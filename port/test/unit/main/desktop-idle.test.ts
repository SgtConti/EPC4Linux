// HostServices.shouldReleaseScreenCapture (src/main/desktop-idle.ts): close FollowVideo's capture before the
// desktop's idle timeout, since Chromium inhibits idle while a desktop capture is open.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import type { CommandResult } from '../../../src/main/child-process.ts';
import {
  DESKTOP_IDLE_FALLBACK_S,
  DESKTOP_IDLE_MARGIN_S,
  DESKTOP_IDLE_MIN_S,
  DesktopIdleWatch,
  desktopIdleKeys,
  parseTimeout,
} from '../../../src/main/desktop-idle.ts';

const log = createLogger('test', silentSink);
const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const SELF = '/opt/evnia-precision-center/evnia-precision-center';
const CINNAMON = { XDG_CURRENT_DESKTOP: 'X-Cinnamon' };

interface Desktop {
  settings: Record<string, string>;
  /** path → [app id, flags]; null = no org.gnome.SessionManager */
  inhibitors: Record<string, [string, number]> | null;
}

function fakeRun(d: Desktop, calls: string[] = []) {
  return async (command: string, args: readonly string[]): Promise<CommandResult> => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'gsettings') {
      const v = d.settings[`${args[1]} ${args[2]}`];
      return v === undefined ? { ok: false, stdout: '', error: `No such schema “${args[1]}”` } : { ok: true, stdout: `${v}\n` };
    }
    if (!d.inhibitors) return { ok: false, stdout: '', error: 'GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown' };
    const method = args[args.indexOf('--method') + 1];
    const path = args[args.indexOf('--object-path') + 1];
    if (method.endsWith('GetInhibitors')) return { ok: true, stdout: `([${Object.keys(d.inhibitors).map((p) => `objectpath '${p}'`).join(', ')}],)\n` };
    const entry = d.inhibitors[path];
    if (!entry) return { ok: false, stdout: '', error: 'UnknownObject' };
    return { ok: true, stdout: method.endsWith('GetAppId') ? `('${entry[0]}',)\n` : `(uint32 ${entry[1]},)\n` };
  };
}

function watch(d: Desktop, env: NodeJS.ProcessEnv = CINNAMON, calls: string[] = []) {
  const s = { idle: 0, now: 0 };
  const w = new DesktopIdleWatch({ log, run: fakeRun(d, calls), env, idleSeconds: () => s.idle, onBattery: () => false, selfExe: SELF, now: () => s.now });
  /** One poll per second from the current idle time up to `to`; returns the first idle second that released. */
  const until = async (to: number): Promise<number | null> => {
    let first: number | null = null;
    for (; s.idle <= to; s.idle++, s.now += 1000) {
      if (w.shouldRelease() && first === null) first = s.idle;
      await tick();
    }
    return first;
  };
  return { w, s, until };
}

const USER_CINNAMON = {
  'org.cinnamon.desktop.session idle-delay': 'uint32 900',
  'org.cinnamon.settings-daemon.plugins.power sleep-display-ac': '300',
};

test('the keys follow the desktop; values are seconds (MATE idle-delay in minutes), 0 means never', () => {
  assert.deepEqual(desktopIdleKeys(CINNAMON, false)?.map((k) => k.key), ['idle-delay', 'sleep-display-ac']);
  assert.deepEqual(desktopIdleKeys(CINNAMON, true)?.map((k) => k.key), ['idle-delay', 'sleep-display-battery']);
  assert.deepEqual(desktopIdleKeys({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }, false)?.map((k) => `${k.schema} ${k.key}`), ['org.gnome.desktop.session idle-delay']);
  assert.equal(desktopIdleKeys({ XDG_CURRENT_DESKTOP: 'MATE' }, false)?.[0].unit, 60);
  assert.equal(desktopIdleKeys({ XDG_CURRENT_DESKTOP: 'KDE' }, false), null);
  assert.equal(parseTimeout('uint32 900\n', 1), 900);
  assert.equal(parseTimeout('5', 60), 300);
  assert.equal(parseTimeout('uint32 0', 1), null);
  assert.throws(() => parseTimeout("'x'", 1), /unexpected/);
});

test('Cinnamon (display off after 5 min): released 15 s before the shortest timeout, with no other inhibitor; input ends it', async () => {
  const d: Desktop = { settings: USER_CINNAMON, inhibitors: { '/org/gnome/SessionManager/Inhibitor1': [SELF, 8] } };
  const { w, s, until } = watch(d);
  await tick();
  assert.equal(w.timeoutSeconds, 300);
  assert.equal(await until(400), 300 - DESKTOP_IDLE_MARGIN_S, 'our own inhibitor does not count');
  s.idle = 0;
  assert.equal(w.shouldRelease(), false, 'input: the capture opens again');
});

test('X11: released at the minimum idle time, since the close restarts the desktop\'s idle count; a desktop that never idles is left alone', async () => {
  const x11 = { ...CINNAMON, XDG_SESSION_TYPE: 'x11' };
  const { w, s, until } = watch({ settings: USER_CINNAMON, inhibitors: {} }, x11);
  await tick();
  assert.equal(await until(60), DESKTOP_IDLE_MIN_S, 'the display then blanks about 30 s after the desktop\'s 300 s, not after 585 s');
  s.idle = 0;
  s.now += 1000;
  assert.equal(w.shouldRelease(), false, 'input: the capture opens again');
  const never = watch({ settings: { 'org.cinnamon.desktop.session idle-delay': 'uint32 0', 'org.cinnamon.settings-daemon.plugins.power sleep-display-ac': '0' }, inhibitors: {} }, x11);
  await tick();
  assert.equal(await never.until(400), null);
  const other = watch({ settings: USER_CINNAMON, inhibitors: { '/i/2': ['firefox', 8] } }, x11);
  await tick();
  assert.equal(await other.until(400), null, 'a film playing keeps the capture open');
});

test('closing the capture resets the X idle counter: the release holds through the reset, and real input ends it', async () => {
  const d: Desktop = { settings: USER_CINNAMON, inhibitors: { '/i/1': [SELF, 8] } };
  const { w, s, until } = watch(d);
  await tick();
  assert.equal(await until(285), 285);
  // The close: the X server's idle counter starts again from 0 (Cinnamon X11, 2026-10-10: 285006 ms → 168 ms).
  delete d.inhibitors!['/i/1'];
  s.idle = 0;
  for (let i = 0; i < 600; i++) {
    s.now += 1000;
    s.idle += 1;
    assert.equal(w.shouldRelease(), true, `still released ${i + 1} s after the close`);
    await tick();
  }
  // Input: the counter falls behind the time since the close.
  s.now += 1000;
  s.idle = 0;
  assert.equal(w.shouldRelease(), false, 'input after the close opens the capture again');
  // ...and the next stretch releases again at 285 s.
  assert.equal(await until(400), 285);
});

test('a release delayed by a slow close still holds; another application inhibiting after the release opens the capture', async () => {
  const d: Desktop = { settings: USER_CINNAMON, inhibitors: {} };
  const { w, s, until } = watch(d);
  await tick();
  assert.equal(await until(285), 285);
  s.now += 3000; // the stream ended 3 s after the release
  s.idle = 0;
  for (let i = 0; i < 30; i++) {
    s.now += 1000;
    s.idle += 1;
    assert.equal(w.shouldRelease(), true);
    await tick();
  }
  d.inhibitors!['/i/2'] = ['/usr/bin/totem', 8];
  let opened = false;
  for (let i = 0; i < 12 && !opened; i++) {
    s.now += 1000;
    s.idle += 1;
    opened = !w.shouldRelease();
    await tick();
  }
  assert.ok(opened, 'a film started without input: the lights follow it again');
});

test('another application inhibiting idle (a video playing) keeps the capture open; when it stops, the release follows', async () => {
  const d: Desktop = { settings: USER_CINNAMON, inhibitors: { '/i/1': [SELF, 8], '/i/2': ['firefox', 8 | 4] } };
  const { s, until } = watch(d);
  await tick();
  assert.equal(await until(600), null);
  delete d.inhibitors!['/i/2'];
  const at = s.idle;
  const released = await until(at + 15);
  assert.ok(released !== null && released - at <= 11, `released within one re-read (${released! - at} s)`);
});

test('an inhibitor of something else than idle (logout, suspend) does not count', async () => {
  const d: Desktop = { settings: USER_CINNAMON, inhibitors: { '/i/2': ['/usr/bin/some-app', 4] } };
  const { until } = watch(d);
  await tick();
  assert.equal(await until(300), 285);
});

test('timeouts: never (0) → never released; unknown desktop or gsettings missing → the 5 min fallback; no SessionManager → released', async () => {
  const never = watch({ settings: { 'org.cinnamon.desktop.session idle-delay': 'uint32 0', 'org.cinnamon.settings-daemon.plugins.power sleep-display-ac': '0' }, inhibitors: null });
  await tick();
  assert.equal(never.w.timeoutSeconds, null);
  assert.equal(await never.until(4000), null);

  const kde = watch({ settings: {}, inhibitors: null }, { XDG_CURRENT_DESKTOP: 'KDE' });
  await tick();
  assert.equal(kde.w.timeoutSeconds, DESKTOP_IDLE_FALLBACK_S);
  assert.equal(await kde.until(400), DESKTOP_IDLE_FALLBACK_S - DESKTOP_IDLE_MARGIN_S);

  const noGsettings = watch({ settings: {}, inhibitors: null });
  await tick();
  assert.equal(noGsettings.w.timeoutSeconds, DESKTOP_IDLE_FALLBACK_S);
});

test('an active user costs no D-Bus calls; the settings are re-read once per idle stretch', async () => {
  const calls: string[] = [];
  const d: Desktop = { settings: { ...USER_CINNAMON }, inhibitors: {} };
  const { w, s, until } = watch(d, CINNAMON, calls);
  await tick();
  const atStart = calls.length;
  for (let i = 0; i < 100; i++) {
    s.idle = i % 15; // typing now and then
    w.shouldRelease();
    await tick();
  }
  assert.equal(calls.length, atStart, 'nothing while the user is active');
  d.settings['org.cinnamon.settings-daemon.plugins.power sleep-display-ac'] = '600';
  s.idle = 0;
  assert.equal(await until(400), null, 'the new 10 min timeout applies from this stretch on');
  assert.equal(w.timeoutSeconds, 600);
  assert.equal(calls.filter((c) => c.startsWith('gsettings')).length, 4, 'once at start, once for the stretch');
});
