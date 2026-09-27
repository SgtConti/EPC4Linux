// ENE effect parameters (TMain_ParameterSet) and the exact register write sequences of
// CUSBENE6K7732.ParameterSet → Class0.method_5 (09 §6) and Class0.method_6 (audio level, 09 §8.3),
// plus the UI → device mapping of ENEDataConvert.MapTMain_ParameterSet (09 §5.2).
//
// The sequences are produced as plain data (EneRegisterWrite[]) so they can be asserted byte for
// byte and replayed by EneDevice; nothing here performs I/O.

import {
  ENE_GROUPS,
  EneBrightness,
  EneField,
  EneMode,
  EneReg,
  EneRegion,
  EneSpeed,
  HOST_CONTROL_OFF,
  HOST_CONTROL_ON,
  groupReg,
  staticColorReg,
  type EneGroup,
} from './ene-registers.ts';

/** TMain_ParameterSet as the app fills it (effect_sel_SWMode is always Normal = 0, see below). */
export interface EneParameterSet {
  /** Device_sel_E (EneRegion). Values other than 1..4 take the AllZone path (method_5 default branch). */
  region: number;
  /** MNTLightEffect_E before rainbow normalisation (EneMode). */
  mode: number;
  rainbow: boolean;
  /** R, G, B (09 §4: colour byte order is R,G,B). */
  rgb: readonly [number, number, number];
  /** Speed_E byte (EneSpeed). */
  speed: number;
  /** Bright_E byte (EneBrightness). */
  brightness: number;
  /** Always 0 from the app: CurDir is not mapped (09 §5.2). Default 0. */
  direction?: number;
}

export interface EneRegisterWrite {
  reg: number;
  data: Uint8Array;
  /** Followed by the 10 ms pause (every method_4 write; not the 0x0023 switch). */
  paced: boolean;
}

// effect_sel_SWMode: ENEDataConvert leaves it at default(TMain_ParameterSet) = Normal (0), so the
// vendor's per-LED 0xE100 branch (SW mode ≠ Normal) is unreachable and not implemented here.
const SW_MODE_NORMAL = 0;

const byte = (n: number) => n & 0xff;

/**
 * Class0.method_5 normalisation (Class0.cs:211-288): the rainbow flag picks the mode variant;
 * FollowVideo/UserDefine force speed Normal, brightness Brightest, direction 0; unknown → LEDOFF.
 */
export function normalizeParameterSet(ps: EneParameterSet): Required<EneParameterSet> {
  const n: Required<EneParameterSet> = {
    region: ps.region,
    mode: ps.mode,
    rainbow: ps.rainbow,
    rgb: [byte(ps.rgb[0]), byte(ps.rgb[1]), byte(ps.rgb[2])],
    speed: byte(ps.speed),
    brightness: byte(ps.brightness),
    direction: byte(ps.direction ?? 0),
  };
  const pick = (plain: number, rainbow: number) => (ps.rainbow ? rainbow : plain);
  switch (ps.mode) {
    case EneMode.StaticMode:
    case EneMode.StaticModeRainbow:
      n.mode = pick(EneMode.StaticMode, EneMode.StaticModeRainbow);
      break;
    case EneMode.ColorShift:
    case EneMode.ColorShiftRainbow:
      n.mode = pick(EneMode.ColorShift, EneMode.ColorShiftRainbow);
      break;
    case EneMode.ColorWave:
    case EneMode.ColorWaveRainbow:
      n.mode = pick(EneMode.ColorWave, EneMode.ColorWaveRainbow);
      break;
    case EneMode.ColorBreathing:
    case EneMode.ColorBreathingRainbow:
      n.mode = pick(EneMode.ColorBreathing, EneMode.ColorBreathingRainbow);
      break;
    case EneMode.FollowAudio:
    case EneMode.FollowAudioRainbow:
      n.mode = pick(EneMode.FollowAudio, EneMode.FollowAudioRainbow);
      break;
    case EneMode.StarryNight:
    case EneMode.StarryNightRainbow:
      n.mode = pick(EneMode.StarryNight, EneMode.StarryNightRainbow);
      break;
    case EneMode.FollowVideo:
    case EneMode.UserDefine:
      n.speed = EneSpeed.Normal;
      n.brightness = EneBrightness.Brightest;
      n.direction = 0;
      break;
    default:
      n.mode = EneMode.LEDOFF;
  }
  return n;
}

/**
 * The complete ParameterSet transfer list (CUSBENE6K7732.ParameterSet, 09 §6):
 *   1. 0x0023 ← 0x04 if the mode is not LEDOFF, else 0x00 (unpaced "USBCableLivingSwitch");
 *   2. the region-specific sequence of Class0.method_5, every write paced.
 * The vendor derives step 1 from the mode before normalisation; for every mode the app can produce
 * that is the same as the normalised mode, and for out-of-range input (normalised to LEDOFF) this
 * port releases host control instead of claiming it with the LEDs off.
 */
export function parameterSetWrites(ps: EneParameterSet): EneRegisterWrite[] {
  const p = normalizeParameterSet(ps);
  const writes: EneRegisterWrite[] = [
    { reg: EneReg.HOST_CONTROL, data: Uint8Array.of(p.mode !== EneMode.LEDOFF ? HOST_CONTROL_ON : HOST_CONTROL_OFF), paced: false },
  ];
  const w = (reg: number, ...bytes: number[]) => writes.push({ reg, data: Uint8Array.from(bytes), paced: true });
  const set = (g: EneGroup, field: number, value: number) => w(groupReg(g, field), value);
  const color = (g: EneGroup) => w(staticColorReg(g), ...p.rgb);
  /** One group fully configured: mode, SW mode, speed, direction, brightness, colour, apply. */
  const configure = (g: EneGroup) => {
    set(g, EneField.MODE, p.mode);
    set(g, EneField.SW_MODE, SW_MODE_NORMAL);
    set(g, EneField.SPEED, p.speed);
    set(g, EneField.DIRECTION, p.direction);
    set(g, EneField.BRIGHTNESS, p.brightness);
    color(g);
    set(g, EneField.APPLY, 1);
  };

  switch (p.region) {
    case EneRegion.Border4Sided: // Class0.cs:342-395 — central off; border and bottom on
      set(2, EneField.MODE, EneMode.LEDOFF);
      set(2, EneField.SW_MODE, 0);
      set(2, EneField.APPLY, 1);
      configure(1);
      configure(3);
      break;
    case EneRegion.Central: // Class0.cs:396-428 — border and bottom off; central on
      set(1, EneField.MODE, EneMode.LEDOFF);
      set(3, EneField.MODE, EneMode.LEDOFF);
      set(1, EneField.SW_MODE, 0);
      set(3, EneField.SW_MODE, 0);
      set(1, EneField.APPLY, 1);
      set(3, EneField.APPLY, 1);
      configure(2);
      break;
    case EneRegion.Bottom: // Class0.cs:429-462 — border and central off; bottom on
      set(1, EneField.MODE, EneMode.LEDOFF);
      set(2, EneField.MODE, EneMode.LEDOFF);
      set(1, EneField.SW_MODE, 0);
      set(2, EneField.SW_MODE, 0);
      set(1, EneField.APPLY, 1);
      set(2, EneField.APPLY, 1);
      configure(3);
      break;
    case EneRegion.Clock4: // Class0.cs:463-492 (no shipped model has a 4th group)
      configure(4);
      break;
    default: {
      // AllZone and anything else, Class0.cs:291-341: field by field across all four groups
      // (group 4 is written although no shipped model has it; 28 writes).
      const fields: Array<[field: number, value: number]> = [
        [EneField.MODE, p.mode],
        [EneField.SW_MODE, SW_MODE_NORMAL],
        [EneField.SPEED, p.speed],
        [EneField.DIRECTION, p.direction],
        [EneField.BRIGHTNESS, p.brightness],
      ];
      for (const [field, value] of fields) for (const g of ENE_GROUPS) set(g, field, value);
      for (const g of ENE_GROUPS) color(g);
      for (const g of ENE_GROUPS) set(g, EneField.APPLY, 1);
    }
  }
  return writes;
}

/**
 * The level byte of a CaptureHost audio level (a float 0..255, types.ts CaptureHost.startAudio):
 * truncated like the vendor's `(byte)(v / mx * 255)` (09 §8.2). The vendor's value cannot leave
 * 0..255 by construction (v ≤ mx); here out-of-range input is clamped and NaN counts as silence.
 */
export function audioLevelByte(level: number): number {
  if (Number.isNaN(level)) return 0;
  return Math.min(255, Math.max(0, Math.trunc(level)));
}

/**
 * FollowAudio level (Class0.method_6, Class0.cs:496-514): the same byte (audioLevelByte) to three
 * registers, E970..E972 for the rainbow variant, E960..E962 otherwise; each write paced.
 */
export function audioLevelWrites(level: number, rainbow: boolean): EneRegisterWrite[] {
  const value = audioLevelByte(level);
  const base = rainbow ? EneReg.AUDIO_LEVEL_RAINBOW : EneReg.AUDIO_LEVEL;
  return [0, 1, 2].map((i) => ({ reg: base + i, data: Uint8Array.of(value), paced: true }));
}

/** Host-control release (UnPlug, 09 §4.2): 0x0023 ← 0, unpaced. */
export function releaseWrites(): EneRegisterWrite[] {
  return [{ reg: EneReg.HOST_CONTROL, data: Uint8Array.of(HOST_CONTROL_OFF), paced: false }];
}

// ───────────── UI model → device (ENEDataConvert, 09 §5.2) ─────────────

/** EffectType values the monitor uses (Zeasn.PCenter.Entity.Lib/EffectType.cs). */
export const EffectType = { FollowVideo: 1, FollowAudio: 2, ColorShift: 3, ColorWave: 4, Breathing: 5, StarryNight: 6, Static: 7 } as const;

/** RegionType (Zeasn.PCenter.Entity.Lib/RegionType.cs). */
export const RegionType = { AllZones: 0, FourSided: 1, Central: 2, Bottom: 3, ThirdSidedA: 4, ThirdSidedB: 5 } as const;

/** The members of DisplayEffectInfo that MapTMain_ParameterSet reads (same names as the C# JSON). */
export interface DisplayEffectInfoLike {
  EffectEnable: boolean;
  CurrEffect: { Value: number } | null;
  EffectDetail: {
    Effect: { Value: number };
    Speed: number;
    Brightness: number;
    IsRainbowColor: boolean;
    CurRGB: { R: number; G: number; B: number };
    CurRegion: number;
  };
}

/** Convert.ToByte on an int: values outside 0..255 throw inside the vendor helper, which returns 0. */
const toByte = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 255 ? n : 0);

function effectMode(effectType: number): number {
  switch (effectType) {
    case EffectType.FollowVideo:
    case EffectType.Breathing:
      return EneMode.UserDefine;
    case EffectType.FollowAudio:
      return EneMode.FollowAudio;
    case EffectType.ColorShift:
      return EneMode.ColorShift;
    case EffectType.ColorWave:
      return EneMode.ColorWave;
    case EffectType.StarryNight:
      return EneMode.StarryNight;
    default: // Static and anything else
      return EneMode.StaticMode;
  }
}

const BRIGHTNESS: Record<number, number> = { 1: EneBrightness.Bright, 2: EneBrightness.Brighter, 3: EneBrightness.Brightest };
const SPEED: Record<number, number> = { 1: EneSpeed.Low, 2: EneSpeed.Normal, 3: EneSpeed.High };

function region(regionType: number): number {
  switch (regionType) {
    case RegionType.Central:
      return EneRegion.Central;
    case RegionType.Bottom:
      return EneRegion.Bottom;
    case RegionType.FourSided:
    case RegionType.ThirdSidedA:
    case RegionType.ThirdSidedB:
      return EneRegion.Border4Sided;
    default:
      return EneRegion.AllZone;
  }
}

/**
 * The parameter set CDevice_PHLDisplay.method_17 sends for an effect state: MapTMain_ParameterSet,
 * then Breathing is switched to firmware breathing (mode 7) unless the display breathes in a
 * Light-Sync group (`breathingSync`, where the host streams the curve into mode 14).
 *
 * Deviation: the vendor applies the Breathing override even when EffectEnable is false, so
 * "turn off lights when idle" and Effect_Enable(false) keep a breathing effect running
 * (CDevice_PHLDisplay.cs:1190-1203 via EffectEnableTemp :954-972). Here a disabled effect is always
 * LEDOFF. The vendor also sends that ParameterSet twice; callers should send it once.
 */
export function toEneParameterSet(info: DisplayEffectInfoLike, options: { breathingSync?: boolean } = {}): EneParameterSet {
  const d = info.EffectDetail;
  let mode: number = info.EffectEnable ? effectMode(d.Effect.Value) : EneMode.LEDOFF;
  if (info.EffectEnable && info.CurrEffect?.Value === EffectType.Breathing && !options.breathingSync) {
    mode = EneMode.ColorBreathing;
  }
  return {
    region: region(d.CurRegion),
    mode,
    rainbow: d.IsRainbowColor,
    rgb: [toByte(d.CurRGB.R), toByte(d.CurRGB.G), toByte(d.CurRGB.B)],
    speed: SPEED[d.Speed] ?? EneSpeed.Normal,
    brightness: BRIGHTNESS[d.Brightness] ?? EneBrightness.Brighter,
    direction: 0,
  };
}
