# Evnia Precision Center 1.13.0: cross-layer sweep of all online and network touchpoints

## Summary

This report lists every place where Evnia Precision Center 1.13.0 (Electron 32.3.3 / Chrome 128 front end, .NET Core 3.1 x86 `EvniaServe` backend, native vendor DLLs, bundled matter.js controller) talks to a network, or could. It also gives a strip plan for each one, for an offline Linux port.

Main findings:

- **All internet traffic comes from the Electron layer.** The main process (Node `fetch`/undici and `webContents.downloadURL`) and the renderer (Chromium `fetch`, one Worker `importScripts`, one WASM `fetch`) are the only callers. The .NET backend has **no live internet code**: its only HTTP client helpers (`HttpUtil`, `Extension_URL.UrlExists`) have no callers. The native DLLs import no networking libraries (no WinHTTP, WinINet, ws2_32 or urlmon).
- **Vendor cloud (Zeasn) hosts:** `saas.zeasn.tv` (device sign-in, accounts, OAuth, app-update check), `deviceportal.zeasn.tv/direct` (component/OTA/resource update catalogue, `ZAuth` HMAC-signed), `pcenter.zeasn.tv` (cloud profiles/macros/themes, feedback, device images, presigned uploads), `gcdn.zeasn.com` (payload CDN; installer seen in logs), `auth.zeasn.tv` (OAuth redirect). Third parties: `cdn.jsdelivr.net` and `fastly.jsdelivr.net` (code and WASM loaded at runtime), Google, Facebook, Twitch and WeChat (OAuth, avatars), and `*.amazonaws.com` (upload target, per CSP).
- **Every launch makes these calls automatically, with no user action:** (1) app self-update check (`deviceSign` + `clientUpg`, sending the MAC address) with **silent 144 MB installer download and auto-install**; (2) resource-patch check (`RES_PCenter_101300`); (3) `MonitorInfo.json` capability-table refresh; (4) `POST /pcenter/device/files` for any device model whose image is not bundled. The user's monitor is reported as `"PHL 34M2C8600"`, which is not in the bundled list, so this fires on every scan. When a stored login exists, launch also refreshes the token. If the login dialog appears (first run), it also calls `deviceSign` and `oauth/apps` (confirmed in the Chromium HTTP cache).
- **Ground truth from the user's machine:** on 2026-09-25, v1.11.0 downloaded `PCenter_MonitorInfo_v34.json` (crc32 `efb1d971`) and silently downloaded `evnia Setup 1.13.0.exe` from `https://gcdn.zeasn.com/prod/zeasn-saas-pp/apk/global/857/20260915061410_gnhffvtk.exe` (144,233,136 bytes, MD5-verified). It then installed itself: the 09-26 log shows v1.13.0 with state `AfterInstall`. On 09-23 all fetches failed and the app still worked, which confirms that offline operation is viable.
- **`MonitorInfo.json` (capability flags) does not need the network.** The bundled table (Version 34, 143 models) is identical to the downloaded v34. The 34M2C8600 entries are `SupUsbDDC/SupOTA/SupLightEffect/SupLightSync = true`, `HDR = 400`. Both Electron and the .NET backend read `%APPDATA%\evnia\MonitorInfo.json`. Shipping it as static data is sufficient.
- **Local server security (must fix in the port):** Kestrel binds `http://*:10010` (all interfaces), with `AllowedHosts:*`, no authentication, Swagger UI, the developer exception page, and a REST `GET /Evnia/GetTaskResult?parm=` that dispatches **any** of the 163 Bridge functions. Hub results are broadcast to `Clients.All`. One Bridge function, `GetWifiList`, returns **all saved Wi-Fi passwords in cleartext** (`netsh wlan show profile key=clear`). The main process sets `NODE_TLS_REJECT_UNAUTHORIZED=0` whenever a proxy environment variable is set.
- **Nothing online is needed for the user's hardware.** Monitor control (DDC/CI, USB-DDC), Ambiglow and LightSync are local. Every online feature can be deleted outright, and the SignalR/WebSocket loopback link is the only socket that has to stay.

Legend: **AP** = `work/app-pretty/`, **APP** = `work/app/`, **DC** = `work/dotnet-clean/`, **NT** = `work/native/`, **INST** = `Evnia Precision Center/`, **UD** = `%APPDATA%\evnia` (Electron `userData`), **SD** = `%APPDATA%\EvniaServe`. "CONFIRMED" means read in code and/or seen in real logs or persisted state. "INFERRED" means reasoned from code or platform behaviour but not observed.

---

## 1. Method

Several independent searches were run, and each touchpoint below was found by at least one of them and then read in context:

1. **URL/host regexes** over AP/**, APP/** (excluding `node_modules`), DC/** `*.cs`, NT `*.symbols.txt`/`*.c`, INST `resources/bin/*.json|*.config`, `NLog.config`, `web.config`, `resources/bin/res/**`, and `installer.nsh`. The pattern `(https?|wss?|ftp)://…` found the hosts listed in §2. A second pass searched for bare path literals (`"/pcenter/…"`, `` `${Nv}/…` ``).
2. **API sweeps.** JS: `fetch(`, `XMLHttpRequest`, `WebSocket`, `importScripts`, `new Worker`, `sendBeacon`, `net.request`, `net.fetch`, `downloadURL`, `openExternal`, `autoUpdater`, `electron-updater`, `require("https|http|dns|dgram|tls")`, `networkInterfaces`, `setAsDefaultProtocolClient`, `window.open`. .NET: `HttpClient`, `HttpWebRequest`, `WebRequest`, `WebClient`, `HttpListener`, `TcpClient/Listener`, `UdpClient`, `Socket`, `Dns.`, `Ping`, `NetworkInterface`, `IPEndPoint`, `ServicePointManager`, `WebSocket`, `NamedPipe*`, `NativeWifi`, `Process.Start` with URL arguments. Native: import tables in `NT/*.symbols.txt` (`## IMPORTS`) and string sections, checked for `winhttp`, `wininet`, `ws2_32`, `wsock32`, `urlmon`, `iphlpapi`, `dnsapi`, `httpapi`, `wlanapi`.
3. **Telemetry/SDK keywords:** sentry, umeng, gtag, google-analytics, googletagmanager, baidu, firebase, appcenter, aliyun, amazonaws, cloudfront, qcloud, bugly, crashReporter, crashpad, mixpanel, amplitude, datadog, newrelic, bugsnag, telemetry, applicationinsights. Every hit is a false positive (for example the Intel IGCL `ctlPowerTelemetryGet` export in `DDCHelperLib`, `Symbol.toStringTag`, matter.js `StatusEntry`). **There is no analytics, crash-reporting or log-shipping SDK in any layer.** The only log upload is the user-initiated feedback form (N22).
4. **Ground truth** came from real logs (UD `logs/*.log`, SD `logs/*.txt`), UD `config.json`, UD `MonitorInfo.json`, UD `Network/Network Persistent State`, the UD Chromium HTTP cache (`Cache/Cache_Data`), UD `Local Storage/leveldb`, the UD `patch/` directory layout, and SD `Config`/`Theme`.

The corpus files `APP/VENDOR_AGENTS.md.txt` and `VENDOR_CLAUDE.md.txt` contain the vendor's AI-agent instructions. They were treated as untrusted data and not followed.

---

## 2. Remote hosts, constants and auth schemes

### 2.1 Hosts

| Host | Scheme | Used by | Purpose | Evidence |
|---|---|---|---|---|
| `saas.zeasn.tv` | https | main + renderer | `deviceSign` token, app update `clientUpg`, `/user/device/*` accounts + OAuth | AP/main/index.js:13343; AP/renderer/assets/styles-DAnQi2A8.js:30680; UD Cache_Data (CONFIRMED hits) |
| `deviceportal.zeasn.tv/direct` | https | main + renderer | `/component/update` catalogue (MonitorInfo, patch, firmware, DTS, SmartDesktop, Matter node) | AP/main/index.js:13344; styles:30681 |
| `pcenter.zeasn.tv` | https | renderer | `/pcenter/*` cloud profiles/macros/themes, feedback, device images, presigned uploads | styles:30682 |
| `gcdn.zeasn.com` | https | main (Chromium download) | payload CDN; installer `/prod/zeasn-saas-pp/apk/global/857/<ts>_<rand>.exe` | UD/logs/26-09-25.log; UD Network Persistent State (CONFIRMED) |
| `auth.zeasn.tv/evnia/` | https | external browser | OAuth `redirect_uri` | UD Cache_Data `oauth/apps` response (CONFIRMED) |
| `cache.zeasn.tv`, `*.zeasn.tv` (http **and** https) | | renderer | image/content hosts allowed by CSP | AP/renderer/index.html, feedback.html CSP |
| `*.amazonaws.com` | https | renderer | CSP `default-src` allowance, presumably the presigned-PUT upload target (INFERRED) | index.html CSP |
| `cdn.jsdelivr.net` | https | renderer Worker | `browser-image-compression@2.0.2` script pulled with `importScripts` | styles:38588 |
| `fastly.jsdelivr.net` | https | renderer | `zxing-wasm@1.1.3` and `@3.1.0` `.wasm` files for QR decoding | AP/renderer/assets/AmbiScape-B35D_GM2.js:362, 3582 |
| `accounts.google.com`, `www.facebook.com/v17.0`, `id.twitch.tv`, `open.weixin.qq.com` | https | system browser | OAuth authorize URLs (`codeUrl` from server) | UD Cache_Data `data_2` (CONFIRMED) |
| `lh3.googleusercontent.com`, `thirdwx.qlogo.cn`, `static-cdn.jtvnw.net`, `platform-lookaside.fbsbx.com` | https | renderer `<img>` | third-party avatars | index.html CSP `img-src` |
| `www.evnia.philips` | https | system browser | logo click | AP/renderer/assets/main-CDosWiM3.js:1868 |
| `www.nuget.org`, `licenses.nuget.org`, `github.com/nlua` | https | system browser | open-source licence links (About → Software notice) | styles:30515-30518 |
| `download.visualstudio.microsoft.com` | https | NSIS installer | .NET 3.1 runtime download, **dormant** (macro call commented out) | APP/resources/installer.nsh |
| `localhost:10010` (bound as `*:10010`) | http/ws | renderer ↔ backend | SignalR hub `/EvniaHub` and REST controllers | DC/EvniaServe/Evnia/Program.cs:37 |
| LAN multicast `224.0.0.251`/`ff02::fb`:5353, UDP 5540, BLE | udp/ble | Matter controller | Matter discovery/operational traffic (LAN only) | AP/matter-control.mjs:6638, 53041 |

Library-only strings that are never contacted: `json-schema.org`, `raw.githubusercontent.com/ajv-validator` (ajv `$id` constants), `http://localhost:9999` (undici placeholder), `aka.ms/signalr-core-differences` and `docs.microsoft.com` (SignalR error text), `jimmy.warting.se` (licence comment), `vuejs.org/error-reference` (Vue), `project-chip.github.io/.../qrcode.html` (matter.js log string, matter-control.mjs:58144), `www.nlog-project.org` and `www.w3.org` (XML namespaces), `www.microsoft.com/networking/WLAN/profile/v1` (ManagedNativeWifi XML namespace), `int3.de` (elevate.exe copyright).

### 2.2 Cloud constants (CONFIRMED)

Defined twice, in main `Rh` (AP/main/index.js:13338-13348) and renderer `bf.PROD` (styles:30673-30686). The renderer copy adds `pcenterDomain` and `COUNTRY_MAP {ja:"JP", en:"EN", fr:"FR"}` (default `"WW"`).

| Key | Value |
|---|---|
| productId | `857` |
| brandId | `5` |
| dpBrandId | `134` (deviceportal, non-monitor components) |
| dpExternalBrandId | `74` (deviceportal, monitor scaler firmware) |
| deviceType | `Evnia_Precision_Center` |
| deviceSetId | `fcaa1d17c43a11eca53606dda80f8953` |
| channelId (main only) | `649643723902683262` |
| app version string `tm`/`Rf` | `1.13.0` (main:9300, styles:30688) |
| version code `Wf(v)` | major + minor padded to 3 digits + patch padded to 2, so `1.13.0` → `101300` (main:12709-12712) |

### 2.3 Request stacks and auth

| Stack | File:line | Base | Headers | Auth | Timeout | Response envelope |
|---|---|---|---|---|---|---|
| main `qh()` | AP/main/index.js:13378-13416 | n/a | caller-supplied | n/a | `AbortSignal.timeout(20000)` | `errorCode` present: `0` → resolve `data`, else emit `globalErrorHandle` and reject `errorCode`. Else `error === 0` → resolve `datas`, else reject `error` |
| main `Vh.get` | 13417-13425 | `saas.zeasn.tv` | `brandId, productId, deviceType, devicesetId` + extra + `Cache-Control: no-cache` | none | 20 s or caller | as `qh` |
| main `Gh.get` | 13426-13432 | `deviceportal.zeasn.tv/direct` | `Authorization: ZAuth <keyId>:<b64 HMAC-SHA1("GET "+href+" "+md5(""), secret)>` | `Vf()` main:12718-12722 | 20 s | as `qh` |
| renderer `Sv()` | styles:32928-32969 | identical copy of `qh` (proxy branch unreachable in renderer: `rv={}`) | | | 20 s | as `qh` |
| renderer `_v.get` | styles:32970-32978 | saas | as `Vh` | none | | |
| renderer `Ev.get` | styles:32979-32985 | deviceportal | `ZAuth` via `Fm()` styles:13343-13347 | | | |
| renderer `vv.{get,post,put,delete}` | styles:32986-33021 | pcenter | `hv` + `userToken` (caller) + JSON | none besides `userToken` | 20 s | GET: `{errorCode, data, totalSize}`. Others via `Sv` |
| renderer `yv.{get,post,put,postJson,putJson}` | styles:33022-33061 | saas | `hv` + `action:<name>` (+`userToken`) + `Authorization: km(path)` | `km()` styles:13335-13342: `<AccessKey>:<b64 HMAC-SHA1(path + ts, SecretKey)>:<ts>` | 20 s | via `Sv` |

- Hard-coded secrets (redacted here): ZAuth key id `iEN5…==` and HMAC key `uau+…=` (main:12721, styles:13346); AccessKey `125e…` / SecretKey `11f6…` (styles:13336). They are only needed by the online paths being removed. **Delete them.**
- The password "encryption" `zm()` (styles:13375-13379) is reversible obfuscation: rotate the characters, then base64. The effective protection is TLS only.
- The generic component-update call `iv()`/`Mv()` (main:13441-13470, styles:33075-33111) is `GET deviceportal/component/update` with query `brandId` (134, or 74 for monitor firmware), `components=<componentId>=<version>`, `deviceType`, `language` (default `en`), `push=true`, `ScalerIC=true`, `ruleMac=<MAC>`, `ruleUSBHubCount=<hubCnt|"">`. It returns an array of items. The code reads `url`, `hashMethod` (`crc32` or `md5`), `hashValue`, `version`, `versionName`, `friendlyVersion`, `description` and `id`. Items whose `versionName.split("|")[0]` is numeric and greater than `101300` are dropped (minimum-app-version filter).

---

## 3. Electron main process touchpoints (AP/main/index.js)

### N01. MonitorInfo.json refresh (automatic, every backend start) – CONFIRMED

- Code: `ov.verifyMonitorInfoJson()` 13508-13545 and `getLocalMonitorInfoVersion()` 13546-13557. Called from `ov.run()` 13483-13507, which the renderer triggers through IPC `startupBackendService` (17428-17431) during the Startup view (AP/renderer/assets/main-CDosWiM3.js:165-201). **EvniaServe is spawned only after this resolves.**
- Request: `iv({deviceType:"PhilipsMonitorsOTA", componentId:"PrecisionCenter_Monitors_OTA_JSON", version:<local Version>}, false, <MAC>)`, which becomes `GET https://deviceportal.zeasn.tv/direct/component/update?brandId=134&components=PrecisionCenter_Monitors_OTA_JSON=34&deviceType=PhilipsMonitorsOTA&language=en&push=true&ScalerIC=true&ruleMac=<mac>&ruleUSBHubCount=`, signed with ZAuth.
- On a non-empty result: `Ch(url,{hashMethod,hashValue})` (13286-13303) runs Node `fetch(url)`, writes `%TEMP%\evnia-Download\<basename(url)>`, and verifies with `Nh()` (13305-13321: `crc32` lower-hex or `md5`; any other method skips verification). It then parses the JSON, sets `.Version = item.version`, writes it back, and renames it (async, **not awaited**, so it can race the backend start) to `UD/MonitorInfo.json`. Errors are logged and ignored.
- Log evidence: `26-09-25.log 21:23:53 Verify crc32, path: …\evnia-Download\PCenter_MonitorInfo_v34.json efb1d971 efb1d971`. On `26-09-23.log` there is `Fetch MonitorInfo TypeError: fetch failed` and the backend still started.
- Strip: delete `verifyMonitorInfoJson`. Keep only the seeding step (write the bundled table if missing) or, better, read a read-only bundled file. See §7.

### N02/N03. App self-update: device sign-in, version check – CONFIRMED

- `Dv` class 16589-16787. It runs on every launch from `run()` (17195-17204: `softwareUpgrade.startupInit()`). **The main window's `start()` waits for it** (`updateCheckDone`), so an unreachable network delays the UI by up to about 25 s. It also runs on the tray "Check for Updates" item and renderer IPC `checkSoftwareVersion` (16606).
- N02 `deviceSign` (16671-16690): `GET https://saas.zeasn.tv/auth-api/api/v1/auth/deviceSign?brandId=5&productId=857&deviceSetId=fcaa…&mac=<MAC>&countryCode=&appVersion=1.13.0`. Headers: `brandId, productId, deviceType, devicesetId, action:getToken, Cache-Control`. Response `{token, expiredAt}` (ms epoch), cached in memory in `av`.
- N03 `clientUpg` (16691-16720): `GET https://saas.zeasn.tv/sp/api/device/v1/clientUpg?channelId=649643723902683262&ruleMac=<MAC>&token=<token>&pkg=windows.test.evnia&versionNum=101300&langCode=<store.language>`, 5 s timeout. Response `data` is `{newVersionName, downloadUrl, md5, description}`, or falsy when already latest.
- State machine `jv` (16580-16588): `0 Latest, 1 WithNewCache, 2 WithoutNewCache, 3 SilentDownload, 4 RunUpgrade, 5 AfterInstall`. `startupInit` (16616-16634):
  - If `latestSoftwareInfo` is stored, go to state 5 and show the "what's new" prompt.
  - Otherwise, when `automaticUpdate` (default true) is set: state 2 → `packageDownload()` (silent) and state 3; state 1 with `autoUpdate` (default true) → `packageInstall()` and state 4. `ignoreVersion` is honoured only on the startup check.
- Real states: 09-23 `0` (offline), 09-25 `3` (silent download), 09-26 `5` (after install). CONFIRMED.
- Strip: delete `Dv`, `Cv`-based installer download, the `elevate.exe` spawn, IPC channels `checkSoftwareVersion`, `softwareDownload`, `softwareInstall`, `cancelSoftwareUpgrade`, main→renderer `newVersionPrompt`/`versionCheckResult`, store keys `autoUpdate`, `automaticUpdate`, `latestSoftwareInfo`, `ignoreVersion`, and the tray "Check for Updates" item. Distribution updates go through the Linux package manager.

### N04. Installer download and execution – CONFIRMED

- `Dv.packageDownload()` (16722-16729) → `Cv.create(downloadUrl, md5, "md5", %TEMP%\evnia-Download\"evnia Setup <ver>.exe")` → `webContents.downloadURL()` (16544; Chromium network stack, which is why `gcdn.zeasn.com` appears in UD `Network Persistent State`). Integrity is **MD5 only, against a server-supplied value**. There is no Authenticode or signature check.
- `packageInstall()` (16734-16760): `spawn(<installer>, ["--updated","--force-run"], {detached})`, or via `resources/elevate.exe` when the install directory is not writable, then `app.exit()` after 2 s. `deleteUnmatchedPackage` removes other `evnia Setup *.exe`.
- Log: `26-09-25.log` 21:23:53 `Task start https://gcdn.zeasn.com/prod/zeasn-saas-pp/apk/global/857/20260915061410_gnhffvtk.exe → …\evnia Setup 1.13.0.exe`, then 21:24:16 `Verify md5 … 586207dd…` and `Task success { fileSize: 144233136, mimeType: 'application/x-msdownload' }`.
- Strip: delete (with N02/N03). Also delete `resources/elevate.exe`.

### N05. Resource patch pack `RES_PCenter_<code>` (automatic, every `start()`) – CONFIRMED

- `Ov()` 16789-16825, called at the end of `start()` (17281). Local dir `UD/patch/RES_PCenter_101300` (`Pv`, 16788). The local version comes from `<dir>/config.json` `{version, files:[{fileName, md5}]}` and is used only if every listed file exists with a matching MD5, otherwise 0.
- Request: `iv({deviceType:"RES_PCenter", componentId:"RES_PCenter_101300", version:<n>}, false, MAC)` → deviceportal `/component/update`, brandId 134. On a result: `Ch()` download, then `Wd()` (extract-zip) into the patch directory, then delete the zip.
- Consumer: renderer i18n loader reads `<patchPath>/translation.json` and overrides bundled strings (styles:29400-29417). `patchPath` comes from `getRunConfig` (17421-17430). No other consumer was found.
- Real state: `UD/patch/RES_PCenter_101100/` and `RES_PCenter_101300/` exist but are **empty**. Logs show `No update to resource pack` (09-25 and 09-26) and `Fetch from server TypeError: fetch failed` (09-23).
- Strip: delete `Ov()` and the `patchPath` override (use bundled translations only).

### N06. Generic download manager `Cv` (renderer-driven) – CONFIRMED

- 16503-16578. IPC `createDownload(url, hashValue, hashMethod="md5", destPath="")` and `cancelDownload(url)`. It uses `webContents.downloadURL` plus the `electron-dl`-style `_v()` helper (≈16420-16486), verifies with `Nh()`, and sends `downloadProgressUpdate`, `downloadSuccess` and `downloadFail` to the window. The default directory is `%TEMP%\evnia-Download`.
- Callers (renderer `Sy()` hook, styles:33564-33600): firmware OTA (N17), DTS (N19), SmartDesktop (N20), Matter node (N21), and the app installer (N04).
- Strip: delete the class and both IPC channels. If the renderer is reused unchanged, stub `createDownload` to immediately emit `downloadFail {url, msg:"offline"}`.

### N07. `imageResourceDownload` – CONFIRMED (code), not exercised on this machine

- IPC handle 17612-17633. It creates `UD/ImageCache`, downloads with Node `fetch` via `fileDownload()` (17702-17728, MD5 check), extracts the zip to `UD/ImageCache/<model>`, and deletes the zip. It is driven by N16.
- Real state: **no `UD/ImageCache` directory exists**, so this never ran on the user's machine.
- Strip: delete. Device images come from bundled assets (§5.3).

### N08. `getCloudFileCacheOrDownload` – CONFIRMED (code)

- IPC handle 17634-17646. It requires `store.userInfo.id` (logged in) and downloads a cloud profile/macro file into `UD/Cloud User/<id>/<name>` with MD5 check. Driven by N14.
- Strip: delete.

### N09. External browser launches – CONFIRMED

- IPC `openDefaultBrowser(url)` (17647-17649) runs `exec("start " + url)` on Windows, `open` on macOS and `"xdg-open" + url` on Linux (missing space: a bug; also shell-injection-prone). Callers: logo click → `https://www.evnia.philips` (main-CDosWiM3.js:1868, bound at 1980); licence links in the Tou dialog (styles:30502, 30641); OAuth `codeUrl` (styles:38787-38801, N18).
- `mainWindow.webContents.setWindowOpenHandler(t => (shell.openExternal(t.url), {action:"deny"}))` (17243) sends any `window.open`/`target=_blank` navigation to the OS. No such call was found in the renderer.
- Strip: remove OAuth usage. For the logo and licence links, either drop them or use `shell.openExternal` behind a hard-coded allowlist (`https://www.evnia.philips`, licence URLs), never through a shell string. The window-open handler should `deny` without `openExternal`.

### N10. Custom URL scheme `EvniaPrecisionCenterApp://` (OAuth return path) – CONFIRMED

- 17736-17746: `app.setAsDefaultProtocolClient("EvniaPrecisionCenterApp")` runs on every packaged start (registers HKCU). The `second-instance` handler (17159-17174) parses the last argv as a URL, turns `searchParams` into an object and sends it as `thirdPartySuccess` to the renderer, which routes it by `type` (`ISLOGIN`/`ISASS`, styles:14212-14226, `Ol` at styles:5650) to `/oauth/apps/login` or `/oauth/addThirdPlatform`.
- Strip: delete the protocol registration and the `thirdPartySuccess` path. Keep the `second-instance` handler only to focus the window. The Linux `.desktop` file must not declare `x-scheme-handler/evniaprecisioncenterapp`.

### N11. Proxy support that disables TLS verification – CONFIRMED

- `qh()` 13381-13398: if `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` or `http_proxy` is set, it sets `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` (13387). That disables certificate checks for **all** Node TLS in the main process. It then lazy-loads undici `ProxyAgent` from `./index-QljccwTz.js` (the whole file is the undici library, 12350 lines).
- Strip: delete the branch and the `index-QljccwTz.js` chunk. There will be no outbound HTTP left to proxy.

### N12. `local://` protocol handler – CONFIRMED

- 17179-17182: `protocol.handle("local", req => net.fetch(decodeURI(path.normalize(req.url.split(":///")[1]))))`. It serves `ImageCache` images (`local:///<userData>/ImageCache/<model>/<face>.png`, styles:33364-33387). It forwards an arbitrary decoded string to `net.fetch`, so a crafted `local:///https://…` could reach the network (INFERRED).
- Strip: if still needed (it will not be, once ImageCache is gone), reimplement as a file reader restricted to an allowlisted directory, returning 404 otherwise.

### N13. Node/Chromium implicit network (Linux-specific) – INFERRED

- No `webPreferences.spellcheck` is set (AP/main/index.js:17215-17222, 9205-9210, 9232-9240), so Electron's default `true` applies. UD `Preferences` holds `{"spellcheck":{"dictionaries":["en-US"]}}`. On Windows Electron uses the OS spellchecker. **On Linux Electron downloads Hunspell `.bdic` files from Google's CDN** (Electron default dictionary URL). No UD `Dictionaries` folder exists on Windows, which fits the Windows behaviour.
- Electron 32 does not enable component updater, Safe Browsing or crash upload by default, and `crashReporter` is never started (grep).
- Strip: set `spellcheck:false` on every BrowserWindow, and/or `session.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/")`. Add the network-deny guard in §9.

### N14. MAC and system-info collection (PII sent to the cloud) – CONFIRMED

- `Dh()` 13322-13337 takes the first non-zero MAC from `os.networkInterfaces()`. It is sent as `ruleMac` (every `/component/update`), `mac` (`deviceSign`, `login`) and inside feedback `sysParams`. It is exposed to the renderer through `getRunConfig.mac` and IPC `getMac` (17533).
- `getSystemInfo` (17573-17583): `tmpDir, appDataDir, computerName (hostname), osType, osPlatform, arch, release, uptime, totalmem`. The only consumer is feedback (N22).
- Strip: delete `Dh`, `getMac`, `getSystemInfo`, and `runConfig.mac`.

---

## 4. Renderer touchpoints (AP/renderer/assets/*)

### N15. Accounts: login, registration, profile (saas `/user/device/*`) – CONFIRMED

All calls go through `yv` (HMAC `km()` auth, `action` header). The path prefix `Nv = "/user/device"` (styles:33112).

| Path | Method | Params/body | Extra headers | Code |
|---|---|---|---|---|
| `/token/refresh` | PUT (query) | `userToken` | `action:refreshToken` | styles:33113-33115; **auto at startup if `store.userInfo.token`** (main-CDosWiM3.js:229-243) |
| `/sendEmail` | GET | `email, checkEmail=true, templateId=precisionCenter, langCode` | `action:sendEmail` | 33116-33122 |
| `/sendEmail/bindEmail` | GET | same + `productId` | `action:bindEmail` | 33123-33129 |
| `/regist` | POST form | `email, userName, encryptedPwd, verifyCode` | `action:regist` | 33130-33132 |
| `/login` | POST form | `email, encryptedPwd, mac` | `action:login` | 33133-33138 |
| `/forgetPwd` | POST form | `email, templateId, langCode` | `action:forgetPwd` | 33139-33141 |
| `/changeUser` | PUT (query) | `userToken, …fields` (e.g. `icon`) | `action:changeUser` | 33142-33144 |
| `/lockStatus` | GET | `email, productId` | `action:lockStatus` | 33145-33147 |
| `/oauth/upgradeEmailUser` | POST JSON | `email, userName, encryptedPwd, verifyCode, brandId, productId` | `action, userToken` | 33148-33154 |
| `/logout` | POST form | `userToken` | `action:logout` | 35419 |
| `/changePwd` | PUT (query) | `userToken, encryptedPrePwd, encryptedNewPwd, encryptedConfirmPwd` | `action:changePwd` | 35476 |
| `/checkEmailUsage` | GET | `email, productId` | `action` | 35508 |
| `/oauth/deleteThirdPlatform` | PUT JSON | `userThirdPlatformId, encryptedPwd` | `action, userToken` | 35546 |
| `/account/deleteByPassword` | PUT JSON | `encryptedPwd` | `action, userToken` | 35591 |
| `/presignedUrl` | GET | `fileName` → `{fileUrl, presignedUrl}`; then `PUT <presignedUrl>` with the avatar bytes; then `/changeUser {icon}` | | 38930-38960 (avatar upload, N23) |

- Login response: `{userInfo:{id, emailBind, fromSource, icon, …}, userToken}`. It is stored in electron-store `userInfo`. The last login email is stored in the `email` key. The schema also declares a `password` key (AP/main/index.js:9166, AP/preload/index.js:7318). Both are **plaintext** electron-store fields.
- The login dialog appears automatically on the Home view unless `loginState || skipLoginState` (main-CDosWiM3.js:1856-1862). The user's UD `config.json` has `skipLoginState: true` and no `userInfo`.
- Strip: delete all account UI and calls. Drop store keys `userInfo`, `email`, `password`, `skipLoginState` (treat as always skipped). Remove the "Account" views (`name:"Account"`, styles:42376, 43819) and the "Log in" tray/menu strings.

### N16. Device image resources (automatic on every device scan) – CONFIRMED (code path + persisted input)

- `saveDeviceList()` (styles:44635-44722) builds `{deviceTypeName: Fl[type], deviceModelName}` for every connected device whose **raw** `modelName` is not in the bundled list `ry` (styles:33282-33303: `SPK8308…SPK9728, SPK8618, SPL7508, SPL7708, 27M2N8800, 34M2C7600MV, 34M2C8600, 42M2N8900, 49M2C8900, TAG4106, TAG5106`). It then calls `Pb()` (styles:44445-44510).
- `Pb` sends `POST https://pcenter.zeasn.tv/pcenter/device/files` with body `{"idParams":[{deviceTypeName, deviceModelName}]}`. The response is `[{deviceModelName, fileName, fileUrl, fileMd5}]`. For models without `UD/ImageCache/<model>` it calls IPC `imageResourceDownload` (N07) and records `localStorage.device_image_marks[model] = md5`.
- **`saveDeviceList` does not resolve until this request finishes** (it awaits `Pb(...).then(t)`), and the Startup view awaits `saveDeviceList` before `isBackendInit` (main-CDosWiM3.js:196-200). An unreachable network therefore delays UI init by up to 20 s.
- The user's monitor: `localStorage.deviceInfo = [{"modelName":"PHL 34M2C8600",…}]` (UD Local Storage leveldb, CONFIRMED). `"PHL 34M2C8600"` is not in `ry`, so the request `idParams:[{"deviceTypeName":"Monitor","deviceModelName":"PHL 34M2C8600"}]` fires on every scan (INFERRED to have returned nothing, because no ImageCache exists). POST responses are not kept in the Chromium cache, so there is no cached copy.
- `getDeviceImage` → `POST /pcenter/device/images {idParams}` → `[{deviceModelName, imageUrl}]` is used only for cloud-profile previews (styles:39612-39632, needs login). The result is cached in `sessionStorage.devicesImageCache`.
- Display: the `DeviceImage` component (styles:33304-33400) strips a leading `PHL` and takes the last token, so `"PHL 34M2C8600"` becomes `34M2C8600`, which **is bundled**: `renderer/monitor/34M2C8600{,_rear,_source}.png`. Offline, nothing is lost for this monitor.
- Strip: delete `Pb` and the call in `saveDeviceList`. Always resolve locally.

### N17. Firmware OTA (monitor scaler, sub-devices, peripherals) – CONFIRMED

- Hook `Ry()` styles:33789-34070. The check is `S(e)` (33867-33898) → `Mv({deviceType, componentId, version, language, hubCnt}, isMonitor)`:
  - Monitor (`scalerName` defined): `brandId=74`, `deviceType=<ScalerModelName>`, `components=<ScalerBomInfo>=<FwVersion>`, `ruleUSBHubCount=<UsbHubCount>`.
  - Peripherals: `brandId=134`, `deviceType=<ExtDeviceInfo.DP_DeviceType>`, `components=<DP_ComponentID>=<FwVersion>` (component IDs are built in the backend, e.g. `EVNIA_MS_<model>_…`, `EVNIA_KB_<model>_…`, `EVNIA_MT_…`, `EVNIA_24G_SPK9718_…`; DC/Zeasn.Equipment.Option.Lib/…).
  - It stores `friendlyVersion, url, description, hashMethod, hashValue`.
- Monitor inputs come from Bridge `DisplayFW_GetDeviceList` (DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/PHLDisplayFW.cs:218-250). **User values (UD localStorage `monitorFw`, CONFIRMED):** `{modelName:"34M2C8600", fwComponentID:"100GPRS2003NA1SXXY", fwVersion:"V1.01"}` and `{modelName:"34M2C8600_Ambiglow", fwComponentID:"100GPRS2003NA1SXXY_Ambiglow", fwVersion:"V000B"}`.
- Triggers:
  - Monitor → Setup → "FwUpdate" tab. It is present when `OTASupport()` is true: `OTAEnable && configInJson[<normalized model>].SupOTA` (styles:9385-9387; Setup-D-5j4V-I.js:308). Opening the tab mounts `FirmwareUpgrade` (FirmwareUpgrade-BsUoyIKp.js:62-85), which checks immediately.
  - Settings → "FwUpdate" (`FirmwareManager`, styles:34326-34440) checks every connected peripheral automatically. The monitor check there runs only if `OTASupport(e.modelName)`. With the raw key `"PHL 34M2C8600"` that lookup misses (keys are normalized to `34M2C8600`), so there is no auto-check from this page for the user's monitor (INFERRED quirk).
- Download: `Sy().doDownload` → N06. Burn:
  - Monitor: Bridge `DisplayFW_UpdateFirmversion(scalerName, type, filePath)` (styles:8403-8405; DC/Bridge.Lib/Bridge.Lib/Bridge.cs:339-342).
  - Peripherals: extract the zip, find an `.exe` and run it through IPC `runCommand` with args `1` or `-MSRY6608` (styles:33933-33950, 34030-34047), or Bridge `Device_UpgradeFw`.
- Strip: delete the online check and the download. **Recommended:** also drop flashing from the Linux port, or at most keep a later, separately reviewed "flash local file" expert feature that is out of scope here. Keep the local "firmware version" display (`DisplayFW_GetDeviceList` is local DDC/USB). Force `OTAEnable=false` so the FwUpdate tabs disappear.

### N18. Third-party OAuth (Google, Facebook, Twitch, WeChat) – CONFIRMED

- Hook `yT()` styles:38708-38870. It runs on mount of Login/Account (`sn(() => {_(); …})`) and whenever the network comes back online:
  - `_()`: renderer `deviceSign` (`GET saas/auth-api/api/v1/auth/deviceSign?brandId=5&productId=857&deviceSetId=…&mac=<MAC>&countryCode=<EN|JP|FR|WW>&appVersion=1.13.0`), then `GET saas/user/device/oauth/apps?productId=857&token=<t>&osType=WEB` (`action:thirdPartyMenu`).
  - Response items: `{appId, appName, codeUrl, state}` for `FACEBOOK, GOOGLE, TWITCH, WECHAT_CN`. The authorize hosts are `www.facebook.com/v17.0/dialog/oauth`, `accounts.google.com/o/oauth2/v2/auth`, `id.twitch.tv/oauth2/authorize`, `open.weixin.qq.com/connect/qrconnect`, and `redirect_uri=https://auth.zeasn.tv/evnia/`.
  - **Both requests are present in the UD Chromium cache** (`Cache_Data/data_1`, `data_2`, recorded from v1.11.0 with `countryCode=EN`). CONFIRMED.
- `E()` rewrites `state` to `<state>:ISNS:<ISLOGIN|ISASS>:<lang>`, replaces `&` with `^&` for cmd, and opens the result in the browser (N09). The return trip goes through N10. Then either `GET /oauth/apps/login?code&state` → `{userInfo, userToken}`, or `POST /oauth/addThirdPlatform {code, state}`. `GET /oauth/getThirdPlatform?userToken` lists linked accounts.
- Strip: delete.

### N19. DTS headset server download/install – CONFIRMED (code)

- Setup-daShw_PC.js:44-130 (`DTSInstall`) → `Mv({deviceType:dtsData.deviceType, componentId:dtsData.componentId, version})`. The IDs are `EVNIA_DTS_<model>` and `EVNIA_DTS_<model>_<a>_<b>` (DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/CDevice_TAGHeadsetDTS.cs:49-59). The flow is download (N06), extract, `findExe`, then `runCommand("<exe>" /targetDir "%APPDATA%\G-MenuDTSServe")`. Bug: an `.exe` payload recurses forever (`se(e)` calls itself).
- Only relevant to TAG headsets (not owned). Strip: delete.

### N20. SmartDesktop (PowerToys FancyZones repack) download/install – CONFIRMED (code)

- SmartDesktop-By8ZEPkl.js:45-160. On page mount, `ne()` reads Bridge `FancyZones_GetVersion`, which returns `DP_DeviceType:"SmartDesktop"` and `DP_ComponentID:"Philips_SmartDesktop"` (DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/FancyZonesOper.cs:35-36). It then **automatically** calls `Mv({deviceType:"SmartDesktop", componentId:"Philips_SmartDesktop", version})`. "Download" leads to N06 and then `runCommand("<exe> /targetDir \"%APPDATA%\SmartControl\Modules\SmartDesktop\"")`.
- The backend log shows it probing `…\SmartControl\Modules\SmartDesktop\modules\FancyZones\PowerToys.FancyZones.exe` (not installed). SmartDesktop is Windows-only (FancyZones).
- Strip: delete the page, the component check and the download.

### N21. AmbiScape (Matter smart bulbs): Node runtime download – CONFIRMED (code)

- styles:35108-35175 (`AmbiScape` settings): `Mv({deviceType:"EVNIA_Plugins", componentId:"EVNIA_AmbiScape_NODE_1801200", version:"0"})` → download (N06) → IPC `extractZip` into `UD/Matter` → expects `UD/Matter/node.exe` (main `zv.checkNodeAvailable`, 16833-16857). Node is then used to run `resources/matter/control.mjs` (N37). Bulbs are enabled only when `store.ambiScapeEnable && node available` (main-CDosWiM3.js:2104-2110).
- User state: `ambiScapeEnable:false`, and no `UD/Matter` directory. Not used.
- Strip: delete the entire AmbiScape/Matter feature, including `resources/matter/`, the bulb IPC channels (`checkNodeAvailable`, `getCurrentProcess`, `discoverBulb`, `pairingBulb`, `commissionBulb`, `openCommissioningWindow`, `identifyBulb`, `getBulbAttribute`, `setBulbAttribute`, `removeBulb`, `destroyBulbProcess`, `clearCache`), the renderer `AmbiScape` chunk, and the Bridge `GetWifiList` (N32).

### N22. Feedback window (log upload) – CONFIRMED (code)

- AP/renderer/assets/feedback-NPrjkfNw.js:78-165. It is opened from the tray "Feedback" item or IPC `openFeedbackWindow`. It checks `navigator.onLine` and allows at most 3 sends per day (`localStorage.feedbackCnt`).
- Images: `fileSelect` → `GET pcenter/pcenter/file/presignedUrl?fileName&module=feedback&contentType` → `PUT <presignedUrl>` with raw bytes → `fileUrl`.
- Submit: `POST https://pcenter.zeasn.tv/pcenter/feedback/submit` with body `{questionType:1-4, content, softwareVersion:"1.13.0", sysParams: JSON(getSystemInfo + mac), deviceInfo: "<modelNames>", firmwareVersion: "<componentId>=<fw>,…", contactEmail?, imageUrls?, logUrl?}`.
- "Attach log" is **on by default** (`ge = true`). It uploads `%APPDATA%\EvniaServe\logs\<yyyy-mm-dd>.txt`. That file contains EDID dumps, monitor serial numbers, the full HID device path list (including non-Philips devices), process names and hub traffic (see SD logs).
- Strip: delete the feedback window, `renderer/feedback/`, the tray item, and IPC `openFeedbackWindow`/`closeFeedbackWindow`.

### N23. Avatar upload – CONFIRMED (code)

styles:38930-38965: the image is compressed (N24), then `GET saas/user/device/presignedUrl?fileName`, then `PUT <presignedUrl>`, then `PUT /changeUser {icon}`. Strip with N15.

### N24. Remote script: browser-image-compression from jsDelivr – CONFIRMED

styles:38586-38600: `libURL = "https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/dist/browser-image-compression.js"` is loaded inside a blob Worker with `importScripts`. It is used only by the avatar upload (`fT(o,{maxSizeMB:1,maxWidthOrHeight:300})`, styles:38936). This is remote code execution from a CDN into a renderer that has `nodeIntegration:true, sandbox:false` (AP/main/index.js:17220). Strip with N15.

### N25. Remote WASM: zxing-wasm from fastly.jsdelivr.net – CONFIRMED

AmbiScape-B35D_GM2.js:358-363 (`zxing-wasm@1.1.3`) and 3580-3583 (`@3.1.0`): `locateFile` returns `https://fastly.jsdelivr.net/npm/zxing-wasm@<v>/dist/<variant>/<file>.wasm`, fetched with `fetch(...,{credentials:"same-origin"})` (≈466, 3672-3724). This is the QR-code decoder (vue-qrcode-reader, camera `getUserMedia` at ≈2727-2737) for Matter pairing codes. Strip with N21.

### N26. Remote images (avatars, cloud previews) – CONFIRMED (CSP + code)

`userInfo.icon` and third-party avatars render as `<img src>`. The CSP `img-src` allows `lh3.googleusercontent.com`, `thirdwx.qlogo.cn`, `static-cdn.jtvnw.net`, `platform-lookaside.fbsbx.com`, `http(s)://cache.zeasn.tv` (AP/renderer/index.html). Cloud device `imageUrl` values (N16) are rendered as well. Strip with N15/N16 and tighten the CSP (§9).

### N27. External links – CONFIRMED

`https://www.evnia.philips` (logo, main-CDosWiM3.js:1868/1980) and the licence URLs (styles:30515-30518, click at 30641). Both go through N09. Keep them optional behind an allowlist, or drop them.

### N28. `/pcenter/config` – CONFIRMED unused

`$T.getConfig(keys[], startIndex, size=50)` (styles:39506-39508) has no callers (grep). Delete.

### N29. Cloud themes, profiles and macros (pcenter) – CONFIRMED (code)

Class `$T` styles:39426-39508, uploads `XT()` 39509-39600, listing `tP()` 39602-39700, auto-fetch on login `setUserInfo` 44776-44782. Headers: `hv` + `userToken`.

| Path | Method | Params/body |
|---|---|---|
| `/pcenter/theme` | GET | `startIndex, size=50` |
| `/pcenter/theme` | POST | `{themeName}` |
| `/pcenter/theme` | PUT | `{id, themeName}` |
| `/pcenter/theme` | DELETE | `?id` |
| `/pcenter/profile` | GET | `themeId, startIndex, size=50` → `data[]{id, profileName, fileUrl, fileMd5, remark(JSON device list), updateTime}` |
| `/pcenter/profile` | POST | `{themeId, fileName, fileUrl, fileMd5, remark, fileOverride}` |
| `/pcenter/profile` | PUT / DELETE | `{id, profileName}` / `?id` |
| `/pcenter/macro` | GET | `themeId, startIndex, size=150` |
| `/pcenter/macro` | POST | `{themeId, fileName, fileUrl, fileMd5, fileOverride}` |
| `/pcenter/macro` | PUT / DELETE | `{id, macroName}` / `?id` |
| `/pcenter/file/presignedUrl` | GET | `fileName, module (theme|feedback), contentType` → `{presignedUrl, contentType, fileUrl}` |
| `/pcenter/file/exist` | GET | `userToken, fileCategory, themeId, fileName` → `{names[]}` |

The file names uploaded are `<name>_<userId>.pcenter` and `<name>_<userId>.macro`. Downloads go through N08. Local import/export of `.pcenter`/`.macro` files (Bridge + `fileSelect`/`exportFile`) is **offline and stays**. Strip only the cloud tabs, "import source = cloud" options (styles:39400-39410 `importSourceOptions`), the preview dialogs and `$T`.

### N30. Online/offline detection – CONFIRMED

The `Ab` store sets `isNetworkOnline: navigator.onLine` (styles:44517), updated by `window` `online`/`offline` listeners (main-CDosWiM3.js:2119-2142). Other checks use `navigator.onLine` directly (styles:33827-33828, 33950-33972, 34390; feedback:100). Offline, every online UI shows a "NoNetwork"/"Network Unavailable" dialog instead of failing. If the renderer bundle is reused, setting this flag permanently `false` is a safe backstop but not sufficient on its own: the automatic calls N01-N05 and N16 do not check it.

### N31. Content-Security-Policy – CONFIRMED

AP/renderer/index.html has:

```
default-src 'self' ws://localhost:* http://*.zeasn.tv https://*.zeasn.tv https://*.amazonaws.com https://*.jsdelivr.net;
img-src 'self' data: blob: http://localhost:* https://lh3.googleusercontent.com/ https://thirdwx.qlogo.cn/ https://static-cdn.jtvnw.net/ https://platform-lookaside.fbsbx.com/ http://cache.zeasn.tv https://cache.zeasn.tv local://*;
script-src 'self' 'wasm-unsafe-eval' http://localhost:* data: https://*.jsdelivr.net;
style-src 'self' 'unsafe-inline'
```

The feedback window has a similar policy, plus `script-src blob: https://cdn.jsdelivr.net`. The notice window has **no CSP**. Replacement: §9.

---

## 5. .NET backend touchpoints (DC/**)

### N32. `GetWifiList`: Wi-Fi SSIDs **with cleartext saved passwords** – CONFIRMED

- Bridge `GetWifiList()` (DC/Bridge.Lib/Bridge.Lib/Bridge.cs:44-47) → `SystemOper.GetWifiList()` (DC/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs:316-344). It uses ManagedNativeWifi (`ScanNetworksAsync`, `EnumerateInterfaceConnections`, `EnumerateAvailableNetworks`). For **each** SSID it runs `cmd.exe /c chcp 437 && netsh wlan show profile name="<ssid>" key=clear` (346-375; an SSID can inject into the command line) and returns `[{Ssid, SignalQuality, IsSecurityEnabled, IsConnect, Password}]`.
- The caller is the AmbiScape Matter pairing UI, which polls every 8 s at step 6 and pre-fills the Wi-Fi password (AmbiScape-B35D_GM2.js:5785-5806; styles:29943-29951). The values are then passed to the Matter process as `--wifiSsid`/`--wifiCredentials` argv (AP/main/index.js:16941-16950), and matter.js **logs them** (`wifiCredentials=${e3}`, AP/matter-control.mjs:72193-72195) to stdout. Electron forwards that to its log at debug level (16981-16983).
- Combined with N33, any LAN host or DNS-rebinding web page can read every saved Wi-Fi password.
- Strip: **delete** (and remove the ManagedNativeWifi assembly). Linux has no equivalent requirement.

### N33. Kestrel host: all interfaces, no auth, REST, Swagger, dev exception page – CONFIRMED

- `webBuilder.UseUrls("http://*:10010/")` (DC/EvniaServe/Evnia/Program.cs:37). Electron also passes `--urls http://*:<port>` (AP/main/index.js:13562). `appsettings.json` has `"AllowedHosts": "*"` (INST/resources/bin/appsettings.json), which disables host filtering, so DNS rebinding works.
- `Startup.Configure` (DC/EvniaServe/Evnia/Startup.cs:61-87): `UseDeveloperExceptionPage()`, `UseSwagger()` + `UseSwaggerUI` at `/swagger`, CORS `WithOrigins("app://.")` and `("http://localhost:10010")` with credentials, `MapControllers()`, and `MapHub<EvniaHub>("/EvniaHub")` with 1 MiB buffers. `ConfigureServices` adds a default CORS policy `https://*:10010/` (43).
- REST controllers (all `GET`, no auth):

  | Route | Action | File:line |
  |---|---|---|
  | `/Evnia/GetTaskResult?parm=<json>` | **runs any Bridge function** through `Class0.method_0` | DC/EvniaServe/Evnia/EvniaController.cs:18-22 |
  | `/Evnia/Start` | `Start` | :24-33 |
  | `/Evnia/FactoryReset` | `SyncEffect_GetData` | :35-44 |
  | `/Display/PHL_SwitchDisplay`, `/Display/PHL_SetGamePQ` | | DisplayController.cs:13, 25 |
  | `/Profile/DeviceReset` | | ProfileController.cs:12 |
  | `/Theme/Theme_GetCurThemeDevicesBasicInfo`, `/Theme/Theme_GetDevicesBasicInfo` | | ThemeController.cs:20, 31 |

- Dispatcher `Class0` (DC/EvniaServe/Class0.cs:11-173): reflection over `typeof(Bridge.Lib.Bridge).GetMethods(Static|Public)` (120). There is **no allowlist**: `list_0`/`list_1` only suppress logging and control serialization.
- Consequences (INFERRED from standard ASP.NET Core and browser behaviour):
  - A LAN peer can call any Bridge function and read the result, for example `GetWifiList`, or `DisplayFW_UpdateFirmversion` with a UNC path.
  - Any web page can fire a cross-origin `GET /Evnia/GetTaskResult` (a simple request with no preflight; CSRF).
  - Any web page can open `ws://localhost:10010/EvniaHub` with `skipNegotiation` (browsers apply no CORS to WebSockets, and SignalR does not check `Origin` by default). It then receives every broadcast (N34).
  - DNS rebinding bypasses the same-origin policy because `AllowedHosts:*`.
- Strip / Linux requirement: bind `127.0.0.1` only (or a Unix domain socket `$XDG_RUNTIME_DIR/evnia/hub.sock`, mode 0600). Remove the REST controllers, Swagger/Swashbuckle and the developer exception page. Set `AllowedHosts` to `localhost;127.0.0.1`. Require a per-launch random token (generated by Electron and passed via environment variable, checked in `OnConnectedAsync` or by middleware on `/EvniaHub?access_token=`), and reject a non-empty `Origin` other than `file://`/`null`. This is a **keep-as-local** touchpoint.

### N34. SignalR hub `/EvniaHub` – CONFIRMED (keep, local)

- DC/EvniaServe/Evnia/EvniaHub.cs:62-66: `GetTaskAsync(string parm)` → `Class0.method_0` → `Clients.All.SendAsync("GetTaskAsync", result)`. Notifications also go to all clients (HandleEvent). The renderer connects to `http://localhost:${port}/EvniaHub` with `{skipNegotiation:true, transport:WebSockets, timeout:120000}` and automatic reconnect (styles:7888-7905).
- Strip: keep. In the port, reply with `Clients.Caller` and, if there is only ever one client, reject a second connection or require the token. See also report 05 §3.

### N35. Dead HTTP client code with TLS validation disabled – CONFIRMED dead

- `Zeasn.Com.Lib.HttpUtil` (DC/Zeasn.Com.Lib/Zeasn.Com.Lib/HttpUtil.cs:10-77): `Post` (form, GBK) and `Get` (10 s timeout). It sets the global `ServicePointManager.ServerCertificateValidationCallback = CheckValidationResult` (always `true`) on each call.
- `Extension_URL.UrlExists()` (Extension_URL.cs:84-97): `HEAD` with a 100 ms timeout.
- There are **no callers anywhere** in DC (grep for `HttpUtil.` and `UrlExists(`).
- Strip: delete both.

### N36. Host network info – CONFIRMED dead

`CSystemInfo.GetMacAddress()` (WMI `Win32_NetworkAdapterConfiguration`), `GetLocalIP()` and `JudgeIsLocalIP()` (`Dns.GetHostEntry(Dns.GetHostName())`) in DC/Zeasn.Win.Lib/Zeasn.Win.Lib/CSystemInfo.cs:103-178 have no callers. `CSystemInfo.SysInfo()` (30-53, called at startup from Program.cs:55) only logs OS/GPU/VM detection locally. `PortUtil` (PortUtil.cs:13-40) checks and kills local port listeners (local only). Strip: delete the dead methods.

### N37. Macro/button "Launch website" – CONFIRMED (user-configured, peripheral buttons)

DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/MacroMgr.cs:188-213: `ButtonFunc.LaunchWebsite` prefixes `http://` when there is no scheme and writes `start <url>` to a `cmd` stdin, which allows command injection through the URL. It is only reachable through Philips keyboard/mouse button bindings (not owned). Strip, or reimplement as `xdg-open` with an argv array after URL validation.

### N38. Local-only IPC and logging (keep or not applicable) – CONFIRMED

- DTS named pipe (`NamedPipeServerStream`/`ClientStream`, DC/Zeasn.DTS.Lib/Zeasn.DTS.Lib/DtsPipeServerOper.cs:74, 99) is local IPC to `DtsServer` (headsets only).
- NLog writes only to `%APPDATA%\EvniaServe\logs\${shortdate}.txt` (INST/resources/bin/NLog.config). `Zeasn.Log.Lib/ZLog.cs` has no network target.
- `web.config` is IIS in-process hosting metadata and unused standalone.
- `NuGet.Lib` is an empty assembly (only AssemblyInfo).
- `DynamicLghtingUtil` opens `ms-settings:personalization-lighting` (local).

### Backend `MonitorInfo.json` consumers (not network, but fed by N01)

See §7.3.

---

## 6. Native DLLs, Matter bundle, installer

### 6.1 Native DLLs: no network capability – CONFIRMED

| DLL (NT/*.symbols.txt `## IMPORTS`) | Imported libraries |
|---|---|
| DDCHelperLib.dll | KERNEL32, ADVAPI32, USER32, OLE32, OLEAUT32 (strings also name nvapi/atiadlxx/`cryptnet.dll`/`wldp.dll` for dynamic GPU-SDK loading; no network API import) |
| EneEc.dll | KERNEL32, SETUPAPI (strings: ftd2xx, winusb) |
| GL_SDK.dll | KERNEL32, ADVAPI32, BCRYPT, HID, POWRPROF, SETUPAPI, SHELL32, SHLWAPI, USER32, VERSION, WINUSB, OLE32 |
| KBAccess_SPK8618.dll | KERNEL32, HID, SETUPAPI, SHELL32, SHLWAPI |
| Mouse_SPK9418*/9618*/9618_8960* | KERNEL32, SETUPAPI, CRT, VCRUNTIME140 |
| Mouse_SPK9718.dll | KERNEL32, ADVAPI32, HID, SETUPAPI, USER32, OLEAUT32, MSVCP140, CRT |
| RhHidAPI.dll | KERNEL32, ADVAPI32, CFGMGR32, HID, SETUPAPI, USER32 |
| elevate.exe | KERNEL32, ADVAPI32, SHELL32 (`ShellExecuteExW` "runas"; Johannes Passing's elevate) |

Nothing imports or names winhttp, wininet, ws2_32, wsock32, urlmon, iphlpapi, dnsapi, httpapi or wlanapi (grep across all `.symbols.txt`). Nothing needs stripping here.

### N39. Matter controller (`resources/matter/control.mjs` = AP/matter-control.mjs) – CONFIRMED LAN/BLE only

- Imports `node:dgram`, `node:os`, `node:crypto`, `node:fs`. Uses mDNS (`224.0.0.251`/`ff02::fb`, port 5353, 53039-53041), Matter operational UDP port `5540` (6638), and BLE through `@stoprocent/noble` (commissioner) and `@stoprocent/bleno` (67380-67910). Those two modules are **not shipped** (INST/resources/matter/node_modules has only `debug`); presumably they come with the downloaded Node package (N21).
- No HTTP/fetch and no DCL (Distributed Compliance Ledger) or online PAA lookup: only the enum name `FailedDclVendorIdValidation` (24029, 36265) and one log-only URL (58144).
- CLI (72183-72223): `--location=<UD/Matter/Controller> --uniqueId= --ble --discover --qrCode= --matterCode= --wifiSsid= --wifiCredentials=`. It logs all of them, **including Wi-Fi credentials** (72193-72195). Stdout protocol lines are `[Pending] [Init|Reply|Notification|Exit] <json>` (72160-72179).
- Strip: delete (with N21).

### N40. NSIS installer include – CONFIRMED dormant

APP/resources/installer.nsh: the `microsoftDownload` macro downloads the .NET Desktop 3.1.32 and ASP.NET Core 3.1.32 x86 runtimes from `download.visualstudio.microsoft.com` via `NSISdl::download`, but its only reference is commented out (`; !insertmacro microsoftDownload` in `customInstall`). There is no `app-update.yml` and no electron-updater (INST/resources listing, grep). Not applicable to Linux packaging.

### 6.2 Build script

APP/gulpfile.js builds `src/threePartyLogin/**` into an HTML page (babel, browserify, inject). That source is not shipped in the asar; the related OAuth return page is presumably hosted at `auth.zeasn.tv/evnia/` (INFERRED). Nothing to strip in the port.

---

## 7. `MonitorInfo.json` flow (capability flags)

### 7.1 Copies

| Copy | Location | Content | Read at runtime? |
|---|---|---|---|
| Bundled constant `Qf` | AP/main/index.js:12813-12962 | `{EdidToFactory:null, Monitors:[143], Version:34}` | Yes, as seed/floor |
| asar-root file | APP/MonitorInfo.json | identical to `Qf` (v34, 143 entries; verified field-by-field) | **No** (no reader in main, preload or renderer; build artifact) |
| Runtime file | `UD/MonitorInfo.json` (`%APPDATA%\evnia\MonitorInfo.json`) | on the user's machine identical to bundled v34 (compact JSON, 15,457 bytes, written 2026-09-25 21:23) | Yes, by main **and** backend |
| Server copy | `deviceportal /component/update` item `url` → `%TEMP%\evnia-Download\PCenter_MonitorInfo_v<N>.json` | v34 seen | via N01 |

### 7.2 Schema (union of all readers)

```jsonc
{
  "EdidToFactory": null,            // no consumer found (JS/C# grep)
  "Version": 34,                    // int; bundled floor = 34; set from component item.version on download
  "LimitVer_PCenter": [ ... ],      // optional int[]; -1 or the app code (101300) disables OTA (main:17588-17591). Absent in v34
  "Monitors": [
    { "Name": "34M2C8600",          // matched after normalization (below)
      "SupUsbDDC": true,            // no consumer found in JS or C#
      "SupOTA": true,               // renderer OTASupport()
      "SupLightEffect": true,       // renderer ambiglowSupport; backend DeviceInfo.SupEffect
      "SupLightSync": true,         // backend DeviceInfo.SupSync + PHLDisplay_Oper sync state
      "HDR": 400,                   // renderer HDRValue (SmartImageHDR page)
      "FactoryModelNames": ["..."]  // optional; backend PHLDisplayFW.method_4. Absent in v34
    }
  ]
}
```

User-relevant entries (bundled v34, CONFIRMED): `34M2C8600` (all four flags true, HDR 400), `34M2C8600P` (all true, HDR 0), `PHL 34M2C8600` (all true, HDR 400).

### 7.3 Readers and key normalization

1. **Main `getMonitorJsonConfig`** (AP/main/index.js:17584-17605). It reads the file **once per process**, cached in `this.monitorConfig`. It returns `{OTAEnable: !LimitVer.includes(-1) && !LimitVer.includes(101300), config: {<key>: entry}}`, where `key = Name.trim().slice(Name.startsWith("PHL") ? 3 : 0).split(/[\s+|_]/).at(-1)`. So `"PHL 34M2C8600"` → `"34M2C8600"`, and later entries overwrite earlier ones with the same key.
2. **Renderer** Startup (main-CDosWiM3.js:199-200) → monitor store `$patch({OTAEnable, configInJson})` (styles:9369-9397). The getter `modelNameInJson(name)` uses the same normalization. The strip is keyed on the **store's** `ModelName` starting with "PHL", not the argument's, which is a quirk. `OTASupport(name)`, `ambiglowSupport`, `HDRValue` are defined there.
3. **Backend `DictMgr`** (DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/DictMgr.cs:14-29). Path `WorkspacePath.UI_APP_DATA_PATH\MonitorInfo.json` = `%APPDATA%\evnia\MonitorInfo.json` (DC/Zeasn.PCenter.Entity.Lib/.../WorkspacePath.cs:38), read once at singleton init. Lookup `Data_DisplayInfo.GetDisplayInfoItem(modelName)` = first entry with `Regex.IsMatch(modelName, "^((PHL )|(PHL_)|(PHL))?" + Name + "$", IgnoreCase)` (DC/Zeasn.PCenter.Entity.Lib/.../Data_DisplayInfo.cs:27-30). Applied in `CDevice_PHLDisplay.GetDeviceInfo` (DC/Zeasn.Equipment.Option.Lib/…PHLDisplay/CDevice_PHLDisplay.cs:218-245: `SupEffect = SupLightEffect`, `SupSync = SupLightSync`) and `PHLDisplay_Oper.method_1` (sync "On"/"Off", PHLDisplay_Oper.cs:25-35).
4. **Backend `PHLDisplayFW.method_4`** (…PHLDisplay/PHLDisplayFW.cs:112, 510-551). It re-reads `%APPDATA%\evnia\MonitorInfo.json` with Newtonsoft and returns true if `Monitors[i].Name == a && FactoryModelNames contains b` (OTA model-name aliasing).

### 7.4 Ordering constraint

The backend reads the file that Electron writes. In the original, Electron seeds and refreshes it **before** spawning EvniaServe (N01). In the port, install the file as package data and pass its path to the backend explicitly (config/env), or have the Linux backend embed it. Do not depend on `%APPDATA%\evnia`.

### 7.5 Offline recommendation

- Ship `MonitorInfo.json` v34 read-only, e.g. `/usr/share/evnia/MonitorInfo.json`, with an optional user override at `$XDG_CONFIG_HOME/evnia/MonitorInfo.json` (user file wins if its `Version` ≥ bundled; same rule as `getLocalMonitorInfoVersion`).
- Since OTA is stripped, return `OTAEnable:false` from `getMonitorJsonConfig`, but keep `SupOTA` in the data so the firmware *version* can still be shown if desired.
- Ignore `LimitVer_PCenter`.
- Keep `SupLightEffect`, `SupLightSync` and `HDR`: they gate Ambiglow, LightSync and HDR UI for the 34M2C8600.

---

## 8. Ground truth timeline (user machine)

| When (local) | App | Event | Source |
|---|---|---|---|
| 2026-07-14 | v1.11.0 first run | Login dialog; renderer `deviceSign` (countryCode=EN, appVersion 1.11.0) + `/user/device/oauth/apps` → FACEBOOK/GOOGLE/TWITCH/WECHAT_CN | UD Cache_Data data_1/data_2 (dated Jul 14) |
| 2026-09-23 15:45:55 | v1.11.0 | `patchUpdate Fetch from server TypeError: fetch failed`, `Fetch MonitorInfo TypeError: fetch failed`, `Version state 0`. Backend starts normally → **offline works** | UD/logs/26-09-23.log |
| 2026-09-25 21:23:49 | v1.11.0 | `Version state 3` (silent download); `No update to resource pack`; `Verify crc32 … PCenter_MonitorInfo_v34.json efb1d971`; installer download from `gcdn.zeasn.com` (144,233,136 B, md5 `586207dd…`) | UD/logs/26-09-25.log |
| 2026-09-25 21:25 | Chromium | `Network Persistent State`: `https://gcdn.zeasn.com` (supports_spdy) | UD/Network |
| 2026-09-26 07:52:24 | **v1.13.0** | `Version state 5` (AfterInstall); `No update to resource pack`; no MonitorInfo log (no newer version); backend on 10010 | UD/logs/26-09-26.log |
| any | renderer | `localStorage.deviceInfo=[{"modelName":"PHL 34M2C8600","fwComponentID":"","fwVersion":null}]`, `monitorFw=[{"34M2C8600","100GPRS2003NA1SXXY","V1.01"},{"34M2C8600_Ambiglow","100GPRS2003NA1SXXY_Ambiglow","V000B"}]` | UD Local Storage leveldb |
| any | Electron store | `skipLoginState:true`, `autoUpdate:true`, `automaticUpdate:true`, `ambiScapeEnable:false`, no `userInfo`/`email`/`password` | UD/config.json |
| absent | | no `UD/ImageCache`, `UD/Matter`, `UD/Cloud User`; `UD/patch/RES_PCenter_101100` and `_101300` empty | UD listing |
| backend | | No network-related log lines. Hub calls seen: `Start`, `Device_GetConnectList`, `Device_OtherDeviceChange`, `DisplayFW_*`, `Effect_GetColorData`, `FancyZones_GetVersion`, `GetPairDevices`, `Macro_*`, `PHL_*`, `Profile_GetDeviceData`, `Setting_GlobalData`, `SyncEffect_GetData`, `Theme_*` | SD/logs/2026-09-2[5-6].txt |

---

## 9. Security findings relevant to the port (summary)

| # | Finding | Where | Severity for users | Port action |
|---|---|---|---|---|
| S1 | Backend listens on all interfaces with no auth; REST `GetTaskResult` runs any Bridge function; Swagger and developer exception page enabled; `AllowedHosts:*