// Network kill-switch and web-contents hardening (ARCHITECTURE "Key design rules" 4 and 5,
// 02 §L.3 "Network kill-switch", 14 §3 N09/N12/N13).
//
// Every renderer request passes session.webRequest.onBeforeRequest. Only local schemes and the
// loopback hub WebSocket are let through; everything else is cancelled before any socket or DNS
// lookup happens, and logged (without query strings, so the hub token never lands in a log).
// Navigation, window.open, <webview> and device/permission requests are denied, except
// media/display-capture for the hidden capture window (09 §7).
//
// `file:` is local but not harmless: a file: page may fetch/XHR other file: URLs, and file: images
// do not taint a canvas, because Electron's GrantFileProtocolExtraPrivileges fuse is on (it has to
// stay on: the vendor UI's `<script type=module crossorigin>` needs it under file://). The CSP's
// 'self' also matches every file: URL. So file: requests are allowed only below the app's own tree
// (`fileRoots`: the vendor UI and the capture page); anything else a renderer asks for, e.g.
// file:///home/<user>/.ssh/id_rsa or ~/Pictures/*.png, is cancelled and logged like a network
// request. User files reach the renderer only through window.nodeApi's path confinement (fs-guard.ts)
// and the local: image protocol (local-protocol.ts). ARCHITECTURE rules 4 and 5.

import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session, WebContents } from 'electron';
import type { Logger } from '../backend/types.ts';

/**
 * Schemes that never leave the machine. `local:` is the confined image protocol (local-protocol.ts);
 * `file:` is further limited to the file roots (isAllowedFileUrl).
 */
export const LOCAL_PROTOCOLS: ReadonlySet<string> = new Set(['file:', 'data:', 'blob:', 'devtools:', 'chrome:', 'local:']);

/** SignalR hub path served by src/backend/hub (02 §4.1, ARCHITECTURE "Big picture"). */
export const HUB_PATH = '/EvniaHub';
export const HUB_HOST = '127.0.0.1';

/** Permissions the capture window may use (getUserMedia of the X11 desktop source, getDisplayMedia). */
export const CAPTURE_PERMISSIONS: ReadonlySet<string> = new Set(['media', 'display-capture']);

/**
 * A file: URL of this machine (no host) whose path is one of `fileRoots` or lies below one. The check is
 * lexical on the resolved path, which is also what Chromium opens: `..` segments are gone after URL
 * parsing, and percent-encoded separators are refused by fileURLToPath.
 */
export function isAllowedFileUrl(u: URL, fileRoots: readonly string[]): boolean {
  if (u.protocol !== 'file:' || u.host !== '') return false;
  let p: string;
  try {
    p = resolve(fileURLToPath(u));
  } catch {
    return false;
  }
  return fileRoots.some((r) => {
    const root = resolve(r);
    return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
  });
}

/**
 * The kill-switch predicate: true when a request to `url` may proceed. `fileRoots` are the only
 * directories file: requests may read (the app tree, AppPaths.appRoot).
 */
export function isAllowedRequestUrl(url: string, hubPort: number | null, fileRoots: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === 'file:') return isAllowedFileUrl(u, fileRoots);
  if (LOCAL_PROTOCOLS.has(u.protocol)) return true;
  return (
    u.protocol === 'ws:' &&
    hubPort !== null &&
    u.hostname === HUB_HOST &&
    u.port === String(hubPort) &&
    u.pathname === HUB_PATH &&
    u.username === '' &&
    u.password === ''
  );
}

/** URL without query/fragment/credentials, capped, for logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const shown = u.protocol === 'data:' || u.protocol === 'blob:' ? `${u.protocol}…` : `${u.protocol}//${u.host}${u.pathname}`;
    return shown.length > 200 ? `${shown.slice(0, 200)}…` : shown;
  } catch {
    return '<unparseable url>';
  }
}

function withoutFragmentAndQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut < 0 ? url : url.slice(0, cut);
}

/** In-app navigation is limited to the page a window was created with (hash/query changes allowed). */
export function isAllowedNavigation(target: string, allowedPages: readonly string[]): boolean {
  const t = withoutFragmentAndQuery(target);
  return allowedPages.some((p) => withoutFragmentAndQuery(p) === t);
}

export interface NetworkGuardOptions {
  log: Logger;
  /** Port of the running hub, or null before startupBackendService succeeded. */
  hubPort: () => number | null;
  /** Directories file: requests may read: the app tree (AppPaths.appRoot). Nothing else of the disk. */
  fileRoots: readonly string[];
  /** True for web contents allowed to capture screen/audio (the hidden capture window only). */
  mayCapture?: (wc: WebContents) => boolean;
}

/** Install the kill-switch and the permission policy on one session. */
export function installNetworkGuard(ses: Session, opts: NetworkGuardOptions): void {
  const { log, hubPort } = opts;
  const fileRoots = [...opts.fileRoots];
  const mayCapture = opts.mayCapture ?? (() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (isAllowedRequestUrl(details.url, hubPort(), fileRoots)) {
      callback({});
      return;
    }
    log.warn(`Blocked ${details.resourceType} request to ${redactUrl(details.url)}`);
    callback({ cancel: true });
  });
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const granted = mayCapture(wc) && CAPTURE_PERMISSIONS.has(permission);
    if (!granted) log.warn(`Denied permission request "${permission}"`);
    callback(granted);
  });
  ses.setPermissionCheckHandler((wc, permission) => wc !== null && mayCapture(wc) && CAPTURE_PERMISSIONS.has(permission));
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback(null);
  });
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  ses.on('select-serial-port', (event, _ports, _wc, callback) => {
    event.preventDefault();
    callback('');
  });
  // 14 N13: Electron would otherwise fetch Hunspell dictionaries from a Google CDN on Linux.
  ses.setSpellCheckerEnabled(false);
}

/** Deny window.open, foreign navigation, redirects and <webview> for one web contents. */
export function hardenWebContents(wc: WebContents, allowedPages: () => readonly string[], log: Logger): void {
  wc.setWindowOpenHandler(({ url }) => {
    log.warn(`Blocked window.open to ${redactUrl(url)}`);
    return { action: 'deny' };
  });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isAllowedNavigation(url, allowedPages())) return;
    event.preventDefault();
    log.warn(`Blocked navigation to ${redactUrl(url)}`);
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (event) => {
    event.preventDefault();
    log.warn('Blocked <webview> attachment');
  });
}
