// Simulated ENE Ambiglow MCU (0cf2:a201) for the fake USB backend: mock mode (EVNIA_MOCK_MONITOR)
// and tests run the real driver code (ene*.ts) against it.
//
// It models a 64 KiB register file behind the two vendor requests (09 §3.3): C0/81 reads and
// 40/80 writes with address auto-increment. Defaults are the user's 34M2C8600 as seen in
// logs/EvniaServe-2026-09-25.txt: model "34M2C8600" (line 650), FW 03 32 07 0F 0B (line 651),
// a 10-digit USB serial (line 31; the mock ships a synthetic one, no identifier of the user's unit).
// Values not visible in the logs are marked [I] (09 Open questions 3 and 5): 3 LED groups of
// 14/18/14, revision 0x01, trim status 0x01.
// Firmware behaviour is reduced to what the port relies on: a group's settings take effect when
// 1 is written to its apply register (+0xF), and the frame buffer/audio registers are live.
// Writes to any register the device does not document are refused with a STALL and recorded in
// `violations`, so tests can assert that the driver never touches e.g. the flash controller or the
// registers behind the frame buffer (09 plan F.3). The mock's register map is its own, written out
// from 09 §4.2 (writableRegisters below) with a frame buffer sized by its own LED counts; it does
// not reuse the driver's access policy (ene-registers.ts), so the check tests the driver instead of
// mirroring it.

import type { ControlSetup } from '../types.ts';
import { UsbError } from '../usb/errors.ts';
import type { FakeUsbDeviceSpec, FakeUsbHandler } from '../usb/fake-backend.ts';
import type { EneLedCounts } from './ene-frame.ts';
import {
  ENE_BM_READ,
  ENE_BM_WRITE,
  ENE_CHIP_ID,
  ENE_GROUPS,
  ENE_PRODUCT_ID,
  ENE_REQ_READ,
  ENE_REQ_WRITE,
  ENE_VENDOR_ID,
  EneField,
  EneReg,
  groupReg,
  staticColorReg,
  type EneGroup,
} from './ene-registers.ts';

export interface MockEneOptions {
  modelName?: string;
  firmware?: readonly number[];
  chipId?: number;
  revision?: number;
  trimStatus?: number;
  ledGroups?: number;
  counts?: EneLedCounts;
  /** Value of the name-length register 0xE9F0; default: the model name's length. */
  modelNameLength?: number;
  serialNumber?: string;
}

/** A group's settings as latched by its apply register. */
export interface MockEneGroupState {
  mode: number;
  swMode: number;
  speed: number;
  direction: number;
  brightness: number;
  color: [number, number, number];
}

export interface MockEneState {
  /** 0x0023: 0x04 while the host controls the LEDs. */
  hostControl: number;
  /** Latched settings per group (null until the group's apply register was written). */
  groups: Record<EneGroup, MockEneGroupState | null>;
  /** Frame buffer from 0xE300, 3 bytes per LED of the groups the mock reports (at most 1..3). */
  frame: Uint8Array;
  audioLevel: [number, number, number];
  audioLevelRainbow: [number, number, number];
}

export const MOCK_ENE_DEFAULTS = {
  modelName: '34M2C8600',
  firmware: [0x03, 0x32, 0x07, 0x0f, 0x0b],
  chipId: ENE_CHIP_ID,
  revision: 0x01,
  trimStatus: 0x01,
  ledGroups: 3,
  counts: { border: 14, central: 18, bottom: 14 },
  serialNumber: '0000000001',
} as const;

const REGISTER_SPACE = 0x10000;

/**
 * The registers the simulated device accepts writes to (1 = writable), per the tables of 09 §4.2:
 * written out here rather than taken from the driver, see the header.
 */
function writableRegisters(frameLeds: number): Uint8Array {
  const map = new Uint8Array(REGISTER_SPACE);
  const allow = (from: number, length: number) => map.fill(1, from, from + length);
  allow(0x0023, 1); // "USBCableLivingSwitch"
  for (const base of [0xe020, 0xe030, 0xe040, 0xe050]) {
    for (const offset of [0x0, 0x1, 0x2, 0x3, 0x9, 0xf]) allow(base + offset, 1); // SWMode, mode, speed, direction, brightness, apply
  }
  allow(0xe300, 3 * frameLeds); // per-LED frame buffer, R,G,B per LED
  allow(0xe960, 3); // audio level (FollowAudio)
  allow(0xe970, 3); // audio level (FollowAudioRainbow)
  allow(0xe980, 12); // static colours R,G,B of groups 1..4
  return map;
}

export class MockEneDevice implements FakeUsbHandler {
  readonly registers = new Uint8Array(REGISTER_SPACE);
  /** Refused requests, e.g. "write 0x0415 len 1". */
  readonly violations: string[] = [];
  readonly serialNumber: string;
  /** LEDs in the frame buffer: those of the groups the device reports (groups 1..3 have counts). */
  readonly frameLeds: number;
  readonly #writable: Uint8Array;
  readonly #latched = new Map<EneGroup, MockEneGroupState>();

  constructor(options: MockEneOptions = {}) {
    const d = MOCK_ENE_DEFAULTS;
    const o = {
      modelName: options.modelName ?? d.modelName,
      firmware: options.firmware ?? d.firmware,
      chipId: options.chipId ?? d.chipId,
      revision: options.revision ?? d.revision,
      trimStatus: options.trimStatus ?? d.trimStatus,
      ledGroups: options.ledGroups ?? d.ledGroups,
      counts: { ...(options.counts ?? d.counts) },
    };
    this.serialNumber = options.serialNumber ?? d.serialNumber;
    const groupCounts = [o.counts.border, o.counts.central, o.counts.bottom];
    this.frameLeds = groupCounts.slice(0, Math.max(0, o.ledGroups)).reduce((sum, n) => sum + n, 0);
    this.#writable = writableRegisters(this.frameLeds);
    const r = this.registers;
    r[EneReg.CHIP_ID_HI] = (o.chipId >> 8) & 0xff;
    r[EneReg.CHIP_ID_LO] = o.chipId & 0xff;
    r[EneReg.CHIP_REV] = o.revision;
    r[EneReg.TRIM_STATUS] = o.trimStatus;
    r[EneReg.LED_GROUPS] = o.ledGroups;
    r[EneReg.LED_COUNT_BORDER] = o.counts.border;
    r[EneReg.LED_COUNT_CENTRAL] = o.counts.central;
    r[EneReg.LED_COUNT_BOTTOM] = o.counts.bottom;
    const name = new TextEncoder().encode(o.modelName);
    r[EneReg.MODEL_NAME_LEN] = options.modelNameLength ?? name.length;
    r.set(name, EneReg.MODEL_NAME);
    r.set(o.firmware, EneReg.FW_VERSION);
  }

  /** Device description for FakeUsbBackend.attach(). */
  spec(placement: Pick<FakeUsbDeviceSpec, 'busNumber' | 'portNumbers' | 'deviceAddress'> = {}): FakeUsbDeviceSpec {
    return { vendorId: ENE_VENDOR_ID, productId: ENE_PRODUCT_ID, serialNumber: this.serialNumber, handler: this, ...placement };
  }

  controlIn(setup: ControlSetup, length: number): Uint8Array {
    const reg = this.#address(setup);
    if (setup.bmRequestType !== ENE_BM_READ || setup.bRequest !== ENE_REQ_READ || reg >= REGISTER_SPACE) {
      throw this.#stall('IN', setup, length);
    }
    return this.registers.slice(reg, Math.min(reg + length, REGISTER_SPACE));
  }

  controlOut(setup: ControlSetup, data: Uint8Array): void {
    if (setup.bmRequestType !== ENE_BM_WRITE || setup.bRequest !== ENE_REQ_WRITE) throw this.#stall('OUT', setup, data.length);
    const reg = this.#address(setup);
    // Every byte of a multi-byte write lands on its own register (auto-increment): all must be writable.
    const writable = reg + data.length <= REGISTER_SPACE && data.every((_, i) => this.#writable[reg + i] === 1);
    if (!writable) {
      this.violations.push(`write 0x${reg.toString(16).padStart(4, '0')} len ${data.length}`);
      throw this.#stall('OUT', setup, data.length);
    }
    this.registers.set(data, reg);
    for (const g of ENE_GROUPS) {
      const apply = groupReg(g, EneField.APPLY);
      if (apply >= reg && apply < reg + data.length && this.registers[apply] === 1) this.#latch(g);
    }
  }

  state(): MockEneState {
    const r = this.registers;
    const three = (base: number): [number, number, number] => [r[base], r[base + 1], r[base + 2]];
    return {
      hostControl: r[EneReg.HOST_CONTROL],
      groups: { 1: this.#group(1), 2: this.#group(2), 3: this.#group(3), 4: this.#group(4) },
      frame: r.slice(EneReg.FRAME_BUFFER, EneReg.FRAME_BUFFER + 3 * this.frameLeds),
      audioLevel: three(EneReg.AUDIO_LEVEL),
      audioLevelRainbow: three(EneReg.AUDIO_LEVEL_RAINBOW),
    };
  }

  #group(g: EneGroup): MockEneGroupState | null {
    const s = this.#latched.get(g);
    return s ? { ...s, color: [...s.color] } : null;
  }

  #latch(g: EneGroup): void {
    const r = this.registers;
    const c = staticColorReg(g);
    this.#latched.set(g, {
      mode: r[groupReg(g, EneField.MODE)],
      swMode: r[groupReg(g, EneField.SW_MODE)],
      speed: r[groupReg(g, EneField.SPEED)],
      direction: r[groupReg(g, EneField.DIRECTION)],
      brightness: r[groupReg(g, EneField.BRIGHTNESS)],
      color: [r[c], r[c + 1], r[c + 2]],
    });
  }

  #address(setup: ControlSetup): number {
    return setup.wValue * 0x10000 + setup.wIndex;
  }

  #stall(dir: 'IN' | 'OUT', setup: ControlSetup, length: number): UsbError {
    return new UsbError('stall', `mock ENE: unsupported control ${dir} request ${JSON.stringify({ ...setup, length })}: LIBUSB_TRANSFER_STALL`);
  }
}
