// DataOSD ValueList rules (20-enum-valuelist-catalog §1-§4) on the user's real capability string, and
// the enum tables against the catalog they were generated from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyseVcpString } from '../../../src/backend/ddc/capabilities.ts';
import { ENUMS } from '../../../src/backend/monitor/model/enums.ts';
import { getDatas, getItem, isBoundExternCode, isBoundStandardCode } from '../../../src/backend/monitor/model/enum-items.ts';
import { buildSupportOsdList, capsOrder, globalValueList, pipPbpTable, resetSmartImageValue, supportedAttribute } from '../../../src/backend/monitor/model/value-lists.ts';
import { realCapabilities } from './helpers.ts';

const names = (list: ReadonlyArray<{ Name: string | null }> | null) => (list ? list.map((x) => x.Name) : null);

test('enums.ts equals every enum block of the catalog (§2), member for member', () => {
  const md = readFileSync(new URL('../../../../docs/re/20-enum-valuelist-catalog.md', import.meta.url), 'utf8');
  const blocks = [...md.matchAll(/```json\n(\{"enum":[\s\S]*?\]\})\n```/g)].map((m) => JSON.parse(m[1]) as { enum: string; members: Array<{ Name: string; Text: string; Value: number; Unbind: boolean }> });
  assert.equal(blocks.length, 76);
  assert.deepEqual(Object.keys(ENUMS), blocks.map((b) => b.enum));
  for (const b of blocks) {
    assert.deepEqual(ENUMS[b.enum as keyof typeof ENUMS].map((m) => ({ ...m })), b.members, b.enum);
  }
});

test('GetDatas skips Unbind members and sorts by value; GetItem includes them (§1.1)', () => {
  assert.deepEqual(getDatas('E2A0_19_AmbiglowLightMode_E').slice(0, 2).map((x) => x.Name), ['FollowVideo', 'FollowAudio']);
  assert.equal(getItem('E2A0_19_AmbiglowLightMode_E', 'AmbiglowOff').Value, 0);
  assert.deepEqual(getItem('EffectType', 'FollowVideo'), { Name: 'FollowVideo', Text: '光影同步', Value: 1 });
  // 32 bound standard codes and 89 bound E2A0 codes (DataOSD.cs:15-17).
  assert.equal(getDatas('StandardVCPOpCode_E').length, 32);
  assert.equal(getDatas('E2A0_ExternVCPOpCode_E').length, 89);
  assert.ok(isBoundStandardCode(0xdc) && !isBoundStandardCode(0xc9));
  assert.ok(isBoundExternCode(0xe2a040) && !isBoundExternCode(0xe2a000 + 0xff));
});

test('the user capability string gives 65 handled codes, 45 with a ValueList (§4, LOG26 parse dump)', () => {
  const caps = analyseVcpString(realCapabilities());
  assert.ok(caps);
  assert.equal(caps.size, 85);
  const list = buildSupportOsdList(caps);
  assert.equal(list.length, 65);
  assert.equal(list.filter((a) => a.ValueList !== null).length, 45);
  const unhandled = [...caps.keys()].filter((c) => !list.some((a) => a.VCPOpCode === c));
  assert.deepEqual(unhandled.map((c) => c.toString(16).toUpperCase().padStart(2, '0')), [
    '02', '05', '08', '0B', '0C', '52', '6C', '6E', '70', 'AC', 'AE', 'B2', 'B6', 'C0', 'C6', 'C8', 'CA', 'DF', 'FD', 'FF',
  ]);
  // Bound codes without a sub-list or without a case keep ValueList null (§1.2).
  for (const code of [0x10, 0x12, 0x16, 0x18, 0x1a, 0x62, 0x87, 0xa4, 0xa5, 0xf6, 0xe2a00a, 0xe2a038, 0xe2a039, 0xe2a042]) {
    assert.equal(list.find((a) => a.VCPOpCode === code)?.ValueList, null, code.toString(16));
  }
  // Every global attribute starts available, with the catalog name.
  assert.ok(list.every((a) => a.err_code === 0 && a.VCPOpCodeName !== null));
});

test('ValueLists of the user monitor match 20-enum §4.2 (names in order)', () => {
  const list = buildSupportOsdList(analyseVcpString(realCapabilities())!);
  const vl = (code: number) => names(list.find((a) => a.VCPOpCode === code)?.ValueList ?? null);
  assert.deepEqual(vl(0xdc), [
    'SmartImage_Standard', 'SmartImage_FPS', 'SmartImage_Movie', 'SmartImage_Game1', 'SmartImage_Game2', 'SmartImage_Racing',
    'SmartImage_RTS', 'SmartImage_Economy', 'SmartImage_LowBlueMode', 'SmartImage_EasyRead', 'SmartImage_ConsoleMode',
    'SmartImage_IllustratorMode', 'HDROff', 'HDRGame', 'HDRMovie', 'HDRPhoto', 'HDRPersonal', 'HDRTrueBlack', 'HDRPeak',
  ]);
  assert.deepEqual(vl(0x60), [
    'Normal_DisplayPort1', 'Normal_DigitalHDMI1', 'Normal_DigitalHDMI2', 'Normal_USBC1', 'PIPPBP_DigitalHDMI1', 'PIPPBP_DigitalHDMI2',
    'PIPPBP_DisplayPort1', 'PIPPBP_USBC1',
  ]);
  assert.deepEqual(vl(0x86), [
    'Scaling_NoScaling', 'Scaling_19', 'Scaling_19_W', 'Scaling_22_W', 'Scaling_18_5_W', 'Scaling_19_5_W', 'Scaling_20_W', 'Scaling_21_5_W',
    'Scaling_23_W', 'Scaling_24_W', 'Scaling_27_W', 'Scaling_Aspect_4to3',
  ]);
  assert.deepEqual(vl(0x54), ['ON', 'OFF']);
  assert.deepEqual(vl(0xda), ['OFF', 'ON']);
  assert.deepEqual(vl(0xe2a019), ['FollowVideo', 'FollowAudio', 'ColorShift', 'ColorWave', 'ColorBreathing', 'StarryNight', 'StaticMode']);
  assert.deepEqual(vl(0xe2a001), ['EQ_100', 'EQ_300', 'EQ_1000', 'EQ_3000', 'EQ_10000']);
  assert.deepEqual(vl(0xe2a006), ['OFF', 'Num_1_0', 'Num_1_5', 'Num_2_0']);
  assert.deepEqual(vl(0xf7), ['PIP_2_PBP_2']);
  assert.deepEqual(names(pipPbpTable(list)), ['PIPPBP__OFF', 'PIPPBP__PIP', 'PIPPBP__PBP_1']);
});

test('DC table selection by the last caps byte, HDR appended (§1.3)', () => {
  assert.deepEqual(names(globalValueList(0xdc, [0x00, 0x01, 0x21, 0xe1])), ['SmartImage_Standard', 'SmartImage_Office', 'HDRGame']);
  const e2 = names(globalValueList(0xdc, [0x00, 0x10, 0x21, 0xe2]));
  assert.deepEqual(e2, ['SmartImage_Standard', 'SmartImage_Off', 'HDRGame']);
  // Last byte not E1..E4: the HDR part alone.
  assert.deepEqual(names(globalValueList(0xdc, [0x00, 0x21])), ['HDRGame']);
  assert.equal(globalValueList(0xdc, []), null);
});

test('smethod_4 keeps capability order for DualResolution, Profile and GamePQ (§1.3)', () => {
  // 0x10 WFHD240Hz, 0x00 UHD120Hz, 0x09 WUHD120Hz: capability order, not value order.
  assert.deepEqual(names(globalValueList(0xe2a059, [0x10, 0x00, 0x09])), ['WFHD240Hz', 'UHD120Hz', 'WUHD120Hz']);
  assert.deepEqual(names(globalValueList(0xe2a059, [0x09, 0x10])), ['WUHD120Hz', 'WFHD240Hz']);
  // smethod_3 sorts: the same bytes for a sorted enum come out by value.
  assert.deepEqual(names(globalValueList(0xe2a01c, [0x02, 0x00])), ['Bright', 'Brightest']);
  // Bytes without a member are skipped.
  assert.deepEqual(capsOrder('E2A0_6B_Profile_E', [0xfe]), []);
});

test('GetAttributeInfo for an unadvertised code is a fresh unavailable attribute; reset codes (DataOSD)', () => {
  const list = buildSupportOsdList(analyseVcpString(realCapabilities())!);
  const missing = supportedAttribute(list, 'EXT_OP_E2A0_02_MBR');
  assert.equal(missing.err_code, 9);
  assert.equal(missing.VCPOpCode, 0xe2a002);
  assert.equal(supportedAttribute(list, 'OP_DC_DisplayApplication', false).err_code, 9);
  assert.equal(supportedAttribute(list, 'OP_DC_DisplayApplication'), list.find((a) => a.VCPOpCode === 0xdc));
  assert.equal(resetSmartImageValue(33), 59);
  assert.equal(resetSmartImageValue(0), 48);
  assert.equal(resetSmartImageValue(51), 65);
  assert.equal(resetSmartImageValue(2), 0);
});
