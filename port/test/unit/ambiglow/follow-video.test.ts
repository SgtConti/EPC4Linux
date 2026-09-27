// FollowVideo: the 09 §7.3 grid → LED mapping on synthetic frames, and the engine's capture/upload cadence per
// speed tier (Low = the vendor's fixed tick; Normal/High event-driven, newest frame wins; live retune without a
// new capture session; the kept session slowed while paused) with a fake capture host, the real ENE driver on the
// simulated MCU and a controllable ENE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findModelLayout } from '../../../src/backend/ambiglow/ene-layout.ts';
import { planFrame } from '../../../src/backend/ambiglow/ene-frame.ts';
import { EneBrightness, EneMode, EneRegion, EneSpeed } from '../../../src/backend/ambiglow/ene-registers.ts';
import type { CaptureFrame, CaptureHost } from '../../../src/backend/types.ts';
import type { EneDevice } from '../../../src/backend/ambiglow/ene.ts';
import {
  FOLLOW_VIDEO_BRIGHTNESS_NAMES,
  FOLLOW_VIDEO_BUSY_RETRY_MS,
  FOLLOW_VIDEO_CADENCES,
  FOLLOW_VIDEO_CAPTURE_MS,
  FOLLOW_VIDEO_DEFAULT_BRIGHTNESS,
  FOLLOW_VIDEO_DEFAULT_SPEED,
  FOLLOW_VIDEO_PAUSED_CAPTURE_MS,
  FOLLOW_VIDEO_SEND_MS,
  FollowVideoEngine,
  describeCadence,
  followVideoBrightness,
  followVideoCadence,
  followVideoGain,
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

/** The real driver on the simulated MCU behind the engine; `speed` is EffectDetail.Speed (default: Normal). */
async function engineRig(options: { capture?: FakeCaptureHost | null; speed?: number } = {}) {
  const ene = await openRig();
  await ene.device.setEffect(followVideoSet);
  const timers = new ManualTimers();
  const capture = options.capture === undefined ? new FakeCaptureHost() : options.capture;
  const engine = new FollowVideoEngine({ log: silentLog, capture: capture ?? undefined, target: () => ene.device, timers, speed: options.speed });
  return { ene, timers, capture, engine };
}

/**
 * An ENE stand-in whose uploads finish when the test says so (the real driver finishes them within a few
 * microtasks with instant pacing), and which another operation (a ParameterSet) can hold busy.
 */
class FakeEne {
  readonly frames: CaptureFrame[] = [];
  /** The brightness gain each upload was asked for (VideoFrameOptions.gain). */
  readonly gains: number[] = [];
  closed = false;
  lost = false;
  #ops = 0;
  readonly #uploads: Array<() => void> = [];

  get busy(): boolean {
    return this.#ops > 0;
  }

  /** Another operation holds the device until the returned function is called. */
  hold(): () => void {
    this.#ops++;
    let done = false;
    return () => {
      if (!done) this.#ops--;
      done = true;
    };
  }

  writeVideoFrame(frame: CaptureFrame, options: { gain?: number } = {}): Promise<boolean> {
    this.frames.push(frame);
    this.gains.push(options.gain ?? 1);
    this.#ops++;
    return new Promise((resolve) =>
      this.#uploads.push(() => {
        this.#ops--;
        resolve(true);
      }),
    );
  }

  /** Finish the upload in flight (the six paced writes went out). */
  finish(): void {
    this.#uploads.shift()?.();
  }

  get inFlight(): number {
    return this.#uploads.length;
  }
}

function fakeEngine(options: { speed?: number; capture?: CaptureHost } = {}) {
  const capture = new FakeCaptureHost();
  const timers = new ManualTimers();
  const ene = new FakeEne();
  let present = true;
  const engine = new FollowVideoEngine({
    log: silentLog,
    capture: options.capture ?? capture,
    target: () => (present ? (ene as unknown as EneDevice) : null),
    timers,
    speed: options.speed,
  });
  return { capture, timers, ene, engine, setPresent: (p: boolean) => (present = p) };
}

test('speed tiers: 1 Low = the vendor 300/100 ms, 2 Normal 100 ms event-driven, 3 High 40 ms event-driven; anything else is Normal', () => {
  assert.deepEqual(FOLLOW_VIDEO_CADENCES[1], { speed: 1, name: 'Low', captureMs: FOLLOW_VIDEO_CAPTURE_MS, sendMs: FOLLOW_VIDEO_SEND_MS });
  assert.deepEqual([FOLLOW_VIDEO_CAPTURE_MS, FOLLOW_VIDEO_SEND_MS], [300, 100], 'EffectTimerMgr Thread.Sleep(300) / Sleep(100)');
  assert.deepEqual(FOLLOW_VIDEO_CADENCES[2], { speed: 2, name: 'Normal', captureMs: 100, sendMs: null });
  assert.deepEqual(FOLLOW_VIDEO_CADENCES[3], { speed: 3, name: 'High', captureMs: 40, sendMs: null });
  assert.equal(FOLLOW_VIDEO_DEFAULT_SPEED, 2);
  for (const speed of [1, 2, 3] as const) assert.equal(followVideoCadence(speed), FOLLOW_VIDEO_CADENCES[speed]);
  for (const other of [undefined, null, 0, -1, 4, 7, 2.5, '2', NaN, {}]) {
    assert.equal(followVideoCadence(other), FOLLOW_VIDEO_CADENCES[2], `${String(other)} → Normal`);
  }
  assert.equal(new FollowVideoEngine({ log: silentLog, target: () => null }).cadence.name, 'Normal', 'the default tier');
  assert.equal(new FollowVideoEngine({ log: silentLog, target: () => null, speed: 3 }).cadence.name, 'High');
  assert.equal(describeCadence(FOLLOW_VIDEO_CADENCES[1]), 'screen capture every 300 ms, LED upload every 100 ms');
  assert.equal(describeCadence(FOLLOW_VIDEO_CADENCES[3]), 'screen capture every 40 ms, LED upload of every new frame');
});

test('Low cadence (vendor): capture requested at 300 ms, newest frame uploaded on the 100 ms tick, once (six writes per frame)', async () => {
  const { ene, timers, capture, engine } = await engineRig({ speed: 1 });
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
  await flush();
  assert.deepEqual(ene.since(m), [], 'Low: a frame waits for the tick');
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

test('Low: frames are skipped while the ENE is busy, and dropped by the driver outside mode 14', async () => {
  const { ene, timers, capture, engine } = await engineRig({ speed: 1 });
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

test('Normal (default) on the real driver: capture every 100 ms, each new frame at once (six writes), no upload tick', async () => {
  const { ene, timers, capture, engine } = await engineRig();
  engine.setWanted(true);
  await flush();
  assert.deepEqual(capture!.videoStarts, [100]);
  assert.equal(timers.pending, 0, 'event-driven: no timer');
  const m = ene.mark();
  capture!.frame(rgbaFrame(() => [3, 4, 5], 1));
  await flush();
  assert.equal(ene.since(m).length, 6);
  assert.deepEqual(leds(ene.mock.state().frame)[20], [3, 4, 5]);
  // Three frames at once: the first goes out, the newest follows, the middle one is never sent.
  capture!.frame(rgbaFrame(() => [1, 0, 0], 2));
  capture!.frame(rgbaFrame(() => [0, 1, 0], 3));
  capture!.frame(rgbaFrame(() => [0, 0, 1], 4));
  await flush(10);
  assert.equal(ene.since(m).length, 18, 'two more frames, not three');
  assert.deepEqual(leds(ene.mock.state().frame)[0], [0, 0, 1]);
  assert.equal(engine.uploads, 3);
  assert.deepEqual(ene.mock.violations, []);
});

test('event-driven uploads, newest frame wins: one upload at a time, frames arriving meanwhile replace each other, nothing is queued', async () => {
  const { capture, ene, engine } = fakeEngine({ speed: 3 });
  engine.setWanted(true);
  await flush();
  assert.deepEqual(capture.videoStarts, [40]);
  const a = rgbaFrame(() => [1, 1, 1], 1);
  const b = rgbaFrame(() => [2, 2, 2], 2);
  const c = rgbaFrame(() => [3, 3, 3], 3);
  capture.frame(a);
  assert.deepEqual(ene.frames, [a], 'sent as soon as it arrived');
  capture.frame(b);
  capture.frame(c);
  assert.deepEqual(ene.frames, [a], 'the upload of A runs: B and C wait');
  ene.finish();
  await flush();
  assert.deepEqual(ene.frames, [a, c], 'C, the newest, follows A; B was replaced before it could go out');
  ene.finish();
  await flush();
  assert.deepEqual(ene.frames, [a, c], 'nothing left to send');
  assert.equal(ene.inFlight, 0);
  capture.frame(c);
  await flush();
  assert.equal(ene.frames.length, 2, 'a frame is sent once');
  assert.equal(engine.uploads, 2);
});

test('event-driven: a frame held back by a busy ENE (a ParameterSet) is retried every FOLLOW_VIDEO_BUSY_RETRY_MS; the newest one goes; stop cancels the retry', async () => {
  const { capture, timers, ene, engine } = fakeEngine();
  engine.setWanted(true);
  await flush();
  const release = ene.hold();
  const d = rgbaFrame(() => [4, 4, 4], 1);
  const e = rgbaFrame(() => [5, 5, 5], 2);
  capture.frame(d);
  assert.deepEqual(ene.frames, [], 'the ENE is busy with something else: not queued behind it');
  assert.equal(timers.pending, 1, 'one retry scheduled');
  capture.frame(e);
  assert.equal(timers.pending, 1, 'still one retry');
  timers.advance(FOLLOW_VIDEO_BUSY_RETRY_MS);
  await flush();
  assert.deepEqual(ene.frames, [], 'still busy');
  release();
  timers.advance(FOLLOW_VIDEO_BUSY_RETRY_MS);
  await flush();
  assert.deepEqual(ene.frames, [e], 'the newest frame, once the ENE is free');
  ene.finish();
  await flush();

  const release2 = ene.hold();
  capture.frame(rgbaFrame(() => [6, 6, 6], 3));
  assert.equal(timers.pending, 1);
  engine.setWanted(false);
  assert.equal(timers.pending, 0, 'the retry is cancelled with the session');
  release2();
  timers.advance(10 * FOLLOW_VIDEO_BUSY_RETRY_MS);
  await flush();
  assert.equal(ene.frames.length, 1);
});

test('live retune: a speed change keeps the capture session (setVideoInterval) and switches between tick and event-driven uploads at once', async () => {
  const { capture, timers, ene, engine } = fakeEngine();
  engine.setWanted(true);
  await flush();
  assert.deepEqual([capture.videoStarts, engine.cadence.name], [[100], 'Normal']);

  engine.setSpeed(3);
  assert.equal(engine.cadence.name, 'High');
  assert.deepEqual(capture.videoIntervals, [40], 'CaptureHost.setVideoInterval(40)');
  assert.equal(capture.videoIntervalMs, 40);
  assert.deepEqual(capture.videoStarts, [100], 'no new session (no portal dialog on Wayland)');
  assert.equal(capture.videoStops, 0);
  assert.equal(engine.retunes, 1);
  assert.equal(engine.state, 'running');
  engine.setSpeed(3);
  assert.equal(engine.retunes, 1, 'idempotent');

  engine.setSpeed(1);
  assert.deepEqual(capture.videoIntervals, [40, 300]);
  assert.equal(timers.pending, 1, 'Low: the 100 ms upload tick');
  const x = rgbaFrame(() => [7, 7, 7], 1);
  capture.frame(x);
  await flush();
  assert.deepEqual(ene.frames, [], 'Low: waits for the tick');
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  assert.deepEqual(ene.frames, [x]);
  ene.finish();
  await flush();

  const y = rgbaFrame(() => [8, 8, 8], 2);
  capture.frame(y);
  engine.setSpeed(2);
  assert.deepEqual(capture.videoIntervals, [40, 300, 100]);
  assert.equal(timers.pending, 0, 'the tick is gone');
  assert.deepEqual(ene.frames, [x, y], 'switching to event-driven sends the waiting frame at once');
  for (const same of [undefined, 0, 9, 2]) engine.setSpeed(same);
  assert.equal(engine.retunes, 3, 'unknown speeds are Normal: no change');
  assert.deepEqual(capture.videoStarts, [100], 'one session throughout');
});

test('a capture host without setVideoInterval (older fakes): the speed still changes the uploads, the session is kept, nothing throws', async () => {
  const frames: Array<(f: CaptureFrame) => void> = [];
  let starts = 0;
  let stops = 0;
  const legacy: CaptureHost = {
    startVideo: async (_ms, onFrame) => {
      starts++;
      frames.push(onFrame);
      return true;
    },
    stopVideo: () => {
      stops++;
    },
    startAudio: async () => false,
    stopAudio: () => {},
  };
  const { timers, ene, engine } = fakeEngine({ capture: legacy });
  engine.setWanted(true);
  await flush();
  engine.setSpeed(1);
  assert.equal(engine.cadence.name, 'Low');
  assert.equal(engine.retunes, 0);
  assert.deepEqual([starts, stops], [1, 0]);
  assert.equal(timers.pending, 1);
  frames[0](rgbaFrame(() => [1, 2, 3], 1));
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  assert.equal(ene.frames.length, 1);
});

test('setSpeed while stopped applies at the next start; while starting the pending session is retuned; a failed session is not', async () => {
  const { capture, engine } = fakeEngine();
  engine.setSpeed(3);
  assert.deepEqual(capture.videoIntervals, [], 'nothing captured: nothing to retune');
  engine.setWanted(true);
  await flush();
  assert.deepEqual(capture.videoStarts, [40], 'the start asks the new interval');
  engine.setWanted(false);

  let open!: () => void;
  capture.videoGate = new Promise<void>((resolve) => (open = resolve));
  engine.setWanted(true);
  assert.equal(engine.state, 'starting');
  engine.setSpeed(1);
  assert.deepEqual(capture.videoIntervals, [300], 'the host retunes the start in flight (a portal dialog may be open)');
  open();
  await flush();
  assert.equal(engine.state, 'running');
  assert.deepEqual(capture.videoStarts, [40, 40]);
  engine.setWanted(false);

  capture.videoGate = null;
  capture.videoResult = false;
  engine.setWanted(true);
  await flush();
  assert.equal(engine.state, 'failed');
  engine.setSpeed(2);
  assert.deepEqual(capture.videoIntervals, [300], 'no session to retune');
  capture.videoResult = true;
  engine.setWanted(true, { retry: true });
  await flush();
  assert.deepEqual(capture.videoStarts, [40, 40, 300, 100]);
});

test('a refused capture start is not retried until FollowVideo is left and selected again, or the owner asks once', async () => {
  const capture = new FakeCaptureHost();
  capture.videoResult = false;
  const { engine, timers } = await engineRig({ capture, speed: 1 });
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

test('Low: pause holds the uploads back but keeps the capture session; resuming re-sends the newest frame', async () => {
  const { ene, timers, capture, engine } = await engineRig({ speed: 1 });
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

test('event-driven: pause (idle, ENE away) holds the uploads and keeps the session; resume sends the newest frame at once', async () => {
  const { capture, timers, ene, engine, setPresent } = fakeEngine();
  engine.setWanted(true);
  await flush();
  const a = rgbaFrame(() => [1, 1, 1], 1);
  capture.frame(a);
  ene.finish();
  await flush();
  engine.setPaused(true);
  const b = rgbaFrame(() => [2, 2, 2], 2);
  capture.frame(b);
  timers.advance(1000);
  await flush();
  assert.deepEqual(ene.frames, [a], 'nothing while paused');
  assert.equal(capture.videoStops, 0);
  engine.setPaused(false);
  assert.deepEqual(ene.frames, [a, b], 'the newest frame at once');
  ene.finish();
  await flush();
  engine.setPaused(true);
  engine.setPaused(false);
  assert.deepEqual(ene.frames, [a, b, b], 'the LEDs were re-applied: the last frame again');
  ene.finish();
  await flush();
  // No usable ENE (away, re-opening): nothing is sent and nothing is scheduled; it resumes via setPaused.
  setPresent(false);
  capture.frame(rgbaFrame(() => [3, 3, 3], 3));
  assert.equal(timers.pending, 0);
  assert.equal(ene.frames.length, 3);
  setPresent(true);
  engine.setPaused(true);
  engine.setPaused(false);
  assert.equal(ene.frames.length, 4);
  assert.deepEqual(capture.videoStarts, [100]);
});

test('pause slows the kept capture session to 1 fps (same session, no portal dialog); resume restores the tier; a speed change while paused applies on resume', async () => {
  const { capture, timers, ene, engine } = fakeEngine({ speed: 3 });
  engine.setWanted(true);
  await flush();
  assert.deepEqual([capture.videoStarts, engine.captureIntervalMs], [[40], 40]);
  const a = rgbaFrame(() => [1, 1, 1], 1);
  capture.frame(a);
  ene.finish();
  await flush();

  engine.setPaused(true);
  assert.equal(FOLLOW_VIDEO_PAUSED_CAPTURE_MS, 1000);
  assert.deepEqual(capture.videoIntervals, [FOLLOW_VIDEO_PAUSED_CAPTURE_MS], 'High (25 fps) → 1 fps while idle or the ENE is away');
  assert.equal(engine.captureIntervalMs, 1000);
  engine.setPaused(true);
  assert.deepEqual(capture.videoIntervals, [1000], 'idempotent');
  // The speed changes while paused (a theme switch during idle): the uploads follow at once, the capture on resume.
  engine.setSpeed(1);
  assert.equal(engine.cadence.name, 'Low');
  assert.deepEqual(capture.videoIntervals, [1000], 'still slow while paused');
  assert.equal(timers.pending, 1, 'the Low tick is armed');
  const b = rgbaFrame(() => [2, 2, 2], 2);
  capture.frame(b);
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  assert.deepEqual(ene.frames, [a], 'no uploads while paused');

  engine.setPaused(false);
  assert.deepEqual(capture.videoIntervals, [1000, 300], 'resume: the interval of the tier now in use (Low)');
  assert.equal(engine.captureIntervalMs, 300);
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  assert.deepEqual(ene.frames, [a, b], 'the newest frame on the next tick');
  ene.finish();
  await flush();
  engine.setSpeed(2);
  engine.setPaused(true);
  engine.setPaused(false);
  assert.deepEqual(capture.videoIntervals, [1000, 300, 100, 1000, 100]);
  assert.equal(engine.retunes, 5);
  assert.deepEqual([capture.videoStarts, capture.videoStops], [[40], 0], 'one capture session throughout');
  assert.equal(engine.state, 'running');

  engine.setWanted(false);
  assert.equal(engine.captureIntervalMs, null);
  engine.setPaused(true);
  engine.setPaused(false);
  assert.equal(engine.retunes, 5, 'nothing to retune without a session');
});

test('a start while paused asks the paused interval, and the resume retunes it to the tier (the service resumes first, see service-ene/idle tests)', async () => {
  const { capture, engine } = fakeEngine();
  engine.setPaused(true);
  assert.deepEqual(capture.videoIntervals, [], 'no session yet');
  engine.setWanted(true);
  await flush();
  assert.deepEqual(capture.videoStarts, [FOLLOW_VIDEO_PAUSED_CAPTURE_MS]);
  engine.setPaused(false);
  assert.deepEqual(capture.videoIntervals, [100]);
  assert.deepEqual(capture.videoStarts, [1000], 'the same session');

  // A retune that fails (host without setVideoInterval, or one that throws) is tried again on the next change.
  const throwing = new FakeCaptureHost();
  let fail = true;
  const original = throwing.setVideoInterval.bind(throwing);
  throwing.setVideoInterval = (ms: number) => {
    if (fail) throw new Error('capture window gone');
    original(ms);
  };
  const t = fakeEngine({ capture: throwing });
  t.engine.setWanted(true);
  await flush();
  t.engine.setPaused(true);
  assert.deepEqual([t.engine.retunes, t.engine.captureIntervalMs], [0, 100], 'the failed retune is not taken for done');
  fail = false;
  t.engine.setSpeed(3);
  assert.deepEqual(throwing.videoIntervals, [1000], 'the next change asks again for the slow-down it missed (the speed waits for the resume)');
  t.engine.setPaused(false);
  assert.deepEqual(throwing.videoIntervals, [1000, 40]);
  assert.equal(t.engine.captureIntervalMs, 40);
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

test('without a capture host FollowVideo is inert (also across speed changes and pauses)', async () => {
  const { engine, timers } = await engineRig({ capture: null });
  engine.setWanted(true);
  assert.equal(engine.state, 'failed');
  assert.equal(timers.pending, 0);
  for (const speed of [1, 3, 2]) {
    engine.setSpeed(speed);
    assert.equal(timers.pending, 0, `speed ${speed}: no upload tick, no retry`);
  }
  engine.setPaused(true);
  engine.setPaused(false);
  engine.setWanted(true, { retry: true });
  assert.deepEqual([engine.state, engine.starts, engine.retunes, engine.captureIntervalMs, timers.pending], ['failed', 0, 0, null, 0]);
});

// ── Brightness (the port's Brightness slider for FollowVideo, deviation 17): host-side dimming of the frames ──

test('brightness levels: 1 Bright = x 1/3, 2 Brighter = x 2/3, 3 Brightest = the colours as captured; anything else is 3', () => {
  assert.deepEqual(FOLLOW_VIDEO_BRIGHTNESS_NAMES, { 1: 'Bright', 2: 'Brighter', 3: 'Brightest' }, 'the slider marks (Ambiglow-Dvqon39u.js na)');
  assert.equal(FOLLOW_VIDEO_DEFAULT_BRIGHTNESS, 3);
  for (const level of [1, 2, 3] as const) assert.equal(followVideoBrightness(level), level);
  for (const other of [undefined, null, 0, -1, 4, 7, 2.5, '2', NaN, {}]) {
    assert.equal(followVideoBrightness(other), 3, `${String(other)} → full (the behaviour before the slider)`);
  }
  assert.deepEqual([followVideoGain(1), followVideoGain(2), followVideoGain(3), followVideoGain(0)], [1 / 3, 2 / 3, 1, 1]);
  // The vendor's host-side breathing curve maps Brightness the same way (clamp(b, 1, 3) / 3f) for 1..3.
  const engine = new FollowVideoEngine({ log: silentLog, target: () => null });
  assert.deepEqual([engine.brightness, engine.gain], [3, 1], 'default: full');
  assert.equal(new FollowVideoEngine({ log: silentLog, target: () => null, brightness: 1 }).gain, 1 / 3);
});

test('brightness on the real driver: the mapped LED colours x level/3, rounded to the nearest integer; the mirror holds the dimmed colours; six writes as before', async () => {
  const { ene, capture, engine } = await engineRig({ speed: 2 });
  engine.setBrightness(2);
  engine.setWanted(true);
  await flush();
  const frame = rgbaFrame((row, col) => [col * 5, row * 6, 200], 1);
  const m = ene.mark();
  capture!.frame(frame);
  await flush();
  assert.equal(ene.since(m).length, 6, 'still the six segment writes');
  const full = leds(mapFrameToLeds(LAYOUT, COUNTS, frame));
  const expected = full.map((c) => c.map((v) => Math.round((v * 2) / 3)));
  assert.deepEqual(leds(ene.mock.state().frame), expected, 'every LED x 2/3 after the §7.3 mapping');
  assert.deepEqual(leds(ene.device.ledColors()), expected, 'Effect_GetLEDs shows what the LEDs show');
  // LED 45 samples cell (39, 49): 245, 234, 200 → 163.3, 156, 133.3 → 163, 156, 133 (never halfway: exact rounding).
  assert.deepEqual(expected[45], [163, 156, 133]);
  // Bright: x 1/3 (LED 0 samples (30, 49): 245, 180, 200 → 81.7, 60, 66.7 → 82, 60, 67).
  engine.setBrightness(1);
  await flush();
  assert.deepEqual(leds(ene.mock.state().frame)[0], [82, 60, 67], 'the newest frame re-sent at once');
  // Brightest: the grid's colours unchanged.
  engine.setBrightness(3);
  await flush();
  assert.deepEqual(leds(ene.mock.state().frame), full);
  assert.deepEqual(ene.mock.violations, []);
});

test('setBrightness live (event-driven): the newest frame goes again at once with the new gain, nothing is queued, the capture is not touched; the same level again is a no-op', async () => {
  const { capture, ene, engine } = fakeEngine();
  engine.setWanted(true);
  await flush();
  const a = rgbaFrame(() => [1, 1, 1], 1);
  capture.frame(a);
  ene.finish();
  await flush();
  assert.deepEqual([ene.frames, ene.gains], [[a], [1]]);
  engine.setBrightness(2);
  assert.deepEqual([ene.frames, ene.gains], [[a, a], [1, 2 / 3]], 'A again at 2/3, without waiting for a new frame');
  engine.setBrightness(2);
  engine.setBrightness('2');
  assert.equal(engine.brightness, 3, "'2' is not a level: full");
  // A change while an upload runs: the newest frame follows it at the new gain; B replaced nothing, one upload each.
  engine.setBrightness(1);
  const b = rgbaFrame(() => [2, 2, 2], 2);
  capture.frame(b);
  assert.equal(ene.inFlight, 1, 'one upload at a time');
  ene.finish();
  await flush();
  ene.finish();
  await flush();
  ene.finish();
  await flush();
  assert.equal(ene.gains.at(-1), 1 / 3);
  assert.equal(ene.frames.at(-1), b);
  assert.deepEqual([capture.videoStarts, capture.videoIntervals, capture.videoStops, engine.retunes], [[100], [], 0, 0], 'same session, no retune');
});

test('setBrightness: Low sends the newest frame again on the next tick; while paused it applies on resume; while stopped at the next start', async () => {
  const { capture, timers, ene, engine } = fakeEngine({ speed: 1 });
  engine.setBrightness(1);
  engine.setWanted(true);
  await flush();
  const a = rgbaFrame(() => [3, 3, 3], 1);
  capture.frame(a);
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  ene.finish();
  await flush();
  assert.deepEqual(ene.gains, [1 / 3], 'the level set before the start');
  engine.setBrightness(3);
  assert.equal(ene.frames.length, 1, 'Low: not before the tick');
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  ene.finish();
  await flush();
  assert.deepEqual([ene.frames, ene.gains], [[a, a], [1 / 3, 1]]);

  engine.setPaused(true);
  engine.setBrightness(2);
  timers.advance(3 * FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(ene.frames.length, 2, 'paused: nothing goes out');
  engine.setPaused(false);
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  ene.finish();
  await flush();
  assert.deepEqual(ene.gains.at(-1), 2 / 3, 'resumed: the newest frame at the level set meanwhile');

  engine.setWanted(false);
  engine.setBrightness(1);
  assert.equal(engine.brightness, 1);
  engine.setWanted(true);
  await flush();
  capture.frame(rgbaFrame(() => [4, 4, 4], 2));
  timers.advance(FOLLOW_VIDEO_SEND_MS);
  await flush();
  assert.equal(ene.gains.at(-1), 1 / 3);
});
