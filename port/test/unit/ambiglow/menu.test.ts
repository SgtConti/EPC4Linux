// Effect_GetMenu: DisplayEffectMenu.Default(model) against the byte-exact fixtures of
// 20-enum-valuelist-catalog §6.1 (ENE "34M2C8600") and §6.2 (no ENE, ""), and the one deliberate deviation of
// the served ENE menu: the FollowVideo item's Speed and Brightness sliders (impl-ambiglow §5 deviation 17).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serialize } from '../../../src/backend/core/json.ts';
import {
  EffectMenuCache,
  FOLLOW_VIDEO_BRIGHTNESS_MENU,
  FOLLOW_VIDEO_SPEED_MENU,
  displayEffectMenu,
  effectRegions,
  vendorEffectMenu,
  type DisplayEffectMenuItem,
} from '../../../src/backend/ambiglow/menu.ts';
import { parseAmbiglowInfo } from '../../../src/backend/ambiglow/ene-layout.ts';
import { DisplayEffectInfo } from '../../../src/backend/monitor/model/effect.ts';
import {
  PORT_FOLLOW_VIDEO_BRIGHTNESS,
  PORT_FOLLOW_VIDEO_SPEED,
  SERVED_ENE_MENU_BYTES,
  VENDOR_FOLLOW_VIDEO_BRIGHTNESS,
  VENDOR_FOLLOW_VIDEO_SPEED,
  vendorMenuText,
} from '../../fixtures/effect-menu.ts';
import { LAYOUTS } from './helpers.ts';

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const SPEC_61 = { bytes: 3962, sha256: '516cd5fad0f6938f314663ae956a79b845a816d272b7446b6bf605f77b290af2' };
const SPEC_62 = { bytes: 3277, sha256: 'cd09882c69487c4bc4c2c08251d34db1119beb152a6be887c1aa63609306a236' };
const SPEED_KEYS = ['SupSpeed', 'MinSpeed', 'MaxSpeed', 'SpeedStep'] as const;
const BRIGHTNESS_KEYS = ['SupBrightness', 'MinBrightness', 'MaxBrightness', 'BrightnessStep'] as const;
const PORT_KEYS: readonly string[] = [...SPEED_KEYS, ...BRIGHTNESS_KEYS];

test('the vendor menu with ENE model 34M2C8600 = 20-enum §6.1 (3962 bytes, sha256 516cd5fa…)', () => {
  const json = serialize(vendorEffectMenu(LAYOUTS, '34M2C8600'), 'ui');
  assert.equal(Buffer.byteLength(json, 'utf8'), SPEC_61.bytes);
  assert.equal(sha256(json), SPEC_61.sha256);
});

test('the served ENE menu = §6.1 except the FollowVideo speed and brightness fields (deviation 17: the Speed and Brightness sliders 1..3)', () => {
  const served = serialize(displayEffectMenu(LAYOUTS, '34M2C8600'), 'ui');
  assert.equal(Buffer.byteLength(served, 'utf8'), SERVED_ENE_MENU_BYTES, '3960 bytes: "true" twice instead of "false"');
  assert.ok(served.includes(PORT_FOLLOW_VIDEO_SPEED + PORT_FOLLOW_VIDEO_BRIGHTNESS));
  const reverted = vendorMenuText(served);
  assert.equal(Buffer.byteLength(reverted, 'utf8'), SPEC_61.bytes);
  assert.equal(sha256(reverted), SPEC_61.sha256, 'every other byte is the vendor fixture');
  assert.ok(reverted.includes(VENDOR_FOLLOW_VIDEO_SPEED + VENDOR_FOLLOW_VIDEO_BRIGHTNESS));

  // The same at object level: only the FollowVideo item differs, and only in the four speed and four brightness members.
  const port = displayEffectMenu(LAYOUTS, '34M2C8600').EffectList;
  const vendor = vendorEffectMenu(LAYOUTS, '34M2C8600').EffectList;
  assert.equal(port.length, vendor.length);
  for (let i = 0; i < port.length; i++) {
    const name = vendor[i].Effect.Name;
    if (name !== 'FollowVideo') {
      assert.deepEqual(port[i], vendor[i], `${name} is the vendor's item`);
      continue;
    }
    assert.deepEqual(
      Object.fromEntries(SPEED_KEYS.map((k) => [k, port[i][k]])),
      { ...FOLLOW_VIDEO_SPEED_MENU },
      'FollowVideo: SupSpeed true, MinSpeed 1, MaxSpeed 3, SpeedStep 1',
    );
    assert.deepEqual(
      Object.fromEntries(BRIGHTNESS_KEYS.map((k) => [k, port[i][k]])),
      { ...FOLLOW_VIDEO_BRIGHTNESS_MENU },
      'FollowVideo: SupBrightness true, MinBrightness 1, MaxBrightness 3, BrightnessStep 1',
    );
    assert.deepEqual([vendor[i].SupSpeed, vendor[i].SupBrightness], [false, false], 'the vendor hides both sliders');
    assert.deepEqual(
      Object.fromEntries(BRIGHTNESS_KEYS.slice(1).map((k) => [k, vendor[i][k]])),
      { MinBrightness: 1, MaxBrightness: 3, BrightnessStep: 1 },
      "the range was the vendor's already: only SupBrightness changes",
    );
    const rest = (item: DisplayEffectMenuItem) => Object.fromEntries(Object.entries(item).filter(([k]) => !PORT_KEYS.includes(k)));
    assert.deepEqual(rest(port[i]), rest(vendor[i]), 'FollowVideo: every other member as the vendor');
  }
  assert.equal(port.find((i) => i.Effect.Name === 'FollowAudio')?.SupBrightness, false, 'FollowAudio keeps the vendor item');
  assert.throws(() => vendorMenuText(serialize(vendorEffectMenu(LAYOUTS, '34M2C8600'), 'ui')), /FollowVideo speed fields/, 'the helper refuses the unmodified menu');
  const speedOnly = served.replace(PORT_FOLLOW_VIDEO_BRIGHTNESS, VENDOR_FOLLOW_VIDEO_BRIGHTNESS);
  assert.throws(() => vendorMenuText(speedOnly), /FollowVideo brightness fields/, 'and a menu without the Brightness slider');
});

test('without ENE ("") the served menu is the vendor one = 20-enum §6.2 (3277 bytes, sha256 cd09882c…): FollowVideo is the firmware\'s', () => {
  for (const menu of [displayEffectMenu(LAYOUTS, ''), vendorEffectMenu(LAYOUTS, '')]) {
    const json = serialize(menu, 'ui');
    assert.equal(Buffer.byteLength(json, 'utf8'), SPEC_62.bytes);
    assert.equal(sha256(json), SPEC_62.sha256);
    const followVideo = menu.EffectList.find((i) => i.Effect.Name === 'FollowVideo');
    assert.deepEqual([followVideo?.SupSpeed, followVideo?.SupBrightness], [false, false]);
  }
});

/**
 * The renderer's Speed slider, transcribed from Ambiglow-Dvqon39u.js:1059-1072 (work/app-pretty, vendor 1.13.0),
 * over the EffectDetail the store builds: `{ ...EffectInfo.EffectDetail, ...eneConfig item }`
 * (styles-DAnQi2A8.js:9516 updateMonitorEffectInfo, :9431 saveMonitorData). `R` is styles' Im(e): `null != e`.
 * Note the vendor bug kept verbatim: the range starts at MinBrightness, not MinSpeed.
 */
function rendererSpeedSlider(e: Record<string, any>, ra: (key: string) => string = (k) => k) {
  const ua = ['Low', 'Normal', 'High'];
  const R = (x: unknown) => x != null;
  const speed = { support: false, value: 0, range: [] as number[], marks: {} as Record<number, string> };
  if (((speed.support = !!e.SupSpeed), e.SupSpeed && ((speed.value = e.Speed), (speed.range = []), (speed.marks = {}), e.MaxSpeed && R(e.MinBrightness)))) {
    let a = e.MinBrightness;
    if (e.MaxSpeed > a && e.SpeedStep) {
      let l = 0;
      for (; a <= e.MaxSpeed; ) speed.range.push(a), (speed.marks[a] = ra(ua[l++])), (a += e.SpeedStep);
    }
  }
  return speed;
}

test('the renderer builds exactly three marks 1..3 Low/Normal/High for FollowVideo (its MinBrightness bug is harmless: MinBrightness = 1)', () => {
  const detail = DisplayEffectInfo.default('34M2C8600').getEffectDetail(1).toJson(); // Speed 2, like the user's profile
  const item = displayEffectMenu(LAYOUTS, '34M2C8600').EffectList.find((i) => i.Effect.Name === 'FollowVideo')!;
  assert.equal(item.MinBrightness, 1, 'the base MinBrightness the renderer starts the speed range at');
  const merged = { ...detail, ...JSON.parse(serialize(item, 'ui')) };
  assert.deepEqual(rendererSpeedSlider(merged), { support: true, value: 2, range: [1, 2, 3], marks: { 1: 'Low', 2: 'Normal', 3: 'High' } });
  // The same code with another MinBrightness would shift the marks: why it must stay 1.
  assert.deepEqual(rendererSpeedSlider({ ...merged, MinBrightness: 2 }).range, [2, 3]);
  // Without ENE (and in the vendor menu) the FollowVideo item hides the slider.
  const vendorItem = vendorEffectMenu(LAYOUTS, '34M2C8600').EffectList.find((i) => i.Effect.Name === 'FollowVideo')!;
  assert.equal(rendererSpeedSlider({ ...detail, ...JSON.parse(serialize(vendorItem, 'ui')) }).support, false);
  // The other effects with a Speed slider (ColorShift, ColorWave, Breathing, StarryNight) are unchanged: 1..3 too.
  for (const other of displayEffectMenu(LAYOUTS, '34M2C8600').EffectList.filter((i) => i.SupSpeed && i.Effect.Name !== 'FollowVideo')) {
    assert.deepEqual(rendererSpeedSlider({ Speed: 2, ...JSON.parse(serialize(other, 'ui')) }).range, [1, 2, 3], String(other.Effect.Name));
  }
});

/**
 * The renderer's Brightness slider, transcribed from Ambiglow-Dvqon39u.js:1040-1058 (work/app-pretty, vendor 1.13.0),
 * over the same merged EffectDetail as the Speed slider. `R` is styles' Im(e): `null != e`. The if-condition is the
 * last expression of the vendor's comma chain (its Brightness part).
 */
function rendererBrightnessSlider(e: Record<string, any>, ra: (key: string) => string = (k) => k) {
  const na = ['Bright', 'Brighter', 'Brightest'];
  const R = (x: unknown) => x != null;
  const brightness = { support: false, value: -1, range: [] as number[], marks: {} as Record<number, string> };
  if (
    ((brightness.support = !!e.SupBrightness),
    brightness.support && ((brightness.value = e.Brightness), (brightness.range = []), (brightness.marks = {}), e.MaxBrightness && R(e.MinBrightness)))
  ) {
    let a = e.MinBrightness;
    if (e.MaxBrightness > a && e.BrightnessStep) {
      let l = 0;
      for (; a <= e.MaxBrightness; ) brightness.range.push(a), (brightness.marks[a] = ra(na[l++])), (a += e.BrightnessStep);
    }
  }
  return brightness;
}

test('the renderer builds exactly three Brightness marks 1..3 Bright/Brighter/Brightest for FollowVideo with the ENE, none without', () => {
  const detail = DisplayEffectInfo.default('34M2C8600').getEffectDetail(1).toJson(); // Brightness 3, like the user's profile
  const item = displayEffectMenu(LAYOUTS, '34M2C8600').EffectList.find((i) => i.Effect.Name === 'FollowVideo')!;
  const merged = { ...detail, ...JSON.parse(serialize(item, 'ui')) };
  assert.deepEqual(rendererBrightnessSlider(merged), {
    support: true,
    value: 3,
    range: [1, 2, 3],
    marks: { 1: 'Bright', 2: 'Brighter', 3: 'Brightest' },
  });
  // The Speed slider next to it keeps its three marks (its MinBrightness bug reads the same 1).
  assert.deepEqual(rendererSpeedSlider(merged).range, [1, 2, 3]);
  // The vendor item (and the no-ENE menu) hides the slider.
  for (const menu of [vendorEffectMenu(LAYOUTS, '34M2C8600'), displayEffectMenu(LAYOUTS, '')]) {
    const vendorItem = menu.EffectList.find((i) => i.Effect.Name === 'FollowVideo')!;
    assert.equal(rendererBrightnessSlider({ ...detail, ...JSON.parse(serialize(vendorItem, 'ui')) }).support, false);
  }
  // FollowAudio has no Brightness slider in either menu (out of scope).
  const audio = displayEffectMenu(LAYOUTS, '34M2C8600').EffectList.find((i) => i.Effect.Name === 'FollowAudio')!;
  assert.equal(rendererBrightnessSlider({ Brightness: 3, ...JSON.parse(serialize(audio, 'ui')) }).support, false);
  // The other effects' Brightness sliders are unchanged: 1..3 too.
  for (const other of displayEffectMenu(LAYOUTS, '34M2C8600').EffectList.filter((i) => i.SupBrightness && i.Effect.Name !== 'FollowVideo')) {
    assert.deepEqual(rendererBrightnessSlider({ Brightness: 3, ...JSON.parse(serialize(other, 'ui')) }).range, [1, 2, 3], String(other.Effect.Name));
  }
});

test('GetRegions follows the JSON LED counts (DisplayEffectMenu.cs:140-168)', () => {
  const names = (model: string, layouts = LAYOUTS) => effectRegions(layouts, model).map((r) => r.Name);
  assert.deepEqual(names('34M2C8600'), ['AllZones', 'Bottom', 'FourSided', 'Central']);
  assert.deepEqual(names('34M2C6500'), ['AllZones', 'ThirdSidedA', 'Central'], 'no bottom LEDs: 3-sided');
  assert.deepEqual(names('27M2N5900A'), ['AllZones', 'ThirdSidedA'], 'no centre LEDs');
  assert.deepEqual(names('UNKNOWN'), ['AllZones']);
  assert.deepEqual(names(''), ['AllZones']);
  const bottomOnly = parseAmbiglowInfo('[{"ModelName":"X","BottomLedCount":5,"RightLedCount":0}]');
  assert.deepEqual(names('X', bottomOnly), ['AllZones', 'Bottom'], 'bottom without all four edges: no FourSided');
  assert.equal(effectRegions(LAYOUTS, '34m2c8600').length, 4, 'model lookup ignores case (impl-usb-ene deviation 5)');
});

test('the menu is built once per ENE model (CDeviceEffectBase._effectMenu)', () => {
  const cache = new EffectMenuCache();
  const a = cache.get(LAYOUTS, '34M2C8600');
  assert.equal(cache.get(LAYOUTS, '34M2C8600'), a);
  assert.notEqual(cache.get(LAYOUTS, ''), a);
  assert.equal(a.EffectList[0].SupSpeed, true, 'the cache serves the port menu');
  cache.clear();
  assert.notEqual(cache.get(LAYOUTS, '34M2C8600'), a);
});
