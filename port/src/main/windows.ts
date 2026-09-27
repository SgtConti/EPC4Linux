// Main window and notice toast (01 §3.4, §3.5, §4; vendor classes Xv and Zd).
// The feedback window (online only, 01 §4 / 14 N22) does not exist in the port.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, screen, shell } from 'electron';
import type { Logger } from '../backend/types.ts';
import { hardenWebContents } from './network-guard.ts';
import type { AppPaths } from './paths.ts';
import { NOTICE_SOUND, NOTICE_STYLE } from './shared/store-schema.ts';
import type { ConfigStore } from './store.ts';
import {
  SPLASH_SIZE,
  MIN_WORKING_SIZE,
  type SavedBounds,
  isSavedBounds,
  largestWorkArea,
  noticeBounds,
  workingSize,
} from './window-geometry.ts';

/** Delay between minimize and resize in the vendor's interfaceInitializeCompleted (01 §4 step 4). */
export const INIT_RESIZE_DELAY_MS = 300;
/** Notice auto-hide for noticeStyle Short (01 §4). */
export const NOTICE_SHORT_MS = 5000;
/** Notice re-layout delay after display-metrics-changed (01 §4). */
export const NOTICE_RELAYOUT_MS = 2000;

function secureWebPreferences(preload: string, devTools: boolean): Electron.WebPreferences {
  return {
    preload,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    devTools,
  };
}

/** Shown when build/app/vendor-ui is missing (the vendor UI is not stored in this repository). */
export function missingUiPage(uiIndex: string): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Evnia Precision Center</title><style>
body{margin:0;padding:32px;font:15px/1.5 system-ui,sans-serif;background:#16181d;color:#e8e8ea}
h1{font-size:20px;margin:0 0 12px}code{background:#262a33;padding:2px 6px;border-radius:4px}
p{max-width:720px}</style></head><body>
<h1>The Precision Center user interface is not installed</h1>
<p>This build does not contain the vendor user interface (<code>${esc(uiIndex)}</code> is missing).
It is extracted from your own copy of the Windows installer and is not part of the source tree.</p>
<p>From the <code>port/</code> directory run <code>npm run import-ui</code>, then <code>npm run build</code>
(and <code>npm run dist:deb</code> for a package), and start the app again.</p>
</body></html>`;
}

export interface MainWindowOptions {
  paths: AppPaths;
  store: ConfigStore;
  log: Logger;
  openAsHidden: boolean;
  isFirstRun: boolean;
  /** DevTools allowed (debug flag or unpackaged). */
  devTools: boolean;
  /** Reload allowed (unpackaged builds, vendor handleRefresh). */
  allowReload: boolean;
  onReadyToShow: () => void;
  /** The user asked to close the window (window manager close or the renderer's close button). */
  onCloseRequested: () => void;
}

export class MainWindowController {
  readonly window: BrowserWindow;
  readonly uiAvailable: boolean;
  interfaceInitializeCompleted = false;
  #nextMaximized = false;
  #allowClose = false;
  readonly #o: MainWindowOptions;
  readonly #lastBounds: SavedBounds | undefined;
  #loadedUrl = '';

  constructor(o: MainWindowOptions) {
    this.#o = o;
    const saved = o.store.get('mainWindowBounds');
    this.#lastBounds = isSavedBounds(saved) ? saved : undefined;
    this.uiAvailable = existsSync(o.paths.uiIndex);
    this.window = new BrowserWindow({
      ...SPLASH_SIZE,
      minWidth: SPLASH_SIZE.width,
      minHeight: SPLASH_SIZE.height,
      maxWidth: this.uiAvailable ? SPLASH_SIZE.width : undefined,
      maxHeight: this.uiAvailable ? SPLASH_SIZE.height : undefined,
      resizable: !this.uiAvailable,
      maximizable: false,
      // The vendor UI draws its own title bar; the error page needs the system frame to be closable.
      frame: !this.uiAvailable,
      hasShadow: false,
      show: false,
      skipTaskbar: false,
      backgroundColor: '#000000',
      icon: existsSync(join(o.paths.resourcesDir, 'favicon.png')) ? join(o.paths.resourcesDir, 'favicon.png') : undefined,
      title: 'Evnia Precision Center',
      webPreferences: secureWebPreferences(o.paths.preload, o.devTools),
    });
    this.window.setMenuBarVisibility(false);
    hardenWebContents(this.window.webContents, () => [this.#loadedUrl], o.log);
    this.window.on('ready-to-show', () => {
      o.log.info('On ready-to-show');
      o.onReadyToShow();
    });
    this.window.on('close', (e) => {
      if (this.#allowClose) return;
      e.preventDefault();
      o.log.debug('Main window close trigger');
      o.onCloseRequested();
    });
    this.window.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = input.key.toLowerCase();
      if (input.alt && input.shift && key === 'm') {
        event.preventDefault();
        this.toggleDevTools();
      } else if ((input.control || input.meta) && key === 'r') {
        event.preventDefault();
        if (o.allowReload) void this.load();
        else o.log.debug('Window refresh disabled');
      }
    });
  }

  async load(): Promise<void> {
    const { paths, log } = this.#o;
    if (this.uiAvailable) {
      this.#loadedUrl = pathToFileURL(paths.uiIndex).href;
      await this.window.loadFile(paths.uiIndex);
    } else {
      log.error(`Renderer not found at ${paths.uiIndex}; run "npm run import-ui" and rebuild`);
      this.#loadedUrl = `data:text/html;charset=utf-8,${encodeURIComponent(missingUiPage(paths.uiIndex))}`;
      await this.window.loadURL(this.#loadedUrl);
    }
  }

  /** Vendor start(): show unless --openAsHidden (position then center, as the vendor did). */
  start(): void {
    this.#o.log.info('Main window start');
    this.#o.log.info('--OpenAsHidden', this.#o.openAsHidden ? 1 : -1);
    if (this.#o.openAsHidden) return;
    if (this.#lastBounds) this.window.setPosition(this.#lastBounds.x, this.#lastBounds.y);
    this.window.center();
    this.window.show();
  }

  /** Vendor showMainWindow(focus) (01 §3.5). */
  show(focus: boolean, trayOptionsEnabled: boolean): void {
    const w = this.window;
    if (w.isDestroyed()) return;
    w.setAlwaysOnTop(true);
    if (w.isMinimized()) w.restore();
    else if (!w.isVisible()) {
      if (trayOptionsEnabled) w.webContents.send('toPageView', 'overview');
      if (this.#nextMaximized) w.maximize();
      w.show();
      w.setSkipTaskbar(false);
    }
    w.setAlwaysOnTop(false);
    w.webContents.send('mainWindowShow');
    if (focus) w.focus();
  }

  hide(): void {
    if (this.window.isDestroyed()) return;
    this.window.hide();
    this.window.setSkipTaskbar(true);
  }

  send(channel: string, ...args: unknown[]): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(channel, ...args);
  }

  /** Vendor setMaximumSize: the largest work area over all displays. */
  applyMaximumSize(): void {
    const best = largestWorkArea(screen.getAllDisplays().map((d) => d.workAreaSize));
    if (!best || this.window.isDestroyed()) return;
    this.#o.log.info('setMaximumSize', best.width, best.height);
    this.window.setMaximumSize(best.width, best.height);
  }

  /**
   * interfaceInitializeCompleted (01 §4). Deviation: the vendor minimized the window and showed it
   * again 300 ms later to hide the resize; on Wayland a client cannot un-minimize itself, which would
   * leave the window minimized, so the port resizes in place after the same delay.
   */
  onInterfaceInitializeCompleted(): void {
    const w = this.window;
    this.interfaceInitializeCompleted = true;
    w.setMaximizable(true);
    w.setResizable(true);
    w.setMinimumSize(MIN_WORKING_SIZE.width, MIN_WORKING_SIZE.height);
    this.applyMaximumSize();
    const b = w.getBounds();
    const size = workingSize(this.#lastBounds, screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workAreaSize);
    this.#o.log.info(`Set main window size ${size.width}x${size.height}`);
    if (this.#o.openAsHidden) {
      w.setSize(size.width, size.height, true);
      w.center();
      this.#nextMaximized = this.#lastBounds?.maximized ?? false;
      return;
    }
    setTimeout(() => {
      if (w.isDestroyed()) return;
      w.setSize(size.width, size.height, true);
      if (this.#o.isFirstRun || this.#lastBounds?.maximized) w.maximize();
      else w.center();
      if (!w.isVisible()) w.show();
    }, INIT_RESIZE_DELAY_MS);
  }

  /** resetToStartSize (01 §10.1 #3): only after interfaceInitializeCompleted. */
  resetToStartSize(): void {
    if (!this.interfaceInitializeCompleted) return;
    const w = this.window;
    w.unmaximize();
    w.setMaximizable(false);
    w.setResizable(false);
    w.setMinimumSize(SPLASH_SIZE.width, SPLASH_SIZE.height);
    w.setMaximumSize(SPLASH_SIZE.width, SPLASH_SIZE.height);
    w.setSize(SPLASH_SIZE.width, SPLASH_SIZE.height);
    w.center();
  }

  /** setWindowSize (01 §10.1 #16). */
  setWindowSize(width: number, height: number): void {
    if (!(width > 0 && height > 0)) return;
    this.window.setSize(Math.round(width), Math.round(height));
    this.window.center();
    this.saveBounds();
  }

  saveBounds(): void {
    if (this.window.isDestroyed()) return;
    this.#o.store.set('mainWindowBounds', { ...this.window.getBounds(), maximized: this.window.isMaximized() });
  }

  toggleDevTools(): void {
    if (!this.#o.devTools) return;
    const wc = (BrowserWindow.getFocusedWindow() ?? this.window).webContents;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'undocked' });
  }

  /** Let the next close go through (app exit). */
  destroy(): void {
    this.#allowClose = true;
    if (!this.window.isDestroyed()) this.window.destroy();
  }
}

export interface NoticeWindowOptions {
  paths: AppPaths;
  store: ConfigStore;
  log: Logger;
}

/** The toast window of the `notice` IPC (01 §4, vendor Zd). */
export class NoticeWindowController {
  readonly #o: NoticeWindowOptions;
  #win: BrowserWindow | null = null;
  #bounds = { x: 0, y: 0, width: 0, height: 0 };
  #hideTimer: ReturnType<typeof setTimeout> | undefined;
  #relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  #loadedUrl = '';

  constructor(o: NoticeWindowOptions) {
    this.#o = o;
  }

  get webContents(): Electron.WebContents | null {
    return this.#win && !this.#win.isDestroyed() ? this.#win.webContents : null;
  }

  /** Created eagerly like the vendor; skipped when the vendor UI is not installed. */
  create(): void {
    if (!existsSync(this.#o.paths.noticeIndex)) {
      this.#o.log.warn(`Notice page missing (${this.#o.paths.noticeIndex}); notices are disabled`);
      return;
    }
    this.#computeBounds();
    const win = new BrowserWindow({
      ...this.#bounds,
      show: false,
      frame: false,
      resizable: false,
      fullscreen: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: secureWebPreferences(this.#o.paths.preload, false),
    });
    this.#win = win;
    this.#loadedUrl = pathToFileURL(this.#o.paths.noticeIndex).href;
    hardenWebContents(win.webContents, () => [this.#loadedUrl], this.#o.log);
    win.once('closed', () => {
      if (this.#win === win) this.#win = null;
    });
    win.loadFile(this.#o.paths.noticeIndex).catch((e: unknown) => this.#o.log.error('Notice page failed to load', e));
    screen.on('display-metrics-changed', this.#onMetricsChanged);
  }

  /** `notice` IPC: (show, key, ...args) (01 §4, index.js:9266-9283). */
  notice(show: boolean, key: string, args: unknown[]): void {
    const { store } = this.#o;
    if (!(show && store.get('noticeSwitch') === true)) {
      this.hide();
      return;
    }
    if (store.get('noticeSound') === NOTICE_SOUND.SystemSound) shell.beep();
    this.webContents?.send('setNotice', key, ...args);
    if (this.#hideTimer) clearTimeout(this.#hideTimer);
    const style = store.get('noticeStyle');
    if (style === NOTICE_STYLE.No) return;
    if (style === NOTICE_STYLE.Short) this.#hideTimer = setTimeout(() => this.hide(), NOTICE_SHORT_MS);
    this.#show();
  }

  relayLanguage(language: string): void {
    this.webContents?.send('setLanguage', language);
  }

  hide(): void {
    if (this.#win && !this.#win.isDestroyed()) this.#win.hide();
  }

  destroy(): void {
    screen.removeListener('display-metrics-changed', this.#onMetricsChanged);
    if (this.#hideTimer) clearTimeout(this.#hideTimer);
    if (this.#relayoutTimer) clearTimeout(this.#relayoutTimer);
    if (this.#win && !this.#win.isDestroyed()) this.#win.destroy();
    this.#win = null;
  }

  /** The toast must not take keyboard focus from the application the user is working in. */
  #show(): void {
    if (!this.#win || this.#win.isDestroyed()) return;
    this.#win.showInactive();
    this.#win.setBounds(this.#bounds);
  }

  #computeBounds(): void {
    const primary = screen.getPrimaryDisplay();
    this.#bounds = noticeBounds(primary.workArea, primary.scaleFactor);
  }

  readonly #onMetricsChanged = (): void => {
    if (!this.#win || this.#win.isDestroyed() || !this.#win.isVisible()) return;
    if (this.#relayoutTimer) clearTimeout(this.#relayoutTimer);
    this.#win.hide();
    this.#relayoutTimer = setTimeout(() => {
      this.#computeBounds();
      this.#show();
    }, NOTICE_RELAYOUT_MS);
  };
}
