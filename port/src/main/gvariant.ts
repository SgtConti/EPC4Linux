// Parser for the GVariant text format that `gdbus call` prints (g_variant_print with type annotations,
// https://docs.gtk.org/glib/gvariant-text-format.html). The main process reads two Mutter D-Bus replies
// this way without a D-Bus library: DisplayConfig.GetCurrentState (display-sources.ts, 20-monitor-io §3.5
// source a) and IdleMonitor.GetIdletime (idle-time.ts).
//
// Mapping: tuples and arrays → JS arrays, a dictionary `{k: v, …}` → Map, a lone dict entry `{k, v}` →
// [k, v], a variant `<v>` → v, numbers → number, booleans → boolean, strings (also object paths,
// signatures and byte strings) → string, `nothing` → null, `just v` → v. Type annotations (`uint32 3`,
// `@a{sv} {}`) are read and dropped.

export type GVariantValue = null | boolean | number | string | GVariantValue[] | Map<GVariantValue, GVariantValue>;

const TYPE_KEYWORDS = new Set(['boolean', 'byte', 'int16', 'uint16', 'int32', 'uint32', 'handle', 'int64', 'uint64', 'double', 'string', 'objectpath', 'signature']);

export class GVariantSyntaxError extends Error {}

class Parser {
  readonly #s: string;
  #i = 0;

  constructor(s: string) {
    this.#s = s;
  }

  parseAll(): GVariantValue {
    const v = this.#value();
    this.#ws();
    if (this.#i < this.#s.length) this.#fail('trailing text');
    return v;
  }

  #fail(what: string): never {
    throw new GVariantSyntaxError(`GVariant text: ${what} at offset ${this.#i}`);
  }

  #ws(): void {
    while (this.#i < this.#s.length && /\s/.test(this.#s[this.#i])) this.#i++;
  }

  #peek(): string {
    this.#ws();
    return this.#s[this.#i] ?? '';
  }

  #expect(c: string): void {
    if (this.#peek() !== c) this.#fail(`expected '${c}'`);
    this.#i++;
  }

  #word(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.#s.slice(this.#i));
    return m ? m[0] : '';
  }

  /** One complete type string after '@' (GVariant type grammar). */
  #skipType(): void {
    const c = this.#s[this.#i++];
    if (c === undefined) this.#fail('truncated type');
    if (c === 'a' || c === 'm') this.#skipType();
    else if (c === '(') {
      while (this.#s[this.#i] !== ')') {
        if (this.#i >= this.#s.length) this.#fail('unterminated tuple type');
        this.#skipType();
      }
      this.#i++;
    } else if (c === '{') {
      this.#skipType();
      this.#skipType();
      if (this.#s[this.#i++] !== '}') this.#fail('bad dict entry type');
    } else if (!'bynqiuxthdsogvr*?'.includes(c)) this.#fail(`bad type character '${c}'`);
  }

  #value(): GVariantValue {
    const c = this.#peek();
    if (c === '@') {
      this.#i++;
      this.#skipType();
      return this.#value();
    }
    if (c === '(') return this.#tuple();
    if (c === '[') return this.#array();
    if (c === '{') return this.#dict();
    if (c === '<') {
      this.#i++;
      const v = this.#value();
      this.#expect('>');
      return v;
    }
    if (c === "'" || c === '"') return this.#string();
    if (c === 'b' && (this.#s[this.#i + 1] === "'" || this.#s[this.#i + 1] === '"')) {
      this.#i++;
      return this.#string();
    }
    if (/[-+0-9.]/.test(c)) return this.#number();
    const word = this.#word();
    if (word === '') this.#fail(c === '' ? 'unexpected end' : `unexpected '${c}'`);
    this.#i += word.length;
    if (TYPE_KEYWORDS.has(word)) return this.#value();
    switch (word) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'nothing':
        return null;
      case 'just':
        return this.#value();
      case 'inf':
        return Infinity;
      case 'nan':
        return NaN;
      default:
        return this.#fail(`unknown word '${word}'`);
    }
  }

  #list(close: string): GVariantValue[] {
    const items: GVariantValue[] = [];
    if (this.#peek() === close) {
      this.#i++;
      return items;
    }
    for (;;) {
      items.push(this.#value());
      const sep = this.#peek();
      this.#i++;
      if (sep === close) return items;
      if (sep !== ',') this.#fail(`expected ',' or '${close}'`);
      if (this.#peek() === close) {
        // one-element tuple "(x,)"
        this.#i++;
        return items;
      }
    }
  }

  #tuple(): GVariantValue[] {
    this.#i++;
    return this.#list(')');
  }

  #array(): GVariantValue[] {
    this.#i++;
    return this.#list(']');
  }

  #dict(): GVariantValue {
    this.#i++;
    const map = new Map<GVariantValue, GVariantValue>();
    if (this.#peek() === '}') {
      this.#i++;
      return map;
    }
    const key = this.#value();
    const sep = this.#peek();
    this.#i++;
    if (sep === ',') {
      // a lone dict entry "{k, v}"
      const v = this.#value();
      this.#expect('}');
      return [key, v];
    }
    if (sep !== ':') this.#fail("expected ':'");
    map.set(key, this.#value());
    for (;;) {
      const next = this.#peek();
      this.#i++;
      if (next === '}') return map;
      if (next !== ',') this.#fail("expected ',' or '}'");
      const k = this.#value();
      this.#expect(':');
      map.set(k, this.#value());
    }
  }

  #number(): number {
    const m = /^[-+]?(0x[0-9a-fA-F]+|inf|nan|(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?)/.exec(this.#s.slice(this.#i));
    if (!m) this.#fail('bad number');
    this.#i += m[0].length;
    const text = m[0];
    const sign = text.startsWith('-') ? -1 : 1;
    const body = text.replace(/^[-+]/, '');
    if (body === 'inf') return sign * Infinity;
    if (body === 'nan') return NaN;
    if (/^0x/i.test(body)) return sign * Number.parseInt(body.slice(2), 16);
    return Number(text);
  }

  #string(): string {
    const quote = this.#s[this.#i++];
    let out = '';
    for (;;) {
      const c = this.#s[this.#i++];
      if (c === undefined) this.#fail('unterminated string');
      if (c === quote) return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = this.#s[this.#i++];
      switch (e) {
        case 'a':
          out += '\x07';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'v':
          out += '\v';
          break;
        case 'u':
        case 'U': {
          const len = e === 'u' ? 4 : 8;
          const hex = this.#s.slice(this.#i, this.#i + len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) this.#fail('bad unicode escape');
          this.#i += len;
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          break;
        }
        case undefined:
          return this.#fail('unterminated escape');
        default:
          if (/[0-7]/.test(e)) {
            // octal escape (byte strings)
            let oct = e;
            while (oct.length < 3 && /[0-7]/.test(this.#s[this.#i] ?? '')) oct += this.#s[this.#i++];
            out += String.fromCharCode(Number.parseInt(oct, 8));
          } else out += e;
      }
    }
  }
}

/** Parse one GVariant text value (throws GVariantSyntaxError). */
export function parseGVariant(text: string): GVariantValue {
  return new Parser(text).parseAll();
}
