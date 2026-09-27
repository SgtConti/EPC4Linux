// registerIpcHandlers (src/main/ipc.ts) together with the preload API (src/preload/api.ts), over a
// fake ipcMain/ipcRenderer bus: window.store write-through and the cross-window broadcast, sender
// checks (capture window, subframes), the nodeApi confinement end to end, and the preload allowlist.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createLogger } from '../../../src/backend/core/log.ts';
import { DeviceChangeGate } from '../../../src/main/device-events.ts';
import { PathGuard } from '../../../src/main/fs-guard.ts';
import { FILE_SELECT_MAX_BUFFER, type IpcElectron, type IpcHost, isTrustedSender, registerIpcHandlers } from '../../../src/main/ipc.ts';
import { resolveAppPaths } from '../../../src/main/paths.ts';
import { INTERNAL_CHANNELS } from '../../../src/main/shared/channels.ts';
import { ConfigStore } from '../../../src/main/store.ts';
import type { MainWindowController, NoticeWindowController } from '../../../src/main/windows.ts';
import { createPreloadApi, type IpcRendererLike, type PreloadApi } from '../../../src/preload/api.ts';

/** What the handlers logged (the renderer-log bridge test reads it). */
const logged: Array<{ level: string; scope: string; text: string }> = [];
const log = createLogger('test', (level, scope, args) => void logged.push({ level, scope, text: args.map(String).join(' ') }), 'debug');
const quiet = { warn: () => {}, error: () => {} };

type Handler = (e: FakeEvent, ...args: unknown[]) => unknown;
interface FakeEvent {
  sender: FakeWebContents;
  senderFrame: object | null;
  returnValue?: unknown;
}

class FakeWebContents {
  readonly mainFrame = { top: true };
  readonly sent: Array<[string, ...unknown[]]> = [];
  readonly listeners = new Map<string, Set<(e: unknown, ...a: unknown[]) => void>>();
  send(channel: string, ...args: unknown[]): void {
    this.sent.push([channel, ...args]);
    for (const l of [...(this.listeners.get(channel) ?? [])]) l({ sender: 'leak' }, ...args);
  }
  isDestroyed(): boolean {
    return false;
  }
}

class FakeIpcMain {
  readonly handlers = new Map<string, Handler>();
  readonly listeners = new Map<string, Handler[]>();
  handle(channel: string, fn: Handler): void {
    this.handlers.set(channel, fn);
  }
  on(channel: string, fn: Handler): this {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), fn]);
    return this;
  }
  async invoke(sender: FakeWebContents, frame: object | null, channel: string, ...args: unknown[]): Promise<unknown> {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`No handler registered for '${channel}'`);
    return fn({ sender, senderFrame: frame }, ...args);
  }
  send(sender: FakeWebContents, frame: object | null, channel: string, ...args: unknown[]): unknown {
    const e: FakeEvent = { sender, senderFrame: frame };
    for (const fn of this.listeners.get(channel) ?? []) fn(e, ...args);
    return e.returnValue;
  }
}

/** ipcRenderer of `wc` (top frame unless `frame` is given) on the fake bus. */
function rendererFor(ipcMain: FakeIpcMain, wc: FakeWebContents, frame: object = wc.mainFrame): IpcRendererLike {
  const add = (channel: string, l: (e: unknown, ...a: unknown[]) => void) => {
    let set = wc.listeners.get(channel);
    if (!set) wc.listeners.set(channel, (set = new Set()));
    set.add(l);
  };
  return {
    send: (channel, ...args) => void ipcMain.send(wc, frame, channel, ...args),
    sendSync: (channel, ...args) => ipcMain.send(wc, frame, channel, ...args),
    invoke: (channel, ...args) => ipcMain.invoke(wc, frame, channel, ...args),
    on: (channel, l) => add(channel, l),
    once: (channel, l) => {
      const w = (e: unknown, ...a: unknown[]) => {
        wc.listeners.get(channel)?.delete(w);
        l(e, ...a);
      };
      add(channel, w);
    },
    removeListener: (channel, l) => wc.listeners.get(channel)?.delete(l),
  };
}

let dir: string;
let userData: string;
let outside: string;
let bus: FakeIpcMain;
let mainWc: FakeWebContents;
let noticeWc: FakeWebContents;
let captureWc: FakeWebContents;
let host: IpcHost;
let picked: string[];
let requests: string[];
let openOptions: unknown[];
let saveOptions: unknown[];
let saveAnswer: { canceled: boolean; filePath: string };

beforeEach(() => {
  logged.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'evnia-ipc-'));
  const paths = resolveAppPaths('/opt/evnia/resources/app.asar', join(dir, 'config'), join(dir, 'run'));
  userData = paths.userData;
  outside = join(dir, 'home');
  mkdirSync(userData, { recursive: true });
  mkdirSync(outside, { recursive: true });
  bus = new FakeIpcMain();
  mainWc = new FakeWebContents();
  noticeWc = new FakeWebContents();
  captureWc = new FakeWebContents();
  picked = [];
  requests = [];
  openOptions = [];
  saveOptions = [];
  saveAnswer = { canceled: true, filePath: '' };
  const mainWindow = { isDestroyed: () => false, webContents: mainWc, minimize: () => requests.push('minimize') };
  host = {
    log,
    paths,
    store: new ConfigStore(join(userData, 'config.json'), log),
    guard: new PathGuard({ readRoots: [userData, paths.serveDataDir], scratchDir: userData }),
    gate: new DeviceChangeGate(() => {}, log),
    main: { window: mainWindow, resetToStartSize: () => requests.push('reset') } as unknown as MainWindowController,
    notice: { webContents: noticeWc, notice: () => requests.push('notice') } as unknown as NoticeWindowController,
    hubToken: 'per-launch-token',
    runConfig: () => ({ appVersion: '1.13.0', isDebugMode: false, isFirstRun: false, isPackaged: true, mac: '', patchPath: '', processPath: '/opt/evnia/evnia', userDataPath: userData }),
    startBackend: async () => 10010,
    monitorJsonConfig: () => ({ OTAEnable: false, config: {} }),
    onInterfaceInitializeCompleted: () => requests.push('init'),
    requestClose: () => requests.push('close'),
    setLanguage: () => {},
    setAutoStartUp: () => {},
    setTrayFlags: () => {},
  };
  const electron: IpcElectron = {
    ipcMain: bus as unknown as IpcElectron['ipcMain'],
    dialog: {
      showOpenDialog: async (_w: unknown, o: unknown) => {
        openOptions.push(o);
        return { canceled: false, filePaths: picked.splice(0, 1) };
      },
      showSaveDialog: async (_w: unknown, o: unknown) => {
        saveOptions.push(o);
        return saveAnswer;
      },
    } as unknown as IpcElectron['dialog'],
    focusedWindow: () => null,
    windowOf: () => mainWindow as unknown as ReturnType<IpcElectron['windowOf']>,
  };
  registerIpcHandlers(host, electron);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const preload = (wc: FakeWebContents, frame?: object): PreloadApi => createPreloadApi(rendererFor(bus, wc, frame), quiet);
const onDisk = () => JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')) as Record<string, unknown>;

test('window.store: snapshot at load, write-through to config.json, broadcast to the other window only', () => {
  const main = preload(mainWc);
  const notice = preload(noticeWc);
  assert.equal(main.store.get('language'), 'en');
  main.store.set('noticeSwitch', true);
  assert.equal(onDisk().noticeSwitch, true, 'main persisted the write');
  assert.equal(notice.store.get('noticeSwitch'), true, 'the notice window saw the change');
  assert.ok(!mainWc.sent.some(([c]) => c === INTERNAL_CHANNELS.storeChanged), 'the writer is not echoed');
  main.store.set('tutorials.MonitorView', true);
  assert.deepEqual(notice.store.get('tutorials'), { MonitorView: true }, 'dot paths');
  main.store.set({ noticeStyle: 1, overviewType: 'list' });
  assert.deepEqual([notice.store.get('noticeStyle'), onDisk().overviewType], [1, 'list']);
  notice.store.delete('tutorials');
  assert.equal(main.store.get('tutorials'), undefined);
  assert.ok(!('tutorials' in onDisk()));
});

test('window.store: pinned and invalid writes behave like main on both sides', () => {
  const main = preload(mainWc);
  const notice = preload(noticeWc);
  main.store.set('autoUpdate', true);
  assert.equal(main.store.get('autoUpdate'), false);
  assert.equal(onDisk().autoUpdate, false);
  assert.throws(() => main.store.set('language', 5), TypeError);
  assert.throws(() => main.store.set('password', 'x'), /not stored/);
  assert.equal(onDisk().language, 'en');
  const bounds = { x: 1, y: 2, width: 1280, height: 720, maximized: false };
  host.store.set('mainWindowBounds', bounds);
  assert.deepEqual([main.store.get('mainWindowBounds'), notice.store.get('mainWindowBounds')], [bounds, bounds], "main's own writes reach every window");
  const copy = main.store.get('mainWindowBounds') as { x: number };
  copy.x = 99;
  assert.equal((main.store.get('mainWindowBounds') as { x: number }).x, 1, 'get returns a copy');
});

test('hub token only for the main window; the capture window and subframes are refused', async () => {
  assert.equal(preload(mainWc).evnia.hubToken, 'per-launch-token');
  assert.equal(preload(noticeWc).evnia.hubToken, '');
  const capture = preload(captureWc);
  assert.equal(capture.evnia.hubToken, '');
  assert.equal(capture.store.get('language'), undefined, 'no store snapshot for an untrusted sender');
  const sub = { top: false };
  for (const [wc, frame] of [[captureWc, captureWc.mainFrame], [mainWc, sub], [mainWc, null]] as const) {
    await assert.rejects(bus.invoke(wc, frame, 'startupBackendService'), /refused/);
    await assert.rejects(bus.invoke(wc, frame, 'getRunConfig'), /refused/);
    assert.deepEqual(bus.send(wc, frame, INTERNAL_CHANNELS.fsReadSync, join(userData, 'config.json'), 'utf8'), {
      ok: false,
      code: 'EACCES',
      message: "EACCES: permission denied, ''",
    });
    assert.equal(bus.send(wc, frame, INTERNAL_CHANNELS.fsExists, join(userData, 'config.json')), false);
    bus.send(wc, frame, INTERNAL_CHANNELS.storeSet, 'language', 'de');
    bus.send(wc, frame, 'interfaceInitializeCompleted');
  }
  assert.equal(onDisk().language, 'en');
  assert.deepEqual(requests, []);
  assert.equal(await bus.invoke(mainWc, mainWc.mainFrame, 'startupBackendService'), 10010);
  bus.send(mainWc, mainWc.mainFrame, 'interfaceInitializeCompleted');
  assert.deepEqual(requests, ['init']);
  assert.equal(isTrustedSender({ sender: mainWc, senderFrame: mainWc.mainFrame } as never, [mainWc as never]), true);
});

test('nodeApi: profile import temp copy and cleanup work; app state is never overwritten or deleted', async () => {
  const api = preload(mainWc).nodeApi;
  const profile = join(outside, 'Racing.pcenter');
  writeFileSync(profile, '{"profile":1}');
  picked.push(profile);
  const sel = (await preload(mainWc).ipc.invoke('fileSelect', {})) as { path: string; size: number };
  assert.equal(sel.path, profile);
  // the vendor import: copy to <userData>/<basename>.slice(0, 30), hand it to the backend, unlink it
  const temp = api.pathJoin(userData, api.getBaseName(profile, '.pcenter').slice(0, 30));
  api.copyFileSync(profile, temp);
  assert.equal(readFileSync(temp, 'utf8'), '{"profile":1}');
  api.unlinkSync(temp);
  assert.equal(existsSync(temp), false);
  // "config.json.pcenter" would have replaced main's store and then deleted it
  const hostile = join(outside, 'config.json.pcenter');
  writeFileSync(hostile, '{"language":"xx"}');
  picked.push(hostile);
  await preload(mainWc).ipc.invoke('fileSelect', {});
  const before = readFileSync(join(userData, 'config.json'), 'utf8');
  assert.throws(() => api.copyFileSync(hostile, api.pathJoin(userData, api.getBaseName(hostile, '.pcenter'))), { code: 'EACCES' });
  api.unlinkSync(join(userData, 'config.json'));
  assert.equal(readFileSync(join(userData, 'config.json'), 'utf8'), before);
  // reads stay confined
  assert.equal(api.existsSync('/etc/passwd'), false);
  assert.throws(() => api.readFileSync('/etc/passwd', 'utf8'), { code: 'EACCES' });
  assert.throws(() => api.copyFileSync('/etc/passwd', join(userData, 'passwd')), { code: 'EACCES' });
  const text = await new Promise<unknown>((resolve, reject) => api.readFile(join(userData, 'config.json'), 'utf8', (err, data) => (err ? reject(err) : resolve(data))));
  assert.equal(text, before);
});

test('fileSelect: the renderer\'s ["exe"] app picker opens the .desktop chooser; the pick is not read', async () => {
  const entry = join(outside, 'org.gnome.Calculator.desktop');
  writeFileSync(entry, '[Desktop Entry]\nType=Application\nName=Calculator\nExec=gnome-calculator\n');
  picked.push(entry);
  const sel = (await preload(mainWc).ipc.invoke('fileSelect', { filters: [{ name: 'Application', extensions: ['exe'] }] })) as {
    path: string;
    size: number;
    buffer: unknown;
  };
  assert.deepEqual(sel, { path: entry, size: 71, buffer: null });
  const o = openOptions[0] as { defaultPath: string; filters: { extensions: string[] }[] };
  assert.equal(o.defaultPath, '/usr/share/applications');
  assert.deepEqual(o.filters.map((f) => f.extensions), [['desktop'], ['*']]);
  assert.equal(preload(mainWc).nodeApi.existsSync(entry), false, 'a binding target is not made readable');
  // any other picker returns the content and makes the file readable (profile import)
  const profile = join(outside, 'Racing.pcenter');
  writeFileSync(profile, '{}');
  picked.push(profile);
  const imp = (await preload(mainWc).ipc.invoke('fileSelect', { filters: [{ name: 'pcenter', extensions: ['pcenter'] }] })) as { buffer: Uint8Array };
  assert.equal(Buffer.from(imp.buffer).toString(), '{}');
  assert.equal(preload(mainWc).nodeApi.existsSync(profile), true);
  assert.equal(await preload(mainWc).ipc.invoke('getFileSize', profile), 2);
});

test('exportFile: GTK does not add the extension, main does (never over a file the dialog did not confirm)', async () => {
  const request = { title: 'Export', defaultPath: 'Racing', filters: [{ name: 'pcenter', extensions: ['pcenter'] }] };
  saveAnswer = { canceled: false, filePath: join(outside, 'Racing') };
  assert.deepEqual(await preload(mainWc).ipc.invoke('exportFile', request), { canceled: false, filePath: join(outside, 'Racing.pcenter') });
  assert.equal((saveOptions[0] as { defaultPath: string }).defaultPath, 'Racing.pcenter', 'the proposed name carries it');
  writeFileSync(join(outside, 'Racing.pcenter'), 'older export');
  assert.deepEqual(await preload(mainWc).ipc.invoke('exportFile', request), { canceled: false, filePath: join(outside, 'Racing') });
  saveAnswer = { canceled: true, filePath: '' };
  assert.deepEqual(await preload(mainWc).ipc.invoke('exportFile', request), { canceled: true, filePath: '' });
});

test('exportFile: the chosen path becomes a one-shot write grant for the backend (Theme_ExportProfile, Macro_Export)', async () => {
  const request = { title: 'Export', defaultPath: 'Racing', filters: [{ name: 'pcenter', extensions: ['pcenter'] }] };
  const chosen = join(outside, 'Racing.pcenter');
  assert.equal(host.guard.backendMayAccess(chosen, 'write'), false, 'nothing chosen yet');
  saveAnswer = { canceled: false, filePath: join(outside, 'Racing') };
  assert.deepEqual(await preload(mainWc).ipc.invoke('exportFile', request), { canceled: false, filePath: chosen });
  assert.equal(host.guard.backendMayAccess(join(outside, 'Racing'), 'write'), false, 'the path the renderer gets, not the one typed');
  assert.equal(host.guard.backendMayAccess(chosen, 'write'), true);
  assert.equal(host.guard.backendMayAccess(chosen, 'write'), false, 'once');
  saveAnswer = { canceled: true, filePath: join(outside, 'Other.pcenter') };
  await preload(mainWc).ipc.invoke('exportFile', request);
  assert.equal(host.guard.backendMayAccess(join(outside, 'Other.pcenter'), 'write'), false, 'a cancelled dialog grants nothing');
  // a capture window cannot obtain grants either (sender check)
  saveAnswer = { canceled: false, filePath: join(outside, 'Evil.pcenter') };
  await assert.rejects(preload(captureWc).ipc.invoke('exportFile', request));
  assert.equal(host.guard.backendMayAccess(join(outside, 'Evil.pcenter'), 'write'), false);
});

test('picked and confined files: regular files only, at most the renderer\'s 20 MiB, never blocking on a FIFO or device', async (t) => {
  const api = preload(mainWc).nodeApi;
  const ipc = preload(mainWc).ipc;
  // fileSelect: a FIFO or a character device picked by name is no pick at all (and not made readable)
  const fifo = join(outside, 'pipe.pcenter');
  const mkfifo = spawnSync('mkfifo', [fifo]);
  if (mkfifo.status === 0) {
    picked.push(fifo);
    assert.deepEqual(await ipc.invoke('fileSelect', {}), { path: '', size: 0, buffer: null });
    assert.equal(api.existsSync(fifo), false);
    // …and one inside the confined roots is refused by every channel at once
    const inside = join(userData, 'pipe');
    spawnSync('mkfifo', [inside]);
    assert.throws(() => api.readFileSync(inside, 'utf8'), { code: 'EINVAL' });
    await assert.rejects(new Promise((resolve, reject) => api.readFile(inside, (err, data) => (err ? reject(err) : resolve(data)))), { code: 'EINVAL' });
    assert.throws(() => api.copyFileSync(inside, join(userData, 'copy')), { code: 'EINVAL' });
    assert.equal(existsSync(join(userData, 'copy')), false);
    assert.equal(await ipc.invoke('getFileMd5', inside), '');
  } else t.diagnostic('mkfifo unavailable: FIFO cases skipped');
  picked.push('/dev/zero');
  assert.deepEqual(await ipc.invoke('fileSelect', {}), { path: '', size: 0, buffer: null }, '/dev/zero reports size 0 but never ends');
  // a regular file above the limit: its size, no content; nodeApi refuses to read or copy it
  const big = join(outside, 'big.pcenter');
  writeFileSync(big, '');
  truncateSync(big, FILE_SELECT_MAX_BUFFER + 1);
  picked.push(big);
  assert.deepEqual(await ipc.invoke('fileSelect', {}), { path: big, size: FILE_SELECT_MAX_BUFFER + 1, buffer: null });
  assert.throws(() => api.readFileSync(big), { code: 'EFBIG' });
  assert.throws(() => api.copyFileSync(big, join(userData, 'big')), { code: 'EFBIG' });
  assert.equal(await ipc.invoke('getFileSize', big), FILE_SELECT_MAX_BUFFER + 1, 'the size is still known (ProfileSizeExceed)');
  // a directory is no file
  assert.throws(() => api.readFileSync(userData), { code: 'EISDIR' });
  // the content goes over IPC as exactly its bytes (a view of a pooled buffer would carry more)
  const small = join(outside, 'small.pcenter');
  writeFileSync(small, '{"a":1}');
  picked.push(small);
  const sel = (await ipc.invoke('fileSelect', {})) as { buffer: Uint8Array };
  assert.equal(sel.buffer.byteLength, 7);
  assert.equal(sel.buffer.buffer.byteLength, 7);
  assert.equal(await ipc.invoke('getFileMd5', small), createHash('md5').update('{"a":1}').digest('hex'));
  const bytes = api.readFileSync(small) as Uint8Array;
  assert.equal(bytes.buffer.byteLength, 7);
  assert.equal(api.readFileSync(small, 'utf8'), '{"a":1}');
});

test('window.__electronLog: the renderer\'s electron-log lines reach the main log; the capture window and subframes are refused', () => {
  // Found by the e2e walkthrough: without this bridge the vendor renderer logs "electron-log: logger isn't
  // initialized in the main process" as a console error (e.g. on a monitor unplug, main-CDosWiM3.js:1749).
  const main = preload(mainWc);
  main.electronLog.sendToMain({ data: ['[renderer/useConnectDetection]', 'To overview device list empty'], level: 'info', logId: 'default' });
  main.electronLog.warn('direct', { n: 1 });
  main.electronLog.sendToMain({ cmd: 'errorHandler', errorName: 'Unhandled', error: { name: 'Error', message: 'boom', stack: 'Error: boom\n at x' } });
  main.electronLog.sendToMain('not a message');
  const renderer = logged.filter((l) => l.scope === 'test/renderer');
  assert.deepEqual(
    renderer.map((l) => [l.level, l.text]),
    [
      ['info', '[renderer/useConnectDetection] To overview device list empty'],
      ['warn', 'direct {"n":1}'],
      ['error', 'Unhandled Error: boom | at x'],
    ],
  );
  logged.length = 0;
  preload(captureWc).electronLog.info('from the capture window');
  preload(mainWc, { top: false }).electronLog.info('from a subframe');
  assert.deepEqual(logged.filter((l) => l.scope === 'test/renderer'), [], 'nothing logged for untrusted senders');
  assert.equal(logged.filter((l) => l.text.includes(`IPC ${INTERNAL_CHANNELS.rendererLog} refused`)).length, 2);
});

test('preload ipc: allowlist, inert offline answers, sanitized listener events', async () => {
  const { ipc } = preload(mainWc);
  assert.deepEqual(await ipc.invoke('runCommand', 'id'), { error: { message: 'disabled' }, stdout: '' });
  assert.equal(await ipc.invoke('noSuchChannel'), undefined);
  const versionCheck = new Promise((resolve) => ipc.once('versionCheckResult', (_e, r) => resolve(r)));
  ipc.send('checkSoftwareVersion');
  assert.equal(((await versionCheck) as { state: number }).state, 0);
  ipc.send('openDefaultBrowser', 'https://example.com');
  assert.ok(!bus.listeners.has('openDefaultBrowser'), 'stripped channels have no handler in main');
  const events: unknown[][] = [];
  const off = ipc.on('displayChange', (e, ...args) => events.push([e, ...args]));
  mainWc.send('displayChange', 1);
  assert.deepEqual(events, [[{}, 1]], 'the page never sees the IpcRendererEvent');
  assert.equal(ipc.listeners('displayChange').length, 1);
  off();
  mainWc.send('displayChange', 2);
  assert.equal(events.length, 1);
  ipc.on('evnia:store-changed', () => events.push(['leak']));
  mainWc.send(INTERNAL_CHANNELS.storeChanged, 'language', 'de');
  assert.equal(events.length, 1, 'internal channels cannot be subscribed from the page');
});
