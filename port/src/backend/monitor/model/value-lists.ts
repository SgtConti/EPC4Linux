// DataOSD (PBASE/DataOSD.cs:92-431, CONFIRMED): the capability string → the global SupportOSDList of
// AttributeInfo with their ValueLists (20-enum-valuelist-catalog §1.2-1.3, §3), plus the helpers the
// driver uses on that list (PIPPBPEnable, GetResetSmartImageValue).
//
// Rules (§1.2): walk the parsed capability map in capability order. A code bound in StandardList gets
// `new AttributeInfo(code)` and, with a non-empty sub-list, smethod_1; a code bound in E2A0_ExternList gets
// smethod_2; anything else is logged "UnHandle vcpCode". A bound code with an empty sub-list or without a
// `case` keeps ValueList null.
//   smethod_3(enum, caps) = GetDatas(enum) (sorted) ∩ caps by (byte)Value;
//   smethod_4(enum, caps) = caps bytes in capability order, each looked up in the enum (DualResolution,
//     Profile, GamePQ);
//   DC: the table picked by the LAST caps byte (E1..E4 → SmartImage_E1..E4) + SmartImageHDR_E appended.

import type { Logger } from '../../types.ts';
import { AttributeInfo } from './attribute-info.ts';
import type { EnumName } from './enums.ts';
import { type EnumItem, getDatas, isBoundExternCode, isBoundStandardCode, isExternName, isStandardName, opcodeOf } from './enum-items.ts';

/** smethod_1 (standard codes): code → value enum for smethod_3 (DataOSD.cs:158-243). DC and F7 are special-cased. */
const STANDARD_RULES: ReadonlyMap<number, EnumName> = new Map<number, EnumName>([
  [0x60, 'VCP_60_InputSource'],
  [0x54, 'VCP_54_PixelOrbiting'],
  [0x14, 'VCP_14_SelectColorPreset'],
  [0x86, 'VCP_86_DisplayScaling'],
  [0x72, 'VCP_72_Gamma'],
  [0xaa, 'VCP_AA_ScreenOrientation'],
  [0x8d, 'VCP_8D_AudioMute'],
  [0xda, 'VCP_DA_ScanMode'],
  [0xd6, 'VCP_D6_SmartPower'],
  [0xcc, 'VCP_CC_OSDLanguage'],
  [0xe0, 'VCP_E0_AudioSourceSelect'],
  [0xf7, 'VCP_F7_PIPPBPType'],
  [0xe9, 'VCP_E9_ResolutionNotifier'],
  [0xeb, 'VCP_EB_SmartResponse'],
  [0xec, 'VCP_EC_PIP_Size'],
  [0xed, 'SwitchFlag_E'],
  [0xf0, 'SwitchFlag_E'],
  [0xf2, 'VCP_F2_PowerLED'],
]);

const SWITCH_FLAG_EXT = [
  0x03, 0x07, 0x08, 0x13, 0x16, 0x17, 0x23, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x32, 0x36, 0x37, 0x40,
  0x43, 0x46, 0x47, 0x4b, 0x4c, 0x61,
];

/** smethod_2 (E2A0 codes, keyed by the low byte): value enum and whether capability order is kept (smethod_4). */
const EXTERN_RULES: ReadonlyMap<number, { e: EnumName; capsOrder?: true }> = new Map<number, { e: EnumName; capsOrder?: true }>([
  [0x88, { e: 'E2A0_88_GamePQ_E', capsOrder: true }],
  [0x00, { e: 'E2A0_00_AudioMode_E' }],
  [0x01, { e: 'E2A0_01_AudioEQ_E' }],
  [0x04, { e: 'E2A0_04_SmartCrosshair_E' }],
  [0x06, { e: 'E2A0_06_SharpShooterSize_E' }],
  [0x11, { e: 'E2A0_11_OSDSettingTimeOut_E' }],
  [0x12, { e: 'E2A0_12_USB_C_Setting_E' }],
  [0x14, { e: 'E2A0_14_USB_Upstream_E' }],
  [0x15, { e: 'E2A0_15_KVM_E' }],
  [0x18, { e: 'E2A0_18_LocalDimming_E' }],
  [0x19, { e: 'E2A0_19_AmbiglowLightMode_E' }],
  [0x1a, { e: 'E2A0_1A_AmbiglowColors_E' }],
  [0x1b, { e: 'E2A0_1B_AmbiglowLightPosition_E' }],
  [0x1c, { e: 'E2A0_1C_AmbiglowLightBrightness_E' }],
  [0x1d, { e: 'E2A0_1D_AmbiglowLightSpeed_E' }],
  [0x1e, { e: 'E2A0_1E_AmbiglowLightDirection_E' }],
  [0x1f, { e: 'E2A0_1F_HDMIRefreshRate_E' }],
  [0x20, { e: 'E2A0_20_ColorSpace_E' }],
  [0x21, { e: 'E2A021_DPOutMultiStream_E' }],
  [0x22, { e: 'E2A0_22_ErgoSensor_E' }],
  [0x25, { e: 'E2A0_25_SharpShooterLocation_E' }],
  [0x30, { e: 'E2A0_SettingUser_E' }],
  [0x31, { e: 'E2A0_SettingUser_E' }],
  [0x09, { e: 'Num_0_E' }],
  [0x33, { e: 'Num_0_E' }],
  [0x34, { e: 'E2A0_34_PixelOrbiting_E' }],
  [0x35, { e: 'E2A0_35_ScreenSaver_E' }],
  [0x3a, { e: 'E2A0_HDMIRefreshRate_E' }],
  [0x3b, { e: 'E2A0_HDMIRefreshRate_E' }],
  [0x3c, { e: 'E2A0_HDMIRefreshRate_E' }],
  [0x41, { e: 'E2A0_41_FanControl_E' }],
  [0x10, { e: 'Num_Off_E' }],
  [0x48, { e: 'Num_Off_E' }],
  [0x49, { e: 'Num_Off_E' }],
  [0x4a, { e: 'Num_Off_E' }],
  [0x59, { e: 'E2A0_59_DualResolution_E', capsOrder: true }],
  ...SWITCH_FLAG_EXT.map((sub): [number, { e: EnumName }] => [sub, { e: 'SwitchFlag_E' }]),
  [0x24, { e: 'Level_Off_E' }],
  [0x44, { e: 'Level_Off_E' }],
  [0x45, { e: 'Level_Off_E' }],
  [0x68, { e: 'Level_Off_E' }],
  [0x6b, { e: 'E2A0_6B_Profile_E', capsOrder: true }],
]);

/** VCP_DC_SmartImage: the last DC caps byte selects the SDR table (DataOSD.cs:197-211). */
const DC_TABLES: ReadonlyMap<number, EnumName> = new Map<number, EnumName>([
  [0xe1, 'SmartImage_E1'],
  [0xe2, 'SmartImage_E2'],
  [0xe3, 'SmartImage_E3'],
  [0xe4, 'SmartImage_E4'],
]);

/** smethod_3: sorted GetDatas filtered to the caps bytes, compared as (byte)Value. */
export function capsFilter(e: EnumName, caps: readonly number[]): EnumItem[] {
  return getDatas(e).filter((x) => caps.includes(x.Value & 0xff));
}

/** smethod_4: capability order, bytes without a member skipped. */
export function capsOrder(e: EnumName, caps: readonly number[]): EnumItem[] {
  const datas = getDatas(e);
  const out: EnumItem[] = [];
  for (const b of caps) {
    const item = datas.find((x) => x.Value === b);
    if (item) out.push({ ...item });
  }
  return out;
}

/** The global ValueList of one code (null when no rule applies or the sub-list is empty). */
export function globalValueList(code: number, caps: readonly number[]): EnumItem[] | null {
  if (caps.length === 0) return null;
  if (code === 0xdc) {
    const table = DC_TABLES.get(caps[caps.length - 1]);
    return [...(table ? capsFilter(table, caps) : []), ...capsFilter('SmartImageHDR_E', caps)];
  }
  if (code < 0x100) {
    const e = STANDARD_RULES.get(code);
    return e ? capsFilter(e, caps) : null;
  }
  if ((code & 0xffff00) === 0xe2a000) {
    const rule = EXTERN_RULES.get(code & 0xff);
    if (!rule) return null;
    return rule.capsOrder ? capsOrder(rule.e, caps) : capsFilter(rule.e, caps);
  }
  return null;
}

/**
 * DataOSD.InitDisplayInfo (DataOSD.cs:92-138): the SupportOSDList for a parsed capability map
 * (ddc/capabilities.ts analyseVcpString, which reproduces ComUtil.AnalyseVcpString).
 */
export function buildSupportOsdList(caps: ReadonlyMap<number, readonly number[]>, log?: Logger): AttributeInfo[] {
  const list: AttributeInfo[] = [];
  const unhandled: number[] = [];
  for (const [code, sub] of caps) {
    if (isBoundStandardCode(code) || isBoundExternCode(code)) {
      const a = AttributeInfo.of(code);
      if (sub.length > 0) a.ValueList = globalValueList(code, sub);
      list.push(a);
    } else {
      unhandled.push(code);
    }
  }
  if (unhandled.length > 0) log?.debug(`UnHandle vcpCode = ${unhandled.join(', ')}`);
  return list;
}

/**
 * DataOSD.GetAttributeInfo(name): the SupportOSDList entry, or a new unavailable AttributeInfo
 * (err_code 9, "Current Display Not Found VCPCode") for names the monitor does not advertise.
 */
export function supportedAttribute(list: readonly AttributeInfo[], opName: string, supported = true): AttributeInfo {
  if (supported) {
    const found = list.find((a) => a.VCPOpCodeName === opName);
    if (found) return found;
  }
  const reason = supported ? 'Current Display Not Found VCPCode' : 'Current Display IsSupportDDCCICommand is false';
  const code = isStandardName(opName) || isExternName(opName) ? opcodeOf(opName) : undefined;
  const a = code !== undefined ? AttributeInfo.of(code) : Object.assign(new AttributeInfo(), { VCPOpCodeName: opName });
  return a.setErrMsg(reason);
}

/** VCP_F7_PIPPBPType value → A5 table (DataOSD.smethod_5, DataOSD.cs:419-431). */
const A5_TABLES: ReadonlyMap<number, EnumName> = new Map<number, EnumName>([
  [0x40, 'VCP_A5_PIPPBPType_40_E'],
  [0x42, 'VCP_A5_PIPPBPType_42_E'],
  [0x43, 'VCP_A5_PIPPBPType_43_E'],
  [0x44, 'VCP_A5_PIPPBPType_44_E'],
  [0x02, 'VCP_A5_PIPPBPType_02_E'],
  [0x03, 'VCP_A5_PIPPBPType_03_E'],
  [0x04, 'VCP_A5_PIPPBPType_04_E'],
]);

/** DataOSD.PIPPBPEnable: the A5 table chosen by F7.ValueList[0], or null when F7 has none or it is empty. */
export function pipPbpTable(list: readonly AttributeInfo[]): EnumItem[] | null {
  const f7 = list.find((a) => a.VCPOpCode === 0xf7);
  if (!f7 || !f7.ValueList || f7.ValueList.length === 0) return null;
  const table = A5_TABLES.get(f7.ValueList[0].Value);
  const items = table ? getDatas(table) : [];
  return items.length > 0 ? items : null;
}

/** DataOSD.GetResetSmartImageValue (DataOSD.cs:433-472): SmartImage value → E2A042 reset code, 0 if unknown. */
export function resetSmartImageValue(v: number): number {
  const map: Record<number, number> = {
    31: 56, 33: 59, 34: 48, 35: 61, 36: 62, 0: 48, 1: 49, 3: 52, 4: 57, 5: 58, 6: 50, 7: 51, 8: 55, 11: 53, 14: 54,
    17: 63, 81: 64, 51: 65, 50: 61,
  };
  return map[v] ?? 0;
}
