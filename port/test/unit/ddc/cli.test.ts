import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, parseCode, parseProductId, parseValue } from '../../../src/backend/cli.ts';
import { MOCK_SERIAL } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, { out: (t) => void (out += t), err: (t) => void (err += t) });
  return { code, out, err };
}

test('code and value parsing', () => {
  assert.equal(parseCode('10'), 0x10);
  assert.equal(parseCode('0xDC'), 0xdc);
  assert.equal(parseCode('e2a019'), 0xe2a019);
  assert.equal(parseCode('0xE2A0FF'), 0xe2a0ff);
  assert.throws(() => parseCode('e2b019'), /invalid VCP code/);
  assert.throws(() => parseCode('100'), /invalid VCP code/);
  assert.equal(parseValue('50'), 50);
  assert.equal(parseValue('0x3616'), 0x3616);
  assert.throws(() => parseValue('70000'), /invalid value/);
  assert.throws(() => parseValue('-1'), /invalid value/);
  assert.equal(parseProductId('8884'), 0x8884);
  assert.equal(parseProductId('0x0100'), 0x0100);
  assert.throws(() => parseProductId('18884'), /invalid USB product id/);
});

test('list --mock --json runs discovery and probes every transport', async () => {
  const r = await run('list', '--mock', '--json');
  assert.equal(r.code, 0, r.err);
  const rows = JSON.parse(r.out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, MOCK_SERIAL);
  assert.equal(rows[0].pnpId, 'PHLC29F');
  assert.equal(rows[0].edidInfo.TimingRecommandation, '3440x1440');
  assert.deepEqual(rows[0].transports.map((p: { transportId: string; supported: boolean }) => [p.transportId, p.supported]), [
    ['via:usb:3-2.4', true],
    ['i2c:/dev/i2c-5', true],
  ]);
});

test('get / caps / identity against the simulated monitor, per transport', async () => {
  const get = await run('get', 'e2a01a', '--mock', '--json', '--transport', 'i2c');
  assert.equal(get.code, 0, get.err);
  assert.deepEqual(JSON.parse(get.out), { code: 'e2a01a', value: 6, max: 13, resultCode: 0 });
  const caps = await run('caps', '--mock', '--transport', 'via');
  assert.equal(caps.code, 0, caps.err);
  assert.match(caps.out, /model 34M2C8600MV, MCCS 2\.2, cmds 01 02 03 07 0C E3 F3, 85 VCP codes/);
  const id = await run('identity', '--mock', '--json');
  assert.equal(JSON.parse(id.out).serialNumber, MOCK_SERIAL);
});

test('read-only by default: set needs --yes; usage errors exit 2 before touching hardware', async () => {
  const refused = await run('set', '10', '50', '--mock');
  assert.equal(refused.code, 2);
  assert.match(refused.err, /refusing to write 0x10 = 50 without --yes/);
  const done = await run('set', 'e2a043', '0', '--mock', '--yes');
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /e2a043 <- 0/);
  assert.equal((await run('get', 'zz', '--mock')).code, 2);
  assert.equal((await run('frobnicate', '--mock')).code, 2);
  assert.equal((await run('get', '10', '--mock', '--transport', 'hid')).code, 2);
  assert.equal((await run('get', '10', '--mock', '--monitor', 'nope')).code, 2);
  assert.equal((await run()).code, 2);
});
