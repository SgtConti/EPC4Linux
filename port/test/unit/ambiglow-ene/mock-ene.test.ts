import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeUsbBackend } from '../../../src/backend/usb/fake-backend.ts';
import { UsbError } from '../../../src/backend/usb/errors.ts';
import { MockEneDevice } from '../../../src/backend/ambiglow/mock-ene.ts';
import { EneError, EneTransport, eneWriteSetup } from '../../../src/backend/ambiglow/ene-transport.ts';
import { EneBrightness, EneMode, EneRegion, EneSpeed, frameBufferEnd, isReadableRange, isWritableRange } from '../../../src/backend/ambiglow/ene-registers.ts';
import { GRID_HEIGHT, GRID_WIDTH } from '../../../src/backend/ambiglow/ene-frame.ts';
import { openRig, quietLog } from './helpers.ts';

async function rawHandle(mock = new MockEneDevice()) {
  const usb = new FakeUsbBackend();
  const handle = await usb.open(usb.attach(mock.spec()));
  return { usb, mock, handle };
}

test('mock: default identity registers of the user\'s 34M2C8600', () => {
  const r = new MockEneDevice().registers;
  assert.deepEqual([r[0x4000], r[0x4001]], [0x77, 0x30]);
  assert.deepEqual([r[0xe0a1], r[0xe0a3], r[0xe0a5], r[0xe0a7]], [3, 14, 18, 14]);
  assert.equal(new TextDecoder().decode(r.subarray(0xe9f1, 0xe9f1 + r[0xe9f0])), '34M2C8600');
  assert.deepEqual([...r.subarray(0xb500, 0xb505)], [0x03, 0x32, 0x07, 0x0f, 0x0b]);
});

test('mock: a group takes new settings only when its apply register is written', async () => {
  const { mock, handle } = await rawHandle();
  await handle.controlOut(eneWriteSetup(0xe021), Uint8Array.of(0x05));
  assert.equal(mock.state().groups[1], null);
  await handle.controlOut(eneWriteSetup(0xe980), Uint8Array.of(1, 2, 3));
  await handle.controlOut(eneWriteSetup(0xe02f), Uint8Array.of(1));
  assert.deepEqual(mock.state().groups[1], { mode: 5, swMode: 0, speed: 0, direction: 0, brightness: 0, color: [1, 2, 3] });
});

test('mock: writes outside the documented map STALL and are recorded as violations', async () => {
  const { mock, handle } = await rawHandle();
  for (const reg of [0x0415, 0x0202, 0x0600, 0xe100]) {
    await assert.rejects(handle.controlOut(eneWriteSetup(reg), Uint8Array.of(0)), (e: unknown) => e instanceof UsbError && e.code === 'stall');
  }
  assert.deepEqual(mock.violations, ['write 0x0415 len 1', 'write 0x0202 len 1', 'write 0x0600 len 1', 'write 0xe100 len 1']);
  await assert.rejects(handle.controlIn({ bmRequestType: 0x80, bRequest: 0x06, wValue: 0x0100, wIndex: 0 }, 18), (e: unknown) => e instanceof UsbError && e.code === 'stall');
  await assert.rejects(handle.controlIn({ bmRequestType: 0xc0, bRequest: 0x81, wValue: 1, wIndex: 0 }, 1), (e: unknown) => e instanceof UsbError && e.code === 'stall');
});

test('mock: its own register map bounds the frame buffer by its LED count and allows only the listed group fields', async () => {
  const { mock, handle } = await rawHandle();
  assert.equal(mock.frameLeds, 46);
  const write = (reg: number, length: number) => handle.controlOut(eneWriteSetup(reg), new Uint8Array(length));
  await write(0xe300, 138); // the whole buffer of 46 LEDs: E300..E389
  await write(0xe387, 3); // its last LED
  for (const [reg, length] of [[0xe38a, 1], [0xe387, 6], [0xe300, 141], [0xe900, 3], [0xe024, 1], [0xe02a, 1], [0xe98c, 1], [0xe963, 1]] as const) {
    await assert.rejects(write(reg, length), (e: unknown) => e instanceof UsbError && e.code === 'stall', `0x${reg.toString(16)} len ${length}`);
  }
  assert.deepEqual(mock.violations, [
    'write 0xe38a len 1',
    'write 0xe387 len 6',
    'write 0xe300 len 141',
    'write 0xe900 len 3',
    'write 0xe024 len 1',
    'write 0xe02a len 1',
    'write 0xe98c len 1',
    'write 0xe963 len 1',
  ]);
  // A device with fewer LEDs has a smaller buffer (34M2C6500-like: no bottom group).
  const small = await rawHandle(new MockEneDevice({ ledGroups: 2 }));
  assert.equal(small.mock.frameLeds, 32);
  await assert.rejects(small.handle.controlOut(eneWriteSetup(0xe360), Uint8Array.of(0)), (e: unknown) => e instanceof UsbError && e.code === 'stall');
  assert.equal(small.mock.state().frame.length, 96);
});

test('transport: refuses forbidden registers before anything reaches the device (09 plan F.3)', async () => {
  const { usb, handle } = await rawHandle();
  const t = new EneTransport(handle, { log: quietLog, writeDelayMs: 0 });
  for (const reg of [0x0410, 0x0415, 0x0202, 0x0600, 0x4000, 0xe0a1, 0xe100, 0xe98c]) {
    await assert.rejects(t.writeRegs(reg, Uint8Array.of(0)), (e: unknown) => e instanceof EneError && e.code === 'forbidden-register');
  }
  await assert.rejects(t.writeRegs(0xe05f, Uint8Array.of(1, 1)), (e: unknown) => e instanceof EneError && e.code === 'forbidden-register', 'must not straddle windows');
  await assert.rejects(t.readRegs(0x0410, 1), (e: unknown) => e instanceof EneError && e.code === 'forbidden-register');
  await assert.rejects(t.readRegs(0x0600, 1), (e: unknown) => e instanceof EneError && e.code === 'forbidden-register');
  await assert.rejects(t.readRegs(0xe9f1, 16), (e: unknown) => e instanceof EneError && e.code === 'forbidden-register');
  await assert.rejects(t.writeRegs(0xe300, new Uint8Array(0)), RangeError);
  assert.equal(usb.transfers.length, 0);
  assert.ok(isWritableRange(0x0023, 1, 0) && isWritableRange(0xe989, 3, 0) && isWritableRange(0xe972, 1, 0));
  assert.ok(isReadableRange(0xb500, 5) && isReadableRange(0xe9f1, 15) && !isReadableRange(0xb500, 6));
});

test('transport: the frame-buffer window is the device\'s LED count, closed until identification set it', async () => {
  const { usb, mock, handle } = await rawHandle();
  const t = new EneTransport(handle, { log: quietLog, writeDelayMs: 0 });
  const refused = (e: unknown) => e instanceof EneError && e.code === 'forbidden-register';
  await assert.rejects(t.writeRegs(0xe300, new Uint8Array(3)), refused, 'no frame write before the LED count is known');
  t.setFrameBufferLeds(46);
  await t.writeRegs(0xe300, new Uint8Array(138));
  await assert.rejects(t.writeRegs(0xe38a, new Uint8Array(3)), refused, 'past the 46th LED');
  await assert.rejects(t.writeRegs(0xe32a, new Uint8Array(99)), refused, 'straddling the end');
  assert.throws(() => t.setFrameBufferLeds(-1), RangeError);
  assert.equal(usb.transfers.length, 1);
  assert.deepEqual(mock.violations, []);
  assert.ok(isWritableRange(0xe300, 138, 46) && !isWritableRange(0xe300, 141, 46) && !isWritableRange(0xe38a, 1, 46) && !isWritableRange(0xe300, 1, 0));
  // A bogus LED count cannot open the window over the audio/colour/name registers behind it.
  assert.equal(frameBufferEnd(1000), 0xe960);
  assert.ok(!isWritableRange(0xe95f, 2, 1000) && isWritableRange(0xe95f, 1, 1000));
});

test('transport: short replies are zero-padded like the vendor\'s pre-cleared buffers', async () => {
  const usb = new FakeUsbBackend();
  const handler = { controlIn: () => Uint8Array.of(0x33, 0x34), controlOut: () => undefined };
  const handle = await usb.open(usb.attach({ vendorId: 0x0cf2, productId: 0xa201, handler }));
  const t = new EneTransport(handle, { log: quietLog });
  assert.deepEqual([...(await t.readRegs(0xe9f1, 5))], [0x33, 0x34, 0, 0, 0]);
});

test('transport: close is idempotent and later access fails', async () => {
  const { handle } = await rawHandle();
  const t = new EneTransport(handle, { log: quietLog });
  await t.close();
  await t.close();
  await assert.rejects(t.readReg(0x4000), (e: unknown) => e instanceof EneError && e.code === 'closed');
});

test('the driver stays inside the device\'s own register map: every region, frames, both audio banks, idle, close', async () => {
  const rig = await openRig();
  const base = { rainbow: false, rgb: [1, 2, 3] as [number, number, number], speed: EneSpeed.Normal, brightness: EneBrightness.Brightest };
  for (const region of [EneRegion.AllZone, EneRegion.Border4Sided, EneRegion.Central, EneRegion.Bottom, EneRegion.Clock4]) {
    await rig.device.setEffect({ ...base, region, mode: EneMode.ColorWave });
  }
  await rig.device.setEffect({ ...base, region: EneRegion.AllZone, mode: EneMode.UserDefine });
  const grid = { width: GRID_WIDTH, height: GRID_HEIGHT, data: new Uint8Array(GRID_WIDTH * GRID_HEIGHT * 4).fill(0x7f) };
  assert.equal(await rig.device.writeVideoFrame(grid), true);
  await rig.device.setEffect({ ...base, region: EneRegion.AllZone, mode: EneMode.FollowAudio });
  assert.equal(await rig.device.writeAudioLevel(99), true);
  await rig.device.setEffect({ ...base, region: EneRegion.AllZone, mode: EneMode.FollowAudio, rainbow: true });
  assert.equal(await rig.device.writeAudioLevel(200), true);
  assert.equal(await rig.device.lightsOff(), true);
  assert.equal(await rig.device.lightsOn(), true);
  await rig.device.close();
  assert.ok(rig.usb.transfers.filter((t) => t.direction === 'out').length > 150);
  assert.deepEqual(rig.mock.violations, []);
});
