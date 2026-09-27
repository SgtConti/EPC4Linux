// Path confinement for window.nodeApi and the file IPC channels (ARCHITECTURE rule 5, 02 §2.3, §L.2).
//
// The vendor preload exposed raw fs (arbitrary read/copy/delete from the page). The port routes the
// few calls the renderer makes (02 §2.1 "Renderer usage of nodeApi") through main and allows:
//   read:   files under the read roots (userData, EvniaServe data, bundled resources) and files the
//           user picked in a fileSelect/exportFile dialog during this session;
//   copy:   only to a new direct child of the scratch directory (userData), or over a file nodeApi
//           itself created there in this session;
//   unlink: only such nodeApi-created files, and the backend's `<name>.pcenter` / `<name>.macro`
//           export files in the scratch directory.
// These are exactly the renderer's temporary files: profile/macro import copies the picked file to
// pathJoin(userDataPath, basename(file, ".pcenter").slice(0, 30)) and unlinks it afterwards
// (ST:43085-43094, KeyBind:1163-1176); export has the backend write `<userData>/<name>.pcenter|.macro`
// and unlinks that (ST:43506-43517, KeyBind:1564-1575). The vendor bug where importing
// "config.json.pcenter" overwrote and then deleted config.json (or Chromium's Preferences, the
// MonitorInfo override, the first-run marker …) cannot happen: existing app state is never a target.
// Paths are resolved through realpath (of the file, or of its parent for a not-yet-existing target) so
// symlinks cannot escape a root.
//
// The same guard answers HostServices.pathAllowed for the backend (backendMayAccess): the hub's Theme_*/
// Macro_* functions take file paths from the renderer and would otherwise read or write any file the user
// owns (Theme_ExportProfile writes exactly the given path, creating directories; the imports parse any
// file and return parts of it). The backend may
//   read:   what nodeApi may read (read roots, dialog picks);
//   write:  the path the user just chose in the export (save) dialog, once (grantWrite, from the
//           exportFile channel), and `<name>.pcenter` / `<name>.macro` directly in the scratch directory
//           (the renderer's export temp files, see above).
// Everything else is refused, and the backend answers with the vendor's own error for that function.

import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Extensions of the backend's export files that the renderer deletes after uploading them. */
export const EXPORT_TEMP_EXTENSIONS: ReadonlySet<string> = new Set(['.pcenter', '.macro']);

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Real path of `p`, or of its parent joined with the last segment when `p` does not exist yet. */
export function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : resolve(canonicalPath(parent), basename(p));
  }
}

export function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function acceptable(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && isAbsolute(p) && !p.includes('\0');
}

/** 'file', 'missing', or 'other' (directory, socket, …) for a canonical path. */
function kind(p: string): 'file' | 'missing' | 'other' {
  try {
    return lstatSync(p).isFile() ? 'file' : 'other';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'other';
  }
}

export interface PathGuardOptions {
  readRoots: readonly string[];
  /** Directory whose direct children hold the renderer's temporary files (userData); none → no writes. */
  scratchDir?: string;
}

/** Export-dialog choices not yet written are kept, newest last, up to this many (each grant is used once). */
export const MAX_WRITE_GRANTS = 16;

export class PathGuard {
  readonly #readRoots: readonly string[];
  readonly #scratchDir: string | null;
  readonly #chosen = new Set<string>();
  readonly #created = new Set<string>();
  /** Canonical paths the user chose in the export dialog, not yet written by the backend. */
  readonly #writeGrants: string[] = [];

  constructor(opts: PathGuardOptions) {
    this.#readRoots = opts.readRoots.map((r) => resolve(r));
    this.#scratchDir = opts.scratchDir ? resolve(opts.scratchDir) : null;
  }

  /** Remember a file the user picked in a dialog; it becomes readable for the rest of the session. */
  allowChosen(p: string): void {
    if (acceptable(p)) this.#chosen.add(canonicalPath(resolve(p)));
  }

  /** Canonical path when `p` may be read, else null. */
  readable(p: unknown): string | null {
    if (!acceptable(p)) return null;
    const c = canonicalPath(resolve(p));
    if (this.#chosen.has(c)) return c;
    return this.#readRoots.some((r) => isInside(realOrResolved(r), c)) ? c : null;
  }

  /** Canonical path when nodeApi.copyFileSync may write `p`, else null. */
  copyTarget(p: unknown): string | null {
    const c = this.#inScratch(p);
    if (!c) return null;
    const k = kind(c);
    return k === 'missing' || (k === 'file' && this.#created.has(c)) ? c : null;
  }

  /** Canonical path when nodeApi.unlinkSync may delete `p`, else null. */
  removable(p: unknown): string | null {
    const c = this.#inScratch(p);
    if (!c || kind(c) !== 'file') return null;
    return this.#created.has(c) || EXPORT_TEMP_EXTENSIONS.has(extname(c).toLowerCase()) ? c : null;
  }

  /** A copy to `copyTarget(…)` succeeded. */
  noteCreated(canonical: string): void {
    this.#created.add(canonical);
  }

  /** An unlink of `removable(…)` succeeded. */
  noteRemoved(canonical: string): void {
    this.#created.delete(canonical);
  }

  /**
   * The user chose `p` in the export (save) dialog (ipc.ts exportFile, after the extension rule): the
   * backend may write it once (Theme_ExportProfile, Macro_Export). Only the newest MAX_WRITE_GRANTS stay.
   */
  grantWrite(p: string): void {
    if (!acceptable(p)) return;
    const c = canonicalPath(resolve(p));
    const i = this.#writeGrants.indexOf(c);
    if (i >= 0) this.#writeGrants.splice(i, 1);
    this.#writeGrants.push(c);
    if (this.#writeGrants.length > MAX_WRITE_GRANTS) this.#writeGrants.splice(0, this.#writeGrants.length - MAX_WRITE_GRANTS);
  }

  /**
   * HostServices.pathAllowed: may the backend read or write `p`, a path the renderer passed to a Theme_*
   * or Macro_* function? Reads: as `readable`. Writes: a pending export-dialog grant (used up by this
   * call), or a new or existing regular `<name>.pcenter` / `<name>.macro` file directly in the scratch
   * directory (never a symlink, never a file whose real path lies elsewhere).
   */
  backendMayAccess(p: unknown, access: 'read' | 'write'): boolean {
    if (access === 'read') return this.readable(p) !== null;
    if (!acceptable(p)) return false;
    const i = this.#writeGrants.indexOf(canonicalPath(resolve(p)));
    if (i >= 0) {
      this.#writeGrants.splice(i, 1);
      return true;
    }
    const c = this.#inScratch(p);
    return c !== null && EXPORT_TEMP_EXTENSIONS.has(extname(c).toLowerCase()) && kind(c) !== 'other';
  }

  #inScratch(p: unknown): string | null {
    if (!this.#scratchDir || !acceptable(p)) return null;
    const c = canonicalPath(resolve(p));
    return dirname(c) === realOrResolved(this.#scratchDir) ? c : null;
  }
}
