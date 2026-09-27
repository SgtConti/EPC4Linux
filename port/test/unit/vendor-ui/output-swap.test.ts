import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { acquireOutputLock, LOCK_NAME, STAGING_PREFIX, STALE_LOCK_MS, swapOutputs } from '../../../scripts/lib/output-swap.ts';
import { ImportError } from '../../../scripts/lib/patch-engine.ts';

const NAMES = ['vendor-ui', 'vendor-data', 'vendor-assets'];
let out: string;

beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), 'evnia-swap-'));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

function put(dir: string, file: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
}
const read = (name: string) => readFileSync(join(out, name, 'marker.txt'), 'utf8');
const lockPath = () => join(out, LOCK_NAME);

/** Writes a lock as another importer would have left it, `ageMs` old. */
function foreignLock(host: string, pid: number, ageMs = 0): void {
  writeFileSync(lockPath(), `${JSON.stringify({ host, pid, started: new Date(Date.now() - ageMs).toISOString(), token: 'f'.repeat(32) })}\n`);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(lockPath(), t, t);
}

const isLocked = (e: unknown) => e instanceof ImportError && e.code === 'OUTPUT_LOCKED';

describe('swapOutputs', () => {
  /** Previous outputs in `out`, new ones staged for all names. */
  function seed(): string {
    const staging = mkdtempSync(join(out, STAGING_PREFIX));
    for (const n of NAMES) {
      put(join(out, n), 'marker.txt', `old ${n}`);
      put(join(staging, 'new', n), 'marker.txt', `new ${n}`);
    }
    return staging;
  }

  test('all three directories are replaced; the previous ones end up in the staging directory', () => {
    const staging = seed();
    swapOutputs(out, staging, NAMES);
    for (const n of NAMES) {
      assert.equal(read(n), `new ${n}`);
      assert.equal(readFileSync(join(staging, 'previous', n, 'marker.txt'), 'utf8'), `old ${n}`);
    }
  });

  test('a first import (no previous outputs) installs everything', () => {
    const staging = mkdtempSync(join(out, STAGING_PREFIX));
    for (const n of NAMES) put(join(staging, 'new', n), 'marker.txt', `new ${n}`);
    swapOutputs(out, staging, NAMES);
    for (const n of NAMES) assert.equal(read(n), `new ${n}`);
  });

  test('a failing install rolls back: the previous outputs are restored exactly', () => {
    const staging = seed();
    rmSync(join(staging, 'new', 'vendor-assets'), { recursive: true });
    assert.throws(
      () => swapOutputs(out, staging, NAMES),
      (e: unknown) => e instanceof ImportError && e.code === 'OUTPUT_SWAP' && /previous outputs were restored/.test(e.message),
    );
    for (const n of NAMES) assert.equal(read(n), `old ${n}`);
    assert.deepEqual(readdirSync(join(staging, 'previous')), []);
  });

  test('root-owned previous outputs (EACCES) are restored and the error says how to fix the ownership', () => {
    const staging = seed();
    const rename = (from: string, to: string): void => {
      if (from === join(out, 'vendor-ui')) throw Object.assign(new Error(`EACCES: permission denied, rename '${from}'`), { code: 'EACCES' });
      renameSync(from, to);
    };
    assert.throws(
      () => swapOutputs(out, staging, NAMES, rename),
      (e: unknown) => e instanceof ImportError && e.code === 'OUTPUT_SWAP' && e.message.includes(`sudo chown -R "$USER" "${out}"`),
    );
    for (const n of NAMES) assert.equal(read(n), `old ${n}`);
  });

  test('if the rollback fails too, the error says where the previous outputs are', () => {
    const staging = seed();
    let calls = 0;
    // Fail the third install (after two previous directories were moved away and two new ones installed),
    // then fail every rollback rename.
    const rename = (from: string, to: string): void => {
      calls++;
      if (calls >= 6) throw new Error(`EBUSY: ${from}`);
      renameSync(from, to);
    };
    assert.throws(
      () => swapOutputs(out, staging, NAMES, rename),
      (e: unknown) => e instanceof ImportError && e.code === 'OUTPUT_ROLLBACK' && e.message.includes(join(staging, 'previous')),
    );
    assert.equal(readFileSync(join(staging, 'previous', 'vendor-assets', 'marker.txt'), 'utf8'), 'old vendor-assets');
  });
});

describe('acquireOutputLock', () => {
  test('creates the lock and a fresh staging directory; release removes both', () => {
    const lock = acquireOutputLock(out);
    assert.equal(lock.lockPath, lockPath());
    const record = JSON.parse(readFileSync(lockPath(), 'utf8')) as { host: string; pid: number; token: string };
    assert.equal(record.host, hostname());
    assert.equal(record.pid, process.pid);
    assert.match(record.token, /^[0-9a-f]{32}$/);
    assert.ok(basename(lock.staging).startsWith(STAGING_PREFIX));
    assert.deepEqual(readdirSync(lock.staging), []);
    assert.deepEqual(lock.warnings, []);
    lock.assertHeld();
    assert.deepEqual(lock.release(false), []);
    assert.deepEqual(readdirSync(out), []);
  });

  test('release(true) keeps the staging directory (the only copy of the previous outputs after OUTPUT_ROLLBACK)', () => {
    const lock = acquireOutputLock(out);
    assert.deepEqual(lock.release(true), []);
    assert.deepEqual(readdirSync(out), [basename(lock.staging)]);
  });

  test('staging directories left by interrupted runs are removed, whatever their pid namespace', () => {
    // `.vendor-import-1`: a killed run in the Docker image (pid 1); the other a killed mkdtemp-style run.
    for (const d of ['.vendor-import-1', '.vendor-import-a1B2c3']) put(join(out, d, 'previous', 'vendor-ui'), 'marker.txt', 'x');
    put(join(out, 'vendor-ui'), 'marker.txt', 'keep');
    // pid 1 is alive on every host; it does not matter, because no lock is held.
    const lock = acquireOutputLock(out, { isRunning: () => true });
    assert.deepEqual(lock.removed, ['.vendor-import-1', '.vendor-import-a1B2c3']);
    assert.deepEqual(readdirSync(out).sort(), [LOCK_NAME, basename(lock.staging), 'vendor-ui'].sort());
    assert.equal(read('vendor-ui'), 'keep');
    lock.release(false);
  });

  test('two concurrent runs that are both pid 1 in their containers: the second is refused and touches nothing', () => {
    const first = acquireOutputLock(out, { host: 'container-a', pid: 1, isRunning: () => true });
    put(join(first.staging, 'new', 'vendor-ui'), 'marker.txt', 'first');
    assert.throws(() => acquireOutputLock(out, { host: 'container-b', pid: 1, isRunning: () => true }), (e: unknown) =>
      isLocked(e) && /pid 1 on host container-a/.test((e as Error).message) && (e as Error).message.includes(`delete ${lockPath()}`),
    );
    assert.equal(readFileSync(join(first.staging, 'new', 'vendor-ui', 'marker.txt'), 'utf8'), 'first');
    first.assertHeld();
    assert.deepEqual(first.release(false), []);
    assert.deepEqual(readdirSync(out), []);
  });

  test('a lock of a live process on this host is respected', () => {
    foreignLock(hostname(), process.ppid);
    assert.throws(() => acquireOutputLock(out), isLocked);
    assert.ok(existsSync(lockPath()));
  });

  test('a lock whose process is gone on this host is taken over, and its staging directory removed', () => {
    foreignLock(hostname(), 2147483646);
    put(join(out, '.vendor-import-Zz9Zz9'), 'x', 'x');
    const lock = acquireOutputLock(out);
    assert.deepEqual(lock.removed, ['.vendor-import-Zz9Zz9']);
    assert.equal(lock.warnings.length, 1);
    assert.match(lock.warnings[0] ?? '', /took over the lock of an interrupted import \(pid 2147483646 on host .*\): its process is gone/);
    lock.assertHeld();
    lock.release(false);
    assert.deepEqual(readdirSync(out), []);
  });

  test('a lock of this very pid is a leftover (pid reuse, e.g. pid 1 in a container with the same host name)', () => {
    foreignLock('container-a', 1);
    const lock = acquireOutputLock(out, { host: 'container-a', pid: 1, isRunning: () => true });
    assert.match(lock.warnings[0] ?? '', /its process is gone/);
    lock.release(false);
  });

  test('a lock from another host (container) is respected until it is older than STALE_LOCK_MS', () => {
    put(join(out, '.vendor-import-1', 'new', 'vendor-ui'), 'marker.txt', 'other');
    foreignLock('container-a', 1, STALE_LOCK_MS - 60_000);
    assert.throws(() => acquireOutputLock(out, { isRunning: () => true }), isLocked);
    assert.ok(existsSync(join(out, '.vendor-import-1', 'new', 'vendor-ui', 'marker.txt')), 'the holder\'s staging directory is left alone');

    foreignLock('container-a', 1, STALE_LOCK_MS + 60_000);
    const lock = acquireOutputLock(out, { isRunning: () => true });
    assert.match(lock.warnings[0] ?? '', /pid 1 on host container-a.*: it is 11 minutes old/);
    assert.deepEqual(lock.removed, ['.vendor-import-1']);
    lock.release(false);
  });

  test('an unreadable lock is respected while fresh and taken over when old', () => {
    writeFileSync(lockPath(), '');
    assert.throws(() => acquireOutputLock(out), (e: unknown) => isLocked(e) && /unreadable lock/.test((e as Error).message));
    const t = (Date.now() - STALE_LOCK_MS - 60_000) / 1000;
    utimesSync(lockPath(), t, t);
    acquireOutputLock(out).release(false);
    assert.deepEqual(readdirSync(out), []);
  });

  test('a run whose lock was taken over cannot install, and does not remove its successor\'s lock', () => {
    const suspended = acquireOutputLock(out, { host: 'container-a', pid: 1 });
    // Its successor finds the lock older than the bound and takes it over.
    const successor = acquireOutputLock(out, { host: 'container-b', pid: 1, now: () => Date.now() + STALE_LOCK_MS + 60_000 });
    assert.throws(() => suspended.assertHeld(), (e: unknown) => isLocked(e) && /was taken over/.test((e as Error).message));
    suspended.release(false);
    assert.ok(existsSync(lockPath()), 'the successor still holds the lock');
    successor.assertHeld();
    successor.release(false);
    assert.deepEqual(readdirSync(out), []);
  });

  test('a clean-up failure is returned as a warning, not thrown, and the lock is still released', () => {
    const lock = acquireOutputLock(out, {
      remove: (p) => {
        throw Object.assign(new Error(`EACCES: permission denied, rmdir '${p}'`), { code: 'EACCES' });
      },
    });
    const warnings = lock.release(false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /could not remove the staging directory .*EACCES.*remove it by hand/);
    assert.ok(!existsSync(lockPath()));
  });

  test('a leftover that cannot be removed is a warning; the run gets its own staging directory', () => {
    put(join(out, '.vendor-import-1'), 'x', 'x');
    const lock = acquireOutputLock(out, {
      remove: (p) => {
        if (p.endsWith('.vendor-import-1')) throw new Error('EACCES: permission denied');
        rmSync(p, { recursive: true, force: true });
      },
    });
    assert.deepEqual(lock.removed, []);
    assert.match(lock.warnings[0] ?? '', /could not remove .*\.vendor-import-1, left by an interrupted import: EACCES/);
    assert.notEqual(basename(lock.staging), '.vendor-import-1');
    assert.deepEqual(lock.release(false), []);
  });
});
