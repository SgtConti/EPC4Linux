# Implementation notes: `ambiglow` (Ambiglow effects, ENE and DDC paths, follow-video/audio, breathing, idle)

Module owner: ambiglow. Sources: `port/src/backend/ambiglow/` (except the ENE driver files `ene*.ts` and `mock-ene.ts`, which belong to usb-ene, see `impl-usb-ene.md`), `port/src/backend/api/effect.ts`, `port/src/backend/api/sync-effect.ts`. Tests: `port/test/unit/ambiglow/` (102 tests) and the driver's `port/test/unit/ambiglow-ene/` (72 tests):

```
MSYS_NO_PATHCONV=1 docker run --rm -v "C:\path\to\repo:/repo" -w /repo/port evnia-port-dev \
  bash -c 'node --test "test/unit/ambiglow/**/*.test.ts" "test/unit/ambiglow-ene/**/*.test.ts"'
```

Specs: `docs/re/09-ambiglow-lighting.md` (§5-§11, §14, §16, plan B-D), `12-equipment-option-entities.md` §3.6 and §7, `05-backend-host.md` §2.6, `20-backend-host-tail.md` §2.4-2.5 and §3 rows 7 and 79-97, `20-enum-valuelist-catalog.md` §6.1-6.4 and §6.6, `20-theme-profile-engine.md` §3.7 (`color.data`) and §5.5 (`Sync_Profile`), `impl-usb-ene.md` §2 and §5, `impl-monitor.md` §2.3 and §5. Ground truth: `work/dotnet-clean/…/PHLDisplay/CDevice_PHLDisplay.cs` (method_14..17 :754-952, EffectEnableTemp :954-972, EffectEnable :974-1008, the setters :1010-1152, EffectReset :1154-1188, method_17 :1190-1203, GetEffectLEDs :1205-1212, OnFollowVideo/OnFollowAudio/OnBreathing :1223-1316), `Zeasn.Framework.Core.Lib/SystemOper.cs` (CheckSoftEffect :1466, EffectEnableTemp :1481-1502, the Effect_* and SyncEffect_* functions :1351-1636, OnBreathingData :1799-1847), `GlobalOper.cs` (CheckIdle :108-118).

---

## 1. Files and public API

| File | Content |
|---|---|
| `service.ts` | `AmbiglowServiceImpl` (implements `services.ts AmbiglowService`), `createAmbiglowService(core, { themes, monitors }, options?)`, `ambiglowEngineFor(services)`, `AmbiglowEngine` (the Bridge-facing surface), `AmbiglowServiceOptions`, `DdcSuspension`; constants `ENE_LOST_GRACE_MS` (2000), `ENE_AWAY_CAPTURE_MS` (10 min), `DDC_WAKE_RETRY_MS` ([2000, 5000, 10000]), `STOP_RESTORE_TIMEOUT_MS` (3000), `NOTIFY_SYNC_DEVICES`, `EffectTexts`, `DYNAMIC_LIGHTING_UNAVAILABLE` (−1) |
| `ddc-fallback.ts` | The DDC/CI Ambiglow path: `DisplayOsd` (DataOSD.GetAttributeInfo rebuilt from the display's capability string), `writeAttribute`, `writeAttributeChecked`, `writeVerified` (write + read-back), `readAttribute`, `readModule`; `AMBIGLOW_OFF`, `AMBIGLOW_STATIC`, `AMBIGLOW_RESET_OP` (E2A038), `AMBIGLOW_RESET_SETTLE_MS` (200) |
| `follow-video.ts` | `FollowVideoEngine` (`setWanted(wanted, { retry })`, `setSpeed(speed)`, `setPaused(paused)`, `state`, `cadence`, `paused`, `captureIntervalMs`, `uploads`, `starts`, `retunes`), the speed tiers `FOLLOW_VIDEO_CADENCES`, `followVideoCadence(speed)`, `FOLLOW_VIDEO_DEFAULT_SPEED` (2), `describeCadence`, `ledLayout`, `frameLedColors`, `mapFrameToLeds`, `solidGrid`, `FOLLOW_VIDEO_CAPTURE_MS` (300), `FOLLOW_VIDEO_SEND_MS` (100), `FOLLOW_VIDEO_BUSY_RETRY_MS` (20), `FOLLOW_VIDEO_PAUSED_CAPTURE_MS` (1000) |
| `follow-audio.ts` | `FollowAudioEngine` (`setWanted`, `state`, `writes`, `lastLevel`), `FOLLOW_AUDIO_INTERVAL_MS` (40) |
| `breathing.ts` | The synced-breathing curve: `BreathingGenerator` (SystemOper.OnBreathingData), `BreathingEngine` (40 ms solid frames), `breathingSteps`, `breathingBrightness`, `multiplyRgb`, `BREATHING_PALETTE`, `BREATHING_TICK_MS` |
| `idle.ts` | `IdleMonitor` (`start`, `stop`, `reset`, `check`, `idle`), `isIdle` (GlobalOper.CheckIdle), `IDLE_CHECK_INTERVAL_MS` (1000) |
| `sync.ts` | `Sync_Profile` model: `parseSyncProfile`, `syncEffectData` (smethod_11), `enableSyncDevices` (SyncEffect_EnableDevice), `isInEffectSync`, `canBreathingSync`, `removeSyncDevice`, `parseSelDevices`, … |
| `menu.ts` | `vendorEffectMenu` (DisplayEffectMenu.Default, byte-exact), `displayEffectMenu` (what Effect_GetMenu serves: the vendor menu plus the FollowVideo Speed slider with an ENE, deviation 17), `FOLLOW_VIDEO_SPEED_MENU`, `effectRegions`, `EffectMenuCache` (per ENE model) |
| `color-data.ts` | `ColorDataStore`, `colorDataPath`, `defaultColorData` (Config/color.data) |
| `timers.ts` | `EffectTimers` seam and `realTimers` (unref'd Node timers) |
| `api/effect.ts` | `effectApi`: the 17 Effect_* overloads and `AmbiScape_EnableFollowVideo` |
| `api/sync-effect.ts` | `syncEffectApi`: `SyncEffect_GetData`, `SyncEffect_EnableDevice` |

The ENE driver (`ene.ts`, `ene-params.ts`, `ene-frame.ts`, `ene-layout.ts`, `ene-registers.ts`, `ene-transport.ts`, `mock-ene.ts`) is documented in `impl-usb-ene.md`. This module added one option there: `EneDevice.setEffect(ps, { suspended: true })` (§4.4).

Diagnostics on the service (used by the tests, harmless in production): `ene`, `display`, `idle`, `followVideo`, `followAudio`, `breathing`, `ddcSuspension`, `checkIdle()`, `settled()`.

---

## 2. Integration contract (composition root, monitor driver, Electron main)

### 2.1 Factory and wiring

```ts
const themes   = createThemeStore(core);
const monitors = createMonitorManager(core, { themes });
const ambiglow = createAmbiglowService(core, { themes, monitors }, options?);   // AmbiglowServiceOptions
monitors.bindAmbiglow(ambiglow);          // attach() after every load/reload/apply/reset, checkEne() in every full read
```

This is what `src/backend/compose.ts createDefaultServices` does (impl-integration §2). Without `bindAmbiglow` the display never learns about its ENE: the first `Profile_GetDeviceData` reports `ENEEffectEnable:false` and the renderer shows the DDC Ambiglow page.

`createBackend` starts the slots themes → monitors → ambiglow and stops them in reverse, so `ambiglow.stop()` runs first at shutdown (the ENE is released while the monitor manager still exists).

`AmbiglowServiceOptions` (all optional; production passes none): `usb` (ENE USB backend, `null` = DDC only), `layouts` (parsed `PCenter_AmbiglowInfo.json`), `ene` (transport pacing/sleep), `timers`, `clock` (Effect_Reset's 200 ms), `eneFrameBurst` (experimental single-transfer frames, default `EVNIA_ENE_FRAME_BURST=1`; impl-usb-ene §2.2), `idleIntervalMs`, `lostGraceMs`, `awayCaptureMs`, `ddcWakeRetryMs`, `stopRestoreTimeoutMs`.

**USB backend selection** (`#usbBackend`): `options.usb` if given; in mock mode (`BackendOptions.mockMonitor`) the simulated bus of `MonitorManagerImpl.mockHardware` (a mock monitor wins over `noHardware`); with `noHardware` none, even when `BackendOptions.usb` is set; else `BackendOptions.usb` (the one `LibusbBackend` shared with the VIA bridges); else an own `LibusbBackend`.

### 2.2 `attach(display)` and `checkEne(display)`

- **`attach(display | null)`** — the monitor manager calls it for the current display after its load, reload, profile apply or reset (the display's `onEffectInfoChanged` hook) and on USB changes that touch its ENE; `attach(null)` when no connected display is left. An attach of another display object first detaches the previous one (engines off, timers cancelled) but **keeps an ENE that `checkEne()` already paired with the display being attached** (`#eneOwner === display.key`): on every first attach the load's full read has just opened and identified it (walkthrough finding, impl-walkthrough §5). Any other held ENE is closed as before. It pairs the display with its ENE (reconcile, §4.1), reports a changed ENE state through `display.setEneModel(model | '')` (the display updates `ENEEffectEnable`/`EffectInfo`, on loss writes E2A019 back, saves and sends `NotifyUIDisplayEffectChange`), then in `display.exclusive()` pushes `EffectInfo` to the ENE (method_12's ENE branch → method_17) or, without ENE, applies the idle state of the DDC path, and finally re-evaluates the engines (CheckSoftEffect). An `attach()` before `start()` only records the display; `start()` attaches it.
- **`checkEne(display)`** — vendor `method_14` at the top of every full VCP read (first load, `PHL_ReloadData`, `Profile_Reset`; PHL/CDevice_PHLDisplay.cs:328). It runs while the display's queue is held by that read and returns the ENE model (`"34M2C8600"`) or `''`. It never waits for the display queue and never awaits `display.ready()`. After `stop()` it probes nothing and returns the model last reported (no change).

### 2.3 Lock order (no deadlock with the display queue)

- `#serial` serializes `attach()`, idle transitions and DDC retries. Holding it, the service may wait for the display queue (`display.exclusive`, `setEneModel`). The display queue never waits for `#serial`.
- `#lifecycle` guards ENE open/close/probe (the reconcile). It never waits for the display queue, because `checkEne()` takes it while the queue is held by a load.
- Order: `#serial` → display queue → `#lifecycle`. The display queue → `#lifecycle` (checkEne) is the only other edge.
- `stop()` never waits for `#serial`: a queued `attach()` may be waiting behind a 20 s load. It stops the engines at once, takes `#lifecycle` only (release the ENE), and bounds its wait for the display queue (DDC restore, `STOP_RESTORE_TIMEOUT_MS`). An attach still running afterwards opens and reports nothing (`#stopped`, `#started`).
- The ENE driver serializes its own register traffic; frame, level and breathing producers skip a tick while it is busy (never queue).

### 2.4 What the host (Electron main) must provide — `HostServices`

| Member | Used for | Expectations |
|---|---|---|
| `capture.startVideo(intervalMs, onFrame)` | FollowVideo | called with the speed tier's interval (300 / 100 / 40 ms, §4.2); frames are 50×40 RGBA `CaptureFrame`s; resolves `true` once frames flow, `false` when denied/unavailable/superseded/60 s timeout, never throws; frames of a stopped or superseded start must not be delivered |
| `capture.stopVideo()` | FollowVideo | synchronous, idempotent (it may run after the host disposed the capture at exit) |
| `capture.setVideoInterval?(intervalMs)` | FollowVideo speed change | optional (appended to `CaptureHost`): retune the current session, running or still starting, to the new interval without a new session (no portal dialog); no-op while nothing is captured, never throws. Without it a speed change keeps the start's interval (logged once) and changes only the uploads |
| `capture.startAudio(onLevel)` / `stopAudio()` | FollowAudio | a float level 0..255 every ~40 ms; the driver truncates it to a byte |
| `getIdleSeconds()` | idle lights-off | whole seconds since the last input (`powerMonitor.getSystemIdleTime`); absent → never idle |
| `resourcesDir` | ENE layout table, menu regions, device records | `<resourcesDir>/ENE/PCenter_AmbiglowInfo.json` (or `data/ENE/…`), `<resourcesDir>/PCenter_DeviceInfo.json` |
| `serveDataDir` | `Config/color.data` | |

Without `capture` FollowVideo/FollowAudio are inert (logged once); the ENE still gets the ParameterSet.

**Capture-host request (electron-shell owner).** On GNOME Wayland every `startVideo` shows the xdg-desktop-portal ScreenCast dialog (impl-electron-shell "Capture host"). This service keeps the capture session through idle and short ENE absences (§4.2) to avoid most of them, but a new session is still needed after the display was detached, FollowVideo was re-selected, or the ENE stayed away longer than 10 minutes. Persisting the portal `restore_token` (`persist_mode: 2`, 09 plan B) would make the dialog appear only once.

### 2.5 ThemeStore use

`getSoftConfig()` (idle settings, read on every 1 s poll), `getSyncProfile()`/`setSyncProfile()` (light-sync group, breathing sync), `onSwitched()` (re-evaluate breathing sync and the engines after a switch/apply/reset; decides the DDC idle record, §4.3). `saveParticipant` is reached through `display.settingsChanged()`.

### 2.6 API modules

`effectApi` and `syncEffectApi` register the 20 ambiglow-owned overloads of `api/catalog.ts` with their exact C# signatures. Each call resolves `ambiglowEngineFor(services)`:

- `services.ambiglow` when it is an `AmbiglowServiceImpl`, or an object that delegates the whole `AmbiglowEngine` surface;
- a detached engine (no USB, no timers, same theme store and monitor manager) only when the composition has no ambiglow service at all;
- a partial stand-in (e.g. one that forwards only `attach`) is an integration error: logged once (`services.ambiglow does not implement the Effect_* engine…`), and the detached engine answers, so nothing reaches an ENE.

`smethod_9(device)`: only the connected current display (DeviceType 100000) has an effect driver; any other device or no connected display answers `"functionName: <fn>  return null obj"` (two spaces).

### 2.7 Notifications

- `NotifyEffectSyncDevicesChange` (Effect_Reset): the raw Sync_Profile after RemoveAll, `null` when the profile has none.
- `NotifyUIDisplayEffectChange` is sent by the display driver (`monitor/display.ts #notifyEffect`) when `setEneModel` changes the ENE state: `{ENEEnable, EffectInfo, ModuleAmbiglow, Item1, Item2, Item3}` — the named keys the renderer reads (Monitor-D4qz4RBn.js:85-91) first, then the vendor's ValueTuple keys with the same values (12 §7 port plan item 7).

---

## 3. Vendor call sites → port behaviour

| Bridge / event | Vendor (CDevice_PHLDisplay / SystemOper) | Port |
|---|---|---|
| `Effect_CheckDynamicLightingEnabled` | registry value −1/0/1 | Tag −1 (the page stops polling, 09 §12) |
| `Effect_OpenDynamicLightingSetting` | opens ms-settings | Tag null, nothing opened |
| `Effect_GetColorData` / `Effect_SetSelfColors` | Config/color.data | same file format (BOM + one line); DefData() when missing/unreadable; golden step 7 byte-exact |
| `Effect_GetMenu(100000)` | `DisplayEffectMenu.Default(string_0)`, cached per model | same, cached; §6.2 (no ENE, 3277 bytes) byte-exact; with the ENE §6.1 (3962 bytes) byte-exact except the FollowVideo item's `SupSpeed` (true: the Speed slider, deviation 17) |
| `Effect_GetLEDs` | ENE mirror in FollowVideo/FollowAudio, else `"not ene follow video or audio"` | same; lock-free (polled every ~30 ms); the mirror is correct (impl-usb-ene deviation 13) |
| `Effect_Enable` | ENE: EffectEnable + ParameterSet + save. DDC: `"NotSupport"` without E2A019, else ModuleAmbiglow.EffectEnable, E2A019 = mode / Off, recheck + save; `CancelEffectSync` on disable; Tag = flag | same; also drops a DDC idle record (§4.3) |
| `Effect_Change`, `_RandomEnable`, `_RainbowEnable`, `_ColorChange` (ToByte, rainbow/random off), `_BgColorChange`, `_DirectionChange`, `_RegionChange` | `"Not Support ENE"` without ENE; edit EffectInfo, method_17, CheckEffectSync else SaveProfile; Tag EffectInfo | same |
| `Effect_SpeedChange` / `_BrightnessChange` | no ParameterSet for FollowVideo/FollowAudio/Breathing | no ParameterSet for FollowVideo/FollowAudio and synced Breathing (deviation 5); a FollowVideo speed selects the host's cadence tier and retunes the running capture (deviation 17) |
| `Effect_Reset` | RemoveAll + `NotifyEffectSyncDevicesChange`; DDC: E2A038 = 1, 200 ms, re-read, recheck + save, Tag ModuleAmbiglow; ENE: `DisplayEffectInfo.Default`, method_17, sync or save, Tag EffectInfo | same (DDC mode shown: deviation 1) |
| `SyncEffect_GetData` | smethod_11 (normalize, clear SyncStatus with ≤1 synced device) | same; golden step 6 byte-exact |
| `SyncEffect_EnableDevice` | group edit; `"Input device=100000 EffectDetail is null"` without an enabled ENE effect | same vendor texts |
| `AmbiScape_EnableFollowVideo` | bulbs + `EnableFollowVideoTimer(enable)` | Tag null, no-op (deviation 3) |
| method_14 (plug) / method_15 (unplug) | Plug on every USBChange | reconcile on attach/checkEne and on a lost handle (§4.1) |
| method_17 | ParameterSet (twice for unsynced Breathing), CheckSoftEffect with bool_4 | once; the timers are re-evaluated after every call (idempotent) |
| CheckSoftEffect | FollowVideo/FollowAudio/Breathing timers per effect type, regardless of idle | per display; not while idle; FollowVideo session policy §4.2 |
| EffectEnableTemp (idle) | ENE: ParameterSet of a copy with EffectEnable = !idle. DDC: E2A019 ← Off / stored mode. Timers stopped while idle | §4.3, §4.4 |
| OnFollowVideo / OnFollowAudio | CalcRGBs(50,40) → ParameterVideoSync; level → ParameterAudioSync | host grid → `writeVideoFrame`; level → `writeAudioLevel` |
| OnBreathing | synced: mode 14 + solid 40×50 frames; mode switch 14 ↔ 7 via bool_3 | `BreathingEngine`; the mode switch on the events that can change the sync state (Effect_*, SyncEffect_*, theme switch) |
| GlobalOper.CheckIdle | 1 s, `IsIdle = enabled && idle ≥ duration·60 s`, logs `Idle state:True/False` | same (`IdleMonitor`), from service start |

---

## 4. Behaviour

### 4.1 ENE pairing (reconcile)

The ENE is the one discovery paired with the display (`DisplayDevice.ene`, same hub). A held device is kept while it is open, not lost, still the same enumeration (id **and** bus address), owned by this display and still `display.ene`; otherwise it is closed (the LEDs are handed back with `0x0023 ← 0` only if the driver holds host control and the handle is alive). Then the paired enumeration is opened and identified, and its model is checked against the monitor (`matchEneModelName`, CUSBENE6K7732.GetModelName).

- `EneError` (`not-ene`, `invalid-firmware`, `unsupported-model`): the device is unusable; that enumeration is not probed again until it is re-plugged.
- Model mismatch: remembered for that display and enumeration only; the same ENE is probed again for another display.
- `UsbError('access')` (missing udev rule): warned once per enumeration, probed again at every reconcile, so after `udevadm trigger` (which does not re-enumerate) the next attach — a reload, a profile switch, a USB change — uses the ENE.
- An empty enumeration keeps a held device that is not known to be lost (`LibusbBackend.list()` answers `[]` when libusb's device list fails). A device that is really gone fails its next operation with `no-device`.
- **Lost handle** (`onLost`): the service re-checks after `ENE_LOST_GRACE_MS` (2 s, the USBChange window). An ENE that re-enumerated in that window is re-opened and the effect re-applied without any DDC fallback or notification. Otherwise the display falls back to DDC (`setEneModel('')` → method_15).
- **Gone on a USB change** (monitor standby, KVM switch: discovery no longer pairs it, no operation failed): the reconcile drops it and the display falls back to DDC; like a lost handle it counts as *away* for the FollowVideo session (§4.2).

### 4.2 FollowVideo, FollowAudio, synced Breathing (CheckSoftEffect)

"Active" = the service runs, the current display's ENE is usable and drives an enabled effect, and the user is not idle.

- **FollowAudio** and **synced Breathing** run only while active (vendor timers; stopped while idle, EffectEnableTemp).
- **FollowVideo** separates the capture session from the uploads, because on Wayland every capture start is a portal dialog:
  - the session **starts** only while active (never while idle or while the ENE is away);
  - it is **kept, uploads paused**, while idle and while the ENE that drove the display is away (a lost handle, or gone on a USB change: monitor standby, USB re-enumeration) — up to `ENE_AWAY_CAPTURE_MS` (10 min), also across the DDC fallback. While paused, the kept session is **slowed to one frame per second** (`FOLLOW_VIDEO_PAUSED_CAPTURE_MS`), with the same in-place retune as a speed change (no new session, no portal dialog); resuming restores the tier's interval. Idle can last hours, and the capture's CPU grows with its rate. `#checkSoftEffect` stops before it pauses and resumes before it starts, so a session that ends is not retuned first, and a start on wake asks the tier's interval at once;
  - it **stops** when FollowVideo is no longer the enabled effect, the display is detached, the ENE stayed away longer than 10 min, or the service stops;
  - uploads follow the speed tier (below); a frame is sent once, never queued; after a pause the newest frame is sent again;
  - a start the host refused (`false`) leaves the engine `failed`: no retry loop; one new attempt on each wake from idle, or when FollowVideo is selected again.
- The per-LED mapping is the driver's (`ene-frame.ts`, 09 §7.3): the JSON border sub-counts of `PCenter_AmbiglowInfo.json` (34M2C8600: R3 RU4 LU4 L3) and the device's central/bottom counts (18/14) = 46 LEDs, six paced writes at `0xE300…`.

**FollowVideo speed tiers** (deviation 17). The vendor cadence (a screenshot every 300 ms, the newest one on a 100 ms tick, then about 65 ms for the six paced writes: up to about 465 ms from screen to LEDs) is felt as laggy, on Windows too. The FollowVideo entry's `EffectDetail.Speed`, set with the Ambiglow page's Speed slider, selects the cadence (`follow-video.ts FOLLOW_VIDEO_CADENCES`):

| Speed (slider mark) | Capture interval asked of the host | Uploads | LED updates per second | Lag of a screen change, average / worst |
|---|---|---|---|---|
| 1 Low | 300 ms (the source delivers a frame every 300 ms) | the newest frame on a fixed 100 ms tick: **the vendor's cadence** | ~3.3 | ~265 / ~465 ms: **the same as the Windows app** |
| 2 Normal (default; also a missing, 0 or out-of-range speed) | 100 ms | event-driven: each new frame as soon as it arrives (the ENE is free again after ~65 ms) | 10 | ~115 / ~165 ms |
| 3 High | 40 ms (25 fps asked) | event-driven, the newest frame whenever the ENE is free | ~15 (bound by the ~65 ms paced upload) | ~115 / ~170 ms |

The lag adds up four terms:
- the wait for the source's next frame, up to one capture interval. The capture page samples each source frame as it arrives (impl-electron-shell "Capture host", frame-driven sampling), so the frame has no further age. The vendor grabbed its GDI screenshot at the moment it sampled, which is the same;
- Low only: up to 100 ms for the tick;
- High only: up to ~65 ms for the upload in flight, since frames come faster than the ENE takes them;
- the ~65 ms upload itself (6 × (~1 ms transfer + 10 ms pacing)).

Not counted: a few ms for the grab and its delivery to main, and the monitor's own latency. The capture e2e test measures the capture part at 300 ms under Xvfb, including the repaint of its test window: median 149 ms, max 266 ms.

Before frame-driven sampling (review of 2026-09-27; still true of the timer fallback), the page's timer ran out of phase with the source and added up to one more interval: Low ≈ 430 / 800 ms, Normal ≈ 165 / 265 ms, High ≈ 135 / 210 ms. The capture e2e test measured 439 ms median at 300 ms with the fallback forced.

With the vendor's six paced writes the upload, not the capture, limits High. It gives about 50 % more LED updates than Normal (smoother motion) at about the same lag. A faster upload would let High reach its 25 updates per second at roughly 30 / 50 ms (the experimental single-transfer frame, impl-usb-ene §2.2, about 11 ms: one transfer and one 10 ms pause).

- **Event-driven uploads, newest frame wins.** One upload runs at a time. Frames that arrive meanwhile replace each other, and the newest goes out when the upload finished; nothing is queued. While the ENE is busy with something else (a ParameterSet), the newest frame is tried again every `FOLLOW_VIDEO_BUSY_RETRY_MS` (20 ms).
- **Where the speed comes from.** `#checkSoftEffect` passes the FollowVideo entry's Speed to `FollowVideoEngine.setSpeed` whenever FollowVideo is wanted: the start uses it, and every re-evaluation applies a changed one: `Effect_SpeedChange` (no ParameterSet, as before), a profile apply or reload (`attach`), a theme switch (`onSwitched`). The speed is stored per profile in the FollowVideo entry, like the other effects' speeds, so a Windows profile (Speed 2 by default) opens as Normal.
- **Live retune, same session.** A speed change of a running or starting session calls `CaptureHost.setVideoInterval` and switches the upload scheduling at once; the capture session is kept, so GNOME Wayland shows no new ScreenCast dialog. A host without `setVideoInterval` keeps the start's interval until the next start. Idle, the ENE away and a refused start behave as above in every tier.
- **Without the ENE** the monitor firmware renders FollowVideo (`E2A019 = 1`); the host has no rate to change, so the DDC menu keeps the vendor item and the renderer does not ask for the ENE menu at all (Monitor-D4qz4RBn.js:45-48).

### 4.3 Idle lights-off over DDC/CI (no ENE)

- Idle: E2A019 ← AmbiglowOff, only while the user's Ambiglow is on (`ModuleAmbiglow.EffectEnable` and a mode other than Off). The service records the display and the mode (`DdcSuspension`).
- An attach while idle (a load, reload or profile apply wrote the Ambiglow on again): E2A019 ← Off again and the record takes the new mode. A load or reload during idle reads the idle Off back and shows the Ambiglow as disabled (PHL/…:379-390); the record survives it.
- `ThemeStore.onSwitched`: the switched-to profile decides — an Ambiglow it switches on becomes the mode to restore, one it switches off drops the record.
- Wake: E2A019 ← the mode DeviceData shows when it shows the Ambiglow on (PHL_SetOSD may have changed it); when DeviceData shows Off although this service switched it off (the read-back above), DeviceData gets `EffectEnable = true` and the recorded mode back and is saved. The write is verified by a read-back. A monitor that did not take it (still coming out of DPMS standby, NAK) gets retries after 2 s, 5 s and 10 s, and the next attach of that display (the reload after the monitor is back) tries again.
- `Effect_Enable` and `Effect_Reset` drop the record (the user decided). `stop()` restores the Ambiglow (one verified write, bounded wait). A record is kept across `attach(null)` for the display's return.

### 4.4 Idle lights-off with the ENE

- Idle: `lightsOff()` (the requested effect with mode LEDOFF, `0x0023 ← 0`); wake: `lightsOn()`. The driver acts only on a requested effect that is on / suspended, which is the vendor's `EffectInfo.EffectEnable` test.
- Every push while idle uses `setEffect(ps, { suspended: true })`: the effect becomes the requested state for the wake, the LEDs stay dark (nothing is written when they already are; a freshly opened device gets the LEDOFF variant once). So a profile switch, a reload or an ENE re-open during idle never flashes the Ambiglow on.

---

## 5. Deviations from the vendor (deliberate)

1. **Effect_Reset over DDC keeps a non-Off mode as read.** The vendor sets `EXT_OP_E2A0_19.Value = StaticMode` whatever the monitor reports after E2A038 = 1 (CDevice_PHLDisplay.cs:1175), so its Tag says Static even when the monitor's own reset left another mode. The port shows Static only for Off, like the load (PHL/…:382-389). The Tag differs from the vendor's only in that value.
2. **DDC idle acts only while the user's Ambiglow is on.** The vendor's EffectEnableTemp tests only the stored mode (:954-963), which is StaticMode even when the Ambiglow is off (the load shows Off as Static), so every wake switched a disabled Ambiglow on in Static mode (`idle.test.ts` "a disabled Ambiglow is not switched on by the wake").
3. **`AmbiScape_EnableFollowVideo` is a no-op** (Tag null). The smart bulbs are out of scope (ARCHITECTURE "Scope"). The vendor also switched the capture timer with it (SystemOper.cs:377-382), which stopped the display's own FollowVideo whenever the bulb page disabled AmbiScape.
4. **A disabled Breathing is off; ParameterSet is sent once.** method_17 forces mode 7 for Breathing even when disabled, so Effect_Enable(false) and idle left a breathing effect running, and it sends unsynced Breathing twice (impl-usb-ene deviations 1-2, `toEneParameterSet`).
5. **Live speed/brightness for firmware Breathing.** The vendor skips the ParameterSet for every Breathing (:1088-1121, 09 §16 quirk 4). In the monitor-only port the display is never in a group of more than one (SyncEffect_GetData clears SyncStatus), so Breathing is always the firmware effect (mode 7/8) and the Breathing sliders the menu offers (SupSpeed/SupBrightness, 20-enum §6.1) would never reach the LEDs. The port re-sends the ParameterSet unless the Breathing is synced (host curve, mode 14). The Tag is the vendor's.
6. **FollowVideo capture session policy** (§4.2). The vendor stops the capture thread on idle (StopAllTimer) and restarts it on wake, and restarts it on every re-plug; on Windows that costs nothing, on GNOME Wayland each start is a portal dialog. The port keeps the session through idle and short ENE absences and pauses only the uploads; a refused start is retried once per wake, never in a loop; a frame is uploaded once (the vendor re-sends the same screenshot, 09 §16 quirk 3); frames are skipped, not queued, while the ENE is busy (09 plan A.7); the newest frame is re-sent after a pause.
7. **DDC idle restore is remembered and verified** (§4.3). The vendor's wake is one unchecked write of the stored mode, and a load or reload during idle reads E2A019 = 0 and saves the Ambiglow as disabled for good. The port keeps a record, verifies the wake write by a read-back, retries it, restores DeviceData after the idle read-back, lets a profile switch decide, and restores the Ambiglow at `stop()`.
8. **No flash on an attach during idle** (§4.4). The vendor's method_17 during idle (a profile switch, a re-plug) lights the effect until the next EffectEnableTemp.
9. **ENE reconcile instead of re-plug on every USB change** (§4.1; 09 §16 quirk 8, impl-usb-ene deviation 18): only new, lost or re-enumerated devices are probed; an empty enumeration does not drop a working device; a permission failure is not remembered; a model mismatch is remembered per display; a lost handle is re-checked after 2 s.
10. **`stop()` hands the LEDs back** (`0x0023 ← 0`, UnPlug) and restores a DDC idle lights-off; the vendor does neither at exit (09 §16 quirk 6). It does not wait for queued attaches.
11. **Engines are gated on idle.** The vendor's CheckSoftEffect restarts the timers by effect type even while idle (SystemOper.cs:1466-1479); the port runs FollowAudio and the breathing curve only when not idle and never starts a capture while idle.
12. **`NotifyUIDisplayEffectChange` carries the named keys and `Item1..3`** (sent by `monitor/display.ts`; §2.7). The vendor's ValueTuple alone makes the renderer handler throw (12 §3.6, 02 §6).
13. **Breathing sync switch on events.** The vendor's 40 ms breathing timer runs for every Breathing and OnBreathing switches mode 14 ↔ 7 when `IsCanBreathingSync` changes (bool_3). The port runs the curve only while synced and makes the switch when an Effect_*, SyncEffect_* call or a theme switch can have changed the group.
14. **The idle poll starts with the service**, not at the first hub connection (EvniaHub.cs:41-49), a few seconds earlier at app start. The idle source is `HostServices.getIdleSeconds` (whole seconds).
15. **No USB with `noHardware`**, even when `BackendOptions.usb` is given (compose.ts semantics, impl-integration §2.1).
16. **`ambiglowEngineFor`** (§2.6) is port-only: a composition without the ambiglow service still answers every Effect_* over DDC, and a partial stand-in is reported.
17. **A Speed slider for FollowVideo (with the ENE): the host's cadence tiers** (§4.2; requested by the user, 2026-09-27). The vendor's FollowVideo item has `SupSpeed: false` and a fixed 300 + 100 ms cadence (EffectTimerMgr.cs:65-175).
    - **Wire:** `Effect_GetMenu` with an ENE serves the FollowVideo item with `SupSpeed: true` (`MinSpeed` 1, `MaxSpeed` 3, `SpeedStep` 1, which are the vendor's values already). This is a deliberate difference from the byte-exact fixture 20-enum §6.1: the served menu is 3961 bytes instead of 3962. The tests assert the fixture byte for byte after putting back the vendor's `"SupSpeed":false` (`test/fixtures/effect-menu.ts vendorMenuText`), so any other drift still fails. `vendorEffectMenu()` keeps the exact vendor menu. The no-ENE menu (§6.2) is unchanged.
    - **UI:** no renderer patch. The vendor's own Ambiglow Speed slider appears (Ambiglow-Dvqon39u.js:1059-1072). Its range starts at `MinBrightness` (a vendor bug), which is 1 for the FollowVideo item, so it shows exactly the three marks 1..3, Low/Normal/High (`menu.test.ts` replays that code). `Effect_SpeedChange` stores `EffectDetail.Speed` in the FollowVideo entry, as for every other effect, and sends no ParameterSet (vendor :1088-1103).
    - **Behaviour:** 1 Low = the vendor cadence, and with frame-driven sampling also the vendor's lag; 2 Normal (default) and 3 High are faster and event-driven (§4.2 table). A change retunes the running capture without a new session. While the uploads are paused (idle, the ENE away) the kept session runs at 1 fps in every tier.
    - **Compatibility:** a profile from Windows opens as Normal, since `DisplayEffectInfo.Default` stores Speed 2 (the user's `Default.pcenter` has 2). A profile saved here with another FollowVideo speed still loads on Windows, where the value is ignored.

---

## 6. Known limitations

- **Wayland portal.** A new capture session shows the ScreenCast dialog (after a display detach, re-selecting FollowVideo, an ENE absence longer than 10 min, or an app restart) until the capture host persists the portal `restore_token` (§2.4). A session the user ends from GNOME's sharing indicator is not reported to the backend (`CaptureHost` has no callback): the LEDs keep the last frame until FollowVideo is selected again. The capture page samples each frame the source delivers. The X11 desktop source delivers one every interval even for a still screen (measured under Xvfb), and each one is uploaded. A PipeWire (Wayland) source may deliver frames only when the screen changes; this is unverified.
- **DDC restore after standby.** The wake write is retried three times (about 17 s) and again at the next load of that display. When the monitor comes back without a reload and ignores all four writes, the Ambiglow stays off until the user switches it (DeviceData then shows it on). A crash during idle leaves E2A019 = 0 on the monitor (and, after a reload during idle, the Ambiglow disabled in the profile).
- **A profile switch racing a pending DDC restore.** The record follows `onSwitched`; an attach from the apply that runs before the event and a wake in between could restore the old mode once. It needs a theme switch within a second of the wake.
- **One ENE handle.** The service drives the ENE of the current display only; `checkEne` for another display closes it (the monitor-only port shows one display at a time, like the vendor's single display driver).
- **Synced breathing** is reachable only with a Windows `Sync_Profile` that lists peripherals; `SyncEffect_GetData` (called at Home mount) clears SyncStatus when at most one synced device is connected.
- **Idle time on GNOME Wayland** depends on Electron's `powerMonitor.getSystemIdleTime()` on that session (09 plan D lists Mutter's IdleMonitor as the reliable source); unverified.
- **FollowVideo speed High** asks the capture host for 25 frames per second and uploads each frame whenever the ENE is free, about 15 uploads per second (six paced writes of ~65 ms each), even for a still screen: frames with the same content are not skipped, since whether the firmware keeps the frame buffer across a ParameterSet is unverified. It costs more CPU (screen capture and scaling) than Low or Normal. Low and Normal differ from the vendor only as described in §4.2.
- **Unverified on hardware**: all ENE behaviour beyond the logged identity and the vendor's byte sequences (impl-usb-ene §4), whether the ENE takes about 15 frame uploads per second (FollowVideo High) without side effects, whether the monitor firmware renders DDC FollowVideo/FollowAudio itself (09 §14), and the monitor's DDC behaviour in and right after DPMS standby.
- **User-facing notes for the docs/packaging owner**: the Ambiglow needs the udev rule for `0cf2:a201` (without it the monitor's own DDC Ambiglow is used and a warning with the rule is logged); FollowVideo asks for screen-sharing consent on Wayland; "turn off lights when idle" switches the Ambiglow off after the configured minutes and back on at the next input; *Profile → Reset* and *Settings → Factory reset* also reset the monitor (VCP 0x04 = 1), including its own Ambiglow settings (binding decision, impl-integration §5). *Documented in `docs/port/USER-GUIDE.md` (Connecting the monitor, Desktop notes, Reset, Troubleshooting) and in README.Debian.*

---

## 7. Tests

| File | Covers |
|---|---|
| `ambiglow/service-ene.test.ts` (29) | load with the ENE: checkEne → ENE mode, identified once (the first attach keeps the device checkEne opened), the logged FollowVideo ParameterSet, capture (Normal, 100 ms: the profile's Speed 2), frame → LEDs → Effect_GetLEDs; Effect_GetMenu §6.1 bytes except the FollowVideo `SupSpeed` (deviation 17); FollowVideo Effect_SpeedChange retuning the running capture (High 40 ms, Low 300 ms + tick, unknown → Normal; no new session, no ParameterSet, saved); another effect's speed not touching the cadence and a re-selected FollowVideo starting at its stored speed; a profile apply and a theme switch applying the new profile's speed in place; the experimental frame burst (announced once, one transfer per frame); every Effect_* setter (replies, register writes, persistence, rainbow/random, regions); speed/brightness (FollowVideo skipped, firmware Breathing re-sent); synced Breathing mode 14 ↔ 8 following the group via onSwitched (one ParameterSet per change); a profile apply and a reload re-push EffectInfo; FollowAudio levels; Effect_Enable; Effect_Reset (notification, §6.3 bytes); light-sync group; SyncEffect_*; unplug → grace → DDC fallback with the `{named, Item1..3}` notification, replug; re-enumeration within the grace (no fallback, no second capture start); an absence past the grace (session kept, reused, ended after the away window); checkEne racing an attach and a reload (one probe); an empty enumeration; a model mismatch per display; another model and a permission failure (then fixed); stop() (release; not waiting for a queued attach; a pending capture start) |
| `ambiglow/service-ddc.test.ts` (8) | golden steps 6/7 byte-exact; the static functions; no ENE: nothing written by the service, "Not Support ENE"; Effect_Enable over DDC; "NotSupport"; Effect_Reset over DDC (notification, E2A038, 200 ms, re-read) and deviation 1; null-obj replies |
| `ambiglow/idle.test.ts` (14) | CheckIdle; IdleMonitor polling and logging; ENE idle (LEDOFF, uploads paused, the capture kept and slowed to 1000 ms, wake with one start, the tier interval again and the newest frame); attaches and a re-enumeration during idle without 0x0023 ← 04; the ENE leaving on a USB change during idle and coming back (one capture start); a failed capture retried on wake (at the tier interval: resumed before the start); a disabled ENE Ambiglow across idle; DDC idle with a verified wake; wake retries; Effect_Enable dropping a pending restore; a reload during idle restored in DeviceData and the profile; a profile switch during idle deciding the restore; stop() during idle; a disabled DDC Ambiglow across idle |
| `ambiglow/follow-video.test.ts` (22) | the §7.3 mapping (layout, solid, gradients, letterbox, pillarbox, bad grids); the speed tiers (1/2/3, defaults for missing, 0 and out-of-range values); Low: the vendor cadence (300/100 ms, newest once), busy skip and mode-14 drop, pause/resume; Normal on the real driver (each new frame at once, newest wins); event-driven newest-frame-wins with a controllable ENE (one upload at a time, nothing queued), the busy retry and its cancellation; live retune Normal → High → Low → Normal in one session; a host without `setVideoInterval`; `setSpeed` while stopped, starting and failed; refused start (no loop, retry on request); event-driven pause/resume (idle, ENE away); the paused session slowed to 1000 ms and restored on resume (a speed change while paused applies on resume, one session); a start while paused, and a failed retune asked again; a stop while the start is pending; no capture host: inert across speeds and pauses |
| `ambiglow/follow-audio.test.ts` (5), `breathing.test.ts` (5), `sync.test.ts` (8), `menu.test.ts` (6), `color-data.test.ts` (3) | the engines and pure models against the vendor formulas and fixtures; `menu.test.ts`: the vendor menu byte-exact (§6.1, §6.2), the served ENE menu = §6.1 except the FollowVideo speed fields (object level too), the renderer's Speed-slider code replayed (three marks 1..3 Low/Normal/High; hidden without the ENE) |
| `ambiglow/api.test.ts` (3) | the 20 overloads exactly; the fallback engine; `ambiglowEngineFor` with a delegate and with a partial stand-in (one error) |
| `ambiglow/backend.test.ts` (2) | the whole composition in mock mode with and without the ENE |
| `monitor/display-ops.test.ts`, `contract/*` | the `NotifyUIDisplayEffectChange` keys (named first, `Item1..3` equal) on plug and loss |

---

## 8. Review findings of this pass

| Finding | Resolution |
|---|---|
| no implementation notes | this document; §5 numbering is what the code cites |
| `NotifyUIDisplayEffectChange` without `Item1..3` | `monitor/display.ts #notifyEffect` sends both key sets (named first); `display-ops.test.ts`, `contract/replay.ts assertEffectChange` and `service-ene.test.ts` assert both and their equality |
| capture stopped on idle, ENE loss, re-attach (a portal dialog each time) | §4.2 session policy; `FollowVideoEngine.setPaused`, `setWanted(…, { retry })`; tests for idle → wake, re-enumeration, absence, retry. The `restore_token` request is with the capture-host owner (§2.4) |
| idle + attach flashes the Ambiglow | `EneDevice.setEffect(ps, { suspended })`; `#push` uses it while idle; driver and service tests |
| Breathing speed/brightness never reach the LEDs | deviation 5, test |
| DDC idle restore fragile, reload during idle disables the Ambiglow | §4.3, deviation 7, five tests |
| `#rejected` keyed by enumeration only; `access` permanent | per-display mismatch set, access not remembered, tests |
| empty enumeration drops the ENE | kept unless lost, test |
| `stop()` blocked behind `#serial`; DDC idle left off at stop | §2.3, tests |
| stale `data` in the breathing mode switch | re-read inside `exclusive`, re-checked |
| `ambiglowEngineFor` silent fallback | §2.6, test |
| contract stand-in without `checkEne` | resolved by the integration wave (the contract tests build the production composition with `bindAmbiglow`; the ENE-present scenario asserts the first `Profile_GetDeviceData` is in ENE mode) |
| missing service tests | added (see §7) |
| (e2e walkthrough, impl-walkthrough §5) every first `attach()` closed the ENE that the load's `checkEne()` had opened for that same display, and `#syncDisplay` opened and identified it again: a second USB open and ~15 identification reads at every start-up, display switch and rescan (two `ENE usb:3-2.1: chip 0x7730 …` lines 0.6 s apart in the backend log). No LED flicker (host control is only taken by the push that follows) | `#detach(next)` keeps a held ENE whose owner is `next.key`; `#syncDisplay`'s reconcile re-validates it. `service-ene.test.ts` "a load identifies the ENE once" (one identification probe since transfer 0, the logged ParameterSet pushed to the kept device, `attach(null)` still releases it); fails without the fix |

---

## 9. Follow video speed (2026-09-27, user request)

The user reported that Follow video lags, on Windows too. The cause is the vendor cadence the port reproduced exactly: a capture every 300 ms, the newest frame on a 100 ms tick, and a ~65 ms upload. The port now offers speed tiers (§4.2, deviation 17):

| Area | Change |
|---|---|
| `menu.ts` | `vendorEffectMenu` (the exact vendor menu) and `displayEffectMenu` (the ENE menu's FollowVideo item with `FOLLOW_VIDEO_SPEED_MENU`) |
| `follow-video.ts` | the tiers, `setSpeed` (live retune), event-driven newest-frame-wins uploads with a busy retry; the kept session slowed to 1000 ms while paused (`FOLLOW_VIDEO_PAUSED_CAPTURE_MS`); the `followVideo` service option (fixed intervals) was removed |
| `service.ts` | `#checkSoftEffect` passes the FollowVideo entry's Speed to the engine, stops before it pauses and resumes before it starts; `eneFrameBurst` |
| `types.ts` | `CaptureHost.setVideoInterval?` (appended, optional) |
| Electron main and capture page | `ElectronCaptureHost.setVideoInterval` and `videoStats`, the page command `setVideoInterval`, the 33 ms floor; the source asked for 1000 / interval fps (not rounded); frame-driven sampling with `MediaStreamTrackProcessor`, the `<video>` timer as fallback (impl-electron-shell "Capture host", deviations 36-37) |
| ENE driver | the experimental single-transfer frame, `EVNIA_ENE_FRAME_BURST=1`; a refused burst is warned about once and falls back to the six paced writes after three failures in a row (impl-usb-ene §2.2, deviation 20) |
| Tests | §7, plus `test/fixtures/effect-menu.ts` (the §6.1 fixture minus the one deviation, also used by `backend.test.ts` and the contract test), `capture-protocol.test.ts`, `capture-slot.test.ts`, `mock-probe.test.ts`, `ene-frame.test.ts` (the burst, its failure fallback), e2e `capture.test.ts` (retune, frame-driven sampling: the 300 ms spacing and the lag of a screen change) and the walkthrough steps "ambiglow-follow-video-speed" and "ambiglow-ddc-follow-video" (impl-walkthrough §4) |

The review of this change (2026-09-27) found no correctness bug and five small issues, all fixed. (1) The lag figures left out the age of the source frame. (2) The page sampled twice: the source at the asked rate, then a timer out of phase with it. Frame-driven sampling removes that term, so the §4.2 figures now hold, and Low really matches the Windows lag. (3) A deleted test ("without a capture host FollowVideo is inert") was restored and extended. (4) The kept session ran at the tier's rate while paused; it is now slowed to 1 fps. (5) A refused frame burst failed silently at the default log level; it is now warned about and falls back.
