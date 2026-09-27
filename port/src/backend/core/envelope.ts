// Zeasn.Com.Lib.JsonResult (work/dotnet-clean/Zeasn.Com.Lib/Zeasn.Com.Lib/JsonResult.cs).
// Newtonsoft serializes properties in declaration order:
//   err_code, IsSucc, err_msg, RequestId, Tag, FunctionName, CurrItem
// The renderer treats a reply as an error when `err_code !== 0 || err_msg` (02 §5, 05 §3.1),
// so success replies carry err_msg "" (Succ default) — never a non-empty message.

import type { JsonResult, SerializeMode } from '../types.ts';
import { toJsonValue } from './json.ts';

export const SUCC = 0;
export const ERROR = 9;

export function succ(tag: unknown = null, msg = ''): JsonResult {
  return { err_code: SUCC, IsSucc: true, err_msg: msg, RequestId: null, Tag: tag, FunctionName: null, CurrItem: null };
}

export function error(msg: string, errCode = ERROR): JsonResult {
  const code = errCode === SUCC ? ERROR : errCode;
  return { err_code: code, IsSucc: false, err_msg: msg, RequestId: null, Tag: null, FunctionName: null, CurrItem: null };
}

/** JsonResult.Exception: err 9 with the exception text as message. */
export function exception(e: unknown, errCode = ERROR): JsonResult {
  const msg = e instanceof Error ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}` : String(e);
  return error(msg, errCode);
}

/** Build a result with an explicit code and optional tag (for vendor paths that set both). */
export function result(errCode: number, msg: string | null, tag: unknown = null): JsonResult {
  return { err_code: errCode, IsSucc: errCode === SUCC, err_msg: msg, RequestId: null, Tag: tag, FunctionName: null, CurrItem: null };
}

/** Serialize with the exact envelope key order; Tag is converted according to `mode`. */
export function serializeResult(r: JsonResult, mode: SerializeMode = 'ui'): string {
  const ordered = {
    err_code: r.err_code,
    IsSucc: r.err_code === SUCC,
    err_msg: r.err_msg ?? null,
    RequestId: r.RequestId ?? null,
    Tag: toJsonValue(r.Tag, mode === 'profile' ? 'ui' : mode),
    FunctionName: r.FunctionName ?? null,
    CurrItem: toJsonValue(r.CurrItem, 'ui'),
  };
  return JSON.stringify(ordered);
}
