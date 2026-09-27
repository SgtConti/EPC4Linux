// LibusbBackend against a stand-in for the `usb` package's legacy API: no real libusb, no hardware.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibusbBackend, type LegacyUsbDevice, type LegacyUsbModule } from '../../../src/backend/usb/libusb-backend.ts';
import { UsbError } from '../../../src/backend/usb/errors.ts';
import { USB_CLASS_HUB, usbDeviceClass } from '../../../src/backend/usb/ids.ts';
import { createLogger, silentSink, type LogSink } from '../../../src/backend/core/log.ts';
import type { UsbDeviceInfo } from '../../../src/backend/types.ts';

const quiet = createLogger('test', silentSink);

interface Call {
  bm: number;
  req: number;
  value: number;
  index: number;
  dataOrLength: number | Uint8Array;
  timeout: number;
}

type Reply = { error?: Error; data?: Uint8Array | number };

/**
 * Mirrors node-usb's Device (src/device.cc, dist/usb/device.js): open() is a no-op on an open device,
 * close() closes the libusb handle for every holder and throws while a transfer is pending, and a
 * transfer on a closed device fails ("Device is not open", delivered to the callback on nextTick).
 */
class FakeLegacyDevice implements LegacyUsbDevice {
  busNumber: number;
  deviceAddress: number;
  portNumbers: number[] | undefined;
  deviceDescriptor: { idVendor: number; idProduct: number; bDeviceClass: number };
  timeout = 1000;
  openArgs: Array<boolean | undefined> = [];
  isOpen = false;
  /** libusb_open / libusb_close calls actually made. */
  libusbOpens = 0;
  libusbCloses = 0;
  pending = 0;
  calls: Call[] = [];
  openErrno: number | null = null;
  closeThrows = false;
  /** Default: OUT echoes the length, IN returns `length` bytes 0..n-1. */
  respond: (call: Call) => Reply = (c) => (typeof c.dataOrLength === 'number' ? { data: Uint8Array.from({ length: c.dataOrLength }, (_, i) => i) } : { data: c.dataOrLength.length });
  delayMs = 0;

  constructor(vid: number, pid: number, bus: number, address: number, ports: number[] | undefined, deviceClass = 0) {
    this.deviceDescriptor = { idVendor: vid, idProduct: pid, bDeviceClass: deviceClass };
    this.busNumber = bus;
    this.deviceAddress = address;
    this.portNumbers = ports;
  }

  open(defaultConfig?: boolean): void {
    this.openArgs.push(defaultConfig);
    if (this.openErrno !== null) throw Object.assign(new Error('LIBUSB_ERROR_ACCESS'), { errno: this.openErrno });
    if (this.isOpen) return;
    this.isOpen = true;
    this.libusbOpens++;
  }

  close(): void {
    if (this.closeThrows || this.pending > 0) throw new Error("Can't close device with a pending request");
    if (!this.isOpen) return;
    this.isOpen = false;
    this.libusbCloses++;
  }

  controlTransfer(bm: number, req: number, value: number, index: number, dataOrLength: number | Uint8Array, cb: (e: Error | undefined, d: Uint8Array | number | undefined) => void) {
    if (!this.isOpen) {
      process.nextTick(() => cb(new Error('Device is not open'), undefined));
      return this;
    }
    const call = { bm, req, value, index, dataOrLength, timeout: this.timeout };
    this.calls.push(call);
    const reply = this.respond(call);
    this.pending++;
    setTimeout(() => {
      this.pending--;
      cb(reply.error, reply.data);
    }, this.delayMs);
    return this;
  }
}

class FakeLegacyModule extends EventEmitter implements LegacyUsbModule {
  INIT_ERROR = 0;
  devices: FakeLegacyDevice[] = [];
  listThrows = false;
  unrefCalls = 0;

  getDeviceList(): LegacyUsbDevice[] {
    if (this.listThrows) throw Object.assign(new Error('LIBUSB_ERROR_NO_MEM'), { errno: -11 });
    return this.devices;
  }

  unrefHotplugEvents(): void {
    this.unrefCalls++;
  }
}

function sysfs(entries: Record<string, Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'evnia-sysfs-'));
  for (const [name, attrs] of Object.entries(entries)) {
    mkdirSync(join(root, name));
    for (const [attr, value] of Object.entries(attrs)) writeFileSync(join(root, name, attr), `${value}\n`);
  }
  return root;
}

function setup(sysfsRoot: string | null = null) {
  const mod = new FakeLegacyModule();
  const ene = new FakeLegacyDevice(0x0cf2, 0xa201, 3, 7, [2, 1]);
  const via = new FakeLegacyDevice(0x2109, 0x8884, 3, 5, [2, 4]);
  const root = new FakeLegacyDevice(0x1d6b, 0x0003, 3, 1, []);
  mod.devices.push(ene, via, root);
  const backend = new LibusbBackend({ log: quiet, load: async () => mod, sysfsRoot });
  return { mod, ene, via, root, backend };
}

const eneWrite = { bmRequestType: 0x40, bRequest: 0x80, wValue: 0, wIndex: 0xe021 };
const eneRead = { bmRequestType: 0xc0, bRequest: 0x81, wValue: 0, wIndex: 0xe9f0 };
const isCode = (code: string) => (e: unknown) => e instanceof UsbError && e.code === code;

test('list: descriptor info and stable port-path ids (usb:<bus>-<p1>.<p2>)', async () => {
  const { backend, mod } = setup();
  mod.devices.push(new FakeLegacyDevice(0x1234, 0x5678, 4, 9, undefined));
  const list = await backend.list();
  assert.deepEqual(list.map((d) => [d.id, d.vendorId, d.productId, d.busNumber, d.deviceAddress]), [
    ['usb:3-2.1', 0x0cf2, 0xa201, 3, 7],
    ['usb:3-2.4', 0x2109, 0x8884, 3, 5],
    ['usb:3', 0x1d6b, 0x0003, 3, 1],
    ['usb:4@9', 0x1234, 0x5678, 4, 9],
  ]);
});

test('list: strings come from sysfs, only for devices that pass the filter; filter sees descriptor data', async () => {
  const root = sysfs({ '3-2.1': { serial: '0000000002', product: 'ENE Ambiglow' }, '3-2.4': { serial: '0000000000000001' } });
  try {
    const { backend } = setup(root);
    const seen: UsbDeviceInfo[] = [];
    const list = await backend.list((d) => {
      seen.push(d);
      return d.vendorId === 0x0cf2;
    });
    assert.ok(seen.every((d) => d.serialNumber === undefined), 'the filter runs before any string lookup');
    assert.deepEqual(list, [{ vendorId: 0x0cf2, productId: 0xa201, busNumber: 3, deviceAddress: 7, id: 'usb:3-2.1', deviceClass: 0, serialNumber: '0000000002', product: 'ENE Ambiglow' }]);
    assert.deepEqual(await backend.list((d) => d.serialNumber === '0000000002'), [], 'cached strings are not shown to the filter either');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('open: libusb_open only (open(false): no configuration, no interface claim, no driver detach)', async () => {
  const { backend, ene } = setup();
  const [info] = await backend.list((d) => d.vendorId === 0x0cf2);
  const h = await backend.open(info);
  assert.deepEqual(ene.openArgs, [false]);
  assert.equal(h.info.id, 'usb:3-2.1');
  await h.controlOut(eneWrite, Uint8Array.of(0x0e));
  const reply = await h.controlIn(eneRead, 3, 250);
  assert.deepEqual([...reply], [0, 1, 2]);
  assert.deepEqual(ene.calls.map((c) => [c.bm, c.req, c.value, c.index, typeof c.dataOrLength === 'number' ? c.dataOrLength : [...c.dataOrLength], c.timeout]), [
    [0x40, 0x80, 0, 0xe021, [0x0e], 1000],
    [0xc0, 0x81, 0, 0xe9f0, 3, 250],
  ]);
  await h.close();
  assert.equal(ene.isOpen, false);
});

test('LIBUSB_ERROR_ACCESS on open → UsbError "access" with the udev-rules hint', async () => {
  const { backend, ene } = setup();
  ene.openErrno = -3;
  const [info] = await backend.list((d) => d.vendorId === 0x0cf2);
  await assert.rejects(backend.open(info), (e: unknown) => {
    assert.ok(e instanceof UsbError);
    assert.equal(e.code, 'access');
    assert.equal(e.errno, -3);
    assert.match(e.message, /No permission to open USB device 0cf2:a201 \(usb:3-2\.1\).*udev rules.*uaccess/);
    return true;
  });
});

test('transfer failures map to error codes (transfer status and LIBUSB_ERROR_*)', async () => {
  const { backend, ene } = setup();
  const h = await backend.open((await backend.list((d) => d.vendorId === 0x0cf2))[0]);
  const fail = (errno: number) => () => ({ error: Object.assign(new Error(`status ${errno}`), { errno }) });
  const cases: Array<[number, string]> = [[2, 'timeout'], [4, 'stall'], [5, 'no-device'], [1, 'io'], [6, 'overflow'], [-9, 'stall'], [-7, 'timeout'], [42, 'other']];
  for (const [errno, code] of cases) {
    ene.respond = fail(errno);
    await assert.rejects(h.controlIn(eneRead, 1), isCode(code), `errno ${errno}`);
  }
  ene.respond = () => ({ data: 0 });
  await assert.rejects(h.controlOut(eneWrite, Uint8Array.of(1)), (e: unknown) => isCode('io')(e) && /short write/.test((e as Error).message));
  // Synchronous throw from submit (e.g. device gone) is mapped too.
  ene.controlTransfer = () => {
    throw Object.assign(new Error('LIBUSB_ERROR_NO_DEVICE'), { errno: -4 });
  };
  await assert.rejects(h.controlOut(eneWrite, Uint8Array.of(1)), isCode('no-device'));
});

test('malformed setup packets are rejected before reaching libusb', async () => {
  const { backend, ene } = setup();
  const h = await backend.open((await backend.list((d) => d.vendorId === 0x0cf2))[0]);
  await assert.rejects(h.controlOut(eneRead, Uint8Array.of(1)), isCode('invalid'));
  await assert.rejects(h.controlIn(eneWrite, 1), isCode('invalid'));
  await assert.rejects(h.controlIn({ ...eneRead, wIndex: 0x10000 }, 1), isCode('invalid'));
  await assert.rejects(h.controlOut(eneWrite, new Uint8Array(0x10000)), isCode('invalid'));
  assert.equal(ene.calls.length, 0);
});

test('closed handles fail with "closed"; close is idempotent and tolerates a failing libusb close', async () => {
  const { backend, ene } = setup();
  const h = await backend.open((await backend.list((d) => d.vendorId === 0x0cf2))[0]);
  ene.closeThrows = true;
  await h.close();
  await h.close();
  await assert.rejects(h.controlIn(eneRead, 1), isCode('closed'));
});

test('two handles on one device share its libusb handle: closed with the last one, transfers serialized across both', async () => {
  const lines: string[] = [];
  const sink: LogSink = (level, _s, args) => lines.push(`${level} ${args.join(' ')}`);
  const mod = new FakeLegacyModule();
  const ene = new FakeLegacyDevice(0x0cf2, 0xa201, 3, 7, [2, 1]);
  mod.devices.push(ene);
  const backend = new LibusbBackend({ log: createLogger('t', sink, 'debug'), load: async () => mod, sysfsRoot: null });
  const [info] = await backend.list();
  // E.g. a rescan pairs the VIA bridge again while the previous transport is alive, or an ENE is re-probed.
  const a = await backend.open(info);
  const b = await backend.open(info);
  assert.equal(ene.libusbOpens, 1);
  assert.deepEqual(ene.openArgs, [false], 'libusb_open once');
  ene.delayMs = 3;
  let outstanding = 0;
  const overlap: number[] = [];
  const original = ene.controlTransfer.bind(ene);
  ene.controlTransfer = (bm, req, value, index, dol, cb) => {
    overlap.push(outstanding++);
    return original(bm, req, value, index, dol, (e, d) => {
      outstanding--;
      cb(e, d);
    });
  };
  await Promise.all([a.controlIn(eneRead, 1), b.controlOut(eneWrite, Uint8Array.of(1)), a.controlOut(eneWrite, Uint8Array.of(2)), b.controlIn(eneRead, 2)]);
  assert.deepEqual(overlap, [0, 0, 0, 0], 'one transfer at a time on the device');
  // Closing one handle while the other has a transfer in flight: waits for it, keeps the libusb handle open.
  const inFlight = b.controlIn(eneRead, 4);
  await a.close();
  assert.equal((await inFlight).length, 4);
  assert.equal(ene.isOpen, true);
  assert.equal(ene.libusbCloses, 0);
  await assert.rejects(a.controlIn(eneRead, 1), isCode('closed'));
  assert.deepEqual([...(await b.controlIn(eneRead, 2))], [0, 1], 'the other handle is unaffected');
  await b.close();
  assert.equal(ene.isOpen, false);
  assert.equal(ene.libusbCloses, 1);
  assert.deepEqual(lines.filter((l) => l.startsWith('warn')), [], 'never closed with a pending request');
  // After the last close, a new open() opens libusb again.
  const c = await backend.open(info);
  assert.equal(ene.libusbOpens, 2);
  await c.close();
});

test('string cache holds present devices only: pruned on enumeration, dropped after a detach event', async () => {
  const root = sysfs({ '3-2.1': { serial: 'A' } });
  const rewrite = (serial: string) => writeFileSync(join(root, '3-2.1', 'serial'), `${serial}\n`);
  try {
    const { backend, mod, ene } = setup(root);
    const serialOf = async () => (await backend.list((d) => d.vendorId === 0x0cf2))[0]?.serialNumber;
    assert.equal(await serialOf(), 'A');
    // The device leaves (no hotplug subscriber) and a different one enumerates at the same port and address.
    mod.devices = mod.devices.filter((d) => d !== ene);
    assert.equal(await serialOf(), undefined);
    rewrite('B');
    mod.devices.push(ene);
    assert.equal(await serialOf(), 'B', 'no stale strings from the previous device');
    // Hotplug: the detach event still carries the strings, then they are dropped.
    const events: string[] = [];
    const off = backend.onChange((kind, info) => events.push(`${kind} ${info.serialNumber}`));
    await backend.isAvailable();
    await new Promise((r) => setImmediate(r));
    mod.emit('detach', ene);
    rewrite('C');
    mod.emit('attach', ene);
    off();
    assert.deepEqual(events, ['detach B', 'attach C']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transfers on one handle run one at a time, in order', async () => {
  const { backend, ene } = setup();
  const h = await backend.open((await backend.list((d) => d.vendorId === 0x0cf2))[0]);
  ene.delayMs = 5;
  let outstanding = 0;
  const overlap: number[] = [];
  const original = ene.controlTransfer.bind(ene);
  ene.controlTransfer = (bm, req, value, index, dol, cb) => {
    overlap.push(outstanding++);
    return original(bm, req, value, index, dol, (e, d) => {
      outstanding--;
      cb(e, d);
    });
  };
  await Promise.all([h.controlIn(eneRead, 1), h.controlOut(eneWrite, Uint8Array.of(1)), h.controlIn(eneRead, 2)]);
  assert.deepEqual(overlap, [0, 0, 0], 'each transfer is submitted after the previous one completed');
  assert.deepEqual(ene.calls.map((c) => c.index), [0xe9f0, 0xe021, 0xe9f0]);
});

test('open finds a device re-enumerated at a new address on the same port; a vanished one → no-device', async () => {
  const { backend, mod, ene } = setup();
  const [info] = await backend.list((d) => d.vendorId === 0x0cf2);
  ene.deviceAddress = 12;
  const h = await backend.open(info);
  assert.equal(h.info.deviceAddress, 12);
  mod.devices = mod.devices.filter((d) => d !== ene);
  await assert.rejects(backend.open(info), isCode('no-device'));
});

test('without libusb the backend reports "no USB" and never throws from list/onChange', async () => {
  const lines: string[] = [];
  const sink: LogSink = (level, _s, args) => lines.push(`${level} ${args.join(' ')}`);
  const backend = new LibusbBackend({ log: createLogger('t', sink), load: async () => { throw new Error('No native build was found for platform=linux arch=x64'); } });
  assert.deepEqual(await backend.list(), []);
  assert.equal(await backend.isAvailable(), false);
  assert.match(backend.unavailableReason ?? '', /No native build/);
  const off = backend.onChange(() => assert.fail('no events without libusb'));
  off();
  await assert.rejects(backend.open({ vendorId: 0x0cf2, productId: 0xa201, busNumber: 3, deviceAddress: 7, id: 'usb:3-2.1' }), isCode('unavailable'));
  assert.equal(lines.filter((l) => l.startsWith('warn')).length, 1, 'warned once');
});

test('libusb_init failure: the reason is the libusb error, although the addon then exports no functions', async () => {
  // node-usb's Init() returns right after setting INIT_ERROR (src/node_usb.cc:49-56): the module the
  // package hands out is its EventEmitter with INIT_ERROR and the constants, but no getDeviceList.
  const mod = Object.assign(new EventEmitter(), { INIT_ERROR: -99, LIBUSB_ERROR_OTHER: -99 }) as unknown as LegacyUsbModule;
  const lines: string[] = [];
  const sink: LogSink = (level, _s, args) => lines.push(`${level} ${args.join(' ')}`);
  const backend = new LibusbBackend({ log: createLogger('t', sink), load: async () => mod });
  assert.equal(await backend.isAvailable(), false);
  assert.equal(backend.unavailableReason, 'libusb_init failed: LIBUSB_ERROR_OTHER (-99)');
  assert.deepEqual(await backend.list(), []);
  backend.onChange(() => assert.fail('no events without libusb'))();
  await assert.rejects(backend.open({ vendorId: 0x0cf2, productId: 0xa201, busNumber: 3, deviceAddress: 7, id: 'usb:3-2.1' }), (e: unknown) =>
    isCode('unavailable')(e) && (e as Error).message.includes('libusb_init failed: LIBUSB_ERROR_OTHER (-99)'),
  );
  assert.deepEqual(lines.filter((l) => l.startsWith('warn')).length, 1);
  assert.match(lines.find((l) => l.startsWith('warn')) ?? '', /libusb_init failed/);
});

test('a module without the legacy API is unavailable; enumeration errors yield an empty list', async () => {
  const bare = Object.assign(new EventEmitter(), { INIT_ERROR: 0 }) as unknown as LegacyUsbModule;
  const backend = new LibusbBackend({ log: quiet, load: async () => bare });
  assert.equal(await backend.isAvailable(), false);
  assert.match(backend.unavailableReason ?? '', /does not expose its legacy API/);
  const ok = setup();
  ok.mod.listThrows = true;
  assert.deepEqual(await ok.backend.list(), []);
});

test('bDeviceClass is reported everywhere: the VIA hub halves are told from the 2109:8884 bridge (20 §2.3 step 2)', async () => {
  const { backend, mod, via } = setup();
  const hub = new FakeLegacyDevice(0x2109, 0x2817, 3, 2, [2], USB_CLASS_HUB);
  const hub2211 = new FakeLegacyDevice(0x2109, 0x2211, 3, 4, [2, 3], USB_CLASS_HUB);
  mod.devices.push(hub, hub2211);
  const seen: Array<[string, number]> = [];
  const bridges = await backend.list((d) => {
    seen.push([d.id, d.deviceClass]);
    return d.vendorId === 0x2109 && d.deviceClass !== USB_CLASS_HUB;
  });
  assert.deepEqual(bridges.map((d) => [d.id, d.productId, d.deviceClass]), [['usb:3-2.4', 0x8884, 0]]);
  assert.deepEqual(seen.filter(([, c]) => c === USB_CLASS_HUB).map(([id]) => id), ['usb:3-2', 'usb:3-2.3'], 'the filter sees the class');
  const hubs = await backend.list((d) => usbDeviceClass(d) === USB_CLASS_HUB);
  assert.deepEqual(hubs.map((d) => d.productId), [0x2817, 0x2211]);
  const h = await backend.open(bridges[0]);
  assert.equal(usbDeviceClass(h.info), 0);
  await h.close();
  const events: Array<[string, number | undefined]> = [];
  const off = backend.onChange((kind, info) => events.push([`${kind} ${info.id}`, usbDeviceClass(info)]));
  await backend.isAvailable();
  await new Promise((r) => setImmediate(r));
  mod.emit('detach', hub2211);
  mod.emit('attach', via);
  off();
  assert.deepEqual(events, [['detach usb:3-2.3', USB_CLASS_HUB], ['attach usb:3-2.4', 0]]);
  assert.equal(usbDeviceClass({ vendorId: 1, productId: 1, busNumber: 1, deviceAddress: 1, id: 'usb:1-1' }), undefined, 'unknown for hand-built infos');
});

test('hotplug: attach/detach mapped to UsbDeviceInfo; detach keeps cached strings; unsubscribe removes listeners', async () => {
  const root = sysfs({ '3-2.1': { serial: '0000000002' } });
  try {
    const { backend, mod, ene } = setup(root);
    const events: Array<[string, UsbDeviceInfo]> = [];
    const offA = backend.onChange((kind, info) => events.push([kind, info]));
    const offB = backend.onChange(() => {
      throw new Error('a failing listener must not break the others');
    });
    await backend.isAvailable();
    await new Promise((r) => setImmediate(r));
    assert.equal(mod.listenerCount('attach'), 1);
    assert.equal(mod.listenerCount('detach'), 1);
    assert.equal(mod.unrefCalls, 1, 'hotplug does not keep the process alive');
    mod.emit('attach', ene);
    rmSync(join(root, '3-2.1'), { recursive: true }); // sysfs node disappears on unplug
    mod.emit('detach', ene);
    assert.deepEqual(events.map(([k, i]) => [k, i.id, i.serialNumber]), [
      ['attach', 'usb:3-2.1', '0000000002'],
      ['detach', 'usb:3-2.1', '0000000002'],
    ]);
    offA();
    assert.equal(mod.listenerCount('attach'), 1, 'still one subscriber');
    offB();
    assert.equal(mod.listenerCount('attach'), 0);
    assert.equal(mod.listenerCount('detach'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
