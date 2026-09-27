// exitApp sequence (src/main/exit.ts, 01 §3.5): vendor order, and a failing step never skips the
// backend stop (ENE release, DDC drain).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { appExitSteps, type ExitParts, runExitSteps } from '../../../src/main/exit.ts';

const log = createLogger('test', silentSink);

function parts(calls: string[], failing: ReadonlySet<string> = new Set()): ExitParts {
  const step = (name: string) => () => {
    calls.push(name);
    if (failing.has(name)) throw new Error(`${name} failed`);
  };
  return {
    saveAndHideWindow: step('window'),
    clearDebugFlag: step('debugFlag'),
    tray: { destroy: step('tray') },
    deviceEvents: [{ dispose: step('gate') }, { dispose: step('udev') }],
    foreground: { dispose: step('foreground') },
    capture: { dispose: step('capture') },
    notice: { destroy: step('notice') },
    stopUsbWatch: step('usb'),
    backend: {
      stop: async () => {
        await new Promise((r) => setTimeout(r, 10));
        calls.push('backend');
        if (failing.has('backend')) throw new Error('backend failed');
      },
    },
  };
}

const ORDER = ['window', 'debugFlag', 'tray', 'gate', 'udev', 'foreground', 'capture', 'notice', 'usb', 'backend'];

test('exit runs the vendor order and awaits the backend last', async () => {
  const calls: string[] = [];
  await runExitSteps(appExitSteps(parts(calls)), log);
  assert.deepEqual(calls, ORDER);
});

test('a throwing step (EPERM on the debug flag, a dead tray) does not skip the rest', async () => {
  const calls: string[] = [];
  const errors: string[] = [];
  const recording = createLogger('test', (level, _scope, args) => {
    if (level === 'error') errors.push(String(args[0]));
  });
  await runExitSteps(appExitSteps(parts(calls, new Set(['window', 'debugFlag', 'tray', 'capture']))), recording);
  assert.deepEqual(calls, ORDER);
  assert.equal(errors.length, 4);
  assert.match(errors[1], /"debug flag" failed/);
});

test('a rejected backend stop is logged, not thrown', async () => {
  const calls: string[] = [];
  await assert.doesNotReject(runExitSteps(appExitSteps(parts(calls, new Set(['backend']))), log));
  assert.equal(calls.at(-1), 'backend');
});

test('missing pieces (exit before the windows exist) are skipped', async () => {
  const calls: string[] = [];
  await runExitSteps(appExitSteps({ ...parts(calls), notice: null, stopUsbWatch: null }), log);
  assert.deepEqual(calls, ORDER.filter((c) => c !== 'notice' && c !== 'usb'));
});
