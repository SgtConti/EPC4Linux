// The renderer's log lines (01 §15; 02 §1 "electron-log renderer", ST:~30688-31140).
//
// The vendor renderer bundles electron-log 5's renderer module. Its named loggers (class Qf, e.g.
// "renderer/useConnectDetection", main-CDosWiM3.js:1696) and its error handler (errorName + error) send every
// line through the IPC transport: `window.__electronLog.sendToMain(message)`, a bridge that electron-log's
// preload exposes once the main process called `log.initialize()`; electron-log main then writes the line
// into the app log. Without that bridge the renderer prints "electron-log: logger isn't initialized in the
// main process" as a console error instead (ST:30998-31002), e.g. on every monitor unplug:
// `da.info("To overview device list empty")` (main-CDosWiM3.js:1749).
//
// Port: the preload exposes the same bridge (src/preload/api.ts electronLog) over the internal channel
// INTERNAL_CHANNELS.rendererLog, main checks the sender like every channel (ipc.ts) and writes the line into
// its own log (logfile.ts format) under the scope "renderer". The message comes from the page, so it is
// treated as untrusted: only the level and the data are used, everything is flattened to one bounded line.

/** electron-log's levels (renderer transports/ipc.js). */
export const RENDERER_LOG_LEVELS = ['error', 'warn', 'info', 'verbose', 'debug', 'silly'] as const;

/** A line longer than this is cut (a page could otherwise fill the log; logfile.ts rotates at 20 MiB). */
export const MAX_RENDERER_LOG_CHARS = 4096;

export interface RendererLogLine {
  level: 'error' | 'warn' | 'info' | 'debug';
  text: string;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function oneLine(text: string): string {
  // One log entry per line: newlines (stack traces) become " | ", other control characters a space.
  const flat = text.replace(/\r?\n\s*/g, ' | ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return flat.length > MAX_RENDERER_LOG_CHARS ? `${flat.slice(0, MAX_RENDERER_LOG_CHARS)}… (${flat.length} chars)` : flat;
}

/**
 * The log line for a message of electron-log's renderer IPC transport: `{data: unknown[], level, …}`, or the
 * error handler's `{cmd: "errorHandler", errorName, error: {name, message, stack, …}}`. Null when it is
 * neither (nothing is logged).
 */
export function rendererLogLine(message: unknown): RendererLogLine | null {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return null;
  const m = message as Record<string, unknown>;
  if (m.cmd === 'errorHandler') {
    const error = typeof m.error === 'object' && m.error !== null ? (m.error as Record<string, unknown>) : {};
    const detail = typeof error.stack === 'string' && error.stack ? error.stack : `${stringify(error.name ?? 'Error')}: ${stringify(error.message ?? '')}`;
    const name = typeof m.errorName === 'string' && m.errorName ? `${m.errorName} ` : '';
    return { level: 'error', text: oneLine(`${name}${detail}`) };
  }
  if (!('data' in m)) return null;
  const data = Array.isArray(m.data) ? m.data : [m.data];
  const raw = typeof m.level === 'string' ? m.level : 'info';
  const level = (RENDERER_LOG_LEVELS as readonly string[]).includes(raw) ? raw : 'info';
  return {
    level: level === 'verbose' || level === 'silly' ? 'debug' : (level as RendererLogLine['level']),
    text: oneLine(data.map(stringify).join(' ')),
  };
}
