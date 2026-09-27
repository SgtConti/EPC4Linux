// Synced breathing (09 §9, 05 §2.6): the host-generated breathing curve used when the display breathes in a
// Light-Sync group. Unsynced Breathing is firmware breathing (ENE mode 7, ene-params.ts toEneParameterSet)
// and needs nothing from the host.
//
// Vendor: EffectTimerMgr.method_4 raises Effect_BreathingData every 40 ms while a connected device's effect
// type is Breathing; SystemOper.OnBreathingData (SystemOper.cs:1799-1847) advances ONE shared curve from the
// current profile's Sync_Profile.EffectDetailInfo and hands the colour to every Breathing device;
// CDevice_PHLDisplay.OnBreathing (:1269-1316) uses it only when IsCanBreathingSync (the display is marked in
// sync and the stored group has more than one entry): it fills the 50×40 grid with that colour and streams it
// (ParameterLedSync = the follow-video frame path, mode 14 set by method_17 with the sync flag).
//
//   f   = clamp(Brightness, 1, 3) / 3f                                   smethod_13
//   N   = up 6/4/2, down 24/16/8 for Speed 1/2/3 (clamped, other → 2/8)  smethod_12
//   rgb = IsRainbowColor ? palette[i] : CurRGB;  out = rgb.Multiply(f).Multiply(step / N)
//   up:   step 0 → N (N+1 ticks), then down from N_down;  down: N_down → 0, then up from 1 and palette i+1
// RGB.Multiply truncates `(byte)((float)c * f)` and leaves the colour unchanged for f outside [0, 1].
//
// Monitor-only reachability: the display can only be "in a group of more than one" through a Sync_Profile
// written on Windows with peripherals (the port adds no peripheral), and SyncEffect_GetData — called by the
// renderer's Home page at startup — clears every SyncStatus when at most one synced device is connected
// (sync.ts syncEffectData). The engine is implemented for that window and for imported profiles.

import type { Logger } from '../types.ts';
import type { EneDevice } from './ene.ts';
import { solidGrid } from './follow-video.ts';
import { realTimers, type EffectTimers } from './timers.ts';

/** EffectTimerMgr.method_4: Thread.Sleep(40). */
export const BREATHING_TICK_MS = 40;

export interface Rgb {
  R: number;
  G: number;
  B: number;
}

/** SystemOper.list_0: the rainbow palette, one colour per breathing cycle. */
export const BREATHING_PALETTE: readonly Rgb[] = Object.freeze(
  [
    [255, 0, 0],
    [255, 128, 0],
    [255, 255, 0],
    [0, 255, 0],
    [0, 255, 255],
    [0, 0, 255],
    [255, 0, 255],
    [255, 255, 255],
  ].map(([R, G, B]) => Object.freeze({ R, G, B })),
);

/** The members of Sync_Profile.EffectDetailInfo the curve reads. */
export interface BreathingDetail {
  Speed: number;
  Brightness: number;
  IsRainbowColor: boolean;
  CurRGB: Rgb | null;
}

const clamp13 = (v: number) => (v <= 1 ? 1 : v >= 3 ? 3 : v);

/** SystemOper.smethod_12: ramp length for the speed, going down or up. */
export function breathingSteps(speed: number, down: boolean): number {
  switch (clamp13(speed)) {
    case 1:
      return down ? 24 : 6;
    case 2:
      return down ? 16 : 4;
    default:
      return down ? 8 : 2;
  }
}

/** SystemOper.smethod_13: brightness factor clamp(b, 1, 3) / 3f. */
export function breathingBrightness(brightness: number): number {
  return Math.fround(clamp13(brightness) / 3);
}

/** RGB_Extension.Multiply (COM/RGB_Extension.cs): float product truncated to a byte; f outside [0, 1] is a no-op. */
export function multiplyRgb(rgb: Rgb, f: number): Rgb {
  if (f < 0 || f > 1) return rgb;
  const m = (c: number) => Math.trunc(Math.fround(Math.fround(c) * f)) & 0xff;
  return { R: m(rgb.R), G: m(rgb.G), B: m(rgb.B) };
}

/** The shared breathing curve of SystemOper (static int_0 step, bool_1 down, int_1 palette index). */
export class BreathingGenerator {
  #step = 0;
  #down = false;
  #palette = 0;

  /** One Effect_BreathingData tick; null when there is no sync effect (the vendor returns early). */
  next(detail: BreathingDetail | null): Rgb | null {
    const paletteColour = BREATHING_PALETTE[this.#palette];
    if (!detail) return null;
    const f = breathingBrightness(detail.Brightness);
    const n = breathingSteps(detail.Speed, this.#down);
    const rgb = detail.IsRainbowColor ? paletteColour : detail.CurRGB;
    const out = rgb ? multiplyRgb(multiplyRgb(rgb, f), Math.fround(this.#step / n)) : null;
    if (this.#down) {
      if (--this.#step < 0) {
        this.#down = false;
        this.#step = 1;
        this.#palette = (this.#palette + 1) % BREATHING_PALETTE.length;
      }
    } else if (++this.#step > n) {
      this.#down = true;
      this.#step = breathingSteps(detail.Speed, true);
    }
    return out;
  }
}

export interface BreathingEngineOptions {
  log: Logger;
  target: () => EneDevice | null;
  /** Sync_Profile.EffectDetailInfo of the current profile (null = none). */
  detail: () => BreathingDetail | null;
  timers?: EffectTimers;
  generator?: BreathingGenerator;
}

/** The 40 ms breathing timer for the display (EnableBreathingTimer + OnBreathing's frame upload). */
export class BreathingEngine {
  readonly #log: Logger;
  readonly #target: () => EneDevice | null;
  readonly #detail: () => BreathingDetail | null;
  readonly #timers: EffectTimers;
  readonly #generator: BreathingGenerator;
  #tick: unknown = null;
  #frames = 0;

  constructor(options: BreathingEngineOptions) {
    this.#log = options.log;
    this.#target = options.target;
    this.#detail = options.detail;
    this.#timers = options.timers ?? realTimers;
    this.#generator = options.generator ?? new BreathingGenerator();
  }

  get running(): boolean {
    return this.#tick !== null;
  }

  /** Frames handed to the ENE since construction. */
  get frames(): number {
    return this.#frames;
  }

  setWanted(wanted: boolean): void {
    if (wanted && this.#tick === null) {
      this.#tick = this.#timers.setInterval(() => this.#onTick(), BREATHING_TICK_MS);
      this.#log.info('Breathing: synced breathing curve started');
    } else if (!wanted && this.#tick !== null) {
      this.#timers.clearInterval(this.#tick);
      this.#tick = null;
      this.#log.info('Breathing: synced breathing curve stopped');
    }
  }

  #onTick(): void {
    const rgb = this.#generator.next(this.#detail());
    if (!rgb) return;
    const ene = this.#target();
    if (!ene || ene.busy || ene.closed || ene.lost) return;
    this.#frames++;
    ene.writeVideoFrame(solidGrid(rgb.R, rgb.G, rgb.B)).catch((e: unknown) => {
      this.#log.debug(`Breathing: frame upload failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
}
