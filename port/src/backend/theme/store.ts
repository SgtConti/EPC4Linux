// Theme/profile engine: vendor ThemeOper (TO) + the theme parts of SystemOper (SO) + GlobalOper's
// SoftConfig (GO), per docs/re/20-theme-profile-engine.md.
//
// State (20-theme §1): the parsed DataTheme.cfg, the CURRENT theme (a reference into it; always "User"
// at start-up, §4 step 3) and the CURRENT profile (T_Theme_Profile) in memory. Device drivers are
// ProfileParticipants (services.ts): they are purified into the current profile on every save
// (ThemeSaveCurProfiles, SO:3119-3140), receive the stored section on a switch (smethod_20,
// SO:3085-3117) and reset on Theme_ResetCurProfile / FactoryReset.
//
// Every vendor operation that returns a JsonResult is a method here returning the same JsonResult
// (codes and texts verbatim, including the vendor's typos); api/theme.ts, api/macro.ts and
// api/setting.ts only register them.
//
// Concurrency (port design; the vendor had one lock around ThemeSaveCurProfiles only, 20-theme §8
// "Races", and §10.1 asks for "one mutex for the index and profile writers"):
//   1. OPERATIONS (Theme_*, Macro_*, FactoryReset, start) run one at a time on the operation lock
//      (OpLock). Work a participant starts inside an operation's async context runs inline (no
//      self-deadlock) and is awaited before the lock is released, so it never overlaps the next
//      operation; onSwitched listeners run after the release, outside that context.
//   2. MUTATORS (saveParticipant, setSyncProfile, setSoftConfig, flush) NEVER take the operation lock.
//      An operation holds the lock while it awaits participants, and the display runs
//      applyProfileContent on its single-flight OpQueue (monitor/op-queue.ts), where ambiglow's Effect_*
//      sequences also run (DisplayDevice.exclusive); a queue task that awaited a lock-taking mutator
//      would deadlock with that operation. Mutators act on the in-memory current profile synchronously
//      and only wait for the file queue below. The current (theme, profile) pair only ever changes in
//      synchronous code (#transition), so a mutator always sees a consistent pair.
//   3. FILES: every write of DataTheme.cfg, a .pcenter or SoftConfig.data, and every rename/delete
//      that can move them, runs on one FIFO (IoQueue) that waits for nothing but the file system.
//      Content and path are captured when a write is queued, and in-memory renames happen in the same
//      synchronous step that queues the matching directory/file move, so no write lands on a stale path.
//   4. Participant calls made by operations are bounded (participantTimeoutMs, default 60 s, below the
//      dispatcher's 120 s watchdog): a participant that never settles is logged with the vendor's
//      "ParameterToDevice Error" text and the operation completes, so the lock is always released.
//   5. Read-only queries (Theme_GetCurTheme, Theme_GetThemeInfos, Theme_GetCurProfile,
//      Setting_GlobalData) are served from memory without the lock, like the vendor (SO:2994-3007,
//      Bridge.cs:23-26).
//
// Port deviations (each documented in docs/port/impl-theme.md §4):
//   - atomic file writes (formats.ts) and debounced participant saves (20-theme §10.1);
//   - names: "." and ".." are invalid (B-1 path traversal); new names also reject a leading/trailing
//     space or dot and case-insensitive duplicate profile names (§10.1, B-10); paths use the canonical
//     theme name found by the case-insensitive lookup (Linux file systems are case-sensitive);
//   - load-time repairs of DataTheme.cfg (§4 "Repairs the vendor does not do"); an unparsable
//     DataTheme.cfg is kept as DataTheme.cfg.corrupt-<ms> before the default replaces it;
//   - FactoryReset also resets the in-memory SoftConfig (B-11) and never deletes outside the
//     EvniaServe tree.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { CoreServices } from '../index.ts';
import type { DeviceProfileDesc, ProfileParticipant, SoftConfig, ThemeStore, ThemeSwitchEvent } from '../services.ts';
import type { HostServices, JsonResult, Logger } from '../types.ts';
import { error, succ } from '../core/envelope.ts';
import {
  AppBindingWatcher,
  BindingResolver,
  genAppIcon,
  moveFile,
  pruneTempIcons,
  type ForegroundApp,
  type ForegroundAppHost,
} from './app-binding.ts';
import { DEVICE_TYPES, getRealDeviceType, isSubDeviceType } from './device-types.ts';
import {
  bindBaseEffectDetailInfo,
  bindDataTheme,
  bindObject,
  bindSoftConfig,
  bindSyncDeviceInfo,
  bindThemeProfile,
  bindBindAppInfo,
  cloneThemeProfile,
  convEnum,
  convList,
  convString,
  dataThemeJson,
  deviceProfileDescJson,
  isDirectory,
  isFile,
  loadConfigFile,
  newBindAppInfo,
  newSoftConfig,
  newThemeInfo,
  newThemeProfile,
  parseJsonText,
  saveConfigFile,
  serializeConfig,
  softConfigJson,
  syncProfileJson,
  themeInfoJson,
  themeInfosJson,
  themeProfileJson,
  writeFileAtomic,
  type BindAppInfoModel,
  type DataThemeModel,
  type DeviceProfileDescModel,
  type SoftConfigModel,
  type SyncProfileModel,
  type ThemeInfoModel,
  type ThemeProfileModel,
} from './formats.ts';
import { MacroOps } from './macros.ts';
import {
  equalsIgnoreCase,
  findIgnoreCase,
  genValidName,
  getExtension,
  getFileNameWithoutExtension,
  isValidName,
  isValidNewName,
  sha1Prefix10,
} from './names.ts';
import { DEFAULT_PROFILE, LOGS_DIR_NAME, SERVE_DATA_NAME, USER_THEME, WorkspacePaths, defaultAppTempDir } from './paths.ts';

/** What the .NET dispatcher replies when a Bridge method throws (TargetInvocationException, 20-backend-host-tail §1.3). */
export const TARGET_INVOCATION_MSG = 'Exception has been thrown by the target of an invocation.';

/** Notification_Func.const_2 (real name from the obfuscated tree, 20-backend-host-tail §2.4). */
export const NOTIFY_UI_SWITCH_THEME = 'NotifyUISwitchTheme';

/** The port's own desktop entry (packaging/deb, electron-shell `desktopName`). */
export const SELF_DESKTOP_FILE = 'evnia-precision-center.desktop';

/** Default bound for one participant call inside an operation (the dispatcher watchdog is 120 s). */
export const DEFAULT_PARTICIPANT_TIMEOUT_MS = 60_000;

const MAX_TIMER_MS = 2_147_483_647;

export interface ThemeStoreOptions {
  /** Delay that coalesces participant saves (20-theme §10.1 "debounce saves"); default 250 ms, 0 = next tick. */
  saveDebounceMs?: number;
  /** CheckTopApp period (vendor RunPerSecondAtStart: 1000 ms). */
  appWatchIntervalMs?: number;
  /**
   * Upper bound for one participant's applyProfileContent / resetToFactory inside an operation
   * (default 60 s; 0 = unbounded). The display's reset is VCP 0x04, 5 s and a full re-read, possibly
   * behind its background load.
   */
  participantTimeoutMs?: number;
  /** PathBase.PATH_APP_TEMP for Comm_GenAppIcon; default paths.defaultAppTempDir(env). */
  appTempDir?: string;
  /** Environment for XDG and PATH lookups (tests). */
  env?: NodeJS.ProcessEnv;
  /** Executables of this app, never treated as a foreground app to bind (default: process.execPath). */
  selfExecutables?: readonly string[];
}

/** One hold of the operation lock. */
interface Hold {
  /** Work started inside this hold's async context (possibly not awaited by it): awaited before release. */
  readonly nested: Promise<unknown>[];
  /** Callbacks that run right after release, outside the hold's async context (onSwitched listeners). */
  readonly after: (() => void)[];
}

/**
 * The operation lock. A call made from inside the holder's async context runs inline (re-entrant: a
 * participant being applied may call back into an operation) and is registered with the hold, which
 * awaits it before releasing, so nested work can never overlap the next operation.
 */
class OpLock {
  readonly #als = new AsyncLocalStorage<Hold>();
  #tail: Promise<unknown> = Promise.resolve();
  #holder: Hold | null = null;

  #current(): Hold | null {
    const h = this.#als.getStore();
    return h !== undefined && h === this.#holder ? h : null;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    const cur = this.#current();
    if (cur) {
      const p = fn();
      cur.nested.push(p.catch(() => undefined));
      return p;
    }
    const hold: Hold = { nested: [], after: [] };
    const next = this.#tail.then(async () => {
      this.#holder = hold;
      try {
        return await this.#als.run(hold, fn);
      } finally {
        while (hold.nested.length > 0) await Promise.allSettled(hold.nested.splice(0));
        this.#holder = null;
        const after = hold.after.splice(0);
        if (after.length > 0) this.#als.exit(() => after.forEach((cb) => cb()));
      }
    });
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /** Run `cb` once the current hold is released (at once when called outside a hold), outside any hold's context. */
  afterRelease(cb: () => void): void {
    const cur = this.#current();
    if (cur) cur.after.push(cb);
    else this.#als.exit(cb);
  }
}

/**
 * FIFO of the engine's file-system work (20-theme §10.1 "one mutex for the index and profile
 * writers"). A task waits for nothing but the file system, so waiting for the queue cannot deadlock.
 * A task must never await another task of the same queue.
 */
class IoQueue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(() => fn());
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /** Resolves once everything queued so far has run. */
  idle(): Promise<void> {
    return this.#tail.then(() => undefined);
  }
}

interface PendingSave {
  timer: NodeJS.Timeout | null;
  extra: Set<ProfileParticipant>;
  waiters: (() => void)[];
}

const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** DataTheme after Check(): a list without null entries. */
interface CheckedDataTheme {
  ThemeInfos: ThemeInfoModel[];
}

function isPresent<T>(v: T | null | undefined): v is T {
  return v !== null && v !== undefined;
}

type InternalOptions = Required<Omit<ThemeStoreOptions, 'appTempDir' | 'env' | 'selfExecutables'>> & { env: NodeJS.ProcessEnv };

export class ThemeStoreImpl implements ThemeStore {
  readonly paths: WorkspacePaths;
  readonly #log: Logger;
  readonly #core: CoreServices;
  readonly #opts: InternalOptions;
  readonly #lock = new OpLock();
  readonly #io = new IoQueue();
  readonly #participants = new Set<ProfileParticipant>();
  readonly #listeners = new Set<(e: ThemeSwitchEvent) => void>();
  readonly #watcher: AppBindingWatcher;
  readonly #resolver: BindingResolver;
  readonly #selfExecutables: readonly string[];
  /** Macro_* operations (theme/macros.ts), on this engine's operation lock. */
  readonly macros: MacroOps;
  #loaded: Promise<void> | null = null;
  #dataTheme: CheckedDataTheme = { ThemeInfos: [] };
  #cur: ThemeInfoModel | null = null;
  #curProfile: ThemeProfileModel | null = null;
  #soft: SoftConfigModel = newSoftConfig();
  #pending: PendingSave | null = null;
  #stopped = false;
  #initFailed = false;
  #pruned = false;

  constructor(core: CoreServices, options: ThemeStoreOptions = {}) {
    this.#core = core;
    this.#log = core.log.child('theme');
    const env = options.env ?? process.env;
    this.paths = new WorkspacePaths(core.host.serveDataDir, options.appTempDir ?? defaultAppTempDir(env));
    this.#opts = {
      saveDebounceMs: options.saveDebounceMs ?? 250,
      appWatchIntervalMs: options.appWatchIntervalMs ?? 1000,
      participantTimeoutMs: Math.min(options.participantTimeoutMs ?? DEFAULT_PARTICIPANT_TIMEOUT_MS, MAX_TIMER_MS),
      env,
    };
    this.#resolver = new BindingResolver(env);
    this.#selfExecutables = options.selfExecutables ?? [process.execPath];
    this.macros = new MacroOps({
      paths: this.paths,
      log: this.#log.child('macro'),
      exclusive: <T>(fn: () => Promise<T>) => this.#run(fn),
      themeDirName: (name) => this.resolveThemeDirName(name),
      pathAllowed: (path, access) => this.#pathAllowed(path, access),
    });
    const host = core.host as HostServices & ForegroundAppHost;
    this.#watcher = new AppBindingWatcher({
      log: this.#log.child('app'),
      intervalMs: this.#opts.appWatchIntervalMs,
      getForegroundApp: (): ForegroundApp | null => {
        if (typeof host.getForegroundApp === 'function') return host.getForegroundApp();
        const exe = host.getForegroundAppPath?.() ?? null;
        return exe ? { exe } : null;
      },
      releaseForegroundApp: () => {
        if (typeof host.releaseForegroundApp === 'function') host.releaseForegroundApp();
      },
      themes: () => this.#dataTheme.ThemeInfos,
      currentThemeName: () => this.#cur?.Name ?? null,
      notify: (theme) => core.notifier.notify(NOTIFY_UI_SWITCH_THEME, theme),
      resolver: this.#resolver,
      selfExecutables: this.#selfExecutables,
    });
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  get themeRootDir(): string {
    return this.paths.themeRootDir;
  }

  /**
   * InitEnviroment(false) + GlobalOper load (20-theme §4). Idempotent: api/system.ts calls it again on
   * every Start. Rejects with "InitEnviroment error" (SO:113-118) while a fresh DataTheme.cfg cannot be
   * written; the in-memory defaults are usable meanwhile and every Start retries the write.
   */
  async start(): Promise<void> {
    this.#stopped = false;
    await this.#run(async () => {
      if (this.#initFailed && (await this.#writeDataTheme())) {
        this.#initFailed = false;
        await this.#ensureThemeDirs();
        await this.#saveNow();
      }
    });
    if (!this.#pruned) {
      this.#pruned = true;
      void pruneTempIcons(this.paths.appTemp, 24 * 3600 * 1000, this.#log);
    }
    if (this.#initFailed) throw new Error('InitEnviroment error');
  }

  /** Writes a pending participant save and stops the CheckTopApp loop. */
  async stop(): Promise<void> {
    this.#watcher.stop();
    await this.flush();
    this.#stopped = true;
  }

  /**
   * Start CheckTopApp. The vendor loop begins with the first hub connection and acts only after the
   * first scan (EvniaHub.cs:45-48, SO:304-314); api/theme.ts arms it on the renderer's start-up
   * Theme_GetCurTheme / Theme_GetThemeInfos, which follow Start.
   */
  armAppWatch(): void {
    if (!this.#stopped) this.#watcher.arm();
  }

  /** One CheckTopApp pass (tests, or a host that wants to poll on focus changes). */
  checkTopApp(): Promise<string | null> {
    return this.#watcher.tick();
  }

  get appWatchArmed(): boolean {
    return this.#watcher.armed;
  }

  /** An operation: the operation lock, after the one-time load. */
  #run<T>(fn: () => Promise<T>): Promise<T> {
    return this.#lock.run(async () => {
      await this.#ensureLoaded();
      return fn();
    });
  }

  #ensureLoaded(): Promise<void> {
    this.#loaded ??= this.#io.run(() => this.#load()).catch((e: unknown) => {
      this.#loaded = null;
      throw e;
    });
    return this.#loaded;
  }

  /** Runs as a file-queue task (raw writes only). The current pair is assigned in one step at the end. */
  async #load(): Promise<void> {
    if (!(await this.#themeInit())) {
      this.#initFailed = true;
      this.#log.error('InitEnviroment error');
    }
    // InitEnviroment: themeInfo_0 = UserThemeInfo (exact "User"; Check() guarantees it exists).
    const cur = this.#dataTheme.ThemeInfos.find((t) => t.Name === USER_THEME) ?? null;
    const profile = cur ? await this.#readOrCreateProfile(cur.Name as string, cur.SelProfileName as string, true) : null;
    const soft = await this.#readSoftConfig();
    this.#cur = cur;
    this.#curProfile = profile;
    this.#soft = soft;
  }

  /** ThemeOper.ThemeInit(false) (TO:28-39); false when a fresh DataTheme.cfg could not be written. Raw writes. */
  async #themeInit(): Promise<boolean> {
    const path = this.paths.dataThemePath;
    const loaded = await loadConfigFile(path, bindDataTheme);
    if (loaded) {
      this.#dataTheme = this.#checkDataTheme(loaded);
      await this.#ensureThemeDirs();
      return true;
    }
    if (await isFile(path)) {
      const keep = `${path}.corrupt-${Date.now()}`;
      this.#log.error(`DataTheme.cfg unreadable; keeping it as ${keep} and creating a default one`);
      await rename(path, keep).catch((e: unknown) => this.#log.error('rename failed', e));
    }
    this.#dataTheme = this.#defaultDataTheme();
    await this.#ensureThemeDirs();
    return this.#rawSaveDataTheme();
  }

  /** DataTheme.Default: [User] with the Default profile, after Check(). */
  #defaultDataTheme(): CheckedDataTheme {
    return this.#checkDataTheme({ ThemeInfos: [newThemeInfo(USER_THEME, true)] });
  }

  /**
   * DataTheme.Check (EN/DataTheme.cs:42-57) + ThemeInfo.Check (EN/ThemeInfo.cs:184-209) and the
   * repairs of 20-theme §4 that the vendor lacks: entries that are null or have an invalid name are
   * dropped (an entry named ".." would let Theme_Del delete the whole tree), case-insensitive duplicate
   * theme names keep only the first, "User" is the only IsDefault theme, SelProfileName must be one of
   * ProfileNames, CycleProfileNames ⊆ ProfileNames without duplicates, and Windows-path app bindings
   * (never matchable on Linux, 20-theme §10.1 "Migration") are dropped. Existing names are checked for
   * path safety only (isValidName), not with the stricter rule for new names, so no copied Windows
   * profile is lost.
   */
  #checkDataTheme(d: DataThemeModel): CheckedDataTheme {
    const out: ThemeInfoModel[] = [];
    for (const t of d.ThemeInfos ?? []) {
      if (!t || !isValidName(t.Name)) {
        if (t) this.#log.warn(`DataTheme: dropping theme with invalid name ${JSON.stringify(t.Name)}`);
        continue;
      }
      if (out.some((o) => equalsIgnoreCase(o.Name, t.Name))) {
        this.#log.warn(`DataTheme: dropping duplicate theme ${t.Name}`);
        continue;
      }
      out.push(t);
    }
    if (!out.some((t) => t.Name === USER_THEME)) out.unshift(newThemeInfo(USER_THEME, true));
    for (const t of out) this.#checkThemeInfo(t);
    return { ThemeInfos: out };
  }

  #checkThemeInfo(t: ThemeInfoModel): void {
    t.IsDefault = t.Name === USER_THEME;
    // Profile names become file names: names the vendor itself could never have created ("/" or ".."
    // in a hand-made or foreign index) are dropped so no path leaves Theme/<theme>/.
    t.ProfileNames = [...new Set(t.ProfileNames.filter((n): n is string => isValidName(n)))];
    if (t.ProfileNames.length === 0) {
      t.SelProfileName = DEFAULT_PROFILE;
      t.ProfileNames.push(DEFAULT_PROFILE);
      if (!t.CycleProfileNames.includes(DEFAULT_PROFILE)) t.CycleProfileNames.push(DEFAULT_PROFILE);
    }
    if (t.SelProfileName === null || !t.ProfileNames.includes(t.SelProfileName)) t.SelProfileName = t.ProfileNames[0];
    t.CycleProfileNames = [...new Set(t.CycleProfileNames.filter((n): n is string => n !== null && t.ProfileNames.includes(n)))];
    t.BindAppInfos = t.BindAppInfos.filter((b): b is BindAppInfoModel => {
      if (!b) return false;
      if (b.BindAppFilePath !== null && WINDOWS_PATH.test(b.BindAppFilePath)) {
        this.#log.info(`DataTheme: dropping Windows app binding ${b.BindAppFilePath} of ${t.Name}`);
        return false;
      }
      return true;
    });
  }

  /** ThemeInfo.Check's Directory.CreateDirectory(ProfileDir) for every theme (errors logged). */
  async #ensureThemeDirs(): Promise<void> {
    for (const t of this.#dataTheme.ThemeInfos) await this.#ensureDir(t);
  }

  async #ensureDir(t: ThemeInfoModel): Promise<void> {
    try {
      await mkdir(this.paths.themeDir(t.Name as string), { recursive: true });
    } catch (e) {
      this.#log.error(`cannot create theme directory for ${t.Name}`, e);
    }
  }

  /**
   * ThemeInfo.LoadCurProfile (EN/ThemeInfo.cs:152-167) for (theme, profile): missing/unparsable → empty
   * profile, saved (raw inside a file-queue task, else queued and awaited).
   */
  async #readOrCreateProfile(themeName: string, profileName: string, raw: boolean): Promise<ThemeProfileModel> {
    const path = this.paths.profilePath(themeName, profileName);
    let p = await loadConfigFile(path, bindThemeProfile);
    if (!p) {
      p = newThemeProfile();
      if (raw) await this.#rawSaveProfile(p, path);
      else await this.#writeProfile(p, path);
    }
    this.#checkThemeProfile(p);
    return p;
  }

  /** ThemeInfo.LoadProfileByName: null when missing or unparsable. */
  async #loadProfileByName(t: ThemeInfoModel, profileName: string): Promise<ThemeProfileModel | null> {
    const p = await loadConfigFile(this.paths.profilePath(t.Name as string, profileName), bindThemeProfile);
    if (p) this.#checkThemeProfile(p);
    return p;
  }

  /** T_Theme_Profile.Check: SyncDevices grouped by DeviceType, first kept (null entries dropped). */
  #checkThemeProfile(p: ThemeProfileModel): void {
    const sync = p.Sync_Profile;
    if (!sync) return;
    const seen = new Set<number>();
    sync.SyncDevices = sync.SyncDevices.filter((d) => {
      if (!d || seen.has(d.DeviceType)) return false;
      seen.add(d.DeviceType);
      return true;
    });
  }

  /** GlobalOper.method_0 (GO:77-94): missing/unparsable → defaults, written at once. Raw write. */
  async #readSoftConfig(): Promise<SoftConfigModel> {
    const s = await loadConfigFile(this.paths.softConfigPath, bindSoftConfig);
    if (s) return s;
    const d = newSoftConfig();
    await saveConfigFile(this.paths.softConfigPath, softConfigJson(d), { onError: (e) => this.#log.error('SoftConfig save failed', e) });
    return d;
  }

  // ───────────────────────────── persistence helpers ─────────────────────────────

  /** SaveTXTConfig of `json`, serialized NOW and written in file-queue order; logs `failure` and resolves false on error. */
  #enqueueWrite(path: string, json: unknown, failure: string): Promise<boolean> {
    let data: Buffer;
    try {
      data = serializeConfig(json);
    } catch (e) {
      this.#log.error(failure, e);
      return Promise.resolve(false);
    }
    return this.#io.run(async () => {
      try {
        await writeFileAtomic(path, data);
        return true;
      } catch (e) {
        this.#log.error(failure, e);
        return false;
      }
    });
  }

  /** ThemeOper.method_2 (TO:244-252): "SaveDataTheme Error" is logged, the operation still succeeds. Raw. */
  #rawSaveDataTheme(): Promise<boolean> {
    return saveConfigFile(this.paths.dataThemePath, dataThemeJson(this.#dataTheme), { onError: (e) => this.#log.error('SaveDataTheme Error', e) });
  }

  /** ThemeOper.method_2, captured now and queued. */
  #writeDataTheme(): Promise<boolean> {
    return this.#enqueueWrite(this.paths.dataThemePath, dataThemeJson(this.#dataTheme), 'SaveDataTheme Error');
  }

  #rawSaveProfile(p: ThemeProfileModel, path: string): Promise<boolean> {
    return saveConfigFile(path, themeProfileJson(p), { onError: (e) => this.#log.error(`SaveTXTConfig ${path} failed`, e) });
  }

  #writeProfile(p: ThemeProfileModel, path: string): Promise<boolean> {
    return this.#enqueueWrite(path, themeProfileJson(p), `SaveTXTConfig ${path} failed`);
  }

  #rawSaveSoftConfig(): Promise<boolean> {
    return saveConfigFile(this.paths.softConfigPath, softConfigJson(this.#soft), { onError: (e) => this.#log.error('SoftConfig save failed', e) });
  }

  /** T_Theme_Profile.GetProfileContent (EN/T_Theme_Profile.cs:54-63): "" when absent. */
  static getProfileContent(p: ThemeProfileModel, deviceType: number, modelName: string | null): string | null {
    const real = getRealDeviceType(deviceType, modelName);
    const hit = p.Profiles.find((x) => x?.ProfileDesc && x.ProfileDesc.DeviceType === real && x.ProfileDesc.ModelName === modelName);
    return hit ? hit.ProfileContent : '';
  }

  /** T_Theme_Profile.SaveProfileContent (EN/T_Theme_Profile.cs:65-94). */
  #saveProfileContent(p: ThemeProfileModel, desc: DeviceProfileDescModel, content: string | null): void {
    const real = getRealDeviceType(desc.DeviceType, desc.ModelName);
    if (!desc.ModelName || !content) {
      this.#log.error(`SaveProfileContent deviceType=${real} modelName =${desc.ModelName ?? ''} content is empty!!!`);
      return;
    }
    const hit = p.Profiles.find((x) => x?.ProfileDesc && x.ProfileDesc.DeviceType === real && x.ProfileDesc.ModelName === desc.ModelName);
    if (hit?.ProfileDesc) {
      hit.ProfileContent = content;
      hit.ProfileDesc.ExtModel = desc.ExtModel;
      return;
    }
    p.Profiles.push({
      ProfileDesc: { EquipmentType: desc.EquipmentType, DeviceType: real, ModelName: desc.ModelName, ExtModel: desc.ExtModel },
      ProfileContent: content,
    });
  }

  /**
   * SystemOper.ThemeSaveCurProfiles (SO:3119-3140), captured NOW: purify every participant (the vendor
   * saves every connected device) plus a pending save's extra participants into the current profile,
   * serialize the current .pcenter and DataTheme.cfg and queue both writes. Takes over a pending save
   * (its waiters resolve after these writes). Never rejects, never waits for the operation lock.
   */
  #saveNow(extra: Iterable<ProfileParticipant> = []): Promise<void> {
    const pending = this.#pending;
    this.#pending = null;
    if (pending?.timer) clearTimeout(pending.timer);
    const cur = this.#cur;
    const profile = this.#curProfile;
    let written: Promise<unknown> = Promise.resolve();
    if (cur && profile) {
      for (const p of new Set([...this.#participants, ...(pending?.extra ?? []), ...extra])) {
        let content: string;
        try {
          content = p.purify();
        } catch (e) {
          this.#log.error(`PurifyProfile ${p.desc.ModelName ?? ''} failed`, e);
          continue;
        }
        this.#saveProfileContent(profile, p.desc, content);
      }
      const label = `${cur.Name}.${cur.SelProfileName}`;
      const path = this.paths.profilePath(cur.Name as string, cur.SelProfileName as string);
      written = Promise.all([
        this.#enqueueWrite(path, themeProfileJson(profile), `${label} SerializedFileUtil.SaveTXTConfig Error`),
        this.#enqueueWrite(this.paths.dataThemePath, dataThemeJson(this.#dataTheme), `${label} SaveDataTheme Error`),
      ]);
    }
    return written.then(() => {
      for (const w of pending?.waiters ?? []) w();
    });
  }

  /** Drop a pending save without writing (the profile is being reset); its waiters resolve now. */
  #discardPending(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    for (const w of pending.waiters) w();
  }

  /** Before an operation reads profile files: write a pending save and wait for queued writes. */
  #settle(): Promise<void> {
    if (this.#pending) void this.#saveNow();
    return this.#io.idle();
  }

  /**
   * Make (theme, profile) the current pair in one synchronous step, so store mutators always see a
   * consistent pair. A pending participant save belongs to the profile being left: it is captured now
   * (purified, serialized, queued) with the old path. When the same profile is re-applied (import or
   * apply onto the current profile) the pending save is left to the operation's own save instead, which
   * would otherwise first write the old content over the file just imported.
   */
  #transition(t: ThemeInfoModel, profileName: string, profile: ThemeProfileModel): void {
    const cur = this.#cur;
    const same = cur === t && cur.SelProfileName === profileName;
    if (this.#pending && !same) void this.#saveNow();
    t.SelProfileName = profileName;
    this.#cur = t;
    this.#curProfile = profile;
  }

  /** Write a pending participant save now; resolves once everything queued so far is on disk. */
  flush(): Promise<void> {
    return this.#settle();
  }

  /** Queue the onSwitched listeners for after the operation releases the lock (outside its async context). */
  #emit(reason: ThemeSwitchEvent['reason']): void {
    const e: ThemeSwitchEvent = { theme: this.currentThemeName(), profile: this.currentProfileName(), reason };
    this.#lock.afterRelease(() => {
      for (const cb of [...this.#listeners]) {
        try {
          cb(e);
        } catch (err) {
          this.#log.error('onSwitched listener failed', err);
        }
      }
    });
  }

  /** One participant call of an operation, bounded by participantTimeoutMs; never throws. */
  async #bounded(call: () => Promise<void>, failure: string): Promise<void> {
    const ms = this.#opts.participantTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const running = Promise.resolve().then(call);
    try {
      if (ms <= 0) {
        await running;
        return;
      }
      const timedOut = new Promise<true>((r) => {
        timer = setTimeout(r, ms, true);
      });
      if ((await Promise.race([running.then(() => false), timedOut])) === true) {
        this.#log.error(`${failure}: no answer after ${ms} ms; continuing without it`);
        running.catch((e: unknown) => this.#log.error(`${failure} (after the timeout)`, e));
      }
    } catch (e) {
      this.#log.error(failure, e);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** smethod_20 (SO:3085-3117): every participant gets its section (or null), in parallel. */
  async #applyParticipants(snapshot: ThemeProfileModel): Promise<void> {
    await Promise.all(
      [...this.#participants].map((p) => {
        const c = ThemeStoreImpl.getProfileContent(snapshot, p.desc.DeviceType, p.desc.ModelName);
        return this.#bounded(() => p.applyProfileContent(c ? c : null), `DeviceType = ${p.desc.DeviceType} ParameterToDevice Error`);
      }),
    );
  }

  /** Reset(needSave:false) of every participant, in parallel (SO:3277-3293, SO:279-292). */
  async #resetParticipants(label: string): Promise<void> {
    await Promise.all([...this.#participants].map((p) => this.#bounded(() => p.resetToFactory(), `${label} ${p.desc.ModelName ?? ''} failed`)));
  }

  // ───────────────────────────── ThemeStore (services.ts) ─────────────────────────────

  currentThemeName(): string {
    return this.#cur?.Name ?? USER_THEME;
  }

  currentProfileName(): string {
    return this.#cur?.SelProfileName ?? DEFAULT_PROFILE;
  }

  getStoredContent(desc: DeviceProfileDesc): string | null {
    if (!this.#curProfile) return null;
    const c = ThemeStoreImpl.getProfileContent(this.#curProfile, desc.DeviceType, desc.ModelName);
    return c ? c : null;
  }

  registerParticipant(p: ProfileParticipant): () => void {
    this.#participants.add(p);
    return () => {
      this.#participants.delete(p);
    };
  }

  /**
   * GClass0.SaveProfile → EVT_Com.SaveCurThemeProfile → ThemeSaveCurProfiles (G0:191-194, HE:35-38).
   * Calls within the debounce window are coalesced into one write of the then-current state; the
   * promise resolves after that write and never rejects (write errors are logged, as in the vendor).
   * Never waits for a theme operation, so it may be awaited anywhere (inside DisplayDevice.exclusive(),
   * applyProfileContent(), resetToFactory()).
   */
  async saveParticipant(p: ProfileParticipant): Promise<void> {
    try {
      await this.#ensureLoaded();
    } catch (e) {
      this.#log.error('save failed', e);
      return;
    }
    if (this.#stopped) return this.#saveNow([p]);
    let pending = this.#pending;
    if (!pending) {
      const created: PendingSave = { timer: null, extra: new Set(), waiters: [] };
      created.timer = setTimeout(() => {
        created.timer = null;
        if (this.#pending === created) void this.#saveNow();
      }, this.#opts.saveDebounceMs);
      pending = this.#pending = created;
    }
    pending.extra.add(p);
    const target = pending;
    return new Promise<void>((r) => target.waiters.push(r));
  }

  getSyncProfile(): { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null {
    return this.#curProfile ? syncProfileJson(this.#curProfile.Sync_Profile) : null;
  }

  /**
   * Replace the current profile's Sync_Profile (normalized to T_Sync_Profile) and save (SO:1537-1626).
   * The change is visible to getSyncProfile() at once; the promise resolves after the write. Never waits
   * for a theme operation.
   */
  async setSyncProfile(sync: { EffectDetailInfo: unknown; SyncDevices: unknown[] } | null): Promise<void> {
    await this.#ensureLoaded();
    const profile = this.#curProfile;
    if (!profile) return;
    profile.Sync_Profile = sync === null ? null : bindSyncProfileLoose(sync);
    await this.#saveNow();
  }

  getSoftConfig(): SoftConfig {
    return softConfigJson(this.#soft);
  }

  /** GlobalOper setters (GO:23-53): saved only when a value changes. Never waits for a theme operation. */
  async setSoftConfig(patch: Partial<SoftConfig>): Promise<void> {
    await this.#ensureLoaded();
    let changed = false;
    if (patch.TurnOffLightsWhenIdle !== undefined && patch.TurnOffLightsWhenIdle !== this.#soft.TurnOffLightsWhenIdle) {
      this.#soft.TurnOffLightsWhenIdle = patch.TurnOffLightsWhenIdle;
      changed = true;
    }
    if (patch.TurnOffLightsWhenIdleDuration !== undefined && patch.TurnOffLightsWhenIdleDuration !== this.#soft.TurnOffLightsWhenIdleDuration) {
      this.#soft.TurnOffLightsWhenIdleDuration = patch.TurnOffLightsWhenIdleDuration;
      changed = true;
    }
    if (changed) await this.#enqueueWrite(this.paths.softConfigPath, softConfigJson(this.#soft), 'SoftConfig save failed');
  }

  /**
   * Listeners run after the operation that switched has released the operation lock, outside its async
   * context: they may call any store method (an operation they start queues normally). Another
   * operation may already be queued, so read the current state instead of trusting the event.
   */
  onSwitched(cb: (e: ThemeSwitchEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }

  // ───────────────────────────── lookups ─────────────────────────────

  /** DataTheme.Contains (OrdinalIgnoreCase). */
  #find(themeName: string | null | undefined): ThemeInfoModel | undefined {
    if (!themeName) return undefined;
    return this.#dataTheme.ThemeInfos.find((t) => equalsIgnoreCase(t.Name, themeName));
  }

  #themeInfos(): JsonResult {
    return succ(themeInfosJson(this.#dataTheme.ThemeInfos));
  }

  /** The canonical theme directory for a raw name (case-insensitive lookup first, 20-theme §10.1). */
  resolveThemeDirName(themeName: string): string {
    return this.#find(themeName)?.Name ?? themeName;
  }

  /** Current theme + profile names (Theme_GetDevicesBasicInfo(int)); loads the store first. Lock-free. */
  async currentSelection(): Promise<{ theme: string; profile: string } | null> {
    await this.#ensureLoaded();
    return this.#cur ? { theme: this.#cur.Name as string, profile: this.#cur.SelProfileName as string } : null;
  }

  /** ThemeOper.GetThemeProfile(theme, profile) (TO:503-517): the stored file, or null. */
  loadThemeProfile(themeName: string, profileName: string): Promise<ThemeProfileModel | null> {
    return this.#run(async () => {
      await this.#settle();
      const t = this.#find(themeName);
      if (!t) {
        this.#log.error(`GetThemeProfile Error ThemeName=${themeName} Not Exist`);
        return null;
      }
      if (!t.ProfileNames.includes(profileName)) {
        this.#log.error(`GetThemeProfile Error ProfileName=${profileName} Not Exist`);
        return null;
      }
      return this.#readProfilePath(this.paths.profilePath(t.Name as string, profileName));
    });
  }

  /** ThemeOper.GetThemeProfile(filePath) (TO:519-534); `filePath` comes from the renderer (host path policy). */
  loadProfileFile(filePath: string): Promise<ThemeProfileModel | null> {
    return this.#run(async () => {
      await this.#settle();
      return this.#readExternalProfilePath(filePath);
    });
  }

  /**
   * HostServices.pathAllowed for a path the renderer sent (Electron main: dialog picks and the app's data
   * directories for reads, the export dialog's choice or a userData temp file for writes). Allowed when
   * the host has no policy (serve.ts, CLI, tests), like the vendor.
   */
  #pathAllowed(path: string, access: 'read' | 'write'): boolean {
    const host = this.#core.host;
    if (typeof host.pathAllowed !== 'function') return true;
    try {
      if (host.pathAllowed(path, access)) return true;
    } catch (e) {
      this.#log.error('pathAllowed failed', e);
    }
    this.#log.warn(`refused to ${access} ${path}: not a file the user chose (host path policy)`);
    return false;
  }

  /** #readProfilePath for a renderer-supplied path: a refused path reads as missing (the vendor's "Not Exist"). */
  #readExternalProfilePath(filePath: string): Promise<ThemeProfileModel | null> {
    if (this.#pathAllowed(filePath, 'read')) return this.#readProfilePath(filePath);
    this.#log.error(`GetThemeProfile Error FilePath=${filePath} Not Exist`);
    return Promise.resolve(null);
  }

  async #readProfilePath(filePath: string): Promise<ThemeProfileModel | null> {
    if (!(await isFile(filePath))) {
      this.#log.error(`GetThemeProfile Error FilePath=${filePath} Not Exist`);
      return null;
    }
    const p = await loadConfigFile(filePath, bindThemeProfile);
    if (!p) this.#log.error(`GetThemeProfile FilePath=${filePath} Error`);
    return p;
  }

  // ───────────────────────────── Theme_* queries (lock-free, from memory) ─────────────────────────────

  /** Theme_GetCurTheme (SO:2994-2997). */
  async getCurTheme(): Promise<JsonResult> {
    await this.#ensureLoaded();
    return succ(themeInfoJson(this.#cur));
  }

  /** Theme_GetCurProfile (SO:2999-3002): the in-memory profile, nulls kept. */
  async getCurProfile(): Promise<JsonResult> {
    await this.#ensureLoaded();
    return succ(this.#curProfile ? themeProfileJson(this.#curProfile) : null);
  }

  /** Theme_GetThemeInfos (SO:3004-3007, TO:234-237). */
  async getThemeInfos(): Promise<JsonResult> {
    await this.#ensureLoaded();
    return this.#themeInfos();
  }

  // ───────────────────────────── switching (SO:3019-3117) ─────────────────────────────

  /** Theme_Switch(theme, profile, bApply) (SO:3019-3052). */
  switchTheme(themeName: string, profileName: string, bApply = false, reason: ThemeSwitchEvent['reason'] = 'switch'): Promise<JsonResult> {
    return this.#run(() => this.#switchLocked(themeName, profileName, bApply, reason));
  }

  /** Theme_SwitchApp (SO:3054-3059): Theme_Switch(theme, ""); EVT_Com.ThemeSwitchApp has no monitor consumer. */
  switchApp(themeName: string): Promise<JsonResult> {
    return this.#run(() => this.#switchLocked(themeName, '', false, 'switch-app'));
  }

  /**
   * SO:3019-3052 + ThemeOper.ThemeSwitch (TO:211-219). `preloaded` is the target's content when the
   * caller just wrote it (import/apply onto a profile): it becomes current without re-reading the file,
   * which a concurrent save could otherwise have replaced in between.
   */
  async #switchLocked(
    themeName: string,
    profileName: string,
    bApply: boolean,
    reason: ThemeSwitchEvent['reason'],
    preloaded?: ThemeProfileModel,
  ): Promise<JsonResult> {
    this.#log.debug(`Theme_Switch  themeName=${themeName}  profileName=${profileName}  bApply=${bApply}`);
    if (!themeName) return error('ThemeSwitch themeName is null');
    let profile = profileName;
    if (!profile) {
      const theme = this.#find(themeName);
      if (!theme) return error(`ThemeSwitch themeName=${themeName} not exit profileName is null`);
      profile = theme.SelProfileName as string;
    }
    const cur = this.#cur as ThemeInfoModel;
    if (!bApply && equalsIgnoreCase(themeName, cur.Name) && equalsIgnoreCase(profile, cur.SelProfileName)) {
      return succ(themeInfoJson(cur));
    }
    // Theme case-insensitive, profile ProfileNames.Contains (ordinal).
    const target = this.#find(themeName);
    if (!target || !target.ProfileNames.includes(profile)) {
      return error(`ThemeSwitch ThemeName=${themeName} or ProfileName=${profile} not contains`);
    }
    let next = preloaded;
    if (next) this.#checkThemeProfile(next);
    else next = await this.#readOrCreateProfile(target.Name as string, profile, false);
    this.#transition(target, profile, next);
    await this.#applyParticipants(cloneThemeProfile(next));
    await this.#saveNow();
    this.#emit(reason);
    return succ(themeInfoJson(this.#cur));
  }

  // ───────────────────────────── theme management (TO:41-209) ─────────────────────────────

  /** ThemeOper.method_0 (TO:154-179): bindings whose file exists (and that are not this app). */
  async #analyseBindApps(param: string): Promise<BindAppInfoModel[]> {
    if (!param) return [];
    this.#log.debug(`AnalyseBindAppInfo param=${param}`);
    const raw = parseJsonText(param);
    if (raw === undefined) return [];
    let list: (BindAppInfoModel | null)[];
    try {
      list = convList((v, p) => bindBindAppInfo(v, p), true)(raw, 'param');
    } catch {
      return [];
    }
    const out: BindAppInfoModel[] = [];
    for (const item of list) {
      if (!item) continue;
      if (this.#selfExecutables.includes(item.BindAppFilePath ?? '') || basename(item.BindAppFilePath ?? '') === SELF_DESKTOP_FILE) {
        // 20-theme §10.2 item 2: the backend also refuses this app itself (the renderer's CannotBindSelf).
        this.#log.warn(`refusing to bind this application (${item.BindAppFilePath})`);
      } else if (await isFile(item.BindAppFilePath)) out.push(item);
      else this.#log.error(`File Not Exits FilePath=${item.BindAppFilePath}; IconPath=${item.BindAppIconPath}`);
    }
    return out;
  }

  /** Is `path` strictly inside `dir` (after resolving `.` and `..`)? */
  static #inside(path: string, dir: string): boolean {
    const p = resolve(path);
    const base = resolve(dir);
    return p.startsWith(base.endsWith('/') ? base : `${base}/`);
  }

  /**
   * ThemeOper.method_1 (TO:181-209): delete icons of removed apps, move fresh temp icons into
   * Theme/<T>/Icon/<sha1(path)[0..10]>.png, blank icon paths that do not exist.
   * Deviations: only icons inside the theme's Icon/ directory or PATH_APP_TEMP are ever deleted (the
   * vendor deleted whatever path the renderer sent); an SVG icon keeps its .svg extension.
   */
  async #setBindApps(t: ThemeInfoModel, list: BindAppInfoModel[]): Promise<void> {
    const iconDir = this.paths.iconPath(t.Name as string, '');
    for (const old of t.BindAppInfos) {
      if (!old) continue;
      if (!list.some((x) => equalsIgnoreCase(x.BindAppFilePath, old.BindAppFilePath))) {
        const icon = old.BindAppIconPath;
        if (icon && (ThemeStoreImpl.#inside(icon, iconDir) || ThemeStoreImpl.#inside(icon, this.paths.appTemp))) await rm(icon, { force: true }).catch(() => undefined);
      }
    }
    for (const item of list) {
      const icon = item.BindAppIconPath ?? '';
      // Vendor: Contains(PATH_APP_TEMP, OrdinalIgnoreCase). Hardening: the file must really be inside
      // PATH_APP_TEMP, so a crafted "…/EvniaServe/../../x" never moves a user file away.
      if (icon.toLowerCase().includes(this.paths.appTemp.toLowerCase()) && ThemeStoreImpl.#inside(icon, this.paths.appTemp)) {
        const ext = getExtension(icon).toLowerCase() === '.svg' ? '.svg' : '.png';
        let dest = this.paths.iconPath(t.Name as string, sha1Prefix10(item.BindAppFilePath ?? '') + ext);
        if (!(await moveFile(icon, dest))) {
          this.#log.error(`SetBindAppFiles MoveFile($${icon}, $${dest}) Error`);
          dest = '';
        }
        item.BindAppIconPath = dest;
      }
      if (!(await isFile(item.BindAppIconPath))) item.BindAppIconPath = '';
    }
    t.BindAppInfos = list.map((b) => newBindAppInfo(b.BindAppFilePath, b.BindAppIconPath));
  }

  /** Delete a directory tree in file-queue order (errors logged, like DirectroyUtil.DelFolder). */
  #removeDir(dir: string): Promise<void> {
    return this.#io.run(() => rm(dir, { recursive: true, force: true }).catch((e: unknown) => this.#log.error('DelFolder failed', e)));
  }

  /** Theme_Add (TO:41-71). */
  addTheme(themeName: string, param: string): Promise<JsonResult> {
    return this.#run(async () => {
      if (!isValidNewName(themeName)) return error(`ThemeAdd Error ThemeName=${themeName} Not Valid`, 2);
      if (this.#find(themeName)) return error(`ThemeAdd Error ThemeName=${themeName} Exist`, 4);
      const list = await this.#analyseBindApps(param);
      if (list.length === 0) return error(`ThemeAdd Error param=${param} Not Exist`, 8);
      const t = newThemeInfo(themeName, false);
      const dir = this.paths.themeDir(themeName);
      if (await isDirectory(dir)) {
        this.#log.warn('newDir exit');
        await this.#removeDir(dir);
      }
      this.#checkThemeInfo(t);
      await this.#ensureDir(t);
      await this.#setBindApps(t, list);
      this.#dataTheme.ThemeInfos.push(t);
      await this.#writeDataTheme();
      return this.#themeInfos();
    });
  }

  /** Theme_Del (SO:3066-3073, TO:73-87). */
  delTheme(themeName: string): Promise<JsonResult> {
    return this.#run(async () => {
      if (equalsIgnoreCase(this.#cur?.Name, themeName)) return error(`Can't del curThemeInfo ${themeName}`, 8);
      const t = this.#find(themeName);
      if (!t) return error(`ThemeDel Error ThemeName=${themeName} Not Exist`, 3);
      if (t.IsDefault) return error(`ThemeDel Error ThemeName=${themeName} IsDefault`, 7);
      this.#dataTheme.ThemeInfos.splice(this.#dataTheme.ThemeInfos.indexOf(t), 1);
      await this.#removeDir(this.paths.themeDir(t.Name as string));
      await this.#writeDataTheme();
      return this.#themeInfos();
    });
  }

  /**
   * Theme_Rename (TO:89-132); the error texts keep the vendor's copy-paste slips (B-7). The in-memory
   * name changes in the same synchronous step that queues the directory move, so a save of the current
   * theme captured before it is written into the old directory before the move and one captured after
   * it goes to the new directory.
   */
  renameTheme(themeName: string, newThemeName: string): Promise<JsonResult> {
    return this.#run(async () => {
      if (!isValidNewName(newThemeName)) return error(`ThemeRename Error ThemeName=${newThemeName} Not Valid`, 2);
      if (this.#find(newThemeName)) return error(`ThemeAdd Error ThemeName=${themeName} Exist`, 4);
      const t = this.#find(themeName);
      if (!t) return error(`ThemeRename Error ThemeName=${themeName} Not Exist`, 3);
      if (t.IsDefault) return error(`ThemeRename Error ThemeName=${themeName} IsDefault`, 7);
      const oldDir = this.paths.themeDir(t.Name as string);
      const newDir = join(dirname(oldDir), newThemeName);
      for (const b of t.BindAppInfos) {
        if (!b) continue;
        if (b.BindAppFilePath) b.BindAppFilePath = b.BindAppFilePath.split(oldDir).join(newDir);
        if (b.BindAppIconPath) b.BindAppIconPath = b.BindAppIconPath.split(oldDir).join(newDir);
      }
      t.Name = newThemeName;
      await this.#io.run(async () => {
        if (!(await isDirectory(oldDir))) return;
        if (await isDirectory(newDir)) {
          this.#log.warn('newDir exit');
          await rm(newDir, { recursive: true, force: true }).catch((e: unknown) => this.#log.error('DelFolder failed', e));
        }
        await rename(oldDir, newDir).catch((e: unknown) => this.#log.error('MoveDir failed', e));
      });
      await this.#writeDataTheme();
      return this.#themeInfos();
    });
  }

  /** Theme_UpdateBindApp (SO:3080-3083, TO:134-152). */
  updateBindApp(themeName: string, param: string): Promise<JsonResult> {
    return this.#run(async () => {
      const t = this.#find(themeName);
      if (!t) return error(`ThemeUpdateBindApp Error ThemeName=${themeName} Not Exist`, 3);
      if (t.IsDefault) return error(`ThemeUpdateBindApp Error Error ThemeName=${themeName} IsDefault`, 7);
      const list = await this.#analyseBindApps(param);
      if (list.length === 0) return error(`ThemeUpdateBindApp Error AppPath=${param} Not Exist`, 8);
      await this.#setBindApps(t, list);
      await this.#writeDataTheme();
      this.#resolver.clear();
      return this.#themeInfos();
    });
  }

  /** Comm_GenAppIcon (SO:694-697, GO:134-146): Tag = temp icon path or "". */
  async genAppIcon(appPath: string): Promise<JsonResult> {
    return succ(await genAppIcon(appPath, this.paths.appTemp, this.#log, this.#opts.env));
  }

  // ───────────────────────────── profile management (TO:268-501) ─────────────────────────────

  /**
   * Is `name` taken in `t`, ignoring case (port, 20-theme §10.1: Windows cannot hold `Default` and
   * `default`)? `except` is the profile being renamed, so a case-only rename of itself is allowed.
   */
  static #profileTaken(t: ThemeInfoModel, name: string, except?: string): boolean {
    return t.ProfileNames.some((n) => n !== null && n !== except && equalsIgnoreCase(n, name));
  }

  /** Theme_AddProfile (SO:3229-3232, TO:268-289); no file is written (the following switch creates it). */
  addProfile(themeName: string, profileName: string): Promise<JsonResult> {
    return this.#run(async () => {
      if (!isValidNewName(profileName)) return error(`ThemeCopyProfile Error ProfileName=${profileName} Not Valid`, 2);
      const t = this.#find(themeName);
      if (!t) return error(`ThemeAddProfile Error ThemeName=${themeName} Not Exist`, 3);
      if (ThemeStoreImpl.#profileTaken(t, profileName)) return error(`ThemeAddProfile Error ProfileName=${profileName} Exist`, 6);
      t.ProfileNames.push(profileName);
      if (!t.CycleProfileNames.includes(profileName)) t.CycleProfileNames.push(profileName);
      await this.#writeDataTheme();
      return this.#themeInfos();
    });
  }

  /** Theme_CopyProfile (TO:291-332). */
  copyProfile(themeName: string, profileName: string, newProfileName: string): Promise<JsonResult> {
    return this.#run(async () => {
      await this.#settle();
      const t = this.#find(themeName);
      if (!t) return error(`ThemeCopyProfile Error ThemeName=${themeName} Not Exist`, 3);
      if (!t.ProfileNames.includes(profileName)) return error(`ThemeCopyProfile Error ProfileName=${profileName} Not Exist`, 5);
      const src = this.paths.profilePath(t.Name as string, profileName);
      if (!(await isFile(src))) return error(`ThemeCopyProfile Error OriProfilePath=${src} Not Exist`, 5);
      if (!isValidNewName(newProfileName)) return error(`ThemeCopyProfile Error newProfileName=${newProfileName} Not Valid`, 2);
      if (ThemeStoreImpl.#profileTaken(t, newProfileName)) return error(`ThemeCopyProfile Error NewProfileName=${newProfileName} Exist`, 6);
      const obj = await loadConfigFile(src, bindThemeProfile);
      if (!obj) return error(`ThemeCopyProfile LoadProfile=${src} Error`, 7);
      if (!(await this.#writeProfile(obj, this.paths.profilePath(t.Name as string, newProfileName)))) return error('ThemeCopyProfile SaveTXTConfig Error');
      t.ProfileNames.push(newProfileName);
      if (!t.CycleProfileNames.includes(newProfileName)) t.CycleProfileNames.push(newProfileName);
      await this.#writeDataTheme();
      return this.#themeInfos();
    });
  }

  /**
   * Theme_RenameProfile (TO:334-386). The names change in the same synchronous step that queues the file
   * move (see renameTheme); the moved file is then re-serialized like the vendor's SaveTXTConfig(obj).
   */
  renameProfile(themeName: string, profileName: string, newProfileName: string): Promise<JsonResult> {
    return this.#run(async () => {
      await this.#settle();
      const t = this.#find(themeName);
      if (!t) return error(`ThemeRenameProfile Error ThemeName=${themeName} Not Exist`, 3);
      if (!t.ProfileNames.includes(profileName)) return error(`ThemeRenameProfile Error ProfileName=${profileName} Not Exist`, 5);
      const src = this.paths.profilePath(t.Name as string, profileName);
      if (!(await isFile(src))) return error(`ThemeRenameProfile Error OriProfilePath=${src} Not Exist`, 5);
      if (!isValidNewName(newProfileName)) return error(`ThemeRenameProfile Error newProfileName=${newProfileName} Not Valid`, 2);
      if (newProfileName === profileName || ThemeStoreImpl.#profileTaken(t, newProfileName, profileName)) {
        return error(`ThemeRenameProfile Error NewProfileName=${newProfileName} Exist`, 6);
      }
      const index = t.ProfileNames.indexOf(profileName);
      if (index === -1) return error(`ThemeRenameProfile Error UnFind ProfileName=${profileName}`, 5);
      const obj = await loadConfigFile(src, bindThemeProfile);
      if (!obj) return error(`ThemeRenameProfile LoadProfile=${src} Error`, 7);
      const dst = this.paths.profilePath(t.Name as string, newProfileName);
      t.ProfileNames[index] = newProfileName;
      if (t.SelProfileName === profileName) t.SelProfileName = newProfileName;
      const ci = t.CycleProfileNames.indexOf(profileName);
      if (ci !== -1) t.CycleProfileNames[ci] = newProfileName;
      const saved = await this.#io.run(async () => {
        await rename(src, dst).catch((e: unknown) => this.#log.error('MoveFile failed', e));
        // Re-read inside the queue: a save of the current profile queued before the move is the newest content.
        const fresh = (await loadConfigFile(dst, bindThemeProfile)) ?? obj;
        return this.#rawSaveProfile(fresh, dst);
      });
      await this.#writeDataTheme();
      if (!saved) return error('ThemeRenameProfile SaveTXTConfig Error');
      return this.#themeInfos();
    });
  }

  /** Theme_DelProfile (SO:3244-3251, TO:388-411). */
  delProfile(themeName: string, profileName: string): Promise<JsonResult> {
    return this.#run(async () => {
      const cur = this.#cur as ThemeInfoModel;
      if (equalsIgnoreCase(cur.Name, themeName) && equalsIgnoreCase(cur.SelProfileName, profileName)) {
        return error(`Can't del curThemeInfo ${themeName} | ${profileName}`);
      }
      const t = this.#find(themeName);
      if (!t) return error(`ThemeDelProfile Error ThemeName=${themeName} Not Exist`, 3);
      if (!t.ProfileNames.includes(profileName)) return error(`ThemeDelProfile Error ProfileName=${profileName} Not Exist`, 5);
      if (t.ProfileNames.length <= 1) return error('ThemeDelProfile Error ProfileNames Count at last one');
      const ci = t.CycleProfileNames.indexOf(profileName);
      if (ci !== -1) t.CycleProfileNames.splice(ci, 1);
      t.ProfileNames.splice(t.ProfileNames.indexOf(profileName), 1);
      if (t.SelProfileName === profileName) t.SelProfileName = t.ProfileNames[0];
      const path = this.paths.profilePath(t.Name as string, profileName);
      await this.#io.run(() => rm(path, { force: true }).catch((e: unknown) => this.#log.error('DelFile failed', e)));
      await this.#writeDataTheme();
      return this.#themeInfos();
    });
  }

  /**
   * Theme_ImportProfile(theme, file, bOverride) (SO:3253-3265, TO:413-446). No content validation (any
   * object with a non-empty Profiles array). With bOverride onto the current profile the profile is
   * re-applied (Theme_Switch bApply). Deviations: an override whose name matches an existing profile
   * ignoring case overwrites THAT profile (on Windows both names hit the same file; on Linux the vendor
   * logic would add a second, case-variant profile); an override name that is not a valid new name (a
   * Linux file name may contain `|` or `:`) goes through GenValidName like the non-override path.
   */
  importProfile(themeName: string, filePath: string, bOverride: boolean): Promise<JsonResult> {
    return this.#run(async () => {
      await this.#settle();
      const t = this.#find(themeName);
      if (!t) return error(`ThemeImportProfile Error ThemeName=${themeName} Not Exist`, 3);
      // A path the user did not pick reads as missing (host path policy; same error as the vendor's File.Exists).
      if (!this.#pathAllowed(filePath, 'read') || !(await isFile(filePath))) return error(`ThemeImportProfile Error FilePath=${filePath} Not Exist`, 8);
      const obj = await loadConfigFile(filePath, bindThemeProfile);
      if (!obj) return error(`ThemeImportProfile LoadProfile=${filePath} Error`, 7);
      if (obj.Profiles.length === 0) return error(`ThemeImportProfile  LoadProfile=${filePath} Profiles is empty`, 10);
      const base = getFileNameWithoutExtension(filePath);
      const existing = bOverride ? findIgnoreCase(t.ProfileNames, base) : undefined;
      const name = existing ?? (bOverride && isValidNewName(base) ? base : genValidName(t.ProfileNames.filter(isPresent), base, DEFAULT_PROFILE));
      if (!t.ProfileNames.includes(name)) {
        t.ProfileNames.push(name);
        if (!t.CycleProfileNames.includes(name)) t.CycleProfileNames.push(name);
      }
      await this.#writeProfile(obj, this.paths.profilePath(t.Name as string, name));
      await this.#writeDataTheme();
      const cur = this.#cur as ThemeInfoModel;
      if (bOverride && cur === t && equalsIgnoreCase(name, cur.SelProfileName)) {
        await this.#switchLocked(t.Name as string, name, true, 'import', obj);
      }
      return this.#themeInfos();
    });
  }

  /**
   * Theme_ExportProfile (TO:448-478): the stored file re-serialized to exactly `filePath`. Tag null.
   * Port: `filePath` must be one the host allows writing (Electron main: the path just chosen in the export
   * dialog, or a userData temp file); otherwise the vendor's write failure "SaveTXTConfig Error".
   */
  exportProfile(themeName: string, profileName: string, filePath: string): Promise<JsonResult> {
    return this.#run(async () => {
      await this.#settle();
      const t = this.#find(themeName);
      if (!t) return error(`ThemeExportProfile Error ThemeName=${themeName} Not Exist`, 3);
      if (!t.ProfileNames.includes(profileName)) return error(`ThemeExportProfile Error ProfileName=${profileName} Not Exist`, 5);
      const src = this.paths.profilePath(t.Name as string, profileName);
      if (!(await isFile(src))) return error(`ThemeExportProfile Error OriProfilePath=${src} Not Exist`, 5);
      const obj = await loadConfigFile(src, bindThemeProfile);
      if (!obj) return error(`ThemeExportProfile LoadProfile=${src} Error`, 7);
      if (obj.Profiles.length === 0) return error(`ThemeExportProfile  LoadProfile=${src} Profiles is empty`, 10);
      if (!this.#pathAllowed(filePath, 'write') || !(await this.#writeProfile(obj, filePath))) return error('ThemeExportProfile SaveTXTConfig Error');
      return succ();
    });
  }

  /** Theme_HandleCycleProfile (TO:480-501). */
  handleCycleProfile(themeName: string, profileName: string, bAdd: boolean): Promise<JsonResult> {
    return this.#run(async () => {
      const t = this.#find(themeName);
      if (!t) return error(`ThemeHandleCycleProfile Error ThemeName=${themeName} Not Exist`, 3);
      if (!t.ProfileNames.includes(profileName)) return error(`ThemeHandleCycleProfile Error ProfileName=${profileName} Not Exist`, 5);
      if (!bAdd) {
        const i = t.CycleProfileNames.indexOf(profileName);
        if (i !== -1) t.CycleProfileNames.splice(i, 1);
      } else if (!t.CycleProfileNames.includes(profileName)) {
        t.CycleProfileNames.push(profileName);
        const order = (n: string | null) => t.ProfileNames.indexOf(n);
        t.CycleProfileNames = t.CycleProfileNames.map((n, i) => ({ n, i })).sort((a, b) => order(a.n) - order(b.n) || a.i - b.i).map((x) => x.n);
      }
      await this.#writeDataTheme();
      return this.#themeInfos();
    });
  }

  /**
   * Theme_ResetCurProfile (SO:3277-3293): clear the current profile (InitDefData keeps Sync_Profile but
   * empties its SyncDevices), reset every participant (the display writes VCP 0x04 = 1, B-3), save.
   * Tag null, always success.
   */
  resetCurProfile(): Promise<JsonResult> {
    return this.#run(async () => {
      this.#discardPending();
      const p = this.#curProfile as ThemeProfileModel;
      if (p.Sync_Profile) p.Sync_Profile.SyncDevices = [];
      p.Profiles = [];
      await this.#resetParticipants('Reset');
      await this.#saveNow();
      this.#emit('reset');
      return succ();
    });
  }

  // ───────────────────────────── descriptions and cloud-era functions ─────────────────────────────

  /** GetProfileDesc tag: (path, [T_DeviceProfile_Base]) with sub-device types removed (TO:550-552). */
  static #descTag(path: string, obj: ThemeProfileModel): JsonResult {
    const descs: unknown[] = [];
    for (const p of obj.Profiles) {
      // x.ProfileDesc on a null entry, x.DeviceType on a null desc: NullReferenceException in the vendor.
      if (!p || !p.ProfileDesc) return error(TARGET_INVOCATION_MSG);
      if (!isSubDeviceType(p.ProfileDesc.DeviceType)) descs.push(deviceProfileDescJson(p.ProfileDesc));
    }
    return succ({ Item1: path, Item2: descs });
  }

  /** Theme_GetProfileDesc(profilePath) (TO:536-555). */
  getProfileDescByPath(profilePath: string): Promise<JsonResult> {
    return this.#run(async () => {
      await this.#settle();
      if (!this.#pathAllowed(profilePath, 'read') || !(await isFile(profilePath))) return error(`AnalyseProfile ProfilePath=${profilePath} Not Exist`, 8);
      const obj = await loadConfigFile(profilePath, bindThemeProfile);
      if (!obj) return error(`AnalyseProfile LoadProfile=${profilePath} Error`, 7);
      if (obj.Profiles.length === 0) return error(`AnalyseProfile  LoadProfile=${profilePath} Profiles is empty`, 10);
      return ThemeStoreImpl.#descTag(profilePath, obj);
    });
  }

  /** Theme_GetProfileDesc(theme, profile) (TO:557-586; cloudFilePath "" → Item1 = the profile path). */
  getProfileDesc(themeName: string, profileName: string): Promise<JsonResult> {
    return this.#run(async () => {
      await this.#settle();
      const t = this.#find(themeName);
      if (!t) return error(`GetProfileDesc Error ThemeName=${themeName} Not Exist`, 3);
      if (!t.ProfileNames.includes(profileName)) return error(`GetProfileDesc Error ProfileName=${profileName} Not Exist`, 5);
      const path = this.paths.profilePath(t.Name as string, profileName);
      if (!(await isFile(path))) return error(`GetProfileDesc Error ProfilePath=${path} Not Exist`, 8);
      const obj = await loadConfigFile(path, bindThemeProfile);
      if (!obj) return error(`GetProfileDesc LoadProfile=${path} Error`, 7);
      if (obj.Profiles.length === 0) return error(`AnalyseProfile  LoadProfile=${path} Profiles is empty`, 10);
      return ThemeStoreImpl.#descTag(path, obj);
    });
  }

  /**
   * Theme_ApplyProfile(theme, profile, profilePath, selDevices) (SO:3456-3464, TO:622-699): local-file
   * based; only its renderer caller is cloud UI. The Tag (ThemeInfos) is serialized after the switch,
   * as in the vendor (the Tag is the live list). An existing profile is found ignoring case (§10.1);
   * the current profile is merged from memory (the vendor's file equals it, the port may still hold a
   * debounced save).
   */
  applyProfile(themeName: string, profileName: string, profilePath: string, selDevices: string): Promise<JsonResult> {
    return this.#run(async () => {
      if (!isValidNewName(themeName) || !isValidNewName(profileName)) {
        return error(`ApplyProfile Error ThemeName=${themeName} or  ProfileName=${profileName} Not Valid`, 2);
      }
      const raw = parseJsonText(selDevices);
      let list: ({ DeviceType: number; ModelName: string | null } | null)[];
      try {
        if (raw === undefined) throw new Error('null');
        list = convList(
          (v, p) =>
            bindObject<{ DeviceType: number; ModelName: string | null; ExtValue: string | null }>(v, p, () => ({ DeviceType: 0, ModelName: null, ExtValue: null }), {
              DeviceType: convEnum(DEVICE_TYPES),
              ModelName: convString,
              ExtValue: convString,
            }),
          true,
        )(raw, 'selDevices');
      } catch {
        return error(TARGET_INVOCATION_MSG); // list.Count on null → NullReferenceException
      }
      if (list.length === 0) return error(`ApplyProfile selDevices=${selDevices} is error`);
      await this.#settle();
      const src = await this.#readExternalProfilePath(profilePath);
      if (!src) return error(`ApplyProfile LoadProfile=${profilePath} Error`, 7);
      const filtered = newThemeProfile();
      for (const p of src.Profiles) {
        if (!p || !p.ProfileDesc) return error(TARGET_INVOCATION_MSG);
        const desc = p.ProfileDesc;
        for (const x of list) {
          if (!x) return error(TARGET_INVOCATION_MSG);
          if (x.ModelName === null) return error(TARGET_INVOCATION_MSG);
          if (x.DeviceType === desc.DeviceType && x.ModelName === desc.ModelName) {
            filtered.Profiles.push(p);
            break;
          }
        }
      }
      if (filtered.Profiles.length === 0) return error(`ApplyProfile LoadProfile=${profilePath} sel profiles is empty`, 10);
      let t = this.#find(themeName);
      let target = profileName;
      let content: ThemeProfileModel;
      if (!t) {
        t = newThemeInfo(themeName, false);
        const dir = this.paths.themeDir(themeName);
        if (await isDirectory(dir)) {
          this.#log.warn('newDir exit');
          await this.#removeDir(dir);
        }
        t.ProfileNames.push(profileName);
        if (!t.CycleProfileNames.includes(profileName)) t.CycleProfileNames.push(profileName);
        this.#checkThemeInfo(t);
        await this.#ensureDir(t);
        this.#dataTheme.ThemeInfos.push(t);
        await this.#writeProfile(filtered, this.paths.profilePath(themeName, profileName));
        await this.#writeDataTheme();
        content = filtered;
      } else {
        const known = findIgnoreCase(t.ProfileNames, profileName);
        if (known === undefined) {
          t.ProfileNames.push(profileName);
          if (!t.CycleProfileNames.includes(profileName)) t.CycleProfileNames.push(profileName);
          await this.#writeProfile(filtered, this.paths.profilePath(t.Name as string, profileName));
          await this.#writeDataTheme();
          content = filtered;
        } else {
          target = known;
          const isCurrent = this.#cur === t && t.SelProfileName === known && this.#curProfile !== null;
          const existing = isCurrent ? cloneThemeProfile(this.#curProfile as ThemeProfileModel) : await this.#loadProfileByName(t, known);
          if (!existing) return error(TARGET_INVOCATION_MSG); // SaveProfileContent on null
          for (const p of filtered.Profiles) {
            const desc = p?.ProfileDesc;
            if (!p || !desc) continue;
            if (!p.ProfileContent) {
              this.#log.error(`${JSON.stringify(deviceProfileDescJson(desc))} is null`);
              continue;
            }
            this.#saveProfileContent(existing, desc, p.ProfileContent);
          }
          await this.#writeProfile(existing, this.paths.profilePath(t.Name as string, known));
          content = existing;
        }
      }
      await this.#switchLocked(t.Name as string, target, true, 'apply', content);
      return this.#themeInfos();
    });
  }

  // ───────────────────────────── profile cycling (SO:3142-3227) ─────────────────────────────

  /** SwitchProfileNotification: NotifyUISwitchTheme "<CurTheme>|<profile>" (the renderer switches). */
  #notifyProfile(profile: string): void {
    this.#core.notifier.notify(NOTIFY_UI_SWITCH_THEME, `${this.#cur?.Name ?? ''}|${profile}`);
  }

  #cycle(step: 1 | -1, wrap: boolean): void {
    const t = this.#cur;
    if (!t || t.CycleProfileNames.length < 1) return;
    const list = t.CycleProfileNames.filter(isPresent);
    if (list.length === 0) return;
    let i = list.indexOf(t.SelProfileName as string);
    if (i < 0) i = 0;
    i += step;
    if (i < 0 || i > list.length - 1) {
      if (!wrap) return;
      i = i < 0 ? list.length - 1 : 0;
    }
    this.#notifyProfile(list[i]);
  }

  /** EVT_Profile.NextProfile: next cycle entry, no wrap. */
  nextProfile(): void {
    this.#cycle(1, false);
  }

  /** EVT_Profile.PreviousProfile: previous cycle entry, no wrap. */
  previousProfile(): void {
    this.#cycle(-1, false);
  }

  /** EVT_Profile.CycleDownProfile: next cycle entry, wraps. */
  cycleDownProfile(): void {
    this.#cycle(1, true);
  }

  /** EVT_Profile.CycleUpProfile: previous cycle entry, wraps. */
  cycleUpProfile(): void {
    this.#cycle(-1, true);
  }

  /** EVT_Profile.SpecificProfile("Theme | Profile"): only within the current theme (ordinal). */
  specificProfile(param: string): void {
    const t = this.#cur;
    if (!t || !param) return;
    const parts = param.split(' | ');
    if (parts.length !== 2) return;
    if (t.Name === parts[0] && t.ProfileNames.some((x) => x === parts[1])) this.#notifyProfile(parts[1]);
  }

  // ───────────────────────────── settings (Bridge.cs:23-42, GO) ─────────────────────────────

  /** Setting_GlobalData: Succ(GlobalOper.ConfigData), from memory without the lock (Bridge.cs:23-26). */
  async globalData(): Promise<JsonResult> {
    await this.#ensureLoaded();
    return succ(softConfigJson(this.#soft));
  }

  /** Setting_TurnOffLightsWhenIdle(bool): Tag null. */
  async setTurnOffLightsWhenIdle(enable: boolean): Promise<JsonResult> {
    await this.setSoftConfig({ TurnOffLightsWhenIdle: enable });
    return succ();
  }

  /** Setting_TurnOffLightsWhenIdleDuration(int): < 1 → "at last 1 minutes" (err 9); Tag null. */
  async setTurnOffLightsWhenIdleDuration(duration: number): Promise<JsonResult> {
    if (duration < 1) return error('at last 1 minutes');
    await this.setSoftConfig({ TurnOffLightsWhenIdleDuration: duration });
    return succ();
  }

  /**
   * FactoryReset (SO:254-303): delete every file directly in EvniaServe/ and every sub-directory
   * except `logs`, then InitEnviroment(reset:true) (fresh DataTheme.cfg and empty User/Default.pcenter),
   * reset every participant, save. Tag true; 9 "InitEnviroment error" when DataTheme.cfg cannot be
   * written.
   *
   * The fresh state (index, User/Default, empty profile, default SoftConfig — B-11) becomes current in
   * one synchronous step before the wipe is queued: saves captured earlier are written before the wipe
   * (and wiped), saves captured later target the fresh tree and are written after it. On the failure
   * path the in-memory state is the fresh one too (the vendor kept pointing at the wiped theme); the
   * participants are not reset (vendor), start() retries writing DataTheme.cfg and the current profile.
   */
  factoryReset(): Promise<JsonResult> {
    return this.#run(async () => {
      this.#log.debug('FactoryReset start');
      this.#discardPending();
      const fresh = this.#defaultDataTheme();
      const user = fresh.ThemeInfos.find((t) => t.Name === USER_THEME) as ThemeInfoModel;
      const profile = newThemeProfile();
      this.#dataTheme = fresh;
      this.#cur = user;
      this.#curProfile = profile;
      this.#soft = newSoftConfig();
      this.#resolver.clear();
      const ok = await this.#io.run(async () => {
        await this.#wipeServeData();
        await this.#ensureThemeDirs();
        if (!(await this.#rawSaveDataTheme())) return false;
        // LoadCurProfile after the wipe: the file is missing, so the empty profile is saved.
        await this.#rawSaveProfile(profile, this.paths.profilePath(USER_THEME, user.SelProfileName as string));
        // Deviation B-11: the vendor kept the idle-lights settings in memory until restart while the UI
        // showed the defaults again; they are reset and written.
        await this.#rawSaveSoftConfig();
        return true;
      });
      if (!ok) {
        this.#initFailed = true;
        this.#emit('factory-reset');
        this.#log.debug('FactoryReset end');
        this.#log.error('InitEnviroment error');
        return error('InitEnviroment error');
      }
      await this.#resetParticipants('FactoryReset Reset');
      await this.#saveNow();
      this.#emit('factory-reset');
      this.#log.debug('FactoryReset end');
      return succ(true);
    });
  }

  /**
   * SO:257-277 (runs as a file-queue task). Safety net (port): the tree is wiped only when it really is
   * an "EvniaServe" directory; for any other configured root only the engine's own sub-trees (Theme,
   * Config, Cache) are removed.
   */
  async #wipeServeData(): Promise<void> {
    const root = this.paths.appData;
    const own = new Set(['Theme', 'Config', 'Cache']);
    const whole = basename(root) === SERVE_DATA_NAME;
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(root, e.name);
      if (e.isDirectory()) {
        if (e.name === LOGS_DIR_NAME) continue;
        if (!whole && !own.has(e.name)) continue;
        await rm(p, { recursive: true, force: true }).catch((err: unknown) => this.#log.error(`DelFolder ${p} failed`, err));
      } else if (whole) {
        await rm(p, { force: true }).catch((err: unknown) => this.#log.error(`DelFile ${p} failed`, err));
      }
    }
  }
}

/** T_Sync_Profile from a caller-supplied object (ambiglow), in canonical member order. */
function bindSyncProfileLoose(sync: { EffectDetailInfo: unknown; SyncDevices: unknown[] }): SyncProfileModel {
  const eff = sync.EffectDetailInfo;
  return {
    EffectDetailInfo: eff === null || eff === undefined ? null : bindBaseEffectDetailInfo(eff),
    SyncDevices: (sync.SyncDevices ?? []).map((d) => (d === null || d === undefined ? null : bindSyncDeviceInfo(d))),
  };
}

/** Composition-root factory (index.ts ServiceSlots.themes). */
export function createThemeStore(core: CoreServices, options: ThemeStoreOptions = {}): ThemeStoreImpl {
  return new ThemeStoreImpl(core, options);
}

/** services.themes when it is this engine (the slot is typed BackendService until the integration wave). */
export function isThemeStoreImpl(v: unknown): v is ThemeStoreImpl {
  return v instanceof ThemeStoreImpl;
}

const fallbackEngines = new WeakMap<object, ThemeStoreImpl>();

/**
 * The engine the api/ modules use: `services.themes` when the composition provides it (the normal
 * case: createBackend starts it before the monitors). Without it, one private engine per services
 * object is created and loads lazily on the first call, so Theme_*, Macro_* and Setting_* still share
 * one state; it is then never stopped (its timers are unref'ed).
 */
export function themeEngineFor(services: CoreServices & { readonly themes?: unknown }): ThemeStoreImpl {
  if (isThemeStoreImpl(services.themes)) return services.themes;
  let engine = fallbackEngines.get(services);
  if (!engine) {
    services.log.warn('No theme store in the service slots; the theme API uses a private one');
    engine = createThemeStore(services);
    fallbackEngines.set(services, engine);
  }
  return engine;
}
