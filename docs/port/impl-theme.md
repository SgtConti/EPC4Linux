# Implementation notes: `theme` (theme/profile engine, Theme_*, Macro_*, Setting_*, FactoryReset)

Module owner: theme. Sources: `port/src/backend/theme/*`, `port/src/backend/api/theme.ts`, `api/macro.ts`, `api/setting.ts`. Tests: `port/test/unit/theme/` (74 tests, about 2 s):

```
node --test "test/unit/theme/**/*.test.ts"
```

Specs: `docs/re/20-theme-profile-engine.md` (the main one, "20-theme"), `20-backend-host-tail.md` §2.4-2.5 (NotifyUISwitchTheme), §3 (catalog rows 2-5, 14, 107-118, 140-162), §5 (golden replies, steps 5, 8, 9, 10, 14, 18), §6.5/§6.7 (DataBasicInfo arrays); `12-equipment-option-entities.md` §3.8 (BasicInfo_Display). Ground truth is the decompiled code: `ThemeOper.cs` (TO), `SystemOper.cs` (SO), `GlobalOper.cs` (GO), `SerializedFileUtil.cs`, the Entity lib (`DataTheme`, `ThemeInfo`, `BindAppInfo`, `T_Theme_Profile`, `T_Profile`, `T_DeviceProfile_Base`, `T_Sync_Profile`, `SyncDeviceInfo`, `BaseEffectDetailInfo`, `MacroInfo`, `MacroDetail`, `SoftConfigInfo`, `DataBasicInfo`, `BasicInfo_Display`, `ButtonMenu*`), `PHLDisplay_Oper.AnalyseBasicInfo`, `Bridge.cs`, and the user's files in `port/test/fixtures/windows/EvniaServe/`.

No new dependencies. **No signature changes to `services.ts` or `types.ts`.** `services.ts` got doc comments only, marked "(Appended by theme/.)": the mutator guarantees on `saveParticipant`, `setSyncProfile` and `setSoftConfig`; the listener rule on `onSwitched`; and the time bound on `ProfileParticipant.applyProfileContent`/`resetToFactory` (§2.1). There is one optional, duck-typed host extension, `getForegroundApp()` (§3.4). It is declared in `theme/app-binding.ts` (`ForegroundAppHost`), not in `types.ts`.

---

## 1. Files

| File | Content |
|---|---|
| `theme/formats.ts` | Newtonsoft-compatible text codec (`newtonsoftStringify`, `serializeConfig`, `decodeConfigBytes`, `firstLine`, `parseConfigText`, `parseJsonText`), a small Newtonsoft binder (`bindObject`, converters), typed models + binders + ordered serializers for `DataTheme`/`ThemeInfo`/`BindAppInfo`, `T_Theme_Profile`/`T_Profile`/`T_DeviceProfile_Base`/`T_Sync_Profile`/`SyncDeviceInfo`/`BaseEffectDetailInfo`, `SoftConfigInfo`, `MacroInfo`/`MacroDetail`; file I/O (`loadConfigFile`, `saveConfigFile`, `writeFileAtomic`, `writeFileInPlace`, `isFile`, `isDirectory`) |
| `theme/names.ts` | `CheckFileNameValid` (vendor) and the port's `isValidName` (path safety of existing names), `isValidNewName` (new names), `findIgnoreCase`, `GenValidName`, `GetFileNameWithoutExtension`, `ChangeExtension`, SHA-1 icon names, `OrdinalIgnoreCase` equality |
| `theme/paths.ts` | `WorkspacePaths` (the vendor `WorkspacePath` rooted at `HostServices.serveDataDir`), `defaultAppTempDir()` (per-user `PATH_APP_TEMP`), file/dir name constants |
| `theme/device-types.ts` | `DeviceType`/`EquipmentType` tables, `[MainDeviceType]` folding (`getRealDeviceType`) |
| `theme/store.ts` | `ThemeStoreImpl implements ThemeStore` (services.ts): load/first-run, current theme and profile, participants, debounced saves, the concurrency model of §3.0, every ThemeOper/SystemOper theme operation returning the vendor `JsonResult`, SoftConfig, FactoryReset, profile-cycle notifications; `createThemeStore`, `themeEngineFor`, `isThemeStoreImpl`, `TARGET_INVOCATION_MSG`, `NOTIFY_UI_SWITCH_THEME`, `DEFAULT_PARTICIPANT_TIMEOUT_MS` |
| `theme/macros.ts` | `MacroOps`: the eleven file-level `Macro_*` operations |
| `theme/macro-menu.ts` | `makeMacroCmdMenuData()`: `Macro_GetFuncMenu` derived from the vendor tables (§5) |
| `theme/basic-info.ts` | `analyseDisplayBasicInfo` (PHLDisplay_Oper.AnalyseBasicInfo on the ProfileContent JSON), `buildDataBasicInfo` (SO smethod_22), `MonitorInfoTable` (DictMgr display table) |
| `theme/app-binding.ts` | `genAppIcon` (Comm_GenAppIcon via XDG icon lookup), `moveFile`, `pruneTempIcons`, `ForegroundApp`/`ForegroundAppHost` (optional host extension), `BindingResolver`/`findBoundTheme` (smethod_21 for Linux), `AppBindingWatcher` (CheckTopApp loop) |
| `theme/desktop-entry.ts` | Desktop Entry parsing (`[Desktop Entry]`, escapes, `Exec` quoting/field codes), `resolveCommand` (PATH), `desktopExecProgram`/`desktopExecCommand`/`desktopExecTarget`, Snap launcher names (`snapNameOfCommand`, `desktopSnapName`), `isInterpreter`, `isScript`, `scriptAppDirectories`, `desktopIdOf`, XDG data dirs, `.desktop` listing |
| `api/theme.ts` | `themeApi`: `Theme_*` (22 overloads) + `Comm_GenAppIcon` |
| `api/macro.ts` | `macroApi`: `Macro_*` (12 overloads) |
| `api/setting.ts` | `settingApi`: `FactoryReset`, `Setting_GlobalData`, `Setting_TurnOffLightsWhenIdle`, `Setting_TurnOffLightsWhenIdleDuration` |

## 2. Integration (what the composition root must do)

```ts
import { createThemeStore } from './theme/store.ts';
import { themeApi } from './api/theme.ts';
import { macroApi } from './api/macro.ts';
import { settingApi } from './api/setting.ts';

createBackend(opts, {
  services: (core) => {
    const themes = createThemeStore(core);          // options: see §3.1
    const monitors = createMonitorManager(core, { themes });   // registers the display participant
    return { themes, monitors, ambiglow };
  },
  modules: [systemApi /* without Setting_GlobalData */, themeApi, macroApi, settingApi, /* phl, effect, … */],
});
```

- **Use `api/system.ts` (`systemApi`), not the hub-rpc placeholder `api/system-minimal.ts`**: the placeholder also registers `Setting_GlobalData`, which `api/catalog.ts` assigns to the theme family, and the dispatcher throws on a duplicate registration (tested). `test/unit/api/coverage.test.ts` confirms that `themeApi` + `macroApi` + `settingApi` register the 40 theme-owned overloads exactly once.
- `ServiceSlots.themes` is typed `ThemeStore`; the API modules use `themeEngineFor(services)`, which returns `services.themes` when it is a `ThemeStoreImpl`. Without it they share one private engine that loads lazily (logged as a warning) — fine for registration-only tests, not for the app (no participant would ever register with it).
- `createThemeStore(core, options?)` ignores unknown option keys, so the contract composer's `factory(core, slotsSoFar)` call works as is.
- Start order is already right: `themes` starts before `monitors` (vendor `InitEnviroment` before the scan, 20-theme §4), so the monitor can read `getStoredContent()` during its connect. `api/system.ts` calls `themes.start()` again on every `Start`: it is idempotent and rejects with `InitEnviroment error` only while a fresh `DataTheme.cfg` cannot be written (then `Start` answers the vendor's 9 `InitEnviroment error`; the next call retries).
- `stop()` writes a pending save and stops the CheckTopApp timer.
- **`PATH_APP_TEMP` moved to a per-user directory** (20-theme §10.1): `theme/paths.ts` `defaultAppTempDir()` = `$XDG_RUNTIME_DIR/EvniaServe`, else `<os.tmpdir()>/EvniaServe-<uid>`. The main process must serve that same directory through `local:`. Today `main/index.ts` still hard-codes `privateRoots: [join(tmpdir(), 'EvniaServe')]`, which is not this module's file. Until it calls `defaultAppTempDir()` (or the composition passes one `appTempDir` to both), icons made by `Comm_GenAppIcon` do not display in the app picker. Icons of bound apps are moved into `Theme/<T>/Icon/`, which is already served, so bound themes are not affected.
- Optional host extension for app-bound themes (§3.4): `host.getForegroundApp?(): { exe, wmClass?, appId? } | null`. The X11 tracker in `main/foreground-app.ts` could read `WM_CLASS` in the same `xprop -id` call it already makes for `_NET_WM_PID`.

### 2.1 Contract for the display driver (monitor module) — `ProfileParticipant`

| Member | What the engine does with it | Vendor |
|---|---|---|
| `desc` | `{EquipmentType:1, DeviceType:100000, ModelName:<EDID monitor name, e.g. "PHL 34M2C8600">, ExtModel:""}`. The profile section is found by `DeviceType` + **ordinal, case-sensitive** `ModelName` (20-theme §5.4); Windows exports only apply if the name is identical. | `DeviceInfo` of the display |
| `purify()` | Called on every save for every registered participant; the string is stored verbatim as `ProfileContent` (must be `'profile'`-mode JSON: IgnoreProfile members and nulls dropped). An empty string is refused (vendor "content is empty!!!"). | `PurifyProfile()` (G0:168-171) |
| `applyProfileContent(c)` | On `Theme_Switch`/`Theme_SwitchApp`/`Theme_ApplyProfile`/`Theme_ImportProfile`(override current): the section of the **target** profile, or `null` when it has none (new profile). The target is already current when this is called. All participants run in parallel; errors are logged. Each call is **bounded** (`participantTimeoutMs`, default 60 s, below the dispatcher's 120 s watchdog). A call still pending then is logged as `DeviceType = … ParameterToDevice Error: no answer after … ms` and the operation completes without it. Afterwards the engine purifies everyone into the target profile and writes it. | `smethod_20` → `ParameterToDevice(content, bForce:true, needSave:false)`; for the display only the SmartImage/HDR group + Ambiglow are re-applied (20-theme §5.5, §6) |
| `resetToFactory()` | `Theme_ResetCurProfile` and `FactoryReset`: the current profile is cleared first, then every participant resets in parallel (bounded like apply), then everyone is purified and saved. | `Reset(needSave:false)` (VCP 0x04 = 1, 5 s, reload — B-3) |
| `saveParticipant(p)` | Call after every setting change and after each scan (vendor `SaveProfile()`). Saves are coalesced (250 ms). The promise resolves after the write of the then-current state and never rejects. **It never waits for a theme operation** (§3.0). It may be awaited anywhere: inside `DisplayDevice.exclusive()` while a `Theme_Switch` waits for that queue, and inside `applyProfileContent`/`resetToFactory`. | `EVT_Com.SaveCurThemeProfile` → `ThemeSaveCurProfiles` |
| `getStoredContent(desc)` | The current profile's section (or `null`) — what `DeviceDataCheck` reads at connect. | `GetProfileContent` |

Register the participant when the display connects and call the returned function when it disconnects (the vendor only saves *connected* devices).

A participant may call back into a theme **operation** while it is being applied (for example `Theme_SwitchApp` from inside `applyProfileContent`). That call runs inline, and the operation awaits it before releasing its lock, even if the participant did not await it. It can never overlap the next operation.

### 2.2 Other consumers

- **ambiglow**:
  - `getSoftConfig()` is synchronous and always current. Poll it in the 1 s idle check, like `GlobalOper.CheckIdle`.
  - `getSyncProfile()` returns the raw `Sync_Profile`: `{"EffectDetailInfo":null,"SyncDevices":[]}` on the user's machine, `null` on a fresh profile. That is exactly what `NotifyEffectSyncDevicesChange` sends after `Effect_Reset`.
  - `setSyncProfile()` normalizes to `T_Sync_Profile` order, applies the change to the current profile at once (visible to `getSyncProfile()` synchronously after the internal load) and saves.
  - `setSyncProfile()` and `setSoftConfig()` wait only for their own file write, **never for a theme operation**. It is therefore safe to await them inside `DisplayDevice.exclusive()` (the Effect_* sequences), even while a `Theme_Switch` waits for that queue.
  - `onSwitched` fires after `switch`, `switch-app`, `apply`, `import`, `reset` and `factory-reset` (vendor `CheckSoftEffect` points); `delete` is never emitted. Listeners run **after** the operation released the store's lock, outside its async context, and may call any store method. An operation started there queues normally. Another switch may already be queued, so read `currentThemeName()`/`getSyncProfile()` instead of trusting the event's names.
- **main process** (not this module): the renderer's app picker asks for `["exe"]` files. 20-theme §10.2 item 1 recommends that `fileSelect` swap that filter for a `.desktop` chooser in `/usr/share/applications`; `main/dialog-options.ts` does not do it yet. The backend accepts both `.desktop` files and executables.
- `Comm_GenAppIcon` writes to `defaultAppTempDir()` (option `appTempDir`); see the `privateRoots` note in §2. Icons of bound apps live in `~/.config/EvniaServe/Theme/<T>/Icon/`, which is already served.

## 3. How it maps to the vendor

### 3.0 Concurrency model (`store.ts` header)

The vendor had one lock, around `ThemeSaveCurProfiles` only (20-theme §8 "Races"); §10.1 asks for one mutex for the index and profile writers. A single lock around everything is not enough here. An operation holds the lock while it awaits the participants, and the display runs `applyProfileContent` on its single-flight `OpQueue` (`monitor/op-queue.ts`). Ambiglow's Effect_* sequences run on that same queue (`DisplayDevice.exclusive`). So a queue task awaiting a lock-taking store call would deadlock with the operation for good. The port therefore separates three things:

1. **Operations** (`Theme_*`, `Macro_*`, `FactoryReset`, `start`) run one at a time on the operation lock.
   - Work started inside the holder's async context runs inline, so a participant calling back cannot self-deadlock. It is registered with the hold and awaited before release, so it never overlaps the next operation.
   - `onSwitched` listeners run right after release, outside that context.
   - Participant calls are bounded (`participantTimeoutMs`, default 60 s), so the lock is always released.
2. **Mutators** (`saveParticipant`, `setSyncProfile`, `setSoftConfig`, `flush`) never take the operation lock.
   - They act on the in-memory current profile synchronously.
   - The current (theme, profile) pair only changes in one synchronous step (`#transition`, and the FactoryReset re-initialisation), so a mutator always sees a consistent pair.
   - A pending debounced save belongs to the profile being left. It is captured (purified and serialized) at the transition and written with the old path.
3. **Files**: every write of `DataTheme.cfg`, a `.pcenter` or `SoftConfig.data`, and every rename or delete that can move them, runs on one FIFO (`IoQueue`).
   - The queue waits for nothing but the file system, so waiting for it cannot deadlock.
   - Content and path are captured when a write is queued.
   - `Theme_Rename`/`Theme_RenameProfile` change the in-memory names in the same synchronous step that queues the directory or file move. A save captured before the move is written into the old place and moved with it; one captured after goes to the new place. There are never stray directories.
   - FactoryReset makes the fresh state current before it queues the wipe.

Read-only queries (`Theme_GetCurTheme`, `Theme_GetThemeInfos`, `Theme_GetCurProfile`, `Setting_GlobalData`) are served from memory without the lock, like the vendor (SO:2994-3007, Bridge.cs:23-26). They stay responsive while an operation waits for a slow display.

### 3.1 Store (`theme/store.ts`)

`createThemeStore(core, options)` takes these options:
- `saveDebounceMs`: 250 ms; tests use 0.
- `appWatchIntervalMs`: 1000 ms (vendor `RunPerSecondAtStart`).
- `participantTimeoutMs`: 60 000 ms; 0 means unbounded.
- `appTempDir`: defaults to `defaultAppTempDir(env)`.
- `env`: environment for XDG/PATH lookups.
- `selfExecutables`: default `[process.execPath]`.

| Vendor | Port |
|---|---|
| `ThemeOper.Init` + `ThemeInit(false)`: load `DataTheme.cfg`; if loaded → `Check()`, no save; else default `[{User}]` + `Check()` + save | `#themeInit(false)`; the first-run file is byte-identical to the user's (tested) |
| `InitEnviroment`: current theme = `User` (always), current profile = `LoadCurProfile()` (missing/unparsable → `{"Sync_Profile":null,"Profiles":[]}` saved) | `#load` at `start()` (and lazily on the first call), as the first file-queue task |
| `GlobalOper.method_0`: SoftConfig missing/unparsable → defaults, saved at once | `#loadSoftConfig` (at start, not at the first idle check — same file result) |
| `ThemeSaveCurProfiles`: purify connected devices into the current profile, write `Theme/<cur>/<Sel>.pcenter` and `DataTheme.cfg` | `#saveCurProfilesLocked` |
| `SystemOper.object_0` lock around `ThemeSaveCurProfiles` only | §3.0: operation lock (re-entrant, nested work awaited), lock-free mutators with synchronous transitions, one FIFO for all file writes and moves (fixes the §8 races without the deadlock a single lock would cause) |
| `T_Theme_Profile.GetProfileContent/SaveProfileContent/GetRealDeviceType/Check` | same names, same rules (`""` when absent; update keeps `EquipmentType`, sets `ExtModel`) |
| `CheckTopApp` every second after the first hub connection and scan | `AppBindingWatcher`, armed by the renderer's start-up `Theme_GetCurTheme`/`Theme_GetThemeInfos` (they follow `Start`); ticks only act when the foreground executable changes |
| `NextProfile`/`PreviousProfile`/`CycleUp`/`CycleDown`/`SpecificProfile` → `NotifyUISwitchTheme "<T>|<P>"` | `nextProfile()` … `specificProfile()` (no trigger on a monitor-only system; available for a tray/CLI) |

### 3.2 Bridge functions

Every overload is registered with the exact Bridge types and order, so wrong calls get the vendor's `params error: …` text (tested for `Theme_Switch`, `Theme_ImportProfile`, `Theme_GetDevicesBasicInfo`, `Setting_TurnOffLightsWhenIdleDuration`). Codes and messages are the vendor's, typos included (B-7: `ThemeAdd Error … Exist` from Rename, `ThemeCopyProfile … Not Valid` from AddProfile, `Error Error` in UpdateBindApp, two spaces in `…  LoadProfile=… Profiles is empty`, `not exit`).

| Function | Tag | Notes |
|---|---|---|
| `Theme_GetCurTheme()`, `Theme_GetThemeInfos()` | `ThemeInfo` / `[ThemeInfo]` | golden replies of §5 steps 5 and 8 are byte-identical (tested) |
| `Theme_GetCurProfile()` | in-memory `T_Theme_Profile`, nulls kept | never called by the renderer |
| `Theme_Switch(s,s)`, `Theme_SwitchApp(s)` | new current `ThemeInfo` | SO:3019-3059 check order; same theme+profile (case-insensitive) = no side effects; profile lookup case-sensitive; missing file created; participants applied; saved |
| `Theme_Add`, `Theme_Del`, `Theme_Rename`, `Theme_UpdateBindApp` | `[ThemeInfo]` | TO:41-152; bindings must point at existing files (`.desktop` or executable); temp icons moved to `Icon/<sha1(path)[0..10]>.png` |
| `Comm_GenAppIcon(s)` | temp icon path or `""` | §3.4 below |
| `Theme_AddProfile`, `Theme_CopyProfile`, `Theme_RenameProfile`, `Theme_DelProfile`, `Theme_HandleCycleProfile` | `[ThemeInfo]` | TO:268-501. New profile names must be unique ignoring case (6 `… Exist`). A case-only rename of a profile itself (`P2` → `p2`) is allowed. |
| `Theme_ImportProfile(s,s,b)` | `[ThemeInfo]` (after the re-apply) | TO:413-446; a Windows-exported `.pcenter` (BOM, one line) imports unchanged (tested with the user's file). With override, a name matching an existing profile ignoring case overwrites **that** profile; without override such a name gets `(n)`. |
| `Theme_ExportProfile(s,s,s)` | `null` | stored file re-serialized to exactly the path (byte-equal) |
| `Theme_ResetCurProfile()` | `null`, always success | participants' `resetToFactory` |
| `Theme_GetDevicesBasicInfo(i)`, `(s,s,i)`, `(s,i)` | `DataBasicInfo` | §3.3 |
| `Theme_GetProfileDesc(s)`, `(s,s)` | `{"Item1":<path>,"Item2":[T_DeviceProfile_Base]}` | sub-device types filtered |
| `Theme_ApplyProfile(s,s,s,s)` | `[ThemeInfo]` (serialized after the switch, as the vendor's live list) | implemented locally (TO:622-699); invalid `selDevices` JSON → 9 `Exception has been thrown by the target of an invocation.` (the dispatcher wraps the NullReferenceException; 20-theme §5.5 quotes the inner text) |
| `Macro_*` | vendor | §3.5 |
| `Setting_GlobalData()` | `{"TurnOffLightsWhenIdle":…,"TurnOffLightsWhenIdleDuration":…}` | golden §5 step 14 |
| `Setting_TurnOffLightsWhenIdle(b)`, `…Duration(i)` | `null` | `< 1` → 9 `at last 1 minutes`; file rewritten only on change |
| `FactoryReset()` | `true` / 9 `InitEnviroment error` | §3.6 |

### 3.3 `Theme_GetDevicesBasicInfo` (DataBasicInfo)

`SO smethod_22(bool_2:false)` over the stored profile (read from disk, after a pending save is written): every section, connected or not; sub-device types and `JiangMeng_Mouse_Dongle_8K` skipped; `-1` = all equipment types. Only the display has a driver in the monitor-only port, so `Display[]` is the only possibly non-empty list; `Keyboard`, `Mouse`, `MousePad`, `Headset` are always `[]` and `SyncEquipment` is `""` (the renderer calls `.filter` on each list, 20-backend-host-tail §6.5).

`BasicInfo_Display` comes from `PHLDisplay_Oper.AnalyseBasicInfo` evaluated on the ProfileContent JSON with the `T_PHLDisplay_Profile` field initializers as defaults (no dependency on the monitor module's classes), fields assigned in the vendor order inside one try (a vendor NullReference returns the partially filled object):
- `Connect`: a connected display (`services.monitors.displays()[].monitorName`) equals `ModelName` case-insensitively; `false` without a monitor manager.
- `LightSync`: `MonitorInfo.json` `SupLightSync` for the model (regex `^((PHL )|(PHL_)|(PHL))?<Name>$`, case-insensitive, first match; user copy in `appDataDir` wins over `resourcesDir` when its `Version` is not lower, as in `main/monitor-info.ts`) → `"On"` only if the display is in `Sync_Profile.SyncDevices` and there are ≥2 sync devices, else `"Off"`; no entry → `"/"`.
- `LightMode`: without ENE the `E2A0_19_AmbiglowLightMode_E` name of the stored E2A019 value (`AmbiglowOff` is unbound → `"/"`), with ENE `EffectInfo.CurrEffect.Name`.
- `Resolution`/`RefreshRate`: `DispalyData.MonitorResolution`/`MonitorFrequency`; `SmartImage`: SDR `ModuleSmartImage.Items` name of `OP_DC` (HDR → `"/"`); `AdaptiveSync`: E2A040 `"On"`/`"Off"`/`"/"`; `Input`: `ModuleInput.InputSourceList` name of `InputSourceInfo.InputSource`.

The user's profile gives exactly the golden reply of §5 step 18 (tested byte for byte).

### 3.4 App binding on Linux (20-theme §10.2)

- **`BindAppFilePath`** is whatever the picker returned: a `.desktop` file (app binding) or an executable. The vendor rule "the file must exist" is kept.
- **`Comm_GenAppIcon(path)`**: `""` unless `path` is an absolute path to an existing `.desktop` file or executable file (security review: the path comes from the renderer, and any other file is never opened). A `.desktop` file gives `Icon=`; an executable gives the `Icon=` of the desktop entry whose `Exec` launches it (scan of `$XDG_DATA_HOME` and `$XDG_DATA_DIRS` `applications/`, one sub-directory level). `Icon=` is an absolute image path or a name looked up in `hicolor` then `Adwaita` (`256x256` … `16x16`, `apps/` then `applications/`, then `scalable/*.svg`) under `$XDG_DATA_HOME/icons`, `$XDG_DATA_DIRS/icons`, `~/.icons`, then `/usr/share/pixmaps`. Only png/svg/jpg/gif/webp/bmp/ico ≤ 5 MiB are used (XPM cannot be shown). The copy goes to `PATH_APP_TEMP/<unix seconds>[_n].png|.svg`. No icon → `""` (the renderer shows a blank icon; vendor failure value).
- **CheckTopApp** input: the foreground app is `host.getForegroundApp?.()` when the host offers that optional extension (`{exe, wmClass?, appId?}`), else `{exe: HostServices.getForegroundAppPath()}`. On X11 that is the exe via `_NET_WM_PID`; on Wayland it is `null`, so the feature is inert.
- **Matching**: themes are checked in index order and the first match wins. A binding matches when one of these holds (20-theme §10.2 item 5):
  1. the same path, ignoring case (vendor rule);
  2. for a `.desktop` binding: the window's `WM_CLASS` or `app_id` equals the desktop-file ID (basename without `.desktop`) or the entry's `StartupWMClass`, ignoring case. This needs the host extension. A Flatpak app id reported as `appId` matches its exported `.desktop` the same way.
  3. the real path of an executable binding, or of what the entry's `Exec` runs, is the foreground binary. `Exec` is taken after `env [-opts] VAR=…` wrappers, a PATH lookup and realpath. Interpreters are excluded: `python*`, `perl`, `ruby`, `node`, `java`, `mono`, `wine`, `sh`/`bash`/…, `flatpak`, `snap`, `electron`, `xdg-open`. Their binary runs many programs, so they would bind them all.
  4. the `Exec` target (or the binding) is a **wrapper script** (`#!`) inside an application's own directory, and the foreground binary lives in that directory, or in `<app>/` for `<app>/bin/<script>`. Examples: Chrome's `/opt/google/chrome/google-chrome` runs `/opt/google/chrome/chrome`; VS Code's `/usr/share/code/bin/code` runs `/usr/share/code/code`. Directories shared by many programs never qualify: fewer than three levels deep (`/usr/bin`, `/opt/google`), `/usr/local/*`, `~/bin`, `~/.local/*`, `~/Desktop`, `~/Downloads`, multi-arch lib dirs.
  5. a **Snap launcher** `/snap/bin/<name>[.<app>]` and the foreground binary lives under `/snap/<name>/`. The launcher is recognised as written, including snapd's `Exec=env BAMF_DESKTOP_FILE_HINT=… /snap/bin/firefox %U`, and through PATH (`Exec=firefox` resolving to `/snap/bin/firefox`). This check runs before realpath, which would only give `/usr/bin/snap`.
- **Caching**: resolution results are cached 30 s and refreshed after `Theme_UpdateBindApp`.
- **Notification**: `NotifyUISwitchTheme` with `Tag` = theme name or `"User"`. It is sent only when that differs from the current theme and the foreground app (exe + WM_CLASS + app_id) changed. The renderer then calls `Theme_SwitchApp`; the backend never switches by itself.
- **Self**: this app never triggers, whether identified by its own executable or by `evnia-precision-center` as binary name, WM_CLASS or app_id.
- **Asked only while it can matter** (data minimisation, security review). A `CheckTopApp` tick asks the host for the foreground app only while some theme has a bound app, or while a theme other than "User" is current (the vendor then switches back to "User" on the next foreground change, SO:3317-3323, which the port keeps). Otherwise the tick asks nothing, forgets the last app, and calls the optional `ForegroundAppHost.releaseForegroundApp()` once. Electron main then ends its `xprop -spy` child, and the next query starts it again. The notifications are the vendor's in every case: with "User" current and no binding, every answer would have been "User". Test: `api-theme.test.ts` "CheckTopApp asks the host … only while the answer could matter".

### 3.5 Macros (`theme/macros.ts`)

`Macro_GetList` returns `[{MacroName, IsComMacro}]` in creation-time order (`birthtime`, else `mtime`), `[]` without `Macro/`; unknown theme → 3 `Theme=<t> path=<Theme dir>/<t> not exit`. `Macro_GetDetail` ×2, `Macro_VerifyFile`, `Macro_Add` (writes `{"Name":n,"MacroContent":[],"IsComMacro":true}`), `Macro_Copy`, `Macro_Rename`, `Macro_Update` (whole-string JSON; Tag = the stored macro with the computed `MacroTypeName`/`MacroActionName`/`IsComMacro`), `Macro_Del`, `Macro_Import`, `Macro_Export` (`ChangeExtension(path, ".macro")`) follow SO:2012-2528 with the vendor texts. The profile-rewrite loops that follow Rename/Update/Del/Import in the vendor only act through peripheral `IButton` drivers; with none they only re-saved profiles unchanged (and wrote the current profile under the wrong theme, B-8), so they are skipped.

**`Macro_GetFuncMenu`** — the 20-enum catalog lacks fixture D.5, so the menu is derived in `theme/macro-menu.ts` by porting `GlobalOper.MakeMacroCmdMenuData` (GO:232-279) over transcriptions of its inputs: `SystemOper.smethod_17`'s 49 `SupportButtonFunc` entries (SO:2554-2842), `ButtonMenu`/`ButtonSubMenu_AppUser`/`ButtonExtFunc` through `Extension_Enum.GetDatas` (unbound members skipped, `[Description]` text, sorted by value), the `ButtonFunc` names/values/descriptions (EN/ButtonFunc.cs:419-515) and the entity member order (`ButtonMenuItem.ChildList` and `ExtEnumItem.ExtData` before `Name/Text/Value`; `ButtonMenuData.ExtFuncDef` initialised from `ButtonExtFunc`). LaunchProgram (9) yields one item per function, Media (10) one item with 7 children, AppUser (12) one item per sub-menu. The result equals the vendor reply of 20-backend-host-tail §5 step 9 byte for byte (Tag 4025 characters / 4161 bytes; the reply is stored in `test/unit/theme/fixtures/macro-getfuncmenu.reply.json`). Built once and cached, like `buttonMenuData_0`.

### 3.6 `FactoryReset` (20-theme §7)

1. **Wipe**: every file directly in the EvniaServe directory and every sub-directory except `logs` are deleted. The backend log directory `~/.config/EvniaServe/logs` survives, as on Windows. `Config/data.json` (the capability cache) goes too, as in the vendor.
2. **Re-init**: `InitEnviroment(reset:true)` writes a fresh `DataTheme.cfg` and an empty `User/Default.pcenter`, plus the default `SoftConfig.data` (B-11). The fresh state becomes current in memory before the wipe is queued (§3.0).
3. **Devices**: participants run `resetToFactory()` in parallel (bounded), then everything is saved. Tag `true`.

A failure to write `DataTheme.cfg` gives 9 `InitEnviroment error`. The in-memory state is then still the fresh one: `User/Default`, an empty profile, the default SoftConfig. The vendor instead kept pointing at the wiped theme while its index listed only `User`. Participants are not reset (vendor), `onSwitched('factory-reset')` fires so consumers re-read, and every later `start()` (renderer `Start`) retries writing `DataTheme.cfg` and the current profile, as after a failed first run.

### 3.7 Formats (20-theme §3)

- Writer: UTF-8 BOM + compact JSON in C# member order, nulls kept in wrappers (ProfileContent is stored as the participant's string), no newline; `\u0085`, `\u2028`, `\u2029` escaped like Newtonsoft.
- Reader: BOM detection (UTF-8, UTF-16 LE/BE, UTF-32 LE/BE, none), **first line only**, Newtonsoft binding rules (exact then case-insensitive member names, last duplicate wins, JSON `null` keeps the initializer, unknown members ignored, enums from integers or names, a type mismatch fails the whole load → `null`).
- Proven byte-identical round trips on the user's `DataTheme.cfg` (156 B), `Default.pcenter` (12 401 B, including the 10 737-character nested ProfileContent) and `SoftConfig.data` (68 B).

## 4. Deviations from the vendor (deliberate)

1. **Atomic writes** (temp file in the same directory, fsync, rename, directory fsync) instead of truncate-and-write (B-4). Exception: an existing `.macro` file is rewritten in place (still fsync'ed) so its creation time — the list order — survives an edit.
2. **Debounced participant saves** (250 ms, 20-theme §10.1): a slider drag rewrites the 12 KB profile once instead of per step. A pending save is written before any operation that reads profile files or changes the current profile, and on `stop()`.
3. **Concurrency model of §3.0** instead of the vendor's unsynchronized ThemeOper (§8 races). This covers the operation lock, lock-free mutators, the file FIFO, participant timeouts, and listeners after release. Read-only queries stay lock-free as in the vendor.
4. **Names**:
   - `.` and `..` are invalid everywhere. B-1: `Theme_Add("..")` deleted the whole EvniaServe tree.
   - **New** theme, profile and macro names also reject a leading or trailing space or dot (20-theme §10.1). Win32 strips a trailing one, and a leading dot hides the file on Linux. Names in an existing (Windows) index are only checked for path safety, so no user profile is dropped at load.
   - New profile names must be unique ignoring case (§10.1, B-10: a Windows file system cannot hold `Default` and `default`). `GenValidName` compares ignoring case too.
   - `Theme_ImportProfile` with override onto a case-variant of an existing profile overwrites that profile. The vendor added a second list entry sharing the file on Windows, and a second file on Linux.
   - A case-only rename of a profile itself is allowed.
   - Macro functions validate theme and macro names before building paths. The vendor did not, so `../..` escaped `Theme/`.
   - Errors keep the vendor codes and texts ("Not Valid" / "Exist" / "not exit" / "save error").
   - The 30-character limit of §10.1 is not enforced. The renderer's inputs already cap names (30 for themes and profiles, 50 for macros), and an imported file name must not silently become `Default(n)`.
5. **Case-sensitive file system**: theme names are resolved case-insensitively to their canonical directory for every path (the vendor used the caller's spelling, which only worked on NTFS).
6. **Load-time repairs** of `DataTheme.cfg` (20-theme §4 "Repairs"): null or invalid entries dropped, case-insensitive duplicate themes dropped (first kept), `IsDefault` only on `User`, `SelProfileName ∈ ProfileNames`, `CycleProfileNames ⊆ ProfileNames` without duplicates, invalid profile names dropped, Windows-path bindings (`C:\…`) dropped. An unparsable `DataTheme.cfg` is renamed to `DataTheme.cfg.corrupt-<ms>` before the default replaces it (the vendor overwrote it silently).
7. **Import override with an invalid file name** (Linux file names may contain `|` or `:`; `|` breaks the header selector): goes through `GenValidName` like a non-override import.
8. **App binding**: in addition to the vendor's path equality, bindings match by desktop-id, StartupWMClass or app_id (when the host reports them), Exec realpath (interpreters excluded), wrapper-script directory, and Snap (§3.4). This app is never bound (`Theme_Add`/`UpdateBindApp` ignore it) and never triggers a switch (vendor bug 13 §4.3).
9. **Icons**:
   - A temp icon is only moved when it really is inside `PATH_APP_TEMP`. The vendor moved any path containing that substring.
   - Only icons inside the theme's `Icon/` or `PATH_APP_TEMP` are deleted when an app is unbound. The vendor deleted any renderer-supplied path.
   - An SVG keeps `.svg`.
   - Two icons made in the same second get `_1`, `_2`… The vendor overwrote.
   - `PATH_APP_TEMP` is per user (`$XDG_RUNTIME_DIR/EvniaServe`, else `<tmp>/EvniaServe-<uid>`, 20-theme §10.1) and must be a directory owned by the user. A shared `/tmp/EvniaServe` would have served only its first owner, and any local user could have pre-created it to disable icons.
   - Temp icons older than 24 h are pruned at start. The vendor never removed them.
10. **FactoryReset**:
    - It resets the in-memory SoftConfig and rewrites `SoftConfig.data` with the defaults (B-11: the vendor kept idle lights-off active while the UI showed it off).
    - On `InitEnviroment error` the in-memory state is the fresh one, consistent with the index; `start()` retries the write.
    - It wipes the whole directory only when it is named `EvniaServe`. For any other configured root only `Theme/`, `Config/`, `Cache/` are removed.
11. **Macro_Copy without a new name** picks a free name among the macros (the vendor looked at the theme's profile files and could overwrite an existing macro); `Macro_GetList` lists `*.macro` files only.
12. **Macro profile-rewrite loops skipped** (no `IButton` drivers; avoids B-8).
13. **Strict JSON** (no comments/single quotes/trailing commas) for files and request parameters; lone UTF-16 surrogates are escaped by `JSON.stringify` where Newtonsoft wrote them raw (invalid UTF-8 either way).
14. **Host path policy for renderer-supplied file paths** (security review; `HostServices.pathAllowed`, types.ts). The vendor read and wrote any path the renderer sent:
    - `Theme_ExportProfile` wrote exactly the given path, creating directories;
    - `Macro_Export` wrote any `<path>.macro`;
    - the imports, `Theme_GetProfileDesc(path)`, `Theme_GetDevicesBasicInfo(path, eq)`, `Theme_ApplyProfile`, `Macro_GetDetail(file)` and `Macro_VerifyFile` parsed any file and returned parts of it.

    When the host has a policy, the store asks it first: `read` before those reads, `write` before the export writes. For `Macro_Export` the check is on the path really written, `ChangeExtension(path, ".macro")`. A refusal gets the vendor's own error for that function, so the reply shapes do not change:
    - `ThemeExportProfile SaveTXTConfig Error`, `Macro_Export save file error`;
    - the code-8 "Not Exist" texts of the theme functions, `file=… not exit` (3), `MacroImport filePath=… is not exit`;
    - `Macro_VerifyFile` → `false`; `Theme_GetDevicesBasicInfo(path)` and `Theme_ApplyProfile` behave as with a missing file.

    Electron main allows reads of dialog picks and of the app's data directories, and writes to the path just chosen in the export dialog (once) or a `<userData>/<name>.pcenter|.macro` temp file (impl-electron-shell "Backend file arguments"). Without a policy (`serve.ts`, the CLI, the contract tests) nothing changes. Tests: `path-policy.test.ts`.

Kept on purpose (compatibility): startup theme always `User`; profile *lookups* stay case-sensitive as in the vendor (`Theme_Switch("User","p2")` → "not contains"; only uniqueness of new names ignores case, item 4); `Theme_ResetCurProfile` = monitor factory reset through the participant (B-3; the decision is the participant's); the renderer maps import/export error 5 to the macro text (B-6); the error-text typos (B-7); unsigned `data.json` handling is the ddc module's.

## 5. Limitations

- GNOME Wayland: no foreground executable → CheckTopApp is inert (20-theme §13 Q5). Flatpak apps cannot be matched from `/proc/<pid>/exe` (sandbox paths). Their exported `.desktop` matches only when the host reports the window's `app_id`/`WM_CLASS` or Flatpak id through `getForegroundApp()`.
- Without the `getForegroundApp()` host extension (not implemented by `main/foreground-app.ts` yet), only the exe rules apply. Some apps then never match:
  - launchers that are wrapper scripts in a **shared** directory: Fedora's `/usr/bin/firefox`, Debian's `/usr/games/steam` (they exec a binary elsewhere);
  - apps started through an interpreter (`python3 app.py`, `java -jar`): excluded on purpose, since matching the interpreter would bind every program it runs.

  With `WM_CLASS` reported, all of these match through `StartupWMClass` or the desktop-file ID.
- The desktop-file ID is the file's basename; the spec's `<subdir>-<name>` IDs for entries in `applications/` sub-directories are not formed.
- The wrapper-script rule treats every binary in the script's application directory as that app (for example `/opt/google/chrome/*`). That is intended for app-private directories and never applied to shared ones.
- A participant call that times out keeps running in the background (it cannot be cancelled). Its late result is only logged. The operation has already saved the state it had.
- Icon lookup covers `hicolor` and `Adwaita` only (the user's current icon theme is not read, no gsettings dependency).
- Macro order uses `birthtime` when the file system reports it (statx), else `mtime` (an edited macro then moves to the end).
- `Theme_GetDevicesBasicInfo` only analyses display sections; peripheral sections of a foreign profile are ignored (no drivers).
- `getForegroundAppPath` is polled once per second (vendor period); a focus change shorter than that can be missed.

## 6. Tests (`port/test/unit/theme/`)

| File | Covers |
|---|---|
| `formats.test.ts` | byte-identical round trips of the three real files (and the nested ProfileContent), first-line rule, null/empty/invalid loads, BOM detection, Newtonsoft binding rules, escaping, atomic/in-place writes, macro JSON, name helpers (incl. `isValidNewName`, case-insensitive `GenValidName`), icon hashes of §3.4 |
| `store.test.ts` | first-run files, start-up on the user's files, startup theme always User, debounced/coalesced saves, `stop()` flush, save from inside apply, SoftConfig persistence and repair, Sync_Profile get/set, switch applies/saves participants + events, corrupt index kept aside, load-time repairs, `InitEnviroment error` on an unwritable tree and retry |
| `store-concurrency.test.ts` | §3.0 with the real `monitor/op-queue.ts` `OpQueue`: a display-queue task awaiting `setSyncProfile`/`saveParticipant`/`setSoftConfig`/`flush` while `Theme_Switch` waits for that queue (the reviewer's deadlock), a save pending before `Theme_Switch`/`Theme_ResetCurProfile` awaited from the queue, a participant that never answers (bounded; switch, reset, FactoryReset and later calls complete), read-only queries answered while a switch holds the lock, listeners after release (an operation started by a listener queues behind the next switch; a mutator applies to exactly one profile; memory = disk), a debounced edit (`saveDebounceMs` 10 s) written into the profile being left before Switch and read by Copy/Export/Import, rename of the current theme racing a save (no stray directory), rename of the current profile with a pending save, FactoryReset `InitEnviroment error` (in-memory state, participants untouched, event, `start()` recovery) |
| `app-binding.test.ts` | snapd's `env BAMF_DESKTOP_FILE_HINT=… /snap/bin/firefox %u` Exec, `/snap/bin/<snap>.<app>` names, a relative Exec resolved through PATH into `/snap/bin` (needs a writable `/snap/bin`: runs as root in the dev container, skipped otherwise), interpreters never matched, wrapper scripts (Chrome layout, VS Code `bin/` layout, `~/.local/bin` not claimed), WM_CLASS/app_id via the host extension (StartupWMClass, desktop-id, self), per-user `PATH_APP_TEMP` |
| `api-theme.test.ts` | golden replies (§5 steps 5, 8, 18), every Theme_* success and error path with exact codes/texts, params-error texts, new-name rules (leading/trailing space or dot, case-insensitive profile uniqueness, case-only self-rename, import override onto a case-variant), Windows `.pcenter` import, export bytes, reset, ApplyProfile, Comm_GenAppIcon (absolute icon, hicolor name, SVG, executable → desktop entry, none), CheckTopApp with a fake foreground provider (desktop Exec binding, User fallback, exe binding, self), the armed 1 s loop, profile-cycle notifications, hardening |
| `api-macro.test.ts` | golden `Macro_GetFuncMenu` (4311-byte reply) and `Macro_GetList`, every Macro_* path, creation-time order |
| `api-setting.test.ts` | golden `Setting_GlobalData`, setters, `at last 1 minutes`, FactoryReset (wipe except logs, fresh files, participants reset, SoftConfig reset, events), non-EvniaServe root safety, duplicate-registration guard |
| `path-policy.test.ts` | `HostServices.pathAllowed` (security review): exports to a path never chosen are refused with the vendor error and create nothing (not even directories), `Macro_Export` checks the `.macro` path it writes; imports, descriptions, previews, `Theme_ApplyProfile`, `Macro_GetDetail(file)` and `Macro_VerifyFile` of an unpicked file read as missing; picked files work; no policy = unchanged; `Comm_GenAppIcon` ignores files that are neither `.desktop` nor executable |

The theme-owned steps of the contract fixture `test/contract/fixtures/golden-2026-09-26.json` (steps 5, 8, 9, 10, 14, 18) were also replayed against this module with the bundled `build/vendor-data/MonitorInfo.json` and a connected "PHL 34M2C8600": all six replies are identical (the full contract replay runs once the monitor and ambiglow modules exist).
