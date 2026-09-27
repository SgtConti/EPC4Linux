// Small pure helpers of the shell: posix path, tray labels/host, autostart entry, geometry,
// foreground-app parsing, capture source selection, display-change watchers, dialog sanitizing (app
// picker, save extension), log files, app paths, runConfig.processPath. The display mode has its own
// file (display-mode.test.ts).

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { applyAutostart, autostartDesktopEntry, autostartDir, quoteExecArg } from '../../../src/main/autostart.ts';
import { pickScreenSource, ScreenGrant } from '../../../src/main/capture-sources.ts';
import {
  appPickerDialogOptions,
  isAppPickerRequest,
  sanitizeOpenDialogOptions,
  sanitizeSaveDialogOptions,
  withSaveExtension,
} from '../../../src/main/dialog-options.ts';
import { isDisplayUevent, isGnomeSession, isMonitorsChangedSignal, LineWatcher, parseUdevMonitorLine } from '../../../src/main/display-watch.ts';
import { flatpakAppIdFromCgroup, isWaylandSession, parseActiveWindow, parseWmClass, parseWmPid } from '../../../src/main/foreground-app.ts';
import { BACKEND_LOG_NAMING, cleanupOldLogs, createFileSink, formatLogLine, MAIN_LOG_NAMING } from '../../../src/main/logfile.ts';
import { INSTALLED_DESKTOP_FILE, resolveAppPaths, SELF_DESKTOP_FILE, selfDesktopFile, userRuntimeDir } from '../../../src/main/paths.ts';
import { SELF_DESKTOP_FILE as BACKEND_SELF_DESKTOP_FILE } from '../../../src/backend/theme/store.ts';
import { basename, join as pjoin } from '../../../src/main/shared/posix-path.ts';
import { legacyTrayLikely, parseNameHasOwner } from '../../../src/main/tray-host.ts';
import { normalizeLanguage, TRAY_LABELS, TRAY_LANGUAGES, trayLabels } from '../../../src/main/tray-i18n.ts';
import { largestWorkArea, noticeBounds, workingSize } from '../../../src/main/window-geometry.ts';

const log = createLogger('test', silentSink);

test('posix join/basename match node:path.posix', () => {
  const joins: string[][] = [
    ['/home/u/.config/evnia', 'ImageCache', 'M', 'normal.png'],
    ['/a/b', '../c', './d'],
    ['a', '', 'b/'],
    ['/a', '/b'],
    ['..', 'x'],
    [''],
    ['/'],
    ['/home/u/.config/evnia', '/ImageCache/34M2C8600'],
    ['a/b', '../../..', 'c'],
  ];
  for (const parts of joins) assert.equal(pjoin(...parts), posix.join(...parts), JSON.stringify(parts));
  const bases: [string, string?][] = [['/a/b/Default.pcenter', '.pcenter'], ['/a/b/', undefined], ['/', undefined], ['x.pcenter', '.pcenter'], ['.pcenter', '.pcenter'], ['/a/b.macro', '.pcenter'], ['a//', undefined]];
  for (const [p, ext] of bases) assert.equal(basename(p, ext), posix.basename(p, ext), JSON.stringify([p, ext]));
});

test('tray labels are the vendor strings (01 §5) for all 10 languages', () => {
  assert.equal(TRAY_LANGUAGES.length, 10);
  assert.deepEqual(TRAY_LABELS.en, { Rescan: 'Rescan', Settings: 'Settings', Exit: 'Exit' });
  assert.deepEqual(TRAY_LABELS['zh-cn'], { Rescan: '重新扫描', Settings: '设置', Exit: '退出' });
  assert.equal(TRAY_LABELS.ja.Settings, 'Settings（設定）');
  assert.equal(TRAY_LABELS.ru.Rescan, 'Повторное сканирование');
  assert.equal(TRAY_LABELS.es.Exit, 'Cerrar');
  assert.equal(TRAY_LABELS.de.Exit, 'Beenden');
  assert.deepEqual(trayLabels('xx'), TRAY_LABELS.en);
});

test('language normalization follows the vendor constructor (01 §3.2)', () => {
  assert.deepEqual(normalizeLanguage('en'), { language: 'en', changed: false });
  assert.deepEqual(normalizeLanguage('zh'), { language: 'zh-cn', changed: true });
  assert.deepEqual(normalizeLanguage('DE'), { language: 'de', changed: true });
  assert.deepEqual(normalizeLanguage('it'), { language: 'en', changed: true });
  assert.deepEqual(normalizeLanguage(undefined), { language: 'en', changed: true });
});

test('tray host detection helpers', () => {
  assert.equal(parseNameHasOwner('(true,)\n'), true);
  assert.equal(parseNameHasOwner('(false,)\n'), false);
  assert.equal(parseNameHasOwner('method return time=1 sender=x\n   boolean true\n'), true);
  assert.equal(parseNameHasOwner('   boolean false\n'), false);
  assert.equal(legacyTrayLikely({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'XFCE' }), true);
  assert.equal(legacyTrayLikely({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), false);
  assert.equal(legacyTrayLikely({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' }), false);
});

test('XDG autostart entry mirrors the vendor login item (--openAsHidden when minimized)', () => {
  const text = autostartDesktopEntry(['/opt/evnia-precision-center/evnia-precision-center'], true);
  assert.match(text, /^\[Desktop Entry\]\nType=Application\n/);
  assert.match(text, /^Exec=\/opt\/evnia-precision-center\/evnia-precision-center --openAsHidden$/m);
  assert.match(text, /^X-GNOME-Autostart-enabled=true$/m);
  assert.doesNotMatch(autostartDesktopEntry(['/usr/bin/x'], false), /openAsHidden/);
  assert.equal(quoteExecArg('/opt/My App/bin'), '"/opt/My App/bin"');
  assert.equal(quoteExecArg('100%'), '100%%');
  assert.equal(quoteExecArg('a"b$c'), '"a\\"b\\$c"');
  assert.equal(autostartDir({ XDG_CONFIG_HOME: '/x/cfg' }), '/x/cfg/autostart');
  const dir = mkdtempSync(join(tmpdir(), 'evnia-autostart-'));
  try {
    applyAutostart({ enabled: true, minimized: false, command: ['/usr/bin/evnia-precision-center'], dir, log });
    assert.match(readFileSync(join(dir, 'evnia-precision-center.desktop'), 'utf8'), /^Exec=\/usr\/bin\/evnia-precision-center$/m);
    applyAutostart({ enabled: false, minimized: false, command: [], dir, log });
    assert.equal(existsSync(join(dir, 'evnia-precision-center.desktop')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('notice toast geometry includes the work-area origin (vendor bug fixed)', () => {
  // 3440x1440 panel, top bar 32 px: vendor factor = 3440/1920.
  assert.deepEqual(noticeBounds({ x: 0, y: 32, width: 3440, height: 1408 }, 1), { width: 430, height: 215, x: 3007, y: 1222 });
  // dock on the left
  assert.deepEqual(noticeBounds({ x: 64, y: 0, width: 1856, height: 1080 }, 1).x, 64 + 1856 - Math.round(240 * (1856 / 1920)) - 3);
  assert.deepEqual(noticeBounds({ x: 0, y: 0, width: 1920, height: 1080 }, 2).width, 480);
});

test('working size and maximum size (01 §4)', () => {
  assert.deepEqual(workingSize(undefined, { width: 3440, height: 1392 }), { width: 1920, height: 1080 });
  assert.deepEqual(workingSize(undefined, { width: 1600, height: 900 }), { width: 1280, height: 720 });
  assert.deepEqual(workingSize({ x: 760, y: 156, width: 1920, height: 1080, maximized: false }, { width: 100, height: 100 }), { width: 1920, height: 1080 });
  assert.deepEqual(largestWorkArea([{ width: 1920, height: 1040 }, { width: 3440, height: 1392 }]), { width: 3440, height: 1392 });
  assert.equal(largestWorkArea([]), null);
});

test('foreground app parsing (xprop) and session detection', () => {
  assert.equal(parseActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007'), '0x3a00007');
  assert.equal(parseActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0'), null);
  assert.equal(parseActiveWindow('_NET_ACTIVE_WINDOW:  not found.'), null);
  assert.equal(parseWmPid('_NET_WM_PID(CARDINAL) = 4242\n'), 4242);
  assert.equal(parseWmPid('_NET_WM_PID:  not found.\n'), null);
  const both = '_NET_WM_PID(CARDINAL) = 4242\nWM_CLASS(STRING) = "gnome-terminal-server", "Gnome-terminal"\n';
  assert.equal(parseWmPid(both), 4242);
  assert.deepEqual(parseWmClass(both), { instance: 'gnome-terminal-server', className: 'Gnome-terminal' });
  assert.deepEqual(parseWmClass('WM_CLASS(STRING) = "a \\"q\\" b", "C\\\\D"'), { instance: 'a "q" b', className: 'C\\D' });
  assert.deepEqual(parseWmClass('WM_CLASS(STRING) = "only"'), { instance: 'only', className: '' });
  assert.equal(parseWmClass('WM_CLASS:  not found.'), null);
  assert.equal(
    flatpakAppIdFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-org.mozilla.firefox-81234.scope\n'),
    'org.mozilla.firefox',
  );
  assert.equal(flatpakAppIdFromCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-flatpak-com.valvesoftware.Steam-9.scope'), 'com.valvesoftware.Steam');
  assert.equal(flatpakAppIdFromCgroup('0::/user.slice/user-1000.slice/session-2.scope\n'), null);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'wayland' }), true);
  assert.equal(isWaylandSession({ XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' }), false);
  assert.equal(isWaylandSession({ WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(isWaylandSession({ DISPLAY: ':0' }), false);
});

test('capture source selection: the primary screen', () => {
  const sources = [{ id: 'screen:1:0', display_id: '11' }, { id: 'screen:2:0', display_id: '22' }];
  assert.equal(pickScreenSource(sources, 22)?.id, 'screen:2:0');
  assert.equal(pickScreenSource(sources, 99)?.id, 'screen:1:0');
  assert.equal(pickScreenSource([], 1), null);
});

test('Wayland screen grant: reused after a start, dropped when a reuse fails or the stream ends', () => {
  const g = new ScreenGrant();
  const screen = { id: 'screen:7:0', name: 'Entire screen' };
  assert.equal(g.reuse(), null, 'nothing granted: ask the portal');
  g.picked(screen);
  g.failed();
  assert.equal(g.reuse(), null, 'a pick that never streamed is no grant');
  g.picked(screen);
  g.started();
  assert.deepEqual(g.reuse(), screen, 'the next request reuses it (portal restore, no dialog)');
  g.started();
  assert.deepEqual(g.granted, screen);
  assert.deepEqual(g.reuse(), screen);
  g.failed();
  assert.equal(g.reuse(), null, 'a failed reuse is not trusted again');
  g.picked(screen);
  g.started();
  g.ended();
  assert.equal(g.reuse(), null, 'the user stopped sharing: ask again');
  g.picked({ id: 'screen:8:0', name: 'B' });
  g.started();
  g.picked({ id: 'screen:9:0', name: 'C' });
  g.failed();
  assert.deepEqual(g.granted, { id: 'screen:8:0', name: 'B' }, 'a failed fresh pick keeps the older grant');
});

test('display watchers: udev drm/i2c-dev events and Mutter MonitorsChanged (20-consolidation §5)', () => {
  const change = parseUdevMonitorLine('UDEV  [48593.183016] change   /devices/pci0000:00/0000:00:02.0/drm/card1 (drm)');
  assert.deepEqual(change, { action: 'change', devpath: '/devices/pci0000:00/0000:00:02.0/drm/card1', subsystem: 'drm' });
  assert.equal(isDisplayUevent(change!), true);
  const i2c = parseUdevMonitorLine('UDEV  [12.000001] add      /devices/pci0000:00/0000:00:02.0/drm/card1/card1-DP-5/i2c-14/i2c-dev/i2c-14 (i2c-dev)');
  assert.equal(i2c?.subsystem, 'i2c-dev');
  assert.equal(isDisplayUevent(i2c!), true);
  assert.equal(isDisplayUevent({ action: 'change', devpath: '/x', subsystem: 'i2c-dev' }), false);
  assert.equal(isDisplayUevent({ action: 'bind', devpath: '/x', subsystem: 'drm' }), false);
  for (const header of ['monitor will print the received events for:', 'UDEV - the event which udev sends out after rule processing', '']) {
    assert.equal(parseUdevMonitorLine(header), null, header);
  }
  assert.equal(isMonitorsChangedSignal('/org/gnome/Mutter/DisplayConfig: org.gnome.Mutter.DisplayConfig.MonitorsChanged ()'), true);
  assert.equal(isMonitorsChangedSignal('/org/gnome/Mutter/DisplayConfig: org.freedesktop.DBus.Properties.PropertiesChanged (…)'), false);
  assert.equal(isMonitorsChangedSignal('The name org.gnome.Mutter.DisplayConfig is owned by :1.20'), false);
  assert.equal(isGnomeSession({ XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' }), true);
  assert.equal(isGnomeSession({ XDG_CURRENT_DESKTOP: 'KDE' }), false);
});

test('display watchers: a missing tool degrades to a log line', async () => {
  const lines: string[] = [];
  const w = new LineWatcher({ name: 'test watcher', command: 'evnia-no-such-tool', args: [], log, onLine: (l) => lines.push(l) });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(w.running, false);
  w.dispose();
  const echo = new LineWatcher({ name: 'echo', command: 'sh', args: ['-c', 'printf "a\\nb\\n"; sleep 5'], log, onLine: (l) => lines.push(l) });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(lines, ['a', 'b']);
  echo.dispose();
  assert.equal(echo.running, false);
});

test('dialog options keep only what the renderer legitimately sets', () => {
  const open = sanitizeOpenDialogOptions({ title: 'Import', filters: [{ name: 'Profile', extensions: ['pcenter', 3] }, { bad: 1 }], properties: ['openDirectory', 'multiSelections'], securityScopedBookmarks: true });
  assert.deepEqual(open, { title: 'Import', filters: [{ name: 'Profile', extensions: ['pcenter'] }], properties: ['openFile'] });
  assert.deepEqual(sanitizeSaveDialogOptions({ title: 'Export', defaultPath: 'Default.pcenter', filters: 'x' }), { title: 'Export', defaultPath: 'Default.pcenter' });
  assert.deepEqual(sanitizeOpenDialogOptions(null), { properties: ['openFile'] });
});

test('app picker: the renderer\'s ["exe"] request opens a .desktop chooser (20-theme §10.2 item 1)', () => {
  // FileSelector.open() of the theme app binding (ST:39812-39832)
  const request = { filters: [{ name: 'Application', extensions: ['exe'] }] };
  assert.equal(isAppPickerRequest(request), true);
  assert.equal(isAppPickerRequest({ filters: [{ name: 'pcenter', extensions: ['pcenter'] }] }), false);
  assert.equal(isAppPickerRequest({ filters: [{ name: 'x', extensions: ['exe', 'bat'] }] }), false);
  assert.equal(isAppPickerRequest({}), false);
  const o = sanitizeOpenDialogOptions(request);
  assert.deepEqual(o, appPickerDialogOptions());
  assert.equal(o.defaultPath, '/usr/share/applications');
  assert.deepEqual(o.filters, [
    { name: 'Applications', extensions: ['desktop'] },
    { name: 'All files', extensions: ['*'] },
  ]);
  assert.deepEqual(o.properties, ['openFile']);
  assert.match(o.title ?? '', /~\/\.local\/share\/applications/);
  assert.match(o.title ?? '', /\/var\/lib\/flatpak\/exports\/share\/applications/);
});

test('save dialog: a single one-extension filter proposes and appends the extension (20-theme §10.2 item 7)', async () => {
  // the profile export of the renderer: FileSelector use-export (ST:39852-39866)
  const s = sanitizeSaveDialogOptions({ title: 'Export', defaultPath: 'Racing', filters: [{ name: 'pcenter', extensions: ['pcenter'] }] });
  assert.equal(s.defaultPath, 'Racing.pcenter');
  assert.equal(sanitizeSaveDialogOptions({ defaultPath: 'v1.2', filters: [{ name: 'macro', extensions: ['macro'] }] }).defaultPath, 'v1.2.macro');
  assert.equal(sanitizeSaveDialogOptions({ defaultPath: 'A.PCENTER', filters: [{ name: 'p', extensions: ['pcenter'] }] }).defaultPath, 'A.PCENTER');
  const none = async () => false;
  assert.equal(await withSaveExtension('/home/u/Racing', s, none), '/home/u/Racing.pcenter');
  assert.equal(await withSaveExtension('/home/u/v1.2', s, none), '/home/u/v1.2.pcenter', 'appended, not replaced');
  assert.equal(await withSaveExtension('/home/u/Racing.pcenter', s, none), '/home/u/Racing.pcenter');
  assert.equal(await withSaveExtension('/home/u/Racing', s, async (p) => p === '/home/u/Racing.pcenter'), '/home/u/Racing', 'never over an existing file the dialog did not confirm');
  const two = sanitizeSaveDialogOptions({ filters: [{ name: 'a', extensions: ['png', 'jpg'] }] });
  assert.equal(await withSaveExtension('/home/u/x', two, none), '/home/u/x', 'no single extension');
  assert.equal(await withSaveExtension('/home/u/x', sanitizeSaveDialogOptions({ filters: [{ name: 'all', extensions: ['*'] }] }), none), '/home/u/x');
});

test('log files: vendor names, line format, retention of matching files only', () => {
  const d = new Date(2026, 8, 26, 7, 52, 24, 578);
  assert.equal(MAIN_LOG_NAMING.fileName(d), '26-09-26.log');
  assert.equal(BACKEND_LOG_NAMING.fileName(d), '2026-09-26.txt');
  assert.equal(formatLogLine(d, 'info', 'main/app', ['App ready, version', '1.13.0']), '[2026-09-26 07:52:24.578] [info] [main/app] App ready, version 1.13.0\n');
  const dir = mkdtempSync(join(tmpdir(), 'evnia-logs-'));
  try {
    for (const f of ['26-09-01.log', '26-09-01.log.1', '26-09-25.log', 'notes.txt']) writeFileSync(join(dir, f), 'x');
    const old = new Date(Date.now() - 10 * 24 * 3600 * 1000);
    for (const f of ['26-09-01.log', '26-09-01.log.1', 'notes.txt']) utimesSync(join(dir, f), old, old);
    cleanupOldLogs(dir, MAIN_LOG_NAMING, 5);
    assert.deepEqual(readdirSync(dir).sort(), ['26-09-25.log', 'notes.txt']);
    const sink = createFileSink({ dir, naming: MAIN_LOG_NAMING, maxBytes: 200 });
    for (let i = 0; i < 5; i++) sink('info', 'main/app', [`line ${i} ${'x'.repeat(40)}`]);
    const today = MAIN_LOG_NAMING.fileName(new Date());
    assert.ok(existsSync(join(dir, `${today}.1`)), 'rotated at maxBytes');
    assert.match(readFileSync(join(dir, today), 'utf8'), /line 4/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app paths mirror the vendor layout (01 §2); the debug flag is per user', () => {
  const p = resolveAppPaths('/opt/x/resources/app.asar', '/home/u/.config', userRuntimeDir({ XDG_RUNTIME_DIR: '/run/user/1000' }));
  assert.equal(p.userData, '/home/u/.config/evnia');
  assert.equal(p.serveDataDir, '/home/u/.config/EvniaServe');
  assert.equal(p.patchPath, '/home/u/.config/evnia/patch/RES_PCenter_101300');
  assert.equal(p.debugFlag, '/run/user/1000/evnia-debug-open.tmp');
  assert.equal(userRuntimeDir({}), tmpdir(), 'no XDG_RUNTIME_DIR: os.tmpdir() with the ownership check');
  assert.equal(userRuntimeDir({ XDG_RUNTIME_DIR: 'relative' }), tmpdir());
  assert.equal(p.bundledMonitorInfo, '/opt/x/resources/app.asar/resources/MonitorInfo.json');
  assert.equal(p.uiIndex, '/opt/x/resources/app.asar/vendor-ui/index.html');
});

test('runConfig.processPath is the port\'s own .desktop (20-theme §10.2 item 2)', () => {
  assert.equal(SELF_DESKTOP_FILE, BACKEND_SELF_DESKTOP_FILE, 'the entry the backend refuses to bind');
  assert.equal(SELF_DESKTOP_FILE, 'evnia-precision-center.desktop');
  assert.ok(existsSync(join(import.meta.dirname, '..', '..', '..', 'packaging', 'deb', SELF_DESKTOP_FILE)), 'the packaged entry has this name');
  const env = { HOME: '/home/u', XDG_DATA_DIRS: '/usr/local/share:/usr/share' };
  const present = (set: string[]) => (p: string) => set.includes(p);
  assert.equal(selfDesktopFile(env, present([])), INSTALLED_DESKTOP_FILE);
  assert.equal(INSTALLED_DESKTOP_FILE, '/usr/share/applications/evnia-precision-center.desktop');
  assert.equal(selfDesktopFile(env, present(['/usr/share/applications/evnia-precision-center.desktop'])), '/usr/share/applications/evnia-precision-center.desktop');
  assert.equal(
    selfDesktopFile(env, present(['/usr/share/applications/evnia-precision-center.desktop', '/home/u/.local/share/applications/evnia-precision-center.desktop'])),
    '/home/u/.local/share/applications/evnia-precision-center.desktop',
    'a user override comes first, like the XDG lookup',
  );
});
