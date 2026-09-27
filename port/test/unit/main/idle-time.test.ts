// HostServices.getIdleSeconds (src/main/idle-time.ts): Electron's idle time, plus Mutter's idle monitor on
// GNOME Wayland, polled only as often as the backend's ≥ 60 s thresholds need (09 §11, idle.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { isIdle } from '../../../src/backend/ambiglow/idle.ts';
import type { CommandResult } from '../../../src/main/child-process.ts';
import { IDLE_FAST_POLL_MS, IdleTimeSource, MUTTER_IDLE_ARGS, parseIdletime, useMutterIdle } from '../../../src/main/idle-time.ts';

const log = createLogger('test', silentSink);
const tick = () => new Promise((r) => setImmediate(r));

test('Mutter is used on GNOME Wayland only; GetIdletime replies are parsed', () => {
  assert.equal(useMutterIdle({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), true);
  assert.equal(useMutterIdle({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0', XDG_CURRENT_DESKTOP: 'GNOME' }), false, 'X11: XScreenSaver through Electron');
  assert.equal(useMutterIdle({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' }), false);
  assert.equal(parseIdletime('(uint64 61234,)\n'), 61234);
  assert.throws(() => parseIdletime("('x',)"), /unexpected/);
  assert.deepEqual(MUTTER_IDLE_ARGS.slice(-2), ['--method', 'org.gnome.Mutter.IdleMonitor.GetIdletime']);
});

test('without Mutter the value is Electron\'s, never negative or NaN', () => {
  let v = 12;
  const s = new IdleTimeSource({ log, electronIdleSeconds: () => v, mutter: false, run: async () => assert.fail('no D-Bus call') });
  assert.equal(s.seconds(), 12);
  v = Number.NaN;
  assert.equal(s.seconds(), 0);
  v = -3;
  assert.equal(s.seconds(), 0);
  const throwing = new IdleTimeSource({ log, electronIdleSeconds: () => { throw new Error('not ready'); }, mutter: false, run: async () => ({ ok: false, stdout: '' }) });
  assert.equal(throwing.seconds(), 0);
});

test('GNOME Wayland: Mutter polled adaptively; the backend\'s idle decision stays exact within about a second', async () => {
  let now = 0;
  let idleMs = 0; // Mutter's truth
  let lastInputAt = 0;
  const calls: number[] = [];
  const run = async (_c: string, _a: readonly string[]): Promise<CommandResult> => {
    calls.push(now);
    idleMs = now - lastInputAt;
    return { ok: true, stdout: `(uint64 ${idleMs},)` };
  };
  const s = new IdleTimeSource({ log, electronIdleSeconds: () => 0, mutter: true, run, now: () => now });
  const soft = { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 1 } as Parameters<typeof isIdle>[0];
  const decisions: [number, boolean][] = [];
  // the backend's CheckIdle: once per second for 3 minutes; the user types at t = 0 s and t = 30 s, then leaves,
  // and comes back at t = 150.5 s
  for (let t = 0; t <= 180_000; t += 1000) {
    now = t;
    if (t === 30_000) lastInputAt = t;
    if (t === 151_000) lastInputAt = 150_500;
    const idle = isIdle(soft, s.seconds());
    await tick();
    decisions.push([t, idle]);
  }
  const firstIdle = decisions.find(([, i]) => i)?.[0];
  assert.ok(firstIdle !== undefined && firstIdle >= 90_000 && firstIdle <= 91_000, `lights off 60 s after the last input (t=${firstIdle})`);
  const wake = decisions.find(([t, i]) => t > 150_000 && !i)?.[0];
  assert.ok(wake !== undefined && wake <= 152_000, `lights back within about a second of the input (t=${wake})`);
  assert.ok(decisions.filter(([t]) => t < 85_000).every(([, i]) => !i), 'never idle while the user is active');
  // while active the monitor is polled about once per ~55 s, while idle once per second
  const activePolls = calls.filter((t) => t < 80_000).length;
  assert.ok(activePolls <= 3, `active: ${activePolls} polls in 80 s`);
  const idlePolls = calls.filter((t) => t >= 91_000 && t < 150_000).length;
  assert.ok(idlePolls >= 55, `idle: ${idlePolls} polls in 59 s`);
  assert.ok(calls.every((t, i) => i === 0 || t - calls[i - 1] >= IDLE_FAST_POLL_MS));
});

test('Electron\'s value wins when larger; Mutter missing disables it, a hiccup backs off', async () => {
  let now = 0;
  const runMissing = async (): Promise<CommandResult> => ({ ok: false, stdout: '', error: 'ENOENT' });
  const a = new IdleTimeSource({ log, electronIdleSeconds: () => 7, mutter: true, run: runMissing, now: () => now });
  assert.equal(a.seconds(), 7);
  await tick();
  assert.equal(a.mutter, false);
  let calls = 0;
  const flaky = async (): Promise<CommandResult> => {
    calls++;
    return { ok: false, stdout: '', error: 'Error: Timeout was reached' };
  };
  const b = new IdleTimeSource({ log, electronIdleSeconds: () => 0, mutter: true, run: flaky, now: () => now });
  b.seconds();
  await tick();
  now = 10_000;
  b.seconds();
  await tick();
  assert.equal(calls, 1, 'retried only after the back-off');
  assert.equal(b.mutter, true);
  now = 30_000;
  b.seconds();
  await tick();
  assert.equal(calls, 2);
  const unknown = new IdleTimeSource({
    log,
    electronIdleSeconds: () => 0,
    mutter: true,
    run: async () => ({ ok: false, stdout: '', error: 'Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name is not activatable' }),
  });
  unknown.seconds();
  await tick();
  assert.equal(unknown.mutter, false);
});
