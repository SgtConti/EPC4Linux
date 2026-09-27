// X11ForegroundTracker (src/main/foreground-app.ts): the executable, WM_CLASS and Flatpak ID of the active
// window for app-bound themes (20-theme-profile-engine §10.2 item 5), with a fake xprop and a fake /proc.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import type { CommandResult } from '../../../src/main/child-process.ts';
import { X11ForegroundTracker } from '../../../src/main/foreground-app.ts';

const log = createLogger('test', silentSink);
const proc = mkdtempSync(join(tmpdir(), 'evnia-proc-'));
after(() => rmSync(proc, { recursive: true, force: true }));

function fakeProcess(pid: number, exe: string, cgroup = '0::/user.slice/user-1000.slice/session-2.scope\n'): void {
  mkdirSync(join(proc, String(pid)), { recursive: true });
  symlinkSync(exe, join(proc, String(pid), 'exe'));
  writeFileSync(join(proc, String(pid), 'cgroup'), cgroup);
}

fakeProcess(100, '/opt/google/chrome/chrome');
fakeProcess(200, '/app/lib/firefox/firefox-bin', '0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-org.mozilla.firefox-4711.scope\n');
fakeProcess(300, '/opt/evnia-precision-center/evnia-precision-center');

const WINDOWS: Record<string, string> = {
  '0x100': '_NET_WM_PID(CARDINAL) = 100\nWM_CLASS(STRING) = "google-chrome", "Google-chrome"\n',
  '0x200': '_NET_WM_PID(CARDINAL) = 200\nWM_CLASS(STRING) = "Navigator", "firefox"\n',
  '0x300': '_NET_WM_PID(CARDINAL) = 300\nWM_CLASS(STRING) = "evnia-precision-center", "Evnia Precision Center"\n',
  '0x400': '_NET_WM_PID:  not found.\nWM_CLASS(STRING) = "steam_app_570", "steam_app_570"\n',
  '0x500': '_NET_WM_PID:  not found.\nWM_CLASS:  not found.\n',
  '0x600': '_NET_WM_PID(CARDINAL) = 999\nWM_CLASS(STRING) = "self", "Self"\n',
};

function tracker(delays: Record<string, number> = {}) {
  const calls: string[][] = [];
  const t = new X11ForegroundTracker({
    log,
    env: {}, // no X11 session: nothing is spawned, lines are fed by the test
    selfExe: '/opt/evnia-precision-center/evnia-precision-center',
    selfPid: 999,
    procRoot: proc,
    run: async (command, args): Promise<CommandResult> => {
      calls.push([command, ...args]);
      const win = args[1];
      await new Promise((r) => setTimeout(r, delays[win] ?? 0));
      return WINDOWS[win] ? { ok: true, stdout: WINDOWS[win] } : { ok: false, stdout: '', error: 'BadWindow' };
    },
  });
  return { t, calls };
}

const line = (win: string) => `_NET_ACTIVE_WINDOW(WINDOW): window id # ${win}`;

test('one xprop query per window change gives exe, WM_CLASS and the Flatpak ID', async () => {
  const { t, calls } = tracker();
  assert.equal(t.currentApp(), null);
  await t.onActiveWindowLine(line('0x100'));
  assert.deepEqual(calls, [['xprop', '-id', '0x100', '_NET_WM_PID', 'WM_CLASS']]);
  assert.deepEqual(t.currentApp(), { exe: '/opt/google/chrome/chrome', wmClass: 'Google-chrome', appId: null });
  assert.equal(t.current(), '/opt/google/chrome/chrome', 'HostServices.getForegroundAppPath');
  await t.onActiveWindowLine(line('0x100'));
  assert.equal(calls.length, 1, 'the same window is not queried again');
  await t.onActiveWindowLine(line('0x200'));
  assert.deepEqual(t.currentApp(), { exe: '/app/lib/firefox/firefox-bin', wmClass: 'firefox', appId: 'org.mozilla.firefox' });
  await t.onActiveWindowLine(line('0x400'));
  assert.deepEqual(t.currentApp(), { exe: null, wmClass: 'steam_app_570', appId: null }, 'no _NET_WM_PID: WM_CLASS alone');
});

test('this app\'s own windows, unknown windows and failed queries keep the last foreign app', async () => {
  const { t } = tracker();
  await t.onActiveWindowLine(line('0x100'));
  for (const w of ['0x300', '0x600', '0x500', '0x777', '0x0']) await t.onActiveWindowLine(line(w));
  assert.deepEqual(t.currentApp(), { exe: '/opt/google/chrome/chrome', wmClass: 'Google-chrome', appId: null });
});

test('a slow answer for a window that lost focus meanwhile is dropped', async () => {
  const { t } = tracker({ '0x100': 50 });
  const slow = t.onActiveWindowLine(line('0x100'));
  await t.onActiveWindowLine(line('0x200'));
  await slow;
  assert.equal(t.currentApp()?.wmClass, 'firefox');
});

test('release() stops following the active window (the xprop -spy child exits); the next query starts it again', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'evnia-xprop-'));
  const events = join(bin, 'events');
  writeFileSync(events, '');
  // A fake `xprop -root -spy`: announces the active window, then waits; logs its start and its SIGTERM.
  writeFileSync(
    join(bin, 'xprop'),
    `#!/bin/sh\ntrap 'echo stopped >> "${events}"; exit 0' TERM\necho started >> "${events}"\necho '_NET_ACTIVE_WINDOW(WINDOW): window id # 0x100'\nwhile :; do sleep 0.05; done\n`,
  );
  chmodSync(join(bin, 'xprop'), 0o755);
  const t = new X11ForegroundTracker({
    log,
    env: { DISPLAY: ':99', PATH: `${bin}:/usr/bin:/bin` },
    selfExe: '/opt/evnia-precision-center/evnia-precision-center',
    selfPid: 999,
    procRoot: proc,
    run: async (_command, args): Promise<CommandResult> => ({ ok: true, stdout: WINDOWS[args[1]] ?? '' }),
  });
  const log2 = () => readFileSync(events, 'utf8').split('\n').filter(Boolean);
  const until = async (what: string, ok: () => boolean) => {
    const end = Date.now() + 5000;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    assert.equal(t.currentApp(), null, 'the first query starts tracking');
    assert.equal(t.tracking, true);
    await until('the foreground app', () => t.currentApp()?.exe === '/opt/google/chrome/chrome');
    t.release();
    assert.equal(t.tracking, false);
    await until('xprop to exit', () => log2().includes('stopped'));
    assert.deepEqual(log2(), ['started', 'stopped']);
    // Released: the last app is forgotten, nothing runs until the backend asks again.
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(log2(), ['started', 'stopped']);
    assert.equal(t.currentApp(), null, 'restarted, no stale answer');
    assert.equal(t.tracking, true);
    await until('the foreground app again', () => t.currentApp()?.wmClass === 'Google-chrome');
    assert.deepEqual(log2(), ['started', 'stopped', 'started']);
    t.release();
    t.release();
  } finally {
    t.dispose();
    rmSync(bin, { recursive: true, force: true });
  }
});
