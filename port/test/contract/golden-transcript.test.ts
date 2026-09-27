// Contract test: replay the user's real 2026-09-26 session (20-backend-host-tail §5, steps 2-18) against the
// PRODUCTION backend composition in mock mode — src/backend/compose.ts through index.ts createDefaultBackend,
// exactly what Electron main's createBackend({ host, usb, mockMonitor }) builds (compose.ts in this directory
// wires nothing itself) — and compare every reply and notification with the Windows backend's, structurally
// (compare.ts: exact keys, key order — integer-like dictionary keys included, via the raw texts — JSON types,
// enum ints, Names/Texts; only the paths in ENVIRONMENT_DEPENDENT may differ) and byte for byte where nothing
// is tolerated.
//
// On the same backend (the golden hardware: no ENE) afterwards: the monitor-page flows of 03 §5, Effect_GetMenu
// without ENE (20-enum §6.2), the persistence of a PHL_SetOSD change (Profile_GetDeviceData, the .pcenter
// section, Theme_GetDevicesBasicInfo), and a theme switch that re-applies the SmartImage/HDR group and the
// Ambiglow of the target profile (20-theme §5.5, §6). On a second backend with the simulated ENE MCU: ENE mode
// from the first read, the Effect_* round trips against the MCU registers, a theme switch re-pushing the
// profile's EffectInfo, Effect_Reset, and the ENE unplug/replug through Device_DetectionUSB with its
// NotifyUIDisplayEffectChange notifications.
// lifecycle.test.ts covers the monitor hotplug, Theme_ResetCurProfile/FactoryReset (VCP 0x04) and restarts;
// serve.test.ts the smoke server. Step 1 (SignalR handshake) is the hub's (test/unit/hub).
//
// The composed tests skip, with the reason, only when build/vendor-data is missing (`npm run import-ui`); the
// fixture provenance check, the comparator tests and the replay of the steps owned by api/system.ts and
// api/stubs.ts always run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createBackend, type ApiModule } from '../../src/backend/index.ts';
import { succ } from '../../src/backend/core/envelope.ts';
import { systemApi } from '../../src/backend/api/system.ts';
import { stubsApi } from '../../src/backend/api/stubs.ts';
import { ENE_VENDOR_ID } from '../../src/backend/ddc/discovery.ts';
import { MockEneDevice } from '../../src/backend/ambiglow/mock-ene.ts';
import { captureLogger } from '../unit/rpc/helpers.ts';
import { testHost } from '../unit/api/helpers.ts';
import { ENVIRONMENT_DEPENDENT, at, compareJson, formatDiffs, jsonKeyOrders, prefixedOrders, stringifyOrdered, subtreeOrders } from './compare.ts';
import { USER_DISPLAY_KEY, mockEnes, rawTag, storedDisplayContent, vcpWritesSince, writeEditedProfile } from './compose.ts';
import { vendorMenuText } from '../fixtures/effect-menu.ts';
import {
  PROFILE_TAG_SHA256,
  SPEC_STATIC_TAGS,
  WINDOWS_FIXTURES,
  fixtureOrders,
  loggedRequest,
  profileTag,
  readFixture,
  sha256,
  specProfileTag,
  specProfileTagText,
  specReplyEntries,
  specStaticTagHeadings,
  specsPresent,
  type GoldenStep,
} from './golden.ts';
import {
  CONSTRAINTS_NOTIFICATION,
  EFFECT_NOTIFICATION,
  GOLDEN as golden,
  N0,
  PROFILE_FIXTURE,
  Replayer,
  assertBackgroundNotifications,
  assertEffectChange,
  assertMatches,
  assertNotifications,
  goldenStep,
  replayStep,
  subtreeDiffs,
  waitFor,
  withComposedBackend,
} from './replay.ts';

const SYNC_DEVICES_NOTIFICATION = 'NotifyEffectSyncDevicesChange';

// ───────────────────────────── Fixture provenance ─────────────────────────────

test('the golden fixtures are exactly the documented transcript', { skip: !specsPresent() && 'docs/re or the session log is not present' }, () => {
  const tag = profileTag();
  const compact = JSON.stringify(tag);
  assert.equal(Buffer.byteLength(compact), 29403, '20-enum-valuelist-catalog §5: 29403 bytes');
  assert.equal(sha256(compact), PROFILE_TAG_SHA256);
  assert.deepEqual(tag, specProfileTag());
  assert.deepEqual(fixtureOrders(PROFILE_FIXTURE), jsonKeyOrders(specProfileTagText()), 'profile Tag key order as documented');

  const spec = specReplyEntries();
  assert.deepEqual(N0, spec.get('N0')?.value);
  assert.deepEqual(golden.notificationOrders.N0, jsonKeyOrders(spec.get('N0')!.text), 'N0 key order as documented');
  assert.equal(JSON.stringify(N0).length, 1925, '§2.5: N0 is 1925 characters');
  const raw = readFixture<{ steps: GoldenStep[] }>('golden-2026-09-26.json').steps;
  assert.deepEqual(raw.map((s) => s.step), ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '16.1', '16.2', '16.3', '17', '18']);
  raw.forEach((s, i) => {
    const id = String(s.reply.RequestId);
    assert.equal(JSON.parse(s.request).requestId, id, `step ${s.step}: request and reply ids`);
    if (s.log !== 'synthetic') assert.equal(s.request, loggedRequest(id), `step ${s.step}: verbatim request from the log`);
    const documented = spec.get(id);
    if (documented) {
      assert.deepEqual(s.reply, documented.value, `step ${s.step}: reply as documented`);
      assert.deepEqual(golden.steps[i].replyOrder, jsonKeyOrders(documented.text), `step ${s.step}: key order as documented`);
      return;
    }
    // Replies §5 gives only by reference: steps 11/12 and 16.2 carry the 20-enum §5 Tag, 16.1 is the port's
    // DisplayFW_GetDeviceList (like step 4), 16.3 repeats step 13 (LOG:1081-1082, N2 = N0).
    const derivedTag: Record<string, unknown> = {
      '11': { $fixture: PROFILE_FIXTURE },
      '12': { $fixture: PROFILE_FIXTURE },
      '16.1': [],
      '16.2': { $fixture: PROFILE_FIXTURE },
      '16.3': spec.get('cceb3c05-0411-4c8f-b031-eec161ed786e')?.value.Tag,
    };
    assert.ok(Object.hasOwn(derivedTag, s.step), `step ${s.step}: undocumented reply`);
    assert.deepEqual(
      s.reply,
      { err_code: 0, IsSucc: true, err_msg: '', RequestId: id, Tag: derivedTag[s.step], FunctionName: s.functionName, CurrItem: null },
      `step ${s.step}: derived reply`,
    );
  });
  // Steps 11/12/16.2 carry the §5 Profile_GetDeviceData Tag; step 16.3 repeats step 13's Tag (LOG:1081-1082).
  const s13 = goldenStep('13');
  assert.deepEqual(goldenStep('16.3').reply.Tag, s13.reply.Tag);
  assert.deepEqual(s13.reply.Tag, N0.Tag, 'the PHL_GetConstraints Tag equals the N1 notification Tag');
  assert.deepEqual(subtreeOrders(goldenStep('12').replyOrder, 'Tag'), fixtureOrders(PROFILE_FIXTURE), 'the $fixture Tag carries the fixture file key order');
  const macroMenu = JSON.stringify(goldenStep('9').reply.Tag);
  assert.equal(macroMenu.length, 4025, '§5 step 9: Macro_GetFuncMenu Tag is 4025 characters');
  // The static Tags of 20-enum §6 the Effect_* checks compare with: sizes and hashes as the headings give them.
  const headings = specStaticTagHeadings();
  for (const [name, fixture] of Object.entries(SPEC_STATIC_TAGS)) {
    assert.deepEqual(headings.get(fixture.section), { bytes: fixture.bytes, sha256: fixture.sha256 }, `${name}: 20-enum §${fixture.section}`);
  }
});

test('compareJson checks keys, order, types and values, and tolerates only the environment-dependent paths', () => {
  const connect = goldenStep('3').reply;
  const linux = structuredClone(connect) as { Tag: { ExtDeviceInfo: { DisplayList: { DeviceName: string }[] } }[] };
  linux.Tag[0].ExtDeviceInfo.DisplayList[0].DeviceName = 'card1-DP-2';
  assert.deepEqual(compareJson(linux, connect).diffs, []);
  assert.deepEqual(compareJson(linux, connect).tolerated, ['Tag[0].ExtDeviceInfo.DisplayList[0].DeviceName']);

  const tag = profileTag();
  const c = structuredClone(tag) as Record<string, Record<string, Record<string, unknown>>>;
  c.DispalyData.MonitorEDIDInfo_T.ScreenSize = '~34.2"';
  c.DispalyData.MonitorEDIDInfo_T.WhitePoint = 'Wx0.313-Wy0.329';
  assert.deepEqual(compareJson(c, tag).diffs, []);
  c.DispalyData.MonitorEDIDInfo_T.sMonitorName = 'PHL 34M2C8601';
  c.DispalyData.MonitorEDIDInfo_T.DisplayGamma = '2.3';
  assert.deepEqual(compareJson(c, tag).diffs.map((d) => d.path), ['DispalyData.MonitorEDIDInfo_T.sMonitorName', 'DispalyData.MonitorEDIDInfo_T.DisplayGamma']);

  const reordered = { ...Object.fromEntries(Object.entries(tag).reverse()) };
  assert.match(formatDiffs(compareJson(reordered, tag).diffs), /key order/);
  const asString = structuredClone(tag) as Record<string, Record<string, unknown>>;
  asString.OP_DC_DisplayApplication.Value = 'HDRGame';
  assert.match(formatDiffs(compareJson(asString, tag).diffs), /OP_DC_DisplayApplication\.Value: type string/);
  const nulled = structuredClone(tag) as Record<string, Record<string, unknown>>;
  nulled.ModuleInput.InputSourceList = null;
  assert.match(formatDiffs(compareJson(nulled, tag).diffs), /ModuleInput\.InputSourceList: type null/);
  const shortList = structuredClone(tag) as Record<string, Record<string, unknown[]>>;
  shortList.ModuleSmartImageHDR.Items.pop();
  assert.match(formatDiffs(compareJson(shortList, tag).diffs), /ModuleSmartImageHDR\.Items: length 6, expected 7/);
  const renamed = structuredClone(tag) as Record<string, Record<string, Record<string, unknown>[]>>;
  renamed.ModuleSmartImageHDR.Items[1].Text = 'HDR game';
  assert.match(formatDiffs(compareJson(renamed, tag).diffs), /Items\[1\]\.Text/);
  assert.equal(ENVIRONMENT_DEPENDENT.length, 2);
});

test('integer-like keys: the raw texts carry the Dictionary<int,…> insertion order that JSON.parse loses', () => {
  // Newtonsoft writes SubSmartImages in insertion order; JSON.parse lists integer-like keys ascending.
  const vendor = '{"SubSmartImages":{"34":{"A":1},"33":{"A":2}},"Z":0}';
  const sorted = '{"SubSmartImages":{"33":{"A":2},"34":{"A":1}},"Z":0}';
  assert.deepEqual(Object.keys(JSON.parse(vendor).SubSmartImages), ['33', '34'], 'JSON.parse reorders');
  assert.deepEqual(jsonKeyOrders(vendor).get('SubSmartImages'), ['34', '33']);
  assert.deepEqual(compareJson(JSON.parse(sorted), JSON.parse(vendor)).diffs, [], 'parsed values alone cannot see the order');
  const withOrders = compareJson(JSON.parse(sorted), JSON.parse(vendor), [], '', { actual: jsonKeyOrders(sorted), expected: jsonKeyOrders(vendor) });
  assert.match(formatDiffs(withOrders.diffs), /SubSmartImages: key order 33,34, expected 34,33/);
  assert.equal(stringifyOrdered(JSON.parse(vendor), jsonKeyOrders(vendor)), vendor, 'exact bytes rebuilt from the raw order');
  assert.notEqual(JSON.stringify(JSON.parse(vendor)), vendor);
  // Nested paths, escapes, arrays, numbers and literals.
  const tricky = '{ "a\\"b": [ {"k": "x\\\\\\"}"}, {"1": 0, "0": -1.5e3} ], "n": null, "t": true, "u": "\\u00e9" }';
  assert.deepEqual(
    [...jsonKeyOrders(tricky)],
    [
      ['', ['a"b', 'n', 't', 'u']],
      ['a"b[0]', ['k']],
      ['a"b[1]', ['1', '0']],
    ],
  );
  for (const bad of ['{"a":1,}', '{"a" 1}', '[1 2]', '{"a":1} x', '"open']) assert.throws(() => jsonKeyOrders(bad), SyntaxError, bad);
  // The fixtures round-trip: the tokenizer and JSON.parse agree on every value.
  assert.equal(stringifyOrdered(profileTag(), fixtureOrders(PROFILE_FIXTURE)), JSON.stringify(profileTag()));
  // rawTag cuts the Tag bytes out of a reply.
  assert.equal(rawTag('{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"x","Tag":{"A":[1,{"B":null}]},"FunctionName":"F","CurrItem":null}'), '{"A":[1,{"B":null}]}');
});

// ───────────────────────────── Minimal backend: steps owned by system.ts and stubs.ts ─────────────────────────────

test('the golden steps owned by api/system.ts and api/stubs.ts replay byte-exact on a minimal backend', async () => {
  const { log } = captureLogger('backend');
  const backend = createBackend({ host: testHost(log), noHardware: true }, { modules: [systemApi, stubsApi] });
  const notifications: string[] = [];
  backend.onNotification((n) => notifications.push(n));
  for (const step of golden.steps.filter((s) => s.functionName === 'Start' || s.functionName === 'GetPairDevices')) {
    assertMatches(await backend.handleRequest(step.request), step.reply, step.replyOrder, `step ${step.step} ${step.functionName}`);
  }
  assert.deepEqual(notifications, []);
});

/**
 * Harness self-check: a module that answers every golden step with the Windows reply (and raises N0 in
 * PHL_GetConstraints, 20-backend-host-tail §5 step 13) must pass the replay, with a Linux DeviceName and
 * dot decimals exercising the tolerances; and a single wrong type or a missing notification must fail it.
 */
function windowsReplayModule(mutate: (fn: string, tag: unknown) => unknown = (_fn, tag) => tag, notifyConstraints = true): ApiModule {
  return (registry, services) => {
    const seen = new Set<string>();
    for (const step of golden.steps) {
      const fn = step.functionName;
      if (fn === 'Start' || fn === 'GetPairDevices' || seen.has(fn)) continue;
      seen.add(fn);
      const signature = (JSON.parse(step.request).parms ?? []).map((p: unknown) => (typeof p === 'number' ? 'int' : 'string'));
      registry.register(fn, signature, () => {
        if (fn === 'PHL_GetConstraints' && notifyConstraints) services.notifier.notify(CONSTRAINTS_NOTIFICATION, N0.Tag);
        return succ(mutate(fn, structuredClone(step.reply.Tag)));
      });
    }
  };
}

function linuxFlavoured(fn: string, tag: unknown): unknown {
  if (fn.startsWith('Device_')) (tag as { ExtDeviceInfo: { DisplayList: { DeviceName: string }[] } }[])[0].ExtDeviceInfo.DisplayList[0].DeviceName = 'card1-DP-2';
  if (fn === 'Profile_GetDeviceData' || fn === 'PHL_SwitchDisplay') {
    const edid = at(tag, 'DispalyData.MonitorEDIDInfo_T') as Record<string, string>;
    for (const k of ['ScreenSize', 'DisplayGamma', 'RedChromaticity', 'GreenChromaticity', 'BlueChromaticity', 'WhitePoint']) edid[k] = edid[k].replaceAll(',', '.');
  }
  return tag;
}

async function replayAll(module: ApiModule): Promise<void> {
  const { log } = captureLogger('backend');
  const backend = createBackend({ host: testHost(log), noHardware: true }, { modules: [systemApi, stubsApi, module] });
  const notifications: string[] = [];
  backend.onNotification((n) => notifications.push(n));
  const replay = new Replayer(backend, notifications);
  for (const step of golden.steps) await replayStep(replay, step);
  assertBackgroundNotifications(replay);
}

test('harness self-check: a backend answering like Windows passes the replay; deviations fail it', async () => {
  await replayAll(windowsReplayModule(linuxFlavoured));
  await assert.rejects(
    replayAll(windowsReplayModule((fn, tag) => (fn === 'Theme_GetCurTheme' ? { ...(tag as object), IsDefault: 'true' } : tag))),
    /step 8 Theme_GetCurTheme reply differs[\s\S]*Tag\.IsDefault: type string/,
  );
  await assert.rejects(
    replayAll(windowsReplayModule((fn, tag) => (fn === 'Device_GetConnectList' ? (tag as unknown[]).map((d) => ({ ...(d as object), FwVersion: null })) : tag))),
    /Tag\[0\]\.FwVersion: type null/,
  );
  await assert.rejects(replayAll(windowsReplayModule(undefined, false)), /step 13 PHL_GetConstraints: notifications/);
});

// ───────────────────────────── Production composition, golden hardware (no ENE) ─────────────────────────────

const profile = profileTag();
const profileOrder = fixtureOrders(PROFILE_FIXTURE);
const attribute = (path: string, value: number) => ({ ...(at(profile, path) as Record<string, unknown>), Value: value });
const orderOf = (path: string) => subtreeOrders(profileOrder, path);

test('golden transcript 2026-09-26 and the monitor-page flows against the production composition (mock, no ENE)', { timeout: 300_000 }, async (t) => {
  await withComposedBackend(t, {}, async (c) => {
    const { monitors, ambiglow } = c.backend.services;
    const replay = new Replayer(c.backend, c.notifications);
    const userProfile = (name: string) => join(c.serveDataDir, 'Theme', 'User', `${name}.pcenter`);

    await t.test('golden transcript, steps 2-18', async (tt) => {
      for (const step of golden.steps) {
        await tt.test(`step ${step.step}: ${step.functionName}`, () => replayStep(replay, step));
        if (step.step !== '2') continue;
        // No request here, so the replayed sequence stays the user's.
        await tt.test('hardware state of the golden session: the ENE controller is absent (§5 "Setup")', async () => {
          assert.equal(await mockEnes(c), 0, 'EVNIA_MOCK_MONITOR=34M2C8600/no-ene has no ENE MCU on the fake USB bus');
          assert.equal(monitors.current()?.key, USER_DISPLAY_KEY);
          assert.equal(monitors.current()?.ene, undefined);
        });
      }
      assertBackgroundNotifications(replay);
    });

    await t.test('wiring: the monitor manager attached the current display to the ambiglow service and asked it for the ENE', async () => {
      const current = monitors.current();
      assert.ok(current, 'a current display');
      await waitFor(() => ambiglow.display === current, 5000, 'AmbiglowService.attach(<current display>)');
      assert.equal(current.eneModel, '', 'checkEne answered "" during the first read (vendor method_14)');
      assert.equal(ambiglow.ene, null, 'no ENE: the Ambiglow runs over DDC/CI, ENEEffectEnable stays false (golden steps 11/12/16.2)');
    });

    await t.test('03 §5 PHL_SetOSD luminance in HDR: AttributeInfo of the HDR sub-module, the vendor side effect, no constraint change', async () => {
      const lum = 'ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance';
      const set = await replay.rpc('osd-lum-80', 'PHL_SetOSD', ['OP_10_Luminance', 80]);
      assert.equal(set.reply.err_code, 0, String(set.reply.err_msg));
      assert.equal(set.reply.err_msg, '');
      assert.equal(subtreeDiffs(set.text, 'Tag', attribute(lum, 80), orderOf(lum)), '');
      assert.deepEqual(set.during, [], 'luminance does not change the constraints');
      assert.equal(c.hardware().monitor.control(0x10)?.value, 80, 'written to the monitor');

      // The whole Profile_GetDeviceData Tag afterwards = the fixture with exactly the vendor's changes
      // (CDevice_PHLDisplay.cs:1622-1656):
      //  - the HDR sub-module's OP_10_Luminance.Value = 80 (method_29 on ModuleSmartImageHDR.CurSubSmartImage);
      //  - ModuleSmartImage.SubSmartImages[OP_DC 33] = ModuleSmartImage.CurSubSmartImage: the vendor always
      //    stores the SDR sub-module, also in HDR (06 §7.2 "Bug (harmless)"), so the SDR dictionary gains key "33";
      //  - ModuleSmartImageHDR.SubSmartImages["33"] keeps 100: DeviceData is a JSON clone of CacheDeviceData
      //    (CDevice_PHLDisplay.cs:564, Extension_Object.ToCloning), so that entry is not the CurSubSmartImage object.
      const data = await replay.rpc('profile-after-lum', 'Profile_GetDeviceData', [100000]);
      assert.equal(data.reply.err_code, 0, String(data.reply.err_msg));
      const expected = structuredClone(profile) as {
        ModuleSmartImage: { CurSubSmartImage: unknown; SubSmartImages: Record<string, unknown> };
        ModuleSmartImageHDR: { CurSubSmartImage: { OP_10_Luminance: { Value: number } } };
      };
      expected.ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value = 80;
      expected.ModuleSmartImage.SubSmartImages = { '33': structuredClone(expected.ModuleSmartImage.CurSubSmartImage) };
      const expectedOrder = new Map([...profileOrder, ['ModuleSmartImage.SubSmartImages', ['33']]]);
      for (const [p, keys] of prefixedOrders(orderOf('ModuleSmartImage.CurSubSmartImage'), 'ModuleSmartImage.SubSmartImages.33')) expectedOrder.set(p, keys);
      const { diffs } = compareJson(data.reply.Tag, expected, ENVIRONMENT_DEPENDENT, '', { actual: subtreeOrders(jsonKeyOrders(data.text), 'Tag'), expected: expectedOrder });
      assert.equal(formatDiffs(diffs), '', 'Profile_GetDeviceData after PHL_SetOSD(OP_10_Luminance, 80)');

      const back = await replay.rpc('osd-lum-100', 'PHL_SetOSD', ['OP_10_Luminance', 100]);
      assert.equal(subtreeDiffs(back.text, 'Tag', attribute(lum, 100), orderOf(lum)), '');
    });

    await t.test('03 §5 PHL_SetOSD AdaptiveSync: the constraints notification precedes the reply (DisplayFuncConstraints.cs:125-294)', async () => {
      const path = 'ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync';
      const off = await replay.rpc('async-off', 'PHL_SetOSD', ['EXT_OP_E2A0_40_AdaptiveSync', 0]);
      assert.equal(off.reply.err_code, 0, String(off.reply.err_msg));
      assert.equal(subtreeDiffs(off.text, 'Tag', attribute(path, 0), orderOf(path)), '');
      // async=false: MBR = method_2(pip || hz<75 || async) → 1; MBRSync = method_2(pip || !async) → 2.
      const expected = structuredClone(N0) as { Tag: { FuncItems: { FuncId: number; State: number }[] } };
      for (const item of expected.Tag.FuncItems) {
        if (item.FuncId === 0xe2a002) item.State = 1;
        if (item.FuncId === 0xe2a003) item.State = 2;
      }
      assert.equal(off.during.length, 1, 'exactly one notification');
      assert.deepEqual(compareJson(off.during[0], expected, []).diffs, []);
      const on = await replay.rpc('async-on', 'PHL_SetOSD', ['EXT_OP_E2A0_40_AdaptiveSync', 1]);
      assert.equal(subtreeDiffs(on.text, 'Tag', attribute(path, 1), orderOf(path)), '');
      assert.equal(on.during.length, 1);
      assert.deepEqual(compareJson(on.during[0], N0, []).diffs, [], 'back to the user state N0');
    });

    await t.test('03 §5 PHL_SetSmartImage in HDR: {Item1: OP_DC AttributeInfo, Item2: ModuleSmartImageHDR}', async () => {
      const hdr = at(profile, 'ModuleSmartImageHDR') as Record<string, Record<string, unknown>>;
      for (const [value, label] of [[34, 'si-movie'], [33, 'si-game']] as const) {
        const r = await replay.rpc(label, 'PHL_SetSmartImage', [value]);
        assert.equal(r.reply.err_code, 0, String(r.reply.err_msg));
        const orders = jsonKeyOrders(r.text);
        const tag = r.reply.Tag as Record<string, Record<string, unknown>>;
        assert.deepEqual(orders.get('Tag'), ['Item1', 'Item2']);
        assert.equal(subtreeDiffs(r.text, 'Tag.Item1', attribute('OP_DC_DisplayApplication', value), orderOf('OP_DC_DisplayApplication')), '');
        assert.deepEqual(orders.get('Tag.Item2'), profileOrder.get('ModuleSmartImageHDR'));
        assert.equal(subtreeDiffs(r.text, 'Tag.Item2.Items', hdr.Items, orderOf('ModuleSmartImageHDR.Items')), '');
        const cur = tag.Item2.CurSubSmartImage as Record<string, Record<string, unknown>>;
        assert.deepEqual(orders.get('Tag.Item2.CurSubSmartImage'), profileOrder.get('ModuleSmartImageHDR.CurSubSmartImage'));
        for (const [k, attr] of Object.entries(hdr.CurSubSmartImage as Record<string, Record<string, unknown>>)) {
          assert.deepEqual(orders.get(`Tag.Item2.CurSubSmartImage.${k}`), profileOrder.get(`ModuleSmartImageHDR.CurSubSmartImage.${k}`), `${k} keys`);
          assert.equal(cur[k].VCPOpCode, attr.VCPOpCode);
          assert.equal(cur[k].err_code, attr.err_code, `${k} availability`);
        }
        // Dictionary<int, SubModuleSmartImageHDR> in insertion order: "33" from the profile, then "34" (vendor
        // CDevice_PHLDisplay.cs:1692-1695); read from the raw reply, since JSON.parse would sort the keys anyway.
        assert.deepEqual(orders.get('Tag.Item2.SubSmartImages'), ['33', '34'], 'SubSmartImages keyed by DC value, insertion order');
        assert.deepEqual(r.during, [], 'HDR Game ↔ HDR Movie keeps the constraints');
      }
    });

    await t.test('03 §5 PHL_SetInputSource: DisplayModuleInput with the vendor InputSourceInfo and the packed 0x60 value', async () => {
      const input = at(profile, 'ModuleInput') as Record<string, unknown>;
      const r = await replay.rpc('input-dp1', 'PHL_SetInputSource', [15, 34, 0, 0, 0]);
      assert.equal(r.reply.err_code, 0, String(r.reply.err_msg));
      assert.deepEqual(jsonKeyOrders(r.text).get('Tag'), profileOrder.get('ModuleInput'));
      for (const list of ['InputSourceList', 'PIPPBPSourceList', 'PIPLocationList']) {
        assert.equal(subtreeDiffs(r.text, `Tag.${list}`, input[list], orderOf(`ModuleInput.${list}`)), '', list);
      }
      // InputSourceInfo {Mode, Size, Location, PIPPBPSource, InputSource} — declaration order and values.
      assert.equal(
        subtreeDiffs(r.text, 'Tag.InputSourceInfo', { Mode: 0, Size: 0, Location: 0, PIPPBPSource: 34, InputSource: 15 }, orderOf('ModuleInput.InputSourceInfo')),
        '',
      );
      for (const k of ['OP_ED_InputAuto', 'OP_A5_WindowSelect', 'OP_EC_PIPPBPSizeLocation', 'OP_F6_PIPPBPSwap']) {
        assert.equal(subtreeDiffs(r.text, `Tag.${k}`, input[k], orderOf(`ModuleInput.${k}`)), '', k);
      }
      // The stored InputSourceInfo already is (15, 34, 0, 0, 0), so the vendor takes the else-if branch: the
      // stored 0x60 value 15 differs from the packed BitConverter.ToInt32([15, 34, 0, 0]) = 15 | 34 << 8 =
      // 8719, which it writes and returns (CDevice_PHLDisplay.cs:1888-1938, lines 1925-1933).
      assert.equal(
        subtreeDiffs(r.text, 'Tag.OP_60_InputSource', attribute('ModuleInput.OP_60_InputSource', 15 | (34 << 8)), orderOf('ModuleInput.OP_60_InputSource')),
        '',
      );
      assert.equal(at(r.reply.Tag, 'OP_60_InputSource.Value'), 8719);
      assert.deepEqual(r.during, [], 'no PIP change, no constraint change');
    });

    await t.test('Effect_GetMenu without ENE: DisplayEffectMenu.Default("") byte for byte (20-enum §6.2)', async () => {
      const r = await replay.rpc('menu-no-ene', 'Effect_GetMenu', [100000]);
      assert.equal(r.reply.err_code, 0, String(r.reply.err_msg));
      const tag = rawTag(r.text);
      assert.equal(Buffer.byteLength(tag), SPEC_STATIC_TAGS.effectMenuNoEne.bytes);
      assert.equal(sha256(tag), SPEC_STATIC_TAGS.effectMenuNoEne.sha256);
      assert.deepEqual(r.during, []);
    });

    await t.test('PHL_SetOSD is persisted: Profile_GetDeviceData, the stored .pcenter section and Theme_GetDevicesBasicInfo follow it', async () => {
      const path = 'ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync';
      const off = await replay.rpc('persist-async-off', 'PHL_SetOSD', ['EXT_OP_E2A0_40_AdaptiveSync', 0]);
      assert.equal(off.reply.err_code, 0, String(off.reply.err_msg));
      assert.deepEqual(off.during.map((n) => n.FunctionName), [CONSTRAINTS_NOTIFICATION]);
      const data = await replay.rpc('persist-profile', 'Profile_GetDeviceData', [100000]);
      assert.equal(at(data.reply.Tag, `${path}.Value`), 0, 'DeviceData');
      // Theme_GetDevicesBasicInfo reads the stored profile from disk, after writing the pending (debounced)
      // participant save (SO smethod_22; impl-theme §3.3): AdaptiveSync "Off", the rest as in golden step 18.
      const basic = await replay.rpc('persist-basic', 'Theme_GetDevicesBasicInfo', [-1]);
      const expected = structuredClone(goldenStep('18').reply.Tag) as { Display: { AdaptiveSync: string }[] };
      expected.Display[0].AdaptiveSync = 'Off';
      assert.equal(formatDiffs(compareJson(basic.reply.Tag, expected).diffs), '', 'BasicInfo_Display from the stored profile');
      const stored = storedDisplayContent(userProfile('Default'));
      assert.equal(at(stored, `${path}.Value`), 0, 'the Default.pcenter ProfileContent carries the change');
      assert.equal(at(stored, 'OP_DC_DisplayApplication.Value'), 33);
      // And back: the user's state again, golden step 18 byte for byte from the file.
      const on = await replay.rpc('persist-async-on', 'PHL_SetOSD', ['EXT_OP_E2A0_40_AdaptiveSync', 1]);
      assert.equal(on.reply.err_code, 0, String(on.reply.err_msg));
      await replayStep(replay, goldenStep('18'));
      assert.equal(at(storedDisplayContent(userProfile('Default')), `${path}.Value`), 1);
    });

    await t.test('Theme_Switch re-applies the SmartImage/HDR group and the Ambiglow of the target profile (20-theme §5.5, §6)', async () => {
      const hw = c.hardware();
      const onlyConstraints = (during: Record<string, any>[]) => assert.deepEqual([...new Set(during.map((n) => n.FunctionName))].filter((n) => n !== CONSTRAINTS_NOTIFICATION), []);

      // A same-content profile (a copy of the current state, HDR Game): no DC write; the HDR group forced
      // (0x10 = 100, 0x12 = 50; E2A03D/3E/3F unsupported); Ambiglow off → E2A019 = 0. The "3 writes" of 20-theme §6.
      assert.equal((await replay.rpc('theme-copy', 'Theme_CopyProfile', ['User', 'Default', 'Copy'])).reply.err_code, 0);
      let mark = hw.monitor.frames.length;
      const toCopy = await replay.rpc('theme-to-copy', 'Theme_Switch', ['User', 'Copy']);
      assert.equal(toCopy.reply.err_code, 0, String(toCopy.reply.err_msg));
      assert.deepEqual([toCopy.reply.Tag.Name, toCopy.reply.Tag.SelProfileName], ['User', 'Copy']);
      assert.deepEqual(vcpWritesSince(hw, mark), [
        { code: 0x10, value: 100 },
        { code: 0x12, value: 50 },
        { code: 0xe2a019, value: 0 },
      ]);
      assert.deepEqual(toCopy.during, []);

      // A profile exported on Windows with HDR Movie, luminance 60 and the monitor's Ambiglow on in
      // FollowVideo, imported (the user's file format: BOM, one line) and switched to.
      const exported = join(c.scratchDir, 'Movie.pcenter');
      writeEditedProfile(join(WINDOWS_FIXTURES, 'EvniaServe', 'Theme', 'User', 'Default.pcenter'), exported, (content) => {
        content.OP_DC_DisplayApplication.Value = 34;
        content.ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value = 60;
        content.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value = 1;
        content.ModuleAmbiglow.EffectEnable = true;
      });
      mark = hw.monitor.frames.length;
      const imported = await replay.rpc('theme-import', 'Theme_ImportProfile', ['User', exported, false]);
      assert.equal(imported.reply.err_code, 0, String(imported.reply.err_msg));
      assert.ok(imported.reply.Tag.find((th: { Name: string }) => th.Name === 'User').ProfileNames.includes('Movie'));
      assert.deepEqual(vcpWritesSince(hw, mark), [], 'importing a profile that is not current writes nothing');

      // DC first (+1000 ms, method_10), the HDR group forced, then the Ambiglow (method_12): E2A019 = the
      // profile's mode, E2A01A..1E only where they differ from the monitor's (here none).
      mark = hw.monitor.frames.length;
      const toMovie = await replay.rpc('theme-to-movie', 'Theme_Switch', ['User', 'Movie']);
      assert.equal(toMovie.reply.err_code, 0, String(toMovie.reply.err_msg));
      assert.equal(toMovie.reply.Tag.SelProfileName, 'Movie');
      assert.deepEqual(vcpWritesSince(hw, mark), [
        { code: 0xdc, value: 34 },
        { code: 0x10, value: 60 },
        { code: 0x12, value: 50 },
        { code: 0xe2a019, value: 1 },
      ]);
      assert.deepEqual([hw.monitor.control(0xdc)?.value, hw.monitor.control(0x10)?.value, hw.monitor.control(0xe2a019)?.value], [34, 60, 1]);
      onlyConstraints(toMovie.during);
      const movie = await replay.rpc('theme-movie-data', 'Profile_GetDeviceData', [100000]);
      assert.equal(at(movie.reply.Tag, 'OP_DC_DisplayApplication.Value'), 34);
      assert.equal(at(movie.reply.Tag, 'ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value'), 60);
      assert.deepEqual(jsonKeyOrders(movie.text).get('Tag.ModuleSmartImageHDR.SubSmartImages'), ['33', '34'], "the profile's entry, then the applied DC");
      assert.deepEqual([at(movie.reply.Tag, 'ModuleAmbiglow.EffectEnable'), at(movie.reply.Tag, 'ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value')], [true, 1]);

      // Back to Default: HDR Game, luminance 100, Ambiglow off (E2A019 = 0).
      mark = hw.monitor.frames.length;
      const back = await replay.rpc('theme-to-default', 'Theme_Switch', ['User', 'Default']);
      assert.equal(back.reply.err_code, 0, String(back.reply.err_msg));
      assert.equal(back.reply.Tag.SelProfileName, 'Default');
      assert.deepEqual(vcpWritesSince(hw, mark), [
        { code: 0xdc, value: 33 },
        { code: 0x10, value: 100 },
        { code: 0x12, value: 50 },
        { code: 0xe2a019, value: 0 },
      ]);
      assert.deepEqual([hw.monitor.control(0xdc)?.value, hw.monitor.control(0x10)?.value, hw.monitor.control(0xe2a019)?.value], [33, 100, 0]);
      onlyConstraints(back.during);

      // DeviceData: Default's SmartImage/HDR group and EffectInfo (copied from the profile without ENE); the
      // Ambiglow off is shown as StaticMode (7), as at load.
      const data = await replay.rpc('theme-profile', 'Profile_GetDeviceData', [100000]);
      assert.equal(at(data.reply.Tag, 'OP_DC_DisplayApplication.Value'), 33);
      assert.equal(at(data.reply.Tag, 'IsSmartImageHDR'), true);
      assert.equal(subtreeDiffs(data.text, 'Tag.ModuleSmartImageHDR.CurSubSmartImage', at(profile, 'ModuleSmartImageHDR.CurSubSmartImage'), orderOf('ModuleSmartImageHDR.CurSubSmartImage')), '');
      // Default's stored dictionary ("34" joined it in the PHL_SetSmartImage flow above), with the applied DC
      // 33 keeping its place (dict[k] = v, CDevice_PHLDisplay.cs:669-671).
      assert.deepEqual(jsonKeyOrders(data.text).get('Tag.ModuleSmartImageHDR.SubSmartImages'), ['33', '34'], "Default's SubSmartImages");
      assert.equal(subtreeDiffs(data.text, 'Tag.EffectInfo', at(profile, 'EffectInfo'), orderOf('EffectInfo')), '');
      assert.equal(subtreeDiffs(data.text, 'Tag.ModuleAmbiglow', at(profile, 'ModuleAmbiglow'), orderOf('ModuleAmbiglow')), '');
      assert.equal(at(data.reply.Tag, 'ENEEffectEnable'), false);
      await replayStep(replay, goldenStep('13')); // the user's constraints again: N1 = N0

      // The profiles on disk: the state saved into each (the save pending at a switch goes to the profile
      // being left, impl-theme §3.0).
      const stored = storedDisplayContent(userProfile('Movie'));
      assert.deepEqual([at(stored, 'OP_DC_DisplayApplication.Value'), at(stored, 'ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance.Value')], [34, 60]);
      assert.equal(at(storedDisplayContent(userProfile('Default')), 'OP_DC_DisplayApplication.Value'), 33);

      // Remove the extra profiles: the theme index is the user's again (golden steps 5 and 8, byte for byte).
      for (const name of ['Copy', 'Movie']) assert.equal((await replay.rpc(`theme-del-${name}`, 'Theme_DelProfile', ['User', name])).reply.err_code, 0);
      await replayStep(replay, goldenStep('5'));
      await replayStep(replay, goldenStep('8'));
    });

    await t.test('PHL_GetConstraints still sends N1 = N0 before its reply after the flows', async () => {
      const step = goldenStep('13');
      const { reply, during } = await replay.call('constraints-final', step.request);
      assertMatches(reply, step.reply, step.replyOrder, 'PHL_GetConstraints reply');
      assertNotifications(step, during);
    });
  });
});

// ───────────────────────────── Production composition with the simulated ENE ─────────────────────────────

test('ENE present: ENE mode from the first read, Effect_* round trips on the MCU, theme switch, ENE unplug/replug', { timeout: 180_000 }, async (t) => {
  // Not the user's session (§5 has no ENE): the simulated ENE MCU stays on USB 3-2.1, next to the VIA bridge.
  await withComposedBackend(t, { ene: true }, async (c) => {
    const { monitors, ambiglow } = c.backend.services;
    const replay = new Replayer(c.backend, c.notifications);
    const userProfile = (name: string) => join(c.serveDataDir, 'Theme', 'User', `${name}.pcenter`);
    const start = goldenStep('2');
    assertMatches((await replay.call('ene-start', start.request)).reply, start.reply, start.replyOrder, 'Start with the ENE present');
    const hw = c.hardware();
    assert.equal(await mockEnes(c), 1);
    const display = monitors.current();
    assert.ok(display);
    assert.equal(display.key, USER_DISPLAY_KEY);
    assert.equal(display.ene?.vendorId, ENE_VENDOR_ID, 'discovery paired the ENE with the monitor (same hub)');
    const ene = () => hw.ene.state();

    await t.test('the first Profile_GetDeviceData is in ENE mode (checkEne during the first read, 20-backend-host-tail §6 item 4)', async () => {
      const data = await replay.rpc('ene-profile', 'Profile_GetDeviceData', [100000]);
      assert.equal(data.reply.err_code, 0, String(data.reply.err_msg));
      assert.equal(data.reply.Tag.ENEEffectEnable, true);
      assert.equal(data.reply.Tag.EffectInfo.CurrEffect.Name, 'FollowVideo', 'the stored EffectInfo is kept (method_12 ENE branch)');
      await waitFor(() => ambiglow.display === display, 5000, 'AmbiglowService.attach(<display with ENE>)');
      await ambiglow.settled();
      assert.equal(display.eneModel, '34M2C8600', 'CUSBENE6K7732.GetModelName("PHL 34M2C8600")');
      assert.equal(ene().hostControl, 4, 'the host drives the LEDs (0x0023 = 4)');
      assert.equal(ene().groups[1]?.mode, 0x0e, 'the stored FollowVideo pushed (09 §6.3)');
      assert.deepEqual(hw.ene.violations, []);
      assert.deepEqual([...data.during, ...replay.drain()].filter((n) => n.FunctionName === EFFECT_NOTIFICATION), [], 'no plug notification at load (vendor: only on a USB change)');
    });

    await t.test('Effect_GetMenu with the ENE: DisplayEffectMenu.Default("34M2C8600") byte for byte (20-enum §6.1) except the FollowVideo Speed slider (impl-ambiglow deviation 17)', async () => {
      const r = await replay.rpc('ene-menu', 'Effect_GetMenu', [100000]);
      assert.equal(r.reply.err_code, 0, String(r.reply.err_msg));
      const tag = vendorMenuText(rawTag(r.text));
      assert.equal(Buffer.byteLength(tag), SPEC_STATIC_TAGS.effectMenuEne.bytes);
      assert.equal(sha256(tag), SPEC_STATIC_TAGS.effectMenuEne.sha256);
    });

    await t.test('Effect_Change / ColorChange / BrightnessChange / SpeedChange: EffectInfo replies, ParameterSet on the MCU, persisted', async () => {
      const effectInfoOrder = jsonKeyOrders(JSON.stringify(profile.EffectInfo)).get('');
      const change = await replay.rpc('ene-static', 'Effect_Change', [100000, 7]);
      assert.equal(change.reply.err_code, 0, String(change.reply.err_msg));
      assert.deepEqual(jsonKeyOrders(change.text).get('Tag'), effectInfoOrder, 'Tag: DisplayEffectInfo in declaration order');
      assert.deepEqual(change.reply.Tag.CurrEffect, { Name: 'Static', Text: '恒亮模式', Value: 7 });
      assert.equal(ene().groups[1]?.mode, 0x02, 'the stored Static detail is rainbow: StaticModeRainbow');
      const leds = await replay.rpc('ene-leds', 'Effect_GetLEDs', [100000]);
      assert.deepEqual([leds.reply.err_code, leds.reply.err_msg], [9, 'not ene follow video or audio'], 'no LED preview outside FollowVideo/FollowAudio');

      const color = await replay.rpc('ene-color', 'Effect_ColorChange', [100000, 255, 0, 0]);
      assert.equal(color.reply.err_code, 0, String(color.reply.err_msg));
      assert.deepEqual(color.reply.Tag.EffectDetail.CurRGB, { R: 255, G: 0, B: 0 });
      assert.equal(color.reply.Tag.EffectDetail.IsRainbowColor, false);
      assert.equal(ene().groups[1]?.mode, 0x01, 'StaticMode');
      assert.deepEqual(ene().groups[1]?.color, [255, 0, 0]);

      const bright = await replay.rpc('ene-bright', 'Effect_BrightnessChange', [100000, 1]);
      assert.equal(bright.reply.Tag.EffectDetail.Brightness, 1);
      assert.equal(ene().groups[1]?.brightness, 0x04, 'Bright = 0x04 (09 §5.2)');
      const speed = await replay.rpc('ene-speed', 'Effect_SpeedChange', [100000, 3]);
      assert.equal(speed.reply.Tag.EffectDetail.Speed, 3);
      assert.deepEqual(hw.ene.violations, []);

      // Persisted: with an ENE, BasicInfo_Display.LightMode is EffectInfo.CurrEffect.Name of the stored profile.
      const basic = await replay.rpc('ene-basic', 'Theme_GetDevicesBasicInfo', [-1]);
      assert.equal(basic.reply.Tag.Display[0].LightMode, 'Static');
      const stored = storedDisplayContent(userProfile('Default'));
      assert.equal(at(stored, 'EffectInfo.CurrEffect.Name'), 'Static');
    });

    await t.test('Effect_Enable(false/true): the LEDs go back to the monitor firmware (0x0023 = 0) and return', async () => {
      const off = await replay.rpc('ene-off', 'Effect_Enable', [100000, false]);
      assert.deepEqual([off.reply.err_code, off.reply.Tag], [0, false]);
      assert.equal(ene().hostControl, 0);
      const on = await replay.rpc('ene-on', 'Effect_Enable', [100000, true]);
      assert.deepEqual([on.reply.err_code, on.reply.Tag], [0, true]);
      assert.equal(ene().hostControl, 4);
      assert.equal(ene().groups[1]?.mode, 0x01, 'the red Static effect again');
    });

    await t.test("Theme_Switch with the ENE pushes the target profile's EffectInfo to the MCU (method_12 ENE branch → method_17)", async () => {
      assert.equal((await replay.rpc('ene-copy', 'Theme_CopyProfile', ['User', 'Default', 'Movie'])).reply.err_code, 0);
      const toMovie = await replay.rpc('ene-to-movie', 'Theme_Switch', ['User', 'Movie']);
      assert.equal(toMovie.reply.Tag.SelProfileName, 'Movie');
      const follow = await replay.rpc('ene-follow', 'Effect_Change', [100000, 1]);
      assert.equal(follow.reply.Tag.CurrEffect.Name, 'FollowVideo');
      assert.equal(ene().groups[1]?.mode, 0x0e);

      const back = await replay.rpc('ene-to-default', 'Theme_Switch', ['User', 'Default']);
      assert.equal(back.reply.Tag.SelProfileName, 'Default');
      await ambiglow.settled();
      assert.equal(ene().groups[1]?.mode, 0x01, "Default's red Static effect is back on the LEDs");
      assert.deepEqual(ene().groups[1]?.color, [255, 0, 0]);
      const data = await replay.rpc('ene-after-switch', 'Profile_GetDeviceData', [100000]);
      assert.equal(data.reply.Tag.EffectInfo.CurrEffect.Name, 'Static');
      assert.equal(data.reply.Tag.ENEEffectEnable, true);
      assert.equal(at(storedDisplayContent(userProfile('Movie')), 'EffectInfo.CurrEffect.Name'), 'FollowVideo');
      assert.equal((await replay.rpc('ene-del', 'Theme_DelProfile', ['User', 'Movie'])).reply.err_code, 0);
    });

    await t.test('Effect_Reset with the ENE: NotifyEffectSyncDevicesChange first, then DisplayEffectInfo.Default (20-enum §6.3 byte for byte)', async () => {
      const r = await replay.rpc('ene-reset', 'Effect_Reset', [100000]);
      assert.equal(r.reply.err_code, 0, String(r.reply.err_msg));
      assert.deepEqual(r.during.map((n) => n.FunctionName), [SYNC_DEVICES_NOTIFICATION]);
      assert.deepEqual(r.during[0].Tag, { EffectDetailInfo: null, SyncDevices: [] }, "the raw Sync_Profile of the user's profile (20-backend-host-tail §2.5)");
      const tag = rawTag(r.text);
      assert.equal(Buffer.byteLength(tag), SPEC_STATIC_TAGS.effectInfoDefault.bytes);
      assert.equal(sha256(tag), SPEC_STATIC_TAGS.effectInfoDefault.sha256);
      assert.equal(ene().groups[1]?.mode, 0x02, 'Static rainbow');
      assert.deepEqual(ene().groups[1]?.color, [0, 0, 255], 'blue');
      // SyncEffect_GetData lists the display while its ENE drives an effect (smethod_11).
      const sync = await replay.rpc('ene-sync', 'SyncEffect_GetData');
      assert.deepEqual(
        sync.reply.Tag.SyncDevices.map((d: { DeviceType: number; ModelName: string }) => [d.DeviceType, d.ModelName]),
        [[100000, 'PHL 34M2C8600']],
      );
    });

    await t.test('ENE unplug and replug: Device_DetectionUSB lists the monitor, NotifyUIDisplayEffectChange reports ENEEnable false, then true', async () => {
      const step3 = goldenStep('3');
      const deviceList = (label: string) => ({ ...step3.reply, RequestId: `contract-${label}`, FunctionName: 'Device_DetectionUSB' });
      const effectChanges = (during: Record<string, any>[]) => during.filter((n) => n.FunctionName === EFFECT_NOTIFICATION);
      const others = (during: Record<string, any>[]) => during.filter((n) => n.FunctionName !== EFFECT_NOTIFICATION && n.FunctionName !== CONSTRAINTS_NOTIFICATION);

      let mark = hw.monitor.frames.length;
      hw.usb.detach(hw.eneInfo!);
      c.backend.hotplug('usb'); // the host's debounced USBChange (01 §9); the renderer then calls Device_DetectionUSB
      const lost = await replay.rpc('ene-unplug', 'Device_DetectionUSB');
      assertMatches(lost.text, deviceList('ene-unplug'), step3.replyOrder, 'Device_DetectionUSB after the ENE unplug');
      assert.equal(effectChanges(lost.during).length, 1, 'exactly one NotifyUIDisplayEffectChange (method_15)');
      assert.deepEqual(others(lost.during), []);
      assertEffectChange(effectChanges(lost.during)[0], false, 'ENE unplug');
      assert.deepEqual(vcpWritesSince(hw, mark), [{ code: 0xe2a019, value: 0 }], 'the DDC Ambiglow takes over, off as in the profile');
      assert.equal(await mockEnes(c), 0);
      const gone = await replay.rpc('ene-gone', 'Profile_GetDeviceData', [100000]);
      assert.equal(gone.reply.Tag.ENEEffectEnable, false);
      assert.deepEqual(effectChanges(lost.during)[0].Tag.EffectInfo, gone.reply.Tag.EffectInfo, "the notification carries the display's EffectInfo");
      assert.deepEqual(effectChanges(lost.during)[0].Tag.ModuleAmbiglow, gone.reply.Tag.ModuleAmbiglow);
      const refused = await replay.rpc('ene-refused', 'Effect_Change', [100000, 7]);
      assert.deepEqual([refused.reply.err_code, refused.reply.err_msg], [9, 'Not Support ENE']);

      // The MCU powers up again (fresh registers) on the same port.
      const fresh = new MockEneDevice();
      hw.usb.attach(fresh.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 19 }));
      mark = hw.monitor.frames.length;
      c.backend.hotplug('usb');
      const back = await replay.rpc('ene-replug', 'Device_DetectionUSB');
      assertMatches(back.text, deviceList('ene-replug'), step3.replyOrder, 'Device_DetectionUSB after the ENE replug');
      assert.equal(effectChanges(back.during).length, 1, 'exactly one NotifyUIDisplayEffectChange (method_14 with bUsbChange)');
      assert.deepEqual(others(back.during), []);
      assertEffectChange(effectChanges(back.during)[0], true, 'ENE replug');
      await ambiglow.settled();
      assert.equal(fresh.state().hostControl, 4, 'the effect is pushed to the replugged MCU');
      assert.deepEqual(fresh.violations, []);
      assert.deepEqual(vcpWritesSince(hw, mark), [], 'no DDC Ambiglow write while the ENE drives the LEDs');
      const again = await replay.rpc('ene-back', 'Profile_GetDeviceData', [100000]);
      assert.equal(again.reply.Tag.ENEEffectEnable, true);
      assert.equal((await replay.rpc('ene-works', 'Effect_Change', [100000, 7])).reply.err_code, 0);
      assert.equal(fresh.state().groups[1]?.mode, 0x02);
    });
  });
});
