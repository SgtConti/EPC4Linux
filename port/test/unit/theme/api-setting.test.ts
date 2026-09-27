import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { RpcDispatcher } from '../../../src/backend/rpc/dispatcher.ts';
import { settingApi } from '../../../src/backend/api/setting.ts';
import { themeApi } from '../../../src/backend/api/theme.ts';
import { macroApi } from '../../../src/backend/api/macro.ts';
import { succ } from '../../../src/backend/core/envelope.ts';
import { FakeParticipant, USER_DATA_THEME, harness, readConfig } from './helpers.ts';

test('Setting_GlobalData: golden reply on the user\'s SoftConfig.data (20-backend-host-tail §5 step 14)', async (t) => {
  const h = await harness(t, { seed: true });
  assert.equal(
    await h.dispatcher.dispatch('{"functionName":"Setting_GlobalData","requestId":"4acabfda-1fb3-4219-b6dc-3b239819fcb9","parms":null}'),
    '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"4acabfda-1fb3-4219-b6dc-3b239819fcb9","Tag":{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5},"FunctionName":"Setting_GlobalData","CurrItem":null}',
  );
});

test('Setting_TurnOffLightsWhenIdle[Duration]: Tag null, persisted, duration < 1 refused (Bridge.cs:28-42)', async (t) => {
  const h = await harness(t, { seed: true });
  const path = join(h.serve, 'Config', 'SoftConfig.data');
  const r1 = await h.call('Setting_TurnOffLightsWhenIdle', true);
  assert.deepEqual([r1.err_code, r1.err_msg, r1.Tag], [0, '', null]);
  const r2 = await h.call('Setting_TurnOffLightsWhenIdleDuration', 0);
  assert.deepEqual([r2.err_code, r2.IsSucc, r2.err_msg, r2.Tag], [9, false, 'at last 1 minutes', null]);
  const r3 = await h.call('Setting_TurnOffLightsWhenIdleDuration', 30);
  assert.deepEqual([r3.err_code, r3.Tag], [0, null]);
  assert.equal(await readConfig(path), '{"TurnOffLightsWhenIdle":true,"TurnOffLightsWhenIdleDuration":30}');
  assert.deepEqual(h.store.getSoftConfig(), { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 30 });
  assert.deepEqual((await h.call('Setting_GlobalData')).Tag, { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 30 });
  const r4 = await h.call('Setting_TurnOffLightsWhenIdleDuration', 'x');
  assert.equal(r4.err_msg, 'params error: Zeasn.Com.Lib.JsonResult Setting_TurnOffLightsWhenIdleDuration(Int32)');
});

test('FactoryReset: wipes EvniaServe except logs, re-initialises, resets participants, Tag true (SO:254-303)', async (t) => {
  const h = await harness(t, { seed: true });
  const serve = h.serve;
  await mkdir(join(serve, 'logs'), { recursive: true });
  await writeFile(join(serve, 'logs', '2026-09-26.txt'), 'log');
  await writeFile(join(serve, 'Config', 'data.json'), '{"data":"[]","sign":"x"}');
  await mkdir(join(serve, 'Cache', 'Theme'), { recursive: true });
  await writeFile(join(serve, 'stray.txt'), 'x');
  const p = new FakeParticipant('{"Before":1}');
  h.store.registerParticipant(p);
  await h.call('Setting_TurnOffLightsWhenIdle', true);
  await h.call('Theme_AddProfile', 'User', 'P2');
  await h.call('Theme_Switch', 'User', 'P2');
  const events: string[] = [];
  h.store.onSwitched((e) => events.push(`${e.reason}:${e.theme}|${e.profile}`));

  const r = await h.call('FactoryReset');
  assert.deepEqual([r.err_code, r.err_msg, r.Tag], [0, '', true]);
  assert.deepEqual((await readdir(serve)).sort(), ['Config', 'Theme', 'logs']);
  assert.deepEqual(await readdir(join(serve, 'logs')), ['2026-09-26.txt']);
  assert.equal(await readConfig(join(serve, 'Theme', 'DataTheme.cfg')), USER_DATA_THEME);
  assert.deepEqual(await readdir(join(serve, 'Theme', 'User')), ['Default.pcenter']);
  assert.equal(
    await readConfig(join(serve, 'Theme', 'User', 'Default.pcenter')),
    '{"Sync_Profile":null,"Profiles":[{"ProfileDesc":{"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":""},"ProfileContent":"{\\"Reset\\":true,\\"ModelName\\":\\"PHL 34M2C8600\\"}"}]}',
  );
  assert.equal(p.resets, 1);
  assert.equal(h.store.currentThemeName(), 'User');
  assert.equal(h.store.currentProfileName(), 'Default');
  // Deviation B-11: the idle-lights settings are back to the defaults in memory and on disk.
  assert.deepEqual(h.store.getSoftConfig(), { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 });
  assert.deepEqual(await readdir(join(serve, 'Config')), ['SoftConfig.data']);
  assert.deepEqual(events, ['factory-reset:User|Default']);
  assert.deepEqual((await h.call('Theme_GetThemeInfos')).Tag, JSON.parse(USER_DATA_THEME).ThemeInfos);
});

test('FactoryReset outside an "EvniaServe" directory only removes the engine\'s own sub-trees', async (t) => {
  const h = await harness(t, { seed: true, start: false });
  // Re-root the same files under a differently named directory.
  const { cp, rm } = await import('node:fs/promises');
  const other = join(h.root, 'custom-root');
  await cp(h.serve, other, { recursive: true });
  await rm(h.serve, { recursive: true, force: true });
  await writeFile(join(other, 'keep.txt'), 'x');
  await mkdir(join(other, 'Unrelated'));
  const { createThemeStore } = await import('../../../src/backend/theme/store.ts');
  const store = createThemeStore({ ...h.core, host: { ...h.core.host, serveDataDir: other } }, { saveDebounceMs: 0 });
  await store.start();
  t.after(() => store.stop());
  const r = await store.factoryReset();
  assert.equal(r.err_code, 0);
  assert.deepEqual((await readdir(other)).sort(), ['Config', 'Theme', 'Unrelated', 'keep.txt']);
  assert.ok((await stat(join(other, 'Theme', 'User', 'Default.pcenter'))).isFile());
});

test('Setting_GlobalData belongs to settingApi alone (a second registration is a composition error)', () => {
  const log = createLogger('test', silentSink);
  const d = new RpcDispatcher(log);
  const services = { log, notifier: { notify() {} }, host: { log, serveDataDir: '/nonexistent/EvniaServe', appDataDir: '/nonexistent', resourcesDir: '/nonexistent' }, events: undefined, options: undefined } as never;
  // Another module registering Setting_GlobalData, as the removed wave-1 placeholder api/system-minimal.ts did.
  d.register('Setting_GlobalData', [], () => succ(null));
  assert.throws(() => settingApi(d, services), /already registered/);
  const d2 = new RpcDispatcher(log);
  for (const m of [themeApi, macroApi, settingApi]) m(d2, services);
  for (const name of ['Theme_Switch', 'Macro_GetFuncMenu', 'Setting_GlobalData', 'FactoryReset', 'Comm_GenAppIcon']) assert.ok(d2.has(name), name);
});
