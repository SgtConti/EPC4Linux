// Register access to the ENE MCU over EP0 vendor control transfers — the Linux equivalent of
// EneEc.dll's Ec_ReadRegs/Ec_WriteRegs on WinUSB (09 §3.3) plus the C# write pacing (09 §3.5).
//
//   read  n bytes at reg:  C0 81 <reg>>16> <reg&FFFF> <n>   device→host n bytes
//   write n bytes at reg:  40 80 <reg>>16> <reg&FFFF> <n>   host→device n bytes
//
// Multi-byte transfers auto-increment the register address on the device. Every write is followed
// by a 10 ms pause (Class0.method_4) unless the caller opts out (the 0x0023 switch, 09 §3.5).
// Accesses outside the documented register map are refused (ene-registers.ts, 09 plan F.3); the
// frame-buffer window opens only once the device's LED count is known (setFrameBufferLeds).
// The transport does not serialize callers; EneDevice runs one operation at a time.

import type { ControlSetup, Logger, UsbDeviceHandle } from '../types.ts';
import { sleep as defaultSleep } from '../core/events.ts';
import { formatSetup } from '../usb/setup.ts';
import {
  ENE_BM_READ,
  ENE_BM_WRITE,
  ENE_MAX_TRANSFER,
  ENE_REQ_READ,
  ENE_REQ_WRITE,
  ENE_WRITE_DELAY_MS,
  isReadableRange,
  isWritableRange,
} from './ene-registers.ts';

export type EneErrorCode =
  /** Chip id is not 0x7730 (not an Evnia Ambiglow controller). */
  | 'not-ene'
  /** FW version bytes 0..3 are all zero: CUSBENE6K7732.Plug() rejects the device. */
  | 'invalid-firmware'
  /** Model name not in PCenter_AmbiglowInfo.json: the vendor never drives such a device. */
  | 'unsupported-model'
  /** Access outside the documented register windows (09 plan F.3). */
  | 'forbidden-register'
  /** The device went away (unplugged or re-enumerated); the EneDevice must be closed and re-opened. */
  | 'lost'
  | 'closed';

export class EneError extends Error {
  readonly code: EneErrorCode;

  constructor(code: EneErrorCode, message: string) {
    super(message);
    this.name = 'EneError';
    this.code = code;
  }
}

export interface EneTransportOptions {
  log: Logger;
  /** Pause after each paced write; default 10 ms (vendor). Tests use 0. */
  writeDelayMs?: number;
  /** Per-transfer libusb timeout; default: the USB backend's (1000 ms). */
  timeoutMs?: number;
  /** Injectable for tests that record the pacing. */
  sleep?: (ms: number) => Promise<void>;
}

const hex = (n: number) => `0x${n.toString(16).toUpperCase().padStart(4, '0')}`;

export function eneReadSetup(reg: number): ControlSetup {
  return { bmRequestType: ENE_BM_READ, bRequest: ENE_REQ_READ, wValue: (reg >>> 16) & 0xffff, wIndex: reg & 0xffff };
}

export function eneWriteSetup(reg: number): ControlSetup {
  return { bmRequestType: ENE_BM_WRITE, bRequest: ENE_REQ_WRITE, wValue: (reg >>> 16) & 0xffff, wIndex: reg & 0xffff };
}

export class EneTransport {
  readonly handle: UsbDeviceHandle;
  readonly #log: Logger;
  readonly #writeDelayMs: number;
  readonly #timeoutMs: number | undefined;
  readonly #sleep: (ms: number) => Promise<void>;
  /** LEDs in the device's frame buffer; 0 (no frame write accepted) until identification set it. */
  #frameBufferLeds = 0;
  #closed = false;

  constructor(handle: UsbDeviceHandle, options: EneTransportOptions) {
    this.handle = handle;
    this.#log = options.log;
    this.#writeDelayMs = options.writeDelayMs ?? ENE_WRITE_DELAY_MS;
    this.#timeoutMs = options.timeoutMs;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Read `length` bytes starting at `reg`. Like Ec_ReadRegs into a zeroed buffer, a short reply is
   * zero-padded (WinUSB reports success for short control reads and the C# code never checks).
   */
  async readRegs(reg: number, length: number): Promise<Uint8Array> {
    this.#checkAccess('read', reg, length);
    const setup = eneReadSetup(reg);
    const reply = await this.handle.controlIn(setup, length, this.#timeoutMs);
    if (reply.length === length) return reply;
    this.#log.debug(`ENE short read ${formatSetup(setup, length)}: ${reply.length}/${length} bytes, zero-padded`);
    const padded = new Uint8Array(length);
    padded.set(reply.subarray(0, length));
    return padded;
  }

  async readReg(reg: number): Promise<number> {
    return (await this.readRegs(reg, 1))[0];
  }

  /** Write `data` starting at `reg`, then pause (unless `paced` is false). */
  async writeRegs(reg: number, data: Uint8Array, paced = true): Promise<void> {
    this.#checkAccess('write', reg, data.length);
    await this.handle.controlOut(eneWriteSetup(reg), data, this.#timeoutMs);
    if (paced && this.#writeDelayMs > 0) await this.#sleep(this.#writeDelayMs);
  }

  /**
   * Open the frame-buffer write window for `leds` LEDs (groups 1..3 as identified, 09 §7.3):
   * writes must then fit in [0xE300, 0xE300 + 3·leds).
   */
  setFrameBufferLeds(leds: number): void {
    if (!Number.isInteger(leds) || leds < 0) throw new RangeError(`ENE frame buffer LED count ${leds} is invalid`);
    this.#frameBufferLeds = leds;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.handle.close();
  }

  #checkAccess(kind: 'read' | 'write', reg: number, length: number): void {
    if (this.#closed) throw new EneError('closed', `ENE ${kind} at ${hex(reg)} after close`);
    if (!Number.isInteger(length) || length < 1 || length > ENE_MAX_TRANSFER) {
      throw new RangeError(`ENE ${kind} length ${length} out of range 1..${ENE_MAX_TRANSFER}`);
    }
    const allowed = kind === 'read' ? isReadableRange(reg, length) : isWritableRange(reg, length, this.#frameBufferLeds);
    if (!allowed) throw new EneError('forbidden-register', `refusing ENE ${kind} of ${length} byte(s) at ${hex(reg)}: outside the documented register map`);
  }
}
