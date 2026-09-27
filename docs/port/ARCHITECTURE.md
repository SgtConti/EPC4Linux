# Evnia Precision Center for Linux: architecture

This is an offline Linux port of Philips **Evnia Precision Center 1.13.0**, covering monitor features only. It is built from the reverse-engineering specs in [`docs/re/`](../re/).

Companion documents:
- [USER-GUIDE.md](USER-GUIDE.md): installing and using the app;
- [MAINTAINING.md](MAINTAINING.md): tests, vendor updates, known limitations;
- the `impl-*.md` notes: one per module, with behaviour, deviations and tests.

## Scope (decided with the user, 2026-09-26)

| Decision | Consequence |
|---|---|
| **Monitor only** | Only the display device (`DeviceType 100000`, `PHL_CDeviceDisplay`) is implemented. Peripheral pages, TAG/DTS headsets, SmartDesktop/FancyZones and AmbiScape smart bulbs are hidden or stubbed. |
| **No online features** | Every cloud touchpoint (N01–N40 in `14-online-sweep.md`) is removed or stubbed. A network kill-switch in the main process, a Node-side egress guard and a local-only CSP back this up. The backend never opens outbound sockets. |
| **No firmware OTA** | `DisplayFW_UpdateFirmversion` always fails. The FwUpdate tab is hidden (`OTA-OFF`, `OTAEnable:false`). No flashing code ships. |
| **Reset keeps the vendor's monitor reset** (binding decision) | `Theme_ResetCurProfile` (Profile → Reset) and `FactoryReset` (Settings → Factory reset) send VCP 0x04 = 1, the monitor's own factory reset, exactly like the Windows app. This is documented for users in USER-GUIDE.md, README.Debian, the man page and the package description. |
| **Targets** | GNOME on Wayland and X11 sessions, x86-64 only. |
| **Packaging** | `.deb` only. Tested on Debian 13 and Ubuntu 24.04. |

Reference hardware: Philips Evnia 34M2C8600 (EDID `PHL`/`0xC29F`, scaler RTD2738VL). It has a VIA Labs USB-DDC bridge at `2109:8884` and an ENE Ambiglow MCU at `0cf2:a201`.

## Big picture

```
┌──────────────────────── Electron 44 (one app) ────────────────────────────────────┐
│ Renderer (vendor Vue bundle, patched at build time; NOT stored in this repo)     │
│   window.ipc / window.store / window.nodeApi  ← preload (allowlisted, sandboxed)  │
│   SignalR JSON client → ws://127.0.0.1:<port>/EvniaHub?k=<token>                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Main process (src/main)                                                           │
│   windows, tray, allowlisted IPC, electron-store-compatible config.json,           │
│   network kill-switch + egress guard, XDG autostart, device-change events          │
│   (Electron screen, udev, Mutter, libusb), display mode (Mutter/xrandr/libdrm),    │
│   idle time, foreground app (X11), follow-audio (parec) ─────────┐                 │
│   capture host (hidden window: screen frames 50×40) ─────────────┤                 │
│   embeds ▼                                                       │ HostServices    │
│ Backend (src/backend, plain Node, no Electron imports)           │                 │
│   hub/  SignalR-JSON server (ws, 127.0.0.1 only, token + Host + Origin check)      │
│   rpc/  dispatcher: GetTaskAsync{functionName,requestId,parms} → JsonResult        │
│   api/  Bridge function subset (PHL_*, Profile_*, Theme_*, Effect_*, …) + stubs    │
│   monitor/ PHLDisplay driver (profile/attributes/constraints), manager             │
│   ddc/  DDC/CI codec, capabilities + cache, EDID, discovery;                       │
│         transports: VIA USB (libusb) → i2c-dev (koffi ioctl) → simulator           │
│   ambiglow/ ENE USB driver + DDC fallback + follow-video/audio engines ◄──────────┘
│   theme/ DataTheme.cfg / *.pcenter / SoftConfig persistence (Windows-compatible)   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### Why this shape

- **Reuse the vendor renderer.** It is a finished Vue 3 UI with no OS dependencies of its own; everything goes through `window.ipc`, `window.store`, `window.nodeApi` and the hub (`02-renderer-shell.md` §L). Rewriting it would cost a lot and lose fidelity. The build pulls it from the user's own installer copy and applies scripted, exact-once, hash-guarded patches. No vendor code is committed.
- **Replace the backend rather than port it.** The .NET backend is about 180K lines of Windows-bound code: WinForms, WMI, SetupAPI, WinUSB, GDI, WASAPI and x86 vendor DLLs. The monitor subset we need is small and fully specified. A Node backend inside the Electron main process removes a second runtime and a second process, and it can be tested headless with a simulated monitor.
- **Keep the SignalR wire protocol.** The renderer's hub client is deeply wired in (`styles-*.js` class `Jc`). Speaking its JSON protocol means patching only one URL template, not the client logic. Security is fixed at the server:
  - it binds to `127.0.0.1`;
  - it accepts only the Host `127.0.0.1:<port>`/`localhost:<port>` and the Origin `file://` (or no Origin);
  - it requires a per-launch random token in the query string;
  - it answers each call to the caller only.

  This closes the vendor's unauthenticated RPC on all interfaces (`http://*:10010`).

## Module map and ownership

| Path | Responsibility | Spec | Impl note |
|---|---|---|---|
| `src/backend/types.ts`, `services.ts` | Contracts: `HostServices` (what the backend asks of the desktop), USB/DDC/capture interfaces, the `Backend` facade; the service contracts `ThemeStore`, `DisplayDevice`, `MonitorManager`, `AmbiglowService` | — | impl-hub-rpc §7 |
| `src/backend/index.ts`, `compose.ts` | Composition root: `createBackend`/`createDefaultBackend`, the production wiring of the three services and the 11 API modules, service lifecycle (themes → monitors → ambiglow), hotplug events | 05 §2.5 | impl-integration |
| `src/backend/core/` | `JsonResult` envelope, C#-compatible JSON serialization (key order, three serialization modes), event bus, logger | 05 §3.4, 12 §2/§7 | impl-hub-rpc |
| `src/backend/hub/` | SignalR JSON-protocol server over `ws` (handshake, invocation, completion, ping, close); token/Host/Origin guard; rate-limited rejection log | 02 §L.4, 05 §3 | impl-hub-rpc |
| `src/backend/rpc/` | Dispatcher: overload resolution by argument types (int/string/bool), `Profile_GetDeviceData` special serialization, error codes, 120 s handler watchdog; notifier | 05 §3.3, 20-backend-host-tail §1 | impl-hub-rpc |
| `src/backend/api/` | The Bridge catalog (162 overloads), implementations of the monitor subset, plus stubs for everything else (peripherals, OTA, FancyZones, DTS, Wi-Fi, Matter) that return renderer-safe values | 05 §12, 03 §5, 12 §7, 20-backend-host-tail §3 | impl-api and the owning modules |
| `src/backend/ddc/` | DDC/CI frames, checksums, reply parsing, extended `E2 A0 xx` codes, TPV `FE` identity queries, capabilities (`F3`) reader and parser, the HMAC-signed capability cache (`Config/data.json`), EDID parser, discovery (DRM connectors, i2c buses, VIA bridges, ENE pairing), in-process and `flock` locks; transports `via-usb`, `i2c-dev`, simulator | 07, 08 §3–4, 06 §4–6, 20-monitor-io | impl-ddc |
| `src/backend/usb/` | Thin libusb wrapper (`usb` npm) for vendor control transfers and hotplug; a fake for tests | 08 §4, 09 §3 | impl-usb-ene |
| `src/backend/monitor/` | Manager (scan kinds, hotplug reconcile, current display), identity, `T_PHLDisplay_Profile` model, load sequence, `PHL_SetOSD` semantics and quirks, constraints, per-display operation queue | 06, 12 §3, 20-* | impl-monitor |
| `src/backend/ambiglow/` | ENE `0cf2:a201` register driver, effect parameter model, DDC fallback (`E2A0 19..1E`, `38`), follow-video mapping (50×40 grid → LEDs), follow-audio level, synced breathing, idle lights-off | 09 | impl-ambiglow, impl-usb-ene |
| `src/backend/theme/` | `Theme/DataTheme.cfg`, `Theme/<theme>/<profile>.pcenter`, macros, `Config/SoftConfig.data`, compatible with the Windows files (UTF-8 BOM, single-line JSON); app binding on Linux; `FactoryReset` | 05 §7, 12 App. D, 20-theme | impl-theme |
| `src/backend/cli.ts`, `serve.ts` | DDC/CI bring-up CLI (read-only by default); backend + hub without Electron | 07 §8.5 | impl-ddc, impl-integration §6 |
| `src/main/` | Electron main: lifecycle, windows (main + notice), tray, IPC allowlist and path policy (`fs-guard.ts`), store (with the port's opt-in experiments, `experimental.ts`), kill-switch and egress guard, `local:` protocol, autostart, device-change events, display mode, idle time, foreground app, capture host, follow-audio recorder, logs, mock probe (tests) | 01, 02 §L.2, 09 §7–8, 13, 20-monitor-io §3.5 | impl-electron-shell |
| `src/preload/` | `window.ipc` (allowlist + offline defaults), `window.store` (sync snapshot), `window.nodeApi` (path-confined), `window.__EVNIA__` (hub token; `experimental`: the "Fast LED upload" checkbox of the FAST-LED-UPLOAD patch), `window.__electronLog` (renderer log bridge) | 02 §L.2 | impl-electron-shell |
| `src/capture/` | Hidden capture page: screen frames through `desktopCapturer` (X11) or `getDisplayMedia` and the ScreenCast portal (Wayland), downscaled to 50×40 | 09 §7 | impl-electron-shell |
| `scripts/` | `import-vendor-ui.mjs` + `ui-patches.mjs` (extract, pin, patch, remove, CSP, audit), `build.mjs` (esbuild), `package-deb.mjs` (+ `lib/fuses.ts`) | 02 §L.3, 14 | impl-vendor-ui, impl-electron-shell |
| `packaging/deb/` | control, postinst/postrm, udev rules, modules-load, `.desktop`, README.Debian, man page, copyright, lintian overrides | 08 §8, 09 | impl-electron-shell "Packaging" |
| `test/` | Unit tests (`node --test`, TS type stripping), contract tests with the production composition and the simulated monitor, Electron e2e (Playwright) including the vendor-UI walkthrough, `.deb` install tests | — | MAINTAINING "Test layers", impl-walkthrough |

## Key design rules

1. **Byte-compatible contract.** For every function the monitor pages call, the `Tag` payload has the same keys, types and enum integers as the Windows backend. Key order follows the C# declaration order (12 App. A/B). Report `03` §5/§6 and `12` define the shapes. Tests assert them against captured Windows values from the user's logs and config, including a golden startup transcript (20-backend-host-tail §5).
2. **Transport priority** (20-monitor-io D1):
   - USB-DDC (VIA) first, i2c-dev second.
   - The choice is **sticky**. The vendor instead retried "hub, then GPU" on every call, which costs about 3.5 s per call when the bridge is dead.
   - A failed get or idempotent set fails over once. One-shot actions are never replayed.
   - The choice is re-evaluated on detection events.
   - USB-DDC is enabled only after the `GetVCP(0x14)` probe passes (08 §3.6).
   - Timings match the vendor: 100 ms after a write, ≥15 ms before a read, 50 ms after a read, 3 attempts, `(n+1)*177` ms VIA retry backoff.
3. **Single DDC queue per monitor.** All VCP traffic for one monitor goes through a FIFO lock, because the vendor app is effectively serialized. Multi-step sequences also hold a per-display operation queue. Per-transaction `flock` files under `$XDG_RUNTIME_DIR/evnia` serialize the app with a second instance and with its own CLI (not with ddcutil). Ambiglow frame streaming uses the ENE device, not DDC, so it does not contend.
4. **Nothing online.**
   - The backend imports no HTTP client.
   - The main process installs `webRequest.onBeforeRequest`. It cancels anything that is not `data:`, `blob:`, `devtools:`, `chrome:`, `local:` (images below allowlisted directories only), `file:` below the app's own tree (`vendor-ui/`, `capture/`), or the loopback hub URL, and logs every cancellation.
   - Chromium resolves no host name (`host-resolver-rules`) and uses no proxy (`--no-proxy-server`).
   - A Node-side egress guard in main (`src/main/egress-guard.ts`) is installed before the backend is created. It refuses every outbound socket other than a Unix socket or a loopback address, and every DNS query.
   - The vendor CSP is replaced with a local-only one: `connect-src` names only `ws://127.0.0.1:*`, and there are no frames, workers or media.
5. **Least privilege.**
   - The preload uses `contextIsolation:true` and `sandbox:true`.
   - `runCommand`, `openDefaultBrowser`, `getMac`, downloads, Matter and feedback are removed.
   - Every way the renderer can reach a user's file is confined to the same set: `window.nodeApi` (`src/main/fs-guard.ts`), the hub's `Theme_*`/`Macro_*` file arguments (`HostServices.pathAllowed`) and `file:` requests (rule 4).
     - Reads: the app's config directories and the files the user picked in a dialog (regular files, at most 20 MiB of content).
     - Writes: only the path the user just chose in the export dialog (once), and the app's own temporary files in `~/.config/evnia`.
   - The hub answers each call to the caller only.
   - The packaged executable has Electron's `RunAsNode`, `NODE_OPTIONS` and `--inspect` fuses off.
   - The udev rules grant the seat user the two USB functions and the display i2c buses only, never GPU SMBus/SMU adapters.
   - Foreground-window tracking runs only while an app-bound theme exists.
6. **Windows profile compatibility.** Files under `$XDG_CONFIG_HOME/EvniaServe/` use the same formats as `%APPDATA%\EvniaServe\`, so profiles can be copied across in both directions. `$XDG_CONFIG_HOME/evnia/config.json` is electron-store compatible with `%APPDATA%\evnia\config.json`.
7. **Testable without hardware.** `EVNIA_MOCK_MONITOR=34M2C8600` swaps in a simulated monitor (a VCP state machine seeded from the user's real values, 06 §5.7, 03 §6.3) plus a simulated ENE device. It works in the CLI, `serve.ts`, the contract tests, the e2e run and the install test.
   - The simulator ships in the package, so its serials are synthetic (`MOCK000000001`, ENE `0000000001`).
   - Tests that replay the user's captured session inject the real EDID and serial from `test/fixtures/user-monitor.ts`.

## Linux integration

| Concern | Implementation |
|---|---|
| USB access (VIA `2109:8884`, ENE `0cf2:a201`) | libusb vendor control transfers on endpoint 0 with a device recipient. No interface claim or driver detach is needed. udev `TAG+="uaccess"` for exactly those VID:PIDs; the bridge is also kept out of USB autosuspend (`power/control=on`). One `LibusbBackend` per process, shared by the VIA bridges, the ENE and main's `USBChange` detection. |
| I2C DDC fallback | `/dev/i2c-N` through koffi FFI (`open`, `ioctl(I2C_SLAVE=0x0703, 0x37)`, `read`, `write`). The bus is mapped to a DRM connector through the connector's child AUX adapter (DP) or `/sys/class/drm/card*-*/ddc`, with EDID comparison. `EBUSY` from the `ddcci` kernel driver is retried with `I2C_SLAVE_FORCE` and a warning, like ddcutil. The package ships `modules-load.d/evnia-precision-center-i2c.conf` and a udev `uaccess` rule for i2c-dev nodes of display adapters, except the adapters the backend never probes (`AMDGPU SMU`, SMBus and the rest of `IGNORED_ADAPTER_PREFIXES`). |
| Screen capture (follow-video) | Hidden BrowserWindow. X11: the primary display's `desktopCapturer` source. Wayland: `getDisplayMedia` through the PipeWire ScreenCast portal (`setDisplayMediaRequestHandler` with `useSystemPicker`); the user consents once per app run, and the grant is reused within the run. The source runs at the asked interval (33 ms or slower), and each of its frames is taken as it arrives (`MediaStreamTrackProcessor`; a `<video>` timer as fallback), area-filtered on a canvas to 50×40 RGBA and sent. The backend's cadence follows the Follow video Speed slider: Low = the vendor's (asks every 300 ms, uploads on a 100 ms tick), Normal (default) 100 ms and High 40 ms with each new frame uploaded at once. A speed change retunes the running capture (`setVideoInterval`), with no new portal dialog, and so does a pause of the uploads, which slows the kept capture to 1 fps (impl-ambiglow §4.2). A start times out after 60 s. |
| Audio (follow-audio) | `parec --device=@DEFAULT_MONITOR@` in main (Chromium cannot open sink monitors). It follows default-sink changes and mute via `pactl subscribe`. The level is the vendor's FFT heuristic (`audio-level.ts`, 0–2500 Hz → 0–255, every 40 ms). It never opens a microphone. |
| Idle lights-off | `powerMonitor.getSystemIdleTime()`, plus Mutter's `IdleMonitor` over D-Bus on GNOME Wayland (polled adaptively), read by the backend every 1 s. |
| Display mode (`MonitorResolution`/`Frequency`/`Orientation`) | 20-monitor-io §3.5: Mutter `GetCurrentState` (GNOME), `xrandr --current --verbose` (X11), libdrm through koffi (fallback), then Electron's screen API. The source is matched by EDID or Mutter's monitor spec. The rate is `floor(exact + 0.005)`. |
| App-bound themes (`CheckTopApp`) | X11: `xprop -root -spy` on `_NET_ACTIVE_WINDOW`, then `_NET_WM_PID` → `/proc/<pid>/exe`, `WM_CLASS` and the Flatpak ID. Bindings are `.desktop` files (the app picker is a `.desktop` chooser) or executables, matched by desktop ID, `StartupWMClass`, exe realpath, wrapper-script directory or Snap name. The tracker runs only while an app-bound theme exists (or a theme other than "User" is current). GNOME Wayland: not available, so the feature is inert. |
| Display/USB change events | Electron `screen` (`display-added`/`-removed`/`-metrics-changed`), udev (`udevadm monitor`: `drm`, `i2c-dev`) and Mutter's `MonitorsChanged` → `displayChange` (2000 ms debounce); `LibusbBackend` attach/detach → `USBChange`; both → `otherDeviceChange`. Vendor timings and shields (01 §9) are applied in main, and the backend gets `hotplug(kind)` afterwards. |
| Autostart | `~/.config/autostart/evnia-precision-center.desktop` (with `--openAsHidden` when minimized). `autoStartup` defaults to off on Linux. |
| Tray | Electron `Tray` (StatusNotifierItem). It needs the AppIndicator extension on vanilla GNOME. Without a tray host (`org.kde.StatusNotifierWatcher`, or XEmbed on non-GNOME X11), closing the window quits and `--openAsHidden` shows the window. |
| Helper processes | `udevadm`, `gdbus`, `parec`, `pactl`, `xprop` start through `setpriv --pdeathsig TERM`, so they die with the app. |
| Files | `~/.config/evnia` (Electron `userData`: `config.json`, logs `YY-MM-DD.log`), `~/.config/EvniaServe` (themes, profiles, `Config/`, backend logs `YYYY-MM-DD.txt`), `$XDG_RUNTIME_DIR/evnia` (DDC lock files), `$XDG_RUNTIME_DIR/EvniaServe` (temporary app icons), `$XDG_RUNTIME_DIR/evnia-debug-open.tmp` (debug flag) |

## Build and test pipeline

1. `npm run import-ui`: extract `app.asar`, verify the SHA-256 of the files it patches, apply the patch table, rewrite the CSP, drop the unused sub-apps, audit the result, and write `build/vendor-ui/`, `build/vendor-data/`, `build/vendor-assets/` (impl-vendor-ui).
2. `npm run build`: esbuild bundles `main.cjs` (with the backend), `preload.cjs`, `capture-preload.cjs`, `capture/`.
3. `npm test`: unit + contract tests with `node --test` on TS sources (Node 22 type stripping).
4. `npm run test:e2e` (Docker, under `xvfb-run`): Electron under Xvfb with the mock monitor. It asserts no console errors and zero escaped network requests.
   - The walkthrough (`test/e2e/walkthrough.test.ts`, impl-walkthrough.md) visits every monitor page, Profile, Settings and Dashboard, with and without the ENE. It checks each interaction on the simulated monitor/ENE through a mock-mode-only probe in main (`src/main/mock-probe.ts`).
5. `npm run dist:deb` (Docker): `@electron/packager` linux-x64, then the executable's fuses (`RunAsNode`, `NODE_OPTIONS`, `--inspect` off; `scripts/lib/fuses.ts`), a shared-library closure check against `Depends`, then `dpkg-deb`.
6. `test/install/run.sh` (Docker host): the package is linted and installed in clean Debian trixie and Ubuntu 24.04 containers. It is started there as a non-root user (namespace and setuid sandbox) and purged again.

See MAINTAINING.md for what each layer covers, and for the known limitations and open questions.
