import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeParameterSet,
  parameterSetWrites,
  toEneParameterSet,
  type DisplayEffectInfoLike,
  type EneParameterSet,
} from '../../../src/backend/ambiglow/ene-params.ts';
import { EneBrightness, EneMode, EneRegion, EneSpeed } from '../../../src/backend/ambiglow/ene-registers.ts';
import { FakeUsbBackend } from '../../../src/backend/usb/fake-backend.ts';
import { MockEneDevice } from '../../../src/backend/ambiglow/mock-ene.ts';
import { EneDevice } from '../../../src/backend/ambiglow/ene.ts';
import { LAYOUTS, openRig, quietLog, w } from './helpers.ts';

const base: EneParameterSet = { region: EneRegion.AllZone, mode: EneMode.StaticMode, rainbow: false, rgb: [0xff, 0, 0], speed: EneSpeed.Normal, brightness: EneBrightness.Brightest };

/** The 28-write AllZone block of Class0.cs:291-341 (after the 0x0023 switch). */
function allZone(mode: number, speed: number, dir: number, bright: number, rgb: number[]): string[] {
  return [
    w(0xe021, mode), w(0xe031, mode), w(0xe041, mode), w(0xe051, mode),
    w(0xe020, 0), w(0xe030, 0), w(0xe040, 0), w(0xe050, 0),
    w(0xe022, speed), w(0xe032, speed), w(0xe042, speed), w(0xe052, speed),
    w(0xe023, dir), w(0xe033, dir), w(0xe043, dir), w(0xe053, dir),
    w(0xe029, bright), w(0xe039, bright), w(0xe049, bright), w(0xe059, bright),
    w(0xe980, ...rgb), w(0xe983, ...rgb), w(0xe986, ...rgb), w(0xe989, ...rgb),
    w(0xe02f, 1), w(0xe03f, 1), w(0xe04f, 1), w(0xe05f, 1),
  ];
}

test('FollowVideo, AllZones (user log 2026-09-25 19:14:01, 09 §6.3): 0x0023←04 then 28 writes, mode 0x0E', async () => {
  // The user's EffectInfo from logs/EvniaServe-2026-09-25.txt:740 (FollowVideo, Speed 2, Brightness 3,
  // rainbow, CurRGB black, region AllZones).
  const info: DisplayEffectInfoLike = {
    EffectEnable: true,
    CurrEffect: { Value: 1 },
    EffectDetail: { Effect: { Value: 1 }, Speed: 2, Brightness: 3, IsRainbowColor: true, CurRGB: { R: 0, G: 0, B: 0 }, CurRegion: 0 },
  };
  const ps = toEneParameterSet(info);
  assert.deepEqual(ps, { region: EneRegion.AllZone, mode: EneMode.UserDefine, rainbow: true, rgb: [0, 0, 0], speed: 0x00, brightness: 0x00, direction: 0 });

  const rig = await openRig();
  const m = rig.mark();
  await rig.device.setEffect(ps);
  assert.deepEqual(rig.since(m), [w(0x0023, 0x04), ...allZone(0x0e, 0x00, 0x00, 0x00, [0, 0, 0])]);
  // 10 ms after each of the 28 writes, none after the 0x0023 switch (09 §3.5; the log shows 458 ms for 28 writes).
  assert.deepEqual(rig.sleeps, Array(28).fill(10));
  assert.equal(rig.device.hostControl, true);
  assert.equal(rig.mock.state().hostControl, 0x04);
  assert.equal(rig.mock.state().groups[1]?.mode, 0x0e);
});

test('Static red, brightness 3 (09 §6.3)', async () => {
  const rig = await openRig();
  const m = rig.mark();
  await rig.device.setEffect(base);
  assert.deepEqual(rig.since(m), [w(0x0023, 0x04), ...allZone(0x01, 0x00, 0x00, 0x00, [0xff, 0, 0])]);
  assert.deepEqual(rig.mock.state().groups[3], { mode: 1, swMode: 0, speed: 0, direction: 0, brightness: 0, color: [0xff, 0, 0] });
});

test('effect off: 0x0023←00, then mode 00 in all groups + apply', async () => {
  const rig = await openRig();
  await rig.device.setEffect(base);
  const m = rig.mark();
  await rig.device.setEffect({ ...base, mode: EneMode.LEDOFF });
  assert.deepEqual(rig.since(m), [w(0x0023, 0x00), ...allZone(0x00, 0x00, 0x00, 0x00, [0xff, 0, 0])]);
  assert.equal(rig.device.hostControl, false);
  assert.equal(rig.mock.state().hostControl, 0);
});

test('ColorWave rainbow, speed High, brightness Bright, AllZone', async () => {
  const rig = await openRig();
  const m = rig.mark();
  await rig.device.setEffect({ ...base, mode: EneMode.ColorWave, rainbow: true, speed: EneSpeed.High, brightness: EneBrightness.Bright, rgb: [0, 0, 0xff] });
  assert.deepEqual(rig.since(m), [w(0x0023, 0x04), ...allZone(0x06, 0xfe, 0x00, 0x04, [0, 0, 0xff])]);
});

test('Border4Sided region (4-sided / 3-sided): central off, border and bottom on (Class0.cs:342-395)', async () => {
  const rig = await openRig();
  const m = rig.mark();
  await rig.device.setEffect({ ...base, region: EneRegion.Border4Sided, mode: EneMode.ColorShift, speed: EneSpeed.Low, brightness: EneBrightness.Brighter, rgb: [1, 2, 3] });
  assert.deepEqual(rig.since(m), [
    w(0x0023, 0x04),
    w(0xe031, 0), w(0xe030, 0), w(0xe03f, 1),
    w(0xe021, 3), w(0xe020, 0), w(0xe022, 2), w(0xe023, 0), w(0xe029, 2), w(0xe980, 1, 2, 3), w(0xe02f, 1),
    w(0xe041, 3), w(0xe040, 0), w(0xe042, 2), w(0xe043, 0), w(0xe049, 2), w(0xe986, 1, 2, 3), w(0xe04f, 1),
  ]);
  assert.equal(rig.mock.state().groups[2]?.mode, 0);
  assert.equal(rig.sleeps.length, 17);
});

test('Central region: border and bottom off, central on (Class0.cs:396-428)', async () => {
  const rig = await openRig();
  const m = rig.mark();
  await rig.device.setEffect({ ...base, region: EneRegion.Central, mode: EneMode.StarryNight, rainbow: true, rgb: [9, 8, 7] });
  assert.deepEqual(rig.since(m), [
    w(0x0023, 0x04),
    w(0xe021, 0), w(0xe041, 0), w(0xe020, 0), w(0xe040, 0), w(0xe02f, 1), w(0xe04f, 1),
    w(0xe031, 0x0d), w(0xe030, 0), w(0xe032, 0), w(0xe033, 0), w(0xe039, 0), w(0xe983, 9, 8, 7), w(0xe03f, 1),
  ]);
});

test('Bottom region: border and central off, bottom on (Class0.cs:429-462)', async () => {
  const rig = await openRig();
  const m = rig.mark();
  await rig.device.setEffect({ ...base, region: EneRegion.Bottom, mode: EneMode.ColorBreathing });
  assert.deepEqual(rig.since(m), [
    w(0x0023, 0x04),
    w(0xe021, 0), w(0xe031, 0), w(0xe020, 0), w(0xe030, 0), w(0xe02f, 1), w(0xe03f, 1),
    w(0xe041, 7), w(0xe040, 0), w(0xe042, 0), w(0xe043, 0), w(0xe049, 0), w(0xe986, 0xff, 0, 0), w(0xe04f, 1),
  ]);
});

test('Clock4 region (group 4 only, Class0.cs:463-492) and unknown regions take the AllZone path', () => {
  const clock = parameterSetWrites({ ...base, region: EneRegion.Clock4 }).map((x) => w(x.reg, ...x.data));
  assert.deepEqual(clock, [w(0x0023, 4), w(0xe051, 1), w(0xe050, 0), w(0xe052, 0), w(0xe053, 0), w(0xe059, 0), w(0xe989, 0xff, 0, 0), w(0xe05f, 1)]);
  const other = parameterSetWrites({ ...base, region: 0 }).map((x) => w(x.reg, ...x.data));
  assert.deepEqual(other, [w(0x0023, 4), ...allZone(1, 0, 0, 0, [0xff, 0, 0])]);
});

test('FollowAudio: mode 9, rainbow → 10; speed and brightness pass through (not forced)', async () => {
  const rig = await openRig();
  const m = rig.mark();
  await rig.device.setEffect({ ...base, mode: EneMode.FollowAudio, rainbow: true, speed: EneSpeed.Low, brightness: EneBrightness.Bright });
  assert.deepEqual(rig.since(m), [w(0x0023, 0x04), ...allZone(0x0a, 0x02, 0x00, 0x04, [0xff, 0, 0])]);
});

test('normalisation (Class0.method_5): rainbow variants, forced FollowVideo/UserDefine fields, unknown → LEDOFF', () => {
  const cases: Array<[mode: number, rainbow: boolean, expected: number]> = [
    [1, false, 1], [1, true, 2], [2, false, 1],
    [3, true, 4], [4, false, 3],
    [5, true, 6], [7, true, 8], [8, false, 7],
    [9, true, 10], [10, false, 9],
    [12, true, 13], [13, false, 12],
    [11, true, 11], [14, true, 14],
    [0, true, 0], [15, false, 0], [99, true, 0],
  ];
  for (const [mode, rainbow, expected] of cases) {
    assert.equal(normalizeParameterSet({ ...base, mode, rainbow }).mode, expected, `mode ${mode} rainbow ${rainbow}`);
  }
  const video = normalizeParameterSet({ ...base, mode: EneMode.UserDefine, speed: EneSpeed.High, brightness: EneBrightness.Bright, direction: 1 });
  assert.deepEqual([video.speed, video.brightness, video.direction], [0, 0, 0]);
  // Out-of-range modes switch host control off rather than on with the LEDs off.
  assert.equal(parameterSetWrites({ ...base, mode: 99 })[0].data[0], 0x00);
});

test('toEneParameterSet (ENEDataConvert, 09 §5.2): effect, speed, brightness and region tables', () => {
  const detail = (effect: number, extra: Partial<DisplayEffectInfoLike['EffectDetail']> = {}): DisplayEffectInfoLike => ({
    EffectEnable: true,
    CurrEffect: { Value: effect },
    EffectDetail: { Effect: { Value: effect }, Speed: 2, Brightness: 3, IsRainbowColor: false, CurRGB: { R: 0, G: 0, B: 255 }, CurRegion: 0, ...extra },
  });
  const modes = [1, 2, 3, 4, 6, 7, 42].map((e) => toEneParameterSet(detail(e)).mode);
  assert.deepEqual(modes, [EneMode.UserDefine, EneMode.FollowAudio, EneMode.ColorShift, EneMode.ColorWave, EneMode.StarryNight, EneMode.StaticMode, EneMode.StaticMode]);
  assert.deepEqual([1, 2, 3, 0].map((s) => toEneParameterSet(detail(7, { Speed: s })).speed), [0x02, 0x00, 0xfe, 0x00]);
  assert.deepEqual([1, 2, 3, 9].map((b) => toEneParameterSet(detail(7, { Brightness: b })).brightness), [0x04, 0x02, 0x00, 0x02]);
  assert.deepEqual([0, 1, 2, 3, 4, 5, -1].map((g) => toEneParameterSet(detail(7, { CurRegion: g })).region), [5, 1, 2, 3, 1, 1, 5]);
  assert.deepEqual(toEneParameterSet(detail(7, { CurRGB: { R: 300, G: -1, B: 17 } })).rgb, [0, 0, 17], 'Convert.ToByte overflow → 0');
  assert.equal(toEneParameterSet({ ...detail(7), EffectEnable: false }).mode, EneMode.LEDOFF);
});

test('Breathing: firmware breathing (7) unless synced (14); a disabled Breathing is off (vendor bug fixed)', () => {
  const breathing: DisplayEffectInfoLike = {
    EffectEnable: true,
    CurrEffect: { Value: 5 },
    EffectDetail: { Effect: { Value: 5 }, Speed: 2, Brightness: 3, IsRainbowColor: true, CurRGB: { R: 0, G: 0, B: 255 }, CurRegion: 0 },
  };
  assert.equal(toEneParameterSet(breathing).mode, EneMode.ColorBreathing);
  assert.equal(normalizeParameterSet(toEneParameterSet(breathing)).mode, EneMode.ColorBreathingRainbow);
  assert.equal(toEneParameterSet(breathing, { breathingSync: true }).mode, EneMode.UserDefine);
  assert.equal(toEneParameterSet({ ...breathing, EffectEnable: false }).mode, EneMode.LEDOFF);
});

test('pacing is configurable: writeDelayMs 0 performs no sleeps', async () => {
  const usb = new FakeUsbBackend();
  const info = usb.attach(new MockEneDevice().spec());
  const sleeps: number[] = [];
  const device = await EneDevice.open(usb, info, { log: quietLog, layouts: LAYOUTS, writeDelayMs: 0, sleep: async (ms) => void sleeps.push(ms) });
  await device.setEffect(base);
  assert.deepEqual(sleeps, []);
});
