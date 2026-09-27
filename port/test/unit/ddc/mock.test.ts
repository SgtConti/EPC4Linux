import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DdcChannelImpl, NO_DELAY_TIMINGS } from '../../../src/backend/ddc/channel.ts';
import { buildDdcMessage, getVcpPayload, parseVcpReply, setVcpPayload, toWireFrame } from '../../../src/backend/ddc/codec.ts';
import { MOCK_34M2C8600, MOCK_SERIAL } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { USER_34M2C8600, USER_MONITOR_SERIAL } from '../../fixtures/user-monitor.ts';
import { MockDdcTransport, SimulatedMonitor, createMock34M2C8600 } from '../../../src/backend/ddc/transports/mock.ts';
import { hex } from './helpers.ts';

function channel(monitor = new SimulatedMonitor()) {
  return { monitor, ch: new DdcChannelImpl([new MockDdcTransport(monitor)], { timings: NO_DELAY_TIMINGS }) };
}

test('seeded with the values read on the user\'s machine (03 §6.3, 06 §5.7)', async () => {
  const { ch } = channel();
  const expect: Array<[number, number, number]> = [
    [0xdc, 0x21, 0x35], [0x10, 0x64, 0x64], [0x12, 0x32, 0x64], [0x60, 0x0f, 0x3616], [0xa5, 0x00, 0x200],
    [0x62, 0x00, 0x64], [0x8d, 0x02, 0x02], [0xe0, 0x03, 0x08], [0x86, 0x02, 0x23], [0x54, 0x02, 0x04],
    [0xda, 0x02, 0x08], [0xf2, 0x01, 0x04], [0xcc, 0x02, 0x24], [0xe9, 0x00, 0x02], [0xed, 0x01, 0x01],
  ];
  for (const [code, value, max] of expect) assert.deepEqual(await ch.getVcp(code), { value, max, resultCode: 0 }, `VCP 0x${code.toString(16)}`);
  const ext: Array<[number, number, number]> = [
    [0x40, 1, 1], [0x04, 0, 2], [0x44, 0, 3], [0x06, 0, 3], [0x09, 1, 7], [0x0a, 0x64, 0x64], [0x0c, 0, 5], [0x0d, 0, 0],
    [0x19, 0, 7], [0x1a, 6, 0x0d], [0x1c, 2, 2], [0x00, 0x46, 0x4b], [0x0e, 0x32, 0x64], [0x11, 2, 4], [0x12, 1, 1],
    [0x15, 0, 2], [0x35, 2, 3], [0x34, 3, 4], [0x43, 1, 1], [0x41, 1, 2],
  ];
  for (const [sub, value, max] of ext) assert.deepEqual(await ch.getExt(sub), { value, max, resultCode: 0 }, `E2A0${sub.toString(16)}`);
});

test('every code in the capability string answers; unsupported codes answer RC=1', async () => {
  const { ch } = channel();
  for (const [code] of MOCK_34M2C8600.vcp) {
    const v = code >= 0xe2a000 ? await ch.getExt(code & 0xff) : await ch.getVcp(code);
    assert.equal(v.resultCode, 0);
  }
  assert.deepEqual(await ch.getVcp(0x8a), { value: 0, max: 0, resultCode: 1 }); // saturation: not in caps
  assert.equal((await ch.getExt(0x3d)).resultCode, 1); // HDR light enhancement: err_code 9 in the profile
});

test('SmartImage modes keep their own picture settings; E2A042 resets the current mode', async () => {
  const { ch } = channel();
  await ch.setVcp(0x10, 40);
  await ch.setVcp(0xdc, 0x00); // HDR Game → Standard
  assert.equal((await ch.getVcp(0x10)).value, 0x64);
  await ch.setVcp(0x10, 70);
  await ch.setVcp(0xdc, 0x21);
  assert.equal((await ch.getVcp(0x10)).value, 40);
  await ch.setVcp(0xdc, 0x00);
  assert.equal((await ch.getVcp(0x10)).value, 70);
  await ch.setExt(0x42, 0x30);
  assert.equal((await ch.getVcp(0x10)).value, 0x64);
});

test('continuous controls clamp, triggers act, factory reset restores the seeds', async () => {
  const { ch, monitor } = channel();
  await ch.setVcp(0x10, 500);
  assert.equal((await ch.getVcp(0x10)).value, 0x64);
  await ch.setExt(0x19, 5);
  await ch.setExt(0x1a, 9);
  await ch.setExt(0x38, 1); // Ambiglow reset (Effect_Reset without ENE)
  assert.equal((await ch.getExt(0x19)).value, 0);
  assert.equal((await ch.getExt(0x1a)).value, 6);
  await ch.setVcp(0x62, 30);
  await ch.setVcp(0x04, 1);
  assert.equal((await ch.getVcp(0x62)).value, 0);
  await ch.setVcp(0x8a, 10); // unsupported: ignored
  assert.equal(monitor.control(0x8a), undefined);
});

test('frames with a bad checksum or unknown opcodes get a null message; both SN request forms work', () => {
  const monitor = new SimulatedMonitor();
  const bad = buildDdcMessage(getVcpPayload(0x10));
  bad[bad.length - 1] ^= 1;
  monitor.receive(bad);
  assert.equal(hex(monitor.reply(3)), '6E 80 BE');
  monitor.receive(buildDdcMessage([0x07]));
  assert.equal(hex(monitor.reply(3)), '6E 80 BE');
  monitor.receive(buildDdcMessage(getVcpPayload(0x10)));
  assert.equal(parseVcpReply(monitor.reply(32)).value, 0x64);
  for (const sn of [[0x01, 0xfe, 0xef, 0x13, 0x00, 0x20], [0x01, 0xfe, 0xef, 0x13, 0x00, 0x00, 0x20]]) {
    monitor.receive(buildDdcMessage(sn));
    assert.equal(Buffer.from(monitor.reply(16).subarray(2, 15)).toString('latin1'), MOCK_SERIAL);
  }
  monitor.receive(buildDdcMessage([0x01, 0xfe, 0xe1, 0xa7, 0x07, 0x00])); // panel name: never captured
  assert.equal(hex(monitor.reply(3)), '6E 80 BE');
  assert.equal(monitor.frames.length, 6);
});

test('fault injection reaches the transport layer', async () => {
  const monitor = new SimulatedMonitor();
  monitor.injectFault('nack-write');
  assert.throws(() => monitor.receive(buildDdcMessage(getVcpPayload(0x10))), /NACK/);
  monitor.injectFault('nack-read');
  assert.throws(() => monitor.reply(8), /NACK/);
});

test('createMock34M2C8600: VIA first, i2c-dev second, keyed by the EDID serial', async () => {
  const bundle = await createMock34M2C8600();
  assert.equal(bundle.discovered.key, MOCK_SERIAL);
  // A seed with another identity (tests replaying the user's session inject the real one).
  const user = await createMock34M2C8600({ spec: USER_34M2C8600, transports: [] });
  assert.equal(user.discovered.key, USER_MONITOR_SERIAL);
  assert.equal(user.monitor.spec, USER_34M2C8600);
  assert.equal(bundle.discovered.connector, 'card1-DP-1');
  assert.deepEqual(bundle.discovered.transports.map((t) => t.id), ['via:usb:3-2.4', 'i2c:/dev/i2c-5']);
  assert.equal(bundle.viaInfo.id, 'usb:3-2.4');
  const ch = new DdcChannelImpl(bundle.discovered.transports, { timings: NO_DELAY_TIMINGS });
  await ch.setVcp(0x12, 0x40);
  assert.equal(bundle.monitor.control(0x12)?.value, 0x40);
  const frame = hex(toWireFrame(buildDdcMessage(setVcpPayload(0x12, 0x40))));
  assert.ok(bundle.usb.transfers.some((t) => t.direction === 'out' && hex(t.data) === frame));
  await ch.close();
  const onlyI2c = await createMock34M2C8600({ transports: ['i2c'] });
  assert.deepEqual(onlyI2c.discovered.transports.map((t) => t.kind), ['i2c-dev']);
});
