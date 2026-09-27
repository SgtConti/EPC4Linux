// Contracts between the wave-2 services (theme/, monitor/, ambiglow/) and the api/ modules.
// The composition root (index.ts ServiceSlots) holds one instance of each. Type-only file.
//
// Vendor model (docs/re/20-theme-profile-engine.md §1): SystemOper keeps the CURRENT theme and the
// CURRENT profile (T_Theme_Profile) in memory. Every device driver (IProfile / GClass0) serializes its
// state into that profile ("PurifyProfile") and the profile file is rewritten after each setting change
// and after each device scan (§8). Switching theme/profile applies the stored section back to the
// devices (§5.5). Here the theme store owns files + current profile; drivers are ProfileParticipants.

import type { BackendService } from './index.ts';
import type { DdcChannel, DiscoveredMonitor, UsbDeviceInfo } from './types.ts';

// ───────────────────────────── Theme / profile store (theme/) ─────────────────────────────

/** T_DeviceProfile_Base (EN/T_DeviceProfile_Base.cs) — identifies a device section inside a profile. */
export interface DeviceProfileDesc {
  EquipmentType: number;
  DeviceType: number;
  /** Exact, case-sensitive model name, e.g. "PHL 34M2C8600" (20-theme §5.5, §10). */
  ModelName: string;
  ExtModel: string | null;
}

/** A device driver that takes part in theme/profile persistence (vendor IProfile). */
export interface ProfileParticipant {
  readonly desc: DeviceProfileDesc;
  /**
   * PurifyProfile: the device's current settings as the nested ProfileContent JSON string
   * (serialized in 'profile' mode — core/json.ts), exactly as the vendor writes it.
   */
  purify(): string;
  /**
   * Apply a stored ProfileContent after a theme/profile switch, Theme_ApplyProfile or import
   * (20-theme §5.5: for the display only the SmartImage/HDR group and Ambiglow are re-applied).
   * `content` is null when the target profile has no section for this device.
   * (Appended by theme/.) The store bounds each call (default 60 s): a call that has not settled by then
   * is logged ("ParameterToDevice Error") and the operation completes without it. The call may await any
   * ThemeStore mutator (they never wait for the running operation).
   */
  applyProfileContent(content: string | null): Promise<void>;
  /**
   * Device part of Theme_ResetCurProfile / FactoryReset (display: VCP 0x04=1, sleep 5 s, re-read — 20-theme §6-7).
   * (Appended by theme/.) Bounded like applyProfileContent.
   */
  resetToFactory(): Promise<void>;
}

/** Config/SoftConfig.data (idle lights-off, 05 §2.6). */
export interface SoftConfig {
  TurnOffLightsWhenIdle: boolean;
  TurnOffLightsWhenIdleDuration: number;
}

export interface ThemeSwitchEvent {
  theme: string;
  profile: string;
  reason: 'switch' | 'switch-app' | 'apply' | 'import' | 'reset' | 'factory-reset' | 'delete';
}

export interface ThemeStore extends BackendService {
  /** $XDG_CONFIG_HOME/EvniaServe/Theme (mirrors %APPDATA%\EvniaServe\Theme). */
  readonly themeRootDir: string;
  currentThemeName(): string;
  currentProfileName(): string;
  /** Stored ProfileContent for `desc` in the CURRENT profile (DeviceType + exact ModelName match), or null. */
  getStoredContent(desc: DeviceProfileDesc): string | null;
  /** Register a driver; it is then purified on save and applied on switch. Returns unregister. */
  registerParticipant(p: ProfileParticipant): () => void;
  /**
   * Re-purify `p` into the current profile and rewrite its .pcenter (after a setting change or scan).
   * (Appended by theme/.) Mutators — saveParticipant, setSyncProfile, setSoftConfig — never wait for a
   * running theme operation (Theme_Switch, reset, …), only for their own file write, so they are safe to
   * await anywhere, including inside DisplayDevice.exclusive() while a switch waits for that queue.
   * saveParticipant coalesces calls (debounce) and never rejects.
   */
  saveParticipant(p: ProfileParticipant): Promise<void>;
  /** Sync_Profile of the current profile (T_Sync_Profile, profile-mode JSON object) — used by ambiglow sync. */
  getSyncProfile(): { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null;
  /** (Appended by theme/.) Visible to getSyncProfile() at once; resolves after the write; never waits for an operation. */
  setSyncProfile(sync: { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null): Promise<void>;
  getSoftConfig(): SoftConfig;
  /** (Appended by theme/.) Visible to getSoftConfig() at once; resolves after the write; never waits for an operation. */
  setSoftConfig(patch: Partial<SoftConfig>): Promise<void>;
  /**
   * (Appended by theme/.) Listeners run after the switching operation released the store's lock, outside
   * its async context, and may call any store method. Another operation may already be queued: read the
   * current state (currentThemeName(), getSyncProfile()) rather than trusting the event's names.
   */
  onSwitched(cb: (e: ThemeSwitchEvent) => void): () => void;
}

// ───────────────────────────── Monitors (monitor/) ─────────────────────────────

/** One connected Philips display with its driver (vendor CDevice_PHLDisplay + Display/DataOSD). */
export interface DisplayDevice {
  /** UI key: the EDID serial string (vendor DisplaySN / PHL_SwitchDisplay argument, 13 characters, e.g. "MOCK000000001"). */
  readonly key: string;
  /** EDID monitor name as the vendor reports it, e.g. "PHL 34M2C8600". */
  readonly monitorName: string;
  readonly discovered: DiscoveredMonitor;
  readonly ddc: DdcChannel;
  /** ENE Ambiglow controller on USB, if present (09 §2). */
  readonly ene?: UsbDeviceInfo;
  /** Resolves once the background full VCP read finished (20-backend-host-tail §7.2). */
  ready(): Promise<void>;
  /**
   * The live T_PHLDisplay_Profile object (vendor GClass0.DeviceData), serializable via core/json.ts
   * ([toCSharpJson] hook) in 'ui', 'uiProfileGet' and 'profile' modes.
   */
  profile(): unknown;
  /**
   * (Appended by monitor/.) Run `fn` in the display's single-flight operation queue, after the background
   * load, so a multi-step sequence (e.g. an Effect_* DDC sequence of the ambiglow service) never interleaves
   * with a PHL_* sequence (20-monitor-io-linux-consolidation §2.4). Re-entrant: queued calls made from
   * inside `fn` run inline.
   */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * (Appended by monitor/.) After changing profile() directly: RecheckFuncConstraints (sends
   * NotifyUIDisplayFuncConstraintsChange when the state changed) and SaveProfile (themes.saveParticipant).
   */
  settingsChanged(): Promise<void>;
  /**
   * (Appended by monitor/.) ENE presence as detected by the ambiglow service (vendor CDevice_PHLDisplay
   * method_14 plug / method_15 unplug): the CUSBENE6K7732.GetModelName result (e.g. "34M2C8600"), or ''
   * when no usable ENE controller is attached. Updates ENEEffectEnable/EffectInfo in DeviceData and
   * CacheDeviceData (on loss also the DDC E2A019 state) and, when the state changed, saves and sends
   * NotifyUIDisplayEffectChange {ENEEnable, EffectInfo, ModuleAmbiglow} (the keys the renderer reads,
   * 20-backend-host-tail §2.5), followed by the vendor's Item1..3 with the same values. Called before or
   * during the first load it is recorded at once, so that
   * load already uses it; later loads use it unless AmbiglowService.checkEne answers. Pushing EffectInfo
   * to the ENE hardware stays with the caller.
   */
  setEneModel(model: string): Promise<void>;
}

export interface MonitorManager extends BackendService {
  /** Enumerate/refresh (vendor ScanDeviceType: All / USB / Display — 05 §2.5). */
  scan(kind: 'all' | 'usb' | 'display'): Promise<void>;
  displays(): readonly DisplayDevice[];
  /** Display the monitor pages act on (vendor "current" display after PHL_SwitchDisplay). */
  current(): DisplayDevice | null;
  select(key: string): Promise<boolean>;
  /** Device_GetConnectList entries for connected displays (DeviceInfo JSON objects, 20-backend-host-tail §5-6). */
  connectList(): unknown[];
  onChanged(cb: () => void): () => void;
}

// ───────────────────────────── Ambiglow (ambiglow/) ─────────────────────────────

export interface AmbiglowService extends BackendService {
  /** Called by the display driver when a display (dis)appears or its ENE presence changes. */
  attach(display: DisplayDevice | null): Promise<void>;
  /**
   * (Appended by monitor/, optional.) Vendor CDevice_PHLDisplay.method_14 at the top of every full VCP
   * read (first load, PHL_ReloadData, Profile_Reset — PHL/CDevice_PHLDisplay.cs:328): open/identify the
   * ENE controller that belongs to `display` (display.ene, display.monitorName → matchEneModelName) and
   * return its model name, or '' when there is none or it is unusable (not-ene, invalid firmware,
   * unsupported model, no USB access). The read awaits it, so ENEEffectEnable/EffectInfo of that read
   * (and the first Profile_GetDeviceData) already reflect the ENE (20-backend-host-tail §6 item 4).
   * It runs while the display's operation queue is held: it must not await display.ready() (the first
   * load is what it is part of); display.exclusive() runs inline. Without it the display keeps the
   * model last reported through DisplayDevice.setEneModel.
   */
  checkEne?(display: DisplayDevice): Promise<string>;
}
