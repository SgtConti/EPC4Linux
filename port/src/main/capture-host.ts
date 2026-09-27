// CaptureHost (src/backend/types.ts) for follow-video and follow-audio (09 §7-8, ARCHITECTURE "Linux
// integration").
//
// Video runs on a hidden BrowserWindow in its own in-memory session, so media permissions and the
// display-media handler never apply to the vendor renderer. startVideo creates the window and
// stopVideo destroys it, which also ends the PipeWire/portal session on Wayland. Commands run through
// executeJavaScript with userGesture=true (getDisplayMedia requires transient activation). Frames come
// back over the capture preload, tagged with the session of the start that produced them.
//
// Video source: X11 → the primary display's desktopCapturer source (the vendor captured
// Screen.PrimaryScreen, 09 §7.1). Wayland → getDisplayMedia; the handler below asks desktopCapturer,
// which goes through the xdg-desktop-portal ScreenCast dialog (PipeWire). `useSystemPicker` is set
// for platforms where Electron supports it; on Linux the portal is the system picker. Once the user
// granted a screen, later requests of this run are answered with that source again, so the portal can
// restore the session without a new dialog (capture-sources.ts ScreenGrant).
//
// Sequencing (capture-slot.ts): stopVideo() or a newer startVideo() cancels a start that is still in
// flight, and frames of a cancelled or superseded session are dropped. The page applies the same rule
// to its own awaits (src/capture/page.ts), so no stream outlives its stop. A start that has not
// succeeded within VIDEO_START_TIMEOUT_MS (a portal dialog left open) resolves false and releases the
// window, which withdraws the dialog.
//
// Audio is recorded outside Chromium, which cannot open a sink monitor (audio-monitor.ts).

import { pathToFileURL } from 'node:url';
import { BrowserWindow, desktopCapturer, ipcMain, screen, session, type IpcMainEvent, type Session } from 'electron';
import type { CaptureFrame, CaptureHost, Logger } from '../backend/types.ts';
import { FRAME_HEIGHT, FRAME_WIDTH, type FramePayload, type StartVideoCommand } from '../capture/protocol.ts';
import { type AudioMonitorOptions, type LevelCallback, PulseMonitorCapture } from './audio-monitor.ts';
import { CaptureSlot, withTimeout } from './capture-slot.ts';
import { pickScreenSource, ScreenGrant } from './capture-sources.ts';
import { hardenWebContents, installNetworkGuard } from './network-guard.ts';
import type { AppPaths } from './paths.ts';
import { INTERNAL_CHANNELS } from './shared/channels.ts';

export const CAPTURE_PARTITION = 'evnia-capture';
/** Fastest frame interval accepted (ARCHITECTURE: up to 10 fps). */
export const MIN_FRAME_INTERVAL_MS = 100;
/** A video start still pending after this long (portal dialog left open) resolves false. */
export const VIDEO_START_TIMEOUT_MS = 60_000;

export interface CaptureHostOptions {
  paths: AppPaths;
  log: Logger;
  /** Wayland session: capture through the ScreenCast portal (getDisplayMedia). */
  wayland: boolean;
  /** Overrides for the follow-audio recorder (tests). */
  audio?: Omit<AudioMonitorOptions, 'log'>;
  videoStartTimeoutMs?: number;
}

type FrameCallback = (f: CaptureFrame) => void;

export class ElectronCaptureHost implements CaptureHost {
  readonly #o: CaptureHostOptions;
  readonly #video = new CaptureSlot<FrameCallback>();
  readonly #audio: PulseMonitorCapture;
  /** Wayland: the screen the user granted in this run. */
  readonly #grant = new ScreenGrant();
  #session: Session | null = null;
  #win: BrowserWindow | null = null;
  #opening: Promise<BrowserWindow | null> | null = null;

  constructor(o: CaptureHostOptions) {
    this.#o = o;
    this.#audio = new PulseMonitorCapture({ ...o.audio, log: o.log.child('audio') });
    ipcMain.on(INTERNAL_CHANNELS.captureFrame, this.#frame);
    ipcMain.on(INTERNAL_CHANNELS.captureStatus, this.#status);
  }

  startVideo(intervalMs: number, onFrame: FrameCallback): Promise<boolean> {
    const session = this.#video.begin(onFrame);
    const timeoutMs = this.#o.videoStartTimeoutMs ?? VIDEO_START_TIMEOUT_MS;
    return withTimeout(this.#startVideo(session, intervalMs), timeoutMs, () => {
      if (this.#video.isCurrent(session)) {
        this.#o.log.warn(`Screen capture did not start within ${timeoutMs} ms; giving up`);
        this.#grant.failed();
        this.stopVideo();
      }
      return false;
    });
  }

  stopVideo(): void {
    this.#video.stop();
    this.#destroyWindow();
  }

  startAudio(onLevel: LevelCallback): Promise<boolean> {
    return this.#audio.start(onLevel);
  }

  stopAudio(): void {
    this.#audio.stop();
  }

  dispose(): void {
    this.stopVideo();
    this.stopAudio();
    ipcMain.removeListener(INTERNAL_CHANNELS.captureFrame, this.#frame);
    ipcMain.removeListener(INTERNAL_CHANNELS.captureStatus, this.#status);
  }

  async #startVideo(session: number, intervalMs: number): Promise<boolean> {
    const win = await this.#window();
    if (!this.#video.isCurrent(session)) return false;
    if (!win) return this.#failed(session);
    const sourceId = this.#o.wayland ? null : await this.#primaryScreenSource();
    if (!this.#video.isCurrent(session)) return false;
    if (!this.#o.wayland && !sourceId) {
      this.#o.log.warn('No screen source available for capture');
      return this.#failed(session);
    }
    const cmd: StartVideoCommand = {
      session,
      intervalMs: Math.max(MIN_FRAME_INTERVAL_MS, Math.round(intervalMs) || MIN_FRAME_INTERVAL_MS),
      sourceId,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
    };
    const ok = await this.#run(win, `window.evniaCapture.startVideo(${JSON.stringify(cmd)})`, false);
    if (!this.#video.isCurrent(session)) return false;
    return ok === true ? true : this.#failed(session);
  }

  /** The current start failed: nothing else needs the window, and a reused Wayland grant is dropped. */
  #failed(session: number): false {
    this.#grant.failed();
    this.#video.release(session);
    this.#destroyWindow();
    return false;
  }

  #fromCaptureWindow(e: IpcMainEvent): boolean {
    return this.#win !== null && !this.#win.isDestroyed() && e.sender === this.#win.webContents;
  }

  readonly #frame = (e: IpcMainEvent, p: FramePayload): void => {
    if (!this.#fromCaptureWindow(e) || typeof p?.session !== 'number') return;
    const sink = this.#video.sink(p.session);
    if (!sink) return;
    const bytes: unknown = p.data;
    if (!(bytes instanceof Uint8Array || bytes instanceof Uint8ClampedArray) || bytes.length !== p.width * p.height * 4) return;
    const data = new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    sink({ width: p.width, height: p.height, data, timestamp: p.timestamp });
  };

  readonly #status = (e: IpcMainEvent, sessionId: unknown, kind: unknown, detail: unknown): void => {
    if (!this.#fromCaptureWindow(e) || typeof sessionId !== 'number' || !this.#video.isCurrent(sessionId)) return;
    const k = String(kind);
    const msg = `capture ${k}${detail ? `: ${String(detail)}` : ''}`;
    if (k === 'video-started') {
      this.#o.log.info(msg);
      this.#grant.started();
    } else this.#o.log.warn(msg);
    if (k === 'video-ended') {
      this.#grant.ended();
      this.#video.release(sessionId);
      this.#destroyWindow();
    }
  };

  async #primaryScreenSource(): Promise<string | null> {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      return pickScreenSource(sources, screen.getPrimaryDisplay().id)?.id ?? null;
    } catch (e) {
      this.#o.log.warn('desktopCapturer failed', e);
      return null;
    }
  }

  #captureSession(): Session {
    if (this.#session) return this.#session;
    const ses = session.fromPartition(CAPTURE_PARTITION);
    installNetworkGuard(ses, {
      log: this.#o.log,
      hubPort: () => null,
      // the capture page and its script (capture/ in the app tree); no other file of the disk
      fileRoots: [this.#o.paths.appRoot],
      mayCapture: (wc) => this.#win !== null && !this.#win.isDestroyed() && wc === this.#win.webContents,
    });
    ses.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const answer = (streams: Parameters<typeof callback>[0]) => {
          try {
            callback(streams);
          } catch (e) {
            // The requesting page was destroyed (stopVideo) while the portal dialog was open.
            this.#o.log.debug('Display media request already gone', e);
          }
        };
        const granted = this.#grant.reuse();
        if (granted) {
          this.#o.log.info('Screen capture: reusing the screen granted earlier in this run');
          answer({ video: granted });
          return;
        }
        desktopCapturer
          .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const source = pickScreenSource(sources, screen.getPrimaryDisplay().id);
            if (source) this.#grant.picked(source);
            else this.#o.log.warn('Screen capture was not granted (no source selected)');
            answer(source ? { video: source } : {});
          })
          .catch((e: unknown) => {
            this.#o.log.warn('Screen capture portal failed', e);
            answer({});
          });
      },
      { useSystemPicker: true },
    );
    this.#session = ses;
    return ses;
  }

  /** The loaded capture window; a destroy during the load makes the next call open a new one. */
  #window(): Promise<BrowserWindow | null> {
    if (this.#win && !this.#win.isDestroyed() && !this.#opening) return Promise.resolve(this.#win);
    if (!this.#opening) {
      const opening: Promise<BrowserWindow | null> = this.#open().finally(() => {
        if (this.#opening === opening) this.#opening = null;
      });
      this.#opening = opening;
    }
    return this.#opening;
  }

  async #open(): Promise<BrowserWindow | null> {
    const { paths, log } = this.#o;
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 240,
      skipTaskbar: true,
      webPreferences: {
        preload: paths.capturePreload,
        session: this.#captureSession(),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        devTools: false,
      },
    });
    const url = pathToFileURL(paths.captureHtml).href;
    hardenWebContents(win.webContents, () => [url], log);
    this.#win = win;
    win.once('closed', () => {
      if (this.#win === win) this.#win = null;
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      if (this.#win !== win) return;
      log.warn('Capture page process gone; follow-video stopped', details.reason);
      this.stopVideo();
    });
    try {
      await win.loadFile(paths.captureHtml);
    } catch (e) {
      if (this.#win === win) {
        log.error('Capture page failed to load', e);
        this.#destroyWindow();
      }
      return null;
    }
    return this.#win === win && !win.isDestroyed() ? win : null;
  }

  async #run<T>(win: BrowserWindow, code: string, fallback: T): Promise<T> {
    if (win.isDestroyed()) return fallback;
    try {
      return (await win.webContents.executeJavaScript(code, true)) as T;
    } catch (e) {
      if (!win.isDestroyed()) this.#o.log.warn('Capture command failed', e);
      return fallback;
    }
  }

  #destroyWindow(): void {
    const win = this.#win;
    this.#win = null;
    this.#opening = null;
    if (win && !win.isDestroyed()) win.destroy();
  }
}
