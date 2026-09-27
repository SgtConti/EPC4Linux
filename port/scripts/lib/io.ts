// File-system failures of the import, reported under the CLI contract (import-vendor-ui.mjs: exit 1
// with one coded line) instead of escaping as a raw Node stack trace.

import { ImportError } from './patch-engine.ts';

/** The errno code of a Node file-system error (`EACCES`, `ENOENT`, …), if any. */
export function errnoOf(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Hint for a write failure in the output directory `dir`. */
export function outputHint(dir: string): (errno: string | undefined) => string {
  return (errno) => {
    if (errno === 'EACCES' || errno === 'EPERM') {
      return `Check that you own ${dir} and everything below it; an import run as root (e.g. in the Docker dev image) ` +
        `leaves root-owned files behind: sudo chown -R "$USER" "${dir}"`;
    }
    if (errno === 'ENOSPC' || errno === 'EDQUOT') return 'The file system is full.';
    return '';
  };
}

/**
 * Runs `fn`. An ImportError passes through; any other error becomes `ImportError(code)` whose message
 * names `what` and the cause, plus `hint(errno)` when that is not empty.
 */
export function withIo<T>(code: string, what: string, fn: () => T, hint: (errno: string | undefined) => string = () => ''): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ImportError) throw err;
    const h = hint(errnoOf(err));
    throw new ImportError(code, `${what}: ${messageOf(err)}${h ? `. ${h}` : ''}`);
  }
}
