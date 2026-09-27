// Shared helpers for the monitor unit tests (not a test file itself).

import { copyFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, DiscoveredMonitor, DisplayModeInfo, HostServices, Logger, Notifier } from '../../../src/backend/types.ts';
import { parseEdid } from '../../../src/backend/ddc/edid.ts';
import type { AmbiglowService, DeviceProfileDesc, DisplayDevice, ProfileParticipant, SoftConfig, ThemeStore, ThemeSwitchEvent } from '../../../src/backend/services.ts';
import { createLogger } from '../../../src/backend/core/log.ts';
import { serialize, stripBom } from '../../../src/backend/core/json.ts';
import { type DdcClock, NO_DELAY_TIMINGS } from '../../../src/backend/ddc/channel.ts';
import { DeviceDictionary, DISPLAY_DEVICE_RECORD } from '../../../src/backend/monitor/model/device-info.ts';
import { CapabilityCache } from '../../../src/backend/ddc/cap-cache.ts';
import { type MockMonitorBundle, MockDdcTransport, SimulatedMonitor, createMock34M2C8600 } from '../../../src/backend/ddc/transports/mock.ts';
import type { MockMonitorSpec } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { USER_34M2C8600 } from '../../fixtures/user-monitor.ts';
import { PhlDisplay, type PhlDisplayOptions } from '../../../src/backend/monitor/display.ts';
import { createBackend, type ApiModule } from '../../../src/backend/index.ts';
import { createMonitorManager, type MonitorManagerImpl, type MonitorManagerOptions } from '../../../src/backend/monitor/manager.ts';
import { phlApi } from '../../../src/backend/api/phl.ts';
import { deviceApi } from '../../../src/backend/api/device.ts';
import { profileApi } from '../../../src/backend/api/profile.ts';
import { displayFwApi } from '../../../src/backend/api/displayfw.ts';

export const fixture = (rel: string) => new URL(`../../fixtures/windows/${rel}`, import.meta.url);
export const localFixture = (rel: string) => new URL(`./fixtures/${rel}`, import.meta.url);

export const silentLog: Logger = createLogger('test', () => {}, 'error');

/** The user's Theme/User/Default.pcenter wrapper (UTF-8 BOM, one line). */
export function defaultPcenterText(): string {
  return readFileSync(fixture('EvniaServe/Theme/User/Default.pcenter'), 'utf8');
}

/** The nested ProfileContent string of the display section of Default.pcenter. */
export function defaultProfileContent(): string {
  const wrapper = JSON.parse(stripBom(defaultPcenterText())) as { Profiles: Array<{ ProfileContent: string }> };
  return wrapper.Profiles[0].ProfileContent;
}

/** The computed hub Tag of 20-enum-valuelist-catalog §5 (compact, 29403 bytes). */
export function expectedDeviceDataTag(): string {
  return readFileSync(localFixture('profile-get-device-data.tag.json'), 'utf8').trim();
}

/** The real capability string (signed cache fixture). */
export function realCapabilities(): string {
  const file = JSON.parse(stripBom(readFileSync(fixture('EvniaServe/Config/data.json'), 'utf8')));
  return JSON.parse(file.data)[0].Datas[0].Vcp;
}

/** Virtual time: sleeps advance instantly and non-zero ones are recorded. */
export class VirtualClock implements DdcClock {
  t = 0;
  readonly sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    if (ms <= 0) return;
    this.sleeps.push(ms);
    this.t += ms;
  }
}

export interface Notification {
  name: string;
  tag: unknown;
  json: string;
}

/** Records notifications with their Tag serialized at emit time (the hub serializes immediately too). */
export class CapturingNotifier implements Notifier {
  readonly sent: Notification[] = [];
  notify(functionName: string, tag: unknown): void {
    this.sent.push({ name: functionName, tag, json: serialize(tag, 'ui') });
  }
  named(name: string): Notification[] {
    return this.sent.filter((n) => n.name === name);
  }
}

/** In-memory ThemeStore: one current profile, sections keyed by DeviceType + exact ModelName. */
export class FakeThemeStore implements ThemeStore {
  readonly themeRootDir = '/nonexistent/Theme';
  readonly contents = new Map<string, string>();
  readonly participants = new Set<ProfileParticipant>();
  saves = 0;
  #listeners = new Set<(e: ThemeSwitchEvent) => void>();
  #soft: SoftConfig = { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 };

  static key(desc: DeviceProfileDesc): string {
    return `${desc.DeviceType}|${desc.ModelName}`;
  }

  currentThemeName(): string {
    return 'User';
  }
  currentProfileName(): string {
    return 'Default';
  }
  getStoredContent(desc: DeviceProfileDesc): string | null {
    return this.contents.get(FakeThemeStore.key(desc)) ?? null;
  }
  registerParticipant(p: ProfileParticipant): () => void {
    this.participants.add(p);
    return () => this.participants.delete(p);
  }
  async saveParticipant(p: ProfileParticipant): Promise<void> {
    this.saves++;
    this.contents.set(FakeThemeStore.key(p.desc), p.purify());
  }
  getSyncProfile(): { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null {
    return { EffectDetailInfo: null, SyncDevices: [] };
  }
  async setSyncProfile(): Promise<void> {}
  getSoftConfig(): SoftConfig {
    return { ...this.#soft };
  }
  async setSoftConfig(patch: Partial<SoftConfig>): Promise<void> {
    this.#soft = { ...this.#soft, ...patch };
  }
  onSwitched(cb: (e: ThemeSwitchEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }
}

export const USER_MODE: DisplayModeInfo = { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' };

/** MonitorInfo.json entry of the user's monitor (bundled table, Version 34). */
export const MONITOR_INFO_34M2C8600 = { Name: '34M2C8600', SupUsbDDC: true, SupOTA: true, SupLightEffect: true, SupLightSync: true, HDR: 400 };

export function userDictionary(): DeviceDictionary {
  return new DeviceDictionary({ ...DISPLAY_DEVICE_RECORD }, [{ ...MONITOR_INFO_34M2C8600 }]);
}

export interface TempHost {
  host: HostServices;
  root: string;
  cleanup(): Promise<void>;
}

/** HostServices over a temporary directory tree with a minimal MonitorInfo.json. */
export async function tempHost(options: { mode?: DisplayModeInfo | null; log?: Logger } = {}): Promise<TempHost> {
  const root = await mkdtemp(join(tmpdir(), 'evnia-monitor-test-'));
  const serveDataDir = join(root, 'EvniaServe');
  const appDataDir = join(root, 'evnia');
  const resourcesDir = join(root, 'resources');
  for (const d of [serveDataDir, appDataDir, resourcesDir]) await mkdir(d, { recursive: true });
  await writeFile(join(resourcesDir, 'MonitorInfo.json'), JSON.stringify({ EdidToFactory: null, Monitors: [MONITOR_INFO_34M2C8600], Version: 34 }));
  const mode = options.mode === undefined ? USER_MODE : options.mode;
  const host: HostServices = {
    log: options.log ?? silentLog,
    serveDataDir,
    appDataDir,
    resourcesDir,
    getDisplayMode: () => (mode ? { ...mode } : null),
  };
  return { host, root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Frames received by the simulated monitor since `from`, as hex strings (e.g. "51 84 03 10 00 32 …"). */
export function framesSince(frames: readonly Uint8Array[], from: number): string[] {
  return frames.slice(from).map((f) => Buffer.from(f).toString('hex').toUpperCase().replace(/(..)(?!$)/g, '$1 '));
}

/** DDC/CI set frame (without 0x6E) for a standard VCP code. */
export function setFrame(code: number, value: number): string {
  const payload = code >= 0x100 ? [0x03, 0xe2, 0xa0, code & 0xff, (value >> 8) & 0xff, value & 0xff] : [0x03, code, (value >> 8) & 0xff, value & 0xff];
  return frameHex(payload);
}

/** DDC/CI get frame (without 0x6E). */
export function getFrame(code: number): string {
  const payload = code >= 0x100 ? [0x01, 0xe2, 0xa0, code & 0xff] : [0x01, code];
  return frameHex(payload);
}

function frameHex(payload: number[]): string {
  const bytes = [0x51, 0x80 | payload.length, ...payload];
  let chk = 0x6e;
  for (const b of bytes) chk ^= b;
  bytes.push(chk);
  return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

// ───────────────────────────── a PhlDisplay over the simulated 34M2C8600 ─────────────────────────────


export interface TestDisplay {
  bundle: MockMonitorBundle;
  display: PhlDisplay;
  themes: FakeThemeStore;
  notifier: CapturingNotifier;
  clock: VirtualClock;
  capCache: CapabilityCache;
  temp: TempHost;
  cleanup(): Promise<void>;
}

export interface TestDisplayOptions {
  /** Stored ProfileContent for the display (default: the user's Default.pcenter section; null = none). */
  stored?: string | null;
  /** Use a modified simulator spec over a plain mock transport (kind 'mock') instead of the VIA bundle. */
  spec?: MockMonitorSpec;
  /** Start with the user's signed capability cache (default true). */
  cachedCaps?: boolean;
  transports?: Array<'via' | 'i2c'>;
  mode?: DisplayModeInfo | null;
  extra?: Partial<PhlDisplayOptions>;
}

export async function testDisplay(options: TestDisplayOptions = {}): Promise<TestDisplay> {
  // The captured unit (its EDID and anonymized serial, test/fixtures/user-monitor.ts): the fixtures come from it.
  const bundle = await createMock34M2C8600({ spec: USER_34M2C8600, transports: options.spec ? [] : (options.transports ?? ['via']) });
  if (options.spec) {
    bundle.monitor = new SimulatedMonitor(options.spec);
    bundle.discovered = { ...bundle.discovered, transports: [new MockDdcTransport(bundle.monitor)] };
  }
  const temp = await tempHost({ mode: options.mode });
  const cachePath = join(temp.host.serveDataDir, 'Config', 'data.json');
  if (options.cachedCaps ?? true) {
    await mkdir(join(temp.host.serveDataDir, 'Config'), { recursive: true });
    await copyFile(fixture('EvniaServe/Config/data.json'), cachePath);
  }
  const capCache = new CapabilityCache(cachePath);
  await capCache.load();
  const themes = new FakeThemeStore();
  const stored = options.stored === undefined ? defaultProfileContent() : options.stored;
  if (stored !== null) themes.contents.set('100000|PHL 34M2C8600', stored);
  const notifier = new CapturingNotifier();
  const clock = new VirtualClock();
  const display = new PhlDisplay(bundle.discovered, {
    log: silentLog,
    notifier,
    host: temp.host,
    capCache,
    dict: userDictionary(),
    themes,
    channel: { timings: NO_DELAY_TIMINGS, clock },
    clock,
    decimalSeparator: ',',
    index: 1,
    ...options.extra,
  });
  return {
    bundle,
    display,
    themes,
    notifier,
    clock,
    capCache,
    temp,
    cleanup: async () => {
      await display.close();
      await temp.cleanup();
    },
  };
}

/** Connect and wait for the background load. */
export async function loadedDisplay(options: TestDisplayOptions = {}): Promise<TestDisplay> {
  const t = await testDisplay(options);
  const ok = await t.display.connect();
  if (!ok) throw new Error('mock display did not connect');
  await t.display.ready();
  return t;
}

/** The 34M2C8600 seed with some controls replaced or added ([code, value, max]). */
export function specWith(vcp: ReadonlyArray<readonly [number, number, number]>, extra: Partial<MockMonitorSpec> = {}): MockMonitorSpec {
  const map = new Map<number, readonly [number, number, number]>(USER_34M2C8600.vcp.map((e) => [e[0], e]));
  for (const e of vcp) map.set(e[0], e);
  return { ...USER_34M2C8600, ...extra, vcp: [...map.values()] };
}

// ───────────────────────────── a whole backend in mock mode ─────────────────────────────


export const MONITOR_MODULES: readonly ApiModule[] = [deviceApi, phlApi, displayFwApi, profileApi];

/**
 * Records AmbiglowService.attach calls (the ambiglow service is another module's). With `eneModel` it
 * also answers checkEne (services.ts) like the real service would: the model when the display has an ENE
 * on USB, '' otherwise.
 */
export class FakeAmbiglow implements AmbiglowService {
  readonly attached: Array<DisplayDevice | null> = [];
  readonly checked: DisplayDevice[] = [];
  checkEne?: (display: DisplayDevice) => Promise<string>;
  constructor(options: { eneModel?: string } = {}) {
    const model = options.eneModel;
    if (model !== undefined) {
      this.checkEne = async (display) => {
        this.checked.push(display);
        return display.ene ? model : '';
      };
    }
  }
  async attach(display: DisplayDevice | null): Promise<void> {
    this.attached.push(display);
  }
}

/** A copy of an EDID (hex) with another serial-string descriptor (FF) and a fixed block-0 checksum. */
export function edidWithSerial(hex: string, serial: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  for (let off = 54; off <= 108; off += 18) {
    if (bytes[off] === 0 && bytes[off + 1] === 0 && bytes[off + 3] === 0xff) {
      const text = Buffer.from(`${serial}\n`.padEnd(13, ' ').slice(0, 13), 'latin1');
      bytes.set(text, off + 5);
    }
  }
  let sum = 0;
  for (let i = 0; i < 127; i++) sum = (sum + bytes[i]) & 0xff;
  bytes[127] = (256 - sum) & 0xff;
  return bytes;
}

/** A second simulated 34M2C8600 (another serial) on a plain mock transport, as a discovery result. */
export function secondMonitor(serial: string, connector = 'card1-DP-2'): { monitor: SimulatedMonitor; discovered: DiscoveredMonitor } {
  const edidHex = Buffer.from(edidWithSerial(USER_34M2C8600.edidHex, serial)).toString('hex').toUpperCase();
  const monitor = new SimulatedMonitor({ ...USER_34M2C8600, edidHex, identity: { ...USER_34M2C8600.identity, serialNumber: serial } });
  const edid = parseEdid(monitor.edid);
  return { monitor, discovered: { key: edid.serialString, edid, connector, transports: [new MockDdcTransport(monitor, `mock:${serial}`)] } };
}

export interface MockBackend {
  backend: Backend;
  manager: MonitorManagerImpl;
  themes: FakeThemeStore;
  ambiglow: FakeAmbiglow;
  clock: DdcClock;
  temp: TempHost;
  /** Serialized notification strings in arrival order. */
  notifications: string[];
  /** 'N:<FunctionName>' and 'R:<FunctionName>' in wire order. */
  wire: string[];
  call(functionName: string, parms: unknown[] | null, requestId?: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function mockBackend(
  options: { clock?: DdcClock; stored?: string | null; manager?: MonitorManagerOptions; ambiglow?: FakeAmbiglow } = {},
): Promise<MockBackend> {
  const temp = await tempHost();
  const themes = new FakeThemeStore();
  const stored = options.stored === undefined ? defaultProfileContent() : options.stored;
  if (stored !== null) themes.contents.set('100000|PHL 34M2C8600', stored);
  const ambiglow = options.ambiglow ?? new FakeAmbiglow();
  const clock = options.clock ?? new VirtualClock();
  let manager: MonitorManagerImpl | null = null;
  const backend = createBackend(
    { host: temp.host, mockMonitor: '34M2C8600' },
    {
      services: (core) => {
        manager = createMonitorManager(core, { themes, ambiglow }, { clock, decimalSeparator: ',', mockSpec: USER_34M2C8600, ...options.manager });
        return { themes, monitors: manager, ambiglow };
      },
      modules: MONITOR_MODULES,
    },
  );
  const notifications: string[] = [];
  const wire: string[] = [];
  backend.onNotification((json) => {
    notifications.push(json);
    wire.push(`N:${(JSON.parse(json) as { FunctionName: string }).FunctionName}`);
  });
  await backend.start();
  let n = 0;
  return {
    backend,
    manager: manager!,
    themes,
    ambiglow,
    clock,
    temp,
    notifications,
    wire,
    async call(functionName, parms, requestId) {
      const reply = await backend.handleRequest(JSON.stringify({ functionName, requestId: requestId ?? `test-${++n}`, parms }));
      wire.push(`R:${functionName}`);
      return reply;
    },
    async cleanup() {
      await backend.stop();
      await temp.cleanup();
    },
  };
}
