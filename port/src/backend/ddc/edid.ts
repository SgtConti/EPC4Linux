// EDID 1.3/1.4 base-block parser (07 §4.8.6-4.8.7, 06 §4.5) plus the vendor's string formatting of
// MonitorUtil.EDID256Block.FnSetaByteEDID, which feeds DisplayEDIDInfo / MonitorEDIDInfo_T in the
// profile JSON (work/dotnet-clean/Zeasn.Monitor.Lib/Zeasn.Monitor.Lib.Utils/MonitorUtil.cs:884-1125).

import type { EdidInfo } from '../types.ts';
import { DdcError } from './errors.ts';

export const EDID_BLOCK = 128;
const HEADER = [0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00];

export interface EdidChromaticity {
  /** Raw 10-bit CIE coordinates (value / 1024). */
  rx: number; ry: number; gx: number; gy: number; bx: number; by: number; wx: number; wy: number;
}

export interface EdidDescriptor {
  /** Display descriptor tag (0xFF serial, 0xFE text, 0xFD range limits, 0xFC name, ...), or null for a DTD. */
  tag: number | null;
  offset: number;
}

export interface EdidDetails extends EdidInfo {
  /** PnP id: manufacturer + product code as 4 hex digits, e.g. "PHLC29F". */
  pnpId: string;
  version: number;
  revision: number;
  digital: boolean;
  /** Screen size in cm (bytes 21/22); 0 when undefined. */
  widthCm: number;
  heightCm: number;
  /** Raw gamma byte (23): gamma = (b + 100) / 100, 0xFF = undefined. */
  gammaByte: number;
  featureSupport: number;
  chromaticity: EdidChromaticity;
  /** Active pixels of DTD #1 when the "preferred timing" feature bit is set. */
  preferredTiming: { width: number; height: number } | null;
  extensionCount: number;
  /** Checksum of the base block (the vendor never checks it). */
  checksumValid: boolean;
  descriptors: EdidDescriptor[];
}

function hasHeader(raw: Uint8Array): boolean {
  return raw.length >= EDID_BLOCK && HEADER.every((b, i) => raw[i] === b);
}

/**
 * EDIDJudgeAndFix (07 §4.8.6): raw I2C reads sometimes lose the first byte; a block starting
 * `FF FF FF FF FF FF 00` is shifted right by one with edid[0] = 0. Returns null when not an EDID.
 * Only meant for bytes read directly from slave 0x50, never for the kernel's sysfs copy.
 */
export function fixEdidHeader(raw: Uint8Array): Uint8Array | null {
  if (hasHeader(raw)) return raw;
  if (raw.length >= EDID_BLOCK && HEADER.slice(1).every((b, i) => raw[i] === b)) {
    const fixed = new Uint8Array(raw.length);
    fixed.set(raw.subarray(0, raw.length - 1), 1);
    return fixed;
  }
  return null;
}

/** MonitorUtil.smethod_9: the EDID serial loses every non-ASCII character (20 D6). */
function stripNonAscii(s: string): string {
  return [...s].filter((c) => c.charCodeAt(0) < 0x80).join('');
}

/** Vendor descriptor test: bytes 0,1 == 0 and byte 3 == tag (byte 2/4 not checked). */
function descriptorText(raw: Uint8Array, tag: number): string {
  let s = '';
  for (let d = 0; d < 4; d++) {
    const at = 54 + d * 18;
    if (raw[at] !== 0 || raw[at + 1] !== 0 || raw[at + 3] !== tag) continue;
    for (let j = 0; j < 13 && raw[at + 5 + j] !== 0x0a; j++) s += String.fromCharCode(raw[at + 5 + j]);
  }
  return s;
}

function manufacturerId(b8: number, b9: number): string {
  return (
    String.fromCharCode(64 + (b8 >> 2)) +
    String.fromCharCode((64 + (((b8 & 3) << 3) & 0xf8)) | ((b9 >> 5) & 0x1f)) +
    String.fromCharCode(64 + (b9 & 0x1f))
  );
}

/** Parse the base block (and count extensions). Throws DdcError('invalid-reply') without a valid header. */
export function parseEdid(raw: Uint8Array): EdidDetails {
  if (!hasHeader(raw)) throw new DdcError('invalid-reply', `not an EDID (${raw.length} bytes, bad header)`);
  const manufacturer = manufacturerId(raw[8], raw[9]);
  const productCode = raw[10] | (raw[11] << 8);
  let sum = 0;
  for (let i = 0; i < EDID_BLOCK; i++) sum = (sum + raw[i]) & 0xff;
  const lo25 = raw[25];
  const lo26 = raw[26];
  const chromaticity: EdidChromaticity = {
    rx: (raw[27] << 2) | ((lo25 >> 6) & 3),
    ry: (raw[28] << 2) | ((lo25 >> 4) & 3),
    gx: (raw[29] << 2) | ((lo25 >> 2) & 3),
    gy: (raw[30] << 2) | (lo25 & 3),
    bx: (raw[31] << 2) | ((lo26 >> 6) & 3),
    by: (raw[32] << 2) | ((lo26 >> 4) & 3),
    wx: (raw[33] << 2) | ((lo26 >> 2) & 3),
    wy: (raw[34] << 2) | (lo26 & 3),
  };
  const descriptors: EdidDescriptor[] = [];
  for (let d = 0; d < 4; d++) {
    const at = 54 + d * 18;
    const isDisplayDescriptor = raw[at] === 0 && raw[at + 1] === 0;
    descriptors.push({ tag: isDisplayDescriptor ? raw[at + 3] : null, offset: at });
  }
  const preferred = (raw[24] & 2) !== 0 && descriptors[0].tag === null
    ? { width: raw[56] + ((raw[58] >> 4) & 0xf) * 256, height: raw[59] + ((raw[61] >> 4) & 0xf) * 256 }
    : null;
  return {
    raw: raw.slice(),
    manufacturer,
    productCode,
    serialNumber: (raw[12] | (raw[13] << 8) | (raw[14] << 16) | (raw[15] << 24)) >>> 0,
    monitorName: descriptorText(raw, 0xfc),
    serialString: stripNonAscii(descriptorText(raw, 0xff)),
    week: raw[16],
    year: 1990 + raw[17],
    pnpId: manufacturer + productCode.toString(16).toUpperCase().padStart(4, '0'),
    version: raw[18],
    revision: raw[19],
    digital: (raw[20] & 0x80) !== 0,
    widthCm: raw[21],
    heightCm: raw[22],
    gammaByte: raw[23],
    featureSupport: raw[24],
    chromaticity,
    preferredTiming: preferred,
    extensionCount: raw[126],
    checksumValid: sum === 0,
    descriptors,
  };
}

/** First 128 bytes equal: the vendor's EDID identity rule (FindMonitorByEDID, 07 §4.4-4.5). */
export function sameEdidBase(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length < EDID_BLOCK || b.length < EDID_BLOCK) return false;
  for (let i = 0; i < EDID_BLOCK; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Name used to pair a USB bridge with a display (MonitorUtil.smethod_7 + Util.GetSimpleName, 08 §3.7):
 * the first strict 0xFC descriptor (00 00 00 FC 00), trimmed, upper-cased, with a leading "PHL"/"AOC"
 * and then "_" removed. Null when the EDID has no name descriptor.
 */
export function edidPairingName(raw: Uint8Array): string | null {
  for (let d = 0; d < 4; d++) {
    const at = 54 + d * 18;
    if (raw[at] !== 0 || raw[at + 1] !== 0 || raw[at + 2] !== 0 || raw[at + 3] !== 0xfc || raw[at + 4] !== 0) continue;
    let text = '';
    for (const b of raw.subarray(at + 5, at + 18)) text += b > 0x7f ? '?' : String.fromCharCode(b);
    return simpleModelName(text.trim());
  }
  return null;
}

/** Util.GetSimpleName: upper-case, strip a "PHL" then an "AOC" prefix, trim, strip leading "_". */
export function simpleModelName(name: string): string {
  let text = name.toUpperCase();
  if (text.startsWith('PHL')) text = text.slice(3);
  if (text.startsWith('AOC')) text = text.slice(3);
  return text.trim().replace(/^_+/, '');
}

// ───────────────────────────── vendor display strings ─────────────────────────────

/** DisplayEDIDInfo (Zeasn.PCenter.Base.Lib/DisplayEDIDInfo.cs) in C# declaration order. */
export interface DisplayEdidStrings {
  sManufacturer: string;
  sManufacturerDate: string;
  PlugAndPlayID: string;
  sMonitorName: string;
  sSerialNumber: string;
  sVersion: string;
  ScreenSize: string;
  TimingRecommandation: string;
  DisplayGamma: string;
  DisplayTypeAndSignal: string;
  RedChromaticity: string;
  GreenChromaticity: string;
  BlueChromaticity: string;
  WhitePoint: string;
}

/** FnIDManufacturerName lookup table, keyed by bytes 8..9 big-endian (verbatim from the vendor). */
const MANUFACTURER_NAMES: ReadonlyMap<number, string> = new Map([
  [0, 'issei Sangyo'], [1059, 'AcerView'], [1138, 'Acer'], [1139, 'CS'], [1140, 'arga'], [1161, 'ADI Corporation'],
  [1507, 'AOC'], [1475, 'International (USA) Ltd.'], [1545, 'Acer'], [1552, 'Apple Computer, Inc.'], [1620, 'SmatMedia'],
  [1652, 'AST Research'], [2631, 'Bridge Information'], [3184, 'Epson'], [3596, 'Compal Electronics Inc / ALFA'],
  [3601, 'COMPAQ'], [3736, 'CTX - Chuntex Electronic Co'], [4259, 'Digital Equipment Corporation'],
  [4268, 'Dell Computer Corp.'], [4611, 'Delta Electronics, Inc.'], [4837, 'Daewoo Telecom Ltd'],
  [5235, 'ELITEGROUP Computer systems'], [5386, 'Epson'], [5434, 'EIZO'], [5523, 'LSA'], [5641, 'Nvision'],
  [6253, 'Funai Electric Company of Taiwan'], [6826, 'Fujitsu'], [7789, 'LG Electronics Inc.'], [7929, 'Gateway 2000'],
  [8361, 'Hyundai Electronics Industries Co., Ltd.'], [8500, 'Hitachi'], [8812, 'Hansol Electronics'],
  [8835, 'Hitachi Ltd. / Nissei Sangyo America Ltd'], [8944, 'Hewlett Packard'], [9293, 'IBM PC Company'],
  [9324, 'Fujitsu ICL'], [9933, 'dek Iiyama North America, Inc.'], [11411, 'Korea Data Systems'],
  [11459, 'FC Computec / SMILE'], [12653, 'DLAS / AZALEA'], [12747, 'LINK Technologies, Inc.'], [12942, 'Lite-On'],
  [13351, 'MAG Technology Co. Ltd.'], [13368, 'Maxdata Computer GmbH (Belinea)'], [13481, 'Panasonic Comm. & Systems Co.'],
  [13484, 'Mitsubishi Electronics'], [13618, 'Miro Computer Products AG'], [13635, 'ITAC'], [14382, 'NANAO'],
  [14499, 'NEC Technologies, Inc.'], [14827, 'Nokia'], [15753, 'Olivetti'], [15721, 'OKI'], [15913, 'OPTIQUEST'],
  [16453, 'Packard Bell'], [16462, 'Packard Bell'], [16627, 'Princeton Graphics Systems'], [16652, 'PHL'],
  [16770, 'PLB Monitor'], [17043, 'ProView Technology'], [18604, 'Relisys'], [19501, 'Samsung Corporation'],
  [19593, 'Samtron'], [19619, 'Seiko Epson'], [19704, 'SGI (Silicon Graphics)'], [19746, 'Sanyo'], [19881, 'mile'],
  [19884, 'mile'], [19913, 'Siemens Nixdorf'], [19929, 'Sony Corporation'], [19988, 'Sceptre'],
  [20035, 'Shamrock Technology'], [20099, 'Sampo Technology'], [20112, 'Sceptre'], [20268, 'Sylvania'],
  [20532, 'Tatung Co. of America, Inc.'], [20536, 'Taxan'], [20589, 'Techmedia'], [20641, 'Teac'], [20979, 'Toshiba'],
  [21068, 'Royal Information Company'], [21090, 'Toshiba, Inc'], [21197, 'TVM Monitor'], [21965, 'Unisys Corporation'],
  [22707, 'Vestel'], [23139, 'ViewSonic Corporation'], [24195, 'Wen Technology'], [26733, 'Zenith Data Systems'],
]);

/** .NET custom format "0.##"/"0.###": fixed decimals, trailing zeros removed, culture separator. */
function netFixed(value: number, decimals: number, sep: string): string {
  let s = value.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s.replace('.', sep);
}

/** DisplayID (block tag 0x70) type-I timings, EDID256Block.method_1 (its loop quirks included). */
function displayIdTimings(block: Uint8Array): string[] {
  const out: string[] = [];
  for (let i = 4; i < 127 && block[i] === 3 && i + 2 < block.length; ) {
    const n = block[i + 2];
    if (n === 0) break;
    for (let j = 0; j < Math.floor(n / 20); j++) {
      const at = i + 3 + j * 20;
      if (at + 13 < block.length) out.push(`${((block[at + 5] << 8) | block[at + 4]) + 1}x${((block[at + 13] << 8) | block[at + 12]) + 1}`);
    }
    i += n;
  }
  return out;
}

/** FnRecXRecY for PHL/AOC/ENV/AMZ panels (method_2/method_3): widest DisplayID timing, else DTD #1. */
function recommendedTiming(raw: Uint8Array, dtd: string): string {
  const candidates: string[] = [];
  if (raw.length >= 3 * EDID_BLOCK && raw[2 * EDID_BLOCK] === 0x70) {
    for (let i = 0; i < raw.length; i += EDID_BLOCK) {
      if (raw[i] === 0x02) candidates.push(dtd);
      else if (raw[i] === 0x70) {
        const shifted = new Uint8Array(EDID_BLOCK);
        shifted.set(raw.subarray(i + 1, i + EDID_BLOCK));
        candidates.push(...displayIdTimings(shifted));
      }
    }
  }
  let best = dtd;
  let widest = 0;
  for (const c of candidates) {
    const parts = c.split('x');
    const w = parts.length === 2 && /^\d+$/.test(parts[0]) ? Number(parts[0]) : NaN;
    if (w > widest) {
      widest = w;
      best = c;
    }
  }
  return best;
}

/**
 * Decimal separator of the process locale, the Linux stand-in for .NET CurrentCulture (20 D5):
 * the first of LC_ALL, LC_NUMERIC, LANG, mapped to a BCP-47 tag ("de_DE.UTF-8" → "de-DE"), then ICU.
 * "C"/"POSIX", unset or unknown locales give ".".
 */
export function localeDecimalSeparator(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = env.LC_ALL || env.LC_NUMERIC || env.LANG || '';
  const tag = raw.split('.')[0].split('@')[0].replace(/_/g, '-');
  if (!tag || tag === 'C' || tag === 'POSIX') return '.';
  try {
    return new Intl.NumberFormat(tag).formatToParts(1.5).find((p) => p.type === 'decimal')?.value ?? '.';
  } catch {
    return '.';
  }
}

/**
 * The strings EDID256Block produces for DisplayEDIDInfo (20 D4, §3.3), e.g. for the user's monitor:
 * PHL / Week01-2025 / PHLC29F / PHL 34M2C8600 / <13-character serial> / 1.4 / ~34,2" / 3440x1440 / 2,2 /
 * DIGITAL / Rx0,689-Ry0,303 / ... with `decimalSeparator` ','. The vendor formats with the Windows
 * user's culture; pass localeDecimalSeparator() or the user's setting. sSerialNumber is the EDID serial
 * with non-ASCII characters removed (MonitorUtil.smethod_9).
 */
export function edidDisplayStrings(edid: EdidDetails, decimalSeparator = '.'): DisplayEdidStrings {
  const raw = edid.raw;
  const key = raw[9] + raw[8] * 256;
  let manufacturerName = MANUFACTURER_NAMES.get(key) ?? '';
  if (!manufacturerName) {
    // Vendor bug kept for parity: int additions are appended as decimal numbers, then the PnP id.
    manufacturerName = `${64 + ((key >> 8) >> 2)}${(64 + ((((key >> 8) & 3) << 3) & 0xf8)) | (((key & 0xff) >> 5) & 0x1f)}${64 + (key & 0x1f)}${edid.pnpId}`;
  }
  const dtd = (raw[24] & 2) !== 0
    ? `${raw[56] + ((raw[58] >> 4) & 0xf) * 256}x${raw[59] + ((raw[61] >> 4) & 0xf) * 256}`
    : '';
  const branded = ['AOC', 'ENV', 'AMZ', 'PHL'].some((b) => edid.pnpId.toUpperCase().includes(b));
  const gamma = Math.fround(Math.fround(raw[23] / 100) + 1);
  const size = Math.sqrt((raw[21] * 10) ** 2 + (raw[22] * 10) ** 2) * 0.03937007;
  const c = edid.chromaticity;
  const f = (v: number) => netFixed(v / 1024, 3, decimalSeparator);
  return {
    sManufacturer: manufacturerName,
    sManufacturerDate: `Week${String(raw[16]).padStart(2, '0')}-${String(1990 + raw[17]).padStart(2, '0')}`,
    PlugAndPlayID: edid.pnpId,
    sMonitorName: edid.monitorName,
    sSerialNumber: edid.serialString,
    sVersion: `${raw[18]}.${raw[19]}`,
    ScreenSize: `~${size.toFixed(1).replace('.', decimalSeparator)}"`,
    TimingRecommandation: branded ? recommendedTiming(raw, dtd) : dtd,
    DisplayGamma: netFixed(Number(gamma.toPrecision(7)), 2, decimalSeparator),
    DisplayTypeAndSignal: (raw[20] & 0x80) === 0 ? 'ANALOG' : 'DIGITAL',
    RedChromaticity: `Rx${f(c.rx)}-Ry${f(c.ry)}`,
    GreenChromaticity: `Gx${f(c.gx)}-Gy${f(c.gy)}`,
    BlueChromaticity: `Bx${f(c.bx)}-By${f(c.by)}`,
    WhitePoint: `Wx${f(c.wx)}-Wy${f(c.wy)}`,
  };
}
