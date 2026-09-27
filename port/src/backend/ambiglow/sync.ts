// Light-Sync bookkeeping over the current profile's Sync_Profile (T_Sync_Profile, EN/T_Sync_Profile.cs):
// SyncEffect_GetData (SystemOper.cs:1518-1533 + smethod_11 :1638-1726), SyncEffect_EnableDevice
// (:1535-1636), and the display driver's sync checks (CDeviceEffectBase.cs IsInEffectSync /
// IsCanBreathingSync / CancelEffectSync; CDevice_PHLDisplay.EffectReset). Spec: 09 §9-§10,
// 20-backend-host-tail §3 rows 96-97, §3.1 (the SyncEffect_GetData fixture), §5 step 6.
//
// Monitor-only port: the display is the only IEffect driver, so every peripheral is "not connected"
// (ConnectionState false, GetDeviceByType null). The functions here are pure: they take the stored
// Sync_Profile (theme/formats.ts SyncProfileModel, bound from ThemeStore.getSyncProfile()) and return the
// result plus what must be written back; the service does the I/O (ThemeStore.setSyncProfile).

import type { Logger } from '../types.ts';
import {
  BindError,
  baseEffectDetailInfoJson,
  bindBaseEffectDetailInfo,
  bindObject,
  bindSyncProfile,
  convEnum,
  convString,
  newBaseEffectDetailInfo,
  syncProfileJson,
  type BaseEffectDetailInfoModel,
  type SyncDeviceInfoModel,
  type SyncProfileModel,
} from '../theme/formats.ts';
import { DEVICE_TYPES, mainDeviceTypeOf } from '../theme/device-types.ts';

/** DeviceType.PHL_CDeviceDisplay. */
export const SYNC_DISPLAY_DEVICE_TYPE = 100000;

/** EffectType.Off. */
const EFFECT_OFF = 0;

/**
 * DeviceType members that Extension_Enum.GetDatas(typeof(DeviceType)) iterates in smethod_11: every member
 * without [UnbindEnumExtended] (EN/DeviceType.cs: Unknown, RongYuan_MouseSPK9708_BLE and
 * HaiHui_MouseSPK9618_3395_BLE are unbound), in value order.
 */
const BOUND_DEVICE_TYPES: readonly number[] = Object.values(DEVICE_TYPES)
  .filter((v) => v !== 0 && v !== 300003 && v !== 303002)
  .sort((a, b) => a - b);

/** The connected display as smethod_11 / GetDevice see it (CDevice_PHLDisplay.GetDeviceInfo). */
export interface SyncDisplayRef {
  EquipmentType: number;
  DeviceType: number;
  /** DeviceInfo.ModelName = the current monitor name, e.g. "PHL 34M2C8600". */
  ModelName: string;
}

/** Bind ThemeStore.getSyncProfile() output (null stays null; an unbindable object is treated as absent). */
export function parseSyncProfile(raw: unknown, log?: Logger): SyncProfileModel | null {
  if (raw === null || raw === undefined) return null;
  try {
    return bindSyncProfile(raw);
  } catch (e) {
    log?.warn(`Sync_Profile ignored: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** ToCloning(): a deep copy through JSON. */
export function cloneSyncProfile(s: SyncProfileModel): SyncProfileModel {
  return bindSyncProfile(JSON.parse(JSON.stringify(syncProfileJson(s))));
}

/**
 * T_Sync_Profile.Check (EN/T_Sync_Profile.cs): EffectDetailInfo defaults to a new BaseEffectDetailInfo; with
 * no sync device left, an effect other than Off is reset too. Mutates `s`. Null list elements are dropped
 * (the vendor would throw a NullReferenceException on them in the lookups below; deviation, unreachable
 * from vendor-written files).
 */
export function checkSyncProfile(s: SyncProfileModel): SyncProfileModel {
  s.SyncDevices = s.SyncDevices.filter((d) => d !== null);
  if (s.EffectDetailInfo === null) s.EffectDetailInfo = newBaseEffectDetailInfo();
  if (s.SyncDevices.length < 1) {
    s.SyncDevices = [];
    if ((s.EffectDetailInfo.Effect?.Value ?? EFFECT_OFF) !== EFFECT_OFF) s.EffectDetailInfo = newBaseEffectDetailInfo();
  }
  return s;
}

const devices = (s: SyncProfileModel): SyncDeviceInfoModel[] => s.SyncDevices.filter((d): d is SyncDeviceInfoModel => d !== null);

/** T_Sync_Profile.GetDevice: ModelName ordinal-equal and the type or its [MainDeviceType] equal. */
export function getSyncDevice(s: SyncProfileModel | null, deviceType: number, modelName: string | null): SyncDeviceInfoModel | null {
  if (!s) return null;
  for (const d of devices(s)) {
    if (d.ModelName !== modelName) continue;
    if (d.DeviceType === deviceType || mainDeviceTypeOf(d.DeviceType) === deviceType) return d;
  }
  return null;
}

/** CDeviceEffectBase.IsInEffectSync: Sync_Profile?.IsSyncStatus(type, model) ?? false. */
export function isInEffectSync(s: SyncProfileModel | null, display: SyncDisplayRef | null): boolean {
  if (!display) return false;
  return getSyncDevice(s, display.DeviceType, display.ModelName)?.SyncStatus ?? false;
}

/** CDeviceEffectBase.IsCanBreathingSync: in sync and the stored group has more than one entry. */
export function canBreathingSync(s: SyncProfileModel | null, display: SyncDisplayRef | null): boolean {
  return isInEffectSync(s, display) && (s?.SyncDevices.length ?? 0) > 1;
}

/**
 * CancelEffectSync / EffectReset's RemoveAll: drop the display's entries (DeviceType and ModelName equal).
 * Returns whether anything was removed. Mutates `s`.
 */
export function removeSyncDevice(s: SyncProfileModel | null, deviceType: number, modelName: string): boolean {
  if (!s) return false;
  const before = s.SyncDevices.length;
  s.SyncDevices = s.SyncDevices.filter((d) => d === null || !(d.DeviceType === deviceType && d.ModelName === modelName));
  return s.SyncDevices.length !== before;
}

/**
 * SystemOper.smethod_11: the Sync_Profile the renderer sees. A clone of the stored one, Check()ed, where
 * the display entry is (re)marked connected when the display is connected with an effect type other than
 * Default (ENE in use), every peripheral entry is marked disconnected (none is connected in the monitor-only
 * port), and disconnected entries are dropped. IsCanOpenSync is true for the display (CDeviceEffectBase
 * default), and peripherals have no driver, so that last filter removes nothing.
 */
export function normalizeSyncProfile(stored: SyncProfileModel | null, display: SyncDisplayRef | null): SyncProfileModel {
  const t = checkSyncProfile(stored ? cloneSyncProfile(stored) : { EffectDetailInfo: null, SyncDevices: [] });
  for (const deviceType of BOUND_DEVICE_TYPES) {
    if (deviceType === SYNC_DISPLAY_DEVICE_TYPE) {
      const list = devices(t).filter((d) => d.DeviceType === deviceType);
      for (const d of list) d.Connect = false;
      if (display) {
        const found = list.find((d) => d.ModelName === display.ModelName);
        if (found) found.Connect = true;
        else {
          t.SyncDevices.push({
            SyncStatus: false,
            Connect: true,
            EquipmentType: display.EquipmentType,
            DeviceType: deviceType,
            ModelName: display.ModelName,
            ExtModel: null,
          });
        }
      }
    } else {
      // Dictionary record with SupSync: Connect = ConnectionState(type) = false; without: Remove(entry).
      // Either way the first entry of the type ends up dropped by the RemoveAll below.
      const first = devices(t).find((d) => d.DeviceType === deviceType);
      if (first) first.Connect = false;
    }
  }
  t.SyncDevices = devices(t).filter((d) => d.Connect);
  return t;
}

/**
 * SystemOper.SyncEffect_GetData: normalize, and with at most one syncing device clear SyncStatus both in
 * the reply and in the stored profile (in memory in the vendor; `storedChanged` tells the service to write it).
 */
export function syncEffectData(stored: SyncProfileModel | null, display: SyncDisplayRef | null): { tag: SyncProfileModel; storedChanged: boolean } {
  const tag = normalizeSyncProfile(stored, display);
  let storedChanged = false;
  if (tag.SyncDevices.filter((d) => d?.SyncStatus).length <= 1) {
    for (const d of stored ? devices(stored) : []) {
      if (d.SyncStatus) {
        d.SyncStatus = false;
        storedChanged = true;
      }
    }
    for (const d of devices(tag)) d.SyncStatus = false;
  }
  return { tag, storedChanged };
}

/** DeviceInfoBase (EN/DeviceInfoBase.cs): DeviceType, ModelName, ExtValue. */
interface DeviceInfoBase {
  DeviceType: number;
  ModelName: string | null;
  ExtValue: string | null;
}

/**
 * JsonDeserialize<List<DeviceInfoBase>>(selDevices): null for anything that is not a JSON array of objects
 * (Extension_Json swallows the exception); a null element stays null.
 */
export function parseSelDevices(text: string): (DeviceInfoBase | null)[] | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(v)) return null;
  try {
    return v.map((e, i) =>
      e === null
        ? null
        : bindObject<DeviceInfoBase>(e, `[${i}]`, () => ({ DeviceType: 0, ModelName: null, ExtValue: null }), {
            DeviceType: convEnum(DEVICE_TYPES),
            ModelName: convString,
            ExtValue: convString,
          }),
    );
  } catch (e) {
    if (e instanceof BindError) return null;
    throw e;
  }
}

/** `$"device={deviceType}"` of a DeviceType value: the member name, or the number for an undefined value. */
export function deviceTypeName(value: number): string {
  for (const [name, v] of Object.entries(DEVICE_TYPES)) if (v === value) return name;
  return String(value);
}

export interface EnableSyncInput {
  device: number;
  selDevices: string;
  /** Current Sync_Profile (null = the profile has none). */
  stored: SyncProfileModel | null;
  /** The connected display (ConnectionState(100000) and GetDeviceByType<IEffect>), else null. */
  display: SyncDisplayRef | null;
  /** The display's EffectDetail (ENE in use and the effect on), else null. */
  effectDetail: BaseEffectDetailInfoModel | null;
  /** DictMgr.GetDeviceInfoItem(type)?.EquipmentType (PCenter_DeviceInfo.json), undefined when absent. */
  equipmentTypeOf: (deviceType: number) => number | undefined;
  log?: Logger;
}

export type EnableSyncOutcome =
  /** Error reply; `nullReference` = the vendor's NullReferenceException (the reflection wrapper text). */
  | { kind: 'error'; msg: string | null; nullReference?: true; store: SyncProfileModel | null; storeChanged: boolean }
  | { kind: 'ok'; tag: SyncProfileModel; store: SyncProfileModel | null; storeChanged: boolean };

/**
 * SystemOper.SyncEffect_EnableDevice (SystemOper.cs:1535-1636) for the monitor-only port. `store` is the
 * Sync_Profile the current profile must hold afterwards (`storeChanged` = it differs from `stored` or the
 * vendor saved). Raising EVT_Effect.Effect_Sync makes every other connected device adopt the effect and then
 * saves the profile (OnSyncEffect); with no peripheral that is only the save, reported as storeChanged.
 */
export function enableSyncDevices(input: EnableSyncInput): EnableSyncOutcome {
  const { device } = input;
  // `if (Sync_Profile.IsNull()) Sync_Profile = new T_Sync_Profile()` — kept even when an error follows.
  let store = input.stored;
  let storeChanged = false;
  if (store === null) {
    store = { EffectDetailInfo: null, SyncDevices: [] };
    storeChanged = true;
  }
  const t = checkSyncProfile(cloneSyncProfile(store));
  const connected = device === SYNC_DISPLAY_DEVICE_TYPE && input.display !== null;
  if (!connected) return { kind: 'error', msg: `device=${deviceTypeName(device)} un connected`, store, storeChanged };
  const detail = input.effectDetail;
  if (detail === null) return { kind: 'error', msg: `Input device=${device} EffectDetail is null`, store, storeChanged };
  const list = parseSelDevices(input.selDevices);
  const nre = (): EnableSyncOutcome => ({ kind: 'error', msg: null, nullReference: true, store, storeChanged });
  const detailClone = () => bindBaseEffectDetailInfo(baseEffectDetailInfoJson(detail));

  // A null list (invalid JSON) or a null element dereferences null in list_0.Exists / the foreach below, in
  // both branches, before anything is stored (the work happens on the clone `t`).
  if (list === null || list.includes(null)) return nre();
  const selected = list as DeviceInfoBase[];

  if ((detail.Effect?.Value ?? EFFECT_OFF) === (t.EffectDetailInfo?.Effect?.Value ?? EFFECT_OFF)) {
    t.SyncDevices = devices(t).filter((x) => selected.some((c) => c.DeviceType === x.DeviceType && c.ModelName === x.ModelName));
    for (const x of devices(t)) {
      x.SyncStatus = false;
      x.Connect = false;
    }
    for (const item of selected) {
      let entry = getSyncDevice(t, item.DeviceType, item.ModelName);
      if (!entry) {
        const equipment = input.equipmentTypeOf(item.DeviceType);
        if (equipment === undefined) {
          input.log?.error(`DeviceType = ${deviceTypeName(item.DeviceType)} not exits DictDeviceInfo`);
          continue;
        }
        entry = { SyncStatus: false, Connect: false, EquipmentType: equipment, DeviceType: item.DeviceType, ModelName: item.ModelName, ExtModel: null };
        t.SyncDevices.push(entry);
      }
      entry.SyncStatus = true;
      // smethod_10: the display counts as connected only when its DeviceInfo.ModelName is empty (a vendor slip);
      // peripherals are never connected here. smethod_11 below re-marks the display.
      entry.Connect = item.DeviceType === SYNC_DISPLAY_DEVICE_TYPE && input.display !== null && input.display.ModelName === '' && item.ModelName === '';
    }
    t.EffectDetailInfo = detailClone();
    if (selected.length === 0) t.EffectDetailInfo = newBaseEffectDetailInfo();
    return { kind: 'ok', tag: normalizeSyncProfile(t, input.display), store: t, storeChanged: true };
  }

  t.EffectDetailInfo = detailClone();
  t.SyncDevices = [];
  for (const item of selected) {
    const equipment = input.equipmentTypeOf(item.DeviceType);
    if (equipment === undefined) {
      input.log?.error(`DeviceType = ${deviceTypeName(item.DeviceType)} not exits DictDeviceInfo`);
      continue;
    }
    t.SyncDevices.push({ SyncStatus: true, Connect: true, EquipmentType: equipment, DeviceType: item.DeviceType, ModelName: item.ModelName, ExtModel: null });
  }
  if (t.SyncDevices.length > 1) return { kind: 'ok', tag: normalizeSyncProfile(t, input.display), store: t, storeChanged: true };
  return { kind: 'ok', tag: normalizeSyncProfile(t, input.display), store, storeChanged };
}
