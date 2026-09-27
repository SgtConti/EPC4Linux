// ipcMain handlers: exactly the channels 01 §10.1 marks Keep/Adapt (shared/channels.ts), plus the
// internal store/nodeApi channels of our preload. Stripped channels have no handler at all; the
// preload answers them inertly (02 §L.2). Every handler checks that the sender is the top frame of the
// main or notice window, so neither the capture page nor a subframe nor any other web contents can
// use them. Electron is injected (IpcElectron) so the handlers are unit-tested with fakes.
//
// window.store write-through (02 §2.2): main owns config.json (01 §6). A change is broadcast on
// INTERNAL_CHANNELS.storeChanged to every trusted window except the one that made it, which already
// updated its own snapshot.

import { existsSync, unlinkSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import type { BrowserWindow, Dialog, IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import type { Logger } from '../backend/types.ts';
import type { DeviceChangeGate } from './device-events.ts';
import { isAppPickerRequest, sanitizeOpenDialogOptions, sanitizeSaveDialogOptions, withSaveExtension } from './dialog-options.ts';
import { copyRegularFileSync, MAX_RENDERER_FILE_BYTES, md5RegularFile, readPickedFile, readRegularFile, readRegularFileSync } from './file-read.ts';
import type { PathGuard } from './fs-guard.ts';
import type { MonitorJsonConfig } from './monitor-info.ts';
import type { AppPaths } from './paths.ts';
import { rendererLogLine } from './renderer-log.ts';
import { type BootstrapData, ELECTRON_STORE_SYNC_CHANNEL, type FsSyncResult, INTERNAL_CHANNELS } from './shared/channels.ts';
import { VENDOR_APP_VERSION } from './shared/store-schema.ts';
import type { ConfigStore } from './store.ts';
import type { MainWindowController, NoticeWindowController } from './windows.ts';

/** window.runConfig (01 §10.1 #1, 02 §1.3). */
export interface RunConfig {
  appVersion: string;
  isDebugMode: boolean;
  isFirstRun: boolean;
  isPackaged: boolean;
  mac: string;
  patchPath: string;
  processPath: string;
  userDataPath: string;
}

/** What the handlers need from the application object (src/main/index.ts). */
export interface IpcHost {
  readonly log: Logger;
  readonly paths: AppPaths;
  readonly store: ConfigStore;
  readonly guard: PathGuard;
  readonly gate: DeviceChangeGate;
  readonly main: MainWindowController;
  readonly notice: NoticeWindowController;
  readonly hubToken: string;
  runConfig(): RunConfig;
  startBackend(): Promise<number>;
  monitorJsonConfig(): MonitorJsonConfig;
  onInterfaceInitializeCompleted(): void;
  requestClose(): void;
  setLanguage(language: string): void;
  setAutoStartUp(enabled: boolean | undefined, minimized: boolean | undefined): void;
  setTrayFlags(flags: { exitDisabled?: boolean; functionDisabled?: boolean }): void;
}

/** The Electron APIs the handlers use (the real modules in index.ts, fakes in tests). */
export interface IpcElectron {
  ipcMain: Pick<IpcMain, 'handle' | 'on'>;
  dialog: Pick<Dialog, 'showOpenDialog' | 'showSaveDialog'>;
  /** BrowserWindow.getFocusedWindow */
  focusedWindow(): BrowserWindow | null;
  /** BrowserWindow.fromWebContents */
  windowOf(wc: WebContents): BrowserWindow | null;
}

/**
 * A file larger than this is returned by fileSelect without its content (buffer: null): the renderer's own
 * import/upload limit (file-read.ts). nodeApi reads and copies refuse larger files with EFBIG.
 */
export const FILE_SELECT_MAX_BUFFER = MAX_RENDERER_FILE_BYTES;

const TEXT_ENCODINGS = new Set(['utf8', 'utf-8', 'latin1', 'ascii', 'base64', 'hex', 'utf16le', 'ucs2']);

type FsFailure = Extract<FsSyncResult<never>, { ok: false }>;

function denied(p: unknown): FsFailure {
  return { ok: false, code: 'EACCES', message: `EACCES: permission denied, '${String(p)}'` };
}

function fsFailure(e: unknown): FsFailure {
  const err = e as NodeJS.ErrnoException;
  return { ok: false, code: err.code ?? 'EIO', message: err.message ?? String(e) };
}

function textEncoding(enc: unknown): BufferEncoding | null {
  return typeof enc === 'string' && TEXT_ENCODINGS.has(enc.toLowerCase()) ? (enc.toLowerCase() as BufferEncoding) : null;
}

/** readFile's result shape: text for an encoding, else the bytes (a fresh Uint8Array, file-read.ts). */
function decoded(data: Uint8Array, enc: unknown): string | Uint8Array {
  const encoding = textEncoding(enc);
  return encoding ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString(encoding) : data;
}

/** The IPC event came from the top frame of one of the trusted web contents. */
export function isTrustedSender(e: Pick<IpcMainEvent, 'sender' | 'senderFrame'>, trusted: readonly WebContents[]): boolean {
  return trusted.includes(e.sender) && e.senderFrame !== null && e.senderFrame === e.sender.mainFrame;
}

export function registerIpcHandlers(h: IpcHost, electron: IpcElectron): void {
  const { ipcMain, dialog } = electron;
  const log = h.log;
  const trustedContents = (): WebContents[] =>
    [h.main.window.isDestroyed() ? null : h.main.window.webContents, h.notice.webContents].filter(
      (wc): wc is WebContents => wc !== null && !wc.isDestroyed(),
    );
  const trusted = (e: IpcMainEvent | IpcMainInvokeEvent): boolean => isTrustedSender(e, trustedContents());
  const handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (e, ...args) => {
      if (!trusted(e)) throw new Error(`IPC ${channel} refused for this sender`);
      return fn(e, ...args);
    });
  const on = (channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => void) =>
    ipcMain.on(channel, (e, ...args) => {
      if (!trusted(e)) {
        log.warn(`IPC ${channel} refused for this sender`);
        return;
      }
      fn(e, ...args);
    });
  /** Sync channels must always set returnValue, or the sender blocks forever. */
  const onSync = (channel: string, fn: (e: IpcMainEvent, ...args: unknown[]) => unknown, refused: unknown) =>
    ipcMain.on(channel, (e, ...args) => {
      if (!trusted(e)) {
        log.warn(`IPC ${channel} refused for this sender`);
        e.returnValue = refused;
        return;
      }
      try {
        e.returnValue = fn(e, ...args);
      } catch (err) {
        log.error(`IPC ${channel} failed`, err);
        e.returnValue = refused;
      }
    });
  const focusedOrMain = (useMain: unknown): BrowserWindow | null => (useMain === true ? h.main.window : electron.focusedWindow());

  // ── store broadcast ──
  let storeOrigin: WebContents | null = null;
  const withStoreOrigin = (origin: WebContents, fn: () => void): void => {
    storeOrigin = origin;
    try {
      fn();
    } finally {
      storeOrigin = null;
    }
  };
  h.store.onChange((key, value) => {
    for (const wc of trustedContents()) if (wc !== storeOrigin) wc.send(INTERNAL_CHANNELS.storeChanged, key, value);
  });

  // ── 01 §10.1 Keep/Adapt ──
  handle('getRunConfig', () => h.runConfig());
  handle('startupBackendService', () => h.startBackend());
  on('resetToStartSize', () => h.main.resetToStartSize());
  on('interfaceInitializeCompleted', () => h.onInterfaceInitializeCompleted());
  on('minimize', (_e, useMain) => {
    if (focusedOrMain(useMain)) h.main.window.minimize();
  });
  handle('maximizedValue', (_e, useMain) => focusedOrMain(useMain)?.isMaximized() ?? false);
  handle('maximizeToggler', (_e, useMain) => {
    const w = focusedOrMain(useMain);
    if (!w) return false;
    if (w.isFullScreen()) w.setFullScreen(false);
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return w.isMaximized();
  });
  on('close', (_e, useMain) => {
    const w = focusedOrMain(useMain);
    if (!w) return;
    if (w === h.main.window) h.requestClose();
    else {
      w.hide();
      w.setSkipTaskbar(true);
    }
  });
  handle('fileSelect', async (e, options) => {
    const win = electron.windowOf(e.sender);
    if (!win) return { path: '', size: 0 };
    // The application picker (["exe"]) becomes a .desktop chooser (dialog-options.ts). Its pick is only a
    // BindAppFilePath for the backend, so it is neither read nor made readable through nodeApi.
    const appPicker = isAppPickerRequest(options);
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog(win, sanitizeOpenDialogOptions(options));
      const path = filePaths[0];
      if (canceled || !path) return { path: '', size: 0, buffer: null };
      if (appPicker) return { path, size: (await stat(path)).size, buffer: null };
      // Regular files only, content up to the renderer's own limit (file-read.ts): a FIFO or device picked
      // by name would otherwise hang or exhaust main.
      const file = await readPickedFile(path, FILE_SELECT_MAX_BUFFER);
      if (!file) {
        log.warn(`File select: ${path} is not a regular file, ignored`);
        return { path: '', size: 0, buffer: null };
      }
      h.guard.allowChosen(path);
      return { path, size: file.size, buffer: file.data };
    } catch (err) {
      log.error('File select error', err);
      return { path: '', size: 0 };
    }
  });
  handle('getFileSize', async (_e, p) => {
    const path = h.guard.readable(p);
    if (!path) throw new Error(denied(p).message);
    return (await stat(path)).size;
  });
  handle('exportFile', async (_e, options) => {
    const sanitized = sanitizeSaveDialogOptions(options);
    const r = await dialog.showSaveDialog(h.main.window, sanitized);
    const chosen = r.filePath ?? '';
    if (r.canceled || !chosen) return { canceled: r.canceled, filePath: chosen };
    const exists = (p: string) => access(p).then(() => true, () => false);
    const filePath = await withSaveExtension(chosen, sanitized, exists);
    // The renderer hands this path to Theme_ExportProfile / Macro_Export: the backend may write it, once
    // (fs-guard.ts backendMayAccess); no other path outside the app's temp files.
    h.guard.grantWrite(filePath);
    return { canceled: false, filePath };
  });
  handle('getFileMd5', async (_e, p) => {
    const path = h.guard.readable(p);
    return path ? md5RegularFile(path) : '';
  });
  on('setWindowSize', (_e, w, hgt) => h.main.setWindowSize(Number(w), Number(hgt)));
  on('setLanguage', (_e, lang) => h.setLanguage(String(lang ?? '')));
  on('setAutoStartUp', (_e, enabled, minimized) =>
    h.setAutoStartUp(typeof enabled === 'boolean' ? enabled : undefined, typeof minimized === 'boolean' ? minimized : undefined),
  );
  handle('getMonitorJsonConfig', () => h.monitorJsonConfig());
  on('disableTrayExit', (_e, flag) => h.setTrayFlags({ exitDisabled: flag === true }));
  on('disableTrayFunction', (_e, flag) => h.setTrayFlags({ functionDisabled: flag === true }));
  on('shieldDisplayChange', (_e, flag, seconds) =>
    h.gate.shieldDisplayChange(flag === true, seconds === undefined ? undefined : Number(seconds) || 0),
  );
  on('shieldPeripheralChange', (_e, flag) => h.gate.shieldPeripheralChange(flag === true));
  on('notice', (_e, show, key, ...args) => h.notice.notice(show === true, typeof key === 'string' ? key : '', args));
  onSync(ELECTRON_STORE_SYNC_CHANNEL, () => ({ defaultCwd: h.paths.userData, appVersion: VENDOR_APP_VERSION }), null);

  // ── preload internals ──
  onSync(
    INTERNAL_CHANNELS.bootstrap,
    (e): BootstrapData => ({ store: h.store.snapshot(), hubToken: e.sender === h.main.window.webContents ? h.hubToken : '' }),
    { store: {}, hubToken: '' },
  );
  on(INTERNAL_CHANNELS.storeSet, (e, key, value) => {
    withStoreOrigin(e.sender, () => {
      try {
        h.store.set(String(key), value);
      } catch (err) {
        log.warn(`store.set(${String(key)}) refused: ${(err as Error).message}`);
      }
    });
  });
  on(INTERNAL_CHANNELS.storeDelete, (e, key) => withStoreOrigin(e.sender, () => h.store.delete(String(key))));
  // The renderer's electron-log lines (window.__electronLog, src/main/renderer-log.ts) into the main log.
  const rendererLog = log.child('renderer');
  on(INTERNAL_CHANNELS.rendererLog, (_e, message) => {
    const line = rendererLogLine(message);
    if (line) rendererLog[line.level](line.text);
  });

  onSync(INTERNAL_CHANNELS.fsExists, (_e, p) => {
    const path = h.guard.readable(p);
    return path !== null && existsSync(path);
  }, false);
  // Reads and copies take regular files of at most MAX_RENDERER_FILE_BYTES only (file-read.ts): the sync
  // channels block main while they run, and a FIFO or device would block or grow without end.
  onSync(INTERNAL_CHANNELS.fsReadSync, (_e, p, enc): FsSyncResult<string | Uint8Array> => {
    const path = h.guard.readable(p);
    if (!path) return denied(p);
    try {
      return { ok: true, value: decoded(readRegularFileSync(path), enc) };
    } catch (err) {
      return fsFailure(err);
    }
  }, denied(''));
  handle(INTERNAL_CHANNELS.fsRead, async (_e, p, enc): Promise<FsSyncResult<string | Uint8Array>> => {
    const path = h.guard.readable(p);
    if (!path) return denied(p);
    try {
      return { ok: true, value: decoded(await readRegularFile(path), enc) };
    } catch (err) {
      return fsFailure(err);
    }
  });
  onSync(INTERNAL_CHANNELS.fsCopySync, (_e, src, dest): FsSyncResult<null> => {
    const from = h.guard.readable(src);
    if (!from) return denied(src);
    const to = h.guard.copyTarget(dest);
    if (!to) {
      log.warn(`nodeApi.copyFileSync refused: ${String(dest)} is not a new temporary file directly in ${h.paths.userData}`);
      return denied(dest);
    }
    try {
      copyRegularFileSync(from, to);
      h.guard.noteCreated(to);
      return { ok: true, value: null };
    } catch (err) {
      return fsFailure(err);
    }
  }, denied(''));
  onSync(INTERNAL_CHANNELS.fsUnlinkSync, (_e, p): FsSyncResult<null> => {
    const path = h.guard.removable(p);
    if (!path) return denied(p);
    try {
      unlinkSync(path);
      h.guard.noteRemoved(path);
      return { ok: true, value: null };
    } catch (err) {
      return fsFailure(err);
    }
  }, denied(''));
}
