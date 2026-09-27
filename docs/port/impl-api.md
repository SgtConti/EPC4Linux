# Implementation notes: `api-catalog` (Bridge catalog, `Start`, stubs, contract harness)

Module owner: api-catalog. Sources: `port/src/backend/api/catalog.ts`, `api/system.ts`, `api/stubs.ts`.
Tests: `port/test/unit/api/` (catalog, system, stubs, coverage) and `port/test/contract/` (golden transcript,
comparator, composition, fixtures).

Specs: `docs/re/20-backend-host-tail.md` §1.2 (overload resolution), §2.4-2.5 (notifications), §3 + §3.1 (the
162-overload catalog and the stub details the renderer depends on), §5 (golden transcript), §6 (connected
monitor rules), §7.2 (`Start` timing); `20-enum-valuelist-catalog.md` §5 (full `Profile_GetDeviceData` Tag);
`03-renderer-monitor-pages.md` §5 (page flows). Ground truth: `work/dotnet-clean/Bridge.Lib/Bridge.Lib/Bridge.cs`,
`SystemOper.cs` (Start, the stubbed families, the device dictionary), `CDeviceBase.cs`, `CDeviceDisplayBase.cs`
(obfuscated tree), `FancyZonesOper.cs`, `NotificationDataBase.cs`, `CDevice_PHLDisplay.cs`
(SetOSD/SetSmartImage/SetInputSource and the DeviceData clone, for the flow cases), `DisplayFuncConstraints.cs`,
`Extension_Object.cs` (`ToCloning`); renderer `main-CDosWiM3.js` (MN:190-198 startup, MN:1803-1806
`NotifyDeviceConnectionStatus`).

No `types.ts` or `services.ts` additions. No new dependencies.

---

## 1. Files and public API

| File | Exports |
|---|---|
| `api/catalog.ts` | `BRIDGE_OVERLOADS` (162 frozen `BridgeOverload {index, name, signature, params, line, owner, disposition, renderer}`), `BRIDGE_OVERLOAD_COUNT`, `API_OWNERS`, `overloadKey`, `findOverload`, `overloadsNamed`, `ownerOf`, `overloadsOwnedBy`; audit: `auditRegistrations`, `formatAudit`, `RecordingRegistry`, `dispatcherRegistrations`, `auditDispatcher`, `auditBackend`, `parseNetSignature`; types `ApiOwner`, `Disposition`, `RendererUse`, `Registration`, `RegistrationAudit`, `AuditScope`, `InspectableDispatcher`, `RequestHandlerLike` |
| `api/system.ts` | `systemApi` (ApiModule, 60 s watchdog), `createSystemApi({ startWatchdogMs })`, `START_INIT_ERROR`, `DEFAULT_START_WATCHDOG_MS`, `MAX_START_WATCHDOG_MS`, `NOTIFY_DEVICE_CONNECTION_STATUS`, type `DeviceConnectionStatus` |
| `api/stubs.ts` | `stubsApi` (ApiModule), `STUB_REPLIES`, `StubTexts`, `DISPLAY_DEVICE_TYPE`, `fancyZonesVersionNotInstalled()` |

### 1.1 The catalog

`BRIDGE_OVERLOADS` lists every public `JsonResult` overload of `Bridge.Lib.Bridge` in declaration order: 162
overloads, 157 names (`PHL_SetOSD` ×2, `Macro_GetDetail` ×2, `Theme_GetDevicesBasicInfo` ×3,
`Theme_GetProfileDesc` ×2). `void A_Notification(Notification)` is in Class0's method table but no JSON argument
can match it, so it is not part of the RPC surface (20 §1.2). Parameter types are only `int`, `string`, `bool`;
the widest overloads (`Button_SetKeyboard`, `SetGamePQ`) take 8.

Each overload has exactly one **owner**, the api module family that must register it:

| Owner | Rule | Count | Files |
|---|---|---|---|
| `system` | `Start` | 1 | `api/system.ts` |
| `monitor` | `PHL_*`, `SetGamePQ`, `Device_*`, `Profile_*`, `DisplayFW_*` | 46 | `api/phl.ts`, `device.ts`, `profile.ts`, `displayfw.ts` |
| `theme` | `Theme_*`, `Macro_*`, `Setting_*`, `FactoryReset`, `Comm_GenAppIcon` | 40 | `api/theme.ts`, `macro.ts`, `setting.ts` |
| `ambiglow` | `Effect_*`, `SyncEffect_*`, `AmbiScape_EnableFollowVideo` | 20 | `api/effect.ts`, `sync-effect.ts` |
| `stubs` | everything else | 55 | `api/stubs.ts` |

`DeviceSteup_*` is not `Device_*` and `GetHotKeyState` is not `PHL_*`: both are stubs.

`disposition` is the port's (§3: I implement, S static stub, E error reply), identical to §3 except
`GetWifiList` (S instead of E, §3 below): 54 I / 24 S / 84 E. `renderer` is §3's "called by renderer" column
(68 yes, 72 only from pages the port hides, 22 never).

### 1.2 Auditing registrations

- `auditRegistrations(regs, { owners? })` returns `missing` (in-scope catalog overloads nobody registered),
  `extra` (unknown name, or a signature Bridge does not declare — the renderer's argument types select the
  overload, so a wrong signature changes the vendor `params error` behaviour), `duplicates`, `outOfScope`
  (valid overloads registered although their owner is not audited) and `ok`. `formatAudit()` prints it with
  `#index Name(types) [owner] Bridge.cs:line`.
- `RecordingRegistry` implements `RpcRegistry`, records every registration including duplicates (the real
  `RpcDispatcher` throws on those), optionally forwards to an inner registry, and gives `handler(name, sig)`
  for calling handlers directly in tests.
- `auditDispatcher(dispatcher, scope)` audits a **live** `RpcDispatcher` without invoking any handler: for each
  `functionNames()` entry it dispatches the name with 16 Boolean arguments. No Bridge overload has more than 8
  parameters, so Class0's step 5 answers `params error: <MethodInfo.ToString() of every registered overload>`,
  which `parseNetSignature` turns back into registrations. (Only a non-Bridge registration taking exactly 16
  bools would run; it is reported as extra.)
- `auditBackend(backend, scope)` audits a composed `Backend` through `handleRequest` only (`createBackend` does
  not expose its dispatcher): every catalog name is probed the same way; `functionName: X undefined` counts as
  not registered. It cannot see registrations under names outside the catalog — run the composition's modules
  against a `RecordingRegistry` for those (the coverage test does both).

## 2. `api/system.ts` — `Start`

Vendor (`SystemOper.Start`, SystemOper.cs:107-133): if no scan has completed (`bool_0`), `InitEnviroment()`
(theme store; failure → `Error("InitEnviroment error")`), then the full device scan `smethod_0()` (which catches
everything), then `Succ(true)`; once a scan has completed, `Succ(true)` at once. On the user's machine it took
21.45 s (20 §7.2).

Port:

1. The first `Start` awaits `services.themes.start()` (the InitEnviroment part) and then
   `services.monitors.scan('all')` (enumeration: EDID/SN, DDC probe, capabilities; the full VCP read continues
   in the background inside the driver). Reply: `Succ(true)`, i.e. the golden step 2 bytes
   `{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"…","Tag":true,"FunctionName":"Start","CurrItem":null}`.
2. Two latches per registration: `scanned` (a `scan('all')` succeeded) and `completed` (vendor `bool_0`: the
   theme store is loaded and a scan succeeded after it). Once `completed`, every later Start (renderer
   reconnect, MN:211-221) replies `Succ(true)` without touching any service.
3. Concurrent Starts share one in-flight run (the vendor would have started a second scan, §7.2 item 3).
4. Missing services are tolerated: no `themes` slot, or a `monitors` slot without `scan()`, logs a warning and
   Start still replies `Succ(true)`.
5. A failing scan is logged; the reply is still `Succ(true)` (vendor: `smethod_0` catches, `bool_0` stays
   false), and the next Start scans again.
6. Everything is asynchronous; the hub keeps pinging during a long Start.
7. `startWatchdogMs` is validated like `RpcDispatcher`'s `handlerTimeoutMs`: NaN or more than
   `MAX_START_WATCHDOG_MS` (2 147 483 647, the setTimeout limit — `Infinity` included) throws a `RangeError`
   from `createSystemApi`; 0 or less disables the watchdog. (Node fires out-of-range delays after 1 ms, which
   would make Start answer before the theme store and the scan ran.)

Deviations:

| # | Vendor | Port | Why |
|---|---|---|---|
| D1 | InitEnviroment failure → `Error("InitEnviroment error")` and **no scan** | Same error reply (the renderer tolerates a Start rejection, MN:190-192), but the monitor scan runs anyway. While the theme store keeps failing, later Starts retry **only** `themes.start()` and reply the error again — no rescan once the displays are enumerated. The Start whose theme load succeeds scans once more (vendor order InitEnviroment → `smethod_0`, so the driver reloads with the saved profile) and completes Start | A theme-store failure (e.g. unwritable `~/.config/EvniaServe`) must not hide the monitor from a Linux user; every renderer reconnect calls Start, and re-running DDC discovery each time under the open page would be the port's own regression |
| D2 | Start waits for the scan however long it takes | Watchdog: after `startWatchdogMs` (default 60 s; vendor worst case 21.45 s) Start replies `Succ(true)` and the scan continues; a later Start joins or skips it. When such a **late** run finishes, Start sends `NotifyDeviceConnectionStatus` with Tag `NotificationDataBase {"DeviceType":100000,"Data":<connectList() non-empty>}` (key order from NotificationDataBase.cs; envelope `err_msg:null`, `RequestId:null`, §2.5) | The renderer has no client timeout (02 §4.6): a hung scan would leave the Startup screen forever. After the watchdog reply the renderer fetches `Device_GetConnectList` at once and stores it (MN:197-198), possibly before the display is enumerated; the notification's subscriber (MN:1803-1806; 02 §6, 03 §7) re-fetches `Device_GetConnectList` and refreshes the cards. The vendor raises this notification only from peripheral drivers (20 §2.4 #17). `createSystemApi({ startWatchdogMs: 0 })` restores the vendor behaviour |

**Contracts this module relies on (integration must honour them):**

- `ThemeStore.start()` must be **idempotent**: the backend lifecycle (`backend.start()`) already calls it, and
  the first `Start` request calls it again (vendor: InitEnviroment runs inside Start). A second call after a
  successful load must resolve without reloading; after a failed load it should retry. The unit test
  "in a composed backend…" documents the double call.
- `MonitorManager.scan('all')` must be callable after `monitors.start()` and must resolve once enumeration is
  done (not after the full VCP read), never block the event loop, and reject (not hang) on failure.
- **`Device_GetConnectList` (api/device.ts) must answer from the current enumeration and never await the scan
  queue** (or `DisplayDevice.ready()`). The renderer's startup `S()` awaits it without a catch
  (20 §6 item 1); if it waited for a scan still running after the Start watchdog, the dispatcher's 120 s
  handler watchdog would answer with an error and startup would hang for good. Today's `deviceApi` honours this
  (`connectList()` is synchronous); `system.test.ts` "D2 end to end" checks it whenever `api/device.ts` exists.

## 3. `api/stubs.ts` — the 55 stub overloads

Registered by iterating `overloadsOwnedBy('stubs')`, so coverage is exact by construction (a missing reply
entry throws at registration). Every reply is what the vendor answers when the device family is absent, read
from SystemOper.cs:

| Functions | Vendor path | Port reply |
|---|---|---|
| `Button_*` (6), `DTS_*` (11), `Keyboard_*` (4), `Mouse_BindSmartDPIToButton` | `GetDeviceByType<IButton/IDTS/IKeyboard/IMouse>` is null → explicit `Error` | E `No driver found!` |
| `DeviceSteup_*` (11), the other `Mouse_*` (11) | `GetDeviceByType<…>(device)?.X()` is null → Class0 | E `functionName: <fn>  return null obj` (two spaces; `DispatchErrors.nullResult`) |
| `CanEnterPairing`, `EnterPairing` | `GetDeviceByType<IDevice>`: null → `No driver found!`; the display driver → `CDeviceBase.Notimplemented()` | E `operation is not implemented` when `device == 100000` **and** the display driver is connected (`monitors.connectList()` non-empty), else E `No driver found!` |
| `GetPairDevices` | sums the successful pair lists; the display's is Notimplemented | S `[]` (golden step 15, byte-exact) |
| `ModifierKeyListenerEnable` | sets the hook flag, `Succ(true)` | S `true` (no global key hook on Linux) |
| `GetHotKeyState` | display hotkey table (never filled, 12 §3.7) or `IsHotkeyOccupied` | S `false` |
| `FancyZones_GetVersion` | "not installed" model | S `{"StrVersion":"V0.0.0.0","Version":0,"DP_DeviceType":"SmartDesktop","DP_ComponentID":"Philips_SmartDesktop"}` (field order: fields, then ExternInfoBase properties) |
| `FancyZones_Enable/StartEditor/GetData/SetSetting` | PowerToys FancyZones | E `not supported` (§3; SmartDesktop hidden by 02 P11) |
| `GetWifiList` | `Succ(List<WifiItem>)` including **saved Wi-Fi passwords** (`netsh wlan show profile key=clear`) | S `[]`; never reads host data |

The display driver implements only `IDisplay, IEffect, IProfile, IDevice` (`work/dotnet/…/CDeviceDisplayBase.cs:17`),
so the "no driver" texts also hold for `device = 100000`. Tags are built fresh per call.

"Connected" for the pairing calls: the vendor keeps the display driver in `SystemOper.concurrentDictionary_0`
only after `ConnectionCkecked()` succeeded and removes it when the check fails (SystemOper.cs:706-717, 846-870).
`MonitorManager.connectList()` is non-empty exactly then; `displays()` also lists discovered displays that are
not connected or not supported, so it is not used.

Deviations from 20 §3: `GetWifiList` is S `[]` instead of E `not supported` (task requirement: empty list; it is
also what the vendor returns on a host without networks, and the renderer's wrapper `.filter`s the Tag,
styles-DAnQi2A8.js:29943-29951). `CanEnterPairing`/`EnterPairing` distinguish the connected display
(`operation is not implemented`, the vendor's actual reply) from other device types; §3 lists only
`No driver found!`. Both are only reachable from hidden pages.

## 4. Tests

```
MSYS_NO_PATHCONV=1 docker run --rm -v "C:\path\to\repo:/repo" -w /repo/port evnia-port-dev \
  bash -c 'node --test "test/unit/api/**/*.test.ts" "test/contract/**/*.test.ts"'
```

51 tests at the end of this wave: 46 pass, 3 `todo`, 2 skipped, because the ambiglow service and
`api/effect.ts` / `api/sync-effect.ts` did not exist yet (§4.2). They exist now (`impl-ambiglow.md`), the
integration wave wired them (`impl-integration.md`), and the `todo`s and skips are gone.

| File | What it checks |
|---|---|
| `unit/api/catalog.test.ts` | 162 entries, order, uniqueness, frozen; owner/disposition/renderer counts; row-by-row equality with Bridge.cs (skipped without `work/`) and with the §3 table (skipped without `docs/re`); `parseNetSignature` ∘ `netSignature`; audit, `RecordingRegistry`, `auditDispatcher`, `auditBackend` (no handler runs) |
| `unit/api/system.test.ts` | golden step 2 bytes; order themes → scan; idempotence; shared in-flight run; D1 (error + scan, no rescan while the store keeps failing, one scan after recovery, rescan after a failed scan); failing scan; tolerated slots; watchdog on/off; the late-run `NotifyDeviceConnectionStatus` bytes (`Data` true/false) and none for a timely run; `RangeError` for `Infinity`/NaN/> 2³¹-1; composed backend; **D2 end to end** with the real `api/device.ts` (if present): after a watchdog reply `Device_GetConnectList` answers `[]` at once while the scan runs, the late run notifies, the re-fetch lists the display |
| `unit/api/stubs.test.ts` | exact coverage of the 55 stubs; every stub's envelope; golden step 15 and the logged `FancyZones_GetVersion` byte-exact; two-space null text; pairing: no service / no display / **discovered but not connected** → `No driver found!`, connected display → `operation is not implemented`; vendor `params error` signatures |
| `unit/api/coverage.test.ts` | imports every api/ module file listed in `helpers.ts API_MODULE_FILES` and runs it against a `RecordingRegistry` with inert services. Strict: files load and export a module; **no `.ts` file in `src/backend/api/` outside `API_MODULE_FILES` + `catalog.ts`** (such a file would never be imported); no extra/duplicate registrations; every registration made by its owner's family. Per owner and for the whole surface: "registered exactly once" — `todo` only while an owner's files are missing **and** its overloads are incomplete (none since the integration wave). **Production composition** (integration wave, strict): `API_MODULES` recorded (missing/extra/duplicates, exactly the api/ modules in owner order) and three live production backends probed with `auditBackend` (`impl-integration.md` §2) |
| `contract/golden-transcript.test.ts` | fixture provenance (re-derived from the docs and the log, sha256 of the §5 Tag, and the raw key order of every documented reply and of the §5 Tag); comparator semantics; integer-like key order (tokenizer, `stringifyOrdered`, error cases); steps 2 and 15 byte-exact on a minimal backend; a **harness self-check** (a module answering like Windows passes, a type change / a `null` FwVersion / a missing N1 fail); the replay, wiring, flows and ENE-present scenario against the **production** composition (integration wave; the cases added then are listed in `impl-integration.md` §4) |

### 4.1 Contract harness

- **Fixtures** (`test/contract/fixtures/`): `golden-2026-09-26.json` (20 steps: §5 steps 2-18 plus the
  follow-ups 16.1-16.3 at LOG:1079-1082; verbatim requests from the log, synthetic ids for 17/18; the N0
  notification; the vendor's step 4 reply for reference) and `profile-getdevicedata-tag.json` (20-enum §5,
  29403 bytes compact, sha256 `91e8a59c…5a45`). The provenance test re-derives both from the documents,
  values and raw key order.
- **Comparison** (`compare.ts`): exact keys, key order, JSON types, array lengths and values; when nothing was
  tolerated the reply bytes must equal the expected value re-serialized in the fixture's raw key order
  (`stringifyOrdered`).
  - **Integer-like keys.** `JSON.parse`/`Object.keys` always put integer-like keys (`"33"`, `"34"`) first and
    ascending, while Newtonsoft writes a `Dictionary<int,…>` (`ModuleSmartImage(HDR).SubSmartImages`, keyed by
    the OP_DC value) in insertion order. `jsonKeyOrders(text)` is an order-preserving tokenizer that returns
    every object's key order by path; `compareJson(…, { actual, expected })` compares those raw orders, and
    `golden.ts` carries the raw orders of every fixture reply (`replyOrder`, with `$fixture` Tags spliced in)
    and notification (`notificationOrders`). Every assertion on a backend reply passes the reply text's
    orders; `compareJson` on parsed values alone (without orders) cannot see the order of integer-like keys.
  - **Environment-dependent paths**, the only tolerated ones:
    1. `Tag[i].ExtDeviceInfo.DisplayList[j].DeviceName` — any string (Windows GDI `\\.\DISPLAY1`; the renderer
       never reads it, 20 §9 Q2);
    2. `…DispalyData.MonitorEDIDInfo_T.{ScreenSize, DisplayGamma, Red/Green/BlueChromaticity, WhitePoint}` —
       equal up to the decimal separator (the user's locale writes `,`; Linux follows LC_NUMERIC, 20-monitor-io
       D5).
    Everything else is strict, including `DispalyData.Monitor{Resolution,Frequency,Orientation}` (the test
    host's `getDisplayMode` returns the user's `3440x1440/175Hz/0°`) and `WorkingTime`/`TimeAfterPixelRefresh`
    (-1).
- **Notifications**: until the first `PHL_GetConstraints`, zero or more copies of N0 are allowed anywhere
  (the port's Start replies before the full VCP read; the driver's constraint recheck may raise N0 later —
  harmless, N0 = N1). Steps 13 and 16.3 require exactly N1 (= N0) before the reply. All other steps: none.
- **Composition** (`compose.ts`, `composeMockBackend({ ene? })`). *Integration wave:* it now builds the
  **production** backend, `createDefaultBackend({host, mockMonitor: '34M2C8600/no-ene' | '34M2C8600',
  noHardware: true})`, with the user's `EvniaServe/` and `evnia/` fixtures copied to a temp dir and
  `resourcesDir = build/vendor-data` (`npm run import-ui`, the only skip reason left). The golden session's
  hardware state (§5 "Setup": ENE absent) is the `34M2C8600/no-ene` mock variant; the late-bound ambiglow
  stand-in, the discovery wrapper that unplugged the simulated ENE and the API-module fallback selection of this
  wave are gone, and the wiring check reads `services.ambiglow.display` (`impl-integration.md` §4).
- **Composed checks** (on top of the 20 golden steps and their notifications):
  - after step 2: no ENE on the fake USB bus, and the current display `AU00000000001` has no `ene`;
  - after the transcript: the monitor manager attached the current display to the ambiglow service
    (`services.ambiglow.display`) and `checkEne` answered `""`;
  - flows (03 §5), all comparisons with raw key orders:
    - `PHL_SetOSD("OP_10_Luminance", 80/100)` → the HDR sub-module's AttributeInfo with the new Value, no
      notification; then the **whole** `Profile_GetDeviceData` Tag must equal the fixture with exactly the vendor's
      changes (CDevice_PHLDisplay.cs:1622-1656): HDR `CurSubSmartImage.OP_10_Luminance.Value = 80`, and
      `ModuleSmartImage.SubSmartImages` gains key `"33"` = `ModuleSmartImage.CurSubSmartImage` (the vendor always
      stores the SDR sub-module, also in HDR — 06 §7.2); `ModuleSmartImageHDR.SubSmartImages["33"]` keeps 100,
      because `DeviceData` is a JSON clone of `CacheDeviceData` (CDevice_PHLDisplay.cs:564, `ToCloning`);
    - `PHL_SetOSD("EXT_OP_E2A0_40_AdaptiveSync", 0/1)` → AttributeInfo + exactly one
      `NotifyUIDisplayFuncConstraintsChange` during the call (MBR 2→1, MBRSync 1→2 derived from
      DisplayFuncConstraints.cs:125-294), then back to N0;
    - `PHL_SetSmartImage(34/33)` → `{Item1: OP_DC AttributeInfo, Item2: ModuleSmartImageHDR}`, `SubSmartImages`
      raw key order `["33","34"]` (insertion order, CDevice_PHLDisplay.cs:1692-1695), no notification;
    - `PHL_SetInputSource(15,34,0,0,0)` → `DisplayModuleInput` in declaration order, lists and
      `InputSourceInfo {Mode,Size,Location,PIPPBPSource,InputSource}` exact, and `OP_60_InputSource.Value = 8719`:
      the stored InputSourceInfo is already (15,34,0,0,0), so the vendor takes the else-if branch and writes and
      returns `BitConverter.ToInt32([15,34,0,0]) = 15 | 34<<8` (CDevice_PHLDisplay.cs:1925-1933);
    - a final `PHL_GetConstraints` still yields N1 = N0.
  - **ENE present** (`{ ene: true }`, a second backend): Start bytes; the discovered display carries the ENE;
    with the production wiring the **first** `Profile_GetDeviceData` already has `ENEEffectEnable: true` (vendor
    `method_14` through `checkEne`; the Monitor shell then calls `Effect_GetMenu`, Monitor-D4qz4RBn.js:42-49),
    followed by the Effect_* round trips of `impl-integration.md` §4.

### 4.2 Validation against the real services (this wave; superseded by the integration wave, which runs every composed test against the production composition)

The composed tests skip today only because `createAmbiglowService` and `api/effect.ts` / `api/sync-effect.ts`
are missing. To validate the harness, it was run once (temporary scratch hook, not committed) with the real
`createThemeStore` + `createMonitorManager`, all existing api/ modules, and a stand-in ambiglow (the 20
ambiglow overloads answering golden steps 6/7 with the Windows replies; `attach` calling
`setEneModel('MOCK-ENE')` when the display has an ENE):

- all 20 golden steps, the ENE-absence and wiring checks, all five flow cases (including the stricter
  luminance, input-source and SubSmartImages-order assertions) and the ENE-present scenario passed (35/35);
- with the old wiring re-introduced (monitor manager created without `ambiglow`), the wiring check and the
  ENE-present scenario failed (`timed out … waiting for AmbiglowService.attach`);
- with the ENE left plugged in, the ENE-absence check and steps 11, 12, 16.2 failed
  (`Tag.ENEEffectEnable: true, expected false`), as did step 18, the wiring check ("attached without an ENE")
  and the luminance and AdaptiveSync flow cases.

## 5. What the integration wave must do

*Status: done by the integration wave (items 1, 2, 4, 5); item 3 stays the convention. See `impl-integration.md` §3.*

1. **`index.ts` `API_MODULES`**: replace `systemMinimalApi` with
   `[systemApi, stubsApi, phl…, device…, profile…, displayfw…, theme…, macro…, setting…, effect…, syncEffect…]`.
   `system-minimal.ts` also registers `Device_GetConnectList` and `Setting_GlobalData`, which the monitor and
   theme modules own; keeping both would throw "already registered". The coverage test
   "the production composition (index.ts API_MODULES)…" turns strict as soon as the ambiglow api files exist
   and fails until this is done.
2. **Service wiring in the composition root**: pass the ambiglow service to the monitor manager — create it
   first, or hand the manager a late-bound stand-in as `compose.ts` does; `createMonitorManager(core, {themes})`
   silently never calls `AmbiglowService.attach` and the ENE is never reported. Electron main currently calls
   `createBackend` without a `services` factory at all (`src/main/backend-host.ts`).
3. **api/ file convention** (used by the coverage and contract tests): each family file exports its ApiModule
   as an exported function whose name ends in `Api` (e.g. `phlApi`, `syncEffectApi`; `create*` factories are
   ignored). Register every overload of the owner with the exact Bridge signature; `coverage.test.ts` names
   anything missing, extra, duplicated or registered by the wrong family. A new api/ file (another split) must
   be added to `API_MODULE_FILES` in `test/unit/api/helpers.ts` with its owner — the coverage test fails until
   it is; the contract composition picks it up either way.
4. Honour the contracts in §2 (idempotent `ThemeStore.start()`, `scan('all')` = enumeration only,
   `Device_GetConnectList` never waits for the scan).
5. If `createAmbiglowService` takes other arguments than `(core, { themes, monitors })`, adapt `buildServices`
   in `compose.ts` only. Then run `test/contract` in Docker: the skipped composed tests run the full transcript,
   the flows and the ENE scenario; the `todo`s of `coverage.test.ts` must turn into passes (drop nothing from
   the lists).

## 6. Limitations

- The Start latches live in the api module; after `backend.stop()` + `backend.start()` a completed Start
  replies at once without rescanning. Electron main creates one backend per app lifetime. (Integration wave:
  the default composition re-enumerates the displays at the end of such a restart, `impl-integration.md` §2.3.)
- The D2 recovery is best effort: the `NotifyDeviceConnectionStatus` subscriber is registered when the Home
  shell mounts (MN:1803) and ignores the notification while `shieldPeripheralChange` is set. If a late run
  finishes after `S()` fetched the list but before Home subscribed, the renderer keeps the empty list until the
  next hotplug, `Device_Rescan` or reconnect. The default 60 s watchdog is about 3× the vendor's worst
  observed Start, so this needs a scan that is already pathologically slow.
- `startWatchdogMs` should stay below the dispatcher's handler watchdog (`handlerTimeoutMs`, default 120 s),
  otherwise the dispatcher answers Start with its timeout error first.
- (Resolved by the integration wave: the ENE-present scenario runs against the real ambiglow service.)
- `auditDispatcher` needs the concrete `RpcDispatcher` (`functionNames()` + `dispatch()`); `auditBackend` sees
  only catalog names.
