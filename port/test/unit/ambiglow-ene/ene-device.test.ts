import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EneBrightness, EneMode, EneRegion, EneSpeed } from '../../../src/backend/ambiglow/ene-registers.ts';
import type { EneParameterSet } from '../../../src/backend/ambiglow/ene-params.ts';
import { EneError } from '../../../src/backend/ambiglow/ene-transport.ts';
import { UsbError } from '../../../src/backend/usb/errors.ts';
import { GRID_HEIGHT, GRID_WIDTH } from '../../../src/backend/ambiglow/ene-frame.ts';
import { EneDevice, findEneDevices } from '../../../src/backend/ambiglow/ene.ts';
import { MockEneDevice } from '../../../src/backend/ambiglow/mock-ene.ts';
import { openRig, w } from './helpers.ts';

const audio: EneParameterSet = { region: EneRegion.AllZone, mode: EneMode.FollowAudio, rainbow: false, rgb: [255, 0, 0], speed: EneSpeed.Normal, brightness: EneBrightness.Brightest };
const video: EneParameterSet = { ...audio, mode: EneMode.UserDefine, rainbow: true, rgb: [0, 0, 0] };
const grid = { width: GRID_WIDTH, height: GRID_HEIGHT, data: new Uint8Array(GRID_WIDTH * GRID_HEIGHT * 3).fill(0x40) };

test('audio level, FollowAudio (mode 9): same byte to E960, E961, E962, each paced (Class0.method_6)', async () => {
  const rig = await openRig();
  await rig.device.setEffect(audio);
  const m = rig.mark();
  rig.sleeps.length = 0;
  assert.equal(await rig.device.writeAudioLevel(0x80), true);
  assert.deepEqual(rig.since(m), [w(0xe960, 0x80), w(0xe961, 0x80), w(0xe962, 0x80)]);
  assert.deepEqual(rig.sleeps, [10, 10, 10]);
  assert.deepEqual(rig.mock.state().audioLevel, [0x80, 0x80, 0x80]);
});

test('audio level, FollowAudioRainbow (mode 10): E970..E972', async () => {
  const rig = await openRig();
  await rig.device.setEffect({ ...audio, rainbow: true });
  const m = rig.mark();
  await rig.device.writeAudioLevel(255);
  assert.deepEqual(rig.since(m), [w(0xe970, 0xff), w(0xe971, 0xff), w(0xe972, 0xff)]);
});

test('audio levels are dropped outside FollowAudio', async () => {
  const rig = await openRig();
  await rig.device.setEffect(video);
  const m = rig.mark();
  assert.equal(await rig.device.writeAudioLevel(10), false);
  assert.deepEqual(rig.since(m), []);
});

test('CaptureHost levels are floats: truncated to a byte like the vendor (byte) cast, clamped, NaN → 0 (09 §8.2)', async () => {
  const rig = await openRig();
  await rig.device.setEffect(audio);
  const byteOf = async (level: number) => {
    const m = rig.mark();
    assert.equal(await rig.device.writeAudioLevel(level), true);
    const writes = rig.since(m);
    assert.equal(writes.length, 3);
    return rig.mock.state().audioLevel[0];
  };
  assert.equal(await byteOf(127.99), 127);
  assert.equal(await byteOf(254.5), 254);
  assert.equal(await byteOf(0.4), 0);
  assert.equal(await byteOf(300), 255);
  assert.equal(await byteOf(-3), 0);
  assert.equal(await byteOf(Number.NaN), 0);
  assert.equal(await byteOf(Number.POSITIVE_INFINITY), 255);
  await rig.device.writeAudioLevel(128.7);
  assert.deepEqual([...rig.device.ledColors().subarray(0, 3)], [128, 0, 0], 'the preview uses the byte that was written');
});

test('preview: FollowAudio colours scale with the level (RGB.Multiply truncation); regions light the right LEDs', async () => {
  const rig = await openRig();
  await rig.device.setEffect(audio);
  await rig.device.writeAudioLevel(128);
  const leds = rig.device.ledColors();
  assert.equal(leds.length, 46 * 3);
  assert.deepEqual([...leds.subarray(0, 3)], [128, 0, 0]);
  // Border4Sided lights border (LEDs 0..13) and bottom (32..45), central (14..31) is off.
  await rig.device.setEffect({ ...audio, mode: EneMode.StaticMode, region: EneRegion.Border4Sided, rgb: [1, 2, 3] });
  const colors = rig.device.ledColors();
  const led = (i: number) => [...colors.subarray(3 * i, 3 * i + 3)];
  assert.deepEqual([led(0), led(13), led(14), led(31), led(32), led(45)], [[1, 2, 3], [1, 2, 3], [0, 0, 0], [0, 0, 0], [1, 2, 3], [1, 2, 3]]);
});

test('lightsOff / lightsOn: idle suspend releases host control; wake restores the effect (09 §11)', async () => {
  const rig = await openRig();
  assert.equal(await rig.device.lightsOn(), false, 'nothing to restore yet');
  // FollowVideo as toEneParameterSet produces it: UI speed/brightness bytes, forced to 0 only in mode 14.
  await rig.device.setEffect({ ...video, speed: EneSpeed.High, brightness: EneBrightness.Bright });
  let m = rig.mark();
  assert.equal(await rig.device.lightsOff(), true);
  const off = rig.since(m);
  assert.equal(off[0], w(0x0023, 0x00));
  assert.deepEqual(off.slice(1, 5), [w(0xe021, 0), w(0xe031, 0), w(0xe041, 0), w(0xe051, 0)]);
  // Same bytes as the vendor's ParameterSet for the EffectInfo with EffectEnable = false: LEDOFF keeps
  // the UI speed (FE) and brightness (04) instead of the values forced for mode 14.
  assert.deepEqual(off.slice(9, 10), [w(0xe022, EneSpeed.High)]);
  assert.deepEqual(off.slice(17, 18), [w(0xe029, EneBrightness.Bright)]);
  assert.equal(off.length, 29);
  assert.equal(rig.device.hostControl, false);
  assert.equal(rig.device.suspended, true);
  assert.equal(rig.mock.state().groups[1]?.mode, 0);
  m = rig.mark();
  assert.equal(await rig.device.lightsOff(), false, 'a second idle notification writes nothing');
  assert.deepEqual(rig.since(m), []);
  assert.equal(await rig.device.writeVideoFrame(grid), false, 'no frames while suspended');
  m = rig.mark();
  assert.equal(await rig.device.lightsOn(), true);
  const on = rig.since(m);
  assert.equal(on[0], w(0x0023, 0x04));
  assert.equal(on[1], w(0xe021, 0x0e));
  assert.equal(on[9], w(0xe022, EneSpeed.Normal), 'mode 14 forces speed Normal again');
  assert.equal(rig.device.applied?.mode, EneMode.UserDefine);
  assert.equal(rig.device.suspended, false);
  assert.equal(await rig.device.writeVideoFrame(grid), true, 'frames flow again after wake');
  m = rig.mark();
  assert.equal(await rig.device.lightsOn(), false, 'not suspended: nothing to resume');
  assert.deepEqual(rig.since(m), []);
});

test('lightsOn never switches on LEDs the owner switched off (Effect_Enable(false) before idle)', async () => {
  const rig = await openRig();
  await rig.device.setEffect(video);
  await rig.device.setEffect({ ...video, mode: EneMode.LEDOFF });
  const m = rig.mark();
  assert.equal(await rig.device.lightsOff(), false, 'already off: nothing to suspend');
  assert.equal(await rig.device.lightsOn(), false);
  assert.deepEqual(rig.since(m), [], 'no write on idle or wake');
  assert.equal(rig.mock.state().hostControl, 0x00, 'host control stays released');
  assert.equal(rig.mock.state().groups[1]?.mode, 0);
});

test('an explicit setEffect ends the suspension: a later wake does not resurrect the old effect', async () => {
  const rig = await openRig();
  await rig.device.setEffect(video);
  assert.equal(await rig.device.lightsOff(), true);
  await rig.device.setEffect({ ...video, mode: EneMode.LEDOFF }); // user disables Ambiglow while idle
  assert.equal(rig.device.suspended, false);
  const m = rig.mark();
  assert.equal(await rig.device.lightsOn(), false);
  assert.deepEqual(rig.since(m), []);
  // A new effect set while idle is shown (the owner decides), and idle then suspends that one.
  await rig.device.setEffect(audio);
  assert.equal(await rig.device.lightsOff(), true);
  assert.equal(await rig.device.lightsOn(), true);
  assert.equal(rig.device.applied?.mode, EneMode.FollowAudio);
});

test('setEffect { suspended }: recorded for the wake without lighting the LEDs (no 0x0023 ← 04 while idle)', async () => {
  const rig = await openRig();
  // A freshly opened device (re-enumerated during idle) still runs the firmware's own effect: the LEDOFF
  // variant of the new request goes out — exactly the lightsOff() bytes.
  let m = rig.mark();
  await rig.device.setEffect({ ...video, speed: EneSpeed.High, brightness: EneBrightness.Bright }, { suspended: true });
  const off = rig.since(m);
  assert.equal(off[0], w(0x0023, 0x00));
  assert.ok(!off.includes(w(0x0023, 0x04)));
  assert.equal(off.length, 29);
  assert.deepEqual(off.slice(9, 10), [w(0xe022, EneSpeed.High)], 'the requested bytes, mode LEDOFF');
  assert.equal(rig.device.suspended, true);
  assert.equal(rig.device.hostControl, false);
  assert.equal(rig.mock.state().groups[1]?.mode, 0);
  assert.equal(await rig.device.writeVideoFrame(grid), false);
  // Already dark: a second request (a profile switch while idle) writes nothing and replaces the request.
  m = rig.mark();
  await rig.device.setEffect(audio, { suspended: true });
  assert.deepEqual(rig.since(m), []);
  assert.equal(await rig.device.lightsOff(), false, 'already suspended');
  m = rig.mark();
  assert.equal(await rig.device.lightsOn(), true);
  assert.equal(rig.since(m)[0], w(0x0023, 0x04));
  assert.equal(rig.device.applied?.mode, EneMode.FollowAudio, 'the wake shows the latest request');
  // An effect that is itself off is applied as is and ends the suspension.
  assert.equal(await rig.device.lightsOff(), true);
  await rig.device.setEffect({ ...audio, mode: EneMode.LEDOFF }, { suspended: true });
  assert.equal(rig.device.suspended, false);
  m = rig.mark();
  assert.equal(await rig.device.lightsOn(), false, 'nothing to resume: the owner switched it off');
  assert.deepEqual(rig.since(m), []);
});

test('lightsOff before any effect writes nothing (the vendor only suspends an applied ENE effect)', async () => {
  const rig = await openRig();
  const m = rig.mark();
  assert.equal(await rig.device.lightsOff(), false);
  assert.deepEqual(rig.since(m), []);
});

test('close releases host control (UnPlug: 0x0023←00, unpaced) and further use fails', async () => {
  const rig = await openRig();
  await rig.device.setEffect(video);
  const m = rig.mark();
  rig.sleeps.length = 0;
  await rig.device.close();
  assert.deepEqual(rig.since(m), [w(0x0023, 0x00)]);
  assert.deepEqual(rig.sleeps, []);
  assert.equal(rig.device.closed, true);
  await rig.device.close(); // idempotent
  await assert.rejects(rig.device.setEffect(video), (e: unknown) => e instanceof EneError && e.code === 'closed');
  await assert.rejects(rig.device.writeVideoFrame(grid), (e: unknown) => e instanceof EneError && e.code === 'closed');
});

test('close({ release: false }) leaves 0x0023 alone', async () => {
  const rig = await openRig();
  await rig.device.setEffect(video);
  const m = rig.mark();
  await rig.device.close({ release: false });
  assert.deepEqual(rig.since(m), []);
  assert.equal(rig.mock.state().hostControl, 0x04);
});

test('unplug: the first failure is UsbError no-device and marks the device lost (onLost once); close skips the release', async () => {
  const rig = await openRig();
  await rig.device.setEffect(video);
  rig.usb.detach(rig.device.info);
  await assert.rejects(rig.device.setEffect(audio), (e: unknown) => e instanceof UsbError && e.code === 'no-device');
  assert.equal(rig.device.applied, null);
  assert.equal(rig.device.lost, true);
  assert.equal(rig.device.hostControl, false);
  assert.deepEqual(rig.lost, [rig.device]);
  await assert.rejects(rig.device.writeVideoFrame(grid), (e: unknown) => e instanceof EneError && e.code === 'lost');
  assert.equal(rig.lost.length, 1, 'reported once');
  const m = rig.mark();
  await rig.device.close();
  assert.deepEqual(rig.since(m), [], 'no release write to a device that is gone');
  assert.equal(rig.device.closed, true);
});

test('re-enumeration at the same port (standby, KVM, E2A014 write): same id, new address → stale device detected, re-open re-applies', async () => {
  const rig = await openRig();
  const old = rig.device;
  await old.setEffect(video);
  // Unplug and replug inside one USBChange throttle window (01 §9): the owner never sees the id vanish.
  rig.usb.detach(old.info);
  const fresh = new MockEneDevice();
  rig.usb.attach(fresh.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: old.info.deviceAddress + 10 }));
  const present = await findEneDevices(rig.usb);
  assert.deepEqual(present.map((d) => d.id), [old.info.id], 'the id is stable across re-enumeration');
  assert.equal(old.isCurrent(present), false, 'but the enumeration (address) changed');
  assert.equal(old.lost, false, 'nothing has failed yet');
  // A frame in flight hits the dead handle: the device is marked lost.
  await assert.rejects(old.writeVideoFrame(grid), (e: unknown) => e instanceof UsbError && e.code === 'no-device');
  assert.equal(old.lost, true);
  await old.close();
  const reopened = await EneDevice.open(rig.usb, present[0], rig.options);
  assert.equal(reopened.isCurrent(present), true);
  await reopened.setEffect(video);
  assert.equal(fresh.state().hostControl, 0x04);
  assert.equal(fresh.state().groups[1]?.mode, EneMode.UserDefine);
  assert.equal(await reopened.writeVideoFrame(grid), true);
  assert.equal(reopened.isCurrent([]), false, 'gone from the list');
  await reopened.close();
  assert.equal(reopened.isCurrent(present), false, 'closed');
});

test('operations are serialized: a frame queued behind a ParameterSet never interleaves with it', async () => {
  const rig = await openRig();
  await rig.device.setEffect(audio);
  const m = rig.mark();
  const effect = rig.device.setEffect(video);
  assert.equal(rig.device.busy, true);
  const frame = rig.device.writeVideoFrame(grid);
  await Promise.all([effect, frame]);
  assert.equal(await frame, true, 'the frame saw mode 14 applied by the ParameterSet queued before it');
  assert.equal(rig.device.busy, false);
  const seq = rig.since(m);
  assert.equal(seq.length, 29 + 6);
  assert.ok(seq.slice(0, 29).every((s) => !s.includes(' E3')), 'no frame-buffer write inside the ParameterSet');
  assert.ok(seq.slice(29).every((s) => /^40 80 0000 E3/.test(s)));
});
