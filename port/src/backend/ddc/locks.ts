// Serialisation of DDC/CI traffic (20 §2.4, decision D2; ARCHITECTURE rule 3).
//
// In-process: one FIFO per lock key, shared by every channel, discovery run and EDID probe in this
// process. The keys are physical paths (transport ids such as "via:usb:3-2.4" or "i2c:/dev/i2c-5")
// plus the monitor key (EDID serial) when it is known. Transport objects are short-lived: each
// discovery run opens a new USB handle and new i2c transports for the same bridge and bus. The path
// stays the same, so two objects on one bridge share one queue. An operation joins the queues of all
// its keys in one synchronous step, so every queue orders operations the same way (by request time):
// operations run first-come first-served and can never deadlock.
//
// Cross-process: an advisory flock(2) on $XDG_RUNTIME_DIR/evnia/ddc-<key>.lock for the same keys,
// around each transaction (write, delays, read). A second instance or the bring-up CLI therefore never
// lands between this process's request and its read. flock is always called with LOCK_NB and polled,
// so the event loop is never blocked, and a stuck peer (for example a CLI suspended with Ctrl-Z) costs
// a bounded wait, not a hang.

import { close, constants as fsConstants, open } from 'node:fs';
import { chown, mkdir } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../types.ts';
import { DdcError, errorText } from './errors.ts';
import { LOCK_EX, LOCK_NB, LOCK_UN, errnoName, loadLibc } from './libc.ts';

// ───────────────────────────── in-process ─────────────────────────────

interface Entry {
  /** Settles when the last operation queued on this key has finished. */
  tail: Promise<void>;
  /** Operations holding or waiting for this key; the entry is dropped when it returns to 0. */
  users: number;
}

const entries = new Map<string, Entry>();

/** Join the queue of `key`: `turn` settles when every earlier operation on it has released. */
function enqueue(key: string): { turn: Promise<void>; release: () => void } {
  let entry = entries.get(key);
  if (!entry) entries.set(key, (entry = { tail: Promise.resolve(), users: 0 }));
  const joined = entry;
  joined.users++;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => (done = resolve));
  const turn = joined.tail;
  joined.tail = turn.then(() => finished);
  return {
    turn,
    release: () => {
      done();
      if (--joined.users === 0 && entries.get(key) === joined) entries.delete(key);
    },
  };
}

/** Run `fn` holding this process's queue of every key (first come, first served across all keys). */
export async function withPathLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const slots = [...new Set(keys)].map(enqueue); // synchronous: one consistent order in every queue
  try {
    await Promise.all(slots.map((s) => s.turn));
    return await fn();
  } finally {
    for (const s of slots) s.release();
  }
}

// ───────────────────────────── cross-process ─────────────────────────────

/** Advisory lock shared with other processes, held around one DDC/CI transaction. */
export interface ProcessLock {
  /** Run `fn` holding the lock of every key. Rejects with DdcError('busy') when a peer holds one too long. */
  run<T>(keys: readonly string[], fn: () => Promise<T>, log?: Logger): Promise<T>;
}

export interface LockPlace {
  /** Directory of the lock files, `$XDG_RUNTIME_DIR/evnia`. */
  dir: string;
  /** Under sudo: the invoking user, who must be able to open the files root creates. */
  owner?: { uid: number; gid: number };
}

/**
 * Where the lock files live (20 §2.4): `$XDG_RUNTIME_DIR/evnia`. sudo drops XDG_RUNTIME_DIR, so as
 * root with SUDO_UID set the invoking user's runtime directory `/run/user/<SUDO_UID>` is used, and the
 * files root creates are given to that user. Returns null when there is no runtime directory.
 */
export function lockPlace(env: NodeJS.ProcessEnv = process.env, uid: number = process.getuid?.() ?? -1): LockPlace | null {
  const numeric = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);
  const sudoUid = uid === 0 ? numeric(env.SUDO_UID) : null;
  const runtime = env.XDG_RUNTIME_DIR || (sudoUid !== null ? `/run/user/${sudoUid}` : '');
  if (!runtime) return null;
  const place: LockPlace = { dir: join(runtime, 'evnia') };
  if (sudoUid !== null) place.owner = { uid: sudoUid, gid: numeric(env.SUDO_GID) ?? sudoUid };
  return place;
}

/** `ddc-<key>.lock`, with every character outside [A-Za-z0-9._-] replaced ("ddc-MOCK000000001.lock" for the simulated monitor). */
export function lockFileName(key: string): string {
  return `ddc-${key.replace(/[^A-Za-z0-9._-]+/g, '-')}.lock`;
}

export interface FlockLockOptions extends LockPlace {
  /**
   * Longest wait for a peer's transaction (default 15 s). The longest VIA exchange, with every
   * control transfer timing out (1 s) and backing off 177/354/531 ms, takes about 8.5 s.
   */
  timeoutMs?: number;
  /** Poll interval while a peer holds the lock (default 10 ms). */
  pollMs?: number;
}

const openFd = (path: string) =>
  new Promise<number>((resolve, reject) =>
    open(path, fsConstants.O_RDONLY | fsConstants.O_CREAT, 0o600, (err, fd) => (err ? reject(err) : resolve(fd))),
  );

/** flock(2) on one file per key under `dir`. The files stay open for the life of the process. */
export class FlockProcessLock implements ProcessLock {
  readonly dir: string;
  readonly #owner: LockPlace['owner'];
  readonly #timeoutMs: number;
  readonly #pollMs: number;
  /** File name → fd, or null when the file cannot be opened (the lock is then skipped for it). */
  readonly #fds = new Map<string, Promise<number | null>>();

  constructor(options: FlockLockOptions) {
    this.dir = options.dir;
    this.#owner = options.owner;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#pollMs = options.pollMs ?? 10;
  }

  async run<T>(keys: readonly string[], fn: () => Promise<T>, log?: Logger): Promise<T> {
    // Distinct keys may share a file name after sanitising: lock each file once, in sorted order.
    const files = [...new Set(keys.map(lockFileName))].sort();
    const held: number[] = [];
    try {
      for (const file of files) {
        const fd = await this.#fd(file, log);
        if (fd !== null && (await this.#lock(fd, file, log))) held.push(fd);
      }
      return await fn();
    } finally {
      if (held.length > 0) {
        const libc = await loadLibc();
        for (const fd of held.reverse()) libc.flock(fd, LOCK_UN);
      }
    }
  }

  /** Close the lock files (releasing any lock); later calls reopen them. */
  async close(): Promise<void> {
    const pending = [...this.#fds.values()];
    this.#fds.clear();
    for (const fd of await Promise.all(pending)) {
      if (fd !== null) await new Promise<void>((resolve) => close(fd, () => resolve()));
    }
  }

  #fd(file: string, log: Logger | undefined): Promise<number | null> {
    let fd = this.#fds.get(file);
    if (!fd) {
      fd = this.#open(join(this.dir, file)).catch((e: unknown) => {
        // Advisory only: without the file, DDC keeps working, just without cross-process exclusion.
        log?.warn(`cross-process DDC lock ${join(this.dir, file)} unavailable (${errorText(e)}); continuing without it`);
        return null;
      });
      this.#fds.set(file, fd);
    }
    return fd;
  }

  async #open(path: string): Promise<number> {
    // Never create the runtime directory itself (logind owns it); only our subdirectory.
    const created = await mkdir(this.dir, { mode: 0o700 }).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e;
        return false;
      },
    );
    if (created && this.#owner) await chown(this.dir, this.#owner.uid, this.#owner.gid);
    const fd = await openFd(path);
    if (this.#owner) await chown(path, this.#owner.uid, this.#owner.gid).catch(() => undefined);
    return fd;
  }

  /** LOCK_EX|LOCK_NB, polled until `timeoutMs`. False when flock itself is unusable (lock skipped). */
  async #lock(fd: number, file: string, log: Logger | undefined): Promise<boolean> {
    const libc = await loadLibc();
    const started = performance.now();
    let waiting = false;
    for (;;) {
      const { result, errno } = libc.flock(fd, LOCK_EX | LOCK_NB);
      if (result === 0) return true;
      if (errno !== osConstants.errno.EWOULDBLOCK) {
        log?.warn(`flock(${file}) failed (${errnoName(errno)}); continuing without the cross-process lock`);
        return false;
      }
      const waited = performance.now() - started;
      if (waited >= this.#timeoutMs) {
        throw new DdcError('busy', `another process has held the DDC lock ${file} for more than ${this.#timeoutMs} ms`);
      }
      if (!waiting) {
        waiting = true;
        log?.debug(`waiting for ${file}: another process is talking to this monitor`);
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.#pollMs, this.#timeoutMs - waited)));
    }
  }
}

let defaultLock: FlockProcessLock | null | undefined;

/** The process-wide lock at {@link lockPlace}, created on first use; null without a runtime directory. */
export function defaultProcessLock(): ProcessLock | null {
  if (defaultLock === undefined) {
    const place = lockPlace();
    defaultLock = place ? new FlockProcessLock(place) : null;
  }
  return defaultLock;
}

/** Channel/discovery option: undefined → the default lock, null → none, otherwise the given lock. */
export function resolveProcessLock(option: ProcessLock | null | undefined): ProcessLock | null {
  return option === undefined ? defaultProcessLock() : option;
}

/** Both levels around one bus access made outside a channel (discovery's EDID read at 0x50). */
export function withExclusiveAccess<T>(keys: readonly string[], processLock: ProcessLock | null, fn: () => Promise<T>, log?: Logger): Promise<T> {
  return withPathLocks(keys, () => (processLock ? processLock.run(keys, fn, log) : fn()));
}
