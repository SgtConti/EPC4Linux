# Implementation notes: end-to-end walkthrough of the vendor UI against the simulated 34M2C8600

Module owner: e2e walkthrough. This wave drives the real vendor renderer (patched by `scripts/import-vendor-ui.mjs` from the user's installer copy) in the real Electron main process, against the production backend with `EVNIA_MOCK_MONITOR`. It visits every monitor page and tab plus Profile, Settings and Dashboard, performs what a user would, and asserts that the simulated monitor or ENE changed accordingly. It also fixes what broke on the way.

| Kind | Files |
|---|---|
| Walkthrough | `port/test/e2e/walkthrough.test.ts` (new), `port/test/e2e/vendor-ui.ts` (new: driving the vendor UI kit) |
| Harness | `port/test/e2e/harness.ts` (hub-traffic recorder, `pageerror`, stderr, `LaunchOptions.seed`, `--disable-dev-shm-usage`), `port/test/e2e/app.test.ts` (renderer exceptions asserted) |
| Test hook | `port/src/main/mock-probe.ts` (new), `port/src/main/index.ts` (installs it in mock mode), `port/src/main/host-services.ts` (idle source typed as `Pick<IdleTimeSource, 'seconds'>`), `port/src/backend/ddc/transports/mock.ts` (`SimulatedMonitor.osdSet`) |
| Fixes | `port/src/main/renderer-log.ts` (new), `port/src/main/ipc.ts`, `port/src/main/shared/channels.ts`, `port/src/preload/api.ts`, `port/src/preload/index.ts` (electron-log bridge); `port/src/backend/ambiglow/service.ts` (ENE kept on the first attach); `port/src/backend/monitor/display.ts` (a theme switch compares with what the monitor was last given) |
| Unit tests | `test/unit/main/mock-probe.test.ts` (6), `test/unit/main/renderer-log.test.ts` (4), `test/unit/main/ipc.test.ts` (+1), `test/unit/ambiglow/service-ene.test.ts` (+1), `test/unit/monitor/display-ops.test.ts` (+1) |

```
MSYS_NO_PATHCONV=1 docker run --rm --network none -v "C:\path\to\repo:/repo" -w /repo/port evnia-port-dev \
  bash -c 'npm run import-ui && npm run build && xvfb-run -a -s "-screen 0 1920x1080x24" npm run test:e2e'
```

`npm run test:e2e` runs `app.test.ts`, `capture.test.ts` and `walkthrough.test.ts` in parallel: 51 tests in about 4.6 minutes. The walkthrough alone takes about 2.3 minutes per run. It skips without an X display or without `build/vendor-ui`. Result at the end of this wave: 51 of 51 in each of three consecutive runs after the last change (a fresh `npm run import-ui && npm run build` first; the flakes found in earlier repetitions are in §7). Typecheck clean. Unit and contract suite: 826 tests, all pass (one hub test skips under `--network none`, as documented in impl-hub-rpc).

Specs: `docs/re/03-renderer-monitor-pages.md` §4 (pages, controls, calls), §5 (functions), §9 (vendor quirks); `02-renderer-shell.md` (tutorials, loading, hub client `Jc`, electron-log renderer ST:~30688-31140); `09-ambiglow-lighting.md` §5-§11; `20-theme-profile-engine.md` §5-§7, §10.2; `20-backend-host-tail.md` §5-§7; `01-electron-main.md` §9, §15. Ground truth for renderer behaviour: `work/app-pretty/renderer/assets/*.js` (cited as ST = `styles-DAnQi2A8.js`, MAIN = `main-CDosWiM3.js`, or the page chunk).

---

## 1. The two runs

| Run | `EVNIA_MOCK_MONITOR` | `~/.config` | What it covers |
|---|---|---|---|
| `34M2C8600` | `34M2C8600` | empty (first run) | the simulated monitor **and** the ENE Ambiglow MCU; the vendor's first-run tutorials walked through (Home 3 steps, Monitor 1, Dashboard 1); the ENE Ambiglow page |
| `34M2C8600-no-ene` | `34M2C8600/no-ene` | the user's Windows `%APPDATA%\evnia` and `%APPDATA%\EvniaServe` copied in (`test/fixtures/windows`: `config.json`, `DataTheme.cfg`, `Default.pcenter`, `SoftConfig.data`, `data.json`) | the user's hardware on 2026-09-26 (golden session: no ENE); the migration of real user data; the DDC Ambiglow fallback page |

Each run is one app launch, built once into `test/e2e/artifacts/walkthrough-app/<run>/app`. The steps run in order: later steps rely on the state earlier ones left (e.g. Movie before SmartFrame, the Ambiglow on before the idle test).

## 2. What every step asserts (`Walk.step`)

After the step's action, `settle()` waits until **every** backend request has its reply (only the vendor's continuous `Effect_GetLEDs` / `Effect_CheckDynamicLightingEnabled` polls may be in flight, and not for longer than 1.5 s) and no loading overlay (`.vc-loading`, `.loading-screen`) is visible, twice in a row 250 ms apart. The overlay appears 100 ms after `loadingShow`, ST:8296-8302. A stuck overlay or a hung request fails the step after 45 s. Then it takes the screenshot `artifacts/walkthrough/<run>/NN-<page>.png` and checks:

1. **Renderer console errors:** none beyond `CONSOLE_ALLOWLIST` (§6).
2. **Renderer exceptions** (Playwright `pageerror`: uncaught exceptions and unhandled rejections): none, except the one each tolerated vendor rejection causes (§6). A tolerance is consumed by its page error, which may arrive in a later step.
3. **Backend requests:** every `GetTaskAsync` reply of the main window's hub socket has `err_code` 0, except the documented vendor ones (`RPC_ALLOWLIST`, §6). No request stays without a reply for 20 s (hang), and no malformed hub record appears.
4. **Network:** nothing non-local was recorded, apart from the deliberate probe of step 00, which must have failed. The main process's kill-switch log holds exactly that probe. Step 00 loads `https://kill-switch-probe.invalid/walkthrough` in a CSP-free hidden window from main.
5. **Main process:** no `Unhandled rejection`, `uncaught … error`, `Render progress gone` or `Child progress gone` line in the main log.

The interaction checks read the simulated device side through the mock probe (§3): the monitor's control values, every Set VCP it received, and the ENE's latched registers and frame buffer. Where the backend persists state, the checks also read the files the user would find in `~/.config` (`DataTheme.cfg`, `*.pcenter`, `SoftConfig.data`, `config.json`). A step whose action fails also writes `NN-<page>.failed.png` and `.failed.html`; a step whose global checks fail writes `NN-<page>.failed.txt` with the message. Each run writes `rpc.log` (every request with its reply time), `notifications.log`, `main.log`, `backend.log`, `stderr.log`, `network.json`, `console-errors.txt` and `page-errors.txt`.

## 3. Test hook: the mock probe (`src/main/mock-probe.ts`)

- **Gated by the mock environment.** `index.ts` installs it on main's `globalThis.__evniaMockProbe` (non-enumerable, read-only) only when `EVNIA_MOCK_MONITOR` is set, i.e. when the backend runs with `noHardware` on simulated devices. An ordinary run never has it. The renderer cannot reach main's globals (contextIsolation, sandbox, and no IPC channel exposes it). The test reads it through Playwright's `electronApp.evaluate()`, which runs in the main process.
- `snapshot()` returns `{model, vcp: {code: value}, writes: [[code, value], …], ene: {hostControl, groups, frame, frameWrites: {count, recent: [[register, length], …]}, violations} | null, capture: {starts, retunes, intervalMs} | null}`, taken from `MonitorManagerImpl.mockHardware`. `capture` is what the backend asked of main's capture host (`ElectronCaptureHost.videoStats`, a hook main passes in): sessions started, in-place retunes and the current frame interval, for the Follow video Speed steps. `ene.frameWrites` counts the frame-buffer writes the simulated MCU accepted and lists the latest 24 (`MockEneDevice.recentFrameWrites`): six segments per Follow video frame, or one 138-byte transfer at `0xE300` with "Fast LED upload". The writes are decoded from the frames the simulated monitor received (the same decoding as `test/contract/compose.ts vcpWritesSince`).
- `osdSet(code, value)` models a change made **on the monitor itself**, such as OSD keys or the source switching HDR off: `SimulatedMonitor.osdSet` applies it with the Set VCP rules, records no host frame and leaves a pending reply alone.
- `setIdleSeconds(n | null)` simulates the input idle time behind `HostServices.getIdleSeconds`. Like the display mode, it is part of the simulated environment. Under Xvfb the real idle time only grows, because synthetic CDP input is no X input. `null` returns to the real source.
- `unplugMonitor()` / `replugMonitor()` model the monitor being switched off or unplugged and back on:
  - the DRM connector's `status` becomes `disconnected`/`connected`;
  - the VIA bridge and the ENE leave the fake USB bus, and come back re-enumerated at new addresses;
  - main's raw device events `USBChange`, `otherDeviceChange` and `displayChange` go through the real `DeviceChangeGate` (vendor debounce and shields, 01 §9), so the renderer events and `backend.hotplug()` run exactly as with udev and libusb.

## 4. Page-by-page status

Each run passes its 17 tests (34 in all). Screenshot numbers (`NN-<page>.png`) are the same in both runs: each has nine Ambiglow steps (23-31).

| # | Page / tab | Interactions and what the simulated hardware must show | ENE run | no-ENE run |
|---|---|---|---|---|
| 00 | Home | the hub connects with the token; the **PHL 34M2C8600** card with its bundled image; the monitor starts in HDR Game (DC 33); ENE present or not; first run: 3-step tutorial | pass | pass (no tutorial: migrated `config.json`) |
| 01-02 | Home | view toggle category ↔ list (`overviewType` in `config.json`); **Rescan** → `Device_Rescan`, the card stays | pass | pass |
| 03-05 | Monitor shell → SmartImage HDR | card → `/monitor/smartImageHDR` (IsSmartImageHDR); Monitor tutorial; HDR Movie → DC 34; HDR Game → DC 33 | pass | pass |
| 06-12 | SmartImage (SDR) | the monitor leaves HDR itself (`osdSet` DC 0) + sidebar **Sync** (`PHL_ReloadData`) → redirect to `/monitor/smartImage`; **Brightness slider** 60 → exactly one write `0x10 = 60`; **Movie** → DC 3; Standard → DC 0, luminance kept per mode; Color Temperature 9300K → `0x14` changes (`PHL_SetColorPreset`); **reset icon** + confirm → `E2A0_42 = 0x30`, Standard luminance back to its factory value; Movie again | pass | pass |
| 13-22 | GameMode: Adaptive Sync, Crosshair, Stark ShadowBoost, Smart Sniper, Low Input Lag, SmartFrame | every tab; Adaptive Sync switch off/on → `E2A0_40` 0/1; SmartFrame switch on/off → `E2A0_08` 1/0 (`PHL_SwitchSmartFrame`, 0.8 s), controls enabled | pass | pass |
| 23-31 | Ambiglow, ENE effects | Breathing → group 1 re-latched in another mode; red swatch → colour `[255,0,0]` (`Effect_ColorChange`, debounced 500 ms); Effect off → `0x0023 = 0`, LEDOFF; on → `0x0023 = 4`, Breathing; **Follow Video** → screen colours in the frame buffer `0xE300` (the capture host on Xvfb) and `Effect_GetLEDs` preview replies; **Follow Video Speed** (29, impl-ambiglow deviation 17): the vendor Speed slider with the marks Low / Normal / High, capture at 100 ms (Normal, first-run default); High → `Effect_SpeedChange(100000, 3)`, the capture host retuned to 40 ms with no new capture session (probe `capture`: same `starts`, `retunes` + 1); **Follow Video Brightness and Fast LED upload** (30, impl-ambiglow deviation 17, impl-usb-ene §2.2): the vendor Brightness slider with the marks Bright / Brighter / Brightest and the FAST-LED-UPLOAD checkbox "Fast LED upload (experimental)" (unticked) with its hint line; a full-screen window of one colour over the Xvfb screen (opened from main, closed at the end) gives the capture a known picture: every LED that colour at Brightest (the cells under the X pointer, which desktopCapturer draws, aside); Brighter → `Effect_BrightnessChange(100000, 2)`, the frame buffer and the `Effect_GetLEDs` preview at 2/3 of it (±1), still one capture session and six writes per frame (probe `ene.frameWrites`); the checkbox ticked → one 138-byte transfer at `0xE300` per frame, the same dimmed colours, `config.json linuxExperimental = {eneFrameBurst: true}`, screenshot `30-…-ticked.png`; unticked → the six writes again, `{eneFrameBurst: false}`, the main log lines of both changes, no capture restart; Breathing again | pass | — |
| 23-31 (no-ENE run) | Ambiglow, DDC fallback | Effect switch on → `E2A0_19` ≠ 0 (remembered mode); red swatch → `E2A0_1A = 2`; Color Wave → `E2A0_19 = 4`; Effect off → 0; on → 4; **Follow Video** → `E2A0_19 = 1`, rendered by the monitor: no screen capture (probe `capture.starts` 0), no `Effect_GetMenu`/`Effect_SpeedChange`, and the only Speed slider is the monitor's own `E2A0_1D`, disabled for Follow Video by its constraints (enabled for Color Wave); no "Fast LED upload" checkbox (30: the patch shows it only with the ENE), no `Effect_BrightnessChange`, and the migrated `config.json` gets no `linuxExperimental`; Color Wave again → 4 | — | pass |
| 32-34 | Input | HDMI 1 → `0x60` low byte 17 (`PHL_SetInputSource`, shieldDisplayChange); DisplayPort 1 → 15 | pass | pass |
| 35-38 | Audio | Volume slider 30 → `0x62 = 30`; Mute on → `0x8D = 1`; off → 2 | pass | pass |
| 39-48 | System: OSD Setting, PIP/PBP, Smart Size, USB Setting, Smart Power, Pixel Orbiting, Over Scan | every tab; Smart Power switch → `E2A0_16` toggles and back; **PIP/PBP Mode** switch → `0xA5 = 256`, off → 0 | pass | pass |
| 49-52 | Setup: Settings, OLED Panel Care | menu is exactly Settings + OLED Panel Care (**no FwUpdate**); footer `Model: PHL 34M2C8600 \| SN: MOCK000000001`; OSD Language Deutsch → `0xCC` changes, English → back; device navigator → `PHL_SwitchDisplay` | pass | pass |
| 53-65 | Profile (`/profile`) | **new profile** "Walkthrough" (`Theme_AddProfile` + `Theme_Switch`; `DataTheme.cfg`), saved as the monitor's current preset and volume with no write (§5 #4); SmartImage **Standard** (DC 0) and luminance 80 in it; **switch** back to Default in the toolbar → the monitor gets Default's Movie (DC 3) and luminance again and keeps the Audio step's volume 30, which `Default.pcenter` is saved with (§5 #4); **export** (save dialog stubbed in main) → a Windows-format `.pcenter` (BOM, one line) with luminance 80; **import** it (open dialog stubbed; `nodeApi` temp copy removed again) → profile "Imported", switching to it writes 80; **copy** → "Imported(1)"; **rename** (label editor) → "Renamed", the file moves; **preview** (eye) → `Theme_GetDevicesBasicInfo`, shows the monitor and 3440x1440; **delete** all three (files gone) | pass | pass |
| 66-67 | Profile → Applications | **new application theme** bound to a `.desktop` file (the app picker is main's `.desktop` chooser): `Comm_GenAppIcon` stages the icon in `PATH_APP_TEMP`, shown through `local:`; `Theme_Add` + switch; the bound icon shown from `Theme/<T>/Icon/`; back to User, **delete** it | pass | pass |
| 68-75 | Settings: General, About Evnia Precision Center, About Device | exactly 3 tabs; **"Idle for" checkbox** → `SoftConfig.data TurnOffLightsWhenIdle: true`; simulated idle ≥ 5 min → ENE LEDOFF and `0x0023 = 0` / DDC `E2A0_19 = 0`; input → Breathing and `0x0023 = 4` / ColorWave again; unchecked → false; language Deutsch → German UI and `config.json language de`, back to English; About: `Version: 1.13.0`, no update controls; About Device: PHL 34M2C8600, 3440x1440, 175Hz | pass | pass |
| 76-78 | Dashboard | Dashboard tutorial (first run); Resolution, Refresh Rate, SmartImage and Input added to the overlay (`config.json dashboardPreview`); the overlay on the monitor pages shows `3440x1440 \| 175Hz \| Movie \| DisplayPort 1` | pass | pass |
| 79-80 | Monitor off / on | `unplugMonitor` → `USBChange`/`displayChange` → `Device_DetectionUSB`, `Device_DetectionDisplay` (5 s) → `[]` → Home "Connect Your Evnia Device"; `replugMonitor` → listed again, the card; Volume 40 reaches the monitor through the new bridge; the re-enumerated ENE driven again | pass | pass |
| 81 | Profile → reset | reset icon of the active profile → `Theme_ResetCurProfile` → **VCP 0x04 = 1** (binding decision), 5 s, the monitor back in HDR Game | pass | pass |
| 82 | Setup → Restore to factory settings | Reset + confirm → `Profile_Reset` → **VCP 0x04 = 1**, 5 s, SmartImage HDR page again | pass | pass |
| 83-84 | Settings → Factory Reset, Tutorials Reset | an extra profile, then Factory Reset → **VCP 0x04 = 1**; `DataTheme.cfg` back to User/Default only; SoftConfig defaults; the selector shows `User \| Default`; Tutorials Reset → `config.json tutorials: {}` | pass | pass |
| 85 | Home | the Home tutorial again (3 steps); no refused ENE register access in the whole run | pass | pass |

Not reachable or not in scope, so not visited: `/message` (only through the `toPageView` IPC "message", which no port source sends), `/account` and the login overlay (patched away), SmartDesktop, AmbiScape and FwUpdate (removed), and the peripheral pages (no Philips peripherals are listed).

## 5. Defects found and fixed

| # | Found as | Cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | `Child progress gone { type: 'GPU', reason: 'killed' }` in the main log on the first screenshot of the monitor shell; Chromium stderr: `Message … rejected by interface viz.mojom.CopyOutputResultSender` → `GPU process exited unexpectedly: exit_code=9` | **test environment**: Docker's default `/dev/shm` is 64 MB; a full-window readback (~8 MB at 1920x1080) plus the renderers' shared memory exhausts it, the CopyOutputResult fails mojo deserialization and the browser kills the GPU process | harness: `--disable-dev-shm-usage` (Chromium keeps shared memory in `/tmp`); test-only, real desktops have a large `/dev/shm` | every walkthrough step asserts no `Child progress gone` |
| 2 | two `ENE usb:3-2.1: chip 0x7730 …` identification lines 0.6 s apart in the backend log at start-up | `AmbiglowServiceImpl.attach()` treated every first attach as a display change and closed the ENE the load's `checkEne()` (vendor method_14) had just opened for that same display; `#syncDisplay` then opened and identified it again: a second USB open and ~15 identification reads at every start-up, `PHL_SwitchDisplay` and rescan | `#detach(next)` keeps a held ENE owned by `next.key`; the reconcile re-validates it (impl-ambiglow §2.2, §8) | `service-ene.test.ts` "a load identifies the ENE once" (fails without the fix); the backend log of every walkthrough run shows one identification |
| 3 | on a monitor unplug: renderer console error `electron-log: logger isn't initialized in the main process`; the renderer's log line lost | the vendor renderer logs through electron-log's IPC transport, which needs `window.__electronLog` (electron-log's own preload, installed by `log.initialize()` in the vendor main); the port's preload did not provide it. The first caller in reach is `useConnectDetection`'s `da.info("To overview device list empty")` (MAIN:1749) | `window.__electronLog` in the preload (electron-log 5's API shape) → internal channel `evnia:renderer-log` → sender check → `renderer-log.ts` sanitizes (level, data, one bounded line) → main log scope `main/app/renderer` (impl-electron-shell "IPC", deviation 30) | `renderer-log.test.ts` (4), `ipc.test.ts` bridge test (trusted and refused senders); walkthrough step "monitor-off" (console clean, the line in `main.log`) |
| 4 | reviewing a passing run's `rpc.log` against the probe (and impl-integration §8's open finding): right after **new profile** "Walkthrough", `Profile_GetDeviceData` answered SmartImage Standard (DC 0) while the monitor was in Movie (DC 3), the UI showed Standard, the Brightness slider then wrote 80 into Movie, and `Walkthrough.pcenter` was saved with Standard and volume 0 (the monitor had 30). In the no-ENE run the new profile also switched the DDC Ambiglow off (`E2A0_19 = 0`: it was off in that read). With the fix disabled, the extended walkthrough fails at "profile-new" in both runs | the vendor's theme switch compares the target with CacheDeviceData, the **last full read** (here the Sync of step 06), not with what the setters gave the monitor, and ends with DeviceData = that cache (CDevice_PHLDisplay.cs:585-614, :600; `method_10` :616-673). A new profile has no section and is applied as `GetDefaultData()` = the cache itself (:248-265), so it became the last read. Generally, a DC equal to the cache's is not written (a preset picked inside a profile survives the switch back while the UI shows the profile's), and every other module of the last read returns to DeviceData, to the UI and into the saved profile | `applyProfileContent` rebases CacheDeviceData on DeviceData first, as the vendor's own unused `ParameterToDevice(bool)` override does (:576-583). Without a setter in between the frames are the vendor's (impl-monitor deviation 18) | `display-ops.test.ts` "theme switch after setters" (fails without the fix); walkthrough steps "profile-new" (the new profile = the monitor's current preset and volume, no write), "profile-new-luminance" (Standard in the new profile reaches the monitor) and "profile-switch-default" (DC 3 written, volume 30 kept on the monitor and in `Default.pcenter`) |

Harness gaps found and closed on the way. None of these is a product defect, but each would have hidden one:
- Uncaught exceptions and unhandled rejections in the renderer never reached the console listener. They are Chromium `Runtime.exceptionThrown` events, which Playwright reports as `pageerror`. The harness now records them, the walkthrough and both `app.test.ts` suites assert them, and that is how the vendor rejections of §6 became visible.
- "Settled" first accepted requests younger than 1.5 s, so a screenshot caught the busy overlay of a 0.8 s `PHL_SwitchSmartFrame`. It now waits for every reply.

## 6. Documented vendor behaviour accepted by the checks

| What | Where it comes from | Why it is kept |
|---|---|---|
| console `Failed to load resource: net::ERR_FILE_NOT_FOUND [.../vendor-ui/monitor/34M2C8600_overview.png]` (Home, Settings → About Device, Ambiglow) | `DeviceImage` tries `<model>_overview.png` first and switches to `<model>.png` in its error handler (ST:33376-33384). The installer ships no overview image for this model | vendor renderer; accepted only if the fallback image loaded (checked) |
| console `404 (Not Found) [local:////<userData>/ImageCache/normal.png]` when the Monitor shell mounts (intermittent: 2 of 6 runs in the repetitions before it was accepted) | `DeviceImage` builds its source from the monitor's `ModelName`; while `Profile_GetDeviceData` is still in flight the model token is empty, so it requests `"local:///" + pathJoin(userData, "ImageCache", "", "normal.png")` (ST:33331-33366). Its error handler shows the generic image until the model arrives, then the bundled `34M2C8600.png` replaces it (ST:33376-33386). The vendor's `net.fetch` fails the same way on Windows | vendor renderer, timing-dependent; the 404 is what drives the vendor's fallback. Only the empty-model form (no model directory) is accepted |
| console `404 (Not Found) [local:///]` on `/profile` | Applications → "+" → Path: `ThemeHeader.v()` pushes `{path, icon: ""}` before `Comm_GenAppIcon` answers (ST:42549-42557), so the bind icon `<img src={"local:///" + icon}>` (ST:42647) is requested once with an empty path; main's `local:` handler refuses it | vendor renderer, transient; the icon loads right after (checked) |
| `SyncEffect_EnableDevice(100000, "[]")` → `err_code 9 "Input device=100000 EffectDetail is null"` + one unhandled rejection (`pageerror` "Object") on `/monitor/ambiglow` when the ENE effect is switched off | LightSync watches `enable` and clears the sync group (LightSync-B-QWSZnT.js:375-391, `.then()` without catch). With the effect off, the display's `EffectDetail` is the base class's null (CDevice_PHLDisplay.cs:99-108, CDeviceEffectBase.cs:18), so the vendor answers the same error (SystemOper.cs:1631) | byte-compatible reply; no visible effect |
| `Effect_GetLEDs` → `err_code 9 "not ene follow video or audio"` + one unhandled rejection when the effect leaves Follow Video while a preview poll is in flight | the preview re-issues `Effect_GetLEDs` 30 ms after each reply with no catch (Ambiglow-Dvqon39u.js:255-263), so the loop ends on the first rejection (03 §4.5) | vendor design; timing-dependent (seen in some runs) |

## 7. Stability

- Two timing-dependent failures showed up in repeated runs, both in step 01 of the ENE run, and are handled:
  1. `walkTutorial()` sampled the Monitor tutorial before it had rendered. It now waits up to 10 s for an expected tutorial, and 1 s for one that must not appear.
  2. The vendor `DeviceImage` sometimes renders before the monitor's model name is known. This is the empty-model `ImageCache/normal.png` miss of §6, now accepted in exactly that form.

  The final three consecutive `npm run test:e2e` runs passed 51 of 51 each (see the task result).
- Things that keep it deterministic:
  - the simulated idle time (not Xvfb's);
  - the dialogs stubbed in main (`stubDialogs`, restored afterwards);
  - the probe-driven hotplug through main's real gate;
  - every Select, Slider and Menu driven through the vendor components' own events (`vendor-ui.ts`).
- Screenshots are artifacts, not assertions (`snapshot()` keeps the error text if Chromium refuses a capture).

## 8. Screenshots

`test/e2e/artifacts/walkthrough/<run>/NN-<page>.png` (git-ignored), listed in the task result. `34M2C8600` and `34M2C8600-no-ene` have 86 steps each (00-85), and the ENE run one extra screenshot inside step 30 (`30-ambiglow-follow-video-brightness-burst-ticked.png`).

## 9. Limitations and items for other owners

- **Not covered here:**
  - the tray and the window buttons (minimize, maximize, close);
  - the Wayland portal and a real PipeWire capture (X11 `desktopCapturer` under Xvfb only);
  - FollowAudio (no `parec` in the container);
  - an app restart with persisted state;
  - a second monitor model and switching between two monitors;
  - `PHL_SwapPIPPBP`, SmartFrame size and position, Audio EQ and mode;
  - the OLED "Refresh" buttons and the remaining selects of System and Setup (each tab is only rendered).

  The contract and unit tests cover those backend paths.
- **User documentation (binding decision):** Reset and Factory reset send VCP 0x04 = 1. The walkthrough checks it in three places (steps 81-83). No user-facing document exists in the repository yet; the text for it is in impl-integration §5 (packaging/docs owner). *Resolved: `docs/port/USER-GUIDE.md` "Reset and Factory reset also reset the monitor", plus README.Debian and the man page.*
- **main (`local-protocol.ts`):** every refused `local:` request is logged at warn level. An app whose `.desktop` entry has no displayable icon makes `Comm_GenAppIcon` answer `""`, so the renderer requests `local:///` at every render of that bind icon, which gives one warning per render. Consider debug level for the empty path.
- The mock probe changes only the simulated environment (idle time, OSD-side changes, hotplug). The production behaviour it drives is main's gate and the unchanged backend.
