// Ambiglow from the command line (port feature, not in the vendor app): `evnia-precision-center --ambiglow=<value>`
// sets the display's ENE effect, for scripts such as a media player hook (packaging/deb/examples/mpv-ambiglow.lua):
//
//   --ambiglow=FollowVideo    an effect (FollowVideo, FollowAudio, ColorShift, ColorWave, Breathing, StarryNight,
//                             Static; case, '-' and '_' ignored: follow-video works too), switched on
//   --ambiglow=on|off         the Ambiglow on or off, the effect kept
//   --ambiglow=restore        back to the effect and on/off state before the first --ambiglow of this app run
//
// A running app gets the command through Electron's second-instance event (the second process exits at once and
// shows no window); an app not yet running starts hidden (like --openAsHidden) and applies it once the monitor is
// loaded. There is no reply: the outcome is in the main log (~/.config/evnia/logs). `--ambiglow=FOO` keeps its value
// in one argv entry; Chromium may move a separate value word behind other arguments of a second instance, so the
// `--ambiglow FOO` form is accepted only when the value directly follows.
//
// restore: the first set of an app run remembers the state before it; restore puts that back and forgets it. When
// the effect was changed in between by something else (the Ambiglow page, a profile), the user's choice wins: restore
// only forgets. Commands run one after another in the order they arrived.
//
// Pure apart from the injected backend, sleep and clock, so the unit tests drive it without Electron.

import type { AmbiglowRemoteState } from '../backend/ambiglow/service.ts';
import type { Logger } from '../backend/types.ts';
import { DISPLAY_EFFECTS, effectTypeValue } from '../backend/monitor/model/effect.ts';

export const AMBIGLOW_SWITCH = '--ambiglow';

/** How long a command waits for the backend to load a display with an ENE (USB discovery, first VCP read). */
export const AMBIGLOW_READY_TIMEOUT_MS = 30_000;
const AMBIGLOW_READY_POLL_MS = 250;

export type AmbiglowCommand = { kind: 'set'; target: Partial<AmbiglowRemoteState> } | { kind: 'restore' };

const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, '');

/** The effect type of a command-line effect name, or null. */
function effectByName(value: string): number | null {
  const name = DISPLAY_EFFECTS.find((n) => normalize(n) === normalize(value));
  return name ? effectTypeValue(name) : null;
}

/** The --ambiglow command of `argv` (the last one wins), null without one, or an error message for a bad value. */
export function parseAmbiglowCommand(argv: readonly string[]): AmbiglowCommand | string | null {
  let value: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(`${AMBIGLOW_SWITCH}=`)) value = arg.slice(AMBIGLOW_SWITCH.length + 1);
    else if (arg === AMBIGLOW_SWITCH) value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? argv[++i] : '';
  }
  if (value === null) return null;
  const v = normalize(value.trim());
  if (v === 'restore') return { kind: 'restore' };
  if (v === 'on') return { kind: 'set', target: { enabled: true } };
  if (v === 'off') return { kind: 'set', target: { enabled: false } };
  const effect = effectByName(v);
  if (effect !== null) return { kind: 'set', target: { effect, enabled: true } };
  return `${AMBIGLOW_SWITCH}: unknown value "${value}" (use on, off, restore or one of ${DISPLAY_EFFECTS.join(', ')})`;
}

/** What the command line needs of the ambiglow service (AmbiglowServiceImpl). */
export interface RemoteEffects {
  remoteEffect(): Promise<AmbiglowRemoteState | null>;
  setRemoteEffect(target: Partial<AmbiglowRemoteState>): Promise<AmbiglowRemoteState>;
}

export interface AmbiglowRemoteOptions {
  /** Start the backend if it is not running (BackendHost.ensureStarted: the port, or -1 on failure). */
  start(): Promise<number>;
  /** The ambiglow service once the backend exists. */
  effects(): RemoteEffects | null;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const same = (a: AmbiglowRemoteState, b: AmbiglowRemoteState) => a.enabled === b.enabled && a.effect === b.effect;

export class AmbiglowRemote {
  readonly #o: AmbiglowRemoteOptions;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #queue: Promise<void> = Promise.resolve();
  /** The state before the first set of this run (restore puts it back), and what that set left. */
  #saved: AmbiglowRemoteState | null = null;
  #applied: AmbiglowRemoteState | null = null;

  constructor(o: AmbiglowRemoteOptions) {
    this.#o = o;
    this.#sleep = o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = o.now ?? Date.now;
  }

  /** Queue a command; resolves when it ran. Never rejects: failures are logged. */
  run(command: AmbiglowCommand): Promise<void> {
    const next = this.#queue.then(() => this.#run(command)).catch((e: unknown) => this.#o.log.error(`${AMBIGLOW_SWITCH}: ${(e as Error).message ?? e}`));
    this.#queue = next;
    return next;
  }

  async #run(command: AmbiglowCommand): Promise<void> {
    const { log } = this.#o;
    const effects = await this.#ready();
    const current = await effects.remoteEffect();
    if (!current) throw new Error('the display with the Ambiglow controller went away');
    if (command.kind === 'restore') {
      const saved = this.#saved;
      const applied = this.#applied;
      this.#saved = this.#applied = null;
      if (!saved || !applied) return void log.info(`${AMBIGLOW_SWITCH}=restore: nothing to restore`);
      if (!same(current, applied)) return void log.info(`${AMBIGLOW_SWITCH}=restore: the effect was changed since, kept`);
      const state = await effects.setRemoteEffect(saved);
      return void log.info(`${AMBIGLOW_SWITCH}=restore: effect ${state.effect}, ${state.enabled ? 'on' : 'off'}`);
    }
    // A set after the user changed the effect starts a new restore point.
    if (!this.#saved || !this.#applied || !same(current, this.#applied)) this.#saved = current;
    this.#applied = await effects.setRemoteEffect(command.target);
    log.info(`${AMBIGLOW_SWITCH}: effect ${this.#applied.effect}, ${this.#applied.enabled ? 'on' : 'off'} (was ${current.effect}, ${current.enabled ? 'on' : 'off'})`);
  }

  /** The service once the backend runs and a display with an ENE is loaded; throws after AMBIGLOW_READY_TIMEOUT_MS. */
  async #ready(): Promise<RemoteEffects> {
    const deadline = this.#now() + AMBIGLOW_READY_TIMEOUT_MS;
    for (;;) {
      if ((await this.#o.start()) >= 0) {
        const effects = this.#o.effects();
        if (effects && (await effects.remoteEffect())) return effects;
      }
      if (this.#now() >= deadline) throw new Error(`no display with an Ambiglow controller (ENE) after ${AMBIGLOW_READY_TIMEOUT_MS / 1000} s`);
      await this.#sleep(AMBIGLOW_READY_POLL_MS);
    }
  }
}
