// Display-change sources beyond Electron's `screen` events (01 port plan 4; 20-monitor-io-linux-
// consolidation D9 and §5 "Hotplug mapping").
//
//   udev   `udevadm monitor --udev --subsystem-match=drm --subsystem-match=i2c-dev`
//          drm `change` (HOTPLUG=1: connector plugged or unplugged, DP link retrain, the monitor's
//          HDR/SDR switch when it pulses HPD) and drm/i2c-dev `add`/`remove` (GPU driver load, DP-MST
//          buses) → displayChange, so the backend re-resolves its buses.
//   Mutter `gdbus monitor --session --dest org.gnome.Mutter.DisplayConfig`: the MonitorsChanged
//          signal (GNOME on X11 and Wayland) fires on every monitor configuration change, including the
//          refresh-rate-only changes that Electron's display-metrics-changed does not report.
// Both only call onChange, which index.ts routes to DeviceChangeGate.trigger('displayChange'), so the
// vendor 2000 ms debounce and shieldDisplayChange apply to them (D9 rule 1). A missing tool (no
// udevadm, no gdbus, not GNOME) leaves Electron's events as the only source.

import type { ChildProcess } from 'node:child_process';
import type { Logger } from '../backend/types.ts';
import { spawnTied } from './child-process.ts';

export interface Uevent {
  action: string;
  devpath: string;
  subsystem: string;
}

/** `UDEV  [48593.183016] change   /devices/pci0000:00/0000:00:02.0/drm/card1 (drm)` → event. */
export function parseUdevMonitorLine(line: string): Uevent | null {
  const m = /^UDEV\s+\[[\d.]+\]\s+(\w+)\s+(\S+)\s+\(([\w-]+)\)\s*$/.exec(line);
  return m ? { action: m[1], devpath: m[2], subsystem: m[3] } : null;
}

export function isDisplayUevent(e: Uevent): boolean {
  if (e.subsystem === 'drm') return e.action === 'change' || e.action === 'add' || e.action === 'remove';
  if (e.subsystem === 'i2c-dev') return e.action === 'add' || e.action === 'remove';
  return false;
}

export const MUTTER_DISPLAY_CONFIG = 'org.gnome.Mutter.DisplayConfig';
const MUTTER_PATH = '/org/gnome/Mutter/DisplayConfig';

/** A `gdbus monitor` line announcing Mutter's MonitorsChanged signal. */
export function isMonitorsChangedSignal(line: string): boolean {
  return line.trim().startsWith(`${MUTTER_PATH}: ${MUTTER_DISPLAY_CONFIG}.MonitorsChanged `);
}

export function isGnomeSession(env: NodeJS.ProcessEnv): boolean {
  return (env.XDG_CURRENT_DESKTOP ?? '').toUpperCase().split(':').includes('GNOME');
}

export interface LineWatcherOptions {
  name: string;
  command: string;
  args: readonly string[];
  log: Logger;
  onLine: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** A long-lived child whose stdout lines are events. It is not restarted when it exits. */
export class LineWatcher {
  readonly #o: LineWatcherOptions;
  #child: ChildProcess | null;

  constructor(o: LineWatcherOptions) {
    this.#o = o;
    const child = spawnTied(o.command, o.args, { stdio: ['ignore', 'pipe', 'ignore'], env: { ...(o.env ?? process.env), LC_ALL: 'C' } });
    this.#child = child;
    child.on('error', (e) => {
      if (this.#child !== child) return;
      this.#child = null;
      o.log.info(`${o.name} unavailable (${o.command}: ${e.message})`);
    });
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      o.log.warn(`${o.name} stopped (${o.command} exited ${code ?? signal})`);
    });
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (this.#child === child) this.#o.onLine(line);
      }
    });
  }

  get running(): boolean {
    return this.#child !== null;
  }

  dispose(): void {
    const child = this.#child;
    this.#child = null;
    child?.kill();
  }
}

export interface DisplayWatchOptions {
  log: Logger;
  /** Called with a short description of the source event. */
  onChange: (source: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** Start the udev watcher, and the Mutter watcher on GNOME. */
export function startDisplayWatchers(o: DisplayWatchOptions): LineWatcher[] {
  const env = o.env ?? process.env;
  const watchers = [
    new LineWatcher({
      name: 'udev display events',
      command: 'udevadm',
      args: ['monitor', '--udev', '--subsystem-match=drm', '--subsystem-match=i2c-dev'],
      log: o.log,
      env,
      onLine: (line) => {
        const e = parseUdevMonitorLine(line);
        if (e && isDisplayUevent(e)) o.onChange(`udev ${e.subsystem} ${e.action} ${e.devpath}`);
      },
    }),
  ];
  if (isGnomeSession(env)) {
    watchers.push(
      new LineWatcher({
        name: 'Mutter MonitorsChanged',
        command: 'gdbus',
        args: ['monitor', '--session', '--dest', MUTTER_DISPLAY_CONFIG, '--object-path', MUTTER_PATH],
        log: o.log,
        env,
        onLine: (line) => {
          if (isMonitorsChangedSignal(line)) o.onChange('Mutter MonitorsChanged');
        },
      }),
    );
  }
  return watchers;
}
