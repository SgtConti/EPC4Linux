// The Philips display driver: CDevice_PHLDisplay (+ its bases GClass0/GClass3 and DataOSD/Display) for
// one monitor, ported from work/dotnet-clean/Zeasn.Equipment.Option.Lib/…PHLDisplay/CDevice_PHLDisplay.cs
// ("PHL/…" below), Zeasn.Equipment.Base.Lib/GClass0.cs + GClass3.cs, Zeasn.PCenter.Base.Lib/DataOSD.cs,
// Display.cs and Extension_AttributeInfo.cs. Spec: 06 §7 (sequences), 12 §3, 20-backend-host-tail §2.4-2.6
// and §7.2, 20-monitor-io-linux-consolidation §2-§4, 20-theme-profile-engine §4-§8, 20-enum §1.4.
//
// Life cycle:
//   connect()   fast part of GClass3.ConnectionCkecked + DataOSD.InitDisplayInfo: support probe, capability
//               string (signed cache Config/data.json or a fresh read), SupportOSDList. Enough for
//               Device_GetConnectList (20-backend-host-tail §7.2 recommendation 1).
//   load        queued right after connect (current display only; load() for one that becomes current), in
//               the background: method_14 (checkEne) + method_4 (the full VCP read into CacheDeviceData) +
//               GClass3.DeviceDataCheck (stored ProfileContent, ParameterToDevice with bForce:false — no
//               stored values are pushed on connect) + RecheckFuncConstraints + save. ready() resolves
//               when it finished.
//   operations  every PHL_* sequence runs in the per-display single-flight queue (op-queue.ts) after the
//               load, with the vendor's exact writes and Thread.Sleep delays on an injectable clock.
//
// State mirrors the vendor: `cache` = CacheDeviceData (last full read), `data` = DeviceData (what the hub
// returns and what PurifyProfile stores), `osd` = DataOSD.SupportOSDList (global attributes).

import type { DdcChannel, DiscoveredMonitor, HostServices, JsonResult, Logger, Notifier, UsbDeviceInfo, VcpValue } from '../types.ts';
import type { DeviceProfileDesc, DisplayDevice, ProfileParticipant, ThemeStore } from '../services.ts';
import { error, succ } from '../core/envelope.ts';
import { type CapabilityCache, capCacheKey } from '../ddc/cap-cache.ts';
import { analyseVcpString } from '../ddc/capabilities.ts';
import { type DdcChannelOptions, type DdcClock, DdcChannelImpl, realClock } from '../ddc/channel.ts';
import { fwVersionFromC9 } from '../ddc/codec.ts';
import { type EdidDetails, edidDisplayStrings, localeDecimalSeparator, parseEdid } from '../ddc/edid.ts';
import { errorText } from '../ddc/errors.ts';
import { readTpvString } from '../ddc/identity.ts';
import { AttributeInfo } from './model/attribute-info.ts';
import { DisplayFuncConstraints } from './model/constraints.ts';
import type { DeviceDictionary, UIDisplayInfo } from './model/device-info.ts';
import { edidInfoFrom, emptyEdidInfo } from './model/display-data.ts';
import { DisplayEffectInfo } from './model/effect.ts';
import { type EnumItem, cloneEnumItem, enumValue, getDatas, isBoundValue, isExternName, isStandardName } from './model/enum-items.ts';
import { asInt32 } from './model/json-populate.ts';
import { type AttributeHolder, attributeByName, attributesOf, eqItem } from './model/modules.ts';
import { DEVICE_TYPE_DISPLAY, EQUIPMENT_DISPLAY, T_PHLDisplay_Profile } from './model/profile.ts';
import { buildSupportOsdList, pipPbpTable, resetSmartImageValue, supportedAttribute } from './model/value-lists.ts';
import { OpQueue } from './op-queue.ts';

/** Notification_Func names emitted by the display driver (20-backend-host-tail §2.4 #3, #4). */
export const NOTIFY_CONSTRAINTS = 'NotifyUIDisplayFuncConstraintsChange';
export const NOTIFY_EFFECT = 'NotifyUIDisplayEffectChange';

/**
 * What the vendor reports when a Bridge method dereferences a missing DeviceData: the reflection wrapper
 * text of 20-backend-host-tail §1.3 (the inner NullReferenceException is only logged).
 */
export const INVOCATION_FAILED = 'Exception has been thrown by the target of an invocation.';

/**
 * Upper bound for the ambiglow service's ENE check inside a full read (identifying the ENE takes a few
 * HID transfers, ~100 ms); a hung USB call must not stall the load that Profile_GetDeviceData waits for.
 */
export const CHECK_ENE_TIMEOUT_MS = 5000;

/** Enum values the driver compares against (catalog names, never literals from memory). */
const HDR_OFF = enumValue('SmartImageHDR_E', 'HDROff');
const SDR_OFF = enumValue('SmartImage_E2', 'SmartImage_Off');
const AMBIGLOW_OFF = enumValue('E2A0_19_AmbiglowLightMode_E', 'AmbiglowOff');
const AMBIGLOW_STATIC = enumValue('E2A0_19_AmbiglowLightMode_E', 'StaticMode');
const PRESET_USER_RGB = enumValue('VCP_14_SelectColorPreset', 'Preset_UserRGB');
const SWITCH_ON = enumValue('SwitchFlag_E', 'ON');
const UHD120 = enumValue('E2A0_59_DualResolution_E', 'UHD120Hz');
/** VCP_60_InputSource_E values after which UHD120Hz is dropped: DP1, DP2, USB-C1, USB-C2 (PHL/…:449-455). */
const DP_OR_USBC_INPUTS = ['Normal_DisplayPort1', 'Normal_DisplayPort2', 'Normal_USBC1', 'Normal_USBC2'].map((n) => enumValue('VCP_60_InputSource_E', n));
/** PIP/PBP source defaults when 0x60's second byte is 0: HDMI2 (34), else DP1 (47) (PHL/…:400-412). */
const PIP_DEFAULTS = [34, 47];

export interface PhlDisplayOptions {
  log: Logger;
  notifier: Notifier;
  host: HostServices;
  capCache: CapabilityCache;
  dict: DeviceDictionary;
  themes?: ThemeStore;
  /** DdcChannelImpl options (timings, clock) for the monitor's channel. */
  channel?: DdcChannelOptions;
  /** Clock for the driver's own Thread.Sleep delays (1000 ms after DC, 5000 ms after 0x04, …). */
  clock?: DdcClock;
  /** Decimal separator of the EDID strings (20 D5); default: the process locale. */
  decimalSeparator?: string;
  /** 1-based position among the discovered monitors, for the `\\.\DISPLAYn` fallback DeviceName. */
  index?: number;
  /**
   * Called (outside the operation queue, not awaited) whenever DeviceData.EffectInfo may have been
   * replaced — load, reload, profile apply, reset — so the ambiglow service can push it to the ENE
   * (vendor method_17 call sites in method_12/Reset).
   */
  onEffectInfoChanged?: (display: PhlDisplay) => void;
  /**
   * Vendor method_14 at the top of every full read (PHL/…:328): the ENE model of this display ('' = none),
   * or null when nobody can tell (the model last reported through setEneModel is kept). The manager
   * wires it to AmbiglowService.checkEne (services.ts).
   */
  checkEne?: (display: PhlDisplay) => Promise<string | null>;
}

/** LINQ Intersect with EnumItemCompare: first list's objects and order, distinct by Value. */
function intersect(first: readonly EnumItem[] | null, second: readonly EnumItem[]): EnumItem[] | null {
  if (!first) return null;
  const seen = new Set<number>();
  return first.filter((x) => second.some((y) => y.Value === x.Value) && !seen.has(x.Value) && seen.add(x.Value) !== undefined).map(cloneEnumItem);
}

/** LINQ Except with EnumItemCompare: first list's objects not in `second`, distinct by Value. */
function except(first: readonly EnumItem[] | null, second: readonly EnumItem[]): EnumItem[] | null {
  if (!first) return null;
  const seen = new Set<number>();
  return first.filter((x) => !second.some((y) => y.Value === x.Value) && !seen.has(x.Value) && seen.add(x.Value) !== undefined).map(cloneEnumItem);
}

/** BitConverter.GetBytes(int) little-endian byte i. */
const byteOf = (value: number, i: number) => (value >> (8 * i)) & 0xff;

export class PhlDisplay implements DisplayDevice, ProfileParticipant {
  readonly key: string;
  readonly monitorName: string;
  readonly desc: DeviceProfileDesc;
  readonly #log: Logger;
  readonly #notifier: Notifier;
  readonly #host: HostServices;
  readonly #capCache: CapabilityCache;
  readonly #dict: DeviceDictionary;
  readonly #themes: ThemeStore | undefined;
  readonly #channelOptions: DdcChannelOptions;
  readonly #clock: DdcClock;
  readonly #decimal: string;
  readonly #onEffect: ((d: PhlDisplay) => void) | undefined;
  readonly #checkEneHook: ((d: PhlDisplay) => Promise<string | null>) | undefined;
  readonly #queue = new OpQueue();
  readonly #constraints = new DisplayFuncConstraints();
  #index: number;
  #discovered: DiscoveredMonitor;
  #edid: EdidDetails | null;
  #ddc: DdcChannelImpl;
  #isSupport = false;
  #connected = false;
  #vcpCode = '';
  #fwVersion = '';
  #osd: AttributeInfo[] = [];
  #cache: T_PHLDisplay_Profile | null = null;
  #data: T_PHLDisplay_Profile | null = null;
  /** CUSBENE6K7732 model string (vendor string_0); '' = no ENE in use (bool_2 false). */
  #eneModel = '';
  #ready: Promise<void> = Promise.resolve();
  #loaded = false;
  #loading = false;
  #loadGeneration = 0;
  /** applyProfileContent/resetToFactory calls waiting for (or running after) the load. */
  #profileOps = 0;
  #closed = false;

  constructor(discovered: DiscoveredMonitor, options: PhlDisplayOptions) {
    this.#discovered = discovered;
    this.#edid = discovered.edid ? parseEdid(discovered.edid.raw) : null;
    this.key = discovered.key;
    this.monitorName = this.#edid?.monitorName ?? discovered.edid?.monitorName ?? '';
    this.desc = Object.freeze({ EquipmentType: EQUIPMENT_DISPLAY, DeviceType: DEVICE_TYPE_DISPLAY, ModelName: this.monitorName, ExtModel: options.dict.displayRecord.ExtModel });
    this.#log = options.log.child(`display:${this.key}`);
    this.#notifier = options.notifier;
    this.#host = options.host;
    this.#capCache = options.capCache;
    this.#dict = options.dict;
    this.#themes = options.themes;
    this.#channelOptions = options.channel ?? {};
    this.#clock = options.clock ?? realClock;
    this.#decimal = options.decimalSeparator ?? localeDecimalSeparator();
    this.#onEffect = options.onEffectInfoChanged;
    this.#checkEneHook = options.checkEne;
    this.#index = options.index ?? 1;
    this.#ddc = new DdcChannelImpl(discovered.transports, { log: this.#log.child('ddc'), ...this.#channelOptions });
  }

  // ───────────────────────────── DisplayDevice ─────────────────────────────

  get discovered(): DiscoveredMonitor {
    return this.#discovered;
  }

  get ddc(): DdcChannel {
    return this.#ddc;
  }

  get ene(): UsbDeviceInfo | undefined {
    return this.#discovered.ene;
  }

  /** The background load (20-backend-host-tail §7.2); never rejects. */
  ready(): Promise<void> {
    return this.#ready;
  }

  /** DeviceData (the live T_PHLDisplay_Profile), null before the first load finished. */
  profile(): T_PHLDisplay_Profile | null {
    return this.#data;
  }

  /** GClass3/CDeviceBase bConnection: a supported transport and an analysable capability string. */
  get connected(): boolean {
    return this.#connected && !this.#closed;
  }

  /** Display.IsSupport: at least one transport passed its DDC/CI support probe. */
  get isSupport(): boolean {
    return this.#isSupport && !this.#closed;
  }

  /** The capability string in use (Display.VcpCode). */
  get capabilities(): string {
    return this.#vcpCode;
  }

  /** FE E1 E6 (or C9) firmware version used for the capability cache key, e.g. "V1.01". */
  get fwVersion(): string {
    return this.#fwVersion;
  }

  /** The current DisplayFuncConstraints (PHL_GetConstraints Tag). */
  get constraints(): DisplayFuncConstraints {
    return this.#constraints;
  }

  /** The ENE model string the ambiglow service reported ('' = none). */
  get eneModel(): string {
    return this.#eneModel;
  }

  /** UIDisplayInfo for Device_GetConnectList (GClass3.method_6). */
  uiInfo(): UIDisplayInfo {
    return { DisplayName: this.monitorName, MonitorName: this.monitorName, DeviceName: this.deviceName, DisplaySN: this.key };
  }

  /**
   * MONITORINFOEX.szDevice on Windows ("\\.\DISPLAY1"). Linux: the DRM connector without "cardN-", e.g.
   * "DP-1" (20-monitor-io §3.2; the renderer never reads it, 20-backend-host-tail §9 Q2).
   */
  get deviceName(): string {
    const c = this.#discovered.connector;
    if (c) return c.replace(/^card\d+-/, '');
    return `\\\\.\\DISPLAY${this.#index}`;
  }

  /** Run `fn` in the display's single-flight queue after the load (Effect_* sequences of the ambiglow service). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.#op(fn);
  }

  /** Hold the queue without waiting for the load (the manager pauses DDC sequences during discovery). */
  exclusiveRaw<T>(fn: () => Promise<T>): Promise<T> {
    return this.#queue.run(fn);
  }

  /** RecheckFuncConstraints (+ notification when changed) and SaveProfile after a change made through profile(). */
  async settingsChanged(): Promise<void> {
    const data = this.#data;
    if (!data) return;
    this.#recheck(data);
    await this.#save();
  }

  /**
   * ENE presence reported by the ambiglow service (vendor method_14 plug / method_15 unplug with
   * bUsbChange, PHL/…:760-858): updates ENEEffectEnable and EffectInfo, on loss writes the DDC Ambiglow
   * state back (E2A019) and rechecks the constraints; when the state changed it saves and sends
   * NotifyUIDisplayEffectChange with the keys the renderer reads (20-backend-host-tail §2.5). Pushing
   * EffectInfo to the ENE is the caller's job.
   *
   * Before and during the first load the model is recorded at once, so that load uses it (the vendor
   * runs method_14 before method_4's reads); the queued part then only reconciles DeviceData. The change is
   * mirrored into CacheDeviceData too: the next ParameterToDevice branches on the cache's ENEEffectEnable
   * (method_12, PHL/…:693), and a stale `false` there would write E2A019 and drop ENE mode on a theme
   * switch (a vendor bug for a hot-plug after the load, which is not reproduced).
   */
  async setEneModel(model: string): Promise<void> {
    if (!this.#loaded) this.#eneModel = model;
    await this.#op(async () => {
      this.#eneModel = model;
      const data = this.#data;
      if (!data) return;
      if (model !== '') {
        const plugged = !data.ENEEffectEnable;
        data.ENEEffectEnable = true;
        const fresh = !data.EffectInfo || !data.EffectInfo.isComplete;
        if (fresh) data.EffectInfo = DisplayEffectInfo.default(model);
        this.#mirrorEne(data);
        if (!plugged && !fresh) return;
        await this.#save();
        // method_14 notifies only when the ENE was not in use before (`bUsbChange && !bool_2`).
        if (plugged) this.#notifyEffect(data);
        return;
      }
      if (!data.ENEEffectEnable) {
        this.#mirrorEne(data);
        return;
      }
      data.ENEEffectEnable = false;
      const mode = data.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode;
      if (data.ModuleAmbiglow.EffectEnable) {
        if (mode.IsAvailable) {
          if (asInt32(mode.Value) === AMBIGLOW_OFF) mode.Value = AMBIGLOW_STATIC;
          await this.#write(mode);
        }
      } else if (mode.IsAvailable) {
        const off = mode.clone();
        off.Value = AMBIGLOW_OFF;
        await this.#write(off);
        if (asInt32(mode.Value) === AMBIGLOW_OFF) mode.Value = AMBIGLOW_STATIC;
      }
      this.#recheck(data);
      this.#mirrorEne(data, true);
      await this.#save();
      this.#notifyEffect(data);
    });
  }

  /**
   * NotifyUIDisplayEffectChange. The vendor's Tag is a ValueTuple, serialized as `Item1..3`
   * (CDevice_PHLDisplay.cs:786-792, 851-857), which the renderer cannot read (Monitor-D4qz4RBn.js:85-91 tests
   * `a.ENEEnable`). The port sends the named keys the renderer reads first, then the vendor's tuple keys with
   * the same values (12 §7 port plan item 7; 20-backend-host-tail §2.4 row 3, §2.5).
   */
  #notifyEffect(data: T_PHLDisplay_Profile): void {
    this.#notifier.notify(NOTIFY_EFFECT, {
      ENEEnable: data.ENEEffectEnable,
      EffectInfo: data.EffectInfo,
      ModuleAmbiglow: data.ModuleAmbiglow,
      Item1: data.ENEEffectEnable,
      Item2: data.EffectInfo,
      Item3: data.ModuleAmbiglow,
    });
  }

  /**
   * Copy DeviceData's ENE state (ENEEffectEnable, EffectInfo) into CacheDeviceData; with `ambiglow` also
   * ModuleAmbiglow, whose E2A019 the loss path has just written back to the monitor.
   */
  #mirrorEne(data: T_PHLDisplay_Profile, ambiglow = false): void {
    const cache = this.#cache;
    if (!cache || cache === data) return;
    cache.ENEEffectEnable = data.ENEEffectEnable;
    cache.EffectInfo = data.EffectInfo ? data.EffectInfo.clone() : null;
    if (ambiglow) cache.ModuleAmbiglow = data.ModuleAmbiglow.clone();
  }

  // ───────────────────────────── ProfileParticipant ─────────────────────────────

  /** PurifyProfile(): DeviceData in 'profile' mode; before the first load the stored section is kept. */
  purify(): string {
    if (this.#data) return this.#data.purify();
    return this.#themes?.getStoredContent(this.desc) ?? '';
  }

  /**
   * Theme switch / apply / import (SystemOper.smethod_20): ParameterToDevice(content, bForce: true,
   * needSave: false). Only the SmartImage/HDR group and Ambiglow are written (20-theme §5.5, §6).
   * The manager registers the display right after its fast connect, so a switch during the background
   * load (Start returns before it, and CheckTopApp is armed right after Start) queues behind the load
   * and is applied once CacheDeviceData exists — the vendor cannot get here, its scan is synchronous
   * inside Start (SO:107-121).
   *
   * Port fix (deviation 18): CacheDeviceData is first rebased on DeviceData. Every setter (PHL_SetSmartImage,
   * PHL_SetOSD, …) changes DeviceData only, as in the vendor, but ParameterToDevice compares the target with
   * the cache (method_10's DC, method_12's Ambiglow 1A-1E, PHL/…:616-632, 711-715) and ends with DeviceData =
   * the cache (PHL/…:600). Against the last full read the vendor skipped the DC write after a preset change
   * (the monitor stayed in HDR Movie while the UI and the profile said HDR Game) and put the last read's
   * volume, input, GameMode, … back into DeviceData, which the UI then showed and the switch saved into the
   * target profile. DeviceData is what the app last wrote to or read from the monitor; the rebase is what the
   * vendor's own (unused) ParameterToDevice(bool) override does (PHL/…:576-583). Between two applies
   * DeviceData = the cache + the setters' changes, so without a setter in between nothing changes.
   */
  async applyProfileContent(content: string | null): Promise<void> {
    this.#profileOps++;
    try {
      await this.#op(async () => {
        if (!this.#cache) return;
        if (this.#data) this.#cache = this.#data.clone();
        // after the rebase: GetDefaultData() (no section for this monitor) is the current state
        const target = T_PHLDisplay_Profile.parse(content) ?? this.#defaultData();
        await this.#parameterToDevice(target, true, false);
      });
    } finally {
      this.#profileOps--;
    }
    this.#effectChanged();
  }

  /** Theme_ResetCurProfile / FactoryReset: Reset(needSave: false) (VCP 0x04 = 1, 5 s, full re-read). */
  async resetToFactory(): Promise<void> {
    this.#profileOps++;
    try {
      const r = await this.reset(false);
      if (r.err_code !== 0) this.#log.warn(`reset: ${r.err_msg ?? ''}`);
    } finally {
      this.#profileOps--;
    }
  }

  // ───────────────────────────── connection ─────────────────────────────

  /**
   * Fast connect (GClass3.ConnectionCkecked steps 1-5 on Linux, 20-monitor-io §2.3): support probe on every
   * transport, capability string, SupportOSDList. Queues the background load on success unless
   * `load: false` (the manager loads only the current display, like the vendor's single driver that
   * works on CurDisplay; load() starts it later). Resolves with bConnection.
   */
  async connect(options: { load?: boolean } = {}): Promise<boolean> {
    const ok = await this.#queue.run(async () => {
      this.#loaded = false;
      const probes = await this.#ddc.probe();
      this.#isSupport = probes.some((p) => p.supported);
      if (!this.#isSupport) {
        this.#log.warn('no DDC/CI transport passed the support probe; display not connected');
        this.#connected = false;
        return false;
      }
      const vcp = await this.#initDisplayVcpCode(probes.some((p) => p.supported && p.kind === 'via-usb'));
      const caps = analyseVcpString(vcp);
      if (!caps) {
        this.#log.error('########### AnalyseVcpString Error ###########');
        this.#connected = false;
        return false;
      }
      this.#vcpCode = vcp;
      this.#osd = buildSupportOsdList(caps, this.#log);
      this.#connected = true;
      return true;
    });
    if (ok && options.load !== false) this.#startLoad();
    return ok;
  }

  /**
   * Start the background load of a connected display unless it is loaded or loading (a display that
   * becomes the current one after a fast connect without load). Resolves like ready().
   */
  load(): Promise<void> {
    if (this.connected && !this.#loaded && !this.#loading) this.#startLoad();
    return this.#ready;
  }

  /** Replace the transports after a rescan (the physical monitor is the same; the loaded model is kept). */
  async rebind(discovered: DiscoveredMonitor, index: number): Promise<void> {
    await this.#queue.run(async () => {
      const old = this.#ddc;
      this.#discovered = discovered;
      this.#edid = discovered.edid ? parseEdid(discovered.edid.raw) : this.#edid;
      this.#index = index;
      this.#ddc = new DdcChannelImpl(discovered.transports, { log: this.#log.child('ddc'), ...this.#channelOptions });
      await old.close();
    });
  }

  /** Update the ENE USB device of the discovery result (the driver itself only keeps it for services). */
  setEneDevice(ene: UsbDeviceInfo | undefined): void {
    this.#discovered = { ...this.#discovered, ene };
  }

  /** Probe the transports again (Device_DetectionUSB / a USB hotplug; 20-monitor-io §2.2 rule 6). */
  async reprobe(): Promise<boolean> {
    return this.#queue.run(async () => {
      const probes = await this.#ddc.probe();
      this.#isSupport = probes.some((p) => p.supported);
      return this.#isSupport;
    });
  }

  /** Mark disconnected and close the channel (the monitor vanished or the manager stops). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#connected = false;
    await this.#queue.run(() => this.#ddc.close()).catch((e) => this.#log.warn(`close: ${errorText(e)}`));
  }

  /** Mark the display unsupported (OnDisConnect) without closing it. */
  markDisconnected(): void {
    this.#connected = false;
    this.#isSupport = false;
  }

  /** Display.InitDisplayVcpCode (Display.cs:202-324), Linux form of 20-monitor-io §2.3 step 5. */
  async #initDisplayVcpCode(usb: boolean): Promise<string> {
    let version = '';
    if (!usb) {
      // Display.method_1: VCP C9 (max 201) first, then the FE E1 E6 query (DDCHelper GetDisplayFWVersion).
      try {
        const v = fwVersionFromC9(await this.#ddc.getVcp(0xc9));
        if (v !== null) version = v;
      } catch (e) {
        this.#log.debug(`VCP C9: ${errorText(e)}`);
      }
    }
    if (version === '') {
      try {
        version = await readTpvString(this.#ddc, 'fwVersion');
      } catch (e) {
        this.#log.warn(`firmware version unreadable: ${errorText(e)}`);
      }
    }
    this.#fwVersion = version;
    let key = '';
    try {
      key = capCacheKey(version, await this.#ddc.getVcp(0x60));
    } catch (e) {
      this.#log.warn(`VCP 60 unreadable, capability cache skipped: ${errorText(e)}`);
    }
    this.#log.debug(`TryGetCapabilites cacheKey=${key}`);
    if (key !== '') {
      const cached = this.#capCache.get(this.monitorName, key);
      if (cached) return cached;
    }
    let caps = '';
    try {
      caps = await this.#ddc.capabilities();
    } catch (e) {
      this.#log.error(`capability string unreadable: ${errorText(e)}`);
      return '';
    }
    if (analyseVcpString(caps)) {
      try {
        await this.#capCache.save(this.monitorName, key, caps);
      } catch (e) {
        this.#log.warn(`capability cache not saved: ${errorText(e)}`);
      }
      return caps;
    }
    return '';
  }

  #startLoad(): void {
    this.#loading = true;
    const generation = ++this.#loadGeneration;
    const load = this.#queue.run(async () => {
      if (!this.#connected) return;
      this.#cache = await this.#readAll();
      await this.#deviceDataCheck();
      this.#loaded = true;
    });
    this.#ready = load
      .then(
        () => this.#effectChanged(),
        (e) => this.#log.error(`load failed: ${errorText(e)}`),
      )
      .finally(() => {
        if (generation === this.#loadGeneration) this.#loading = false;
      });
  }

  /**
   * GClass3.DeviceDataCheck: stored content (or the default data), then ParameterToDevice(bForce:false).
   * When a theme switch/apply or reset is already waiting for this load, the save is left to it: this
   * load read the profile section the switch is about to apply, and saving the not-yet-switched monitor
   * state into it first would be wrong (the store saves after applying, 20-theme §5.5/§8).
   */
  async #deviceDataCheck(): Promise<void> {
    const content = this.#themes?.getStoredContent(this.desc) ?? null;
    const stored = T_PHLDisplay_Profile.parse(content);
    this.#data = stored ?? this.#defaultData();
    await this.#parameterToDevice(this.#data, false, this.#profileOps === 0);
  }

  /**
   * Vendor method_14 at the top of method_4 (PHL/…:328): ask the ambiglow service for the ENE model
   * before reading, so this read's ENEEffectEnable/EffectInfo reflect it. Without an answer the model
   * last reported through setEneModel stays; a failing check means no usable ENE (Plug() failed →
   * method_15 clears string_0).
   */
  async #checkEne(): Promise<void> {
    const hook = this.#checkEneHook;
    if (!hook) return;
    const expired = Symbol('timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof expired>((resolve) => {
      timer = setTimeout(resolve, CHECK_ENE_TIMEOUT_MS, expired);
      timer.unref?.();
    });
    const answer = Promise.resolve().then(() => hook(this));
    try {
      const model = await Promise.race([answer, timeout]);
      if (model === expired) {
        this.#log.warn(`CheckENE: no answer after ${CHECK_ENE_TIMEOUT_MS} ms; keeping ENE model "${this.#eneModel}"`);
        answer.catch(() => undefined);
        return;
      }
      if (model !== null) this.#eneModel = model;
    } catch (e) {
      this.#log.warn(`CheckENE failed: ${errorText(e)}`);
      this.#eneModel = '';
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** GetDefaultData(): CacheDeviceData itself, with a fresh EffectInfo (PHL/…:248-265). */
  #defaultData(): T_PHLDisplay_Profile {
    const d = this.#cache ?? new T_PHLDisplay_Profile();
    d.DeviceType = DEVICE_TYPE_DISPLAY;
    d.ModelName = this.monitorName;
    d.EffectInfo = this.#eneModel ? DisplayEffectInfo.default(this.#eneModel) : new DisplayEffectInfo();
    return d;
  }

  #effectChanged(): void {
    const hook = this.#onEffect;
    if (!hook || !this.#data) return;
    this.#queue.outside(() => {
      try {
        hook(this);
      } catch (e) {
        this.#log.warn(`EffectInfo hook failed: ${errorText(e)}`);
      }
    });
  }

  /** Queue an operation after the load (inline when already inside the queue). */
  async #op<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.#queue.inside) await this.#ready;
    return this.#queue.run(fn);
  }

  // ───────────────────────────── VCP I/O (Extension_AttributeInfo) ─────────────────────────────

  /** DataOSD.GetAttributeInfo(name): the global attribute, or an unavailable one. */
  #global(opName: string): AttributeInfo {
    return supportedAttribute(this.#osd, opName, this.#isSupport);
  }

  /** AttributeInfo.GetValue(): read one VCP; success sets Value/MaxValue/err_code 0, failure err_code 9. */
  async #read(a: AttributeInfo): Promise<void> {
    const code = a.VCPOpCode;
    try {
      let v: VcpValue;
      if (isStandardName(a.VCPOpCodeName)) {
        v = await this.#ddc.getVcp(code);
      } else if (isExternName(a.VCPOpCodeName)) {
        if ((code & 0xffff00) !== 0xe2a000) {
          a.setErrMsg(`extCode formate error code = ${code.toString(16)}`);
          return;
        }
        v = await this.#ddc.getExt(code & 0xff);
      } else {
        return;
      }
      a.Value = v.value;
      a.MaxValue = v.max;
      a.resetErrMsg();
    } catch (e) {
      a.setErrMsg(`${isStandardName(a.VCPOpCodeName) ? 'GetStandardValue' : 'GetTPVExternValue'} error result=${errorText(e)}`);
    }
  }

  /**
   * AttributeInfo.SetValue(): one write of Value.ToInt32(). Like the vendor the transport result is not
   * reported to the caller (Display.SetStandardValue's return code is ignored); failures are logged.
   */
  async #write(a: AttributeInfo): Promise<void> {
    const code = a.VCPOpCode;
    const value = asInt32(a.Value);
    try {
      if (isStandardName(a.VCPOpCodeName)) await this.#ddc.setVcp(code, value);
      else if (isExternName(a.VCPOpCodeName)) await this.#ddc.setExt(code & 0xff, value);
      else this.#log.error(`${code} is not VcpCode`);
    } catch (e) {
      this.#log.warn(`${a.VCPOpCodeName ?? code} = ${value}: write failed: ${errorText(e)}`);
    }
  }

  /** Extension_AttributeInfo.GetValue<T>: every AttributeInfo property, copying the global ValueList. */
  async #readModule(holder: AttributeHolder): Promise<void> {
    for (const a of attributesOf(holder)) {
      const g = this.#global(a.VCPOpCodeName ?? '');
      if (g.IsAvailable) {
        if (!a.ValueList?.length && g.ValueList?.length) a.ValueList = g.ValueList.map(cloneEnumItem);
        await this.#read(a);
      } else {
        a.setErrMsg(g.err_msg);
      }
    }
  }

  /** method_13: write `src.Value` into `dst` when available and (forced or different). */
  async #restore(dst: AttributeInfo, src: AttributeInfo, force = false): Promise<void> {
    if (dst.IsAvailable && src.Value !== null && (force || asInt32(dst.Value) !== asInt32(src.Value))) {
      dst.Value = src.Value;
      await this.#write(dst);
    }
  }

  #sleep(ms: number): Promise<void> {
    return this.#clock.sleep(ms);
  }

  /** RecheckFuncConstraints + Notify() when the serialized state changed. */
  #recheck(data: T_PHLDisplay_Profile): void {
    if (this.#constraints.recheck(data, pipPbpTable(this.#osd) !== null)) this.#notifyConstraints();
  }

  #notifyConstraints(): void {
    this.#notifier.notify(NOTIFY_CONSTRAINTS, this.#constraints);
  }

  /**
   * SaveProfile(): EVT_Com.SaveCurThemeProfile → the theme store rewrites the current .pcenter. Not
   * awaited: the store coalesces bursts (a slider drag) into one write and purifies the then-current
   * DeviceData, so an operation's reply never waits for the file write.
   */
  async #save(): Promise<void> {
    const themes = this.#themes;
    if (!themes || !this.#data) return;
    this.#queue.outside(() => {
      themes.saveParticipant(this).catch((e: unknown) => this.#log.error(`SaveProfile failed: ${errorText(e)}`));
    });
  }

  // ───────────────────────────── method_4: the full read ─────────────────────────────

  /** CDevice_PHLDisplay.method_4 (PHL/…:296-468; 06 §7.1; 20-enum §1.4). Returns the new CacheDeviceData. */
  async #readAll(): Promise<T_PHLDisplay_Profile> {
    const started = this.#clock.now();
    const cache = new T_PHLDisplay_Profile();
    cache.EquipmentType = EQUIPMENT_DISPLAY;
    cache.DeviceType = DEVICE_TYPE_DISPLAY;
    cache.ModelName = this.monitorName;
    cache.DispalyData.MonitorEDIDInfo_T = this.#edid ? edidInfoFrom(edidDisplayStrings(this.#edid, this.#decimal)) : emptyEdidInfo();
    try {
      const mode = this.#host.getDisplayMode?.(this.#discovered) ?? null;
      if (mode) {
        cache.DispalyData.MonitorResolution = mode.resolution;
        cache.DispalyData.MonitorFrequency = mode.frequency;
        cache.DispalyData.MonitorOrientation = mode.orientation;
      }
    } catch (e) {
      this.#log.warn(`display mode unavailable: ${errorText(e)}`);
    }
    if (!this.#isSupport) return cache;
    await this.#checkEne();

    // IsSmartImageHDR, policy P1 (20-monitor-io §4, D8): the DC value read in this pass is an HDR preset.
    await this.#readModule(cache);
    const dcAttr = cache.OP_DC_DisplayApplication;
    const dc = asInt32(dcAttr.Value);
    const hdr = dcAttr.IsAvailable && dcAttr.Value !== null && isBoundValue('SmartImageHDR_E', dc);
    cache.IsSmartImageHDR = hdr;
    const hdrDatas = getDatas('SmartImageHDR_E');
    if (hdr) {
      // Deviation: a DC without ValueList gives [] instead of the vendor's null Items (renderer .map()).
      cache.ModuleSmartImageHDR.Items = intersect(dcAttr.ValueList, hdrDatas) ?? [];
      if (dc !== HDR_OFF) {
        await this.#readModule(cache.ModuleSmartImageHDR.CurSubSmartImage);
        cache.ModuleSmartImageHDR.SubSmartImages.set(dc, cache.ModuleSmartImageHDR.CurSubSmartImage);
      }
    } else {
      cache.ModuleSmartImage.Items = except(dcAttr.ValueList, hdrDatas) ?? [];
      if (dc !== SDR_OFF) {
        await this.#readModule(cache.ModuleSmartImage.CurSubSmartImage);
        cache.ModuleSmartImage.SubSmartImages.set(dc, cache.ModuleSmartImage.CurSubSmartImage);
      }
    }

    // GameMode + DualResolution split (06 §7.11; 20-enum §8 item 3: trimming only with Overclock available).
    await this.#readModule(cache.ModuleGameMode);
    const dual = cache.ModuleGameMode.EXT_OP_E2A0_59_DualResolution.clone();
    if (dual.IsAvailable) {
      const raw = asInt32(dual.Value);
      const split = raw >> 8;
      dual.Value = raw & 0xff;
      if (dual.ValueList && split > 0 && split < dual.ValueList.length) {
        const overclock = cache.ModuleGameMode.EXT_OP_E2A0_4C_Overclock;
        if (overclock.IsAvailable) {
          if (asInt32(overclock.Value) === SWITCH_ON) dual.ValueList.splice(0, split);
          else dual.ValueList.splice(split);
        }
      }
      cache.ModuleGameMode.EXT_OP_E2A0_59_DualResolution = dual;
    }

    // Ambiglow: without ENE the DDC mode decides EffectEnable, and Off is shown as StaticMode (PHL/…:379-390).
    // #eneModel is read here (not at the check above) so that a setEneModel report that arrives during
    // the reads still counts when no checkEne hook answers.
    await this.#readModule(cache.ModuleAmbiglow);
    const ene = this.#eneModel !== '';
    cache.ENEEffectEnable = ene;
    cache.EffectInfo = ene ? DisplayEffectInfo.default(this.#eneModel) : null;
    if (!ene) {
      const mode = cache.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode;
      cache.ModuleAmbiglow.EffectEnable = mode.IsAvailable && asInt32(mode.Value) !== AMBIGLOW_OFF;
      if (!cache.ModuleAmbiglow.EffectEnable) mode.Value = AMBIGLOW_STATIC;
    }

    // Input (PHL/…:391-420).
    await this.#readModule(cache.ModuleInput);
    const input = cache.ModuleInput;
    // Deviation: a 0x60 without ValueList gives [] (the vendor stores null and then throws in Find).
    input.InputSourceList = intersect(input.OP_60_InputSource.ValueList, getDatas('VCP_60_InputSource_E')) ?? [];
    input.PIPPBPSourceList = intersect(input.OP_60_InputSource.ValueList, getDatas('VCP_60_PIPPBPSource_E')) ?? [];
    this.#splitInputSource(input);
    const table = pipPbpTable(this.#osd);
    if (input.OP_A5_WindowSelect.IsAvailable && table) {
      input.OP_A5_WindowSelect.ValueList = table;
      input.InputSourceInfo.Mode = asInt32(input.OP_A5_WindowSelect.Value);
      const ec = asInt32(input.OP_EC_PIPPBPSizeLocation.Value);
      input.InputSourceInfo.Size = byteOf(ec, 0);
      input.InputSourceInfo.Location = byteOf(ec, 1);
    }

    // Audio + EQ bands through the GLOBAL E2A001/E2A039 attributes (PHL/…:421-440).
    await this.#readModule(cache.ModuleAudio);
    const eqBand = this.#global('EXT_OP_E2A0_01_AudioEQ');
    const eqGain = this.#global('EXT_OP_E2A0_39_AudioEQGain');
    if (eqBand.IsAvailable && eqGain.IsAvailable) {
      for (const band of eqBand.ValueList ?? []) {
        eqBand.Value = band.Value;
        await this.#write(eqBand);
        await this.#sleep(100);
        await this.#read(eqGain);
        cache.ModuleAudio.EQItems.push(eqItem(band.Name ?? '', band.Value, asInt32(eqGain.Value), eqGain.MaxValue));
      }
    }

    await this.#readModule(cache.ModuleSystem);
    await this.#readModule(cache.ModuleSetup);
    cache.HasUSBSetting = ['EXT_OP_E2A0_12_USB_C_Setting', 'EXT_OP_E2A0_14_USB_Upstream', 'EXT_OP_E2A0_15_KVM'].some((n) => this.#global(n).IsAvailable);
    await this.#readOledTimers(cache);

    const dualList = cache.ModuleGameMode.EXT_OP_E2A0_59_DualResolution;
    if (dualList.IsAvailable && dualList.ValueList && dualList.ValueList.length > 0) {
      const i = dualList.ValueList.findIndex((x) => x.Value === UHD120);
      if (i !== -1 && DP_OR_USBC_INPUTS.includes(input.InputSourceInfo.InputSource)) dualList.ValueList.splice(i, 1);
    }
    this.#log.debug(`CacheDeviceDataLoad    TotalMilliseconds=${Math.round(this.#clock.now() - started)}    ${this.#isSupport}`);
    return cache;
  }

  /** 0x60 byte split with the PIP source default (PHL/…:397-412, 1950-1968). */
  #splitInputSource(input: T_PHLDisplay_Profile['ModuleInput']): void {
    const v = asInt32(input.OP_60_InputSource.Value);
    input.InputSourceInfo.InputSource = byteOf(v, 0);
    input.InputSourceInfo.PIPPBPSource = byteOf(v, 1);
    if (byteOf(v, 1) === 0) {
      const found = PIP_DEFAULTS.find((d) => input.PIPPBPSourceList.some((x) => x.Value === d));
      if (found !== undefined) input.InputSourceInfo.PIPPBPSource = found;
    }
  }

  /** method_9: OLED working time and time after pixel refresh, each (H << 16) | L, else -1. */
  async #readOledTimers(cache: T_PHLDisplay_Profile): Promise<void> {
    cache.ModuleSetup.WorkingTime = -1;
    const wl = this.#global('EXT_OP_E2A0_4E_OLEDInfoWorkingTimeL');
    if (wl.IsAvailable) {
      await this.#read(wl);
      if (wl.IsAvailable) {
        const lo = asInt32(wl.Value);
        const wh = this.#global('EXT_OP_E2A0_4D_OLEDInfoWorkingTimeH');
        await this.#read(wh);
        const hi = wh.IsAvailable ? asInt32(wh.Value) : 0;
        cache.ModuleSetup.WorkingTime = (hi << 16) | lo;
      }
    }
    cache.ModuleSetup.TimeAfterPixelRefresh = -1;
    const pl = this.#global('EXT_OP_E2A0_51_OLEDInfoTimeAfterPixelRefreshL');
    if (!pl.IsAvailable) return;
    await this.#read(pl);
    if (pl.IsAvailable) {
      const lo = asInt32(pl.Value);
      const ph = this.#global('EXT_OP_E2A0_50_OLEDInfoTimeAfterPixelRefreshH');
      await this.#read(ph);
      const hi = ph.IsAvailable ? asInt32(ph.Value) : 0;
      cache.ModuleSetup.TimeAfterPixelRefresh = (hi << 16) | lo;
    }
  }

  // ───────────────────────────── ParameterToDevice ─────────────────────────────

  /** ParameterToDevice(object, bForce, needSave) (PHL/…:585-614). */
  async #parameterToDevice(profile: T_PHLDisplay_Profile, force: boolean, needSave: boolean): Promise<void> {
    const cache = this.#cache;
    if (!cache || !this.#isSupport) {
      this.#log.error(`ParameterToDevice error ${this.monitorName}`);
      return;
    }
    const started = this.#clock.now();
    if (force) await this.#restoreSmartImage(cache, profile);
    await this.#restoreEffect(cache, profile, force);
    this.#log.debug(`PHLDisplay ParameterToDevice    TotalMilliseconds=${Math.round(this.#clock.now() - started)}    ${this.monitorName}`);
    this.#data = cache.clone();
    this.#recheck(this.#data);
    if (needSave) await this.#save();
  }

  /** method_10: the SmartImage/HDR group (20-theme §6 table rows 1-2). */
  async #restoreSmartImage(cache: T_PHLDisplay_Profile, profile: T_PHLDisplay_Profile): Promise<void> {
    let dc = asInt32(profile.OP_DC_DisplayApplication.Value);
    const cacheDc = cache.OP_DC_DisplayApplication;
    if (!cache.IsSmartImageHDR) {
      if (cache.ModuleSmartImage.Items.findIndex((x) => x.Value === dc) < 0) dc = asInt32(cacheDc.Value);
      if (asInt32(cacheDc.Value) !== dc) {
        cacheDc.Value = dc;
        await this.#write(cacheDc);
        await this.#sleep(1000);
      }
    } else if (cache.IsSmartImageHDR === profile.IsSmartImageHDR && asInt32(cacheDc.Value) !== dc) {
      cacheDc.Value = dc;
      await this.#write(cacheDc);
      await this.#sleep(1000);
    }
    if (!cache.IsSmartImageHDR) {
      cache.ModuleSmartImageHDR = profile.ModuleSmartImageHDR.clone();
      const c = cache.ModuleSmartImage.CurSubSmartImage;
      const p = profile.ModuleSmartImage.CurSubSmartImage;
      await this.#restore(c.EXT_OP_E2A0_20_ColorSpace, p.EXT_OP_E2A0_20_ColorSpace, true);
      await this.#restore(c.OP_14_SelectColorPreset, p.OP_14_SelectColorPreset, true);
      if (asInt32(c.OP_14_SelectColorPreset.Value) === PRESET_USER_RGB) {
        await this.#restore(c.OP_16_VideoGainDriveRed, p.OP_16_VideoGainDriveRed, true);
        await this.#restore(c.OP_18_VideoGainDriveGreen, p.OP_18_VideoGainDriveGreen, true);
        await this.#restore(c.OP_1A_VideoGainDriveBlue, p.OP_1A_VideoGainDriveBlue, true);
      }
      await this.#restore(c.OP_72_Gamma, p.OP_72_Gamma, true);
      await this.#restore(c.OP_12_Contrast, p.OP_12_Contrast, true);
      await this.#restore(c.OP_F0_SmartContrast, p.OP_F0_SmartContrast, true);
      await this.#restore(c.OP_87_Sharpness, p.OP_87_Sharpness, true);
      await this.#restore(c.OP_10_Luminance, p.OP_10_Luminance, true);
      await this.#restore(c.OP_8A_Saturation, p.OP_8A_Saturation, true);
      await this.#restore(c.OP_90_Hue, p.OP_90_Hue, true);
      await this.#restore(c.EXT_OP_E2A0_24_DLBL, p.EXT_OP_E2A0_24_DLBL, true);
      const subs = new Map([...profile.ModuleSmartImage.SubSmartImages].map(([k, v]) => [k, v.clone()] as const));
      subs.set(dc, c.clone());
      cache.ModuleSmartImage.SubSmartImages = subs;
    } else {
      cache.ModuleSmartImage = profile.ModuleSmartImage.clone();
      const c = cache.ModuleSmartImageHDR.CurSubSmartImage;
      const p = profile.ModuleSmartImageHDR.CurSubSmartImage;
      await this.#restore(c.OP_10_Luminance, p.OP_10_Luminance, true);
      await this.#restore(c.OP_12_Contrast, p.OP_12_Contrast, true);
      await this.#restore(c.EXT_OP_E2A0_3D_LightEnhancement, p.EXT_OP_E2A0_3D_LightEnhancement, true);
      await this.#restore(c.EXT_OP_E2A0_3E_ColorEnhancement, p.EXT_OP_E2A0_3E_ColorEnhancement, true);
      await this.#restore(c.EXT_OP_E2A0_3F_DarkEnhancement, p.EXT_OP_E2A0_3F_DarkEnhancement, true);
      const subs = new Map([...profile.ModuleSmartImageHDR.SubSmartImages].map(([k, v]) => [k, v.clone()] as const));
      subs.set(dc, c.clone());
      cache.ModuleSmartImageHDR.SubSmartImages = subs;
    }
  }

  /** method_12: Ambiglow over DDC without ENE, EffectInfo with ENE (the ENE push is the ambiglow service's). */
  async #restoreEffect(cache: T_PHLDisplay_Profile, profile: T_PHLDisplay_Profile, force: boolean): Promise<void> {
    if (!cache.ENEEffectEnable) {
      cache.EffectInfo = profile.EffectInfo ? profile.EffectInfo.clone() : null;
      if (!force) return;
      cache.ModuleAmbiglow.EffectEnable = profile.ModuleAmbiglow.EffectEnable;
      const mode = cache.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode;
      if (!mode.IsAvailable) {
        this.#log.warn('AmbiglowLightMode not support');
        return;
      }
      const p = profile.ModuleAmbiglow;
      if (p.EffectEnable) {
        if (asInt32(p.EXT_OP_E2A0_19_AmbiglowLightMode.Value) === AMBIGLOW_OFF) p.EXT_OP_E2A0_19_AmbiglowLightMode.Value = AMBIGLOW_STATIC;
        const c = cache.ModuleAmbiglow;
        await this.#restore(mode, p.EXT_OP_E2A0_19_AmbiglowLightMode, true);
        await this.#restore(c.EXT_OP_E2A0_1A_AmbiglowColors, p.EXT_OP_E2A0_1A_AmbiglowColors);
        await this.#restore(c.EXT_OP_E2A0_1B_AmbiglowLightPosition, p.EXT_OP_E2A0_1B_AmbiglowLightPosition);
        await this.#restore(c.EXT_OP_E2A0_1C_AmbiglowLightBrightness, p.EXT_OP_E2A0_1C_AmbiglowLightBrightness);
        await this.#restore(c.EXT_OP_E2A0_1D_AmbiglowLightSpeed, p.EXT_OP_E2A0_1D_AmbiglowLightSpeed);
        await this.#restore(c.EXT_OP_E2A0_1E_AmbiglowLightDirection, p.EXT_OP_E2A0_1E_AmbiglowLightDirection);
      } else {
        const off = mode.clone();
        off.Value = AMBIGLOW_OFF;
        await this.#write(off);
        mode.Value = p.EXT_OP_E2A0_19_AmbiglowLightMode.Value;
        if (asInt32(mode.Value) === AMBIGLOW_OFF) mode.Value = AMBIGLOW_STATIC;
      }
      return;
    }
    if (profile.EffectInfo?.isComplete) cache.EffectInfo = profile.EffectInfo.clone();
  }

  // ───────────────────────────── PHL_* operations ─────────────────────────────

  /** ReloadOSD (PHL/…:559-574): PHL_ReloadData. */
  async reload(): Promise<JsonResult> {
    const r = await this.#op(async () => {
      if (!this.#connected) return error(INVOCATION_FAILED);
      this.#cache = await this.#readAll();
      if (this.#data === null) {
        this.#data = this.#cache.clone();
        this.#recheck(this.#data);
        await this.#save();
      } else {
        await this.#parameterToDevice(this.#data.clone(), false, true);
      }
      return succ(this.#data);
    });
    this.#effectChanged();
    return r;
  }

  /** Full reconnect of this display (GClass3.OnConnect after PHL_SwitchDisplay / a display rescan). */
  async reconnect(): Promise<boolean> {
    const ok = await this.connect();
    await this.#ready;
    return ok;
  }

  /** SetOSD(itemName, iValue) (PHL/…:1622-1656). Tag: the AttributeInfo, or null for an unknown name. */
  async setOsd(itemName: string, value: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const sub = data.IsSmartImageHDR ? data.ModuleSmartImageHDR.CurSubSmartImage : data.ModuleSmartImage.CurSubSmartImage;
      let attr = await this.#setInModule(sub, itemName, value);
      if (attr && attr.IsAvailable) {
        // Vendor quirk kept: always the SDR module, also in HDR (06 §7.2 "Bug (harmless)").
        data.ModuleSmartImage.SubSmartImages.set(asInt32(data.OP_DC_DisplayApplication.Value), data.ModuleSmartImage.CurSubSmartImage);
      }
      for (const module of [data.ModuleGameMode, data.ModuleAmbiglow, data.ModuleInput, data.ModuleAudio, data.ModuleSystem, data.ModuleSetup]) {
        if (attr) break;
        attr = await this.#setInModule(module, itemName, value);
      }
      this.#recheck(data);
      await this.#save();
      return succ(attr);
    });
  }

  /** method_29: find by VCPOpCodeName, write when available. */
  async #setInModule(holder: AttributeHolder, itemName: string, value: number): Promise<AttributeInfo | null> {
    const a = attributeByName(holder, itemName);
    if (a && a.IsAvailable) {
      a.Value = value;
      await this.#write(a);
    }
    return a;
  }

  /** SetSmartImage (PHL/…:1675-1717). Tag {Item1: DC, Item2: the SmartImage(HDR) module}. */
  async setSmartImage(value: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const hdr = data.IsSmartImageHDR;
      const items = hdr ? data.ModuleSmartImageHDR.Items : data.ModuleSmartImage.Items;
      if (items.findIndex((x) => x.Value === value) === -1) return error('SetSmartImage iValue is not valid');
      const dc = data.OP_DC_DisplayApplication;
      if (dc.IsAvailable && asInt32(dc.Value) !== value) {
        dc.Value = value;
        await this.#write(dc);
        await this.#sleep(1000);
        if (hdr) {
          if (value !== HDR_OFF) {
            const m = data.ModuleSmartImageHDR;
            const sub = (m.SubSmartImages.get(value) ?? m.CurSubSmartImage).clone();
            await this.#readModule(sub);
            m.CurSubSmartImage = sub;
            m.SubSmartImages.set(value, sub);
          }
        } else if (value !== SDR_OFF) {
          const m = data.ModuleSmartImage;
          const sub = (m.SubSmartImages.get(value) ?? m.CurSubSmartImage).clone();
          await this.#readModule(sub);
          m.CurSubSmartImage = sub;
          m.SubSmartImages.set(value, sub);
        }
        this.#recheck(data);
        await this.#save();
      } else {
        this.#log.warn(`SetSmartImage ${JSON.stringify(dc.toJson('ui'))}`);
      }
      return succ({ Item1: dc, Item2: hdr ? data.ModuleSmartImageHDR : data.ModuleSmartImage });
    });
  }

  /** ResetSmartImage (PHL/…:1719-1775): E2A042 = reset code, 1000 ms, re-read. */
  async resetSmartImage(value: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const hdr = data.IsSmartImageHDR;
      if ((hdr && value === HDR_OFF) || (!hdr && value === SDR_OFF)) return error('Off Mode Not Support ResetSmartImage');
      const current = asInt32(data.OP_DC_DisplayApplication.Value) === value;
      const reset = this.#global('EXT_OP_E2A0_42_FunctionReset');
      if (!reset.IsAvailable) return error('Not Support ResetSmartImage');
      reset.Value = resetSmartImageValue(value);
      await this.#write(reset);
      await this.#sleep(1000);
      if (hdr) {
        const m = data.ModuleSmartImageHDR;
        if (!current) {
          this.#log.warn('Not Reset Cur SmartImage(0xDC) Value');
          const saved = m.SubSmartImages.get(value);
          if (saved) await this.#readModule(saved);
        } else {
          const sub = m.CurSubSmartImage.clone();
          await this.#readModule(sub);
          m.CurSubSmartImage = sub;
          m.SubSmartImages.set(value, sub);
        }
      } else {
        const m = data.ModuleSmartImage;
        if (current) {
          const sub = m.CurSubSmartImage.clone();
          await this.#readModule(sub);
          m.CurSubSmartImage = sub;
          m.SubSmartImages.set(value, sub);
        } else {
          this.#log.warn('Not Reset Cur SmartImageHDR(0xDC) Value');
          const saved = m.SubSmartImages.get(value);
          if (saved) await this.#readModule(saved);
        }
      }
      this.#recheck(data);
      await this.#save();
      return succ({ Item1: data.OP_DC_DisplayApplication, Item2: hdr ? data.ModuleSmartImageHDR : data.ModuleSmartImage });
    });
  }

  /** SetColorPreset (PHL/…:1777-1806): 0x14 = v; for UserRGB 50 ms then read 16/18/1A. No recheck. */
  async setColorPreset(value: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const sub = data.ModuleSmartImage.CurSubSmartImage;
      const preset = sub.OP_14_SelectColorPreset;
      if (preset.IsAvailable) {
        preset.Value = value;
        await this.#write(preset);
        if (value === PRESET_USER_RGB) {
          await this.#sleep(50);
          for (const a of [sub.OP_16_VideoGainDriveRed, sub.OP_18_VideoGainDriveGreen, sub.OP_1A_VideoGainDriveBlue]) {
            if (a.IsAvailable) await this.#read(a);
          }
        }
        await this.#save();
      }
      return succ(data.ModuleSmartImage);
    });
  }

  /** SwitchSmartFrame (PHL/…:1808-1862): E2A008 = v, 100 ms, poll E2A00A until max 100 (10 × 1000 ms), re-read. */
  async switchSmartFrame(value: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const gm = data.ModuleGameMode;
      const frame = gm.EXT_OP_E2A0_08_SmartFrame;
      if (frame.IsAvailable) {
        frame.Value = value;
        await this.#write(frame);
        await this.#sleep(100);
        const brightness = gm.EXT_OP_E2A0_0A_SmartFrameBrightness;
        if (brightness.IsAvailable) {
          let probe = brightness.clone();
          await this.#read(probe);
          for (let n = 10; probe.MaxValue !== 100 && n > 0; n--) {
            await this.#sleep(1000);
            probe = brightness.clone();
            await this.#read(probe);
          }
        } else {
          this.#log.error('EXT_OP_E2A0_0A_SmartFrameBrightness is null or not available');
        }
        for (const a of [gm.EXT_OP_E2A0_0B_SmartFrameContrast, gm.EXT_OP_E2A0_09_SmartFrameSize, gm.EXT_OP_E2A0_0C_SmartFrameHPosition, gm.EXT_OP_E2A0_0D_SmartFrameVPosition]) {
          await this.#sleep(100);
          if (a.IsAvailable) await this.#read(a);
        }
        await this.#save();
      }
      this.#recheck(data);
      return succ(gm);
    });
  }

  /** SetSmartFrameSize (PHL/…:1864-1886): E2A009 = v, 1000 ms, read 0C, 100 ms, read 0D. No recheck. */
  async setSmartFrameSize(value: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const gm = data.ModuleGameMode;
      const size = gm.EXT_OP_E2A0_09_SmartFrameSize;
      if (size.IsAvailable) {
        size.Value = value;
        await this.#write(size);
        await this.#sleep(1000);
        if (gm.EXT_OP_E2A0_0C_SmartFrameHPosition.IsAvailable) await this.#read(gm.EXT_OP_E2A0_0C_SmartFrameHPosition);
        await this.#sleep(100);
        if (gm.EXT_OP_E2A0_0D_SmartFrameVPosition.IsAvailable) await this.#read(gm.EXT_OP_E2A0_0D_SmartFrameVPosition);
        await this.#save();
      }
      return succ(gm);
    });
  }

  /** SetInputSource (PHL/…:1888-1938): A5, EC, 60 (100 ms apart), then A4 = 0xFFFF. */
  async setInputSource(inputSource: number, pipSource: number, mode: number, size: number, location: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const input = data.ModuleInput;
      const info = input.InputSourceInfo;
      const commit = this.#global('OP_A4_WindowMaskControl');
      const v60 = (inputSource & 0xff) | ((pipSource & 0xff) << 8);
      if ((pipSource !== info.PIPPBPSource || mode !== info.Mode || size !== info.Size || location !== info.Location) && input.OP_A5_WindowSelect.IsAvailable) {
        info.Mode = mode;
        input.OP_A5_WindowSelect.Value = mode;
        await this.#write(input.OP_A5_WindowSelect);
        await this.#sleep(100);
        info.Size = size;
        info.Location = location;
        input.OP_EC_PIPPBPSizeLocation.Value = (size & 0xff) | ((location & 0xff) << 8);
        await this.#write(input.OP_EC_PIPPBPSizeLocation);
        await this.#sleep(100);
        info.InputSource = inputSource;
        info.PIPPBPSource = pipSource;
        input.OP_60_InputSource.Value = v60;
        await this.#write(input.OP_60_InputSource);
        await this.#sleep(100);
        commit.Value = 0xffff;
        await this.#write(commit);
      } else if (asInt32(input.OP_60_InputSource.Value) !== v60) {
        info.InputSource = inputSource;
        info.PIPPBPSource = pipSource;
        input.OP_60_InputSource.Value = v60;
        await this.#write(input.OP_60_InputSource);
        await this.#sleep(100);
        commit.Value = 0xffff;
        await this.#write(commit);
      }
      this.#recheck(data);
      await this.#save();
      return succ(input);
    });
  }

  /** SwrapPIPPBP (PHL/…:1940-1974): only with PIP/PBP on: F6 = 1, 5000 ms, re-read 0x60. */
  async swapPipPbp(): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const input = data.ModuleInput;
      if (input.InputSourceInfo.Mode === 0) return succ(input);
      const swap = this.#global('OP_F6_PIPPBPSwap');
      swap.Value = 1;
      await this.#write(swap);
      await this.#sleep(5000);
      await this.#read(input.OP_60_InputSource);
      this.#splitInputSource(input);
      this.#recheck(data);
      await this.#save();
      return succ(input);
    });
  }

  /** SetAudioEQ (PHL/…:1976-1996): E2A001 = band, 100 ms, E2A039 = gain. No recheck. */
  async setAudioEq(index: number, value: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const item = data.ModuleAudio.EQItems.find((x) => x.Index === index);
      // A missing band dereferences null in the vendor (gClass.MaxValue): the reflection wrapper error.
      if (!item) return error(INVOCATION_FAILED);
      if (value > item.MaxValue) return error(`SetAudioEQ Error index=${index} iValue=${value} MaxValue=${item.MaxValue}`);
      const band = this.#global('EXT_OP_E2A0_01_AudioEQ');
      const gain = this.#global('EXT_OP_E2A0_39_AudioEQGain');
      if (band.IsAvailable && gain.IsAvailable) {
        band.Value = index;
        await this.#write(band);
        await this.#sleep(100);
        item.Value = value;
        gain.Value = value;
        await this.#write(gain);
        await this.#save();
      }
      return succ(data.ModuleAudio);
    });
  }

  /** GetConstraints (PHL/…:2021-2025): Notify() first, then the object (20-backend-host-tail §5 step 13). */
  async getConstraints(): Promise<JsonResult> {
    return this.#withData(async () => {
      this.#notifyConstraints();
      return succ(this.#constraints);
    });
  }

  /** SetGamePQ (PHL/…:2027-2030): dead in 1.13.0, returns ModuleGameMode without I/O. */
  async setGamePQ(): Promise<JsonResult> {
    return this.#withData(async (data) => succ(data.ModuleGameMode));
  }

  /** ProfileAction (PHL/…:2032-2049): E2A06B = ((0xA0|action) << 8) | profile. */
  async profileAction(value: number, action: number): Promise<JsonResult> {
    return this.#withData(async (data) => {
      const attr = data.ModuleSystem.EXT_OP_E2A0_6B_Profile;
      if (!attr.IsAvailable) return error('EXT_OP_E2A0_6B_Profile Unavailable');
      const w = attr.clone();
      const sel = action === 1 ? 161 : action === 2 ? 162 : 160;
      w.Value = ((sel << 8) | value) >>> 0;
      await this.#write(w);
      return succ();
    });
  }

  /** Reset(needSave) (PHL/…:1998-2019): Profile_Reset / Theme_ResetCurProfile / FactoryReset. */
  async reset(needSave = true): Promise<JsonResult> {
    const r = await this.#withData(async (data) => {
      const restore = this.#global('OP_04_RestoreFactoryDefaults');
      if (!restore.IsAvailable) return error('not support rest');
      restore.Value = SWITCH_ON;
      await this.#write(restore);
      // The vendor clears the ENE state here and method_14 re-detects it in the reload below; #readAll
      // asks checkEne the same way (without that hook the last reported model is kept), so the end state
      // is identical (ENEEffectEnable + DisplayEffectInfo.Default when an ENE is present).
      data.EffectInfo = new DisplayEffectInfo();
      await this.#sleep(5000);
      this.#cache = await this.#readAll();
      this.#data = this.#defaultData().clone();
      this.#recheck(this.#data);
      if (needSave) await this.#save();
      return succ(this.#data);
    });
    if (r.err_code === 0) this.#effectChanged();
    return r;
  }

  /** Queue `fn` with the current DeviceData; a display without data answers like the vendor's NRE. */
  async #withData(fn: (data: T_PHLDisplay_Profile) => Promise<JsonResult>): Promise<JsonResult> {
    return this.#op(async () => {
      const data = this.#data;
      if (!data || !this.#connected) return error(INVOCATION_FAILED);
      return fn(data);
    });
  }

  /** Whether the first load finished (DeviceData exists). */
  get loaded(): boolean {
    return this.#loaded && this.#data !== null;
  }
}
