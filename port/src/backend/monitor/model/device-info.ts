// Device_GetConnectList / Device_GetDeviceInfo payloads for the display (CDevice_PHLDisplay.GetDeviceInfo,
// PHL/CDevice_PHLDisplay.cs:218-246; 20-backend-host-tail §5 step 3 and §6) and the two DictMgr tables
// (PBASE/DictMgr.cs): PCenter_DeviceInfo.json (static device records) and MonitorInfo.json (model
// whitelist + SupLightEffect/SupLightSync).
//
// DeviceInfo : DictDeviceInfo serializes DeviceInfo's own members first (StrFwVersion, FwVersion,
// ExtDeviceInfo), then the DictDeviceInfo members without the six [JsonIgnore] computed names.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../../types.ts';
import { stripBom } from '../../core/json.ts';
import { type JsonObject, isJsonObject, member, toBool, toInt, toStr } from './json-populate.ts';
import { DEVICE_TYPE_DISPLAY, EQUIPMENT_DISPLAY } from './profile.ts';

/** UIDisplayInfo: four public fields (PBASE/UIDisplayInfo.cs). */
export interface UIDisplayInfo {
  DisplayName: string;
  MonitorName: string;
  DeviceName: string;
  DisplaySN: string;
}

/** ExternDispalyInfo {CurSN, DisplayList} (OPT/ExternDispalyInfo.cs). */
export interface ExternDispalyInfo {
  CurSN: string;
  DisplayList: UIDisplayInfo[];
}

/** DictDeviceInfo serialized members in declaration order (ENT/DictDeviceInfo.cs). */
export interface DictDeviceInfo {
  DeviceType: number;
  FactoryType: number;
  EquipmentType: number;
  ModelName: string | null;
  ExtModel: string | null;
  HasBattery: boolean;
  Vid: number;
  Pid: number;
  IUSB_USAGE_PAGE: number;
  IUSB_USAGE: number;
  CreateDevice: number;
  CheckFState: number;
  SupEffect: boolean;
  SupSync: boolean;
  ProfileCount: number;
  SupGameMode: boolean;
  Extra: string | null;
  ConnectMode: number;
}

export interface DeviceInfo extends DictDeviceInfo {
  StrFwVersion: string | null;
  FwVersion: number;
  ExtDeviceInfo: ExternDispalyInfo | null;
}

/**
 * The PCenter_DeviceInfo.json record for DeviceType 100000 as shipped in 1.13.0
 * (resources/bin/res/data/PCenter_DeviceInfo.json; 20-backend-host-tail §5 step 3, CONFIRMED). Used when
 * the bundled file cannot be read.
 */
export const DISPLAY_DEVICE_RECORD: Readonly<DictDeviceInfo> = Object.freeze({
  DeviceType: DEVICE_TYPE_DISPLAY,
  FactoryType: 1,
  EquipmentType: EQUIPMENT_DISPLAY,
  ModelName: 'Display',
  ExtModel: '',
  HasBattery: false,
  Vid: 0,
  Pid: 0,
  IUSB_USAGE_PAGE: 0,
  IUSB_USAGE: 0,
  CreateDevice: 0,
  CheckFState: 0,
  SupEffect: true,
  SupSync: true,
  ProfileCount: 1,
  SupGameMode: false,
  Extra: '',
  ConnectMode: -1,
});

/** Parse one PCenter_DeviceInfo.json record (all values are strings in the shipped file; Newtonsoft converts). */
export function parseDeviceRecord(json: JsonObject): DictDeviceInfo {
  const n = (k: string, d: number) => toInt(member(json, k)) ?? d;
  const b = (k: string, d: boolean) => toBool(member(json, k)) ?? d;
  const s = (k: string) => toStr(member(json, k)) ?? null;
  return {
    DeviceType: n('DeviceType', 0),
    FactoryType: n('FactoryType', 0),
    EquipmentType: n('EquipmentType', 0),
    ModelName: s('ModelName'),
    ExtModel: s('ExtModel'),
    HasBattery: b('HasBattery', false),
    Vid: n('Vid', 0),
    Pid: n('Pid', 0),
    IUSB_USAGE_PAGE: n('IUSB_USAGE_PAGE', 0),
    IUSB_USAGE: n('IUSB_USAGE', 0),
    CreateDevice: n('CreateDevice', 0),
    CheckFState: n('CheckFState', 0),
    SupEffect: b('SupEffect', true),
    SupSync: b('SupSync', true),
    ProfileCount: n('ProfileCount', 1),
    SupGameMode: b('SupGameMode', false),
    Extra: toStr(member(json, 'Extra')) ?? '',
    ConnectMode: n('ConnectMode', 0),
  };
}

/** MonitorInfo.json entry (ENT/DictDisplayInfo.cs). */
export interface DictDisplayInfo {
  Name: string;
  SupUsbDDC: boolean;
  SupOTA: boolean;
  SupLightEffect: boolean;
  SupLightSync: boolean;
  HDR: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `^((PHL )|(PHL_)|(PHL))?<name>$`, case-insensitive (Data_DisplayInfo.GetDisplayInfoItem, GClass3.method_2). */
export function modelNamePattern(name: string): RegExp {
  return new RegExp(`^((PHL )|(PHL_)|(PHL))?${escapeRegex(name)}$`, 'i');
}

/** CDevice_PHLDisplay ctor: MonitorInfo names with a leading "PHL "/"PHL_"/"PHL" removed and trimmed. */
export function stripPhlPrefix(name: string): string {
  if (name.startsWith('PHL ')) return name.slice(4).trim();
  if (name.startsWith('PHL_')) return name.slice(4).trim();
  if (name.startsWith('PHL')) return name.slice(3).trim();
  return name;
}

/** DictMgr: the static tables the display driver consults. */
export class DeviceDictionary {
  readonly displayRecord: DictDeviceInfo;
  readonly monitors: readonly DictDisplayInfo[] | null;

  constructor(displayRecord: DictDeviceInfo, monitors: readonly DictDisplayInfo[] | null) {
    this.displayRecord = displayRecord;
    this.monitors = monitors;
  }

  /**
   * Load PCenter_DeviceInfo.json from `resourcesDir`, and MonitorInfo.json from `appDataDir` (the vendor
   * reads %APPDATA%\evnia\MonitorInfo.json, WorkspacePath.UI_APP_DATA_PATH) falling back to the bundled copy
   * in `resourcesDir`. Missing or broken files are logged; the display record falls back to the built-in
   * 1.13.0 values.
   */
  static async load(dirs: { resourcesDir: string; appDataDir: string }, log?: Logger): Promise<DeviceDictionary> {
    let record: DictDeviceInfo = { ...DISPLAY_DEVICE_RECORD };
    const devices = await readJson(join(dirs.resourcesDir, 'PCenter_DeviceInfo.json'), log);
    const records = devices ? member(devices, 'RECORDS') : undefined;
    const found = Array.isArray(records) ? records.filter(isJsonObject).find((r) => toInt(member(r, 'DeviceType')) === DEVICE_TYPE_DISPLAY) : undefined;
    if (found) record = parseDeviceRecord(found);
    else log?.warn('PCenter_DeviceInfo.json: no record for DeviceType 100000; using the built-in 1.13.0 values');

    let monitors: DictDisplayInfo[] | null = null;
    for (const dir of [dirs.appDataDir, dirs.resourcesDir]) {
      const info = await readJson(join(dir, 'MonitorInfo.json'), log);
      const list = info ? member(info, 'Monitors') : undefined;
      if (!Array.isArray(list)) continue;
      monitors = list.filter(isJsonObject).map((m) => ({
        Name: toStr(member(m, 'Name')) ?? '',
        SupUsbDDC: toBool(member(m, 'SupUsbDDC')) ?? false,
        SupOTA: toBool(member(m, 'SupOTA')) ?? false,
        SupLightEffect: toBool(member(m, 'SupLightEffect')) ?? false,
        SupLightSync: toBool(member(m, 'SupLightSync')) ?? false,
        HDR: toInt(member(m, 'HDR')) ?? 0,
      }));
      break;
    }
    if (!monitors) log?.warn('MonitorInfo.json not found: every Philips monitor is treated as supported');
    return new DeviceDictionary(record, monitors);
  }

  /** GetDisplayInfoItem(modelName): the first entry whose Name matches the EDID model name. */
  displayInfo(modelName: string | null): DictDisplayInfo | null {
    if (!modelName || !this.monitors) return null;
    return this.monitors.find((m) => m.Name !== '' && modelNamePattern(m.Name).test(modelName)) ?? null;
  }

  /**
   * GClass3.method_2 (IsSupportModelName) against GetSupDisplayModelNames() with the PHL prefix removed.
   * Deviation: without any MonitorInfo.json the vendor supports nothing; the port then accepts every
   * monitor that passed the "PHL" brand filter, so a missing data file does not hide the user's monitor.
   */
  supportsModel(edidModelName: string): boolean {
    if (!this.monitors) return edidModelName !== '';
    return this.monitors.some((m) => m.Name !== '' && modelNamePattern(stripPhlPrefix(m.Name)).test(edidModelName));
  }
}

async function readJson(path: string, log?: Logger): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log?.warn(`${path}: ${(e as Error).message}`);
    return null;
  }
  try {
    const v: unknown = JSON.parse(stripBom(text));
    return isJsonObject(v) ? v : null;
  } catch (e) {
    log?.warn(`${path}: invalid JSON (${(e as Error).message})`);
    return null;
  }
}

/**
 * CDevice_PHLDisplay.GetDeviceInfo: the PCenter_DeviceInfo record with ModelName = current display's
 * MonitorName, ExtDeviceInfo = {CurSN, DisplayList}, SupEffect/SupSync from MonitorInfo.json.
 * StrFwVersion/FwVersion are never set for the display (null / 0; FwVersion must stay a number because
 * the renderer calls .toString() on it, 20-backend-host-tail §6 item 2).
 */
export function displayDeviceInfo(dict: DeviceDictionary, currentMonitorName: string, ext: ExternDispalyInfo): DeviceInfo {
  const base = { ...dict.displayRecord, ModelName: currentMonitorName };
  const item = dict.displayInfo(currentMonitorName);
  if (item) {
    base.SupEffect = item.SupLightEffect;
    base.SupSync = item.SupLightSync;
  }
  return {
    StrFwVersion: null,
    FwVersion: 0,
    ExtDeviceInfo: { CurSN: ext.CurSN, DisplayList: ext.DisplayList.map((d) => ({ ...d })) },
    DeviceType: base.DeviceType,
    FactoryType: base.FactoryType,
    EquipmentType: base.EquipmentType,
    ModelName: base.ModelName,
    ExtModel: base.ExtModel,
    HasBattery: base.HasBattery,
    Vid: base.Vid,
    Pid: base.Pid,
    IUSB_USAGE_PAGE: base.IUSB_USAGE_PAGE,
    IUSB_USAGE: base.IUSB_USAGE,
    CreateDevice: base.CreateDevice,
    CheckFState: base.CheckFState,
    SupEffect: base.SupEffect,
    SupSync: base.SupSync,
    ProfileCount: base.ProfileCount,
    SupGameMode: base.SupGameMode,
    Extra: base.Extra,
    ConnectMode: base.ConnectMode,
  };
}
