// DispalyData (sic) = OPT/DispalyOtherInfo.cs with MonitorEDIDInfo_T = PB/DisplayEDIDInfo.cs.
// 20-monitor-io-linux-consolidation §3.1: the 14 EDID strings come from EDID256Block (ddc/edid.ts
// edidDisplayStrings); the three mode strings default to "" when the OS cannot tell (vendor defaults).

import type { SerializeMode } from '../../types.ts';
import { type CSharpSerializable, toCSharpJson } from '../../core/json.ts';
import type { DisplayEdidStrings } from '../../ddc/edid.ts';
import { type JsonObject, isJsonObject, member, toStr } from './json-populate.ts';

/** DisplayEDIDInfo member order (PB/DisplayEDIDInfo.cs:51-245; PROF shows the same order). */
export const EDID_INFO_KEYS = [
  'sManufacturer', 'sManufacturerDate', 'PlugAndPlayID', 'sMonitorName', 'sSerialNumber', 'sVersion', 'ScreenSize',
  'TimingRecommandation', 'DisplayGamma', 'DisplayTypeAndSignal', 'RedChromaticity', 'GreenChromaticity',
  'BlueChromaticity', 'WhitePoint',
] as const satisfies ReadonlyArray<keyof DisplayEdidStrings>;

export type DisplayEdidInfo = { [K in (typeof EDID_INFO_KEYS)[number]]: string | null };

/** `new DisplayEDIDInfo()`: every string null. */
export function emptyEdidInfo(): DisplayEdidInfo {
  const o = {} as DisplayEdidInfo;
  for (const k of EDID_INFO_KEYS) o[k] = null;
  return o;
}

export function edidInfoFrom(strings: DisplayEdidStrings): DisplayEdidInfo {
  const o = emptyEdidInfo();
  for (const k of EDID_INFO_KEYS) o[k] = strings[k];
  return o;
}

export class DispalyOtherInfo implements CSharpSerializable {
  MonitorEDIDInfo_T: DisplayEdidInfo = emptyEdidInfo();
  /** "<W>x<H>" of the current mode (CWinSysDisplay; Linux: 20-monitor-io §3.5). */
  MonitorResolution = '';
  /** "<n>Hz", integer (D7); parsed by the constraints (DisplayFuncConstraints.method_4). */
  MonitorFrequency = '';
  /** "0°" / "90°" / "180°" / "270°". */
  MonitorOrientation = '';

  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    const edid = member(json, 'MonitorEDIDInfo_T');
    if (isJsonObject(edid)) {
      for (const k of EDID_INFO_KEYS) {
        const v = toStr(member(edid, k));
        if (v !== undefined) this.MonitorEDIDInfo_T[k] = v;
      }
    }
    for (const k of ['MonitorResolution', 'MonitorFrequency', 'MonitorOrientation'] as const) {
      const v = toStr(member(json, k));
      if (v !== undefined) this[k] = v;
    }
    return this;
  }

  toJson(): JsonObject {
    return {
      MonitorEDIDInfo_T: { ...this.MonitorEDIDInfo_T },
      MonitorResolution: this.MonitorResolution,
      MonitorFrequency: this.MonitorFrequency,
      MonitorOrientation: this.MonitorOrientation,
    };
  }

  [toCSharpJson](_mode: SerializeMode): unknown {
    return this.toJson();
  }
}
