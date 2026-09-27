// HostServices.getIdleSeconds: seconds since the last user input, for "turn off lights when idle"
// (09 §11; the backend's GlobalOper.CheckIdle polls it every second, src/backend/ambiglow/idle.ts).
//
// Vendor: GetLastInputInfo (13 §3). Port: Electron's powerMonitor.getSystemIdleTime(), which Chromium
// answers from the XScreenSaver extension on X11 and from the compositor's idle protocol on Wayland. GNOME's
// compositor offers no such Wayland protocol to Chromium, so on GNOME Wayland the value would stay 0 and the
// lights would never go off. There the source is Mutter's own idle monitor as well:
//   gdbus call --session --dest org.gnome.Mutter.IdleMonitor --object-path /org/gnome/Mutter/IdleMonitor/Core
//              --method org.gnome.Mutter.IdleMonitor.GetIdletime            → (uint64 <ms>,)
// and the answer is the larger of the two.
//
// getIdleSeconds() is synchronous and called every second, so Mutter is polled in the background and only
// as often as the decision needs: the backend's shortest threshold is one minute
// (Setting_TurnOffLightsWhenIdleDuration ≥ 1, "at last 1 minutes"). Between polls the value is extrapolated
// (last idle time + time since the poll), an upper bound that is exact while no input happens. The next
// poll is due when that bound could reach 55 s, and every second from then on, so the lights go off within
// about a second of the threshold and come back within about a second of the next input — the vendor's own
// 1 s polling latency — while an active user costs one D-Bus call per ~55 s.

import type { Logger } from '../backend/types.ts';
import type { CommandRunner } from './child-process.ts';
import { isGnomeSession } from './display-watch.ts';
import { isWaylandSession } from './foreground-app.ts';
import { parseGVariant } from './gvariant.ts';

export const MUTTER_IDLE_ARGS: readonly string[] = Object.freeze([
  'call',
  '--session',
  '--dest',
  'org.gnome.Mutter.IdleMonitor',
  '--object-path',
  '/org/gnome/Mutter/IdleMonitor/Core',
  '--method',
  'org.gnome.Mutter.IdleMonitor.GetIdletime',
]);

/** From this idle time on, Mutter is polled every IDLE_FAST_POLL_MS (below the backend's 60 s minimum). */
export const IDLE_NEAR_THRESHOLD_MS = 55_000;
export const IDLE_FAST_POLL_MS = 1000;
/** Back-off after a failed poll (a D-Bus hiccup), before the next attempt. */
export const IDLE_RETRY_MS = 30_000;

/** `(uint64 1234,)` → 1234. */
export function parseIdletime(reply: string): number {
  const v = parseGVariant(reply);
  const ms = Array.isArray(v) ? v[0] : v;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new Error('unexpected GetIdletime reply');
  return ms;
}

/** Whether Mutter's idle monitor is needed: GNOME on Wayland. */
export function useMutterIdle(env: NodeJS.ProcessEnv): boolean {
  return isWaylandSession(env) && isGnomeSession(env);
}

export interface IdleTimeOptions {
  log: Logger;
  /** powerMonitor.getSystemIdleTime */
  electronIdleSeconds: () => number;
  /** Also ask Mutter (useMutterIdle). */
  mutter: boolean;
  run: CommandRunner;
  now?: () => number;
}

export class IdleTimeSource {
  readonly #o: IdleTimeOptions;
  readonly #now: () => number;
  #mutter: boolean;
  #last: { ms: number; at: number } | null = null;
  #nextPollAt = 0;
  #inflight = false;

  constructor(o: IdleTimeOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#mutter = o.mutter;
  }

  /** Whether Mutter is (still) consulted. */
  get mutter(): boolean {
    return this.#mutter;
  }

  /** HostServices.getIdleSeconds */
  seconds(): number {
    let electron = 0;
    try {
      const s = this.#o.electronIdleSeconds();
      if (Number.isFinite(s) && s > 0) electron = s;
    } catch {
      // powerMonitor before app ready
    }
    if (!this.#mutter) return electron;
    this.#poll();
    const last = this.#last;
    const estimate = last ? Math.floor((last.ms + Math.max(0, this.#now() - last.at)) / 1000) : 0;
    return Math.max(electron, estimate);
  }

  #poll(): void {
    const at = this.#now();
    if (this.#inflight || at < this.#nextPollAt) return;
    this.#inflight = true;
    void this.#o.run('gdbus', MUTTER_IDLE_ARGS, { timeoutMs: 2000 }).then((r) => {
      this.#inflight = false;
      if (!r.ok) {
        if (r.error === 'ENOENT' || /ServiceUnknown|UnknownMethod|UnknownObject|No such interface/i.test(r.error ?? '')) {
          this.#mutter = false;
          this.#o.log.info(`Mutter idle monitor unavailable (${r.error}); idle time from Electron only`);
        } else this.#nextPollAt = at + IDLE_RETRY_MS;
        return;
      }
      let ms: number;
      try {
        ms = parseIdletime(r.stdout);
      } catch (e) {
        this.#nextPollAt = at + IDLE_RETRY_MS;
        this.#o.log.warn(`Mutter idle monitor: ${(e as Error).message}`);
        return;
      }
      // `at` is when the call was made: the extrapolation then never underestimates.
      this.#last = { ms, at };
      this.#nextPollAt = at + (ms >= IDLE_NEAR_THRESHOLD_MS ? IDLE_FAST_POLL_MS : Math.max(IDLE_FAST_POLL_MS, IDLE_NEAR_THRESHOLD_MS - ms));
    });
  }
}
