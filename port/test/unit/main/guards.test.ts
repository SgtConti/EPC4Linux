// Path confinement (nodeApi, local: protocol, debug flag) and the network kill-switch predicate.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MAX_WRITE_GRANTS, PathGuard } from '../../../src/main/fs-guard.ts';
import { isOwnedDirectory, localUrlToPath, resolveLocalImage } from '../../../src/main/local-protocol.ts';
import { isAllowedNavigation, isAllowedRequestUrl, redactUrl } from '../../../src/main/network-guard.ts';
import { clearDebugFlag, DEBUG_FLAG_NAME, debugFlagSet } from '../../../src/main/paths.ts';

let root: string;
let userData: string;
let serve: string;
let outside: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'evnia-guard-'));
  userData = join(root, 'evnia');
  serve = join(root, 'EvniaServe');
  outside = join(root, 'home');
  for (const d of [userData, join(userData, 'ImageCache', '34M2C8600'), serve, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(userData, 'ImageCache', '34M2C8600', 'normal.png'), 'png');
  writeFileSync(join(userData, 'secret.txt'), 's');
  writeFileSync(join(outside, 'profile.pcenter'), '{}');
  writeFileSync(join(outside, 'private.png'), 'png');
  symlinkSync(outside, join(userData, 'escape'));
});
after(() => rmSync(root, { recursive: true, force: true }));

test('PathGuard: reads confined to the roots plus files picked in a dialog', () => {
  const g = new PathGuard({ readRoots: [userData, serve], scratchDir: userData });
  assert.ok(g.readable(join(userData, 'secret.txt')));
  assert.ok(g.readable(join(serve, 'Theme', 'DataTheme.cfg')), 'not-yet-existing file below a root');
  assert.equal(g.readable(join(outside, 'profile.pcenter')), null);
  assert.equal(g.readable(join(userData, '..', 'home', 'profile.pcenter')), null, '.. traversal');
  assert.equal(g.readable(join(userData, 'escape', 'profile.pcenter')), null, 'symlink escape');
  assert.equal(g.readable('/etc/passwd'), null);
  assert.equal(g.readable('relative/path'), null);
  assert.equal(g.readable(`${userData}/x\0.txt`), null);
  assert.equal(g.readable(42), null);
  g.allowChosen(join(outside, 'profile.pcenter'));
  assert.ok(g.readable(join(outside, 'profile.pcenter')), 'picked file becomes readable');
  assert.equal(g.readable(join(outside, 'private.png')), null, 'only that file');
});

test('PathGuard: copies create new temporary files directly in userData, never app state', () => {
  const g = new PathGuard({ readRoots: [userData, serve], scratchDir: userData });
  // the vendor import target: pathJoin(userDataPath, basename(file, ".pcenter").slice(0, 30))
  const temp = join(userData, 'My Profile');
  assert.equal(g.copyTarget(temp), temp);
  // "config.json.pcenter", "Preferences.pcenter", "evnia-first-run.pcenter" … would overwrite app state
  for (const name of ['config.json', 'Preferences', 'MonitorInfo.json', 'evnia-first-run', 'secret.txt']) {
    writeFileSync(join(userData, name), 'state');
    assert.equal(g.copyTarget(join(userData, name)), null, name);
  }
  assert.equal(g.copyTarget(join(userData, 'ImageCache')), null, 'directory');
  assert.equal(g.copyTarget(join(userData, 'ImageCache', 'x')), null, 'not a direct child');
  assert.equal(g.copyTarget(userData), null);
  assert.equal(g.copyTarget(join(serve, 'Config', 'SoftConfig.data')), null);
  g.allowChosen(join(outside, 'profile.pcenter'));
  assert.equal(g.copyTarget(join(outside, 'profile.pcenter')), null, 'picked files are read-only');
  assert.equal(g.copyTarget(join(userData, 'escape', 'x')), null, 'symlink escape');
  symlinkSync(join(userData, 'config.json'), join(userData, 'alias'));
  assert.equal(g.copyTarget(join(userData, 'alias')), null, 'symlink to app state');
  // a file nodeApi created itself may be written again (re-import after a failed unlink)
  writeFileSync(temp, 'copy');
  assert.equal(g.copyTarget(temp), null, 'pre-existing file');
  g.noteCreated(temp);
  assert.equal(g.copyTarget(temp), temp);
});

test('PathGuard: unlink only nodeApi-created files and the backend export files', () => {
  const g = new PathGuard({ readRoots: [userData, serve], scratchDir: userData });
  const created = join(userData, 'Imported');
  writeFileSync(created, 'x');
  assert.equal(g.removable(created), null, 'not created by nodeApi');
  g.noteCreated(created);
  assert.equal(g.removable(created), created);
  g.noteRemoved(created);
  assert.equal(g.removable(created), null);
  // exportProfile / exportMacro write <userData>/<name>.pcenter|.macro, the renderer deletes it
  for (const f of ['Game.pcenter', 'Keys.macro']) {
    writeFileSync(join(userData, f), 'x');
    assert.equal(g.removable(join(userData, f)), join(userData, f), f);
  }
  writeFileSync(join(userData, 'config.json'), '{}');
  assert.equal(g.removable(join(userData, 'config.json')), null);
  assert.equal(g.removable(join(userData, 'Missing.pcenter')), null, 'missing file');
  assert.equal(g.removable(join(outside, 'profile.pcenter')), null, 'outside userData');
  symlinkSync(join(userData, 'config.json'), join(userData, 'link.pcenter'));
  assert.equal(g.removable(join(userData, 'link.pcenter')), null, 'symlink resolving to app state');
  assert.equal(new PathGuard({ readRoots: [userData] }).copyTarget(join(userData, 'x')), null, 'no scratch dir: no writes');
});

test('debug flag counts only as a regular file owned by the user', () => {
  const flag = join(root, DEBUG_FLAG_NAME);
  assert.equal(debugFlagSet(flag), false);
  writeFileSync(flag, '');
  assert.equal(debugFlagSet(flag), true);
  assert.equal(debugFlagSet(flag, 4242), false, "someone else's file in a shared /tmp");
  clearDebugFlag(flag, 4242);
  assert.equal(existsSync(flag), true, "never deletes someone else's file");
  clearDebugFlag(flag);
  assert.equal(existsSync(flag), false);
  mkdirSync(flag);
  assert.equal(debugFlagSet(flag), false, 'a directory is not the flag');
  assert.doesNotThrow(() => clearDebugFlag(flag), 'exit never throws on a bogus flag');
  rmSync(flag, { recursive: true });
  symlinkSync(join(userData, 'secret.txt'), flag);
  assert.equal(debugFlagSet(flag), false, 'a symlink is not the flag');
  rmSync(flag);
});

test('local: private roots (shared /tmp) are served only while owned by the user', () => {
  assert.equal(isOwnedDirectory(serve), true);
  assert.equal(isOwnedDirectory(serve, 4242), false);
  assert.equal(isOwnedDirectory(join(userData, 'secret.txt')), false);
  assert.equal(isOwnedDirectory(join(userData, 'escape')), false, 'symlink');
  assert.equal(isOwnedDirectory(join(root, 'missing')), false);
});

test('PathGuard.backendMayAccess (HostServices.pathAllowed): reads as nodeApi; writes only to a fresh export-dialog choice or a userData temp export', () => {
  const g = new PathGuard({ readRoots: [userData, serve], scratchDir: userData });
  const picked = join(outside, 'profile.pcenter');
  // reads: the roots and dialog picks
  assert.equal(g.backendMayAccess(join(userData, 'secret.txt'), 'read'), true);
  assert.equal(g.backendMayAccess(picked, 'read'), false);
  g.allowChosen(picked);
  assert.equal(g.backendMayAccess(picked, 'read'), true);
  assert.equal(g.backendMayAccess('/etc/passwd', 'read'), false);
  assert.equal(g.backendMayAccess(join(userData, 'escape', 'private.png'), 'read'), false, 'symlink escape');
  // writes: never a read root as such, never a dialog pick, never outside
  for (const p of [join(userData, 'secret.txt'), join(userData, 'config.json'), picked, join(outside, '.bashrc'), join(serve, 'Theme', 'x.pcenter'), '/etc/x.pcenter', 'relative.pcenter', '']) {
    assert.equal(g.backendMayAccess(p, 'write'), false, p);
  }
  // the renderer's temp export files, directly in userData
  assert.equal(g.backendMayAccess(join(userData, 'Racing.pcenter'), 'write'), true);
  assert.equal(g.backendMayAccess(join(userData, 'Combo.MACRO'), 'write'), true);
  assert.equal(g.backendMayAccess(join(userData, 'ImageCache', 'x.pcenter'), 'write'), false, 'not a direct child');
  assert.equal(g.backendMayAccess(join(userData, 'escape', 'x.pcenter'), 'write'), false, 'symlinked directory');
  symlinkSync(join(outside, 'profile.pcenter'), join(userData, 'user-link.pcenter'));
  assert.equal(g.backendMayAccess(join(userData, 'user-link.pcenter'), 'write'), false, 'a symlink to a user file');
  // the export dialog's choice: once
  const chosen = join(outside, 'Export', 'Racing.pcenter');
  g.grantWrite(chosen);
  assert.equal(g.backendMayAccess(join(outside, 'Export', 'Other.pcenter'), 'write'), false);
  assert.equal(g.backendMayAccess(join(outside, 'Export', '..', 'Export', 'Racing.pcenter'), 'write'), true, 'same path, other spelling');
  assert.equal(g.backendMayAccess(chosen, 'write'), false, 'used up');
  // only the newest grants are kept
  for (let i = 0; i <= MAX_WRITE_GRANTS; i++) g.grantWrite(join(outside, `e${i}.macro`));
  assert.equal(g.backendMayAccess(join(outside, 'e0.macro'), 'write'), false);
  assert.equal(g.backendMayAccess(join(outside, `e${MAX_WRITE_GRANTS}.macro`), 'write'), true);
});

test('local: URLs map to absolute paths like the vendor renderer builds them', () => {
  assert.equal(localUrlToPath('local:////home/u/.config/evnia/ImageCache/M/normal.png'), '/home/u/.config/evnia/ImageCache/M/normal.png');
  assert.equal(localUrlToPath('local:///home/u/a%20b.png?x=1#y'), '/home/u/a b.png');
  assert.equal(localUrlToPath('local:///%E0%A4%A'), null);
  assert.equal(localUrlToPath('file:///etc/passwd'), null);
});

test('local: serves images below the allowed roots only', () => {
  const g = new PathGuard({ readRoots: [join(userData, 'ImageCache')] });
  const ok = resolveLocalImage(`local:///${join(userData, 'ImageCache', '34M2C8600', 'normal.png')}`, g);
  assert.equal(ok?.type, 'image/png');
  assert.equal(resolveLocalImage(`local:///${join(userData, 'secret.txt')}`, g), null, 'not an image');
  assert.equal(resolveLocalImage(`local:///${join(outside, 'private.png')}`, g), null, 'outside the roots');
  assert.equal(resolveLocalImage(`local:///${join(userData, 'ImageCache', '..', 'escape', 'private.png')}`, g), null);
  assert.equal(resolveLocalImage('local:///https://example.com/x.png', g), null, 'no URL smuggling (14 N12)');
});

test('kill-switch predicate: local schemes and the loopback hub only', () => {
  const hub = 10010;
  const roots = ['/opt/evnia-precision-center/resources/app.asar'];
  for (const url of [
    'file:///opt/evnia-precision-center/resources/app.asar/vendor-ui/index.html',
    'file:///opt/evnia-precision-center/resources/app.asar/vendor-ui/assets/main-CDosWiM3.js?x=1#y',
    'file://localhost/opt/evnia-precision-center/resources/app.asar/capture/capture.html',
    'data:image/png;base64,AA',
    'blob:file:///uuid',
    'devtools://devtools/bundled/x',
    'chrome://gpu',
    'local:////home/u/x.png',
    `ws://127.0.0.1:${hub}/EvniaHub?k=abc`,
  ]) {
    assert.ok(isAllowedRequestUrl(url, hub, roots), url);
  }
  for (const url of [
    'https://saas.zeasn.tv/auth-api/api/v1/auth/deviceSign',
    'http://127.0.0.1:10010/EvniaHub',
    `ws://localhost:${hub}/EvniaHub`,
    `ws://127.0.0.1:${hub + 1}/EvniaHub`,
    `ws://127.0.0.1:${hub}/Other`,
    `wss://127.0.0.1:${hub}/EvniaHub`,
    `ws://user:pw@127.0.0.1:${hub}/EvniaHub`,
    'https://cdn.jsdelivr.net/npm/browser-image-compression',
    'ftp://example.com/',
    'not a url',
  ]) {
    assert.ok(!isAllowedRequestUrl(url, hub, roots), url);
  }
  assert.ok(!isAllowedRequestUrl(`ws://127.0.0.1:${hub}/EvniaHub`, null, roots), 'no hub before startupBackendService');
});

test('kill-switch predicate: file: only below the app tree (no fetch/XHR/<img> of user files)', () => {
  const roots = ['/opt/evnia-precision-center/resources/app.asar'];
  const allowed = (url: string) => isAllowedRequestUrl(url, null, roots);
  assert.ok(allowed('file:///opt/evnia-precision-center/resources/app.asar'), 'the root itself');
  for (const url of [
    'file:///opt/x/index.html',
    'file:///etc/hostname',
    'file:///home/u/.ssh/id_rsa',
    'file:///home/u/Pictures/secret.png',
    'file:///home/u/.config/evnia/config.json',
    // a sibling whose name only starts like the root
    'file:///opt/evnia-precision-center/resources/app.asar.unpacked/node_modules/usb/package.json',
    'file:///opt/evnia-precision-center/resources/other/x.js',
    // traversal, encoded separators and foreign hosts never escape the root
    'file:///opt/evnia-precision-center/resources/app.asar/../../../../etc/passwd',
    'file:///opt/evnia-precision-center/resources/app.asar/%2e%2e/%2e%2e/secret',
    'file:///opt/evnia-precision-center/resources/app.asar/vendor-ui%2F..%2F..%2Fx',
    'file://server/opt/evnia-precision-center/resources/app.asar/vendor-ui/index.html',
  ]) {
    assert.ok(!allowed(url), url);
  }
  assert.ok(!isAllowedRequestUrl('file:///opt/evnia-precision-center/resources/app.asar/vendor-ui/index.html', null, []), 'no roots, no file:');
  // a trailing separator on the root changes nothing
  assert.ok(isAllowedRequestUrl('file:///srv/app/vendor-ui/index.html', null, ['/srv/app/']));
  assert.ok(!isAllowedRequestUrl('file:///srv/app2/index.html', null, ['/srv/app/']));
});

test('redactUrl never logs query strings (the hub token)', () => {
  assert.equal(redactUrl('ws://127.0.0.1:10010/EvniaHub?k=secret'), 'ws://127.0.0.1:10010/EvniaHub');
  assert.equal(redactUrl('https://u:p@saas.zeasn.tv/a?b=c#d'), 'https://saas.zeasn.tv/a');
  assert.equal(redactUrl('data:text/html,<script>'), 'data:…');
});

test('navigation is limited to the page the window was created with', () => {
  const page = 'file:///opt/app/vendor-ui/index.html';
  assert.ok(isAllowedNavigation(`${page}#/overview`, [page]));
  assert.ok(isAllowedNavigation(`${page}?x=1`, [page]));
  assert.ok(!isAllowedNavigation('file:///etc/passwd', [page]));
  assert.ok(!isAllowedNavigation('https://www.evnia.philips/', [page]));
});
