import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIXTURE_DEFAULT_PCENTER, FakeParticipant, DISPLAY_DESC, USER_DATA_THEME, harness, readConfig } from './helpers.ts';

test('first run creates DataTheme.cfg, User/Default.pcenter and SoftConfig.data exactly like the vendor (20-theme §4)', async (t) => {
  const h = await harness(t);
  assert.equal(await readConfig(join(h.serve, 'Theme', 'DataTheme.cfg')), USER_DATA_THEME);
  assert.equal(await readConfig(join(h.serve, 'Theme', 'User', 'Default.pcenter')), '{"Sync_Profile":null,"Profiles":[]}');
  assert.equal(await readConfig(join(h.serve, 'Config', 'SoftConfig.data')), '{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5}');
  assert.equal(h.store.currentThemeName(), 'User');
  assert.equal(h.store.currentProfileName(), 'Default');
  assert.equal(h.store.themeRootDir, join(h.serve, 'Theme'));
  assert.equal(h.store.getStoredContent(DISPLAY_DESC), null);
  assert.equal(h.store.getSyncProfile(), null);
});

test('start-up on the user\'s Windows files: always User, stored content and Sync_Profile available, nothing rewritten', async (t) => {
  const h = await harness(t, { seed: true });
  const pcenter = join(h.serve, 'Theme', 'User', 'Default.pcenter');
  assert.deepEqual(await readFile(pcenter), await readFile(FIXTURE_DEFAULT_PCENTER));
  assert.equal(h.store.currentThemeName(), 'User');
  const content = h.store.getStoredContent(DISPLAY_DESC);
  assert.ok(content?.startsWith('{"IsSmartImageHDR":true,'));
  // ModelName is compared ordinally and case-sensitively (20-theme §5.4).
  assert.equal(h.store.getStoredContent({ ...DISPLAY_DESC, ModelName: 'phl 34m2c8600' }), null);
  assert.deepEqual(h.store.getSyncProfile(), { EffectDetailInfo: null, SyncDevices: [] });
  assert.deepEqual(h.store.getSoftConfig(), { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 });
});

test('the startup theme is User even when another theme was active', async (t) => {
  const h = await harness(t, { seed: true, start: false });
  await writeFile(
    join(h.serve, 'Theme', 'DataTheme.cfg'),
    '\ufeff{"ThemeInfos":[{"Name":"Game","IsDefault":false,"SelProfileName":"P2","ProfileNames":["P1","P2"],"CycleProfileNames":["P1","P2"],"BindAppInfos":[]},{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]}]}',
  );
  await h.store.start();
  assert.equal(h.store.currentThemeName(), 'User');
  assert.ok((await stat(join(h.serve, 'Theme', 'Game'))).isDirectory());
});

test('saveParticipant purifies every participant into the current profile, coalesced into one write', async (t) => {
  const h = await harness(t, { store: { saveDebounceMs: 30 } });
  const p = new FakeParticipant('{"A":1}');
  h.store.registerParticipant(p);
  const saves = [h.store.saveParticipant(p), h.store.saveParticipant(p)];
  p.content = '{"A":2}';
  await Promise.all(saves);
  const text = await readConfig(join(h.serve, 'Theme', 'User', 'Default.pcenter'));
  assert.equal(
    text,
    '{"Sync_Profile":null,"Profiles":[{"ProfileDesc":{"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":""},"ProfileContent":"{\\"A\\":2}"}]}',
  );
  assert.equal(h.store.getStoredContent(DISPLAY_DESC), '{"A":2}');
  // Empty content is refused like SaveProfileContent (content is empty!!!).
  p.content = '';
  await h.store.saveParticipant(p);
  assert.equal(h.store.getStoredContent(DISPLAY_DESC), '{"A":2}');
});

test('stop() writes a pending save', async (t) => {
  const h = await harness(t, { store: { saveDebounceMs: 10_000 } });
  const p = new FakeParticipant('{"B":1}');
  h.store.registerParticipant(p);
  const pending = h.store.saveParticipant(p);
  await h.store.stop();
  await pending;
  assert.match(await readConfig(join(h.serve, 'Theme', 'User', 'Default.pcenter')), /\{\\"B\\":1\}/);
});

test('a participant that saves from inside applyProfileContent does not deadlock the switch', async (t) => {
  const h = await harness(t, { seed: true });
  const p = new FakeParticipant();
  h.store.registerParticipant(p);
  p.onApply = () => h.store.saveParticipant(p);
  assert.equal((await h.call('Theme_AddProfile', 'User', 'P2')).err_code, 0);
  const r = await h.call('Theme_Switch', 'User', 'P2');
  assert.equal(r.err_code, 0);
  assert.deepEqual(p.applied, [null]); // new profile: no section for the display
});

test('SoftConfig: get/set persist only on change; the file is the vendor format', async (t) => {
  const h = await harness(t);
  const path = join(h.serve, 'Config', 'SoftConfig.data');
  const before = (await stat(path)).mtimeMs;
  await h.store.setSoftConfig({ TurnOffLightsWhenIdle: false });
  assert.equal((await stat(path)).mtimeMs, before);
  await h.store.setSoftConfig({ TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 12 });
  assert.equal(await readConfig(path), '{"TurnOffLightsWhenIdle":true,"TurnOffLightsWhenIdleDuration":12}');
  assert.deepEqual(h.store.getSoftConfig(), { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 12 });
});

test('an unparsable SoftConfig.data is replaced by the defaults (GO:77-94)', async (t) => {
  const h = await harness(t, { start: false });
  await mkdir(join(h.serve, 'Config'), { recursive: true });
  await writeFile(join(h.serve, 'Config', 'SoftConfig.data'), '{\n"TurnOffLightsWhenIdle":true}');
  await h.store.start();
  assert.equal(await readConfig(join(h.serve, 'Config', 'SoftConfig.data')), '{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5}');
});

test('Sync_Profile get/set is normalized to T_Sync_Profile and saved', async (t) => {
  const h = await harness(t, { seed: true });
  await h.store.setSyncProfile({ EffectDetailInfo: { Speed: 3 }, SyncDevices: [{ ModelName: 'PHL 34M2C8600', DeviceType: 100000, SyncStatus: true }] });
  const sync = h.store.getSyncProfile();
  assert.deepEqual(sync?.SyncDevices, [{ SyncStatus: true, Connect: false, EquipmentType: 0, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: null }]);
  const text = await readConfig(join(h.serve, 'Theme', 'User', 'Default.pcenter'));
  assert.ok(text.startsWith('{"Sync_Profile":{"EffectDetailInfo":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":3,'));
  await h.store.setSyncProfile(null);
  assert.ok((await readConfig(join(h.serve, 'Theme', 'User', 'Default.pcenter'))).startsWith('{"Sync_Profile":null,'));
});

test('switch applies the stored section to participants and saves their state into the target profile', async (t) => {
  const h = await harness(t, { seed: true });
  const p = new FakeParticipant('{"Live":1}');
  h.store.registerParticipant(p);
  const events: string[] = [];
  h.store.onSwitched((e) => events.push(`${e.reason}:${e.theme}|${e.profile}`));
  assert.equal((await h.call('Theme_AddProfile', 'User', 'Night')).err_code, 0);
  assert.equal((await h.call('Theme_Switch', 'User', 'Night')).err_code, 0);
  // The new profile had no section → null, and the live state was saved into it.
  assert.deepEqual(p.applied, [null]);
  assert.match(await readConfig(join(h.serve, 'Theme', 'User', 'Night.pcenter')), /"ProfileContent":"\{\\"Live\\":1\}"/);
  // Back to Default: its stored content is applied.
  p.content = '{"Live":2}';
  await h.call('Theme_Switch', 'User', 'Default');
  assert.ok(String(p.applied[1]).startsWith('{"IsSmartImageHDR":true,'));
  assert.deepEqual(events, ['switch:User|Night', 'switch:User|Default']);
  // The same theme/profile (case-insensitive) is a no-op.
  await h.call('Theme_Switch', 'user', 'DEFAULT');
  assert.equal(p.applied.length, 2);
});

test('a corrupt DataTheme.cfg is kept aside and replaced by the default index', async (t) => {
  const h = await harness(t, { seed: true, start: false });
  await writeFile(join(h.serve, 'Theme', 'DataTheme.cfg'), '\ufeff{"ThemeInfos":[{"Name":"Us');
  await h.store.start();
  assert.equal(await readConfig(join(h.serve, 'Theme', 'DataTheme.cfg')), USER_DATA_THEME);
  const kept = (await readdir(join(h.serve, 'Theme'))).filter((n) => n.startsWith('DataTheme.cfg.corrupt-'));
  assert.equal(kept.length, 1);
});

test('load-time repairs: invalid names, duplicates, IsDefault, SelProfileName and cycle list, Windows bindings', async (t) => {
  const h = await harness(t, { start: false });

  await mkdir(join(h.serve, 'Theme'), { recursive: true });
  await writeFile(
    join(h.serve, 'Theme', 'DataTheme.cfg'),
    '\ufeff' +
      JSON.stringify({
        ThemeInfos: [
          { Name: '..', IsDefault: false },
          null,
          { Name: 'App', IsDefault: true, SelProfileName: 'Gone', ProfileNames: ['A', '../../x', 'B', 'A', null], CycleProfileNames: ['B', 'Z', 'B'], BindAppInfos: [{ BindAppFilePath: 'C:\\Windows\\notepad.exe', BindAppIconPath: '' }, null] },
          { Name: 'app' },
          { Name: 'User', IsDefault: false },
        ],
      }),
  );
  await h.store.start();
  const r = await h.call('Theme_GetThemeInfos');
  assert.deepEqual(r.Tag, [
    { Name: 'App', IsDefault: false, SelProfileName: 'A', ProfileNames: ['A', 'B'], CycleProfileNames: ['B'], BindAppInfos: [] },
    { Name: 'User', IsDefault: true, SelProfileName: 'Default', ProfileNames: ['Default'], CycleProfileNames: ['Default'], BindAppInfos: [] },
  ]);
});

test('start() rejects with "InitEnviroment error" while DataTheme.cfg cannot be written, and retries (SO:107-133)', async (t) => {
  const h = await harness(t, { start: false });
  // A file where the Theme directory must go makes every write fail.
  await writeFile(join(h.serve, 'Theme'), 'not a directory');
  await assert.rejects(h.store.start(), /^Error: InitEnviroment error$/);
  // The in-memory defaults still answer.
  assert.deepEqual((await h.call('Theme_GetCurTheme')).Tag, JSON.parse(USER_DATA_THEME).ThemeInfos[0]);

  await rm(join(h.serve, 'Theme'));
  await h.store.start();
  assert.equal(await readConfig(join(h.serve, 'Theme', 'DataTheme.cfg')), USER_DATA_THEME);
  assert.deepEqual((await h.call('Macro_GetList', 'User')).Tag, [], 'Theme/User exists again');
});
