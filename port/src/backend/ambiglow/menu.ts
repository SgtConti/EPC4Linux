// Effect_GetMenu: DisplayEffectMenu.Default(string_0) (work/dotnet-clean/Zeasn.Equipment.Option.Lib/…/
// DisplayEffectMenu.cs:49-168), cached per ENE model string like CDevice_PHLDisplay.GetEffectMenuData
// (PHL/CDevice_PHLDisplay.cs:866-879). Fixtures: 20-enum-valuelist-catalog §6.1 (ENE model "34M2C8600",
// 3962 bytes) and §6.2 (no ENE, string_0 = "", 3277 bytes); 09 §10.1.
//
// Member order is BaseEffectMenuItem's declaration order (ENT/BaseEffectMenuItem.cs): Effect, SupSync,
// SupSpeed, MinSpeed, MaxSpeed, SpeedStep, SupBrightness, MinBrightness, MaxBrightness, BrightnessStep,
// SupRandomColor, SupRainbowColor, SupColor, SupBgColor, SupDir, DirList, SupRegion, RegionList,
// SupStarCount, MinStarCount, MaxStarCount, StarCountStep. DisplayEffectMenu has one member, EffectList.

import type { EnumItem } from '../monitor/model/enum-items.ts';
import { getItem } from '../monitor/model/enum-items.ts';
import { DISPLAY_EFFECTS } from '../monitor/model/effect.ts';
import { findModelLayout, type EneModelLayout } from './ene-layout.ts';

export interface DisplayEffectMenuItem {
  Effect: EnumItem;
  SupSync: boolean;
  SupSpeed: boolean;
  MinSpeed: number;
  MaxSpeed: number;
  SpeedStep: number;
  SupBrightness: boolean;
  MinBrightness: number;
  MaxBrightness: number;
  BrightnessStep: number;
  SupRandomColor: boolean;
  SupRainbowColor: boolean;
  SupColor: boolean;
  SupBgColor: boolean;
  SupDir: boolean;
  DirList: EnumItem[] | null;
  SupRegion: boolean;
  RegionList: EnumItem[] | null;
  SupStarCount: boolean;
  MinStarCount: number;
  MaxStarCount: number;
  StarCountStep: number;
}

export interface DisplayEffectMenu {
  EffectList: DisplayEffectMenuItem[];
}

const region = (name: string) => getItem('RegionType', name);

/**
 * DisplayEffectMenu.GetRegions(modelName) (DisplayEffectMenu.cs:140-168): AllZones, then Bottom (+ FourSided
 * when all four edges have LEDs) for models with bottom LEDs, else ThirdSidedA when all four edges have LEDs;
 * Central when the model has centre LEDs. A model without a PCenter_AmbiglowInfo.json record (including "",
 * the no-ENE case) gets [AllZones]. The record lookup ignores case (ene-layout.ts findModelLayout, deviation 5
 * of impl-usb-ene); the vendor's is exact, which only matters for a device reporting a differently-cased name.
 */
export function effectRegions(layouts: readonly EneModelLayout[], modelName: string): EnumItem[] {
  const list = [region('AllZones')];
  const l = modelName === '' ? undefined : findModelLayout(layouts, modelName);
  if (!l) return list;
  const allEdges = l.leftLedCount > 0 && l.leftUpLedCount > 0 && l.rightLedCount > 0 && l.rightUpLedCount > 0;
  if (l.bottomLedCount <= 0) {
    if (allEdges) list.push(region('ThirdSidedA'));
  } else {
    list.push(region('Bottom'));
    if (allEdges) list.push(region('FourSided'));
  }
  if (l.centerLedCount > 0) list.push(region('Central'));
  return list;
}

function baseItem(effect: EnumItem): DisplayEffectMenuItem {
  // DisplayEffectMenu.cs:54-73 plus the BaseEffectMenuItem initializers for the members it does not set.
  return {
    Effect: effect,
    SupSync: true,
    SupSpeed: true,
    MinSpeed: 1,
    MaxSpeed: 3,
    SpeedStep: 1,
    SupBrightness: true,
    MinBrightness: 1,
    MaxBrightness: 3,
    BrightnessStep: 1,
    SupRandomColor: false,
    SupRainbowColor: true,
    SupColor: true,
    SupBgColor: false,
    SupDir: false,
    DirList: null,
    SupRegion: false,
    RegionList: null,
    SupStarCount: false,
    MinStarCount: 1,
    MaxStarCount: 3,
    StarCountStep: 1,
  };
}

/** DisplayEffectMenu.Default(modelName): the seven effects of DisplayEffectInfo.GetEffects with their capabilities. */
export function displayEffectMenu(layouts: readonly EneModelLayout[], modelName: string): DisplayEffectMenu {
  const EffectList: DisplayEffectMenuItem[] = [];
  for (const name of DISPLAY_EFFECTS) {
    const item = baseItem(getItem('EffectType', name));
    const withRegions = () => {
      item.RegionList = effectRegions(layouts, modelName);
      item.SupRegion = item.RegionList.length > 1;
    };
    switch (name) {
      case 'FollowVideo':
        item.SupSpeed = false;
        item.SupBrightness = false;
        item.SupRainbowColor = false;
        item.SupColor = false;
        item.SupRegion = false;
        break;
      case 'FollowAudio':
        item.SupSpeed = false;
        item.SupBrightness = false;
        withRegions();
        break;
      case 'ColorShift':
      case 'ColorWave':
      case 'Breathing':
        withRegions();
        break;
      case 'StarryNight':
        item.SupRegion = false;
        break;
      case 'Static':
        item.SupSpeed = false;
        withRegions();
        break;
    }
    EffectList.push(item);
  }
  return { EffectList };
}

/** CDeviceEffectBase._effectMenu: one menu per ENE model string, built on first use. */
export class EffectMenuCache {
  readonly #menus = new Map<string, DisplayEffectMenu>();

  get(layouts: readonly EneModelLayout[], modelName: string): DisplayEffectMenu {
    let menu = this.#menus.get(modelName);
    if (!menu) {
      menu = displayEffectMenu(layouts, modelName);
      this.#menus.set(modelName, menu);
    }
    return menu;
  }

  /** The layout table changed (loaded after a menu was built without it). */
  clear(): void {
    this.#menus.clear();
  }
}
