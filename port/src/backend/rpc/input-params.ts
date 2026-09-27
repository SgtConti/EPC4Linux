// Request envelope Evnia.InputParams (DC/EvniaServe/Evnia/InputParams.cs, 05 §3.2) read with the
// semantics of Extension_Json.JsonDeserialize<InputParams> (DC/Zeasn.Com.Lib/.../Extension_Json.cs:89-127):
// Newtonsoft.Json 13, NullValueHandling.Ignore, and ANY failure → null (the dispatcher then answers
// with the "解析json字符串: …失败" parse error, echoing the ids salvageRequestIds() can still read).
//
// JSON.parse cannot be used: Class0 resolves overloads by Newtonsoft's JTokenType, which tells an
// Integer from a Float by its spelling ("1" vs "1.0" / "1e0"). This module therefore contains a small
// RFC 8259 parser that keeps number lexemes, plus the Newtonsoft conversions for the four properties:
//
//   property      C# type        accepted (anything else makes the whole request fail)
//   functionName  string         string; number → its lexeme; true/false → "true"/"false"   (ReadAsString)
//   requestId     string         same as functionName
//   device        int (def. -1)  integer lexeme within int32; string int.TryParse(NumberStyles.Integer);
//                                "" is read as null                                          (ReadAsInt32)
//   parms         List<JToken>   array; tokens are kept as-is
//   JSON null for any property is skipped (NullValueHandling.Ignore), unknown properties are ignored,
//   property names match exactly or else case-insensitively, a repeated property overwrites, except a
//   repeated `parms` array, which is appended (ObjectCreationHandling.Auto reuses the existing list).
//
// Deviations (documented in docs/port/impl-hub-rpc.md): the lexical grammar is strict JSON, whereas
// Newtonsoft also takes comments, single quotes, NaN/Infinity, hex/octal numbers and a few other
// extensions; and strings are always String tokens, whereas Newtonsoft's default DateParseHandling
// turns ISO-8601 date-time strings into Date tokens that Class0 then rejects as
// "Unsupported parameter type: Date" (a user naming a profile "2026-01-01T10:00:00" would hit that).

export type JTokenType = 'Object' | 'Array' | 'Integer' | 'Float' | 'String' | 'Boolean' | 'Null';

export type JToken =
  | { readonly type: 'Object'; readonly entries: ReadonlyArray<readonly [string, JToken]> }
  | { readonly type: 'Array'; readonly items: readonly JToken[] }
  | { readonly type: 'Integer' | 'Float'; readonly lexeme: string }
  | { readonly type: 'String'; readonly value: string }
  | { readonly type: 'Boolean'; readonly value: boolean }
  | { readonly type: 'Null' };

export interface InputParams {
  device: number;
  functionName: string | null;
  requestId: string | null;
  parms: JToken[] | null;
}

/** Newtonsoft 13 default JsonSerializerSettings.MaxDepth. */
export const MAX_DEPTH = 64;

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;

/** Parse a JSON document into JTokens. Throws SyntaxError on malformed input. */
export function parseJToken(text: string): JToken {
  return new Parser(text).document();
}

/** Deserialize an InputParams request; null when Newtonsoft's JsonDeserialize would have returned null. */
export function parseInputParams(text: string): InputParams | null {
  if (text === '') return null; // string.IsNullOrEmpty → default(T)
  try {
    const root = parseJToken(text);
    if (root.type !== 'Object') return null; // "null" → null; any other root → JsonSerializationException
    const p: InputParams = { device: -1, functionName: null, requestId: null, parms: null };
    for (const [key, value] of root.entries) {
      const prop = matchProperty(key);
      if (prop === null || value.type === 'Null') continue;
      switch (prop) {
        case 'functionName':
          p.functionName = readAsString(value);
          break;
        case 'requestId':
          p.requestId = readAsString(value);
          break;
        case 'device': {
          const device = readAsInt32(value);
          if (device !== null) p.device = device;
          break;
        }
        case 'parms':
          if (value.type !== 'Array') throw new Error('parms is not an array');
          p.parms = p.parms === null ? [...value.items] : [...p.parms, ...value.items];
          break;
      }
    }
    return p;
  } catch {
    return null;
  }
}

/**
 * Port rule (20-backend-host-tail §1.3): the ids of a request that parseInputParams() rejected, read
 * best-effort so that the parse-failure reply still reaches its caller. The renderer takes a reply with
 * RequestId null for a notification, and the caller's promise would never settle (02 §4.6). Same name
 * matching and string conversion as parseInputParams; an id that cannot be read stays null.
 */
export function salvageRequestIds(text: string): { functionName: string | null; requestId: string | null } {
  const ids: { functionName: string | null; requestId: string | null } = { functionName: null, requestId: null };
  let root: JToken;
  try {
    root = parseJToken(text);
  } catch {
    return ids; // not JSON at all: nothing to salvage
  }
  if (root.type !== 'Object') return ids;
  for (const [key, value] of root.entries) {
    const prop = matchProperty(key);
    if (prop !== 'functionName' && prop !== 'requestId') continue;
    const s = stringOf(value);
    if (s !== undefined) ids[prop] = s;
  }
  return ids;
}

/** Integer JToken → C# int as Convert.ToInt32 does it; throws the .NET OverflowException text. */
export function toInt32(lexeme: string): number {
  const n = Number(lexeme);
  if (!(n >= INT32_MIN && n <= INT32_MAX)) throw new RangeError('Value was either too large or too small for an Int32.');
  return n + 0; // normalizes -0
}

// ───────────── Newtonsoft property conversions ─────────────

type Prop = 'device' | 'functionName' | 'requestId' | 'parms';
const PROPS: readonly Prop[] = ['device', 'functionName', 'requestId', 'parms'];

/** JsonPropertyCollection.GetClosestMatchProperty: Ordinal, then OrdinalIgnoreCase. */
function matchProperty(key: string): Prop | null {
  for (const p of PROPS) if (p === key) return p;
  for (const p of PROPS) if (equalsOrdinalIgnoreCase(p, key)) return p;
  return null;
}

function equalsOrdinalIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && upperChar(a[i]) !== upperChar(b[i])) return false;
  }
  return true;
}

/** Per-UTF-16-unit simple upper-casing (a one-to-many mapping such as ß → SS leaves the unit unchanged). */
function upperChar(c: string): string {
  const u = c.toUpperCase();
  return u.length === 1 ? u : c;
}

/** JsonTextReader.ReadAsString; throws for tokens it cannot read as a string. */
function readAsString(t: JToken): string {
  const s = stringOf(t);
  if (s === undefined) throw new Error(`cannot read ${t.type} as string`);
  return s;
}

/** ReadAsString's conversion: numbers keep their spelling, booleans become "true"/"false"; else undefined. */
function stringOf(t: JToken): string | undefined {
  switch (t.type) {
    case 'String':
      return t.value;
    case 'Integer':
    case 'Float':
      return t.lexeme;
    case 'Boolean':
      return t.value ? 'true' : 'false';
    default:
      return undefined;
  }
}

/** JsonTextReader.ReadAsInt32; null means "read as JSON null" (skipped by NullValueHandling.Ignore). */
function readAsInt32(t: JToken): number | null {
  switch (t.type) {
    case 'Integer':
      return toInt32(t.lexeme);
    case 'String': {
      if (t.value === '') return null;
      // int.TryParse(s, NumberStyles.Integer, InvariantCulture): optional white space and sign.
      const m = /^[\t\n\v\f\r ]*([+-]?[0-9]+)[\t\n\v\f\r ]*$/.exec(t.value);
      if (!m) throw new Error(`Could not convert string to integer: ${t.value}`);
      return toInt32(m[1]);
    }
    default:
      throw new Error(`cannot read ${t.type} as Int32`);
  }
}

// ───────────── Lexer/parser ─────────────

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;
const ESCAPES: Readonly<Record<string, string>> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

class Parser {
  readonly #s: string;
  #i = 0;
  #depth = 0;

  constructor(text: string) {
    this.#s = text;
  }

  document(): JToken {
    this.#ws();
    const value = this.#value();
    this.#ws();
    if (this.#i !== this.#s.length) throw this.#error('Additional text encountered after finished reading JSON content');
    return value;
  }

  #value(): JToken {
    const c = this.#s[this.#i];
    switch (c) {
      case '{':
        return this.#object();
      case '[':
        return this.#array();
      case '"':
        return { type: 'String', value: this.#string() };
      case 't':
        this.#literal('true');
        return { type: 'Boolean', value: true };
      case 'f':
        this.#literal('false');
        return { type: 'Boolean', value: false };
      case 'n':
        this.#literal('null');
        return { type: 'Null' };
      default:
        if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.#number();
        throw this.#error(c === undefined ? 'Unexpected end of input' : `Unexpected character ${JSON.stringify(c)}`);
    }
  }

  #object(): JToken {
    this.#enter();
    const entries: [string, JToken][] = [];
    this.#i++; // {
    this.#ws();
    if (this.#s[this.#i] === '}') {
      this.#i++;
    } else {
      for (;;) {
        this.#ws();
        if (this.#s[this.#i] !== '"') throw this.#error('Expected property name');
        const key = this.#string();
        this.#ws();
        this.#expect(':');
        this.#ws();
        entries.push([key, this.#value()]);
        this.#ws();
        if (this.#s[this.#i] === ',') {
          this.#i++;
          continue;
        }
        this.#expect('}');
        break;
      }
    }
    this.#depth--;
    return { type: 'Object', entries };
  }

  #array(): JToken {
    this.#enter();
    const items: JToken[] = [];
    this.#i++; // [
    this.#ws();
    if (this.#s[this.#i] === ']') {
      this.#i++;
    } else {
      for (;;) {
        this.#ws();
        items.push(this.#value());
        this.#ws();
        if (this.#s[this.#i] === ',') {
          this.#i++;
          continue;
        }
        this.#expect(']');
        break;
      }
    }
    this.#depth--;
    return { type: 'Array', items };
  }

  #string(): string {
    const s = this.#s;
    let i = this.#i + 1; // opening quote
    let out = '';
    let run = i;
    for (;;) {
      if (i >= s.length) throw this.#error('Unterminated string');
      const c = s[i];
      if (c === '"') break;
      if (c !== '\\') {
        i++;
        continue;
      }
      out += s.slice(run, i);
      const e = s[i + 1];
      if (e === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw this.#error('Bad unicode escape');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        const decoded = e === undefined ? undefined : ESCAPES[e];
        if (decoded === undefined) throw this.#error('Bad escape sequence');
        out += decoded;
        i += 2;
      }
      run = i;
    }
    out += s.slice(run, i);
    this.#i = i + 1;
    return out;
  }

  #number(): JToken {
    NUMBER.lastIndex = this.#i;
    const m = NUMBER.exec(this.#s);
    if (!m) throw this.#error('Invalid number');
    this.#i += m[0].length;
    // Newtonsoft reads a number with a fraction or exponent as Float, everything else as Integer.
    return { type: m[1] !== undefined || m[2] !== undefined ? 'Float' : 'Integer', lexeme: m[0] };
  }

  #literal(word: string): void {
    if (!this.#s.startsWith(word, this.#i)) throw this.#error('Unexpected token');
    this.#i += word.length;
  }

  #expect(c: string): void {
    if (this.#s[this.#i] !== c) throw this.#error(`Expected ${JSON.stringify(c)}`);
    this.#i++;
  }

  #enter(): void {
    if (++this.#depth > MAX_DEPTH) throw this.#error(`The reader's MaxDepth of ${MAX_DEPTH} has been exceeded`);
  }

  #ws(): void {
    const s = this.#s;
    while (this.#i < s.length) {
      const c = s.charCodeAt(this.#i);
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.#i++;
    }
  }

  #error(msg: string): SyntaxError {
    return new SyntaxError(`${msg} at position ${this.#i}`);
  }
}
