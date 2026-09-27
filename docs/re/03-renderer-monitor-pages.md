# 03 - Renderer monitor feature pages -> backend contract

Evnia Precision Center v1.13.0, renderer (Vue 3 + Pinia + vue-router, minified by Vite) as seen in
`work/app-pretty/renderer/assets/*.js`. Target device for the port: Philips Evnia **34M2C8600**
(EDID `PHL`/`0xC29F`, EDID name `PHL 34M2C8600`, SN `AU00000000001`, backend DeviceType `100000`).

## Summary

The monitor UI is a thin shell over one backend object: the **`T_PHLDisplay_Profile`** returned by
`Profile_GetDeviceData(100000)`. Every monitor page (SmartImage, SmartImageHDR, GameMode, Ambiglow,
Input, Audio, System, Setup, SmartDesktop) renders controls from `AttributeInfo` records inside that
object (one record per DDC/CI VCP code, standard `OP_xx_*` or Philips extended `EXT_OP_E2A0_xx_*`),
shows a control only if `err_code == 0` (renderer field `Support`), and writes back almost exclusively
through one generic call, **`PHL_SetOSD(vcpName, value)`**, which returns the updated `AttributeInfo`
that the page merges into the Pinia `monitor` store by its `VCPOpCodeName`. A handful of multi-VCP
operations have dedicated calls (`PHL_SetSmartImage`, `PHL_SetColorPreset`, `PHL_ResetSmartImage`,
`PHL_SetInputSource`, `PHL_SwrapPIPPBP`, `PHL_SetAudioEQ`, `PHL_SwitchSmartFrame`,
`PHL_SetSmartFrameSize`, `Profile_Reset`). Ambiglow has two back-ends selected by
`ENEEffectEnable`: the ENE 6K7732 USB lighting controller (`Effect_*` calls, 34M2C8600 was seen with
ENE both present (2026-09-25) and absent (2026-09-26) in the user's logs) or DDC VCPs `E2A0_19..1E`.
Cross-control enable/disable rules are computed in the backend (`DisplayFuncConstraints`) and pushed
through the `NotifyUIDisplayFuncConstraintsChange` notification. Capability gating in the UI comes from
(a) per-VCP `Support`, (b) `MonitorInfo.json` via IPC `getMonitorJsonConfig` (`SupLightEffect` shows
the Ambiglow tab, `SupOTA` + `OTAEnable` shows the Setup "FwUpdate" tab, `HDR` labels
"DisplayHDR xxx"; `SupUsbDDC`/`SupLightSync` are **not read by the renderer**), (c) Windows HDR state
(`IsSmartImageHDR` chooses SmartImage vs SmartImageHDR page), (d) hard-coded model lists (images,
LED layouts). Online features inside this area are: monitor/peripheral firmware OTA check + download,
SmartDesktop (PowerToys FancyZones) download, DTS driver download, device image download, and the
MonitorInfo.json refresh; all are removable without affecting local DDC control. 43 backend function
names are used by the monitor pages and their helpers, plus peripheral-only ones (table in section 5). Several vendor bugs were found (section 9),
most notably `NotifyUIDisplayEffectChange` being serialized as `Item1/Item2/Item3` while the renderer
reads named fields.

Legend used below: **CONFIRMED** = read in code and/or seen in real logs; **INFERRED** = deduced,
not directly observed. File paths are relative to the repository root unless
absolute. `R/` = `work/app-pretty/renderer/assets/`, `DC/` = `work/dotnet-clean/`.

---

## 1. Transport as seen from the renderer (context for all pages)

CONFIRMED, `R/styles-DAnQi2A8.js` lines 7888-8031 (class `Jc`, factory `ou`):

| Item | Value |
|---|---|
| Hub URL | `http://localhost:${port}/EvniaHub`, port from IPC `startupBackendService` (default 10010) |
| SignalR options | `skipNegotiation: true`, `transport: WebSockets`, `timeout: 120000`, automatic reconnect; on close it re-`connect()`s every 2 s |
| Request | `hub.invoke("GetTaskAsync", JSON.stringify({functionName, requestId: uuid, parms: args.length ? args : null}))`. The renderer never sends the optional `device` field. |
| Hub events registered | `"GetTaskAsync"` (responses) and `"Notification"` (push); payload is a JSON **string**, parsed with `JSON.parse` |
| Response routing | `{FunctionName, RequestId, err_code, err_msg, Tag}`; if `RequestId` set: resolve only if `waitingResponse[FunctionName] === RequestId` **or** the function is in the concurrent list `["Theme_GetThemeInfos","DeviceSteup_GetPowerInfo"]`. Otherwise it is a notification: all callbacks for `FunctionName` get `Tag`. |
| Success test | resolve with `Tag` iff `err_code === 0 && !err_msg`; else reject `{code: err_code, msg: err_msg}` |
| Not connected | `invoke` sleeps 4000 ms once if hub state != Connected, then sends anyway |
| Log-silenced | `Effect_CheckDynamicLightingEnabled`, `Effect_GetLEDs`, `NotifyAmbiScapeFollowVideoData` |

Consequence (CONFIRMED, line ~7976): **only the newest outstanding request per functionName resolves**.
Rapid slider moves send many `PHL_SetOSD`; earlier promises never settle. A Linux backend must still
answer every request with its own `RequestId`; the renderer drops stale ones.

Backend side (CONFIRMED, `DC/EvniaServe/Class0.cs` 19-113): `parms` elements are converted by JSON
token type only (Integer -> `int`, String -> `string`, Boolean -> `bool`; anything else = error), and
the overload of `Bridge.<functionName>` is chosen by that type list. `Profile_GetDeviceData` is
serialized with `JsonIgnoreExType.IgnoreUI` and nulls **included**; all other responses with plain
Newtonsoft (`ReferenceLoopHandling.Ignore`, nulls included). `[JsonIgnore]` members of
`AttributeInfo` (`VCPOpCodeDesc`, `IsAvailable`, `err_msg`) are never sent.
Notifications: `DC/EvniaServe/Evnia/HandleEvent.cs` 89-101 sends `JsonResult{FunctionName, Tag,
err_code:0, RequestId:null}` as JSON string on hub event `"Notification"` to all clients.

C# `ValueTuple` returns serialize as `{"Item1":...,"Item2":...}` (Newtonsoft default; tuple element
names are lost). The renderer relies on this for `PHL_SetSmartImage`/`PHL_ResetSmartImage` (reads
`Item1`/`Item2`). See bug B1 for the notification where it does **not**.

---

## 2. Renderer service layer for monitors

### 2.1 `yu()` - monitor API object (CONFIRMED `R/styles-DAnQi2A8.js` 8310-8517)

`const t = (name, v) => invoke("PHL_SetOSD", name, v)`. `e` = deviceType bound at construction;
pages construct it with `yu(DeviceType)` (Ambiglow, `aP` import) or `yu()` (then `t||e` = explicit
argument). Global instance: `Dy.device.monitor` (`Hu()` line 8758, `Dy` line 33761).

| JS method | functionName | params sent (order) |
|---|---|---|
| detectMonitor() | Device_DetectionDisplay | - |
| monitorSwitch(sn) | PHL_SwitchDisplay | sn:string (monitor serial, e.g. `"AU00000000001"`) |
| getMonitorData(dt) | Profile_GetDeviceData | dt:int (100000) |
| reloadMonitorData() | PHL_ReloadData | - |
| setOSD(name, v) | PHL_SetOSD | name:string, v:int |
| getDisplayConstraints() | PHL_GetConstraints | - |
| getENEConfig(dt) | Effect_GetMenu | dt:int |
| setSmartImage(v) / setSmartImageHDR(v) | PHL_SetSmartImage | v:int (OP_DC value) |
| setBrightness(v) | PHL_SetOSD | "OP_10_Luminance", v |
| setContrast(v) | PHL_SetOSD | "OP_12_Contrast", v |
| setSharpness(v) | PHL_SetOSD | "OP_87_Sharpness", v |
| setSaturation(v) | PHL_SetOSD | "OP_8A_Saturation", v |
| setHue(v) | PHL_SetOSD | "OP_90_Hue", v |
| setGamma(v) | PHL_SetOSD | "OP_72_Gamma", v |
| setColorTemperature(v) | PHL_SetColorPreset | v:int (OP_14 value) |
| setColorTemperatureRGB(ch, v) | PHL_SetOSD | {R:"OP_16_VideoGainDriveRed",G:"OP_18_VideoGainDriveGreen",B:"OP_1A_VideoGainDriveBlue"}[ch], v |
| setSmartContrast(v) | PHL_SetOSD | "OP_F0_SmartContrast", v |
| setColorSpace(v) | PHL_SetOSD | "EXT_OP_E2A0_20_ColorSpace", v |
| setLightEnhancement(v) | PHL_SetOSD | "EXT_OP_E2A0_3D_LightEnhancement", v |
| setColorEnhancement(v) | PHL_SetOSD | "EXT_OP_E2A0_3E_ColorEnhancement", v |
| setDarkEnhancement(v) | PHL_SetOSD | "EXT_OP_E2A0_3F_DarkEnhancement", v |
| setDLBL(v) | PHL_SetOSD | "EXT_OP_E2A0_24_DLBL", v |
| setInputAuto(v) | PHL_SetOSD | "OP_ED_InputAuto", v |
| setInputSource(i,p,m,s,l) | PHL_SetInputSource | inputSource, pippbpSource, mode, size, location (all int) |
| pipPbpSwap() | PHL_SwrapPIPPBP | - |
| smartImageReset(v) | PHL_ResetSmartImage | v:int |
| monitorReset(dt) | Profile_Reset | dt:int |
| getMonitorFwList() | DisplayFW_GetDeviceList | - |
| firmwareBurning(scaler, type, file) | DisplayFW_UpdateFirmversion | scalerModelName:string, deviceType:int, fwFile:string |
| checkUpstream() | DisplayFW_CheckUpstreamCable | - |
| checkMonitorCount() | DisplayFW_GetMonitorCount | - |
| setVolume(v) | PHL_SetOSD | "OP_62_AudioSpeakerVolume", v |
| setMute(v) | PHL_SetOSD | "OP_8D_AudioMute", v |
| setAudioMode(v) | PHL_SetOSD | "EXT_OP_E2A0_00_AudioMode", v |
| setAudioSource(v) | PHL_SetOSD | "OP_E0_AudioSource", v |
| setEq(idx, v) | PHL_SetAudioEQ | index:int, value:int |
| setEffectEnable(b, dt) | Effect_Enable | dt:int, b:bool |
| setEffectMode(v) | PHL_SetOSD | "EXT_OP_E2A0_19_AmbiglowLightMode", v |
| setENEEffectMode(v, dt) | Effect_Change | dt, v |
| saveCustomColor(csv) | Effect_SetSelfColors | csv:string (e.g. `"#ff0000,#00ff00"`) |
| setRandomColorEnable(b, dt) | Effect_RandomEnable | dt, b |
| setEffectColor(v) | PHL_SetOSD | "EXT_OP_E2A0_1A_AmbiglowColors", v |
| setENEEffectColor(r,g,b,dt) | Effect_ColorChange | dt, r, g, b |
| setRainbowEnable(b, dt) | Effect_RainbowEnable | dt, b |
| setEffectPosition(v) | PHL_SetOSD | "EXT_OP_E2A0_1B_AmbiglowLightPosition", v |
| setENEEffectPosition(v, dt) | Effect_RegionChange | dt, v |
| setEffectBrightness(v) | PHL_SetOSD | "EXT_OP_E2A0_1C_AmbiglowLightBrightness", v |
| setENEEffectBrightness(v, dt) | Effect_BrightnessChange | dt, v |
| setEffectSpeed(v) | PHL_SetOSD | "EXT_OP_E2A0_1D_AmbiglowLightSpeed", v |
| setENEEffectSpeed(v, dt) | Effect_SpeedChange | dt, v |
| resetEffect(dt) | Effect_Reset | dt |
| getMonitorLED(dt) | Effect_GetLEDs | dt |
| setEffectDirection(v) | PHL_SetOSD | "EXT_OP_E2A0_1E_AmbiglowLightDirection", v |
| setENEEffectDirection(v, dt) | Effect_DirectionChange | dt, v |
| setSmartFrame(v) | PHL_SwitchSmartFrame | v:int |
| setSmartFrameSize(v) | PHL_SetSmartFrameSize | v:int |
| setSmartFrameBrightness(v) | PHL_SetOSD | "EXT_OP_E2A0_0A_SmartFrameBrightness", v |
| setSmartFrameContrast(v) | PHL_SetOSD | "EXT_OP_E2A0_0B_SmartFrameContrast", v |
| setSmartFramePositionVt(v) | PHL_SetOSD | "EXT_OP_E2A0_0D_SmartFrameVPosition", v |
| setSmartFramePositionHz(v) | PHL_SetOSD | "EXT_OP_E2A0_0C_SmartFrameHPosition", v |
| setSmartSize(v) | PHL_SetOSD | "OP_86_DisplayScaling", v |

Real traffic confirming the shapes (CONFIRMED, `%APPDATA%/EvniaServe/logs/2026-09-26.txt`
lines 1019-1087): `{"functionName":"PHL_SwitchDisplay","parms":["AU00000000001"]}`,
`{"functionName":"Profile_GetDeviceData","parms":[100000]}`, `{"functionName":"PHL_GetConstraints","parms":null}`,
`{"functionName":"PHL_SetOSD","parms":["EXT_OP_E2A0_43_AutoWarning",1]}` (followed by
`Hub SetTPVExternValue command=e2a043 value=01 result=0`), `{"functionName":"PHL_ReloadData","parms":null}`.

### 2.2 `bu()` - lighting API (CONFIRMED 8619-8676), used by Ambiglow/LightSync

| JS method | functionName | params |
|---|---|---|
| getENEConfig(dt) | Effect_GetMenu | dt |
| getEffectColors() | Effect_GetColorData | - |
| setEffectEnable/Mode/Color/... | Effect_Enable / Effect_Change / Effect_ColorChange(dt,r,g,b) / Effect_RandomEnable / Effect_RainbowEnable / Effect_RegionChange / Effect_DirectionChange / Effect_BrightnessChange / Effect_SpeedChange / Effect_Reset | dt first, then value(s) |
| saveCustomColor(csv) | Effect_SetSelfColors | csv |
| getSyncData() | SyncEffect_GetData | - |
| setSyncDevices(dt, list) | SyncEffect_EnableDevice | dt:int, JSON.stringify([{DeviceType, ModelName}]) |
| clearSync(dt) | SyncEffect_EnableDevice | dt, `"[]"` |
| setBulbAmbiScape(en, ms=500) | AmbiScape_EnableFollowVideo | en:bool, en ? ms : 0 |

### 2.3 Other APIs touched by monitor pages

- `Gh()` system API (CONFIRMED 29887-29960): `getSystemDynamicLight` -> `Effect_CheckDynamicLightingEnabled`,
  `toDynamicLightSetting` -> `Effect_OpenDynamicLightingSetting`, `getDeviceList` -> `Device_GetConnectList`,
  `getDeviceInfo(dt)` -> `Device_GetDeviceInfo`, `systemInit` -> `Start`, `detectUsb` -> `Device_DetectionUSB`,
  `detectOtherDevice` -> `Device_OtherDeviceChange`. (It also calls `Setting_EnableAllowControlLights`
  and `Setting_TurnOffLightsWhenDisplayTurnOff`, which do **not exist** in `Bridge.cs` - out of scope, see Cross-references.)
- `Ey()` FancyZones API (CONFIRMED 33604-33640): `FancyZones_GetVersion`, `FancyZones_GetData`,
  `FancyZones_Enable(bool)`, `FancyZones_SetSetting("FancyzonesShiftDrag", "true"|"false")`, `FancyZones_StartEditor`.
- `nu()` setup API (CONFIRMED 8033-8081): `Device_UpgradeFw(dt, path)` (peripheral FW only) plus `DeviceSteup_*` (peripherals).
- `Ry()` firmware-upgrade composable (CONFIRMED 33789-34060) - section 4.9.

---

## 3. Monitor Pinia store `id` ("monitor") - how responses are normalized

CONFIRMED `R/styles-DAnQi2A8.js` 9046-9590.

### 3.1 Normalizers

| fn (line) | input | output |
|---|---|---|
| `Qu` (9046) "switch" | AttributeInfo | `{VCPOpCode, On, Off, Value:boolean, Support}`; `On` = `ValueList` entry whose `Name.toUpperCase()==="ON"` (default 1), `Off` = entry `"OFF"` (default 0), `Value = (raw Value === On)`, `Support = err_code===0` |
| `Xu` (9065) "enum/range" | AttributeInfo | `{...attr, Support: err_code===0, ValueList: [{name, text, value}]}`; names starting `Num_` are rewritten: `Num_1_5` -> `"1.5"`, `Num_2` -> `"2"` |
| `rd` (9297) module | module object | for each key: arrays `InputSourceList`/`PIPLocationList`/`PIPPBPSourceList` -> `[{name,text,value}]`, other arrays copied, objects with `ValueList` -> `Xu`, objects with `err_code` -> `{...o, Support}`, rest copied |

### 3.2 State (defaults) and `saveMonitorData(data, eneMenuEffectList?)` (9316-9444)

```text
DeviceType, ModelName, IsSmartImageHDR, OP_DC_DisplayApplication (raw AttributeInfo),
ENEEffectEnable, HasUSBSetting, DispalyData{MonitorEDIDInfo_T{...16 strings}, MonitorResolution, MonitorFrequency, MonitorOrientation},
ModuleSmartImage    = {Items: data.ModuleSmartImage.Items, activedItem: data.OP_DC_DisplayApplication.Value,
                       ...rd(data.ModuleSmartImage.CurSubSmartImage), OP_F0_SmartContrast: Qu(...)}
ModuleSmartImageHDR = {Items: data.ModuleSmartImageHDR.Items, activedItem: OP_DC.Value, ...rd(CurSubSmartImage)}
ModuleGameMode      = {...rd(ModuleGameMode), Qu() for EXT_OP_E2A0_40_AdaptiveSync, _03_MBRSync, _07_LowInputLag, _4C_Overclock, _08_SmartFrame}
EffectInfo          = {...data.EffectInfo, CurrEffect: data.EffectInfo.CurrEffect.Value,
                       EffectDetail: {...data.EffectInfo.EffectDetail, ...eneMenu.find(m => m.Effect.Value === CurrEffect.Value)},
                       EffectList: data.EffectInfo.EffectList.map(e => ({name:e.Effect.Name, text:e.Effect.Text, value:e.Effect.Value}))}
ModuleAmbiglow      = rd(ModuleAmbiglow)            (EffectEnable kept as bool)
ModuleAudio         = {...rd(ModuleAudio), OP_8D_AudioMute: Qu()}          (EQItems raw)
ModuleInput         = {...rd(ModuleInput), OP_ED_InputAuto: Qu()}          (InputSourceInfo raw)
ModuleSetup         = {...rd(ModuleSetup), Qu() for OP_E9_ResolutionNotifier, EXT_OP_E2A0_17_CEC, _36_PixelRefresh,
                       _61_AutoPixelRefresh, _37_PanelRefresh, _43_AutoWarning, _47_UniBright, _4B_ThermalProtection}
ModuleSystem        = {...rd(ModuleSystem), Qu() for EXT_OP_E2A0_16_SmartPower, _13_USB_StandbyMode, OP_54_PerformancePreservation, OP_DA_ScanMode}
eneConfig, optionControl{}, OTAEnable(true), configInJson{}
```

Required (the renderer dereferences them unconditionally): `data.ModuleSmartImage.CurSubSmartImage`,
`data.ModuleSmartImageHDR.CurSubSmartImage`, all five modules, `data.OP_DC_DisplayApplication`,
**`data.EffectInfo.CurrEffect`** (a null `EffectInfo` throws, see bug B3).

Merge actions used by pages (9445-9580): `updateSmartImage`, `updateSmartImageHDR`,
`updateMonitorGameMode`, `updateMonitorAmbiglow`, `updateEffectEnable(b, isENE)`,
`updateMonitorEffectInfo(effectInfo)`, `updateMonitorAudio`, `updateMute(bool)`,
`updateMonitorInput`, `updateMonitorSystem`, `updateMonitorSetup`, `setOptionControl(list)`. Each takes
`{VCPOpCodeName: AttributeInfo, ...}` (or a whole module object) and re-applies the same Qu/Xu rule per key.

### 3.3 Capability getters (9372-9392)

| getter | definition | source |
|---|---|---|
| `modelNameInJson(name?)` | `name.trim().slice(startsWith("PHL")?3:0).split(/[\s+|_]/).at(-1)` -> `"PHL 34M2C8600"` -> `"34M2C8600"` | - |
| `OTASupport(name?)` | `OTAEnable && configInJson[key]?.SupOTA` | MonitorInfo.json |
| `ambiglowSupport` | `configInJson[key]?.SupLightEffect` | MonitorInfo.json -> hides Ambiglow nav tab |
| `ambiglowTitle` | `"Ambiglow"` if `ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode.ValueList` has name `"FollowVideo"`, else `"Halolight"` | VCP ValueList |
| `HDRValue` | `configInJson[key]?.HDR` (400 for 34M2C8600) | used in label "DisplayHDR 400" |
| `monitorEDIDInfo` | `DispalyData.MonitorEDIDInfo_T` | Setup footer "Model: sMonitorName | SN: sSerialNumber" |

`configInJson`/`OTAEnable` are loaded once at startup (`R/main-CDosWiM3.js` 199-200) from IPC
`getMonitorJsonConfig`, which the main process builds from `%APPDATA%/evnia/MonitorInfo.json`
(`work/app-pretty/main/index.js` 17584-17601): `{OTAEnable: !LimitVer_PCenter.includes(-1) && !includes(appVer), config: {<key>: MonitorEntry}}`.
For the user (CONFIRMED `work/app/MonitorInfo.json` 1101-1147): keys `34M2C8600` and `PHL 34M2C8600`
both `{SupUsbDDC:true, SupOTA:true, SupLightEffect:true, SupLightSync:true, HDR:400}`; after the
key transform both map to `"34M2C8600"`.

**`SupUsbDDC` and `SupLightSync` are never read by the renderer** (grep of all `R/*.js`, CONFIRMED).
`SupLightSync` reaches the UI only indirectly via backend `DeviceInfo.SupSync` (`Device_GetConnectList`
-> `moduleSupport.effectSync`), set from the backend's own dictionary
(`DC/Zeasn.Equipment.Option.Lib/.../CDevice_PHLDisplay.cs` 218-246).

### 3.4 `optionControl` (backend function constraints)

CONFIRMED `R/main-CDosWiM3.js` 1834-1840: on notification `NotifyUIDisplayFuncConstraintsChange`
(Tag = `DisplayFuncConstraints`), `setOptionControl([...FuncItems.flatMap(i => [{[i.FuncId]: i.State},{[i.FuncName]: i.State}]), {[-1]: AudioEQ}, {[-2]: ModuleGameMode}])`
and the store stores `optionControl[key] = (State === 1)`. So each constraint is addressable both by
numeric VCP code (`FuncId`) and by name (`FuncName`). `true` = enabled, `false` = disabled.
Missing keys are treated as enabled by GameMode/System (`a[name] ?? 1`) but as **disabled** by
SmartImage/Audio/Ambiglow/System-SmartSize (`!optionControl[VCPOpCode]`); since the initial `optionControl` is `{}` (truthy) those controls stay disabled until the first `NotifyUIDisplayFuncConstraintsChange` arrives (which `PHL_GetConstraints` on page mount guarantees).

Backend rule set (CONFIRMED `DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/DisplayFuncConstraints.cs` 64-294);
State 1 = enabled, 2 = disabled. Let `pip` = OP_A5 available && PIP/PBP enabled && A5 != 0,
`hdr` = IsSmartImageHDR, `ss` = ScreenSaver(E2A0_35) != OFF, `sniper` = !pip && !hdr && SharpShooter_Size != OFF,
`as` = !pip && AdaptiveSync(E2A0_40) != OFF, `hz` = parsed `MonitorFrequency`,
`mbr` = !(pip || hz<75 || as) && MBR(E2A0_02) > 0, `mbrs` = !pip && as && MBRSync(E2A0_03) != OFF,
`si` = OP_DC value:

| FuncName | disabled when |
|---|---|
| EXT_OP_E2A0_40_AdaptiveSync, _04_SmartCrosshair, OP_EB_SmartResponse, _4C_Overclock | pip |
| EXT_OP_E2A0_02_MBR | pip or hz<75 or as |
| EXT_OP_E2A0_03_MBRSync | pip or !as |
| EXT_OP_E2A0_44_StarkShadowBoost, _45_ShadowBoost, _06_SharpShooter_Size | pip or hdr |
| EXT_OP_E2A0_07_LowInputLag | pip or sniper |
| OP_10_Luminance | non-HDR: mbr or mbrs; HDR: never |
| OP_12_Contrast | si == SmartImage_EasyRead (14) |
| OP_F0_SmartContrast | pip or ss or sniper or mbr or mbrs |
| OP_14_SelectColorPreset, EXT_OP_E2A0_20_ColorSpace | si in {EasyRead 14, LowBlueMode 11} |
| EXT_OP_E2A0_24_DLBL | si != LowBlueMode (11) |
| EXT_OP_E2A0_08_SmartFrame | pip or hdr or sniper or si in {Standard 0, EasyRead 14} |
| EXT_OP_E2A0_1A..1E (Ambiglow colors/position/brightness/speed/direction) | per AmbiglowLightMode, see 4.5 |
| OP_E0_AudioSource | **enabled only when pip** (`method_3(E0, flag?1:2)`) |
| OP_54_PerformancePreservation | pip |
| OP_DA_ScanMode | OP_86_DisplayScaling enabled and value == Scaling_NoScaling (1) |
| `-2` ModuleGameMode, `-1` AudioEQ | always 1 (never disabled in v1.13.0) |

The notification is sent by `PHL_GetConstraints` (always) and by any setter whose recheck changed the
JSON. `PHL_GetConstraints`'s own response (same object) is **ignored** by the renderer
(`R/Monitor-D4qz4RBn.js` 84). Real log: the notification follows `PHL_GetConstraints` at
2026-09-26 07:53:01.8657 (CONFIRMED, logged as "exceeds the print limit").

---

## 4. Page-by-page specification

Route map (CONFIRMED `R/styles-DAnQi2A8.js` 43772-44027): `/monitor` (Monitor-D4qz4RBn) with children
`/monitor/smartImage` (SmartImage-DuKfuYFN), `/monitor/smartImageHDR` (SmartImageHDR-BQ1gioFP),
`/monitor/gameMode` (GameMode-C1cXG-_T), `/monitor/ambiglow` (Ambiglow-Dvqon39u, imports LightSync-B-QWSZnT),
`/monitor/input` (InputSource-DfTEOTzT), `/monitor/audio` (Audio-C89vcIta + Equalizer), `/monitor/system`
(System-DT9nKs1q), `/monitor/setup` (Setup-D-5j4V-I + FirmwareUpgrade-BsUoyIKp), `/monitor/smartDesktop`
(SmartDesktop-By8ZEPkl); `/bulb` (Bulb-vdvqR6Jj) -> `/bulb/ambiScape` (AmbiScape-B35D_GM2).
Other `Setup-*`, `Ambiglow-*`, `Customize-*`, `GameMode-CyhaXAEp` chunks belong to keyboard/mouse/pad/headset (4.12).

Sidebar (CONFIRMED `R/main-CDosWiM3.js` 283-325, 496-512): under `/monitor` the nav items are
SmartImage-or-SmartImageHDR (by `IsSmartImageHDR`), GameMode (disabled if `optionControl[-2]` false),
Ambiglow (label `ambiglowTitle`, hidden unless `ambiglowSupport`), Input, Audio, System, Setup,
SmartDesktop, and "Sync" (`nav_sync`), which does **not** navigate: it emits `monitorReload`
(= `PHL_ReloadData` then full refresh, 4.1).

### 4.1 Monitor shell - `R/Monitor-D4qz4RBn.js` (+ DeviceLayout, Overview)

| Step | Code (line) | Backend |
|---|---|---|
| mount | 65-69: listen bus `refreshDeviceData` -> `k`, `monitorReload` -> `x`; if a monitor is connected run `U()` | - |
| `U()` load | 41-49: `dt = activeDevice(Monitor).deviceType` | `Profile_GetDeviceData(dt)`; if `ENEEffectEnable` also `Effect_GetMenu(dt)` -> `saveMonitorData(data, menu.EffectList)` |
| `k()` refresh | 50-59: no monitor -> route `/`; else loading, `U()`, redirect SmartImage <-> SmartImageHDR to match `IsSmartImageHDR` | as `U()` |
| `x()` "Sync" | 60-62 | `PHL_ReloadData()` (response ignored) then `k()` |
| route `/monitor` | 73-81: after 200 ms go to SmartImageHDR if `IsSmartImageHDR` else SmartImage | - |
| mount #2 | 83-92 | `PHL_GetConstraints()`; subscribe `NotifyUIDisplayEffectChange` |
| unmount | 70-71, 93-95 | unsubscribe |
| overlay | 96-120: `DeviceLayout` + dashboard overlay (`vh`, dashboard store `Jm`, `window.store` keys `dashboardPreview*`, `dashboardLocation`) | none |

`NotifyUIDisplayEffectChange` handler (86-91): `a.ENEEnable ? updateMonitorEffectInfo(a.EffectInfo) : for k in a.ModuleAmbiglow: updateMonitorAmbiglow({k: a.ModuleAmbiglow[k]})`.
Backend sends a ValueTuple (bug B1).

Monitor selection: Overview (`R/styles-DAnQi2A8.js` 8883-8893) and DeviceNav
(`R/DeviceLayout-pwnPovdh.js` 127-140) call `PHL_SwitchDisplay(aliasName)` where `aliasName` =
`ExtDeviceInfo.DisplayList[i].DisplaySN`; failure -> alert "MonitorNoSupport". Device list mapping
(CONFIRMED `R/styles-DAnQi2A8.js` 44421-44445, 44664-44672): for each monitor entry of
`Device_GetConnectList`/`Device_DetectionDisplay`, one UI device per `ExtDeviceInfo.DisplayList[]`
item: `{equipmentType:1, aliasName: DisplaySN, modelName: MonitorName, deviceType, ...}`; active =
`ExtDeviceInfo.CurSN`. Display hot-plug: main process forwards `WM_DISPLAYCHANGE` (126) as IPC
`displayChange` (`work/app-pretty/main/index.js` 17235) -> renderer calls `Device_DetectionDisplay()`
(backend sleeps 5 s, `DC/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs` 241-246)
-> `saveDeviceList` -> bus `refreshDeviceData` (`R/main-CDosWiM3.js` 1735-1760).
IPC `shieldDisplayChange(on, secs=4)` suppresses that forwarding around mode switches that re-train the link.

### 4.2 SmartImage - `R/SmartImage-DuKfuYFN.js`

Store slice `ModuleSmartImage` (+ `optionControl`). All setters go through helper `R()` (42-46):
`fn(...).then(attr => attr.VCPOpCodeName && updateSmartImage({[attr.VCPOpCodeName]: attr}))`.

| UI control (line) | visible if | disabled if | call |
|---|---|---|---|
| Mode menu (205) | always; items = `Items[{Name,Value}]` | - | `PHL_SetSmartImage(value)` -> `updateSmartImage({...Tag.Item2.CurSubSmartImage, activedItem: Tag.Item1.Value})` (68-75) |
| settings block | hidden (opacity) when mode name == `SmartImage_Off` (76) | | |
| Brightness 0-100 (218) | `OP_10_Luminance.Support` | `!optionControl[16]` | PHL_SetOSD("OP_10_Luminance", v) |
| Contrast 0-100 (238) | `OP_12_Contrast.Support` | `!optionControl[18]` | PHL_SetOSD("OP_12_Contrast", v) |
| Sharpness (258) | `OP_87_Sharpness.Support` | - | if `MaxValue==10`: slider 0-100 step 10 and sends `v/10`; else raw (89-94, 160-161) |
| Saturation 0-100 (278) | `OP_8A_Saturation?.Support` | - | "OP_8A_Saturation" |
| Hue 0-100 (297) | `OP_90_Hue?.Support` | - | "OP_90_Hue" |
| SmartContrast switch (319) | `OP_F0_SmartContrast.Support` | `!optionControl[240]` | "OP_F0_SmartContrast", `On`/`Off` |
| sRGB switch (335) | ColorSpace supported and its ValueList has exactly 2 entries, one with `text=="sRGB"` | `!optionControl[0xE2A020]` | "EXT_OP_E2A0_20_ColorSpace", sRGB value or the other value |
| ColorSpace select (354) | ColorSpace supported and not the 2-entry sRGB case | same | "EXT_OP_E2A0_20_ColorSpace", value |
| Gamma select (373) | `OP_72_Gamma.Support` | - | "OP_72_Gamma", value |
| ColorTemperature select (392) | `OP_14_SelectColorPreset.Support` | `!optionControl[20]` | `PHL_SetColorPreset(v)` -> `updateSmartImage({...Tag.CurSubSmartImage})` (135-139) |
| R/G/B sliders 0-100 (411-465) | preset name == `Preset_UserRGB` | - | "OP_16_VideoGainDriveRed"/"OP_18_..Green"/"OP_1A_..Blue" |
| DLBL select (468) | `EXT_OP_E2A0_24_DLBL?.Support` | `!optionControl[0xE2A024]` | "EXT_OP_E2A0_24_DLBL", value |
| Reset icon + confirm (510-529) | always | - | `PHL_ResetSmartImage(activedItem)` -> same merge as mode change |

Mode illustration images are bundled (`image-SmartImage_*` CSS classes, list at 51-66); none online.

Backend behaviour (CONFIRMED `CDevice_PHLDisplay.cs` 1675-1776): `SetSmartImage` validates the value
is in `Items`, writes OP_DC, **sleeps 1000 ms**, re-reads the whole sub-module, returns
`(OP_DC AttributeInfo, DisplayModuleSmartImage)` -> JSON `{Item1, Item2}`. `ResetSmartImage` writes
`EXT_OP_E2A0_42_FunctionReset = DataOSD.GetResetSmartImageValue(v)` (enum `E2A0_42_ResetSmartImage_E`,
e.g. Standard=0x30, FPS=0x31, ... HDRPeak=0x41), sleeps 1000 ms, re-reads; errors "Off Mode Not Support ResetSmartImage".
`SetColorPreset` writes OP_14 and, for `Preset_UserRGB` (11), sleeps 50 ms and re-reads OP_16/18/1A.

### 4.3 SmartImageHDR - `R/SmartImageHDR-BQ1gioFP.js`

Same pattern on `ModuleSmartImageHDR` (helper `M`, 42-46; `updateSmartImageHDR`).

| control | visible if | call |
|---|---|---|
| Mode menu (153-164) | items from `Items`; entry `DisplayHDRXXXX` relabelled `"<tr(DisplayHDRXXXX)> <HDRValue>"` | `PHL_SetSmartImage(v)` -> `{...Item2.CurSubSmartImage, activedItem: Item1.Value}` |
| settings block (166) | shown only if mode not in {HDROff, HDRTrueBlack, DisplayHDRXXXX} **and** any of Light/Color/Dark enhancement supported | |
| Brightness (168) / Contrast (186) | `.Support` | "OP_10_Luminance" / "OP_12_Contrast" (no optionControl check here) |
| LightEnhancement / ColorEnhancement / DarkEnhancement (204-258) | `.Support`; slider max = `MaxValue` | "EXT_OP_E2A0_3D_LightEnhancement" / "_3E_ColorEnhancement" / "_3F_DarkEnhancement" |
| Reset (284-291, 128-137) | same visibility as settings block | `PHL_ResetSmartImage(activedItem)` |

Bundled images for HDROff/HDRGame/HDRMovie/HDRPeak/HDRPhoto/HDRVivid/HDRPersonal/HDRTrueBlack/DisplayHDRXXXX (48-59).
User's monitor (CONFIRMED persisted profile, section 6.3): HDR items HDROff 32, HDRGame 33, HDRMovie 34,
HDRPhoto 35, HDRPersonal 36, HDRTrueBlack 48, HDRPeak 51; enhancements unsupported (`err_code 9`),
so on this monitor only Brightness/Contrast appear.

Which page is shown depends on **Windows** HDR state, not on the monitor: backend
`GetMonitorHDR()` -> `CWinSysDisplayHDR.GetHDR(MonitorName).Enabled` (CONFIRMED
`DC/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/GClass3.cs` 356-364, `CDevice_PHLDisplay.cs` 331-337).
The item lists are split by intersecting OP_DC `ValueList` with enum `SmartImageHDR_E` (32..51).

### 4.4 GameMode (monitor) - `R/GameMode-C1cXG-_T.js`

Menu-driven property list (46-293), rendered by `PropertyRenderer` (`R/useMonitorPropertyHandler-BOOFue3H.js` 25-207).
A menu entry is shown if any of its properties has `Support`. Generic handlers (`useMonitorPropertyHandler` 208-252):
select -> `PHL_SetOSD(vcpName, option.value)`, switch -> `PHL_SetOSD(vcpName, on ? On : Off)`,
slider -> `PHL_SetOSD(vcpName, v)`; all show loading, then `updateMonitorGameMode({[Tag.VCPOpCodeName]: Tag})`;
if `shieldDisplay` the IPC `shieldDisplayChange(true)` is sent before and `(false)` after.

| menuValue | menu name | property -> VCP | type | extra |
|---|---|---|---|---|
| 0 | DualMode (tip "DualResolutionRenameTip") | EXT_OP_E2A0_59_DualResolution | select | backend splits value: low byte = mode, high byte = split index vs Overclock (`CDevice_PHLDisplay.cs` 350-371) |
| 1 | AdaptiveSync | EXT_OP_E2A0_40_AdaptiveSync | switch | `shieldDisplay: true` |
| 2 | SmartMBR | EXT_OP_E2A0_02_MBR ("MBRLevel") | slider Min..Max | |
| 3 | SmartMBRSync | EXT_OP_E2A0_03_MBRSync | switch | |
| 4 | SmartResponse | OP_EB_SmartResponse | select | |
| 5 | Crosshair | EXT_OP_E2A0_04_SmartCrosshair | select | |
| 6 | StackShadowBoost | EXT_OP_E2A0_44_StarkShadowBoost | select | |
| 7 | ShadowBoost | EXT_OP_E2A0_45_ShadowBoost | select | |
| 8 | SmartSniper | EXT_OP_E2A0_06_SharpShooter_Size ("Size", `shieldDisplay`), EXT_OP_E2A0_25_SharpShooter_Location ("Location") | select x2 | Location disabled when Size option text is "off" or Size is constraint-disabled |
| 9 | LowInputLag | EXT_OP_E2A0_07_LowInputLag | switch | |
| 10 | Overclock | EXT_OP_E2A0_4C_Overclock | switch | |
| 11 | SmartFrame | EXT_OP_E2A0_08_SmartFrame (custom UI) | custom | see below |
| 12 | AutoRefineAI | EXT_OP_E2A0_68_AutoRefineAIStatus | select | |

Disabled state per property: `!(optionControl[vcpName] ?? 1)` (369).
SmartFrame custom panel (logic 297-341, template 422-545): switch -> `PHL_SwitchSmartFrame(On|Off)` -> `updateMonitorGameMode(Tag)`
(Tag = whole `DisplayModuleGameMode`); Size slider over `EXT_OP_E2A0_09_SmartFrameSize.ValueList[].value`
-> `PHL_SetSmartFrameSize(v)`; Brightness (max = `_0A.MaxValue`) -> SetOSD "EXT_OP_E2A0_0A_SmartFrameBrightness";
Contrast (max `_0B.MaxValue`) -> "EXT_OP_E2A0_0B_SmartFrameContrast"; arrow pad moves V/H position by
`StepValue` within `[MinValue, MaxValue]` -> "EXT_OP_E2A0_0D_SmartFrameVPosition" / "_0C_SmartFrameHPosition".
All disabled when SmartFrame is constraint-disabled or off.
Backend timing (CONFIRMED `CDevice_PHLDisplay.cs` 1808-1886): `SwitchSmartFrame` polls brightness until
`MaxValue == 100` for up to 10 x 1000 ms, then re-reads 0B/09/0C/0D with 100 ms gaps (can block ~11 s);
`SetSmartFrameSize` sleeps 1000 ms then re-reads 0C/0D.
Bundled right-side images `image-0..12` (AdaptiveSync.png, SmartMBR.png, Crosshair.png ...).

### 4.5 Ambiglow (monitor) - `R/Ambiglow-Dvqon39u.js` (+ `R/LightSync-B-QWSZnT.js`)

Two modes selected by store `ENEEffectEnable` (`Z`):

**Common**

| feature (line) | call |
|---|---|
| Windows Dynamic Lighting guard (884-896) | `Effect_CheckDynamicLightingEnabled()` polled every 2000 ms while mounted; Tag `int`: `<0` stops polling, truthy shows "ToDynamicLightingTip" + button -> `Effect_OpenDynamicLightingSetting()` |
| Effect on/off switch (897-901) | `Effect_Enable(dt, bool)` -> Tag bool -> `updateEffectEnable(bool, isENE)` |
| Default/custom colours (1016-1034, 918-923, 1340-1346) | `Effect_GetColorData()` -> `{DefColors:[{R,G,B}] (13 defaults), SelfColors:"#rrggbb,..."}`; add/delete custom (max 14) -> `Effect_SetSelfColors(csv)` -> Tag `EffectColorData`, reads `SelfColors` |
| Reset (1119-1133) | `Effect_Reset(dt)`: ENE -> Tag `DisplayEffectInfo` -> `updateMonitorEffectInfo`; DDC -> Tag `DisplayModuleAmbiglow`, each key merged via `updateMonitorAmbiglow` |
| Preview (1512-1528) | `SimulateGeneralLogic` (or `SimulateSymmetricalLogic` for 27M2N5510J/P, 27M2N5511P, 27M3N5540U/P, 27M2N5810, 27M3N5840) over bundled `34M2C8600_rear.png` |

**ENE path** (`ENEEffectEnable == true`): effect list = `EffectInfo.EffectList` (names FollowVideo 1,
FollowAudio 2, ColorShift 3, ColorWave 4, Breathing 5, StarryNight 6, Static 7 - enum `EffectType`),
capabilities from merged menu item (`SupColor, SupBgColor, SupRainbowColor, SupRandomColor, SupRegion+RegionList,
SupDir+DirList, SupBrightness+Min/Max/Step, SupSpeed+Min/Max/Step`).

| control | call | response use |
|---|---|---|
| effect select (905-908) | `Effect_Change(dt, v)` | `updateMonitorEffectInfo(Tag)` |
| colour picker (1251-1265) | debounced 500 ms: `Effect_ColorChange(dt, R, G, B)` | same |
| rainbow swatch (944-947) | `Effect_RainbowEnable(dt, true)` | same |
| Random switch (949-952) | `Effect_RandomEnable(dt, b)` | same |
| LightPosition select (977-979) | `Effect_RegionChange(dt, v)` (RegionType AllZones 0, FourSided 1, Central 2, Bottom 3, ThirdSidedA 4, ThirdSidedB 5) | same |
| Direction select (980-984) | `Effect_DirectionChange(dt, v)` | same |
| Brightness slider (985-987) | `Effect_BrightnessChange(dt, v)` (1..3, marks Bright/Brighter/Brightest) | ignored |
| Speed slider (988-990) | `Effect_SpeedChange(dt, v)` (1..3, marks Low/Normal/High) | ignored |
| LightSync widget (1476-1490) | shown **only** on ENE path, see below | |
| FollowVideo/FollowAudio preview (255-263) | `Effect_GetLEDs(dt)` re-issued 30 ms after each reply | Tag `RGB[]`: for 34M2C8600 entries `[0..13]` = edge ring (reversed), `[14..31]` = centre strip (274-276) |

ENE defaults (CONFIRMED `DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/DisplayEffectMenu.cs` 49-122,
`DisplayEffectInfo.cs` 49-75): Speed/Brightness 1..3 step 1, rainbow + colour supported, BgColor/Dir/Random/StarCount
unsupported, FollowVideo has no speed/brightness/colour; defaults Speed 2, Brightness 3, rainbow on,
CurRGB blue (black for Follow*), region AllZones. Region list from
`resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json` (34M2C8600: Right 3, RightUp 4, LeftUp 4, Left 3,
Centre 18, Bottom 14 -> `GetRegions` (`DisplayEffectMenu.cs` 140-167) yields AllZones 0, Bottom 3, FourSided 1, Central 2; CONFIRMED code, table lookup by ENE model name INFERRED).

**DDC path** (`ENEEffectEnable == false`, the user's state on 2026-09-26): controls come from
`ModuleAmbiglow` AttributeInfos; all setters are `PHL_SetOSD` -> `updateMonitorAmbiglow({[VCPOpCodeName]: Tag})`.

| control | VCP | values (enum, CONFIRMED `DC/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/E2A0_1*_E.cs`) | disabled by |
|---|---|---|---|
| effect select | EXT_OP_E2A0_19_AmbiglowLightMode (0xE2A019) | AmbiglowOff 0, FollowVideo 1, FollowAudio 2, ColorShift 3, ColorWave 4, ColorBreathing 5, StarryNight 6, StaticMode 7, ColorFlowReverse 8, ColorFlow 9 | effect switch off |
| colour swatches | EXT_OP_E2A0_1A_AmbiglowColors | Rainbow 0, White 1, Red 2, Rose 3, Magenta 4, Violet 5, Blue 6, Azure 7, Cyan 8, Aqua 9, Green 10, Pear 11, Yellow 12, Orange 13 (renderer maps names to hex, 991-1005) | `!optionControl[0xE2A01A]` |
| LightPosition | EXT_OP_E2A0_1B_AmbiglowLightPosition | AllZones 0, FourSided 1, Central 2, Bottom 3, ThirdSidedA 4, ThirdSidedB 5, Right_Left 6 | `!optionControl[0xE2A01B]` |
| Brightness | EXT_OP_E2A0_1C_AmbiglowLightBrightness | Bright 0, Brighter 1, Brightest 2 | `!optionControl[0xE2A01C]` |
| Speed | EXT_OP_E2A0_1D_AmbiglowLightSpeed | Low 0, Normal 1, High 2 | `!optionControl[0xE2A01D]` |
| Direction | EXT_OP_E2A0_1E_AmbiglowLightDirection | RtoL 0, LtoR 1 | `!optionControl[0xE2A01E]` |

Backend enable/disable on DDC (CONFIRMED `CDevice_PHLDisplay.cs` 974-1008): disable writes
`E2A0_19 = 0 (AmbiglowOff)` but keeps the remembered mode; enable re-writes the remembered mode.
DDC reset writes `EXT_OP_E2A0_38_AmbiglowSet = 1`, sleeps 200 ms, re-reads the module.
Per-mode control availability (backend `DisplayFuncConstraints.cs` 217-277; 1 = enabled):

| mode | 1A colour | 1B position | 1C brightness | 1D speed | 1E direction |
|---|---|---|---|---|---|
| FollowVideo | 2 | 2 | 1 | 2 | 2 |
| FollowAudio | 1 | 1 | 2 | 2 | 2 |
| ColorShift / ColorWave / ColorBreathing | 1 | 1 | 1 | 1 | 1 |
| StarryNight | 1 | 2 | 1 | 1 | 1 |
| StaticMode | 1 | 1 | 1 | 2 | 1 |
| ColorFlow / ColorFlowReverse | 2 | 2 | 1 | 1 | 2 |

On the DDC path the renderer never calls `Effect_Change`/`Effect_ColorChange` (backend would answer
"Not Support ENE", `CDevice_PHLDisplay.cs` 1010-1152). `Effect_GetLEDs` answers
`"not ene follow video or audio"` -> preview polling stops on the first rejection.

Preview geometry for 34M2C8600 (CONFIRMED 86-89, 132-137): edge rows `[8,2,2,2]` (14 cells),
centre groups `[7,4,7]` (18 cells). Purely cosmetic.

**LightSync widget** (`R/LightSync-B-QWSZnT.js` 317-523): `SyncEffect_GetData()` on mount/model change
-> Tag `T_Sync_Profile {EffectDetailInfo:{Effect:{Name,Text,Value},...}, SyncDevices:[{EquipmentType, DeviceType, ModelName, ExtModel, SyncStatus, Connect}]}`;
subscribes `NotifyEffectSyncDevicesChange` (same Tag). Toggling calls
`SyncEffect_EnableDevice(currentDeviceType, JSON.stringify([{DeviceType, ModelName}, ...]))` and
re-renders from the returned `T_Sync_Profile`. With no Philips peripherals this is effectively
"sync with nothing" - it can be dropped for the user (see 10).

### 4.6 Input - `R/InputSource-DfTEOTzT.js`

| control | data | call |
|---|---|---|
| input tiles (106-130) | `ModuleInput.InputSourceList[{name,text,value}]`, icon by name (`Normal_DisplayPort1/2`->dp, `Normal_DigitalHDMI1..3`->hdmi, `Normal_USBC1/2`,`Normal_Thunderbolt1/2`->usbc); active = `InputSourceInfo.InputSource` | `PHL_SetInputSource(value, InputSourceInfo.PIPPBPSource, .Mode, .Size, .Location)` with `shieldDisplayChange(true)` before and `shieldDisplayChange(false, 10)` after -> `updateMonitorInput(Tag)` (Tag = `DisplayModuleInput`) |
| Auto tile (132-140) | shown if `OP_ED_InputAuto.Support`; active = its bool | `PHL_SetOSD("OP_ED_InputAuto", active ? Off : On)` |

Backend (CONFIRMED `CDevice_PHLDisplay.cs` 1888-1938): `OP_60` value is packed `byte0 = main input,
byte1 = PIP/PBP source`; when PIP params change it writes `OP_A5_WindowSelect = mode`, 100 ms,
`OP_EC_PIPPBPSizeLocation = size | location<<8`, 100 ms, `OP_60`, 100 ms, `OP_A4_WindowMaskControl = 0xFFFF`.
Input value enum `VCP_60_InputSource_E`: VGA1 1, VGA2 2, DVI1 3, DP1 15, DP2 16, HDMI1 17, HDMI2 18,
HDMI3 19, USBC1 21, USBC2 22, TB1 23, TB2 24; PIP source enum `VCP_60_PIPPBPSource_E`: HDMI1 33, HDMI2 34,
HDMI3 35, DVI1 36, DP1 47, DP2 48, VGA1 49, VGA2 50, USBC1 53, USBC2 54, TB1 55, TB2 56.
User's monitor lists: inputs DP1 15, HDMI1 17, HDMI2 18, USBC1 21; PIP sources 33, 34, 47, 53 (CONFIRMED profile).

### 4.7 Audio - `R/Audio-C89vcIta.js`

| control (line) | visible if | call |
|---|---|---|
| Volume 0-100 (154) | always | `PHL_SetOSD("OP_62_AudioSpeakerVolume", v)`; afterwards if mute supported and muted -> local `updateMute(false)` |
| Mute switch (168) | `OP_8D_AudioMute.Support` | `PHL_SetOSD("OP_8D_AudioMute", on ? On : Off)` (VCP_8D: ON 1, OFF 2) |
| AudioMode cascader (186) | `EXT_OP_E2A0_00_AudioMode.Support` | `PHL_SetOSD("EXT_OP_E2A0_00_AudioMode", value)`. Names ending `BASS` are grouped under their base with children "BASS+"/"DTS" (55-80). Enum: Standard 64, Game 65, Classical 66, Rock 67, Live 68, Theater 69, OFF 70, SportsRacing 71, RPGAdventure 72, ShootingAction 73, MovieWatching 74, Music 75, Personal 76, SportsRacingBASS 80, RPGAdventureBASS 81, MovieWatchingBASS 83 |
| AudioSource select (205) | `OP_E0_AudioSource.Support` | disabled `!optionControl[224]` (i.e. enabled only in PIP/PBP); `PHL_SetOSD("OP_E0_AudioSource", value)` |
| EQ (224) | `EQItems.length` | offset `Z = EQItems[0].MaxValue/2`; UI shows `Value - Z`; on change `PHL_SetAudioEQ(index, uiValue + Z)` -> `updateMonitorAudio(Tag)` (Tag = `DisplayModuleAudio`); disabled `!optionControl[-1]` |

EQ backend (CONFIRMED `CDevice_PHLDisplay.cs` 1976-1996, 420-441): bands are enumerated at load by
writing `EXT_OP_E2A0_01_AudioEQ = band` and reading `EXT_OP_E2A0_39_AudioEQGain` (100 ms apart);
set = write 0x01 = index, 100 ms, write 0x39 = value (must be <= MaxValue). User's monitor: 5 bands
EQ_100/300/1000/3000/10000, index 0..4, value 8, MaxValue 16 (CONFIRMED log 2026-09-26 lines 1142-1151 and profile).

### 4.8 System - `R/System-DT9nKs1q.js`

Property-list page (like GameMode, handler set "System" -> `updateMonitorSystem`). Menus (58-306):

| menuValue | menu | properties -> VCP (type) |
|---|---|---|
| 0 | HDMIRefreshRate | "HDMI 1/2/3" -> EXT_OP_E2A0_3A/_3B/_3C_HDMIxRefreshRate (select, `shieldDisplay`) |
| 1 | OSDSetting | Horizontal EXT_OP_E2A0_0E (slider), Vertical _0F (slider), Transparency _10 + OSDTimeOut _11 (select pair) |
| 2 | PipPbp | custom (OP_A5_WindowSelect) |
| 3 | SmartSize / "PictureFormat" | custom (OP_86_DisplayScaling) |
| 4 | "USBSetting" if `HasUSBSetting` else "USBStandbyMode" | USBCSetting EXT_OP_E2A0_12 (select), USBUpstream _14 + KVM _15 (select pair), USBStandbyMode _13 (switch) |
| 5 | SmartPower | EXT_OP_E2A0_16_SmartPower (switch) |
| 6 | LocalDimming | EXT_OP_E2A0_18_LocalDimming (select) |
| 7 | PixelOrbiting | OP_54_PerformancePreservation (switch; disabled `!optionControl["OP_54_PerformancePreservation"]`) |
| 8 | OverScan | OP_DA_ScanMode (switch; disabled `!optionControl["OP_DA_ScanMode"]`; VCP_DA: OFF 0, ON 2) |

PIP/PBP panel (logic 318-392, template 489-625): mode switch/radio from `OP_A5_WindowSelect.ValueList`
without value 0 (`PIPPBP__PIP` 0x100 -> icon pip, `PIPPBP__PBP_1` 0x200 -> pbp); Window A = `InputSourceList`,
Window B = `PIPPBPSourceList`, PipSize = `OP_EC_PIPPBPSizeLocation.ValueList` (Small 1, Middle 2, Large 3),
PipPosition = `PIPLocationList` (UpperRight 1, LowerRight 2, UpperLeft 3, LowerLeft 4), size/position only
enabled for mode 256. "Ok" -> `PHL_SetInputSource(input, pipSource, mode, size, location)` with
`shieldDisplayChange(true)` / `(false)`; "Swap" radio -> `PHL_SwrapPIPPBP()` (backend writes OP_F6 = 1,
**sleeps 5000 ms**, re-reads OP_60). Both -> `updateMonitorInput(Tag)`.

SmartSize panel (logic 393-440, template 626-700): `OP_86_DisplayScaling.ValueList` split into screen-size entries
(everything not in the aspect list) and aspect entries (`Scaling_NoScaling, Scaling_Aspect, Scaling_Aspect_4to3,
Scaling_Full_16to9, Scaling_1to1_16to9, Scaling_Full_Square, Scaling_1to1_Square, Scaling_24_5, Scaling_27`);
special case: only `Scaling_MaxImage` + `Scaling_Aspect` -> radio "PictureFormat". Sizes sorted by the
numeric part of the name (`xm`, `R/styles-DAnQi2A8.js` 13367). All -> `PHL_SetOSD("OP_86_DisplayScaling", v)`;
disabled `!optionControl[134]`.
User's caps: `86(01 0A 12 13 14 15 16 17 18 19 1A 1B 23)` (Config/data.json, section 6.2).

### 4.9 Setup (monitor) - `R/Setup-D-5j4V-I.js` + `R/FirmwareUpgrade-BsUoyIKp.js`

Property-list page (handler set "Setup" -> `updateMonitorSetup`). Menus (70-302):

| menu | property -> VCP (type) | notes |
|---|---|---|
| Settings (0) | PowerLED OP_F2 (select, option label = numeric value), Language OP_CC (select, label = `text`), ResolutionNotice OP_E9 (switch-block), CEC EXT_OP_E2A0_17 (switch-block), RestoreToFactory (button) | Reset: confirm, `shieldDisplayChange(true)`, `Profile_Reset(DeviceType)` -> Tag = full profile -> (if ENE) `Effect_GetMenu` -> `saveMonitorData` |
| OLEDPanelCare (1) | PixelOrbiting E2A0_34, ScreenSaver _35, FanControl _41, MultiLogoProtection _48, BoundaryDimmer _49, TaskbarDimmer _4A (select); AutoWarning _43, UniBright _47, ThermalProtection _4B, AutoPixelRefresh _61 (switch-block); PixelRefresh _36, PanelRefresh _37 (button "Refresh") | AutoWarning OFF, PixelRefresh, PanelRefresh require a confirm dialog; buttons send `PHL_SetOSD(vcp, On)` |
| OLEDInformation (2) | WorkingTime, TimeAfterPixelRefresh (info, shown if `>-1`, suffix "H"), PixelRefreshCounts _54, PanelRefreshCounts _55 (info) | WorkingTime = `(E2A0_4D<<16) | E2A0_4E`, TimeAfterPixelRefresh = `(E2A0_50<<16) | E2A0_51` (backend `CDevice_PHLDisplay.cs` 518-557) |
| FwUpdate (3) | only if `OTASupport()` (MonitorInfo `SupOTA` && `OTAEnable`) | renders `FirmwareUpgrade` (online) |

Footer marquee: `"Model: " + MonitorEDIDInfo_T.sMonitorName + " | SN: " + sSerialNumber`.
Backend reset (CONFIRMED `CDevice_PHLDisplay.cs` 1998-2019): write `OP_04_RestoreFactoryDefaults = 1`,
clear ENE state, **sleep 5000 ms**, full reload, return the default profile.
The user's monitor is a VA/LCD panel; all OLED VCPs except `_34/_35/_36/_41/_43` report `err_code 9`
(CONFIRMED profile), so OLEDInformation is hidden.

**FirmwareUpgrade for monitors** (CONFIRMED `R/FirmwareUpgrade-BsUoyIKp.js` 64-77 and
`R/styles-DAnQi2A8.js` 33789-34060 `Ry`, 34062-34300 `UpgradeDialog`):

1. `validMonitor()`: `DisplayFW_CheckUpstreamCable()` (Tag bool) - false -> state 1 "FwUpstreamTip";
   `DisplayFW_GetMonitorCount()` (Tag int) - `<1` -> 1, `>1` -> 2 "FwMonitorCntTip" (+ Refresh button).
2. `DisplayFW_GetDeviceList()` -> Tag `[MonitorInformation{ShowName, StrFwVersion, FwVersion:int, ScalerModelName, ScalerBomInfo, UsbHubCount, DeviceType, AdmWarning}]`
   (entry 0 = scaler, DeviceType 1; extra OTA sub-devices named `<model>_<type>`). Rejection -> state 3
   "UpstreamConnectError" with `err_msg` (backend puts the monitor name there for code -536739836).
   Backend error codes: -536739837 no displays, -536739838 >1 monitor, -536735736 not ready, -536858613 update running
   (`DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/PHLDisplayFW.cs` 185-268).
3. **Online**: for each entry `Mv({deviceType: ScalerModelName, componentId: ScalerBomInfo, version: FwVersion, language, hubCnt})`
   -> GET `https://deviceportal.zeasn.tv/direct/component/update` (4.x in section 11).
4. Download (online) via IPC `createDownload(url, hashValue, hashMethod, "")`, progress events
   `downloadProgressUpdate/downloadSuccess/downloadFail` (`Sy`, 33564-33602).
5. Flash: `DisplayFW_UpdateFirmversion(scalerName or "" on retry, deviceType, zipPath)`; IPC
   `shieldDisplayChange(true, 0)`, `shieldPeripheralChange(true)`, `disableTrayExit(true)` during;
   subscribes `FirmwareUpdateProgressData` (Tag `{Name:"Update Firmware Progress", Type:"OSD", Value: 0-100 double}`,
   emitted every 2000 ms while the call blocks). Progress bar = `floor(0.2*download% + 0.8*burn%)`.
   After success: delete zip (`window.nodeApi.unlinkSync`), wait 4000 ms, message by DeviceType:
   1 -> "UpgradeSuccess" (+ bus `displayChange`), 8 (PowerSensor2) or 9 (Ambiglow) -> "RestartComputerTip",
   others -> "RestartMonitorTip". Failure -> hex code `0x` + (code + 2^32).
   Zip must end in `.ZIP` and contain the scaler model name (backend check).

User's scaler (CONFIRMED log 2026-09-26 lines 152-160): ModelName 34M2C8600, BomString
100GPRS2003NA1SXXY, Version V1.01, ScalerName RTD2738VL, hub VID 0x2109 PID 0x8884, "Hub-Scaler: VIA-RTK".

### 4.10 SmartDesktop - `R/SmartDesktop-By8ZEPkl.js`

Windows-only (PowerToys FancyZones). On mount `FancyZones_GetVersion()` -> `{StrVersion, Version, DP_DeviceType, DP_ComponentID}`;
if `StrVersion != "V0.0.0.0"` also `FancyZones_GetData()` -> `{Enable, FancyZonesSettings.Properties.FancyzonesShiftDrag.Value}`.
Online update check `Mv(...)` + download + `runCommand("<exe> /targetDir \"%APPDATA%\\SmartControl\\Modules\\SmartDesktop\"")`.
Controls: enable switch -> `FancyZones_Enable(bool)`, Editor -> `FancyZones_StartEditor()`, shift-drag ->
`FancyZones_SetSetting("FancyzonesShiftDrag", "true"|"false")`. Real log shows the module is not
installed on the user's PC (`PowerToys.FancyZones.exe` missing, log 2026-09-26 line 7). **Drop on Linux.**

### 4.11 Bulb / AmbiScape - `R/Bulb-vdvqR6Jj.js`, `R/AmbiScape-B35D_GM2.js`

`/bulb` redirects to `/bulb/ambiScape`, and back to `/` when no monitor is connected. AmbiScape is a
**Matter smart-bulb** manager (QR scanner, pairing via Wi-Fi list `GetWifiList`, commissioning) that
talks to the main process through IPC `discoverBulb, pairingBulb, commissionBulb, openCommissioningWindow,
identifyBulb, getBulbAttribute, setBulbAttribute, removeBulb, clearCache, destroyBulbProcess`
(`R/styles-DAnQi2A8.js` 34805-34888) and persists `localStorage.bulbListStore`. Screen-follow: when any
bulb has `ambiScapeEnable`, main chunk calls `AmbiScape_EnableFollowVideo(true, 100)` and consumes
`NotifyAmbiScapeFollowVideoData` (Tag `{T,B,R1..R4,L1..L4: {R,G,B}}`, class
`DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/AmbiScapeFollowVideoData.cs`), converting each
zone to HSV and IPC `setBulbAttribute(uniqueId, endpointId, "HSV", {H,S[,V]})` (`R/main-CDosWiM3.js` 2140-2190).
Bulb device appears only if `window.store.ambiScapeEnable` and IPC `checkNodeAvailable()`. The user has
no bulb -> **drop** (Matter is LAN-only, not internet, but out of the user's needs).

### 4.12 Peripheral chunks listed in scope (not needed for the user)

| chunk | device | backend calls |
|---|---|---|
| Setup-B7TUA1KS | mouse pad | `DeviceSteup_LightEnable`, `DeviceSteup_SwitchStartupEffect`; FirmwareUpgrade (peripheral path: `Device_GetDeviceInfo`, online check, `Device_UpgradeFw` or external exe via `findExe`/`runCommand`) |
| Setup-CilyjteY | mouse | above + `DeviceSteup_SetLowBetteryValue`, `_SwitchLightSleep`, `_SetLightSleepTime`, `_SwitchDeepSleep`, `_SetDeepSleepTime` |
| Setup-D1HXv0D_ | keyboard | same as mouse |
| Setup-daShw_PC | headset | `DTS_Open/DTS_Close`, `Device_GetDeviceInfo`, online DTS driver download + `extractZip`/`findExe`/`runCommand "... /targetDir %APPDATA%\G-MenuDTSServe"` |
| Ambiglow-C1UG4F7Y / -xxUfbvEw / -CUjDUSuQ (+ index-7Mj02WAv) | keyboard / mouse / pad | `bu()` `Effect_*` with peripheral DeviceType, `DeviceSteup_LightEnable`, `Effect_SetSelfColors`, LightSync |
| Customize-CsUn_qP7 / -BKPfwQKG | keyboard / mouse | `Button_SetFunc`, `Button_RestButtons` (+ ButtonFunc/Macro helpers) |
| GameMode-CyhaXAEp | keyboard | `Keyboard_GetGameMode/SwitchGameMode/SetGameMode/ResetGameMode`, notification `NotifyKeyboardGameModeChange` |

### 4.13 Shared UI components

`Menu-DxkEEx1J.js`, `Collapse-DHyH0EEZ.js`, `Equalizer-bwdWX0U6.js`, `useMonitorPropertyHandler-BOOFue3H.js`
(PropertyRenderer), `DeviceLayout-pwnPovdh.js`: no backend or IPC calls except DeviceNav's
`PHL_SwitchDisplay` (CONFIRMED by grep). PropertyRenderer types: `select`, `switch`, `switch-block`,
`slider` (0..maxValue), `button` (calls `changeHandler(true, prop)`), `info` (shows `text || value`),
`select-wrap` (children), `custom` (page-drawn).

---

## 5. Master table: functionName -> params -> response -> used by

All monitor calls use DeviceType `100000` where a `dt` is present. "Tag" = `JsonResult.Tag`.
Timings are backend sleeps (CONFIRMED in `CDevice_PHLDisplay.cs` / `SystemOper.cs`); each DDC read over
the USB hub took ~187 ms in the user's log.

| functionName | params | response Tag | used by |
|---|---|---|---|
| Profile_GetDeviceData | dt:int | `T_PHLDisplay_Profile` (6.1) | Monitor shell |
| PHL_ReloadData | - | `T_PHLDisplay_Profile` (ignored). Re-reads every VCP (~11 s on user HW) | Monitor shell ("Sync") |
| PHL_GetConstraints | - | `DisplayFuncConstraints` (ignored) + notification | Monitor shell |
| PHL_SwitchDisplay | sn:string | `T_PHLDisplay_Profile` / error | Overview, DeviceNav |
| Device_DetectionDisplay | - | device list (same as Device_GetConnectList), after 5 s | main (displayChange) |
| PHL_SetOSD | vcpName:string, value:int | `AttributeInfo` of that VCP, or null if unknown name | SmartImage, SmartImageHDR, GameMode, Ambiglow (DDC), Input, Audio, System, Setup |
| PHL_SetSmartImage | value:int | `{Item1: AttributeInfo(OP_DC), Item2: DisplayModuleSmartImage or ...HDR}`; 1000 ms | SmartImage, SmartImageHDR |
| PHL_ResetSmartImage | value:int | same tuple; 1000 ms; error for *_Off | SmartImage, SmartImageHDR |
| PHL_SetColorPreset | value:int | `DisplayModuleSmartImage` | SmartImage |
| PHL_SwitchSmartFrame | value:int (On/Off) | `DisplayModuleGameMode`; up to ~11 s | GameMode |
| PHL_SetSmartFrameSize | value:int | `DisplayModuleGameMode`; 1000 ms | GameMode |
| PHL_SetInputSource | input, pipSrc, mode, size, location (int) | `DisplayModuleInput` | Input, System |
| PHL_SwrapPIPPBP | - | `DisplayModuleInput`; 5000 ms | System |
| PHL_SetAudioEQ | index:int, value:int | `DisplayModuleAudio` | Audio |
| Profile_Reset | dt:int | `T_PHLDisplay_Profile`; 5000 ms + reload | Setup |
| Effect_GetMenu | dt:int | `DisplayEffectMenu {EffectList:[DisplayEffectMenuItem]}` | Monitor shell, Setup (ENE only) |
| Effect_Enable | dt:int, enable:bool | bool | Ambiglow |
| Effect_Change | dt, effect:int | `DisplayEffectInfo` (ENE) / error | Ambiglow |
| Effect_ColorChange | dt, r, g, b | `DisplayEffectInfo` | Ambiglow |
| Effect_RainbowEnable | dt, bool | `DisplayEffectInfo` | Ambiglow |
| Effect_RandomEnable | dt, bool | `DisplayEffectInfo` | Ambiglow |
| Effect_RegionChange | dt, region:int | `DisplayEffectInfo` | Ambiglow |
| Effect_DirectionChange | dt, dir:int | `DisplayEffectInfo` | Ambiglow |
| Effect_BrightnessChange | dt, int | `DisplayEffectInfo` (ignored) | Ambiglow |
| Effect_SpeedChange | dt, int | `DisplayEffectInfo` (ignored) | Ambiglow |
| Effect_Reset | dt | ENE: `DisplayEffectInfo`; DDC: `DisplayModuleAmbiglow`; + `NotifyEffectSyncDevicesChange` | Ambiglow |
| Effect_GetLEDs | dt | `RGB[]` ({R,G,B} bytes) or error | Ambiglow preview (30 ms loop) |
| Effect_GetColorData | - | `EffectColorData {DefColors: RGB[13], SelfColors: string}` | Ambiglow, main init |
| Effect_SetSelfColors | csv:string | `EffectColorData` | Ambiglow |
| Effect_CheckDynamicLightingEnabled | - | int | Ambiglow (2 s poll) |
| Effect_OpenDynamicLightingSetting | - | null | Ambiglow |
| SyncEffect_GetData | - | `T_Sync_Profile {EffectDetailInfo, SyncDevices[]}` | LightSync, main init |
| SyncEffect_EnableDevice | dt:int, json:string | `T_Sync_Profile` | LightSync |
| DisplayFW_CheckUpstreamCable | - | bool | FirmwareUpgrade |
| DisplayFW_GetMonitorCount | - | int | FirmwareUpgrade |
| DisplayFW_GetDeviceList | - | `MonitorInformation[]` or error code | FirmwareUpgrade, device store (localStorage `monitorFw`) |
| DisplayFW_UpdateFirmversion | scaler:string, type:int, zip:string | null (err_code) + `FirmwareUpdateProgressData` | UpgradeDialog |
| AmbiScape_EnableFollowVideo | enable:bool, intervalMs:int | null + `NotifyAmbiScapeFollowVideoData` | main (bulbs) |
| FancyZones_GetVersion / GetData / Enable / SetSetting / StartEditor | -, -, bool, (string,string), - | see 4.10 | SmartDesktop |
| Device_GetDeviceInfo / Device_UpgradeFw / DeviceSteup_* / Button_* / DTS_* / Keyboard_* | peripheral | - | peripheral chunks (4.12) |

All signatures match `DC/Bridge.Lib/Bridge.Lib/Bridge.cs` (lines 49, 99-106, 134-137, 199-352, 409-502, 669-677) - CONFIRMED.

---

## 6. JSON shapes

### 6.1 `T_PHLDisplay_Profile` (response of Profile_GetDeviceData / PHL_ReloadData / Profile_Reset / PHL_SwitchDisplay)

CONFIRMED from `DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/T_PHLDisplay_Profile.cs`,
`DisplayModule*.cs`, `SubModule*.cs`, `DispalyOtherInfo.cs`, `DC/Zeasn.PCenter.Entity.Lib/.../AttributeInfo.cs`:

```jsonc
{
  "EquipmentType": 1, "DeviceType": 100000, "ModelName": "PHL 34M2C8600", "ExtModel": null,
  "IsSmartImageHDR": true,                 // Windows HDR enabled for this output
  "HasUSBSetting": true,                   // any of E2A0_12 / _14 / _15 available
  "OP_DC_DisplayApplication": <AttributeInfo>,   // current SmartImage/HDR mode, ValueList = all modes
  "ModuleSmartImage":    {"Items": [EnumItem], "CurSubSmartImage": {OP_10_Luminance, OP_12_Contrast, OP_F0_SmartContrast,
                          OP_72_Gamma, OP_87_Sharpness, EXT_OP_E2A0_20_ColorSpace, OP_14_SelectColorPreset,
                          OP_16_VideoGainDriveRed, OP_18_VideoGainDriveGreen, OP_1A_VideoGainDriveBlue,
                          OP_8A_Saturation, OP_90_Hue, EXT_OP_E2A0_24_DLBL}, "SubSmartImages": {"<mode>": {...}}},
  "ModuleSmartImageHDR": {"Items": [...], "CurSubSmartImage": {OP_10_Luminance, OP_12_Contrast,
                          EXT_OP_E2A0_3D_LightEnhancement, EXT_OP_E2A0_3E_ColorEnhancement, EXT_OP_E2A0_3F_DarkEnhancement},
                          "SubSmartImages": {...}},
  "ModuleGameMode": {EXT_OP_E2A0_40_AdaptiveSync, _02_MBR, _03_MBRSync, _04_SmartCrosshair, _44_StarkShadowBoost,
                     _45_ShadowBoost, _06_SharpShooter_Size, _25_SharpShooter_Location, _07_LowInputLag,
                     OP_EB_SmartResponse, _4C_Overclock, _08_SmartFrame, _09_SmartFrameSize, _0A_SmartFrameBrightness,
                     _0B_SmartFrameContrast, _0C_SmartFrameHPosition, _0D_SmartFrameVPosition, _59_DualResolution,
                     _68_AutoRefineAIStatus},                     // all EXT_OP_E2A0_* AttributeInfo
  "ModuleAmbiglow": {EXT_OP_E2A0_19_AmbiglowLightMode, _1A_AmbiglowColors, _1B_AmbiglowLightPosition,
                     _1C_AmbiglowLightBrightness, _1D_AmbiglowLightSpeed, _1E_AmbiglowLightDirection, "EffectEnable": bool},
  "ModuleInput": {OP_ED_InputAuto, OP_60_InputSource, OP_A5_WindowSelect, OP_EC_PIPPBPSizeLocation, OP_F6_PIPPBPSwap,
                  "InputSourceList": [EnumItem], "PIPPBPSourceList": [EnumItem], "PIPLocationList": [EnumItem],
                  "InputSourceInfo": {"Mode": int, "Size": int, "Location": int, "PIPPBPSource": int, "InputSource": int}},
  "ModuleAudio": {OP_62_AudioSpeakerVolume, OP_8D_AudioMute, EXT_OP_E2A0_00_AudioMode, OP_E0_AudioSource,
                  "EQItems": [{"Name": "EQ_100", "Index": 0, "Value": 8, "MaxValue": 16}, ...]},
  "ModuleSystem": {EXT_OP_E2A0_3A/3B/3C_HDMIxRefreshRate, _0E_OSDSettingHorizontal, _0F_OSDSettingVertical,
                   _10_OSDSettingTransparency, _11_OSDSettingTimeOut, OP_86_DisplayScaling, _12_USB_C_Setting,
                   _13_USB_StandbyMode, _14_USB_Upstream, _15_KVM, _16_SmartPower, _18_LocalDimming,
                   OP_54_PerformancePreservation, OP_DA_ScanMode, _6B_Profile},
  "ModuleSetup": {OP_F2_PowerLED, OP_CC_OSDLanguage, OP_E9_ResolutionNotifier, _17_CEC, _35_ScreenSaver, _34_PixelOrbiting,
                  _36_PixelRefresh, _37_PanelRefresh, _43_AutoWarning, _47_UniBright, _48_MultiLogoProtection,
                  _49_BoundaryDimmer, _4A_TaskbarDimmer, _4B_ThermalProtection, _61_AutoPixelRefresh,
                  "WorkingTime": int(-1 = n/a), "TimeAfterPixelRefresh": int(-1), _54_PixelRefreshCounts,
                  _55_PanelRefreshCounts, _41_FanControl},
  "ENEEffectEnable": bool,
  "EffectInfo": {"EffectEnable": bool, "CurrEffect": EnumItem, "EffectList": [DisplayEffectDetailInfo], "EffectDetail": DisplayEffectDetailInfo},
  "DispalyData": {"MonitorEDIDInfo_T": {sManufacturer, sManufacturerDate, PlugAndPlayID, sMonitorName, sSerialNumber, sVersion,
                  ScreenSize, TimingRecommandation, DisplayGamma, DisplayTypeAndSignal, RedChromaticity, GreenChromaticity,
                  BlueChromaticity, WhitePoint},
                  "MonitorResolution": "3440x1440", "MonitorFrequency": "175Hz", "MonitorOrientation": "0°"}
}
```

Note the vendor spelling `DispalyData` must be kept.

`AttributeInfo` (sent fields): `{"VCPOpCode": int, "VCPOpCodeName": string, "Value": int|null,
"MinValue": int, "MaxValue": int, "StepValue": int, "ValueList": [EnumItem]|null, "err_code": int}`
(`err_code 0` = supported; `9` = not supported). `VCPOpCode` = VCP byte for standard codes (e.g. 16 for 0x10)
and `0xE2A0xx` for extended codes (e.g. 14852160 = 0xE2A040). `EnumItem` = `{"Name","Text","Value"}`.
The renderer store default also has `ChildItem: null` (unused).
`DisplayEffectDetailInfo` = `{Effect: EnumItem, Speed, Brightness, IsRandomColor, IsRainbowColor, CurRGB:{R,G,B}, BgRGB:{R,G,B}, CurDir, CurRegion, CurStarCount}`.
`DisplayEffectMenuItem` = `{Effect, SupSync, SupSpeed, MinSpeed, MaxSpeed, SpeedStep, SupBrightness, MinBrightness, MaxBrightness, BrightnessStep, SupRandomColor, SupRainbowColor, SupColor, SupBgColor, SupDir, DirList[], SupRegion, RegionList[], SupStarCount, MinStarCount, MaxStarCount, StarCountStep}`.

### 6.2 Ground truth: user's monitor capabilities string

CONFIRMED `%APPDATA%/EvniaServe/Config/data.json` (backend cache of the MCCS
capabilities, key `v1.01_0f`): `model(34M2C8600MV)`, `mccs_ver(2.2)`, standard VCPs
`02 04 05 08 0B 0C 10 12 14(02 04 05 06 07 08 0A 0B 0D) 16 18 1A 52 54(00 01) 60(11 12 0F 15 21 22 2F 35)
62 6C 6E 70 72(50 64 78 8C A0) 86(01 0A 12 13 14 15 16 17 18 19 1A 1B 23) 87 8D(01 02) A4 A5 AC AE B2 B6 C0
C6 C8 CA(01 02) CC(...) D6(01 04 05) DA(00 02) DC(00 01 03 04 05 06 07 08 0B 0E 11 20 21 22 23 24 30 33 51 E2)
DF E9(00 02) E0(01 02 03 05) EC(01 02 03) ED(00 01) F0(00 01) F2(00 01 02 03 04) F6(01) F7(42)`, extended
`E2A000(46..4B) E2A001(00..04) E2A004(00 01 02) E2A006(00..03) E2A007 E2A008 E2A009(01..07) E2A00A..E2A00F
E2A010(00..04) E2A011(00..04) E2A012 E2A013 E2A015(00 01 02) E2A016 E2A017 E2A019(00..07) E2A01A(00..0D)
E2A01B(00..03) E2A01C(00 01 02) E2A01D(00 01 02) E2A020(02 03 04 0F) E2A024(00..04) E2A034(00 02 03 04)
E2A035(00 02 03) E2A036(00 01) E2A038(01) E2A039 E2A040(00 01) E2A041(00 01 02) E2A042(30..3F) E2A043(00 01)
E2A044(00..03)`. (DC values are hex: 00-11 = SmartImage modes Standard 0 .. ConsoleMode 17,
20-24, 30, 33 = HDR modes 32-36, 48 (HDRTrueBlack), 51 (HDRPeak); 51 hex = 81 IllustratorMode; E2 unknown.)

### 6.3 Ground truth: values read during PHL_ReloadData (2026-09-26 08:02:52-08:03:03)

CONFIRMED log lines 1096-1177 (values hex as logged, "max" = logged maxValue):
`DC=0x21 (HDRGame 33)`, `10=0x64`, `12=0x32`, `E2A040=1`, `E2A004=0/2`, `E2A044=0/3`, `E2A006=0/3`,
`E2A007=0/1`, `E2A008=0/1`, `E2A009=1/7`, `E2A00A=0x64/0x64`, `E2A00B=0x32/0x64`, `E2A00C=0/5`, `E2A00D=0/0`,
`E2A019=0/7`, `E2A01A=6/0x0D`, `E2A01B=0/3`, `E2A01C=2/2`, `E2A01D=0/2`, `ED=1`, `60=0x0F (DP1)`, `A5=0`,
`EC=0`, `F6=0`, `62=0`, `8D=2 (unmuted)`, `E2A000=0x46 (OFF)`, EQ bands via `E2A001=0..4`/`E2A039=8/0x10`,
`E2A00E=0x32/0x64`, `E2A00F=0x32/0x64`, `E2A010=0/4`, `E2A011=2/4`, `86=2`, `E2A012=1`, `E2A013=1`,
`E2A015=0/2`, `E2A016=0/1`, `54=2/4`, `DA=2/8`, `F2=1/4`, `CC=2/0x24`, `E9=0/2`, `E2A017=0/1`, `E2A035=2/3`,
`E2A034=3/4`, `E2A036=0/1`, `E2A043=1/1`, `E2A041=1/2`. Write seen from Setup page:
`PHL_SetOSD("EXT_OP_E2A0_43_AutoWarning", 1)` -> `SetTPVExternValue command=e2a043 value=01 result=0`.

Persisted profile (`%APPDATA%/EvniaServe/Theme/User/Default.pcenter`, IgnoreProfile
form, so no ValueList/Min/Max) confirms `err_code 9` (unsupported) for: E2A0_3D/3E/3F, E2A0_02, _03, _45,
_25, OP_EB, _4C, _59, _68, _1E, _3A/_3B/_3C, _14, _18, _6B, _37, _47, _48, _49, _4A, _4B, _61, _54, _55.
So on this monitor the visible GameMode menus are AdaptiveSync, Crosshair, StackShadowBoost, SmartSniper
(Size only), LowInputLag, SmartFrame; System shows OSDSetting, PipPbp, SmartSize, USB (USB-C setting,
KVM, standby), SmartPower, PixelOrbiting(OP_54), OverScan; Setup shows Settings and OLEDPanelCare
(PixelOrbiting E2A0_34, ScreenSaver, FanControl, AutoWarning, PixelRefresh) (INFERRED from Support rules).

---

## 7. Notifications consumed by monitor pages

| FunctionName | Tag | consumer | action |
|---|---|---|---|
| NotifyUIDisplayFuncConstraintsChange | `DisplayFuncConstraints {FuncItems:[{FuncId, FuncName, State}], ModuleGameMode, AudioEQ}` | main (global, `R/main-CDosWiM3.js` 1834) | `setOptionControl` |
| NotifyUIDisplayEffectChange | backend: ValueTuple `(ENEEffectEnable, EffectInfo, ModuleAmbiglow)` -> JSON `{Item1,Item2,Item3}`; renderer expects `{ENEEnable, EffectInfo, ModuleAmbiglow}` (bug B1) | Monitor shell | update EffectInfo or ModuleAmbiglow |
| NotifyEffectSyncDevicesChange | `T_Sync_Profile` | LightSync | re-render |
| FirmwareUpdateProgressData | `{Name, Type:"OSD", Value}` | UpgradeDialog | progress |
| NotifyDeviceConnectionStatus | (ignored) | main | `Device_GetConnectList` + `saveDeviceList` |
| NotifyAmbiScapeFollowVideoData | `{T,B,R1..R4,L1..L4:{R,G,B}}` | main (bulbs) | Matter HSV |
| NotifyHotKeyExecute | `NotificationDataBase {DeviceType, Data: EnumItem}` (monitor hotkeys: brightness/contrast/sharpness/SmartImage/ColorSpace) | **nobody** | UI goes stale until reload (bug B4) |
| NotifyEffectChange | `{DeviceType, Data: EffectInfo}` (monitor LightSync) | not subscribed on monitor pages | - |

---

## 8. IPC and `window.*` surface used by these pages

Preload exposes `window.ipc {send, invoke, on, once, removeAllListeners, listeners}`, `window.nodeApi
{existsSync, mkdirSync, rmdirSync, unlinkSync, readFile(Sync), copyFileSync, getBaseName, pathJoin}`,
`window.store {get,set,delete}` (electron-store schema) - CONFIRMED `work/app-pretty/preload/index.js`
7300-7377. There is **no `window.api`**. Also `window.runConfig {isPackaged, isDebugMode, userDataPath, mac}`.

| IPC | kind | used by (monitor area) |
|---|---|---|
| startupBackendService | invoke -> port | startup |
| getMonitorJsonConfig | invoke -> `{OTAEnable, config}` | startup -> store `configInJson` |
| displayChange (main->renderer) | on | Device_DetectionDisplay |
| shieldDisplayChange(on:bool, secs=4) | send | GameMode/System (`shieldDisplay` props), Input, System PIP, Setup reset, FW flash |
| shieldPeripheralChange(bool) | send | FW flash |
| disableTrayExit(bool) | send | FW flash |
| createDownload(url, hash, method, dir) / cancelDownload(url) + downloadProgressUpdate/downloadSuccess/downloadFail | send/on | FW, SmartDesktop, DTS (online) |
| runCommand(cmd) / extractZip / findExe | invoke | SmartDesktop, DTS, peripheral FW |
| imageResourceDownload / getCloudFileCacheOrDownload | invoke | device images (online) |
| getMac | invoke | OTA query `ruleMac` (online) |
| checkNodeAvailable, discoverBulb, pairingBulb, commissionBulb, openCommissioningWindow, identifyBulb, getBulbAttribute, setBulbAttribute, removeBulb, clearCache, destroyBulbProcess | invoke | AmbiScape |

`window.store` keys touched: `dashboardPreview`, `dashboardPreviewEnable`, `dashboardLocation`,
`overviewType`, `ambiScapeEnable`. localStorage keys: `monitorFw`, `deviceInfo`, `device_image_marks`,
`bulbListStore`.

---

## 9. Vendor bugs and quirks relevant to the port

| id | finding | status | port action |
|---|---|---|---|
| B1 | `NotifyUIDisplayEffectChange` Tag is a C# ValueTuple (`CDevice_PHLDisplay.cs` 786-792, 850-856) -> Newtonsoft emits `Item1/Item2/Item3`; renderer reads `.ENEEnable/.EffectInfo/.ModuleAmbiglow` (`R/Monitor-D4qz4RBn.js` 86-89) -> `Object.keys(undefined)` TypeError on ENE plug/unplug | INFERRED (serializer behaviour), code CONFIRMED | emit named fields `{ENEEnable, EffectInfo, ModuleAmbiglow}` (optionally also Item1..3) |
| B2 | Only the newest request per functionName resolves (1.) | CONFIRMED | answer all; keep semantics |
| B3 | `saveMonitorData` dereferences `EffectInfo.CurrEffect.Value`; backend sets `EffectInfo = null` for non-ENE in `method_4` and relies on the saved profile to repopulate it; a fresh non-ENE profile would break the store (and `new DisplayEffectInfo()` has `EffectList=null`, whose `EffectDetail` getter throws during serialization) | INFERRED | always send a full default `EffectInfo` (DisplayEffectInfo.Default) |
| B4 | `NotifyHotKeyExecute` not consumed | CONFIRMED | optional: re-fetch on it |
| B5 | Speed range in ENE Ambiglow starts at `MinBrightness` (`R/Ambiglow-Dvqon39u.js` 1062-1070, cf. 1049-1056) | CONFIRMED | harmless (both 1) |
| B6 | `SetOSD` on HDR sub-module writes the non-HDR `SubSmartImages` cache (`CDevice_PHLDisplay.cs` 1624-1628) | CONFIRMED | ignore |
| B7 | `PHL_SetOSD` with an unknown name returns `Tag:null`; SmartImage/Audio helpers then throw on `null.VCPOpCodeName` | CONFIRMED | return error instead |
| B8 | optionControl missing-key semantics differ per page (3.4) | CONFIRMED | always send the full `FuncItems` list |
| B9 | `IsSmartImageHDR` follows Windows HDR, but the monitor's `OP_DC` may already be an HDR mode (user log: DC=33 while profile says HDR) | CONFIRMED | on Linux derive from compositor/KMS HDR state or from `OP_DC >= 32` (see 10) |
| B10 | Device image lookup for monitors: store uses raw `modelName` ("PHL 34M2C8600", not in bundled list) and so requests the online image resource on every device-list save, although `DeviceImage` itself strips "PHL" and uses the bundled PNG | code CONFIRMED (`R/styles-DAnQi2A8.js` 44674-44690 vs 33333-33340); model string "PHL 34M2C8600" CONFIRMED as profile ModelName | drop online lookup |

---

## 10. Linux port plan (renderer monitor pages -> backend contract)

Recommended architecture: keep the Electron renderer bundle unchanged (it is data-driven) and replace
EvniaServe with a Linux service that speaks the same SignalR JSON protocol on `localhost:10010/EvniaHub`
(or patch `Jc`/`ou` to a plain WebSocket and keep the JSON envelope). Minimum function set for the
user's 34M2C8600 (no peripherals, no bulb, no online):

1. **Must implement** (all pages functional):
   `Start`, `Device_GetConnectList`, `Device_DetectionDisplay`, `PHL_SwitchDisplay`, `Profile_GetDeviceData`,
   `PHL_ReloadData`, `PHL_GetConstraints` (+ `NotifyUIDisplayFuncConstraintsChange`), `PHL_SetOSD`,
   `PHL_SetSmartImage`, `PHL_ResetSmartImage`, `PHL_SetColorPreset`, `PHL_SetInputSource`, `PHL_SwrapPIPPBP`,
   `PHL_SetAudioEQ`, `PHL_SwitchSmartFrame`, `PHL_SetSmartFrameSize`, `Profile_Reset`, `Effect_Enable`,
   `Effect_Reset`, `Effect_GetColorData`, `Effect_SetSelfColors`.
2. **Stubs** (return success with neutral data): `Effect_CheckDynamicLightingEnabled` -> `-1` (stops the
   2 s poll), `Effect_OpenDynamicLightingSetting` -> null, `SyncEffect_GetData` -> `{EffectDetailInfo:null, SyncDevices:[]}`,
   `SyncEffect_EnableDevice` -> same, `DisplayFW_*` -> hide via `OTAEnable:false` instead,
   `FancyZones_GetVersion` -> `{StrVersion:"V0.0.0.0"}` or remove the SmartDesktop nav item.
3. **ENE lighting (optional, when the ENE USB device is present)**: `Effect_GetMenu`, `Effect_Change`,
   `Effect_ColorChange`, `Effect_RainbowEnable`, `Effect_RandomEnable`, `Effect_RegionChange`,
   `Effect_DirectionChange`, `Effect_BrightnessChange`, `Effect_SpeedChange`, `Effect_GetLEDs`; set
   `ENEEffectEnable=true` in the profile. Protocol is in the ENE report (see Cross-references). Without it,
   the DDC path (`E2A0_19..1E` through `PHL_SetOSD`) gives the full Ambiglow page minus LightSync and the
   live preview.
4. **Capability config**: serve IPC `getMonitorJsonConfig` from a bundled static `MonitorInfo.json`
   (never download); force `OTAEnable:false` to hide FwUpdate; keep `SupLightEffect:true` for the Ambiglow tab.
5. **Profile semantics**: reproduce `ParameterToDevice` (re-apply saved values on connect), per-SmartImage
   `SubSmartImages` cache, and `DisplayFuncConstraints.RecheckFuncConstraints` after every write
   (rules table 3.4); send the constraint notification only when changed and always on `PHL_GetConstraints`.
6. **Timing**: preserve backend sleeps after mode-changing writes (OP_DC 1000 ms, reset 1000/5000 ms,
   PIP swap 5000 ms, SmartFrame polling). DDC over the VIA/Realtek hub took ~187 ms per read; a full
   reload ~11 s - keep the renderer's loading overlay by only answering when done.
7. **HDR page selection**: implement `IsSmartImageHDR` from the Linux output HDR state (KMS connector
   `Colorspace`/`HDR_OUTPUT_METADATA`, or compositor API), falling back to `OP_DC value in SmartImageHDR_E (32..51)`.
   Split `Items` exactly as Windows: HDR items = OP_DC ValueList intersect `SmartImageHDR_E`, SDR items = the rest.
8. **Display hot-plug**: replace `WM_DISPLAYCHANGE` with udev `drm` change events (or RandR/Wayland output
   events) and forward IPC `displayChange`; honour `shieldDisplayChange(on, secs)` (suppress events for
   `secs` seconds after `off`) because AdaptiveSync, SharpShooter, HDMI refresh, input switch and PIP
   re-train the link.
9. **Fix-ups while porting**: B1 (named notification fields), B3 (non-null EffectInfo), B7.
10. **Remove** from the renderer: FwUpdate tab (or keep with `OTAEnable:false`), SmartDesktop route/nav,
    AmbiScape/Bulb, device image downloads, `getMac` usage, all `Mv`/`Ev`/`vv`/`yv` HTTP clients.

---

## 11. Online touchpoints (in or reachable from these pages)

| what | where | endpoint | trigger | strip recommendation |
|---|---|---|---|---|
| Monitor & sub-device FW update check | `R/styles-DAnQi2A8.js` 33075-33112 (`Mv`), called from `Ry().upgradeDetect` 33858-33885 | GET `https://deviceportal.zeasn.tv/direct/component/update?brandId=74&components=<BOM>=<ver>&deviceType=<scaler>&language&push=true&ScalerIC=true&ruleMac=<MAC>&ruleUSBHubCount=` with `Authorization: ZAuth ...` HMAC-SHA1 signature (`Fm`, 13343; embedded key) | opening Setup -> FwUpdate | remove; set `OTAEnable:false` |
| FW download | `Sy` 33564-33602 via IPC `createDownload` | URL from the check response | Upgrade button | remove |
| Peripheral FW check (brandId 134) | same `Mv` via `getFwData` | same host | peripheral Setup pages | remove (no peripherals) |
| SmartDesktop (FancyZones) update/download | `R/SmartDesktop-By8ZEPkl.js` 94-107, 120-127 | same `/component/update` + download, then local installer | SmartDesktop page | drop page |
| DTS driver download | `R/Setup-daShw_PC.js` 47-66, 90-130 | same | headset Setup | drop |
| Device image resources | `R/styles-DAnQi2A8.js` 44445-44510, 39502 | POST `https://pcenter.zeasn.tv/pcenter/device/files {idParams:[{deviceTypeName:"Monitor", deviceModelName:"PHL 34M2C8600"}]}` then IPC `imageResourceDownload` | every `saveDeviceList` for models not in bundled list | remove; 34M2C8600 images are bundled (`work/app/out/renderer/monitor/34M2C8600{,_rear,_source}.png`) |
| MonitorInfo.json refresh | `work/app-pretty/main/index.js` 13508-13545 (main process) | same `/component/update` (deviceType `PhilipsMonitorsOTA`, componentId `PrecisionCenter_Monitors_OTA_JSON`) | backend start | remove; ship static file |
| `navigator.onLine` gating | FirmwareUpgrade/UpgradeDialog/SmartDesktop | - | - | irrelevant once removed |
| Windows Dynamic Lighting | Ambiglow page | local OS setting, not network | 2 s poll | stub -1 |
| AmbiScape Matter bulbs | AmbiScape/Bulb, main | LAN (Matter/Wi-Fi), not internet | bulb enabled | drop |

---

## 12. Open questions

1. Does Newtonsoft in EvniaServe carry any custom `ValueTuple` converter that would name `NotifyUIDisplayEffectChange` fields? None found in `DC/Zeasn.Com.Lib/Zeasn.Com.Lib/Extension_Json.cs`; a live capture of the Notification string on ENE plug/unplug would settle B1.
2. How `DataOSD` builds `ValueList` names per VCP (which enum type per code, and how capability-string values and the logged "maxValue" filter them) - needed so names like `SmartImage_Standard`, `Preset_UserRGB`, `Scaling_*`, `PIPPBP__PIP`, `ON/OFF`, `Num_1_5` match exactly (DDC/Monitor.Lib report).
3. Which condition makes the 34M2C8600's ENE 6K7732 (USB `vid_0cf2`) enumerate: it was present on 2026-09-25 (`CheckENE ... Plug = True`, FW `03 32 07 0F 0B`) and absent on 2026-09-26 (`bEnableENE=False`). USB upstream cable state? This decides whether the Linux port needs the ENE path at all.
4. Exact semantics of `OP_54_PerformancePreservation` on this model: logged value 2 with max 4, caps `54(00 01)`, enum `VCP_54_PixelOrbiting {ON 0, OFF 1}`; the switch uses `Qu` (ON/OFF names) - verify on hardware.
5. `EXT_OP_E2A0_59_DualResolution` write path: backend splits the read value (low byte/high byte vs Overclock) but writes the selected option value raw; unsupported on the user's monitor, so low priority.
6. Whether `DisplayFW_GetMonitorCount`'s EDID/factory model-name comparison (`method_4`) is needed at all once OTA is removed (it is not, INFERRED).
7. Fresh-install behaviour for non-ENE monitors (B3) was not observed; the user's profile already contains a populated `EffectInfo`.

---

## 13. Cross-references (outside this area)

- **Transport/dispatch**: `DC/EvniaServe/Class0.cs`, `Evnia/EvniaHub.cs`, `Evnia/HandleEvent.cs` (hub, reflection dispatch, notification broadcast) - see the backend/transport report.
- **DDC/CI implementation**: `Extension_AttributeInfo.SetValue/GetValue`, `Display.GetStandardValue/GetTPVExternValue/SetTPVExternValue` (log prefix "Hub" = USB-hub DDC path), `DataOSD`, `NewDDCOper`, native `DDCHelperLib.dll`, `RhHidAPI.dll` (Realtek), `GL_SDK.dll` (Genesys). User's hub: VID 0x2109 PID 0x8884 ("VIA-RTK", scaler RTD2738VL), `CheckSupportUSBDDC(0x14)` true. Extended "E2A0" codes are 3-byte VCP-like commands `E2 A0 xx`.
- **ENE lighting**: `DC/Zeasn.USB.ENE.Lib/.../CUSBENE6K7732.cs` (`Plug`, `ParameterSet`, `GetLightColors`, `ParameterLedSync`, `USBCableLivingSwitch`), `ENEDataConvert.MapTMain_ParameterSet`, `work/native/EneEc.dll.c`, `res/data/ENE/PCenter_AmbiglowInfo.json`. FollowVideo screen sampling `ScreenCaptureMgr.CalcRGBs(50, 40, bitmap)` needs a Linux screen-capture replacement (PipeWire/xdg-desktop-portal).
- **Monitor OTA**: `DC/Zeasn.Monitor.Lib` (`MonitorService.UpdateMonitorOTADeviceFirmware`, `OtherOTAUtil`, `GenesysAPI`), `PHLDisplayFW.cs`.
- **Windows HDR**: `CWinSysDisplayHDR` (`Zeasn.Win.Lib`) - needs a Linux replacement (section 10 step 7).
- **Monitor hotkeys** (`PHL_GetHotKeyMenu/Data`, `PHL_SetHotKey*`, `GetHotKeyState`, `PHL_*GamePQ*`, `PHL_ProfileAction` writing `EXT_OP_E2A0_6B_Profile = (0xA0|action)<<8 | idx`) are used by the Setting page, not by the monitor pages.
- **Renderer calls with no Bridge method**: `Setting_EnableAllowControlLights`, `Setting_TurnOffLightsWhenDisplayTurnOff` (`R/styles-DAnQi2A8.js` 29911-29914) will always fail with "method not found"-style errors.
- **Electron main**: `getMonitorJsonConfig`, `verifyMonitorInfoJson`, `shieldDisplayChange`, `hookWindowMessage(126)`, download manager, Matter controller (`resources/matter/control.mjs`) - see `docs/re/01-electron-main.md`.
- **Online account/feedback**: localStorage `monitorFw`/`deviceInfo` written by the device store are consumed by the feedback window (online) - feedback report.
