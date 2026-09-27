// FollowAudio ("光音同步", 09 §8): the level of the default audio output → the ENE audio registers.
//
// Vendor: EffectTimerMgr.method_3 computes one 0..255 level every 40 ms from the WASAPI loopback spectrum
// (AudioSyncUtil.ConvertToSingleData) and CDevice_PHLDisplay.OnFollowAudio (:1248-1267) writes it through
// Class0.method_6: the byte to E960..E962 (FollowAudio, mode 9) or E970..E972 (FollowAudioRainbow, mode 10),
// each write paced; the firmware draws the visualisation in the colour/region of the last ParameterSet.
// The timer runs only while a connected device's effect type is FollowAudio (CheckSoftEffect, 05 §2.6) and
// stops while idle (EffectEnableTemp, 09 §11).
//
// Port: HostServices.capture.startAudio delivers the level every 40 ms (Electron main: parec on the default
// sink's monitor + the vendor FFT/heuristic, impl-electron-shell "startAudio"). Each level is forwarded to
// EneDevice.writeAudioLevel, which picks the register bank from the applied mode and truncates the float to a
// byte like the vendor's cast. A level that arrives while the previous write (3 × 10 ms) or a ParameterSet is
// still running is dropped rather than queued (impl-usb-ene §5); the next one follows 40 ms later.

import type { CaptureHost, Logger } from '../types.ts';
import type { EneDevice } from './ene.ts';

/** EffectTimerMgr.method_3: Thread.Sleep(40) between audio levels (the capture host's cadence). */
export const FOLLOW_AUDIO_INTERVAL_MS = 40;

export interface FollowAudioOptions {
  log: Logger;
  capture?: CaptureHost;
  target: () => EneDevice | null;
}

type State = 'stopped' | 'starting' | 'running' | 'failed';

export class FollowAudioEngine {
  readonly #log: Logger;
  readonly #capture: CaptureHost | undefined;
  readonly #target: () => EneDevice | null;
  #state: State = 'stopped';
  #session = 0;
  #inflight = false;
  #writes = 0;
  #lastLevel = 0;
  #warnedNoHost = false;

  constructor(options: FollowAudioOptions) {
    this.#log = options.log;
    this.#capture = options.capture;
    this.#target = options.target;
  }

  get state(): State {
    return this.#state;
  }

  /** Levels handed to the ENE since construction. */
  get writes(): number {
    return this.#writes;
  }

  /** The last level received from the capture host. */
  get lastLevel(): number {
    return this.#lastLevel;
  }

  /** EffectTimerMgr.EnableFollowAudioTimer(enable). Idempotent. */
  setWanted(wanted: boolean): void {
    if (wanted) {
      if (this.#state === 'stopped') this.#start();
      return;
    }
    if (this.#state !== 'stopped') this.#stop();
  }

  #start(): void {
    const capture = this.#capture;
    if (!capture) {
      if (!this.#warnedNoHost) this.#log.warn('FollowAudio: no audio capture host; the LEDs do not follow the sound');
      this.#warnedNoHost = true;
      this.#state = 'failed';
      return;
    }
    const session = ++this.#session;
    this.#state = 'starting';
    this.#log.info('FollowAudio: capturing the default output level');
    capture
      .startAudio((level) => {
        if (session === this.#session) this.#onLevel(level);
      })
      .then(
        (ok) => this.#started(session, ok, null),
        (e: unknown) => this.#started(session, false, e),
      );
  }

  #started(session: number, ok: boolean, e: unknown): void {
    if (session !== this.#session || this.#state !== 'starting') return;
    if (ok) {
      this.#state = 'running';
      return;
    }
    this.#log.warn(`FollowAudio: audio capture unavailable${e ? ` (${e instanceof Error ? e.message : String(e)})` : ''}`);
    this.#state = 'failed';
  }

  #stop(): void {
    this.#session++;
    const wasCapturing = this.#state === 'starting' || this.#state === 'running';
    this.#state = 'stopped';
    if (wasCapturing) {
      try {
        this.#capture?.stopAudio();
      } catch (e) {
        this.#log.warn('FollowAudio: stopAudio failed', e);
      }
      this.#log.info('FollowAudio: audio capture stopped');
    }
  }

  #onLevel(level: number): void {
    this.#lastLevel = level;
    if (this.#inflight) return;
    const ene = this.#target();
    if (!ene || ene.busy || ene.closed || ene.lost) return;
    this.#inflight = true;
    this.#writes++;
    ene
      .writeAudioLevel(level)
      .catch((e: unknown) => this.#log.debug(`FollowAudio: level write failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        this.#inflight = false;
      });
  }
}
