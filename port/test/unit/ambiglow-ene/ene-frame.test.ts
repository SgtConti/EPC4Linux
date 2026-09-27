import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRID_HEIGHT, GRID_WIDTH, burstFrameWrite, dimFrameWrites, planFrame, renderFrame, roundHalfEven } from '../../../src/backend/ambiglow/ene-frame.ts';
import { findModelLayout } from '../../../src/backend/ambiglow/ene-layout.ts';
import { EneMode, EneRegion, EneSpeed, EneBrightness } from '../../../src/backend/ambiglow/ene-registers.ts';
import type { EneParameterSet } from '../../../src/backend/ambiglow/ene-params.ts';
import { FakeUsbBackend } from '../../../src/backend/usb/fake-backend.ts';
import { ENE_FRAME_BURST_ENV, ENE_FRAME_BURST_MAX_FAILURES, EneDevice, eneFrameBurstFromEnv } from '../../../src/backend/ambiglow/ene.ts';
import { MOCK_ENE_FRAME_WRITE_HISTORY, MockEneDevice } from '../../../src/backend/ambiglow/mock-ene.ts';
import { UsbError } from '../../../src/backend/usb/errors.ts';
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

// ── experimental frame burst (EneDeviceOptions.frameBurst, EVNIA_ENE_FRAME_BURST=1; 09 plan A.7) ──

test('burstFrameWrite: contiguous segments become one write; a gap or an overlap keeps the segments', () => {
  const layout = findModelLayout(LAYOUTS, '34M2C8600');
  assert.ok(layout);
  const writes = renderFrame(planFrame(layout, { border: 14, central: 18, bottom: 14 }), coordinateGrid(3));
  const burst = burstFrameWrite(writes);
  assert.ok(burst);
  assert.equal(burst.reg, 0xe300);
  assert.equal(burst.data.length, 138, '9+12+12+9+54+42 bytes, E300..E389');
  assert.equal(hex(burst.data), SPEC_TABLE.map((line) => line.split(' | ')[1]).join(' '), 'the six segments back to back');
  // A JSON border larger than the device's border group overlaps the central write: not merged.
  assert.equal(burstFrameWrite(renderFrame(planFrame(layout, { border: 12, central: 18, bottom: 0 }), coordinateGrid(3))), null);
  assert.equal(burstFrameWrite([{ reg: 0xe300, data: new Uint8Array(3) }, { reg: 0xe309, data: new Uint8Array(3) }]), null, 'a gap');
  assert.equal(burstFrameWrite([]), null);
});

test('frameBurst: one paced 138-byte transfer at 0xE300 with the same bytes, inside the frame-buffer window; off by default', async () => {
  const rig = await openRig({}, { frameBurst: true });
  await rig.device.setEffect(followVideo);
  const m = rig.mark();
  rig.sleeps.length = 0;
  assert.equal(await rig.device.writeVideoFrame(coordinateGrid(4)), true);
  const expected = SPEC_TABLE.map((line) => line.split(' | ')[1]).join(' ');
  assert.deepEqual(rig.since(m), [`40 80 0000 E300 008A | ${expected}`], 'one control transfer, wLength 138');
  assert.deepEqual(rig.sleeps, [10], 'paced once');
  assert.equal(hex(rig.mock.state().frame), expected, 'the MCU holds the same frame as after six writes');
  assert.equal(hex(rig.device.ledColors()), expected);
  assert.deepEqual(rig.mock.violations, [], 'every byte on an allowed register of the mock');
  // Default: the vendor's six writes.
  const plain = await openRig();
  await plain.device.setEffect(followVideo);
  const p = plain.mark();
  await plain.device.writeVideoFrame(coordinateGrid(3));
  assert.equal(plain.since(p).length, 6);
});

test('frameBurst with non-contiguous segments falls back to the segment writes (logged once)', async () => {
  const usb = new FakeUsbBackend({ journalLimit: Infinity });
  // Border group of 12 while the JSON border is 14: the central write overlaps the spilled border LEDs.
  const mock = new MockEneDevice({ counts: { border: 12, central: 18, bottom: 14 } });
  const info = usb.attach(mock.spec());
  const { log, lines } = recordingLog();
  const device = await EneDevice.open(usb, info, { log, layouts: LAYOUTS, writeDelayMs: 0, frameBurst: true });
  await device.setEffect(followVideo);
  const m = usb.transfers.length;
  await device.writeVideoFrame(coordinateGrid(3));
  await device.writeVideoFrame(coordinateGrid(3));
  assert.equal(usb.transfers.slice(m).length, 12, 'six writes per frame');
  assert.equal(lines.filter((l) => l.includes('frame burst off')).length, 1, lines.join('\n'));
});

test('frameBurst refused by the controller (a firmware that stalls data stages over one 64-byte packet): warned once naming the switch, the six paced writes again after ENE_FRAME_BURST_MAX_FAILURES in a row', async () => {
  const usb = new FakeUsbBackend({ journalLimit: Infinity });
  const mock = new MockEneDevice();
  let refuseLong = true;
  const info = usb.attach({
    ...mock.spec({ busNumber: 3, portNumbers: [2, 1] }),
    handler: {
      controlIn: (setup, length) => mock.controlIn(setup, length),
      controlOut: (setup, data) => {
        if (refuseLong && data.length > 64) throw new Error('EP0 data stage stalled');
        mock.controlOut(setup, data);
      },
    },
  });
  const { log, lines } = recordingLog();
  const device = await EneDevice.open(usb, info, { log, layouts: LAYOUTS, writeDelayMs: 0, frameBurst: true });
  await device.setEffect(followVideo);
  const burstWarnings = () => lines.filter((l) => l.startsWith('warn') && l.includes('EVNIA_ENE_FRAME_BURST=1') && l.includes('failed:'));
  const stall = (e: unknown) => e instanceof UsbError && e.code === 'stall';
  assert.equal(ENE_FRAME_BURST_MAX_FAILURES, 3);

  // Two failures, then a success: the count starts again.
  await assert.rejects(device.writeVideoFrame(coordinateGrid(3)), stall);
  assert.equal(burstWarnings().length, 1, lines.join('\n'));
  assert.match(burstWarnings()[0], /EP0 data stage stalled/);
  await assert.rejects(device.writeVideoFrame(coordinateGrid(3)), stall);
  refuseLong = false;
  let m = usb.transfers.length;
  assert.equal(await device.writeVideoFrame(coordinateGrid(3)), true);
  assert.equal(usb.transfers.slice(m).length, 1, 'still the burst');
  refuseLong = true;

  // Three in a row: switched off (logged), the device is not lost, and the next frame is the vendor's six writes.
  for (let i = 0; i < ENE_FRAME_BURST_MAX_FAILURES; i++) await assert.rejects(device.writeVideoFrame(coordinateGrid(3)), stall);
  assert.equal(burstWarnings().length, 1, 'the failure warning is logged once');
  assert.equal(lines.filter((l) => l.startsWith('warn') && l.includes('switched off')).length, 1, lines.join('\n'));
  assert.equal(device.lost, false);
  m = usb.transfers.length;
  assert.equal(await device.writeVideoFrame(coordinateGrid(4)), true);
  assert.deepEqual(usb.transfers.slice(m).map(fmt), SPEC_TABLE, 'six paced writes from now on');
  assert.equal(hex(mock.state().frame), SPEC_TABLE.map((line) => line.split(' | ')[1]).join(' '));
  assert.equal(device.frameBurst, false, 'given up');
  assert.match(lines.find((l) => l.includes('switched off'))!, /the setting is kept; untick "Fast LED upload \(experimental\)" on the Ambiglow page, or unset EVNIA_ENE_FRAME_BURST/);

  // Switching it on again (the user re-ticks the checkbox) re-arms it with a fresh count and a fresh warning.
  refuseLong = false;
  device.setFrameBurst(true);
  assert.equal(device.frameBurst, true);
  m = usb.transfers.length;
  assert.equal(await device.writeVideoFrame(coordinateGrid(4)), true);
  assert.equal(usb.transfers.slice(m).length, 1, 'the burst again');
  refuseLong = true;
  await assert.rejects(device.writeVideoFrame(coordinateGrid(3)), stall);
  assert.equal(burstWarnings().length, 2, 'warned again after the re-arm');
  assert.deepEqual(mock.violations, []);
});

test('frameBurst: a device that went away is not the burst\'s failure (no burst warning; the device is lost)', async () => {
  const { log, lines } = recordingLog();
  const rig = await openRig({}, { frameBurst: true, log });
  await rig.device.setEffect(followVideo);
  rig.usb.detach(rig.device.info);
  await assert.rejects(rig.device.writeVideoFrame(coordinateGrid(3)), (e: unknown) => e instanceof UsbError && e.code === 'no-device');
  assert.equal(rig.device.lost, true);
  assert.deepEqual(lines.filter((l) => l.includes('frame burst')), [], lines.join('\n'));
});

test('eneFrameBurstFromEnv: EVNIA_ENE_FRAME_BURST=1 only', () => {
  assert.equal(ENE_FRAME_BURST_ENV, 'EVNIA_ENE_FRAME_BURST');
  assert.equal(eneFrameBurstFromEnv({ EVNIA_ENE_FRAME_BURST: '1' }), true);
  assert.equal(eneFrameBurstFromEnv({ EVNIA_ENE_FRAME_BURST: ' 1 ' }), true);
  for (const v of [undefined, '', '0', 'true', 'yes', '2']) assert.equal(eneFrameBurstFromEnv({ EVNIA_ENE_FRAME_BURST: v }), false, String(v));
  assert.equal(eneFrameBurstFromEnv({}), false);
});

// ── host-side brightness (VideoFrameOptions.gain; the FollowVideo Brightness slider) and the runtime burst switch ──

/** The SPEC_TABLE bytes of the coordinate grid (R = row, G = col, B = 0xA5), each × gain and rounded. */
function dimmedSpecBytes(gain: number): string {
  const bytes = SPEC_TABLE.map((line) => line.split(' | ')[1]).join(' ').split(' ').map((b) => parseInt(b, 16));
  return hex(bytes.map((b) => Math.round(b * gain)));
}

test('dimFrameWrites: every byte × gain, rounded to the nearest integer; gain 1 (or above, or NaN) unchanged, 0 or below black', () => {
  const writes = [{ reg: 0xe300, data: Uint8Array.of(0, 1, 2, 3, 150, 151, 255) }];
  assert.deepEqual([...dimFrameWrites(writes, 2 / 3)[0].data], [0, 1, 1, 2, 100, 101, 170]);
  assert.deepEqual([...dimFrameWrites(writes, 1 / 3)[0].data], [0, 0, 1, 1, 50, 50, 85]);
  for (const gain of [1, 1.5, Number.NaN]) assert.equal(dimFrameWrites(writes, gain)[0], writes[0], `gain ${gain}: the same write`);
  for (const gain of [0, -1]) assert.deepEqual([...dimFrameWrites(writes, gain)[0].data], [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...writes[0].data], [0, 1, 2, 3, 150, 151, 255], 'the input is not modified');
  assert.equal(dimFrameWrites(writes, 2 / 3)[0].reg, 0xe300);
});

test('writeVideoFrame gain: the six writes carry the dimmed bytes, the mirror too; with the burst the one transfer does', async () => {
  const rig = await openRig();
  await rig.device.setEffect(followVideo);
  let m = rig.mark();
  assert.equal(await rig.device.writeVideoFrame(coordinateGrid(4), { gain: 2 / 3 }), true);
  const sent = rig.since(m);
  assert.equal(sent.length, 6);
  assert.equal(sent.map((line) => line.split(' | ')[1]).join(' '), dimmedSpecBytes(2 / 3), 'the §7.3 bytes x 2/3');
  assert.equal(hex(rig.mock.state().frame), dimmedSpecBytes(2 / 3));
  assert.equal(hex(rig.device.ledColors()), dimmedSpecBytes(2 / 3), 'Effect_GetLEDs mirror = what the LEDs show');
  await rig.device.writeVideoFrame(coordinateGrid(4));
  assert.equal(hex(rig.device.ledColors()), dimmedSpecBytes(1), 'no gain: the grid as it is');

  const burst = await openRig({}, { frameBurst: true });
  await burst.device.setEffect(followVideo);
  m = burst.mark();
  await burst.device.writeVideoFrame(coordinateGrid(3), { gain: 1 / 3 });
  assert.deepEqual(burst.since(m), [`40 80 0000 E300 008A | ${dimmedSpecBytes(1 / 3)}`]);
  assert.equal(hex(burst.device.ledColors()), dimmedSpecBytes(1 / 3));
  assert.deepEqual([rig.mock.violations, burst.mock.violations], [[], []]);
});

test('setFrameBurst switches between the six writes and the one transfer from the next frame, without touching the effect', async () => {
  const rig = await openRig();
  await rig.device.setEffect(followVideo);
  assert.equal(rig.device.frameBurst, false, 'off by default');
  const frame = async () => {
    const m = rig.mark();
    assert.equal(await rig.device.writeVideoFrame(coordinateGrid(3)), true);
    return rig.since(m);
  };
  assert.equal((await frame()).length, 6);
  rig.device.setFrameBurst(true);
  assert.equal(rig.device.frameBurst, true);
  assert.deepEqual((await frame()).map((l) => l.slice(0, 20)), ['40 80 0000 E300 008A']);
  // A frame queued while the switch changes goes out as the switch stands when its turn comes.
  const busy = rig.device.setEffect(followVideo);
  const queued = rig.device.writeVideoFrame(coordinateGrid(3));
  rig.device.setFrameBurst(false);
  const m = rig.mark();
  await busy;
  await queued;
  assert.equal(rig.since(m).filter((l) => l.startsWith('40 80 0000 E3')).length, 6, 'switched off before its turn: six writes');
  assert.equal(rig.device.frameBurst, false);
  assert.equal(hex(rig.mock.state().frame), SPEC_TABLE.map((line) => line.split(' | ')[1]).join(' '));
  assert.equal(rig.device.applied?.mode, EneMode.UserDefine, 'the effect is untouched');
  assert.deepEqual(rig.mock.violations, []);
});

test('mock ENE: recentFrameWrites lists the frame-buffer writes as [register, length] (six segments, or one burst), bounded', async () => {
  const rig = await openRig();
  await rig.device.setEffect(followVideo);
  assert.equal(rig.mock.frameWriteCount, 0, 'a ParameterSet is no frame write');
  await rig.device.writeVideoFrame(coordinateGrid(3));
  assert.deepEqual(rig.mock.recentFrameWrites(), [[0xe300, 9], [0xe309, 12], [0xe315, 12], [0xe321, 9], [0xe32a, 54], [0xe360, 42]]);
  rig.device.setFrameBurst(true);
  for (let i = 0; i < 30; i++) await rig.device.writeVideoFrame(coordinateGrid(3));
  assert.equal(rig.mock.frameWriteCount, 36);
  const recent = rig.mock.recentFrameWrites();
  assert.equal(recent.length, MOCK_ENE_FRAME_WRITE_HISTORY);
  assert.ok(recent.every(([reg, length]) => reg === 0xe300 && length === 138));
});
