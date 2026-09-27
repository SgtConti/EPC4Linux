// Log files compatible with the vendor's electron-log setup (01 §15):
//   ~/.config/evnia/logs/YY-MM-DD.log, line format `[YYYY-MM-DD HH:mm:ss.SSS] [level] [scope] msg`,
//   20 MiB rotation, 5-day retention of files matching ^\d{2}-\d{2}-\d{2}\.log(\.\d+)?$.
// Deviations (documented in impl notes): the day's file is appended to instead of truncated on every
// start (the vendor's Bv.clear() destroyed the previous session's evidence), and cleanup never deletes
// files that do not match the pattern (the vendor deleted anything else found in the directory).
// The same sink writes the backend log to ~/.config/EvniaServe/logs/YYYY-MM-DD.txt (05 §7 layout).

import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inspect } from 'node:util';
import type { LogLevel, LogSink } from '../backend/core/log.ts';

export const LOG_MAX_BYTES = 20 << 20;
export const LOG_RETENTION_DAYS = 5;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** electron-log timestamp `YYYY-MM-DD HH:mm:ss.SSS` (local time). */
export function logTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export interface LogFileNaming {
  /** File name for a given day. */
  fileName(d: Date): string;
  /** Files eligible for retention cleanup. */
  pattern: RegExp;
}

/** Electron-side names: `YY-MM-DD.log` (vendor `getCurrentDateStamp`). */
export const MAIN_LOG_NAMING: LogFileNaming = {
  fileName: (d) => `${String(d.getFullYear()).slice(-2)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`,
  pattern: /^\d{2}-\d{2}-\d{2}\.log(\.\d+)?$/,
};

/** Backend names: `YYYY-MM-DD.txt` like %APPDATA%\EvniaServe\logs. */
export const BACKEND_LOG_NAMING: LogFileNaming = {
  fileName: (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.txt`,
  pattern: /^\d{4}-\d{2}-\d{2}\.txt(\.\d+)?$/,
};

export function formatLogLine(d: Date, level: LogLevel, scope: string, args: readonly unknown[]): string {
  const msg = args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 4, breakLength: Infinity }))).join(' ');
  return `[${logTimestamp(d)}] [${level}] [${scope}] ${msg}\n`;
}

/** Delete matching log files older than `days` (vendor cleanupOldLogs, minus the non-matching deletion). */
export function cleanupOldLogs(dir: string, naming: LogFileNaming, days: number, now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  for (const name of entries) {
    if (!naming.pattern.test(name)) continue;
    try {
      if (statSync(join(dir, name)).mtimeMs < cutoff) rmSync(join(dir, name), { force: true });
    } catch {
      // a file vanishing concurrently is fine
    }
  }
}

/** Shift `<file>.N` → `<file>.N+1`, then move the full file to `<file>.1`. */
function rotate(file: string): void {
  const dir = dirname(file);
  const base = basename(file);
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d+)$`);
  const suffixes = readdirSync(dir)
    .map((n) => re.exec(n)?.[1])
    .filter((s): s is string => s !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
  for (const n of suffixes) renameSync(`${file}.${n}`, `${file}.${n + 1}`);
  renameSync(file, `${file}.1`);
}

export interface FileSinkOptions {
  dir: string;
  naming: LogFileNaming;
  /** Also echo to the console (development runs). */
  console?: boolean;
  maxBytes?: number;
  retentionDays?: number;
}

/** A LogSink (src/backend/core/log.ts) that appends to dated files. Never throws. */
export function createFileSink(opts: FileSinkOptions): LogSink {
  const maxBytes = opts.maxBytes ?? LOG_MAX_BYTES;
  let dirReady = false;
  let written = -1;
  let currentFile = '';
  try {
    mkdirSync(opts.dir, { recursive: true });
    dirReady = true;
    cleanupOldLogs(opts.dir, opts.naming, opts.retentionDays ?? LOG_RETENTION_DAYS);
  } catch {
    dirReady = false;
  }
  return (level, scope, args) => {
    const now = new Date();
    const line = formatLogLine(now, level, scope, args);
    if (opts.console) (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line.trimEnd());
    if (!dirReady) return;
    const file = join(opts.dir, opts.naming.fileName(now));
    try {
      if (file !== currentFile) {
        currentFile = file;
        try {
          written = statSync(file).size;
        } catch {
          written = 0;
        }
      }
      if (written + line.length > maxBytes && written > 0) {
        rotate(file);
        written = 0;
      }
      appendFileSync(file, line, { mode: 0o600 });
      written += Buffer.byteLength(line);
    } catch {
      // logging must never take the app down
    }
  };
}
