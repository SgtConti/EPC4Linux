// Patch table for the vendor renderer of Evnia Precision Center 1.13.0 (data only; the machinery is
// in scripts/lib/). Consumed by scripts/import-vendor-ui.mjs. See docs/port/impl-vendor-ui.md.
//
// Every anchor below was verified against the raw minified bundle (work/app/out/renderer, identical
// to the installer's app.asar) and must match exactly `expectCount` times (default 1). The pinned
// SHA-256 values make any other vendor build fail before a single byte is patched.
//
// Spec references: 02 = docs/re/02-renderer-shell.md, 03 = 03-renderer-monitor-pages.md,
// 04 = 04-renderer-peripheral-pages.md, 14 = 14-online-sweep.md (touchpoints N01..N40).

/** @typedef {import('./lib/types.ts').UiPatchTable} UiPatchTable */

const STYLES = 'assets/styles-*.js';
const MAIN = 'assets/main-*.js';
// The monitor Ambiglow page (03 §4.5). The glob also matches the three peripheral Ambiglow chunks, which only a
// PIN_MISSING message lists; the exact name and hash pin the monitor page.
const AMBIGLOW = 'assets/Ambiglow-*.js';

/** The FAST-LED-UPLOAD checkbox's description (a visible second line and the row's tooltip). */
const FAST_LED_UPLOAD_HINT = 'Sends each frame in one USB transfer. Turn off if the lights flicker or freeze.';

/**
 * The FAST-LED-UPLOAD checkbox's log line when the preload refuses a change (followed by the reason). The vendor
 * Checkbox has already toggled its local value and cannot be reset from the page, so the line says so.
 */
const FAST_LED_UPLOAD_REFUSED =
  'Fast LED upload not changed; the checkbox shows the wrong state until the row is shown again (another effect and back, or the page reopened): ';

/**
 * Local-only policy for every HTML entry point (14 N31; ARCHITECTURE rules 4 and 5). For a file: page
 * 'self' matches every file: URL, so connect-src names only the loopback hub: fetch()/XHR of files is
 * refused (the bundle never fetches its own files; the cloud requests it had are disabled by P1-P4).
 * The bundle has no frames, media, forms or manifest, and its one Worker (browser-image-compression)
 * is disabled by IMGCOMP-NO-WORKER. The main-process kill-switch additionally limits file: requests to
 * the app tree (src/main/network-guard.ts).
 */
const CSP =
  "default-src 'self'; connect-src ws://127.0.0.1:*; img-src 'self' data: blob: local:; " +
  "script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; object-src 'none'; base-uri 'none'; " +
  "frame-src 'none'; worker-src 'none'; media-src 'none'; form-action 'none'; manifest-src 'none'";

/** @type {UiPatchTable} */
export default {
  vendor: { product: 'Evnia Precision Center', version: '1.13.0' },
  csp: CSP,

  pinnedFiles: [
    { glob: STYLES, path: 'assets/styles-DAnQi2A8.js', sha256: 'c3b4f412f79f871488ae7ca43a3b68f0253dacd7f0c46324671f89723832f550' },
    { glob: MAIN, path: 'assets/main-CDosWiM3.js', sha256: 'de62edb3976b0b256b6f8e8549a084d990d3ffeefe3401471a89ff97d33cd24a' },
    { glob: 'index.html', path: 'index.html', sha256: '96f86597d762b950c28087602f97b5215331e47746dd2945642504a75498adab' },
    { glob: 'notice/notice.html', path: 'notice/notice.html', sha256: '74725dc53130d4166f7620c54ddbc552b354941c05ef807c50408ce11223c1cb' },
    { glob: AMBIGLOW, path: 'assets/Ambiglow-Dvqon39u.js', sha256: '89838ac09fdb11c535ef79dc931e997fe7803509a4cf19cb1fed22281921d43a' },
  ],

  cspFiles: ['index.html', 'notice/notice.html'],

  patches: [
    // ── Local hub connection ────────────────────────────────────────────────────────────────
    {
      id: 'HUB-URL',
      file: STYLES,
      find: '`http://localhost:${e}/EvniaHub`',
      replace: '`http://127.0.0.1:${e}/EvniaHub?k=${encodeURIComponent(window.__EVNIA__?.hubToken??"")}`',
      rationale:
        'The SignalR client (class Jc) connects with skipNegotiation over WebSockets, so the URL becomes ' +
        'ws://127.0.0.1:<port>/EvniaHub?k=<token>. The hub binds to 127.0.0.1 only and rejects connections without ' +
        'the per-launch token that the preload exposes as window.__EVNIA__.hubToken. A missing token yields k= and ' +
        'the server refuses the connection (fail closed).',
      spec: '02 §4.1, §L.4; 14 N33/N34; ARCHITECTURE "Keep the SignalR wire protocol"',
    },

    // ── Cloud request core (02 §L.3 P1-P4) ──────────────────────────────────────────────────
    {
      id: 'P1',
      file: STYLES,
      find: 'async function Sv(e,t){',
      replace: 'async function Sv(e,t){throw new Error("offline");',
      rationale:
        'Sv() is the request core behind every saas/deviceportal/pcenter call except vv.get (_v, Ev, yv, vv.post/put/delete). ' +
        'Rejecting with an Error object makes all callers take their existing "no network" paths.',
      spec: '02 §L.3 P1; 14 N15/N18/N23/N29',
    },
    {
      id: 'P2',
      file: STYLES,
      find: 'const i=new URL(cv+e);',
      replace: 'return r(new Error("offline"));const i=new URL(cv+e);',
      rationale: 'vv.get (pcenter lists, presigned URLs, file-exist checks) calls fetch directly; reject before building the request.',
      spec: '02 §L.3 P2; 14 N28/N29',
    },
    {
      id: 'P3',
      file: STYLES,
      find: 'async function Mv(e,t=!1,o=""){',
      replace: 'async function Mv(e,t=!1,o=""){return[];',
      rationale:
        'Component-update check (firmware, DTS, SmartDesktop, AmbiScape Node). Returning [] means "no update" and ' +
        'also skips the MAC lookup that precedes the request.',
      spec: '02 §L.3 P3; 14 N17/N19/N20/N21',
    },
    {
      id: 'P4a',
      file: STYLES,
      find: 'getDeviceImage(e){',
      replace: 'getDeviceImage(e){return Promise.resolve([]);',
      rationale: 'Cloud device thumbnails for cloud-profile previews; resolve empty without a request.',
      spec: '02 §L.3 P4; 14 N16',
    },
    {
      id: 'P4b',
      file: STYLES,
      find: 'getDeviceResource(e){',
      replace: 'getDeviceResource(e){return Promise.resolve([]);',
      rationale:
        'saveDeviceList() posts every model not in the bundled list (the monitor is "PHL 34M2C8600") to ' +
        '/pcenter/device/files and waits for it; resolving [] keeps start-up local and instant. The 34M2C8600 images are bundled.',
      spec: '02 §L.3 P4, §O-3; 03 §9 B10; 14 N16',
    },
    {
      id: 'CLOUD-HOSTS',
      file: STYLES,
      find: 'saasDomain:"https://saas.zeasn.tv",portalDomain:"https://deviceportal.zeasn.tv/direct",pcenterDomain:"https://pcenter.zeasn.tv"',
      replace: 'saasDomain:"offline:",portalDomain:"offline:",pcenterDomain:"offline:"',
      rationale:
        'Defence in depth behind P1/P2: the cloud base URLs become a non-network scheme, so any request URL built from ' +
        'them is valid for new URL() but can never be fetched. No Zeasn host name remains in the UI.',
      spec: '14 §2.1, §2.2',
    },
    {
      id: 'UNDICI-IMPORT',
      file: STYLES,
      find: 'await import("./index-BYSWl2m0.js").then(e=>e.i)',
      replace: 'await Promise.reject(new Error("offline"))',
      rationale:
        'The proxy branch of Sv() lazily imports the undici chunk (Node-only, dead in a browser renderer and unreachable ' +
        'after P1). Dropping the import lets the 12k-line chunk be removed with no dangling reference.',
      spec: '02 §1.1 (index-BYSWl2m0.js); 14 N11',
    },
    {
      id: 'NO-MAC',
      file: STYLES,
      find: 'async function Cv(){return"undefined"==typeof window?"":(window.runConfig.mac||(window.runConfig.mac=await window.ipc.invoke("getMac")),window.runConfig.mac)}',
      replace: 'async function Cv(){return""}',
      rationale: 'Cv() fetches the machine MAC address for cloud requests (ruleMac, login, deviceSign). Never ask main for it.',
      spec: '14 N14; 02 §3.1 getMac',
    },
    {
      id: 'SECRET-SAAS',
      file: STYLES,
      // RegExp so the vendor's access/secret key pair is not reproduced in this repository.
      find: /function km\(e\)\{const t=\{AccessKey:"[^"]*",SecretKey:"[^"]*"\}/,
      replace: 'function km(e){const t={AccessKey:"",SecretKey:""}',
      rationale: 'Hard-coded saas HMAC credentials are only used by removed account paths; blank them (14 §2.3 "Delete them").',
      spec: '14 §2.3; 02 Online touchpoints (HMAC keys)',
    },
    {
      id: 'SECRET-ZAUTH',
      file: STYLES,
      find: /`ZAuth [^`:]*:\$\{Xp\.enc\.Base64\.stringify\(Xp\.HmacSHA1\(r,"[^"]*"\)\)\}`/,
      replace: '`ZAuth :${Xp.enc.Base64.stringify(Xp.HmacSHA1(r,""))}`',
      rationale: 'Hard-coded deviceportal ZAuth key id and HMAC secret (component-update signing) are blanked; the signer stays callable.',
      spec: '14 §2.3',
    },

    // ── Remote code loaders ─────────────────────────────────────────────────────────────────
    {
      id: 'IMGCOMP-NO-WORKER',
      file: STYLES,
      find: 'l="boolean"!=typeof r.useWebWorker||r.useWebWorker',
      replace: 'l=!1',
      rationale:
        'browser-image-compression runs in a blob Worker that importScripts() the library from jsDelivr. Forcing the ' +
        'main-thread path (the library\'s own fallback) removes the remote script load. Only the avatar upload uses it.',
      spec: '14 N24',
    },
    {
      id: 'IMGCOMP-NO-CDN',
      file: STYLES,
      find: 'r.libURL=r.libURL||"https://cdn.jsdelivr.net/npm/browser-image-compression@2.0.2/dist/browser-image-compression.js"',
      replace: 'r.libURL=r.libURL||""',
      rationale: 'Remove the jsDelivr URL itself; the worker branch that would use it is disabled by IMGCOMP-NO-WORKER.',
      spec: '14 N24',
    },

    // ── Account / login / cloud UI (02 §L.3 P5-P7) ──────────────────────────────────────────
    {
      id: 'P5',
      file: MAIN,
      find: '{name:"account",tip:"Account",path:$.Account,hidden:!1}',
      replace: '{name:"account",tip:"Account",path:$.Account,hidden:!0}',
      rationale: 'The toolbar Account button is the only UI entry into Account, login and register.',
      spec: '02 §L.3 P5; 14 N15/N23',
    },
    {
      id: 'P6',
      file: MAIN,
      find: 'y.loginState||e?ne.value=!1:oe.value=!0',
      replace: 'ne.value=!1',
      rationale: 'Never auto-show the login overlay on Home mount (its mount also calls deviceSign and oauth/apps).',
      spec: '02 §L.3 P6; 14 N15/N18',
    },
    {
      id: 'LOGIN-EVENTS',
      file: MAIN,
      find: '"Home"===t&&(o.on("openLogin",c),o.on("openEmailAssociated",f))',
      replace: 'void 0',
      rationale:
        'The bus events openLogin/openEmailAssociated are the remaining ways to open the login overlay (Profile ' +
        '"Log in to cloud", cloud error 650401, Account pages). With no listener the overlay can never appear.',
      spec: '02 §7 (Login overlay); 14 N15/N18',
    },
    {
      id: 'P7',
      file: MAIN,
      find: 'le("https://www.evnia.philips")',
      replace: 'void 0',
      rationale: 'The brand-logo click opened the vendor website in the system browser.',
      spec: '02 §L.3 P7; 14 N27',
    },
    {
      id: 'NO-EXTERNAL-BROWSER',
      file: STYLES,
      find: 'ipcOpenDefaultBrowser:function(e){window.ipc.send("openDefaultBrowser",e)}',
      replace: 'ipcOpenDefaultBrowser:function(e){}',
      rationale:
        'Every remaining caller (OSS licence links in the Terms dialog, OAuth) would hand a remote URL to the OS browser. ' +
        'The licence URLs stay visible as text but are inert; the main process does not implement the channel either.',
      spec: '14 N09/N27; 02 §3.1 openDefaultBrowser',
    },
    {
      id: 'PROFILE-NO-CLOUD-EXPORT',
      file: STYLES,
      find: 'Gr("div",ub,[bt(a)?(kr(),Kr("span",{key:0,class:"text-active",onClick:W},Q(s.$t("ExportToCloud")),1)):(kr(),Kr("span",{key:1,onClick:W},Q(s.$t("LoginToCloud")),1)),bt(a)?Xr("",!0):(kr(),Yr(j,{key:2,name:"tooltip",onClick:W}))]),',
      replace: '',
      rationale: 'Profile page export dialog: drop the "Export to cloud" / "Log in to cloud" link row; local export is unchanged.',
      spec: '14 N29; 04 Online touchpoints #4',
    },
    {
      id: 'PROFILE-NO-CLOUD-IMPORT',
      file: STYLES,
      find: 'jr(G,{modelValue:bt(R),"onUpdate:modelValue":c[0]||(c[0]=e=>yt(R)?R.value=e:null),options:bt(w)},null,8,["modelValue","options"]),',
      replace: '',
      rationale:
        'Profile page import dialog: drop the "From local / From cloud" source selector. importSource stays 0, so the ' +
        'local file picker is always shown.',
      spec: '14 N29 (importSourceOptions)',
    },

    // ── Settings (02 §L.3 P8-P10) ───────────────────────────────────────────────────────────
    {
      id: 'P8',
      file: STYLES,
      find: 'jr(I,{text:"Feedback",highlight:"",onClick:bt(P)},null,8,["onClick"]),',
      replace: '',
      rationale: 'Settings > General "Feedback" opened the online feedback window (log + MAC upload). The sub-app is removed below.',
      spec: '02 §L.3 P8, §11.1; 14 N22',
    },
    {
      id: 'P9',
      file: STYLES,
      find: ',{name:"FwUpdate",value:4}];return o.hasMonitor&&e.splice(2,0,{name:"AmbiScape",value:3}),r.value.length&&e.push({name:"PairingTool",value:5}),e}',
      replace: '];return e}',
      rationale:
        'Settings menu becomes General, AboutPCenter, AboutDevice. FwUpdate is the online OTA manager, AmbiScape the Matter ' +
        'bulb/Node-download page, PairingTool pairs Philips 2.4 GHz peripherals (out of scope; GetPairDevices is still ' +
        'called and the backend answers []).',
      spec: '02 §L.3 P9, §7; 04 §3.6 PairingTool; 14 N17/N21',
    },
    {
      id: 'P10',
      file: STYLES,
      find:
        'Gr("div",zv,[jr(n,{modelValue:r.value,"onUpdate:modelValue":o[0]||(o[0]=e=>r.value=e),"active-text":"AutoUpdate",class:"display-switch",onChange:s},null,8,["modelValue"])]),' +
        'Gr("div",Vv,[jr(d,{modelValue:a.value,"onUpdate:modelValue":o[1]||(o[1]=e=>a.value=e),label:"AutoDownload",disabled:!r.value},null,8,["modelValue","disabled"]),' +
        'jr(d,{modelValue:i.value,"onUpdate:modelValue":o[2]||(o[2]=e=>i.value=e),label:"AutoDonwloadAndInstall",disabled:!r.value},null,8,["modelValue","disabled"])]),' +
        'Gr("div",Wv,[jr(p,{text:"CheckUpdates",size:"large","max-width":"3rem",highlight:"",class:"update-btn",onClick:o[3]||(o[3]=e=>bt(t)())})]),',
      replace: '',
      rationale:
        'About page: drop the AutoUpdate switch, the auto-download/install checkboxes and "Check for updates" (which ' +
        'shows a SERVER loading overlay until main answers versionCheckResult). Updates come from the package manager.',
      spec: '02 §L.3 P10; 14 N02/N03',
    },
    {
      id: 'OTA-OFF',
      file: STYLES,
      find: 'OTASupport(e){return t=>Boolean(e.OTAEnable&&e.configInJson[t||this.modelNameInJson()]?.SupOTA)}',
      replace: 'OTASupport(e){return t=>!1}',
      rationale:
        'Hides the monitor Setup "FwUpdate" tab and the FirmwareManager auto-check independently of main\'s ' +
        'getMonitorJsonConfig (which also returns OTAEnable:false). configInJson keeps gating Ambiglow and HDR.',
      spec: '02 §L.3 (OTAEnable), §8; 03 §4.9; 14 N17',
    },
    {
      id: 'IPC-ONLINE-EVENTS',
      file: STYLES,
      find:
        'ipcEventListen:function(){t.push(window.ipc.once("newVersionPrompt",(e,t)=>nh.emit("newVersionPrompt",t))),' +
        't.push(window.ipc.on("versionCheckResult",(e,t)=>nh.emit("versionCheckResult",t))),' +
        't.push(window.ipc.on("checkSoftwareUpgrade",()=>e())),' +
        't.push(window.ipc.on("toPageView",(e,t)=>nh.emit("toPageView",t))),' +
        't.push(window.ipc.on("rescan",()=>nh.emit("rescan"))),' +
        't.push(window.ipc.on("thirdPartySuccess",(e,t)=>{const{loginState:o}=Ga(Ab()),{showMessage:n}=oh(),{type:r}=t;switch(r){case Ol.ISLOGIN:o.value?n("ThirdPartyLoginTip"):nh.emit("thirdPartyLoginEmit",t);break;case Ol.ISASS:nh.emit("thirdPartyAssociatedEmit",t)}})),' +
        't.push(window.ipc.on("mainWindowShow",()=>nh.emit("mainWindowShow"))),' +
        't.push(window.ipc.on("loginShow",()=>nh.emit("openLogin"))),' +
        't.push(window.ipc.on("matterNotification",(e,t)=>nh.emit("matterNotification",t)))},',
      replace:
        'ipcEventListen:function(){t.push(window.ipc.on("toPageView",(e,t)=>nh.emit("toPageView",t))),' +
        't.push(window.ipc.on("rescan",()=>nh.emit("rescan"))),' +
        't.push(window.ipc.on("mainWindowShow",()=>nh.emit("mainWindowShow")))},',
      rationale:
        'Keep only the local main→renderer events of this listener set. newVersionPrompt/versionCheckResult/' +
        'checkSoftwareUpgrade (self-update), thirdPartySuccess (OAuth deep link), loginShow and matterNotification ' +
        'belong to removed features; the preload allowlist drops them as well.',
      spec: '02 §3.2; 14 N02/N03/N10/N18/N21',
    },

    // ── SmartDesktop and AmbiScape bulbs (02 §L.3 P11; 03 §4.10-4.11) ───────────────────────
    {
      id: 'P11',
      file: MAIN,
      find: '{icon:"nav_smart_desktop",path:$.Monitor_SmartDesktop,tip:"SmartDesktop",actived:o.path===$.Monitor_SmartDesktop}',
      replace: '{icon:"nav_smart_desktop",path:$.Monitor_SmartDesktop,tip:"SmartDesktop",actived:o.path===$.Monitor_SmartDesktop,hidden:!0}',
      rationale: 'SmartDesktop is Windows PowerToys FancyZones plus an online installer. The sidebar filters hidden items.',
      spec: '02 §L.3 P11; 03 §4.10; 14 N20',
    },
    {
      id: 'ROUTE-SMARTDESKTOP',
      file: STYLES,
      find: ',{path:"/monitor/smartDesktop",component:()=>Qa(()=>import("./SmartDesktop-By8ZEPkl.js"),__vite__mapDeps([30,31]),import.meta.url),meta:{module:"Monitor",title:"SmartDesktop"}}',
      replace: '',
      rationale: 'Drop the /monitor/smartDesktop route so its chunk (FancyZones calls, installer download, runCommand) can be removed.',
      spec: '03 §4.10; 14 N20',
    },
    {
      id: 'BULB-OFF',
      file: MAIN,
      find: 'const e=window.store.get("ambiScapeEnable")??!1,t=await f();a.setBulbEnabled(e&&t.available)',
      replace: 'a.setBulbEnabled(!1)',
      rationale:
        'The AmbiScape pseudo-device appears only when bulbs are enabled. Force it off at start-up (no checkNodeAvailable ' +
        'IPC); with the device absent the bulb manager and follow-video bulb streaming never start.',
      spec: '02 §4.8 step 4; 03 §4.11; 14 N21/N39',
    },
    {
      id: 'ROUTE-BULB',
      file: STYLES,
      find: ',{path:"/bulb",name:"BulbView",component:()=>Qa(()=>import("./Bulb-vdvqR6Jj.js"),__vite__mapDeps([88,1,2]),import.meta.url),children:[{path:"/bulb/ambiScape",component:()=>Qa(()=>import("./AmbiScape-B35D_GM2.js"),__vite__mapDeps([89,90]),import.meta.url),meta:{title:"AmbiScape"}}]}',
      replace: '',
      rationale: 'Drop the /bulb routes so the Bulb and AmbiScape chunks (Matter pairing, camera QR reader, zxing-wasm from jsDelivr) can be removed.',
      spec: '03 §4.11; 14 N21/N25/N32',
    },

    // ── Bundled device images independent of the install layout ────────────────────────────
    {
      id: 'IMG-PATH',
      file: STYLES,
      find: '`../../../${n?"out/renderer/":""}${o[i.deviceType]}/${e}`',
      replace: '`../${o[i.deviceType]}/${e}`',
      rationale:
        'DeviceImage resolved bundled product images relative to the asar root ("out/renderer/" when packaged). ' +
        'Resolve them relative to the renderer root instead, so build/vendor-ui works wherever it is installed and ' +
        'regardless of runConfig.isPackaged.',
      spec: '02 §11.3; 04 §3.6 DeviceImage',
    },
    {
      id: 'IMG-PATH-OVERVIEW',
      file: STYLES,
      find: 'let e=`../../../${o[i.deviceType]}/${d.value}.png`;n&&(e=`../../../out/renderer/${o[i.deviceType]}/${d.value}.png`),p.value=',
      replace: 'let e=`../${o[i.deviceType]}/${d.value}.png`;p.value=',
      rationale: 'Same as IMG-PATH for the onError fallback (the 34M2C8600 has no _overview face, so this path is used).',
      spec: '02 §11.3; 04 §3.6 DeviceImage',
    },

    // ── Port features (Linux additions to the vendor UI) ─────────────────────────────────────
    {
      id: 'FAST-LED-UPLOAD',
      file: AMBIGLOW,
      // The end of the Speed slider block and the start of the StarCount one in the Ambiglow page's render
      // (Ambiglow-Dvqon39u.js:1435-1454 prettified); `onChange:ia` names the Speed slider's handler.
      find: 'onChange:ia},null,8,["modelValue","range","marks","disabled"])):m("",!0),Ye.startCount.support?',
      replace:
        'onChange:ia},null,8,["modelValue","range","marks","disabled"])):m("",!0),' +
        'c(Z)&&1===Ae.value&&window.__EVNIA__?.experimental?(t=>(n(),u("div",{key:4,class:"slider-item evnia-fast-led-upload",' +
        `title:${JSON.stringify(FAST_LED_UPLOAD_HINT)}},[` +
        'r(s("Checkbox"),{modelValue:t.eneFrameBurst||t.forcedByEnv,label:"Fast LED upload (experimental)",i18n:!1,' +
        'disabled:!Ce.value||t.forcedByEnv,onChange:e=>{window.__EVNIA__.experimental.setEneFrameBurst(e).catch(x=>{' +
        `const msg=${JSON.stringify(FAST_LED_UPLOAD_REFUSED)}+(x&&x.message||x);console.warn(msg);window.__electronLog?.warn(msg)})}},` +
        'null,8,["modelValue","disabled"]),' +
        'S("div",{class:"evnia-fast-led-upload-hint",style:{fontSize:".11rem",lineHeight:".16rem",marginTop:".04rem",opacity:.6}},' +
        `t.forcedByEnv?"On because EVNIA_ENE_FRAME_BURST=1 is set; unset it to turn this off.":${JSON.stringify(FAST_LED_UPLOAD_HINT)},1)` +
        '])))(window.__EVNIA__.experimental.get()):m("",!0),' +
        'Ye.startCount.support?',
      rationale:
        'Port feature (user request 2026-09-27): the "Fast LED upload (experimental)" checkbox for the experimental ENE frame ' +
        'burst (one USB control transfer per Follow video frame instead of six paced writes; impl-usb-ene §2.2), directly ' +
        'after the Speed slider. Shown only with the ENE (ENEEffectEnable, Z) and the Follow Video effect (Ae = EffectType 1), ' +
        'and only when the preload offers window.__EVNIA__.experimental; disabled while the effect is off (Ce) like the ' +
        'sliders, and ticked and disabled when EVNIA_ENE_FRAME_BURST=1 forces the burst on. It is the vendor\'s own global ' +
        'Checkbox component (main-CDosWiM3.js:4052), resolved like the page\'s other components, in the page\'s scoped ' +
        '"slider-item" row, with a second line of hint text. The checkbox keeps its toggled state itself (useModel without ' +
        'onUpdate:modelValue) and calls the narrow preload API, which stores config.json linuxExperimental.eneFrameBurst ' +
        'through main (main window only, booleans only) and switches the backend from the next frame; get() is synchronous, ' +
        'so the first render shows the stored state. A refused call is logged (console and window.__electronLog, i.e. the ' +
        'main log); the box keeps showing the refused value until the row is created again (the Checkbox\'s local model ' +
        'cannot be reset from the page, and get() is not reactive). No window.ipc channel, no URL, nothing online.',
      spec: 'impl-vendor-ui §3 FAST-LED-UPLOAD; impl-usb-ene §2.2 deviation 20; impl-electron-shell "IPC" (experimentalSet); 03 §4.5',
    },
  ],

  // Files dropped from the imported UI. After patching, nothing in the kept JS/HTML/CSS may refer to
  // them except inert entries of vite's __vite__mapDeps file table (mapDepsEntries), whose indices no
  // remaining preload call uses; the importer verifies both (scripts/lib/removals.ts).
  removals: [
    { path: 'feedback/feedback.html', reason: 'Online feedback window (log, MAC and hostname upload); main never opens it.', spec: '02 §11.1; 14 N22', mapDepsEntries: 0 },
    { path: 'assets/feedback-NPrjkfNw.js', reason: 'Entry chunk of the feedback window.', spec: '02 §11.1; 14 N22', mapDepsEntries: 0 },
    { path: 'assets/feedback-DH816rEa.css', reason: 'Stylesheet of the feedback window.', spec: '02 §11.1; 14 N22', mapDepsEntries: 0 },
    { path: 'assets/index-BYSWl2m0.js', reason: 'undici (Node HTTP client, proxy support); its only import is removed by UNDICI-IMPORT.', spec: '02 §1.1; 14 N11', mapDepsEntries: 0 },
    // Table indices 30/31 (styles chunk); their only preload call was the route removed by ROUTE-SMARTDESKTOP.
    { path: 'assets/SmartDesktop-By8ZEPkl.js', reason: 'SmartDesktop page; route removed by ROUTE-SMARTDESKTOP, nav hidden by P11.', spec: '03 §4.10; 14 N20', mapDepsEntries: 1 },
    { path: 'assets/SmartDesktop-DDdFid7d.css', reason: 'SmartDesktop page stylesheet.', spec: '03 §4.10', mapDepsEntries: 1 },
    // Table indices 88/89/90; their only preload calls were the routes removed by ROUTE-BULB.
    { path: 'assets/Bulb-vdvqR6Jj.js', reason: 'Bulb device root; route removed by ROUTE-BULB, device disabled by BULB-OFF.', spec: '03 §4.11; 14 N21', mapDepsEntries: 1 },
    {
      path: 'assets/AmbiScape-B35D_GM2.js',
      reason: 'Matter bulb pairing page: camera QR reader, zxing-wasm from fastly.jsdelivr.net, GetWifiList.',
      spec: '03 §4.11; 14 N21/N25/N32',
      mapDepsEntries: 1,
    },
    { path: 'assets/AmbiScape-CSqmg1LO.css', reason: 'AmbiScape page stylesheet.', spec: '03 §4.11', mapDepsEntries: 1 },
    { path: 'assets/matter_scan_tip-DSFC2GUj.png', reason: 'Image used only by the AmbiScape page.', spec: '03 §4.11', mapDepsEntries: 0 },
    { path: 'smart_bulb.png', reason: 'Unreferenced bulb image (AmbiScape feature).', spec: '03 §4.11', mapDepsEntries: 0 },
  ],

  copies: [
    // Capability table read by main (getMonitorJsonConfig) and the backend (DictMgr); v34, identical to main's embedded copy.
    { from: 'asar', source: 'MonitorInfo.json', destDir: 'vendor-data', sha256: 'b54cccfd20b1dc562a0ed9b021ee5487e660391f631e11695a20f70ab5ad3ee8' },
    // Backend supported-device table (04 §2.2) and ENE Ambiglow model table (09).
    { from: 'resources', source: 'bin/res/data/PCenter_DeviceInfo.json', destDir: 'vendor-data', sha256: '9d731dcbb072d767aea830220e854921324841f6ba7c4b53772c07a6f05c42af' },
    { from: 'resources', source: 'bin/res/data/ENE/PCenter_AmbiglowInfo.json', destDir: 'vendor-data/ENE', sha256: 'e0290c3769358f4b42ebfb10ecaf2668078c942f99a3143d668f04a47d58156e' },
    // Tray and window icons (01 §5): favicon*.png, tray_*.png.
    { from: 'asar', source: 'resources/*.png', destDir: 'vendor-assets' },
  ],

  // Absolute URLs that may stay because nothing ever requests them. The loopback hub (127.0.0.1) is
  // accepted by the audit itself; `localhost` is not, so an unpatched hub URL fails the build.
  urlAllowlist: [
    { url: 'https://vuejs.org/error-reference/#runtime-${n}', reason: 'Vue runtime error-message text; never requested' },
    { url: 'http://www.w3.org/2000/svg', reason: 'XML namespace identifier (createElementNS); never requested' },
    { url: 'http://www.w3.org/1998/Math/MathML', reason: 'XML namespace identifier (createElementNS); never requested' },
    { url: 'http://www.w3.org/1999/xlink', reason: 'XML namespace identifier (setAttributeNS); never requested' },
    { url: 'https://docs.microsoft.com/aspnet/core/signalr/javascript-client#bsleep', reason: 'SignalR client warning text; never requested' },
    { url: 'https://aka.ms/signalr-core-differences', reason: 'SignalR client error text (negotiation only, skipped); never requested' },
    { url: 'https://www.nuget.org/packages/NAudio/2.1.0/license', reason: 'OSS licence table text; its click handler is a no-op (NO-EXTERNAL-BROWSER)' },
    { url: 'https://licenses.nuget.org/BSD-3-Clause', reason: 'OSS licence table text; its click handler is a no-op (NO-EXTERNAL-BROWSER)' },
    { url: 'https://github.com/nlua/NLua/blob/main/LICENSE', reason: 'OSS licence table text; its click handler is a no-op (NO-EXTERNAL-BROWSER)' },
    { url: 'https://www.nuget.org/packages/SharpCompress/0.32.2/license', reason: 'OSS licence table text; its click handler is a no-op (NO-EXTERNAL-BROWSER)' },
  ],

  // Network-capable API call sites that remain, with the reason each cannot reach the network.
  reviewedSites: [
    {
      file: STYLES, api: 'fetch', context: 'this._fetchType=fetch.bind', count: 1,
      reason: 'SignalR FetchHttpClient; only used for negotiate/long polling, which skipNegotiation+WebSockets never do; target is the hub URL',
    },
    {
      file: STYLES, api: 'fetch', context: 'iv.debug(`${i} request`,e.toJSON(),t)', count: 1,
      reason: 'Sv() cloud request core; unreachable (P1 throws on entry) and URLs use the offline: scheme (CLOUD-HOSTS)',
    },
    {
      file: STYLES, api: 'fetch', context: 'i=new URL(cv+e);i.search=new URLSearchParams(t).toString()', count: 1,
      reason: 'vv.get pcenter GET; unreachable (P2 rejects first)',
    },
    {
      file: STYLES, api: 'fetch', context: 'const{fileUrl:i,presignedUrl:a}=r;', count: 1,
      reason: 'Avatar upload PUT; runs only after a saas presignedUrl reply, which P1 makes impossible (Account UI hidden by P5)',
    },
    {
      file: STYLES, api: 'fetch', context: 'window.nodeApi.readFile(e,(e,o)=>{if(e)return i(e);', count: 1,
      reason: 'Cloud file upload PUT (profiles/macros); runs only after a pcenter presignedUrl reply, which P2 makes impossible',
    },
    {
      file: STYLES, api: 'XMLHttpRequest', context: 'e.method?e.url?new Promise((t,o)=>{const n=', count: 1,
      reason: 'SignalR XhrHttpClient; fallback when fetch is missing, never used with skipNegotiation+WebSockets; target is the hub URL',
    },
    {
      file: STYLES, api: 'XMLHttpRequest', context: '"undefined"!=typeof XMLHttpRequest&&"string"!=typeof(', count: 1,
      reason: 'SignalR LongPolling capability probe (constructs an XHR to read responseType; sends nothing; transport not used)',
    },
    {
      file: STYLES, api: 'WebSocket', context: '(t[Hc.Cookie]=a),', count: 1,
      reason: 'SignalR WebSocketTransport Node branch (cc.isNode); not taken in the renderer',
    },
    {
      file: STYLES, api: 'WebSocket', context: '`access_token=${encodeURIComponent(o)}`', count: 1,
      reason: 'SignalR WebSocketTransport browser branch: the only live socket, to ws://127.0.0.1:<port>/EvniaHub?k=<token> (HUB-URL)',
    },
    {
      file: STYLES, api: 'EventSource', context: 'new this._options.EventSource(e,{withCredentials:this._options.withCredentials})', count: 1,
      reason: 'SignalR ServerSentEventsTransport browser branch; never constructed: skipNegotiation+WebSockets selects only the WebSocket transport, and connect-src would block an SSE request anyway',
    },
    {
      file: STYLES, api: 'EventSource', context: 'new this._options.EventSource(e,{withCredentials:this._options.withCredentials,headers:', count: 1,
      reason: 'SignalR ServerSentEventsTransport Node branch (cookie headers); not taken in the renderer and never constructed (see above)',
    },
    {
      file: STYLES, api: 'importScripts', context: 'if (!scriptImported) {', count: 1,
      reason: 'Source text of the browser-image-compression blob worker; the worker is never created (IMGCOMP-NO-WORKER) and libURL is empty (IMGCOMP-NO-CDN)',
    },
    {
      file: STYLES, api: 'Worker', context: 'const r=new Worker(hT)', count: 1,
      reason: 'browser-image-compression worker; disabled by IMGCOMP-NO-WORKER (main-thread compression only)',
    },
  ],

  // Scheme-only literals that remain, with the reason none of them builds a URL by concatenation.
  reviewedSchemes: [
    {
      file: STYLES, context: '_resolveUrl(e){if(0===e.lastIndexOf("https://",0)||0===e.lastIndexOf("http://",0))return e;', count: 2,
      reason: 'SignalR HttpConnection._resolveUrl: prefix test whether the hub URL is already absolute (it is: HUB-URL); compared, never concatenated',
    },
    {
      file: 'assets/ButtonFunc-*.js', context: 'placeholder:"http://",maxlength:100', count: 1,
      reason: 'Input placeholder of the peripheral key "Launch website" action (peripheral pages only; 14 N37); display text, never requested',
    },
  ],

  // Decision record for every online touchpoint of 14-online-sweep.md (N01..N40) as it concerns the
  // renderer. The other layers (main, preload, backend) implement the decisions marked for them.
  touchpoints: [
    { id: 'N01', what: 'MonitorInfo.json refresh', decision: 'main', patches: [], note: 'Main never downloads it; the import copies the bundled v34 table to build/vendor-data/MonitorInfo.json.' },
    { id: 'N02', what: 'App self-update: deviceSign', decision: 'patched', patches: ['P10', 'IPC-ONLINE-EVENTS'], note: 'Update controls and update events removed from the UI; main has no updater.' },
    { id: 'N03', what: 'App self-update: clientUpg version check', decision: 'patched', patches: ['P10', 'IPC-ONLINE-EVENTS'], note: 'As N02.' },
    { id: 'N04', what: 'Installer download and execution', decision: 'main', patches: [], note: 'No updater in main; updates come from the .deb.' },
    { id: 'N05', what: 'Resource patch pack (translation.json)', decision: 'main', patches: [], note: 'Renderer still reads <patchPath>/translation.json if present (local only); main never downloads it.' },
    { id: 'N06', what: 'Generic download manager (createDownload)', decision: 'patched', patches: ['P3', 'P9', 'OTA-OFF', 'ROUTE-SMARTDESKTOP', 'ROUTE-BULB'], note: 'Every caller follows a component-update result, which P3 makes empty; main/preload do not implement the channel.' },
    { id: 'N07', what: 'imageResourceDownload', decision: 'patched', patches: ['P4b'], note: 'Only caller is the device-image lookup; preload answers "" as a backstop.' },
    { id: 'N08', what: 'getCloudFileCacheOrDownload', decision: 'patched', patches: ['P1', 'P2', 'P5', 'PROFILE-NO-CLOUD-IMPORT'], note: 'Only reachable from cloud profile/macro lists, which can no longer be fetched or opened.' },
    { id: 'N09', what: 'External browser launches', decision: 'patched', patches: ['P7', 'NO-EXTERNAL-BROWSER'], note: 'Renderer never sends openDefaultBrowser; main does not implement it.' },
    { id: 'N10', what: 'EvniaPrecisionCenterApp:// deep link (OAuth return)', decision: 'patched', patches: ['IPC-ONLINE-EVENTS'], note: 'thirdPartySuccess listener removed; main registers no protocol.' },
    { id: 'N11', what: 'Proxy support disabling TLS verification', decision: 'removed', patches: ['P1', 'UNDICI-IMPORT'], note: 'Renderer copy of the proxy branch is unreachable and the undici chunk is removed; main has no HTTP client.' },
    {
      id: 'N12', what: 'local:// protocol handler', decision: 'main', patches: [],
      note:
        'The renderer loads "local:///"+<absolute path> images from three places: (1) device images of models ' +
        'that are not bundled, <userData>/ImageCache/<model>/<face>.png (DeviceImage; 02 §11.3); (2) app-bound ' +
        'theme icons, BindAppIconPath = <EvniaServe data>/Theme/<theme>/Icon/<sha10>.png (Profile page theme list ' +
        'and bind-app dialog; 20-theme §3.4, §9); (3) icons just returned by Comm_GenAppIcon, shown in the bind-app ' +
        'dialog before binding moves them into Theme/<theme>/Icon (the backend temp directory, %TEMP%\\EvniaServe on ' +
        'Windows; 13 §4.2). Main must allow all three roots and serve only image files below them.',
    },
    { id: 'N13', what: 'Spell-check dictionary download (Linux)', decision: 'main', patches: [], note: 'spellcheck:false on every BrowserWindow.' },
    { id: 'N14', what: 'MAC address and system-info collection', decision: 'patched', patches: ['NO-MAC'], note: 'Renderer never asks for the MAC; feedback (getSystemInfo) is removed; main returns mac:"".' },
    { id: 'N15', what: 'Accounts: login, registration, profile', decision: 'patched', patches: ['P1', 'P5', 'P6', 'LOGIN-EVENTS', 'SECRET-SAAS'], note: 'No UI path opens Account or the login overlay; all saas calls reject.' },
    { id: 'N16', what: 'Device image resources (every device scan)', decision: 'patched', patches: ['P4a', 'P4b'], note: 'Start-up no longer waits up to 20 s for pcenter; bundled images are used.' },
    { id: 'N17', what: 'Firmware OTA (monitor and peripherals)', decision: 'patched', patches: ['P3', 'P9', 'OTA-OFF', 'SECRET-ZAUTH'], note: 'FwUpdate tabs hidden; main also returns OTAEnable:false and the backend refuses DisplayFW_UpdateFirmversion.' },
    { id: 'N18', what: 'Third-party OAuth (Google, Facebook, Twitch, WeChat)', decision: 'patched', patches: ['P1', 'P6', 'LOGIN-EVENTS', 'IPC-ONLINE-EVENTS'], note: 'Login overlay unreachable; deviceSign/oauth/apps reject.' },
    { id: 'N19', what: 'DTS headset server download/install', decision: 'backend', patches: ['P3'], note: 'Headset Setup page is reachable only with a Philips TAG headset, which the monitor-only backend never reports; P3 makes its update check empty.' },
    { id: 'N20', what: 'SmartDesktop (FancyZones) download/install', decision: 'removed', patches: ['P11', 'ROUTE-SMARTDESKTOP'], note: 'Nav hidden, route and chunk removed.' },
    { id: 'N21', what: 'AmbiScape Node runtime download', decision: 'removed', patches: ['P9', 'BULB-OFF', 'ROUTE-BULB'], note: 'Settings tab, bulb device, routes and chunks removed.' },
    { id: 'N22', what: 'Feedback window (log upload)', decision: 'removed', patches: ['P8'], note: 'Button removed and feedback sub-app dropped; main opens no feedback window.' },
    { id: 'N23', what: 'Avatar upload', decision: 'patched', patches: ['P1', 'P5'], note: 'Account page unreachable; saas presignedUrl rejects.' },
    { id: 'N24', what: 'browser-image-compression from jsDelivr (importScripts)', decision: 'patched', patches: ['IMGCOMP-NO-WORKER', 'IMGCOMP-NO-CDN'], note: 'No remote script can load; compression would run on the main thread.' },
    { id: 'N25', what: 'zxing-wasm from fastly.jsdelivr.net', decision: 'removed', patches: ['ROUTE-BULB'], note: 'AmbiScape chunk removed.' },
    { id: 'N26', what: 'Remote avatar and cloud images', decision: 'patched', patches: ['P5'], note: 'CSP img-src is local-only (self, data:, blob:, local:); no avatar UI is reachable.' },
    { id: 'N27', what: 'External links (evnia.philips, licence pages)', decision: 'patched', patches: ['P7', 'NO-EXTERNAL-BROWSER'], note: 'Licence URLs remain as display text only (audit allowlist).' },
    { id: 'N28', what: '/pcenter/config (unused)', decision: 'harmless', patches: ['P2'], note: 'No caller; would be rejected by P2 anyway.' },
    { id: 'N29', what: 'Cloud themes, profiles and macros', decision: 'patched', patches: ['P1', 'P2', 'CLOUD-HOSTS', 'PROFILE-NO-CLOUD-EXPORT', 'PROFILE-NO-CLOUD-IMPORT'], note: 'Local import/export unchanged; cloud rows removed from the Profile page. KeyBind (peripheral macro page) keeps its cloud buttons but is reachable only with a Philips keyboard/mouse, and they need a login that cannot happen.' },
    { id: 'N30', what: 'navigator.onLine detection', decision: 'harmless', patches: [], note: 'Only drives "no network" dialogs of removed features.' },
    { id: 'N31', what: 'Content-Security-Policy', decision: 'patched', patches: [], note: 'Every HTML entry point gets the local-only policy (index.html replaced, notice.html inserted).' },
    { id: 'N32', what: 'GetWifiList (cleartext Wi-Fi passwords)', decision: 'removed', patches: ['ROUTE-BULB'], note: 'Only caller (AmbiScape pairing) removed; the Linux backend does not implement it.' },
    { id: 'N33', what: 'Kestrel on all interfaces, REST, Swagger', decision: 'backend', patches: ['HUB-URL'], note: 'Hub on 127.0.0.1 with a per-launch token; the renderer now connects to 127.0.0.1 with ?k=<token>.' },
    { id: 'N34', what: 'SignalR hub /EvniaHub', decision: 'patched', patches: ['HUB-URL'], note: 'Kept as the only socket (loopback).' },
    { id: 'N35', what: 'Dead .NET HTTP client code', decision: 'n/a', patches: [], note: 'Not ported.' },
    { id: 'N36', what: 'Host network info (dead)', decision: 'n/a', patches: [], note: 'Not ported.' },
    { id: 'N37', what: 'Macro/button "Launch website"', decision: 'backend', patches: [], note: 'Peripheral button functions are not implemented; ButtonFunc keeps only an "http://" input placeholder.' },
    { id: 'N38', what: 'Local IPC and logging', decision: 'n/a', patches: [], note: 'Local only.' },
    { id: 'N39', what: 'Matter controller (LAN/BLE)', decision: 'removed', patches: ['BULB-OFF', 'ROUTE-BULB'], note: 'Not shipped; the renderer never starts the bulb manager.' },
    { id: 'N40', what: 'NSIS installer .NET download (dormant)', decision: 'n/a', patches: [], note: 'Windows installer only.' },
  ],
};
