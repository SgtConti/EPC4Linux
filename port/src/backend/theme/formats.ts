// On-disk formats of the theme/profile engine (20-theme §3), byte-compatible with the Windows backend.
//
// Writer (SerializedFileUtil.SaveTXTConfig → SaveTxtData, 20-theme §3.1):
//   UTF-8 BOM + Newtonsoft JsonSerialize() text (nulls kept, members in C# declaration order: fields,
//   then properties, most-derived class first), trimmed, no trailing newline.
//   Newtonsoft escapes U+0085, U+2028 and U+2029, which JSON.stringify does not; that is the only
//   difference for the strings in this corpus (20-theme §3.1, 20-backend-host-tail §8 item 9).
// Reader (SerializedFileUtil.LoadTXTConfig):
//   StreamReader with BOM detection (UTF-8, UTF-16 LE/BE, UTF-32 LE/BE); ONLY THE FIRST LINE is
//   deserialized (a pretty-printed file is a load error); missing/empty/invalid → null. The binding
//   follows Newtonsoft's defaults: unknown members ignored, member names matched exactly first and then
//   case-insensitively, JSON null leaves the C# field initializer, get-only collections populated in
//   place, enums from integers or names.
//
// Deviations (documented in docs/port/impl-theme.md):
//   - writes are atomic (temp file in the same directory, fsync, rename) instead of truncate + write
//     in place (vendor bug B-4: a torn DataTheme.cfg silently reset every app theme);
//   - the JSON grammar is strict (JSON.parse); Newtonsoft's lenient extensions (comments, single
//     quotes, trailing commas) are refused as load errors. No vendor-written file uses them.

import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEVICE_TYPES, EQUIPMENT_TYPES } from './device-types.ts';

// ───────────────────────────── Text codec ─────────────────────────────

export const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

/** Characters Newtonsoft escapes but JSON.stringify writes raw: U+0085, U+2028, U+2029. */
const NEWTONSOFT_EXTRA_ESCAPES = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, 'g');

/** Newtonsoft JsonConvert.SerializeObject(value) for plain ordered objects (default settings). */
export function newtonsoftStringify(value: unknown): string {
  return JSON.stringify(value).replace(NEWTONSOFT_EXTRA_ESCAPES, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** File bytes as SaveTxtData writes them: BOM + UTF-8 text (no newline). */
export function encodeConfigText(text: string): Buffer {
  return Buffer.concat([UTF8_BOM_BYTES, Buffer.from(text, 'utf8')]);
}

/** Bytes of a config file for `value` (SaveTXTConfig: JsonSerialize().Trim()). */
export function serializeConfig(value: unknown): Buffer {
  return encodeConfigText(newtonsoftStringify(value).trim());
}

function decodeUtf32(buf: Buffer, littleEndian: boolean): string {
  let out = '';
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const cp = littleEndian ? buf.readUInt32LE(i) : buf.readUInt32BE(i);
    out += cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '�';
  }
  return out;
}

/** StreamReader(stream, UTF8Encoding(true)) with detectEncodingFromByteOrderMarks (the .NET default). */
export function decodeConfigBytes(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xfe && buf[2] === 0 && buf[3] === 0) return decodeUtf32(buf.subarray(4), true);
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 0xfe && buf[3] === 0xff) return decodeUtf32(buf.subarray(4), false);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  return new TextDecoder('utf-8').decode(buf);
}

/** First line as StreamReader.ReadLine() returns it (split at CR, LF or CRLF); null for an empty file. */
export function firstLine(text: string): string | null {
  if (text.length === 0) return null;
  const m = /[\r\n]/.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/**
 * JsonDeserialize of the first line: the parsed JSON value, or `undefined` for every case in which the
 * vendor ends up with null (empty file or line, invalid JSON, trailing content, literal null).
 */
export function parseConfigText(text: string): unknown {
  const line = firstLine(text);
  if (line === null || line.trim() === '') return undefined;
  try {
    const v: unknown = JSON.parse(line);
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

/**
 * Extension_Json.JsonDeserialize of a whole string (request parameters such as Theme_Add's app list or
 * Macro_Update's macroData — not files, so no first-line rule): `undefined` for null/empty/invalid.
 */
export function parseJsonText(text: string | null | undefined): unknown {
  if (!text || text.trim() === '') return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v === null ? undefined : v;
  } catch {
    return undefined;
  }
}

// ───────────────────────────── Newtonsoft-style binding ─────────────────────────────

export class BindError extends Error {
  override name = 'BindError';
}

/** Converter for one member value; never called with null (NullValueHandling.Ignore skips nulls). */
export type Conv<T> = (v: unknown, path: string) => T;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const convString: Conv<string> = (v, path) => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  throw new BindError(`${path}: expected string`);
};

export const convBool: Conv<boolean> = (v, path) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  throw new BindError(`${path}: expected boolean`);
};

function toInt(v: unknown, path: string, min: number, max: number): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) n = Number(v);
  else throw new BindError(`${path}: expected integer`);
  if (!Number.isFinite(n)) throw new BindError(`${path}: expected integer`);
  if (!Number.isInteger(n)) {
    // Convert.ToInt32(double): round half to even.
    const f = Math.floor(n);
    const d = n - f;
    n = d > 0.5 || (d === 0.5 && f % 2 !== 0) ? f + 1 : f;
  }
  if (n < min || n > max) throw new BindError(`${path}: value ${n} out of range`);
  return n;
}

export const convInt: Conv<number> = (v, path) => toInt(v, path, -2147483648, 2147483647);
export const convByte: Conv<number> = (v, path) => toInt(v, path, 0, 255);

/** Enum member: integer (any Int32, defined or not) or a member name (case-insensitive). */
export function convEnum(table: Readonly<Record<string, number>>): Conv<number> {
  return (v, path) => {
    if (typeof v === 'string' && !/^\s*[+-]?\d+\s*$/.test(v)) {
      const want = v.trim().toLowerCase();
      for (const [name, value] of Object.entries(table)) if (name.toLowerCase() === want) return value;
      throw new BindError(`${path}: unknown enum name ${JSON.stringify(v)}`);
    }
    return convInt(v, path);
  };
}

/** List<T>: JSON array; null elements stay null for reference types (`nullable`), else error. */
export function convList<T>(item: Conv<T>, nullable: boolean): Conv<(T | null)[]> {
  return (v, path) => {
    if (!Array.isArray(v)) throw new BindError(`${path}: expected array`);
    return v.map((e, i) => {
      if (e === null) {
        if (nullable) return null;
        throw new BindError(`${path}[${i}]: null in a value-type list`);
      }
      return item(e, `${path}[${i}]`);
    });
  };
}

/**
 * Bind a JSON object onto a fresh model (`init()` = the C# field initializers, keys in declaration
 * order). JSON members are matched to model members exactly, else case-insensitively (Newtonsoft
 * GetClosestMatchProperty); a later duplicate overwrites an earlier one; nulls and unknown members are
 * skipped.
 */
export function bindObject<T extends object>(v: unknown, path: string, init: () => T, members: { [K in keyof T]?: Conv<T[K]> }): T {
  if (!isPlainObject(v)) throw new BindError(`${path}: expected object`);
  const target = init();
  const names = Object.keys(members) as (keyof T & string)[];
  for (const [key, value] of Object.entries(v)) {
    let name = names.find((n) => n === key);
    if (name === undefined) {
      const lower = key.toLowerCase();
      name = names.find((n) => n.toLowerCase() === lower);
    }
    if (name === undefined || value === null) continue;
    const conv = members[name] as Conv<T[keyof T & string]>;
    target[name] = conv(value, `${path}.${name}`);
  }
  return target;
}

/** Converter for a nested class member. */
function convObject<T extends object>(bind: (v: unknown, path: string) => T): Conv<T> {
  return (v, path) => bind(v, path);
}

// ───────────────────────────── Theme/DataTheme.cfg (20-theme §3.2) ─────────────────────────────

/** BindAppInfo (EN/BindAppInfo.cs): BindAppFilePath (null), BindAppIconPath (""). */
export interface BindAppInfoModel {
  BindAppFilePath: string | null;
  BindAppIconPath: string | null;
}

/** ThemeInfo (EN/ThemeInfo.cs); ProfileDir, BindAppInfo, IsBind, SelProfilePath are [JsonIgnore]. */
export interface ThemeInfoModel {
  Name: string | null;
  IsDefault: boolean;
  SelProfileName: string | null;
  ProfileNames: (string | null)[];
  CycleProfileNames: (string | null)[];
  BindAppInfos: (BindAppInfoModel | null)[];
}

/** DataTheme (EN/DataTheme.cs); UserThemeInfo is [JsonIgnore]. */
export interface DataThemeModel {
  ThemeInfos: (ThemeInfoModel | null)[] | null;
}

export function newBindAppInfo(filePath: string | null = null, iconPath: string | null = ''): BindAppInfoModel {
  return { BindAppFilePath: filePath, BindAppIconPath: iconPath };
}

export function newThemeInfo(name: string | null, isDefault = false): ThemeInfoModel {
  return { Name: name, IsDefault: isDefault, SelProfileName: 'Default', ProfileNames: [], CycleProfileNames: [], BindAppInfos: [] };
}

export function bindBindAppInfo(v: unknown, path = 'BindAppInfo'): BindAppInfoModel {
  return bindObject<BindAppInfoModel>(v, path, () => newBindAppInfo(), { BindAppFilePath: convString, BindAppIconPath: convString });
}

export function bindThemeInfo(v: unknown, path = 'ThemeInfo'): ThemeInfoModel {
  return bindObject<ThemeInfoModel>(v, path, () => newThemeInfo(null), {
    Name: convString,
    IsDefault: convBool,
    SelProfileName: convString,
    ProfileNames: convList(convString, true),
    CycleProfileNames: convList(convString, true),
    BindAppInfos: convList(convObject(bindBindAppInfo), true),
  });
}

export function bindDataTheme(v: unknown, path = 'DataTheme'): DataThemeModel {
  return bindObject<DataThemeModel>(v, path, () => ({ ThemeInfos: null }), { ThemeInfos: convList(convObject(bindThemeInfo), true) });
}

export function bindAppInfoJson(b: BindAppInfoModel | null): unknown {
  return b === null ? null : { BindAppFilePath: b.BindAppFilePath, BindAppIconPath: b.BindAppIconPath };
}

/** ThemeInfo as Newtonsoft writes it (also the Tag of Theme_GetCurTheme / Theme_Switch). */
export function themeInfoJson(t: ThemeInfoModel | null): unknown {
  if (t === null) return null;
  return {
    Name: t.Name,
    IsDefault: t.IsDefault,
    SelProfileName: t.SelProfileName,
    ProfileNames: [...t.ProfileNames],
    CycleProfileNames: [...t.CycleProfileNames],
    BindAppInfos: t.BindAppInfos.map(bindAppInfoJson),
  };
}

/** List<ThemeInfo> (Tag of Theme_GetThemeInfos and of every ThemeOper mutation, TO:234-237). */
export function themeInfosJson(list: readonly (ThemeInfoModel | null)[] | null): unknown {
  return list === null ? null : list.map(themeInfoJson);
}

export function dataThemeJson(d: DataThemeModel): unknown {
  return { ThemeInfos: themeInfosJson(d.ThemeInfos) };
}

// ───────────────────────────── Theme/<T>/<P>.pcenter (20-theme §3.3) ─────────────────────────────

/** EnumItem (COM/EnumItem.cs): Name, Text, Value. */
export interface EnumItemModel {
  Name: string | null;
  Text: string | null;
  Value: number;
}

/** RGB (COM/RGB.cs): byte R = 255, G = 0, B = 0. */
export interface RgbModel {
  R: number;
  G: number;
  B: number;
}

/** BaseEffectDetailInfo (EN/BaseEffectDetailInfo.cs) with its field initializers. */
export interface BaseEffectDetailInfoModel {
  Effect: EnumItemModel | null;
  Speed: number;
  Brightness: number;
  IsRandomColor: boolean;
  IsRainbowColor: boolean;
  CurRGB: RgbModel | null;
  BgRGB: RgbModel | null;
  CurDir: number;
  CurRegion: number;
  CurStarCount: number;
}

/** T_DeviceProfile_Base (EN/T_DeviceProfile_Base.cs). */
export interface DeviceProfileDescModel {
  EquipmentType: number;
  DeviceType: number;
  ModelName: string | null;
  ExtModel: string | null;
}

/** SyncDeviceInfo : T_DeviceProfile_Base (EN/SyncDeviceInfo.cs) — own members first. */
export interface SyncDeviceInfoModel {
  SyncStatus: boolean;
  Connect: boolean;
  EquipmentType: number;
  DeviceType: number;
  ModelName: string | null;
  ExtModel: string | null;
}

/** T_Sync_Profile (EN/T_Sync_Profile.cs). */
export interface SyncProfileModel {
  EffectDetailInfo: BaseEffectDetailInfoModel | null;
  SyncDevices: (SyncDeviceInfoModel | null)[];
}

/** T_Profile (EN/T_Profile.cs). */
export interface ProfileEntryModel {
  ProfileDesc: DeviceProfileDescModel | null;
  ProfileContent: string | null;
}

/** T_Theme_Profile (EN/T_Theme_Profile.cs): Profiles is get-only (never null). */
export interface ThemeProfileModel {
  Sync_Profile: SyncProfileModel | null;
  Profiles: (ProfileEntryModel | null)[];
}

const DIRECTION_TYPES: Readonly<Record<string, number>> = {
  Default: -1, LeftToRight: 0, RightToLeft: 1, UpToDown: 2, DownToUp: 3, Spread: 5, Gathered: 4, ClockWise: 6, CounterClockWise: 7,
};
const REGION_TYPES: Readonly<Record<string, number>> = { Default: -1, AllZones: 0, FourSided: 1, Central: 2, Bottom: 3, ThirdSidedA: 4 };

/** EffectType.Off.GetItem() (EN/EffectType.cs: [Description("关闭")] Off = 0). */
export function effectOffItem(): EnumItemModel {
  return { Name: 'Off', Text: '关闭', Value: 0 };
}

export function newBaseEffectDetailInfo(): BaseEffectDetailInfoModel {
  return {
    Effect: effectOffItem(),
    Speed: 2,
    Brightness: 2,
    IsRandomColor: false,
    IsRainbowColor: false,
    CurRGB: { R: 255, G: 0, B: 0 },
    BgRGB: { R: 0, G: 0, B: 0 },
    CurDir: -1,
    CurRegion: 0,
    CurStarCount: 1,
  };
}

export function newThemeProfile(): ThemeProfileModel {
  return { Sync_Profile: null, Profiles: [] };
}

export function bindEnumItem(v: unknown, path = 'EnumItem'): EnumItemModel {
  return bindObject<EnumItemModel>(v, path, () => ({ Name: null, Text: null, Value: 0 }), { Name: convString, Text: convString, Value: convInt });
}

export function bindRgb(v: unknown, path = 'RGB'): RgbModel {
  return bindObject<RgbModel>(v, path, () => ({ R: 255, G: 0, B: 0 }), { R: convByte, G: convByte, B: convByte });
}

export function bindBaseEffectDetailInfo(v: unknown, path = 'BaseEffectDetailInfo'): BaseEffectDetailInfoModel {
  return bindObject<BaseEffectDetailInfoModel>(v, path, newBaseEffectDetailInfo, {
    Effect: convObject(bindEnumItem),
    Speed: convInt,
    Brightness: convInt,
    IsRandomColor: convBool,
    IsRainbowColor: convBool,
    CurRGB: convObject(bindRgb),
    BgRGB: convObject(bindRgb),
    CurDir: convEnum(DIRECTION_TYPES),
    CurRegion: convEnum(REGION_TYPES),
    CurStarCount: convInt,
  });
}

export function bindDeviceProfileDesc(v: unknown, path = 'ProfileDesc'): DeviceProfileDescModel {
  return bindObject<DeviceProfileDescModel>(v, path, () => ({ EquipmentType: 0, DeviceType: 0, ModelName: null, ExtModel: null }), {
    EquipmentType: convEnum(EQUIPMENT_TYPES),
    DeviceType: convEnum(DEVICE_TYPES),
    ModelName: convString,
    ExtModel: convString,
  });
}

export function bindSyncDeviceInfo(v: unknown, path = 'SyncDeviceInfo'): SyncDeviceInfoModel {
  return bindObject<SyncDeviceInfoModel>(
    v,
    path,
    () => ({ SyncStatus: false, Connect: false, EquipmentType: 0, DeviceType: 0, ModelName: null, ExtModel: null }),
    {
      SyncStatus: convBool,
      Connect: convBool,
      EquipmentType: convEnum(EQUIPMENT_TYPES),
      DeviceType: convEnum(DEVICE_TYPES),
      ModelName: convString,
      ExtModel: convString,
    },
  );
}

export function bindSyncProfile(v: unknown, path = 'Sync_Profile'): SyncProfileModel {
  return bindObject<SyncProfileModel>(v, path, () => ({ EffectDetailInfo: null, SyncDevices: [] }), {
    EffectDetailInfo: convObject(bindBaseEffectDetailInfo),
    SyncDevices: convList(convObject(bindSyncDeviceInfo), true),
  });
}

export function bindProfileEntry(v: unknown, path = 'T_Profile'): ProfileEntryModel {
  return bindObject<ProfileEntryModel>(v, path, () => ({ ProfileDesc: null, ProfileContent: null }), {
    ProfileDesc: convObject(bindDeviceProfileDesc),
    ProfileContent: convString,
  });
}

export function bindThemeProfile(v: unknown, path = 'T_Theme_Profile'): ThemeProfileModel {
  const entries = convList(convObject(bindProfileEntry), true);
  return bindObject<ThemeProfileModel>(v, path, newThemeProfile, {
    Sync_Profile: convObject(bindSyncProfile),
    // Get-only, initialised collection: Newtonsoft populates the existing (empty) list in place.
    Profiles: (value, p) => entries(value, p),
  });
}

function rgbJson(c: RgbModel | null): unknown {
  return c === null ? null : { R: c.R, G: c.G, B: c.B };
}

export function enumItemJson(e: EnumItemModel | null): unknown {
  return e === null ? null : { Name: e.Name, Text: e.Text, Value: e.Value };
}

export function baseEffectDetailInfoJson(e: BaseEffectDetailInfoModel | null): unknown {
  if (e === null) return null;
  return {
    Effect: enumItemJson(e.Effect),
    Speed: e.Speed,
    Brightness: e.Brightness,
    IsRandomColor: e.IsRandomColor,
    IsRainbowColor: e.IsRainbowColor,
    CurRGB: rgbJson(e.CurRGB),
    BgRGB: rgbJson(e.BgRGB),
    CurDir: e.CurDir,
    CurRegion: e.CurRegion,
    CurStarCount: e.CurStarCount,
  };
}

export function deviceProfileDescJson(d: DeviceProfileDescModel | null): unknown {
  return d === null ? null : { EquipmentType: d.EquipmentType, DeviceType: d.DeviceType, ModelName: d.ModelName, ExtModel: d.ExtModel };
}

function syncDeviceInfoJson(d: SyncDeviceInfoModel | null): unknown {
  if (d === null) return null;
  return { SyncStatus: d.SyncStatus, Connect: d.Connect, EquipmentType: d.EquipmentType, DeviceType: d.DeviceType, ModelName: d.ModelName, ExtModel: d.ExtModel };
}

export function syncProfileJson(s: SyncProfileModel | null): { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null {
  if (s === null) return null;
  return { EffectDetailInfo: baseEffectDetailInfoJson(s.EffectDetailInfo), SyncDevices: s.SyncDevices.map(syncDeviceInfoJson) };
}

export function profileEntryJson(p: ProfileEntryModel | null): unknown {
  return p === null ? null : { ProfileDesc: deviceProfileDescJson(p.ProfileDesc), ProfileContent: p.ProfileContent };
}

/** T_Theme_Profile as written to .pcenter files and returned by Theme_GetCurProfile. */
export function themeProfileJson(t: ThemeProfileModel): unknown {
  return { Sync_Profile: syncProfileJson(t.Sync_Profile), Profiles: t.Profiles.map(profileEntryJson) };
}

/** Deep copy (T_Theme_Profile.ToCloning(), used by Theme_Switch before applying, SO:3046). */
export function cloneThemeProfile(t: ThemeProfileModel): ThemeProfileModel {
  return bindThemeProfile(JSON.parse(JSON.stringify(themeProfileJson(t))));
}

// ───────────────────────────── Config/SoftConfig.data (20-theme §3.6) ─────────────────────────────

/** SoftConfigInfo (EN/SoftConfigInfo.cs): TurnOffLightsWhenIdle = false, TurnOffLightsWhenIdleDuration = 5. */
export interface SoftConfigModel {
  TurnOffLightsWhenIdle: boolean;
  TurnOffLightsWhenIdleDuration: number;
}

export function newSoftConfig(): SoftConfigModel {
  return { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 };
}

export function bindSoftConfig(v: unknown, path = 'SoftConfigInfo'): SoftConfigModel {
  return bindObject<SoftConfigModel>(v, path, newSoftConfig, { TurnOffLightsWhenIdle: convBool, TurnOffLightsWhenIdleDuration: convInt });
}

export function softConfigJson(s: SoftConfigModel): SoftConfigModel {
  return { TurnOffLightsWhenIdle: s.TurnOffLightsWhenIdle, TurnOffLightsWhenIdleDuration: s.TurnOffLightsWhenIdleDuration };
}

// ───────────────────────────── Theme/<T>/Macro/<name>.macro (20-theme §3.5) ─────────────────────────────

/** MacroType (EN/MacroType.cs). */
export const MACRO_TYPES: Readonly<Record<string, number>> = { Null: 0, KeyBoard: 1, Mouse: 2, Text: 3, RunCommand: 4 };
/** MacroAction (EN/MacroAction.cs). */
export const MACRO_ACTIONS: Readonly<Record<string, number>> = { Null: 0, Down: 1, Up: 2 };

/** MacroDetail (EN/MacroDetail.cs); MacroTypeName/MacroActionName are computed (Enum.ToString()). */
export interface MacroDetailModel {
  MacroTag: string | null;
  MacroType: number;
  MacroAction: number;
  DelayTime: number;
  MacroValue: string | null;
  Extra: string | null;
}

/** MacroInfo (EN/MacroInfo.cs); IsComMacro is computed. */
export interface MacroInfoModel {
  Name: string | null;
  MacroContent: (MacroDetailModel | null)[];
}

/** Enum.ToString(): the member name, or the number for an undefined value. */
function enumName(table: Readonly<Record<string, number>>, value: number): string {
  for (const [name, v] of Object.entries(table)) if (v === value) return name;
  return String(value);
}

export function newMacroInfo(name = ''): MacroInfoModel {
  return { Name: name, MacroContent: [] };
}

export function bindMacroDetail(v: unknown, path = 'MacroDetail'): MacroDetailModel {
  return bindObject<MacroDetailModel>(
    v,
    path,
    () => ({ MacroTag: null, MacroType: 0, MacroAction: 0, DelayTime: 0, MacroValue: '', Extra: '' }),
    {
      MacroTag: convString,
      MacroType: convEnum(MACRO_TYPES),
      MacroAction: convEnum(MACRO_ACTIONS),
      DelayTime: convInt,
      MacroValue: convString,
      Extra: convString,
    },
  );
}

export function bindMacroInfo(v: unknown, path = 'MacroInfo'): MacroInfoModel {
  return bindObject<MacroInfoModel>(v, path, () => newMacroInfo(), {
    Name: convString,
    MacroContent: convList(convObject(bindMacroDetail), true),
  });
}

/**
 * MacroInfo.IsComMacro (EN/MacroInfo.cs): no Text/RunCommand step. MacroContent is never null after
 * binding (a JSON null keeps the initializer); a null step counts as neither.
 */
export function macroIsComMacro(m: MacroInfoModel): boolean {
  return m.MacroContent.findIndex((x) => x !== null && (x.MacroType === MACRO_TYPES.Text || x.MacroType === MACRO_TYPES.RunCommand)) === -1;
}

export function macroDetailJson(d: MacroDetailModel | null): unknown {
  if (d === null) return null;
  return {
    MacroTag: d.MacroTag,
    MacroType: d.MacroType,
    MacroTypeName: enumName(MACRO_TYPES, d.MacroType),
    MacroAction: d.MacroAction,
    MacroActionName: enumName(MACRO_ACTIONS, d.MacroAction),
    DelayTime: d.DelayTime,
    MacroValue: d.MacroValue,
    Extra: d.Extra,
  };
}

/** MacroInfo as Newtonsoft writes it (the computed IsComMacro property last, EN/MacroInfo.cs order). */
export function macroInfoJson(m: MacroInfoModel): unknown {
  return { Name: m.Name, MacroContent: m.MacroContent.map(macroDetailJson), IsComMacro: macroIsComMacro(m) };
}

// ───────────────────────────── File I/O ─────────────────────────────

export type Binder<T> = (v: unknown, path?: string) => T;

/**
 * SerializedFileUtil.LoadTXTConfig<T>: the bound model, or null when the file is missing, empty,
 * unreadable, not JSON on its first line, or does not bind to T.
 */
export async function loadConfigFile<T>(path: string, bind: Binder<T>): Promise<T | null> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch {
    return null;
  }
  return parseConfigBytes(buf, bind);
}

export function parseConfigBytes<T>(buf: Buffer, bind: Binder<T>): T | null {
  const value = parseConfigText(decodeConfigBytes(buf));
  if (value === undefined) return null;
  try {
    return bind(value);
  } catch {
    return null;
  }
}

let tmpCounter = 0;

/**
 * Atomic replacement of `path` with `data` (deviation from SaveTxtData, which truncates in place):
 * the directory is created, the bytes go to a temp file next to the target, are fsync'ed, and the temp
 * file is renamed over the target; the directory is fsync'ed best-effort. Throws on failure (the temp
 * file is removed).
 */
export async function writeFileAtomic(path: string, data: Buffer): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  // Short hidden name in the same directory (same file system, so rename is atomic; no NAME_MAX issue
  // for long profile names; never listed as a macro because it lacks the .macro extension).
  const tmp = join(dir, `.evnia-${process.pid}-${++tmpCounter}-${randomBytes(4).toString('hex')}.tmp`);
  try {
    const fh = await open(tmp, 'wx', 0o644);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  try {
    const dh = await open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // Directory fsync is not supported everywhere; the rename itself is already atomic.
  }
}

/**
 * The vendor's own write (SaveTxtData: create directory and file, truncate, write, no rename). Used only
 * where the file identity matters: macro files are listed in creation-time order (20-theme §3.5), and a
 * rename-based rewrite would give an edited macro a new birth time and move it to the end of the list.
 * The data is fsync'ed before returning.
 */
export async function writeFileInPlace(path: string, data: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const fh = await open(path, 'w', 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export interface SaveOptions {
  /** Keep the file's identity (inode, birth time) when it already exists; see writeFileInPlace. */
  inPlace?: boolean;
  /** Receives the failure reason (the vendor logs it). */
  onError?: (e: unknown) => void;
}

/**
 * SerializedFileUtil.SaveTXTConfig: serialize (Newtonsoft order and escaping, trimmed) and write with
 * a BOM. Returns false instead of throwing, like the vendor.
 */
export async function saveConfigFile(path: string, json: unknown, options: SaveOptions = {}): Promise<boolean> {
  if (json === null || json === undefined || path === '') {
    options.onError?.(new Error('SaveTXTConfig obj is null'));
    return false;
  }
  try {
    const data = serializeConfig(json);
    if (options.inPlace && (await isFile(path))) await writeFileInPlace(path, data);
    else await writeFileAtomic(path, data);
    return true;
  } catch (e) {
    options.onError?.(e);
    return false;
  }
}

/** File.Exists: true for an existing regular file (following symlinks), false for directories. */
export async function isFile(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Directory.Exists. */
export async function isDirectory(path: string | null | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
