// FollowAudio: capture-host levels → ENE audio registers (09 §8.3), with the real driver on the simulated MCU.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EneBrightness, EneMode, EneRegion, EneSpeed } from '../../../src/backend/ambiglow/ene-registers.ts';
import { FollowAudioEngine } from '../../../src/backend/ambiglow/follow-audio.ts';
import { openRig, w } from '../ambiglow-ene/helpers.ts';
import { FakeCaptureHost, flush, silentLog } from './helpers.ts';

const followAudio = { region: EneRegion.AllZone, mode: EneMode.FollowAudio, rainbow: false, rgb: [0, 0, 255] as const, speed: EneSpeed.Normal, brightness: EneBrightness.Brightest };

async function setup(rainbow: boolean) {
  const ene = await openRig();
  await ene.device.setEffect({ ...followAudio, rainbow });
  const capture = new FakeCaptureHost();
  const engine = new FollowAudioEngine({ log: silentLog, capture, target: () => ene.device });
  return { ene, capture, engine };
}

test('each level goes to E960..E962 (FollowAudio, mode 9), truncated to a byte', async () => {
  const { ene, capture, engine } = await setup(false);
  engine.setWanted(true);
  await flush();
  assert.equal(engine.state, 'running');
  assert.equal(capture.audioStarts, 1);
  const m = ene.mark();
  capture.level(128.9);
  await flush();
  assert.deepEqual(ene.since(m), [w(0xe960, 128), w(0xe961, 128), w(0xe962, 128)]);
  capture.level(300);
  await flush();
  assert.deepEqual(ene.mock.state().audioLevel, [255, 255, 255], 'clamped');
  assert.equal(engine.writes, 2);
});

test('FollowAudioRainbow (mode 10) uses E970..E972', async () => {
  const { ene, capture, engine } = await setup(true);
  engine.setWanted(true);
  await flush();
  const m = ene.mark();
  capture.level(42);
  await flush();
  assert.deepEqual(ene.since(m), [w(0xe970, 42), w(0xe971, 42), w(0xe972, 42)]);
});

test('a level arriving during a write is dropped, not queued; stop ends the capture', async () => {
  const { ene, capture, engine } = await setup(false);
  engine.setWanted(true);
  await flush();
  const m = ene.mark();
  capture.level(10);
  capture.level(20); // previous write (3 × paced) still running
  capture.level(30);
  await flush();
  assert.deepEqual(ene.since(m), [w(0xe960, 10), w(0xe961, 10), w(0xe962, 10)]);
  assert.equal(engine.lastLevel, 30);
  engine.setWanted(false);
  assert.equal(capture.audioStops, 1);
  capture.level(40);
  await flush();
  assert.equal(ene.since(m).length, 3);
});

test('levels are ignored outside FollowAudio (the driver writes nothing)', async () => {
  const { ene, capture, engine } = await setup(false);
  await ene.device.setEffect({ ...followAudio, mode: EneMode.StaticMode });
  engine.setWanted(true);
  await flush();
  const m = ene.mark();
  capture.level(99);
  await flush();
  assert.deepEqual(ene.since(m), []);
});

test('an unavailable audio capture leaves the engine failed until it is wanted again', async () => {
  const { capture, engine } = await setup(false);
  capture.audioResult = false;
  engine.setWanted(true);
  await flush();
  assert.equal(engine.state, 'failed');
  engine.setWanted(true);
  assert.equal(capture.audioStarts, 1);
  engine.setWanted(false);
  assert.equal(capture.audioStops, 0, 'nothing to stop');
});
