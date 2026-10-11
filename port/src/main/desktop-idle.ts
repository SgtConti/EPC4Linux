// HostServices.shouldReleaseScreenCapture: let the desktop blank, lock and sleep while FollowVideo runs.
//
// Chromium holds a "prevent display sleep" wake lock for as long as a desktop capture stream is open
// (content/browser/media/capture/desktop_capture_device.cc, reason "Native desktop capture"). On Linux that is
// an idle inhibitor of the session manager (org.gnome.SessionManager.Inhibit, flag 8; also Cinnamon and MATE)
// or org.freedesktop.ScreenSaver, plus XScreenSaverSuspend on X11. Electron offers no way to drop it, and
// another process cannot remove it. FollowVideo keeps its capture session open while the user is away
// (follow-video.ts: the uploads pause, the session stays), so the display never went to sleep: the
// power-management timeout of the desktop had no effect while FollowVideo was the effect.
//
// The only release is closing the stream. This watch says when: the input idle time (idle-time.ts) has
// reached the desktop's own idle timeout less DESKTOP_IDLE_MARGIN_S, and no other application inhibits idle.
// The ambiglow service then stops the capture session and starts it again at the next input. Closing it
// before the timeout matters: the session manager re-arms its idle alarm when the inhibitor goes, and an
// alarm whose time has passed only fires after the next input.
//
// Closing the capture resets the X server's idle counter itself (seen on Cinnamon X11: 285 s → 0 the moment
// the stream ends), so after a release a short idle time is no sign of input. The release holds while the idle
// time keeps up with the time since the release (less DESKTOP_IDLE_RESET_SLACK_S); input after the close makes
// it fall behind, and only that opens the capture again. Taking the drop for input reopened the capture a
// second later, every 285 s, and the display never slept. The desktop's own timeout then counts from the close,
// so on X11 a release at timeout less the margin blanked the display only after about twice the timeout (285 s
// + 300 s; 2026-10-10, user away 5 min and the display stayed on). On X11 the release therefore comes at
// DESKTOP_IDLE_MIN_S of idle time, and the display blanks about that much after the desktop's timeout. On
// Wayland the release stays at timeout less the margin: the reset is an X server's, and there an early release
// could bring the screen-share dialog back after every short pause.
//
// Desktop timeout (the shortest of the keys that apply; 0 = never):
//   Cinnamon  org.cinnamon.desktop.session idle-delay (s), org.cinnamon.settings-daemon.plugins.power
//             sleep-display-ac / sleep-display-battery (s)
//   GNOME     org.gnome.desktop.session idle-delay (s): the screen blanks then (also Unity, Budgie, Pantheon)
//   MATE      org.mate.session idle-delay (min), org.mate.power-manager sleep-display-ac / -battery (s)
//   other     (KDE, Xfce, …; or gsettings missing) DESKTOP_IDLE_FALLBACK_S
// read once per idle stretch, so a change in the desktop's settings applies from the next one.
//
// Other inhibitors: the session manager's GetInhibitors, minus this app's own (app id = our executable).
// A video player or browser playing a film keeps the display on itself, and the lights keep following the
// picture. Where the list cannot be read (no org.gnome.SessionManager), nothing else is assumed to inhibit.

import { basename } from 'node:path';
import type { Logger } from '../backend/types.ts';
import type { CommandRunner } from './child-process.ts';
import { parseGVariant } from './gvariant.ts';

/** How long before the desktop's timeout the capture is closed. */
export const DESKTOP_IDLE_MARGIN_S = 15;
/** Never earlier than this much idle time, whatever the desktop says; on X11 the release comes at this. */
export const DESKTOP_IDLE_MIN_S = 30;
/** The timeout assumed where the desktop's is unknown (KDE, Xfce, …): the common 5 min screen-off default. */
export const DESKTOP_IDLE_FALLBACK_S = 300;
/** Idle time from which a stretch counts (the desktop settings are re-read once per stretch). */
export const DESKTOP_IDLE_STRETCH_S = 20;
/** The inhibitor list is read from this long before the release and every DESKTOP_IDLE_RECHECK_MS after that. */
export const DESKTOP_IDLE_LOOKAHEAD_S = 20;
export const DESKTOP_IDLE_RECHECK_MS = 10_000;
/** After a release: input counts once the idle time falls this far behind the time since the release. */
export const DESKTOP_IDLE_RESET_SLACK_S = 5;
/** org.gnome.SessionManager inhibit flag: "Inhibit the session being marked as idle". */
export const INHIBIT_IDLE = 8;

export interface DesktopIdleKey {
  schema: string;
  key: string;
  /** Seconds per unit of the value. */
  unit: number;
}

const k = (schema: string, key: string, unit = 1): DesktopIdleKey => ({ schema, key, unit });

/** The gsettings keys that hold the idle timeouts of the session's desktop; null when it is not one we know. */
export function desktopIdleKeys(env: NodeJS.ProcessEnv, onBattery: boolean): DesktopIdleKey[] | null {
  const desktops = (env.XDG_CURRENT_DESKTOP ?? '').toUpperCase().split(':');
  const power = onBattery ? 'sleep-display-battery' : 'sleep-display-ac';
  if (desktops.some((d) => d === 'X-CINNAMON' || d === 'CINNAMON')) {
    return [k('org.cinnamon.desktop.session', 'idle-delay'), k('org.cinnamon.settings-daemon.plugins.power', power)];
  }
  if (desktops.includes('MATE')) return [k('org.mate.session', 'idle-delay', 60), k('org.mate.power-manager', power)];
  if (desktops.some((d) => d === 'GNOME' || d === 'UNITY' || d === 'BUDGIE' || d === 'PANTHEON')) return [k('org.gnome.desktop.session', 'idle-delay')];
  return null;
}

/** `uint32 900` / `300` → seconds; 0 or negative → null (never). */
export function parseTimeout(reply: string, unit: number): number | null {
  const v = parseGVariant(reply.trim());
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`unexpected gsettings value ${reply.trim()}`);
  return v > 0 ? v * unit : null;
}

const SM = ['--session', '--dest', 'org.gnome.SessionManager'];

export interface DesktopIdleOptions {
  log: Logger;
  run: CommandRunner;
  env: NodeJS.ProcessEnv;
  /** Input idle time in seconds (IdleTimeSource.seconds). */
  idleSeconds: () => number;
  /** powerMonitor.isOnBatteryPower */
  onBattery: () => boolean;
  /** process.execPath: our own inhibitor's app id. */
  selfExe: string;
  now?: () => number;
}

export class DesktopIdleWatch {
  readonly #o: DesktopIdleOptions;
  readonly #now: () => number;
  /** Seconds; null = the desktop never goes idle; undefined = not read yet. */
  #timeout: number | null | undefined = undefined;
  #stretch = false;
  /** Another application inhibits idle: true/false from the last read, null = not read in this stretch. */
  #others: boolean | null = null;
  #nextInhibitorRead = 0;
  #inflight = false;
  /** now() of the release that holds, null while the capture may be open. */
  #releasedAt: number | null = null;
  /** The close resets the idle count the desktop's timeout runs on (X11): release early. */
  readonly #early: boolean;

  constructor(o: DesktopIdleOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#early = o.env.XDG_SESSION_TYPE === 'x11';
    void this.#readTimeout();
  }

  /** The desktop's idle timeout in seconds as last read (null = never; undefined = not read yet). */
  get timeoutSeconds(): number | null | undefined {
    return this.#timeout;
  }

  /** Whether an open screen capture should be closed now so that the desktop can go idle. Polled every second. */
  shouldRelease(): boolean {
    let idle = 0;
    try {
      const s = this.#o.idleSeconds();
      if (Number.isFinite(s) && s > 0) idle = s;
    } catch {
      // no idle source yet
    }
    if (this.#releasedAt !== null) {
      // The close reset the idle counter: only idle time shorter than the time since then is input.
      const since = (this.#now() - this.#releasedAt) / 1000;
      if (idle >= since - DESKTOP_IDLE_RESET_SLACK_S) {
        this.#readInhibitors();
        if (this.#others !== true) return true;
      }
      this.#releasedAt = null;
      if (idle >= DESKTOP_IDLE_STRETCH_S) return false; // another application inhibits now: open, same stretch
    }
    if (idle < DESKTOP_IDLE_STRETCH_S) {
      this.#stretch = false;
      this.#others = null;
      this.#nextInhibitorRead = 0;
      return false;
    }
    if (!this.#stretch) {
      this.#stretch = true;
      void this.#readTimeout();
    }
    const timeout = this.#timeout;
    if (timeout === null || timeout === undefined) return false;
    const at = this.#early ? DESKTOP_IDLE_MIN_S : Math.max(DESKTOP_IDLE_MIN_S, timeout - DESKTOP_IDLE_MARGIN_S);
    if (idle < at - DESKTOP_IDLE_LOOKAHEAD_S) return false;
    this.#readInhibitors();
    if (idle < at || this.#others === true) return false;
    this.#releasedAt = this.#now();
    return true;
  }

  async #readTimeout(): Promise<void> {
    const keys = desktopIdleKeys(this.#o.env, this.#safeOnBattery());
    let timeout: number | null = DESKTOP_IDLE_FALLBACK_S;
    if (keys) {
      const values: (number | null)[] = [];
      for (const key of keys) {
        const r = await this.#o.run('gsettings', ['get', key.schema, key.key], { timeoutMs: 2000 });
        if (!r.ok) continue;
        try {
          values.push(parseTimeout(r.stdout, key.unit));
        } catch (e) {
          this.#o.log.warn(`${key.schema} ${key.key}: ${(e as Error).message}`);
        }
      }
      if (values.length > 0) {
        const set = values.filter((v): v is number => v !== null);
        timeout = set.length > 0 ? Math.min(...set) : null;
      }
    }
    if (timeout !== this.#timeout) {
      this.#o.log.info(timeout === null ? 'desktop idle timeout: never' : `desktop idle timeout: ${timeout} s${keys ? '' : ' (assumed)'}`);
    }
    this.#timeout = timeout;
  }

  #safeOnBattery(): boolean {
    try {
      return this.#o.onBattery();
    } catch {
      return false;
    }
  }

  #readInhibitors(): void {
    const at = this.#now();
    if (this.#inflight || at < this.#nextInhibitorRead) return;
    this.#inflight = true;
    this.#nextInhibitorRead = at + DESKTOP_IDLE_RECHECK_MS;
    void this.#othersInhibit().then((others) => {
      this.#inflight = false;
      // The user came back meanwhile: the stretch is over, and its answer with it.
      if (!this.#stretch) return;
      if (others !== this.#others && others) this.#o.log.info('another application keeps the display on; the screen capture stays open');
      this.#others = others;
    });
  }

  /** Whether an inhibitor other than ours holds the session's idle; false when the list cannot be read. */
  async #othersInhibit(): Promise<boolean> {
    const run = this.#o.run;
    const list = await run('gdbus', ['call', ...SM, '--object-path', '/org/gnome/SessionManager', '--method', 'org.gnome.SessionManager.GetInhibitors'], { timeoutMs: 2000 });
    if (!list.ok) return false;
    let paths: string[];
    try {
      const v = parseGVariant(list.stdout.trim());
      const arr = Array.isArray(v) ? v[0] : null;
      paths = Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      return false;
    }
    const self = basename(this.#o.selfExe);
    for (const path of paths) {
      const call = (method: string) => run('gdbus', ['call', ...SM, '--object-path', path, '--method', `org.gnome.SessionManager.Inhibitor.${method}`], { timeoutMs: 2000 });
      const [app, flags] = await Promise.all([call('GetAppId'), call('GetFlags')]);
      if (!app.ok || !flags.ok) continue; // gone meanwhile
      try {
        const id = first(parseGVariant(app.stdout.trim()));
        const f = first(parseGVariant(flags.stdout.trim()));
        if (typeof f !== 'number' || (f & INHIBIT_IDLE) === 0) continue;
        if (typeof id === 'string' && (id === this.#o.selfExe || basename(id) === self)) continue;
        return true;
      } catch {
        // unreadable entry: not counted
      }
    }
    return false;
  }
}

function first(v: unknown): unknown {
  return Array.isArray(v) ? v[0] : v;
}
