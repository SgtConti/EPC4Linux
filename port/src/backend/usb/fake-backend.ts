// In-memory UsbBackend for tests and mock mode (EVNIA_MOCK_MONITOR, ARCHITECTURE rule 7).
//
// Devices are registered with a handler that answers control transfers, and can be attached and
// detached programmatically (emitting the same hotplug events as the libusb backend). Transfers are
// journaled with their exact setup packet and data so tests can assert byte-exact sequences; the
// journal is bounded so a long-running mock-mode app does not grow without limit.
// Semantics mirror LibusbBackend:
//  - setup packets are validated the same way;
//  - infos carry bDeviceClass (UsbDeviceInfoWithClass; spec.deviceClass, default 0);
//  - the list() filter sees descriptor data only (no serial/product/manufacturer), the result has them;
//  - simulated open failures are built by the same libusb error mapping (code, errno, message, udev hint);
//  - handles on one device are independent (closing one leaves the others usable) but share one
//    FIFO lock, so transfers from different handles never interleave inside an async handler, and
//    close() waits for a transfer in flight;
//  - open handles of a detached device fail with 'no-device' (also after a device re-attaches at
//    the same port: that is a new enumeration), a closed handle fails with 'closed';
//  - handler exceptions surface as UsbError (a non-UsbError becomes 'stall', like a device
//    rejecting a request).

import type { ControlSetup, UsbBackend, UsbDeviceHandle, UsbDeviceInfo, UsbDeviceInfoWithClass } from '../types.ts';
import { Mutex } from '../core/events.ts';
import { UsbError, describeDevice, simulatedLibusbError, type LibusbErrorCode } from './errors.ts';
import { usbDeviceId } from './ids.ts';
import { checkSetup, formatSetup } from './setup.ts';

/** Simulated device firmware: answers EP0 control transfers. */
export interface FakeUsbHandler {
  controlIn(setup: ControlSetup, length: number): Uint8Array | Promise<Uint8Array>;
  controlOut(setup: ControlSetup, data: Uint8Array): void | Promise<void>;
}

export interface FakeUsbDeviceSpec {
  vendorId: number;
  productId: number;
  handler: FakeUsbHandler;
  /** Default 1. */
  busNumber?: number;
  /** Port path from the root hub, e.g. [2, 1] → id "usb:1-2.1". Default: a free root port. */
  portNumbers?: number[];
  /** Default: next free address on the bus. */
  deviceAddress?: number;
  /** bDeviceClass; default 0 (class per interface). Hubs use 0x09 (ids.ts USB_CLASS_HUB). */
  deviceClass?: number;
  serialNumber?: string;
  product?: string;
  manufacturer?: string;
}

/**
 * A journaled transfer. OUT transfers are recorded when sent (also if the device then rejects
 * them); IN transfers when the device answered.
 */
export interface FakeTransfer {
  deviceId: string;
  direction: 'in' | 'out';
  setup: ControlSetup;
  /** OUT: the data stage sent; IN: the bytes returned. */
  data: Uint8Array;
  /** wLength of the setup packet. */
  length: number;
  timeoutMs: number | undefined;
}

export interface FakeUsbBackendOptions {
  /**
   * The journal keeps at least the most recent `journalLimit` transfers (it is trimmed to that many
   * once it reaches twice the limit). 0 disables journaling, Infinity keeps everything.
   * Default {@link DEFAULT_JOURNAL_LIMIT}.
   */
  journalLimit?: number;
}

/** Far above any single test, small enough for hours of mock-mode follow-video/audio traffic. */
export const DEFAULT_JOURNAL_LIMIT = 10_000;

interface FakeDevice {
  info: UsbDeviceInfoWithClass;
  handler: FakeUsbHandler;
  attached: boolean;
  openError: LibusbErrorCode | null;
  /** Shared by all handles on this device (LibusbBackend's DeviceShare). */
  mutex: Mutex;
}

/** What the list() filter may see: descriptor data, as with LibusbBackend. */
function descriptorOnly(info: UsbDeviceInfoWithClass): UsbDeviceInfoWithClass {
  const { vendorId, productId, busNumber, deviceAddress, id, deviceClass } = info;
  return { vendorId, productId, busNumber, deviceAddress, id, deviceClass };
}

export class FakeUsbBackend implements UsbBackend {
  /** Journaled transfers on every device, oldest first (bounded, see {@link FakeUsbBackendOptions}). */
  readonly transfers: FakeTransfer[] = [];
  readonly #journalLimit: number;
  readonly #devices = new Map<string, FakeDevice>();
  readonly #listeners = new Set<(kind: 'attach' | 'detach', info: UsbDeviceInfoWithClass) => void>();
  #nextAddress = 2;

  constructor(options: FakeUsbBackendOptions = {}) {
    const limit = options.journalLimit ?? DEFAULT_JOURNAL_LIMIT;
    if (!(limit >= 0)) throw new RangeError(`journalLimit ${limit} must be ≥ 0`);
    this.#journalLimit = limit;
  }

  /** Plug a device in; emits 'attach'. Returns its info (ids are unique per port path). */
  attach(spec: FakeUsbDeviceSpec): UsbDeviceInfoWithClass {
    const busNumber = spec.busNumber ?? 1;
    const deviceAddress = spec.deviceAddress ?? this.#nextAddress++;
    const portNumbers = spec.portNumbers ?? [this.#freeRootPort(busNumber)];
    const deviceClass = spec.deviceClass ?? 0;
    if (!Number.isInteger(deviceClass) || deviceClass < 0 || deviceClass > 0xff) throw new RangeError(`bDeviceClass ${deviceClass} is not a byte`);
    const id = usbDeviceId(busNumber, portNumbers, deviceAddress);
    if (this.#devices.get(id)?.attached) throw new Error(`fake USB port ${id} is already occupied`);
    const info: UsbDeviceInfoWithClass = { vendorId: spec.vendorId, productId: spec.productId, busNumber, deviceAddress, id, deviceClass };
    if (spec.serialNumber !== undefined) info.serialNumber = spec.serialNumber;
    if (spec.product !== undefined) info.product = spec.product;
    if (spec.manufacturer !== undefined) info.manufacturer = spec.manufacturer;
    this.#devices.set(id, { info, handler: spec.handler, attached: true, openError: null, mutex: new Mutex() });
    this.#emit('attach', info);
    return { ...info };
  }

  /** Unplug a device; emits 'detach'. Open handles start failing with 'no-device'. */
  detach(device: UsbDeviceInfo | string): void {
    const id = typeof device === 'string' ? device : device.id;
    const entry = this.#devices.get(id);
    if (!entry?.attached) return;
    entry.attached = false;
    this.#devices.delete(id);
    this.#emit('detach', { ...entry.info });
  }

  /**
   * Make open() of this device fail as libusb_open would with the libusb_error behind `code`
   * ('access' = LIBUSB_ERROR_ACCESS, a missing udev rule; 'busy', 'io', …): the same UsbError code,
   * errno and message as LibusbBackend, including the udev hint. null clears.
   */
  setOpenError(device: UsbDeviceInfo | string, code: LibusbErrorCode | null): void {
    const entry = this.#devices.get(typeof device === 'string' ? device : device.id);
    if (!entry) throw new Error('unknown fake USB device');
    entry.openError = code;
  }

  async list(filter?: (d: UsbDeviceInfoWithClass) => boolean): Promise<UsbDeviceInfoWithClass[]> {
    const present = [...this.#devices.values()].filter((d) => d.attached);
    return present.filter((d) => !filter || filter(descriptorOnly(d.info))).map((d) => ({ ...d.info }));
  }

  async open(info: UsbDeviceInfo): Promise<UsbDeviceHandle> {
    const entry = this.#devices.get(info.id);
    if (!entry?.attached || entry.info.vendorId !== info.vendorId || entry.info.productId !== info.productId) {
      throw new UsbError('no-device', `USB device ${describeDevice(info)} is no longer present`);
    }
    if (entry.openError) throw simulatedLibusbError(entry.openError, 'open', entry.info);
    return new FakeDeviceHandle(entry, (t) => this.#record(t));
  }

  onChange(cb: (kind: 'attach' | 'detach', info: UsbDeviceInfoWithClass) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  #record(transfer: FakeTransfer): void {
    if (this.#journalLimit === 0) return;
    this.transfers.push(transfer);
    // Amortised O(1): trim back to the limit only once the journal holds twice as many.
    if (this.transfers.length >= 2 * this.#journalLimit) this.transfers.splice(0, this.transfers.length - this.#journalLimit);
  }

  #emit(kind: 'attach' | 'detach', info: UsbDeviceInfoWithClass): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb(kind, { ...info });
      } catch {
        // listeners own their errors, as with the libusb backend
      }
    }
  }

  #freeRootPort(busNumber: number): number {
    for (let port = 1; ; port++) {
      if (!this.#devices.has(usbDeviceId(busNumber, [port], 0))) return port;
    }
  }
}

class FakeDeviceHandle implements UsbDeviceHandle {
  readonly info: UsbDeviceInfoWithClass;
  readonly #entry: FakeDevice;
  readonly #record: (t: FakeTransfer) => void;
  #closed = false;

  constructor(entry: FakeDevice, record: (t: FakeTransfer) => void) {
    this.#entry = entry;
    this.#record = record;
    this.info = { ...entry.info };
  }

  async controlOut(setup: ControlSetup, data: Uint8Array, timeoutMs?: number): Promise<void> {
    checkSetup(setup, 'out', data.length, this.info);
    const copy = Uint8Array.from(data);
    return this.#entry.mutex.run(async () => {
      this.#check(setup, copy.length, 'OUT');
      this.#record({ deviceId: this.info.id, direction: 'out', setup: { ...setup }, data: copy, length: copy.length, timeoutMs });
      try {
        await this.#entry.handler.controlOut({ ...setup }, Uint8Array.from(copy));
      } catch (e) {
        throw this.#wrap(e, setup, copy.length, 'OUT');
      }
    });
  }

  async controlIn(setup: ControlSetup, length: number, timeoutMs?: number): Promise<Uint8Array> {
    checkSetup(setup, 'in', length, this.info);
    return this.#entry.mutex.run(async () => {
      this.#check(setup, length, 'IN');
      let reply: Uint8Array;
      try {
        reply = await this.#entry.handler.controlIn({ ...setup }, length);
      } catch (e) {
        throw this.#wrap(e, setup, length, 'IN');
      }
      // A device can return fewer bytes than asked for, never more (libusb reports OVERFLOW).
      if (reply.length > length) {
        throw new UsbError('overflow', `control IN ${formatSetup(setup, length)} on USB device ${describeDevice(this.info)} failed: LIBUSB_TRANSFER_OVERFLOW`);
      }
      const data = Uint8Array.from(reply);
      this.#record({ deviceId: this.info.id, direction: 'in', setup: { ...setup }, data, length, timeoutMs });
      return Uint8Array.from(data);
    });
  }

  /** Waits for a transfer in flight on the device, like LibusbDeviceHandle.close(). */
  async close(): Promise<void> {
    await this.#entry.mutex.run(async () => {
      this.#closed = true;
    });
  }

  #check(setup: ControlSetup, length: number, dir: 'IN' | 'OUT'): void {
    const op = `control ${dir} ${formatSetup(setup, length)}`;
    if (this.#closed) throw new UsbError('closed', `${op}: handle for ${describeDevice(this.info)} is closed`);
    if (!this.#entry.attached) throw new UsbError('no-device', `${op} on USB device ${describeDevice(this.info)} failed: LIBUSB_TRANSFER_NO_DEVICE`);
  }

  #wrap(e: unknown, setup: ControlSetup, length: number, dir: 'IN' | 'OUT'): UsbError {
    if (e instanceof UsbError) return e;
    const why = e instanceof Error ? e.message : String(e);
    return new UsbError('stall', `control ${dir} ${formatSetup(setup, length)} on USB device ${describeDevice(this.info)} failed: ${why}`, { cause: e });
  }
}
