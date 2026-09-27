# Evnia Precision Center 1.13.0: preload, renderer app shell and SignalR client (RE spec 02)

## Summary

The UI is a Vue 3 single-page app. vue-router, pinia, a small custom i18n plugin and the `@microsoft/signalr` 7.0.14 JavaScript client are bundled into one shared chunk (`styles-DAnQi2A8.js`, 45 k lines when prettified). The shell (`main-CDosWiM3.js`) holds the startup screen, sidebar, toolbar, login and register dialogs, the Home layout and the root `App`. Everything the renderer needs from the OS goes through three objects that the preload exposes: `window.ipc`, `window.nodeApi` and `window.store`. `window.ipc` is a raw pass-through to `ipcRenderer` with **no channel allowlist**. `window.store` is `electron-store` (`config.json`). All device control goes over **one** SignalR hub method, `GetTaskAsync(string)`, at `ws://localhost:<port>/EvniaHub`. The port is normally 10010 and comes from the `startupBackendService` IPC.

Requests are double-encoded JSON of the form `{functionName, requestId, parms}`. The renderer never sends `device`. Replies and notifications come back as server-to-client invocations named `GetTaskAsync` or `Notification`, each carrying a JSON string of the backend `JsonResult` (`{err_code, err_msg, RequestId, FunctionName, Tag, ...}`). A reply is matched by `RequestId` and only the **latest** request per `functionName` is honoured. The exceptions are `Theme_GetThemeInfos` and `DeviceSteup_GetPowerInfo`. There is **no per-request timeout**.

The renderer calls 140 distinct hub functions and subscribes to 20 notification names. Two of those names (`NotifyUISwitchTheme`, `NotifyMouseDPIChange`) are never emitted by the 1.13.0 backend. One (`NotifyUIDisplayEffectChange`) has a payload-shape mismatch with its backend emitter.

Online code in the renderer is concentrated in one request core, `Sv()` at `ST:32928`, plus three thin clients:
- `saas.zeasn.tv`: accounts, OAuth, device-sign token and avatar upload.
- `deviceportal.zeasn.tv/direct`: firmware and plugin component updates.
- `pcenter.zeasn.tv`: cloud themes, profiles and macros, feedback, device image resources and presigned uploads.

A few more online touchpoints exist:
- `cdn.jsdelivr.net`: browser-image-compression.
- `fastly.jsdelivr.net`: zxing-wasm.
- A link to `www.evnia.philips`.
- IPC calls that ask main to go online: software update, image and cloud-file downloads, and the feedback window.

The renderer already degrades when `fetch` fails. So the recommended offline strategy combines three things:
1. A network kill-switch in the Linux main process.
2. Five small, verified string patches in the minified bundles (`Sv`, `vv.get`, `Mv`, `getDeviceResource`, `getDeviceImage`).
3. Hiding six entry points: Account, Feedback, update checks, the firmware tab, the AmbiScape tab and SmartDesktop.

With those in place the stock renderer runs fully offline against a Linux backend that implements the hub contract in section 4.

---

## 0. Sources, abbreviations, confidence

| Abbrev | Path |
|---|---|
| PL | `work/app-pretty/preload/index.js` |
| ST | `work/app-pretty/renderer/assets/styles-DAnQi2A8.js` (shared chunk: libraries + all services, stores, settings and account pages) |
| MN | `work/app-pretty/renderer/assets/main-CDosWiM3.js` (entry of `index.html`) |
| FB | `work/app-pretty/renderer/assets/feedback-NPrjkfNw.js` (entry of `feedback/feedback.html`) |
| NT | `work/app-pretty/renderer/assets/notice-CyNu0Xs4.js` (entry of `notice/notice.html`) |
| EM | `work/app-pretty/main/index.js` (Electron main, see `01-electron-main.md`) |
| DC | `work/dotnet-clean/` |
| BLOG | `%APPDATA%/EvniaServe/logs/2026-09-26.txt` (real backend traffic, 34M2C8600 attached) |
| ELOG | `%APPDATA%/evnia/logs/26-09-2*.log` |
| CFG | `%APPDATA%/evnia/config.json` (real electron-store file; only keys inspected) |

Line numbers refer to the prettified copies in `work/app-pretty`. Minified identifiers (`Sv`, `tu`, `Dy`...) are identical in the raw bundles under `work/app/out/renderer/assets/`, which is where patches must be applied. The anchors in §L.3 were verified against the raw files.

**CONFIRMED** means the behaviour was read in code, or seen in the logs or CFG. **INFERRED** means it was deduced from code semantics or library defaults and not observed directly.

---

## 1. Bundle and entry-point layout

### 1.1 Shell files in scope

| File | Lines (pretty) | Content |
|---|---|---|
| `out/renderer/index.html` | 1 | Main window. `<div id="app">` + `<div id="component-teleport-container">`. Loads `main-CDosWiM3.js` and preloads `styles`, `tinycolor`, `directive`, `Menu` and `Collapse` chunks. CSP below. |
| `main-CDosWiM3.js` | 4077 | Startup, Sidebar, Toolbar, SoftwareVersionUpdate, Tutorials, Login, ForgetPassword, Register, the login container, Home, App, generic widgets (ActionBox, Confirm, Dialog, Label, Toast, TextIcon, CheckboxGroup, Select, NumberSplitInput, Radio, Slider, Switch, Cascader, SliderSelect, LabelEditor), global component registration `yl` (MN:4040-4071) and app bootstrap (MN:4074-4077). |
| `styles-DAnQi2A8.js` | 45145 | Vue runtime, vue-router (web-history), pinia, SignalR 7.0.14 (ST:~6033-7867), SignalR wrapper `Jc` and `ou()` (ST:7888-8032), every hub API facade, every pinia store, loading and alert services, the ipc wrapper `ih()` (ST:14156-14294), built-in translations (ST:14295-29380), i18n plugin (ST:29400-29466), Overview, Dashboard, Message, Setting (General, AboutPCenter, AboutDevice, AmbiScape, FwUpdate, PairingTool), Account (MyProfiles, MyMacros, user settings), Profile page, cloud HTTP clients (ST:32914-33154, 39426-39716), electron-log renderer (ST:~30688-31140), crypto-js, qs, browser-image-compression 2.0.2 (ST:~38200-38656), router table (ST:43772-44029), device-model mapping and the main store (ST:44421-44835). Export map at ST:44990-45145. |
| `directive-B2r732H0.js` | 577 | Widgets: Textarea, Input, Checkbox, Button, PopMessage, Progress, Loading; `v-outside-click` directive (global capture-phase `mousedown` listener list). |
| `index-7Mj02WAv.js` | 524 | Peripheral "Ambiglow" lighting panel (colour picker, `Effect_*`). Used by the keyboard, mouse and pad Ambiglow pages. |
| `index-CkulgR5C.js` | 325 | Onboard-profile panel (`Profile_*Onboard*`). Used by the keyboard and mouse Onboard pages. |
| `index-D_7NuP0U.js` | 533 | Mouse button-map renderer (per-model LED/button layout tables `renderFlat`). |
| `index-BYSWl2m0.js` | 12541 | `undici` (ProxyAgent). Lazily imported only from `Sv()` when `typeof window === "undefined"` (ST:32929-32949), so it is dead code in the renderer. |
| `src-renderer-B_PeUVI8.js` | 6 | Side-effect imports only (main + shared chunks). |
| `noop-DX6rZLP_.js` | 2 | `export function n(){}`, used as `.catch(noop)` by the device view pages. |
| `feedback/feedback.html` | 1 | Feedback window; own CSP; loads `feedback-NPrjkfNw.js`. |
| `notice/notice.html` | 1 | Toast/notice popup window; **no CSP**; loads `notice-CyNu0Xs4.js`. |
| `monitor/ keyboard/ mouse/ mouse_pad/ headset/` | png | Bundled product images for the model list `ry` (ST:33282-33303). `34M2C8600.png`, `34M2C8600_rear.png` and `34M2C8600_source.png` are present, so the user's monitor never needs a downloaded image. |

Version constant: `Rf = "1.13.0"` (ST:30687). The licence table in the Terms dialog lists electron 25.4.0 and vue 3.3.4 (ST:30506-30519); that table is stale and is not the runtime version.

### 1.2 Content-Security-Policy (CONFIRMED, `out/renderer/index.html`)

```
default-src 'self' ws://localhost:* http://*.zeasn.tv https://*.zeasn.tv https://*.amazonaws.com https://*.jsdelivr.net;
img-src 'self' data: blob: http://localhost:* https://lh3.googleusercontent.com/ https://thirdwx.qlogo.cn/
        https://static-cdn.jtvnw.net/ https://platform-lookaside.fbsbx.com/ http://cache.zeasn.tv https://cache.zeasn.tv local://*;
script-src 'self' 'wasm-unsafe-eval' http://localhost:* data: https://*.jsdelivr.net;
style-src 'self' 'unsafe-inline'
```

- `feedback.html` uses the same idea but its `script-src` has `blob:` and `https://cdn.jsdelivr.net`, and there is no `blob:`/`localhost` in `img-src`.
- `notice.html` has no CSP.
- The img-src hosts are the avatar CDNs of Google, WeChat, Twitch and Facebook (third-party login avatars) plus `cache.zeasn.tv`.
- `*.amazonaws.com` is there for presigned S3 PUT uploads (INFERRED from the CSP and the `presignedUrl` flows).
- `local://` is a custom protocol served by main (EM:17179-17182) that maps `local:///<abs path>` to a file read. It is used for ImageCache images and bound-app icons.

### 1.3 Bootstrap (CONFIRMED, MN:4072-4077)

```js
document.addEventListener("mouseup", e => { if (e.button===3||e.button===4) e.preventDefault(); }); // kill mouse back/forward
const bl = window.store.get("language");
window.runConfig = await window.ipc.invoke("getRunConfig");         // top-level await
createApp(App).use(router Db).use(createPinia()).use(i18n ph, bl).use(components yl)
  .directive("outside-click", o).mount("#app");
```

`feedback` (FB:370-372) and `notice` (NT:51-52) boot the same way: read the language, await `getRunConfig`, then mount.

`window.runConfig`, as returned by main (EM:17421-17430): `{appVersion, isDebugMode, isFirstRun, isPackaged, mac, patchPath, processPath, userDataPath}`.
- `isDebugMode` is `existsSync(os.tmpdir()/<name>-debug-open.tmp)`.
- `patchPath` is `<userData>/patch/RES_PCenter_101300`.
- The renderer reads `isPackaged`, `isDebugMode`, `mac`, `patchPath`, `processPath` and `userDataPath`.

---

## 2. Preload (`PL`)

### 2.1 What is exposed (CONFIRMED, PL:7328-7377)

`process.contextIsolated` is true in the main window: `webPreferences = {preload, sandbox:false, nodeIntegration:true}` (EM:17214) and contextIsolation keeps its default. The preload therefore calls `contextBridge.exposeInMainWorld` three times. Without isolation it would assign to `window.*` instead.

| Global | Member | Implementation | Notes |
|---|---|---|---|
| `window.ipc` | `send(ch, ...args)` | `ipcRenderer.send` | **No channel allowlist.** |
| | `invoke(ch, ...args)` | `ipcRenderer.invoke` → Promise | |
| | `on(ch, listener)` | `ipcRenderer.on`; **returns an unsubscribe function** | Listener signature is `(event, ...args)`. |
| | `once(ch, listener)` | `ipcRenderer.once`; returns an unsubscribe function | |
| | `removeAllListeners(ch)` | | unused by the renderer |
| | `listeners(ch)` | | unused |
| `window.nodeApi` | `existsSync`, `mkdirSync`, `rmdirSync`, `readFile`, `readFileSync`, `copyFileSync` | raw `fs` functions | Unrestricted fs access from the page. |
| | `unlinkSync(p)` | wrapped; errors are logged and swallowed | |
| | `getBaseName` = `path.basename`, `pathJoin` = `path.join` | | |
| `window.store` | `get(key)`, `set(key, value)`, `delete(key)` | `electron-store` instance `new Ad({schema: xd})` | File `<userData>/config.json`. |

Other preload details:
- `window.noop = () => {}` is also assigned (PL:7369). With context isolation it only exists in the isolated world, so the page's `.catch(window.noop)` calls (ST:40057, ST:43516, KeyBind:1574) are really `.catch(undefined)` (INFERRED; harmless).
- Constructing the store runs `ipcRenderer.sendSync("electron-store-get-data")` (PL:7282). Main must have called `Store.initRenderer()` so that this **synchronous** channel is answered with `{defaultCwd: userData, appVersion}` (PL:7265-7276). A Linux main must keep this handler.

Renderer usage of `nodeApi`:
- `existsSync`, `readFileSync`: translation override and ImageCache check (ST:29405-29408, ST:44489).
- `readFile`: cloud upload (ST:39474).
- `copyFileSync`, `unlinkSync`: temporary copies for profile and macro import/export (ST:43086-43094, ST:43507-43517, KeyBind:1163-1176, KeyBind:1564-1575), firmware temp files (ST:34010).
- `getBaseName`, `pathJoin`: various.

### 2.2 electron-store schema (CONFIRMED, PL:7305-7327)

| Key | Type | Default | Used by renderer (file:line) | Meaning |
|---|---|---|---|---|
| `language` | string | `"en"` | MN:4075, FB:370, NT:51 read; ST:29447 write | UI language code (§9) |
| `dashboardPreview` | object | `{}` | ST:13989 read; ST:14118-14139 write | `{<EquipmentType>: "Name1/Name2/..."}` dashboard preview items |
| `dashboardPreviewEnable` | boolean | `true` | ST:13997, ST:14134, ST:29657 | |
| `dashboardLocation` | number | – | ST:13998, ST:14101, ST:14136 | 0..5 overlay corner (`<2` top, `<4` right, else bottom; ST:14097) |
| `autoStartup` | boolean | `true` | ST:29980 read (write via ipc `setAutoStartUp`) | |
| `autoStartupMinimize` | boolean | `true` | ST:29981 | |
| `noticeSwitch` | boolean | `false` | ST:30005, ST:30017 | show OS notices |
| `noticeSound` | number | 0 (`SystemSound`; 1 = `NoSound`) | ST:30006, ST:30018 | |
| `noticeStyle` | number | 0 (`Persistent`; 1 = `Short`, 2 = `No`) | ST:30007, ST:30019 | |
| `autoUpdate` | boolean | `true` | ST:33167, ST:33176 | "Auto download and install" (online) |
| `automaticUpdate` | boolean | `true` | ST:33166, ST:33178 | "AutoUpdate" master switch (online) |
| `latestSoftwareInfo` | object | – | main only | online updater cache |
| `ignoreVersion` | string | – | MN:750 | "remind next time" for updates |
| `tutorials` | object | – | MN:904-905, ST:30100, ST:44581 | `{DeviceOverview:true, MonitorView:true, Dashboard:true}` = seen |
| `userInfo` | object | – | MN:140, MN:230, MN:236-239, MN:1361, MN:1911, ST:35412, ST:38842, ST:38964, ST:38981 | cloud account: `{email,emailBind,fromId,fromSource,groupId,icon,id,nm,token,timestamp?}` |
| `email` | string | – | MN:981, MN:999 | last login e-mail |
| `password` | string | – | **never read or written** (grep of renderer and main) | dead schema key |
| `skipLoginState` | boolean | – | MN:982, MN:1001, MN:1025, MN:1864, ST:38843 | "don't show login at start" |
| `mainWindowBounds` | object | – | main only | `{x,y,width,height,maximized}` |
| `overviewType` | string | `"category"` | ST:8878-8880 | `"category"` or `"list"` |
| `ambiScapeEnable` | boolean | `false` | MN:2106, ST:44812 | Matter bulb feature toggle |

Keys actually present in the user's CFG are listed below. `languageTemp` is not in the schema and no JS code writes it; it is INFERRED to come from the NSIS installer.

```
languageTemp, language, dashboardPreview, dashboardPreviewEnable, autoStartup, autoStartupMinimize,
noticeSwitch, noticeSound, noticeStyle, autoUpdate, automaticUpdate, overviewType, ambiScapeEnable,
__internal__.migrations.version, tutorials{DeviceOverview,MonitorView,Dashboard}, skipLoginState(true), mainWindowBounds
```

There is no `userInfo`, so the user has never logged in.

### 2.3 Security observations (for the port)

- `window.ipc` forwards any channel name. Combined with the main-side `runCommand` handler (EM:17515-17531, `child_process.exec(arbitrary)`) and a CSP that allows scripts from `https://*.jsdelivr.net` and `http://localhost:*`, any script injection turns into arbitrary command execution. The port should expose a **typed allowlist** instead (§L.2).
- `nodeApi` gives the page arbitrary fs read, copy and delete.

---

## 3. IPC contract used by the renderer

All channels were found with a multiline-aware scan of every renderer chunk. Main handler lines are from EM (see `01-electron-main.md` §10 for the main-side semantics).

### 3.1 Renderer → main (`invoke` = request/response, `send` = fire-and-forget)

| Channel | Kind | Renderer caller (wrapper in `ih()` unless noted) | Args → return | Main | Online? | Linux port |
|---|---|---|---|---|---|---|
| `getRunConfig` | invoke | MN:4076, FB:371, NT:52 | → runConfig (§1.3) | EM:17421 | – | keep; `mac:""` |
| `startupBackendService` | invoke | `backendStartup` ST:14163 (Startup MN:171) | → port number (−1 after 3 failed spawns) | EM:17431 | main refreshes MonitorInfo.json online first (01 §8.2) | keep; spawn the Linux backend; no fetch |
| `getMonitorJsonConfig` | invoke | ST:14267 (MN:199) | → `{OTAEnable:bool, config:{<model>:{Name,SupUsbDDC,SupOTA,SupLightEffect,SupLightSync,HDR}}}` | EM:17584-17605 | – | keep; build from bundled `MonitorInfo.json`; return `OTAEnable:false` |
| `interfaceInitializeCompleted` | send | ST:14169 | – | EM:17445 | – | keep (window resize to working size) |
| `resetToStartSize` | send | ST:14166 | – | EM:17435 | – | keep (880×520 non-resizable) |
| `minimize` / `close` | send | ST:14172 / ST:14181 | `close(forceMain=false)` hides the focused window | EM:17473 / EM:17487 | – | keep |
| `maximizedValue` / `maximizeToggler` | invoke | ST:14175 / ST:14178 | → bool | EM:17476 / EM:17480 | – | keep |
| `fileSelect` | invoke | ST:14184, FB:79 | `OpenDialogOptions` → `{path,size,buffer}` | EM:17491 | – | keep |
| `exportFile` | invoke | ST:14191 | `{title,defaultPath,filters}` → `{canceled,filePath}` | EM:17514 | – | keep |
| `getFileSize` | invoke | ST:14188 | path → bytes | EM:17513 | – | keep |
| `getFileMd5` | invoke | ST:14264 (cloud upload only) | path → md5 hex | EM:17572 | – | optional |
| `runCommand` | invoke | ST:14199; peripheral FW flashers (ST:33896-33913), SmartDesktop installer, headset DTS setup | cmd string → `{error, stdout}` | EM:17515 | – | **drop** (security; Windows-only uses) |
| `extractZip` / `findExe` | invoke | ST:14255 / ST:14258 | zip[, dir] → dir; dir, ext → path | EM:17534 / EM:17555 | – | drop (FW / plugin install) |
| `setLanguage` | send | ST:14203 | code | EM:17566 (+ EM:9284 relays to child windows) | – | keep |
| `setAutoStartUp` | send | ST:14206 | `(enable[, minimize])` | EM:17569 | – | keep → XDG autostart |
| `notice` | send | ST:14209 (MN:1941-1946 DPI and low-battery notices) | `(show:boolean, i18nKey, ...params)` | EM:9266 | – | keep (notice window or libnotify) |
| `checkSoftwareVersion` | send | ST:14158 (`ipcCheckSoftwareUpdates`; shows a SERVER loading overlay until `versionCheckResult` arrives) | – | EM:16606 | **yes** | drop the button; if kept, main must answer `versionCheckResult` `{state:0}` or the overlay stays up |
| `softwareDownload` / `softwareInstall` / `cancelSoftwareUpgrade` | send | ST:14240 / ST:14243 / ST:14246 | – | EM:16609-16611 | **yes** | drop |
| `createDownload` / `cancelDownload` | send | ST:14249 / ST:14252 (`Sy()` ST:33564) | `(url, hashValue, hashMethod, dir)` / url | EM:16513 / EM:16516 | **yes** | drop |
| `imageResourceDownload` | invoke | ST:14276 (`Pb` ST:44445) | `{model,url,fileName,hashMethod:"md5",hashValue}` → dir | EM:17612 | **yes** | drop (resolve `""`) |
| `getCloudFileCacheOrDownload` | invoke | ST:14279 | `(fileName, md5, url)` → local path | EM:17634 | **yes** | drop |
| `openDefaultBrowser` | send | ST:14261 (MN:1868 logo; licence links ST:30641) | url | EM:17647 (the Linux branch is buggy: `"xdg-open"+t`, no space) | opens browser | no-op or local only |
| `openFeedbackWindow` | send | ST:14282 (General, ST:30265) | – | EM:9263 | leads to online | drop |
| `closeFeedbackWindow` | send | FB:177 | – | EM:9260 | – | drop with feedback |
| `getSystemInfo` | invoke | FB:118 | → `{tmpDir,appDataDir,computerName,osType,osPlatform,arch,release,uptime,totalmem}` | EM:17573 | feeds online feedback | drop |
| `getMac` | invoke | ST:33072 (`Cv`) | → MAC string | EM:17533 | feeds online calls | drop or return `""` |
| `disableTrayExit` / `disableTrayFunction` | send | ST:14270 / ST:14273 | bool | EM:17606 / EM:17609 | – | keep |
| `shieldDisplayChange` | send | ST:14285 (monitor pages) | `(on:boolean, autoOffSeconds=4)` | EM:17650 | – | keep (suppresses self-inflicted display events) |
| `shieldPeripheralChange` | send | ST:14288 | bool | EM:17658 | – | keep |
| `checkNodeAvailable` | invoke | ST:14291 (MN:2107, ST:35120) | → `{available, extractPath}` | EM:17005 | – | return `{available:false}` |
| `discoverBulb`, `pairingBulb`, `commissionBulb`, `openCommissioningWindow`, `identifyBulb`, `getBulbAttribute`, `setBulbAttribute`, `removeBulb`, `clearCache`, `destroyBulbProcess` | invoke | `aD()` ST:34805-34873; MN:2163-2171 | Matter smart-bulb bridge (`resources/matter/control.mjs`) | EM:17005-17036 | LAN/Matter | drop (the user has no Philips bulb) |

Main handles `getCurrentProcess` (EM:17006) and `setWindowSize` (EM:17556), but no renderer chunk calls them.

### 3.2 Main → renderer events (`window.ipc.on/once`)

| Channel | Payload | Renderer handler | Source in main | Linux port |
|---|---|---|---|---|
| `displayChange` | – | Startup S() flag (MN:188); Home detection → `Device_DetectionDisplay` (MN:1795) | Windows `WM_DISPLAYCHANGE` (msg 126), debounced 2 s (EM:17234, 17662-17670) | Electron `screen` `display-added/removed/metrics-changed`, or a udev `drm` change, debounced 2 s |
| `USBChange` | – | Startup (MN:189); Home → `Device_DetectionUSB` (MN:1796); Setting page → `GetPairDevices` (ST:35354) | `usb` attach/detach, +1 s delay, 2 s lock (EM:17237-17242) | node-usb works on Linux (libusb/udev) |
| `otherDeviceChange` | – | Home → `Device_OtherDeviceChange` (MN:1797) | Windows `WM_DEVICECHANGE` (msg 537), 1.7 s delay | udev `hidraw` add/remove, or fold into USBChange |
| `newVersionPrompt` | `{state, versionNum, packageUrl, description[]}` | once, then bus → `saveNewVersion` (ST:14212, MN:2112) | EM:17274 | never send |
| `versionCheckResult` | same, plus `isStartup` | bus → Home shows the SoftwareVersionUpdate dialog and hides loading (MN:1717-1734) | EM:16639 | never send (unless the check button is kept) |
| `checkSoftwareUpgrade` | – | triggers `checkSoftwareVersion` (ST:14214) | tray menu (EM:17338) | drop from tray |
| `toPageView` | `"overview"`, `"setting"` or `"message"` | Toolbar navigation (MN:598-612) | tray (EM:17290, 17355) | keep |
| `rescan` | – | Home: go to Overview, `Device_Rescan`, `saveDeviceList` (MN:1844-1853) | tray (EM:17329) | keep |
| `mainWindowShow` | – | recompute root font size (MN:2135) | EM:17295 | keep |
| `thirdPartySuccess` | query object of the `EvniaPrecisionCenterApp://` deep link: `{type:"ISLOGIN"/"ISASS", code, preState, ...}` | login / associate (ST:14217-14230) | second-instance handler (EM:17157-17166); protocol registered at EM:17742 | drop (do not register the protocol) |
| `matterNotification` | `{uniqueId, type, ...}` | bulb manager | EM:16911, 16962 | drop |
| `loginShow` | – | opens login (ST:14232) | **no sender in main** (dead) | – |
| `downloadProgressUpdate` / `downloadSuccess` / `downloadFail` | `{url, percent}` / `{url, path, filename, ...}` / `{url, msg}` | MN:729-731, ST:33577-33589 | EM:16530-16556 | drop |
| `setNotice` (notice window) | `(i18nKey, ...params)` | NT:30 | EM:9272 | keep if notices are kept |
| `setLanguage` (child windows) | code | NT:33, FB:186 | EM:9285-9286 | keep |

---

## 4. SignalR client (`ST:7888-8032`)

### 4.1 Library and connection parameters (CONFIRMED)

- Library: `@microsoft/signalr` **7.0.14**. The user-agent header value is `Microsoft SignalR/7.0 (7.0.14; ...)` (ST:6148-6160). Browser WebSocket connections cannot set custom headers, so it is not sent here (INFERRED).
- Builder (ST:7900-7904):
  ```js
  new HubConnectionBuilder()
    .configureLogging(LogLevel.Debug)
    .withUrl(`http://localhost:${port}/EvniaHub`, { skipNegotiation: true, transport: HttpTransportType.WebSockets, timeout: 120000 })
    .withAutomaticReconnect()      // default delays [0, 2000, 10000, 30000, null] (ST:6972-6980)
    .build();
  ```
- Effective URL: `ws://localhost:<port>/EvniaHub`. `skipNegotiation` means no `/negotiate` POST and no `id` query parameter; the client opens the WebSocket directly. `timeout:120000` is the HttpClient timeout and does not matter for pure WS.
- HubConnection defaults (ST:6430-6431): `serverTimeoutInMilliseconds = 30000`, `keepAliveIntervalInMilliseconds = 15000`.
- Protocol: JSON hub protocol v1 (`qc`, ST:7755-7809); messages end with record separator 0x1E (ST:6352-6360).
- Port: the value resolved by `ipc.invoke("startupBackendService")` (MN:171-183). Main probes from 10010 upward for a free port (EM:13558-13580) and starts `EvniaServe.exe --urls http://*:<port>`. ELOG shows 10010 every time.
- Created once. `ou(port = 10010)` (ST:8024-8032) stores the instance in module variable `tu`. In unpackaged or debug mode (`!isPackaged || isDebugMode`) it is also exposed as `window.connect` for console debugging.

### 4.2 Wire protocol (CONFIRMED from library code + BLOG request strings)

```
C→S  {"protocol":"json","version":1}\x1e                                  (handshake, ST:6496-6499)
S→C  {}\x1e                                                               (handshake OK; ASP.NET Core)
C→S  {"type":6}\x1e                                                       (ping right after handshake; WS has no inherent keep-alive, ST:6508)
C→S  {"arguments":["{\"functionName\":\"Start\",\"requestId\":\"8f2b...\",\"parms\":null}"],
      "invocationId":"0","target":"GetTaskAsync","type":1}\x1e            (Invocation; invocationId counts up per connection, ST:6600-6613)
S→C  {"type":1,"target":"GetTaskAsync","arguments":["{\"err_code\":0,...,\"RequestId\":\"8f2b...\",\"Tag\":...,\"FunctionName\":\"Start\",...}"]}\x1e
S→C  {"type":3,"invocationId":"0"}\x1e                                    (Completion, hub method returns Task → no result)
S→C  {"type":1,"target":"Notification","arguments":["{\"err_code\":0,...,\"RequestId\":null,\"Tag\":{...},\"FunctionName\":\"NotifyDeviceConnectionStatus\"}"]}\x1e
C↔S  {"type":6}\x1e every 15 s (client); server must send something at least every 30 s
```

Requests seen in BLOG, verbatim apart from the `requestId`:

```
{"functionName":"Start","requestId":"<uuid>","parms":null}
{"functionName":"Profile_GetDeviceData","requestId":"<uuid>","parms":[100000]}
{"functionName":"PHL_SwitchDisplay","requestId":"<uuid>","parms":["AU00000000001"]}
{"functionName":"PHL_SetOSD","requestId":"<uuid>","parms":["EXT_OP_E2A0_43_AutoWarning",1]}
{"functionName":"Macro_GetList","requestId":"<uuid>","parms":["User"]}
```

`100000` is the device type of the attached PHL display, and `AU00000000001` is its serial number, used as `DisplaySN`.

Server side (DC/EvniaServe/Evnia/EvniaHub.cs; see `05-backend-host.md` §3):
- `GetTaskAsync(string parm)` runs the dispatcher and then `await Clients.All.SendAsync("GetTaskAsync", resultJson)`. The reply is a **broadcast to every connected client**, and it is pushed *before* the Completion.
- Notifications go out through `HandleEvent.StartClient.All.SendAsync("Notification", json)` (DC/EvniaServe/Evnia/HandleEvent.cs).
- Server hub options: `MaximumReceiveMessageSize = 1 MiB`, application and transport max buffer 1 MiB (Startup.cs:55-58, 81-85).
- The backend listens on `http://*:10010` (**all interfaces**). The Linux backend must bind to `127.0.0.1`.

### 4.3 Client class `Jc` (CONFIRMED, ST:7888-8021)

| Member | Behaviour |
|---|---|
| `constructor(port, events)` | Builds the hub, registers the close, reconnecting and reconnected callbacks, and registers `hub.on(name, s => handleResponse(JSON.parse(s)))` for each of `["GetTaskAsync","Notification"]` (`eu`, ST:8022). |
| `run()` | `connect(resolve)`; the promise resolves after the first successful `start()`. |
| `invoke(functionName, ...args)` | See §4.4. Returns a Promise that resolves with `Tag` or rejects with `{code: err_code, msg: err_msg}` (or with an Error from SignalR itself). |
| `subscribe(name, cb)` | Pushes `cb` into `notifyCallbacks[name]`; multiple subscribers are allowed. |
| `hasSubscribe(name)` / `unsubscribe(name)` | `unsubscribe` removes **all** callbacks for that name. |
| `setEventHandler({ON_CONNECTED, ON_RECONNECTED, ON_RECONNECTING, ON_CLOSE})` | Connection lifecycle hooks. |
| `setWithoutLogMethods([...])` | Suppresses console logging for noisy functions. Set to `["Effect_CheckDynamicLightingEnabled","Effect_GetLEDs","NotifyAmbiScapeFollowVideoData"]` (ST:8027). |
| `setConcurrentMethods([...])` | Functions whose replies are accepted even when a newer request with the same name is pending. Set to `["Theme_GetThemeInfos","DeviceSteup_GetPowerInfo"]` (ST:8028). |
| `createUUID()` | v4-shaped UUID seeded by `Date.now()` plus `Math.random()` (ST:7965-7971). |

`Dy` (ST:33761-33776) is the app-wide facade built on it:

```js
Dy = { system:Gh(), fancyZones:Ey(), theme:vy(), device:Hu(), macro:yy(),
       subscribe:(n,cb)=>tu.subscribe(n,cb),
       subscribeIfAbsent:(n,cb)=>!tu.hasSubscribe(n)&&tu.subscribe(n,cb),
       unsubscribe:n=>tu.unsubscribe(n) }
```

### 4.4 Building requests (CONFIRMED, ST:7918-7946)

```js
async invoke(fn, ...args) {
  if (hub.state !== "Connected") await sleep(4000);            // single 4 s grace wait, then sends anyway
  return new Promise((resolve, reject) => {
    const id = createUUID();
    waitingResponse[fn] = id;                                  // latest-wins per function name
    requestCallbacks[id] = r => (r.err_code !== 0 || r.err_msg) ? reject({code:r.err_code,msg:r.err_msg}) : resolve(r.Tag);
    hub.invoke("GetTaskAsync", JSON.stringify({functionName:fn, requestId:id, parms: args.length ? args : null}))
       .catch(reject);                                         // transport errors reject with an Error object
  });
}
```

Consequences for backend implementers:
- **`device` is never sent.** Backend `InputParams.device` defaults to −1. If a client sent it, `Class0` would prepend it to the call arguments while overload matching uses only `parms`, so it would not work (DC/EvniaServe/Class0.cs:77-100).
- `parms` is `null` when there are no arguments, otherwise a JSON array.
- The backend resolves overloads by JSON token type: Integer → `int`, String → `string`, Boolean → `bool`. **Any other token type (Float, Null, Object, Array) fails** with `"Unsupported parameter type: <T>"` and err_code 9 (Class0.cs:115-171).
- `undefined` arguments become `null` inside the stringified array and fail the same way.
- Structured data is passed as JSON **strings**. Examples: `SyncEffect_EnableDevice(n, JSON.stringify(list))` (ST:8667), `Theme_Add` and `Theme_UpdateBindApp` with `JSON.stringify([{BindAppFilePath,BindAppIconPath}])` (ST:33662-33676), `FancyZones_SetSetting("FancyzonesShiftDrag", bool.toString())` (ST:33629).
- **Success rule:** `err_code === 0 && !err_msg`. A non-empty `err_msg` with code 0 still counts as an error.

### 4.5 Correlating responses (CONFIRMED, ST:7975-7995)

```js
handleResponse(e) {                 // e = parsed JsonResult
  const {FunctionName:fn, RequestId:id} = e;
  if (e.RequestId) {                // reply
    if ((waitingResponse[fn] === id || allowConcurrentlyMethods.includes(fn)) && requestCallbacks[id]) {
      requestCallbacks[id](e); delete requestCallbacks[id];
    }                               // else: silently dropped
  } else if (notifyCallbacks[fn]) { // notification (RequestId null/empty)
    for (let i = cbs.length; i--;) cbs[i](e.Tag);        // newest subscriber first
  }
}
```

- **Latest-wins.** If a second request for the same `functionName` is issued before the first reply arrives, the first promise **never settles** and its callback leaks. Only the two functions in the concurrent list are exempt.
- The same handler serves both server targets, so notifications are told apart only by an empty `RequestId`.
- Replies are broadcast, so a reply meant for another client is ignored because its `requestId` is unknown.
- Envelope fields the client reads: `FunctionName`, `RequestId`, `err_code`, `err_msg` and `Tag`. The backend also serialises `IsSucc` and `CurrItem`.
- Serialisation defaults: Newtonsoft, nulls included, enums as integers. `Profile_GetDeviceData` uses `ConditionContractResolver(IgnoreUI)` with nulls included (Zeasn.Com.Lib/Extension_Json.cs:37-85; Class0.cs:46-50). So a reply looks like:
  `{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":"<uuid>","Tag":<payload>,"FunctionName":"<fn>","CurrItem":null}` (property order INFERRED from declaration order).

### 4.6 Timeouts

| What | Value | Source |
|---|---|---|
| Wait before sending while not Connected | 4000 ms, once | ST:7921-7925 |
| Per-request reply timeout | **none**. A missing reply leaves the promise pending, and any loading overlay (`vu()`, ST:8290-8308) stays visible. | – |
| Client ping interval | 15000 ms | ST:6431 |
| Server-silence timeout | 30000 ms, then the connection closes and the reconnect logic starts | ST:6430 |
| HTTP timeout option | 120000 ms (unused with WS) | ST:7902 |

### 4.7 Reconnect behaviour (CONFIRMED)

1. **Built-in automatic reconnect** (`withAutomaticReconnect()`): retries after 0, 2000, 10000 and 30000 ms, then gives up and fires `onclose`.
   - While it runs, `onreconnecting` fires `ON_RECONNECTING`.
   - Startup's handler (MN:177-180) sleeps 3000 ms and calls `ipc.invoke("startupBackendService")` again, so main re-verifies or restarts EvniaServe. That also triggers main's online MonitorInfo refresh.
   - Because `tu` already exists, no new hub object is created. **The port returned by that call is ignored**, so a backend restarted on a different port is never reached (INFERRED quirk).
2. `onreconnected` fires `ON_RECONNECTED`, which runs `I()` (MN:211-221): loading overlay, `Start`, then `shieldDisplayChange(false)` and `shieldPeripheralChange(false)`.
3. `onclose` (ST:7997-7999) calls `connect()` **without** a resolve callback. That retries `hub.start()` every 2000 ms **forever** (ST:8007-8016). On success it fires `ON_CONNECTED`, which re-runs the full init `S()` (§4.8). `ON_CLOSE` is also fired but has no handler.

### 4.8 Startup sequence (CONFIRMED, MN:148-270; order matches BLOG)

1. The Startup component mounts: `ipc.send("resetToStartSize")` (880×520), then sleep 3000 ms.
2. If `store.userInfo.token` exists, the token is refreshed **online** (`Ov`: PUT saas `/user/device/token/refresh`). On failure `userInfo` is cleared. Not the user's case.
3. `backendInit` → `ipc.invoke("startupBackendService")` returns the port → `ou(port).setEventHandler({...}).run()`, then `S()`:
   1. Temporarily listen for `displayChange` and `USBChange`.
   2. Call `Start`. If a display or USB change happened meanwhile, also call `Device_DetectionDisplay` or `Device_DetectionUSB`.
   3. Call `Device_GetConnectList`, then `mainStore.saveDeviceList(list)` (ST:44635-44727). This maps devices with `Tb()` (ST:44421-44444), writes `localStorage.deviceInfo`, calls `DisplayFW_GetDeviceList` (to `localStorage.monitorFw`) and picks active devices. **For unknown models it requests online image resources (§O-3).**
   4. `C()`, **not awaited** (MN:198): `Theme_GetThemeInfos`, then `Theme_GetCurTheme`, then `Macro_GetFuncMenu` and `Macro_GetList(<theme>)`. The bus event `factoryReset` is subscribed and re-runs `C()`.
   5. In parallel with step 4: `ipc.invoke("getMonitorJsonConfig")`, then `mainStore.isBackendInit = true`, `monitorStore.$patch({OTAEnable, configInJson})` and `ipc.send("interfaceInitializeCompleted")`.
4. `App` sees `isBackendInit` and swaps Startup for Home. It then dispatches `resize`, navigates to `/` and calls `ipc checkNodeAvailable` → `setBulbEnabled(ambiScapeEnable && available)` (MN:2103-2110).
5. Home mounts:
   - `SyncEffect_GetData` → `saveSyncModels(SyncDevices)`.
   - `Effect_GetColorData` → `saveEffectColors`.
   - Subscriptions (§6).
   - Then either the update prompt or the login overlay (MN:1860-1867).

BLOG order on 2026-09-26 (CONFIRMED):

| Time | Calls | Source |
|---|---|---|
| 07:52:30 | `Start` | startup |
| 07:52:52 | `Device_GetConnectList`, `DisplayFW_GetDeviceList` | `saveDeviceList` |
| 07:52:54 | `Theme_GetThemeInfos`, `SyncEffect_GetData`, `Effect_GetColorData`, `Theme_GetCurTheme`, `Macro_GetFuncMenu`, `Macro_GetList ["User"]` | `C()` interleaved with Home mount |
| 07:53:01 | `PHL_SwitchDisplay ["AU00000000001"]`, `Profile_GetDeviceData [100000]`, `PHL_GetConstraints` (then a Notification) | user clicked the monitor card |
| 07:53:18 | `Setting_GlobalData`, `GetPairDevices` | Setting page |
| 07:54:01 | `Device_OtherDeviceChange` | `otherDeviceChange` event |
| 08:02:36 | `FancyZones_GetVersion`, `DisplayFW_CheckUpstreamCable`, `DisplayFW_GetMonitorCount` | SmartDesktop page and firmware validation, i.e. online `Mv` checks happened here |

---

## 5. Hub functions called by the renderer (140)

Every wrapper lives in ST. Wrappers named `x(t, o)` with `o || e` default their device-type argument to the facade's bound device type (`updateDeviceType`). Argument order is the wire order. The detailed semantics belong to the backend and device reports (see Cross-references).

### 5.1 System / global (`Gh()`, ST:29887-29953)

| Wrapper | functionName(parms) |
|---|---|
| systemInit | `Start()` |
| getDeviceList | `Device_GetConnectList()` → `[DeviceInfo]` (fields used by `Tb`: `EquipmentType, AliasName, ModelName, ExtModel, ConnectMode, StrFwVersion, FwVersion, MaxFw, SupSync, DeviceType, Pid, Vid, ExtDeviceInfo{CurSN, DisplayList[{DisplaySN, MonitorName,...}], DP_ComponentID, DP_DeviceType, DP_Receiver*, IDCode}, HasBattery, SupEffect, SupGameMode, ProfileCount}`) |
| getDeviceInfo | `Device_GetDeviceInfo(deviceType)` |
| rescan / detectUsb / detectOtherDevice | `Device_Rescan()`, `Device_DetectionUSB()`, `Device_OtherDeviceChange()` → each returns a device list |
| getSettingGlobalData | `Setting_GlobalData()` → `{EnableAllowControlLights, TurnOffLightsWhenDisplayTurnOff, TurnOffLightsWhenIdle, TurnOffLightsWhenIdleDuration}` |
| setTurnOffLightsWhenIdle / …Duration | `Setting_TurnOffLightsWhenIdle(bool)`, `Setting_TurnOffLightsWhenIdleDuration(int minutes)` (0 is coerced to 5, ST:30029-30035) |
| setEnableAllowControlLights / setTurnOffLightsWhenDisplayTurnOff | `Setting_EnableAllowControlLights(bool)`, `Setting_TurnOffLightsWhenDisplayTurnOff(bool)`: **not implemented in Bridge**; wrappers unused |
| setFactoryReset | `FactoryReset()`, then bus `factoryReset` |
| getThemeGetDevicesBasicInfo | `Theme_GetDevicesBasicInfo(-1)` (AboutDevice) |
| getSystemDynamicLight / toDynamicLightSetting | `Effect_CheckDynamicLightingEnabled()` / `Effect_OpenDynamicLightingSetting()` (Windows Dynamic Lighting) |
| getPairDeviceList / pairPrepare / pairStart | `GetPairDevices()` → `[{Name,DeviceType,HidStr}]`; `CanEnterPairing(deviceType, hidStr)` (errors 1001001, 1001002); `EnterPairing(deviceType, hidStr)` |
| getWifiList | `GetWifiList()` → `[{Ssid,...}]` (bulb commissioning) |

### 5.2 Monitor (`yu()`, ST:8310-8503)

- `Device_DetectionDisplay()`
- `PHL_SwitchDisplay(displaySN)`
- `Profile_GetDeviceData(deviceType)`
- `PHL_ReloadData()`
- `PHL_GetConstraints()`: its reply is followed by a `NotifyUIDisplayFuncConstraintsChange` notification (BLOG 07:53:01 / 07:54:14)
- `Effect_GetMenu(dt)`
- `PHL_SetSmartImage(v)` (SmartImage and SmartImage HDR)
- `PHL_SetColorPreset(v)`
- `PHL_SetInputSource(a,b,c,d,e)`
- `PHL_SwrapPIPPBP()`
- `PHL_ResetSmartImage(v)`
- `Profile_Reset(dt)`
- `DisplayFW_GetDeviceList()`, `DisplayFW_UpdateFirmversion(scalerName, type, filePath)`, `DisplayFW_CheckUpstreamCable()`, `DisplayFW_GetMonitorCount()`
- `PHL_SetAudioEQ(a,b)`
- `PHL_SwitchSmartFrame(v)`, `PHL_SetSmartFrameSize(v)`
- ENE effect family (same functions as §5.6)
- `Effect_GetLEDs(dt)`

**`PHL_SetOSD(attributeName, value)`** is used by these wrappers (ST:8311-8500):

| Wrapper | attributeName |
|---|---|
| setBrightness | `OP_10_Luminance` |
| setContrast | `OP_12_Contrast` |
| setSharpness | `OP_87_Sharpness` |
| setSaturation | `OP_8A_Saturation` |
| setHue | `OP_90_Hue` |
| setGamma | `OP_72_Gamma` |
| setColorTemperatureRGB | `OP_16_VideoGainDriveRed`, `OP_18_VideoGainDriveGreen`, `OP_1A_VideoGainDriveBlue` |
| setSmartContrast | `OP_F0_SmartContrast` |
| setColorSpace | `EXT_OP_E2A0_20_ColorSpace` |
| setLightEnhancement | `EXT_OP_E2A0_3D_LightEnhancement` |
| setColorEnhancement | `…_3E_ColorEnhancement` |
| setDarkEnhancement | `…_3F_DarkEnhancement` |
| setDLBL | `…_24_DLBL` |
| setInputAuto | `OP_ED_InputAuto` |
| setVolume | `OP_62_AudioSpeakerVolume` |
| setMute | `OP_8D_AudioMute` |
| setAudioMode | `EXT_OP_E2A0_00_AudioMode` |
| setAudioSource | `OP_E0_AudioSource` |
| setEffectMode | `EXT_OP_E2A0_19_AmbiglowLightMode` |
| setEffectColor | `…_1A_AmbiglowColors` |
| setEffectPosition | `…_1B_AmbiglowLightPosition` |
| setEffectBrightness | `…_1C_AmbiglowLightBrightness` |
| setEffectSpeed | `…_1D_AmbiglowLightSpeed` |
| setEffectDirection | `…_1E_AmbiglowLightDirection` |
| setSmartFrameBrightness / Contrast | `EXT_OP_E2A0_0A` / `…_0B` |
| setSmartFramePositionHz / Vt | `…_0C_SmartFrameHPosition` / `…_0D_SmartFrameVPosition` |
| setSmartSize | `OP_86_DisplayScaling` |

The monitor pages (outside this scope) additionally use:
- `EXT_OP_E2A0_02_MBR`, `03_MBRSync`, `04_SmartCrosshair`, `06_SharpShooter_Size`, `07_LowInputLag`, `08_SmartFrame`
- `0E`/`0F`/`10`/`11` OSD position, transparency and timeout
- `12_USB_C_Setting`, `13_USB_StandbyMode`, `14_USB_Upstream`, `15_KVM`, `16_SmartPower`, `17_CEC`, `18_LocalDimming`
- `25_SharpShooter_Location`, `34_PixelOrbiting`, `35_ScreenSaver`, `36_PixelRefresh`, `37_PanelRefresh`
- `3A`/`3B`/`3C` HDMI1-3 refresh rate
- `40_AdaptiveSync`, `41_FanControl`, `43_AutoWarning`, `44_StarkShadowBoost`, `45_ShadowBoost`, `47_UniBright`, `48_MultiLogoProtection`, `49_BoundaryDimmer`, `4A_TaskbarDimmer`, `4B_ThermalProtection`, `4C_Overclock`
- `54_PixelRefreshCounts`, `55_PanelRefreshCounts`, `59_DualResolution`, `61_AutoPixelRefresh`, `68_AutoRefineAIStatus`
- `OP_54_PerformancePreservation`, `OP_A5_WindowSelect`, `OP_CC_OSDLanguage`, `OP_DA_ScanMode`, `OP_E9_ResolutionNotifier`, `OP_EB_SmartResponse`, `OP_F2_PowerLED`

This list was produced by a grep of all chunks. The attribute-name → VCP mapping is in the monitor/DDC report.

### 5.3 Keyboard (`Du()` ST:8504), mouse (`Tu()` ST:8526), pad (`Pu()` ST:8569), headset (`Au()` ST:8579)

- Keyboard: `Profile_GetDeviceData`, `Keyboard_GetGameMode`, `Keyboard_SwitchGameMode(dt,bool)`, `Keyboard_SetGameMode(dt,a,b)`, `Keyboard_ResetGameMode`.
- Mouse: `Profile_GetDeviceData`, `Mouse_ChangeDPILevel`, `Mouse_ChangeLod`, `Mouse_ChangeDPI`, `Mouse_ChangeDPIValue(dt,a,b,c)`, `Mouse_ChangeSmartDPI`, `Mouse_BindSmartDPIToButton(dt,btn,v)`, `Mouse_ChangeRepotRate` (sic), `Mouse_ChangeDoubleClickSpeed`, `Mouse_ChangeScrollSpeed`, `Mouse_ResetParam`, `Mouse_GetMouseMenu`.
- Pad: `Profile_GetDeviceData`.
- Headset (DTS): `Profile_GetDeviceData`, `DTS_SetAPO`, `DTS_SetRooms`, `DTS_SetStereoPreference`, `DTS_SetBassTbhdx`, `DTS_SetDialogEnhancement`, `DTS_SetPreset`, `DTS_SetGeqBandGain`, `DTS_GraphicEqRest`, `DTS_SaveGeqBandGain` (all `(dt, v)` or `(dt)`).

### 5.4 Device setup (`nu()`, ST:8033-8075)

`DeviceSteup_GetSetupMenu(dt)`, `DeviceSteup_GetSetupData(dt)`, `DeviceSteup_GetPowerInfo(dt)` → `{ConnectMode,ChargeStatus,BatteryValue,Time}` (concurrent), `DeviceSteup_GetBatteryCurrent(dt)` → `{Time}`, `DeviceSteup_SetLowBetteryValue`, `DeviceSteup_SwitchStartupEffect`, `DeviceSteup_LightEnable`, `DeviceSteup_SwitchLightSleep`, `DeviceSteup_SetLightSleepTime`, `DeviceSteup_SwitchDeepSleep`, `DeviceSteup_SetDeepSleepTime` (all `(dt, v)`), `Device_UpgradeFw(dt, filePath)`.

### 5.5 Buttons (`Lu()` ST:8732) and onboard (`Ru()` ST:8677)

- Buttons: `Button_GetFuncMenu(dt)`, `Button_SetFunc(dt, layer, buttonId, menuId, funcId, funcValue="", ext="")`, `Button_SetKeyboard(dt, a, b, c, d, e=-1, f=-1, g=-1)`, `Button_SetMacro(dt, a, b, c, d, e)` (errors 1005001 "MacroBoundNoSupport", 1005002 "MacroBoundNoMemory"), `Button_RestButtons(dt, layer)`.
- Onboard: `Profile_GetBoard(dt)`, `Profile_EnableOnboard(dt,bool)`, `Profile_SwitchOnboard(dt,i)`, `Profile_ApplyOnboard(dt,a,b,c)`, `Profile_ResetOnboard(dt, i | -1)`, `Profile_SyncOnBoard(dt)`, `Profile_ClearOnBoardMacro(dt,i)`.

### 5.6 Lighting (`bu()`, ST:8619-8676)

`Effect_GetMenu(dt)`, `Effect_GetColorData()` → `{DefColors:[{R,G,B}], SelfColors:"#rrggbb,..."}`, `Effect_Enable(dt,bool)`, `Effect_Change(dt,mode)`, `Effect_SetSelfColors(csv)`, `Effect_ColorChange(dt,a,b,c)`, `Effect_RandomEnable`, `Effect_RainbowEnable`, `Effect_RegionChange`, `Effect_DirectionChange`, `Effect_BrightnessChange`, `Effect_SpeedChange`, `Effect_Reset`, `SyncEffect_GetData()` → `{SyncDevices:[{ModelName,SyncStatus}]}`, `SyncEffect_EnableDevice(n, jsonString)` (clearing passes `"[]"`), `AmbiScape_EnableFollowVideo(bool, intervalMs)` (100 ms from App, 500 by default, 0 = off).

### 5.7 Themes, profiles, macros, SmartDesktop

- `vy()` (ST:33641-33723):
  - `Theme_GetThemeInfos()` (concurrent) → `[{Name, BindAppInfos[{BindAppFilePath,BindAppIconPath}], IsDefault, ProfileNames[], SelProfileName, CycleProfileNames[], SmartImageSwitch, SmartImages[{Name,Value}], SelSmartImage}]` (mapper `Wm`, ST:13384-13396)
  - `Theme_GetCurTheme()`, `Theme_Switch(theme, profile|"")`, `Theme_SwitchApp(theme)`, `Theme_UpdateBindApp(theme, json)`, `Comm_GenAppIcon(exePath)` → icon path
  - `Theme_Add(name, json)`, `Theme_Rename`, `Theme_Del`, `Theme_ImportProfile(theme, path, overwrite)`, `Theme_ExportProfile(theme, profile, path)`
  - `Theme_AddProfile`, `Theme_RenameProfile`, `Theme_CopyProfile`, `Theme_DelProfile`, `Theme_ResetCurProfile`
  - `Theme_GetDevicesBasicInfo(theme, [profile,] -1)`, `Theme_GetProfileDesc(theme[, profile])`, `Theme_ApplyProfile(a,b,c,d)` (cloud apply), `Theme_HandleCycleProfile(a,b,c)`
  - `Theme_EnableSmartImage` and `Theme_SetSmartImage`: **not implemented in Bridge**; wrappers unused
- `yy()` (ST:33724-33760): `Macro_GetList(theme)` → `[{MacroName, IsComMacro}]`, `Macro_VerifyFile`, `Macro_GetDetail`, `Macro_Rename`, `Macro_Update`, `Macro_Add`, `Macro_Copy`, `Macro_Del`, `Macro_Import`, `Macro_Export`, `Macro_GetFuncMenu()` → `{Items}`.
- `Ey()` FancyZones / SmartDesktop (ST:33604-33640; Windows PowerToys FancyZones): `FancyZones_GetVersion` → `{StrVersion, Version, DP_DeviceType, DP_ComponentID}`, `FancyZones_GetData` → `{Enable, FancyZonesSettings.Properties.FancyzonesShiftDrag.Value}`, `FancyZones_Enable(bool)`, `FancyZones_SetSetting("FancyzonesShiftDrag","true"|"false")`, `FancyZones_StartEditor()`.

### 5.8 Bridge coverage (CONFIRMED by diffing against `DC/Bridge.Lib/Bridge.Lib/Bridge.cs`)

- Called by the renderer but missing in Bridge (the backend would return err_code 9 "undefined"): `Setting_EnableAllowControlLights`, `Setting_TurnOffLightsWhenDisplayTurnOff`, `Theme_EnableSmartImage`, `Theme_SetSmartImage`. None of them is reachable from the UI.
- In Bridge but never called by any renderer chunk: `Button_GetStaticData`, `DTS_Close`, `DTS_Open`, `DisplayFW_FWUpdateFailedNextTime`, `DisplayFW_InstallDriver`, `Effect_BgColorChange`, `GetHotKeyState`, `ModifierKeyListenerEnable`, `Mouse_GetMouseParam`, `PHL_DeleteHotKey`, `PHL_EnableGamePQMouseKey`, `PHL_GetHotKeyData`, `PHL_GetHotKeyMenu`, `PHL_ProfileAction`, `PHL_Rescan`, `PHL_SetGamePQMouseKeyBind`, `PHL_SetHotKey`, `PHL_SetHotKeyEnable`, `PHL_SetHotKeyItemEnable`, `SetGamePQ`, `Theme_GetCurProfile`.
- A Linux backend can therefore skip the hot-key and GamePQ families as far as the UI is concerned.

---

## 6. Notifications

Envelope, as emitted by the backend (e.g. DC/Zeasn.Equipment.Option.Lib/.../AmbiScapeOper.cs:97-102):

```json
{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":<payload>,"FunctionName":"<name>","CurrItem":null}
```

- It is sent on target `"Notification"`. The renderer passes only `Tag` to subscribers and ignores `err_code` for notifications.
- Most device notifications wrap their payload as `NotificationDataBase {DeviceType:int, Data:object}` (DC/Zeasn.PCenter.Entity.Lib/NotificationDataBase.cs).
- The backend enum `Notification_Func` has 23 members (DC/Zeasn.PCenter.Entity.Lib/Notification_Func.cs).

| Name (enum idx) | Emitted by 1.13.0 backend? | Subscribed at | `Tag` payload used | Renderer reaction |
|---|---|---|---|---|
| `NotifyDeviceConnectionStatus` (17) | yes (peripheral drivers) | MN:1803 (Home) | `{DeviceType, Data:bool}` (ignored) | Unless peripheral changes are shielded: loading, `Device_GetConnectList`, `saveDeviceList` |
| `NotifyUIDisplayFuncConstraintsChange` (4) | yes (`DisplayFuncConstraints.Notify`, after `PHL_GetConstraints`; seen in BLOG, >1024 chars) | MN:1834 | `{FuncItems:[{FuncId:int,FuncName:string,State:int}], AudioEQ:int, ModuleGameMode:int}` | `monitorStore.optionControl[FuncId]` and `[FuncName]` = `State===1`; `[-1]`=AudioEQ, `[-2]`=ModuleGameMode (ST:9581-9587). `-2` greys out the GameMode nav item (MN:304). |
| `NotifyUISwitchTheme` | **no** (no emitter anywhere in DC) | MN:1917 | string `"Theme"` or `"Theme\|Profile"` | Switches theme or profile. Dead in 1.13.0. |
| `NotifyMacroKeyPressed` (13) | yes (RongYuan keyboard and mouse) | MN:1927 | `{DeviceType, Data:{EquipmentType}}` | Keyboard macro key: navigate to `/keyboard/macro?action=record` or emit `marcoRecording` |
| `NotifyMouseDPIChange` | **no** | MN:1935 | `{DeviceType, Data:{ModelName, Data:{DPILevelList, DPILevel, CurDPIIndex}}}` | OS notice `DPIChangeNotice`. Dead in 1.13.0. |
| `BatteryLowPowerReport` (16) | yes (RongYuan) | MN:1944 | `{DeviceType, Data:{ModelName, BatteryValue}}` | `ipc notice(true,"LowBatteryNotice",model,"NN%")` |
| `NotifyAmbiScapeFollowVideoData` (20) | yes (`AmbiScapeOper`) | MN:2184, only while a Matter bulb has AmbiScape on | `{L1..L4,T,R1..R4,B: {R,G,B}}` | Converts to HSV and sends ipc `setBulbAttribute`. The subscription is paired with `AmbiScape_EnableFollowVideo(true,100)`. |
| `FirmwareUpdateProgressData` (0) | yes (`PHLDisplayFW`) | ST:34006 | `{Name:"Update Firmware Progress", Type:"OSD", Value:number}` | Monitor OTA progress bar |
| `NotifyDevicePairResult` (19) | yes | ST:34692 | `true`/`false` (on error err_code 1002001 with `Tag:false`) | Pairing dialog success or fail |
| `NotifyUIDisplayEffectChange` (3) | yes (CDevice_PHLDisplay.cs:787-791, 851-855) | Monitor-D4qz4RBn.js:85 | Renderer expects `{ENEEnable, EffectInfo, ModuleAmbiglow}`, but the backend `Tag` is a C# **ValueTuple** `(ENEEffectEnable, EffectInfo, ModuleAmbiglow)`, which Newtonsoft serialises as `{Item1,Item2,Item3}` (INFERRED) | **Mismatch**: the handler takes the `else` branch and `Object.keys(undefined)` throws. The Linux backend should emit the named keys. |
| `NotifyEffectSyncDevicesChange` (5) | yes | LightSync-B-QWSZnT.js:350 | sync data → `q()` | peripheral light-sync UI |
| `NotifyOnboardChange` (6), `NotifyParamMouseChange` (8), `NotifyKeyboardGameModeChange` (9), `NotifyEffectChange` (10), `NotifyLightEnableChange` (11), `NotifyButtonsChange` (12), `NotifyResetDevice` (14) | yes | Keyboard, Mouse, MousePad and GameMode views | `{DeviceType, Data}` | Per-device store updates. Irrelevant for this user (no Philips peripherals). |
| `DTSStateChange` (1) | yes (TAG5106 headset) | Headset-B10qLwzf.js:45 | JsonResult-like; handler uses `e.DeviceType` and `e.Data.DtsUIStringSingle` | headset UI |
| `NotifyBatteryChange` (15), `NotifyDeviceUpgradeFwProgress` (18), `ModifierKeyListener` (21), `NotifyHotKeyExecute` (22; monitor hot-keys, CDevice_PHLDisplay.cs:1459-1588) | yes | **not subscribed** by any chunk | – | ignored by the UI |

Subscription lifetime:
- Home and App use `subscribeIfAbsent`.
- Page views subscribe in `onMounted` and `unsubscribe` in `onUnmounted`. Because `unsubscribe` removes all callbacks for a name, a page leaving can remove Home's subscription to the same name. That happens for none of the shell names (INFERRED).

---

## 7. Router and page structure

- Router: vue-router 4 with **`createWebHistory()`** (no hash; ST:44349-44418) and routes `yb` (ST:43814-44029).
- The window loads `file://…/index.html` in production (EM:17254). `App` immediately pushes `/` after backend init (MN:2105).
- Route enum `vb` (ST:43772-43813).

| Path | Name / component | Notes |
|---|---|---|
| `/` | DeviceOverview (`qu`, ST:8861) | Device cards; category or list view (`overviewType`); monitor click → `PHL_SwitchDisplay(aliasName=SN)` then `/monitor` |
| `/dashboard` | Dashboard (`Lh`, ST:29641) | Per-device preview overlay configuration (electron-store keys) |
| `/message` | Message (`xh`, ST:29827) | Static "NoNotification" placeholder |
| `/setting` | Setting (`bD`, ST:35297-35391) | Menu: General(0), AboutPCenter(1), AmbiScape(3, only if a monitor is present), AboutDevice(2), FwUpdate(4), PairingTool(5, only if `GetPairDevices` is non-empty) |
| `/account` | Account (`NA`, ST:42376) | Tabs MyProfiles, MyMacros, Setting. Toolbar only opens it when logged in, otherwise it opens Login (MN:578-580). |
| `/profile` | Profile (`Eb`, ST:43707) | Local themes (apps) and profiles, app binding, import/export, cloud import when logged in |
| `/monitor` + children | Monitor-D4qz4RBn.js | `smartImage`, `smartImageHDR`, `gameMode`, `ambiglow` (Ambiglow-Dvqon39u), `input`, `audio`, `system`, `setup`, `smartDesktop` |
| `/keyboard` + children | Keyboard-e26Z1DHa.js | `customize`, `ambiglow`, `gameMode`, `macro`, `setup`, `onboard` |
| `/mouse` + children | Mouse-CaVQ4CBf.js | `customize`, `ambiglow`, `Sensitivity` (capital S), `macro`, `setup`, `onboard` |
| `/pad` + children | MousePad-in-8FqYp.js | `ambiglow`, `setup` |
| `/headset` + children | Headset-B10qLwzf.js | `microphone`, `setup` |
| `/bulb` + `/bulb/ambiScape` | Bulb / AmbiScape-B35D_GM2.js | Matter bulb; contains zxing-wasm |

Navigation wrapper `Gl()` (ST:5844-5870): `to(path)`.
- If the current path is a sub-route of `/keyboard/macro`, it first replaces with `/keyboard/macro`.
- Between the "overlay" pages (`/dashboard`, `/message`, `/setting`, `/account`, `/profile`) it uses `replace`; otherwise `push`.
- `back()` falls back to `/`.
- `toDeviceView(EquipmentType)`.

Shell chrome (MN):
- **Sidebar** (MN:271-555) is visible only on device routes. Per-device icon lists:
  - Monitor: SmartImage or SmartImageHDR (picked by `IsSmartImageHDR`), GameMode (disabled if `optionControl[-2]` is false), Ambiglow/"Halolight" (hidden unless `configInJson[model].SupLightEffect`; the title is "Ambiglow" if the light-mode list contains `FollowVideo`, ST:9388-9394), Input, Audio, System, Setup, SmartDesktop, and a "Sync" icon that emits bus `monitorReload`.
  - Keyboard, Mouse, Pad, Headset and Bulb have their own lists.
  - A second group holds Onboard when `ProfileCount > 1`.
  - If the current child path is not in the list, it redirects to the first item (MN:467-474).
- **Toolbar** (MN:556-688):
  - Left: `home` (`/`), `dashboard` (hidden when no device is connected), `setting`, `account` (shows the avatar `<img src=userInfo.icon>` when logged in).
  - Right: minimize, maximize toggle (`maximizedValue` / `maximizeToggler`), close (disabled while `disableClose`).
- **Home header** (MN:1974-2008): brand logo (click opens `https://www.evnia.philips` in the browser, throttled 1 s), `Profile` link and a profile selector (`"Theme | Profile"` strings) → `Theme_Switch`.
- **Tutorials** (MN:885-953): keys `HomeTutorial1-3`, `MonitorTutorial1`, `DashboardTutorial1`, keyed by top-level route name. Completion is stored in `tutorials`.
- **Login overlay** (`ca`, MN:1590-1695): Login, ForgetPassword and Register sub-views. Shown on Home mount if `!loginState && !skipLoginState` (MN:1864-1865), and on bus `openLogin`.
- **SoftwareVersionUpdate dialog** (MN:689-884): driven by `versionCheckResult`, states `Vl` (ST:5826-5835): 0 Latest, 1 WithNewCache, 2 WithoutNewCache, 3 SilentDownload, 4 RunUpgrade, 5 AfterInstall.

Root font scaling (MN:2123-2136):
- Before backend init: `html{font-size:100px}`.
- After: `floor(min(innerWidth/1920, innerHeight/1080)*100)` px. The whole UI is laid out in rem for a 1920×1080 design; main sets the window to 1920×1080 after `interfaceInitializeCompleted` (ELOG "Set main window size 1920x1080").

---

## 8. State (pinia stores)

| Store id (var, line) | Key state | Notes |
|---|---|---|
| `main` (`Ab`, ST:44514-44835) | `newVersion{isProcessed,state,versionNum,packageUrl,description}`, `isNetworkOnline` (from `navigator.onLine` + `online`/`offline` events, MN:2120-2141), `emailSendFrequency`, `isBackendInit`, `bodyFontSize`, `deviceTypes{1..6:{name,equipmentType,iconName,path,connectedDevices[],activeDevice}}`, `selectedDeviceType`, `powerInfoCache{dt:{connectMode,chargeStatus,powerPercent,time}}`, `isSmartDesktopDownloading`, `downloadingSmartDesktopVersion`, `settingGlobalData{...}`, `tutorialsState`, `loginState`, `userInfo{email,emailBind,fromId,fromSource,groupId,icon,id,nm,token}`, `thirdPartyInfo`, `thirdPartyAssociatedInfo{isInit,list}`, `syncModels[]`, `effectColors{default[],customize[]}`, `bulbEnabled` | Getters: `hasMonitor`, `allDevices` (Bulb only when a monitor is present), `getDeviceInfo(eqType, deviceType)`, `isDeviceConnected`, `isAllUnconnected`, `getPowerInfo`. Actions: `saveDeviceList` (§4.8), `setActiveDevice(eqType, key)` (monitor key = `aliasName+modelName`), and `setUserInfo`, which **fetches cloud themes when the token changes** (online). |
| `monitor` (`id`, ST:9316-9600+) | `DeviceType, ModelName, IsSmartImageHDR, OP_DC_DisplayApplication, ENEEffectEnable, HasUSBSetting, DispalyData{MonitorEDIDInfo_T{...}, MonitorResolution, MonitorFrequency, MonitorOrientation}, EffectInfo, Module{Audio,GameMode,Ambiglow,Input,SmartImage,SmartImageHDR,Setup,System}, eneConfig, optionControl{}, OTAEnable, configInJson{}` | `modelNameInJson` strips a leading "PHL" and keeps the last token split on whitespace, `+`, `\|` or `_` ("PHL 34M2C8600" → "34M2C8600"). `OTASupport(model) = OTAEnable && configInJson[model].SupOTA`. `ambiglowSupport = configInJson[model].SupLightEffect`. `HDRValue = configInJson[model].HDR`. **These three depend only on `getMonitorJsonConfig`.** |
| `theme` (`Gm`, ST:13397-13435) | `themes[]` (mapped by `Wm`), `activedThemeName` ("User"), `activedProfileName` ("default1") | `allProfileList` returns `"Theme \| Profile"` strings |
| `dashboard` (`Jm`, ST:13987-14142) | `enable`, `location`, `dashboardPreview`, `dashboardOptions` | Persisted to electron-store |
| `macros` (`IP`, ST:40744) | `macroFuncMenu`, `macroFuncMap`, `macros[{name,value,isIncludeText}]`, `isRecording` | |
| `keyboard` (`jm`, 13436), `mousePad` (`qm`, 13605), `mouse` (`Qm`, 13662), `headset` (`Yu`, 8801) | per-device data | Outside this scope |

Other shared state:
- Loading overlay (`vu()`, ST:8280-8308): keyed set; shows after 100 ms; types `Nl` = NONE 0, DEFAULT 1, SERVER 2, DOT 3.
- Alert dialog (`Ou()`, ST:8705-8731).
- Pop message (`oh()`, ST:14143-14153).
- Event bus (`Bu()` returns `ku`, ST:8794; mitt-like). Events seen: `FwUpdateCompleted, USBChange, bulbRefresh, disableClose, displayChange, factoryReset, globalErrorHandle, macrosChange, mainWindowShow, marcoRecording, matterNotification, monitorReload, newVersionPrompt, openEmailAssociated, openLogin, refreshDeviceData, rescan, shieldPeripheralChange, showLoginToast, thirdPartyAssociatedEmit, thirdPartyLoginEmit, toPageView, updateThirdPlatformList, versionCheckResult, windowResize`.

Enums (ST:5643-5840):
- `EquipmentType Fl` = Monitor 1, Keyboard 2, Mouse 3, MousePad 4, Headset 5, Bulb 6.
- `ConnectMode xl` = UNKNOWN −1, USB 0, BLUETOOH 1, DONGLE 2.
- `ChargeStatus zl` = UNKNOWN −1, UNCHARGING 0, CHARGING 1, FULL 2.
- Mouse button codes `Ul` = {0:513, 1:515, 2:514, 3:516, 4:517}.
- Windows virtual-key → name map `Yl`.

---

## 9. i18n and language handling (CONFIRMED)

- Custom plugin `ph` (ST:29400-29426), not vue-i18n. `app.config.globalProperties.$t = dh`, `$getI18n`, `$setI18n`.
- `dh(key, ...params)` looks the key up in the current dictionary, replaces each `{key}` placeholder in order with a param, and **falls back to the key itself** (ST:29389-29399).
- Built-in dictionaries: array `ah` (ST:14295-29380), about 1,500 keys per language, for `en, zh-cn, zh-tw, ja, ko, ru, es, pt, fr, de`.
- When packaged, `<patchPath>/translation.json` (same array format) is merged over the built-ins at startup (ST:29402-29417). Main downloads that file as part of the online "resource pack" update (`01-electron-main.md` §12.4). On the user's machine `…/patch/RES_PCenter_101300/` is empty.
- Language selector options (`mh`, ST:29427-29438): English en, 简体中文 zh-cn, 繁體中文 zh-tw, 日本語 ja, 한국인 ko, Русский ru, Español es, Português pt, Français fr, Deutsch de.
- `setLanguage(code)` (ST:29446-29448) updates the dictionary, sends `ipc setLanguage` (main updates the tray and relays to the feedback and notice windows), and stores `language`.
- Cloud error codes are shown via keys `Err_<code>`, for example `Err_650209` (account locked) and `Err_650401` (token invalid → forced logout, MN:1906-1914).
- Terms of use, privacy statement and OSS notice are local keys `tou*` / `statement*` / `oss*` (ST:30520-30529). They need no network.

---

## 10. Browser-side persistence

| Store | Key | Written at | Content / purpose | Offline relevance |
|---|---|---|---|---|
| localStorage | `deviceInfo` | ST:44695 | `[{modelName, fwComponentID, fwVersion}]` for every connected device | Feeds online feedback only |
| localStorage | `monitorFw` | ST:44704, ST:33836 | `[{modelName, fwComponentID, fwVersion}]` from `DisplayFW_GetDeviceList` | Feedback only |
| localStorage | `device_image_marks` | ST:44452-44472 | `{<model>: md5}` of downloaded image packs | Online image cache |
| localStorage | `bulbListStore` | ST:34904-34910 | Matter bulbs list | Drop |
| localStorage | `CacheDeleted` | MN:2114 | `"1"` marker | Harmless |
| localStorage | `feedbackCnt` | FB:182-192 | `{<localeDate>: count}`, max 3 feedbacks per day | Drop |
| sessionStorage | `devicesImageCache` | ST:39586-39628 | `{<model>: imageUrl}` for cloud profile previews | Drop |
| files | `<userData>/ImageCache/<model>/{normal,overview,rear,source}.png` | main | Downloaded images for models not in `ry` | Not needed for 34M2C8600 |
| files | `<userData>/Cloud User/<userId>/…` | main | Cloud profile cache | Drop |

`userData` is `%APPDATA%/evnia` on Windows. On Linux Electron derives it from the package name "evnia": `~/.config/evnia` (INFERRED).

---

## 11. Sub-apps and asset directories

### 11.1 `feedback/feedback.html` (FB, 372 lines): online only

- Fields: type (Feedback_Type_1..4 → `questionType` 1..4), message (≤500 chars), optional e-mail, up to 3 images (≤20 MiB each), and a policy checkbox that defaults to **checked** (`ge = true`).
- Selecting an image **uploads it immediately** (FB:78-94): `$T("").fileUpload(path, name, "feedback", mime)`, which calls GET `pcenter /pcenter/file/presignedUrl` and then PUTs to the presigned URL.
- **Send** (FB:98-162) requires `navigator.onLine` and fewer than 3 sends today. It builds:
  ```json
  {"questionType":1,"content":"…","softwareVersion":"1.13.0",
   "sysParams":"{\"tmpDir\":…,\"appDataDir\":…,\"computerName\":…,\"osType\":…,\"osPlatform\":…,\"arch\":…,\"release\":…,\"uptime\":…,\"totalmem\":…,\"mac\":…}",
   "deviceInfo":"model1,model2","firmwareVersion":"compId=ver,…","contactEmail":"…","imageUrls":["…"],"logUrl":"…"}
  ```
- If the checkbox is set, it **uploads today's backend log** `<AppData>/EvniaServe/logs/YYYY-MM-DD.txt` (FB:135-149).
- Then `POST pcenter /pcenter/feedback/submit` and `ipc closeFeedbackWindow`.
- Port decision: **drop the window** and remove the General→Feedback button.

### 11.2 `notice/notice.html` (NT, 52 lines): local

A small frameless popup: logo, "Evnia Precision Center", close icon (sends `notice(false,"")`) and a body `$t(key, ...params)` that comes from `ipc setNotice`. Keep it, or replace it with libnotify through main.

### 11.3 Bundled product images and `DeviceImage` resolution (ST:33304-33401)

- Known model list `ry`: SPK8308, SPK8508, SPK8708, SPK9308, SPK9418, SPK9508, SPK9618, SPK9708, SPK9718, SPK9728, SPK8618, SPL7508, SPL7708, 27M2N8800, 34M2C7600MV, 34M2C8600, 42M2N8900, 49M2C8900, TAG4106, TAG5106.
- Faces: `normal`, `source`, `overview`, `rear`.
- For a known model the image URL is `new URL("../../../" + (isPackaged ? "out/renderer/" : "") + "<dir>/<Model>[_<face>].png", import.meta.url)`, i.e. the app-root-relative `out/renderer/monitor/34M2C8600.png`. Keep this layout in the Linux package.
- Unknown models use `local:///<userData>/ImageCache/<ID>/<face>.png`. The ID is `ModelName_vid_pid_IDCode` upper-cased for peripherals and the model name for monitors.
- Fallbacks on error:
  - An overview face falls back to the normal image.
  - Otherwise a generic image is used: monitor 27M2N8800 (rear variant for the rear face), keyboard SPK8708, mouse SPK9708 (rear variant for the rear face), pad SPL7508, headset TAG4106.
  - Bulb uses an inline data URI.

---

## 12. Small shared bundles (in scope by filename)

- `directive-B2r732H0.js`: widgets used across windows (exports T=Textarea, I=Input, C=Checkbox, _=Button, a=PopMessage, P=Progress, L=Loading, o=outside-click directive). No IPC and no network.
- `index-7Mj02WAv.js`: peripheral Ambiglow panel. Calls `bu().saveCustomColor` (`Effect_SetSelfColors`), `setEffectEnable` (`Effect_Enable`) and `updateDeviceType`. It confirms before enabling light (`LightEnableOnConfirm`) and imports the LightSync chunk.
- `index-CkulgR5C.js`: Onboard panel. Uses `Ru()`: `Profile_EnableOnboard`, `Profile_SwitchOnboard`, `Profile_ApplyOnboard`, `Profile_ResetOnboard(dt,i)` / `(dt,-1)`, `Profile_SyncOnBoard`, `Profile_ClearOnBoardMacro`. Drag-and-drop of profiles.
- `index-D_7NuP0U.js`: mouse button-layout tables `R.{SPK9308,SPK9418,SPK9508,SPK9618(+renderFlat3395),SPK9708,…}.renderFlat.{front,frontLeft,frontRight,back,backLeft,backRight}` (button index lists) plus a button list using `ButtonValue`. Only needs `getDeviceInfo` from the store.
- `noop`, `src-renderer`: trivial. `index-BYSWl2m0.js`: undici, dead in the renderer (see §1.1).

---

## L. Linux port plan (renderer shell, preload, SignalR client)

### L.1 Strategy

Reuse the **stock renderer bundles** (`out/renderer/**`) in Electron on Linux. The Vue app has no Windows dependencies of its own; every OS or device dependency goes through the three preload objects and the SignalR hub. Replace:

1. **The preload** with a typed allowlist that keeps the same `window.ipc` / `window.nodeApi` / `window.store` shape (§L.2).
2. **The main process** with a Linux main that implements only the channels marked keep in §3 (see `01-electron-main.md` for the main-side detail).
3. **The backend** with a Linux service that implements the hub contract in §L.4.
4. **Online code**: a network kill-switch plus a few minified-bundle patches (§L.3). The renderer's existing error handling covers the rest.

### L.2 Preload replacement (drop-in)

```js
// preload.js (contextIsolation: true, sandbox: true possible because nothing below needs Node in-page)
const { contextBridge, ipcRenderer } = require('electron');
const INVOKE = new Set(['getRunConfig','startupBackendService','getMonitorJsonConfig','maximizedValue','maximizeToggler',
  'fileSelect','exportFile','getFileSize','checkNodeAvailable','store:get','store:set','store:delete','fs:*']);
const SEND   = new Set(['interfaceInitializeCompleted','resetToStartSize','minimize','close','setLanguage','setAutoStartUp',
  'notice','disableTrayExit','disableTrayFunction','shieldDisplayChange','shieldPeripheralChange']);
const ON     = new Set(['displayChange','USBChange','otherDeviceChange','toPageView','rescan','mainWindowShow','setNotice','setLanguage']);
contextBridge.exposeInMainWorld('ipc', {
  send: (c, ...a) => SEND.has(c) && ipcRenderer.send(c, ...a),
  invoke: (c, ...a) => INVOKE.has(c) ? ipcRenderer.invoke(c, ...a) : Promise.resolve(OFFLINE_DEFAULTS[c]),
  on:   (c, f) => { if (!ON.has(c)) return () => {}; ipcRenderer.on(c, f); return () => ipcRenderer.removeListener(c, f); },
  once: (c, f) => { if (!ON.has(c)) return () => {}; ipcRenderer.once(c, f); return () => ipcRenderer.removeListener(c, f); },
  removeAllListeners: c => ipcRenderer.removeAllListeners(c), listeners: c => ipcRenderer.listeners(c).length });
```

- `OFFLINE_DEFAULTS` gives inert answers for dropped invoke channels so no promise hangs:
  - `imageResourceDownload`, `getCloudFileCacheOrDownload`, `extractZip`, `findExe`, `getMac` → `""`
  - `runCommand` → `{error:{message:'disabled'},stdout:''}`
  - `getFileMd5` → `""`
  - `getSystemInfo` → `{}`
  - bulb channels → `{success:false,error:'disabled'}`
- `window.store` should keep `get`/`set`/`delete` with the same schema defaults (§2.2), but route through main (`store:*` invoke with `sendSync` or a preloaded snapshot) so the preload can be sandboxed. The renderer reads the store **synchronously**, e.g. `window.store.get("language")` at module top level, so the preload must cache a snapshot obtained with `ipcRenderer.sendSync` at load.
- `window.nodeApi` must keep `existsSync`, `readFileSync`, `readFile`, `copyFileSync`, `unlinkSync`, `getBaseName` and `pathJoin`, because profile and macro import/export and the ImageCache check use them. Either implement them via synchronous IPC to main with path confinement (userData plus user-chosen files), or keep a non-sandboxed preload that uses `fs`.

### L.3 Offline patches (anchors verified in `work/app/out/renderer/assets/*.js`)

Apply these as literal string replacements to the raw minified files. Each anchor occurs exactly once.

| # | File | Find | Replace with | Effect |
|---|---|---|---|---|
| P1 | styles-DAnQi2A8.js | `async function Sv(e,t){` | `async function Sv(e,t){throw new Error("offline");` | All saas, deviceportal and pcenter requests (`_v`, `Ev`, `vv.post/put/delete`, `yv`) reject with an **Error object**. Callers show `NoNetworkRetry`, clear `userInfo`, set firmware fetchError, and so on. |
| P2 | styles-DAnQi2A8.js | `const i=new URL(cv+e);` | `return r(new Error("offline"));const i=new URL(cv+e);` | `vv.get` (cloud theme, profile and macro lists, presigned URLs) uses `fetch` directly; make it reject as well. |
| P3 | styles-DAnQi2A8.js | `async function Mv(e,t=!1,o=""){` | `async function Mv(e,t=!1,o=""){return[];` | Component-update check returns "no update": firmware rows show `LatestVersion`, the AmbiScape download and SmartDesktop do nothing. |
| P4 | styles-DAnQi2A8.js | `getDeviceResource(e){` / `getDeviceImage(e){` | `getDeviceResource(e){return Promise.resolve([]);` / `getDeviceImage(e){return Promise.resolve([]);` | No image-pack lookups (§O-3) and no log noise. |
| P5 | main-CDosWiM3.js | `{name:"account",tip:"Account",path:$.Account,hidden:!1}` | `{name:"account",tip:"Account",path:$.Account,hidden:!0}` | Removes the only UI entry into login, register and Account. |
| P6 | main-CDosWiM3.js | `y.loginState\|\|e?ne.value=!1:oe.value=!0` | `ne.value=!1` | Never auto-show the login overlay. Alternative: set `skipLoginState=true` in the store defaults. |
| P7 | main-CDosWiM3.js | `le("https://www.evnia.philips")` | `void 0` | The logo click does nothing. |
| P8 | styles-DAnQi2A8.js | `{text:"Feedback",highlight:"",onClick:` | wrap the element in a false condition, or make main ignore `openFeedbackWindow` | Hide feedback. The simplest route is main-side: do not create the window. |
| P9 | styles-DAnQi2A8.js | `{name:"FwUpdate",value:4}` and `e.splice(2,0,{name:"AmbiScape",value:3})` | remove the first; replace the second with `0` | Settings shows General, AboutPCenter, AboutDevice and PairingTool (only when paired devices exist). |
| P10 | styles-DAnQi2A8.js | `text:"CheckUpdates"` (AboutPCenter; the AutoUpdate switch is nearby) | hide the button and switches, **or** have main answer `checkSoftwareVersion` with `versionCheckResult {state:0,versionNum:"",packageUrl:"",description:[]}` | Otherwise the loading overlay started at ST:14158 never hides. |
| P11 | main-CDosWiM3.js | `{icon:"nav_smart_desktop",path:$.Monitor_SmartDesktop,tip:"SmartDesktop",actived:o.path===$.Monitor_SmartDesktop}` | same object with `,hidden:!0` added | SmartDesktop is Windows FancyZones plus an online installer. |

Also:
- `getMonitorJsonConfig` must return `OTAEnable:false`. That hides the monitor Setup "FwUpdate" tab (Setup-D-5j4V-I.js:308) and the OTA auto-check at ST:34429-34436, while keeping `configInJson` so the Ambiglow nav and HDR still work.
- Tighten the CSP in `index.html`:
  ```
  default-src 'self' ws://localhost:* ws://127.0.0.1:*; img-src 'self' data: blob: local:; script-src 'self'; style-src 'self' 'unsafe-inline'
  ```
  (Drop `'wasm-unsafe-eval'` along with AmbiScape.)
- **Network kill-switch** in Linux main: `session.defaultSession.webRequest.onBeforeRequest({urls:['<all_urls>']}, …)`, cancelling everything whose URL is not `file:`, `local:`, `devtools:`, `data:`, `blob:` or `ws://localhost|127.0.0.1:<port>`. This backstops anything missed. A cancelled `fetch` rejects with `TypeError`, which the renderer already treats as "no network".

Result: no renderer path reaches the network. Everything the user needs works offline: Overview, Monitor pages, Profile (local), Dashboard, Settings (General, About, AboutDevice), tutorials and the tray pages.

### L.4 What the Linux backend must provide to this client (minimal hub contract)

1. HTTP server on `127.0.0.1:<port>`. Default 10010; main passes the port to the renderer via `startupBackendService`.
2. WebSocket upgrade at `/EvniaHub` **without** negotiate. Accept the `{"protocol":"json","version":1}\x1e` handshake and reply `{}\x1e`.
3. Frame parsing on 0x1E. Handle `type` 1 (Invocation, `target:"GetTaskAsync"`, one string argument), 6 (Ping) and 7 (Close). Reply to each invocation with a Completion `{"type":3,"invocationId":<same>}`; this is optional for the UI but keeps the client clean.
4. For each request string `{functionName, requestId, parms}`, send `{"type":1,"target":"GetTaskAsync","arguments":[JSON.stringify(result)]}`. `result` = `{err_code:int, err_msg:string|null, RequestId:<echo>, FunctionName:<echo>, Tag:<payload>}`. Success means `err_code:0` **and** empty/null `err_msg`. **Always reply**; there is no client-side timeout.
5. Push notifications as `{"type":1,"target":"Notification","arguments":[JSON.stringify({err_code:0, RequestId:null, FunctionName:<name>, Tag:<payload>})]}` using the names and payloads in §6. Use named keys for `NotifyUIDisplayEffectChange`.
6. Send `{"type":6}` pings at most 15 s apart (the client drops the connection after 30 s of silence).
7. Accept only int, string and bool parameters, as the renderer only produces those. Reject others with `err_code:9`.
8. Implement at least what the shell calls at startup and what the monitor pages call:
   - Startup: `Start`, `Device_GetConnectList`, `DisplayFW_GetDeviceList`, `Theme_GetThemeInfos`, `Theme_GetCurTheme`, `Macro_GetFuncMenu`, `Macro_GetList`, `SyncEffect_GetData`, `Effect_GetColorData`, `Setting_GlobalData`, `GetPairDevices`, `Device_DetectionDisplay`, `Device_DetectionUSB`, `Device_OtherDeviceChange`, `Device_Rescan`, `Theme_GetDevicesBasicInfo(-1)`.
   - Monitor: `PHL_*`, `Profile_GetDeviceData(100000)`, `Effect_*`, `DisplayFW_*` (the OTA ones may return errors).

   Reply shapes for the shell are in §5.1 and §8. Detailed device payloads are in the backend and monitor reports.

### L.5 Acceptance checks (renderer side)

- A cold start with the network unplugged **and** with a firewall that drops packets both reach Home in under about 5 s. The 3 s splash is intentional (MN:229). No `fetch` is attempted, which can be verified with the kill-switch log.
- The monitor appears as `PHL 34M2C8600` with the bundled image. Sidebar shows SmartImage, GameMode, Ambiglow, Input, Audio, System, Setup (+Sync).
- Unplugging or replugging USB or a display produces `USBChange` / `displayChange` → `Device_Detection*` and no stuck overlay.
- Killing the backend shows reconnect attempts (0/2/10/30 s, then every 2 s). After restart the UI calls `Start` again.

---

## Online touchpoints

A Base URL written without a scheme means `https://`. The saas headers `hv` (ST:32925) are `brandId:"5", productId:"857", deviceType:"Evnia_Precision_Center", devicesetId:"fcaa1d17c43a11eca53606dda80f8953"`. Every saas `yv.*` call adds an `action:<name>` header, `Cache-Control:no-cache` and an `Authorization` HMAC signature. The HMAC keys are hard-coded at ST:13335-13347 and are **redacted here**; the port needs none of them.

| # | What | Where | Endpoint (method, path, params) | Trigger | UI that depends on it | Stub |
|---|---|---|---|---|---|---|
| O-1 | Startup token refresh | MN:230-244 → `Ov` ST:33113 | PUT `saas.zeasn.tv/user/device/token/refresh` `{userToken}` | Every start when `userInfo.token` is stored | Keeps you logged in | P1 (fails → logout) |
| O-2 | Device-sign token (sends **MAC**) | `yT()._` ST:38751-38773 | GET `saas…/auth-api/api/v1/auth/deviceSign?brandId=5&productId=857&deviceSetId=…&mac=<MAC>&countryCode=<JP\|EN\|FR\|WW>&appVersion=1.13.0` (no timeout because `signal:null` overrides) | Login dialog mount; network comes back | Third-party login buttons | P1 + P5/P6 |
| O-3 | Device image resources | `Pb` ST:44445-44513 via `saveDeviceList` ST:44718 | POST `pcenter.zeasn.tv/pcenter/device/files` `{idParams:[{deviceTypeName,deviceModelName}]}` → `[{deviceModelName,fileName,fileUrl,fileMd5}]`, then ipc `imageResourceDownload` (zip → ImageCache) | **Every device-list refresh** for models whose `modelName` is not in `ry`. INFERRED to include the user's monitor, because `DisplayList[].MonitorName` = EDID name `"PHL 34M2C8600"` (DC/Zeasn.PCenter.Base.Lib/Display.cs:185; BLOG "PHL 34M2C8600: Hub SetStandardDDC") while `ry` has `"34M2C8600"`. Startup waits on it (up to 20 s). | Pictures of unknown devices | P4 (+ P1) |
| O-4 | Third-party login menu | ST:38774-38782 | GET `saas…/user/device/oauth/apps?productId=857&token=…&osType=WEB` | Login dialog | Google, Facebook, WeChat, Twitch buttons | P1 |
| O-5 | E-mail login (sends MAC) | `Fv` ST:33133; MN:991-1017 | POST `saas…/user/device/login` form `{email, encryptedPwd, mac}` (`encryptedPwd` is only a reversible shuffle + base64, `zm` ST:13375) | Login button | Account features | P5/P6 |
| O-6 | Lock status | `Kv` ST:33145 | GET `saas…/user/device/lockStatus?email&productId=857` | After failed login; register | Error text | P1 |
| O-7 | Register, verify, forgot password, bind e-mail | ST:33116-33154; MN:1300-1520 | GET `…/user/device/sendEmail` (templateId=precisionCenter, langCode), GET `…/sendEmail/bindEmail`, POST `…/regist` `{email,userName,encryptedPwd,verifyCode}`, POST `…/forgetPwd`, POST JSON `…/oauth/upgradeEmailUser` | Login dialog flows | – | P5 |
| O-8 | Account management | ST:35403-35620, ST:38851-38981 | POST `…/logout`, PUT `…/changePwd`, PUT `…/changeUser` (`{userName}` or `{icon}`), GET `…/checkEmailUsage`, PUT JSON `…/oauth/deleteThirdPlatform`, PUT JSON `…/account/deleteByPassword`, GET `…/oauth/getThirdPlatform`, GET `…/oauth/apps/login?code&state`, POST JSON `…/oauth/addThirdPlatform` | Account page | Account page | P5 |
| O-9 | Avatar upload | ST:38930-38972 | Image compression in a Worker that `importScripts("https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/dist/browser-image-compression.js")` (ST:38587-38616), then GET `saas…/user/device/presignedUrl?fileName`, then PUT to the presigned URL (S3, INFERRED), then `changeUser {icon}` | Account > Setting avatar | Avatar | P5 |
| O-10 | Third-party OAuth in the browser | ST:38784-38801 | Opens `thirdPartyInfo[app].codeUrl` (state rewritten to `<state>:ISNS:<ISLOGIN\|ISASS>:<lang>`) via `openDefaultBrowser`; returns through the `EvniaPrecisionCenterApp://` deep link → `thirdPartySuccess` | Login | – | P5; do not register the protocol |
| O-11 | Cloud themes, profiles, macros | `$T` ST:39426-39507, `tP` ST:39602-39716, `XT` ST:39509-39582 | GET/POST/PUT/DELETE `pcenter…/pcenter/theme` (`startIndex,size=50` / `{themeName}` / `{id,themeName}` / `id`), `/pcenter/profile` (`themeId,startIndex,size=50` / `{themeId,fileName,fileUrl,fileMd5,remark,fileOverride}` / `{id,profileName}` / `id`), `/pcenter/macro` (size=150; `{themeId,fileName,fileUrl,fileMd5,fileOverride}`), GET `/pcenter/file/exist?userToken&fileCategory&themeId&fileName`, GET `/pcenter/file/presignedUrl?fileName&module=theme&contentType`, then PUT to the presigned URL. Header `userToken`. Download via ipc `getCloudFileCacheOrDownload`. | Login (`setUserInfo` fetches cloud themes); Account tabs; "FromCloud" import (disabled when not logged in, ST:39390-39399); export-to-cloud | Account / MyProfiles / MyMacros | P2 + P5 |
| O-12 | Cloud device images | `tP().n` ST:39613-39635 | POST `pcenter…/pcenter/device/images` `{idParams}` → imageUrl (session-cached) | Cloud profile list | Profile preview images | P4 |
| O-13 | Remote config | `$T.getConfig` ST:39505 | GET `pcenter…/pcenter/config?keys[]&startIndex&size=50` | **Unused** | – | none |
| O-14 | Firmware / plugin update check (sends **MAC**, USB hub count) | `Mv` ST:33075-33111; callers ST:33861 (monitor), ST:34450 (FirmwareManager), SmartDesktop:93, headset Setup:63, AmbiScape ST:35140 | GET `deviceportal.zeasn.tv/direct/component/update?brandId=<74 monitor\|134 other>&components=<componentId>=<version>&deviceType=<scaler or DP type>&language&push=true&ScalerIC=true&ruleMac=<MAC>&ruleUSBHubCount=<n>`, header `Authorization: ZAuth <key>:<HMAC-SHA1("GET <href> <md5('')>")>` (redacted). Result filtered by `versionName <= 101300`; items `{id,friendlyVersion,url,hashMethod,hashValue,description}` | Settings > FwUpdate tab (all devices); monitor Setup FwUpdate tab when `OTASupport` (true for 34M2C8600 with stock config); OTA auto-check on list change (ST:34429-34436); AmbiScape "Download"; SmartDesktop page; headset DTS setup | Firmware UI | P3 + `OTAEnable:false` + P9 |
| O-15 | Package downloads | `Sy()` ST:33564-33599 | ipc `createDownload(url, hash…)` (main downloads `url`, e.g. `gcdn.zeasn.com/...`; see ELOG) | After O-14 | Firmware burn, AmbiScape node, SmartDesktop | Unreachable after P3 |
| O-16 | Software self-update | `ih().ipcCheckSoftwareUpdates` ST:14157-14159; MN:689-884 | ipc `checkSoftwareVersion` / `softwareDownload` / `softwareInstall`; main checks and downloads online (ELOG: `gcdn.zeasn.com/prod/zeasn-saas-pp/apk/global/857/…exe`) | AboutPCenter "CheckUpdates"; tray; `newVersionPrompt` at start | Update dialog | P10; main never sends prompts |
| O-17 | Feedback | FB (§11.1) | GET `pcenter…/pcenter/file/presignedUrl?module=feedback`, then PUT image and log; POST `pcenter…/pcenter/feedback/submit` (sysParams with hostname and **MAC**, device list, firmware list, **today's backend log**) | Settings > General > Feedback | Feedback window | P8 |
| O-18 | Evnia website | MN:1868 | `openDefaultBrowser("https://www.evnia.philips")` | Brand-logo click | – | P7 |
| O-19 | Licence links | ST:30515-30518, 30640-30642 | `nuget.org`, `licenses.nuget.org`, `github.com/nlua` via `openDefaultBrowser` | Click in the OSS notice | – | Main no-op |
| O-20 | zxing-wasm | AmbiScape-B35D_GM2.js:359-363, 3579-3583 | `https://fastly.jsdelivr.net/npm/zxing-wasm@1.1.3/dist/<flavor>/zxing_reader.wasm` and `@3.1.0` (XHR/fetch) | QR scan in the Matter bulb pairing page | AmbiScape bulb | Drop the bulb feature (keep `checkNodeAvailable → false`) |
| O-21 | Remote avatars and images | `<img>` of `userInfo.icon`, cloud image URLs (CSP img-src hosts) | googleusercontent, qlogo, jtvnw, fbsbx, cache.zeasn.tv | Logged in | – | Unreachable; CSP |
| O-22 | Translation patch (indirect) | ST:29402-29417 | Reads `<patchPath>/translation.json`, which main's online resource-pack updater writes | Start | Updated strings | Keep reading local only; main must not download |
| O-23 | Backend restart hook (indirect) | MN:177-180 | ON_RECONNECTING → `startupBackendService` → main re-fetches MonitorInfo.json online | Hub reconnect | – | Main must not fetch |

Cloud response envelope handled by `Sv` (ST:32950-32966):
- `{errorCode, errorMsg, data}`: `errorCode == 0` resolves with `data`; otherwise the bus emits `globalErrorHandle(errorCode)` and the promise rejects with the code string.
- deviceportal uses `{error, datas}`: `error === 0` resolves with `datas`.
- Default timeout is 20 s (`AbortSignal.timeout(20000)`), except where `signal:null` overrides it (O-2).

---

## Open questions

1. **Exact `Device_GetConnectList` reply for the 34M2C8600.** It is not logged. §O-3 assumes `ExtDeviceInfo.DisplayList[].MonitorName == "PHL 34M2C8600"`, which would make `saveDeviceList` call `/pcenter/device/files` on every refresh. This is INFERRED from Display.cs:185 and the BLOG string. It can be confirmed by capturing one reply, or by adding a debug log in a test build of the port.
2. **`NotifyUIDisplayEffectChange` payload.** Does the real 1.13.0 backend emit `Item1/Item2/Item3`, making the renderer handler throw, or does some serializer setting produce `ENEEnable/EffectInfo/ModuleAmbiglow`? The key `ENEEnable` does not appear anywhere in DC. Decide the Linux payload: named keys are recommended.
3. `NotifyUISwitchTheme` and `NotifyMouseDPIChange` have no emitter in DC. Was app-bound automatic profile switching moved elsewhere, e.g. into a backend-internal `Theme_SwitchApp`, or is it simply broken in 1.13.0? On Linux, app-bound profiles need an X11/Wayland foreground-app source anyway.
4. `languageTemp` in `config.json` is not written by any JS. Presumably the NSIS installer writes it; this does not matter for Linux.
5. Whether the backend really sends a SignalR Completion after the push. It is standard ASP.NET behaviour for a `Task` hub method (INFERRED); the renderer does not rely on it.
6. `window.noop` visibility under context isolation (§2.1): harmless, but unhandled rejections may appear in the console.

## Cross-references

- **Electron main** (`01-electron-main.md`): the main-side behaviour of every channel in §3, including MonitorInfo online refresh (§8), `local://` protocol, tray pages (`toPageView`, `rescan`, `checkSoftwareUpgrade`), backend spawn/port (§7), downloads/upgrade/patch (§12), Matter process (§14) and the `openDefaultBrowser` Linux typo.
- **Backend host / Bridge** (`05-backend-host.md` §3): `Class0` dispatcher (type-based overload resolution, `device` prepend bug), `JsonResult`, `HandleEvent` broadcast, `http://*:10010` binding (should be loopback), Swagger UI enabled in production (Startup.cs:63-68).
- **Monitor / DDC report**: the `PHL_SetOSD` attribute names (§5.2) → VCP codes; `Profile_GetDeviceData(100000)` payload (`Module*`, `DispalyData.MonitorEDIDInfo_T`); `PHL_GetConstraints` and `DisplayFuncConstraints`; `DisplayFW_*` OTA flow (drop for the offline port); `NotifyHotKeyExecute` (the UI never subscribes to it).
- **ENE / Ambiglow report**: `Effect_*` and `SyncEffect_*` semantics; `AmbiScape_EnableFollowVideo` and `NotifyAmbiScapeFollowVideoData` (the video-capture-driven lighting data).
- **Peripheral reports** (RongYuan, JiangMeng, YJX, BeiYing, DTS headset): all `Keyboard_*`, `Mouse_*`, `Button_*`, `Profile_*Onboard*`, `DTS_*` and pairing functions. These are irrelevant for this user, whose HID devices (unrelated third-party keyboard, mouse and audio devices) are not recognised by the app.
- **Matter / `resources/matter/control.mjs`**: the bulb IPC family (`discoverBulb` … `destroyBulbProcess`, `matterNotification`). Drop.
- **Security**: `window.ipc` plus `runCommand`, a CSP that allows remote scripts, unrestricted `nodeApi`, and hard-coded cloud HMAC secrets (ST:13335-13347; values deliberately not reproduced here).
