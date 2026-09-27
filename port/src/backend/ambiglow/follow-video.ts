// FollowVideo ("光影同步", 09 §7): screen colours → Ambiglow LEDs through the ENE frame buffer.
//
// Vendor pipeline (EffectTimerMgr.cs:65-175, ScreenCaptureMgr.cs, CDevice_PHLDisplay.OnFollowVideo:1223-1246,
// Class0.method_7..10):
//   capture thread   every 300 ms a screenshot of the primary screen into a 2-deep queue;
//   frame thread     every 100 ms the newest screenshot → CalcRGBs(50, 40) grid → ParameterVideoSync:
//                    one grid cell per LED by the fixed §7.3 formulas, six paced writes at 0xE300…;
//   gating           SystemOper.CheckSoftEffect runs the timers only while a connected device's effect type
//                    is FollowVideo (ENE in use, effect on, CurrEffect FollowVideo), and EffectEnableTemp stops
//                    them while idle (05 §2.6, 09 §11).
//
// Port: the capture host (HostServices.capture, Electron main) delivers the 50×40 RGBA grid itself — the
// area-filtered "smooth" downscale of 09 plan B instead of the 5-point CalcRGBs sample (impl-electron-shell
// "Capture host"). The per-LED mapping is the wave-1 driver's (ene-frame.ts planFrame/renderFrame: the JSON
// border sub-counts R/RU/LU/L of PCenter_AmbiglowInfo.json and the device's central/bottom counts; for the
// 34M2C8600 R3 RU4 LU4 L3 C18 B14 = 46 LEDs, 09 §7.3 concrete table); EneDevice.writeVideoFrame uploads.
//
// Cadence = the FollowVideo entry's EffectDetail.Speed, set with the Ambiglow page's Speed slider (the port
// offers it for FollowVideo with an ENE, menu.ts; impl-ambiglow §5 deviation 17). The vendor cadence is
// 300 + 100 ms plus a ~65 ms upload, felt as laggy on Windows too:
//   1 Low      the vendor's: capture every 300 ms, the newest frame on a fixed 100 ms tick (as on Windows);
//   2 Normal   (default, also for a missing or unknown speed) capture every 100 ms, each new frame uploaded as
//              soon as it arrives;
//   3 High     capture every 40 ms (25 fps asked), each new frame uploaded as soon as the ENE is free; the six
//              paced writes of a frame (~65 ms) bound it to ~15 uploads per second.
// Event-driven uploads (Normal, High): newest frame wins. While an upload runs, newer frames only replace the
// pending one, which goes out when the upload finished; frames are never queued. While the ENE is busy with
// something else (a ParameterSet), the newest frame is retried every FOLLOW_VIDEO_BUSY_RETRY_MS.
// A speed change retunes the running capture (CaptureHost.setVideoInterval) and the upload scheduling at once,
// without a new capture session (on Wayland each session is a portal dialog).
//
// Brightness = the FollowVideo entry's EffectDetail.Brightness, set with the Ambiglow page's Brightness slider (also
// offered for FollowVideo with an ENE only, menu.ts; deviation 17): 1 Bright, 2 Brighter, 3 Brightest (default, also
// for a missing, 0 or out-of-range value: the frames as captured, the behaviour before the slider). The frames are
// dimmed on the host after the grid → LED mapping, by clamp(Brightness, 1, 3) / 3 like the vendor's host-side
// breathing curve (SystemOper.smethod_13, breathing.ts breathingBrightness), rounded to the nearest integer
// (EneDevice.writeVideoFrame gain, ene-frame.ts dimFrameWrites). The ENE cannot do it: its ParameterSet of mode 14
// always carries Brightest, so no ParameterSet is sent. A change applies to the newest frame at once (re-sent), with
// the same capture session; the Effect_GetLEDs mirror holds the dimmed colours.
//
// Capture session vs. uploads. On GNOME Wayland every CaptureHost.startVideo shows the xdg-desktop-portal
// ScreenCast dialog (impl-electron-shell "Capture host"), so the session is kept for as long as FollowVideo is
// the selected, enabled effect: setWanted() starts/stops the capture, setPaused() only stops the uploads (idle
// lights-off, an ENE that went away and may come back after monitor standby or a USB re-enumeration) and slows
// the kept session to FOLLOW_VIDEO_PAUSED_CAPTURE_MS (one frame per second; the same retune as a speed change, so
// no portal dialog); resuming retunes it back to the tier's interval. The vendor stops and restarts its capture
// thread in both cases (EffectEnableTemp → StopAllTimer, 09 §11), which costs nothing on Windows.
//
// Deviations (docs/port/impl-ambiglow.md §5):
//   - the speed tiers above (deviation 17): only Low keeps the vendor cadence;
//   - the brightness levels above (deviation 17): the vendor streams the frames as captured (Brightest keeps that);
//   - a frame is uploaded once: the vendor's frame thread re-sends the same screenshot twice between captures
//     (09 §16 quirk 3), which only doubles the USB traffic; after a pause the newest frame is sent again;
//   - frames are skipped while the ENE is busy (a ParameterSet or the previous frame), never queued
//     (09 plan A.7);
//   - a failed start (portal denied, no source, 60 s timeout) is retried only when the owner asks for it
//     (setWanted(true, { retry: true }): the service does so once per wake from idle) or after FollowVideo
//     was left and selected again, never in a loop: on Wayland every start shows the ScreenCast dialog again.

import type { CaptureFrame, CaptureHost, Logger } from '../types.ts';
import type { EneDevice } from './ene.ts';
import type { EneModelLayout } from './ene-layout.ts';
import { EneReg } from './ene-registers.ts';
import { GRID_HEIGHT, GRID_WIDTH, planFrame, renderFrame, type EneLedCounts, type FramePlan, type VideoGrid } from './ene-frame.ts';
import { realTimers, type EffectTimers } from './timers.ts';

/** EffectTimerMgr.method_0: Thread.Sleep(300) between screen captures (speed Low). */
export const FOLLOW_VIDEO_CAPTURE_MS = 300;
/** EffectTimerMgr.method_2: Thread.Sleep(100) between frame deliveries (speed Low). */
export const FOLLOW_VIDEO_SEND_MS = 100;
/** Event-driven uploads: how soon a frame held back by a busy ENE (a ParameterSet in flight) is tried again. */
export const FOLLOW_VIDEO_BUSY_RETRY_MS = 20;
/**
 * The capture interval while the uploads are paused (idle lights-off, which can last hours; the ENE away for up to
 * ENE_AWAY_CAPTURE_MS): the kept session is slowed to one frame per second instead of the tier's 3.3 to 25.
 */
export const FOLLOW_VIDEO_PAUSED_CAPTURE_MS = 1000;

/** EffectDetail.Speed of the FollowVideo entry as the Speed slider sets it (menu.ts: 1..3, marks Low/Normal/High). */
export type FollowVideoSpeed = 1 | 2 | 3;

/** One speed tier: how often frames are asked of the capture host and how they reach the ENE. */
export interface FollowVideoCadence {
  readonly speed: FollowVideoSpeed;
  /** The Speed slider's mark (Ambiglow-Dvqon39u.js ua = ["Low", "Normal", "High"]). */
  readonly name: 'Low' | 'Normal' | 'High';
  /** Frame interval asked of CaptureHost.startVideo / setVideoInterval. */
  readonly captureMs: number;
  /** Fixed upload tick (the vendor's frame thread), or null: event-driven, each new frame once the ENE is free. */
  readonly sendMs: number | null;
}

export const FOLLOW_VIDEO_CADENCES: Readonly<Record<FollowVideoSpeed, FollowVideoCadence>> = Object.freeze({
  1: Object.freeze({ speed: 1, name: 'Low', captureMs: FOLLOW_VIDEO_CAPTURE_MS, sendMs: FOLLOW_VIDEO_SEND_MS }),
  2: Object.freeze({ speed: 2, name: 'Normal', captureMs: 100, sendMs: null }),
  3: Object.freeze({ speed: 3, name: 'High', captureMs: 40, sendMs: null }),
} as const);

/** The tier of a missing, 0 or out-of-range speed (DisplayEffectInfo.Default stores 2). */
export const FOLLOW_VIDEO_DEFAULT_SPEED: FollowVideoSpeed = 2;

/** The tier of EffectDetail.Speed: 1 Low, 2 Normal, 3 High; anything else (missing, 0, 7, "2") is Normal. */
export function followVideoCadence(speed: unknown): FollowVideoCadence {
  return speed === 1 || speed === 2 || speed === 3 ? FOLLOW_VIDEO_CADENCES[speed] : FOLLOW_VIDEO_CADENCES[FOLLOW_VIDEO_DEFAULT_SPEED];
}

/** EffectDetail.Brightness of the FollowVideo entry as the Brightness slider sets it (menu.ts: 1..3). */
export type FollowVideoBrightness = 1 | 2 | 3;

/** The Brightness slider's marks (Ambiglow-Dvqon39u.js na = ["Bright", "Brighter", "Brightest"]). */
export const FOLLOW_VIDEO_BRIGHTNESS_NAMES: Readonly<Record<FollowVideoBrightness, 'Bright' | 'Brighter' | 'Brightest'>> = Object.freeze({
  1: 'Bright',
  2: 'Brighter',
  3: 'Brightest',
} as const);

/** The level of a missing, 0 or out-of-range brightness: full, the frames as captured (DisplayEffectInfo.Default stores 3). */
export const FOLLOW_VIDEO_DEFAULT_BRIGHTNESS: FollowVideoBrightness = 3;

/** The level of EffectDetail.Brightness: 1, 2 or 3 as given; anything else (missing, 0, 4, "2", 2.5) is 3, full. */
export function followVideoBrightness(brightness: unknown): FollowVideoBrightness {
  return brightness === 1 || brightness === 2 || brightness === 3 ? brightness : FOLLOW_VIDEO_DEFAULT_BRIGHTNESS;
}

/** The factor the frames are dimmed by: level / 3 (1/3, 2/3, 1), the vendor's clamp(b, 1, 3) / 3 of the breathing curve. */
export function followVideoGain(brightness: unknown): number {
  const level = followVideoBrightness(brightness);
  return level === FOLLOW_VIDEO_DEFAULT_BRIGHTNESS ? 1 : level / 3;
}

/** "capture every 100 ms, LED upload of every new frame" (log text). */
export function describeCadence(c: FollowVideoCadence): string {
  return `screen capture every ${c.captureMs} ms, LED upload ${c.sendMs === null ? 'of every new frame' : `every ${c.sendMs} ms`}`;
}

// ───────────────────────────── pure mapping (09 §7.3) ─────────────────────────────

/** LEDs per segment in frame-buffer order, as the mapping uses them. */
export interface LedLayoutSummary {
  right: number;
  rightUp: number;
  leftUp: number;
  left: number;
  central: number;
  bottom: number;
  total: number;
}

/**
 * The LED segments a model streams: border sub-counts from the JSON (Class0.method_8), central and bottom
 * from the device registers 0xE0A5/0xE0A7 (method_9/10; used only when the JSON also lists that segment).
 */
export function ledLayout(layout: EneModelLayout, counts: EneLedCounts): LedLayoutSummary {
  const border = counts.border > 0;
  const s = {
    right: border ? layout.rightLedCount : 0,
    rightUp: border ? layout.rightUpLedCount : 0,
    leftUp: border ? layout.leftUpLedCount : 0,
    left: border ? layout.leftLedCount : 0,
    central: layout.centerLedCount > 0 ? counts.central : 0,
    bottom: layout.bottomLedCount > 0 ? counts.bottom : 0,
  };
  return { ...s, total: s.right + s.rightUp + s.leftUp + s.left + s.central + s.bottom };
}

/**
 * Per-LED colours of one frame: R,G,B per LED in frame-buffer order (right bottom→top, top right→centre,
 * top centre→left, left top→bottom, central top→bottom, bottom left→right) — exactly the bytes
 * EneDevice.writeVideoFrame sends from 0xE300 (renderFrame of the driver's plan).
 */
export function frameLedColors(plan: FramePlan, grid: VideoGrid): Uint8Array {
  const writes = renderFrame(plan, grid);
  let end = 0;
  for (const w of writes) end = Math.max(end, w.reg - EneReg.FRAME_BUFFER + w.data.length);
  const out = new Uint8Array(end);
  for (const w of writes) out.set(w.data, w.reg - EneReg.FRAME_BUFFER);
  return out;
}

/** Convenience: plan + map for a model layout and device counts. */
export function mapFrameToLeds(layout: EneModelLayout, counts: EneLedCounts, grid: VideoGrid): Uint8Array {
  return frameLedColors(planFrame(layout, counts), grid);
}

/** A 50×40 RGB grid of one colour (OnBreathing fills byte_0[40][150] this way, CDevice_PHLDisplay.cs:1297-1306). */
export function solidGrid(r: number, g: number, b: number): VideoGrid {
  const data = new Uint8Array(GRID_WIDTH * GRID_HEIGHT * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return { width: GRID_WIDTH, height: GRID_HEIGHT, data };
}

// ───────────────────────────── engine ─────────────────────────────

export interface FollowVideoOptions {
  log: Logger;
  /** HostServices.capture; without one FollowVideo shows nothing (logged once). */
  capture?: CaptureHost;
  /** The ENE device frames go to (null while none is usable). */
  target: () => EneDevice | null;
  timers?: EffectTimers;
  /** Initial EffectDetail.Speed (default Normal); the owner follows the profile with setSpeed(). */
  speed?: number;
  /** Initial EffectDetail.Brightness (default 3, full); the owner follows the profile with setBrightness(). */
  brightness?: number;
}

type State = 'stopped' | 'starting' | 'running' | 'failed';

export class FollowVideoEngine {
  readonly #log: Logger;
  readonly #capture: CaptureHost | undefined;
  readonly #target: () => EneDevice | null;
  readonly #timers: EffectTimers;
  #cadence: FollowVideoCadence;
  #brightness: FollowVideoBrightness;
  #state: State = 'stopped';
  #session = 0;
  /** Speed Low: the fixed upload tick. */
  #tick: unknown = null;
  /** Event-driven: a retry of the newest frame while the ENE is busy with something else. */
  #retry: unknown = null;
  /** Event-driven: an upload of this engine is running (newer frames wait for it, never queue). */
  #inFlight = false;
  #latest: CaptureFrame | null = null;
  #sent: CaptureFrame | null = null;
  #paused = false;
  /** The interval the current session was last asked for (start or retune); null while none runs. */
  #askedMs: number | null = null;
  #uploads = 0;
  #starts = 0;
  #retunes = 0;
  #warnedNoHost = false;
  #warnedNoRetune = false;

  constructor(options: FollowVideoOptions) {
    this.#log = options.log;
    this.#capture = options.capture;
    this.#target = options.target;
    this.#timers = options.timers ?? realTimers;
    this.#cadence = followVideoCadence(options.speed);
    this.#brightness = followVideoBrightness(options.brightness);
  }

  /** 'running' while frames are requested; 'failed' after a start the host refused (until setWanted(false)). */
  get state(): State {
    return this.#state;
  }

  /** The speed tier in use (and asked of the next capture start). */
  get cadence(): FollowVideoCadence {
    return this.#cadence;
  }

  /** The brightness level in use: 1 Bright, 2 Brighter, 3 Brightest (full). */
  get brightness(): FollowVideoBrightness {
    return this.#brightness;
  }

  /** The factor the uploaded colours are dimmed by (followVideoGain: 1/3, 2/3 or 1). */
  get gain(): number {
    return followVideoGain(this.#brightness);
  }

  /** Frames handed to the ENE since construction. */
  get uploads(): number {
    return this.#uploads;
  }

  /** CaptureHost.startVideo calls since construction (each one is a portal dialog on Wayland). */
  get starts(): number {
    return this.#starts;
  }

  /** CaptureHost.setVideoInterval calls since construction (speed changes, pause and resume of a live session). */
  get retunes(): number {
    return this.#retunes;
  }

  /** True while uploads are held back (the capture session, if any, keeps running, slowed down). */
  get paused(): boolean {
    return this.#paused;
  }

  /** The frame interval the running (or starting) session was asked for; null while none runs. */
  get captureIntervalMs(): number | null {
    return this.#askedMs;
  }

  /**
   * EffectTimerMgr.EnableFollowVideoTimer(enable): start or stop the capture session and the upload tick.
   * Idempotent. A session in 'failed' is left alone unless `retry` is set (one new attempt).
   */
  setWanted(wanted: boolean, options: { retry?: boolean } = {}): void {
    if (wanted) {
      if (this.#state === 'stopped' || (this.#state === 'failed' && options.retry === true)) this.#start();
      return;
    }
    if (this.#state !== 'stopped') this.#stop();
  }

  /**
   * The FollowVideo entry's EffectDetail.Speed (followVideoCadence: 1 Low, 2 Normal, 3 High, else Normal).
   * Idempotent. A live session (starting or running) is retuned in place: the capture host is asked for the new
   * interval (CaptureHost.setVideoInterval, same session: no portal dialog) and the uploads switch between the
   * fixed tick and event-driven at once; while paused the capture stays slow until the uploads resume. Otherwise
   * the tier applies at the next start.
   */
  setSpeed(speed: unknown): void {
    const next = followVideoCadence(speed);
    if (next === this.#cadence) return;
    this.#cadence = next;
    if (!this.#live()) return;
    this.#log.info(`FollowVideo speed ${next.name}: ${describeCadence(next)} (same capture session${this.#paused ? '; from when the uploads resume' : ''})`);
    this.#schedule();
    this.#retuneCapture();
    this.#pump();
  }

  /**
   * The FollowVideo entry's EffectDetail.Brightness (followVideoBrightness: 1 Bright, 2 Brighter, 3 Brightest, else 3).
   * Idempotent. The capture session is not touched (no retune, no new session): the level applies to the next
   * upload, and a live session sends its newest frame again at once (Low: on the next tick), so the LEDs and the
   * Effect_GetLEDs mirror follow the slider without waiting for a screen change. While paused it applies on resume.
   */
  setBrightness(brightness: unknown): void {
    const next = followVideoBrightness(brightness);
    if (next === this.#brightness) return;
    this.#brightness = next;
    if (!this.#live()) return;
    this.#log.info(`FollowVideo brightness ${FOLLOW_VIDEO_BRIGHTNESS_NAMES[next]}: frame colours x ${next}/3 on the host (same capture session)`);
    this.#sent = null;
    this.#pump();
  }

  /**
   * Hold back (true) or resume (false) the uploads without ending the capture session: idle lights-off and an ENE
   * that is away for a moment. Pausing slows the kept session to FOLLOW_VIDEO_PAUSED_CAPTURE_MS, resuming retunes it
   * to the tier's interval (same session) and re-sends the newest frame, since the LEDs were re-applied.
   */
  setPaused(paused: boolean): void {
    if (paused === this.#paused) return;
    this.#paused = paused;
    if (!paused) this.#sent = null;
    this.#retuneCapture();
    if (!paused) this.#pump();
  }

  #live(): boolean {
    return this.#state === 'starting' || this.#state === 'running';
  }

  /** The interval the session should have now: slow while paused, else the tier's. */
  #captureMs(): number {
    return this.#paused ? FOLLOW_VIDEO_PAUSED_CAPTURE_MS : this.#cadence.captureMs;
  }

  #start(): void {
    const capture = this.#capture;
    if (!capture) {
      if (!this.#warnedNoHost) this.#log.warn('FollowVideo: no screen capture host; the LEDs are not updated');
      this.#warnedNoHost = true;
      this.#state = 'failed';
      return;
    }
    const session = ++this.#session;
    const cadence = this.#cadence;
    const captureMs = this.#captureMs();
    this.#state = 'starting';
    this.#starts++;
    this.#askedMs = captureMs;
    this.#latest = null;
    this.#sent = null;
    this.#schedule();
    this.#log.info(`FollowVideo speed ${cadence.name}: ${describeCadence(cadence)}${this.#paused ? ` (paused: capture every ${captureMs} ms until the uploads resume)` : ''}`);
    capture
      .startVideo(captureMs, (frame) => {
        if (session !== this.#session) return;
        this.#latest = frame;
        this.#pump();
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
    this.#log.warn(`FollowVideo: screen capture unavailable${e ? ` (${e instanceof Error ? e.message : String(e)})` : ''}; the LEDs keep the last frame`);
    this.#clearTimers();
    this.#state = 'failed';
    this.#askedMs = null;
  }

  #stop(): void {
    this.#session++;
    const wasCapturing = this.#live();
    this.#state = 'stopped';
    this.#askedMs = null;
    this.#clearTimers();
    this.#latest = null;
    this.#sent = null;
    if (wasCapturing) {
      try {
        this.#capture?.stopVideo();
      } catch (e) {
        this.#log.warn('FollowVideo: stopVideo failed', e);
      }
      this.#log.info('FollowVideo: screen capture stopped');
    }
  }

  /** The upload scheduling of the current tier: the fixed tick (Low) or none (event-driven, #pump). */
  #schedule(): void {
    this.#clearTimers();
    const sendMs = this.#cadence.sendMs;
    if (sendMs !== null) this.#tick = this.#timers.setInterval(() => this.#tickUpload(), sendMs);
  }

  #clearTimers(): void {
    if (this.#tick !== null) this.#timers.clearInterval(this.#tick);
    if (this.#retry !== null) this.#timers.clearTimeout(this.#retry);
    this.#tick = null;
    this.#retry = null;
  }

  /** Ask the live session for the interval it should have now (#captureMs), unless it was asked for it already. */
  #retuneCapture(): void {
    if (!this.#live()) return;
    const captureMs = this.#captureMs();
    if (captureMs === this.#askedMs) return;
    if (this.#retune(captureMs)) this.#askedMs = captureMs;
  }

  /** CaptureHost.setVideoInterval; false when the host has none (it keeps the start's interval) or it threw. */
  #retune(captureMs: number): boolean {
    const capture = this.#capture;
    if (typeof capture?.setVideoInterval !== 'function') {
      if (!this.#warnedNoRetune) this.#log.info('FollowVideo: the capture host cannot change a running capture; the new interval applies at the next start');
      this.#warnedNoRetune = true;
      return false;
    }
    try {
      capture.setVideoInterval(captureMs);
      this.#retunes++;
      return true;
    } catch (e) {
      this.#log.warn('FollowVideo: setVideoInterval failed', e);
      return false;
    }
  }

  /** The newest frame not sent yet, while uploads may run (not paused, a usable ENE). */
  #pending(): { frame: CaptureFrame; ene: EneDevice } | null {
    const frame = this.#latest;
    if (this.#paused || !frame || frame === this.#sent) return null;
    const ene = this.#target();
    if (!ene || ene.closed || ene.lost) return null;
    return { frame, ene };
  }

  /** Speed Low, the vendor's 100 ms frame tick: the newest frame, once, unless paused or the ENE is busy (the next tick retries). */
  #tickUpload(): void {
    const next = this.#pending();
    if (!next || next.ene.busy) return;
    this.#send(next.ene, next.frame);
  }

  /**
   * Event-driven uploads (Normal, High), newest frame wins: after a new frame, a finished upload, a resume or a
   * speed change. One upload at a time; a frame held back by a busy ENE is tried again shortly.
   */
  #pump(): void {
    if (this.#cadence.sendMs !== null || this.#inFlight || this.#retry !== null || !this.#live()) return;
    const next = this.#pending();
    if (!next) return;
    if (next.ene.busy) {
      this.#retry = this.#timers.setTimeout(() => {
        this.#retry = null;
        this.#pump();
      }, FOLLOW_VIDEO_BUSY_RETRY_MS);
      return;
    }
    this.#send(next.ene, next.frame);
  }

  #send(ene: EneDevice, frame: CaptureFrame): void {
    this.#sent = frame;
    this.#uploads++;
    this.#inFlight = true;
    ene
      .writeVideoFrame(frame, { gain: this.gain })
      .catch((e: unknown) => {
        this.#log.debug(`FollowVideo: frame upload failed: ${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        this.#inFlight = false;
        this.#pump();
      });
  }
}
