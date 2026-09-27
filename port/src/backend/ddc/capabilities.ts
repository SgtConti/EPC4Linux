// MCCS capability string: fragment reader (F3/E3), a structural parser, and an exact port of the
// vendor's VCP-list parser ComUtil.AnalyseVcpString (06 §4.8), which the monitor model depends on.

import type { Logger } from '../types.ts';
import type { CapsFragment } from './codec.ts';
import { DdcError, errorText, isBusy } from './errors.ts';

// ───────────────────────────── fragment reader (08 §3.5, 07 §4.8.5) ─────────────────────────────

export interface CapsReaderOptions {
  /** Failed fetches tolerated per fragment before giving up (vendor hub: 3; counter reset after each success). */
  retries?: number;
  /**
   * Vendor stop rule (08 §3.5): the hub stops after a fragment with fewer than 26 data bytes. We keep
   * reading until the MCCS end marker (an empty fragment), and use this rule only as a fallback: when the
   * fragment after a short one cannot be read, the string read so far is accepted as complete.
   */
  shortFragment?: number;
  /** Upper bound on the assembled string, protects against a monitor that never sends the end marker. */
  maxLength?: number;
  log?: Logger;
}

const CAPS_DEFAULTS = { retries: 3, shortFragment: 26, maxLength: 8192 } as const;

/** Reads the fragment at `offset` (one validated F3 request/E3 reply exchange). */
export type CapsFetch = (offset: number) => Promise<CapsFragment>;

/**
 * Standard MCCS algorithm (08 §3.5 recommendation, 07 §8.4-H, 20 §2.6): request F3 at `offset`, append
 * all fragment data, advance by the fragment's data length, and stop on an empty fragment or as soon as
 * the outer parentheses balance. The vendor quirks (hub: fragment capped at 27 bytes, stop below 26;
 * DDCHelper: drop a final fragment shorter than 10 bytes) are not reproduced, except the short-fragment
 * stop as a fallback (see options).
 */
export async function readCapabilityString(fetch: CapsFetch, options: CapsReaderOptions = {}): Promise<string> {
  const retries = options.retries ?? CAPS_DEFAULTS.retries;
  const shortFragment = options.shortFragment ?? CAPS_DEFAULTS.shortFragment;
  const maxLength = options.maxLength ?? CAPS_DEFAULTS.maxLength;
  let offset = 0;
  let text = '';
  let lastWasShort = false;
  for (;;) {
    let fragment: CapsFragment | undefined;
    for (let failures = 0; fragment === undefined; ) {
      try {
        fragment = await fetch(offset);
      } catch (e) {
        if (isBusy(e)) throw e; // another process holds the monitor; retrying cannot help
        failures++;
        if (failures > retries) {
          if (lastWasShort && text.length > 0) {
            options.log?.debug(`capabilities: no fragment at offset ${offset} after a short one; accepting ${text.length} bytes (vendor stop rule)`);
            return text;
          }
          throw e instanceof DdcError ? e : new DdcError('io', `capabilities read failed at offset ${offset}: ${errorText(e)}`);
        }
        options.log?.debug(`capabilities: fragment ${offset} failed (${failures}/${retries + 1}): ${errorText(e)}`);
      }
    }
    if (fragment.offset !== offset) {
      options.log?.warn(`capabilities: fragment offset echo ${fragment.offset} != requested ${offset}`);
    }
    if (fragment.length === 0) return text;
    text += fragment.text;
    if (text.length > maxLength) throw new DdcError('invalid-reply', `capability string longer than ${maxLength} bytes`);
    if (isCompleteGroup(text)) return text;
    offset += fragment.length;
    lastWasShort = fragment.length < shortFragment;
  }
}

/**
 * 20 §2.6 step 3: a string wrapped in one outer "( ... )" group is complete once that group closes at
 * its last non-blank character, so the end marker need not be requested.
 */
function isCompleteGroup(text: string): boolean {
  const s = text.trim();
  return s.startsWith('(') && matchParen(s, 0) === s.length - 1;
}

// ───────────────────────────── structural parser ─────────────────────────────

export interface CapValue {
  value: number;
  /** Nested value list, e.g. `14(05 08(01 02))`; absent when the value has none. */
  children?: CapValue[];
}

export interface VcpCapability {
  /** Code as a number; TPV extended codes are 3 bytes, e.g. 0xE2A019. */
  code: number;
  /** Code as written in the string, upper case, e.g. "E2A019". */
  hex: string;
  /** Flat list of the direct values, in string order, duplicates removed. */
  values: number[];
  /** Full value tree including nested lists. */
  tree: CapValue[];
}

export interface CapSegment {
  /** Segment name, lower case (e.g. "vcp", "mccs_ver"). */
  name: string;
  /** Raw content between the segment's parentheses. */
  content: string;
}

export interface Capabilities {
  raw: string;
  prot?: string;
  type?: string;
  model?: string;
  mccsVer?: string;
  cmds: number[];
  vcp: VcpCapability[];
  segments: CapSegment[];
  warnings: string[];
}

const SPACE = /\s/;

/** Index of the parenthesis closing the one at `open`, or -1 if unbalanced. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

function splitSegments(raw: string, warnings: string[]): CapSegment[] {
  let s = raw.trim();
  if (s.startsWith('(') && matchParen(s, 0) === s.length - 1) s = s.slice(1, -1);
  const segments: CapSegment[] = [];
  let i = 0;
  while (i < s.length) {
    if (SPACE.test(s[i])) { i++; continue; }
    const m = /^[A-Za-z0-9_]+/.exec(s.slice(i));
    if (!m) {
      warnings.push(`unexpected character '${s[i]}' at ${i}`);
      i++;
      continue;
    }
    const name = m[0].toLowerCase();
    i += m[0].length;
    while (i < s.length && SPACE.test(s[i])) i++;
    if (s[i] !== '(') {
      warnings.push(`segment "${name}" has no value`);
      segments.push({ name, content: '' });
      continue;
    }
    const close = matchParen(s, i);
    if (close < 0) {
      warnings.push(`segment "${name}" is not closed`);
      segments.push({ name, content: s.slice(i + 1) });
      break;
    }
    segments.push({ name, content: s.slice(i + 1, close) });
    i = close + 1;
  }
  return segments;
}

interface RawItem { token: string; group?: string }

/** Tokens with an optional attached `(...)` group; tokens end at whitespace or parentheses. */
function scanItems(s: string, warnings: string[]): RawItem[] {
  const items: RawItem[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (SPACE.test(c)) { i++; continue; }
    if (c === ')') { warnings.push(`stray ')' at ${i}`); i++; continue; }
    if (c === '(') {
      const close = matchParen(s, i);
      const group = close < 0 ? s.slice(i + 1) : s.slice(i + 1, close);
      const prev = items[items.length - 1];
      if (prev && prev.group === undefined) prev.group = group;
      else warnings.push(`value list without a code at ${i}`);
      i = close < 0 ? s.length : close + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !SPACE.test(s[j]) && s[j] !== '(' && s[j] !== ')') j++;
    items.push({ token: s.slice(i, j) });
    i = j;
  }
  return items;
}

const HEX_EVEN = /^(?:[0-9A-Fa-f]{2})+$/;

/** Split "0204" into ["02","04"] (strings without spaces, like the vendor's space insertion). */
function pairs(token: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < token.length; i += 2) out.push(token.slice(i, i + 2));
  return out;
}

function parseValueList(s: string, spaced: boolean, warnings: string[]): CapValue[] {
  const out: CapValue[] = [];
  for (const item of scanItems(s, warnings)) {
    if (!HEX_EVEN.test(item.token)) {
      warnings.push(`invalid value "${item.token}"`);
      continue;
    }
    const bytes = spaced && item.token.length === 2 ? [item.token] : pairs(item.token);
    if (spaced && item.token.length !== 2) warnings.push(`multi-byte value "${item.token}" split into bytes`);
    bytes.forEach((b, k) => {
      const v: CapValue = { value: parseInt(b, 16) };
      if (k === bytes.length - 1 && item.group !== undefined) v.children = parseValueList(item.group, spaced, warnings);
      out.push(v);
    });
  }
  return out;
}

function parseVcpSegment(content: string, into: VcpCapability[], warnings: string[]): void {
  // Like the vendor: multi-byte codes (E2A0xx) are only recognised when the list uses spaces.
  const spaced = content.includes(' ');
  for (const item of scanItems(content, warnings)) {
    if (!HEX_EVEN.test(item.token)) {
      warnings.push(`invalid VCP code "${item.token}"`);
      continue;
    }
    const codes = spaced ? [item.token] : pairs(item.token);
    codes.forEach((hex, k) => {
      if (hex.length > 8) {
        warnings.push(`VCP code "${hex}" too long`);
        return;
      }
      const tree = k === codes.length - 1 && item.group !== undefined ? parseValueList(item.group, spaced, warnings) : [];
      const code = parseInt(hex, 16);
      if (into.some((v) => v.code === code)) {
        warnings.push(`duplicate VCP code ${hex.toUpperCase()} ignored`);
        return;
      }
      const values: number[] = [];
      for (const v of tree) if (!values.includes(v.value)) values.push(v.value);
      into.push({ code, hex: hex.toUpperCase(), values, tree });
    });
  }
}

/** Structural parse of an MCCS capability string (prot/type/model/cmds/vcp/mccs_ver + any other segment). */
export function parseCapabilities(raw: string): Capabilities {
  const warnings: string[] = [];
  const segments = splitSegments(raw, warnings);
  const caps: Capabilities = { raw, cmds: [], vcp: [], segments, warnings };
  for (const seg of segments) {
    switch (seg.name) {
      case 'prot': caps.prot ??= seg.content.trim(); break;
      case 'type': caps.type ??= seg.content.trim(); break;
      case 'model': caps.model ??= seg.content.trim(); break;
      case 'mccs_ver': caps.mccsVer ??= seg.content.trim(); break;
      case 'cmds':
        for (const v of parseValueList(seg.content, seg.content.includes(' '), warnings)) {
          if (!caps.cmds.includes(v.value)) caps.cmds.push(v.value);
        }
        break;
      case 'vcp': parseVcpSegment(seg.content, caps.vcp, warnings); break;
      default: break;
    }
  }
  return caps;
}

// ───────────────────────────── vendor-compatible VCP map ─────────────────────────────

/** .NET `\s` minus CR/LF, as in the vendor's `((?!(\r|\n))\s)*`. */
function isNetSpaceNoCrLf(c: string): boolean {
  return c === '\t' || c === '\v' || c === '\f' || c === '\u0085' || /\p{Z}/u.test(c);
}

function isNetWhiteSpace(s: string): boolean {
  return /^[\s\u0085]*$/.test(s);
}

/** First "VCP(" whose parenthesised group is balanced (the vendor's balancing-group regex). */
function findVcpGroup(upper: string): string | null {
  for (let at = upper.indexOf('VCP('); at >= 0; at = upper.indexOf('VCP(', at + 1)) {
    const close = matchParen(upper, at + 3);
    if (close >= 0) return upper.slice(at, close + 1);
  }
  return null;
}

/**
 * Port of ComUtil.AnalyseVcpString (work/dotnet-clean/Zeasn.Com.Lib/Zeasn.Com.Lib/ComUtil.cs:124-240,
 * 06 §4.8). Returns the ordered map code → value list, or null where the vendor returns false (no
 * balanced vcp(...) group, or a code longer than 8 hex digits, which overflows int.Parse).
 * Semantics kept on purpose because DataOSD builds the supported-attribute list from it:
 *   - the whole string is upper-cased; only the first balanced VCP(...) group is used;
 *   - if that group has no space, a space is inserted after every 2-hex token, which splits
 *     multi-byte codes (E2A0xx) into separate bytes;
 *   - a sub-list is only used when it is flat; nested sub-lists yield an empty list;
 *   - values must be exactly two hex digits; duplicates inside a list are dropped;
 *   - a repeated code is ignored (the first occurrence wins).
 */
export function analyseVcpString(capString: string | null | undefined): Map<number, number[]> | null {
  if (!capString) return null;
  let text = findVcpGroup(capString.toUpperCase());
  if (text === null) return null;
  if (!text.includes(' ')) text = text.replace(/([0-9A-F]{2}\)?)(?=[^() ])/g, '$1 ');
  const inner = text.slice(4, text.length - 1);
  const map = new Map<number, number[]>();
  let i = 0;
  while (i < inner.length) {
    // (?<majorItem>[^() ]+)(\s-no-CRLF*)(?<subItems>balanced-group?)
    if ('() '.includes(inner[i])) { i++; continue; }
    const start = i;
    while (i < inner.length && !'() '.includes(inner[i])) i++;
    const token = inner.slice(start, i);
    let ws = '';
    while (i < inner.length && (inner[i] === ' ' || isNetSpaceNoCrLf(inner[i]))) ws += inner[i++];
    let group = '';
    if (inner[i] === '(') {
      const close = matchParen(inner, i);
      if (close >= 0) {
        group = inner.slice(i, close + 1);
        i = close + 1;
      }
    }
    // match2: ^(?<majorItem>([\dA-F]{2})+)\s*(?<subItems>group?)(?=[() ]|$) — the token must be an
    // even-length hex run followed only by non-CR/LF whitespace (.NET `$` also matches before a final
    // "\n", so one trailing LF is accepted when nothing follows it).
    const hexRun = /^(?:[0-9A-F]{2})+/.exec(token);
    if (!hexRun) continue;
    const tailOk = (rest: string): boolean =>
      [...rest].every(isNetSpaceNoCrLf) ||
      (group === '' && ws === '' && rest.endsWith('\n') && [...rest.slice(0, -1)].every(isNetSpaceNoCrLf));
    let major = hexRun[0];
    while (major.length > 0 && !tailOk(token.slice(major.length))) major = major.slice(0, -2);
    if (major.length === 0) continue;
    if (major.length > 8) return null;
    const key = parseInt(major, 16) | 0;
    // match3: a flat "(...)" group provides the sub-items; a nested group does not match.
    const flat = group.length >= 2 && !/[()]/.test(group.slice(1, -1)) ? group.slice(1, -1) : '';
    if (!isNetWhiteSpace(flat)) {
      const list: number[] = [];
      for (const tok of flat.split(' ')) {
        if (!/^[0-9A-F]{2}\n?$/.test(tok)) continue;
        const b = parseInt(tok.slice(0, 2), 16);
        if (!list.includes(b)) list.push(b);
      }
      if (!map.has(key)) map.set(key, list);
    } else if (!map.has(key)) {
      map.set(key, []);
    }
  }
  return map;
}
