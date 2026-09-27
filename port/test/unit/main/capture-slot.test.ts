// Capture start/stop sequencing (src/main/capture-slot.ts), the core of ElectronCaptureHost's video
// half: a stop or a newer start issued while a start is still awaiting must cancel it, and frames of a
// cancelled session must never reach a callback. The Electron side is exercised end to end in
// test/e2e/capture.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CaptureSlot, withTimeout } from '../../../src/main/capture-slot.ts';

type Sink = (frame: string) => void;

/** The host's start algorithm, with every await point replaced by a controllable gate. */
function makeHost() {
  const slot = new CaptureSlot<Sink>();
  const gates: Array<() => void> = [];
  const gate = () => new Promise<void>((r) => gates.push(r));
  const opened: number[] = [];
  const stopped: number[] = [];
  async function start(sink: Sink): Promise<boolean> {
    const session = slot.begin(sink);
    await gate(); // window / desktopCapturer / portal / getUserMedia
    if (!slot.isCurrent(session)) return false;
    opened.push(session);
    return true;
  }
  const frame = (session: number, f: string) => slot.sink(session)?.(f);
  const stop = () => {
    slot.stop();
    stopped.push(opened.length);
  };
  return { slot, gates, start, frame, stop, opened };
}

test('stop during a pending start: the start resolves false and delivers nothing', async () => {
  const h = makeHost();
  const got: string[] = [];
  const pending = h.start((f) => got.push(f));
  h.stop();
  h.gates.shift()!();
  assert.equal(await pending, false);
  h.frame(1, 'late frame');
  assert.deepEqual(got, []);
  assert.equal(h.slot.busy, false);
});

test('overlapping starts: the newer wins, the older resolves false and gets no frames', async () => {
  const h = makeHost();
  const a: string[] = [];
  const b: string[] = [];
  const pa = h.start((f) => a.push(f));
  const pb = h.start((f) => b.push(f));
  for (const g of h.gates.splice(0)) g();
  assert.deepEqual(await Promise.all([pa, pb]), [false, true]);
  h.frame(1, 'from the superseded stream');
  h.frame(2, 'x');
  assert.deepEqual([a, b], [[], ['x']]);
});

test('a restart while running drops the old stream at once', async () => {
  const h = makeHost();
  const a: string[] = [];
  const b: string[] = [];
  const pa = h.start((f) => a.push(f));
  h.gates.shift()!();
  assert.equal(await pa, true);
  h.frame(1, 'a1');
  const pb = h.start((f) => b.push(f));
  h.frame(1, 'a2 (in flight while restarting)');
  h.gates.shift()!();
  assert.equal(await pb, true);
  h.frame(2, 'b1');
  assert.deepEqual([a, b], [['a1'], ['b1']]);
});

test('release forgets a failed or ended session only if nothing newer happened', () => {
  const slot = new CaptureSlot<Sink>();
  const s1 = slot.begin(() => {});
  const s2 = slot.begin(() => {});
  slot.release(s1);
  assert.equal(slot.isCurrent(s2), true, 'a stale failure does not cancel the newer start');
  slot.release(s2);
  assert.equal(slot.busy, false);
  assert.equal(slot.sink(s2), null);
});

test('withTimeout: resolves with the promise, or with the timeout value', async () => {
  assert.equal(await withTimeout(Promise.resolve(true), 1000, () => false), true);
  let timedOut = false;
  const never = new Promise<boolean>(() => {});
  assert.equal(
    await withTimeout(never, 20, () => {
      timedOut = true;
      return false;
    }),
    false,
  );
  assert.equal(timedOut, true);
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 1000, () => false), /boom/);
});
