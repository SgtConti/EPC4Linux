// Model serialization fixtures: the user's Default.pcenter round trip ('profile' mode), the computed
// Profile_GetDeviceData Tag of 20-enum-valuelist-catalog §5 ('uiProfileGet' mode) for the simulated
// 34M2C8600, and the entity defaults of 20-enum §6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serialize } from '../../../src/backend/core/json.ts';
import { serializeResult, succ } from '../../../src/backend/core/envelope.ts';
import { T_PHLDisplay_Profile } from '../../../src/backend/monitor/model/profile.ts';
import { DisplayEffectInfo } from '../../../src/backend/monitor/model/effect.ts';
import { DisplayFuncConstraints } from '../../../src/backend/monitor/model/constraints.ts';
import { AttributeInfo } from '../../../src/backend/monitor/model/attribute-info.ts';
import { defaultProfileContent, expectedDeviceDataTag, loadedDisplay } from './helpers.ts';

test('Default.pcenter ProfileContent round-trips byte for byte in profile mode', () => {
  const content = defaultProfileContent();
  assert.equal(Buffer.byteLength(content), 10812);
  const profile = T_PHLDisplay_Profile.parse(content);
  assert.ok(profile);
  assert.equal(profile.purify(), content);
  // 20-enum §0: sha256 of the stored ProfileContent.
  assert.equal(createHash('sha256').update(profile.purify()).digest('hex'), 'ccff11e5f491b2525557034706dd464a5f2bd26a3f1c48658984b0f2470c39af');
});

test('parsing keeps initializer names where the profile omits them (Newtonsoft populate)', () => {
  const profile = T_PHLDisplay_Profile.parse(defaultProfileContent());
  assert.ok(profile);
  assert.equal(profile.ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync.VCPOpCodeName, 'EXT_OP_E2A0_40_AdaptiveSync');
  assert.equal(profile.ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync.Value, 1);
  assert.equal(profile.ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync.ValueList, null);
  assert.equal(profile.ModuleSmartImageHDR.SubSmartImages.get(33)?.OP_10_Luminance.Value, 100);
  assert.equal(profile.ExtModel, null);
  assert.equal(profile.EffectInfo?.EffectDetail.Effect.Name, 'FollowVideo');
  // clone() is the vendor ToCloning (JSON round trip) and preserves everything that serializes.
  assert.equal(serialize(profile.clone(), 'ui'), serialize(profile, 'ui'));
});

test('invalid or empty ProfileContent parses to null (JsonDeserialize swallows errors)', () => {
  assert.equal(T_PHLDisplay_Profile.parse(''), null);
  assert.equal(T_PHLDisplay_Profile.parse(null), null);
  assert.equal(T_PHLDisplay_Profile.parse('{"broken"'), null);
  assert.equal(T_PHLDisplay_Profile.parse('[1,2]'), null);
});

test('the loaded simulated 34M2C8600 serializes to the 20-enum §5 Tag byte for byte (uiProfileGet)', async () => {
  const t = await loadedDisplay();
  try {
    const tag = serialize(t.display.profile(), 'uiProfileGet');
    const expected = expectedDeviceDataTag();
    assert.equal(tag, expected);
    assert.equal(Buffer.byteLength(tag), 29403);
    assert.equal(createHash('sha256').update(tag).digest('hex'), '91e8a59c09e6a94d2e67d0422ed35519be6c8111499da17187c368c460d45a45');
    // 'ui' is identical: no display member carries [JsonIgnoreEx(IgnoreUI)] (20-backend-host-tail §5 step 11).
    assert.equal(serialize(t.display.profile(), 'ui'), tag);
    // The envelope keeps the Tag verbatim.
    const reply = serializeResult({ ...succ(t.display.profile()), RequestId: 'b09910ba-8ed2-4ce9-b184-dc5f5ea0495b', FunctionName: 'Profile_GetDeviceData' }, 'uiProfileGet');
    assert.equal(reply, `{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"b09910ba-8ed2-4ce9-b184-dc5f5ea0495b","Tag":${expected},"FunctionName":"Profile_GetDeviceData","CurrItem":null}`);
  } finally {
    await t.cleanup();
  }
});

test('the profile projection of the loaded state equals the stored Default.pcenter content', async () => {
  const t = await loadedDisplay();
  try {
    assert.equal(t.display.purify(), defaultProfileContent());
    // The connect-time save wrote exactly that section (GClass3.DeviceDataCheck → SaveProfile).
    assert.equal(t.themes.contents.get('100000|PHL 34M2C8600'), defaultProfileContent());
  } finally {
    await t.cleanup();
  }
});

test('DisplayEffectInfo.Default and the fresh-install EffectInfo match 20-enum §6.3/§6.4', () => {
  const def = serialize(DisplayEffectInfo.default('34M2C8600'), 'ui');
  assert.equal(Buffer.byteLength(def), 1994);
  assert.equal(createHash('sha256').update(def).digest('hex'), '341006d3282ac2e6986a94ba8878498107baa0c0f0516f9fe11da3baa36f41e8');
  assert.equal(
    serialize(new DisplayEffectInfo(), 'ui'),
    '{"EffectList":null,"EffectDetail":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":2,"Brightness":2,"IsRandomColor":false,"IsRainbowColor":false,"CurRGB":{"R":255,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"EffectEnable":true,"CurrEffect":{"Name":null,"Text":null,"Value":0}}',
  );
  // In a ProfileContent (profile mode) the nulls disappear (20-theme §4 step 5).
  assert.equal(
    serialize(new DisplayEffectInfo(), 'profile'),
    '{"EffectDetail":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":2,"Brightness":2,"IsRandomColor":false,"IsRainbowColor":false,"CurRGB":{"R":255,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"EffectEnable":true,"CurrEffect":{"Value":0}}',
  );
  // EffectDetail is the list entry itself, so detail setters change the list.
  const info = DisplayEffectInfo.default('34M2C8600');
  info.EffectDetail.Speed = 3;
  assert.equal(info.EffectList?.find((d) => d.Effect.Name === 'Static')?.Speed, 3);
});

test('AttributeInfo serializes per mode (20-enum §1.5)', () => {
  const a = AttributeInfo.of(0xe2a040);
  a.Value = 1;
  a.MaxValue = 1;
  a.ValueList = [{ Name: 'OFF', Text: 'Off', Value: 0 }];
  assert.equal(serialize(a, 'ui'), '{"VCPOpCode":14852160,"VCPOpCodeName":"EXT_OP_E2A0_40_AdaptiveSync","Value":1,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0}],"err_code":0}');
  assert.equal(serialize(a, 'profile'), '{"VCPOpCode":14852160,"Value":1,"err_code":0}');
  const unread = AttributeInfo.of(0x10);
  assert.equal(serialize(unread, 'profile'), '{"VCPOpCode":16,"err_code":0}');
  assert.equal(serialize(unread, 'ui'), '{"VCPOpCode":16,"VCPOpCodeName":"OP_10_Luminance","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0}');
});

test('a fresh DisplayFuncConstraints is the all-1 constructor state in constructor order', () => {
  const json = serialize(new DisplayFuncConstraints(), 'ui');
  const parsed = JSON.parse(json) as { FuncItems: Array<{ FuncId: number; FuncName: string; State: number }> };
  assert.equal(parsed.FuncItems.length, 26);
  assert.ok(parsed.FuncItems.every((x) => x.State === 1));
  assert.deepEqual(parsed.FuncItems.slice(0, 3).map((x) => x.FuncName), ['OP_10_Luminance', 'OP_12_Contrast', 'OP_F0_SmartContrast']);
  assert.ok(json.endsWith('"ModuleGameMode":1,"AudioEQ":1}'));
});
