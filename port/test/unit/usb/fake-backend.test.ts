import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeUsbBackend, type FakeUsbHandler } from '../../../src/backend/usb/fake-backend.ts';
import { USB_PERMISSION_HINT, UsbError, fromLibusbError } from '../../../src/backend/usb/errors.ts';
import { USB_CLASS_HUB, formatVidPid, isSameEnumeration, usbDeviceClass, usbDeviceId, usbSysfsName } from '../../../src/backend/usb/ids.ts';
import { formatSetup } from '../../../src/backend/usb/setup.ts';
import type { UsbDeviceInfo } from '../../../src/backend/types.ts';

const echo: FakeUsbHandler = {
  controlIn: (setup, length) => Uint8Array.from({ length }, (_, i) => (setup.wIndex + i) & 0xff),
  controlOut: () => undefined,
};
const out = { bmRequestType: 0x40, bRequest: 0xb2, wValue: 0, wIndex: 0 };
const inp = { bmRequestType: 0xc0, bRequest: 0xa3, wValue: 0, wIndex: 0x6f };
const isCode = (code: string) => (e: unknown) => e instanceof UsbError && e.code === code;

test('ids follow sysfs naming; vid:pid and setup notation', () => {
  assert.equal(usbDeviceId(3, [2, 1], 7), 'usb:3-2.1');
  assert.equal(usbDeviceId(3, [], 1), 'usb:3');
  assert.equal(usbDeviceId(3, undefined, 7), 'usb:3@7');
  assert.equal(usbSysfsName(3, [2, 1]), '3-2.1');
  assert.equal(usbSysfsName(3, []), 'usb3');
  assert.equal(usbSysfsName(3, undefined), null);
  assert.equal(formatVidPid(0x0cf2, 0xa201), '0cf2:a201');
  assert.equal(formatSetup({ bmRequestType: 0xc0, bRequest: 0x81, wValue: 0, wIndex: 0xe9f0 }, 1), 'C0 81 0000 E9F0 0001');
});

test('attach/detach emit hotplug events and update list()', async () => {
  const usb = new FakeUsbBackend();
  const events: string[] = [];
  const off = usb.onChange((kind, info) => events.push(`${kind} ${info.id} ${formatVidPid(info.vendorId, info.productId)}`));
  const via = usb.attach({ vendorId: 0x2109, productId: 0x8884, busNumber: 3, portNumbers: [2, 4], serialNumber: '0000000000000001', handler: echo });
  const ene = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, busNumber: 3, portNumbers: [2, 1], handler: echo });
  assert.equal(via.serialNumber, '0000000000000001');
  assert.deepEqual((await usb.list()).map((d) => d.id), ['usb:3-2.4', 'usb:3-2.1']);
  assert.deepEqual((await usb.list((d) => d.vendorId === 0x0cf2)).map((d) => d.id), ['usb:3-2.1']);
  usb.detach(ene);
  usb.detach(ene); // no second event
  off();
  usb.detach(via.id); // unsubscribed
  assert.deepEqual(events, ['attach usb:3-2.4 2109:8884', 'attach usb:3-2.1 0cf2:a201', 'detach usb:3-2.1 0cf2:a201']);
  assert.deepEqual(await usb.list(), []);
  assert.throws(() => {
    usb.attach({ vendorId: 1, productId: 1, busNumber: 1, portNumbers: [1], handler: echo });
    usb.attach({ vendorId: 2, productId: 2, busNumber: 1, portNumbers: [1], handler: echo });
  }, /already occupied/);
});

test('default placement gives distinct root ports and addresses', () => {
  const usb = new FakeUsbBackend();
  const a = usb.attach({ vendorId: 1, productId: 1, handler: echo });
  const b = usb.attach({ vendorId: 1, productId: 1, handler: echo });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.deviceAddress, b.deviceAddress);
});

test('transfers are journaled with setup, data and timeout', async () => {
  const usb = new FakeUsbBackend();
  const info = usb.attach({ vendorId: 0x2109, productId: 0x8884, handler: echo });
  const h = await usb.open(info);
  await h.controlOut(out, Uint8Array.of(0x6e, 0x51, 0x82, 0x01, 0x10, 0xac));
  const reply = await h.controlIn(inp, 4, 500);
  assert.deepEqual([...reply], [0x6f, 0x70, 0x71, 0x72]);
  assert.deepEqual(
    usb.transfers.map((t) => [t.deviceId, t.direction, formatSetup(t.setup, t.length), [...t.data], t.timeoutMs]),
    [
      [info.id, 'out', '40 B2 0000 0000 0006', [0x6e, 0x51, 0x82, 0x01, 0x10, 0xac], undefined],
      [info.id, 'in', 'C0 A3 0000 006F 0004', [0x6f, 0x70, 0x71, 0x72], 500],
    ],
  );
});

test('detached devices: open → no-device, open handles fail with no-device', async () => {
  const usb = new FakeUsbBackend();
  const info = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, handler: echo });
  const h = await usb.open(info);
  usb.detach(info);
  await assert.rejects(h.controlIn(inp, 1), isCode('no-device'));
  await assert.rejects(usb.open(info), isCode('no-device'));
  const stale: UsbDeviceInfo = { ...info, productId: 0x1111 };
  usb.attach({ vendorId: 0x0cf2, productId: 0xa201, busNumber: info.busNumber, portNumbers: [1], handler: echo });
  await assert.rejects(usb.open(stale), isCode('no-device'), 'same port, different device');
});

test('simulated open errors, handler failures, overflow, bad setup, closed handle', async () => {
  const usb = new FakeUsbBackend();
  const failing: FakeUsbHandler = {
    controlIn: (_s, length) => new Uint8Array(length + 1),
    controlOut: () => {
      throw new Error('request not supported');
    },
  };
  const info = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, handler: failing });
  usb.setOpenError(info, 'access');
  await assert.rejects(usb.open(info), isCode('access'));
  usb.setOpenError(info, null);
  const h = await usb.open(info);
  await assert.rejects(h.controlOut(out, Uint8Array.of(1)), isCode('stall'));
  await assert.rejects(h.controlIn(inp, 2), isCode('overflow'));
  await assert.rejects(h.controlIn(out, 2), isCode('invalid'));
  await assert.rejects(h.controlOut(inp, Uint8Array.of(1)), isCode('invalid'));
  await h.close();
  await assert.rejects(h.controlIn(inp, 1), isCode('closed'));
});

test('simulated open errors read exactly like LibusbBackend\'s (code, errno, message, udev hint)', async () => {
  const usb = new FakeUsbBackend();
  const info = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, busNumber: 3, portNumbers: [2, 1], handler: echo });
  // What LibusbBackend.open() throws when libusb_open fails: fromLibusbError(node-usb's exception, 'open', info).
  const real = (name: string, errno: number) => fromLibusbError(Object.assign(new Error(name), { errno }), 'open', info);
  const cases: Array<['access' | 'busy' | 'io' | 'no-device' | 'other', string, number]> = [
    ['access', 'LIBUSB_ERROR_ACCESS', -3],
    ['busy', 'LIBUSB_ERROR_BUSY', -6],
    ['io', 'LIBUSB_ERROR_IO', -1],
    ['no-device', 'LIBUSB_ERROR_NO_DEVICE', -4],
    ['other', 'LIBUSB_ERROR_OTHER', -99],
  ];
  for (const [code, name, errno] of cases) {
    usb.setOpenError(info, code);
    await assert.rejects(usb.open(info), (e: unknown) => {
      assert.ok(e instanceof UsbError);
      const expected = real(name, errno);
      assert.deepEqual([e.code, e.errno, e.message], [expected.code, expected.errno, expected.message], code);
      return true;
    });
  }
  usb.setOpenError(info, 'access');
  await assert.rejects(usb.open(info), (e: unknown) => e instanceof UsbError && e.message.includes(USB_PERMISSION_HINT) && e.message.includes('0cf2:a201 (usb:3-2.1)'));
});

test('bDeviceClass: spec.deviceClass (default 0) in list(), its filter, handles and hotplug events', async () => {
  const usb = new FakeUsbBackend();
  const events: Array<number | undefined> = [];
  usb.onChange((_kind, info) => events.push(usbDeviceClass(info)));
  const hub = usb.attach({ vendorId: 0x2109, productId: 0x2211, deviceClass: USB_CLASS_HUB, handler: echo });
  const bridge = usb.attach({ vendorId: 0x2109, productId: 0x8884, handler: echo });
  assert.deepEqual([hub.deviceClass, bridge.deviceClass], [USB_CLASS_HUB, 0]);
  assert.deepEqual((await usb.list((d) => d.vendorId === 0x2109 && d.deviceClass !== USB_CLASS_HUB)).map((d) => d.productId), [0x8884]);
  assert.equal(usbDeviceClass((await usb.open(hub)).info), USB_CLASS_HUB);
  usb.detach(hub);
  assert.deepEqual(events, [USB_CLASS_HUB, 0, USB_CLASS_HUB]);
  assert.throws(() => usb.attach({ vendorId: 1, productId: 1, deviceClass: 0x100, handler: echo }), RangeError);
});

test('the list() filter sees descriptor data only, like LibusbBackend; the result carries the strings', async () => {
  const usb = new FakeUsbBackend();
  usb.attach({ vendorId: 0x0cf2, productId: 0xa201, serialNumber: '0000000002', product: 'ENE', manufacturer: 'ENE', handler: echo });
  const seen: UsbDeviceInfo[] = [];
  const list = await usb.list((d) => {
    seen.push(d);
    return true;
  });
  assert.deepEqual(seen.map((d) => [d.serialNumber, d.product, d.manufacturer]), [[undefined, undefined, undefined]]);
  assert.equal(list[0].serialNumber, '0000000002');
  assert.deepEqual(await usb.list((d) => d.serialNumber === '0000000002'), [], 'a serial filter never matches, as in production');
});

test('two handles on one device: independent close, transfers serialized across handles, close waits for a transfer in flight', async () => {
  const usb = new FakeUsbBackend();
  let inFlight = 0;
  const overlaps: number[] = [];
  const slow: FakeUsbHandler = {
    controlIn: async (_s, length) => {
      overlaps.push(inFlight++);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return new Uint8Array(length);
    },
    controlOut: async () => {
      overlaps.push(inFlight++);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
    },
  };
  const info = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, handler: slow });
  const a = await usb.open(info);
  const b = await usb.open(info);
  await Promise.all([a.controlIn(inp, 1), b.controlOut(out, Uint8Array.of(1)), a.controlOut(out, Uint8Array.of(2)), b.controlIn(inp, 2)]);
  assert.deepEqual(overlaps, [0, 0, 0, 0], 'never two transfers inside the device at once');
  const pending = b.controlIn(inp, 1);
  await a.close();
  await pending; // a's close waited for b's transfer and did not disturb it
  await assert.rejects(a.controlIn(inp, 1), isCode('closed'));
  assert.equal((await b.controlIn(inp, 3)).length, 3, 'the other handle stays usable');
  await b.close();
});

test('the journal is bounded (journalLimit), 0 disables it', async () => {
  const bounded = new FakeUsbBackend({ journalLimit: 3 });
  const h = await bounded.open(bounded.attach({ vendorId: 1, productId: 1, handler: echo }));
  for (let i = 0; i < 20; i++) await h.controlOut(out, Uint8Array.of(i));
  assert.ok(bounded.transfers.length >= 3 && bounded.transfers.length < 6, `kept ${bounded.transfers.length}`);
  assert.deepEqual([...bounded.transfers[bounded.transfers.length - 1].data], [19], 'the most recent transfer is kept');
  const off = new FakeUsbBackend({ journalLimit: 0 });
  const h2 = await off.open(off.attach({ vendorId: 1, productId: 1, handler: echo }));
  await h2.controlOut(out, Uint8Array.of(1));
  assert.equal(off.transfers.length, 0);
  assert.throws(() => new FakeUsbBackend({ journalLimit: -1 }), RangeError);
});

test('re-attach at the same port: same id, new address; handles of the old enumeration stay dead', async () => {
  const usb = new FakeUsbBackend();
  const first = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, busNumber: 3, portNumbers: [2, 1], deviceAddress: 7, handler: echo });
  const h = await usb.open(first);
  usb.detach(first);
  const second = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, busNumber: 3, portNumbers: [2, 1], deviceAddress: 8, handler: echo });
  assert.equal(second.id, first.id);
  assert.equal(isSameEnumeration(first, second), false);
  assert.equal(isSameEnumeration(second, (await usb.list())[0]), true);
  await assert.rejects(h.controlIn(inp, 1), isCode('no-device'));
  const fresh = await usb.open(first); // an info from before the re-enumeration still opens the device at that port
  assert.equal(fresh.info.deviceAddress, 8);
});
