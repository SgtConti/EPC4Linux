// The shared breathing curve (SystemOper.OnBreathingData, 05 §2.6 / 09 §9) and its frame upload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BREATHING_PALETTE,
  BREATHING_TICK_MS,
  BreathingEngine,
  BreathingGenerator,
  breathingBrightness,
  breathingSteps,
  multiplyRgb,
  type BreathingDetail,
} from '../../../src/backend/ambiglow/breathing.ts';
import { EneBrightness, EneMode, EneRegion, EneSpeed } from '../../../src/backend/ambiglow/ene-registers.ts';
import { openRig } from '../ambiglow-ene/helpers.ts';
import { ManualTimers, flush, silentLog } from './helpers.ts';

test('ramp lengths and brightness factor (smethod_12 / smethod_13)', () => {
  assert.deepEqual([1, 2, 3].map((s) => [breathingSteps(s, false), breathingSteps(s, true)]), [[6, 24], [4, 16], [2, 8]]);
  assert.deepEqual([0, 5, -3].map((s) => breathingSteps(s, false)), [6, 2, 6], 'speed clamped to 1..3');
  assert.equal(breathingBrightness(3), 1);
  assert.equal(breathingBrightness(1), Math.fround(1 / 3));
  assert.equal(breathingBrightness(9), 1);
});

test('RGB.Multiply truncates the float product and ignores factors outside [0, 1]', () => {
  assert.deepEqual(multiplyRgb({ R: 255, G: 128, B: 1 }, Math.fround(1 / 3)), { R: 85, G: 42, B: 0 });
  assert.deepEqual(multiplyRgb({ R: 255, G: 0, B: 0 }, 1.5), { R: 255, G: 0, B: 0 });
  assert.deepEqual(multiplyRgb({ R: 255, G: 0, B: 0 }, 0), { R: 0, G: 0, B: 0 });
});

test('one cycle at speed 2, brightness 3: up 0..4 (5 ticks), down 16..0 (17 ticks), then up from 1', () => {
  const gen = new BreathingGenerator();
  const detail: BreathingDetail = { Speed: 2, Brightness: 3, IsRainbowColor: false, CurRGB: { R: 200, G: 100, B: 0 } };
  const reds: number[] = [];
  for (let i = 0; i < 5 + 17 + 2; i++) reds.push(gen.next(detail)!.R);
  const f = (step: number, n: number) => Math.trunc(Math.fround(200 * Math.fround(step / n)));
  const expected = [
    ...[0, 1, 2, 3, 4].map((s) => f(s, 4)),
    ...Array.from({ length: 17 }, (_, i) => f(16 - i, 16)),
    f(1, 4),
    f(2, 4),
  ];
  assert.deepEqual(reds, expected);
  assert.equal(reds[4], 200, 'peak is the full colour');
});

test('rainbow cycles the 8-colour palette once per breath; no sync detail → nothing, state kept', () => {
  const gen = new BreathingGenerator();
  const detail: BreathingDetail = { Speed: 3, Brightness: 3, IsRainbowColor: true, CurRGB: { R: 1, G: 2, B: 3 } };
  assert.equal(gen.next(null), null);
  const peaks: string[] = [];
  // speed 3: up 0..2 (3 ticks) + down 8..0 (9 ticks) = 12 ticks for the first breath, 11 after.
  let tick = 0;
  for (const length of [12, 11, 11]) {
    const colours = Array.from({ length }, () => gen.next(detail)!);
    tick += length;
    const peak = colours.reduce((a, c) => (c.R + c.G + c.B > a.R + a.G + a.B ? c : a));
    peaks.push(`${peak.R},${peak.G},${peak.B}`);
  }
  assert.deepEqual(peaks, BREATHING_PALETTE.slice(0, 3).map((c) => `${c.R},${c.G},${c.B}`));
  assert.equal(tick, 34);
});

test('engine: while wanted, one solid 50×40 frame per 40 ms tick into the ENE frame buffer (mode 14)', async () => {
  const ene = await openRig();
  await ene.device.setEffect({ region: EneRegion.AllZone, mode: EneMode.UserDefine, rainbow: false, rgb: [0, 0, 0], speed: EneSpeed.Normal, brightness: EneBrightness.Brightest });
  const timers = new ManualTimers();
  const detail: BreathingDetail = { Speed: 2, Brightness: 3, IsRainbowColor: false, CurRGB: { R: 0, G: 200, B: 0 } };
  const engine = new BreathingEngine({ log: silentLog, target: () => ene.device, detail: () => detail, timers });
  engine.setWanted(true);
  engine.setWanted(true);
  assert.equal(timers.pending, 1);
  for (let i = 0; i < 5; i++) {
    timers.advance(BREATHING_TICK_MS);
    await flush();
  }
  assert.equal(engine.frames, 5);
  const frame = ene.mock.state().frame;
  assert.deepEqual([...frame.subarray(0, 3)], [0, 200, 0], 'fifth tick = peak');
  assert.ok(Array.from({ length: 46 }, (_, i) => frame[3 * i + 1]).every((g) => g === 200), 'all LEDs the same colour');
  engine.setWanted(false);
  assert.equal(timers.pending, 0);
});
