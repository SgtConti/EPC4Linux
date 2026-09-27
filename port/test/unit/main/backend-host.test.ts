// startupBackendService (src/main/backend-host.ts) over the PRODUCTION composition, the way Electron main
// builds it: createDefaultBackend with main's HostServices (host-services.ts), EVNIA_MOCK_MONITOR → the
// simulated monitor with noHardware, the shared USB backend on real hardware, one PATH_APP_TEMP for the
// theme store and local:, and the loopback hub (token, Origin file:// only). Plus the start/stop/retry
// sequencing with a stand-in backend.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import WebSocket from 'ws';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { generateHubToken, type DefaultBackend } from '../../../src/backend/index.ts';
import type { CaptureHost, UsbBackend } from '../../../src/backend/types.ts';
import { MOCK_SERIAL } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { BackendHost, backendConfiguration, mockMonitorFromEnv } from '../../../src/main/backend-host.ts';
import { X11ForegroundTracker } from '../../../src/main/foreground-app.ts';
import { PathGuard } from '../../../src/main/fs-guard.ts';
import { createHostServices } from '../../../src/main/host-services.ts';
import { IdleTimeSource } from '../../../src/main/idle-time.ts';
import { resolveAppPaths } from '../../../src/main/paths.ts';
import { USER_MONITOR_SERIAL } from '../../fixtures/user-monitor.ts';

const log = createLogger('test', silentSink);
const VENDOR_DATA = fileURLToPath(new URL('../../../build/vendor-data/', import.meta.url));
const WINDOWS_FIXTURES = fileURLToPath(new URL('../../fixtures/windows/', import.meta.url));
const noVendorData = existsSync(join(VENDOR_DATA, 'PCenter_DeviceInfo.json')) ? false : 'build/vendor-data missing (npm run import-ui)';
const dir = mkdtempSync(join(tmpdir(), 'evnia-backend-host-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const capture: CaptureHost = { startVideo: async () => false, stopVideo: () => {}, startAudio: async () => false, stopAudio: () => {} };

function mainHost(root: string, guard?: PathGuard) {
  const paths = { ...resolveAppPaths('/opt/evnia/resources/app.asar', join(root, 'config'), join(root, 'run')), resourcesDir: VENDOR_DATA };
  const foreground = new X11ForegroundTracker({ log, env: {}, selfExe: '/opt/evnia/evnia' });
  const idle = new IdleTimeSource({ log, electronIdleSeconds: () => 0, mutter: false, run: async () => ({ ok: false, stdout: '' }) });
  // As in index.ts: nodeApi's guard, which also answers the backend's path policy.
  guard ??= new PathGuard({ readRoots: [paths.userData, paths.serveDataDir, paths.resourcesDir], scratchDir: paths.userData });
  return createHostServices({ log, paths, capture, foreground, idle, displayModes: null, guard });
}

test('EVNIA_MOCK_MONITOR selects the simulated monitor without hardware; real hardware shares main\'s USB backend', () => {
  assert.equal(mockMonitorFromEnv({}), undefined);
  assert.equal(mockMonitorFromEnv({ EVNIA_MOCK_MONITOR: ' ' }), undefined);
  assert.equal(mockMonitorFromEnv({ EVNIA_MOCK_MONITOR: '34M2C8600/no-ene' }), '34M2C8600/no-ene');
  const host = mainHost(dir);
  const usb = { list: async () => [], open: async () => assert.fail(), onChange: () => () => {} } as UsbBackend;
  assert.deepEqual(backendConfiguration({ host, usb, appTempDir: '/run/user/1000/EvniaServe' }), {
    options: { host, usb },
    overrides: { themes: { appTempDir: '/run/user/1000/EvniaServe' } },
  });
  assert.deepEqual(backendConfiguration({ host, usb, mockMonitor: '34M2C8600' }), {
    options: { host, mockMonitor: '34M2C8600', noHardware: true },
    overrides: {},
  });
});

test('main host services: the simulated monitor reports the user\'s mode; foreground and idle come from main', () => {
  const host = mainHost(dir);
  assert.deepEqual(host.getDisplayMode?.({ key: 'AU00000000001', edid: null, transports: [] }), { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });
  assert.equal(host.getIdleSeconds?.(), 0);
  assert.equal(host.getForegroundAppPath?.(), null, 'no X11 session');
  assert.equal(host.getForegroundApp(), null);
  assert.equal(host.resourcesDir, VENDOR_DATA);
  assert.match(host.serveDataDir, /config\/EvniaServe$/);
  assert.match(host.appDataDir, /config\/evnia$/);
});

test('startupBackendService: the production backend with the simulated 34M2C8600 behind the token hub', { skip: noVendorData, timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(dir, 'prod-'));
  const appTempDir = join(root, 'run', 'EvniaServe');
  const token = generateHubToken();
  const paths = resolveAppPaths('/opt/evnia/resources/app.asar', join(root, 'config'), join(root, 'run'));
  const guard = new PathGuard({ readRoots: [paths.userData, paths.serveDataDir, VENDOR_DATA], scratchDir: paths.userData });
  // The user's Windows themes (a profile with content, so an export has something to write).
  cpSync(join(WINDOWS_FIXTURES, 'EvniaServe', 'Theme'), join(paths.serveDataDir, 'Theme'), { recursive: true });
  const bh = new BackendHost({ host: mainHost(root, guard), log, token, mockMonitor: '34M2C8600/no-ene', appTempDir });
  try {
    const port = await bh.ensureStarted();
    assert.ok(port > 0);
    assert.equal(await bh.ensureStarted(), port, 'the renderer\'s re-invocation gets the same port');
    assert.equal(bh.port, port);
    const backend = bh.backend!;
    assert.equal(backend.services.themes.paths.appTemp, appTempDir, 'Comm_GenAppIcon writes where local: serves');
    const call = async (functionName: string, parms: unknown[] | null = null) => backend.handleRequest(JSON.stringify({ functionName, requestId: functionName, parms }));
    assert.equal((JSON.parse(await call('Start')) as { IsSucc: boolean }).IsSucc, true);
    const list = await call('Device_GetConnectList');
    assert.ok(list.includes(MOCK_SERIAL), 'the simulated monitor is listed (Home shows its card)');
    assert.ok(!list.includes(USER_MONITOR_SERIAL), 'the product\'s mock carries no serial of the user\'s unit');
    // The hub's file arguments follow main's path policy (fs-guard.ts backendMayAccess): an export goes only
    // to the path just chosen in the save dialog, once; an import only from a picked file.
    const home = mkdtempSync(join(root, 'home-'));
    const target = join(home, '.bashrc');
    const tag = (r: string) => JSON.parse(r) as { err_code: number; err_msg: string };
    assert.deepEqual(tag(await call('Theme_ExportProfile', ['User', 'Default', target])).err_msg, 'ThemeExportProfile SaveTXTConfig Error');
    assert.equal(existsSync(target), false, 'nothing written where the user did not choose');
    const chosen = join(home, 'Racing.pcenter');
    guard.grantWrite(chosen);
    assert.equal(tag(await call('Theme_ExportProfile', ['User', 'Default', chosen])).err_code, 0);
    assert.equal(existsSync(chosen), true);
    assert.equal(tag(await call('Theme_ExportProfile', ['User', 'Default', chosen])).err_code, 9, 'the grant is used up');
    assert.deepEqual(
      tag(await call('Theme_ImportProfile', ['User', chosen, false])),
      { ...tag(await call('Theme_ImportProfile', ['User', join(home, 'missing'), false])), err_msg: `ThemeImportProfile Error FilePath=${chosen} Not Exist` },
      'an unpicked file reads as missing (code 8, the vendor text)',
    );
    guard.allowChosen(chosen);
    assert.equal(tag(await call('Theme_ImportProfile', ['User', chosen, false])).err_code, 0, 'a picked file imports');
    const data = await call('Profile_GetDeviceData', [100000]);
    assert.equal((JSON.parse(data) as { IsSucc: boolean }).IsSucc, true, data.slice(0, 300));
    assert.match(data, /\\?"MonitorResolution\\?":\\?"3440x1440\\?"/, 'getDisplayMode reached the driver');
    assert.match(data, /\\?"MonitorFrequency\\?":\\?"175Hz\\?"/);
    // the hub: loopback, per-launch token, Origin file:// only (impl-integration §2.4)
    const connect = (url: string, origin?: string) =>
      new Promise<number | 'open'>((resolve) => {
        const ws = new WebSocket(url, origin ? { origin } : {});
        ws.on('open', () => {
          ws.close();
          resolve('open');
        });
        ws.on('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
        ws.on('error', () => resolve(0));
      });
    const base = `ws://127.0.0.1:${port}/EvniaHub`;
    assert.equal(await connect(`${base}?k=${token}`, 'file://'), 'open');
    assert.notEqual(await connect(base, 'file://'), 'open', 'no token');
    assert.notEqual(await connect(`${base}?k=${token}`, 'null'), 'open', 'opaque origin');
    assert.notEqual(await connect(`${base}?k=${token}`, 'https://example.com'), 'open');
  } finally {
    await bh.stop();
  }
  assert.equal(bh.port, null);
});

function fakeBackend(start: () => Promise<void> = async () => {}): DefaultBackend & { stops: number } {
  const b = {
    stops: 0,
    services: {} as DefaultBackend['services'],
    handleRequest: async () => '{}',
    onNotification: () => () => {},
    hotplug: () => {},
    start,
    stop: async () => {
      b.stops++;
    },
  };
  return b;
}

test('a failed start resolves -1 and is retried by the next call', async () => {
  let attempts = 0;
  const backend = fakeBackend();
  const bh = new BackendHost({
    host: mainHost(dir),
    log,
    token: generateHubToken(),
    createBackend: () => {
      attempts++;
      if (attempts === 1) throw new Error('no resources');
      return backend;
    },
  });
  assert.equal(await bh.ensureStarted(), -1);
  const port = await bh.ensureStarted();
  assert.ok(port > 0);
  assert.equal(attempts, 2);
  await bh.stop();
  assert.equal(backend.stops, 1);
});

test('stop() during the start waits for it and stops the backend; no hub is left listening', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const backend = fakeBackend(() => gate);
  const bh = new BackendHost({ host: mainHost(dir), log, token: generateHubToken(), createBackend: () => backend });
  const started = bh.ensureStarted();
  const stopped = bh.stop();
  release();
  assert.equal(await started, -1);
  await stopped;
  assert.equal(backend.stops, 1);
  assert.equal(bh.port, null);
  assert.equal(await bh.ensureStarted(), -1, 'no restart after stop');
});
