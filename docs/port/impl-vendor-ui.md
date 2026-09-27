# Implementation notes: vendor UI import and patch pipeline

Module owner: vendor-ui. Sources:

| File | Role |
|---|---|
| `port/scripts/import-vendor-ui.mjs` | CLI (`npm run import-ui`) |
| `port/scripts/ui-patches.mjs` | Vendor-specific data: pins, patches, removals, copies, URL allowlist, reviewed sites and scheme literals, N01–N40 decisions |
| `port/scripts/lib/import-pipeline.ts` | `runImport()`, `defaultPaths()`, `loadPatchTable()`, the manifest |
| `port/scripts/lib/asar-source.ts` | Read-only asar access, entry-name validation |
| `port/scripts/lib/patch-engine.ts` | `ImportError`, pin verification, exact-count patching, table validation |
| `port/scripts/lib/removals.ts` | Dropping files and proving nothing reachable still loads them (`__vite__mapDeps` index check) |
| `port/scripts/lib/csp.ts` | CSP `<meta>` rewrite |
| `port/scripts/lib/audit.ts` | Static audit of the output |
| `port/scripts/lib/output-swap.ts` | Output lock, staging directory, swap of the three output directories as a unit |
| `port/scripts/lib/io.ts` | Wrapping file-system errors in coded `ImportError`s |
| `port/scripts/lib/types.ts` | Table and result types |

Tests: `port/test/unit/vendor-ui/` — `audit.test.ts` (7), `csp.test.ts` (4), `fast-led-upload.test.ts` (4; the FAST-LED-UPLOAD render expression evaluated in a stand-in of the page's render scope, no archive needed), `import-vendor-ui.test.ts` (30; two suites run the real import against the installer's `app.asar` and are skipped without it, one uses synthetic archives), `output-swap.test.ts` (17), `patch-engine.test.ts` (10), `removals.test.ts` (6). 78 tests, `node --test "test/unit/vendor-ui/*.test.ts"`, about 20 s.

Specs: `docs/re/02-renderer-shell.md` §1.2, §3, §4, §7, §11, §L.3 (P1–P11), Online touchpoints; `03-renderer-monitor-pages.md` §4.9–§4.11, §9, §11; `04-renderer-peripheral-pages.md` §3, §9, Online touchpoints; `14-online-sweep.md` N01–N40; `20-online-sweep-tail.md` (summary only, the file ends in §9.1); `20-theme-profile-engine.md` §9, §10.2. Ground truth: `work/app/out/renderer/**` (byte-identical to the asar) and the prettified copy `work/app-pretty/renderer/**`.

No new dependencies (`@electron/asar` and, in the tests, `esbuild` are already dev dependencies). No additions to `src/backend/types.ts`.

---

## 1. What it does

`npm run import-ui` (= `node scripts/import-vendor-ui.mjs`) builds the renderer from the user's own Windows installation. No vendor code is committed.

```
node scripts/import-vendor-ui.mjs [--asar <app.asar>] [--resources <dir>] [--out <dir>] [--quiet]
  --asar       default: $EVNIA_VENDOR_ASAR (an empty value counts as unset), else
               ../Evnia Precision Center/resources/app.asar relative to port/
  --resources  the install's resources/ dir holding bin/res/data (default: the asar's directory)
  --out        parent of vendor-ui/, vendor-data/, vendor-assets/ (default: port/build)
  --quiet      only print errors and warnings
Relative --asar/--resources/--out values and a relative EVNIA_VENDOR_ASAR resolve against the current directory.
exit 0 = ok (warnings on stderr, "warning: …", do not change it)
     1 = any failure: one line "import-vendor-ui: <CODE>: <message>" on stderr (§1.1); an unexpected
         internal error prints "import-vendor-ui: INTERNAL:" with the stack
     2 = usage error
```

Pipeline (`scripts/lib/import-pipeline.ts` `runImport()`), in this order:

1. **Validate the table** (`validatePatchTable`): every list present, unique ids, every patch targets a pinned file, positive `expectCount`, rationale and spec present, copies pinned, reviewed sites and scheme literals with a file glob, context, reason and count ≥ 1, touchpoints reference existing patch ids.
2. **Extract** every file under `out/renderer/` of the asar into memory (`AsarSource`). When the archive is opened, every entry name of the whole header must be a single safe path segment (non-empty, not `.`/`..`, no `/`, `\` or NUL), else `ASAR_UNSAFE_PATH`. `@electron/asar` 4.3 already rejects `.`, `..` and separators while reading the header; that error is mapped to the same code, so the result does not depend on the installed minor version (`package.json` allows `^4.0.0`). Symlinks in the renderer abort (`ASAR_LINK`). An entry that cannot be read is `ASAR_READ` (with a hint to copy `app.asar.unpacked/` when the entry is stored there). Nothing from the archive is executed.
3. **Verify pins** (`verifyPinnedFiles`): each patched file must exist under its exact 1.13.0 name and have the pinned SHA-256. Otherwise `PIN_MISSING` names the file that was found instead (`expected assets/styles-DAnQi2A8.js (Evnia Precision Center 1.13.0) but found assets/styles-Zz9….js`), or `PIN_HASH` gives both hashes.
4. **Patch** (`applyPatchTable`): literal (or, for the two secret blanks, RegExp) replacements. Each must match exactly `expectCount` (default 1) times or the import aborts with `PATCH_COUNT`. Replacements are always literal (no `$&` expansion). Text is decoded with a lossless UTF-8 round-trip check (`NOT_UTF8`).
5. **Remove** the dropped sub-apps (`removeFiles`, `removals.ts`). Vite loads a lazy chunk by name (`import("./X.js")`, `new URL(…)`, CSS `url()`, HTML `src`) or by index through the per-chunk preload table `__vite__mapDeps` (`m.f=["./A.js",…]`, used as `__vite__mapDeps([30,31])`). After patching, for every removed file:
   - its basename may not occur in any kept JS/HTML/CSS outside a `__vite__mapDeps` table literal (`REMOVAL_REFERENCED`);
   - no remaining `__vite__mapDeps([…])` call may use the index of a table entry naming it (`REMOVAL_REFERENCED`, "still preloaded");
   - the number of table entries still naming it must equal the table's `mapDepsEntries` exactly (`REMOVAL_MAPDEPS`). Such an entry is inert: the patches removed the routes that used its index.
   A table or call in a shape the parser does not recognize (an aliased helper, a computed index list, an entry that is not a vendor file) aborts with `REMOVAL_UNVERIFIABLE`, because the index check could not be done.
6. **CSP**: every HTML file gets exactly one `<meta http-equiv="Content-Security-Policy">` with the local-only policy (replaced in `index.html`, inserted after `<meta charset>` in `notice/notice.html`, which had none). The set of HTML files must equal the reviewed set (`CSP_FILESET`).
7. **Static audit** (`auditFiles`, §5). Any failure aborts with `AUDIT_FAILED` and prints the table.
8. **Copy vendor data and icons**, each data file pinned by SHA-256 (`COPY_MISSING`, `COPY_IO` for a path that is not a regular file or cannot be read, `COPY_HASH`).
9. **Write** `vendor-ui/PATCHES.json` and install the outputs (`output-swap.ts`):
   - take the lock `<out>/.vendor-import.lock` (exclusive create; records host name, pid, start time and a random token). While another import holds it, the run fails with `OUTPUT_LOCKED` and touches nothing;
   - remove every `.vendor-import-*` directory (they can only be leftovers of interrupted runs, because staging directories are created only by the lock holder), then create this run's staging directory with `mkdtemp` (`<out>/.vendor-import-XXXXXX`);
   - write the new trees to `<staging>/new/`, re-check that the lock is still ours, and swap the three directories in by renames with rollback (`OUTPUT_SWAP`; `OUTPUT_ROLLBACK` if the rollback fails too, in which case `<staging>/previous` is kept);
   - release: remove the staging directory and the lock. A clean-up failure is printed as a warning; it does not turn a completed import into a failure, and it never hides the original error of a failed one.
   File-system errors while preparing, writing or swapping are `OUTPUT_IO`, with a hint for `EACCES`/`EPERM` (root-owned files left by an import run as root in the Docker dev image: `sudo chown -R "$USER" <out>`). If any step fails, the previous outputs stay untouched (tested).

The CLI prints the audit table and the IPC channels the patched UI references.

### 1.1 Error codes

| Code | Meaning |
|---|---|
| `TABLE_INVALID` | `ui-patches.mjs` is structurally wrong |
| `ASAR_MISSING`, `ASAR_INVALID`, `ASAR_READ`, `ASAR_LAYOUT`, `ASAR_UNSAFE_PATH`, `ASAR_LINK`, `ASAR_FILE_MISSING` | The archive is absent, not an asar, unreadable (or an unpacked entry is missing), has no `out/renderer`, has an unsafe entry name, a symlink in the renderer, or lacks a requested file |
| `PIN_MISSING`, `PIN_HASH` | Different vendor build (§9) |
| `PATCH_COUNT`, `PATCH_UNPINNED`, `PATCH_EMPTY_FIND`, `PATCH_EMPTY_MATCH`, `NOT_UTF8` | Patch engine guards |
| `REMOVAL_MISSING`, `REMOVAL_REFERENCED`, `REMOVAL_MAPDEPS`, `REMOVAL_UNVERIFIABLE` | Removal guards (step 5) |
| `CSP_FILESET`, `CSP_AMBIGUOUS`, `CSP_NO_HEAD`, `CSP_INVALID` | CSP guards |
| `AUDIT_FAILED` | Static audit found something (the table is printed) |
| `COPY_MISSING`, `COPY_IO`, `COPY_HASH` | Vendor data files |
| `OUTPUT_LOCKED`, `OUTPUT_IO`, `OUTPUT_SWAP`, `OUTPUT_ROLLBACK` | Installing the outputs |

## 2. Outputs

| Path | Content |
|---|---|
| `build/vendor-ui/` | Patched `out/renderer/**`: `index.html`, `notice/notice.html`, `assets/*`, `monitor/ keyboard/ mouse/ mouse_pad/ headset/` product images, `PATCHES.json`. 308 files. |
| `build/vendor-ui/PATCHES.json` | Manifest: vendor version, asar SHA-256, CSP, pinned files (hash before/after), every applied patch with its match count, CSP actions, removed files (with `mapDepsEntries`), copied files with hashes, the N01–N40 decision record, audit summary (remaining URLs and scheme-only literals with reasons, reviewed API-site count, IPC channel tally). No absolute paths and no timestamps, so it is reproducible. |
| `build/vendor-data/MonitorInfo.json` | asar root copy, `Version` 34, 143 models (identical to main's embedded `Qf`, 14 §7.1). For `getMonitorJsonConfig` (main) and `DictMgr` (backend). |
| `build/vendor-data/PCenter_DeviceInfo.json` | `resources/bin/res/data/PCenter_DeviceInfo.json` (04 §2.2). |
| `build/vendor-data/ENE/PCenter_AmbiglowInfo.json` | `resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json` (09). |
| `build/vendor-assets/*.png` | asar `resources/*.png`: `favicon.png`, `favicon_16x16.png`, `favicon_24x24.png`, `tray_{close,feedback,refresh,rescan,setting,user}.png` (01 §5). |

`build/` is git-ignored (`port/.gitignore`).

## 3. Patch table (`scripts/ui-patches.mjs`)

Pinned files (1.13.0): `assets/styles-DAnQi2A8.js` (glob `assets/styles-*.js`), `assets/main-CDosWiM3.js` (`assets/main-*.js`), `index.html`, `notice/notice.html`, `assets/Ambiglow-Dvqon39u.js` (`assets/Ambiglow-*.js`, the monitor's Ambiglow page; the glob also matches the three peripheral Ambiglow chunks, which only a `PIN_MISSING` message would list). The globs identify a chunk across vendor builds; the exact name and hash pin this build.

32 patches, all with `expectCount` 1:

| Id | File | Effect | Spec |
|---|---|---|---|
| `HUB-URL` | styles | `http://localhost:${e}/EvniaHub` → `http://127.0.0.1:${e}/EvniaHub?k=${encodeURIComponent(window.__EVNIA__?.hubToken??"")}` | 02 §4.1, §L.4; 14 N33/N34 |
| `P1` | styles | `Sv()` (cloud request core) throws `Error("offline")` on entry | 02 §L.3 P1 |
| `P2` | styles | `vv.get` rejects before building the request | P2 |
| `P3` | styles | `Mv()` component-update check returns `[]` (and skips the MAC lookup) | P3 |
| `P4a`, `P4b` | styles | `getDeviceImage` / `getDeviceResource` resolve `[]` (no `/pcenter/device/files` on every scan; start-up no longer waits for it) | P4; 03 §9 B10 |
| `CLOUD-HOSTS` | styles | saas/deviceportal/pcenter base URLs become `offline:` (valid for `new URL`, never fetchable) | 14 §2 |
| `UNDICI-IMPORT` | styles | the proxy branch's `import("./index-BYSWl2m0.js")` becomes a rejection, so the undici chunk can go | 14 N11 |
| `NO-MAC` | styles | `Cv()` returns `""`; the renderer never invokes `getMac` | 14 N14 |
| `SECRET-SAAS`, `SECRET-ZAUTH` | styles | blank the hard-coded HMAC credentials (matched by RegExp so the secrets are not in this repo) | 14 §2.3 |
| `IMGCOMP-NO-WORKER`, `IMGCOMP-NO-CDN` | styles | browser-image-compression never creates its blob Worker (no `importScripts` from jsDelivr); URL removed | 14 N24 |
| `P5` | main | toolbar Account item `hidden:!0` | P5 |
| `P6` | main | never auto-show the login overlay | P6 |
| `LOGIN-EVENTS` | main | no listener for `openLogin` / `openEmailAssociated`, so the login overlay cannot open from anywhere (Profile "Log in to cloud", cloud error 650401) | 02 §7 |
| `P7` | main | brand-logo click does nothing | P7 |
| `NO-EXTERNAL-BROWSER` | styles | `ipcOpenDefaultBrowser` is a no-op (licence links, OAuth) | 14 N09/N27 |
| `PROFILE-NO-CLOUD-EXPORT` | styles | Profile export dialog: "Export to cloud / Log in to cloud" row removed | 14 N29; 20-theme §9 |
| `PROFILE-NO-CLOUD-IMPORT` | styles | Profile import dialog: "From local / From cloud" selector removed (source stays local) | 14 N29 |
| `P8` | styles | Settings > General "Feedback" button removed | P8 |
| `P9` | styles | Settings menu = General, AboutPCenter, AboutDevice (FwUpdate, AmbiScape and PairingTool removed) | P9 |
| `P10` | styles | About page: AutoUpdate switch, auto-download/install checkboxes and "Check for updates" removed | P10 |
| `OTA-OFF` | styles | monitor-store getter `OTASupport()` → `false` (monitor Setup "FwUpdate" tab and FirmwareManager auto-check hidden regardless of `OTAEnable`) | 03 §4.9; 14 N17 |
| `IPC-ONLINE-EVENTS` | styles | `ipcEventListen` keeps only `toPageView`, `rescan`, `mainWindowShow` (drops `newVersionPrompt`, `versionCheckResult`, `checkSoftwareUpgrade`, `thirdPartySuccess`, `loginShow`, `matterNotification`) | 02 §3.2 |
| `P11` | main | SmartDesktop sidebar item `hidden:!0` | P11 |
| `ROUTE-SMARTDESKTOP` | styles | `/monitor/smartDesktop` route removed | 03 §4.10 |
| `BULB-OFF` | main | `setBulbEnabled(false)` at start-up, no `checkNodeAvailable` call | 03 §4.11 |
| `ROUTE-BULB` | styles | `/bulb`, `/bulb/ambiScape` routes removed | 03 §4.11 |
| `IMG-PATH`, `IMG-PATH-OVERVIEW` | styles | bundled product images resolve as `../<dir>/<model>.png` relative to `assets/`, not `../../../[out/renderer/]…` relative to the asar root | 02 §11.3 |
| `FAST-LED-UPLOAD` | Ambiglow | **Port feature**, not a removal: the "Fast LED upload (experimental)" checkbox (below). Inserted between the Speed slider block (`onChange:ia`) and the StarCount block of the page's render | impl-usb-ene §2.2 deviation 20; impl-electron-shell "IPC" |

**`FAST-LED-UPLOAD`** (user request 2026-09-27) is the only patch that adds UI. It inserts one v-if block, in the vendor's own render style, into the setting column of the monitor Ambiglow page (Ambiglow-Dvqon39u.js:1435-1454 prettified):

```js
c(Z)&&1===Ae.value&&window.__EVNIA__?.experimental ? (t=>(n(),u("div",{key:4,class:"slider-item evnia-fast-led-upload",title:HINT},[
  r(s("Checkbox"),{modelValue:t.eneFrameBurst||t.forcedByEnv,label:"Fast LED upload (experimental)",i18n:!1,
    disabled:!Ce.value||t.forcedByEnv,onChange:e=>{window.__EVNIA__.experimental.setEneFrameBurst(e).catch(x=>{
      const msg=REFUSED+(x&&x.message||x);console.warn(msg);window.__electronLog?.warn(msg)})}},null,8,["modelValue","disabled"]),
  S("div",{class:"evnia-fast-led-upload-hint",style:{…}},t.forcedByEnv?"On because EVNIA_ENE_FRAME_BURST=1 is set; …":HINT,1)
])))(window.__EVNIA__.experimental.get()) : m("",!0)
```

- **When:** only with the ENE (`Z` = the store's `ENEEffectEnable` ref) and the Follow Video effect (`Ae` = the current `EffectType`, 1), and only when the preload offers `window.__EVNIA__.experimental` (another preload shows nothing). Disabled while the effect is off (`Ce`), like the page's sliders; ticked and disabled when `EVNIA_ENE_FRAME_BURST=1` forces the burst on.
- **What:** the vendor's own global `Checkbox` component (`main-CDosWiM3.js:4052`), resolved with the page's `resolveComponent` (`s`), in a row with the page's scoped `slider-item` class (the new vnodes get the page's scope id), `i18n:false` for the English label, and a second line of hint text (`Sends each frame in one USB transfer. Turn off if the lights flicker or freeze.`, also the row's tooltip). `key:4` is free among the column's v-if blocks (0 position/direction, 1 brightness, 2 speed, 3 star count). The checkbox keeps its toggled state itself: `useModel` without an `onUpdate:modelValue` listener updates its local value (`styles-DAnQi2A8.js:2503-2540`), and the next render passes the stored value, which the preload has updated by then.
- **A refused call** (`setEneFrameBurst` rejects: main refuses the sender or the type, or the IPC call itself fails; not expected from the main window with the checkbox's boolean, since main accepts it and neither a failed config write nor a failing backend throws there) is logged, not dropped: one `console.warn` and one `window.__electronLog.warn` line (the preload's electron-log bridge, so it lands in the main log under `renderer`, src/main/renderer-log.ts; a plain `console.warn` does not reach any log file), `REFUSED` = `Fast LED upload not changed; the checkbox shows the wrong state until the row is shown again (another effect and back, or the page reopened): ` followed by the reason. **Known limitation:** the box keeps showing the value that was refused until the row is created again (another effect and back to Follow Video, leaving and reopening the Ambiglow page, or the ENE going away and back), which reads `get()` afresh. The page cannot put it right sooner: the vendor `Checkbox` has already toggled its local `useModel` value and emits only `change(value)` (no handle to reset it), `get()` is not reactive, and nothing in the page re-renders on a refusal. A vnode key built from the stored value would not help either: a refusal leaves the stored value, and so the key, unchanged, so a re-render would reuse the same Checkbox. Binding `onUpdate:modelValue` would need reactive page state that the patch does not have (and the Checkbox would then emit the old value in `change`).
- **How it reaches the backend:** `window.__EVNIA__.experimental` is a narrow preload API (`get()` synchronous, from the store snapshot of the bootstrap; `setEneFrameBurst(boolean)`), over the internal invoke channel `evnia:experimental-set`, which main accepts from the main window's top frame only and for a boolean only, stores in `config.json linuxExperimental.eneFrameBurst` and forwards to the ambiglow service (impl-electron-shell "IPC", "Persisted settings"). No `window.ipc` channel, no URL: the audit's IPC tally and URL findings are unchanged.
- **Tests:** `fast-led-upload.test.ts` evaluates the inserted expression with stand-ins for the page's helpers and state (visibility, bindings, the click, a refused call logged to the console and `window.__electronLog` without an unhandled rejection, no URL or `window.ipc`); the real-archive suite checks the patched chunk (once, after the Speed and before the StarCount block, key 4 free, the peripheral Ambiglow chunks untouched, the module still parses); the e2e walkthrough ticks it on the real page (impl-walkthrough §4).

Removed files (11): `feedback/feedback.html`, `assets/feedback-NPrjkfNw.js`, `assets/feedback-DH816rEa.css`, `assets/index-BYSWl2m0.js` (undici), `assets/SmartDesktop-By8ZEPkl.js`, `assets/SmartDesktop-DDdFid7d.css`, `assets/Bulb-vdvqR6Jj.js`, `assets/AmbiScape-B35D_GM2.js` (zxing-wasm from fastly.jsdelivr.net, camera QR reader, `GetWifiList`), `assets/AmbiScape-CSqmg1LO.css`, `assets/matter_scan_tip-DSFC2GUj.png`, `smart_bulb.png` (unreferenced). `mapDepsEntries` is 1 for the two SmartDesktop files (styles table indices 30/31) and for `Bulb`/`AmbiScape` JS and CSS (indices 88–90), 0 for the rest; the preload calls that used those indices were the routes removed by `ROUTE-SMARTDESKTOP` / `ROUTE-BULB`.

CSP for every page:

```
default-src 'self'; connect-src ws://127.0.0.1:*; img-src 'self' data: blob: local:; script-src 'self';
style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none';
frame-src 'none'; worker-src 'none'; media-src 'none'; form-action 'none'; manifest-src 'none'
```

Security review: for a `file:` page, `'self'` matches every `file:` URL. With Electron's `GrantFileProtocolExtraPrivileges` fuse on, which the `<script type=module crossorigin>` entry needs, the renderer could otherwise `fetch`/XHR any file the user can read. So `connect-src` names only the loopback hub; the bundle never fetches its own files, and its cloud requests are disabled by P1-P4. `frame-src`, `worker-src` (the one Worker is disabled by IMGCOMP-NO-WORKER), `media-src`, `form-action` and `manifest-src` are `'none'`: the bundle has no frames, media, forms or manifest. Images and fonts still load from `'self'`; the main-process kill-switch confines `file:` requests to the app tree (impl-electron-shell "Network kill-switch"). Both e2e walkthroughs pass with this policy and without a CSP violation.

## 4. Decision record (renderer side of 14 N01–N40)

The full record, one entry per touchpoint with the patch ids, is `touchpoints` in `ui-patches.mjs` and is copied into `PATCHES.json`. A test asserts that N01..N40 are all present. In short:

| Decision | Touchpoints |
|---|---|
| **Patched** in the bundle | N02, N03 (update UI and events), N06 (download manager: every caller follows an empty `Mv`), N07, N08, N09, N10, N14, N15, N16, N17, N18, N23, N24, N26 (CSP + no avatar UI), N27, N29, N31 (CSP), N34 |
| **Removed** from the bundle | N11 (undici), N20 (SmartDesktop), N21, N25, N32, N39 (AmbiScape/Matter), N22 (feedback sub-app) |
| **Main process** | N01 (never download MonitorInfo; use `vendor-data/`), N04, N05 (patch pack; the renderer only *reads* `<patchPath>/translation.json`), N12 (`local:` handler), N13 (spellcheck off) |
| **Backend** | N19 (DTS installer: headset page reachable only with a Philips headset, which the backend never lists; `Mv` is empty anyway), N33 (loopback + token), N37 (peripheral "Launch website" not implemented) |
| **Harmless** | N28 (`/pcenter/config`, no caller), N30 (`navigator.onLine`) |
| **n/a** | N35, N36, N38, N40 |

Other items the task named:

| Item | Decision |
|---|---|
| Account / login overlay | Patched: `P5`, `P6`, `LOGIN-EVENTS`, `IPC-ONLINE-EVENTS` (`loginShow`). The `/account` route and its components stay in `styles` but have no entry point. |
| Feedback | Patched (`P8`) and sub-app removed. |
| Check for updates / AutoUpdate / `newVersionPrompt` | Patched (`P10`, `IPC-ONLINE-EVENTS`). The Home "what's new" dialog needs `newVersion.versionNum`, which only the removed `newVersionPrompt` listener sets. |
| Firmware update | Patched (`P3`, `P9`, `OTA-OFF`). Main should still return `OTAEnable:false`; `DisplayFW_GetDeviceList` is still called by `saveDeviceList` (local, feeds only `localStorage.monitorFw`). |
| SmartDesktop | Patched and removed (`P11`, `ROUTE-SMARTDESKTOP`). The renderer no longer calls `FancyZones_*`. |
| AmbiScape / Bulb | Patched and removed (`P9`, `BULB-OFF`, `ROUTE-BULB`). The bulb manager never starts, so no bulb IPC is sent. |
| DTS installer (headset Setup `Setup-daShw_PC.js`) | Kept, unreachable (see N19). |
| Peripheral pages (keyboard, mouse, pad, headset chunks) | Kept. Reachable only from Overview cards of connected Philips peripherals (04 §1 summary, §9), which the monitor-only backend never reports. Their online paths (cloud macros in `KeyBind`, peripheral OTA, DTS) all go through the patched `Sv`/`vv`/`Mv`. The audit found no remote URL or network call in them. Removing them would need a larger router/sidebar patch set for no user-visible gain. |
| Pairing tool | Patched out of the Settings menu (`P9`). `GetPairDevices` is still called on the Settings page and on `USBChange`; the backend answers `[]`. |
| Device image downloads | Patched (`P4a`, `P4b`). The 34M2C8600 images are bundled. Unknown models fall back to `local:///<userData>/ImageCache/…`, which will not exist, then to the generic 27M2N8800 image. |
| Cloud theme/profile/macro sharing | Patched (`P1`, `P2`, `CLOUD-HOSTS`, `PROFILE-NO-CLOUD-*`). Local import/export unchanged. |
| External links | Patched (`P7`, `NO-EXTERNAL-BROWSER`). Licence URLs remain as display text. |
| Remote script/WASM loaders | jsDelivr browser-image-compression patched (`IMGCOMP-*`); zxing-wasm removed with the AmbiScape chunk. |
| App-binding file picker (`.exe` filter) | **No bundle patch** (20-theme §10.2 recommends a main-side dialog swap). |

## 5. Static audit (`scripts/lib/audit.ts`)

Scans every `.js/.html/.css` of the output:

- **URLs** matching `(https?|wss?)://…` (any letter case) with a non-empty host. Allowed: the loopback hub in scripts (scheme `http`/`ws`, host literally `127.0.0.1`, path exactly `/EvniaHub`, no userinfo; never `localhost`), the CSP source `ws://127.0.0.1:*` in HTML, and the exact strings in `urlAllowlist`: Vue's error-reference link, the three W3C XML namespaces, two SignalR error/warning texts, and four OSS licence URLs shown in the Terms dialog (their click handler is the no-op `ipcOpenDefaultBrowser`). Anything else fails.
- **Scheme-only literals** (`"https://"`, `"http://"`, `` `wss://` ``, …): the building block of a URL assembled by concatenation (`"https://"+host+"/api"`), which the URL rule cannot see. Each must be covered by a `reviewedSchemes` entry (file glob + literal context within 160 characters before / 80 after + exact count + reason). There are 2 entries covering the 3 literals left in 1.13.0: SignalR `HttpConnection._resolveUrl`'s `lastIndexOf("https://",0)` / `lastIndexOf("http://",0)` prefix test (count 2; compares, never concatenates), and the `placeholder:"http://"` input of the peripheral "Launch website" key action in `ButtonFunc-*.js` (14 N37; display text). Undici's `startsWith("http://")`/`startsWith("https://")` checks left with the removed `index-BYSWl2m0.js`.
- **Network API call sites**: `fetch(` / `fetch.bind|call|apply(`, `new XMLHttpRequest`, `new …WebSocket…(`, `new EventSource(` (also aliased, e.g. `new this._options.EventSource(`), `importScripts(`, `new Worker(`/`SharedWorker(`, `sendBeacon(`, `window.open(`, `new RTCPeerConnection`, `serviceWorker.register(`. Each must be covered by a `reviewedSites` entry (API + file glob + a literal context string within 160 characters before / 80 after + exact count + reason). There are 13 entries: SignalR's fetch/XHR/WebSocket/EventSource transports (the only live one is the browser WebSocket branch to `HUB-URL`; the two SSE branches are never constructed with `skipNegotiation`+WebSockets), the four cloud `fetch` sites made unreachable by `P1`/`P2`, and the image-compression Worker/importScripts made unreachable by `IMGCOMP-NO-WORKER`.
- The tables are exact: an allowlist entry, reviewed site or reviewed scheme literal that no longer matches (or matches a different number of times, or whose file glob matches no file) also fails, so they cannot rot, and a new site next to a reviewed one is caught by the count.
- IPC channels (`window.ipc.send|invoke|on|once("…")`) are tallied for the preload review, not judged.

Result on 1.13.0 (unchanged by FAST-LED-UPLOAD, which adds no URL, network API or IPC channel): 97 files scanned, 29 findings (13 reviewed API sites, 3 reviewed scheme literals, 10 allowlisted URLs, 3 loopback: the hub template and the CSP source in both pages), 0 failures. `PATCHES.json` `audit.remoteUrls` lists every remaining URL and scheme literal with its reason; `audit.reviewedSites` counts API sites only.

## 6. Verification done

- `node --test "test/unit/vendor-ui/*.test.ts"` in the Docker image: 73/73 pass, none skipped. The real-asar suite checks every patch count, the pins (re-hashed from the asar), the CSP of every page, an independent re-scan of the output (also: no `zeasn`, `jsdelivr`, `amazonaws`, `evnia.philips` or `localhost` anywhere; HMAC keys blank), that every output `.js` still parses as an ES module (esbuild), the removed and kept files, the data/icon hashes, the audit rows for the reviewed scheme literals, that no lock, staging directory or warning is left, and that a duplicated anchor in the real `main` chunk fails with `PATCH_COUNT`. The guard suite triggers `REMOVAL_REFERENCED`, `REMOVAL_MAPDEPS`, `CSP_FILESET`, `AUDIT_FAILED`, `COPY_HASH`, `COPY_MISSING`, `COPY_IO` (a directory in place of a data file), `OUTPUT_LOCKED` (a foreign lock; nothing touched) and `OUTPUT_IO` (CLI, coded line, no stack trace) on the real archive, and runs the CLI with `--resources` (a copied `bin/res/data` tree is used; an empty one fails). Synthetic archives check `ASAR_UNSAFE_PATH` for `..`, `.` (rejected by the library), an empty name and NUL names inside and outside the renderer (accepted by the library, refused by our check), `ASAR_LINK`, `ASAR_READ` for an unpacked entry without `app.asar.unpacked/`, `PIN_MISSING` / `PIN_HASH`, `ASAR_MISSING`, `defaultPaths()` with and without `EVNIA_VENDOR_ASAR` (relative values resolve against the cwd), and that the CLI reads the variable and `--asar` overrides it. `output-swap.test.ts` covers the swap/rollback and the lock: two concurrent runs that are both pid 1 in different containers (the second is refused and touches nothing), leftovers from any pid namespace, same-host dead/alive owners, foreign locks before and after `STALE_LOCK_MS`, unreadable locks, a taken-over run that must not install or remove its successor's lock, and clean-up failures returned as warnings.
- Typecheck: `scripts/lib/*.ts` and the tests are clean under the project options (`tsc --strict … --erasableSyntaxOnly --verbatimModuleSyntax`, also with `--noUnusedLocals`). The two `.mjs` files are clean under `tsc --allowJs --checkJs` (the table is typed with `@type {UiPatchTable}`). Note: at the time of writing the global `npm run typecheck` stops at a syntax error in another module (`src/backend/theme/formats.ts`), which hides semantic errors everywhere; the owned files were checked in isolation.
- Manual Electron 44 smoke run (Xvfb, `contextIsolation`+`sandbox`, a throwaway preload and a minimal SignalR-JSON stub; not committed): the patched UI boots to Home with no login overlay, shows the monitor card with `monitor/34M2C8600.png` loaded, the toolbar has Home/Dashboard/Settings only, Settings shows General/About/About Device without Feedback, About has no update controls. The **only** non-`file:` request was `ws://127.0.0.1:<port>/EvniaHub?k=<token>` (WebSocket `Origin: file://`). No console errors or CSP violations. `notice/notice.html` also renders under its inserted CSP.

## 7. Deviations from the specs

- **P8** is done in the bundle (button removed) and the feedback sub-app is deleted, instead of only relying on main ignoring `openFeedbackWindow`.
- **P9** also removes `PairingTool` (peripherals are out of scope).
- **P10** removes the update controls instead of having main answer `versionCheckResult {state:0}`. The tray "Check for Updates" event is also dropped in the renderer (`IPC-ONLINE-EVENTS`).
- **02 §L.3 "tighten the CSP"** proposed `ws://localhost:*`; the port uses only `ws://127.0.0.1:*`, adds `connect-src` (the loopback hub only, no `'self'`), `font-src`, `object-src 'none'`, `base-uri 'none'` and `'none'` for frames, workers, media, forms and the manifest, and inserts a policy into `notice.html` (which had none).
- **Hub URL** host is `127.0.0.1` (not `localhost`, which may resolve to `::1`) and carries the token as `?k=`.
- **Image paths** are made layout-independent (`IMG-PATH*`), which the specs did not ask for. Otherwise `runConfig.isPackaged:true` would require the UI to live at `<X>/out/renderer/`.
- Beyond P1–P11 the table adds `CLOUD-HOSTS`, `UNDICI-IMPORT`, `NO-MAC`, `SECRET-*`, `IMGCOMP-*`, `LOGIN-EVENTS`, `NO-EXTERNAL-BROWSER`, `PROFILE-NO-CLOUD-*`, `OTA-OFF`, `IPC-ONLINE-EVENTS`, `ROUTE-*`, `BULB-OFF` (all described above). `20-online-sweep-tail.md` mentions patches P12–P16 (P12 = remove the embedded cloud credentials), but its §10–§11 are not in the file; `SECRET-SAAS`/`SECRET-ZAUTH` cover P12, the others could not be compared.

## 8. What the next wave must know

**Main process (`src/main`)**
- Load `build/vendor-ui/index.html` with `loadFile` (file://) and the notice window from `build/vendor-ui/notice/notice.html`. Ship `vendor-ui/` as one directory with its internal layout (`assets/`, `monitor/`, `notice/`, …); its location no longer matters, and neither does `runConfig.isPackaged` for images.
- The hub must listen on **127.0.0.1** (CSP `connect-src` allows only `ws://127.0.0.1:*`). The renderer connects to `ws://127.0.0.1:<port>/EvniaHub?k=<encodeURIComponent(token)>`, where `<port>` is the value of `startupBackendService`. The WebSocket `Origin` header seen in Electron 44 from a file:// page is `file://`.
- Tray icons: `build/vendor-assets/favicon.png`, `favicon_16x16.png`, `tray_rescan.png`, `tray_setting.png`, `tray_close.png`. Per 01 "Linux port plan" item 5 the Check-for-updates and Feedback tray items go, so `tray_refresh.png`/`tray_feedback.png` are unused; the renderer no longer reacts to `checkSoftwareUpgrade` anyway.
- `getMonitorJsonConfig`: read `build/vendor-data/MonitorInfo.json` (v34), keep the vendor key normalization, return `OTAEnable:false` (the renderer ignores it for OTA now, but it is the documented contract).
- `getRunConfig.patchPath`: point it at a directory without `translation.json` (or a real local override); the renderer only reads it.
- The renderer no longer sends `openDefaultBrowser`, `getMac`, `checkNodeAvailable`, `openFeedbackWindow`, `checkSoftwareVersion` from any reachable UI, and no longer listens for `newVersionPrompt`, `versionCheckResult`, `checkSoftwareUpgrade`, `thirdPartySuccess`, `loginShow`, `matterNotification`.

**Preload (`src/preload`)**
- Expose `window.__EVNIA__ = { hubToken }` with `contextBridge.exposeInMainWorld` before the page scripts run. A missing token yields `?k=` and the hub refuses the connection (fail closed).
- IPC channels observed at start-up (smoke run): invoke `getRunConfig`, `startupBackendService`, `getMonitorJsonConfig`, `maximizedValue`; send `resetToStartSize`, `interfaceInitializeCompleted`; on `toPageView`, `rescan`, `mainWindowShow`, `displayChange`, `USBChange`, `otherDeviceChange`. User actions add (02 §3.1 "keep" rows): `minimize`, `maximizeToggler`, `close`, `fileSelect`, `exportFile`, `getFileSize`, `setLanguage`, `setAutoStartUp`, `notice`, `shieldDisplayChange`, `shieldPeripheralChange`, `disableTrayExit`, `disableTrayFunction`; the notice window listens for `setNotice`/`setLanguage`. The full tally of referenced channels is `audit.ipcChannels` in `PATCHES.json`; it also lists channels referenced only from unreachable code (downloads, bulbs, `runCommand`, …), which the preload should keep answering with inert defaults (02 §L.2).

**Backend**
- Startup call order seen against the patched UI: `Start`, `Device_GetConnectList`, `DisplayFW_GetDeviceList`, `Theme_GetThemeInfos`, `SyncEffect_GetData`, `Effect_GetColorData`, `Theme_GetCurTheme`, `Macro_GetFuncMenu`, `Macro_GetList`; the Settings page adds `Setting_GlobalData`, `GetPairDevices`. `FancyZones_*` and `GetWifiList` are no longer called.
- Report the monitor with `MonitorName` `"PHL 34M2C8600"` as before; the device-image lookup no longer depends on it.

**e2e**
- Visit `/`, `/dashboard`, `/message`, `/setting` (3 tabs), `/profile` and the monitor children `smartImage|smartImageHDR`, `gameMode`, `ambiglow`, `input`, `audio`, `system`, `setup`. `/monitor/smartDesktop` and `/bulb*` no longer exist. Expect exactly one non-file request: the hub WebSocket.
- Done by `test/e2e/walkthrough.test.ts` (impl-walkthrough.md), except `/message`: no port source sends its only entry, the `toPageView` IPC "message". The walkthrough also confirms the patches from the user's side: no login overlay, no FwUpdate tab, the Settings menu has exactly General/AboutPCenter/AboutDevice, About has no update controls, and nothing leaves the machine. The renderer's electron-log needed a preload bridge (`window.__electronLog`, impl-electron-shell "IPC"); no bundle patch was needed.

**Packaging / build scripts**
- Run `npm run import-ui` before `npm run build`/`dist:deb`; package `build/vendor-ui`, `build/vendor-data`, `build/vendor-assets`. Do not package anything else from the asar (it also contains the vendor's AI-agent instruction files `AGENTS.md`/`CLAUDE.md`, which are never extracted). Never package `build/.vendor-import.lock` or `build/.vendor-import-*` (they exist only while an import runs, or after an interrupted one).
- A script that drives the import programmatically calls `runImport({ asarPath, resourcesDir?, outDir, table: await loadPatchTable(), log?, warn? })` and gets `ImportError` (stable `code`, §1.1) for every anticipated failure. `defaultPaths(portDir, env)` gives the CLI defaults.
- Do not run two imports into the same `build/` at once: the second fails with `OUTPUT_LOCKED`. If an import in the Docker image is killed, its lock cannot be checked from another container or the host (different host name, separate pid namespace); the next run refuses for 10 minutes (`STALE_LOCK_MS`) and says which file to delete to go on at once.
- Test fixtures copied from an older import (e.g. `test/e2e/artifacts/vendor/app/vendor-ui/PATCHES.json`, owned by e2e) still show the former `danglingRefs` field; a fresh import writes `mapDepsEntries` and the scheme-literal rows.

## 9. Known limitations

- Only vendor **1.13.0** is supported. Another build fails at the pin check. Updating: point the importer at the new asar, fix the pins and anchors in `ui-patches.mjs` (the error messages name the new chunk files), then re-derive from the import's failures: `mapDepsEntries` for each removal (`REMOVAL_MAPDEPS` reports the number of inert `__vite__mapDeps` entries found; first check with the route patches that no preload call still uses those indices, which `REMOVAL_REFERENCED` enforces), the URL allowlist, the reviewed network-API sites and the reviewed scheme literals (the audit table lists every unreviewed one with an excerpt, and every stale or miscounted entry). Then run the tests.
- The audit is lexical. It sees absolute URLs, scheme-only literals and the listed network APIs; a URL split differently (`"https:"+"//"+host`), a network API reached through an unlisted alias, or code evaluated from a string would not be recognized. The CSP (`connect-src ws://127.0.0.1:*`, `script-src 'self'`) and the main-process network kill-switch are the enforcement layers behind it.
- The output lock is advisory and file-based (no kernel lock is portable across the Docker bind mount). A run suspended for longer than `STALE_LOCK_MS` loses its lock to the next run; it notices before its swap (`OUTPUT_LOCKED`, nothing installed) but not during the few renames of the swap itself.
- Unreachable vendor code stays in `styles-*.js` (Account pages, cloud clients, OTA manager, AmbiScape settings, IPC wrappers for removed channels). It is inert: every cloud request path is neutralized at `Sv`/`vv.get`/`Mv`, and base URLs are `offline:`. The preload allowlist and the main-process kill-switch remain the enforcement layers.
- Peripheral chunks stay (see §4). `KeyBind` still shows cloud-macro buttons if a Philips keyboard or mouse were ever listed; they require a login that can no longer happen.
- The licence URLs remain visible in the Terms dialog but do nothing when clicked.
- The PNG icons and product images are copied without pinning (they are not patched).
