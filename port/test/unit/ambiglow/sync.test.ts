// Sync_Profile logic: SyncEffect_GetData (smethod_11) and SyncEffect_EnableDevice, pure (sync.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialize } from '../../../src/backend/core/json.ts';
import { syncProfileJson, type SyncProfileModel } from '../../../src/backend/theme/formats.ts';
import {
  canBreathingSync,
  enableSyncDevices,
  isInEffectSync,
  normalizeSyncProfile,
  parseSelDevices,
  parseSyncProfile,
  removeSyncDevice,
  syncEffectData,
  type SyncDisplayRef,
} from '../../../src/backend/ambiglow/sync.ts';

/** 20-backend-host-tail §5 step 6 / §3.1 Tag. */
const GOLDEN_STEP6_TAG =
  '{"EffectDetailInfo":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":2,"Brightness":2,"IsRandomColor":false,"IsRainbowColor":false,"CurRGB":{"R":255,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"SyncDevices":[]}';

const DISPLAY: SyncDisplayRef = { EquipmentType: 1, DeviceType: 100000, ModelName: 'PHL 34M2C8600' };
const staticDetail = { Effect: { Name: 'Static', Text: '恒亮模式', Value: 7 }, Speed: 2, Brightness: 3, IsRandomColor: false, IsRainbowColor: true, CurRGB: { R: 0, G: 0, B: 255 }, BgRGB: { R: 0, G: 0, B: 0 }, CurDir: -1, CurRegion: 0, CurStarCount: 1 };
const entry = (DeviceType: number, ModelName: string, SyncStatus: boolean, Connect = true) => ({ SyncStatus, Connect, EquipmentType: DeviceType === 100000 ? 1 : 2, DeviceType, ModelName, ExtModel: null });
const stored = (json: unknown): SyncProfileModel => parseSyncProfile(json)!;

test('SyncEffect_GetData on the user\'s profile without ENE = golden step 6 (Check() default detail, no display)', () => {
  const { tag, storedChanged } = syncEffectData(stored({ EffectDetailInfo: null, SyncDevices: [] }), null);
  assert.equal(serialize(syncProfileJson(tag), 'ui'), GOLDEN_STEP6_TAG);
  assert.equal(storedChanged, false);
  assert.equal(serialize(syncProfileJson(syncEffectData(null, null).tag), 'ui'), GOLDEN_STEP6_TAG, 'a profile without Sync_Profile answers the same');
});

test('smethod_11 lists the display (ENE in use) as connected, SyncStatus false; peripherals are dropped', () => {
  const { tag } = syncEffectData(null, DISPLAY);
  assert.deepEqual(syncProfileJson(tag)?.SyncDevices, [{ SyncStatus: false, Connect: true, EquipmentType: 1, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: null }]);
  const s = stored({ EffectDetailInfo: staticDetail, SyncDevices: [entry(200000, 'SPK8708', true), entry(100000, 'PHL 34M2C8600', true, false), entry(100000, 'PHL 27M2N8500', true)] });
  const n = normalizeSyncProfile(s, DISPLAY);
  assert.deepEqual(n.SyncDevices.map((d) => d?.ModelName), ['PHL 34M2C8600'], 'keyboard not connected, the other monitor not current');
  assert.equal(n.SyncDevices[0]?.Connect, true);
  assert.equal(n.EffectDetailInfo?.Effect?.Name, 'Static', 'Check() keeps the detail while the stored group is not empty');
  assert.equal(s.SyncDevices.length, 3, 'the stored profile is not modified by the normalization');
});

test('with at most one synced device left, SyncStatus is cleared in the reply and in the stored profile', () => {
  const s = stored({ EffectDetailInfo: staticDetail, SyncDevices: [entry(100000, 'PHL 34M2C8600', true), entry(200000, 'SPK8708', true)] });
  const { tag, storedChanged } = syncEffectData(s, DISPLAY);
  assert.equal(storedChanged, true);
  assert.deepEqual(s.SyncDevices.map((d) => d?.SyncStatus), [false, false]);
  assert.deepEqual(tag.SyncDevices.map((d) => d?.SyncStatus), [false]);
});

test('IsInEffectSync / IsCanBreathingSync / RemoveAll on the stored group', () => {
  const s = stored({ EffectDetailInfo: staticDetail, SyncDevices: [entry(100000, 'PHL 34M2C8600', true), entry(200000, 'SPK8708', true)] });
  assert.equal(isInEffectSync(s, DISPLAY), true);
  assert.equal(canBreathingSync(s, DISPLAY), true, 'in sync and more than one stored entry (connected or not)');
  assert.equal(isInEffectSync(s, { ...DISPLAY, ModelName: 'PHL 34m2c8600' }), false, 'model names compare ordinally');
  assert.equal(removeSyncDevice(s, 100000, 'PHL 34M2C8600'), true);
  assert.equal(canBreathingSync(s, DISPLAY), false);
  assert.equal(removeSyncDevice(s, 100000, 'PHL 34M2C8600'), false);
  assert.equal(canBreathingSync(null, DISPLAY), false);
});

test('SyncEffect_EnableDevice errors are the vendor texts', () => {
  const base = { selDevices: '[]', stored: stored({ EffectDetailInfo: null, SyncDevices: [] }), effectDetail: null, equipmentTypeOf: () => 1 };
  assert.deepEqual(pick(enableSyncDevices({ ...base, device: 100000, display: null })), ['error', 'device=PHL_CDeviceDisplay un connected']);
  assert.deepEqual(pick(enableSyncDevices({ ...base, device: 200000, display: DISPLAY })), ['error', 'device=RongYuan_KeyboardSPK8708 un connected']);
  assert.deepEqual(pick(enableSyncDevices({ ...base, device: 123, display: DISPLAY })), ['error', 'device=123 un connected']);
  assert.deepEqual(pick(enableSyncDevices({ ...base, device: 100000, display: DISPLAY })), ['error', 'Input device=100000 EffectDetail is null']);
  const nullProfile = enableSyncDevices({ ...base, stored: null, device: 100000, display: DISPLAY });
  assert.equal(nullProfile.storeChanged, true, 'Sync_Profile = new T_Sync_Profile() is kept even after the error');
  assert.deepEqual(syncProfileJson(nullProfile.store), { EffectDetailInfo: null, SyncDevices: [] });
  const bad = enableSyncDevices({ ...base, device: 100000, display: DISPLAY, effectDetail: parseDetail(staticDetail), selDevices: 'nope' });
  assert.equal(bad.kind === 'error' && bad.nullReference, true, 'invalid JSON → null list → NullReferenceException');
});

test('SyncEffect_EnableDevice with only the display: a one-device group is not stored (different effect)', () => {
  const detail = parseDetail(staticDetail);
  const out = enableSyncDevices({
    device: 100000,
    display: DISPLAY,
    effectDetail: detail,
    selDevices: JSON.stringify([{ DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtValue: '' }]),
    stored: stored({ EffectDetailInfo: null, SyncDevices: [] }),
    equipmentTypeOf: (t) => (t === 100000 ? 1 : undefined),
  });
  assert.equal(out.kind, 'ok');
  assert.equal(out.storeChanged, false, 'Count ≤ 1: no Effect_Sync, nothing stored');
  if (out.kind !== 'ok') return;
  assert.equal(out.tag.EffectDetailInfo?.Effect?.Name, 'Static');
  assert.deepEqual(out.tag.SyncDevices.map((d) => [d?.ModelName, d?.SyncStatus, d?.Connect]), [['PHL 34M2C8600', true, true]]);
});

test('SyncEffect_EnableDevice with the same effect rebuilds the group and stores it', () => {
  const detail = parseDetail(staticDetail);
  const out = enableSyncDevices({
    device: 100000,
    display: DISPLAY,
    effectDetail: detail,
    selDevices: JSON.stringify([
      { DeviceType: 100000, ModelName: 'PHL 34M2C8600' },
      { DeviceType: 'RongYuan_MouseSPK9708', ModelName: 'SPK9708' },
      { DeviceType: 999, ModelName: 'X' },
    ]),
    stored: stored({ EffectDetailInfo: staticDetail, SyncDevices: [entry(200000, 'SPK8708', true), entry(100000, 'PHL 34M2C8600', false)] }),
    equipmentTypeOf: (t) => ({ 100000: 1, 300000: 3 })[t as 100000 | 300000],
  });
  assert.equal(out.kind, 'ok');
  if (out.kind !== 'ok') return;
  assert.equal(out.storeChanged, true);
  assert.deepEqual(
    out.store?.SyncDevices.map((d) => [d?.DeviceType, d?.SyncStatus, d?.Connect]),
    [[100000, true, false], [300000, true, false]],
    'keyboard removed (not selected), unknown type skipped, smethod_10 leaves Connect false',
  );
  assert.deepEqual(out.tag.SyncDevices.map((d) => [d?.DeviceType, d?.SyncStatus, d?.Connect]), [[100000, true, true]], 'smethod_11: the mouse is not connected');
});

test('parseSelDevices: Newtonsoft List<DeviceInfoBase> (enum names or numbers; invalid → null)', () => {
  assert.deepEqual(parseSelDevices('[{"DeviceType":"PHL_CDeviceDisplay","ModelName":"PHL 34M2C8600","ExtValue":""}]'), [{ DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtValue: '' }]);
  assert.deepEqual(parseSelDevices('[null]'), [null]);
  assert.equal(parseSelDevices('{}'), null);
  assert.equal(parseSelDevices('[{"DeviceType":"Nope"}]'), null);
});

function pick(o: ReturnType<typeof enableSyncDevices>): [string, string | null] {
  return [o.kind, o.kind === 'error' ? o.msg : null];
}

function parseDetail(json: unknown) {
  return parseSyncProfile({ EffectDetailInfo: json, SyncDevices: [] })!.EffectDetailInfo!;
}
