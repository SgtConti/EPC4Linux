import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DdcChannelImpl, NO_DELAY_TIMINGS } from '../../../src/backend/ddc/channel.ts';
import { buildDdcMessage, getVcpPayload } from '../../../src/backend/ddc/codec.ts';
import { DdcError } from '../../../src/backend/ddc/errors.ts';
import { sameEdidBase } from '../../../src/backend/ddc/edid.ts';
import {
  I2C_SLAVE,
  I2C_SLAVE_FORCE,
  I2cDevTransport,
  createLinuxI2cSyscalls,
  readEdidOverI2c,
  type I2cSyscalls,
} from '../../../src/backend/ddc/transports/i2cdev.ts';
import { SimulatedMonitor, createMockI2cSyscalls } from '../../../src/backend/ddc/transports/mock.ts';
import { hex, realEdid } from './helpers.ts';
import { USER_34M2C8600 } from '../../fixtures/user-monitor.ts';

/** Records every syscall; reads are answered by `answer`. */
function recorder(answer: (length: number) => Uint8Array = (n) => new Uint8Array(n)) {
  const calls: string[] = [];
  let openFailures = 0;
  const sys: I2cSyscalls & { failOpen(n: number): void } = {
    failOpen(n) {
      openFailures = n;
    },
    async open(path) {
      calls.push(`open ${path}`);
      if (openFailures > 0) {
        openFailures--;
        throw new Error(`open ${path}: EACCES`);
      }
      return 7;
    },
    async setSlave(fd, address) {
      calls.push(`ioctl ${fd} I2C_SLAVE 0x${address.toString(16)}`);
    },
    async write(fd, data) {
      calls.push(`write ${fd} ${hex(data)}`);
      return data.length;
    },
    async read(fd, length) {
      calls.push(`read ${fd} ${length}`);
      return answer(length);
    },
    async close(fd) {
      calls.push(`close ${fd}`);
    },
  };
  return { sys, calls };
}

test('opens lazily, sets slave 0x37, writes the frame without the address byte, reads exact lengths', async () => {
  const { sys, calls } = recorder();
  const t = new I2cDevTransport('/dev/i2c-5', sys);
  assert.equal(t.id, 'i2c:/dev/i2c-5');
  assert.deepEqual(calls, []); // constructing never touches the device
  await t.write(buildDdcMessage(getVcpPayload(0x10)));
  await t.read(11);
  await t.close();
  assert.deepEqual(calls, ['open /dev/i2c-5', 'ioctl 7 I2C_SLAVE 0x37', 'write 7 51 82 01 10 AC', 'read 7 11', 'close 7']);
});

test('a failed open is retried on the next operation; short transfers are errors', async () => {
  const { sys, calls } = recorder((n) => new Uint8Array(n - 1));
  sys.failOpen(1);
  const t = new I2cDevTransport('/dev/i2c-9', sys);
  await assert.rejects(t.read(11), (e: unknown) => e instanceof DdcError && e.code === 'io' && /EACCES/.test(e.message));
  await assert.rejects(t.read(11), /short read \(10\/11\)/);
  assert.equal(calls.filter((c) => c.startsWith('open')).length, 2);
  await t.close();
  await assert.rejects(t.write(Uint8Array.of(1)), (e: unknown) => e instanceof DdcError && e.code === 'closed');
});

/** Syscalls where a kernel driver (ddcci) has claimed `claimed`: I2C_SLAVE fails with EBUSY there. */
function claimedBus(inner: I2cSyscalls, calls: string[], claimed: number, forceFails = false): I2cSyscalls {
  const busy = (what: string) => Object.assign(new Error(`${what}: EBUSY`), { code: 'EBUSY' });
  return {
    ...inner,
    async setSlave(fd, address, force = false) {
      calls.push(`ioctl ${force ? 'I2C_SLAVE_FORCE' : 'I2C_SLAVE'} 0x${address.toString(16)}`);
      if (address === claimed && (!force || forceFails)) throw busy(force ? 'ioctl(I2C_SLAVE_FORCE)' : 'ioctl(I2C_SLAVE)');
      return inner.setSlave(fd, address, force);
    },
  };
}

test('EBUSY on 0x37 (ddcci driver bound): retried with I2C_SLAVE_FORCE and a warning, like ddcutil', async () => {
  const monitor = new SimulatedMonitor();
  const calls: string[] = [];
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn: (m: unknown) => warnings.push(String(m)), error() {}, child: () => log };
  const sys = claimedBus(createMockI2cSyscalls({ '/dev/i2c-5': monitor }), calls, 0x37);
  const ch = new DdcChannelImpl([new I2cDevTransport('/dev/i2c-5', sys, { log })], { timings: NO_DELAY_TIMINGS, processLock: null });
  assert.deepEqual(await ch.getVcp(0x10), { value: 0x64, max: 0x64, resultCode: 0 });
  assert.deepEqual(calls, ['ioctl I2C_SLAVE 0x37', 'ioctl I2C_SLAVE_FORCE 0x37']);
  assert.ok(warnings.some((w) => /claimed by a kernel driver.*I2C_SLAVE_FORCE/.test(w)));
  await ch.close();

  // If even the forced ioctl fails, the error names the likely cause and the remedy.
  const stuck = new I2cDevTransport('/dev/i2c-5', claimedBus(createMockI2cSyscalls({ '/dev/i2c-5': monitor }), [], 0x37, true));
  await assert.rejects(stuck.read(32), (e: unknown) => e instanceof DdcError && /EBUSY.*ddcci/.test(e.message));
  // Other addresses are never forced: the EDID EEPROM keeps its driver.
  const edidCalls: string[] = [];
  await assert.rejects(readEdidOverI2c('/dev/i2c-5', claimedBus(createMockI2cSyscalls({ '/dev/i2c-5': monitor }), edidCalls, 0x50)), /EBUSY.*claimed slave 0x50/);
  assert.deepEqual(edidCalls, ['ioctl I2C_SLAVE 0x50']);
});

test('full channel over i2c-dev against the simulator', async () => {
  const monitor = new SimulatedMonitor();
  const sys = createMockI2cSyscalls({ '/dev/i2c-5': monitor });
  const ch = new DdcChannelImpl([new I2cDevTransport('/dev/i2c-5', sys)], { timings: NO_DELAY_TIMINGS });
  assert.deepEqual(await ch.getVcp(0x14), { value: 5, max: 13, resultCode: 0 });
  await ch.setExt(0x19, 3);
  assert.equal((await ch.getExt(0x19)).value, 3);
  assert.equal(await ch.capabilities(), monitor.spec.capabilities);
  await ch.close();
  const missing = new DdcChannelImpl([new I2cDevTransport('/dev/i2c-6', sys)], { timings: NO_DELAY_TIMINGS });
  await assert.rejects(missing.getVcp(0x10), (e: unknown) => e instanceof DdcError && e.code === 'no-transport');
});

test('ReadEDID256_Direc sequence on slave 0x50 (07 §4.8.6)', async () => {
  const monitor = new SimulatedMonitor(USER_34M2C8600); // the user's EDID, compared with the logged dump
  const { sys, calls } = recorder((n) => monitor.readEdid(calls.filter((c) => c.startsWith('read')).length === 1 ? 0 : 128, n));
  const edid = await readEdidOverI2c('/dev/i2c-5', sys);
  assert.deepEqual(calls, ['open /dev/i2c-5', 'ioctl 7 I2C_SLAVE 0x50', 'write 7 00', 'read 7 128', 'write 7 80', 'read 7 128', 'close 7']);
  assert.equal(sameEdidBase(edid, realEdid()), true);
  const junk = recorder((n) => new Uint8Array(n).fill(0xff));
  await assert.rejects(readEdidOverI2c('/dev/i2c-5', junk.sys), /no EDID/);
  assert.equal(junk.calls.at(-1), 'close 7');
});

test('real syscall binding (node:fs + koffi ioctl) on a regular file, never /dev', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'i2cdev-'));
  try {
    const path = join(dir, 'fake-bus');
    await writeFile(path, Uint8Array.of(0x6e, 0x80, 0xbe));
    const sys = createLinuxI2cSyscalls();
    const fd = await sys.open(path);
    assert.equal(hex(await sys.read(fd, 3)), '6E 80 BE');
    assert.equal(await sys.write(fd, Uint8Array.of(0x51, 0x82)), 2); // appended at the file position
    // ioctl(I2C_SLAVE) on a regular file: koffi loads libc and the kernel answers ENOTTY.
    await assert.rejects(sys.setSlave(fd, 0x37), (e: NodeJS.ErrnoException) => /ioctl\(I2C_SLAVE, 0x37\): ENOTTY/.test(e.message) && e.code === 'ENOTTY');
    await assert.rejects(sys.setSlave(fd, 0x37, true), /ioctl\(I2C_SLAVE_FORCE, 0x37\): ENOTTY/);
    await sys.close(fd);
    assert.equal(hex(await readFile(path)), '6E 80 BE 51 82');
    await assert.rejects(sys.open(join(dir, 'i2c-99')), /ENOENT.*i2c-dev module/);
    assert.equal(I2C_SLAVE, 0x0703);
    assert.equal(I2C_SLAVE_FORCE, 0x0706);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
