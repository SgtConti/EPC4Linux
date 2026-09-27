// The ambiglow service without an ENE controller (the user's 2026-09-26 state): the DDC E2A0 path for
// Effect_Enable / Effect_Reset, the vendor replies of the ENE-only functions, the golden startup replies
// (steps 6 and 7) and the no-device answers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serialize } from '../../../src/backend/core/json.ts';
import { MOCK_34M2C8600 } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { getFrame, setFrame, specWith } from '../monitor/helpers.ts';
import { rig } from './helpers.ts';

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

test('golden steps 6 and 7 through the dispatcher: SyncEffect_GetData and Effect_GetColorData replies byte for byte', async () => {
  const r = await rig({ ene: false });
  try {
    const step6 = await r.call('SyncEffect_GetData');
    assert.equal(
      step6.raw,
      '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"r1","Tag":{"EffectDetailInfo":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":2,"Brightness":2,"IsRandomColor":false,"IsRainbowColor":false,"CurRGB":{"R":255,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"SyncDevices":[]},"FunctionName":"SyncEffect_GetData","CurrItem":null}',
    );
    const step7 = await r.call('Effect_GetColorData');
    assert.equal(
      step7.raw,
      '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"r2","Tag":{"DefColors":[{"R":255,"G":255,"B":255},{"R":255,"G":0,"B":0},{"R":255,"G":0,"B":127},{"R":127,"G":0,"B":127},{"R":127,"G":0,"B":255},{"R":0,"G":0,"B":255},{"R":0,"G":127,"B":255},{"R":0,"G":255,"B":255},{"R":0,"G":255,"B":127},{"R":0,"G":255,"B":0},{"R":127,"G":255,"B":0},{"R":255,"G":255,"B":0},{"R":255,"G":127,"B":0}],"SelfColors":""},"FunctionName":"Effect_GetColorData","CurrItem":null}',
    );
    const saved = await r.call('Effect_SetSelfColors', ['#ff0000,#00ff00']);
    assert.equal(saved.Tag.SelfColors, '#ff0000,#00ff00');
    assert.equal((await r.call('Effect_GetColorData')).Tag.SelfColors, '#ff0000,#00ff00');
  } finally {
    await r.cleanup();
  }
});

test('the static functions: Dynamic Lighting -1 / null, AmbiScape no-op', async () => {
  const r = await rig({ ene: false });
  try {
    const dl = await r.call('Effect_CheckDynamicLightingEnabled');
    assert.deepEqual([dl.err_code, dl.Tag], [0, -1]);
    const open = await r.call('Effect_OpenDynamicLightingSetting');
    assert.deepEqual([open.err_code, open.err_msg, open.Tag], [0, '', null]);
    const bulbs = await r.call('AmbiScape_EnableFollowVideo', [false, 0]);
    assert.deepEqual([bulbs.err_code, bulbs.Tag], [0, null]);
    assert.equal(r.capture.videoStops, 0, 'the display capture is not touched (vendor: EnableFollowVideoTimer(false))');
    const wrong = await r.call('AmbiScape_EnableFollowVideo', [true]);
    assert.equal(wrong.err_msg, 'params error: Zeasn.Com.Lib.JsonResult AmbiScape_EnableFollowVideo(Boolean, Int32)');
  } finally {
    await r.cleanup();
  }
});

test('load without ENE: nothing is written by the service; ENE-only functions answer "Not Support ENE"', async () => {
  const r = await rig({ ene: false });
  try {
    assert.equal(r.display.profile()!.ENEEffectEnable, false);
    assert.equal(r.display.profile()!.EffectInfo?.CurrEffect.Name, 'FollowVideo', 'stored EffectInfo copied (golden step 12)');
    assert.equal(r.service.followVideo.state, 'stopped', 'no capture: the monitor does FollowVideo itself over DDC');
    for (const [fn, args] of [
      ['Effect_Change', [1]],
      ['Effect_RandomEnable', [true]],
      ['Effect_RainbowEnable', [true]],
      ['Effect_ColorChange', [1, 2, 3]],
      ['Effect_BgColorChange', [1, 2, 3]],
      ['Effect_SpeedChange', [1]],
      ['Effect_BrightnessChange', [1]],
      ['Effect_DirectionChange', [1]],
      ['Effect_RegionChange', [1]],
    ] as const) {
      const reply = await r.call(fn, [100000, ...args]);
      assert.deepEqual([reply.err_code, reply.err_msg, reply.Tag], [9, 'Not Support ENE', null], fn);
    }
    const leds = await r.call('Effect_GetLEDs', [100000]);
    assert.deepEqual([leds.err_code, leds.err_msg], [9, 'not ene follow video or audio']);
    const menu = await r.call('Effect_GetMenu', [100000]);
    assert.equal(sha256(serialize(menu.Tag, 'ui')), 'cd09882c69487c4bc4c2c08251d34db1119beb152a6be887c1aa63609306a236', '20-enum §6.2');
    const sync = await r.call('SyncEffect_EnableDevice', [100000, '[]']);
    assert.deepEqual([sync.err_code, sync.err_msg], [9, 'Input device=100000 EffectDetail is null'], '20-backend-host-tail §3 row 97');
  } finally {
    await r.cleanup();
  }
});

test('Effect_Enable over DDC: E2A019 = stored mode / AmbiglowOff, ModuleAmbiglow.EffectEnable saved, Tag = flag', async () => {
  const r = await rig({ ene: false });
  try {
    let m = r.ddcMark();
    let reply = await r.call('Effect_Enable', [100000, true]);
    assert.deepEqual([reply.err_code, reply.Tag], [0, true]);
    assert.deepEqual(r.ddcSince(m), [setFrame(0xe2a019, 7)], 'Off was shown as StaticMode, so enabling turns Static on');
    assert.equal(r.display.profile()!.ModuleAmbiglow.EffectEnable, true);
    assert.match(r.themes.contents.get('100000|PHL 34M2C8600')!, /"EffectEnable":true\},"ModuleInput"/);
    m = r.ddcMark();
    reply = await r.call('Effect_Enable', [100000, false]);
    assert.deepEqual([reply.err_code, reply.Tag], [0, false]);
    assert.deepEqual(r.ddcSince(m), [setFrame(0xe2a019, 0)]);
    assert.equal(r.display.profile()!.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value, 7, 'the stored mode is kept');
  } finally {
    await r.cleanup();
  }
});

test('Effect_Enable without E2A019 in the capabilities: "NotSupport"', async () => {
  const capabilities = MOCK_34M2C8600.capabilities.replace('E2A019(00 01 02 03 04 05 06 07) ', '');
  assert.notEqual(capabilities, MOCK_34M2C8600.capabilities);
  const r = await rig({ ene: false, cachedCaps: false, spec: { ...MOCK_34M2C8600, capabilities } });
  try {
    const reply = await r.call('Effect_Enable', [100000, true]);
    assert.deepEqual([reply.err_code, reply.err_msg], [9, 'NotSupport']);
  } finally {
    await r.cleanup();
  }
});

test('Effect_Reset over DDC: notification, E2A038 = 1, 200 ms, re-read of the advertised codes; Tag ModuleAmbiglow', async () => {
  const r = await rig({ ene: false });
  try {
    await r.call('Effect_Enable', [100000, true]); // monitor now in Static (7); its reset seed is Off (0)
    const m = r.ddcMark();
    const sleeps = r.clock.sleeps.length;
    const before = r.notifier.sent.length;
    const reply = await r.call('Effect_Reset', [100000]);
    assert.equal(reply.err_code, 0);
    assert.equal(r.notifier.sent[before].name, 'NotifyEffectSyncDevicesChange');
    assert.equal(r.notifier.sent[before].json, '{"EffectDetailInfo":null,"SyncDevices":[]}');
    assert.deepEqual(r.ddcSince(m), [
      setFrame(0xe2a038, 1),
      getFrame(0xe2a019),
      getFrame(0xe2a01a),
      getFrame(0xe2a01b),
      getFrame(0xe2a01c),
      getFrame(0xe2a01d),
    ], 'E2A01E is not advertised: no read, err_code 9 kept');
    assert.deepEqual(r.clock.sleeps.slice(sleeps), [200]);
    assert.deepEqual(Object.keys(reply.Tag), [
      'EXT_OP_E2A0_19_AmbiglowLightMode',
      'EXT_OP_E2A0_1A_AmbiglowColors',
      'EXT_OP_E2A0_1B_AmbiglowLightPosition',
      'EXT_OP_E2A0_1C_AmbiglowLightBrightness',
      'EXT_OP_E2A0_1D_AmbiglowLightSpeed',
      'EXT_OP_E2A0_1E_AmbiglowLightDirection',
      'EffectEnable',
    ]);
    assert.equal(reply.Tag.EffectEnable, false, 'the reset left the Ambiglow off');
    assert.equal(reply.Tag.EXT_OP_E2A0_19_AmbiglowLightMode.Value, 7, 'Off shown as StaticMode');
    assert.equal(reply.Tag.EXT_OP_E2A0_1E_AmbiglowLightDirection.err_code, 9);
    assert.equal(r.display.profile()!.ModuleAmbiglow.EffectEnable, false);
  } finally {
    await r.cleanup();
  }
});

test('Effect_Reset over DDC keeps a mode other than Off as read (deviation: the vendor always shows Static)', async () => {
  const r = await rig({ ene: false, spec: specWith([[0xe2a019, 3, 7]]) });
  try {
    await r.display.ddc.setExt(0x19, 5); // the user picked ColorBreathing on the OSD
    const reply = await r.call('Effect_Reset', [100000]);
    assert.equal(reply.Tag.EXT_OP_E2A0_19_AmbiglowLightMode.Value, 3, 'the reset restored ColorShift');
    assert.equal(reply.Tag.EffectEnable, true);
  } finally {
    await r.cleanup();
  }
});

test('no-device replies: another DeviceType, or no connected display → "functionName: X  return null obj"', async () => {
  const r = await rig({ ene: false, load: false });
  try {
    for (const [fn, args] of [
      ['Effect_GetMenu', []],
      ['Effect_GetLEDs', []],
      ['Effect_Enable', [true]],
      ['Effect_Change', [1]],
      ['Effect_Reset', []],
      ['Effect_ColorChange', [1, 2, 3]],
    ] as const) {
      for (const device of [100000, 200000]) {
        const reply = await r.call(fn, [device, ...args]);
        assert.deepEqual([reply.err_code, reply.err_msg], [9, `functionName: ${fn}  return null obj`], `${fn}(${device}) before connect`);
      }
    }
    await r.display.connect();
    await r.display.ready();
    const other = await r.call('Effect_Enable', [300000, true]);
    assert.equal(other.err_msg, 'functionName: Effect_Enable  return null obj');
    const sync = await r.call('SyncEffect_EnableDevice', [200000, '[]']);
    assert.equal(sync.err_msg, 'device=RongYuan_KeyboardSPK8708 un connected');
    const ok = await r.call('Effect_Enable', [100000, false]);
    assert.equal(ok.err_code, 0);
  } finally {
    await r.cleanup();
  }
});
