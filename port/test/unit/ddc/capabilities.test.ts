import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analyseVcpString,
  parseCapabilities,
  readCapabilityString,
  type CapsFetch,
} from '../../../src/backend/ddc/capabilities.ts';
import type { CapsFragment } from '../../../src/backend/ddc/codec.ts';
import { DdcError } from '../../../src/backend/ddc/errors.ts';
import { MOCK_34M2C8600 } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { fixture, realCapabilities } from './helpers.ts';

const hexList = (s: string) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));

test('the simulator carries the user\'s capability string byte for byte', () => {
  assert.equal(MOCK_34M2C8600.capabilities, realCapabilities());
});

test('structural parse of the real 34M2C8600 capability string (06 §4.8)', () => {
  const caps = parseCapabilities(realCapabilities());
  assert.equal(caps.prot, 'monitor');
  assert.equal(caps.type, 'LCD');
  assert.equal(caps.model, '34M2C8600MV');
  assert.equal(caps.mccsVer, '2.2');
  assert.deepEqual(caps.cmds, hexList('01 02 03 07 0C E3 F3'));
  assert.deepEqual(caps.segments.map((s) => s.name), ['prot', 'type', 'model', 'cmds', 'vcp', 'mswhql', 'asset_eep', 'mccs_ver']);
  assert.deepEqual(caps.warnings, []);
  const byHex = new Map(caps.vcp.map((v) => [v.hex, v]));
  assert.equal(caps.vcp.length, 85);
  assert.deepEqual(byHex.get('14')?.values, hexList('02 04 05 06 07 08 0A 0B 0D'));
  assert.deepEqual(byHex.get('60')?.values, hexList('11 12 0F 15 21 22 2F 35'));
  assert.deepEqual(byHex.get('86')?.values, hexList('01 0A 12 13 14 15 16 17 18 19 1A 1B 23'));
  assert.deepEqual(byHex.get('87')?.values, []); // "...23)87" without a space
  assert.deepEqual(byHex.get('DC')?.values.at(-1), 0xe2); // selects the SmartImage_E2 table
  assert.deepEqual(byHex.get('F7')?.values, [0x42]);
  // 3-byte TPV codes, including the double space inside E2A020's list.
  assert.equal(byHex.get('E2A019')?.code, 0xe2a019);
  assert.deepEqual(byHex.get('E2A020')?.values, hexList('02 03 04 0F'));
  assert.deepEqual(byHex.get('E2A042')?.values.length, 16);
  assert.deepEqual(byHex.get('E2A039')?.values, []);
  assert.deepEqual(caps.vcp.slice(-2).map((v) => v.hex), ['FD', 'FF']);
});

test('vendor-compatible AnalyseVcpString agrees with the structural parse on the real string', () => {
  const raw = realCapabilities();
  const map = analyseVcpString(raw);
  assert.ok(map);
  const caps = parseCapabilities(raw);
  assert.deepEqual([...map.entries()], caps.vcp.map((v) => [v.code, v.values]));
  // Unhandled codes the vendor logs on this monitor are present as keys (06 §4.8).
  for (const code of hexList('02 05 08 0B 0C 52 6C 6E 70 AC AE B2 B6 C0 C6 C8 CA DF FD FF')) assert.ok(map.has(code));
});

test('AnalyseVcpString edge cases follow the vendor regexes', () => {
  // No spaces: a space is inserted after every 2-hex token and multi-byte support is lost.
  assert.deepEqual([...analyseVcpString('(vcp(10121460(0F11)E2A019))')!.entries()], [
    [0x10, []], [0x12, []], [0x14, []], [0x60, [0x0f, 0x11]], [0xe2, []], [0xa0, []], [0x19, []],
  ]);
  // Nested sub-list: the balancing regex accepts the item but its value list is empty.
  assert.deepEqual([...analyseVcpString('vcp(14(05 08(01 02)) 10)')!.entries()], [[0x14, []], [0x10, []]]);
  // Duplicate code: first wins; duplicate values are dropped; invalid values are skipped.
  assert.deepEqual([...analyseVcpString('vcp(60(0F 0F 11 XY 123) 60(12) 10 10)')!.entries()], [[0x60, [0x0f, 0x11]], [0x10, []]]);
  // Case-insensitive, odd-length and non-hex tokens skipped, text before VCP ignored.
  assert.deepEqual([...analyseVcpString('model(x)VCP(10 1 ZZ e2a0ff(0a))')!.entries()], [[0x10, []], [0xe2a0ff, [0x0a]]]);
  // First balanced VCP( group only.
  assert.deepEqual([...analyseVcpString('vcp(10) vcp(12)')!.entries()], [[0x10, []]]);
  // Unbalanced first occurrence: the vendor's regex moves on to the next VCP(.
  assert.deepEqual([...analyseVcpString('vcp(10 vcp(12)')!.entries()], [[0x12, []]]);
  // Tab after a code is whitespace; a trailing LF is tolerated like .NET's `$`.
  assert.deepEqual([...analyseVcpString('vcp(10\t 12\n)')!.entries()], [[0x10, []], [0x12, []]]);
  // Codes longer than 8 hex digits overflow int.Parse: the vendor returns false.
  assert.equal(analyseVcpString('vcp(10 E2A0000000)'), null);
  assert.equal(analyseVcpString('vcp(10 FFFFFFFF)')!.has(-1), true); // 8 digits: negative like int.Parse
  assert.equal(analyseVcpString('(prot(monitor))'), null);
  assert.equal(analyseVcpString(''), null);
  assert.equal(analyseVcpString(null), null);
});

test('structural parser handles missing outer parentheses, nesting and junk', () => {
  const caps = parseCapabilities(' prot(monitor) vcp(14(05 08(01 02)) 60 ( 0F 11 ) ) junk');
  assert.equal(caps.prot, 'monitor');
  assert.deepEqual(caps.vcp.map((v) => [v.hex, v.values]), [['14', [5, 8]], ['60', [0x0f, 0x11]]]);
  assert.deepEqual(caps.vcp[0].tree[1], { value: 8, children: [{ value: 1 }, { value: 2 }] });
  assert.ok(caps.warnings.some((w) => w.includes('junk')));
  const noSpace = parseCapabilities('(vcp(101214(0506)))');
  assert.deepEqual(noSpace.vcp.map((v) => [v.code, v.values]), [[0x10, []], [0x12, []], [0x14, [5, 6]]]);
});

// ───────────── fragment reader ─────────────

function fragmentsOf(text: string, size: number): Map<number, CapsFragment> {
  const map = new Map<number, CapsFragment>();
  for (let off = 0; off < text.length; off += size) {
    const part = text.slice(off, off + size);
    map.set(off, { offset: off, length: part.length, text: part });
  }
  map.set(text.length, { offset: text.length, length: 0, text: '' }); // MCCS end marker
  return map;
}

test('reader: standard advance by fragment length; stops when the outer group closes or on the end marker', async () => {
  const run = async (text: string) => {
    const frags = fragmentsOf(text, 32);
    const requested: number[] = [];
    const fetch: CapsFetch = async (offset) => {
      requested.push(offset);
      const f = frags.get(offset);
      if (!f) throw new Error(`unexpected offset ${offset}`);
      return f;
    };
    assert.equal(await readCapabilityString(fetch), text);
    return requested;
  };
  const real = realCapabilities();
  const requested = await run(real);
  assert.equal(requested.length, Math.ceil(real.length / 32)); // "(...mccs_ver(2.2))" balances: no end-marker request
  assert.equal(requested[1], 32); // not the vendor's 27-byte cap
  const bare = 'prot(monitor)type(LCD)vcp(10 12 14)mccs_ver(2.2)'; // no outer group: read up to the end marker
  assert.equal((await run(bare)).length, Math.ceil(bare.length / 32) + 1);
  const early = '(prot(monitor)) vcp(10)'; // closes early but not at a fragment end: keep reading
  assert.equal((await run(early)).length, 2);
});

test('the port matches the vendor parser dump logged by EvniaServe (LOG26 "5. 匹配完毕的 VCP")', () => {
  const lines = readFileSync(fixture('logs/EvniaServe-2026-09-26.txt'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('5. 匹配完毕的 VCP'));
  assert.ok(start > 0);
  const logged: Array<[number, number[]]> = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+([0-9A-F]+), \[([0-9A-F, ]*)\]/.exec(line);
    if (!m) break;
    logged.push([parseInt(m[1], 16), m[2] ? m[2].split(', ').map((h) => parseInt(h, 16)) : []]);
  }
  assert.equal(logged.length, 85);
  assert.deepEqual([...analyseVcpString(realCapabilities())!.entries()], logged);
});

test('reader: retries per fragment, then fails; vendor short-fragment stop as fallback', async () => {
  const text = 'vcp(10 12 14)';
  let calls = 0;
  const flaky: CapsFetch = async (offset) => {
    calls++;
    if (calls <= 3) throw new DdcError('io', 'nack');
    return offset === 0 ? { offset: 0, length: text.length, text } : { offset, length: 0, text: '' };
  };
  assert.equal(await readCapabilityString(flaky), text); // 3 failures tolerated
  const dead: CapsFetch = async () => {
    throw new DdcError('io', 'nack');
  };
  await assert.rejects(readCapabilityString(dead), /nack/);
  // Monitor that errors instead of sending the end marker after a short (< 26 bytes) fragment.
  const noEnd: CapsFetch = async (offset) => {
    if (offset === 0) return { offset: 0, length: text.length, text };
    throw new DdcError('invalid-reply', 'null message');
  };
  assert.equal(await readCapabilityString(noEnd), text);
  // ...but not after a full-size fragment (the string may be incomplete).
  const full = 'x'.repeat(32);
  const cutOff: CapsFetch = async (offset) => {
    if (offset === 0) return { offset: 0, length: 32, text: full };
    throw new DdcError('invalid-reply', 'null message');
  };
  await assert.rejects(readCapabilityString(cutOff), /null message/);
});

test('reader: offset echo mismatch is only logged; runaway strings are bounded', async () => {
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn: (m: unknown) => warnings.push(String(m)), error() {}, child() { return log; } };
  const text = 'abc';
  const skew: CapsFetch = async (offset) => (offset === 0 ? { offset: 7, length: 3, text } : { offset: 99, length: 0, text: '' });
  assert.equal(await readCapabilityString(skew, { log }), text);
  assert.equal(warnings.length, 2);
  const endless: CapsFetch = async (offset) => ({ offset, length: 32, text: 'y'.repeat(32) });
  await assert.rejects(readCapabilityString(endless, { maxLength: 100 }), /longer than 100/);
});
