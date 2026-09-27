// Effect_GetColorData / Effect_SetSelfColors over Config/color.data (20-theme §3.7, golden step 7).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from '../../../src/backend/core/json.ts';
import { ColorDataStore, colorDataPath, defaultColorData } from '../../../src/backend/ambiglow/color-data.ts';
import { silentLog } from './helpers.ts';

/** 20-backend-host-tail §5 step 7 Tag (= 20-enum §6.6, 339 bytes). */
const GOLDEN_STEP7_TAG =
  '{"DefColors":[{"R":255,"G":255,"B":255},{"R":255,"G":0,"B":0},{"R":255,"G":0,"B":127},{"R":127,"G":0,"B":127},{"R":127,"G":0,"B":255},{"R":0,"G":0,"B":255},{"R":0,"G":127,"B":255},{"R":0,"G":255,"B":255},{"R":0,"G":255,"B":127},{"R":0,"G":255,"B":0},{"R":127,"G":255,"B":0},{"R":255,"G":255,"B":0},{"R":255,"G":127,"B":0}],"SelfColors":""}';

async function withDir(fn: (serveDataDir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'evnia-color-'));
  try {
    await fn(join(root, 'EvniaServe'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('no color.data (the user\'s state): DefData(), byte-exact golden step 7 Tag', async () => {
  await withDir(async (dir) => {
    const store = new ColorDataStore(colorDataPath(dir), silentLog);
    const data = await store.get();
    assert.equal(serialize(data, 'ui'), GOLDEN_STEP7_TAG);
    assert.equal(GOLDEN_STEP7_TAG.length, 339);
    assert.equal(serialize(defaultColorData(), 'ui'), GOLDEN_STEP7_TAG);
  });
});

test('Effect_SetSelfColors writes BOM + one JSON line and Effect_GetColorData reads it back', async () => {
  await withDir(async (dir) => {
    const path = colorDataPath(dir);
    assert.equal(path, join(dir, 'Config', 'color.data'));
    const store = new ColorDataStore(path, silentLog);
    const saved = await store.setSelfColors('#12ab34,#ff0000');
    assert.equal(saved.SelfColors, '#12ab34,#ff0000');
    const bytes = await readFile(path);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM like SaveTxtData');
    const text = bytes.subarray(3).toString('utf8');
    assert.equal(text, GOLDEN_STEP7_TAG.replace('"SelfColors":""', '"SelfColors":"#12ab34,#ff0000"'), 'DefColors first, no newline');
    assert.equal(serialize(await store.get(), 'ui'), text);
  });
});

test('a Windows color.data with other DefColors is kept as is; unreadable files fall back to DefData', async () => {
  await withDir(async (dir) => {
    const path = colorDataPath(dir);
    await mkdir(join(dir, 'Config'), { recursive: true });
    const store = new ColorDataStore(path, silentLog);
    await writeFile(path, '﻿{"DefColors":[{"R":1,"G":2,"B":3}],"SelfColors":"#010203"}');
    assert.deepEqual(await store.get(), { DefColors: [{ R: 1, G: 2, B: 3 }], SelfColors: '#010203' });
    const updated = await store.setSelfColors('');
    assert.deepEqual(updated.DefColors, [{ R: 1, G: 2, B: 3 }], 'only SelfColors changes (SystemOper.cs:1365-1383)');
    for (const broken of ['', '{"DefColors":[{"R":300,"G":0,"B":0}]}', '{\n"SelfColors":"#000000"}', 'not json']) {
      await writeFile(path, broken);
      assert.equal(serialize(await store.get(), 'ui'), GOLDEN_STEP7_TAG, JSON.stringify(broken));
    }
    await writeFile(path, '{"SelfColors":null,"DefColors":null}');
    assert.deepEqual(await store.get(), { DefColors: [], SelfColors: '' }, 'nulls keep the field initializers');
  });
});
