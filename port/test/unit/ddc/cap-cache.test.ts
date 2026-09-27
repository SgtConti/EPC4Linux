import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CapabilityCache,
  capCacheKey,
  capCacheSign,
  capCacheVerify,
  decodeCapCacheFile,
  encodeCapCacheFile,
  serializeCapCacheData,
} from '../../../src/backend/ddc/cap-cache.ts';
import { fixture, realCapabilities } from './helpers.ts';

const fixtureText = () => readFileSync(fixture('EvniaServe/Config/data.json'), 'utf8');

test('real data.json: signature verifies with HMAC-SHA256("WhaleTV_Serizlize_2026")', () => {
  const decoded = decodeCapCacheFile(fixtureText());
  assert.equal(decoded.status, 'signed');
  assert.deepEqual(decoded.list, [{ Name: 'PHL 34M2C8600', Datas: [{ Key: 'v1.01_0f', Vcp: realCapabilities() }] }]);
  const wrapper = JSON.parse(fixtureText().replace(/^﻿/, ''));
  assert.equal(capCacheSign(wrapper.data), wrapper.sign);
  assert.equal(capCacheSign(wrapper.data), 'Tsp5rMqtwjyGNk+TolTxhiSrLJlvsF4d3085ZOkUyfo=');
  assert.equal(capCacheVerify(wrapper.data, wrapper.sign), true);
  assert.equal(capCacheVerify(wrapper.data, 'not base64!'), false);
});

test('real data.json round-trips byte for byte (BOM, escaping, key order, signature)', () => {
  const text = fixtureText();
  const decoded = decodeCapCacheFile(text);
  assert.ok(decoded.list);
  assert.equal(encodeCapCacheFile(decoded.list), text);
  assert.equal(Buffer.from(encodeCapCacheFile(decoded.list), 'utf8').equals(readFileSync(fixture('EvniaServe/Config/data.json'))), true);
});

test('tampered data is rejected; unsigned legacy lists are accepted', () => {
  const wrapper = JSON.parse(fixtureText().replace(/^﻿/, ''));
  const tampered = JSON.stringify({ data: wrapper.data.replace('v1.01_0f', 'v1.02_0f'), sign: wrapper.sign });
  assert.equal(decodeCapCacheFile(tampered).status, 'bad-signature');
  const legacy = decodeCapCacheFile('[{"name":"PHL X","datas":[{"key":"k","vcp":"(vcp(10))"}]}]');
  assert.deepEqual(legacy, { status: 'legacy', list: [{ Name: 'PHL X', Datas: [{ Key: 'k', Vcp: '(vcp(10))' }] }] });
  assert.equal(decodeCapCacheFile('﻿  ').status, 'empty');
  assert.equal(decodeCapCacheFile('{not json').status, 'invalid');
  assert.equal(decodeCapCacheFile('{"foo":1}').status, 'invalid');
});

test('Newtonsoft string escaping and null Datas', () => {
  const s = serializeCapCacheData([{ Name: 'a"b\\c', Datas: null }, { Name: `x${String.fromCharCode(0x2028)}\u0001`, Datas: [] }]);
  assert.equal(s, '[{"Name":"a\\"b\\\\c","Datas":null},{"Name":"x\\u2028\\u0001","Datas":[]}]');
});

test('cache key: lower("<version>_<VCP60 low byte %02X>")', () => {
  assert.equal(capCacheKey('V1.01', 0x0f), 'v1.01_0f');
  assert.equal(capCacheKey('V1.01', { value: 0x2f11, max: 0x3616, resultCode: 0 }), 'v1.01_11');
});

test('CapabilityCache: CacheVcpMgr lookup/save/delete/reset semantics on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capcache-'));
  try {
    const path = join(dir, 'Config', 'data.json');
    const cache = new CapabilityCache(path);
    await cache.load(); // missing file → empty
    assert.equal(cache.get('PHL 34M2C8600', 'v1.01_0f'), null);

    await writeFile(join(dir, 'seed.json'), fixtureText());
    const seeded = new CapabilityCache(join(dir, 'seed.json'));
    await seeded.load();
    assert.equal(seeded.get('phl 34m2c8600', 'V1.01_0F'), realCapabilities()); // case-insensitive
    assert.equal(seeded.get('PHL 34M2C8600', '1.01'), realCapabilities()); // Key.Contains
    assert.equal(seeded.get('PHL 34M2C8600', ''), null);
    assert.equal(seeded.get('PHL 27M2N5500', 'v1.01_0f'), null);

    await cache.save('PHL 34M2C8600', 'v1.01_0f', realCapabilities());
    assert.equal(await readFile(path, 'utf8'), fixtureText()); // identical to what Windows wrote
    await cache.save('PHL 34M2C8600', 'v1.01_11', '(vcp(10))');
    await cache.save('PHL 34M2C8600', 'v1.01_11', '(vcp(12))'); // exact key → replaced
    await cache.save('', 'k', 'v'); // ignored
    const reread = new CapabilityCache(path);
    await reread.load();
    assert.deepEqual(reread.entries()[0].Datas?.map((d) => d.Key), ['v1.01_0f', 'v1.01_11']);
    assert.equal(reread.get('PHL 34M2C8600', 'v1.01_11'), '(vcp(12))');

    await reread.delete('PHL 34M2C8600');
    assert.equal(decodeCapCacheFile(await readFile(path, 'utf8')).list?.length, 0);
    await reread.save('A', 'k', 'v');
    await reread.reset();
    assert.equal(await readFile(path, 'utf8'), `﻿{"data":"[]","sign":"${capCacheSign('[]')}"}`);

    // A tampered file is ignored and replaced on the next save, like the vendor.
    await writeFile(path, fixtureText().replace('Tsp5', 'Xsp5'));
    const tampered = new CapabilityCache(path);
    await tampered.load();
    assert.equal(tampered.entries().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('overlapping mutations are queued: every save/delete resolves and the file ends in the final state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'capcache-'));
  try {
    const path = join(dir, 'Config', 'data.json');
    const cache = new CapabilityCache(path);
    await cache.load();
    // 50 pairs of concurrent saves (two monitors connecting in parallel), then a save racing a delete.
    await Promise.all(Array.from({ length: 50 }, (_, i) => [
      cache.save('PHL 34M2C8600', `v1.01_${i}`, `(vcp(${i}))`),
      cache.save('PHL 27M2N5500', `v1.02_${i}`, `(vcp(${i}))`),
    ]).flat());
    await Promise.all([cache.save('PHL 49M2C8900', 'v1.00_0f', '(vcp(10))'), cache.delete('PHL 27M2N5500')]);
    const reread = new CapabilityCache(path);
    await reread.load();
    assert.deepEqual(reread.entries().map((d) => [d.Name, d.Datas?.length]), [['PHL 34M2C8600', 50], ['PHL 49M2C8900', 1]]);
    assert.equal(await readFile(path, 'utf8'), encodeCapCacheFile(cache.entries()));
    // Two instances on one path do not rename each other's temp file away either.
    const other = new CapabilityCache(path);
    await Promise.all([cache.save('A', 'k', 'v'), other.save('B', 'k', 'v'), cache.reset(), other.reset()]);
    assert.deepEqual((await readdir(join(dir, 'Config'))).sort(), ['data.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
