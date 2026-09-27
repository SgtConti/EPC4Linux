// UsbBackend on the `usb` npm package (2.18, legacy libusb API).
//
// Only what the monitor needs: enumerate, open, EP0 vendor control transfers, hotplug.
//  - VIA USB-DDC bridge 2109:8884 (08 §4.1, §8.2) and ENE Ambiglow MCU 0cf2:a201 (09 §3.3, plan A.2-A.4)
//    are driven purely by device-recipient vendor requests on endpoint 0. Linux usbfs accepts those
//    without a claimed interface, so this backend never claims interfaces and never detaches kernel
//    drivers (the ENE's HID interface mi_01 stays bound to usbhid; 08 §8.2 step 2, 09 plan A.3).
//  - The native addon is loaded lazily and failure-tolerant: without libusb (missing prebuild,
//    libusb_init failure, sandbox) the backend reports itself unavailable and lists no devices,
//    but never throws out of list()/onChange() and never crashes the process.
//  - Every UsbDeviceInfo it hands out carries bDeviceClass (UsbDeviceInfoWithClass), so callers can
//    tell hubs (0x09) from functions without opening anything (20 §2.3 step 2, §5 step 1).
//  - String descriptors are not read while enumerating. They are taken from sysfs
//    (/sys/bus/usb/devices/<bus>-<ports>/{serial,product,manufacturer}, cached by the kernel at
//    enumeration) only for devices that pass the caller's filter, are opened or are hotplugged, so
//    no device is touched just to learn its name and no extra permission is needed. The local copy
//    only holds devices that are present (pruned on detach and on every enumeration).
//  - node-usb hands out ONE JS Device per libusb_device (device.cc Device::get), `open()` is a no-op
//    on an open device and `close()` closes the libusb handle for every holder (device.cc:206-224).
//    Handles opened on the same device therefore share one reference-counted record: the libusb
//    handle is closed when the last of them closes, and their transfers share one FIFO lock, so a
//    close never meets a transfer in flight ("Can't close device with a pending request").

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ControlSetup, Logger, UsbBackend, UsbDeviceHandle, UsbDeviceInfo, UsbDeviceInfoWithClass } from '../types.ts';
import { Mutex } from '../core/events.ts';
import { UsbError, describeDevice, fromLibusbError, libusbErrorName } from './errors.ts';
import { usbDeviceId, usbSysfsName } from './ids.ts';
import { checkSetup, formatSetup } from './setup.ts';

// ───────────── Structural view of the parts of the `usb` package this backend uses ─────────────

export interface LegacyUsbDevice {
  busNumber: number;
  deviceAddress: number;
  /** Undefined where libusb cannot report the topology. */
  portNumbers?: number[] | undefined;
  deviceDescriptor: { idVendor: number; idProduct: number; bDeviceClass: number };
  /** Control-transfer timeout in ms, read when a transfer is submitted. */
  timeout: number;
  open(defaultConfig?: boolean): void;
  close(): void;
  controlTransfer(
    bmRequestType: number,
    bRequest: number,
    wValue: number,
    wIndex: number,
    dataOrLength: number | Uint8Array,
    callback: (error: Error | undefined, data: Uint8Array | number | undefined) => void,
  ): unknown;
}

export interface LegacyUsbModule {
  /**
   * libusb_init() result. When it is non-zero the addon's Init() returns right after setting it, so
   * getDeviceList and every other function below is missing (node_modules/usb/src/node_usb.cc:49-56).
   */
  INIT_ERROR?: number;
  getDeviceList(): LegacyUsbDevice[];
  on(event: 'attach' | 'detach', listener: (device: LegacyUsbDevice) => void): unknown;
  removeListener(event: 'attach' | 'detach', listener: (device: LegacyUsbDevice) => void): unknown;
  /** Lets the process exit while hotplug listeners are registered (usb ≥ 2.x). */
  unrefHotplugEvents?(): void;
}

/**
 * Default loader: dynamic import, so bundlers keep `usb` external and a load failure is catchable.
 * Accepts the ESM namespace and the CJS shape (esbuild turns the import into require()). Whether the
 * module is usable is decided by the backend (checkUsbModule), for injected loaders as well.
 */
export async function loadUsbModule(): Promise<LegacyUsbModule> {
  const mod = (await import('usb')) as unknown as { usb?: LegacyUsbModule; default?: { usb?: LegacyUsbModule } };
  const usb = mod.usb ?? mod.default?.usb;
  if (!usb) throw new Error('the "usb" package has no `usb` export');
  return usb;
}

/**
 * Throw the reason a loaded module is unusable. INIT_ERROR comes first: after a failed libusb_init
 * the addon exports INIT_ERROR and the constants but no functions, and the reason the user needs
 * is the libusb error, not the missing API.
 */
function checkUsbModule(usb: LegacyUsbModule): void {
  if (usb.INIT_ERROR) throw new Error(`libusb_init failed: ${libusbErrorName(usb.INIT_ERROR)}`);
  if (typeof usb.getDeviceList !== 'function') throw new Error('the "usb" package does not expose its legacy API (getDeviceList)');
}

// ───────────── Backend ─────────────

/** libusb-level timeout per control transfer (09 plan A.4 and 08 §8.2 suggest 1000 ms). */
export const DEFAULT_CONTROL_TIMEOUT_MS = 1000;

export interface LibusbBackendOptions {
  log: Logger;
  /** Loads the `usb` module; tests inject a fake. Default: {@link loadUsbModule}. */
  load?: () => Promise<LegacyUsbModule>;
  /** sysfs USB device directory for string descriptors; null disables the lookup. */
  sysfsRoot?: string | null;
  /** Timeout for transfers that do not pass one explicitly. */
  defaultTimeoutMs?: number;
}

type ChangeListener = (kind: 'attach' | 'detach', info: UsbDeviceInfoWithClass) => void;
type Strings = Pick<UsbDeviceInfo, 'serialNumber' | 'product' | 'manufacturer'>;

/** State shared by every open handle on one node-usb Device (see the header). */
interface DeviceShare {
  /** Open handles; the libusb handle is closed when this drops to 0. */
  refs: number;
  /** One transfer (or close) at a time on the device, FIFO across all its handles. */
  readonly mutex: Mutex;
}

/**
 * Per-Device records, module-wide because node-usb's Device objects are: two backend instances in
 * one process see the same objects. Weak, so a Device that is garbage-collected takes its entry along.
 */
const shares = new WeakMap<LegacyUsbDevice, DeviceShare>();

/** Cache key of an enumeration instance (the address changes on every re-enumeration). */
function enumerationKey(device: LegacyUsbDevice): string {
  const { idVendor, idProduct } = device.deviceDescriptor;
  return `${usbDeviceId(device.busNumber, device.portNumbers, device.deviceAddress)}@${device.deviceAddress}:${idVendor}:${idProduct}`;
}

export class LibusbBackend implements UsbBackend {
  readonly #log: Logger;
  readonly #load: () => Promise<LegacyUsbModule>;
  readonly #sysfsRoot: string | null;
  readonly #timeoutMs: number;
  #module: Promise<LegacyUsbModule | null> | null = null;
  #unavailableReason: string | null = null;
  /** String descriptors of present devices, by enumerationKey(). */
  readonly #strings = new Map<string, Strings>();
  readonly #listeners = new Set<ChangeListener>();
  #hotplug: { usb: LegacyUsbModule; onAttach: (d: LegacyUsbDevice) => void; onDetach: (d: LegacyUsbDevice) => void } | null = null;

  constructor(options: LibusbBackendOptions) {
    this.#log = options.log;
    this.#load = options.load ?? loadUsbModule;
    this.#sysfsRoot = options.sysfsRoot === undefined ? '/sys/bus/usb/devices' : options.sysfsRoot;
    this.#timeoutMs = options.defaultTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  }

  /** True when libusb is usable. Loads the addon on first call; never throws. */
  async isAvailable(): Promise<boolean> {
    return (await this.#usb()) !== null;
  }

  /** Why USB is unavailable (null while available or not yet probed). */
  get unavailableReason(): string | null {
    return this.#unavailableReason;
  }

  async list(filter?: (d: UsbDeviceInfoWithClass) => boolean): Promise<UsbDeviceInfoWithClass[]> {
    const usb = await this.#usb();
    if (!usb) return [];
    let devices: LegacyUsbDevice[];
    try {
      devices = usb.getDeviceList();
    } catch (e) {
      this.#log.warn('USB enumeration failed:', e instanceof Error ? e.message : e);
      return [];
    }
    this.#pruneStrings(devices);
    const result: UsbDeviceInfoWithClass[] = [];
    for (const device of devices) {
      const info = this.#describe(device, 'none');
      if (filter && !filter(info)) continue;
      result.push(this.#describe(device, 'read'));
    }
    return result;
  }

  async open(info: UsbDeviceInfo): Promise<UsbDeviceHandle> {
    const usb = await this.#usb();
    if (!usb) throw new UsbError('unavailable', `USB access is unavailable (${this.#unavailableReason}); cannot open ${describeDevice(info)}`);
    let devices: LegacyUsbDevice[];
    try {
      devices = usb.getDeviceList();
    } catch (e) {
      throw fromLibusbError(e, 'enumerate', info);
    }
    const sameIds = (d: LegacyUsbDevice) =>
      d.deviceDescriptor.idVendor === info.vendorId && d.deviceDescriptor.idProduct === info.productId;
    // Prefer the exact enumeration instance; fall back to the same port (device re-enumerated at a new address).
    const device =
      devices.find((d) => sameIds(d) && d.busNumber === info.busNumber && d.deviceAddress === info.deviceAddress) ??
      devices.find((d) => sameIds(d) && usbDeviceId(d.busNumber, d.portNumbers, d.deviceAddress) === info.id);
    if (!device) throw new UsbError('no-device', `USB device ${describeDevice(info)} is no longer present`);
    const current = this.#describe(device, 'read');
    // Everything from here on is synchronous, so concurrent open() calls cannot race on the record.
    let share = shares.get(device);
    if (share) {
      this.#log.debug(`${describeDevice(current)} is already open; sharing its libusb handle (${share.refs + 1} handles)`);
    } else {
      try {
        // open(false): libusb_open only — no configuration change, no interface claim, no driver detach.
        device.open(false);
      } catch (e) {
        throw fromLibusbError(e, 'open', current);
      }
      share = { refs: 0, mutex: new Mutex() };
      shares.set(device, share);
      this.#log.debug(`opened ${describeDevice(current)}`);
    }
    share.refs++;
    return new LibusbDeviceHandle(device, share, current, this.#timeoutMs, this.#log);
  }

  onChange(cb: ChangeListener): () => void {
    this.#listeners.add(cb);
    void this.#startHotplug();
    return () => {
      if (!this.#listeners.delete(cb) || this.#listeners.size > 0 || !this.#hotplug) return;
      const { usb, onAttach, onDetach } = this.#hotplug;
      this.#hotplug = null;
      try {
        usb.removeListener('attach', onAttach);
        usb.removeListener('detach', onDetach);
      } catch (e) {
        this.#log.debug('removing USB hotplug listeners failed:', e);
      }
    };
  }

  #usb(): Promise<LegacyUsbModule | null> {
    this.#module ??= (async () => {
      try {
        const usb = await this.#load();
        checkUsbModule(usb);
        return usb;
      } catch (e) {
        this.#unavailableReason = e instanceof Error ? e.message : String(e);
        this.#log.warn(`USB access unavailable, USB-DDC and the ENE Ambiglow driver are disabled: ${this.#unavailableReason}`);
        return null;
      }
    })();
    return this.#module;
  }

  async #startHotplug(): Promise<void> {
    const usb = await this.#usb();
    if (!usb || this.#hotplug || this.#listeners.size === 0) return;
    const onAttach = (d: LegacyUsbDevice) => this.#emit('attach', this.#describe(d, 'read'));
    // After a detach sysfs is gone: #describe() then falls back to the strings cached while attached,
    // which are dropped once the event is out.
    const onDetach = (d: LegacyUsbDevice) => {
      this.#emit('detach', this.#describe(d, 'cached'));
      this.#strings.delete(enumerationKey(d));
    };
    try {
      usb.on('attach', onAttach);
      usb.on('detach', onDetach);
      usb.unrefHotplugEvents?.();
      this.#hotplug = { usb, onAttach, onDetach };
    } catch (e) {
      this.#log.warn('USB hotplug unavailable:', e instanceof Error ? e.message : e);
      try {
        usb.removeListener('attach', onAttach);
        usb.removeListener('detach', onDetach);
      } catch {
        // nothing was registered
      }
    }
  }

  #emit(kind: 'attach' | 'detach', info: UsbDeviceInfoWithClass): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb(kind, info);
      } catch (e) {
        this.#log.error(`USB ${kind} listener failed:`, e);
      }
    }
  }

  /**
   * UsbDeviceInfo of a device. `strings`: 'none' = descriptor data only (what a list() filter sees,
   * independent of what happens to be cached), 'cached' = add cached strings only (after a detach
   * sysfs is gone), 'read' = add strings, reading sysfs if they are not cached yet.
   */
  #describe(device: LegacyUsbDevice, strings: 'none' | 'cached' | 'read'): UsbDeviceInfoWithClass {
    const { busNumber, deviceAddress, portNumbers } = device;
    const { idVendor: vendorId, idProduct: productId, bDeviceClass: deviceClass } = device.deviceDescriptor;
    const id = usbDeviceId(busNumber, portNumbers, deviceAddress);
    const info: UsbDeviceInfoWithClass = { vendorId, productId, busNumber, deviceAddress, id, deviceClass };
    if (strings === 'none') return info;
    const key = enumerationKey(device);
    let found = this.#strings.get(key);
    if (!found && strings === 'read') {
      found = this.#readSysfsStrings(busNumber, portNumbers);
      this.#strings.set(key, found);
    }
    return { ...info, ...found };
  }

  /** Forget strings of devices that are no longer enumerated (detach events can be missed without a subscriber). */
  #pruneStrings(present: readonly LegacyUsbDevice[]): void {
    if (this.#strings.size === 0) return;
    const keep = new Set(present.map(enumerationKey));
    for (const key of this.#strings.keys()) if (!keep.has(key)) this.#strings.delete(key);
  }

  #readSysfsStrings(busNumber: number, portNumbers: readonly number[] | undefined): Strings {
    const name = usbSysfsName(busNumber, portNumbers);
    if (this.#sysfsRoot === null || name === null) return {};
    const dir = join(this.#sysfsRoot, name);
    const read = (attr: string) => {
      try {
        const value = readFileSync(join(dir, attr), 'utf8').trim();
        return value === '' ? undefined : value;
      } catch {
        return undefined; // attribute absent (device has no such string) or sysfs not mounted
      }
    };
    const strings: Strings = {};
    const serialNumber = read('serial');
    const product = read('product');
    const manufacturer = read('manufacturer');
    if (serialNumber !== undefined) strings.serialNumber = serialNumber;
    if (product !== undefined) strings.product = product;
    if (manufacturer !== undefined) strings.manufacturer = manufacturer;
    return strings;
  }
}

// ───────────── Handle ─────────────

class LibusbDeviceHandle implements UsbDeviceHandle {
  readonly info: UsbDeviceInfoWithClass;
  #device: LegacyUsbDevice | null;
  /** Shared with the other handles on the device: one transfer at a time, FIFO, across all of them. */
  readonly #share: DeviceShare;
  readonly #timeoutMs: number;
  readonly #log: Logger;

  constructor(device: LegacyUsbDevice, share: DeviceShare, info: UsbDeviceInfoWithClass, timeoutMs: number, log: Logger) {
    this.#device = device;
    this.#share = share;
    this.info = info;
    this.#timeoutMs = timeoutMs;
    this.#log = log;
  }

  async controlOut(setup: ControlSetup, data: Uint8Array, timeoutMs?: number): Promise<void> {
    checkSetup(setup, 'out', data.length, this.info);
    const op = `control OUT ${formatSetup(setup, data.length)}`;
    return this.#share.mutex.run(async () => {
      const actual = await this.#transfer(setup, data, timeoutMs, op);
      if (typeof actual === 'number' && actual !== data.length) {
        throw new UsbError('io', `${op} on USB device ${describeDevice(this.info)}: short write (${actual}/${data.length} bytes)`);
      }
    });
  }

  /** Resolves with the bytes the device returned, which may be fewer than `length` (short packet). */
  async controlIn(setup: ControlSetup, length: number, timeoutMs?: number): Promise<Uint8Array> {
    checkSetup(setup, 'in', length, this.info);
    const op = `control IN ${formatSetup(setup, length)}`;
    return this.#share.mutex.run(async () => {
      const data = await this.#transfer(setup, length, timeoutMs, op);
      return data instanceof Uint8Array ? Uint8Array.from(data) : new Uint8Array(0);
    });
  }

  /**
   * Release this handle. The libusb handle is closed with the last handle on the device; holding
   * the device lock, no transfer of this backend can be in flight then. libusb_close also succeeds
   * on an unplugged device.
   */
  async close(): Promise<void> {
    await this.#share.mutex.run(async () => {
      const device = this.#device;
      if (!device) return;
      this.#device = null;
      if (--this.#share.refs > 0) return;
      shares.delete(device);
      try {
        device.close();
      } catch (e) {
        // Only thrown while a transfer is pending, i.e. someone outside this backend uses the device.
        this.#log.warn(`closing ${describeDevice(this.info)} failed:`, e instanceof Error ? e.message : e);
      }
    });
  }

  #transfer(setup: ControlSetup, dataOrLength: Uint8Array | number, timeoutMs: number | undefined, op: string) {
    return new Promise<Uint8Array | number | undefined>((resolve, reject) => {
      const device = this.#device;
      if (!device) {
        reject(new UsbError('closed', `${op}: handle for ${describeDevice(this.info)} is closed`));
        return;
      }
      device.timeout = timeoutMs ?? this.#timeoutMs;
      try {
        device.controlTransfer(setup.bmRequestType, setup.bRequest, setup.wValue, setup.wIndex, dataOrLength, (error, result) => {
          if (error) reject(fromLibusbError(error, op, this.info));
          else resolve(result);
        });
      } catch (e) {
        reject(fromLibusbError(e, op, this.info));
      }
    });
  }
}
