# Peripheral protocols, part 1: RongYuan, BeiYing, HaiHui and Equipment.Base

**Scope:** `work/dotnet-clean/Zeasn.USB.RongYuan.Lib`, `Zeasn.USB.BeiYing.Lib` (plus `work/native/KBAccess_SPK8618.dll.c/.symbols.txt`), `Zeasn.USB.HaiHui.Lib`, `Zeasn.Equipment.Base.Lib`, the data files `resources/bin/res/data/{PCenter_DeviceInfo.json, BeiYing/KB_K916.json, RongYuan/RongYuan_Keyboard_V1.json}`, and how the app discovers devices.

The vendor-library assemblies in scope hold only enums, structs and thin native wrappers. The code that builds the actual packets lives in `work/dotnet-clean/Zeasn.Equipment.Option.Lib` (files `*RongYuan*`, `*BeiYing*`, `*HaiHui*`). I read those files too, because the byte layouts can't be specified without them.

## Summary

* **All of these devices are Philips/Evnia-branded gaming peripherals. The user owns none of them.** Nothing here touches the 34M2C8600 monitor, and none of it can be tested on the user's machine. The runtime logs confirm this: the HID enumeration (`EvniaServe/logs/2026-09-25.txt:11-25`) lists only three unrelated HID devices (a keyboard, a mouse and an audio device; anonymized `0000:0001`-`0000:0003`), `0cf2:a201` and a virtual HID device. Every peripheral `ConnectionChecked` ends "not found".
* **Every in-scope device uses plain HID, reached through SetupAPI and `hid.dll`.** Nothing uses WinUSB, a kernel driver or raw GATT. BLE devices are reached through the Windows HID-over-GATT stack as ordinary HID paths. On Linux, `hidraw` covers all of it.
* **RongYuan** (keyboards SPK8308/8508/8708, mice SPK9308/9508/9708, mouse pad SPL7508; VID `0x25AA`) uses a vendor protocol written directly in C#:
  * 64-byte **feature reports with no report ID**, sent on USB interface 2 (interface 1 for the pad).
  * An 8-byte header whose checksum is `byte[7] = 0xFF - sum(byte[0..6])`.
  * Paging in 56-byte chunks.
  * A 2.4 GHz dongle relay made of meta-commands `0xF7` (status), `0xF6` (forward) and `0xFC` (fetch).
  * A BLE wrapper that uses report ID 6: `06 55 <64 bytes>`.
  * Events arrive as input report ID 5 with a 3-byte payload.
* **HaiHui SPK9618 "3395"** (VID `0x25AA`, PID `0x4019` wired / `0x4018` dongle, BLE `0x3151:0x503C`) uses the **same framing, checksum, dongle relay and BLE wrapper** as RongYuan, but its own command table (`CmdType`).
* **HaiHui SPK9618 "8960"** (PIDs `0x401B` / `0x401A`) is driven only through the closed YJX SDK DLL (`lib/YJX/Mouse_SPK9618_8960*.dll`). Its wire protocol belongs to the YJX report (see Cross-references).
* **BeiYing SPK8618 / KB_K916** (wired `0x25AA:0x200D`, dongle `0x3554:0xFA09`) is driven only through `KBAccess_SPK8618.dll`. I recovered that DLL's protocol from the Ghidra output and from its vtables, which I read out of the DLL's `.rdata` (the file was read, never run). It has two transports:
  * **"G5" wired:** 520-byte feature reports with report ID 6 or 9, a 8-byte header, then 512-byte data chunks.
  * **"3632" 2.4 GHz:** 20-byte output and input reports with report ID `0x13`, 14-byte chunks, and a trailing additive checksum.
* **Online touchpoints in this scope** are limited to building the firmware-update identifiers `DP_DeviceType`/`DP_ComponentID`, which the renderer sends to the cloud firmware service, and the HaiHui 8960 firmware flashing of downloaded images. The device protocols themselves are entirely local.
* **Recommendation:** for a monitor-only Linux port, drop all of these peripherals. The spec below exists so they can be added later behind a "peripherals" feature flag. Section 6 gives the order to build them in.

Tags used throughout: **[C]** means CONFIRMED (read directly in code or bytes). **[I]** means INFERRED (reasoned from code structure or naming, not observed on the wire).

---

## 1. Device inventory (`PCenter_DeviceInfo.json`)

Source: `Evnia Precision Center/resources/bin/res/data/PCenter_DeviceInfo.json`. The enum names come from `work/dotnet-clean/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/DeviceType.cs:7-79`.

The JSON fields map onto `DictDeviceInfo` (`Zeasn.PCenter.Entity.Lib/.../DictDeviceInfo.cs`):

* `FactoryType`: 2 = RongYuan, 3 = BeiYing, 6 = HaiHui (`FactoryType.cs`).
* `EquipmentType`: 2 = keyboard, 3 = mouse, 4 = mouse pad (`EquipmentType.cs`).
* `ConnectMode`: 0 = USB, 1 = BLE, 2 = Dongle (`ConnectMode.cs`).
* `CreateDevice`: 0 = `FILE_SHARE_READ|WRITE` plus overlapped (`Zeasn.Win.Lib/.../CreateDeviceFileMode_E.cs`).
* `CheckFState`: 0 = open the async input-report reader, 1 = don't (`DeviceFileFinishCheckFState_E.cs`: Open=0, Close=1).

| DeviceType id | Enum name | Model | VID:PID | Conn | UsagePage:Usage (primary handle) | `Extra` (second handle / BLE key) | CheckFState | Battery | Profiles | Driver |
|---|---|---|---|---|---|---|---|---|---|---|
| 200000 | RongYuan_KeyboardSPK8708 | SPK8708 | 25AA:2007 | USB | FFFF:0001 | `vid_25aa&pid_2007&mi_02` | 0 | yes | 4 | C# RongYuan |
| 200001 | RongYuan_KeyboardSPK8508 | SPK8508 | 25AA:2006 | USB | FFFF:0001 | `vid_25aa&pid_2006&mi_02` | 0 | no | 4 | C# RongYuan |
| 200002 | RongYuan_KeyboardSPK8308 | SPK8308 | 25AA:2005 | USB | FFFF:0001 | `vid_25aa&pid_2005&mi_02` | 0 | no | 4 | C# RongYuan |
| 200003 | RongYuan_KeyboardSPK8708_BLE | SPK8708 | 25AA:2007 | BLE | 0000:0000 | `&0&0005#` | 0 | yes | 4 | C# RongYuan (BLE) |
| 200004 | RongYuan_KeyboardSPK8708_24G | SPK8708 | 25AA:2008 | Dongle | FFFF:0001 | `vid_25aa&pid_2008&mi_02` | 0 | yes | 4 | C# RongYuan (dongle) |
| 201000 | BeiYing_KeyboardSPK8618 | SPK8618 | 25AA:200D | USB | 0000:0000 | `57d0c10254559e4a550c00000004dd` (encoded; see 4.2) | 0 | yes | 1 | KBAccess_SPK8618.dll |
| 201001 | BeiYing_KeyboardSPK8618_24G | SPK8618 | 3554:FA09 | Dongle | 0000:0000 | `55248aeb54a8426a57300000001077` | 0 | yes | 1 | KBAccess_SPK8618.dll |
| 300000 | RongYuan_MouseSPK9708 | SPK9708 | 25AA:4007 | USB | FFFF:0001 | `vid_25aa&pid_4007&mi_02` | 0 | yes | 4 | C# RongYuan |
| 300001 | RongYuan_MouseSPK9508 | SPK9508 | 25AA:4006 | USB | FFFF:0001 | `vid_25aa&pid_4006&mi_02` | 0 | no | 4 | C# RongYuan |
| 300002 | RongYuan_MouseSPK9308 | SPK9308 | 25AA:4005 | USB | FFFF:0001 | `vid_25aa&pid_4005&mi_02` | 0 | no | 4 | C# RongYuan |
| 300003 | RongYuan_MouseSPK9708_BLE | SPK9708 | 0000:0000 | BLE | 0000:0000 | `&0&0005#` | 0 | yes | 4 | C# (VID/PID 0, effectively dead; `[UnbindEnumExtended]`) |
| 300004 | RongYuan_MouseSPK9708_24G | SPK9708 | 25AA:4008 | Dongle | FFFF:0001 | `vid_25aa&pid_4008&mi_02` | 0 | yes | 4 | C# RongYuan (dongle) |
| 303000 | HaiHui_MouseSPK9618_3395 | SPK9618 (ExtModel 3395) | 25AA:4019 | USB | FFFF:0001 | `vid_25aa&pid_4019&mi_02` | 0 | yes | 1 | C# HaiHui M3395 |
| 303001 | HaiHui_MouseSPK9618_3395_24G | SPK9618/3395 | 25AA:4018 | Dongle | FFFF:0001 | `vid_25aa&pid_4018&mi_02` | 0 | yes | 1 | C# HaiHui M3395 |
| 303002 | HaiHui_MouseSPK9618_3395_BLE | SPK9618/3395 | 0000:0000 | BLE | **FF55:0202** | `vid&023151_pid&503c` (BLE VID 0x3151, PID 0x503C) | 0 | yes | 1 | C# HaiHui M3395 (BLE) |
| 303003 | HaiHui_MouseSPK9618_8960 | SPK9618 (ExtModel 8960) | 25AA:401B | USB | FFFF:0001 | "" | 0 | no | 1 | `lib/YJX/Mouse_SPK9618_8960.dll` |
| 303004 | HaiHui_MouseSPK9618_8960_24G | SPK9618/8960 | 25AA:401A | Dongle | FFFF:0001 | "" | 0 | no | 1 | `lib/YJX/Mouse_SPK9618_8960_24G.dll` |
| 400001 | RongYuan_MousePadSPL7508 | SPL7508 | 25AA:8002 | USB | FFFF:**0002** | `vid_25aa&pid_8002&mi_01` | **1** (no event reader) | no | 1 | C# RongYuan |

Notes on the table:

* The JSON has no `IUSB_USAGE_PAGE` for BLE RongYuan (0), and the BLE lookup keys on the `Extra` substring instead. **[C]** `CDeviceBluetoothLEBase.cs:83-117`.
* `MainDeviceTypeAttribute` (`DeviceType.cs:21-72`) makes the `_BLE` and `_24G` variants share board/profile storage with their wired "main" device.
* Other Philips devices in the same JSON (JiangMeng 3010xx, YongJiaXing 3020xx, TAG headsets 5000xx) are out of scope.

---

## 2. Equipment.Base: the shared device framework

### 2.1 Class hierarchy [C]

The deobfuscated names differ from the names other assemblies use for the same classes. Both are given below.

| File (`work/dotnet-clean/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/`) | Referenced elsewhere as | Role |
|---|---|---|
| `CDeviceBase.cs` | `CDeviceBase` | Holds `DeviceType`, `bConnection`, `WirelessConnectionState`. `CheckDeviceOnLine()` returns `WirelessConnectionState` for BLE/Dongle and `ConnectionState` otherwise (l.70-81). `OnConnect()` = `InitDeviceOnce` (once) + `InitDevice` + `DeviceDataCheck` (l.83-92). Default `UpgradeFw/GetPairDevices/EnterPairing` return "operation is not implemented". |
| `GClass0.cs` | `CDeviceProfileBase<T>` | Profile/onboard-board logic. `Board` is persisted to `%APPDATA%/EvniaServe/Config/BoardInfo/<MainDeviceType>.data` (l.54-75; `WorkspacePath.cs:65-68`). `DeviceDataCheck()` loads the current theme's JSON for the device and calls `ParameterToDevice(bForce:true)` (l.173-189). |
| `CDeviceEffectBase.cs` | `CDeviceEffectBase<T>` | Effect menu and effect-sync helpers (`IsInEffectSync`, `IsCanBreathingSync` = in sync and ≥2 devices). |
| `CDeviceBluetoothLEBase.cs` | `CDeviceBluetoothLEBase<T>` | BLE discovery and opening (2.3). |
| `CDeviceUsbBase.cs` | `CDeviceUsbBase<T>` | USB HID discovery/opening, async input reader, `DataReceived` event (2.2). |
| `CDeviceButtonBase.cs` | `CDeviceButtonBase<T>` | Button-function menu; **software handling of "vendor key" events** (2.5). |
| `CDeviceMouseBase.cs` | `CDeviceMouseBase<T>` | Mouse interface stubs (DPI, rate, LOD, …). |
| `GClass1.cs` | `CDeviceKeyboardBase<T>` | Keyboard game-mode stubs. |
| `GClass2.cs` | headset DTS base | out of scope |
| `GClass3.cs` | display base | Display/DDC discovery. **Relevant to the user's monitor**, covered by the DDC report. |
| `IDevice/IProfile/IEffect/IButton/IMouse/IKeyboard/IDeviceSetup.cs` | | Interface surface that `Bridge.Lib` dispatches to. |
| `Class0.cs` | | .NET Reactor runtime stub (string-decryption helper). Not functional code; ignore. |

### 2.2 USB HID discovery and open [C]

1. **Enumerate** (`Zeasn.Win.Lib/.../UsbUtil.cs:9-39`):
   * `HidD_GetHidGuid`, then `SetupDiGetClassDevs(HIDGuid, NULL, NULL, 0x12 = DIGCF_PRESENT|DIGCF_DEVICEINTERFACE)` (`WindowsUSBAPI.cs:105-108`).
   * `SetupDiEnumDeviceInterfaces` for at most 128 entries, then `SetupDiGetDeviceInterfaceDetail`.
   * The result is a list of device paths such as `\\?\hid#vid_25aa&pid_2007&mi_02#…`, stored in `Global.UsbList`.
   * The list is refreshed on every scan (`Zeasn.Framework.Core.Lib/.../SystemOper.cs:136-229`). A scan runs one task per `DeviceType` in parallel. USB-change events rescan non-BLE types; "other" device-change events rescan BLE types.
2. **Select** (`CDeviceUsbBase.cs:124-162`): keep list entries whose lowercase path contains `vid_%04x` **and** `pid_%04x`.
3. **Open and verify** (`CDeviceUsbBase.cs:168-225`):
   * `CreateFile(path, 0xE0000000, share=3, OPEN_EXISTING, FILE_FLAG_OVERLAPPED)` for `CreateDevice=0` (`WindowsUSBAPI.cs:155-164`).
   * Then `HidD_GetAttributes` and `HidD_GetPreparsedData`/`HidP_GetCaps`.
   * **Accept only if VID, PID, `Caps.UsagePage` and `Caps.Usage` all match** the JSON. This handle is the "primary" handle.
4. If `CheckFState == 0`, wrap the primary handle in a `FileStream` and loop on `BeginRead(InputReportByteLength)`. Each read becomes `Report(id = buf[0], data = buf[1..])` and is raised as `DataReceived` (l.227-259). On an `IOException` the device is treated as removed.
5. `OpenSecondHidDevice()`:
   * The base version returns true.
   * The RongYuan, HaiHui and mouse-pad overrides open the **first** `UsbList` path containing the lowercase `Extra` string (for example `vid_25aa&pid_2007&mi_02`) as the "second" handle. **All feature-report command I/O goes to the second handle.** (`CDevice_RongYuanKeyboardBase.cs:29-50`, `CDevice_RongYuanMouseBase.cs:28-49`, `CDevice_RongYuanMousePadBase.cs` l.~26-45, `M3395_DeviceService.cs:167-193`.)
6. A quick re-check keeps the connection if the same path is still present (`QuickCheckConnectd`). The RongYuan subclasses also require `GetFirmwareVersion` (`0x80`) to succeed (`CDevice_RongYuanKeyboardBase.cs:66-78`).

**Important for Linux [I]:** input reports on the primary handle must carry **report ID 5**, because `RongYuanReportBuffUtil.AnalyseData` ignores anything else (`Zeasn.USB.RongYuan.Lib/.../RongYuanReportBuffUtil.cs:14`). Feature commands, however, go out with **report ID 0** to the `mi_02` path. A single HID interface can't mix numbered and unnumbered reports. So the event collection (usage page `0xFFFF`, usage 1, input report 5) and the command interface (interface 2, unnumbered 64-byte feature report) are most likely **different USB interfaces**. The Linux side must look up two `hidraw` nodes (see 6.3).

### 2.3 BLE discovery and open [C] (`CDeviceBluetoothLEBase.cs:83-161`)

* Sleep 1500 ms, then re-enumerate HID paths (`UsbUtil.GetUsbList()`).
* Keep paths containing `(Vid.ToString("X2") + "_pid&" + Pid.ToString("X2")).ToLower()` (for example `25aa_pid&2007`) **and** the `Extra` substring (`&0&0005#`, the Windows collection-instance suffix of the vendor TLC).
* Open that path with shared read/write, overlapped. The `FileStream` buffer is `InputReportByteLength`, or `FeatureReportByteLength` if the former is 0.
* A background thread (`CDevice_RongYuanKeyboardBase.cs:194-228`) polls "online" every 2000 ms with the BLE `0x77` request (3.2.3) and raises `NotifyDeviceConnectionStatus` on changes.

### 2.4 HID I/O primitives and their hidden timing [C] (`Zeasn.Win.Lib/.../WindowsUSBAPI.cs`)

| Primitive | Buffer on the wire | Retries / delays |
|---|---|---|
| `HidD_SetFeatureReport(h, report, iLength)` (l.290-304), as used by RongYuan and HaiHui with `iLength=64` | `byte[iLength+1]`: `[0]=reportID (0)`, `[1..64]=payload` (65 bytes) | `smethod_1(func, 37)` (l.243-264): up to 3 attempts. After attempt n fails, sleep `(n+1)*37` ms. **After success, sleep 37 ms.** |
| `HidD_GetFeatureReport(h, report, iLength)` (l.211-239) | `byte[iLength+1]` with `[0]=reportID`, the rest zero. The result is copied back from `[1..]`. | `smethod_1(func, 7)`: up to 3 attempts, 7/14/21 ms backoff, **7 ms after success**. |
| `HidD_SetFeatureReport(h, report, iLength, iDelay)` (l.271-288) | `byte[iLength]` (**no +1**) | custom delay |
| `CDeviceUsbBase.HidD_WriteUSBHID_SendCmd` (`CDeviceUsbBase.cs:316-331`) | output report of `InputReportByteLength` bytes via `WriteFile` | none. Unused in this scope. |

### 2.5 Software "vendor key" handling [C] (`CDeviceButtonBase.cs:61-127`)

When a key is remapped to a *software* function, its matrix entry becomes a **VendorCode** entry: `06 FF <keyId|0x80 if Fn> 00` (see 3.4). The software functions are Macro, Text, SwitchProfile, SwitchLighting and LaunchProgram (`CDevice_RongYuanKeyboard.cs:873-906`). When pressed, the device sends a report-5 event `FF <keyId|Fn> <1=down/0=up>`. `ButtonEvent(layer, id, action)` then:

* runs a software macro (`MacroMgr.FuncExecuteMacro`, which synthesizes input);
* switches the app profile (`EVT_Profile.*`);
* switches the lighting effect locally; or
* runs `MacroMgr.ExecuteFunc` on key-up (launch programs, …).

A Linux port needs `uinput` for this. See Cross-references (macro engine).

---

## 3. RongYuan protocol (keyboards, mice, mouse pad)

Code: `work/dotnet-clean/Zeasn.USB.RongYuan.Lib/**` (enums, structs, key table) and `work/dotnet-clean/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.RongYuan/RongYuanIO.cs` (all transport). The device logic is in `CDevice_RongYuan{Keyboard,Mouse,MousePad}*.cs`, `RongYuanKeyboard_Oper.cs`, `…Option.RongYuan.Mouse/RongYuanMouse_Oper.cs` and `…Option.RongYuan.Base.Bluetooth/GClass1.cs` (BLE).

### 3.1 Packet format [C]

Every command is a **64-byte block** (`RongYuanIO.LENGTH_REPORT_BUFF = 64`, header 8, data 56; `RongYuanIO.cs:35-61`):

```
byte 0     : command (FEA_CMD, see 3.3)  - SET = 0x00-0x7F, GET = SET|0x80
byte 1..6  : command parameters (profile/board, index, page, flags...)
byte 7     : checksum = (0xFF - (b0+b1+...+b6)) & 0xFF        (RongYuanIO.cs:754-769)
byte 8..63 : data (max 56 bytes per page)
```

Multi-page writes (`FnSetFeatureReport(hdr, data, pageIndex, pageCount)`, `RongYuanIO.cs:496-611`):

* Page count = `pageCount` if given, else `ceil(len/56)`.
* For page *i*: clone the header, set `hdr[pageIndex] = i` **only when pageCount > 1**, recompute the checksum, then copy `data[i*56 ..]` (≤56 bytes) to offset 8.
* Pages that fall beyond the data are still sent, with an empty payload.

Keyboard macro writes use a variant (`method_7`, l.613-662). It always sends **5 pages**, sets `[2]=page`, `[3]=chunk length (≤56)` and `[4]=1` on the last page.

Multi-page reads (`FnGetFeatureReport(hdr, pageIndex, pageCount)`, l.689-710):

* For each page, set `hdr[pageIndex]=i` and run a GET transaction.
* With `pageCount>1`, concatenate each response's bytes `[8..63]`.
* With `pageCount==1`, return the whole 64-byte response. Response byte 0 echoes the command.

### 3.2 Transports [C]

#### 3.2.1 Wired USB (ConnectMode USB)

* **SET:** `HidD_SetFeatureReport(secondHandle, reportID 0, 64 bytes)`, followed by the implicit 37 ms sleep.
* **GET** (`method_8`, l.712-752): SET the request block, `Thread.Sleep(10)`, then `HidD_GetFeatureReport(secondHandle, 64)`. The response must be exactly 64 bytes.
* Many high-level calls add their own post-delays when **not** in dongle mode (`method_11()` = `ConnectMode != Dongle`, l.1367-1370). See 3.9.

#### 3.2.2 2.4 GHz dongle (ConnectMode Dongle) [C] (`RongYuanIO.cs:230-465`)

The same 64-byte feature report on the dongle's `mi_02`, plus meta-commands. All meta packets are 64 bytes with **no checksum**.

| Meta cmd | Name (`Zeasn.USB.RongYuan.Lib.Enum/GEnum0.cs`) | Layout |
|---|---|---|
| `0xF7` (247) | DeviceStatus | SET `F7 00…`, then GET 64 bytes. Response **[I]**: `[1]`=keyboard battery %, `[2]`=mouse battery %, `[3]`=keyboard offline flag (1 = offline), `[4]`=mouse offline flag, `[5]`=1 when the dongle can forward a command, `[0]`=1 when a forwarded GET response is ready. |
| `0xF6` (246) | DeviceData (forward) | `F6 0A …` for keyboards (DeviceType 200000-299999) or `F6 05 …` for mice (300000-399999). The next SET is relayed over RF. |
| `0xFC` (252) | GetData | `FC 00…`, then GET 64 bytes returns the peripheral's response. |
| `0xFE` (254) | CheckLen | `FE 17 …` (0x17 = 23 = `MAX_LEDSYNC_DATA_LEN`). Sent before every LED-sync (`0x0C`) frame; the frame follows immediately. Only used while online. |

**Dongle SET** (`method_5`, l.331-406):

1. If `cmd == 0x0C`: when online, send `FE 17`, then the frame. Done.
2. Otherwise loop for up to 5000 ms:
   * Send `F7`, then GET the status.
   * If the target is offline (keyboard `[3]==1` / mouse `[4]==1`), fail.
   * If `[5] != 1`, sleep 150 ms and retry.
   * Otherwise send `F6 0A|05`, then the real 64-byte command.

**Dongle GET** (`method_8` → SET path above, then sleep 10 ms, then `method_6`, l.408-465). Loop for up to 5000 ms:

* Send `F7`, then GET the status.
* If the target is offline, fail.
* If `[0] != 1`, sleep 20 ms and retry.
* Otherwise send `FC`, sleep 10 ms, then GET 64 bytes. That is the response.

**Online poll** (`LoopCheck24GDeviceConnect`, l.230-281): every 2000 ms, run `Check24GDeviceConnect` (send `F7`, GET; online = keyboard `[3]==0` / mouse `[4]==0`). It raises a synthetic event `Report(5, [0x0E, battery, 0])` (battery = `[1]` for keyboards, `[2]` for mice). On an offline→online transition it waits 2000 ms, then re-runs `OnConnect`.

#### 3.2.3 BLE (ConnectMode BLE) [C] (`Option.RongYuan.Base.Bluetooth/GClass1.cs`)

HID output and input reports are **66 bytes with report ID 6**:

| Direction | Bytes | Meaning |
|---|---|---|
| host→dev | `06 55 <64-byte block>` | "Drive": a normal command. The checksum is recomputed before wrapping (l.318-334). |
| host→dev | `06 56 <len> <first len bytes of block>` | "ShortDrive": only for `0x0C` LED-sync frames, len = 23 (l.348-361). |
| host→dev | `06 77 00…` | "Bluetooth": online/battery request (l.336-346). |
| dev→host | `06 55 <64-byte response>` | Response to a GET. Kept only if `resp[0]` is an awaited command; matched on `resp[0]==cmd` (and `resp[pageIndex]==page`) (l.194-208, 279-316). |
| dev→host | `06 77 <battery>` | Online. Raised as event `Report(5,[0x0E,battery,0])`. |
| dev→host | `06 88 …` | Offline |
| dev→host | `06 66 <64 bytes>` | "Flash": an unsolicited device event. The first 3 bytes are raised as `Report(5, b[0..2])` unless `b[0]==0x0F` (FlashWriteReport). |

* Every write sleeps 100 ms after `Write` (l.124-145).
* A GET polls every 10 ms for up to 1500 ms (`GetOutTime`).
* BLE GETs don't send a separate SET; the `06 55` write is the request.
* Enum values: `BluetoothCommand` Drive=0x55, ShortDrive=0x56, Flash=0x66, Bluetooth=0x77, 0xAA (unused) (`Zeasn.USB.RongYuan.Lib.Enum/BluetoothCommand.cs`).

### 3.3 Command table (`FEA_CMD`) [C]

`Zeasn.USB.RongYuan.Lib.Enum/FEA_CMD.cs`, with usage from `RongYuanIO.cs`. "prof" means onboard profile/board 0-2, or **3 = software (host-driven) profile**. Offsets are into the 64-byte block. The Linux column says what a Linux port needs.

| Cmd | Name | Header bytes | Data @8 | Used by / notes | Linux |
|---|---|---|---|---|---|
| `0x02` | SET_RESERT (reset) | `[1]=prof` (0xFF = all, default) | – | `Reset()` l.1354; 2000 ms delay | yes |
| `0x03` | SET_BATTERY (low-battery alert %) | `[1]=%` (clamped ≤99) | – | keyboard SPK8708 family l.1204 | yes |
| `0x04` | SET_REPORT (polling rate) | `[1]=prof, [2]=rate` | – | `SetRepotRate` l.1016. Rate code (`RongYuanReportRate.cs`): **1=1000 Hz, 2=500, 4=250, 8=125**. 2000/4000/8000 would throw (no mapping). | yes |
| `0x05` | SET_PROFILE (switch onboard board) | `[1]=board 0..3` (anything else becomes 3) | – | `SwitchBoard` l.771; 350 ms | yes |
| `0x06` | SET_KBOPTION_KB | `[1]=prof, [2]=opt1, [3]=opt2` | – | 3.5.3 | yes |
| `0x07` | SET_LEDPARAM | `[1]=board` | 8-byte `RongYuanLedParam` | l.1140 | yes |
| `0x08` | SET_SLEEPTIME_KB | `[1]=prof (3)` | 8 bytes: 4× int16 LE seconds `{SleepBT, Sleep24G, DeepSleepBT, DeepSleep24G}` (`RongYuanSleepTimeStruct.cs`: minutes×60) | l.1341 | yes |
| `0x09` | SET_KEYMATRIX (one key, base layer) | `[1]=prof, [2]=keyIndex, [3]=0` | 4-byte action (3.4) | `SetButtonValue` l.843 | yes |
| `0x0A` | SET_MACRO (keyboard) | `[1]=macroIdx, [2]=page 0..4, [3]=chunkLen, [4]=last(1), [5]=prof` | macro bytes (255-byte buffer, 5 pages) | l.948 + `method_7` | yes |
| `0x0C` | SET_LEDSYNCPARAM (live streaming) | `[1]=effect, [2]=speed, [3]=brightness, [4]=option, [5]=mode (1 start / 0 stop / 2 frame), [6]=random-colour flag` | frame data | 3.6.4 | optional |
| `0x0D` | SET_FN (one key, Fn layer) | as `0x09` | 4 bytes | sent **twice**, `[3]=0` then `[3]=1` (l.858-867) | yes |
| `0x10` | SET_PROFILE_DATA_KB | `[1]=prof, [2]=page (5 pages)` | 205-byte `RongYuanKeyboardProfile` (3.5.1) | l.816; 300 ms | yes |
| `0x11` | SET_PROFILE_MATRIX_KB (base layer, all keys) | `[1]=prof, [2]=page (10 pages)` | 126×4 = 504 bytes | l.874; 800 ms | yes |
| `0x12` | SET_PROFILE_FN_KB (Fn layer, all keys) | as `0x11` | 504 bytes | sent twice (`[3]=0`, then `[3]=1`), 800 ms each | yes |
| `0x14` | SET_POWERSAVE ("lights off") | `[1]=1 on / 0 off` | – | `LightEnable(x)` sends `!x` (l.921) | yes |
| `0x16` | SET_PROFILENAME | `[1]=prof` | name in **GBK**, ≤56 bytes | l.1233 | optional |
| `0x17` | SET_MACROFLAG / SET_BATTERY_THRESHOLD | `[1]=board` **or** `[1]=%` | – | Same code for two meanings (l.1221 mouse low-battery %, l.1315 clear macro flag). See Open questions. | yes |
| `0x18` | SET_LOGOLED (startup/boot effect) | `[1]=on` | – | l.1274 | yes |
| `0x19` | SET_CHECKCURRENTBATTERY | – | – | Triggers event `0x20` (l.1004) | optional |
| `0x22` | SET_M_PROFILE_B_M (mouse DPI table) | `[1]=prof, [2]=curDpiIndex, [3]=dpiCount, [4]=1` | 56-byte DPI struct (3.5.4) | `method_10` l.984; 300 ms | yes |
| `0x23` | SET_M_PROFILE_C_M (mouse LED per-effect params) | `[1]=prof, [2]=effect *list index*` | 54-byte `RongYuanMouseProfile` | l.829; 250 ms | yes |
| `0x25` | SET_M_MACRO_M (mouse macro) | `[1]=macroIdx (i+16·board), [2]=page (5 pages)` | macro bytes (255) | l.948 | yes |
| `0x26` / `0x27` | SET_M_KEYMATRIX / FNKEYMATRIX (mouse, all buttons) | `[1]=prof, [2]=page (2 pages)` | 16×4 = 64 bytes | l.904; 250 ms | yes |
| `0x7F` | SET_BOOTLOATER | – | – | **Never sent** (no RongYuan firmware update) | no |
| `0x80` | GET_REV | – | – | Response `fw = [2]<<8 | [1]` (l.1303). Used for wireless and for the quick re-check. Wired FW version = HID `bcdDevice`. | yes |
| `0x83` | GET_BATTERY | – | – | `[1]`=%, `[2]`=0 not charging / 1 charging / 2 full (l.1190) | yes |
| `0x85` | GET_PROFILE | – | – | `[1]`=board 0..3 (l.788) | yes |
| `0x87` | GET_LEDPARAM | `[1]=prof` | – | response `[8..15]` = `RongYuanLedParam` (l.1118) | yes |
| `0x8C` | GET_LEDSYNCPARAM | – | – | `[1]`, 0 = not streaming (l.802) | optional |
| `0x8F` | GET_INFOR (ID code) | – | – | `[1..4]` int32 LE `IDCode`; colour variant = IDCode/100 when 100≤IDCode<1000 (l.1328, `ExternRongYuanInfo.cs`) | yes |
| `0x91` / `0x92` | GET_PROFILE_MATRIX / FN (keyboard) | `[1]=prof, [2]=page (10 pages)` | – | 560 bytes returned, first 128×4 used (l.1030-1072) | yes |
| `0x94` | GET_POWERSAVE | – | – | `[1]==1` | yes |
| `0x96` | GET_PROFILENAME | `[1]=prof` | – | `[8..63]` GBK, NUL-trimmed | optional |
| `0x98` | GET_LOGOLED | – | – | `[1]`=on, `[2]`=boot animation running (l.1287) | yes |
| `0xA6` / `0xA7` | GET_M_KEYMATRIX / FN (mouse) | `[1]=prof, [2]=page (2 pages)` | – | 16×4 used | yes |

Defined but never sent (semantics **[I]** from their names):

* `0x0B/0x8B` USERPIC, `0x0E/0x8E` DEBOUNCE, `0x0F` SET_INFOR, `0x13/0x93` PROFILE_MACRO.
* `0x20/0xA0` M_VARITE, `0x21/0xA1` M_PROFILE_A (probably the mouse parameter block matching the unused `RongYuanMouseParam` struct: rate, debounce, profile enable/max, option[2], button-change time, wheel↔button, X/Y sensitivity, lift cut-off, angle snap).

### 3.4 Key action codes (4 bytes per key) [C]

Source: `Zeasn.USB.RongYuan.Lib/RongYuanKeyCodeTable.cs`, `RongYuanKeyType.cs`, `RongYuanKeyFunc.cs`, `RongYuanDataConvert.cs:491-536`. Format: `[type, b1, b2, b3]`.

| type (b0) | Meaning | Layout / examples |
|---|---|---|
| `0x00` Keyboard | key + modifiers | `00 <modmask> <HID usage> 00`. Modmask bits (`RongYuanModifyKey`): 0x01 LCtrl, 0x02 LShift, 0x04 LAlt, 0x08 LWin, 0x10 RCtrl, 0x20 RShift, 0x40 RAlt, 0x80 RWin. A bare modifier key is `00 <bit> 00 00` (for example LShift = `00 02 00 00`). |
| `0x01` Mouse | button/wheel | `01 00 F0 00` L, `01 00 F1 00` R, `01 00 F2 00` M, `01 00 F3 00` **Back** (`Mouse_Backward`), `01 00 F4 00` **Forward**, `01 00 F5 01` wheel up, `01 00 F5 FF` wheel down, `01 00 F9 FF` wheel left, `01 00 F9 01` wheel right |
| `0x03` MultiMedia (consumer) | 16-bit usage LE in b2..b3 | Mute `03 00 E2 00`, Vol− `03 00 EA 00`, Vol+ `03 00 E9 00`, Prev `03 00 B6 00`, Next `03 00 B5 00`, Play/Pause `03 00 CD 00`, Stop `03 00 B7 00`, Calculator `03 00 92 01` (0x0192) |
| `0x06` VendorCode | report the key to the host | `06 FF <keyId | 0x80 if Fn layer> 00` (`GetVendorCode`) |
| `0x08` ProfileSwitch | onboard profile | `08 00 01 00` next, `08 00 02 00` previous, `08 00 03 00` cycle, `08 00 05 00` cycle-up, `08 00 04 <n>` specific profile n |
| `0x09` Macro | play an onboard macro | `09 <mode> <macroIdx> 00`. Mode (`RongYuanMacroType`): 0 = repeat N times, 1 = toggle, 2 = while held |
| `0x0A` SpecialKey | | `0A 01 00 00` Fn, `0A 02 00 00` reset device, `0A 05 00 00` Win layout, `0A 05 01 00` Mac layout, `0A 06 00 00` game mode, `0A 0C 00 00` LED on/off; from the JSON: `0A 08` (Fn+Space), `0A 19`/`0A 14` (Fn+Up/Down), `0A 20` |
| `0x0B` Fire | double click | `0B F0 64 02` (button F0, 100 ms, ×2) |
| `0x0D` LEDKey | | `0D 01 00 00` effect cycle, `0D 05 01 00` colour cycle, `0D 02 01 00` brightness+, `0D 02 02 00` brightness− |
| `0x0E` FuncKey | | `0E 01 01 00` BT pairing |
| `0x14` DPI (mouse) | | `14 00 00 00` loop, `14 00 01 00` DPI+, `14 00 02 00` DPI−, `14 <lo> 04 <hi>` Smart-DPI (sniper) at value `hi<<8|lo` (default 50) |
| other | | `00 00 01 00` = disabled (usage 0x01); `00 0A 16 00` = Win+Shift+S (Snipping Tool); "User_*" shortcuts are modifier+usage entries (`GetRongYuanKey`, l.~560-640 of the table file) |

Enum `RongYuanKeyType` also defines System=2, Scroll=4, ReportRateSwitch=5 and OLEDKey=19. They are unused.

**Keyboard key index map:** `RongYuan_Keyboard_V1.json` defines 126 slots (`ButtonID` 0-125). Each has a base action (`BaseValue`) and an Fn-layer action (`FnValue`). The JSON root key is `RECORDS` (Newtonsoft maps it case-insensitively onto `Records`). Values are written as `"[0x00,0x00,0x29,0x00]"`. Examples:

* 0 = ESC (Fn: `0A 02` reset)
* 7/13/19/25 = 1..4 (Fn: `08 00 04 00..03` = onboard profile 1..4)
* 56 = O (Fn: `0A 05 01` Mac layout), 62 = P (Fn: `0A 05 00` Win layout)
* 103/109/115/121 = NumLock, KP/, KP*, KP− (Fn: media Prev/Play/Next/Stop)
* 99/100 = `0D 02 02` / `0D 02 01` (brightness −/+)
* 102 = `0A 06` (game mode; Fn `0D 01` effect cycle)
* 108 = `0A 20` (Fn `0D 05 01`), 114 = Mute (Fn `0A 0C` LED on/off)
* 124/125 = Vol−/Vol+ (volume knob)
* `Exits:false` slots (6, 10, 11, 29, 35, 47, 53, 75, 82, 83, 87, 88, 93, 119, 120) are unused matrix positions.

`SetButton` on the Fn layer maps key 124 to base-layer 99 and key 125 to base-layer 100 (`RongYuanKeyboard_Oper.cs:1919-1937`).

**Mouse button index map** (`RongYuan_DictMgr.GetMouseButtons`, `Zeasn.USB.RongYuan.Lib.Util/RongYuan_DictMgr.cs:35-123`):

* 0 = L, 1 = R, 2 = M, 3 = B4 (`01 00 F4 00`), 4 = B5 (`01 00 F3 00`), 5 = DPI loop, 14 = wheel up, 15 = wheel down.
* SPK9708 adds 6 = "Profile Loop" (`00 00 00 00`) and 7 = "Match" (`0E 01 00 00`); SPK9508 adds 6 = Profile Loop.
* The matrix always has 16 slots.

### 3.5 Structures (all `LayoutKind.Sequential`, byte-packed, little-endian) [C]

#### 3.5.1 `RongYuanKeyboardProfile` (205 bytes; `Struct.Keyboard/RongYuanKeyboardProfile.cs`, filled by `RongYuanDataConvert.ConvertProfileData` l.263-311)

| Off | Size | Field | Value written |
|---|---|---|---|
| 0 | 1 | ReportRate | **8** (constant) |
| 1 | 1 | Debounce | 1 |
| 2 | 2 | KbOption[2] | option bytes (3.5.3) |
| 4 | 1 | LEDParamEffect | current effect id (FollowVideo/FollowAudio is stored as 4 = ColorWave; 0 when disabled) |
| 5 | 32 | LEDParamSpeed[32] | per effect id |
| 37 | 32 | LEDParamBrightness[32] (decompiled as `byte_0`) | per effect id |
| 69 | 32 | LEDParamOption[32] | per effect id |
| 101 | 96 | LEDParamAPColor[32×RGB] | per effect id |
| 197 | 1 | SLEDParamEffect (side LED) | = LEDParamEffect |
| 198 | 1 | SLEDParamSpeed | current effect's speed |
| 199 | 1 | SLEDParamBrightness (`byte_1`) | |
| 200 | 1 | SLEDParamOption | |
| 201 | 3 | SLEDParamAPColor | |
| 204 | 1 | MacroFlag | number of onboard macros |

#### 3.5.2 `RongYuanLedParam` (8 bytes; `Struct/RongYuanLedParam.cs`, `RongYuanDataConvert.cs:39-59,158-206`)

`{Effect, Speed, Brightness, Option, R, G, B, LEDOnoff}`

* **Speed** = `5 − uiSpeed` (UI 1..5 → 4..0).
* **Brightness** = `uiBrightness − 1` (UI 1..5 → 0..4).
* **Option** low nibble = colour mode: 1..6 = preset colours (1 orange FF8000, 2 yellow, 3 green, 4 cyan, 5 blue, 6 magenta, 0 or other = red); **7 = custom RGB; 8 = colourful/rainbow**.
* **Option** high nibble = direction (keyboard mapping in `RongYuanDataConvert.cs:61-99`):
  * ColorWave: 0 L→R, 1 R→L, 2 Up→Down, 3 Down→Up.
  * ColorShift: 0 Sequence, 1 Clip.
  * ColorWaveLine: 0/1 L→R / R→L.
  * Radar: 0 CW, 1 CCW.
  * Kaleidoscope: 0 Spread, 1 Gathered.
  * Mouse and pad use the raw `DirectionType` value.
* **LEDOnoff** = 1 only when Effect == 0xFF (the pad's "Off"). The pad also sets it to 1 when the effect is disabled.

#### 3.5.3 Keyboard option bytes (`Struct.Keyboard/RongYuanKeyboardOption.cs`)

* opt1:
  * bit0 = Win-key lock
  * bits1-2 = platform (0 = Windows, 1 = Mac)
  * bit3 = arrow↔WASD swap
  * bit4 = LED switch (always 0)
  * bit5 = gaming mode
  * bit6 = keyboard lock (always 0)
* opt2: bit0 = Alt+Tab lock, bit1 = Alt+F4 lock.
* Software defaults on reset (`RongYuanKeyboard_Oper.cs:2055-2070`): game mode off, LockWin **on**, the rest off.

#### 3.5.4 Mouse DPI block (56 bytes; decompiled as `Struct.Mouse/GStruct0.cs`, referenced as `RongYuanMouseDPIData`)

* `u16 X[8]` at offset 0, then `u16 Y[8]` at 16 (both = DPI value), then `RGB[8]` colours at 32.
* It is filled from `DPILevelList[DPILevel]`; `[2]`=CurDPIIndex (0-based), `[3]`=level count (`RongYuanDataConvert.cs:227-261`).
* Default table (`T_RongYuanMouse_Profile.cs:224-254`): 800 red, 1600 green, 3200 blue, 4800 orange, 6200 magenta, and a max entry (26000 SPK9708, 16000 SPK9508, 12000 SPK9308) in white. The six cumulative level lists hold 1..6 entries; default DPILevel=5, CurDPIIndex=1.
* Min 50, step 50, smart-DPI default 400 (`DPIData.cs`).

#### 3.5.5 `RongYuanMouseProfile` (54 bytes)

* `LEDParamSpeed[9]`, `LEDParamBrightness[9]`, `LEDParamOption[9]`, `LEDParamColor[27]`.
* Arrays are indexed by the **position in `rongYuanMouseEffects`**: 0 Off, 1 Static, 2 Breathing, 3 Neon, 4 ColorWave, 5 Music, 6 Windows, 7 StarryNight, 8 ColorShift (`RongYuanDataConvert.cs:26-37,313-342`).
* `LedParam.Effect` itself uses the **enum value** `RongYuanMouseEffect`: Off 0, Static 1, Breathing 2, Neon 3, ColorWave 4, Music 5, Windows 6, ColorShift 7, StarryNight 8. The two numberings differ for 7 and 8.

#### 3.5.6 Sleep and battery

* Sleep: see `0x08`. The UI range is 1-10 min; defaults are light sleep 2 min and deep sleep 30 min, both enabled (`T_RongYuanKeyboard_Profile.cs:194-201`).
* Low-battery alert: UI range 10-50 %, default 30.

### 3.6 Lighting [C]

#### 3.6.1 Effect id tables

* **Keyboard** (`Enum/RongYuanKeyboardEffect.cs`): Off 0, Static 1, Breathing 2, Neon 3, ColorWave 4, Ripple 5, StarryNight 6, Snake/ColorShift 7, PressActionOn 8, Coverge 9, ColorWaveW 10, Kaleidoscope 11, ColorWaveLine 12, Laser 13, Radar 14, Dazzing 15, RainDown 16, Meteor 17, PressActionOff 18, **Music 19** (audio sync), **Windows 20** (video/"Windows" sync).
* **Mouse:** see 3.5.5.
* **Mouse pad** (`Enum/RongYuanMousePadEffect.cs`): **Off 0xFF**, Static 0, Breathing 1, ColorWave 2, StarryNight 3, ColorShift 4, Music 5, Windows 6.

App `EffectType` names map onto these enums **by name** (`EffectType.cs`; `RongYuanDataConvert.cs:43-46`). UI menus: keyboard `KeyboardEffectMenu.cs:168-187`, mouse `MouseEffectMenu.cs:116-123`, pad `MousePadEffectMenu.cs:112-118`. Speed and brightness range 1..5 in the UI; brightness can't be changed for effect values 1/2 (FollowVideo/FollowAudio) (`CDevice_RongYuanKeyboard.cs:1308-1324`).

#### 3.6.2 Static effects

`SetEffectToDevice` → `SET_LEDPARAM 0x07` with board 3 (software profile) (`CDevice_RongYuanKeyboard.cs:1355-1399`; mouse `CDevice_RongYuanMouse.cs:1383-1427`; pad `CDevice_RongYuanMousePad.cs:596-627`, where the pad sends `07 00` with `LEDOnoff`).

#### 3.6.3 Onboard write sequence ("ApplyOnboard" / "SyncOnBoardProfile") (`CDevice_RongYuanKeyboard.cs:525-651`)

1. `GET_LEDPARAM(curBoard)`.
2. `SET_LEDPARAM` effect 0 (lights off).
3. Upload all macros: `0x0A` ×5 pages each, 100 ms between macros.
4. For each layer, `0x11`/`0x12` with 126 keys. Keys that are unmapped or disabled are filled from the JSON defaults.
5. `SET_PROFILENAME`.
6. `0x14`? No: `StopLedSync` (`0C .. [5]=0`), then `0x10` profile data.
7. Restore the LED param on the current board.

The mouse sequence is the same using `0x25`/`0x26`/`0x27`/`0x23`, with macro index `i+16·board` (`CDevice_RongYuanMouse.cs:554-664`).

#### 3.6.4 Live sync streaming (`0x0C`) — used for "Follow video", "Follow audio" and multi-device breathing sync

* **Start** (`RongYuanIO.cs:1161-1175`): `0C <effect> <speed> <brightness> <option> 01`. Effect = 20 (video) or 19 (audio) for the keyboard; 6/5 for the mouse and pad (`CDevice_RongYuanKeyboard.cs:1151-1157`, mouse l.1179-1185, pad l.418-423).
* **Stop:** `0C 00 00 00 00 00`.
* **Frame:** `0C <effect> <speed> 04 <option> 02 <randomFlag> <cks> <data>`:

  | Device | Video data | Audio data | Breathing data |
  |---|---|---|---|
  | Keyboard (`…Keyboard.cs:922-1118`) | 15 raw bytes = 5 zones × RGB from the screen sampler | 17 bytes: `R,G,B, Temperament[11], SideR,G,B`. Each Temperament byte packs two bands as nibbles; nibble = count of values >10 in a 22×6 spectrum grid; side lamp = colour × loudness fraction | 15 bytes = 5×RGB |
  | Mouse | 9 bytes: Left, Right, Middle RGB (from sampler bytes 0-2, 12-14, 6-8) | 4 bytes: R,G,B, level = ceil(v/255·8) | 9 bytes = 3×RGB |
  | Pad | 6 bytes: Left, Right RGB | 4 bytes, scaled colour, Temperament 2/0 | 6 bytes |

* BLE frames are truncated to 23 bytes (`06 56 17 …`). Dongle frames are preceded by `FE 17`.
* About once a minute the app re-reads `0x8C` and restarts streaming if the device dropped out. That check only runs on firmware ≥ 1297 (SPK8308), ≥ 1304 (SPK8508), ≥ 280 (SPK8708), ≥ 275/280/292 (SPK9308/9508/9708).

### 3.7 Events: input report ID 5, 3-byte payload `[code, v1, v2]` [C]

Source: `Util/RongYuanReportBuffUtil.cs:12-63`, `Enum/EVendorCodeDefinition.cs`. Handlers: `RongYuanKeyboard_Oper.cs:2313-2563`, `RongYuanMouse_Oper.cs:2400-2649`.

| code | Name | Handling |
|---|---|---|
| 0x01 | CurrentProfileReport | v1 = board 0..3, then notify `NotifyOnboardChange` |
| 0x02 | CurrentRateReport | ignored |
| 0x03 | CurrentKeyboardOption | Keyboard (payload must be exactly 3 bytes): v2=6 → gaming = v1 bit5; v2=4 → lights off = v1 bit4; v2=9 → lights on = (v1≠1). Mouse: v1==1 → lights off. |
| 0x04 | CurrentLEDEffectReport | v1 = effect id (updates the UI) |
| 0x05 | CurrentLEDSpeed | UI speed = v1+1. Vendor bug: compared against brightness, not inverted. |
| 0x06 | brightness | UI = v1+1 |
| 0x07 | CurrentLEDOption | direction = high nibble, colour mode = low nibble (7 → read `0x87` for RGB; 8 → rainbow) |
| 0x08-0x0B | side-LED effect/speed/brightness/option | Same as above. For the mouse, code 9 with v2=9 is a light on/off flag. |
| 0x0C | CurrentDPIReport | v1 = DPI index (mouse) |
| 0x0D | CurrentResetReport | device was reset; the app resets its model and board 0 |
| 0x0E | CurrentBatteryReport | v1 = % |
| 0x0F | FlashWriteReport | ignored |
| 0x1A | MacroKey | notify `NotifyMacroKeyPressed` |
| 0x1F | BatteryLowPowerReport | notify, reading the battery with `0x83` |
| 0x20 | BatteryCurrent | `current = v1 | (v2&0x7F)<<8`. Remaining time = capacity(3750 mAh keyboard / 750 mAh mouse) × % / current (`RongYuanKeyboard_Oper.cs:2378-2394`). |
| 0xFF | VendorKey | `keyId = v1 & 0x7F`, `Fn = v1 & 0x80`, `down = (v2==1)`; raised as `ButtonEvent` (2.5) when board 3 is active |

### 3.8 Connection and init sequences [C]

**Keyboard `InitDevice`** (`CDevice_RongYuanKeyboard.cs:115-176`):

1. `0x96` ×3 (profile names).
2. `0x83` (battery).
3. `0x8F` (ID code).
4. `0x85` (board). If it differs from the saved board: `0x05` + `0x85` (verify) + `0x05` retry (`SwitchBoard`, l.1653-1671).

**Then `ParameterToDevice(force)`** (l.669-743):

1. `0x87`.
2. `0x07` off.
3. `0x11` then `0x12`×2 (software board 3).
4. `0x06`.
5. `0x18`.
6. SPK8708 family only: `0x03`, `0x08`.
7. Effect (`0x07` or `0x0C` start).
8. If the current board ≠ 3, `0x07` restore.

**Mouse** (`CDevice_RongYuanMouse.cs` ~l.115-180, 686-760): the same idea with `0x26`/`0x27`, `0x22` + `0x04` (`method_7`, l.833-845), `0x18`, then (SPK9708 family) `0x17` %, `0x08`.

**Mouse pad** (`CDevice_RongYuanMousePad.cs:73-89`, `CDevice_RongYuanMousePadBase.cs` `method_0`): `0x8F`, then poll `0x98` every ~200 ms for up to 3000 ms while `bootUp==1`, then `0x18` (150 ms before and after) and the effect.

**Software-side only (no device I/O):** double-click speed and scroll speed change Windows settings (`RongYuanMouse_Oper.cs:2182-2200`). "Turn off lights when idle" is a global config (`GetSetupData`).

### 3.9 Per-call delays in wired/BLE mode (skipped for the dongle) [C] (`RongYuanIO.cs`)

| Call | Delay |
|---|---|
| SwitchBoard | 350 |
| GetBoard | 150 |
| GetLedSyncState | 150 |
| SetKeyboardProfileData | 300 |
| SetMouseEffectProfile | 250 |
| SetButtonValue | 250 (+250 for the second Fn write, always) |
| SetKeyboardButtonMatrix | 800 (+800 for Fn) |
| SetMouseButtonMatrix | 250 (always) |
| SetPowerSaving | 250 |
| GetPowerSaving | 150 |
| SetMacro | 350 |
| SetKeyboardOption | 250 |
| Set DPI | 300 |
| CheckCurrentBattery | 200 |
| SetReportRate | 250 |
| GetLedParam | 250 |
| SetLedParam | 250 |
| StartLedSync | 150 (before sending) |
| StopLedSync | 250 |
| SetBatteryThreshold | 150 |
| Set/GetProfileName | 250/150 |
| SetLogoLed | 150 |
| ClearMacroFlag | 150 |
| SetSleepTime | 150 |
| Reset | 2000 ms |

All in ms. These come on top of the 37 ms after every SetFeature and 7 ms after every GetFeature.

### 3.10 Macro byte format (RongYuan, onboard) [C] (`RongYuanDataConvert.cs:344-449, 539-582`)

```
u16 LE  playCount (>=1)
event 0 : code 0x01 (dummy), UP, delay = original first event's delay
event k : code, then delay/action encoding
   code  : keyboard -> HID usage (Windows Keys -> USB usage); mouse -> 0xF0 L,0xF1 R,0xF2 M,0xF3 back,0xF4 fwd
   delay : if 1<=d<=127 : 1 byte  (d | 0x80 if key-DOWN)
           if d>127     : 3 bytes (0x80 if DOWN else 0x00), d & 0xFF, d >> 8
```

* Each event's delay is the delay **after** it (the list is shifted by one; the last is forced to 1 ms).
* At most 62 events and 16 macros per profile. The 255-byte buffer is zero-padded.
* Only "hardware" macros (`IsComMacro`) are written.
* Units are ms **[I]**.

---

## 4. BeiYing SPK8618 / KB_K916 (`KBAccess_SPK8618.dll`)

### 4.1 Managed side [C]

Source: `work/dotnet-clean/Zeasn.USB.BeiYing.Lib/**`, `Zeasn.Equipment.Option.Lib/Option.BeiYing.KB_K916/*.cs`.

* `KB_K916_DllWrapper.cs:137-162` loads `lib/BeiYing/KBAccess_SPK8618.dll` for DeviceType 201000 and 201001, binding delegates by field name. Everything is cdecl (`KB_K916_DllConstraints.cs`).
* **Functions the app actually calls:** `OpenDevice(Extra, hwnd=0, notifyCb, ref err)`, `CloseDevice`, `IsDeviceOnline` (==1), `GetDevVersion`, `SetLED(tDev, 0, ref BeiYingLightData)`, `SetKey(tDev, 0, layer 0/1, int[126] as 504 bytes)`, `ClearMacro`/`new_key_action`/`AddMacro`/`SetMacro`, `SendMusicData(tDev, 378 bytes)`, `ReadBattery`.
* **Never called:** `SetMultiBoard`, `SetLayerCount`, `ReadLED`, `Set/ReadCFG`, `Set/ReadKeyColor`, `Set/GetOnBoard`, `ReadKey`, `ResetDevice`, `Set/GetUserData`, `ReadMacro`/`PickMacro`, `ExportLog`, `SetDebug`.
* Controller retries (`KB_K916_Controller.cs`):
  * Before most calls, if the handle is invalid or offline (USB only), re-open up to 3× with 500 ms waits (l.96-125).
  * `SetLED`: up to 3×, 200 ms after each (l.201-227).
  * `SetKey`: up to 3×, 200 ms after each, +300 ms on failure (l.298-333).
  * `ReadBattery`: up to 3×, 500 ms (l.406-425).
* `BeiYingLightData` (`Structs/BeiYingLightData.cs`, `Pack=1`, **34 bytes**; `bool` marshals as a 4-byte BOOL): `int nMode, int nBri, int nSpeed, BOOL bColorFull, uint clrLight (R | G<<8 | B<<16), int bIsGameMode, int nGameIndex, int nTapTime, short nSleepTime`.
  * Filled by `BeiYing_KB_K916_DataConvert.ConvertEffectInfo`: `nMode` = `BeiYingKeyboard_Light_Mode` (Off 0, Static 1, Breathing 2, Neon 3, Laser 4, RainDown 5, RainbowRoulette 6, ColorWaveLine 7, StarryNight 8, ColorShift 10, ColorWave 11, PressActionOn 12, ColorWaveW 13, RotaryWindmill 15, RainbowFalls 16, Kaleidoscope 17, SelfDefine 20); `nSpeed = min(ui, 4)`; `nBri` = ui (1 → 0).
  * `nSleepTime = LightSleepTime(min) × 2` (0 = off; UI 1-100) (`CDevice_BeiYing_KB_K916.cs:~520-535, 930-952`).
* Notifications: callback `(tDev, nMsg, p1, p2)` (`CDevice_BeiYing_KB_K916.cs:232-293`):
  * nMsg 1 = Connect (p1==1 connected). For the dongle, debounce 5000 ms after connect and 500 ms after disconnect, then re-check.
  * nMsg 2 = Power: p1 = battery %, p2 high nibble 1 = charging, low nibble 1 = full.
  * nMsg 3 = Board and nMsg 4 = CustomKey are delivered but ignored.
* Connection check (`CDevice_BeiYing_KB_K916.cs:118-230`): VID/PID present in `UsbList` → `OpenDevice(Extra)` → `IsDeviceOnline`. After a new connect, wait 2500 ms (wired) or 1000 ms (dongle), then `OnConnect`.
* Mode handling is BeiYing-specific: there are no onboard profiles (`IsSupOnBoard=false`), and "FollowVideo/FollowAudio/Breathing-sync" run by streaming `SendMusicData` frames (4.6.5).

### 4.2 The `Extra` string: VID, PID and a 6-byte device password [C] (`KBAccess_SPK8618.dll.c` `FUN_10001020` l.24-117, used by `OpenDevice` l.148-287)

The 30 hex characters are parsed as 15 bytes `b0..b14`. With `rotr(x, s)` meaning an 8-bit rotate right:

* `s1 = (b0 + 0xAD) & 0xFF`, `PID = rotr(b3, s1)<<8 | rotr(b1, s1)`
* `s2 = (b4 + 0xAD) & 0xFF`, `VID = rotr(b7, s2)<<8 | rotr(b5, s2)`
* `s3 = b8 − 0x53`, `psd[0..5] = rotr(b9..b14, s3)`

Decoded (I computed these by hand from the JSON strings):

| DeviceType | VID:PID | psd (expected device password) |
|---|---|---|
| 201000 wired (`57d0c1…04dd`) | 25AA:200D | `03 00 00 00 01 77` |
| 201001 dongle (`55248a…1077`) | 3554:FA09 | `03 00 00 00 01 77` |

`OpenDevice`:

* Enumerates all HID interfaces whose path contains `VID_%04x&PID_%04x` and records caps and report ID per collection (`FUN_10007980`).
* First tries the **G5 driver** (4.3). If that fails, it tries the **3632 driver** (4.4).
* Either driver rejects a collection unless GetPsd returns the expected 6 bytes ("Psd unmatch" log).
* DLL version reported: `0x40`.

### 4.3 Transport "G5" (wired keyboard) [C] (`FUN_10005fd0` l.3858-3957; I/O `FUN_10007620` and `FUN_10006240…10007420` l.3959-4990)

* **Collection match:**
  * VID/PID match.
  * `FeatureReportByteLength == 0x208` (520).
  * Report ID ∈ {6, 9}.
  * Either (UsagePage `0xFF00` and Usage 1) or (UsagePage `0xFF02` and Usage 1 or 2).
  * Opened with `CreateFileW(access 0x12019F, share 3, OPEN_EXISTING, OVERLAPPED)`.
* **Frame** (520-byte feature report):

```
[0] RID (6 or 9, from the matched collection)   [1] cmd
[2] p3   [3] p4   [4] total packets = ceil(len/512)   [5] packet index
[6..7] chunk length LE (<=512)   [8..519] data
```

* **Write** (op 1): per packet, busy-wait `pre` ms (20; 7 for music), then `HidD_SetFeature(520)` with up to 3 tries and 50 ms between.
* **Read** (op 2, cmd|0x80): per packet, wait 20 ms (40 ms for `0x85`), `SetFeature(header)`, wait 20 ms, `HidD_GetFeature(520)`, then copy `[8..8+len)`.
* **Input:** if `InputReportByteLength == 8`, a thread reads 8-byte input reports (`FUN_10005b90` l.3618-3709). `[1]==0x0A` marks a notification; `[2]` = 2 Connect(p1=`[3]`), 5 Power(p1=`[3]`, p2=`[4]`), 7 Board(`[3]`), 8 CustomKey(`[3]`).
* **FW version** = `HidD_GetAttributes().VersionNumber` (USB `bcdDevice`) (`GetDevVersion` l.316-329).
* **Online** is always 1 while open (vtable+0x5C = `FUN_10004210` returns 1).

### 4.4 Transport "3632" (2.4 GHz dongle) [C] (`FUN_100047c0` l.2545-2671; `FUN_10005110` l.3092-3260; `FUN_100055c0` l.3326-3533)

* **Collection match:** UsagePage `0xFF02`, Usage 2, Input=Output=**20 bytes**, report ID **0x13**.
* **Online test:** cmd `0x07` read 1 byte (0 = keyboard asleep or out of range).
* **Password:** cmd `0x05` read 6 bytes.
* **Packet** (20-byte output report, `WriteFile`, 500/1000 ms timeout, up to 3 retries):

```
[0]=0x13 [1]=cmd [2]=total packets (ceil(len/14)) [3]=packet index
[4]= (sub<<4) | (chunkLen & 0x0F)      [5..18] data (<=14 bytes)
[19]= checksum = (sum of bytes [0..18]) & 0xFF
```

* **Write ack:** for cmd < 0x80 and cmd ≠ 0x06, wait for an input report with `([1]&0x7F)==cmd`. Allow up to 10 mismatches and a 5000 ms timeout (8000 ms via the service thread's ring buffer). Retry the packet up to 5× on timeout. Busy-wait 15 ms before each packet.
* **Read:** send the request `[0x13, cmd, 1, 0, sub<<4, 0…, cks]`, then collect responses `[0x13, cmd, total(&0x7F), idx, len(&0x0F), data(14)…]`:
  * `[1]` with bit7 set means a CRC error: resend.
  * Duplicate indices are ignored.
  * Done when `idx == total−1` or enough bytes have arrived.
  * An index gap is a "package leak": retry up to 5× (200 ms).
  * Per-read timeout 1000/8000 ms; 5 overall tries with 50 ms between.
* **Notifications** (service thread `FUN_10004340`/`FUN_100044f0` l.2279-2399): `[1]==0x0A`, `[5]` = 2/5/7/8 as in G5. The payload position of p1/p2 is not recoverable from the decompilation. **[I]:** bytes 6-7.
* **Sub-parameter:** SetMatrix/GetMatrix/SetLED/… use `sub = layer` (or `board*4 | layer` in multi-board mode, which is never enabled).

### 4.5 Operation → command map

Vtables were read from the DLL `.rdata`: G5 at file offset `0x1BC3C`, 3632 at `0x1B874`. Handlers were matched to exports by vtable offset. [C]

| vtable | Operation | G5 cmd (write / read) | 3632 cmd (write / read) | Size |
|---|---|---|---|---|
| +0x18 | GetPsd | – / `0x82` ([2]=1) | – / `0x05` | 6 |
| +0x1C | GetBattery | – / `0x87` | – / `0x4A` | 2 **[I]** (`[0]`=%, `[1]`=charging<<4 \| full) |
| +0x20/+0x24 | Set/GetMatrix (keys) | `0x03` ([2]=layer,[3]=board) / `0x83` | `0x01` (sub=layer) / `0x41` | 512 |
| +0x28/+0x2C | Set/Get macro area | `0x05` / `0x85` | `0x03` (sub=page, 512-byte pages, 100 ms between) / `0x43` | ≤4096 |
| +0x30/+0x34 | Set/Get LED/config block | `0x04` ([3]=board) / `0x84` | `0x04` / `0x44` | 128 |
| +0x38/+0x3C | Set/Get per-key colours ("Game") | `0x06` ([2]=idx,[3]=board) / `0x86` | `0x02` / `0x42` | 378 (3×126 planes) |
| +0x40/+0x44 | Set/Get LED RGB table | `0x0A` ([3]=board) / `0x8A` | `0x09` / `0x49` | 512 / 420 |
| +0x48/+0x4C | Set/Get onboard | `0x10` (1 byte) / `0x90` | `0x10` / `0x11` | 1 |
| +0x50/+0x54 | Set/Get user data | `0x71` / `0xF1` | `0x71` / `0x72` | any |
| +0x58 | SendMusicData | `0x08` (7 ms pre-delay, raw 378 bytes) | `0x88` (no ack, compressed; see 4.6.5) | |
| +0x5C | GetOnline | always 1 | `0x07` read 1 | |
| +0x60 | ResetMatrix | `0x11` 1 byte (bit0=a, bit1=b, 0 if c) + 50 ms | `0x06` 1 byte + 50 ms | |

### 4.6 High-level operations

#### 4.6.1 `SetLED(tDev, board, data)` (`SetLED` l.464-583) [C, offsets I]

Buffer offsets are consistent between `SetLED` and `ReadLED`; the decompiler's stack offsets were reconciled by hand.

1. Wait 30 ms, then read the 128-byte block (`0x84`/`0x44`). Retry until `blk[0x7E..0x7F] == 5A A5` (up to 5×, 100 ms apart).
2. Modify the block:
   * `blk[0x0A] = nMode`.
   * If nMode > 0: `blk[0x38+2·mode] = nBri` and `blk[0x39+2·mode] = (bColorFull ? 7 : 0) | nSpeed<<4`.
   * `blk[0x38..0x39] = FF FF`.
   * `blk[0x16] = nTapTime`, `blk[0x18] = nSleepTime`.
   * From `ReadLED`/`SetKeyColor`: `blk[0x09]` = game-mode flag and `blk[0x0B] = 0x20 + gameIndex`.
3. Wait 30 ms, then write the block (`0x04`).
4. If nMode ≠ 0 and not colourful:
   * Wait 50 ms, then read the RGB table (`0x8A`/`0x49`, 420 bytes = 20 modes × 21 bytes).
   * The colour of mode m lives at `tab[m·21 + 0..2]` = R, G, B.
   * If it differs, update it, set the signature `5A A5` near the end of the 512-byte buffer (offset `0x1FE` **[I]**; the decompiler says `0x1FA`), wait 80 ms, and write (`0x0A`/`0x09`, 512 bytes).

#### 4.6.2 `SetKey(tDev, board, layer, int[126])` (l.1130-1300) [C]

Reads the current 512-byte matrix, translates each non-zero *API* value to a *device* entry, writes it back with signature `00 00 5A A5` at offset `0x1FC..0x1FF`, and pre-waits 20 ms and 30 ms. API value = `b0<<24 | b1<<16 | b2<<8 | b3`, i.e. little-endian bytes `[b3,b2,b1,b0]` = `[type, x, y, z]`.

| API (LE bytes) | Built by (`BeiYing_KB_K916_DataConvert.cs`) | Device entry (LE bytes) |
|---|---|---|
| `FF FF FF FF` | Disable | `00 00 00 00` |
| `0` | not set | keep the current entry |
| `[00, mods, 00, VK]` | keyboard (VK = Windows virtual key; mods = BeiYing modmask, same bits as RongYuan) | `[00, mods, 00, HID(VK)]` (VK→HID table in 4.7) |
| `[00,00,00,FA]` / `[00,00,00,FB]` | Fn / Fn2 (`KB_K916.json` "0xFA000000") | `[0D,00,00,00]` / `[0D,01,00,00]` |
| `[01, 00, code, 00]` | media | `[02, 00, hi, lo]` consumer usage, big-endian in bytes 2..3: code 0x21→0x0183, 0x22→0x00CD play, 0x23→B7 stop, 0x24→B6 prev, 0x25→B5 next, 0x26→E9 vol+, 0x27→EA vol−, 0x28→E2 mute, 0x30→018A mail, 0x31→0192 calc, 0x32→0194, 0x33..0x39→0221,0223,0224,0225,0226,0227,022A (browser) |
| `[02, idx, mode, count]` | macro (mode 1 = N times, 2 = toggle, 4 = while held; count ≤255) | `[03, mode, count, idx]` |
| `[03, x, 00, 00]` | mouse button (x: 0 L, 1 R, 2 M, 3 fwd, 4 back) and, oddly, device functions | `[01, tbl[x], 01, 00]`. `tbl` isn't readable from the decompilation; the `ReadKey` inverse gives `{0→1, 1→2, 2→3, 3→5, 4→4}` **[I]** |
| `[04, a, 00, 00]` | – | `[04, 00, 00, a]` |
| `[5..9, …, …, 07]` | – | passed through unchanged |
| byte3 & 0xC0 == 0xC0 | raw values from JSON (for example `0xEDBAEA38`) | `bswap(v & 0x3FFFFFFF)`, i.e. raw device bytes |
| else | – | `00 00 00 00` |

Key slots and default API values come from `res/data/BeiYing/KB_K916.json` (82 records; `ButtonID`, `ButtonDefValue` and `ButtonFnValue` as hex strings; loaded by `KB_K916_DictMgr.cs:107-139`). Examples:

* ESC `0x1B000000` (Fn `0x4D541F48`)
* LShift `0x0200`
* Fn key (id 59) `0xFA000000`
* F7..F12 Fn = media `0x240001`, `0x220001`, `0x250001`, `0x280001`, `0x270001`, `0x260001`
* Fn+F3 `0x9000800` (Win+Tab), Fn+F4 `0x45000800` (Win+E)
* `0x7FFC`, which translates to "disabled"

#### 4.6.3 Macros

* **`new_key_action(vk, press, delay, out, 6)`** (l.1491-1585) returns 4 bytes:
  * `[0] = (type<<4) | ((delay>>16)&0xF) | (press ? 0 : 0x80)`, `[1] = delay>>8`, `[2] = delay & 0xFF`, `[3] = code`.
  * type 1 = keyboard (code = HID; VK 0x10/0xA0→E1, 0x11/0xA2→E0, 0x12/0xA4→E2, 0x5B→E3, 0x5C→E7, 0xA1→E5, 0xA3→E4, 0xA5→E6, others via the 4.7 table).
  * type 2 = mouse (VK 0xF0..0xF4 → button mask 1, 2, 4, 8, 0x10).
  * type 5 = wheel (0xF5 → +1, 0xF6 → 0xFF).
  * delay is 20-bit, ≥100 enforced by the C# (`ConvertMacroData`); it has the same "delay-after" shift as RongYuan and a dummy leading `A`-key UP event.
* **Macro container** (`AddMacro`/`SetMacro`, l.1602-1710):
  * A directory of N × `{u16 offset, u16 length}` entries (offset absolute from the container start, directory included).
  * Then N records `{u8 nameLen, name bytes (the app passes no name), action bytes}`. `length = 2·nameLen + 1 + dataLen`; the `2·` is a vendor bug.
  * Total ≤4096. Written with +0x28.
* Macro index = order of `AddMacro` (`CDevice_BeiYing_KB_K916.cs:451-503`).

#### 4.6.4 Battery and version

`ReadBattery` → +0x1C. `GetDevVersion` = USB `bcdDevice` (the UI shows `V%04X`).

#### 4.6.5 `SendMusicData(378 bytes)`: 126 keys × RGB, a full per-key frame

* Key k is at `k·3`.
* The app lays the keyboard out as 16 columns × 6 rows: `index = col·6 + row` (`CDevice_BeiYing_KB_K916.cs:568-697`).
* **G5:** raw write with cmd `0x08`.
* **3632** (`FUN_10004ea0` l.2957-3057): groups keys by identical non-zero colour (≤64 groups) and serializes `{R, G, B, count, keyIdx…}` records (≤200 bytes total), sent as cmd `0x88`, sub 1, no ack, 10 ms pre-delay.

This is the **only per-key RGB path the app uses** (video, audio and breathing sync). `SetKeyColor` (static per-key colours) is never called.

### 4.7 VK→HID table [C] (dumped from DLL `.rdata` at VA `0x1001ABF0`, file offset `0x199F0`, 0x71 pairs)

Standard Windows VK → USB usage: A-Z → 04-1D, 1-0 → 1E-27, F1-F12 → 3A-45, arrows 4F-52, keypad 59-63, Ins/Home/PgUp/Del/End/PgDn 49-4E, PrtSc 46, Scroll 47, Pause 48, Menu 65, NumLock 53, modifiers E0-E7. Non-obvious entries:

* `VK 0xE2→0x64` (non-US `\`), `0xFD→0x58` (keypad Enter), `0xC2→0x85`, `0xC1→0x87`, `0xC3→0x89`, `0xD8→0x32`, `0xDA→0x8A`, `0xD7→0x88`, `0xEB→0x8B`.
* `0xFA→0x20`, which looks like a vendor quirk.

A Linux port can use any standard VK→HID map, but should keep these entries.

---

## 5. HaiHui SPK9618

### 5.1 "3395" variant: C# protocol, same framing as RongYuan [C]

Code: `work/dotnet-clean/Zeasn.USB.HaiHui.Lib/Zeasn.USB.HaiHui.Lib.M3395/*.cs`; device logic `Zeasn.Equipment.Option.Lib/Option.HaiHui.Mouse.M3395/*.cs`.

**Transport** (`M3395_DeviceService.cs`):

* Primary handle: the VID/PID/usage-page `0xFFFF`/usage 1 match, with an async input reader (l.129-225). Second handle: the `Extra` path `…&mi_02` (l.167-193).
* Every command is a 64-byte block with the **RongYuan checksum** at `[7]` (l.733-748).
* **USB SET** = `HidD_SetFeatureReport(second, ID 0, 64)` + 10 ms (l.619-639). **USB GET** = SET, then GET 64 bytes, then 10 ms (l.641-670).
* **After every `Set`** the service sleeps 10 ms and issues `Get(GetReturnRate 0x88)` as a sync read (l.672-698).
* **Dongle SET** (l.487-550): up to 3 polls of `F7` (offline check on `[4]` for mice; wait 50 ms while `[5]!=1`), then `F6 05`, then the command.
* **Dongle GET** (l.552-617): after the poll, `FC`, 10 ms, SET the request, 10 ms, GET 64 bytes. Note this order differs from RongYuan.
* **Dongle online loop:** every 2000 ms, `F7`; battery = `[2]` (mouse), which raises notice `[0x0E, battery, 0]` (l.411-485).
* **BLE** (l.227-376):
  * The handle is found by `Extra` (`vid&023151_pid&503c`) plus usage page `0xFF55` usage `0x0202`.
  * Writes are `06 55 <64>`.
  * Responses with `[1]==0x55` are stored; a GET polls 4 × 100 ms for `resp[0]==cmd`.
  * `[1]==0x66` means a notice (`[2..4]`).
  * The BLE mouse VID/PID is `0x3151:0x503C` (from the Windows BLE HID path format `vid&02<VID>_pid&<PID>`, VID source 2) **[I]**.

**Commands used** (`CmdType.cs`; `M3395_Controllers.cs`):

| Cmd | Name | Layout |
|---|---|---|
| `0x00` | SetKey | `[1]=key index 0..15`, `[8..11]`=4-byte code (l.163-173) |
| `0x01` | SetAllKey | page 0: `[2]=0`, keys 0..13 at `[8+4i]`; page 1: `[2]=1`, keys 14..15 (l.97-161) |
| `0x03` | SetTargetMacro | `[1]=macroIdx 0..15, [2]=page, [3]=total length (255 if 256), [4]=last`; chunks of 56,56,56,56, then 32 bytes (max 256) (l.256-305) |
| `0x08` | SetReturnRate | `[1]`: 125 Hz=8, 250=4, 500=2, 1000=1, **2000=0x84, 4000=0x82, 8000=0x81** (l.237-254) |
| `0x0E` | SetMouseReset | (l.307-312) |
| `0x10` | SetSensorDPI | `[2]=curIndex, [3]=count`, X u16 LE ×8 at `[8..23]`, Y u16 ×8 at `[24..39]`, RGB ×8 at `[40..63]` (l.175-224). Default list 400 red, 800 blue, 1600 green, 3200 yellow, 6400 cyan-ish, 36000 magenta; range 400-36000 (`T_HaiHui_9618_3395_Mouse_Profile.cs:88-128`) |
| `0x11` | SetSensorLift (LOD) | `[1]=1` if LOD "2", else 0 (l.226-235) |
| `0x88` | GetReturnRate | used as a post-write sync |
| `0x8A` | GetBattery | `[1]`=%. The UI treats 0 as 100 and, on USB, 100 as full and anything else as charging |
| `0x8F` | GetMouseVerAndId | `[1..4]` id u32 LE, `[5..6]` fw u16 LE (shown `V%03X`) |

Defined in `CmdType.cs` but unused: debounce 0x04, middle-button-up time 0x05, 2.4G/BLE sleep 0x06/0x07, recoil compensation 0x09, down count 0x0B, key low-latency 0x0C, angle 0x12, ripple 0x13, motion-sync 0x14, FPS20000 0x15, profile enable 0x16, effect 0x17, angle tune 0x18, all-param 0x1F, clear bind 0x6F, **upgrade mode 0x7F**, receiver version 0xF0, receiver RF address 0xFA/0xFB. HaiHui `UpgradeFw` returns an error (`HaiHui_9618_3395_Mouse_Oper.cs:1782-1785`).

**Key codes** (`HaiHui_9618_3395_DataConvert.cs:50-424`):

* Mouse, wheel, DPI, double-click and smart-DPI codes are **identical to RongYuan** (3.4).
* **Keyboard:** `00 <mod1 HID usage> <mod2 HID usage> <key usage>`. Modifiers are **usages 0xE0-0xE7, not a bitmask**, with at most 2. With more than 2 modifiers, the key becomes a macro (`09 00 <buttonId> 00`) whose content is generated: `01 00` count, then presses/releases at 10 ms.
* **Media:** `03 00 <usage lo> 00`.
* **Macro binding:** `09 <mode 0 N-times / 1 toggle / 2 held> <macroIdx = buttonId> 00`.

**Macro bytes** (l.542-641): the same as RongYuan (count LE16, delay encoding), except the dummy first event code is `0x04`. The buffer is terminated with `00 00` and limited to ≤62 events and ≤256 bytes.

**Notices** (input report 5; `CDevice_9618_3395_Mouse.cs:85-140`): `[0x0C, dpiIndex]` updates the UI DPI index; `[0x0E, battery]` updates the battery.

**Mode exclusivity:** when one variant (wired, 2.4G or BLE) connects, the others are forced disconnected (`CDevice_9618_3395_Mouse.cs` `method_2`).

### 5.2 "8960" variant: YJX SDK DLL (closed) [C API, protocol → Cross-references]

`Zeasn.USB.HaiHui.Lib.M9618.*` wraps `lib/YJX/Mouse_SPK9618_8960.dll` (wired) and `…_24G.dll` (dongle) (`M_9618_DllWrapper.cs:202-209`).

**Exports used** (`M_9618_DllConstraints.cs`, `M_9618_Controllers.cs`): `YJXSDK_Init/UnInit/FindDevice/OpenDevice(vid,pid,0)` (after `OpenDevice`, `RegisterDeviceStatusNotify` then a 2000 ms sleep), `DeviceIsOnline`, `GetDeviceVersion(fw, dongle)`, `GetDeviceMode`, `GetDeviceBatteryInfo`, `Get/SetAllKeyInfo`, `SetKey`, `ResetKey`, `ResetAllKey`, `Get/SetMouseInfo`, `SetLightMode`, `SetDPICount/Index/Value/Color`, `SetReportRate` (1=125…4=1000 Hz), `SetSilenceHeight`, `SetKeyDebounceTime`, `SetSrollFlag`, `SetSleepTime`, `SetHighSpeed`, `SetMotionSync`, `SetAngleSnapping`, `SetRippleControl`, `SetMoveOffLed`, `SetMouseMacro`, `RestoreFactorySettings`, `FirmwareUpgrade(buf, len)`.

**Structs** (`M_9618_Struct.cs`):

* `YJX_KEYINFO {int profile, keyValue, keyType, keyCode1..3}`
* `YJX_MOUSEINFO {u8 profile, workMode, isOnline, battery, chargeFlag, lightMode, dpiCount, dpiIndex; int dpi1..7; int dpi1..7RGB; u8 reportRate, silenceHeight, debounce, scrollFlag; int sleepTime; u8 highSpeed, motionSync, angleSnap, ripple, moveOffLed}`
* `YJX_RECORD {int state, type, value, delay; s8 dx, dy}`
* `YJX_MACROINFO {int index, count; YJX_RECORD[1000]}`

Enums: `YJX_KEY_TYPE`, `YJX_MOUSEKEY_TYPE`, and `YJX_NOTIFYMSG_TYPE` (1 online, 2 battery, 3 DPI, 4 report rate, 5 FW update).

**Native quick look [I]** (`work/native/Mouse_SPK9618_8960.dll.c`; the full analysis belongs to the YJX report):

* A near-copy of the YJX `Mouse_SPK9618.dll`.
* Matches HID UsagePage `0xFF06`, trying usage 2 and then usage 1 (l.~4190-4225).
* Knows PIDs `0x401B`/`0x401A` (and `0x200F/0x2010/0x2011/0x2012`, and VIDs `0xA8A4/0xA8A5`) (l.2146-2330).
* Uses `WriteFile`/`ReadFile` (output/input reports) plus `HidD_Set/GetFeature`.

**Firmware upgrade** (`HaiHui_9618_8960_Mouse_Oper.cs:1765-1797`): only over USB. It reads `<path>/<name>/<name>.bin` (downloaded by the renderer) and calls `FirmwareUpgrade`.

---

## 6. Linux port plan (this area)

### 6.1 Recommendation

The user has no Philips peripherals. **Ship the Linux port without peripheral support by default.** Keep the `Equipment.Base` concepts only as far as the display pipeline needs them (the display framework `GClass3` is covered in the DDC report). Implement peripherals behind a compile-time or runtime flag, in this order of value and confidence:

1. RongYuan wired (C# protocol fully visible).
2. HaiHui 3395 wired (same framing).
3. RongYuan/HaiHui dongle.
4. BLE.
5. BeiYing (reimplements a closed DLL; medium confidence).
6. HaiHui 8960 (depends on the YJX report).

### 6.2 Architecture

* A user-space daemon talks to `/dev/hidrawN` directly. No kernel module and no libusb (hidraw keeps the kernel's HID drivers bound, so the keyboard or mouse keeps working).
* Recommended: `hidapi` with the hidraw backend, or raw `ioctl`s:
  * `HIDIOCGRDESC` + `HIDIOCGRDESCSIZE`: report descriptor, for usage-page and report-ID matching.
  * `HIDIOCGRAWINFO`: bus, VID, PID.
  * `HIDIOCSFEATURE(len)` / `HIDIOCGFEATURE(len)`: feature reports. `buf[0]` = report ID; use 0 for unnumbered reports (the kernel strips it for USB).
  * `write()`/`read()`: output and input reports. The buffer starts with the report ID when the device uses numbered reports.
* Device-to-model mapping: a static table equal to section 1. Load `PCenter_DeviceInfo.json` and the two key tables, or embed them.
* Hot-plug: a `libudev` monitor on `subsystem=hidraw` replaces `SetupDi` enumeration and `WM_DEVICECHANGE`. Match on `HID_ID=0003:000025AA:0000xxxx` (USB) or `0005:…` (BLE) from the parent `hid` device uevent. Find the USB interface number from `HID_PHYS=…/inputN`, or from the sysfs parent `bInterfaceNumber`.
* FW version on wired USB = `bcdDevice`. Read `/sys/class/hidraw/hidrawN/device/../../bcdDevice`, or `ID_REVISION` from udev.

### 6.3 Per-transport implementation notes

**RongYuan and HaiHui 3395, wired or dongle:**

* **Command node:** the hidraw node of USB interface 2 (interface 1 for the SPL7508 pad). Confirm it has an unnumbered Feature report of 64 bytes.
* **I/O:**
  * `set(block)`: fill the checksum, then `ioctl(HIDIOCSFEATURE(65), [0x00] + block)`.
  * `get(block)`: `set(block)`, sleep 10 ms, then `ioctl(HIDIOCGFEATURE(65), [0x00] + zeros)`; the result is `buf[1..64]`.
  * Keep the vendor's 37 ms and 7 ms post-delays and the per-call delays (3.9). The firmware may rely on them, and nobody can test this.
* **Event node:** the hidraw node whose descriptor contains a collection with UsagePage `0xFFFF` and Usage 1 (pad: usage 2) and an **Input report with ID 5** (3 data bytes). Read it continuously; each read returns `05 code v1 v2`.
* **Dongle:** implement the `F7`/`F6`/`FC`/`FE` state machine exactly as described in 3.2.2 and 5.1. Note the different GET order for RongYuan and HaiHui.

**RongYuan and HaiHui BLE:**

* The hidraw node sits on bus `0x0005`. RongYuan keyboard VID/PID is `25AA:2007`; HaiHui is `3151:503C`.
* Select the node whose descriptor contains an output/input report ID 6 of 65 bytes. HaiHui's is in the usage page `0xFF55` / usage `0x0202` collection.
* `write([0x06, 0x55] + block)` (66 bytes); read input reports `06 xx …`.
* Linux merges all top-level collections into one hidraw node, so the Windows `&0&0005#` collection filter goes away.

**BeiYing G5 (wired `25AA:200D`):**

* Find the node whose descriptor has a Feature report with ID 6 or 9, 519 data bytes, in usage page `0xFF00` (usage 1) or `0xFF02` (usage 1/2).
* `HIDIOCSFEATURE(520)` / `HIDIOCGFEATURE(520)` with `buf[0]`=RID. Frame as in 4.3.
* Verify the password: `0x82`, read 6 bytes, expect `03 00 00 00 01 77`.
* If the collection has an 8-byte input report, read notifications from it.

**BeiYing 3632 (dongle `3554:FA09`):**

* Find the node with report ID `0x13`, 20-byte input and output reports, in usage page `0xFF02` / usage 2.
* `write(20 bytes)`, `read(20 bytes)`, filtered on `buf[0]==0x13`.
* Implement the ack and packet assembler from 4.4. Verify the password with `0x05`.

**HaiHui 8960 / YJX:** implement from the YJX report, or leave unsupported. The SDK's own protocol is not specified here.

### 6.4 udev rules (grant the logged-in user access; no root daemon needed)

```
# /etc/udev/rules.d/70-evnia-peripherals.rules
# RongYuan / HaiHui / BeiYing-wired (VID 25AA) - USB
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="25aa", ATTRS{idProduct}=="2005|2006|2007|2008|200d|4005|4006|4007|4008|4018|4019|401a|401b|8002", TAG+="uaccess"
# BeiYing SPK8618 2.4 GHz dongle
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3554", ATTRS{idProduct}=="fa09", TAG+="uaccess"
# BLE (hid-over-gatt via uhid has no USB ATTRS; match the HID parent name)
SUBSYSTEM=="hidraw", KERNELS=="0005:25AA:2007.*", TAG+="uaccess"
SUBSYSTEM=="hidraw", KERNELS=="0005:3151:503C.*", TAG+="uaccess"
```

(`ATTRS{idProduct}` does glob-style `|` alternation. If a distro's udev version lacks it, split into one line per PID.)

### 6.5 What to drop or replace

* Software-macro playback and "launch program" key actions (`MacroMgr`): replace with `uinput` and `xdg-open`, or drop.
* The Windows double-click and scroll-speed "mouse" settings: they change OS settings, not the device. Drop them or map them to desktop settings.
* Screen and audio "follow" sync (the source of the `0x0C` and BeiYing music frames): see the screen-capture and audio-capture reports. Implement with PipeWire, or drop.
* Firmware update for these devices (cloud): drop (7).
* BeiYing debug logging to `BYDllLog.txt` (the DLL writes it to a shell special folder) goes away with the DLL.

### 6.6 Verification without hardware

* Build a **protocol simulator** from this spec (a fake hidraw via `uhid`, i.e. `/dev/uhid`, with a synthesized report descriptor). Unit-test framing, checksums, paging, the dongle state machine and the 3632 assembler against it.
* Golden vectors worth pinning:
  * RongYuan `GET_REV`: `80 00 00 00 00 00 00 7F`.
  * `SwitchBoard(3)`: `05 03 00 00 00 00 00 F7`.
  * HaiHui `GetBattery`: `8A 00 … [7]=0x75`.
  * 3632 GetOnline request: `13 07 01 00 00 …`, checksum = `0x13+0x07+0x01 = 0x1B`.

---

## 7. Online touchpoints (this area)

| What | Where | Trigger | Recommendation |
|---|---|---|---|
| Firmware-update identifiers `DP_DeviceType` / `DP_ComponentID`: `EVNIA_KB_<Model>_<VID>_<PID>_<IDCode>`, `EVNIA_MS_…`, `EVNIA_MT_…` (mouse pad) | Built in `CDevice_RongYuanKeyboard.cs:131-141`, `CDevice_RongYuanMousePad.cs:84-87`, `CDevice_9618_3395_Mouse.cs:52-53` (and RongYuan mouse `InitDevice`). Exposed as `DeviceInfo.ExtDeviceInfo`. **Sent by the renderer** in `work/app-pretty/renderer/assets/styles-DAnQi2A8.js:33075-33110` (`Mv` → `Ev.get("/component/update", {brandId, components:"<componentId>=<version>", deviceType, language, ruleMac:<MAC>, …})`), called from l.33858-33870 and 34448-34460. | Opening the firmware page or checking a device | **Strip.** Don't build these IDs and remove the firmware UI. The `IDCode` from `0x8F` can stay local (colour variant). |
| Device firmware flashing (HaiHui 8960) of a downloaded `.bin` | `HaiHui_9618_8960_Mouse_Oper.cs:1765-1797` → `YJXSDK_FirmwareUpgrade` | User runs a firmware update after the renderer downloads a package (`packageUrl`) | **Strip.** No other device in this scope can flash (RongYuan `0x7F` and HaiHui 3395 `0x7F` are defined but never sent). |
| Device "basic info" summaries (`AnalyseBasicInfo`: LightSync, LightMode, Brightness, Speed, CustomizedCount, MacroCount, GameMode, PShiftKey) | `RongYuanKeyboard_Oper.cs:2565-2602` (similar for mouse, pad, HaiHui) → `SystemOper.Theme_GetDevicesBasicInfo` (`SystemOper.cs:3372-3430`) | "About device" page and profile preview, including **cloud-profile** preview (`styles-DAnQi2A8.js:33545-33560, 33708-33716`) | Local only as far as this scope shows. Keep for UI if useful; confirm with the cloud-profile report that it isn't uploaded. |
| None in the device protocols | – | – | The protocols in 3-5 are fully local |

---

## 8. Open questions

1. **RongYuan and HaiHui interface topology [I]:** is the event collection (usage page `0xFFFF`, input report ID 5, 3-byte payload) on a different USB interface from the unnumbered 64-byte feature interface `mi_02`? The code only works if it is. A USB descriptor dump from a real device would settle it.
2. **`0x17` double meaning:** `SetMouseBatteryThreshold` and `ClearMacroFlag` both send `0x17 [1]=value`. The firmware presumably disambiguates by device class (the keyboard's alert uses `0x03`), but the mouse's clear-on-board-macro path also sends `0x17` with a board number.
3. **Why the Fn layer is written twice** (`[3]=0` then `[3]=1`) for `0x0D` and `0x12`. It may be a second Fn layer or a "commit" flag.
4. **Dongle status byte semantics** (`F7` response `[0]`, `[5]`) are inferred from how the code uses them.
5. **Keyboard `ReportRate=8` in the profile block:** it could mean 125 Hz under the mouse code table, or something else for keyboards.
6. **BeiYing:**
   * The `tbl[]` for API type 3 (mouse/device functions) couldn't be recovered. The app also uses type 3 for LightOnOrOff, CycleLight and similar "device functions", which the DLL appears to turn into mouse buttons (possibly a vendor bug).
   * The 3632 notification payload offsets.
   * `ReadBattery`'s 2-byte layout.
   * The exact offset of the RGB-table signature (`0x1FA` or `0x1FE`).
   * The meaning of the raw `0xC0`-prefixed device codes in `KB_K916.json` (for example device type `0x2D`, `0x38` bytes) and of `0x7FFC`.
7. **HaiHui BLE VID/PID `0x3151:0x503C`** is inferred from the Windows BLE path format. Linux may report it differently (DIS PnP ID).
8. **Macro delay units** (assumed ms) and the dummy first-event codes (`0x01` RongYuan, `0x04` HaiHui, `A`-key UP for BeiYing).
9. **What the "Windows" (20) and "Music" (19) keyboard effects do** when set as static effects rather than streaming.

## 9. Cross-references (outside this scope)

* **Bridge/hub API that fronts these devices:** `work/dotnet-clean/Bridge.Lib/Bridge.Lib/Bridge.cs`:
  * `Device_*` (l.94-139)
  * `DeviceSteup_*` (l.144-194)
  * `Button_*` (l.54-79)
  * `Effect_*` (l.409-489)
  * `SyncEffect_*` (l.494-499)
  * `Keyboard_*GameMode` (l.529-544)
  * `Macro_*` (l.549-604)
  * `Mouse_*` (l.609-664)
  * `Profile_*` onboard (l.669-709)
  * `Theme_GetDevicesBasicInfo` (l.799-809)
  * `GetPairDevices/CanEnterPairing/EnterPairing` (l.109-119; implemented only for JiangMeng)
  * Notifications: `NotifyDeviceConnectionStatus`, `NotifyEffectChange`, `NotifyOnboardChange`, `NotifyButtonsChange`, `NotifyLightEnableChange`, `NotifyKeyboardGameModeChange`, `NotifyMacroKeyPressed`, `NotifyResetDevice`, `BatteryLowPowerReport`, `const_7` (DPI change) → `Bridge.Lib/Notification.cs`, EvniaServe `HandleEvent.cs`.
* **Device scan orchestration and USB/hub lists:** `Zeasn.Framework.Core.Lib/.../SystemOper.cs:136-229` (also enumerates USB devices `A5DCBF10-…` and hubs `F18A0E88-…` for the monitor's USB-DDC). The monitor/DDC report covers these.
* **Display framework** `Zeasn.Equipment.Base.Lib/GClass3.cs` (`ConnectionCkecked` uses `DataOSD.EnumerateUsbMonitors`, `NewDDCOper.DDCHelAPIIni(SupportBrand.PHL)`, EDID PNP/model regex `^((PHL )|(PHL_)|(PHL))?<model>$`, HDR get/set). **Relevant to the user's monitor**; see the DDC/monitor report.
* **Peripheral protocols part 2:**
  * JiangMeng `Mouse_SPK9718.dll`.
  * YongJiaXing/YJX `Mouse_SPK9418*/9618*` (and **`lib/YJX/Mouse_SPK9618_8960*.dll`, used by HaiHui 8960**).
  * ENE `EneEc.dll`, Genesys `GL_SDK.dll`, Realtek `RhHidAPI.dll`, TAG headsets.
* **Software macro engine and key injection:** `MacroMgr` (`Zeasn.PCenter.Base.Lib`), `KeyboardHIDScanCode_Extension.ToUsbKeys` (`Zeasn.Win.Lib`).
* **Screen and audio sampling** that feeds the `0x0C` and `SendMusicData` streams: `Zeasn.Audio.Sync.Lib` (`AudioSyncUtil.GetKeyboardSyncDataSimple`) and the video-capture code that raises `OnFollowVideo(Bitmap, byte[])`.
* **Cloud firmware service** (`Ev` client, base URL in renderer config `bf.PROD`, `ruleMac` = the host MAC via `ipc.invoke("getMac")`): `work/app-pretty/renderer/assets/styles-DAnQi2A8.js:32979-33140`. See the renderer/online report.
* **Obfuscator runtime** `Class0.cs` in each assembly: see the deobfuscation notes.
