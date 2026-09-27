# Evnia Precision Center 1.13.0: EvniaServe host, Bridge API, framework and persistence (RE spec)

## Summary

`EvniaServe.exe` is a .NET Core 3.1 x86 ASP.NET Core application that acts as the device backend for the Electron UI. It listens on `http://*:10010/` (all interfaces), exposes one SignalR hub (`/EvniaHub`) and four REST controllers, and forwards every request to one of **162 public static methods** of `Bridge.Lib.Bridge` using a reflection dispatcher. `Bridge` is a thin facade: 157 of the methods call `Zeasn.Framework.Core.Lib.SystemOper` one-to-one. The other five call `GlobalOper` or pass through with light argument conversion. `SystemOper` then routes by `DeviceType` to per-device driver objects in `Zeasn.Equipment.Option.Lib`. For the display (`DeviceType 100000`) that object is `PHLDisplay_Oper`/`CDevice_PHLDisplay`. It also routes to singletons such as `ThemeOper`, `GlobalOper`, `PHLDisplayFW`, `AmbiScapeOper` and `FancyZonesOper`.

Every result is a `Zeasn.Com.Lib.JsonResult` (`err_code`, `IsSucc`, `err_msg`, `RequestId`, `Tag`, `FunctionName`, `CurrItem`), serialized with Newtonsoft.Json 13 and **broadcast to all hub clients** as a `"GetTaskAsync"` event. Asynchronous device events travel over an in-process `EventSystem` bus and reach the UI as `"Notification"` events that carry a `JsonResult` with `RequestId=null`. There are 23 notification names; two appear as `const_2`/`const_7` in `dotnet-clean` and their real names are `NotifyUISwitchTheme`/`NotifyMouseDPIChange`.

All persistence lives under `%APPDATA%\EvniaServe\` (`Config\`, `Theme\`, `logs\`). Each file is single-line UTF-8 JSON with a BOM, with **no encryption and no compression**. The one exception is `Config\data.json`, the VCP-capability cache: it wraps its JSON in `{"data","sign"}` with an HMAC-SHA256 signature under the hard-coded key `WhaleTV_Serizlize_2026`. I verified this against the user's real file. Themes and profiles are stored as `Theme\DataTheme.cfg` plus `Theme\<Theme>\<Profile>.pcenter`, where each device's settings are a JSON string nested inside the profile. Macros are stored as `Theme\<Theme>\Macro\<name>.macro`.

The backend itself makes **no outbound Internet requests**. The only HTTP client code (`HttpUtil`, `UrlExists`) is dead. It does consume two things the Electron side downloads: `%APPDATA%\evnia\MonitorInfo.json` and firmware files. It also has local-network and privacy-sensitive features:
- **Wi-Fi list with plaintext saved passwords** (via `netsh … key=clear`), used for Matter smart-bulb commissioning.
- An **unauthenticated LAN-reachable RPC** with Swagger, a developer exception page, and a GET endpoint (`/Evnia/GetTaskResult`) that can run any Bridge function (CSRF-able).

Windows coupling sits mostly in helpers such as WinForms, WMI, SetupAPI, user32 idle/foreground-window checks, low-level keyboard hooks, GDI screen capture, WASAPI, the registry, `netsh` and PowerToys FancyZones. The core dispatcher, theme and persistence logic is portable.

**Linux port recommendation.** Re-implement the host as a small loopback-only (or IPC-only) service that keeps the request/response and notification JSON envelope byte-compatible. That lets the existing renderer stay mostly unchanged. Implement only the display-relevant subset of the 162 functions (listed in §12). Stub everything peripheral, Windows-only or online with compatible error or empty responses. Reuse the on-disk formats unchanged under `$XDG_CONFIG_HOME/EvniaServe/`.

Conventions:
- **CONFIRMED** means read in code or seen in the user's real logs or config files. **INFERRED** means reasoned from code or framework semantics but not observed.
- `DC/` = `work/dotnet-clean/`, `DO/` = `work/dotnet/` (obfuscated originals), `AP/` = `work/app-pretty/`.
- `LOG/` = `%APPDATA%/EvniaServe/logs/`. `CFG/` = `%APPDATA%/EvniaServe/`.

---

## 1. Assemblies in scope

| Assembly | Target / SDK | Role | Key files |
|---|---|---|---|
| EvniaServe (exe) | `Microsoft.NET.Sdk.Web`, `netcoreapp3.1`, `OutputType=WinExe` (DC/EvniaServe/EvniaServe.csproj:1-8) | ASP.NET Core host, SignalR hub, REST controllers, dispatcher | DC/EvniaServe/Evnia/{Program,Startup,EvniaHub,HandleEvent,EvniaService,InputParams,*Controller}.cs, DC/EvniaServe/Class0.cs (dispatcher) |
| Bridge.Lib | `Microsoft.NET.Sdk`, netcoreapp3.1 | RPC facade: 162 `public static JsonResult` methods + `A_Notification(Notification)` (empty) + doc enum `Notification` | DC/Bridge.Lib/Bridge.Lib/Bridge.cs, Notification.cs |
| Zeasn.Framework.Core.Lib | `Microsoft.NET.Sdk.WindowsDesktop`, `UseWindowsForms=True` (csproj:1-6) | `SystemOper`: startup, device scan, per-function routing, theme/macro orchestration, CheckTopApp, Wi-Fi; `DynamicLghtingUtil` | DC/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs (3465 lines), DynamicLghtingUtil.cs, ScanDeviceType.cs |
| Zeasn.PCenter.Base.Lib | WindowsDesktop, `UseWindowsForms=True` | `GlobalOper` (SoftConfig, idle), `ThemeOper` (theme/profile files), `CacheVcpMgr` (data.json), `DictMgr` (device/monitor dictionaries), `EffectTimerMgr`, `ScreenCaptureMgr`, `MacroMgr`/`RunMacro`, `HotKeyMgr/InputEventManager`, `Display`/`DataOSD` (DDC; display team) | DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/*.cs |
| Zeasn.Com.Lib | netcoreapp3.1 | `JsonResult`, JSON extensions and `JsonIgnoreEx`, `SerializedFileUtil`, `PathBase`, `EventSystem`, `Singleton<T>`, crypto helpers, file/dir/process utils | DC/Zeasn.Com.Lib/Zeasn.Com.Lib/*.cs |
| Zeasn.Log.Lib | netcoreapp3.1, refs NLog | `ZLog` static wrapper over one NLog logger | DC/Zeasn.Log.Lib/Zeasn.Log.Lib/ZLog.cs |
| NuGet.Lib | netcoreapp3.1 | **Empty assembly** (no types; DC/NuGet.Lib contains only csproj and AssemblyInfo). Exists only to carry package references: Microsoft.Win32.Registry 5.0.0, NAudio 2.1.0, NLog 5.0.0, Newtonsoft.Json 13.0.1, SharpCompress 0.32.2, System.IO.Abstractions 17.2.3, System.Management 6.0.0, System.Text.Json 6.0.7 (CONFIRMED from `EvniaServe.deps.json`) | - |
| Zeasn.PCenter.Entity.Lib (support) | netcoreapp3.1 | Enums (`DeviceType`, `EquipmentType`, `Notification_Func`, `EVT_*`), persisted entity classes | DC/Zeasn.PCenter.Entity.Lib/... |

The `Class0`/`Class1`/`Class3`/`Class7` files in each assembly root (e.g. DC/EvniaServe/Class1.cs, DC/Zeasn.PCenter.Base.Lib/Class7.cs) are .NET Reactor runtime residue (string decryption, resource loader). They have no functional content and should be ignored.

Runtime (CONFIRMED, `Evnia Precision Center/resources/bin/EvniaServe.runtimeconfig.json`):
- Frameworks `Microsoft.NETCore.App`, `Microsoft.WindowsDesktop.App` and `Microsoft.AspNetCore.App`, all 3.1.32, self-contained ("includedFrameworks").
- `System.GC.Server=true`.
- Product version `1.13.0+65d46f10babb48ff3c3715929966c19c75c578d0` (DC/EvniaServe/Properties/AssemblyInfo.cs).

---

## 2. Process lifecycle

### 2.1 Launch by Electron (CONFIRMED)
- The Electron main process runs `resources\bin\EvniaServe.exe --urls http://*:<port>` via `child_process.execFile` (AP/main/index.js:13471-13590, class with `port = 10010`, `exeName = "EvniaServe.exe"`). The real Electron log `%APPDATA%/evnia/logs/26-09-23.log` shows the literal command line `EvniaServe.exe --urls http://*:10010`.
- Port selection:
  1. `getFreePort(10010)` tries to listen on 10010 and increments until a port is free.
  2. If an `EvniaServe.exe` process at the same path is already running (found with a PowerShell `Get-CimInstance Win32_Process` query), it reuses that process's port, found with `netstat -ano | findstr <pid>`.
  3. It retries at most 3 times.
- Before spawning, Electron refreshes `%APPDATA%\evnia\MonitorInfo.json` from the cloud (online; see 01-electron-main.md §8). With `--openAsHidden` it waits 10 s first.
- **Port pitfall (INFERRED).** `Program.CreateHostBuilder` hard-codes `webBuilder.UseUrls("http://*:10010/")` (DC/EvniaServe/Evnia/Program.cs:37). In ASP.NET Core 3.1 generic-host semantics, `UseUrls` writes the `urls` key into the web-host configuration, which is layered after the command-line provider. So the effective port is probably always 10010, and `--urls` is ignored. If 10010 were busy, Electron would pick 10011 while the backend still tries 10010. That was not observed; the user's port was always 10010.

### 2.2 `Program.Main` (DC/EvniaServe/Evnia/Program.cs:15-63) (CONFIRMED)
1. WinForms global exception plumbing: `Application.SetUnhandledExceptionMode(CatchException)`, `Application.ThreadException += ComUtil.Application_ThreadException`, `AppDomain.UnhandledException += ComUtil.CurrentDomain_UnhandledException`, `EnableVisualStyles`, `SetCompatibleTextRenderingDefault(false)` (lines 19-23). The handlers only log (DC/Zeasn.Com.Lib/Zeasn.Com.Lib/ComUtil.cs:31-47).
2. `smethod_0()` (lines 47-63):
   - Logs the banner `===... PCenter Start ...===`.
   - Runs `ComUtil.CleanLogFiles()`, which deletes files in `%APPDATA%\EvniaServe\logs` whose `LastWriteTime` is older than 3 days or whose size is over 5 242 880 bytes (5 MiB). It creates the directory if it is missing (ComUtil.cs:15-29).
   - In a background task: `CSystemInfo.SysInfo()` (WMI logging of OS name, virtual-machine detection and `Win32_VideoController` names; DC/Zeasn.Win.Lib/Zeasn.Win.Lib/CSystemInfo.cs:30-52), then `ProcessUtil.ProcessKill("DtsServer")`, which kills every process named `DtsServer` (DC/Zeasn.Com.Lib/Zeasn.Com.Lib/ProcessUtil.cs:23-45).
   - The real log shows exactly these lines: `SystemInVirtualMachine = False`, `Microsoft Windows 11 Pro`, `Name - AMD Radeon Graphics</br>`, `DeviceID - VideoController1</br>` (LOG/2026-09-26.txt:1-5).
3. `Host.CreateDefaultBuilder(args).ConfigureWebHostDefaults(UseUrls("http://*:10010/"), UseStartup<Startup>).ConfigureLogging(ClearProviders, SetMinimumLevel(Trace)).UseConsoleLifetime()`, then `Build().Run()` (lines 33-45). ASP.NET's own logging providers are cleared, so only NLog via `ZLog` produces logs.

### 2.3 ASP.NET Core configuration (DC/EvniaServe/Evnia/Startup.cs) (CONFIRMED)
| Item | Value | Line |
|---|---|---|
| Listen URL | `http://*:10010/` (all IPv4/IPv6 interfaces, plain HTTP, no TLS) | Program.cs:37 |
| MVC | `AddControllers()` + `MapControllers()` | 22, 65 |
| SignalR | `AddSignalR()` then `AddSignalR(o => o.MaximumReceiveMessageSize = 1048576)` (1 MiB); hub mapped at `/EvniaHub` with `HttpConnectionDispatcherOptions.ApplicationMaxBufferSize = TransportMaxBufferSize = 1048576` | 23, 40-43, 66-70 |
| CORS default policy | `WithOrigins("https://*:10010/").AllowCredentials()`. This is dead in practice because `UseCors(builder)` below overrides it | 24-30 |
| CORS middleware | `UseCors(o => o.WithOrigins("app://.").AllowAnyMethod().AllowAnyHeader().AllowCredentials(); o.WithOrigins("http://localhost:10010")…)`. The second `WithOrigins` appends, so the allowed origins are `app://.` and `http://localhost:10010`. CORS does **not** apply to WebSocket upgrades | 55-61 |
| Swagger | `AddSwaggerGen` doc `v1`, title `PCenter`; `UseSwagger()`; `UseSwaggerUI` endpoint `/swagger/v1/swagger.json` "PCenter v1". **Enabled in production** | 31-38, 49-53 |
| Error page | `UseDeveloperExceptionPage()` unconditionally (stack traces to any caller) | 48 |
| Auth | `UseAuthorization()` with no schemes or policies, so effectively none | 62 |
| Hosted service | `AddHostedService<EvniaService>()`: `ExecuteAsync` loops `Task.Delay(1000)` forever; `StopAsync` logs and kills `DtsServer` (DC/EvniaServe/Evnia/EvniaService.cs:11-24) | 39 |
| `appsettings.json` | Logging levels (unused, providers cleared); `"AllowedHosts": "*"` | resources/bin/appsettings.json |
| `web.config` | IIS ANCM in-process stub (`processPath=".\EvniaServe.exe"`, stdout log off). Irrelevant outside IIS | resources/bin/web.config |

### 2.4 Hub connection lifecycle (DC/EvniaServe/Evnia/EvniaHub.cs) (CONFIRMED)
- Constructor (line 23): creates a `HandleEvent` unless this is not the first connection.
- `OnConnectedAsync` (32-53):
  1. Sets static `StartClient = Clients` and `HandleEvent.bConnect = true`.
  2. **On the first connection only** (static `bool_0`):
     - `handleEvent_0.RegisterEvent()` wires the internal event bus to the UI (§4).
     - `SystemOper.GetFancyZonesData()` reads PowerToys data. It logged `WARN 不存在程序 ...\SmartControl\Modules\SmartDesktop\modules\FancyZones\PowerToys.FancyZones.exe` ("program does not exist") in LOG/2026-09-26.txt:7.
     - Starts a dedicated thread running `SystemOper.RunPerSecondAtStart(() => { GlobalOper.CheckIdle(); SystemOper.CheckTopApp(); })`.
- `OnDisconnectedAsync` (55-60): logs an error and sets `bConnect = false`. Nothing is torn down, and the loop thread keeps running.
- `GetTaskAsync(string parm)` (62-66) is the **only hub method**:

  ```csharp
  string arg = Singleton<Class0>.Instance.method_0(parm);
  await Clients.All.SendAsync("GetTaskAsync", arg);
  ```

  - The dispatcher runs **synchronously** on the SignalR invocation.
  - The reply is sent to **all** connected clients, not the caller, as a hub event named `GetTaskAsync` whose single argument is the JSON **string**.
  - The hub method returns nothing (`Task`).

### 2.5 `Start` and the device scan (DC/.../SystemOper.cs) (CONFIRMED)
The renderer calls `Start` first after connecting (LOG/2026-09-26.txt:8, `{"functionName":"Start","requestId":"683a…","parms":null}`).

`SystemOper.Start()` (107-122):
- If the static `bool_0` ("scan finished") is false, it calls `InitEnviroment()` and then `smethod_0(ScanDeviceType.All)`, and returns `Succ(true)`.
- Otherwise it returns `Succ(true)` immediately. On failure it returns `Error("InitEnviroment error")`.

`InitEnviroment(reset)` (124-133):
- `ThemeOper.ThemeInit(reset)` loads or creates `Theme\DataTheme.cfg`, see §7.
- `themeInfo_0 = DataTheme.UserThemeInfo`. The theme named `"User"` is **always** the startup theme; the last active app theme is not restored.
- `t_Theme_Profile_0 = themeInfo_0.LoadCurProfile()` reads `Theme\User\<SelProfileName>.pcenter`, creating a default one if it is missing.

Scan `smethod_0(ScanDeviceType)` (135-226):

1. `bool_0 = false`. This also pauses the 1-second idle/top-app loop (§2.6).
2. Select `DeviceType` values from `Extension_Enum.GetDatas(typeof(DeviceType))`, which excludes members tagged `[UnbindEnumExtended]`: `Unknown`, `RongYuan_MouseSPK9708_BLE`, `HaiHui_MouseSPK9618_3395_BLE` (DC/Zeasn.Com.Lib/Zeasn.Com.Lib/Extension_Enum.cs:107-148).

   | ScanDeviceType | Selection (lines 142-176) | Triggered by Bridge fn |
   |---|---|---|
   | `All` (0) | all 26 bindable types | `Start`, `Device_Rescan` |
   | `USB` (1) | all except `PHL_CDeviceDisplay` and except `ConnectMode==BLE` (from `PCenter_DeviceInfo.json`) | `Device_DetectionUSB` |
   | `Dispaly` (2, sic) | only `PHL_CDeviceDisplay` | `Device_DetectionDisplay` (after `Thread.Sleep(5000)`, line 243) |
   | `Other` (3) | only `ConnectMode==BLE` types | `Device_OtherDeviceChange` |

3. Snapshot the USB topology into `Global.UsbList`, `Global.UsbDevices` and `Global.UsbHubs` (Zeasn.Win.Lib `UsbUtil`/`UsbDevice`; lines 177-188). The real log paths show the device-interface classes:
   - `UsbList`: HID interfaces, `{4d1e55b2-f16f-11cf-88cb-001111000030}` = GUID_DEVINTERFACE_HID.
   - `UsbDevices`: `{a5dcbf10-6530-11d2-901f-00c04fb951ed}` = GUID_DEVINTERFACE_USB_DEVICE.
   - `UsbHubs`: `{f18a0e88-c30c-11d0-8815-00a0c906bed8}` = GUID_DEVINTERFACE_USB_HUB.
   - Source: LOG/2026-09-26.txt:11-41.
4. For **each** selected type, run `Task.Run(smethod_5(type, curProfile))` in parallel, then `Task.WaitAll` (lines 189-202). `smethod_5` (846-878):
   - Gets the driver singleton via `smethod_6` (the factory table below).
   - Sets `CurThemeInfo` and `CurThemeProfile`.
   - Calls `profile.ConnectionCkecked()`. On true it adds the driver to `EquipmentDic` (`ConcurrentDictionary<DeviceType,IDevice>`). On false it removes it, unless the device is BLE or Dongle.
   - Display team: `ConnectionCkecked` for the display loads the saved profile content and pushes it to the monitor (`GClass0.DeviceDataCheck`, DC/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/GClass0.cs:173-189, `ParameterToDevice(..., bForce:true)`).
5. After the scan:
   - For `USB` scans only: `SendEvent(EVT_Com.UsbDeviceChange)`, handled by `CDevice_PHLDisplay`.
   - Always: `SendEvent(EVT_Effect.Effect_Sync)`, then `SendEvent(EVT_Effect.CheckSoftEffect)`, then `bool_0 = true` (lines 205-219).

Driver factory `smethod_6` (880-925):

| DeviceType(s) | Driver singleton (Zeasn.Equipment.Option.Lib) |
|---|---|
| 100000 `PHL_CDeviceDisplay` | `PHLDisplay_Oper.Equipment()` (…PHLDisplay/PHLDisplay_Oper.cs; implements `IDisplay, IEffect, IProfile, IDevice` only) |
| 200000-200004 `RongYuan_Keyboard*` | `RongYuanKeyboard_Oper` |
| 201000/201001 `BeiYing_KeyboardSPK8618[_24G]` | `BeiYing_KB_K916_Oper` |
| 300000-300004 `RongYuan_Mouse*` | `RongYuanMouse_Oper` |
| 301000-301002 `JiangMeng_*` | `JiangMengMouse_Oper` |
| 302000-302003 `YongJiaXing_*` | `YongJiaXingMouse_Oper` |
| 303000-303002 `HaiHui_MouseSPK9618_3395*` | `HaiHui_9618_3395_Mouse_Oper` |
| 303003/303004 `HaiHui_MouseSPK9618_8960*` | `HaiHui_9618_8960_Mouse_Oper` |
| 400001 `RongYuan_MousePadSPL7508` | `RongYuanMousePad_Oper` |
| 500000/500001 `PHL_CDeviceTAG4106/5106` | `TAGHeadsetDTS_Oper` |

Real-log timing for the user's system (CONFIRMED, LOG/2026-09-26.txt):

| Time | Event |
|---|---|
| 07:52:29.32 | Process start |
| 07:52:30.50 | Hub connected |
| 07:52:30.95 | `Start` received |
| 07:52:31.11 | Scan begins |
| 07:52:31.47 → 07:52:52.19 | Display `ConnectionCkecked` phases 1-5 ("start", "USBDevices Init", "DDCDevices Init", "middle", "end"). **21 069 ms**, dominating the scan; the peripherals take ≤ 1.7 s |
| 07:52:52.39 | `已接入设备数 count=1` ("connected devices count=1"); the renderer's next call (`Device_GetConnectList`) arrives, consistent with the `Start` reply arriving only after the scan completes |

### 2.6 Background loops and timers (CONFIRMED unless noted)
| Loop | Period | Code | Behaviour |
|---|---|---|---|
| `RunPerSecondAtStart` | 1000 ms `Thread.Sleep` | SystemOper.cs:304-314 | Infinite loop; runs its action only while `bool_0` (scan complete) is true |
| `GlobalOper.CheckIdle` | from the loop above | DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/GlobalOper.cs:108-118 | If `TurnOffLightsWhenIdle` is false, `IsIdle=false`. Otherwise `IsIdle = (GetLastInputInfo idle ms) >= TurnOffLightsWhenIdleDuration*60*1000`. The `IsIdle` setter (55-70), on change, logs `Idle state:{v}` and sends `EVT_Effect.EffectEnableTemp`, which runs `SystemOper.EffectEnableTemp` (1481-1502): each connected `IEffect.EffectEnableTemp(!IsIdle)` (lights temporarily off/on, including Ambiglow), plus timers stop or restart |
| `SystemOper.CheckTopApp` | from the loop above | SystemOper.cs:3295-3345 | See the steps below |
| `EvniaService.ExecuteAsync` | 1000 ms | EvniaService.cs:18-24 | No-op keepalive |
| `EffectTimerMgr` (singleton, 4 threads started in `Init`) | see right | DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/EffectTimerMgr.cs:65-175 | (a) Screen-capture thread: every 300 ms while follow-video is enabled (`fgbsatJeK`, **initially true**), else a 1000 ms idle poll; enqueues `ScreenCaptureMgr.CaptureScreen()` of the primary screen. (b) Video thread: every 100 ms while enabled, `CalcRGBs(6,7,3,5,11,bitmap)` then `SendEvent(Effect_VideoData, (Bitmap, byte[]))`. (c) Audio thread: 40 ms; `AudioSyncUtil.GetDftData()` gives `Effect_AudioData (double[] dft, byte level, RGB fadeColor)`, with a fade over an 8-color rainbow list in 5 % steps per tick. (d) Breathing thread: 40 ms, `SendEvent(Effect_BreathingData)` |
| `AmbiScapeOper` | min interval 2000 ms (default; overridden by `AmbiScape_EnableFollowVideo(timeInterval>0)`) | DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/AmbiScapeOper.cs:19-104 | On `Effect_VideoData`, computes 10 edge colors from an 8×6 grid and sends `NotifyAmbiScapeFollowVideoData` |

`CheckTopApp` (SystemOper.cs:3295-3345) runs these steps:
1. Calls `GetForegroundWindow` (user32). If the HWND is unchanged, it returns.
2. Calls `GetWindowThreadProcessId`, then `Process.GetProcessById`. If the process name is unchanged, it returns.
3. If the process name is not `electron` or `Precision Center`, it gets the full exe path via `OpenProcess(0x1000)` + `QueryFullProcessImageName` (DC/Zeasn.Win.Lib/Zeasn.Win.Lib/CWinSysGetWnd.cs:87-111).
4. It finds the first theme whose `BindAppInfos[].BindAppFilePath` equals that path (case-insensitive), else uses theme `"User"`.
5. If that differs from the current theme, it sends notification `NotifyUISwitchTheme` with `Tag = "<ThemeName>"` (string).
6. **The backend does not switch by itself.** The UI reacts by calling `Theme_SwitchApp` (AP/renderer/assets/main-CDosWiM3.js:1917-1925).

`CheckSoftEffect` (SystemOper.cs:1466-1479) is sent after each scan and by devices. It enables the follow-video timer if any connected `IEffect.EffectType == FollowVideo` or AmbiScape follow-video is on. It enables the follow-audio timer if any device has `FollowAudio`, and the breathing timer if any has `Breathing`.

Breathing generator `OnBreathingData` (SystemOper.cs:1799-1899). Its state is shared across devices and driven by `Sync_Profile.EffectDetailInfo`:
- Brightness factor = `clamp(Brightness,1,3)/3`.
- Step counts per phase from `smethod_12(speed, descending)`:

  | Speed | Ascending steps | Descending steps |
  |---|---|---|
  | 1 | 6 | 24 |
  | 2 | 4 | 16 |
  | 3 | 2 | 8 |

- Emitted color = `CurRGB` (or the rainbow color if `IsRainbowColor`) × brightness × `step/steps`.
- The counter rises to `steps`, then falls to 0. At the bottom it advances the rainbow index through `[FF0000, FF8000, FFFF00, 00FF00, 00FFFF, 0000FF, FF00FF, FFFFFF]`.
- It is sent via `IEffect.OnBreathing(0, rgb)` to devices whose `EffectType == Breathing`. At the 40 ms tick, speed 1 is about 0.25 s up and 1 s down.

### 2.7 Shutdown (CONFIRMED)
`UseConsoleLifetime()` means Ctrl-C/SIGTERM stops the host, and `EvniaService.StopAsync` kills `DtsServer`. Nothing else is persisted on shutdown, because all state is written eagerly (§7.6). The Electron side kills the process on exit (see 01-electron-main.md §7).

---

## 3. RPC wire protocol

### 3.1 Transport (CONFIRMED from the renderer client, AP/renderer/assets/styles-DAnQi2A8.js:7885-8030)
- Client: `new HubConnectionBuilder().withUrl("http://localhost:" + port + "/EvniaHub", { skipNegotiation: true, transport: WebSockets, timeout: 120000 }).withAutomaticReconnect()`, with logging at Debug.
  - This means a direct `ws://localhost:<port>/EvniaHub` upgrade with no `/negotiate` POST.
  - The SignalR JSON hub protocol:
    - Handshake: `{"protocol":"json","version":1}\x1e`.
    - Invocation frame: `{"type":1,"target":"GetTaskAsync","arguments":["<request-json-string>"],"invocationId":"<n>"}\x1e`.
    - The server's hub event frame has `"type":1,"target":"GetTaskAsync"|"Notification"` with `arguments[0]` a JSON string.
  - The protocol and framing are standard ASP.NET Core SignalR 3.1 and INFERRED; the client options are CONFIRMED.
- Client event names registered: `["GetTaskAsync","Notification"]`, both handled by the same `handleResponse(JSON.parse(arg))` (styles-DAnQi2A8.js:7979-8022).
- Client routing:
  - If the message has `RequestId`, it resolves the pending promise **only if** `waitingResponse[FunctionName] === RequestId`, or the function is in the concurrent list `["Theme_GetThemeInfos","DeviceSteup_GetPowerInfo"]`. Otherwise it is dropped silently. The practical effect: for the same function name, only the latest outstanding request is answered.
  - If there is no `RequestId`, it is a notification and goes to subscribers of `FunctionName` with the argument `Tag`.
- The client treats the reply as an **error when `err_code !== 0 || err_msg` is truthy** and rejects with `{code: err_code, msg: err_msg}`. Otherwise it resolves with `Tag` (styles-DAnQi2A8.js:7928-7932). This is why every success must have `err_msg` equal to `""` or `null`.
- Methods excluded from client console logging: `Effect_CheckDynamicLightingEnabled`, `Effect_GetLEDs`, `NotifyAmbiScapeFollowVideoData`.
- Reconnect: on `onclose` it reconnects every 2 s until success. If the hub is not connected at invoke time, it waits 4 s first.

### 3.2 Request envelope `InputParams` (DC/EvniaServe/Evnia/InputParams.cs) (CONFIRMED)
```json
{"functionName":"PHL_SetOSD","requestId":"2edaf9a0-a747-454a-a6f9-acf680fb2104","parms":["EXT_OP_E2A0_43_AutoWarning",1]}
```
| Field | C# type | Default | Notes |
|---|---|---|---|
| `functionName` | string | null | Name of a `Bridge` static method (case-sensitive dictionary lookup) |
| `requestId` | string | null | Echoed back as `RequestId`. The renderer generates a UUIDv4-like id (styles:7964-7970); REST uses `"1"` |
| `parms` | `List<JToken>` | null | Positional arguments. **The renderer sends `null` when there are none**, not `[]` (styles:7942) |
| `device` | int | -1 | **Unusable in practice**, see §3.3. The renderer never sends it; the device type goes in `parms[0]` (e.g. `{"functionName":"Profile_GetDeviceData",...,"parms":[100000]}`, LOG/2026-09-26.txt) |

Every real request seen in the user's logs:
- 20 distinct functions, see §6 "UI v1.13 use".
- Sample: `Start` `null`; `Macro_GetList` `["User"]`; `PHL_SwitchDisplay` `["<monitor serial string>"]`; `Profile_GetDeviceData` `[100000]`; `PHL_SetOSD` `["EXT_OP_E2A0_43_AutoWarning",1]`.

### 3.3 Dispatcher `Class0.method_0/1/2` (DC/EvniaServe/Class0.cs) (CONFIRMED)
1. `method_0(json)` (19-51):
   - Deserializes `InputParams` with Newtonsoft (`NullValueHandling.Ignore`). On failure it returns `Error("解析json字符串: <json>失败")` ("parsing JSON string <json> failed"), err 9.
   - Logs `GetTaskAsync param = <raw json>` unless `functionName ∈ {"Effect_GetLEDs","Effect_CheckDynamicLightingEnabled"}` (line 13).
   - Serializes the result with `JsonSerialize()`, or, for `functionName ∈ {"Profile_GetDeviceData"}` (line 15), with `JsonSerialize(JsonIgnoreExType.IgnoreUI, includeNulls)` (line 48). See §3.5.
   - Any exception becomes `JsonResult.Exception(ex)` (err 9, `err_msg = ex.ToString()`).
2. Method table (115-172): lazily built from `typeof(Bridge.Lib.Bridge).GetMethods(Public|Static)` grouped by name. `A_Notification` is included but unreachable with JSON arguments.
3. Argument typing (lines 124-146 and 82-99). Each `parms` element maps by `JToken.Type`:

   | JSON type | C# type | Conversion |
   |---|---|---|
   | Integer | `int` | `Convert.ToInt32`; values beyond int32 throw, giving err 9 |
   | String | `string` | as-is |
   | Boolean | `bool` | as-is |
   | anything else (Float, Null