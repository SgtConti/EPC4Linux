// "Turn off lights when idle" (09 §11, 05 §2.6): GlobalOper.CheckIdle, run every second by
// SystemOper.RunPerSecondAtStart (GlobalOper.cs:108-118):
//
//   IsIdle = TurnOffLightsWhenIdle && GetLastInputTime() >= TurnOffLightsWhenIdleDuration * 60 * 1000
//
// and the IsIdle setter (GlobalOper.cs:55-69) logs `Idle state:{value}` (C# bool → "True"/"False") and raises
// EVT_Effect.EffectEnableTemp on every change, which the ambiglow service turns into the per-device
// EffectEnableTemp(!idle) plus stopping/restarting the effect timers.
//
// Port: the settings come from ThemeStore.getSoftConfig() (Config/SoftConfig.data, always current) and the
// input idle time from HostServices.getIdleSeconds() (Electron powerMonitor.getSystemIdleTime, whole seconds;
// the vendor's GetLastInputInfo is in milliseconds). No idle source → never idle. The vendor starts the loop
// at the first hub connection; the port starts it with the service (a few seconds earlier at app start).

import type { SoftConfig } from '../services.ts';
import type { Logger } from '../types.ts';
import { realTimers, type EffectTimers } from './timers.ts';

/** SystemOper.RunPerSecondAtStart period. */
export const IDLE_CHECK_INTERVAL_MS = 1000;

export interface IdleMonitorOptions {
  log: Logger;
  softConfig: () => SoftConfig;
  idleSeconds?: () => number;
  /** EVT_Effect.EffectEnableTemp: called once per change of the idle state. */
  onChange: (idle: boolean) => void;
  timers?: EffectTimers;
  intervalMs?: number;
}

/** GlobalOper.CheckIdle's decision for one poll. */
export function isIdle(soft: SoftConfig, idleSeconds: number): boolean {
  if (!soft.TurnOffLightsWhenIdle) return false;
  return idleSeconds * 1000 >= soft.TurnOffLightsWhenIdleDuration * 60 * 1000;
}

export class IdleMonitor {
  readonly #log: Logger;
  readonly #softConfig: () => SoftConfig;
  readonly #idleSeconds: (() => number) | undefined;
  readonly #onChange: (idle: boolean) => void;
  readonly #timers: EffectTimers;
  readonly #intervalMs: number;
  #timer: unknown = null;
  #idle = false;

  constructor(options: IdleMonitorOptions) {
    this.#log = options.log;
    this.#softConfig = options.softConfig;
    this.#idleSeconds = options.idleSeconds;
    this.#onChange = options.onChange;
    this.#timers = options.timers ?? realTimers;
    this.#intervalMs = options.intervalMs ?? IDLE_CHECK_INTERVAL_MS;
  }

  /** GlobalOper.IsIdle. */
  get idle(): boolean {
    return this.#idle;
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  start(): void {
    if (this.#timer === null) this.#timer = this.#timers.setInterval(() => this.check(), this.#intervalMs);
  }

  /** Stop polling. The idle state is kept (the owner restores the lights itself when it shuts down). */
  stop(): void {
    if (this.#timer !== null) this.#timers.clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Forget the idle state without reporting it (the owner has restored the lights itself, e.g. at shutdown),
   * so that a later start() reports an idle user again.
   */
  reset(): void {
    this.#idle = false;
  }

  /** One GlobalOper.CheckIdle poll; returns the idle state. */
  check(): boolean {
    let idle = false;
    try {
      const soft = this.#softConfig();
      const seconds = this.#idleSeconds ? this.#idleSeconds() : 0;
      idle = isIdle(soft, Number.isFinite(seconds) ? seconds : 0);
    } catch (e) {
      this.#log.warn(`CheckIdle failed: ${e instanceof Error ? e.message : String(e)}`);
      return this.#idle;
    }
    if (idle !== this.#idle) {
      this.#log.info(`Idle state:${idle ? 'True' : 'False'}`);
      this.#idle = idle;
      try {
        this.#onChange(idle);
      } catch (e) {
        this.#log.error('EffectEnableTemp handler failed', e);
      }
    }
    return idle;
  }
}
