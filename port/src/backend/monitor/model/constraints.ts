// DisplayFuncConstraints + FuncContraintItem (OPT/DisplayFuncConstraints.cs:64-335, OPT/FuncContraintItem.cs;
// 06 §8, 20-backend-host-tail §2.6, 20-enum §6.5 and the §8 correction of the OP_DA rule).
//
// State 1 = enabled, 2 = disabled. The 26 items keep the constructor order; FuncId is the enum value and
// FuncName the enum member name. RecheckFuncConstraints resets every state to 1 and re-evaluates the rules;
// the owner sends NotifyUIDisplayFuncConstraintsChange only when the serialized state changed.

import type { SerializeMode } from '../../types.ts';
import { type CSharpSerializable, toCSharpJson } from '../../core/json.ts';
import { asInt32 } from './json-populate.ts';
import { enumValue, opcodeName } from './enum-items.ts';
import type { T_PHLDisplay_Profile } from './profile.ts';

export const ENABLED = 1;
export const DISABLED = 2;

export interface FuncContraintItem {
  FuncId: number;
  FuncName: string;
  State: number;
}

/** Constructor order (DisplayFuncConstraints.cs:64-92). */
export const CONSTRAINT_CODES = [
  0x10, 0x12, 0xf0, 0xe2a020, 0x14, 0xe2a024, 0xe2a040, 0xe2a002, 0xe2a003, 0xe2a004, 0xe2a044, 0xe2a045, 0xe2a006,
  0xe2a007, 0xeb, 0xe2a04c, 0xe2a008, 0xe2a01a, 0xe2a01b, 0xe2a01c, 0xe2a01d, 0xe2a01e, 0xe0, 0x86, 0x54, 0xda,
] as const;

/** E2A0_19_AmbiglowLightMode_E values used by the rules (20-enum §2 catalog). */
const mode = (name: string) => enumValue('E2A0_19_AmbiglowLightMode_E', name);
const MODE = {
  FollowVideo: mode('FollowVideo'),
  FollowAudio: mode('FollowAudio'),
  ColorShift: mode('ColorShift'),
  ColorWave: mode('ColorWave'),
  ColorBreathing: mode('ColorBreathing'),
  StarryNight: mode('StarryNight'),
  StaticMode: mode('StaticMode'),
  ColorFlow: mode('ColorFlow'),
  ColorFlowReverse: mode('ColorFlowReverse'),
} as const;
/** SmartImage_E2 values the rules compare DC against. */
const DC_STANDARD = enumValue('SmartImage_E2', 'SmartImage_Standard');
const DC_LOW_BLUE = enumValue('SmartImage_E2', 'SmartImage_LowBlueMode');
const DC_EASY_READ = enumValue('SmartImage_E2', 'SmartImage_EasyRead');
/** VCP_86_DisplayScaling.Scaling_NoScaling. */
const SCALING_NO_SCALING = enumValue('VCP_86_DisplayScaling', 'Scaling_NoScaling');

export class DisplayFuncConstraints implements CSharpSerializable {
  FuncItems: FuncContraintItem[] = CONSTRAINT_CODES.map((code) => ({ FuncId: code, FuncName: opcodeName(code) ?? String(code), State: ENABLED }));
  ModuleGameMode = 1;
  AudioEQ = 1;

  #item(code: number): FuncContraintItem | undefined {
    return this.FuncItems.find((x) => x.FuncId === code);
  }

  /** method_1: the state, 2 when the item is missing. */
  state(code: number): number {
    return this.#item(code)?.State ?? DISABLED;
  }

  /** method_2: 2 when `disabled`, else 1. */
  #flag(code: number, disabled: boolean): void {
    const it = this.#item(code);
    if (it) it.State = disabled ? DISABLED : ENABLED;
  }

  /** method_3: set a state directly. */
  #set(code: number, state: number): void {
    const it = this.#item(code);
    if (it) it.State = state;
  }

  /**
   * RecheckFuncConstraints(profile) (DisplayFuncConstraints.cs:125-294). `pipTableAvailable` is
   * DataOSD.PIPPBPEnable (F7 advertises a PIP/PBP table). Returns true when the serialized state changed,
   * i.e. when the vendor calls Notify().
   */
  recheck(profile: T_PHLDisplay_Profile, pipTableAvailable: boolean): boolean {
    const before = JSON.stringify(this.toJson());
    const hz = parseFrequency(profile.DispalyData.MonitorFrequency);
    for (const it of this.FuncItems) it.State = ENABLED;
    this.ModuleGameMode = 1;
    this.AudioEQ = 1;

    const gm = profile.ModuleGameMode;
    const a5 = profile.ModuleInput.OP_A5_WindowSelect;
    const pip = a5.IsAvailable && pipTableAvailable && asInt32(a5.Value) !== 0;
    const hdr = profile.IsSmartImageHDR;
    const saver = profile.ModuleSetup.EXT_OP_E2A0_35_ScreenSaver;
    const ss = saver.IsAvailable && asInt32(saver.Value) !== 0;
    const sniper = !(pip || hdr) && gm.EXT_OP_E2A0_06_SharpShooter_Size.IsAvailable && asInt32(gm.EXT_OP_E2A0_06_SharpShooter_Size.Value) !== 0;
    const async = !pip && gm.EXT_OP_E2A0_40_AdaptiveSync.IsAvailable && asInt32(gm.EXT_OP_E2A0_40_AdaptiveSync.Value) !== 0;
    const mbr = !(pip || hz < 75 || async) && gm.EXT_OP_E2A0_02_MBR.IsAvailable && asInt32(gm.EXT_OP_E2A0_02_MBR.Value) > 0;
    const mbrSync = !pip && async && gm.EXT_OP_E2A0_03_MBRSync.IsAvailable && asInt32(gm.EXT_OP_E2A0_03_MBRSync.Value) !== 0;

    this.ModuleGameMode = 1;
    this.#flag(0xe2a040, pip);
    this.#flag(0xe2a002, pip || hz < 75 || async);
    this.#flag(0xe2a003, pip || !async);
    this.#flag(0xe2a004, pip);
    this.#flag(0xe2a044, pip || hdr);
    this.#flag(0xe2a045, pip || hdr);
    this.#flag(0xe2a006, pip || hdr);
    this.#flag(0xe2a007, pip || sniper);
    this.#flag(0xeb, pip);
    this.#flag(0xe2a04c, pip);

    let standardOrEasyRead = false;
    const dcAttr = profile.OP_DC_DisplayApplication;
    if (dcAttr.IsAvailable) {
      this.#flag(0x10, hdr ? false : mbr || mbrSync);
      const dc = asInt32(dcAttr.Value);
      this.#flag(0x12, dc === DC_EASY_READ);
      this.#flag(0xf0, pip || ss || sniper || mbr || mbrSync);
      this.#flag(0x14, dc === DC_EASY_READ || dc === DC_LOW_BLUE);
      this.#flag(0xe2a020, dc === DC_EASY_READ || dc === DC_LOW_BLUE);
      this.#flag(0xe2a024, dc !== DC_LOW_BLUE);
      standardOrEasyRead = dc === DC_STANDARD || dc === DC_EASY_READ;
    }
    this.#flag(0xe2a008, pip || hdr || sniper || standardOrEasyRead);

    const modeAttr = profile.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode;
    const ambiglow = modeAttr.IsAvailable;
    for (const code of [0xe2a01a, 0xe2a01b, 0xe2a01c, 0xe2a01d, 0xe2a01e]) this.#set(code, ambiglow ? ENABLED : DISABLED);
    if (ambiglow) {
      const current = asInt32(modeAttr.Value);
      // [colours, position, brightness, speed, direction] per mode; Off/unknown leave them at 1.
      let states: readonly number[] | null = null;
      if (current === MODE.FollowVideo) states = [2, 2, 1, 2, 2];
      else if (current === MODE.FollowAudio) states = [1, 1, 2, 2, 2];
      else if (current === MODE.ColorShift || current === MODE.ColorWave || current === MODE.ColorBreathing) states = [1, 1, 1, 1, 1];
      else if (current === MODE.StarryNight) states = [1, 2, 1, 1, 1];
      else if (current === MODE.StaticMode) states = [1, 1, 1, 2, 1];
      else if (current === MODE.ColorFlow || current === MODE.ColorFlowReverse) states = [2, 2, 1, 1, 2];
      if (states) [0xe2a01a, 0xe2a01b, 0xe2a01c, 0xe2a01d, 0xe2a01e].forEach((code, i) => this.#set(code, states[i]));
    }

    this.AudioEQ = 1;
    // As coded: the audio source is enabled only while PIP/PBP is active (DisplayFuncConstraints.cs:279).
    this.#set(0xe0, pip ? ENABLED : DISABLED);
    this.#flag(0x54, pip);
    // 20-enum §8 item 1: ScanMode is disabled when 0x86 is enabled, available and Scaling_NoScaling (1).
    const scaling = profile.ModuleSystem.OP_86_DisplayScaling;
    const noScaling = this.state(0x86) === ENABLED && scaling.IsAvailable && asInt32(scaling.Value) === SCALING_NO_SCALING;
    this.#set(0xda, noScaling ? DISABLED : ENABLED);

    return JSON.stringify(this.toJson()) !== before;
  }

  toJson(): { FuncItems: FuncContraintItem[]; ModuleGameMode: number; AudioEQ: number } {
    return {
      FuncItems: this.FuncItems.map((x) => ({ FuncId: x.FuncId, FuncName: x.FuncName, State: x.State })),
      ModuleGameMode: this.ModuleGameMode,
      AudioEQ: this.AudioEQ,
    };
  }

  [toCSharpJson](_mode: SerializeMode): unknown {
    return this.toJson();
  }
}

/** method_4: int.TryParse(s.ToLower().Replace("hz","")), 0 on failure or blank (DisplayFuncConstraints.cs:296-314). */
export function parseFrequency(s: string | null | undefined): number {
  if (!s || s.trim() === '') return 0;
  const t = s.toLowerCase().replaceAll('hz', '');
  // .NET int.TryParse (NumberStyles.Integer): optional surrounding white space and a leading sign.
  if (!/^\s*[+-]?\d+\s*$/.test(t)) return 0;
  const n = Number.parseInt(t, 10);
  return n >= -2147483648 && n <= 2147483647 ? n : 0;
}
