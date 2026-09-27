// `local:` protocol (01 §3.3 item 5, 14 N12).
//
// The renderer builds `"local:///" + absolutePath` for cached device images
// (<userData>/ImageCache/<model>/<face>.png, 02 §11.3) and for app-bound theme icons returned by the
// backend (Comm_GenAppIcon, 13 §4.2). The vendor handler passed the decoded remainder to net.fetch,
// i.e. any file (or even a URL) was reachable. The port serves only image files below an allowlist of
// directories and answers 404 for everything else.
//
// The backend stages Comm_GenAppIcon icons in PATH_APP_TEMP (20-theme §10.1; backend theme/paths.ts
// defaultAppTempDir: $XDG_RUNTIME_DIR/EvniaServe, else $TMPDIR/EvniaServe-<uid>), and main passes that same
// directory to the backend (backend-host.ts appTempDir) and here. In a shared /tmp another local user could
// create the directory first, so such "private" roots are served only while they are a real directory owned
// by this user (the backend applies the same rule before writing there).

import { lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Logger } from '../backend/types.ts';
import { PathGuard } from './fs-guard.ts';

export const LOCAL_SCHEME = 'local';

export const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

/** Absolute file path encoded in a `local:` URL, or null when malformed. */
export function localUrlToPath(url: string): string | null {
  if (!url.startsWith(`${LOCAL_SCHEME}:`)) return null;
  let rest = url.slice(LOCAL_SCHEME.length + 1);
  const cut = rest.search(/[?#]/);
  if (cut >= 0) rest = rest.slice(0, cut);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  const path = decoded.replace(/^\/+/, '/');
  return path.startsWith('/') && !path.includes('\0') ? path : null;
}

/** Resolve a `local:` URL to a servable image path inside `roots`, or null. */
export function resolveLocalImage(url: string, guard: PathGuard): { path: string; type: string } | null {
  const path = localUrlToPath(url);
  if (!path) return null;
  const type = IMAGE_TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  const allowed = guard.readable(path);
  return allowed ? { path: allowed, type } : null;
}

/** A directory (not a symlink) owned by the current user. */
export function isOwnedDirectory(p: string, uid: number | undefined = process.getuid?.()): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && (uid === undefined || st.uid === uid);
  } catch {
    return false;
  }
}

export interface LocalRoots {
  /** App-owned directories (config tree, bundled resources). */
  roots: readonly string[];
  /** Directories in shared locations, served only while isOwnedDirectory() holds. */
  privateRoots: readonly string[];
}

/** Request handler for protocol.handle(LOCAL_SCHEME, …). */
export function createLocalProtocolHandler(dirs: LocalRoots, log: Logger): (req: Request) => Promise<Response> {
  return async (req) => {
    const guard = new PathGuard({ readRoots: [...dirs.roots, ...dirs.privateRoots.filter((d) => isOwnedDirectory(d))] });
    const hit = resolveLocalImage(req.url, guard);
    if (!hit) {
      log.warn(`local: refused ${req.url.slice(0, 200)}`);
      return new Response(null, { status: 404 });
    }
    try {
      const body = await readFile(hit.path);
      return new Response(body, { status: 200, headers: { 'content-type': hit.type } });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
}
