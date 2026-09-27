import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createBackend, type ApiModule } from '../../../src/backend/index.ts';
import { RecordingRegistry } from '../../../src/backend/api/catalog.ts';
import {
  DEFAULT_START_WATCHDOG_MS,
  MAX_START_WATCHDOG_MS,
  NOTIFY_DEVICE_CONNECTION_STATUS,
  START_INIT_ERROR,
  createSystemApi,
  systemApi,
} from '../../../src/backend/api/system.ts';
import type { MonitorManager, ThemeStore } from '../../../src/backend/services.ts';
import type { JsonResult, RpcCallContext } from '../../../src/backend/types.ts';
import { captureLogger } from '../rpc/helpers.ts';
import { API_DIR, deferred, request, testHost, testServices } from './helpers.ts';

/** The verbatim Start request of the user's session and the reply the Windows backend sent (20-backend-host-tail §5 step 2). */
const START_REQUEST = '{"functionName":"Start","requestId":"683a49b0-ff8e-4e9e-aa25-30a2e8d09b87","parms":null}';
const START_REPLY = '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"683a49b0-ff8e-4e9e-aa25-30a2e8d09b87","Tag":true,"FunctionName":"Start","CurrItem":null}';

/** NotifyDeviceConnectionStatus after a late Start run (D2): NotificationDataBase{DeviceType, Data}, err_msg null (20-backend-host-tail §2.5). */
const LATE_NOTIFICATION = (connected: boolean) =>
  `{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":{"DeviceType":100000,"Data":${connected}},"FunctionName":"NotifyDeviceConnectionStatus","CurrItem":null}`;

type Scan = MonitorManager['scan'];

/** Fake theme store + monitor manager that record the calls Start makes. */
function fakes(opts: { themeStart?: () => Promise<void>; scan?: Scan; connectList?: () => unknown[] } = {}) {
  const calls: string[] = [];
  // Only start() is used by Start; the rest of the ThemeStore contract is irrelevant here.
  const themes = {
    start: async () => {
      calls.push('themes.start');
      await opts.themeStart?.();
    },
  } as unknown as ThemeStore;
  const monitors = {
    scan: async (kind: 'all' | 'usb' | 'display') => {
      calls.push(`scan:${kind}`);
      await opts.scan?.(kind);
    },
    connectList: () => opts.connectList?.() ?? [],
    current: () => null,
  } as unknown as MonitorManager;
  return { calls, themes, monitors };
}

function startHandler(module = systemApi, slots: Parameters<typeof testServices>[0] = {}) {
  const { services, lines, notifications } = testServices(slots);
  const registry = new RecordingRegistry();
  module(registry, services);
  const handler = registry.handler('Start', []);
  assert.ok(handler, 'Start() is registered');
  const ctx: RpcCallContext = { functionName: 'Start', requestId: 'r', log: services.log };
  return { call: () => Promise.resolve(handler([], ctx)) as Promise<JsonResult>, lines, notifications, registry };
}

const tick = () => new Promise((r) => setImmediate(r));

test('system.ts registers exactly Start()', () => {
  const { registry } = startHandler();
  assert.deepEqual(registry.registrations.map((r) => [r.name, r.signature]), [['Start', []]]);
  assert.deepEqual(registry.audit({ owners: ['system'] }).ok, true);
});

test('Start without services replies Succ(true) and warns (golden step 2 bytes)', async () => {
  const { log, lines } = captureLogger('backend');
  const backend = createBackend({ host: testHost(log), noHardware: true }, { modules: [systemApi] });
  assert.equal(await backend.handleRequest(START_REQUEST), START_REPLY);
  const warnings = lines.filter((l) => l.level === 'warn').map((l) => l.text);
  assert.ok(warnings.some((w) => /no theme store/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /no monitor manager/.test(w)), warnings.join('\n'));
  assert.equal(await backend.handleRequest(START_REQUEST), START_REPLY, 'idempotent');
  assert.equal(
    JSON.parse(await backend.handleRequest(request('Start', [1]))).err_msg,
    'params error: Zeasn.Com.Lib.JsonResult Start()',
    'vendor overload error for a wrong argument list',
  );
});

test('the first Start loads the theme store, then enumerates all devices, then replies true', async () => {
  const f = fakes();
  const { call, notifications } = startHandler(systemApi, { themes: f.themes, monitors: f.monitors });
  const r = await call();
  assert.equal(r.err_code, 0);
  assert.equal(r.Tag, true);
  assert.equal(r.err_msg, '');
  assert.deepEqual(f.calls, ['themes.start', 'scan:all']);
  assert.deepEqual((await call()).Tag, true);
  assert.deepEqual(f.calls, ['themes.start', 'scan:all'], 'a completed Start is not repeated (vendor bool_0)');
  assert.deepEqual(notifications, [], 'a Start that answers in time sends no notification');
});

test('concurrent Start calls share one in-flight scan', async () => {
  const gate = deferred();
  const f = fakes({ scan: () => gate.promise });
  const { call } = startHandler(systemApi, { themes: f.themes, monitors: f.monitors });
  const a = call();
  const b = call();
  await tick();
  const c = call();
  gate.resolve();
  const replies = await Promise.all([a, b, c]);
  assert.deepEqual(replies.map((r) => r.Tag), [true, true, true]);
  assert.deepEqual(f.calls, ['themes.start', 'scan:all']);
});

test('a failing theme store gives the vendor error, the scan still runs, and the Start after its recovery scans once more', async () => {
  let fail = true;
  const f = fakes({
    themeStart: async () => {
      if (fail) throw new Error('EACCES: permission denied, open DataTheme.cfg');
    },
  });
  const { call, lines } = startHandler(systemApi, { themes: f.themes, monitors: f.monitors });
  const r = await call();
  assert.equal(r.err_code, 9);
  assert.equal(r.IsSucc, false);
  assert.equal(r.err_msg, START_INIT_ERROR);
  assert.equal(START_INIT_ERROR, 'InitEnviroment error', 'vendor spelling (SystemOper.cs:117)');
  assert.deepEqual(f.calls, ['themes.start', 'scan:all'], 'deviation D1: the monitor is still enumerated');
  assert.ok(lines.some((l) => l.level === 'error' && /InitEnviroment error/.test(l.text)));
  fail = false;
  assert.equal((await call()).Tag, true);
  assert.deepEqual(f.calls, ['themes.start', 'scan:all', 'themes.start', 'scan:all'], 'vendor order InitEnviroment → scan once the store loads');
  await call();
  assert.equal(f.calls.length, 4, 'done after the successful retry');
});

test('while the theme store keeps failing, later Starts retry only the theme store and never rescan', async () => {
  const f = fakes({
    themeStart: async () => {
      throw new Error('EROFS: read-only file system');
    },
  });
  const { call, lines } = startHandler(systemApi, { themes: f.themes, monitors: f.monitors });
  for (let i = 0; i < 3; i++) {
    const r = await call();
    assert.equal(r.err_msg, START_INIT_ERROR, `Start #${i + 1}`);
  }
  assert.deepEqual(f.calls, ['themes.start', 'scan:all', 'themes.start', 'themes.start'], 'one scan; renderer reconnects do not re-run discovery');
  assert.ok(lines.some((l) => l.level === 'warn' && /displays already enumerated/.test(l.text)));
});

test('a failing theme store after a failed scan still rescans (the displays were never enumerated)', async () => {
  let scanFails = true;
  const f = fakes({
    themeStart: async () => {
      throw new Error('EACCES');
    },
    scan: async () => {
      if (scanFails) throw new Error('DDC probe failed');
    },
  });
  const { call } = startHandler(systemApi, { themes: f.themes, monitors: f.monitors });
  assert.equal((await call()).err_msg, START_INIT_ERROR);
  scanFails = false;
  assert.equal((await call()).err_msg, START_INIT_ERROR);
  assert.equal((await call()).err_msg, START_INIT_ERROR);
  assert.deepEqual(f.calls, ['themes.start', 'scan:all', 'themes.start', 'scan:all', 'themes.start']);
});

test('a failing scan still replies Succ(true) (vendor catches it) and the next Start scans again', async () => {
  let fail = true;
  const f = fakes({
    scan: async () => {
      if (fail) throw new Error('DDC probe failed');
    },
  });
  const { call, lines } = startHandler(systemApi, { themes: f.themes, monitors: f.monitors });
  assert.equal((await call()).Tag, true);
  assert.ok(lines.some((l) => l.level === 'error' && /display scan failed/.test(l.text)));
  fail = false;
  assert.equal((await call()).Tag, true);
  assert.equal((await call()).Tag, true);
  assert.deepEqual(f.calls, ['themes.start', 'scan:all', 'themes.start', 'scan:all']);
});

test('a monitor slot without scan() is tolerated like a missing one', async () => {
  const { call, lines } = startHandler(systemApi, { monitors: { start: async () => {} } as unknown as MonitorManager });
  assert.equal((await call()).Tag, true);
  assert.ok(lines.some((l) => l.level === 'warn' && /no monitor manager/.test(l.text)));
});

test('the watchdog replies true while a slow scan continues; the late run makes the renderer re-fetch the device list', async () => {
  assert.equal(DEFAULT_START_WATCHDOG_MS, 60_000);
  const gate = deferred();
  let connected: unknown[] = [];
  const f = fakes({ scan: () => gate.promise, connectList: () => connected });
  const { call, lines, notifications } = startHandler(createSystemApi({ startWatchdogMs: 20 }), { themes: f.themes, monitors: f.monitors });
  const t0 = performance.now();
  const r = await call();
  assert.equal(r.Tag, true);
  assert.ok(performance.now() - t0 >= 15);
  assert.ok(lines.some((l) => l.level === 'warn' && /still running after 20 ms/.test(l.text)));
  assert.deepEqual(notifications, [], 'nothing before the run finishes');
  const joined = call(); // joins the running scan (and its own watchdog)
  connected = [{ DeviceType: 100000 }];
  gate.resolve();
  assert.equal((await joined).Tag, true);
  assert.equal((await call()).Tag, true);
  assert.deepEqual(f.calls, ['themes.start', 'scan:all'], 'one scan for all three calls');
  // MN:1803-1806: the subscriber calls Device_GetConnectList again and saves the list.
  assert.deepEqual(notifications, [LATE_NOTIFICATION(true)], `one ${NOTIFY_DEVICE_CONNECTION_STATUS} once the late run finished`);
});

test('a late run that finds no display still tells the renderer to refresh (Data false)', async () => {
  const gate = deferred();
  const f = fakes({ scan: () => gate.promise });
  const { call, notifications } = startHandler(createSystemApi({ startWatchdogMs: 5 }), { themes: f.themes, monitors: f.monitors });
  assert.equal((await call()).Tag, true);
  gate.resolve();
  await tick();
  await tick();
  assert.deepEqual(notifications, [LATE_NOTIFICATION(false)]);
});

test('with the watchdog disabled Start waits for the scan however long it takes', async () => {
  const gate = deferred();
  const f = fakes({ scan: () => gate.promise });
  const { call, notifications } = startHandler(createSystemApi({ startWatchdogMs: 0 }), { themes: f.themes, monitors: f.monitors });
  let settled = false;
  const p = call().then((r) => {
    settled = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false);
  gate.resolve();
  assert.equal((await p).Tag, true);
  assert.deepEqual(notifications, []);
});

test('startWatchdogMs outside the setTimeout range is rejected instead of firing after 1 ms', () => {
  for (const bad of [Infinity, Number.NaN, MAX_START_WATCHDOG_MS + 1, 2 ** 40]) {
    assert.throws(() => createSystemApi({ startWatchdogMs: bad }), RangeError, String(bad));
  }
  assert.equal(MAX_START_WATCHDOG_MS, 2_147_483_647);
  for (const ok of [MAX_START_WATCHDOG_MS, 1, 0, -1, -Infinity]) createSystemApi({ startWatchdogMs: ok });
});

test('in a composed backend Start runs after backend.start() and replies the vendor bytes', async () => {
  const { log } = captureLogger('backend');
  const f = fakes();
  const backend = createBackend(
    { host: testHost(log), noHardware: true },
    { services: () => ({ themes: f.themes, monitors: f.monitors }), modules: [systemApi] },
  );
  await backend.start();
  assert.deepEqual(f.calls, ['themes.start'], 'the lifecycle starts the theme store');
  assert.equal(await backend.handleRequest(START_REQUEST), START_REPLY);
  assert.deepEqual(f.calls, ['themes.start', 'themes.start', 'scan:all'], 'Start re-awaits the (idempotent) theme start, then scans');
  await backend.stop();
});

// ───────────────────── Contract with api/device.ts (impl-api.md §5): the renderer's startup S() ─────────────────────

const DEVICE_FILE = `${API_DIR}device.ts`;

test(
  'D2 end to end: after a watchdog reply Device_GetConnectList answers at once from the current enumeration, and the late run brings the display',
  { skip: !existsSync(DEVICE_FILE) && 'api/device.ts does not exist yet' },
  async () => {
    const { deviceApi } = (await import(pathToFileURL(DEVICE_FILE).href)) as { deviceApi: ApiModule };
    const gate = deferred();
    const info = { DeviceType: 100000, ModelName: 'PHL 34M2C8600' };
    let enumerated = false;
    const f = fakes({ scan: () => gate.promise, connectList: () => (enumerated ? [info] : []) });
    const { log } = captureLogger('backend');
    const backend = createBackend(
      { host: testHost(log), noHardware: true },
      { services: () => ({ themes: f.themes, monitors: f.monitors }), modules: [createSystemApi({ startWatchdogMs: 20 }), deviceApi] },
    );
    const notifications: string[] = [];
    backend.onNotification((n) => notifications.push(n));
    const list = async () => JSON.parse(await backend.handleRequest(request('Device_GetConnectList'))) as JsonResult;

    // MN:190-198: systemInit (Start) → getDeviceList → saveDeviceList. Device_GetConnectList has no catch
    // in S() (20-backend-host-tail §6 item 1): it must answer, from what is enumerated now, while the scan runs.
    assert.equal(JSON.parse(await backend.handleRequest(START_REQUEST)).Tag, true, 'watchdog reply');
    const t0 = performance.now();
    const early = await list();
    assert.ok(performance.now() - t0 < 1000, 'Device_GetConnectList does not wait for the in-flight scan');
    assert.equal(early.err_code, 0);
    assert.deepEqual(early.Tag, []);
    assert.deepEqual(notifications, []);

    enumerated = true;
    gate.resolve();
    for (let i = 0; i < 10 && notifications.length === 0; i++) await tick();
    assert.deepEqual(notifications, [LATE_NOTIFICATION(true)]);
    // The renderer's NotifyDeviceConnectionStatus subscriber (MN:1803-1806) fetches the list again.
    assert.deepEqual((await list()).Tag, [info]);
  },
);
