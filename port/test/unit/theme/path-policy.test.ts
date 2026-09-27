// HostServices.pathAllowed (types.ts): the hub's Theme_*/Macro_* file arguments follow the host's path
// policy (Electron main: fs-guard.ts backendMayAccess). A refused path gets the vendor's own error for that
// function, so the reply shapes do not change; without a policy (serve.ts, CLI) nothing changes at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURE_DEFAULT_PCENTER, harness, type Harness } from './helpers.ts';

const MACRO = '﻿{"Name":"Combo","MacroContent":[],"IsComMacro":true}';

interface Policy {
  reads: Set<string>;
  writes: Set<string>;
  asked: string[];
}

async function withPolicy(t: Parameters<typeof harness>[0]): Promise<{ h: Harness; policy: Policy; home: string }> {
  const policy: Policy = { reads: new Set(), writes: new Set(), asked: [] };
  const h = await harness(t, {
    seed: true,
    host: {
      pathAllowed: (path, access) => {
        policy.asked.push(`${access} ${path}`);
        return (access === 'read' ? policy.reads : policy.writes).has(path);
      },
    },
  });
  const home = join(h.root, 'home');
  await mkdir(join(home, '.ssh'), { recursive: true });
  return { h, policy, home };
}

async function err(h: Harness, name: string, ...parms: unknown[]): Promise<{ code: number; msg: string | null; tag: unknown }> {
  const r = await h.call(name, ...parms);
  return { code: r.err_code, msg: r.err_msg, tag: r.Tag };
}

test('Theme_ExportProfile / Macro_Export write only where the host allows (the export dialog\'s choice)', async (t) => {
  const { h, policy, home } = await withPolicy(t);
  // Never chosen: ~/.ssh/authorized_keys is not created (nor any directory), the vendor's write error answers.
  const keys = join(home, '.ssh', 'authorized_keys');
  const deep = join(home, 'new', 'dir', 'x.pcenter');
  for (const target of [keys, deep]) {
    assert.deepEqual(await err(h, 'Theme_ExportProfile', 'User', 'Default', target), { code: 9, msg: 'ThemeExportProfile SaveTXTConfig Error', tag: null });
  }
  assert.equal(existsSync(keys), false);
  assert.equal(existsSync(join(home, 'new')), false, 'no mkdir -p either');
  assert.deepEqual(policy.asked, [`write ${keys}`, `write ${deep}`]);
  // Chosen: written as before.
  const chosen = join(home, 'Racing.pcenter');
  policy.writes.add(chosen);
  assert.equal((await err(h, 'Theme_ExportProfile', 'User', 'Default', chosen)).code, 0);
  assert.equal(existsSync(chosen), true);

  await h.call('Macro_Update', 'User', 'Combo', '{"MacroContent":[]}');
  const unchosen = join(home, 'Documents', 'report');
  assert.deepEqual(await err(h, 'Macro_Export', 'User', 'Combo', unchosen), { code: 9, msg: 'Macro_Export save file error', tag: null });
  assert.equal(existsSync(join(home, 'Documents')), false);
  // The checked path is the one really written: ChangeExtension(path, ".macro").
  assert.equal(policy.asked.at(-1), `write ${unchosen}.macro`);
  policy.writes.add(join(home, 'combo.macro'));
  assert.equal((await err(h, 'Macro_Export', 'User', 'Combo', join(home, 'combo.txt'))).code, 0);
  assert.deepEqual((await readdir(home)).filter((n) => n.endsWith('.macro')), ['combo.macro']);
});

test('imports, descriptions and previews read only files the host allows; a refused file reads as missing', async (t) => {
  const { h, policy, home } = await withPolicy(t);
  const secret = join(home, '.ssh', 'id_ed25519');
  await writeFile(secret, '{"Profiles":[{"ProfileDesc":{"EquipmentType":1,"DeviceType":100000,"ModelName":"x","ExtModel":null}}]}');
  const macro = join(home, 'Combo.macro');
  await writeFile(macro, MACRO);

  assert.deepEqual(await err(h, 'Theme_ImportProfile', 'User', secret, false), { code: 8, msg: `ThemeImportProfile Error FilePath=${secret} Not Exist`, tag: null });
  assert.deepEqual(await err(h, 'Theme_GetProfileDesc', secret), { code: 8, msg: `AnalyseProfile ProfilePath=${secret} Not Exist`, tag: null });
  const empty = { SyncEquipment: '', Display: [], Keyboard: [], Mouse: [], MousePad: [], Headset: [] };
  assert.deepEqual(await err(h, 'Theme_GetDevicesBasicInfo', secret, -1), { code: 0, msg: '', tag: empty }, 'like a missing file');
  const sel = JSON.stringify([{ DeviceType: 100000, ModelName: 'x' }]);
  assert.deepEqual(await err(h, 'Theme_ApplyProfile', 'Cloud', 'P', secret, sel), { code: 7, msg: `ApplyProfile LoadProfile=${secret} Error`, tag: null });
  assert.deepEqual(await err(h, 'Macro_Import', 'User', macro, false), { code: 9, msg: `MacroImport filePath=${macro} is not exit`, tag: null });
  assert.deepEqual(await err(h, 'Macro_GetDetail', macro), { code: 3, msg: `file=${macro} not exit`, tag: null });
  assert.deepEqual(await err(h, 'Macro_VerifyFile', macro), { code: 0, msg: '', tag: false });
  assert.equal(policy.asked.every((a) => a.startsWith('read ')), true);

  // Picked in a dialog (main: allowChosen): everything works as before.
  policy.reads.add(FIXTURE_DEFAULT_PCENTER);
  policy.reads.add(macro);
  assert.equal((await err(h, 'Theme_ImportProfile', 'User', FIXTURE_DEFAULT_PCENTER, false)).code, 0);
  assert.equal((await err(h, 'Theme_GetProfileDesc', FIXTURE_DEFAULT_PCENTER)).code, 0);
  assert.deepEqual(await err(h, 'Macro_VerifyFile', macro), { code: 0, msg: '', tag: true });
  assert.equal((await err(h, 'Macro_GetDetail', macro)).code, 0);
  assert.equal((await err(h, 'Macro_Import', 'User', macro, false)).code, 0);
});

test('without a host policy (serve.ts, CLI) the functions behave as before', async (t) => {
  const h = await harness(t, { seed: true });
  const out = join(h.root, 'anywhere', 'x.pcenter');
  assert.equal((await err(h, 'Theme_ExportProfile', 'User', 'Default', out)).code, 0);
  assert.equal(existsSync(out), true);
  assert.equal((await err(h, 'Theme_ImportProfile', 'User', out, false)).code, 0);
});

test('Comm_GenAppIcon only looks at what the app picker binds: a .desktop file or an executable', async (t) => {
  const h = await harness(t, { seed: true });
  const plain = join(h.root, 'notes.txt');
  await writeFile(plain, '[Desktop Entry]\nIcon=/etc/hostname\n');
  assert.deepEqual(await err(h, 'Comm_GenAppIcon', plain), { code: 0, msg: '', tag: '' });
  assert.deepEqual(await err(h, 'Comm_GenAppIcon', 'relative/app.desktop'), { code: 0, msg: '', tag: '' });
  await chmod(plain, 0o755);
  assert.deepEqual(await err(h, 'Comm_GenAppIcon', plain), { code: 0, msg: '', tag: '' }, 'an executable without a desktop entry has no icon');
});
