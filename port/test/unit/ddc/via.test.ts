import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ControlSetup, UsbDeviceHandle } from '../../../src/backend/types.ts';
import { FakeUsbBackend, type FakeTransfer } from '../../../src/backend/usb/fake-backend.ts';
import { formatSetup } from '../../../src/backend/usb/setup.ts';
import { DdcChannelImpl, NO_DELAY_TIMINGS } from '../../../src/backend/ddc/channel.ts';
import { buildDdcMessage, getVcpPayload } from '../../../src/backend/ddc/codec.ts';
import { DdcError } from '../../../src/backend/ddc/errors.ts';
import { readMonitorIdentity } from '../../../src/backend/ddc/identity.ts';
import { MOCK_34M2C8600 } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { USER_34M2C8600, USER_MONITOR_SERIAL } from '../../fixtures/user-monitor.ts';
import { SimulatedMonitor, mockViaDeviceSpec } from '../../../src/backend/ddc/transports/mock.ts';
import { VIA_TIMEOUT_MS, ViaUsbTransport } from '../../../src/backend/ddc/transports/via.ts';
import { hex } from './helpers.ts';

/** "OUT 40 B2 0000 0000 0006 | 6E 51 82 01 10 AC" / "IN C0 A3 0000 006F 0020 → 32 bytes". */
function describe(t: FakeTransfer): string {
  return t.direction === 'out'
    ? `OUT ${formatSetup(t.setup, t.length)} | ${hex(t.data)}`
    : `IN ${formatSetup(t.setup, t.length)}`;
}

async function viaSetup() {
  const monitor = new SimulatedMonitor(USER_34M2C8600); // the user's unit (LOG26 banner, real serial)
  const usb = new FakeUsbBackend();
  const info = usb.attach(mockViaDeviceSpec(monitor));
  const transport = new ViaUsbTransport(await usb.open(info));
  const ch = new DdcChannelImpl([transport], { timings: NO_DELAY_TIMINGS });
  await ch.probe();
  usb.transfers.length = 0;
  return { monitor, usb, info, transport, ch };
}

test('08 §4.3: GetVCP(0x10) is B2 write of 6E 51 82 01 10 AC, then A3 read of 32 bytes at wIndex 0x6F', async () => {
  const { ch, usb } = await viaSetup();
  assert.deepEqual(await ch.getVcp(0x10), { value: 0x64, max: 0x64, resultCode: 0 });
  assert.deepEqual(usb.transfers.map(describe), [
    'OUT 40 B2 0000 0000 0006 | 6E 51 82 01 10 AC',
    'IN C0 A3 0000 006F 0020',
  ]);
  // 08 §3.3 example reply (value 0x32 → F2) with value 0x64: F2 ^ 32 ^ 64 = A4.
  assert.equal(hex(usb.transfers[1].data.subarray(0, 11)), '6E 88 02 00 10 00 00 64 00 64 A4');
  assert.ok(usb.transfers.every((t) => t.timeoutMs === VIA_TIMEOUT_MS));
});

test('08 §4.3: SetVCP(0x10, 0x32) and the extended E2 A0 frames', async () => {
  const { ch, usb, monitor } = await viaSetup();
  await ch.setVcp(0x10, 0x32);
  await ch.getExt(0x43);
  await ch.setExt(0x43, 1);
  assert.deepEqual(usb.transfers.map(describe), [
    'OUT 40 B2 0000 0000 0008 | 6E 51 84 03 10 00 32 9A',
    'OUT 40 B2 0000 0000 0008 | 6E 51 84 01 E2 A0 43 BB',
    'IN C0 A3 0000 006F 0020',
    'OUT 40 B2 0000 0000 000A | 6E 51 86 03 E2 A0 43 00 01 BA',
  ]);
  assert.equal(monitor.control(0x10)?.value, 0x32);
});

test('08 §4.3: capabilities use the A7/A9 split read (first 32 bytes at 0x6F, then 32 at wIndex 0)', async () => {
  const { ch, usb } = await viaSetup();
  assert.equal(await ch.capabilities(), MOCK_34M2C8600.capabilities);
  assert.deepEqual(usb.transfers.slice(0, 3).map(describe), [
    'OUT 40 B2 0000 0000 0007 | 6E 51 83 F3 00 00 4F',
    'IN C0 A7 0000 006F 0020',
    'IN C0 A9 0000 0000 0020',
  ]);
  assert.equal(describe(usb.transfers[3]), 'OUT 40 B2 0000 0000 0007 | 6E 51 83 F3 00 20 6F');
  // A full 32-byte fragment (L = 35) spans both halves: 6E A3 E3 00 00 + 32 data + checksum.
  assert.equal(hex(usb.transfers[1].data.subarray(0, 5)), '6E A3 E3 00 00');
});

test('identity over the VIA path matches the LOG26 banner (08 §2.3)', async () => {
  const { ch } = await viaSetup();
  const id = await readMonitorIdentity(ch);
  assert.equal(id.modelName, '34M2C8600');
  assert.equal(id.bomString, '100GPRS2003NA1SXXY');
  assert.equal(id.version, 'V1.01');
  assert.equal(id.dualImageBank, 0x40);
  assert.equal(id.scalerName, 'RTD2738VL');
  assert.equal(id.scalerType, 'RTK');
  assert.equal(id.serialNumber, USER_MONITOR_SERIAL);
});

test('transport contract: address byte added on the wire, 32-byte limit, read lengths, errors, close', async () => {
  const calls: string[] = [];
  let closed = 0;
  const handle: UsbDeviceHandle = {
    info: { vendorId: 0x2109, productId: 0x8884, busNumber: 1, deviceAddress: 2, id: 'usb:1-1' },
    async controlOut(setup: ControlSetup, data: Uint8Array, timeoutMs?: number) {
      calls.push(`out ${formatSetup(setup, data.length)} ${hex(data)} t=${timeoutMs}`);
    },
    async controlIn(setup: ControlSetup, length: number) {
      calls.push(`in ${formatSetup(setup, length)}`);
      if (setup.bRequest === 0xa3 && length === 7) throw new Error('LIBUSB_ERROR_PIPE');
      return new Uint8Array(length === 32 ? 5 : length).fill(0x6e); // short transfer on the first call
    },
    async close() {
      closed++;
    },
  };
  const t = new ViaUsbTransport(handle, 250);
  assert.equal(t.id, 'via:usb:1-1');
  await t.write(buildDdcMessage(getVcpPayload(0x14)));
  assert.equal(calls[0], 'out 40 B2 0000 0000 0006 6E 51 82 01 14 A8 t=250');
  const r = await t.read(32);
  assert.equal(r.length, 32);
  assert.equal(hex(r.subarray(4, 6)), '6E 00'); // zero tail after a short transfer
  assert.equal((await t.read(40)).length, 40);
  assert.deepEqual(calls.slice(-2), ['in C0 A7 0000 006F 0020', 'in C0 A9 0000 0000 0008']);
  await assert.rejects(t.read(7), (e: unknown) => e instanceof DdcError && e.code === 'io' && /PIPE/.test(e.message));
  await assert.rejects(t.read(65), (e: unknown) => e instanceof DdcError && e.code === 'argument');
  await assert.rejects(t.write(new Uint8Array(32)), (e: unknown) => e instanceof DdcError && e.code === 'argument');
  await t.close();
  await t.close();
  assert.equal(closed, 1);
  await assert.rejects(t.read(8), (e: unknown) => e instanceof DdcError && e.code === 'closed');
});

test('the mock bridge STALLs requests it does not implement, and unplugging fails the transport', async () => {
  const { usb, info, transport, ch } = await viaSetup();
  const handle = await usb.open(info);
  await assert.rejects(handle.controlOut({ bmRequestType: 0x40, bRequest: 0xb7, wValue: 0, wIndex: 0 }, Uint8Array.of(0x94, 0x6f)), /unsupported request/);
  await assert.rejects(handle.controlIn({ bmRequestType: 0xc0, bRequest: 0xa3, wValue: 0, wIndex: 0x95 }, 32), /unsupported request/);
  usb.detach(info);
  await assert.rejects(ch.getVcp(0x10), (e: unknown) => e instanceof DdcError && e.code === 'io');
  await transport.close();
});
