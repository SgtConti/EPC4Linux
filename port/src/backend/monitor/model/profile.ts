// T_PHLDisplay_Profile (OPT/T_PHLDisplay_Profile.cs:16-234) over T_DeviceProfile_Base (ENT/
// T_DeviceProfile_Base.cs:19-73): the monitor's whole state, as the hub returns it (Profile_GetDeviceData,
// PHL_SwitchDisplay, PHL_ReloadData, Profile_Reset) and as PurifyProfile stores it in a .pcenter.
//
// Serialization modes (core/json.ts, 12 §2.1, 20-enum §1.5):
//   'ui' / 'uiProfileGet'  every member, nulls kept (no display member carries [JsonIgnoreEx(IgnoreUI)])
//   'profile'              HasUSBSetting and the AttributeInfo IgnoreProfile members dropped, nulls dropped
// Member order: IsSmartImageHDR, HasUSBSetting, OP_DC_DisplayApplication, ModuleSmartImage,
// ModuleSmartImageHDR, ModuleGameMode, ModuleAmbiglow, ModuleInput, ModuleAudio, ModuleSystem, ModuleSetup,
// ENEEffectEnable, EffectInfo, DispalyData, then the base EquipmentType, DeviceType, ModelName, ExtModel.

import type { SerializeMode } from '../../types.ts';
import { type CSharpSerializable, serialize, toCSharpJson } from '../../core/json.ts';
import { AttributeInfo } from './attribute-info.ts';
import { DispalyOtherInfo } from './display-data.ts';
import { DisplayEffectInfo } from './effect.ts';
import { type JsonObject, isJsonObject, member, parseJsonObject, toBool, toInt, toStr } from './json-populate.ts';
import {
  DisplayModuleAmbiglow,
  DisplayModuleAudio,
  DisplayModuleGameMode,
  DisplayModuleInput,
  DisplayModuleSetup,
  DisplayModuleSmartImage,
  DisplayModuleSmartImageHDR,
  DisplayModuleSystem,
} from './modules.ts';

/** EquipmentType.Display. */
export const EQUIPMENT_DISPLAY = 1;
/** DeviceType.PHL_CDeviceDisplay. */
export const DEVICE_TYPE_DISPLAY = 100000;

export class T_PHLDisplay_Profile implements CSharpSerializable {
  IsSmartImageHDR = false;
  /** [JsonIgnoreEx(IgnoreProfile)]: E2A012 ∨ E2A014 ∨ E2A015 available (PHL/CDevice_PHLDisplay.cs:491-516). */
  HasUSBSetting = false;
  OP_DC_DisplayApplication = AttributeInfo.of(0xdc);
  ModuleSmartImage = new DisplayModuleSmartImage();
  ModuleSmartImageHDR = new DisplayModuleSmartImageHDR();
  ModuleGameMode = new DisplayModuleGameMode();
  ModuleAmbiglow = new DisplayModuleAmbiglow();
  ModuleInput = new DisplayModuleInput();
  ModuleAudio = new DisplayModuleAudio();
  ModuleSystem = new DisplayModuleSystem();
  ModuleSetup = new DisplayModuleSetup();
  ENEEffectEnable = false;
  /** Initializer `new DisplayEffectInfo()`; method_4 sets null transiently without ENE (20-enum §8 item 4). */
  EffectInfo: DisplayEffectInfo | null = new DisplayEffectInfo();
  DispalyData = new DispalyOtherInfo();
  EquipmentType = 0;
  DeviceType = 0;
  ModelName: string | null = null;
  ExtModel: string | null = null;

  /** The AttributeInfo-typed properties of the profile object itself (Extension_AttributeInfo.GetValue<T>). */
  readonly attrNames = ['OP_DC_DisplayApplication'] as const;

  /** JsonDeserialize<T_PHLDisplay_Profile>(content): null for an empty or unparsable string (never throws). */
  static parse(content: string | null | undefined): T_PHLDisplay_Profile | null {
    const json = parseJsonObject(content);
    return json ? new T_PHLDisplay_Profile().populate(json) : null;
  }

  /** Newtonsoft populate onto the initializer values (json-populate.ts). */
  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    const hdr = toBool(member(json, 'IsSmartImageHDR'));
    if (hdr !== undefined) this.IsSmartImageHDR = hdr;
    const usb = toBool(member(json, 'HasUSBSetting'));
    if (usb !== undefined) this.HasUSBSetting = usb;
    this.OP_DC_DisplayApplication.populate(member(json, 'OP_DC_DisplayApplication'));
    this.ModuleSmartImage.populate(member(json, 'ModuleSmartImage'));
    this.ModuleSmartImageHDR.populate(member(json, 'ModuleSmartImageHDR'));
    this.ModuleGameMode.populate(member(json, 'ModuleGameMode'));
    this.ModuleAmbiglow.populate(member(json, 'ModuleAmbiglow'));
    this.ModuleInput.populate(member(json, 'ModuleInput'));
    this.ModuleAudio.populate(member(json, 'ModuleAudio'));
    this.ModuleSystem.populate(member(json, 'ModuleSystem'));
    this.ModuleSetup.populate(member(json, 'ModuleSetup'));
    const ene = toBool(member(json, 'ENEEffectEnable'));
    if (ene !== undefined) this.ENEEffectEnable = ene;
    const effect = member(json, 'EffectInfo');
    if (isJsonObject(effect)) (this.EffectInfo ??= new DisplayEffectInfo()).populate(effect);
    this.DispalyData.populate(member(json, 'DispalyData'));
    const eq = toInt(member(json, 'EquipmentType'));
    if (eq !== undefined) this.EquipmentType = eq;
    const dt = toInt(member(json, 'DeviceType'));
    if (dt !== undefined) this.DeviceType = dt;
    const model = toStr(member(json, 'ModelName'));
    if (model !== undefined) this.ModelName = model;
    const ext = toStr(member(json, 'ExtModel'));
    if (ext !== undefined) this.ExtModel = ext;
    return this;
  }

  /** ToCloning(): default-mode JSON round trip (Extension_Object.cs:18-29). */
  clone(): T_PHLDisplay_Profile {
    return new T_PHLDisplay_Profile().populate(this.toJson('ui'));
  }

  /** PurifyProfile(): JsonSerialize(IgnoreProfile, bIgnoreNullValue:true) (EBASE/GClass0.cs:168-171). */
  purify(): string {
    return serialize(this, 'profile');
  }

  toJson(mode: SerializeMode): JsonObject {
    const out: JsonObject = { IsSmartImageHDR: this.IsSmartImageHDR };
    if (mode !== 'profile') out.HasUSBSetting = this.HasUSBSetting;
    out.OP_DC_DisplayApplication = this.OP_DC_DisplayApplication.toJson(mode);
    out.ModuleSmartImage = this.ModuleSmartImage.toJson(mode);
    out.ModuleSmartImageHDR = this.ModuleSmartImageHDR.toJson(mode);
    out.ModuleGameMode = this.ModuleGameMode.toJson(mode);
    out.ModuleAmbiglow = this.ModuleAmbiglow.toJson(mode);
    out.ModuleInput = this.ModuleInput.toJson(mode);
    out.ModuleAudio = this.ModuleAudio.toJson(mode);
    out.ModuleSystem = this.ModuleSystem.toJson(mode);
    out.ModuleSetup = this.ModuleSetup.toJson(mode);
    out.ENEEffectEnable = this.ENEEffectEnable;
    out.EffectInfo = this.EffectInfo ? this.EffectInfo.toJson() : null;
    out.DispalyData = this.DispalyData.toJson();
    out.EquipmentType = this.EquipmentType;
    out.DeviceType = this.DeviceType;
    out.ModelName = this.ModelName;
    out.ExtModel = this.ExtModel;
    return out;
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}
