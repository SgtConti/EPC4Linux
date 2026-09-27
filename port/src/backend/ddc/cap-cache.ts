// Capability-string cache `EvniaServe/Config/data.json`, byte-compatible with the Windows backend
// (06 §4.8, 05 summary). Ports:
//   - SerializedFileUtil.SaveTXTConfigWithSign / LoadTXTConfigWithSign (Zeasn.Com.Lib/SerializedFileUtil.cs)
//   - HmacSha1Util.HmacSha256Encrypt / HmacSha256Verify (key and message UTF-8, digest base64)
//   - CacheVcpMgr (Zeasn.PCenter.Base.Lib/CacheVcpMgr.cs): lookup/save/delete/reset semantics
// File = UTF-8 BOM + {"data":"<List<CacheDisplayInfo> as JSON>","sign":"<base64 HMAC-SHA256(data)>"}.
// The inner JSON is Newtonsoft's default output: no whitespace, declaration order Name, Datas / Key, Vcp.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger, VcpValue } from '../types.ts';
import { Mutex } from '../core/events.ts';
import { UTF8_BOM, stripBom } from '../core/json.ts';
import { hex2 } from './codec.ts';
import { errorText } from './errors.ts';

/** Hard-coded HMAC key of SerializedFileUtil (sic, "Serizlize"). */
export const CAP_CACHE_HMAC_KEY = 'WhaleTV_Serizlize_2026';

/** CacheDisplayItem: one capability string for one (firmware version, input) key. */
export interface CapCacheItem {
  Key: string;
  Vcp: string;
}

/** CacheDisplayInfo: all cached strings of one EDID model name (e.g. "PHL 34M2C8600"). */
export interface CapCacheDisplay {
  Name: string;
  Datas: CapCacheItem[] | null;
}

export function capCacheSign(data: string): string {
  return createHmac('sha256', Buffer.from(CAP_CACHE_HMAC_KEY, 'utf8')).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** HmacSha256Verify: constant-time compare of the decoded signature; malformed base64 fails. */
export function capCacheVerify(data: string, sign: string): boolean {
  const expected = createHmac('sha256', Buffer.from(CAP_CACHE_HMAC_KEY, 'utf8')).update(Buffer.from(data, 'utf8')).digest();
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(sign) || sign.length % 4 !== 0) return false;
  const given = Buffer.from(sign, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Newtonsoft also escapes NEL, LINE SEPARATOR and PARAGRAPH SEPARATOR (JavaScriptUtils, lower-case hex). */
const NET_EXTRA_ESCAPES = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');

/** Newtonsoft default string escaping: JSON.stringify plus the three characters above. */
function netString(s: string): string {
  return JSON.stringify(s).replace(NET_EXTRA_ESCAPES, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** JsonSerialize() of List<CacheDisplayInfo> exactly as the vendor writes it into "data". */
export function serializeCapCacheData(list: readonly CapCacheDisplay[]): string {
  const item = (i: CapCacheItem) => `{"Key":${netString(i.Key)},"Vcp":${netString(i.Vcp)}}`;
  const display = (d: CapCacheDisplay) =>
    `{"Name":${netString(d.Name)},"Datas":${d.Datas === null ? 'null' : `[${d.Datas.map(item).join(',')}]`}}`;
  return `[${list.map(display).join(',')}]`;
}

/** Complete file content (with BOM) as written by SaveTXTConfigWithSign. */
export function encodeCapCacheFile(list: readonly CapCacheDisplay[]): string {
  const data = serializeCapCacheData(list);
  return `${UTF8_BOM}{"data":${netString(data)},"sign":${netString(capCacheSign(data))}}`;
}

export type CapCacheDecode =
  | { status: 'signed' | 'legacy'; list: CapCacheDisplay[] }
  | { status: 'empty' | 'bad-signature' | 'invalid'; list: null; reason?: string };

/** Newtonsoft binds properties case-insensitively; missing members keep the C# defaults ("" / []). */
function prop(o: Record<string, unknown>, name: string): unknown {
  const key = Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : o[key];
}

function asText(v: unknown): string {
  return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

function toList(value: unknown): CapCacheDisplay[] {
  if (!Array.isArray(value)) throw new Error('cache data is not a list');
  return value.map((d) => {
    if (d === null || typeof d !== 'object') throw new Error('cache entry is not an object');
    const datas = prop(d as Record<string, unknown>, 'Datas');
    let items: CapCacheItem[] | null;
    if (datas === null) items = null;
    else if (datas === undefined) items = [];
    else if (Array.isArray(datas)) {
      items = datas.map((i) => {
        if (i === null || typeof i !== 'object') throw new Error('cache item is not an object');
        const r = i as Record<string, unknown>;
        return { Key: asText(prop(r, 'Key')), Vcp: asText(prop(r, 'Vcp')) };
      });
    } else throw new Error('Datas is not a list');
    return { Name: asText(prop(d as Record<string, unknown>, 'Name')), Datas: items };
  });
}

/**
 * LoadTXTConfigWithSign: a {data, sign} wrapper must verify, otherwise the file is ignored (the vendor
 * then starts from an empty list and overwrites it on the next save). A file without a wrapper is an
 * "old version config" and is accepted unsigned.
 */
export function decodeCapCacheFile(text: string): CapCacheDecode {
  const body = stripBom(text);
  if (body.trim() === '') return { status: 'empty', list: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return { status: 'invalid', list: null, reason: errorText(e) };
  }
  try {
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const data = prop(parsed as Record<string, unknown>, 'data');
      const sign = prop(parsed as Record<string, unknown>, 'sign');
      if (typeof data === 'string' && typeof sign === 'string' && data.trim() !== '' && sign.trim() !== '') {
        if (!capCacheVerify(data, sign)) return { status: 'bad-signature', list: null };
        return { status: 'signed', list: toList(JSON.parse(data)) };
      }
    }
    return { status: 'legacy', list: toList(parsed) };
  } catch (e) {
    return { status: 'invalid', list: null, reason: errorText(e) };
  }
}

/** Cache key `lower("<FW version>_<VCP 60 low byte %02X>")`, e.g. "v1.01_0f" (Display.method_0, 06 §4.8). */
export function capCacheKey(fwVersion: string, inputSource: VcpValue | number): string {
  const value = typeof inputSource === 'number' ? inputSource : inputSource.value;
  return `${fwVersion}_${hex2(value & 0xff)}`.toLowerCase();
}

/** CacheVcpMgr: in-memory list backed by the signed file; every mutation rewrites the file. */
export class CapabilityCache {
  readonly filePath: string;
  #list: CapCacheDisplay[] = [];
  readonly #log: Logger | undefined;
  readonly #writes = new Mutex();

  constructor(filePath: string, log?: Logger) {
    this.filePath = filePath;
    this.#log = log;
  }

  /** Load the file; a missing, empty, unverifiable or malformed file yields an empty cache. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.#log?.warn(`capability cache unreadable: ${errorText(e)}`);
      this.#list = [];
      return;
    }
    const decoded = decodeCapCacheFile(text);
    if (decoded.list === null) {
      if (decoded.status === 'bad-signature') this.#log?.error('capability cache signature check failed; ignoring file');
      else if (decoded.status === 'invalid') this.#log?.warn(`capability cache invalid: ${decoded.reason ?? ''}`);
      this.#list = [];
      return;
    }
    if (decoded.status === 'legacy') this.#log?.info('capability cache has no signature (old format); accepted');
    this.#list = decoded.list;
  }

  entries(): readonly CapCacheDisplay[] {
    return this.#list;
  }

  /** GetDisplayItem: model name compared case-insensitively, key by case-insensitive substring. */
  get(edidModelName: string, cacheKey: string): string | null {
    if (!cacheKey) return null;
    const display = this.#list.find((x) => x.Name.toLowerCase() === edidModelName.toLowerCase());
    const item = display?.Datas?.find((x) => x.Key.toLowerCase().includes(cacheKey.toLowerCase()));
    return item && item.Vcp ? item.Vcp : null;
  }

  /** SaveDisplayItem: exact (ordinal) matches on name and key; ignored when any argument is empty. */
  async save(edidModelName: string, cacheKey: string, vcp: string): Promise<void> {
    if (!edidModelName || !cacheKey || !vcp) return;
    let display = this.#list.find((x) => x.Name === edidModelName);
    if (!display) {
      display = { Name: edidModelName, Datas: [] };
      this.#list.push(display);
    }
    display.Datas ??= [];
    let item = display.Datas.find((x) => x.Key === cacheKey);
    if (!item) {
      item = { Key: cacheKey, Vcp: '' };
      display.Datas.push(item);
    }
    item.Vcp = vcp;
    await this.#write();
  }

  /** DeleteDisplayItem (the vendor rewrites the file even when nothing was removed). */
  async delete(edidModelName: string): Promise<void> {
    if (!edidModelName) return;
    const index = this.#list.findIndex((x) => x.Name === edidModelName);
    if (index >= 0) this.#list.splice(index, 1);
    await this.#write();
  }

  async reset(): Promise<void> {
    this.#list = [];
    await this.#write();
  }

  /**
   * Atomic replace (the vendor writes in place; a crash could then leave a truncated file). Writes are
   * queued, and each writes the list as it is when its turn comes, so overlapping mutations (two
   * monitors saving during parallel connects, a save racing a Device_Rescan reset) all resolve and the
   * file ends with the final state. The temp name is unique per write, so separate instances on the
   * same path cannot rename each other's temp file away either.
   */
  #write(): Promise<void> {
    return this.#writes.run(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.${++tempSeq}.tmp`;
      try {
        await writeFile(tmp, encodeCapCacheFile(this.#list), 'utf8');
        await rename(tmp, this.filePath);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
    });
  }
}

/** Per-process counter for unique temp file names. */
let tempSeq = 0;
