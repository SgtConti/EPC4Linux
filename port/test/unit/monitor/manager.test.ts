// MonitorManager + the monitor API modules in mock mode: background load / ready() semantics
// (20-backend-host-tail §7.2), USB and display hotplug (20-monitor-io §5), selection, the vendor's
// no-driver replies, Device_Rescan and the Bridge-catalog coverage of the four API modules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DdcClock } from '../../../src/backend/ddc/channel.ts';
import type { DiscoveredMonitor } from '../../../src/backend/types.ts';
import { MockDdcTransport, mockViaDeviceSpec } from '../../../src/backend/ddc/transports/mock.ts';
import { type DiscoveryOptions, discoverMonitors } from '../../../src/backend/ddc/discovery.ts';
import { RecordingRegistry } from '../../../src/backend/api/catalog.ts';
import { createBackend, type CoreServices } from '../../../src/backend/index.ts';
import { PhlDisplay } from '../../../src/backend/monitor/display.ts';
import { createMonitorManager } from '../../../src/backend/monitor/manager.ts';
import { T_PHLDisplay_Profile } from '../../../src/backend/monitor/model/profile.ts';
import { EventBus } from '../../../src/backend/core/events.ts';
import {
  MONITOR_MODULES,
  CapturingNotifier,
  FakeAmbiglow,
  FakeThemeStore,
  framesSince,
  getFrame,
  mockBackend,
  secondMonitor,
  setFrame,
  silentLog,
  tempHost,
} from './helpers.ts';

type Reply = { err_code: number; err_msg: string | null; Tag: unknown };
const parse = (s: string) => JSON.parse(s) as Reply;

/** A clock whose sleeps block until released (the load's EQ loop sleeps 100 ms per band). */
class GatedClock implements DdcClock {
  t = 0;
  #gate: Promise<void>;
  #open!: () => void;
  constructor() {
    this.#gate = new Promise((r) => (this.#open = r));
  }
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    await this.#gate;
    this.t += ms;
  }
  release(): void {
    this.#open();
  }
}

test('the scan resolves after the fast connect; Profile_GetDeviceData waits for the background load', async () => {
  const clock = new GatedClock();
  const b = await mockBackend({ clock });
  try {
    await b.manager.scan('all');
    // The connect list is available at once (EDID, SN and capabilities are known).
    assert.equal((parse(await b.call('Device_GetConnectList', null)).Tag as unknown[]).length, 1);
    const display = b.manager.current();
    assert.ok(display instanceof PhlDisplay);
    assert.equal(display.profile(), null);
    // The load is parked in the EQ loop: the request must wait for it.
    let answered = false;
    const pending = b.call('Profile_GetDeviceData', [100000]).then((r) => {
      answered = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(answered, false);
    clock.release();
    const reply = parse(await pending);
    assert.equal(reply.err_code, 0);
    assert.equal((reply.Tag as { ModelName: string }).ModelName, 'PHL 34M2C8600');
    await display.ready();
    assert.ok(display.loaded);
    // Registered with the theme store and handed to the ambiglow service after the load.
    assert.ok(b.themes.participants.has(display));
    assert.ok(b.ambiglow.attached.includes(display));
  } finally {
    clock.release();
    await b.cleanup();
  }
});

test('concurrent full scans share one run (Start + Device_Rescan racing)', async () => {
  const b = await mockBackend();
  try {
    const first = b.manager.scan('all');
    const second = b.manager.scan('all');
    assert.equal(first, second);
    await first;
    assert.equal(b.manager.displays().length, 1);
  } finally {
    await b.cleanup();
  }
});

test('USB hotplug: VIA bridge detach falls back to i2c-dev, re-attach brings USB-DDC back; ENE changes re-attach ambiglow', async () => {
  const b = await mockBackend();
  try {
    await b.manager.scan('all');
    const display = b.manager.current()!;
    await display.ready();
    const hw = b.manager.mockHardware!;
    assert.deepEqual(display.discovered.transports.map((t) => t.kind), ['via-usb', 'i2c-dev']);
    assert.equal(display.ene?.id, hw.eneInfo?.id);

    hw.usb.detach(hw.via);
    b.backend.hotplug('usb');
    await b.manager.scan('usb');
    assert.deepEqual(display.discovered.transports.map((t) => t.kind), ['i2c-dev']);
    assert.ok(display.connected);
    const r = parse(await b.call('PHL_SetOSD', ['OP_10_Luminance', 70]));
    assert.equal(r.err_code, 0);
    assert.equal(hw.monitor.control(0x10)?.value, 70);

    const via2 = hw.usb.attach(mockViaDeviceSpec(hw.monitor, { deviceAddress: 12 }));
    await b.manager.scan('usb');
    assert.deepEqual(display.discovered.transports.map((t) => t.kind), ['via-usb', 'i2c-dev']);
    assert.equal(parse(await b.call('PHL_SetOSD', ['OP_10_Luminance', 60])).err_code, 0);
    assert.equal(hw.monitor.control(0x10)?.value, 60);
    assert.equal(hw.usb.transfers.at(-1)?.deviceId, via2.id);

    const attaches = b.ambiglow.attached.length;
    hw.usb.detach(hw.eneInfo!);
    await b.manager.scan('usb');
    assert.equal(display.ene, undefined);
    assert.equal(b.ambiglow.attached.length, attaches + 1);
    assert.equal(b.ambiglow.attached.at(-1), display);

    // Nothing changed: no rediscovery, no attach.
    await b.manager.scan('usb');
    assert.equal(b.ambiglow.attached.length, attaches + 1);
  } finally {
    await b.cleanup();
  }
});

test('display hotplug: Device_DetectionDisplay removes an unplugged monitor and adds it back', async () => {
  const b = await mockBackend();
  try {
    await b.manager.scan('all');
    const status = join(b.manager.mockHardware!.sysfsRoot, 'class/drm/card1-DP-1/status');
    const first = b.manager.current()!;
    await first.ready();
    assert.ok(b.themes.participants.has(first));

    await writeFile(status, 'disconnected\n');
    assert.deepEqual(parse(await b.call('Device_DetectionDisplay', null)).Tag, []);
    assert.equal(b.manager.current(), null);
    assert.equal(b.themes.participants.has(first), false);
    assert.equal(b.ambiglow.attached.at(-1), null);
    // No driver: the vendor's `?.` null-object reply.
    assert.equal(parse(await b.call('PHL_SetOSD', ['OP_10_Luminance', 1])).err_msg, 'functionName: PHL_SetOSD  return null obj');

    await writeFile(status, 'connected\n');
    const back = parse(await b.call('Device_DetectionDisplay', null));
    assert.equal((back.Tag as unknown[]).length, 1);
    const again = b.manager.current()!;
    assert.notEqual(again, first);
    assert.equal(parse(await b.call('Profile_GetDeviceData', [100000])).err_code, 0);
  } finally {
    await b.cleanup();
  }
});

test('PHL_SwitchDisplay with an unknown serial keeps the current display and answers the vendor error', async () => {
  const b = await mockBackend();
  try {
    await b.manager.scan('all');
    const r = parse(await b.call('PHL_SwitchDisplay', ['XX0000']));
    assert.equal(r.err_msg, 'Display sn=XX0000 is not exit or not support');
    assert.equal(b.manager.current()?.key, 'AU00000000001');
    // A case variant of the current serial reconnects (the vendor compares ordinally first).
    const again = parse(await b.call('PHL_SwitchDisplay', ['au00000000001']));
    assert.equal(again.err_code, 0);
  } finally {
    await b.cleanup();
  }
});

test('Device_Rescan empties and refills the capability cache (CacheVcpMgr.Reset)', async () => {
  const b = await mockBackend();
  try {
    const cache = join(b.temp.host.serveDataDir, 'Config', 'data.json');
    await b.manager.scan('all');
    assert.ok(existsSync(cache));
    const reply = parse(await b.call('Device_Rescan', null));
    assert.equal((reply.Tag as unknown[]).length, 1);
    assert.ok(existsSync(cache));
    assert.equal(b.manager.current()?.capabilities.startsWith('(prot(monitor)type(LCD)model(34M2C8600MV)'), true);
  } finally {
    await b.cleanup();
  }
});

test('Profile_Reset over RPC and Profile_* for other device types', async () => {
  const b = await mockBackend();
  try {
    await b.manager.scan('all');
    const reset = parse(await b.call('Profile_Reset', [100000]));
    assert.equal(reset.err_code, 0);
    assert.equal((reset.Tag as { DeviceType: number }).DeviceType, 100000);
    assert.equal(parse(await b.call('Profile_GetDeviceData', [200000])).err_msg, 'functionName: Profile_GetDeviceData  return null obj');
    assert.equal(parse(await b.call('Profile_Reset', [300000])).err_msg, 'functionName: Profile_Reset  return null obj');
    assert.equal(parse(await b.call('Profile_GetBoard', [100000])).err_msg, 'functionName: Profile_GetBoard  return null obj');
    assert.equal(parse(await b.call('Profile_ApplyOnboard', [100000, 1, '', 'Default'])).err_msg, 'ThemeSwitch themeName is null');
    assert.equal(parse(await b.call('Profile_ApplyOnboard', [100000, 1, 'User', ''])).err_msg, 'ThemeSwitch profileName is null');
    assert.equal(parse(await b.call('Profile_ApplyOnboard', [100000, 1, 'User', 'Default'])).err_msg, 'functionName: Profile_ApplyOnboard  return null obj');
    assert.equal(parse(await b.call('Device_GetDeviceInfo', [100000])).err_code, 0);
    assert.equal(parse(await b.call('Device_GetDeviceInfo', [200000])).err_msg, 'No driver found!');
    assert.equal(parse(await b.call('Device_UpgradeFw', [100000, '/tmp/x.bin'])).err_msg, 'No driver found!');
  } finally {
    await b.cleanup();
  }
});

test('stub replies: hotkeys, GamePQ, DisplayFW_* and the one-argument PHL_SetOSD', async () => {
  const b = await mockBackend();
  try {
    await b.manager.scan('all');
    const raw = (s: string) => JSON.parse(s) as Record<string, unknown>;
    assert.deepEqual(raw(await b.call('PHL_GetHotKeyMenu', null)).Tag, []);
    assert.equal(raw(await b.call('PHL_GetHotKeyData', null)).Tag, null);
    assert.equal(raw(await b.call('PHL_SetHotKey', ['Brightness', 65, false, true, false, false, false])).err_code, 0);
    assert.equal((raw(await b.call('SetGamePQ', [1, true, true, false, false, false, false, false])).Tag as Record<string, unknown>).EXT_OP_E2A0_40_AdaptiveSync !== undefined, true);
    assert.equal(raw(await b.call('PHL_SetOSD', ['OP_F6_PIPPBPSwap'])).err_msg, 'not supported');
    assert.equal(raw(await b.call('PHL_ProfileAction', [1, 0])).err_msg, 'EXT_OP_E2A0_6B_Profile Unavailable');

    const cable = raw(await b.call('DisplayFW_CheckUpstreamCable', null));
    assert.deepEqual([cable.err_code, cable.err_msg, cable.Tag], [0, null, true]);
    const count = raw(await b.call('DisplayFW_GetMonitorCount', null));
    assert.deepEqual([count.err_msg, count.Tag], [null, 1]);
    const list = raw(await b.call('DisplayFW_GetDeviceList', null, '1b8c40f7-f55f-44f7-abb8-57c86bc286c9'));
    // 20-backend-host-tail §5 step 4 R(port).
    assert.equal(JSON.stringify(list), '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"1b8c40f7-f55f-44f7-abb8-57c86bc286c9","Tag":[],"FunctionName":"DisplayFW_GetDeviceList","CurrItem":null}');
    assert.equal(raw(await b.call('DisplayFW_UpdateFirmversion', ['34M2C8600', 1, '/tmp/fw.zip'])).err_msg, 'firmware update not supported');
    assert.equal(raw(await b.call('DisplayFW_FWUpdateFailedNextTime', [1])).err_msg, 'firmware update not supported');
    const driver = raw(await b.call('DisplayFW_InstallDriver', ['via', '/tmp/x']));
    assert.deepEqual([driver.err_code, driver.err_msg, driver.Tag], [0, null, null]);
    // A wrong argument type gets the vendor's "params error" with both overloads in Bridge order.
    assert.equal(
      raw(await b.call('PHL_SetOSD', ['OP_10_Luminance', '1'])).err_msg,
      'params error: Zeasn.Com.Lib.JsonResult PHL_SetOSD(System.String) | Zeasn.Com.Lib.JsonResult PHL_SetOSD(System.String, Int32)',
    );
  } finally {
    await b.cleanup();
  }
});

test('without hardware: empty list, no-driver replies, "Display unconnected"', async () => {
  const temp = await tempHost();
  const themes = new FakeThemeStore();
  const backend = createBackend(
    { host: temp.host, noHardware: true },
    { services: (core) => ({ themes, monitors: createMonitorManager(core, { themes }) }), modules: MONITOR_MODULES },
  );
  try {
    await backend.start();
    const call = async (functionName: string, parms: unknown[] | null) => parse(await backend.handleRequest(JSON.stringify({ functionName, requestId: 'x', parms })));
    assert.deepEqual((await call('Device_Rescan', null)).Tag, []);
    assert.deepEqual((await call('Device_GetConnectList', null)).Tag, []);
    assert.equal((await call('PHL_ReloadData', null)).err_msg, 'functionName: PHL_ReloadData  return null obj');
    assert.equal((await call('PHL_SwitchDisplay', ['AU00000000001'])).err_msg, 'functionName: PHL_SwitchDisplay  return null obj');
    assert.equal((await call('Profile_GetDeviceData', [100000])).err_msg, 'functionName: Profile_GetDeviceData  return null obj');
    assert.equal((await call('PHL_Rescan', null)).err_msg, 'Display unconnected');
    assert.equal((await call('Device_GetDeviceInfo', [100000])).err_msg, 'No driver found!');
    assert.equal((await call('DisplayFW_GetMonitorCount', null)).Tag, 0);
  } finally {
    await backend.stop();
    await temp.cleanup();
  }
});

test('the four API modules register exactly the monitor-owned Bridge overloads (catalog audit)', () => {
  const registry = new RecordingRegistry();
  const core: CoreServices = {
    log: silentLog,
    notifier: new CapturingNotifier(),
    host: { log: silentLog, serveDataDir: '/nonexistent', appDataDir: '/nonexistent', resourcesDir: '/nonexistent' },
    events: new EventBus(),
    options: { host: { log: silentLog, serveDataDir: '/nonexistent', appDataDir: '/nonexistent', resourcesDir: '/nonexistent' }, noHardware: true },
  };
  for (const register of MONITOR_MODULES) register(registry, core);
  const audit = registry.audit({ owners: ['monitor'] });
  assert.deepEqual(audit.missing.map((b) => b.name), []);
  assert.deepEqual(audit.extra, []);
  assert.deepEqual(audit.duplicates, []);
  assert.ok(audit.ok);
});

test('mock variant without ENE, and late binding of the ambiglow service', async () => {
  const b = await mockBackend({ manager: { mockEne: false } });
  try {
    await b.manager.scan('all');
    const display = b.manager.current()!;
    await display.ready();
    assert.equal(b.manager.mockHardware?.eneInfo, null);
    assert.equal(display.ene, undefined);
    const late = new FakeAmbiglow();
    b.manager.bindAmbiglow(late);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(late.attached, [display]);
  } finally {
    await b.cleanup();
  }
});

// ───────────────────────────── current display only (GClass3: one driver for CurDisplay) ─────────────────────────────

type ExtInfo = { CurSN: string; DisplayList: Array<{ DisplaySN: string; DeviceName: string; MonitorName: string }> };

test('two Philips monitors: both listed, only the current one is loaded and a theme participant; PHL_SwitchDisplay moves it', async () => {
  const second = secondMonitor('AU00000009999');
  // Fresh transports per discovery run (a rebind closes the previous ones).
  const discover = async (o: DiscoveryOptions): Promise<DiscoveredMonitor[]> => [
    ...(await discoverMonitors(o)),
    { ...second.discovered, transports: [new MockDdcTransport(second.monitor, 'mock:AU00000009999')] },
  ];
  const b = await mockBackend({ manager: { discover } });
  try {
    await b.manager.scan('all');
    const [first, other] = b.manager.displays();
    assert.equal(b.manager.current(), first);
    assert.equal(first.key, 'AU00000000001');
    assert.equal(other.key, 'AU00000009999');
    await first.ready();

    const info = async (): Promise<ExtInfo> => (parse(await b.call('Device_GetConnectList', null)).Tag as Array<{ ExtDeviceInfo: ExtInfo }>)[0].ExtDeviceInfo;
    let ext = await info();
    assert.equal(ext.CurSN, 'AU00000000001');
    assert.deepEqual(ext.DisplayList.map((d) => [d.DisplaySN, d.DeviceName, d.MonitorName]), [
      ['AU00000000001', 'DP-1', 'PHL 34M2C8600'],
      ['AU00000009999', 'DP-2', 'PHL 34M2C8600'],
    ]);
    assert.equal(parse(await b.call('DisplayFW_GetMonitorCount', null)).Tag, 2);

    // The other monitor is only probed (capability string), never read: no DC read, no data, no participant.
    assert.ok(other.connected);
    assert.equal(other.profile(), null);
    assert.equal(framesSince(second.monitor.frames, 0).includes(getFrame(0xdc)), false);
    assert.deepEqual([...b.themes.participants], [first]);
    assert.deepEqual(b.ambiglow.attached, [first]);

    // PHL_SwitchDisplay: OnConnect of the other SN (full load), which becomes the only participant.
    const sw = parse(await b.call('PHL_SwitchDisplay', ['AU00000009999']));
    assert.equal(sw.err_code, 0);
    assert.equal((sw.Tag as { ModelName: string }).ModelName, 'PHL 34M2C8600');
    assert.equal(b.manager.current(), other);
    assert.ok(other.profile());
    assert.ok(framesSince(second.monitor.frames, 0).includes(getFrame(0xdc)));
    assert.deepEqual([...b.themes.participants], [other]);
    assert.equal(b.ambiglow.attached.at(-1), other);
    ext = await info();
    assert.equal(ext.CurSN, 'AU00000009999');

    // A factory reset / theme switch reaches the current monitor only.
    const hw = b.manager.mockHardware!;
    const f1 = hw.monitor.frames.length;
    const f2 = second.monitor.frames.length;
    for (const p of b.themes.participants) await p.resetToFactory();
    assert.equal(framesSince(hw.monitor.frames, f1).includes(setFrame(0x04, 1)), false);
    assert.ok(framesSince(second.monitor.frames, f2).includes(setFrame(0x04, 1)));

    // A rescan keeps the selected SN current (GClass3.ConnectionCkecked lastSN).
    await b.manager.scan('all');
    assert.equal(b.manager.current(), other);
    assert.deepEqual([...b.themes.participants], [other]);
    await other.ready();

    // And back.
    assert.equal(parse(await b.call('PHL_SwitchDisplay', ['AU00000000001'])).err_code, 0);
    assert.equal(b.manager.current(), first);
    assert.deepEqual([...b.themes.participants], [first]);
  } finally {
    await b.cleanup();
  }
});

test('ENE present at start: checkEne makes the first Profile_GetDeviceData report ENE mode (20-backend-host-tail §6 item 4)', async () => {
  const ambiglow = new FakeAmbiglow({ eneModel: '34M2C8600' });
  const b = await mockBackend({ ambiglow });
  try {
    await b.manager.scan('all');
    const display = b.manager.current()!;
    const reply = parse(await b.call('Profile_GetDeviceData', [100000]));
    type Tag = { ENEEffectEnable: boolean; EffectInfo: { CurrEffect: { Name: string } }; ModuleAmbiglow: { EXT_OP_E2A0_19_AmbiglowLightMode: { Value: number } } };
    const tag = reply.Tag as Tag;
    assert.equal(tag.ENEEffectEnable, true);
    assert.equal(tag.EffectInfo.CurrEffect.Name, 'FollowVideo');
    // With the ENE in use method_4 leaves the DDC Ambiglow state as read (no Off → Static fix-up).
    assert.equal(tag.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value, 0);
    assert.deepEqual(ambiglow.checked, [display]);
    assert.equal(b.notifications.some((n) => n.includes('NotifyUIDisplayEffectChange')), false);
  } finally {
    await b.cleanup();
  }
});

test('the no-ENE mock answers checkEne with "" (the golden session: ENE absent)', async () => {
  const ambiglow = new FakeAmbiglow({ eneModel: '34M2C8600' });
  const b = await mockBackend({ ambiglow, manager: { mockEne: false } });
  try {
    await b.manager.scan('all');
    assert.equal((parse(await b.call('Profile_GetDeviceData', [100000])).Tag as { ENEEffectEnable: boolean }).ENEEffectEnable, false);
    assert.equal(ambiglow.checked.length, 1);
  } finally {
    await b.cleanup();
  }
});

test('a theme switch during the background first load is applied after it; the load does not save over the target profile', async () => {
  const clock = new GatedClock();
  const b = await mockBackend({ clock });
  try {
    await b.manager.scan('all');
    const display = b.manager.current() as PhlDisplay;
    assert.equal(display.profile(), null);
    // Registered right after the fast connect, so smethod_20 reaches it.
    assert.ok(b.themes.participants.has(display));
    // Before its load the display purifies to the stored section (nothing is lost if the store saves now).
    const key = '100000|PHL 34M2C8600';
    assert.equal(display.purify(), b.themes.contents.get(key));

    const p = T_PHLDisplay_Profile.parse(b.themes.contents.get(key));
    assert.ok(p);
    p.ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value = 60;
    p.ModuleAmbiglow.EffectEnable = true;
    p.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value = 3;
    const target = p.purify();
    // Theme_Switch: the store's current profile changes, then every participant gets its section.
    b.themes.contents.set(key, target);
    const applied = [...b.themes.participants].map((x) => x.applyProfileContent(target));
    const hw = b.manager.mockHardware!;
    clock.release();
    await Promise.all(applied);

    assert.deepEqual(framesSince(hw.monitor.frames, 0).slice(-3), [setFrame(0x10, 60), setFrame(0x12, 50), setFrame(0xe2a019, 3)]);
    assert.equal(hw.monitor.control(0x10)?.value, 60);
    const data = display.profile();
    assert.ok(data);
    assert.equal(data.ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value, 60);
    assert.equal(data.ModuleAmbiglow.EffectEnable, true);
    // The load read the target section but left saving to the switch (the store saves after applying).
    assert.equal(b.themes.saves, 0);
    assert.equal(b.themes.contents.get(key), target);
  } finally {
    clock.release();
    await b.cleanup();
  }
});

test('Theme_ResetCurProfile / FactoryReset during the background first load still resets the monitor (VCP 0x04)', async () => {
  const clock = new GatedClock();
  const b = await mockBackend({ clock });
  try {
    await b.manager.scan('all');
    const display = b.manager.current() as PhlDisplay;
    const hw = b.manager.mockHardware!;
    const resets = [...b.themes.participants].map((x) => x.resetToFactory());
    assert.equal(resets.length, 1);
    clock.release();
    await Promise.all(resets);
    assert.ok(framesSince(hw.monitor.frames, 0).includes(setFrame(0x04, 1)));
    assert.equal(display.profile()?.ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value, 100);
  } finally {
    clock.release();
    await b.cleanup();
  }
});

// ───────────────────────────── USB reconcile and discovery failures ─────────────────────────────

/** Discovery that can fail on demand or report the monitors without any transport. */
function flakyDiscovery(): { discover: (o: DiscoveryOptions) => Promise<DiscoveredMonitor[]>; state: { fail: number; strip: boolean; calls: number } } {
  const state = { fail: 0, strip: false, calls: 0 };
  const discover = async (o: DiscoveryOptions): Promise<DiscoveredMonitor[]> => {
    state.calls++;
    if (state.fail > 0) {
      state.fail--;
      throw new Error('sysfs: Resource temporarily unavailable');
    }
    const found = await discoverMonitors(o);
    if (!state.strip) return found;
    for (const m of found) for (const t of m.transports) await t.close();
    return found.map((m) => ({ ...m, transports: [] }));
  };
  return { discover, state };
}

test('USB change: a current display left without any transport is disconnected, unregistered and ambiglow detached; it comes back', async () => {
  const { discover, state } = flakyDiscovery();
  const b = await mockBackend({ manager: { discover } });
  try {
    await b.manager.scan('all');
    const display = b.manager.current() as PhlDisplay;
    await display.ready();
    assert.equal(b.ambiglow.attached.at(-1), display);
    const hw = b.manager.mockHardware!;

    state.strip = true;
    hw.usb.detach(hw.via);
    await b.manager.scan('usb');
    assert.equal(display.connected, false);
    assert.equal(b.ambiglow.attached.at(-1), null);
    assert.equal(b.themes.participants.size, 0);
    assert.deepEqual(parse(await b.call('Device_GetConnectList', null)).Tag, []);
    assert.equal(parse(await b.call('PHL_SetOSD', ['OP_10_Luminance', 1])).err_msg, 'functionName: PHL_SetOSD  return null obj');

    state.strip = false;
    hw.usb.attach(mockViaDeviceSpec(hw.monitor, { deviceAddress: 14 }));
    await b.manager.scan('usb');
    assert.ok(display.connected);
    assert.equal(b.manager.current(), display);
    assert.ok(b.themes.participants.has(display));
    await display.ready();
    assert.equal(b.ambiglow.attached.at(-1), display);
    assert.equal(parse(await b.call('PHL_SetOSD', ['OP_10_Luminance', 42])).err_code, 0);
    assert.equal(hw.monitor.control(0x10)?.value, 42);
  } finally {
    await b.cleanup();
  }
});

test('USB change: a failed discovery does not consume the change, the next reconcile retries it', async () => {
  const { discover, state } = flakyDiscovery();
  const b = await mockBackend({ manager: { discover } });
  try {
    await b.manager.scan('all');
    const display = b.manager.current()!;
    await display.ready();
    const hw = b.manager.mockHardware!;
    assert.ok(display.ene);

    state.fail = 1;
    hw.usb.detach(hw.eneInfo!);
    await b.manager.scan('usb');
    assert.equal(state.calls, 2);
    assert.ok(display.ene, 'unchanged after the failed discovery');

    const attaches = b.ambiglow.attached.length;
    await b.manager.scan('usb');
    assert.equal(state.calls, 3);
    assert.equal(display.ene, undefined);
    assert.equal(b.ambiglow.attached.length, attaches + 1);
  } finally {
    await b.cleanup();
  }
});

test('a full scan whose discovery fails keeps the known displays (no dispose, no unregister)', async () => {
  const { discover, state } = flakyDiscovery();
  const b = await mockBackend({ manager: { discover } });
  try {
    await b.manager.scan('all');
    const display = b.manager.current() as PhlDisplay;
    await display.ready();
    state.fail = 1;
    const reply = parse(await b.call('Device_Rescan', null));
    assert.equal((reply.Tag as unknown[]).length, 1);
    assert.equal(b.manager.current(), display);
    assert.ok(display.connected);
    assert.ok(b.themes.participants.has(display));
    assert.equal(parse(await b.call('PHL_SetOSD', ['OP_10_Luminance', 33])).err_code, 0);
    assert.equal(b.manager.mockHardware!.monitor.control(0x10)?.value, 33);
  } finally {
    await b.cleanup();
  }
});
