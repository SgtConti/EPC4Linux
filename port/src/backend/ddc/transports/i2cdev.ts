// DDC/CI over a GPU I2C bus exposed by the Linux i2c-dev driver (/dev/i2c-N), replacing DDCHelperLib
// and its ADL/NVAPI/IGCL backends (07 §8.1-8.3). Same frames as every other transport; the kernel adds
// the address byte (0x6E / 0x6F) from ioctl(I2C_SLAVE, 0x37). Plain write()/read() are two separate
// transactions with a STOP in between, as DDC/CI requires (never a combined I2C_RDWR).
//
// System calls go through the injectable `I2cSyscalls` so tests never touch /dev. The real
// implementation uses Node's fs (async on the libuv pool, errno codes preserved) for
// open/read/write/close and koffi only for the ioctl, which does no bus traffic.

import { close, open, read, write } from 'node:fs';
import type { DdcTransport, Logger } from '../../types.ts';
import { DDC_CI_SLAVE, EDID_SLAVE } from '../codec.ts';
import { fixEdidHeader, EDID_BLOCK } from '../edid.ts';
import { DdcError, errorText } from '../errors.ts';
import { errnoError, loadLibc } from '../libc.ts';

/** linux/i2c-dev.h: use this 7-bit slave address for subsequent read()/write(). */
export const I2C_SLAVE = 0x0703;
/** linux/i2c-dev.h: the same, even if a kernel driver has claimed the address. */
export const I2C_SLAVE_FORCE = 0x0706;

export interface I2cSyscalls {
  open(path: string): Promise<number>;
  /**
   * ioctl(fd, force ? I2C_SLAVE_FORCE : I2C_SLAVE, address). Failures carry the errno name in `code`
   * (EBUSY: a kernel driver owns the address).
   */
  setSlave(fd: number, address: number, force?: boolean): Promise<void>;
  /** One read(2); resolves with the bytes actually read. */
  read(fd: number, length: number): Promise<Uint8Array>;
  /** One write(2); resolves with the number of bytes written. */
  write(fd: number, data: Uint8Array): Promise<number>;
  close(fd: number): Promise<void>;
}

/** Remedy appended to i2c-dev errors, by errno name. */
function hint(code: string | undefined, path: string, slave?: number): string {
  if (code === 'ENOENT') return ` (${path} missing: is the i2c-dev module loaded?)`;
  if (code === 'EACCES' || code === 'EPERM') return ` (no permission on ${path}: udev uaccess rule / i2c group)`;
  if (code === 'EBUSY' && slave !== undefined) {
    return ` (a kernel driver has claimed slave 0x${slave.toString(16)} on ${path}` +
      (slave === DDC_CI_SLAVE ? '; usually ddcci-driver-linux: `sudo modprobe -r ddcci_backlight ddcci`, or use USB-DDC)' : ')');
  }
  return '';
}

/** Production syscalls: node:fs + koffi ioctl. */
export function createLinuxI2cSyscalls(): I2cSyscalls {
  return {
    open: (path) =>
      new Promise((resolve, reject) =>
        open(path, 'r+', (err, fd) => (err ? reject(Object.assign(new Error(`open ${path}: ${err.code ?? err.message}${hint(err.code, path)}`), { code: err.code })) : resolve(fd))),
      ),
    async setSlave(fd, address, force = false) {
      const libc = await loadLibc();
      const { result, errno } = libc.ioctl(fd, force ? I2C_SLAVE_FORCE : I2C_SLAVE, address);
      if (result < 0) throw errnoError(`ioctl(${force ? 'I2C_SLAVE_FORCE' : 'I2C_SLAVE'}, 0x${address.toString(16)})`, errno);
    },
    read: (fd, length) =>
      new Promise((resolve, reject) => {
        const buf = Buffer.alloc(length);
        read(fd, buf, 0, length, null, (err, n) => (err ? reject(new Error(`read: ${err.code ?? err.message}`)) : resolve(new Uint8Array(buf.subarray(0, n)))));
      }),
    write: (fd, data) =>
      new Promise((resolve, reject) =>
        write(fd, data, 0, data.length, null, (err, n) => (err ? reject(new Error(`write: ${err.code ?? err.message}`)) : resolve(n))),
      ),
    close: (fd) => new Promise((resolve, reject) => close(fd, (err) => (err ? reject(err) : resolve()))),
  };
}

let defaultSyscalls: I2cSyscalls | null = null;
export function linuxI2cSyscalls(): I2cSyscalls {
  defaultSyscalls ??= createLinuxI2cSyscalls();
  return defaultSyscalls;
}

export interface I2cDevTransportOptions {
  /** 7-bit slave address (default 0x37, DDC/CI). */
  slave?: number;
  /** Receives the warning when the DDC/CI address has to be forced. */
  log?: Logger;
}

/** Transport id (and lock key, locks.ts) of a bus: "i2c:/dev/i2c-5", whichever slave is addressed. */
export function i2cTransportId(path: string): string {
  return `i2c:${path}`;
}

/** Byte pipe to one slave on one bus. The device node is opened lazily on first use. */
export class I2cDevTransport implements DdcTransport {
  readonly kind = 'i2c-dev' as const;
  readonly id: string;
  readonly path: string;
  readonly #sys: I2cSyscalls;
  readonly #slave: number;
  readonly #log: Logger | undefined;
  #fd: Promise<number> | null = null;
  #closed = false;

  constructor(path: string, sys: I2cSyscalls = linuxI2cSyscalls(), options: I2cDevTransportOptions = {}) {
    this.path = path;
    this.#sys = sys;
    this.#slave = options.slave ?? DDC_CI_SLAVE;
    this.#log = options.log;
    this.id = i2cTransportId(path);
  }

  async write(message: Uint8Array): Promise<void> {
    const fd = await this.#open();
    const n = await this.#io('write', () => this.#sys.write(fd, message));
    if (n !== message.length) throw new DdcError('io', `short write (${n}/${message.length})`, this.id);
  }

  async read(length: number): Promise<Uint8Array> {
    const fd = await this.#open();
    const data = await this.#io('read', () => this.#sys.read(fd, length));
    if (data.length !== length) throw new DdcError('io', `short read (${data.length}/${length})`, this.id);
    return data;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#fd;
    this.#fd = null;
    if (pending) {
      const fd = await pending.catch(() => -1);
      if (fd >= 0) await this.#sys.close(fd);
    }
  }

  #open(): Promise<number> {
    if (this.#closed) return Promise.reject(new DdcError('closed', 'transport closed', this.id));
    if (!this.#fd) {
      const opening = (async () => {
        const fd = await this.#io('open', () => this.#sys.open(this.path));
        try {
          await this.#io('ioctl', () => this.#setSlave(fd));
        } catch (e) {
          await this.#sys.close(fd).catch(() => undefined);
          throw e;
        }
        return fd;
      })();
      // A failed open is retried on the next operation (e.g. after the user fixed permissions).
      opening.catch(() => {
        if (this.#fd === opening) this.#fd = null;
      });
      this.#fd = opening;
    }
    return this.#fd;
  }

  /**
   * I2C_SLAVE fails with EBUSY when a kernel driver has instantiated a client at the address; for
   * 0x37 that is the out-of-tree ddcci driver (ddcci-backlight). Like ddcutil, retry with
   * I2C_SLAVE_FORCE: that driver only talks to the monitor when its sysfs/backlight files are used.
   * Other addresses (the EDID EEPROM at 0x50) are never forced.
   */
  async #setSlave(fd: number): Promise<void> {
    try {
      await this.#sys.setSlave(fd, this.#slave);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' || this.#slave !== DDC_CI_SLAVE) throw withHint(e, code, this.path, this.#slave);
      this.#log?.warn(
        `${this.path}: slave 0x37 is claimed by a kernel driver (usually ddcci); using I2C_SLAVE_FORCE like ddcutil. ` +
          "That driver's own DDC/CI traffic (brightness via its backlight device) is not serialized with ours.",
      );
      try {
        await this.#sys.setSlave(fd, this.#slave, true);
      } catch (forced) {
        throw withHint(forced, (forced as NodeJS.ErrnoException).code, this.path, this.#slave);
      }
    }
  }

  async #io<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw e instanceof DdcError ? e : new DdcError('io', `${what} failed: ${errorText(e)}`, this.id, { cause: e });
    }
  }
}

function withHint(e: unknown, code: string | undefined, path: string, slave: number): Error {
  const extra = hint(code, path, slave);
  return extra ? new Error(`${errorText(e)}${extra}`, { cause: e }) : e instanceof Error ? e : new Error(String(e));
}

/**
 * ReadEDID256_Direc (07 §4.8.6): slave 0x50, write 00 / read 128, write 80 / read 128, no delays and
 * no segment pointer, then EDIDJudgeAndFix. Used only for buses without a DRM connector link;
 * connectors with a link use the kernel's sysfs EDID instead. The caller serializes it with the DDC/CI
 * traffic on the same bus (discovery.ts holds the bus's path lock).
 */
export async function readEdidOverI2c(path: string, sys: I2cSyscalls = linuxI2cSyscalls()): Promise<Uint8Array> {
  const t = new I2cDevTransport(path, sys, { slave: EDID_SLAVE });
  try {
    const out = new Uint8Array(2 * EDID_BLOCK);
    for (const offset of [0x00, 0x80]) {
      await t.write(Uint8Array.of(offset));
      out.set(await t.read(EDID_BLOCK), offset);
    }
    const fixed = fixEdidHeader(out);
    if (!fixed) throw new DdcError('invalid-reply', 'no EDID at 0x50', t.id);
    return fixed;
  } finally {
    await t.close();
  }
}
