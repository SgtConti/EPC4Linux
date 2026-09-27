// MonitorManager: the display half of SystemOper's device scan (SystemOper.smethod_0/smethod_5 for
// DeviceType.PHL_CDeviceDisplay, GClass3.ConnectionCkecked / FnRecheckConnectionByUSB / SwitchDisplay),
// on Linux discovery (ddc/discovery.ts, 20-monitor-io-linux-consolidation §2.3) with one PhlDisplay per
// physical monitor.
//
// Scan kinds (05 §2.5, 20-monitor-io §5 D9):
//   'all'      Start / Device_Rescan / PHL_Rescan: discovery, reconcile, fast connect of every display; the
//              full VCP read continues in the background (display.ready()). Concurrent requests share one run.
//   'display'  Device_DetectionDisplay: the caller waits the vendor's 5 s settle time first
//              (detectDisplays()), then the same as 'all'.
//   'usb'      Device_DetectionUSB and USB hotplug: only when the VIA/ENE USB set changed (the vendor's
//              CListCompareController): the displays get fresh transports and a re-probe (no reload), the
//              ENE presence is updated and the ambiglow service re-attached.
// Hotplug events (CoreServices.events 'hotplug') only drive the USB reconcile; display changes are left
// to the renderer's Device_DetectionDisplay, which honours shieldDisplayChange (D9 rule 1).
//
// Current display (GClass3 CurSN): the vendor has ONE display driver, working on CurDisplay only; the
// other displays are just listed (UIDisplayInfos) and probed. Here every display gets the fast connect
// (probe + capability string), but only the current one is loaded, registered with the theme store as
// a ProfileParticipant (right after its fast connect, so a theme switch during the background load is
// queued behind it) and handed to the ambiglow service. PHL_SwitchDisplay moves all of that to the new
// current display (OnConnect: full reconnect and load).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreServices } from '../index.ts';
import type { AmbiglowService, DisplayDevice, MonitorManager, ThemeStore } from '../services.ts';
import type { DdcTransport, DiscoveredMonitor, Logger, UsbBackend, UsbDeviceInfo } from '../types.ts';
import { CapabilityCache } from '../ddc/cap-cache.ts';
import { type DdcChannelOptions, type DdcClock, NO_DELAY_TIMINGS, realClock } from '../ddc/channel.ts';
import { type DiscoveryOptions, ENE_VENDOR_ID, discoverMonitors } from '../ddc/discovery.ts';
import { errorText } from '../ddc/errors.ts';
import { type I2cSyscalls, linuxI2cSyscalls } from '../ddc/transports/i2cdev.ts';
import { type SimulatedMonitor, DEFAULT_MOCK_SYSFS, createMock34M2C8600, writeMockSysfs } from '../ddc/transports/mock.ts';
import type { MockMonitorSpec } from '../ddc/transports/mock-34m2c8600.ts';
import { ViaUsbTransport } from '../ddc/transports/via.ts';
import { MockEneDevice } from '../ambiglow/mock-ene.ts';
import { LibusbBackend } from '../usb/libusb-backend.ts';
import type { FakeUsbBackend } from '../usb/fake-backend.ts';
import { DeviceDictionary, type DeviceInfo, displayDeviceInfo } from './model/device-info.ts';
import { OpQueue } from './op-queue.ts';
import { PhlDisplay } from './display.ts';

/** Device_DetectionDisplay sleeps 5000 ms before the display scan (SystemOper.cs:241-246). */
export const DISPLAY_SETTLE_MS = 5000;

/** USB vendor ids whose device list the vendor watches (CListCompareController, PHL/…:25-29, 204-216). */
const WATCHED_USB_VENDORS = new Set([0x2109, 0x0bda, 0x05e3, 0x0552, ENE_VENDOR_ID]);

/** Test/integration seams; production callers pass nothing. */
export interface MonitorManagerOptions {
  /** Replace discovery (defaults to ddc/discovery.ts over the real or mock environment). */
  discover?: (options: DiscoveryOptions) => Promise<DiscoveredMonitor[]>;
  /** DdcChannelImpl options for every display (mock mode default: NO_DELAY_TIMINGS). */
  channel?: DdcChannelOptions;
  /** Clock for the driver sleeps and the Device_DetectionDisplay settle time. */
  clock?: DdcClock;
  /** Decimal separator of the EDID strings (default: process locale, 20 D5). */
  decimalSeparator?: string;
  /** Override the 5 s Device_DetectionDisplay settle time. */
  displaySettleMs?: number;
  /** Mock mode: attach the simulated ENE (default true; "<model>/no-ene" in mockMonitor also disables it). */
  mockEne?: boolean;
  /**
   * Mock mode: the simulated monitor's seed (default MOCK_34M2C8600, synthetic serial). The contract tests
   * pass the captured unit's EDID and serial (test/fixtures/user-monitor.ts) to replay the captured session.
   */
  mockSpec?: MockMonitorSpec;
  /** Real mode: sysfs root, /dev root and i2c syscalls (tests). */
  sysfsRoot?: string;
  devRoot?: string;
  i2c?: I2cSyscalls;
}

/** The simulated hardware behind EVNIA_MOCK_MONITOR (exposed for tests and diagnostics). */
export interface MockHardware {
  monitor: SimulatedMonitor;
  usb: FakeUsbBackend;
  via: UsbDeviceInfo;
  ene: MockEneDevice;
  /** The simulated ENE on the fake USB bus, or null in the "no-ene" variant. */
  eneInfo: UsbDeviceInfo | null;
  sysfsRoot: string;
}

interface Environment {
  usb?: UsbBackend;
  i2c: I2cSyscalls;
  sysfsRoot: string;
  devRoot: string;
  channel: DdcChannelOptions;
  mock?: MockHardware;
}

function transportSignature(t: DdcTransport): string {
  if (t instanceof ViaUsbTransport) return `${t.id}#${t.info.busNumber}.${t.info.deviceAddress}`;
  return t.id;
}

function transportsSignature(m: DiscoveredMonitor): string {
  return m.transports.map(transportSignature).join('|');
}

function eneSignature(ene: UsbDeviceInfo | undefined): string {
  return ene ? `${ene.id}#${ene.busNumber}.${ene.deviceAddress}` : '';
}

export class MonitorManagerImpl implements MonitorManager {
  readonly #core: CoreServices;
  readonly #log: Logger;
  readonly #themes: ThemeStore | undefined;
  #ambiglow: AmbiglowService | undefined;
  readonly #options: MonitorManagerOptions;
  readonly #clock: DdcClock;
  readonly #scanQueue = new OpQueue();
  readonly #listeners = new Set<() => void>();
  readonly #registrations = new Map<PhlDisplay, () => void>();
  #env: Environment | null = null;
  #envPromise: Promise<Environment | null> | null = null;
  #dict: DeviceDictionary | null = null;
  #capCache: CapabilityCache | null = null;
  #displays: PhlDisplay[] = [];
  #current: PhlDisplay | null = null;
  #attached: DisplayDevice | null = null;
  #pendingFull: Promise<void> | null = null;
  #usbSnapshot: string | null = null;
  #unsubscribe: (() => void) | null = null;
  #stopped = false;

  constructor(core: CoreServices, slots: { themes?: ThemeStore; ambiglow?: AmbiglowService }, options: MonitorManagerOptions = {}) {
    this.#core = core;
    this.#log = core.log.child('monitor');
    this.#themes = slots.themes;
    this.#ambiglow = slots.ambiglow;
    this.#options = options;
    this.#clock = options.clock ?? realClock;
  }

  // ───────────────────────────── BackendService ─────────────────────────────

  /**
   * Load the static tables and the capability cache and subscribe to hotplug events. The scan itself
   * starts with the renderer's `Start` (api/system.ts calls scan('all')), as in the vendor.
   */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.#prepare();
    this.#unsubscribe ??= this.#core.events.on('hotplug', ({ kind }) => {
      if (kind === 'usb') {
        this.scan('usb').catch((e) => this.#log.error(`USB reconcile failed: ${errorText(e)}`));
      } else {
        // D9 rule 1: display rescans come from the renderer (Device_DetectionDisplay) behind its shield.
        this.#log.debug('display hotplug: left to Device_DetectionDisplay');
      }
    });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    await this.#scanQueue.run(async () => {
      for (const d of this.#displays) await this.#dispose(d);
      this.#displays = [];
      this.#current = null;
      await this.#attach(null);
    });
    const env = this.#env;
    this.#env = null;
    this.#envPromise = null;
    if (env?.mock) await rm(env.mock.sysfsRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  // ───────────────────────────── MonitorManager ─────────────────────────────

  displays(): readonly PhlDisplay[] {
    return this.#displays;
  }

  current(): PhlDisplay | null {
    return this.#current;
  }

  onChanged(cb: () => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  scan(kind: 'all' | 'usb' | 'display'): Promise<void> {
    if (kind === 'usb') return this.#scanQueue.run(() => this.#usbReconcile());
    // Concurrent full scans share one run until it starts (Start + Device_Rescan racing, 20-backend-host-tail §7.2 item 3).
    if (this.#pendingFull) return this.#pendingFull;
    const run = this.#scanQueue.run(async () => {
      this.#pendingFull = null;
      await this.#fullScan();
    });
    this.#pendingFull = run;
    run.catch(() => undefined).finally(() => {
      if (this.#pendingFull === run) this.#pendingFull = null;
    });
    return run;
  }

  /** Device_DetectionDisplay: the vendor's 5000 ms settle wait, then the display scan. */
  async detectDisplays(): Promise<void> {
    await this.#clock.sleep(this.#options.displaySettleMs ?? DISPLAY_SETTLE_MS);
    await this.scan('display');
  }

  /** Device_Rescan: CacheVcpMgr.Reset() (the signed capability cache is emptied), then a full scan. */
  async rescan(): Promise<void> {
    await this.#prepare();
    await this.#capCache?.reset().catch((e) => this.#log.warn(`capability cache reset failed: ${errorText(e)}`));
    await this.scan('all');
  }

  /**
   * PHL_SwitchDisplay (GClass3.SwitchDisplay, GClass3.cs:258-274): the current key → true without I/O;
   * another supported display becomes current and reconnects (OnConnect: full reload), and becomes the
   * only theme participant; unknown/unsupported → false.
   */
  async select(key: string): Promise<boolean> {
    const current = this.#current;
    if (!key || (current && key === current.key)) return current !== null;
    const target = this.#displays.find((d) => d.key.toLowerCase() === key.toLowerCase());
    if (!target || !target.isSupport) return false;
    for (const d of [...this.#registrations.keys()]) if (d !== target) this.#unregister(d);
    this.#current = target;
    this.#emitChanged();
    let ok = false;
    try {
      ok = await target.connect();
    } catch (e) {
      this.#log.error(`${target.key}: connect failed: ${errorText(e)}`);
    }
    if (this.#current === target) {
      if (ok) this.#register(target);
      else {
        this.#unregister(target);
        await this.#attach(null);
      }
    }
    await target.ready();
    return true;
  }

  /**
   * Device_GetConnectList entries (SystemOper.GetConnectionDevice → CDevice_PHLDisplay.GetDeviceInfo):
   * one DeviceInfo for the display driver while the current display is connected, listing every display
   * (20-backend-host-tail §5 step 3, §6). CurSN is always one of the DisplaySNs.
   */
  connectList(): DeviceInfo[] {
    const info = this.deviceInfo();
    return info ? [info] : [];
  }

  /** Device_GetDeviceInfo(100000): the display DeviceInfo, or null ("No driver found!") when not connected. */
  deviceInfo(): DeviceInfo | null {
    const current = this.#current;
    if (!current || !current.connected || !this.#dict) return null;
    return displayDeviceInfo(this.#dict, current.monitorName, { CurSN: current.key, DisplayList: this.#displays.map((d) => d.uiInfo()) });
  }

  /**
   * Late binding of the ambiglow service, for compositions that create it after the monitor manager
   * (index.ts starts themes → monitors → ambiglow, so a factory chain hands the manager no ambiglow slot).
   * A connected, loaded current display is attached at once.
   */
  bindAmbiglow(service: AmbiglowService | undefined): void {
    this.#ambiglow = service;
    this.#attached = null;
    const current = this.#current;
    if (service && current?.connected && current.loaded) void this.#attach(current);
  }

  /** The simulated hardware in mock mode (null otherwise, or before start()). */
  get mockHardware(): MockHardware | null {
    return this.#env?.mock ?? null;
  }

  // ───────────────────────────── internals ─────────────────────────────

  async #prepare(): Promise<void> {
    const host = this.#core.host;
    this.#dict ??= await DeviceDictionary.load({ resourcesDir: host.resourcesDir, appDataDir: host.appDataDir }, this.#log);
    if (!this.#capCache) {
      // The vendor code says "config"; the Windows directory is "Config" (impl-ddc "Capability cache").
      const cache = new CapabilityCache(join(host.serveDataDir, 'Config', 'data.json'), this.#log.child('capcache'));
      await cache.load();
      this.#capCache = cache;
    }
  }

  async #environment(): Promise<Environment | null> {
    if (this.#env) return this.#env;
    this.#envPromise ??= this.#createEnvironment();
    this.#env = await this.#envPromise;
    return this.#env;
  }

  async #createEnvironment(): Promise<Environment | null> {
    const opts = this.#core.options;
    if (opts.mockMonitor) return this.#createMockEnvironment(opts.mockMonitor);
    if (opts.noHardware) {
      this.#log.info('hardware access disabled: no monitors');
      return null;
    }
    return {
      usb: opts.usb ?? new LibusbBackend({ log: this.#log.child('usb') }),
      i2c: this.#options.i2c ?? linuxI2cSyscalls(),
      sysfsRoot: this.#options.sysfsRoot ?? '/sys',
      devRoot: this.#options.devRoot ?? '/dev',
      channel: this.#options.channel ?? {},
    };
  }

  /**
   * EVNIA_MOCK_MONITOR=34M2C8600: the simulated monitor behind a fake VIA bridge (USB 3-2.4) and a fake
   * /dev/i2c-5, a simulated ENE MCU on USB 3-2.1, and a temporary sysfs tree, so the real discovery and
   * driver code run unchanged (impl-ddc "Mock mode", impl-usb-ene §2.3). The value "34M2C8600/no-ene" (or
   * the option mockEne: false) leaves the ENE out, as on the user's 2026-09-26 session (20-monitor-io §6).
   */
  async #createMockEnvironment(value: string): Promise<Environment> {
    const [model, ...flags] = value.split('/');
    if (model !== '34M2C8600') this.#log.warn(`mock monitor "${model}" is not simulated; using the 34M2C8600`);
    const withEne = this.#options.mockEne ?? !flags.includes('no-ene');
    const bundle = await createMock34M2C8600({ transports: [], spec: this.#options.mockSpec });
    const ene = new MockEneDevice();
    const eneInfo = withEne ? bundle.usb.attach(ene.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: 9 })) : null;
    const sysfsRoot = await mkdtemp(join(tmpdir(), 'evnia-mock-sysfs-'));
    await writeMockSysfs(sysfsRoot, bundle.monitor, DEFAULT_MOCK_SYSFS, [bundle.viaInfo]);
    this.#log.info(`mock monitor ${bundle.monitor.spec.name} (VIA ${bundle.viaInfo.id}, i2c ${bundle.busPath}, ENE ${eneInfo?.id ?? 'absent'})`);
    return {
      usb: bundle.usb,
      i2c: bundle.i2c,
      sysfsRoot,
      devRoot: '/dev',
      channel: this.#options.channel ?? { timings: NO_DELAY_TIMINGS },
      mock: { monitor: bundle.monitor, usb: bundle.usb, via: bundle.viaInfo, ene, eneInfo, sysfsRoot },
    };
  }

  async #discover(env: Environment): Promise<DiscoveredMonitor[]> {
    const dict = this.#dict;
    const discover = this.#options.discover ?? discoverMonitors;
    return discover({
      log: this.#log.child('discovery'),
      sysfsRoot: env.sysfsRoot,
      devRoot: env.devRoot,
      usb: env.usb,
      i2c: env.i2c,
      supportsModel: dict ? (name) => dict.supportsModel(name) : undefined,
      channel: env.channel,
    });
  }

  /** Discovery while every display's operation queue is held, so no DDC sequence overlaps the bridge queries. */
  async #discoverHeld(env: Environment): Promise<DiscoveredMonitor[]> {
    const hold = (i: number): Promise<DiscoveredMonitor[]> =>
      i >= this.#displays.length ? this.#discover(env) : this.#displays[i].exclusiveRaw(() => hold(i + 1));
    return hold(0);
  }

  async #fullScan(): Promise<void> {
    if (this.#stopped) return;
    await this.#prepare();
    const env = await this.#environment();
    let found: DiscoveredMonitor[] = [];
    if (env) {
      try {
        found = await this.#discoverHeld(env);
      } catch (e) {
        // One transient error (sysfs, USB enumeration) must not dispose and unregister every display:
        // keep the known set with its transports; the next scan reconciles.
        this.#log.error(`discovery failed, keeping ${this.#displays.length} known display(s): ${errorText(e)}`);
        return;
      }
      this.#usbSnapshot = await this.#takeUsbSnapshot(env);
    }
    const lastKey = this.#current?.key ?? null;
    const seen = new Set<PhlDisplay>();
    let index = 0;
    for (const m of found) {
      index++;
      const existing = this.#displays.find((d) => d.key.toLowerCase() === m.key.toLowerCase() && !seen.has(d));
      if (existing) {
        await existing.rebind(m, index);
        seen.add(existing);
      } else {
        const d = this.#create(m, index);
        this.#displays.push(d);
        seen.add(d);
      }
    }
    for (const d of [...this.#displays]) {
      if (!seen.has(d)) {
        this.#log.info(`${d.key}: display gone`);
        await this.#dispose(d);
      }
    }
    this.#displays = this.#displays.filter((d) => seen.has(d));
    this.#displays.sort((a, b) => found.findIndex((m) => m.key === a.key) - found.findIndex((m) => m.key === b.key));

    // Current display (GClass3.ConnectionCkecked): keep the last SN, else the first display; chosen before
    // the connects so the post-load hook already sees it.
    const keep = lastKey ? this.#displays.find((d) => d.key.toLowerCase() === lastKey.toLowerCase()) : undefined;
    const chosen = keep ?? this.#displays[0] ?? null;
    this.#current = chosen;

    // Fast connect of every display (the vendor probes them all in DDCHelAPIIni); only the current one is
    // loaded, in the background.
    await Promise.all(this.#displays.map((d) => this.#connect(d, d === chosen)));

    // Deviation: a current display that cannot connect gives way to one that can (the vendor stays on
    // Displays[0] and then reports no display at all).
    let next = this.#current;
    if (next && !next.connected) next = this.#displays.find((d) => d.connected) ?? next;
    await this.#applyCurrent(next);
    this.#log.info(`scan: ${this.#displays.length} display(s); current ${next ? `${next.key} (${next.connected ? 'connected' : 'not connected'})` : 'none'}`);
    this.#emitChanged();
  }

  /**
   * Make `next` the current display: the only theme participant (registered right after its fast
   * connect, before its load finished) and the only loaded one; others are unregistered. The ambiglow
   * service gets it after its load (post-load hook), at once when it is already loaded, and null when no
   * connected display is left.
   */
  async #applyCurrent(next: PhlDisplay | null): Promise<void> {
    for (const d of [...this.#registrations.keys()]) if (d !== next) this.#unregister(d);
    this.#current = next;
    if (!next || !next.connected) {
      await this.#attach(null);
      return;
    }
    this.#register(next);
    if (next.loaded) {
      if (this.#attached !== next) await this.#attach(next);
    } else {
      void next.load();
    }
  }

  #create(m: DiscoveredMonitor, index: number): PhlDisplay {
    return new PhlDisplay(m, {
      log: this.#log,
      notifier: this.#core.notifier,
      host: this.#core.host,
      capCache: this.#capCache as CapabilityCache,
      dict: this.#dict as DeviceDictionary,
      themes: this.#themes,
      channel: this.#env?.channel ?? this.#options.channel,
      clock: this.#options.clock,
      decimalSeparator: this.#options.decimalSeparator,
      index,
      onEffectInfoChanged: (d) => {
        if (d === this.#current) void this.#attach(d);
      },
      checkEne: (d) => this.#checkEne(d),
    });
  }

  /** Vendor method_14 through the ambiglow service (services.ts AmbiglowService.checkEne); null = no answer. */
  async #checkEne(d: PhlDisplay): Promise<string | null> {
    const service = this.#ambiglow;
    if (!service?.checkEne) return null;
    return service.checkEne(d);
  }

  /** Fast connect (and, for the current display, the background load). Unregisters on failure. */
  async #connect(d: PhlDisplay, load: boolean): Promise<boolean> {
    let ok = false;
    try {
      ok = await d.connect({ load });
    } catch (e) {
      this.#log.error(`${d.key}: connect failed: ${errorText(e)}`);
    }
    if (!ok) this.#unregister(d);
    return ok;
  }

  #register(d: PhlDisplay): void {
    if (!this.#themes || this.#registrations.has(d)) return;
    this.#registrations.set(d, this.#themes.registerParticipant(d));
  }

  #unregister(d: PhlDisplay): void {
    const off = this.#registrations.get(d);
    if (!off) return;
    this.#registrations.delete(d);
    off();
  }

  async #dispose(d: PhlDisplay): Promise<void> {
    this.#unregister(d);
    if (this.#current === d) this.#current = null;
    if (this.#attached === d) await this.#attach(null);
    await d.close();
  }

  /** Tell the ambiglow service which display to drive (vendor ENE check per display load / USB change). */
  async #attach(display: DisplayDevice | null): Promise<void> {
    const ambiglow = this.#ambiglow;
    if (!ambiglow || (display === null && this.#attached === null)) return;
    this.#attached = display;
    try {
      await ambiglow.attach(display);
    } catch (e) {
      this.#log.error(`ambiglow attach failed: ${errorText(e)}`);
    }
  }

  /** VIA bridges, hubs and the ENE as the vendor's USB comparers see them (ids + bus addresses). */
  async #takeUsbSnapshot(env: Environment): Promise<string | null> {
    if (!env.usb) return null;
    try {
      const list = await env.usb.list((d) => WATCHED_USB_VENDORS.has(d.vendorId));
      return list.map((d) => `${d.vendorId.toString(16)}:${d.productId.toString(16)}@${d.id}#${d.busNumber}.${d.deviceAddress}`).sort().join(',');
    } catch (e) {
      this.#log.warn(`USB list failed: ${errorText(e)}`);
      return null;
    }
  }

  /**
   * Device_DetectionUSB / USB hotplug (UsbDeviceChange → CDevice_PHLDisplay.method_3): nothing to do
   * unless the watched USB set changed; then fresh transports and a re-probe for the displays whose
   * bridge changed (FnRecheckConnectionByUSB without the vendor's full reload), the ENE presence for the
   * ambiglow service (method_14), and a connect for displays that became reachable.
   */
  async #usbReconcile(): Promise<void> {
    if (this.#stopped) return;
    await this.#prepare();
    const env = await this.#environment();
    if (!env?.usb) return;
    const snapshot = await this.#takeUsbSnapshot(env);
    if (snapshot === null || snapshot === this.#usbSnapshot) return;
    this.#log.info('USB devices changed: re-evaluating monitor transports and ENE');
    let found: DiscoveredMonitor[];
    try {
      found = await this.#discoverHeld(env);
    } catch (e) {
      // The snapshot is not consumed: the next identical reconcile tries again.
      this.#log.error(`discovery failed: ${errorText(e)}`);
      return;
    }
    this.#usbSnapshot = snapshot;
    const before = this.#current;
    let changed = false;
    let index = 0;
    for (const m of found) {
      index++;
      const d = this.#displays.find((x) => x.key.toLowerCase() === m.key.toLowerCase());
      if (!d) {
        const created = this.#create(m, this.#displays.length + 1);
        this.#displays.push(created);
        await this.#connect(created, false);
        changed = true;
        continue;
      }
      const eneChanged = eneSignature(d.discovered.ene) !== eneSignature(m.ene);
      if (transportsSignature(d.discovered) !== transportsSignature(m)) {
        await d.rebind(m, index);
        const supported = await d.reprobe();
        if (supported && !d.connected) await this.#connect(d, false);
        else if (!supported && d.connected) {
          this.#log.warn(`${d.key}: no DDC/CI transport left after the USB change`);
          d.markDisconnected();
          this.#unregister(d);
        }
        changed = true;
      } else {
        for (const t of m.transports) await t.close().catch(() => undefined);
        if (eneChanged) d.setEneDevice(m.ene);
      }
      // Not before the load: its post-load hook attaches it (the service expects profile() to exist).
      if (eneChanged && d === this.#current && d.connected && d.loaded) await this.#attach(d);
      if (eneChanged) changed = true;
    }
    // FnRecheckConnectionByUSB (GClass3.cs:190-222): a current display that lost its last transport gives
    // way to the first supported one (OnConnect: load), else OnDisConnect (the ambiglow service is
    // detached); one that became reachable again is reloaded.
    let next = this.#current;
    if (!next || !next.connected) next = this.#displays.find((x) => x.connected) ?? next;
    await this.#applyCurrent(next);
    if (changed || next !== before) this.#emitChanged();
  }

  #emitChanged(): void {
    for (const cb of [...this.#listeners]) {
      try {
        cb();
      } catch (e) {
        this.#log.warn(`onChanged listener failed: ${errorText(e)}`);
      }
    }
  }
}

/** Composition-root factory (index.ts ServiceSlots.monitors). */
export function createMonitorManager(
  core: CoreServices,
  slots: { themes?: ThemeStore; ambiglow?: AmbiglowService },
  options?: MonitorManagerOptions,
): MonitorManagerImpl {
  return new MonitorManagerImpl(core, slots, options);
}

