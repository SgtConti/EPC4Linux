# Electron shell, capture host and .deb packaging (module `electron-shell`)

This module is the Electron main process, the preloads, the hidden capture window, the build script and the Debian packaging. It follows `docs/re/01-electron-main.md`, `02-renderer-shell.md` §2/§L.2, `09` §7-8 and `13` §3/§4/§12.

The shell is done and tested. `startupBackendService` runs the production backend composition (`src/backend/compose.ts`). With the imported vendor UI and `EVNIA_MOCK_MONITOR=34M2C8600`, Home shows the simulated **PHL 34M2C8600** card, and its `DispalyData` carries the display mode that main reports. The installed `.deb` runs under Chromium's setuid sandbox.

Integration wave (this revision):
- **Backend:** the production composition, a shared USB backend, and one `PATH_APP_TEMP` for the backend and `local:`.
- **`getDisplayMode`:** implemented exactly per 20-monitor-io §3.5 (Mutter, XRandR, libdrm).
- **App binding:** the app picker becomes a `.desktop` chooser, `processPath` is the port's own `.desktop`, and `getForegroundApp()` reports `WM_CLASS` and the Flatpak ID.
- **Idle:** Mutter's idle monitor on GNOME Wayland.
- **Exports:** the save dialog appends the file extension.

Security review (latest revision; see "Security review fixes" at the end):
- **`file:`** requests are allowed only below the app tree, and the CSP's `connect-src` no longer contains `'self'`.
- **Hub file arguments** follow the same path policy as `nodeApi` (`HostServices.pathAllowed`).
- **Picked files** are read only when they are regular files, up to 20 MiB.
- **Hardening:** Electron fuses, a Node-side egress ban, `--no-proxy-server`, udev without GPU SMBus/SMU adapters, and a foreground tracker that stops when no app-bound theme exists.

See "Integration status" at the end.

## Files

| Path | Role |
|---|---|
| `port/src/main/index.ts` | Bootstrap and the `EvniaApp` orchestrator: single-instance lock, `userData` path, logging, lifecycle, device events, exit |
| `port/src/main/windows.ts` | Main window (880x520 splash → working size) and notice toast; error page when `vendor-ui` is missing |
| `port/src/main/tray.ts`, `tray-i18n.ts`, `tray-host.ts` | Tray menu, the vendor's 10-language labels, and detection of a StatusNotifier or legacy tray host |
| `port/src/main/ipc.ts`, `dialog-options.ts` | `ipcMain` handlers (Keep/Adapt channels plus preload internals), sender checks, the `window.store` broadcast, dialog option sanitizing. Electron is injected, so the handlers are unit-tested with fakes |
| `port/src/main/store.ts`, `shared/store-schema.ts` | `config.json` compatible with electron-store (schema, validation, dot paths) |
| `port/src/main/shared/channels.ts` | The IPC contract shared by main and the preload: allowlists, offline defaults, synthetic replies |
| `port/src/main/shared/posix-path.ts` | `join`/`basename` for the sandboxed preload |
| `port/src/main/backend-host.ts` | `startupBackendService`: `createDefaultBackend` (production composition) + `startHubServer` in process; `mockMonitorFromEnv`, `backendConfiguration` |
| `port/src/main/host-services.ts` | `HostServices` for the backend (idle time, display mode, foreground app with the `getForegroundApp()` extension, capture) |
| `port/src/main/display-mode.ts` | 20-monitor-io §3.5 string rules (exact rate, `floor(exact + 0.005)`, rotation), output matching (EDID, Mutter spec, connector), Electron screen fallback |
| `port/src/main/display-sources.ts` | Mode sources a/b (Mutter `GetCurrentState`, `xrandr --current --verbose`) and `DisplayModeProvider` (snapshots, refresh, fallbacks) |
| `port/src/main/drm-modes.ts` | Mode source c: libdrm through koffi (read-only KMS getters) |
| `port/src/main/gvariant.ts` | Parser for the GVariant text that `gdbus call` prints |
| `port/src/main/idle-time.ts` | `getIdleSeconds`: `powerMonitor` plus Mutter's idle monitor on GNOME Wayland |
| `port/src/main/capture-host.ts`, `capture-slot.ts`, `capture-sources.ts` | `CaptureHost`: follow-video on a hidden window, start/stop sequencing, screen source selection |
| `port/src/main/audio-monitor.ts`, `audio-level.ts` | Follow-audio: `parec` on the default sink's monitor, and the vendor FFT/level heuristic |
| `port/src/main/display-watch.ts` | udev (`drm`, `i2c-dev`) and Mutter `MonitorsChanged` display-change sources |
| `port/src/main/child-process.ts` | `spawnTied`: long-lived helpers die with the app (`setpriv --pdeathsig`); `createCommandRunner` for short queries (`gdbus call`, `xrandr`, `xprop -id`) |
| `port/src/main/exit.ts` | The `exitApp` step list; each step runs even if an earlier one fails |
| `port/src/main/network-guard.ts` | Kill-switch predicate (`file:` only below the app tree), session and web-contents hardening |
| `port/src/main/egress-guard.ts` | Node-side egress ban: loopback and Unix sockets only, no DNS (installed before the backend) |
| `port/src/main/local-protocol.ts`, `fs-guard.ts`, `file-read.ts` | `local:` image protocol; `nodeApi` path confinement, which also answers the backend's `pathAllowed`; bounded reads of regular files only |
| `port/src/main/device-events.ts` | `displayChange`/`USBChange`/`otherDeviceChange` debounce, throttle and shields (01 §9) |
| `port/src/main/monitor-info.ts` | `getMonitorJsonConfig` (01 §8.3, 14 §7.5) |
| `port/src/main/autostart.ts`, `foreground-app.ts`, `window-geometry.ts`, `logfile.ts`, `paths.ts` | Linux replacements for the Windows integrations, plus pure helpers |
| `port/src/main/renderer-log.ts` | The renderer's electron-log lines (`window.__electronLog`) into the main log: message sanitizing (see "IPC") |
| `port/src/main/mock-probe.ts` | Test probe of the simulated hardware, installed on main's `globalThis` only with `EVNIA_MOCK_MONITOR` (impl-walkthrough §3) |
| `port/src/main/experimental.ts` | `ExperimentalSettings`: the port's opt-in experiments in `config.json` (`linuxExperimental`), today the Ambiglow page's "Fast LED upload (experimental)" checkbox; follows the store and forwards every change to the backend (see "IPC", "Persisted settings") |
| `port/src/preload/api.ts`, `index.ts` | `window.ipc`, `window.store`, `window.nodeApi`, `window.__EVNIA__` (`hubToken`, `platform`, `experimental`), `window.noop`, `window.__electronLog`. `api.ts` builds them over an injected `ipcRenderer`; `index.ts` exposes them |
| `port/src/capture/{capture.html,page.ts,preload.ts,protocol.ts}` | Hidden follow-video capture page and its bridge |
| `port/scripts/build.mjs` | esbuild → `build/app` |
| `port/scripts/package-deb.mjs`, `port/scripts/lib/fuses.ts`, `port/packaging/deb/*` | `@electron/packager` → `.deb`, with the Electron fuses, the shared-library check, user docs (README.Debian, man page) and md5sums |
| `port/test/install/*`, `port/docker/Dockerfile.install-test` | Install verification of the `.deb` in clean Debian 13 and Ubuntu 24.04 containers (see "Install test") |
| `port/test/unit/main/*.test.ts` | 155 unit tests |
| `port/test/e2e/*` | Playwright/Electron e2e harness: 17 shell and capture tests (including the Home page checks in `pages.ts`) and the 34-step vendor-UI walkthrough (`walkthrough.test.ts`, `vendor-ui.ts`; impl-walkthrough.md) |

## Public API (what other modules rely on)

### Backend hosting (`backend-host.ts`)

The first `startupBackendService` call does four things:

1. Calls `createDefaultBackend(options, overrides)` from `src/backend/index.ts`. This is the production composition (impl-integration §2): the theme store, the monitor manager, the ambiglow service bound to the manager, and all 11 Bridge modules. `backendConfiguration()` builds the arguments:

   | `EVNIA_MOCK_MONITOR` | `options` | Hardware |
   |---|---|---|
   | unset (or blank) | `{host, usb}` | Real hardware. `usb` is the process's one `LibusbBackend`: the VIA USB-DDC bridges and the ENE share it, and main subscribes to it for `USBChange` (impl-monitor §5 item 4, impl-usb-ene §5). |
   | `34M2C8600`, `34M2C8600/no-ene`, … | `{host, mockMonitor, noHardware: true}` | The simulated monitor (and ENE) of ARCHITECTURE rule 7. Nothing real is opened, as with `backend/serve.ts --mock`. |

   `overrides = {themes: {appTempDir}}` gives the theme store the `PATH_APP_TEMP` that `local:` serves (see "`local:` protocol").
2. Awaits `backend.start()`.
3. Calls `startHubServer(backend, {token, log})`. The hub binds 127.0.0.1, probes upward from 10010, and admits only Origin `file://` (the `startHubServer` default, impl-integration §2.4).
4. Resolves the bound port.

Later calls return the same port. The renderer re-invokes 3 s after every SignalR reconnect (02 §4.7). A failure resolves `-1` (the vendor's failure value) and is retried on the next call. A `stop()` during a start waits for that start, so its services are stopped too.

The token comes from `generateHubToken()` once per launch. The preload exposes it to the main window only, as `window.__EVNIA__.hubToken`. The vendor-ui patch `HUB-URL` builds `ws://127.0.0.1:<port>/EvniaHub?k=<token>` from it.

The backend is created with the stored "Fast LED upload (experimental)" setting (`BackendHostOptions.eneFrameBurst`, read at creation and passed as `overrides.ambiglow.eneFrameBurst` when on), and `BackendHost.setEneFrameBurst(enabled)` forwards every later change to `services.ambiglow.setEneFrameBurst` (a no-op before the backend exists, and for an ambiglow service without the optional member).

### `HostServices` (`host-services.ts`)

| Field | Value |
|---|---|
| `log` | Backend logger writing `~/.config/EvniaServe/logs/YYYY-MM-DD.txt` (the Windows backend log layout) |
| `serveDataDir` | `~/.config/EvniaServe` (`$XDG_CONFIG_HOME` honoured) |
| `appDataDir` | `~/.config/evnia` (Electron `userData`) |
| `resourcesDir` | `<app>/resources`: `MonitorInfo.json`, `PCenter_DeviceInfo.json`, `ENE/PCenter_AmbiglowInfo.json`, icons. In the `.deb` this is inside `app.asar`; Electron's `fs` reads it transparently. |
| `capture` | `ElectronCaptureHost` (see "Capture host") |
| `getIdleSeconds()` | Input idle seconds, like `GetLastInputInfo` (see "Idle time") |
| `getDisplayMode(monitor)` | 20-monitor-io §3.5, e.g. `{resolution:"3440x1440", frequency:"175Hz", orientation:"0°"}` (see "Display mode"). With `EVNIA_MOCK_MONITOR` it is the simulated monitor's mode, the user's `3440x1440`/`175Hz`/`0°`, as `serve.ts --mock` reports. |
| `getForegroundAppPath()` | X11: exe of the active window (`xprop -spy`, then `/proc/<pid>/exe`); this app's own windows are ignored. Wayland, or no `xprop`: `null`. |
| `getForegroundApp()` | The optional extension of backend `theme/app-binding.ts` (`ForegroundAppHost`): `{exe, wmClass, appId}` of the same window (see "Foreground app") |
| `releaseForegroundApp()` | The other half of that extension: stop tracking until the next query. The backend calls it while no theme has a bound app (see "Foreground app") |
| `pathAllowed(path, access)` | The path policy for the hub's file arguments (`types.ts`): `PathGuard.backendMayAccess` (see "IPC", "Backend file arguments") |

### Display mode (`display-mode.ts`, `display-sources.ts`, `drm-modes.ts`)

This implements 20-monitor-io-linux-consolidation §3.5 exactly.

**String rules**
- The rate comes from the source, or from `clock·1000 / (htotal·vtotal)` with `drm_mode_vrefresh`'s factors: ×2 for interlaced, ÷2 for double scan, ÷vscan.
- `MonitorFrequency = floor(exact + 0.005) + "Hz"`. So 59.9726 gives `59Hz` and 74.9832 gives `74Hz` (MBR off), as the spec table of this monitor says.
- `MonitorResolution` uses mode pixels (also under fractional scaling), swapped for 90°/270°.
- `MonitorOrientation = ["0°","90°","180°","270°"][r]`, where `r` counts counter-clockwise steps. Flips are ignored.
- An unknown rate gives `""`.

**Sources, per session**

| Session | Order | Match |
|---|---|---|
| GNOME Wayland | a. Mutter `org.gnome.Mutter.DisplayConfig.GetCurrentState` (`gdbus call`): the `is-current` mode, and the transform of the logical monitor that contains it | Mutter's monitor spec (vendor, product, serial) = the EDID's PnP id, 0xFC name, 0xFF serial, or Mutter's `0x…` fallbacks. The connector name breaks ties between identical monitors and stands in without an identity. |
| X11 | b. `xrandr --current --verbose` (no re-probe of the outputs): the `*current` mode's dot clock and totals, Interlace/DoubleScan, rotation; then a. on GNOME | The output's `EDID` property (the first 128 bytes). Never the name alone: the amdgpu DDX calls the kernel's DP-2 `DisplayPort-1`. |
| any, when neither a nor b answered (no D-Bus, no `xrandr`, non-GNOME Wayland) | c. libdrm via koffi: `drmModeGetResources` → `drmModeGetConnectorCurrent` (never forces a probe) → encoder → CRTC mode. Only cards that sysfs shows with a connected connector are opened. Orientation `0°`. | The full connector name (`card1-DP-2`) |
| none of a, b, c available | The Electron screen API (a deviation: §3.5 has no such source) | Output name or EDID model in `label`, the EDID preferred mode, or the only display. There is no primary-display guess. |

- The answering sources are asked in order, and the first that lists the monitor decides. The result is `null` in two cases: none of them lists the monitor, or that first one lists it without a current mode (a disabled output). The backend then keeps `""` (§3.5 step 6), and one warning is logged per monitor and reason. The Electron fallback is not used in either case.
- `getDisplayMode` is synchronous, so the provider keeps the last snapshot. It refreshes it:
  - at start;
  - on every raw display event (Electron `screen`, udev `drm`, Mutter `MonitorsChanged`), before the 2 s `displayChange` debounce and the backend's 5 s settle;
  - again 3 s later, when the compositor has applied the new configuration;
  - in the background when a lookup finds data older than 10 s.
- Refreshes are joined while one runs. A missing tool is logged once at info level, and again when it comes back.
- The libdrm structures (`xf86drmMode.h`) are checked against a C compiler's layout: a unit test compiles a stand-in libdrm and reads it through the real binding.

### Idle time (`idle-time.ts`)

- `powerMonitor.getSystemIdleTime()`. Chromium answers it from the XScreenSaver extension on X11, and from the compositor's idle protocol on Wayland.
- GNOME's compositor offers Chromium no Wayland idle protocol. So on GNOME Wayland the Mutter idle monitor is also asked, and the larger value wins. The call is `gdbus call … org.gnome.Mutter.IdleMonitor.GetIdletime` on `/org/gnome/Mutter/IdleMonitor/Core`, in ms.
- `getIdleSeconds()` is synchronous and polled every second (`GlobalOper.CheckIdle`), so Mutter is polled in the background, only as often as the decision needs:
  - The backend's shortest threshold is 1 minute (`Setting_TurnOffLightsWhenIdleDuration ≥ 1`).
  - Between polls the value is extrapolated (last idle time + elapsed). That is an upper bound, and exact while no input happens.
  - The next poll is due when that bound could reach 55 s, and every second after that.
- Result:
  - An active user costs one D-Bus call per ~55 s.
  - The lights go off within about a second of the threshold, and come back within about a second of the next input (the vendor polls every second as well).
- Missing `gdbus` or no Mutter service disables the Mutter source (one info line). Other failures back off 30 s.

### Foreground app (`foreground-app.ts`)

- On X11, each change of `_NET_ACTIVE_WINDOW` (`xprop -root -spy`) triggers one `xprop -id <win> _NET_WM_PID WM_CLASS`. It gives:
  - `exe`: `/proc/<pid>/exe`;
  - `wmClass`: the class part of `WM_CLASS` (the instance part when the class is empty);
  - `appId`: the Flatpak application ID from `/proc/<pid>/cgroup` (`app-flatpak-<id>-<n>.scope`).
- The backend matches these against a binding's desktop-file ID and `StartupWMClass` (20-theme §10.2 item 5, impl-theme §3.4).
- A window without `_NET_WM_PID` still reports its `WM_CLASS`.
- This app's windows are ignored (by pid and exe), and so are answers for a window that lost focus meanwhile.
- On Wayland the tracker reports `null`, and app-bound themes are inert.
- **Tracking runs only while it can matter** (data minimisation). The backend's `CheckTopApp` loop, armed by the renderer's first `Theme_GetCurTheme`, asks for the foreground app only while some theme has a bound app, or while a theme other than "User" is current. In the second case the vendor switches back to "User" on the next foreground change (SO:3317-3323), and so does the port. Otherwise the loop asks nothing and calls `releaseForegroundApp()`: the `xprop -spy` child exits and the last answer is forgotten. The next query starts it again. So with no app-bound theme, which is the default, the app does not follow focus changes or read the focused processes' `/proc/<pid>/exe` and cgroup.

### Hotplug

The host calls `backend.hotplug('usb')` when a `USBChange` is sent and `backend.hotplug('display')` when a `displayChange` is sent. Both happen after the vendor debounce/throttle and shields, so the backend never needs its own debounce. The renderer additionally calls `Device_DetectionUSB`/`Device_DetectionDisplay`/`Device_OtherDeviceChange` on the same events, exactly as on Windows.

### Capture host (`CaptureHost`)

**`startVideo(intervalMs, onFrame)`**
- Resolves `true` once frames flow. It never throws. It resolves `false` in these cases:
  - capture is denied, no source exists, or the page fails;
  - a `stopVideo()` or a newer `startVideo()` was issued while it was still pending;
  - it has not succeeded within 60 s (`VIDEO_START_TIMEOUT_MS`), e.g. a Wayland portal dialog left open. The window is then released, which withdraws the dialog.
- Frames are `{width:50, height:40, data: Uint8ClampedArray(8000) RGBA, timestamp}` every `intervalMs`, clamped to 33..10000 ms (`src/capture/protocol.ts clampFrameInterval`; the floor was 100 ms before the Follow video speed tiers, whose High asks for 40 ms). The screen source is asked for `1000 / interval` fps, not rounded, between 1 and 30 (`frameRateFor`): 300 ms asks 3.33 fps, and the source then delivers a frame every 300 ms (3 fps would be 333 ms).
- **Sampling: each source frame as it arrives.** The page reads the track's frames with `MediaStreamTrackProcessor`, which Chromium exposes to the page (checked on Electron 44 in the hidden capture window). It scales each frame when it arrives and closes it at once. At most about one frame per interval is taken (`minSampleSpacingMs`: the interval less min(15 ms, interval / 4)), which only thins a source that runs faster than asked, such as a portal stream the constraint did not slow down. A frame therefore reaches main a few ms after the screen was grabbed, and a screen change waits at most one source interval. This needs no rendering, so the hidden (unmapped) window does not matter.
  - Fallback, when the page has no `MediaStreamTrackProcessor`: a `<video>` element sampled by a timer every interval, as before 2026-09-27. That timer runs out of phase with the source. It adds up to one interval of lag and sometimes posts the same source frame twice (measured at 300 ms under Xvfb: lag median 439 ms, against 149 ms with frame-driven sampling).
  - The page names the sampling in its start status: `capture video-started: <label>; sampling each new source frame` (or `…; sampling a <video> element every <ms> ms (no MediaStreamTrackProcessor)`).
- Frames are area-filtered (`imageSmoothingQuality:'high'`) from the full screen, i.e. the 09 plan B "smooth" mode. The vendor's 5-point sampling can be done on top of these by the ambiglow engine if bit-parity is wanted.
- Source on X11: the primary display's `desktopCapturer` source.
- Source on a Wayland session (`XDG_SESSION_TYPE=wayland`): `getDisplayMedia` through the xdg-desktop-portal ScreenCast dialog, where the user picks the screen.
  - After the first successful start, later requests in the same run are answered with the granted source again (`capture-sources.ts ScreenGrant`, impl-ambiglow §2.4 request). WebRTC's PipeWire capturer keeps the portal's restore token per source id for the life of the process (persist mode "transient"), so the portal can restore the session without a dialog.
  - A start that fails with a reused grant drops it, as does a stream ended by the user or the system. The next start then shows the dialog again.
  - A new app run always asks once. `persist_mode: 2` (persist across runs) is not reachable: Electron exposes neither the persist mode nor the token.
  - This is not verified on a GNOME Wayland session.
- If the user or the system ends the stream, frames stop, the window is released and a warning is logged. There is no callback for this in `CaptureHost`.

**Sequencing.** At most one stream exists, and a callback never receives frames after its capture was stopped or replaced:
- Every start and stop gets a session number (`capture-slot.ts`).
  - A start re-checks its session after each await (window creation, `desktopCapturer`, the page command) and gives up if it is no longer current.
  - Frames are tagged with their session; frames of an old session are dropped.
  - The latest start wins. Earlier pending starts resolve `false`, and their callbacks never receive a frame.
- The page (`src/capture/page.ts`) applies the same rule to its own awaits. A stream that opens after its start was superseded is stopped at once.
- `stopVideo()` destroys the capture window. That ends every stream, the PipeWire session and GNOME's sharing indicator.

**`setVideoInterval(intervalMs)`** (optional `CaptureHost` member, appended for the Follow video speed tiers, impl-ambiglow §4.2; FollowVideo also uses it to slow a kept session to 1000 ms while its uploads are paused): the current session changes its frame interval **in place**. There is no new session, so no ScreenCast dialog on Wayland.
- The host clamps the interval like a start and remembers it for the current session. A start still in flight sends the latest interval with its page command. Otherwise the host runs the page command `window.evniaCapture.setVideoInterval({session, intervalMs})` (`src/capture/protocol.ts SetVideoIntervalCommand`) and logs `Screen capture interval <ms> ms (same session)`.
- It is a no-op while nothing is captured, and for the same interval. It never throws.
- The page (`src/capture/page.ts`) applies the new sampling interval at once (the frame spacing, or the fallback's timer). It then asks the stream's track for the new rate with `track.applyConstraints({frameRate: {max}})` and reads back `getSettings().frameRate`. On X11 under Xvfb, `applyConstraints` raises and lowers the desktop source in place (3.33 → 25 → 1 → 10 fps measured on a track read by `MediaStreamTrackProcessor`).
  - X11: the desktop stream is opened at the asked rate. When `applyConstraints` cannot raise it, the page re-opens the same `desktopCapturer` source at the new rate, which needs no dialog on X11. It starts a sampler on the new stream within the same session, then stops the old sampler and stream. If the new stream cannot be sampled, the old one is kept.
  - Wayland: the portal stream is opened at the 30 fps ceiling and then constrained to the asked rate. A later, faster speed therefore stays inside the stream, and the stream is never re-opened (that would be a new portal dialog).
  - A start that is still opening takes the newest interval when its stream is up.
- The page reports `capture video-retuned: every <ms> ms, source frame rate <n> fps[ (notes)]` (status kind `video-retuned`, info level).
- `videoStats` (`{starts, retunes, intervalMs}`: sessions started, in-place retunes, the current session's interval or `null`) shows what the backend asked for. The mock probe exposes it to the walkthrough as `snapshot().capture`, in mock mode only.

**`startAudio(onLevel)`**
- Resolves `true` on the first audio data from the default sink's monitor. `onLevel(level 0..255, spectrum Float32Array)` is then called every 40 ms.
- Resolves `false` in these cases (it never opens a microphone):
  - `parec` is missing (about 10 ms);
  - `parec` exits, e.g. no sound server;
  - no data arrives within 3 s;
  - a newer `startAudio()` or a `stopAudio()` was issued while it was pending.
- Recording happens outside Chromium, in main (`audio-monitor.ts`):
  - Chromium cannot open a sink monitor. Its PulseAudio backend drops monitor sources from the input list (`audio_manager_pulse.cc`, `InputDevicesInfoCallback`), and PipeWire desktops go through pipewire-pulse.
  - The command is `parec --device=@DEFAULT_MONITOR@ --raw --format=float32le --rate=48000 --channels=2 --latency-msec=20` (pulseaudio-utils; it works with PulseAudio and pipewire-pulse). The latest 2048 mono samples are kept.
- Vendor behaviours kept (09 §8.1):
  - Default sink changes restart `parec` (`pactl subscribe`, then `get-default-sink`).
  - A muted default sink gives level 0 with an empty spectrum (`pactl get-sink-mute @DEFAULT_SINK@` after sink events).
  - A 3 s no-data watchdog restarts `parec`. An exited `parec` is restarted after 1 s, with backoff up to 30 s.
- DSP (`src/main/audio-level.ts`, tested against a transcription of the C#): the vendor pipeline. That is a mono mix, N=2048 at 48 kHz, an unscaled FFT, bins `[0, 2500/floor(sr/N))` (108 bins), `sqrt(|X|)`, then the `ConvertToSingleData` heuristic.

`stopVideo()`/`stopAudio()` are synchronous and idempotent. The helpers (`parec`, `pactl subscribe`) are started through `spawnTied`, so they cannot outlive the app (see "Helper processes").

## IPC

The preload forwards only the channels 01 §10.1 marks Keep/Adapt. Main registers handlers for exactly those, plus `electron-store-get-data` and the internal `evnia:*` channels. Every handler checks that the sender is the top frame of the main or notice window. The capture window, subframes and any other web contents are refused:
- invokes reject;
- sync channels return an inert value (an empty bootstrap, `EACCES`, `false`);
- sends are dropped and logged.

| Channel | Linux behaviour |
|---|---|
| `getRunConfig` | `{appVersion:"1.13.0", isDebugMode, isFirstRun, isPackaged:true, mac:"", patchPath, processPath, userDataPath}`. `processPath` is the port's own `evnia-precision-center.desktop`: the first found in the XDG data dirs (`~/.local/share/applications` first), else `/usr/share/applications/…`. The renderer's only use of it is `picked === processPath` → "CannotBindSelf" in the app picker (20-theme §10.2 item 2), which now offers `.desktop` files. The backend refuses both that entry and this executable anyway. |
| `startupBackendService` | In-process backend + loopback hub, as above |
| `getMonitorJsonConfig` | `{OTAEnable:false, config}` built with the vendor key expression; `{OTAEnable:false, config:{}}` when no file is available |
| `resetToStartSize`, `interfaceInitializeCompleted`, `minimize`, `maximizedValue`, `maximizeToggler`, `setWindowSize` | Vendor logic (01 §4, §10) |
| `close` | Same rule as a window-manager close (see "Windows and tray") |
| `fileSelect` | One file only, options sanitized, async I/O. Only a regular file counts as a pick: a FIFO, socket, device or directory chosen by name answers `{path:"", size:0, buffer:null}` (no pick). It is opened with `O_NONBLOCK` and checked with `fstat`, so a FIFO cannot hang main and `/dev/zero` (size 0, endless) cannot exhaust it. The picked file becomes readable through `nodeApi` and the backend. `buffer` is a fresh `Uint8Array` of exactly the file's bytes, or `null` above 20 MiB (the renderer's own `ProfileSizeExceed`/`MacroSizeExceed` limit). **App picker** (20-theme §10.2 item 1): the renderer's `FileSelector` default `[{name:"Application", extensions:["exe"]}]` (theme app binding) opens a chooser instead with `defaultPath:"/usr/share/applications"`, the filters `Applications (*.desktop)` and `All files (*)`, and a title naming `~/.local/share/applications`, the Flatpak and the Snap export directories. It returns `{path, size, buffer:null}` and does not make the pick readable, since the path is only a `BindAppFilePath` for the backend (a desktop-id or executable binding). |
| `exportFile` | Save dialog with sanitized options, returns `{canceled, filePath}`. GTK does not append the filter's extension, which Windows did, and the backend writes exactly the given path (20-theme §10.2 item 7). So with a single one-extension filter (profile/macro export), the proposed name gets `.pcenter`/`.macro`, and a chosen name without it gets it appended. The exception is when a file of that name exists: the dialog's overwrite confirmation never covered it. The returned path becomes a **one-shot write grant** for the backend (`PathGuard.grantWrite`): `Theme_ExportProfile`/`Macro_Export` may write exactly that path, once. |
| `getFileSize`, `getFileMd5` | Confined paths only. `getFileMd5` hashes regular files only (streamed, any size) and answers `""` for anything else |
| `setLanguage` | Tray labels, relay to the notice window |
| `setAutoStartUp` | Store, then XDG autostart |
| `disableTrayExit`, `disableTrayFunction`, `shieldDisplayChange`, `shieldPeripheralChange`, `notice` | Vendor logic |

Stripped channels never reach main. The preload answers them:
- `runCommand` → `{error:{message:"disabled"}, stdout:""}`.
- `getMac`, `extractZip`, `findExe`, `imageResourceDownload`, `getCloudFileCacheOrDownload` → `""`.
- `getSystemInfo` → `{}`.
- `checkNodeAvailable` → `{available:false, extractPath:""}`.
- Bulb channels → `{success:false, error:"disabled"}`.
- `checkSoftwareVersion` → a local `versionCheckResult {state:0, …}` event, so the loading overlay closes.
- `createDownload` → a local `downloadFail {url, msg:"offline"}`.
- The other online sends are dropped.
- Unknown invokes resolve `undefined` with a console warning.

Listeners receive an empty event object instead of `IpcRendererEvent`. The vendor leaked `ipcRenderer` through `event.sender`.

**`window.__electronLog`** is the bridge electron-log 5's own preload exposed in the vendor app once main called `log.initialize()`. The vendor renderer bundles electron-log's renderer module (ST:~30688-31140); its named loggers (e.g. `renderer/useConnectDetection`) and its error handler send every line through `__electronLog.sendToMain(message)`. Without the bridge the renderer prints `electron-log: logger isn't initialized in the main process` as a console error instead (ST:30998-31002). The e2e walkthrough found it on every monitor unplug: `da.info("To overview device list empty")` (main-CDosWiM3.js:1749).
- The preload (`api.ts electronLog`) has the same shape as electron-log's preload API: `sendToMain`, `log`, `error`, `warn`, `info`, `verbose`, `debug`, `silly`. It sends on the internal channel `evnia:renderer-log`.
- Main (`ipc.ts`) checks the sender like every channel; the capture window and subframes are refused and logged.
- `renderer-log.ts rendererLogLine` treats the message as untrusted: only `level` and `data`, or `errorName` and `error` for the error handler, are used. Unknown levels become `info`, verbose/silly become `debug`, the text is flattened to one line (newlines → ` | `, control characters → space) and cut at 4096 characters.
- The line lands in the main log under the scope `main/app/renderer`, e.g. `[info] [main/app/renderer] [renderer/useConnectDetection] To overview device list empty`, where the vendor's electron-log main wrote it into the same `logs/YY-MM-DD.log`.

**`window.__EVNIA__.experimental`** (user request 2026-09-27) is the narrow API of the port's opt-in experiments, used only by the FAST-LED-UPLOAD renderer patch, the Ambiglow page's "Fast LED upload (experimental)" checkbox (impl-vendor-ui §3):
- `get()` is synchronous: `{eneFrameBurst, forcedByEnv}`. `eneFrameBurst` is read from the window's store snapshot (`config.json linuxExperimental.eneFrameBurst`, true only when exactly `true`), so the first render shows the stored state and every later write (the window's own, main's broadcasts) is followed. `forcedByEnv` (`EVNIA_ENE_FRAME_BURST=1` in the app's environment) comes with the bootstrap (`BootstrapData.experimental`). Windows other than the main window see both false.
- `setEneFrameBurst(enabled)` rejects a non-boolean in the preload, then invokes the internal channel `evnia:experimental-set`. Main (`ipc.ts`) accepts it only from the main window's top frame (the notice window, the capture window and subframes are refused and logged) and only with a boolean (anything else: `TypeError`, logged, nothing written). `ExperimentalSettings.setEneFrameBurst` (`experimental.ts`) stores it in `config.json` (a real change only) and returns the new state; the preload puts it into its snapshot at once, since main's broadcast of the same write may come after the reply.
- `ExperimentalSettings` follows the store: any change of `linuxExperimental` or `linuxExperimental.eneFrameBurst`, whoever writes it (also `window.store`), reaches the backend (`BackendHost.setEneFrameBurst` → `AmbiglowService.setEneFrameBurst`, from the next frame, impl-usb-ene §2.2). `config.json` is the one source of truth.
- The page cannot reach the channel through `window.ipc` (not in the allowlist) and the vendor bundle references no new channel.

**`window.store`** is a synchronous snapshot taken at load through `evnia:bootstrap` (sendSync):
- `get`/`set`/`delete`, with dot paths and electron-store validation errors.
- Writes go through to main, which is the only writer of `config.json`.
- `ipc.ts` broadcasts every change on `evnia:store-changed` to the trusted windows except the writer. Changes main makes itself (window bounds, autostart) reach every window.

**`window.nodeApi`** implements the calls the renderer makes: `existsSync`, `readFileSync`, `readFile`, `copyFileSync`, `unlinkSync`, `getBaseName`, `pathJoin`. The fs calls use synchronous IPC, confined by `fs-guard.ts`:
- **Reads:** `~/.config/evnia`, `~/.config/EvniaServe`, `<app>/resources`, and files picked in `fileSelect`. `existsSync` answers `false` outside these.
- **`copyFileSync` destination:** only a new file directly in `~/.config/evnia`, or a file that `nodeApi` itself created there in this session.
- **`unlinkSync`:** only files `nodeApi` created, plus the backend's `<name>.pcenter` / `<name>.macro` export files in `~/.config/evnia`.
- Paths are realpath-checked, so symlinks cannot escape or alias app state.
- **Regular files, at most 20 MiB** (`file-read.ts`). `readFileSync`, `readFile` and the source of `copyFileSync` must be regular files of at most 20 MiB, the renderer's own import limit. A directory gives `EISDIR`, a FIFO, socket or device `EINVAL`, and a larger file `EFBIG`. Nothing is read before the check. The sync channels block main while they run, so they stay short, and a FIFO can no longer block main. Content goes over IPC as a fresh `Uint8Array`: IPC serializes a view's whole `ArrayBuffer`, and a pooled Node `Buffer` would carry unrelated memory along.

These are exactly the renderer's temporary files. Profile/macro import copies the picked file to `pathJoin(userDataPath, basename(file, ".pcenter").slice(0, 30))` and then unlinks it (ST:43085-43094, KeyBind:1163-1176). Export has the backend write `<userData>/<name>.pcenter|.macro`, which the renderer then unlinks (ST:43506-43517, KeyBind:1564-1575).

The vendor had a bug here: importing `config.json.pcenter`, `Preferences.pcenter`, `MonitorInfo.json.pcenter` or `evnia-first-run.pcenter` overwrote, then deleted, that file of app state. Existing app state is now never a target, so such an import fails with `EACCES` and a log line.

**Backend file arguments** (`HostServices.pathAllowed`, `fs-guard.ts backendMayAccess`). The hub's `Theme_*` and `Macro_*` functions take file paths from the renderer. Unchecked, they gave anyone holding the hub token, or a compromised renderer, more than `nodeApi` does:
- a write to any file the user owns: `Theme_ExportProfile` writes exactly the given path and creates missing directories, and `Macro_Export` writes any `<path>.macro`;
- a read of any file whose parsed content comes back in the reply: `Theme_ImportProfile`, `Theme_GetProfileDesc(path)`, `Theme_GetDevicesBasicInfo(path, eq)`, `Theme_ApplyProfile`, `Macro_GetDetail(file)`, `Macro_VerifyFile`, `Macro_Import`.

The backend now asks main first:
- **read:** what `nodeApi` may read (the read roots and the dialog picks);
- **write:** the path of the latest `exportFile` answers, each once (the 16 newest are kept), or a `<name>.pcenter` / `<name>.macro` directly in `~/.config/evnia` that is new or an existing regular file (the renderer's cloud-export temp files). Never a symlink, and never a file whose real path lies elsewhere.

A refused path gets the vendor's own error for that function, so the reply shapes stay byte-compatible:
- `ThemeExportProfile SaveTXTConfig Error`, `Macro_Export save file error`;
- the "Not Exist" errors (code 8 for the theme functions, `file=… not exit` code 3 for `Macro_GetDetail`, `MacroImport filePath=… is not exit`);
- `Macro_VerifyFile` → `false`, and `Theme_GetDevicesBasicInfo(path)` / `Theme_ApplyProfile` behave as with a missing file.

`Macro_Export` checks the path it really writes, `ChangeExtension(path, ".macro")`. A chosen `Racing` whose `Racing.macro` already exists (the dialog confirmed `Racing`, not the file the extension change replaces) is therefore refused instead of silently overwritten.

`Comm_GenAppIcon` keeps its own allowance, because a bound app is not a file picked in this session: only an absolute path to a `.desktop` file or to an executable is looked at (`app-binding.ts genAppIcon`). Without a host policy (`serve.ts`, the CLI, the contract tests) the functions behave as before.

## Persisted settings (`~/.config/evnia/config.json`)

The file uses the electron-store format: one tab-indented JSON object, schema defaults merged in, and `__internal__.migrations.version = "1.13.0"`. The user's Windows `config.json` loads unchanged apart from the pinned keys (unit-tested with the real fixture).

| Key group | Behaviour |
|---|---|
| Schema keys and defaults | Vendor `Qd` (01 §6), except that `autoStartup` defaults to **false** (01 port plan 6). A fresh install therefore adds no login autostart until the user enables it; an explicit value in an existing file (the user's Windows file has `true`) is kept. `autoStartupMinimize` defaults to true, as in the vendor. |
| `autoUpdate`, `automaticUpdate` | Pinned `false` |
| `skipLoginState` | Pinned `true` |
| `userInfo`, `email`, `password`, `latestSoftwareInfo` | Removed on load; writes are refused |
| Invalid JSON | Moved to `config.json.invalid-<ts>`, then the app starts from defaults |
| `linuxExperimental` (port-only) | The port's opt-in experiments: `{"eneFrameBurst": boolean}`, the Ambiglow page's "Fast LED upload (experimental)" checkbox (see "IPC"). Global, not per profile, and not in the backend's `Config/SoftConfig.data`. In the schema as an `object` **without a default**: a fresh file gets it only when the user ticks the checkbox, a missing key means off, and the user's Windows `config.json` loads unchanged. A non-object value is dropped on load. The Windows app ignores the key (electron-store keeps unknown keys, like the installer's `languageTemp`) |

## Network kill-switch (defence in depth)

1. `session.webRequest.onBeforeRequest` on the default session and the capture session. It cancels everything except `data:`, `blob:`, `devtools:`, `chrome:`, `local:`, `ws://127.0.0.1:<hub port>/EvniaHub` and `file:` below the app tree. Before the hub starts, no WebSocket is allowed. Each block is logged as `Blocked <type> request to <origin+path>`, with the query stripped so the token never reaches a log.
   - **`file:` rule.** A `file:` URL passes only when it has no host and its resolved path is `AppPaths.appRoot` or lies below it (`isAllowedFileUrl`). In the `.deb` that is `/opt/evnia-precision-center/resources/app.asar`, so `vendor-ui/` and `capture/`. `..`, percent-encoded separators and a sibling such as `app.asar.unpacked` never pass.
   - **Why.** Electron's `GrantFileProtocolExtraPrivileges` fuse is on, and must stay on: the vendor UI's `<script type=module crossorigin>` needs it under `file://`. With it, a `file:` page may `fetch`/XHR other `file:` URLs, and `file:` images do not taint a canvas. The CSP's `'self'` also matches every `file:` URL. Without this rule, a compromised renderer could read any file the user can read (verified with Electron 44.4.5: `fetch('file:///tmp/secret.txt')`, a sync XHR of `/etc/hostname`, `getImageData` of `~/Pictures`), which would have made the `nodeApi` confinement pointless.
   - In the e2e runs every legitimate `file:` request is under `<appRoot>/vendor-ui/` or `<appRoot>/capture/`.
2. **CSP** (`scripts/ui-patches.mjs`, impl-vendor-ui §3): `connect-src ws://127.0.0.1:*` without `'self'`, so `fetch`/XHR of files fail in the renderer already. `frame-src`, `worker-src`, `media-src`, `form-action` and `manifest-src` are `'none'`: the bundle has no frames, media, forms or manifest, and its one Worker is disabled by IMGCOMP-NO-WORKER.
3. `--host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"`: no host name resolves, even for requests Chromium might make outside `webRequest`. `--no-proxy-server`: Chromium ignores the system and environment proxy settings, so there is no PAC download and no proxy connection (20-online-sweep-tail §10 "proxy dead-end").
4. **Node-side egress ban** (`egress-guard.ts`, 20-online-sweep-tail §10). It is installed at bootstrap, before the backend, the hub or any dependency can open a socket. `webRequest` covers only Chromium's network stack; main also runs Node. Refused, with a `Blocked outbound …` warning and an `EACCES` `EgressBlockedError`:
   - `net.Socket#connect`, which covers `net.connect`, `tls.connect`, the `http`/`https` agents and `fetch` (undici), to anything but a Unix socket or a loopback literal (`127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`). Host names are refused too, except `localhost`.
   - `dgram` `send`/`connect` to a non-loopback address.
   - `dns.lookup` of any name but `localhost` (IP literals need no query).
   - every `dns.resolve*`/`reverse` query, which c-ares sends to the network itself: callback and promise APIs, and `Resolver` instances.

   Servers are not affected: the hub listens on 127.0.0.1, and accepted sockets are no `connect()`. Child processes (`gdbus`, `xprop`, `parec`) and Chromium's own networking are not affected either. No code path in main connects anywhere today; the guard makes a future dependency that tries fail loudly.
5. Spellchecker disabled per session and per window (14 N13: Linux Electron would otherwise download Hunspell dictionaries).
6. The following are denied:
   - `window.open` (logged)
   - foreign navigation and redirects
   - `<webview>`
   - all permission requests and checks, except `media`/`display-capture` for the capture window's web contents
   - WebHID/WebUSB/serial device pickers
7. `Menu.setApplicationMenu(null)`: no reload or zoom accelerators. `before-input-event` handles Alt+Shift+M (DevTools, dev/debug only) and Ctrl+R (reload, unpackaged only), replacing the vendor's `globalShortcut`, which does not work on Wayland.

The e2e placeholder fires a real `fetch` to `https://kill-switch-probe.invalid/probe`. The test asserts that the request fails and that the main log contains the `Blocked` line. It also asserts that no other non-local request or WebSocket was made, in both suites.

## `local:` protocol

This implements 01 §3.3 item 5 and 14 N12. Only image files are served (png/jpg/gif/webp/bmp/ico/svg), and only below these directories:
- `~/.config/evnia/ImageCache`
- `~/.config/EvniaServe/Theme` (bound-app icons)
- The backend's `PATH_APP_TEMP` (`Comm_GenAppIcon` temp icons): `theme/paths.ts defaultAppTempDir()`, i.e. `$XDG_RUNTIME_DIR/EvniaServe`, else `$TMPDIR/EvniaServe-<uid>`. Main computes it once and hands the same directory to the theme store (`backend-host.ts` `appTempDir`). The fallback lives in a shared `/tmp`, so it is served only while it is a real directory owned by the user; the backend applies the same check before writing there.
- `<app>/resources`
- `<app>/vendor-ui`

Everything else, including `local:///https://…` smuggling, gets a 404.

## Device-change events (01 §9)

| Source | Event |
|---|---|
| `screen` `display-added`/`display-removed` | `displayChange` + `otherDeviceChange` (a Windows monitor devnode change also raised `WM_DEVICECHANGE`) |
| `display-metrics-changed` with `bounds`, `scaleFactor` or `rotation` | `displayChange` (work-area-only changes such as a dock resize are ignored) |
| udev (`udevadm monitor --udev --subsystem-match=drm --subsystem-match=i2c-dev`): `drm` change/add/remove (connector `HOTPLUG=1`, DP link retrain, the monitor's HDR/SDR switch when it pulses HPD), `i2c-dev` add/remove | `displayChange` (20-monitor-io-linux-consolidation §5 / D9), so the backend re-resolves its buses |
| GNOME: Mutter's `MonitorsChanged` D-Bus signal (`gdbus monitor --session --dest org.gnome.Mutter.DisplayConfig`), on X11 and Wayland | `displayChange`; it also covers refresh-rate-only changes, which Electron does not report |
| `LibusbBackend.onChange` attach/detach (any device, like the vendor's node-usb hook) | `USBChange` + `otherDeviceChange` |

Every source goes through `DeviceChangeGate`, so the debounce and `shieldDisplayChange` apply to udev and Mutter events too (D9 rule 1). The backend never starts its own display rescans. A missing `udevadm` or `gdbus`, or a non-GNOME session, leaves the other sources working; one info line is logged.

Timings are exactly the vendor's and are unit-tested with mocked timers:
- `displayChange`: 2000 ms trailing debounce.
- `USBChange`: leading-edge lock, sent after 1000 ms, unlocked at 2000 ms.
- `otherDeviceChange`: same as `USBChange` but sent after 1700 ms.
- Shields are checked on entry and again at fire time.
- `shieldDisplayChange(flag, seconds=4)` behaves as in the vendor.

## Windows and tray

**Main window**
- Frameless 880x520, not resizable, `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `spellcheck:false`.
- It is shown on `ready-to-show` unless `--openAsHidden` is given **and** a tray host exists. The login autostart passes `--openAsHidden`, but a hidden window is only reachable through the tray icon. On vanilla GNOME without the AppIndicator extension, the window is therefore shown and a warning is logged, instead of starting an invisible instance.
- On `interfaceInitializeCompleted` it sets min 1280x720 and max = the largest work area, then resizes to the saved size or 1920x1080/1280x720, then maximizes on first run or when saved maximized, otherwise centers.
- If `vendor-ui/index.html` is missing, a framed error page explains `npm run import-ui`.

**Notice toast**
- Uses the vendor geometry plus the work-area origin.
- Uses `showInactive`.
- The Short (5 s) and No styles, `shell.beep()`, and the 2 s re-layout on metric changes all work as in the vendor.

**Tray**
- Items: "Precision Center" (show, or DevTools when packaged with the debug flag), Rescan, Settings, Exit. The labels are the vendor strings in 10 languages.
- Enabled states follow `isTrayOptionEnable` (01 §5).
- There is no Check for Updates or Feedback item.

**Closing the window** (title bar, window manager, or the renderer's close button):
- It hides to the tray only if `org.kde.StatusNotifierWatcher` owns its D-Bus name (checked with `gdbus` or `dbus-send`), or if the session is a non-GNOME X11 desktop (XEmbed).
- Otherwise it quits cleanly.
- A second launch always shows the window.

**Exit** (tray Exit, quit, or SIGTERM through `before-quit`) runs these steps in order (`exit.ts`):
1. Save `mainWindowBounds` and hide the window.
2. Delete the debug flag, as the vendor does (only if it is ours).
3. Destroy the tray.
4. Stop device events (the debounce gate, then the udev/Mutter watchers), the foreground tracker, capture and the notice window.
5. Unsubscribe USB.
6. `hub.close()` and `backend.stop()`.
7. `app.exit(0)`, with a 3 s hard deadline.

Each step has its own try/catch, and async steps are awaited. A failing step is logged and the next one still runs, so the backend stop (ENE release, DDC drain) always happens.

**Helper processes.** The long-lived helpers (`udevadm monitor`, `gdbus monitor`, `parec`, `pactl subscribe`, `xprop -spy`) start through `spawnTied` (`child-process.ts`), i.e. `setpriv --pdeathsig TERM -- <exe> …`.
- **Why:** Node's spawn in Electron's main process passes on every descriptor Chromium left inheritable: mojo sockets, the single-instance socket, the profile's leveldb locks, a test runner's pipes. A helper orphaned by a crash would hold all of them. That blocks the next launch's single-instance lock and Local Storage, and keeps Chromium's child processes alive.
- **Effect:** with `pdeathsig` the kernel terminates the helpers whenever the app dies, however it dies. The e2e run found this: an orphaned `udevadm` kept Playwright's pipes open.
- `setpriv` is in util-linux, which is Essential on Debian/Ubuntu. Without it the helpers start directly.

## Autostart, logging, paths

**Autostart.** `~/.config/autostart/evnia-precision-center.desktop` contains `Exec=<execPath> [--openAsHidden]`, `X-GNOME-Autostart-enabled=true`. It is written or removed on every start and on `setAutoStartUp`, in packaged builds only (vendor semantics). With the Linux default `autoStartup:false`, a fresh install writes no entry. When no tray host exists at login, `--openAsHidden` shows the window (see "Main window").

**Logs**
- The main log is `~/.config/evnia/logs/YY-MM-DD.log`, line format `[YYYY-MM-DD HH:mm:ss.SSS] [level] [scope] msg`.
- Files rotate at 20 MiB, and `.log`/`.log.N` files older than 5 days are deleted.
- The backend log is `~/.config/EvniaServe/logs/YYYY-MM-DD.txt`.
- The level is debug when the debug flag exists, otherwise info. The flag also enables DevTools.
- Console output is on in unpackaged runs.

**Debug flag.** It is `$XDG_RUNTIME_DIR/evnia-debug-open.tmp`, or `os.tmpdir()` when `XDG_RUNTIME_DIR` is unset. Enable it with `touch "$XDG_RUNTIME_DIR/evnia-debug-open.tmp"`.
- It counts only as a regular file owned by the user; a symlink, a directory or another user's file is ignored.
- Exit deletes it (one-shot, like the vendor) only under the same condition, and never throws.
- The vendor used `%TEMP%`, which is per user on Windows. In a shared `/tmp`, any local user could have forced another user's debug logging and DevTools, or made the exit fail.

**`userData`** is set explicitly to `~/.config/evnia`, whatever the product name.

## Build (`scripts/build.mjs`)

`node scripts/build.mjs [--out build/app] [--vendor-ui build/vendor-ui] [--vendor-data build/vendor-data] [--vendor-assets build/vendor-assets]`

| Output | Source and bundling |
|---|---|
| `main.cjs` | src/main plus the whole backend; platform node, CJS; externals `electron`, `usb`, `koffi`, `ws` |
| `preload.cjs`, `capture-preload.cjs` | platform browser, CJS, only `electron` external, so an accidental Node import fails the build (sandboxed preloads) |
| `capture/capture.{html,js}` | IIFE |
| `vendor-ui/` | Copy of build/vendor-ui |
| `resources/` | vendor-data + vendor-assets |
| `package.json` | `{name:"evnia-precision-center", productName:"Evnia Precision Center", version, main:"main.cjs", desktopName:"evnia-precision-center.desktop"}` |

A missing vendor-ui/data/assets directory is a warning, not an error.

## Packaging (`scripts/package-deb.mjs`, `packaging/deb/`)

`node scripts/package-deb.mjs [--app build/app] [--out dist] [--allow-missing-ui]` (`npm run dist:deb`) runs in the dev container and needs no network. It takes about 1 minute.

1. **Stage:** `build/app` plus the production closure of `usb`, `koffi`, `ws`: `@types/w3c-web-usb`, `node-addon-api`, `node-gyp-build`, `@koromix/koffi-linux-x64`. Other-platform prebuilds and the C/C++ sources of usb and koffi are pruned (musl builds too).
2. **Electron zip:** `electron-v44.4.5-linux-x64.zip` built from `node_modules/electron/dist` with Python's `zipfile`, which keeps the modes. This is the packager's `electronZipDir`, so there is no download.
3. **Packager:** `@electron/packager`, linux/x64, name and executable `evnia-precision-center`, `asar: {unpack:'*.node', unpackDir:'{node_modules/koffi,node_modules/@koromix,node_modules/usb}'}`, prune, junk, derefSymlinks.
   - **Fuses** (`hardenFuses`, `scripts/lib/fuses.ts`; 20-online-sweep-tail §12 "fuse checks"). In the packaged executable, `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` are written to `0`, then read back. With Electron's defaults, `ELECTRON_RUN_AS_NODE=1 evnia-precision-center -e …`, `NODE_OPTIONS=--require …` or `--inspect` turned the installed app into a general Node runtime running under its identity.
     - `@electron/fuses` is not a dependency. The helper writes the v1 fuse wire (sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX`, version 1, length, one `'0'`/`'1'` byte per fuse), and refuses anything else: no sentinel, several sentinels, another version, a removed fuse.
     - `GrantFileProtocolExtraPrivileges` stays on, because the vendor UI's `file://` module scripts need it; `network-guard.ts` confines `file:` instead.
     - `EnableEmbeddedAsarIntegrityValidation` and `OnlyLoadAppFromAsar` stay off. Asar integrity needs the header hash stored with the executable (macOS: `ElectronAsarIntegrity` in Info.plist; Windows: a PE resource), and the Linux executable of Electron 44 has no such store. Without integrity, `OnlyLoadAppFromAsar` protects nothing here: `/opt` is root-owned, so whoever can add a `resources/app/` can also replace `app.asar` or the executable.
     - Resulting wire: `RunAsNode=0 EnableCookieEncryption=0 EnableNodeOptionsEnvironmentVariable=0 EnableNodeCliInspectArguments=0 EnableEmbeddedAsarIntegrityValidation=0 OnlyLoadAppFromAsar=0 LoadBrowserProcessSpecificV8Snapshot=0 GrantFileProtocolExtraPrivileges=1 WasmTrapHandlers=1`.
     - Nothing in the app needs `RunAsNode`: it never uses `child_process.fork()` (which needs it) or spawns its own executable as Node.
4. **Deb tree:**
   - `/opt/evnia-precision-center/**`, with modes normalized to 0644/0755. The Windows bind mount shows every source file as 0777.
   - `/usr/bin/evnia-precision-center` symlink.
   - `/usr/share/applications/evnia-precision-center.desktop` with `StartupWMClass=evnia-precision-center`. Electron 44 derives both the X11 `WM_CLASS` of its windows and the Wayland app_id from `desktopName` (`evnia-precision-center.desktop`); the install test found the former value `Evnia Precision Center` on no window.
   - hicolor icons at 64x64 and 16x16 from the vendor favicons. `favicon_24x24.png` is really 28x28, not a hicolor size, and is skipped.
   - `/usr/lib/udev/rules.d/70-evnia-precision-center.rules`.
   - `/usr/lib/modules-load.d/evnia-precision-center-i2c.conf` (`i2c-dev`).
   - **User documentation:** `/usr/share/doc/evnia-precision-center/README.Debian.gz` and the man page `evnia-precision-center(1)`. Both state the binding decision that *Profile → Reset* (`Theme_ResetCurProfile`) and *Settings → Factory reset* (`FactoryReset`) also restore the monitor's factory settings (VCP 0x04 = 1, impl-integration §5), and the control `Description` points to it. README.Debian also covers the permissions (udev/uaccess, re-plugging), the Wayland notes (portal dialog, inert app-bound themes), the tray, follow-audio, the files, taking over the Windows `%APPDATA%\evnia` and `%APPDATA%\EvniaServe` (as the walkthrough's migrated run does), debug logging, removal and the sandbox.
   - `copyright` (DEP-5, per-component notices and licences), `changelog.Debian.gz` (dated by `SOURCE_DATE_EPOCH` when set), the lintian overrides.
   - `DEBIAN/{control,md5sums,postinst,postrm}`. `md5sums` makes `dpkg --verify` and debsums work.
5. **Shared-library check:** `readelf -d -V` over every shipped ELF file (8: electron, chrome-sandbox, chrome_crashpad_handler, libffmpeg.so, libvk_swiftshader.so, libvulkan.so.1, the usb and koffi addons). Every `NEEDED` soname must be shipped in the package or map (`SONAME_PACKAGES`) to a package that `Depends` names, and the `libc6` bound must cover the highest `GLIBC_` version they need (2.25). An Electron or prebuild upgrade that adds a library fails the build instead of producing a package that does not start.
6. **Build:** `fakeroot dpkg-deb -Zxz --build`. The script prints the maintainer, `Depends` and the size.

**Result:** `dist/evnia-precision-center_1.13.0-linux.1_amd64.deb`, 109,945,536 bytes (105 MiB, xz), Installed-Size 312,798 KiB, 140 files.

**udev.** The rules give `TAG+="uaccess"` to exactly `usb 2109:8884` (the VIA USB-DDC bridge) and `0cf2:a201` (the ENE Ambiglow controller), matched as `usb_device`. The bridge rule also sets `ATTR{power/control}="on"` (20-monitor-io-linux-consolidation §2.9, 08 §8.5). Laptop power tools (TLP, `powertop --auto-tune`) set USB autosuspend to `auto`, which would suspend the bridge between requests and stall or fail the first transfer after an idle period. VIA Labs' vendor ID `2109` also covers ordinary USB hubs and hub/billboard controllers in docks and monitors. Tagging `2109:*` would let any seat user send raw control requests (port power, reset, firmware commands) to all of them, which the app never needs. For the DDC/CI fallback, i2c-dev nodes whose PCI ancestor is a display adapter (class `0x030000` or `0x038000`) are tagged, as in ddcutil's `60-ddcutil-i2c.rules`, except the adapters the backend never probes (security review): `ATTR{name}!="AMDGPU SMU*|Synopsys DesignWare*|soc:i2cdsi*|smu*|mac-io*|u4*|*[Ss][Mm][Bb][Uu][Ss]*"`, i.e. `discovery.ts IGNORED_ADAPTER_PREFIXES` plus any name containing "smbus". amdgpu's `AMDGPU SMU n` buses (present on recent AMD GPUs) carry the RAS/FRU EEPROM and the power-management firmware controller, and a GPU's SMBus adapter is no display bus either: raw read/write access to them stays root-only, as without the package. A packaging test keeps the rule in sync with the backend's list (every prefix excluded, the display buses of amdgpu DC, i915, nouveau and radeon not), and `udevadm verify` passes (systemd 257). Number 70 runs before `73-seat-late.rules`, which applies uaccess.

**postinst**
- `chown root:root` and `chmod 4755 chrome-sandbox`. The archive stores it as 0755.
- `modprobe i2c-dev || true`.
- `udevadm control --reload-rules`.
- `udevadm trigger --action=change` for the two USB IDs and for `i2c-dev`.

**postrm** reloads the rules. User data and any autostart entry are left in place (Debian policy); README.Debian names them.

**Control fields**
- `Depends` is exactly the shared-library closure of the shipped ELF files (step 5), with the pre-t64 name as an alternative for the t64-renamed libraries (Debian 12 / Ubuntu 22.04 names):
  `libasound2t64 | libasound2`, `libatk-bridge2.0-0t64 | libatk-bridge2.0-0`, `libatk1.0-0t64 | libatk1.0-0`, `libatspi2.0-0t64 | libatspi2.0-0`, `libc6 (>= 2.25)`, `libcairo2`, `libcups2t64 | libcups2`, `libdbus-1-3`, `libexpat1`, `libgbm1 (>= 21.1.0)`, `libgcc-s1`, `libglib2.0-0t64 | libglib2.0-0`, `libgtk-3-0t64 | libgtk-3-0`, `libnspr4`, `libnss3`, `libpango-1.0-0`, `libstdc++6 (>= 5)`, `libudev1`, `libx11-6`, `libxcb1`, `libxcomposite1`, `libxdamage1`, `libxext6`, `libxfixes3`, `libxkbcommon0`, `libxrandr2` (control.in carries the version bounds).
  - The lower bounds are dpkg-shlibdeps' (trixie) except two. `libc6 (>= 2.25)` is the highest `GLIBC_` symbol version the binaries need; dpkg-shlibdeps says 2.34 only because trixie's symbols file lists the pthread functions merged into libc.so.6 at 2.34, while the binaries bind them through libpthread.so.0. `libxcomposite1` is unversioned: trixie's shlibs file pins its own 1:0.4.6, Ubuntu 24.04 has 1:0.4.5 (the install test failed on it), and Electron uses only `XCompositeQueryExtension`, `XCompositeQueryVersion` and `XCompositeRedirectWindow`, which every libXcomposite 1 has.
  - **Added:** `libudev1` (the usb prebuild and Electron itself link `libudev.so.1`, impl-usb-ene "Runtime library for USB"), `libstdc++6` and `libgcc-s1` (the usb and koffi prebuilds; lintian `missing-dependency-on-libstdc++`), and the other libraries Electron 44 links directly.
  - **Removed:** `libusb-1.0-0` (the prebuild links libusb statically), `libxss1` (Chromium speaks the XScreenSaver protocol through its own xcb code; nothing links or loads libXss), `libsecret-1-0` (only dlopen'ed by `safeStorage`, which the app does not use; cookie encryption is off by default in Electron), `xdg-utils` (nothing runs `xdg-open`/`xdg-email`/`xdg-mime`/`xdg-settings`: external links are no-ops by NO-EXTERNAL-BROWSER, the protocol registration is removed, there are no downloads). On a desktop these libraries are present anyway.
- `Recommends`: `libglib2.0-bin` (`gdbus`: Mutter display mode, idle monitor, `MonitorsChanged`, tray host check), `libpipewire-0.3-0t64 | libpipewire-0.3-0` (WebRTC dlopens it for the Wayland ScreenCast portal, i.e. follow-video), `pulseaudio-utils` (`parec`/`pactl` for follow-audio), `x11-utils` (`xprop`: foreground app), `x11-xserver-utils` (`xrandr`: display mode on X11, asked for under "Integration status"), `xdg-desktop-portal`.
- `Suggests`: `gnome-shell-extension-appindicator`.
- The install test checks that every `Recommends` and `Suggests` exists in both distributions.
- `Homepage` (the vendor's support site) is gone: the vendor does not support this port. The `Description` says "unofficial".
- **Maintainer:** `DEBEMAIL` (`addr` or `Name <addr>`) with debchange's name rules (`DEBFULLNAME`, else `NAME`, else the name in `DEBEMAIL`). Without `DEBEMAIL` it is the neutral placeholder `Evnia Linux Port <noreply@localhost>`, never the git identity. With the placeholder, the build adds overrides for lintian's `bogus-mail-host` and `bogus-mail-host-in-debian-changelog` (the only two tags it causes); with a real `DEBEMAIL` they are not added.

**lintian** (2.122.0, trixie, run as a non-root user): no tag at any level. `lintian` prints nothing and exits 0; with `--info --pedantic --display-experimental` every remaining tag is overridden (250), and no override is unused. Fixed rather than overridden: `copyright-without-copyright-notice`, `no-manual-page`, `no-md5sums-control-file`, `missing-dependency-on-libstdc++`. Overridden, with the reason in `packaging/deb/lintian-overrides`:
- `dir-or-file-in-opt`: a self-contained Electron app under /opt (FHS 3.13).
- `embedded-library`, `unstripped-binary-or-object`, `binary-has-unneeded-section`, `hardening-no-bindnow`, `hardening-no-fortify-functions`, `exit-in-shared-library`, `spelling-error-in-binary`: the prebuilt upstream binaries, shipped unmodified.
- `script-not-executable`: koffi's loader starts with a shebang but is only `require()`d.
- `extra-license-file`, `package-contains-documentation-outside-usr-share-doc`: licences and READMEs stay next to their components; `copyright` points there.
- `repeated-path-segment`: the npm packages' own layout.
- `appstream-metadata-missing-modalias-provide`: the package is installed from a local file, never from an archive whose AppStream catalogue could advertise it for the monitor's USB IDs.
- `bogus-mail-host*`: only with the placeholder maintainer (see above).

### Install test (`test/install/run.sh`)

`test/install/run.sh [--skip-build] [--deb <file>] [--dist "debian:trixie ubuntu:24.04"] [--reuse-images] [--keep-images]` runs on the Docker host (Linux, or Git Bash with Docker Desktop; paths go through `cygpath`). It exits 1 when anything fails. Results are in `test/install/artifacts/` (git-ignored). Files: `docker/Dockerfile.install-test`, `test/install/{run.sh,in-container.sh,shlibs-check.mjs,launch-check.mjs}`.

1. **Build** in `evnia-port-dev`: `npm run import-ui && npm run build && npm run dist:deb`.
2. **Inspect:** `dpkg-deb -I` and the size (`package-info.txt`); lintian as a non-root user, plain (`lintian.txt`, E/W tags fail the run) and with `--info --pedantic --display-experimental --show-overrides` (`lintian-full.txt`).
3. **Install** (`docker build` of `Dockerfile.install-test` on the CLEAN `debian:trixie` / `ubuntu:24.04`, `--no-cache`, BuildKit named contexts holding only the `.deb` and the test scripts). This is the only step with network, and only apt uses it.
   - `apt-get install --no-install-recommends ./pkg.deb`: apt resolves `Depends` from the distribution archive, and `Depends` alone must suffice.
   - Then, still in that Depends-only state (`in-container.sh deps`):
     - `ldd` finds every library of every ELF file.
     - `shlibs-check.mjs`, run by the package's own Electron as Node (`ELECTRON_RUN_AS_NODE=1`), parses each file's `DT_NEEDED`, resolves it through `ldconfig`, and requires the owning package (`dpkg -S`) to be in `Depends`. The base images already contain libc6, libgcc-s1, libstdc++6 and libudev1, so a missing declaration of those would pass `ldd`.
     - It loads `usb` and `koffi` through `app.asar` as the app does, and calls into libc through koffi.
     - The installed executable has `RunAsNode` off, so both test scripts (`shlibs-check.mjs`, `launch-check.mjs`) run on `/tmp/electron-as-node/electron` (`in-container.sh node_runtime`): a copy with that one fuse byte back on, next to symlinks to the package's own files. It is otherwise byte-identical, so the libraries checked are the shipped ones. No name contains "evnia", so the leftover check after the purge is unaffected.
   - Then every `Recommends`/`Suggests` clause must have an alternative in the archive. The Recommends are installed, then the test tools (`xvfb xauth desktop-file-utils udev procps`).
4. **Verify** (`docker run --network none --cap-add SYS_ADMIN --security-opt seccomp=unconfined --shm-size 1g … in-container.sh verify`; the capability and the unconfined seccomp let the setuid sandbox create its namespaces inside Docker):
   - package state, and `dpkg --verify` against `DEBIAN/md5sums`;
   - every packaged path's mode and owner: `chrome-sandbox` 4755 root:root, the three executables 0755, everything else 0644/0755 root:root. No other setuid/setgid or group/world-writable file. The `/usr/bin` symlink. dpkg `path-exclude` is honoured: the ubuntu image drops the man page and README.Debian.
   - **fuses** of the installed executable, read from its fuse wire with `grep -obUa` and `dd`: `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` and `EnableNodeCliInspectArguments` `0`, `GrantFileProtocolExtraPrivileges` `1`. And in practice: `ELECTRON_RUN_AS_NODE=1 evnia-precision-center -e …` runs no script (as `tester` with a throwaway `HOME`).
   - udev: `udevadm verify --resolve-names=never` (systemd 257 / 255) and the rule content (uaccess only; exactly the two USB IDs; two i2c-dev classes);
   - modules-load: syntax, `i2c-dev`, mode;
   - `.desktop`: `desktop-file-validate`, `Exec` in `PATH`, `Icon` in hicolor;
   - **launch** as the non-root user `tester` (with a 0700 `XDG_RUNTIME_DIR`, `XDG_SESSION_TYPE=x11`) under Xvfb 1920x1080 with `EVNIA_MOCK_MONITOR=34M2C8600`. The app is started as the menu does: `/usr/bin/evnia-precision-center`, sandbox on, GPU on, plus `--remote-debugging-port=0`. `launch-check.mjs` drives it over the DevTools protocol with Node's built-in `fetch`/`WebSocket`, so the clean image needs no Node or Playwright. It checks:
     - Home shows the **PHL 34M2C8600** card with its bundled image, no "Connect Your Evnia Device", at the working size (the `pages.ts` criteria). It saves `launch-<name>/home.png`.
     - every viewable window's `WM_CLASS` equals `StartupWMClass`;
     - `SIGTERM` ends the app and no helper process (`udevadm`, `xprop`, …) survives it;
     - the main log has no `[error]` line.

     There are two launches:
     - `default`: whatever sandbox the kernel offers (the namespace sandbox in Docker Desktop);
     - `suid-sandbox`: `--disable-namespace-sandbox` forces Chromium's setuid helper, i.e. the installed `chrome-sandbox`, the path Ubuntu 24.04's AppArmor userns restriction takes.

     While the app runs, root reads the renderers' `NSpid` depth and `uid_map` (world-readable; `/proc/<pid>/ns/*` needs `CAP_SYS_PTRACE`). A nested PID namespace with the browser's user namespace means setuid; a new user namespace means namespace; neither means unsandboxed, which fails.
   - after the launches: `~/.config/evnia/config.json` and the logs exist, `~/.config/EvniaServe` exists, and there is no autostart entry (`autoStartup` defaults to false);
   - `apt-get purge`: exit 0 and no dpkg warning. Afterwards:
     - no dpkg record or info file;
     - every packaged path is gone, except directories that other packages own;
     - `find / -xdev -iname '*evnia*'` finds nothing outside `/home/tester` and `/run/user/<uid>`;
     - the user's `~/.config/evnia` and `~/.config/EvniaServe` are still there.


**Verified (2026-09-27; `test/install/run.sh`, the package above).** Both `debian:trixie` (Debian 13) and `ubuntu:24.04` (24.04.5 LTS) pass all 13 checks. On each, apt pulled 128 packages for `Depends` from the archive.

| Check | Debian 13 | Ubuntu 24.04 |
|---|---|---|
| `apt-get install --no-install-recommends ./pkg.deb` | pass | pass (failed before `libxcomposite1` lost its trixie-only bound) |
| `ldd` + `DT_NEEDED` → `dpkg -S` ∈ `Depends`, `usb`/`koffi` load | pass (8 ELF files, 34 external sonames) | pass |
| Recommends/Suggests exist | pass | pass |
| `dpkg --verify` | pass | pass (man page and README.Debian kept off the disk by the image's `path-exclude`) |
| Modes/owners, `chrome-sandbox` `-rwsr-xr-x root:root` | pass | pass |
| `udevadm verify` | pass (systemd 257) | pass (systemd 255) |
| modules-load, `desktop-file-validate` | pass | pass |
| Launch, default sandbox (namespace) | Home + card in ~4 s | same |
| Launch, `--disable-namespace-sandbox` (setuid `chrome-sandbox`) | Home + card; renderers setuid-sandboxed | same |
| Viewable windows' `WM_CLASS` = `StartupWMClass` | pass (after the fix) | pass |
| No helper left after exit; no `[error]` in the main log | pass | pass |
| No autostart entry by default | pass | pass |
| `apt-get purge`: only `~/.config/evnia`, `~/.config/EvniaServe` remain | pass | pass |

Screenshots of the installed package on Home: `port/test/install/artifacts/<distribution>/launch-{default,suid-sandbox}/home.png` (git-ignored).

**Known issue found by the install test (outside the packaging, reported as XFAIL):** the app never exits cleanly. After the exit steps have run ("Exit" logged, backend stopped), every exit ends in **SIGTRAP**: `SIGTERM`, `SIGINT`, `app.quit()` and `app.exit(0)` alike, so tray Exit, closing the window without a tray host, and logout. The crash is not in the port's code.
- Loading `usb` 2.18.0 in Electron 44's browser process is enough. A 15-line Electron app with just `require('usb')` crashes the same way on `app.exit`/`app.quit`, and exits with 0 without it. `ELECTRON_RUN_AS_NODE` and plain Node exit cleanly with it.
- `process.reallyExit(0)` avoids the crash but skips Chromium's orderly shutdown.
- Main loads `usb` even in mock mode: `LibusbBackend.onChange` for `USBChange` starts the libusb hotplug thread.
- Consequences: a core dump per exit where systemd-coredump is active, and a crash report where a crash handler collects them. No data is lost: the steps before `app.exit` completed.
- **Suggested fix (main / USB owners):** host `usb` outside the browser process (an Electron `utilityProcess`), or fix the addon's environment-teardown hook. `launch-check.mjs KNOWN_EXIT_CRASH` accepts only exactly this signature (SIGTRAP after "Exit"); any other exit failure fails. Remove the entry once it is fixed.

## Tests

| Command (inside `evnia-port-dev`) | Covers |
|---|---|
| `node --test "test/unit/main/**/*.test.ts"` (167 tests) | See the unit-test list below |
| `xvfb-run -a -s "-screen 0 1920x1080x24" node --test "test/e2e/**/*.test.ts"` (51 tests: 17 shell and capture tests plus the 34-step walkthrough of `walkthrough.test.ts`, about 5 min; run with `--network none`) | See the e2e list below |
| The whole project: `npx tsc -p tsconfig.json && node --test "test/unit/**/*.test.ts" "test/contract/**/*.test.ts"` | 902 tests, none fail (Follow video brightness and "Fast LED upload", with the installer at `../Evnia Precision Center`; the LAN-interface hub test skips under `--network none`; MAINTAINING "Test layers") |
| On the Docker host: `test/install/run.sh` (10 to 15 min with the build, mostly apt downloads) | The `.deb` in clean `debian:trixie` and `ubuntu:24.04`, see "Install test" |

**Unit tests**
- **Store:** schema and file format, with the real Windows `config.json`. The Linux `autoStartup` default applies to a fresh file only. `linuxExperimental`: an object without a default, dropped when not an object, kept across loads.
- **Experiments** (`experimental.test.ts`): the checkbox path stores `linuxExperimental.eneFrameBurst` and reaches the backend once per change, the same value writes nothing, a non-boolean is refused, any writer of the key is followed (and none after `dispose()`); `EVNIA_ENE_FRAME_BURST=1` reported, not stored.
- **IPC** (`ipc.test.ts`): `registerIpcHandlers` with the real preload API on a fake bus.
  - `window.__EVNIA__.experimental`: the synchronous snapshot at load (also after a reload and for a fresh `ConfigStore`), `setEneFrameBurst` persisting `config.json` and switching the (fake) backend once per change, a write through `window.store` followed, `forcedByEnv` reported; refused for the notice window, the capture window, subframes and frameless senders, and for every non-boolean (in the preload and in main), with nothing written; not reachable through `window.ipc`.
  - `window.store` write-through to disk and the broadcast to the other window only, including main's own writes.
  - Pinned and invalid writes.
  - The hub token for the main window only.
  - Refusal of the capture window, subframes and frameless senders on every kind of channel.
  - The `nodeApi` import/export temp-file flow, and that `config.json` can be neither overwritten nor deleted.
  - Allowlist and offline answers, and sanitized listener events.
  - `window.__electronLog`: a named-logger line, a level function and the error handler reach the main log under `renderer`; the capture window and subframes are refused.
  - `exportFile` grants the backend one write of exactly the returned path; a cancelled dialog or the capture window grants nothing.
  - Picked and confined files: a FIFO and `/dev/zero` picked by name are no pick; a FIFO inside the roots gives `EINVAL` on every channel at once (no hang); a file above 20 MiB gives its size but no buffer and `EFBIG`; a directory `EISDIR`; the buffer is exactly the file's bytes.
- **Renderer log** (`renderer-log.test.ts`): electron-log's message shapes, level mapping, and untrusted input (non-objects, one bounded line, control characters, circular data).
- **Mock probe** (`mock-probe.test.ts`): Set VCP decoding, the snapshot (controls, host writes, JSON-safe ENE state, the capture host's video stats through the `capture` hook), OSD-side changes without a host write, the simulated idle time, unplug/replug (connector status, VIA and ENE leave and return at new addresses, the three host events), and the non-enumerable, read-only install.
- **Allowlist coverage:** every renderer channel.
- **Device-event timings.**
- **MonitorInfo key derivation:** equality with the vendor expression, against the real v34 table.
- **Path confinement:** reads, the copy/unlink policy, and symlink escape and aliasing. `backendMayAccess` (the backend's `pathAllowed`): reads as `nodeApi`; writes only to a one-shot export grant (any spelling of the path, the 16 newest kept) or a `.pcenter`/`.macro` temp file directly in userData, never through a symlink.
- **`local:`:** resolution and private-root ownership.
- **Debug flag:** ownership, symlinks and directories.
- **Kill-switch:** the URL predicate (`file:` only below the app tree: the root itself, not a sibling like `app.asar.unpacked`, no `..` or encoded separators, no host), the navigation guard and token redaction.
- **Egress guard** (`egress-guard.test.ts`, installed in that test process only): TCP, TLS, `http.get` and `fetch` to a non-loopback peer, and by name, are refused before any packet and logged; `dns.lookup` of names other than `localhost` and every `resolve*`/`reverse` query fail; UDP only to loopback; the loopback hub, `localhost` and Unix sockets still work; idempotent install and uninstall.
- **Pure helpers:**
  - POSIX path vs `node:path`;
  - tray labels and tray-host parsing;
  - the autostart entry;
  - notice and working geometry;
  - display-mode strings and matching;
  - xprop parsing;
  - udev `monitor` and `gdbus monitor` parsing, and the line watcher with a missing tool;
  - dialog sanitizing;
  - log names, format, rotation and retention;
  - `WM_CLASS` and Flatpak-cgroup parsing, the app picker and save-extension rules, `processPath`, the Wayland screen grant.
- **Backend host** (`backend-host.test.ts`):
  - the "Fast LED upload" setting: passed at creation only when on, later changes forwarded to the ambiglow service (none before it exists, none to a service without the member);
  - the option mapping (mock → `noHardware`, real → the shared `usb`, `appTempDir`);
  - main's host services;
  - `startupBackendService` over the production composition with the simulated 34M2C8600: `Start`, the monitor listed, `Profile_GetDeviceData` carrying `3440x1440`/`175Hz`, the theme store's `PATH_APP_TEMP`;
  - the hub admits only token plus `file://`;
  - retry after a failed start, and stop during a start.
- **Display mode** (`display-mode.test.ts`, `drm-modes.test.ts`):
  - the §3.5 table of this monitor (59/100/74/29 Hz), truncation with the 0.005 slack, the vrefresh factors, rotation and swap;
  - the GVariant parser;
  - Mutter `GetCurrentState` (current mode, transform, disabled monitor, spec matching and twins);
  - `xrandr --current --verbose` with the amdgpu DDX names (EDID match, interlaced, rotated, another unit not matched);
  - the Electron fallback;
  - the provider's session order, fallbacks, one warning per reason, joined, settle and stale refreshes;
  - libdrm: connector names, the sysfs pre-filter, the koffi layouts, the system `libdrm.so.2` symbols, and an end-to-end read of a C-compiled stand-in libdrm, with every object freed.
- **Idle** (`idle-time.test.ts`): a simulated 3-minute session with the backend's `isIdle`:
  - off 60 s after the last input, back within a second;
  - about one D-Bus call per 55 s while active, 1 s while idle;
  - back-off and disable.
- **Foreground** (`foreground-app.test.ts`): a fake `xprop` and a fake `/proc`:
  - exe, `WM_CLASS` and Flatpak ID;
  - self windows, unknown windows and failed queries are ignored;
  - a stale answer is dropped;
  - `release()` ends the `xprop -spy` child (a fake `xprop` on `PATH` logs its start and `SIGTERM`), forgets the answer, and the next query starts it again.
- **Follow-audio** (`audio-monitor.test.ts`): real child processes, with fake `parec`/`pactl` scripts on `PATH`.
  - The `parec` arguments, the level every 40 ms and 108 bins, and silence giving 0.
  - Mute and unmute through `pactl subscribe`, and a restart on a default-sink change.
  - Restart after `parec` exits and after it stalls.
  - `false` when `parec` is missing, failing or silent.
  - Stop during start, and double start.
  - The FFT/level heuristic: 500 random spectra vs the C# transcription.
- **Capture sequencing** (`capture-slot.test.ts`): stop during start, overlapping starts, restart and timeout, and `current` (the session a retune acts on). **Frame intervals** (`capture-protocol.test.ts`): the 33..10000 ms clamp, the source frame rate (1000 / interval, not rounded, 1..30 fps), the sample spacing (a source at the asked rate sampled frame by frame, a 30 fps one thinned to the asked rate), and every Follow video speed tier and the paused interval passing unchanged.
- **Exit** (`exit.test.ts`): vendor order, and throwing or rejecting steps never skip the backend stop.
- **`spawnTied`** (`child-process.test.ts`): a helper dies when its parent is SIGKILLed.
- **Packaging:** udev (including `power/control` on the bridge), modules-load, control (Depends names, versioned libc6), maintainer scripts, `.desktop` validity, `StartupWMClass` = `desktopName` (the X11 WM_CLASS Electron sets), and the VCP 0x04 note in README.Debian, the man page and the description.
  - udev: no seat access to the adapters the backend never probes (each of `IGNORED_ADAPTER_PREFIXES`, AMDGPU SMU, SMBus names), while the display buses of amdgpu DC, i915, nouveau and radeon keep it.
  - Fuses: read from the real Electron 44 executable, `PACKAGED_FUSES` written, read back, and exactly three bytes changed; `package-deb.mjs` applies them after the packager; the wire parser refuses unknown layouts.
  - Privacy: no source of the bundles, script, packaging file or built app contains the user's monitor or ENE serial.
  - Backend host: the production backend lists the synthetic serial; its `Theme_ExportProfile`/`Theme_ImportProfile` follow the real `PathGuard` (refused, granted once, picked).

**E2E tests**
- **Placeholder suite:**
  - preload shape (no `require`/`process`) and the 880-wide splash; `window.__EVNIA__.experimental` across the real contextBridge (off, and a non-boolean refused);
  - the full shell contract and hub token enforcement;
  - the working-size resize;
  - the kill-switch probe blocked and logged, and zero non-local requests;
  - no console errors beyond an explicit allowlist (only the probe's `ERR_BLOCKED_BY_CLIENT`).
- **Vendor suite** (when `build/vendor-ui` exists): the same against the real renderer, with the simulated 34M2C8600 (`EVNIA_MOCK_MONITOR=34M2C8600`), plus the page checks of `pages.ts`:
  - Home shows the **PHL 34M2C8600** card with its bundled image (`artifacts/vendor/home-monitor-card.png`), not "Connect Your Evnia Device".
  - A second SignalR client on the app's hub (port and token taken from the page) gets `Device_GetConnectList` with the monitor's SN, and `Profile_GetDeviceData` with `MonitorResolution`/`MonitorFrequency`/`MonitorOrientation` = `3440x1440`/`175Hz`/`0°` from main's host services.
  - The console-error allowlist has exactly one entry: the vendor `DeviceImage`'s deliberate miss of `vendor-ui/monitor/<model>_overview.png` (the installer ships none for the 34M2C8600; its error handler switches to `<model>.png`, `styles-DAnQi2A8.js:33376-33384`). It is accepted only when the fallback image loaded. Console lines now carry the message location, which for "Failed to load resource" is the resource URL.
- **`--openAsHidden`:**
  - without a tray host (GNOME session, no D-Bus) the window is shown;
  - with a tray host (non-GNOME X11) it stays hidden.
- **Capture:**
  - X11 frames of 50x40 at about 10 fps, showing a red test window;
  - no frames after stop, and the window is released;
  - stop during start resolves `false` with no frames and no window;
  - overlapping starts: the later wins, the earlier gets nothing, one stream (19 frames in 2 s);
  - a restart drops the old callback at once;
  - a running capture retuned in place (`setVideoInterval`: 100 → 40 → 300 ms): one session and one window, more frames at 40 ms than at 100 ms, about 5 in 1.5 s at 300 ms, the host's `videoStats`, and the page's `video-retuned` log line; a retune while the start is still in flight applies when the stream is up; a retune while nothing is captured is a no-op;
  - frame-driven sampling: the page reports `sampling each new source frame`; at 300 ms the frames come every 300 ms (median gap 280..320 ms); and 12 colour changes of the test window, at random phases, reach the frame callback with a median lag under 300 ms (measured 149 ms, max 266; with the timer fallback forced, 439 ms, max 580). The figures are written to `artifacts/capture/lag.json`;
  - a start past its deadline resolves `false` and cleans up;
  - audio resolves `false` without `parec`.
- **Walkthrough** (`walkthrough.test.ts`, impl-walkthrough.md): the real vendor UI against the simulated 34M2C8600, every monitor page and tab plus Profile, Settings and Dashboard, with interactions checked on the simulated monitor/ENE, in two runs (ENE present and first run; no ENE with the user's migrated Windows data). After every step: no console error or renderer exception beyond documented vendor ones, no failed or hung backend request, no loading overlay left, nothing leaving the machine, no main-process error.
- **Harness additions** (walkthrough wave): `--disable-dev-shm-usage` (Docker's 64 MB `/dev/shm` made Chromium kill the GPU process during full-window screenshots), renderer `pageerror` capture (`Session.pageErrors`; also asserted empty by the vendor and placeholder suites), the main window's hub traffic (`Session.rpc`), Chromium's stderr, and `LaunchOptions.seed` to prepare `~/.config` before launch.

- Artifacts (screenshots, `network.json`, `console-errors.txt`, `page-errors.txt`, `main.log`) land in `test/e2e/artifacts/<suite>/`, which is git-ignored; the walkthrough writes `artifacts/walkthrough/<run>/`.
- `npm run test:e2e` needs to be wrapped in `xvfb-run`; package.json is not owned by this module.
- The e2e files run in parallel. In the shell wave they passed 3 consecutive runs of 15 tests, about 26 s each. The integration-wave run (after `npm run import-ui && npm run build`, `--network none`) passed 17 of 17. Four measures make that hold:
  - The capture harness starts its own Xvfb display, so other windows cannot cover its test pattern.
  - Requests are recorded on the Playwright context.
  - The main process's own `Blocked … request to` log lines are asserted as the authoritative record of outbound attempts. Screenshots are best-effort artifacts.
  - Helpers are started with `spawnTied`. Before that, an orphaned `udevadm` kept Playwright's pipes open and the suite hung after closing the app.

## Deviations from the vendor (all intentional)

1. **Backend and startup**
   - The backend runs in process.
   - `startupBackendService` resolves only when the hub listens (the vendor resolved before EvniaServe listened).
   - There is no MonitorInfo download and no 10 s `--openAsHidden` backend delay.
   - The hub is loopback-only and token-protected.
2. **`interfaceInitializeCompleted`** does not minimize and re-show the window (a Wayland client cannot un-minimize itself). It resizes in place after the same 300 ms.
3. **Closing the window quits when no tray host exists**, instead of hiding to an invisible tray.
4. **Notice toast:** the work-area origin is honoured, and `showInactive` avoids stealing focus.
5. **Logs:** today's log is appended to, not truncated on start. Retention never deletes non-log files. Rotation goes to `.1`.
6. **`config.json`**
   - Main is the only writer; the vendor had two electron-store instances racing on the file.
   - Invalid JSON is set aside instead of crashing.
   - Cloud keys are stripped; update and login keys are pinned.
7. **`getRunConfig`:** `isPackaged:true` always (the renderer is always the production bundle) and `mac:""`.
8. **`getMonitorJsonConfig`:** `OTAEnable:false`. It returns an empty config instead of `undefined` when no table exists. A user copy in `~/.config/evnia` wins only if its `Version` is at least the bundled one (14 §7.5).
9. **`local:`** is confined to images in allowlisted directories (the vendor used `net.fetch` of any path).
10. **Preload:** channel allowlist, sanitized listener events, and a working `window.noop` (the vendor defined it only in the isolated world).
11. **Tray:** no Check for Updates or Feedback item.
12. **Shortcuts:** `globalShortcut` is replaced by `before-input-event`, with no application menu.
13. **Removed:** the `EvniaPrecisionCenterApp://` protocol, `thirdPartySuccess`, the DtsServer kill, the feedback window, Matter, the updater, and resource patches.
14. **Foreground app:** focusing this app no longer resets the tracked foreground app. This fixes the vendor's self-exclusion bug (13 §4.3).
15. **`fileSelect`:** single file only, sanitized options, regular files only, and the returned buffer only up to 20 MiB (the renderer's own import limit; the vendor read any picked path completely, synchronously).
16. **Display events:** `displayChange` ignores work-area-only changes. `otherDeviceChange` is derived from USB and display add/remove, since Linux has no `WM_DEVICECHANGE`. udev `drm`/`i2c-dev` events and Mutter's `MonitorsChanged` are extra `displayChange` sources (01 port plan 4).
17. **Exit** has a 3 s hard deadline (vendor: 1 s) so the hub's close grace fits. Each step is isolated, so one failure cannot skip the backend stop.
18. **Autostart:** `autoStartup` defaults to false (01 port plan 6). `--openAsHidden` shows the window when no tray host exists.
19. **Debug flag:** per-user runtime directory, and only a regular file owned by the user counts (vendor: `%TEMP%`).
20. **`nodeApi` writes:** only new temporary files directly in userData, and deletes only of those and of export files. This fixes the vendor import that could overwrite and then delete `config.json` and other app state.
21. **Follow-audio** records with `parec` in main instead of the vendor's WASAPI loopback. That is 09 plan C; Chromium cannot open monitor sources.
22. **Capture sequencing:** a stop or newer start cancels a pending start, and a start times out after 60 s. The vendor's synchronous GDI/WASAPI capture had no pending state.
23. **Display mode:**
    - §3.5's sources replace `EnumDisplaySettings`.
    - When none of Mutter, XRandR and libdrm is available, the Electron screen API answers, and only for an unambiguous display. §3.5 has no such source.
    - The frequency truncates with a 0.005 Hz slack instead of the legacy API's plain truncation.
    - With `EVNIA_MOCK_MONITOR` the simulated monitor reports the user's mode.
24. **Idle time on GNOME Wayland** also comes from Mutter's idle monitor, polled adaptively. The vendor had `GetLastInputInfo`.
25. **App picker:** `fileSelect` swaps the renderer's `["exe"]` request for a `.desktop` chooser, and `runConfig.processPath` is the port's `.desktop` (20-theme §10.2 items 1-2; zero bundle patches).
26. **Export:** a single one-extension save filter appends its extension (GTK does not; §10.2 item 7).
27. **Foreground app:** besides the exe, the tracker reports `WM_CLASS` and the Flatpak ID (the backend's `getForegroundApp()` extension). The vendor only had the process path.
28. **`fileSelect`/`getFileSize`** read and stat asynchronously (the vendor used sync fs in main).
29. **Wayland capture grant** is reused within a run (the vendor captured through GDI without any consent).
30. **Renderer log bridge:** `window.__electronLog` is the port's preload API over an allowlisted internal channel with sender checks and a sanitized, bounded, single-line message (vendor: electron-log's own preload and IPC channel, any message processed as given).
31. **`file:`** requests are allowed only below the app tree (vendor: every `file:` URL, and a CSP whose `'self'` matched them all). The CSP has no `'self'` in `connect-src`, and `frame-src`, `worker-src`, `media-src`, `form-action` and `manifest-src` are `'none'`.
32. **Hub file arguments** follow main's path policy (`HostServices.pathAllowed`). The vendor read and wrote any path the renderer sent; a refused path gets the vendor's own error. `nodeApi` reads and copies take regular files of at most 20 MiB.
33. **Packaged executable:** the `RunAsNode`, `NODE_OPTIONS` and `--inspect` fuses are off. Main refuses outbound sockets and DNS at the Node level (`egress-guard.ts`), and Chromium uses no proxy (`--no-proxy-server`).
34. **Foreground tracking** runs only while an app-bound theme exists or a theme other than "User" is current. The vendor followed every focus change for the whole session.
35. **udev:** the i2c rule excludes the GPU adapters the backend never probes (AMDGPU SMU, SMBus, …). The Windows app needed no such rule; ddcutil's `60-ddcutil-i2c.rules`, which the rule otherwise follows, tags every i2c bus of a display adapter.
36. **Capture retune** (`setVideoInterval`): the capture keeps its session when the Follow video speed changes, and while FollowVideo's uploads are paused. The Wayland portal stream is opened at the 30 fps ceiling and then constrained to the asked rate, and an X11 desktop stream that cannot reach a faster rate is re-opened silently. The vendor captured with GDI on its own fixed 300 ms thread and had nothing to retune.
37. **Frame-driven sampling** (2026-09-27): the page samples each frame of the screen source as it arrives (`MediaStreamTrackProcessor`), at the asked rate, instead of a timer sampling a `<video>` element out of phase with the source. The vendor grabbed a GDI screenshot at the moment it sampled, so its frames had no age; frame-driven sampling brings the port's lag to the same level. The timer remains as the fallback.
38. **Port experiments in `config.json`** (2026-09-27): the key `linuxExperimental` ("Fast LED upload (experimental)", impl-usb-ene deviation 20) and its narrow preload API `window.__EVNIA__.experimental` over the internal channel `evnia:experimental-set` (main window only, booleans only). The vendor has neither; its `Qd` schema is otherwise unchanged.

## Known limitations

- **Wayland**
  - Toast positioning is ignored by the compositor. Only peripheral DPI/battery notices use the toast, so it is irrelevant for the monitor-only scope.
  - The first follow-video start of each app run shows the ScreenCast portal dialog. Later starts reuse the grant (unverified; a failed reuse falls back to the dialog).
  - GNOME shows a screen-sharing indicator while follow-video runs.
  - The foreground app is not available, so app-bound themes are inert. XWayland windows are not tracked either: the tracker is off on Wayland sessions.
- **GNOME without the AppIndicator extension** has no tray. Closing the window then quits, and an `--openAsHidden` start shows the window.
- **Display mode**
  - The libdrm fallback knows no orientation (`0°`), as §3.5 says.
  - On a non-GNOME X11 desktop, a refresh-rate-only change without any display event is picked up by the next lookup's background refresh (data older than 10 s). The lookup itself still answers with the old rate.
  - `xrandr` comes from x11-xserver-utils, a `Recommends` of the package: an install without Recommends has no X11 source b.
- **Idle time:** between Mutter polls the value below 55 s is an upper bound (exact while no input happens). That is only valid for the backend's ≥ 60 s thresholds, its only consumer.
- **Follow-audio**
  - It needs PulseAudio or PipeWire with pipewire-pulse, plus `parec` (pulseaudio-utils, a Recommends of the package). Without `pactl`, default-sink changes and mute are not followed.
  - GNOME's microphone indicator may appear while it runs, because GNOME Shell counts recording streams on monitor sources too.
- **Display changes:** a refresh-rate-only change is seen only through Mutter's `MonitorsChanged`, i.e. on GNOME. Other desktops rely on Electron's events and udev.
- **Helper processes:** without `setpriv` (util-linux), a helper orphaned by a crash of the app outlives it. The normal exit path always stops them.
- **Test coverage gaps**
  - The setuid sandbox can only be exercised in a container with `CAP_SYS_ADMIN` (the install test adds it). Otherwise, run with `--no-sandbox` in containers.
  - The install test covers Debian 13 and Ubuntu 24.04 containers, not a desktop session. Ubuntu 24.04's AppArmor restriction of unprivileged user namespaces cannot be reproduced in Docker; the forced setuid-sandbox launch covers the path Chromium takes there.
  - Follow-audio has run only against fake `parec`/`pactl` processes; the container has no sound server. To confirm it on a real PipeWire session: start FollowAudio, play audio, and check that the backend receives non-zero levels. The main log also shows "Follow-audio capturing the default sink monitor".
  - The Wayland portal path and Mutter `MonitorsChanged` need a real GNOME session. X11 capture, udev parsing and the sequencing are tested.
  - The display-mode sources ran only against fixtures in the tools' documented output formats (`gdbus call` of `GetCurrentState`, `xrandr --current --verbose`) and against a C-compiled stand-in libdrm. The container has no compositor, no `xrandr`/`gdbus` and no `/dev/dri`. To confirm on the user's machine:
    - start the app with the debug flag and check the main log line `Display modes (mutter): mutter:DP-…=3440x1440@…`;
    - check that the overview/dashboard shows the monitor's resolution and refresh rate;
    - the 175 Hz mode's exact timing (20-monitor-io checklist C10) decides between `175Hz` and `174Hz`.
  - The Mutter idle monitor has not run on a real GNOME Wayland session. To confirm: enable "turn off lights when idle" with 1 minute, leave the input idle, and check that the backend log shows `Idle state:True` after about 60 s.

## Integration status

The integration items the other modules' notes addressed to Electron main:

| Source | Item | Resolution |
|---|---|---|
| impl-integration §2.1, impl-monitor §5 items 4 and 7, impl-usb-ene §5 | One `LibusbBackend` per process for the VIA bridges and the ENE; `EVNIA_MOCK_MONITOR` → `mockMonitor` | `backend-host.ts backendConfiguration`: real hardware gets main's shared instance, mock mode gets `noHardware` and no USB. `createDefaultBackend` is called explicitly (the production composition, services exposed). |
| impl-integration §3 last row and §8, impl-theme §2 and §3.4 | `local:` private root ≠ the theme store's `PATH_APP_TEMP` | One `defaultAppTempDir()` computed in `index.ts`, passed to the theme store (`themes.appTempDir`) and to `privateRoots` |
| impl-theme §3.4, 20-theme §10.2 item 5 | Optional `getForegroundApp()` with `WM_CLASS` | `X11ForegroundTracker.currentApp()`: exe, `WM_CLASS` class and Flatpak ID in one `xprop -id` query |
| impl-theme §3.4, 20-theme §10.2 items 1, 2, 7 | `.desktop` chooser instead of `["exe"]`; `processPath` = the port's `.desktop`; save extension | `dialog-options.ts`, `ipc.ts`, `paths.ts selfDesktopFile` |
| impl-monitor §4 and §5 item 6, 20-monitor-io §3.5 | `getDisplayMode` for the display's connector, `floor(rate + 0.005)` | `display-mode.ts`, `display-sources.ts`, `drm-modes.ts` (see "Display mode") |
| impl-ambiglow §2.4 and §6 ("Idle time on GNOME Wayland … unverified", 09 plan D) | Input idle time on every target session | `idle-time.ts`: Electron plus Mutter's idle monitor on GNOME Wayland |
| impl-ambiglow §2.4 (host table) | FollowVideo asks for frames every 300 ms and keeps the session across idle and a short ENE absence; `false` means "not capturing"; FollowAudio forwards the 40 ms level; `stopVideo()` is synchronous and idempotent | Already met by `CaptureHost` (frames at the asked interval, clamped to 33..10000 ms; since the speed tiers FollowVideo asks 300, 100 or 40 ms and retunes a running session with `setVideoInterval`; 50×40 RGBA, latest call wins, never throws, idempotent stops after `dispose()`). The audio source is the default sink's monitor (`parec --device=@DEFAULT_MONITOR@`), which follows default-sink changes and mute. |
| impl-ambiglow §2.4 "Capture-host request" | No portal dialog on every FollowVideo start (`restore_token`, `persist_mode: 2`) | Within one run: the granted source is reused (see "Capture host"). Across runs: **open**, since Electron exposes neither `persist_mode` nor the token. |
| impl-ambiglow §6 | A session the user ends from GNOME's sharing indicator is not reported to the backend | **Open**: `CaptureHost` (types.ts) has no callback for it. The host releases the window and the grant and logs a warning. |
| impl-integration §4.1 and §8 (vendor-ui / e2e) | The e2e console check failed on the vendor's `34M2C8600_overview.png` miss | Allowed in `test/e2e/app.test.ts` only with the loaded fallback (see "E2E tests"). The import script is unchanged. |
| impl-walkthrough §5 (walkthrough wave) | The renderer's electron-log had no bridge (console error on every monitor unplug, the log line lost) | `window.__electronLog` → `evnia:renderer-log` → `renderer-log.ts` (see "IPC", deviation 30) |
| impl-walkthrough §3 | The walkthrough needs the simulated hardware's state and the outside world's events | `mock-probe.ts`, installed in mock mode only; the idle time goes through it (`host-services.ts` takes any `seconds()` source) and its hotplug uses the real `DeviceChangeGate` |
| impl-usb-ene "Runtime library for USB" (packaging wave) | `Depends: libudev1` (the usb prebuild links `libudev.so.1`); `libusb-1.0-0` is not used | `control.in` Depends is now the shared-library closure of all shipped ELF files; `package-deb.mjs` checks it at build time, and the install test checks it in clean Debian 13 and Ubuntu 24.04 (see "Packaging") |
| impl-integration §5 and §8, impl-walkthrough "User documentation", impl-ambiglow §6 "User-facing notes" (packaging wave) | User documentation of the VCP 0x04 resets, the ENE udev rule, the Wayland portal dialog and idle lights | `README.Debian` and `evnia-precision-center(1)`, and the note in the package description |
| impl-ddc "Packaging", impl-usb-ene "udev", 20-monitor-io §2.9 (packaging wave) | udev rules and modules-load on real systems | Shipped; `udevadm verify` passes on systemd 257 and 255, and the rules are checked for uaccess only |
| impl-electron-shell "Integration status" (xrandr) (packaging wave) | `x11-xserver-utils` for display mode on X11 | In `Recommends`, with `libglib2.0-bin` (`gdbus`) and `libpipewire-0.3-0t64` (Wayland screen capture) |

**For the backend (still valid)**
- **Hotplug is already debounced** and shielded when `backend.hotplug(kind)` is called. The renderer's own `Device_Detection*` calls follow on the same events.
- **MonitorInfo.** `HostServices.resourcesDir/MonitorInfo.json` is the bundled v34 table; an optional user copy is `appDataDir/MonitorInfo.json`. A user copy wins if its `Version` ≥ the bundled one (`src/main/monitor-info.ts`, pure; the backend has its own copy of the rule, impl-theme §3).
- **Capture.** Call `stopVideo()`/`stopAudio()` whenever the effect leaves FollowVideo/FollowAudio. That releases the portal session, the hidden window and `parec`.
  - Start and stop may be called in any order and at any rate. The latest call wins, and a superseded or stopped start resolves `false`.
  - `startVideo` returning `false` after a denial or the 60 s timeout is the place to fall back to the monitor-native mode (`E2A019=1`, 09 plan B).
  - `startAudio` returning `false` means no `parec` or no sound server.
- **Page checks.** Add per-page e2e checks as `PageCheck` entries in `test/e2e/pages.ts`; they run in the vendor suite with the mock monitor. `hubRpc(window)` there gives a second SignalR client on the app's hub.

**Dependencies.** No new npm dependencies. The runtime tools are all optional and degrade gracefully when missing:
- xprop (x11-utils): foreground app on X11;
- xrandr (x11-xserver-utils): display mode on X11. It is in the package's `Recommends` (packaging wave). GNOME X11 also has Mutter, and libdrm is the fallback.
- parec and pactl (pulseaudio-utils);
- gdbus (libglib2.0-bin, part of every GNOME install): Mutter `DisplayConfig`, `MonitorsChanged`, `IdleMonitor`; and dbus-send;
- udevadm;
- setpriv (util-linux);
- xdg-desktop-portal;
- libdrm.so.2 (always present: Electron links it).

**types.ts** has no additions from this module. `MainHostServices` = `HostServices & Required<ForegroundAppHost>` is local to main.

**For other owners**
- **User documentation** (binding decision, impl-integration §5): *Profile → Reset* and *Settings → Factory reset* also reset the monitor. They send VCP 0x04 = 1, like the Windows app. This is now documented in `packaging/deb/README.Debian` (installed as `/usr/share/doc/evnia-precision-center/README.Debian.gz`), in the man page `evnia-precision-center(1)` and in the package description (see "Packaging").
- **Main / USB owners: exit crash** (see "Packaging", known issue). Every exit ends in SIGTRAP because `usb` 2.18.0 is loaded in the browser process. The install test reports it as XFAIL.
- **impl-theme §2 and §3.4, impl-integration §3 and §8, impl-monitor §4, impl-ambiglow §6 (idle on GNOME Wayland):** these notes still describe the main-side items above as open.

## Security review fixes

The findings of the security/privacy review (verdict "needs fixes"), and how each was resolved. The owners' notes were updated as well: impl-hub-rpc §3.1, impl-theme §3.4 and §4, impl-vendor-ui §3, impl-ddc "Mock mode", impl-usb-ene.

| Finding | Resolution |
|---|---|
| **major**: any file the user can read was readable by the renderer through `fetch`/XHR/`<img>` of `file:` URLs (kill-switch let every `file:` through, CSP `'self'` matches all `file:` URLs, `GrantFileProtocolExtraPrivileges` on) | `network-guard.ts isAllowedFileUrl`: `file:` only below `AppPaths.appRoot`, for the default and the capture session. CSP `connect-src ws://127.0.0.1:*` without `'self'`, plus `frame-src`/`worker-src`/`media-src`/`form-action`/`manifest-src 'none'`. The fuse stays on (the vendor UI's `file://` module scripts need it). Both e2e walkthroughs pass with no blocked `file:` request. See "Network kill-switch". |
| **major**: the hub let the renderer (or any token holder) write and read arbitrary paths (`Theme_ExportProfile`, `Macro_Export`, the imports and descriptions) | `HostServices.pathAllowed` (types.ts). Main answers it with `PathGuard.backendMayAccess`: dialog picks and the app's data for reads; the `exportFile` answer (once) and userData temp exports for writes. The backend replies with the vendor's own error on refusal. `Comm_GenAppIcon` takes only a `.desktop` file or an executable. See "Backend file arguments". |
| minor: udev `uaccess` for every i2c bus under a display adapter, including `AMDGPU SMU` and SMBus adapters | The rule excludes the backend's `IGNORED_ADAPTER_PREFIXES` and any "smbus" name. The packaging test keeps both in sync, and `udevadm verify` passes. |
| minor: packaged Electron with default fuses (RunAsNode, NODE_OPTIONS, --inspect on) | `package-deb.mjs hardenFuses` (`scripts/lib/fuses.ts`), read back after writing. There is a unit test against the real Electron 44 binary, and an install-test check of the installed executable (wire and behaviour). The install test's scripts run on a copy with `RunAsNode` back on. |
| minor: no proxy dead-end, no Node-side egress ban | `--no-proxy-server`; `egress-guard.ts`, installed at bootstrap before the backend (see "Network kill-switch" item 4). |
| minor: hub replies broadcast to every client | Replies go to the caller only; Notifications are still broadcast (impl-hub-rpc §3.1). |
| minor: the user's real monitor serial (and EDID serial, and the ENE's USB serial) compiled into the shipped bundle | The shipped mock is synthetic: `MOCK000000001`, EDID serial number 1 with the checksum recomputed, and ENE `0000000001`. Tests that replay the user's data inject `test/fixtures/user-monitor.ts` (`MonitorManagerOptions.mockSpec`, `createMock34M2C8600({spec})`). A packaging test scans the bundle sources and `build/app` for the real identifiers. |
| minor: continuous foreground-window tracking without any app-bound theme | `AppBindingWatcher` asks the host only while a binding exists or a non-"User" theme is current, and otherwise calls `releaseForegroundApp()`. `X11ForegroundTracker.release()` ends `xprop -spy`. See "Foreground app". |
| minor: picked files handled without type or size limits (`readFile` of a FIFO or `/dev/zero`, sync `readFileSync`/`copyFileSync` of any size in main) | `file-read.ts`: `O_NONBLOCK` open, `fstat` of regular files only, at most 20 MiB for `fileSelect`'s buffer and every `nodeApi` read or copy, `EINVAL`/`EISDIR`/`EFBIG` otherwise; `getFileMd5` streams regular files only. |

Verified: `npx tsc` clean; 848 unit and contract tests pass; after `npm run import-ui && npm run build`, the e2e suite passes 51 of 51 (`--network none`, both walkthroughs, including profile export and import through the new grants). `npm run dist:deb` logs the wire `RunAsNode=0 … GrantFileProtocolExtraPrivileges=1 WasmTrapHandlers=1`. `test/install/run.sh` was not re-run: its apt downloads need the network. Its changed helpers were run against the built `.deb` in the dev container instead: `node_runtime`, whose copy differs from the executable in exactly the RunAsNode byte and runs Node, and `check_fuses` (rc 0; the app it starts leaves nothing named "evnia" outside the throwaway HOME).
