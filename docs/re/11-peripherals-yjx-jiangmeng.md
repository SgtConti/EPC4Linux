# 11 - Peripheral protocols part 2: YongJiaXing (YJX) and JiangMeng mice

Area: native mouse SDKs `Mouse_SPK9418*.dll`, `Mouse_SPK9618*.dll`, `Mouse_SPK9618_8960*.dll` (YongJiaXing, "YJX") and `Mouse_SPK9718.dll` (JiangMeng), plus their managed wrappers `Zeasn.USB.YongJiaXing.Lib`, `Zeasn.USB.JiangMeng.Lib` (and, for the 8960 build, `Zeasn.USB.HaiHui.Lib/M9618`).

## Summary

- **Two unrelated wire protocols.**
  - **YJX** (SPK9418/SPK9618 and the HaiHui-branded SPK9618-8960) talks to a vendor HID collection (Usage Page `0xFF01`, Usage `0x0010`) on VID `0x25AA`. It uses 64-byte reports with no report ID. Requests start with `0x55`, responses with `0xAA`. The config block is 46 bytes. There is no checksum on normal commands.
  - **JiangMeng** (SPK9718/SPK9728 and the "8K dongle") talks to interface 1, top-level collection 5 of VID `0x25AA`. It uses 17-byte reports with **report ID `0x08`**, a big-endian flash address plus length, 10 data bytes and a trailing checksum byte `0x55 - sum(bytes[0..15])`. The mouse configuration is a 6912-byte (`0x1B00`) "flash map" that is read and written through commands `0x08` and `0x07`. Every stored value carries its own `0x55 - sum` check byte.
- **Only two YJX binaries exist.** The four `lib/YongJiaXing/*.dll` files are byte-identical (MD5 `3d3d9ced...`, internal name `YJXMouse.dll` v1.0.0.3), and so are the two `lib/YJX/Mouse_SPK9618_8960*.dll` files (MD5 `d969d3d2...`, v1.0.0.4). The 8960 build uses **the same protocol**. It only adds PIDs `0x401A` (wireless) and `0x401B` (wired) to the hard-coded wired/wireless lists. Every model difference (DPI range, defaults, macro slot count) lives in C#.
- **The DLLs contain no encryption, and no network code.** JiangMeng command `0x01` sends 4 random bytes and reads back CID, MID and device type, but the DLL never checks the reply. Neither DLL imports a networking library. The only online path is **firmware OTA**, which is driven by the renderer and uses the `DP_ComponentID = "EVNIA_MS_<Model>_<VID>_<PID>"` identifiers. That path must be stripped.
- **Not relevant to the user's hardware.** Their HID devices are unrelated third-party devices only. The runtime logs show these modules probing and finding nothing (`UsbCount = 0`, `JiangMeng ConnectionCkecked devices: []`), so the vendor DLLs are never even loaded on this machine.
  - Recommendation: port these modules only as an optional, off-by-default plugin. The spec below is precise enough for a clean-room hidraw implementation.
  - None of it can be verified on the user's machine. Items marked INFERRED need a real device to confirm.

Confidence legend: **CONFIRMED** means read directly in decompiled C#, Ghidra C, raw disassembly (`objdump`, read-only), or the user's logs/JSON. **INFERRED** means deduced from naming, structure or partial evidence.

---

## 1. Device inventory and binary map

Source for VID/PID: `Evnia Precision Center/resources/bin/res/data/PCenter_DeviceInfo.json` lines 277-590 (decimal values). DeviceType enum: `work/dotnet-clean/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/DeviceType.cs` lines 43-72.

| DeviceType (enum value) | Model | VID:PID | ConnectMode (JSON) | Native DLL (relative to `resources/bin`) | Managed controller |
|---|---|---|---|---|---|
| `YongJiaXing_MouseSPK9618` (302000) | SPK9618 | `25AA:200F` | 0 = USB (wired) | `lib/YongJiaXing/Mouse_SPK9618.dll` | `Zeasn.USB.YongJiaXing.Lib.M9618.Controllers.M_9618_Controllers` |
| `YongJiaXing_MouseSPK9618_24G` (302001) | SPK9618 | `25AA:2010` | 2 = Dongle | `lib/YongJiaXing/Mouse_SPK9618_24G.dll` | same |
| `YongJiaXing_MouseSPK9418` (302002) | SPK9418 | `25AA:2011` | 0 | `lib/YongJiaXing/Mouse_SPK9418.dll` | same |
| `YongJiaXing_MouseSPK9418_24G` (302003) | SPK9418 | `25AA:2012` | 2 | `lib/YongJiaXing/Mouse_SPK9418_24G.dll` | same |
| `HaiHui_MouseSPK9618_8960` (303003) | SPK9618 (ExtModel 8960) | `25AA:401B` | 0 | `lib/YJX/Mouse_SPK9618_8960.dll` | `Zeasn.USB.HaiHui.Lib.M9618.Controllers.M_9618_Controllers` (identical copy of the YJX controller) |
| `HaiHui_MouseSPK9618_8960_24G` (303004) | SPK9618 (8960) | `25AA:401A` | 2 | `lib/YJX/Mouse_SPK9618_8960_24G.dll` | same |
| `JiangMeng_MouseSPK9718` (301000) | SPK9718 | `25AA:4010`, Extra `vid_25aa&pid_4010&mi_01&col05` | 0 | `lib/JiangMeng/Mouse_SPK9718.dll` | `Zeasn.USB.JiangMeng.Lib.M9718.Controllers.M_9718_Controller` + static `DataParser` P/Invokes |
| `JiangMeng_Mouse_Dongle_8K` (301001) | "Dongle" (receiver for SPK9718/SPK9728) | `25AA:400F`, Extra `...pid_400f&mi_01&col05` | 2 | same DLL | same |
| `JiangMeng_MouseSPK9728` (301002) | SPK9728 | `25AA:400D`, Extra `...pid_400d&mi_01&col05` | 0 | same DLL | same |

All entries have `IUSB_USAGE_PAGE 65535` and `IUSB_USAGE 1` in the JSON. These values are used by the generic enumeration layer, **not** by the vendor DLLs, which carry their own hard-coded criteria (sections 2.3 and 3.3). CONFIRMED.

Managed-to-native path mapping (all CONFIRMED):

- `work/dotnet-clean/Zeasn.USB.YongJiaXing.Lib/Zeasn.USB.YongJiaXing.Lib.M9618.DllWrappers/M_9618_DllWrapper.cs:200-209`
- `work/dotnet-clean/Zeasn.USB.HaiHui.Lib/Zeasn.USB.HaiHui.Lib.M9618.DllWrappers/M_9618_DllWrapper.cs:206-207`
- `work/dotnet-clean/Zeasn.USB.JiangMeng.Lib/Zeasn.USB.JiangMeng.Lib.M9718.DllWrappers/M_9718_DllWrapper.cs:260-266` (DeviceType 301000..301002 all map to the one DLL)

Loading mechanism: both wrappers call `DllWrapper.LoadLibrary(path)`. They then reflect over their public delegate fields and resolve each one by **field name** with `GetProcAddress`. The export name therefore equals the C# field name: `YJXSDK_*` and `CS_*`. `DataParser` additionally `[DllImport]`s eight `CS_*` helpers from `lib/JiangMeng/Mouse_SPK9718.dll` (`DataParser.cs:29-52`).

Binary identity (CONFIRMED, `md5sum` of `resources/bin/lib/*`):

| MD5 | Files | Version resource |
|---|---|---|
| `3d3d9ced011b71448009a07def96818b` | `YongJiaXing/Mouse_SPK9418.dll`, `_9418_24G`, `_9618`, `_9618_24G` (52 736 B each) | `YJXMouse.dll` 1.0.0.3 (`Mouse_SPK9418.dll.symbols.txt`, strings at `0x100101d4`) |
| `d969d3d2b7159c0d92b9ac2a35c0b7fc` | `YJX/Mouse_SPK9618_8960.dll`, `_8960_24G` (53 248 B) | 1.0.0.4 |
| `3a35990db977c86bbc63f6d9d4001123` | `JiangMeng/Mouse_SPK9718.dll` (120 320 B) | original name `HIDUsb.dll` (string at `0x1001a170`) |

User relevance (CONFIRMED from `%APPDATA%/EvniaServe/logs/2026-09-25.txt` and `2026-09-26.txt`):

- `YongJiaXing_MouseSPK9618 ConnectionCkecked UsbCount = 0`, plus the same line for SPK9418, both 24G variants and both HaiHui 8960 variants.
- `JiangMeng ConnectionCkecked devices: []` and `JiangMeng ConnectionCkecked JiangMeng_Mouse_Dongle_8K Error: devices.Count < 1`.
- Both `CDevice_*` classes return **before** constructing their controller when no matching USB path exists. For YJX see `CDevice_YongJiaXing_Mouse.cs:242-287`; for JiangMeng see `CDevice_JiangMeng_Mouse.cs:268-278`. The native DLLs are therefore never loaded on the user's PC.

---

## 2. YongJiaXing SDK (`YJXMouse.dll`, exports `YJXSDK_*`)

### 2.1 Internal architecture (CONFIRMED)

- **Embedded hidapi.** The DLL contains a statically linked, slightly modified copy of signal11 hidapi for Windows. It uses SetupAPI enumeration and loads `hid.dll` dynamically with `LoadLibraryA` / `GetProcAddress` for `HidD_GetAttributes`, `HidD_GetSerialNumberString`, `HidD_GetManufacturerString`, `HidD_GetProductString`, `HidD_SetFeature`, `HidD_GetFeature`, `HidD_GetIndexedString`, `HidD_GetPreparsedData`, `HidD_FreePreparsedData` and `HidP_GetCaps`. See `work/native/Mouse_SPK9418.dll.c:1456-1493` (FUN_10002510).
  - `hid_enumerate` is FUN_10002620 (`:1499`), `hid_open_path` is FUN_10002a90 (`:1732`), `hid_write` is FUN_10002c30 (`:1814`) and `hid_read_timeout` is FUN_10002d60 (`:1885`).
  - `hid_device_info` layout is standard: `+0` path, `+4` VID, `+6` PID, `+8` serial, `+0xC` release, `+0x10` manufacturer, `+0x14` product, `+0x18` usage_page, `+0x1A` usage, `+0x1C` interface_number, `+0x20` next.
  - `HID_Feature` APIs are loaded but never used for mouse traffic. All traffic uses `WriteFile`/`ReadFile`, i.e. output and input reports.
- **Device table.** A global `std::map<int devId, node>` (`DAT_1000d590`, size in `DAT_1000d594`). `YJXSDK_OpenDevice` allocates a `MouseInfo` object of `0x4E4B8` bytes and inserts it under key `size+1`, so the first device gets devID 1 (`:5324-5355`).
- **Per-device worker thread.** `MouseInfo` derives from `CThreadBasic`. `FUN_10003100` (`:2081`) stores `+0x40` = hid_device\*, `+0x48` = VID and `+0x4C` = PID. It then starts `_beginthreadex(FUN_10006850)`, which loops `vtable[0](); Sleep(10);` (`+0x10 = 10` ms, `:5196-5216`).
  - `vtable[0]` at `0x1000a8d8` points to `0x100048d0`, i.e. FUN_100048d0 (`:3385`). CONFIRMED by dumping `.rdata` at `0x1000a8d8`.
  - It also pushes command code **1 (init)** onto the queue.
- **Command queue.** A `std::list<int>` at `+0x18/+0x1C`. Setter exports only update a cached `YJX_MOUSEINFO` or key table inside `MouseInfo`, then push a code. The worker pops one code per 10 ms tick and performs the USB exchange:

| Code | Pushed by | Worker action (FUN_100048d0, `:3466-3502`) |
|---|---|---|
| 1 | `FUN_10003100` (open) | FUN_10004b20: online handshake `0xED`, battery `0x30`, read keys `0x08`, read config `0x0E` |
| 2 | `YJXSDK_SetProfile` (FUN_10003450, `:2279`) | read keys `0x08` + read config `0x0E` for the new profile |
| 3 | `SetAllKeyInfo`/`SetKey`/`ResetKey`/`ResetAllKey` | FUN_10004bd0: write keys `0x09` |
| 4 | all `Set*` scalar setters (light, DPI, rate, LOD, ...) | FUN_10004da0: write whole config `0x0F` |
| 5 | `YJXSDK_SetMouseMacro` | FUN_10004fd0: macro chunks `0x0D` + commit `0x10` |
| 6 | `YJXSDK_RestoreFactorySettings` | FUN_100055c0: reset key table to defaults, write keys `0x09`, write config `0x0F`, profile := 0 |
| (queue empty) | - | `hid_read_timeout(10 ms)` to catch unsolicited `0xAA 0xFA` / `0xAA 0xED` reports (section 2.8) |

**Consequence:** every `Set*` export returns 1 immediately (before any I/O) and never reports device errors. The C# layer's `== 1` checks are therefore meaningless. CONFIRMED (for example FUN_10003d10 `:2664` returns `CONCAT31(...,1)` unconditionally).

### 2.2 Export table and signatures

C# delegates are in `Zeasn.USB.YongJiaXing.Lib.M9618.Constraints/M_9618_DllConstraints.cs:9-115`. All are `Cdecl` except the callback. `devID` is the int returned by OpenDevice. BOOL results are one byte (1 = true).

| Export (ordinal, VA) | C signature (reconstructed) | Behaviour | USB traffic |
|---|---|---|---|
| `YJXSDK_Init` (1, `0x100068b0`) | `void(void)` | `jmp 0x10007a80`: clears the device map. **Not called by C#** | none |
| `YJXSDK_UnInit` (2, `0x100068c0`) | `void(void)` | Stops each worker (`WaitForSingleObject(1000)`), closes handles, frees objects, clears map (`:5222-5300`). Called by the 8960 C# on disconnect | none |
| `YJXSDK_FindDevice` (10) | `uint8 (int vid, int pid, const wchar_t* productName)` | Enumerates HID and returns 1 if VID/PID (and productName, if non-empty) match any interface (FUN_10001740 `:445`). C# passes NULL | none |
| `YJXSDK_OpenDevice` (11) | `int (int vid, int pid, const wchar_t* productName)` | Returns devID > 0 or 0. Opens the interface with UsagePage `0xFF01` / Usage `0x0010` (section 2.3) and queues code 1 | via code 1 |
| `YJXSDK_RegisterDeviceStatusNotify` (12) | `void (int devID, YJX_DeviceStatusNotify cb, void* user)` | Stores cb at `+0x5C`, devID at `+0x50`, user at `+0x54` (`:5361-5404`). C# then `Thread.Sleep(2000)` (`M_9618_Controllers.cs:63`) | none |
| `YJXSDK_DeviceIsOnline` (13) | `uint8 (int devID)` | If the device is a **wired** model, returns 1. If it is a **dongle** (VID `0xA8A5`, or VID `0x25AA` with PID `0x2010`/`0x2012`/`0x401A`[8960 only]), returns the cached online flag `+0x60` (`:5410-5456`; 8960: helper in normalized diff) | none (cached) |
| `YJXSDK_GetDeviceVersion` (14) | `uint8 (int devID, int* fwVersion, int* dongleVersion)` | **Synchronous** cmd `0x03` (FUN_10003250 `:2151`) | 1 exchange |
| `YJXSDK_GetDeviceMode` (15) | `int (int devID)` | Returns 0 (dongle) only if VID `0x25AA` and PID is `0x2010`/`0x2012` (+`0x401A` in 8960). Everything else, **including VID `0xA8A5`**, returns 1 (wired) (`:5513-5551`). Not called by C# | none |
| `YJXSDK_GetDeviceBatteryInfo` (16) | `uint8 (int devID, int* battery, int* chargeFlag)` | Returns cached `+0x1EB`/`+0x1EC` (`:5557-5604`) | none (cached) |
| `YJXSDK_SetProfile` (19) | `uint8 (int devID, int profile)` | `+0x64 = profile`; queue code 2. **No "switch profile" packet exists.** The profile only selects the `[7]` byte used by later reads/writes. **Not called by C#** | via code 2 |
| `YJXSDK_GetAllKeyInfo` (20) | `uint8 (int devID, YJX_KEYINFO* out, int* count)` | Sets `*count = 8` but copies **9** entries from cache (FUN_100034b0 `:2306`). C# allocates 16 | none |
| `YJXSDK_SetAllKeyInfo` (21) | `uint8 (int devID, const YJX_KEYINFO* keys, int n)` | Copies `min(n,8)` entries **sequentially** into slots 0..7 (the entry's keyValue is copied but not used as the index). Queues code 3 (FUN_100036d0 `:2374`) | via code 3 |
| `YJXSDK_SetKey` (3) | `uint8 (int devID, const YJX_KEYINFO* k)` | Slot `k->keyValue-1` := k; queue 3 (FUN_10003770 `:2420`) | via code 3 |
| `YJXSDK_ResetKey` (22) | `uint8 (int devID, int keyValue)` | Slot := default (table 2.6.3); queue 3 (FUN_10003800 `:2453`) | via code 3 |
| `YJXSDK_ResetAllKey` (23) | `uint8 (int devID)` | Slots 0..8 := defaults; queue 3 (FUN_10003950 `:2515`) | via code 3 |
| `YJXSDK_GetMouseInfo` (30) | `uint8 (int devID, YJX_MOUSEINFO* out)` | Copies the cache (FUN_10003ab0 `:2584`) | none |
| `YJXSDK_SetMouseInfo` (31) | `uint8 (int devID, const YJX_MOUSEINFO* in)` | Copies fields 5.. into the cache and sets `+0x1E8` := current profile. **Does not queue anything** (FUN_10003bf0 `:2626`) | none |
| `YJXSDK_SetLightMode` (32) | `uint8 (int devID, int mode)` | `+0x1ED` = (byte)mode; queue 4 | via 4 |
| `YJXSDK_SetDPICount` (33) | `uint8 (int devID, uint8 n)` | `+0x1EE`; queue 4 | via 4 |
| `YJXSDK_SetDPIIndex` (34) | `uint8 (int devID, uint8 idx)` | `+0x1EF` (0-based); queue 4 | via 4 |
| `YJXSDK_SetDPIValue` (35) | `uint8 (int devID, uint8 idx, int dpi)` | Slot idx 0..6 → `+0x1F0 + 4*idx`; queue 4 | via 4 |
| `YJXSDK_SetDPIColor` (36) | `uint8 (int devID, uint8 idx, int rgb)` | Stored at `+0x20C + 4*idx`. **Never transmitted** (section 2.5.3). Queues 4 | via 4 |
| `YJXSDK_SetReportRate` (37) | `uint8 (int devID, uint8 rate)` | `+0x228`; queue 4 | via 4 |
| `YJXSDK_SetSilenceHeight` (38) | `uint8 (int devID, uint8 lod)` | `+0x229`; queue 4 | via 4 |
| `YJXSDK_SetKeyDebounceTime` (39) | `uint8 (int devID, uint8 ms)` | `+0x22A`; queue 4 | via 4 |
| `YJXSDK_SetSrollFlag` (40) | `uint8 (int devID, int flag)` | `+0x22B` (byte); queue 4 | via 4 |
| `YJXSDK_SetSleepTime` (41) | `uint8 (int devID, int t)` | `+0x22C` (int, **only the low byte is sent**); queue 4 | via 4 |
| `YJXSDK_SetHighSpeed` (42) | `uint8 (int devID, uint8 v)` | `+0x230`; queue 4 | via 4 |
| `YJXSDK_SetMotionSync` (43) | `uint8 (int devID, uint8 v)` | `+0x231`; queue 4 | via 4 |
| `YJXSDK_SetAngleSnapping` (44) | `uint8 (int devID, uint8 v)` | `+0x232`; queue 4 | via 4 |
| `YJXSDK_SetRippleControl` (45) | `uint8 (int devID, uint8 v)` | `+0x233`; queue 4 | via 4 |
| `YJXSDK_SetMoveOffLed` (46) | `uint8 (int devID, uint8 v)` | `+0x234`. **Never transmitted** (not in the config packet). Queues 4 | via 4 |
| `YJXSDK_GetMouseMacro` (55) | `uint8 (void)` | Stub, returns 0 (`:6644`) | none |
| `YJXSDK_SetMouseMacro` (56) | `uint8 (int devID, const YJX_MACROINFO* m, int n)` | `memcpy(+0x238, m, min(n,16)*0x4E28)`; queue 5 (FUN_10004370 `:3109`) | via 5 |
| `YJXSDK_RestoreFactorySettings` (100) | `uint8 (int devID, const YJX_MOUSEINFO* defaults)` | SetMouseInfo(defaults) + queue 6 (FUN_100043f0 `:3142`) | via 6 |
| `YJXSDK_FirmwareUpgrade` (105) | `uint8 (int devID, const uint8* bin, int size)` | **Synchronous** firmware flash (section 2.9). Signature per C# `M_9618_DllConstraints.cs:111-112` | many |
| `YJXSDK_FirmwareUpgradeByFile` (106) | `uint8 (int devID, const char* path)` | Reads the file with `CreateFileA`, then as above (FUN_100047f0 `:3345`). Declared in C# but not bound (no field) | many |

Callback: `void __stdcall YJX_DeviceStatusNotify(void* user, uint8 devID, uint8 msgType, int param1, int param2)` (`M_9618_DllConstraints.cs:9-10`, CallingConvention.Winapi). msgType is `YJX_NOTIFYMSG_TYPE`: 1 ONLINE, 2 BATTERY, 3 DPI, 4 REPORTRATE, 5 FWUPDATE (`Enums/YJX_NOTIFYMSG_TYPE.cs`).

Structs (C# sequential layout, default pack; matched byte-for-byte with DLL offsets in FUN_10003ab0 and FUN_10003bf0; `Entity/M_9618_Struct.cs`):

```c
typedef struct { int32 profile, keyValue, keyType, keyCode1, keyCode2, keyCode3; } YJX_KEYINFO;  // 24 bytes
typedef struct {                  // 0x50 bytes
  uint8 profile, workMode, isOnline, batteryValue, chargeFlag, lightMode, dpiCount, dpiIndex; // 0x00-0x07
  int32 dpi[7];                   // 0x08-0x23  (C# int_0..int_6)
  int32 dpiRGB[7];                // 0x24-0x3F  (0x00RRGGBB per RgbToInt; GetDefaultMouseInfo uses 0x00BBGGRR - inconsistent, unused on wire)
  uint8 reportRate, silenceHeight, keyDebounceTime, srollFlag;               // 0x40-0x43
  int32 sleepTime;                // 0x44
  uint8 highSpeed, motionSyncEnable, angleSnappingEnable, rippleControlEnable, moveOffLedEnable; // 0x48-0x4C
} YJX_MOUSEINFO;
typedef struct { int32 keyState, keyType, keyValue, delayTime; int8 moveX, moveY; /*pad 2*/ } YJX_RECORD; // 20 bytes
typedef struct { int32 macroIndex, recordCount; YJX_RECORD data[1000]; } YJX_MACROINFO;                  // 0x4E28 bytes
```

### 2.3 Device discovery and open (CONFIRMED)

`YJXSDK_OpenDevice` → FUN_10001890 (`Mouse_SPK9418.dll.c:540-659`):

1. `hid_enumerate()` lists every HID interface with GUID `{4D1E55B2-F16F-11CF-88CB-001111000030}`, class `HIDClass` (`:1546-1558, 1613`).
2. For each entry with matching VID and PID (and matching product string, if the caller passed one), `hid_open_path(path)` is called with `GENERIC_READ|GENERIC_WRITE`, share read/write and `FILE_FLAG_OVERLAPPED`. The entry is kept **only if `usage_page == 0xFF01 && usage == 0x0010`**. Verified in raw disassembly at `0x1000196d`: `mov eax,0xff01; cmp WORD PTR [esi+0x18],ax; cmp WORD PTR [esi+0x1a],0x10`. Otherwise it is closed and the loop continues.
3. **Vendor bug:** once the first VID/PID match has happened, every later list entry (any VID/PID) is opened and tested for `0xFF01/0x0010` (the `LAB_1000195a: if (bVar4) goto LAB_10001960` path). A Linux port must match VID, PID **and** usage.
4. After open, `hid_device+0x138` (release number) and `+0x38` (serial number wchar copy) are filled from the enumeration record.

The report sizes used are `output_report_length` / `input_report_length` from `HidP_GetCaps`, stored at `hid_device+8` and `+0xC`.

### 2.4 Transport (CONFIRMED)

- **Write** (FUN_10002c30 `:1814`): the caller builds a 65-byte buffer `[0x00 reportID][64 data bytes]`. If the collection's output report length exceeds 65, the buffer is zero-padded to that length. `WriteFile` is overlapped and waited on with `GetOverlappedResult(..., TRUE)`. On failure the transaction helper FUN_10001bb0 (`:754-776`) does `Sleep(2)` and retries once.
- **Read** (FUN_10002d60 `:1885`): overlapped `ReadFile` of `input_report_length` bytes, waiting `param_4` ms. That is **1000 ms** after a command and **10 ms** for the idle poll (`:3408`). If the first byte is `0x00` (report ID 0) it is stripped. At most 65 bytes are copied back **into the same buffer** the request was built in.
- **No request/response correlation.** The code takes the next input report and checks `resp[0]==0xAA && resp[1]==cmd` only in some callers. An unsolicited report arriving between write and read makes the command parse silently fail (INFERRED consequence).
- There is no checksum, CRC or encryption in normal traffic.

### 2.5 Packet formats

Byte offsets below **exclude** the report-ID byte. On Windows, and on Linux hidraw, the buffer written is `0x00` followed by these 64 bytes. Responses are 64 bytes starting with `0xAA`.

Generic header (CONFIRMED from all builders):

| Offset | OUT (host→mouse) | IN (mouse→host) |
|---|---|---|
| 0 | `0x55` magic | `0xAA` magic |
| 1 | command | command echo (`0xFA`/`0xED` for unsolicited) |
| 2-3 | opaque constants per command (copy verbatim, table 2.5.1) | ? |
| 4 | payload length in bytes (INFERRED from 0x2E = 46 = config, 0x20 = 32 = 8 keys × 4, 0x38 = 56 = macro chunk) | ? |
| 5-6 | opaque / offset (macro chunk: little-endian byte offset) | ? |
| 7 | profile index (0 in all C# usage) / argument | ? |
| 8.. | payload | payload (same layout as the OUT payload of the matching write command) |

#### 2.5.1 Command table (all CONFIRMED from Ghidra C, config write re-verified in disassembly)

| Cmd | Name (INFERRED) | Exact OUT bytes [0..8] (then zeros unless noted) | Response parse | Source |
|---|---|---|---|---|
| `0x03` | Read version | `55 03 00 00 00 00 00 00 00` | `resp[1]==0x03`. `resp[20..22]` = 3 ASCII digits → **dongleVersion**; `resp[23..25]` = 3 ASCII digits → **fwVersion**. A non-digit is replaced by `'0'`, then `atoi` | FUN_10003250 `:2151-2263` |
| `0x08` | Read key table | `55 08 A5 0B 20 00 00 <profile> 00` | `resp[0]==0xAA`. For i = 0..8: `resp[8+4i..11+4i]` = {keyType, code1, code2, code3}. An entry is ignored if `(b0==FF && b1==FF)` or all four bytes are 0 | FUN_10004450 `:3170-3251` |
| `0x09` | Write key table | `55 09 A5 22 20 00 00 <profile>` then `[8+4i..11+4i]` = slot i {keyType, code1, code2, code3} for i = 0..8 (36 bytes, though the header length says 32) | response read (1000 ms) and ignored | FUN_10004bd0 `:3547-3645` |
| `0x0D` | Macro data chunk | `55 0D 00 00 <len> <offLo> <offHi> 00` then 56 bytes of the macro image at `[8..63]` | ignored | FUN_10004fd0 `:3961-4017` |
| `0x0E` | Read config | `55 0E A5 0B 2E 01 01 <profile> 00 00` | `resp[1]==0x0E` → section 2.5.2 | FUN_100045e0 `:3257-3339` |
| `0x0F` | Write config | `55 0F AE 0A 2E 01 01 <profile> <profile2>` then payload per 2.5.2 | ignored | FUN_10004da0 `:3651-3780`, disasm `0x10004da0` |
| `0x10` | Macro commit | `55 10 A5 22 00 00 00 05` | ignored | FUN_10004fd0 `:4019-4050` |
| `0x30` | Read battery | `55 30 A5 0B 2E 01 01 01 00` | `resp[1]==0x30`: `resp[8]` = battery %, `resp[9]` = charge flag | FUN_10004b20 `:3526-3536` |
| `0xED` | Online handshake (dongle only) | `55 ED 00 ...` | Online iff `resp[0]==0xAA && resp[1]==0xED && resp[8]==2`. **Skipped** (returns online=1) for wired models: VID `0x25AA` with PID `0x200F`/`0x2011` (+`0x401B` in 8960), or VID `0xA8A4` | FUN_100031b0 `:2121-2145`, disasm `0x100031b0` |
| (IN) `0xFA` | Unsolicited status | - | section 2.8 | FUN_100048d0 `:3410-3446` |
| (IN) `0xED` | Unsolicited link status | - | section 2.8 | FUN_100048d0 `:3448-3462` |

Notes: `<profile>` is `MouseInfo+0x64` (0 unless SetProfile was called). `<profile2>` is `+0x1E8`, the copy set by SetMouseInfo/RestoreFactorySettings (also 0 in practice). VIDs `0xA8A4` (wired) / `0xA8A5` (dongle) are hard-coded in the DLL but no Evnia device uses them. INFERRED: they are YJX's own reference VIDs.

#### 2.5.2 Config block (cmd `0x0E` response == cmd `0x0F` payload)

CONFIRMED: the write layout was taken from raw disassembly of `0x10004da0`, the read layout from FUN_100045e0. Offsets exclude the report ID.

| Offset | Field (`YJX_MOUSEINFO`) | Write source | Read behaviour |
|---|---|---|---|
| 7 | profile | `+0x64` | - |
| 8 | profile (copy) | `+0x1E8` | not parsed |
| 9 | lightMode | `+0x1ED` | → lightMode |
| 10 | reportRate | `+0x228` | → reportRate |
| 11 | dpiCount | `+0x1EE` | → dpiCount |
| 12 | dpiIndex **+ 1** (1-based on wire) | `+0x1EF + 1` | → dpiIndex = resp[12] - 1 |
| 13-14 | dpi[0] u16 LE | written only if 50 ≤ dpi ≤ 50000, else 00 00 | accepted only if 50..50000 |
| 15-16 | dpi[1] | same | same |
| 17-18 | dpi[2] | same | same |
| 19-20 | dpi[3] | same | same |
| 21-22 | dpi[4] | same | same |
| 23-24 | dpi[5] | same | same |
| 25-26 | dpi[6] | same | same |
| 27-47 | (INFERRED: 7 × RGB DPI colours) | **always 00** (see 2.5.3) | not parsed |
| 48 | srollFlag (INFERRED: scroll direction invert) | `+0x22B` | → `+0x22B` |
| 49 | silenceHeight (LOD) | `+0x229` | → `+0x229` |
| 50 | flags: bit0 angleSnapping, bit4 rippleControl, bit5 motionSync | built from `+0x232/0x233/0x231` (value `==1` sets the bit) | → same bits |
| 51 | keyDebounceTime | `+0x22A` | → `+0x22A` |
| 52 | sleepTime (low byte) | `(uint8)+0x22C` | → `+0x22C` |
| 53 | highSpeed | `+0x230` | → `+0x230` |
| 54-63 | 0 | - | - |

The whole block is only accepted on read if `(resp[9]|resp[10]|resp[11]) != 0 && !(resp[13]==FF && resp[14]==FF && resp[15]==FF)`.

#### 2.5.3 Fields that are silently dropped (CONFIRMED)

- **DPI colours.** `SetDPIColor` and `SetMouseInfo.dpiXRGBValue` are cached but never copied into the `0x0F` packet: the disassembly writes staging bytes 0..18 and 0x28..0x2D only. The Windows app therefore sends zeros in `[27..47]` on every config write. It is unknown whether the firmware treats these as colours (see Open questions).
- **`moveOffLedEnable`** (`+0x234`) is never transmitted.
- **`workMode` / `isOnline` / `batteryValue` / `chargeFlag`** are read-only cache fields.

### 2.6 Buttons (key table)

#### 2.6.1 Slot numbering

Slots 0..8 correspond to `keyValue` 1..9. C# `YongJiaXingDataConvert.GetButtons` builds `YJX_KEYINFO[9]` indexed by `ButtonId-1`, with ButtonIds 1..8 (`YongJiaXingDataConvert.cs:512-521`, default buttons `T_YongJiaXingMouse_Profile.cs` `GetBasicButtons`):

| ButtonId / keyValue | Physical (C# default) |
|---|---|
| 1 | Left |
| 2 | Right |
| 3 | Middle (scroll click) |
| 4 | Back |
| 5 | Forward |
| 6 | DPI button (DPI cycle) |
| 7 | Wheel up |
| 8 | Wheel down |
| 9 | unused (DLL default = type 0x20, code 0) |

#### 2.6.2 Key-type encoding

CONFIRMED values emitted by C# `YongJiaXingDataConvert.GetButton` (`YongJiaXingDataConvert.cs:17-395`). The same values appear in the DLL defaults.

| keyType | Meaning | code1 | code2 | code3 |
|---|---|---|---|---|
| `0x00` | Disabled / unsupported (Smart DPI maps here since it is unimplemented) | 0 | 0 | 0 |
| `0x10` | Keyboard key | modifier mask: bit0 LCtrl, bit1 LShift, bit2 LAlt, bit3 LGUI, bit4 RCtrl, bit5 RShift, bit6 RAlt, bit7 RGUI | HID keyboard usage (page 0x07) | 0 |
| `0x20` | Mouse button | mask: 0x01 L, 0x02 R, 0x04 M, 0x08 Back, 0x10 Forward | 0 | 0 |
| `0x21` | Special | `0x38` = vertical wheel (code2 `0x01` up, `0xFF` down); `0xF8` = horizontal wheel/AC-Pan (code2 `0xFF` left, `0x01` right); `0x55` = DPI cycle | see code1 | 0 |
| `0x22` | Double click | 1 | 0 | 0 |
| `0x30` | Consumer control | usage low byte | usage high byte (e.g. Calculator 0x0192 → `92 01`) | 0 |
| `0x70` | Play macro | macro slot (= ButtonId) | repeat count 1..255 | mode: 0 = play N times, 2 = while held, 3 = toggle |
| `0xF0` | DPI step | 1 | 1 = DPI+, 2 = DPI- | 0 |

Consumer codes used (`smethod_4`): Mute `0xE2`, Vol- `0xEA`, Vol+ `0xE9`, Prev `0xB6`, Next `0xB5`, Play/Pause `0xCD`, Stop `0xB7`. "AppUser" shortcuts (`smethod_5`) become type `0x10` with fixed modifier/key combos, for example Win+D = `10 08 07 00` (LGUI bit3=0x08, usage 0x07 'D').

#### 2.6.3 DLL factory key table

Used by ResetKey/ResetAllKey/RestoreFactory (FUN_10003800 `:2461-2496`). Values are `{type, c1, c2, c3}`:

| Slot | Value |
|---|---|
| 1 | `20 01 00 00` |
| 2 | `20 02 00 00` |
| 3 | `20 04 00 00` |
| 4 | `20 08 00 00` |
| 5 | `20 10 00 00` |
| 6 | `21 55 00 00` |
| 7 | `21 38 01 00` |
| 8 | `21 38 FF 00` |
| 9 | `20 00 00 00` |

### 2.7 Macros (cmd `0x0D` + `0x10`)

CONFIRMED from FUN_10004fd0 (`:3789-4055`).

1. **Build an image.** Take the C# `YJX_MACROINFO[]` array (C# passes 32 entries for YJX and 10 for 8960; the DLL clamps to 16) and build an image of up to `0x1080` bytes:
   - `image[0 .. 2*n-1]` holds n little-endian u16 **start offsets**, one per macro index 0..n-1. The first macro starts at `0x40`. The table always reserves 64 bytes, so at most 32 entries.
   - Records follow from `0x40`, 4 bytes each, in array order. `macroIndex` is ignored; the array position is the slot. C# puts the macro for button N at array index N, so slot 0 is always empty.
2. **Encode each `YJX_RECORD`.**
   - `rec[0] = delayTime & 0xFF` and `rec[1] = (delayTime >> 8) & 0xFF` (ms, u16 LE).
   - `rec[2]` = type/flags and `rec[3]` = value, per the following table (keyState: 1 = down, 0 = up, per `YJX_KEY_STATE`):

| YJX_KEY_TYPE (`record.keyType`) | rec[2] | rec[3] |
|---|---|---|
| 1 HOTKEY (modifier) | `(keyState<<6) \| 0x01` | modifier bit for keyValue `0xE0..0xE7` → `1,2,4,8,0x10,0x20,0x40,0x80` |
| 2 KEYBOARD | `(keyState<<6) \| 0x02` | HID usage |
| 3 LEFT | `(keyState<<6) \| 0x03` | `0x01` |
| 5 RIGHT | `(keyState<<6) \| 0x03` | `0x02` |
| 4 MIDDLE | `(keyState<<6) \| 0x03` | `0x04` |
| 6 FORWARD | `(keyState<<6) \| 0x03` | `0x10` |
| 7 BACKWARD | `(keyState<<6) \| 0x03` | `0x08` |
| 8 SCROLLUP | `0x48` | `0x01` |
| 9 SCROLLDOWN | `0x48` | `0xFF` |
| other (10 MOUSEMOVE, **and 0**) | `0x46` | `(\|moveY\| & 0xF) \| (\|moveX\| << 4)`; plus `rec[1] \|= 0x80` if moveX < 0 and `rec[1] \|= 0x40` if moveY < 0 |

   The last record of each macro gets `rec[2] |= 0x80`.
3. **Send.** Let total = `0x40 + 4*records`. Send `ceil(total/56)` chunks: `55 0D 00 00 <len> <off LE16> 00` followed by `image[off .. off+55]`. `len = 0x38`, except the last chunk, where `len = total - 56*floor(total/56)`.
   - **Vendor bug:** when total is an exact multiple of 56, the last chunk's len becomes 0.
   - Each chunk waits for any response (1000 ms, not checked).
4. **Commit.** Send `55 10 A5 22 00 00 00 05`.

C# pre-processing (`YongJiaXingDataConvert.GetMacroData`, `:558-635`):

- Macros with more than 199 entries are skipped.
- A leading record `{keyState 0, keyType 0, delay = first delay}` is prepended, which encodes as a zero mouse move.
- Delays are shifted by one: each record carries the delay that follows it, the last gets 0, and all are clamped to at least 50 ms.
- Mouse records use keyValue 4. Keyboard records use `ToUsbKeys(Keys)`.
- The UI rejects macros over 198 steps (`YongJiaXingMouse_Oper.cs:254-266`).

### 2.8 Unsolicited input reports and callbacks (CONFIRMED, FUN_100048d0 `:3403-3463`)

These are polled with a 10 ms read whenever the command queue is empty.

- **`AA FA ...`**, ignored if `resp[9]==0xFF || resp[10]==0xFF`:
  - If `resp[8] == 0xD0` it is a battery report: charge = `resp[10]`, battery = `min(resp[9],100)`. Callback `(user, devID, 2 /*BATTERY*/, battery, charge)`.
  - Otherwise: `dpiIndex = resp[9]-1` (clamped to at most 7). If it changed, callback `(…, 3 /*DPI*/, dpiIndex, 0)`. `reportRate = resp[10]`; if it changed, callback `(…, 4 /*REPORTRATE*/, rate, 0)`.
- **`AA ED ...`**: `resp[8]==2` → online := 1, callback `(…, 1 /*ONLINE*/, 1, 0)`. Anything else → online := 0, callback `(…, 1, 0, 0)`.

C# reaction (`CDevice_YongJiaXing_Mouse.cs:76-139`):

- DPI: updates `DPIData.CurDPIIndex`, emits notification `Notification_Func.const_7` with `{Data: DPIData, ModelName}` and saves the profile.
- BATTERY: updates PowerInfo when param1 != 0.
- ONLINE: toggles `WirelessConnectionState` and calls OnConnect/`NotifyDeviceConnectionStatus`.
- FWUPDATE: forwards progress as `NotifyDeviceUpgradeFwProgress {ModelName, Progress}`.
- REPORTRATE is ignored.

### 2.9 Firmware upgrade (for completeness; **recommend dropping**)

FUN_100056f0 (`:4122-4228`); interface selection verified in disassembly at `0x10005733-0x100057c0`. Status: CONFIRMED unless marked.

1. **Open a second HID handle** on the same VID/PID:
   - First choice: UsagePage **`0xFF06`**, Usage **`0x0002`**. Then report ID `0x0B`, response offset `off=1`, chunk 54 bytes.
   - Fallback: UsagePage **`0x0001`**, Usage **`0x0000`**. Then report ID `0x00`, `off=0`, chunk 55 bytes. INFERRED: the fallback is a bootloader/alternate descriptor.
2. **Packets** use `[0]=RID, [1]=cmd, [2..3]=u16 LE length field, [4..]=args`. The response must have `resp[0]==RID` and `resp[off+1]==expected`. Each exchange uses the 1000 ms read, and each write gets one retry after 2 ms.

| Step | OUT | Expect | Effect |
|---|---|---|---|
| 1 Query base | `RID 01 00 00` | `resp[off+1]==1` | base address = u32 LE `resp[off+4..off+7]` |
| 2 Query info | `RID 02 06 00` | `==2` | u32 LE `resp[off+4..off+7]` stored (unused) |
| 3 Erase | `RID 03 06 00 <addr u32 LE>`, addr = base + i*0x1000, for i = 0 .. floor(size/4096) | `==3` each | 4 KiB sectors |
| 4 Program | `RID 05 <(chunk+9) u16 LE> <addr u32 LE> <chunk u16 LE> <data…>`, addr = base + k*chunk | `==5` (retries the same chunk on mismatch) | callback msgType 5, progress = `30 + 70*sent/size` |
| 5 Verify/finish | `RID 09 08 00 <size u32 LE> <crc u32 LE>` | `resp[off+1]==1` | - |

The progress callbacks between steps are invoked with truncated arguments in the decompile; INFERRED they carry msgType 5 with fixed percentages.

**CRC** (FUN_10006080 `:4614`, disassembly `0x10006080-0x100061ab`):

- The table is the standard reflected CRC-32 table (poly `0xEDB88320`, `.rdata` `0x1000a4d0`), but it is used with a non-standard MSB-first update.
- It covers file bytes **`[0x100, size)`**; the first 256 bytes are skipped. INFERRED: they are a header.

```c
int32_t crc = 0;                       // signed!
for (i = 0x100; i < size; i++) {
    int32_t t = crc / 256;             // C truncation toward zero (cdq; and edx,0xff; add; sar 8)
    crc = (crc << 8) ^ TABLE[(uint8_t)(t ^ buf[i])];
}
```

Test vectors (computed with this algorithm):
- `bytes(range(256))*2 + 01 02 03` (size `0x203`) → `0x38CB6E3F`.
- `FF×256 + "123456789"` → `0x6A8517BD`.

The C# side reads `<path>/<name>/<name>.bin` (`YongJiaXingMouse_Oper.cs` `UpgradeFw`, around line 1761). The path comes from the renderer OTA download (section 5).

### 2.10 C#-layer value mappings (CONFIRMED)

| Setting | UI value | Wire value |
|---|---|---|
| Report rate | `ReportRate._125Hz/_250Hz/_500Hz/_1000Hz` | `YJX_REPORT_RATE` 1/2/3/4 (`Enums/YJX_REPORT_RATE.cs`) via enum-name parse (`CDevice_YongJiaXing_Mouse.cs:345-346`). Wired: UI forced to 1000 Hz and the report-rate menu is hidden (`GetDeviceData`, `GetMouseMenu`) |
| LOD (`silenceHeight`) | LodItems `"1"`, `"2"` | byte 1 / 2 (`T_YongJiaXingMouse_Profile.InitMouseParamItems`) |
| DPI | SPK9618: 50..26000; SPK9418: 100..12000; step 50 (`DPIData.DPIStep` default 50) | u16 LE, 7 slots, 1-based index on wire |
| DPI stage lists | SPK9618 has one list of 6 stages (800/1200/1600/3200/5000/12000). SPK9418 has 6 lists of 1..6 stages (400/800/1200/1600/3200/6400), default DPILevel 5, CurDPIIndex 2 | `SetMouseDPIData` sends SetDPICount + SetDPIIndex + SetDPIValue × n, i.e. **2+n config writes** of the full 0x0F block (`M_9618_Controllers.cs:208-228`) |
| Profile applied on connect | `ParameterToDevice` → SetMouseDPIData, SetReportRate, SetSilenceHeight, SetAllKeyInfo(9), SetMouseMacro(32) (`CDevice_YongJiaXing_Mouse.cs:342-360`) | - |
| Factory reset | `Reset()` → GetMouseInfo, `GetDefaultMouseInfo`, RestoreFactorySettings | defaults: dpiCount 6, dpiIndex 2, DPI (9618) 800/1200/1600/3200/5000/12000/26000 or (9418) 400/800/1200/1600/3200/6400/26000, lightMode 1, reportRate 4, LOD 1, debounce 8, scroll 0, sleepTime 20 (**8960: 3**), highSpeed 0, motionSync 1, angleSnap 1, ripple 0, moveOffLed 0 (`YongJiaXingDataConvert.cs:463-505`) |
| Firmware version display | fwVersion int (3 ASCII digits) | `"V{fw:D3}"` (`CDevice_YongJiaXing_Mouse.cs:196-200`) |
| 8960 only | FW ≥ 258 → Button 6 = DPI cycle is added; otherwise removed (`CDevice_9618_8960_Mouse.cs` `GetDeviceData`) | - |

Bridge entry points (renderer `GetTaskAsync` function names) that reach these Oper methods: `Mouse_ChangeDPI`, `Mouse_ChangeDPIValue`, `Mouse_ChangeDPILevel`, `Mouse_ChangeSmartDPI`, `Mouse_ChangeLod`, `Mouse_ChangeRepotRate`, `Mouse_ResetParam`, `Mouse_GetMouseMenu`, `Button_SetFunc`/`Button_SetKeyboard`/`Button_SetMacro`/`Button_RestButtons`, `Profile_GetDeviceData`/`Profile_Reset`, `DeviceSteup_GetPowerInfo`, `Device_UpgradeFw` (`Bridge.Lib/Bridge.Lib/Bridge.cs:54-104, 609-674`).

### 2.11 Variant diff (CONFIRMED)

| Aspect | SPK9418 / SPK9618 (+24G) | SPK9618-8960 (+24G) |
|---|---|---|
| Native binary | one binary, 4 names, v1.0.0.3 | one binary, 2 names, v1.0.0.4 |
| Protocol / commands / layouts | identical | identical (normalized Ghidra diff shows only helper refactoring) |
| Wireless PID list (`DeviceIsOnline`/`GetDeviceMode`) | `0x2010`, `0x2012` (+ VID `0xA8A5`) | adds `0x401A` |
| Wired PID list (handshake skip) | `0x200F`, `0x2011` (+ VID `0xA8A4`) | adds `0x401B` |
| Managed assembly | `Zeasn.USB.YongJiaXing.Lib` | `Zeasn.USB.HaiHui.Lib` (M9618 namespace, byte-identical logic) |
| C# macro array | 32 | 10 |
| C# defaults | sleepTime 20; GetMouseInfo helper sets sleepTime 255 and highSpeed 255 | sleepTime 3, highSpeed 0; calls `UnInit()` on disconnect; HasBattery=false in JSON but still reads battery |
| DPI range (C#) | 9618: 50-26000; 9418: 100-12000 | per `T_HaiHui_9618_8960_Mouse_Profile` (other report) |
| "24G" vs wired DLL | no difference | no difference |

---

## 3. JiangMeng SDK (`HIDUsb.dll` → `Mouse_SPK9718.dll`)

### 3.1 Architecture (CONFIRMED)

The DLL has two independent I/O paths.

1. **`UsbFinder_*` (synchronous).** Each call opens the device path twice: a synchronous write handle (FUN_1000fbb0) and an overlapped read handle (FUN_1000fc20). It starts one 17-byte read, then loops up to 3 attempts of `WriteFile(17)` → `WaitForSingleObject(100 ms)`. A response is accepted only if the checksum is valid and `resp[1]==req[1]`. Both handles are then closed (FUN_1000a440, `Mouse_SPK9718.dll.c:8515-8597`). This path is used by C# for online, version, CID/MID and USB attributes.
2. **`UsbServer_*` (queued, asynchronous).** `UsbServer_Start` stores the device path(s). `CS_UsbServer_Start` uses **param_1 for both** read and write (`:11806-11807`). It then starts one global thread running `UsbReaderWriterServer` (`:14094-14510`). Commands are appended to a mutex-protected `std::vector` of 20-byte entries:

```text
entry[0]    isLast      (1 = this packet completes the transaction → deliver callback)
entry[1]    needsSend   (1 = pending/resend; the server sets it to 0 after WriteFile)
entry[2]    tag         (0 normal; 1..0x51 = internal full-flash-read state machine; 0xFF = flash write)
entry[3..19] the 17-byte packet
```

The server loop behaves as follows:
- On (re)start, it opens the write handle with `CreateFileW(GENERIC_RW, share RW, OPEN_EXISTING, 0x80)` and the read handle with the same call plus `FILE_FLAG_OVERLAPPED`, then posts a 17-byte overlapped read.
- If the head entry needs sending, it busy-waits **8 clock ticks** (`clock()` delta < 8, i.e. about 8 ms with MSVC's 1000 ticks/s), then calls `WriteFile(17)`. On failure it re-enumerates the path and closes the handles if the device has gone.
- It then arms a timeout of **1000 ms**, or **5000 ms if cmd == `0x09` (ClearSetting)**. On timeout the entry is re-marked for sending; after about 5 attempts the queue is flushed (INFERRED from the `uStack_74 < 5` counter).
- When the read completes with a valid checksum, FUN_1000eb30 (`:13783-14038`) handles it (section 3.6).
- When the queue is empty, the loop does `Sleep(100)` (`DAT_1001d028`, initialised to `0x64` in `.data`, settable via `CS_UsbServer_SetThreadSleepTime`) and re-checks that the device path still exists.

Unsolicited `0x0A` reports are delivered immediately. The C# side receives callbacks as `OnUsbDataReceived(IntPtr pcmd, int cmdLength=17, IntPtr pdata, int dataLength)`. It decodes `pcmd` as `{ReportId=[0], id=[1], CommandStatus=[2], address=[3]<<8|[4], dataLength=[5], command=[6..15]}` (`M_9718_Controller.cs:207-231`).

### 3.2 Exports actually bound by C#

The DLL has 183 exports; many are debug/factory functions. C# binds these (`M_9718_DllConstraints.cs:20-171`, `DataParser.cs:29-52`); all are cdecl:

| Export | Signature | Wire effect |
|---|---|---|
| `CS_StartUsbChanged(OnUsbChanged cb, int delayMs)` / `CS_StopUsbChanged()` / `CS_SetUsbChangedCallBack` | cb(bool plugged) | Creates the hidden window class `"usb hook msg window"` and registers for `GUID_DEVINTERFACE_USB_DEVICE {A5DCBF10-6530-11D2-901F-00C04FB951ED}`. `WM_DEVICECHANGE` `0x8000` → `Sleep(delay)`, then cb(1); `0x8004` → cb(0) (`:6534-6618`). Bound but **not called** by the Oper classes |
| `CS_UsbFinder_EnumHidDeviceList() → SAFEARRAY(BSTR)` | - | enumeration only |
| `CS_UsbFinder_FindHidDevices(vid,pid)`, `...ByKey(path)`, `...ByDefaultDeviceId(vid,pid)`, `...ByDeviceId(vid,pid,mi,col)` | strings are hex without `0x` | Path filter `"vid_%ls&pid_%ls&mi_%02d&col%02d"`. DefaultDeviceId = **mi 1, col 5** (`:7654, 7714`) |
| `CS_UsbFinder_GetDeviceInfo(path, bool isKeyboard, out {CID,MID,DeviceType})` | - | sync cmd `0x01` |
| `CS_UsbFinder_GetVersion(path) → int` | - | sync cmd `0x12` |
| `CS_UsbFinder_GetDeviceOnLine(path) → bool` | - | sync cmd `0x03` |
| `CS_UsbFinder_GetDeviceOnLineWithUsbAddress(path) → SAFEARRAY(UI1)` | - | sync cmd `0x03`; returns raw response |
| `CS_UsbFinder_GetBatteryLevel(path, out BatteryStatus)` | - | sync cmd `0x04` |
| `CS_UsbFinder_GetUsbDeviceAttribute(path, out HIDD_ATTRIBUTES)` | - | `HidD_GetAttributes` (the dongle's bcdDevice is used as receiver FW version) |
| `CS_UsbFinder_Set4KDongleRGB(path, ref DongleRGB) → uint8` / `CS_UsbFinder_Get4KDongleRGBValue(path, out DongleRGB) → bool` | - | sync `0x14` / `0x15` (unused by Oper) |
| `CS_UsbServer_Start(in, out, OnUsbDataReceived)`, `CS_UsbServer_Exit()`, `CS_UsbServer_Thread()` | - | server control |
| `CS_UsbServer_ReadEncryption()` == `CS_UsbServer_ReadCidMid()` (same VA `0x1000d870`) | - | queued `0x01` |
| `CS_UsbServer_SetPCDriverStatus(bool)` | - | queued `0x02` (unused by Oper) |
| `CS_UsbServer_ReadOnLine`, `_ReadBatteryLevel`, `_EnterDonglePair`, `_ReadDonglePairStatus`, `_SetClearSetting`, `_SetVidPid(vid,pid)`, `_SetDeviceDescriptorString(str)`, `_EnterUsbUpdateMode`, `_ReadConfig`, `_SetCurrentConfig(id)`, `_EnterMTKMode`, `_ReadVersion`, `_ReadFalshData(addr,len)`, `_ReadAllFlashData`, `_ReadCurrentDPI`, `_ReadReportRate`, `_ReadDPILed`, `_ReadLedBar`, `_Set4KDongleRGB`, `UsbServer_Get4KDongleRGBValue` | - | queued, see 3.4 |
| `CS_ProtocolDataUpdate(FlashDataMap*)` | - | diff against the DLL cache → queued `0x07` writes (3.8) |
| `CS_UsbUpgrade_Start(bin, cb, timeoutMs)`, `CS_UsbUpgrade_FindBootDevices(bin,len)`, `CS_UsbUpgrade_FileSplit(bin,len,idx)` | - | firmware (3.11) |
| DataParser: `CS_GetCidMid(buf,out)`, `CS_isDeviceOnLine(buf)`, `CS_GetDeviceBatteryStatus(buf,out)`, `CS_GetDeviceStatusChanged(buf,out)`, `CS_GetDeviceVersion(buf)`, `CS_ProtocolDataParser(buf,out)`, `CS_BufferToDPILed`, `CS_BufferToLedBar` | pure parsers, no I/O | layouts in 3.4/3.7 |

The Oper/CDevice classes actually call only: `GetDeviceOnLine`, `GetVersion`, `GetDeviceInfo`, `GetUsbDeviceAttribute`, `Start`, `ReadAllFlashData`, `ReadCurrentDPI`, `ReadReportRate`, `ReadDPILed`, `ReadLedBar`, `ReadBatteryLevel`, `EnterDonglePair`, `ReadDonglePairStatus`, `SetClearSetting`, `Update`, `Exit`, `FindHidDevicesByDefaultDeviceId`, `FindBootDevices` and `UsbUpgrade_Start`. CONFIRMED by grep: `SetPCDriverStatus`, `SetVidPid`, `EnterMTKMode`, `EnterUsbUpdateMode`, `SetCurrentConfig`, `ReadConfig` and `Set4KDongleRGB` have **no callers**.

### 3.3 Device discovery (CONFIRMED)

C# `ConnectionCkecked` (`CDevice_JiangMeng_Mouse.cs:258-324`):

1. `UsbUtil.GetUsbList()` returns Windows device-interface paths. Keep those containing JSON `Extra`, e.g. `vid_25aa&pid_4010&mi_01&col05`.
2. `Thread.Sleep(1000)`. `PointStr = list[0]`.
3. `GetDeviceOnLine(PointStr)` (sync `0x03`). If offline: for a Dongle, start the 1.5 s poll thread (below) and return; for wired, disconnect.
4. `Start(PointStr, PointStr, OnUsbDataReceived)`, then `ReadAllFlashData()`. Wait up to 5000 ms, polling every 300 ms, for the 0x1B00-byte map callback.
5. Connected → `OnConnect()`. For the 8K dongle, the model is chosen via `GetDeviceInfo` (`0x01`): **CID 88 (`0x58`) with MID 4/5/6 → SPK9718; CID 88 with MID 1/2/3 → SPK9728** (`:365-379`; also `T_Theme_Profile.cs:101-109`).
6. Dongle online poll thread (`method_0`, `:104-146`): every 1500 ms (500 ms while pairing) it calls `GetDeviceOnLine`. Transitions call OnConnect or `NotifyDeviceConnectionStatus`.

On Windows, `mi_01&col05` means USB interface 1, fifth top-level collection; that collection owns report ID 8. INFERRED: interface 1 also carries other collections (keyboard/consumer for macros), which is why a collection index is needed.

### 3.4 Packet format and command IDs

17-byte output **and** input report (CONFIRMED: `WriteFile(...,0x11)` / `ReadFile(...,0x11)` at `:14283, 14398, 8555, 8563`):

| Byte | Field |
|---|---|
| 0 | Report ID **`0x08`** |
| 1 | Command ID |
| 2 | Status: 0 in requests; response status (INFERRED 0 = OK; only `Set4KDongleRGB` checks `resp[2]==0`) |
| 3 | Address high |
| 4 | Address low (big-endian flash address) |
| 5 | Data length (0..10). In "keyboard mode" (`UsbServer_KeyboardStart`, `DAT_1001f882`) `|0x80` is added; never the case for mice |
| 6-15 | Data (10 bytes, zero-padded) |
| 16 | Checksum = `(0x55 - Σ bytes[0..15]) & 0xFF` (FUN_1000ce20 `:11405-11583`; vectorised byte sum, returns `'U' - sum`) |

`UsbCommandID` enum (`Enums/UsbCommandID.cs`) is completed with the extra IDs found in the DLL:

| ID | Name | Request data (`[5]` = len) | Response data | Transport | Status |
|---|---|---|---|---|---|
| `0x01` | EncryptionData / Read CID-MID | len 8 (`0x88` if keyboard): `[6..9]` = 4 bytes from `srand(time)`/`rand()`, `[10..15]`=0 (FUN_1000cf00 `:11589`) | `data[4]` = CID, `data[5]` = MID, `data[6]` = DeviceType (`CS_GetDeviceInfo :4991`, `UsbFinder_GetDeviceInfo :8662` reads resp[10..12]). The random challenge is **not verified** by the DLL | sync + queued | CONFIRMED |
| `0x02` | PCDriverStatus | len 1, `[6]` = 1 active / 0 | - | queued | CONFIRMED (unused) |
| `0x03` | DeviceOnLine | len 0 | `data[0] != 0` → mouse linked (dongle) (`:8932-8969`, `CS_isDeviceOnLine :5006`) | sync + queued | CONFIRMED |
| `0x04` | BatteryLevel | len 0 | `data[0]` = level %, `data[1]` = isCharging, `data[2..3]` = voltage **big-endian** (mV) (`CS_GetDeviceBatteryStatus :5018`, `UsbFinder_GetBatteryLevel :9232`) | sync + queued | CONFIRMED |
| `0x05` | DongleEnterPair | len 2, `[6]` = CID, `[7]` = MID (0,0 from C#) | echo | queued | CONFIRMED |
| `0x06` | GetPairState | len 0 | `data[0]`: 1 = pairing, 2 = failed/timeout, 3 or 11 = success (C# `:445-476`) | queued | CONFIRMED (values from C#) |
| `0x07` | WriteFlashData | addr BE, len ≤ 10, data | **exact 17-byte echo** of the request; a mismatch re-sends (`:13909-13919`) | queued | CONFIRMED |
| `0x08` | ReadFlashData | addr BE, len ≤ 10, data zeros | `[5]` = bytes valid, `[6..15]` = flash bytes | queued | CONFIRMED |
| `0x09` | ClearSetting (factory reset) | len 0 | echo (5000 ms timeout) | queued | CONFIRMED |
| `0x0A` | StatusChanged (**unsolicited IN**) | - | `data[0]` bitfield: b0 DPI, b1 report rate, b2 config, b3 DPI-LED, b4 logo LED, b5 LED bar, b6 battery (`CS_GetDeviceStatusChanged :5033`) | - | CONFIRMED |
| `0x0B` | SetDeviceVidPid | len 4: `[vidHi&0x0F, vidLo, pidHi&0x0F, pidLo]` | - | queued | CONFIRMED, **dangerous**, unused |
| `0x0C` | SetDeviceDescriptorString | multi-packet; `[3]` = total, `[4]` = offset, data (buggy: `memcpy` from NULL, `:12721`) | - | queued | CONFIRMED broken, unused |
| `0x0D` | EnterUsbUpdateMode | len 0 | - | queued | CONFIRMED, dangerous, unused by Oper |
| `0x0E` | GetCurrentConfig | len 0 | ? | queued | unused |
| `0x0F` | SetCurrentConfig | len 1, `[6]` = config id | ? | queued | unused |
| `0x10` | (`const_15`) | - | - | - | not built in DLL |
| `0x11` | EnterMTKMode | len 0 | - | queued | dangerous, unused |
| `0x12` | ReadVersionID | len 0 | version = `data[0]<<8 \| data[1]` (`CS_GetDeviceVersion :5052`, `UsbFinder_GetVersion :8823`) | sync + queued | CONFIRMED |
| `0x14` | Set4KDongleRGB | len 10: `[6]` = mode, `[7..15]` = color1 RGB, color2 RGB, color3 RGB | `resp[2]==0` and echoed data equal → OK (returns 0 OK / 1 mismatch / 3 no reply / status) (`:9406-9463`) | sync + queued | CONFIRMED, unused |
| `0x15` | Get4KDongleRGB | len 0 | `resp[5]!=0` → `data[0..9]` = DongleRGB | sync + queued | CONFIRMED, unused |
| `0x16`/`0x17` | Set/Get LongRangeMode | - | - | sync + queued | exists, unused |
| `0x18`/`0x19` | Set/Get DongleRGBBarMode | - | - | sync + queued | exists, unused |
| `0x1A` | SetDongleIDToMouse | len 10 | - | sync + queued | exists, unused, dangerous |
| `0x1F`/`0x20` | Set/Get MouseSerialNumber | - | - | sync + queued | exists, unused |
| `0xB3` | GetSlaveVersion | len 0 | - | sync + queued | exists, unused |
| `0xF0`/`0xF1` | Write/Read CID-MID (factory) | - | - | sync | exists, unused, dangerous |

Golden request packets (checksums computed with the formula above):

| Purpose | 17 bytes (hex) |
|---|---|
| Online | `08 03 00 00 00 00 00 00 00 00 00 00 00 00 00 00 4A` |
| Battery | `08 04 00 … 00 49` |
| Version | `08 12 00 … 00 3B` |
| Pair status | `08 06 00 … 00 47` |
| Factory reset | `08 09 00 … 00 44` |
| Enter pair (CID=MID=0) | `08 05 00 00 00 02 00 … 00 46` |
| CID/MID with rnd=00000000 | `08 01 00 00 00 08 00 … 00 44` |
| Read flash 0x0000 len 10 | `08 08 00 00 00 0A 00 … 00 3B` |
| Read flash 0x0004 len 1 | `08 08 00 00 04 01 00 … 00 40` |
| Write report-rate 1000 Hz | `08 07 00 00 00 02 01 54 00 … 00 EF` |
| Write DPI slot0 = 800 | `08 07 00 00 0C 04 10 10 00 35 00 … 00 E1` |
| Write key0 = Left | `08 07 00 00 60 04 01 01 00 53 00 … 00 8D` |

Useful property: any 2-byte `[v, 0x55-v]` write to address `A` always has packet checksum `(0x55 - (0x08+0x07+A_hi+A_lo+0x02+0x55)) & 0xFF`.

### 3.5 Flash map (0x0000-0x1AFF, 6912 bytes)

CONFIRMED from `MouseConfigParser :5064`, `ProtocolDataParser :5317`, `FUN_10006e30 :5621` and the C# `FlashDataMap` marshal layout (total `0x28D0` = `CS_SetDllProtocolData` memcpy size, `:5611`).

Integrity rule: every item is stored with a trailing check byte `0x55 - Σ(item bytes)`. On read, a bad check substitutes the default shown.

| Flash addr | Bytes | Item | Default if check fails | C# `FlashDataMap` offset/field |
|---|---|---|---|---|
| `0x00` | v, chk | reportRate (bitmask, 3.7) | 1 (1000 Hz) | `0x00 mouseConfig.reportRate` |
| `0x02` | v, chk | maxDPI = number of active DPI stages | 6 | `0x01 maxDPI` |
| `0x04` | v, chk | current DPI index (0-based; must be < maxDPI) | 2 | `0x02 byte_0 (currentDPI)` |
| `0x06` | v, chk | xSpindown | 0 | `0x03` |
| `0x08` | v, chk | ySpindown | 0 | `0x04` |
| `0x0A` | v, chk | silenceHeight (LOD) | 0 | `0x05` |
| `0x0C + 4i` (i = 0..7) | x, y, ex, chk | DPI stage i (3.7) | FF FF 00 | `0x24 + 6i dpiConfig[i].{xDPI,yDPI,DPIex}` |
| `0x2C + 4i` | R, G, B, chk | DPI stage i colour | FF FF FF | `0x27 + 6i dpiConfig[i].color[3]` |
| `0x4C` | v, chk | DPI LED mode | 2 | `0x54 dpiLed.mode` |
| `0x4E` | v, chk | DPI LED brightness | 0x80 | `0x55` |
| `0x50` | v, chk | DPI LED breath speed | 3 | `0x56` |
| `0x52` | v, chk | DPI LED enable | 1 | `0x57` |
| `0x54-0x5F` | - | unused | - | - |
| `0x60 + 4k` (k = 0..15) | type, p1, p2, chk | key function k (3.7) | 00 00 00 | `0x5F + 3k keys[k]` |
| `0xA0` | mode, R, G, B, speed, brightness, chk | LED bar | 01 FF FF FF 08 09 | `0x58..0x5D ledBar` |
| `0xA7` | v, chk | LED bar enable | 1 | `0x5E` |
| `0xA9` | v, chk | keyDebounceTime | 8 | `0x06` |
| `0xAB` | v, chk | motionSyncEnable (bool) | 1 | `0x07` |
| `0xAD` | v, chk | allLedOffTime | 6 | `0x08` |
| `0xAF` | v, chk | linearCorrectionEnable (bool) | 0 | `0x09` |
| `0xB1` | v, chk | rippleControlEnable (bool) | 0 | `0x0A` |
| `0xB3` | v, chk | moveOffLedEnable (bool) | 0 | `0x0B` |
| `0xB5` | v, chk | sensorCustomSleepTimeEnable (bool) | 0 | `0x0C` |
| `0xB7` | v, chk | sensorSleepTime | 6 | `0x0D` |
| `0xB9` | v, chk | sensorPowerSavingModeEnable | 0 | `0x0E` |
| `0xBB-0xBC` | - | unused | - | - |
| `0xBD` | v, chk | sensorAngleTune | (unchanged) | `0x0F` |
| `0xBF` | v, chk | enableSensorAngleTune | (unchanged) | `0x10` |
| `0xC1` | v, chk | enableWheelToChangeDPI | (unchanged) | `0x11` |
| `0xC3` | f32 LE ×4 bytes, chk | sensitivityPositiveX | (unchanged) | `0x14` |
| `0xC8` | f32, chk | sensitivityNegativeX | - | `0x18` |
| `0xCD` | f32, chk | sensitivityPositiveY | - | `0x1C` |
| `0xD2` | f32, chk | sensitivityNegativeY | - | `0x20` |
| `0xD7-0xFF` | - | unused (the read-all fetches `0x00..0xD7`) | - | - |
| `0x100 + 0x20s` (s = 0..15) | ≤ 20 bytes | shortcut s (3.7) | count 0 | `0x90 + 0x34s shortCutKey[s]` |
| `0x300 + 0x180m` (m = 0..15) | ≤ 384 bytes | macro m (3.7) | empty | `0x3D0 + 0x250m macroKey[m]` |

### 3.6 Response handling (FUN_1000eb30 `:13783-14038`)

1. **`cmd == 0x0A`** (unsolicited): the 10 data bytes are copied. If battery-optimize is enabled (default **on**, `.data 0x1001d071 = 01`) and bit6 is set, battery is handled internally (3.9). The callback is then raised with dataLength 10.
2. **Otherwise**, the response must match the head of the queue: head sent, and `resp[1] == head cmd`.
   - For `0x07`, all 17 bytes must equal the request, or the request is re-sent.
   - For `0x08` at addresses `0x0000`/`0x0004`/`0x004C`/`0x00A0`, the DLL's cached map is also patched.
   - The entry is moved to a completed list. When an entry with `isLast=1` completes, the data fields of all completed entries are concatenated: `Σ resp[5]` bytes, 10-byte stride.
3. **Dispatch:**
   - If the tag is 1..0x50 (0x51), the full-flash-read state machine runs (3.6.1).
   - Otherwise the callback gets `(requestHeader with [5]=resp[5], 17, data, len)`. `len` is forced to 4 for `0x03`/`0x04` single replies.
   - For `0x04` with battery-optimize enabled, the DLL instead emits a synthetic battery reply (3.9).

#### 3.6.1 Read-all state machine (CONFIRMED, FUN_10005d30 `:4536`, FUN_10005fe0 `:4719`, FUN_10006170 `:4830`)

1. `ReadAllFlashData` → `ReadFalshData(0x0000, 0xD8, tag 1)`: 22 packets of `08 08 00 <addr> <len≤10>` with addr += 10; only the last has isLast=1.
2. Tag 1: copy 0xD8 bytes to image `[0x000..0x0D7]`; fill the rest of the 0x2000-byte image with `0xFF`. Queue `read(0x100, 10, tag 2)`.
3. Tags 2..0x11 (shortcut s = tag-2 header):
   - If `count = data[0]` is 2..6: `read(0x100+0x20s, count*3+2, tag s+0x12)`.
   - Otherwise: if s < 15, `read(0x100+0x20(s+1), 10, tag s+3)`; else go to macros.
4. Tags 0x12..0x21: verify the shortcut checksum and copy into the image, then continue with the next shortcut or macros.
5. Macro m: queue two reads, `read(0x300+0x180m, 10)` and `read(0x31F+0x180m, 10, isLast)`, both tag m+0x22. The first gives nameLength, the second contextCount (`data[10]`).
6. Tags 0x22..0x31: if nameLength is 1..30, `read(0x300+0x180m, contextCount∈[2,70] ? contextCount*5+0x21 : nameLength+1, tag m+0x42)`. Otherwise go to the next macro, or finish.
7. Tags 0x42..0x51: normalise via `BufferToMacroKey` → `MacroKeyToBuffer` into the image; next macro, or finish.
8. Finish: `ProtocolDataParser(image, dllCache)` then callback `cmd = 08 08 00 00 00 00 …`, data = image, len = **0x1B00**. C# accepts exactly `address==0 && receivedData.Length==6912` (`CDevice_JiangMeng_Mouse.cs:478-482`).

Cost for an empty device: 22 + 16 + 32 = 70 exchanges at about 8 ms + round trip each (INFERRED about 1-2 s). C# waits up to 5 s.

### 3.7 Value encodings

**Report rate** (`Enums/REPORT_RATE.cs`, `JiangMengDataConvert.smethod_1 :71-93`):

| Rate | Byte |
|---|---|
| 1000 Hz | `0x01` |
| 500 Hz | `0x02` |
| 250 Hz | `0x04` |
| 125 Hz | `0x08` |
| 2000 Hz | `0x10` |
| 4000 Hz | `0x20` |
| 8000 Hz | `0x40` |

The UI offers all seven (`T_JiangMengMouse_Profile.InitMouseParamItems`). CONFIRMED.

**LOD**: LodItems `"0.7"`, `"1"`, `"2"`. `0.7` → 3; otherwise byte(value), so 1 or 2. CONFIRMED.

**DPI stage** (`JiangMengDataConvert.smethod_0 :28-69`; CONFIRMED encoder, INFERRED firmware meaning):

```text
if dpi >= 30000: n = dpi/100; ex.bit4 = 1 (X ×100 range), ex.bit0 = 1 (Y ×100 range)
else:            n = dpi/50
x = y = n & 0xFF
ex.bit7 = (n>>9)&1 ; ex.bit6 = (n>>8)&1        // X high bits
ex.bit3 = (n>>9)&1 ; ex.bit2 = (n>>8)&1        // Y high bits
ex.bit5 = ex.bit1 = 0
decode: X = (((ex>>6)&3)<<8 | x) * (ex&0x10 ? 100 : 50); Y = (((ex>>2)&3)<<8 | y) * (ex&0x01 ? 100 : 50)
```

The UI range is 50..36000 with step 50 (`T_JiangMengMouse_Profile.InitMouseParam`). The default lists are 1..6 stages from `{400 red, 800 blue, 1600 green, 3200 yellow, 6400 cyan, 30000 magenta}`. `maxDPI := stage count`, `currentDPI := CurDPIIndex`. `SetFlashDataMap` rebuilds all 8 `dpiConfig` entries; entries beyond the count become 00 00 00 / 00 00 00.

**Key function map** (`KeyFunMapDriver.cs`, `Enums/KEY_CLASS.cs`); flash bytes `type, p1, p2, chk`:

| type | KEY_CLASS | p1 | p2 |
|---|---|---|---|
| 0 | Close (disabled) | 0 | 0 |
| 1 | MouseKey | mask 1 L, 2 R, 4 M, 8 Back, 0x10 Fwd | 0 |
| 2 | ChangeDPI | 1 loop, 2 +, 3 - | 0 |
| 3 | AC-Pan | 1 left, 2 right | 0 |
| 4 | Fire (auto-click) | speed | count. Double-click = `Fire(50,2)` |
| 5 | Shortcut | shortcut index | 0 |
| 6 | Macro | macro slot | repeat: 1..250 = N times, **254 = while held**, **255 = toggle** |
| 7 | ChangeReportRate | 0 | 0 |
| 8 | DecorativeLamp | - | - (unused) |
| 9 | ChangeConfig | 0 | 0 |
| 10 | DPILock (Smart DPI) | `dpi/50 - 1` | 0 |
| 11 | Wheel | 1 up, 2 down | 0 |

C# index = `ButtonId` 0..15. The UI buttons are 0 L, 1 R, 2 M, 3 Back, 4 Fwd, 5 DPI (`T_JiangMengMouse_Profile.GetBasicButtons`). Default table written by C# (`smethod_10 :490-511`):

| Key | Default |
|---|---|
| 0 | Mouse L |
| 1 | Mouse R |
| 2 | Mouse M |
| 3 | Back |
| 4 | Forward |
| 5 | DPI loop |
| 6 | DPI+ |
| 7 | DPI- |
| 8 | ReportRate |
| 9 | ReportRate |
| 10 | none |
| 11 | Fire(10,2) |
| 12-15 | none |

**Keyboard, media and app bindings are implemented as macros.** The button's macro slot `ButtonId` receives a key sequence, and the key entry becomes `Macro(ButtonId, 1)` (`smethod_4/8/9`).
- Keyboard: modifiers down (Ctrl `0xE0`, Win `0xE3`, Shift `0xE1`, Alt `0xE2`, all with type 1 Normal), key down, modifiers up, key up (`MacroKeyDriver.cs`).
- Media: consumer usage with type 2, down then up.
- Calculator: consumer `0x0192`.

**Shortcut** (flash `0x100+0x20s`; `ShortcutKeyToBuffer :6161`, `BufferToShortcutKey :6265`):

```text
[0] count (valid 2..6, else slot treated as empty)
[1+3j] flags|type : 0x80 = key down (KEY_STATE.KeyDown=0), 0x40 = key up (KeyUp=1); low nibble = HID_CODE_TYPE (0 Modify,1 Normal,2 Media,3 Power,4 Mouse)
[2+3j] value lo  [3+3j] value hi
[count*3+1] chk = 0x55 - Σ[0..count*3]
write length = count*3+2
```

**Macro** (flash `0x300+0x180m`; `MacroKeyToBuffer :6371`, `BufferToMacroKey :6424`):

```text
[0x00]      nameLength (1..30)          [0x01..0x1E] name bytes
[0x1F]      contextCount (valid 2..70)
[0x20+5j]   flags|type (0x80 down / 0x40 up | type&0x0F)
[0x21+5j]   value lo   [0x22+5j] value hi
[0x23+5j]   delay hi   [0x24+5j] delay lo      (u16 BIG-endian ms; C# uint truncated)
[0x20+5n]   chk = 0x55 - Σ[0x1F .. 0x1F+5n]
write length = 5n + 0x21 (covers name header too)
```

C# macro rules (`JiangMengDataConvert.smethod_7 :233-321`, `JiangMengMouse_Oper.SetButton`): at most 69 steps.
- A leading context `{keyState 1 (up), type 1, value 0, delay = first delay}` is prepended.
- Delays are shifted to "delay after".
- Mouse steps use type 4 with the button mask; keyboard steps use type 1 with the HID usage.
- `MacroKey.SetMacroName` is dead code (`if (name.Length < name.Length)`), so **nameLength is always 0**. Consequence: the read-all state machine skips these macros on read-back (it requires nameLength 1..30), so the DLL cache never contains them and every Update re-writes them. CONFIRMED vendor bug.

### 3.8 Writing settings (`CS_ProtocolDataUpdate`, FUN_10006e30 `:5621-6143`)

1. C# mutates its `FlashDataMap` via `JiangMengDataConvert.SetFlashDataMap`. This touches only dpiConfig, maxDPI, currentDPI, reportRate, silenceHeight, keys and macroKey[ButtonId]. C# then calls `Update(map)`.
2. The DLL compares the new map with its cache (from the last read-all) **field by field, in this order**, and queues `0x07` writes only for changed items, each as `[value bytes…, chk]`:
   - Single bytes (2-byte writes) at `0x00, 0x02, 0x04, 0x06, 0x08, 0x0A, 0xA9, 0xAB, 0xAD, 0xAF, 0xB1, 0xB3, 0xB5, 0xB7, 0xB9, 0xBD, 0xBF, 0xC1`.
   - Floats (5-byte writes) at `0xC3, 0xC8, 0xCD, 0xD2`.
   - For each of 8 DPI stages: `0x0C+4i` (4 bytes), then colour `0x2C+4i` (4 bytes).
   - DPI LED `0x4C/0x4E/0x50/0x52`.
   - LED bar `0xA0` (7 bytes) and `0xA7` (2 bytes).
   - Keys `0x60+4k` (4 bytes).
   - Shortcuts `0x100+0x20s` (count*3+2 bytes).
   - Macros `0x300+0x180m` (5n+0x21 bytes).
3. Items longer than 10 bytes are split into 10-byte chunks at addr+10·i (FUN_10006cd0 `:5515`). Only the final chunk of each item has isLast=1 (FUN_10006bf0 `:5443`). Each chunk must be echoed exactly.
4. Flash writes are **not** followed by any commit or reset command. INFERRED: the firmware applies each write immediately.

### 3.9 Battery and the DLL "battery optimizer" (CONFIRMED structure, INFERRED semantics)

- `0x04` reply: `level %, charging, voltage(BE)`.
- **Optimizer.** Enabled at load (`0x1001d071 = 1`); `CS_UsbServer_SetBatteryOptimizeEnable` exists but C# never calls it.
  - While the server runs, every 5000 ms it calls `UsbFinder_GetBatteryLevel` (FUN_10005770 `:4201`). If the voltage is non-zero, it maps voltage to percent with a **21-point table (mV)** at `.data 0x1001d07c`: 3050, 3420, 3480, 3540, 3600, 3660, 3720, 3760, 3800, 3840, 3880, 3920, 3940, 3960, 3980, 4000, 4020, 4040, 4060, 4080, 4110. These are 5 % steps with linear interpolation (FUN_100056d0 `:4156`).
  - It then moves the displayed value by at most 1 % per interval: 10 000 ms (`0x2710`) normally, 300 000 ms (`0x493E0`) in some charging states (`0x1001d074/78`).
  - It synthesises callbacks of the form `cmd 08 04…`, data `{%, charging, vHi, vLo}` (FUN_10005ab0 `:4396`).
- It **persists** the last value to the registry: `HKCU\Software\DeviceBatteryOptimize`, value `BatteryValue_%02x%02x%02x` (INFERRED: CID/MID/type), REG_SZ formatted `"%u%u-%u"` (FUN_10005040 `:3786`, FUN_10004d30 `:3656`).
- On Linux, a simple smoothing filter and an XDG state file (or no persistence) replaces this.

### 3.10 Pairing, online, identity (CONFIRMED, C# `CDevice_JiangMeng_Mouse.cs:436-716`)

- `GetPairDevices` / `CanEnterPairing` / `EnterPairing(hidStr)`: `FindHidDevicesByDefaultDeviceId("25aa","400f")`. Exactly one dongle must be present, otherwise error 1001002 "Please keep only one dongle!".
- EnterPairing then runs `Start(hidStr,hidStr)` and `EnterDonglePair()` (`0x05` len 2 `00 00`), and waits up to 20 s for the `0x05` reply.
- On the reply: mark disconnected, then every 500 ms send `ReadDonglePairStatus` (`0x06`) until `data[0]` is 3 or 11 (success) or 2 (fail), or 25 s elapse (timeout). It emits `NotifyDevicePairResult {err_code 0 | 1002001, Tag bool, err_msg}`.
- Versions: mouse FW = `0x12` → `"V" + X4`. Receiver FW = dongle USB `bcdDevice` via `HidD_GetAttributes`.

### 3.11 Firmware upgrade (drop)

`UsbUpgrade_Start(bin, cb, timeout)` (`:14725-14774`) parses a vendor container header (strings: icName, fileId, boot/normal input/output endpoints, senserName, productName). It supports a "Main and Slave" pair (dongle + mouse). It resets the device to boot mode (`ResetToBootMode`, sent by `WriteFile` or `HidD_SetFeature`), waits for a single boot device ("Multi Boot Device Error" otherwise), downloads, and reports via `cb(cmd[0]=7, cmd[1]=UpgradeState{1 DownLoadFile progress=cmd[2], 2 UpgradeResult=cmd[2] UpgradeResultParam}, …)`.

The C# side waits up to 180 s (`JiangMengMouse_Oper.UpgradeFw`, around lines 1739-1836). Logs go to `dll_log.txt` in the CWD when enabled. Only the outline is documented here (INFERRED details). **Not recommended for porting.**

---

## 4. Linux port plan

### 4.1 Recommendation

1. **Default: ship without these drivers**, or behind a compile/feature flag that is off by default. The user owns none of these devices, the Windows app never even loads the DLLs on their PC (section 1), and no behaviour can be validated.
2. If implemented, use clean-room userspace drivers over **hidraw**. No kernel module is needed, nothing links against the vendor DLLs, and there is no Wine.
3. **Never implement** firmware flashing, VID/PID/serial/CID writes (`0x0B`, `0x0C`, `0x0D`, `0x11`, `0x1A`, `0x1F`, `0xF0`) or MTK mode. They are high brick risk and need online firmware anyway.

### 4.2 Enumeration and hot-plug (replaces SetupAPI, `Global.UsbList`, `RegisterDeviceNotification`)

- Use `libudev` (or `pyudev`): monitor subsystem `hidraw`. For each node read `…/device/uevent` for `HID_ID=0003:000025AA:0000PPPP`, and the USB interface number from the parent `usb_interface` (`bInterfaceNumber`).
- **YJX**: parse `/sys/class/hidraw/hidrawN/device/report_descriptor`. Pick the node whose top-level Application collection is Usage Page `0xFF01` (`06 01 FF`) and Usage `0x10` (`09 10`). The PID must be in {`200F`,`2010`,`2011`,`2012`,`401A`,`401B`}. Wired = {`200F`,`2011`,`401B`}, dongle = {`2010`,`2012`,`401A`}.
- **JiangMeng**: the node with `bInterfaceNumber == 1` and PID in {`4010` wired SPK9718, `400D` wired SPK9728, `400F` 8K dongle}. Confirm that the descriptor declares report ID 8 (`85 08`) with a 16-byte input/output. There is no "col05" on Linux; one hidraw node per interface carries all its collections.
- The udev rule for unprivileged access (INFERRED, standard practice) goes in `/etc/udev/rules.d/70-evnia-mice.rules`:
  ```
  SUBSYSTEM=="hidraw", ATTRS{idVendor}=="25aa", ATTRS{idProduct}=="200f|2010|2011|2012|401a|401b|4010|400d|400f", TAG+="uaccess"
  ```
- On add or remove, emit the same Bridge notifications as Windows: `NotifyDeviceConnectionStatus`, plus DPI notifications (see report 05/bridge).

### 4.3 YJX driver (hidraw)

```text
write(fd, [0x00] + pkt64)          # 65 bytes; kernel drops report-ID 0 (usbhid_output_report)
read(fd) -> 64 bytes, resp[0]==0xAA (no report ID prefix on Linux)
transact(pkt): write; loop poll(fd, ≤1000 ms): r=read; if r[0]==0xAA and r[1]==pkt[1]: return r
               else if r[1] in (0xFA,0xED): handle_async(r)   # improvement over vendor
connect():   if dongle: r=transact(55 ED); online = r[8]==2
             battery: r=transact(55 30 A5 0B 2E 01 01 01 00) -> r[8]=%, r[9]=charge
             keys = parse(transact(55 08 A5 0B 20 00 00 P))
             cfg  = parse(transact(55 0E A5 0B 2E 01 01 P 00 00))
             ver  = transact(55 03) -> fw=int(r[23:26]), dongle=int(r[20:23])
set_config(cfg): transact(55 0F AE 0A 2E 01 01 P P ... per table 2.5.2)   # ONE write per change (vendor sends 2+n)
set_keys(keys9): transact(55 09 A5 22 20 00 00 P, 9×4 bytes)
set_macros(list16): build image (2.7), send 0x0D chunks (fix the len==0 edge case), then 55 10 A5 22 00 00 00 05
idle: poll fd for AA FA / AA ED reports (2.8)
```

- Keep bytes `[2..6]` exactly as specified. They are opaque constants.
- For DPI colours, either replicate the vendor (zeros at `[27..47]`) or preserve the bytes last read (see Open question Q1). Replicating the vendor matches tested Windows behaviour.

### 4.4 JiangMeng driver (hidraw)

```text
pkt = [0x08, cmd, 0, addrHi, addrLo, len] + data10 ; pkt.append((0x55 - sum(pkt)) & 0xFF)   # 17 bytes
write(fd, pkt)   # report ID 8 is sent on the wire
read loop: accept r if len(r)==17 and r[0]==0x08 and r[16]==(0x55-sum(r[0:16]))&0xFF
           r[1]==0x0A -> async status (3.4) -> issue follow-up reads (DPI:@0x04 len1, RR:@0x00 len1, config:read-all, LED:@0x4C len8, bar:@0xA0 len9, battery:0x04)
           else match head-of-queue by cmd; 0x07 requires byte-exact echo; timeout 1000 ms (0x09: 5000 ms); ≤5 attempts; 8 ms gap before each write
read_all(): implement the 3.6.1 state machine (or simply read 0x0000..0x1AFF in 10-byte chunks = 692 packets, simpler but slower; INFERRED harmless)
apply(): diff new map vs cache in the 3.8 order; write only changed items with per-item check bytes; chunk >10 bytes
battery(): 0x04 every ~5-10 s while connected (optional smoothing with the 3.9 voltage table; no registry)
pair(): single 0x400F dongle -> 0x05 [00 00]; then 0x06 every 500 ms until data[0] in {3,11} (ok) / 2 (fail) / 25 s
```

### 4.5 Feature matrix

| Feature | YJX | JiangMeng | Linux difficulty | Keep? |
|---|---|---|---|---|
| Detect / connect / online | Y (`0xED`) | Y (`0x03`) | low | yes (if module enabled) |
| DPI stages/value/index | Y (config 0x0F) | Y (flash 0x02/0x04/0x0C..) | low | yes |
| Polling rate | 125-1000 | 125-8000 | low | yes |
| LOD | 1/2 | 0.7/1/2 | low | yes |
| Button remap | Y (0x09) | Y (flash 0x60) | medium | yes |
| Macros | Y (0x0D/0x10) | Y (flash 0x300) | medium-high | optional |
| Battery / charging | Y (`0x30` + async) | Y (`0x04` + async) | low | yes |
| Lighting | lightMode byte only (semantics unknown); DPI colours never sent | DPI colours + DPI LED + LED bar exist in flash but the Windows UI does not expose them | medium (unverified) | no (UI never exposed it) |
| Sleep, motion sync, angle snap, ripple, debounce, high speed | in config block, UI not exposed | in flash, UI not exposed | low | optional |
| 2.4G pairing | none (hardware) | Y (`0x05`/`0x06`) | medium | optional |
| Onboard profiles | profile byte in header; app uses 0 only | Set/GetCurrentConfig exist, unused | - | no |
| Firmware version | Y (`0x03`) | Y (`0x12`) + dongle bcdDevice | low | yes (local display only) |
| Firmware update | Y (dangerous) | Y (dangerous) | high | **drop** (online-sourced) |
| Factory reset | code 6 (writes defaults) | `0x09` ClearSetting | low | yes |

### 4.6 Testing without hardware

- Unit-test packet builders against the golden vectors in 3.4, the YJX headers in 2.5.1 and the CRC vectors in 2.9.
- Optionally, create a `uhid` virtual device (Linux `/dev/uhid`) with a matching report descriptor that answers from a scripted model of these tables. This exercises the full hidraw path in CI.

---

## 5. Online touchpoints

| What | Where | Trigger | Endpoint | Strip recommendation |
|---|---|---|---|---|
| Firmware OTA check for these mice | renderer `work/app-pretty/renderer/assets/styles-DAnQi2A8.js:33930-33980` builds `{dpDeviceType, dpComponentId, detectVersion, packageUrl, hashMethod…}` from `DeviceInfo.ExtDeviceInfo`; C# fills `DP_DeviceType="EVNIA_MS_<Model>"`, `DP_ComponentID="EVNIA_MS_<Model>_<VID hex>_<PID hex>"` (`CDevice_YongJiaXing_Mouse.cs:54-55`, `CDevice_9618_8960_Mouse.cs:53-54`, `CDevice_JiangMeng_Mouse.cs:65-72`, plus `DP_ReceiverDeviceType="EVNIA_24G_SPK9718"` and `DP_ReceiverComponentID="EVNIA_24G_SPK9718_<VID>_<PID>"` for the dongle) | settings / update page, `navigator.onLine` | vendor OTA server (see OTA/cloud report) | Remove the OTA fetch. Keep only local version display. Do not expose `Device_UpgradeFw` |
| Firmware apply | `Bridge.Device_UpgradeFw(device, path)` (`Bridge.cs:104-107`) → `SystemOper.UpgradeFw` (`SystemOper.cs:769`) → `YongJiaXingMouse_Oper.UpgradeFw` / `HaiHui_9618_8960_Mouse_Oper.UpgradeFw` / `JiangMengMouse_Oper.UpgradeFw` (reads `<path>/<name>/<name>.bin`) | after OTA download | local file from OTA | Drop entirely (no local-flash feature) |
| Feedback metadata | renderer `feedback-NPrjkfNw.js:125-129`, `styles-DAnQi2A8.js:44690` include `fwComponentID=fwVersion` of attached devices | user sends feedback | vendor feedback endpoint | Drop with the feedback feature |
| Native DLLs | `Mouse_SPK9*.dll` imports: SETUPAPI, KERNEL32, HID, USER32, ADVAPI32, OLEAUT32, CRT only | - | **none** (CONFIRMED, `*.symbols.txt` IMPORTS) | n/a |
| Local side effects (not online) | JiangMeng DLL writes `HKCU\Software\DeviceBatteryOptimize` and optionally `dll_log.txt` | battery optimizer, upgrade log | local | Do not port |

---

## 6. Open questions

- **Q1 (YJX).** The config write zeroes bytes `[27..47]`. Does the firmware interpret them as DPI colours, so that Windows effectively blanks the DPI LED colours on every write? The read path does not parse them either. Needs a device capture.
- **Q2 (YJX).** Meaning of the header bytes `[2..3]` (`A5 0B` read, `AE 0A` config write, `A5 22` key/commit write, `00 00` macro chunk) and `[5..6]` (`01 01` for config/battery, `00 00` for keys). They are treated as opaque constants.
- **Q3 (YJX).** Semantics and units of `lightMode` (default 1), `sleepTime` (defaults 20 or 3; UI min/max 1..50, possibly minutes), `highSpeed` (0 or 255), `srollFlag`, and the commit argument `0x05` of cmd `0x10`.
- **Q4 (YJX).** Is `resp[20..25]` of cmd `0x03` always ASCII digits? The code tolerates non-digits.
- **Q5 (YJX FW).** The progress-callback arguments between upgrade steps are truncated in the decompile. Also the meaning of the fallback bootloader collection (UsagePage `0x0001`, Usage `0x0000`) and the finish-ack value 1.
- **Q6 (JiangMeng).** Response status byte `[2]` semantics. The exact retry limit (the `<5` counter) and whether it resets per entry.
- **Q7 (JiangMeng).** DPI raw encoding: is the firmware value `dpi/50` (C# DPI stages) or `dpi/50 - 1` (C# DPILock uses `-1`)? One of the two C# paths is off by one.
- **Q8 (JiangMeng).** Linux report-descriptor layout of interface 1 (report ID 8 size and in/out direction), and whether an interrupt OUT endpoint exists or `SET_REPORT` is used. hidraw handles both, but a capture would confirm.
- **Q9.** Physical button count and mapping on SPK9728 / 8K-dongle variants beyond ButtonIds 0-5.
- **Q10.** VIDs `0xA8A4`/`0xA8A5` hard-coded in the YJX DLL: are there Evnia-branded devices using them? None appear in `PCenter_DeviceInfo.json`.

## 7. Cross-references (outside this scope)

- **Bridge / notification plumbing**: `Bridge.Lib/Bridge.Lib/Bridge.cs:54-107, 609-704` (Mouse_*, Button_*, Profile_*, Pairing, Device_UpgradeFw); `Notification_Func` values `const_7` (DPI changed), `NotifyDeviceConnectionStatus`, `NotifyButtonsChange`, `NotifyDevicePairResult`, `NotifyDeviceUpgradeFwProgress`. See the backend-host and Bridge reports.
- **Device registry / connection loop**: `Zeasn.Framework.Core.Lib/SystemOper.cs:884-904` (DeviceType → Oper), `:3390` (special-casing `JiangMeng_Mouse_Dongle_8K`); `Zeasn.Win.Lib/UsbUtil.cs:9` (`GetUsbList`); `CDeviceMouseBase`/`CDeviceProfileBase` in `Zeasn.Equipment.Base.Lib`.
- **HaiHui SPK9618-3395 (M3395)** in `Zeasn.USB.HaiHui.Lib/Zeasn.USB.HaiHui.Lib.M3395/*` (managed-only HID protocol, BLE variant) is **not** covered here; only its sibling 8960 (YJX DLL) is. See the peripherals-part-1 report or a HaiHui report.
- **Macro library / theme profiles**: `Macro_*` Bridge functions and `T_Theme_Profile.cs:101-109` (8K dongle model resolution by CID/MID).
- **OTA / cloud update service** consuming `DP_ComponentID`: renderer `styles-DAnQi2A8.js` around 33930 and 34386; see the online/OTA report.
- **Generic `DictMgr` / `PCenter_DeviceInfo.json`** (VID/PID, Extra, ProfileCount) shared with the RongYuan, BeiYing and HaiHui drivers.
