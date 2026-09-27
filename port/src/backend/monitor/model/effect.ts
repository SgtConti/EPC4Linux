// The profile's EffectInfo slot: DisplayEffectInfo / DisplayEffectDetailInfo (OPT/DisplayEffectInfo.cs,
// OPT/DisplayEffectDetailInfo.cs over ENT/BaseEffectInfo.cs, ENT/BaseEffectDetailInfo.cs) and Zeasn RGB.
// The ambiglow service owns the behaviour (ENE parameter sets, Effect_* functions); this file owns the
// data shape inside T_PHLDisplay_Profile.
//
// Member order (CONFIRMED against Default.pcenter, 20-enum §6.3): derived EffectList, EffectDetail, then
// base EffectEnable, CurrEffect. EffectDetail is get-only: GetEffectDetail(CurrEffect.Value) ?? new
// DisplayEffectDetailInfo() — it returns the EffectList element itself, so setters such as
// EffectSpeedChange (`EffectInfo.EffectDetail.Speed = …`) mutate the list entry.

import type { SerializeMode } from '../../types.ts';
import { type CSharpSerializable, toCSharpJson } from '../../core/json.ts';
import { populateEnumItem } from './attribute-info.ts';
import { type EnumItem, cloneEnumItem, emptyEnumItem, enumValue, getItem } from './enum-items.ts';
import { type JsonObject, isJsonObject, member, toBool, toInt } from './json-populate.ts';

/** Zeasn.Com.Lib.RGB: three bytes; `new RGB()` is red (255,0,0) (COM/RGB.cs:8-14). */
export interface RGB {
  R: number;
  G: number;
  B: number;
}

export function rgb(R: number, G: number, B: number): RGB {
  return { R: R & 0xff, G: G & 0xff, B: B & 0xff };
}

export const RGB_RED = (): RGB => rgb(255, 0, 0);
export const RGB_BLUE = (): RGB => rgb(0, 0, 255);
export const RGB_BLACK = (): RGB => rgb(0, 0, 0);

function populateRgb(target: RGB, json: unknown): RGB {
  if (!isJsonObject(json)) return target;
  for (const k of ['R', 'G', 'B'] as const) {
    const v = toInt(member(json, k));
    if (v !== undefined) target[k] = v & 0xff;
  }
  return target;
}

/** DirectionType.Default = -1, RegionType.AllZones = 0 (ENT/BaseEffectDetailInfo.cs defaults). */
export const DIRECTION_DEFAULT = -1;

/** BaseEffectDetailInfo / DisplayEffectDetailInfo (no own members): defaults Off, 2, 2, false, false, red, black, -1, 0, 1. */
export class DisplayEffectDetailInfo implements CSharpSerializable {
  Effect: EnumItem = getItem('EffectType', 'Off');
  Speed = 2;
  Brightness = 2;
  IsRandomColor = false;
  IsRainbowColor = false;
  CurRGB: RGB = RGB_RED();
  BgRGB: RGB = RGB_BLACK();
  CurDir = DIRECTION_DEFAULT;
  CurRegion = 0;
  CurStarCount = 1;

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    populateEnumItem(this.Effect, member(json, 'Effect'));
    for (const k of ['Speed', 'Brightness', 'CurDir', 'CurRegion', 'CurStarCount'] as const) {
      const v = toInt(member(json, k));
      if (v !== undefined) this[k] = v;
    }
    const random = toBool(member(json, 'IsRandomColor'));
    if (random !== undefined) this.IsRandomColor = random;
    const rainbow = toBool(member(json, 'IsRainbowColor'));
    if (rainbow !== undefined) this.IsRainbowColor = rainbow;
    populateRgb(this.CurRGB, member(json, 'CurRGB'));
    populateRgb(this.BgRGB, member(json, 'BgRGB'));
    return this;
  }

  clone(): DisplayEffectDetailInfo {
    return new DisplayEffectDetailInfo().populate(this.toJson());
  }

  toJson(): JsonObject {
    return {
      Effect: cloneEnumItem(this.Effect),
      Speed: this.Speed,
      Brightness: this.Brightness,
      IsRandomColor: this.IsRandomColor,
      IsRainbowColor: this.IsRainbowColor,
      CurRGB: { ...this.CurRGB },
      BgRGB: { ...this.BgRGB },
      CurDir: this.CurDir,
      CurRegion: this.CurRegion,
      CurStarCount: this.CurStarCount,
    };
  }

  [toCSharpJson](): unknown {
    return this.toJson();
  }
}

/** DisplayEffectInfo.GetEffects(modelName): always the same seven effects (the model is ignored). */
export const DISPLAY_EFFECTS = ['FollowVideo', 'FollowAudio', 'ColorShift', 'ColorWave', 'Breathing', 'StarryNight', 'Static'] as const;

export class DisplayEffectInfo implements CSharpSerializable {
  EffectList: DisplayEffectDetailInfo[] | null = null;
  /** BaseEffectInfo.EffectEnable, initializer true. */
  EffectEnable = true;
  /** BaseEffectInfo.CurrEffect, initializer `new EnumItem()`. */
  CurrEffect: EnumItem = emptyEnumItem();

  /** Get-only EffectDetail (OPT/DisplayEffectInfo.cs:27): the list entry of the current effect, or a fresh default. */
  get EffectDetail(): DisplayEffectDetailInfo {
    return this.getEffectDetail(this.CurrEffect.Value);
  }

  /** GetEffectDetail(effect): EffectList.ToList() is null-safe (COM/Extension.cs:29-48). */
  getEffectDetail(effect: number): DisplayEffectDetailInfo {
    return this.EffectList?.find((x) => x.Effect.Value === effect) ?? new DisplayEffectDetailInfo();
  }

  /** SetEffect: replace the entry with the same effect value, or append. */
  setEffect(detail: DisplayEffectDetailInfo): void {
    const list = [...(this.EffectList ?? [])];
    const i = list.findIndex((x) => x.Effect.Value === detail.Effect.Value);
    if (i >= 0) list[i] = detail;
    else list.push(detail);
    this.EffectList = list;
  }

  /**
   * DisplayEffectInfo.Default(modelName) (OPT/DisplayEffectInfo.cs:49-90; fixture 20-enum §6.3): Static
   * current, seven details with speed 2, brightness 3, rainbow on, blue (black for FollowVideo/Audio).
   */
  static default(_modelName: string): DisplayEffectInfo {
    const info = new DisplayEffectInfo();
    info.CurrEffect = getItem('EffectType', 'Static');
    for (const name of DISPLAY_EFFECTS) {
      const d = new DisplayEffectDetailInfo();
      d.Effect = getItem('EffectType', name);
      d.Speed = 2;
      d.Brightness = 3;
      d.IsRandomColor = false;
      d.IsRainbowColor = true;
      d.CurRGB = name === 'FollowVideo' || name === 'FollowAudio' ? RGB_BLACK() : RGB_BLUE();
      d.BgRGB = RGB_BLACK();
      d.CurDir = DIRECTION_DEFAULT;
      d.CurRegion = 0;
      info.setEffect(d);
    }
    return info;
  }

  /** The vendor's "usable stored EffectInfo" test (PHL/CDevice_PHLDisplay.cs:736, :778): list and effect name set. */
  get isComplete(): boolean {
    return this.EffectList !== null && this.CurrEffect.Name !== null;
  }

  /**
   * Newtonsoft populate. The get-only EffectDetail member is populated in place too, but it precedes
   * CurrEffect in the JSON, so at that moment CurrEffect.Value is still the initializer's 0 and the getter
   * returns a throw-away object: the JSON EffectDetail never changes the result.
   */
  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    const list = member(json, 'EffectList');
    if (Array.isArray(list)) this.EffectList = list.filter(isJsonObject).map((x) => new DisplayEffectDetailInfo().populate(x));
    const enable = toBool(member(json, 'EffectEnable'));
    if (enable !== undefined) this.EffectEnable = enable;
    populateEnumItem(this.CurrEffect, member(json, 'CurrEffect'));
    return this;
  }

  clone(): DisplayEffectInfo {
    return new DisplayEffectInfo().populate(this.toJson());
  }

  toJson(): JsonObject {
    return {
      EffectList: this.EffectList ? this.EffectList.map((d) => d.toJson()) : null,
      EffectDetail: this.EffectDetail.toJson(),
      EffectEnable: this.EffectEnable,
      CurrEffect: cloneEnumItem(this.CurrEffect),
    };
  }

  [toCSharpJson](_mode: SerializeMode): unknown {
    return this.toJson();
  }
}

/** EffectType value of a name (e.g. "FollowVideo" → 1). */
export function effectTypeValue(name: string): number {
  return enumValue('EffectType', name);
}
