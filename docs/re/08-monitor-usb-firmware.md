# Evnia Precision Center 1.13.0: USB-DDC, monitor hub bridges (VIA / Realtek / Genesys) and scaler firmware update (RE spec)

**Area:** USB-DDC transport, hub bridge APIs (VIA Labs WinUSB, Realtek `RhHidAPI.dll`, Genesys `GL_SDK.dll`), and monitor firmware update (`DisplayFW_*`).
**Scope:** `Zeasn.Monitor.Lib` (the `ScalerFW` namespaces and their obfuscated `ClassN`/`InterfaceN` helpers), `Bridge.DisplayFW_*` -> `PHLDisplayFW`, `SupUsbDDC`/`SupOTA`, `work/native/GL_SDK.dll.*`, `work/native/RhHidAPI.dll.*`, `resources/bin/lib/RTK/info.txt`, and the user's runtime logs.
**Goal:** Give a Linux implementer enough detail to build USB-DDC, and optionally an offline firmware flasher, without re-reading the decompiled code.

Path abbreviations used below:

| Abbrev | Path |
|---|---|
| `ML/` | `work/dotnet-clean/Zeasn.Monitor.Lib/` |
| `DC/` | `work/dotnet-clean/` |
| `NV/` | `work/native/` |
| `AP/` | `work/app-pretty/` |
| `INST/` | `Evnia Precision Center/resources/bin/` |
| `LOG/` | `%APPDATA%/EvniaServe/logs/` |

Evidence labels: **CONFIRMED** means read in code or seen in logs. **INFERRED** means reasoned from names, structure or external knowledge; the reason is given each time.

---

## Summary

1. **What "USB DDC" is.** It is plain **VESA DDC/CI (MCCS)**, byte for byte the same frames as over the GPU's I2C bus (`0x6E`/`0x6F` addressing, XOR checksum). The frames go through a **USB-to-I2C bridge inside the monitor's USB hub controller**, which is wired to the scaler's DDC slave. It is *not* the USB HID Monitor Control class. The code has three bridge back-ends:
   * **VIA Labs (VID `2109`)**: vendor control transfers (`bmRequestType 0x40/0xC0`, `bRequest 0xA3/0xA7-0xA9/0xB2/0xB7-0xB9`) sent to a WinUSB-bound vendor device.
   * **Realtek RTS hub (`0BDA:1100`)**: HID Output/Input reports, each carrying an 11-byte I2C command header, through `RhHidAPI.dll`.
   * **Genesys GL35xx hub (VID `05E3`)**: vendor control transfers (`0x7C/0x7F/0xC1/...`) sent to the hub itself. On Windows this goes through the `glusbflt` filter driver and `GL_SDK.dll`.
2. **The user's 34M2C8600 uses the VIA path (CONFIRMED in the logs).** The logged device is `\\?\usb#vid_2109&pid_8884#0000000000000001#{a5dcbf10-...}` with `Hub-Scaler: VIA-RTK` and `ScalerName: RTD2738VL`. The logs also record `CheckSupportUSBDDC(0x14): isSupport = True` and dozens of "Hub Get/Set…" VCP operations per session (118 lines on 2026-09-26) that all return `result=0`. When the monitor is reachable over USB, **all OSD traffic goes over USB-DDC**. GPU DDC (DDCHelper) is only a fallback.
3. **USB-DDC is enabled at runtime, not from JSON.** The app probes `GetVCP(0x14)` and requires `0 < value < 255 && max < 255`. The JSON flag `SupUsbDDC` in `MonitorInfo.json` has no reader in code. `SupOTA` from the same (server-updatable) JSON only gates the firmware-update UI.
4. **Firmware update ("DisplayFW").**
   * The renderer asks the Zeasn device portal (`https://deviceportal.zeasn.tv/direct/component/update`) whether an update exists. That request sends the BOM string, the version and **the PC's MAC address**.
   * It then downloads a ZIP (or RAR) and hash-checks it against the server-supplied hash.
   * It calls `DisplayFW_UpdateFirmversion(scalerModelName, deviceType, localZipPath)`.
   * The backend extracts the first `*.bin`, checks that the file name contains the model name, pads the image to 1 KiB, and runs a 10-step ISP state machine. For the user's Realtek scaler this state machine is plain **Realtek ISP register programming over I2C slave `0x4A` (8-bit `0x94/0x95`)**, tunneled through the same VIA bridge.
   * ISP here means: enter ISP (reg `0x6F`), detect the SPI flash (JEDEC `0x9F`), clear the status-register protection, erase the boot-flag sector, erase and program each 64 KiB block of the dual-image bank at `DualImageBank*0x10000` (`0x400000` on this monitor), check a CRC-8 per block, write the boot flag `AA 55`, re-protect, and reset (reg `0xEE`).
   * The host does no firmware signature check (Realtek path). The only integrity checks are the download hash and a per-block CRC-8 against the flash.
5. **Linux.** Implement USB-DDC with libusb control transfers for VIA and Genesys. These are device-recipient vendor requests, so no interface claim or driver detach is needed. For Realtek, use hidraw with `HIDIOCSOUTPUT`/`HIDIOCGINPUT`, or libusb `SET_REPORT`/`GET_REPORT`. Add udev `uaccess` rules. Share the DDC/CI framing with the `/dev/i2c-*` path. Firmware update should be **dropped**, or at most offered as an explicit, offline, local-file expert feature. It is fully documented below, but it is high-risk.

---

## 1. Layering and class map

### 1.1 Layers (CONFIRMED)

```
Display.cs (PCenter.Base.Lib)  --"Hub"-->  MonitorService (public API, lock MonitorLock)
                                             |
                                        Interface0/Class2 (enumeration + dispatch)
                                             |
IMonitorDevice / IOTADevice (ML/Zeasn.Monitor.Lib.ScalerFW.Devices/*.cs)
   Interface2  : DDC/CI framing (checksum, Get/Set VCP, caps, TPV vendor cmds)   ML/Interface2.cs
   Interface1  : 4 I2C primitives imethod_0..3                                  ML/Interface1.cs
   Interface8  : monitor-info queries + 10-step ISP state machine                ML/Interface8.cs
   ├── hub transport:   Interface13 = VIA (WinUSB)      ML/Interface13.cs
   │                    Interface12 = RTK (RhHidAPI)    ML/Interface12.cs
   │                    Interface10 = Genesys (GL_SDK)  ML/Interface10.cs
   └── scaler ISP:      Interface7 = Realtek (RTD)      ML/Interface7.cs
                        Interface5 = MTK/MStar          ML/Interface5.cs
                        Interface6 = Novatek            ML/Interface6.cs
                        Interface3 = HVW-6315, Interface4 = HVW-7315
                        Interface9 = unknown scaler (all ISP steps are no-ops)
```

The four `Interface1` primitives are declared as `imethod_0..3` (`ML/Interface1.cs:6-12`, default `repeat=3`, `timeout=177`). Implementations keep their obfuscated names. The mapping follows from declaration order and from how callers use them (INFERRED, consistent everywhere):

| Decl. | Impl. name | Purpose |
|---|---|---|
| `imethod_0` | `XQk0iRoH44` | raw I2C write (ISP register writes) |
| `imethod_1` | `JIi0gbPVqH` | raw I2C read |
| `imethod_2` | `w1l0pAh5O9` | DDC/CI write, then `Sleep(100)` |
| `imethod_3` | `dnm0IaPUfk` | DDC/CI read, then `Sleep(50)` |

### 1.2 Concrete classes (CONFIRMED)

| Hub \ scaler | RTK (Realtek) | MTK (MStar) | NTK | HVW | unknown |
|---|---|---|---|---|---|
| VIA | `Class15` (Interface23+7) **user's monitor** | `Class16` (21+5) | `Class17` (22+6) | `Class18` (19+3); `Class19` (20+4, via `Class6.method_1`) | `Class14` (Interface9) |
| RTK | `Class11` (18+7) | `Class12` (16+5) | `Class13` (17+6) | – | `Class10` (Interface9) |
| Genesys | `Class8` (15+7) | `Class9` (14+5) | – | – | `Class7` (Interface9) |

The factories `Class14.vmethod_0`, `Class10.vmethod_0` and `Class7.vmethod_0` pick the class after `GetScalerIC()` (`ML/Class14.cs`, `ML/Class10.cs`, `ML/Class7.cs`). `Class6.method_2` copies the hub/scaler/VID/PID/handles into the new object (`ML/Class6.cs:57-71`).

---

## 2. Discovery

### 2.1 Which hub families are present (`Util.smethod_10`, `ML/Zeasn.Monitor.Lib.Utils/Util.cs:293-315`) (CONFIRMED)

The code enumerates Windows device interfaces:

* `GUID_DEVINTERFACE_USB_DEVICE` `{A5DCBF10-6530-11D2-901F-00C04FB951ED}` (`ML/Class44.cs:53`, enumerated by `Class40.smethod_1`, `ML/Class40.cs:116-153`).
* `GUID_DEVINTERFACE_USB_HUB` `{F18A0E88-C30C-11D0-8815-00A0C906BED8}` (`ML/Class44.cs:55`, `Class40.smethod_2`).

| Result | Condition |
|---|---|
| `HubType.VIA` | any USB **device** path containing `vid_2109` |
| `HubType.RTK` | any USB **device** path containing `vid_0bda` (note: *any* Realtek device, such as a card reader or NIC, triggers this) |
| `HubType.Genesys` | any USB **hub** path containing `vid_05e3`, or a hub whose VID/PID maps to Genesys via `OtherOTAUtil.GetUsbHubType` (VID `0x0552` or `0x05F6`, PID `0x1200-0x12FF`) |

`MonitorService.CheckUpstreamCable(type)` (`ML/Zeasn.Monitor.Lib/MonitorService.cs:110-122`) returns this list. Bridge function `DisplayFW_CheckUpstreamCable` exposes it (§7.1).

### 2.2 Per-family enumeration (`Class2.yGB0ZdvUvw`, `ML/Class2.cs:30-63`) (CONFIRMED)

For each detected family the code runs that family's enumerator, then `GetScalerIC()` (VCP `0xC8`, §3.4), then builds the scaler-specific class and re-opens it. A family that is not present logs `【MonitorOTAOperator】没有检测到 <X>-Hub 机台` ("no <X>-Hub machine detected").

**VIA** (`Class5`, `ML/Class5.cs:21-64`):
* Takes every `GUID_DEVINTERFACE_USB_DEVICE` path containing `vid_2109`.
* Opens it with `CreateFile(path, GENERIC_READ|GENERIC_WRITE, FILE_SHARE_READ|WRITE, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL|FILE_FLAG_OVERLAPPED)` (`ML/Class40.cs:111-114`), then `WinUsb_Initialize` (`ML/Interface13.cs:18-51`).
* Description is the substring between `usb#` and the GUID, e.g. `VID_2109&PID_8884#0000000000000001`. VID/PID are parsed from it (`ML/Class0.cs:426-442`).
* No device-specific init command is sent.

**RTK** (`Class4`, `ML/Class4.cs:96-170`):
* `RH_ConfigLog(true,0)`, then `RH_ListAllHidDev(&list,&count)`.
* The HID list is filtered to `DevType == 4 && VID contains "0BDA" && PID contains "1100"` (`ML/Class4.cs:159`).
* For each match: `RH_OpenHid(dwInst)`, then `RH_HidI2CConfig(h, 0x6E, 1, 0)` (`ML/Interface12.cs:32-41`).

**Genesys** (`Class3`, `ML/Class3.cs:290-350`):
* Requires the `glusbflt` filter service to be installed: registry `HKLM\SYSTEM\CurrentControlSet\Services\glusbflt` with `DisplayName=="glusbflt"` and `Enum\Count >= 1` (`ML/Class3.cs:184-227`).
* Then `InitialzeSDK`, `DetectUsbHub`, `GetUsbHubList`.
* For each hub: send a vendor "open" (§5.3), then `GetScalerIC`.

### 2.3 What the user's machine shows (CONFIRMED, `LOG/2026-09-26.txt:28-45,148-163`)

```
UsbDevices: ... \\?\usb#vid_2109&pid_8884#0000000000000001#{a5dcbf10-...}
UsbHubs:    vid_2109&pid_0211, vid_2109&pid_0817 (serial msft30000000000), vid_2109&pid_2817 (msft20000000000), 2x root_hub30
【MonitorOTAOperator】没有检测到 RTK-Hub 机台 / 没有检测到 Genesys-Hub 机台
* ModelName: 34M2C8600  * BomString: 100GPRS2003NA1SXXY  * Version: V1.01
* DualImageBank: 0x40   * ScalerName: RTD2738VL  * VID: 0x2109, PID: 0x8884
* Hub-Scaler: VIA-RTK
CheckSupportUSBDDC(0x14): isSupport = True，value = 0x05，max = 0x0D
```

Also CONFIRMED in the logs:
* `[GetSN] ... SN : AU00000000001` (13 characters; anonymized) at `LOG/2026-09-25.txt:166`.
* The capabilities string read over USB took 6.8 s (`LOG/2026-09-25.txt:169`).

The VIA hub is a VL817-family part: `2109:2817` is the USB 2.0 half and `2109:0817` the USB 3.x half (INFERRED from the PID naming). `2109:8884` is a separate vendor device behind it that WinUSB can open, so it is the I2C bridge function. `2109:0211` is another VIA hub, role unknown (open question).

Timing from the logs: each "Hub GetStandardValue" or "GetTPVExternValue" takes about **185 ms** end to end (`LOG/2026-09-26.txt:913-993`), and each "Hub Set…" about 110 ms (`:962-971`).

---

## 3. DDC/CI framing (common to all transports)

### 3.1 Checksum and frame builder (`Interface2.imethod_4`, `ML/Interface2.cs:15-30`) (CONFIRMED)

* The input is a `data[]` of fewer than 32 bytes, starting with the destination address byte.
* The output is a 32-byte buffer `data || cs`, where `cs = data[0] ^ data[1] ^ … ^ data[n-1]`. The transfer length is `n+1`.
* For host->display writes the first byte is **`0x6E`**, so the XOR includes the destination address, as MCCS requires.

### 3.2 Reply validation (`GetStandardData`, `ML/Interface2.cs:32-93`) (CONFIRMED)

1. Up to 3 attempts. Each attempt:
   * Write through `imethod_2` (VIA/RTK/Genesys implementations sleep 100 ms after the write).
   * Sleep `max(15, sleepTime - elapsedWriteMs)` (`sleepTime` is 150 by default, 100 for `GetDDC`).
   * Read `readLength` bytes (32, or 64 for capabilities) through `imethod_3`. The read buffer is pre-filled with `buf[0]=0x6F`, which the VIA read uses as its I2C read address (§4).
2. Validity: `L = buf[1]-0x80`, `0 < L`, `L+3 <= readLength`, and `0x50 ^ buf[0] ^ … ^ buf[L+2] == 0`. This is the standard MCCS reply checksum with virtual host address `0x50`.
   * The `DISABLE_CHECK_SUM` setting skips this check (`ML/Class45.cs:139-144`).
3. `imethod_7` additionally requires `buf[0]==0x6E && buf[1]>0x80` (`ML/Interface2.cs:132-140`). So **the bridge returns the raw I2C read bytes, starting with the display's source byte `0x6E`**.

### 3.3 Standard and "extended" VCP (CONFIRMED)

| Operation | Frame sent (checksum added) | Code |
|---|---|---|
| Get VCP `c` | `6E 51 82 01 c` | `ML/Interface2.cs:155-176,198-225` |
| Set VCP `c`=v | `6E 51 84 03 c vH vL` | `ML/Interface2.cs:178-196,227-239` |
| Get extended (`pre2 aCode01 ext`) | `6E 51 84 01 pre2 aCode01 ext` | `ML/Interface2.cs:241-268` |
| Set extended | `6E 51 86 03 pre2 aCode01 ext vH vL` | `ML/Interface2.cs:270-282` |
| Raw `GetDDC(cmds…)` / `SetDDC(cmds…)` | `6E 51 (0x80+1+len) 01|03 cmds…`, `len <= 27` | same |

* The extended form is used with `pre2=0xE2, aCode01=0xA0` for the TPV/Philips "E2A0xx" controls (logged as `command=e2a0NN`, e.g. `LOG/2026-09-26.txt:931-993`).
* The same `IMonitorDevice.GetDDC/SetDDC` API is exposed publicly through `MonitorService.GetDDC/SetDDC` (`ML/Zeasn.Monitor.Lib/MonitorService.cs:282-296`).

**Reply parsing** for Get: with `L = r[1]-0x80` (valid only if `r[1]>0x80 && L<=30` and the buffer length is 32 or 64):
* `value = r[L]<<8 | r[L+1]`
* `max = r[L-2]<<8 | r[L-1]`

For a standard 8-byte reply `6E 88 02 rc cc tp mh ml sh sl cs` this gives `value=sh:sl` and `max=mh:ml`. The result code `rc` is **not checked**.

Worked examples (checksums computed with the §3.1 algorithm):

```
Get brightness      : 6E 51 82 01 10 AC
Get VCP 0x14 probe  : 6E 51 82 01 14 A8
Get VCP 0xC8        : 6E 51 82 01 C8 74
Set 0x10 = 0x0032   : 6E 51 84 03 10 00 32 9A
Get E2A0 43         : 6E 51 84 01 E2 A0 43 BB
Set E2A0 43 = 1     : 6E 51 86 03 E2 A0 43 00 01 BA
Reply (example)     : 6E 88 02 00 10 00 00 64 00 32 F2   (value 0x32, max 0x64; 0x50^...^F2 == 0)
```

### 3.4 Monitor-identity commands (TPV vendor "FE" page and VCP C8) (CONFIRMED frames; reply layout partly INFERRED)

The Get-VCP opcode `0x01` is followed by 5 bytes `FE xx yy zz ww`, which makes these non-standard 6-byte requests.

| Query | Frame (with cs) | Parse | Code |
|---|---|---|---|
| ScalerIC | `6E 51 82 01 C8 74` (MCCS VCP C8 "display controller type") | `sub = reply[5..]`, `ScalerIC = sub[4]` (= SL byte). Mapping: `0x09`→RTK, `0x05`→MTK, `0x12`→NTK, `0x24`→HVW, else Unknown | `ML/Interface8.cs:257-287` |
| ModelName | `6E 51 86 01 FE E9 0D 00 00 A2` | ASCII (see `imethod_8` below) | `ML/Interface2.cs:382-402` |
| BOM string | `6E 51 86 01 FE E1 E6 1D 00 5C` | ASCII; with setting `PHILIPS` it is accepted only if its 5th char is `'P'` (or the literal `100GARVGG88NT1SXXY`); with `AOC`, 5th char `'A'`; else `Fail_GetBOMString_NotSupport` | `ML/Interface8.cs:289-334` |
| FW version | `6E 51 86 01 FE E1 E6 06 00 47` | ASCII, e.g. `V1.01` | `ML/Interface8.cs:359-379` |
| DualImageBank | `6E 51 86 01 FE E1 A1 01 00 07` | `sub[1]<<8 | sub[2]` (NTK: `sub[2]`) | `ML/Interface8.cs:336-357` |
| BootFlagAddress (RTK only) | `6E 51 86 01 FE E1 A1 01 01 06` | `sub[1..4]` big-endian int32 | `ML/Interface7.cs:49-71` |
| ScalerName | `6E 51 86 01 FE E1 E8 00 00 4F` | ASCII, e.g. `RTD2738VL` | `ML/Interface8.cs:381-401` |
| PanelName | `6E 51 86 01 FE E1 A7 07 00 07` | ASCII | `ML/Interface8.cs:403-423` |
| Serial number | `6E 51 86 01 FE EF 13 00 20 9A` (read 32 bytes, 100 ms) | `N = r[1]-0x80` (if `N==32`, use `N-2`); `SN = ascii(r[2..N+2])` with non-ASCII bytes stripped; truncated to 14 chars; empty if `N<13` | `ML/Interface2.cs:284-322` |

`imethod_8` (`ML/Interface2.cs:142-148`) extracts the payload: `len = r[1]-0x80`, `start = (r[5]==0) ? 6 : 5`, copy `len-(start-2)` bytes from `r[start]`. The exact meaning of reply bytes `r[2..4]` is INFERRED to be an opcode/echo.

`GetMonitorInfo` (`ML/Interface8.cs:144-255`) runs ModelName, BOM, Version, DualImage and ScalerName, each retried 3 times with 150 ms between tries. A failure of ModelName, BOM or Version clears `IsReadyForFirmwareUpdate`. The RTK variant also reads BootFlagAddress (`ML/Interface7.cs:22-47`).

### 3.5 Capabilities string (`0xF3`) (CONFIRMED)

* Generic path (`ML/Interface2.cs:324-380`): request `6E 51 83 F3 offH offL` and read 64 bytes (100 ms). The reply must have `r[2]==0xE3`. `N = r[1]-0x80` (if `N==32`, `N-2`; capped at 30). Fragment data is `r[5 .. 2+N)`. Append it, then `offset += N-3`, and stop when `N-3 < 26`. Up to 3 read failures are tolerated.
* VIA path (`ML/Interface13.cs:440-515`): the same frames. With the default `VIA_FUNCTION A7A9` it reads 2×32 bytes through `ReadA7A9` (§4.3). With `VIA_FUNCTION A3` it does one 32-byte read. Stop condition: `N-3 < 32-6`.
* The user's real string, cached in `%APPDATA%\EvniaServe\Config\data.json`, starts `(prot(monitor)type(LCD)model(34M2C8600MV)cmds(01 02 03 07 0C E3 F3)vcp(02 04 05 08 0B 0C 10 12 14(…) … E2A000(…) … mccs_ver(2.2))`.
* Recommendation for Linux: use the standard algorithm (advance by the fragment length, stop on an empty fragment). Keep the vendor's "fragment shorter than 26" stop only as a fallback.

### 3.6 USB-DDC support probe (CONFIRMED)

`Interface0.imethod_5` (`ML/Interface0.cs:465-473`, public name `MonitorService.method_0` / `CheckIsSupportUSBDDC`):

```
IsSupportUsbDDC = GetStandardDDC(0x14) == Success && 0 < value < 255 && max < 255
```

It is called for every enumerated USB monitor by `DataOSD.EnumerateUsbMonitors()` (`DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/DataOSD.cs:72-91`). Only devices with `IsSupportUsbDDC` and a non-empty EDID serial are merged into the UI's `Display` list (`DC/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/GClass3.cs:100-126`).

`Display.GetStandardValue/SetStandardValue/GetTPVExternValue/SetTPVExternValue` try "Hub" (USB) first and fall back to GPU DDC (`NewDDCOper`, DDCHelper) on failure (`DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/Display.cs:354-475`).

**`SupUsbDDC`** (in `DictDisplayInfo.cs:36` and `work/app/MonitorInfo.json`, `true` for `34M2C8600`) **has no reader** in either the C# or the JS code (grep, CONFIRMED). It is informational only.

### 3.7 USB monitor ↔ OS display pairing (CONFIRMED)

`MonitorUtil.smethod_6/8` (`ML/Zeasn.Monitor.Lib.Utils/MonitorUtil.cs:1271-1360`) works as follows:
* Reads each active display's EDID from `HKLM\SYSTEM\CurrentControlSet\Enum\DISPLAY\<id>\<inst>\Device Parameters\EDID`.
* Takes the monitor-name descriptor (`00 00 00 FC 00` + ASCII) and strips a `PHL`/`AOC` prefix.
* Matches `^((AOC )|(PHL )|(AOC_)|(PHL_)|(AOC)|(PHL))?<name>$`, then retries with the looser `…<name>[0-9A-Z]*`, against the `ModelName` read over USB.
* On a match, the EDID is attached to the USB device.

Displays are then merged by **EDID serial number** (`GClass3.method_4`, `:76-98`).

---

## 4. Transport A: VIA Labs bridge (user's monitor)

### 4.1 Device and open (CONFIRMED)

| Item | Value |
|---|---|
| Device | `2109:8884`, serial `0000000000000001` (log). The app accepts any `2109:*` non-hub device that WinUSB can open (`ML/Class5.cs:23-25`). |
| Windows binding | WinUSB on the device's `GUID_DEVINTERFACE_USB_DEVICE` path (`ML/Interface13.cs:34-47`). No pipe policy is set, so timeouts are WinUSB defaults. |
| Interface/endpoints | Control endpoint 0 only (`WinUsb_ControlTransfer`, `ML/Class44.cs:67-68`). |
| Setup struct | `WINUSB_SETUP_PACKET {u8 RequestType; u8 Request; u16 Value; u16 Index; u16 Length}` (`ML/Class44.cs:7-19`) |
| Init command | none |
| Retry | `Util.smethod_0(fn, repeat=3, timeout=177)`: after a failure, sleep `(n+1)*177` ms (`ML/Zeasn.Monitor.Lib.Utils/Util.cs:24-46`) |

The device's USB class (vendor 0xFF, Billboard 0x11 or other) is not visible in the corpus (open question).

### 4.2 Vendor requests (codes CONFIRMED in `ML/Interface13.cs:68-177`; I2C semantics INFERRED from the vendor's method names)

All requests have device recipient, vendor type, and `wValue = 0`. For reads, `wIndex` is the 8-bit I2C **read** address, taken from `buf[0]`.

| Method | bmRequestType | bRequest | wIndex | wLength | Data stage | I2C semantics |
|---|---|---|---|---|---|---|
| `imethod_11` (full write) | `0x40` | **`0xB2`** | 0 | N | OUT `[addrW, bytes…]` | START addrW data… STOP |
| `imethod_12` (full read) | `0xC0` | **`0xA3`** | `addrR` (e.g. `0x006F`) | N | IN N bytes | START addrR, N bytes, NACK, STOP |
| `I2CWriteCmd_Start` | `0x40` | `0xB7` | 0 | N | OUT `[addrW, …]` | START + data, no STOP |
| `I2CWriteCmd_DataNP` | `0x40` | `0xB8` | 0 | N | OUT | more data, no STOP |
| `I2CWriteCmd_DataP` | `0x40` | `0xB9` | 0 | N (may be 0) | OUT | more data, then STOP |
| `I2CReadCmd_Start` | `0xC0` | `0xA7` | `addrR` | N | IN | START addrR + read, no STOP |
| `I2CReadCmd_DataACK` | `0xC0` | `0xA8` | `buf[0]` | N | IN | continue read (ACK) |
| `I2CReadCmd_DataNACK` | `0xC0` | `0xA9` | `buf[0]` (0 in practice) | N | IN | final read, NACK + STOP |

Mapping to the `Interface1` primitives (`ML/Interface13.cs:271-293`):

| Primitive | VIA implementation |
|---|---|
| `imethod_0` | `0xB2` |
| `imethod_1` | `0xA3` |
| `imethod_2` | `0xB2`, then `Sleep(100)` |
| `imethod_3` | `0xA3`, then `Sleep(50)` |

### 4.3 DDC/CI over VIA: exact traffic (CONFIRMED by construction; the user's logs confirm it works)

```
GetVCP(0x10):
  CTRL OUT  40 B2 0000 0000 0006   data: 6E 51 82 01 10 AC
  sleep 100 ms (+ >=15 ms)
  CTRL IN   C0 A3 0000 006F 0020   -> 32 bytes: 6E 88 02 00 10 00 00 64 00 32 F2 ...
  sleep 50 ms
SetVCP(0x10, 0x32):
  CTRL OUT  40 B2 0000 0000 0008   data: 6E 51 84 03 10 00 32 9A
  sleep 100 ms
Capabilities, default "A7A9" mode (ML/Interface13.cs:301-358, 425-438):
  CTRL OUT  40 B2 0000 0000 0007   data: 6E 51 83 F3 offH offL cs
  sleep
  CTRL IN   C0 A7 0000 006F 0020   (first 32 bytes, no STOP)
  CTRL IN   C0 A9 0000 0000 0020   (next 32 bytes, NACK+STOP) -> 64-byte reply buffer
```

### 4.4 VIA as ISP I2C master (RTK scaler, `ML/Interface23.cs`) (CONFIRMED)

The Realtek ISP slave is **`0x94` (write) / `0x95` (read)**, i.e. 7-bit `0x4A`.

**Register write** `I2CWriteCmd(reg, v…)` (`:12-53`), with buffer `[0x94, reg, v…]`:
* If the buffer is at most 32 bytes: one `B2` transfer.
* Otherwise (e.g. a 256-byte FIFO burst to `reg=0x70`):
  * `B7 [0x94,0x70]`
  * then 32-byte chunks with `B8`
  * and the final chunk with `B9`.

**Register read** `I2CReadCmd(reg)` (`:55-80`):
* `B7 [0x94, reg]`
* `A3 wIndex=0x0095 wLength=32` (the value is in byte 0)
* `B9` with length 0 (STOP)

**Poll** `I2CReadAndCheck(reg, mask, expect, timeoutSec)` (`:82-112`): read `reg` every ~2 ms until `(v & mask) == expect`. The timeout is multiplied by 3 in `DEBUG_MODE`.

**ISP start** (`:114-119`): max write burst 256 bytes (`DeviceData.method_14(256)`), and "ignore reset failure" is set to true.

---

## 5. Transports B and C (not used by the user's monitor)

### 5.1 Realtek RTS hub HID bridge: `RhHidAPI.dll` (`INST/lib/RTK/RhHidAPI.dll`)

**C# imports** (`ML/Class23.cs`, all cdecl):

```
IntPtr RH_OpenHid(uint devInst)
void   RH_CloseDev(IntPtr)
int    RH_ListAllHidDev(ref IntPtr list, ref uint count)   // nonzero = success
int    RH_FreeDevList(IntPtr)
bool   RH_ConfigLog(bool enable, int level)
int    RH_HidI2CConfig(IntPtr, byte slaveAddr, byte speed, byte memLen)   // 0 = OK
int    RH_HidI2CWrite (IntPtr, uint addr, byte[] buf, ushort len)         // len <= 0x80
int    RH_HidI2CRead  (IntPtr, uint addr, byte[] buf, ushort len)         // len <= 0xC0
bool   RH_ReadDevVersion(IntPtr, out int)
bool   RH_ReadBinVersion(IntPtr, byte[] path, out int)
bool   RH_UpdateDev(IntPtr, byte[] path, bool cb(int progress))
```

Other exports exist but the C# code does not use them: `RH_ListAllHidDevByVIDPID`, `RH_HidI2CBlockWriteFlash/EraseFlash/Status`, `RH_MST_HidI2CBlock`, `RH_HidSetHubGPIO` (`NV/RhHidAPI.dll.symbols.txt:1-35`).

**List record** `Class23.Struct0` (`ML/Class23.cs:10-40`), Unicode, sequential, 4136 bytes:

| Field | Type |
|---|---|
| `dwInst` | `u32` |
| `hwID` | `wchar[1024]` |
| `Path` | `wchar[1024]` |
| `PID` | `wchar[5]` |
| `VID` | `wchar[5]` |
| `nLevel` | `i32` |
| `nPort` | `i32` |
| `DevType` | `u32` |
| `USBSpeed` | `u32` |

**DDC use** (`ML/Interface12.cs:13-90`) (CONFIRMED):
1. `RH_HidI2CConfig(h, 0x6E, 1, 0)`.
2. Write: `RH_HidI2CWrite(h, 0x51, frame[2..], len-2)`. The C# strips `6E 51` and passes `0x51` as the "address".
3. Read: `RH_HidI2CRead(h, 0x51, buf, len)`.
4. Retries: 3 attempts, sleeping `2*n` ms (`ML/Class23.cs:164-257`).

**ISP use** (`ML/Interface18.cs`): `RH_HidI2CConfig(h, 0x94, 1, 1)`, then `RH_HidI2CWrite(h, reg, values, n)` and `RH_HidI2CRead(h, reg, buf, 1)`.

**Wire format** (CONFIRMED from `NV/RhHidAPI.dll.c`; the vtables were verified by parsing the PE):

`CHidDev` vtable: `+0x9c` config, `+0xa0` write, `+0xa4` read. `CHidProperty` `+0x2c/+0x30` forward to `CHidTransfers` `+0x14/+0x18`.

* **Config** (`FUN_10004290`, `NV/RhHidAPI.dll.c:3017`) only stores `slave, speed, memLen`. It is accepted if `slave!=0`, `speed<=4`, `memLen<=2` (`:22693-22735`).
* **I2C write** `CHidDev::I2CWriteImpl` (`FUN_100042c0`, `:3031-3110`) builds an 11-byte command header:

  ```
  [0]=0x40 [1]=0xC6 [2..5]=addr (LE32) [6..7]=len (LE16) [8]=slave [9]=speed [10]=memLen|0x80
  ```

* **I2C read** `CHidDev::I2CReadImpl` (`FUN_10004490`, `:3112-3190`) uses the same header with `[1]=0xD6`.
* **HID report layout.** `CHidTransfers` (`FUN_10016c50` "HidDataOut", `FUN_10016ac0` "HidDataIn", `FUN_100168c0` "Hid_SetReport", `:20543-20810`) builds the output report as:

  ```
  byte 0        : report ID 0x00
  bytes 1..64   : header area (the 11 or 8 header bytes, zero padded to 64)
  bytes 65..    : payload (write data), zero padded to OutputReportByteLength
  ```

  * The payload length must satisfy `len <= OutputReportByteLength - 0x41`, otherwise the call fails ("pBuffer Len greater than Max Length").
  * It is sent with **`HidD_SetOutputReport`**, which is a control `SET_REPORT(Output, ID 0)`.
  * For reads (and any request with `bmRequestType & 0x80`), the code then calls **`HidD_GetInputReport`**, a control `GET_REPORT(Input, ID 0)`, and copies `len` bytes from report byte 1.
  * A mutex serializes transfers. The lock wait is 100 ms polls up to a 5000 ms timeout.
  * Report lengths come from `HidP_GetCaps` (`FUN_10016600`, `:20378-20541`). Their actual values for `0BDA:1100` are not in the corpus (open question).
* **Generic "VD command"** `Rs_SendVDCmd(reqType, req, wValue, wIndex, data, len, timeout)` (`FUN_10016950`, `:20577-20658`) wraps a USB vendor setup packet in the same report: header `[reqType, req, wValue LE16, wIndex LE16, len LE16]`, payload = data. The special case `(0x40, 0xF2)` puts the data itself in the header area.
* **Device probing** `CHidProperty::Rs_IsRtHid` (`FUN_10015430`, `:19383-19745`):
  * If `VidPid.ini` exists next to the DLL, only listed VID/PIDs are accepted.
  * **Otherwise every openable HID device receives the VD command** `40 02 wValue=0001 wIndex=0BDA len=0` ("VdcmdEnable"), then `wValue=0000`. The constant `0x0240` at `0x10051ab8` was CONFIRMED by reading the PE.
  * A device that accepts the report is treated as a Realtek hub.

**Real log** `INST/lib/RTK/info.txt` (2026-08-09) (CONFIRMED):
* No `0BDA:1100` device was present.
* The probe output report was **accepted by three unrelated HID devices of the user (a keyboard's `MI_02` interface and two other devices' `MI_00` interfaces; anonymized `0000:0001`, `0000:0004`, `0000:0005`)**, so they were listed as "Realtek HID" (`Index:0..2`).
* Other HID devices failed with `ERROR_INVALID_PARAMETER (87)` or `ERROR_INVALID_FUNCTION (1)`, or could not be opened (`ERROR_ACCESS_DENIED (5)`).
* The C# filter (`DevType==4 && 0BDA && 1100`) then discarded them.
* What triggered this run: RTK enumeration starts whenever *any* `vid_0bda` USB device exists (§2.1). It is INFERRED that a Realtek device was attached that day.
* **The Linux port must not replicate this probe.**

**`CUSBDev` variant** (non-HID, real control transfers, used by the DLL's USB-device mode) (`FUN_10008650/10008790/10008900`, `:6706-6920`):

| Operation | Setup packet |
|---|---|
| config | `40 F6 wValue=(slave<<8)|speed wIndex=0x8000|(memLen|0x80) wLength=0` |
| write | `40 C6 wValue=addr[15:0] wIndex=addr[31:16] wLength=len` |
| read | `C0 D6 …` |

This confirms that the HID header is a USB setup packet plus 3 extra bytes.

**Semantics of `memLen`** (INFERRED, uncertain): values are 0..2.
* The ISP path uses `1` with `addr=register`, i.e. a 1-byte sub-address.
* DDC uses `0` with `addr=0x51`. This suggests "0 = DDC/CI mode": the address byte is sent on writes but there is no sub-address phase on reads.
* Verify with a USB capture before relying on it (open question).

**Realtek PD controller update** (`ML/Class21.cs`; only for RTK-hub monitors) (CONFIRMED):
* SMBus to slave `0xAC` through the same HID I2C calls.
* Write: `RH_HidI2CConfig(h,0xAC,0,1)`, `RH_HidI2CWrite(h,0xAC,cmd,len)`, then poll `RH_HidI2CRead(h,0xAC,buf,1)` until non-zero (2.5 s timeout; `1` means OK).
* Read: `RH_HidI2CConfig(h,0xAC,1,1)`, then `RH_HidI2CRead(h,0x80,buf,n)`.
* Commands:

| Command | Bytes |
|---|---|
| VENDOR_CMD_ENABLE | `01 03 DA 0B 01` |
| FLASH_ACCESS_ENABLE | `01 03 DA 0B 03` |
| GET_IC_STATUS | `3A 03 00 00 1F` (read 31 bytes; `[4..5]` version, `[10..13]` VID/PID LE) |
| ERASE | `03 03 DA 0B 00` |
| RESET_TO_FLASH | `05 03 DA 0B 01` (then 5 s wait) |
| SMBUS_ISP_VALIDATION | `16 01 01` |

**Realtek hub self-update** (`RH_UpdateDev`, used by `Class20` for `ConnectedHubType==RTK`, `ML/Class20.cs`):
* Driven by DLL strings `CUniversalFlow::DevUpdate`: reset to ROM, erase, write flash, check flash (compare), reset to flash (`NV/RhHidAPI.dll.symbols.txt`).
* The bin files must contain `LV<n>_`; the matching hub is found by `nLevel == n+2`.

### 5.2 Genesys GL35xx: `GL_SDK.dll` (`INST/lib/Genesys/GL_SDK.dll`)

**API** (`ML/Zeasn.Monitor.Lib.ScalerFW.Devices.Monitor.HubAPI/GenesysAPI.cs:12-64`, cdecl, Unicode):
* `SDKVersion()` returns 4 (`NV/GL_SDK.dll.c:684-691`).
* Lifecycle: `InitialzeSDK()`, `UninitialzeSDK()`.
* `InstallHubDriver()`, `UninstallHubDriver()`, `UsbSelectiveSuspend(bool)`.
* `DetectUsbHub(ref nuint count)`, `GetUsbHubList(UsbDeviceInfo[], nuint count)`.
* `QueryUsbHubFwCount`, `GetUsbHubFwVersion`, `GetSpecificFwVersion`.
* **`SendControlPipe(ref UsbDeviceInfo, UsbSetupPacket, byte[] data)`**: the wrapper always calls `CloseControlPipe` afterwards (`GenesysAPI.cs:167-175`).
* `UpdateFw(ref UsbDeviceInfo, ref GlFw{GL_FW_TYPE eType; int iIdx}, string path)`, where `GL_FW_TYPE` is `HUB, INT_PD, EXT_PD, HOST_BRIDGE, RSV1, RSV2, SCALER, MCU` (`GL_FW_TYPE.cs`).
* `ERROR_CODE`: `OK=0, SDK_NOT_INIT=1, FUNCTION_FAILED=2, INVALID_PARAMETER=3, FILE_NOT_EXIST=4`.

**Structs** (all `Pack=4`):

| Struct | Layout |
|---|---|
| `UsbSetupPacket` | `u8 bmRequest, u8 bRequest, u16 wValue, u16 wIndex, u16 wLength` (8 bytes, passed by value) |
| `UsbDeviceInfo` (48 bytes) | USB device descriptor (18 bytes, `GStruct0`) + `szManufacturer*`, `szProduct*`, `szSerialNumber*` + `u64 uLocationPort` + `pEntityObj*` |

**Windows transport** (CONFIRMED):
* `SendControlPipe` (`NV/GL_SDK.dll.c:1101-1252`) → `FUN_1000dd20` (`:12465-12522`) builds a buffer: `[0..3]` device id, `[4..7]` hub handle, `[8..15]` setup packet, `[16..]` data.
* It is sent with `DeviceIoControl(\\.\glusbflt, 0x222008 /*GL_IOCTL_USB_REQUEST*/)` (`FUN_1003c250`, `:54588`).
* The SDK can also use a "GLI HID" feature-report path (`HidD_SetFeature/GetFeature`) and WinUSB (imports and strings in `NV/GL_SDK.dll.symbols.txt`).
* It skips `VID_2109` hubs except PIDs `0210` and `2210`, and it skips `VID_8087`, `050D:0307` and `05E3:0608` (`NV/GL_SDK.dll.c:39204-39229`).

**Driver management** (`ML/Class3.cs:94-146`, `258-288`): `GenesysDriver\GLHubUpdateToolCli.exe` together with `GLHub.ini`, from the app directory or `%APPDATA%\MonitorOTA\GenesysDriver`. It is run elevated with `/di /d` (install) or `/e /du` (uninstall). These files are **not shipped** in this install (CONFIRMED: not found).

### 5.3 Genesys vendor requests used by the C# code (CONFIRMED, `ML/Interface10.cs`)

| Purpose | bmReq | bReq | wValue | wIndex | wLength | Data |
|---|---|---|---|---|---|---|
| Open ("jVKU841h1J") | `0xC0` | `0xC1` | `0x0300` | 0 | 1 | IN 1 byte, ignored; then **sleep 500 ms** (`:223-238`) |
| DDC write (`imethod_2`) | `0x40` | `0x7C` | 0 | 0 | N | full frame incl. `6E`; then sleep 100 ms (`:183-221`) |
| DDC read (`imethod_3`) | `0xC0` | `0x7F` | `0x0001` | 0 | N+1 | IN: `[status][N reply bytes starting 6E]`; the first byte is dropped; then sleep 50 ms (`:142-181`) |
| ISP-RTK write (`imethod_0`) | `0x40` | `0xAB` | `(reg<<8)|0x94` | 0 | len-2 | register values (`:108-119`) |
| ISP-RTK read (`imethod_1`) | `0xC0` | `0xAA` | `(reg<<8)|0x94` | 0 | len | IN: the first byte is dropped (`:43-53`, `62-69`) |
| ISP-MTK write | `0x40` | `0x7B` | mode (`DeviceData.ushort_0`: 0,1,3,`16+16k`,`|0x80`) | 0 | len | `[addr, …]` (`:95-107`, `ML/Interface14.cs:122-135,234-266`) |
| ISP-MTK read | `0xC0` | `0x7A` | mode | 0 | len | IN (`:31-42`) |

On failure a request is retried up to 3 times with `Sleep(177)` between tries.

---

## 6. Other hub-side OTA devices (`EnumerateOtherOTADevices`, `ML/Class2.cs:65-154`, `ML/Class20.cs`) (CONFIRMED)

The Philips path uses the `dictionary_1` table (`ML/Zeasn.Monitor.Lib.Utils/OtherOTAUtil.cs:38-136`), keyed by `(VID<<16)|PID`:

| Type | IDs |
|---|---|
| Camera "AVC" | `174F:11CB/11CC/11CD` |
| Camera "HopWin" | `2EF4:520B/5078` |
| Camera "Altek" | `143C:0021` |
| Camera "Chicony" | `04F2:B79E` |
| Camera "JX" | `1E08:5022` |
| Audio "RTK" | `0BDA:4C6C/4C74/4C79/4C85/4CBA` |
| Composite audio | `0BDA:411F` |
| PD | `0BDA:5450` |
| PowerSensor2 "ENE" | `0CF2:A202` |
| USB hub (VIA) | `0552:1003-1006` |
| USB hub (RTK) | `0552:1110/1111` |
| USB hub (Genesys) | `0552:1202/1203` |

The AOC table (`dictionary_0`) holds `05F6:1003/1004` (VIA), `05F6:1110/1111` (RTK) and `2EF4:520B`. The user's `2109:*` hubs match none of these.

For cameras, audio, VIA hubs and Genesys hubs, **the update runs a vendor EXE extracted from the downloaded ZIP**, e.g.:
* camera: `exe /s`
* audio: `exe /VID_xxxx /PID_xxxx -USB -f:*.rfw` (elevated)
* Genesys hub: `exe "/mu=<level>&hub=<bin>"`

These must be dropped on Linux.

---

## 7. Firmware update ("DisplayFW")

### 7.1 Bridge API (CONFIRMED; the envelope is described in 05-backend-host.md)

`DC/Bridge.Lib/Bridge.Lib/Bridge.cs:324-352` → `SystemOper` (`DC/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs:1116-1144`) → `PHLDisplayFW` (`DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/PHLDisplayFW.cs`).

| functionName | parms | Result `JsonResult` |
|---|---|---|
| `DisplayFW_CheckUpstreamCable` | – | `Tag: bool` (any of VIA/RTK/Genesys present) (`:114-120`) |
| `DisplayFW_GetMonitorCount` | – | `Tag: int` = (USB monitors) + (OS displays whose simplified name matches no USB monitor). Special case: when there is exactly one of each and the EDID name maps to the factory name through `%APPDATA%\evnia\MonitorInfo.json` `Monitors[].{Name,FactoryModelNames}`, `Tag=1`; when there is one of each and they do *not* map, `Tag` is left unset (`:122-183`, `510-554`) |
| `DisplayFW_GetDeviceList` | – | `Tag: MonitorInformation[]` with `{ShowName, StrFwVersion ("V"+Version), FwVersion (int, "V1.01"→101), ScalerModelName, ScalerBomInfo, UsbHubCount:0, DeviceType (1=Monitor), AdmWarning}` plus one entry per other OTA device and per matching ENE Ambiglow. `err_code`: `-536739837` (`0xE0020003` NoDisplays), `-536739838` (`0xE0020002`, more than one USB monitor), `-536735736` (`0xE0021008` NotReady), `-536739836` (`0xE0020004` WrongUpstreamCable; `err_msg` = display name), `-536858613` (`0xE000300B` update running) (`:185-268`) |
| `DisplayFW_UpdateFirmversion` | `scalerModelName: string, deviceType: int, fwFile: string` (local path, must end `.ZIP`) | Blocks until done. `err_code` = `ErrorCode` (uint cast to int), 0 on success. Every 2 s it sends notification `FirmwareUpdateProgressData` `{Name:"Update Firmware Progress", Type:"OSD", Value:<0..100>}` (`:270-435`). Before starting, it calls `CUSBENE6K7732.UnPlug()` (ENE Ambiglow) (`:377`). |
| `DisplayFW_InstallDriver` | `type, exePath` | stub, `err_code 0` (`:404-410`) |
| `DisplayFW_FWUpdateFailedNextTime` | `flag: int` | **Debug fault injection**: sets `MonitorService.ISPForceFailedStep` (decompiled as `int_0`, INFERRED rename), which forces the ISP to fail at step `flag`; `Class20` refuses any other OTA while it is non-zero (`:412-419,457-460`; `ML/Interface8.cs:445-582`; `ML/Class20.cs`) |

For `deviceType==1` (monitor), `UpdateFirmversion` requires:
* `fwFile.Contains(scalerModelName)`,
* exactly one USB monitor, and
* `ModelName.ToUpper().Contains(GetSimpleName(scalerModelName))` (`:329-354`).

The USB monitor list excludes `ScalerType.Unknown` and the combination MTK behind an RTK hub (`:474-481`).

### 7.2 Renderer flow and online part (CONFIRMED; see also 01-electron-main.md)

In `AP/renderer/assets/styles-DAnQi2A8.js`:
* `getMonitorFwList` calls `DisplayFW_GetDeviceList` (`:8400-8411`).
* For each entry, `Mv()` (`:33075-33107`) sends `GET https://deviceportal.zeasn.tv/direct/component/update` with query:
  * `brandId=74` (monitor, `dpExternalBrandId`; `134` otherwise)
  * `components=<ScalerBomInfo>=<FwVersion>`
  * `deviceType=<ScalerModelName>`
  * `language`, `push=true`, `ScalerIC=true`
  * **`ruleMac=<PC MAC address>`**
  * `ruleUSBHubCount`
  * header `Authorization: ZAuth …` (HMAC-SHA1 with an embedded key, `Fm()` at `:13343-13347`)
* The response is `[{friendlyVersion, url, description, hashMethod, hashValue, versionName}]`.
* The download goes through the main-process download manager (`AP/main/index.js:16503-16560`) to `%TEMP%\evnia-Download\`, with an md5 check (default) against `hashValue`.
* Then `fwBurning` calls `DisplayFW_UpdateFirmversion(scalerName, type, path)` (`styles-DAnQi2A8.js:33999-34025`), deletes the ZIP, and shows "UpgradeSuccess", "RestartMonitorTip" or "RestartComputerTip".
* The UI is shown only if `OTAEnable && MonitorInfo.json[model].SupOTA` (`:9385-9387`).
* `MonitorInfo.json` itself is refreshed from the same API (`deviceType=PhilipsMonitorsOTA`, `componentId=PrecisionCenter_Monitors_OTA_JSON`, `AP/main/index.js:13507-13540`). The Electron log shows `PCenter_MonitorInfo_v34.json` being downloaded (`%APPDATA%/evnia/logs/26-09-25.log`).

### 7.3 Package format and pre-checks (CONFIRMED)

* **Archive** (`ML/Class0.cs:48-120,413-424`). It is a ZIP if the extension is `.zip` and the first two bytes are "PK" (the code compares the string `"8075"`). It is a RAR if the extension is `.rar` and the first bytes are "Ra" (`"8297"`). It is extracted with SharpCompress into `<zipdir>\FirmwareExtract\`, and the first `*.bin` found (recursively) is used. A bare `.bin` is used directly.
  * AI variant: for devices with `AIStartBank != 0` and names ending in `AI.ZIP`, the non-`.AI` `.bin` is the main image and the `.AI` `.bin` is the AI image (`ML/Interface0.cs:526-564`).
* **`CheckFileBeforeFirmwareUpdate`** (`ML/Zeasn.Monitor.Lib.ScalerFW.Devices/IMonitorDevice.cs:34-94`):
  1. `IsReadyForFirmwareUpdate` must be true.
  2. The bin **file name must contain `ModelName`**.
  3. If not overridden and `DualImageBank != 0`: `FWBase = DualImageBank * 0x10000`. For the user's monitor this is `0x40 * 0x10000 = 0x400000`.
  4. The file is read into a 32 MiB buffer. It must be at least 1024 bytes. The size is rounded up to a multiple of 1024, padding with `0xFF`.
  5. `EndBlock = FWBase/0x10000 + size/0x10000` must be at most 255 (16 MiB address space).
* The image carries **no header or signature**: it is a raw SPI-flash image for one bank (INFERRED from the code, which copies bytes 1:1 to flash at `FWBase + offset`).
* Note that `WriteData` programs `size/0x10000` whole blocks (integer division). A tail that is not a multiple of 64 KiB **would not be written** (CONFIRMED arithmetic, `ML/Interface7.cs:2103-2110`). It is INFERRED that real images are block-aligned.

### 7.4 ISP state machine (`Interface8.method_0`, `ML/Interface8.cs:445-582`) (CONFIRMED)

`FirmwareUpdate` (`ML/Interface8.cs:41-71`):
* Holds `SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_DISPLAY_REQUIRED)` (`ML/Zeasn.Monitor.Lib.Services/SleepPreventService.cs:89-99`).
* Runs the pre-checks, fires `OTAStateChanged(true)`, runs `method_0`, then fires `OTAStateChanged(false)`.

The steps are `imethod_14..23`. The implementation names follow in the same order (INFERRED mapping, consistent with the log texts):

| # | Impl. name | RTK meaning (`ML/Interface7.cs`) | Retry | Progress |
|---|---|---|---|---|
| 1 | `ELkwJh5b3Y` | "ISPFlow start" (VIA-RTK: burst 256; RTK-RTK: `RH_HidI2CConfig(h,0x94,1,1)` + burst 128; Genesys-RTK: ISPRTK mode + burst 128) | – | – |
| 2 | `qX7wEmicDf` | EnterISP | – | – |
| 3 | `IkCw0RKGDV` | SetDefaultValue + DetectFlashType | – | 2, 3 |
| 4 | `hCUwwY1jeh` | Disable flash WP (HW GPIO + status register) | – | – |
| 5 | `qFtw7yiirv` | no-op | – | – |
| 6 | `msmwU19LKH` | Erase boot-flag sector ("Clear Data") | ×3 together with #7; continues even if all fail | 6 |
| 7 | `TdOwLOO94q` | no-op | ↑ | – |
| 8 | `w2jwOCQWwO` | WriteData (all blocks) + WriteBootFlag ("Program Data") | ×3; continues even if all fail | 6→96, 97 |
| 9 | `SSWwDfT6Ua` | Enable flash protection | – | 99 |
| 10 | `L7LwxYajoh` | Reset | – | 100 |

* **Resume:** if the previous run failed at a step greater than 5 (`MonitorService.ISPFailedStep`), steps 1-5 are skipped.
* **Final result:** `Error` if any step recorded a failure, even when later steps succeeded.

### 7.5 Realtek ISP register protocol (slave `0x94/0x95`) (CONFIRMED sequences from `ML/Interface7.cs`)

Notation: `W r=v` is a register write `[0x94, r, v]`; `R r` is a 1-byte register read; `P r&m==e (t s)` is a poll with timeout in seconds.

```
EnterISP (imethod_29, :274-301)
  W 6F=80 ; P 6F&80==80 (3s) ; W F4=9F ; W F5=06 ; W F4=A0 ; W F5=74
SetDefaultValue (imethod_30, :303-370)
  W 1B=02, 1C=30, 1D=1C, 1E=02, 1F=00, 20=1C, 2C=02, 2D=00, 2E=1C,
    62=06, 63=50, 6A=03, 6B=0B, 6C=00, ED=88, EE=04
DetectFlashType (imethod_31, :372-445)
  W 60=46 ; W 61=9F ; W 60=47 ; P 60&01==0 (10s) ; R 67,68,69 -> JEDEC ID (mfr,type,cap)
  W 60=5A ; W 61=AB ; W 64=00 ; W 65=00 ; W 66=00 ; W 60=5B ; P 60&01==0 ; R 67 -> RES byte
Flash status-register policy (Interface8.imethod_9/10, ML/Interface8.cs:19-39):
  JEDEC C84015 -> 0x180 and "special" (only SR1 path used); C84016 -> 0x180; EF4018 -> 0x100;
  852016 -> 0x40180; default -> 0x080.   bit 0x80=SR1 (op 01), 0x100=SR2 (op 31), 0x40000=SR3 (op 11)
Write status register (imethod_38/39/40 disable, 46/47/48 enable, :1852-1937, :2301-2386)
  [DisableFlashHardwareWriteProtection()] ; W 60=68 ; W 61=op ; W 64=val ; W 60=69 ; P 60&01==0 (3s; enable SR2/SR3: 255s)
  disable: val=00 for all ops.  enable: SR1 val=FF (!), SR2/SR3 val=00
Erase 64 KiB block b (imethod_41, :1939-1970)
  W 64=b ; W 65=00 ; W 66=00 ; W 60=B8 ; W 61=D8 ; W 60=B9 ; P 60&01==0 (30s)
Erase 4 KiB sector (imethod_42, :1972-2003)
  W 64=b ; W 65=s ; W 66=00 ; W 60=B8 ; W 61=20 ; W 60=B9 ; P 60&01==0
Hardware CRC-8 (imethod_44, :2018-2063)
  W 64=startBlk ; W 65=startPage|0 ; W 66=startByte|0 ; W 72=endBlk ; W 73=endPage|FF ; W 74=endByte|FF
  R 6F -> v ; W 6F=(v&FB)|04 ; P 6F&04==0 (30s) ; R 75 -> crc
Program block b (WriteData, :2103-2224), L = burst (VIA 256, others 128)
  W 6D=02 (page-program opcode) ; W 71=L-1
  for page 0..255, for off in 0..255 step L:
     W 64=b ; W 65=page ; W 66=off ; P 6F&10==10 (3s)
     W 70=<L bytes>   (single burst [0x94,0x70,data...], VIA splits into B7/B8/B9)
     W 6F=A0 ; P 6F&20==0 (3s)
  verify: CRC8(image block) == hardware CRC(b..b)
Erase check: erased 64 KiB block CRC must be 0xDE; erased boot-flag sector (16 pages) must be 0x09
Boot flag (imethod_45, :2226-2275)
  W 6D=02 ; W 71=01 ; addr = BootFlagAddress (default 00:70:00) -> W 64,65,66 ; P 6F&10==10
  W 70=AA 55 ; W 6F=A0 ; P 6F&20==0
Reset (:2388-2397)
  R EE -> v ; W EE=(v&FD)|02     (failure ignored when the "ignore reset" flag is set - true for VIA-RTK)
Read one flash byte (debug, imethod_50, :2425-2468)
  W 6F=80 ; W 60=46 ; W 61=03 ; W 64..66=addr ; W 6A=03 ; W 60=47 ; P 60&01==0 ; R 70
```

**Erase boot-flag sector** (`EraseBootFlagSector`, `:2065-2101`). With BootFlagAddress `A`:
* block = `A>>16`, sector start page = `(A>>8)&0xF0`, end page = `(A>>8)|0x0F`.
* Erase the 4 KiB sector, then check the CRC is `0x09`.
* This is skipped when there is no boot-flag address or `FWBase==0`.

**Safety design** (INFERRED): the boot flag is erased first and written (`AA 55`) last, into the *inactive* bank selected by `DualImageBank`. An interrupted flash therefore leaves the old bank bootable.

**CRC-8 on the host** (`Util.smethod_6`, `ML/Zeasn.Monitor.Lib.Utils/Util.cs:129-152`): polynomial `0x07`, init `0x00`, MSB-first, no reflection, no final XOR. It was re-implemented and checked: 64 KiB of `0xFF` gives `0xDE` and 4 KiB of `0xFF` gives `0x09`, matching the constants in the code (CONFIRMED).

**Hardware write-protect release** (`DisableFlashHardwareWriteProtection`, `ML/Interface7.cs:447-525`) is chip-specific. Registers `F4`/`F5` form an indirect page/register port: `F4=9F`, `F5=page`, `F4=reg`, `F5=data`.
* The user's `RTD2738VL` matches `(RTD2738)|(RTD2739-YUF-CG)`, which selects **`method_9`** (`:1552-1625`):

```
W F4=9F ; W F5=10 ; W F4=9B ; R F5 -> v ; W F4=9F ; W F5=10 ; W F4=9B ; W F5=(v&F0)|01
W F4=9F ; W F5=22 ; W F4=3B ; R F5 -> v ; W F4=9F ; W F5=22 ; W F4=3B ; W F5=(v&FE)|01
```

  This reads as: pin-mux page 0x10 reg 0x9B selects GPIO, and page 0x22 reg 0x3B drives the WP pin high (INFERRED).
* Other scaler names select `method_1..12` or `imethod_33..37` (the same shape with other page/register pairs).
* The default is `imethod_32`, which uses flash-ID-dependent registers from `Class28.smethod_0` (`ML/Class28.cs`):

| Flash ID | Registers |
|---|---|
| GD `C8401413` | `12`/`02` |
| MX `C2201615` | `64`/`54` |
| MX `C2201514` | `29`/`19` |
| default | `29`/`19` |

**Relation to public knowledge** (INFERRED, external): the `0x4A` slave with registers `6F/60/61/64-66/67-69/6A/6D/70/71/75` is the same Realtek "MST ISP" interface driven by flashrom's `realtek_mst_i2c_spi` programmer. That programmer is a useful reference for a Linux implementation.

### 7.6 Other scaler families (summary, not the user's)

* **MTK/MStar** (`ML/Interface5.cs`):
  * Serial-debug slave `0xB2/0xB3`, entered via GPIO/WP helpers `method_1..8` chosen by scaler name (MST9U, TSUM*, MT97xx/98xx).
  * ISP slave `0x92/0x93`, entered with `92 4D 53 54 41 52` ("MSTAR") sent twice (`:278-292`).
* **NTK/Novatek** (`ML/Interface6.cs`): McuID, IIC channel, flash ID, block protect, erase, bulk program, page checksum, ID sector, valid/invalid flags (see the `Fail_ISPFlow_NTK_*` codes in `ErrorCode.cs:122-141`).
* **HVW-6315/7315** (`ML/Interface3.cs`, `ML/Interface4.cs`): OTA through DDC/CI vendor opcode `0xC6` with sub-commands `E2` (lock), `E3` (version, part A/B, chip), `E4` (get OTA part), `E5` (start), `E6` (write AUX), `E7` (done), `E8` (check), `EA` (reboot), `EB/EC` (superblock `{magic,type,length,offset,crc,blockLength,version[12]}`, `ML/Zeasn.Monitor.Lib.ScalerFW.Constants/SuperBlock.cs`), `ED` (CRC). Example: `6E 51 83 C6 E2 <0|1> cs`, with the reply needing `r[5]==0xE0` (`ML/Interface3.cs:280-318`).
* **`ExecOTAConfig`** (`ML/Class1.cs`): an INI-script interpreter (`RTKWrite`, `RTKRead`, `MTKWrite`, `…Variable`) that can override the WP-release sequence. It is debug only.

### 7.7 Settings strings (`MonitorService.SetSetting`, `ML/Class45.cs:110-154`) (CONFIRMED)

| String | Effect |
|---|---|
| `PHILIPS` | Always set by `CDevice_PHLDisplay` (`…/CDevice_PHLDisplay.cs:136`) |
| `AOC` | AOC BOM/ID tables |
| `DEBUG_MODE` | Verbose I2C logging; 3× poll timeouts |
| `DEMO_MODE` | Logs every DDC read and write |
| `VIA_FUNCTION A3` / `VIA_FUNCTION A7A9` | Default A7A9 (VIA read mode for capabilities) |
| `DISABLE_CHECK_SUM` | Skip the DDC reply checksum |
| `FUNCTION_RESULT_HANDLER_MODE xxxx` | Size of the error-history ring |

---

## 8. Linux port plan (this area)

### 8.1 Recommended architecture

```
ddc-core (shared)        : frame build/verify (§3.1-3.3), VCP get/set, E2A0 extended, caps (§3.5),
                           TPV FE-page queries (§3.4), timing (§8.4), per-monitor mutex
 ├── transport i2c-dev   : /dev/i2c-N from DRM connector (other report); same bytes, addr 0x37
 ├── transport via-usb   : libusb, 2109:xxxx vendor device (the user's path)
 ├── transport rtk-hid   : hidraw 0BDA:1100 (optional)
 └── transport gl-usb    : libusb, Genesys hub 05E3:xxxx (optional)
monitor-registry          : pairs a USB bridge to a DRM connector via EDID name/serial (§3.7)
fw-update (OPTIONAL, off) : offline Realtek ISP over via-usb only, local file, expert gate
```

Transport priority: try USB if `IsSupportUsbDDC` (the VCP `0x14` probe passes), otherwise i2c-dev, as the Windows app does. Note that `ddcutil --usb` implements the USB *HID Monitor Control* class, which is **not** this protocol. A custom back-end is needed.

### 8.2 VIA back-end (priority: this is the user's monitor)

1. **Enumerate.**
   * `libusb_get_device_list`, keep `idVendor==0x2109 && bDeviceClass != 0x09` (not a hub). The user's device is `2109:8884`.
   * Optionally match the hub topology: the bridge sits on a port of a `2109:2817`/`0817` hub.
2. **Open.**
   * Call `libusb_open`.
   * All requests are *vendor, recipient=device* on EP0. Linux usbfs allows these without claiming an interface (only interface- and endpoint-recipient requests need a claim). No kernel-driver detach is needed.
   * If `lsusb -v` shows an interface bound to some kernel driver, still do **not** detach it; device-recipient EP0 requests work regardless. (INFERRED from usbfs `check_ctrlrecip` behaviour; verify on hardware.)
3. **Probe.** Send `GetVCP(0xC8)` and require `SL==0x09` (Realtek scaler), then `GetVCP(0x14)` with the §3.6 rule, then read ModelName (FE E9 0D) and SN (FE EF 13 00 20).
4. **Transactions** (`timeout_ms` 1000 is suggested; Windows uses the WinUSB default):

```c
int via_write(libusb_device_handle *h, const uint8_t *buf, uint16_t n) {          // buf[0]=0x6E
  return libusb_control_transfer(h, 0x40, 0xB2, 0, 0, (uint8_t*)buf, n, 1000);
}
int via_read(libusb_device_handle *h, uint8_t addrR, uint8_t *buf, uint16_t n) {   // addrR=0x6F
  return libusb_control_transfer(h, 0xC0, 0xA3, 0, addrR, buf, n, 1000);
}
// long read (caps, "A7A9"): A7(wIndex=0x6F,32) then A9(wIndex=0,32)
// long write (>32B): B7(first 2 bytes) , B8(32B chunks) , B9(last chunk, may be 0 bytes)
```

5. **Retry policy** (as on Windows): 3 attempts, with `(n+1)*177` ms between attempts, and 3 attempts at the `GetStandardData` level.

### 8.3 Realtek HID and Genesys back-ends (optional; no hardware to test with)

**Realtek (`0BDA:1100`):**
* Open `/dev/hidrawN` where `HIDIOCGRAWINFO` gives vendor `0x0BDA`, product `0x1100`.
* Read the report descriptor (`HIDIOCGRDESC`) to learn `OutputReportByteLength` and `InputReportByteLength`.
* Build the report as in §5.1: `[0x00][11-byte header zero-padded to 64][payload]`, total `OutputReportByteLength`.
* Send it with **`ioctl(fd, HIDIOCSOUTPUT(len), buf)`**. This is a control `SET_REPORT(Output)`, matching `HidD_SetOutputReport`; plain `write()` may use an interrupt OUT endpoint instead.
* For reads, use **`ioctl(fd, HIDIOCGINPUT(len), buf)`** with `buf[0]=0`, which matches `HidD_GetInputReport`.
* Both ioctls need Linux ≥ 5.11.
* Alternative with libusb, after claiming the HID interface and auto-detaching `usbhid`:
  * `SET_REPORT` = `21 09 0200 <ifnum> <len>`
  * `GET_REPORT` = `A1 01 0100 <ifnum> <len>`
* DDC header example: `40 C6 51 00 00 00 LL 00 6E 01 80`, payload = frame without `6E 51`.
* **Never** send VD commands to arbitrary HID devices (§5.1). Match on VID:PID only.

**Genesys (`05E3:*` hub):**
* `libusb_open` the hub device. Do **not** detach the `hub` driver.
* Send vendor device-recipient requests on EP0: open `C0 C1 0300 0000 0001` then 500 ms; write `40 7C 0000 0000 N`; read `C0 7F 0001 0000 N+1` (drop byte 0).
* No filter driver is needed on Linux.
* Identify the Genesys hub whose downstream port hosts the monitor. The Windows SDK uses location ports; on Linux, use sysfs topology.

### 8.4 Timing to reproduce (CONFIRMED values)

| Point | Value |
|---|---|
| After a DDC write | ≥ 100 ms (write helper) plus ≥ 15 ms before the read |
| After a DDC read | 50 ms |
| Get round trip | ~185 ms |
| Set | ~110 ms |
| Genesys open | 500 ms |
| ISP polls | 2 ms interval; timeouts 3/10/30/255 s as listed in §7.5 |

Serialize all traffic per monitor (the Windows code uses `MonitorService.MonitorLock`). Also keep USB-DDC and i2c-dev from hitting the same scaler at the same time.

### 8.5 udev / permissions (suggested)

```
# /etc/udev/rules.d/70-evnia-usbddc.rules
# VIA Labs I2C bridge inside Philips Evnia hubs (user's monitor)
SUBSYSTEM=="usb", ATTR{idVendor}=="2109", ATTR{idProduct}=="8884", TAG+="uaccess", ATTR{power/control}="on"
# Realtek hub HID I2C bridge (optional)
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="1100", TAG+="uaccess"
# Genesys hubs (optional; broad - consider restricting by PID/topology)
SUBSYSTEM=="usb", ATTR{idVendor}=="05e3", ATTR{bDeviceClass}=="09", TAG+="uaccess"
```

* `uaccess` gives the logged-in seat user access to `/dev/bus/usb/BBB/DDD`.
* `power/control=on` avoids autosuspend stalls on the bridge (INFERRED as useful).
* No root and no helper binary is needed (unlike Windows, where `elevate.exe` or the filter driver was used).
* fwupd ships plugins for VIA (`vli`), Genesys (`genesys`) and Realtek MST, and it may open the same devices. Serialize with it or document the conflict (INFERRED, external).

### 8.6 Firmware update on Linux (recommendation)

**Default: do not implement.**
* There is no offline source of firmware. Images are only obtained from the Zeasn portal (§9).
* A failed or wrong flash can brick the scaler.
* The host verifies only md5 plus per-block CRC. It does not verify any vendor signature.

If the maintainer insists, gate it behind an explicit expert flag and support **only VIA-RTK/RTD2738** (the tested path):
1. The user supplies a local `.zip` or `.bin`. Apply §7.3: the name contains `ModelName`, the BOM 5th char is `'P'`, the size is at least 1 KiB, 1 KiB padding, block alignment, and `EndBlock ≤ 255`.
2. Read `DualImageBank`, `BootFlagAddress` and `ScalerName` (§3.4). Refuse if `ScalerName !~ RTD2738|RTD2739-YUF-CG` or `DualImageBank==0`.
3. Hold `systemd-inhibit --what=sleep:idle:shutdown`. Warn about cable and power stability.
4. Run §7.5 exactly: EnterISP, SetDefault, Detect (refuse unknown JEDEC IDs), WP release (`method_9`), SR clear, erase boot sector plus CRC `0x09`, per block (erase, CRC `0xDE`, program, CRC match), boot flag, SR re-protect, reset.
5. **Stop** on the first failure. Do not continue as the Windows code does (§7.4). Keep the old bank's boot flag untouched.
6. Never implement `FWUpdateFailedNextTime` (fault injection), hub/camera/audio/PD updates (they run vendor EXEs), or Genesys `UpdateFw`.

---

## 9. Online touchpoints (this area)

| # | What | Where | Trigger | Endpoint | Recommendation |
|---|---|---|---|---|---|
| 1 | Firmware availability check (sends BOM, version, model, **MAC**, hub count; signed `ZAuth`) | `AP/renderer/assets/styles-DAnQi2A8.js:33075-33107` (`Mv`), called from `Ry().getMonitorFwList/upgradeDetect` (`:33789-33870`) | Opening the firmware page; `navigator.onLine` | `GET https://deviceportal.zeasn.tv/direct/component/update?brandId=74&components=<BOM>=<ver>&deviceType=<model>&push=true&ScalerIC=true&ruleMac=<mac>&ruleUSBHubCount=…` | **Strip.** Remove the UI or replace it with "import local firmware file" (expert mode only). |
| 2 | Firmware package download + md5 check | `AP/main/index.js:16503-16560` (`createDownload`), renderer `Sy()` `:33564-33600` | The user clicks update | `url` from #1 (Zeasn CDN, e.g. `gcdn.zeasn.com`, INFERRED from the setup download in the Electron log) | **Strip.** |
| 3 | `MonitorInfo.json` refresh (`SupOTA`/`SupUsbDDC`/`FactoryModelNames` table) | `AP/main/index.js:13507-13540` | App start | Same component API, `deviceType=PhilipsMonitorsOTA`, `componentId=PrecisionCenter_Monitors_OTA_JSON` | **Strip**; ship a static table (see 01-electron-main.md). |
| 4 | Genesys driver install tool | `ML/Class3.cs:94-146` | Genesys hub present and filter driver missing | none (local EXE, elevated) | **Drop** (not needed on Linux). |
| 5 | Other OTA device updates run EXEs from downloaded ZIPs | `ML/Class20.cs` | UI update for camera, audio or hub | none directly (package from #2) | **Drop.** |

The backend's USB-DDC and ISP code itself makes **no network access** (CONFIRMED).

---

## 10. Open questions

1. **`2109:8884` descriptors.** What are its device/interface class (vendor 0xFF, Billboard 0x11, HID…), `bcdDevice`, and does any Linux kernel driver bind to it? Run `lsusb -v -d 2109:8884` and `lsusb -t` on the user's machine. What is the role of `2109:0211`?
2. **VIA request semantics.** Are `0xA3/0xB2` really "complete transaction", `B7/B8/B9` "start/continue/stop", and `A7/A8/A9` "start/ACK/NACK"? A usbmon capture of one Windows `GetVCP` and one capabilities read would settle it. Is there any clock-stretching or timeout limit in the bridge?
3. **Realtek HID.** What are the report lengths (`HidP_GetCaps`) of `0BDA:1100`, and what exactly does `memLen` (0/1/2) mean? Does the RTK firmware insert `0x51` itself (DDC mode)? Why does the PD path pass `addr=0xAC` with `memLen=1`?
4. **Genesys status byte.** What is the meaning of the first byte returned by `0x7F`/`0xAA` IN transfers, and of the open request `C1 wValue=0x0300`?
5. **TPV "FE" page reply layout.** What do reply bytes `r[2..4]` mean, and when is `r[5]==0` (the pad-byte rule in `imethod_8`)?
6. **Capabilities termination.** Does the monitor always send at least 26 data bytes per fragment? If not, the vendor's stop rule truncates early. Prefer "empty fragment".
7. **Firmware image alignment.** Are Philips `.bin` images always a multiple of 64 KiB? If not, the vendor tool silently leaves the tail unprogrammed (§7.3).
8. **SR1 re-protect with `0xFF`** (`imethod_46`). Does this set BP bits (and possibly SRP) that later updates depend on clearing via `imethod_38`? The behaviour is inherited; confirm it is safe for the actual flash (JEDEC ID unknown for this monitor; it would be logged by `[RTK Scaler] FlashID`).
9. **Direct I2C alternative.** Is the RTD2738 ISP slave `0x4A` also reachable over the GPU DDC bus (`/dev/i2c-N`, as flashrom does for MST parts)? That would allow a transport-independent flasher (INFERRED; not tested; risky).

---

## 11. Cross-references (outside this area)

* **DDC/CI over GPU I2C** (`DDCHelperLib.dll`, `NewDDCOper`, `Zeasn.DDC.Lib`): the fallback path and the source of `DDCDisplayInfo`. It shares frames with §3. It also covers the VCP code and `E2A0_ExternVCPOpCode_E` semantics (`AttributeInfo`, `DataOSD.InitDisplayVcpCode`). See the DDC/monitor-control report.
* **Envelope and notifications** (`JsonResult`, `Notification` events, `FirmwareUpdateProgressData`): 05-backend-host.md.
* **`Config\data.json`** (HMAC-signed VCP/capabilities cache keyed `"<version>_<input>"`, e.g. `v1.01_0f`, built from `Display.method_0` using `GetVCP(0x60)` over USB): 05-backend-host.md and `DC/.../Display.cs:202-252`.
* **Electron download manager, patch/resource update, and `MonitorInfo.json` handling**: 01-electron-main.md.
* **ENE Ambiglow** (`CUSBENE6K7732`, `EneEc.dll`): unplugged before a monitor OTA (`PHLDisplayFW.cs:377`). Ambiglow firmware entries are added to `GetDeviceList` (`:500-507`). See the ENE/lighting report.
* **Peripheral firmware updates** (mouse/keyboard `runCommand` of extracted EXEs, renderer `fwBurning` non-monitor branch, `styles-DAnQi2A8.js:34027-34055`): peripheral reports.
* **EDID parsing** (`MonitorUtil.EDID256Block`, `smethod_10`) and display enumeration on Linux (DRM connectors): display/DDC report.
