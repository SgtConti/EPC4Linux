// The e2e walkthrough's probe of the simulated hardware (src/main/mock-probe.ts; mock mode only): snapshot of
// the monitor's controls and received Set VCP frames, the ENE registers, OSD-side changes, the simulated idle
// time, and monitor unplug/replug with the host events main raises for them.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MockEneDevice } from '../../../src/backend/ambiglow/mock-ene.ts';
import { buildDdcMessage, setExtPayload, setVcpPayload } from '../../../src/backend/ddc/codec.ts';
import { createMock34M2C8600, DEFAULT_MOCK_SYSFS, writeMockSysfs } from '../../../src/backend/ddc/transports/mock.ts';
import type { DefaultBackend } from '../../../src/backend/index.ts';
import type { MockHardware } from '../../../src/backend/monitor/manager.ts';
import type { DeviceEventName } from '../../../src/main/device-events.ts';
import { createMockProbe, decodeSetVcp, installMockProbe, MOCK_PROBE_KEY } from '../../../src/main/mock-probe.ts';

async function hardware(withEne = true): Promise<MockHardware & { cleanup(): Promise<void> }> {
  const bundle = await createMock34M2C8600({ transports: [] });
  const ene = new MockEneDevice();
  const eneInfo = withEne ? bundle.usb.attach(ene.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 9 })) : null;
  const sysfsRoot = await mkdtemp(join(tmpdir(), 'evnia-probe-'));
  await writeMockSysfs(sysfsRoot, bundle.monitor, DEFAULT_MOCK_SYSFS, [bundle.viaInfo]);
  return { monitor: bundle.monitor, usb: bundle.usb, via: bundle.viaInfo, ene, eneInfo, sysfsRoot, cleanup: () => rm(sysfsRoot, { recursive: true, force: true }) };
}

/** A DefaultBackend stand-in: the probe only reads services.monitors.mockHardware. */
const backendOf = (hw: MockHardware | null) => () => ({ services: { monitors: { mockHardware: hw } } }) as unknown as DefaultBackend;

test('decodeSetVcp: standard and TPV extended Set VCP frames, nothing else', () => {
  assert.deepEqual(decodeSetVcp(buildDdcMessage(setVcpPayload(0x10, 60))), [0x10, 60]);
  assert.deepEqual(decodeSetVcp(buildDdcMessage(setExtPayload(0x19, 4))), [0xe2a019, 4]);
  assert.equal(decodeSetVcp(buildDdcMessage([0x01, 0x10])), null, 'Get VCP');
  assert.equal(decodeSetVcp(new Uint8Array(0)), null);
});

test('snapshot: controls, the host writes in order, the ENE registers; null before the backend exists', async () => {
  assert.equal(createMockProbe(() => null).snapshot(), null);
  const hw = await hardware();
  try {
    const probe = createMockProbe(backendOf(hw));
    const before = probe.snapshot()!;
    assert.equal(before.model, '34M2C8600');
    assert.equal(before.vcp[0xdc], 33, 'seeded HDR Game');
    assert.deepEqual(before.writes, []);
    assert.equal(before.ene?.hostControl, 0);
    hw.monitor.receive(buildDdcMessage(setVcpPayload(0x10, 42)));
    hw.monitor.receive(buildDdcMessage(setExtPayload(0x19, 4)));
    const after = probe.snapshot()!;
    assert.deepEqual(after.writes, [[0x10, 42], [0xe2a019, 4]]);
    assert.equal(after.vcp[0x10], 42);
    assert.ok(Array.isArray(after.ene?.frame) && after.ene.frame.length === 3 * hw.ene.frameLeds, 'JSON-safe frame buffer');
    assert.deepEqual(after.ene?.violations, []);
    assert.deepEqual(after.ene?.frameWrites, { count: 0, recent: [] }, 'no frame uploaded yet');
    // Frame-buffer writes as the MCU received them (the "Fast LED upload" steps: six segments or one burst).
    const out = (reg: number, length: number) =>
      hw.ene.controlOut({ bmRequestType: 0x40, bRequest: 0x80, wValue: 0, wIndex: reg }, new Uint8Array(length));
    out(0xe300, 9);
    out(0xe300, 138);
    assert.deepEqual(probe.snapshot()!.ene?.frameWrites, { count: 2, recent: [[0xe300, 9], [0xe300, 138]] });
    assert.deepEqual(JSON.parse(JSON.stringify(probe.snapshot()!.ene?.frameWrites)), { count: 2, recent: [[0xe300, 9], [0xe300, 138]] }, 'JSON-safe');
    // a change on the monitor itself: applied, but not a host write
    assert.equal(probe.osdSet(0xdc, 0), true);
    assert.equal(probe.snapshot()!.vcp[0xdc], 0);
    assert.equal(probe.snapshot()!.writes.length, 2);
    assert.equal(probe.osdSet(0x99, 1), false, 'no such control');
  } finally {
    await hw.cleanup();
  }
});

test('capture: what the backend asked of main\'s capture host (sessions, retunes, interval), a copy per snapshot; null without the hook', async () => {
  const hw = await hardware();
  try {
    assert.equal(createMockProbe(backendOf(hw)).snapshot()!.capture, null);
    const stats = { starts: 1, retunes: 0, intervalMs: 100 as number | null };
    const probe = createMockProbe(backendOf(hw), { capture: () => stats });
    const before = probe.snapshot()!;
    assert.deepEqual(before.capture, { starts: 1, retunes: 0, intervalMs: 100 });
    stats.retunes = 1;
    stats.intervalMs = 40; // Follow video High, same session
    assert.deepEqual(probe.snapshot()!.capture, { starts: 1, retunes: 1, intervalMs: 40 });
    assert.deepEqual(before.capture, { starts: 1, retunes: 0, intervalMs: 100 }, 'snapshots are copies');
    assert.deepEqual(JSON.parse(JSON.stringify(probe.snapshot())).capture, { starts: 1, retunes: 1, intervalMs: 40 }, 'JSON-safe');
  } finally {
    await hw.cleanup();
  }
});

test('simulated idle time: overrides the real source until reset with null', () => {
  const probe = createMockProbe(() => null);
  assert.equal(probe.idleSeconds(() => 7), 7);
  probe.setIdleSeconds(301.9);
  assert.equal(probe.idleSeconds(() => 7), 301);
  probe.setIdleSeconds(-5);
  assert.equal(probe.idleSeconds(() => 7), 0);
  probe.setIdleSeconds(null);
  assert.equal(probe.idleSeconds(() => 7), 7);
});

test('unplug/replug: connector status, the VIA bridge and the ENE leave and return, host events raised', async () => {
  const hw = await hardware();
  const events: DeviceEventName[] = [];
  try {
    const probe = createMockProbe(backendOf(hw), { deviceEvent: (name) => events.push(name) });
    const status = join(hw.sysfsRoot, 'class/drm/card1-DP-1/status');
    const ids = async () => (await hw.usb.list()).map((d) => `${d.id}@${d.deviceAddress}`).sort();
    assert.deepEqual(await ids(), ['usb:3-2.1@9', 'usb:3-2.4@7']);
    assert.equal(await probe.unplugMonitor(), true);
    assert.equal(await readFile(status, 'utf8'), 'disconnected\n');
    assert.deepEqual(await ids(), []);
    assert.deepEqual(events, ['USBChange', 'otherDeviceChange', 'displayChange']);
    assert.equal(await probe.unplugMonitor(), false, 'already unplugged');
    assert.equal(await probe.replugMonitor(), true);
    assert.equal(await readFile(status, 'utf8'), 'connected\n');
    assert.deepEqual(await ids(), ['usb:3-2.1@31', 'usb:3-2.4@30'], 're-enumerated at new addresses');
    assert.equal(events.length, 6);
    assert.equal(await probe.replugMonitor(), false, 'already plugged');
    // a second cycle detaches the re-enumerated devices
    assert.equal(await probe.unplugMonitor(), true);
    assert.deepEqual(await ids(), []);
  } finally {
    await hw.cleanup();
  }
});

test('unplug without an ENE; no simulated hardware at all → false', async () => {
  const hw = await hardware(false);
  try {
    const probe = createMockProbe(backendOf(hw));
    assert.equal(await probe.unplugMonitor(), true);
    assert.equal(await probe.replugMonitor(), true);
    assert.deepEqual((await hw.usb.list()).map((d) => d.id), ['usb:3-2.4']);
  } finally {
    await hw.cleanup();
  }
  const none = createMockProbe(backendOf(null));
  assert.equal(await none.unplugMonitor(), false);
  assert.equal(none.osdSet(0x10, 1), false);
});

test('installMockProbe: a non-enumerable, read-only property of the target', () => {
  const target: Record<string, unknown> = {};
  const probe = installMockProbe(target, () => null);
  assert.equal(target[MOCK_PROBE_KEY], probe);
  assert.deepEqual(Object.keys(target), []);
  assert.throws(() => {
    'use strict';
    target[MOCK_PROBE_KEY] = null;
  }, TypeError);
});
