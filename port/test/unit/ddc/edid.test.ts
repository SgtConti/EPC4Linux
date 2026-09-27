import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  edidDisplayStrings,
  localeDecimalSeparator,
  edidPairingName,
  fixEdidHeader,
  parseEdid,
  sameEdidBase,
  simpleModelName,
} from '../../../src/backend/ddc/edid.ts';
import { MOCK_34M2C8600, MOCK_SERIAL } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { hexToBytes } from '../../../src/backend/ddc/transports/mock.ts';
import { USER_EDID_HEX } from '../../fixtures/user-monitor.ts';
import { fixture, realEdid } from './helpers.ts';

test('real EDID (RAW DUMP, 07 §7.3) parses to the expected identity', () => {
  const raw = realEdid();
  assert.equal(raw.length, 256);
  const e = parseEdid(raw);
  assert.equal(e.manufacturer, 'PHL');
  assert.equal(e.productCode, 0xc29f);
  assert.equal(e.pnpId, 'PHLC29F');
  assert.equal(e.serialNumber, 1);
  assert.equal(e.monitorName, 'PHL 34M2C8600');
  assert.equal(e.serialString, 'AU00000000001');
  assert.equal(e.week, 1);
  assert.equal(e.year, 2025);
  assert.equal(`${e.version}.${e.revision}`, '1.4');
  assert.equal(e.digital, true);
  assert.deepEqual([e.widthCm, e.heightCm], [80, 34]);
  assert.equal(e.gammaByte, 0x78);
  assert.deepEqual(e.preferredTiming, { width: 3440, height: 1440 });
  assert.equal(e.extensionCount, 2); // byte 126; only the first extension is in the 256-byte dump
  assert.equal(e.checksumValid, true);
  assert.deepEqual(e.chromaticity, { rx: 706, ry: 310, gx: 247, gy: 732, bx: 148, by: 60, wx: 321, wy: 337 });
  assert.deepEqual(e.descriptors.map((d) => d.tag), [null, 0xff, 0xfc, 0xfd]);
  assert.equal(e.raw !== raw && sameEdidBase(e.raw, raw), true);
});

test('vendor EDID strings equal the MonitorEDIDInfo_T persisted by Windows (comma culture)', () => {
  const pcenter = readFileSync(fixture('EvniaServe/Theme/User/Default.pcenter'), 'utf8').replace(/^﻿/, '');
  const content = JSON.parse(JSON.parse(pcenter).Profiles[0].ProfileContent);
  const persisted = content.DispalyData.MonitorEDIDInfo_T;
  const strings = edidDisplayStrings(parseEdid(realEdid()), ',');
  assert.deepEqual(strings, persisted);
  assert.deepEqual(Object.keys(strings), Object.keys(persisted)); // C# declaration order
});

test('vendor EDID strings with an invariant decimal point', () => {
  const s = edidDisplayStrings(parseEdid(realEdid()));
  assert.equal(s.ScreenSize, '~34.2"');
  assert.equal(s.DisplayGamma, '2.2');
  assert.equal(s.RedChromaticity, 'Rx0.689-Ry0.303');
  assert.equal(s.BlueChromaticity, 'Bx0.145-By0.059');
  assert.equal(s.sManufacturerDate, 'Week01-2025');
});

test('unknown manufacturers keep the vendor fallback text; DisplayID timings win for Philips', () => {
  const raw = realEdid().slice();
  raw[8] = 0x5a; // "VQZ": not in the table
  raw[9] = 0x3a;
  let sum = 0;
  for (let i = 0; i < 127; i++) sum += raw[i];
  raw[127] = (256 - (sum % 256)) % 256;
  const e = parseEdid(raw);
  assert.equal(e.manufacturer, 'VQZ');
  assert.equal(edidDisplayStrings(e).sManufacturer, `868190${e.pnpId}`); // 64+22, (64+16)|1, 64+26

  // Three blocks with a DisplayID extension (tag 0x70) holding a type-I timing of 5120x2160.
  const three = new Uint8Array(384);
  three.set(realEdid());
  three[256] = 0x70;
  const block = three.subarray(256);
  block[5] = 0x03; // data block tag (array index 4 after the vendor's one-byte shift)
  block[7] = 20; // payload length: one 20-byte timing
  const t = 8; // i + 3 in the shifted array → block offset 8
  block[t + 4] = (5120 - 1) & 0xff;
  block[t + 5] = (5120 - 1) >> 8;
  block[t + 12] = (2160 - 1) & 0xff;
  block[t + 13] = (2160 - 1) >> 8;
  assert.equal(edidDisplayStrings(parseEdid(three)).TimingRecommandation, '5120x2160');
});

test('pairing name and header fix', () => {
  assert.equal(edidPairingName(realEdid()), '34M2C8600');
  assert.equal(simpleModelName('PHL_27E1N5500'), '27E1N5500');
  assert.equal(simpleModelName('aoc 24G2'), '24G2');
  const shifted = realEdid().slice(1);
  const padded = new Uint8Array(256);
  padded.set(shifted);
  const fixed = fixEdidHeader(padded);
  assert.ok(fixed);
  assert.equal(sameEdidBase(fixed, realEdid()), true);
  assert.equal(fixEdidHeader(new Uint8Array(256)), null);
  assert.throws(() => parseEdid(new Uint8Array(100)), /not an EDID/);
});

test('the captured unit in the tests is the (anonymized) logged dump; the shipped simulator differs only in its serials (privacy)', () => {
  const real = realEdid();
  assert.deepEqual(hexToBytes(USER_EDID_HEX), real);
  const shipped = hexToBytes(MOCK_34M2C8600.edidHex);
  assert.equal(shipped.length, real.length);
  const differs = [...real.keys()].filter((i) => real[i] !== shipped[i]);
  // bytes 12-15: the 32-bit serial number; 77-89: the 0xFF descriptor text; 127: the base block checksum
  assert.ok(differs.every((i) => (i >= 12 && i <= 15) || (i >= 77 && i <= 89) || i === 127), `differs at ${differs.join(',')}`);
  const e = parseEdid(shipped);
  assert.equal(e.serialString, MOCK_SERIAL);
  assert.equal(e.serialNumber, 1);
  assert.equal(e.monitorName, 'PHL 34M2C8600', 'the model identity is kept');
  assert.equal(e.productCode, 0xc29f);
  assert.notEqual(parseEdid(real).serialString, e.serialString);
  assert.equal(shipped.subarray(0, 128).reduce((s, b) => (s + b) & 0xff, 0), 0, 'valid base block checksum');
});

test('decimal separator from the process locale (20 D5)', () => {
  assert.equal(localeDecimalSeparator({ LANG: 'de_DE.UTF-8' }), ',');
  assert.equal(localeDecimalSeparator({ LANG: 'da_DK.UTF-8' }), ',');
  assert.equal(localeDecimalSeparator({ LANG: 'en_US.UTF-8' }), '.');
  assert.equal(localeDecimalSeparator({ LC_NUMERIC: 'fr_FR.UTF-8', LANG: 'en_US.UTF-8' }), ',');
  assert.equal(localeDecimalSeparator({ LC_ALL: 'en_GB.UTF-8', LC_NUMERIC: 'de_DE.UTF-8' }), '.');
  assert.equal(localeDecimalSeparator({ LANG: 'C.UTF-8' }), '.');
  assert.equal(localeDecimalSeparator({ LANG: 'sr_RS@latin' }), ',');
  assert.equal(localeDecimalSeparator({}), '.');
});

test('the EDID serial loses non-ASCII characters (MonitorUtil.smethod_9)', () => {
  const raw = realEdid().slice();
  raw[77 + 2] = 0xc5; // the first '0' of "AU00000000001" becomes a non-ASCII byte
  const e = parseEdid(raw);
  assert.equal(e.serialString, 'AU0000000001');
  assert.equal(edidDisplayStrings(e).sSerialNumber, 'AU0000000001');
});
