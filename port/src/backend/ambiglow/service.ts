// AmbiglowService (services.ts): the effect half of the vendor's CDevice_PHLDisplay (method_14..17, the
// Effect* members, OnFollowVideo/OnFollowAudio/OnBreathing, EffectEnableTemp), SystemOper's effect functions
// (Effect_*, SyncEffect_*, CheckSoftEffect, EffectEnableTemp) and GlobalOper.CheckIdle, on top of the wave-1
// ENE driver (ene.ts) and the display driver (monitor/display.ts). Specs: 09 (§5-§11, §14), 12 §3.6 and §7,
// 05 §2.6, 20-backend-host-tail §2.4-2.5 and §3 rows 7 and 79-97, 20-enum-valuelist-catalog §6.1-6.4 and §6.6,
// 20-theme-profile-engine §3.7 and §5.5, impl-usb-ene §5, impl-monitor §5.
//
// Two light paths, chosen per display like the vendor (09 §2):
//   ENE    the controller 0cf2:a201 that discovery paired with the monitor (DisplayDevice.ene) is open and its
//          model belongs to the monitor (CUSBENE6K7732.GetModelName): DeviceData.ENEEffectEnable is true and
//          DeviceData.EffectInfo drives the LEDs (ParameterSet, plus frames/levels for FollowVideo/FollowAudio
//          and synced Breathing).
//   DDC    otherwise: the monitor's own Ambiglow over E2A0 19..1E / 38 (ddc-fallback.ts). The mode/colour/…
//          setters are PHL_SetOSD (monitor module); Effect_Enable, Effect_Reset and idle lights-off are here.
//
// Concurrency (never block the event loop; never deadlock with the display's operation queue):
//   - Every sequence that reads or changes DeviceData runs in DisplayDevice.exclusive() (Effect_* functions,
//     the effect push of attach(), idle transitions), so it never interleaves with a PHL_* sequence, a load or
//     a theme switch (20-monitor-io-linux-consolidation §2.4).
//   - ENE open/close (#lifecycle) never waits for the display queue, because checkEne() runs while the display
//     queue is held by a load and takes #lifecycle.
//   - attach() and idle transitions are serialized among themselves (#serial); they may wait for the display
//     queue, which never waits for #serial. stop() never waits for #serial (a queued attach may be waiting for
//     a 20 s load): it stops the engines at once and takes #lifecycle only.
//   - The ENE driver serializes its own register traffic; frame/level producers skip while it is busy.
//
// Deviations are listed in docs/port/impl-ambiglow.md §5.

import type { ApiServices, CoreServices } from '../index.ts';
import type { AmbiglowService, DisplayDevice, MonitorManager, ThemeStore, ThemeSwitchEvent } from '../services.ts';
import type { JsonResult, Logger, UsbBackend, UsbDeviceInfo } from '../types.ts';
import { error, succ } from '../core/envelope.ts';
import { Mutex } from '../core/events.ts';
import { realClock, type DdcClock } from '../ddc/channel.ts';
import { UsbError } from '../usb/errors.ts';
import { isSameEnumeration } from '../usb/ids.ts';
import { LibusbBackend } from '../usb/libusb-backend.ts';
import { INVOCATION_FAILED } from '../monitor/display.ts';
import { DisplayEffectInfo, rgb, type RGB } from '../monitor/model/effect.ts';
import { enumItem, memberOf, type EnumItem } from '../monitor/model/enum-items.ts';
import { asInt32, isJsonObject, member } from '../monitor/model/json-populate.ts';
import { DEVICE_TYPE_DISPLAY, EQUIPMENT_DISPLAY, T_PHLDisplay_Profile } from '../monitor/model/profile.ts';
import { parseDeviceRecord } from '../monitor/model/device-info.ts';
import { bindBaseEffectDetailInfo, syncProfileJson, type BaseEffectDetailInfoModel } from '../theme/formats.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripBom } from '../core/json.ts';
import { EneDevice, findEneDevices } from './ene.ts';
import { EneError, type EneTransportOptions } from './ene-transport.ts';
import { loadAmbiglowInfo, matchEneModelName, type EneModelLayout } from './ene-layout.ts';
import { toEneParameterSet } from './ene-params.ts';
import { ColorDataStore, colorDataPath } from './color-data.ts';
import { EffectMenuCache } from './menu.ts';
import {
  AMBIGLOW_OFF,
  AMBIGLOW_RESET_OP,
  AMBIGLOW_RESET_SETTLE_MS,
  AMBIGLOW_STATIC,
  DisplayOsd,
  readModule,
  writeAttribute,
  writeVerified,
} from './ddc-fallback.ts';
import { FollowVideoEngine } from './follow-video.ts';
import { FollowAudioEngine } from './follow-audio.ts';
import { BreathingEngine, type BreathingDetail } from './breathing.ts';
import { IdleMonitor } from './idle.ts';
import {
  canBreathingSync,
  enableSyncDevices,
  isInEffectSync,
  parseSyncProfile,
  removeSyncDevice,
  syncEffectData,
  type SyncDisplayRef,
} from './sync.ts';
import { realTimers, type EffectTimers } from './timers.ts';

/** Notification_Func.NotifyEffectSyncDevicesChange (20-backend-host-tail §2.4 #5). */
export const NOTIFY_SYNC_DEVICES = 'NotifyEffectSyncDevicesChange';

/** Vendor reply texts (CDevice_PHLDisplay.cs, verbatim). */
export const EffectTexts = {
  notSupportEne: 'Not Support ENE',
  notSupport: 'NotSupport',
  notFollow: 'not ene follow video or audio',
} as const;

/** Effect_CheckDynamicLightingEnabled: the vendor's "no registry value" answer (09 §12, 20-backend-host-tail §3.1). */
export const DYNAMIC_LIGHTING_UNAVAILABLE = -1;

/** How long a lost ENE may take to come back before the display is told it is gone (01 §9 USBChange window). */
export const ENE_LOST_GRACE_MS = 2000;

/**
 * How long a FollowVideo capture session is kept (uploads paused) after the ENE went away, so that a monitor
 * standby or a USB re-enumeration does not cost a new ScreenCast portal dialog on Wayland (impl-ambiglow §5).
 */
export const ENE_AWAY_CAPTURE_MS = 10 * 60_000;

/** Retries of the DDC idle restore (E2A019) that the monitor did not confirm, e.g. still in DPMS standby. */
export const DDC_WAKE_RETRY_MS: readonly number[] = Object.freeze([2000, 5000, 10_000]);

/** stop(): the longest wait for the display queue before the DDC idle restore is left to run on its own. */
export const STOP_RESTORE_TIMEOUT_MS = 3000;

/** EffectType values the service branches on (ENT/EffectType.cs). */
const EFFECT = { FollowVideo: 1, FollowAudio: 2, Breathing: 5 } as const;

export interface AmbiglowServiceOptions {
  /**
   * USB backend for the ENE controller; null = no USB (DDC path only). Default: the simulated bus in mock
   * mode (MonitorManagerImpl.mockHardware), else none with noHardware, else BackendOptions.usb, else a
   * LibusbBackend (one per process is enough; handles are shared module-wide, impl-usb-ene §1.1).
   */
  usb?: UsbBackend | null;
  /** Parsed PCenter_AmbiglowInfo.json (default: loaded from HostServices.resourcesDir). */
  layouts?: readonly EneModelLayout[];
  /** ENE transport options (write pacing, timeout, sleep); tests pass an instant sleep. */
  ene?: Partial<Omit<EneTransportOptions, 'log'>>;
  timers?: EffectTimers;
  /** Clock for the DDC path's driver sleep (Effect_Reset's 200 ms). */
  clock?: DdcClock;
  followVideo?: { captureIntervalMs?: number; sendIntervalMs?: number };
  idleIntervalMs?: number;
  lostGraceMs?: number;
  /** ENE_AWAY_CAPTURE_MS. */
  awayCaptureMs?: number;
  /** DDC_WAKE_RETRY_MS. */
  ddcWakeRetryMs?: readonly number[];
  /** STOP_RESTORE_TIMEOUT_MS. */
  stopRestoreTimeoutMs?: number;
}

/** The concrete display driver's extras (monitor/display.ts PhlDisplay), read duck-typed. */
interface DisplayExtras {
  readonly connected?: boolean;
  /** Vendor string_0: the ENE model the display uses ('' = none). */
  readonly eneModel?: string;
}

/**
 * The DDC Ambiglow this service switched off for idle (EffectEnableTemp(false) without ENE): the display, the
 * mode to restore, whether a restore is outstanding (the wake write was not confirmed), and the retries used.
 */
export interface DdcSuspension {
  readonly key: string;
  mode: number;
  pending: boolean;
  retries: number;
}

/** Convert.ToByte(int) inside the vendor's ToByte(): out of range → 0 (Extension_Byte.cs). */
const toByte = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 255 ? n : 0);

/** EffectType.GetItem() of `effect.Parse<EffectType>()`: an undefined value keeps its number as Name and Text. */
function effectItem(value: number): EnumItem {
  const m = memberOf('EffectType', value);
  return m ? enumItem(m.Name, m.Text, m.Value) : enumItem(String(value), String(value), value);
}

/** DeviceData of a display (the live T_PHLDisplay_Profile), or null before the first load. */
function profileOf(display: DisplayDevice): T_PHLDisplay_Profile | null {
  const p = display.profile();
  return p instanceof T_PHLDisplay_Profile ? p : null;
}

/** The DDC Ambiglow mode DeviceData shows as on (ModuleAmbiglow.EffectEnable and E2A019 not Off), else null. */
function ddcModeOn(data: T_PHLDisplay_Profile): number | null {
  const module = data.ModuleAmbiglow;
  const attr = module.EXT_OP_E2A0_19_AmbiglowLightMode;
  if (!module.EffectEnable || !attr.IsAvailable || attr.Value === null) return null;
  const mode = asInt32(attr.Value);
  return mode === AMBIGLOW_OFF ? null : mode;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class AmbiglowServiceImpl implements AmbiglowService {
  readonly #core: CoreServices;
  readonly #log: Logger;
  readonly #themes: ThemeStore | undefined;
  readonly #monitors: MonitorManager | undefined;
  readonly #opts: AmbiglowServiceOptions;
  readonly #timers: EffectTimers;
  readonly #clock: DdcClock;
  readonly #lifecycle = new Mutex();
  readonly #serial = new Mutex();
  readonly #osd = new DisplayOsd();
  readonly #menus = new EffectMenuCache();
  readonly #colors: ColorDataStore;
  readonly #idle: IdleMonitor;
  readonly #video: FollowVideoEngine;
  readonly #audio: FollowAudioEngine;
  readonly #breathing: BreathingEngine;
  /** ENE model last reported to a display through setEneModel (for displays that do not expose eneModel). */
  readonly #reported = new WeakMap<DisplayDevice, string>();
  /** Enumerations (id#bus.address) whose device is not usable (EneError); not probed again until re-plugged. */
  readonly #rejected = new Set<string>();
  /** `<display key>\n<enumeration>`: an ENE whose model is not that display's; probed again for another display. */
  readonly #mismatched = new Set<string>();
  /** Enumerations whose open failed for lack of permission (warned once; probed again on every reconcile). */
  readonly #accessWarned = new Set<string>();
  #layouts: Promise<readonly EneModelLayout[]> | null = null;
  #deviceRecords: Promise<Map<number, number>> | null = null;
  #ownUsb: UsbBackend | null = null;
  #display: DisplayDevice | null = null;
  #ene: EneDevice | null = null;
  #eneOwner: string | null = null;
  #lostTimer: unknown = null;
  /** Incremented on every ENE loss; a reconcile that started before the last loss says nothing about it. */
  #lostEpoch = 0;
  /** The ENE went away and may come back (keeps a FollowVideo capture session alive, paused). */
  #eneAway = false;
  #awayTimer: unknown = null;
  #ddcSuspension: DdcSuspension | null = null;
  #ddcRetryTimer: unknown = null;
  #lastBreathingSync: boolean | null = null;
  #unsubscribe: (() => void) | null = null;
  #started = false;
  /** stop() ran (and no start() since): a reconcile opens nothing. */
  #stopped = false;

  constructor(core: CoreServices, slots: { themes?: ThemeStore; monitors?: MonitorManager }, options: AmbiglowServiceOptions = {}) {
    this.#core = core;
    this.#log = core.log.child('ambiglow');
    this.#themes = slots.themes;
    this.#monitors = slots.monitors;
    this.#opts = options;
    this.#timers = options.timers ?? realTimers;
    this.#clock = options.clock ?? realClock;
    this.#colors = new ColorDataStore(colorDataPath(core.host.serveDataDir), this.#log);
    const target = () => (this.#display ? this.#eneFor(this.#display) : null);
    this.#video = new FollowVideoEngine({
      log: this.#log.child('video'),
      capture: core.host.capture,
      target,
      timers: this.#timers,
      captureIntervalMs: options.followVideo?.captureIntervalMs,
      sendIntervalMs: options.followVideo?.sendIntervalMs,
    });
    this.#audio = new FollowAudioEngine({ log: this.#log.child('audio'), capture: core.host.capture, target });
    this.#breathing = new BreathingEngine({ log: this.#log.child('breathing'), target, detail: () => this.#syncBreathingDetail(), timers: this.#timers });
    this.#idle = new IdleMonitor({
      log: this.#log,
      softConfig: () => this.#themes?.getSoftConfig() ?? { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 },
      idleSeconds: core.host.getIdleSeconds ? () => core.host.getIdleSeconds?.() ?? 0 : undefined,
      onChange: (idle) => this.#onIdle(idle),
      timers: this.#timers,
      intervalMs: options.idleIntervalMs,
    });
  }

  // ───────────────────────────── BackendService ─────────────────────────────

  async start(): Promise<void> {
    this.#started = true;
    this.#stopped = false;
    void this.#loadLayouts();
    this.#idle.start();
    this.#unsubscribe ??= this.#themes?.onSwitched((e) => this.#onThemeSwitched(e)) ?? null;
    const pending = this.#display;
    if (pending) await this.attach(pending);
  }

  /**
   * Stop the engines and hand the LEDs back to the monitor: ENE UnPlug (0x0023 ← 0), and a DDC Ambiglow switched
   * off for idle is switched on again. Never waits for a queued attach(): an attach that is still running
   * afterwards opens and changes nothing (#stopped, #started).
   */
  async stop(): Promise<void> {
    this.#started = false;
    this.#stopped = true;
    this.#idle.stop();
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#stopEngines();
    this.#cancelLostTimer();
    this.#clearAway();
    this.#cancelDdcRetry();
    await this.#lifecycle.run(() => this.#closeEne());
    await this.#restoreDdcOnStop();
    this.#idle.reset();
  }

  // ───────────────────────────── AmbiglowService ─────────────────────────────

  /**
   * The current display (after its load, reload, profile apply or reset, or an ENE change), or null when no
   * connected display is left. Pairs the display with its ENE (vendor method_14 / method_15 with bUsbChange),
   * reports a changed ENE state to the display (DisplayDevice.setEneModel, which saves and sends
   * NotifyUIDisplayEffectChange), pushes EffectInfo to the ENE (method_12's ENE branch → method_17) and
   * re-evaluates the effect timers (CheckSoftEffect).
   */
  attach(display: DisplayDevice | null): Promise<void> {
    return this.#serial.run(async () => {
      if (display === null) {
        await this.#detach();
        return;
      }
      if (this.#display !== display) {
        await this.#detach(display);
        this.#display = display;
      }
      if (!this.#started) return; // picked up by start()
      await this.#syncDisplay(display);
    });
  }

  /**
   * Vendor method_14 at the top of every full read: open/identify the ENE that belongs to `display` and
   * return its model name ('' = none or unusable). Runs while the display's queue is held (services.ts).
   */
  checkEne(display: DisplayDevice): Promise<string> {
    return this.#reconcile(display);
  }

  // ───────────────────────────── diagnostics / tests ─────────────────────────────

  /** The ENE controller in use, if any. */
  get ene(): EneDevice | null {
    return this.#ene;
  }

  get display(): DisplayDevice | null {
    return this.#display;
  }

  /** GlobalOper.IsIdle. */
  get idle(): boolean {
    return this.#idle.idle;
  }

  get followVideo(): FollowVideoEngine {
    return this.#video;
  }

  get followAudio(): FollowAudioEngine {
    return this.#audio;
  }

  get breathing(): BreathingEngine {
    return this.#breathing;
  }

  /** The DDC Ambiglow switched off for idle and not yet confirmed back on, if any (a copy). */
  get ddcSuspension(): Readonly<DdcSuspension> | null {
    return this.#ddcSuspension ? { ...this.#ddcSuspension } : null;
  }

  /** One CheckIdle poll now (the 1 s timer does the same). */
  checkIdle(): boolean {
    return this.#idle.check();
  }

  /** Resolves once attach() calls and idle transitions queued so far have finished. */
  settled(): Promise<void> {
    return this.#serial.run(async () => undefined);
  }

  // ───────────────────────────── API: driver resolution ─────────────────────────────

  /**
   * SystemOper.smethod_9(device) = GetDeviceByType<IEffect>(device): the display driver for 100000 while it
   * is connected, else null (the caller answers "functionName: X  return null obj"). The monitor-only port
   * has no peripheral effect driver.
   */
  driverFor(device: number): DisplayDevice | null {
    if (device !== DEVICE_TYPE_DISPLAY) return null;
    let current: DisplayDevice | null = null;
    try {
      current = this.#monitors?.current() ?? null;
    } catch {
      return null;
    }
    if (!current) return null;
    return (current as DisplayDevice & DisplayExtras).connected === false ? null : current;
  }

  // ───────────────────────────── API: Effect_* on the display ─────────────────────────────

  /** Effect_GetMenu → GetEffectMenu: DisplayEffectMenu.Default(string_0), cached per model. */
  async getMenu(display: DisplayDevice): Promise<JsonResult> {
    await display.ready();
    return succ(this.#menus.get(await this.#loadLayouts(), this.#eneModelOf(display)));
  }

  /**
   * Effect_GetLEDs → GetEffectLEDs (CDevice_PHLDisplay.cs:1205-1212): the preview mirror in FollowVideo or
   * FollowAudio with ENE, else "not ene follow video or audio". Polled every ~30 ms by the Ambiglow page, so
   * it never waits for the display queue (the vendor's is lock-free too).
   */
  getLeds(display: DisplayDevice): JsonResult {
    const data = profileOf(display);
    const info = data?.EffectInfo ?? null;
    const current = info?.CurrEffect.Value;
    if (!data || !data.ENEEffectEnable || !info || (current !== EFFECT.FollowVideo && current !== EFFECT.FollowAudio)) {
      return error(EffectTexts.notFollow);
    }
    const bytes = this.#eneFor(display)?.ledColors() ?? new Uint8Array(0);
    const leds: RGB[] = [];
    for (let i = 0; i + 2 < bytes.length; i += 3) leds.push(rgb(bytes[i], bytes[i + 1], bytes[i + 2]));
    return succ(leds);
  }

  /**
   * Effect_Enable → CDevice_PHLDisplay.EffectEnable (:954-1008). ENE: EffectInfo.EffectEnable, ParameterSet,
   * save. DDC: E2A019 unavailable → "NotSupport"; else ModuleAmbiglow.EffectEnable, E2A019 = stored mode or
   * AmbiglowOff, recheck + save. Disabling also leaves the light-sync group (CancelEffectSync). Tag: `enable`.
   */
  effectEnable(display: DisplayDevice, enable: boolean): Promise<JsonResult> {
    return this.#op(display, async (data) => {
      if (data.ENEEffectEnable) {
        const info = data.EffectInfo;
        if (!info) return error(INVOCATION_FAILED);
        info.EffectEnable = enable;
        await this.#push(display, data);
        await display.settingsChanged();
      } else {
        const mode = data.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode;
        if (!mode.IsAvailable) return error(EffectTexts.notSupport);
        // The user decided: an idle lights-off of the old state is not to be restored.
        this.#forgetDdcSuspension(display);
        data.ModuleAmbiglow.EffectEnable = enable;
        if (enable) {
          await writeAttribute(display, mode, this.#log);
        } else {
          const off = mode.clone();
          off.Value = AMBIGLOW_OFF;
          await writeAttribute(display, off, this.#log);
        }
        await display.settingsChanged();
      }
      if (!enable) await this.#cancelEffectSync(display, data);
      this.#checkSoftEffect();
      return succ(enable);
    });
  }

  /** Effect_Change: CurrEffect = effect.GetItem(), ParameterSet (+ CheckSoftEffect), sync or save. Tag: EffectInfo. */
  effectChange(display: DisplayDevice, effect: number): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      info.CurrEffect = effectItem(effect);
      return true;
    });
  }

  /** Effect_RandomEnable: EffectDetail.IsRandomColor (not mapped to the ENE, but sent like the vendor). */
  effectRandomEnable(display: DisplayDevice, isRandom: boolean): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      info.EffectDetail.IsRandomColor = isRandom;
      return true;
    });
  }

  /** Effect_RainbowEnable: EffectDetail.IsRainbowColor (the ENE mode's rainbow variant). */
  effectRainbowEnable(display: DisplayDevice, isRainbow: boolean): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      info.EffectDetail.IsRainbowColor = isRainbow;
      return true;
    });
  }

  /** Effect_ColorChange: CurRGB (each component ToByte'd: out of range → 0), rainbow and random off. */
  effectColorChange(display: DisplayDevice, r: number, g: number, b: number): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      const detail = info.EffectDetail;
      detail.CurRGB = rgb(toByte(r), toByte(g), toByte(b));
      // Each EffectDetail access resolves the list entry again, like the vendor's three separate calls.
      info.EffectDetail.IsRainbowColor = false;
      info.EffectDetail.IsRandomColor = false;
      return true;
    });
  }

  /** Effect_BgColorChange: BgRGB (not mapped to the ENE). */
  effectBgColorChange(display: DisplayDevice, r: number, g: number, b: number): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      info.EffectDetail.BgRGB = rgb(toByte(r), toByte(g), toByte(b));
      return true;
    });
  }

  /**
   * Effect_SpeedChange: EffectDetail.Speed; no ParameterSet for FollowVideo/FollowAudio and synced Breathing
   * (vendor :1088-1103 also skips firmware Breathing — deviation, impl-ambiglow §5 item 5).
   */
  effectSpeedChange(display: DisplayDevice, speed: number): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      info.EffectDetail.Speed = speed;
      return !this.#hostDriven(display, info);
    });
  }

  /** Effect_BrightnessChange: EffectDetail.Brightness; same exception as the speed (:1105-1121). */
  effectBrightnessChange(display: DisplayDevice, brightness: number): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      info.EffectDetail.Brightness = brightness;
      return !this.#hostDriven(display, info);
    });
  }

  /** Effect_DirectionChange: EffectDetail.CurDir (never reaches the ENE: direction is not mapped, 09 §5.2). */
  effectDirectionChange(display: DisplayDevice, direction: number): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      info.EffectDetail.CurDir = direction;
      return true;
    });
  }

  /** Effect_RegionChange: EffectDetail.CurRegion (RegionType → Device_sel_E, 09 §5.2). */
  effectRegionChange(display: DisplayDevice, region: number): Promise<JsonResult> {
    return this.#eneEdit(display, (info) => {
      info.EffectDetail.CurRegion = region;
      return true;
    });
  }

  /**
   * Effect_Reset → CDevice_PHLDisplay.EffectReset (:1154-1188): the display leaves the light-sync group and
   * NotifyEffectSyncDevicesChange carries the raw Sync_Profile (null when the profile has none). DDC: E2A038 = 1,
   * 200 ms, re-read E2A019..1E, recheck + save; Tag ModuleAmbiglow. ENE: EffectInfo = Default, ParameterSet,
   * sync or save; Tag EffectInfo.
   */
  effectReset(display: DisplayDevice): Promise<JsonResult> {
    return this.#op(display, async (data) => {
      const raw = this.#themes?.getSyncProfile() ?? null;
      const stored = parseSyncProfile(raw, this.#log);
      if (stored && removeSyncDevice(stored, data.DeviceType, data.ModelName ?? '')) await this.#themes?.setSyncProfile(syncProfileJson(stored));
      this.#core.notifier.notify(NOTIFY_SYNC_DEVICES, stored ? syncProfileJson(stored) : raw);
      if (!data.ENEEffectEnable) {
        const reset = this.#osd.global(display, AMBIGLOW_RESET_OP);
        if (reset.IsAvailable) {
          this.#forgetDdcSuspension(display); // the monitor's reset state wins over an idle lights-off
          reset.Value = 1;
          await writeAttribute(display, reset, this.#log);
          await this.#clock.sleep(AMBIGLOW_RESET_SETTLE_MS);
          const module = data.ModuleAmbiglow;
          await readModule(display, this.#osd, module);
          const mode = module.EXT_OP_E2A0_19_AmbiglowLightMode;
          module.EffectEnable = mode.IsAvailable && asInt32(mode.Value) !== AMBIGLOW_OFF;
          // Deviation: the vendor shows StaticMode whatever mode the reset left; like the load
          // (PHL/…:382-389) only an Off mode is shown as Static here.
          if (!module.EffectEnable) mode.Value = AMBIGLOW_STATIC;
          await display.settingsChanged();
        }
        return succ(data.ModuleAmbiglow);
      }
      data.EffectInfo = DisplayEffectInfo.default(this.#eneModelOf(display));
      await this.#push(display, data);
      await this.#checkEffectSync(display, data);
      await display.settingsChanged();
      this.#checkSoftEffect();
      return succ(data.EffectInfo);
    });
  }

  // ───────────────────────────── API: global effect functions ─────────────────────────────

  /** Effect_GetColorData: Config/color.data, else EffectColorData.DefData(). */
  async getColorData(): Promise<JsonResult> {
    return succ(await this.#colors.get());
  }

  /** Effect_SetSelfColors: store the renderer's custom colour CSV in Config/color.data. */
  async setSelfColors(colors: string): Promise<JsonResult> {
    return succ(await this.#colors.setSelfColors(colors));
  }

  /** SyncEffect_GetData (SystemOper.cs:1518-1533): the normalized Sync_Profile. */
  async syncEffectGetData(): Promise<JsonResult> {
    const stored = parseSyncProfile(this.#themes?.getSyncProfile() ?? null, this.#log);
    const display = this.driverFor(DEVICE_TYPE_DISPLAY);
    const { tag, storedChanged } = syncEffectData(stored, display ? this.#syncRef(display) : null);
    if (storedChanged && stored) await this.#themes?.setSyncProfile(syncProfileJson(stored));
    if (storedChanged) this.#checkSoftEffect();
    return succ(syncProfileJson(tag));
  }

  /** SyncEffect_EnableDevice (SystemOper.cs:1535-1636). */
  async syncEffectEnableDevice(device: number, selDevices: string): Promise<JsonResult> {
    const display = this.driverFor(DEVICE_TYPE_DISPLAY);
    if (display) await display.ready();
    const data = display ? profileOf(display) : null;
    const info = data?.ENEEffectEnable ? data.EffectInfo : null;
    const effectDetail: BaseEffectDetailInfoModel | null = info?.EffectEnable ? bindBaseEffectDetailInfo(info.EffectDetail.toJson()) : null;
    const records = await this.#loadDeviceRecords();
    const outcome = enableSyncDevices({
      device,
      selDevices,
      stored: parseSyncProfile(this.#themes?.getSyncProfile() ?? null, this.#log),
      // ConnectionState(100000); smethod_11 lists the display only on success, where effectDetail != null
      // already implies an effect type other than Default.
      display: display ? this.#displayRef(display) : null,
      effectDetail,
      equipmentTypeOf: (t) => records.get(t),
      log: this.#log,
    });
    if (outcome.storeChanged && outcome.store) await this.#themes?.setSyncProfile(syncProfileJson(outcome.store));
    this.#checkSoftEffect();
    if (outcome.kind === 'error') return error(outcome.nullReference ? INVOCATION_FAILED : (outcome.msg ?? INVOCATION_FAILED));
    return succ(syncProfileJson(outcome.tag));
  }

  // ───────────────────────────── internals: display + ENE ─────────────────────────────

  /** Reconcile the ENE of `display`, report a change, push EffectInfo (or the DDC idle state), update the timers. */
  async #syncDisplay(display: DisplayDevice): Promise<void> {
    const epoch = this.#lostEpoch;
    const model = await this.#reconcile(display);
    if (!this.#started) return; // stop() ran meanwhile: report nothing, push nothing
    const data = profileOf(display);
    if (this.#eneModelOf(display) !== model || (data !== null && data.ENEEffectEnable !== (model !== ''))) {
      this.#log.info(model ? `ENE "${model}" drives the Ambiglow of ${display.monitorName}` : `no ENE for ${display.monitorName}: DDC Ambiglow`);
      this.#reported.set(display, model);
      try {
        await display.setEneModel(model);
      } catch (e) {
        this.#log.warn(`setEneModel failed: ${message(e)}`);
      }
    }
    // An ENE that is back ends the "away" state; one that is still gone keeps it until ENE_AWAY_CAPTURE_MS.
    if (model !== '' && epoch === this.#lostEpoch) this.#clearAway();
    try {
      await display.exclusive(async () => {
        const d = profileOf(display);
        if (!d) return;
        if (d.ENEEffectEnable) await this.#push(display, d);
        else if (this.#idle.idle) await this.#ddcSuspend(display, d);
        else if (this.#ddcSuspension?.key === display.key) await this.#ddcResume(display, d, { resetRetries: true });
      });
    } catch (e) {
      this.#log.warn(`effect apply failed: ${message(e)}`);
    }
    this.#checkSoftEffect();
  }

  /**
   * The display is no longer driven: timers off, ENE released. A DDC idle suspension is kept for its return.
   * `next` (attach of another display object): an ENE that checkEne() already paired with `next` stays open.
   * That is the normal case of a first attach: the load's full read opened and identified the ENE (method_14)
   * just before its onEffectInfoChanged hook attaches the display, and closing it here made #syncDisplay open
   * and identify the same device again (a second USB open and ~15 identification reads per attach, seen in
   * the e2e walkthrough's backend log). #syncDisplay's reconcile re-validates the kept handle (lost,
   * re-enumerated, owner) and host control is only taken by its push.
   */
  async #detach(next: DisplayDevice | null = null): Promise<void> {
    this.#stopEngines();
    this.#cancelLostTimer();
    this.#clearAway();
    this.#cancelDdcRetry();
    this.#display = null;
    await this.#lifecycle.run(async () => {
      if (next !== null && this.#ene !== null && this.#eneOwner === next.key) return;
      await this.#closeEne();
    });
  }

  /**
   * Pair `display` with its ENE controller (impl-usb-ene §5 reconcile): drop a held device that is closed,
   * lost, re-enumerated or belongs to another display; open the one discovery paired with the display; check
   * the model against the monitor (CUSBENE6K7732.GetModelName). Returns the model string, '' for none.
   * An ENE that drove this display and is gone now without a failed operation (a USB change: monitor standby,
   * KVM switch) counts as away, like a lost handle (FollowVideo keeps its capture session, §4.2).
   */
  #reconcile(display: DisplayDevice): Promise<string> {
    return this.#lifecycle.run(async () => {
      if (this.#stopped) {
        // Shutting down: open nothing, report no change (the display keeps its last model).
        await this.#closeEne();
        return this.#eneModelOf(display);
      }
      const held = this.#ene;
      const drove = held !== null && this.#eneOwner === display.key && !held.closed && !held.lost;
      const model = await this.#pair(display);
      if (model === '' && drove && this.#started) this.#markAway();
      return model;
    });
  }

  /** The body of #reconcile (inside #lifecycle). */
  async #pair(display: DisplayDevice): Promise<string> {
    const usb = this.#usbBackend();
    const target = display.ene;
    let present: UsbDeviceInfo[] = [];
    if (usb) {
      try {
        present = await findEneDevices(usb);
      } catch (e) {
        this.#log.warn(`ENE enumeration failed: ${message(e)}`);
      }
    }
    if (present.length > 0) this.#pruneProbeState(present);
    const held = this.#ene;
    if (held) {
      // An empty enumeration may be a failed one (LibusbBackend.list() answers [] when libusb's device list
      // fails): a held device that is not known to be lost is kept. If it is really gone, its next operation
      // fails with no-device, which marks it lost and schedules the re-check (onLost).
      const current = held.isCurrent(present) || (present.length === 0 && !held.lost && !held.closed);
      const keep = target !== undefined && this.#eneOwner === display.key && held.info.id === target.id && current;
      if (!keep) await this.#closeEne();
    }
    if (!usb || !target) return '';
    if (!this.#ene) {
      const info = present.find((p) => isSameEnumeration(p, target)) ?? present.find((p) => p.id === target.id);
      if (!info) return '';
      const key = enumerationKey(info);
      if (this.#rejected.has(key) || this.#mismatched.has(mismatchKey(display, key))) return '';
      try {
        this.#ene = await EneDevice.open(usb, info, {
          log: this.#log.child('ene'),
          layouts: await this.#loadLayouts(),
          onLost: (d) => this.#handleLost(d),
          ...this.#opts.ene,
        });
        this.#eneOwner = display.key;
        this.#accessWarned.delete(key);
      } catch (e) {
        if (e instanceof EneError) {
          // The device itself is unusable (not-ene, invalid-firmware, unsupported-model): until re-plugged.
          this.#rejected.add(key);
          this.#log.warn(`ENE ${info.id} not usable, the Ambiglow uses DDC/CI: ${message(e)}`);
        } else if (e instanceof UsbError && e.code === 'access') {
          // Missing udev rule: probed again at every reconcile (after "udevadm trigger" the device does not
          // re-enumerate), warned once per enumeration.
          if (this.#accessWarned.has(key)) this.#log.debug(`ENE ${info.id}: still no permission`);
          else this.#log.warn(`ENE ${info.id} not usable, the Ambiglow uses DDC/CI: ${message(e)}`);
          this.#accessWarned.add(key);
        } else {
          this.#log.warn(`ENE ${info.id} not usable now, the Ambiglow uses DDC/CI: ${message(e)}`);
        }
        return '';
      }
    }
    const ene = this.#ene;
    const model = matchEneModelName(display.monitorName, [ene.modelName]);
    if (model === undefined) {
      this.#log.warn(`ENE ${ene.info.id} reports model "${ene.modelName}", which is not "${display.monitorName}"; not used for this display`);
      this.#mismatched.add(mismatchKey(display, enumerationKey(ene.info)));
      await this.#closeEne();
      return '';
    }
    return model;
  }

  /** Forget probe results of enumerations that are gone (a re-plug is a new enumeration, probed afresh). */
  #pruneProbeState(present: readonly UsbDeviceInfo[]): void {
    const keys = new Set(present.map(enumerationKey));
    for (const key of [...this.#rejected]) if (!keys.has(key)) this.#rejected.delete(key);
    for (const key of [...this.#accessWarned]) if (!keys.has(key)) this.#accessWarned.delete(key);
    for (const key of [...this.#mismatched]) if (!keys.has(key.slice(key.indexOf('\n') + 1))) this.#mismatched.delete(key);
  }

  /** Close the held ENE; hand the LEDs back (0x0023 ← 0) only if this driver holds host control. Inside #lifecycle. */
  async #closeEne(): Promise<void> {
    const ene = this.#ene;
    this.#ene = null;
    this.#eneOwner = null;
    if (!ene) return;
    try {
      await ene.close({ release: ene.hostControl && !ene.lost });
    } catch (e) {
      this.#log.debug(`ENE close: ${message(e)}`);
    }
  }

  /** EneDeviceOptions.onLost: the handle died; re-check after the USB-change window (the ENE may come back). */
  #handleLost(device: EneDevice): void {
    if (device !== this.#ene || !this.#started) return;
    this.#lostEpoch++;
    this.#markAway();
    if (this.#lostTimer === null) {
      const grace = this.#opts.lostGraceMs ?? ENE_LOST_GRACE_MS;
      this.#log.info(`ENE ${device.info.id} went away; checking again in ${grace} ms`);
      this.#lostTimer = this.#timers.setTimeout(() => {
        this.#lostTimer = null;
        const display = this.#display;
        if (display) this.attach(display).catch((e: unknown) => this.#log.warn(`ENE re-check failed: ${message(e)}`));
      }, grace);
    }
    this.#checkSoftEffect();
  }

  #cancelLostTimer(): void {
    if (this.#lostTimer !== null) this.#timers.clearTimeout(this.#lostTimer);
    this.#lostTimer = null;
  }

  /** The ENE went away: a FollowVideo capture session is kept (paused) for ENE_AWAY_CAPTURE_MS. */
  #markAway(): void {
    this.#eneAway = true;
    if (this.#awayTimer !== null) this.#timers.clearTimeout(this.#awayTimer);
    this.#awayTimer = this.#timers.setTimeout(() => {
      this.#awayTimer = null;
      this.#eneAway = false;
      this.#checkSoftEffect();
    }, this.#opts.awayCaptureMs ?? ENE_AWAY_CAPTURE_MS);
  }

  #clearAway(): void {
    this.#eneAway = false;
    if (this.#awayTimer !== null) this.#timers.clearTimeout(this.#awayTimer);
    this.#awayTimer = null;
  }

  /** The open ENE of `display`, if usable. */
  #eneFor(display: DisplayDevice): EneDevice | null {
    const ene = this.#ene;
    if (!ene || this.#eneOwner !== display.key || ene.closed || ene.lost) return null;
    return ene;
  }

  /** Vendor string_0 / bool_2 of the display: the ENE model in use ('' = none). */
  #eneModelOf(display: DisplayDevice): string {
    const model = (display as DisplayDevice & DisplayExtras).eneModel;
    return typeof model === 'string' ? model : (this.#reported.get(display) ?? '');
  }

  /**
   * The ENE's USB backend: AmbiglowServiceOptions.usb when given; in mock mode the simulated bus (a mock
   * monitor wins over noHardware); none with noHardware, even when BackendOptions.usb is set (compose.ts
   * semantics, impl-integration §2.1); else BackendOptions.usb, else an own LibusbBackend.
   */
  #usbBackend(): UsbBackend | null {
    if (this.#opts.usb !== undefined) return this.#opts.usb;
    const o = this.#core.options;
    if (o.mockMonitor) {
      const hw = (this.#monitors as { mockHardware?: { usb?: UsbBackend } | null } | undefined)?.mockHardware;
      return hw?.usb ?? null;
    }
    if (o.noHardware) return null;
    if (o.usb) return o.usb;
    this.#ownUsb ??= new LibusbBackend({ log: this.#log.child('usb') });
    return this.#ownUsb;
  }

  #loadLayouts(): Promise<readonly EneModelLayout[]> {
    this.#layouts ??= this.#opts.layouts
      ? Promise.resolve(this.#opts.layouts)
      : loadAmbiglowInfo(this.#core.host.resourcesDir, this.#log).then((l) => {
          this.#menus.clear();
          return l;
        });
    return this.#layouts;
  }

  /** DictMgr.GetDeviceInfoItem(type).EquipmentType for every PCenter_DeviceInfo.json record (display: 1 built in). */
  #loadDeviceRecords(): Promise<Map<number, number>> {
    this.#deviceRecords ??= (async () => {
      const map = new Map<number, number>([[DEVICE_TYPE_DISPLAY, EQUIPMENT_DISPLAY]]);
      const path = join(this.#core.host.resourcesDir, 'PCenter_DeviceInfo.json');
      try {
        const json: unknown = JSON.parse(stripBom(await readFile(path, 'utf8')));
        const records = isJsonObject(json) ? member(json, 'RECORDS') : undefined;
        if (Array.isArray(records)) {
          for (const r of records.filter(isJsonObject).map(parseDeviceRecord)) map.set(r.DeviceType, r.EquipmentType);
        }
      } catch (e) {
        this.#log.debug(`${path}: ${message(e)}`);
      }
      return map;
    })();
    return this.#deviceRecords;
  }

  // ───────────────────────────── internals: effects ─────────────────────────────

  /** A Bridge call on the display's DeviceData, in its operation queue; no DeviceData = the vendor's NRE. */
  #op(display: DisplayDevice, fn: (data: T_PHLDisplay_Profile) => Promise<JsonResult>): Promise<JsonResult> {
    return display.exclusive(async () => {
      const data = profileOf(display);
      if (!data) return error(INVOCATION_FAILED);
      return fn(data);
    });
  }

  /**
   * The ENE-only Effect_* setters (CDevice_PHLDisplay.cs:1010-1152): "Not Support ENE" unless the display
   * uses an ENE (bool_2); `edit` changes EffectInfo and says whether to re-send ParameterSet (method_17 with
   * bool_4 false, i.e. without CheckSoftEffect — the port re-evaluates the timers anyway, which is
   * idempotent); then CheckEffectSync, else SaveProfile. Tag: EffectInfo.
   */
  #eneEdit(display: DisplayDevice, edit: (info: DisplayEffectInfo) => boolean): Promise<JsonResult> {
    return this.#op(display, async (data) => {
      if (this.#eneModelOf(display) === '') return error(EffectTexts.notSupportEne);
      const info = data.EffectInfo;
      if (!info) return error(INVOCATION_FAILED);
      if (edit(info)) await this.#push(display, data);
      await this.#checkEffectSync(display, data);
      await display.settingsChanged();
      this.#checkSoftEffect();
      return succ(data.EffectInfo);
    });
  }

  /**
   * Effects whose live speed/brightness changes the ENE does not take from a ParameterSet: FollowVideo and
   * FollowAudio (vendor :1088-1121) and the host-driven synced Breathing (mode 14, the curve reads
   * Sync_Profile). Deviation: the vendor also skips firmware Breathing (mode 7), whose speed and brightness
   * then never reach the LEDs until the effect is selected again (09 §16 quirk 4).
   */
  #hostDriven(display: DisplayDevice, info: DisplayEffectInfo): boolean {
    const v = info.CurrEffect.Value;
    if (v === EFFECT.FollowVideo || v === EFFECT.FollowAudio) return true;
    return v === EFFECT.Breathing && this.#canBreathingSync(display);
  }

  /**
   * CDevice_PHLDisplay.method_17: EffectInfo → ParameterSet (MapTMain_ParameterSet + the Breathing sync
   * choice), sent once. While idle the effect only becomes the ENE's requested state and the LEDs stay dark
   * (EneDevice.setEffect { suspended }): a profile switch, reload or re-open during idle is shown on wake.
   */
  async #push(display: DisplayDevice, data: T_PHLDisplay_Profile): Promise<void> {
    const info = data.EffectInfo;
    const ene = this.#eneFor(display);
    if (!info || !ene) return;
    const breathingSync = this.#canBreathingSync(display);
    this.#lastBreathingSync = info.CurrEffect.Value === EFFECT.Breathing ? breathingSync : null;
    try {
      await ene.setEffect(toEneParameterSet(info, { breathingSync }), { suspended: this.#idle.idle });
    } catch (e) {
      this.#log.warn(`ENE ParameterSet failed: ${message(e)}`);
    }
  }

  /**
   * CheckEffectSync → NotityEffectSync (CDeviceEffectBase.cs): while the display is marked in sync, the
   * group's EffectDetailInfo follows the display's and Effect_Sync is raised (every other connected device
   * adopts it — none in the monitor-only port — and the profile is saved).
   */
  async #checkEffectSync(display: DisplayDevice, data: T_PHLDisplay_Profile): Promise<boolean> {
    const stored = parseSyncProfile(this.#themes?.getSyncProfile() ?? null, this.#log);
    if (!stored || !data.EffectInfo || !isInEffectSync(stored, this.#displayRef(display))) return false;
    stored.EffectDetailInfo = bindBaseEffectDetailInfo(data.EffectInfo.EffectDetail.toJson());
    await this.#themes?.setSyncProfile(syncProfileJson(stored));
    return true;
  }

  /** CancelEffectSync: leave the light-sync group (Effect_Enable(false)). */
  async #cancelEffectSync(display: DisplayDevice, data: T_PHLDisplay_Profile): Promise<void> {
    const stored = parseSyncProfile(this.#themes?.getSyncProfile() ?? null, this.#log);
    if (!stored || !stored.SyncDevices.some((d) => d?.DeviceType === data.DeviceType)) return;
    if (removeSyncDevice(stored, DEVICE_TYPE_DISPLAY, display.monitorName)) await this.#themes?.setSyncProfile(syncProfileJson(stored));
  }

  /** CDevice_PHLDisplay.GetDeviceInfo as the sync code sees it. */
  #displayRef(display: DisplayDevice): SyncDisplayRef {
    return { EquipmentType: EQUIPMENT_DISPLAY, DeviceType: DEVICE_TYPE_DISPLAY, ModelName: display.monitorName };
  }

  /** The display for smethod_11: connected with an effect type other than Default (ENE in use), else null. */
  #syncRef(display: DisplayDevice): SyncDisplayRef | null {
    const data = profileOf(display);
    return data && data.ENEEffectEnable && data.EffectInfo ? this.#displayRef(display) : null;
  }

  #canBreathingSync(display: DisplayDevice): boolean {
    return canBreathingSync(parseSyncProfile(this.#themes?.getSyncProfile() ?? null), this.#displayRef(display));
  }

  #syncBreathingDetail(): BreathingDetail | null {
    const d = parseSyncProfile(this.#themes?.getSyncProfile() ?? null)?.EffectDetailInfo ?? null;
    return d ? { Speed: d.Speed, Brightness: d.Brightness, IsRainbowColor: d.IsRainbowColor, CurRGB: d.CurRGB } : null;
  }

  /**
   * SystemOper.CheckSoftEffect for the display: FollowAudio and synced-Breathing timers run while the ENE drives
   * an enabled effect of that type and the user is not idle ("active"). FollowVideo splits the capture session
   * from the uploads (follow-video.ts): the session starts only when active, is kept while idle and while a lost
   * ENE may come back, and stops when FollowVideo is no longer the enabled effect, the display is detached or
   * the service stops; the uploads run only when active. `wake` gives a failed capture start one more try.
   * A Breathing effect whose sync state changed gets its ParameterSet again (mode 14 ↔ 7, OnBreathing's bool_3).
   */
  #checkSoftEffect(options: { wake?: boolean } = {}): void {
    const display = this.#display;
    const data = display ? profileOf(display) : null;
    const ene = display ? this.#eneFor(display) : null;
    const info = data?.EffectInfo ?? null;
    const eneMode = data?.ENEEffectEnable === true;
    const effect = info?.CurrEffect.Value;
    const enabled = this.#started && display !== null && info !== null && info.EffectEnable;
    const active = enabled && eneMode && ene !== null && !this.#idle.idle;
    const followVideo = enabled && effect === EFFECT.FollowVideo && ((eneMode && ene !== null) || this.#eneAway);
    if (!followVideo) this.#video.setWanted(false);
    else if (active) this.#video.setWanted(true, { retry: options.wake === true });
    this.#video.setPaused(!active);
    this.#audio.setWanted(active && effect === EFFECT.FollowAudio);
    const canSync = display !== null && effect === EFFECT.Breathing && this.#canBreathingSync(display);
    this.#breathing.setWanted(active && canSync);
    if (display && active && effect === EFFECT.Breathing && this.#lastBreathingSync !== null && this.#lastBreathingSync !== canSync) {
      this.#lastBreathingSync = canSync;
      display
        .exclusive(async () => {
          // Re-read: a reload, apply or reset may have replaced DeviceData meanwhile (OnBreathing reads it live).
          const d = profileOf(display);
          const i = d?.ENEEffectEnable ? d.EffectInfo : null;
          if (!d || !i || !i.EffectEnable || i.CurrEffect.Value !== EFFECT.Breathing) return;
          await this.#push(display, d);
        })
        .catch((e: unknown) => this.#log.warn(`breathing mode switch failed: ${message(e)}`));
    }
  }

  #stopEngines(): void {
    this.#video.setWanted(false);
    this.#audio.setWanted(false);
    this.#breathing.setWanted(false);
  }

  /** ThemeStore.onSwitched: Sync_Profile (breathing sync) and, through the display's post-apply hook, DeviceData changed. */
  #onThemeSwitched(e: ThemeSwitchEvent): void {
    this.#log.debug(`theme ${e.reason}: re-evaluating the effect timers`);
    const s = this.#ddcSuspension;
    const display = this.#display;
    if (s && display && display.key === s.key) {
      // The switch wrote the new profile's Ambiglow to the monitor (method_12). An Ambiglow it switches on is
      // what idle suspends from now on (the attach that follows switches it off again while idle); one it
      // switches off is not to be restored.
      const data = profileOf(display);
      const mode = data && !data.ENEEffectEnable ? ddcModeOn(data) : null;
      if (mode !== null && (this.#idle.idle || s.pending)) s.mode = mode;
      else this.#forgetDdcSuspension(display);
    }
    this.#checkSoftEffect();
  }

  /**
   * EVT_Effect.EffectEnableTemp (SystemOper.cs:1481-1502 → CDevice_PHLDisplay.EffectEnableTemp :954-972):
   * idle → timers off, then the lights; wake → the lights, then the timers.
   */
  #onIdle(idle: boolean): void {
    this.#serial
      .run(async () => {
        if (idle) this.#checkSoftEffect();
        const display = this.#display;
        if (display) {
          await display.exclusive(async () => {
            const data = profileOf(display);
            if (!data) return;
            if (!data.ENEEffectEnable) {
              if (idle) await this.#ddcSuspend(display, data);
              else await this.#ddcResume(display, data, { resetRetries: true });
              return;
            }
            const ene = this.#eneFor(display);
            if (!ene) return;
            try {
              // The driver acts only on a requested effect that is on (lightsOff) or suspended (lightsOn): the
              // vendor's EffectInfo.EffectEnable test, also for a push recorded while idle.
              if (idle) await ene.lightsOff();
              else await ene.lightsOn();
            } catch (e) {
              this.#log.warn(`ENE ${idle ? 'lights off' : 'lights on'} failed: ${message(e)}`);
            }
          });
        }
        if (!idle) this.#checkSoftEffect({ wake: true });
      })
      .catch((e: unknown) => this.#log.warn(`EffectEnableTemp failed: ${message(e)}`));
  }

  // ───────────────────────────── internals: DDC idle lights-off ─────────────────────────────

  /**
   * EffectEnableTemp(false) without ENE: E2A019 ← AmbiglowOff, remembering the mode that was on.
   * Deviation: only while the user's Ambiglow is on (ModuleAmbiglow.EffectEnable). The vendor tests only
   * the stored mode, which is StaticMode even when Ambiglow is off (the load shows Off as Static), so every
   * wake switched a disabled Ambiglow on in Static mode. A DeviceData that shows Off (a load or reload during
   * idle read back this Off) keeps the earlier record.
   */
  async #ddcSuspend(display: DisplayDevice, data: T_PHLDisplay_Profile): Promise<void> {
    const mode = ddcModeOn(data);
    if (mode === null) return;
    this.#cancelDdcRetry();
    this.#ddcSuspension = { key: display.key, mode, pending: false, retries: 0 };
    const off = data.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.clone();
    off.Value = AMBIGLOW_OFF;
    await writeAttribute(display, off, this.#log);
  }

  /**
   * EffectEnableTemp(true) without ENE, and the outstanding restore at an attach: E2A019 back to the mode
   * that was on. DeviceData decides while it shows the Ambiglow on (the vendor writes its mode; PHL_SetOSD may
   * have changed it meanwhile). While it shows Off although this service switched the Ambiglow off for idle,
   * that Off is the monitor's answer to a load or reload during idle: DeviceData gets the suspended state back
   * and is saved, else the profile would keep Ambiglow disabled. Port addition: the write is verified by a
   * read-back; one the monitor did not take (still coming out of DPMS standby) is retried (DDC_WAKE_RETRY_MS)
   * and tried again at the next attach (the reload after the monitor is back). In the display's queue.
   */
  async #ddcResume(display: DisplayDevice, data: T_PHLDisplay_Profile, options: { resetRetries?: boolean } = {}): Promise<void> {
    const s = this.#ddcSuspension;
    const attr = data.ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode;
    if (!s || s.key !== display.key) {
      // Nothing of ours to undo (idle began before this display was driven): the vendor's single write.
      if (ddcModeOn(data) !== null) await writeAttribute(display, attr, this.#log);
      return;
    }
    if (!attr.IsAvailable) {
      this.#forgetDdcSuspension(display);
      return;
    }
    let mode = ddcModeOn(data);
    const restored = mode === null;
    if (mode === null) {
      mode = s.mode;
      data.ModuleAmbiglow.EffectEnable = true;
      attr.Value = mode;
    }
    s.mode = mode;
    if (options.resetRetries) s.retries = 0;
    this.#cancelDdcRetry();
    const w = attr.clone();
    w.Value = mode;
    const ok = await writeVerified(display, w, this.#log);
    if (restored) {
      this.#log.info(`DDC Ambiglow: mode ${mode} restored after idle (the monitor had reported the idle Off)`);
      await display.settingsChanged();
    }
    if (ok) {
      if (this.#ddcSuspension === s) this.#ddcSuspension = null;
      return;
    }
    s.pending = true;
    this.#scheduleDdcRetry(display, s);
  }

  #scheduleDdcRetry(display: DisplayDevice, s: DdcSuspension): void {
    if (!this.#started || this.#ddcRetryTimer !== null) return;
    const delays = this.#opts.ddcWakeRetryMs ?? DDC_WAKE_RETRY_MS;
    if (s.retries >= delays.length) {
      this.#log.warn(`DDC Ambiglow restore after idle not confirmed by ${display.monitorName}; trying again at its next load`);
      return;
    }
    const delay = delays[s.retries++];
    this.#ddcRetryTimer = this.#timers.setTimeout(() => {
      this.#ddcRetryTimer = null;
      if (!this.#started || this.#idle.idle || this.#display !== display || this.#ddcSuspension !== s) return;
      this.#serial
        .run(() =>
          display.exclusive(async () => {
            const data = profileOf(display);
            if (!data || data.ENEEffectEnable || this.#idle.idle || this.#ddcSuspension !== s) return;
            await this.#ddcResume(display, data);
          }),
        )
        .catch((e: unknown) => this.#log.warn(`DDC Ambiglow restore failed: ${message(e)}`));
    }, delay);
  }

  #cancelDdcRetry(): void {
    if (this.#ddcRetryTimer !== null) this.#timers.clearTimeout(this.#ddcRetryTimer);
    this.#ddcRetryTimer = null;
  }

  /** Drop the idle suspension of `display` (the user or a profile decided the Ambiglow state). */
  #forgetDdcSuspension(display: DisplayDevice): void {
    if (this.#ddcSuspension?.key !== display.key) return;
    this.#ddcSuspension = null;
    this.#cancelDdcRetry();
  }

  /** stop(): switch a DDC Ambiglow that idle switched off on again (one verified write, bounded wait). */
  async #restoreDdcOnStop(): Promise<void> {
    const s = this.#ddcSuspension;
    const display = this.#display;
    if (!s || !display || display.key !== s.key) return;
    const work = display
      .exclusive(async () => {
        const data = profileOf(display);
        if (data && !data.ENEEffectEnable) await this.#ddcResume(display, data);
      })
      .catch((e: unknown) => this.#log.warn(`DDC Ambiglow restore at stop failed: ${message(e)}`));
    let timer: unknown = null;
    const bound = new Promise<void>((resolve) => {
      timer = this.#timers.setTimeout(() => {
        this.#log.warn('DDC Ambiglow restore at stop: the display is busy; it follows when the display is free');
        resolve();
      }, this.#opts.stopRestoreTimeoutMs ?? STOP_RESTORE_TIMEOUT_MS);
    });
    await Promise.race([work, bound]);
    this.#timers.clearTimeout(timer);
  }
}

function enumerationKey(info: UsbDeviceInfo): string {
  return `${info.id}#${info.busNumber}.${info.deviceAddress}`;
}

function mismatchKey(display: DisplayDevice, enumeration: string): string {
  return `${display.key}\n${enumeration}`;
}

/** Composition-root factory (index.ts ServiceSlots.ambiglow). */
export function createAmbiglowService(
  core: CoreServices,
  slots: { themes?: ThemeStore; monitors?: MonitorManager },
  options?: AmbiglowServiceOptions,
): AmbiglowServiceImpl {
  return new AmbiglowServiceImpl(core, slots, options);
}

/** What api/effect.ts and api/sync-effect.ts call: the Bridge-facing surface of the service. */
export type AmbiglowEngine = Pick<
  AmbiglowServiceImpl,
  | 'driverFor'
  | 'getMenu'
  | 'getLeds'
  | 'effectEnable'
  | 'effectChange'
  | 'effectRandomEnable'
  | 'effectRainbowEnable'
  | 'effectColorChange'
  | 'effectBgColorChange'
  | 'effectSpeedChange'
  | 'effectBrightnessChange'
  | 'effectDirectionChange'
  | 'effectRegionChange'
  | 'effectReset'
  | 'getColorData'
  | 'setSelfColors'
  | 'syncEffectGetData'
  | 'syncEffectEnableDevice'
>;

const ENGINE_METHODS: readonly (keyof AmbiglowEngine)[] = [
  'driverFor',
  'getMenu',
  'getLeds',
  'effectEnable',
  'effectChange',
  'effectRandomEnable',
  'effectRainbowEnable',
  'effectColorChange',
  'effectBgColorChange',
  'effectSpeedChange',
  'effectBrightnessChange',
  'effectDirectionChange',
  'effectRegionChange',
  'effectReset',
  'getColorData',
  'setSelfColors',
  'syncEffectGetData',
  'syncEffectEnableDevice',
];

function isAmbiglowEngine(x: unknown): x is AmbiglowEngine {
  if ((typeof x !== 'object' && typeof x !== 'function') || x === null) return false;
  const o = x as Record<string, unknown>;
  return ENGINE_METHODS.every((m) => typeof o[m] === 'function');
}

const fallbackEngines = new WeakMap<object, AmbiglowServiceImpl>();

/**
 * The engine the api/ modules call: services.ambiglow when it is this implementation or delegates its whole
 * Bridge-facing surface (AmbiglowEngine). Only a composition without any ambiglow service gets a detached
 * engine over the same theme store and monitor manager, which uses no USB (DDC path only) and runs no timers.
 * An ambiglow service that is neither (a partial stand-in) is an integration error: logged once, and the
 * detached engine answers, so Effect_* never reach an ENE.
 */
export function ambiglowEngineFor(services: ApiServices): AmbiglowEngine {
  const own = services.ambiglow;
  if (own instanceof AmbiglowServiceImpl) return own;
  if (own !== undefined && isAmbiglowEngine(own)) return own;
  let engine = fallbackEngines.get(services);
  if (!engine) {
    if (own !== undefined) {
      services.log
        .child('ambiglow')
        .error('services.ambiglow does not implement the Effect_* engine (AmbiglowEngine); Effect_* run on a detached DDC-only engine and never reach the ENE');
    }
    engine = new AmbiglowServiceImpl(services, { themes: services.themes, monitors: services.monitors }, { usb: null });
    fallbackEngines.set(services, engine);
  }
  return engine;
}
