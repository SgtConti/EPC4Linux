// Shared rig for the ambiglow service tests (not a test file itself): the simulated 34M2C8600 display driver
// (monitor/display.ts over the mock VIA bridge), optionally the simulated ENE MCU on the same fake USB bus,
// the ambiglow service with instant ENE pacing and manual timers, a fake capture host, and the Effect_* /
// SyncEffect_* API modules on a real RpcDispatcher.

import type { CaptureFrame, CaptureHost, HostServices, Logger } from '../../../src/backend/types.ts';
import type { ApiServices, BackendEvents, CoreServices } from '../../../src/backend/index.ts';
import type { MonitorManager, SoftConfig, ThemeSwitchEvent } from '../../../src/backend/services.ts';
import { EventBus } from '../../../src/backend/core/events.ts';
import { RpcDispatcher } from '../../../src/backend/rpc/dispatcher.ts';
import { effectApi } from '../../../src/backend/api/effect.ts';
import { syncEffectApi } from '../../../src/backend/api/sync-effect.ts';
import { createAmbiglowService, type AmbiglowServiceImpl, type AmbiglowServiceOptions } from '../../../src/backend/ambiglow/service.ts';
import type { EffectTimers } from '../../../src/backend/ambiglow/timers.ts';
import { MockEneDevice, type MockEneOptions } from '../../../src/backend/ambiglow/mock-ene.ts';
import { GRID_HEIGHT, GRID_WIDTH } from '../../../src/backend/ambiglow/ene-frame.ts';
import type { PhlDisplay } from '../../../src/backend/monitor/display.ts';
import type { UsbDeviceInfo } from '../../../src/backend/types.ts';
import type { MockMonitorSpec } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import {
  CapturingNotifier,
  FakeThemeStore,
  VirtualClock,
  defaultProfileContent,
  framesSince,
  silentLog,
  tempHost,
  testDisplay,
  type TempHost,
  type TestDisplay,
} from '../monitor/helpers.ts';
import { LAYOUTS, fmt } from '../ambiglow-ene/helpers.ts';

export { LAYOUTS, fmt, silentLog, framesSince };

// ───────────────────────────── timers and capture ─────────────────────────────

interface ManualTimer {
  at: number;
  every: number | null;
  cb: () => void;
}

/** Deterministic EffectTimers: nothing fires until advance(). */
export class ManualTimers implements EffectTimers {
  now = 0;
  #next = 1;
  readonly #timers = new Map<number, ManualTimer>();

  setInterval(cb: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, every: ms, cb });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.#next++;
    this.#timers.set(id, { at: this.now + ms, every: null, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  /** Timers currently scheduled. */
  get pending(): number {
    return this.#timers.size;
  }

  /** Run every timer due within `ms`, in time order, interval timers repeatedly. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let nextId = -1;
      let next: ManualTimer | null = null;
      for (const [id, t] of this.#timers) {
        if (t.at <= end && (next === null || t.at < next.at)) {
          next = t;
          nextId = id;
        }
      }
      if (!next) break;
      this.now = next.at;
      if (next.every === null) this.#timers.delete(nextId);
      else next.at += next.every;
      next.cb();
    }
    this.now = end;
  }
}

/**
 * A CaptureHost the test drives: records starts/stops/retunes and pushes frames and levels on demand. Like the real
 * host, setVideoInterval acts only on a session that is running or starting (a no-op otherwise).
 */
export class FakeCaptureHost implements CaptureHost {
  readonly videoStarts: number[] = [];
  /** setVideoInterval calls that reached a session (running or starting). */
  readonly videoIntervals: number[] = [];
  /** The interval of the current session (start, then retunes); null while none. */
  videoIntervalMs: number | null = null;
  videoStops = 0;
  audioStarts = 0;
  audioStops = 0;
  videoResult = true;
  audioResult = true;
  /** While set, startVideo waits for it (a portal dialog the user has not answered yet). */
  videoGate: Promise<void> | null = null;
  #onFrame: ((f: CaptureFrame) => void) | null = null;
  #onLevel: ((level: number) => void) | null = null;

  async startVideo(intervalMs: number, onFrame: (f: CaptureFrame) => void): Promise<boolean> {
    this.videoStarts.push(intervalMs);
    this.videoIntervalMs = intervalMs;
    const stopsBefore = this.videoStops;
    if (this.videoGate) await this.videoGate;
    // Like the real host: a stop issued while the start was pending makes it resolve false, without frames.
    if (this.videoStops !== stopsBefore) return false;
    this.#onFrame = this.videoResult ? onFrame : null;
    if (!this.videoResult) this.videoIntervalMs = null;
    return this.videoResult;
  }

  stopVideo(): void {
    this.videoStops++;
    this.videoIntervalMs = null;
    this.#onFrame = null;
  }

  setVideoInterval(intervalMs: number): void {
    if (this.videoIntervalMs === null) return;
    this.videoIntervals.push(intervalMs);
    this.videoIntervalMs = intervalMs;
  }

  async startAudio(onLevel: (level: number) => void): Promise<boolean> {
    this.audioStarts++;
    this.#onLevel = this.audioResult ? onLevel : null;
    return this.audioResult;
  }

  stopAudio(): void {
    this.audioStops++;
    this.#onLevel = null;
  }

  get videoActive(): boolean {
    return this.#onFrame !== null;
  }

  get audioActive(): boolean {
    return this.#onLevel !== null;
  }

  frame(f: CaptureFrame): void {
    this.#onFrame?.(f);
  }

  level(level: number): void {
    this.#onLevel?.(level);
  }
}

/** A 50×40 RGBA CaptureFrame whose pixel (row, col) is colour(row, col). */
export function rgbaFrame(colour: (row: number, col: number) => readonly [number, number, number], timestamp = 0): CaptureFrame {
  const data = new Uint8ClampedArray(GRID_WIDTH * GRID_HEIGHT * 4);
  for (let row = 0; row < GRID_HEIGHT; row++) {
    for (let col = 0; col < GRID_WIDTH; col++) {
      const [r, g, b] = colour(row, col);
      data.set([r, g, b, 255], (row * GRID_WIDTH + col) * 4);
    }
  }
  return { width: GRID_WIDTH, height: GRID_HEIGHT, data, timestamp };
}

/** Wait for pending promise callbacks (the engines' fire-and-forget uploads). */
export async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setImmediate(r));
}

// ───────────────────────────── theme store with a live Sync_Profile ─────────────────────────────

/**
 * FakeThemeStore whose Sync_Profile and SoftConfig are stored (monitor/helpers.ts keeps them constant), and
 * which can raise onSwitched like the real store after a switch/apply/reset.
 */
export class SyncThemeStore extends FakeThemeStore {
  sync: { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null = { EffectDetailInfo: null, SyncDevices: [] };
  syncWrites = 0;
  readonly #switched = new Set<(e: ThemeSwitchEvent) => void>();

  override onSwitched(cb: (e: ThemeSwitchEvent) => void): () => void {
    this.#switched.add(cb);
    return () => this.#switched.delete(cb);
  }

  /** ThemeStore: listeners run after the switching operation (here: whenever the test says so). */
  emitSwitched(reason: ThemeSwitchEvent['reason'] = 'switch'): void {
    for (const cb of [...this.#switched]) cb({ theme: 'User', profile: 'Default', reason });
  }

  override getSyncProfile(): { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null {
    return this.sync === null ? null : (JSON.parse(JSON.stringify(this.sync)) as { EffectDetailInfo: unknown; SyncDevices: unknown[] });
  }

  // Optional parameter: the base class declares setSyncProfile() without one.
  override async setSyncProfile(sync?: { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null): Promise<void> {
    this.syncWrites++;
    this.sync = sync === null || sync === undefined ? null : (JSON.parse(JSON.stringify(sync)) as { EffectDetailInfo: unknown; SyncDevices: unknown[] });
  }
}

// ───────────────────────────── the rig ─────────────────────────────

export interface RigOptions {
  /** Plug the simulated ENE MCU in (default true). */
  ene?: boolean | MockEneOptions;
  /** Stored display ProfileContent (default: the user's Default.pcenter section). */
  stored?: string | null;
  spec?: MockMonitorSpec;
  /** Start from the user's signed capability cache (default true); false reads spec.capabilities. */
  cachedCaps?: boolean;
  soft?: Partial<SoftConfig>;
  capture?: boolean;
  service?: Partial<AmbiglowServiceOptions>;
  /** Connect and load the display (default true). */
  load?: boolean;
}

export interface Rig {
  t: TestDisplay;
  display: PhlDisplay;
  service: AmbiglowServiceImpl;
  themes: SyncThemeStore;
  notifier: CapturingNotifier;
  timers: ManualTimers;
  clock: VirtualClock;
  capture: FakeCaptureHost;
  idle: { seconds: number };
  mock: MockEneDevice | null;
  eneInfo: UsbDeviceInfo | null;
  services: ApiServices;
  dispatcher: RpcDispatcher;
  host: HostServices;
  /** Call a Bridge function through the dispatcher; returns the parsed reply envelope. */
  call(functionName: string, parms?: unknown[] | null): Promise<{ err_code: number; err_msg: string | null; Tag: any; raw: string }>;
  /** Journal position of the ENE transfers. */
  eneMark(): number;
  /** ENE transfers since `mark` in spec notation (reads and writes). */
  eneSince(mark: number): string[];
  /** DDC frames received by the simulated monitor since `mark`. */
  ddcMark(): number;
  ddcSince(mark: number): string[];
  cleanup(): Promise<void>;
}

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const timers = new ManualTimers();
  const capture = new FakeCaptureHost();
  const idle = { seconds: 0 };
  const themes = new SyncThemeStore();
  const stored = options.stored === undefined ? defaultProfileContent() : options.stored;
  if (stored !== null) themes.contents.set('100000|PHL 34M2C8600', stored);
  if (options.soft) await themes.setSoftConfig(options.soft);
  const notifier = new CapturingNotifier();
  const temp: TempHost = await tempHost();
  const host: HostServices = {
    ...temp.host,
    ...(options.capture === false ? {} : { capture }),
    getIdleSeconds: () => idle.seconds,
  };
  let display: PhlDisplay | null = null;
  let service: AmbiglowServiceImpl | null = null;
  const monitors = {
    current: () => display,
    displays: () => (display ? [display] : []),
    scan: async () => undefined,
    select: async () => false,
    connectList: () => [],
    onChanged: () => () => undefined,
  } as unknown as MonitorManager;
  const core: CoreServices = {
    log: silentLog,
    notifier,
    host,
    events: new EventBus<BackendEvents>(),
    options: { host, noHardware: true },
  };
  const t = await testDisplay({
    spec: options.spec,
    cachedCaps: options.cachedCaps,
    extra: {
      host,
      themes,
      notifier,
      log: silentLog,
      checkEne: (d) => (service ? service.checkEne(d) : Promise.resolve(null)),
      onEffectInfoChanged: (d) => {
        if (service && d === display) void service.attach(d);
      },
    },
  });
  const clock = t.clock;
  let mock: MockEneDevice | null = null;
  let eneInfo: UsbDeviceInfo | null = null;
  const usb = t.bundle.usb;
  if (options.ene !== false) {
    mock = new MockEneDevice(typeof options.ene === 'object' ? options.ene : {});
    eneInfo = usb.attach(mock.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 9 }));
    t.display.setEneDevice(eneInfo);
  }
  service = createAmbiglowService(core, { themes, monitors }, {
    usb,
    layouts: LAYOUTS,
    ene: { sleep: async () => undefined },
    timers,
    clock,
    ...options.service,
  });
  const services: ApiServices = { ...core, themes, monitors, ambiglow: service };
  const dispatcher = new RpcDispatcher(silentLog);
  effectApi(dispatcher, services);
  syncEffectApi(dispatcher, services);
  await service.start();
  display = t.display;
  if (options.load !== false) {
    const ok = await t.display.connect();
    if (!ok) throw new Error('mock display did not connect');
    await t.display.ready();
    await service.settled();
    await flush();
  }
  let n = 0;
  const eneId = eneInfo?.id;
  return {
    t,
    display: t.display,
    service,
    themes,
    notifier,
    timers,
    clock,
    capture,
    idle,
    mock,
    eneInfo,
    services,
    dispatcher,
    host,
    async call(functionName, parms = null) {
      const raw = await dispatcher.dispatch(JSON.stringify({ functionName, requestId: `r${++n}`, parms }));
      const parsed = JSON.parse(raw) as { err_code: number; err_msg: string | null; Tag: unknown };
      return { ...parsed, Tag: parsed.Tag as any, raw };
    },
    eneMark: () => usb.transfers.length,
    eneSince: (mark) => usb.transfers.slice(mark).filter((x) => x.deviceId === eneId).map(fmt),
    ddcMark: () => t.bundle.monitor.frames.length,
    ddcSince: (mark) => framesSince(t.bundle.monitor.frames, mark),
    async cleanup() {
      await service?.stop();
      await t.cleanup();
      await temp.cleanup();
    },
  };
}

/** "40 80 0000 <reg> <len> | <data>" writes of the spec notation, without reads. */
export function writesOnly(lines: readonly string[]): string[] {
  return lines.filter((l) => l.startsWith('40 80'));
}

export const quiet: Logger = silentLog;
