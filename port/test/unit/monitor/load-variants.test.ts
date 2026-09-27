// The branches of method_4 (the full read, PHL/CDevice_PHLDisplay.cs:296-468) and method_10 (the forced
// SmartImage group of a theme switch, :630-676) that the user's HDR monitor never takes, on simulator
// variants of the 34M2C8600: the SDR group, DualResolution/Overclock trimming and the UHD120Hz removal,
// the F7 PIP table with PIP active at load, the OLED timers — plus the insertion order of the
// Dictionary<int, …> SubSmartImages (12 App. A) through serialize, purify, parse and clone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, stripBom } from '../../../src/backend/core/json.ts';
import { serializeResult } from '../../../src/backend/core/envelope.ts';
import { MOCK_34M2C8600 } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import type { SimulatedMonitor } from '../../../src/backend/ddc/transports/mock.ts';
import { T_PHLDisplay_Profile } from '../../../src/backend/monitor/model/profile.ts';
import { orderedEntries, parseJsonOrdered } from '../../../src/backend/monitor/model/json-populate.ts';
import { getDatas } from '../../../src/backend/monitor/model/enum-items.ts';
import { jsonKeyOrders } from '../../contract/compare.ts';
import { type TestDisplay, defaultPcenterText, defaultProfileContent, framesSince, getFrame, loadedDisplay, setFrame, specWith } from './helpers.ts';

function data(t: TestDisplay): T_PHLDisplay_Profile {
  const p = t.display.profile();
  assert.ok(p);
  return p;
}

async function traced<T>(t: TestDisplay, fn: () => Promise<T>): Promise<{ result: T; frames: string[]; sleeps: number[] }> {
  const f0 = t.bundle.monitor.frames.length;
  const s0 = t.clock.sleeps.length;
  const result = await fn();
  return { result, frames: framesSince(t.bundle.monitor.frames, f0), sleeps: t.clock.sleeps.slice(s0) };
}

/** The 34M2C8600 capability string with extra vcp() entries (inserted after E2A044). */
function capsWith(extra: string): string {
  const anchor = 'E2A044(00 01 02 03)';
  assert.ok(MOCK_34M2C8600.capabilities.includes(anchor));
  return MOCK_34M2C8600.capabilities.replace(anchor, `${anchor} ${extra}`);
}

/** Change a control on the simulator directly (as the OSD would), without going through the driver. */
function poke(monitor: SimulatedMonitor, code: number, value: number): void {
  const payload = [0x03, code, (value >> 8) & 0xff, value & 0xff];
  const bytes = [0x51, 0x80 | payload.length, ...payload];
  let chk = 0x6e;
  for (const b of bytes) chk ^= b;
  monitor.receive(Uint8Array.from([...bytes, chk]));
}

// ───────────────────────────── SDR (method_4 else-branch, method_10 SDR group) ─────────────────────────────

test('SDR monitor: load reads the SmartImage group; a theme switch forces it (method_10 SDR branch, 20-theme §6)', async () => {
  const t = await loadedDisplay({ spec: specWith([[0xdc, 0x03, 0x35]]), stored: null });
  try {
    const d = data(t);
    assert.equal(d.IsSmartImageHDR, false);
    assert.deepEqual(d.ModuleSmartImage.Items.map((x) => x.Value), [0, 1, 3, 4, 5, 6, 7, 8, 11, 14, 17, 81]);
    assert.deepEqual(d.ModuleSmartImageHDR.Items, []);
    assert.deepEqual([...d.ModuleSmartImage.SubSmartImages.keys()], [3]);
    assert.equal(d.ModuleSmartImage.CurSubSmartImage.OP_14_SelectColorPreset.Value, 5);
    // 8A/90 are not in the capability string: unavailable, never written.
    assert.equal(d.ModuleSmartImage.CurSubSmartImage.OP_8A_Saturation.IsAvailable, false);

    const content = t.display.purify();
    // Same profile: every available member of the group is written (forced), then E2A019 = 0 (Ambiglow off).
    const same = await traced(t, () => t.display.applyProfileContent(content));
    assert.deepEqual(same.frames, [
      setFrame(0xe2a020, 0x0f), setFrame(0x14, 5), setFrame(0x72, 0x78), setFrame(0x12, 0x32), setFrame(0xf0, 0),
      setFrame(0x87, 0x32), setFrame(0x10, 0x64), setFrame(0xe2a024, 0), setFrame(0xe2a019, 0),
    ]);
    assert.deepEqual(same.sleeps, []);

    // Another SmartImage (in Items) and the UserRGB preset: DC first (+1000 ms), then 16/18/1A too.
    const other = content.replace('"OP_DC_DisplayApplication":{"VCPOpCode":220,"Value":3,', '"OP_DC_DisplayApplication":{"VCPOpCode":220,"Value":4,').replace('"OP_14_SelectColorPreset":{"VCPOpCode":20,"Value":5,', '"OP_14_SelectColorPreset":{"VCPOpCode":20,"Value":11,');
    assert.notEqual(other, content);
    const r = await traced(t, () => t.display.applyProfileContent(other));
    assert.deepEqual(r.frames, [
      setFrame(0xdc, 4),
      setFrame(0xe2a020, 0x0f), setFrame(0x14, 11), setFrame(0x16, 0x64), setFrame(0x18, 0x64), setFrame(0x1a, 0x64),
      setFrame(0x72, 0x78), setFrame(0x12, 0x32), setFrame(0xf0, 0), setFrame(0x87, 0x32), setFrame(0x10, 0x64), setFrame(0xe2a024, 0),
      setFrame(0xe2a019, 0),
    ]);
    assert.deepEqual(r.sleeps, [1000]);
    assert.equal(data(t).OP_DC_DisplayApplication.Value, 4);
    assert.equal(t.bundle.monitor.control(0x14)?.value, 11);
    // dictionary = profile.SubSmartImages.ToCloning(); dictionary[DC] = the current group.
    assert.deepEqual([...data(t).ModuleSmartImage.SubSmartImages.keys()], [3, 4]);

    // A DC that is not one of the monitor's SDR modes keeps the current one (no DC write).
    const invalid = content.replace('"OP_DC_DisplayApplication":{"VCPOpCode":220,"Value":3,', '"OP_DC_DisplayApplication":{"VCPOpCode":220,"Value":2,');
    const r2 = await traced(t, () => t.display.applyProfileContent(invalid));
    assert.equal(r2.frames.includes(setFrame(0xdc, 2)), false);
    assert.equal(r2.frames[0], setFrame(0xe2a020, 0x0f));
  } finally {
    await t.cleanup();
  }
});

test('SubSmartImages keep the Dictionary insertion order in replies, purify, parse and clone (not ascending)', async () => {
  const t = await loadedDisplay({ spec: specWith([[0xdc, 0x03, 0x35]]), stored: null });
  try {
    await t.display.setSmartImage(4);
    const r = await t.display.setSmartImage(1);
    assert.deepEqual([...data(t).ModuleSmartImage.SubSmartImages.keys()], [3, 4, 1]);

    const reply = serializeResult({ ...r, RequestId: 'x', FunctionName: 'PHL_SetSmartImage' });
    assert.deepEqual(jsonKeyOrders(reply).get('Tag.Item2.SubSmartImages'), ['3', '4', '1']);
    const ui = serialize(t.display.profile(), 'uiProfileGet');
    assert.deepEqual(jsonKeyOrders(ui).get('ModuleSmartImage.SubSmartImages'), ['3', '4', '1']);
    // The tree view (JSON.parse) is ascending, which is exactly what the raw order must not be.
    assert.deepEqual(Object.keys((JSON.parse(ui) as { ModuleSmartImage: { SubSmartImages: object } }).ModuleSmartImage.SubSmartImages), ['1', '3', '4']);

    const stored = t.display.purify();
    assert.deepEqual(jsonKeyOrders(stored).get('ModuleSmartImage.SubSmartImages'), ['3', '4', '1']);
    const parsed = T_PHLDisplay_Profile.parse(stored);
    assert.ok(parsed);
    assert.deepEqual([...parsed.ModuleSmartImage.SubSmartImages.keys()], [3, 4, 1]);
    assert.equal(parsed.purify(), stored);
    assert.equal(serialize(data(t).clone(), 'ui'), serialize(data(t), 'ui'));
    assert.deepEqual([...data(t).clone().ModuleSmartImage.SubSmartImages.keys()], [3, 4, 1]);

    // A later theme switch keeps the profile's order and appends/overwrites the current DC in place.
    await t.display.applyProfileContent(stored);
    assert.deepEqual([...data(t).ModuleSmartImage.SubSmartImages.keys()], [3, 4, 1]);
  } finally {
    await t.cleanup();
  }
});

test('a Windows ProfileContent with {"34":…,"33":…} parses and purifies in that order (byte for byte)', () => {
  const p = T_PHLDisplay_Profile.parse(defaultProfileContent());
  assert.ok(p);
  const m = p.ModuleSmartImageHDR;
  const g33 = m.SubSmartImages.get(33);
  assert.ok(g33);
  const g34 = g33.clone();
  g34.OP_10_Luminance.Value = 70;
  m.SubSmartImages = new Map([[34, g34], [33, g33]]);
  const text = p.purify();
  assert.deepEqual(jsonKeyOrders(text).get('ModuleSmartImageHDR.SubSmartImages'), ['34', '33']);
  assert.notEqual(JSON.stringify(JSON.parse(text)), text, 'a plain JSON round trip would reorder');
  const again = T_PHLDisplay_Profile.parse(text);
  assert.ok(again);
  assert.deepEqual([...again.ModuleSmartImageHDR.SubSmartImages.keys()], [34, 33]);
  assert.equal(again.purify(), text);
});

test('parseJsonOrdered: JSON.parse values and errors, plus the source order of integer-like keys', () => {
  const wrapper = stripBom(defaultPcenterText());
  assert.deepEqual(parseJsonOrdered(wrapper), JSON.parse(wrapper));
  const content = defaultProfileContent();
  assert.deepEqual(parseJsonOrdered(content), JSON.parse(content));
  for (const s of ['{"a":[1,-2.5e3,true,false,null,"\\u00e9\\n\\""],"b":{}}', '[]', ' 0 ', '"x"', '{"a":1,"a":2}']) {
    assert.deepEqual(parseJsonOrdered(s), JSON.parse(s), s);
  }
  for (const bad of ['', '{"a":1,}', '[1 2]', '{"a":01}', '"\\x"', '{"a":1} x', '{a:1}', '"\u0001"', 'tru', '[1,]']) {
    assert.throws(() => JSON.parse(bad), SyntaxError, bad);
    assert.throws(() => parseJsonOrdered(bad), SyntaxError, bad);
  }
  const o = parseJsonOrdered('{"34":1,"b":2,"33":3,"34":4}') as Record<string, unknown>;
  assert.deepEqual(orderedEntries(o), [['34', 4], ['b', 2], ['33', 3]]);
  const proto = parseJsonOrdered('{"__proto__":{"x":1}}') as object;
  assert.ok(Object.hasOwn(proto, '__proto__'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
});

// ───────────────────────────── GameMode: DualResolution split (PHL/…:351-376, :449-455) ─────────────────────────────

const DUAL_CAPS = capsWith('E2A04C(00 01) E2A059(00 01 04)');

async function dualResolution(vcp: ReadonlyArray<readonly [number, number, number]>, caps = DUAL_CAPS): Promise<{ value: unknown; list: number[] | undefined }> {
  const t = await loadedDisplay({ spec: specWith(vcp, { capabilities: caps }), cachedCaps: false });
  try {
    const a = data(t).ModuleGameMode.EXT_OP_E2A0_59_DualResolution;
    assert.equal(a.IsAvailable, true);
    return { value: a.Value, list: a.ValueList?.map((x) => x.Value) };
  } finally {
    await t.cleanup();
  }
}

test('DualResolution: value = low byte; Overclock ON drops the first <split> entries (06 §7.11, 20-enum §8 item 3)', async () => {
  // raw 0x0101: split 1, UHD160Hz; Overclock on → [UHD160Hz, UHD240Hz].
  assert.deepEqual(await dualResolution([[0xe2a059, 0x0101, 0x04], [0xe2a04c, 1, 1]]), { value: 1, list: [1, 4] });
});

test('DualResolution: Overclock OFF keeps the first <split> entries; UHD120Hz is removed on DP/USB-C inputs only', async () => {
  // split 2 → [UHD120Hz, UHD160Hz]; the input is DisplayPort 1 (0x0F) → UHD120Hz removed.
  assert.deepEqual(await dualResolution([[0xe2a059, 0x0201, 0x04], [0xe2a04c, 0, 1]]), { value: 1, list: [1] });
  // HDMI 1 (0x11): UHD120Hz stays.
  assert.deepEqual(await dualResolution([[0xe2a059, 0x0201, 0x04], [0xe2a04c, 0, 1], [0x60, 0x11, 0x3616]]), { value: 1, list: [0, 1] });
  // USB-C 1 (0x15) removes it like DP.
  assert.deepEqual(await dualResolution([[0xe2a059, 0x0200, 0x04], [0xe2a04c, 0, 1], [0x60, 0x15, 0x3616]]), { value: 0, list: [1] });
});

test('DualResolution without Overclock in the capabilities: no split trimming (only the UHD120Hz rule)', async () => {
  const caps = capsWith('E2A059(00 01 04)');
  assert.deepEqual(await dualResolution([[0xe2a059, 0x0101, 0x04]], caps), { value: 1, list: [1, 4] });
  assert.deepEqual(await dualResolution([[0xe2a059, 0x0101, 0x04], [0x60, 0x12, 0x3616]], caps), { value: 1, list: [0, 1, 4] });
});

// ───────────────────────────── Setup: OLED timers (method_9, PHL/…:518-557) ─────────────────────────────

test('OLED timers: (H << 16) | L from E2A04D/4E and E2A050/51, read L first; a missing H counts as 0', async () => {
  const full = await loadedDisplay({
    spec: specWith([[0xe2a04e, 0x1234, 0xffff], [0xe2a04d, 0x0002, 0xffff], [0xe2a051, 0x0010, 0xffff], [0xe2a050, 0x0001, 0xffff]], { capabilities: capsWith('E2A04D E2A04E E2A050 E2A051') }),
    cachedCaps: false,
  });
  try {
    assert.equal(data(full).ModuleSetup.WorkingTime, (2 << 16) | 0x1234);
    assert.equal(data(full).ModuleSetup.TimeAfterPixelRefresh, (1 << 16) | 0x10);
    const order = [0xe2a04e, 0xe2a04d, 0xe2a051, 0xe2a050].map(getFrame);
    assert.deepEqual(framesSince(full.bundle.monitor.frames, 0).filter((f) => order.includes(f)), order);
  } finally {
    await full.cleanup();
  }
  const lowOnly = await loadedDisplay({
    spec: specWith([[0xe2a04e, 0x1234, 0xffff], [0xe2a051, 0x0010, 0xffff]], { capabilities: capsWith('E2A04E E2A051') }),
    cachedCaps: false,
  });
  try {
    assert.equal(data(lowOnly).ModuleSetup.WorkingTime, 0x1234);
    assert.equal(data(lowOnly).ModuleSetup.TimeAfterPixelRefresh, 0x10);
  } finally {
    await lowOnly.cleanup();
  }
  // Without the L codes both stay -1 (the user's monitor, 20-enum §5).
  const none = await loadedDisplay();
  try {
    assert.equal(data(none).ModuleSetup.WorkingTime, -1);
    assert.equal(data(none).ModuleSetup.TimeAfterPixelRefresh, -1);
  } finally {
    await none.cleanup();
  }
});

// ───────────────────────────── Input: F7 PIP table with PIP active (PHL/…:391-420, 06 §7.8-7.9) ─────────────────────────────

test('PIP active at load: A5 gets the F7 table, Mode/Size/Location from A5/EC, PIP source from 0x60 byte 1', async () => {
  const t = await loadedDisplay({ spec: specWith([[0xa5, 0x100, 0x200], [0xec, 0x0201, 0x0000], [0x60, 0x210f, 0x3616]]) });
  try {
    const input = data(t).ModuleInput;
    assert.deepEqual(input.OP_A5_WindowSelect.ValueList?.map((x) => x.Value), getDatas('VCP_A5_PIPPBPType_42_E').map((x) => x.Value));
    assert.deepEqual(input.OP_A5_WindowSelect.ValueList?.map((x) => x.Value), [0, 256, 512]);
    assert.deepEqual({ ...input.InputSourceInfo }, { Mode: 256, Size: 1, Location: 2, PIPPBPSource: 33, InputSource: 15 });
    // PIP on: AudioSource enabled (06 §8).
    assert.equal(t.display.constraints.state(0xe0), 1);

    // Same PIP parameters, another main input: only 60 and the A4 commit (100 ms apart).
    const main = await traced(t, () => t.display.setInputSource(17, 33, 256, 1, 2));
    assert.deepEqual(main.frames, [setFrame(0x60, 0x2111), setFrame(0xa4, 0xffff)]);
    assert.deepEqual(main.sleeps, [100]);

    // A PIP size/location change: A5, EC, 60, A4.
    const size = await traced(t, () => t.display.setInputSource(17, 33, 256, 2, 1));
    assert.deepEqual(size.frames, [setFrame(0xa5, 256), setFrame(0xec, 0x0102), setFrame(0x60, 0x2111), setFrame(0xa4, 0xffff)]);
    assert.deepEqual(size.sleeps, [100, 100, 100]);

    // PHL_SwrapPIPPBP: F6 = 1, 5000 ms, re-read 0x60 and split it again (the monitor swapped the sources).
    poke(t.bundle.monitor, 0x60, 0x2f11);
    const swap = await traced(t, () => t.display.swapPipPbp());
    assert.deepEqual(swap.frames, [setFrame(0xf6, 1), getFrame(0x60)]);
    assert.deepEqual(swap.sleeps, [5000]);
    assert.deepEqual({ ...data(t).ModuleInput.InputSourceInfo }, { Mode: 256, Size: 2, Location: 1, PIPPBPSource: 47, InputSource: 17 });
  } finally {
    await t.cleanup();
  }
});

test('PIP off with 0x60 byte 1 = 0: the PIP source defaults to HDMI 2 (34), else DisplayPort 1 (47)', async () => {
  const t = await loadedDisplay();
  try {
    assert.deepEqual({ ...data(t).ModuleInput.InputSourceInfo }, { Mode: 0, Size: 0, Location: 0, PIPPBPSource: 34, InputSource: 15 });
  } finally {
    await t.cleanup();
  }
  const noHdmi2 = await loadedDisplay({ spec: specWith([], { capabilities: MOCK_34M2C8600.capabilities.replace('60(11 12 0F 15 21 22 2F 35 )', '60(11 12 0F 15 21 2F 35 )') }), cachedCaps: false });
  try {
    assert.equal(data(noHdmi2).ModuleInput.InputSourceInfo.PIPPBPSource, 47);
  } finally {
    await noHdmi2.cleanup();
  }
});
