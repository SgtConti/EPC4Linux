import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TARGET_INVOCATION_MSG } from '../../../src/backend/theme/store.ts';
import { sha1Prefix10 } from '../../../src/backend/theme/names.ts';
import type { ForegroundAppHost } from '../../../src/backend/theme/app-binding.ts';
import type { HostServices } from '../../../src/backend/types.ts';
import { FIXTURE_DEFAULT_PCENTER, FakeParticipant, USER_DATA_THEME, fakeMonitors, harness, readConfig, type Harness } from './helpers.ts';

const USER_THEME = { Name: 'User', IsDefault: true, SelProfileName: 'Default', ProfileNames: ['Default'], CycleProfileNames: ['Default'], BindAppInfos: [] };

async function expectErr(h: Harness, code: number, msg: string, name: string, ...parms: unknown[]): Promise<void> {
  const r = await h.call(name, ...parms);
  assert.deepEqual({ err_code: r.err_code, IsSucc: r.IsSucc, err_msg: r.err_msg, Tag: r.Tag }, { err_code: code, IsSucc: false, err_msg: msg, Tag: null }, `${name}(${JSON.stringify(parms)})`);
}

async function expectOk(h: Harness, name: string, ...parms: unknown[]): Promise<unknown> {
  const r = await h.call(name, ...parms);
  assert.equal(r.err_code, 0, `${name}: ${r.err_msg}`);
  assert.equal(r.err_msg, '');
  return r.Tag;
}

/** An app to bind: an executable script plus a .desktop entry launching it, with an icon. */
async function makeApp(root: string, name: string): Promise<{ exe: string; desktop: string; icon: string }> {
  const dir = join(root, 'apps');
  await mkdir(dir, { recursive: true });
  const exe = join(dir, name);
  await writeFile(exe, '#!/bin/sh\nexit 0\n');
  await chmod(exe, 0o755);
  const icon = join(dir, `${name}.png`);
  await writeFile(icon, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  const desktop = join(dir, `${name}.desktop`);
  await writeFile(desktop, `[Desktop Entry]\nType=Application\nName=${name}\nName[de]=X\nExec="${exe}" --flag %U\nIcon=${icon}\n\n[Desktop Action new]\nExec=/bin/false\n`);
  return { exe, desktop, icon };
}

async function bindParam(h: Harness, ...paths: string[]): Promise<string> {
  const apps = [];
  for (const p of paths) apps.push({ BindAppFilePath: p, BindAppIconPath: String((await h.call('Comm_GenAppIcon', p)).Tag) });
  return JSON.stringify(apps);
}

async function addApp(t: TestContext, h: Harness, theme = 'App'): Promise<{ exe: string; desktop: string }> {
  void t;
  const app = await makeApp(h.root, theme.toLowerCase().replace(/\W/g, '') || 'app');
  assert.equal((await h.call('Theme_Add', theme, await bindParam(h, app.desktop))).err_code, 0);
  return app;
}

test('golden startup replies: Theme_GetThemeInfos and Theme_GetCurTheme (20-backend-host-tail §5 steps 5, 8)', async (t) => {
  const h = await harness(t, { seed: true });
  assert.equal(
    await h.dispatcher.dispatch('{"functionName":"Theme_GetThemeInfos","requestId":"e6efb073-8cf5-4399-ab31-7f09a738530d","parms":null}'),
    '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"e6efb073-8cf5-4399-ab31-7f09a738530d","Tag":[{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]}],"FunctionName":"Theme_GetThemeInfos","CurrItem":null}',
  );
  assert.equal(
    await h.dispatcher.dispatch('{"functionName":"Theme_GetCurTheme","requestId":"c2f07275-18af-4f8a-b4dc-24b60a8070a7","parms":null}'),
    '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"c2f07275-18af-4f8a-b4dc-24b60a8070a7","Tag":{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]},"FunctionName":"Theme_GetCurTheme","CurrItem":null}',
  );
  assert.equal(h.store.appWatchArmed, true, 'the startup calls arm CheckTopApp');
});

test('golden Theme_GetDevicesBasicInfo(-1) on the user\'s profile (20-backend-host-tail §5 step 18)', async (t) => {
  const h = await harness(t, { seed: true, monitors: fakeMonitors() });
  await writeFile(join(h.root, 'resources', 'MonitorInfo.json'), '{"Monitors":[{"Name":"34M2C8600","SupLightEffect":true,"SupLightSync":true,"HDR":400}],"Version":34}');
  const golden =
    '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"00000000-0000-4000-8000-000000000018","Tag":{"SyncEquipment":"","Display":[{"LightSync":"Off","LightMode":"StaticMode","Resolution":"3440x1440","RefreshRate":"175Hz","SmartImage":"/","Input":"Normal_DisplayPort1","AdaptiveSync":"On","Connect":true,"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":null}],"Keyboard":[],"Mouse":[],"MousePad":[],"Headset":[]},"FunctionName":"Theme_GetDevicesBasicInfo","CurrItem":null}';
  assert.equal(await h.dispatcher.dispatch('{"functionName":"Theme_GetDevicesBasicInfo","requestId":"00000000-0000-4000-8000-000000000018","parms":[-1]}'), golden);
  const tag = JSON.parse(golden).Tag;
  assert.deepEqual(await expectOk(h, 'Theme_GetDevicesBasicInfo', 'User', 'Default', -1), tag);
  assert.deepEqual(await expectOk(h, 'Theme_GetDevicesBasicInfo', 'user', 'Default', 1), tag);
  assert.deepEqual(await expectOk(h, 'Theme_GetDevicesBasicInfo', FIXTURE_DEFAULT_PCENTER, -1), tag);
  const empty = { SyncEquipment: '', Display: [], Keyboard: [], Mouse: [], MousePad: [], Headset: [] };
  assert.deepEqual(await expectOk(h, 'Theme_GetDevicesBasicInfo', 'User', 'Default', 2), empty);
  assert.deepEqual(await expectOk(h, 'Theme_GetDevicesBasicInfo', 'Nope', 'Default', -1), empty);
  assert.deepEqual(await expectOk(h, 'Theme_GetDevicesBasicInfo', 'User', 'Nope', -1), empty);
  assert.deepEqual(await expectOk(h, 'Theme_GetDevicesBasicInfo', '/nonexistent.pcenter', -1), empty);
  await expectErr(
    h,
    9,
    'params error: Zeasn.Com.Lib.JsonResult Theme_GetDevicesBasicInfo(Int32) | Zeasn.Com.Lib.JsonResult Theme_GetDevicesBasicInfo(System.String, System.String, Int32) | Zeasn.Com.Lib.JsonResult Theme_GetDevicesBasicInfo(System.String, Int32)',
    'Theme_GetDevicesBasicInfo',
  );
});

test('Theme_GetDevicesBasicInfo without a connected display or MonitorInfo entry', async (t) => {
  const h = await harness(t, { seed: true });
  const tag = (await expectOk(h, 'Theme_GetDevicesBasicInfo', -1)) as { Display: { Connect: boolean; LightSync: string }[] };
  assert.equal(tag.Display[0].Connect, false);
  assert.equal(tag.Display[0].LightSync, '/');
});

test('Theme_Switch / Theme_SwitchApp: checks, texts and the same-profile shortcut (SO:3019-3059)', async (t) => {
  const h = await harness(t, { seed: true });
  await expectErr(h, 9, 'ThemeSwitch themeName is null', 'Theme_Switch', '', '');
  await expectErr(h, 9, 'ThemeSwitch themeName=Nope not exit profileName is null', 'Theme_Switch', 'Nope', '');
  await expectErr(h, 9, 'ThemeSwitch ThemeName=User or ProfileName=Nope not contains', 'Theme_Switch', 'User', 'Nope');
  await expectOk(h, 'Theme_AddProfile', 'User', 'P2');
  // Profiles are case-sensitive in ThemeOper.ThemeSwitch.
  await expectErr(h, 9, 'ThemeSwitch ThemeName=User or ProfileName=p2 not contains', 'Theme_Switch', 'User', 'p2');
  assert.deepEqual(await expectOk(h, 'Theme_Switch', 'user', 'DEFAULT'), { ...USER_THEME, ProfileNames: ['Default', 'P2'], CycleProfileNames: ['Default', 'P2'] });
  const tag = (await expectOk(h, 'Theme_Switch', 'user', 'P2')) as { Name: string; SelProfileName: string };
  assert.equal(tag.Name, 'User');
  assert.equal(tag.SelProfileName, 'P2');
  // The new profile file was created, then filled by ThemeSaveCurProfiles.
  assert.equal(await readConfig(join(h.serve, 'Theme', 'User', 'P2.pcenter')), '{"Sync_Profile":null,"Profiles":[]}');
  assert.equal((await expectOk(h, 'Theme_SwitchApp', 'USER') as { SelProfileName: string }).SelProfileName, 'P2');
  await expectErr(h, 9, 'ThemeSwitch themeName=Nope not exit profileName is null', 'Theme_SwitchApp', 'Nope');
  await expectErr(h, 9, 'params error: Zeasn.Com.Lib.JsonResult Theme_Switch(System.String, System.String)', 'Theme_Switch', 'User');
});

test('Theme_Add: checks in order, bindings must exist, icons move into Theme/<T>/Icon (TO:41-71, 181-209)', async (t) => {
  const h = await harness(t, { seed: true });
  const app = await makeApp(h.root, 'tool');
  await expectErr(h, 2, 'ThemeAdd Error ThemeName=a/b Not Valid', 'Theme_Add', 'a/b', '[]');
  await expectErr(h, 2, 'ThemeAdd Error ThemeName=.. Not Valid', 'Theme_Add', '..', '[]');
  await expectErr(h, 4, 'ThemeAdd Error ThemeName=user Exist', 'Theme_Add', 'user', '[]');
  await expectErr(h, 8, 'ThemeAdd Error param= Not Exist', 'Theme_Add', 'App', '');
  const missing = JSON.stringify([{ BindAppFilePath: '/nope/app.desktop', BindAppIconPath: '' }]);
  await expectErr(h, 8, `ThemeAdd Error param=${missing} Not Exist`, 'Theme_Add', 'App', missing);
  await expectErr(h, 8, 'ThemeAdd Error param={ Not Exist', 'Theme_Add', 'App', '{');
  // A pre-existing directory is deleted first.
  await mkdir(join(h.serve, 'Theme', 'App', 'junk'), { recursive: true });
  const param = await bindParam(h, app.desktop);
  const tempIcon = JSON.parse(param)[0].BindAppIconPath as string;
  assert.ok(tempIcon.startsWith(join(h.root, 'tmp-EvniaServe')) && tempIcon.endsWith('.png'));
  const tag = (await expectOk(h, 'Theme_Add', 'App', param)) as unknown[];
  const icon = join(h.serve, 'Theme', 'App', 'Icon', `${sha1Prefix10(app.desktop)}.png`);
  assert.deepEqual(tag, [
    USER_THEME,
    { Name: 'App', IsDefault: false, SelProfileName: 'Default', ProfileNames: ['Default'], CycleProfileNames: ['Default'], BindAppInfos: [{ BindAppFilePath: app.desktop, BindAppIconPath: icon }] },
  ]);
  assert.deepEqual(await readdir(join(h.serve, 'Theme', 'App')), ['Icon']); // no .pcenter, junk gone
  await assert.rejects(stat(tempIcon));
  assert.deepEqual(await readFile(icon), await readFile(app.icon));
  assert.equal(await readConfig(join(h.serve, 'Theme', 'DataTheme.cfg')), JSON.stringify({ ThemeInfos: tag }));
});

test('Theme_Add hardening: this app cannot be bound; only real temp icons are moved', async (t) => {
  const h = await harness(t, { seed: true });
  const self = JSON.stringify([{ BindAppFilePath: process.execPath, BindAppIconPath: '' }]);
  await expectErr(h, 8, `ThemeAdd Error param=${self} Not Exist`, 'Theme_Add', 'App', self);
  const app = await makeApp(h.root, 'tool');
  // A path that merely contains PATH_APP_TEMP but resolves elsewhere is not moved.
  const victim = join(h.root, 'victim.png');
  await writeFile(victim, 'user file');
  const crafted = join(h.root, 'tmp-EvniaServe', '..', 'victim.png');
  const tag = (await expectOk(h, 'Theme_Add', 'App', JSON.stringify([{ BindAppFilePath: app.desktop, BindAppIconPath: crafted }]))) as {
    BindAppInfos: { BindAppIconPath: string }[];
  }[];
  assert.equal(tag[1].BindAppInfos[0].BindAppIconPath, crafted);
  assert.equal(await readFile(victim, 'utf8'), 'user file');
});

test('Theme_Del (SO:3066-3073, TO:73-87)', async (t) => {
  const h = await harness(t, { seed: true });
  await addApp(t, h);
  await expectErr(h, 8, "Can't del curThemeInfo user", 'Theme_Del', 'user');
  await expectErr(h, 3, 'ThemeDel Error ThemeName=Nope Not Exist', 'Theme_Del', 'Nope');
  await expectOk(h, 'Theme_Switch', 'App', '');
  await expectErr(h, 7, 'ThemeDel Error ThemeName=User IsDefault', 'Theme_Del', 'User');
  await expectOk(h, 'Theme_Switch', 'User', '');
  const tag = await expectOk(h, 'Theme_Del', 'app');
  assert.deepEqual(tag, [USER_THEME]);
  await assert.rejects(stat(join(h.serve, 'Theme', 'App')));
});

test('Theme_Rename (TO:89-132): vendor texts, directory moved, bound paths rewritten', async (t) => {
  const h = await harness(t, { seed: true });
  await addApp(t, h);
  await expectErr(h, 2, 'ThemeRename Error ThemeName=a|b Not Valid', 'Theme_Rename', 'App', 'a|b');
  await expectErr(h, 4, 'ThemeAdd Error ThemeName=App Exist', 'Theme_Rename', 'App', 'user');
  await expectErr(h, 3, 'ThemeRename Error ThemeName=Nope Not Exist', 'Theme_Rename', 'Nope', 'X');
  await expectErr(h, 7, 'ThemeRename Error ThemeName=User IsDefault', 'Theme_Rename', 'User', 'X');
  const tag = (await expectOk(h, 'Theme_Rename', 'app', 'Games')) as { Name: string; BindAppInfos: { BindAppIconPath: string }[] }[];
  assert.equal(tag[1].Name, 'Games');
  assert.ok(tag[1].BindAppInfos[0].BindAppIconPath.startsWith(join(h.serve, 'Theme', 'Games', 'Icon')));
  assert.ok((await stat(tag[1].BindAppInfos[0].BindAppIconPath)).isFile());
  await assert.rejects(stat(join(h.serve, 'Theme', 'App')));
});

test('Theme_UpdateBindApp (TO:134-152): replaces bindings, deletes icons of removed apps', async (t) => {
  const h = await harness(t, { seed: true });
  await addApp(t, h);
  const other = await makeApp(h.root, 'other');
  await expectErr(h, 3, 'ThemeUpdateBindApp Error ThemeName=Nope Not Exist', 'Theme_UpdateBindApp', 'Nope', '[]');
  await expectErr(h, 7, 'ThemeUpdateBindApp Error Error ThemeName=User IsDefault', 'Theme_UpdateBindApp', 'User', '[]');
  await expectErr(h, 8, 'ThemeUpdateBindApp Error AppPath=[] Not Exist', 'Theme_UpdateBindApp', 'App', '[]');
  const oldIcon = ((await h.call('Theme_GetThemeInfos')).Tag as { BindAppInfos: { BindAppIconPath: string }[] }[])[1].BindAppInfos[0].BindAppIconPath;
  const tag = (await expectOk(h, 'Theme_UpdateBindApp', 'App', await bindParam(h, other.desktop))) as { BindAppInfos: { BindAppFilePath: string }[] }[];
  assert.deepEqual(tag[1].BindAppInfos.map((b) => b.BindAppFilePath), [other.desktop]);
  await assert.rejects(stat(oldIcon));
  // An icon path outside the theme's Icon dir is never deleted, and a missing one becomes "".
  const outside = join(h.root, 'keep.png');
  await writeFile(outside, 'x');
  await expectOk(h, 'Theme_UpdateBindApp', 'App', JSON.stringify([{ BindAppFilePath: other.exe, BindAppIconPath: outside }]));
  const t2 = (await expectOk(h, 'Theme_UpdateBindApp', 'App', JSON.stringify([{ BindAppFilePath: other.desktop, BindAppIconPath: '/nope.png' }]))) as { BindAppInfos: { BindAppIconPath: string }[] }[];
  assert.equal(t2[1].BindAppInfos[0].BindAppIconPath, '');
  assert.ok((await stat(outside)).isFile());
});

test('profile management: Theme_AddProfile / CopyProfile / RenameProfile (TO:268-386)', async (t) => {
  const h = await harness(t, { seed: true });
  const dir = join(h.serve, 'Theme', 'User');
  await expectErr(h, 2, 'ThemeCopyProfile Error ProfileName=a:b Not Valid', 'Theme_AddProfile', 'User', 'a:b');
  await expectErr(h, 3, 'ThemeAddProfile Error ThemeName=Nope Not Exist', 'Theme_AddProfile', 'Nope', 'P');
  await expectErr(h, 6, 'ThemeAddProfile Error ProfileName=Default Exist', 'Theme_AddProfile', 'User', 'Default');
  const added = (await expectOk(h, 'Theme_AddProfile', 'user', 'P2')) as { ProfileNames: string[]; CycleProfileNames: string[] }[];
  assert.deepEqual([added[0].ProfileNames, added[0].CycleProfileNames], [['Default', 'P2'], ['Default', 'P2']]);
  await assert.rejects(stat(join(dir, 'P2.pcenter')));

  await expectErr(h, 3, 'ThemeCopyProfile Error ThemeName=Nope Not Exist', 'Theme_CopyProfile', 'Nope', 'Default', 'X');
  await expectErr(h, 5, 'ThemeCopyProfile Error ProfileName=Nope Not Exist', 'Theme_CopyProfile', 'User', 'Nope', 'X');
  await expectErr(h, 5, `ThemeCopyProfile Error OriProfilePath=${join(dir, 'P2.pcenter')} Not Exist`, 'Theme_CopyProfile', 'User', 'P2', 'X');
  await expectErr(h, 2, 'ThemeCopyProfile Error newProfileName=a*b Not Valid', 'Theme_CopyProfile', 'User', 'Default', 'a*b');
  await expectErr(h, 6, 'ThemeCopyProfile Error NewProfileName=P2 Exist', 'Theme_CopyProfile', 'User', 'Default', 'P2');
  const copied = (await expectOk(h, 'Theme_CopyProfile', 'User', 'Default', 'Default(1)')) as { ProfileNames: string[] }[];
  assert.deepEqual(copied[0].ProfileNames, ['Default', 'P2', 'Default(1)']);
  assert.deepEqual(await readFile(join(dir, 'Default(1).pcenter')), await readFile(FIXTURE_DEFAULT_PCENTER));
  await writeFile(join(dir, 'Default(1).pcenter'), '{\n}');
  await expectErr(h, 7, `ThemeCopyProfile LoadProfile=${join(dir, 'Default(1).pcenter')} Error`, 'Theme_CopyProfile', 'User', 'Default(1)', 'Z');

  await expectErr(h, 3, 'ThemeRenameProfile Error ThemeName=Nope Not Exist', 'Theme_RenameProfile', 'Nope', 'a', 'b');
  await expectErr(h, 5, 'ThemeRenameProfile Error ProfileName=Nope Not Exist', 'Theme_RenameProfile', 'User', 'Nope', 'b');
  await expectErr(h, 5, `ThemeRenameProfile Error OriProfilePath=${join(dir, 'P2.pcenter')} Not Exist`, 'Theme_RenameProfile', 'User', 'P2', 'b');
  await expectErr(h, 2, 'ThemeRenameProfile Error newProfileName=b? Not Valid', 'Theme_RenameProfile', 'User', 'Default', 'b?');
  await expectErr(h, 6, 'ThemeRenameProfile Error NewProfileName=P2 Exist', 'Theme_RenameProfile', 'User', 'Default', 'P2');
  await expectErr(h, 7, `ThemeRenameProfile LoadProfile=${join(dir, 'Default(1).pcenter')} Error`, 'Theme_RenameProfile', 'User', 'Default(1)', 'Z');
  // Renaming the current profile moves the file and SelProfileName; later saves go to the new file.
  const p = new FakeParticipant('{"After":1}');
  h.store.registerParticipant(p);
  const renamed = (await expectOk(h, 'Theme_RenameProfile', 'User', 'Default', 'Main')) as { SelProfileName: string; ProfileNames: string[]; CycleProfileNames: string[] }[];
  assert.deepEqual([renamed[0].SelProfileName, renamed[0].ProfileNames, renamed[0].CycleProfileNames], ['Main', ['Main', 'P2', 'Default(1)'], ['Main', 'P2', 'Default(1)']]);
  await assert.rejects(stat(join(dir, 'Default.pcenter')));
  assert.deepEqual(await readFile(join(dir, 'Main.pcenter')), await readFile(FIXTURE_DEFAULT_PCENTER));
  await h.store.saveParticipant(p);
  assert.match(await readConfig(join(dir, 'Main.pcenter')), /\{\\"After\\":1\}/);
});

test('Theme_DelProfile (SO:3244-3251, TO:388-411)', async (t) => {
  const h = await harness(t, { seed: true });
  await addApp(t, h);
  await expectErr(h, 9, "Can't del curThemeInfo user | default", 'Theme_DelProfile', 'user', 'default');
  await expectErr(h, 3, 'ThemeDelProfile Error ThemeName=Nope Not Exist', 'Theme_DelProfile', 'Nope', 'X');
  await expectErr(h, 5, 'ThemeDelProfile Error ProfileName=Nope Not Exist', 'Theme_DelProfile', 'App', 'Nope');
  await expectErr(h, 9, 'ThemeDelProfile Error ProfileNames Count at last one', 'Theme_DelProfile', 'App', 'Default');
  await expectOk(h, 'Theme_AddProfile', 'App', 'P2');
  await expectOk(h, 'Theme_Switch', 'App', 'P2');
  await expectOk(h, 'Theme_Switch', 'User', 'Default');
  const tag = (await expectOk(h, 'Theme_DelProfile', 'App', 'P2')) as { SelProfileName: string; ProfileNames: string[]; CycleProfileNames: string[] }[];
  assert.deepEqual([tag[1].SelProfileName, tag[1].ProfileNames, tag[1].CycleProfileNames], ['Default', ['Default'], ['Default']]);
  await assert.rejects(stat(join(h.serve, 'Theme', 'App', 'P2.pcenter')));
});

test('Theme_ImportProfile: errors, naming, and a Windows-exported .pcenter imported unchanged (TO:413-446)', async (t) => {
  const h = await harness(t, { seed: true });
  const dir = join(h.serve, 'Theme', 'User');
  // The renderer imports a copy named <userData>/<basename without .pcenter> (ST:43076-43097).
  const src = join(h.root, 'evnia', 'Default');
  await copyFile(FIXTURE_DEFAULT_PCENTER, src);
  await expectErr(h, 3, 'ThemeImportProfile Error ThemeName=Nope Not Exist', 'Theme_ImportProfile', 'Nope', src, false);
  await expectErr(h, 8, 'ThemeImportProfile Error FilePath=/nope.pcenter Not Exist', 'Theme_ImportProfile', 'User', '/nope.pcenter', false);
  const bad = join(h.root, 'evnia', 'Bad');
  await writeFile(bad, '{\n"Profiles":[]}');
  await expectErr(h, 7, `ThemeImportProfile LoadProfile=${bad} Error`, 'Theme_ImportProfile', 'User', bad, false);
  const empty = join(h.root, 'evnia', 'Empty');
  await writeFile(empty, '{"Sync_Profile":null,"Profiles":[]}');
  await expectErr(h, 10, `ThemeImportProfile  LoadProfile=${empty} Profiles is empty`, 'Theme_ImportProfile', 'User', empty, false);
  await expectErr(h, 9, 'params error: Zeasn.Com.Lib.JsonResult Theme_ImportProfile(System.String, System.String, Boolean)', 'Theme_ImportProfile', 'User', src);

  const tag = (await expectOk(h, 'Theme_ImportProfile', 'User', src, false)) as { ProfileNames: string[] }[];
  assert.deepEqual(tag[0].ProfileNames, ['Default', 'Default(1)']);
  assert.deepEqual(await readFile(join(dir, 'Default(1).pcenter')), await readFile(FIXTURE_DEFAULT_PCENTER));
  // Invalid file names fall back to "Default" (GenValidName).
  const weird = join(h.root, 'evnia', 'a|b.pcenter');
  await copyFile(FIXTURE_DEFAULT_PCENTER, weird);
  assert.deepEqual(((await expectOk(h, 'Theme_ImportProfile', 'User', weird, true)) as { ProfileNames: string[] }[])[0].ProfileNames, ['Default', 'Default(1)', 'Default(2)']);

  // Override of the current profile re-applies it (Theme_Switch bApply).
  const p = new FakeParticipant('{"Live":1}');
  h.store.registerParticipant(p);
  const events: string[] = [];
  h.store.onSwitched((e) => events.push(e.reason));
  await expectOk(h, 'Theme_ImportProfile', 'User', src, true);
  assert.equal(p.applied.length, 1);
  assert.ok(p.applied[0]?.startsWith('{"IsSmartImageHDR":true,'));
  assert.deepEqual(events, ['import']);
});

test('new names: no leading/trailing space or dot; profile names unique ignoring case (20-theme §10.1, B-10)', async (t) => {
  const h = await harness(t, { seed: true });
  const dir = join(h.serve, 'Theme', 'User');
  for (const bad of ['Night.', ' default ', '.hidden', 'Night ']) {
    await expectErr(h, 2, `ThemeCopyProfile Error ProfileName=${bad} Not Valid`, 'Theme_AddProfile', 'User', bad);
  }
  await expectErr(h, 6, 'ThemeAddProfile Error ProfileName=DEFAULT Exist', 'Theme_AddProfile', 'User', 'DEFAULT');
  await expectErr(h, 2, 'ThemeAdd Error ThemeName=Game. Not Valid', 'Theme_Add', 'Game.', '[]');
  await expectErr(h, 2, 'ThemeRename Error ThemeName= X Not Valid', 'Theme_Rename', 'App', ' X');
  await expectOk(h, 'Theme_AddProfile', 'User', 'P2');
  await expectErr(h, 6, 'ThemeCopyProfile Error NewProfileName=p2 Exist', 'Theme_CopyProfile', 'User', 'Default', 'p2');
  await expectErr(h, 2, 'ThemeCopyProfile Error newProfileName=Copy. Not Valid', 'Theme_CopyProfile', 'User', 'Default', 'Copy.');
  await expectOk(h, 'Theme_Switch', 'User', 'P2');
  await expectOk(h, 'Theme_Switch', 'User', 'Default');
  await expectErr(h, 6, 'ThemeRenameProfile Error NewProfileName=default Exist', 'Theme_RenameProfile', 'User', 'P2', 'default');
  await expectErr(h, 6, 'ThemeRenameProfile Error NewProfileName=P2 Exist', 'Theme_RenameProfile', 'User', 'P2', 'P2');
  // A case-only rename of the profile itself is allowed (Windows allows it too).
  const renamed = (await expectOk(h, 'Theme_RenameProfile', 'User', 'P2', 'p2')) as { ProfileNames: string[] }[];
  assert.deepEqual(renamed[0].ProfileNames, ['Default', 'p2']);
  assert.deepEqual((await readdir(dir)).sort(), ['Default.pcenter', 'p2.pcenter']);

  // Import with override of "default" while User/Default is current: overwrites and re-applies Default
  // instead of adding a second, case-variant profile with its own file.
  const src = join(h.root, 'evnia', 'default');
  await copyFile(FIXTURE_DEFAULT_PCENTER, src);
  const p = new FakeParticipant('{"Live":1}');
  h.store.registerParticipant(p);
  const tag = (await expectOk(h, 'Theme_ImportProfile', 'User', src, true)) as { SelProfileName: string; ProfileNames: string[] }[];
  assert.deepEqual([tag[0].SelProfileName, tag[0].ProfileNames], ['Default', ['Default', 'p2']]);
  assert.equal(p.applied.length, 1, 'the current profile was re-applied');
  assert.deepEqual((await readdir(dir)).sort(), ['Default.pcenter', 'p2.pcenter']);
  // Without override the case-variant name gets a suffix.
  const tag2 = (await expectOk(h, 'Theme_ImportProfile', 'User', src, false)) as { ProfileNames: string[] }[];
  assert.deepEqual(tag2[0].ProfileNames, ['Default', 'p2', 'default(1)']);
});

test('Theme_ExportProfile writes the stored file to exactly the given path (TO:448-478)', async (t) => {
  const h = await harness(t, { seed: true });
  const dir = join(h.serve, 'Theme', 'User');
  const out = join(h.root, 'exported');
  await expectErr(h, 3, 'ThemeExportProfile Error ThemeName=Nope Not Exist', 'Theme_ExportProfile', 'Nope', 'Default', out);
  await expectErr(h, 5, 'ThemeExportProfile Error ProfileName=Nope Not Exist', 'Theme_ExportProfile', 'User', 'Nope', out);
  await expectOk(h, 'Theme_AddProfile', 'User', 'P2');
  await expectErr(h, 5, `ThemeExportProfile Error OriProfilePath=${join(dir, 'P2.pcenter')} Not Exist`, 'Theme_ExportProfile', 'User', 'P2', out);
  await writeFile(join(dir, 'P2.pcenter'), '{"Profiles":[]}');
  await expectErr(h, 10, `ThemeExportProfile  LoadProfile=${join(dir, 'P2.pcenter')} Profiles is empty`, 'Theme_ExportProfile', 'User', 'P2', out);
  await writeFile(join(dir, 'P2.pcenter'), 'x');
  await expectErr(h, 7, `ThemeExportProfile LoadProfile=${join(dir, 'P2.pcenter')} Error`, 'Theme_ExportProfile', 'User', 'P2', out);
  await expectErr(h, 9, 'ThemeExportProfile SaveTXTConfig Error', 'Theme_ExportProfile', 'User', 'Default', h.serve);
  assert.equal(await expectOk(h, 'Theme_ExportProfile', 'User', 'Default', out), null);
  assert.deepEqual(await readFile(out), await readFile(FIXTURE_DEFAULT_PCENTER));
});

test('Theme_HandleCycleProfile (TO:480-501)', async (t) => {
  const h = await harness(t, { seed: true });
  await expectErr(h, 3, 'ThemeHandleCycleProfile Error ThemeName=Nope Not Exist', 'Theme_HandleCycleProfile', 'Nope', 'Default', true);
  await expectErr(h, 5, 'ThemeHandleCycleProfile Error ProfileName=Nope Not Exist', 'Theme_HandleCycleProfile', 'User', 'Nope', true);
  await expectOk(h, 'Theme_AddProfile', 'User', 'B');
  await expectOk(h, 'Theme_AddProfile', 'User', 'C');
  await expectOk(h, 'Theme_HandleCycleProfile', 'User', 'Default', false);
  await expectOk(h, 'Theme_HandleCycleProfile', 'User', 'B', false);
  const tag = (await expectOk(h, 'Theme_HandleCycleProfile', 'User', 'Default', true)) as { CycleProfileNames: string[] }[];
  assert.deepEqual(tag[0].CycleProfileNames, ['Default', 'C']);
});

test('Theme_ResetCurProfile: participants reset, profile rebuilt from them, Tag null (SO:3277-3293)', async (t) => {
  const h = await harness(t, { seed: true });
  const p = new FakeParticipant();
  h.store.registerParticipant(p);
  assert.equal(await expectOk(h, 'Theme_ResetCurProfile'), null);
  assert.equal(p.resets, 1);
  assert.equal(
    await readConfig(join(h.serve, 'Theme', 'User', 'Default.pcenter')),
    '{"Sync_Profile":{"EffectDetailInfo":null,"SyncDevices":[]},"Profiles":[{"ProfileDesc":{"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":""},"ProfileContent":"{\\"Reset\\":true,\\"ModelName\\":\\"PHL 34M2C8600\\"}"}]}',
  );
});

test('Theme_GetCurProfile returns the in-memory profile with nulls kept', async (t) => {
  const h = await harness(t);
  assert.deepEqual(await expectOk(h, 'Theme_GetCurProfile'), { Sync_Profile: null, Profiles: [] });
});

test('Theme_GetProfileDesc ×2 (TO:536-586)', async (t) => {
  const h = await harness(t, { seed: true });
  const dir = join(h.serve, 'Theme', 'User');
  const desc = [{ EquipmentType: 1, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: '' }];
  await expectErr(h, 8, 'AnalyseProfile ProfilePath=/nope Not Exist', 'Theme_GetProfileDesc', '/nope');
  const bad = join(h.root, 'bad');
  await writeFile(bad, 'x');
  await expectErr(h, 7, `AnalyseProfile LoadProfile=${bad} Error`, 'Theme_GetProfileDesc', bad);
  await writeFile(bad, '{"Profiles":[]}');
  await expectErr(h, 10, `AnalyseProfile  LoadProfile=${bad} Profiles is empty`, 'Theme_GetProfileDesc', bad);
  assert.deepEqual(await expectOk(h, 'Theme_GetProfileDesc', FIXTURE_DEFAULT_PCENTER), { Item1: FIXTURE_DEFAULT_PCENTER, Item2: desc });

  await expectErr(h, 3, 'GetProfileDesc Error ThemeName=Nope Not Exist', 'Theme_GetProfileDesc', 'Nope', 'Default');
  await expectErr(h, 5, 'GetProfileDesc Error ProfileName=Nope Not Exist', 'Theme_GetProfileDesc', 'User', 'Nope');
  await expectOk(h, 'Theme_AddProfile', 'User', 'P2');
  await expectErr(h, 8, `GetProfileDesc Error ProfilePath=${join(dir, 'P2.pcenter')} Not Exist`, 'Theme_GetProfileDesc', 'User', 'P2');
  await writeFile(join(dir, 'P2.pcenter'), '{"Profiles":[]}');
  await expectErr(h, 10, `AnalyseProfile  LoadProfile=${join(dir, 'P2.pcenter')} Profiles is empty`, 'Theme_GetProfileDesc', 'User', 'P2');
  assert.deepEqual(await expectOk(h, 'Theme_GetProfileDesc', 'User', 'Default'), { Item1: join(dir, 'Default.pcenter'), Item2: desc });
});

test('Theme_ApplyProfile (TO:622-699): checks, new theme creation, apply', async (t) => {
  const h = await harness(t, { seed: true });
  const sel = JSON.stringify([{ DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtValue: '' }]);
  await expectErr(h, 2, 'ApplyProfile Error ThemeName=.. or  ProfileName=P Not Valid', 'Theme_ApplyProfile', '..', 'P', FIXTURE_DEFAULT_PCENTER, sel);
  await expectErr(h, 9, TARGET_INVOCATION_MSG, 'Theme_ApplyProfile', 'Cloud', 'P', FIXTURE_DEFAULT_PCENTER, 'x');
  await expectErr(h, 9, 'ApplyProfile selDevices=[] is error', 'Theme_ApplyProfile', 'Cloud', 'P', FIXTURE_DEFAULT_PCENTER, '[]');
  await expectErr(h, 7, 'ApplyProfile LoadProfile=/nope Error', 'Theme_ApplyProfile', 'Cloud', 'P', '/nope', sel);
  const other = JSON.stringify([{ DeviceType: 100000, ModelName: 'PHL 27M2N5500' }]);
  await expectErr(h, 10, `ApplyProfile LoadProfile=${FIXTURE_DEFAULT_PCENTER} sel profiles is empty`, 'Theme_ApplyProfile', 'Cloud', 'P', FIXTURE_DEFAULT_PCENTER, other);
  const p = new FakeParticipant('{"Live":1}');
  h.store.registerParticipant(p);
  const tag = (await expectOk(h, 'Theme_ApplyProfile', 'Cloud', 'P', FIXTURE_DEFAULT_PCENTER, sel)) as { Name: string; SelProfileName: string; ProfileNames: string[] }[];
  assert.deepEqual(tag.map((x) => [x.Name, x.SelProfileName, x.ProfileNames]), [['User', 'Default', ['Default']], ['Cloud', 'P', ['P']]]);
  assert.equal(h.store.currentThemeName(), 'Cloud');
  assert.ok(p.applied[0]?.startsWith('{"IsSmartImageHDR":true,'));
});

test('Comm_GenAppIcon: .desktop Icon= resolved to a temp PNG, "" otherwise (GO:134-146, 20-theme §10.2)', async (t) => {
  const iconsRoot = await mkdtemp(join(tmpdir(), 'evnia-xdg-'));
  t.after(() => rm(iconsRoot, { recursive: true, force: true }));
  const env = { HOME: iconsRoot, XDG_DATA_HOME: join(iconsRoot, 'home'), XDG_DATA_DIRS: join(iconsRoot, 'share'), PATH: '/usr/bin:/bin' };
  const h = await harness(t, { seed: true, store: { env } });
  assert.equal(await expectOk(h, 'Comm_GenAppIcon', ''), '');
  assert.equal(await expectOk(h, 'Comm_GenAppIcon', '/nope/x.desktop'), '');
  const app = await makeApp(h.root, 'tool');
  const p1 = (await expectOk(h, 'Comm_GenAppIcon', app.desktop)) as string;
  const p2 = (await expectOk(h, 'Comm_GenAppIcon', app.desktop)) as string;
  assert.match(p1, /\/tmp-EvniaServe\/\d+(_\d+)?\.png$/);
  assert.notEqual(p1, p2, 'two icons in the same second do not overwrite each other');
  assert.deepEqual(await readFile(p1), await readFile(app.icon));
  // Themed icon name through $XDG_DATA_DIRS/icons/hicolor.
  const themed = join(iconsRoot, 'share', 'icons', 'hicolor', '48x48', 'apps');
  await mkdir(themed, { recursive: true });
  await writeFile(join(themed, 'org.example.Tool.png'), 'png');
  const desk = join(h.root, 'themed.desktop');
  await writeFile(desk, '[Desktop Entry]\nName=T\nExec=tool\nIcon=org.example.Tool\n');
  assert.match((await expectOk(h, 'Comm_GenAppIcon', desk)) as string, /\.png$/);
  // SVG icons keep their extension.
  const scalable = join(iconsRoot, 'share', 'icons', 'hicolor', 'scalable', 'apps');
  await mkdir(scalable, { recursive: true });
  await writeFile(join(scalable, 'vec.svg'), '<svg/>');
  await writeFile(desk, '[Desktop Entry]\nName=T\nIcon=vec\n');
  assert.match((await expectOk(h, 'Comm_GenAppIcon', desk)) as string, /\.svg$/);
  // An executable finds its icon through the desktop entry that launches it.
  const appsDir = join(iconsRoot, 'share', 'applications');
  await mkdir(appsDir, { recursive: true });
  await writeFile(join(appsDir, 'tool.desktop'), `[Desktop Entry]\nName=Tool\nExec=env A=1 ${app.exe} %F\nIcon=org.example.Tool\n`);
  assert.match((await expectOk(h, 'Comm_GenAppIcon', app.exe)) as string, /\.png$/);
  // No icon anywhere → "".
  await writeFile(desk, '[Desktop Entry]\nName=T\nIcon=does-not-exist\n');
  assert.equal(await expectOk(h, 'Comm_GenAppIcon', desk), '');
});

test('CheckTopApp: NotifyUISwitchTheme with the bound theme or "User"; the backend does not switch (SO:3295-3345)', async (t) => {
  const h = await harness(t, { seed: true });
  const app = await addApp(t, h);
  const note = (theme: string) => `{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":"${theme}","FunctionName":"NotifyUISwitchTheme","CurrItem":null}`;
  // Unknown foreground (Wayland) → nothing.
  assert.equal(await h.store.checkTopApp(), null);
  // The executable launched by the bound .desktop entry → "App".
  h.foreground.path = await realpath(app.exe);
  assert.equal(await h.store.checkTopApp(), 'App');
  assert.deepEqual(h.notifications.map((n) => n.json), [note('App')]);
  assert.equal(h.store.currentThemeName(), 'User');
  // Same foreground again → no repeat.
  assert.equal(await h.store.checkTopApp(), null);
  // The renderer switches (Theme_SwitchApp); another app then brings "User" back.
  await expectOk(h, 'Theme_SwitchApp', 'App');
  h.foreground.path = '/bin/sh';
  assert.equal(await h.store.checkTopApp(), 'User');
  assert.equal(h.notifications.at(-1)?.json, note('User'));
  // A direct executable binding, matched case-insensitively like the vendor.
  await expectOk(h, 'Theme_Switch', 'User', '');
  await expectOk(h, 'Theme_UpdateBindApp', 'App', JSON.stringify([{ BindAppFilePath: app.exe, BindAppIconPath: '' }]));
  h.foreground.path = app.exe.toUpperCase();
  assert.equal(await h.store.checkTopApp(), 'App');
  // This app itself never triggers a switch.
  h.foreground.path = process.execPath;
  assert.equal(await h.store.checkTopApp(), null);
});

test('CheckTopApp asks the host for the foreground app only while the answer could matter (data minimisation)', async (t) => {
  const h = await harness(t, { seed: true });
  const host = h.core.host as HostServices & ForegroundAppHost;
  let asked = 0;
  let released = 0;
  host.getForegroundApp = () => {
    asked++;
    return { exe: '/usr/bin/gedit', wmClass: 'Gedit' };
  };
  host.releaseForegroundApp = () => void released++;
  const switches = () => h.notifications.filter((n) => n.name === 'NotifyUISwitchTheme').map((n) => n.tag);
  // "User" is current and no theme binds an app: every answer would be "User", so nothing is asked and
  // the host may stop tracking (X11: the xprop -spy child exits).
  for (let i = 0; i < 3; i++) assert.equal(await h.store.checkTopApp(), null);
  assert.equal(asked, 0);
  assert.equal(released, 1, 'released once, not every tick');
  // A theme with a bound app: tracking resumes.
  await addApp(t, h);
  assert.equal(await h.store.checkTopApp(), null, 'gedit is not bound and "User" is current');
  assert.equal(asked, 1);
  // Its binding gone again: released again.
  await expectOk(h, 'Theme_Del', 'App');
  assert.equal(await h.store.checkTopApp(), null);
  assert.equal(asked, 1);
  assert.equal(released, 2);
  // Another theme is current (no binding anywhere): the vendor switches back to "User" on the next foreground
  // change (SO:3317-3323), so the host is asked again.
  await expectOk(h, 'Theme_ApplyProfile', 'Cloud', 'P', FIXTURE_DEFAULT_PCENTER, JSON.stringify([{ DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtValue: '' }]));
  assert.equal(h.store.currentThemeName(), 'Cloud');
  assert.equal(await h.store.checkTopApp(), 'User');
  assert.equal(asked, 2);
  assert.deepEqual(switches(), ['User']);
});

test('the CheckTopApp loop runs once armed by the renderer\'s startup calls and stops with the store', async (t) => {
  const h = await harness(t, { seed: true, store: { appWatchIntervalMs: 15 } });
  const app = await addApp(t, h);
  h.foreground.path = await realpath(app.exe);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(h.notifications.length, 0, 'not armed before Theme_GetCurTheme');
  await expectOk(h, 'Theme_GetCurTheme');
  const until = Date.now() + 2000;
  while (h.notifications.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(h.notifications.map((n) => [n.name, n.tag]), [['NotifyUISwitchTheme', 'App']]);
  await h.store.stop();
  assert.equal(h.store.appWatchArmed, false);
});

test('profile cycling notifications (SO:3142-3227): "<Theme>|<Profile>", the renderer switches', async (t) => {
  const h = await harness(t, { seed: true });
  await expectOk(h, 'Theme_AddProfile', 'User', 'P2');
  h.store.nextProfile();
  h.store.previousProfile(); // at index 0, no wrap → nothing
  h.store.cycleUpProfile(); // wraps to the last
  h.store.specificProfile('User | P2');
  h.store.specificProfile('Other | P2');
  assert.deepEqual(h.notifications.map((n) => n.tag), ['User|P2', 'User|P2', 'User|P2']);
});

test('DataTheme.cfg written by the port loads in the vendor format (first line, BOM)', async (t) => {
  const h = await harness(t);
  await addApp(t, h);
  const bytes = await readFile(join(h.serve, 'Theme', 'DataTheme.cfg'));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.includes(0x0a), false);
  assert.equal(bytes.includes(0x0d), false);
});
