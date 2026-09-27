// Login autostart through the XDG Autostart spec (01 §10.1 #18 Adapt, 13 §12.1).
//
// Vendor: app.setLoginItemSettings({openAtLogin: autoStartup, args: [autoStartupMinimize ? "--openAsHidden" : ""]})
// on every start() and on the setAutoStartUp IPC, packaged builds only. setLoginItemSettings is a
// no-op on Linux, so the port writes ~/.config/autostart/evnia-precision-center.desktop instead
// (removed when autostart is off) with the same --openAsHidden semantics.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../backend/types.ts';

export const AUTOSTART_FILE = 'evnia-precision-center.desktop';
export const OPEN_AS_HIDDEN = '--openAsHidden';

/** Desktop Entry spec "Exec key": quote arguments that contain reserved characters. */
export function quoteExecArg(arg: string): string {
  const escapedPercent = arg.replace(/%/g, '%%');
  if (!/[\s"'\\><~|&;$*?#()`]/.test(escapedPercent) && escapedPercent.length > 0) return escapedPercent;
  return `"${escapedPercent.replace(/(["`$\\])/g, '\\$1')}"`;
}

export function autostartDesktopEntry(command: readonly string[], minimized: boolean): string {
  const exec = [...command, ...(minimized ? [OPEN_AS_HIDDEN] : [])].map(quoteExecArg).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Evnia Precision Center',
    'Comment=Philips Evnia monitor control (offline)',
    `Exec=${exec}`,
    'Icon=evnia-precision-center',
    'Terminal=false',
    'NoDisplay=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export function autostartDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.startsWith('/') ? env.XDG_CONFIG_HOME : join(homedir(), '.config');
  return join(base, 'autostart');
}

export interface AutostartOptions {
  enabled: boolean;
  minimized: boolean;
  /** argv that launches the installed app, e.g. [process.execPath]. */
  command: readonly string[];
  dir: string;
  log: Logger;
}

/** Create or remove the autostart entry. Never throws. */
export function applyAutostart(opts: AutostartOptions): void {
  const file = join(opts.dir, AUTOSTART_FILE);
  try {
    if (!opts.enabled) {
      rmSync(file, { force: true });
      opts.log.info('Autostart disabled');
      return;
    }
    mkdirSync(opts.dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, autostartDesktopEntry(opts.command, opts.minimized), { mode: 0o644 });
    renameSync(tmp, file);
    opts.log.info(`Autostart enabled${opts.minimized ? ' (hidden)' : ''}: ${file}`);
  } catch (e) {
    opts.log.error('Cannot update autostart entry', e);
  }
}
