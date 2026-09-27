import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_HEIGHT, GRID_WIDTH, planFrame, renderFrame, roundHalfEven } from '../../../src/backend/ambiglow/ene-frame.ts';
import { findModelLayout } from '../../../src/backend/ambiglow/ene-layout.ts';
import { EneMode, EneRegion, EneSpeed, EneBrightness } from '../../../src/backend/ambiglow/ene-registers.ts';
import type { EneParameterSet } from '../../../src/backend/ambiglow/ene-params.ts';
import { FakeUsbBackend } from '../../../src/backend/usb/fake-backend.ts';
import { EneDevice } from '../../../src/backend/ambiglow/ene.ts';
import { MockEneDevice } from '../../../src/backend/ambiglow/mock-ene.ts';
import { LAYOUTS, fmt, hex, openRig, recordingLog, w } from './helpers.ts';

const followVideo: EneParameterSet = { region: EneRegion.AllZone, mode: EneMode.UserDefine, rainbow: true, rgb: [0, 0, 0], speed: EneSpeed.Normal, brightness: EneBrightness.Brightest };

/** Grid whose pixel (row, col) is R=row, G=col, B=0xA5, so every LED's bytes name the cell it sampled. */
function coordinateGrid(channels: 3 | 4) {
  const data = new Uint8Array(GRID_WIDTH * GRID_HEIGHT * channels);
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = 0; col < GRID_WIDTH; col++) {
      data.set(channels === 3 ? [row, col, 0xa5] : [row, col, 0xa5, 0xff], (row * GRID_WIDTH + col) * channels);
    }
  }
  return { width: GRID_WIDTH, height: GRID_HEIGHT, data };
}

const cells = (list: Array<[number, number]>) => list.flatMap(([row, col]) => [row, col, 0xa5]);

// 09 §7.3 "Concrete table for the 34M2C8600" (JSON R=3, RU=4, LU=4, L=3; device counts 14/18/14).
const SPEC_TABLE = [
  w(0xe300, ...cells([[30, 49], [20, 49], [10, 49]])), // Right, bottom → top
  w(0xe309, ...cells([[0, 49], [0, 43], [0, 36], [0, 30]])), // RightUp
  w(0xe315, ...cells([[0, 19], [0, 12], [0, 6], [0, 0]])), // LeftUp
  w(0xe321, ...cells([[10, 0], [20, 0], [30, 0]])), // Left, top → bottom
  w(0xe32a, ...cells([0, 2, 4, 7, 9, 11, 13, 16, 18, 20, 22, 24, 27, 29, 31, 33, 36, 38].map((row) => [row, 25] as [number, number]))),
  w(0xe360, ...cells([0, 4, 7, 11, 14, 18, 21, 25, 29, 32, 36, 39, 43, 49].map((col) => [39, col] as [number, number]))),
];

test('round half to even like .NET Convert.ToInt32(double)', () => {
  assert.deepEqual([0.5, 1.5, 2.5, 12.5, 36.5, 42.75, 30.25, 2.4999, 3.5000001].map(roundHalfEven), [0, 2, 2, 12, 36, 43, 30, 2, 4]);
});

test('frame upload for the 34M2C8600: six writes, 138 bytes E300..E389, byte-exact per 09 §7.3', async () => {
  const rig = await openRig();
  await rig.device.setEffect(followVideo);
  const m = rig.mark();
  rig.sleeps.length = 0;
  assert.equal(await rig.device.writeVideoFrame(coordinateGrid(3)), true);
  assert.deepEqual(rig.since(m), SPEC_TABLE);
  assert.deepEqual(rig.sleeps, Array(6).fill(10), 'each frame write is paced like Class0.method_4');
  // No apply/commit after frames; the buffer is contiguous and the mock shows it.
  const frame = rig.mock.state().frame;
  assert.equal(frame.length, 138);
  const expected = SPEC_TABLE.map((line) => line.split(' | ')[1]).join(' ');
  assert.equal(hex(frame), expected);
  assert.equal(hex(rig.device.ledColors()), expected, 'preview mirror is the frame actually sent');
});

test('RGBA grids (CaptureFrame layout) give the same bytes as RGB', async () => {
  const rig = await openRig();
  await rig.device.setEffect(followVideo);
  const m = rig.mark();
  await rig.device.writeVideoFrame(coordinateGrid(4));
  assert.deepEqual(rig.since(m), SPEC_TABLE);
});

test('frames are dropped unless mode 14 is applied (not before an effect, not in Static, not after lightsOff)', async () => {
  const rig = await openRig();
  const grid = coordinateGrid(3);
  let m = rig.mark();
  assert.equal(await rig.device.writeVideoFrame(grid), false);
  await rig.device.setEffect({ ...followVideo, mode: EneMode.StaticMode });
  m = rig.mark();
  assert.equal(await rig.device.writeVideoFrame(grid), false);
  assert.deepEqual(rig.since(m), []);
  await rig.device.setEffect(followVideo);
  await rig.device.lightsOff();
  m = rig.mark();
  assert.equal(await rig.device.writeVideoFrame(grid), false);
  assert.deepEqual(rig.since(m), []);
});

test('grids other than 50x40 RGB/RGBA are rejected', async () => {
  const rig = await openRig();
  await rig.device.setEffect(followVideo);
  await assert.rejects(rig.device.writeVideoFrame({ width: 40, height: 50, data: new Uint8Array(6000) }), RangeError);
  await assert.rejects(rig.device.writeVideoFrame({ width: 50, height: 40, data: new Uint8Array(100) }), RangeError);
});

test('plan for another layout: 49M2C8900L border 3/9/9/3, central 20, no bottom', () => {
  const layout = findModelLayout(LAYOUTS, '49M2C8900L');
  assert.ok(layout);
  const plan = planFrame(layout, { border: 24, central: 20, bottom: 0 });
  assert.deepEqual(plan.segments.map((s) => [s.name, s.reg.toString(16), s.cells.length]), [
    ['right', 'e300', 3],
    ['rightUp', 'e309', 9],
    ['leftUp', 'e324', 9],
    ['left', 'e33f', 3],
    ['central', 'e348', 20],
  ]);
});

test('segments are skipped when either the JSON or the device reports no LEDs for them', () => {
  const layout = findModelLayout(LAYOUTS, '34M2C8600');
  assert.ok(layout);
  assert.deepEqual(planFrame(layout, { border: 14, central: 0, bottom: 14 }).segments.map((s) => s.name), ['right', 'rightUp', 'leftUp', 'left', 'bottom']);
  const noBottom = findModelLayout(LAYOUTS, '34M2C6500');
  assert.ok(noBottom);
  assert.deepEqual(planFrame(noBottom, { border: 14, central: 18, bottom: 14 }).segments.map((s) => s.name), ['right', 'rightUp', 'leftUp', 'left', 'central']);
  const grid = coordinateGrid(3);
  assert.deepEqual(renderFrame(planFrame(layout, { border: 0, central: 0, bottom: 0 }), grid), []);
});

test('a JSON border larger than the device\'s border group but within its buffer spills into the central LEDs, as in the vendor', () => {
  const layout = findModelLayout(LAYOUTS, '34M2C8600');
  assert.ok(layout);
  const plan = planFrame(layout, { border: 12, central: 18, bottom: 0 });
  assert.deepEqual(plan.segments.map((s) => [s.name, s.reg.toString(16), s.cells.length]), [
    ['right', 'e300', 3],
    ['rightUp', 'e309', 4],
    ['leftUp', 'e315', 4],
    ['left', 'e321', 3],
    ['central', 'e324', 18], // A2 = A1 + 3·border(dev); written last, over the spilled border LEDs
  ]);
});

test('a JSON border larger than the device\'s whole frame buffer is cut at the buffer end (the vendor writes past it)', async () => {
  // Device: one group of 10 LEDs (frame buffer E300..E31D); JSON for 34M2C8600: border 3+4+4+3 = 14.
  const usb = new FakeUsbBackend({ journalLimit: Infinity });
  const mock = new MockEneDevice({ ledGroups: 1, counts: { border: 10, central: 0, bottom: 0 } });
  const info = usb.attach(mock.spec());
  const { log, lines } = recordingLog();
  const device = await EneDevice.open(usb, info, { log, layouts: LAYOUTS, writeDelayMs: 0 });
  assert.equal(device.ledCount, 10);
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes('14 border LEDs, the device reports 10')), lines.join('\n'));
  await device.setEffect(followVideo);
  const m = usb.transfers.length;
  assert.equal(await device.writeVideoFrame(coordinateGrid(3)), true);
  assert.deepEqual(usb.transfers.slice(m).map(fmt), [
    w(0xe300, ...cells([[30, 49], [20, 49], [10, 49]])),
    w(0xe309, ...cells([[0, 49], [0, 43], [0, 36], [0, 30]])),
    w(0xe315, ...cells([[0, 19], [0, 12], [0, 6]])), // LeftUp cut after 3 LEDs, Left dropped
  ]);
  assert.deepEqual(mock.violations, []);
  assert.equal(device.ledColors().length, 30);
});
