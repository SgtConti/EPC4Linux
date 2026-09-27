# Evnia Precision Center 1.13.0: renderer peripheral pages and their backend contract (RE spec)

## Summary

This document specifies what the Vue renderer's **peripheral** pages (keyboard, mouse, mouse pad, headset, and the shared
button, macro, onboard-memory, sensitivity, lighting and light-sync components) and the **device home/list UI** send to
the backend and what they expect back. It covers every `functionName` invoked, the parameter order and JSON types, the
response fields the renderer actually reads, the notifications it consumes, and the IPC it uses. It also flags
online dependencies (feedback, cloud macros, device-image lookup, DTS driver download) and identifies what only makes
sense with Philips peripherals.

Key findings:

- **All backend calls live in the shared chunk** `styles-DAnQi2A8.js`. The page chunks only call wrapper objects
  (`Dy.device.keyboard.*`, `Dy.macro.*` and so on). The page-to-wrapper-to-`functionName` mapping is therefore
  exhaustive and mechanical (sections 1.3 and 5).
- **Every peripheral page is Philips-hardware-only.** The backend only instantiates drivers for VID `0x25AA` (and
  `0x3554` for one SPK8618 dongle), taken from `resources/bin/res/data/PCenter_DeviceInfo.json`. The user's real logs
  show one connected device, `PHL_CDeviceDisplay` (DeviceType 100000). No Philips keyboard, mouse, pad or headset is
  present (CONFIRMED, `EvniaServe/logs/2026-09-26.txt:1006-1007`). All of these routes are unreachable for this user
  because the Overview only lists connected devices.
- **Some peripheral calls still run on the monitor-only system.** At startup and on Home mount the renderer calls
  `Macro_GetFuncMenu`, `Macro_GetList("User")`, `SyncEffect_GetData` and `Effect_GetColorData`. The Settings page also
  calls `GetPairDevices`. The log confirms all of these. A Linux backend must answer them with benign empty data.
- **Light Sync is a no-op with a single device.** The backend clears all `SyncStatus` flags when two or fewer devices
  are synced (CONFIRMED, `SystemOper.cs:1518-1533`). Light Sync is therefore meaningless for a monitor-only setup.
- **The device list itself triggers a cloud call.** `saveDeviceList()` sends any model name that is not in the built-in
  list to `POST https://pcenter.zeasn.tv/pcenter/device/files`. The monitor's model name is `"PHL 34M2C8600"` (with the
  `PHL ` prefix), and the built-in list contains `"34M2C8600"`, so the check misses. INFERRED: this cloud call fires on
  every device-list refresh for this user.
- **Two mouse settings are OS settings, not device settings.** Mouse double-click speed and scroll speed call Windows
  `SystemParametersInfo` (CONFIRMED, `DoubleClickSpeedData.cs:59-81`, `ScrollSpeedData.cs:59`).
- **The feedback window uploads a lot of local data to the cloud.** It sends today's full backend log (which contains
  HID enumeration, EDID and the monitor serial), the machine's MAC address, hostname, OS info and firmware versions.
  Strip it.
- **The renderer and Bridge disagree in places.** The renderer calls `Setting_EnableAllowControlLights`,
  `Setting_TurnOffLightsWhenDisplayTurnOff`, `Theme_EnableSmartImage` and `Theme_SetSmartImage`, none of which exist in
  `Bridge.cs`. The first two wrappers are dead code. Only the newest in-flight request per `functionName` ever resolves.
  Parameters are type-matched strictly (int, string or bool only).
- **Scope correction.** The task text called `GameMode-C1cXG-_T.js` the keyboard game mode page. The router shows it is
  the **monitor** Game Mode page (`/monitor/gameMode`). The keyboard game mode page is `GameMode-CyhaXAEp.js`. Both are
  documented here (sections 4.9 and 4.17).

Path abbreviations used below:

| Abbrev | Path |
|---|---|
| `R/` | `work/app-pretty/renderer/assets/` |
| `S` | `R/styles-DAnQi2A8.js` (shared chunk: API wrappers, stores, router, many components) |
| `M` | `R/main-CDosWiM3.js` (App, Startup, Home, Sidebar) |
| `B` | `work/dotnet-clean/Bridge.Lib/Bridge.Lib/Bridge.cs` |
| `SO` | `work/dotnet-clean/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs` |
| `E/` | `work/dotnet-clean/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/` |
| `MAIN` | `work/app-pretty/main/index.js` |
| `LOG` | `%APPDATA%/EvniaServe/logs/2026-09-26.txt` |

Evidence levels: **CONFIRMED** means read in code or seen in logs. **INFERRED** means reasoned from code without
direct observation.

---

## 1. Transport as the peripheral pages see it

The wire protocol and backend dispatcher are specified in `docs/re/05-backend-host.md` §3. This section only lists what
the renderer requires.

### 1.1 Hub client (`S:7888-8030`, class `Jc`)

| Item | Value | Evidence |
|---|---|---|
| URL | `http://localhost:${port}/EvniaHub`, port 10010 (`ou(e = 10010)`, `S:8024`) | CONFIRMED |
| Transport | SignalR JSON hub protocol, WebSockets only, `skipNegotiation: true`, `timeout: 120000` ms, automatic reconnect | CONFIRMED `S:7902` |
| Hub events listened | `"GetTaskAsync"` and `"Notification"`, same handler `handleResponse(JSON.parse(arg))` (`S:8022`, `register()`) | CONFIRMED |
| Request | `hub.invoke("GetTaskAsync", JSON.stringify({functionName, requestId, parms}))`. `parms` is the positional argument array, or `null` when there are no arguments. The renderer **never** sends `device`, so every device type is passed inside `parms` as the first argument. | CONFIRMED `S:7942`, LOG lines 8-1235 |
| requestId | Timestamp-seeded UUIDv4-like string (`createUUID`) | CONFIRMED |
| If not connected | Waits 4000 ms once, then sends anyway | CONFIRMED `S:7921-7925` |
| Response | `{FunctionName, RequestId, err_code, err_msg, Tag}`. The promise resolves with `Tag` only if `err_code === 0` **and** `err_msg` is falsy. Otherwise it rejects with `{code: err_code, msg: err_msg}`. A Linux backend must therefore send `err_msg: ""` or `null` on success. | CONFIRMED `S:7930-7934` |
| Only the newest request resolves | `waitingResponse[functionName] = requestId`. A response is dispatched only if its RequestId is the latest one sent for that functionName, unless the function is in `allowConcurrentlyMethods = ["Theme_GetThemeInfos","DeviceSteup_GetPowerInfo"]`. Older in-flight calls for the same functionName **never settle**. | CONFIRMED `S:7928`, `S:7975-7983`, `S:8028` |
| Notifications | Any message with a falsy `RequestId` is dispatched to `notifyCallbacks[FunctionName]`, which receives `Tag` | CONFIRMED `S:7984-7993` |
| Log suppression | `Effect_CheckDynamicLightingEnabled`, `Effect_GetLEDs` and `NotifyAmbiScapeFollowVideoData` are not console-logged | CONFIRMED `S:8027` |

### 1.2 Backend parameter binding

This constrains every call in section 5. The dispatcher `work/dotnet-clean/EvniaServe/Class0.cs:117-171`
(`method_2`) selects the `Bridge` overload whose parameter count and **exact** types match the JSON token types:

- JSON Integer maps to `int`, String to `string`, Boolean to `bool`.
- Any other token type (float, null, object, array) is rejected with `Unsupported parameter type`.

CONFIRMED consequences:

- Structured arguments are sent as **JSON strings**. Examples are `SyncEffect_EnableDevice(int, string selDevices)`,
  `Macro_Update(..., string macroData)` and `DTS_SetGeqBandGain(int, string)`.
- `Mouse_ChangeLod(int, string)` works only because `ParamMouse.LodItems` is `List<string>` (`E/ParamMouse.cs`), so the
  renderer sends the string it received.
- Overloads are selected by arity. `Macro_GetDetail` takes either (theme, name) or (filePath).

Notification envelope (CONFIRMED, `work/dotnet-clean/EvniaServe/Evnia/HandleEvent.cs:87-99`): a `JsonResult` is
serialized and sent via `Clients.All.SendAsync("Notification", json)`. Most peripheral notifications use the shape
`Tag = NotificationDataBase {DeviceType:int, Data:any}` (`E/NotificationDataBase.cs`). The exceptions are listed in
section 6.

### 1.3 API wrapper objects

The table below maps the minified export letters in `S` (export block at the end of `S`) to the wrapper objects the
pages use.

| Export | Local | Wrapper | Defined at | Main functionNames |
|---|---|---|---|---|
| `G` | `Dy` | aggregate `{system, fancyZones, theme, device, macro, subscribe, subscribeIfAbsent, unsubscribe}` | `S:33761` | all |
| `aS` | `Gh()` | `system` | `S:29887-29955` | `Start`, `Device_*`, `Setting_*`, `FactoryReset`, `GetPairDevices`, `CanEnterPairing`, `EnterPairing`, `GetWifiList`, `Theme_GetDevicesBasicInfo`, `Effect_CheckDynamicLightingEnabled`, `Effect_OpenDynamicLightingSetting` |
| `bq` | `Hu(e)` | `device = {monitor, keyboard, mouse, mousePad, headset, button, light, setup, onboard}` | `S:8758` | |
| `a$` | `nu(e)` | `setup` | `S:8033-8074` | `DeviceSteup_*`, `Device_UpgradeFw` |
| `aP` | `yu(e)` | `monitor` | `S:8310-8503` | `PHL_*`, `Profile_GetDeviceData`, `Effect_*`, `DisplayFW_*` |
| `b0` | `Du(e)` | `keyboard` | `S:8504-8525` | `Profile_GetDeviceData`, `Keyboard_*GameMode` |
| `b6` | `Tu(e)` | `mouse` | `S:8526-8568` | `Profile_GetDeviceData`, `Mouse_*` |
| `bm` store / `Pu` | `Pu(e)` | `mousePad` | `S:8569-8578` | `Profile_GetDeviceData` |
| `bw` | `Au(e)` | `headset` | `S:8579-8618` | `Profile_GetDeviceData`, `DTS_*` |
| `aq` | `bu(e)` | `light` | `S:8619-8676` | `Effect_*`, `SyncEffect_*`, `AmbiScape_EnableFollowVideo` |
| `bl` | `Ru()` | `onboard` | `S:8677-8703` | `Profile_*Onboard*`, `Profile_GetBoard` |
| `a_` | `Lu(e)` | `button` | `S:8732-8757` | `Button_*` |
| `b1` | `yy()` | `macro` | `S:33724-33760` | `Macro_*` |
| `A` | `tu` | raw hub client | `S:8024` | |

Each wrapper factory closes over a default device type `e`. Each method takes an optional trailing device type
(`t || e`). `Dy.device` is built with `e === undefined`, so the callers always pass `deviceType` explicitly, or create
a dedicated instance such as `Tu(Y.value)`.

Pinia stores that parse responses (their field reads define the response shapes):

| Store | Export | Line |
|---|---|---|
| `keyboard` (`jm`) | `V` | `S:13436` |
| `mousePad` (`qm`) | `bm` | `S:13605` |
| `mouse` (`Qm`) | `W` | `S:13662` |
| `headset` (`Yu`) | `X` | `S:8801` |
| `macros` (`IP`) | `z` | `S:40744` |
| `main` (`Ab`, device list) | `s` | `S:44514` |
| `dashboard` (`Jm`) | | `S:13987` |

---

## 2. Domain model used by the peripheral pages

### 2.1 Equipment types and routes

| EquipmentType | Renderer `Fl` (`S:5663`) | C# `EquipmentType` (`E/EquipmentType.cs`) | Route root (`vb`, `S:43772`) |
|---|---|---|---|
| 1 | Monitor | Display | `/monitor` |
| 2 | Keyboard | Keyboard | `/keyboard` (children `customize`, `ambiglow`, `gameMode`, `macro`, `setup`, `onboard`) |
| 3 | Mouse | Mouse | `/mouse` (children `customize`, `ambiglow`, `Sensitivity`, `macro`, `setup`, `onboard`) |
| 4 | MousePad | MousePad | `/pad` (children `ambiglow`, `setup`) |
| 5 | Headset | Headset | `/headset` (children `microphone`, `setup`) |
| 6 | Bulb (renderer-only pseudo-device for AmbiScape/Matter) | n/a | `/bulb` |

### 2.2 Philips device table

This is the backend's supported-device table (CONFIRMED, `Evnia Precision Center/resources/bin/res/data/PCenter_DeviceInfo.json`).
`DeviceType` is the integer the renderer passes as the first parameter. Only these USB IDs are ever matched.

| DeviceType | Model (ExtModel) | Kind | VID:PID | ConnectMode | Battery | Effect | Sync | GameMode | ProfileCount | Vendor (FactoryType) |
|---|---|---|---|---|---|---|---|---|---|---|
| 100000 | Display | Monitor | n/a (DDC) | -1 | no | yes | yes | no | 1 | PHL |
| 200000 | SPK8708 | Keyboard | 25AA:2007 | USB | yes | yes | yes | yes | 4 | RongYuan |
| 200001 | SPK8508 | Keyboard | 25AA:2006 | USB | no | yes | yes | yes | 4 | RongYuan |
| 200002 | SPK8308 | Keyboard | 25AA:2005 | USB | no | yes | yes | yes | 4 | RongYuan |
| 200003 | SPK8708 | Keyboard | 25AA:2007 | BLE | yes | yes | yes | yes | 4 | RongYuan |
| 200004 | SPK8708 | Keyboard | 25AA:2008 | Dongle | yes | yes | yes | yes | 4 | RongYuan |
| 201000 | SPK8618 | Keyboard | 25AA:200D | USB | yes | yes | no | no | 1 | BeiYing |
| 201001 | SPK8618 | Keyboard | 3554:FA09 | Dongle | yes | yes | no | no | 1 | BeiYing |
| 300000 | SPK9708 | Mouse | 25AA:4007 | USB | yes | yes | yes | no | 4 | RongYuan |
| 300001 | SPK9508 | Mouse | 25AA:4006 | USB | no | yes | yes | no | 4 | RongYuan |
| 300002 | SPK9308 | Mouse | 25AA:4005 | USB | no | yes | yes | no | 4 | RongYuan |
| 300003 | SPK9708 | Mouse | 0000:0000 | BLE | yes | yes | yes | no | 4 | RongYuan |
| 300004 | SPK9708 | Mouse | 25AA:4008 | Dongle | yes | yes | yes | no | 4 | RongYuan |
| 301000 | SPK9718 | Mouse | 25AA:4010 | USB | yes | no | no | no | 1 | JiangMeng |
| 301001 | SPK9718 | Mouse | 25AA:400F | Dongle | yes | no | no | no | 1 | JiangMeng |
| 301002 | SPK9728 | Mouse | 25AA:400D | USB | yes | no | no | no | 1 | JiangMeng |
| 302000 | SPK9618 | Mouse | 25AA:200F | USB | yes | no | no | no | 1 | YongJiaXing |
| 302001 | SPK9618 | Mouse | 25AA:2010 | Dongle | yes | no | no | no | 1 | YongJiaXing |
| 302002 | SPK9418 | Mouse | 25AA:2011 | USB | yes | no | no | no | 1 | YongJiaXing |
| 302003 | SPK9418 | Mouse | 25AA:2012 | Dongle | yes | no | no | no | 1 | YongJiaXing |
| 303000 | SPK9618 (3395) | Mouse | 25AA:4019 | USB | yes | no | no | no | 1 | HaiHui |
| 303001 | SPK9618 (3395) | Mouse | 25AA:4018 | Dongle | yes | no | no | no | 1 | HaiHui |
| 303002 | SPK9618 (3395) | Mouse | 0000:0000 | BLE | yes | no | no | no | 1 | HaiHui |
| 303003 | SPK9618 (8960) | Mouse | 25AA:401B | USB | no | no | no | no | 1 | HaiHui |
| 303004 | SPK9618 (8960) | Mouse | 25AA:401A | Dongle | no | no | no | no | 1 | HaiHui |
| 400001 | SPL7508 | Mouse pad | 25AA:8002 | USB | no | yes | yes | no | 1 | RongYuan |
| 500000 | TAG4106 | Headset | 25AA:6002 (UP 0x000C) | USB | no | no | no | no | 1 | ZEASN |
| 500001 | TAG5106 | Headset | 25AA:6003 (UP 0xFF01) | USB | no | no | no | no | 1 | ZEASN |

The user's HID devices in the logs are `0000:0001`, `0000:0002` and `0000:0003` (anonymized keyboard, mouse and audio device), plus hub and other entries
`0CF2:A201` and `2109:*` (CONFIRMED, LOG enumeration at lines 11-24 and across all log files). None of them is a
Philips peripheral. `0CF2:A201` is an ENE controller, INFERRED to be the monitor's own Ambiglow controller; see the
cross-references.

### 2.3 Enums on the wire

All values below are CONFIRMED from `E/*.cs`. Names hidden by the deobfuscator were recovered from the obfuscated copy
in `work/dotnet/...`.

| Enum | Values |
|---|---|
| `ConnectMode` | -1 Unknown, 0 USB, 1 BLE, 2 Dongle. The renderer `xl` (`S:5812`) uses 0 USB, 1 BLUETOOH, 2 DONGLE. |
| `ChargeStatus` | -1 Unknown, 0 UnCharging, 1 Charging, 2 Full (`zl`, `S:5819`) |
| `ButtonLayer` | 1 LayerBase, 2 LayerFn. It is used as a **bit mask**: `Button_RestButtons(device, 3)` resets both layers (CONFIRMED, `JiangMengMouse_Oper.cs:318-332`, `layer.HasFlag`). |
| `ButtonMenu` | -1 NULL, 0 Preset, 1 Disable, 2 KeyboardFunc, 3 MouseFunc, 4 SwitchDPI, 5 Macro, 6 Text, 7 SwitchProfile, 8 SwitchLighting, 9 LaunchProgram, 10 Media, 11 PShiftKey, 12 AppUser, 13 DeviceFunc |
| `ButtonSubMenu_Keyboard` | -1 NULL, 0 KeyRecording, 1 Alphanumeric, 2 Function, 3 Numpad, 4 Navigation, 5 Modifiers, 6 Symbols, 7 SymbolsMore |
| `ButtonSubMenu_Mouse` | -1, 0 MouseClick, 1 DPIAdjustment, 2 Navigation, 3 Profile |
| `ButtonSubMenu_DeviceFunc` | -1, 0 ResetDevice, 1 OnboardProfile, 2 Light, 3 Switchlayout, 4 BatteryStatus, 5 BluetoothParing, 6 KeyboardGameMode, 7 MacroRecord |
| `ButtonSubMenu_AppUser` | -1, 0 Productivity, 1 Windows, 2 Editing, 3 Navigation |
| `ButtonExtFunc` (`ext` string) | `"ApplyToThemeCycleProfiles"`, `"ApplyToThemeCycleOnBoards"` |
| `MacroType` | 0 Null, 1 KeyBoard, 2 Mouse, 3 Text, 4 RunCommand (renderer `Ll`, `S:5646`: NONE, KEYSTROKE, MOUSE_BUTTON, TYPE_TEXT, RUN_COMMAND) |
| `MacroAction` | 0 Null, 1 Down, 2 Up (renderer `Hl`: NONE, PRESS, RELEASE) |
| `MacroPlayType` | -1 Null, 0 MacroPlayOnce, 1 MacroPlayMultiple, 2 MacroTogglePlayback, 3 MacroPressToPlay |
| `KeyboardGameModeType` | 0 AllKey, 1 LockWin, 2 LockAltAndF4, 3 LockAltAndTab, 100 SwitchWASD |
| `DirectionType` | -1 Default, 0 L→R, 1 R→L, 2 Up→Down, 3 Down→Up, 4 Gathered, 5 Spread, 6 ClockWise, 7 CounterClockWise, 8 LeftOrBotton, 9 RightOrTop, 10 Sequence, 11 Clip |
| `RegionType` | -1 Default, 0 AllZones, 1 FourSided, 2 Central, 3 Bottom, 4 ThirdSidedA, 5 ThirdSidedB |
| `EffectType` | 0 Off, 1 FollowVideo, 2 FollowAudio, 3 ColorShift, 4 ColorWave, 5 Breathing, 6 StarryNight, 7 Static, 8 Blink, 9 Neon, 10 ColorWaveW, 11 ColorWaveLine, 12 Radar, 13 Laser, 14 Ripple, 20 PressActionOn, 21 PressActionOff, 22 Coverge, 23 Kaleidoscope, 24 Dazzing, 25 RainDown, 26 Meteor, 101-115 BeiYing_* |

`ButtonFunc` (`work/dotnet/.../ButtonFunc.cs`, CONFIRMED) is the function id carried in `funcId` / `newFun`:

| Group | Values |
|---|---|
| Keys | **USB HID keyboard usage IDs**: `KEY_a`=4 … `KEY_z`=29, `KEY_D1`=30 … `KEY_D0`=39, `KEY_ENT`=40 … `KEY_UP`=82, `KEY_LCTRL`=224 … `KEY_RWIN`=231. Upper-case and "_2nd" variants are the base usage + 256 (for example `KEY_A`=260, `KEY_F13`=314). `KEY_Fn`=2560. |
| Mouse | `Mouse_DoubleClick`=512, `Mouse_LeftClick`=513, `Mouse_RightClick`=514, `Mouse_ScrollClick`=515, `Mouse_Backward`=516, `Mouse_Forward`=517, `Mouse_ScrollUp`=518, `ScrollDown`=519, `ScrollLeft`=520, `ScrollRight`=521, `Mouse_DPIForward`=522, `DPIBackward`=523, `DPICircle`=524, `DPIForwardCircle`=525, `DPIBackwardCircle`=526, `Mouse_SmartDPI`=527 |
| Menu actions | `Preset`=768, `Disable`=769, `Macro`=784, `Text`=800 |
| Profiles | `NextProfile`=817 … `SpecificProfile`=821 |
| Lighting | `EffectOnOrOff`=833, `NextLight`=834 … `SpecificLight`=838 |
| Launch | `LaunchExe`=864, `LaunchWebsite`=865 |
| Media | `Media_Mute`=880 … `Media_Stop`=886 |
| P-Shift | `PShiftKey`=912 |
| Windows shortcuts | `User_*` = 928-998 (Windows shortcuts such as LaunchCalc, LockScreen, OpenGameBar, Copy, Paste) |
| Device functions | `Fn_*`=2561-2567, `ResetDevice`=2608, onboard profile cycling 2609-2614, layout switches 2615-2618, light control 2624-2637, `BatteryStatus`=2640, `BluetoothParing`=2641, `KeyboardGameMode`=2642, `MacroRecord`=2643 |

### 2.4 Renderer-side key maps (all in `S`)

| Map | Line | Meaning |
|---|---|---|
| `Yl` | `S:5686-5811` | Windows **virtual-key code** to name (for example 65 → `KEY_A`, 112 → `KEY_F1`, 173 → `Media_Mute`). Used to label recorded macro keystrokes and `KeyRecording` button bindings. The recorded values are DOM `KeyboardEvent.keyCode`, which match Windows VK codes. |
| `Kl` | `S:5679-5685` | Mouse macro values 513-517 (Left, Right, Scroll(middle), Backward, Forward) |
| `Ul` | `S:5678` | DOM `MouseEvent.button` to macro value: `{0:513, 1:515, 2:514, 3:516, 4:517}` |
| `Ju` | `S:9084` | Modifier codes (HID usages) 224 LCTRL, 225 LSHIFT, 226 LALT, 228 RCTRL, 229 RSHIFT, 230 RALT, used in `ExtButton.Modify1..3` |
| `Zu` | `S:9077-9083` | Keyboard ButtonIds with special names: 102 `KEY_SHORTCUT_1`, 108 `KEY_SHORTCUT_2`, 114 `KEY_ROLL_PRESS`, 124 `KEY_ROLL_DOWN`, 125 `KEY_ROLL_UP` |
| `kl` | `S:5662` | Maximum macro step delay 65000 ms |

---

## 3. Device home and list UI

### 3.1 Startup sequence

Startup is handled by the `Startup` component (`M:151-265`, backend init at `M:185-210`).

1. IPC `startupBackendService` (spawns EvniaServe). Then the hub connects (`ou(port).run()`).
2. `Start()`. Before it returns, the renderer records whether an IPC `displayChange` or `USBChange` arrived during
   init. If one did, it calls `Device_DetectionDisplay()` and/or `Device_DetectionUSB()` (`M:186-196`).
3. `Device_GetConnectList()`, then `main.saveDeviceList(list)` (`M:197-198`, `S:44635`).
4. `C()`: `Theme_GetThemeInfos()`, `Theme_GetCurTheme()`, `Macro_GetFuncMenu()` (Items go to the macros store) and
   `Macro_GetList(curTheme.Name)` (`M:202-210`). `C()` is re-run on the `factoryReset` bus event.
5. IPC `getMonitorJsonConfig`, then `interfaceInitializeCompleted`.
6. On hub reconnect: `Start()` again, and the display/peripheral shields are cleared (`M:211-222`).

The user's log confirms this order (CONFIRMED, LOG:8-1018):

`Start` → `Device_GetConnectList` → `DisplayFW_GetDeviceList` (the `saveDeviceList` side effect) → `Theme_GetThemeInfos`
→ `SyncEffect_GetData` → `Effect_GetColorData` → `Theme_GetCurTheme` → `Macro_GetFuncMenu` → `Macro_GetList ["User"]`.

`Start` took about 21 s on this machine (07:52:30.9 to 07:52:52.4).

### 3.2 Home mount

Home is at `M:1698-1960`. On mount it:

- Calls `SyncEffect_GetData()`, then `main.saveSyncModels(SyncDevices)`. The store keeps only the `ModelName` values
  whose `SyncStatus` is true (`S:44800`).
- Calls `Effect_GetColorData()`, then `main.saveEffectColors`. `DefColors[]` becomes swatch values 100 and up.
  `SelfColors` (comma-separated `#rrggbb`) becomes swatch values 200 and up (`M:1826-1831`, `S:44802-44813`).
- Subscribes to `NotifyUIDisplayFuncConstraintsChange` (monitor, out of scope), `NotifyUISwitchTheme`,
  `NotifyMacroKeyPressed`, `NotifyMouseDPIChange`, `BatteryLowPowerReport` and `NotifyDeviceConnectionStatus`.
- Handles the bus event `rescan`: navigate to the Overview, show loading, disable the tray, then call `Device_Rescan()`
  and `saveDeviceList` (`M:1844-1855`).

### 3.3 Hot-plug

Hot-plug handling is in `M:1734-1814`, with the main-process side at `MAIN:17235-17241` and `MAIN:17661-17684`.

| Source (Windows main process) | IPC to renderer | Debounce in main | Renderer call | Loading key |
|---|---|---|---|---|
| `WM_DISPLAYCHANGE` (0x7E, `hookWindowMessage(126)`) | `displayChange` | 2000 ms trailing; suppressed while `shieldDisplayChange` is true | `Device_DetectionDisplay()`. The backend itself sleeps 5000 ms first (`SO:241-246`). | `public` |
| `usb` npm module attach/detach | `USBChange` | 1000 ms, then a 2 s lock | `Device_DetectionUSB()` (scans non-BLE drivers) | `USBChange` |
| `WM_DEVICECHANGE` (0x219, `hookWindowMessage(537)`) | `otherDeviceChange` | 1700 ms, then a 2 s lock | `Device_OtherDeviceChange()` (scans BLE drivers) | `otherDevice` |
| Backend notification `NotifyDeviceConnectionStatus` | n/a | n/a | `Device_GetConnectList()`, ignored while the `shieldPeripheralChange` flag is set | `public` |

All four return the same thing as `Device_GetConnectList`. Each handler coalesces re-entrant triggers: a trigger that
arrives during a call causes exactly one re-run afterwards.

After the list is saved:

- If the list is not empty, the renderer emits bus `refreshDeviceData`, and every open device page reloads its data.
- If it is empty, it navigates to the Overview.

The log shows this in practice (CONFIRMED): `Device_OtherDeviceChange` at 07:54:01 (a Windows `WM_DEVICECHANGE`,
per the Electron log line "otherDeviceChange send") → `DisplayFW_GetDeviceList` → `Profile_GetDeviceData [100000]`.

### 3.4 `Device_GetConnectList` response

`Tag` is a `DeviceInfo[]` (`SO:737-751`). `DeviceInfo` extends `DictDeviceInfo` (`E/DictDeviceInfo.cs`,
`E/DeviceInfo.cs`); `[JsonIgnore]` computed members are excluded.

| Field | Type | Read by renderer (`Tb`, `S:44421-44444`) |
|---|---|---|
| `DeviceType` | int (see 2.2) | `deviceType` (the id sent in all later calls) |
| `EquipmentType` | int 1-5 | `equipmentType` |
| `ModelName` | string | `modelName` |
| `ExtModel` | string | `modelNameExt` |
| `ConnectMode` | int | `connectMode` |
| `StrFwVersion` | string | `displayFwVersion` |
| `FwVersion` | int | `detectFwVersion = FwVersion.toString()`. **Required**: if it is missing, `Tb` throws. |
| `MaxFw` | not in the C# class | `maxFw` (always undefined) |
| `SupSync` | bool | `syncSupport`, `moduleSupport.effectSync` |
| `Pid`, `Vid` | ushort | `pid`, `vid` (also used for image keys) |
| `ExtDeviceInfo` | object | `extInfo` |
| `HasBattery` | bool | `moduleSupport.battery` |
| `SupEffect` | bool | `moduleSupport.effect` (shows or hides the Ambiglow tab) |
| `SupGameMode` | bool | `moduleSupport.gameMode` (shows or hides the keyboard GameMode tab) |
| `ProfileCount` | int | `moduleSupport.onboard = ProfileCount > 1` |
| `FactoryType`, `IUSB_USAGE_PAGE`, `IUSB_USAGE`, `CreateDevice`, `CheckFState`, `Extra` | | not read |

`ExtDeviceInfo` by kind:

- **Monitor**: `ExternDispalyInfo {CurSN, DisplayList:[UIDisplayInfo{DisplayName, MonitorName, DeviceName, DisplaySN}]}`
  (`work/dotnet-clean/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/ExternDispalyInfo.cs`,
  `work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Entity.Lib/UIDisplayInfo.cs`). `saveDeviceList` expands one
  Monitor record into one entry per `DisplayList` element, with `AliasName = DisplaySN` and `ModelName = MonitorName`.
  The active monitor is the one whose `aliasName === CurSN` (`S:44660-44666`).
- **Headset**: `DTSExternInfo {DTSDectected, StrDTSVersion, DTSVersion, DTSFilePath, DTS_DP_DeviceType, DTS_DP_ComponentID}`
  (`E/DTSExternInfo.cs`).
- **Some mice**: `IDCode` is used in image keys (INFERRED from `S:33349`).

### 3.5 `saveDeviceList()` side effects (`S:44635-44705`)

- **localStorage `deviceInfo`**: `[{modelName, fwComponentID: extInfo.DP_ComponentID, fwVersion}]`. Only the feedback
  window reads this (section 4.16).
- **Monitor firmware list**: if any monitor is present, the renderer calls `DisplayFW_GetDeviceList()` and stores
  `[{modelName: ShowName, fwComponentID: ScalerBomInfo, fwVersion: StrFwVersion}]` in localStorage `monitorFw`
  (CONFIRMED by LOG:1011, 1079, 1234). This is also only used by feedback.
- **Cloud device-image lookup** (online, see Online touchpoints #1):
  - For every non-Bulb device whose `modelName` is **not** in the built-in list `ry` (`S:33282-33303`), the renderer
    builds the key `Monitor!<modelName>`, or for peripherals `<Type>!<MODEL>_<vidhex>_<pidhex>_<IDCode>` in upper case.
  - It then calls `validDeviceImageResource`, which does
    `POST https://pcenter.zeasn.tv/pcenter/device/files {idParams:[{deviceTypeName, deviceModelName}]}`.
  - Missing images are fetched with IPC `imageResourceDownload({model,url,fileName,hashMethod:"md5",hashValue})` into
    `userData/ImageCache/<model>/`. localStorage `device_image_marks` stores model → md5.
  - For this user, `MonitorName` is `"PHL 34M2C8600"` (CONFIRMED in LOG, for example "PHL 34M2C8600 IsSupportDDCCI = True"),
    while `ry` contains `"34M2C8600"`. The `ry.includes()` check at `S:44672` therefore fails. INFERRED: a cloud
    request is made on every device-list save.
- **Active device and selected type**: kept per equipment type. For peripherals the device is matched by `modelName`;
  for monitors by `aliasName === CurSN`.

### 3.6 Overview and navigation components (no extra backend calls unless listed)

| Component | Location | Backend / IPC |
|---|---|---|
| `Overview` (category or list view; `window.store` key `overviewType`) | `S:8858-9040` | Clicking a device: **Monitor** → `PHL_SwitchDisplay(aliasName=DisplaySN:string)`, with alert `MonitorNoSupport` on error (CONFIRMED param `["AU425…"]` at LOG:1019). **Keyboard, Mouse, Pad, Bulb** → `setActiveDevice` and route only. **Headset** → `headset.updateDtsData(extInfo.DTS_DP_DeviceType, DTS_DP_ComponentID, DTSDectected, StrDTSVersion, DTSVersion)` and route. The Rescan icon emits bus `rescan`. |
| `DeviceMenu` (`ql`) | `S:5896+` | none |
| `OverviewDevice` / `ConnectModeAndBattery` / `DeviceBattery` | `S:8186-8290`, `S:8074-8185` | `DeviceSteup_GetPowerInfo(deviceType)` → `{ConnectMode, ChargeStatus, HasBattery, BatteryValue:int %, Time:float}` (`E/PowerInfo.cs`), re-fetched on prop change. `DeviceSteup_GetBatteryCurrent(deviceType)` → `{Time}` (hours, rounded to 0.01) on tooltip hover. Special display rule for `SPK9418`, `SPK9618`, `SPK8618`. |
| `DeviceNav` (inside `DeviceLayout`) | `R/DeviceLayout-pwnPovdh.js:36-150` | Model switcher inside a device page. For a monitor it calls `PHL_SwitchDisplay(aliasName)`. After switching it emits `refreshDeviceData` (same equipment type) or navigates. |
| `DeviceLayout` | `R/DeviceLayout-pwnPovdh.js:151-189` | none (title and `<router-view>`) |
| `DeviceImage` | `S:33305-33415` | none. Resolution order: Bulb → inline PNG; a model in `ry` → bundled `out/renderer/<kind>/<MODEL>[ _face].png` (faces `normal`, `source`, `overview`, `rear`); otherwise `local:///<userData>/ImageCache/<key>/<face>.png`. The model name is stripped of a leading `PHL` and everything before the last space or underscore. For this monitor it resolves to the bundled `monitor/34M2C8600.png` (there is no `_overview` file, so `onError` falls back). |
| `DashboardDisplay` (`aN` / `vh`) | `S:29471-29560`, store `S:13987-14120` | none. Reads the device stores. `window.store` keys `dashboardPreview`, `dashboardPreviewEnable`, `dashboardLocation`. |
| `PairingTool` (Settings page) | `S:34664-34760`, list fetch `S:35337` | `GetPairDevices()` → `[{Name, DeviceType, HidStr}]` (also called on the monitor-only system, LOG:1025). `CanEnterPairing(deviceType, hidStr)`: errors 1001001 `ReceiverConnectAlert`, 1001002 `SameModelAlert`. `EnterPairing(deviceType, hidStr)` is followed by notification `NotifyDevicePairResult` with `Tag: bool` (`err_code` 1002001 on timeout; `CDevice_JiangMeng_Mouse.cs:450-475`). |

---

## 4. Per-page contracts

### 4.1 Keyboard root (`R/Keyboard-e26Z1DHa.js`)

Load function `S()` (lines 34-63). It runs on mount, on bus `refreshDeviceData`, and on `NotifyResetDevice` for the
active device.

1. `Button_GetFuncMenu(dt)`, then `keyboard.saveFuncMenu(Tag.Items)`. The parser is `td()` (`S:9147-9168`).
2. `DeviceSteup_GetSetupMenu(dt)`, then `saveSetupMenu`.
3. `DeviceSteup_GetSetupData(dt)`, then `updateSetupData`.
4. If `moduleSupport.effect`: `Effect_GetMenu(dt)` → `Tag.EffectList`, then `Profile_GetDeviceData(dt)` →
   `saveKeyboardData(data, EffectList)`. Otherwise only `Profile_GetDeviceData`.
5. If `moduleSupport.onboard`: `Profile_GetBoard(dt)` (a failure maps to `null`), then `updateOnboardList`.
6. Routing: if hardware onboard mode is active (`!softBoardEnable`), go to `/keyboard/onboard`. Otherwise, from the bare
   `/keyboard`, go to `/keyboard/customize`. Any error goes to `/`.

Subscriptions (lines 65-103, all filtered by `Tag.DeviceType === active.deviceType`):

- `NotifyResetDevice`: reload.
- `NotifyButtonsChange`: `updateKeyboardButton(Data)`.
- `NotifyOnboardChange` (only when onboard is supported): `updateOnboardList(Data)`, and route to Onboard if
  `Data.IsHardwareBoard`.
- `NotifyEffectChange` (only when effects are supported): `updateEffectInfo(Data)`.
- `NotifyLightEnableChange`: `setupMenu.lightEnable = Data`.

Response shapes consumed (keyboard store `S:13436-13604`):

- `Button_GetFuncMenu` → `{Items: EnumItem[]}`. Each item is `{Name, Value, ExtData?, ChildList?[]}`, and each child
  is `{Name, Value, SupModify?, ChildList?}`. The C# type is `ButtonMenuData {Items, ExtFuncDef}` (`E/ButtonMenuData.cs`).
  - `Name` is a `ButtonMenu` name (`Preset`, `Disable`, `KeyboardFunc`, `MouseFunc`, `SwitchDPI`, `Macro`, `Text`,
    `SwitchProfile`, `SwitchLighting`, `LaunchProgram`, `Media`, `PShiftKey`, `AppUser`, `DeviceFunc`) or a sub-menu name.
  - `Value` is the `ButtonMenu` / sub-menu / `ButtonFunc` integer.
  - The renderer special-cases the names `SpecificLight`, `SpecificProfile` and `SpecificOnboardProfile`. Their options
    are filled locally from the effect list, the theme profiles, and the onboard slots plus `{name:"M"+(n+1), value:3}`.
  - A menu with a single same-named child becomes `funcId`.
- `DeviceSteup_GetSetupMenu` → `{SupLowBetteryAlertSwitch, MinLowBetteryValue, MaxLowBetteryValue, StepLowBetteryValue,
  SupStartupEffect, SupLightEnable, SupLightSleepTimeSwitch, MinLightSleepTime, MaxLightSleepTime, StepLightSleepTime,
  SupDeepSleepTimeSwitch, MinDeepSleepTime, MaxDeepSleepTime, StepDeepSleepTime}`. The spelling "Bettery" is on the wire.
- `DeviceSteup_GetSetupData` → `{LowBetteryValue, StartupEffectEnable, LightEnable, SleepData:{LightSleepEnable,
  LightSleepTime, DeepSleepEnable, DeepSleepTime}}` (`RongYuanSetupData.cs`).
- `Effect_GetMenu` → `{EffectList: EffectMenuItem[]}`, where each `EffectMenuItem` is
  `{Effect:{Name,Value,Text}, SupSync, SupSpeed, MinSpeed, MaxSpeed, SpeedStep, SupBrightness, MinBrightness,
  MaxBrightness, BrightnessStep, SupRandomColor, SupRainbowColor, SupColor, SupBgColor, SupDir, DirList[], SupRegion,
  RegionList[], SupStarCount, MinStarCount, MaxStarCount, StarCountStep}` (`E/BaseEffectMenuItem.cs`).
- `Profile_GetDeviceData` (keyboard) → `{DeviceType, ModelName, MacroMaxPlayCount?, EffectInfo?, Buttons: LayerButtons[]}`.
  - `EffectInfo = {EffectEnable, CurrEffect:{Name,Value,Text}, EffectDetail:BaseEffectDetailInfo, EffectList:[{Effect:{...}}]}`.
  - `BaseEffectDetailInfo = {Effect, Speed, Brightness, IsRandomColor, IsRainbowColor, CurRGB:{R,G,B}, BgRGB, CurDir,
    CurRegion, CurStarCount}`.
  - `LayerButtons = {ButtonLayer:1|2, Buttons: ButtonInfo[]}`.
  - `ButtonInfo = {ButtonId, PreFunc, PreFuncName, ButtonMenu, ButtonMenuName?, ButtonFunc, ButtonName, ButtonValue,
    ExtValue, ExtButton:{Modify1, Modify2, Modify3, MacroPlayType, MacroPlayTimes}}` (`E/ButtonInfo.cs`,
    `E/ExtButtonInfo.cs`).
  - The renderer's `ed()` (`S:9085-9146`) pairs layer-1 and layer-2 entries by `ButtonId`. A layer-2 entry is treated
    as its own Fn binding only if `ButtonMenu !== 0 || PreFunc > -1`.
  - `hasFnLayer = Buttons.length > 1`.
  - `MacroMaxPlayCount` exists only in the HaiHui/YongJiaXing mouse profiles. It is undefined for keyboards, so
    `macroMaxTime` becomes undefined.
- `Profile_GetBoard` → `T_BoardInfo_Profile {IsSupOnBoard, CurBoardId, LastSwitchHardwareBoard,
  BoardProfiles:[{BoardId, Name, ProfileName, ThemeName}], BoardRGBs:[{R,G,B}], IsHardwareBoard}`.
  `IsHardwareBoard => CurBoardId != SoftBoardId` (`E/T_BoardInfo_Profile.cs:71`). INFERRED: `SoftBoardId` is 3 on
  4-slot RongYuan devices, matching the renderer's hard-coded value 3.

### 4.2 Mouse root (`R/Mouse-CaVQ4CBf.js`)

The load function (lines 32-65) is the same as the keyboard's, plus:

- A first call `Mouse_GetMouseMenu(dt)` → `{SupReportRate: bool}`, then `mouse.updateMenuSupport`.
- `saveMouseData` also reads `ExtModel` and `ParamMouse` (section 4.8).

Routing: onboard supported and not soft mode → `/mouse/onboard`. Otherwise, from the bare `/mouse`, go to
`/mouse/customize`.

Subscriptions: the same as the keyboard, plus `NotifyParamMouseChange` → `updateSensitivityData(Data: ParamMouse)`.
Here `NotifyOnboardChange` uses `subscribe` rather than `subscribeIfAbsent`.

### 4.3 Mouse pad root (`R/MousePad-in-8FqYp.js`)

1. `DeviceSteup_GetSetupMenu` (reads only `SupStartupEffect` and `SupLightEnable`).
2. `DeviceSteup_GetSetupData` (reads `StartupEffectEnable` and `LightEnable`).
3. `Effect_GetMenu` if effects are supported.
4. `Profile_GetDeviceData` → `{DeviceType, ModelName, EffectInfo}`.
5. Route to `/pad/ambiglow`.

It subscribes only to `NotifyLightEnableChange`. The store is at `S:13605-13660`.

### 4.4 Headset root (`R/Headset-B10qLwzf.js`)

- `Profile_GetDeviceData(dt)` → `{DeviceType, ModelName, DTSData:{DtsUIStringSingle}}`, then `headset.saveHeadsetData`.
  If `ModelName` is empty it falls back to `"TAG4106"`.
- Routing: if `dtsData.dectected` (set from the Overview click), go to `/headset/microphone`, otherwise `/headset/setup`.
- `DTSStateChange` → `updateMicrophoneData(Tag.Data.DtsUIStringSingle)`. It is emitted only for TAG5106 when the
  hardware DTS switch changes (`CDevice_TAGHeadsetDTS.cs:25-33`).

### 4.5 Customize: button remapping

Pages: `R/Customize-CsUn_qP7.js` (keyboard) and `R/Customize-BKPfwQKG.js` (mouse).

UI layout: a button list (`ButtonSelector`) and a device picture (`KeyboardRenderer` or the mouse renderer
`index-D_7NuP0U`) select a `ButtonId`. A menu lists the function menus, and `ButtonFunc` edits the chosen function.
The "Standard / P-Shift" switch selects layer 1 or 2 and appears only when `hasFnLayer`.

| Action | Call | Response handling |
|---|---|---|
| Pick menu `Preset` / `Disable` / `PShiftKey` (after a confirm dialog) | `Button_SetFunc(dt, layer, buttonId, menu.value, menu.funcId, "", "")` (`Customize-CsUn_qP7.js:121-130`, `Customize-BKPfwQKG.js:117-126`) | Keyboard: `updateKeyboardButton(Tag.Buttons)`. Mouse: `updateButtonAndSensitivity(Tag)`, which reads `Tag.Buttons` and `Tag.ParamMouse`. |
| Reset icon | `Button_RestButtons(dt, 3)` (both layers) | same |
| Leaving the page with unsaved edits | the `ButtonFunc.confirm()` dialog | |

Backend behavior (CONFIRMED, `SO:409-503`):

- `Button_SetFunc` validates `layer` / `buttonId` / `menu` / `func`.
- Special-casing:
  - `ButtonFunc.Preset` resets the button.
  - `PShiftKey` (912) first clears any other P-Shift button on layer 1.
  - `Mouse_SmartDPI` (527) clears any other SmartDPI binding and stores `value` as the SmartDPI value.
- It saves the theme profile. If `ext == "ApplyToThemeCycleProfiles"` and the function is a profile-cycle function,
  it propagates the change into every profile in the theme's cycle.
- It returns `button.GetDeviceData()`, which has the same shape as `Profile_GetDeviceData`.

### 4.6 ButtonFunc / FuncCascader (`R/ButtonFunc-DdsMNio-.js`)

The component emits three different calls, depending on the selected menu:

| Menu name | UI | Call (parameter order as sent) |
|---|---|---|
| `KeyboardFunc`, sub-menu `KeyRecording` (value 0) | Press a key; DOM `keydown` `keyCode` is captured (`FuncCascader`, lines 146-157) | `Button_SetKeyboard(dt, layer, buttonId, 0, <VK keyCode>, -1, -1, -1)` (`he()`, lines 775-793) |
| `KeyboardFunc`, other sub-menus | Pick a key option plus up to three modifiers (Shift 225/229, Ctrl 224/228, Alt 226/230) | `Button_SetKeyboard(dt, layer, buttonId, subMenu, funcId, shiftOr-1, ctrlOr-1, altOr-1)` |
| `Macro` | Pick a macro and a play mode (`options` are `MacroPlay*`). "Multiple" shows a times field, 1…`macroMaxTime` (default 2). | `Button_SetMacro(dt, layer, buttonId, macroName, playType, times or -1)` (lines 748-760). Errors: 1005001 alert `MacroBoundNoSupport`, 1005002 alert `MacroBoundNoMemory` (`S:8745-8750`). |
| `Text` | Textarea, max 250 characters | `Button_SetFunc(dt, layer, buttonId, menu.value, menu.funcId, text, "")` |
| `LaunchProgram` | Radio `LaunchExe` (file picker component `b5`) or `LaunchWebsite` (input, placeholder `http://`, max 100) | `Button_SetFunc(dt, layer, buttonId, menu.value, selectedFuncId, pathOrUrl, "")` |
| All other menus (`MouseFunc`, `SwitchDPI`, `SwitchProfile`, `SwitchLighting`, `Media`, `AppUser`, `DeviceFunc`) | Cascader | `Button_SetFunc(dt, layer, buttonId, menu.value, funcId, funcValue, ext)`, emitted by FuncCascader `save` (lines 244-277). |

Notes on the cascader cases:

- `funcValue` is `SpecificProfile` / `SpecificLight` / `SpecificOnboardProfile` option value `.toString()`, or the
  SmartDPI value (string) for `Mouse_SmartDPI`.
- `ext` is `"ApplyToThemeCycleProfiles"` / `"ApplyToThemeCycleOnBoards"` when the user confirms "apply to all profiles
  / onboards".
- `ResetDevice` asks for confirmation first.
- For mouse buttons 14 and 15, `Mouse_SmartDPI` and `ResetDevice` are filtered out.

The response is handled by `$()` (lines 671-676): keyboard → `updateKeyboardButton(Tag.Buttons)`, mouse →
`updateButtonAndSensitivity(Tag)`.

Backend conversion (CONFIRMED, `SO:505-596`): `Button_SetKeyboard` with sub-menu `KeyRecording` parses `newFun` as a
Windows `Keys` value, converts it to a USB HID scan code (`KeyboardHIDScanCode_Extension.ToUsbKeys`), then finds the
matching `SupportButtonFunc`. Modifiers are accepted only if they equal the listed HID codes.

### 4.7 UI-only helpers

These have no backend or IPC calls (CONFIRMED by grep: no `invoke`, `ipc` or `fetch`).

| Chunk | Role | Philips-only data |
|---|---|---|
| `R/ButtonSelector-4-C2eBwB.js` | Grouped button list: all / by category / customized (group value 3). Categories come from `od` (keyboard `CATE_*`, `S:9169+`) and `nd` (mouse). | Category tables keyed by `PreFuncName`. |
| `R/ButtonValue-sxj6B4tc.js` | Renders a key cap label (function, macro, modifiers). | none |
| `R/KeyboardRenderer-CcD1uMyv.js` | Clickable keyboard picture. Hard-coded `renderMatrix` of ButtonIds for SPK8308, SPK8508, SPK8708 (shared) and SPK8618 (lines 1-60). Props: `disabled-ids`, `swap-wasd`. | Yes, Philips models only |
| `R/index-D_7NuP0U.js` (mouse renderer `M`) | Clickable mouse picture. Per-model `renderFlat` front/back ButtonId lists for SPK9308, 9418, 9508, 9618 (plus 3395 variant), 9708, 9718, 9728. CSS layer classes `<MODEL>-layer`. | Yes |
| `R/Collapse-*`, `R/Menu-*` | Generic UI | |
| `R/tinycolor-DJ_qK68I.js` | Vendored tinycolor2 color maths. No I/O. | |
| `R/Equalizer-bwdWX0U6.js` | Generic vertical-bar EQ. Props `min`/`max` (default -150/150) and `frequencyGroups`. Emits `change(group, value)`. Also used by the monitor Audio page. | |

### 4.8 Mouse Sensitivity (`R/Sensitivity-DAJKZbEr.js`)

It uses its own instance `Tu(modelDeviceType)`. Responses go through `mouse.updateSensitivityData` (`S:13815-13840`) or
`updateButtonAndSensitivity`.

| UI control | Call | Response used |
|---|---|---|
| "DPI levels" select (number of stages) | `Mouse_ChangeDPILevel(dt, levelIndex)` | ParamMouse |
| Stage click (200 ms debounce) | `Mouse_ChangeDPI(dt, stageIndex)` | ParamMouse |
| Stage drag or numeric input | `Mouse_ChangeDPIValue(dt, DPILevel, stageIndex, dpi)`. The value is floored to `DPIStep` and clamped between the neighbouring stages ± step. | ParamMouse |
| LOD select | `Mouse_ChangeLod(dt, value:string)` (options are `LodItems` labelled `"<v>mm"`) | ParamMouse |
| SmartDPI slider (only if `isSmartDpiSupport`: not SPK9418, and SPK9618 only in its 3395 variant) | `Mouse_ChangeSmartDPI(dt, value)`, floored to `DPIStep` | ParamMouse |
| SmartDPI bind / unbind button | `Mouse_BindSmartDPIToButton(dt, buttonId or -1, layer)`. The wrapper swaps argument order: `setSmartDPIButton(layer, buttonId)` sends `(dt, buttonId, layer)` (`S:8551-8553`). | `{Buttons, ParamMouse}` |
| Report rate select (only if `menuSupport.reportRate`) | `Mouse_ChangeRepotRate(dt, value)` | ignored |
| Double-click speed slider | `Mouse_ChangeDoubleClickSpeed(dt, ms)` | ignored |
| Scroll speed slider | `Mouse_ChangeScrollSpeed(dt, lines)` | ignored |
| Reset | `Mouse_ResetParam(dt)` | ParamMouse |

`ParamMouse` shape (CONFIRMED, `E/ParamMouse.cs`, `E/DPIData.cs`, `E/DPIItem.cs`; renderer reads at `S:13815-13877`):

```json
{
  "ReportRateItems": [{"Name":"…","Value":0,"Text":"…"}],
  "ReportRate": 0,
  "DoubleClickSpeedData": {"MinDoubleClickDelay":200,"MaxDoubleClickDelay":900,"DoubleClickDelayStep":0,"DoubleClickSpeed":550},
  "ScrollSpeedData": {"MinScrollSpeed":0,"MaxScrollSpeed":0,"ScrollSpeedStep":0,"ScrollSpeed":3},
  "DPIData": {
    "DPILevel": 0, "CurDPIIndex": 0,
    "DPILevelList": [[{"DPIValue":800,"RGB":{"R":255,"G":0,"B":0}}, "…"], "…"],
    "SmartDPIValue":0, "SmartDPIMinValue":0, "SmartDPIMaxValue":0, "SmartDPIBindButtonID":-1,
    "DPIMinValue":50, "DPIMaxValue":26000, "DPIStep":50
  },
  "LodValue": "1", "LodItems": ["1","2"]
}
```

The numeric values above are illustrative, except for the clamps:

- `ReportRateItems[].Name` is sliced from index 1 for the slider labels, so it is presumably something like `"R1000"`
  (INFERRED).
- **`DoubleClickSpeed` and `ScrollSpeed` are the Windows system values.** They are read and written through
  `SystemParametersInfo` / `SetDoubleClickTime`. The double-click value is clamped to 200-900 ms and resets to 550 ms.
  The scroll value maps 0 to 1 and clamps to 1-100 lines (CONFIRMED, `E/DoubleClickSpeedData.cs:59-81`,
  `E/ScrollSpeedData.cs:59-180`, `work/dotnet-clean/Zeasn.Win.Lib/Zeasn.Win.Lib/CWinSysInfo.cs:79-130`).

### 4.9 Keyboard Game Mode (`R/GameMode-CyhaXAEp.js`)

This page is reached at `/keyboard/gameMode` and is visible only if `SupGameMode`. The task text named the wrong chunk;
see section 4.17.

| Action | Call | Response |
|---|---|---|
| Mount | `Keyboard_GetGameMode(dt)` | `KeyboardGameModeInfo` |
| On/Off select | `Keyboard_SwitchGameMode(dt, bool)` | same |
| Option checkbox (enabled only when on) | `Keyboard_SetGameMode(dt, GameModeType:int, checked:bool)` | same |
| Reset (confirm) | `Keyboard_ResetGameMode(dt)` | same |
| Notification | `NotifyKeyboardGameModeChange` → `updateGameModeData(Tag.Data)` | |

Shape (CONFIRMED, `E/KeyboardGameModeInfo.cs`, `E/KeyboardGameModeItem.cs`):

```
{IsGameMode:bool, GameModes:[{GameModeType:int, GameModeName:string, IsChecked:bool}],
 DisableKeys:int[] (ButtonIds), OriSwitchWASDKeys:int[]}
```

`GameModeName` is the enum name. The renderer shows `SwitchWASD` swapping when that option is checked. The picture
greys out `DisableKeys`.

### 4.10 Macros

Pages: `R/Macro-CQX1qny-.js` (keyboard), `R/Macro-hNLIHfuF.js` (mouse), editor `R/KeyBind-C58wX42L.js`.

Macros are stored **per theme** (`themeName` = current theme name, `"User"` on this system per `DataTheme.cfg`).

| Action (component, line) | Call | Response |
|---|---|---|
| Page mount (keyboard only) | `Macro_GetList(theme)` → macros store; if `?action=record`, auto-create and record | `[{MacroName, IsComMacro}]` (`E/MacroAttributeInfo.cs`) |
| Theme change (Home watcher, `M:1880-1890`) | `Macro_GetList(theme)` | same |
| New macro (MacroModule `he()`, KeyBind:1119-1134). Default names "New Macro N" / "Quick Macro N". Max 150 macros (`MacroFileLimit`). | `Macro_Add(theme, name)` | macro list. Errors: 2 `NameInvalid`, 4 `NameExisted` (`S:39411-39424`). |
| Rename (KeyBind:1486) | `Macro_Rename(theme, oldName, newName)` | list |
| Copy (KeyBind:1538) | `Macro_Copy(theme, name, name+"(n)")` | list |
| Delete (KeyBind:1706) | `Macro_Del(theme, name)` | list |
| Import from local file. File must be ≤ 20 MiB (`MacroSizeExceed`). When not overwriting, the file is first copied to `userData/<basename[0..30]>` (KeyBind:1159-1182). | `Macro_Import(theme, filePath, overwrite:bool)` | list. Error 5 `MacoParseErr`. |
| Export to local file (KeyBind:1582) | `Macro_Export(theme, name, path)` | ignored |
| Load macro steps (Detail `ie()`, KeyBind:745-765) | `Macro_GetDetail(theme, name)` | `{Name, MacroContent: MacroDetail[]}` |
| Save macro steps (Detail `ce()`, KeyBind:766-785) | `Macro_Update(theme, name, JSON.stringify({MacroContent:[...]}))` | `{MacroContent}` |
| Bind macro to a button (MacroBind, KeyBind:1830-1880). Limit 10 bindings per macro (`MacroBindLimit`). At least one left-click must remain (`AtLeastLeftClick`). | `Button_SetMacro(dt, layer, buttonId, macroName, playType, times or 0)` | device data |
| Unbind | `Button_SetFunc(dt, layer, buttonId, Preset.value or 0, Preset.funcId or 1, "", "")` | device data |
| Macro function menu (startup) | `Macro_GetFuncMenu()` → `{Items:[{Name, Text, Value, ChildList}]}`. Backend list (`SO:2544-2600`): `LaunchExe`, `LaunchWebsite`, `Media_*`, … | stored as `macroFuncMenu` / `macroFuncMap` (`S:40744-40770`) |

`MacroDetail` record, both directions (CONFIRMED, `E/MacroDetail.cs`; renderer at KeyBind:655-680 and 766-778):

| Field | Type | Meaning |
|---|---|---|
| `MacroTag` | string | Pairing id linking a PRESS and its RELEASE. `k-xxxxx` for recorded steps, `t-xxxxx` for inserted steps. |
| `DelayTime` | int ms | Delay **before** this step, 0-65000 |
| `MacroType` | int | 1 key, 2 mouse, 3 text, 4 command |
| `MacroAction` | int | 1 down, 2 up, 0 for text/command |
| `MacroValue` | string | key: **Windows VK code** as a decimal string. mouse: 513-517. text: the text itself. command: the `ButtonFunc` id from `Macro_GetFuncMenu`, for example `"864"` for LaunchExe. |
| `Extra` | string | command argument (exe path or URL) |

Recording (component `Recording`, KeyBind:84-200) happens entirely in the renderer:

- Listeners: document `keydown` and `keyup` (skips keyCode 12), and `mousedown` and `mouseup` (skips `.control-button`).
- Modes (`ke`): `RECORD_DELAY` (0, with a 3-second countdown; delay = real elapsed time, capped at 65000),
  `FIXED_DELAY` (1, default 50 ms) and `NO_DELAY` (2).
- Maximum 7000 steps (`MacroKeystrokeLimit` / `MacroInsertLimit`).
- Hardware "macro record" key: the backend notification `NotifyMacroKeyPressed` with `{Data:{EquipmentType}}` is
  handled at `M:1927-1934`. For keyboards only, it switches to that device and opens `/keyboard/macro?action=record`
  or toggles recording.

Cloud macro features in the same chunk (online, see Online touchpoints #4):

- The "FromCloud" import source, which uses IPC `getCloudFileCacheOrDownload`.
- `ExportToCloud`, which calls `Macro_Export` to a temp file, then `cloudMacroUpload` (it also calls
  `Macro_VerifyFile(path)`).
- A cloud macro preview (`S:41890-41905`) calls `Macro_GetDetail(filePath)`.

### 4.11 Onboard memory

Pages: `R/Onboard-BRf-2iG0.js` (keyboard) and `R/Onboard-PK1XuhEm.js` (mouse). Shared component:
`R/index-CkulgR5C.js:44-260`, which calls `Ru()`.

| Action | Call | Response |
|---|---|---|
| "Onboard profiles" switch (on = hardware mode) | `Profile_EnableOnboard(dt, bool)` | board info, then `updateOnboardList` |
| Click slot M1..Mn (only in hardware mode, or slot 3) | `Profile_SwitchOnboard(dt, boardId)` | board info |
| Drag a theme profile ("Theme \| Profile" string) onto a slot | `Profile_ApplyOnboard(dt, boardId, themeName, profileName)` | board info |
| Drag a slot's profile out | `Profile_ResetOnboard(dt, boardId)` | board info |
| Reset all (confirm) | `Profile_ResetOnboard(dt, -1)` | board info |
| Delete macro on slot (confirm) | `Profile_ClearOnBoardMacro(dt, boardId)` | ignored |
| Sync | `Profile_SyncOnBoard(dt)` | ignored |

The slot colour is `BoardRGBs[BoardId]` rendered as `#rrggbb`. The slot label is `"M"+(BoardId+1)`, and the text is
`BoardProfiles[].Name`.

### 4.12 Headset Microphone / DTS (`R/Microphone-CQ1pDLI1.js`)

It uses `Au(modelDeviceType)`. Every setter's `Tag` is passed to `headset.updateMicrophoneData` (`S:8834-8847`), which
reads `DtsUIStringSingle` fields.

| Control | Call |
|---|---|
| "Headphone" (APO) switch | `DTS_SetAPO(dt, bool)` |
| Surround mode | `DTS_SetRooms(dt, int)` |
| Stereo preference | `DTS_SetStereoPreference(dt, int)` |
| Bass enhance | `DTS_SetBassTbhdx(dt, bool)` |
| Dialog enhance | `DTS_SetDialogEnhancement(dt, bool)` |
| Preset | `DTS_SetPreset(dt, int)` |
| EQ bar | `DTS_SetGeqBandGain(dt, JSON.stringify(int[10]))`. Bands 31, 63, 125, 250, 500, 1k, 2k, 4k, 8k, 16k Hz. Range -150..150 (INFERRED to be tenths of a dB). |
| EQ reset / save (Custom preset only) | `DTS_GraphicEqRest(dt)` / `DTS_SaveGeqBandGain(dt)` |

`DtsUIStringSingle` fields read: `APO` (0/1), `RoomsList[{Name,Text,Value}]`, `Rooms`, `StereoPreferenceList[]`,
`StereoPreference`, `MFX_BASS_TBHDX`, `SFX_DIALOG_ENHANCEMENT`, `PresetList[]`, `CurrPreset`, `GEQ_Band_Gain:int[10]`.

On Windows, `DTS_SetAPO` also plays `res/audios/tips/dts_on_16k.wav` or `dts_off_16k.wav`
(`CDeviceHeadsetDTSBase.cs:87-100`).

The headset Setup page (`R/Setup-daShw_PC.js`, adjacent to this scope) downloads and installs the DTS driver
(Online touchpoints #5). It also calls `DTS_Open` / `DTS_Close` (`setDTSEnable`) and `Device_GetDeviceInfo`.

### 4.13 Light Sync (`R/LightSync-B-QWSZnT.js:315-395`)

This component is embedded in every Ambiglow and effect page, for peripherals and the monitor.

- On mount and whenever `modelName` changes: `SyncEffect_GetData()`.
- Subscription: `NotifyEffectSyncDevicesChange`. Its `Tag` is the sync profile **directly**, with no
  `DeviceType`/`Data` wrapper (CONFIRMED, `CDevice_PHLDisplay.cs:1157-1160`).
- Toggling a device: `SyncEffect_EnableDevice(currentDeviceType, JSON.stringify([{DeviceType, ModelName}, …]))`. The
  list contains the currently synced devices, including disconnected ones.
- If the current device's effect differs from the sync effect, the device list is reset to just this device.
- `enable=false` (lights off) removes this device from sync.

Shape (CONFIRMED, `E/T_Sync_Profile.cs`, `E/SyncDeviceInfo.cs`):

```
{EffectDetailInfo: BaseEffectDetailInfo,
 SyncDevices:[{EquipmentType, DeviceType, ModelName, ExtModel, SyncStatus:bool, Connect:bool}]}
```

Backend rule (CONFIRMED, `SO:1518-1533`): if two or fewer devices have `SyncStatus`, all are reported and stored as
`false`. **With only the monitor connected, Light Sync can never be on.**

### 4.14 Peripheral Ambiglow and Setup pages (adjacent chunks, documented for completeness)

Effect panel `R/index-7Mj02WAv.js:60-200`, used by `Ambiglow-C1UG4F7Y` (keyboard), `Ambiglow-xxUfbvEw` (mouse) and
`Ambiglow-CUjDUSuQ` (pad):

| Control | Call | Response |
|---|---|---|
| Effect on/off | `Effect_Enable(dt, bool)` | `Tag: bool`, then `{EffectEnable}` |
| Mode | `Effect_Change(dt, effectValue)` | `EffectInfo` |
| Colour | `Effect_ColorChange(dt, r, g, b)`, debounced 500 ms for the picker | `EffectInfo` |
| Random | `Effect_RandomEnable(dt, bool)` | `EffectInfo` |
| Rainbow | `Effect_RainbowEnable(dt, true)` | `EffectInfo` |
| Region | `Effect_RegionChange(dt, region)` | `EffectInfo` |
| Direction | `Effect_DirectionChange(dt, dir)` | `EffectInfo` |
| Brightness | `Effect_BrightnessChange(dt, n)` | `EffectInfo` |
| Speed | `Effect_SpeedChange(dt, n)` | `EffectInfo` |
| Custom swatches | `Effect_SetSelfColors("#aabbcc,…")`, maximum 14 | `{DefColors, SelfColors}`, then `main.saveEffectColors` |
| Page reset | `Effect_Reset(dt)` | `EffectInfo` |
| "Turn lights on" prompt | `DeviceSteup_LightEnable(dt, true)` | SetupData |

`EffectInfo` responses are emitted as `effectInfoChange` and merged by `store.updateEffectInfo`, which accepts partial
`{EffectEnable?, CurrEffect?+EffectDetail?, EffectList?}`.

Setup pages `Setup-D1HXv0D_` (keyboard), `Setup-CilyjteY` (mouse) and `Setup-B7TUA1KS` (pad):

| Control | Call |
|---|---|
| Battery alert | `DeviceSteup_SetLowBetteryValue(dt, int)` |
| Startup effect | `DeviceSteup_SwitchStartupEffect(dt, bool)` |
| Lights | `DeviceSteup_LightEnable(dt, bool)` |
| Light sleep on/off | `DeviceSteup_SwitchLightSleep(dt, bool)` |
| Light sleep time | `DeviceSteup_SetLightSleepTime(dt, int)` |
| Deep sleep on/off | `DeviceSteup_SwitchDeepSleep(dt, bool)`. Deep sleep is shown only if supported, and for SPK8708 only when light sleep is on. |
| Deep sleep time | `DeviceSteup_SetDeepSleepTime(dt, int)` |

Each setter returns SetupData, which is applied with `updateSetupData`. These pages also embed `FirmwareUpgrade`
(peripheral OTA via `Device_UpgradeFw(dt, path)`); see the cross-references.

### 4.15 DeviceLayout

See section 3.6. Each device root page renders `DeviceLayout` and `DashboardDisplay`. Neither calls the backend except
for `PHL_SwitchDisplay` from the model switcher.

### 4.16 Feedback and notice windows

**`R/feedback-NPrjkfNw.js`** runs in its own BrowserWindow (`out/renderer/feedback/index.html`). It is opened by IPC
`openFeedbackWindow` from the Settings page (`S:30108`). It is entirely online and makes no hub calls.

- Form fields: type 1-4 (`Feedback_Type_1..4`), message (required), optional email (regex-validated), up to 3 images
  (png, jpg, jpeg or webp, ≤ 20 MiB, chosen via IPC `fileSelect`), and a checkbox "allow log" that is **on by default**
  (`ge = true`), together with the privacy-policy link.
- Limit: 3 sends per calendar day, tracked in localStorage `feedbackCnt`. It requires `navigator.onLine`.
- Submission builds (lines 99-160):
  ```
  {questionType, content, softwareVersion:"1.13.0",
   sysParams: JSON.stringify({...ipc getSystemInfo, mac: runConfig.mac}),
   deviceInfo: "<model names from localStorage deviceInfo>",
   firmwareVersion: "<componentId>=<ver>,…" (deviceInfo + monitorFw),
   contactEmail?, imageUrls?:[…], logUrl?}
  ```
  - `getSystemInfo` returns `{tmpDir, appDataDir, computerName, osType, osPlatform, arch, release, uptime, totalmem}`
    (`MAIN:17573-17583`).
  - `mac` comes from `getRunConfig` (`MAIN:17421-17430`).
- Uploads go through `$T.fileUpload` (`S:39470-39498`): `GET https://pcenter.zeasn.tv/pcenter/file/presignedUrl?
  fileName&module=feedback&contentType`, then an HTTP `PUT` of the file bytes to the presigned URL. The images are
  uploaded, and so is **`%APPDATA%/EvniaServe/logs/<YYYY-MM-DD>.txt`** when the log checkbox is on.
- The form is then sent with `POST https://pcenter.zeasn.tv/pcenter/feedback/submit` (`S:39467`), and the window closes
  with IPC `closeFeedbackWindow`.
- It also listens for IPC `setLanguage`.

**`R/notice-CyNu0Xs4.js`** is the toast window (`out/renderer/notice/index.html`). It is **local only**.

- The main process forwards `ipc.send("notice", show, i18nKey, ...args)` as `setNotice`. This is gated by
  electron-store settings: `noticeSwitch`; `noticeSound` (0 SystemSound = `shell.beep()`, 1 NoSound); and
  `noticeStyle` (0 Persistent, 1 Short = auto-hide after 5 s, 2 No) (`MAIN:9266-9285`).
- In this area the producers are:
  - `NotifyMouseDPIChange`, which shows `DPIChangeNotice(model, dpi)` if the DPI changed (`M:1935-1943`).
  - `BatteryLowPowerReport`, which shows `LowBatteryNotice(model, "<n>%")` (`M:1944-1947`).
- Closing the toast sends `notice(false)`.

The `/message` page (`S:29827-29868`) is a static stub that always shows "NoNotification". It has no network access.

### 4.17 Monitor Game Mode (`R/GameMode-C1cXG-_T.js`, route `/monitor/gameMode`)

This page is in the task's scope list but labelled "keyboard game mode" there. It is the monitor page and is relevant
to the user's 34M2C8600.

Data comes from the monitor store's `ModuleGameMode` (filled by `Profile_GetDeviceData(100000)`; see the monitor
report) and `optionControl` (from `PHL_GetConstraints` / `NotifyUIDisplayFuncConstraintsChange`). Menu entries are
shown only when the corresponding property has `Support` true.

Changes go through `useMonitorPropertyHandler` (`R/useMonitorPropertyHandler-BOOFue3H.js:207-250`):

- `PHL_SetOSD(vcpName:string, value:int)`. The response `Tag` must contain `VCPOpCodeName`, and it is merged into
  `ModuleGameMode[VCPOpCodeName]`.
- For switches, the value sent is the property's `On` or `Off` value.
- `shieldDisplay` properties wrap the call in IPC `shieldDisplayChange(true)` … `(false)` so that the mode switch does
  not trigger a rescan.

The "Support" column below is INFERRED from the 34M2C8600 capability string in `EvniaServe/Config/data.json`.

| Menu | vcpName(s) | Control | Support on 34M2C8600 (INFERRED from caps) |
|---|---|---|---|
| DualMode | `EXT_OP_E2A0_59_DualResolution` | select | no (no E2A059 in caps) |
| AdaptiveSync | `EXT_OP_E2A0_40_AdaptiveSync` | switch, shieldDisplay | yes (`E2A040(00 01)`) |
| SmartMBR | `EXT_OP_E2A0_02_MBR` | slider | no |
| SmartMBRSync | `EXT_OP_E2A0_03_MBRSync` | switch | no |
| SmartResponse | `OP_EB_SmartResponse` | select | no (no EB in caps) |
| Crosshair | `EXT_OP_E2A0_04_SmartCrosshair` | select | yes (`E2A004(00 01 02)`) |
| StackShadowBoost | `EXT_OP_E2A0_44_StarkShadowBoost` | select | yes (`E2A044(00 01 02 03)`) |
| ShadowBoost | `EXT_OP_E2A0_45_ShadowBoost` | select | no |
| SmartSniper | `EXT_OP_E2A0_06_SharpShooter_Size` (shieldDisplay) and `EXT_OP_E2A0_25_SharpShooter_Location`. Location is disabled when Size is "off". | select ×2 | Size yes (`E2A006`); Location no |
| LowInputLag | `EXT_OP_E2A0_07_LowInputLag` | switch | yes |
| Overclock | `EXT_OP_E2A0_4C_Overclock` | switch | no |
| SmartFrame | On/off: `PHL_SwitchSmartFrame(On/Off value)`. Size: `PHL_SetSmartFrameSize(v)`. Both return data for `updateMonitorGameMode`. Brightness, contrast, H-position and V-position use `PHL_SetOSD("EXT_OP_E2A0_0A_SmartFrameBrightness"/"…0B_SmartFrameContrast"/"…0C_SmartFrameHPosition"/"…0D_SmartFrameVPosition", v)`. Position uses arrow buttons ± `StepValue` within `[MinValue, MaxValue]`. | custom | yes (`E2A008`-`E2A00D`) |
| AutoRefineAI | `EXT_OP_E2A0_68_AutoRefineAIStatus` | select | no |

Property object fields read: `Support`, `Value`, `ValueList[{name,text,value}]`, `On`, `Off`, `MinValue`, `MaxValue`,
`StepValue`, `VCPOpCode`.

---

## 5. Master table: functionName → params → response → used by

The Bridge line is the method's line in `B`. "Sent" types are the JSON token types the renderer sends; `dt` is the
integer DeviceType. "Log" means the call was seen in the user's `EvniaServe/logs` (CONFIRMED).

### 5.1 Device list and system

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `Start` (13) | none | `true` | Startup, reconnect | yes |
| `Device_GetConnectList` (94) | none | `DeviceInfo[]` (§3.4) | Startup, `NotifyDeviceConnectionStatus` | yes |
| `Device_DetectionDisplay` (134) | none | `DeviceInfo[]` | IPC `displayChange` | |
| `Device_DetectionUSB` (129) | none | `DeviceInfo[]` | IPC `USBChange` | |
| `Device_OtherDeviceChange` (139) | none | `DeviceInfo[]` | IPC `otherDeviceChange` | yes |
| `Device_Rescan` (124) | none | `DeviceInfo[]` | Overview rescan icon, tray | |
| `Device_GetDeviceInfo` (99) | `dt` | `DeviceInfo` (`ExtDeviceInfo.DTS_*`) | Headset Setup, FirmwareUpgrade | |
| `Device_UpgradeFw` (104) | `dt, path:str` | not read | peripheral FirmwareUpgrade | |
| `PHL_SwitchDisplay` (204) | `DisplaySN:str` | not read | Overview, DeviceNav | yes |
| `DisplayFW_GetDeviceList` (334) | none | `[{ShowName, ScalerBomInfo, StrFwVersion}]` | `saveDeviceList` side effect | yes |
| `GetPairDevices` (109) | none | `[{Name, DeviceType, HidStr}]` | Settings → PairingTool | yes |
| `CanEnterPairing` (114) | `dt, hidStr:str` | not read; errors 1001001/1001002 | PairingTool | |
| `EnterPairing` (119) | `dt, hidStr:str` | result via `NotifyDevicePairResult` | PairingTool | |

### 5.2 Device setup and power

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `DeviceSteup_GetPowerInfo` (144) | `dt` | `{ConnectMode, ChargeStatus, BatteryValue, Time}` | DeviceBattery (concurrency-allowed) | |
| `DeviceSteup_GetBatteryCurrent` (149) | `dt` | `{Time}` | DeviceBattery tooltip | |
| `DeviceSteup_GetSetupMenu` (154) | `dt` | §4.1 | Keyboard, Mouse, Pad roots | |
| `DeviceSteup_GetSetupData` (159) | `dt` | SetupData | Keyboard, Mouse, Pad roots | |
| `DeviceSteup_SetLowBetteryValue` (169) | `dt, int` | SetupData | Setup pages | |
| `DeviceSteup_SwitchStartupEffect` (164) | `dt, bool` | SetupData | Setup pages | |
| `DeviceSteup_LightEnable` (194) | `dt, bool` | SetupData | Setup pages, Ambiglow pages | |
| `DeviceSteup_SwitchLightSleep` (174) | `dt, bool` | SetupData | Setup pages | |
| `DeviceSteup_SetLightSleepTime` (179) | `dt, int` | SetupData | Setup pages | |
| `DeviceSteup_SwitchDeepSleep` (184) | `dt, bool` | SetupData | Setup pages | |
| `DeviceSteup_SetDeepSleepTime` (189) | `dt, int` | SetupData | Setup pages | |

### 5.3 Device data, buttons and onboard memory

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `Profile_GetDeviceData` (669) | `dt` | keyboard, mouse, pad and headset shapes (§4.1-4.4); monitor elsewhere | all device roots | yes (100000) |
| `Profile_GetBoard` (679) | `dt` | board info (§4.1) | Keyboard, Mouse roots | |
| `Profile_EnableOnboard` (684) | `dt, bool` | board info | Onboard | |
| `Profile_SwitchOnboard` (689) | `dt, int` | board info | Onboard | |
| `Profile_ApplyOnboard` (709) | `dt, int, str theme, str profile` | board info | Onboard | |
| `Profile_ResetOnboard` (699) | `dt, int` (-1 = all) | board info | Onboard | |
| `Profile_ClearOnBoardMacro` (704) | `dt, int` | not read | Onboard | |
| `Profile_SyncOnBoard` (694) | `dt` | not read | Onboard | |
| `Button_GetFuncMenu` (54) | `dt` | `{Items}` | Keyboard, Mouse roots | |
| `Button_SetFunc` (64) | `dt, layer, buttonId, menu, func, value:str, ext:str` | device data (`Buttons`, `ParamMouse`) | Customize, ButtonFunc, MacroBind (unbind) | |
| `Button_SetKeyboard` (69) | `dt, layer, buttonId, subMenu, fun/VK, mod1, mod2, mod3` | device data | ButtonFunc | |
| `Button_SetMacro` (74) | `dt, layer, buttonId, name:str, playType, times` | device data; errors 1005001/1005002 | ButtonFunc, MacroBind | |
| `Button_RestButtons` (79) | `dt, 3` | device data | Customize reset | |

### 5.4 Mouse

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `Mouse_GetMouseMenu` (614) | `dt` | `{SupReportRate}` | Mouse root | |
| `Mouse_ChangeDPILevel` (624) | `dt, int` | ParamMouse | Sensitivity | |
| `Mouse_ChangeDPI` (609) | `dt, int` | ParamMouse | Sensitivity | |
| `Mouse_ChangeDPIValue` (619) | `dt, level, index, dpi` | ParamMouse | Sensitivity | |
| `Mouse_ChangeSmartDPI` (629) | `dt, int` | ParamMouse | Sensitivity | |
| `Mouse_BindSmartDPIToButton` (639) | `dt, buttonId (-1 = unbind), layer` | `{Buttons, ParamMouse}` | Sensitivity | |
| `Mouse_ChangeLod` (634) | `dt, str` | ParamMouse | Sensitivity | |
| `Mouse_ChangeRepotRate` (664) | `dt, int` | not read | Sensitivity | |
| `Mouse_ChangeDoubleClickSpeed` (649) | `dt, int ms` | not read (OS setting) | Sensitivity | |
| `Mouse_ChangeScrollSpeed` (654) | `dt, int lines` | not read (OS setting) | Sensitivity | |
| `Mouse_ResetParam` (659) | `dt` | ParamMouse | Sensitivity | |

### 5.5 Keyboard game mode

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `Keyboard_GetGameMode` (529) | `dt` | `KeyboardGameModeInfo` | Keyboard GameMode | |
| `Keyboard_SwitchGameMode` (534) | `dt, bool` | same | Keyboard GameMode | |
| `Keyboard_SetGameMode` (539) | `dt, int type, bool` | same | Keyboard GameMode | |
| `Keyboard_ResetGameMode` (544) | `dt` | same | Keyboard GameMode | |

### 5.6 Macros

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `Macro_GetFuncMenu` (604) | none | `{Items}` | Startup | yes |
| `Macro_GetList` (549) | `theme:str` | `[{MacroName, IsComMacro}]` | Startup, theme change, Keyboard Macro | yes (`["User"]`) |
| `Macro_GetDetail` (554) | `theme, name` | `{MacroContent}` | Macro Detail | |
| `Macro_GetDetail` (559) | `filePath` | `{MacroContent}` | cloud macro preview (online) | |
| `Macro_Add` (564) | `theme, name` | macro list | MacroModule | |
| `Macro_Copy` (574) | `theme, name, newName` | list | MacroModule | |
| `Macro_Rename` (579) | `theme, old, new` | list | MacroModule | |
| `Macro_Update` (584) | `theme, name, json:str` | `{MacroContent}` | Macro Detail | |
| `Macro_Del` (589) | `theme, name` | list | MacroModule | |
| `Macro_Import` (594) | `theme, path, bool` | list | MacroModule | |
| `Macro_Export` (599) | `theme, name, path` | not read | MacroModule | |
| `Macro_VerifyFile` (569) | `path` | `bool` | cloud macro upload only | |

### 5.7 Lighting and sync

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `Effect_GetMenu` (429) | `dt` | `{EffectList}` | Keyboard, Mouse, Pad roots | |
| `Effect_GetColorData` (419) | none | `{DefColors:[RGB], SelfColors:str}` | Home mount | yes |
| `Effect_SetSelfColors` (424) | `csv:str` | same | effect panel | |
| `Effect_Enable` (439) | `dt, bool` | `bool` | effect panel | |
| `Effect_Change` (444) | `dt, int` | EffectInfo | effect panel | |
| `Effect_ColorChange` (459) | `dt, r, g, b` | EffectInfo | effect panel | |
| `Effect_RandomEnable` (449) | `dt, bool` | EffectInfo | effect panel | |
| `Effect_RainbowEnable` (454) | `dt, bool` | EffectInfo | effect panel | |
| `Effect_RegionChange` (484) | `dt, int` | EffectInfo | effect panel | |
| `Effect_DirectionChange` (479) | `dt, int` | EffectInfo | effect panel | |
| `Effect_BrightnessChange` (474) | `dt, int` | EffectInfo | effect panel | |
| `Effect_SpeedChange` (469) | `dt, int` | EffectInfo | effect panel | |
| `Effect_Reset` (489) | `dt` | EffectInfo | Ambiglow pages | |
| `SyncEffect_GetData` (494) | none | sync profile (§4.13) | Home mount, LightSync | yes |
| `SyncEffect_EnableDevice` (499) | `dt, json:str` | sync profile | LightSync | |

### 5.8 Headset DTS

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `DTS_Open` / `DTS_Close` (354/359) | `dt` | not read | Headset Setup (DTS install) | |
| `DTS_SetAPO` (364) | `dt, bool` | DtsUIStringSingle | Microphone | |
| `DTS_SetRooms` (369) | `dt, int` | DtsUIStringSingle | Microphone | |
| `DTS_SetStereoPreference` (374) | `dt, int` | DtsUIStringSingle | Microphone | |
| `DTS_SetBassTbhdx` (379) | `dt, bool` | DtsUIStringSingle | Microphone | |
| `DTS_SetDialogEnhancement` (384) | `dt, bool` | DtsUIStringSingle | Microphone | |
| `DTS_SetPreset` (389) | `dt, int` | DtsUIStringSingle | Microphone | |
| `DTS_SetGeqBandGain` (394) | `dt, json:str` | DtsUIStringSingle | Microphone | |
| `DTS_GraphicEqRest` (399) | `dt` | DtsUIStringSingle | Microphone | |
| `DTS_SaveGeqBandGain` (404) | `dt` | DtsUIStringSingle | Microphone | |

### 5.9 Monitor Game Mode (§4.17)

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `PHL_SetOSD` (219) | `vcpName:str, int` | `{VCPOpCodeName, …property}` | Monitor GameMode | yes (other page) |
| `PHL_SwitchSmartFrame` (239) | `int` | ModuleGameMode | Monitor GameMode | |
| `PHL_SetSmartFrameSize` (244) | `int` | ModuleGameMode | Monitor GameMode | |

### 5.10 Global light settings (Settings page, peripheral-related)

| functionName (B line) | Params sent | Response `Tag` (fields read) | Used by | Log |
|---|---|---|---|---|
| `Setting_GlobalData` (23) | none | `{TurnOffLightsWhenIdle, TurnOffLightsWhenIdleDuration, …}` merged into `main.settingGlobalData` | Settings | yes |
| `Setting_TurnOffLightsWhenIdle` (28) | `bool` | | Settings | |
| `Setting_TurnOffLightsWhenIdleDuration` (34) | `int` (≥ 1 min, otherwise backend error) | | Settings | |
| `Setting_EnableAllowControlLights` | `bool` | **not in Bridge**; wrapper never called (`S:29910`) | none | |
| `Setting_TurnOffLightsWhenDisplayTurnOff` | `bool` | **not in Bridge**; wrapper never called (`S:29913`) | none | |
| `Effect_CheckDynamicLightingEnabled` / `Effect_OpenDynamicLightingSetting` (409/414) | none | `bool` / not read | Settings (Windows 11 Dynamic Lighting) | |

**Bridge methods never called by any renderer chunk** (CONFIRMED by grep over `R/*.js`): `Button_GetStaticData`,
`Mouse_GetMouseParam`, `Effect_BgColorChange`, `ModifierKeyListenerEnable`, all `PHL_*HotKey*`, `GetHotKeyState`,
`PHL_ProfileAction`, `SetGamePQ`, `PHL_EnableGamePQMouseKey`, `PHL_SetGamePQMouseKeyBind`, `PHL_Rescan`,
`Theme_GetCurProfile`, `DisplayFW_InstallDriver` and `DisplayFW_FWUpdateFailedNextTime`. They may be used by the main
process or be dead code; see the cross-references.

---

## 6. Notifications consumed in this area

| Notification (C# `Notification_Func`) | Tag shape | Subscriber (file:line) | Effect |
|---|---|---|---|
| `NotifyDeviceConnectionStatus` | `{DeviceType, Data:bool}` | `M:1803` | `Device_GetConnectList`, unless `shieldPeripheralChange` |
| `NotifyButtonsChange` | `{DeviceType, Data: LayerButtons[]}` | Keyboard:73, Mouse:79 | rebuild buttons |
| `NotifyResetDevice` | `{DeviceType, Data: device profile}` | Keyboard:69, Mouse:71 | full reload |
| `NotifyOnboardChange` | `{DeviceType, Data: board info}` | Keyboard:79, Mouse:86 | update slots; route to Onboard if `IsHardwareBoard` |
| `NotifyEffectChange` | `{DeviceType, Data: EffectInfo}` | Keyboard:87, Mouse:94 | merge effect |
| `NotifyLightEnableChange` | `{DeviceType, Data: bool}` | Keyboard:91, Mouse:98, MousePad:60 | `setupMenu.lightEnable` |
| `NotifyParamMouseChange` | `{DeviceType, Data: ParamMouse}` | Mouse:75 | sensitivity refresh |
| `NotifyKeyboardGameModeChange` | `{DeviceType, Data: KeyboardGameModeInfo}` | GameMode-CyhaXAEp:52 | refresh |
| `NotifyMouseDPIChange` (obfuscated as `const_7`, real name CONFIRMED from `work/dotnet/.../Notification_Func.cs:12`) | `{DeviceType, Data:{Data: DPIData, ModelName}}` | `M:1935` | toast + `updateDPI` |
| `BatteryLowPowerReport` | `{DeviceType, Data:{ModelName, BatteryValue}}` | `M:1944` | toast |
| `NotifyMacroKeyPressed` | `{DeviceType, Data:{EquipmentType}}` | `M:1927` | open or toggle macro recording (keyboard only) |
| `NotifyUISwitchTheme` (obfuscated as `const_2`, CONFIRMED from `work/dotnet/.../Notification_Func.cs:7`) | `"Theme\|Profile"` string, or `"Theme"` (`SO:3218-3226`) | `M:1917` | `Theme_Switch` / `Theme_SwitchApp`, then `refreshDeviceData` |
| `NotifyEffectSyncDevicesChange` | sync profile (no wrapper) | LightSync:350 | refresh sync list |
| `DTSStateChange` | `{DeviceType, Data:{DtsUIStringSingle}}` (INFERRED from renderer use) | Headset:45 | refresh DTS UI |
| `NotifyDevicePairResult` | `bool` (plus `err_code`) | `S:34692` | pairing result |
| `FirmwareUpdateProgressData` | `{Value}` | `S:34006` (FirmwareUpgrade) | progress |

Defined in C# but **not consumed** by the renderer: `NotifyBatteryChange`, `NotifyDeviceUpgradeFwProgress`,
`ModifierKeyListener` and `NotifyHotKeyExecute`.

---

## 7. IPC used by the in-scope pages

| Channel | Direction | Where | Purpose |
|---|---|---|---|
| `displayChange`, `USBChange`, `otherDeviceChange` | main → renderer | `M:1795-1797`, `M:186-189` | hot-plug (§3.3) |
| `shieldPeripheralChange` (send) | renderer → main | `S:14289-14291` (also a bus event) | suppress `USBChange` / `otherDeviceChange` |
| `shieldDisplayChange` (send) | renderer → main | useMonitorPropertyHandler | suppress `displayChange` during mode switches |
| `imageResourceDownload` (invoke) | renderer → main | `S:44440-44500` | download device image zip (online) |
| `getCloudFileCacheOrDownload` (invoke) | renderer → main | KeyBind:1258 | cloud macro download (online, needs login) |
| `getFileSize` (invoke) | renderer → main | KeyBind:1160 | ≤ 20 MiB check |
| `getFileMd5` (invoke) | renderer → main | `S:39520+` | cloud upload |
| `fileSelect` (invoke) | renderer → main | feedback:81, file-picker component | open dialog |
| `exportFile` (invoke) | renderer → main | macro export path | save dialog |
| `notice` (send) | renderer → main → notice window `setNotice` | `M:1935-1947` | toasts |
| `openFeedbackWindow` / `closeFeedbackWindow` (send) | renderer → main | Settings, feedback | feedback window |
| `getSystemInfo` (invoke), `getRunConfig` (invoke) | renderer → main | feedback:111, all windows | system info, MAC address |
| `runCommand`, `extractZip`, `findExe` (invoke) | renderer → main | headset Setup `R/Setup-daShw_PC.js:56-150` | DTS driver install |
| `disableTrayFunction` (send) | renderer → main | `M:1846-1852` | during rescan |
| `openDefaultBrowser` (send) | renderer → main | `M:1868` | logo click opens `https://www.evnia.philips` |

---

## 8. Discrepancies and bugs a port must preserve or fix

1. **Only the newest request per functionName resolves** (§1.1). If two device pages load at once, for example both
   calling `Profile_GetDeviceData`, only the last promise settles. The Linux backend can answer in any order, but a
   renderer rewrite should key callbacks by requestId only.
2. **Success requires an empty `err_msg`.** `JsonResult.Succ(tag, msg)` sets `err_msg = ""` by default. A backend that
   puts text in `err_msg` on success breaks every call.
3. **`Tb()` requires numeric `FwVersion`** on every `DeviceInfo`.
4. **Renderer functions missing from Bridge:** `Setting_EnableAllowControlLights` and
   `Setting_TurnOffLightsWhenDisplayTurnOff` are never called. `Theme_EnableSmartImage` and `Theme_SetSmartImage`
   would fail with `functionName: … undefined`; they belong to the theme area.
5. **Mouse store bug (`S:13896`):** `saveSetupMenu` writes `MinDeepSleepTime` into `lightSleep.min` rather than
   `deepSleep.min`.
6. **Effect panel bug (`R/index-7Mj02WAv.js:190-194`):** the speed range starts at `MinBrightness`, not `MinSpeed`.
7. **Inconsistent macro play count:** `Button_SetMacro` receives `times = -1` (ButtonFunc) or `0` (MacroBind) for
   non-"Multiple" play types.
8. **`macroMaxTime`** comes from `MacroMaxPlayCount`, which only the HaiHui/YongJiaXing profiles provide.
   `MaxFw` and `AliasName` are not in the C# `DeviceInfo`.
9. **The device-list cloud check compares un-normalized `modelName`** (`"PHL 34M2C8600"`) against `ry`, while
   `DeviceImage` normalizes it (§3.5).
10. **`Button_RestButtons` is called with layer 3**, which is a bitmask, not a `ButtonLayer` enum member.

---

## 9. Which pages only make sense with Philips peripherals

| Page / feature | Requires | Relevant to the user (34M2C8600 only)? | Recommendation |
|---|---|---|---|
| Keyboard root, Customize, Ambiglow, GameMode, Macro, Setup, Onboard | Philips keyboard 25AA:2005-2008/200D, 3554:FA09 | No | Hide or remove routes |
| Mouse root, Customize, Ambiglow, Sensitivity, Macro, Setup, Onboard | Philips mouse 25AA:4005-401B/200F-2012 | No | Hide or remove |
| MousePad Ambiglow, Setup | SPL7508 25AA:8002 | No | Hide or remove |
| Headset Microphone (DTS), Setup (DTS driver) | TAG4106/5106 25AA:6002/6003 and the DTS APO driver | No | Remove (Windows APO, online install) |
| ButtonFunc, ButtonSelector, ButtonValue, KeyboardRenderer, mouse renderer, KeyBind (macro editor and bind), Onboard component, Equalizer (headset use) | peripherals | No | Remove, except that Equalizer is also used by monitor Audio |
| Macro list/function menu at startup (`Macro_GetFuncMenu`, `Macro_GetList`) | none (theme files) | Called, but useless without a bindable device | Stub: return `{Items:[]}` and `[]` |
| Light Sync (`LightSync-B-*`, `SyncEffect_*`) | ≥ 2 sync-capable devices | Rendered on the monitor Ambiglow page, but can never be on (§4.13) | Hide; stub `SyncEffect_GetData` |
| Effect colour swatches (`Effect_GetColorData`, `Effect_SetSelfColors`) | none | Also used by the **monitor** ENE Ambiglow colour picker (see the monitor report) | Keep (local file) |
| Device battery, pairing (`GetPairDevices`), NotifyMouseDPIChange/BatteryLowPowerReport toasts | Philips wireless peripherals | No | Stub `GetPairDevices → []`; drop toasts |
| Overview, DeviceNav, DeviceImage, DashboardDisplay | any device | Yes (monitor) | Keep, minus the cloud image lookup |
| Monitor Game Mode (`GameMode-C1cXG-_T`) | monitor | Yes | Keep (§4.17) |
| Global "turn off lights when idle" | lighting devices; the monitor Ambiglow is affected too (INFERRED, `GlobalOper.CheckIdle` runs every second in `EvniaHub.cs:47-55`) | Maybe | Keep if the monitor Ambiglow is supported |
| Windows Dynamic Lighting check/open | Windows 11 | No | Remove |

---

## Linux port plan (this area)

**Recommended approach: keep the Vue renderer, and reduce the peripheral surface to stubs.**

1. **Backend RPC subset required even with no peripherals.** A Linux reimplementation of the hub must answer these with
   well-formed data:
   - `Start` → `true`.
   - `Device_GetConnectList`, `Device_DetectionDisplay`, `Device_DetectionUSB`, `Device_OtherDeviceChange`,
     `Device_Rescan` → the same `DeviceInfo[]`. Include the monitor record with numeric `FwVersion`,
     `EquipmentType: 1`, `DeviceType: 100000` and `ExtDeviceInfo {CurSN, DisplayList}`.
   - `SyncEffect_GetData` → `{"EffectDetailInfo":{"Effect":{"Name":"Off","Value":0,"Text":""}},"SyncDevices":[]}`.
   - `Effect_GetColorData` → persisted `{DefColors, SelfColors}`.
   - `Macro_GetFuncMenu` → `{"Items":[]}`.
   - `Macro_GetList(theme)` → `[]`.
   - `GetPairDevices` → `[]`.
   - `Setting_GlobalData` → `{TurnOffLightsWhenIdle:false, TurnOffLightsWhenIdleDuration:…}`.
   - Every other peripheral function → `{err_code: 9, err_msg: "No driver found!"}`. This is the exact Windows behavior
     when a device is absent (`SO:393-407`, `SO:684-692`).
2. **Keep `PHL_SwitchDisplay(DisplaySN)` and `Profile_GetDeviceData(100000)`** working; the log shows the renderer uses
   them on every monitor selection.
3. **Hot-plug on Linux.** Replace the Windows sources (`WM_DISPLAYCHANGE`, `WM_DEVICECHANGE`, the `usb` npm module) in
   the Electron main process with a libudev monitor:
   - `drm` subsystem `change` events → `displayChange`, keeping the 2 s debounce. The backend should not sleep 5 s.
   - `usb` / `hidraw` add or remove → `USBChange` (1 s debounce).
   - Drop `otherDeviceChange` (Bluetooth peripherals are Philips-only).
   - The monitor's USB hub (`2109:*`) and its Ambiglow controller (`0CF2:A201`) appearing or disappearing should still
     raise `USBChange`, because the monitor's USB-DDC path depends on them (see the cross-references).
4. **Renderer patches to strip online features** (see Online touchpoints for exact locations):
   - Remove the `Pb(...)` call in `saveDeviceList` (`S:44694-44703`) so that it always resolves locally.
   - Remove the `localStorage` `deviceInfo` / `monitorFw` writes; they only feed feedback.
   - Remove the feedback window and its IPC handlers.
   - Remove the "FromCloud" / "ExportToCloud" macro UI.
   - Remove the headset Setup DTS installer and the peripheral FirmwareUpgrade OTA.
   - Remove the logo link to `evnia.philips`, or keep it as a plain link.
5. **Hide peripheral routes.** In the router table (`S:43772-44010`) and the Sidebar (`M:266-440`), gate
   `/keyboard`, `/mouse`, `/pad`, `/headset` and `/bulb` behind a build flag. They are unreachable anyway when the
   device list contains only the monitor, but removing them shrinks the port.
6. **If peripheral support is ever needed** (not for this user), these are the Windows-specific pieces to replace:
   - HID I/O to VID 0x25AA / 0x3554: use `/dev/hidraw*` with udev rules granting access; the vendor protocols are
     covered by the native-DLL reports.
   - **Software macro playback and "Text" / "LaunchProgram" / `User_*` functions**: they use Windows `SendInput`,
     Windows shortcuts and `ShellExecute` in the backend. Replace with `/dev/uinput`, `xdg-open` and DE-specific
     shortcuts.
   - Macro `MacroValue` keystrokes are Windows VK codes. Map VK to evdev `KEY_*` for uinput. `Button_SetKeyboard`
     KeyRecording converts VK to USB HID usage (`ToUsbKeys`), which is platform-independent and can be reused.
   - The Chromium DOM `keyCode` on Linux produces the same VK-compatible values, so the renderer's recording code is
     unchanged.
   - Mouse double-click and scroll speed are OS settings. Map them to the desktop environment (for example the GNOME
     `org.gnome.desktop.peripherals.mouse double-click` key and libinput `scroll-factor`), or drop them.
   - DTS APO has no Linux equivalent. Use PipeWire filter-chain EQ, or drop it.
7. **Alternative native Linux UI (Electron dropped):** none of the peripheral pages need porting. The only
   device-list-level contract that matters is §3.4, restricted to the monitor.

---

## Online touchpoints

All `pcenter` HTTP requests from the renderer go to `https://pcenter.zeasn.tv` with headers `brandId: 5`,
`productId: 857`, `deviceType: Evnia_Precision_Center`, `devicesetId: fcaa1d17c43a11eca53606dda80f8953`
(`S:30673-30690`, `S:32910-32930`, `S:32986-33030`).

| # | What | Where | Trigger | Endpoint | Recommendation |
|---|---|---|---|---|---|
| 1 | Device image resource lookup, then zip download into `ImageCache/<model>` | `S:44445-44510` (`validDeviceImageResource`), `S:44694-44703`, `MAIN:17612-17632` | Every `saveDeviceList` with a model not in the built-in list. INFERRED to include the user's monitor (`"PHL 34M2C8600"`). | `POST https://pcenter.zeasn.tv/pcenter/device/files` `{idParams:[{deviceTypeName, deviceModelName}]}`, then GET `fileUrl` (CDN) | Remove; use only bundled images |
| 2 | Device thumbnails for cloud profiles | `S:39602-39640` (`tP().getDeviceImage`) | Cloud profile page (logged in) | `POST /pcenter/device/images` | Remove with the cloud profile feature |
| 3 | Feedback: image and **log file** upload plus the form | `R/feedback-NPrjkfNw.js:65-190`, `S:39467-39498` | User submits feedback | `GET /pcenter/file/presignedUrl` → `PUT <presigned URL>` → `POST /pcenter/feedback/submit` (payload §4.16, includes MAC, hostname, full backend log) | Remove the window and IPC |
| 4 | Cloud macros (list, import, export, preview) | `R/KeyBind-C58wX42L.js:1099-1260, 1553-1590`, `S:39426-39600`, `S:41890-41905`, `MAIN:17634-17647` | Logged-in user chooses FromCloud or ExportToCloud | `GET /pcenter/theme`, `GET /pcenter/macro`, `GET /pcenter/file/exist`, presigned upload, `POST /pcenter/macro`, file download via IPC `getCloudFileCacheOrDownload` | Remove |
| 5 | Headset DTS driver update check, download and silent install | `R/Setup-daShw_PC.js:60-150`, `S:33075-33106` (`Mv`) | Opening headset Setup | `GET https://deviceportal.zeasn.tv/direct/component/update?brandId&components&deviceType&language&push&ScalerIC&ruleMac=<MAC>&ruleUSBHubCount`. Header `Authorization: ZAuth …` (HMAC, `S:13338-13342`). Then the package is downloaded, extracted and run as `"<exe>" /targetDir "%APPDATA%\G-MenuDTSServe"`. | Remove |
| 6 | Peripheral firmware OTA | `R/FirmwareUpgrade-BsUoyIKp.js`, `S:33800-34060` | Setup pages | same component-update endpoint, then `Device_UpgradeFw` | Remove (cross-ref) |
| 7 | Global cloud error hook (650401 → forced logout / login prompt) | `M:1906-1914` | any `pcenter` error | n/a | Remove with login |
| 8 | Logo click opens the vendor site | `M:1868` | user click | `https://www.evnia.philips` (via `openDefaultBrowser`) | Optional; harmless |
| n/a | Notice toasts, `/message` page, tinycolor, LightSync, all hub calls | | | local only | Keep |

User-configured `LaunchWebsite` button or macro actions open URLs through the backend at run time. That is a user
feature, not an app online dependency.

---

## Open questions

1. **Monitor record in `Device_GetConnectList`.** The exact JSON was not logged; only the count and name were. It is
   unclear whether `ExtDeviceInfo` carries more than `CurSN` / `DisplayList`, whether `DP_ComponentID` / `IDCode` are
   present, and whether `MonitorName` in `DisplayList` is exactly `"PHL 34M2C8600"`. The log strings suggest it is.
   Capturing one real response would settle the §3.5 cloud-lookup claim.
2. **`JsonSerialize()` null handling.** It is unclear whether the default omits null properties
   (`Class0.cs:47-50` uses different options for `list_1` functions). This matters for renderer reads such as
   `e.ExtDeviceInfo?.DisplayList` and `e.EffectInfo`.
3. **`SoftBoardId` per driver.** The renderer hard-codes slot value 3 as the "software" onboard slot.
   `T_BoardInfo_Profile.SoftBoardId` is set per driver and was not traced.
4. **Report-rate item names** (`ReportRateItems[].Name`, whose first character is stripped) and the LOD item strings
   were not observed. They only matter if mice are ever supported.
5. **The exact `DTSStateChange` Tag nesting** is inferred from renderer use. The Windows-side `SetAPO` returns
   `GetDtsData()`, whose wrapper was not fully traced.
6. **`GlobalOper.CheckIdle` and the monitor Ambiglow.** Whether "turn off lights when idle" also switches off the
   monitor Ambiglow on the 34M2C8600 (and therefore should be kept) needs confirmation from the lighting/backend report.

---

## Cross-references (outside this scope)

- **Transport and dispatcher details**: `docs/re/05-backend-host.md` §2-3 (hub lifecycle, `Class0`, `InputParams`).
  Per the user's Electron log, EvniaServe is launched with `--urls http://*:10010`, so the unauthenticated hub listens
  on **all interfaces**. A Linux port must bind to `127.0.0.1` only.
- **Main process**: `docs/re/01-electron-main.md`, covering the hot-plug sources (§9), IPC reference (§10), downloads,
  image and cloud cache (§12) and the notice/feedback windows (§4).
- **Monitor pages**: Monitor root, SmartImage, SmartImageHDR, Ambiglow-Dvqon39u (monitor ENE/VCP Ambiglow; uses
  `Effect_GetLEDs`, `Effect_*` with DeviceType 100000, and the `EXT_OP_E2A0_19..1E` Ambiglow VCPs), Input, Audio
  (reuses `Equalizer`, `PHL_SetAudioEQ`), System, Setup and FirmwareUpgrade (`DisplayFW_*`, online OTA). These belong
  to the monitor renderer report. `NotifyUIDisplayFuncConstraintsChange` and `NotifyUIDisplayEffectChange` are
  consumed there.
- **Theme and profile** (`Theme_*`, including the missing `Theme_EnableSmartImage` / `Theme_SetSmartImage`) and the
  cloud profile page (`/pcenter/profile`, `/pcenter/theme`): theme/profile report.
- **Login and account**: `Startup` refreshes the token at `M:232` via `PUT https://saas.zeasn.tv/user/device/token/refresh`
  (`S:33108-33110`). Home shows the login dialog when not logged in (`M:1857-1864`). This belongs to the
  account/online report.
- **AmbiScape / Matter bulbs** (`Bulb` pseudo-device, `AmbiScape_EnableFollowVideo`, `NotifyAmbiScapeFollowVideoData`,
  `GetWifiList`, `M:2150-2195`): bulb report.
- **Peripheral vendor protocols** (RongYuan, BeiYing KB_K916, JiangMeng, YongJiaXing, HaiHui, TAG headset DTS):
  native DLL reports (`work/native/KBAccess_SPK8618`, `Mouse_SPK9718`, `Mouse_SPK9418*/9618*`, `RhHidAPI`) and
  `Zeasn.USB.*` / `Zeasn.Equipment.Option.Lib`.
- **ENE `0CF2:A201` and VIA `2109:*` hubs** in the user's enumeration are INFERRED to be the 34M2C8600's internal USB
  hub and Ambiglow controller (`EneEc.dll`). They are relevant to the USB-DDC and Ambiglow reports, not to
  peripherals.
- **Backend software features used only by peripherals**: software macro playback (`EVT_Com.StopSoftMacro`,
  `InputEventManager`), `ModifierKeyListenerEnable` and the `PHL_*HotKey*` functions (not called by the renderer;
  possibly main-process or dead). Windows `SystemParametersInfo` in `Zeasn.Win.Lib/CWinSysInfo.cs` is also used for
  keyboard repeat.
- **Vendor AI-agent files** `work/app/VENDOR_AGENTS.md.txt` and `VENDOR_CLAUDE.md.txt` are untrusted corpus data.
  They were not followed.
