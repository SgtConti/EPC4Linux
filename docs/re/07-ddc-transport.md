# 07 — DDC transport layer (Zeasn.DDC.Lib, DDCHelperLib.dll, Dxva2)

## Summary

Evnia Precision Center (EPC) v1.13.0 can reach a monitor over DDC/CI in two ways:

1. **Hub path (USB).** `Zeasn.Monitor.Lib` sends DDC/CI frames through the monitor's own USB hub/scaler bridge (Realtek `RhHidAPI.dll` HID-I2C, or Genesys `GL_SDK.dll`). That path belongs to another report; see the Cross-references section.
2. **GPU path.** This is the subject of this report. `Zeasn.DDC.Lib` (managed) calls `DDCHelperLib.dll` (native, 32-bit). DDCHelperLib is a legacy multi-vendor DDC/CI library ("DDCHelper"). It can reach the monitor's I²C bus through AMD ADL, NVIDIA NVAPI, Intel IGCL, Intel CUI (COM), legacy `atiddc.dll`, Matrox `MtxApi.dll`, a kernel driver `\\.\MDDCDRV` (not shipped), or the Windows **Dxva2** monitor-configuration API.

Most operations send the **standard DDC/CI framing** (`0x6E 0x51 0x80|len … xor-checksum`, reply checksum seeded with `0x50`) as raw bytes. It has fixed delays: **100 ms after every write** and **50 ms after every read**, plus `5·attempt` ms between the write and the read, with up to 3 attempts. The only exception is monitors that were found through Dxva2 alone, where the Dxva2 calls are used instead.

The TPV/Philips vendor operations are ordinary DDC/CI packets that carry manufacturer VCP codes and extra bytes:

- **Extended VCP get/set:** `01 E2 A0 xx` / `03 E2 A0 xx hi lo`.
- **Factory serial number:** `01 FE EF 13 00 00 20`.
- **Firmware version string:** `01 FE E1 E6 06 00`.

The monitor's capability string advertises `cmds(01 02 03 07 0C E3 F3)`, so table read (0xE2) and table write (0xE7) are **not** used. Here 0xE2 appears only as a VCP code.

On the user's machine (an AMD GPU, Philips 34M2C8600 connected over DisplayPort), the logs show the GPU path working through **AMD ADL `ADL_Display_DDCBlockAccess_Get`**. The app uses it only at start-up: enumeration, EDID read, the VCP 0x14 support probe and the factory serial number. Every runtime VCP get/set (233 calls, all successful) went through the USB hub path.

The managed Dxva2 wrapper in `Zeasn.Win.Lib` (`WhaleTV.Win.Display.Lib`) is **dead code**; nothing references it.

**Linux port:** replace the whole layer with one `/dev/i2c-N` DDC/CI codec (slave 0x37, EDID at 0x50). Map buses to DRM connectors through `/sys/class/drm/card*-*/ddc` or by EDID comparison, which is the same EDID-equality rule the vendor uses. Keep the vendor timings and retry counts. **There are no online touchpoints in this layer.**

Status tags used below:

- **[C]** = CONFIRMED: read in code, or seen in the logs.
- **[I]** = INFERRED.
- **[L]** = general Linux or DDC/CI platform knowledge, not taken from the corpus.

---

## 1. Sources and versions

| Item | Path | Notes |
|---|---|---|
| Managed DDC library | `work/dotnet-clean/Zeasn.DDC.Lib/` | Assembly version 1.0.12.0 (`Properties/AssemblyInfo.cs:6-13`). `Class2.cs` is NET Reactor runtime code (MD5, AES, method-token table) and has no DDC logic. |
| Native helper | `Evnia Precision Center/resources/bin/DDCHelperLib.dll` | PE32 x86, ImageBase 0x10000000. SHA-256 `27315597194D24F6954E168A07125B7EB849369E9AAB2E660C4E65F22BC4825C`. Sections: `.text` VA 0x1000 → raw 0x400; `.rdata` VA 0x46000 → raw 0x45200; `.data` VA 0x5B000 → raw 0x59400. |
| Decompilation | `work/native/DDCHelperLib.dll.c` (65,677 lines), `DDCHelperLib.dll.symbols.txt` | Ghidra 12.1.4. |
| Dxva2 P/Invokes | `work/dotnet-clean/Zeasn.Win.Lib/WhaleTV.Win.Display.Lib/DisplayDeviceWinApi.cs:209-233` | Only managed Dxva2 user. Unreferenced (§5.2). |
| Consumers | `Zeasn.PCenter.Base.Lib/Display.cs`, `Zeasn.Equipment.Base.Lib/GClass3.cs:143-175`, `Zeasn.Equipment.Option.Lib/.../CDevice_PHLDisplay.cs:111-138` | |
| Runtime logs | `%APPDATA%/EvniaServe/logs/2026-09-25.txt` (app **1.11.0**), `2026-09-26.txt` (app **1.13.0**) | See the version note below. |
| VCP cache | `%APPDATA%/EvniaServe/Config/data.json` | Holds the monitor's full capability string (§7.4). |

**Version note [C].** The native log lines carry the C source line number in the form `--R:<line>--`. The corpus DLL embeds line constants 0x0E96 = 3734 for `InitDDCHelper` (bytes at VA 0x1000ad96: `C7 45 E4 96 0E 00 00`) and 0x13CA = 5066 for `GetEDIDOption` (VA 0x1000b858). These match the **2026-09-26** log. The 09-25 log shows 3631 and 4963, which belong to the 1.11.0 build. The Electron log `evnia/logs/26-09-25.log:1` says "App ready, version 1.11.0"; `26-09-25.log:9-19` shows the auto-update to 1.13.0, and `26-09-26.log:1` says "version 1.13.0". Both builds produce **the same DDC message sequence**. Only the line numbers are shifted by 103.

---

## 2. Architecture

```
Bridge.Lib (hub method) ─► Zeasn.PCenter.Base.Lib.Display
                              │  GetStandardValue / SetStandardValue / GetTPVExternValue / SetTPVExternValue
                              │  (Display.cs:354-474)
                              ├─(1) if MonitorDevice != null → MonitorService (Zeasn.Monitor.Lib, USB hub DDC)   [other report]
                              └─(2) else / on error → foreach DDCDisplayInfo with IsSupportDDCCI:
                                      Zeasn.DDC.Lib.New.NewDDCOper  (lock Utils.MonitorLock, InFirmwareUpdate gate)
                                        └─ Class1 (lock object_0, Task.Run(...).Wait())
                                             └─ P/Invoke DDCHelperLib.dll (stdcall, x86)
                                                  ├─ raw I²C "invoke" backends: ADL / NVAPI / IGCL / Intel CUI / atiddc / MDDCDRV / Matrox / PCI bit-bang
                                                  └─ Dxva2 (monitors found only via Windows enumeration)
```

- The **hub path is tried first**, and the GPU path runs only if the hub path is unavailable or fails [C] (`Display.cs:356-383`, `388-412`, `417-444`, `449-473`).
- The monitor lock `Utils.MonitorLock` is set to `Const_Lock.Monitor`, **the same lock object the hub MonitorService uses** (`CDevice_PHLDisplay.cs:133,137`). All DDC traffic on both paths is therefore serialized [C].
- `Utils.InFirmwareUpdate` blocks all GPU-path DDC while an OTA update runs [C] (`NewDDCOper.cs:20-24,100-108,…`). It is set from `MonitorService.OTAStateChanged` (`CDevice_PHLDisplay.cs:138,141-145`).
- The hub USB display and the DDC display are merged into one `Display` by matching **serial number, case-insensitive**: the DDC factory SN against the hub's EDID SN [C] (`GClass3.cs:50-72`).

---

## 3. Managed layer: `Zeasn.DDC.Lib`

### 3.1 Public API (`Zeasn.DDC.Lib.New.NewDDCOper`, `NewDDCOper.cs`)

| Method (lines) | Behaviour [C] | Return |
|---|---|---|
| `SwitchGetCommandChecksum(bool)` (12-15) | Calls `SwitchGetCommandChecksum` in the DLL. `CDevice_PHLDisplay` passes **true** (strict reply checksum) in its constructor (`CDevice_PHLDisplay.cs:132`). | — |
| `DDCHelAPIIni(params string[] supportTypes)` (17-75) | Returns empty if `InFirmwareUpdate`. Otherwise, under `MonitorLock`: `DDCCIHelperIni` → `EnumDisplayIDIni` → for each display whose `DisplayName` prefix before `_` contains any `supportTypes` entry (case-insensitive; called with `"PHL"`, `GClass3.cs:151`): `DDCSupportJudge_C` (+ factory SN) → `IsSupportDDCCI`, `DisplayEDID`, `DisplaySN`. | `List<DDCDisplayInfo>` |
| `JudgeSupportDDCCI(int)` (77-81) | `Class1.smethod_7`. **No external callers.** | bool |
| `GetCapabilites(int, out string)` (83-96) | `Class1.smethod_8` (§3.4.4). | bool (false only on exception) |
| `getTPVExternDDCCI_VCPSupportFun_CS(idx, app, acode, ext)` (98-109) | Extended get that returns only the value and ignores the return code. **No external callers.** | uint |
| `GetStandardDDCCIValue(idx, vcp, ref val, ref max)` (111-122) | `Class1.smethod_10`. | 0 = OK; -1 while in FW update; else DLL error code |
| `SetStandardDDCCIValue(idx, vcp, val)` (124-135) | `Class1.smethod_11`. | same |
| `GetTPVExternDDCCIValue(idx, app, acode, ext, ref val, ref max)` (137-148) | `Class1.smethod_12`. | same |
| `SetTPVExternDDCCIValue(idx, app, acode, ext, val)` (150-161) | `Class1.smethod_13`. | same |
| `smethod_0` = **GetExternDDCCIValue**(idx, byte[] send, len, byte[] recv, ref recvLen) (163-174) | Raw get with arbitrary payload (`Class1.smethod_14`). | 0 / err |
| `smethod_1` = **SetExternDDCCIValue**(idx, byte[] send, len) (176-187) | Raw set (`Class1.smethod_15`). | 0 / err |
| `smethod_2` = **GetDisplayFWVersion**(displayId) (189-215) | The name is proven by the caller `Display.cs:272`. Sends `{FE E1 E6 06 00}` through `smethod_0` with `iRecv = 32`. Takes the reply payload from index 3 if `payload[3] != 0`, otherwise from index 4; reads `iRecv` bytes as ASCII up to the first NUL. | string ("" on error) |

`DDCDisplayInfo` (`DDCDisplayInfo.cs`) fields: `DisplayID` (int), `DisplayName`, `MonitorName`, `DeviceName`, `DisplaySN`, `IsSupportDDCCI`, `VcpCode`, `DisplayEDID` (`stMonitorEDIDInfo_T`).
`SupportBrand` constants: `AOC`, `ENV`, `AMZ`, `PHL` (`SupportBrand.cs`).

### 3.2 P/Invoke table (`Class1.cs`)

All entries use `DllImport("DDCHelperLib.dll", CallingConvention.StdCall, SetLastError=true)`. The .NET x86 stdcall probe resolves undecorated names to the `_Name@N` exports.

| Managed decl (line) | Native export | Used? |
|---|---|---|
| `RegisterFunctionCallback(Delegate0)` (32-33) | `_RegisterFunctionCallback@4` | Yes, from the static ctor (25-30). |
| `InvokeCallbackFunction()` (35-36) | `_InvokeCallbackFunction@0` (self-test log spam) | No |
| `logDDCDrvClean()` (64-65) | `logDDCDrvClean` | Only via `smethod_1`, which is itself uncalled. |
| `logGetDDCDrv()` / `logBufGetDDCDrv(ref Struct2)` (67-71) | `logGetDDCDrv`, `logBufGetDDCDrv` | No |
| `SwitchGetCommandChecksum(bool)` (79-85) | `_SwitchGetCommandChecksum@4` | Yes |
| `DDCCIStruct(ref Struct0)` (87-88) | **not exported.** Would throw `EntryPointNotFoundException`. | No |
| `DDCCIHelperIni()` (90-104) | `DDCCIHelperIni` | Yes |
| `EnumDisplayIDIni(ref Struct1)` (106-153) | `_EnumDisplayIDIni@4` | Yes |
| `DDCSupportJudge_C(int, ref stMonitorEDIDInfo_T)` (196-233) | `_DDCSupportJudge_C@8` | Yes |
| `MonitorGetFactorySN_C(int, ref stMonitorSNDeal_T)` (235-272) | `_MonitorGetFactorySN_C@8` | Yes |
| `EnumMonitorCapabilitesStr(ref stMonitorCapPackage_T)` (274-318) | `_EnumMonitorCapabilitesStr@4` | Yes (hub fallback only) |
| `get/setStandardDDCCIValue_C(ref Struct0)` (320-324) | `getStandardDDCCIValue_C`, `setStandardDDCCIValue_C` | Yes |
| `get/setTPVExternDDCCIValue_C(ref Struct0)` (326-330) | `getTPVExternDDCCIValue_C`, `setTPVExternDDCCIValue_C` | Yes |

Every native call goes through `smethod_16`, which does `Task.Run(action).Wait()`: synchronous, on a thread-pool thread (522-529). It also holds the class lock `object_0`.

**Log callback [C].** The DLL calls `callback(1, msg)`, always with level 1 (`FUN_1001c570`, `DDCHelperLib.dll.c:17593`). The managed side maps level 1 to `Logger.smethod_7` (Information) (`Class1.cs:38-62`). This is why every `--R:` line in the logs is INFO.

### 3.3 Marshalled structures: exact byte layouts [C]

These are x86 sequential layouts with natural alignment and ANSI `ByValTStr`. The native offsets were cross-checked against the decompiled exports.

**`Struct0` — DDC/CI command block (0x428 bytes)** (`Struct0.cs`; native `getStandardDDCCIValue_C` etc., `DDCHelperLib.dll.c:6879-6977`)

| Off | Type | C# name | Meaning |
|---|---|---|---|
| 0x000 | byte[520] | `byte_0` | TX payload: opcode + data, **without** 0x51/len/checksum |
| 0x208 | byte | `byte_1` | TX payload length |
| 0x209 | byte[520] | `byte_2` | RX payload (reply bytes after the length byte, checksum stripped) |
| 0x411 | byte | `byte_3` | in: requested RX payload length; out: actual reply length |
| 0x414 | int | `int_0` | display index (DDCHelper list index) |
| 0x418 | byte | `byte_4` | VCP code (standard get/set only) |
| 0x41C | int | `int_1` | in: value to set / out: current value |
| 0x420 | int | `int_2` | 1 = get, 2 = set hint. **Never read by the DLL.** |
| 0x424 | int | `esoermrBX` | out: maximum value |

**`Struct1` — display package (0xC34 bytes)** (`Struct1.cs`; native `_EnumDisplayIDIni@4`, `.c:6521-6568`)

| Off | Type | Meaning |
|---|---|---|
| 0x000 | char[520] | `strName`: `"<PnPID>_<EDID monitor name>;"` repeated, e.g. `PHLC29F_PHL 34M2C8600;` |
| 0x208 | int[520] | `displayIndex[i] = i` |
| 0xA28 | int | set to 0 by the enumeration (return slot of `EnumGetFirst`) |
| 0xA2C | char[520] | `strDeviceName`: `"<GDI monitor device>;"` repeated, e.g. `\\.\DISPLAY1\Monitor0;` |

`Struct2`: char[52000]. It receives the native log ring buffer and is unused.

**`stMonitorCapPackage_T` (0xA30 bytes):** `strCapabilites` char[2600] @0x000, `curDispIndex` int @0xA28, `Length` int @0xA2C.
The export `_EnumMonitorCapabilitesStr@4` calls `GetMonitorCapabilitesStr(idx=[+0xA28], buf=+0, size=0xA28, &len=+0xA2C)`. This is confirmed from raw bytes at VA 0x10008650:
`8B 45 08 05 2C 0A 00 00 50 68 28 0A 00 00 8B 4D 08 51 8B 55 08 8B 82 28 0A 00 00 50 E8 …` [C]

**`stMonitorEDIDInfo_T` (16 × char[32] = 0x200 bytes):** field order and the source filled in by `DDCSupportJudge_C` (`.c:6626-6778`) [C]. Separator literals were read from `.rdata` [C].

| Off | Field | Filled with (GetEDIDOption code, §4.8.7) | 34M2C8600 value (log) |
|---|---|---|---|
| 0x000 | sManufacturer | first 3 chars of opt 1 | `PHL` |
| 0x020 | sMonitorName | opt 6 | `PHL 34M2C8600` |
| 0x040 | sModelName | opt 1 | `PHLC29F` |
| 0x060 | sSerialNumber | opt 5; overwritten in C# by the factory SN | `AU00000000001` |
| 0x080 | sManufacturerDate | `"Week"` + opt 0xC | `Week01-2025` |
| 0x0A0 | sVersion | opt 0x12 | `1.4` |
| 0x0C0 | TimingRecommandation | opt 3 + `"x"` + opt 4 | `3440x1440` |
| 0x0E0 | Description | monitor-object PnP string (+0x10C) | `PHLC29F` |
| 0x100 | ScreenSize | `"~"` + (int)(√(E²+F²)·0.03937) + 1 + `"\""` | `~35"` (sic; a +1 quirk on a 34" panel) |
| 0x120 | PlugAndPlayID | opt 1 | `PHLC29F` |
| 0x140 | DisplayGamma | opt 0xB | `2.2` |
| 0x160 | RedChromaticity | `"Rx"`+opt 0x16+`"-Ry"`+opt 0x17 | `Rx0.688-Ry0.302` |
| 0x180 | GreenChromaticity | `"Gx"`+0x18+`"-Gy"`+0x19 | `Gx0.241-Gy0.713` |
| 0x1A0 | BlueChromaticity | `"Bx"`+0x1A+`"-By"`+0x1B | `Bx0.144-By0.0584` |
| 0x1C0 | DisplayTypeAndSignal | opt 0xD | `DIGITAL` |
| 0x1E0 | WhitePoint | `"Wx"`+0x14+`"-Wy"`+0x15 | `Wx0.313-Wy0.328` |

**`stMonitorSNDeal_T` (0x2C bytes):** `sSerialNumber` char[32] @0x00, `extCode` byte @0x20, `iReadLength` int @0x24, `int_0` (copy length) int @0x28. The native export passes `(idx, extCode, (byte)iReadLength, &struct, int_0)` (`.c:6835-6846`).

### 3.4 Managed algorithms [C]

**3.4.1 `DDCHelAPIIni` / display naming** (`Class1.smethod_4`, 109-153)
- The DLL returns `strName` and `strDeviceName`. The managed side splits both on `;`. For entry *i*:
  - `DisplayID = i`
  - `DisplayName = "{i}-{name}"`
  - `MonitorName` = text after the first `_`
  - `DeviceName` = the device string with its last `\…` component removed (`\\.\DISPLAY1\Monitor0` → `\\.\DISPLAY1`). The default is `\\.\DISPLAY1` if the string has no "DISPLAY" (178-194).
- In the logs: `DisplayName=0-PHLC29F_PHL 34M2C8600`, `MonitorName=PHL 34M2C8600`.

**3.4.2 `JudgeSupportDDCCI`** (`smethod_7`, 199-233)
- Calls `DDCSupportJudge_C`. If the result is non-zero, it sleeps **200 ms** and retries once.
- On success it reads the factory SN (§3.4.3), replaces `sSerialNumber` with it if the result is non-blank, then strips non-ASCII characters.

**3.4.3 Factory SN** (`rpfBerbMnd`, 238-272)
- Call: `MonitorGetFactorySN_C(idx, {extCode=19 (0x13), iReadLength=32, int_0=20})`.
- If the result has length < 13, the SN is rejected (empty string).
- Otherwise the first 14 characters are used (Substring(0, 14) when the length is 14 or more).

**3.4.4 Capabilities post-processing** (`smethod_8`, 277-318)
1. Upper-case the whole string.
2. Extract the balanced `VCP(...)` group with a .NET balancing-group regex.
3. If that group has no spaces, insert a space after every 2-hex token.
4. Return `"vcp" + group[3..]`, for example `vcp(02 04 05 …)`.
5. The fallback (with a Chinese warning log) splits on `VCP(` and re-balances braces.

**3.4.5 DDC fallback loops** (`Display.cs`)
- Each GPU-path call loops over `DDCDisplays` where `IsSupportDDCCI`, and returns the first `0` result.
- Error values are passed through unchanged. Callers only test `== 0`.

---

## 4. Native layer: `DDCHelperLib.dll`

### 4.1 Exports

- 140 exports in total, of which **125 are `ctl*`**. The `ctl*` exports are thunks into Intel IGCL (`ControlLib32.dll`, loaded by name `"ControlLib32"` + `"%s.dll"`). Each does `GetProcAddress(hModule,"ctlX")` and calls through (e.g. `ctlI2CAccess`, `.c:2917-2938`). Managed code never uses them.
- The DDC exports are listed below. The `.c` column is the line in `DDCHelperLib.dll.c`.

| Export (VA) | Signature (reconstructed) | Semantics [C] | .c |
|---|---|---|---|
| `DDCCIHelperIni` (0x10007ab0) | `int __stdcall (void)` | Logs, calls `InitDDCHelper` (FUN_1000ad80), returns 0. | 6504 |
| `_EnumDisplayIDIni@4` (0x10007b00) | `void (Struct1*)` | `EnumGetFirst` (FUN_1000b2c0) rebuilds the monitor list, then fills `Struct1` (§3.3). | 6521 |
| `_DDCSupportJudge_C@8` (0x10007d50) | `int (uint idx, stMonitorEDIDInfo_T*)` | Returns 1 if the index is out of range. Fills the EDID fields from the cached EDID, then returns `DDCSupport_Judg(idx)` = **GetCIValue(VCP 0x14)** (FUN_1000cdb0, `.c:9665`). 0 means DDC/CI works. | 6626, 6719 |
| `_MonitorGetFactorySN_C@8` (0x100085f0) | `int (uint idx, stMonitorSNDeal_T*)` | `GetMonitorPropertySN(idx, extCode, readLen, buf, copyLen)` (FUN_1000ce40). 0 on success; **returns 1** (not an error code) after 3 failures. | 6835, 9695 |
| `_SwitchGetCommandChecksum@4` (0x10008630) | `int (BOOL)` | Sets global `g_strictChecksum` (DAT_1005dd70, BSS default 0). | 6849 |
| `_EnumMonitorCapabilitesStr@4` (0x10008650) | `int (stMonitorCapPackage_T*)` | `GetMonitorCapabilitesStr(idx, buf, 2600, &len)` (FUN_1000c990). | 6861, 9481 |
| `getStandardDDCCIValue_C` / `_…@4` (0x100086d0) | `int (Struct0*)` | `GetCIValue(idx=+0x414, vcp=+0x418, &val=+0x41C, &max=+0x424)` (FUN_1000c090). | 6879, 9201 |
| `setStandardDDCCIValue_C` (0x10008720) | `int (Struct0*)` | `SetCIValue(idx, vcp, val=+0x41C)` (FUN_1000c5f0). | 6896, 9379 |
| `getTPVExternDDCCIValue_C` (0x10008760) | `int (Struct0*)` | Raw write of `byte_0[0..byte_1)`, then raw read of `byte_3` bytes into `byte_2`; up to 3 attempts. Value = `rx[6]<<8|rx[7]`, max = `rx[4]<<8|rx[5]`. | 6913 |
| `setTPVExternDDCCIValue_C` (0x100088c0) | `int (Struct0*)` | Raw write of `byte_0[0..byte_1)`; up to 3 attempts until 0. | 6957 |
| `logDDCDrvClean` / `logGetDDCDrv` / `logBufGetDDCDrv` | | Clear / return / copy the 52,000-byte log buffer at DAT_10061420. | 17578-17674 |
| `_RegisterFunctionCallback@4` | `BOOL (void(__stdcall*)(int,const char*))` | Stores the log callback (DAT_10061418). | 17676 |
| `_InvokeCallbackFunction@0` | | Emits test log lines ("LogTest20x", "AAAA BBBB CCCC"). | 17717 |

### 4.2 Monitor object ("DDC device", 0x25C bytes) [C]

The list head is DAT_1005d968. The index table is `DAT_1005d970[idx]` and the count is `DAT_1005d96c`. `GetMonitorByIndex(idx)` (FUN_10016000, `.c:13742`) returns NULL when `idx >= count`.

| Off | Content |
|---|---|
| +0x000 | Backend "port" handle. For ADL it points to the object itself, so `*(port+8)` is the ADL id. |
| +0x008 | ADL: `adapterIndex<<16 \| displayInfoIndex`. Dxva2 objects: pointer to a `PHYSICAL_MONITOR[]` array (0x104 bytes each). |
| +0x00C | EDID, 256 bytes |
| +0x10C | PnP string from GetEDIDOption(1), e.g. `PHLC29F` |
| +0x12C (300) | GDI monitor device name, e.g. `\\.\DISPLAY1\Monitor0` (copied when matched to a Windows monitor) |
| +0x14C | length byte of the last DDC/CI reply |
| +0x150 | **raw I²C invoke function** (`BOOL fn(I2CReq*)`). NULL for Dxva2-only objects. |
| +0x154 | flags: bit 0 = **Dxva2 ("Vista API") object**; bits 0-1 checked when reading EDID |
| +0x158 | `DISPLAY_DEVICEA.DeviceKey` (128 bytes) |
| +0x258 (600) | next pointer |

### 4.3 `InitDDCHelper` (FUN_1000ad80, `.c:8664-8750`) [C]

- Runs once (flag DAT_1005d75c). Calls `GetVersionExA`, then `IsWow64Process` (log `WinVer: 6.2`, `Win64: YES`).
- Opens `CreateFileA("\\\\.\\MDDCDRV", GENERIC_READ|GENERIC_WRITE, 0, 0, OPEN_EXISTING)`. This fails with error 2 on the user's machine because no `.sys` ships with EPC. It logs `ERROR_CANNOTOPENDRIVER` (0x60000001) and continues.
- If the OS major version > 5, it runs `LoadLibraryA("dxva2.dll")` and resolves: `GetPhysicalMonitorsFromHMONITOR`, `DestroyPhysicalMonitor`, `SetVCPFeature`, `GetVCPFeatureAndVCPFeatureReply`, `CapabilitiesRequestAndCapabilitiesReply`, `GetCapabilitiesStringLength`, `GetNumberOfPhysicalMonitorsFromHMONITOR`.
- Logs `InitDDCHelper Finished: S_OK(2)`.

### 4.4 Enumeration: `EnumGetFirst` (FUN_1000b2c0, `.c:8795-8930`) [C]

1. Frees the old list, calling `DestroyPhysicalMonitor` for Dxva2 objects.
2. `switch (COMMLOGIC)`, where COMMLOGIC is DAT_1005c708 = **3** (initialised `.data` byte 03; log `COMMLOGIC: 3`). Case 3 runs:
   - `EnumPCI` (FUN_10012870). This needs MDDCDRV, so on the user's machine it logs "driver not available".
   - `EnumSDKs` (FUN_10013e60, `.c:12839`), which calls in order:
     - `EnumNV` (NVAPI; "skip checking, exit" without NVIDIA)
     - `DetectATI`, then `EnumATI` (legacy `atiddc.dll`)
     - `EnumA_ATI` (**ADL**)
     - `EnumCUI` (Intel CUI COM; `CoCreateInstance` failed 0x80040154)
     - `EnumIntelGCLSDK` (IGCL; `ctlInit` failed 0x40000026)
     - `EnumMatrox` (`MtxApi.dll` not found)
3. If DAT_1005de68 == 0: `EnumWindows` (FUN_1000fbb0, `.c:10954`), the Dxva2 enumeration (§4.5).
4. Optionally `EnumOther`.
5. Builds the index table in list order. **DisplayID = position in this list.** SDK-found monitors come first.

**`EnumA_ATI` (FUN_10011370, `.c:11684-11950`)** [C]
- Loads `atiadlxx.dll`, falling back to `atiadlxy.dll`.
- Calls `ADL_Main_Control_Create(cb,1)` → `ADL_Adapter_NumberOfAdapters_Get` → `ADL_Adapter_AdapterInfo_Get` (records of 0x624 bytes).
- Requires these exports: `ADL_Display_WriteAndReadI2C`, `ADL_Display_WriteAndReadI2CRev_Get`, **`ADL_Display_DDCBlockAccess_Get`** (kept as the invoke target), `ADL_Display_EdidData_Get`, and uses `ADL_Display_DisplayInfo_Get`.
- For each adapter and each display-info record (0x228 bytes) with `(iDisplayInfoValue@0x224 & 2 | 1) == 3` (connected and mapped), it creates an object with invoke = `atiA_Invoke`, `obj[2] = iAdapterIndex<<16 | recordIndex`, and reads the EDID (§4.8.6). If that fails it falls back to `ADL_Display_EdidData_Get` (FUN_10011150).
- **Duplicates are dropped when the first 128 EDID bytes are identical** (`FUN_1000efc0`, `.c:10625`, memcmp 0x80, log "EDID found").
- Logs show 5 adapters and 14 display records. The same monitor is found five times and kept once.

### 4.5 Matching a Windows display to a DDC handle [C]

**`EnumWindows` → `EnumDisplayMonitors(WindowsEnumProc)`** (FUN_1000f290, `.c:10720-10950`). For each HMONITOR:

1. `GetMonitorInfoA` (MONITORINFOEXA, cbSize 0x48).
2. `EnumDisplayDevicesA(szDevice, i, &dd, 0)`: take the first child with `StateFlags & 1` (active) and not `& 8`.
3. Driver key = `strstr(dd.DeviceID, "{")`, for example `{4d36e96e-…}\0004`.
4. Walk `HKLM\SYSTEM\CurrentControlSet\Enum\DISPLAY\<model>\<instance>` and find the key whose `Driver` value equals the driver key. Read `Device Parameters\EDID` (the first 256 bytes; re-read when larger).
5. `FindMonitorByEDID(edid)` compares the first 128 bytes:
   - If it matches an SDK object, copy `dd.DeviceName` (e.g. `\\.\DISPLAY1\Monitor0`) into obj+0x12C. **That object stays on the raw-I²C backend.** This is what happened on the user's machine: "EDID found", "EnumWindows OK: 0".
   - If there is no match and the enumeration flag is set, `AddVistaMonitor` (FUN_1000f060, `.c:10658`) creates a Dxva2 object:
     - `GetNumberOfPhysicalMonitorsFromHMONITOR` + `GetPhysicalMonitorsFromHMONITOR` → +0x008
     - flags = 1
     - EDID from the registry copied to +0x00C
     - `DeviceKey` → +0x158
     - `DeviceName` → +0x12C
   - If DAT_1005de5c ≠ 0, an existing SDK object would be **replaced** by a Vista object ("Replaced by Vista API"). The default is 0.
6. `WindowsEnumProcSec` (FUN_1000dfd0, `.c:10211`) re-acquires physical-monitor handles by comparing `dd.DeviceKey` with obj+0x158. It is used after `ERROR_GRAPHICS_INVALID_PHYSICAL_MONITOR_HANDLE` (0xC026258D).

Resulting identity chain: **DDC index ↔ EDID bytes ↔ GDI device name**. On top of that, the managed layer matches **factory SN ↔ hub USB device** (§2).

### 4.6 Raw I²C request block and backends [C]

Every raw backend receives the same request block, 0x118 bytes. This is also the `DeviceIoControl` buffer size for MDDCDRV.

| Off | Field |
|---|---|
| +0x00 | port handle (obj+0) |
| +0x04 | 0 |
| +0x08 | 7-bit I²C slave (0x37 DDC/CI, 0x50 EDID) |
| +0x0C | op: low byte 1 = read, 2 = write. Bits 8-15 = alt-line flag (legacy ATI). |
| +0x10 | length (write: bytes in data; read: bytes requested, updated with bytes read) |
| +0x14 | status / GetLastError |
| +0x18 | data[256] |

| Backend (function, .c line) | Mechanism |
|---|---|
| **atiA_Invoke** (FUN_1000d8f0, 10004) **← used on the user's PC** | `ADL_Display_DDCBlockAccess_Get(iAdapterIndex = id>>16, iDisplayIndex = id&0xFFFF, iOption=0, iCommandIndex=0, iSendMsgLen, lpucSendMsgBuf, lpulRecvMsgLen, lpucRecvMsgBuf)`. Write: send `[addr<<1] + data` (len+1), no receive. Read: send `[addr<<1 \| 1]` (1 byte), receive `len` bytes. |
| nv_Invoke (FUN_1000dbd0, 10063) | NVAPI `NV_I2C_INFO` v3 (`0x3002C`): `displayMask`, `bIsDDCPort=1`, `i2cDevAddress = addr<<1 (\|1 read)`, no register address, `pbData`, `cbSize`, `i2cSpeed = 10000/1000`. Write = `NvAPI_I2CWrite` (QueryInterface id 0xE812EB07, `.c:309`); read = `NvAPI_I2CRead` (0x2FDE12C5, `.c:270`). |
| IGCL (FUN_1000df20 → FUN_10018b60/FUN_10018ca0, 10187/15440/15473) | Intel IGCL/CUI COM vtable +0xB0 (write) / +0xAC (read). Reads capped at 0x80 bytes; **Sleep(30)** after reads. |
| Intel CUI probe (FUN_10018e20, 15522) | Hard-coded probe `51 82 01 14 A8` = GET VCP 0x14, Sleep(150), read 11 bytes, validate `0x6E`, len, checksum. |
| ATIInvoke (FUN_1000d5f0, 9952) | Legacy `atiddc.dll!ATIDDCBlockAccess`. |
| ALLInvoke (FUN_1000de20, 10146) | `DeviceIoControl(\\.\MDDCDRV, 0x222004, req, 0x118, req, 0x118)`. Other IOCTLs 0x222010-0x222038 are used for PCI/port access. |
| Matrox / S3 / VIA / SiS / i9xx SDVO | Direct register bit-banging through MDDCDRV. Legacy and unreachable without the driver. |

### 4.7 DDC/CI framing [C]

**Write, `DDCCIWrite(idx, payload, n)`** (FUN_1000be10, `.c:9127-9198`)

```
frame = [0x51, 0x80|n, payload[0..n-1], chk]        // sent to slave 0x37 (wire address byte 0x6E is prepended by backend)
chk   = (0x80|n) ^ 0x3F ^ payload[0] ^ … ^ payload[n-1]      // 0x3F == 0x6E ^ 0x51
req.op = 2 (write), req.len = n+3
invoke(); Sleep(100);                                  // ALWAYS 100 ms after the write, even on failure
fail → 0x70000012 (ERROR_I2CWRITE); invoke==NULL → 0x70000021 (ERROR_NOTSUPPORTEDBYVISTAAPI); bad idx → 0x70000018
```

**Read, `DDCCIRead(idx, out, &n)`** (FUN_1000b980, `.c:9004-9124`)

```
req.op = 1 (read), req.slave = 0x37, req.len = n + 3        // n = requested payload length
invoke() fail → 0x70000011 (ERROR_I2CREAD)
Sleep(50)                                                   // log "Sleep(50)"
rx[0] must be 0x6E (== 0x37*2)               else ERROR_I2CREAD(2)
rx[1] must have bit7 set; L = rx[1] & 0x7F   else ERROR_I2CREAD(3)
L must be <= n+3                              else ERROR_I2CREAD(4)
x = 0x50; for i in 0..L+2: x ^= rx[i]         // covers 0x6E, len, L payload bytes, checksum → must be 0
if x == 0            → out[0..L-1] = rx[2..L+1]; n = L; return 0
elif strict (SwitchGetCommandChecksum(TRUE), as EPC sets it) → return 0x70000011
else (lenient)       → if L == n+3: copy L-3 bytes, n = L-6, log "| DDCWARN | Exception at VCP String Check", return 0; else 0x70000011
```

- The returned payload **starts at the reply opcode** (for example `0x02` for a VCP reply, or `0xE3` for a capabilities reply). A null message (`6E 80 BE`) passes with `n = 0`.
- Nothing checks the reply opcode or the echoed VCP code (see GetCIValue below).

### 4.8 Operations

#### 4.8.1 `GetCIValue(idx, vcp, &val, &max)` — standard VCP get (FUN_1000c090, `.c:9201-9376`) [C]

**Raw path** (flag bit 0 clear), up to **3 attempts** (a=1..3):

```
DDCCIWrite([0x01, vcp], 2)                  → on fail: next attempt (error 0x70000012)
Sleep(5*a)
DDCCIRead(buf, n=8)                         → on fail: Sleep(5*a), next attempt
if buf[1] (result code) != 0 → return 0x7000001A (ERROR_COMMANDCODE)   // unsupported VCP
val = buf[6]<<8 | buf[7] ; max = buf[4]<<8 | buf[5] ; return 0
```

- The reply payload is `02 RC VCP TP MH ML SH SL`.
- **Wire timing per attempt is about 155 ms plus bus time.** Observed: 194 ms and 197 ms (§7.2).
- **Dxva2 path** (flag bit 0 set): `GetVCPFeatureAndVCPFeatureReply(hPhys, vcp, &type, &val, &max)`, up to 3 tries.
  - If it fails with GetLastError 0xC026258D, it re-enumerates via `EnumDisplayMonitors(WindowsEnumProcSec)` and retries 3 more times.
  - Final failure → 0x70000012. 0xC0262584 is logged as "VCP code is not supported by monitor".

#### 4.8.2 `SetCIValue(idx, vcp, val)` (FUN_1000c5f0, `.c:9379-9478`) [C]

- **Raw path:** `DDCCIWrite([0x03, vcp, val>>8, val&0xFF], 4)`, up to 3 attempts until success. There is no read-back and no extra delay beyond the 100 ms inside the write.
- **Dxva2 path:** `SetVCPFeature(hPhys, vcp, val)`, up to 3 tries, with the same 0xC026258D re-enumeration.

#### 4.8.3 TPV extended VCP (`getTPVExternDDCCIValue_C` / `setTPVExternDDCCIValue_C`, `.c:6913-6977`; managed `Class1.smethod_12/13`) [C]

**Get**
- Managed request: `byte_0 = [0x01, app, acode, ext]`, `byte_1 = 4`, `byte_3 = 8`.
- On the wire: `51 84 01 E2 A0 <ext> chk`.
- Up to 3 attempts, each: write → `Sleep(5*a)` → read 8 → (on fail `Sleep(5*a)`).
- Value = `payload[6..7]`, max = `payload[4..5]`. The **RC byte is not checked**.
- Returns 0x70000000 after 3 failures.

**Set**
- Managed request: `byte_0 = [0x03, app, acode, ext, val>>8, val&0xFF]`, `byte_1 = 6`.
- On the wire: `51 86 03 E2 A0 <ext> hi lo chk`.
- Up to 3 attempts.

Values seen in the logs (hub path, same frames): `app = 0xE2`, `acode = 0xA0`, `ext ∈ {00,01,04,06–0D,0E,0F,10–13,15–17,19–1D,34–36,39,40,41,43,44}`. The capabilities string lists `E2A000 … E2A044`.

**Raw get/set** (`GetExternDDCCIValue` / `SetExternDDCCIValue`) use the same exports with a caller-supplied payload after the 0x01 or 0x03 opcode. `rxlen = max(8, requested)`.

These operations **require a raw I²C backend**. On a Dxva2-only object they fail immediately with 0x70000021 [C] (invoke == NULL).

#### 4.8.4 `GetMonitorPropertySN(idx, code, readLen, out, copyLen)` — vendor factory info (FUN_1000ce40, `.c:9695-9790`) [C]

- TX payload (7 bytes): `[0x01, 0xFE, 0xEF, code, 0x00, 0x00, code==0x13 ? readLen : 0x00]`.
  - `code` must be one of 0-7 or 0x10-0x14; any other value is sent as 0.
  - EPC calls it with code **0x13**, readLen **0x20**, copyLen **20**.
  - On the wire: `51 87 01 FE EF 13 00 00 20 9B`.
- Up to 3 attempts: write → `Sleep(5*a)` → read `readLen` (I²C read of 35 bytes) → on fail `Sleep(5*a)`.
- The payload is **raw ASCII serial number** with no opcode byte; the managed layer copies the first 20 bytes.
- Returns 1 after 3 failures.
- Observed: SN `AU00000000001` (both logs).

The hub path sends a 6-byte variant, `51 86 01 FE EF 13 00 20 9A` (`Zeasn.Monitor.Lib/Interface2.cs:293`), and reads the SN from `reply[2..]`. The monitor accepted both [C].

#### 4.8.5 Capabilities: `GetMonitorCapabilitesStr` → `_GetCapsString` (FUN_1000c990/FUN_1000caef/FUN_10014150/FUN_10014080, `.c:9481-9660, 12895-13012`) [C]

- A 64 KiB temporary buffer is used. The raw algorithm is **always tried first**, even for Dxva2 objects, where it fails fast. The logic:

```
offset = 0; tries = 3
loop:
  tries -= 1; if tries < 2: Sleep(500)
  DDCCIWrite([0xF3, offset>>8, offset&0xFF], 3)            // "51 83 F3 00 00 4F" for offset 0
  DDCCIRead(buf, n=0x23)                                    // I²C read of 38 bytes
  retry while error and tries != 0
  if L < 13 and buf[0]==0xE3: STOP (fragment NOT appended)  // quirk: a final fragment with <10 data bytes is dropped
  if buf[0] != 0xE3: if tries>0 retry same offset else STOP
  append buf[3 .. L-1] (L-3 bytes; offset echo buf[1..2] ignored), capped at bufsize-1
  tries = 5; offset += L-3
  if L-3 == 0 or buffer full: STOP
result: 0 if >0 bytes else 0x70000015 (ERROR_READCAPABILITES)
```

- If the raw read failed **and** the object is Dxva2: `GetCapabilitiesStringLength` (error if larger than the caller buffer) → `CapabilitiesRequestAndCapabilitiesReply(hPhys, buf, len)`, up to 3 tries.
- The caller buffer is 2600 bytes. A longer string gives 0x70000019 (ERROR_SMALLBUFFER).
- On the user's PC the capabilities were read through the hub path, not this one.

#### 4.8.6 `ReadEDID256_Direc(obj, out256)` (FUN_1000e530, `.c:10369-10474`) [C]

- Raw path (flags & 3 == 0), I²C slave **0x50**:
  1. write `[0x00]`
  2. read 128 bytes
  3. write `[0x80]`
  4. read 128 bytes
- There are **no delays** and no E-DDC segment pointer (0x30), so only the first 256 bytes are read. The log shows four `atiA_Invoke` calls per EDID.
- Then `EDIDJudgeAndFix` (FUN_1000e3b0, `.c:10330`):
  - If the header is not `00 FF FF FF FF FF FF 00` but begins `FF FF FF FF FF FF 00`, the 256 bytes are shifted right by one and `edid[0] = 0` ("HEADER ERROR ready to fix").
  - Otherwise the result is 0x70000013 (ERROR_INVALIDEDID).
- Logs a hex "RAW DUMP" of 256 bytes.
- Dxva2 objects: returns the registry EDID cached at +0x00C.

#### 4.8.7 `GetEDIDOption(edid, code, out)` (FUN_100145e0, `.c:13015-13300`; wrapper FUN_1000b830) [C]

Format strings were read from `.rdata`. `DTD` means detailed timing descriptor.

| Code | Output | Format / source | 34M2C8600 |
|---|---|---|---|
| 1 | PnP id | 3 letters from bytes 8-9 + `%04X` of the product code | `PHLC29F` |
| 2 | vendor name | internal table; else `Unknown (%s)` | — |
| 3 / 4 | H / V active pixels | DTD #1 (only when feature bit 1 "preferred timing" is set), `%d` | `3440` / `1440` |
| 5 | serial | descriptor 0xFF text (`%s`), else the 32-bit serial (`%d`) | `AU00000000001` |
| 6 | monitor name | descriptor 0xFC text; error 0x7000001E if absent | `PHL 34M2C8600` |
| 7-10 | `%d` values from descriptors [I: range-limit fields] | | not observed |
| 0xB | gamma | `%2.2g` | `2.2` |
| 0xC | week-year | `%.2d-%.2d` | `01-2025` |
| 0xD | `DIGITAL` / `ANALOG` | byte 0x14 bit 7 | `DIGITAL` |
| 0xE / 0xF | image size in mm | `%d` (cm × 10) | `800` / `340` |
| 0x10 | aspect | `4x3`, `16x10`, `5x4`, `16x9` from byte 0x15/0x16 ratio | — |
| 0x11 | DPMS | `STANDBY:%.1d SUSPEND:%.1d LOWPOWER:%.1d` | — |
| 0x12 | EDID version | `%d.%d` | `1.4` |
| 0x13 | colour type | `Monochrome/Grayscale` / `RGB Color` | — |
| 0x14/0x15 | white x/y | `%2.3g` | `0.313` / `0.328` |
| 0x16-0x1B | Rx, Ry, Gx, Gy, Bx, By | `%2.3g` | 0.688, 0.302, 0.241, 0.713, 0.144, 0.0584 |

### 4.9 Error codes [C]

| Code | Name (from the log strings) |
|---|---|
| 0 | S_OK |
| 1 | index error (`DDCSupportJudge_C`), or 3 failures in `GetMonitorPropertySN` |
| 0x60000001 | ERROR_CANNOTOPENDRIVER (MDDCDRV). Not fatal. |
| 0x70000000 | "not done": the initial value, returned by `getTPVExtern` after 3 failures |
| 0x70000010 | invalid parameter / unknown EDID option |
| 0x70000011 | ERROR_I2CREAD (including bad source byte, length or checksum) |
| 0x70000012 | ERROR_I2CWRITE (also the final Dxva2 failure) |
| 0x70000013 | ERROR_INVALIDEDID |
| 0x70000015 | ERROR_READCAPABILITES |
| 0x70000016 | ERROR_NOMOREDEVICES |
| 0x70000018 | ERROR_INVALIDDEVICE (bad index / object not in list) |
| 0x70000019 | ERROR_SMALLBUFFER |
| 0x7000001A | ERROR_COMMANDCODE (VCP reply RC ≠ 0) |
| 0x7000001E | EDID option not present |
| 0x70000021 | ERROR_NOTSUPPORTEDBYVISTAAPI (no raw invoke on a Dxva2 object) |

---

## 5. Dxva2

### 5.1 Dxva2 inside DDCHelperLib [C]

- Resolved dynamically in `InitDDCHelper` (§4.3).
- Used only for monitors that **no SDK backend found** but Windows enumerated (§4.5).
- Scope:
  - standard get/set (§4.8.1–2)
  - capabilities (§4.8.5)
  - EDID from the registry
- Tries and recovery: up to 3 tries per call. After error 0xC026258D the physical-monitor handles are re-enumerated and the call is tried 3 more times.
- **TPV extended VCP, factory SN and FW version do not work on Dxva2 objects** (0x70000021). This is why EPC's vendor features depend on an SDK backend or the USB hub.

### 5.2 Managed Dxva2 wrapper (`Zeasn.Win.Lib/WhaleTV.Win.Display.Lib`) [C]

**P/Invokes** (`DisplayDeviceWinApi.cs:209-233`):
- `GetPhysicalMonitorsFromHMONITOR`
- `DestroyPhysicalMonitors`
- `GetNumberOfPhysicalMonitorsFromHMONITOR`
- `CapabilitiesRequestAndCapabilitiesReply(IntPtr, StringBuilder, uint)`
- `GetCapabilitiesStringLength`
- `GetVCPFeatureAndVCPFeatureReply(IntPtr, byte, out MC_VCP_CODE_TYPE, out uint, out uint)`
- `SetVCPFeature(IntPtr, byte, uint)`

**Wrappers** (only `hPhysicalMonitors[0]` is used for VCP operations):

| Wrapper | Lines | Behaviour |
|---|---|---|
| `smethod_2` GetCapabilitiesString | 271-300 | Tries each physical monitor until the string is non-empty. |
| `smethod_3` / `smethod_4` | 302-333 | Standard get / set. |
| `smethod_5` GetExternVCP | 335-355 | `SetVCPFeature(code, (sub<<8)\|0xFF)`, then `GetVCPFeatureAndVCPFeatureReply(code)`. **Always returns false** (bug). Wire: `03 <code> <sub> FF` then `01 <code>`. This is a different "select-then-read" encoding from DDCHelper's `01 E2 A0 xx`. |
| `smethod_6` SetExternVCP | 357-371 | `SetVCPFeature(code, (sub<<8)\|value)`. Wire: `03 <code> <sub> <value>`. |

Other pieces:
- Display enumeration: `DisplayDevice.GetDisplays` (`DisplayDevice.cs:74-136`), same `StateFlags&1 && !(StateFlags&8)` rule.
- EDID from the registry: `EDIDUtil.smethod_1` (`EDIDUtil.cs:35-50`, `HKLM\SYSTEM\CurrentControlSet\Enum\DISPLAY\<id>\<inst>\Device Parameters\EDID`).

**No other assembly references `WhaleTV.Win.Display.Lib`** (grep over `work/dotnet-clean`). The entire wrapper is dead code, so porting needs nothing from it. The VCP semantics that are actually used live in DDCHelper and the hub.

---

## 6. Vendor-specific (non-MCCS) DDC/CI commands on this transport

All commands go to slave 0x37 (wire `6E`). The frame shown starts after the address byte. Checksums were computed and cross-checked: the binary itself contains `51 82 01 14 A8` (§4.6).

| Purpose | TX payload | Full frame | RX payload (requested len) | Parse | Status |
|---|---|---|---|---|---|
| DDC support probe = GET VCP 0x14 (colour preset) | `01 14` | `51 82 01 14 A8` | `02 RC 14 TP MH ML SH SL` (8) | RC==0 → supported; value 5, max 0x0D observed | [C] code + log |
| Standard get (any VCP) | `01 vv` | e.g. `51 82 01 10 AC` | 8 bytes as above | val = SH:SL, max = MH:ML | [C] |
| Standard set | `03 vv hi lo` | e.g. brightness 50: `51 84 03 10 00 32 9A` | — | — | [C] |
| TPV extended get | `01 E2 A0 xx` | e.g. xx=41: `51 84 01 E2 A0 41 B9` | 8 bytes: val = p[6..7], max = p[4..5] [I: layout `02 RC E2 TP MH ML SH SL`] | | [C] code; hub log values |
| TPV extended set | `03 E2 A0 xx hi lo` | e.g. xx=01 val 4: `51 86 03 E2 A0 01 00 04 FD` | — | | [C] |
| Factory SN (FE EF 0x13) | `01 FE EF 13 00 00 20` | `51 87 01 FE EF 13 00 00 20 9B` | ASCII, NUL padded (32) | first 20 bytes; ≥13 chars; truncate to 14 | [C] code + log |
| Other FE EF sub-codes 0-7, 0x10-0x12, 0x14 | `01 FE EF cc 00 00 00` | | ? | | [C] code; semantics unknown |
| FW version string | `01 FE E1 E6 06 00` | `51 86 01 FE E1 E6 06 00 47` | ASCII from p[3] (or p[4] if p[3]==0) (32) | `"V1.01"` observed via hub | [C] code; value via hub log |
| Capabilities | `F3 hi lo` | `51 83 F3 00 00 4F`, `51 83 F3 00 20 6F`, … | `E3 hi lo data…` (35) | §4.8.5 | [C] |
| EDID | slave 0x50: write `00`/`80`, read 128 each | | | | [C] |

- More `01 FE E1 …` / `01 FE E9 …` / `01 C8` commands are sent **only through the hub** (BOM string, scaler name, panel name, model name, dual-image bank). See the Cross-references section.
- **Table Read (opcode 0xE2) and Table Write (0xE7) are never sent.** The monitor does not advertise them: `cmds(01 02 03 07 0C E3 F3)`.
- Opcodes 0x07 (timing request) and 0x0C (save current settings) are advertised but not used by this layer [C: no code path builds them].

---

## 7. Real traffic from the user's machine

### 7.1 Environment [C]

- Windows 11, an **AMD Radeon** GPU (`2026-09-25.txt:4`).
- One monitor: GDI `\\.\DISPLAY1`, device path `\\?\DISPLAY#PHLC29F#7&0000005&0&UID264#…` (`2026-09-25.txt:167`).
- Cache key `v1.01_0f` (FW `V1.01`, VCP 0x60 = 0x0F = DisplayPort-1), so the monitor is connected over **DisplayPort** [C: data.json + `Display.cs:242-253`].

### 7.2 GPU-path start-up sequence (v1.13.0, `2026-09-26.txt:165-362`; identical in v1.11.0 at `2026-09-25.txt:173-368`)

| t (s) | Event |
|---|---|
| 33.2919 | `DDCHelAPIIni` → `InitDDCHelper`; MDDCDRV `CreateFile` fails with error 2; Dxva2 loaded |
| 33.2972 | EnumPCI unavailable; EnumNV skipped; atiddc absent; **EnumA_ATI: 5 adapters, 14 display records** |
| 33.3169–33.4536 | 5 × `ReadEDID256_Direc` through `atiA_Invoke` (4 ADL calls each, about 10–30 ms per EDID); first kept, 4 dropped as "EDID found" |
| 33.4536 | EnumCUI: `CoCreateInstance` 0x80040154; IGCL `ctlInit` 0x40000026; Matrox absent |
| 33.4536–33.4687 | EnumWindows: 1 HMONITOR, registry EDID matches the ADL object → DeviceName `\\.\DISPLAY1\Monitor0` copied; 0 Vista objects |
| 33.4687 | `EnumDisplayIDIn DispIndex = 0 , acName = PHLC29F_PHL 34M2C8600;` |
| 33.4687 | 19 × GetEDIDOption (table §4.8.7) |
| 33.4687 → 33.6015 → 33.6652 | GET VCP 0x14: write → (132.8 ms) → read → Sleep(50) → `Value = 5, MaxValue = D` (**196.5 ms total**) |
| 33.6652 → 33.7909 → 33.8537 | FE EF 13 SN read: write → (125.7 ms) → read → Sleep(50) → SN `AU00000000001` (**188.5 ms total**) |
| 33.8537 | `DDCHelAPIIni` 1 display, 1 supported |

- A log quirk [C]: `atiA_Invoke` logs both the write completion (line 399) and the read completion (line 417) as "WR".
- 1.11.0 timings (`2026-09-25.txt:351-368`): GET 0x14 took 193.8 ms, SN took 189.1 ms.

### 7.3 EDID dump [C]

256 bytes from `RAW DUMP`, both checksums valid:

```
000: 00 FF FF FF FF FF FF 00 41 0C 9F C2 01 00 00 00   mfg "PHL", product 0xC29F, serial32 0x00000001
010: 01 23 01 04 B5 50 22 78 3B AC 05 B0 4D 3D B7 25   week 1 / 2025, EDID 1.4, digital, 80x34 cm, gamma 2.2
020: 0F 50 54 BF EF 00 D1 C0 B3 00 95 00 81 80 81 C0
030: 31 68 45 68 61 68 E7 7C 70 A0 D0 A0 29 50 30 20   DTD1: 3440x1440
040: 3A 00 20 51 31 00 00 1A 00 00 00 FF 00 41 55 30   0xFF serial "AU00000000001"
050: 30 30 30 30 30 30 30 30 30 31 00 00 00 FC 00 50   0xFC name  "PHL 34M2C8600"
060: 48 4C 20 33 34 4D 32 43 38 36 30 30 00 00 00 FD
070: 00 30 AF FF FF 5F 01 0A 20 20 20 20 20 20 02 BD   1 extension
080: 02 03 3D F1 4D 03 05 14 04 13 1F 02 90 4B 4C 3F   CTA-861 block
090: 59 5A 23 09 07 07 83 01 00 00 E2 00 D5 E3 05 C3
0A0: 01 E6 06 05 01 66 4B 02 74 1A 00 00 03 03 30 AF
0B0: 00 A0 66 02 4B 02 AF 00 00 00 00 00 00 88 D1 70
0C0: A0 D0 A0 32 50 30 40 3A 00 20 51 31 00 00 1C 53
0D0: 9D 70 A0 D0 A0 34 50 30 40 3A 00 20 51 31 00 00
0E0: 1A 73 3E 70 A0 D0 A0 29 50 30 20 3A 00 20 51 31
0F0: 00 00 1A 00 00 00 00 00 00 00 00 00 00 00 00 C9
```

### 7.4 Capabilities string [C]

From `EvniaServe/Config/data.json`, key `PHL 34M2C8600` / `v1.01_0f`, originally read through the hub:

```
(prot(monitor)type(LCD)model(34M2C8600MV)cmds(01 02 03 07 0C E3 F3)vcp(02 04 05 08 0B 0C 10 12 14(02 04 05 06 07 08 0A 0B 0D ) 16 18 1A 52 54(00 01) 60(11 12 0F 15 21 22 2F 35 ) 62 6C 6E 70 72(50 64 78 8C A0) 86(01 0A 12 13 14 15 16 17 18 19 1A 1B 23)87 8D(01 02) A4 A5 AC AE B2 B6 C0 C6 C8 CA(01 02) CC(01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 12 14 16 17 1A 1E 24) D6(01 04 05) DA(00 02) DC(00 01 03 04 05 06 07 08 0B 0E 11 20 21 22 23 24 30 33 51 E2) DF E9(00 02) E0(01 02 03 05) E2A000(46 47 48 49 4A 4B) E2A001(00 01 02 03 04) E2A004(00 01 02) E2A006(00 01 02 03) E2A007(00 01) E2A008(00 01) E2A009(01 02 03 04 05 06 07) E2A00A E2A00B E2A00C E2A00D E2A00E E2A00F E2A010(00 01 02 03 04) E2A011(00 01 02 03 04) E2A012(00 01) E2A013(00 01) E2A015(00 01 02) E2A016(00 01) E2A017(00 01) E2A019(00 01 02 03 04 05 06 07) E2A01A(00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D) E2A01B(00 01 02 03) E2A01C(00 01 02) E2A01D(00 01 02) E2A020(02 03 04  0F) E2A024(00 01 02 03 04) E2A034(00 02 03 04) E2A035(00 02 03) E2A036(00 01) E2A038(01) E2A039 E2A040(00 01) E2A041(00 01 02) E2A042(30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F) E2A043(00 01) E2A044(00 01 02 03) EC(01 02 03) ED(00 01) F0(00 01) F2(00 01 02 03 04) F6(01) F7(42)FD FF)mswhql(1)asset_eep(40)mccs_ver(2.2))
```

- The non-standard tokens `E2A0xx` are the TPV extended codes (§4.8.3).
- The hub path read took about **6.8 s** (`2026-09-25.txt:169`, `2026-09-26.txt:370`).

### 7.5 Runtime VCP traffic [C]

- **All** 233 runtime get/set calls in both logs went through the hub (`Hub GetStandardValue …`, `Hub GetTPVExternValue command=e2a0xx …`, `Hub SetTPVExternValue command=e2a001 …`), and every one returned result=0.
- No `DDC GetStandardValue`, `DDC Set…` or `DDC GetTPVExternValue` fallback lines appear.
- The hub path spaces calls at about 187 ms.

---

## 8. Linux port plan (this layer)

### 8.1 What to build

Build one `DdcCiChannel` abstraction with the same operations the managed API exposes (§3.1). Give it two implementations:

1. **`I2cDevChannel`** (this report): `/dev/i2c-N`, DDC/CI framing as in §4.7. This replaces DDCHelperLib and Dxva2 entirely.
2. **`UsbHubChannel`** (hub report): the same DDC/CI frames carried over the monitor's HID-I2C bridge.

Share the frame codec, reply parser and operation table (§6) between both.

**Transport order.** EPC tries the hub first, then the GPU path (§2). On Linux, prefer `I2cDevChannel` whenever the connector's DDC bus is accessible, because it needs no vendor USB protocol. Fall back to the hub channel otherwise, or when the user asks for it. Make the order configurable [I/recommendation].

**Drop** (Windows-only, no Linux equivalent needed):
- the ADL, NVAPI, IGCL, Intel CUI, atiddc, Matrox, MDDCDRV and PCI bit-bang backends
- Dxva2
- the GDI `\\.\DISPLAYn` naming, the registry EDID walk
- the logging callback and log-buffer exports
- the 125 `ctl*` IGCL thunks

### 8.2 Discovering monitors and mapping to DRM connectors [L]

1. Load the character device: `modprobe i2c-dev` (for example via `/etc/modules-load.d/i2c-dev.conf`).
2. Grant access through a udev rule, for example `KERNEL=="i2c-[0-9]*", SUBSYSTEM=="i2c-dev", GROUP="i2c", MODE="0660"`. Better: tag only display-adapter buses with `TAG+="uaccess"`. Never run the app as root.
3. For each `/sys/class/drm/card*-*/` whose `status` is `connected`:
   - Read `edid` (binary, all blocks).
   - Resolve the bus in this order:
     - a. **`ddc` symlink** → `…/i2c-N`. Present when the driver uses `drm_connector_init_with_ddc`: i915, amdgpu, nouveau, radeon and others.
     - b. An `i2c-N` child directory of the connector device. This is the DP AUX I²C-over-AUX adapter: amdgpu names it "AMDGPU DM aux hw bus N", i915 names it "DPDDC-x". Relevant here because the monitor is on **DisplayPort** (§7.1).
     - c. Fallback, the same rule the vendor uses: for every `/sys/bus/i2c/devices/i2c-N` whose `name` looks like a GPU adapter (skip SMBus, `i801`, `piix4`, and so on), read EDID at 0x50 (§8.4-G) and pick the bus whose **first 128 bytes equal** the connector's `edid`.
4. **Identify the Philips monitor:**
   - EDID mfg `PHL` (bytes 8-9 = `41 0C`), product `0xC29F`, descriptor 0xFF serial `AU00000000001`.
   - Filter supported displays like `DDCHelAPIIni("PHL")`: the PnP-id prefix contains "PHL".
   - The display handle becomes `{connector: "card1-DP-1", bus: N}` instead of the DDCHelper list index.
5. **Hub merge key:** the factory SN (§8.4-B), compared case-insensitively with the hub device's EDID serial. This is the same rule as `GClass3.method_3`.
6. **MST, docks, NVIDIA proprietary driver:**
   - MST branch devices expose separate `DPMST` i2c adapters, or `/dev/drm_dp_auxN`.
   - The NVIDIA proprietary driver may need i2c enabled via `NVreg_RegistryDwords`.
   - Detect these cases and fall back to the hub channel.

### 8.3 Frame codec and bus access [C framing, L syscalls]

```c
// open once per bus; serialize all access with one mutex per monitor (EPC shares one lock for hub+GPU)
int fd = open("/dev/i2c-N", O_RDWR);
ioctl(fd, I2C_SLAVE, 0x37);                 // kernel sends 0x6E (write) / 0x6F (read) address bytes

int ddc_write(int fd, const uint8_t *p, uint8_t n) {        // n <= 32
    uint8_t f[40]; f[0] = 0x51; f[1] = 0x80 | n;
    uint8_t c = 0x6E ^ 0x51 ^ f[1];
    for (int i = 0; i < n; i++) { f[2+i] = p[i]; c ^= p[i]; }
    f[2+n] = c;
    int r = write(fd, f, n + 3);
    msleep(100);                                            // vendor: always 100 ms after a write
    return r == n + 3 ? 0 : -EIO;
}

int ddc_read(int fd, uint8_t *out, uint8_t *n /*in: expected payload, out: actual*/) {
    uint8_t f[40]; int want = *n + 3;
    if (read(fd, f, want) != want) return -EIO;
    msleep(50);                                             // vendor: 50 ms after a read
    if (f[0] != 0x6E || !(f[1] & 0x80)) return -EPROTO;
    uint8_t L = f[1] & 0x7F; if (L > *n) return -EPROTO;    // vendor allows L <= n+3; be strict
    uint8_t x = 0x50; for (int i = 0; i < L + 3; i++) x ^= f[i];
    if (x) return -EBADMSG;                                 // strict mode (EPC sets SwitchGetCommandChecksum(true))
    memcpy(out, f + 2, L); *n = L; return 0;                // L == 0 → DDC/CI null message
}
```

- Use plain `write()`/`read()`, or two separate `I2C_RDWR` transactions. **Do not** combine the write and the read into one repeated-start transaction, because DDC/CI needs a STOP and a delay between them.
- Keep reads ≤ 38 bytes. The largest vendor read is capabilities: 35 payload + 3.

### 8.4 Operation recipes (drop-in replacements for `NewDDCOper`)

`a` = attempt number, 1..3. `sleep(5a)` reproduces the vendor's extra per-attempt delay.

| Op | Linux sequence | Result mapping |
|---|---|---|
| **A. JudgeSupportDDCCI / probe** | `ddc_write({01,14})`, `sleep(5a)`, `ddc_read(n=8)`. Retry up to 3 times. If all fail, wait 200 ms and run the whole thing once more (managed retry). | Supported if `p[0]==0x02 && p[1]==0x00`. Expected on this monitor: value 5, max 13. |
| **B. Factory SN** | `ddc_write({01,FE,EF,13,00,00,20})` (the 6-byte hub variant `{01,FE,EF,13,00,20}` also works), `sleep(5a)`, `ddc_read(n=32)`, 3 attempts. | Take the first 20 payload bytes as ASCII, stop at NUL, drop non-ASCII. `len<13` → "" ; else take the first 14 characters. |
| **C. GetStandardDDCCIValue(vcp)** | `ddc_write({01,vcp})`, `sleep(5a)`, `ddc_read(n=8)`, 3 attempts. | `p[1]!=0` → ERROR_COMMANDCODE (0x7000001A). Else val = `p[6]<<8\|p[7]`, max = `p[4]<<8\|p[5]`. Recommended: also check `p[0]==0x02` and `p[2]==vcp`, and treat `L==0` (null message) as retryable. |
| **D. SetStandardDDCCIValue(vcp,v)** | `ddc_write({03,vcp,v>>8,v&0xFF})`, retry up to 3 times until the write succeeds. | 0 / ERROR_I2CWRITE |
| **E. GetTPVExternDDCCIValue(E2,A0,x)** | `ddc_write({01,E2,A0,x})`, `sleep(5a)`, `ddc_read(n=8)`, 3 attempts. | Robust parse: val = last 2 payload bytes, max = the 2 before. This is the hub's length-agnostic rule (`Interface2.cs:253-259`); it equals DDCHelper's `p[4..7]` when L==8. Don't reject on RC (vendor doesn't), but log RC. |
| **F. SetTPVExternDDCCIValue(E2,A0,x,v)** | `ddc_write({03,E2,A0,x,v>>8,v&0xFF})`, up to 3 attempts. | |
| **G. EDID** | Prefer `/sys/class/drm/<conn>/edid`. Otherwise `I2C_SLAVE 0x50`: `write({00})`, `read(128)`, `write({80})`, `read(128)`; for more than 2 blocks use segment pointer 0x30 [L]. Apply the vendor's header fix (§4.8.6) only when reading raw. | |
| **H. GetCapabilites** | offset=0; loop `ddc_write({F3,off>>8,off&0xFF})`, `ddc_read(n=35)`. Require `p[0]==0xE3` (optionally check `p[1..2]==offset`), append `p[3..L-1]`, `off += L-3`, stop when `L-3 == 0`. Per fragment: 3 tries at first and 5 after a success, with 500 ms sleeps before the later tries. | **Do not** copy the vendor quirk that drops a final fragment with < 10 data bytes. Then post-process exactly like `Class1.smethod_8` (§3.4.4). Cache per (model, FW version, input) like `CacheVcpMgr` (key `v1.01_0f`). |
| **I. GetDisplayFWVersion** | `ddc_write({01,FE,E1,E6,06,00})`, `sleep(5a)`, `ddc_read(n=32)`. | ASCII from `p[3]` (or `p[4]` if `p[3]==0`) up to NUL, e.g. `V1.01`. `Display.method_1` first tries VCP 0xC9 and uses it only if `max == 201`. |
| **J. EDID info struct** | Re-implement the GetEDIDOption table (§4.8.7) and the field composition (§3.3) in the port, including the `~35"` quirk if UI parity matters. | |

- **Timing:** keep the vendor values by default. They were validated on this monitor on Windows: write + 100 ms, +5·a ms, read + 50 ms, which gives about 190 ms per get.
- MCCS minimums are lower (about 40 ms after a get request, 50 ms after a set or caps request) [L]. They can be offered as a "fast" option after testing.
- Keep the **global per-monitor mutex**, and keep the **firmware-update gate**: refuse all DDC while an OTA is active, returning -1 like `NewDDCOper`.

### 8.5 Safe bring-up and test order [L]

1. **Read-only first:**
   - sysfs EDID
   - probe GET 0x14
   - GET 0x10 / 0x12 / 0x60
   - factory SN, FW version, capabilities
   - Compare against §7 (value 5/13 for 0x14, SN, `V1.01`, the caps string).
2. `ddcutil --bus N getvcp 14` and `ddcutil --bus N capabilities` are useful references. ddcutil may reject the non-standard `E2A0xx` capability tokens; that is expected.
3. **Then writes**, restricted to reversible standard VCPs (brightness 0x10). Restore the original value afterwards.
4. Extended E2 A0 writes come last, after the VCP-catalog report confirms their meaning.

---

## 9. Online touchpoints

**None in this layer [C].**
- `DDCHelperLib.dll` imports only KERNEL32, USER32, ADVAPI32, OLE32 and OLEAUT32. There are no Winsock, WinHTTP or WinINet imports and no URLs in its strings.
- `Zeasn.DDC.Lib` makes no network calls. `Class2.cs` is obfuscator crypto and resource code.
- The Dxva2 wrapper is local only.
- Nothing needs to be stripped here.

Observed outside this scope: the Electron auto-updater downloaded `https://gcdn.zeasn.com/prod/zeasn-saas-pp/apk/global/857/20260915061410_gnhffvtk.exe` ("evnia Setup 1.13.0.exe") (`evnia/logs/26-09-25.log:9-19`). See the Cross-references section.

---

## 10. Open questions

1. **TPV extended reply layout on raw I²C** (`01 E2 A0 xx`). DDCHelper assumes an 8-byte payload with fixed offsets 4..7. The hub uses "last 4 bytes". No raw reply bytes were ever logged (`Class45.bool_3` gates hub frame logging). Capture one on Linux with a read-only get, for example E2 A0 39 (value 8, max 0x10 per the hub log), before finalizing the parser.
2. **Meaning of the `FE EF` sub-codes** 0-7 and 0x10-0x14 other than 0x13 (serial). Also: does the 7-byte versus 6-byte request form matter on other models?
3. Does the 34M2C8600 answer DDC/CI over **amdgpu DP AUX I²C** on Linux with the same timings? MCCS allows shorter delays; the vendor's 100 ms / 50 ms values are empirical.
4. Why does `Display.method_1` accept VCP 0xC9 (firmware level) only when `max == 201` (0xC9)? It looks like a firmware echo quirk, and it drives the FW-version source and the caps cache key.
5. The vendor capabilities reader drops a final fragment with < 10 data bytes (§4.8.5). Was the stored string complete on the DDC path? Only the hub path was exercised on this machine.
6. GetEDIDOption codes 2 (vendor-name table, FUN_1000ad30) and 7–10 were not decoded. They are not used by EPC's struct fill.
7. Windows used the ADL path here. Whether other Windows machines ended up on Dxva2-only objects, which lose all TPV features, is unknown and irrelevant to Linux.

---

## 11. Cross-references (outside this report's scope)

- **USB hub DDC transport**: `Zeasn.Monitor.Lib/Interface2.cs`.
  - `GetDDC`/`SetDDC` (155-195) build `6E 51 80|n+1 01/03 …`.
  - `imethod_4`, `imethod_5` (32/64-byte transfers, 100 ms), capabilities (324-376), GetSN (284-318).
  - Also `RhHidAPI.dll` (`RH_HidI2CWrite`, …) and `GL_SDK.dll`.
  - "Hub-Scaler: VIA-RTK", `ScalerName: RTD2738VL` (`2026-09-25.txt:155-161`).
  - This is the transport actually used for all runtime VCP traffic on the user's PC.
- **Hub-only vendor reads**:
  - `01 FE E1 E6 1D 00` BOM string
  - `01 FE E1 A1 01 00` dual-image bank
  - `01 FE E1 E8 00 00` scaler name
  - `01 FE E1 A7 07 00` panel name
  - `01 FE E9 0D 00 00` model name
  - `01 FE E1 E6 35 01`
  - `01 FE E1 A1 01 02`
  - `01 C8`
  - `03 FE E1 A7 16 01` (set)
  - Sources: `Interface8.cs:260-420`, `Interface6.cs:40-65,1203`, `Interface2.cs:386`.
- **VCP catalog and TPV `E2 A0 xx` semantics**: `Zeasn.PCenter.Entity.Lib/StandardVCPOpCode_E.cs`, `Zeasn.Equipment.Option.Lib/DisplayModule*.cs`, `SubModuleSmartImage*.cs`, `DisplayFuncConstraints.cs`; capability parser `ComUtil.AnalyseVcpString`.
- **VCP capability cache**: `Zeasn.PCenter.Base.Lib/CacheVcpMgr.cs` → `%APPDATA%/EvniaServe/config/data.json`, signed via `SerializedFileUtil.LoadTXTConfigWithSign`. The `sign` field format is for the persistence report.
- **Display merge and model whitelist**: `Zeasn.Equipment.Base.Lib/GClass3.cs:36-128` (SN merge, `IsSupportModelName` regex, `DictMgr.GetSupDisplayModelNames`).
- **USB monitor ↔ Windows display mapping via registry EDID**: `Zeasn.Monitor.Lib/Zeasn.Monitor.Lib.Utils/MonitorUtil.cs:1184-1330`.
- **Display settings** (resolution, orientation, HDR): WhaleTV `DisplayDevice`/`DisplayConfigWinApi`. On Linux use DRM/KMS or the compositor.
- **Firmware OTA gating** (`MonitorService.OTAStateChanged` → `Utils.InFirmwareUpdate`): OTA report.
- **ENE Ambiglow controller** seen in the same logs (`CUSBENE6K7732`, FW `03 32 07 0F 0B`, `2026-09-25.txt:651`): lighting report.
- **Electron auto-update download from `gcdn.zeasn.com`** (`evnia/logs/26-09-25.log:9-19`): online-features report.
