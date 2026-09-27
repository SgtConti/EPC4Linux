// USB-DDC through the VIA Labs I2C bridge in the monitor's USB hub (user's device 2109:8884).
// Vendor control transfers on EP0, device recipient, wValue 0 (08 §4.2-4.3, 06 §5.3):
//   write : 40 B2 0000 0000 N   data = 6E 51 (80|n) payload chk      (START addrW data STOP)
//   read  : C0 A3 0000 006F N   N bytes starting with the display's 0x6E
//   long  : C0 A7 0000 006F 20  (first 32 bytes, no STOP) + C0 A9 0000 0000 N-32 (NACK + STOP)
// This class is a plain byte pipe: retries ((n+1)*177 ms) and DDC delays live in channel.ts.

import type { ControlSetup, DdcTransport, UsbDeviceHandle, UsbDeviceInfo } from '../../types.ts';
import { DDC_READ_ADDR, toWireFrame } from '../codec.ts';
import { DdcError, errorText } from '../errors.ts';

export const VIA_VENDOR_ID = 0x2109;
/** The bridge function seen on the user's machine (08 §2.3); discovery probes other PIDs only when configured. */
export const VIA_DDC_BRIDGE_PID = 0x8884;

export const VIA_REQUEST = {
  /** imethod_11: complete I2C write (START + data + STOP). */
  write: 0xb2,
  /** imethod_12: complete I2C read; wIndex = 8-bit read address. */
  read: 0xa3,
  /** I2CReadCmd_Start: START + read, no STOP; wIndex = read address. */
  readStart: 0xa7,
  /** I2CReadCmd_DataNACK: final read chunk, NACK + STOP; wIndex = 0. */
  readEnd: 0xa9,
} as const;

const BM_OUT = 0x40; // host-to-device | vendor | device
const BM_IN = 0xc0; // device-to-host | vendor | device
/** One bridge transfer carries at most 32 bytes (the vendor buffers and imethod_4's limit). */
const CHUNK = 32;
/** Windows used the WinUSB default (no pipe policy); 1 s is ample for a 32-byte I2C transfer (08 §8.2). */
export const VIA_TIMEOUT_MS = 1000;

export class ViaUsbTransport implements DdcTransport {
  readonly kind = 'via-usb' as const;
  readonly id: string;
  readonly info: UsbDeviceInfo;
  readonly #handle: UsbDeviceHandle;
  readonly #timeoutMs: number;
  #closed = false;

  constructor(handle: UsbDeviceHandle, timeoutMs = VIA_TIMEOUT_MS) {
    this.#handle = handle;
    this.info = handle.info;
    this.id = `via:${handle.info.id}`;
    this.#timeoutMs = timeoutMs;
  }

  async write(message: Uint8Array): Promise<void> {
    this.#assertOpen();
    const data = toWireFrame(message);
    if (data.length > CHUNK) throw new DdcError('argument', `VIA write of ${data.length} bytes exceeds ${CHUNK}`, this.id);
    await this.#transfer(() => this.#handle.controlOut(setup(BM_OUT, VIA_REQUEST.write, 0), data, this.#timeoutMs));
  }

  async read(length: number): Promise<Uint8Array> {
    this.#assertOpen();
    if (!Number.isInteger(length) || length < 1 || length > 2 * CHUNK) {
      throw new DdcError('argument', `VIA read length ${length} out of range 1..${2 * CHUNK}`, this.id);
    }
    const out = new Uint8Array(length);
    if (length <= CHUNK) {
      out.set(await this.#in(VIA_REQUEST.read, DDC_READ_ADDR, length));
      return out;
    }
    // ReadA7A9 (Interface13.cs:425-438): first chunk with the read address, then the rest with wIndex 0.
    out.set(await this.#in(VIA_REQUEST.readStart, DDC_READ_ADDR, CHUNK));
    out.set(await this.#in(VIA_REQUEST.readEnd, 0, length - CHUNK), CHUNK);
    return out;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#handle.close();
  }

  async #in(request: number, wIndex: number, length: number): Promise<Uint8Array> {
    // A short transfer leaves the tail zero, like the vendor's zero-initialised buffer.
    const data = await this.#transfer(() => this.#handle.controlIn(setup(BM_IN, request, wIndex), length, this.#timeoutMs));
    return data.length > length ? data.subarray(0, length) : data;
  }

  async #transfer<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw new DdcError('io', `USB control transfer failed: ${errorText(e)}`, this.id, { cause: e });
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new DdcError('closed', 'transport closed', this.id);
  }
}

function setup(bmRequestType: number, bRequest: number, wIndex: number): ControlSetup {
  return { bmRequestType, bRequest, wValue: 0, wIndex };
}
