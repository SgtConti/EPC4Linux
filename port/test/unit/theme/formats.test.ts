import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  bindDataTheme,
  bindMacroInfo,
  bindSoftConfig,
  bindThemeProfile,
  dataThemeJson,
  decodeConfigBytes,
  firstLine,
  loadConfigFile,
  macroInfoJson,
  newMacroInfo,
  newtonsoftStringify,
  parseConfigBytes,
  saveConfigFile,
  serializeConfig,
  softConfigJson,
  themeProfileJson,
} from '../../../src/backend/theme/formats.ts';
import {
  changeExtension,
  checkFileNameValidVendor,
  findIgnoreCase,
  genValidName,
  getFileNameWithoutExtension,
  isValidName,
  isValidNewName,
  sha1Prefix10,
} from '../../../src/backend/theme/names.ts';
import { FIXTURE_DATA_THEME, FIXTURE_DEFAULT_PCENTER, FIXTURE_SOFT_CONFIG, USER_DATA_THEME, readConfig, tempServeDir } from './helpers.ts';

test('the user\'s DataTheme.cfg round-trips byte for byte (20-theme §3.1)', async () => {
  const bytes = await readFile(FIXTURE_DATA_THEME);
  assert.equal(bytes.length, 156);
  const model = parseConfigBytes(bytes, bindDataTheme);
  assert.ok(model);
  assert.deepEqual(serializeConfig(dataThemeJson(model)), bytes);
  assert.equal(bytes.subarray(3).toString('utf8'), USER_DATA_THEME);
});

test('the user\'s Default.pcenter round-trips byte for byte, nested ProfileContent included', async () => {
  const bytes = await readFile(FIXTURE_DEFAULT_PCENTER);
  assert.equal(bytes.length, 12401);
  const model = parseConfigBytes(bytes, bindThemeProfile);
  assert.ok(model);
  assert.deepEqual(serializeConfig(themeProfileJson(model)), bytes);
  // Sync_Profile form created by SyncEffect_EnableDevice must be preserved verbatim.
  assert.deepEqual(model.Sync_Profile, { EffectDetailInfo: null, SyncDevices: [] });
  const entry = model.Profiles[0];
  assert.deepEqual(entry?.ProfileDesc, { EquipmentType: 1, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: '' });
  const content = entry?.ProfileContent ?? '';
  assert.equal(content.length, 10737);
  // The nested PurifyProfile text is itself compact, order-preserving JSON (raw ° and 光影同步).
  assert.equal(JSON.stringify(JSON.parse(content)), content);
  assert.ok(content.includes('"MonitorOrientation":"0°"') && content.includes('光影同步'));
});

test('the user\'s SoftConfig.data round-trips byte for byte', async () => {
  const bytes = await readFile(FIXTURE_SOFT_CONFIG);
  assert.equal(bytes.length, 68);
  const model = parseConfigBytes(bytes, bindSoftConfig);
  assert.deepEqual(model, { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 });
  assert.deepEqual(serializeConfig(softConfigJson(model!)), bytes);
});

test('the reader deserializes only the first line (pretty-printed files are load errors)', () => {
  const pretty = Buffer.from('\ufeff{\n  "TurnOffLightsWhenIdle": true\n}', 'utf8');
  assert.equal(parseConfigBytes(pretty, bindSoftConfig), null);
  const trailing = Buffer.from('{"TurnOffLightsWhenIdle":true}\r\ngarbage', 'utf8');
  assert.deepEqual(parseConfigBytes(trailing, bindSoftConfig), { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 5 });
  assert.equal(firstLine('a\rb'), 'a');
  assert.equal(firstLine(''), null);
});

test('missing, empty, whitespace, invalid, trailing-content and null files load as null', async (t) => {
  const dir = await tempServeDir(t);
  assert.equal(await loadConfigFile(join(dir, 'nope.data'), bindSoftConfig), null);
  for (const text of ['', '   ', '{', '{"a":1} x', 'null', '[1]', '"str"']) {
    const p = join(dir, 'x.data');
    await writeFile(p, text);
    assert.equal(await loadConfigFile(p, bindSoftConfig), null, JSON.stringify(text));
  }
});

test('BOM detection: UTF-8 without BOM, UTF-16 LE and BE are read like .NET StreamReader', () => {
  const json = '{"TurnOffLightsWhenIdle":true,"TurnOffLightsWhenIdleDuration":7}';
  const expect = { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 7 };
  assert.deepEqual(parseConfigBytes(Buffer.from(json, 'utf8'), bindSoftConfig), expect);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]);
  assert.deepEqual(parseConfigBytes(le, bindSoftConfig), expect);
  const be = Buffer.from(le);
  be[0] = 0xfe;
  be[1] = 0xff;
  be.subarray(2).swap16();
  assert.deepEqual(parseConfigBytes(be, bindSoftConfig), expect);
  assert.equal(decodeConfigBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'A');
});

test('Newtonsoft binding: case-insensitive names, null keeps the initializer, unknown members ignored, enum names', () => {
  const t = bindThemeProfile(JSON.parse(
    '{"sync_profile":{"SyncDevices":null,"EffectDetailInfo":{"Speed":4,"CurDir":"Spread"}},"Profiles":[{"profiledesc":{"DeviceType":"PHL_CDeviceDisplay","EquipmentType":"Display","ModelName":"M"},"Extra":1,"ProfileContent":"{}"},null],"Unknown":true}',
  ));
  assert.deepEqual(themeProfileJson(t), {
    Sync_Profile: {
      EffectDetailInfo: {
        Effect: { Name: 'Off', Text: '关闭', Value: 0 },
        Speed: 4,
        Brightness: 2,
        IsRandomColor: false,
        IsRainbowColor: false,
        CurRGB: { R: 255, G: 0, B: 0 },
        BgRGB: { R: 0, G: 0, B: 0 },
        CurDir: 5,
        CurRegion: 0,
        CurStarCount: 1,
      },
      SyncDevices: [],
    },
    Profiles: [{ ProfileDesc: { EquipmentType: 1, DeviceType: 100000, ModelName: 'M', ExtModel: null }, ProfileContent: '{}' }, null],
  });
  // A fresh profile as ThemeInfo.LoadCurProfile writes it (20-theme §4 step 4).
  assert.equal(newtonsoftStringify(themeProfileJson(bindThemeProfile({}))), '{"Sync_Profile":null,"Profiles":[]}');
  // Type mismatches fail the whole deserialization (→ null in LoadTXTConfig).
  assert.throws(() => bindDataTheme({ ThemeInfos: 5 }));
  assert.throws(() => bindThemeProfile({ Sync_Profile: { EffectDetailInfo: { CurRGB: { R: 256 } } } }));
});

test('DataTheme binding keeps the ThemeInfo initializers and member order', () => {
  const d = bindDataTheme({ ThemeInfos: [{ Name: 'X', ProfileNames: null }] });
  assert.equal(
    newtonsoftStringify(dataThemeJson(d)),
    '{"ThemeInfos":[{"Name":"X","IsDefault":false,"SelProfileName":"Default","ProfileNames":[],"CycleProfileNames":[],"BindAppInfos":[]}]}',
  );
  assert.equal(newtonsoftStringify(dataThemeJson(bindDataTheme({}))), '{"ThemeInfos":null}');
});

test('Newtonsoft escapes U+0085/U+2028/U+2029; everything else matches JSON.stringify', () => {
  const s = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c${String.fromCharCode(0x85)}d°"\\\u0001`;
  assert.equal(newtonsoftStringify({ s }), '{"s":"a\\u2028b\\u2029c\\u0085d°\\"\\\\\\u0001"}');
});

test('saveConfigFile writes BOM + one line atomically and leaves no temp files', async (t) => {
  const dir = await tempServeDir(t);
  const p = join(dir, 'Config', 'SoftConfig.data');
  assert.equal(await saveConfigFile(p, { TurnOffLightsWhenIdle: true, TurnOffLightsWhenIdleDuration: 3 }), true);
  assert.equal(await readConfig(p), '{"TurnOffLightsWhenIdle":true,"TurnOffLightsWhenIdleDuration":3}');
  assert.equal(await saveConfigFile(p, { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 3 }, { inPlace: true }), true);
  assert.equal(await readConfig(p), '{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":3}');
  assert.deepEqual(await readdir(join(dir, 'Config')), ['SoftConfig.data']);
  assert.equal(await saveConfigFile('', {}), false);
  assert.equal(await saveConfigFile(p, null), false);
});

test('macro files: new macro shape, computed members, IsComMacro', () => {
  assert.equal(newtonsoftStringify(macroInfoJson(newMacroInfo('M1'))), '{"Name":"M1","MacroContent":[],"IsComMacro":true}');
  const m = bindMacroInfo({
    Name: 'x',
    MacroContent: [
      { MacroTag: 't', MacroType: 1, MacroTypeName: 'ignored', MacroAction: 'Up', DelayTime: 20, MacroValue: 'A' },
      { MacroType: 3, MacroAction: 0, MacroValue: 'hello' },
    ],
    IsComMacro: true,
  });
  assert.equal(
    newtonsoftStringify(macroInfoJson(m)),
    '{"Name":"x","MacroContent":[{"MacroTag":"t","MacroType":1,"MacroTypeName":"KeyBoard","MacroAction":2,"MacroActionName":"Up","DelayTime":20,"MacroValue":"A","Extra":""},' +
      '{"MacroTag":null,"MacroType":3,"MacroTypeName":"Text","MacroAction":0,"MacroActionName":"Null","DelayTime":0,"MacroValue":"hello","Extra":""}],"IsComMacro":false}',
  );
});

test('name helpers follow .NET and the vendor', () => {
  assert.equal(checkFileNameValidVendor('..'), true); // vendor bug B-1
  assert.equal(isValidName('..'), false);
  assert.equal(isValidName('.'), false);
  for (const bad of ['', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b']) assert.equal(isValidName(bad), false, bad);
  assert.equal(isValidName('New Application 1'), true);
  assert.equal(genValidName(['Default', 'Default(1)'], 'Default', 'X'), 'Default(2)');
  assert.equal(genValidName([], 'a|b', 'Default'), 'Default');
  // New names (20-theme §10.1): no leading/trailing space or dot; existing ones stay loadable.
  for (const bad of ['Night.', 'Night ', ' Night', '.Night', '...', ' ']) {
    assert.equal(isValidNewName(bad), false, JSON.stringify(bad));
    assert.equal(isValidName(bad), true, `${JSON.stringify(bad)} stays loadable from an existing index`);
  }
  assert.equal(isValidNewName('My.Profile 2'), true);
  assert.equal(isValidNewName('..'), false);
  // Taken is case-insensitive (a Windows file system cannot hold Default and default, B-10).
  assert.equal(genValidName(['Default'], 'default', 'X'), 'default(1)');
  assert.equal(genValidName(['Default', 'DEFAULT(1)'], 'default', 'X'), 'default(2)');
  assert.equal(genValidName([], 'Night.', 'Default'), 'Default');
  assert.equal(findIgnoreCase(['User', 'Default'], 'DEFAULT'), 'Default');
  assert.equal(findIgnoreCase(['User'], 'x'), undefined);
  assert.equal(getFileNameWithoutExtension('/x/y/My.Profile.pcenter'), 'My.Profile');
  assert.equal(getFileNameWithoutExtension('/x/.pcenter'), '');
  assert.equal(changeExtension('/x/y/m.txt', '.macro'), '/x/y/m.macro');
  assert.equal(changeExtension('/x.d/m', '.macro'), '/x.d/m.macro');
  // Icon names of 20-theme §3.4.
  assert.equal(sha1Prefix10('C:\\Windows\\notepad.exe'), '6ee69b7475');
  assert.equal(sha1Prefix10('/usr/share/applications/firefox.desktop'), '53127c7233');
});
