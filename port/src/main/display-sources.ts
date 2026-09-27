// Mode sources of HostServices.getDisplayMode (20-monitor-io-linux-consolidation §3.5 step 1) and the
// provider that answers the backend synchronously from their last snapshot.
//
//   a. Mutter  `gdbus call … org.gnome.Mutter.DisplayConfig.GetCurrentState` (GNOME, Wayland and X11): the
//              monitor's `is-current` mode (width, height, refresh_rate) and the transform of the logical
//              monitor that contains it; monitors are matched by their spec (connector, vendor, product,
//              serial).
//   b. XRandR  `xrandr --current --verbose` (X11): the output's `*current` mode (dot clock, h/v totals,
//              Interlace/DoubleScan) and rotation, matched by the output's EDID property. `--current` reads the
//              server's state without re-probing the outputs (no DDC traffic, no flicker).
//   c. libdrm  drm-modes.ts, only when neither a nor b answered (a D-Bus-less or CLI-less session): the CRTC
//              mode of the connector named by the backend, orientation "0°".
// Session order: Wayland → a; X11 → b, then a on GNOME. When no source is available at all (no D-Bus, no
// xrandr, no readable /dev/dri) the Electron screen API is the last resort (deviation: §3.5 has no such
// source; it only answers when the display is unambiguous). A source that answers but does not list the
// monitor, or lists it without a current mode (disabled output), gives null: the backend then keeps ""
// (§3.5 step 6) and a warning is logged once.
//
// getDisplayMode is synchronous (types.ts HostServices), so the provider keeps the last snapshot and
// refreshes it asynchronously: at start, on every raw display event (Electron screen, udev drm, Mutter
// MonitorsChanged — before the 2 s displayChange debounce and the backend's 5 s settle, so the backend's
// re-read after a hotplug sees the new mode), again settleMs later (the compositor applies a new
// configuration after the kernel event), and in the background when a lookup finds it older than maxAgeMs.

import type { DiscoveredMonitor, DisplayModeInfo, Logger } from '../backend/types.ts';
import type { CommandRunner } from './child-process.ts';
import { isGnomeSession, MUTTER_DISPLAY_CONFIG } from './display-watch.ts';
import {
  type DisplayLike,
  exactRefreshHz,
  formatElectronDisplay,
  formatMode,
  matchSnapshot,
  type ModeSnapshot,
  type ModeSourceName,
  pickDisplayForMonitor,
  rotationSteps,
} from './display-mode.ts';
import { isWaylandSession } from './foreground-app.ts';
import { type GVariantValue, parseGVariant } from './gvariant.ts';

// ───────────────────────────── a. Mutter ─────────────────────────────

export const MUTTER_GET_CURRENT_STATE_ARGS: readonly string[] = Object.freeze([
  'call',
  '--session',
  '--dest',
  MUTTER_DISPLAY_CONFIG,
  '--object-path',
  '/org/gnome/Mutter/DisplayConfig',
  '--method',
  `${MUTTER_DISPLAY_CONFIG}.GetCurrentState`,
]);

function list(v: GVariantValue | undefined): GVariantValue[] {
  return Array.isArray(v) ? v : [];
}

function text(v: GVariantValue | undefined): string {
  return typeof v === 'string' ? v : '';
}

/**
 * GetCurrentState → (u serial, a((ssss)a(siiddada{sv})a{sv}) monitors, a(iiduba(ssss)a{sv}) logical_monitors,
 * a{sv} properties). A monitor outside every logical monitor is connected but disabled (mode null).
 */
export function parseMutterState(reply: string): ModeSnapshot[] {
  const root = list(parseGVariant(reply));
  if (root.length < 3) throw new Error('unexpected GetCurrentState reply');
  const transformOf = new Map<string, number>();
  for (const lm of list(root[2])) {
    const [, , , transform, , specs] = list(lm);
    for (const spec of list(specs)) transformOf.set(text(list(spec)[0]), typeof transform === 'number' ? transform : 0);
  }
  return list(root[1]).map((monitor): ModeSnapshot => {
    const [spec, modes] = list(monitor);
    const [connector, vendor, product, serial] = list(spec).map(text);
    const current = list(modes).find((m) => {
      const props = list(m)[6];
      return props instanceof Map && props.get('is-current') === true;
    });
    const active = transformOf.has(connector) && current !== undefined;
    const [, width, height, rate] = list(current);
    return {
      source: 'mutter',
      connector,
      identity: { vendor, product, serial },
      mode: active && typeof width === 'number' && typeof height === 'number' ? { width, height, exactHz: typeof rate === 'number' ? rate : 0 } : null,
      rotation: rotationSteps(transformOf.get(connector) ?? 0),
    };
  });
}

// ───────────────────────────── b. XRandR ─────────────────────────────

export const XRANDR_ARGS: readonly string[] = Object.freeze(['--current', '--verbose']);

const RANDR_ROTATIONS: Readonly<Record<string, number>> = { normal: 0, left: 1, inverted: 2, right: 3 };

interface XrandrOutput {
  name: string;
  rotation: number;
  enabled: boolean;
  edidHex: string;
  mode: { width: number; height: number; exactHz: number } | null;
}

/** `xrandr --current --verbose` → the connected outputs. */
export function parseXrandrVerbose(output: string): ModeSnapshot[] {
  const outputs: XrandrOutput[] = [];
  let cur: XrandrOutput | null = null;
  let inEdid = false;
  let pending: { clockMHz: number; flags: string; current: boolean; width?: number; height?: number; htotal?: number } | null = null;
  for (const line of output.split('\n')) {
    const head = /^(\S+) (connected|disconnected|unknown connection)(.*)$/.exec(line);
    if (head) {
      inEdid = false;
      pending = null;
      cur = null;
      if (head[2] !== 'connected') continue;
      // " primary 3440x1440+0+0 (0x4b) left X axis (normal left inverted right x axis y axis) 800mm x 335mm"
      const rest = head[3].replace(/\(0x[0-9a-fA-F]+\)/, '');
      const cut = rest.indexOf('(');
      const before = cut >= 0 ? rest.slice(0, cut) : rest;
      const rotation = /\b(normal|left|inverted|right)\b/.exec(before)?.[1] ?? 'normal';
      cur = { name: head[1], rotation: RANDR_ROTATIONS[rotation], enabled: /\d+x\d+[+-]\d+[+-]\d+/.test(before), edidHex: '', mode: null };
      outputs.push(cur);
      continue;
    }
    if (!cur) continue;
    if (/^\t[^\t]/.test(line)) {
      inEdid = /^\tEDID(_DATA)?:\s*$/.test(line);
      continue;
    }
    const hexLine = /^\t\t([0-9a-fA-F]+)\s*$/.exec(line);
    if (hexLine) {
      if (inEdid) cur.edidHex += hexLine[1];
      continue;
    }
    const mode = /^ {2}\S+ \(0x[0-9a-fA-F]+\)\s+([\d.]+)MHz(.*)$/.exec(line);
    if (mode) {
      inEdid = false;
      pending = { clockMHz: Number(mode[1]), flags: mode[2], current: /\*current\b/.test(mode[2]) };
      continue;
    }
    const h = /^\s+h: width\s+(\d+)\b.*\btotal\s+(\d+)/.exec(line);
    if (h && pending) {
      pending.width = Number(h[1]);
      pending.htotal = Number(h[2]);
      continue;
    }
    const v = /^\s+v: height\s+(\d+)\b.*\btotal\s+(\d+)/.exec(line);
    if (v && pending) {
      if (pending.current && cur.enabled && pending.width !== undefined && pending.htotal !== undefined) {
        cur.mode = {
          width: pending.width,
          height: Number(v[1]),
          exactHz: exactRefreshHz({
            clockKHz: pending.clockMHz * 1000,
            htotal: pending.htotal,
            vtotal: Number(v[2]),
            interlace: /\bInterlace\b/.test(pending.flags),
            doubleScan: /\bDoubleScan\b/.test(pending.flags),
          }),
        };
      }
      pending = null;
    }
  }
  return outputs.map((o) => ({
    source: 'xrandr',
    connector: o.name,
    ...(o.edidHex.length >= 256 && o.edidHex.length % 2 === 0 ? { edid: Uint8Array.from(Buffer.from(o.edidHex, 'hex')) } : {}),
    mode: o.mode,
    rotation: o.rotation,
  }));
}

// ───────────────────────────── provider ─────────────────────────────

/** A second refresh after a display event: the compositor applies a new configuration after the kernel event. */
export const DISPLAY_SETTLE_REFRESH_MS = 3000;
/** A lookup on an older snapshot refreshes it in the background (for changes no event reported). */
export const DISPLAY_SNAPSHOT_MAX_AGE_MS = 10_000;

type CliSource = 'mutter' | 'xrandr';

export interface DisplayModeProviderOptions {
  log: Logger;
  run: CommandRunner;
  env?: NodeJS.ProcessEnv;
  /** Source c; null disables it. */
  drm: (() => Promise<ModeSnapshot[] | null>) | null;
  /** Electron's screen.getAllDisplays(), for the last resort. */
  electronDisplays: () => readonly DisplayLike[];
  now?: () => number;
  settleMs?: number;
  maxAgeMs?: number;
}

interface Snapshot {
  at: number;
  /** The sources that answered, in lookup order. */
  available: ModeSourceName[];
  snapshots: ModeSnapshot[];
}

/** The CLI sources of a session, in lookup order (§3.5 step 1). */
export function cliSourcesFor(env: NodeJS.ProcessEnv): CliSource[] {
  const gnome = isGnomeSession(env);
  if (isWaylandSession(env)) return gnome ? ['mutter'] : [];
  if (!env.DISPLAY) return gnome ? ['mutter'] : [];
  return gnome ? ['xrandr', 'mutter'] : ['xrandr'];
}

export class DisplayModeProvider {
  readonly #o: DisplayModeProviderOptions;
  readonly #sources: CliSource[];
  readonly #now: () => number;
  #state: Snapshot | null = null;
  #running: Promise<void> | null = null;
  #again = false;
  #settle: NodeJS.Timeout | null = null;
  #disposed = false;
  /** Source → last failure logged (so a missing tool is reported once, a recovery again). */
  readonly #sourceErrors = new Map<string, string>();
  /** Monitor key → last "no mode" reason logged. */
  readonly #monitorWarnings = new Map<string, string>();

  constructor(o: DisplayModeProviderOptions) {
    this.#o = o;
    this.#sources = cliSourcesFor(o.env ?? process.env);
    this.#now = o.now ?? Date.now;
  }

  /** The CLI sources this session uses (diagnostics, tests). */
  get sources(): readonly CliSource[] {
    return this.#sources;
  }

  /** A display event (or the start): refresh now and once more after the settle time. */
  refresh(): void {
    if (this.#disposed) return;
    void this.refreshNow();
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = setTimeout(() => {
      this.#settle = null;
      void this.refreshNow();
    }, this.#o.settleMs ?? DISPLAY_SETTLE_REFRESH_MS);
    this.#settle.unref?.();
  }

  /** Refresh (joined with a running refresh, which then runs once more); resolves with current data. */
  refreshNow(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    const running = (async () => {
      do {
        this.#again = false;
        try {
          this.#state = await this.#collect();
        } catch (e) {
          this.#o.log.warn('Display mode refresh failed', e);
        }
      } while (this.#again && !this.#disposed);
    })().finally(() => {
      if (this.#running === running) this.#running = null;
    });
    this.#running = running;
    return running;
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#settle) clearTimeout(this.#settle);
    this.#settle = null;
  }

  /** HostServices.getDisplayMode. */
  get(monitor: DiscoveredMonitor): DisplayModeInfo | null {
    const state = this.#state;
    if (!this.#running && (!state || this.#now() - state.at > (this.#o.maxAgeMs ?? DISPLAY_SNAPSHOT_MAX_AGE_MS))) void this.refreshNow();
    if (state && state.available.length > 0) {
      for (const source of state.available) {
        const hit = matchSnapshot(
          state.snapshots.filter((s) => s.source === source),
          monitor,
        );
        if (!hit) continue;
        if (hit.mode) return this.#found(monitor, formatMode(hit.mode, hit.rotation));
        return this.#missing(monitor, `${source} shows ${hit.connector} without a current mode`);
      }
      return this.#missing(monitor, `not found by ${state.available.join(', ')}`);
    }
    let displays: readonly DisplayLike[] = [];
    try {
      displays = this.#o.electronDisplays();
    } catch {
      // screen is not available before app ready
    }
    const display = pickDisplayForMonitor(displays, monitor);
    if (display) return this.#found(monitor, formatElectronDisplay(display));
    return this.#missing(monitor, state ? 'no display mode source available and no unambiguous Electron display' : 'no display snapshot yet');
  }

  #found(monitor: DiscoveredMonitor, mode: DisplayModeInfo): DisplayModeInfo {
    this.#monitorWarnings.delete(monitor.key);
    return mode;
  }

  #missing(monitor: DiscoveredMonitor, reason: string): null {
    if (this.#monitorWarnings.get(monitor.key) !== reason) {
      this.#monitorWarnings.set(monitor.key, reason);
      this.#o.log.warn(`Display mode of ${monitor.key} (${monitor.connector ?? 'no connector'}) unknown: ${reason}; resolution and refresh rate stay empty`);
    }
    return null;
  }

  async #collect(): Promise<Snapshot> {
    const results = await Promise.all(this.#sources.map(async (s) => [s, await this.#query(s)] as const));
    const available: ModeSourceName[] = [];
    const snapshots: ModeSnapshot[] = [];
    for (const [source, snaps] of results) {
      if (!snaps) continue;
      available.push(source);
      snapshots.push(...snaps);
    }
    if (available.length === 0 && this.#o.drm) {
      let drm: ModeSnapshot[] | null = null;
      try {
        drm = await this.#o.drm();
      } catch (e) {
        this.#sourceFailed('drm', (e as Error).message);
      }
      if (drm) {
        this.#sourceOk('drm');
        available.push('drm');
        snapshots.push(...drm);
      } else this.#sourceFailed('drm', 'no readable DRM device');
    }
    this.#o.log.debug(
      `Display modes (${available.join(', ') || 'no source'}): ${snapshots.map((s) => `${s.source}:${s.connector}=${s.mode ? `${s.mode.width}x${s.mode.height}@${s.mode.exactHz.toFixed(3)}/r${s.rotation}` : 'off'}`).join(' ')}`,
    );
    return { at: this.#now(), available, snapshots };
  }

  async #query(source: CliSource): Promise<ModeSnapshot[] | null> {
    const [command, args, parse] =
      source === 'mutter'
        ? (['gdbus', MUTTER_GET_CURRENT_STATE_ARGS, parseMutterState] as const)
        : (['xrandr', XRANDR_ARGS, parseXrandrVerbose] as const);
    const r = await this.#o.run(command, args);
    if (!r.ok) {
      this.#sourceFailed(source, `${command}: ${r.error ?? 'failed'}`);
      return null;
    }
    try {
      const snaps = parse(r.stdout);
      this.#sourceOk(source);
      return snaps;
    } catch (e) {
      this.#sourceFailed(source, `unreadable ${command} output: ${(e as Error).message}`);
      return null;
    }
  }

  #sourceFailed(source: string, why: string): void {
    if (this.#sourceErrors.get(source) === why) return;
    this.#sourceErrors.set(source, why);
    this.#o.log.info(`Display mode source ${source} unavailable (${why})`);
  }

  #sourceOk(source: string): void {
    if (this.#sourceErrors.delete(source)) this.#o.log.info(`Display mode source ${source} available again`);
  }
}
