// The whole composition in mock mode (EVNIA_MOCK_MONITOR=34M2C8600): the real monitor manager with its
// simulated monitor, VIA bridge and ENE MCU, the ambiglow service bound to it (checkEne + attach), and the
// Effect_* / SyncEffect_* modules next to the monitor modules on the real dispatcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBackend } from '../../../src/backend/index.ts';
import { createMonitorManager, type MonitorManagerImpl } from '../../../src/backend/monitor/manager.ts';
import { createAmbiglowService, type AmbiglowServiceImpl } from '../../../src/backend/ambiglow/service.ts';
import { effectApi } from '../../../src/backend/api/effect.ts';
import { syncEffectApi } from '../../../src/backend/api/sync-effect.ts';
import { serialize } from '../../../src/backend/core/json.ts';
import { MONITOR_MODULES, VirtualClock, defaultProfileContent, tempHost } from '../monitor/helpers.ts';
import { FIXTURES } from '../ambiglow-ene/helpers.ts';
import { FakeCaptureHost, ManualTimers, SyncThemeStore, flush } from './helpers.ts';

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

async function compose(mockMonitor: string) {
  const temp = await tempHost();
  // The production location of the vendor table (impl-usb-ene §5 "Layout table").
  await mkdir(join(temp.host.resourcesDir, 'ENE'), { recursive: true });
  await copyFile(new URL('PCenter_AmbiglowInfo.json', FIXTURES), join(temp.host.resourcesDir, 'ENE', 'PCenter_AmbiglowInfo.json'));
  const capture = new FakeCaptureHost();
  const themes = new SyncThemeStore();
  themes.contents.set('100000|PHL 34M2C8600', defaultProfileContent());
  const timers = new ManualTimers();
  let manager: MonitorManagerImpl | null = null;
  let ambiglow: AmbiglowServiceImpl | null = null;
  const backend = createBackend(
    { host: { ...temp.host, capture, getIdleSeconds: () => 0 }, mockMonitor },
    {
      services: (core) => {
        manager = createMonitorManager(core, { themes }, { clock: new VirtualClock(), decimalSeparator: ',' });
        ambiglow = createAmbiglowService(core, { themes, monitors: manager }, { ene: { sleep: async () => undefined }, timers });
        manager.bindAmbiglow(ambiglow);
        return { themes, monitors: manager, ambiglow };
      },
      modules: [...MONITOR_MODULES, effectApi, syncEffectApi],
    },
  );
  const notifications: Array<{ FunctionName: string; Tag: any }> = [];
  backend.onNotification((json) => notifications.push(JSON.parse(json)));
  await backend.start();
  let n = 0;
  const call = async (functionName: string, parms: unknown[] | null = null) =>
    JSON.parse(await backend.handleRequest(JSON.stringify({ functionName, requestId: `c${++n}`, parms }))) as { err_code: number; err_msg: string; Tag: any };
  await manager!.scan('all');
  return {
    backend,
    manager: manager!,
    ambiglow: ambiglow!,
    capture,
    themes,
    timers,
    notifications,
    call,
    cleanup: async () => {
      await backend.stop();
      await temp.cleanup();
    },
  };
}

test('mock mode with the ENE: the first DeviceData is in ENE mode, the menu is the 34M2C8600 one, Effect_* reach the MCU', async () => {
  const c = await compose('34M2C8600');
  try {
    const data = await c.call('Profile_GetDeviceData', [100000]);
    assert.equal(data.err_code, 0);
    assert.equal(data.Tag.ENEEffectEnable, true, 'checkEne answered during the first read (method_14)');
    await c.ambiglow.settled();
    await flush();
    const hw = c.manager.mockHardware!;
    assert.equal(hw.ene.state().hostControl, 4);
    assert.equal(hw.ene.state().groups[1]?.mode, 14, 'stored FollowVideo pushed after the load');
    assert.deepEqual(c.capture.videoStarts, [300]);
    const menu = await c.call('Effect_GetMenu', [100000]);
    assert.equal(sha256(serialize(menu.Tag, 'ui')), '516cd5fad0f6938f314663ae956a79b845a816d272b7446b6bf605f77b290af2');
    const change = await c.call('Effect_Change', [100000, 6]);
    assert.equal(change.Tag.CurrEffect.Name, 'StarryNight');
    assert.equal(hw.ene.state().groups[2]?.mode, 13, 'StarryNightRainbow');
    assert.deepEqual(hw.ene.violations, []);
    assert.equal(c.capture.videoStops, 1);
    const sync = await c.call('SyncEffect_GetData');
    assert.equal(sync.Tag.SyncDevices.length, 1);
    assert.equal(sync.Tag.SyncDevices[0].ModelName, 'PHL 34M2C8600');

    // Unplug the ENE: the USB hotplug reconcile re-attaches the display without it (method_15).
    hw.usb.detach(hw.eneInfo!);
    c.backend.hotplug('usb');
    for (let i = 0; i < 50 && c.notifications.filter((x) => x.FunctionName === 'NotifyUIDisplayEffectChange').length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      await c.ambiglow.settled();
    }
    const lost = c.notifications.filter((x) => x.FunctionName === 'NotifyUIDisplayEffectChange');
    assert.equal(lost.length, 1);
    assert.equal(lost[0].Tag.ENEEnable, false);
    const after = await c.call('Profile_GetDeviceData', [100000]);
    assert.equal(after.Tag.ENEEffectEnable, false);
    const refused = await c.call('Effect_Change', [100000, 7]);
    assert.equal(refused.err_msg, 'Not Support ENE');
  } finally {
    await c.cleanup();
  }
});

test('mock mode without the ENE (the golden session): DDC Ambiglow, golden SyncEffect_GetData', async () => {
  const c = await compose('34M2C8600/no-ene');
  try {
    const data = await c.call('Profile_GetDeviceData', [100000]);
    assert.equal(data.Tag.ENEEffectEnable, false);
    await c.ambiglow.settled();
    assert.equal(c.ambiglow.ene, null);
    const sync = await c.call('SyncEffect_GetData');
    assert.deepEqual(sync.Tag.SyncDevices, []);
    assert.equal(sync.Tag.EffectDetailInfo.Effect.Name, 'Off');
    const enable = await c.call('Effect_Enable', [100000, true]);
    assert.deepEqual([enable.err_code, enable.Tag], [0, true]);
    assert.equal(c.manager.mockHardware!.monitor.control(0xe2a019)?.value, 7);
  } finally {
    await c.cleanup();
  }
});
