// Minimal leveled logger. The Electron main process can pass a sink that also writes to
// ~/.config/evnia/logs; tests use the default console sink or a silent one.

import type { Logger } from '../types.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (level: LogLevel, scope: string, args: unknown[]) => void;

export const consoleSink: LogSink = (level, scope, args) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}]`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line, ...args);
};

export const silentSink: LogSink = () => {};

export function createLogger(scope = 'backend', sink: LogSink = consoleSink, minLevel: LogLevel = 'info'): Logger {
  const emit = (level: LogLevel, args: unknown[]) => {
    if (ORDER[level] >= ORDER[minLevel]) sink(level, scope, args);
  };
  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    child: (s) => createLogger(`${scope}/${s}`, sink, minLevel),
  };
}
