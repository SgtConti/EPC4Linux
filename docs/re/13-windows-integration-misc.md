# 13 — Windows-only integrations: Zeasn.Win.Lib, SmartDesktop/FancyZones, DTS, Wi-Fi, hotkeys, idle/foreground tracking, elevate, Matter bulbs

## Summary

This report covers the parts of Evnia Precision Center v1.13.0 that are tied to Windows or to third-party helper programs, not to the monitor protocol itself. For each one it says what it does, how it works (with file and line references), and what a Linux port should do.

Short version:

- **Keep (useful on the user's 34M2C8600)**
  - **Idle detection.** `CheckIdle` turns the Ambiglow LEDs off by writing TPV VCP `E2 A0 19` = `0x00` after N minutes without input, and restores the old value afterwards.
  - **Foreground-app theme switching.** `CheckTopApp`, `Theme_SwitchApp`, `Theme_UpdateBindApp` and `Comm_GenAppIcon` switch profiles when a bound app gets focus.
  - **Autostart.** The app starts at login, minimized.
  - **Windows Dynamic Lighting check.** On Linux this should return "not applicable".
  - Each has a clear Linux equivalent: ext-idle-notify / Mutter IdleMonitor / XScreenSaver; `_NET_ACTIVE_WINDOW` / KWin script / compositor IPC; XDG autostart.
- **Drop**
  - **Global hotkeys and input hooks (`InputEventManager`).** This code is dead in v1.13.0. `Start()` is never called, the display hotkey methods are stubs, and the renderer never calls any hotkey function.
  - **DTS.** It only works with Philips TAG4106/TAG5106 headsets (USB `25AA:6002` / `25AA:6003`) and needs a `DtsServer.exe` downloaded from the vendor cloud.
  - **SmartDesktop.** This is a downloader and launcher for a repackaged Microsoft PowerToys FancyZones, fetched from the vendor cloud.
  - **`elevate.exe`.** Johannes Passing's 2007 "Elevate" UAC helper. The self-updater is its only user.
- **Optional, off by default: Matter smart bulbs ("AmbiScape").**
  - The control path is local-network only. It uses matter.js through Node running `resources/matter/control.mjs`: BLE for commissioning, IPv6/UDP plus mDNS for operation.
  - It never contacts the Distributed Compliance Ledger (DCL). Device attestation is only checked for *presence*.
  - It does need a **Node runtime "plugin" downloaded from `deviceportal.zeasn.tv`**. It also needs **Wi-Fi credentials**, which the backend reads from Windows (`netsh … key=clear`).
  - Linux alternatives: system Node ≥ 18 or Electron-as-Node, NetworkManager/iwd over D-Bus, and IP-only commissioning or chip-tool for BLE.
- **Security notes the Linux port must not reproduce (CONFIRMED by reading the code; nothing was executed):**
  1. `GetWifiList` shells out to `cmd.exe`/`netsh` with the SSID string interpolated into the command line, once per visible network. The SSID is attacker-controllable data. A reimplementation must never pass a scanned SSID to a shell.
  2. `GetWifiList` returns saved Wi-Fi passphrases in clear text over the SignalR channel, and the backend binds `http://*:10010` (all interfaces), so that channel is reachable beyond localhost.
  3. The Matter child process receives Wi-Fi credentials as command-line arguments and echoes them into its own log.
  4. SmartDesktop terminates any process named `PowerToys.FancyZones` and overwrites the genuine PowerToys file `%LOCALAPPDATA%\Microsoft\PowerToys\FancyZones\settings.json`.
  These are reasons to redesign the corresponding surfaces on Linux, detailed in §6, §7 and §8.

Legend used throughout:
- **CONFIRMED**: read in code, or seen in the user's logs or config files.
- **INFERRED**: deduced, not directly observed.

Paths are relative to the repository root. These abbreviations are used:
- `SO` = `work/dotnet-clean/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs`
- `MAIN` = `work/app-pretty/main/index.js`
- `STY` = `work/app-pretty/renderer/assets/styles-DAnQi2A8.js`
- `AMB` = `work/app-pretty/renderer/assets/AmbiScape-B35D_GM2.js`
- `MCJ` = `work/app-pretty/matter-control.mjs`
- `MAINR` = `work/app-pretty/renderer/assets/main-CDosWiM3.js`

---

## 1. Inventory

| # | Integration | Bridge / IPC surface | Windows dependency | Used by the v1.13.0 UI? | Relevant to 34M2C8600 | Online | Linux verdict |
|---|---|---|---|---|---|---|---|
| 1 | Idle → lights off | `Setting_TurnOffLightsWhenIdle(bool)`, `Setting_TurnOffLightsWhenIdleDuration(int)`, background `CheckIdle` | `user32!GetLastInputInfo` | Yes (Settings › General "OffLighting / IdleFor") | **Yes** (Ambiglow off via VCP E2A0-19) | No | **Keep** (ext-idle-notify-v1 / Mutter IdleMonitor / XScreenSaver / logind) |
| 2 | Foreground app → theme | `Theme_Add`, `Theme_UpdateBindApp`, `Theme_SwitchApp`, background `CheckTopApp`, notification `NotifyUISwitchTheme` | `GetForegroundWindow`, `GetWindowThreadProcessId`, `OpenProcess(0x1000)`, `QueryFullProcessImageName` | Yes (Profile › "New Application" binding) | **Yes** (a theme's profile includes monitor settings) | No | **Keep** (X11 `_NET_ACTIVE_WINDOW`; Wayland per compositor) |
| 3 | App icon extraction | `Comm_GenAppIcon(path)` | `user32!PrivateExtractIcons`, GDI+ | Yes (with #2) | Yes (with #2) | No | **Keep** (.desktop `Icon=` plus icon theme) |
| 4 | Global hotkeys / LL hooks | `ModifierKeyListenerEnable`, `GetHotKeyState`, `PHL_*HotKey*`, `PHL_EnableGamePQMouseKey`, `PHL_SetGamePQMouseKeyBind` | `RegisterHotKey`, `SetWindowsHookEx(WH_KEYBOARD_LL/WH_MOUSE_LL)`, `SendInput` | **No** (never called; implementation dead) | No | No | **Drop** (return stubs) |
| 5 | Wi-Fi list + saved passwords | `GetWifiList()` | ManagedNativeWifi 2.8.0 (`wlanapi.dll`), `cmd.exe`+`netsh` | Only in the Matter BLE pairing dialog | No | No (local) | **Drop** (or NetworkManager/iwd without passwords if Matter is kept) |
| 6 | Matter smart bulbs (AmbiScape "Bulb" device) | Electron IPC `checkNodeAvailable`, `discoverBulb`, `pairingBulb`, `commissionBulb`, `openCommissioningWindow`, `identifyBulb`, `getBulbAttribute`, `setBulbAttribute`, `removeBulb`, `destroyBulbProcess`, `clearCache`, `getCurrentProcess`; event `matterNotification` | Downloaded `node.exe`; `@stoprocent/noble` (WinRT BLE) | Yes, if enabled and the Node plugin is present | Indirect (gated on any Philips monitor; controls third-party bulbs) | **Yes** (plugin download) | **Optional** (off by default; see §7) |
| 7 | Screen → bulb colour sync | `AmbiScape_EnableFollowVideo(bool, int ms)`, notification `NotifyAmbiScapeFollowVideoData` | GDI screen capture (ScreenCaptureMgr) | With #6 | Indirect | No | With #6 |
| 8 | SmartDesktop = PowerToys FancyZones | `FancyZones_Enable`, `FancyZones_StartEditor`, `FancyZones_GetVersion`, `FancyZones_GetData`, `FancyZones_SetSetting` | Downloaded `PowerToys.FancyZones.exe` / `…Editor.exe`, `%LOCALAPPDATA%\Microsoft\PowerToys` | Yes (Monitor › Smart Desktop nav item is always shown) | No (desktop window tiling) | **Yes** (download) | **Drop** (use KWin tiling / GNOME extensions) |
| 9 | DTS headset audio | `DTS_Open/Close/SetAPO/SetRooms/SetStereoPreference/SetBassTbhdx/SetDialogEnhancement/SetPreset/SetGeqBandGain/GraphicEqRest/SaveGeqBandGain` | Downloaded `DtsServer.exe`, named pipe `\\.\pipe\DTS`, `winmm!PlaySound` | Yes (Headset pages) | No (TAG headsets only) | **Yes** (download) | **Drop** |
| 10 | Windows Dynamic Lighting check | `Effect_CheckDynamicLightingEnabled`, `Effect_OpenDynamicLightingSetting` | `HKCU\Software\Microsoft\Lighting\AmbientLightingEnabled`, `ms-settings:` URI | Yes (Ambiglow page, polled every 2 s) | Yes (warning banner on the Ambiglow page) | No | **Stub** (return −1) |
| 11 | Autostart / start hidden | Electron IPC `setAutoStartUp(bool, bool)`; `--openAsHidden` | `app.setLoginItemSettings` (HKCU Run) | Yes (Settings › General) | App-level | No | **Keep** (XDG autostart `.desktop`) |
| 12 | Backend self-autostart | `CWinSysRegister.SetMeStart` | HKLM `…\CurrentVersion\Run` | **No** (dead code) | No | No | **Drop** |
| 13 | `elevate.exe` | used by `packageInstall` in MAIN | `ShellExecuteExW("runas")` | Only by the self-updater | No | Yes (self-update path) | **Drop** |
| 14 | Other Zeasn.Win.Lib wrappers (display, EDID, HDR, USB SetupAPI, SendInput, SystemParametersInfo, PlaySound, registry) | many | Win32 | Various | Some (display/EDID) | No | See §12 and the cross-references |

---

## 2. Background loop that drives idle and foreground tracking (CONFIRMED)

- `work/dotnet-clean/EvniaServe/Evnia/EvniaHub.cs:32-53`: on the **first** SignalR connection (`OnConnectedAsync`, guarded by a static bool) the hub:
  1. registers event handlers (`HandleEvent.RegisterEvent`);
  2. calls `SystemOper.GetFancyZonesData()`, which forces `FancyZonesOper` singleton initialisation (§8);
  3. starts **one thread** running `SystemOper.RunPerSecondAtStart(() => { GlobalOper.CheckIdle(); SystemOper.CheckTopApp(); })`.
- `SO:304-314`, `RunPerSecondAtStart(Action, int time = 1000)`: `while(true){ if (bool_0 && action != null) action(); Thread.Sleep(1000); }`. `bool_0` is `true` only after the device scan (`smethod_0`) has finished (`SO:212`). **Period: 1000 ms, polling, never stops.**
- Linux: replace polling with event sources where they exist: idle notifications and active-window-changed signals. Keep a 1 s poll fallback for X11 or odd compositors.

---

## 3. Idle detection → "Turn off lights when idle" (CONFIRMED)

### 3.1 Code path
| Step | Location | Detail |
|---|---|---|
| Setting store | `Zeasn.PCenter.Entity.Lib/.../SoftConfigInfo.cs` | `TurnOffLightsWhenIdle: bool` (default `false`), `TurnOffLightsWhenIdleDuration: int` minutes (default `5`) |
| Persistence | `Zeasn.PCenter.Base.Lib/.../GlobalOper.cs:77-106`; path `WorkspacePath.SoftConfigPath` = `%APPDATA%\EvniaServe\Config\SoftConfig.data` (`WorkspacePath.cs:32-34`) | JSON with a UTF-8 BOM. User's file: `{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5}` |
| Bridge setters | `Bridge.cs:28-42` | `Setting_TurnOffLightsWhenIdleDuration(duration)` → `JsonResult.Error("at last 1 minutes")` if `< 1` |
| Read-back | `Bridge.cs:23-26` `Setting_GlobalData()` → `Succ(SoftConfigInfo)` | |
| Check | `GlobalOper.cs:108-118` | `IsIdle = enabled && CWinSysWithoutOperate.GetLastInputTime() >= Duration*60*1000` |
| Idle ms | `Zeasn.Win.Lib/Zeasn.Win.Lib/CWinSysWithoutOperate.cs:17-29` | `GetLastInputInfo(LASTINPUTINFO{cbSize=8})` → `Environment.TickCount - dwTime` (ms) |
| Edge event | `GlobalOper.cs:55-70` | Fires only when the value changes: logs `Idle state:{v}` and sends `EVT_Effect.EffectEnableTemp` |
| Handler | `EvniaServe/Evnia/HandleEvent.cs:43-46` → `SO:1481-1500` `EffectEnableTemp()` | For every connected `IEffect` device: `EffectEnableTemp(!IsIdle)`. Idle → `EffectTimerMgr.StopAllTimer()` (stops the follow-video, follow-audio and breathing timers). Resume → re-enables timers by effect type |
| Monitor action | `Zeasn.Equipment.Option.Lib/.../PHLDisplay/CDevice_PHLDisplay.cs:954-971` | **Non-ENE path (the 34M2C8600 case):** clone attribute `ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode`. If it is available and ≠ `AmbiglowOff`, write `0` (AmbiglowOff) when idle and the saved profile value when active. **ENE path:** clone `EffectInfo`, set `EffectEnable=enable`, push via `method_17` (ENE LED controller; see the ENE report) |
| Enum | `Zeasn.PCenter.Entity.Lib/.../E2A0_19_AmbiglowLightMode_E.cs` | 0 Off, 1 FollowVideo, 2 FollowAudio, 3 ColorShift, 4 ColorWave, 5 ColorBreathing, 6 StarryNight, 7 StaticMode, 8 ColorFlowReverse, 9 ColorFlow. The user's capability string lists `E2A019(00 01 02 03 04 05 06 07)` (`%APPDATA%\EvniaServe\Config\data.json`) |

UI: `STY:30020-30045` and `STY:30215-30250`. The checkbox "IdleFor" and a minutes box (min 0, max 999) sit under "OffLighting". If the box is 0 or empty, the UI rewrites it to 5 before sending.

### 3.2 Semantics to preserve / fix
- Windows `GetLastInputInfo` counts **only real user input**. Media playback inhibitors are ignored, so watching a video with no input for N minutes **does** turn the lights off. For parity on Linux, use the *input-idle* variant (`ext_idle_notifier_v1.get_input_idle_notification`, protocol v2), not the inhibitor-respecting one. Alternatively make this configurable.
- Vendor bug (INFERRED): `Environment.TickCount` is a signed 32-bit value that wraps after ~24.9 days of uptime. `TickCount - (uint)dwTime` is then negative, so idle is never detected. Do not port this.
- The duration is in **minutes** and must be ≥ 1.

### 3.3 Linux equivalents (in order of preference)
| Session | API | Notes |
|---|---|---|
| Wayland, wlroots (sway, Hyprland, labwc, niri), KWin | `ext-idle-notify-v1`: `ext_idle_notifier_v1.get_input_idle_notification(timeout_ms, seat)` → `idled`/`resumed` | Event-driven. The timeout is set to `Duration*60000`. Re-create the notification when the setting changes |
| GNOME (Mutter) | D-Bus `org.gnome.Mutter.IdleMonitor` `/org/gnome/Mutter/IdleMonitor/Core`: `GetIdletime()` → ms; `AddIdleWatch(ms)` + `WatchFired` signal; `AddUserActiveWatch()` | Private but stable GNOME API |
| KDE fallback | `org.freedesktop.ScreenSaver.GetSessionIdleTime()` (seconds) | |
| X11 | `XScreenSaverQueryInfo()` (libXss) → `idle` ms | Poll every 1 s (same as Windows) |
| Any, systemd | logind `org.freedesktop.login1.Session.IdleHint` / `IdleSinceHint` | Coarse; the DE sets it. Last resort |

The Linux action is the same DDC write, `E2 A0 19 := 0x00` / restore, through the DDC layer (see the DDC report).

---

## 4. Foreground-app tracking and app-bound themes (CONFIRMED unless marked)

### 4.1 Data model
- `%APPDATA%\EvniaServe\Theme\DataTheme.cfg` (JSON, BOM):
  `{"ThemeInfos":[{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]}]}` (user's file; only the default theme exists).
- `BindAppInfo` (`Zeasn.PCenter.Entity.Lib/.../BindAppInfo.cs`): `{ "BindAppFilePath": string, "BindAppIconPath": string }`.
- Theme profile dir: `WorkspacePath.GetThemeProfileDir(name)` = `%APPDATA%\EvniaServe\Theme\<name>` (`WorkspacePath.cs:30,55`). Icons are moved to `<ProfileDir>\Icon\<first 10 hex chars of SHA1(BindAppFilePath)>.png` (`ThemeOper.cs:180-206`).
- UI limits (`STY:42525-42570`): at most **50 themes** (`ThemeUpperLimit`), at most **7 apps per theme** (`AppBindLimit`). Binding the app's own exe (`runConfig.processPath`) is refused (`CannotBindSelf`). Each exe may be bound to only one theme (`AppAlreadyBind`). The app picker is a file dialog filtered to `["exe"]` (`STY:39810-39840`).

### 4.2 Bridge functions
| Function | Location | Behaviour |
|---|---|---|
| `Theme_Add(themeName, param)` | `ThemeOper.cs:41-71` | `param` = JSON `[{BindAppFilePath,BindAppIconPath}]`. Errors: 2 invalid name, 4 exists, 8 "param Not Exist" (no listed file exists). Creates the theme, moves icons, saves |
| `Theme_UpdateBindApp(themeName, param)` | `SO:3080-3083` → `ThemeOper.cs:134-152` | Replaces `BindAppInfos`. Error 7 if the theme `IsDefault`, 3 if missing, 8 if no file exists. Entries whose file does not exist are dropped (`ThemeOper.cs:154-178`). Old icons of removed apps are deleted |
| `Theme_SwitchApp(themeName)` | `SO:3054-3059` | `Theme_Switch(themeName)` (profile = the theme's `SelProfileName`), then `EventSystem.SendEvent(EVT_Com.ThemeSwitchApp)`. That event is only consumed by `RongYuanMouse_Oper` (`RongYuanMouse_Oper.cs:491`), which is irrelevant here |
| `Comm_GenAppIcon(appPath)` | `SO:694-697` → `GlobalOper.cs:134-146` → `AppUtil.GetIcon` (`Zeasn.Win.Lib/Zeasn.Win.Lib/AppUtil.cs:183-235`) | If the file exists: `PrivateExtractIcons(path, 0, 256, 256, …)` and save the first icon as PNG to `%TEMP%\EvniaServe\<timestamp>.png` (`PathBase.PATH_APP_TEMP`). Returns that path, or `""` |

Renderer wrappers: `STY:33641-33700` (`themeBindApp` sends `JSON.stringify(list.map(e => ({BindAppFilePath: e.path, BindAppIconPath: e.icon})))`).

### 4.3 `CheckTopApp` algorithm (`SO:3295-3345`, helper `smethod_21` `SO:3347-3362`)
```
every 1 s (after device scan):
  h = GetForegroundWindow()                               // CWinSysGetWnd.cs:21-22
  if h == 0 or h == lastHwnd: return
  lastHwnd = h
  GetWindowThreadProcessId(h, out pid)                    // CWinSysGetWnd.cs:60-61
  if pid == 0: log "curProcessId is Zero!"; return
  p = Process.GetProcessById(pid)
  if p.ProcessName == lastProcessName: return
  lastProcessName = p.ProcessName
  if p.ProcessName in {"electron","Precision Center"}: return   // self-exclusion (see bug below)
  exe = QueryFullProcessImageName(OpenProcess(0x1000 /*PROCESS_QUERY_LIMITED_INFORMATION*/, false, pid), 0)
                                                           // CWinSysGetWnd.cs:87-111, AppUtil.cs:257-261
  target = first ThemeInfo whose BindAppInfos has BindAppFilePath == exe (OrdinalIgnoreCase) ; else "User"
  if currentTheme.Name != target:
      push Notification { FunctionName:"NotifyUISwitchTheme", Tag: target }   // no "|profile"
  on exception: lastHwnd = 0
```
- The deobfuscated source shows `Notification_Func.const_2`. That name is an **artifact of the deobfuscator**. The original obfuscated assembly has `NotifyUISwitchTheme` (`work/dotnet/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/Notification_Func.cs`). Likewise `const_7` = `NotifyMouseDPIChange`.
- **The backend does not switch by itself.** The renderer receives the notification (`MAINR:1917-1927`). It fires a synthetic `mousedown` on `<body>` to close popups, splits `Tag` on `|`, and then:
  - Tag has a profile part: calls `Theme_Switch(theme, profile)`.
  - Otherwise: calls `Theme_SwitchApp(theme)`.
  - Then it stores the active theme, emits `refreshDeviceData` and shows the toast `ProfileActived`.
  The same notification is used for hardware profile-cycle keys, with Tag `"theme|profile"` (`SO:3215-3226`).
- `Theme_Switch` (`SO:3016-3052`) returns early if theme and profile are unchanged. Otherwise it applies the profile to **every connected device**. The display always gets a full `ParameterToDevice(..., apply=true)` (`SO:3085-3112`), so every app switch re-sends many DDC writes (see the DDC report).
- Vendor bug (INFERRED): the self-exclusion list is `{"electron","Precision Center"}`, but the shipped process is `Evnia Precision Center.exe`, whose ProcessName is `Evnia Precision Center`. Focusing the Precision Center window while a bound-app theme is active therefore resolves to "User" and switches back.
- The fallback is the **hard-coded** theme name `"User"`, not "the theme with `IsDefault`".

### 4.4 Linux equivalents
Getting the executable path of the focused window:

| Session | Mechanism | Gives PID? | Notes |
|---|---|---|---|
| X11 (any WM) | Root property `_NET_ACTIVE_WINDOW` (subscribe `PropertyNotify` on root) → window `_NET_WM_PID` (or XRes `XResQueryClientIds` for reliability) + `WM_CLASS` | Yes | Event-driven; then `readlink /proc/<pid>/exe` |
| KDE Plasma 6 (KWin Wayland) | Load a KWin script via D-Bus `org.kde.KWin /Scripting loadScript`; in the script `workspace.windowActivated.connect(w => callDBus("<our.service>", "/", "<iface>", "ActiveWindow", w.pid, w.resourceClass, w.caption))` | Yes | Plasma 5 uses `workspace.clientActivated` / `activeClient` |
| GNOME (Mutter Wayland) | No public API; needs a small Shell extension exposing `global.display.focus_window.get_pid()` / `get_wm_class()` on D-Bus (INFERRED: existing third-party extensions do this) | Via extension | `org.gnome.Shell.Eval` has been disabled since GNOME 41 |
| Hyprland | IPC socket `$XDG_RUNTIME_DIR/hypr/$HIS/.socket2.sock` events `activewindowv2>>ADDR`; query `hyprctl -j activewindow` → `pid` | Yes | |
| sway / i3 | i3-ipc `subscribe ["window"]`, `change:"focus"` → `container.pid`, `app_id` | Yes | |
| Other wlroots | `zwlr_foreign_toplevel_manager_v1` → `app_id`, `title`, `state` includes `activated` | **No PID** | Bind by `app_id` → `.desktop` ID instead of by exe path |
| Flatpak/Snap apps | `/proc/<pid>/exe` resolves to a path inside the sandbox | — | Prefer binding by app ID (`.desktop` file ID) and keep the exe path as a secondary key |

- **Binding format recommendation:** extend `BindAppInfo` with `AppId` (the `.desktop` ID or `WM_CLASS`/`app_id`). Match on `AppId` first, then on `BindAppFilePath` (the `readlink /proc/<pid>/exe` result).
- **Icons (`Comm_GenAppIcon`):**
  - Resolve the `.desktop` entry's `Icon=` through the freedesktop icon-theme spec (GIO `g_desktop_app_info_get_icon` + `GtkIconTheme`, or a JS/Python icon-theme resolver).
  - Render a 256 px PNG to `$XDG_CACHE_HOME/evnia/tmp/<ts>.png` and keep returning the path.
  - Replace the renderer's `["exe"]` file filter with a `.desktop` / application chooser.
- Move the switch decision **into the backend**: call `Theme_Switch` directly and notify the UI afterwards. That way it works while the window is closed. On Windows it depends on the renderer being connected.

---

## 5. Global hotkeys, modifier interception, mouse hook: `InputEventManager` (CONFIRMED dead in 1.13.0)

File: `work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib.HotKeyMgr/InputEventManager.cs`. Win32 wrappers are in `Zeasn.Win.Lib/Zeasn.Win.Lib.Input/InputWinApi.cs`.

| Element | Detail |
|---|---|
| Thread | `Start()` (`:513-551`) creates a background thread "InputEventManagerThread" running a message loop (`method_29`, `:1681-1752`). It installs **WH_MOUSE_LL (14)** (`:1128-1135`) and **WH_KEYBOARD_LL (13)** (`:1027-1034`) hooks, then pumps `GetMessage`. Thread messages: `0x0312` WM_HOTKEY → `method_4(wParam=id)`; `0x8001` run queued work; `0x8002` stop |
| Hotkey register | `method_1` (`:830-863`): `RegisterHotKey(NULL, id++, mods, vk)` with `mods` = ALT 0x1, CTRL 0x2, SHIFT 0x4, WIN 0x8, plus **MOD_NOREPEAT 0x4000** (`smethod_0` `:899-923`). Error 1409 = ERROR_HOTKEY_ALREADY_REGISTERED → "Key combination already occupied" |
| Hotkey fire | `method_4` (`:925-945`): sends a synthetic key-**up** for the hotkey's VK (`CWinInputHelper.SendInputKeyEvent(vk, 2 /*KEYEVENTF_KEYUP*/)`), then queues the callback (5000 ms timeout, queue limit 1024) |
| Occupied probe | `IsHotkeyOccupied` (`:736-759`): tries `RegisterHotKey` with a negative id **without** NOREPEAT; on failure returns `true`, otherwise unregisters and returns `false`. Exposed as Bridge `GetHotKeyState(keyCode, alt, ctrl, shift, win)` (`SO:1092-1099`). The display's `CheckHotKeyBind` is checked first but always returns `false` |
| Modifier interception | Keyboard hook `method_7` (`:1041-1073`). Active only while `ModifierKeyInterceptEnabled` is set (Bridge `ModifierKeyListenerEnable(bool)`, `SO:699-704`). Ignores injected events (`KBDLLHOOKSTRUCT.flags & 0x10`). For WM_KEYDOWN/WM_SYSKEYDOWN (0x100/0x104) and KEYUP/SYSKEYUP (0x101/0x105) on VK 16–18, 91–92, 160–165 it **swallows the key** (returns 1) and pushes Notification `ModifierKeyListener` with `Tag = {DeviceType: Unknown, Data: {Key: <System.Windows.Forms.Keys name, e.g. "LShiftKey">, IsDown: bool}}` (`:1075-1099`) |
| Mouse hook | `method_10` (`:1142-1180`). Never swallows. Ignores injected events (`flags & 1`). Supports `MouseButton` {Left, Right, Middle, XButton1, XButton2} × `MouseEventType` {Click, DoubleClick, LongPress, LongPressRelease, Down, Up} |

**Why this is dead code:**
- `Start()` is never called anywhere. The only references are `SO:701`, `SO:1098` and `CDevice_PHLDisplay.cs:1389,1397`, checked in both `work/dotnet-clean` and `work/dotnet`. Hooks are therefore never installed, and `RegisterHotKey` would throw "not started".
- `CDevice_PHLDisplay` hotkey methods are stubs **in the shipped binary too**: `GetHotKeyData`, `SetHotKeyEnable`, `SetHotKeyItemEnable`, `SetHotKey`, `DeleteHotKey`, `EnableGamePQMouseKey` and `SetGamePQMouseKeyBind` return `Succ()`; `CheckHotKeyBind` returns `false`; the callback `method_20` is empty (`CDevice_PHLDisplay.cs:1350-1420`; obfuscated `work/dotnet/.../CDevice_PHLDisplay.cs:6233-6364`). `GetHotKeyMenu` returns the static `HotKeyItems`.
- The renderer contains **no** call to any of `ModifierKeyListenerEnable`, `GetHotKeyState`, `PHL_*HotKey*`, `NotifyHotKeyExecute` or `ModifierKeyListener` (grep over `work/app`).
- No hotkey activity appears in the user's logs.

**Linux:** DROP. Keep Bridge stubs that return the same values as Windows (§13). If a future version needs global hotkeys:
- X11: `XGrabKey` on root. Register 4 variants for NumLock/CapsLock masks. The "occupied" probe is `BadAccess`.
- Wayland: `org.freedesktop.portal.GlobalShortcuts` (CreateSession/BindShortcuts; the user confirms in a DE dialog; no occupancy probe possible). Supported on KDE Plasma ≥ 5.27 and Hyprland; GNOME only in recent releases (INFERRED).
- Avoid raw evdev (`/dev/input/event*`; needs the `input` group, and `EVIOCGRAB` steals the whole device).
- Modifier capture for key-recording UIs should use DOM `keydown`/`keyup` in the focused renderer.

---

## 6. Wi-Fi list: `GetWifiList` (CONFIRMED)

### 6.1 Purpose
Its only consumer is the Matter BLE pairing dialog (`AMB:5794-5807`, `ve()`). A BLE-commissioned Wi-Fi bulb must be handed the SSID and passphrase of the network to join. The dialog pre-selects the currently connected SSID and pre-fills its **stored passphrase**. While the dialog is in the "choose Wi-Fi" state it re-calls `GetWifiList` **every 8 s** (`AMB:5808-5811`, `ge()`). The renderer wrapper drops entries with an empty SSID (`STY:29943-29956`).

### 6.2 Implementation (`SO:316-345`)
```
GetWifiList():
  NativeWifi.ScanNetworksAsync(10 s)                       // ManagedNativeWifi 2.8.0 -> wlanapi WlanScan
  connected = EnumerateInterfaceConnections() where IsConnected && ProfileName != ""   // -> ProfileName list
  for each AvailableNetworkPack in EnumerateAvailableNetworks():   // dedup by SSID
      WifiItem { Ssid, SignalQuality (0..100), IsSecurityEnabled, IsConnect = SSID in connected }
      wifiItem.Password = KlFcemDmw(Ssid)                  // read stored passphrase (see below)
  return list
```
- `WifiItem` (`Zeasn.PCenter.Entity.Lib/.../System/WifiItem.cs`): `Ssid`, `SignalQuality:int`, `IsSecurityEnabled:bool`, `IsConnect:bool`, `Password:string`.
- ManagedNativeWifi is emoacht's library v2.8.0 (`ManagedNativeWifi/Properties/AssemblyInfo.cs`), using `wlanapi.dll` `WlanScan` / `WlanGetAvailableNetworkList` / `WlanQueryInterface` (`ManagedNativeWifi/ManagedNativeWifi.Win32/NativeMethod.cs:647-671`).

### 6.3 Passphrase read: `KlFcemDmw` (`SO:346-375`) — do not reproduce on Linux
For every SSID the backend runs:
```
cmd.exe /c chcp 437 && netsh wlan show profile name="<SSID>" key=clear
```
and scans stdout for a line starting with one of `"Key Content"`, `"关键内容"`, `"關鍵內容"`, `"金鑰內容"` (`SO:52`), returning the text after the colon.

Two things the Linux port must avoid:
1. **Shell/argument injection surface.** The scanned SSID (attacker-influenced beacon data) is interpolated into a `cmd.exe /c` string. A reimplementation must read network credentials through a typed API, never by building a shell command from an SSID.
2. **Credential disclosure over the network.** `WifiItem.Password` (the clear-text passphrase) is serialized into the `GetWifiList` result and sent over SignalR. The backend binds `http://*:10010` with permissive CORS (`EvniaServe/Evnia/Startup.cs:35-80`), so this is not localhost-only. See §11.

### 6.4 Linux verdict
- If Matter (§7) is **dropped**, `GetWifiList` is dropped entirely.
- If Matter is **kept**, replace it with a credential-free network list and let the user type the passphrase, or fetch it only with explicit consent:
  - **NetworkManager** (D-Bus `org.freedesktop.NetworkManager`): `GetAllDevices` → wifi device → `RequestScan({})`, then `GetAllAccessPoints` → per-AP `Ssid` (bytes), `Strength` (0–100, maps to `SignalQuality`), `WpaFlags`/`RsnFlags` (→ `IsSecurityEnabled`), and the active connection for `IsConnect`.
  - Reading a saved PSK requires `org.freedesktop.NetworkManager.Settings.Connection.GetSecrets("802-11-wireless-security")`, which prompts through the agent and needs the user's authorization. Prefer prompting the user for the passphrase in the dialog instead of auto-reading it.
  - **iwd** (`net.connman.iwd`, D-Bus): `Station.GetOrderedNetworks`, `Station.Scan`.
- Return shape stays `{Ssid, SignalQuality:0..100, IsSecurityEnabled, IsConnect, Password}`; on Linux leave `Password` empty and require the user to enter it.

---

## 7. Matter smart bulbs — "AmbiScape" / the "Bulb" device (CONFIRMED)

This is the largest Windows-independent subsystem and the only one that reaches the internet at setup time. It is a separate optional device shown as "Bulb" and is only offered when a Philips monitor is connected.

### 7.1 Process architecture
```
renderer (Vue)  --window.ipc.invoke-->  Electron main (class Uv/zv, MAIN:16826-17080)
   |                                        |  spawn  node.exe control.mjs  (one process per bulb "uniqueId")
   |  window.ipc.on("matterNotification")   |  <-- stdout "[Pending] [Init|Reply|Notification] <json>"
   |                                        |  --> stdin  {"requestId","code","type","payload"}\n
```
- Node process manager `class zv` (`MAIN:16833-16882`): `checkNodeAvailable()` returns true only if `%APPDATA%\evnia\Matter\node.exe` exists (`MAIN:16827` `Av`, `Lv`). `createProcess(id, args)` spawns `node control.mjs --location=%APPDATA%\evnia\Matter\Controller <args>`, cwd = node dir, `windowsHide:true`, one child per `uniqueId` in a `Map` pool (`MAIN:16888-16918`). `destroyProcess` kills it (falls back to `taskkill /PID <pid> /T /F`).
- Controller `class Uv` (`MAIN:16884-17080`): registers the IPC handlers (`MAIN:17004-17053`), parses stdout lines beginning with `[Pending] [<tag>] <json>` (`handleStdOut` `MAIN:16973-16999`), and forwards `Notification` frames to the renderer as `webContents.send("matterNotification", …)`. Requests are correlated by a UUID `requestId` with a 60 s timeout, written to the child's stdin as one JSON line (`sendRequest` `MAIN:17056-17072`).
- Script location (`MAIN:16831`): packaged → `resources/matter/control.mjs`; it exists in the install at `Evnia Precision Center/resources/matter/control.mjs` (1.8 MB; the pretty copy is `MCJ`). Its only bundled node_module is `debug`; BLE deps are loaded dynamically (below).

### 7.2 The Node runtime is a downloaded cloud plugin (ONLINE)
- `checkNodeAvailable` requires `%APPDATA%\evnia\Matter\node.exe`. It is **not shipped**; the folder does not exist on the user's machine, and the log shows nothing Matter-related. If missing, the constructor logs "Node not found, please install node 18 or higher" (`MAIN:16842`).
- The AmbiScape page downloads it: `Mv({deviceType:"EVNIA_Plugins", componentId:"EVNIA_AmbiScape_NODE_1801200", version:"0"})` (`STY:35140`), i.e. a component-update query to `deviceportal.zeasn.tv/direct/component/update` (`Mv` `STY:33075-33110`; base `bf.PROD.portalDomain`, `STY:30674-30684`), then downloads and extracts the archive to `%APPDATA%\evnia\Matter` (`ipcExtract` → `extractZip`, `MAIN:17535`). See the online report for the full portal contract.
- **Linux:** the equivalent is a Node ≥ 18 runtime. Options, in order: (a) require system `node` (`which node`, check `--version` ≥ 18); (b) ship Node in the package; (c) run the Electron binary as Node via `ELECTRON_RUN_AS_NODE=1`. Do **not** replicate the cloud download of a runtime; either bundle it or use the system one. `checkNodeAvailable` becomes "is a suitable node on PATH / bundled".

### 7.3 CLI contract of `control.mjs` (CONFIRMED, `MCJ:72181-72302`)
Flags parsed via matter.js env (`MCJ:72181-72205`):

| Flag | Meaning |
|---|---|
| `--location=<dir>` | storage root (`%APPDATA%\evnia\Matter\Controller`) |
| `--ble` | enable BLE transport for this run |
| `--discover` | discovery-only mode (used by `discoverBulb`) |
| `--qrCode=<str>` | Matter QR payload `MT:...` |
| `--matterCode=<str>` | 11-digit manual pairing code |
| `--wifiSsid=<str>` / `--wifiCredentials=<str>` | network to provision the device onto |
| `--uniqueId=<str>` | controller identity / storage namespace |
| `--ble.hci.id=<n>` | HCI device index (INFERRED: maps to Linux `hciN`) |

Modes:
- **Discover** (`discoverBulb`, `MAIN:16919-16937`): `--ble --discover (--qrCode|--matterCode)`. `class ER` decodes the QR (`El.decode`) or manual code (`Lc.decode`) to `{longDiscriminator|shortDiscriminator, vendorId, productId, passcode}`, tries commissionable discovery over Wi-Fi then BLE (`ER.discover`/`doDiscover`, `MCJ:71411-71446`), and prints one `[Init]` line `{state:"ble"|"wifi"|"error", success, data|error}`. 50 s watchdog.
- **Pairing/commission** (`pairingBulb`, `MAIN:16938-16960`): `(--ble) (--qrCode|--matterCode) --wifiSsid=<> --wifiCredentials=<> --uniqueId=<>`. Runs `handleControl` → `class RR` (`MCJ:71710-72119`). **Note: the Wi-Fi passphrase is passed as a command-line argument** and the process logs the parsed flags including `wifiCredentials=` (`MCJ:72193-72205`); on Linux prefer feeding secrets on stdin, not argv (argv is world-readable via `/proc/<pid>/cmdline`).
- **Control** (`commissionBulb`, `MAIN:16893-16918`): `--uniqueId=<>` only. Reconnects to an already-commissioned node and then serves interactive requests on stdin.

Interactive stdin request types (`Y_`, `MCJ:72242-72301`): `identify {endpointId, identifyTime}`, `getAttribute {endpointId, attributeName}`, `setAttribute {endpointId, attributeName, value, transitionTime}` (attributeName `HSV` is special-cased), `openCommissioningWindow {commissioningTimeout}`, `remove`, `clearStorage`. Replies: `[Reply] {requestId, success, errorMessage, data}`. Async pushes: `[Notification] {uniqueId, endpointId, type, data}`.

### 7.4 Matter protocol details (CONFIRMED)
- Library: **matter.js 0.9.1** (`MCJ:58289`), `@matter/main` env API.
- Device types handled (`MCJ:71374-71379`, `cy`): `root` (0x0016 = 22), `aggregator` (0x000E = 14; a Matter bridge), `extendedColorLight` (0x010D = 269). Anything else → "Unsupported device type" (`saveRootEndpoint`, `MCJ:71834-71872`).
- Clusters used on each bulb endpoint (`class uy` `MCJ:71451-71709`): Identify (0x0003), OnOff (0x0006), LevelControl (0x0008), ColorControl (0x0300). Bridge endpoints read BridgedDeviceBasicInformation (0x0039) for `NodeLabel`/`Reachable`; root reads BasicInformation (0x0028) for `ProductName`/`NodeLabel`.
- Feature discovery via FeatureMap: LevelControl.`lighting` → brightness support; ColorControl.`colorTemperature` and `hueSaturation`. Ranges pulled from `MinLevel`/`MaxLevel` (default 1..254) and `ColorTempPhysicalMin/MaxMireds` (default 153..370).
- Value scaling (`Ko` / `Vm`): brightness and colour-temp are exposed to the UI as 0–100 %, hue as 0–100 (device 0–254), saturation 0–100 (0–254). `moveToLevel` / `moveToColorTemperature` / `moveToHue` / `moveToSaturation` / `moveToHueAndSaturation` carry `transitionTime`. Every set first calls `ensureOn()`.
- Transports (`configureNetwork` / BLE loaders):
  - **Operational:** IPv6 UDP + **mDNS** service discovery `_matterc._udp.local` (commissionable) / `_matter._tcp.local` (operational), multicast `ff02::fb`, port 5353 (`MCJ:52988-53041`). A network-interface monitor restarts the controller on IPv6 scope changes (`G_`/`YD`, `MCJ:72122-72158`).
  - **BLE (commissioning only):** loaded via `createRequire` — `@stoprocent/bleno` (peripheral) and `@stoprocent/noble` (central) (`MCJ:67380-67385`, `MCJ:67903-67910`). These are Node native BLE bindings; on Windows they use WinRT. `BLENO_HCI_DEVICE_ID` / `NOBLE_HCI_DEVICE_ID` are set from `--ble.hci.id`.

### 7.5 Does it touch the cloud / DCL? (CONFIRMED: no)
- The only URL in `MCJ` is a comment string `https://project-chip.github.io/connectedhomeip/qrcode.html` (`MCJ:58144`); there is no `fetch`, `https`, `http`, DCL, PAA fetch or CSA endpoint in the script.
- Device attestation is requested from the device and checked only for **presence** (non-empty DAC/PAI/attestation elements), not verified against a trust store: `#g()` throws only "Device Attestation data missing from device" (`MCJ:51361-51378`). The controller generates its own root CA and NOC locally (`#S()`, `MCJ:51380-51407`).
- Commissioning uses `regulatoryCountryCode:"XX"` and `IndoorOutdoor` (`MCJ:71788`). Fabric label is stored as `"Precision Center"` (`MCJ:71757`).
- Persistent state lives under `%APPDATA%\evnia\Matter\Controller\<uniqueId>_controller` (matter.js storage). `clearCache` (`MAIN:17036-17053`) deletes these dirs.

So the Matter runtime itself is **fully local**. The only online dependency is downloading the Node runtime plugin (§7.2) and the AmbiScape UI plugin bundle (§7.6).

### 7.6 AmbiScape UI is itself a downloaded plugin (ONLINE)
- The "Bulb" page (`renderer/assets/Bulb-vdvqR6Jj.js`) immediately routes to `Bulb_AmbiScape`. `bulbEnabled` is a per-machine flag persisted in the Electron store key `ambiScapeEnable` (default **false**, `MAIN:9171`, and `evnia/config.json` shows `"ambiScapeEnable": false`). The device tile is only enabled once the AmbiScape node plugin has been downloaded and extracted (`AMB` `AmbiScape` component `STY:35110-35180`).
- Gating (`STY:44601-44646`, `MAINR:2098-2110`): the Bulb device requires `hasMonitor` (any connected Philips monitor) **and** `bulbEnabled && checkNodeAvailable().available`.
- Paired-bulb list is stored client-side in `localStorage["bulbListStore"]` (`STY:35062-35070`); the backend `EvniaServe` has no knowledge of bulbs.

### 7.7 Multi-admin share codes (CONFIRMED)
The UI can open a commissioning window on an already-commissioned bulb for a second ecosystem: `openCommissioningWindow(uniqueId, timeout)` → child `openCommissioningWindow` → `node.openEnhancedCommissioningWindow` (`MCJ:71856`, `MCJ:72030`), returning `manualPairingCode` + `qrPairingCode` shown to the user (`AMB:7656-7671`). Local Matter feature; no cloud.

### 7.8 Linux port plan for Matter
| Concern | Windows | Linux |
|---|---|---|
| Runtime | downloaded `node.exe` | system Node ≥ 18, bundled Node, or `ELECTRON_RUN_AS_NODE=1` |
| Spawn | `child_process.spawn(node, [control.mjs, --location=…, …])` | identical; keep the stdin/stdout line protocol unchanged |
| Storage | `%APPDATA%\evnia\Matter\Controller` | `$XDG_DATA_HOME/evnia/Matter/Controller` |
| BLE (commissioning) | `@stoprocent/{bleno,noble}` (WinRT) | same packages use **BlueZ** on Linux (needs `bluetoothd`, adapter access; may need `setcap cap_net_raw` or the `bluetooth` group). Alternatively skip BLE and commission over IP only, or shell out to `chip-tool` |
| mDNS/operational | UDP6 + 5353 multicast | identical; ensure Avahi/mDNS is not conflicting on 5353 (matter.js opens its own socket, so avoid duplicate binds) |
| Secrets | Wi-Fi passphrase on argv (logged) | pass via stdin JSON instead; never log it |
| HCI selection | `--ble.hci.id` → WinRT radio | `--ble.hci.id` → `hciN` |

Because control.mjs is standard matter.js and self-contained, the port is mostly: provide Node, adjust the storage path, and wire BlueZ. The renderer IPC surface stays byte-for-byte the same.

---

## 8. Screen → bulb colour sync ("Follow Video" for AmbiScape) (CONFIRMED)

- `AmbiScape_EnableFollowVideo(bool enable, int timeInterval)` (`SO:377-382`) turns on `AmbiScapeOper` and the follow-video capture timer. Renderer: `setBulbAmbiScape(enable, ms=500)` → `AmbiScape_EnableFollowVideo(enable, enable?ms:0)` (`STY:8672-8674`).
- `AmbiScapeOper` (`Zeasn.Equipment.Option.Lib/.../AmbiScapeOper.cs`): on each `EVT_Effect.Effect_VideoData` (a captured desktop `Bitmap`), if enabled and ≥ `timeInterval` ms since the last emit, it computes a 8×6 grid via `ScreenCaptureMgr.CalcRGBs(8, 6, bmp)` and maps 10 edge zones (T, R1–R4, B, L1–L4) to averaged RGB. It pushes Notification `NotifyAmbiScapeFollowVideoData` with those 10 colours (`AmbiScapeOper.cs:45-103`). Default interval 2000 ms; the UI passes 500 ms/100 ms.
- `ScreenCaptureMgr.CalcRGBs` (`Zeasn.PCenter.Base.Lib/.../ScreenCaptureMgr.cs:147-204`): GDI `CaptureScreen`, `LockBits`, supports 24bpp/32bpp, averages each cell; byte order read as BGR → returns RGB.
- Renderer consumer (`MAINR:2150-2195`): subscribes `NotifyAmbiScapeFollowVideoData`; for each linked online bulb converts the zone RGB to HSV (tinycolor) and calls `setBulbAttribute(uniqueId, endpointId, "HSV", {H,S[,V]})`; very dark cells (`R,G,B < 13`) send `HSV(1,1,5)` (near-off). Zones map to bulbs via `ambiScapeLinkTo` (10 slots T/R1-4/B/L1-4).
- **Linux:** screen capture must be replaced (GDI is Windows-only):
  - Wayland: `org.freedesktop.portal.ScreenCast` + PipeWire, then downscale to the 8×6 grid. This shows a portal consent dialog and, on some compositors, a screencast indicator.
  - X11: XShm/`XGetImage` on the root window (works on Xorg; not XWayland-restricted).
  - KDE also offers `org.kde.KWin.ScreenShot2`.
  - Keep the same 10-zone averaging and the same `NotifyAmbiScapeFollowVideoData` payload so the renderer is unchanged.
- This is only meaningful if Matter bulbs (§7) are kept. The monitor's own Ambiglow "Follow Video" is a separate hardware feature handled by the display firmware (see the Ambiglow report), not this code.

---

## 9. SmartDesktop = repackaged PowerToys FancyZones (CONFIRMED)

"Smart Desktop" (`Monitor › nav_smart_desktop`, always shown, `MAINR:318-323`) is a thin manager over Microsoft PowerToys FancyZones, redistributed by the vendor.

### 9.1 Assemblies
- `Zeasn.FZ32.Interop` = a fork of PowerToys' FancyZones interop (P/Invoke into `FancyZonesExtend.dll`, settings model). `FancyZonesController` (`.../FancyZonesController.cs`) P/Invokes `Enable`/`Disable`/`GetConfig`/`SetConfig`/`GenerateEditorParameter`/`StartFancyZonesEditor` from `modules/FancyZones/FancyZonesExtend.dll`.
- `Zeasn.FZ32.Lib` = PowerToys settings serialization (`Zeasn.FZ32.Lib.FancyZones`, `Zeasn.FZ32.Lib.PowerToys`).
- Settings JSON key names are verbatim PowerToys (`fancyzones_shiftDrag`, `fancyzones_zoneHighlightColor` `#0078D7`, `fancyzones_editor_hotkey` Win+Shift+\`, etc.; `GClass0.cs:15-630`, `ConfigDefaults.cs`).

### 9.2 Runtime files and orchestration
- `FancyZonesOper` (`Zeasn.Equipment.Option.Lib/.../FancyZonesOper.cs`), initialised on first hub connect (`EvniaHub.cs:42`):
  - persistent data `%APPDATA%\SmartControl\SmartDesktop.data` (`string_0`), user's file `{"FancyZonesSettings":null,"Enable":true}`.
  - module dir `%APPDATA%\SmartControl\Modules\SmartDesktop`; binaries `modules\FancyZones\PowerToys.FancyZones.exe` and `PowerToys.FancyZonesEditor.exe`.
  - `PowerToys.FancyZones` settings live at `%LOCALAPPDATA%\Microsoft\PowerToys\FancyZones\settings.json` (`FancyZonesSettingsController.cs:10`, `Zeasn.FZ32.Lib/Class0.cs:10`) — **the genuine PowerToys path**, shared with a real PowerToys install.
  - `EnableFancyZones(true)` = launch `PowerToys.FancyZones.exe`; `EnableFancyZones(false)` = `ProcessUtil.KillProcess("PowerToys.FancyZones")`, which kills **every** process of that name (`ProcessUtil.cs:142`).
  - `StartFancyZonesEditor()` writes `editor-parameters.json` (monitor geometry, `EditorParameters.cs`) then runs the editor exe and waits.
  - `GetFancyZonesVersion()` reads `FileVersionInfo` of the exe; returns `V0.0.0.0` when not installed. User's log shows the exe is absent: "不存在程序 …\PowerToys.FancyZones.exe" (`EvniaServe/logs/2026-09-26.txt:7`).
- Download/install UI (`SmartDesktop-By8ZEPkl.js:45-140`): component-update query for `{deviceType:"SmartDesktop", componentId:"Philips_SmartDesktop"}` to the portal, download the zip, `extractZip`, then `runCommand('"<installer>" /targetDir "%APPDATA%\\SmartControl\\Modules\\SmartDesktop"')`.

### 9.3 Bridge surface
`FancyZones_Enable(bool)`, `FancyZones_StartEditor()`, `FancyZones_GetVersion()`, `FancyZones_GetData()`, `FancyZones_SetSetting(name, value)` (`SO:1901-1925`). The renderer only ever toggles enable, launches the editor, reads version/data, and flips `FancyzonesShiftDrag` (`STY:33604-33639`).

### 9.4 Concerns for a Linux port
- FancyZones is a Windows desktop window-tiling tool; it does nothing for the monitor. It is unrelated to the 34M2C8600.
- The install path shares state with real PowerToys and kill-by-name could terminate a genuine PowerToys FancyZones. Reason enough not to port as-is.
- **Linux:** DROP. If desktop tiling is wanted, expose the concept through native tools instead of shipping a binary:
  - KWin: built-in custom tiling (Meta+T editor) and tiling scripts; settings via `kwriteconfig6`.
  - GNOME: extensions (Tiling Assistant / Forge / gTile) — cannot be driven headlessly in a portable way.
  - wlroots: sway/Hyprland are already tiling.
  - Minimal parity: keep `FancyZones_*` as stubs returning `Enable:false`, `V0.0.0.0` so the renderer's Smart Desktop page shows "not available", or hide the nav item on Linux.

---

## 10. DTS headset audio (CONFIRMED — not applicable to this user)

### 10.1 What it controls
`DTS_*` targets only USB headsets of type `PHL_CDeviceTAG4106` (DeviceType 500000) and `PHL_CDeviceTAG5106` (500001): USB **VID 0x25AA (9642)**, PID **0x6002 (24578)** / **0x6003 (24579)** (`resources/bin/res/data/PCenter_DeviceInfo.json`, entries "TAG4106"/"TAG5106"). The user owns none of these (their HID devices are unrelated third-party devices), so this whole subsystem is inert for them.

### 10.2 How it works
- `IDTS` implemented by `TAGHeadsetDTS_Oper` → `CDeviceHeadsetDTSBase` → `DtsOper` (`work/dotnet-clean/Zeasn.DTS.Lib/Zeasn.DTS.Lib/DtsOper.cs`).
- All DSP work is done by an external **`DtsServer.exe`** (DTS Sound Unbound / APO engine), located at `%APPDATA%\G-MenuDTSServe\DtsServer.exe` (`WorkspacePath.cs:24`). `DTS_Open` starts it if not already running (`DtsOper.DtsOpen`, `DtsOper.cs:98-113`); `DTS_Close` kills it. `EvniaServe` also kills `DtsServer` at startup and shutdown (`Program.cs:56`, `EvniaService.cs:14`).
- IPC is a **named pipe** `\\.\pipe\DTS` (`DtsOper.cs:37`, `DtsPipeServerOper.cs`): the backend is the client, DtsServer the server; 10 KiB UTF-8 buffer, JSON `MethodResult` with a `RequestStr` carrying a serialized `DtsUIStringSingle`; 10 s connect timeout.
- `DtsUIStringSingle` (`DtsUIStringSingle.cs`) fields (all get/set through the pipe): `Vid`, `Pid`, `APO`, `Rooms {ENTERTAINMENT,GAME,SPORTS}`, `StereoPreference {OFF,FRONT,WIDE,TRADITIONAL}`, `MFX_BASS_TBHDX`, `SFX_DIALOG_ENHANCEMENT`, `SFX_VIRTUALIZATION`, `SFX_LOUDNESS_CONTROL`, `MFX_HEADPHONE_EQ`, `GRAPHIC_EQ_ON_OFF`, `AutoContentMode`, `Spatial`, `CurrentOperateMode`/`CurrPreset {OFF,Music,Movie,Voice,Game1,Game2,Game3,Custom}`, 10-band `GEQ_Band_Gain`, `ExtraOperate {NULL, Toggle, ResetDTS}`.
- 10-band preset gains (`DTSDataBase.GetPresetGEQData`, `DTSDataBase.cs:120-155`), e.g. Game1 `[9,29,20,9,6,-3,8,-6,7,-7]`, Music `[-15,0,-60,0,0,0,0,-30,0,0]`. `SetAPO` plays a `dts_on_16k.wav`/`dts_off_16k.wav` cue via `winmm!PlaySound` (`CDeviceHeadsetDTSBase.cs:87-99`).
- The `DtsServer.exe` binary itself is downloaded from the portal (`Setup-daShw_PC.js:56-140`: component update for `{deviceType, componentId}` from `E.dtsData`, download, `extractZip`, then `runCommand('"<inst>" /targetDir "%APPDATA%\\G-MenuDTSServe"')`).

### 10.3 Linux
DROP for this user (no DTS headset). If ever needed for a TAG headset:
- There is no DTS APO on Linux; the closest is a **PipeWire** filter-chain graph (`libpipewire-module-filter-chain`) implementing a 10-band EQ + bass/virtualization, or EasyEffects presets. The band gains and presets above are the only reusable data; the DtsServer/APO engine and its pipe protocol have no Linux counterpart and cannot be ported. Treat DTS as out of scope.

---

## 11. Backend hosting, CORS and reachability (CONFIRMED — context for §6)

- `EvniaServe` binds **`http://*:10010/`** (`Program.cs:37`, and the user's Electron log "Try start backend service … on 10010"). CORS default policy allows `app://.` and `http://localhost:10010` with `AllowAnyMethod/Header/Credentials`, plus a `https://*:10010` credentialed policy (`Startup.cs:39-80`). SignalR hub `/EvniaHub`, method `GetTaskAsync(json)`; results/notifications broadcast to **all** clients via `Clients.All.SendAsync("GetTaskAsync"/"Notification", …)` (`EvniaHub.cs:62-66`, `HandleEvent.cs:89-101`).
- Because it binds all interfaces and broadcasts to every connected client, any function that returns secrets (notably `GetWifiList`'s clear-text passphrases, §6) is exposed to other hosts that can reach TCP 10010, and any connected client sees another client's notifications.
- **Linux port hardening (recommended regardless of features kept):** bind `127.0.0.1:10010` (or `[::1]`) only; or replace the TCP SignalR transport with a Unix domain socket under `$XDG_RUNTIME_DIR` with `0600`. Never return credentials over this channel. This is the Kestrel `UseUrls("http://127.0.0.1:10010")` change plus dropping `Password` from `WifiItem` on Linux.

---

## 12. Autostart, elevate, and the rest of Zeasn.Win.Lib

### 12.1 Autostart (CONFIRMED)
- App-level, the live mechanism: Electron `setAutoStartUp(open, minimized)` → `app.setLoginItemSettings({openAtLogin, args:[minimized?"--openAsHidden":""]})` (`MAIN:17397-17405`). Store keys `autoStartup` (default true), `autoStartupMinimize` (default true) (`MAIN:9155-9156`; `evnia/config.json` shows both true). `--openAsHidden` makes the window start hidden and delays the backend 10 s (`MAIN:17262`, `MAIN:13485`). UI: Settings › General (`STY:29979-29995`).
- `CWinSysRegister.SetMeStart` (HKLM `…\CurrentVersion\Run`, `Zeasn.Win.Lib/Zeasn.Win.Lib/CWinSysRegister.cs`) is **dead** (no caller in either build).
- **Linux:** write an XDG autostart file `~/.config/autostart/evnia.desktop` with `X-GNOME-Autostart-enabled=true`; encode "start minimized" as an `--openAsHidden` `Exec=` arg (unchanged semantics). `app.setLoginItemSettings` is a no-op on Linux in Electron, so implement this explicitly.

### 12.2 elevate.exe (CONFIRMED)
- `work/native/elevate.exe` is Johannes Passing's "Elevate" 1.0.0.2894, 2007 (strings at `.symbols.txt:275-293`, "(c) 2007 - Johannes Passing"). It does `ShellExecuteExW(lpVerb="runas", nShow=0)` on `argv` (`elevate.exe.c:373-397`), i.e. a UAC re-launch helper; `-wait` waits, `-k` runs through `%COMSPEC%`. Its own manifest requests `asInvoker` (it relies on `runas`, not an embedded high IL).
- Only user: the self-updater's `packageInstall` (`MAIN:16734-16755`) spawns `resources/elevate.exe <installer> --updated --force-run` when it cannot create a temp dir next to the exe (i.e. install dir needs admin). Otherwise it runs the installer directly.
- **Linux:** DROP. There is no `runas` and the update flow is different anyway (packages update through the distro). If the port ever needs privilege elevation, use `pkexec`/Polkit with an action file, or run installs unprivileged in `$HOME`. See the electron-main report for the updater.

### 12.3 Other Zeasn.Win.Lib helpers (map for other reports)
`Zeasn.Win.Lib` is mostly Win32 P/Invoke glue. What is in scope here and what belongs elsewhere:

| Class | Purpose | External callers | Where covered |
|---|---|---|---|
| `CWinSysWithoutOperate` | idle ms | GlobalOper | §3 (here) |
| `CWinSysGetWnd`, `AppUtil` | foreground window, exe path, icon extraction, installed-software registry scan | SystemOper, GlobalOper | §4 (here) |
| `CWinSysRegister` | HKLM Run autostart (dead) | none | §12.1 (here) |
| `Zeasn.Win.Lib.Input/*`, `CWinInputHelper`, `WinMessageUtil` | SendInput, LL hooks, message loop | InputEventManager (dead), MacroMgr, RunMacro | §5 (here, dead); **macro/keyboard reports** for MacroMgr |
| `CWinSysInfo` | SystemParametersInfo (OS mouse/keyboard speed) | RunMacro, ScrollSpeedData, DoubleClickSpeedData | **mouse/keyboard reports** |
| `CWinSysPlaySound` | winmm PlaySound cue | DTS base | §10 (here) |
| `CWinSysDisplay`, `CWinSysDisplayHDR`, `DisplayConfig`, `DisplayDevice*`, `EDID*`, `DisplayHDRInfo`, `WhaleTV.Win.Display.Lib/*` | EnumDisplaySettings, DisplayConfig, EDID parse, HDR toggle | CDevice_PHLDisplay, ScreenCaptureMgr, GClass3 | **display/EDID/HDR reports** |
| `UsbDevice*`, `UsbUtil`, `USBHIDEnum`, `WindowsUSBAPI`, `UsbDeviceWinApi` | SetupAPI HID enumeration | SystemOper scan, all USB device libs | **USB/HID transport report** |
| `RegistryMonitor`, `RegistryUtil` | HKCU change watch | (none external) | n/a |
| `KeyboardHIDScanCode_Extension` | VK ↔ USB HID usage tables | all device data-convert libs | **keyboard/mouse reports** |
| `CSystemInfo` | WMI Win32_VideoController/OS name at startup | Program.cs | logging only |

For the ones in scope, the Linux replacements are given in the relevant section above. `CSystemInfo`'s WMI calls are pure logging (`SysInfo()`, `Program.cs:55`) and can be dropped or replaced with `/proc`/`lspci`.

---

## 13. Windows Dynamic Lighting check (CONFIRMED)

- `Effect_CheckDynamicLightingEnabled()` (`SO:1385-1388`) reads `HKCU\Software\Microsoft\Lighting\AmbientLightingEnabled` (`DynamicLghtingUtil.cs:9-18`): returns `1` on, `0` off, `-1` if the key is absent (pre-Win11-22H2).
- `Effect_OpenDynamicLightingSetting()` (`SO:1390-1394`) launches `ms-settings:personalization-lighting`.
- Used by the Ambiglow page (`Ambiglow-Dvqon39u.js:885-895`): it polls `getSystemDynamicLight()` every 2 s and, if enabled, shows a warning that Windows Dynamic Lighting may fight the app for LED control, with a button to open Settings.
- **Linux:** there is no Windows Dynamic Lighting. Stub `Effect_CheckDynamicLightingEnabled` → `-1` (so the warning banner never shows) and make `Effect_OpenDynamicLightingSetting` a no-op. If OpenRGB or a similar daemon is present and could contend for the same HID LEDs, a future version could detect it and warn analogously, but that is out of scope.

---

## Linux port plan (this area)

Priority order for a Linux build targeting the 34M2C8600:

1. **Idle → Ambiglow off (§3).** High value, self-contained. Implement idle notifications (ext-idle-notify-v1 / Mutter IdleMonitor / XScreenSaver, 1 s poll fallback) driving the same `E2 A0 19` DDC write. Fix the TickCount-wrap bug.
2. **Foreground-app themes (§4).** Implement active-window tracking per session type (X11 `_NET_ACTIVE_WINDOW`; KWin script; sway/Hyprland IPC; foreign-toplevel elsewhere). Bind by `.desktop`/app-id first, exe path second. Replace icon extraction with the freedesktop icon theme. Move the switch decision into the backend so it works with the window closed.
3. **Autostart (§12.1).** XDG autostart `.desktop`, honouring "start minimized".
4. **Dynamic Lighting check (§13).** Stub to `-1` / no-op.
5. **Hotkeys (§5).** Ship stubs identical to Windows behaviour (all `Succ`, `GetHotKeyState` → false). Do not build hooks unless a feature needs them.
6. **Matter/AmbiScape (§7, §8) — optional, off by default.** Only if bulb support is wanted. Provide Node (system/bundled/Electron-as-Node) instead of the cloud download; BlueZ for BLE; `$XDG_DATA_HOME` storage; feed Wi-Fi secrets on stdin not argv; screen capture via PipeWire portal / XShm. Keep the renderer IPC and the control.mjs stdin/stdout protocol unchanged.
7. **Wi-Fi list (§6).** Drop if Matter is dropped. If kept, use NetworkManager/iwd D-Bus, return no passphrase, prompt the user. Never shell out with an SSID.
8. **Harden the backend socket (§11).** Bind localhost or a Unix socket; never return credentials.
9. **Drop:** DTS (§10), SmartDesktop/FancyZones (§9), elevate (§12.2), the HKLM Run self-autostart (§12.1), backend WMI logging.

## Online touchpoints (this area)

| # | What | Where | Trigger | Strip recommendation |
|---|---|---|---|---|
| 1 | Matter Node runtime plugin download | `Mv({deviceType:"EVNIA_Plugins", componentId:"EVNIA_AmbiScape_NODE_1801200"})` → `deviceportal.zeasn.tv/direct/component/update`, then `extractZip` to `%APPDATA%\evnia\Matter` (`STY:35140`, `MAIN:16826-16842`, `STY:33075-33110`) | Enabling AmbiScape when node.exe absent | Bundle Node or use system Node / Electron-as-Node; remove the download |
| 2 | AmbiScape UI plugin bundle download | same portal `component/update`, `SmartDesktop`-style flow (`AMB`/`STY:35110-35180`) | First AmbiScape enable | Bundle the page; remove |
| 3 | SmartDesktop (PowerToys FancyZones) download + install | portal `component/update {SmartDesktop, Philips_SmartDesktop}`, `extractZip`, `runCommand` installer (`SmartDesktop-By8ZEPkl.js:45-140`) | User clicks Download on Smart Desktop page | Feature dropped on Linux |
| 4 | DtsServer.exe download + install | portal `component/update {E.dtsData.deviceType, E.dtsData.componentId}`, `extractZip`, `runCommand` (`Setup-daShw_PC.js:56-140`) | User opens a TAG-headset Setup page | Feature dropped |
| 5 | Matter commissioning / operation | BLE + IPv6/UDP + mDNS, local only; no DCL/cloud (`MCJ`, §7.5) | Pairing/controlling a bulb | Keep as-is if Matter kept; it is already offline |
| 6 | `GetWifiList` | Local only (wlanapi + netsh); no network egress but returns secrets over the SignalR channel (§6, §11) | Matter Wi-Fi pairing step | If kept, drop passphrases and bind localhost |

Note: the self-update flow (which uses `elevate.exe`) and its `deviceSign` / `clientUpg` endpoints are the electron-main / online reports' territory; only the `elevate.exe` mechanism is covered here.

## Open questions

1. **Matter Node plugin contents.** The archive at `EVNIA_AmbiScape_NODE_1801200` was never downloaded on the user's machine (`%APPDATA%\evnia\Matter` absent), so its exact layout, Node version and whether it bundles the `@stoprocent/*` native BLE addons is INFERRED from `control.mjs` requires. A Linux port must confirm which native modules it needs and rebuild them for BlueZ.
2. **`--ble.hci.id` mapping.** Assumed to be the Linux `hciN` index under BlueZ; not verified against `@stoprocent/noble`'s Linux backend.
3. **`extractZip` installer command semantics.** SmartDesktop/DTS/Node installers are invoked as `"<file>" /targetDir "<dir>"`. Whether these are self-extracting exes or NSIS installers (and whether any run on Wine) is unconfirmed; not relevant since these features are dropped.
4. **Multi-monitor FancyZones editor.** `EditorParameters` enumerates monitors via `Zeasn.Display32.Lib` (a referenced DLL not in this corpus's decompilation set); its exact monitor-id format is not fully resolved here. Irrelevant unless SmartDesktop is ported.
5. **Whether any Philips-branded Matter bulb exists** vs. this being generic Matter control. The device types handled are standard (extendedColorLight, aggregator), so it appears to control any Matter lighting device, but the intended retail bulb SKU is unknown.

## Cross-references

- **DDC transport / VCP:** the actual `E2 A0 19` Ambiglow write used by idle (§3) and the full monitor VCP set are in the DDC report (`docs/re/07-ddc-transport.md`) and Ambiglow report (`docs/re/09-ambiglow-lighting.md`).
- **Ambiglow / lighting effects:** `E2A0_19_AmbiglowLightMode_E`, the ENE vs non-ENE effect paths, and Follow-Video at the *monitor* level (distinct from the bulb sync in §8) are in the Ambiglow report.
- **Electron main / updater / online:** the self-updater that uses `elevate.exe` (§12.2), `deviceSign`/`clientUpg`, the `component/update` portal contract, and the full ipcMain surface are in the electron-main report (`docs/re/01-electron-main.md`) and the online report.
- **Backend host / dispatch:** SignalR hub, `GetTaskAsync`, reflection dispatch to `Bridge`, notification push, and the `10010` binding (§11) are in the backend-host report (`docs/re/05-backend-host.md`).
- **USB/HID + device data:** `Zeasn.Win.Lib` SetupAPI/HID enumeration, `KeyboardHIDScanCode_Extension`, and per-vendor peripheral libs (third-party peripherals are not vendor-supported here) belong to the USB/HID and peripheral reports.
- **Macros / RunMacro:** `CWinInputHelper.SendInput` and `CSystemInfo` OS input-speed reads are used by the macro engine, covered in the keyboard/macro report.
