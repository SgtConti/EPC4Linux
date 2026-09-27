// EnumItem and the Extension_Enum helpers over the frozen catalog in enums.ts.
//
// Vendor: Zeasn.Com.Lib/EnumItem.cs (serialized {"Name","Text","Value"} in that order) and
// Extension_Enum.cs:26-34 (GetItem: any member, Unbind included) / :108-148 (GetDatas: members without
// [UnbindEnumExtended], sorted by Value) — 20-enum-valuelist-catalog §1.1.
//
// GetDatas returns fresh objects on every call, like the vendor (each call builds new EnumItems), so a
// caller that mutates a list (DualResolution trimming, 06 §7.11) never affects another list.

import { ENUMS, type EnumMember, type EnumName } from './enums.ts';

/** Zeasn.Com.Lib.EnumItem. `Name`/`Text` are null only for `new EnumItem()` (e.g. a fresh CurrEffect). */
export interface EnumItem {
  Name: string | null;
  Text: string | null;
  Value: number;
}

/** Build an EnumItem with the C# member order Name, Text, Value (12 §2.4). */
export function enumItem(Name: string | null, Text: string | null, Value: number): EnumItem {
  return { Name, Text, Value };
}

/** `new EnumItem()`: Name/Text null, Value 0 (BaseEffectInfo.CurrEffect default). */
export function emptyEnumItem(): EnumItem {
  return enumItem(null, null, 0);
}

export function cloneEnumItem(e: EnumItem): EnumItem {
  return enumItem(e.Name, e.Text, e.Value);
}

const sortedBound = new Map<EnumName, readonly EnumMember[]>();

function bound(name: EnumName): readonly EnumMember[] {
  let list = sortedBound.get(name);
  if (!list) {
    list = Object.freeze(ENUMS[name].filter((m) => !m.Unbind).sort((a, b) => a.Value - b.Value));
    sortedBound.set(name, list);
  }
  return list;
}

/** Extension_Enum.GetDatas(type): bound members as new EnumItems, sorted by Value. */
export function getDatas(name: EnumName): EnumItem[] {
  return bound(name).map((m) => enumItem(m.Name, m.Text, m.Value));
}

/** Extension_Enum.GetItem(e): Name, [Description] text (or the name), value — Unbind members included. */
export function getItem(name: EnumName, member: string): EnumItem {
  const m = ENUMS[name].find((x) => x.Name === member);
  if (!m) throw new Error(`${name}.${member} is not in the enum catalog`);
  return enumItem(m.Name, m.Text, m.Value);
}

/** Integer value of a member (C# `(int)Enum.Member` / GetHashCode()). */
export function enumValue(name: EnumName, member: string): number {
  return getItem(name, member).Value;
}

/** Member with the given value (any, Unbind included), or undefined. */
export function memberOf(name: EnumName, value: number): EnumMember | undefined {
  return ENUMS[name].find((m) => m.Value === value);
}

/** Whether `value` is a bound member of the enum (Enum.IsDefined restricted to GetDatas). */
export function isBoundValue(name: EnumName, value: number): boolean {
  return bound(name).some((m) => m.Value === value);
}

// ───────────────────────────── opcode names (DataOSD.StandardList / E2A0_ExternList) ─────────────────────────────

/** VCP code of an opcode member name ("OP_10_Luminance" → 0x10, "EXT_OP_E2A0_40_AdaptiveSync" → 0xE2A040). */
export function opcodeOf(opName: string): number | undefined {
  return (ENUMS.StandardVCPOpCode_E.find((m) => m.Name === opName) ?? ENUMS.E2A0_ExternVCPOpCode_E.find((m) => m.Name === opName))?.Value;
}

/** Extension_AttributeInfo.IsStandard: the name is a bound StandardVCPOpCode_E member. */
export function isStandardName(opName: string | null): boolean {
  return opName !== null && opName !== '' && bound('StandardVCPOpCode_E').some((m) => m.Name === opName);
}

/** Extension_AttributeInfo.IsExtern: the name is a bound E2A0_ExternVCPOpCode_E member. */
export function isExternName(opName: string | null): boolean {
  return opName !== null && opName !== '' && bound('E2A0_ExternVCPOpCode_E').some((m) => m.Name === opName);
}

/** DataOSD.StandardList membership by code (the 32 bound standard codes, DataOSD.cs:15). */
export function isBoundStandardCode(code: number): boolean {
  return bound('StandardVCPOpCode_E').some((m) => m.Value === code);
}

/** DataOSD.E2A0_ExternList membership by code (the 89 bound E2A0 codes, DataOSD.cs:17). */
export function isBoundExternCode(code: number): boolean {
  return bound('E2A0_ExternVCPOpCode_E').some((m) => m.Value === code);
}

/** Opcode member name of a code (standard codes < 0x100, TPV codes 0xE2A0xx). */
export function opcodeName(code: number): string | undefined {
  const table = code >= 0x100 ? ENUMS.E2A0_ExternVCPOpCode_E : ENUMS.StandardVCPOpCode_E;
  return table.find((m) => m.Value === code)?.Name;
}
