// The frame-interval rules shared by the capture host (src/main/capture-host.ts: every startVideo and
// setVideoInterval command) and the capture page (src/capture/page.ts: the frame rate asked of the source and the
// spacing of the frames it samples): 33..10000 ms, about 30 fps at most. The Follow video speed tiers ask
// 300 / 100 / 40 ms, 1000 ms while paused (follow-video.ts). The Electron side (frame-driven sampling, retuning a
// running X11 capture) is exercised in test/e2e/capture.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOLLOW_VIDEO_CADENCES, FOLLOW_VIDEO_PAUSED_CAPTURE_MS } from '../../../src/backend/ambiglow/follow-video.ts';
import {
  clampFrameInterval,
  frameRateFor,
  MAX_FRAME_INTERVAL_MS,
  MAX_FRAME_RATE,
  MIN_FRAME_INTERVAL_MS,
  minSampleSpacingMs,
} from '../../../src/capture/protocol.ts';

test('clampFrameInterval: 33 ms floor (was 100 ms), rounding, nonsense → a bound', () => {
  assert.equal(MIN_FRAME_INTERVAL_MS, 33);
  assert.equal(MAX_FRAME_INTERVAL_MS, 10_000);
  assert.deepEqual([300, 100, 40, 33, 34.4, 34.6].map(clampFrameInterval), [300, 100, 40, 33, 34, 35]);
  assert.deepEqual([10, 1, 0, -5, NaN, -Infinity].map(clampFrameInterval), Array(6).fill(33));
  assert.deepEqual([10_000, 20_000, Infinity].map(clampFrameInterval), Array(3).fill(10_000));
});

test('frameRateFor: 1000 / interval, not rounded (300 ms → 3.33 fps, a frame every 300 ms, not 333), 1..30 fps', () => {
  assert.equal(MAX_FRAME_RATE, 30);
  assert.deepEqual([33, 40, 100, 1000, 10_000].map(frameRateFor), [30, 25, 10, 1, 1]);
  assert.equal(frameRateFor(300), 1000 / 300);
  assert.equal(1000 / frameRateFor(300), 300);
  assert.equal(frameRateFor(1), 30);
});

test('minSampleSpacingMs: the interval less min(15 ms, interval / 4): a source at the asked rate is sampled frame by frame, a faster one thinned', () => {
  assert.deepEqual([300, 100, 40, 33, 1000].map(minSampleSpacingMs), [285, 85, 30, 24.75, 985]);
  // A frame of a source at the asked rate arrives up to a few ms early (jitter): it is still sampled.
  for (const ms of [300, 100, 40, 33]) assert.ok(ms - 3 >= minSampleSpacingMs(ms), `${ms} ms`);
  // A 30 fps source (a portal stream the constraint did not slow down): every 3rd frame at 100 ms, every 9th at 300.
  const sampled = (intervalMs: number) => {
    let last = -Infinity;
    let n = 0;
    for (let i = 0; i < 90; i++) {
      const t = (i * 1000) / 30;
      if (t - last >= minSampleSpacingMs(intervalMs)) {
        last = t;
        n++;
      }
    }
    return n; // in 3 s
  };
  assert.deepEqual([sampled(100), sampled(300), sampled(1000)], [30, 10, 3]);
});

test('every Follow video speed tier and the paused interval pass the host unchanged (High is no longer clamped to 10 fps)', () => {
  for (const tier of Object.values(FOLLOW_VIDEO_CADENCES)) {
    assert.equal(clampFrameInterval(tier.captureMs), tier.captureMs, tier.name);
  }
  assert.equal(clampFrameInterval(FOLLOW_VIDEO_PAUSED_CAPTURE_MS), FOLLOW_VIDEO_PAUSED_CAPTURE_MS);
  assert.deepEqual(Object.values(FOLLOW_VIDEO_CADENCES).map((t) => frameRateFor(t.captureMs)), [1000 / 300, 10, 25]);
  assert.equal(frameRateFor(FOLLOW_VIDEO_PAUSED_CAPTURE_MS), 1);
});
