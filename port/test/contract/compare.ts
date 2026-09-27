// Structural JSON comparison for the contract tests (not a test file itself).
//
// A reply matches its golden value when, recursively:
//   - objects have exactly the same keys in the same order (Newtonsoft writes C# declaration order, and the
//     renderer and persisted files depend on it — 12 §2.2);
//   - every value has the same JSON type (null, boolean, number, string, array, object) — so an enum
//     serialized as a string instead of an int, or null instead of [], is a mismatch;
//   - arrays have the same length;
//   - primitive values are equal (enum ints, Names/Texts, numbers), except at the paths listed in
//     ENVIRONMENT_DEPENDENT, which depend on the machine the backend runs on, not on the port's logic.
// Paths are written like `Tag.ModuleInput.InputSourceList[2].Name`.
//
// Key order and integer-like keys: JSON.parse (and so Object.keys) always lists integer-like keys ("33",
// "34") first and ascending, whatever the text says. Newtonsoft writes a Dictionary<int,…> (e.g.
// ModuleSmartImage(HDR).SubSmartImages, keyed by the OP_DC value) in insertion order, so the order of such
// keys is only visible in the raw text. compareJson therefore takes the raw key orders of both sides
// (jsonKeyOrders(text)) when they are available, and stringifyOrdered() rebuilds the exact expected bytes
// from them. Without raw orders (a parsed value built in a test), the order of integer-like keys is NOT
// checked — every contract assertion on a backend reply passes the reply text's orders.

export type Tolerance =
  /** Any value of the same JSON type. */
  | 'type'
  /** Equal once ',' and '.' are treated as the same decimal separator. */
  | 'decimal-separator';

export interface ToleratedPath {
  readonly path: RegExp;
  readonly tolerance: Tolerance;
  readonly why: string;
}

/**
 * The only fields whose value may differ from the Windows capture. Everything else — keys, key order, types,
 * enum ints, ValueList Names/Texts, values read from the (simulated) monitor and the user's profile — must match.
 */
export const ENVIRONMENT_DEPENDENT: readonly ToleratedPath[] = [
  {
    path: /^Tag\[\d+\]\.ExtDeviceInfo\.DisplayList\[\d+\]\.DeviceName$/,
    tolerance: 'type',
    why: 'UIDisplayInfo.DeviceName is the Windows GDI device (\\\\.\\DISPLAY1, MONITORINFOEX.szDevice); Linux has no such name and reports its own display id. The renderer never reads it (20-backend-host-tail §5 step 3, §9 Q2).',
  },
  {
    path: /(^|\.)DispalyData\.MonitorEDIDInfo_T\.(ScreenSize|DisplayGamma|RedChromaticity|GreenChromaticity|BlueChromaticity|WhitePoint)$/,
    tolerance: 'decimal-separator',
    why: 'EDID256Block formats these with the current culture: the user\'s Windows locale writes "~34,2\\"" and "Rx0,689-Ry0,303"; on Linux the separator follows LC_ALL/LC_NUMERIC/LANG (20-monitor-io-linux-consolidation D5, ddc/edid.ts localeDecimalSeparator).',
  },
];

export interface JsonDiff {
  readonly path: string;
  readonly problem: string;
}

export interface CompareResult {
  readonly diffs: JsonDiff[];
  /** Paths where a tolerance accepted a different value. */
  readonly tolerated: string[];
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

const show = (v: unknown) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 120 ? `${s.slice(0, 117)}...` : s;
};

/** Object key order per path (compareJson path syntax, root ''), as written in a JSON text. */
export type KeyOrders = ReadonlyMap<string, readonly string[]>;

export interface RawOrders {
  /** jsonKeyOrders() of the actual JSON text. */
  readonly actual?: KeyOrders;
  /** jsonKeyOrders() of the expected JSON text (fixtures: golden.ts replyOrder / notificationOrders). */
  readonly expected?: KeyOrders;
}

/**
 * Compare `actual` with `expected` (both parsed JSON) under the rules above. `orders` supplies the raw key
 * order of either side (see the header: needed for integer-like keys); paths it does not cover fall back
 * to Object.keys.
 */
export function compareJson(
  actual: unknown,
  expected: unknown,
  tolerated: readonly ToleratedPath[] = ENVIRONMENT_DEPENDENT,
  root = '',
  orders: RawOrders = {},
): CompareResult {
  const diffs: JsonDiff[] = [];
  const accepted: string[] = [];
  const keysOf = (o: Record<string, unknown>, path: string, raw: KeyOrders | undefined): string[] => orderedKeys(o, raw?.get(path));
  const walk = (a: unknown, e: unknown, path: string): void => {
    const ta = jsonType(a);
    const te = jsonType(e);
    if (ta !== te) {
      diffs.push({ path, problem: `type ${ta} (${show(a)}), expected ${te} (${show(e)})` });
      return;
    }
    if (te === 'array') {
      const aa = a as unknown[];
      const ea = e as unknown[];
      if (aa.length !== ea.length) diffs.push({ path, problem: `length ${aa.length}, expected ${ea.length}` });
      for (let i = 0; i < Math.min(aa.length, ea.length); i++) walk(aa[i], ea[i], `${path}[${i}]`);
      return;
    }
    if (te === 'object') {
      const ao = a as Record<string, unknown>;
      const eo = e as Record<string, unknown>;
      const ak = keysOf(ao, path, orders.actual);
      const ek = keysOf(eo, path, orders.expected);
      const missing = ek.filter((k) => !Object.hasOwn(ao, k));
      const extra = ak.filter((k) => !Object.hasOwn(eo, k));
      if (missing.length) diffs.push({ path, problem: `missing keys ${missing.join(', ')}` });
      if (extra.length) diffs.push({ path, problem: `unexpected keys ${extra.join(', ')}` });
      if (!missing.length && !extra.length && ak.join('\u0000') !== ek.join('\u0000')) {
        diffs.push({ path, problem: `key order ${ak.join(',')}, expected ${ek.join(',')}` });
      }
      for (const k of ek) if (Object.hasOwn(ao, k)) walk(ao[k], eo[k], path ? `${path}.${k}` : k);
      return;
    }
    if (a === e) return;
    const rule = tolerated.find((t) => t.path.test(path));
    if (rule?.tolerance === 'type') {
      accepted.push(path);
      return;
    }
    if (rule?.tolerance === 'decimal-separator' && typeof a === 'string' && typeof e === 'string' && a.replaceAll(',', '.') === e.replaceAll(',', '.')) {
      accepted.push(path);
      return;
    }
    diffs.push({ path, problem: `${show(a)}, expected ${show(e)}` });
  };
  walk(actual, expected, root);
  return { diffs, tolerated: accepted };
}

/** The object's own keys in `raw` order (keys missing from `raw` appended in Object.keys order). */
function orderedKeys(o: Record<string, unknown>, raw: readonly string[] | undefined): string[] {
  const own = Object.keys(o);
  if (!raw) return own;
  const inRaw = raw.filter((k) => Object.hasOwn(o, k));
  const seen = new Set(inRaw);
  return [...inRaw, ...own.filter((k) => !seen.has(k))];
}

/**
 * The key order of every object in a JSON text, by compareJson path — an order-preserving tokenizer, since
 * JSON.parse reorders integer-like keys. Throws SyntaxError on invalid JSON.
 */
export function jsonKeyOrders(text: string): Map<string, string[]> {
  const orders = new Map<string, string[]>();
  const literal = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
  let i = 0;
  const fail = (what: string): never => {
    throw new SyntaxError(`jsonKeyOrders: ${what} at offset ${i}`);
  };
  const skipWs = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i++;
  };
  const readString = (): string => {
    const start = i;
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') i += 2;
      else if (c === '"') {
        i++;
        return JSON.parse(text.slice(start, i)) as string;
      } else i++;
    }
    return fail('unterminated string');
  };
  const readValue = (path: string): void => {
    skipWs();
    const c = text[i];
    if (c === '{') {
      i++;
      const keys: string[] = [];
      orders.set(path, keys);
      skipWs();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        skipWs();
        if (text[i] !== '"') fail('expected a key');
        const key = readString();
        keys.push(key);
        skipWs();
        if (text[i] !== ':') fail('expected ":"');
        i++;
        readValue(path ? `${path}.${key}` : key);
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === '}') {
          i++;
          return;
        }
        fail('expected "," or "}"');
      }
    }
    if (c === '[') {
      i++;
      skipWs();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (let n = 0; ; n++) {
        readValue(`${path}[${n}]`);
        skipWs();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === ']') {
          i++;
          return;
        }
        fail('expected "," or "]"');
      }
    }
    if (c === '"') {
      readString();
      return;
    }
    literal.lastIndex = i;
    const m = literal.exec(text);
    if (!m) fail('unexpected token');
    i += m![0].length;
  };
  readValue('');
  skipWs();
  if (i !== text.length) fail('trailing characters');
  return orders;
}

/** The entries of `orders` at and below `prefix`, re-rooted so that `prefix` becomes ''. */
export function subtreeOrders(orders: KeyOrders, prefix: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [p, keys] of orders) {
    if (prefix === '') out.set(p, [...keys]);
    else if (p === prefix) out.set('', [...keys]);
    else if (p.startsWith(`${prefix}.`)) out.set(p.slice(prefix.length + 1), [...keys]);
    else if (p.startsWith(`${prefix}[`)) out.set(p.slice(prefix.length), [...keys]);
  }
  return out;
}

/** `orders` moved under `prefix` (the inverse of subtreeOrders). */
export function prefixedOrders(orders: KeyOrders, prefix: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [p, keys] of orders) out.set(p === '' ? prefix : p.startsWith('[') || prefix === '' ? `${prefix}${p}` : `${prefix}.${p}`, [...keys]);
  return out;
}

/** Compact JSON of a parsed value with every object's keys in `orders` (JSON.stringify for the rest). */
export function stringifyOrdered(value: unknown, orders?: KeyOrders, path = ''): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v, n) => stringifyOrdered(v === undefined ? null : v, orders, `${path}[${n}]`)).join(',')}]`;
  const o = value as Record<string, unknown>;
  const members = orderedKeys(o, orders?.get(path))
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stringifyOrdered(o[k], orders, path ? `${path}.${k}` : k)}`);
  return `{${members.join(',')}}`;
}

export function formatDiffs(diffs: readonly JsonDiff[], limit = 40): string {
  const lines = diffs.slice(0, limit).map((d) => `  ${d.path || '<root>'}: ${d.problem}`);
  if (diffs.length > limit) lines.push(`  … ${diffs.length - limit} more`);
  return lines.join('\n');
}

/** Read a value at a dotted path such as `ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance`. */
export function at(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
