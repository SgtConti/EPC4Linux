// Long-lived helper processes of the main process (udevadm, gdbus, parec, pactl subscribe, xprop -spy).
//
// Node's spawn in Electron's main process passes on every descriptor Chromium left inheritable: mojo
// sockets, the single-instance socket, leveldb locks of the profile, a test runner's pipes. A helper
// orphaned by a crash of the app would keep all of those open and run forever. That blocks the next
// launch's single-instance lock and Local Storage, and keeps Chromium's own child processes alive.
// Helpers are therefore started through util-linux `setpriv --pdeathsig TERM` (util-linux is Essential
// on Debian and Ubuntu), so the kernel terminates them when the app dies, however it dies. Without
// setpriv they are started directly; the normal exit path (exit.ts) stops them either way.
//
// Short-lived queries (gdbus call, xrandr, xprop -id) go through createCommandRunner below.

import { accessSync, constants } from 'node:fs';
import { type ChildProcess, execFile, spawn, type SpawnOptions } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';

/** Absolute path of an executable `command` on PATH, or null. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = command.includes('/') ? [command] : (env.PATH ?? '').split(delimiter).filter((d) => isAbsolute(d)).map((d) => join(d, command));
  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {
      // not here
    }
  }
  return null;
}

/** The argv that runs `command args` so that it receives SIGTERM when this process dies. */
export function tiedArgv(command: string, args: readonly string[], env: NodeJS.ProcessEnv): [string, string[]] {
  const exe = findOnPath(command, env);
  const setpriv = exe ? findOnPath('setpriv', env) : null;
  return exe && setpriv ? [setpriv, ['--pdeathsig', 'TERM', '--', exe, ...args]] : [command, [...args]];
}

/**
 * spawn() for helpers that must not outlive the app. A missing `command` behaves like spawn(): the
 * child emits 'error' with ENOENT.
 */
export function spawnTied(command: string, args: readonly string[], options: SpawnOptions & { env: NodeJS.ProcessEnv }): ChildProcess {
  const [file, argv] = tiedArgv(command, args, options.env);
  return spawn(file, argv, options);
}

// ───────────────────────────── short-lived queries ─────────────────────────────

export interface CommandResult {
  ok: boolean;
  stdout: string;
  /** Why it failed: ENOENT (not installed), a timeout, a non-zero exit with its stderr. */
  error?: string;
}

/** Runs one short-lived query command (gdbus call, xrandr, xprop -id) and collects its stdout. */
export type CommandRunner = (command: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<CommandResult>;

/** Default timeout of a query command. */
export const COMMAND_TIMEOUT_MS = 3000;
const COMMAND_MAX_OUTPUT = 4 << 20;

/**
 * The CommandRunner of the main process: execFile (no shell) with the C locale, a timeout (SIGKILL) and an
 * output cap. Never rejects. Queries exit on their own within milliseconds, so they are not tied with
 * setpriv like the long-lived helpers above.
 */
export function createCommandRunner(env: NodeJS.ProcessEnv = process.env): CommandRunner {
  return (command, args, options = {}) =>
    new Promise((resolve) => {
      execFile(
        command,
        [...args],
        { env: { ...env, LC_ALL: 'C' }, timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: COMMAND_MAX_OUTPUT, encoding: 'utf8', windowsHide: true },
        (err, stdout, stderr) => {
          if (!err) {
            resolve({ ok: true, stdout });
            return;
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          const why = e.code === 'ENOENT' ? 'ENOENT' : e.killed ? 'timed out' : (stderr || e.message).trim().split('\n')[0];
          resolve({ ok: false, stdout: stdout ?? '', error: why });
        },
      );
    });
}
