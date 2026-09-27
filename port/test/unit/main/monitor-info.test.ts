import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import {
  buildMonitorJsonConfig,
  loadMonitorInfo,
  monitorKey,
  selectMonitorInfo,
  versionToInt,
} from '../../../src/main/monitor-info.ts';

const log = createLogger('test', silentSink);
const PORT = join(import.meta.dirname, '..', '..', '..');

test('Wf version encoding (01 §8.3)', () => {
  assert.equal(versionToInt('1.13.0'), 101300);
  assert.equal(versionToInt('1.11.0'), 101100);
  assert.equal(versionToInt('v2.3.45'), 200345);
});

test('key derivation is byte-for-byte the vendor expression', () => {
  const vendor = (name: string) =>
    name
      .trim()
      .slice(name.startsWith('PHL') ? 3 : 0)
      .split(/[\s+|_]/)
      .at(-1) || '';
  const names = ['34M2C8600', 'PHL 34M2C8600', 'PHL_27M2N8800', 'PHL27M2N5900A', ' PHL 49M2C8900', 'Evnia+42M2N8900', 'a|b', 'PHL', '', '32M2N6800M '];
  for (const n of names) assert.equal(monitorKey(n), vendor(n), JSON.stringify(n));
  assert.equal(monitorKey('PHL 34M2C8600'), '34M2C8600');
  assert.equal(monitorKey('PHL_27M2N8800'), '27M2N8800');
  assert.equal(monitorKey('PHL'), '', 'a bare prefix yields no key (entry skipped)');
});

test('config: later entries win, OTAEnable is always false', () => {
  const r = buildMonitorJsonConfig({
    Version: 34,
    LimitVer_PCenter: [],
    Monitors: [
      { Name: '34M2C8600', SupUsbDDC: true, SupOTA: true, SupLightEffect: true, SupLightSync: true, HDR: 400 },
      { Name: 'PHL 34M2C8600', SupUsbDDC: true, SupOTA: true, SupLightEffect: true, SupLightSync: true, HDR: 401 },
      { Name: '', HDR: 0 },
    ],
  });
  assert.equal(r.OTAEnable, false);
  assert.deepEqual(Object.keys(r.config), ['34M2C8600']);
  assert.equal(r.config['34M2C8600'].HDR, 401);
  assert.deepEqual(buildMonitorJsonConfig(null), { OTAEnable: false, config: {} });
});

test('user copy wins only when its Version is at least the bundled one (14 §7.5)', () => {
  const bundled = { Version: 34, Monitors: [] };
  assert.equal(selectMonitorInfo(bundled, { Version: 34, Monitors: [] })?.Version, 34);
  const newer = { Version: 35, Monitors: [] };
  assert.equal(selectMonitorInfo(bundled, newer), newer);
  assert.equal(selectMonitorInfo(bundled, { Version: 33, Monitors: [] }), bundled);
  assert.equal(selectMonitorInfo(null, newer), newer);
});

test('loadMonitorInfo reads files, tolerates a BOM, ignores broken user files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evnia-mi-'));
  try {
    const bundled = join(dir, 'bundled.json');
    const user = join(dir, 'user.json');
    writeFileSync(bundled, `﻿${JSON.stringify({ Version: 34, Monitors: [{ Name: 'PHL 34M2C8600', HDR: 400 }] })}`);
    writeFileSync(user, '{broken');
    const info = loadMonitorInfo(bundled, user, log);
    assert.equal(buildMonitorJsonConfig(info).config['34M2C8600'].HDR, 400);
    assert.equal(loadMonitorInfo(join(dir, 'none.json'), join(dir, 'none2.json'), log), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real vendor table (when imported): the user's model maps to all features, HDR 400", { skip: !existsSync(join(PORT, 'build', 'vendor-data', 'MonitorInfo.json')) && 'npm run import-ui not run' }, () => {
  const info = JSON.parse(readFileSync(join(PORT, 'build', 'vendor-data', 'MonitorInfo.json'), 'utf8'));
  const { config } = buildMonitorJsonConfig(info);
  assert.equal(info.Version, 34);
  const { Name, ...flags } = config['34M2C8600'];
  assert.match(Name, /^(PHL )?34M2C8600$/);
  assert.deepEqual(flags, { SupUsbDDC: true, SupOTA: true, SupLightEffect: true, SupLightSync: true, HDR: 400 });
});
