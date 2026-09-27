// Shared helpers for the theme-module tests (not a test file itself).

import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { ApiModule, ApiServices, BackendEvents, CoreServices } from '../../../src/backend/index.ts';
import type { DeviceProfileDesc, MonitorManager, ProfileParticipant } from '../../../src/backend/services.ts';
import type { BackendOptions, HostServices, JsonResult } from '../../../src/backend/types.ts';
import { EventBus } from '../../../src/backend/core/events.ts';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { RpcDispatcher } from '../../../src/backend/rpc/dispatcher.ts';
import { HubNotifier } from '../../../src/backend/rpc/notifier.ts';
import { createThemeStore, type ThemeStoreImpl, type ThemeStoreOptions } from '../../../src/backend/theme/store.ts';
import { themeApi } from '../../../src/backend/api/theme.ts';
import { macroApi } from '../../../src/backend/api/macro.ts';
import { settingApi } from '../../../src/backend/api/setting.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, '..', '..', 'fixtures', 'windows');
export const WIN_SERVE = join(FIXTURES, 'EvniaServe');
export const FIXTURE_DATA_THEME = join(WIN_SERVE, 'Theme', 'DataTheme.cfg');
export const FIXTURE_DEFAULT_PCENTER = join(WIN_SERVE, 'Theme', 'User', 'Default.pcenter');
export const FIXTURE_SOFT_CONFIG = join(WIN_SERVE, 'Config', 'SoftConfig.data');

export const DISPLAY_DESC: DeviceProfileDesc = { EquipmentType: 1, DeviceType: 100000, ModelName: 'PHL 34M2C8600', ExtModel: '' };

/** A fresh `<tmp>/…/EvniaServe` (optionally seeded with the user's Windows files), removed after the test. */
export async function tempServeDir(t: TestContext, seed = false, name = 'EvniaServe'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evnia-theme-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serve = join(root, name);
  await mkdir(serve, { recursive: true });
  await mkdir(join(root, 'evnia'), { recursive: true });
  await mkdir(join(root, 'resources'), { recursive: true });
  if (seed) {
    await cp(join(WIN_SERVE, 'Theme'), join(serve, 'Theme'), { recursive: true });
    await mkdir(join(serve, 'Config'), { recursive: true });
    await cp(FIXTURE_SOFT_CONFIG, join(serve, 'Config', 'SoftConfig.data'));
  }
  return serve;
}

export interface Harness {
  serve: string;
  root: string;
  store: ThemeStoreImpl;
  core: CoreServices;
  notifications: { name: string; tag: unknown; json: string }[];
  foreground: { path: string | null };
  /** Call a Bridge function through the real dispatcher; returns the parsed reply and its raw JSON. */
  call(name: string, ...parms: unknown[]): Promise<JsonResult & { raw: string }>;
  dispatcher: RpcDispatcher;
}

export interface HarnessOptions {
  seed?: boolean;
  store?: ThemeStoreOptions;
  monitors?: Partial<MonitorManager>;
  modules?: readonly ApiModule[];
  start?: boolean;
  /** Name of the serve-data directory (default "EvniaServe"; FactoryReset only wipes all of an "EvniaServe"). */
  serveName?: string;
  /** Extra host services, e.g. main's pathAllowed policy. */
  host?: Partial<HostServices>;
}

export async function harness(t: TestContext, o: HarnessOptions = {}): Promise<Harness> {
  const serve = await tempServeDir(t, o.seed ?? false, o.serveName);
  const root = dirname(serve);
  const log = createLogger('test', silentSink);
  const foreground: { path: string | null } = { path: null };
  const host: HostServices = {
    log,
    serveDataDir: serve,
    appDataDir: join(root, 'evnia'),
    resourcesDir: join(root, 'resources'),
    getForegroundAppPath: () => foreground.path,
    ...o.host,
  };
  const notifier = new HubNotifier(log.child('notify'));
  const notifications: Harness['notifications'] = [];
  notifier.subscribe((json) => {
    const r = JSON.parse(json) as JsonResult;
    notifications.push({ name: r.FunctionName ?? '', tag: r.Tag, json });
  });
  const options: BackendOptions = { host, noHardware: true };
  const core: CoreServices = { log, notifier, host, events: new EventBus<BackendEvents>(), options };
  const store = createThemeStore(core, { saveDebounceMs: 0, appTempDir: join(root, 'tmp-EvniaServe'), ...o.store });
  const services = { ...core, themes: store, monitors: o.monitors as ApiServices['monitors'] } as ApiServices;
  const dispatcher = new RpcDispatcher(log.child('rpc'));
  for (const m of o.modules ?? [themeApi, macroApi, settingApi]) m(dispatcher, services);
  if (o.start !== false) await store.start();
  t.after(() => store.stop());
  let n = 0;
  const call = async (name: string, ...parms: unknown[]) => {
    const raw = await dispatcher.dispatch(JSON.stringify({ functionName: name, requestId: `req-${++n}`, parms: parms.length ? parms : null }));
    return { ...(JSON.parse(raw) as JsonResult), raw };
  };
  return { serve, root, store, core, notifications, foreground, call, dispatcher };
}

/** A fake display driver: records applied contents, purifies a settable JSON string. */
export class FakeParticipant implements ProfileParticipant {
  readonly desc: DeviceProfileDesc;
  content: string;
  applied: (string | null)[] = [];
  resets = 0;
  onApply?: (content: string | null) => Promise<void>;

  constructor(content = '{"IsSmartImageHDR":true,"ModelName":"PHL 34M2C8600"}', desc: DeviceProfileDesc = DISPLAY_DESC) {
    this.content = content;
    this.desc = desc;
  }

  purify(): string {
    return this.content;
  }

  async applyProfileContent(content: string | null): Promise<void> {
    this.applied.push(content);
    if (content) this.content = content;
    await this.onApply?.(content);
  }

  async resetToFactory(): Promise<void> {
    this.resets++;
    this.content = '{"Reset":true,"ModelName":"PHL 34M2C8600"}';
  }
}

/** A MonitorManager stub with one connected display named `monitorName`. */
export function fakeMonitors(monitorName = 'PHL 34M2C8600'): Partial<MonitorManager> {
  return { displays: () => [{ monitorName } as never] };
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/** File contents without the UTF-8 BOM (asserting it is there). */
export async function readConfig(path: string): Promise<string> {
  const buf = await readFile(path);
  if (buf[0] !== 0xef || buf[1] !== 0xbb || buf[2] !== 0xbf) throw new Error(`${path} has no UTF-8 BOM`);
  return buf.subarray(3).toString('utf8');
}

export const USER_DATA_THEME = '{"ThemeInfos":[{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]}]}';

/** `p`, or a rejection naming `label` when it has not settled within `ms` (turns a deadlock into a failure). */
export function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DEADLOCK: ${label} still pending after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Poll `cond` every 2 ms until it holds (or fail after `ms`). */
export async function until(cond: () => boolean, ms: number, label: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

/** A promise with its resolver (a gate a test opens). */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}
