// The ambiglow service with the ENE controller present: the simulated 34M2C8600 display driver + the simulated
// ENE MCU on the same fake USB bus, Effect_* through the real dispatcher (api/effect.ts), register writes as the
// MCU received them, replies, notifications and persistence into the display profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serialize } from '../../../src/backend/core/json.ts';
import { parameterSetWrites, toEneParameterSet } from '../../../src/backend/ambiglow/ene-params.ts';
import { ENE_LOST_GRACE_MS } from '../../../src/backend/ambiglow/service.ts';
import { DisplayEffectInfo } from '../../../src/backend/monitor/model/effect.ts';
import { NOTIFY_EFFECT } from '../../../src/backend/monitor/display.ts';
import type { DisplayDevice } from '../../../src/backend/services.ts';
import { setFrame } from '../monitor/helpers.ts';
import { w } from '../ambiglow-ene/helpers.ts';
import { flush, rig, rgbaFrame, writesOnly, type Rig } from './helpers.ts';

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

/** The ParameterSet the vendor sends for the display's current EffectInfo (method_17, sent once). */
function expectedParameterSet(r: Rig): string[] {
  const info = r.display.profile()!.EffectInfo!;
  return parameterSetWrites(toEneParameterSet(info)).map((x) => w(x.reg, ...x.data));
}

/** 09 §6.3 worked example (user's log 2026-09-25:741-742): FollowVideo, AllZones. */
const USER_FOLLOW_VIDEO = [
  w(0x0023, 0x04),
  ...[0xe021, 0xe031, 0xe041, 0xe051].map((reg) => w(reg, 0x0e)),
  ...[0xe020, 0xe030, 0xe040, 0xe050].map((reg) => w(reg, 0)),
  ...[0xe022, 0xe032, 0xe042, 0xe052].map((reg) => w(reg, 0)),
  ...[0xe023, 0xe033, 0xe043, 0xe053].map((reg) => w(reg, 0)),
  ...[0xe029, 0xe039, 0xe049, 0xe059].map((reg) => w(reg, 0)),
  ...[0xe980, 0xe983, 0xe986, 0xe989].map((reg) => w(reg, 0, 0, 0)),
  ...[0xe02f, 0xe03f, 0xe04f, 0xe05f].map((reg) => w(reg, 1)),
];

test('load with the ENE present: checkEne → ENE mode, the stored FollowVideo is pushed (09 §6.3) and the capture starts', async () => {
  const r = await rig();
  try {
    const data = r.display.profile()!;
    assert.equal(r.display.eneModel, '34M2C8600', 'CUSBENE6K7732.GetModelName("PHL 34M2C8600")');
    assert.equal(data.ENEEffectEnable, true);
    assert.equal(data.EffectInfo?.CurrEffect.Name, 'FollowVideo', 'the stored EffectInfo is kept (method_12 ENE branch)');
    const writes = writesOnly(r.eneSince(0));
    assert.deepEqual(writes, USER_FOLLOW_VIDEO, 'identification is read-only; then exactly the logged ParameterSet');
    assert.deepEqual(r.capture.videoStarts, [300]);
    assert.equal(r.service.followVideo.state, 'running');
    assert.equal(r.notifier.named(NOTIFY_EFFECT).length, 0, 'no plug notification at load (vendor: only on a USB change)');
    // A frame reaches the LEDs and the preview.
    r.capture.frame(rgbaFrame(() => [10, 20, 30]));
    r.timers.advance(100);
    await flush();
    assert.deepEqual([...r.mock!.state().frame.subarray(0, 3)], [10, 20, 30]);
    const leds = await r.call('Effect_GetLEDs', [100000]);
    assert.equal(leds.err_code, 0);
    assert.equal(leds.Tag.length, 46);
    assert.deepEqual(leds.Tag[45], { R: 10, G: 20, B: 30 });
  } finally {
    await r.cleanup();
  }
});

test('Effect_GetMenu with the ENE = 20-enum §6.1 byte for byte', async () => {
  const r = await rig();
  try {
    const reply = await r.call('Effect_GetMenu', [100000]);
    assert.equal(reply.err_code, 0);
    assert.equal(reply.err_msg, '');
    const tag = serialize(reply.Tag, 'ui');
    assert.equal(sha256(tag), '516cd5fad0f6938f314663ae956a79b845a816d272b7446b6bf605f77b290af2');
  } finally {
    await r.cleanup();
  }
});

test('Effect_Change(Static): EffectInfo reply, ParameterSet for the stored Static detail, capture stopped, profile saved', async () => {
  const r = await rig();
  try {
    const m = r.eneMark();
    const saves = r.themes.saves;
    const reply = await r.call('Effect_Change', [100000, 7]);
    assert.equal(reply.err_code, 0);
    assert.deepEqual(reply.Tag.CurrEffect, { Name: 'Static', Text: '恒亮模式', Value: 7 });
    assert.equal(reply.Tag.EffectDetail.Effect.Name, 'Static');
    const writes = writesOnly(r.eneSince(m));
    assert.deepEqual(writes, expectedParameterSet(r));
    assert.equal(writes[1], w(0xe021, 0x02), 'stored Static detail is rainbow → StaticModeRainbow');
    assert.equal(r.capture.videoStops, 1);
    assert.equal(r.service.followVideo.state, 'stopped');
    assert.ok(r.themes.saves > saves);
    assert.match(r.themes.contents.get('100000|PHL 34M2C8600')!, /"CurrEffect":\{"Name":"Static","Text":"恒亮模式","Value":7\}/);
    const leds = await r.call('Effect_GetLEDs', [100000]);
    assert.deepEqual([leds.err_code, leds.err_msg], [9, 'not ene follow video or audio']);
  } finally {
    await r.cleanup();
  }
});

test('Effect_ColorChange: CurRGB (out-of-range → 0), rainbow and random off, static colour on the ENE', async () => {
  const r = await rig();
  try {
    await r.call('Effect_Change', [100000, 7]);
    const m = r.eneMark();
    const reply = await r.call('Effect_ColorChange', [100000, 255, 300, -1]);
    assert.equal(reply.err_code, 0);
    assert.deepEqual(reply.Tag.EffectDetail.CurRGB, { R: 255, G: 0, B: 0 });
    assert.equal(reply.Tag.EffectDetail.IsRainbowColor, false);
    const writes = writesOnly(r.eneSince(m));
    assert.equal(writes[1], w(0xe021, 0x01), 'StaticMode');
    assert.ok(writes.includes(w(0xe980, 0xff, 0, 0)));
    assert.deepEqual(r.mock!.state().groups[3]?.color, [255, 0, 0]);
  } finally {
    await r.cleanup();
  }
});

test('Effect_SpeedChange / Effect_BrightnessChange: stored, but no ParameterSet for FollowVideo/FollowAudio', async () => {
  const r = await rig();
  try {
    let m = r.eneMark();
    let reply = await r.call('Effect_SpeedChange', [100000, 3]);
    assert.equal(reply.Tag.EffectDetail.Speed, 3);
    reply = await r.call('Effect_BrightnessChange', [100000, 1]);
    assert.equal(reply.Tag.EffectDetail.Brightness, 1);
    assert.deepEqual(writesOnly(r.eneSince(m)), [], 'FollowVideo: vendor :1088-1121');
    await r.call('Effect_Change', [100000, 3]); // ColorShift
    m = r.eneMark();
    await r.call('Effect_SpeedChange', [100000, 3]);
    const writes = writesOnly(r.eneSince(m));
    assert.ok(writes.includes(w(0xe022, 0xfe)), 'speed High = 0xFE');
    m = r.eneMark();
    await r.call('Effect_BrightnessChange', [100000, 1]);
    assert.ok(writesOnly(r.eneSince(m)).includes(w(0xe029, 0x04)), 'brightness Bright = 0x04');
  } finally {
    await r.cleanup();
  }
});

test('firmware Breathing (not synced) takes live speed/brightness changes (deviation: the vendor skips every Breathing)', async () => {
  const r = await rig();
  try {
    await r.call('Effect_Change', [100000, 5]);
    assert.equal(r.mock!.state().groups[1]?.mode, 8, 'unsynced Breathing = firmware breathing (09 §9); the stored detail is rainbow → ColorBreathingRainbow');
    let m = r.eneMark();
    const speed = await r.call('Effect_SpeedChange', [100000, 3]);
    assert.equal(speed.Tag.EffectDetail.Speed, 3, 'the Tag is the vendor\'s');
    let writes = writesOnly(r.eneSince(m));
    assert.deepEqual(writes, expectedParameterSet(r), 'one ParameterSet with the new speed');
    assert.ok(writes.includes(w(0xe022, 0xfe)));
    m = r.eneMark();
    await r.call('Effect_BrightnessChange', [100000, 1]);
    writes = writesOnly(r.eneSince(m));
    assert.ok(writes.includes(w(0xe029, 0x04)));
    assert.equal(r.mock!.state().groups[1]?.mode, 8);
  } finally {
    await r.cleanup();
  }
});

test('synced Breathing: mode 14 and the host curve while the group has two members; the ParameterSet follows the group (OnBreathing bool_3)', async () => {
  const r = await rig();
  try {
    const member = { SyncStatus: true, Connect: true, EquipmentType: 1, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: null };
    const keyboard = { SyncStatus: true, Connect: true, EquipmentType: 2, DeviceType: 200000, ModelName: 'SPK8708', ExtModel: null };
    r.themes.sync = { EffectDetailInfo: null, SyncDevices: [member, keyboard] };
    await r.call('Effect_Change', [100000, 5]);
    assert.equal(r.mock!.state().groups[1]?.mode, 14, 'IsCanBreathingSync → UserDefine, frames from the host');
    assert.equal(r.service.breathing.running, true);
    const frames = r.service.breathing.frames;
    r.timers.advance(200);
    await flush();
    assert.ok(r.service.breathing.frames > frames, 'the 40 ms curve streams solid frames');
    // Live speed changes are not sent while synced: the curve reads Sync_Profile (vendor :1088-1103).
    let m = r.eneMark();
    await r.call('Effect_SpeedChange', [100000, 3]);
    assert.ok(!writesOnly(r.eneSince(m)).includes(w(0x0023, 0x04)));

    // The keyboard leaves the group (another profile, SyncEffect_*): firmware breathing again, once.
    r.themes.sync = { ...(r.themes.sync as object), SyncDevices: [member] } as never;
    m = r.eneMark();
    r.themes.emitSwitched('switch');
    await r.display.exclusive(async () => undefined);
    await flush();
    assert.equal(r.mock!.state().groups[1]?.mode, 8, 'firmware (rainbow) breathing');
    assert.equal(r.service.breathing.running, false);
    assert.equal(writesOnly(r.eneSince(m)).filter((x) => x === w(0x0023, 0x04)).length, 1);
    r.themes.emitSwitched('switch');
    await r.display.exclusive(async () => undefined);
    assert.equal(writesOnly(r.eneSince(m)).filter((x) => x === w(0x0023, 0x04)).length, 1, 'no change, no ParameterSet');

    // …and back into the group.
    r.themes.sync = { ...(r.themes.sync as object), SyncDevices: [member, keyboard] } as never;
    r.themes.emitSwitched('apply');
    await r.display.exclusive(async () => undefined);
    await flush();
    assert.equal(r.mock!.state().groups[1]?.mode, 14);
    assert.equal(r.service.breathing.running, true);
  } finally {
    await r.cleanup();
  }
});

test('a profile apply or reload re-pushes EffectInfo (onEffectInfoChanged → attach, method_12 → method_17)', async () => {
  const r = await rig();
  try {
    const content = JSON.parse(r.display.purify()) as { EffectInfo: { CurrEffect: unknown } };
    content.EffectInfo.CurrEffect = { Name: 'Static', Text: '恒亮模式', Value: 7 };
    let m = r.eneMark();
    await r.display.applyProfileContent(JSON.stringify(content));
    await r.service.settled();
    await flush();
    assert.equal(r.display.profile()!.EffectInfo!.CurrEffect.Name, 'Static');
    assert.deepEqual(writesOnly(r.eneSince(m)), expectedParameterSet(r), 'the applied EffectInfo on the ENE');
    assert.equal(r.mock!.state().groups[1]?.mode, 2);
    assert.equal(r.service.followVideo.state, 'stopped', 'FollowVideo left: capture stopped');
    // The store's onSwitched afterwards only re-evaluates the timers: nothing more on the wire.
    m = r.eneMark();
    r.themes.emitSwitched('apply');
    await flush();
    assert.deepEqual(writesOnly(r.eneSince(m)), []);

    m = r.eneMark();
    const reload = await r.display.reload();
    assert.equal(reload.IsSucc, true);
    await r.service.settled();
    await flush();
    assert.deepEqual(writesOnly(r.eneSince(m)), expectedParameterSet(r), 'PHL_ReloadData: the kept EffectInfo is sent again');
    assert.equal(r.notifier.named(NOTIFY_EFFECT).length, 0, 'no ENE change, no notification');
  } finally {
    await r.cleanup();
  }
});

test('an ENE that re-enumerates within ENE_LOST_GRACE_MS is re-opened without a DDC fallback; the capture session is kept', async () => {
  const r = await rig();
  try {
    assert.deepEqual(r.capture.videoStarts, [300]);
    const usb = r.t.bundle.usb;
    usb.detach(r.eneInfo!);
    const info = usb.attach(r.mock!.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 14 }));
    r.display.setEneDevice(info);
    // The next frame upload finds the old handle dead.
    r.capture.frame(rgbaFrame(() => [1, 2, 3], 1));
    r.timers.advance(100);
    await flush();
    assert.equal(r.service.ene?.lost, true);
    assert.equal(r.service.followVideo.paused, true);
    assert.equal(r.service.followVideo.state, 'running');
    const d = r.ddcMark();
    const m = r.eneMark();
    r.timers.advance(ENE_LOST_GRACE_MS);
    await r.service.settled();
    await flush();
    assert.equal(r.service.ene?.lost, false, 'the new enumeration is open');
    assert.equal(r.service.ene?.info.deviceAddress, 14);
    assert.equal(r.display.eneModel, '34M2C8600');
    assert.equal(r.notifier.named(NOTIFY_EFFECT).length, 0, 'no method_15/method_14 round trip');
    assert.deepEqual(r.ddcSince(d), [], 'no E2A019 write');
    assert.deepEqual(writesOnly(r.eneSince(m)).filter((x) => !x.startsWith('40 80 0000 E3')), USER_FOLLOW_VIDEO, 'the effect again');
    assert.deepEqual(r.capture.videoStarts, [300], 'no second portal dialog');
    assert.equal(r.capture.videoStops, 0);
    assert.equal(r.service.followVideo.paused, false);
    r.capture.frame(rgbaFrame(() => [4, 5, 6], 2));
    r.timers.advance(100);
    await flush();
    assert.deepEqual([...r.mock!.state().frame.subarray(0, 3)], [4, 5, 6]);
  } finally {
    await r.cleanup();
  }
});

test('an ENE away longer than the grace: DDC fallback, the capture session is kept up to ENE_AWAY_CAPTURE_MS for its return', async () => {
  const r = await rig({ service: { awayCaptureMs: 60_000 } });
  try {
    const usb = r.t.bundle.usb;
    usb.detach(r.eneInfo!);
    r.capture.frame(rgbaFrame(() => [1, 1, 1], 1));
    r.timers.advance(100);
    await flush();
    r.timers.advance(ENE_LOST_GRACE_MS);
    await r.service.settled();
    await flush();
    assert.equal(r.display.eneModel, '', 'DDC fallback (method_15)');
    assert.equal(r.service.followVideo.state, 'running', 'kept, paused');
    assert.equal(r.service.followVideo.paused, true);
    // The monitor is back (standby over): a new enumeration, found by the next attach (USB change).
    const info = usb.attach(r.mock!.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 30 }));
    r.display.setEneDevice(info);
    await r.service.attach(r.display);
    await flush();
    assert.equal(r.display.eneModel, '34M2C8600');
    assert.equal(r.service.followVideo.paused, false);
    assert.deepEqual(r.capture.videoStarts, [300], 'the same session');
    // Gone again, this time for good: after the away window the session ends.
    usb.detach(info);
    r.capture.frame(rgbaFrame(() => [2, 2, 2], 2));
    r.timers.advance(100);
    await flush();
    r.timers.advance(ENE_LOST_GRACE_MS);
    await r.service.settled();
    await flush();
    assert.equal(r.capture.videoStops, 0);
    r.timers.advance(60_000);
    await flush();
    assert.equal(r.capture.videoStops, 1);
    assert.equal(r.service.followVideo.state, 'stopped');
  } finally {
    await r.cleanup();
  }
});

test('a load identifies the ENE once: the first attach keeps the device checkEne opened for that display', async () => {
  // Found by the e2e walkthrough: the first attach() treated the display as a new one and closed the ENE that
  // the load's checkEne() (method_14) had just opened for it, so #syncDisplay opened and identified it again.
  const r = await rig();
  try {
    const probes = r.eneSince(0).filter((x) => x.startsWith('C0 81 0000 4000'));
    assert.equal(probes.length, 1, 'identified once by checkEne, kept by the first attach');
    assert.equal(r.service.display, r.display);
    assert.equal(r.mock!.state().hostControl, 4, 'the effect is pushed to the kept device');
    assert.deepEqual(writesOnly(r.eneSince(0)), USER_FOLLOW_VIDEO);
    // Only an attach of the display that owns the ENE keeps it: no display left → released as before.
    const ene = r.service.ene;
    assert.ok(ene);
    await r.service.attach(null);
    assert.equal(ene.closed, true, 'attach(null) still releases the ENE');
  } finally {
    await r.cleanup();
  }
});

test('checkEne (a reload holding the display queue) racing an attach: one probe, one device', async () => {
  const r = await rig();
  try {
    const usb = r.t.bundle.usb;
    usb.detach(r.eneInfo!);
    const info = usb.attach(r.mock!.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 17 }));
    r.display.setEneDevice(info);
    const m = r.eneMark();
    const [reload] = await Promise.all([r.display.reload(), r.service.attach(r.display), r.service.checkEne(r.display)]);
    assert.equal(reload.IsSucc, true);
    await r.service.settled();
    await flush();
    const probes = r.eneSince(m).filter((x) => x.startsWith('C0 81 0000 4000'));
    assert.equal(probes.length, 1, 'the new enumeration is identified once');
    assert.equal(r.service.ene?.info.deviceAddress, 17);
    assert.equal(r.display.eneModel, '34M2C8600');
    assert.equal(r.display.profile()!.ENEEffectEnable, true);
    assert.equal(r.mock!.state().hostControl, 4);
    assert.equal(r.notifier.named(NOTIFY_EFFECT).length, 0);
  } finally {
    await r.cleanup();
  }
});

test('an empty USB enumeration (libusb device list failed) does not drop a working ENE', async () => {
  const r = await rig();
  try {
    const usb = r.t.bundle.usb;
    const held = r.service.ene;
    const real = usb.list.bind(usb);
    let empty = 1;
    usb.list = async (filter) => (empty-- > 0 ? [] : real(filter));
    const m = r.eneMark();
    assert.equal(await r.service.checkEne(r.display), '34M2C8600');
    assert.equal(r.service.ene, held, 'kept');
    assert.deepEqual(writesOnly(r.eneSince(m)), [], 'no release (0x0023 ← 0)');
    assert.equal(r.display.profile()!.ENEEffectEnable, true);
  } finally {
    await r.cleanup();
  }
});

test('an ENE checked against another display (model mismatch) stays usable for its own display', async () => {
  const r = await rig();
  try {
    const other = { key: 'OTHER000001', monitorName: 'PHL 27M2N8500', ene: r.eneInfo } as unknown as DisplayDevice;
    assert.equal(await r.service.checkEne(other), '');
    assert.equal(await r.service.checkEne(other), '', 'the mismatch is remembered for that display');
    assert.equal(await r.service.checkEne(r.display), '34M2C8600', 'not rejected for its own display');
    assert.equal(r.service.ene?.modelName, '34M2C8600');
  } finally {
    await r.cleanup();
  }
});

test('Effect_RegionChange(Central) sends the Central sequence; RandomEnable/BgColor/Direction are stored and re-sent unchanged', async () => {
  const r = await rig();
  try {
    await r.call('Effect_Change', [100000, 7]);
    let m = r.eneMark();
    const reply = await r.call('Effect_RegionChange', [100000, 2]);
    assert.equal(reply.Tag.EffectDetail.CurRegion, 2);
    const writes = writesOnly(r.eneSince(m));
    assert.deepEqual(writes.slice(0, 7), [w(0x0023, 4), w(0xe021, 0), w(0xe041, 0), w(0xe020, 0), w(0xe040, 0), w(0xe02f, 1), w(0xe04f, 1)]);
    assert.equal(writes.length, 14);
    for (const [fn, args, check] of [
      ['Effect_RandomEnable', [true], (t: any) => t.EffectDetail.IsRandomColor === true],
      ['Effect_BgColorChange', [1, 2, 3], (t: any) => t.EffectDetail.BgRGB.B === 3],
      ['Effect_DirectionChange', [1], (t: any) => t.EffectDetail.CurDir === 1],
      ['Effect_RainbowEnable', [false], (t: any) => t.EffectDetail.IsRainbowColor === false],
    ] as const) {
      m = r.eneMark();
      const res = await r.call(fn, [100000, ...args]);
      assert.equal(res.err_code, 0, fn);
      assert.ok(check(res.Tag), fn);
      assert.equal(writesOnly(r.eneSince(m))[0], w(0x0023, 4), `${fn} re-sends ParameterSet (method_17)`);
    }
  } finally {
    await r.cleanup();
  }
});

test('FollowAudio: Effect_Change(2) → mode 10 (stored rainbow), audio capture, levels to E970..E972', async () => {
  const r = await rig();
  try {
    await r.call('Effect_Change', [100000, 2]);
    await flush();
    assert.equal(r.mock!.state().groups[1]?.mode, 10);
    assert.equal(r.capture.audioStarts, 1);
    assert.equal(r.service.followAudio.state, 'running');
    const m = r.eneMark();
    r.capture.level(77.7);
    await flush();
    assert.deepEqual(writesOnly(r.eneSince(m)), [w(0xe970, 77), w(0xe971, 77), w(0xe972, 77)]);
    const leds = await r.call('Effect_GetLEDs', [100000]);
    assert.equal(leds.err_code, 0, 'FollowAudio has a preview too');
    await r.call('Effect_Change', [100000, 7]);
    assert.equal(r.capture.audioStops, 1);
  } finally {
    await r.cleanup();
  }
});

test('Effect_Enable(false/true) with ENE: LEDOFF (0x0023 ← 0) and back; the timers follow; Tag is the flag', async () => {
  const r = await rig();
  try {
    let m = r.eneMark();
    let reply = await r.call('Effect_Enable', [100000, false]);
    assert.equal(reply.err_code, 0);
    assert.equal(reply.Tag, false);
    const off = writesOnly(r.eneSince(m));
    assert.equal(off[0], w(0x0023, 0));
    assert.equal(off[1], w(0xe021, 0));
    assert.equal(r.display.profile()!.EffectInfo!.EffectEnable, false);
    assert.equal(r.service.followVideo.state, 'stopped');
    assert.match(r.themes.contents.get('100000|PHL 34M2C8600')!, /"EffectEnable":false,"CurrEffect":\{"Name":"FollowVideo"/);
    m = r.eneMark();
    reply = await r.call('Effect_Enable', [100000, true]);
    assert.equal(reply.Tag, true);
    assert.deepEqual(writesOnly(r.eneSince(m)), USER_FOLLOW_VIDEO);
    assert.equal(r.service.followVideo.state, 'running');
  } finally {
    await r.cleanup();
  }
});

test('Effect_Reset with ENE: NotifyEffectSyncDevicesChange (raw Sync_Profile) first, then DisplayEffectInfo.Default (20-enum §6.3)', async () => {
  const r = await rig();
  try {
    const m = r.eneMark();
    const before = r.notifier.sent.length;
    const reply = await r.call('Effect_Reset', [100000]);
    assert.equal(reply.err_code, 0);
    const notes = r.notifier.sent.slice(before);
    assert.deepEqual(notes.map((n) => n.name), ['NotifyEffectSyncDevicesChange']);
    assert.equal(notes[0].json, '{"EffectDetailInfo":null,"SyncDevices":[]}', '20-backend-host-tail §2.5');
    const tag = serialize(reply.Tag, 'ui');
    assert.equal(sha256(tag), '341006d3282ac2e6986a94ba8878498107baa0c0f0516f9fe11da3baa36f41e8');
    assert.equal(tag, serialize(DisplayEffectInfo.default('34M2C8600'), 'ui'));
    const writes = writesOnly(r.eneSince(m));
    assert.equal(writes[1], w(0xe021, 0x02), 'Static rainbow');
    assert.ok(writes.includes(w(0xe980, 0, 0, 0xff)), 'blue');
    assert.equal(r.service.followVideo.state, 'stopped');
  } finally {
    await r.cleanup();
  }
});

test('light sync: in a group the detail follows the display; Effect_Enable(false) and Effect_Reset leave the group', async () => {
  const r = await rig();
  try {
    const member = { SyncStatus: true, Connect: true, EquipmentType: 1, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: null };
    const keyboard = { SyncStatus: true, Connect: true, EquipmentType: 2, DeviceType: 200000, ModelName: 'SPK8708', ExtModel: null };
    r.themes.sync = { EffectDetailInfo: null, SyncDevices: [member, keyboard] };
    await r.call('Effect_Change', [100000, 7]);
    const sync = r.themes.sync as any;
    assert.equal(sync.EffectDetailInfo.Effect.Name, 'Static', 'NotityEffectSync copied the display detail');
    await r.call('Effect_Enable', [100000, false]);
    assert.deepEqual((r.themes.sync as any).SyncDevices.map((d: any) => d.DeviceType), [200000], 'CancelEffectSync');
    r.themes.sync = { EffectDetailInfo: null, SyncDevices: [member, keyboard] };
    const before = r.notifier.sent.length;
    await r.call('Effect_Reset', [100000]);
    const note = r.notifier.sent.slice(before).find((n) => n.name === 'NotifyEffectSyncDevicesChange')!;
    assert.deepEqual((JSON.parse(note.json) as any).SyncDevices.map((d: any) => d.DeviceType), [200000], 'raw profile after RemoveAll');
  } finally {
    await r.cleanup();
  }
});

test('SyncEffect_GetData lists the display while its ENE drives an effect', async () => {
  const r = await rig();
  try {
    const reply = await r.call('SyncEffect_GetData');
    assert.equal(reply.err_code, 0);
    assert.deepEqual(reply.Tag.SyncDevices, [{ SyncStatus: false, Connect: true, EquipmentType: 1, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: null }]);
    const single = await r.call('SyncEffect_EnableDevice', [100000, JSON.stringify([{ DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtValue: '' }])]);
    assert.equal(single.err_code, 0);
    assert.equal(single.Tag.EffectDetailInfo.Effect.Name, 'FollowVideo');
    await r.call('Effect_Enable', [100000, false]);
    const off = await r.call('SyncEffect_EnableDevice', [100000, '[]']);
    assert.deepEqual([off.err_code, off.err_msg], [9, 'Input device=100000 EffectDetail is null'], 'EffectDetail requires the effect on');
  } finally {
    await r.cleanup();
  }
});

test('ENE unplugged: the next write finds it gone, after the grace period the display falls back to DDC (named + Item1..3 notification)', async () => {
  const r = await rig();
  try {
    const usb = r.t.bundle.usb;
    usb.detach(r.eneInfo!);
    const reply = await r.call('Effect_Change', [100000, 7]);
    assert.equal(reply.err_code, 0, 'the write failure is logged, not reported (vendor ParameterSet result ignored)');
    assert.equal(r.service.ene?.lost, true);
    assert.equal(r.service.followVideo.state, 'stopped');
    const d = r.ddcMark();
    r.timers.advance(2000);
    await r.service.settled();
    await flush();
    assert.equal(r.display.eneModel, '');
    assert.equal(r.display.profile()!.ENEEffectEnable, false);
    const notes = r.notifier.named(NOTIFY_EFFECT);
    assert.equal(notes.length, 1);
    const lost = JSON.parse(notes[0].json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(lost), ['ENEEnable', 'EffectInfo', 'ModuleAmbiglow', 'Item1', 'Item2', 'Item3']);
    assert.deepEqual([lost.Item1, lost.Item2, lost.Item3], [lost.ENEEnable, lost.EffectInfo, lost.ModuleAmbiglow]);
    assert.equal(lost.ENEEnable, false);
    assert.deepEqual(lost.ModuleAmbiglow, JSON.parse(serialize(r.display.profile()!.ModuleAmbiglow, 'ui')), 'the display\'s ModuleAmbiglow');
    assert.deepEqual(r.ddcSince(d), [setFrame(0xe2a019, 0)], 'method_15: Ambiglow off over DDC (the user had it off)');
    const effect = await r.call('Effect_Change', [100000, 3]);
    assert.deepEqual([effect.err_code, effect.err_msg], [9, 'Not Support ENE']);

    // Re-plugged (a new enumeration): the next attach finds it, reports it and pushes the effect again.
    const info = usb.attach(r.mock!.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 12 }));
    r.display.setEneDevice(info);
    const m = r.eneMark();
    await r.service.attach(r.display);
    await flush();
    assert.equal(r.display.eneModel, '34M2C8600');
    const plug = r.notifier.named(NOTIFY_EFFECT);
    assert.equal(plug.length, 2);
    const plugged = JSON.parse(plug[1].json) as Record<string, unknown>;
    assert.equal(plugged.ENEEnable, true);
    assert.equal(plugged.Item1, true);
    assert.deepEqual(plugged.Item2, plugged.EffectInfo);
    assert.equal(writesOnly(r.eneSince(m))[0], w(0x0023, 4));
    assert.equal(r.mock!.state().groups[1]?.mode, 2, 'the Static (rainbow) effect chosen while unplugged');
  } finally {
    await r.cleanup();
  }
});

test('an ENE of another model, or one the user may not open, is not used: DDC Ambiglow', async () => {
  const other = await rig({ ene: { modelName: '27M2N8500' } });
  try {
    assert.equal(other.display.eneModel, '');
    assert.equal(other.display.profile()!.ENEEffectEnable, false);
    assert.deepEqual(writesOnly(other.eneSince(0)), [], 'never written');
    assert.equal(other.service.ene, null);
  } finally {
    await other.cleanup();
  }
  const denied = await rig({ load: false });
  try {
    denied.t.bundle.usb.setOpenError(denied.eneInfo!, 'access');
    await denied.display.connect();
    await denied.display.ready();
    await denied.service.settled();
    assert.equal(denied.display.eneModel, '');
    assert.equal(denied.display.profile()!.ENEEffectEnable, false);
    // The user installs the udev rule and runs "udevadm trigger": the device does not re-enumerate, but a
    // permission failure is not remembered, so the next attach (reload, profile switch, USB change) uses it.
    denied.t.bundle.usb.setOpenError(denied.eneInfo!, null);
    await denied.service.attach(denied.display);
    await flush();
    assert.equal(denied.display.eneModel, '34M2C8600');
    assert.equal(denied.display.profile()!.ENEEffectEnable, true);
    assert.equal(denied.mock!.state().hostControl, 4);
  } finally {
    await denied.cleanup();
  }
});

test('stop() releases the LEDs to the monitor firmware (0x0023 ← 0) and stops the capture', async () => {
  const r = await rig();
  try {
    const m = r.eneMark();
    await r.service.stop();
    assert.deepEqual(writesOnly(r.eneSince(m)), [w(0x0023, 0)]);
    assert.equal(r.capture.videoStops, 1);
    assert.equal(r.service.ene, null);
  } finally {
    await r.cleanup();
  }
});

test('stop() does not wait for an attach queued behind a busy display; that attach opens and starts nothing', async () => {
  const r = await rig();
  try {
    let release!: () => void;
    const busy = r.display.exclusive(() => new Promise<void>((resolve) => (release = resolve))); // e.g. a 20 s load
    const attach = r.service.attach(r.display);
    await flush();
    const m = r.eneMark();
    const outcome = await Promise.race([
      r.service.stop().then(() => 'stopped'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 2000).unref()),
    ]);
    assert.equal(outcome, 'stopped');
    assert.deepEqual(writesOnly(r.eneSince(m)), [w(0x0023, 0)], 'LEDs handed back at once');
    assert.equal(r.capture.videoStops, 1);
    release();
    await busy;
    await attach;
    await flush();
    assert.equal(r.service.ene, null, 'nothing re-opened');
    assert.deepEqual(writesOnly(r.eneSince(m)), [w(0x0023, 0)]);
    assert.deepEqual(r.capture.videoStarts, [300]);
    // A load after stop() asks checkEne: no probe, the last model is kept.
    assert.equal(await r.service.checkEne(r.display), '34M2C8600');
    assert.equal(r.service.ene, null);
  } finally {
    await r.cleanup();
  }
});

test('stop() while the capture start is pending (portal dialog open): withdrawn, the late answer is ignored', async () => {
  const r = await rig({ load: false });
  try {
    let answer!: () => void;
    r.capture.videoGate = new Promise<void>((resolve) => (answer = resolve));
    await r.display.connect();
    await r.display.ready();
    await r.service.settled();
    await flush();
    assert.equal(r.service.followVideo.state, 'starting');
    await r.service.stop();
    assert.equal(r.capture.videoStops, 1);
    answer();
    await flush();
    assert.equal(r.service.followVideo.state, 'stopped');
    assert.equal(r.capture.videoActive, false);
  } finally {
    await r.cleanup();
  }
});
