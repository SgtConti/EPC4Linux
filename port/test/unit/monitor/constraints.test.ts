// DisplayFuncConstraints for the user's monitor (20-backend-host-tail §2.6, 20-enum §6.5) and the rule
// table of 06 §8 with the ScanMode correction of 20-enum §8 item 1.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { serialize } from '../../../src/backend/core/json.ts';
import { serializeResult, result, SUCC } from '../../../src/backend/core/envelope.ts';
import { DisplayFuncConstraints, parseFrequency } from '../../../src/backend/monitor/model/constraints.ts';
import { NOTIFY_CONSTRAINTS } from '../../../src/backend/monitor/display.ts';
import type { T_PHLDisplay_Profile } from '../../../src/backend/monitor/model/profile.ts';
import { loadedDisplay, localFixture } from './helpers.ts';

const userConstraints = () => readFileSync(localFixture('constraints.user.json'), 'utf8').trim();
const n0 = () => readFileSync(localFixture('n0.notification.json'), 'utf8').trim();

function states(c: DisplayFuncConstraints): Record<string, number> {
  return Object.fromEntries(c.FuncItems.map((x) => [x.FuncName, x.State]));
}

test('the user state gives the 20-enum §6.5 constraints and N0 byte for byte (1925 chars)', async () => {
  const t = await loadedDisplay();
  try {
    assert.equal(serialize(t.display.constraints, 'ui'), userConstraints());
    const sent = t.notifier.named(NOTIFY_CONSTRAINTS);
    assert.equal(sent.length, 1);
    const envelope = serializeResult({ ...result(SUCC, null, sent[0].tag), FunctionName: NOTIFY_CONSTRAINTS });
    assert.equal(envelope, n0());
    assert.equal(envelope.length, 1925);
  } finally {
    await t.cleanup();
  }
});

test('a recheck without changes does not notify; a change does (RecheckFuncConstraints → Notify)', async () => {
  const t = await loadedDisplay();
  try {
    await t.display.setOsd('EXT_OP_E2A0_43_AutoWarning', 1);
    assert.equal(t.notifier.named(NOTIFY_CONSTRAINTS).length, 1);
    await t.display.setOsd('EXT_OP_E2A0_35_ScreenSaver', 0);
    assert.equal(t.notifier.named(NOTIFY_CONSTRAINTS).length, 2);
    assert.equal(t.display.constraints.state(0xf0), 1);
  } finally {
    await t.cleanup();
  }
});

async function withProfile(fn: (p: T_PHLDisplay_Profile, c: DisplayFuncConstraints) => void): Promise<void> {
  const t = await loadedDisplay();
  try {
    const p = t.display.profile()!.clone();
    fn(p, new DisplayFuncConstraints());
  } finally {
    await t.cleanup();
  }
}

test('rules: SDR presets, MBR by refresh rate, sniper, Ambiglow modes and ScanMode (06 §8)', async () => {
  await withProfile((p, c) => {
    // SDR EasyRead: contrast, preset and colour space disabled, DLBL disabled, SmartFrame disabled.
    p.IsSmartImageHDR = false;
    p.OP_DC_DisplayApplication.Value = 14;
    c.recheck(p, true);
    let s = states(c);
    assert.equal(s.OP_12_Contrast, 2);
    assert.equal(s.OP_14_SelectColorPreset, 2);
    assert.equal(s.EXT_OP_E2A0_20_ColorSpace, 2);
    assert.equal(s.EXT_OP_E2A0_24_DLBL, 2);
    assert.equal(s.EXT_OP_E2A0_08_SmartFrame, 2);
    assert.equal(s.EXT_OP_E2A0_44_StarkShadowBoost, 1);

    // LowBlue: DLBL enabled.
    p.OP_DC_DisplayApplication.Value = 11;
    c.recheck(p, true);
    assert.equal(states(c).EXT_OP_E2A0_24_DLBL, 1);

    // SDR, sniper on (SharpShooter size ≠ 0): LowInputLag and SmartContrast disabled.
    p.OP_DC_DisplayApplication.Value = 4;
    p.ModuleGameMode.EXT_OP_E2A0_06_SharpShooter_Size.Value = 2;
    p.ModuleSetup.EXT_OP_E2A0_35_ScreenSaver.Value = 0;
    c.recheck(p, true);
    s = states(c);
    assert.equal(s.EXT_OP_E2A0_07_LowInputLag, 2);
    assert.equal(s.OP_F0_SmartContrast, 2);
    assert.equal(s.EXT_OP_E2A0_08_SmartFrame, 2);

    // MBR: disabled below 75 Hz or with AdaptiveSync; available and not otherwise blocked → enabled.
    p.ModuleGameMode.EXT_OP_E2A0_06_SharpShooter_Size.Value = 0;
    p.ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync.Value = 0;
    p.ModuleGameMode.EXT_OP_E2A0_02_MBR.err_code = 0;
    p.ModuleGameMode.EXT_OP_E2A0_02_MBR.Value = 1;
    p.DispalyData.MonitorFrequency = '74Hz';
    c.recheck(p, true);
    assert.equal(states(c).EXT_OP_E2A0_02_MBR, 2);
    assert.equal(states(c).OP_10_Luminance, 1);
    p.DispalyData.MonitorFrequency = '175Hz';
    c.recheck(p, true);
    s = states(c);
    assert.equal(s.EXT_OP_E2A0_02_MBR, 1);
    // mbr active in SDR: luminance and SmartContrast disabled.
    assert.equal(s.OP_10_Luminance, 2);
    assert.equal(s.OP_F0_SmartContrast, 2);

    // Ambiglow FollowVideo: colours/position/speed/direction disabled, brightness enabled.
    p.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value = 1;
    c.recheck(p, true);
    s = states(c);
    assert.deepEqual([s.EXT_OP_E2A0_1A_AmbiglowColors, s.EXT_OP_E2A0_1B_AmbiglowLightPosition, s.EXT_OP_E2A0_1C_AmbiglowLightBrightness, s.EXT_OP_E2A0_1D_AmbiglowLightSpeed, s.EXT_OP_E2A0_1E_AmbiglowLightDirection], [2, 2, 1, 2, 2]);
    // Ambiglow unavailable: all five disabled.
    p.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.err_code = 9;
    c.recheck(p, true);
    s = states(c);
    assert.deepEqual([s.EXT_OP_E2A0_1A_AmbiglowColors, s.EXT_OP_E2A0_1E_AmbiglowLightDirection], [2, 2]);

    // ScanMode is disabled exactly when 0x86 is available and No Scaling (1).
    p.ModuleSystem.OP_86_DisplayScaling.Value = 1;
    c.recheck(p, true);
    assert.equal(states(c).OP_DA_ScanMode, 2);
    p.ModuleSystem.OP_86_DisplayScaling.Value = 2;
    c.recheck(p, true);
    assert.equal(states(c).OP_DA_ScanMode, 1);

    // PIP active only when F7 offers a table (DataOSD.PIPPBPEnable) and A5 ≠ 0.
    p.ModuleInput.OP_A5_WindowSelect.Value = 256;
    c.recheck(p, false);
    assert.equal(states(c).OP_E0_AudioSource, 2);
    c.recheck(p, true);
    s = states(c);
    assert.equal(s.OP_E0_AudioSource, 1);
    assert.equal(s.OP_54_PerformancePreservation, 2);
    assert.equal(s.EXT_OP_E2A0_03_MBRSync, 2);
  });
});

test('MonitorFrequency parsing follows int.TryParse after removing "hz" (DisplayFuncConstraints.method_4)', () => {
  assert.equal(parseFrequency('175Hz'), 175);
  assert.equal(parseFrequency('59HZ'), 59);
  assert.equal(parseFrequency(' 60 hz '), 60);
  assert.equal(parseFrequency('59.94Hz'), 0);
  assert.equal(parseFrequency(''), 0);
  assert.equal(parseFrequency(null), 0);
});
