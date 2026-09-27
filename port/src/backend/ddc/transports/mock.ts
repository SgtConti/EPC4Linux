// Simulated Philips Evnia 34M2C8600 for tests, the CLI (--mock) and EVNIA_MOCK_MONITOR.
//
// `SimulatedMonitor` is a DDC/CI slave (0x37) plus EDID EEPROM (0x50) working on raw frames, so every
// real code path can run against it:
//   - MockDdcTransport            : DdcTransport kind 'mock' talking to the simulator directly
//   - createMockViaHandler()      : firmware of the VIA bridge (B2/A3/A7/A9) for usb/FakeUsbBackend
//   - mockViaDeviceSpec()         : the user's 2109:8884 bridge as a FakeUsbBackend device spec
//   - createMockI2cSyscalls()     : I2cSyscalls for /dev/i2c-N paths wired to simulators
//   - writeMockSysfs()            : a fake /sys tree (DRM connector + i2c adapter + USB device class)
//   - createMock34M2C8600()       : all of the above in one call, returning a DiscoveredMonitor
// The simulator answers the TPV identity page with the values the real monitor reported; reply byte
// layouts that were never captured (07 §10 Q1, 08 §10 Q5) are chosen so that the vendor parsers
// (length-relative VCP parse, imethod_8) extract the logged values.

import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ControlSetup, DdcTransport, DiscoveredMonitor, UsbDeviceInfo } from '../../types.ts';
import { FakeUsbBackend, type FakeUsbDeviceSpec, type FakeUsbHandler } from '../../usb/fake-backend.ts';
import {
  DDC_DEST,
  DDC_HOST_SRC,
  DDC_READ_ADDR,
  DDC_REPLY_SEED,
  EXT_BASE,
  OP_CAPS_REPLY,
  OP_CAPS_REQUEST,
  OP_GET_VCP,
  OP_GET_VCP_REPLY,
  OP_SET_VCP,
  TPV_QUERY,
  xorChecksum,
} from '../codec.ts';
import { parseEdid } from '../edid.ts';
import { I2cDevTransport, type I2cSyscalls } from './i2cdev.ts';
import { MOCK_34M2C8600, type MockMonitorSpec } from './mock-34m2c8600.ts';
import { VIA_DDC_BRIDGE_PID, VIA_REQUEST, VIA_VENDOR_ID, ViaUsbTransport } from './via.ts';

export type MockFault =
  /** The next DDC write is not acknowledged (transport error). */
  | 'nack-write'
  /** The next DDC read is not acknowledged (transport error). */
  | 'nack-read'
  /** The next reply carries a wrong checksum. */
  | 'bad-checksum'
  /** The next reply is a DDC/CI null message (display busy). */
  | 'null-reply';

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const NULL_MESSAGE = Uint8Array.of(DDC_DEST, 0x80, DDC_REPLY_SEED ^ DDC_DEST ^ 0x80);
const CAPS_FRAGMENT = 32;
const SN_QUERY_7 = [0xfe, 0xef, 0x13, 0x00, 0x00, 0x20]; // DDCHelper variant (07 §4.8.4)

interface Control { value: number; max: number }

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class SimulatedMonitor {
  readonly spec: MockMonitorSpec;
  readonly edid: Uint8Array;
  /** Every frame received on 0x37 (as written, starting with 0x51), for test assertions. */
  readonly frames: Uint8Array[] = [];
  #controls = new Map<number, Control>();
  #modeStore = new Map<number, Map<number, number>>();
  #eqGains: number[] = [];
  #reply: Uint8Array = NULL_MESSAGE;
  #faults: MockFault[] = [];

  constructor(spec: MockMonitorSpec = MOCK_34M2C8600) {
    this.spec = spec;
    this.edid = hexToBytes(spec.edidHex);
    this.factoryReset();
  }

  /** Restore every control to its seed value (VCP 04 "restore factory defaults"). */
  factoryReset(): void {
    this.#controls = new Map(this.spec.vcp.map(([code, value, max]) => [code, { value, max }]));
    this.#modeStore.clear();
    this.#eqGains = Array.from({ length: this.spec.eq.bands }, () => this.spec.eq.defaultGain);
  }

  /** Current value/max of a control (TPV codes as 0xE2A0xx), or undefined if unsupported. */
  control(code: number): { value: number; max: number } | undefined {
    if (code === EXT_BASE + 0x39) return { value: this.#eqGains[this.#band()], max: this.spec.eq.maxGain };
    const c = this.#controls.get(code);
    return c ? { ...c } : undefined;
  }

  /**
   * A change made on the monitor itself (OSD keys, or the source switching HDR on and off), not by the
   * host: the value is applied with the same rules as a Set VCP, but no host frame is recorded and a
   * pending reply is left alone, so a transaction the host has in flight is not disturbed.
   * Returns false for a control the monitor does not have.
   */
  osdSet(code: number, value: number): boolean {
    if (!this.#controls.has(code) && code !== EXT_BASE + 0x39) return false;
    this.#set(code, value);
    return true;
  }

  /** Queue faults consumed by the next operations of the matching kind. */
  injectFault(kind: MockFault, count = 1): void {
    for (let i = 0; i < count; i++) this.#faults.push(kind);
  }

  /** Host frame on slave 0x37: `51 (80|n) payload chk` (without the 0x6E address byte). */
  receive(frame: Uint8Array): void {
    if (this.#takeFault('nack-write')) throw new Error('simulated NACK on write');
    this.frames.push(frame.slice());
    const n = frame.length >= 2 ? frame[1] & 0x7f : -1;
    if (frame[0] !== DDC_HOST_SRC || (frame[1] & 0x80) === 0 || frame.length < n + 3 || xorChecksum(frame.subarray(0, n + 2), DDC_DEST) !== frame[n + 2]) {
      this.#reply = NULL_MESSAGE;
      return;
    }
    this.#reply = this.#handle(frame.subarray(2, 2 + n));
  }

  /** Read on slave 0x37: the pending reply, padded with 0xFF (idle bus) to `length`. */
  reply(length: number): Uint8Array {
    if (this.#takeFault('nack-read')) throw new Error('simulated NACK on read');
    let reply = this.#reply;
    if (this.#takeFault('null-reply')) reply = NULL_MESSAGE;
    else if (this.#takeFault('bad-checksum')) {
      reply = reply.slice();
      reply[reply.length - 1] ^= 0x5a;
    }
    const out = new Uint8Array(length).fill(0xff);
    out.set(reply.subarray(0, length));
    return out;
  }

  /** EEPROM read on slave 0x50. */
  readEdid(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length).fill(0xff);
    out.set(this.edid.subarray(offset, offset + length));
    return out;
  }

  #takeFault(kind: MockFault): boolean {
    const i = this.#faults.indexOf(kind);
    if (i < 0) return false;
    this.#faults.splice(i, 1);
    return true;
  }

  #band(): number {
    return Math.min(this.#controls.get(EXT_BASE + 0x01)?.value ?? 0, this.spec.eq.bands - 1);
  }

  #handle(p: Uint8Array): Uint8Array {
    if (p[0] === OP_GET_VCP && p.length === 2) return this.#vcpReply(p[1], p[1]);
    if (p[0] === OP_GET_VCP && p.length === 4 && p[1] === 0xe2 && p[2] === 0xa0) return this.#vcpReply(EXT_BASE | p[3], 0xe2);
    if (p[0] === OP_GET_VCP && p[1] === 0xfe) return this.#tpvReply(p.subarray(1));
    if (p[0] === OP_SET_VCP && p.length === 4) this.#set(p[1], (p[2] << 8) | p[3]);
    else if (p[0] === OP_SET_VCP && p.length === 6 && p[1] === 0xe2 && p[2] === 0xa0) this.#set(EXT_BASE | p[3], (p[4] << 8) | p[5]);
    else if (p[0] === OP_CAPS_REQUEST && p.length === 3) return this.#capsReply((p[1] << 8) | p[2]);
    return NULL_MESSAGE;
  }

  /** `02 RC cc 00 MH ML SH SL`; unsupported codes answer RC=1 with zeros (MCCS). */
  #vcpReply(code: number, echo: number): Uint8Array {
    const c = this.control(code);
    return frameReply(c
      ? [OP_GET_VCP_REPLY, 0x00, echo, 0x00, c.max >> 8, c.max & 0xff, c.value >> 8, c.value & 0xff]
      : [OP_GET_VCP_REPLY, 0x01, echo, 0x00, 0, 0, 0, 0]);
  }

  /** TPV "FE" page: echo `FE xx yy` then data (08 §3.4); the serial is raw ASCII without echo. */
  #tpvReply(args: Uint8Array): Uint8Array {
    const id = this.spec.identity;
    const ascii = (s: string) => frameReply([args[0], args[1], args[2], ...Buffer.from(s, 'latin1')]);
    if (sameBytes(args, TPV_QUERY.modelName)) return ascii(id.modelName);
    if (sameBytes(args, TPV_QUERY.bomString)) return ascii(id.bomString);
    if (sameBytes(args, TPV_QUERY.fwVersion)) return ascii(id.fwVersion);
    if (sameBytes(args, TPV_QUERY.scalerName)) return ascii(id.scalerName);
    if (sameBytes(args, TPV_QUERY.dualImageBank)) {
      // Pad byte 0 exercises imethod_8's "r[5] == 0 → start at r[6]" rule.
      return frameReply([args[0], args[1], args[2], 0x00, 0x00, id.dualImageBank >> 8, id.dualImageBank & 0xff]);
    }
    if (sameBytes(args, TPV_QUERY.serialNumber) || sameBytes(args, SN_QUERY_7)) return frameReply([...Buffer.from(id.serialNumber, 'latin1')]);
    // Panel name and boot-flag address were never read from the real monitor: answer "unsupported".
    return NULL_MESSAGE;
  }

  #capsReply(offset: number): Uint8Array {
    const data = Buffer.from(this.spec.capabilities, 'latin1').subarray(offset, offset + CAPS_FRAGMENT);
    return frameReply([OP_CAPS_REPLY, offset >> 8, offset & 0xff, ...data]);
  }

  #set(code: number, value: number): void {
    const c = this.#controls.get(code);
    if (!c && code !== EXT_BASE + 0x39) return;
    switch (code) {
      case 0x04:
        if (value !== 0) this.factoryReset();
        return;
      case 0xdc:
        this.#switchMode(value);
        return;
      case EXT_BASE + 0x01:
        c!.value = Math.min(value, this.spec.eq.bands - 1);
        return;
      case EXT_BASE + 0x39:
        this.#eqGains[this.#band()] = Math.min(value, this.spec.eq.maxGain);
        return;
      case EXT_BASE + 0x38:
        if (value !== 0) this.#restoreSeeds(this.spec.ambiglow);
        return;
      case EXT_BASE + 0x42:
        this.#restoreSeeds(this.spec.perMode);
        return;
      default:
        c!.value = this.spec.continuous.includes(code) ? Math.min(value, c!.max) : value;
    }
  }

  #restoreSeeds(codes: readonly number[]): void {
    for (const [code, value] of this.spec.vcp) {
      const c = this.#controls.get(code);
      if (c && codes.includes(code)) c.value = value;
    }
  }

  /** SmartImage change: picture controls are stored per mode, like the real OSD. */
  #switchMode(mode: number): void {
    const dc = this.#controls.get(0xdc)!;
    if (dc.value === mode) return;
    const saved = new Map<number, number>();
    for (const code of this.spec.perMode) {
      const c = this.#controls.get(code);
      if (c) saved.set(code, c.value);
    }
    this.#modeStore.set(dc.value, saved);
    dc.value = mode;
    const restore = this.#modeStore.get(mode);
    if (restore) for (const [code, value] of restore) this.#controls.get(code)!.value = value;
    else this.#restoreSeeds(this.spec.perMode);
  }
}

/** `6E (80|L) payload chk` with the 0x50-seeded reply checksum. */
function frameReply(payload: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array(payload.length + 3);
  out[0] = DDC_DEST;
  out[1] = 0x80 | payload.length;
  out.set(Array.from(payload), 2);
  out[out.length - 1] = xorChecksum(out.subarray(0, out.length - 1), DDC_REPLY_SEED);
  return out;
}

/** DdcTransport kind 'mock' wired straight to a simulator (no USB/i2c layer). */
export class MockDdcTransport implements DdcTransport {
  readonly kind = 'mock' as const;
  readonly id: string;
  readonly monitor: SimulatedMonitor;

  constructor(monitor: SimulatedMonitor, id = `mock:${monitor.spec.name}`) {
    this.monitor = monitor;
    this.id = id;
  }

  async write(message: Uint8Array): Promise<void> {
    this.monitor.receive(message);
  }

  async read(length: number): Promise<Uint8Array> {
    return this.monitor.reply(length);
  }

  async close(): Promise<void> {}
}

// ───────────────────────────── USB side ─────────────────────────────

/**
 * Firmware of the VIA I2C bridge in the monitor hub, as a handler for the usb module's
 * FakeUsbBackend: B2 writes forward `data[1..]` to the DDC slave when data[0] is 0x6E; A3/A7
 * (wIndex 0x6F) read the pending reply and A9 continues after the A7 chunk (08 §4.2-4.3). Anything
 * else is rejected, which the fake backend reports as a STALL.
 */
export function createMockViaHandler(monitor: SimulatedMonitor): FakeUsbHandler {
  let pending: Uint8Array | null = null;
  let cursor = 0;
  const stall = (setup: ControlSetup) =>
    new Error(`unsupported request ${setup.bmRequestType.toString(16)}/${setup.bRequest.toString(16)} wIndex=${setup.wIndex.toString(16)}`);
  return {
    controlOut(setup, data) {
      if (setup.bmRequestType !== 0x40 || setup.bRequest !== VIA_REQUEST.write || setup.wValue !== 0 || setup.wIndex !== 0) throw stall(setup);
      if (data[0] !== DDC_DEST) throw stall(setup); // other slaves (e.g. the ISP at 0x94) are not simulated
      pending = null;
      monitor.receive(data.subarray(1));
    },
    controlIn(setup, length) {
      if (setup.bmRequestType !== 0xc0 || setup.wValue !== 0) throw stall(setup);
      if ((setup.bRequest === VIA_REQUEST.read || setup.bRequest === VIA_REQUEST.readStart) && setup.wIndex === DDC_READ_ADDR) {
        pending = monitor.reply(64);
        cursor = length;
        return pending.slice(0, length);
      }
      if (setup.bRequest === VIA_REQUEST.readEnd && setup.wIndex === 0 && pending) {
        const chunk = pending.slice(cursor, cursor + length);
        pending = null;
        return chunk;
      }
      throw stall(setup);
    },
  };
}

/** The user's bridge: 2109:8884, serial 0000000000000001 (08 §2.3), on port 2.4 of bus 3 ("usb:3-2.4"). */
export function mockViaDeviceSpec(monitor: SimulatedMonitor, overrides: Partial<Omit<FakeUsbDeviceSpec, 'handler'>> = {}): FakeUsbDeviceSpec {
  return {
    vendorId: VIA_VENDOR_ID,
    productId: VIA_DDC_BRIDGE_PID,
    busNumber: 3,
    portNumbers: [2, 4],
    deviceAddress: 7,
    serialNumber: '0000000000000001',
    ...overrides,
    handler: createMockViaHandler(monitor),
  };
}

// ───────────────────────────── i2c side ─────────────────────────────

/** I2cSyscalls where each /dev/i2c-N path is wired to a simulator; unknown paths fail with ENOENT. */
export function createMockI2cSyscalls(buses: Record<string, SimulatedMonitor>): I2cSyscalls {
  const fds = new Map<number, { monitor: SimulatedMonitor; slave: number; edidOffset: number }>();
  let next = 100;
  const get = (fd: number) => {
    const f = fds.get(fd);
    if (!f) throw new Error('EBADF');
    return f;
  };
  return {
    async open(path) {
      const monitor = buses[path];
      if (!monitor) throw new Error(`open ${path}: ENOENT`);
      fds.set(++next, { monitor, slave: -1, edidOffset: 0 });
      return next;
    },
    async setSlave(fd, address) {
      get(fd).slave = address;
    },
    async write(fd, data) {
      const f = get(fd);
      if (f.slave === 0x37) f.monitor.receive(data);
      else if (f.slave === 0x50) f.edidOffset = data[0] ?? 0;
      else throw new Error('write: ENXIO');
      return data.length;
    },
    async read(fd, length) {
      const f = get(fd);
      if (f.slave === 0x37) return f.monitor.reply(length);
      if (f.slave === 0x50) {
        const out = f.monitor.readEdid(f.edidOffset, length);
        f.edidOffset += length;
        return out;
      }
      throw new Error('read: ENXIO');
    },
    async close(fd) {
      fds.delete(fd);
    },
  };
}

// ───────────────────────────── fake sysfs ─────────────────────────────

export interface MockSysfsLayout {
  card: string;
  connector: string;
  /** Adapter behind the `ddc` link (GPIO DDC engine, "AMDGPU DM i2c hw bus N"). */
  bus: number;
  /** Adapter created as the connector's child (I2C-over-AUX, "AMDGPU DM aux hw bus N"). */
  auxBus: number;
  /** PCI address of the fake GPU (a VGA-class device). */
  pci: string;
  /** How the connector exposes its buses. */
  link: 'ddc' | 'aux' | 'both' | 'none';
}

export const DEFAULT_MOCK_SYSFS: MockSysfsLayout = {
  card: 'card1',
  connector: 'DP-1',
  bus: 5,
  auxBus: 6,
  pci: '0000:03:00.0',
  link: 'ddc',
};

/**
 * Create the parts of /sys that discovery reads, for one monitor: the DRM connector (status, edid,
 * `ddc` link and/or AUX child adapter), the GPU (PCI class) and its adapters (name, bus/i2c entries),
 * and, optionally, the device class of mock USB devices. With `link: 'none'` the GPIO adapter still
 * exists under the GPU but is not linked, for the EDID-matching path.
 */
export async function writeMockSysfs(root: string, monitor: SimulatedMonitor, layout: Partial<MockSysfsLayout> = {}, usb: UsbDeviceInfo[] = []): Promise<void> {
  const l = { ...DEFAULT_MOCK_SYSFS, ...layout };
  const gpu = join(root, 'devices/pci0000:00', l.pci);
  const card = join(gpu, 'drm', l.card);
  const connDir = join(card, `${l.card}-${l.connector}`);
  const adapter = async (dir: string, n: number, name: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'name'), `${name}\n`);
    await mkdir(join(root, 'class/i2c-dev', `i2c-${n}`), { recursive: true });
    await symlink(dir, join(root, 'bus/i2c/devices', `i2c-${n}`)).catch(ignoreExists);
  };
  await mkdir(connDir, { recursive: true });
  await mkdir(join(root, 'class/drm'), { recursive: true });
  await mkdir(join(root, 'bus/i2c/devices'), { recursive: true });
  await writeFile(join(gpu, 'class'), '0x030000\n');
  await writeFile(join(connDir, 'status'), 'connected\n');
  await writeFile(join(connDir, 'edid'), monitor.edid);
  await symlink(gpu, join(card, 'device')).catch(ignoreExists);
  await symlink(connDir, join(root, 'class/drm', `${l.card}-${l.connector}`)).catch(ignoreExists);
  await symlink(card, join(root, 'class/drm', l.card)).catch(ignoreExists);
  if (l.link !== 'aux') {
    const ddcDir = join(gpu, `i2c-${l.bus}`);
    await adapter(ddcDir, l.bus, `AMDGPU DM i2c hw bus ${l.bus}`);
    if (l.link !== 'none') await symlink(ddcDir, join(connDir, 'ddc')).catch(ignoreExists);
  }
  if (l.link === 'aux' || l.link === 'both') await adapter(join(connDir, `i2c-${l.auxBus}`), l.auxBus, `AMDGPU DM aux hw bus ${l.auxBus}`);
  for (const info of usb) {
    const m = /^usb:(\d+-[\d.]+)$/.exec(info.id);
    if (!m) continue;
    const dir = join(root, 'bus/usb/devices', m[1]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'bDeviceClass'), '00\n');
  }
}

function ignoreExists(e: NodeJS.ErrnoException): void {
  if (e.code !== 'EEXIST') throw e;
}

// ───────────────────────────── one-call factory ─────────────────────────────

export interface MockMonitorBundle {
  monitor: SimulatedMonitor;
  /** Fake USB bus holding the VIA bridge (journals every control transfer). */
  usb: FakeUsbBackend;
  viaInfo: UsbDeviceInfo;
  i2c: I2cSyscalls;
  busPath: string;
  /** Ready-made discovery result: VIA transport first, i2c-dev second (06 §5.1 order). */
  discovered: DiscoveredMonitor;
}

/**
 * The simulated 34M2C8600 reachable over both a mock VIA bridge and a mock /dev/i2c-5. `spec` replaces the
 * seed (default MOCK_34M2C8600, whose identity is synthetic), e.g. with the captured unit's EDID and serial
 * in tests that replay the captured session.
 */
export async function createMock34M2C8600(
  options: { busPath?: string; connector?: string; transports?: Array<'via' | 'i2c'>; spec?: MockMonitorSpec } = {},
): Promise<MockMonitorBundle> {
  const monitor = new SimulatedMonitor(options.spec ?? MOCK_34M2C8600);
  const busPath = options.busPath ?? '/dev/i2c-5';
  const usb = new FakeUsbBackend();
  const viaInfo = usb.attach(mockViaDeviceSpec(monitor));
  const i2c = createMockI2cSyscalls({ [busPath]: monitor });
  const wanted = options.transports ?? ['via', 'i2c'];
  const transports: DdcTransport[] = [];
  if (wanted.includes('via')) transports.push(new ViaUsbTransport(await usb.open(viaInfo)));
  if (wanted.includes('i2c')) transports.push(new I2cDevTransport(busPath, i2c));
  const edid = parseEdid(monitor.edid);
  return {
    monitor,
    usb,
    viaInfo,
    i2c,
    busPath,
    discovered: { key: edid.serialString, edid, connector: options.connector ?? 'card1-DP-1', transports },
  };
}
