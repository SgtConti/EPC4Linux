# Implementation notes: integration (backend composition, contract tests, smoke server)

Module owner: integration. Sources: `port/src/backend/compose.ts` (new), `port/src/backend/index.ts` (composition root), `port/src/backend/serve.ts` (new); `port/src/backend/api/system-minimal.ts` is **removed**. Tests: `port/test/contract/` (`golden-transcript`, `lifecycle`, `serve` and their helpers `compose.ts`, `replay.ts`, `golden.ts`, `compare.ts`), `port/test/unit/api/coverage.test.ts`, `port/test/unit/hub/backend.test.ts`.

```
MSYS_NO_PATHCONV=1 docker run --rm -v "C:\path\to\repo:/repo" -w /repo/port evnia-port-dev \
  bash -c 'npx tsc -p tsconfig.json && node --test "test/unit/**/*.test.ts" "test/contract/**/*.test.ts"'
```

State at the end of this wave: typecheck clean; 767 unit + contract tests, 767 pass, none skipped or `todo` (about 28 s; the contract files alone are 56 tests, about 27 s, because they run the driver's real sleeps: 1000 ms per SmartImage change, 5000 ms per VCP 0x04 reset and per `Device_DetectionDisplay`).

Specs: `docs/re/20-backend-host-tail.md` (§1.4 wire order, §2.4-2.5 notifications, §5 golden transcript, §6 connected-monitor rules, §7 minimal backend and `Start` timing), `20-theme-profile-engine.md` (§5.5 and §6 theme-switch writes, §7 FactoryReset), `20-enum-valuelist-catalog.md` (§5 Tag, §6.1-6.3 static Tags), `03-renderer-monitor-pages.md` §5 (flows), `09-ambiglow-lighting.md` §5-6 (ENE registers), `01-electron-main.md` §9 (hotplug). Ground truth for the reset and theme-switch writes: `work/dotnet-clean/…/CDevice_PHLDisplay.cs` (`ParameterToDevice` :585-614, `method_10` :616-673, `method_12`, `SetSmartImage` :1675-1720), `GClass0.cs` :201-235.

---

## 1. Files and public API

| File | Exports |
|---|---|
| `src/backend/compose.ts` | `API_MODULES` (frozen, the 11 Bridge modules), `DefaultServices` (the three concrete classes), `DefaultCompositionOptions`, `createDefaultServices(core, options?)`, `defaultComposition(options?)`, `describeHardware(options)` |
| `src/backend/index.ts` | unchanged API plus: `createBackend(options, composition = defaultComposition())`, `BackendComposition.afterStart`, `createDefaultBackend(options, overrides?)` → `DefaultBackend` (`Backend` + `services: DefaultServices`), `APP_RENDERER_ORIGINS` (`['file://']`, the default `allowedOrigins` of `startHubServer`); re-exports `API_MODULES`, `createDefaultServices`, `defaultComposition`, `describeHardware` and the two types |
| `src/backend/serve.ts` | `serve(options)` → `ServeHandle {port, token, url, serveDataDir, hardware, backend, close()}`, `main(argv, io?, stopSignal?)`, `parseServeArgs(argv)`, `DEFAULT_RESOURCES_DIR`; runnable as `node src/backend/serve.ts` |
| ~~`src/backend/api/system-minimal.ts`~~ | removed: `Start` is `api/system.ts`, `Device_GetConnectList` `api/device.ts`, `Setting_GlobalData` `api/setting.ts` |

No new dependencies. No changes to `types.ts` or `services.ts`.

## 2. The production composition (`compose.ts`)

```ts
createBackend({ host, usb, mockMonitor })          // Electron main (src/main/backend-host.ts), unchanged
  = createBackend(options, defaultComposition())
      services: themes   = createThemeStore(core)
                monitors = createMonitorManager(core, { themes })
                ambiglow = createAmbiglowService(core, { themes, monitors })
                monitors.bindAmbiglow(ambiglow)
      modules:  API_MODULES = [systemApi, stubsApi, phlApi, deviceApi, profileApi, displayFwApi,
                               themeApi, macroApi, settingApi, effectApi, syncEffectApi]
      afterStart: re-enumerate the displays on a restart (§2.3)
```

- **Order.** `createBackend` starts the slots themes → monitors → ambiglow and stops them in reverse (SystemOper.Start: InitEnviroment before the scan, SystemOper.cs:107-133). The ambiglow service needs the manager (`driverFor`, the mock USB bus), and the manager must call `AmbiglowService.attach()` after every load, reload, profile apply and reset of the current display and `checkEne()` at the top of every full read (vendor `method_14`/`method_17`, PHL/CDevice_PHLDisplay.cs:328). So the manager is created first and the service is bound late with `bindAmbiglow`. Without that binding the display never learns about its ENE: the first `Profile_GetDeviceData` reports `ENEEffectEnable: false` with an ENE plugged in and the renderer shows the DDC Ambiglow page (impl-monitor §4). The contract test "ENE present" checks the first read already reports ENE mode.
- **`createBackend` semantics.** Without a composition argument it is the production backend. An explicit composition is used as given: no services unless it builds them, `API_MODULES` unless it lists modules. That keeps every existing test composition (partial modules, contract-only doubles) unchanged. `createDefaultBackend(options, overrides)` is the production backend with `services` exposed as the concrete classes; `serve.ts` and the contract tests use it. `DefaultCompositionOptions` passes options through to the three factories (`themes`, `monitors`, `ambiglow`), replaces `modules` or `dispatcher`, and `onServices` sees the services before anything starts.
- **Every Bridge overload exactly once.** `API_MODULES` registers the 162 overloads of `api/catalog.ts` exactly once (`coverage.test.ts`: the list itself through a `RecordingRegistry`, and three live backends — `createBackend(options)`, `createBackend(options, defaultComposition())`, `createDefaultBackend(options)` — probed with `auditBackend` without running a handler). `API_MODULES` is also checked to be exactly the exported module of every `api/` file, in catalog-owner order (system, stubs, monitor, theme, ambiglow).

### 2.1 Hardware selection (`BackendOptions`, ARCHITECTURE rule 7)

The services decide; the composition only passes the options through and logs one line (`backend composition: <describeHardware(options)>`).

| Options | Monitors | ENE |
|---|---|---|
| `mockMonitor: '34M2C8600'` | simulated monitor behind a fake VIA bridge (USB 3-2.4) and fake `/dev/i2c-5`, temporary sysfs | simulated ENE MCU on the same fake bus, USB 3-2.1 |
| `mockMonitor: '34M2C8600/no-ene'` | same | none: the user's 2026-09-26 golden session |
| `noHardware` without `mockMonitor` | none | none, **even when `usb` is given** (the composition passes `usb: null` to the ambiglow service; on its own the service prefers a given `usb` over `noHardware`) |
| neither | real: `BackendOptions.usb` (one `LibusbBackend` per process, shared by VIA and ENE), `/sys`, `/dev/i2c-*` | real ENE through the same `usb` |

A mock monitor wins over `noHardware` (the simulated devices are not real hardware); the contract tests pass both.

### 2.2 Typing of the slots

`DefaultServices` types the production services as `ThemeStoreImpl`, `MonitorManagerImpl`, `AmbiglowServiceImpl`; `createDefaultBackend(...).services` and `DefaultCompositionOptions.onServices` get those. `ServiceSlots` (what `ApiModule`s see) **stays typed by the `services.ts` contracts**: the api/ modules are written against the contracts and resolve the concrete engines themselves (`themeEngineFor`, `ambiglowEngineFor`, `monitorsOf`), and about a dozen test compositions of the other modules (`test/unit/{api,monitor,ambiglow,hub}`) hand in contract-only doubles, which a slot narrowed to a class with `#private` members would reject. Narrowing the slots would have meant editing those modules' tests (one of them under concurrent review) for no runtime gain.

### 2.3 Restart (`afterStart`)

`api/system.ts` latches a completed `Start` (vendor `bool_0`), while `MonitorManager.stop()` disposes every display. After `backend.stop()` + `backend.start()` the renderer's reconnect `Start` would reply at once with no display left (impl-api §6). The vendor never had this state: its latch lived and died with the EvniaServe process. `BackendComposition.afterStart(services, {restart})` runs at the end of every start phase (awaited by `backend.start()`, failures logged, `start()` never rejects); the default composition runs `monitors.scan('all')` there when `restart` is true **and** an earlier run had scanned (`MonitorManager.onChanged` fired). A backend restarted before any `Start` scans nothing until `Start`, as in the vendor. Electron main creates one backend per app lifetime, so this only matters for embedders and tests; after the restart the mock environment is rebuilt, so a simulated monitor starts from its seeds again.

### 2.4 Hub default origin

`startHubServer` now defaults `allowedOrigins` to `APP_RENDERER_ORIGINS = ['file://']` (impl-hub-rpc §4 and §7 asked Electron main to pass exactly that; `src/main/backend-host.ts` did not). The raw server default (`hub/security.ts ALLOWED_ORIGINS`: `file://` and `null`) is unchanged for direct `startSignalRServer` users. `Origin: null` comes from opaque origins any web page can create, and the vendor renderer loaded with `loadFile` sends `file://` (probed, impl-hub-rpc §4). Non-browser clients send no Origin and are admitted as before. Tested in `test/unit/hub/backend.test.ts`; the e2e run (vendor UI) connects with it.

## 3. Integration open issues from the other notes, resolved here

| Source | Item | Resolution | Checked by |
|---|---|---|---|
| impl-api §5 item 1, impl-hub-rpc §7, impl-monitor §5 item 2, impl-theme §2 | `API_MODULES` = every module, `system-minimal.ts` dropped (its `Device_GetConnectList`/`Setting_GlobalData` duplicated `deviceApi`/`settingApi`) | `compose.ts API_MODULES`; file removed; the hub tests use a test-local startup fixture instead, `test/unit/theme/api-setting.test.ts` a local duplicate registration | `coverage.test.ts` (strict, no `todo` left) |
| impl-api §5 item 2, impl-monitor §5 item 1 | ambiglow service handed to the monitor manager; Electron main called `createBackend` without services | `bindAmbiglow` in `createDefaultServices`; main needs no change (`createBackend(options)` is now the production backend) | contract "wiring", "ENE present" |
| impl-api §5 item 5 | `compose.ts` test hook with a late-bound stand-in | removed: the contract tests build `createDefaultBackend`, observe `services.ambiglow.display` instead of recording `attach` calls, and select the ENE state with `mockMonitor` instead of unplugging it before discovery | all contract tests |
| impl-api §2 contracts, impl-theme §2 | `ThemeStore.start()` idempotent although the lifecycle and every `Start` call it | holds: one load | `lifecycle.test.ts` "ThemeStore.start() loads once" (a corrupted `DataTheme.cfg` written after `backend.start()` is neither reloaded nor set aside by `Start`) |
| impl-api §2 contracts | `scan('all')` resolves after enumeration; `Device_GetConnectList` never waits for the scan | holds | golden step 2/3 timings; `system.test.ts` "D2 end to end" |
| impl-api §6 | `Start` after `stop()`/`start()` replies without rescanning | `afterStart` re-enumeration (§2.3) | `lifecycle.test.ts` two restart tests |
| impl-monitor §5 item 4 | one `LibusbBackend` per process | main passes its shared instance as `usb`; `serve.ts` does the same; `noHardware` keeps the ENE off a given `usb` | §2.1 |
| impl-monitor §5 item 5 | ambiglow service answers `checkEne`, calls `setEneModel` on USB changes | wired through `bindAmbiglow` | contract "ENE present" (first read in ENE mode; unplug/replug notifications) |
| impl-hub-rpc §7 | Electron main should pass `allowedOrigins: ['file://']` | default of `startHubServer` (§2.4) | `test/unit/hub/backend.test.ts` |
| impl-theme §2 | `PATH_APP_TEMP` must be the directory main serves through `local:` | `DefaultCompositionOptions.themes.appTempDir` can carry one directory for both; main still hard-codes `join(tmpdir(), 'EvniaServe')` in `privateRoots` — **open, main's file** | — |

## 4. Contract tests (`test/contract/`)

All composed tests build the **production** backend: `compose.ts composeMockBackend({ ene? })` = `createDefaultBackend({ host, mockMonitor: '34M2C8600/no-ene' | '34M2C8600', noHardware: true })` with the user's `EvniaServe/` and `evnia/` fixtures copied to a temp dir, `resourcesDir = build/vendor-data` (`npm run import-ui`; the only skip reason when missing), the user's display mode (3440x1440/175Hz/0°), idle 0, no capture host. Nothing is wired test-locally. Observations go through the exposed services and the simulated hardware (`services.monitors.mockHardware`: the monitor's received frames and control values, the fake USB bus, the ENE MCU registers).

The one composition option the tests pass is the simulated monitor's identity (security review): the shipped mock has a synthetic serial (`MOCK000000001`), while the golden replies carry the user's. So `composeMockBackend` passes `monitors: { mockSpec: USER_34M2C8600 }` (`test/fixtures/user-monitor.ts`: the real EDID and serial) through `DefaultCompositionOptions`. `serve.test.ts` runs `serve.ts --mock` unchanged and therefore sees the synthetic serial.

| File | Test | What it checks |
|---|---|---|
| `golden-transcript.test.ts` | provenance, comparator, integer-like keys, minimal backend, harness self-check | unchanged from impl-api §4, plus: the §6.1-6.3 sizes/hashes of 20-enum match the document headings |
| | **golden transcript + flows** (no ENE) | the 20 golden steps (§5 steps 2-18 + 16.1-16.3) byte-exact or with the two tolerated paths, their notifications (N0 before the first `PHL_GetConstraints`, N1 exactly in steps 13/16.3); ENE absent; `ambiglow.display` is the current display and `checkEne` answered `""`; the 03 §5 flows (luminance with the full-Tag side effects, AdaptiveSync with the constraints notification, `PHL_SetSmartImage` 34/33 with `SubSmartImages` insertion order, `PHL_SetInputSource` 8719); `Effect_GetMenu` without ENE = 20-enum §6.2 bytes; **persistence**: `PHL_SetOSD(AdaptiveSync, 0)` → `Profile_GetDeviceData`, the `Default.pcenter` ProfileContent and `Theme_GetDevicesBasicInfo` (step 18 with `AdaptiveSync:"Off"`), then back to step 18 byte-exact; **theme switch** (below); final N1 |
| | **ENE present** | `Start` bytes; discovery pairs the ENE; the first `Profile_GetDeviceData` is already in ENE mode with the stored FollowVideo pushed (0x0023 = 4, mode 0x0E), no plug notification at load; `Effect_GetMenu` = 20-enum §6.1 bytes; `Effect_Change(7)` (Tag key order, StaticModeRainbow), `Effect_GetLEDs` refused outside Follow*, `Effect_ColorChange` (StaticMode, colour registers), `Effect_BrightnessChange` (0x04), `Effect_SpeedChange`, persisted (`LightMode:"Static"`, `.pcenter` EffectInfo); `Effect_Enable(false/true)` (0x0023 0 ↔ 4); theme switch pushes the target profile's EffectInfo to the MCU; `Effect_Reset` (`NotifyEffectSyncDevicesChange` with the raw Sync_Profile first, Tag = 20-enum §6.3 bytes, blue Static rainbow), `SyncEffect_GetData` lists the display; **ENE unplug/replug** via `backend.hotplug('usb')` + `Device_DetectionUSB`: reply = golden step 3 list, exactly one `NotifyUIDisplayEffectChange` with the named keys (then `Item1..3` with the same values) and `ENEEnable:false` (its EffectInfo/ModuleAmbiglow = the display's), `E2A019 = 0` written, `Effect_Change` → `Not Support ENE`; a fresh MCU plugged back: `ENEEnable:true`, the effect pushed, no DDC Ambiglow write |
| `lifecycle.test.ts` | **monitor hotplug** | unplug (DRM connector `disconnected` + VIA detached, `hotplug('usb'/'display')`): `Device_DetectionUSB` = `Device_GetConnectList`, `Device_DetectionDisplay` → `[]` after the 5 s settle, no notification, `attach(null)`, `PHL_SetOSD` → `functionName: PHL_SetOSD  return null obj`; replug: `Device_DetectionUSB` = golden step 3 again (only N0 may accompany it), then golden steps 12 (the **same** Tag as before the unplug), 17 and 13 byte-exact, a new driver on USB-DDC first, attached to ambiglow, writable |
| | **VCP 0x04** | `Theme_ResetCurProfile`: Tag `null`, the monitor gets exactly `0x04 = 1` then the re-read's five EQ band selects `E2A001 = 0..4`; the monitor's values are the factory ones afterwards, in DeviceData and in `Default.pcenter`. `FactoryReset`: Tag `true`, the same writes, `DataTheme.cfg` equals the user's first-run file byte for byte (golden steps 5, 8), SoftConfig defaults (step 14), the extra profile gone, the display section re-saved, the monitor keeps working |
| | **restart** | `stop()` + `start()` after a Start: displays re-enumerated before any request; `Start` (latched), steps 3, 11, 12, 13 byte-exact; re-attached. Restart before any Start: nothing scanned until `Start` |
| | **ThemeStore.start() once** | §3 row 4 |
| `serve.test.ts` | command line | usage errors exit 2 with nothing on stdout; `--help`; `parseServeArgs` |
| | smoke | `node src/backend/serve.ts serve --mock --port 0` as a child process: one JSON line (`port`, 43-character token, `url`, temp `serveDataDir`, `hardware`), the token never in the log, the vendor-configured SignalR client gets `Start`, the device list (CurSN), ENE-mode DeviceData, `Setting_GlobalData`; SIGTERM → exit 0, temp dir removed |

The theme-switch case: `Theme_CopyProfile` + `Theme_Switch` to a same-content profile writes exactly `0x10 = 100`, `0x12 = 50`, `E2A019 = 0` (the "3 writes" of 20-theme §6); a Windows-format `.pcenter` (BOM, one line) with HDR Movie, luminance 60 and the monitor's Ambiglow on in FollowVideo, imported with `Theme_ImportProfile` (no write) and switched to, writes exactly `DC = 34`, `0x10 = 60`, `0x12 = 50`, `E2A019 = 1`; switching back writes `DC = 33`, `0x10 = 100`, `0x12 = 50`, `E2A019 = 0`, and DeviceData is Default's HDR group, EffectInfo and ModuleAmbiglow (Off shown as Static) again; both `.pcenter` files hold their state; after deleting the extra profiles the index is golden steps 5/8 byte-exact.

### 4.1 E2E run with the production composition

`xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e` in the dev container (the harness builds into `test/e2e/artifacts/`): 14 of 15 pass. With the vendor UI and `EVNIA_MOCK_MONITOR=34M2C8600`, Home now shows the simulated **PHL 34M2C8600** card with its bundled image and the profile selector "User | Default" (`artifacts/vendor/final.png`); the renderer connects over the token hub with Origin `file://` (§2.4) and no request leaves the machine. The one failure is "no unexpected console errors": `file:///: Failed to load resource: net::ERR_FILE_NOT_FOUND` for `vendor-ui/monitor/34M2C8600_overview.png`. That is the vendor renderer's own image fallback — its DeviceImage component tries `<model>_overview.png` first and switches to `<model>.png` in the `error` handler (`styles-DAnQi2A8.js`, `src.endsWith("overview.png")`), and the vendor installer ships no `34M2C8600_overview.png`. It became visible because the renderer now reaches a device card at all (the placeholder `system-minimal.ts` never listed one). Fix belongs to the e2e allowlist or the vendor-UI import (§8).

**Walkthrough wave.** `test/e2e/walkthrough.test.ts` (impl-walkthrough.md) now drives the production composition through the real vendor UI: every monitor page and tab, Profile, Settings and Dashboard, monitor off/on, and the three VCP 0x04 resets, with and without the ENE. It found and fixed two production defects (the ENE re-opened on every first attach, impl-ambiglow §8; the renderer's electron-log bridge missing, impl-electron-shell "IPC") and one test-environment issue (the GPU process killed through Docker's 64 MB `/dev/shm`). The composition and the backend API needed no change.

Shared helpers: `compose.ts` (composition, `mockEnes`, `vcpWritesSince` — Set VCP frames decoded from what the simulated monitor received, `storedDisplayContent`, `writeEditedProfile`, `rawTag`), `replay.ts` (the `Replayer` with per-request notification capture, `assertMatches`, `replayStep`, `assertNotifications`, `isAllowedNotification`, `assertEffectChange`, `withComposedBackend`; formerly inside the test file).

## 5. User-facing behaviour to document (binding decision)

> **Reset and Factory reset also reset the monitor.** In *Profile → Reset* (`Theme_ResetCurProfile`) and *Settings → Factory reset* (`FactoryReset`) the app sends the monitor the DDC/CI command *Restore factory defaults* (VCP 0x04 = 1), exactly like the Windows app. Every OSD picture setting of the monitor (SmartImage mode values, brightness, contrast, colour, Ambiglow over DDC, …) returns to its factory value; the app waits 5 s and then reads the monitor again. *Factory reset* additionally deletes the app's themes, profiles, macros and settings in `~/.config/EvniaServe` (the `logs` folder is kept) and recreates the defaults. The operations take about 6-10 s on real hardware; the monitor may blank briefly.

No user documentation file exists in the repository yet (no README or `/usr/share/doc` content in `packaging/deb`); this paragraph is meant for it (packaging/docs owner). It is covered by `lifecycle.test.ts` "VCP 0x04".

*Resolved: documented in `packaging/deb/README.Debian`, the man page and the package description (packaging wave), and in `docs/port/USER-GUIDE.md` "Reset and Factory reset also reset the monitor" (docs wave). The user guide also lists the third path, Monitor → Setup → Restore to factory settings (`Profile_Reset`).*

## 6. Smoke server (`src/backend/serve.ts`)

```
node src/backend/serve.ts [serve] [--mock [--model <m>] [--no-ene]] [--port <n>] [--data <dir>] [--resources <dir>]
                          [--token <t>] [--origin <o>]... [--verbose]
```

- Starts `createDefaultBackend` + `startHubServer` on 127.0.0.1 (port 10010 upward by default, `--port 0` = any), then prints **one JSON line** on stdout: `{"port","token","url":"ws://127.0.0.1:<port>/EvniaHub?k=<token>","serveDataDir","hardware"}`. Logs go to stderr (`--verbose` = debug, every request). The token is printed there only, never logged.
- `--mock` = `EVNIA_MOCK_MONITOR` semantics (default `34M2C8600` with the simulated ENE; `--no-ene` = the golden session); the mock host reports the user's display mode so the session matches the golden transcript. Without `--mock`: **real hardware**, one shared `LibusbBackend` (VIA + ENE) and USB hotplug forwarded to `backend.hotplug('usb')` after 1 s (the host's USBChange debounce, 01 §9). Nothing is written to the monitor until a client calls a setter.
- `--data <dir>`: the EvniaServe directory (its sibling `../evnia` is the userData directory). Default: a temporary directory removed on exit — so a bring-up session never touches the user's profiles. `~/.config/EvniaServe` reuses the app's profiles and capability cache; never while the app runs.
- `--resources` defaults to `build/vendor-data` of the checkout (a warning is logged when `PCenter_DeviceInfo.json` is missing: no display would be recognised).
- `--origin` admits extra browser origins besides `file://`; Node clients and tools like `websocat` send no Origin.
- SIGINT/SIGTERM: `hub.close()` (≤1 s for running requests), `backend.stop()`, temp dir removed, exit 0; a second signal exits at once. Usage errors exit 2, a failed start 1.

Example (in the dev container): `node src/backend/serve.ts --mock --no-ene --port 0`, then any SignalR JSON client on the printed URL sending `GetTaskAsync` with `{"functionName":"Start","requestId":"1","parms":null}`.

## 7. Deviations and decisions

1. **Slots typed by the contracts** (§2.2): the concrete classes are exposed through `DefaultServices`/`createDefaultBackend`, not by narrowing `ServiceSlots`.
2. **Restart re-enumeration** (§2.3) — a port-only state.
3. **`startHubServer` admits `file://` only by default** (§2.4).
4. **`noHardware` keeps the ENE off a given USB backend** (§2.1).
5. **Contract tests select the ENE state with `mockMonitor`** (`34M2C8600/no-ene`) instead of unplugging the simulated ENE before each discovery: the production composition has no discovery seam, and the no-ENE variant is exactly the golden hardware.

## 8. Findings for other owners (not changed here)

- **monitor — stale CacheDeviceData DC on a theme switch back** (vendor bug reproduced): `PHL_SetSmartImage` updates DeviceData only (vendor CDevice_PHLDisplay.cs:1675-1720), and a theme switch compares the target profile's DC with `CacheDeviceData` (`ParameterToDevice(object…)`, :585-614, `method_10` :616-673). Copy *Default* to *Gaming*, switch to *Gaming*, pick HDR Movie there, switch back to *Default*: no DC write, the monitor stays in HDR Movie (with Default's luminance/contrast written into that mode) while DeviceData and the UI say HDR Game. impl-monitor lists "a profile switch copies CacheDeviceData (a possibly stale GameMode/Input/…) into DeviceData" as a kept quirk; the DC case is user-visible. The contract test avoids that path (it imports a profile instead) so it does not pin the bug either way. *Resolved in the e2e walkthrough wave: `applyProfileContent` rebases CacheDeviceData on DeviceData first (impl-monitor deviation 18, impl-walkthrough §5 #4); the walkthrough's step "profile-switch-default" asserts the DC write and the kept volume.*
- **monitor — USB reconcile and a vanished monitor** (verified with the mock): `#usbReconcile` only handles displays that discovery still finds. A monitor unplugged completely (DRM connector `disconnected` and the VIA bridge gone) stays `connected` with its dead `via-usb` transport, and `Device_DetectionUSB` still lists it, until the renderer's `Device_DetectionDisplay` (2 s debounce + 5 s settle) removes it; setters in that window go to a bridge that is gone. The contract test only asserts `Device_DetectionUSB` = `Device_GetConnectList` for that window, so it does not pin this either way.
- **ambiglow** — `AmbiglowServiceImpl.#usbBackend` prefers `BackendOptions.usb` over `noHardware` (the composition compensates, §2.1). *Resolved in the ambiglow fix pass: `noHardware` now wins in the service itself (impl-ambiglow §2.1, deviation 15); the composition's compensation is kept and harmless.*
- **electron-shell** — `src/main/index.ts` `privateRoots: [join(tmpdir(), 'EvniaServe')]` vs the theme store's per-user `defaultAppTempDir()` (impl-theme §2): icons made by `Comm_GenAppIcon` are not served until main uses the same directory (or passes one `appTempDir` to both through `DefaultCompositionOptions.themes`). `backend-host.ts` needs no change for the composition or the Origin default.
- **theme** — `src/backend/api/setting.ts` line 8 still mentions `api/system-minimal.ts`.
- **vendor-ui / e2e** — the e2e check "no unexpected console errors" fails on the vendor renderer's deliberate `34M2C8600_overview.png` miss (§4.1). Either allow exactly that failed request in `test/e2e/app.test.ts` (correlating the console line with the failed `*_overview.png` entry of `network.json`, since the console text carries no URL) or have `scripts/import-vendor-ui.mjs` provide `monitor/<model>_overview.png` (a copy of `<model>.png`) for models that lack it.
- **docs/packaging** — no user documentation exists for §5. *Resolved: README.Debian, the man page and `docs/port/USER-GUIDE.md` (see §5).*

## 9. Limitations

- The contract tests run against the simulated 34M2C8600 (the real capability string, EDID, the user's seed values); a second monitor model, a real PipeWire capture and real USB timing are not covered here (monitor/ambiglow unit tests and the e2e run cover parts).
- The restart re-enumeration rescans only after a run that had scanned; a restart in the middle of a `Start` scan waits for it (the transitions are serialized).
