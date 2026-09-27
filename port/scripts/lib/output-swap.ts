// Replacing the importer's output directories (build/vendor-ui, vendor-data, vendor-assets) as a unit.
//
// Ownership. An import that writes into <out> first takes the lock file <out>/.vendor-import.lock
// (created exclusively, recording host, pid, start time and a random token) and holds it until it
// has finished. Its staging directory is a fresh `mkdtemp` directory <out>/.vendor-import-XXXXXX.
// Neither depends on the pid, which is not unique across PID namespaces: every run in the Docker dev
// image is pid 1, and the host sees a different pid 1. Because a staging directory is only ever
// created by the lock holder, every other .vendor-import-* directory found while holding the lock is
// a leftover of an interrupted run and is removed.
//
// A lock left behind by a crashed run is taken over when its owner is provably gone (same host name,
// process no longer running) or when it is older than STALE_LOCK_MS. An import takes seconds; the
// age bound is what frees a lock left by a run in another container, whose process cannot be
// checked (each `docker run` has its own host name). The holder re-checks the lock right before the
// swap, so even an importer suspended past the bound cannot install over its successor.
//
// Swap. A run writes the new outputs to <staging>/new/<dir>. `swapOutputs` then
//   1. moves every existing output directory to <staging>/previous/<dir>,
//   2. moves every new directory into place,
// each step a rename inside <out> (atomic, same file system). If any rename fails, the directories
// already installed are taken out again and the previous ones are moved back, so a failed swap leaves
// the previous outputs exactly as they were. Only a process killed in the middle of the few renames can
// leave a mix; the next run removes its staging directory and installs a complete new set.

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { errnoOf, messageOf, outputHint } from './io.ts';
import { ImportError } from './patch-engine.ts';

export const STAGING_PREFIX = '.vendor-import-';
export const LOCK_NAME = '.vendor-import.lock';
/** Age after which a lock whose owner cannot be checked counts as abandoned. */
export const STALE_LOCK_MS = 10 * 60 * 1000;

interface LockRecord {
  host: string;
  pid: number;
  started: string;
  token: string;
}

/** Test seams; production uses the real host, pid, clock and file system. */
export interface LockOptions {
  host?: string;
  pid?: number;
  now?: () => number;
  isRunning?: (pid: number) => boolean;
  remove?: (path: string) => void;
}

export interface OutputLock {
  readonly lockPath: string;
  /** This run's staging directory (empty when acquired). */
  readonly staging: string;
  /** Names of staging directories of interrupted runs removed while acquiring the lock. */
  readonly removed: readonly string[];
  /** Problems that did not stop the import (a leftover that could not be removed, a lock taken over). */
  readonly warnings: readonly string[];
  /** Throws OUTPUT_LOCKED if another import has taken the lock over. */
  assertHeld(): void;
  /**
   * Removes the staging directory (unless `keepStaging`) and the lock file if it is still this run's.
   * Never throws: a failure is returned as a warning line, so a completed import is not reported as
   * failed because its clean-up failed.
   */
  release(keepStaging: boolean): string[];
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return errnoOf(err) === 'EPERM';
  }
}

/** The lock file's content and modification time, or null if there is no lock. */
function readLock(path: string): { raw: string; mtimeMs: number; record: LockRecord | null } | null {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return null;
    throw err;
  }
  try {
    const r = JSON.parse(raw) as Partial<LockRecord>;
    const ok = typeof r.host === 'string' && Number.isInteger(r.pid) && typeof r.started === 'string' && typeof r.token === 'string';
    return { raw, mtimeMs, record: ok ? (r as LockRecord) : null };
  } catch {
    // A lock is written right after its exclusive creation; an empty or partial one may be in progress.
    return { raw, mtimeMs, record: null };
  }
}

/**
 * Takes the output lock of `outDir` (which must exist), removes the staging directories of
 * interrupted runs and creates this run's staging directory. Throws OUTPUT_LOCKED while another
 * import holds the lock; other file-system errors are thrown as they are (the caller reports them).
 */
export function acquireOutputLock(outDir: string, opts: LockOptions = {}): OutputLock {
  const host = opts.host ?? hostname();
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now;
  const alive = opts.isRunning ?? isRunning;
  const remove = opts.remove ?? ((p: string) => rmSync(p, { recursive: true, force: true }));
  const lockPath = join(outDir, LOCK_NAME);
  const token = randomBytes(16).toString('hex');
  const warnings: string[] = [];

  const locked = (owner: string): ImportError =>
    new ImportError(
      'OUTPUT_LOCKED',
      `Another import into ${outDir} is running (${owner}). If none is (e.g. a run in another container was ` +
        `interrupted), delete ${lockPath} and run the import again; a lock whose owner cannot be checked expires ` +
        `after ${STALE_LOCK_MS / 60000} minutes.`,
    );
  let tookOver = false;
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lockPath, `${JSON.stringify({ host, pid, started: new Date(now()).toISOString(), token })}\n`, { flag: 'wx' });
      break;
    } catch (err) {
      if (errnoOf(err) !== 'EEXIST') throw err;
    }
    if (attempt === 2) throw locked('the lock is contended');
    const held = readLock(lockPath);
    if (held === null) continue; // released in the meantime
    const { record } = held;
    const ageMs = now() - held.mtimeMs;
    const owner = record ? `pid ${record.pid} on host ${record.host}, started ${record.started}` : 'unreadable lock';
    let stale: string | null = null;
    if (record && record.host === host && (record.pid === pid || !alive(record.pid))) stale = 'its process is gone';
    else if (ageMs > STALE_LOCK_MS) stale = `it is ${Math.round(ageMs / 60000)} minutes old`;
    if (stale === null || tookOver) throw locked(owner);
    // Remove exactly the lock judged stale, not one another run created meanwhile.
    if (readLock(lockPath)?.raw === held.raw) rmSync(lockPath, { force: true });
    tookOver = true;
    warnings.push(`took over the lock of an interrupted import (${owner}): ${stale}`);
  }

  const ours = (): boolean => readLock(lockPath)?.record?.token === token;
  const removed: string[] = [];
  let staging: string;
  try {
    for (const name of readdirSync(outDir)) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      try {
        remove(join(outDir, name));
        removed.push(name);
      } catch (err) {
        warnings.push(`could not remove ${join(outDir, name)}, left by an interrupted import: ${messageOf(err)}; remove it by hand`);
      }
    }
    staging = mkdtempSync(join(outDir, STAGING_PREFIX));
  } catch (err) {
    if (ours()) rmSync(lockPath, { force: true });
    throw err;
  }

  return {
    lockPath,
    staging,
    removed: removed.sort(),
    warnings,
    assertHeld(): void {
      if (!ours()) {
        throw new ImportError(
          'OUTPUT_LOCKED',
          `The lock ${lockPath} was taken over by another import while this one ran (it had been held longer than ` +
            `${STALE_LOCK_MS / 60000} minutes); nothing was installed.`,
        );
      }
    },
    release(keepStaging: boolean): string[] {
      const problems: string[] = [];
      if (!keepStaging) {
        try {
          remove(staging);
        } catch (err) {
          problems.push(`could not remove the staging directory ${staging}: ${messageOf(err)}; remove it by hand`);
        }
      }
      try {
        if (ours()) rmSync(lockPath, { force: true });
      } catch (err) {
        problems.push(`could not remove the lock ${lockPath}: ${messageOf(err)}; delete it before the next import`);
      }
      return problems;
    },
  };
}

/**
 * Installs `<staging>/new/<name>` as `<outDir>/<name>` for every name, replacing the previous
 * directories as a unit (see the file comment). `<staging>/new/<name>` must exist for every name.
 * The caller deletes `staging` afterwards, which also drops the previous outputs, except after an
 * `OUTPUT_ROLLBACK` error: then `<staging>/previous` holds what could not be restored.
 * `rename` is the file-system primitive (a parameter so tests can inject failures).
 */
export function swapOutputs(
  outDir: string,
  staging: string,
  names: readonly string[],
  rename: (from: string, to: string) => void = renameSync,
): void {
  const previous = join(staging, 'previous');
  mkdirSync(previous, { recursive: true });
  const moved: string[] = [];
  const installed: string[] = [];
  try {
    for (const name of names) {
      if (!existsSync(join(outDir, name))) continue;
      rename(join(outDir, name), join(previous, name));
      moved.push(name);
    }
    for (const name of names) {
      rename(join(staging, 'new', name), join(outDir, name));
      installed.push(name);
    }
  } catch (err) {
    const rollbackErrors: string[] = [];
    for (const name of installed.reverse()) {
      try {
        rename(join(outDir, name), join(staging, 'new', name));
      } catch (e) {
        rollbackErrors.push(`${name}: ${messageOf(e)}`);
      }
    }
    for (const name of moved.reverse()) {
      try {
        rename(join(previous, name), join(outDir, name));
      } catch (e) {
        rollbackErrors.push(`${name}: ${messageOf(e)}`);
      }
    }
    if (rollbackErrors.length) {
      throw new ImportError(
        'OUTPUT_ROLLBACK',
        `Installing the new outputs in ${outDir} failed (${messageOf(err)}) and restoring the previous ones failed too ` +
          `(${rollbackErrors.join('; ')}). Remaining previous outputs are in ${previous}; running the import again rebuilds all of them.`,
      );
    }
    // Moving a directory needs write access to it (its ".." entry), so root-owned outputs of an import
    // run as root cannot be replaced by a user's run: the hint says so.
    const hint = outputHint(outDir)(errnoOf(err));
    throw new ImportError(
      'OUTPUT_SWAP',
      `Installing the new outputs in ${outDir} failed: ${messageOf(err)}. The previous outputs were restored.${hint ? ` ${hint}` : ''}`,
    );
  }
}
