// Newtonsoft.Json-compatible serialization helpers (Zeasn.Com.Lib/Extension_Json.cs).
//
// Windows semantics we reproduce:
//   - 'ui'           JsonSerialize(): every property, nulls included, JsonIgnoreEx attributes NOT applied.
//   - 'uiProfileGet' JsonSerialize(IgnoreUI, bIgnoreNullValue:false): drop [JsonIgnoreEx(IgnoreUI)] members, keep nulls
//                    (used only for Profile_GetDeviceData, EvniaServe/Class0.cs).
//   - 'profile'      files (*.pcenter etc.): drop [JsonIgnoreEx(IgnoreProfile)] members and null values.
// Enums are emitted as integers, byte[] as base64 (Newtonsoft default), key order = C# declaration order.
//
// Entity classes opt in by implementing [toCSharpJson](mode) and returning a plain object whose key
// insertion order is the C# declaration order (derived-class members first, then base-class members,
// as Newtonsoft does for properties declared on the most derived type first... see 12 App. A).

import type { SerializeMode } from '../types.ts';

export const toCSharpJson: unique symbol = Symbol.for('evnia.toCSharpJson') as never;

export interface CSharpSerializable {
  [toCSharpJson](mode: SerializeMode): unknown;
}

function isSerializable(v: unknown): v is CSharpSerializable {
  return typeof v === 'object' && v !== null && typeof (v as Record<symbol, unknown>)[toCSharpJson] === 'function';
}

/** Convert an arbitrary value into a JSON-ready tree following the rules above. */
export function toJsonValue(value: unknown, mode: SerializeMode): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'object') return value;
  if (isSerializable(value)) return toJsonValue(value[toCSharpJson](mode), mode);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map((v) => toJsonValue(v, mode));
  if (value instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of value) {
      const jv = toJsonValue(v, mode);
      if (mode === 'profile' && jv === null) continue;
      o[String(k)] = jv;
    }
    return o;
  }
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const jv = toJsonValue(v, mode);
    if (mode === 'profile' && jv === null) continue;
    o[k] = jv;
  }
  return o;
}

export function serialize(value: unknown, mode: SerializeMode = 'ui'): string {
  return JSON.stringify(toJsonValue(value, mode));
}

/** UTF-8 BOM used by the Windows backend for every persisted JSON file (05 §7). */
export const UTF8_BOM = '﻿';

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Parse JSON the way Newtonsoft's lenient reader tolerates our inputs (BOM, trailing whitespace). */
export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(stripBom(text).trim()) as T;
}
