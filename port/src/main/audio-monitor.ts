// Follow-audio capture: level of the default sink's monitor (09 §8, 09 plan C; ARCHITECTURE "Audio").
//
// Chromium cannot open a sink monitor. Its PulseAudio backend drops monitor ("loopback") sources from
// the input device list (media/audio/pulse/audio_manager_pulse.cc, InputDevicesInfoCallback returns
// early when monitor_of_sink != PA_INVALID_INDEX), and PipeWire desktops go through pipewire-pulse, so
// getUserMedia never sees "Monitor of …". The monitor is therefore recorded here, in main, by `parec`
// (pulseaudio-utils; it speaks to PulseAudio and pipewire-pulse alike):
//   parec --device=@DEFAULT_MONITOR@ --raw --format=float32le --rate=48000 --channels=2 --latency-msec=20
// Every 40 ms the latest 2048 mono samples (mean of the channels, like GetDftData's de-interleave) go
// through the vendor DFT and ConvertToSingleData (audio-level.ts), EffectTimerMgr.method_3 (09 §8.3).
//
// Vendor behaviours kept (AudioSyncController.cs, 09 §8.1):
//   - a new default render endpoint restarts the capture (OnDefaultDeviceChanged): `pactl subscribe`
//     reports "change on server", and parec restarts when `pactl get-default-sink` names another sink;
//   - a muted default endpoint gives level 0: `pactl get-sink-mute @DEFAULT_SINK@` after sink changes;
//   - a watchdog restarts the capture when no data arrived for 3 s (:261-289). parec is also restarted
//     after it exits (sound server restart), with a backoff while it keeps failing.
// start() resolves true on the first audio data, false when parec is missing, exits, or sends nothing
// within 3 s. stop() is synchronous. A start supersedes (and resolves false for) the previous one.

import { type ChildProcess, execFile } from 'node:child_process';
import type { Logger } from '../backend/types.ts';
import { AUDIO_FFT_SIZE, AUDIO_INTERVAL_MS, dftData, levelFromSpectrum } from './audio-level.ts';
import { spawnTied } from './child-process.ts';

export const MONITOR_SAMPLE_RATE = 48000;
export const MONITOR_CHANNELS = 2;

export const PAREC_ARGS: readonly string[] = [
  '--device=@DEFAULT_MONITOR@',
  '--raw',
  '--format=float32le',
  `--rate=${MONITOR_SAMPLE_RATE}`,
  `--channels=${MONITOR_CHANNELS}`,
  '--latency-msec=20',
  '--client-name=Evnia Precision Center',
  '--stream-name=Ambiglow follow-audio',
];

export interface AudioMonitorTiming {
  /** No data for this long → restart parec (vendor watchdog). */
  watchdogMs: number;
  /** First delay before parec is started again after it exited; doubles while it keeps failing. */
  restartDelayMs: number;
  restartDelayMaxMs: number;
  /** start() resolves false when no data arrived within this time. */
  startTimeoutMs: number;
  /** Coalesces bursts of sink events (volume changes) into one mute query. */
  muteQueryDelayMs: number;
}

export const DEFAULT_AUDIO_MONITOR_TIMING: AudioMonitorTiming = {
  watchdogMs: 3000,
  restartDelayMs: 1000,
  restartDelayMaxMs: 30_000,
  startTimeoutMs: 3000,
  muteQueryDelayMs: 100,
};

export type LevelCallback = (level: number, spectrum?: Float32Array) => void;

/** `pactl subscribe` line → the change follow-audio reacts to, or null. */
export function parsePulseEvent(line: string): 'server' | 'sink' | null {
  const m = /^Event '(\w+)' on (server|sink)\b/.exec(line.trim());
  return m && m[1] === 'change' ? (m[2] as 'server' | 'sink') : null;
}

/** `pactl get-sink-mute …` output → muted?, null when unparseable. */
export function parseMute(stdout: string): boolean | null {
  const m = /^Mute:\s*(yes|no)\b/m.exec(stdout);
  return m ? m[1] === 'yes' : null;
}

/** The latest `size` mono samples of an interleaved float32le stream (frames may span chunks). */
export class MonoRing {
  readonly #buf: Float32Array;
  readonly #channels: number;
  #pos = 0;
  #carry: Buffer = Buffer.alloc(0);

  constructor(size: number, channels: number) {
    this.#buf = new Float32Array(size);
    this.#channels = channels;
  }

  push(chunk: Buffer): void {
    const data = this.#carry.length > 0 ? Buffer.concat([this.#carry, chunk]) : chunk;
    const frameBytes = 4 * this.#channels;
    const frames = Math.floor(data.length / frameBytes);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < this.#channels; c++) sum += data.readFloatLE(f * frameBytes + c * 4);
      const v = sum / this.#channels;
      this.#buf[this.#pos] = Number.isFinite(v) ? v : 0;
      this.#pos = (this.#pos + 1) % this.#buf.length;
    }
    this.#carry = Buffer.from(data.subarray(frames * frameBytes));
  }

  /** Oldest sample first. */
  snapshot(): Float32Array {
    const out = new Float32Array(this.#buf.length);
    out.set(this.#buf.subarray(this.#pos), 0);
    out.set(this.#buf.subarray(0, this.#pos), this.#buf.length - this.#pos);
    return out;
  }

  clear(): void {
    this.#buf.fill(0);
    this.#pos = 0;
    this.#carry = Buffer.alloc(0);
  }
}

export interface AudioMonitorOptions {
  log: Logger;
  /** Environment of the child processes (tests put fake parec/pactl on PATH). */
  env?: NodeJS.ProcessEnv;
  timing?: Partial<AudioMonitorTiming>;
}

interface RunDeps {
  log: Logger;
  env: NodeJS.ProcessEnv;
  timing: AudioMonitorTiming;
}

function forEachLine(child: ChildProcess, onLine: (line: string) => void): void {
  let buffer = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  });
}

/** One capture from start() to close(): the parec child, the pactl event watcher and the timers. */
class MonitorRun {
  readonly #d: RunDeps;
  readonly #onLevel: LevelCallback;
  readonly #ring = new MonoRing(AUDIO_FFT_SIZE, MONITOR_CHANNELS);
  #closed = false;
  #started = false;
  #rec: ChildProcess | null = null;
  #events: ChildProcess | null = null;
  #ticker: ReturnType<typeof setInterval> | null = null;
  #restartTimer: ReturnType<typeof setTimeout> | null = null;
  #muteTimer: ReturnType<typeof setTimeout> | null = null;
  #settle: ((ok: boolean) => void) | null = null;
  #lastDataAt = 0;
  #failures = 0;
  #muted = false;
  #defaultSink: string | null = null;

  constructor(d: RunDeps, onLevel: LevelCallback) {
    this.#d = d;
    this.#onLevel = onLevel;
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.#d.log.warn(`Follow-audio unavailable: parec sent no audio within ${this.#d.timing.startTimeoutMs} ms`);
        this.close();
      }, this.#d.timing.startTimeoutMs);
      this.#settle = (ok) => {
        clearTimeout(timeout);
        this.#settle = null;
        resolve(ok);
      };
      this.#spawnRecorder();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#settle?.(false);
    for (const t of [this.#restartTimer, this.#muteTimer]) if (t) clearTimeout(t);
    if (this.#ticker) clearInterval(this.#ticker);
    this.#restartTimer = this.#muteTimer = this.#ticker = null;
    const children = [this.#rec, this.#events];
    this.#rec = this.#events = null;
    for (const c of children) c?.kill();
  }

  #childEnv(): NodeJS.ProcessEnv {
    return { ...this.#d.env, LC_ALL: 'C' };
  }

  #spawnRecorder(): void {
    const { log } = this.#d;
    const child = spawnTied('parec', PAREC_ARGS, { stdio: ['ignore', 'pipe', 'pipe'], env: this.#childEnv() });
    this.#rec = child;
    this.#lastDataAt = Date.now();
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (s: string) => {
      stderr = (stderr + s).slice(-400);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.#rec !== child) return;
      this.#lastDataAt = Date.now();
      this.#failures = 0;
      this.#ring.push(chunk);
      if (!this.#started) this.#onStarted();
    });
    const ended = (why: string) => {
      if (this.#rec !== child) return;
      this.#rec = null;
      if (!this.#started) {
        log.warn(`Follow-audio unavailable: ${why}`);
        this.close();
      } else {
        this.#scheduleRestart(why);
      }
    };
    child.on('error', (e) => ended(`cannot run parec (${e.message}); it is part of pulseaudio-utils`));
    child.on('exit', (code, signal) => ended(`parec exited (${code ?? signal})${stderr ? `: ${stderr.trim()}` : ''}`));
  }

  #onStarted(): void {
    this.#started = true;
    this.#d.log.info('Follow-audio capturing the default sink monitor');
    this.#settle?.(true);
    this.#ticker = setInterval(() => this.#tick(), AUDIO_INTERVAL_MS);
    this.#watchServer();
    void this.#pactl(['get-default-sink']).then((out) => {
      if (this.#defaultSink === null) this.#defaultSink = out?.trim() || null;
    });
    this.#queryMute();
  }

  #tick(): void {
    if (this.#closed) return;
    const { timing, log } = this.#d;
    const rec = this.#rec;
    if (rec && Date.now() - this.#lastDataAt > timing.watchdogMs) {
      log.warn(`No audio from parec for ${timing.watchdogMs} ms; restarting it`);
      this.#lastDataAt = Date.now();
      rec.kill();
    }
    try {
      if (this.#muted) {
        this.#onLevel(0, new Float32Array(0));
        return;
      }
      const spectrum = dftData(this.#ring.snapshot(), MONITOR_SAMPLE_RATE);
      this.#onLevel(levelFromSpectrum(spectrum), Float32Array.from(spectrum));
    } catch (e) {
      log.error('Follow-audio level callback failed', e);
    }
  }

  #scheduleRestart(why: string): void {
    if (this.#closed || this.#restartTimer) return;
    const { timing, log } = this.#d;
    const delay = Math.min(timing.restartDelayMs * 2 ** this.#failures, timing.restartDelayMaxMs);
    if (this.#failures === 0) log.warn(`${why}; restarting in ${delay} ms`);
    else log.debug(`${why}; restarting in ${delay} ms`);
    this.#failures++;
    this.#ring.clear();
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#closed && !this.#rec) this.#spawnRecorder();
    }, delay);
  }

  /** New default sink: record its monitor right away. */
  #restartNow(): void {
    const rec = this.#rec;
    this.#rec = null;
    rec?.kill();
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#ring.clear();
    this.#spawnRecorder();
  }

  #watchServer(): void {
    const child = spawnTied('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'], env: this.#childEnv() });
    this.#events = child;
    child.on('error', (e) => {
      if (this.#events !== child) return;
      this.#events = null;
      this.#d.log.info(`pactl unavailable (${e.message}): follow-audio ignores default-sink changes and mute`);
    });
    child.on('exit', () => {
      if (this.#events === child) this.#events = null;
    });
    forEachLine(child, (line) => {
      if (this.#events !== child) return;
      const what = parsePulseEvent(line);
      if (what === 'server') this.#onServerChange();
      else if (what === 'sink') this.#scheduleMuteQuery();
    });
  }

  #onServerChange(): void {
    void this.#pactl(['get-default-sink']).then((out) => {
      const sink = out?.trim() || null;
      if (this.#closed || !sink) return;
      const previous = this.#defaultSink;
      this.#defaultSink = sink;
      if (previous !== null && previous !== sink) {
        this.#d.log.info(`Default sink changed to ${sink}; restarting follow-audio capture`);
        this.#restartNow();
      }
      this.#queryMute();
    });
  }

  #scheduleMuteQuery(): void {
    if (this.#muteTimer || this.#closed) return;
    this.#muteTimer = setTimeout(() => {
      this.#muteTimer = null;
      this.#queryMute();
    }, this.#d.timing.muteQueryDelayMs);
  }

  #queryMute(): void {
    void this.#pactl(['get-sink-mute', '@DEFAULT_SINK@']).then((out) => {
      const muted = out === null ? null : parseMute(out);
      if (this.#closed || muted === null || muted === this.#muted) return;
      this.#muted = muted;
      this.#d.log.info(`Default sink ${muted ? 'muted: follow-audio level 0' : 'unmuted'}`);
    });
  }

  #pactl(args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('pactl', args, { timeout: 2000, env: this.#childEnv() }, (err, stdout) => resolve(err ? null : stdout));
    });
  }
}

/** The follow-audio half of CaptureHost (start/stop semantics of src/backend/types.ts). */
export class PulseMonitorCapture {
  readonly #d: RunDeps;
  #run: MonitorRun | null = null;

  constructor(o: AudioMonitorOptions) {
    this.#d = { log: o.log, env: o.env ?? process.env, timing: { ...DEFAULT_AUDIO_MONITOR_TIMING, ...o.timing } };
  }

  async start(onLevel: LevelCallback): Promise<boolean> {
    this.#run?.close();
    const run = new MonitorRun(this.#d, onLevel);
    this.#run = run;
    const ok = await run.start();
    if (this.#run !== run) return false;
    if (!ok || run.closed) this.#run = null;
    return ok && !run.closed;
  }

  stop(): void {
    this.#run?.close();
    this.#run = null;
  }
}
