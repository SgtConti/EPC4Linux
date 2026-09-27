// Effect_GetMenu: DisplayEffectMenu.Default(string_0) (work/dotnet-clean/Zeasn.Equipment.Option.Lib/…/
// DisplayEffectMenu.cs:49-168), cached per ENE model string like CDevice_PHLDisplay.GetEffectMenuData
// (PHL/CDevice_PHLDisplay.cs:866-879). Fixtures: 20-enum-valuelist-catalog §6.1 (ENE model "34M2C8600",
// 3962 bytes) and §6.2 (no ENE, string_0 = "", 3277 bytes); 09 §10.1.
//
// Deliberate deviation (impl-ambiglow §5 item 17): with an ENE the served menu's FollowVideo item offers the
// Speed slider (SupSpeed true, 1..3 step 1) for the host's follow-video speed tiers and the Brightness slider
// (SupBrightness true, 1..3 step 1: Bright / Brighter / Brightest) for the host-side dimming of the frames.
// vendorEffectMenu() is the byte-exact vendor menu; displayEffectMenu() is what Effect_GetMenu answers. §6.2 (no
// ENE) is unchanged.
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

/**
 * DisplayEffectMenu.Default(modelName) exactly as the vendor builds it: the seven effects of
 * DisplayEffectInfo.GetEffects with their capabilities (fixtures 20-enum §6.1 / §6.2, byte for byte).
 */
export function vendorEffectMenu(layouts: readonly EneModelLayout[], modelName: string): DisplayEffectMenu {
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

/**
 * What the port changes in the ENE menu's FollowVideo item (impl-ambiglow §5 deviation 17): the Speed slider, whose
 * EffectDetail.Speed 1..3 selects the host's follow-video cadence (follow-video.ts: Low = the vendor's 300 + 100 ms,
 * Normal, High). The vendor item has SupSpeed false with the BaseEffectMenuItem range 1..3 step 1.
 *
 * The renderer builds the slider (Ambiglow-Dvqon39u.js:1059-1072) from the item merged over EffectDetail
 * (styles-DAnQi2A8.js:9516 updateMonitorEffectInfo, :9431 saveMonitorData) with a vendor bug: the range starts at
 * `MinBrightness`, not `MinSpeed` (`let a = e.MinBrightness; … for (; a <= e.MaxSpeed;) … a += e.SpeedStep`), and
 * mark i is labelled ua[i] = ["Low", "Normal", "High"][i]. The FollowVideo item keeps the base MinBrightness 1, so
 * the range is exactly [1, 2, 3] with the marks Low, Normal, High (menu.test.ts replays that code); MinBrightness
 * needs no change.
 */
export const FOLLOW_VIDEO_SPEED_MENU = Object.freeze({ SupSpeed: true, MinSpeed: 1, MaxSpeed: 3, SpeedStep: 1 } as const);

/**
 * The other port change of the ENE menu's FollowVideo item (deviation 17): the Brightness slider, whose
 * EffectDetail.Brightness 1..3 dims the frames on the host before they are uploaded (follow-video.ts
 * followVideoBrightness: 1/3, 2/3, full). The ENE cannot dim a streamed frame: the ParameterSet of mode 14 always
 * carries Brightest (Class0.method_5, ene-params.ts normalizeParameterSet), so no ParameterSet is sent for it.
 *
 * The renderer builds it (Ambiglow-Dvqon39u.js:1040-1058) from the same merged EffectDetail: with SupBrightness,
 * `MaxBrightness && MinBrightness != null`, the range runs from MinBrightness while <= MaxBrightness by
 * BrightnessStep, and mark i is labelled na[i] = ["Bright", "Brighter", "Brightest"][i]. The vendor item already has
 * the BaseEffectMenuItem range 1..3 step 1, so only SupBrightness changes and the slider shows exactly the three
 * marks 1..3 (menu.test.ts replays that code).
 */
export const FOLLOW_VIDEO_BRIGHTNESS_MENU = Object.freeze({ SupBrightness: true, MinBrightness: 1, MaxBrightness: 3, BrightnessStep: 1 } as const);

/**
 * Effect_GetMenu as the port serves it: the vendor's DisplayEffectMenu.Default(modelName), except that with an ENE
 * (modelName non-empty) the FollowVideo item offers the Speed slider (FOLLOW_VIDEO_SPEED_MENU) and the Brightness
 * slider (FOLLOW_VIDEO_BRIGHTNESS_MENU). Without an ENE the monitor firmware renders FollowVideo (E2A019 = 1); the
 * host can change neither its rate nor its colours, so the vendor item stays and the §6.2 menu is byte-exact.
 * FollowAudio keeps the vendor item in both menus.
 */
export function displayEffectMenu(layouts: readonly EneModelLayout[], modelName: string): DisplayEffectMenu {
  const menu = vendorEffectMenu(layouts, modelName);
  if (modelName === '') return menu;
  for (const item of menu.EffectList) {
    if (item.Effect.Name === 'FollowVideo') Object.assign(item, FOLLOW_VIDEO_SPEED_MENU, FOLLOW_VIDEO_BRIGHTNESS_MENU);
  }
  return menu;
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
