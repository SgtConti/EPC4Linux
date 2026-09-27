// The port's experiments in main (src/main/experimental.ts): config.json "linuxExperimental" is the one source of
// truth for the "Fast LED upload (experimental)" checkbox; every change of it reaches the backend, the checkbox's own
// path writes only real changes, and EVNIA_ENE_FRAME_BURST=1 is reported (not stored).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createLogger } from '../../../src/backend/core/log.ts';
import { ExperimentalSettings } from '../../../src/main/experimental.ts';
import { ConfigStore } from '../../../src/main/store.ts';

const lines: string[] = [];
const log = createLogger('test', (_level, _scope, args) => void lines.push(args.map(String).join(' ')), 'debug');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evnia-experimental-'));
  lines.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('the checkbox path: stored in config.json, applied to the backend once per change, the same value writes nothing', () => {
  const store = new ConfigStore(join(dir, 'config.json'), log);
  const applied: boolean[] = [];
  const settings = new ExperimentalSettings({ store, backend: { setEneFrameBurst: (on) => void applied.push(on) }, forcedByEnv: false, log });
  assert.deepEqual(settings.state(), { eneFrameBurst: false, forcedByEnv: false });
  assert.deepEqual(settings.setEneFrameBurst(true), { eneFrameBurst: true, forcedByEnv: false });
  assert.deepEqual(settings.setEneFrameBurst(true), { eneFrameBurst: true, forcedByEnv: false });
  assert.deepEqual(applied, [true]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).linuxExperimental, { eneFrameBurst: true });
  assert.equal(lines.filter((l) => l.includes('"Fast LED upload (experimental)" on')).length, 1);
  settings.setEneFrameBurst(false);
  assert.deepEqual(applied, [true, false]);
  assert.throws(() => settings.setEneFrameBurst('on' as unknown as boolean), TypeError);
  assert.deepEqual(applied, [true, false]);
  // Any writer of the key is followed (window.store), other keys are not.
  store.set('language', 'de');
  store.delete('linuxExperimental');
  assert.deepEqual(applied, [true, false, false]);
  settings.dispose();
  store.set('linuxExperimental.eneFrameBurst', true);
  assert.deepEqual(applied, [true, false, false], 'disposed: no longer followed');
});

test('EVNIA_ENE_FRAME_BURST=1 is reported with the stored setting unchanged, and logged once', () => {
  const store = new ConfigStore(join(dir, 'config.json'), log);
  const settings = new ExperimentalSettings({ store, backend: { setEneFrameBurst: () => {} }, forcedByEnv: true, log });
  assert.deepEqual(settings.state(), { eneFrameBurst: false, forcedByEnv: true });
  assert.equal(lines.filter((l) => l.includes('EVNIA_ENE_FRAME_BURST=1')).length, 1);
});
