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
//
// Port addition, on the same tick: HostServices.shouldReleaseScreenCapture (src/main/desktop-idle.ts), the
// desktop's own idle timeout coming up. Chromium inhibits the desktop's idle while a screen capture is open,
// so the service closes FollowVideo's capture session while this holds (onReleaseCapture, once per change).

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
  /** HostServices.shouldReleaseScreenCapture; absent → never. */
  releaseCapture?: () => boolean;
  /** Called once per change of releaseCapture(). */
  onReleaseCapture?: (release: boolean) => void;
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
  readonly #releaseCapture: (() => boolean) | undefined;
  readonly #onReleaseCapture: ((release: boolean) => void) | undefined;
  readonly #timers: EffectTimers;
  readonly #intervalMs: number;
  #timer: unknown = null;
  #idle = false;
  #captureReleased = false;

  constructor(options: IdleMonitorOptions) {
    this.#log = options.log;
    this.#softConfig = options.softConfig;
    this.#idleSeconds = options.idleSeconds;
    this.#onChange = options.onChange;
    this.#releaseCapture = options.releaseCapture;
    this.#onReleaseCapture = options.onReleaseCapture;
    this.#timers = options.timers ?? realTimers;
    this.#intervalMs = options.intervalMs ?? IDLE_CHECK_INTERVAL_MS;
  }

  /** GlobalOper.IsIdle. */
  get idle(): boolean {
    return this.#idle;
  }

  /** The screen capture is to stay closed so that the desktop can go idle (releaseCapture). */
  get captureReleased(): boolean {
    return this.#captureReleased;
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
    this.#captureReleased = false;
  }

  /** One GlobalOper.CheckIdle poll (and the capture release check); returns the idle state. */
  check(): boolean {
    this.#checkCaptureRelease();
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

  #checkCaptureRelease(): void {
    if (!this.#releaseCapture) return;
    let release: boolean;
    try {
      release = this.#releaseCapture() === true;
    } catch (e) {
      this.#log.warn(`capture release check failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (release === this.#captureReleased) return;
    this.#captureReleased = release;
    try {
      this.#onReleaseCapture?.(release);
    } catch (e) {
      this.#log.error('capture release handler failed', e);
    }
  }
}
