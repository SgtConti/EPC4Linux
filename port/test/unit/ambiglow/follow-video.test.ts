// FollowVideo: the 09 §7.3 grid → LED mapping on synthetic frames, and the engine's capture/upload cadence
// with a fake capture host and the real ENE driver on the simulated MCU.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findModelLayout } from '../../../src/backend/ambiglow/ene-layout.ts';
import { planFrame } from '../../../src/backend/ambiglow/ene-frame.ts';
import { EneBrightness, EneMode, EneRegion, EneSpeed } from '../../../src/backend/ambiglow/ene-registers.ts';
import {
  FOLLOW_VIDEO_CAPTURE_MS,
  FOLLOW_VIDEO_SEND_MS,
  FollowVideoEngine,
  frameLedColors,
  ledLayout,
  mapFrameToLeds,
  solidGrid,
} from '../../../src/backend/ambiglow/follow-video.ts';
import { openRig } from '../ambiglow-ene/helpers.ts';
import { FakeCaptureHost, LAYOUTS, ManualTimers, flush, rgbaFrame, silentLog } from './helpers.ts';

const LAYOUT = findModelLayout(LAYOUTS, '34M2C8600')!;
const COUNTS = { border: 14, central: 18, bottom: 14 };

/** The sampled cell of every LED, 09 §7.3 concrete table (LED 0..45). */
const CELLS: Array<[number, number]> = [
  [30, 49], [20, 49], [10, 49],
  [0, 49], [0, 43], [0, 36], [0, 30],
  [0, 19], [0, 12], [0, 6], [0, 0],
  [10, 0], [20, 0], [30, 0],
  ...[0, 2, 4, 7, 9, 11, 13, 16, 18, 20, 22, 24, 27, 29, 31, 33, 36, 38].map((row): [number, number] => [row, 25]),
  ...[0, 4, 7, 11, 14, 18, 21, 25, 29, 32, 36, 39, 43, 49].map((col): [number, number] => [39, col]),
];

const leds = (bytes: Uint8Array) => Array.from({ length: bytes.length / 3 }, (_, i) => [bytes[3 * i], bytes[3 * i + 1], bytes[3 * i + 2]]);

test('34M2C8600 layout: R3 RU4 LU4 L3 C18 B14 = 46 LEDs (09 §7.3; JSON + device counts 14/18/14)', () => {
  assert.deepEqual(ledLayout(LAYOUT, COUNTS), { right: 3, rightUp: 4, leftUp: 4, left: 3, central: 18, bottom: 14, total: 46 });
  assert.equal(CELLS.length, 46);
  const noBottom = findModelLayout(LAYOUTS, '34M2C6500')!;
  assert.equal(ledLayout(noBottom, { border: 14, central: 18, bottom: 0 }).total, 32);
});

test('solid colour frames light every LED with that colour', () => {
  for (const colour of [[255, 0, 0], [0, 255, 0], [12, 34, 56], [0, 0, 0]] as const) {
    const out = mapFrameToLeds(LAYOUT, COUNTS, rgbaFrame(() => colour));
    assert.equal(out.length, 138);
    assert.deepEqual(new Set(leds(out).map((c) => c.join(','))), new Set([colour.join(',')]));
  }
  assert.deepEqual(mapFrameToLeds(LAYOUT, COUNTS, solidGrid(1, 2, 3)).subarray(0, 6), Uint8Array.of(1, 2, 3, 1, 2, 3), 'RGB grids work too');
});

test('gradients: every LED samples the §7.3 cell (R = column ramp, G = row ramp)', () => {
  const frame = rgbaFrame((row, col) => [col * 5, row * 6, 200]);
  const out = leds(mapFrameToLeds(LAYOUT, COUNTS, frame));
  assert.deepEqual(out, CELLS.map(([row, col]) => [col * 5, row * 6, 200]));
  // Horizontal gradient: top edge runs right → left, bottom edge left → right (write order 09 §7.3).
  const top = out.slice(3, 11).map((c) => c[0] / 5);
  assert.deepEqual(top, [49, 43, 36, 30, 19, 12, 6, 0]);
  const bottom = out.slice(32).map((c) => c[0] / 5);
  assert.deepEqual(bottom, [...bottom].sort((a, b) => a - b), 'bottom row left → right');
});

test('letterbox (black bars top and bottom): the top and bottom rows and the bar parts of the centre line are dark', () => {
  const bar = 5; // rows 0..4 and 35..39
  const frame = rgbaFrame((row) => (row < bar || row >= 40 - bar ? [0, 0, 0] : [250, 120, 10]));
  const out = leds(mapFrameToLeds(LAYOUT, COUNTS, frame));
  const lit = (i: number) => out[i].some((v) => v !== 0);
  CELLS.forEach(([row], i) => assert.equal(lit(i), row >= bar && row < 40 - bar, `LED ${i} samples row ${row}`));
  assert.deepEqual([0, 1, 2, 11, 12, 13].map(lit), [true, true, true, true, true, true], 'side LEDs (rows 10/20/30) keep the picture');
  assert.ok(out.slice(32).every((c) => c.every((v) => v === 0)), 'bottom LEDs sample row 39 (bar)');
  assert.deepEqual(frameLedColors(planFrame(LAYOUT, COUNTS), frame), mapFrameToLeds(LAYOUT, COUNTS, frame));
});

test('pillarbox (bars left and right): the side LEDs are dark, top/bottom keep the picture inside the bars', () => {
  const frame = rgbaFrame((_row, col) => (col < 6 || col > 43 ? [0, 0, 0] : [9, 9, 9]));
  const out = leds(mapFrameToLeds(LAYOUT, COUNTS, frame));
  CELLS.forEach(([, col], i) => assert.equal(out[i][0], col < 6 || col > 43 ? 0 : 9, `LED ${i} col ${col}`));
});

test('bad grids are refused (the vendor needs 50×40)', () => {
  assert.throws(() => mapFrameToLeds(LAYOUT, COUNTS, { width: 40, height: 40, data: new Uint8Array(40 * 40 * 4) }), RangeError);
});

const followVideoSet = { region: EneRegion.AllZone, mode: EneMode.UserDefine, rainbow: true, rgb: [0, 0, 0] as const, speed: EneSpeed.Normal, brightness: EneBrightness.Brightest };

async function engineRig(options: { capture?: FakeCaptureHost | null } = {}) {
  const ene = await openRig();
  await ene.device.setEffect(followVideoSet);
  const timers = new ManualTimers();
  const capture = options.capture === undefined ? new FakeCaptureHost() : options.capture;
  const engine = new FollowVideoEngine({ log: silentLog, capture: capture ?? undefined, target: () => ene.device, timers });
  return { ene, timers, capture, engine };
}

test('cadence: capture requested at 300 ms, newest frame uploaded on the 100 ms tick, once (six writes per frame)', async () => {
  const { ene, timers, capture, engine } = await engineRig();
  engine.setWanted(true);
  await flush();
  assert.equal(engine.state, 'running');
  assert.deepEqual(capture!.videoStarts, [FOLLOW_VIDEO_CAPTURE_MS]);
  engine.setWanted(true);
  assert.deepEqual(capture!.videoStarts, [FOLLOW_VIDEO_CAPTURE_MS], 'idempotent: no second start (a new portal dialog on Wayland)');

  const m = ene.mark();
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.deepEqual(ene.since(m), [], 'no frame yet');

  const red = rgbaFrame(() => [255, 0, 0], 1);
  capture!.frame(red);
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(ene.since(m).length, 6, 'one frame = 6 paced writes at E300/E309/E315/E321/E32A/E360');
  assert.deepEqual(leds(ene.mock.state().frame)[45], [255, 0, 0]);

  // Same frame on the next ticks: the vendor re-sends it, the port does not.
  timers.advance(2 * FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(ene.since(m).length, 6);

  // Two frames between ticks: only the newest goes out.
  capture!.frame(rgbaFrame(() => [0, 255, 0], 2));
  capture!.frame(rgbaFrame(() => [0, 0, 255], 3));
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(ene.since(m).length, 12);
  assert.deepEqual(leds(ene.mock.state().frame)[0], [0, 0, 255]);
  assert.equal(engine.uploads, 2);

  engine.setWanted(false);
  assert.equal(capture!.videoStops, 1);
  assert.equal(timers.pending, 0, 'upload tick cleared');
  capture!.frame(rgbaFrame(() => [9, 9, 9], 4));
  timers.advance(10 * FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(ene.since(m).length, 12, 'nothing after stop');
});

test('frames are skipped while the ENE is busy, and dropped by the driver outside mode 14', async () => {
  const { ene, timers, capture, engine } = await engineRig();
  engine.setWanted(true);
  await flush();
  capture!.frame(rgbaFrame(() => [1, 1, 1], 1));
  const busy = ene.device.setEffect(followVideoSet); // a ParameterSet in flight
  assert.equal(ene.device.busy, true);
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  assert.equal(engine.uploads, 0, 'skipped, not queued');
  await busy;
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(engine.uploads, 1, 'the next tick sends it');

  await ene.device.setEffect({ ...followVideoSet, mode: EneMode.StaticMode });
  const m = ene.mark();
  capture!.frame(rgbaFrame(() => [2, 2, 2], 2));
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.deepEqual(ene.since(m), [], 'writeVideoFrame refuses frames unless mode 14 is applied');
});

test('a refused capture start is not retried until FollowVideo is left and selected again, or the owner asks once', async () => {
  const capture = new FakeCaptureHost();
  capture.videoResult = false;
  const { engine, timers } = await engineRig({ capture });
  engine.setWanted(true);
  await flush();
  assert.equal(engine.state, 'failed');
  assert.equal(timers.pending, 0, 'no upload tick without a session');
  engine.setWanted(true);
  assert.deepEqual(capture.videoStarts, [300], 'no retry (Wayland would show the portal again)');
  engine.setWanted(true, { retry: true });
  await flush();
  assert.deepEqual(capture.videoStarts, [300, 300], 'one more attempt when asked (the service does on a wake)');
  assert.equal(engine.state, 'failed');
  engine.setWanted(false);
  capture.videoResult = true;
  engine.setWanted(true);
  await flush();
  assert.deepEqual(capture.videoStarts, [300, 300, 300]);
  assert.equal(engine.state, 'running');
  assert.equal(engine.starts, 3);
  engine.setWanted(true, { retry: true });
  assert.equal(engine.starts, 3, 'retry only acts on a failed session');
});

test('pause holds the uploads back but keeps the capture session; resuming re-sends the newest frame', async () => {
  const { ene, timers, capture, engine } = await engineRig();
  engine.setWanted(true);
  await flush();
  capture!.frame(rgbaFrame(() => [5, 5, 5], 1));
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(engine.uploads, 1);
  engine.setPaused(true);
  assert.equal(engine.paused, true);
  capture!.frame(rgbaFrame(() => [6, 6, 6], 2));
  timers.advance(5 * FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(engine.uploads, 1, 'nothing while paused');
  assert.equal(capture!.videoStops, 0, 'the session (and its portal consent) is kept');
  assert.equal(engine.state, 'running');
  engine.setPaused(false);
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(engine.uploads, 2);
  assert.deepEqual(leds(ene.mock.state().frame)[0], [6, 6, 6]);
  // Resuming without a new frame re-sends the last one (the LEDs were re-applied meanwhile).
  engine.setPaused(true);
  engine.setPaused(false);
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(engine.uploads, 3);
  assert.deepEqual(capture!.videoStarts, [FOLLOW_VIDEO_CAPTURE_MS]);
});

test('a stop while the capture start is pending (portal dialog open) ends it: no frames, no stale session', async () => {
  const capture = new FakeCaptureHost();
  let open!: () => void;
  capture.videoGate = new Promise<void>((resolve) => (open = resolve));
  const { engine, timers } = await engineRig({ capture });
  engine.setWanted(true);
  assert.equal(engine.state, 'starting');
  engine.setWanted(false);
  assert.equal(capture.videoStops, 1, 'the pending start is withdrawn (the host releases the dialog)');
  assert.equal(timers.pending, 0);
  open();
  await flush();
  assert.equal(engine.state, 'stopped', 'the late answer of the withdrawn start is ignored');
  assert.equal(capture.videoActive, false);
});

test('without a capture host FollowVideo is inert', async () => {
  const { engine, timers } = await engineRig({ capture: null });
  engine.setWanted(true);
  assert.equal(engine.state, 'failed');
  assert.equal(timers.pending, 0);
});
