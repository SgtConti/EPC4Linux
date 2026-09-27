// Bridge dispatcher: reproduction of EvniaServe's Class0 (DC/EvniaServe/Class0.cs; 05 §3.2-3.3).
//
//   method_0  request JSON → InputParams (input-params.ts) → method_1 → JsonResult → JSON string
//   method_1  functionName checks, argument conversion, invocation, RequestId/FunctionName echo
//   method_2  overload lookup by exact argument-type signature over Bridge's public static methods
//
// The order of the checks below is the vendor's and decides which error a malformed request gets:
//   1. unparsable request                → "解析json字符串: <json>失败"   (vendor: ids null; see below)
//   2. functionName missing/null         → .NET NullReferenceException text        (string_0.Trim())
//   3. functionName empty or white space → "functionName is null"
//   4. a parameter that is not Integer/String/Boolean → "Unsupported parameter type: <JTokenType>"
//      (checked before the name lookup, so it wins over "undefined")
//   5. unknown name                      → "functionName: <name> undefined"
//   6. no overload with that exact type list → "params error: <.NET signatures joined by ' | '>"
//   7. integer outside int32             → .NET OverflowException text
//   8. `device` != -1 with non-null parms → "Parameter count mismatch." (device is prepended AFTER
//      overload selection, so any such call has one argument too many — 02 §4.4); with parms null
//      the vendor passes no arguments at all and `device` is silently ignored
//   9. handler returns null              → "functionName: <name>  return null obj" (two spaces)
// In the vendor, every result from step 2 on echoes RequestId and FunctionName (here step 1 does
// too, best-effort). All errors use err_code 9.
//
// Deviations, each because the vendor's reply would leave the renderer's promise pending forever
// (there is no client timeout, 02 §4.6), or for simpler handlers:
//   - step 1 echoes whatever functionName/requestId can still be read from a request that failed to
//     bind (port rule, 20-backend-host-tail §1.3); the vendor sent RequestId null, which the
//     renderer takes for a notification. The err_msg stays the vendor's;
//   - a handler that throws yields JsonResult.Exception(ex) (the vendor would report the reflection
//     wrapper's "Exception has been thrown by the target of an invocation."; every SystemOper method
//     catches and returns JsonResult.Exception itself, which is what api/ modules get by throwing);
//   - a result that cannot be serialized yields an error envelope instead of a null broadcast;
//   - Class0's outer catch (unreachable here too) echoes the ids instead of sending them null;
//   - every handler runs under a watchdog (default 120 s, DEFAULT_HANDLER_TIMEOUT_MS). The hub runs a
//     connection's requests one at a time (20-backend-host-tail §1.4) and the renderer has no reply
//     timeout (02 §4.6), so in the vendor one handler that never returned (a stuck USB/DDC transfer)
//     froze the UI behind its loading overlay until restart; server pings kept the socket alive, so
//     not even a reconnect happened. When the watchdog fires the caller gets an err_code 9 envelope
//     (handlerTimeoutMessage) with the ids echoed and the next request runs; the handler keeps
//     running and its late result is logged and dropped.

import type { JsonResult, Logger, RpcArg, RpcArgType, RpcCallContext, RpcHandler, RpcOverload, RpcRegistry, SerializeMode } from '../types.ts';
import { ERROR, error, exception, serializeResult } from '../core/envelope.ts';
import { parseInputParams, salvageRequestIds, toInt32, type InputParams, type JToken, type JTokenType } from './input-params.ts';

/** Class0.list_0: requests that are not logged (polled several times a second by the UI). */
export const VENDOR_QUIET_FUNCTIONS: readonly string[] = ['Effect_GetLEDs', 'Effect_CheckDynamicLightingEnabled'];

/** Class0.list_1: functions serialized with JsonSerialize(IgnoreUI, bIgnoreNullValue:false) (core/json.ts). */
export const VENDOR_SERIALIZE_MODES: ReadonlyMap<string, SerializeMode> = new Map([['Profile_GetDeviceData', 'uiProfileGet']]);

/** Vendor error texts, verbatim (Class0.cs and the .NET runtime messages it surfaces). */
export const DispatchErrors = {
  parseFailed: (json: string) => `解析json字符串: ${json}失败`,
  nullReference: 'Object reference not set to an instance of an object.',
  functionNameNull: 'functionName is null',
  unsupportedType: (type: JTokenType) => `Unsupported parameter type: ${type}`,
  undefinedFunction: (name: string) => `functionName: ${name} undefined`,
  paramsError: (signatures: readonly string[]) => `params error: ${signatures.join(' | ')}`,
  parameterCountMismatch: 'Parameter count mismatch.',
  nullResult: (name: string) => `functionName: ${name}  return null obj`,
} as const;

/**
 * Handler watchdog default (port deviation, see header). Generous on purpose: the longest vendor
 * operation on the request path is the ~21 s Start scan (20-backend-host-tail §7.2), which
 * api/system.ts already answers after 60 s; nothing legitimate comes close to 120 s.
 */
export const DEFAULT_HANDLER_TIMEOUT_MS = 120_000;

/** Largest delay setTimeout honours; longer ones fire after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** err_msg of a request whose handler overran the watchdog (the port's text; the vendor had none). */
export function handlerTimeoutMessage(name: string, timeoutMs: number): string {
  return `functionName: ${name} timed out after ${timeoutMs} ms`;
}

const TIMED_OUT = Symbol('handler watchdog fired');

const ARG_TYPE_OF: Partial<Record<JTokenType, RpcArgType>> = { Integer: 'int', String: 'string', Boolean: 'bool' };
const NET_TYPE_NAME: Record<RpcArgType, string> = { int: 'Int32', string: 'System.String', bool: 'Boolean' };

/** string.IsNullOrEmpty(s.Trim()): true exactly when every UTF-16 unit is char.IsWhiteSpace. */
function isNetWhiteSpaceOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const white =
      (c >= 0x09 && c <= 0x0d) || c === 0x20 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
    if (!white) return false;
  }
  return true;
}

interface Entry {
  readonly overloads: RpcOverload[];
  readonly log: Logger;
}

interface Outcome {
  result: JsonResult;
  mode: SerializeMode;
}

export interface DispatcherOptions {
  /** Function names whose requests are not logged (default VENDOR_QUIET_FUNCTIONS). */
  quietFunctions?: Iterable<string>;
  /**
   * Answer a request with an error once its handler has run this long (default
   * DEFAULT_HANDLER_TIMEOUT_MS). 0 or less disables the watchdog (vendor behaviour: wait forever).
   */
  handlerTimeoutMs?: number;
}

/** A registered overload as seen from outside (read-only copy; see RpcDispatcher.registrations()). */
export interface RegisteredOverload {
  readonly name: string;
  readonly signature: readonly RpcArgType[];
  /** Mode the reply is serialized in (core/json.ts). */
  readonly serialize: SerializeMode;
}

export class RpcDispatcher implements RpcRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #log: Logger;
  readonly #quiet: ReadonlySet<string>;
  readonly #handlerTimeoutMs: number;

  constructor(log: Logger, options: DispatcherOptions = {}) {
    const timeout = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
    if (Number.isNaN(timeout) || timeout > MAX_TIMER_MS) {
      throw new RangeError(`handlerTimeoutMs must be at most ${MAX_TIMER_MS} ms (0 disables the watchdog), got ${timeout}`);
    }
    this.#log = log;
    this.#quiet = new Set(options.quietFunctions ?? VENDOR_QUIET_FUNCTIONS);
    this.#handlerTimeoutMs = timeout;
  }

  /**
   * Add one overload of a Bridge function. Overloads of a name are tried in registration order
   * (Bridge declaration order in the vendor); two overloads with the same signature are a bug.
   * `serialize` defaults to the vendor's per-function mode (VENDOR_SERIALIZE_MODES), else 'ui'.
   */
  register(name: string, signature: RpcArgType[], handler: RpcHandler, serialize?: SerializeMode): void {
    if (name.trim() === '') throw new Error('RPC function name must not be empty');
    for (const t of signature) {
      if (!Object.hasOwn(NET_TYPE_NAME, t)) throw new Error(`RPC function ${name}: unsupported parameter type ${String(t)}`);
    }
    let entry = this.#entries.get(name);
    if (!entry) this.#entries.set(name, (entry = { overloads: [], log: this.#log.child(name) }));
    if (entry.overloads.some((o) => sameSignature(o.signature, signature))) {
      throw new Error(`RPC function ${netSignature(name, signature)} is already registered`);
    }
    const overload: RpcOverload = { signature: [...signature], handler };
    const mode = serialize ?? VENDOR_SERIALIZE_MODES.get(name);
    if (mode !== undefined) overload.serialize = mode;
    entry.overloads.push(overload);
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  /** Registered function names, in registration order. */
  functionNames(): string[] {
    return [...this.#entries.keys()];
  }

  /**
   * Every registered overload with its signature and serialize mode, grouped by function name in
   * registration order (functionNames() order, then overload order). Copies: changing them does not
   * affect the dispatcher. For audits such as api/catalog.ts; nothing is dispatched.
   */
  registrations(): RegisteredOverload[] {
    const out: RegisteredOverload[] = [];
    for (const [name, entry] of this.#entries) {
      for (const o of entry.overloads) out.push({ name, signature: [...o.signature], serialize: o.serialize ?? 'ui' });
    }
    return out;
  }

  /** Class0.method_0: one GetTaskAsync request string → serialized JsonResult. Never rejects. */
  async dispatch(requestJson: string): Promise<string> {
    const params = parseInputParams(requestJson);
    if (params === null) {
      this.#log.debug(`GetTaskAsync param = ${requestJson}`);
      const ids = salvageRequestIds(requestJson);
      const result = { ...error(DispatchErrors.parseFailed(requestJson)), RequestId: ids.requestId, FunctionName: ids.functionName };
      return this.#serialize({ result, mode: 'ui' });
    }
    if (params.functionName === null || !this.#quiet.has(params.functionName)) {
      this.#log.debug(`GetTaskAsync param = ${requestJson}`);
    }
    let outcome: Outcome;
    try {
      outcome = await this.#call(params);
    } catch (e) {
      // Unreachable in practice (#call handles its own failures); kept as Class0's outer guard.
      this.#log.error(`GetTaskAsync exception param = ${requestJson}`, e);
      outcome = { result: { ...exception(e), RequestId: params.requestId, FunctionName: params.functionName }, mode: 'ui' };
    }
    return this.#serialize(outcome);
  }

  /** Class0.method_1 (+ method_2 for the lookup). */
  async #call(p: InputParams): Promise<Outcome> {
    const { functionName: name, requestId } = p;
    const fail = (msg: string): Outcome => ({
      result: { ...error(msg), RequestId: requestId, FunctionName: name },
      mode: (name !== null && VENDOR_SERIALIZE_MODES.get(name)) || 'ui',
    });

    if (name === null) {
      this.#log.error(`GetTaskAsync: functionName missing (${DispatchErrors.nullReference})`);
      return fail(DispatchErrors.nullReference);
    }
    if (isNetWhiteSpaceOnly(name)) return fail(DispatchErrors.functionNameNull);

    const types: RpcArgType[] = [];
    for (const token of p.parms ?? []) {
      const t = ARG_TYPE_OF[token.type];
      if (t === undefined) {
        const msg = DispatchErrors.unsupportedType(token.type);
        this.#log.error(msg);
        return fail(msg);
      }
      types.push(t);
    }
    const entry = this.#entries.get(name);
    if (!entry) return fail(DispatchErrors.undefinedFunction(name));
    const overload = entry.overloads.find((o) => sameSignature(o.signature, types));
    if (!overload) return fail(DispatchErrors.paramsError(entry.overloads.map((o) => netSignature(name, o.signature))));

    let args: RpcArg[];
    try {
      args = p.parms === null ? [] : [...(p.device !== -1 ? [p.device] : []), ...p.parms.map(toArg)];
    } catch (e) {
      this.#log.error(`${name}: ${(e as Error).message}`);
      return fail((e as Error).message);
    }
    if (args.length !== overload.signature.length) {
      this.#log.error(`${name}: device ${p.device} prepended to ${types.length} parameter(s)`);
      return fail(DispatchErrors.parameterCountMismatch);
    }

    const mode = overload.serialize ?? 'ui';
    const ctx: RpcCallContext = { functionName: name, requestId, log: entry.log };
    let r: JsonResult | null | undefined | typeof TIMED_OUT;
    try {
      // The async wrapper turns a synchronous throw into a rejection like an async handler's.
      r = await this.#watch((async () => overload.handler(args, ctx))(), entry.log);
    } catch (e) {
      entry.log.error('handler threw', e);
      return { result: { ...exception(e), RequestId: requestId, FunctionName: name }, mode };
    }
    if (r === TIMED_OUT) return fail(handlerTimeoutMessage(name, this.#handlerTimeoutMs));
    const result = r ?? error(DispatchErrors.nullResult(name));
    return { result: { ...result, RequestId: requestId, FunctionName: name }, mode };
  }

  /**
   * The handler watchdog (header, last deviation): `running`'s outcome, or TIMED_OUT once it has run
   * for the configured time. A late outcome is only logged.
   */
  async #watch<T>(running: Promise<T>, log: Logger): Promise<T | typeof TIMED_OUT> {
    const limit = this.#handlerTimeoutMs;
    if (limit <= 0) return running;
    const t0 = performance.now();
    let timer: NodeJS.Timeout | undefined;
    const watchdog = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(resolve, limit, TIMED_OUT)));
    try {
      const outcome = await Promise.race([running, watchdog]);
      if (outcome === TIMED_OUT) {
        log.error(`no result after ${limit} ms; answering with an error, the handler keeps running and its result will be dropped`);
        const late = (): string => `${Math.round(performance.now() - t0)} ms after the call started, after the watchdog had answered`;
        running.then(
          () => log.warn(`finished ${late()}; result dropped`),
          (e: unknown) => log.error(`failed ${late()}`, e),
        );
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  #serialize({ result, mode }: Outcome): string {
    try {
      return serializeResult(result, mode);
    } catch (e) {
      this.#log.error(`JsonSerialize failed for ${result.FunctionName ?? '(no function)'}`, e);
      const msg = `JsonSerialize failed: ${e instanceof Error ? e.message : String(e)}`;
      return serializeResult({ ...error(msg, ERROR), RequestId: result.RequestId, FunctionName: result.FunctionName });
    }
  }
}

/** JToken → C# argument (the dispatcher already rejected every other token type). */
function toArg(t: JToken): RpcArg {
  switch (t.type) {
    case 'Integer':
      return toInt32(t.lexeme);
    case 'String':
    case 'Boolean':
      return t.value;
    default:
      throw new Error(DispatchErrors.unsupportedType(t.type));
  }
}

function sameSignature(a: readonly RpcArgType[], b: readonly RpcArgType[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** MethodInfo.ToString() of the Bridge method, e.g. "Zeasn.Com.Lib.JsonResult PHL_SetOSD(System.String, Int32)". */
export function netSignature(name: string, signature: readonly RpcArgType[]): string {
  return `Zeasn.Com.Lib.JsonResult ${name}(${signature.map((t) => NET_TYPE_NAME[t]).join(', ')})`;
}
