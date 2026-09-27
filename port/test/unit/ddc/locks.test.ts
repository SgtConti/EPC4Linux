import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcChannelImpl, NO_DELAY_TIMINGS } from '../../../src/backend/ddc/channel.ts';
import { DdcError } from '../../../src/backend/ddc/errors.ts';
import { FlockProcessLock, type ProcessLock, lockFileName, lockPlace, withPathLocks } from '../../../src/backend/ddc/locks.ts';
import { SimulatedMonitor } from '../../../src/backend/ddc/transports/mock.ts';
import { ScriptedTransport } from './helpers.ts';

const tick = () => new Promise((r) => setTimeout(r, 5));

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'ddc-locks-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A promise with its resolver, for holding a lock until the test lets go. */
function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

test('path locks: FIFO per key, overlapping key sets serialize, disjoint ones do not, any key order', async () => {
  const log: string[] = [];
  const op = (name: string, keys: string[], hold = gate()) => {
    const done = withPathLocks(keys, async () => {
      log.push(`${name}+`);
      await hold.promise;
      log.push(`${name}-`);
    });
    return { done, hold };
  };
  const a = op('a', ['via:usb:3-2.4', 'i2c:/dev/i2c-5', 'AU00000000001']); // the driver's channel
  const b = op('b', ['via:usb:3-2.4']); // a rescan's identification channel on a new handle
  const c = op('c', ['i2c:/dev/i2c-7']); // another monitor
  const d = op('d', ['AU00000000001', 'i2c:/dev/i2c-5']); // same monitor, keys in another order
  const e = op('e', ['i2c:/dev/i2c-5', 'via:usb:3-2.4']); // after b and d: waits for both
  try {
    await tick();
    assert.deepEqual(log, ['a+', 'c+']); // first come, first served: b never overtakes a
    c.hold.open();
    a.hold.open();
    await tick();
    assert.deepEqual(log.slice(0, 4), ['a+', 'c+', 'c-', 'a-']);
    assert.deepEqual(log.slice(4).sort(), ['b+', 'd+']);
    b.hold.open();
    await tick();
    assert.equal(log.includes('e+'), false);
    d.hold.open();
    await tick();
    assert.equal(log.at(-1), 'e+');
  } finally {
    for (const x of [a, b, c, d, e]) x.hold.open();
  }
  await Promise.all([a.done, b.done, c.done, d.done, e.done]);
  // A rejected operation releases its keys.
  await assert.rejects(withPathLocks(['k'], async () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(await withPathLocks(['k'], async () => 42), 42);
});

test('flock: two lock holders exclude each other per file; a peer that holds too long gives DdcError busy', () =>
  withDir(async (dir) => {
    const app = new FlockProcessLock({ dir, timeoutMs: 2000, pollMs: 2 });
    const cli = new FlockProcessLock({ dir, timeoutMs: 60, pollMs: 2 }); // own fds: contends like another process
    try {
      const order: string[] = [];
      const hold = gate();
      const held = app.run(['via:usb:3-2.4', 'AU00000000001'], async () => {
        order.push('app');
        await hold.promise;
      });
      await tick();
      // The CLI's transaction on the same monitor times out while the app holds it...
      await assert.rejects(cli.run(['i2c:/dev/i2c-5', 'AU00000000001'], async () => order.push('cli')), (e: unknown) =>
        e instanceof DdcError && e.code === 'busy' && /ddc-AU00000000001\.lock/.test(e.message));
      // ...but a different path of another monitor is free, and the first lock is released on the timeout.
      await cli.run(['i2c:/dev/i2c-7'], async () => order.push('other'));
      const waiting = app.run(['i2c:/dev/i2c-5'], async () => order.push('i2c free'));
      await waiting;
      hold.open();
      await held;
      await cli.run(['AU00000000001'], async () => order.push('cli after'));
      assert.deepEqual(order, ['app', 'other', 'i2c free', 'cli after']);
      assert.deepEqual((await readdir(dir)).sort(), ['ddc-AU00000000001.lock', 'ddc-i2c-dev-i2c-5.lock', 'ddc-i2c-dev-i2c-7.lock', 'ddc-via-usb-3-2.4.lock']);
      // Keys that map to one file are locked once (no self-deadlock).
      assert.equal(lockFileName('a:b'), lockFileName('a-b'));
      assert.equal(await cli.run(['a:b', 'a-b'], async () => 'ok'), 'ok');
    } finally {
      await app.close();
      await cli.close();
    }
  }));

test('flock: a waiting peer proceeds as soon as the holder releases', () =>
  withDir(async (dir) => {
    const app = new FlockProcessLock({ dir, pollMs: 1 });
    const cli = new FlockProcessLock({ dir, pollMs: 1 });
    try {
      const order: string[] = [];
      const hold = gate();
      const held = app.run(['via:usb:3-2.4'], async () => {
        order.push('app write+read');
        await hold.promise;
      });
      await tick();
      const waiting = cli.run(['via:usb:3-2.4'], async () => order.push('cli write+read'));
      await tick();
      assert.deepEqual(order, ['app write+read']);
      hold.open();
      await Promise.all([held, waiting]);
      assert.deepEqual(order, ['app write+read', 'cli write+read']);
    } finally {
      await app.close();
      await cli.close();
    }
  }));

test('lock place: $XDG_RUNTIME_DIR/evnia; under sudo the invoking user\'s runtime dir, files given to that user', async () => {
  assert.deepEqual(lockPlace({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000), { dir: '/run/user/1000/evnia' });
  assert.deepEqual(lockPlace({ SUDO_UID: '1000', SUDO_GID: '1001' }, 0), { dir: '/run/user/1000/evnia', owner: { uid: 1000, gid: 1001 } });
  assert.deepEqual(lockPlace({ XDG_RUNTIME_DIR: '/run/user/1000', SUDO_UID: '1000' }, 0), { dir: '/run/user/1000/evnia', owner: { uid: 1000, gid: 1000 } });
  assert.equal(lockPlace({}, 1000), null);
  assert.equal(lockPlace({ SUDO_UID: '1000' }, 1000), null); // SUDO_UID only matters for root
  assert.equal(lockFileName('AU00000000001'), 'ddc-AU00000000001.lock');

  if (process.getuid?.() !== 0) return; // chown needs root (the Docker test image runs as root)
  await withDir(async (runtime) => {
    const lock = new FlockProcessLock({ dir: join(runtime, 'evnia'), owner: { uid: 1234, gid: 2345 } });
    try {
      await lock.run(['AU00000000001'], async () => undefined);
      for (const path of [join(runtime, 'evnia'), join(runtime, 'evnia', 'ddc-AU00000000001.lock')]) {
        const s = await stat(path);
        assert.deepEqual([s.uid, s.gid], [1234, 2345], path);
      }
      assert.equal((await stat(join(runtime, 'evnia'))).mode & 0o777, 0o700);
    } finally {
      await lock.close();
    }
  });
});

test('a missing runtime directory degrades to no cross-process lock, with a warning', () =>
  withDir(async (dir) => {
    const warnings: string[] = [];
    const log = { debug() {}, info() {}, warn: (m: unknown) => warnings.push(String(m)), error() {}, child: () => log };
    const lock = new FlockProcessLock({ dir: join(dir, 'no-such-runtime', 'evnia') });
    assert.equal(await lock.run(['k'], async () => 'ran', log), 'ran');
    assert.equal(await lock.run(['k'], async () => 'again', log), 'again');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unavailable .*ENOENT.*continuing without it/);
  }));

/** Records the keys of every transaction; can be switched to fail like a peer that never lets go. */
class RecordingLock implements ProcessLock {
  readonly calls: string[][] = [];
  busy = false;
  async run<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
    this.calls.push([...keys]);
    if (this.busy) throw new DdcError('busy', 'another process has held the DDC lock for too long');
    return fn();
  }
}

test('channel: one process-lock hold per transaction, keyed by path and monitor (20 §2.4)', async () => {
  const monitor = new SimulatedMonitor();
  const via = new ScriptedTransport('via-usb', 'via:usb:3-2.4', monitor);
  const i2c = new ScriptedTransport('i2c-dev', 'i2c:/dev/i2c-5', monitor);
  const lock = new RecordingLock();
  const ch = new DdcChannelImpl([via, i2c], { timings: NO_DELAY_TIMINGS, processLock: lock, monitorKey: 'AU00000000001' });
  await ch.probe();
  assert.deepEqual(lock.calls, [['via:usb:3-2.4', 'AU00000000001'], ['i2c:/dev/i2c-5', 'AU00000000001']]);
  lock.calls.length = 0;
  await ch.getVcp(0x10);
  await ch.setVcp(0x10, 50);
  assert.deepEqual(lock.calls, [['via:usb:3-2.4', 'AU00000000001'], ['via:usb:3-2.4', 'AU00000000001']]);
  // Capabilities: one hold per fragment, released in between (a peer can take turns).
  lock.calls.length = 0;
  await ch.capabilities();
  assert.equal(lock.calls.length, via.ops.filter((o) => o.startsWith('w:51 83 F3')).length);
  // Without a monitor key only the path is locked.
  const bare = new DdcChannelImpl([via], { timings: NO_DELAY_TIMINGS, processLock: lock });
  lock.calls.length = 0;
  await bare.getVcp(0x12);
  assert.deepEqual(lock.calls, [['via:usb:3-2.4']]);
});

test('channel: busy is neither retried, nor failed over, nor taken as a failed probe', async () => {
  const monitor = new SimulatedMonitor();
  const via = new ScriptedTransport('via-usb', 'via:usb:3-2.4', monitor);
  const i2c = new ScriptedTransport('i2c-dev', 'i2c:/dev/i2c-5', monitor);
  const lock = new RecordingLock();
  const ch = new DdcChannelImpl([via, i2c], { timings: NO_DELAY_TIMINGS, processLock: lock, monitorKey: 'AU00000000001' });
  lock.busy = true;
  await assert.rejects(ch.probe(), (e: unknown) => e instanceof DdcError && e.code === 'busy');
  await assert.rejects(ch.getVcp(0x10), (e: unknown) => e instanceof DdcError && e.code === 'busy');
  await assert.rejects(ch.setVcp(0x10, 1), (e: unknown) => e instanceof DdcError && e.code === 'busy');
  await assert.rejects(ch.capabilities(), (e: unknown) => e instanceof DdcError && e.code === 'busy');
  assert.equal(lock.calls.length, 4); // one attempt each, never on i2c
  assert.deepEqual([via.ops, i2c.ops], [[], []]);
  lock.busy = false;
  await ch.getVcp(0x10); // USB was not marked unusable
  assert.equal(ch.activeTransport, via);
});
