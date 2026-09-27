// Messages between the main process (src/main/capture-host.ts) and the hidden capture page.
// main → page: webContents.executeJavaScript(`window.evniaCapture.<command>(<json>)`, userGesture=true)
// page → main: the capture preload bridge (src/capture/preload.ts) over INTERNAL_CHANNELS.capture*.
//
// Every start carries a session number allocated by main. The page tags its frames and status with it,
// so main can drop anything that belongs to a start it has since stopped or superseded.
// Follow-audio does not use this page: Chromium cannot record a sink monitor (src/main/audio-monitor.ts).

/** Grid the follow-video engine samples (09 §7.2: CalcRGBs(50, 40)). */
export const FRAME_WIDTH = 50;
export const FRAME_HEIGHT = 40;

export interface StartVideoCommand {
  session: number;
  intervalMs: number;
  /** X11: desktopCapturer source id for getUserMedia(chromeMediaSource:'desktop'); null → getDisplayMedia (Wayland portal). */
  sourceId: string | null;
  width: number;
  height: number;
}

export interface CapturePageApi {
  /**
   * Stops the current stream, then opens the screen. Resolves false when the capture is unavailable or
   * denied, or when a later startVideo/stopVideo superseded this one while it was opening.
   */
  startVideo(cmd: StartVideoCommand): Promise<boolean>;
  /** Stops the current stream and cancels a start that is still opening. */
  stopVideo(): void;
}

/** What the capture preload exposes to the page as window.evniaCaptureBridge. */
export interface CaptureBridge {
  frame(session: number, data: Uint8ClampedArray, width: number, height: number, timestamp: number): void;
  status(session: number, kind: CaptureStatusKind, detail: string): void;
}

export type CaptureStatusKind = 'video-started' | 'video-error' | 'video-ended';

export interface FramePayload {
  session: number;
  data: Uint8ClampedArray;
  width: number;
  height: number;
  timestamp: number;
}
