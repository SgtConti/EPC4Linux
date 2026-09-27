// Foreground matching of app-bound themes on Linux (20-theme §10.2 item 5) and PATH_APP_TEMP (§10.1).

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostServices } from '../../../src/backend/types.ts';
import { BindingResolver, type ForegroundAppHost } from '../../../src/backend/theme/app-binding.ts';
import {
  desktopExecProgram,
  desktopSnapName,
  isInterpreter,
  parseDesktopEntry,
  scriptAppDirectories,
  snapNameOfCommand,
} from '../../../src/backend/theme/desktop-entry.ts';
import { defaultAppTempDir } from '../../../src/backend/theme/paths.ts';
import { harness } from './helpers.ts';

async function tempRoot(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'evnia-bind-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeExec(path: string, text: string): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
  await chmod(path, 0o755);
  return path;
}

async function writeDesktop(dir: string, name: string, body: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, `[Desktop Entry]\nType=Application\nName=${name}\n${body}\n`);
  return path;
}

test('snap: the Exec format snapd generates (env BAMF_DESKTOP_FILE_HINT=… /snap/bin/<app>) matches the snap binary', async (t) => {
  const root = await tempRoot(t);
  const env = { HOME: join(root, 'home'), PATH: '/usr/bin:/bin' };
  const exec = 'Exec=env BAMF_DESKTOP_FILE_HINT=/var/lib/snapd/desktop/applications/firefox_firefox.desktop /snap/bin/firefox %u';
  const entry = parseDesktopEntry(`[Desktop Entry]\nName=Firefox\n${exec}\n`);
  assert.equal(desktopExecProgram(entry), '/snap/bin/firefox');
  assert.equal(await desktopSnapName(entry, env), 'firefox');
  assert.equal(snapNameOfCommand('/snap/bin/code.url-handler'), 'code');
  assert.equal(snapNameOfCommand('/usr/bin/firefox'), null);

  const desk = await writeDesktop(join(root, 'snapd', 'applications'), 'firefox_firefox.desktop', exec);
  const resolver = new BindingResolver(env);
  const fg = '/snap/firefox/4793/usr/lib/firefox/firefox';
  assert.equal(await resolver.matches(desk, { exe: fg }, fg), true);
  const other = '/snap/thunderbird/12/usr/lib/thunderbird/thunderbird';
  assert.equal(await resolver.matches(desk, { exe: other }, other), false);
  assert.equal(await resolver.matches(desk, { exe: '/usr/bin/snap' }, '/usr/bin/snap'), false, 'the snap launcher binary itself is not the app');
});

test('snap: a relative Exec that PATH resolves into /snap/bin matches the snap binary', async (t) => {
  // Needs a writable /snap/bin (root in the dev container); skipped elsewhere.
  const name = `evniatest${process.pid}`;
  const created: string[] = [];
  const launcher = join('/snap/bin', name);
  try {
    for (const d of ['/snap', '/snap/bin']) {
      try {
        await stat(d);
      } catch {
        await mkdir(d);
        created.unshift(d);
      }
    }
    await writeExec(launcher, '#!/bin/sh\nexit 0\n');
  } catch {
    for (const d of created) await rmdir(d).catch(() => undefined);
    t.skip('cannot create a launcher in /snap/bin (not root)');
    return;
  }
  t.after(async () => {
    await rm(launcher, { force: true });
    for (const d of created) await rmdir(d).catch(() => undefined);
  });
  const root = await tempRoot(t);
  const env = { HOME: join(root, 'home'), PATH: '/snap/bin:/usr/bin:/bin' };
  const desk = await writeDesktop(join(root, 'apps'), `${name}.desktop`, `Exec=${name} %U`);
  assert.equal(await desktopSnapName(parseDesktopEntry(`[Desktop Entry]\nExec=${name} %U\n`), env), name);
  const fg = `/snap/${name}/7/usr/bin/app`;
  assert.equal(await new BindingResolver(env).matches(desk, { exe: fg }, fg), true);
});

test('interpreters never bind every program they run (python3 x.py, sh -c, java -jar, flatpak run)', async (t) => {
  const root = await tempRoot(t);
  const env = { HOME: join(root, 'home'), PATH: '/usr/bin:/bin' };
  for (const p of ['/usr/bin/python3.12', '/usr/bin/java', '/bin/sh', '/usr/bin/flatpak', '/usr/lib/jvm/bin/java', '/usr/bin/node', '/usr/bin/snap']) assert.equal(isInterpreter(p), true, p);
  for (const p of ['/usr/bin/firefox', '/opt/google/chrome/chrome', '/usr/bin/shotwell']) assert.equal(isInterpreter(p), false, p);
  const desk = await writeDesktop(join(root, 'apps'), 'script-app.desktop', 'Exec=sh -c "exec /opt/app/run" %U');
  const sh = await realpath('/bin/sh');
  assert.equal(await new BindingResolver(env).matches(desk, { exe: sh }, sh), false);
});

test('wrapper scripts: the binary next to the script (or in <app>/ for <app>/bin/<script>) matches; shared directories do not', async (t) => {
  const root = await tempRoot(t);
  const home = join(root, 'home');
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  const resolver = new BindingResolver(env);
  // Google Chrome: /opt/google/chrome/google-chrome (script) execs /opt/google/chrome/chrome.
  const chromeDir = join(root, 'opt', 'google', 'chrome');
  const script = await writeExec(join(chromeDir, 'google-chrome'), '#!/bin/bash\nexec -a "$0" "$(dirname "$0")/chrome" "$@"\n');
  const chrome = await writeExec(join(chromeDir, 'chrome'), '\u007fELF');
  const desk = await writeDesktop(join(root, 'apps'), 'google-chrome.desktop', `Exec=${script} %U\nStartupWMClass=Google-chrome`);
  assert.equal(await resolver.matches(desk, { exe: chrome }, chrome), true);
  const sh = await realpath('/bin/sh');
  assert.equal(await resolver.matches(desk, { exe: sh }, sh), false);
  // VS Code: /usr/share/code/bin/code (script) execs /usr/share/code/code.
  const codeDir = join(root, 'share', 'code');
  const codeScript = await writeExec(join(codeDir, 'bin', 'code'), '#!/usr/bin/env sh\nexec "$(dirname "$0")/../code" "$@"\n');
  const code = await writeExec(join(codeDir, 'code'), '\u007fELF');
  const codeDesk = await writeDesktop(join(root, 'apps'), 'code.desktop', `Exec=${codeScript} --unity-launch %F`);
  assert.equal(await resolver.matches(codeDesk, { exe: code }, code), true);
  // A script in ~/.local/bin does not claim the other programs there.
  const tool = await writeExec(join(home, '.local', 'bin', 'tool'), '#!/bin/sh\nexec other\n');
  const other = await writeExec(join(home, '.local', 'bin', 'other'), '\u007fELF');
  const toolDesk = await writeDesktop(join(root, 'apps'), 'tool.desktop', `Exec=${tool}`);
  assert.equal(await resolver.matches(toolDesk, { exe: other }, other), false);
  assert.deepEqual(scriptAppDirectories('/usr/bin/firefox', env), [], '/usr/bin is shared');
  assert.deepEqual(scriptAppDirectories('/usr/lib/x86_64-linux-gnu/helper', env), []);
});

test('CheckTopApp uses WM_CLASS / app_id when the host reports them (desktop-id and StartupWMClass rules)', async (t) => {
  const h = await harness(t, { seed: true });
  const apps = join(h.root, 'apps');
  // Exec points nowhere: only the window identity can match.
  const desk = await writeDesktop(apps, 'org.example.Tool.desktop', 'Exec=/nonexistent/tool %U\nStartupWMClass=ToolWin');
  assert.equal((await h.call('Theme_Add', 'Tool', JSON.stringify([{ BindAppFilePath: desk, BindAppIconPath: '' }]))).err_code, 0);
  let fg: { exe: string | null; wmClass?: string | null; appId?: string | null } | null = null;
  (h.core.host as HostServices & ForegroundAppHost).getForegroundApp = () => fg;
  fg = { exe: null, wmClass: 'toolwin' };
  assert.equal(await h.store.checkTopApp(), 'Tool', 'StartupWMClass, ignoring case');
  fg = { exe: '/usr/bin/other', appId: 'org.example.Tool' };
  assert.equal(await h.store.checkTopApp(), 'Tool', 'app_id = desktop-file ID');
  fg = { exe: '/bin/true', wmClass: 'Other' };
  assert.equal(await h.store.checkTopApp(), null, 'User is current: nothing to send');
  await h.call('Theme_SwitchApp', 'Tool');
  fg = { exe: null, wmClass: 'evnia-precision-center' };
  assert.equal(await h.store.checkTopApp(), null, 'this app itself never triggers');
  fg = { exe: '/bin/true', wmClass: 'Other' };
  assert.equal(await h.store.checkTopApp(), 'User');
});

test('PATH_APP_TEMP is per user: $XDG_RUNTIME_DIR/EvniaServe, else <tmp>/EvniaServe-<uid> (20-theme §10.1)', () => {
  assert.equal(defaultAppTempDir({ XDG_RUNTIME_DIR: '/run/user/1000' }), '/run/user/1000/EvniaServe');
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : '';
  const fallback = defaultAppTempDir({});
  assert.ok(fallback.startsWith(join(tmpdir(), 'EvniaServe-')), fallback);
  if (uid) assert.equal(fallback, join(tmpdir(), `EvniaServe-${uid}`));
  assert.equal(defaultAppTempDir({ XDG_RUNTIME_DIR: 'relative/dir' }), fallback, 'a relative XDG_RUNTIME_DIR is ignored');
});
