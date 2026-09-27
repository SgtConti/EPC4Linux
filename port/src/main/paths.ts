// Filesystem layout of the Electron app (01 §2 adapted to Linux, ARCHITECTURE rule 6).
//
// build/app (or resources/app.asar in the .deb):
//   main.cjs (main process + in-process backend), preload.cjs, capture-preload.cjs,
//   capture/{capture.html,capture.js}, vendor-ui/{index.html,notice/notice.html,…},
//   resources/{MonitorInfo.json,favicon.png,tray_*.png,…}
// user data: ~/.config/evnia (config.json, logs/, MonitorInfo.json override, ImageCache/),
//            ~/.config/EvniaServe (backend data, same layout as %APPDATA%\EvniaServe).
// debug flag: $XDG_RUNTIME_DIR/evnia-debug-open.tmp. The vendor used %TEMP%, which is per user on
//            Windows; /tmp is shared on Linux, so the per-user runtime directory takes its place
//            (os.tmpdir() only when XDG_RUNTIME_DIR is unset) and the flag must be a regular file
//            owned by the user (01 port plan 10).

import { existsSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { xdgDataDirs } from '../backend/theme/desktop-entry.ts';
import { versionToInt } from './monitor-info.ts';
import { VENDOR_APP_VERSION } from './shared/store-schema.ts';

export interface AppPaths {
  appRoot: string;
  resourcesDir: string;
  vendorUiDir: string;
  uiIndex: string;
  noticeIndex: string;
  captureHtml: string;
  preload: string;
  capturePreload: string;
  userData: string;
  serveDataDir: string;
  logsDir: string;
  backendLogsDir: string;
  imageCacheDir: string;
  /** Vendor resource-patch directory (01 §12.4); only read by the renderer's translation override. */
  patchPath: string;
  /** Vendor debug flag file (01 §2): debug logging + DevTools; see debugFlagSet(). */
  debugFlag: string;
  firstRunMarker: string;
  bundledMonitorInfo: string;
  userMonitorInfo: string;
}

export const USER_DATA_NAME = 'evnia';
export const SERVE_DATA_NAME = 'EvniaServe';
export const DEBUG_FLAG_NAME = `${USER_DATA_NAME}-debug-open.tmp`;

/**
 * The port's desktop entry (packaging/deb/evnia-precision-center.desktop; the same name as the backend's
 * theme/store.ts SELF_DESKTOP_FILE, which refuses to bind it).
 */
export const SELF_DESKTOP_FILE = 'evnia-precision-center.desktop';
/** Where the .deb installs it. */
export const INSTALLED_DESKTOP_FILE = `/usr/share/applications/${SELF_DESKTOP_FILE}`;

/**
 * window.runConfig.processPath on Linux (20-theme-profile-engine §10.2 item 2): the renderer's only use is
 * `picked === processPath` → "CannotBindSelf" in the app picker, which now offers .desktop files. So it is
 * the port's own entry as the XDG lookup finds it (a user override in ~/.local/share/applications first),
 * else the installed path.
 */
export function selfDesktopFile(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  for (const dir of xdgDataDirs(env)) {
    const p = join(dir, 'applications', SELF_DESKTOP_FILE);
    if (exists(p)) return p;
  }
  return INSTALLED_DESKTOP_FILE;
}

/** Per-user temporary directory for the debug flag: $XDG_RUNTIME_DIR, else os.tmpdir(). */
export function userRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.XDG_RUNTIME_DIR;
  return dir && isAbsolute(dir) ? dir : tmpdir();
}

export function resolveAppPaths(appRoot: string, appData: string, runtimeDir: string): AppPaths {
  const resourcesDir = join(appRoot, 'resources');
  const vendorUiDir = join(appRoot, 'vendor-ui');
  const userData = join(appData, USER_DATA_NAME);
  const serveDataDir = join(appData, SERVE_DATA_NAME);
  return {
    appRoot,
    resourcesDir,
    vendorUiDir,
    uiIndex: join(vendorUiDir, 'index.html'),
    noticeIndex: join(vendorUiDir, 'notice', 'notice.html'),
    captureHtml: join(appRoot, 'capture', 'capture.html'),
    preload: join(appRoot, 'preload.cjs'),
    capturePreload: join(appRoot, 'capture-preload.cjs'),
    userData,
    serveDataDir,
    logsDir: join(userData, 'logs'),
    backendLogsDir: join(serveDataDir, 'logs'),
    imageCacheDir: join(userData, 'ImageCache'),
    patchPath: join(userData, 'patch', `RES_PCenter_${versionToInt(VENDOR_APP_VERSION)}`),
    debugFlag: join(runtimeDir, DEBUG_FLAG_NAME),
    firstRunMarker: join(userData, `${USER_DATA_NAME}-first-run`),
    bundledMonitorInfo: join(resourcesDir, 'MonitorInfo.json'),
    userMonitorInfo: join(userData, 'MonitorInfo.json'),
  };
}

/** The debug flag counts only as a regular file owned by this user (not a symlink, not someone else's). */
export function debugFlagSet(path: string, uid: number | undefined = process.getuid?.()): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && (uid === undefined || st.uid === uid);
  } catch {
    return false;
  }
}

/** Vendor exitApp deletes the flag, so debug mode lasts one run. Never throws. */
export function clearDebugFlag(path: string, uid: number | undefined = process.getuid?.()): void {
  if (!debugFlagSet(path, uid)) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // best effort: a flag that cannot be removed only keeps debug logging on
  }
}
