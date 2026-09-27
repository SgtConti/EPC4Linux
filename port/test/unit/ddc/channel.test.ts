import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DdcTransport, Logger } from '../../../src/backend/types.ts';
import { DdcChannelImpl, NO_DELAY_TIMINGS, VENDOR_TIMINGS } from '../../../src/backend/ddc/channel.ts';
import { DdcError } from '../../../src/backend/ddc/errors.ts';
import { readMonitorIdentity } from '../../../src/backend/ddc/identity.ts';
import { MOCK_34M2C8600, MOCK_SERIAL, type MockMonitorSpec } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { SimulatedMonitor } from '../../../src/backend/ddc/transports/mock.ts';
import { buildDdcMessage, getVcpPayload, setExtPayload, setVcpPayload } from '../../../src/backend/ddc/codec.ts';
import { ScriptedTransport, VirtualClock, bytes, hex } from './helpers.ts';

function withVcp(code: number, value: number, max: number): MockMonitorSpec {
  const vcp = MOCK_34M2C8600.vcp.filter(([c]) => c !== code);
  return { ...MOCK_34M2C8600, vcp: value < 0 ? vcp : [...vcp, [code, value, max]] };
}

function setup(kinds: Array<DdcTransport['kind']> = ['via-usb'], spec: MockMonitorSpec = MOCK_34M2C8600) {
  const monitor = new SimulatedMonitor(spec);
  const clock = new VirtualClock();
  const transports = kinds.map((k, i) => new ScriptedTransport(k, `${k}:${i}`, monitor));
  const ch = new DdcChannelImpl(transports, { clock, timings: VENDOR_TIMINGS });
  return { monitor, clock, transports, ch };
}

async function probed(kinds: Array<DdcTransport['kind']> = ['via-usb'], spec?: MockMonitorSpec) {
  const s = setup(kinds, spec);
  await s.ch.probe();
  s.clock.sleeps.length = 0;
  for (const t of s.transports) t.ops.length = 0;
  return s;
}

test('GetVCP over VIA: write, 100 ms, max(15, 100 - elapsed), read 32 bytes, 50 ms (08 §3.2)', async () => {
  const { ch, clock, transports } = await probed();
  assert.deepEqual(await ch.getVcp(0x10), { value: 0x64, max: 0x64, resultCode: 0 });
  assert.deepEqual(clock.sleeps, [100, 15, 50]);
  assert.deepEqual(transports[0].ops, ['w:51 82 01 10 AC', 'r:32']);
});

test('identity queries use sleepTime 150 (imethod_7) and sets are one write + 100 ms', async () => {
  const { ch, clock, transports } = await probed();
  await ch.rawQuery([0xfe, 0xe9, 0x0d, 0x00, 0x00], 32, ch.timings.querySleepMs);
  assert.deepEqual(clock.sleeps, [100, 50, 50]);
  clock.sleeps.length = 0;
  transports[0].ops.length = 0;
  await ch.setVcp(0x10, 0x32);
  assert.deepEqual(clock.sleeps, [100]);
  assert.deepEqual(transports[0].ops, ['w:51 84 03 10 00 32 9A']);
});

test('both paths read 32 bytes for every get (20 D3)', async () => {
  const { ch, transports } = await probed(['i2c-dev']);
  await ch.getExt(0x43);
  assert.deepEqual(transports[0].ops, ['w:51 84 01 E2 A0 43 BB', 'r:32']);
});

test('VIA transfer retries back off (n+1)*177 ms, the last failure included (Util.smethod_0)', async () => {
  const { ch, clock, transports } = await probed();
  transports[0].failWrites = 2;
  await ch.getVcp(0x12);
  assert.deepEqual(clock.sleeps, [177, 354, 100, 15, 50]);
  clock.sleeps.length = 0;
  transports[0].failWrites = 3; // the whole write primitive fails → next GetStandardData attempt
  await ch.getVcp(0x12);
  assert.deepEqual(clock.sleeps, [177, 354, 531, 100, 100, 15, 50]);
});

test('invalid replies (checksum, null message) are retried up to 3 attempts', async () => {
  const { ch, monitor, transports } = await probed();
  monitor.injectFault('bad-checksum');
  monitor.injectFault('null-reply');
  assert.equal((await ch.getVcp(0x10)).value, 0x64);
  assert.deepEqual(transports[0].ops.filter((o) => o.startsWith('w')).length, 3);
  monitor.injectFault('bad-checksum', 3);
  await assert.rejects(ch.getVcp(0x10), (e: unknown) => e instanceof DdcError && e.code === 'invalid-reply');
});

test('sticky transport: failover after the full budget, back to USB only after probe() (20 D1, §2.2)', async () => {
  const { ch, transports } = await probed(['via-usb', 'i2c-dev']);
  const frame = (payload: number[]) => `w:${hex(buildDdcMessage(payload))}`;
  transports[0].failWrites = 1000;
  assert.equal((await ch.getVcp(0x62)).max, 0x64);
  assert.equal(transports[0].ops.length, 9); // 3 attempts × 3 transfers, no reads
  assert.deepEqual(transports[1].ops, [frame(getVcpPayload(0x62)), 'r:32']);
  assert.equal(ch.activeTransport, transports[1]);
  transports[0].failWrites = 0;
  await ch.setVcp(0x62, 10); // sticky: stays on i2c-dev although USB would work again
  assert.equal(transports[0].ops.length, 9);
  assert.equal(transports[1].ops.at(-1), frame(setVcpPayload(0x62, 10)));
  await ch.probe(); // Device_DetectionDisplay / Device_DetectionUSB: re-evaluate
  assert.equal(ch.activeTransport, null);
  transports[0].ops.length = 0;
  await ch.getVcp(0x10);
  assert.deepEqual(transports[0].ops, [frame(getVcpPayload(0x10)), 'r:32']);
  assert.equal(ch.activeTransport, transports[0]);
});

test('set attempts: one write on the hub, three on the GPU path', async () => {
  const { ch, transports, monitor } = await probed(['via-usb', 'i2c-dev']);
  transports[0].failWrites = 3;
  transports[1].failWrites = 2;
  await ch.setExt(0x43, 0); // an absolute value: safe to run again on the other transport
  assert.equal(transports[0].ops.length, 3);
  assert.equal(transports[1].ops.length, 3);
  assert.equal(monitor.control(0xe2a043)?.value, 0);
  transports[1].failWrites = 3;
  transports[0].failWrites = 3;
  await assert.rejects(ch.setVcp(0x10, 1), (e: unknown) => e instanceof DdcError && e.code === 'io');
  assert.equal(transports[1].ops.length, 6); // i2c-dev (active) first, then one USB write primitive
  assert.equal(transports[0].ops.length, 6);
});

test('one-shot actions are never replayed on another transport (20 §2.2 rule 4)', async () => {
  const { ch, transports, monitor } = await probed(['via-usb', 'i2c-dev']);
  transports[0].failWrites = 3;
  await assert.rejects(ch.setVcp(0xf6, 1)); // PIP/PBP swap would toggle twice
  transports[0].failWrites = 3;
  await assert.rejects(ch.setExt(0x36, 1)); // OLED pixel refresh
  assert.deepEqual(transports[1].ops, []);
  transports[0].failWrites = 3;
  await ch.setVcp(0x10, 20); // absolute value: replayed on i2c-dev
  assert.equal(monitor.control(0x10)?.value, 20);
  assert.equal(transports[1].ops.length, 1);
});

test('a USB-topology write marks USB-DDC suspect until the next probe (20 §2.2 rule 5)', async () => {
  const { ch, transports } = await probed(['via-usb', 'i2c-dev']);
  await ch.setExt(0x15, 1); // KVM: the hub re-enumerates
  assert.equal(transports[0].ops.at(-1), `w:${hex(buildDdcMessage(setExtPayload(0x15, 1)))}`);
  assert.equal(ch.activeTransport, transports[1]);
  const usbOps = transports[0].ops.length;
  await ch.getVcp(0x10);
  assert.equal(transports[0].ops.length, usbOps);
  assert.equal(transports[1].ops.at(-1), 'r:32');
  await ch.probe(); // after the USBChange
  await ch.getVcp(0x10);
  assert.equal(ch.activeTransport, transports[0]);
  // Without an alternative the bridge is simply re-probed before its next use.
  const only = await probed(['via-usb']);
  await only.ch.setExt(0x12, 0);
  only.transports[0].ops.length = 0;
  await only.ch.getVcp(0x10);
  assert.deepEqual(only.transports[0].ops, ['w:51 82 01 14 A8', 'r:32', 'w:51 82 01 10 AC', 'r:32']);
});

test('USB-DDC probe: 0 < value < 255 && max < 255 (08 §3.6), done once per transport', async () => {
  for (const [value, max, ok] of [[5, 13, true], [0, 13, false], [255, 255, false], [5, 255, false]] as const) {
    const { ch, transports } = setup(['via-usb', 'i2c-dev'], withVcp(0x14, value, max));
    await ch.getVcp(0x10);
    const viaUsed = transports[0].ops.includes('w:51 82 01 10 AC');
    assert.equal(viaUsed, ok, `value ${value} max ${max}`);
  }
  const { ch, transports } = setup();
  await ch.getVcp(0x10);
  await ch.getVcp(0x12);
  assert.equal(transports[0].ops.filter((o) => o === 'w:51 82 01 14 A8').length, 1);
  // A second channel over the same transport reuses the probe result.
  const again = new DdcChannelImpl(transports, { timings: NO_DELAY_TIMINGS });
  await again.getVcp(0x10);
  assert.equal(transports[0].ops.filter((o) => o === 'w:51 82 01 14 A8').length, 1);
});

test('DDC/CI probe on i2c: result code 0, one retry after 200 ms (JudgeSupportDDCCI)', async () => {
  const { ch, clock } = setup(['i2c-dev'], withVcp(0x14, -1, 0));
  const probes = await ch.probe();
  assert.deepEqual(probes[0], { transportId: 'i2c-dev:0', kind: 'i2c-dev', supported: false, value: 0, max: 0, resultCode: 1 });
  assert.ok(clock.sleeps.includes(200));
  await assert.rejects(ch.getVcp(0x10), (e: unknown) => e instanceof DdcError && e.code === 'no-transport');
});

test('one queue per monitor: concurrent operations never interleave on the bus', async () => {
  const { transports } = await probed(['via-usb']);
  const a = new DdcChannelImpl(transports, { timings: NO_DELAY_TIMINGS });
  const b = new DdcChannelImpl(transports, { timings: NO_DELAY_TIMINGS });
  const [x, y] = await Promise.all([a.getVcp(0x10), b.getVcp(0x12)]);
  assert.equal(x.value, 0x64);
  assert.equal(y.value, 0x32);
  assert.deepEqual(transports[0].ops, ['w:51 82 01 10 AC', 'r:32', 'w:51 82 01 12 AE', 'r:32']);
});

test('extended codes: EQ band selector and gain (06 §5.7 load loop)', async () => {
  const { ch } = await probed(['mock']);
  for (let band = 0; band < 5; band++) {
    await ch.setExt(0x01, band);
    assert.deepEqual(await ch.getExt(0x39), { value: 8, max: 16, resultCode: 0 });
  }
  await ch.setExt(0x01, 2);
  await ch.setExt(0x39, 12);
  assert.equal((await ch.getExt(0x39)).value, 12);
  await ch.setExt(0x01, 0);
  assert.equal((await ch.getExt(0x39)).value, 8);
});

test('capabilities: 64-byte A7+A9 read without the 50 ms delay on VIA; 38 bytes and a retry after 2000 ms on i2c', async () => {
  const { ch, transports, clock } = await probed(['via-usb']);
  assert.equal(await ch.capabilities(), MOCK_34M2C8600.capabilities);
  const requests = transports[0].ops.filter((o) => o.startsWith('w:51 83 F3'));
  assert.equal(requests.length, Math.ceil(MOCK_34M2C8600.capabilities.length / 32)); // stops when the group closes
  assert.ok(transports[0].ops.every((o) => !o.startsWith('r:') || o === 'r:64'));
  assert.deepEqual(clock.sleeps.slice(0, 4), [100, 15, 100, 15]); // Interface13.method_0: no post-read sleep

  const gpu = await probed(['i2c-dev']);
  assert.equal(await gpu.ch.capabilities(), MOCK_34M2C8600.capabilities);
  assert.deepEqual(gpu.clock.sleeps.slice(0, 3), [100, 15, 50]);
  assert.ok(gpu.transports[0].ops.includes('r:38'));
  gpu.transports[0].failReads = 1000;
  gpu.clock.sleeps.length = 0;
  await assert.rejects(gpu.ch.capabilities());
  assert.ok(gpu.clock.sleeps.includes(2000));
});

test('identity over any channel (Interface8 GetMonitorInfo + GetSN)', async () => {
  const { ch } = await probed(['mock']);
  const id = await readMonitorIdentity(ch);
  assert.deepEqual(id, {
    errors: {},
    scalerIc: 0x09,
    scalerType: 'RTK',
    modelName: '34M2C8600',
    bomString: '100GPRS2003NA1SXXY',
    version: 'V1.01',
    dualImageBank: 0x40,
    scalerName: 'RTD2738VL',
    serialNumber: MOCK_SERIAL, // the simulated monitor's synthetic serial
  });
});

test('echo mismatch is logged, not rejected (vendor parity); bad arguments reject before I/O', async () => {
  const warnings: string[] = [];
  const log: Logger = { debug() {}, info() {}, warn: (m: unknown) => warnings.push(String(m)), error() {}, child: () => log };
  const fixed: DdcTransport = {
    kind: 'mock',
    id: 'fixed',
    async write() {},
    async read() {
      return bytes('6E 88 02 00 12 00 00 64 00 32 F0');
    },
    async close() {},
  };
  const ch = new DdcChannelImpl([fixed], { log, timings: NO_DELAY_TIMINGS });
  const v = await ch.getVcp(0x10);
  assert.equal(v.value, 0x32);
  assert.ok(warnings.some((w) => w.includes('echoes 0x12 for request 0x10')));
  await assert.rejects(ch.getVcp(0x100), (e: unknown) => e instanceof DdcError && e.code === 'argument');
  await assert.rejects(ch.setVcp(0x10, 70000), (e: unknown) => e instanceof DdcError && e.code === 'argument');
});

test('close() closes the transports; later operations reject', async () => {
  const { ch, transports } = await probed(['via-usb', 'i2c-dev']);
  await ch.close();
  assert.equal(transports.every((t) => t.closed), true);
  await assert.rejects(ch.getVcp(0x10), (e: unknown) => e instanceof DdcError && e.code === 'closed');
});
