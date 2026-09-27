import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  API_MODULES,
  APP_RENDERER_ORIGINS,
  DEFAULT_HUB_PORT,
  HUB_PATH,
  createBackend,
  generateHubToken,
  startHubServer,
  type ApiModule,
  type ApiServices,
  type BackendComposition,
  type BackendService,
  type HubHandle,
  type ServiceSlots,
} from '../../../src/backend/index.ts';
import { handlerTimeoutMessage } from '../../../src/backend/rpc/dispatcher.ts';
import { succ } from '../../../src/backend/core/envelope.ts';
import type { Backend, HostServices } from '../../../src/backend/types.ts';
import { captureLogger, type LogLine } from '../rpc/helpers.ts';
import { RawClient, VendorRpc, invocation, sleep, vendorClient, waitFor } from './helpers.ts';

function host(): { host: HostServices; lines: LogLine[] } {
  const { log, lines } = captureLogger('backend');
  return { host: { log, serveDataDir: '/nonexistent/EvniaServe', appDataDir: '/nonexistent/evnia', resourcesDir: '/nonexistent/res' }, lines };
}

/** SoftConfigInfo field initializers (SoftConfigInfo.cs), the user's Config/SoftConfig.data. */
const SOFT_CONFIG = { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 } as const;

/**
 * The renderer's first calls answered as the Windows backend does on a machine without devices (the replies
 * of the removed wave-1 placeholder api/system-minimal.ts). These tests are about the hub and the backend
 * facade, so they use this fixture instead of the production services (which read and write the data
 * directories; test/contract runs those).
 */
const startupApi: ApiModule = (registry) => {
  registry.register('Start', [], () => succ(true));
  registry.register('Device_GetConnectList', [], () => succ([]));
  registry.register('Setting_GlobalData', [], () => succ({ ...SOFT_CONFIG }));
};
const STARTUP: BackendComposition = { modules: [startupApi] };

async function serve(t: TestContext, composition: BackendComposition = STARTUP): Promise<{ backend: Backend; hub: HubHandle; token: string; lines: LogLine[] }> {
  const { host: h, lines } = host();
  const backend = createBackend({ host: h, noHardware: true }, composition);
  await backend.start();
  const token = generateHubToken();
  const hub = await startHubServer(backend, { port: 0, token, log: h.log.child('hub') });
  t.after(async () => {
    await hub.close();
    await backend.stop();
  });
  return { backend, hub, token, lines };
}

/** Lifecycle-only stand-ins for all three slots (these tests only look at start/stop). */
function lifecycleSlots(slots: Record<keyof ServiceSlots, BackendService>): ServiceSlots {
  return slots as unknown as ServiceSlots;
}

async function rpcClient(t: TestContext, port: number, token: string): Promise<VendorRpc> {
  const hub = vendorClient(port, token);
  const rpc = new VendorRpc(hub);
  await hub.start();
  t.after(() => hub.stop());
  return rpc;
}

test('the renderer startup calls work end to end through the vendor-configured client', async (t) => {
  const { hub, token } = await serve(t);
  assert.equal(DEFAULT_HUB_PORT, 10010);
  assert.equal(HUB_PATH, '/EvniaHub');
  const rpc = await rpcClient(t, hub.port, token);
  assert.equal(hub.connectionCount, 1);
  assert.equal(await rpc.invoke('Start'), true);
  assert.deepEqual(await rpc.invoke('Device_GetConnectList'), []);
  assert.deepEqual(await rpc.invoke('Setting_GlobalData'), { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 });
  await assert.rejects(rpc.invoke('Theme_GetThemeInfos'), { code: 9, msg: 'functionName: Theme_GetThemeInfos undefined' });
  await assert.rejects(rpc.invoke('Start', 1.5), { code: 9, msg: 'Unsupported parameter type: Float' });
});

test('wire bytes of a reply match the Windows backend (Setting_GlobalData)', async (t) => {
  const { hub, token } = await serve(t);
  const raw = await RawClient.open(hub.port, `?k=${token}`);
  t.after(() => raw.ws.terminate());
  await raw.handshake();
  raw.send(invocation('{"functionName":"Setting_GlobalData","requestId":"4acabfda-1fb3-4219-b6dc-3b239819fcb9","parms":null}', '0'));
  const reply = await raw.nextNonPing();
  assert.deepEqual(reply, {
    type: 1,
    target: 'GetTaskAsync',
    arguments: ['{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"4acabfda-1fb3-4219-b6dc-3b239819fcb9","Tag":{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5},"FunctionName":"Setting_GlobalData","CurrItem":null}'],
  });
  assert.deepEqual(await raw.nextNonPing(), { type: 3, invocationId: '0', result: null });
});

test('API modules get the services; notifications reach every client, replies only the caller', async (t) => {
  let services: ApiServices | null = null;
  const notifying: ApiModule = (registry, s) => {
    services = s;
    registry.register('Test_Notify', ['string'], ([name]) => {
      s.notifier.notify(String(name), { DeviceType: 100000, Data: true });
      return succ(true);
    });
  };
  const { hub, token } = await serve(t, { modules: [...API_MODULES, notifying] });
  assert.ok(services);
  const s = services as ApiServices;
  assert.equal(typeof s.log.child, 'function');
  assert.equal(s.host.serveDataDir, '/nonexistent/EvniaServe');
  assert.equal(s.options.noHardware, true);
  assert.equal(s.monitors, undefined);
  // The slots carry their services.ts contracts, so api/ modules call them without casts (tsc checks this).
  const scanAll = (api: ApiServices): Promise<void> | undefined => api.monitors?.scan('all');
  assert.equal(scanAll(s), undefined);

  const a = await rpcClient(t, hub.port, token);
  const b = await rpcClient(t, hub.port, token);
  assert.equal(await a.invoke('Test_Notify', 'NotifyDeviceConnectionStatus'), true);
  await waitFor(() => a.notifications.length === 1 && b.notifications.length === 1, 3000, 'notifications on both clients');
  for (const c of [a, b]) assert.deepEqual(c.notifications, [{ name: 'NotifyDeviceConnectionStatus', tag: { DeviceType: 100000, Data: true } }]);
  assert.equal(await b.invoke('Start'), true); // b's own request still resolves normally
});

test('service lifecycle: ordered start, reverse stop, idempotent, failures logged but not fatal', async () => {
  const order: string[] = [];
  const svc = (name: string, failStart = false) => ({
    start: async () => {
      order.push(`start:${name}`);
      if (failStart) throw new Error(`${name} cannot start`);
    },
    stop: async () => {
      order.push(`stop:${name}`);
    },
  });
  const { host: h, lines } = host();
  const backend = createBackend({ host: h }, { services: () => lifecycleSlots({ ambiglow: svc('ambiglow'), monitors: svc('monitors', true), themes: svc('themes') }) });
  await backend.stop(); // not started: no-op
  await Promise.all([backend.start(), backend.start()]);
  await backend.start();
  assert.deepEqual(order, ['start:themes', 'start:monitors', 'start:ambiglow']);
  assert.ok(lines.some((l) => l.level === 'error' && l.text.includes('monitors start failed')));
  await backend.stop();
  await backend.stop();
  assert.deepEqual(order.slice(3), ['stop:ambiglow', 'stop:monitors', 'stop:themes']);
  await backend.start(); // restartable
  assert.equal(order.length, 9);
  await backend.stop();
});

test('hotplug is published on the event bus; the services factory sees the core services', async () => {
  const seen: string[] = [];
  const { host: h } = host();
  const backend = createBackend({ host: h }, {
    services: (core) => {
      core.events.on('hotplug', ({ kind }) => seen.push(`service:${kind}`));
      return {};
    },
    modules: [(_r, s) => void s.events.on('hotplug', ({ kind }) => seen.push(`module:${kind}`))],
  });
  backend.hotplug('usb');
  backend.hotplug('display');
  assert.deepEqual(seen, ['service:usb', 'module:usb', 'service:display', 'module:display']);
});

test('startHubServer passes a custom Origin allow-list to the hub', async (t) => {
  const { host: h } = host();
  const backend = createBackend({ host: h }, STARTUP);
  const token = generateHubToken();
  const hub = await startHubServer(backend, { port: 0, token, log: h.log, allowedOrigins: ['app://evnia'] });
  t.after(() => hub.close());
  const ok = await RawClient.open(hub.port, `?k=${token}`, { Origin: 'app://evnia' });
  ok.ws.terminate();
  await assert.rejects(RawClient.open(hub.port, `?k=${token}`, { Origin: 'file://' }), /HTTP 403/);
});

test('the app hub admits only its loadFile renderer (file://) and Origin-less clients; opaque origins (null) are refused', async (t) => {
  // impl-hub-rpc §4: any web page can open the socket from an opaque origin (Origin: null); the vendor
  // renderer loaded with loadFile sends file://, so the app's hub (startHubServer) does not admit null.
  assert.deepEqual(APP_RENDERER_ORIGINS, ['file://']);
  const { host: h } = host();
  const backend = createBackend({ host: h }, STARTUP);
  const token = generateHubToken();
  const hub = await startHubServer(backend, { port: 0, token, log: h.log });
  t.after(() => hub.close());
  for (const headers of [{ Origin: 'file://' }, {}] as Record<string, string>[]) {
    const ok = await RawClient.open(hub.port, `?k=${token}`, headers);
    ok.ws.terminate();
  }
  await assert.rejects(RawClient.open(hub.port, `?k=${token}`, { Origin: 'null' }), /HTTP 403/);
  await assert.rejects(RawClient.open(hub.port, `?k=${token}`, { Origin: 'https://evil.example' }), /HTTP 403/);
});

test('afterStart runs after every start phase, knows a restart, and a failure in it never fails start()', async () => {
  const order: string[] = [];
  const svc = (name: string) => ({
    start: async () => void order.push(`start:${name}`),
    stop: async () => void order.push(`stop:${name}`),
  });
  const { host: h, lines } = host();
  let fail = false;
  const backend = createBackend({ host: h }, {
    services: () => lifecycleSlots({ themes: svc('themes'), monitors: svc('monitors'), ambiglow: svc('ambiglow') }),
    modules: [],
    afterStart: async (services, { restart }) => {
      assert.equal(typeof services.monitors?.start, 'function', 'the hook sees the service slots');
      order.push(`afterStart:${restart}`);
      if (fail) throw new Error('rescan failed');
    },
  });
  await Promise.all([backend.start(), backend.start()]);
  assert.deepEqual(order, ['start:themes', 'start:monitors', 'start:ambiglow', 'afterStart:false']);
  await backend.stop();
  order.length = 0;
  fail = true;
  await backend.start(); // resolves although the hook throws
  assert.deepEqual(order, ['start:themes', 'start:monitors', 'start:ambiglow', 'afterStart:true']);
  assert.ok(lines.some((l) => l.level === 'error' && l.text.startsWith('afterStart failed')));
  await backend.stop();
});

test('handleRequest and onNotification work without a hub; closing the hub unsubscribes it', async (t) => {
  let notify: ((n: string) => void) | null = null;
  const { backend, hub } = await serve(t, { modules: [(r, s) => { notify = (n) => s.notifier.notify(n, null); r.register('Start', [], () => succ(true)); }] });
  const reply = JSON.parse(await backend.handleRequest('{"functionName":"Start","requestId":"x","parms":null}')) as { Tag: unknown; RequestId: string };
  assert.deepEqual([reply.Tag, reply.RequestId], [true, 'x']);
  const got: string[] = [];
  const off = backend.onNotification((j) => got.push(j));
  notify!('NotifyA');
  off();
  notify!('NotifyB');
  assert.equal(got.length, 1);
  assert.equal(JSON.parse(got[0]).FunctionName, 'NotifyA');
  await hub.close();
  assert.doesNotThrow(() => notify!('AfterClose'));
});

test('wire order inside one invocation: notifications raised by the handler, then the reply, then the Completion (20 §1.4)', async (t) => {
  const notifying: ApiModule = (registry, s) => {
    registry.register('PHL_GetConstraints', [], async () => {
      s.notifier.notify('NotifyUIDisplayFuncConstraintsChange', { DeviceType: 100000 });
      await sleep(5);
      s.notifier.notify('NotifyDeviceConnectionStatus', 1);
      return succ(true);
    });
  };
  const { hub, token } = await serve(t, { modules: [notifying] });
  const raw = await RawClient.open(hub.port, `?k=${token}`);
  t.after(() => raw.ws.terminate());
  await raw.handshake();
  raw.send(invocation('{"functionName":"PHL_GetConstraints","requestId":"c1","parms":null}', '0'));
  const records = [await raw.nextNonPing(), await raw.nextNonPing(), await raw.nextNonPing(), await raw.nextNonPing()];
  const payload = (r: Record<string, unknown>) => JSON.parse((r.arguments as string[])[0]) as { FunctionName: string; RequestId: string | null };
  assert.deepEqual(records.map((r) => r.target ?? `completion ${String(r.invocationId)}`), ['Notification', 'Notification', 'GetTaskAsync', 'completion 0']);
  assert.deepEqual(records.slice(0, 3).map((r) => [payload(r).FunctionName, payload(r).RequestId]), [
    ['NotifyUIDisplayFuncConstraintsChange', null],
    ['NotifyDeviceConnectionStatus', null],
    ['PHL_GetConstraints', 'c1'],
  ]);
  assert.deepEqual(records[3], { type: 3, invocationId: '0', result: null });
});

test('a hung handler does not stall the renderer: the watchdog answers it and the queued request runs next', async (t) => {
  let hungCalls = 0;
  const hanging: ApiModule = (registry) => {
    registry.register('PHL_GetConstraints', [], () => {
      hungCalls++;
      return new Promise(() => {}); // e.g. a DDC transfer that never completes
    });
  };
  const { hub, token, lines } = await serve(t, { modules: [startupApi, hanging], dispatcher: { handlerTimeoutMs: 300 } });
  const rpc = await rpcClient(t, hub.port, token);

  // Both are sent at once, so Start waits in the connection's queue behind the hung call.
  const t0 = performance.now();
  const hung = rpc.invoke('PHL_GetConstraints').then(() => 'resolved', (e: unknown) => e);
  const next = rpc.invoke('Start').then((tag) => ({ tag, at: performance.now() - t0 }));
  assert.deepEqual(await hung, { code: 9, msg: handlerTimeoutMessage('PHL_GetConstraints', 300) });
  const { tag, at } = await next;
  assert.equal(tag, true);
  assert.ok(at >= 290 && at < 3000, `the queued request ran right after the watchdog (${Math.round(at)} ms)`);
  assert.equal(hungCalls, 1);
  assert.equal(hub.connectionCount, 1);
  assert.ok(lines.some((l) => l.level === 'error' && l.scope === 'backend/rpc/PHL_GetConstraints' && l.text.startsWith('no result after 300 ms')));

  // Nothing is left running in the hub, so close() does not wait for the hung handler.
  const c0 = performance.now();
  await hub.close();
  assert.ok(performance.now() - c0 < 500, 'close() did not wait for the grace period');
});

test('service lifecycle: overlapping start()/stop() calls never interleave phases', async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const step = async (what: string) => {
    maxActive = Math.max(maxActive, ++active);
    order.push(what);
    await sleep(5);
    active--;
  };
  const svc = (name: string) => ({ start: () => step(`start:${name}`), stop: () => step(`stop:${name}`) });
  const { host: h } = host();
  const backend = createBackend({ host: h }, { services: () => lifecycleSlots({ themes: svc('themes'), monitors: svc('monitors'), ambiglow: svc('ambiglow') }) });
  const starts = ['start:themes', 'start:monitors', 'start:ambiglow'];
  const stops = ['stop:ambiglow', 'stop:monitors', 'stop:themes'];

  // stop() during start() waits for the start phase; a second stop() shares the first one
  const s1 = backend.start();
  const t1 = backend.stop();
  const t2 = backend.stop();
  assert.equal(t1, t2);
  await t2;
  assert.deepEqual(order, [...starts, ...stops], 'the second stop() resolved only after every service stopped');
  await s1;

  // start() during stop() begins only after the stop phase has finished
  await backend.start();
  order.length = 0;
  const t3 = backend.stop();
  const s2 = backend.start();
  const s3 = backend.start();
  assert.equal(s2, s3);
  await s3;
  await t3;
  assert.deepEqual(order, [...stops, ...starts]);

  // a burst of alternating calls ends in the state of the last call
  order.length = 0;
  void backend.stop();
  void backend.start();
  await backend.stop();
  assert.deepEqual(order, [...stops, ...starts, ...stops]);
  await backend.stop();
  assert.equal(order.length, 9, 'stop() on a stopped backend is a no-op');
  assert.equal(maxActive, 1, 'no two service steps ever ran at the same time');
});
