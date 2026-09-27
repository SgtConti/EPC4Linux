// Theme_GetDevicesBasicInfo (SO:3363-3439 smethod_22) and the display's AnalyseBasicInfo
// (PHL/PHLDisplay_Oper.cs:14-108), evaluated on the stored ProfileContent JSON.
//
// The vendor deserializes the content into T_PHLDisplay_Profile (Newtonsoft, NullValueHandling.Ignore,
// so a missing or null member keeps its field initializer) and reads a handful of members. This file
// does the same reads on the parsed JSON, with the initializer values as defaults, so it does not
// depend on the monitor module's model classes. Only the display has a driver on Linux; sections of
// other devices are skipped, which leaves Keyboard/Mouse/MousePad/Headset as [] (20-backend-host-tail
// §6.5, §6.7: every key except SyncEquipment must be an array because AboutDevice calls .filter).

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { HostServices } from '../types.ts';
import { DEVICE_TYPE_DISPLAY, DEVICE_TYPE_JIANGMENG_DONGLE_8K, EQUIPMENT_TYPE_DISPLAY, isSubDeviceType, mainDeviceTypeOf } from './device-types.ts';
import type { SyncProfileModel, ThemeProfileModel } from './formats.ts';
import { equalsIgnoreCase } from './names.ts';

/** BasicInfo_Display (EN/BasicInfo_Display.cs): own members, then BasicInfoBase.Connect, then T_DeviceProfile_Base. */
export interface BasicInfoDisplay {
  LightSync: string | null;
  LightMode: string | null;
  Resolution: string | null;
  RefreshRate: string | null;
  SmartImage: string | null;
  Input: string | null;
  AdaptiveSync: string | null;
  Connect: boolean;
  EquipmentType: number;
  DeviceType: number;
  ModelName: string | null;
  ExtModel: string | null;
}

/** DataBasicInfo (EN/DataBasicInfo.cs). */
export interface DataBasicInfo {
  SyncEquipment: string;
  Display: BasicInfoDisplay[];
  Keyboard: unknown[];
  Mouse: unknown[];
  MousePad: unknown[];
  Headset: unknown[];
}

export interface BasicInfoContext {
  /** DataOSD.s_DataDisplay.UIDisplayInfos[].MonitorName of the connected displays. */
  connectedMonitorNames: readonly string[];
  /** DictMgr.GetDisplayInfoItem(model)?.SupLightSync (MonitorInfo.json); undefined when no entry. */
  supLightSync(modelName: string): boolean | undefined;
}

/** E2A0_19_AmbiglowLightMode_E via Extension_Enum.GetDatas (AmbiglowOff is [UnbindEnumExtended]). */
const AMBIGLOW_LIGHT_MODES: ReadonlyMap<number, string> = new Map([
  [1, 'FollowVideo'],
  [2, 'FollowAudio'],
  [3, 'ColorShift'],
  [4, 'ColorWave'],
  [5, 'ColorBreathing'],
  [6, 'StarryNight'],
  [7, 'StaticMode'],
  [9, 'ColorFlow'],
  [8, 'ColorFlowReverse'],
]);

/** SwitchFlag_E.ON. */
const SWITCH_ON = 1;

class Mismatch extends Error {}

type Json = Record<string, unknown>;

/**
 * Newtonsoft member binding: every JSON member whose name matches (exactly or case-insensitively) is
 * applied in document order, nulls skipped (NullValueHandling.Ignore), so the last non-null one wins.
 */
function member(o: Json, name: string): unknown {
  const lower = name.toLowerCase();
  let v: unknown;
  for (const k of Object.keys(o)) if ((k === name || k.toLowerCase() === lower) && o[k] !== null) v = o[k];
  return v;
}

/** A nested class member: its JSON object, or {} (= the field initializer) when missing/null. */
function obj(o: Json, name: string): Json {
  const v = member(o, name);
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new Mismatch(name);
  return v as Json;
}

function arr(o: Json, name: string): unknown[] {
  const v = member(o, name);
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Mismatch(name);
  return v;
}

function str(o: Json, name: string, init: string | null): string | null {
  const v = member(o, name);
  if (v === undefined || v === null) return init;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  throw new Mismatch(name);
}

function int(o: Json, name: string, init: number): number {
  const v = member(o, name);
  if (v === undefined || v === null) return init;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
  throw new Mismatch(name);
}

function bool(o: Json, name: string, init: boolean): boolean {
  const v = member(o, name);
  if (v === undefined || v === null) return init;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return v !== 0;
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true';
  throw new Mismatch(name);
}

/** Extension_Number.ToInt32(object) = Convert.ToInt32 with 0 on failure. */
function toInt32(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) | 0 : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v) | 0;
  return 0;
}

/** AttributeInfo: err_code defaults to 0 and Value to null (AttributeInfo(opcode) constructor). */
function attr(o: Json, name: string): { errCode: number; value: unknown } {
  const a = obj(o, name);
  const value = member(a, 'Value');
  return { errCode: int(a, 'err_code', 0), value: value === undefined ? null : value };
}

/** EnumItem list entries: {Name, Value}. */
function enumItems(list: unknown[]): { name: string | null; value: number }[] {
  return list.map((e) => {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new Mismatch('EnumItem');
    return { name: str(e as Json, 'Name', null), value: int(e as Json, 'Value', 0) };
  });
}

/** T_Sync_Profile.GetDevice (EN/T_Sync_Profile.cs). */
function syncHasDevice(sync: SyncProfileModel, deviceType: number, modelName: string | null): boolean {
  for (const d of sync.SyncDevices) {
    if (d === null) continue;
    if (d.ModelName === modelName && (d.DeviceType === deviceType || mainDeviceTypeOf(d.DeviceType) === deviceType)) return true;
  }
  return false;
}

/**
 * PHLDisplay_Oper.AnalyseBasicInfo(content, syncProfile): null when the content is empty or does not
 * deserialize. The fields are assigned in the vendor's order inside one try block, so an exception
 * (a NullReferenceException on a null ModelName while a display is connected) returns the object
 * filled up to that point.
 */
export function analyseDisplayBasicInfo(content: string | null, sync: SyncProfileModel | null, ctx: BasicInfoContext): BasicInfoDisplay | null {
  if (!content) return null;
  let p: Json;
  try {
    const v: unknown = JSON.parse(content);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    p = v as Json;
  } catch {
    return null;
  }
  // Deserialization-level type checks of every member read below (a mismatch fails the whole
  // JsonDeserialize<T_PHLDisplay_Profile> in the vendor → null).
  let modelName: string | null;
  let deviceType: number;
  let eneEffectEnable: boolean;
  let ambiglowMode: { errCode: number; value: unknown };
  let currEffectName: string | null;
  let monitorResolution: string | null;
  let monitorFrequency: string | null;
  let dcApp: { errCode: number; value: unknown };
  let smartImageItems: { name: string | null; value: number }[];
  let adaptiveSync: { errCode: number; value: unknown };
  let inputSourceList: { name: string | null; value: number }[];
  let inputSource: number;
  try {
    modelName = str(p, 'ModelName', null);
    deviceType = int(p, 'DeviceType', 0);
    eneEffectEnable = bool(p, 'ENEEffectEnable', false);
    ambiglowMode = attr(obj(p, 'ModuleAmbiglow'), 'EXT_OP_E2A0_19_AmbiglowLightMode');
    currEffectName = str(obj(obj(p, 'EffectInfo'), 'CurrEffect'), 'Name', null);
    const dispaly = obj(p, 'DispalyData');
    monitorResolution = str(dispaly, 'MonitorResolution', '');
    monitorFrequency = str(dispaly, 'MonitorFrequency', '');
    dcApp = attr(p, 'OP_DC_DisplayApplication');
    smartImageItems = enumItems(arr(obj(p, 'ModuleSmartImage'), 'Items'));
    adaptiveSync = attr(obj(p, 'ModuleGameMode'), 'EXT_OP_E2A0_40_AdaptiveSync');
    const input = obj(p, 'ModuleInput');
    inputSourceList = enumItems(arr(input, 'InputSourceList'));
    inputSource = int(obj(input, 'InputSourceInfo'), 'InputSource', 0);
  } catch (e) {
    if (e instanceof Mismatch) return null;
    throw e;
  }

  const info: BasicInfoDisplay = {
    LightSync: '/',
    LightMode: '/',
    Resolution: '/',
    RefreshRate: '/',
    SmartImage: '/',
    Input: '/',
    AdaptiveSync: '/',
    Connect: false,
    EquipmentType: 0,
    DeviceType: 0,
    ModelName: null,
    ExtModel: null,
  };
  try {
    info.Connect = ctx.connectedMonitorNames.findIndex((n) => {
      if (modelName === null) throw new Error('NullReferenceException');
      return equalsIgnoreCase(modelName, n);
    }) !== -1;
    info.EquipmentType = EQUIPMENT_TYPE_DISPLAY;
    info.DeviceType = deviceType;
    info.ModelName = modelName;
    // method_1 (LightSync)
    const sup = modelName ? ctx.supLightSync(modelName) : undefined;
    info.LightSync = sup === true ? (sync !== null && syncHasDevice(sync, deviceType, modelName) && sync.SyncDevices.length > 1 ? 'On' : 'Off') : '/';
    // method_3 (LightMode): without ENE the DDC mode name, with ENE the current effect name.
    if (!eneEffectEnable) {
      info.LightMode =
        ambiglowMode.errCode === 0 && ambiglowMode.value !== null ? (AMBIGLOW_LIGHT_MODES.get(toInt32(ambiglowMode.value)) ?? '/') : '/';
    } else {
      info.LightMode = currEffectName;
    }
    info.Resolution = monitorResolution;
    info.RefreshRate = monitorFrequency;
    // method_4 (SmartImage): SDR items only; HDR profiles have none → "/" (12 §3.8).
    if (dcApp.errCode === 0 && dcApp.value !== null && smartImageItems.length > 0) {
      const want = toInt32(dcApp.value);
      info.SmartImage = smartImageItems.find((i) => i.value === want)?.name ?? '/';
    } else {
      info.SmartImage = '/';
    }
    // method_2 (AdaptiveSync)
    info.AdaptiveSync = adaptiveSync.errCode === 0 ? (toInt32(adaptiveSync.value) !== SWITCH_ON ? 'Off' : 'On') : '/';
    // method_5 (Input)
    info.Input = inputSourceList.find((i) => i.value === inputSource)?.name ?? '/';
  } catch {
    // ZLog.Exception(ex); the partially filled object is returned (PHLDisplay_Oper.cs:100-106).
  }
  return info;
}

/**
 * SystemOper.smethod_22(profile, equipmentType, bool_2: false): every section of the profile, connected
 * or not; sub-device types and JiangMeng_Mouse_Dongle_8K skipped; `equipmentType` -1 = all.
 */
export function buildDataBasicInfo(profile: ThemeProfileModel | null, equipmentType: number, ctx: BasicInfoContext): DataBasicInfo {
  const data: DataBasicInfo = { SyncEquipment: '', Display: [], Keyboard: [], Mouse: [], MousePad: [], Headset: [] };
  if (!profile) return data;
  for (const entry of profile.Profiles) {
    const desc = entry?.ProfileDesc;
    if (!entry || !desc) continue;
    const deviceType = desc.DeviceType;
    if (isSubDeviceType(deviceType) || deviceType === DEVICE_TYPE_JIANGMENG_DONGLE_8K) continue;
    // DictMgr.GetDeviceInfoItem(deviceType).EquipmentType; only the display has a driver on Linux
    // (smethod_6 has no peripheral drivers in the monitor-only port).
    if (deviceType !== DEVICE_TYPE_DISPLAY) continue;
    if (equipmentType !== -1 && equipmentType !== EQUIPMENT_TYPE_DISPLAY) continue;
    const info = analyseDisplayBasicInfo(entry.ProfileContent, profile.Sync_Profile, ctx);
    if (info) data.Display.push(info);
  }
  return data;
}

// ───────────────────────────── MonitorInfo.json (DictMgr display table) ─────────────────────────────

interface MonitorInfoEntry {
  Name?: unknown;
  SupLightSync?: unknown;
}

interface MonitorInfoFile {
  Version?: unknown;
  Monitors?: unknown;
}

/**
 * DictMgr.GetDisplayInfoItem (Data_DisplayInfo.cs): the first Monitors[] entry whose Name matches
 * `^((PHL )|(PHL_)|(PHL))?<Name>$` case-insensitively. The vendor reads %APPDATA%\evnia\MonitorInfo.json;
 * on Linux the main process ships a bundled copy in resourcesDir and lets a user copy in appDataDir win
 * when its Version is not lower (main/monitor-info.ts, 14 §7.5), so the same selection is made here.
 */
export class MonitorInfoTable {
  readonly #paths: { user: string; bundled: string };
  #cache: { key: string; monitors: MonitorInfoEntry[] } | null = null;

  constructor(host: Pick<HostServices, 'appDataDir' | 'resourcesDir'>) {
    this.#paths = { user: join(host.appDataDir, 'MonitorInfo.json'), bundled: join(host.resourcesDir, 'MonitorInfo.json') };
  }

  async #read(path: string): Promise<{ file: MonitorInfoFile; mtime: number } | null> {
    try {
      const s = await stat(path);
      const text = await readFile(path, 'utf8');
      const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (v === null || typeof v !== 'object' || !Array.isArray((v as MonitorInfoFile).Monitors)) return null;
      return { file: v as MonitorInfoFile, mtime: s.mtimeMs };
    } catch {
      return null;
    }
  }

  /** Reload when either file changed; returns the Monitors list in use. */
  async load(): Promise<MonitorInfoEntry[]> {
    const [user, bundled] = await Promise.all([this.#read(this.#paths.user), this.#read(this.#paths.bundled)]);
    const key = `${user?.mtime ?? '-'}|${bundled?.mtime ?? '-'}`;
    if (this.#cache?.key === key) return this.#cache.monitors;
    let chosen: MonitorInfoFile | null = null;
    if (user && bundled) chosen = Number(user.file.Version ?? 0) >= Number(bundled.file.Version ?? 0) ? user.file : bundled.file;
    else chosen = user?.file ?? bundled?.file ?? null;
    const monitors = (chosen?.Monitors as unknown[] | undefined)?.filter((m): m is MonitorInfoEntry => typeof m === 'object' && m !== null) ?? [];
    this.#cache = { key, monitors };
    return monitors;
  }

  /** SupLightSync of the matching entry; undefined without one (the vendor then reports "/"). */
  static supLightSync(monitors: readonly MonitorInfoEntry[], modelName: string): boolean | undefined {
    if (!modelName) return undefined;
    for (const m of monitors) {
      if (typeof m.Name !== 'string') continue;
      let re: RegExp;
      try {
        re = new RegExp(`^((PHL )|(PHL_)|(PHL))?${m.Name}$`, 'i');
      } catch {
        continue;
      }
      if (re.test(modelName)) return m.SupLightSync === true;
    }
    return undefined;
  }
}
