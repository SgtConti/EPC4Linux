// Messages between the main process (src/main/capture-host.ts) and the hidden capture page.
// main → page: webContents.executeJavaScript(`window.evniaCapture.<command>(<json>)`, userGesture=true)
// page → main: the capture preload bridge (src/capture/preload.ts) over INTERNAL_CHANNELS.capture*.
//
// Every start carries a session number allocated by main. The page tags its frames and status with it,
// so main can drop anything that belongs to a start it has since stopped or superseded.
// Follow-audio does not use this page: Chromium cannot record a sink monitor (src/main/audio-monitor.ts).
//
// The frame-interval rules below are pure and shared by main (the clamp of every command) and the page
// (the frame rate asked of the screen source, and the spacing of the frames it samples).

/** Grid the follow-video engine samples (09 §7.2: CalcRGBs(50, 40)). */
export const FRAME_WIDTH = 50;
export const FRAME_HEIGHT = 40;

/** Fastest frame interval accepted: 33 ms, about 30 fps (Follow video High asks for 40 ms). */
export const MIN_FRAME_INTERVAL_MS = 33;
/** Slowest frame interval accepted (a guard against nonsense; Follow video asks 300 ms at Low, 1000 ms while paused). */
export const MAX_FRAME_INTERVAL_MS = 10_000;
/** Highest frame rate asked of the screen source. */
export const MAX_FRAME_RATE = 30;

/** The interval a command carries: rounded, NaN → the fastest, clamped to MIN..MAX_FRAME_INTERVAL_MS. */
export function clampFrameInterval(intervalMs: number): number {
  const ms = Math.round(intervalMs);
  if (!Number.isFinite(ms)) return ms === Infinity ? MAX_FRAME_INTERVAL_MS : MIN_FRAME_INTERVAL_MS;
  return Math.min(MAX_FRAME_INTERVAL_MS, Math.max(MIN_FRAME_INTERVAL_MS, ms || MIN_FRAME_INTERVAL_MS));
}

/**
 * Frame rate asked of the screen source for an interval: 1000 / interval, 1..MAX_FRAME_RATE. Not rounded: 300 ms
 * asks 3.33 fps, and Chromium's X11 desktop source then delivers a frame every 300 ms (3 fps would be 333 ms;
 * measured under Xvfb, test/e2e/capture.test.ts).
 */
export function frameRateFor(intervalMs: number): number {
  return Math.max(1, Math.min(MAX_FRAME_RATE, 1000 / intervalMs));
}

/**
 * The least spacing of two frames the capture page samples (frame-driven sampling, src/capture/page.ts): the
 * interval less a jitter allowance of min(15 ms, interval / 4). A source that runs at the asked rate has every
 * frame sampled, as it arrives; a faster one (a portal stream the constraint did not slow down) is thinned to
 * about the asked rate.
 */
export function minSampleSpacingMs(intervalMs: number): number {
  return intervalMs - Math.min(15, intervalMs / 4);
}

export interface StartVideoCommand {
  session: number;
  intervalMs: number;
  /** X11: desktopCapturer source id for getUserMedia(chromeMediaSource:'desktop'); null → getDisplayMedia (Wayland portal). */
  sourceId: string | null;
  width: number;
  height: number;
}

/** Retune the stream of `session` (running, or a start still opening) to a new frame interval. */
export interface SetVideoIntervalCommand {
  session: number;
  intervalMs: number;
}

export interface CapturePageApi {
  /**
   * Stops the current stream, then opens the screen. Resolves false when the capture is unavailable or
   * denied, or when a later startVideo/stopVideo superseded this one while it was opening.
   */
  startVideo(cmd: StartVideoCommand): Promise<boolean>;
  /** Stops the current stream and cancels a start that is still opening. */
  stopVideo(): void;
  /**
   * Changes the sampling interval of the current session's stream without re-opening the screen source through
   * the portal: the sample spacing at once, the source's frame rate by track.applyConstraints; an X11 desktop source
   * that cannot reach the new rate is re-opened silently with the same source id. A start still opening takes the
   * new interval when its stream is up. Resolves false when `session` is not the current one.
   */
  setVideoInterval(cmd: SetVideoIntervalCommand): Promise<boolean>;
}

/** What the capture preload exposes to the page as window.evniaCaptureBridge. */
export interface CaptureBridge {
  frame(session: number, data: Uint8ClampedArray, width: number, height: number, timestamp: number): void;
  status(session: number, kind: CaptureStatusKind, detail: string): void;
}

export type CaptureStatusKind = 'video-started' | 'video-error' | 'video-ended' | 'video-retuned';

export interface FramePayload {
  session: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
  timestamp: number;
}
