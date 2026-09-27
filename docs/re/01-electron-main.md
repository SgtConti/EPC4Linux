# Evnia Precision Center 1.13.0: Electron main process (RE spec)

**Area:** Electron main process. **Scope:** `work/app-pretty/main/index.js`, `work/app-pretty/main/index-QljccwTz.js`, `work/app/package.json`, `work/app/resources/installer.nsh`.
**Goal:** Give a Linux implementer enough detail to rebuild the main process, with every online feature removed, without re-reading the minified code.

## Summary

The main process is one Rollup/Vite bundle (`out/main/index.js`, 17 748 lines once prettified). Most of it is vendored libraries: electron-log, electron-store/conf with ajv, extract-zip/yauzl, md5-file, crypto-js, crc, electron-dl, and file-type/mime. Only about 2 000 lines are application code. The second file, `index-QljccwTz.js`, is the **undici** HTTP library. It is loaded lazily, and only when an `HTTP(S)_PROXY` environment variable is set, so the app can use undici's `ProxyAgent`.

The application code does these things:

1. Creates a frameless main window (880x520 splash, then resizable), a hidden always-on-top "notice" toast window, and an on-demand "feedback" window.
2. Creates a tray icon with six menu entries.
3. Registers **50 distinct IPC channels** (51 registrations, because `setLanguage` is registered twice) plus the electron-store sync channel.
4. Locates `resources/bin/EvniaServe.exe` and runs it with `--urls http://*:<port>` (default port 10010; free-port probing; process re-use detection through PowerShell and netstat). This only happens when the renderer invokes `startupBackendService`.
5. Refreshes `MonitorInfo.json` from the Zeasn device portal before every backend start.
6. Checks for application updates, downloads them and runs the installer, using `elevate.exe` only when the install directory is not writable.
7. Downloads resource patches, image packs and "cloud user" files.
8. Manages Matter smart-bulb helper processes (`node.exe resources/matter/control.mjs`) over a line-based stdin/stdout JSON protocol.
9. Turns Windows `WM_DISPLAYCHANGE`/`WM_DEVICECHANGE` messages and node-usb hotplug events into debounced `displayChange`/`otherDeviceChange`/`USBChange` renderer events.

**The bundled `usb` module does no device I/O in the main process.** Its only use is `usb.on("attach")` and `usb.on("detach")` with no VID:PID filter and no transfers.

All monitor and peripheral control goes through the .NET backend over SignalR; the main process never touches that path.

Every online touchpoint is listed in the "Online touchpoints" section. All of them can be removed without affecting local monitor control.

Conventions:
- All line numbers refer to `work/app-pretty/main/index.js` unless another file is named.
- **CONFIRMED** means read in the code or seen in the real logs (`%APPDATA%/evnia/logs/*.log`).
- **INFERRED** means a reasoned conclusion that has not been verified directly.
- A hardcoded ZAuth access-key id and HMAC secret, plus a SaaS config block (index.js ~13338-13377), are embedded in the code. They are **deliberately not reproduced** here: an offline port does not need them.

---

## 1. Bundle anatomy

| Lines (index.js) | Content | Notes |
|---|---|---|
| 1-22 | `require`s: electron, path, fs, os, electron-log, child_process, util, crypto, …, **`f = require("usb")`** (l.17), net, node:* | |
| 23-140 | `class E`: logger wrapper around electron-log (date-named files, rotation, retention) | App code |
| 141-7427 | find-up/read-pkg, conf, ajv, semver, `Gl` = electron-store (7404-7427), `Vl` store IPC init (7390-7403) | Library |
| 7428-9040 | debug/ms, get-stream, fd-slicer, yauzl | Library |
| 9033-9113 | extract-zip (`Hd`, `Wd`) | Library; used by app |
| 9114-9145 | md5-file (`Xd`) | Library; used by app |
| 9146-9172 | Enums `Jd` (noticeSound), `Yd` (noticeStyle) and the store schema `Qd` | App |
| 9173-9298 | `class Zd`: feedback and notice windows | App |
| 9299-9300 | `em = "evnia"`, `tm = "1.13.0"` | App |
| 9301-12708 | crypto-js (`Hf`) | Library |
| 12709-12722 | `Wf` (version to int), `qf` (sleep), `Vf` (ZAuth signer) | App |
| 12723-12812 | Tray i18n table `Gf`, `Jf` (set language), `Yf` (translate) | App |
| 12813-12962 | `Qf`: embedded default MonitorInfo (143 models, `Version: 34`) | App data |
| 12963-13283 | `crc` package (crc1/8/16/24/32…) as `_h` | Library |
| 13284-13337 | `Ch` (fetch and hash-verify download), `Nh` (hash verify), `Dh` (getMac) | App |
| 13338-13377 | `Rh` SaaS config (domains, brand/product ids), loggers, event emitter `Ph`/`Ah` | App (values not reproduced) |
| 13378-13470 | `qh` (fetch wrapper, proxy), `Vh` (SaaS GET), `Gh` (portal GET, ZAuth), `tv`, `av`, `iv` (component update query) | App, online |
| 13471-13584 | `ov`: backend service launcher (EvniaServe) | App |
| 13585-16398 | unused-filename, pupa, file-type/mime tables (`Sv`) | Library |
| 16399-16486 | `_v`: electron-dl-style `will-download` handler | Library (adapted) |
| 16487-16578 | `class Cv`: download manager | App |
| 16579-16786 | `class Dv`: software upgrade | App, online |
| 16787-16825 | `Ov()`: resource patch update | App, online |
| 16826-16883 | `class zv` / `Fv`: Node process pool for Matter | App |
| 16884-17080 | `class Uv`: bulb controller IPC | App |
| 17081-17729 | `class Xv`: application (windows, tray, IPC, device-change handling) | App |
| 17730-17748 | Bootstrap (logger config, protocol client, single-instance lock) | App |

`index-QljccwTz.js` (12 350 lines) is the undici bundle. It exports `{ProxyAgent, default}` at l.12349-12350. Its only consumer is `index.js:13389-13396`. **CONFIRMED.**

`work/app/package.json` declares name `evnia`, version `1.13.0`, main `./out/main/index.js`, author "Top Victory Investments Limited", and dependencies `electron-log ^5.1.1` (5.4.4 installed) and `usb ^2.9.0` (**2.18.0** installed in `app.asar.unpacked/node_modules/usb`, with prebuilds for linux-x64/arm64/arm/ia32, win32-*, darwin). The runtime is **Electron 32.3.3 / Chrome 128.0.6613.186** (strings in `Evnia Precision Center.exe`). **CONFIRMED.**

The repo copy of `MonitorInfo.json` at the asar root (`work/app/MonitorInfo.json`) is identical in content to the embedded `Qf` (143 entries, Version 34). The main process never reads the asar copy; it uses `Qf` (see §8). **INFERRED:** the asar copy is a build leftover.

---

## 2. File-system layout used by main

| Path (Windows) | Linux default (Electron) | Purpose | Ref |
|---|---|---|---|
| `%APPDATA%\evnia\` = `app.getPath("userData")` | `~/.config/evnia/` | userData root | 17090 |
| `%APPDATA%\evnia\config.json` | same | electron-store (schema §6) | 9181, 17120 |
| `%APPDATA%\evnia\evnia-first-run` | same | First-run marker (0 bytes; created if absent) | 17127-17136 |
| `%APPDATA%\evnia\MonitorInfo.json` | same | Model capability table (§8); **also read by the .NET backend** | 13476, 17586 |
| `%APPDATA%\evnia\logs\YY-MM-DD.log` | `~/.config/evnia/logs/` | electron-log output (§15) | 30-47, 17730 |
| `%APPDATA%\evnia\patch\RES_PCenter_101300\` | same | Resource patch pack (§12.4) | 16789-16796, 17427 |
| `%APPDATA%\evnia\ImageCache\<model>\` | same | Downloaded device images (§12.5) | 17612-17633 |
| `%APPDATA%\evnia\Cloud User\<userId>\` | same | Cloud-synced user files (§12.6) | 17634-17646 |
| `%APPDATA%\evnia\Matter\node.exe` | same | Downloaded Node runtime for Matter | 16827-16828 |
| `%APPDATA%\evnia\Matter\Controller\` | same | Matter controller storage (`--location`) | 16829 |
| `%TEMP%\evnia-Download\` | `/tmp/evnia-Download` | All downloads (created at startup) | 13285, 16507, 16598, 17091, 17115 |
| `%TEMP%\evnia-debug-open.tmp` | `/tmp/evnia-debug-open.tmp` | **Debug flag**: debug log level, DevTools, `isDebugMode` | 17085, 17731 |
| `<asar>/resources/{favicon,favicon_16x16,tray_*}.png` | same | Tray icons | 17083-17084, 17305-17362 |
| `<install>/resources/bin/EvniaServe.exe` (fallback `<install>/bin/EvniaServe.exe`) | n/a | Backend | 13479-13480 |
| `<install>/resources/elevate.exe` | n/a | UAC helper for the installer only | 16743 |
| `<install>/resources/matter/control.mjs` (dev: `<repo>/matter/control.mjs`) | same | Matter helper script | 16830-16832 |

Real install location on the user's machine: `%LOCALAPPDATA%\Programs\Evnia Precision Center\` (log line "Try start backend service …"). Real userData contents: `config.json, MonitorInfo.json, evnia-first-run, logs/, patch/RES_PCenter_101100/, patch/RES_PCenter_101300/` (both patch dirs empty), plus Chromium caches. `ImageCache`, `Cloud User` and `Matter` do not exist, so those features were never used. `%TEMP%\evnia-Download\` still holds `evnia Setup 1.13.0.exe` (144 233 136 bytes) from the auto-update. **CONFIRMED.**

---

## 3. Application lifecycle

### 3.1 Bootstrap (module top level)
1. `app.commandLine.appendSwitch("disable-features", "WidgetLayering")` (17081).
2. Module-level constants: `Bv` logger "main/app", `Hv` = asar root, `Wv` = asar `resources/`, `qv` = debug flag file, and platform booleans `Vv` (win32), `Gv` (darwin), `Kv` (linux) (17082-17088).
3. `E.configure({level, console})` (17730-17733). Level: `"silly"` when unpackaged; when packaged, `"debug"` if the debug flag exists, otherwise `"info"`. Console logging only when unpackaged.
4. `process.on("uncaughtException")` logs the error (17736-17738).
5. **Custom protocol `EvniaPrecisionCenterApp://`**: when packaged, `setAsDefaultProtocolClient` is called if the app is not already the handler. In dev, it registers with `process.execPath` + argv[1] (17739-17746). It is used for third-party (OAuth) login callbacks (§3.3). On Windows this writes `HKCU\Software\Classes\EvniaPrecisionCenterApp` (Electron behaviour, **INFERRED**).
6. **Single instance:** `app.requestSingleInstanceLock()`. If the lock is held, run `new Xv().run()`; otherwise log "requestSingleInstanceLock return false" and call `app.quit()` (17747).

### 3.2 `Xv` constructor (17114-17146)
- `mkdir %TEMP%/evnia-Download` if missing; `nativeTheme.themeSource = "dark"`; **`Bv.clear()` truncates today's log file on every start** (log 26-09-26 contains a single session); `Gl.initRenderer()` registers the `electron-store-get-data` sync IPC.
- `store = new Gl({schema: Qd, migrations: {}})`. If that throws (schema violation), it falls back to a schemaless store and resets `dashboardPreview` to `{}`.
- `isFirstRun`: true if `userData/evnia-first-run` did not exist (the file is created).
- Language: `store.language` lower-cased; `"zh"` is mapped to `"zh-cn"`. If the value is not in `Kf = [en, zh-cn, zh-tw, ja, ko, ru, es, pt, fr, de]`, it is reset to `"en"`. Then `Jf(lang)` sets the tray labels.
- `lastWinBounds = store.mainWindowBounds`.

### 3.3 `run()` (17147-17206): order on `app.whenReady()`
1. Log `App ready, version 1.13.0`. On win32: `setAppUserModelId("Evnia Precision Center")`.
2. `browser-window-focus` registers **global shortcuts** (17151-17157):
   - `Ctrl+W` and `Ctrl+Shift+I` are swallowed (no-op).
   - `Alt+Shift+M` calls `openDevTool` (only when unpackaged or the debug flag exists).
   - `Ctrl+R` and `Ctrl+Shift+R` call `handleRefresh` (reload only when unpackaged).
   
   `browser-window-blur` calls `globalShortcut.unregisterAll()`.
3. `second-instance` (17159-17172): on win32, takes the **last argv element**. If it is longer than 3 characters, it is parsed as a URL and `Object.fromEntries(url.searchParams)` is sent to the main window as **`thirdPartySuccess`** (OAuth callback). The main window is then shown. The Chinese debug strings "协议1:" and "协议URL无效" mean "protocol 1:" and "protocol URL invalid".
4. `render-process-gone` and `child-process-gone` are logged at error level. The real logs show both at every Windows logoff, with exitCode `1073807364` = `0x40010004`.
5. **`protocol.handle("local", …)`** (17179-17182): for `local:///<path>`, takes the part after `:///`, runs it through `path.normalize` and `decodeURI`, and returns `net.fetch(thatPath)`. The renderer uses this for images from `ImageCache` and for app icons, e.g. `"local:///" + pathJoin(userData,"ImageCache",model,"normal.png")` (renderer `styles-DAnQi2A8.js:33366,33383,42665`). This gives the renderer read access to any local file.
6. `screen` `display-added` / `display-removed` call `setMaximumSize(mainWindow)` once `interfaceInitializeCompleted` is set.
7. `createMainWindow()` (async, not awaited), `childWindows = new Zd()` (creates the hidden notice window immediately), `createTray()`, `new Cv(mainWindow)` (download manager singleton), `ipcEventRegister()`.
8. `softwareUpgrade = new Dv(mainWindow)`, then `startupInit()`, **which performs network calls** (§12.2). If the resulting state is not `RunUpgrade (4)` and the main window is already `ready-to-show`, `start()` runs. In `finally`: `updateCheckDone = true`.
9. `new Uv(mainWindow)`: registers the bulb IPC.

The main window's `ready-to-show` sets `mainWindowReady` and calls `start()` if `updateCheckDone && !appReady` (17224-17228). So **`start()` waits for both the page to load and the update check to finish.** Real log: "Version state …" appears within 60-400 ms.

### 3.4 `start()` (17257-17282)
- `appReady = true`. If `--openAsHidden` is **absent**: `setPosition(lastWinBounds.x, y)`, then `center()` (which overrides the position), then `show()`.
- Reads `autoStartup` and `autoStartupMinimize` and calls `setAutoStartUp()` (re-applies the login item every start).
- Sends `newVersionPrompt {state, versionNum, packageUrl, description}` to the renderer when `state == AfterInstall(5)`, or when `automaticUpdate == false` and `state ∈ {WithNewCache(1), WithoutNewCache(2)}`.
- Calls **`Ov()`**, the resource-patch check (online; §12.4).

Backend startup is **not** started by main. The renderer's Startup view calls `ipc.invoke("startupBackendService")` (renderer `main-CDosWiM3.js:170-183`), then connects SignalR to `http://localhost:<port>/EvniaHub` (WebSockets, skipNegotiation, 120 s timeout; `styles-DAnQi2A8.js:7902`). After `systemInit`/`getDeviceList`/`getMonitorJsonConfig` it sends `interfaceInitializeCompleted` (main-CDosWiM3.js:185-200). On SignalR `ON_RECONNECTING` the renderer waits 3 s and calls `startupBackendService` again (main-CDosWiM3.js:177-178). **That is the only health/retry mechanism.**

### 3.5 Hide/show/exit
- Main window `close` calls `preventDefault()` and `hideMainWindow()` (`hide()` + `setSkipTaskbar(true)`) (17229-17231). Closing only hides to tray.
- Main window `closed` calls `app.exit()` (17232-17234).
- `showMainWindow(focus=true)` (17283-17297):
  - `setAlwaysOnTop(true)`.
  - If minimized, `restore()`. Otherwise, if not visible: send `toPageView "overview"` (when the tray options are enabled), `maximize()` if `nextMaximized`, then `show()` and `setSkipTaskbar(false)`.
  - `setAlwaysOnTop(false)`, send `mainWindowShow`, then `focus()`.
- `exitApp()` (17370-17396), called only from tray Exit:
  - Persist `mainWindowBounds {x,y,width,height,maximized}`, hide, **delete the debug flag file**, destroy the tray.
  - **Kill every process whose name contains `DtsServer`.** It runs `tasklist` (win32) or `ps aux` and splits each line into `[name, pid]`. On Linux `ps aux` puts USER first, so this parse is broken there.
  - Then `app.exit()`, with a hard `app.exit()` fallback after 1000 ms.
  - **EvniaServe.exe is never killed** (it is re-used on the next start; §7). Matter node processes are not explicitly killed either.
- Installer path: `packageInstall` hides the window and calls `app.exit()` after 2000 ms (16756-16757).

### 3.6 Command-line flags consumed

| Flag | Where | Effect |
|---|---|---|
| `--openAsHidden` | 17261-17262, 17460, 13485 | Do not show the window at start. The backend start is delayed **10 s** (`qf(1e4)`). Window sizing is deferred through `nextMaximized`. Passed by the login item when `autoStartupMinimize`. Note: `ov.run` checks `indexOf(...) > 0`, the others check `< 0`. |
| `EvniaPrecisionCenterApp://…?…` (last argv) | 17160-17169 | Second-instance OAuth callback, forwarded as `thirdPartySuccess` |
| `ELECTRON_RENDERER_URL` env | 9217, 9250, 17249 | Dev server URL (dev only) |
| `HTTPS_PROXY`/`HTTP_PROXY`/`https_proxy`/`http_proxy` env | 13381-13396 | Use undici ProxyAgent **and set `NODE_TLS_REJECT_UNAUTHORIZED=0`** |

---

## 4. Windows (BrowserWindows)

| Window | Created | Options | Content | Ref |
|---|---|---|---|---|
| **Main** | `createMainWindow()` at ready | 880x520, min=max=880x520, `resizable:false`, `maximizable:false`, `frame:false`, `hasShadow:false`, `show:false`, `skipTaskbar:false`; webPreferences `{preload: out/preload/index.js, sandbox:false, nodeIntegration:true}` (contextIsolation left at the Electron 32 default, `true`); `setMenuBarVisibility(false)` | `out/renderer/index.html` (or `ELECTRON_RENDERER_URL`). Opens DevTools if the debug flag exists. | 17207-17256 |
| **Feedback** | Lazily, on `openFeedbackWindow` or the tray "Feedback" item | 952x734, `frame:false`, `resizable:false`, `fullscreen:false`, `show:false`; `{preload, sandbox:false, nodeIntegration:true}` | `out/renderer/feedback/feedback.html`. On `closed` the reference is nulled. `closeFeedbackWindow` only hides it. | 9183-9222 |
| **Notice** (toast) | Eagerly, in the `Zd` constructor | Bounds from `calcNoticeWindowBounds()`; `frame:false`, `resizable:false`, `skipTaskbar:true`, `alwaysOnTop:true`, `show:false`; `{preload, nodeIntegration:true, contextIsolation:false}` | `out/renderer/notice/notice.html` | 9223-9255 |

Main-window behaviour details:
- `setWindowOpenHandler`: every `window.open` or `target=_blank` URL goes to `shell.openExternal(url)` and is denied in-app (17243). This is online and should be stripped.
- `before-input-event`: `Ctrl/Meta` + `=`, `-` or `0` sets `setIgnoreMenuShortcuts(true)`, which blocks zoom. It is never reset (17244-17248).
- Two Windows message hooks: `hookWindowMessage(126 /*WM_DISPLAYCHANGE 0x007E*/)` and `hookWindowMessage(537 /*WM_DEVICECHANGE 0x0219*/)` (17235-17236). See §9.
- `interfaceInitializeCompleted` IPC (17445-17472):
  1. Set `interfaceInitializeCompleted = true` and `trayFunctionDisabled = false`, then `refreshTray()`.
  2. `setMaximizable(true)`, `setResizable(true)`, `setMinimumSize(1280,720)`, `setMaximumSize(<largest workArea over all displays>)`.
  3. Target size: `lastWinBounds.{width,height}` if saved. Otherwise 1920x1080 when the nearest display's workArea width is at least 1920, else 1280x720.
  4. If not `--openAsHidden`: `minimize()`, then after **300 ms** `show()`, `setSize(w,h,true)`, then `maximize()` if first run or saved-maximized, otherwise `center()`.
  5. If `--openAsHidden`: `setSize`, `center`, and `nextMaximized = lastWinBounds.maximized`.
  
  Real log: "setMaximumSize 3440 1392", "Set main window size 1920x1080".
- `resetToStartSize` (only after `interfaceInitializeCompleted`): unmaximize, fixed 880x520, center (17435-17444).

Notice window geometry (9223-9229):

```
factor = primaryDisplay.workAreaSize.width * scaleFactor / 1920
w = round(240*factor), h = round(120*factor)
x = workAreaSize.width - w - 3, y = workAreaSize.height - h - 3
```

`workArea.x/y` offsets are ignored, so the formula is wrong when the taskbar is on the left or top (**INFERRED**). On `screen display-metrics-changed`, if the notice window is visible it is hidden, and after **2000 ms** the bounds are recalculated and it is re-shown (9288-9295).

`notice` IPC logic (9266-9283), args `(show:boolean, key:string, ...args)`:
- If `show && store.noticeSwitch`:
  1. If `noticeSound == 0 (SystemSound)`, call `shell.beep()`.
  2. Send `setNotice(key, ...args)` to the notice window.
  3. Clear the pending hide timer.
  4. If `noticeStyle == 2 (No)`, stop here (the window is not shown).
  5. If `noticeStyle == 1 (Short)`, schedule a hide after **5000 ms**.
  6. `showNoticeWindow()`, which is `show()` + `setBounds(noticeWindowBounds)`.
- Otherwise, hide the notice window.

Enums (9146-9149): `noticeSound {SystemSound:0, NoSound:1}`, `noticeStyle {Persistent:0, Short:1, No:2}`.

---

## 5. Tray

Created in `createTray()` (17304-17309):
- Icon `<asar>/resources/favicon.png`, tooltip `"Precision Center"`.
- `click` calls `showMainWindow()`.
- The context menu is rebuilt by `refreshTray()` (`closeContextMenu` + `setContextMenu`) and on `setLanguage`.

| # | Label (en; key in `Gf`) | Icon | Enabled when | Action |
|---|---|---|---|---|
| 1 | "Precision Center" (not translated) | favicon_16x16.png | always | If packaged and debug flag exists: `openDevTool()`. Otherwise `showMainWindow()` |
| 2 | Rescan (`Rescan`) | tray_rescan.png | `isTrayOptionEnable()` | `showMainWindow()`; if `appReady`, send `rescan` |
| 3 | Check for Updates (`CheckUpdates`) | tray_refresh.png | `isTrayOptionEnable()` | `showMainWindow()`; send `checkSoftwareUpgrade` (the renderer then sends `checkSoftwareVersion`), **online** |
| 4 | Feedback (`Feedback`) | tray_feedback.png | always | `childWindows.showFeedbackWindow()`, **online** feature |
| 5 | Settings (`Settings`) | tray_setting.png | `isTrayOptionEnable()` | `showMainWindow()`; send `toPageView "setting"` |
| 6 | Exit (`Exit`) | tray_close.png | `isTrayOptionEnable(true)` | `exitApp()` |

- `isTrayOptionEnable(exitOnly)` (17367-17369): for Exit, returns `!trayExitDisabled`. For the others, returns `appReady && !trayExitDisabled && !trayFunctionDisabled`. `trayFunctionDisabled` starts as **true** and becomes false on `interfaceInitializeCompleted`. The renderer toggles both flags through `disableTrayExit`/`disableTrayFunction`, e.g. during firmware flashing.
- A `Login` string exists in `Gf` but no Login menu item is built in 1.13.0.
- Translations exist for en, zh-cn, zh-tw, ja, ko, ru, es, pt, fr, de (12723-12804).

---

## 6. Persisted settings (electron-store `config.json`)

The schema is `Qd` (9150-9172). The preload creates a second electron-store instance with the same schema and exposes it as `window.store` (preload `index.js:7352-7373`), so **the renderer reads and writes these keys directly**. `electron-store-get-data` is a sync IPC channel that returns `{defaultCwd: userData, appVersion}` (7390-7403).

| Key | Type | Default | Used by main |
|---|---|---|---|
| language | string | "en" | tray language, clientUpg `langCode` |
| dashboardPreview | object | {} | reset on store error |
| dashboardPreviewEnable | boolean | true | – |
| dashboardLocation | number | – | – |
| autoStartup | boolean | **true** | login item |
| autoStartupMinimize | boolean | **true** | `--openAsHidden` arg |
| noticeSwitch | boolean | false | notice window |
| noticeSound | number | 0 | notice beep |
| noticeStyle | number | 0 | notice style |
| autoUpdate | boolean | true | auto-install at startup (**online**) |
| latestSoftwareInfo | object | – | set before auto-install; its presence at next start means "AfterInstall" |
| ignoreVersion | string | – | skip-version logic |
| automaticUpdate | boolean | true | auto check/download at startup (**online**) |
| tutorials | object | – | – |
| userInfo | object | – | cloud account; `userInfo.id` names the Cloud User dir (**online**) |
| email | string | – | cloud login (renderer; **sensitive**) |
| password | string | – | cloud login (renderer; **sensitive**, plain JSON unless the renderer encrypts it: cross-ref) |
| skipLoginState | boolean | – | – |
| mainWindowBounds | object | – | `{x,y,width,height,maximized}` |
| overviewType | string | "category" | – |
| ambiScapeEnable | boolean | false | – |

The user's real `config.json` contains exactly these non-secret values: `language:"en"`, `languageTemp:"en"` (not in the schema; written by the renderer), `autoStartup:true`, `autoStartupMinimize:true`, `noticeSwitch:false`, `noticeSound:0`, `noticeStyle:0`, `autoUpdate:true`, `automaticUpdate:true`, `overviewType:"category"`, `ambiScapeEnable:false`, `tutorials:{DeviceOverview,MonitorView,Dashboard:true}`, `skipLoginState:true`, `mainWindowBounds:{x:760,y:156,width:1920,height:1080,maximized:false}`, `__internal__.migrations.version:"1.13.0"`. **CONFIRMED** (secret keys were not inspected).

---

## 7. Backend service (EvniaServe.exe): locate, spawn, port, health

The singleton `ov` is defined at 13471-13584. It is invoked only by the IPC `startupBackendService` (17431-17434), which returns the port number.

| Field | Value |
|---|---|
| `port` | `10010` (initial) |
| `exeName` | `"EvniaServe.exe"` |
| `exePath` | `join(dirname(__dirname), "..", "bin", exeName)`. `__dirname` is `…/resources/app.asar/out/main`, which gives `…/resources/app.asar/../bin`, i.e. **`resources/bin/EvniaServe.exe`**. If missing, the fallback is `…/out/../../bin/EvniaServe.exe` (13479-13480). |
| `monitorInfoPath` | `userData/MonitorInfo.json` |

`run()` (13482-13507):
1. `await verifyMonitorInfoJson()`, an **online** MonitorInfo refresh (§8). It always resolves, including on error. Offline it costs about 3 s (real log: "Fetch MonitorInfo TypeError: fetch failed" 2.9 s after start).
2. If `--openAsHidden` is present, `await sleep(10000)` ("Backend service waiting 10 sec").
3. **Is it already running?** Uses `child_process.exec` to run:
   `powershell -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '<exePath>' } | Select-Object ProcessId"`
   - On exec error: `startServe(port)`.
   - If the stdout has a number (`/\d+/`), that number is the PID. Then run (cmd syntax)
     `for /f "tokens=2 delims= " %a in ('netstat -ano ^| findstr <PID>') do @echo %a`.
     Take stdout, `trim()`, `split(":").at(-1)` (the port from the **last** netstat line's local address), and resolve `Number(port)`. If the output is empty, call `startServe`.
   - Otherwise ("Program is not running") call `startServe(this.port)`.
4. `startServe(port, resolve)` (13557-13572):
   - `retryCnt < 3` is always true, because **`retryCnt` is reset to 0 and never incremented**. The `-1` branch is dead code.
   - `getFreePort(port)`, then `execFile(exePath, ["--urls", "http://*:<port>"], cb)`. The callback only fires when the process exits and logs "Start serve error". Then `this.port = port` and resolve **immediately**, without waiting for the backend to listen.
5. `getFreePort(p)` (13573-13583): `net.createServer().listen(p)` with no host (all interfaces). On `listening`, close and return `p`. On `error`, recurse with `p+1` until 65535, then reject "Port exhausted" (logged; the promise from `run()` then never resolves).

Observations:
- The backend is started **not detached**, with default `execFile` options (1 MiB `maxBuffer`, stdio piped).
- It survives app exit because nothing kills it. Real logs show "Start serve error … Command failed: …EvniaServe.exe --urls http://*:10010" only at Windows logoff, when both processes are killed with 0x40010004. **CONFIRMED.**
- **Port mismatch risk:** EvniaServe `Program.cs:37` hardcodes `webBuilder.UseUrls("http://*:10010/")`. In ASP.NET Core 3.1 generic hosting, a `UseUrls` call in code overrides the `--urls` command-line value. So if 10010 is busy, main would report 10011 while the backend still tries 10010. **INFERRED**; see Open questions.
- `--urls http://*:<port>` means the SignalR hub **listens on all network interfaces** (LAN-exposed, and the hub has no authentication; cross-ref backend reports).
- Real sequence from the logs (CONFIRMED):
  1. "Backend service run"
  2. "Program is not running"
  3. "Port 10010 is availiable."
  4. "Try start backend service …\resources\bin\EvniaServe.exe on 10010"
  5. "Backend startup completed" (about 30 ms later)
- `elevate.exe` is **not** used for EvniaServe. The backend runs as the normal user.

---

## 8. MonitorInfo.json handling

### 8.1 Seeding and version (`getLocalMonitorInfoVersion`, 13546-13556)
- If `userData/MonitorInfo.json` exists and parses, and `.Version >= Qf.Version (34)`, return `String(Version)`.
- Otherwise **asynchronously write the embedded `Qf` JSON** (compact) to that path and return `"34"`.

### 8.2 Online refresh (`verifyMonitorInfoJson`, 13508-13545), called on every `startupBackendService`
1. `iv({deviceType:"PhilipsMonitorsOTA", componentId:"PrecisionCenter_Monitors_OTA_JSON", version:<local>}, false, mac)`, which is a device-portal `GET /component/update` (§13).
2. If the result array is non-empty, take `[0].{url, hashMethod, hashValue, version}`. Then `Ch(url, {hashMethod, hashValue})` downloads it to `%TEMP%/evnia-Download/<basename(url)>` and verifies the hash.
3. Parse the file, set `.Version = version`, rewrite it, then `fs.promises.rename(tmp, userData/MonitorInfo.json)`. The rename is not awaited, and the `qf(1000)` is not awaited either.
4. Real log (09-25): `Verify crc32, path: …\evnia-Download\PCenter_MonitorInfo_v34.json efb1d971 efb1d971`, so the server uses **crc32**. **CONFIRMED.**

### 8.3 `getMonitorJsonConfig` IPC (17584-17605)
The result is cached in `this.monitorConfig` for the life of the process, and is `undefined` on a parse error.

```
{ Monitors = [], LimitVer_PCenter = [] } = JSON.parse(userData/MonitorInfo.json)
OTAEnable = !LimitVer_PCenter.includes(-1) && !LimitVer_PCenter.includes(Wf("1.13.0") /*101300*/)
config    = Monitors.reduce((acc, m) => {
              key = m.Name.trim().slice(m.Name.startsWith("PHL") ? 3 : 0).split(/[\s+|_]/).at(-1) || "";
              if (key) acc[key] = m;   // later entries overwrite earlier ones
              return acc; }, {})
return { OTAEnable, config }
```

- Entry shape: `{Name, SupUsbDDC:bool, SupOTA:bool, SupLightEffect:bool, SupLightSync:bool, HDR:int}`. Top level: `{EdidToFactory:null, Monitors:[…], Notes, Version:34}`. There is no `LimitVer_PCenter` in the v34 file, so **OTAEnable = true**.
- For the user's model, both `"34M2C8600"` and `"PHL 34M2C8600"` map to key **`34M2C8600`** = `{SupUsbDDC:true, SupOTA:true, SupLightEffect:true, SupLightSync:true, HDR:400}` (12953, 12958; also in the user's `%APPDATA%\evnia\MonitorInfo.json`). **CONFIRMED.**
- The renderer stores this as `OTAEnable` / `configInJson` (renderer `main-CDosWiM3.js:199-200`).
- The backend also reads `%APPDATA%\evnia\MonitorInfo.json` directly (cross-ref `Zeasn.Equipment.Option.Lib/.../PHLDisplayFW.cs:112`, `Zeasn.PCenter.Base.Lib/.../DictMgr.cs:23`).

`Wf(version)` (12709-12712): lower-case the version, strip `v`, and split on `.`. The first field is kept as is, middle fields are padded to 3 digits, and the last field to 2 digits; the result is joined and converted to a Number. So `1.13.0` becomes **101300** and `1.11.0` becomes 101100.

---

## 9. Device-change detection (and the `usb` module)

**Every use of the `usb` module in main** (CONFIRMED by grepping all references; `f` is used only at 17237-17241):

| Line | Call | VID:PID filter | Transfers |
|---|---|---|---|
| 17 | `f = require("usb")` | – | – |
| 17237-17239 | `f.usb.on("attach", () => handleDeviceChange("USBChange"))` | **none** (any device) | none |
| 17240-17242 | `f.usb.on("detach", () => handleDeviceChange("USBChange"))` | **none** | none |

There is no `getDeviceList`, `findByIds`, `controlTransfer` or interface claim in main. (`ruleUSBHubCount` at 13454 is only a string parameter of the cloud query.) All USB/HID/DDC traffic lives in the .NET backend and native DLLs.

Event sources:

| Source | Event name | Ref |
|---|---|---|
| `hookWindowMessage(126)` = WM_DISPLAYCHANGE | `displayChange` | 17235 |
| `hookWindowMessage(537)` = WM_DEVICECHANGE | `otherDeviceChange` | 17236 |
| node-usb attach/detach | `USBChange` | 17237-17242 |

`handleDeviceChange(name)` (17662-17683), timings CONFIRMED:
- If `shieldState[name]` is set: log and drop.
- `displayChange`: **trailing debounce 2000 ms**. Each event restarts the timer. When it fires, if `shieldState.displayChange` is set, drop; otherwise `webContents.send("displayChange")`.
- `USBChange` / `otherDeviceChange`: if `eventLockedState[name]` is set, drop. Otherwise lock, send after **1000 ms** (USBChange) or **1700 ms** (otherDeviceChange) unless shielded at that moment, and unlock after **2000 ms**. This is a leading-edge throttle with a delayed send.
- Shields (renderer-controlled, used during mode changes and firmware updates):
  - `shieldDisplayChange(flag, seconds=4)` (17650-17657) clears any pending shield timer. If `flag || !seconds`, it sets `shieldState.displayChange = flag`. Otherwise (flag false, seconds > 0) it clears the shield after `seconds*1000` ms.
  - `shieldPeripheralChange(flag)` sets both `shieldState.USBChange` and `shieldState.otherDeviceChange` to `flag` (17658-17660).

Real logs show the pattern "USB detach, then +1.0 s USBChange send, then +0.7 s otherDeviceChange send", plus lone "otherDeviceChange send" (monitor power/input changes). **CONFIRMED.**

---

## 10. IPC reference

The preload (`work/app-pretty/preload/index.js:7325-7377`) exposes a **generic** `window.ipc = {send, invoke, on, once, removeAllListeners, listeners}` with **no channel allowlist**, plus `window.nodeApi` (fs helpers) and `window.store`. All main-side channels follow.

Legend for the "Linux" column:
- **Keep**: port as is.
- **Adapt**: Linux-specific change needed.
- **Strip**: online or Windows-only; remove, or stub the return value shown.

### 10.1 Renderer → main channels

| # | Channel | Kind | Args (renderer order) | Behaviour | Return / side effect | Ref | Linux |
|---|---|---|---|---|---|---|---|
| 1 | `getRunConfig` | handle | – | Static runtime info | `{appVersion:"1.13.0", isDebugMode:exists(%TEMP%/evnia-debug-open.tmp), isFirstRun, isPackaged, mac:getMac(), patchPath:userData/patch/RES_PCenter_101300, processPath:argv[0], userDataPath}` | 17421-17430 | Keep; `mac` → `""` (only used for cloud) |
| 2 | `startupBackendService` | handle | – | `ov.run()` (§7) | `port:number` (or -1, never in practice) | 17431-17434 | **Adapt**: spawn the Linux backend on 127.0.0.1, wait for readiness, no MonitorInfo fetch |
| 3 | `resetToStartSize` | on | – | Back to 880x520 fixed (only after init) | – | 17435-17444 | Keep |
| 4 | `interfaceInitializeCompleted` | on | – | Enable tray, resize/maximize logic (§4) | – | 17445-17472 | Keep |
| 5 | `minimize` | on | `useMain=false` | Minimizes **mainWindow** if (`useMain ? mainWindow : focusedWindow`) exists | – | 17473-17475 | Keep |
| 6 | `maximizedValue` | handle | `useMain=false` | – | `boolean` isMaximized | 17476-17479 | Keep |
| 7 | `maximizeToggler` | handle | `useMain=false` | Exit fullscreen, toggle maximize | `boolean` new isMaximized | 17480-17486 | Keep |
| 8 | `close` | on | `useMain=false` | `hide()` + `setSkipTaskbar(true)` (hide to tray) | – | 17487-17490 | Keep |
| 9 | `fileSelect` | handle | `OpenDialogOptions` | `dialog.showOpenDialog(senderWindow, opts)` | `{path, size, buffer:Buffer(whole file)}`; cancel returns `{path:"",size:0,buffer:null}`; error returns `{path:"",size:0}` | 17491-17512 | Keep |
| 10 | `getFileSize` | handle | `path` | `fs.statSync(path).size` (throws if missing) | number | 17513 | Keep |
| 11 | `exportFile` | handle | `{title, defaultPath, filters}` | `dialog.showSaveDialog(mainWindow, opts)` | `{canceled, filePath}` | 17514 | Keep |
| 12 | `runCommand` | handle | `cmd:string` | `child_process.exec(cmd)` (cmd.exe on Windows) | `{error:{message,name,stack,code,killed}\|null, stdout}` | 17515-17532 | **Strip** (arbitrary RCE surface; all known callers run Windows .exe installers or updaters; see Cross-refs) |
| 13 | `getMac` | handle | – | `Dh()`: first MAC in `os.networkInterfaces()` not matching `/(?:[0]{1,2}[:-]){5}[0]{1,2}/` (i.e. not all-zero), cached | `"aa:bb:…"` or `""` | 17533, 13321-13337 | **Strip** (return `""`; only used as cloud device id) |
| 14 | `extractZip` | handle | `zipPath, destDir=""` | `destDir ||= dirname(zip)/basename(zip,".zip")`; `rm -rf destDir`; extract-zip | `destDir` or `""` on error | 17534-17554 | Keep (local zips only) or Strip with firmware/Matter download |
| 15 | `findExe` | handle | `dir, ext="exe"` | Depth-first search. **Bug:** it descends into the *first* subdirectory it meets (readdir order) and returns that subtree's result, even if empty, without checking siblings. Returns the first file ending in `"."+ext`. | path or `""` | 17407-17420, 17555 | Strip (Windows `.exe` updaters) |
| 16 | `setWindowSize` | on | `w, h` | `setSize`, `center`, persist bounds | – | 17556-17565 | Keep |
| 17 | `setLanguage` | on | `lang` | (a) `Xv`: tray labels; (b) `Zd`: forward `setLanguage` to the feedback and notice windows | – | 17566-17568, 9284-9287 | Keep |
| 18 | `setAutoStartUp` | on | `autoStartup?:bool, minimize?:bool` | Persist; `app.setLoginItemSettings({openAtLogin, args:[minimize?"--openAsHidden":""]})` (packaged only) | – | 17569-17571, 17397-17405 | **Adapt**: XDG autostart `.desktop` |
| 19 | `getFileMd5` | handle | `path` | md5-file sync | hex string or `""` | 17572 | Keep |
| 20 | `getSystemInfo` | handle | – | – | `{tmpDir, appDataDir: process.env.AppDATA, computerName: hostname, osType, osPlatform, arch, release, uptime, totalmem:"<GB, 1 decimal>G"}` | 17573-17583 | Adapt (`appDataDir` → `app.getPath("appData")`); only the feedback window uses it, so it can be stripped |
| 21 | `getMonitorJsonConfig` | handle | – | §8.3 | `{OTAEnable, config}` | 17584-17605 | Keep (read bundled or local file) |
| 22 | `disableTrayExit` | on | `bool` | Set `trayExitDisabled`, refresh tray | – | 17606-17608 | Keep |
| 23 | `disableTrayFunction` | on | `bool` | Set `trayFunctionDisabled`, refresh tray | – | 17609-17611 | Keep |
| 24 | `imageResourceDownload` | handle | `{model, fileName, url, hashValue}` | `mkdir userData/ImageCache`; `fileDownload(%TEMP%/evnia-Download/<fileName>, url, md5)`; extract to `userData/ImageCache/<model>`; delete the zip | dir path; `""` on extract error; **on download error it resolves with the error string** (`.catch(resolve)`) | 17612-17633 | **Strip** (return `""`; ship images locally) |
| 25 | `getCloudFileCacheOrDownload` | handle | `fileName, md5, url` | Requires `store.userInfo.id` (else `""`). Uses the cache at `userData/Cloud User/<id>/<fileName>` if its md5 matches, otherwise fetches and verifies. | path or `""` | 17634-17646 | **Strip** (return `""`) |
| 26 | `openDefaultBrowser` | on | `url` | win32: `exec("start " + url)` (**shell-injection prone**); darwin: `exec("open "+url)`; linux: `exec("xdg-open"+url)` (**bug: no space**) | – | 17647-17649 | Strip, or replace with an allowlisted `shell.openExternal` |
| 27 | `shieldDisplayChange` | on | `flag:bool, seconds=4` | §9 | – | 17650-17657 | Keep |
| 28 | `shieldPeripheralChange` | on | `flag:bool` | §9 | – | 17658-17660 | Keep |
| 29 | `closeFeedbackWindow` | on | – | Hide feedback window | – | 9260-9262 | Strip |
| 30 | `openFeedbackWindow` | on | – | Show or create feedback window | – | 9263-9265 | Strip |
| 31 | `notice` | on | `show:bool, key:string, ...args` | §4 notice logic | sends `setNotice` | 9266-9283 | Keep |
| 32 | `createDownload` | on | `url, hashValue, hashMethod="md5", destPath=""` | `Cv.create` (§12.1) | events `downloadProgressUpdate` / `downloadSuccess` / `downloadFail` | 16513-16515 | **Strip** (online) |
| 33 | `cancelDownload` | on | `url` | Cancel the task; unlink the partial file after 1000 ms | – | 16516-16518 | Strip |
| 34 | `checkSoftwareVersion` | on | – | `Dv.manualCheck()` | event `versionCheckResult` | 16606-16608 | **Strip** (reply `versionCheckResult {state:0}` or remove the UI) |
| 35 | `softwareDownload` | on | – | `Dv.packageDownload()` | download events | 16609 | Strip |
| 36 | `softwareInstall` | on | `packagePath?` | `Dv.packageInstall(path)`: spawn installer, exit app | – | 16610 | Strip |
| 37 | `cancelSoftwareUpgrade` | on | – | `Dv.cancel()` | – | 16611 | Strip |
| 38 | `checkNodeAvailable` | handle | – | – | `{available: exists(userData/Matter/node.exe), extractPath: userData/Matter}` | 17005 | Adapt (system `node`) or Strip (Matter) |
| 39 | `getCurrentProcess` | handle | – | – | `"Process pool size N, <keys>"` | 17006 | Strip/Keep with Matter |
| 40 | `discoverBulb` | handle | `code, isQrCode:bool` | §14 | Init object | 17007 | Strip/Adapt |
| 41 | `pairingBulb` | handle | `code, isQrCode, wifiSsid, wifiCredentials, uniqueId` | §14 | Init object | 17008 | Strip/Adapt |
| 42 | `commissionBulb` | handle | `uniqueId` | §14 (starts the long-lived controller) | Init object | 17009 | Strip/Adapt |
| 43 | `openCommissioningWindow` | handle | `uniqueId, timeout` | request `openCommissioningWindow {commissioningTimeout}` | data | 17010-17012 | Strip/Adapt |
| 44 | `identifyBulb` | handle | `uniqueId, endpointId, identifyTime=2` | request `identify {endpointId, identifyTime}` | data | 17013-17015 | Strip/Adapt |
| 45 | `getBulbAttribute` | handle | `uniqueId, endpointId, attributeName` | request `getAttribute` | data | 17016-17018 | Strip/Adapt |
| 46 | `setBulbAttribute` | handle | `uniqueId, endpointId, attributeName, value, transitionTime=0` | request `setAttribute` | `{success:true,data}` or `{success:false,error}` | 17019-17033 | Strip/Adapt |
| 47 | `removeBulb` | handle | `uniqueId` | request `remove` | data | 17034 | Strip/Adapt |
| 48 | `destroyBulbProcess` | handle | `uniqueId` | `kill()`; if that returns false: `taskkill /PID <pid> /T /F` | bool | 17035, 16869-16881 | Adapt (process group kill) |
| 49 | `clearCache` | handle | `mode:"All"\|"NotExist"\|other, uniqueIds:string[]` | If `Controller` dir is missing, return false. `"All"`: `rm -rf userData/Matter/Controller`. `"NotExist"`: keep `<id>_controller` dirs for the given ids, plus the uniqueid string read from `<id>_controller/data.uniqueid` (quotes stripped), and delete every other entry. Other: request `clearStorage` to `uniqueIds[0]`. | varies | 17036-17054 | Strip/Adapt |
| 50 | `electron-store-get-data` | on (sync) | – | Used by the preload's electron-store | `returnValue = {defaultCwd: userData, appVersion}` | 7395-7400 | Keep |

`setLanguage` is registered by both `Zd` and `Xv`, giving 51 registrations for 50 names. Every name is referenced by the renderer bundles (grep of the quoted channel names in `renderer/assets/*.js`), with two exceptions: `electron-store-get-data`, which only the preload uses, and **`getCurrentProcess`, which nothing references** (a debug leftover). **CONFIRMED.**

### 10.2 Main → renderer events (`webContents.send`)

| Event | Target | Payload | Emitted by | Ref |
|---|---|---|---|---|
| `displayChange` | main | – | §9 | 17670 |
| `otherDeviceChange` | main | – | §9 | 17678 |
| `USBChange` | main | – | §9 | 17678 |
| `rescan` | main | – | tray Rescan | 17329 |
| `checkSoftwareUpgrade` | main | – | tray Check for Updates | 17338 |
| `toPageView` | main | `"setting"` \| `"overview"` | tray Settings / `showMainWindow` | 17290, 17355 |
| `mainWindowShow` | main | – | `showMainWindow` | 17295 |
| `thirdPartySuccess` | main | `{…URL query params}` (has `type` = ISLOGIN/ISASS) | second-instance protocol URL | 17166 |
| `newVersionPrompt` | main | `{state, versionNum, packageUrl, description:string[]}` | `start()` | 17274-17279 |
| `versionCheckResult` | main | `{state, isStartup:false, versionNum, packageUrl, description}` | `manualCheck` | 16639-16645 |
| `downloadProgressUpdate` | main | `{url, percent, transferredBytes, totalBytes}` (cached file: `{url, percent:1}`) | `Cv` | 16530, 16550 |
| `downloadSuccess` | main | `{fileName, filename, path, fileSize, mimeType, url}` (cached: `{url, path, filename}`) | `Cv` | 16531, 16555 |
| `downloadFail` | main | `{url, msg:"hash check error"}` | `Cv` | 16556 |
| `matterNotification` | main | `{uniqueId, endpointId, type, data}` | Matter stdout `[Notification]` | 16911, 16962 |
| `setNotice` | notice | `(key, ...args)` | `notice` IPC | 9272 |
| `setLanguage` | feedback, notice | `lang` | `setLanguage` IPC | 9285-9286 |

The renderer also listens for `loginShow` (renderer `styles-DAnQi2A8.js:14232`), which main 1.13.0 **never sends** (dead code).

---

## 11. Other handler details

- **`runCommand`**: arbitrary `exec` with the default shell (`cmd.exe` on Windows). Known renderer uses (cross-ref, CONFIRMED):
  1. Peripheral firmware updaters: `"<findExe(extractedDir)>" 1`, or `-MSRY6608` for SPK9618 ext 3395. Expected result code 0 or 255, parsed from stdout with `/.*code:\s+(.*),.*/`. Up to 2 retries, 2 s apart (`styles-DAnQi2A8.js:33887-33911, 34036-34041`).
  2. DTS audio server installer: `"<exe>" /targetDir "%APPDATA%\G-MenuDTSServe"` (`Setup-daShw_PC.js:124`).
  3. SmartDesktop installer: `<exe> /targetDir "%APPDATA%\SmartControl\Modules\SmartDesktop"` (`SmartDesktop-By8ZEPkl.js:121`).
  
  None of these apply to a 34M2C8600-only Linux setup.
- **Zip extraction** (`Wd`/`Hd`, 9041-9113): extract-zip semantics:
  - The target must be absolute; it is `mkdir -p`ed and `realpath`ed.
  - Entries under `__MACOSX/` are skipped.
  - Zip-slip is rejected (`Out of bound path`).
  - Symlinks are recreated.
  - Mode comes from `externalFileAttributes>>16`; the defaults are dir 0755 and file 0644.
- **`fileDownload(dest, url, md5)`** (17702-17728): uses the global `fetch(url)` (Node/undici, no proxy agent). It writes the whole buffer to `dest`, computes md5 (one retry after 2 s if md5-file throws), and compares case-insensitively. On success it resolves `dest`; otherwise it rejects with `"hash mismatch"` or `"Download file error: <msg>"`.
- **`Ch(url, {hashMethod, hashValue, name?, size?})`** (13286-13304): the same pattern, but the destination is `%TEMP%/evnia-Download/<name || last URL segment>` and the check is done by `Nh`.
- **`Nh(path, method, value, size?)`** (13305-13320):
  - `crc32`: compares `crc32(file).toString(16)`.
  - `md5`: compares md5-file.
  - Any other method: logs "Verify skip", compares `size` if given, and **otherwise returns true** (no verification).

---

## 12. Downloads, software upgrade, patches, images, cloud cache (all online)

### 12.1 Download manager `Cv` (16487-16578)
- Singleton keyed by window. The directory is `%TEMP%/evnia-Download`.
- `create(url, hashValue, hashMethod="md5", destPath="")`:
  1. Destination: `destPath` if given, else `evnia-Download/decodeURI(basename(url))`.
  2. If a task for the URL exists, it warns ("Already a task in progress") but **does not return** (bug).
  3. If the destination already verifies (`Nh`), it immediately emits a progress of 1 and `downloadSuccess`. Otherwise it deletes the stale file.
  4. It registers a one-shot `session.on("will-download")` handler (`_v`, electron-dl-like: sets the save path, `setProgressBar`, and `app.badgeCount` on linux/darwin), then calls `webContents.downloadURL(url)`.
  5. On completion it re-verifies. Success emits `downloadSuccess` and resolves. Failure emits `downloadFail` ("hash check error") and **never resolves** (bug).
- `cancel(url)`: `item.cancel()`, then unlink the partial file after 1000 ms.

### 12.2 Software upgrade `Dv` (16579-16786)

States (`jv`):

| Value | Name | Meaning |
|---|---|---|
| 0 | Latest | No update, error, or offline |
| 1 | WithNewCache | Update exists and the installer is already downloaded and md5-verified |
| 2 | WithoutNewCache | Update exists, not downloaded yet |
| 3 | SilentDownload | Background download started |
| 4 | RunUpgrade | Installer launched |
| 5 | AfterInstall | First run after an update |

Flow:
- **`startupInit()`**:
  - If `store.latestSoftwareInfo` exists: state 5, load it, delete the key.
  - Else, if `automaticUpdate` (default true): `state = getVersionState(respectIgnore=true)`.
    - State 2: `deleteUnmatchedPackage(versionNum)`, `packageDownload()`, state = 3.
    - State 1 and `autoUpdate` (default true): save `latestSoftwareInfo`, `packageInstall()`, state = 4.
- **`fetchNewVersion()`**:
  1. Token: `Vh.get("/auth-api/api/v1/auth/deviceSign", {brandId, productId, deviceSetId, mac, countryCode:"", appVersion:"1.13.0"}, {action:"getToken"})`. Returns `{token, expiredAt}`, cached in `av` until `expiredAt`.
  2. Then `Vh.get("/sp/api/device/v1/clientUpg", {channelId, ruleMac:mac, token, pkg:"windows.test.evnia", versionNum:101300, langCode:store.language}, {}, 5000 ms)`. The response data is `{newVersionName, downloadUrl, md5, description}`.
  3. This becomes `softwareInfo = {versionNum:newVersionName, description:lines[], downloadUrl, fileName:"evnia Setup <ver>.exe", md5}`.
- **`verifyUpgradePackage`**: md5 of `evnia-Download/<fileName>`.
- **`verifyIgnoredVersion(v)`**: not ignored when `ignoreVersion` is empty or "0.0.0.0". Otherwise not ignored if **any** component `v[n] > ignored[n]`, which is an incorrect semver comparison.
- **`packageInstall(path)`**:
  1. Write-probe: `mkdir <dirname(argv[0])>/<random>`, then `rmdir`.
  2. If the probe fails and `resources/elevate.exe` exists, `spawn(elevate.exe, [pkg, "--updated", "--force-run"])`. Otherwise `spawn(pkg, ["--updated","--force-run"])`. Both detached, `stdio:"ignore"`, `unref`.
  3. Hide the window, then `app.exit()` after 2000 ms.
- `elevate.exe` = "Elevate Application": `ShellExecuteExW` with verb `runas`, usage `Elevate [-?|-wait|-k] prog [args]` (`work/native/elevate.exe.symbols.txt`).
- Real logs (CONFIRMED):
  - 09-21..24: "Version state 0" (offline).
  - 09-25: "Version state 3", then `Task start https://gcdn.zeasn.com/prod/zeasn-saas-pp/apk/global/857/20260915061410_gnhffvtk.exe → …\evnia-Download\evnia Setup 1.13.0.exe`, then md5 `586207dd5c9bfd58a9c22243ca25faba` OK.
  - 09-26: "App ready, version 1.13.0", "Version state 5".

### 12.3 Installer flags
`--updated --force-run` are electron-builder NSIS flags. `installer.nsh` `customInstall` runs the app after an update (`${isUpdated}`, then `RunApp`, then `quitSuccess`). See §18.

### 12.4 Resource patch `Ov()` (16787-16825), called from every `start()`
1. Dir `userData/patch/RES_PCenter_101300/`. The local version comes from `<dir>/config.json` `{version:number, files:[{fileName, md5}]}`, and counts only if every file exists with a matching md5; otherwise it is 0.
2. `iv({deviceType:"RES_PCenter", componentId:"RES_PCenter_101300", version})`.
3. On a hit: `Ch(url,{hashMethod,hashValue})`, then extract into the dir, then delete the zip.
4. Real logs: "No update to resource pack" or "Fetch from server TypeError: fetch failed".
5. The renderer gets `patchPath` from `getRunConfig` (what it overlays is a cross-ref).

### 12.5 Image resources
`imageResourceDownload` (17612-17633). The URL, hash and model come from the renderer (cloud metadata). Images end up in `userData/ImageCache/<model>/`, loaded through `local:///`.

### 12.6 Cloud user files
`getCloudFileCacheOrDownload` (17634-17646). Available only when logged in (`userInfo.id`).

---

## 13. Cloud HTTP client (main-side)

Domains: `saasDomain = "https://saas.zeasn.tv"` and `portalDomain = "https://deviceportal.zeasn.tv/direct"`. The literals are at 13344-13345, and the bindings `{portalDomain: Lh, saasDomain: Ih}` at 13374. **CONFIRMED.** The CDN seen in logs is `https://gcdn.zeasn.com/…`.

| Client | Base | Headers | Timeout | Ref |
|---|---|---|---|---|
| `Vh.get(path, query, headers, timeoutMs?)` | saasDomain | static `Bh` headers (from the Rh block; not reproduced) + per-call headers + `Cache-Control: no-cache` | **None** unless `timeoutMs`: `signal:null` overrides the 20 s default | 13417-13425 |
| `Gh.get(path, query)` | portalDomain | `Authorization: ZAuth <accessKeyId>:<Base64(HMAC-SHA1(secret, "GET " + fullHref + " " + md5("") /*d41d8cd98f00b204e9800998ecf8427e*/))>` | 20 s (`AbortSignal.timeout(2e4)`) | 13426-13432, 12718-12722 |
| `qh(url, init)` (common) | – | If a proxy env var is set: undici `ProxyAgent` **and** `process.env.NODE_TLS_REJECT_UNAUTHORIZED="0"` (process-wide TLS verification off) | – | 13378-13416 |

- Response envelope: `{errorCode, errorMsg, data}`. `errorCode == 0` resolves `data`; any other code emits `globalErrorHandle(errorCode)` on `Ah` (no main-side listener) and rejects with the code. Legacy form: `{error, datas}`, where `error == 0` resolves `datas`.
- `iv(component, external=false, mac)` sends `GET portal /component/update` with query `brandId (dpBrandId, or dpExternalBrandId when external), components="<componentId>=<version>", deviceType (encodeURI), language (default "en"), push=true, ScalerIC=true, ruleMac=<MAC>, ruleUSBHubCount=<hubCnt or "">`.
  - The result array is filtered to keep items whose `versionName.split("|")[0]` is non-numeric or `<= 101300` (a minimum-app-version gate).
  - Items carry `{url, hashMethod, hashValue, version, versionName, friendlyVersion, description}`; the last two are used by the renderer.
- Identity constants (`brandId`, `dpBrandId`, `dpExternalBrandId`, `channelId`, `productId`, `deviceSetId`) are destructured from `Rh` at 13434. `productId` is `"857"` (13339; the same number appears in the CDN path). **The MAC address is sent as a device identifier in every call.**
- The same module (`tv`, `iv`) is also bundled in the renderer, where `tv()` fetches the MAC through `ipc.invoke("getMac")` (13435-13439). The renderer does its own `component/update` calls for firmware, plugins and Node (cross-ref).

---

## 14. Matter / smart-bulb process management

- Paths (16826-16832): `Av = userData/Matter`, `Lv = Av/node.exe`, `Iv = Av/Controller`, `Mv = resources/matter/control.mjs`.
- **Node runtime origin:** the renderer AmbiScape page downloads it from the device portal (`deviceType:"EVNIA_Plugins"`, `componentId:"EVNIA_AmbiScape_NODE_1801200"`) via `createDownload`, then `extractZip(zip, userData/Matter)` (renderer `styles-DAnQi2A8.js:35131-35160`). **Online.** Not present on the user's machine.
- `zv` pool (16833-16882):
  - `checkNodeAvailable()` is `exists(node.exe)`.
  - `createProcess(key, args)` destroys any existing process under the key, then runs `spawn(node.exe, [control.mjs, "--location=<Iv>", ...args], {cwd: Av, stdio:["pipe","pipe","pipe"], windowsHide:true})`.
  - `destroyProcess(key)` calls `kill()`; if that fails it runs `taskkill /PID <pid> /T /F`.
- Spawn argument sets (`Uv`, 16893-16969):

  | IPC | Pool key | Extra args |
  |---|---|---|
  | discoverBulb | `code` | `--ble --discover --qrCode=<code>` or `--matterCode=<code>`; **50 s** init timeout; process destroyed after Init |
  | pairingBulb | `uniqueId` | `[ssid?"--ble":"", isQr?"--qrCode=":"--matterCode=", ssid?"--wifiSsid=<ssid>":"", cred?"--wifiCredentials=<pwd>":"", id?"--uniqueId=<id>":""]` (empty strings are passed as empty argv entries) |
  | commissionBulb | `uniqueId` | `--uniqueId=<id>`. Long-lived controller. Checks `"error" === init.type`, but Init carries `state`, not `type`, so the check never fires (bug). |

- **stdout protocol (control.mjs → main)**: line-oriented, and only lines starting with `[Pending]` are parsed: `[Pending] [<Kind>] <json>`, matched by `/\[([^\]]+)\]\s*(.+)/` after stripping `[Pending]`. Kinds: `Init {state, success, data|error}`, `Reply {requestId, success, errorMessage, data}`, `Notification {uniqueId, endpointId, type, data}`, `Exit <msg>` (ignored by main) (16973-16995; `matter-control.mjs:72158-72179`). Other lines are logged at debug level.
- **stderr**: lines containing `WARN` are logged at debug level. Anything else counts as an error: it is logged, the reject callback is called if present, and for discovery the process is auto-destroyed (16996-17003).
- **stdin protocol (main → control.mjs)**: one JSON object per line, `{"requestId":"<uuid v4-ish>", "code":"<uniqueId>", "type":"<openCommissioningWindow|identify|getAttribute|setAttribute|remove|clearStorage>", "payload":{…}}\n` (17056-17072). Per-request timeout is **60 s**. The timer is stored **per uniqueId**, so a new request cancels the previous request's timeout (bug). If there is no process, the promise resolves (it does not reject) with `"Node process not found <id>"`.
- The Wi-Fi password is passed on the command line (visible in the process list) and printed by control.mjs at info level (`matter-control.mjs:72194`). It reaches the main log at debug level.
- Matter commissioning itself is local (BLE + IP/mDNS), but the runtime download is online. The user owns no Philips bulbs, so this whole subsystem is optional.

---

## 15. Logging

- Logger `E` (26-140) wraps electron-log 5.4.4.
  - `configure()` is called without `logDir`, so the directory is `dirname(electron-log default file)`: **`%APPDATA%\evnia\logs\`** (`~/.config/evnia/logs/` on Linux).
  - The file name is `YY-MM-DD.log` (`getCurrentDateStamp`, 73-75).
  - `maxSize = 20 MiB` (`20<<20`). Rotation: shift numeric suffixes up, then rename the current file to `<file>.2` (79). On failure, crop to the last `min(maxSize/4, 256 KiB)` bytes, prefixed with `[log cropped]`.
  - Retention: `cleanupOldLogs(dir, 5 days)` at configure time deletes matching files older than 5 days **and deletes any non-matching file in the log dir** (118-136). The filename regex is `^\d{2}-\d{2}-\d{2}\.log(\.\d+)?$`.
  - Line format: `[YYYY-MM-DD HH:mm:ss.SSS] [level] [<scope>] msg`.
  - Scopes: `main/app`, `main/index`, `main/utils`, `main/backendService`, `main/download`, `main/softwareUpgrade`, `main/patchUpdate`, `main/bulbControl`, `api/server`.
- Level: info (packaged), debug if `%TEMP%\evnia-debug-open.tmp` exists, silly in dev. `Bv.clear()` truncates the current day's file at startup (17117).
- The backend logs separately to `%APPDATA%\EvniaServe\logs` (cross-ref).

---

## 16. Windows-only APIs and assumptions in main

| Item | Ref | Linux replacement |
|---|---|---|
| `powershell … Get-CimInstance Win32_Process` (WMI/CIM) to find EvniaServe by path | 13489-13491 | PID file plus `/proc/<pid>/exe` check, or keep a child handle |
| `cmd` `for /f … netstat -ano ^\| findstr <pid>` | 13498 | Known port / `ss -ltnp` / pidfile with port |
| `execFile("…\\EvniaServe.exe", ["--urls","http://*:<p>"])` | 13562 | Spawn the Linux backend with `http://127.0.0.1:<p>` |
| `hookWindowMessage(126 WM_DISPLAYCHANGE / 537 WM_DEVICECHANGE)` | 17235-17236 | Windows-only Electron API (undefined elsewhere; guard it). Use `screen` events + udev monitor |
| `app.setAppUserModelId` | 17150 | n/a |
| `app.setLoginItemSettings` (writes `HKCU\…\Run`, INFERRED) | 17401 | `~/.config/autostart/evnia.desktop` |
| `app.setAsDefaultProtocolClient` (registry `HKCU\Software\Classes`, INFERRED) | 17741-17745 | Strip (OAuth only) |
| `second-instance` protocol parsing only on win32 | 17160 | Strip |
| `tasklist` / `ps aux` DtsServer kill | 17376-17389 | Strip (DTS is Windows-only) |
| `taskkill /PID … /T /F` | 16876 | `process.kill(-pgid, "SIGKILL")` with `detached:true` spawn |
| `exec("start " + url)` | 17648 | `shell.openExternal` (or strip) |
| `elevate.exe` (`ShellExecuteExW` runas) + NSIS installer spawn | 16743-16748 | Strip |
| `process.env.AppDATA` | 17575 | `app.getPath("appData")` |
| `node.exe` path for Matter | 16828 | `which node` (>= 18) |
| `.exe` assumptions in `findExe` default, upgrade file name `evnia Setup <v>.exe`, `pkg:"windows.test.evnia"` | 17555, 16703, 16694 | Strip |
| `globalShortcut` per focus (does not work on Wayland) | 17151-17158 | `before-input-event` handling |
| `local://` → `net.fetch(<Windows path>)` | 17179-17182 | `net.fetch(pathToFileURL(p))`, restricted to userData/resources |

---

## 17. Security observations (relevant for the port)

1. **`runCommand`** is arbitrary shell execution from the renderer, and the preload has no channel allowlist. Any renderer compromise is RCE. The renderer CSP allows `https://*.zeasn.tv`, `*.amazonaws.com` and `script-src https://*.jsdelivr.net` (`renderer/index.html`).
2. `openDefaultBrowser` builds a shell command by concatenating the URL.
3. `protocol.handle("local")` serves arbitrary local paths to the renderer.
4. The backend is bound to `http://*:<port>`, i.e. all interfaces, with no hub auth: the LAN can drive the monitor (cross-ref backend).
5. With a proxy env var set, `NODE_TLS_REJECT_UNAUTHORIZED=0` disables TLS verification process-wide.
6. Store schema has `email` and `password` fields (renderer-managed).
7. Windows use `sandbox:false`, `nodeIntegration:true`; the notice window also uses `contextIsolation:false`.
8. The MAC address is sent to Zeasn with every cloud call.
9. The Matter Wi-Fi password is exposed in argv and in logs.

---

## 18. `installer.nsh` (electron-builder NSIS include)

| Macro | Behaviour |
|---|---|
| `preInit` | If not `${isUpdated}` and `HKCU\${INSTALL_REGISTRY_KEY}\InstallLocation` is empty: write `InstallLocation = "C:\Precision Center"` into HKCU, in both the 64-bit and 32-bit registry views. The HKLM writes are commented out. The user's actual install is under `%LOCALAPPDATA%\Programs\Evnia Precision Center`. |
| `RunApp` | `StdUtils.ExecShellAsUser "$launchLink" open` |
| `customInit` | No-op. A commented-out `DeleteRegKey HKCU "…\Uninstall\3ddc912e-b8a0-5f97-a936-cac905df7796"` shows the uninstall GUID. |
| `customInstall` | If `${isUpdated}` (from `--updated`): `RunApp`, then `quitSuccess`. This is the auto-relaunch after an auto-update. `microsoftDownload` is **commented out**. |
| `customInstallMode` | `$isForceCurrentInstall = "1"` (per-user install) |
| `customUnInit` | `SetSilent silent`. Find `${PRODUCT_FILENAME}.exe` with nsProcess and kill it, then sleep 500 ms. |
| `microsoftDownload` (inactive) | Would download .NET Core 3.1.32 x86 Desktop and ASP.NET Core runtimes from `download.visualstudio.microsoft.com` via NSISdl (7.5 s timeout) and install them quietly. Unused because `EvniaServe.runtimeconfig.json` lists `includedFrameworks` 3.1.32 (self-contained). |

Nothing in the installer is needed on Linux.

---

## Linux port plan (Electron main)

The target is a Linux build of the same Electron shell and renderer. The main process becomes a thin, offline host.

1. **Runtime:** use a maintained Electron (>= 32). Drop the undici chunk (no proxy logic needed). Keep electron-log and electron-store. Remove `email`, `password`, `userInfo`, `latestSoftwareInfo`, `ignoreVersion`, `autoUpdate` and `automaticUpdate` through a store migration, or ignore them.
2. **Backend launcher** (replaces §7):
   - Spawn the Linux backend binary (the replacement for EvniaServe/Bridge, defined by other reports) with `--urls http://127.0.0.1:<port>`, `stdio:["ignore","pipe","pipe"]` piped into electron-log.
   - Port: keep the default **10010**. Probe with `net.createServer().listen(port, "127.0.0.1")`, and make the backend honour the chosen port (unlike `Program.cs:37`).
   - Readiness: poll a TCP connect (or `GET /EvniaHub/negotiate`) every 100 ms for up to 15 s before resolving `startupBackendService`.
   - Keep the renderer's "reconnecting → wait 3 s → re-invoke" behaviour. Make `startupBackendService` idempotent: if the tracked child is alive, return its port; if it died, respawn.
   - Kill the child (SIGTERM, then SIGKILL after 3 s) on `before-quit` and in `exitApp`. Do not use PowerShell or netstat.
   - Drop the 10 s `--openAsHidden` delay, or make it optional.
3. **MonitorInfo:** delete `verifyMonitorInfoJson`. Ship `MonitorInfo.json` v34 (identical to `Qf`) and keep `getLocalMonitorInfoVersion`'s seeding into `~/.config/evnia/MonitorInfo.json`, because the backend reads it. Keep `getMonitorJsonConfig` byte-for-byte, including the key-derivation regex. For the 34M2C8600 it yields `{SupUsbDDC, SupOTA, SupLightEffect, SupLightSync: true, HDR: 400}`. Recommended: return `OTAEnable:false`, since firmware OTA requires cloud downloads (or add `LimitVer_PCenter:[-1]` to the shipped JSON).
4. **Device-change events** (keep the renderer contract `displayChange` / `otherDeviceChange` / `USBChange` and all timings in §9):
   - `displayChange`: Electron `screen` `display-added`, `display-removed`, `display-metrics-changed`, plus udev `drm` "change" events (hotplug and mode changes), through the same 2000 ms trailing debounce.
   - `USBChange`: keep node-usb `usb.on("attach"/"detach")` (libusb hotplug works on Linux; the prebuild `linux-x64` is present; it needs no device permissions for hotplug), or use a udev monitor on `usb`. Keep the 1000 ms delay and 2000 ms lock.
   - `otherDeviceChange`: udev monitor on `hid`, `input` and `i2c`/`drm` add/remove. Keep the 1700 ms delay.
   - Guard `hookWindowMessage` behind `process.platform === "win32"`.
   - Keep `shieldDisplayChange` and `shieldPeripheralChange` unchanged.
5. **Windows and tray:** keep all three window specs, except feedback, which is removed. Fix notice placement using `workArea.x/y`. The tray on Linux needs StatusNotifierItem/AppIndicator support. Keep items 1 (rename to "Show Precision Center", since AppIndicator often does not emit `click`), 2 (Rescan), 5 (Settings) and 6 (Exit). Remove Check for Updates and Feedback. Keep `trayExitDisabled`/`trayFunctionDisabled`.
6. **Autostart:** implement `setAutoStartUp` by writing or removing `~/.config/autostart/evnia-precision-center.desktop`, with `Exec=<AppImage or binary> --openAsHidden` when `autoStartupMinimize`. Keep the store defaults. Recommended: make the Linux default `autoStartup:false`.
7. **IPC surface:**
   - Keep or adapt: 1-11, 16-19, 21-23, 27-28, 31, 50 (see §10.1).
   - Stub offline: `getMac` returns `""`; `imageResourceDownload` and `getCloudFileCacheOrDownload` return `""`; `checkSoftwareVersion` replies `versionCheckResult {state:0, isStartup:false}`; `createDownload` immediately sends `downloadFail {url, msg:"offline"}`.
   - Remove: `runCommand`, `findExe`, `openDefaultBrowser` (or allowlisted `shell.openExternal`), feedback channels, software-upgrade channels, `extractZip` (unless local firmware files are supported), and Matter channels (or port them per item 9).
   - Add a channel allowlist in the preload.
8. **Remove entirely:**
   - `Dv` (upgrade), `Ov` (patch update), `Vh`/`Gh`/`qh`/`iv`/`Vf` (cloud client and signing).
   - The `EvniaPrecisionCenterApp://` protocol registration, `second-instance` URL parsing and `thirdPartySuccess`.
   - The `setWindowOpenHandler` external open (deny only), the DtsServer kill, and `elevate.exe`.
9. **Matter (optional, default off):** use the system `node` (>= 18) instead of the downloaded `node.exe` (`checkNodeAvailable` then reports `which node`). Spawn with `detached:true` and kill the process group. Fix the per-request timeout map. Pass Wi-Fi credentials through stdin, not argv. BLE commissioning on Linux needs HCI access (`CAP_NET_RAW`/`CAP_NET_ADMIN`, or BlueZ). The user has no bulbs, so shipping without it is recommended.
10. **Logging:** keep `E`. Logs land in `~/.config/evnia/logs/YY-MM-DD.log` with 5-day retention. Keep the debug-flag file semantics (`/tmp/evnia-debug-open.tmp`) or replace them with an env var.
11. **`local://` protocol:** implement it with `pathToFileURL` and restrict it to `userData/ImageCache` and app resources. Better, register it as privileged or use `file://` for bundled images.
12. **Misc:** `getSystemInfo.appDataDir` becomes `app.getPath("appData")`. Replace `globalShortcut` with `before-input-event`. Keep `nativeTheme.themeSource="dark"` and the single-instance lock.

---

## Online touchpoints

| # | What | Where (index.js) | Endpoint | Trigger | Strip recommendation |
|---|---|---|---|---|---|
| 1 | Device token | 16667-16685 (`Vh`) | `GET https://saas.zeasn.tv/auth-api/api/v1/auth/deviceSign?brandId&productId&deviceSetId&mac&countryCode&appVersion` (header `action:getToken` + static headers) | Startup (`startupInit` when `automaticUpdate`), manual check, tray "Check for Updates" | Remove |
| 2 | App version check | 16689-16720 | `GET https://saas.zeasn.tv/sp/api/device/v1/clientUpg?channelId&ruleMac&token&pkg=windows.test.evnia&versionNum=101300&langCode` (5 s) | Same as #1 | Remove; `versionCheckResult` returns state 0 |
| 3 | Installer download | 16723-16730 → `Cv` (`webContents.downloadURL`) | `https://gcdn.zeasn.com/prod/zeasn-saas-pp/apk/global/857/<ts>_<rand>.exe` (from the clientUpg response; seen in logs) | Auto (state 2) or `softwareDownload` IPC | Remove |
| 4 | Installer execution | 16734-16758 | local spawn of `evnia Setup <v>.exe` (optionally via `elevate.exe`) | Auto (state 1 + autoUpdate) or `softwareInstall` IPC | Remove |
| 5 | MonitorInfo refresh | 13508-13545 (`iv`/`Gh`, then `Ch`) | `GET https://deviceportal.zeasn.tv/direct/component/update?...deviceType=PhilipsMonitorsOTA&components=PrecisionCenter_Monitors_OTA_JSON=<v>…` + JSON download (crc32) | Every `startupBackendService` | Remove; ship v34 JSON |
| 6 | Resource patch | 16787-16825 | same endpoint, `deviceType=RES_PCenter`, `components=RES_PCenter_101300=<v>` + zip download | Every `start()` | Remove |
| 7 | Generic downloads | 16487-16578 | any URL from the renderer (firmware, Node runtime `EVNIA_AmbiScape_NODE_1801200`, DTS/SmartDesktop installers) | `createDownload` IPC | Remove (reply `downloadFail`) |
| 8 | Device image packs | 17612-17633, 17702-17728 (`fetch`) | URL from the renderer (cloud metadata) | `imageResourceDownload` IPC | Remove; bundle images |
| 9 | Cloud user files | 17634-17646 | URL from the renderer; requires a logged-in `userInfo.id` | `getCloudFileCacheOrDownload` IPC | Remove |
| 10 | OAuth / third-party login callback | 17159-17172, 17739-17746 | `EvniaPrecisionCenterApp://…` custom protocol, registered in the OS | Browser redirect after login | Remove the protocol registration and handler |
| 11 | External links | 17243, 17647-17649 | `shell.openExternal` / `start <url>` | Renderer `window.open` or `openDefaultBrowser` | Deny, or allowlist local help only |
| 12 | Feedback | 9183-9222, tray item 4 | Feedback window (upload handled by the renderer, cross-ref) + `getSystemInfo` | Tray / `openFeedbackWindow` | Remove window, IPC and tray item |
| 13 | MAC as device identity | 13321-13337, 17426, 17533 | Sent as `mac` / `ruleMac` query parameters | Every cloud call | `getMac` returns `""` |
| 14 | Proxy / TLS weakening | 13378-13396 | undici ProxyAgent; `NODE_TLS_REJECT_UNAUTHORIZED=0` | Whenever `HTTP(S)_PROXY` is set | Remove with the cloud client |
| 15 | Backend LAN exposure | 13562 | `EvniaServe --urls http://*:<port>` listens on all interfaces | Backend start | Bind 127.0.0.1 only |
| 16 | Installer .NET runtime download (inactive) | `installer.nsh` `microsoftDownload` | `https://download.visualstudio.microsoft.com/download/pr/…/windowsdesktop-runtime-3.1.32-win-x86.exe`, `…/aspnetcore-runtime-3.1.32-win-x86.exe` | Never (macro commented out) | n/a on Linux |

---

## Open questions

1. **Does EvniaServe honour `--urls`?** `Program.cs:37` hardcodes `UseUrls("http://*:10010/")`. With .NET Core 3.1 generic hosting this likely overrides the command line (INFERRED), so main's free-port fallback (10011+) would desync from the backend. Irrelevant if the Linux backend is rewritten, but the Linux launcher and backend must agree on the port.
2. What does the renderer do when `imageResourceDownload` returns `""`, or when `getMonitorJsonConfig` is undefined? Is there a bundled fallback image for the 34M2C8600? (Renderer scope.)
3. What do `RES_PCenter_*` patch packs contain (renderer resource overrides, translations?), and is `patchPath` consulted before bundled assets? Both local patch dirs are empty, so this cannot be observed.
4. The static SaaS request headers (`Bh`) and the `Rh` identity constants were intentionally not transcribed (the region carries embedded credentials). They are not needed for an offline port.
5. `loginShow` is listened for by the renderer but never emitted by main 1.13.0. Is the login dialog reachable only from renderer UI? (Renderer scope.)
6. Is the `password` store key encrypted by the renderer before persisting? (Renderer/preload scope.)
7. Does EvniaServe detect an orphaned state or exit on its own when Electron exits? Main never kills it. Logs show it dying only at session end.
8. Does `net.fetch()` in the `local` protocol handler really accept a bare Windows path (`C:\…`)? If not, how do `local:///` images load? A Linux port should use `file://` URLs regardless.

---

## Cross-references (outside this scope)

- **Preload** `work/app-pretty/preload/index.js:7325-7377`: generic IPC bridge without an allowlist; `window.store` (electron-store with the same schema, including `email`/`password`); `window.nodeApi` (`existsSync`, `mkdirSync`, `rmdirSync`, `unlinkSync`, `readFile`/`readFileSync`, `copyFileSync`, `basename`, `join`).
- **Renderer startup / SignalR:** `renderer/assets/main-CDosWiM3.js:156-200` (startup sequence, reconnect → re-invoke `startupBackendService` after 3 s); `styles-DAnQi2A8.js:7902` (`HubConnectionBuilder().withUrl("http://localhost:<port>/EvniaHub", {skipNegotiation:true, transport:WebSockets, timeout:120000})`); IPC wrappers at `styles-DAnQi2A8.js:14156-14293`.
- **Renderer firmware flows** (`runCommand`, `findExe`, `extractZip`, `createDownload`): `styles-DAnQi2A8.js:33790-34050`. Monitor firmware goes through the backend `firmwareBurning(scalerName, type, path)` with `FirmwareUpdateProgressData` notifications; peripheral firmware goes through the vendor `.exe` or `m.firmwareUpgrade` for SPK9418/9618/9728.
- **Renderer DTS / SmartDesktop installers:** `Setup-daShw_PC.js:105-135`, `SmartDesktop-By8ZEPkl.js:121`.
- **Renderer Matter Node download:** `styles-DAnQi2A8.js:35131-35160`. `local:///` usage: `styles-DAnQi2A8.js:33366, 33383, 42665, 42882, 42968`. CSP whitelist in `renderer/index.html` and `renderer/feedback/feedback.html` (`*.zeasn.tv`, `*.amazonaws.com`, `*.jsdelivr.net`, Google/WeChat/Twitch/Facebook avatar hosts).
- **Backend:**
  - `work/dotnet-clean/EvniaServe/Evnia/Program.cs:37` (`UseUrls("http://*:10010/")`), `:56` and `EvniaService.cs:14` (kill `DtsServer`).
  - `Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/PHLDisplayFW.cs:112` and `Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/DictMgr.cs:23` read `%APPDATA%\evnia\MonitorInfo.json`.
  - `Zeasn.PCenter.Entity.Lib/.../WorkspacePath.cs:24` (`%APPDATA%\G-MenuDTSServe\DtsServer.exe`).
  - The backend is self-contained .NET Core 3.1.32 (`resources/bin/EvniaServe.runtimeconfig.json`), with `System.GC.Server:true`.
- **Matter helper** `work/app-pretty/matter-control.mjs:72158-72198` (stdout `[Pending] [...]` protocol, CLI vars `location, ble, discover, qrCode, matterCode, wifiSsid, wifiCredentials, uniqueId`, plaintext credential log at 72194; stdin JSON-lines reader at 72243-72296). `resources/matter/node_modules` contains only `debug`.
- **elevate.exe:** `work/native/elevate.exe.symbols.txt` (ShellExecuteExW "runas"; "Execute a process on the command line with elevated rights on Vista").
- **Vendor agent files** `work/app/VENDOR_AGENTS.md.txt` and `VENDOR_CLAUDE.md.txt` are untrusted data and were ignored.
