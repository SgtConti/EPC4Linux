import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import {
  deletePath,
  getPath,
  normalizeStoreData,
  serializeStore,
  setPath,
  STORE_SCHEMA,
  writeError,
} from '../../../src/main/shared/store-schema.ts';
import { ConfigStore } from '../../../src/main/store.ts';

const log = createLogger('test', silentSink);
const FIXTURE = join(import.meta.dirname, '..', '..', 'fixtures', 'windows', 'evnia', 'config.json');
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evnia-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('schema reproduces the vendor keys and defaults (01 §6) with update/login pinned off', () => {
  assert.deepEqual(Object.keys(STORE_SCHEMA), [
    'language', 'dashboardPreview', 'dashboardPreviewEnable', 'dashboardLocation', 'autoStartup', 'autoStartupMinimize',
    'noticeSwitch', 'noticeSound', 'noticeStyle', 'autoUpdate', 'latestSoftwareInfo', 'ignoreVersion', 'automaticUpdate',
    'tutorials', 'userInfo', 'email', 'password', 'skipLoginState', 'mainWindowBounds', 'overviewType', 'ambiScapeEnable',
  ]);
  assert.equal(STORE_SCHEMA.autoStartup.default, false, 'Linux default (01 port plan 6): no login autostart until enabled');
  assert.equal(STORE_SCHEMA.autoStartupMinimize.default, true);
  assert.equal(STORE_SCHEMA.overviewType.default, 'category');
  assert.equal(STORE_SCHEMA.autoUpdate.default, false);
  assert.equal(STORE_SCHEMA.automaticUpdate.default, false);
  assert.equal(STORE_SCHEMA.skipLoginState.default, true);
});

test("the user's real Windows config.json loads unchanged except for the pinned keys", () => {
  const original = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const data = structuredClone(original);
  const changes = normalizeStoreData(data);
  assert.deepEqual(changes, ['pinned autoUpdate=false', 'pinned automaticUpdate=false']);
  assert.deepEqual({ ...data, autoUpdate: true, automaticUpdate: true }, original);
  // key order and the non-schema key written by the NSIS installer survive
  assert.deepEqual(Object.keys(data), Object.keys(original));
  assert.equal(data.languageTemp, 'en');
  assert.equal(data.autoStartup, true, "the user's explicit choice survives the Linux default");
});

test('a fresh config does not enable login autostart', () => {
  const data: Record<string, unknown> = {};
  normalizeStoreData(data);
  assert.equal(data.autoStartup, false);
  assert.equal(data.autoStartupMinimize, true);
});

test('normalization drops cloud keys and schema violations and stamps the migration version', () => {
  const data: Record<string, unknown> = { language: 42, userInfo: { id: 'x' }, password: 'p', email: 'e', noticeSound: 1 };
  normalizeStoreData(data);
  assert.equal(data.language, 'en');
  assert.equal(data.noticeSound, 1);
  assert.ok(!('userInfo' in data) && !('password' in data) && !('email' in data));
  assert.deepEqual(data.__internal__, { migrations: { version: '1.13.0' } });
});

test('writeError mirrors electron-store validation', () => {
  assert.equal(writeError('language', 'de'), null);
  assert.match(writeError('language', 3)!, /schema violation/);
  assert.match(writeError('noticeSound', Number.NaN)!, /schema violation/);
  assert.match(writeError('dashboardPreview', [])!, /must be object/);
  assert.match(writeError('language', undefined)!, /delete/);
  assert.match(writeError('__internal__.x', 1)!, /__internal__/);
  assert.match(writeError('userInfo', {})!, /not stored/);
  assert.match(writeError('a..b', 1)!, /Invalid/);
  assert.match(writeError('__proto__.polluted', 1)!, /Invalid/);
  assert.equal(writeError('tutorials.Dashboard', true), null);
  assert.match(writeError('language.x', true)!, /must be string/);
  assert.equal(writeError('languageTemp', 'en'), null, 'keys outside the schema are allowed like electron-store');
});

test('dot paths behave like dot-prop', () => {
  const d: Record<string, unknown> = {};
  setPath(d, 'tutorials.Dashboard', true);
  assert.deepEqual(d, { tutorials: { Dashboard: true } });
  assert.equal(getPath(d, 'tutorials.Dashboard'), true);
  assert.equal(getPath(d, 'tutorials.Missing'), undefined);
  assert.equal(deletePath(d, 'tutorials.Dashboard'), true);
  assert.deepEqual(d, { tutorials: {} });
  assert.equal(deletePath(d, 'nothing.here'), false);
});

test('ConfigStore writes a tab-indented electron-store file and persists every change', () => {
  const file = join(dir, 'config.json');
  const store = new ConfigStore(file, log);
  const onDisk = () => JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(readFileSync(file, 'utf8'), serializeStore(store.snapshot()));
  assert.match(readFileSync(file, 'utf8'), /^\{\n\t"language": "en",/);
  const seen: [string, unknown][] = [];
  store.onChange((k, v) => seen.push([k, v]));
  store.set('noticeSwitch', true);
  store.set('autoUpdate', true); // pinned
  store.set('tutorials.Dashboard', true);
  store.delete('tutorials');
  assert.equal(onDisk().noticeSwitch, true);
  assert.equal(onDisk().autoUpdate, false);
  assert.equal(onDisk().tutorials, undefined);
  assert.deepEqual(seen, [['noticeSwitch', true], ['autoUpdate', false], ['tutorials.Dashboard', true], ['tutorials', undefined]]);
  assert.throws(() => store.set('language', 1), /schema violation/);
  assert.deepEqual(new ConfigStore(file, log).snapshot(), store.snapshot(), 'reload gives the same data');
});

test('ConfigStore keeps an unparseable file aside and starts from defaults', () => {
  const file = join(dir, 'config.json');
  writeFileSync(file, '{ not json');
  const store = new ConfigStore(file, log);
  assert.equal(store.get('language'), 'en');
  assert.ok(readdirSync(dir).some((f) => f.startsWith('config.json.invalid-')));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).language, 'en');
});

test('get returns copies', () => {
  const store = new ConfigStore(join(dir, 'config.json'), log);
  const preview = store.get<Record<string, string>>('dashboardPreview')!;
  preview.x = 'mutated';
  assert.deepEqual(store.get('dashboardPreview'), {});
});
