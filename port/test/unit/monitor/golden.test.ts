// Golden transcript of the user's 2026-09-26 session (20-backend-host-tail §5), steps 3 and 11-13,
// through the real dispatcher (createBackend + the monitor API modules) against the mock-mode backend
// (simulated 34M2C8600 on a fake VIA bridge + fake i2c bus, real discovery). The session ran WITHOUT the
// ENE (§5 setup, 20-monitor-io §6), so every test uses the "no-ene" mock and an ambiglow fake that
// answers checkEne like the real service: the §5 Tag's ENEEffectEnable:false then comes from the
// hardware state, not from a service that never reports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DdcClock } from '../../../src/backend/ddc/channel.ts';
import { FakeAmbiglow, VirtualClock, expectedDeviceDataTag, localFixture, mockBackend } from './helpers.ts';

const fixtureText = (name: string) => readFileSync(localFixture(name), 'utf8').trim();

/** The golden session's hardware: no ENE on USB; the ambiglow fake answers checkEne. */
const goldenBackend = (clock?: DdcClock) => mockBackend({ clock, manager: { mockEne: false }, ambiglow: new FakeAmbiglow({ eneModel: '34M2C8600' }) });

/** Linux DeviceName: the DRM connector (card1-DP-1 of the mock sysfs) instead of \\.\DISPLAY1 (20-monitor-io §3.2). */
const linuxDeviceName = (s: string) => s.replace('"DeviceName":"\\\\\\\\.\\\\DISPLAY1"', '"DeviceName":"DP-1"');

test('step 3: Device_GetConnectList after the Start scan', async () => {
  const b = await goldenBackend();
  try {
    await b.manager.scan('all');
    const reply = await b.call('Device_GetConnectList', null, 'd85976b8-9e88-45b6-8a28-d76cef48b3f7');
    const expected = linuxDeviceName(fixtureText('step3.connect-list.json'));
    assert.notEqual(expected, fixtureText('step3.connect-list.json'), 'DeviceName substitution applied');
    assert.equal(reply, expected);
    // §6: CurSN equals a DisplaySN, FwVersion is a number, EquipmentType 1.
    const tag = (JSON.parse(reply) as { Tag: Array<{ FwVersion: unknown; EquipmentType: number; ExtDeviceInfo: { CurSN: string; DisplayList: Array<{ DisplaySN: string }> } }> }).Tag;
    assert.equal(typeof tag[0].FwVersion, 'number');
    assert.ok(tag[0].ExtDeviceInfo.DisplayList.some((d) => d.DisplaySN === tag[0].ExtDeviceInfo.CurSN));
  } finally {
    await b.cleanup();
  }
});

test('steps 11-13: PHL_SwitchDisplay, Profile_GetDeviceData, PHL_GetConstraints (+ N1 before the reply)', async () => {
  const b = await goldenBackend();
  try {
    await b.manager.scan('all');
    const tag = expectedDeviceDataTag();

    // Step 11: the "already current" branch — Succ(DeviceData), serialized with plain JsonSerialize().
    const r11 = await b.call('PHL_SwitchDisplay', ['AU00000000001'], '23e6864d-0493-4b6a-a9fb-1e691a96ea0d');
    assert.equal(r11, `{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"23e6864d-0493-4b6a-a9fb-1e691a96ea0d","Tag":${tag},"FunctionName":"PHL_SwitchDisplay","CurrItem":null}`);

    // Step 12: Profile_GetDeviceData(100000), IgnoreUI mode — the same bytes.
    const r12 = await b.call('Profile_GetDeviceData', [100000], 'b09910ba-8ed2-4ce9-b184-dc5f5ea0495b');
    assert.equal(r12, `{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"b09910ba-8ed2-4ce9-b184-dc5f5ea0495b","Tag":${tag},"FunctionName":"Profile_GetDeviceData","CurrItem":null}`);

    // Step 13: N1 (byte-identical to N0) goes out before the reply.
    const before = b.notifications.length;
    b.wire.length = 0;
    const r13 = await b.call('PHL_GetConstraints', null, 'cceb3c05-0411-4c8f-b031-eec161ed786e');
    assert.equal(r13, fixtureText('step13.constraints.json'));
    assert.deepEqual(b.wire, ['N:NotifyUIDisplayFuncConstraintsChange', 'R:PHL_GetConstraints']);
    assert.equal(b.notifications.length, before + 1);
    assert.equal(b.notifications.at(-1), fixtureText('n0.notification.json'));
    // N0 was sent during the scan-time load (the renderer drops it; §5 step 2).
    assert.equal(b.notifications[0], fixtureText('n0.notification.json'));
  } finally {
    await b.cleanup();
  }
});

test('step 16/17 shapes: Device_OtherDeviceChange and Device_DetectionDisplay return the same list', async () => {
  const clock = new VirtualClock();
  const b = await goldenBackend(clock);
  try {
    await b.manager.scan('all');
    const list = (reply: string) => JSON.stringify((JSON.parse(reply) as { Tag: unknown }).Tag);
    const base = list(await b.call('Device_GetConnectList', null));
    assert.equal(list(await b.call('Device_OtherDeviceChange', null)), base);
    assert.equal(list(await b.call('Device_DetectionDisplay', null)), base);
    // Device_DetectionDisplay waited the vendor's 5000 ms first (virtual clock).
    assert.ok(clock.sleeps.includes(5000));
    // The constraints did not change, so the rescan sent no new notification.
    assert.equal(b.notifications.filter((n) => n.includes('NotifyUIDisplayFuncConstraintsChange')).length, 1);
  } finally {
    await b.cleanup();
  }
});
