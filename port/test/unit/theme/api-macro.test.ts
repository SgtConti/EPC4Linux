import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMacroCmdMenuData } from '../../../src/backend/theme/macro-menu.ts';
import { harness, readConfig, type Harness } from './helpers.ts';

/** 20-backend-host-tail §5 step 9, the vendor's reply verbatim: Tag = 4025 characters (4161 UTF-8 bytes). */
const GOLDEN_FUNC_MENU = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'macro-getfuncmenu.reply.json');

async function expectErr(h: Harness, code: number, msg: string, name: string, ...parms: unknown[]): Promise<void> {
  const r = await h.call(name, ...parms);
  assert.deepEqual({ err_code: r.err_code, err_msg: r.err_msg, Tag: r.Tag }, { err_code: code, err_msg: msg, Tag: null }, `${name}(${JSON.stringify(parms)})`);
}

async function ok(h: Harness, name: string, ...parms: unknown[]): Promise<unknown> {
  const r = await h.call(name, ...parms);
  assert.equal(r.err_code, 0, `${name}: ${r.err_msg}`);
  assert.equal(r.err_msg, '');
  return r.Tag;
}

test('Macro_GetFuncMenu is derived byte-for-byte from the vendor tables (20-backend-host-tail §5 step 9)', async (t) => {
  const tag = JSON.stringify(makeMacroCmdMenuData());
  assert.equal(tag.length, 4025);
  assert.equal(Buffer.byteLength(tag, 'utf8'), 4161);
  const h = await harness(t, { seed: true });
  const reply = await h.dispatcher.dispatch('{"functionName":"Macro_GetFuncMenu","requestId":"90e03aab-43d2-406f-a766-12126d985ce9","parms":null}');
  assert.equal(reply, await readFile(GOLDEN_FUNC_MENU, 'utf8'));
  assert.equal(Buffer.byteLength(reply, 'utf8'), 4311);
});

test('Macro_GetList: [] without a Macro folder, error 3 for an unknown theme (SO:1972-2010, step 10)', async (t) => {
  const h = await harness(t, { seed: true });
  assert.equal(
    await h.dispatcher.dispatch('{"functionName":"Macro_GetList","requestId":"985de1ec-19ce-4f11-b657-603396bb0226","parms":["User"]}'),
    '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"985de1ec-19ce-4f11-b657-603396bb0226","Tag":[],"FunctionName":"Macro_GetList","CurrItem":null}',
  );
  const themeRoot = join(h.serve, 'Theme');
  await expectErr(h, 3, `Theme=Nope path=${themeRoot}/Nope not exit`, 'Macro_GetList', 'Nope');
  await expectErr(h, 3, `Theme=.. path=${themeRoot}/.. not exit`, 'Macro_GetList', '..');
  // Theme names resolve case-insensitively (the Windows directory lookup was case-insensitive).
  assert.deepEqual(await ok(h, 'Macro_GetList', 'user'), []);
});

test('Macro_Add / GetDetail / VerifyFile / Copy / Rename / Update / Del (SO:2012-2399)', async (t) => {
  const h = await harness(t, { seed: true });
  const dir = join(h.serve, 'Theme', 'User', 'Macro');
  await expectErr(h, 2, 'The Macro name: a/b is not valid', 'Macro_Add', 'User', 'a/b');
  assert.deepEqual(await ok(h, 'Macro_Add', 'User', 'M1'), [{ MacroName: 'M1', IsComMacro: true }]);
  assert.equal(await readConfig(join(dir, 'M1.macro')), '{"Name":"M1","MacroContent":[],"IsComMacro":true}');
  await expectErr(h, 4, 'The Macro name: M1 already exists', 'Macro_Add', 'User', 'M1');
  await expectErr(h, 3, `Theme=Nope path=${join(h.serve, 'Theme')}/Nope not exit`, 'Macro_Add', 'Nope', 'M');

  assert.deepEqual(await ok(h, 'Macro_GetDetail', 'User', 'M1'), { Name: 'M1', MacroContent: [], IsComMacro: true });
  assert.equal(await ok(h, 'Macro_GetDetail', 'User', 'Missing'), null);
  assert.deepEqual(await ok(h, 'Macro_GetDetail', join(dir, 'M1.macro')), { Name: 'M1', MacroContent: [], IsComMacro: true });
  await expectErr(h, 3, 'file=/nope.macro not exit', 'Macro_GetDetail', '/nope.macro');
  assert.equal(await ok(h, 'Macro_VerifyFile', join(dir, 'M1.macro')), true);
  assert.equal(await ok(h, 'Macro_VerifyFile', '/nope.macro'), false);
  await writeFile(join(h.root, 'bad.macro'), '{\n}');
  assert.equal(await ok(h, 'Macro_VerifyFile', join(h.root, 'bad.macro')), false);

  // Update: whole-string JSON (multi-line accepted), Tag = the stored macro with computed members.
  const data = JSON.stringify({ Name: 'ignored', MacroContent: [{ MacroType: 3, MacroValue: 'hi' }] }, null, 2);
  assert.deepEqual(await ok(h, 'Macro_Update', 'User', 'M1', data), {
    Name: 'ignored',
    MacroContent: [{ MacroTag: null, MacroType: 3, MacroTypeName: 'Text', MacroAction: 0, MacroActionName: 'Null', DelayTime: 0, MacroValue: 'hi', Extra: '' }],
    IsComMacro: false,
  });
  await expectErr(h, 5, 'Macro_UpdateData macroData is not valid', 'Macro_Update', 'User', 'M1', 'nope');
  await expectErr(h, 9, 'Macro_UpdateData save error', 'Macro_Update', 'User', '../../x', '{}');

  // Copy: explicit and generated names.
  await expectErr(h, 2, 'The Macro newName: a:b is not valid', 'Macro_Copy', 'User', 'M1', 'a:b');
  await expectErr(h, 4, `The Macro newName: ${join(dir, 'M1.macro')} is exists`, 'Macro_Copy', 'User', 'M1', 'M1');
  await expectErr(h, 9, `The Macro name: ${join(dir, 'Zed.macro')} is not exists`, 'Macro_Copy', 'User', 'Zed', 'Z2');
  // Creation-time order: make M1 clearly older than the copies (mtime is the fallback without birth time).
  const old = new Date(Date.now() - 60_000);
  await utimes(join(dir, 'M1.macro'), old, old);
  await ok(h, 'Macro_Copy', 'User', 'M1', 'M2');
  const list = (await ok(h, 'Macro_Copy', 'User', 'M1', '')) as { MacroName: string; IsComMacro: boolean }[];
  assert.deepEqual(new Set(list.map((m) => m.MacroName)), new Set(['M1', 'M2', 'M1(1)']));
  assert.ok(list.every((m) => m.IsComMacro === false));
  await writeFile(join(dir, 'Broken.macro'), 'x');
  await expectErr(h, 5, 'Macro_Copy ori macro=Broken content is not valid', 'Macro_Copy', 'User', 'Broken', 'B2');

  // Rename: the file name is authoritative; the Name member is not rewritten.
  await expectErr(h, 2, 'The macro newName:a?b  is not valid', 'Macro_Rename', 'User', 'M2', 'a?b');
  await expectErr(h, 4, 'The macro newName:M1 already exists', 'Macro_Rename', 'User', 'M2', 'M1');
  await expectErr(h, 9, 'Macro_Update MoveFile error', 'Macro_Rename', 'User', 'Zed', 'Z3');
  const renamed = (await ok(h, 'Macro_Rename', 'User', 'M2', 'M3')) as { MacroName: string }[];
  assert.ok(renamed.some((m) => m.MacroName === 'M3') && !renamed.some((m) => m.MacroName === 'M2'));
  assert.match(await readConfig(join(dir, 'M3.macro')), /^\{"Name":"ignored"/);

  // Del: missing names are fine; Tag = the list.
  const afterDel = (await ok(h, 'Macro_Del', 'User', 'M3')) as { MacroName: string }[];
  assert.ok(!afterDel.some((m) => m.MacroName === 'M3'));
  await ok(h, 'Macro_Del', 'User', 'Nope');
  // Non-macro files are not listed.
  await writeFile(join(dir, 'notes.txt'), 'x');
  assert.ok(!((await ok(h, 'Macro_GetList', 'User')) as { MacroName: string }[]).some((m) => m.MacroName === 'notes'));
});

test('Macro_GetList orders by creation time and edits keep a macro in place', async (t) => {
  const h = await harness(t, { seed: true });
  await ok(h, 'Macro_Add', 'User', 'B');
  await new Promise((r) => setTimeout(r, 20));
  await ok(h, 'Macro_Add', 'User', 'A');
  await ok(h, 'Macro_Update', 'User', 'B', '{"MacroContent":[]}');
  assert.deepEqual(((await ok(h, 'Macro_GetList', 'User')) as { MacroName: string }[]).map((m) => m.MacroName), ['B', 'A']);
});

test('Macro_Import / Macro_Export (SO:2401-2528)', async (t) => {
  const h = await harness(t, { seed: true });
  const dir = join(h.serve, 'Theme', 'User', 'Macro');
  const src = join(h.root, 'Combo.macro');
  await writeFile(src, '﻿{"Name":"Combo","MacroContent":[{"MacroTag":"a","MacroType":1,"MacroAction":1,"DelayTime":10,"MacroValue":"65","Extra":""}],"IsComMacro":true}');
  await expectErr(h, 9, 'MacroImport filePath=/nope.macro is not exit', 'Macro_Import', 'User', '/nope.macro', false);
  await writeFile(join(h.root, 'Bad.macro'), 'x');
  await expectErr(h, 5, 'Macro_Import macro content is not valid', 'Macro_Import', 'User', join(h.root, 'Bad.macro'), false);
  assert.deepEqual(await ok(h, 'Macro_Import', 'User', src, false), [{ MacroName: 'Combo', IsComMacro: true }]);
  const second = (await ok(h, 'Macro_Import', 'User', src, false)) as { MacroName: string }[];
  assert.deepEqual(second.map((m) => m.MacroName).sort(), ['Combo', 'Combo(1)']);
  assert.equal(((await ok(h, 'Macro_Import', 'User', src, true)) as unknown[]).length, 2);
  assert.equal(
    await readConfig(join(dir, 'Combo.macro')),
    '{"Name":"Combo","MacroContent":[{"MacroTag":"a","MacroType":1,"MacroTypeName":"KeyBoard","MacroAction":1,"MacroActionName":"Down","DelayTime":10,"MacroValue":"65","Extra":""}],"IsComMacro":true}',
  );
  await expectErr(h, 3, `Theme=Nope path=${join(h.serve, 'Theme')}/Nope not exit`, 'Macro_Import', 'Nope', src, false);

  const outDir = join(h.root, 'out');
  await mkdir(outDir);
  assert.equal(await ok(h, 'Macro_Export', 'User', 'Combo', join(outDir, 'exported.txt')), null);
  assert.deepEqual(await readdir(outDir), ['exported.macro']);
  assert.equal(await readConfig(join(outDir, 'exported.macro')), await readConfig(join(dir, 'Combo.macro')));
  await expectErr(h, 5, 'Macro_Export ori macro=Nope content is not valid', 'Macro_Export', 'User', 'Nope', join(outDir, 'x'));
  await expectErr(h, 9, 'Macro_Export save file error', 'Macro_Export', 'User', 'Combo', '');
});
