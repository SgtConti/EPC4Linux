import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  AMBIGLOW_INFO_PATHS,
  findModelLayout,
  loadAmbiglowInfo,
  matchEneModelName,
  parseAmbiglowInfo,
} from '../../../src/backend/ambiglow/ene-layout.ts';
import { resolveAppPaths } from '../../../src/main/paths.ts';
import { FIXTURES, LAYOUTS, recordingLog } from './helpers.ts';

const USER_LAYOUT = {
  modelName: '34M2C8600',
  rightLedCount: 3,
  rightUpLedCount: 4,
  leftUpLedCount: 4,
  leftLedCount: 3,
  centerLedCount: 18,
  bottomLedCount: 14,
};

test('parses the vendor format (CRLF, WriteType ignored)', () => {
  assert.deepEqual(LAYOUTS.map((l) => l.modelName), ['49M2C8900L', '34M2C8600', '34M2C6500', '27M2N5900A']);
  assert.deepEqual(findModelLayout(LAYOUTS, '34M2C8600'), USER_LAYOUT);
  assert.equal(findModelLayout(LAYOUTS, '34m2c8600')?.modelName, '34M2C8600');
  assert.equal(findModelLayout(LAYOUTS, '34M2C860'), undefined);
});

test('Newtonsoft-like leniency: BOM, case-insensitive keys, missing counts are 0, nameless entries dropped', () => {
  const text = '﻿[{"modelname":"X1","rightledcount":2},{"WriteType":1,"RightLedCount":3},{"ModelName":"X2","CenterLedCount":null}]';
  assert.deepEqual(parseAmbiglowInfo(text), [
    { modelName: 'X1', rightLedCount: 2, rightUpLedCount: 0, leftUpLedCount: 0, leftLedCount: 0, centerLedCount: 0, bottomLedCount: 0 },
    { modelName: 'X2', rightLedCount: 0, rightUpLedCount: 0, leftUpLedCount: 0, leftLedCount: 0, centerLedCount: 0, bottomLedCount: 0 },
  ]);
});

test('malformed tables are rejected', () => {
  assert.throws(() => parseAmbiglowInfo('{"ModelName":"X"}'), /expected a JSON array/);
  assert.throws(() => parseAmbiglowInfo('[{"ModelName":"X","RightLedCount":-1}]'), /RightLedCount/);
  assert.throws(() => parseAmbiglowInfo('[{"ModelName":"X","BottomLedCount":"14"}]'), /BottomLedCount/);
  assert.throws(() => parseAmbiglowInfo('[1]'), /expected an object/);
});

const TABLE = readFileSync(new URL('PCenter_AmbiglowInfo.json', FIXTURES));

function withResources(fn: (dir: string, put: (relative: string, content: string | Buffer) => void) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'evnia-ene-'));
  const put = (relative: string, content: string | Buffer) => {
    mkdirSync(join(dir, relative, '..'), { recursive: true });
    writeFileSync(join(dir, relative), content);
  };
  return fn(dir, put).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('loadAmbiglowInfo reads <resourcesDir>/ENE/PCenter_AmbiglowInfo.json and logs it; a missing table disables ENE with a warning', () =>
  withResources(async (dir, put) => {
    const { log, lines } = recordingLog();
    assert.deepEqual(await loadAmbiglowInfo(dir, log), []);
    const warning = lines.find((l) => l.startsWith('warn:')) ?? '';
    assert.ok(warning.includes(join(dir, 'ENE', 'PCenter_AmbiglowInfo.json')) && warning.includes(join(dir, 'data', 'ENE', 'PCenter_AmbiglowInfo.json')), warning);
    lines.length = 0;
    put(join('ENE', 'PCenter_AmbiglowInfo.json'), TABLE);
    assert.deepEqual(await loadAmbiglowInfo(dir, log), LAYOUTS);
    assert.deepEqual(lines, [`info: ENE model table ${join(dir, 'ENE', 'PCenter_AmbiglowInfo.json')}: 4 models`]);
  }));

test('the vendor\'s data/ENE/ level is accepted too; the build location wins when both exist', () =>
  withResources(async (dir, put) => {
    const { log, lines } = recordingLog();
    const vendorPath = join(dir, 'data', 'ENE', 'PCenter_AmbiglowInfo.json');
    put(join('data', 'ENE', 'PCenter_AmbiglowInfo.json'), TABLE);
    assert.deepEqual(await loadAmbiglowInfo(dir, log), LAYOUTS);
    assert.deepEqual(lines, [`info: ENE model table ${vendorPath}: 4 models`]);
    put(join('ENE', 'PCenter_AmbiglowInfo.json'), '[{"ModelName":"X1"}]');
    assert.deepEqual((await loadAmbiglowInfo(dir, log)).map((l) => l.modelName), ['X1']);
  }));

test('a malformed table disables ENE with a warning (no fallback to another copy)', () =>
  withResources(async (dir, put) => {
    const { log, lines } = recordingLog();
    put(join('ENE', 'PCenter_AmbiglowInfo.json'), '{"ModelName":"X"}');
    put(join('data', 'ENE', 'PCenter_AmbiglowInfo.json'), TABLE);
    assert.deepEqual(await loadAmbiglowInfo(dir, log), []);
    assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes('malformed') && l.includes('expected a JSON array')), lines.join('\n'));
  }));

const PORT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface UiCopy {
  source: string;
  destDir: string;
}

test('AMBIGLOW_INFO_PATHS[0] follows the build: ui-patches copies → build/vendor-data/ → <app>/resources = resourcesDir', async () => {
  const manifest: { copies: UiCopy[] } = (await import(pathToFileURL(join(PORT_ROOT, 'scripts', 'ui-patches.mjs')).href)).default;
  const copyOf = (file: string) => manifest.copies.find((c) => basename(c.source) === file);
  // vendor-data/ is resourcesDir: MonitorInfo.json is imported into vendor-data/ and main reads it at <resourcesDir>/MonitorInfo.json.
  assert.equal(copyOf('MonitorInfo.json')?.destDir, 'vendor-data');
  const paths = resolveAppPaths('/opt/evnia/app', '/home/u/.config', '/tmp');
  assert.equal(paths.bundledMonitorInfo, join(paths.resourcesDir, 'MonitorInfo.json'));
  const table = copyOf('PCenter_AmbiglowInfo.json');
  assert.ok(table, 'the import ships PCenter_AmbiglowInfo.json');
  assert.equal(join(relative('vendor-data', table.destDir), 'PCenter_AmbiglowInfo.json'), AMBIGLOW_INFO_PATHS[0]);
});

// Real import/build output, when present: build/vendor-data (import-ui) and build/app/resources (build).
const BUILT_RESOURCES = ['build/vendor-data', 'build/app/resources']
  .map((dir) => join(PORT_ROOT, dir))
  .filter((dir) => existsSync(join(dir, 'MonitorInfo.json')));

test('the imported/built resources hold the table where loadAmbiglowInfo looks', { skip: BUILT_RESOURCES.length === 0 && 'no import/build output' }, async () => {
  for (const dir of BUILT_RESOURCES) {
    const { log, lines } = recordingLog();
    const layouts = await loadAmbiglowInfo(dir, log);
    assert.deepEqual(findModelLayout(layouts, '34M2C8600'), USER_LAYOUT, dir);
    assert.deepEqual(lines.filter((l) => l.startsWith('warn:')), [], dir);
  }
});

// The real vendor file, when the reference install is present next to the port (read-only check).
const VENDOR_FILE = fileURLToPath(new URL('../../../../Evnia Precision Center/resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json', import.meta.url));

test('vendor PCenter_AmbiglowInfo.json matches the table in 09 §7.3', { skip: !existsSync(VENDOR_FILE) && 'vendor install not present' }, () => {
  const layouts = parseAmbiglowInfo(readFileSync(VENDOR_FILE, 'utf8'));
  assert.equal(layouts.length, 19);
  assert.deepEqual(findModelLayout(layouts, '34M2C8600'), USER_LAYOUT);
  const row = (name: string) => {
    const l = findModelLayout(layouts, name);
    return l && [l.rightLedCount, l.rightUpLedCount, l.leftUpLedCount, l.leftLedCount, l.centerLedCount, l.bottomLedCount];
  };
  assert.deepEqual(row('42M2N8900'), [4, 4, 4, 4, 34, 0]);
  assert.deepEqual(row('34M2C7600MV'), [3, 4, 4, 3, 22, 14]);
  assert.deepEqual(row('27M2N8500'), [4, 5, 5, 4, 12, 0]);
});

test('matchEneModelName follows CUSBENE6K7732.GetModelName', () => {
  const ene = ['34M2C8600', '27M2N5900A'];
  assert.equal(matchEneModelName('34M2C8600', ene), '34M2C8600');
  assert.equal(matchEneModelName('PHL 34M2C8600', ene), '34M2C8600');
  assert.equal(matchEneModelName('phl_34m2c8600', ene), '34M2C8600');
  assert.equal(matchEneModelName('PHL34M2C8600', ene), '34M2C8600');
  // Second rule: the ENE name extends the monitor name with letters/digits. The vendor escapes the
  // whole monitor name there, so a "PHL " prefix on the monitor side does not match (kept as is).
  assert.equal(matchEneModelName('27M2N5900', ene), '27M2N5900A');
  assert.equal(matchEneModelName('34M2C86', ene), '34M2C8600');
  assert.equal(matchEneModelName('PHL 27M2N5900', ene), undefined);
  assert.equal(matchEneModelName('34M2C8600 (1)', ene), undefined);
  assert.equal(matchEneModelName('XPHL 34M2C8600', ene), undefined);
  assert.equal(matchEneModelName('', ene), undefined);
});
