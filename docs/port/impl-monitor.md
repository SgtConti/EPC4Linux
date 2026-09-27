# Implementation notes: `monitor` (Philips display driver and the monitor-facing API)

Module owner: monitor. Sources: `port/src/backend/monitor/**`, `port/src/backend/api/{phl,device,profile,displayfw}.ts`. Tests: `port/test/unit/monitor/` (73 tests, about 2 s):

```
MSYS_NO_PATHCONV=1 docker run --rm -v "C:\path\to\repo:/repo" -w /repo/port evnia-port-dev \
  bash -c 'node --test "test/unit/monitor/*.test.ts"'
```

This module ports the vendor classes `CDevice_PHLDisplay`, `PHLDisplay_Oper` (driver part), `GClass0`/`GClass3` (profile and display base classes), `Display`/`DataOSD` (capability string, SupportOSDList, VCP I/O), `DisplayFuncConstraints` and the `T_PHLDisplay_Profile` entity tree. It also answers every Bridge overload of the `monitor` family in `api/catalog.ts`: 23 `PHL_*` overloads, `SetGamePQ`, 7 `Device_*`, 9 `Profile_*` and 6 `DisplayFW_*`.

Specs used: 20-backend-host-tail (§2.4-2.6, §3, §5, §6, §7.2), 20-enum-valuelist-catalog (the whole report), 20-theme-profile-engine (§4-§8), 20-monitor-io-linux-consolidation (§2-§5), 06 §7-§9, 12 §3, 03 §5. The decompiled sources were the ground truth wherever they differed from a report: `CDevice_PHLDisplay.cs`, `DataOSD.cs`, `Display.cs`, `Extension_AttributeInfo.cs`, `GClass0.cs`, `GClass3.cs`, `DisplayFuncConstraints.cs`, `SystemOper.cs`, `PHLDisplayFW.cs` and the entity classes.

**Byte-exactness, verified by tests:**
- The user's `Default.pcenter` ProfileContent round-trips byte for byte: parse, then `purify()`, gives 10 812 bytes with the documented sha256.
- The loaded simulated 34M2C8600 serializes to the 20-enum §5 Tag byte for byte in `uiProfileGet` mode (29 403 bytes, sha256 `91e8a59c…`). Its profile projection equals the stored ProfileContent.
- The constraints equal 20-enum §6.5, and N0/N1 equal 20-backend-host-tail §2.5 (1925 characters).
- Golden transcript steps 3, 11, 12 and 13 match through the real dispatcher, on the golden session's hardware (no ENE on USB, an ambiglow fake that answers `checkEne`). Step 3 differs only in `DeviceName`.
- `SubSmartImages` (`Dictionary<int, …>`) keeps the vendor's insertion order, e.g. `"3","4","1"`, in replies, `.pcenter` content, parse and clone (§2.6).

---

## 1. Files and public API

| File | Exports | Vendor / spec |
|---|---|---|
| `monitor/model/enums.ts` | `ENUMS` (76 frozen tables: Name, Text, Value, Unbind), `EnumMember`, `EnumName` | Generated from 20-enum §2. `value-lists.test.ts` checks it member by member against the catalog |
| `monitor/model/enum-items.ts` | `EnumItem`, `enumItem`, `getDatas` (bound members, sorted), `getItem`, `enumValue`, `memberOf`, `isBoundValue`, `opcodeOf`/`opcodeName`, `isStandardName`/`isExternName`, `isBoundStandardCode`/`isBoundExternCode` | `Extension_Enum`, `DataOSD.StandardList`/`E2A0_ExternList` |
| `monitor/model/json-populate.ts` | Newtonsoft populate helpers: `member` (case-insensitive), `toInt`, `asInt32` (`object.ToInt32()`), `parseJsonObject`; key order of integer-keyed objects: `parseJsonOrdered` (JSON.parse plus source order), `setKeyOrder`, `orderedEntries` | `JsonDeserialize` with `NullValueHandling.Ignore`; 12 App. A |
| `monitor/model/attribute-info.ts` | `AttributeInfo` (`of(code)`, `IsAvailable`, `setErrMsg`, `resetErrMsg`, `clone`, `populate`, `toJson(mode)`), `parseEnumItem`, `populateEnumItem` | `ENT/AttributeInfo.cs`; 20-enum §1.5 |
| `monitor/model/modules.ts` | `SubModuleSmartImage(HDR)`, `DisplayModuleSmartImage(HDR)` (with `SubSmartImages: Map<number, …>`), `DisplayModuleGameMode`, `DisplayModuleAmbiglow`, `DisplayInputSourceInfo`, `DisplayModuleInput`, `EqItem`, `DisplayModuleAudio`, `DisplayModuleSystem`, `DisplayModuleSetup`, `attributesOf`, `attributeByName` | `OPT/DisplayModule*.cs`, `SubModule*.cs`; 20-enum §3 |
| `monitor/model/effect.ts` | `RGB`, `DisplayEffectDetailInfo`, `DisplayEffectInfo` (`EffectDetail` getter, `default(model)`, `isComplete`, `setEffect`), `DISPLAY_EFFECTS` | `OPT/DisplayEffectInfo.cs`, `ENT/BaseEffect*.cs`; 20-enum §6.3/§6.4 |
| `monitor/model/display-data.ts` | `DispalyOtherInfo`, `DisplayEdidInfo`, `EDID_INFO_KEYS`, `edidInfoFrom` | `OPT/DispalyOtherInfo.cs`, `PB/DisplayEDIDInfo.cs`; 20-monitor-io §3 |
| `monitor/model/profile.ts` | `T_PHLDisplay_Profile` (`parse`, `populate`, `clone` = ToCloning, `purify` = PurifyProfile, `toJson`), `EQUIPMENT_DISPLAY`, `DEVICE_TYPE_DISPLAY` | `OPT/T_PHLDisplay_Profile.cs` |
| `monitor/model/value-lists.ts` | `buildSupportOsdList` (DataOSD.InitDisplayInfo), `globalValueList`, `capsFilter` (smethod_3), `capsOrder` (smethod_4), `supportedAttribute` (GetAttributeInfo), `pipPbpTable` (PIPPBPEnable), `resetSmartImageValue` | `PBASE/DataOSD.cs`; 20-enum §1 |
| `monitor/model/constraints.ts` | `DisplayFuncConstraints` (`recheck(profile, pipTable)` returns "changed", `state(code)`, `toJson`), `CONSTRAINT_CODES`, `parseFrequency` | `OPT/DisplayFuncConstraints.cs`; 06 §8 |
| `monitor/model/device-info.ts` | `DeviceDictionary` (PCenter_DeviceInfo.json and MonitorInfo.json: `load`, `displayInfo`, `supportsModel`), `DISPLAY_DEVICE_RECORD`, `displayDeviceInfo`, `UIDisplayInfo`, `ExternDispalyInfo`, `DeviceInfo` | `DictMgr`, `CDevice_PHLDisplay.GetDeviceInfo`; 20-backend-host-tail §5 step 3 |
| `monitor/op-queue.ts` | `OpQueue`: a per-display single-flight queue, re-entrant through AsyncLocalStorage (`run`, `inside`, `outside`, `busy`) | 20-monitor-io §2.4 (D2) |
| `monitor/display.ts` | `PhlDisplay` (implements `DisplayDevice` and `ProfileParticipant`), `PhlDisplayOptions` (incl. the `checkEne` hook), `NOTIFY_CONSTRAINTS`, `NOTIFY_EFFECT`, `INVOCATION_FAILED`, `CHECK_ENE_TIMEOUT_MS` | `CDevice_PHLDisplay`, `GClass0`, `GClass3`, `Display` |
| `monitor/manager.ts` | `MonitorManagerImpl` (implements `MonitorManager`), `createMonitorManager(core, slots, options?)`, `MonitorManagerOptions`, `MockHardware`, `DISPLAY_SETTLE_MS` | SystemOper scan, GClass3 connection handling |
| `monitor/api-support.ts` | `nullObj`, `monitorsOf`, `connectedDisplay`, `withDisplay`, `detectDisplays`, `rescan` | SystemOper's `GetDeviceByType<IDisplay>(…)?.X()` dispatch |
| `api/phl.ts` | `phlApi` | Bridge.cs:199-321 |
| `api/device.ts` | `deviceApi`, `NO_DRIVER` | Bridge.cs:94-142 |
| `api/profile.ts` | `profileApi` | Bridge.cs:669-712 |
| `api/displayfw.ts` | `displayFwApi`, `FW_UPDATE_UNSUPPORTED` | Bridge.cs:324-352 |

`PhlDisplay` members beyond `DisplayDevice`:
- **Getters:** `connected` (bConnection), `isSupport`, `loaded`, `capabilities`, `fwVersion`, `constraints`, `eneModel`, `deviceName`.
- **Methods:** `uiInfo()`, `connect({ load? })` (fast connect; the background load unless `load: false`), `load()` (start the load of a connected, unloaded display), `reconnect()`, `rebind()`, `reprobe()`, `setEneDevice()`, `markDisconnected()`, `close()`, `exclusiveRaw()`.
- **The PHL operations, each returning a `JsonResult`:** `reload`, `setOsd`, `setSmartImage`, `resetSmartImage`, `setColorPreset`, `switchSmartFrame`, `setSmartFrameSize`, `setInputSource`, `swapPipPbp`, `setAudioEq`, `getConstraints`, `setGamePQ`, `profileAction`, `reset(needSave)`.

`MonitorManagerImpl` members beyond `MonitorManager`: `detectDisplays()` (the 5 s settle, then a display scan), `rescan()` (capability-cache reset, then a full scan), `deviceInfo()`, `bindAmbiglow(service)` and `mockHardware`.

### 1.1 Additions to `services.ts` (appended to `DisplayDevice` and `AmbiglowService`; nothing changed or removed)

| Member | Why |
|---|---|
| `DisplayDevice.exclusive<T>(fn): Promise<T>` | The ambiglow service's DDC sequences (Effect_Enable/Effect_Reset without ENE, idle lights-off `EffectEnableTemp`) must not interleave with PHL_* sequences (D2). The call is re-entrant |
| `DisplayDevice.settingsChanged(): Promise<void>` | After an `Effect_*` change made through `profile()`: `RecheckFuncConstraints` (which sends the notification if the state changed) and `SaveProfile`, as the vendor does in `EffectEnable`/`EffectReset` |
| `DisplayDevice.setEneModel(model): Promise<void>` | The vendor keeps ENE presence in the display driver (`string_0`/`bool_2`, `method_14`/`method_15`). It decides `ENEEffectEnable` and the `EffectInfo` default of every load. The ambiglow service reports plug/unplug here (USB changes) |
| `AmbiglowService.checkEne?(display): Promise<string>` (optional) | The vendor runs `method_14` (ENE check) at the top of every full read (`method_4`, PHL/…:328), so the first `Profile_GetDeviceData` already has `ENEEffectEnable: true` when an ENE is plugged in (20-backend-host-tail §6 item 4). The display awaits this hook at that point (bounded by `CHECK_ENE_TIMEOUT_MS`, 5 s). It runs with the display's queue held: it must not await `display.ready()`; `display.exclusive()` runs inline |

---

## 2. Behaviour

### 2.1 Connect and load (20-backend-host-tail §7.2, 06 §7.1, 20-monitor-io §2.3)

1. **`connect()`** is the fast part and runs inside the op queue:
   - `DdcChannelImpl.probe()` runs on all transports (USB-DDC first, then i2c-dev). No supported transport means `isSupport = false`, and the display is not connected.
   - Capability string (`Display.InitDisplayVcpCode`):
     - Firmware version: `FE E1 E6` on USB. On i2c the vendor order is VCP `C9` with max 201 first, then `FE E1 E6`.
     - Key: `capCacheKey(version, VCP 60)`, e.g. `v1.01_0f`. Lookup in `CapabilityCache(<serveDataDir>/Config/data.json)`.
     - On a miss, `channel.capabilities()` is read. It is saved only when `analyseVcpString` accepts it.
   - `buildSupportOsdList` builds the global attribute list. `connected` = supported transport **and** an analysable string, as `bConnection` does.
   - This is all that `Device_GetConnectList` needs. It takes about 1-2 s on real hardware with a warm cache.
2. **The background load** is queued right after `connect()` of the **current** display only (the manager passes `load: false` for the others; `load()` starts it when a display becomes current). `ready()` resolves when it is done and never rejects.
   - **`method_14`** first (PHL/…:328): the `checkEne` hook (the manager wires it to `AmbiglowService.checkEne`) is awaited and gives the ENE model, `''` for none. A throwing hook means no usable ENE (the vendor's `Plug()` failure → `method_15`). No hook, a `null` answer or no answer within `CHECK_ENE_TIMEOUT_MS` keeps the model last reported through `setEneModel`.
   - **`method_4`**, the full read into CacheDeviceData:
     - EDID strings via `edidDisplayStrings` (decimal separator per D5; tests pin `,`).
     - Mode strings from `host.getDisplayMode(discovered)`, or `""` when there is no answer.
     - DC read, then **IsSmartImageHDR by policy P1**: the DC value is a bound `SmartImageHDR_E` member (D8; a failed read gives `false`).
     - Items split (Intersect/Except with EnumItemCompare semantics), then the HDR or SDR sub-module read and `SubSmartImages[DC]`.
     - GameMode, then the DualResolution split. It trims only when Overclock is available (20-enum §8 item 3).
     - Ambiglow. With an ENE model: `ENEEffectEnable = true`, `EffectInfo = DisplayEffectInfo.Default`, the DDC state is left as read. Without ENE: `EffectEnable = E2A019 available && ≠ 0`, and Off is shown as StaticMode (7).
     - Input: lists, the 0x60 byte split with the PIP default 34, then 47. When F7 has a table, A5 is replaced by it and EC is split.
     - Audio, and the EQ loop through the **global** E2A001/E2A039: write the band, 100 ms, read the gain.
     - System, Setup, `HasUSBSetting`, the OLED timers, and the removal of `UHD120Hz` on DP/USB-C inputs.
   - **`DeviceDataCheck`**: stored content from `themes.getStoredContent(desc)`, else `GetDefaultData()` (CacheDeviceData with a fresh EffectInfo). Then `ParameterToDevice(bForce:false, needSave:true)`.
     - **This never writes a stored value to the monitor.** The only writes during a load are the five EQ band selects (asserted in `display-ops.test.ts`, also with an ENE).
     - Without ENE, EffectInfo is copied from the stored profile. That is why the Tag shows FollowVideo. With an ENE the stored EffectInfo is kept when it is complete (method_12 ENE branch), so the Tag shows FollowVideo too.
   - `RecheckFuncConstraints` runs next. N0 goes out because the state differs from the constructor's all-1 state.
   - The profile is saved last, **unless** an `applyProfileContent` or `resetToFactory` is already waiting for this load. That call is a theme switch or reset that arrived during the load; the store saves after it, and this load read the very section it is about to apply, so saving the not-yet-switched monitor state into it first would be wrong.
3. **Ops wait for the load** automatically: every public operation runs `await ready()`, then the op queue. `Profile_GetDeviceData`, `PHL_SwitchDisplay` and `PHL_Rescan` also await `ready()` before replying. This includes `applyProfileContent` and `resetToFactory`: the display is a theme participant from its fast connect on (§2.4), so a `Theme_Switch`, `Theme_SwitchApp` (CheckTopApp is armed right after `Start`), `Theme_ResetCurProfile` or `FactoryReset` during the 11-18 s first load is applied after it.

### 2.2 Operations (06 §7; exact frames and sleeps are asserted in `display-ops.test.ts`)

| Bridge | Writes (in order) | Driver sleeps | Recheck / save |
|---|---|---|---|
| `PHL_SetOSD(s,i)` | the matching attribute (SmartImage sub-module of the current HDR/SDR state, then GameMode, Ambiglow, Input, Audio, System, Setup), only if available | – | yes / yes |
| `PHL_SetSmartImage(v)` | DC (only if it differs), then re-read of the sub-module for `v` | 1000 | yes / yes |
| `PHL_ResetSmartImage(v)` | E2A042 = reset code (`GetResetSmartImageValue`), then re-read | 1000 | yes / yes |
| `PHL_SetColorPreset(v)` | 0x14; UserRGB (11) also reads 16/18/1A | 50 (UserRGB only) | no / yes |
| `PHL_SwitchSmartFrame(v)` | E2A008; poll E2A00A until max 100 (≤10×); read 0B, 09, 0C, 0D | 100, [1000×n], 100×4 | yes / yes |
| `PHL_SetSmartFrameSize(v)` | E2A009; read 0C, 0D | 1000, 100 | no / yes |
| `PHL_SetInputSource(…)` | if the PIP parameters changed and A5 is available: A5, EC, 60, A4=FFFF; else, if 60 changed: 60, A4=FFFF | 100 between writes | yes / yes |
| `PHL_SwrapPIPPBP()` | only with PIP/PBP on: F6=1, then re-read 0x60 | 5000 | yes / yes |
| `PHL_SetAudioEQ(i,v)` | E2A001=i, E2A039=v | 100 | no / yes |
| `Profile_Reset` / `resetToFactory` | 0x04=1, then the full re-read (with the EQ loop) | 5000, then 100×bands | yes / yes (no for `resetToFactory`) |
| theme switch (`applyProfileContent`) | CacheDeviceData rebased on DeviceData (deviation 18), then method_10: DC (+1000 ms, where it differs from what the monitor was last given) and the SmartImage or HDR group, forced; method_12: E2A019 (+1A-1E where they differ), or E2A019=0 | 1000 on a DC change | yes / no (the store saves) |

- **Saving.** Saves call `themes.saveParticipant(this)` and are **not awaited**. The real store debounces them by 250 ms and purifies the DeviceData current at that moment, so a reply never waits for a file write.
- **Failed writes** are logged and not reported, like the vendor (`Display.SetStandardValue`'s result is ignored).
- **Failed reads** set `err_code 9` on the attribute.

### 2.3 Notifications (20-backend-host-tail §2.4-2.5)

- **`NotifyUIDisplayFuncConstraintsChange`**:
  - after every recheck that changed the state (N0 at load);
  - unconditionally from `PHL_GetConstraints`, before its reply (N1). The golden test asserts the wire order `Notification`, then `GetTaskAsync`.
- **`NotifyUIDisplayEffectChange`** from `setEneModel` when the ENE state changed (plug when it was not in use, loss when it was), using the **named keys** `{ENEEnable, EffectInfo, ModuleAmbiglow}` that the renderer reads (`Monitor-D4qz4RBn.js:85-91` tests `a.ENEEnable`; 20-backend-host-tail §2.5) first, followed by the vendor's ValueTuple keys `Item1..3` with the same values (12 §7 port plan item 7; added in the ambiglow fix pass, impl-ambiglow §2.7). The vendor's `Item1..3` alone would throw in the renderer.
- `setEneModel` details:
  - before and during the first load, the model is recorded at once, so that load uses it (when no `checkEne` answers);
  - the change is mirrored into CacheDeviceData (`ENEEffectEnable` and `EffectInfo`; on a loss also `ModuleAmbiglow`, whose E2A019 was just written back). `method_12` branches on the cache's `ENEEffectEnable`, and a stale `false` would make the next theme switch write `E2A019` and drop ENE mode. The vendor has that bug for a hot-plug after the load; the port does not reproduce it;
  - the same model again is a no-op: no save, no notification.
- `NotifyEffectSyncDevicesChange` (Effect_Reset), `NotifyEffectChange` (light sync) and `NotifyHotKeyExecute` (dead code) are not the driver's: the Effect_* functions belong to the ambiglow module.

### 2.4 Manager (scan kinds, hotplug, selection)

- **`start()`** only loads the dictionaries and the capability cache and subscribes to `hotplug` events. As in the vendor, the scan starts with the renderer's `Start` (`api/system.ts` calls `scan('all')`).
- **Current display only** (the vendor has one driver, `CDevice_PHLDisplay`, working on `DataOSD.s_DataDisplay.CurDisplay`; GClass3.cs:143-274): every display gets the fast connect, but only the current one is loaded, registered with the theme store and handed to the ambiglow service. So `Theme_Switch`/`Theme_ApplyProfile` apply to it alone, and `Theme_ResetCurProfile`/`FactoryReset` send VCP 0x04 to it alone. Its notifications are the only ones the renderer gets (the others never recheck). `Device_GetConnectList` still lists every display (`UIDisplayInfos`).
- **`scan('all' | 'display')`**:
  1. Discovery runs while every display's op queue is held, so the bridge identification queries never interleave with a running sequence. **If discovery throws**, the scan keeps the known displays as they are (no dispose, no unregister) and ends; the next scan reconciles.
  2. Displays are reconciled by EDID serial:
     - existing displays keep their `PhlDisplay` object and get new transports (`rebind`);
     - new displays are created;
     - vanished ones are closed, unregistered from the theme store, and detached from ambiglow (`attach(null)`).
  3. The current display is chosen before the connects: the last SN (case-insensitive, `lastSN`), else the first display.
  4. Every display gets a fast connect; the current one's load continues in the background.
  5. If the current one cannot connect, the first connected display becomes current and is loaded (deviation 8).
  6. The current display is registered as a `ProfileParticipant` right after its fast connect, before its load finished (§2.1 item 3); all others are unregistered.

  Concurrent full-scan requests share the queued run (the same promise).
- **`detectDisplays()`** (`Device_DetectionDisplay`): the vendor's 5000 ms settle on the injectable clock, then `scan('display')`. `PHL_Rescan` scans without the wait.
- **`scan('usb')`** (`Device_DetectionUSB`, and every `hotplug('usb')` event):
  1. Compare a snapshot of the watched USB devices (VID 2109/0BDA/05E3/0552/0CF2, id plus bus address; the vendor's CListCompareControllers).
  2. If it changed: rediscover. The snapshot is taken over only when discovery succeeded, so a failed discovery is retried by the next reconcile even if the USB set does not change again.
     - Displays whose transport set changed are rebound and re-probed. VIA gone means i2c only; VIA back (a new enumeration) means USB first again.
     - A display with no supported transport left is marked disconnected and unregistered. If it was the current one, the first connected display becomes current (and is loaded), else the ambiglow service gets `attach(null)` (`FnRecheckConnectionByUSB` → `OnDisConnect`, GClass3.cs:190-222).
     - A display that became reachable again is fast-connected; if it is the current one it is registered and reloaded (`OnConnect`).
     - An ENE change updates `discovered.ene` and re-attaches ambiglow.
     - New monitors are fast-connected (and loaded only if there was no connected current display).
- **`hotplug('display')`** does nothing on purpose. Display rescans come from the renderer's `Device_DetectionDisplay`, which respects `shieldDisplayChange` (20-monitor-io D9 rule 1).
- **`select(key)`**:
  - the current key (exact match) returns `true` with no I/O;
  - another supported display (case-insensitive match) becomes current, the only theme participant, and reconnects fully (OnConnect: fast connect, registration, load);
  - anything else returns `false`, and `PHL_SwitchDisplay` then answers `Display sn=<sn> is not exit or not support`.
- **Theme store:** the current display is registered as a `ProfileParticipant` right after its fast connect. Before its first load, `purify()` returns the stored section unchanged, and `applyProfileContent`/`resetToFactory` queue behind the load. The vendor cannot get into this state: its scan runs synchronously inside `Start` (SO:107-121), before CheckTopApp can switch themes. A display is unregistered when it stops being current, disconnects or vanishes.
- **Ambiglow:** `attach(current)` is called after each load, reload, profile apply and reset of the current display. These are the vendor's `method_17` call sites, so the ambiglow service re-pushes `EffectInfo`. It is also called on ENE changes, and when an already loaded display becomes current. `attach(null)` is called when there is no connected current display. `checkEne` is asked at the start of every full read of the current display.
- **Mock mode** (`BackendOptions.mockMonitor`):
  - `createMock34M2C8600` provides the simulator and the fake VIA bridge and i2c bus;
  - `MockEneDevice` sits on the same `FakeUsbBackend` at `3-2.1`;
  - a temporary sysfs is written with `writeMockSysfs`;
  - the real `discoverMonitors` runs over all of it, with `NO_DELAY_TIMINGS`.

  `"34M2C8600/no-ene"` (or `mockEne: false`) leaves the ENE out, which is the user's 2026-09-26 state. `mockHardware` exposes all of it to tests. `mockSpec` replaces the simulated monitor's seed: the shipped one has a synthetic serial (`MOCK000000001`, impl-ddc "Synthetic identity"), and the tests that replay the user's captured data pass `test/fixtures/user-monitor.ts` `USER_34M2C8600` (the captured EDID and serial, anonymized).
- **Real mode:** `BackendOptions.usb`, or a new `LibusbBackend`, plus `/sys`, `/dev` and `linuxI2cSyscalls()`. With `noHardware` and no mock, there are no monitors.

### 2.5 API dispositions (20-backend-host-tail §3; audited against `api/catalog.ts`)

| Function | Port reply |
|---|---|
| `PHL_*` driver calls without a connected display | `functionName: <fn>  return null obj` (the vendor's `?.`) |
| `PHL_Rescan` | `Tag` DeviceData after `scan('display')`, or `Display unconnected` |
| `PHL_SetOSD(s)` | E `not supported` |
| `PHL_ProfileAction` | vendor logic; the 34M2C8600 has no E2A06B, so `EXT_OP_E2A0_6B_Profile Unavailable` |
| `SetGamePQ` | `Tag` ModuleGameMode (no I/O) |
| hotkey / GamePQ-mouse stubs | `Tag` `[]` (`PHL_GetHotKeyMenu`) or `null` |
| `Device_GetConnectList` | `[DeviceInfo]` while the current display is connected, else `[]`; never fails |
| `Device_GetDeviceInfo(100000)` | DeviceInfo, else `No driver found!` |
| `Device_UpgradeFw` | E `No driver found!` |
| `Device_Rescan` / `Device_DetectionUSB` / `Device_DetectionDisplay` / `Device_OtherDeviceChange` | the list after: cache reset + full scan / the USB reconcile / 5 s + display scan / nothing |
| `Profile_GetDeviceData(100000)` / `Profile_Reset(100000)` | DeviceData (`uiProfileGet`) / `Reset()` |
| other device types, onboard functions | `functionName: <fn>  return null obj`; `Profile_ApplyOnboard` checks the names first (`ThemeSwitch themeName is null` / `…profileName is null`) |
| `DisplayFW_CheckUpstreamCable` / `GetMonitorCount` / `InstallDriver` | `err_msg:null`; Tag `true` / number of monitors / `null` |
| `DisplayFW_GetDeviceList` | `Tag []` (§5 step 4 R(port)) |
| `DisplayFW_UpdateFirmversion`, `DisplayFW_FWUpdateFailedNextTime` | E `firmware update not supported` |

`GetHotKeyState` belongs to `api/stubs.ts` (catalog owner `stubs`).

### 2.6 Key order of `SubSmartImages` (`Dictionary<int, …>`)

Newtonsoft writes and populates a `Dictionary<int, T>` in insertion order, e.g. `{"3":…,"4":…,"1":…}` after `SetSmartImage(4)` and `SetSmartImage(1)` on an SDR monitor loaded in mode 3, or `{"34":…,"33":…}` in a Windows `.pcenter`. A JS object always lists integer-like keys ascending, and `core/json.ts` builds plain objects, so the order has to be carried on the side:
- **Model:** `SubSmartImages` is a `Map` (insertion order, and `set` on an existing key keeps its position, like `dict[k] = v`).
- **Serialization** (`modules.ts` `serializeSubMap`): the object it returns has the plain ascending keys, for code that walks the tree. It also has an enumerable `toJSON` function. `core/json` `toJsonValue` copies function values through, and the final `JSON.stringify` of `serialize()`/`serializeResult()` calls it. `toJSON` returns a `Proxy` whose `ownKeys` trap gives the insertion order: ECMA-262 `SerializeJSONObject` → `EnumerableOwnProperties` → `[[OwnPropertyKeys]]`. The values are converted with `toJsonValue` in the same mode, so `profile` mode still drops nulls.
- **Parsing** (`json-populate.ts` `parseJsonOrdered`, used by `parseJsonObject`, i.e. `T_PHLDisplay_Profile.parse`): a strict JSON parser with the same values and `SyntaxError`s as `JSON.parse` (tested side by side). It records the source key order of every object with integer-like keys in a `WeakMap`, and `populateSubMap` walks `orderedEntries()`.
- **Clone** (`ToCloning`): `serializeSubMap` registers its output's order too, so `toJson('ui')` → `populate` keeps the order.

Verified with the contract harness' independent `jsonKeyOrders` scanner (`load-variants.test.ts`).

---

## 3. Deviations from the vendor

1. **Linux `DeviceName`.** It is the DRM connector without `cardN-` (e.g. `DP-1`), with `\\.\DISPLAY<n>` when no connector is known. The Windows value was `\\.\DISPLAY1` (20-monitor-io §3.2; the renderer never reads it; the contract compare tolerates it).
2. **IsSmartImageHDR = P1**, derived from DC, not from the OS HDR state (20-monitor-io D8).
3. **Per-display single-flight queue** for multi-step sequences (D2). The vendor does not serialize them.
4. **Saves are not awaited** by the operation (§2.2). The vendor wrote synchronously; the port's store debounces.
5. **Null lists become `[]`.** A DC or 0x60 without a ValueList gives `[]` for `Items`, `InputSourceList` and `PIPPBPSourceList`. The vendor stores `null` and then throws (`Find` on null) or crashes the renderer's `.map`.
6. **DualResolution split** is skipped when the attribute has no ValueList. The vendor would throw a NullReferenceException.
7. **ENE state across Reset.** The vendor clears the ENE state in `Reset` and re-detects it in the same reload (`method_4` → `method_14`). The port asks `checkEne` in that reload the same way. Without that hook it keeps the last reported model. The end state is identical.
8. **Current display after a scan.** When the current display cannot connect, the first display that can becomes current. The vendor stays on `Displays[0]` and then shows no monitor at all.
9. **Missing MonitorInfo.json.** Without any MonitorInfo.json every PHL-brand monitor is supported. The vendor would support none.
10. **Firmware version on i2c.** A `C9` that reads 0/0 falls back to `FE E1 E6`. The vendor keeps `""`, which only changes the cache key.
11. **`PHL_SetAudioEQ` with an unknown band** returns `Exception has been thrown by the target of an invocation.`, the vendor's reflection text for its NullReferenceException.
12. **ENE notifications.** `setEneModel` notifies on every ENE state change, and always with the named keys `{ENEEnable, EffectInfo, ModuleAmbiglow}` followed by `Item1..3`. The vendor notifies only on a USB-change plug or unplug, with `Item1..3` alone, which the renderer cannot read.
13. **USB-change reconcile** re-probes and rebinds transports. It reloads only a current display that became reachable again, or a new current one; a display whose bridge merely changed (VIA ↔ i2c) is not reloaded. The vendor's `FnRecheckConnectionByUSB` calls `OnConnect` only when the support state flips, which amounts to the same.
14. **ENE check through the ambiglow service.** `method_14` becomes the optional `AmbiglowService.checkEne` hook (§1.1). It is bounded by `CHECK_ENE_TIMEOUT_MS` (5 s), so a hung USB call cannot stall the load. `setEneModel` also mirrors the ENE state into CacheDeviceData (§2.3), which fixes the vendor's hot-plug-after-load inconsistency.
15. **Theme participant from the fast connect on** (§2.1 item 3, §2.4). The load skips its own save when a switch or reset is already queued behind it.
16. **Other displays are fast-connected.** The vendor reads only the current display's capability string (`InitDisplayVcpCode` of `CurDisplay`). The port reads every display's (cached), so a failed current display can give way to another (deviation 8). They are still never loaded, and never theme participants.
17. **Discovery errors.** A full scan whose discovery throws keeps the known displays. A failed USB-change discovery does not consume the USB change. The vendor had no such failure mode (SetupAPI enumeration).
18. **Theme switch compares with what the monitor was last given** (found by the e2e walkthrough; impl-integration §8 finding). Every setter (`PHL_SetSmartImage`, `PHL_SetOSD`, `PHL_SetInputSource`, …) changes DeviceData only, as in the vendor (CDevice_PHLDisplay.cs:1675-1720). The vendor's theme switch, `ParameterToDevice(object…)` (:585-614), compares the target with CacheDeviceData, the last full read (`method_10` DC :616-673, `method_12` Ambiglow 1A-1E), and ends with `DeviceData = CacheDeviceData.ToCloning()` (:600). Three user-visible results:
    - **DC not written.** Pick another SmartImage preset inside a profile and switch back to a profile whose preset equals the cache's: no DC write. The monitor stays in the other mode, with the target's luminance/contrast written into it, while the UI and the profile show the target's preset. Example: HDR Movie in *Gaming*, back to *Default* (HDR Game).
    - **Stale values.** Volume, input, GameMode, … of the last full read return to DeviceData. The UI then shows them and the store saves them into the target profile, although the monitor still has the values the user set.
    - **New profiles.** A profile without a section for this monitor (`Theme_AddProfile` + the switch into it) is applied as `GetDefaultData()`, which is CacheDeviceData itself (:248-265, GClass0.cs:208/225). The new profile was therefore the last full read, not the monitor's current state. No DC write followed, and the UI and the saved profile showed e.g. Standard and volume 0 while the monitor was in Movie at volume 30. A DDC Ambiglow that was off in that read was switched off (`method_12`: E2A019 = 0).

    The port rebases CacheDeviceData on DeviceData at the start of `applyProfileContent`, which is what the vendor's own (unused) `ParameterToDevice(bool)` override does (:576-583). DeviceData is what the app last wrote to or read from the monitor. Between two applies DeviceData = the cache + the setters' changes, so a switch with no setter in between writes exactly the vendor's frames (`display-ops.test.ts`; 20-theme §6 unchanged). The monitor's own OSD changes are unseen by both until a reload (Sync / `PHL_ReloadData`), as in the vendor.

Vendor quirks kept on purpose, because they are harmless and byte-visible:
- `PHL_SetOSD` stores the SDR sub-module under `SubSmartImages[DC]` even in HDR.
- The EQ load loop leaves the band selector on the last band.
- `OP_E0_AudioSource` is enabled only while PIP/PBP is active.
- A theme switch writes `E2A019 = 0` when the profile's Ambiglow is off.
- A profile switch ends with DeviceData = CacheDeviceData. Since deviation 18 the cache is DeviceData rebased at the start of the switch, so this no longer brings back stale values.

---

## 4. Limitations and open points

- **HDR cross-check.** There is no P2/P3 check (compositor or KMS HDR state): `HostServices` has no HDR source. P1 alone decides.
- **Mode strings** (`MonitorResolution`, `MonitorFrequency`, `MonitorOrientation`) come from `host.getDisplayMode`. Electron main must implement 20-monitor-io §3.5, including `floor(rate + 0.005)`, or the fields stay `""`. With `""`, hz = 0 and MBR is disabled.
- **No HMAC lock.** There is no cross-process lock and no `flock` against ddcutil (20-monitor-io §2.4, L). The DDC channel owner lists this too.
- **`DisplayFW_GetDeviceList`** returns `[]` (spec R(port)). The vendor's local-identity list is not produced (FW version, BOM and scaler model: `fwVersion` is kept on `PhlDisplay` if it is ever wanted).
- **Hotkeys** are not implemented; the whole GamePQ/hotkey surface is dead in 1.13.0 (06 §7.13-7.14).
- **Multiple identical monitors.** They share one `(DeviceType, ModelName)` profile section, as in the vendor. Only the current display is a participant, so the section always holds the current display's settings. After a `PHL_SwitchDisplay` to an identical monitor, the next save overwrites the section with that monitor's state; the vendor behaves the same.
- **Without `checkEne`** (an ambiglow service that does not implement it), the first load can only use an ENE model that `setEneModel` reported before the Ambiglow step of the read. A later report is applied to DeviceData and CacheDeviceData and notified. The renderer's store only takes `ENEEffectEnable` from `saveMonitorData`, so it keeps showing the DDC Ambiglow page until it reloads the device data.

---

## 5. What integration must know

*Status (integration wave): items 1, 2 and 4 are implemented in `src/backend/compose.ts` exactly as below (`createBackend(options)` without a composition is now the production backend); `test/contract` runs against it. See `impl-integration.md` §2-§3.*

1. **Composition.**
   ```ts
   services: (core) => {
     const themes = createThemeStore(core);
     const monitors = createMonitorManager(core, { themes });   // ambiglow does not exist yet (start order)
     const ambiglow = createAmbiglowService(core, { themes, monitors });
     monitors.bindAmbiglow(ambiglow);                            // or pass { themes, ambiglow } if created first
     return { themes, monitors, ambiglow };
   },
   modules: [systemApi, stubsApi, deviceApi, phlApi, profileApi, displayFwApi, /* theme, macro, setting, effect, sync-effect */],
   ```
   A factory chain in slot order gives the manager no ambiglow slot. Call `bindAmbiglow` after the ambiglow service exists (the ambiglow factory can do it with `deps.monitors`). Otherwise `attach()` is never called, and the ambiglow service must rely on `onChanged()`.
2. **Drop `systemMinimalApi`**: its `Device_GetConnectList` duplicates `deviceApi`'s, and a duplicate registration throws.
3. **`Start`** (`api/system.ts`) calls `monitors.scan('all')`. That resolves after the fast connect; the loads continue, and every monitor API waits for them.
4. **One `LibusbBackend` per process.** Pass it as `BackendOptions.usb` so the manager (VIA bridges) and the ambiglow service (ENE) share it. Without it the manager creates its own.
5. **The ambiglow service** should:
   - implement **`checkEne(display)`**: return the ENE model of `display` (open or reuse the `EneDevice` for `display.ene`, `matchEneModelName(display.monitorName, [ene.modelName])`), or `''` when there is none or it is unusable. The display awaits it at the start of every full read. Without it, the first `Profile_GetDeviceData` reports `ENEEffectEnable: false` with an ENE plugged in, and the renderer shows the DDC Ambiglow page (§4). It runs with the display's queue held: never await `display.ready()` in it;
   - call `display.setEneModel(model | '')` when it finds or loses a usable ENE on a USB change (plug/unplug notifications, `method_14`/`method_15` with `bUsbChange`);
   - run DDC-fallback sequences inside `display.exclusive(...)`;
   - call `display.settingsChanged()` after changing `profile()`;
   - expect `attach(display)` only for the current display, after its load (`profile()` is then non-null), and `attach(null)` when no connected display is left.

   `profile()` returns the live `T_PHLDisplay_Profile` (C#-named members, e.g. `ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.Value`, `EffectInfo.EffectDetail.Speed`). It is `null` until the first load.
6. **Electron main**:
   - implements `HostServices.getDisplayMode` for the display's connector (20-monitor-io §3.5);
   - calls `backend.hotplug('usb')` after the debounced USB changes. `hotplug('display')` is accepted but ignored.
7. **Mock mode**: `EVNIA_MOCK_MONITOR=34M2C8600` includes the simulated ENE; `34M2C8600/no-ene` reproduces the golden session. The channel runs without DDC delays, while the driver delays (1000 ms, 5000 ms, …) stay real.

---

## 6. Tests (`port/test/unit/monitor/`)

| File | Covers |
|---|---|
| `model.test.ts` | Default.pcenter round trip (profile mode, sha256); the loaded mock monitor gives the 20-enum §5 Tag byte for byte (uiProfileGet and ui) and the stored ProfileContent in profile mode; the EffectInfo fixtures of §6.3/§6.4; AttributeInfo modes; the constraints constructor state |
| `value-lists.test.ts` | enums.ts against every catalog block; GetDatas/GetItem; the real capability string (85 parsed, 65 handled, 45 ValueLists, the 20 unhandled codes); the §4.2 lists; the DC last-byte rule; smethod_4 capability order; GetAttributeInfo for missing codes; reset codes |
| `display-ops.test.ts` | Every PHL_* sequence (frames as the monitor received them, driver sleeps on a virtual clock); load writes only the EQ selects; theme switch = the 3 writes of 20-theme §6; the Ambiglow-on switch; a switch after setters (deviation 18: DC and 1A written against what the monitor was last given, the volume kept in DeviceData and the stored section, the vendor's frames without a setter in between); reload; ENE plug/loss (named `ENEEnable` keys then `Item1..3`, no-op repeat, cache mirrored: a switch after a plug writes no E2A019, after a loss it does); ENE present at start through `checkEne` (and on reload); `setEneModel` during the first load; a failing `checkEne`; queue non-interleaving; reset with and without 0x04 |
| `load-variants.test.ts` | Simulator variants: the SDR load and `method_10` SDR group (forced writes, UserRGB 16/18/1A, DC +1000 ms, a DC outside Items); `SubSmartImages` insertion order through replies, purify, parse and clone, and a Windows `{"34","33"}` ProfileContent byte for byte; `parseJsonOrdered` against `JSON.parse` (values and errors); DualResolution split with Overclock on/off/absent and UHD120Hz removal on DP/USB-C; OLED timers (all four codes, L only, none); PIP active at load (F7 table in A5, Mode/Size/Location from A5/EC), PIP-active SetInputSource (60 only / A5+EC+60) and SwrapPIPPBP with the 0x60 re-read split; the PIP source default 34 → 47 |
| `constraints.test.ts` | The user state = §6.5 and N0 (1925 characters); notify-on-change only; the rule table (EasyRead, LowBlue, sniper, MBR vs refresh rate and async, Ambiglow modes, ScanMode, PIP) |
| `golden.test.ts` | Steps 3, 11, 12 and 13 through `createBackend` and the real dispatcher (N1 before the reply), on the no-ENE mock with a `checkEne`-answering ambiglow fake; steps 16/17 shapes and the 5 s settle |
| `manager.test.ts` | Fast scan vs background load (gated clock); shared concurrent scans; USB hotplug (VIA detach → i2c, re-attach → USB, ENE detach → re-attach); display unplug/replug via Device_DetectionDisplay; selection errors; Device_Rescan and the cache; Profile_*/Device_* replies; stubs and DisplayFW_*; no-hardware replies; catalog audit (all 46 monitor-owned overloads, no extras or duplicates); the no-ENE mock variant and late ambiglow binding; two monitors (connect list with both, CurSN, only the current one loaded/participant/attached, PHL_SwitchDisplay there and back, reset reaches the current one only, rescan keeps the SN); ENE present at start through RPC; a theme switch and a reset during the gated first load; USB change leaving no transport (disconnect, `attach(null)`, recovery); failed USB-change discovery retried; failed full-scan discovery keeps the displays |

The fixtures in `test/unit/monitor/fixtures/` were extracted verbatim from the reports: the §5 Tag, the §6.5 constraints, N0 and the step 3/13 replies.
