// Newtonsoft deserialization semantics the vendor relies on when it loads a ProfileContent string or
// clones an entity (Extension_Json.JsonDeserialize with NullValueHandling.Ignore; ToCloning =
// JsonSerialize() + JsonDeserialize(), COM/Extension_Object.cs:18-29):
//   - property names match exactly, else case-insensitively; unknown members are ignored;
//   - a JSON null (or a missing member) leaves the C# initializer value in place;
//   - existing non-null objects are populated in place (ObjectCreationHandling.Auto), so an
//     AttributeInfo created by a field initializer keeps its VCPOpCodeName when the profile JSON omits it;
//   - integers are accepted for enums, numbers are converted with Convert semantics.
// 20-theme-profile-engine §3.1 (reader rules), 20-enum §1.4 (ToCloning keeps ValueList etc.).

export type JsonObject = Record<string, unknown>;

export function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Member lookup: exact name first, then case-insensitive (Newtonsoft). JSON null reads as undefined. */
export function member(obj: JsonObject, name: string): unknown {
  if (Object.hasOwn(obj, name)) return obj[name] ?? undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k] ?? undefined;
  return undefined;
}

/** Convert.ToInt32 of a JSON scalar (Value is `object` in C#; the vendor calls .ToInt32() on it). */
export function toInt(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10);
  return undefined;
}

/** Zeasn `object.ToInt32()`: null and unconvertible values give 0. */
export function asInt32(v: unknown): number {
  return toInt(v) ?? 0;
}

export function toBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (t === 'true') return true;
    if (t === 'false') return false;
  }
  return undefined;
}

export function toStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

/** Parse a nested JSON string the way LoadTXTConfig/JsonDeserialize does: BOM stripped, failures → null. */
export function parseJsonObject(text: string | null | undefined): JsonObject | null {
  if (text === null || text === undefined) return null;
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed === '') return null;
  try {
    const v: unknown = parseJsonOrdered(trimmed);
    return isJsonObject(v) ? v : null;
  } catch {
    return null;
  }
}

// ───────────────────────────── key order of Dictionary<int, …> ─────────────────────────────
//
// Newtonsoft reads and writes a Dictionary<int, T> (SubSmartImages, keyed by the OP_DC value) in insertion
// order, e.g. {"34":…,"33":…} (12 App. A; ARCHITECTURE key rule 1). A JS object always lists integer-like
// keys ascending, whatever the source or insertion order, so JSON.parse and plain objects lose it. The
// order is kept on the side: objects produced by parseJsonOrdered() and by the model's dictionary
// serializer are registered here, and orderedEntries() walks them in that order.

/** Canonical array-index strings: the keys a JS object lists first and ascending. */
const INDEX_KEY = /^(?:0|[1-9]\d*)$/;

const KEY_ORDER = new WeakMap<object, readonly string[]>();

/** Record `keys` as the source/insertion order of `obj` (only kept when an integer-like key makes it matter). */
export function setKeyOrder(obj: object, keys: readonly string[]): void {
  if (keys.some((k) => INDEX_KEY.test(k))) KEY_ORDER.set(obj, [...keys]);
}

/** Object.entries in the recorded source/insertion order when there is one (keys added later go last). */
export function orderedEntries(obj: JsonObject): Array<[string, unknown]> {
  const order = KEY_ORDER.get(obj);
  if (!order) return Object.entries(obj);
  const out: Array<[string, unknown]> = [];
  const seen = new Set<string>();
  for (const k of order) {
    if (Object.hasOwn(obj, k) && !seen.has(k)) {
      seen.add(k);
      out.push([k, obj[k]]);
    }
  }
  for (const [k, v] of Object.entries(obj)) if (!seen.has(k)) out.push([k, v]);
  return out;
}

const SCALAR = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/**
 * JSON.parse (same values, same SyntaxError on invalid input) that also records the source key order of
 * every object with integer-like keys (setKeyOrder). Duplicate keys: the last value wins at the first
 * key's position, as with JSON.parse and Newtonsoft's populate; `__proto__` is an own property.
 */
export function parseJsonOrdered(text: string): unknown {
  let i = 0;
  const fail = (): never => {
    throw new SyntaxError(`Unexpected token in JSON at position ${i}`);
  };
  const ws = (): void => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else return;
    }
  };
  const string = (): string => {
    const start = i;
    i++;
    for (;;) {
      if (i >= text.length) fail();
      const c = text.charCodeAt(i);
      if (c === 0x22) break;
      i += c === 0x5c ? 2 : 1;
    }
    i++;
    // JSON.parse of the token validates escapes and control characters exactly like the full parse.
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): unknown => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: JsonObject = {};
      const keys: string[] = [];
      ws();
      if (text[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = string();
        ws();
        if (text[i] !== ':') fail();
        i++;
        const v = value();
        if (!Object.hasOwn(obj, key)) keys.push(key);
        Object.defineProperty(obj, key, { value: v, writable: true, enumerable: true, configurable: true });
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          break;
        }
        fail();
      }
      setKeyOrder(obj, keys);
      return obj;
    }
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          break;
        }
        fail();
      }
      return arr;
    }
    if (c === '"') return string();
    SCALAR.lastIndex = i;
    const m = SCALAR.exec(text);
    if (!m) return fail();
    i = SCALAR.lastIndex;
    const tok = m[0];
    return tok === 'true' ? true : tok === 'false' ? false : tok === 'null' ? null : Number(tok);
  };
  const result = value();
  ws();
  if (i !== text.length) fail();
  return result;
}
