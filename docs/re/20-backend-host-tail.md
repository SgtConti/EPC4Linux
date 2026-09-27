# 20 — EvniaServe host, part 2: dispatcher errors, event bus, Bridge catalog, golden startup transcript

This report finishes `05-backend-host.md`, which stops in the middle of §3.3 (line 253). It covers the parts 05 lists but never reaches: the rest of the dispatcher (05 §3.3), the event bus and notifications (05 §4), the Bridge catalog (05 §6), a short persistence note (05 §7) and the function list for the Linux port (05 §12). It does not edit 05.

## Summary

- **Dispatcher (`Class0`).**
  - Overload resolution is exact-type positional matching. JSON Integer maps to `int`, String to `string` and Boolean to `bool`. Any other token type fails before the name lookup.
  - Every error path uses `err_code 9`; §1.3 lists the exact texts. Two of them never reach the renderer's promise, because the reply carries `RequestId:null`: the JSON-parse failure and the outer exception catch.
  - Exceptions thrown inside a Bridge method come back as `"Exception has been thrown by the target of an invocation."`, not as the stack trace that 05 implies.
  - A SignalR Completion (`{"type":3,"invocationId":"n","result":null}`) follows every reply. This is INFERRED from ASP.NET Core 3.1.
- **Event bus.**
  - `EventSystem` is a synchronous, in-process multicast table keyed by enum type and value.
  - Only one handler ends in SignalR: `EVT_Com.Notification` → `HandleEvent.method_0`, which serializes the **whole `JsonResult`**. Every one of the 80 emitters passes a `JsonResult`.
  - The log line `eventType=0` is always the enum value of `EVT_Com.Notification`. It never identifies the notification.
  - 21 of the 23 `Notification_Func` names have emitters. `NotifyParamMouseChange` and `NotifyBatteryChange` have none. `NotifyUISwitchTheme` and `NotifyMouseDPIChange` do have emitters; they appear as `const_2`/`const_7` in `dotnet-clean`. This corrects 02 §6.
- **Bridge catalog.** All 162 overloads are listed with their target, whether the renderer calls them, and a disposition for the monitor-only port: 54 implement, 23 static stub, 85 error. The error replies reuse the vendor's own "no device" texts, so the port stays byte-compatible even on those paths.
- **Golden transcript.** It is derived from code and the user's 2026-09-26 log.
  - The 34M2C8600 appears as one `DeviceInfo` whose `ExtDeviceInfo` is `{"CurSN":"AU00000000001","DisplayList":[{"DisplayName":"PHL 34M2C8600","MonitorName":"PHL 34M2C8600","DeviceName":"\\\\.\\DISPLAY1","DisplaySN":"AU00000000001"}]}`.
  - `Macro_GetFuncMenu` is exactly 4025 characters (4161 UTF-8 bytes).
  - The scan-time `NotifyUIDisplayFuncConstraintsChange` (07:52:52.1834) arrives before the renderer has subscribed and is dropped.
- **Connected and selectable.** Three things must hold:
  - `Device_GetConnectList` must succeed, because Startup does not catch its failure.
  - `FwVersion` must be non-null, because `Tb` calls `.toString()` on it.
  - `CurSN` must equal a `DisplaySN`. Otherwise `activeDevice` is null and the Monitor shell never loads data after a refresh.
- **Start timing.** The 21 s `Start` is purely a vendor artefact: 6.7 s cold capability read plus 11.1 s full VCP read. The port can reply once the EDID/SN are known and finish the VCP read in the background. It must keep sending SignalR pings, because the client drops the connection after 30 s of silence.

Conventions:
- **CONFIRMED** means read in code or seen in the user's logs or config files. **INFERRED** means reasoned from code or framework semantics.
- `DC/` = `work/dotnet-clean/`, `DO/` = `work/dotnet/` (the obfuscated tree, which keeps the real enum names).
- `AP/` = `work/app-pretty/`. `ST` = `AP/renderer/assets/styles-DAnQi2A8.js` and `MN` = `AP/renderer/assets/main-CDosWiM3.js`.
- `LOG` = `%APPDATA%/EvniaServe/logs/2026-09-26.txt`, `ELOG` = `%APPDATA%/evnia/logs/26-09-26.log`, `CFG` = `%APPDATA%/EvniaServe/`.
- `SO` = `DC/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs`, `PHL` = `DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/`.

---

## 1. (a) 05 §3.3 continued: dispatcher `Class0` (DC/EvniaServe/Class0.cs)

### 1.1 Request flow (CONFIRMED, Class0.cs:19-113)

1. `method_0(json)` → `json.JsonDeserialize<InputParams>()`.
   - This is Newtonsoft with `NullValueHandling.Ignore` (DC/Zeasn.Com.Lib/Zeasn.Com.Lib/Extension_Json.cs:129-147, 89-127).
   - `JsonDeserialize` **catches every exception**, logs the raw text, and returns `null`.
2. Logging: `GetTaskAsync param = <raw>` is written unless the function is `Effect_GetLEDs` or `Effect_CheckDynamicLightingEnabled` (:13, :28-31).
3. `method_1(device, functionName, requestId, parms)` builds `new JsonResult{RequestId, FunctionName}` first (:55-59). Every error that is detected inside `method_1` therefore **echoes both ids**.
4. `method_2` does type-based overload resolution (§1.2).
5. Arguments: `device` is prepended when `!= -1` (:78-81). The renderer never sends it. Then each token goes through `Convert.ToInt32` / `Convert.ToString` / `Convert.ToBoolean` (:84-97).
6. `methodInfo.Invoke(this, parms == null ? null : args)` (:100).
   - A `null` return becomes `Error("functionName: <fn>  return null obj")`. There are **two spaces** before `return`.
   - `RequestId`/`FunctionName` are then overwritten with the request's values (:101-104).
7. Serialization:
   - `Profile_GetDeviceData` uses `JsonSerialize(IgnoreUI, bIgnoreNullValue:false)`.
   - Everything else uses `JsonSerialize()` (:46-50).
   - Both keep nulls and use `ReferenceLoopHandling.Ignore` (Extension_Json.cs:37-87).
   - If serialization throws, `JsonSerialize` returns `null`. The hub then sends `arguments:[null]` and the renderer's `JSON.parse` path throws inside the handler (INFERRED edge case; no known trigger).

### 1.2 Overload resolution, exact algorithm (CONFIRMED, Class0.cs:115-172)

1. The method table is built once: `typeof(Bridge.Lib.Bridge).GetMethods(Public|Static)` grouped by `Name` into a `Dictionary<string, List<MethodInfo>>` with the default **ordinal, case-sensitive** comparer. `A_Notification(Notification)` is in the table, but no JSON argument can ever match it.
2. **Token types first, before the name lookup.** For each `parms` element in order:
   - `Integer` → `int`
   - `String` → `string`
   - `Boolean` → `bool`
   - any other `JTokenType` → **fail immediately**: `"Unsupported parameter type: <JTokenType>"`. Possible types are `Float`, `Null`, `Object`, `Array`, `Undefined` (Newtonsoft accepts the `undefined` literal) and `Date`.
   - `Date` is not obvious: Newtonsoft's default `DateParseHandling.DateTime` turns an ISO-looking string such as `"2026-09-26T07:52:52"` into a `Date` token. INFERRED from Newtonsoft semantics.
   - `parms: null` and `parms: []` both give an empty type list.
3. Name lookup. If the name is missing → `"functionName: <fn> undefined"`.
4. `FirstOrDefault` over the overloads, in reflection order (declaration order in practice; INFERRED). An overload matches only when `ParameterInfo.Length == types.Count` **and** every `ParameterType == types[i]` exactly.
   - There is no widening and no default-parameter handling. `Theme_ImportProfile(s, s, bool bOverride = false)` still needs three arguments.
   - A `long`/`double`/enum-typed parameter would be unreachable, but Bridge has none. Every Bridge parameter is `int`, `string` or `bool` (checked over all 162 signatures).
5. No match → `"params error: " + string.Join(" | ", overloads.Select(m => m.ToString()))`.
   - .NET Core `RuntimeMethodInfo.ToString()` prints primitive names without `System.` (`Int32`, `Boolean`, `Void`) and other types with their namespace (`System.String`, `Zeasn.Com.Lib.JsonResult`). INFERRED from the .NET Core 3.1 BCL.
   - Example: `"params error: Zeasn.Com.Lib.JsonResult Theme_GetDevicesBasicInfo(Int32) | Zeasn.Com.Lib.JsonResult Theme_GetDevicesBasicInfo(System.String, System.String, Int32) | Zeasn.Com.Lib.JsonResult Theme_GetDevicesBasicInfo(System.String, Int32)"`.

### 1.3 Error replies, exact strings

All of them have `"IsSucc":false,"Tag":null,"CurrItem":null`.

| Case | Where | `err_code` | `err_msg` | `RequestId` / `FunctionName` | Renderer effect |
|---|---|---|---|---|---|
| JSON parse failure: invalid JSON, `""`, `null`, wrong shape (e.g. `[]`, or `parms` not an array) | Class0.cs:37 via Extension_Json.cs:121-126 | 9 | `解析json字符串: <raw request text>失败` ("parsing JSON string … failed") | **null / null** | Treated as a notification for `FunctionName null`. There is no subscriber, so it is dropped. **The request promise never settles** (ST:7975-7995). CONFIRMED by code |
| `functionName` missing or JSON `null` | `string_0.Trim()` NRE caught at :106-112 | 9 | `Object reference not set to an instance of an object.` | echoed / **null** | Dropped (no `waitingResponse[null]`) |
| `functionName` empty or whitespace | :62-67 | 9 | `functionName is null` | echoed | Promise rejects `{code:9,msg}` |
| Unsupported token type | :139-142 | 9 | `Unsupported parameter type: Float` (or `Null`, `Object`, `Array`, `Date`, `Undefined`) | echoed | rejects. The renderer produces `Null` whenever a wrapper passes `undefined` (JSON.stringify turns it into `null`) |
| Unknown function | :146-149 | 9 | `functionName: <fn> undefined` | echoed | rejects. Reachable only through the four renderer wrappers with no Bridge method: `Setting_EnableAllowControlLights`, `Setting_TurnOffLightsWhenDisplayTurnOff`, `Theme_EnableSmartImage`, `Theme_SetSmartImage` |
| No matching overload | :167-170 | 9 | `params error: <sig> \| <sig> …` | echoed | rejects |
| Exception thrown inside a Bridge/SystemOper method | `Invoke` wraps it in `TargetInvocationException`, caught at :106-112 | 9 | `Exception has been thrown by the target of an invocation.` (the wrapper's `Message`; the inner exception is only logged via `ZLog.Exception`) | echoed | rejects. INFERRED BCL text |
| Argument conversion overflow (Integer beyond Int32) | `Convert.ToInt32(JToken)` at :89, caught at :106 | 9 | `Value was either too large or too small for an Int32.` | echoed | rejects. INFERRED BCL text |
| `device` field sent together with `parms` | `Invoke` with one extra argument | 9 | `Parameter count mismatch.` | echoed | INFERRED. The renderer never sends `device` |
| Bridge returned `null` (the `?.` on a missing driver) | :101 | 9 | `functionName: <fn>  return null obj` (two spaces) | echoed | rejects |
| Method caught its own exception and returned `JsonResult.Exception(ex)` | e.g. SO:747-750, 1359-1362 | 9 | `ex.ToString()` (type, message and stack trace, multi-line) | echoed | rejects |
| Outer catch in `method_0` | :41-45 | 9 | `ex.ToString()` | **null / null** | Dropped; hangs. Practically unreachable, because everything below it catches |

Success replies from `JsonResult.Succ(tag)` carry `"err_msg":""` (JsonResult.cs:143-146). Replies built with `new JsonResult{…}` carry `"err_msg":null`. That second group is `DisplayFW_GetDeviceList`, `DisplayFW_GetMonitorCount`, `DisplayFW_CheckUpstreamCable`, `DisplayFW_InstallDriver`, `DisplayFW_FWUpdateFailedNextTime` and `FancyZones_GetData` (PHL/PHLDisplayFW.cs:114-120, 124, 187, 404-419; DC/…Option.Lib/FancyZonesOper.cs:213-219). CONFIRMED. The renderer treats both as success.

**Port rule.** Always echo `RequestId` and `FunctionName`, even when the request cannot be parsed. The vendor's `RequestId:null` paths make the renderer hang, and there is no client timeout (02 §4.6).

### 1.4 Frames on the wire

- **Reply** (CONFIRMED EvniaHub.cs:62-66). `await Clients.All.SendAsync("GetTaskAsync", json)` gives `{"type":1,"target":"GetTaskAsync","arguments":["<json>"]}␞` and goes to **every** connected client.
- **Completion** (INFERRED, ASP.NET Core 3.1 `DefaultHubDispatcher`). The hub method returns `Task` and the invocation carried an `invocationId`, so after the method completes the server writes `{"type":3,"invocationId":"<n>","result":null}␞` (`CompletionMessage.WithResult(id, null)` writes `"result":null`).
  - This goes to the calling connection only, **after** the reply broadcast.
  - The renderer ignores its value; `hub.invoke(...)` only `.catch`es (ST:7942-7943).
  - **Never send a Completion with `error`.** The SignalR client would reject (ST:6590-6600) and the renderer promise would reject with an `Error` object instead of `{code,msg}`.
- **Order inside one invocation** (INFERRED). Notifications raised synchronously during the method go out first, then the reply, then the Completion.
  - `EventSystem.SendEvent` is synchronous. `HandleEvent` calls `SendAsync("Notification")` without awaiting it. Both writes share the connection's write lock, and the notification write starts first.
  - LOG:1022-1023 is consistent: `PHL_GetConstraints` and `OnNotification` carry the same timestamp.
- **Serial processing.** ASP.NET Core 3.1 dispatches one invocation at a time per connection (`HubConnectionHandler.DispatchMessagesAsync` awaits each one; INFERRED). During the 21 s `Start`, later requests from the same renderer queue behind it.
- **Server frame encoding** (INFERRED). The JSON hub protocol in 3.1 uses System.Text.Json with the default `JavaScriptEncoder`. Inside the outer frame's string argument, `"` becomes `\u0022` and non-ASCII (`关闭`, `°`) becomes `\uXXXX`. The inner Newtonsoft text itself has raw UTF-8. The renderer `JSON.parse`s the frame, so any valid encoding (e.g. `JSON.stringify`) is equivalent.
- **Target names.** The client lower-cases them (`on()` at ST:6606-6612), so the case of `"GetTaskAsync"`/`"Notification"` does not matter.
- **Handshake and pings.**
  - Handshake reply is `{}␞`.
  - The server sends `{"type":6}␞` pings (ASP.NET default `KeepAliveInterval` 15 s; INFERRED). They run on a timer and are **not** blocked by a long hub method.
  - The client closes after 30 s of server silence (ST:6430).

### 1.5 Argument typing table, completed (the part cut from 05 §3.3)

| JSON token | C# | Conversion | Notes |
|---|---|---|---|
| Integer | `int` | `Convert.ToInt32(JValue)` | > Int32 → overflow error (§1.3) |
| String | `string` | `Convert.ToString(JValue)` | ISO-date-looking strings arrive as `Date` → "Unsupported parameter type: Date" |
| Boolean | `bool` | `Convert.ToBoolean` | |
| Float, Null, Object, Array, Date, Undefined | — | — | "Unsupported parameter type: <T>", checked before the name |

### 1.6 REST controllers (DC/EvniaServe/Evnia/*Controller.cs, CONFIRMED)

Every controller builds an `InputParams` and calls `Class0.method_0`. None of them is used by the renderer. **Drop them on Linux.**

| Route (GET) | Calls | Vendor bug |
|---|---|---|
| `/Evnia/GetTaskResult?parm=<json>` | any function (EvniaController.cs:18-22) | CSRF-able RPC (05 summary) |
| `/Evnia/Start` | `Start` | — |
| `/Evnia/FactoryReset` | **`SyncEffect_GetData`** (EvniaController.cs:35-44) | name does not match the function |
| `/Display/PHL_SwitchDisplay?parm=` | `PHL_SwitchDisplay` | — |
| `/Display/PHL_SetGamePQ?...` | `SystemOper.PHL_SetGamePQ` directly, returns `""` | — |
| `/Profile/DeviceReset?device=` | `Profile_Reset` | — |
| `/Theme/Theme_GetCurThemeDevicesBasicInfo` | `Theme_GetDevicesBasicInfo` with no parms | always "params error: …" |
| `/Theme/Theme_GetDevicesBasicInfo?themeName&profileName` | two strings | no `(string,string)` overload, so always "params error: …" |

---

## 2. (b) Event bus and notifications (05 §4)

### 2.1 Mechanics (CONFIRMED, DC/Zeasn.Com.Lib/Zeasn.Com.Lib/EventSystem.cs, EventGroup.cs)

- Groups are keyed by `enum.GetType().FullName`. Within a group, handlers are keyed by `Convert.ToInt32(value)`.
- `Register` replaces a missing handler, or does `Delegate.Remove` then `Combine`, which gives a multicast delegate without duplicates.
- `SendEvent` looks the handler up and **invokes it synchronously on the sender's thread**. With no handler it is a no-op; the event is not queued.
- `HandleEvent.RegisterEvent()` runs **only on the first hub connection** (EvniaHub.cs:38-51). Notifications raised before any UI has connected are lost.

### 2.2 The SignalR edge (CONFIRMED, HandleEvent.cs:89-101)

```csharp
private void method_0(int int_0, object object_0) {           // int_0 = (int)EVT_Com.Notification = 0 for every call
    string text = object_0 != null ? object_0.JsonSerialize() : "";   // object_0 is ALWAYS the JsonResult built by the emitter
    ZLog.Debug(text.Length <= 1024 ? $"OnNotification connection={bConnect} eventType={int_0} param={text}"
                                   : $"OnNotification connection={bConnect} eventType={int_0} param='The parameter exceeds the print limit'");
    StartClient?.All.SendAsync("Notification", text);          // not awaited; broadcast
}
```

- `object_0` is the `JsonResult` that the emitter passes to `SendEvent(EVT_Com.Notification, param)`. All 80 call sites pass one (the table in §2.4 was produced by a script).
- The whole envelope is serialized with the plain `JsonSerialize()`: nulls kept, and `[JsonIgnoreEx]` ignored, so `AttributeInfo.ValueList` and friends are included.
- `eventType=0` in LOG (lines 996, 1023, 1082) is the numeric value of `EVT_Com.Notification`. The log cannot tell notifications apart except by length. All three logged 2026-09-26 notifications exceeded 1024 characters.
- **`err_msg`.** Every emitter uses `new JsonResult{FunctionName=…, Tag=…}`, so the result is `err_code 0`, `err_msg null`, `RequestId null`. There are two exceptions:
  - `NotifyDevicePairResult` sets `err_code 1002001` and `err_msg "Pairing error: timeout!"`, or `err_code 0` and `err_msg "Pairing success!"` (DC/…Option.Lib/Zeasn.Equipment.Option.Lib.JiangMeng.Mouse/CDevice_JiangMeng_Mouse.cs:453-474, 632-639).
  - `DTSStateChange` forwards whatever `base.SetAPO()` returned, with its `FunctionName` overwritten (CDevice_TAGHeadsetDTS.cs:30-32).
- The renderer ignores `err_code`/`err_msg` on notifications and passes only `Tag` (ST:7985-7993).

### 2.3 All `Register` / `SendEvent` pairs

| Event (value) | Handler (Register site) | Senders (SendEvent sites) | Ends in a SignalR `Notification`? |
|---|---|---|---|
| `EVT_Com.Notification` (0) | `HandleEvent.method_0` (HandleEvent.cs:34) | 80 sites, §2.4 | **Yes, always** |
| `EVT_Com.SyncLedTimer` (1) | none | none | dead |
| `EVT_Com.SaveCurThemeProfile` (2) | `SystemOper.ThemeSaveCurProfiles` (HandleEvent.cs:35-38) | `GClass0.SaveProfile` (DC/Zeasn.Equipment.Base.Lib/…/GClass0.cs:191-194) | No (writes `.pcenter` and `DataTheme.cfg`) |
| `EVT_Com.UsbDeviceChange` (3) | `CDevice_PHLDisplay.method_3` (PHL/CDevice_PHLDisplay.cs:195; unregistered :201) | SO:207 (USB scans only) | Conditional. The USB-DDC recheck can reconnect the display, and `ParameterToDevice` → `RecheckFuncConstraints` then emits `NotifyUIDisplayFuncConstraintsChange` if the JSON changed. ENE plug-in gives `NotifyUIDisplayEffectChange` (:787-792) |
| `EVT_Com.ThemeSwitchApp` (4) | `RongYuanMouse_Oper.method_15` (…RongYuan.Mouse/RongYuanMouse_Oper.cs:491) | SO:3057 (`Theme_SwitchApp`) | Conditional: `NotifyMouseDPIChange` if a RongYuan mouse is connected (:494-513) |
| `EVT_Com.StopSoftMacro` (5) | `MacroMgr` (DC/Zeasn.PCenter.Base.Lib/…/MacroMgr.cs:22) | 12 RongYuan sites | No |
| `EVT_Effect.CheckSoftEffect` (0) | `SystemOper.CheckSoftEffect` (HandleEvent.cs:39) | SO:216, 293; PHL/CDevice_PHLDisplay.cs:850, 1201; BeiYing 921/943; RongYuan kb 1390, mouse 1418, pad 625 | No (timers only) |
| `EVT_Effect.EffectEnableTemp` (1) | `SystemOper.EffectEnableTemp` (HandleEvent.cs:43) | `GlobalOper.IsIdle` setter (GlobalOper.cs:67) | No |
| `EVT_Effect.Effect_Sync` (2) | `SystemOper.OnSyncEffect` (HandleEvent.cs:51) | SO:212, 1593, 1625; CDeviceEffectBase.cs:194 | Conditional: `NotifyEffectChange` from each device in sync (display: CDevice_PHLDisplay.cs:1318-1347, only when `IsInEffectSync`). Never with no peripherals |
| `EVT_Effect.Effect_VideoData` (3) | `SystemOper.OnVideoData` (HandleEvent.cs:55) **and** `AmbiScapeOper.method_0` (AmbiScapeOper.cs:30) | EffectTimerMgr.cs:115 | Conditional: `NotifyAmbiScapeFollowVideoData` while AmbiScape follow-video is on |
| `EVT_Effect.Effect_AudioData` (4) | `SystemOper.OnAudioData` (HandleEvent.cs:59) | EffectTimerMgr.cs:156 | No |
| `EVT_Effect.Effect_BreathingData` (5) | `SystemOper.OnBreathingData` (HandleEvent.cs:63) | EffectTimerMgr.cs:167 | No |
| `EVT_Effect.Effect_SyncDataChange` (6) | `SystemOper.EffectSyncDataChange` (HandleEvent.cs:47) | CDeviceEffectBase.cs:185 plus 25 peripheral sites | **Yes**: `NotifyEffectSyncDevicesChange` (SO:1728-1736) |
| `EVT_Profile.NextProfile`/`PreviousProfile`/`CycleUpProfile`/`CycleDownProfile`/`SpecificProfile` (0-4) | `SystemOper.NextProfile`… (HandleEvent.cs:67-86) | CDeviceButtonBase.cs:134-146 (peripheral profile buttons) | **Yes**: `NotifyUISwitchTheme` with `"Theme\|Profile"` (SO:3219-3227) |

### 2.4 The 23 `Notification_Func` names

Real names come from `DO/Zeasn.PCenter.Entity.Lib/…/Notification_Func.cs`. In `DC` the same enum lists `const_2` and `const_7`. Paths are relative to `DC/Zeasn.Equipment.Option.Lib/` unless they start with `SO`.

| # | Name | Emitter file:line (the `SendEvent` line) | `Tag` type | Renderer subscriber |
|---|---|---|---|---|
| 0 | `FirmwareUpdateProgressData` | PHLDisplay/PHLDisplayFW.cs:434 | `UpdateFirmwareProgressInfo{Name,Type,Value(object=double)}` | ST:34006 (OTA dialog) |
| 1 | `DTSStateChange` | Zeasn.Equipment.Option.Lib/CDevice_TAGHeadsetDTS.cs:32 | the `JsonResult` of `SetAPO`, with its own `err_code`/`err_msg` | Headset page |
| 2 | **`NotifyUISwitchTheme`** | SO:3226 (`SwitchProfileNotification`), SO:3331 (`CheckTopApp`) | `string`: `"<Theme>\|<Profile>"` or `"<Theme>"` | MN:1917 |
| 3 | `NotifyUIDisplayEffectChange` | PHLDisplay/CDevice_PHLDisplay.cs:792 (ENE detected on a USB change), :856 (ENE lost) | `ValueTuple<bool,DisplayEffectInfo,DisplayModuleAmbiglow>` → `{"Item1","Item2","Item3"}` | Monitor-D4qz4RBn.js:84-91 (expects `ENEEnable/EffectInfo/ModuleAmbiglow`) |
| 4 | `NotifyUIDisplayFuncConstraintsChange` | Zeasn.Equipment.Option.Lib/DisplayFuncConstraints.cs:323 (`Notify()`). It is called from `RecheckFuncConstraints` when the JSON changed (:288-293) and unconditionally from `GetConstraints` (PHLDisplay/CDevice_PHLDisplay.cs:2021-2025) | `DisplayFuncConstraints` | MN:1834-1841 |
| 5 | `NotifyEffectSyncDevicesChange` | SO:1735 (normalized `smethod_11(...)`); PHLDisplay/CDevice_PHLDisplay.cs:1162 (**raw** `CurThemeProfile?.Sync_Profile`, which may be `null` or have `EffectDetailInfo:null`) | `T_Sync_Profile` | LightSync-B-QWSZnT.js:350 |
| 6 | `NotifyOnboardChange` | RongYuan…/RongYuanMouse_Oper.cs:88, 245, 2448, 2606; RongYuan/RongYuanKeyboard_Oper.cs:85, 271, 2362, 2545 | `NotificationDataBase` | peripheral pages |
| 7 | **`NotifyMouseDPIChange`** | JiangMeng…/CDevice_JiangMeng_Mouse.cs:510; HaiHui…M3395/CDevice_9618_3395_Mouse.cs:110; HaiHui…M8960/CDevice_9618_8960_Mouse.cs:101; RongYuanMouse_Oper.cs:190, 512, 2551; YongJiaXing…/CDevice_YongJiaXing_Mouse.cs:100 | `NotificationDataBase{Data:{Data:DPIData, ModelName}}` | MN:1935 |
| 8 | `NotifyParamMouseChange` | **none** | — | Mouse page |
| 9 | `NotifyKeyboardGameModeChange` | RongYuanKeyboard_Oper.cs:161, 2436 | `NotificationDataBase` | Keyboard page |
| 10 | `NotifyEffectChange` | BeiYing…/CDevice_BeiYing_KB_K916.cs:982; PHLDisplay/CDevice_PHLDisplay.cs:1347; RongYuan/CDevice_RongYuanKeyboard.cs:1606, CDevice_RongYuanMouse.cs:1634, CDevice_RongYuanMousePad.cs:405 | `NotificationDataBase` (display: `Data = DisplayEffectInfo`) | peripheral pages |
| 11 | `NotifyLightEnableChange` | RongYuanMouse_Oper.cs:158, 270, 2518, 2631; RongYuanKeyboard_Oper.cs:178, 205, 2453, 2479; CDevice_RongYuanKeyboard.cs:1577; CDevice_RongYuanMouse.cs:1605 | `NotificationDataBase{Data:bool}` | peripheral pages |
| 12 | `NotifyButtonsChange` | CDevice_JiangMeng_Mouse.cs:619; CDevice_BeiYing_KB_K916.cs:968; CDevice_9618_3395_Mouse.cs:483; CDevice_9618_8960_Mouse.cs:453; CDevice_YongJiaXing_Mouse.cs:391; CDevice_RongYuanKeyboard.cs:1592; CDevice_RongYuanMouse.cs:1620 | `NotificationDataBase` | peripheral pages |
| 13 | `NotifyMacroKeyPressed` | RongYuanMouse_Oper.cs:209, 2570; RongYuanKeyboard_Oper.cs:235, 2509 | `NotificationDataBase{Data:{EquipmentType}}` | MN:1927 |
| 14 | `NotifyResetDevice` | RongYuanMouse_Oper.cs:235, 2596; RongYuanKeyboard_Oper.cs:261, 2535 | `NotificationDataBase` | peripheral pages |
| 15 | `NotifyBatteryChange` | **none** | — | not subscribed |
| 16 | `BatteryLowPowerReport` | RongYuanMouse_Oper.cs:140, 2500; RongYuanKeyboard_Oper.cs:138, 2415 | `NotificationDataBase{Data:{ModelName,BatteryValue}}` | MN:1944 |
| 17 | `NotifyDeviceConnectionStatus` | CDevice_JiangMeng_Mouse.cs:169; CDevice_BeiYing_KB_K916.cs:309; CDevice_9618_3395_Mouse.cs:187; CDevice_9618_8960_Mouse.cs:220; CDevice_YongJiaXing_Mouse.cs:189; RongYuan/CDevice_RongYuanKeyboardBase.cs:157; RongYuan/CDevice_RongYuanMouseBase.cs:135 | `NotificationDataBase{Data:bool}` | MN:1803 |
| 18 | `NotifyDeviceUpgradeFwProgress` | JiangMeng…/JiangMengMouse_Oper.cs:1821; CDevice_9618_8960_Mouse.cs:130; CDevice_YongJiaXing_Mouse.cs:130 | `NotificationDataBase` | not subscribed |
| 19 | `NotifyDevicePairResult` | CDevice_JiangMeng_Mouse.cs:460, 474, 639 | `bool` (with `err_code`/`err_msg` set, §2.2) | ST:34692 |
| 20 | `NotifyAmbiScapeFollowVideoData` | Zeasn.Equipment.Option.Lib/AmbiScapeOper.cs:102 | `AmbiScapeFollowVideoData{T,B,R1..R4,L1..L4: RGB}` | MN:2184 |
| 21 | `ModifierKeyListener` | DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib.HotKeyMgr/InputEventManager.cs:1093 | `NotificationDataBase{DeviceType:0 (Unknown), Data:{Key:string, IsDown:bool}}` | not subscribed |
| 22 | `NotifyHotKeyExecute` | PHLDisplay/CDevice_PHLDisplay.cs:1466, 1490, 1522, 1564, 1595 | `NotificationDataBase{DeviceType:100000, Data:EnumItem(DisplayHotKeyFunc)}` | not subscribed (dead: `HotKeyItems` is never filled, 12 §3.7) |

Totals: 80 emit sites, 21 names with at least one emitter, and 2 names (8, 15) with none. CONFIRMED by a scripted scan of every `SendEvent(EVT_Com.Notification, …)` in DC plus a check that no other `Notification_Func` use exists. The only two SignalR sends in the code base are EvniaHub.cs:65 and HandleEvent.cs:100.

### 2.5 JSON examples for the display-related notifications

These are complete frames' inner strings (`arguments[0]`). All carry `"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null`.

**`NotifyUIDisplayFuncConstraintsChange`**, the user's state on 2026-09-26. It is byte-exact and 1925 characters, which matches the ">1024" log entry at LOG:996 and LOG:1023. The states are derived in §2.6.

```json
{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":{"FuncItems":[{"FuncId":16,"FuncName":"OP_10_Luminance","State":1},{"FuncId":18,"FuncName":"OP_12_Contrast","State":1},{"FuncId":240,"FuncName":"OP_F0_SmartContrast","State":2},{"FuncId":14852128,"FuncName":"EXT_OP_E2A0_20_ColorSpace","State":1},{"FuncId":20,"FuncName":"OP_14_SelectColorPreset","State":1},{"FuncId":14852132,"FuncName":"EXT_OP_E2A0_24_DLBL","State":2},{"FuncId":14852160,"FuncName":"EXT_OP_E2A0_40_AdaptiveSync","State":1},{"FuncId":14852098,"FuncName":"EXT_OP_E2A0_02_MBR","State":2},{"FuncId":14852099,"FuncName":"EXT_OP_E2A0_03_MBRSync","State":1},{"FuncId":14852100,"FuncName":"EXT_OP_E2A0_04_SmartCrosshair","State":1},{"FuncId":14852164,"FuncName":"EXT_OP_E2A0_44_StarkShadowBoost","State":2},{"FuncId":14852165,"FuncName":"EXT_OP_E2A0_45_ShadowBoost","State":2},{"FuncId":14852102,"FuncName":"EXT_OP_E2A0_06_SharpShooter_Size","State":2},{"FuncId":14852103,"FuncName":"EXT_OP_E2A0_07_LowInputLag","State":1},{"FuncId":235,"FuncName":"OP_EB_SmartResponse","State":1},{"FuncId":14852172,"FuncName":"EXT_OP_E2A0_4C_Overclock","State":1},{"FuncId":14852104,"FuncName":"EXT_OP_E2A0_08_SmartFrame","State":2},{"FuncId":14852122,"FuncName":"EXT_OP_E2A0_1A_AmbiglowColors","State":1},{"FuncId":14852123,"FuncName":"EXT_OP_E2A0_1B_AmbiglowLightPosition","State":1},{"FuncId":14852124,"FuncName":"EXT_OP_E2A0_1C_AmbiglowLightBrightness","State":1},{"FuncId":14852125,"FuncName":"EXT_OP_E2A0_1D_AmbiglowLightSpeed","State":2},{"FuncId":14852126,"FuncName":"EXT_OP_E2A0_1E_AmbiglowLightDirection","State":1},{"FuncId":224,"FuncName":"OP_E0_AudioSource","State":2},{"FuncId":134,"FuncName":"OP_86_DisplayScaling","State":1},{"FuncId":84,"FuncName":"OP_54_PerformancePreservation","State":1},{"FuncId":218,"FuncName":"OP_DA_ScanMode","State":1}],"ModuleGameMode":1,"AudioEQ":1},"FunctionName":"NotifyUIDisplayFuncConstraintsChange","CurrItem":null}
```

**`NotifyUIDisplayEffectChange`** (vendor shape, ENE-loss path CDevice_PHLDisplay.cs:851-856; abbreviated with `…`; INFERRED Newtonsoft ValueTuple handling):

```json
{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":{"Item1":false,"Item2":{"EffectList":[…7 DisplayEffectDetailInfo…],"EffectDetail":{…},"EffectEnable":true,"CurrEffect":{"Name":"FollowVideo","Text":"光影同步","Value":1}},"Item3":{"EXT_OP_E2A0_19_AmbiglowLightMode":{"VCPOpCode":14852121,"VCPOpCodeName":"EXT_OP_E2A0_19_AmbiglowLightMode","Value":7,"MinValue":0,"MaxValue":7,"StepValue":1,"ValueList":[…],"err_code":0},…,"EffectEnable":false}},"FunctionName":"NotifyUIDisplayEffectChange","CurrItem":null}
```

The port should send `{"ENEEnable":false,"EffectInfo":…,"ModuleAmbiglow":…}` instead, which is what the renderer handler reads (Monitor-D4qz4RBn.js:85-91). With the vendor shape, `Object.keys(undefined)` throws inside the SignalR callback.

**`NotifyEffectSyncDevicesChange`** after `Effect_Reset(100000)` with no peripherals. This is the raw profile object (CDevice_PHLDisplay.cs:1157-1162); INFERRED from `Default.pcenter`, which has `"Sync_Profile":{"EffectDetailInfo":null,"SyncDevices":[]}`:

```json
{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":{"EffectDetailInfo":null,"SyncDevices":[]},"FunctionName":"NotifyEffectSyncDevicesChange","CurrItem":null}
```

**`NotifyUISwitchTheme`** (SO:3329-3342). The Tag is a plain JSON string, `"Tag":"User"` or, from the profile buttons, `"Tag":"User|Default"`:

```json
{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":"User|Default","FunctionName":"NotifyUISwitchTheme","CurrItem":null}
```

**`FirmwareUpdateProgressData`** (OTA; removed in the port). `Value` is a boxed `double`, so Newtonsoft always writes a decimal point:

```json
{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":{"Name":"Update Firmware Progress","Type":"OSD","Value":42.0},"FunctionName":"FirmwareUpdateProgressData","CurrItem":null}
```

**`NotifyHotKeyExecute`** (dead). `DisplayHotKeyFunc` has no `[Description]`, so `Text == Name`:

```json
{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":{"DeviceType":100000,"Data":{"Name":"Brightness","Text":"Brightness","Value":0}},"FunctionName":"NotifyHotKeyExecute","CurrItem":null}
```

**`NotifyEffectChange` (display)** is sent only while the display is in a ≥2-device light sync, which never happens here: `{"DeviceType":100000,"Data":<DisplayEffectInfo>}`. **`NotifyAmbiScapeFollowVideoData`**: `{"T":{"R":r,"G":g,"B":b},"B":…,"R1":…,"R2":…,"R3":…,"R4":…,"L1":…,"L2":…,"L3":…,"L4":…}` (12 §3.6).

**What the Linux backend must emit:** `NotifyUIDisplayFuncConstraintsChange` on every `PHL_GetConstraints` (the reply's Tag is ignored; §5 step 13), and whenever the constraints change after a `PHL_SetOSD`, `PHL_SetInputSource` and similar. Everything else is optional for the monitor-only port.
- `NotifyUIDisplayEffectChange` with named keys, only if ENE support is added.
- `NotifyEffectSyncDevicesChange` after `Effect_Reset`.
- `NotifyUISwitchTheme`, only if app-bound themes are implemented. That needs a foreground-window source, which GNOME Wayland does not provide.

### 2.6 Constraint states for the user's monitor (derivation of N0/N1)

The rules are in `DisplayFuncConstraints.RecheckFuncConstraints` (DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/DisplayFuncConstraints.cs:125-294). `method_5` first resets every state to 1. `method_2(x, cond)` then sets 2 when `cond` is true and 1 otherwise, and `method_3` sets a state directly. Item order is fixed by the constructor (:64-92).

Inputs, each read during the 07:52 scan:

| Input | Value | Source |
|---|---|---|
| DC | 0x21 = 33 (HDR Game) | LOG:913 |
| `IsSmartImageHDR` | true | stored profile; `GetHDR` LOG:909-910 |
| E2A040 (AdaptiveSync) | 1 | LOG:931 |
| A5 (PIP/PBP) | 0 | LOG:950 |
| 0x86 (DisplayScaling) | 2 | LOG:976 |
| E2A035 (ScreenSaver) | 2 | LOG:987 |
| E2A019 (Ambiglow mode) | read as 0, rewritten to 7 (StaticMode) because Ambiglow is off | LOG:942; CDevice_PHLDisplay.cs:382-389 |
| MonitorFrequency | "175Hz" | stored profile |
| E2A002 / E2A003 / E2A045 | not in the capability list → `err_code 9` (not available) | 03 §6.2 |

Derived flags:

| Flag | Value | Why |
|---|---|---|
| `pip` | false | A5 = 0 |
| `hdr` | true | `IsSmartImageHDR` |
| `ss` | true | E2A035 ≠ OFF |
| `sniper` | false | forced false because `hdr` |
| `async` | true | E2A040 ≠ 0 |
| `mbrOn` | false | `async` is true |
| `mbrSyncOn` | false | E2A003 unavailable |
| `hz` | 175 | MonitorFrequency |

Results:

| Item | State | Rule |
|---|---|---|
| OP_10 Luminance | 1 | HDR branch forces 1 (:200) |
| OP_12 Contrast | 1 | dc ≠ 14 |
| OP_F0 SmartContrast | **2** | `ss` |
| E2A020 ColorSpace, OP_14 ColorPreset | 1 | dc ∉ {11, 14} |
| E2A024 DLBL | **2** | dc ≠ 11 |
| E2A040 AdaptiveSync | 1 | ¬pip |
| E2A002 MBR | **2** | `async` |
| E2A003 MBRSync | 1 | ¬pip ∧ async |
| E2A004 SmartCrosshair | 1 | ¬pip |
| E2A044 StarkShadowBoost, E2A045 ShadowBoost, E2A006 SharpShooter_Size | **2** | `hdr` |
| E2A007 LowInputLag | 1 | ¬pip ∧ ¬sniper |
| OP_EB SmartResponse, E2A04C Overclock | 1 | ¬pip |
| E2A008 SmartFrame | **2** | `hdr` |
| Ambiglow 1A / 1B / 1C / 1D / 1E | 1 / 1 / 1 / **2** / 1 | StaticMode branch (:252-259) |
| OP_E0 AudioSource | **2** | ¬pip (inverted rule, :279) |
| OP_86 | 1 | never changed |
| OP_54 | 1 | ¬pip |
| OP_DA ScanMode | 1 | 0x86 = 2 ≠ NoScaling (:281-288) |
| `ModuleGameMode`, `AudioEQ` | 1 | always |

At startup the constructor's all-1 state differs from this result, so `Notify()` fires (N0). Later rechecks, after `PHL_SetOSD(E2A043)` at 08:02:49 and after `PHL_ReloadData`, find no change and emit nothing. LOG has only three `OnNotification` lines: 996, 1023 and 1082. The last two come from `PHL_GetConstraints`.

---

## 3. (c) Bridge catalog: 162 overloads, monitor-only dispositions (05 §6)

Columns:
- "Called by renderer" comes from the grep in 02 §5 (`.invoke("<Name>"` over every renderer chunk, plus `Theme_Add` and `Theme_UpdateBindApp`, which are called through a ternary at ST:33662-33676). "hidden" means the only caller is a page that the port hides (peripheral pages, SmartDesktop, Bulb, FW update, cloud).
- Disposition: **I** = implement, **S** = static stub (always `err_code 0`), **E** = error reply (`err_code 9`, `IsSucc:false`, `Tag:null`, ids echoed). A backtick string in the last column is the exact `err_msg`.
- Types: `s` = string, `i` = int, `b` = bool.
- Bridge.cs line numbers refer to `DC/Bridge.Lib/Bridge.Lib/Bridge.cs`. Where Bridge does more than a same-name call:
  - The three `Setting_*` methods never call `SystemOper`; they use `GlobalOper` inside Bridge.cs:23-42.
  - `DTS_SetAPO`/`SetBassTbhdx`/`SetDialogEnhancement` convert `bool` to `int` before calling SO.
  - Several Bridge names map to differently named SO methods, e.g. `Device_GetConnectList` → `GetConnectionDevice`, `FancyZones_*` → `*FancyZones*`, `Profile_GetDeviceData` → `GetDeviceData`, `SetGamePQ` → `PHL_SetGamePQ`. The Target column shows each one.
- All targets are CONFIRMED from Bridge.cs and the SO line index.

| # | Bridge method :line | Target | Called by renderer (where) | Disp. | Port reply |
|---|---|---|---|---|---|
| 1 | `Start()` :13 | `SystemOper.Start:107` | Y (shell: startup S(), reconnect I()) | I | Tag `true` (timing: §7.2) |
| 2 | `FactoryReset()` :18 | `SystemOper.FactoryReset:254` | Y (shell: Setting > General) | I | Tag `true`; wipes config except logs, re-inits theme, monitor reset (VCP 0x04) |
| 3 | `Setting_GlobalData()` :23 | `GlobalOper` (in Bridge) | Y (shell: Setting > General) | I | Tag `{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5}` |
| 4 | `Setting_TurnOffLightsWhenIdle(b enable)` :28 | `GlobalOper` (in Bridge) | Y (shell: Setting > General) | I | Tag `null`; persist SoftConfig.data |
| 5 | `Setting_TurnOffLightsWhenIdleDuration(i duration)` :34 | `GlobalOper` (in Bridge) | Y (shell: Setting > General) | I | Tag `null`; `duration<1`: E `"at last 1 minutes"` |
| 6 | `GetWifiList()` :44 | `SystemOper.GetWifiList:316` | Y (hidden: Bulb pairing) | E | `"not supported"` |
| 7 | `AmbiScape_EnableFollowVideo(b enable, i timeInterval)` :49 | `SystemOper.AmbiScape_EnableFollowVideo:377` | Y (hidden: App watch, only when bulbEnabled) | S | Tag `null` |
| 8 | `Button_GetFuncMenu(i device)` :54 | `SystemOper.Button_GetFuncMenu:399` | Y (hidden: peripheral pages) | E | `"No driver found!"` |
| 9 | `Button_GetStaticData(i device)` :59 | `SystemOper.Button_GetStaticData:389` | N | E | `"No driver found!"` |
| 10 | `Button_SetFunc(i device, i layer, i buttonId, i newMenu, i newFun, s value, s ext)` :64 | `SystemOper.Button_SetFunc:409` | Y (hidden: peripheral pages) | E | `"No driver found!"` |
| 11 | `Button_SetKeyboard(i device, i layer, i buttonId, i subMenu, i newFun, i modify1, i modify2, i modify3)` :69 | `SystemOper.Button_SetKeyboard:505` | Y (hidden: peripheral pages) | E | `"No driver found!"` |
| 12 | `Button_SetMacro(i device, i layer, i buttonId, s macroName, i macroPlayType, i macroPlayTimes)` :74 | `SystemOper.Button_SetMacro:597` | Y (hidden: peripheral pages) | E | `"No driver found!"` |
| 13 | `Button_RestButtons(i device, i layer)` :79 | `SystemOper.Button_RestButtons:684` | Y (hidden: peripheral pages) | E | `"No driver found!"` |
| 14 | `Comm_GenAppIcon(s appApth)` :84 | `SystemOper.Comm_GenAppIcon:694` | Y (shell: Profile > bind app) | S | Tag `""` (or an icon path from the .desktop entry) |
| 15 | `ModifierKeyListenerEnable(b isOn)` :89 | `SystemOper.ModifierKeyListenerEnable:699` | N | S | Tag `true` |
| 16 | `Device_GetConnectList()` :94 | `SystemOper.GetConnectionDevice:737` | Y (shell: startup, NotifyDeviceConnectionStatus) | I | Tag `[DeviceInfo]` (§5 step 3); must never fail |
| 17 | `Device_GetDeviceInfo(i device)` :99 | `SystemOper.GetDeviceInfo:753` | Y (hidden: peripheral pages) | I | 100000: Tag `DeviceInfo`; else E `"No driver found!"` |
| 18 | `Device_UpgradeFw(i device, s path)` :104 | `SystemOper.UpgradeFw:764` | Y (hidden: peripheral setup) | E | `"No driver found!"` |
| 19 | `GetPairDevices()` :109 | `SystemOper.GetPairDevices:774` | Y (shell: Setting menu) | S | Tag `[]` |
| 20 | `CanEnterPairing(i device, s hidStr)` :114 | `SystemOper.CanEnterPairing:792` | Y (hidden: PairingTool) | E | `"No driver found!"` |
| 21 | `EnterPairing(i device, s hidStr)` :119 | `SystemOper.EnterPairing:802` | Y (hidden: PairingTool) | E | `"No driver found!"` |
| 22 | `Device_Rescan()` :124 | `SystemOper.Rescan:228` | Y (shell: tray "rescan") | I | Tag `[DeviceInfo]` |
| 23 | `Device_DetectionUSB()` :129 | `SystemOper.UsbDeviceChange:235` | Y (shell: USBChange) | I | Tag `[DeviceInfo]` |
| 24 | `Device_DetectionDisplay()` :134 | `SystemOper.DisplayDeviceChange:241` | Y (shell: displayChange) | I | Tag `[DeviceInfo]` (vendor sleeps 5 s first) |
| 25 | `Device_OtherDeviceChange()` :139 | `SystemOper.OtherDeviceChange:248` | Y (shell: otherDeviceChange) | I | Tag `[DeviceInfo]` (no display I/O) |
| 26 | `DeviceSteup_GetPowerInfo(i device)` :144 | `SystemOper.DeviceSteup_GetPowerInfo:932` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_GetPowerInfo  return null obj"` |
| 27 | `DeviceSteup_GetBatteryCurrent(i device)` :149 | `SystemOper.DeviceSteup_GetBatteryCurrent:937` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_GetBatteryCurrent  return null obj"` |
| 28 | `DeviceSteup_GetSetupMenu(i device)` :154 | `SystemOper.DeviceSteup_GetSetupMenu:942` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_GetSetupMenu  return null obj"` |
| 29 | `DeviceSteup_GetSetupData(i device)` :159 | `SystemOper.DeviceSteup_GetSetupData:947` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_GetSetupData  return null obj"` |
| 30 | `DeviceSteup_SwitchStartupEffect(i device, b isOn)` :164 | `SystemOper.DeviceSteup_SwitchStartupEffect:952` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_SwitchStartupEffect  return null obj"` |
| 31 | `DeviceSteup_SetLowBetteryValue(i device, i value)` :169 | `SystemOper.DeviceSteup_SetLowBetteryValue:957` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_SetLowBetteryValue  return null obj"` |
| 32 | `DeviceSteup_SwitchLightSleep(i device, b isOn)` :174 | `SystemOper.DeviceSteup_SwitchLightSleep:962` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_SwitchLightSleep  return null obj"` |
| 33 | `DeviceSteup_SetLightSleepTime(i device, i time)` :179 | `SystemOper.DeviceSteup_SetLightSleepTime:967` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_SetLightSleepTime  return null obj"` |
| 34 | `DeviceSteup_SwitchDeepSleep(i device, b isOn)` :184 | `SystemOper.DeviceSteup_SwitchDeepSleep:972` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_SwitchDeepSleep  return null obj"` |
| 35 | `DeviceSteup_SetDeepSleepTime(i device, i time)` :189 | `SystemOper.DeviceSteup_SetDeepSleepTime:977` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_SetDeepSleepTime  return null obj"` |
| 36 | `DeviceSteup_LightEnable(i device, b enable)` :194 | `SystemOper.DeviceSteup_LightEnable:982` | Y (hidden: peripheral setup) | E | `"functionName: DeviceSteup_LightEnable  return null obj"` |
| 37 | `PHL_Rescan()` :199 | `SystemOper.PHL_Rescan:987` | N | I | Tag profile, or E `"Display unconnected"` |
| 38 | `PHL_SwitchDisplay(s name)` :204 | `SystemOper.PHL_SwitchDisplay:992` | Y (shell: card click, DeviceNav) | I | Tag `T_PHLDisplay_Profile`; an error shows "MonitorNoSupport" |
| 39 | `PHL_ReloadData()` :209 | `SystemOper.PHL_ReloadData:997` | Y (monitor: Sync icon) | I | Tag `T_PHLDisplay_Profile` (re-reads all VCPs) |
| 40 | `PHL_SetOSD(s itemName)` :214 | `SystemOper.PHL_SetOSD:1002` | N | E | `"not supported"` |
| 41 | `PHL_SetOSD(s itemName, i iValue)` :219 | `SystemOper.PHL_SetOSD:1007` | Y (monitor: all pages) | I | Tag `AttributeInfo`, never `null` |
| 42 | `PHL_SetSmartImage(i iValue)` :224 | `SystemOper.PHL_SetSmartImage:1012` | Y (monitor: SmartImage(HDR)) | I | Tag `{"Item1":AttributeInfo,"Item2":module}` |
| 43 | `PHL_ResetSmartImage(i iValue)` :229 | `SystemOper.PHL_ResetSmartImage:1017` | Y (monitor: SmartImage(HDR)) | I | Tag `{"Item1":AttributeInfo,"Item2":module}` |
| 44 | `PHL_SetColorPreset(i iValue)` :234 | `SystemOper.PHL_SetColorPreset:1022` | Y (monitor pages) | I | Tag = module object (03 §5) |
| 45 | `PHL_SwitchSmartFrame(i iValue)` :239 | `SystemOper.PHL_SwitchSmartFrame:1027` | Y (monitor pages) | I | Tag = module object (03 §5) |
| 46 | `PHL_SetSmartFrameSize(i iValue)` :244 | `SystemOper.PHL_SetSmartFrameSize:1032` | Y (monitor pages) | I | Tag = module object (03 §5) |
| 47 | `PHL_SetInputSource(i inputSource, i pippbpSource, i mode, i size, i location)` :249 | `SystemOper.PHL_SetInputSource:1037` | Y (monitor pages) | I | Tag = module object (03 §5) |
| 48 | `PHL_SwrapPIPPBP()` :254 | `SystemOper.PHL_SwrapPIPPBP:1042` | Y (monitor pages) | I | Tag = module object (03 §5) |
| 49 | `PHL_SetAudioEQ(i index, i iValue)` :259 | `SystemOper.PHL_SetAudioEQ:1047` | Y (monitor pages) | I | Tag = module object (03 §5) |
| 50 | `PHL_GetConstraints()` :264 | `SystemOper.PHL_GetConstraints:1052` | Y (monitor: shell mount) | I | Notification first, then Tag `DisplayFuncConstraints` |
| 51 | `SetGamePQ(i iValue, b IsShow, b R, b G, b B, b C, b M, b Y)` :269 | `SystemOper.PHL_SetGamePQ:1057` | N | S | Tag `ModuleGameMode` (vendor no-op) |
| 52 | `PHL_ProfileAction(i iValue, i action)` :274 | `SystemOper.PHL_ProfileAction:1062` | N | E | `"EXT_OP_E2A0_6B_Profile Unavailable"` |
| 53 | `PHL_GetHotKeyMenu()` :279 | `SystemOper.PHL_GetHotKeyMenu:1067` | N | S | Tag `[]` |
| 54 | `PHL_GetHotKeyData()` :284 | `SystemOper.PHL_GetHotKeyData:1072` | N | S | Tag `null` |
| 55 | `PHL_SetHotKeyEnable(b enable)` :289 | `SystemOper.PHL_SetHotKeyEnable:1077` | N | S | Tag `null` |
| 56 | `PHL_SetHotKeyItemEnable(s func, b enable)` :294 | `SystemOper.PHL_SetHotKeyItemEnable:1082` | N | S | Tag `null` |
| 57 | `PHL_SetHotKey(s func, i code, b alt, b ctrl, b shift, b win, b bHotKeyExt)` :299 | `SystemOper.PHL_SetHotKey:1087` | N | S | Tag `null` |
| 58 | `PHL_DeleteHotKey(s func)` :304 | `SystemOper.PHL_DeleteHotKey:1101` | N | S | Tag `null` |
| 59 | `GetHotKeyState(i keyCode, b alt, b ctrl, b shift, b win)` :309 | `SystemOper.GetHotKeyState:1092` | N | S | Tag `false` |
| 60 | `PHL_EnableGamePQMouseKey(b enable)` :314 | `SystemOper.PHL_EnableGamePQMouseKey:1106` | N | S | Tag `null` |
| 61 | `PHL_SetGamePQMouseKeyBind(i mouseButton)` :319 | `SystemOper.PHL_SetGamePQMouseKeyBind:1111` | N | S | Tag `null` |
| 62 | `DisplayFW_CheckUpstreamCable()` :324 | `SystemOper.DisplayFW_CheckUpstreamCable:1116` | Y (hidden: FW upgrade) | S | Tag `true`, `err_msg:null` |
| 63 | `DisplayFW_GetMonitorCount()` :329 | `SystemOper.DisplayFW_GetMonitorCount:1121` | Y (hidden: FW upgrade) | S | Tag `1`, `err_msg:null` |
| 64 | `DisplayFW_GetDeviceList()` :334 | `SystemOper.DisplayFW_GetDeviceList:1126` | Y (shell: saveDeviceList, not awaited) | S | Tag `[]` (§3.1) |
| 65 | `DisplayFW_UpdateFirmversion(s scalerModelName, i deviceType, s fwFile)` :339 | `SystemOper.DisplayFW_UpdateFirmversion:1131` | Y (hidden: FW upgrade) | E | `"firmware update not supported"` |
| 66 | `DisplayFW_InstallDriver(s type, s exePath)` :344 | `SystemOper.DisplayFW_InstallDriver:1136` | N | S | Tag `null`, `err_msg:null` |
| 67 | `DisplayFW_FWUpdateFailedNextTime(i flag)` :349 | `SystemOper.DisplayFW_FWUpdateFailedNextTime:1141` | N | E | `"firmware update not supported"` |
| 68 | `DTS_Open(i device)` :354 | `SystemOper.DTS_Open:1151` | N | E | `"No driver found!"` |
| 69 | `DTS_Close(i device)` :359 | `SystemOper.DTS_Close:1161` | N | E | `"No driver found!"` |
| 70 | `DTS_SetAPO(i device, b enable)` :364 | `SystemOper.DTS_SetAPO:1181` | Y (hidden: headset) | E | `"No driver found!"` |
| 71 | `DTS_SetRooms(i device, i room)` :369 | `SystemOper.DTS_SetRooms:1261` | Y (hidden: headset) | E | `"No driver found!"` |
| 72 | `DTS_SetStereoPreference(i device, i stereoPreference)` :374 | `SystemOper.DTS_SetStereoPreference:1291` | Y (hidden: headset) | E | `"No driver found!"` |
| 73 | `DTS_SetBassTbhdx(i device, b enable)` :379 | `SystemOper.DTS_SetBassTbhdx:1271` | Y (hidden: headset) | E | `"No driver found!"` |
| 74 | `DTS_SetDialogEnhancement(i device, b enable)` :384 | `SystemOper.DTS_SetDialogEnhancement:1251` | Y (hidden: headset) | E | `"No driver found!"` |
| 75 | `DTS_SetPreset(i device, i presetMode)` :389 | `SystemOper.DTS_SetPreset:1221` | Y (hidden: headset) | E | `"No driver found!"` |
| 76 | `DTS_SetGeqBandGain(i device, s iValues)` :394 | `SystemOper.DTS_SetGeqBandGain:1321` | Y (hidden: headset) | E | `"No driver found!"` |
| 77 | `DTS_GraphicEqRest(i device)` :399 | `SystemOper.DTS_GraphicEqRest:1311` | Y (hidden: headset) | E | `"No driver found!"` |
| 78 | `DTS_SaveGeqBandGain(i device)` :404 | `SystemOper.DTS_SaveGeqBandGain:1331` | Y (hidden: headset) | E | `"No driver found!"` |
| 79 | `Effect_CheckDynamicLightingEnabled()` :409 | `SystemOper.Effect_CheckDynamicLightingEnabled:1385` | Y (monitor: Ambiglow (2 s poll)) | S | Tag `-1` |
| 80 | `Effect_OpenDynamicLightingSetting()` :414 | `SystemOper.Effect_OpenDynamicLightingSetting:1390` | Y (monitor: Ambiglow) | S | Tag `null` |
| 81 | `Effect_GetColorData()` :419 | `SystemOper.Effect_GetColorData:1351` | Y (shell: Home mount; Ambiglow) | I | Tag `EffectColorData` (Config/color.data) |
| 82 | `Effect_SetSelfColors(s colors)` :424 | `SystemOper.Effect_SetSelfColors:1365` | Y (shell: Home mount; Ambiglow) | I | Tag `EffectColorData` (Config/color.data) |
| 83 | `Effect_GetMenu(i device)` :429 | `SystemOper.Effect_GetMenu:1401` | Y (monitor: only when ENEEffectEnable) | S | Tag `DisplayEffectMenu.Default("")` (12 App. D.2) |
| 84 | `Effect_GetLEDs(i device)` :434 | `SystemOper.Effect_GetLEDs:1406` | Y (monitor: ENE preview only) | E | `"not ene follow video or audio"` |
| 85 | `Effect_Enable(i device, b enable)` :439 | `SystemOper.Effect_Enable:1411` | Y (monitor: Ambiglow switch) | I | 100000: Tag `true`/`false` (DDC E2A019) |
| 86 | `Effect_Change(i device, i effect)` :444 | `SystemOper.Effect_Change:1416` | Y (monitor: ENE branch only) | E | `"Not Support ENE"` |
| 87 | `Effect_RandomEnable(i device, b isRandom)` :449 | `SystemOper.Effect_RandomEnable:1421` | Y (monitor: ENE branch only) | E | `"Not Support ENE"` |
| 88 | `Effect_RainbowEnable(i device, b isRainbow)` :454 | `SystemOper.Effect_RainbowEnable:1426` | Y (monitor: ENE branch only) | E | `"Not Support ENE"` |
| 89 | `Effect_ColorChange(i device, i r, i g, i b)` :459 | `SystemOper.Effect_ColorChange:1431` | Y (monitor: ENE branch only) | E | `"Not Support ENE"` |
| 90 | `Effect_BgColorChange(i device, i r, i g, i b)` :464 | `SystemOper.Effect_BgColorChange:1436` | N | E | `"Not Support ENE"` |
| 91 | `Effect_SpeedChange(i device, i speed)` :469 | `SystemOper.Effect_SpeedChange:1441` | Y (monitor: ENE branch only) | E | `"Not Support ENE"` |
| 92 | `Effect_BrightnessChange(i device, i brightness)` :474 | `SystemOper.Effect_BrightnessChange:1446` | Y (monitor: ENE branch only) | E | `"Not Support ENE"` |
| 93 | `Effect_DirectionChange(i device, i direction)` :479 | `SystemOper.Effect_DirectionChange:1451` | Y (monitor: ENE branch only) | E | `"Not Support ENE"` |
| 94 | `Effect_RegionChange(i device, i region)` :484 | `SystemOper.Effect_RegionChange:1456` | Y (monitor: ENE branch only) | E | `"Not Support ENE"` |
| 95 | `Effect_Reset(i device)` :489 | `SystemOper.Effect_Reset:1461` | Y (monitor: Ambiglow reset) | I | Tag `DisplayModuleAmbiglow` + NotifyEffectSyncDevicesChange |
| 96 | `SyncEffect_GetData()` :494 | `SystemOper.SyncEffect_GetData:1518` | Y (shell: Home mount) | I | Tag `T_Sync_Profile` (§5 step 6, §3.1) |
| 97 | `SyncEffect_EnableDevice(i device, s selDevices)` :499 | `SystemOper.SyncEffect_EnableDevice:1535` | Y (monitor: LightSync) | E | `"Input device=100000 EffectDetail is null"` |
| 98 | `FancyZones_Enable(b enable)` :504 | `SystemOper.EnableFancyZones:1901` | Y (hidden: SmartDesktop) | E | `"not supported"` |
| 99 | `FancyZones_StartEditor()` :509 | `SystemOper.StartFancyZonesEditor:1907` | Y (hidden: SmartDesktop) | E | `"not supported"` |
| 100 | `FancyZones_GetVersion()` :514 | `SystemOper.GetFancyZonesVersion:1912` | Y (hidden: SmartDesktop) | S | Tag `{"StrVersion":"V0.0.0.0","Version":0,"DP_DeviceType":"SmartDesktop","DP_ComponentID":"Philips_SmartDesktop"}` |
| 101 | `FancyZones_GetData()` :519 | `SystemOper.GetFancyZonesData:1917` | Y (hidden: SmartDesktop) | E | `"not supported"` |
| 102 | `FancyZones_SetSetting(s settingName, s settingValue)` :524 | `SystemOper.SetFancyZonesSetting:1922` | Y (hidden: SmartDesktop) | E | `"not supported"` |
| 103 | `Keyboard_GetGameMode(i device)` :529 | `SystemOper.Keyboard_GetGameMode:1932` | Y (hidden: keyboard) | E | `"No driver found!"` |
| 104 | `Keyboard_SwitchGameMode(i device, b enable)` :534 | `SystemOper.Keyboard_SwitchGameMode:1942` | Y (hidden: keyboard) | E | `"No driver found!"` |
| 105 | `Keyboard_SetGameMode(i device, i gameModeType, b status)` :539 | `SystemOper.Keyboard_SetGameMode:1952` | Y (hidden: keyboard) | E | `"No driver found!"` |
| 106 | `Keyboard_ResetGameMode(i device)` :544 | `SystemOper.Keyboard_ResetGameMode:1962` | Y (hidden: keyboard) | E | `"No driver found!"` |
| 107 | `Macro_GetList(s themeName)` :549 | `SystemOper.Macro_GetList:1972` | Y (shell: startup C(), theme change) | I | Tag `[]` without a Macro dir; unknown theme: E code 3 |
| 108 | `Macro_GetDetail(s themeName, s name)` :554 | `SystemOper.Macro_GetDetail:2012` | Y (hidden: macro editor) | E | `"not supported"` |
| 109 | `Macro_GetDetail(s filePath)` :559 | `SystemOper.Macro_GetDetail:2022` | Y (hidden: macro editor) | E | `"not supported"` |
| 110 | `Macro_Add(s themeName, s name)` :564 | `SystemOper.Macro_Add:2046` | Y (hidden: macro editor) | E | `"not supported"` |
| 111 | `Macro_VerifyFile(s filePath)` :569 | `SystemOper.Macro_VerifyFile:2031` | Y (hidden: macro editor) | E | `"not supported"` |
| 112 | `Macro_Copy(s themeName, s name, s newName)` :574 | `SystemOper.Macro_Copy:2087` | Y (hidden: macro editor) | E | `"not supported"` |
| 113 | `Macro_Rename(s themeName, s oldName, s newName)` :579 | `SystemOper.Macro_Rename:2133` | Y (hidden: macro editor) | E | `"not supported"` |
| 114 | `Macro_Update(s themeName, s name, s macroData)` :584 | `SystemOper.Macro_Update:2226` | Y (hidden: macro editor) | E | `"not supported"` |
| 115 | `Macro_Del(s themeName, s name)` :589 | `SystemOper.Macro_Del:2313` | Y (hidden: macro editor) | E | `"not supported"` |
| 116 | `Macro_Import(s themeName, s filePath, b bOverride)` :594 | `SystemOper.Macro_Import:2401` | Y (hidden: macro editor) | E | `"not supported"` |
| 117 | `Macro_Export(s themeName, s name, s exportPath)` :599 | `SystemOper.Macro_Export:2503` | Y (hidden: macro editor) | E | `"not supported"` |
| 118 | `Macro_GetFuncMenu()` :604 | `SystemOper.Macro_GetFuncMenu:2544` | Y (shell: startup C()) | S | static Tag (§5 step 9) |
| 119 | `Mouse_ChangeDPI(i device, i dpiIndex)` :609 | `SystemOper.Mouse_ChangeDPI:2849` | Y (hidden: mouse) | E | `"functionName: Mouse_ChangeDPI  return null obj"` |
| 120 | `Mouse_GetMouseMenu(i device)` :614 | `SystemOper.Mouse_GetMouseMenu:2854` | Y (hidden: mouse) | E | `"functionName: Mouse_GetMouseMenu  return null obj"` |
| 121 | `Mouse_ChangeDPIValue(i device, i dpiLevel, i dpiIndex, i dpiValue)` :619 | `SystemOper.Mouse_ChangeDPIValue:2859` | Y (hidden: mouse) | E | `"functionName: Mouse_ChangeDPIValue  return null obj"` |
| 122 | `Mouse_ChangeDPILevel(i device, i level)` :624 | `SystemOper.Mouse_ChangeDPILevel:2864` | Y (hidden: mouse) | E | `"functionName: Mouse_ChangeDPILevel  return null obj"` |
| 123 | `Mouse_ChangeSmartDPI(i device, i value)` :629 | `SystemOper.Mouse_ChangeSmartDPI:2869` | Y (hidden: mouse) | E | `"functionName: Mouse_ChangeSmartDPI  return null obj"` |
| 124 | `Mouse_ChangeLod(i device, s value)` :634 | `SystemOper.Mouse_ChangeLod:2874` | Y (hidden: mouse) | E | `"functionName: Mouse_ChangeLod  return null obj"` |
| 125 | `Mouse_BindSmartDPIToButton(i device, i buttonId, i layer)` :639 | `SystemOper.Mouse_BindSmartDPIToButton:2879` | Y (hidden: mouse) | E | `"No driver found!"` |
| 126 | `Mouse_GetMouseParam(i device)` :644 | `SystemOper.Mouse_GetMouseParam:2911` | N | E | `"functionName: Mouse_GetMouseParam  return null obj"` |
| 127 | `Mouse_ChangeDoubleClickSpeed(i device, i speed)` :649 | `SystemOper.Mouse_ChangeDoubleClickSpeed:2916` | Y (hidden: mouse) | E | `"functionName: Mouse_ChangeDoubleClickSpeed  return null obj"` |
| 128 | `Mouse_ChangeScrollSpeed(i device, i speed)` :654 | `SystemOper.Mouse_ChangeScrollSpeed:2921` | Y (hidden: mouse) | E | `"functionName: Mouse_ChangeScrollSpeed  return null obj"` |
| 129 | `Mouse_ResetParam(i device)` :659 | `SystemOper.Mouse_ResetParam:2926` | Y (hidden: mouse) | E | `"functionName: Mouse_ResetParam  return null obj"` |
| 130 | `Mouse_ChangeRepotRate(i device, i value)` :664 | `SystemOper.Mouse_ChangeRepotRate:2931` | Y (hidden: mouse) | E | `"functionName: Mouse_ChangeRepotRate  return null obj"` |
| 131 | `Profile_GetDeviceData(i device)` :669 | `SystemOper.GetDeviceData:2941` | Y (monitor: shell mount) | I | 100000: Tag `T_PHLDisplay_Profile`; else E `"functionName: Profile_GetDeviceData  return null obj"` |
| 132 | `Profile_Reset(i device)` :674 | `SystemOper.Reset:2946` | Y (monitor: Setup > Reset) | I | 100000: Tag `T_PHLDisplay_Profile` |
| 133 | `Profile_GetBoard(i device)` :679 | `SystemOper.Profile_GetBoard:2951` | Y (hidden: onboard panel) | E | `"functionName: Profile_GetBoard  return null obj"` |
| 134 | `Profile_EnableOnboard(i device, b enable)` :684 | `SystemOper.Profile_EnableOnboard:2956` | Y (hidden: onboard panel) | E | `"functionName: Profile_EnableOnboard  return null obj"` |
| 135 | `Profile_SwitchOnboard(i device, i boardId)` :689 | `SystemOper.Profile_SwitchOnboard:2961` | Y (hidden: onboard panel) | E | `"functionName: Profile_SwitchOnboard  return null obj"` |
| 136 | `Profile_SyncOnBoard(i device)` :694 | `SystemOper.Profile_SyncOnBoard:2966` | Y (hidden: onboard panel) | E | `"functionName: Profile_SyncOnBoard  return null obj"` |
| 137 | `Profile_ResetOnboard(i device, i boardId)` :699 | `SystemOper.Profile_ResetOnboard:2984` | Y (hidden: onboard panel) | E | `"functionName: Profile_ResetOnboard  return null obj"` |
| 138 | `Profile_ClearOnBoardMacro(i device, i boardId)` :704 | `SystemOper.Profile_ClearOnBoardMacro:2989` | Y (hidden: onboard panel) | E | `"functionName: Profile_ClearOnBoardMacro  return null obj"` |
| 139 | `Profile_ApplyOnboard(i device, i boardId, s themeName, s profileName)` :709 | `SystemOper.Profile_ApplyOnboard:2971` | Y (hidden: onboard panel) | E | `"functionName: Profile_ApplyOnboard  return null obj"` |
| 140 | `Theme_GetCurTheme()` :714 | `SystemOper.Theme_GetCurTheme:2994` | Y (shell: startup C()) | I | Tag `ThemeInfo` |
| 141 | `Theme_GetCurProfile()` :719 | `SystemOper.Theme_GetCurProfile:2999` | N | I | Tag `T_Theme_Profile` |
| 142 | `Theme_GetThemeInfos()` :724 | `SystemOper.Theme_GetThemeInfos:3004` | Y (shell: startup C(), Profile page) | I | Tag `[ThemeInfo]` |
| 143 | `Theme_Switch(s themeName, s profileName)` :729 | `SystemOper.Theme_Switch:3019` | Y (shell: header selector, NotifyUISwitchTheme) | I | Tag `ThemeInfo`; re-applies the profile to the monitor |
| 144 | `Theme_SwitchApp(s themeName)` :734 | `SystemOper.Theme_SwitchApp:3054` | Y (shell: header selector, NotifyUISwitchTheme) | I | Tag `ThemeInfo`; re-applies the profile to the monitor |
| 145 | `Theme_Add(s themeName, s param)` :739 | `SystemOper.Theme_Add:3061` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 146 | `Theme_Del(s themeName)` :744 | `SystemOper.Theme_Del:3066` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 147 | `Theme_Rename(s themeName, s newThemeName)` :749 | `SystemOper.Theme_Rename:3075` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 148 | `Theme_UpdateBindApp(s themeName, s param)` :754 | `SystemOper.Theme_UpdateBindApp:3080` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 149 | `Theme_AddProfile(s themeName, s profileName)` :759 | `SystemOper.Theme_AddProfile:3229` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 150 | `Theme_CopyProfile(s themeName, s profileName, s newProfileName)` :764 | `SystemOper.Theme_CopyProfile:3234` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 151 | `Theme_RenameProfile(s themeName, s profileName, s newProfileName)` :769 | `SystemOper.Theme_RenameProfile:3239` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 152 | `Theme_DelProfile(s themeName, s profileName)` :774 | `SystemOper.Theme_DelProfile:3244` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 153 | `Theme_ImportProfile(s themeName, s filePath, b bOverride=false)` :779 | `SystemOper.Theme_ImportProfile:3253` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 154 | `Theme_ExportProfile(s themeName, s profileName, s filePath)` :784 | `SystemOper.Theme_ExportProfile:3267` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 155 | `Theme_HandleCycleProfile(s themeName, s profileName, b bAdd)` :789 | `SystemOper.Theme_HandleCycleProfile:3272` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 156 | `Theme_ResetCurProfile()` :794 | `SystemOper.Theme_ResetCurProfile:3277` | Y (shell: Profile page) | I | vendor Tags (file ops under Theme/) |
| 157 | `Theme_GetDevicesBasicInfo(i equipmentType)` :799 | `SystemOper.Theme_GetDevicesBasicInfo:3363` | Y (shell: AboutDevice) | I | Tag `DataBasicInfo` (§5 step 18) |
| 158 | `Theme_GetDevicesBasicInfo(s themeName, s profileName, i equipmentType)` :804 | `SystemOper.Theme_GetDevicesBasicInfo:3372` | Y (shell: Profile page) | I | Tag `DataBasicInfo` |
| 159 | `Theme_GetDevicesBasicInfo(s profilePath, i equipmentType)` :809 | `SystemOper.Theme_GetDevicesBasicInfo:3377` | Y (shell: Profile page) | I | Tag `DataBasicInfo` |
| 160 | `Theme_GetProfileDesc(s profilePath)` :814 | `SystemOper.Theme_GetProfileDesc:3441` | Y (shell: Profile import) | I | vendor Tag |
| 161 | `Theme_GetProfileDesc(s themeName, s profileName)` :819 | `SystemOper.Theme_GetProfileDesc:3446` | Y (shell: Profile page) | I | vendor Tag |
| 162 | `Theme_ApplyProfile(s themeName, s profileName, s profilePath, s selDevices)` :824 | `SystemOper.Theme_ApplyProfile:3456` | Y (hidden: cloud profile apply) | E | `"not supported"` |

Counts: 54 I, 23 S, 85 E. 140 overloads (136 names) are called by some renderer chunk and 22 are never called. The 22 are the 21 names in 02 §5.8 plus the one-argument `PHL_SetOSD(s)` overload. Of the called ones, only these are reachable after the port's patches:
- the shell set (startup, Setting > General/About/AboutDevice, Profile page);
- the monitor pages;
- `DisplayFW_GetDeviceList`, which `saveDeviceList` calls unconditionally.

### 3.1 Stub details the renderer depends on (CONFIRMED consumer lines)

| Function | Exact Tag | Consumer and why this shape |
|---|---|---|
| `GetPairDevices` | `[]` | ST:35338-35341 does `e.map(...)`, and an empty list hides the PairingTool menu (`r.value.length \|\| 5 !== i.value \|\| (i.value = 0)`). Also the vendor result with only a display connected: `CDeviceBase.GetPairDevices()` → `Error("operation is not implemented")` is skipped (SO:774-790; DC/Zeasn.Equipment.Base.Lib/…/CDeviceBase.cs:111-114, 149-152) |
| `Macro_GetList("User")` with no macros | `[]` | Vendor: `GetFileNameListOrderByCreateTime` returns an empty list for a missing `Theme/User/Macro` (DC/Zeasn.Com.Lib/…/DirectroyUtil.cs:153-159; SO:1972-2003). Consumer `saveMacroList` does `e.map` (ST:40758-40760). The theme dir must exist, or the vendor returns `err_code 3` `"Theme=User path=<dir> not exit"` (SO:2009) |
| `SyncEffect_GetData` with no peripherals and ENE absent | `{"EffectDetailInfo":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":2,"Brightness":2,"IsRandomColor":false,"IsRainbowColor":false,"CurRGB":{"R":255,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"SyncDevices":[]}` | Vendor: `smethod_11` → `T_Sync_Profile.Check()` replaces the null `EffectDetailInfo` with a default `BaseEffectDetailInfo`, which is `Off`, speed 2, brightness 2, `RGB.Red`/`RGB.Black`, `CurDir -1`, `CurRegion 0`, `CurStarCount 1` (SO:1638-1726; DC/…Entity.Lib/…/T_Sync_Profile.cs `Check`; BaseEffectDetailInfo.cs). The display is **not** added, because its `EffectType` is `Default` when ENE is absent (CDevice_PHLDisplay.cs:83-96; CDeviceEffectBase.cs:16; SO:1661). Consumer `saveSyncModels(e.SyncDevices)` → `e.filter(...)` (ST:44794-44796). `SyncDevices` must be an array |
| `Effect_CheckDynamicLightingEnabled` | `-1` | The vendor reads the Windows registry and returns -1 when the value is absent (DC/…Framework.Core.Lib/…/DynamicLghtingUtil.cs:9-18). The Ambiglow page poll `e >= 0 && (…setTimeout(Me, 2e3))` stops at -1 and leaves the "Dynamic Lighting" hint off (Ambiglow-Dvqon39u.js:885-891) |
| `DisplayFW_GetDeviceList` (OTA removed) | `[]` | `saveDeviceList` calls it only when a monitor is present and **does not await it**: `getMonitorFwList().then(e => { e.forEach(…); localStorage.monitorFw = … }).catch(() => {})` (ST:44695-44705). An **error reply** is swallowed by that `.catch`. A `null` Tag throws in `e.forEach`, and the throw is also swallowed. Either way startup is not blocked. `[]` is the cleanest: `localStorage.monitorFw = "[]"`, and the FirmwareManager (hidden by 02 P9) would show an empty list (its own `.catch` sets state 3, ST:33851-33853) |
| `DisplayFW_CheckUpstreamCable` / `DisplayFW_GetMonitorCount` | `true` / `1` | Only the FW-upgrade validation calls them (hidden once `OTAEnable:false`) |
| `FancyZones_GetVersion` | `{"StrVersion":"V0.0.0.0","Version":0,"DP_DeviceType":"SmartDesktop","DP_ComponentID":"Philips_SmartDesktop"}` | This is the vendor "not installed" reply: `"V" + (FileVersion ?? "0.0.0.0")`, `ConvertSoftVersion(null) = 0`, fields first and then the `ExternInfoBase` properties (FancyZonesOper.cs:20-37, 189-211; DC/…Entity.Lib/…/ExternInfoBase.cs). The SmartDesktop page is hidden by 02 P11 |
| `Macro_GetFuncMenu` | 4025-character object, §5 step 9 | `CP(e.Items)` needs `Items[].{Name,Text,Value,ChildList}` (ST:40736-40757) |
| `Comm_GenAppIcon` | `""` | ST:42539-42560 stores it as `icon`. An empty string gives a blank icon, and nothing throws |
| `Effect_GetMenu(100000)` | `DisplayEffectMenu.Default("")` (12 App. D.2) | Called only when `ENEEffectEnable` is true (Monitor-D4qz4RBn.js:45-48; Setup-D-5j4V-I.js:129-131). Never called while ENE is absent |

---

## 4. (a/c support) Persistence touched by the monitor subset (05 §7, compact)

Every file is UTF-8 **with BOM** and holds a single line of Newtonsoft `JsonSerialize()` output (nulls kept). `SaveTXTConfig` refuses content that contains `\r\n` (DC/Zeasn.Com.Lib/…/SerializedFileUtil.cs:101-132, 282-308). A missing file loads as `null` (:134-164). CONFIRMED by the BOM hexdump of `CFG/Theme/DataTheme.cfg` (`EF BB BF`).

| File (under `%APPDATA%\EvniaServe\`) | Content on the user's machine | Used by |
|---|---|---|
| `Config\SoftConfig.data` | `{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5}` (CONFIRMED) | `Setting_*` |
| `Config\color.data` | absent, so `Effect_GetColorData` returns `EffectColorData.DefData()` | `Effect_GetColorData`/`SetSelfColors` |
| `Config\data.json` | signed VCP-capability cache (05 summary, 07) | display scan |
| `Theme\DataTheme.cfg` | `{"ThemeInfos":[{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]}]}` (CONFIRMED) | `Theme_*` |
| `Theme\User\Default.pcenter` | `{"Sync_Profile":{"EffectDetailInfo":null,"SyncDevices":[]},"Profiles":[{"ProfileDesc":{"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":""},"ProfileContent":"<IgnoreProfile JSON, 10 737 chars>"}]}` (CONFIRMED) | `Profile_*`, `Theme_GetDevicesBasicInfo` |
| `Theme\<t>\Macro\<name>.macro` | none | `Macro_*` |

`FactoryReset` (SO:254-302) deletes every file directly under `%APPDATA%\EvniaServe` and every sub-directory except `logs`. It then re-creates `DataTheme.cfg`, resets each connected device (for the monitor that means VCP 0x04, 5 s sleep, reload) and saves.

---

## 5. (d) Golden transcript, user's session 2026-09-26

Setup: the 34M2C8600 is connected over USB-DDC through the VIA-RTK hub, the ENE controller is **absent**, there are no peripherals, the SN is `AU00000000001`, and the machine uses the user's persisted config (§4).

Rules for reading this section:
- `␞` = 0x1E.
- Request strings and ids are verbatim from LOG. Two ids are synthetic: steps 17 and 18 do not occur in the 2026-09-26 log.
- `invocationId`s count per connection from `"0"` (ST:6904-6916). Because processing is serial per connection, the log order is the arrival order.
- Every reply `R` below is the **exact inner string**, property order per 12 §2.2. It travels as `{"type":1,"target":"GetTaskAsync","arguments":[<R as JSON string>]}␞` and is followed by `{"type":3,"invocationId":"<n>","result":null}␞` (§1.4).
- Only the Newtonsoft-generated inner strings are byte-exact claims. Frame-level escaping is INFERRED (§1.4).

### Step 1: handshake (CONFIRMED client side, ST:6490-6508; server INFERRED)

```
C→S  {"protocol":"json","version":1}␞
S→C  {}␞
C→S  {"type":6}␞                         (client ping right after the handshake; then every 15 s)
S→C  {"type":6}␞                         (server keep-alive, every 15 s, independent of running hub methods)
```

### Step 2: `Start` (request 07:52:30.9457, reply ≈07:52:52.39; LOG:8-1005)

```
C→S  {"arguments":["{\"functionName\":\"Start\",\"requestId\":\"683a49b0-ff8e-4e9e-aa25-30a2e8d09b87\",\"parms\":null}"],"invocationId":"0","target":"GetTaskAsync","type":1}␞
```

During the scan, at 07:52:52.1834 (LOG:996), `ParameterToDevice` → `RecheckFuncConstraints` sees the constraints JSON change from the all-1 constructor state and calls `Notify()`. This is PHL/CDevice_PHLDisplay.cs:585-613, line 601, and DisplayFuncConstraints.cs:125-130, 288-293. It falls between "ParameterToDevice TotalMilliseconds" (LOG:995, :599) and "ParameterToDevice end" (LOG:997, :612). CONFIRMED by ordering.

```
S→C  {"type":1,"target":"Notification","arguments":[N0]}␞
N0 = {"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":{"FuncItems":[{"FuncId":16,"FuncName":"OP_10_Luminance","State":1},{"FuncId":18,"FuncName":"OP_12_Contrast","State":1},{"FuncId":240,"FuncName":"OP_F0_SmartContrast","State":2},{"FuncId":14852128,"FuncName":"EXT_OP_E2A0_20_ColorSpace","State":1},{"FuncId":20,"FuncName":"OP_14_SelectColorPreset","State":1},{"FuncId":14852132,"FuncName":"EXT_OP_E2A0_24_DLBL","State":2},{"FuncId":14852160,"FuncName":"EXT_OP_E2A0_40_AdaptiveSync","State":1},{"FuncId":14852098,"FuncName":"EXT_OP_E2A0_02_MBR","State":2},{"FuncId":14852099,"FuncName":"EXT_OP_E2A0_03_MBRSync","State":1},{"FuncId":14852100,"FuncName":"EXT_OP_E2A0_04_SmartCrosshair","State":1},{"FuncId":14852164,"FuncName":"EXT_OP_E2A0_44_StarkShadowBoost","State":2},{"FuncId":14852165,"FuncName":"EXT_OP_E2A0_45_ShadowBoost","State":2},{"FuncId":14852102,"FuncName":"EXT_OP_E2A0_06_SharpShooter_Size","State":2},{"FuncId":14852103,"FuncName":"EXT_OP_E2A0_07_LowInputLag","State":1},{"FuncId":235,"FuncName":"OP_EB_SmartResponse","State":1},{"FuncId":14852172,"FuncName":"EXT_OP_E2A0_4C_Overclock","State":1},{"FuncId":14852104,"FuncName":"EXT_OP_E2A0_08_SmartFrame","State":2},{"FuncId":14852122,"FuncName":"EXT_OP_E2A0_1A_AmbiglowColors","State":1},{"FuncId":14852123,"FuncName":"EXT_OP_E2A0_1B_AmbiglowLightPosition","State":1},{"FuncId":14852124,"FuncName":"EXT_OP_E2A0_1C_AmbiglowLightBrightness","State":1},{"FuncId":14852125,"FuncName":"EXT_OP_E2A0_1D_AmbiglowLightSpeed","State":2},{"FuncId":14852126,"FuncName":"EXT_OP_E2A0_1E_AmbiglowLightDirection","State":1},{"FuncId":224,"FuncName":"OP_E0_AudioSource","State":2},{"FuncId":134,"FuncName":"OP_86_DisplayScaling","State":1},{"FuncId":84,"FuncName":"OP_54_PerformancePreservation","State":1},{"FuncId":218,"FuncName":"OP_DA_ScanMode","State":1}],"ModuleGameMode":1,"AudioEQ":1},"FunctionName":"NotifyUIDisplayFuncConstraintsChange","CurrItem":null}
```

The renderer **drops N0**. Its only subscriber is registered in Home's `onMounted` (MN:1832-1841), and Home mounts only after `isBackendInit`, which is set after `Start` **and** `Device_GetConnectList` (MN:186-200). CONFIRMED by code.

```
S→C  {"type":1,"target":"GetTaskAsync","arguments":[R]}␞      then  {"type":3,"invocationId":"0","result":null}␞
R = {"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"683a49b0-ff8e-4e9e-aa25-30a2e8d09b87","Tag":true,"FunctionName":"Start","CurrItem":null}
```

### Step 3: `Device_GetConnectList` (07:52:52.3943, invocationId 1; LOG:1005-1010)

Request `{"functionName":"Device_GetConnectList","requestId":"d85976b8-9e88-45b6-8a28-d76cef48b3f7","parms":null}`.

```
R = {"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"d85976b8-9e88-45b6-8a28-d76cef48b3f7","Tag":[{"StrFwVersion":null,"FwVersion":0,"ExtDeviceInfo":{"CurSN":"AU00000000001","DisplayList":[{"DisplayName":"PHL 34M2C8600","MonitorName":"PHL 34M2C8600","DeviceName":"\\\\.\\DISPLAY1","DisplaySN":"AU00000000001"}]},"DeviceType":100000,"FactoryType":1,"EquipmentType":1,"ModelName":"PHL 34M2C8600","ExtModel":"","HasBattery":false,"Vid":0,"Pid":0,"IUSB_USAGE_PAGE":0,"IUSB_USAGE":0,"CreateDevice":0,"CheckFState":0,"SupEffect":true,"SupSync":true,"ProfileCount":1,"SupGameMode":false,"Extra":"","ConnectMode":-1}],"FunctionName":"Device_GetConnectList","CurrItem":null}
```

Derivation of each field:

| Field(s) | Value and source |
|---|---|
| `StrFwVersion` / `FwVersion` / `ExtDeviceInfo` | `DeviceInfo`'s own properties come first (DC/…Entity.Lib/…/DeviceInfo.cs). `StrFwVersion` is never set for the display, so `null`; `FwVersion` is `0`. CONFIRMED: no assignment anywhere in Base, Option or PHLDisplay |
| `ExtDeviceInfo` | `ExternDispalyInfo{CurSN, DisplayList}` (DC/…Option.Lib/…/ExternDispalyInfo.cs; PHL/CDevice_PHLDisplay.cs:218-225). `UIDisplayInfo` has four public **fields** in the order `DisplayName, MonitorName, DeviceName, DisplaySN` (DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Entity.Lib/UIDisplayInfo.cs) |
| `DisplaySN` / `CurSN` | `AU00000000001`: LOG:360, 368, and the renderer sent it back at LOG:1019. CONFIRMED |
| `DisplayName` / `MonitorName` | Both come from the EDID model string (`Display(IMonitorDevice)`, DC/Zeasn.PCenter.Base.Lib/…/Display.cs:180-186). The value is `"PHL 34M2C8600"`, CONFIRMED by LOG:365 `PHL 34M2C8600: Hub SetStandardDDC`, which prints `eDID256Block.FnModelName` (Display.cs:235). The USB-hub path was the one taken: LOG has no `USB Hub Device …` rejection (GClass3.cs:100-126), and LOG:163 shows `CheckSupportUSBDDC … isSupport = True`. The DDC-only path would instead give `DisplayName` `"0-PHLC29F_PHL 34M2C8600"` (DC/Zeasn.DDC.Lib/Class1.cs:137; LOG:362) |
| `DeviceName` | `MONITORINFOEX.szDevice` = `\\.\DISPLAY1`. INFERRED: MonitorUtil.cs:1206-1210 and 1283 set it, and LOG:162 shows `Get display device for display \\.\DISPLAY1`. The renderer never reads it |
| `DeviceType`…`ExtModel` | From the `PCenter_DeviceInfo.json` record for 100000 (`FactoryType "1"`, `EquipmentType "1"`, `ExtModel ""`, `Vid/Pid 0`, `CreateDevice "0"`, `CheckFState "0"`, `ConnectMode "-1"`, `HasBattery false`, `ProfileCount 1`, `SupGameMode false`, `Extra ""`; `Evnia Precision Center/resources/bin/res/data/PCenter_DeviceInfo.json`). CONFIRMED. `ModelName` is then overwritten with `CurDisplay.MonitorName` (CDevice_PHLDisplay.cs:224/236) |
| `SupEffect` / `SupSync` | `true` / `true`. They come from the `%APPDATA%\evnia\MonitorInfo.json` entry that matches `^((PHL )\|(PHL_)\|(PHL))?34M2C8600$` (DC/…Entity.Lib/…/Data_DisplayInfo.cs). The user's file has `SupLightEffect:true, SupLightSync:true` (CONFIRMED). Without that file, the `PCenter_DeviceInfo.json` defaults are also `true` |
| Serialized field order | DictDeviceInfo declaration order, skipping the six `[JsonIgnore]` computed names (DictDeviceInfo.cs) |

### Step 4: `DisplayFW_GetDeviceList` (07:52:52.4081, invocationId 2; LOG:1011)

This call is not awaited by `saveDeviceList`.

Vendor, INFERRED:
- Built with `new JsonResult()`, so `err_msg:null` (PHLDisplayFW.cs:185-249).
- One scaler monitor with fields from LOG:151-159: `ModelName 34M2C8600`, `BomString 100GPRS2003NA1SXXY`, `Version V1.01`. `ConvertMonitorVersion("V1.01") = 101` (DC/Zeasn.Com.Lib/…/ComUtil.cs:77-89), and `DeviceType.Monitor = 1`.
- It assumes `EnumerateOtherOTADevices` adds nothing while the ENE is absent. That part is unverified.

```
R(vendor) = {"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":"1b8c40f7-f55f-44f7-abb8-57c86bc286c9","Tag":[{"ShowName":"34M2C8600","StrFwVersion":"V1.01","FwVersion":101,"ScalerModelName":"34M2C8600","ScalerBomInfo":"100GPRS2003NA1SXXY","UsbHubCount":0,"DeviceType":1,"AdmWarning":false}],"FunctionName":"DisplayFW_GetDeviceList","CurrItem":null}
R(port)   = {"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"1b8c40f7-f55f-44f7-abb8-57c86bc286c9","Tag":[],"FunctionName":"DisplayFW_GetDeviceList","CurrItem":null}
```

Between this request and step 5 the renderer spends about 1.7 s in `saveDeviceList`: the monitor's `modelName` `"PHL 34M2C8600"` is not in the bundled list `ry`, so `Pb()` makes the online image lookup (ST:44676-44690, 44718-44725). ELOG `Set main window size 1920x1080` at 07:52:54.100 marks the end of `S()`. With patch 02 P4 this gap disappears.

### Steps 5-10: `C()` interleaved with the Home mount (07:52:54.09-07:52:54.17, invocationIds 3-8; LOG:1012-1018)

| id | Request (verbatim `requestId`) | Reply `R` |
|---|---|---|
| 3 | `Theme_GetThemeInfos`, `e6efb073-8cf5-4399-ab31-7f09a738530d` | step 5 |
| 4 | `SyncEffect_GetData`, `4c8b0e31-fe1a-4706-b27a-bbb8b8e70da9` | step 6 |
| 5 | `Effect_GetColorData`, `9a28612b-c44a-4ae5-9a09-f5e07f38eeb5` | step 7 |
| 6 | `Theme_GetCurTheme`, `c2f07275-18af-4f8a-b4dc-24b60a8070a7` | step 8 |
| 7 | `Macro_GetFuncMenu`, `90e03aab-43d2-406f-a766-12126d985ce9` | step 9 |
| 8 | `Macro_GetList` `["User"]`, `985de1ec-19ce-4f11-b657-603396bb0226` | step 10 |

**Step 5: `Theme_GetThemeInfos`** (ThemeOper.cs:234-237; `ThemeInfo` order CONFIRMED byte-for-byte against `CFG/Theme/DataTheme.cfg`):
```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"e6efb073-8cf5-4399-ab31-7f09a738530d","Tag":[{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]}],"FunctionName":"Theme_GetThemeInfos","CurrItem":null}
```

**Step 6: `SyncEffect_GetData`** (SO:1518-1533; see §3.1):
```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"4c8b0e31-fe1a-4706-b27a-bbb8b8e70da9","Tag":{"EffectDetailInfo":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":2,"Brightness":2,"IsRandomColor":false,"IsRainbowColor":false,"CurRGB":{"R":255,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"SyncDevices":[]},"FunctionName":"SyncEffect_GetData","CurrItem":null}
```

**Step 7: `Effect_GetColorData`.** `Config\color.data` is absent, so `LoadTXTConfig` returns `null` and the code falls back to `DefData()` (SO:1351-1363; SerializedFileUtil.cs:151-158; EffectColorData.cs). `DefColors` is a public **field** and comes before the `SelfColors` property. `RGB` statics are skipped.
```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"9a28612b-c44a-4ae5-9a09-f5e07f38eeb5","Tag":{"DefColors":[{"R":255,"G":255,"B":255},{"R":255,"G":0,"B":0},{"R":255,"G":0,"B":127},{"R":127,"G":0,"B":127},{"R":127,"G":0,"B":255},{"R":0,"G":0,"B":255},{"R":0,"G":127,"B":255},{"R":0,"G":255,"B":255},{"R":0,"G":255,"B":127},{"R":0,"G":255,"B":0},{"R":127,"G":255,"B":0},{"R":255,"G":255,"B":0},{"R":255,"G":127,"B":0}],"SelfColors":""},"FunctionName":"Effect_GetColorData","CurrItem":null}
```

**Step 8: `Theme_GetCurTheme`** (SO:2994-2997, `themeInfo_0` = the User theme):
```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"c2f07275-18af-4f8a-b4dc-24b60a8070a7","Tag":{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]},"FunctionName":"Theme_GetCurTheme","CurrItem":null}
```

**Step 9: `Macro_GetFuncMenu`** (SO:2544-2552, 2554-2842; GlobalOper.cs:232-279).
- Size: `Tag` is **4025 characters** (.NET/JS string length) = 4161 UTF-8 bytes. The whole reply is 4175 characters / 4311 bytes. Produced by a script that emulates the code path over `DO/…/ButtonFunc.cs`, `ButtonMenu.cs`, `ButtonSubMenu_AppUser.cs` and `ButtonExtFunc.cs`.
- Item order: `ButtonMenu` values sorted give LaunchProgram (9) → one item per function; Media (10) → one item holding 7 children; AppUser (12) → one item per `ButtonSubMenu_AppUser`: Productivity (4), Windows (17), Editing (11), Navigation (7).
- Items are `ButtonMenuItem`s, with `ChildList` before `Name/Text/Value`. Children are `ExtEnumItem`s, with `ExtData` first.
- `ExtFuncDef` = `GetDatas(ButtonExtFunc)`.
```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"90e03aab-43d2-406f-a766-12126d985ce9","Tag":{"Items":[{"ChildList":[{"ExtData":"","Name":"LaunchExe","Text":"启动exe程序","Value":864}],"Name":"LaunchExe","Text":"启动exe程序","Value":864},{"ChildList":[{"ExtData":"","Name":"LaunchWebsite","Text":"启动网页","Value":865}],"Name":"LaunchWebsite","Text":"启动网页","Value":865},{"ChildList":[{"ExtData":"","Name":"Media_Mute","Text":"静音","Value":880},{"ExtData":"","Name":"Media_VolumeDown","Text":"音量减少","Value":881},{"ExtData":"","Name":"Media_VolumeUp","Text":"音量增大","Value":882},{"ExtData":"","Name":"Media_PreviousTrack","Text":"上一曲","Value":883},{"ExtData":"","Name":"Media_NextTrack","Text":"下一曲","Value":884},{"ExtData":"","Name":"Media_PlayOrPause","Text":"播放/暂停","Value":885},{"ExtData":"","Name":"Media_Stop","Text":"停止","Value":886}],"Name":"Media","Text":"多媒体","Value":10},{"ChildList":[{"ExtData":"","Name":"User_LaunchCalc","Text":"LaunchCalc","Value":928},{"ExtData":"","Name":"User_LaunchMspaint","Text":"LaunchMspaint","Value":929},{"ExtData":"","Name":"User_LaunchNotepad","Text":"LaunchNotepad","Value":930},{"ExtData":"","Name":"User_LaunchSnippingtool","Text":"LaunchSnippingtool","Value":931}],"Name":"Productivity","Text":"Productivity","Value":0},{"ChildList":[{"ExtData":"","Name":"User_ShowDesktop","Text":"ShowDesktop","Value":944},{"ExtData":"","Name":"User_LockScreen","Text":"LockScreen","Value":945},{"ExtData":"","Name":"User_OpenGameBar","Text":"OpenGameBar","Value":946},{"ExtData":"","Name":"User_OpenSearch","Text":"OpenSearch","Value":947},{"ExtData":"","Name":"User_OpenNarrator","Text":"OpenNarrator","Value":948},{"ExtData":"","Name":"User_OpenActionCenter","Text":"OpenActionCenter","Value":949},{"ExtData":"","Name":"User_FocusNotifyArea","Text":"FocusNotifyArea","Value":950},{"ExtData":"","Name":"User_OpenExplorer","Text":"OpenExplorer","Value":951},{"ExtData":"","Name":"User_OpenSetting","Text":"OpenSetting","Value":952},{"ExtData":"","Name":"User_OpenConnect","Text":"OpenConnect","Value":953},{"ExtData":"","Name":"User_MiniAllWins","Text":"MiniAllWins","Value":954},{"ExtData":"","Name":"User_RunDialog","Text":"RunDialog","Value":955},{"ExtData":"","Name":"User_CycleTaskBarApps","Text":"CycleTaskApps","Value":956},{"ExtData":"","Name":"User_OpenEaseOfAccess","Text":"OpenEaseOfAccess","Value":957},{"ExtData":"","Name":"User_OpenTaskView","Text":"OpenTaskView","Value":958},{"ExtData":"","Name":"User_OpenMagnifier","Text":"OpenMagnifier","Value":959},{"ExtData":"","Name":"User_OpenEmojiPanel","Text":"OpenEmojiPanel","Value":960}],"Name":"Windows","Text":"Windows","Value":1},{"ChildList":[{"ExtData":"","Name":"User_Copy","Text":"Copy","Value":976},{"ExtData":"","Name":"User_Paste","Text":"Paste","Value":977},{"ExtData":"","Name":"User_Cut","Text":"Cut","Value":978},{"ExtData":"","Name":"User_Redo","Text":"Redo","Value":979},{"ExtData":"","Name":"User_Undo","Text":"Undo","Value":980},{"ExtData":"","Name":"User_SelectAll","Text":"SelectAll","Value":981},{"ExtData":"","Name":"User_Save","Text":"Save","Value":982},{"ExtData":"","Name":"User_New","Text":"New","Value":983},{"ExtData":"","Name":"User_Open","Text":"Open","Value":984},{"ExtData":"","Name":"User_NewTab","Text":"NewTab","Value":985},{"ExtData":"","Name":"User_CloseTab","Text":"CloseTab","Value":986}],"Name":"Editing","Text":"Editing","Value":2},{"ChildList":[{"ExtData":"","Name":"User_GoBack","Text":"GoBack","Value":992},{"ExtData":"","Name":"User_GoForward","Text":"GoForward","Value":993},{"ExtData":"","Name":"User_OpenStart","Text":"OpenStart","Value":994},{"ExtData":"","Name":"User_OpenTaskManager","Text":"OpenTaskManager","Value":995},{"ExtData":"","Name":"User_ExitActiveApp","Text":"ExitActiveApp","Value":996},{"ExtData":"","Name":"User_SwitchBetweenApps","Text":"SwitchBetweenApps","Value":997},{"ExtData":"","Name":"User_CycleThroughApps","Text":"CycleThroughApps","Value":998}],"Name":"Navigation","Text":"Navigation","Value":3}],"ExtFuncDef":[{"Name":"ApplyToThemeCycleProfiles","Text":"将功能应用到当前主题下所有循环Profile中","Value":0},{"Name":"ApplyToThemeCycleOnBoards","Text":"将功能应用到所有板载中","Value":1}]},"FunctionName":"Macro_GetFuncMenu","CurrItem":null}
```

**Step 10: `Macro_GetList(["User"])`.** `Theme\User` exists and `Theme\User\Macro` does not, so the result is `[]` (SO:1972-2003):
```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"985de1ec-19ce-4f11-b657-603396bb0226","Tag":[],"FunctionName":"Macro_GetList","CurrItem":null}
```

### Step 11: `PHL_SwitchDisplay(["AU00000000001"])` (07:53:01.8247, id 9; LOG:1019-1020)

LOG:1020 `SwitchDisplay sn is sn = AU00000000001` shows the "already current" branch, so the reply is `JsonResult.Succ(base.DeviceData)` (DC/Zeasn.Equipment.Base.Lib/…/GClass3.cs:258-274).

It is serialized with plain `JsonSerialize()`, not IgnoreUI. The display model has no `[JsonIgnoreEx(IgnoreUI)]` member: the only `JsonIgnoreEx` in the monitor classes is `HasUSBSetting` (IgnoreProfile, T_PHLDisplay_Profile.cs:65), and 12 §2.1 lists the three IgnoreUI members, all on keyboards. So **the Tag bytes are identical to step 12's**. CONFIRMED by code. The renderer ignores the Tag (ST:8886-8893).

```
R = {"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"23e6864d-0493-4b6a-a9fb-1e691a96ea0d","Tag":<same object as step 12>,"FunctionName":"PHL_SwitchDisplay","CurrItem":null}
```

### Step 12: `Profile_GetDeviceData([100000])` (07:53:01.8365, id 10; LOG:1021)

The full body (every `AttributeInfo` with its `ValueList`) is in the sibling report **`docs/re/20-enum-valuelist-catalog.md`**. The values on disk are in 12 §3.1. Top-level skeleton, in the real single-line form. Line breaks are added only here; `…` marks elided sub-objects.

```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"b09910ba-8ed2-4ce9-b184-dc5f5ea0495b","Tag":{
"IsSmartImageHDR":true,
"HasUSBSetting":true,
"OP_DC_DisplayApplication":{"VCPOpCode":220,"VCPOpCodeName":"OP_DC_DisplayApplication","Value":33,"MinValue":0,"MaxValue":53,"StepValue":1,"ValueList":[…],"err_code":0},
"ModuleSmartImage":{"Items":[],"CurSubSmartImage":{…13 AttributeInfo…},"SubSmartImages":{}},
"ModuleSmartImageHDR":{"Items":[…HDROff 32,HDRGame 33,HDRMovie 34,HDRPhoto 35,HDRPersonal 36,HDRTrueBlack 48,HDRPeak 51…],"CurSubSmartImage":{…5…},"SubSmartImages":{"33":{…}}},
"ModuleGameMode":{…19 AttributeInfo…},
"ModuleAmbiglow":{…6 AttributeInfo…,"EffectEnable":false},
"ModuleInput":{…5 AttributeInfo…,"InputSourceList":[…4…],"PIPPBPSourceList":[…4…],"InputSourceInfo":{"Mode":0,"Size":0,"Location":0,"PIPPBPSource":34,"InputSource":15},"PIPLocationList":[…4…]},
"ModuleAudio":{…4 AttributeInfo…,"EQItems":[…5…]},
"ModuleSystem":{…},
"ModuleSetup":{…},
"ENEEffectEnable":false,
"EffectInfo":{"EffectList":[…7…],"EffectDetail":{…FollowVideo…},"EffectEnable":true,"CurrEffect":{"Name":"FollowVideo","Text":"光影同步","Value":1}},
"DispalyData":{"MonitorEDIDInfo_T":{"sManufacturer":"PHL","sManufacturerDate":"Week01-2025","PlugAndPlayID":"PHLC29F","sMonitorName":"PHL 34M2C8600","sSerialNumber":"AU00000000001","sVersion":"1.4","ScreenSize":"~34,2\"","TimingRecommandation":"3440x1440","DisplayGamma":"2,2","DisplayTypeAndSignal":"DIGITAL","RedChromaticity":"Rx0,689-Ry0,303","GreenChromaticity":"Gx0,241-Gy0,715","BlueChromaticity":"Bx0,145-By0,059","WhitePoint":"Wx0,313-Wy0,329"},"MonitorResolution":"3440x1440","MonitorFrequency":"175Hz","MonitorOrientation":"0°"},
"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":null},
"FunctionName":"Profile_GetDeviceData","CurrItem":null}
```

Sources:
- Key order: T_PHLDisplay_Profile.cs:51-234, then the base `T_DeviceProfile_Base`.
- `DC` max `0x35`: LOG:913.
- `HasUSBSetting`: E2A012 is available.
- `EffectInfo` is the **stored** FollowVideo object, copied in by `method_12` while ENE is absent (CDevice_PHLDisplay.cs:693-695) and matching `Default.pcenter`. The UI ignores it because `ENEEffectEnable:false`.
- `ExtModel:null`: `CacheDeviceData` never sets it (INFERRED).
- The E2A019 `Value` is 7 even though the monitor reads 0: the load rewrites Off to StaticMode (CDevice_PHLDisplay.cs:382-389).

### Step 13: `PHL_GetConstraints` + notification (07:53:01.8657, id 11; LOG:1022-1023)

`GetConstraints()` calls `Notify()` **before** returning (CDevice_PHLDisplay.cs:2021-2025). So on the wire the Notification comes first, then the reply, then the Completion.

```
S→C  {"type":1,"target":"Notification","arguments":[N1]}␞      N1 is byte-identical to N0 (step 2)
S→C  {"type":1,"target":"GetTaskAsync","arguments":[R]}␞
S→C  {"type":3,"invocationId":"11","result":null}␞
R = {"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"cceb3c05-0411-4c8f-b031-eec161ed786e","Tag":{"FuncItems":[{"FuncId":16,"FuncName":"OP_10_Luminance","State":1},{"FuncId":18,"FuncName":"OP_12_Contrast","State":1},{"FuncId":240,"FuncName":"OP_F0_SmartContrast","State":2},{"FuncId":14852128,"FuncName":"EXT_OP_E2A0_20_ColorSpace","State":1},{"FuncId":20,"FuncName":"OP_14_SelectColorPreset","State":1},{"FuncId":14852132,"FuncName":"EXT_OP_E2A0_24_DLBL","State":2},{"FuncId":14852160,"FuncName":"EXT_OP_E2A0_40_AdaptiveSync","State":1},{"FuncId":14852098,"FuncName":"EXT_OP_E2A0_02_MBR","State":2},{"FuncId":14852099,"FuncName":"EXT_OP_E2A0_03_MBRSync","State":1},{"FuncId":14852100,"FuncName":"EXT_OP_E2A0_04_SmartCrosshair","State":1},{"FuncId":14852164,"FuncName":"EXT_OP_E2A0_44_StarkShadowBoost","State":2},{"FuncId":14852165,"FuncName":"EXT_OP_E2A0_45_ShadowBoost","State":2},{"FuncId":14852102,"FuncName":"EXT_OP_E2A0_06_SharpShooter_Size","State":2},{"FuncId":14852103,"FuncName":"EXT_OP_E2A0_07_LowInputLag","State":1},{"FuncId":235,"FuncName":"OP_EB_SmartResponse","State":1},{"FuncId":14852172,"FuncName":"EXT_OP_E2A0_4C_Overclock","State":1},{"FuncId":14852104,"FuncName":"EXT_OP_E2A0_08_SmartFrame","State":2},{"FuncId":14852122,"FuncName":"EXT_OP_E2A0_1A_AmbiglowColors","State":1},{"FuncId":14852123,"FuncName":"EXT_OP_E2A0_1B_AmbiglowLightPosition","State":1},{"FuncId":14852124,"FuncName":"EXT_OP_E2A0_1C_AmbiglowLightBrightness","State":1},{"FuncId":14852125,"FuncName":"EXT_OP_E2A0_1D_AmbiglowLightSpeed","State":2},{"FuncId":14852126,"FuncName":"EXT_OP_E2A0_1E_AmbiglowLightDirection","State":1},{"FuncId":224,"FuncName":"OP_E0_AudioSource","State":2},{"FuncId":134,"FuncName":"OP_86_DisplayScaling","State":1},{"FuncId":84,"FuncName":"OP_54_PerformancePreservation","State":1},{"FuncId":218,"FuncName":"OP_DA_ScanMode","State":1}],"ModuleGameMode":1,"AudioEQ":1},"FunctionName":"PHL_GetConstraints","CurrItem":null}
```

The renderer throws the reply's Tag away (`getDisplayConstraints()` has no `.then`, Monitor-D4qz4RBn.js:84; ST:8331-8333). **Only N1 feeds `optionControl`** (MN:1834-1841 → ST:9581-9587). This is the one notification the port must send.

### Step 14: `Setting_GlobalData` (07:53:18.3257, id 12; LOG:1024)

`GlobalOper.ConfigData` is a `SoftConfigInfo` with two properties (Bridge.cs:23-26; SoftConfigInfo.cs; CFG/Config/SoftConfig.data). The renderer's extra keys `EnableAllowControlLights`/`TurnOffLightsWhenDisplayTurnOff` stay `null` in its store (ST:44575-44580, 44761-44765).

```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"4acabfda-1fb3-4219-b6dc-3b239819fcb9","Tag":{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5},"FunctionName":"Setting_GlobalData","CurrItem":null}
```

### Step 15: `GetPairDevices` (07:53:18.3257, id 13; LOG:1025)

```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"a475cf3f-a975-48fd-8adc-26ae004d4ae3","Tag":[],"FunctionName":"GetPairDevices","CurrItem":null}
```

### Step 16: `Device_OtherDeviceChange` (07:54:01.1667, id 14; ELOG `otherDeviceChange send` at 07:54:01.160; LOG:1026-1078)

The "Other" scan re-checks BLE types only; the display is untouched (SO:162-175, 248-252). The reply is the same device list. Afterwards `saveDeviceList` issues `DisplayFW_GetDeviceList` again (LOG:1079, id 15), and `refreshDeviceData` is emitted. The user was on the Setting page, so the Monitor shell was not mounted. At 07:54:14 the monitor page mounts again and calls `Profile_GetDeviceData` + `PHL_GetConstraints` (LOG:1080-1082, ids 16-17; N2 = N0).

```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"fa2ed15a-34f9-447e-938f-be804350429c","Tag":[{"StrFwVersion":null,"FwVersion":0,"ExtDeviceInfo":{"CurSN":"AU00000000001","DisplayList":[{"DisplayName":"PHL 34M2C8600","MonitorName":"PHL 34M2C8600","DeviceName":"\\\\.\\DISPLAY1","DisplaySN":"AU00000000001"}]},"DeviceType":100000,"FactoryType":1,"EquipmentType":1,"ModelName":"PHL 34M2C8600","ExtModel":"","HasBattery":false,"Vid":0,"Pid":0,"IUSB_USAGE_PAGE":0,"IUSB_USAGE":0,"CreateDevice":0,"CheckFState":0,"SupEffect":true,"SupSync":true,"ProfileCount":1,"SupGameMode":false,"Extra":"","ConnectMode":-1}],"FunctionName":"Device_OtherDeviceChange","CurrItem":null}
```

### Step 17: `Device_DetectionDisplay` (not in the 09-26 log; synthetic `requestId`)

The vendor sleeps 5000 ms (SO:241-246), then runs the display-only scan: DDC init, cached capabilities, full VCP read, `ParameterToDevice`. It then returns the same list. The constraints are unchanged, so **no** notification is sent. The renderer follows with `saveDeviceList`, then `DisplayFW_GetDeviceList`, then `refreshDeviceData` → `Profile_GetDeviceData` (MN:1745-1762).

```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"00000000-0000-4000-8000-000000000017","Tag":[{"StrFwVersion":null,"FwVersion":0,"ExtDeviceInfo":{"CurSN":"AU00000000001","DisplayList":[{"DisplayName":"PHL 34M2C8600","MonitorName":"PHL 34M2C8600","DeviceName":"\\\\.\\DISPLAY1","DisplaySN":"AU00000000001"}]},"DeviceType":100000,"FactoryType":1,"EquipmentType":1,"ModelName":"PHL 34M2C8600","ExtModel":"","HasBattery":false,"Vid":0,"Pid":0,"IUSB_USAGE_PAGE":0,"IUSB_USAGE":0,"CreateDevice":0,"CheckFState":0,"SupEffect":true,"SupSync":true,"ProfileCount":1,"SupGameMode":false,"Extra":"","ConnectMode":-1}],"FunctionName":"Device_DetectionDisplay","CurrItem":null}
```

### Step 18: `Theme_GetDevicesBasicInfo(-1)` (AboutDevice; not in the 09-26 log; synthetic `requestId`)

`(int)` overload → `smethod_22(GetThemeProfile("User","Default") read from disk, -1, false)` (SO:3363-3439; ThemeOper.cs:503-534) → `PHLDisplay_Oper.AnalyseBasicInfo` (PHL/PHLDisplay_Oper.cs:14-108, 148-181). Values from `Default.pcenter` and `MonitorInfo.json`:

| Field | Value | Why |
|---|---|---|
| `LightSync` | `Off` | `SupLightSync` is true; the display is not in `SyncDevices`, which is empty |
| `LightMode` | `StaticMode` | ENE off, E2A019 = 7, the `GetDatas` name |
| `SmartImage` | `/` | HDR, so `ModuleSmartImage.Items` is empty |
| `Input` | `Normal_DisplayPort1` | `InputSource` 15 |
| `AdaptiveSync` | `On` | E2A040 = 1 |
| `Connect` | `true` | a `UIDisplayInfo.MonitorName` equals `ModelName` |

```
{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"00000000-0000-4000-8000-000000000018","Tag":{"SyncEquipment":"","Display":[{"LightSync":"Off","LightMode":"StaticMode","Resolution":"3440x1440","RefreshRate":"175Hz","SmartImage":"/","Input":"Normal_DisplayPort1","AdaptiveSync":"On","Connect":true,"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":null}],"Keyboard":[],"Mouse":[],"MousePad":[],"Headset":[]},"FunctionName":"Theme_GetDevicesBasicInfo","CurrItem":null}
```

Order: `DataBasicInfo` is `SyncEquipment, Display, Keyboard, Mouse, MousePad, Headset` (DataBasicInfo.cs). `BasicInfo_Display` fields come first, then `BasicInfoBase.Connect`, then the `T_DeviceProfile_Base` fields (12 §3.8).

---

## 6. (e) When the UI shows the monitor as connected and selectable

All CONFIRMED from the renderer unless marked otherwise.

1. **`Device_GetConnectList` must resolve.** `S()` does `const o = await s.system.getDeviceList(); await d.saveDeviceList(o)` with no `.catch` (MN:197-198). A rejection leaves the Startup screen up forever: `isBackendInit` is never set (MN:199-200).
   - `Start`'s rejection *is* tolerated (MN:190-192).
   - A **missing** `Start` reply hangs startup, because there is no timeout (02 §4.6).
2. **`saveDeviceList` must not throw** (ST:44635-44727). Its executor runs `Tb()` synchronously, and a throw rejects the promise, which gives the same stuck startup:
   - `e.FwVersion.toString()` (ST:44429) needs `FwVersion` to be a number or string, not `null`/missing.
   - The monitor branch needs `EquipmentType === 1`. It sets `n = ExtDeviceInfo?.CurSN || ""` and pushes one card **per `DisplayList[]` entry** as `Tb({...e, AliasName: DisplaySN, ModelName: MonitorName})` (ST:44664-44672). An empty or missing `DisplayList` produces **no monitor card**, even though the device is in the list.
   - Unknown `EquipmentType` values are ignored (`?.push`).
3. **Active device.** For the Monitor group, `activeDevice = connectedDevices.find(t => t.aliasName === CurSN)` (ST:44707-44713). `CurSN` must therefore equal one `DisplaySN`. Otherwise:
   - `activeDevice` is `null`.
   - The Monitor shell's loader `U()` returns early on `!getActivedDevice(Monitor)?.deviceType` (Monitor-D4qz4RBn.js:41-49), so every later `refreshDeviceData` (after a display or USB change) leaves the page stale.
   - The first click still works, because the Overview click sets the active device explicitly.
4. **Selectable.**
   - Overview click → `PHL_SwitchDisplay(aliasName)` must succeed (`err_code 0` and no `err_msg`). An error gives the "MonitorNoSupport" toast. Success then runs `setActiveDevice(Monitor, aliasName+modelName)` and routes to `/monitor` (ST:8883-8893). DeviceNav does the same (DeviceLayout-pwnPovdh.js:127-135).
   - The Monitor shell then calls `Profile_GetDeviceData(activeDevice.deviceType)`, so `DeviceType` must be `100000`. If `ENEEffectEnable` is true it also calls `Effect_GetMenu` (Monitor-D4qz4RBn.js:42-49).
   - The page stays only while `getConnectedList(Monitor).length > 0`; otherwise it redirects to Overview (:50-58).
5. **`isDeviceConnected(1, dt, modelName)`** matches monitors by `modelName` only (ST:44615-44621). AboutDevice filters `DataBasicInfo.Display[]` with it (ST:33549-33558), so `BasicInfo_Display.ModelName` must equal `DisplayList[].MonitorName` (`"PHL 34M2C8600"`). Every `DataBasicInfo` key except `SyncEquipment` must be an **array**, because the code calls `.filter` on it.
6. **Images and online.**
   - The card `modelName` is the raw `MonitorName`. `saveDeviceList` checks it against `ry` without stripping, so `"PHL 34M2C8600"` triggers `Pb()`, the online lookup (ST:44676-44690, `Pb` call 44718-44725). This settles 02 open question 1: CONFIRMED by LOG:365 plus the 1.7 s gap before LOG:1012. The fix is 02 P4.
   - `DeviceImage` strips the `PHL` prefix and takes the last token, `34M2C8600` ∈ `ry`, so the bundled image is shown (ST:33307-33360).
7. **Empty peripheral data must be empty collections, not null:**
   - `Device_GetConnectList` holds only the monitor object; no peripheral placeholders are needed.
   - `GetPairDevices` → `[]`.
   - `SyncEffect_GetData.SyncDevices` → `[]`.
   - `Macro_GetList` → `[]`.
   - `Theme_GetDevicesBasicInfo` → `"Keyboard":[],"Mouse":[],"MousePad":[],"Headset":[]`.
   - `Effect_GetColorData` → `DefColors` array plus a `SelfColors` **string** (`.split(",")`, ST:44797-44808).
   - The Keyboard, Mouse, Pad and Headset groups then have `connectedDevices = []` and `activeDevice = null`. `hasMonitor` is true, `isAllUnconnected` is false (dashboard button visible), and the Bulb group is shown only when `bulbEnabled`.

---

## 7. (f) Minimal Linux backend (05 §12)

### 7.1 Function set

| Tier | Functions | Notes |
|---|---|---|
| **Must implement, startup path** | `Start`, `Device_GetConnectList`, `Theme_GetThemeInfos`, `Theme_GetCurTheme`, `Macro_GetList`, `Macro_GetFuncMenu` (static), `SyncEffect_GetData`, `Effect_GetColorData`, `DisplayFW_GetDeviceList` (stub `[]`) | A missing reply on any of the first two blocks startup, and the other startup calls leave stores empty |
| **Must implement, monitor pages** | `PHL_SwitchDisplay`, `Profile_GetDeviceData`, `PHL_GetConstraints` (+ notification), `PHL_ReloadData`, `PHL_SetOSD(s,i)`, `PHL_SetSmartImage`, `PHL_ResetSmartImage`, `PHL_SetColorPreset`, `PHL_SwitchSmartFrame`, `PHL_SetSmartFrameSize`, `PHL_SetInputSource`, `PHL_SwrapPIPPBP`, `PHL_SetAudioEQ`, `Profile_Reset`, `Effect_Enable`, `Effect_Reset`, `Effect_SetSelfColors`, `Effect_CheckDynamicLightingEnabled` (stub -1), `Effect_OpenDynamicLightingSetting` (stub) | Device semantics: 03 §5, 06, 12 §3.4 |
| **Must implement, device events** | `Device_DetectionDisplay`, `Device_DetectionUSB`, `Device_OtherDeviceChange`, `Device_Rescan` | All return the device list. Electron main raises `displayChange`, `USBChange` and `otherDeviceChange` (01) |
| **Shell pages that are kept** | `Setting_GlobalData`, `Setting_TurnOffLightsWhenIdle`, `Setting_TurnOffLightsWhenIdleDuration`, `FactoryReset`, `GetPairDevices` (stub `[]`), `Theme_GetDevicesBasicInfo` ×3, `Theme_Switch`, `Theme_SwitchApp`, `Theme_Add/Del/Rename/UpdateBindApp`, `Theme_AddProfile/CopyProfile/RenameProfile/DelProfile/ImportProfile/ExportProfile/HandleCycleProfile/ResetCurProfile`, `Theme_GetProfileDesc` ×2, `Comm_GenAppIcon` (stub `""`) | File formats: §4 and 12 §2.1 |
| **Everything else** | the E/S rows in §3 | The vendor's no-device texts keep the replies byte-compatible |

Notifications: send `NotifyUIDisplayFuncConstraintsChange` (required); the rest per §2.5.

### 7.2 The 21 s `Start` (CONFIRMED timeline, LOG:8-1005, ELOG)

| Time | Event |
|---|---|
| 07:52:28.721 | Electron spawns EvniaServe (ELOG) |
| 07:52:30.4974 | Hub connected (LOG:6) |
| 07:52:30.9457 | `Start` received |
| 07:52:31.1124 | Scan starts: all 26 types in parallel, then `Task.WaitAll` (SO:189-202) |
| 07:52:31.47 → 33.29 | Display phase 1→2: USB monitor enumeration and OTA hub probes (VIA-RTK scaler banner LOG:151-159) |
| 07:52:33.29 → 33.85 | Phase 2→3: Windows DDC helper init, EDID and SN |
| 07:52:34.06 → 40.99 | Capabilities string read, **6.74 s**. Cache miss: LOG:367 `LoadTXTConfig: file not found - …\config\data.json` |
| 07:52:41.01 → 52.13 | Full VCP read `CacheDeviceDataLoad`, **11 097 ms** (LOG:994). About 60 reads at roughly 187 ms each over the USB hub |
| 07:52:52.17-52.19 | `ParameterToDevice` (3 ms), constraints notification N0, phase 5. `ConnectionCheckedTime PHL_CDeviceDisplay` = 21 069 ms |
| 07:52:52.24 / 52.39 | `Effect_Sync` 44 ms, `CheckSoftEffect` 154 ms, then `bool_0 = true` and the reply |

About **21.45 s** from request to reply. With a warm `data.json` the capability read is skipped (INFERRED: about 14.7 s).

What the renderer does during this time:
- The Startup view shows "LoadingWithDot" and waits with **no timeout** (MN:186-192, 226-270).
- SignalR stays alive only because server pings are timer-driven. **A Node.js backend must not block its event loop** with synchronous i2c `ioctl`s for longer than about 15 s. Run DDC I/O in a worker thread or with async I/O, or the client's 30 s server timeout fires and triggers the reconnect loop (ST:6430; 02 §4.7).
- ASP.NET processes one invocation per connection at a time (INFERRED), so the vendor could not have answered anything else meanwhile. The renderer sends nothing else until `Start` resolves.

Recommendation (INFERRED as safe from the renderer code above):
1. Answer `Start` (`Tag true`) once:
   - `DataTheme.cfg` and the current profile are loaded;
   - the monitor is enumerated: EDID with model and SN, and a DDC reachability probe;
   - the capability string is available from the `data.json` cache or a fresh read.

   `Device_GetConnectList` needs only EDID/SN data.
2. Run the full VCP read and the profile push (`ParameterToDevice`) in the background.
   - `Profile_GetDeviceData`, `PHL_SwitchDisplay`, `PHL_ReloadData` and every `PHL_Set*` must `await` that read.
   - The user only reaches them by clicking the monitor card. The overview click shows the loading overlay until `PHL_SwitchDisplay` resolves (ST:8883-8893), so the wait is covered.
3. Keep `Start` idempotent. The vendor returns `Succ(true)` at once when a scan has already completed (SO:110-121), and reconnects call `Start` again (MN:211-221). Also guard against a second `Start` arriving **while** a scan runs. The vendor would start a second concurrent scan, because `bool_0` is still false.
4. Always reply, with `RequestId`/`FunctionName` echoed, on every path including parse errors (§1.3).
5. Either serialize invocations per connection like ASP.NET 3.1, or rely on `RequestId` correlation (ST:7975-7995). Both work, because the renderer never has two same-name requests in flight except the two concurrent-allowed functions.

---

## 8. Corrections to earlier reports

1. **02 §6, `NotifyUISwitchTheme`**: "no emitter anywhere in DC" is wrong. It is emitted as `const_2` at SO:3219-3227 (`SwitchProfileNotification`, driven by `EVT_Profile.*` from peripheral profile buttons) and at SO:3329-3342 (`CheckTopApp`). 05 §2.6 already describes the `CheckTopApp` path, so 02 contradicts it. Not dead in 1.13.0; dead only for this user (no bound apps, no peripherals). The same applies to 02 open question 3.
2. **02 §6, `NotifyMouseDPIChange`**: "no" emitter is wrong. There are 7 emitters as `const_7` (§2.4 #7), plus the `ThemeSwitchApp` handler in RongYuanMouse_Oper.cs:494-513.
3. **02 §6, `NotifyParamMouseChange` (8) and `NotifyBatteryChange` (15)**: listed as emitted ("yes"). **No emitter exists** in DC; confirmed by grep of every `Notification_Func.` use.
4. **02 §4.2 and §L.4, Completion frame**: shown as `{"type":3,"invocationId":"0"}`. For a `Task` hub method with an invocation id, ASP.NET Core 3.1 writes `{"type":3,"invocationId":"0","result":null}` (INFERRED; §1.4). This matters only for byte-level captures. Add to L.4: never put `error` in a Completion.
5. **02 §4.5 and 12 §2.3, sample envelope**: 02 shows replies with `"err_msg":null`. Replies built with `JsonResult.Succ` carry `"err_msg":""`. `null` appears only on notifications and on the few `new JsonResult{…}` replies listed in §1.3.
6. **02 §5.1, `Setting_GlobalData` shape**: the backend returns only `{TurnOffLightsWhenIdle, TurnOffLightsWhenIdleDuration}` (`SoftConfigInfo`; CFG/Config/SoftConfig.data). `EnableAllowControlLights` and `TurnOffLightsWhenDisplayTurnOff` exist only as renderer-store defaults (ST:44575-44580).
7. **05 §3.3 item 1**: "Any exception becomes `JsonResult.Exception(ex)` (err 9, `err_msg = ex.ToString()`)" is misleading. That is only the practically unreachable outer catch, and it replies with `RequestId:null`. Exceptions from Bridge methods come back from `method_1`'s catch with `err_msg = "Exception has been thrown by the target of an invocation."` and the ids echoed (§1.3).
8. **12 §3.5, `0xDA ScanMode` rule inverted**: the code sets DA to **2 (disabled) when** the `OP_86` item is enabled ∧ `OP_86` is available ∧ `OP_86 == 1` (NoScaling), and to 1 otherwise (DisplayFuncConstraints.cs:281-288). 12 says "2 unless (…)". For the user `OP_86 = 2`, so DA is 1 (§2.6).
9. **12 §2.2 item 9, string escaping**: Newtonsoft's default `StringEscapeHandling` also escapes U+0085, U+2028 and U+2029 (as `\u0085`, `\u2028`, `\u2029`), which `JSON.stringify` does not (INFERRED from Newtonsoft `JavaScriptUtils`). It does not matter for any value in this corpus.
10. **02 open question 1 is resolved**: `DisplayList[].MonitorName` = `"PHL 34M2C8600"` is CONFIRMED (LOG:365 via Display.cs:184-185/235). `saveDeviceList` therefore does run the online image lookup on every refresh.
11. **02 §6, `NotifyEffectSyncDevicesChange`**: the display's `Effect_Reset` path sends the **raw** `CurThemeProfile?.Sync_Profile` (CDevice_PHLDisplay.cs:1160), which can be `null` or have `EffectDetailInfo:null`. `SystemOper.EffectSyncDataChange` sends the normalized one.

---

## 9. Open questions

1. **Vendor `DisplayFW_GetDeviceList` extra entries.** Does `EnumerateOtherOTADevices` add the VIA hub or a PD controller for this monitor? It matters only for the "vendor" line in step 4; the port returns `[]`. Checking would need one captured reply.
2. **`DeviceName` value.** `\\.\DISPLAY1` is INFERRED from the MonitorUtil mapping plus LOG:162. The renderer does not read it; on Linux use any stable identifier, e.g. the DRM connector name.
3. Framework-level INFERRED items that no log can confirm:
   - the Completion `"result":null`;
   - the System.Text.Json outer escaping;
   - serial per-connection dispatch;
   - Newtonsoft's `ValueTuple` → `Item1..3`.

   The renderer does not depend on any of them.
4. **Full `Profile_GetDeviceData` body.** It depends on the `ValueList` construction in `docs/re/20-enum-valuelist-catalog.md` (a sibling report). Only the skeleton is given here.
