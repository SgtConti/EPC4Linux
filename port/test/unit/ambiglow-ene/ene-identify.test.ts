import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeUsbBackend } from '../../../src/backend/usb/fake-backend.ts';
import { USB_PERMISSION_HINT, UsbError } from '../../../src/backend/usb/errors.ts';
import { MOCK_ENE_DEFAULTS, MockEneDevice } from '../../../src/backend/ambiglow/mock-ene.ts';
import { EneDevice, findEneDevices, isEneDevice } from '../../../src/backend/ambiglow/ene.ts';
import { EneError } from '../../../src/backend/ambiglow/ene-transport.ts';
import { LAYOUTS, fmt, hex, openRig, quietLog, r, recordingLog } from './helpers.ts';

// Identification of the user's monitor (logs/EvniaServe-2026-09-25.txt:650-652): model 34M2C8600,
// FW 03 32 07 0F 0B. Vendor order: Ec_Init (chip id, rev, trim) → LED groups → model name → FW (09 §3.4, §4.1).
const USER_PROBE = [
  r(0x4000, 0x77),
  r(0x4001, 0x30),
  r(0x0244, 0x01),
  r(0x0415, 0x01),
  r(0xe0a1, 0x03),
  r(0xe0a3, 14),
  r(0xe0a5, 18),
  r(0xe0a7, 14),
  r(0xe9f0, 9),
  r(0xe9f1, ...[...'34M2C8600'].map((c) => c.charCodeAt(0))),
  r(0xb500, 0x03, 0x32, 0x07, 0x0f, 0x0b),
];

async function openWith(mock: MockEneDevice, log = quietLog) {
  const usb = new FakeUsbBackend();
  const info = usb.attach(mock.spec({ busNumber: 3, portNumbers: [2, 1] }));
  const result = await EneDevice.open(usb, info, { log, layouts: LAYOUTS, writeDelayMs: 0 }).then(
    (device) => ({ device, error: null }),
    (error: unknown) => ({ device: null, error }),
  );
  return { usb, info, ...result, transfers: usb.transfers.map(fmt) };
}

test('identification: byte-exact read sequence of the 34M2C8600, no writes, no pacing', async () => {
  const rig = await openRig();
  assert.deepEqual(rig.since(0), USER_PROBE);
  assert.deepEqual(rig.sleeps, []);
  const id = rig.device.identity;
  assert.equal(id.chipId, 0x7730);
  assert.equal(id.modelName, '34M2C8600');
  assert.equal(hex(id.firmware), '03 32 07 0F 0B');
  assert.equal(id.fwVersion, 0x0b);
  assert.deepEqual(id.counts, { border: 14, central: 18, bottom: 14 });
  assert.equal(id.ledGroups, 3);
  assert.equal(rig.device.ledCount, 46);
  assert.equal(rig.device.layout.modelName, '34M2C8600');
  assert.equal(rig.device.info.id, 'usb:3-2.1');
  assert.equal(rig.device.info.serialNumber, MOCK_ENE_DEFAULTS.serialNumber, 'the synthetic USB serial of the simulated MCU');
  assert.equal(rig.device.hostControl, false);
  assert.equal(rig.device.applied, null);
});

test('identification logs model, firmware and LED counts', async () => {
  const { log, lines } = recordingLog();
  const { device } = await openWith(new MockEneDevice(), log);
  assert.ok(device);
  assert.ok(lines.some((l) => l.includes('model "34M2C8600", FW 03 32 07 0F 0B') && l.includes('border 14, central 18, bottom 14')), lines.join('\n'));
});

test('a chip outside the 0x773x family is rejected after the id read and closed without writes', async () => {
  const { error, transfers } = await openWith(new MockEneDevice({ chipId: 0x5570 }));
  assert.ok(error instanceof EneError && error.code === 'not-ene');
  assert.deepEqual(transfers, [r(0x4000, 0x55), r(0x4001, 0x70)]);
});

test('another 0x773x chip reads revision and trim like EneEc.dll, then is rejected (C# accepts only 0x7730)', async () => {
  const { error, transfers } = await openWith(new MockEneDevice({ chipId: 0x7731 }));
  assert.ok(error instanceof EneError && error.code === 'not-ene');
  assert.deepEqual(transfers, [r(0x4000, 0x77), r(0x4001, 0x31), r(0x0244, 0x01), r(0x0415, 0x01)]);
});

test('firmware bytes 0..3 all zero: rejected like CUSBENE6K7732.Plug, after the full probe, without writes', async () => {
  const { error, transfers, usb } = await openWith(new MockEneDevice({ firmware: [0, 0, 0, 0, 0x0b] }));
  assert.ok(error instanceof EneError && error.code === 'invalid-firmware');
  assert.equal(transfers.length, USER_PROBE.length);
  assert.ok(usb.transfers.every((t) => t.direction === 'in'));
});

test('a model missing from PCenter_AmbiglowInfo.json is not driven', async () => {
  const { error, usb } = await openWith(new MockEneDevice({ modelName: '27E1N1800' }));
  assert.ok(error instanceof EneError && error.code === 'unsupported-model');
  assert.ok(usb.transfers.every((t) => t.direction === 'in'), 'no register was written');
});

test('model lookup ignores case (vendor support check is case-insensitive)', async () => {
  const { device } = await openWith(new MockEneDevice({ modelName: '34m2c8600' }));
  assert.equal(device?.layout.modelName, '34M2C8600');
});

test('model name: length capped at 15 bytes, string ends at the first NUL', async () => {
  const long = await openWith(new MockEneDevice({ modelNameLength: 40 }));
  assert.ok(long.transfers.includes(`C0 81 0000 E9F1 000F -> 33 34 4D 32 43 38 36 30 30 00 00 00 00 00 00`));
  assert.equal(long.device?.modelName, '34M2C8600');
  const empty = await openWith(new MockEneDevice({ modelNameLength: 0 }));
  assert.ok(!empty.transfers.some((t) => t.startsWith('C0 81 0000 E9F1')), 'no name read when the length is 0');
  assert.ok(empty.error instanceof EneError && empty.error.code === 'unsupported-model');
});

test('LED group count: clamped to 3 (0xE0A9 never read); fewer groups read fewer counts', async () => {
  const five = await openWith(new MockEneDevice({ ledGroups: 5 }));
  assert.ok(!five.transfers.some((t) => t.startsWith('C0 81 0000 E0A9')));
  assert.equal(five.device?.identity.ledGroups, 5);
  const one = await openWith(new MockEneDevice({ ledGroups: 1 }));
  assert.ok(one.transfers.includes(r(0xe0a3, 14)));
  assert.ok(!one.transfers.some((t) => /^C0 81 0000 E0A[57]/.test(t)));
  assert.deepEqual(one.device?.identity.counts, { border: 14, central: 0, bottom: 0 });
  assert.equal(one.device?.ledCount, 14);
});

test('trim status 0 is only logged; the flash trim-load of EneEc.dll is never attempted', async () => {
  const { log, lines } = recordingLog();
  const { device, usb } = await openWith(new MockEneDevice({ trimStatus: 0 }), log);
  assert.ok(device);
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes('0x0415')));
  assert.ok(usb.transfers.every((t) => t.direction === 'in'));
});

test('permission errors from the USB layer propagate with the udev hint', async () => {
  const usb = new FakeUsbBackend();
  const info = usb.attach(new MockEneDevice().spec());
  usb.setOpenError(info, 'access');
  await assert.rejects(
    EneDevice.open(usb, info, { log: quietLog, layouts: LAYOUTS }),
    (e: unknown) => e instanceof UsbError && e.code === 'access' && e.message.includes(USB_PERMISSION_HINT),
  );
  assert.deepEqual(usb.transfers, [], 'nothing was sent');
});

test('findEneDevices returns only 0cf2:a201', async () => {
  const usb = new FakeUsbBackend();
  const bridge = { controlIn: () => new Uint8Array(0), controlOut: () => undefined };
  usb.attach({ vendorId: 0x2109, productId: 0x8884, handler: bridge });
  usb.attach({ vendorId: 0x0cf2, productId: 0x1234, handler: bridge });
  const ene = usb.attach(new MockEneDevice().spec());
  assert.deepEqual((await findEneDevices(usb)).map((d) => d.id), [ene.id]);
  assert.equal(isEneDevice({ vendorId: 0x0cf2, productId: 0xa201 }), true);
});
