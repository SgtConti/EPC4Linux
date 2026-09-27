// The eight modules of T_PHLDisplay_Profile (Zeasn.Equipment.Option.Lib/DisplayModule*.cs,
// SubModuleSmartImage*.cs, DisplayInputSourceInfo.cs, GClass0.cs = EQ item). Member order is the C#
// declaration order, verified against the user's Default.pcenter and the computed hub Tag
// (20-enum-valuelist-catalog §3 table, §5). Each module lists its AttributeInfo properties in `attrNames`
// so the driver can walk them like the vendor's reflection helpers (Extension_AttributeInfo.GetValue<T> /
// GetAttributeInfos<T>, PBASE/Extension_AttributeInfo.cs:33-65).

import type { SerializeMode } from '../../types.ts';
import { type CSharpSerializable, toCSharpJson, toJsonValue } from '../../core/json.ts';
import { AttributeInfo, parseEnumItem } from './attribute-info.ts';
import { type EnumItem, cloneEnumItem, getDatas } from './enum-items.ts';
import { type JsonObject, isJsonObject, member, orderedEntries, setKeyOrder, toBool, toInt, toStr } from './json-populate.ts';

const V = (code: number) => AttributeInfo.of(code);

/** A class whose AttributeInfo members are listed in declaration order. */
export interface AttributeHolder {
  readonly attrNames: readonly string[];
}

/** GetAttributeInfos<T>(): the AttributeInfo-typed properties in declaration order. */
export function attributesOf(holder: AttributeHolder): AttributeInfo[] {
  const record = holder as unknown as Record<string, AttributeInfo>;
  return holder.attrNames.map((n) => record[n]);
}

/** The property of `holder` whose AttributeInfo has this VCPOpCodeName (method_29's FindIndex). */
export function attributeByName(holder: AttributeHolder, opName: string): AttributeInfo | null {
  return attributesOf(holder).find((a) => a.VCPOpCodeName === opName) ?? null;
}

function serializeAttrs(holder: AttributeHolder, mode: SerializeMode): JsonObject {
  const out: JsonObject = {};
  const record = holder as unknown as Record<string, AttributeInfo>;
  for (const n of holder.attrNames) out[n] = record[n].toJson(mode);
  return out;
}

function populateAttrs(holder: AttributeHolder, json: JsonObject): void {
  const record = holder as unknown as Record<string, AttributeInfo>;
  for (const n of holder.attrNames) {
    const v = member(json, n);
    if (isJsonObject(v)) record[n].populate(v);
  }
}

function parseEnumList(v: unknown): EnumItem[] | undefined {
  return Array.isArray(v) ? v.filter(isJsonObject).map(parseEnumItem) : undefined;
}

// ───────────────────────────── SmartImage (SDR) ─────────────────────────────

export class SubModuleSmartImage implements AttributeHolder, CSharpSerializable {
  readonly attrNames = [
    'OP_10_Luminance', 'OP_12_Contrast', 'OP_F0_SmartContrast', 'OP_72_Gamma', 'OP_87_Sharpness',
    'EXT_OP_E2A0_20_ColorSpace', 'OP_14_SelectColorPreset', 'OP_16_VideoGainDriveRed', 'OP_18_VideoGainDriveGreen',
    'OP_1A_VideoGainDriveBlue', 'OP_8A_Saturation', 'OP_90_Hue', 'EXT_OP_E2A0_24_DLBL',
  ] as const;
  OP_10_Luminance = V(0x10);
  OP_12_Contrast = V(0x12);
  OP_F0_SmartContrast = V(0xf0);
  OP_72_Gamma = V(0x72);
  OP_87_Sharpness = V(0x87);
  EXT_OP_E2A0_20_ColorSpace = V(0xe2a020);
  OP_14_SelectColorPreset = V(0x14);
  OP_16_VideoGainDriveRed = V(0x16);
  OP_18_VideoGainDriveGreen = V(0x18);
  OP_1A_VideoGainDriveBlue = V(0x1a);
  OP_8A_Saturation = V(0x8a);
  OP_90_Hue = V(0x90);
  EXT_OP_E2A0_24_DLBL = V(0xe2a024);

  populate(json: unknown): this {
    if (isJsonObject(json)) populateAttrs(this, json);
    return this;
  }

  clone(): SubModuleSmartImage {
    return new SubModuleSmartImage().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return serializeAttrs(this, mode);
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

/**
 * Dictionary<int, T> as Newtonsoft writes it: string keys in INSERTION order (12 App. A), e.g.
 * {"3":…,"4":…,"1":…} after SetSmartImage(4) and SetSmartImage(1) on an SDR monitor that loaded in mode 3.
 * A JS object lists integer-like keys ascending, so the returned object (ascending, for code that walks
 * the tree) carries two extras:
 *   - its insertion order is registered (json-populate setKeyOrder), so populateSubMap — i.e. clone() —
 *     rebuilds the Map in the same order;
 *   - an enumerable `toJSON`, which core/json's toJsonValue copies through as a function value, so the
 *     final JSON.stringify of serialize()/serializeResult() emits a Proxy whose ownKeys trap yields the
 *     insertion order (ECMA-262 SerializeJSONObject → EnumerableOwnProperties → [[OwnPropertyKeys]]).
 */
function serializeSubMap<T extends { toJson(mode: SerializeMode): JsonObject }>(map: Map<number, T>, mode: SerializeMode): JsonObject {
  const keys: string[] = [];
  const out: JsonObject = {};
  for (const [k, v] of map) {
    const key = String(k);
    keys.push(key);
    out[key] = v.toJson(mode);
  }
  setKeyOrder(out, keys);
  Object.defineProperty(out, 'toJSON', { value: () => orderedJsonObject(keys, out, mode), enumerable: true, writable: false, configurable: true });
  return out;
}

/** A JSON-ready object whose own keys enumerate in `keys` order (see serializeSubMap). */
function orderedJsonObject(keys: readonly string[], source: JsonObject, mode: SerializeMode): object {
  const target: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const k of keys) target[k] = toJsonValue(source[k], mode);
  const order = [...keys];
  return new Proxy(target, { ownKeys: () => [...order] });
}

function populateSubMap<T>(map: Map<number, T>, json: unknown, create: () => T & { populate(j: unknown): unknown }): void {
  if (!isJsonObject(json)) return;
  // Source order (parseJsonOrdered / serializeSubMap), as Newtonsoft populates the Dictionary.
  for (const [k, v] of orderedEntries(json)) {
    const key = toInt(k);
    if (key === undefined || !isJsonObject(v)) continue;
    const item = create();
    item.populate(v);
    map.set(key, item);
  }
}

export class DisplayModuleSmartImage implements CSharpSerializable {
  /** Public field: DC.ValueList − SmartImageHDR_E when SDR (PHL/CDevice_PHLDisplay.cs:347). */
  Items: EnumItem[] = [];
  CurSubSmartImage = new SubModuleSmartImage();
  SubSmartImages = new Map<number, SubModuleSmartImage>();

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    const items = parseEnumList(member(json, 'Items'));
    if (items) this.Items.push(...items);
    const cur = member(json, 'CurSubSmartImage');
    if (isJsonObject(cur)) this.CurSubSmartImage.populate(cur);
    populateSubMap(this.SubSmartImages, member(json, 'SubSmartImages'), () => new SubModuleSmartImage());
    return this;
  }

  clone(): DisplayModuleSmartImage {
    return new DisplayModuleSmartImage().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return {
      Items: this.Items.map(cloneEnumItem),
      CurSubSmartImage: this.CurSubSmartImage.toJson(mode),
      SubSmartImages: serializeSubMap(this.SubSmartImages, mode),
    };
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

// ───────────────────────────── SmartImage HDR ─────────────────────────────

export class SubModuleSmartImageHDR implements AttributeHolder, CSharpSerializable {
  readonly attrNames = [
    'OP_10_Luminance', 'OP_12_Contrast', 'EXT_OP_E2A0_3D_LightEnhancement', 'EXT_OP_E2A0_3E_ColorEnhancement', 'EXT_OP_E2A0_3F_DarkEnhancement',
  ] as const;
  OP_10_Luminance = V(0x10);
  OP_12_Contrast = V(0x12);
  EXT_OP_E2A0_3D_LightEnhancement = V(0xe2a03d);
  EXT_OP_E2A0_3E_ColorEnhancement = V(0xe2a03e);
  EXT_OP_E2A0_3F_DarkEnhancement = V(0xe2a03f);

  populate(json: unknown): this {
    if (isJsonObject(json)) populateAttrs(this, json);
    return this;
  }

  clone(): SubModuleSmartImageHDR {
    return new SubModuleSmartImageHDR().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return serializeAttrs(this, mode);
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

export class DisplayModuleSmartImageHDR implements CSharpSerializable {
  /** Public field: DC.ValueList ∩ SmartImageHDR_E when HDR (PHL/CDevice_PHLDisplay.cs:338). */
  Items: EnumItem[] = [];
  CurSubSmartImage = new SubModuleSmartImageHDR();
  SubSmartImages = new Map<number, SubModuleSmartImageHDR>();

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    const items = parseEnumList(member(json, 'Items'));
    if (items) this.Items.push(...items);
    const cur = member(json, 'CurSubSmartImage');
    if (isJsonObject(cur)) this.CurSubSmartImage.populate(cur);
    populateSubMap(this.SubSmartImages, member(json, 'SubSmartImages'), () => new SubModuleSmartImageHDR());
    return this;
  }

  clone(): DisplayModuleSmartImageHDR {
    return new DisplayModuleSmartImageHDR().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return {
      Items: this.Items.map(cloneEnumItem),
      CurSubSmartImage: this.CurSubSmartImage.toJson(mode),
      SubSmartImages: serializeSubMap(this.SubSmartImages, mode),
    };
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

// ───────────────────────────── GameMode ─────────────────────────────

export class DisplayModuleGameMode implements AttributeHolder, CSharpSerializable {
  readonly attrNames = [
    'EXT_OP_E2A0_40_AdaptiveSync', 'EXT_OP_E2A0_02_MBR', 'EXT_OP_E2A0_03_MBRSync', 'EXT_OP_E2A0_04_SmartCrosshair',
    'EXT_OP_E2A0_44_StarkShadowBoost', 'EXT_OP_E2A0_45_ShadowBoost', 'EXT_OP_E2A0_06_SharpShooter_Size',
    'EXT_OP_E2A0_25_SharpShooter_Location', 'EXT_OP_E2A0_07_LowInputLag', 'OP_EB_SmartResponse', 'EXT_OP_E2A0_4C_Overclock',
    'EXT_OP_E2A0_08_SmartFrame', 'EXT_OP_E2A0_09_SmartFrameSize', 'EXT_OP_E2A0_0A_SmartFrameBrightness',
    'EXT_OP_E2A0_0B_SmartFrameContrast', 'EXT_OP_E2A0_0C_SmartFrameHPosition', 'EXT_OP_E2A0_0D_SmartFrameVPosition',
    'EXT_OP_E2A0_59_DualResolution', 'EXT_OP_E2A0_68_AutoRefineAIStatus',
  ] as const;
  EXT_OP_E2A0_40_AdaptiveSync = V(0xe2a040);
  EXT_OP_E2A0_02_MBR = V(0xe2a002);
  EXT_OP_E2A0_03_MBRSync = V(0xe2a003);
  EXT_OP_E2A0_04_SmartCrosshair = V(0xe2a004);
  EXT_OP_E2A0_44_StarkShadowBoost = V(0xe2a044);
  EXT_OP_E2A0_45_ShadowBoost = V(0xe2a045);
  EXT_OP_E2A0_06_SharpShooter_Size = V(0xe2a006);
  EXT_OP_E2A0_25_SharpShooter_Location = V(0xe2a025);
  EXT_OP_E2A0_07_LowInputLag = V(0xe2a007);
  OP_EB_SmartResponse = V(0xeb);
  EXT_OP_E2A0_4C_Overclock = V(0xe2a04c);
  EXT_OP_E2A0_08_SmartFrame = V(0xe2a008);
  EXT_OP_E2A0_09_SmartFrameSize = V(0xe2a009);
  EXT_OP_E2A0_0A_SmartFrameBrightness = V(0xe2a00a);
  EXT_OP_E2A0_0B_SmartFrameContrast = V(0xe2a00b);
  EXT_OP_E2A0_0C_SmartFrameHPosition = V(0xe2a00c);
  EXT_OP_E2A0_0D_SmartFrameVPosition = V(0xe2a00d);
  EXT_OP_E2A0_59_DualResolution = V(0xe2a059);
  EXT_OP_E2A0_68_AutoRefineAIStatus = V(0xe2a068);

  populate(json: unknown): this {
    if (isJsonObject(json)) populateAttrs(this, json);
    return this;
  }

  clone(): DisplayModuleGameMode {
    return new DisplayModuleGameMode().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return serializeAttrs(this, mode);
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

// ───────────────────────────── Ambiglow (DDC path) ─────────────────────────────

export class DisplayModuleAmbiglow implements AttributeHolder, CSharpSerializable {
  readonly attrNames = [
    'EXT_OP_E2A0_19_AmbiglowLightMode', 'EXT_OP_E2A0_1A_AmbiglowColors', 'EXT_OP_E2A0_1B_AmbiglowLightPosition',
    'EXT_OP_E2A0_1C_AmbiglowLightBrightness', 'EXT_OP_E2A0_1D_AmbiglowLightSpeed', 'EXT_OP_E2A0_1E_AmbiglowLightDirection',
  ] as const;
  EXT_OP_E2A0_19_AmbiglowLightMode = V(0xe2a019);
  EXT_OP_E2A0_1A_AmbiglowColors = V(0xe2a01a);
  EXT_OP_E2A0_1B_AmbiglowLightPosition = V(0xe2a01b);
  EXT_OP_E2A0_1C_AmbiglowLightBrightness = V(0xe2a01c);
  EXT_OP_E2A0_1D_AmbiglowLightSpeed = V(0xe2a01d);
  EXT_OP_E2A0_1E_AmbiglowLightDirection = V(0xe2a01e);
  /** Without ENE: E2A019 available && value != 0 (PHL/CDevice_PHLDisplay.cs:382-389). */
  EffectEnable = false;

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    populateAttrs(this, json);
    const enable = toBool(member(json, 'EffectEnable'));
    if (enable !== undefined) this.EffectEnable = enable;
    return this;
  }

  clone(): DisplayModuleAmbiglow {
    return new DisplayModuleAmbiglow().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return { ...serializeAttrs(this, mode), EffectEnable: this.EffectEnable };
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

// ───────────────────────────── Input ─────────────────────────────

/** DisplayInputSourceInfo: five public int fields in this order (OPT/DisplayInputSourceInfo.cs). */
export class DisplayInputSourceInfo implements CSharpSerializable {
  Mode = 0;
  Size = 0;
  Location = 0;
  PIPPBPSource = 0;
  InputSource = 0;

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    for (const k of ['Mode', 'Size', 'Location', 'PIPPBPSource', 'InputSource'] as const) {
      const v = toInt(member(json, k));
      if (v !== undefined) this[k] = v;
    }
    return this;
  }

  toJson(): JsonObject {
    return { Mode: this.Mode, Size: this.Size, Location: this.Location, PIPPBPSource: this.PIPPBPSource, InputSource: this.InputSource };
  }

  [toCSharpJson](): unknown {
    return this.toJson();
  }
}

export class DisplayModuleInput implements AttributeHolder, CSharpSerializable {
  readonly attrNames = ['OP_ED_InputAuto', 'OP_60_InputSource', 'OP_A5_WindowSelect', 'OP_EC_PIPPBPSizeLocation', 'OP_F6_PIPPBPSwap'] as const;
  OP_ED_InputAuto = V(0xed);
  OP_60_InputSource = V(0x60);
  OP_A5_WindowSelect = V(0xa5);
  OP_EC_PIPPBPSizeLocation = V(0xec);
  OP_F6_PIPPBPSwap = V(0xf6);
  InputSourceList: EnumItem[] = [];
  PIPPBPSourceList: EnumItem[] = [];
  InputSourceInfo = new DisplayInputSourceInfo();

  /** Get-only: the full GetDatas(VCP_EC_PIP_Location), not filtered by caps (OPT/DisplayModuleInput.cs:146). */
  get PIPLocationList(): EnumItem[] {
    return getDatas('VCP_EC_PIP_Location');
  }

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    populateAttrs(this, json);
    const inputs = parseEnumList(member(json, 'InputSourceList'));
    if (inputs) this.InputSourceList.push(...inputs);
    const pips = parseEnumList(member(json, 'PIPPBPSourceList'));
    if (pips) this.PIPPBPSourceList.push(...pips);
    this.InputSourceInfo.populate(member(json, 'InputSourceInfo'));
    return this;
  }

  clone(): DisplayModuleInput {
    return new DisplayModuleInput().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return {
      ...serializeAttrs(this, mode),
      InputSourceList: this.InputSourceList.map(cloneEnumItem),
      PIPPBPSourceList: this.PIPPBPSourceList.map(cloneEnumItem),
      InputSourceInfo: this.InputSourceInfo.toJson(),
      PIPLocationList: this.PIPLocationList,
    };
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

// ───────────────────────────── Audio ─────────────────────────────

/** Option.Lib GClass0: one EQ band {Name, Index, Value, MaxValue} (PHL/CDevice_PHLDisplay.cs:432-438). */
export interface EqItem {
  Name: string;
  Index: number;
  Value: number;
  MaxValue: number;
}

export function eqItem(Name: string, Index: number, Value: number, MaxValue: number): EqItem {
  return { Name, Index, Value, MaxValue };
}

export class DisplayModuleAudio implements AttributeHolder, CSharpSerializable {
  readonly attrNames = ['OP_62_AudioSpeakerVolume', 'OP_8D_AudioMute', 'EXT_OP_E2A0_00_AudioMode', 'OP_E0_AudioSource'] as const;
  OP_62_AudioSpeakerVolume = V(0x62);
  OP_8D_AudioMute = V(0x8d);
  EXT_OP_E2A0_00_AudioMode = V(0xe2a000);
  OP_E0_AudioSource = V(0xe0);
  EQItems: EqItem[] = [];

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    populateAttrs(this, json);
    const items = member(json, 'EQItems');
    if (Array.isArray(items)) {
      for (const it of items.filter(isJsonObject)) {
        this.EQItems.push(eqItem(toStr(member(it, 'Name')) ?? '', toInt(member(it, 'Index')) ?? 0, toInt(member(it, 'Value')) ?? 0, toInt(member(it, 'MaxValue')) ?? 0));
      }
    }
    return this;
  }

  clone(): DisplayModuleAudio {
    return new DisplayModuleAudio().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return { ...serializeAttrs(this, mode), EQItems: this.EQItems.map((e) => eqItem(e.Name, e.Index, e.Value, e.MaxValue)) };
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

// ───────────────────────────── System ─────────────────────────────

export class DisplayModuleSystem implements AttributeHolder, CSharpSerializable {
  readonly attrNames = [
    'EXT_OP_E2A0_3A_HDMI1RefreshRate', 'EXT_OP_E2A0_3B_HDMI2RefreshRate', 'EXT_OP_E2A0_3C_HDMI3RefreshRate',
    'EXT_OP_E2A0_0E_OSDSettingHorizontal', 'EXT_OP_E2A0_0F_OSDSettingVertical', 'EXT_OP_E2A0_10_OSDSettingTransparency',
    'EXT_OP_E2A0_11_OSDSettingTimeOut', 'OP_86_DisplayScaling', 'EXT_OP_E2A0_12_USB_C_Setting', 'EXT_OP_E2A0_13_USB_StandbyMode',
    'EXT_OP_E2A0_14_USB_Upstream', 'EXT_OP_E2A0_15_KVM', 'EXT_OP_E2A0_16_SmartPower', 'EXT_OP_E2A0_18_LocalDimming',
    'OP_54_PerformancePreservation', 'OP_DA_ScanMode', 'EXT_OP_E2A0_6B_Profile',
  ] as const;
  EXT_OP_E2A0_3A_HDMI1RefreshRate = V(0xe2a03a);
  EXT_OP_E2A0_3B_HDMI2RefreshRate = V(0xe2a03b);
  EXT_OP_E2A0_3C_HDMI3RefreshRate = V(0xe2a03c);
  EXT_OP_E2A0_0E_OSDSettingHorizontal = V(0xe2a00e);
  EXT_OP_E2A0_0F_OSDSettingVertical = V(0xe2a00f);
  EXT_OP_E2A0_10_OSDSettingTransparency = V(0xe2a010);
  EXT_OP_E2A0_11_OSDSettingTimeOut = V(0xe2a011);
  OP_86_DisplayScaling = V(0x86);
  EXT_OP_E2A0_12_USB_C_Setting = V(0xe2a012);
  EXT_OP_E2A0_13_USB_StandbyMode = V(0xe2a013);
  EXT_OP_E2A0_14_USB_Upstream = V(0xe2a014);
  EXT_OP_E2A0_15_KVM = V(0xe2a015);
  EXT_OP_E2A0_16_SmartPower = V(0xe2a016);
  EXT_OP_E2A0_18_LocalDimming = V(0xe2a018);
  OP_54_PerformancePreservation = V(0x54);
  OP_DA_ScanMode = V(0xda);
  EXT_OP_E2A0_6B_Profile = V(0xe2a06b);

  populate(json: unknown): this {
    if (isJsonObject(json)) populateAttrs(this, json);
    return this;
  }

  clone(): DisplayModuleSystem {
    return new DisplayModuleSystem().populate(this.toJson('ui'));
  }

  toJson(mode: SerializeMode): JsonObject {
    return serializeAttrs(this, mode);
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

// ───────────────────────────── Setup ─────────────────────────────

export class DisplayModuleSetup implements AttributeHolder, CSharpSerializable {
  readonly attrNames = [
    'OP_F2_PowerLED', 'OP_CC_OSDLanguage', 'OP_E9_ResolutionNotifier', 'EXT_OP_E2A0_17_CEC', 'EXT_OP_E2A0_35_ScreenSaver',
    'EXT_OP_E2A0_34_PixelOrbiting', 'EXT_OP_E2A0_36_PixelRefresh', 'EXT_OP_E2A0_37_PanelRefresh', 'EXT_OP_E2A0_43_AutoWarning',
    'EXT_OP_E2A0_47_UniBright', 'EXT_OP_E2A0_48_MultiLogoProtection', 'EXT_OP_E2A0_49_BoundaryDimmer',
    'EXT_OP_E2A0_4A_TaskbarDimmer', 'EXT_OP_E2A0_4B_ThermalProtection', 'EXT_OP_E2A0_61_AutoPixelRefresh',
    'EXT_OP_E2A0_54_PixelRefreshCounts', 'EXT_OP_E2A0_55_PanelRefreshCounts', 'EXT_OP_E2A0_41_FanControl',
  ] as const;
  OP_F2_PowerLED = V(0xf2);
  OP_CC_OSDLanguage = V(0xcc);
  OP_E9_ResolutionNotifier = V(0xe9);
  EXT_OP_E2A0_17_CEC = V(0xe2a017);
  EXT_OP_E2A0_35_ScreenSaver = V(0xe2a035);
  EXT_OP_E2A0_34_PixelOrbiting = V(0xe2a034);
  EXT_OP_E2A0_36_PixelRefresh = V(0xe2a036);
  EXT_OP_E2A0_37_PanelRefresh = V(0xe2a037);
  EXT_OP_E2A0_43_AutoWarning = V(0xe2a043);
  EXT_OP_E2A0_47_UniBright = V(0xe2a047);
  EXT_OP_E2A0_48_MultiLogoProtection = V(0xe2a048);
  EXT_OP_E2A0_49_BoundaryDimmer = V(0xe2a049);
  EXT_OP_E2A0_4A_TaskbarDimmer = V(0xe2a04a);
  EXT_OP_E2A0_4B_ThermalProtection = V(0xe2a04b);
  EXT_OP_E2A0_61_AutoPixelRefresh = V(0xe2a061);
  /** (E2A04D << 16) | E2A04E, else -1 (PHL/CDevice_PHLDisplay.cs:518-537). */
  WorkingTime = -1;
  /** (E2A050 << 16) | E2A051, else -1 (PHL/CDevice_PHLDisplay.cs:538-557). */
  TimeAfterPixelRefresh = -1;
  EXT_OP_E2A0_54_PixelRefreshCounts = V(0xe2a054);
  EXT_OP_E2A0_55_PanelRefreshCounts = V(0xe2a055);
  EXT_OP_E2A0_41_FanControl = V(0xe2a041);

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    populateAttrs(this, json);
    const wt = toInt(member(json, 'WorkingTime'));
    if (wt !== undefined) this.WorkingTime = wt;
    const tpr = toInt(member(json, 'TimeAfterPixelRefresh'));
    if (tpr !== undefined) this.TimeAfterPixelRefresh = tpr;
    return this;
  }

  clone(): DisplayModuleSetup {
    return new DisplayModuleSetup().populate(this.toJson('ui'));
  }

  /** Declaration order: the two int properties sit between E2A061 and E2A054 (Default.pcenter). */
  toJson(mode: SerializeMode): JsonObject {
    const attrs = serializeAttrs(this, mode);
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'EXT_OP_E2A0_54_PixelRefreshCounts') {
        out.WorkingTime = this.WorkingTime;
        out.TimeAfterPixelRefresh = this.TimeAfterPixelRefresh;
      }
      out[k] = v;
    }
    return out;
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}
