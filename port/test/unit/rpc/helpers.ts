// Shared test helpers for the rpc/ and hub/ unit tests (not a test file itself).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLogger, type LogLevel } from '../../../src/backend/core/log.ts';
import type { Logger } from '../../../src/backend/types.ts';

const LOG_DIR = fileURLToPath(new URL('../../fixtures/windows/logs/', import.meta.url));

/** Every `GetTaskAsync param = {...}` request line of the user's real EvniaServe logs (05 §3.2). */
export function vendorRequests(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(LOG_DIR).filter((n) => n.startsWith('EvniaServe-'))) {
    for (const m of readFileSync(LOG_DIR + f, 'utf8').matchAll(/GetTaskAsync param = (\{.*?\})  \S/g)) out.push(m[1]);
  }
  return out;
}

export interface LogLine {
  level: LogLevel;
  scope: string;
  text: string;
}

/** A debug-level logger that records every line instead of printing it. */
export function captureLogger(scope = 'test'): { log: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = createLogger(scope, (level, s, args) => {
    lines.push({ level, scope: s, text: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ') });
  }, 'debug');
  return { log, lines };
}
