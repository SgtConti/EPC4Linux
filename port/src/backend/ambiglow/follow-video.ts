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
// "Capture host"). This engine keeps the vendor cadence: it asks for frames every 300 ms and uploads the newest
// one on a 100 ms tick. The per-LED mapping is the wave-1 driver's (ene-frame.ts planFrame/renderFrame: the
// JSON border sub-counts R/RU/LU/L of PCenter_AmbiglowInfo.json and the device's central/bottom counts; for
// the 34M2C8600 R3 RU4 LU4 L3 C18 B14 = 46 LEDs, 09 §7.3 concrete table); EneDevice.writeVideoFrame uploads.
//
// Capture session vs. uploads. On GNOME Wayland every CaptureHost.startVideo shows the xdg-desktop-portal
// ScreenCast dialog (impl-electron-shell "Capture host"), so the session is kept for as long as FollowVideo is
// the selected, enabled effect: setWanted() starts/stops the capture, setPaused() only stops the uploads (idle
// lights-off, an ENE that went away and may come back after monitor standby or a USB re-enumeration). The
// vendor stops and restarts its capture thread in both cases (EffectEnableTemp → StopAllTimer, 09 §11), which
// costs nothing on Windows.
//
// Deviations (docs/port/impl-ambiglow.md §5):
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

/** EffectTimerMgr.method_0: Thread.Sleep(300) between screen captures. */
export const FOLLOW_VIDEO_CAPTURE_MS = 300;
/** EffectTimerMgr.method_2: Thread.Sleep(100) between frame deliveries. */
export const FOLLOW_VIDEO_SEND_MS = 100;

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
  captureIntervalMs?: number;
  sendIntervalMs?: number;
}

type State = 'stopped' | 'starting' | 'running' | 'failed';

export class FollowVideoEngine {
  readonly #log: Logger;
  readonly #capture: CaptureHost | undefined;
  readonly #target: () => EneDevice | null;
  readonly #timers: EffectTimers;
  readonly #captureMs: number;
  readonly #sendMs: number;
  #state: State = 'stopped';
  #session = 0;
  #tick: unknown = null;
  #latest: CaptureFrame | null = null;
  #sent: CaptureFrame | null = null;
  #paused = false;
  #uploads = 0;
  #starts = 0;
  #warnedNoHost = false;

  constructor(options: FollowVideoOptions) {
    this.#log = options.log;
    this.#capture = options.capture;
    this.#target = options.target;
    this.#timers = options.timers ?? realTimers;
    this.#captureMs = options.captureIntervalMs ?? FOLLOW_VIDEO_CAPTURE_MS;
    this.#sendMs = options.sendIntervalMs ?? FOLLOW_VIDEO_SEND_MS;
  }

  /** 'running' while frames are requested; 'failed' after a start the host refused (until setWanted(false)). */
  get state(): State {
    return this.#state;
  }

  /** Frames handed to the ENE since construction. */
  get uploads(): number {
    return this.#uploads;
  }

  /** CaptureHost.startVideo calls since construction (each one is a portal dialog on Wayland). */
  get starts(): number {
    return this.#starts;
  }

  /** True while uploads are held back (the capture session, if any, keeps running). */
  get paused(): boolean {
    return this.#paused;
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
   * Hold back (true) or resume (false) the uploads without touching the capture session: idle lights-off and
   * an ENE that is away for a moment. Resuming re-sends the newest frame, since the LEDs were re-applied.
   */
  setPaused(paused: boolean): void {
    if (paused === this.#paused) return;
    this.#paused = paused;
    if (!paused) this.#sent = null;
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
    this.#state = 'starting';
    this.#starts++;
    this.#latest = null;
    this.#sent = null;
    this.#clearTick();
    this.#tick = this.#timers.setInterval(() => this.#upload(), this.#sendMs);
    this.#log.info(`FollowVideo: screen capture every ${this.#captureMs} ms, LED upload every ${this.#sendMs} ms`);
    capture
      .startVideo(this.#captureMs, (frame) => {
        if (session === this.#session) this.#latest = frame;
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
    this.#clearTick();
    this.#state = 'failed';
  }

  #stop(): void {
    this.#session++;
    const wasCapturing = this.#state === 'starting' || this.#state === 'running';
    this.#state = 'stopped';
    this.#clearTick();
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

  #clearTick(): void {
    if (this.#tick !== null) this.#timers.clearInterval(this.#tick);
    this.#tick = null;
  }

  /** The 100 ms frame tick: the newest frame, once, unless paused or the ENE is busy (the next tick retries). */
  #upload(): void {
    const frame = this.#latest;
    if (this.#paused || !frame || frame === this.#sent) return;
    const ene = this.#target();
    if (!ene || ene.busy || ene.closed || ene.lost) return;
    this.#sent = frame;
    this.#uploads++;
    ene.writeVideoFrame(frame).catch((e: unknown) => {
      this.#log.debug(`FollowVideo: frame upload failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}
