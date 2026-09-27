// electron-store compatible schema and helpers for `<userData>/config.json`.
//
// Pure module (no Node or Electron imports): the main process uses it to load/persist the file and
// the sandboxed preload uses it to validate writes against its synchronous snapshot, so both sides
// reject exactly the same values.
//
// Source of truth: vendor schema `Qd` (01 §6, work/app-pretty/main/index.js:9150-9172; identical
// copy `xd` in the preload, 02 §2.2). Linux changes, all documented in docs/port/impl-electron-shell.md:
//   - autoUpdate / automaticUpdate default to false and are pinned there: the port has no updater (01 §12).
//   - skipLoginState defaults to true and is pinned: there is no cloud login (02 §L.3 P6).
//   - autoStartup defaults to false (01 port plan 6): a fresh install does not add itself to the
//     session autostart until the user enables it; an explicit value from an existing file is kept.
//   - userInfo / email / password / latestSoftwareInfo are cloud-only and never persisted (01 port plan 1).
//   - linuxExperimental (port-only, not in `Qd`): the port's opt-in experiments, {"eneFrameBurst": boolean} = the
//     Ambiglow page's "Fast LED upload (experimental)" checkbox. Typed as an object, no default: a file without it
//     loads unchanged and means "off". The Windows app ignores it (electron-store keeps unknown keys, like the
//     installer's languageTemp).

export type StoreValueType = 'string' | 'number' | 'boolean' | 'object';

export interface StoreKeySpec {
  type: StoreValueType;
  default?: unknown;
}

/** noticeSound values (vendor enum `Jd`, 01 §4). */
export const NOTICE_SOUND = { SystemSound: 0, NoSound: 1 } as const;
/** noticeStyle values (vendor enum `Yd`, 01 §4). */
export const NOTICE_STYLE = { Persistent: 0, Short: 1, No: 2 } as const;

export const STORE_SCHEMA: Readonly<Record<string, StoreKeySpec>> = {
  language: { type: 'string', default: 'en' },
  dashboardPreview: { type: 'object', default: {} },
  dashboardPreviewEnable: { type: 'boolean', default: true },
  dashboardLocation: { type: 'number' },
  autoStartup: { type: 'boolean', default: false },
  autoStartupMinimize: { type: 'boolean', default: true },
  noticeSwitch: { type: 'boolean', default: false },
  noticeSound: { type: 'number', default: NOTICE_SOUND.SystemSound },
  noticeStyle: { type: 'number', default: NOTICE_STYLE.Persistent },
  autoUpdate: { type: 'boolean', default: false },
  latestSoftwareInfo: { type: 'object' },
  ignoreVersion: { type: 'string' },
  automaticUpdate: { type: 'boolean', default: false },
  tutorials: { type: 'object' },
  userInfo: { type: 'object' },
  email: { type: 'string' },
  password: { type: 'string' },
  skipLoginState: { type: 'boolean', default: true },
  mainWindowBounds: { type: 'object' },
  overviewType: { type: 'string', default: 'category' },
  ambiScapeEnable: { type: 'boolean', default: false },
  // Linux port only (see the header); no default, so an existing config.json is not rewritten for it.
  linuxExperimental: { type: 'object' },
};

/** config.json key of the port's experiments ({"eneFrameBurst": boolean}); not a vendor key. */
export const EXPERIMENTAL_KEY = 'linuxExperimental';
/** The "Fast LED upload (experimental)" setting (ENE frame burst, impl-usb-ene §2.2): true = on; missing = off. */
export const ENE_FRAME_BURST_KEY = `${EXPERIMENTAL_KEY}.eneFrameBurst`;

/** Keys pinned to a fixed value on Linux: no self-updater and no cloud account exist. */
export const FORCED_VALUES: Readonly<Record<string, unknown>> = {
  autoUpdate: false,
  automaticUpdate: false,
  skipLoginState: true,
};

/** Cloud-only keys: removed on load, writes are refused (never reach disk). */
export const STRIPPED_KEYS: readonly string[] = ['userInfo', 'email', 'password', 'latestSoftwareInfo'];

/** electron-store's reserved key; it holds `migrations.version` and cannot be written by callers. */
export const INTERNAL_KEY = '__internal__';

/** Vendor application version the renderer and the store metadata expect (01 §1, `tm`). */
export const VENDOR_APP_VERSION = '1.13.0';

export type StoreData = Record<string, unknown>;

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Split an electron-store (dot-prop) key path. Returns null for keys dot-prop would refuse. */
export function splitKeyPath(key: string): string[] | null {
  if (typeof key !== 'string' || key.length === 0) return null;
  const parts = key.split('.');
  if (parts.some((p) => p.length === 0 || FORBIDDEN_SEGMENTS.has(p))) return null;
  return parts;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function matchesType(value: unknown, type: StoreValueType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isPlainObject(value);
  }
}

/** Deep copy of JSON data (the store only ever holds JSON values). */
export function cloneJson<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function getPath(data: StoreData, key: string): unknown {
  const parts = splitKeyPath(key);
  if (!parts) return undefined;
  let cur: unknown = data;
  for (const p of parts) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, p)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Set `key` (dot path) in place, creating intermediate objects like dot-prop does. */
export function setPath(data: StoreData, key: string, value: unknown): void {
  const parts = splitKeyPath(key);
  if (!parts) throw new TypeError(`Invalid store key: ${String(key)}`);
  let cur: Record<string, unknown> = data;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

/** Delete `key` (dot path) in place; returns true when something was removed. */
export function deletePath(data: StoreData, key: string): boolean {
  const parts = splitKeyPath(key);
  if (!parts) return false;
  let cur: unknown = data;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, p)) return false;
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (!isPlainObject(cur) || !Object.hasOwn(cur, last)) return false;
  delete cur[last];
  return true;
}

/**
 * Why a write of `value` at `key` must be refused, or null when it is acceptable.
 * Mirrors electron-store: `undefined` is not storable (use delete), `__internal__` is reserved, and the
 * top-level key touched must still satisfy the schema after the change.
 */
export function writeError(key: string, value: unknown): string | null {
  const parts = splitKeyPath(key);
  if (!parts) return `Invalid store key: ${String(key)}`;
  const top = parts[0];
  if (top === INTERNAL_KEY) return `Please don't use the ${INTERNAL_KEY} key, as it's used to manage this module internally.`;
  if (value === undefined) return 'Use `delete()` to clear values';
  if (STRIPPED_KEYS.includes(top)) return `\`${top}\` is not stored by the offline Linux port`;
  const spec = STORE_SCHEMA[top];
  if (spec && parts.length === 1 && !matchesType(value, spec.type)) {
    return `Config schema violation: \`${top}\` must be ${spec.type}`;
  }
  if (spec && parts.length > 1 && spec.type !== 'object') {
    return `Config schema violation: \`${top}\` must be ${spec.type}`;
  }
  return null;
}

/** Value actually stored for `key`: pinned keys always keep their forced value. */
export function coerceForced(key: string, value: unknown): unknown {
  return Object.hasOwn(FORCED_VALUES, key) ? FORCED_VALUES[key] : value;
}

/**
 * Normalize freshly loaded data: drop cloud keys and schema violations, add missing defaults,
 * pin forced keys and stamp electron-store's migration version. Returns the list of changes
 * (for logging); `data` is modified in place and keeps its existing key order.
 */
export function normalizeStoreData(data: StoreData): string[] {
  const changes: string[] = [];
  for (const key of STRIPPED_KEYS) {
    if (Object.hasOwn(data, key)) {
      delete data[key];
      changes.push(`removed cloud key ${key}`);
    }
  }
  for (const [key, spec] of Object.entries(STORE_SCHEMA)) {
    if (Object.hasOwn(data, key) && !matchesType(data[key], spec.type)) {
      delete data[key];
      changes.push(`dropped ${key} (not a ${spec.type})`);
    }
    if (!Object.hasOwn(data, key) && spec.default !== undefined) {
      data[key] = cloneJson(spec.default);
      changes.push(`default ${key}`);
    }
  }
  for (const [key, forced] of Object.entries(FORCED_VALUES)) {
    if (data[key] !== forced) {
      data[key] = forced;
      changes.push(`pinned ${key}=${String(forced)}`);
    }
  }
  const internal = isPlainObject(data[INTERNAL_KEY]) ? (data[INTERNAL_KEY] as Record<string, unknown>) : null;
  const migrations = internal && isPlainObject(internal.migrations) ? (internal.migrations as Record<string, unknown>) : null;
  if (!migrations || typeof migrations.version !== 'string') {
    data[INTERNAL_KEY] = { ...(internal ?? {}), migrations: { ...(migrations ?? {}), version: VENDOR_APP_VERSION } };
    changes.push('stamped migrations.version');
  }
  return changes;
}

/** electron-store/conf default serialization (tab indentation, no trailing newline). */
export function serializeStore(data: StoreData): string {
  return JSON.stringify(data, undefined, '\t');
}
