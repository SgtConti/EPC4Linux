// HostServices.getForegroundAppPath and the optional getForegroundApp() extension (backend
// theme/app-binding.ts ForegroundAppHost) for app-bound themes (13 §4.3-4.4, 20-theme-profile-engine §10.2
// item 5).
//
// X11: `xprop -root -spy _NET_ACTIVE_WINDOW` prints the active window on every change (event-driven,
// one long-lived child); for each new window one `xprop -id <win> _NET_WM_PID WM_CLASS` gives
//   exe      readlink /proc/<pid>/exe
//   wmClass  the class part of WM_CLASS ("Google-chrome"; the instance part when the class is empty),
//            which the backend compares with a binding's desktop-file ID and StartupWMClass;
//   appId    the Flatpak application ID from the process's systemd scope
//            (/proc/<pid>/cgroup: …/app-flatpak-<app id>-<n>.scope), which matches the exported .desktop.
// A window without _NET_WM_PID still reports its WM_CLASS (exe null).
// GNOME Wayland exposes no foreground-window API without a Shell extension (13 §4.4), and XWayland
// only sees X11 clients, so on Wayland sessions — or without xprop (package x11-utils) — the tracker
// reports null and the backend keeps the feature inert.
//
// Tracking starts with the first query and stops again on release(), which the backend's CheckTopApp
// calls while no theme has a bound app (theme/app-binding.ts AppBindingWatcher): focus changes and the
// focused processes' /proc entries are not followed when no app-bound theme could use them.
//
// Vendor bug fixed here: CheckTopApp excluded {"electron","Precision Center"} but the shipped process
// was "Evnia Precision Center", so focusing the app itself switched the theme back to "User"
// (13 §4.3). Focus changes to this app's own windows are ignored: the last foreign app is kept.

import type { ChildProcess } from 'node:child_process';
import { readFile, readlink } from 'node:fs/promises';
import type { ForegroundApp } from '../backend/theme/app-binding.ts';
import type { Logger } from '../backend/types.ts';
import { type CommandRunner, createCommandRunner, spawnTied } from './child-process.ts';

/** `_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007` → "0x3a00007" (null for none / 0x0). */
export function parseActiveWindow(line: string): string | null {
  const m = /window id # (0x[0-9a-fA-F]+)/.exec(line);
  if (!m || /^0x0+$/.test(m[1])) return null;
  return m[1];
}

/** `_NET_WM_PID(CARDINAL) = 1234` → 1234. */
export function parseWmPid(output: string): number | null {
  const m = /_NET_WM_PID\(CARDINAL\)\s*=\s*(\d+)/.exec(output);
  const pid = m ? Number(m[1]) : NaN;
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

const XPROP_STRING = '"((?:[^"\\\\]|\\\\.)*)"';
const WM_CLASS_RE = new RegExp(`WM_CLASS\\([^)]*\\)\\s*=\\s*${XPROP_STRING}(?:\\s*,\\s*${XPROP_STRING})?`);

function unescapeXprop(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** `WM_CLASS(STRING) = "gnome-terminal-server", "Gnome-terminal"` → {instance, className}. */
export function parseWmClass(output: string): { instance: string; className: string } | null {
  const m = WM_CLASS_RE.exec(output);
  if (!m) return null;
  return { instance: unescapeXprop(m[1]), className: unescapeXprop(m[2] ?? '') };
}

/** The Flatpak application ID of a process from its /proc/<pid>/cgroup (systemd app scope), or null. */
export function flatpakAppIdFromCgroup(cgroup: string): string | null {
  const m = /\/app-flatpak-([A-Za-z0-9_.-]+?)-\d+\.scope\s*$/m.exec(cgroup);
  return m ? m[1] : null;
}

export function isWaylandSession(env: NodeJS.ProcessEnv): boolean {
  return env.XDG_SESSION_TYPE === 'wayland' || (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11');
}

export interface ForegroundTrackerOptions {
  log: Logger;
  env?: NodeJS.ProcessEnv;
  /** Our own executable; windows of this app never replace the tracked foreground app. */
  selfExe: string;
  /** Our own process (the browser process owns every window of the app). */
  selfPid?: number;
  run?: CommandRunner;
  /** /proc (tests). */
  procRoot?: string;
}

export class X11ForegroundTracker {
  readonly #log: Logger;
  readonly #env: NodeJS.ProcessEnv;
  readonly #selfExe: string;
  readonly #selfPid: number;
  readonly #run: CommandRunner;
  readonly #proc: string;
  #child: ChildProcess | null = null;
  #unavailable = false;
  #current: ForegroundApp | null = null;
  #lastWindow: string | null = null;
  #buffer = '';

  constructor(opts: ForegroundTrackerOptions) {
    this.#log = opts.log;
    this.#env = opts.env ?? process.env;
    this.#selfExe = opts.selfExe;
    this.#selfPid = opts.selfPid ?? process.pid;
    this.#run = opts.run ?? createCommandRunner(this.#env);
    this.#proc = opts.procRoot ?? '/proc';
  }

  /** HostServices.getForegroundAppPath: the foreground executable; starts tracking on first use. */
  current(): string | null {
    return this.currentApp()?.exe ?? null;
  }

  /** The ForegroundAppHost extension: executable, WM_CLASS and Flatpak ID of the foreground window. */
  currentApp(): ForegroundApp | null {
    if (!this.#child && !this.#unavailable) this.#start();
    return this.#current;
  }

  dispose(): void {
    this.#unavailable = true;
    this.#child?.kill();
    this.#child = null;
  }

  /**
   * The ForegroundAppHost.releaseForegroundApp extension: stop following the active window (the xprop -spy
   * child exits) and forget the last answer. The backend calls it while no theme has a bound app (data
   * minimisation); the next current()/currentApp() starts tracking again.
   */
  release(): void {
    const child = this.#child;
    if (!child) return;
    this.#child = null;
    this.#current = null;
    this.#lastWindow = null;
    this.#buffer = '';
    child.kill();
    this.#log.debug('Foreground app tracking paused (no app-bound theme)');
  }

  /** An xprop -spy child is running (tests). */
  get tracking(): boolean {
    return this.#child !== null;
  }

  /** Feed one `xprop -spy` line (the watcher's stdout; exposed for tests). */
  onActiveWindowLine(line: string): Promise<void> {
    const win = parseActiveWindow(line);
    if (!win || win === this.#lastWindow) return Promise.resolve();
    this.#lastWindow = win;
    return this.#resolve(win);
  }

  #start(): void {
    if (isWaylandSession(this.#env) || !this.#env.DISPLAY) {
      this.#unavailable = true;
      this.#log.info('Foreground app tracking unavailable (not an X11 session); app-bound themes are inert');
      return;
    }
    const child = spawnTied('xprop', ['-root', '-spy', '_NET_ACTIVE_WINDOW'], { stdio: ['ignore', 'pipe', 'ignore'], env: this.#env });
    this.#child = child;
    child.on('error', (e) => {
      if (this.#child !== child) return; // released meanwhile
      this.#unavailable = true;
      this.#child = null;
      this.#log.warn(`Foreground app tracking unavailable (xprop: ${e.message}); install x11-utils to enable app-bound themes`);
    });
    child.on('exit', (code) => {
      if (this.#child === child) {
        this.#child = null;
        this.#unavailable = true;
        this.#log.warn(`xprop exited (${String(code)}); foreground app tracking stopped`);
      }
    });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (this.#child !== child) return; // output still buffered from a released watcher
      this.#buffer += chunk;
      let nl: number;
      while ((nl = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        void this.onActiveWindowLine(line);
      }
    });
  }

  async #resolve(win: string): Promise<void> {
    const r = await this.#run('xprop', ['-id', win, '_NET_WM_PID', 'WM_CLASS'], { timeoutMs: 1000 });
    if (!r.ok || win !== this.#lastWindow) return;
    const pid = parseWmPid(r.stdout);
    const cls = parseWmClass(r.stdout);
    const wmClass = cls ? cls.className || cls.instance || null : null;
    let exe: string | null = null;
    let appId: string | null = null;
    if (pid !== null) {
      if (pid === this.#selfPid) return;
      exe = await readlink(`${this.#proc}/${pid}/exe`).catch(() => null);
      appId = flatpakAppIdFromCgroup(await readFile(`${this.#proc}/${pid}/cgroup`, 'utf8').catch(() => ''));
    }
    if (win !== this.#lastWindow || (exe !== null && exe === this.#selfExe)) return;
    if (exe === null && wmClass === null) return;
    const next: ForegroundApp = { exe, wmClass, appId };
    const prev = this.#current;
    if (!prev || prev.exe !== exe || prev.wmClass !== wmClass || prev.appId !== appId) this.#log.debug('Foreground app', exe, wmClass ?? '', appId ?? '');
    this.#current = next;
  }
}
