// Effect_GetMenu: DisplayEffectMenu.Default(model) against the byte-exact fixtures of
// 20-enum-valuelist-catalog §6.1 (ENE "34M2C8600") and §6.2 (no ENE, "").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { serialize } from '../../../src/backend/core/json.ts';
import { EffectMenuCache, displayEffectMenu, effectRegions } from '../../../src/backend/ambiglow/menu.ts';
import { parseAmbiglowInfo } from '../../../src/backend/ambiglow/ene-layout.ts';
import { LAYOUTS } from './helpers.ts';

const sha256 = (s: string) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

test('Effect_GetMenu with ENE model 34M2C8600 = 20-enum §6.1 (3962 bytes, sha256 516cd5fa…)', () => {
  const json = serialize(displayEffectMenu(LAYOUTS, '34M2C8600'), 'ui');
  assert.equal(Buffer.byteLength(json, 'utf8'), 3962);
  assert.equal(sha256(json), '516cd5fad0f6938f314663ae956a79b845a816d272b7446b6bf605f77b290af2');
});

test('Effect_GetMenu without ENE ("") = 20-enum §6.2 (3277 bytes, sha256 cd09882c…)', () => {
  const json = serialize(displayEffectMenu(LAYOUTS, ''), 'ui');
  assert.equal(Buffer.byteLength(json, 'utf8'), 3277);
  assert.equal(sha256(json), 'cd09882c69487c4bc4c2c08251d34db1119beb152a6be887c1aa63609306a236');
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
  cache.clear();
  assert.notEqual(cache.get(LAYOUTS, '34M2C8600'), a);
});
