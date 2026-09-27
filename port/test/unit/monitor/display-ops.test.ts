// Every PHL_* sequence of the driver against the simulated 34M2C8600: byte-exact DDC/CI frames (as the
// monitor received them) and the driver's Thread.Sleep delays on a virtual clock (06 §7, 20-theme §6).
// The channel runs with NO_DELAY_TIMINGS, so the recorded sleeps are exactly the driver's own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from '../../../src/backend/core/json.ts';
import { INVOCATION_FAILED, NOTIFY_CONSTRAINTS, NOTIFY_EFFECT } from '../../../src/backend/monitor/display.ts';
import type { T_PHLDisplay_Profile } from '../../../src/backend/monitor/model/profile.ts';
import { type TestDisplay, framesSince, getFrame, loadedDisplay, setFrame, specWith, testDisplay } from './helpers.ts';

/** Run `fn` and return the frames and driver sleeps it caused. */
async function traced<T>(t: TestDisplay, fn: () => Promise<T>): Promise<{ result: T; frames: string[]; sleeps: number[] }> {
  const f0 = t.bundle.monitor.frames.length;
  const s0 = t.clock.sleeps.length;
  const result = await fn();
  return { result, frames: framesSince(t.bundle.monitor.frames, f0), sleeps: t.clock.sleeps.slice(s0) };
}

function data(t: TestDisplay): T_PHLDisplay_Profile {
  const p = t.display.profile();
  assert.ok(p);
  return p;
}

test('connect + load: no stored value is pushed; the only writes are the EQ band selector loop (20 corrections)', async () => {
  const t = await loadedDisplay();
  try {
    const sets = framesSince(t.bundle.monitor.frames, 0).filter((f) => f.startsWith('51 84 03') || f.startsWith('51 86 03'));
    assert.deepEqual(sets, [0, 1, 2, 3, 4].map((band) => setFrame(0xe2a001, band)));
    // EQ loop: 100 ms after every band write (PHL/…:428-431).
    assert.deepEqual(t.clock.sleeps, [100, 100, 100, 100, 100]);
    // N0: the scan-time constraints notification (20-backend-host-tail §5 step 2).
    assert.equal(t.notifier.named(NOTIFY_CONSTRAINTS).length, 1);
  } finally {
    await t.cleanup();
  }
});

test('PHL_SetOSD: one write, no delay, recheck + save; unavailable/unknown names write nothing (06 §7.2)', async () => {
  const t = await loadedDisplay();
  try {
    const saves = t.themes.saves;
    const a = await traced(t, () => t.display.setOsd('OP_10_Luminance', 80));
    assert.deepEqual(a.frames, [setFrame(0x10, 80)]);
    assert.deepEqual(a.sleeps, []);
    assert.equal(a.result.err_code, 0);
    assert.equal(serialize(a.result.Tag, 'ui'), '{"VCPOpCode":16,"VCPOpCodeName":"OP_10_Luminance","Value":80,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0}');
    assert.equal(t.themes.saves, saves + 1);
    assert.equal(t.bundle.monitor.control(0x10)?.value, 80);
    // HDR: the vendor still stores the SDR sub-module under the DC key (06 §7.2 "Bug (harmless)").
    assert.ok(data(t).ModuleSmartImage.SubSmartImages.has(33));

    const ext = await traced(t, () => t.display.setOsd('EXT_OP_E2A0_43_AutoWarning', 0));
    assert.deepEqual(ext.frames, [setFrame(0xe2a043, 0)]);

    const off = await traced(t, () => t.display.setOsd('EXT_OP_E2A0_02_MBR', 1));
    assert.deepEqual(off.frames, []);
    assert.equal((off.result.Tag as { err_code: number }).err_code, 9);

    const unknown = await traced(t, () => t.display.setOsd('OP_99_Nothing', 1));
    assert.deepEqual(unknown.frames, []);
    assert.equal(unknown.result.err_code, 0);
    assert.equal(unknown.result.Tag, null);
  } finally {
    await t.cleanup();
  }
});

test('PHL_SetSmartImage: DC write, 1000 ms, re-read of the HDR sub-module (06 §7.4)', async () => {
  const t = await loadedDisplay();
  try {
    const r = await traced(t, () => t.display.setSmartImage(34));
    assert.deepEqual(r.frames, [setFrame(0xdc, 34), getFrame(0x10), getFrame(0x12)]);
    assert.deepEqual(r.sleeps, [1000]);
    const tag = JSON.parse(serialize(r.result.Tag, 'ui')) as { Item1: { Value: number }; Item2: { SubSmartImages: Record<string, unknown>; Items: unknown[] } };
    assert.equal(tag.Item1.Value, 34);
    assert.deepEqual(Object.keys(tag.Item2.SubSmartImages), ['33', '34']);
    assert.equal(tag.Item2.Items.length, 7);

    const invalid = await traced(t, () => t.display.setSmartImage(0));
    assert.deepEqual(invalid.frames, []);
    assert.equal(invalid.result.err_msg, 'SetSmartImage iValue is not valid');

    const same = await traced(t, () => t.display.setSmartImage(34));
    assert.deepEqual(same.frames, []);
    assert.deepEqual(same.sleeps, []);
  } finally {
    await t.cleanup();
  }
});

test('PHL_ResetSmartImage: E2A042 reset code, 1000 ms, re-read when current; Off rejected (06 §7.5)', async () => {
  const t = await loadedDisplay();
  try {
    const cur = await traced(t, () => t.display.resetSmartImage(33));
    assert.deepEqual(cur.frames, [setFrame(0xe2a042, 59), getFrame(0x10), getFrame(0x12)]);
    assert.deepEqual(cur.sleeps, [1000]);
    assert.equal(cur.result.err_code, 0);

    const other = await traced(t, () => t.display.resetSmartImage(35));
    assert.deepEqual(other.frames, [setFrame(0xe2a042, 61)]);
    assert.deepEqual(other.sleeps, [1000]);

    const off = await traced(t, () => t.display.resetSmartImage(32));
    assert.deepEqual(off.frames, []);
    assert.equal(off.result.err_msg, 'Off Mode Not Support ResetSmartImage');
  } finally {
    await t.cleanup();
  }
});

test('PHL_SetColorPreset: 0x14 write; UserRGB adds 50 ms and reads 16/18/1A (06 §7.6)', async () => {
  const t = await loadedDisplay();
  try {
    const plain = await traced(t, () => t.display.setColorPreset(5));
    assert.deepEqual(plain.frames, [setFrame(0x14, 5)]);
    assert.deepEqual(plain.sleeps, []);
    const user = await traced(t, () => t.display.setColorPreset(11));
    assert.deepEqual(user.frames, [setFrame(0x14, 11), getFrame(0x16), getFrame(0x18), getFrame(0x1a)]);
    assert.deepEqual(user.sleeps, [50]);
  } finally {
    await t.cleanup();
  }
});

test('PHL_SwitchSmartFrame: E2A008, 100 ms, E2A00A probe, then 100 ms before each of 0B, 09, 0C, 0D (06 §7.7)', async () => {
  const t = await loadedDisplay();
  try {
    const r = await traced(t, () => t.display.switchSmartFrame(1));
    assert.deepEqual(r.frames, [setFrame(0xe2a008, 1), getFrame(0xe2a00a), getFrame(0xe2a00b), getFrame(0xe2a009), getFrame(0xe2a00c), getFrame(0xe2a00d)]);
    assert.deepEqual(r.sleeps, [100, 100, 100, 100, 100]);
  } finally {
    await t.cleanup();
  }
});

test('PHL_SwitchSmartFrame polls E2A00A up to 10 times, 1000 ms apart, while its max is not 100', async () => {
  const t = await loadedDisplay({ spec: specWith([[0xe2a00a, 0x40, 0x50]]) });
  try {
    const r = await traced(t, () => t.display.switchSmartFrame(1));
    assert.deepEqual(r.frames, [
      setFrame(0xe2a008, 1),
      ...Array.from({ length: 11 }, () => getFrame(0xe2a00a)),
      getFrame(0xe2a00b), getFrame(0xe2a009), getFrame(0xe2a00c), getFrame(0xe2a00d),
    ]);
    assert.deepEqual(r.sleeps, [100, ...Array.from({ length: 10 }, () => 1000), 100, 100, 100, 100]);
  } finally {
    await t.cleanup();
  }
});

test('PHL_SetSmartFrameSize: E2A009, 1000 ms, read 0C, 100 ms, read 0D (06 §7.7)', async () => {
  const t = await loadedDisplay();
  try {
    const r = await traced(t, () => t.display.setSmartFrameSize(3));
    assert.deepEqual(r.frames, [setFrame(0xe2a009, 3), getFrame(0xe2a00c), getFrame(0xe2a00d)]);
    assert.deepEqual(r.sleeps, [1000, 100]);
  } finally {
    await t.cleanup();
  }
});

test('PHL_SetInputSource: input only → 60, 100 ms, A4 = FFFF; PIP change → A5, EC, 60, A4 (06 §7.8)', async () => {
  const t = await loadedDisplay();
  try {
    const plain = await traced(t, () => t.display.setInputSource(17, 34, 0, 0, 0));
    assert.deepEqual(plain.frames, [setFrame(0x60, 0x2211), setFrame(0xa4, 0xffff)]);
    assert.deepEqual(plain.sleeps, [100]);
    const unchanged = await traced(t, () => t.display.setInputSource(17, 34, 0, 0, 0));
    assert.deepEqual(unchanged.frames, []);

    const notified = t.notifier.named(NOTIFY_CONSTRAINTS).length;
    const pip = await traced(t, () => t.display.setInputSource(15, 33, 256, 1, 2));
    assert.deepEqual(pip.frames, [setFrame(0xa5, 256), setFrame(0xec, 0x0201), setFrame(0x60, 0x210f), setFrame(0xa4, 0xffff)]);
    assert.deepEqual(pip.sleeps, [100, 100, 100]);
    assert.deepEqual({ ...data(t).ModuleInput.InputSourceInfo }, { Mode: 256, Size: 1, Location: 2, PIPPBPSource: 33, InputSource: 15 });
    // PIP on changes the constraints (AdaptiveSync, SmartCrosshair, … disabled; AudioSource enabled).
    assert.equal(t.notifier.named(NOTIFY_CONSTRAINTS).length, notified + 1);
    assert.equal(t.display.constraints.state(0xe0), 1);
    assert.equal(t.display.constraints.state(0xe2a040), 2);

    // PHL_SwrapPIPPBP now swaps: F6 = 1, 5000 ms, re-read 0x60 (06 §7.9).
    const swap = await traced(t, () => t.display.swapPipPbp());
    assert.deepEqual(swap.frames, [setFrame(0xf6, 1), getFrame(0x60)]);
    assert.deepEqual(swap.sleeps, [5000]);
  } finally {
    await t.cleanup();
  }
});

test('PHL_SwrapPIPPBP without PIP/PBP does nothing', async () => {
  const t = await loadedDisplay();
  try {
    const r = await traced(t, () => t.display.swapPipPbp());
    assert.deepEqual(r.frames, []);
    assert.equal(r.result.err_code, 0);
  } finally {
    await t.cleanup();
  }
});

test('PHL_SetAudioEQ: band, 100 ms, gain; range and index errors (06 §7.10)', async () => {
  const t = await loadedDisplay();
  try {
    const r = await traced(t, () => t.display.setAudioEq(2, 10));
    assert.deepEqual(r.frames, [setFrame(0xe2a001, 2), setFrame(0xe2a039, 10)]);
    assert.deepEqual(r.sleeps, [100]);
    assert.equal(data(t).ModuleAudio.EQItems[2].Value, 10);
    const tooBig = await traced(t, () => t.display.setAudioEq(2, 17));
    assert.deepEqual(tooBig.frames, []);
    assert.equal(tooBig.result.err_msg, 'SetAudioEQ Error index=2 iValue=17 MaxValue=16');
    const missing = await t.display.setAudioEq(9, 1);
    assert.equal(missing.err_msg, INVOCATION_FAILED);
  } finally {
    await t.cleanup();
  }
});

test('PHL_GetConstraints notifies first and returns the constraints; ProfileAction/SetGamePQ stubs', async () => {
  const t = await loadedDisplay();
  try {
    const before = t.notifier.named(NOTIFY_CONSTRAINTS).length;
    const r = await t.display.getConstraints();
    assert.equal(t.notifier.named(NOTIFY_CONSTRAINTS).length, before + 1);
    assert.equal(serialize(r.Tag, 'ui'), t.notifier.named(NOTIFY_CONSTRAINTS).at(-1)?.json);
    const pa = await traced(t, () => t.display.profileAction(1, 0));
    assert.equal(pa.result.err_msg, 'EXT_OP_E2A0_6B_Profile Unavailable');
    assert.deepEqual(pa.frames, []);
    const gpq = await traced(t, () => t.display.setGamePQ());
    assert.equal(gpq.result.Tag, data(t).ModuleGameMode);
    assert.deepEqual(gpq.frames, []);
  } finally {
    await t.cleanup();
  }
});

test('Profile_Reset: 0x04 = 1, 5000 ms, full re-read, fresh EffectInfo, save (06 §7.12, 20-theme §6)', async () => {
  const t = await loadedDisplay();
  try {
    await t.display.setOsd('OP_10_Luminance', 40);
    const saves = t.themes.saves;
    const r = await traced(t, () => t.display.reset(true));
    assert.equal(r.frames[0], setFrame(0x04, 1));
    assert.deepEqual(r.sleeps, [5000, 100, 100, 100, 100, 100]);
    // The re-read picked up the factory values of the simulator.
    assert.equal(data(t).ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value, 100);
    // GetDefaultData without ENE: `new DisplayEffectInfo()` (20-enum §6.4).
    assert.equal(serialize(data(t).EffectInfo, 'ui').endsWith('"CurrEffect":{"Name":null,"Text":null,"Value":0}}'), true);
    assert.equal(t.themes.saves, saves + 1);
    assert.equal(r.result.Tag, data(t));

    // resetToFactory is Reset(needSave: false).
    const saves2 = t.themes.saves;
    await t.display.resetToFactory();
    assert.equal(t.themes.saves, saves2);
  } finally {
    await t.cleanup();
  }
});

test('Profile_Reset without 0x04 in the capabilities: "not support rest"', async () => {
  const caps = specWith([]).capabilities.replace('vcp(02 04 05', 'vcp(02 05');
  const t = await loadedDisplay({ spec: specWith([], { capabilities: caps }), cachedCaps: false });
  try {
    const r = await traced(t, () => t.display.reset(true));
    assert.equal(r.result.err_msg, 'not support rest');
    assert.deepEqual(r.frames, []);
  } finally {
    await t.cleanup();
  }
});

test('theme switch to the stored profile: 0x10, 0x12, E2A019 = 0 — the 3 writes of 20-theme §6', async () => {
  const t = await loadedDisplay();
  try {
    const content = t.themes.getStoredContent(t.display.desc);
    const r = await traced(t, () => t.display.applyProfileContent(content));
    assert.deepEqual(r.frames, [setFrame(0x10, 100), setFrame(0x12, 50), setFrame(0xe2a019, 0)]);
    assert.deepEqual(r.sleeps, []);

    // A profile with another HDR preset also writes DC (+1000 ms) first.
    const other = content!.replace('"OP_DC_DisplayApplication":{"VCPOpCode":220,"Value":33', '"OP_DC_DisplayApplication":{"VCPOpCode":220,"Value":34');
    const r2 = await traced(t, () => t.display.applyProfileContent(other));
    assert.deepEqual(r2.frames, [setFrame(0xdc, 34), setFrame(0x10, 100), setFrame(0x12, 50), setFrame(0xe2a019, 0)]);
    assert.deepEqual(r2.sleeps, [1000]);
    // No section for this monitor: the cached state is re-applied (GetDefaultData).
    const r3 = await traced(t, () => t.display.applyProfileContent(null));
    assert.deepEqual(r3.frames, [setFrame(0x10, 100), setFrame(0x12, 50), setFrame(0xe2a019, 0)]);
  } finally {
    await t.cleanup();
  }
});

test('theme switch to a profile with Ambiglow on: E2A019 forced, 1A-1E only where different', async () => {
  const t = await loadedDisplay();
  try {
    const content = t.themes
      .getStoredContent(t.display.desc)!
      .replace('"EXT_OP_E2A0_1A_AmbiglowColors":{"VCPOpCode":14852122,"Value":6', '"EXT_OP_E2A0_1A_AmbiglowColors":{"VCPOpCode":14852122,"Value":2')
      .replace('"EffectEnable":false},"ModuleInput"', '"EffectEnable":true},"ModuleInput"')
      .replace('"EXT_OP_E2A0_19_AmbiglowLightMode":{"VCPOpCode":14852121,"Value":7', '"EXT_OP_E2A0_19_AmbiglowLightMode":{"VCPOpCode":14852121,"Value":3');
    const r = await traced(t, () => t.display.applyProfileContent(content));
    assert.deepEqual(r.frames, [setFrame(0x10, 100), setFrame(0x12, 50), setFrame(0xe2a019, 3), setFrame(0xe2a01a, 2)]);
    assert.equal(data(t).ModuleAmbiglow.EffectEnable, true);
  } finally {
    await t.cleanup();
  }
});

// Port fix (impl-monitor deviation 18, found by the e2e walkthrough): the setters change DeviceData only, as in the
// vendor, while ParameterToDevice compares the target with CacheDeviceData (the last full read) and ends with
// DeviceData = the cache. The vendor therefore skipped the DC write after a preset change (the monitor stayed in
// HDR Movie while the UI said HDR Game, method_10) and put the last full read's volume back into DeviceData.
test('theme switch after setters: compared with what the monitor was last given, and DeviceData keeps it', async () => {
  const t = await loadedDisplay();
  try {
    const content = t.themes.getStoredContent(t.display.desc)!;
    assert.equal(data(t).OP_DC_DisplayApplication.Value, 33, 'precondition: HDR Game');
    const volume = t.bundle.monitor.control(0x62)!.value === 30 ? 31 : 30;
    assert.equal((await t.display.setSmartImage(34)).err_code, 0);
    assert.equal((await t.display.setOsd('OP_62_AudioSpeakerVolume', volume)).err_code, 0);
    assert.equal(t.bundle.monitor.control(0xdc)!.value, 34);

    const r = await traced(t, () => t.display.applyProfileContent(content));
    // the profile's HDR Game is written again (+1000 ms), then the forced HDR picture values and Ambiglow
    assert.deepEqual(r.frames, [setFrame(0xdc, 33), setFrame(0x10, 100), setFrame(0x12, 50), setFrame(0xe2a019, 0)]);
    assert.deepEqual(r.sleeps, [1000]);
    assert.equal(t.bundle.monitor.control(0xdc)!.value, 33);
    assert.equal(data(t).OP_DC_DisplayApplication.Value, 33);
    // not part of a profile switch: the monitor keeps the volume, and so does DeviceData (what the UI shows and saves)
    assert.equal(t.bundle.monitor.control(0x62)!.value, volume);
    assert.equal(data(t).ModuleAudio.OP_62_AudioSpeakerVolume.Value, volume);
    assert.match(t.themes.getStoredContent(t.display.desc) ?? '', new RegExp(`"OP_62_AudioSpeakerVolume":\\{"VCPOpCode":98,"Value":${volume}\\b`));

    // DDC Ambiglow (method_12): 1A-1E are written only where they differ, now from the colour the monitor was given
    const on = content
      .replace('"EffectEnable":false},"ModuleInput"', '"EffectEnable":true},"ModuleInput"')
      .replace('"EXT_OP_E2A0_19_AmbiglowLightMode":{"VCPOpCode":14852121,"Value":7', '"EXT_OP_E2A0_19_AmbiglowLightMode":{"VCPOpCode":14852121,"Value":3');
    await t.display.applyProfileContent(on);
    assert.equal(t.bundle.monitor.control(0xe2a01a)!.value, 6);
    assert.equal((await t.display.setOsd('EXT_OP_E2A0_1A_AmbiglowColors', 2)).err_code, 0);
    const back = await traced(t, () => t.display.applyProfileContent(on));
    assert.deepEqual(back.frames, [setFrame(0x10, 100), setFrame(0x12, 50), setFrame(0xe2a019, 3), setFrame(0xe2a01a, 6)]);
    assert.equal(t.bundle.monitor.control(0xe2a01a)!.value, 6);

    // without a setter in between nothing changes: the same writes as a switch right after the load
    const again = await traced(t, () => t.display.applyProfileContent(content));
    assert.deepEqual(again.frames, [setFrame(0x10, 100), setFrame(0x12, 50), setFrame(0xe2a019, 0)]);
  } finally {
    await t.cleanup();
  }
});

test('PHL_ReloadData re-reads everything and keeps the stored EffectInfo (ParameterToDevice bForce:false)', async () => {
  const t = await loadedDisplay();
  try {
    t.bundle.monitor.receive(Uint8Array.from([0x51, 0x84, 0x03, 0x62, 0x00, 0x21, 0x6e ^ 0x51 ^ 0x84 ^ 0x03 ^ 0x62 ^ 0x00 ^ 0x21]));
    const r = await traced(t, () => t.display.reload());
    assert.equal(r.result.err_code, 0);
    assert.equal(data(t).ModuleAudio.OP_62_AudioSpeakerVolume.Value, 0x21);
    assert.equal(data(t).EffectInfo?.CurrEffect.Name, 'FollowVideo');
    assert.ok(r.frames.every((f) => !f.startsWith('51 84 03') || f === setFrame(0xe2a001, Number.parseInt(f.split(' ')[6], 16))));
  } finally {
    await t.cleanup();
  }
});

test('ENE presence: plug keeps the stored EffectInfo; loss writes the DDC state back and notifies (method_14/15)', async () => {
  const t = await loadedDisplay();
  try {
    await t.display.setEneModel('34M2C8600');
    assert.equal(data(t).ENEEffectEnable, true);
    assert.equal(data(t).EffectInfo?.CurrEffect.Name, 'FollowVideo');
    const plug = t.notifier.named(NOTIFY_EFFECT);
    assert.equal(plug.length, 1);
    // The keys the renderer handler reads (Monitor-D4qz4RBn.js:85-91, 20-backend-host-tail §2.5).
    const tag = JSON.parse(plug[0].json) as { ENEEnable: boolean; EffectInfo: { CurrEffect: { Name: string } }; ModuleAmbiglow: object } & Record<string, unknown>;
    // Named keys first, then the vendor's ValueTuple keys with the same values (12 §7 port plan item 7).
    assert.deepEqual(Object.keys(tag), ['ENEEnable', 'EffectInfo', 'ModuleAmbiglow', 'Item1', 'Item2', 'Item3']);
    assert.deepEqual([tag.Item1, tag.Item2, tag.Item3], [tag.ENEEnable, tag.EffectInfo, tag.ModuleAmbiglow]);
    assert.equal(tag.ENEEnable, true);
    assert.equal(tag.EffectInfo.CurrEffect.Name, 'FollowVideo');

    // The same report again changes nothing: no save, no notification.
    const saves = t.themes.saves;
    await t.display.setEneModel('34M2C8600');
    assert.equal(t.themes.saves, saves);
    assert.equal(t.notifier.named(NOTIFY_EFFECT).length, 1);

    // CacheDeviceData follows: a theme switch stays in ENE mode (method_12 ENE branch) — no E2A019 write.
    const content = t.themes.getStoredContent(t.display.desc);
    const sw = await traced(t, () => t.display.applyProfileContent(content));
    assert.deepEqual(sw.frames, [setFrame(0x10, 100), setFrame(0x12, 50)]);
    assert.equal(data(t).ENEEffectEnable, true);
    assert.equal(data(t).EffectInfo?.CurrEffect.Name, 'FollowVideo');

    const loss = await traced(t, () => t.display.setEneModel(''));
    assert.deepEqual(loss.frames, [setFrame(0xe2a019, 0)]);
    assert.equal(data(t).ENEEffectEnable, false);
    assert.equal(data(t).ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value, 7);
    const lost = JSON.parse(t.notifier.named(NOTIFY_EFFECT).at(-1)!.json) as Record<string, unknown>;
    assert.deepEqual(Object.keys(lost), ['ENEEnable', 'EffectInfo', 'ModuleAmbiglow', 'Item1', 'Item2', 'Item3']);
    assert.deepEqual([lost.Item1, lost.Item2, lost.Item3], [lost.ENEEnable, lost.EffectInfo, lost.ModuleAmbiglow]);
    assert.equal(lost.ENEEnable, false);
    // …and after the loss the cache is back on the DDC path: the switch writes E2A019 again.
    const sw2 = await traced(t, () => t.display.applyProfileContent(content));
    assert.deepEqual(sw2.frames, [setFrame(0x10, 100), setFrame(0x12, 50), setFrame(0xe2a019, 0)]);
  } finally {
    await t.cleanup();
  }
});

test('ENE present at start: checkEne answers before the first read, so the first DeviceData is in ENE mode (method_14)', async () => {
  const asked: string[] = [];
  const t = await loadedDisplay({ extra: { checkEne: async (d) => (asked.push(d.key), '34M2C8600') } });
  try {
    assert.deepEqual(asked, ['AU00000000001']);
    assert.equal(t.display.eneModel, '34M2C8600');
    assert.equal(data(t).ENEEffectEnable, true);
    // ParameterToDevice(bForce:false) with the cache in ENE mode keeps the stored (complete) EffectInfo.
    assert.equal(data(t).EffectInfo?.CurrEffect.Name, 'FollowVideo');
    // Still no stored value pushed: the only load writes are the EQ band selects.
    const sets = framesSince(t.bundle.monitor.frames, 0).filter((f) => f.startsWith('51 84 03') || f.startsWith('51 86 03'));
    assert.deepEqual(sets, [0, 1, 2, 3, 4].map((band) => setFrame(0xe2a001, band)));
    assert.equal(t.notifier.named(NOTIFY_EFFECT).length, 0);
    // The ambiglow service's later report of the same model is a no-op.
    await t.display.setEneModel('34M2C8600');
    assert.equal(t.notifier.named(NOTIFY_EFFECT).length, 0);
    // A theme switch stays in ENE mode.
    const sw = await traced(t, () => t.display.applyProfileContent(t.themes.getStoredContent(t.display.desc)));
    assert.deepEqual(sw.frames, [setFrame(0x10, 100), setFrame(0x12, 50)]);
    assert.equal(data(t).ENEEffectEnable, true);
    // PHL_ReloadData asks again (method_4 → method_14 every time).
    await t.display.reload();
    assert.equal(asked.length, 2);
    assert.equal(data(t).ENEEffectEnable, true);
  } finally {
    await t.cleanup();
  }
});

test('setEneModel during the first load (no checkEne answer) is used by that load; nothing is left to reconcile', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const t = await testDisplay({ extra: { checkEne: async () => (await gate, null) } });
  try {
    assert.ok(await t.display.connect());
    const report = t.display.setEneModel('34M2C8600');
    release();
    await t.display.ready();
    await report;
    assert.equal(data(t).ENEEffectEnable, true);
    assert.equal(t.notifier.named(NOTIFY_EFFECT).length, 0);
    const sw = await traced(t, () => t.display.applyProfileContent(t.themes.getStoredContent(t.display.desc)));
    assert.deepEqual(sw.frames, [setFrame(0x10, 100), setFrame(0x12, 50)]);
  } finally {
    await t.cleanup();
  }
});

test('a failing checkEne means no usable ENE (Plug() failure → method_15)', async () => {
  const t = await loadedDisplay({
    extra: {
      checkEne: async () => {
        throw new Error('LIBUSB_ERROR_ACCESS');
      },
    },
  });
  try {
    assert.equal(data(t).ENEEffectEnable, false);
    assert.equal(t.display.eneModel, '');
  } finally {
    await t.cleanup();
  }
});

test('operations queue: concurrent PHL_* sequences never interleave their frames', async () => {
  const t = await loadedDisplay();
  try {
    const f0 = t.bundle.monitor.frames.length;
    await Promise.all([t.display.setSmartFrameSize(2), t.display.setAudioEq(1, 9), t.display.setInputSource(18, 34, 0, 0, 0)]);
    assert.deepEqual(framesSince(t.bundle.monitor.frames, f0), [
      setFrame(0xe2a009, 2), getFrame(0xe2a00c), getFrame(0xe2a00d),
      setFrame(0xe2a001, 1), setFrame(0xe2a039, 9),
      setFrame(0x60, 0x2212), setFrame(0xa4, 0xffff),
    ]);
  } finally {
    await t.cleanup();
  }
});
