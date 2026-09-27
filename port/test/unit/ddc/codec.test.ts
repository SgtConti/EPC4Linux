import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TPV_QUERY,
  buildDdcMessage,
  capsRequestPayload,
  checkReply,
  extCode,
  extSub,
  extractTpvPayload,
  fwVersionFromC9,
  getExtPayload,
  getVcpPayload,
  isExtCode,
  isNullMessage,
  parseBomString,
  parseBootFlagAddress,
  parseCapsFragment,
  parseDualImageBank,
  parseScalerIc,
  parseSerialReply,
  parseVcpReply,
  rawGetPayload,
  scalerTypeOf,
  setExtPayload,
  setVcpPayload,
  toWireFrame,
  tpvAscii,
  xorChecksum,
} from '../../../src/backend/ddc/codec.ts';
import { DdcError } from '../../../src/backend/ddc/errors.ts';
import { bytes, hex } from './helpers.ts';

/** Build a display->host reply `6E (80|L) payload chk` (0x50-seeded checksum). */
function reply(payload: number[], pad = 32): Uint8Array {
  const out = new Uint8Array(Math.max(pad, payload.length + 3));
  out[0] = 0x6e;
  out[1] = 0x80 | payload.length;
  out.set(payload, 2);
  out[payload.length + 2] = xorChecksum(out.subarray(0, payload.length + 2), 0x50);
  return out;
}

const wire = (payload: number[]) => hex(toWireFrame(buildDdcMessage(payload)));

test('08 §3.3 worked examples: standard and extended VCP frames', () => {
  assert.equal(wire(getVcpPayload(0x10)), '6E 51 82 01 10 AC');
  assert.equal(wire(getVcpPayload(0x14)), '6E 51 82 01 14 A8');
  assert.equal(wire(getVcpPayload(0xc8)), '6E 51 82 01 C8 74');
  assert.equal(wire(setVcpPayload(0x10, 0x32)), '6E 51 84 03 10 00 32 9A');
  assert.equal(wire(getExtPayload(0x43)), '6E 51 84 01 E2 A0 43 BB');
  assert.equal(wire(setExtPayload(0x43, 1)), '6E 51 86 03 E2 A0 43 00 01 BA');
});

test('07 §6 frames without the address byte (DDCHelper form)', () => {
  assert.equal(hex(buildDdcMessage(getVcpPayload(0x14))), '51 82 01 14 A8');
  assert.equal(hex(buildDdcMessage(setVcpPayload(0x10, 50))), '51 84 03 10 00 32 9A');
  assert.equal(hex(buildDdcMessage(getExtPayload(0x41))), '51 84 01 E2 A0 41 B9');
  assert.equal(hex(buildDdcMessage(setExtPayload(0x01, 4))), '51 86 03 E2 A0 01 00 04 FD');
  assert.equal(hex(buildDdcMessage([0x01, 0xfe, 0xef, 0x13, 0x00, 0x00, 0x20])), '51 87 01 FE EF 13 00 00 20 9B');
  assert.equal(hex(buildDdcMessage(rawGetPayload([0xfe, 0xe1, 0xe6, 0x06, 0x00]))), '51 86 01 FE E1 E6 06 00 47');
  assert.equal(hex(buildDdcMessage(capsRequestPayload(0))), '51 83 F3 00 00 4F');
  assert.equal(hex(buildDdcMessage(capsRequestPayload(0x20))), '51 83 F3 00 20 6F');
});

test('08 §3.4 TPV identity query frames', () => {
  const q = (args: readonly number[]) => wire(rawGetPayload([...args]));
  assert.equal(q(TPV_QUERY.modelName), '6E 51 86 01 FE E9 0D 00 00 A2');
  assert.equal(q(TPV_QUERY.bomString), '6E 51 86 01 FE E1 E6 1D 00 5C');
  assert.equal(q(TPV_QUERY.fwVersion), '6E 51 86 01 FE E1 E6 06 00 47');
  assert.equal(q(TPV_QUERY.dualImageBank), '6E 51 86 01 FE E1 A1 01 00 07');
  assert.equal(q(TPV_QUERY.bootFlagAddress), '6E 51 86 01 FE E1 A1 01 01 06');
  assert.equal(q(TPV_QUERY.scalerName), '6E 51 86 01 FE E1 E8 00 00 4F');
  assert.equal(q(TPV_QUERY.panelName), '6E 51 86 01 FE E1 A7 07 00 07');
  assert.equal(q(TPV_QUERY.serialNumber), '6E 51 86 01 FE EF 13 00 20 9A');
});

test('argument validation', () => {
  assert.throws(() => getVcpPayload(0x100), DdcError);
  assert.throws(() => setVcpPayload(0x10, 0x10000), DdcError);
  assert.throws(() => setVcpPayload(0x10, -1), DdcError);
  assert.throws(() => setExtPayload(0x19, 1.5), DdcError);
  assert.throws(() => buildDdcMessage([]), DdcError);
  assert.throws(() => buildDdcMessage(new Array(33).fill(0)), DdcError);
  assert.throws(() => rawGetPayload(new Array(28).fill(0)), DdcError);
  assert.equal(isExtCode(0xe2a019), true);
  assert.equal(isExtCode(0x19), false);
  assert.equal(extCode(0x19), 0xe2a019);
  assert.equal(extSub(0xe2a043), 0x43);
  assert.throws(() => extSub(0x43), DdcError);
});

test('reply validation: 0x50-seeded checksum over source, length, payload and checksum (08 §3.2)', () => {
  const example = bytes('6E 88 02 00 10 00 00 64 00 32 F2');
  assert.deepEqual(checkReply(example), { ok: true, length: 8 });
  assert.equal(xorChecksum(example, 0x50), 0);
  const corrupt = example.slice();
  corrupt[10] ^= 1;
  assert.deepEqual(checkReply(corrupt), { ok: false, reason: 'checksum mismatch' });
  assert.equal(checkReply(bytes('6F 88 02 00 10 00 00 64 00 32 F2')).ok, false);
  assert.equal(checkReply(bytes('6E 08 02')).ok, false);
  const nullMessage = bytes('6E 80 BE');
  assert.equal(isNullMessage(nullMessage), true);
  assert.deepEqual(checkReply(nullMessage), { ok: false, reason: 'null message' });
  assert.equal(checkReply(bytes('6E 88 02 00')).ok, false); // length beyond buffer
});

test('VCP reply parsing is length-relative (last four payload bytes)', () => {
  assert.deepEqual(parseVcpReply(bytes('6E 88 02 00 10 00 00 64 00 32 F2')), { value: 0x32, max: 0x64, resultCode: 0 });
  // Probe value seen on the user's monitor: 0x14 = 5, max 0x0D.
  assert.deepEqual(parseVcpReply(reply([0x02, 0x00, 0x14, 0x00, 0x00, 0x0d, 0x00, 0x05])), { value: 5, max: 13, resultCode: 0 });
  // Longer reply: still the last four bytes (Interface2.GetStandardDDC).
  assert.deepEqual(parseVcpReply(reply([0x02, 0x00, 0xe2, 0xa0, 0x39, 0x00, 0x00, 0x10, 0x00, 0x08])), { value: 8, max: 16, resultCode: 0 });
  // Unsupported code: result code reported, not an error (hub semantics).
  assert.equal(parseVcpReply(reply([0x02, 0x01, 0x8a, 0x00, 0, 0, 0, 0])).resultCode, 1);
  assert.throws(() => parseVcpReply(reply([0x02, 0x00, 0x10])), /out of range/);
});

test('capabilities fragment parsing', () => {
  const frag = parseCapsFragment(reply([0xe3, 0x00, 0x20, ...Buffer.from('vcp(02 04'), 0x00]));
  assert.deepEqual(frag, { offset: 0x20, length: 10, text: 'vcp(02 04' });
  assert.equal(parseCapsFragment(reply([0xe3, 0x04, 0xf1])).length, 0);
  assert.throws(() => parseCapsFragment(reply([0x02, 0x00, 0x00])), /opcode/);
});

test('imethod_8 payload extraction, with and without the pad byte', () => {
  const ascii = reply([0xfe, 0xe9, 0x0d, ...Buffer.from('34M2C8600')]);
  assert.equal(tpvAscii(ascii), '34M2C8600');
  const sub = extractTpvPayload(ascii);
  assert.equal(sub.length, 12); // array length L, zero tail
  assert.equal(hex(sub.subarray(9)), '00 00 00');
  const padded = reply([0xfe, 0xe1, 0xa1, 0x00, 0x00, 0x00, 0x40]);
  assert.equal(hex(extractTpvPayload(padded).subarray(0, 3)), '00 00 40');
  assert.equal(parseDualImageBank(padded, 'RTK'), 0x40);
  assert.equal(parseDualImageBank(reply([0xfe, 0xe1, 0xa1, 0x01, 0x12, 0x34]), 'RTK'), 0x1234);
  assert.equal(parseDualImageBank(reply([0xfe, 0xe1, 0xa1, 0x01, 0x12, 0x34]), 'NTK'), 0x34);
  assert.equal(parseBootFlagAddress(reply([0xfe, 0xe1, 0xa1, 0x09, 0x00, 0x40, 0x00, 0x00])), 0x00400000);
  assert.equal(tpvAscii(reply([0xfe, 0xe1, 0xe6, ...Buffer.from('V1.01'), 0, 0x41])), 'V1.01'); // stops at NUL
});

test('factory serial parsing (Interface2.GetSN)', () => {
  assert.equal(parseSerialReply(reply([...Buffer.from('AU00000000001')])), 'AU00000000001');
  assert.equal(parseSerialReply(reply([...Buffer.from('AU00000000001'), 0, 0, 0])), 'AU00000000001'); // N >= 14, NULs dropped
  assert.equal(parseSerialReply(reply([...Buffer.from('AU000000000019999')])), 'AU000000000019'); // truncated to 14
  assert.equal(parseSerialReply(reply([...Buffer.from('AU0000')])), ''); // shorter than 13
  assert.equal(parseSerialReply(reply([...Buffer.from('ABCDEFGHIJKLM'), 0xc3])), 'ABCDEFGHIJKLM?'); // ASCII decoder
});

test('scaler IC, BOM rule and firmware level', () => {
  const c8 = reply([0x02, 0x00, 0xc8, 0x00, 0x00, 0xff, 0x00, 0x09]);
  assert.equal(parseScalerIc(c8), 0x09);
  assert.equal(scalerTypeOf(0x09), 'RTK');
  assert.equal(scalerTypeOf(0x05), 'MTK');
  assert.equal(scalerTypeOf(0x12), 'NTK');
  assert.equal(scalerTypeOf(0x24), 'HVW');
  assert.equal(scalerTypeOf(0x33), 'Unknown');
  assert.equal(parseBomString(reply([0xfe, 0xe1, 0xe6, ...Buffer.from('100GPRS2003NA1SXXY')])), '100GPRS2003NA1SXXY');
  assert.equal(parseBomString(reply([0xfe, 0xe1, 0xe6, ...Buffer.from('100GARVGG88NT1SXXY')])), '100GARVGG88NT1SXXY');
  assert.throws(() => parseBomString(reply([0xfe, 0xe1, 0xe6, ...Buffer.from('100GXRS2003NA1SXXY')])), /not accepted/);
  assert.equal(parseBomString(reply([0xfe, 0xe1, 0xe6, ...Buffer.from('100GARS2003NA1SXXY')]), ['AOC']), '100GARS2003NA1SXXY');
  assert.equal(fwVersionFromC9({ value: 0x0101, max: 201, resultCode: 0 }), 'V1.01');
  assert.equal(fwVersionFromC9({ value: 0, max: 201, resultCode: 0 }), '');
  assert.equal(fwVersionFromC9({ value: 0x0101, max: 0xff, resultCode: 0 }), null);
});

test('scaler IC: r[9] must be a payload byte (L >= 8), never the checksum or bus padding', () => {
  // 32-byte reads: a short reply is followed by padding. With L = 4 the vendor throws (sub[4]), with
  // L = 5..7 it would read r[9] behind the payload; a 0x09 there must not classify the scaler as RTK.
  const padded = (payload: number[]) => {
    const raw = new Uint8Array(32).fill(0x09);
    raw.set(reply(payload, 0));
    return raw;
  };
  for (const short of [[0x02, 0x00, 0xc8, 0x00], [0x02, 0x00, 0xc8, 0x00, 0x00, 0xff, 0x00]]) {
    assert.throws(() => parseScalerIc(padded(short)), (e: unknown) => e instanceof DdcError && e.code === 'invalid-reply' && /< 8/.test(e.message));
  }
  assert.equal(parseScalerIc(padded([0x02, 0x00, 0xc8, 0x00, 0x00, 0xff, 0x00, 0x05])), 0x05);
});

test('20 §2.5 frame table', () => {
  assert.equal(wire(getVcpPayload(0x60)), '6E 51 82 01 60 DC');
  assert.equal(wire(getVcpPayload(0xdc)), '6E 51 82 01 DC 60');
  assert.equal(wire(getExtPayload(0x39)), '6E 51 84 01 E2 A0 39 C1');
  assert.equal(wire(capsRequestPayload(0)), '6E 51 83 F3 00 00 4F');
});
