// Zeasn.PCenter.Entity.Lib.AttributeInfo (ENT/AttributeInfo.cs:8-237): one VCP control of the monitor.
//
// Serialized members in C# declaration order (20-enum-valuelist-catalog §1.5):
//   VCPOpCode, VCPOpCodeName*, Value, MinValue*, MaxValue*, StepValue*, ValueList*, err_code
//   (* = [JsonIgnoreEx(IgnoreProfile)]: present in hub replies, absent from ProfileContent)
// VCPOpCodeDesc, IsAvailable and err_msg are [JsonIgnore]. MinValue stays 0 and StepValue 1 — nothing in
// the vendor assigns them (20-enum §4.2). `Value` is `object` in C#: null until read, then an int.

import type { SerializeMode } from '../../types.ts';
import { type CSharpSerializable, toCSharpJson } from '../../core/json.ts';
import { type EnumItem, cloneEnumItem, enumItem, opcodeName } from './enum-items.ts';
import { type JsonObject, isJsonObject, member, toInt, toStr } from './json-populate.ts';

export class AttributeInfo implements CSharpSerializable {
  VCPOpCode = 0;
  VCPOpCodeName: string | null = null;
  Value: number | null = null;
  MinValue = 0;
  MaxValue = 0;
  StepValue = 1;
  ValueList: EnumItem[] | null = null;
  err_code = 0;
  /** [JsonIgnore]; also dropped by ToCloning. */
  err_msg = '';

  /** `new AttributeInfo(StandardVCPOpCode_E|E2A0_ExternVCPOpCode_E code)`: VCPOpCode + member name. */
  static of(code: number): AttributeInfo {
    const a = new AttributeInfo();
    a.VCPOpCode = code;
    a.VCPOpCodeName = opcodeName(code) ?? null;
    if (a.VCPOpCodeName === null) throw new Error(`0x${code.toString(16)} is not a VCP opcode of the catalog`);
    return a;
  }

  /** AttributeInfo.IsAvailable => err_code == 0. */
  get IsAvailable(): boolean {
    return this.err_code === 0;
  }

  /** SetErrMsg: err_code 9 + message. */
  setErrMsg(msg: string): this {
    this.err_code = 9;
    this.err_msg = msg;
    return this;
  }

  /** ResetErrMsg: err_code 0, message "". */
  resetErrMsg(): this {
    this.err_code = 0;
    this.err_msg = '';
    return this;
  }

  /** ToCloning(): JSON round trip (ValueList copied, err_msg dropped). */
  clone(): AttributeInfo {
    return new AttributeInfo().populate(this.toJson('ui'));
  }

  /** Newtonsoft populate of an existing instance (json-populate.ts rules). */
  populate(json: unknown): this {
    if (!isJsonObject(json)) return this;
    const code = toInt(member(json, 'VCPOpCode'));
    if (code !== undefined) this.VCPOpCode = code;
    const name = toStr(member(json, 'VCPOpCodeName'));
    if (name !== undefined) this.VCPOpCodeName = name;
    const value = member(json, 'Value');
    if (value !== undefined) this.Value = toInt(value) ?? null;
    const min = toInt(member(json, 'MinValue'));
    if (min !== undefined) this.MinValue = min;
    const max = toInt(member(json, 'MaxValue'));
    if (max !== undefined) this.MaxValue = max;
    const step = toInt(member(json, 'StepValue'));
    if (step !== undefined) this.StepValue = step;
    const list = member(json, 'ValueList');
    if (Array.isArray(list)) this.ValueList = list.filter(isJsonObject).map(parseEnumItem);
    const err = toInt(member(json, 'err_code'));
    if (err !== undefined) this.err_code = err;
    return this;
  }

  toJson(mode: SerializeMode): JsonObject {
    if (mode === 'profile') return { VCPOpCode: this.VCPOpCode, Value: this.Value, err_code: this.err_code };
    return {
      VCPOpCode: this.VCPOpCode,
      VCPOpCodeName: this.VCPOpCodeName,
      Value: this.Value,
      MinValue: this.MinValue,
      MaxValue: this.MaxValue,
      StepValue: this.StepValue,
      ValueList: this.ValueList ? this.ValueList.map(cloneEnumItem) : null,
      err_code: this.err_code,
    };
  }

  [toCSharpJson](mode: SerializeMode): unknown {
    return this.toJson(mode);
  }
}

/** EnumItem from JSON (Name/Text may be missing → null; Value defaults to 0). */
export function parseEnumItem(json: JsonObject): EnumItem {
  return enumItem(toStr(member(json, 'Name')) ?? null, toStr(member(json, 'Text')) ?? null, toInt(member(json, 'Value')) ?? 0);
}

/** Populate an EnumItem in place (Newtonsoft keeps the existing instance and its initializer values). */
export function populateEnumItem(target: EnumItem, json: unknown): EnumItem {
  if (!isJsonObject(json)) return target;
  const name = toStr(member(json, 'Name'));
  if (name !== undefined) target.Name = name;
  const text = toStr(member(json, 'Text'));
  if (text !== undefined) target.Text = text;
  const value = toInt(member(json, 'Value'));
  if (value !== undefined) target.Value = value;
  return target;
}
