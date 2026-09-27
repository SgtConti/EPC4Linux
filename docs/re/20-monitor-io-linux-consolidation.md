# 20 - Consolidated Linux monitor I/O spec: transport, identification, DispalyData strings, HDR flag, hotplug, ENE presence

Scope: the Philips Evnia 34M2C8600 on the user's machine, monitor-only port (no peripherals, no OTA), GNOME Wayland and X11, `.deb`. This report resolves the disagreements between 06, 07 and 08, and fills the gaps they left open. It extends them; it does not repeat their full content.

## Conventions

Evidence labels:

- **C** = CONFIRMED: read in code, or seen in the user's logs, profile or cache.
- **I** = INFERRED: reasoned from code, logs or naming; the reason is given.
- **L** = Linux or USB platform knowledge that is not in the corpus. Treat it as INFERRED until the checklist in §7 has been run.

Path prefixes (the same as 06, plus a few new ones):

| Prefix | Path |
|---|---|
| `DC/` | `work/dotnet-clean/` |
| `ML/` | `DC/Zeasn.Monitor.Lib/` |
| `PB/` | `DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/` |
| `EB/` | `DC/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/` |
| `EO/` | `DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/` |
| `PHL/` | `DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/` |
| `WL/` | `DC/Zeasn.Win.Lib/Zeasn.Win.Lib/` |
| `SO` | `DC/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs` |
| `NAT` | `work/native/DDCHelperLib.dll.c` |
| `AM` | `work/app-pretty/main/index.js` |
| `RA/` | `work/app-pretty/renderer/assets/` |
| `LOG25`, `LOG26` | `%APPDATA%/EvniaServe/logs/2026-09-25.txt` (app 1.11.0) and `2026-09-26.txt` (app 1.13.0) |
| `ELOG25`, `ELOG26` | `%APPDATA%/evnia/logs/26-09-25.log`, `26-09-26.log` |
| `PROF` | `%APPDATA%/EvniaServe/Theme/User/Default.pcenter` |
| `CACHE` | `%APPDATA%/EvniaServe/Config/data.json` |

---

## Summary (the decisions)

| # | Question | Decision | Basis |
|---|---|---|---|
| D1 | Transport order | Default `auto`: **VIA USB-DDC (`2109:8884`) first, i2c-dev on the DP-AUX adapter as fallback**. The chosen transport stays in use ("sticky") and is switched only after an operation has used up its whole retry budget. A setting `ddc.transport = auto \| usb \| i2c` overrides the choice. | Windows used the hub for 100 % of runtime traffic with zero failures. The USB path works whichever video input is active, and Ambiglow needs the same USB cable anyway (§2.1) |
| D2 | Concurrency | One async mutex per monitor. It covers **both** transports and every single transaction (write, then wait, then read). A single-flight queue serialises the multi-step `PHL_*` sequences on top of it. The two transports are never used at the same time. | Windows shares one lock between both paths (`CDevice_PHLDisplay.cs:133,137`) C |
| D3 | Reply parsing | Parse relative to the length byte on both transports. The last 4 payload bytes are max and current. Read 32 bytes for every get and 38 (i2c) or 64 (USB) for capabilities. | `ML/Interface2.cs:209-214,254-259` C. Over-reading works on this monitor's GPU path: DDCHelper read 35 bytes for an L=13 reply (§2.6) C |
| D4 | EDID parser | Port **`MonitorUtil.EDID256Block`** (the hub parser) exactly, and use it for every transport. Do not port DDCHelper `GetEDIDOption`. | PROF contains exactly the EDID256Block output (§3.1) C |
| D5 | Decimal separator | `auto` = the decimal separator of the process locale (.NET `CurrentCulture` semantics). The test fixture pins `,` so that it reproduces PROF byte for byte. | The Windows culture used `,` (PROF, and the log `Span Time : 0,1858926`) C |
| D6 | Serial and key | Display key = **EDID 0xFF descriptor serial** (non-ASCII stripped). The factory SN (`FE EF 13`) is only a cross-check. | In 1.13.0 the hub `Display.SN` is the EDID serial (§3.2) C |
| D7 | `MonitorFrequency` | `"<n>Hz"` with an integer `n = floor(exact_rate + 0.005)`. Never a fractional number, because the constraint parser uses `int.TryParse`. | `DisplayFuncConstraints.cs:296-314` C |
| D8 | `IsSmartImageHDR` | Policy **P1 "monitor"**: true when the DC value read from the monitor is in `SmartImageHDR_E` (32..51). Compositor and KMS HDR state are only logged as a cross-check. | Only P1 keeps the Items split, `PHL_SetSmartImage` and the `ParameterToDevice` restore consistent with the monitor (§4) |
| D9 | Hotplug | udev `drm`, Mutter `MonitorsChanged` and RandR events all feed Electron's `handleDeviceChange("displayChange")` (2 s debounce, honours `shieldDisplayChange`). udev/libusb `usb` events feed `USBChange`. `hidraw` events feed `otherDeviceChange`. The backend never starts its own display rescans. | `AM:17234-17242,17650-17683` C |
| D10 | ENE absent on 09-26 | The ENE sits behind the **USB 2.0 half (`2109:2211`) of a second VIA hub** on port 4 of the VL817. On 09-26 only that USB 2.0 half failed to enumerate; its SuperSpeed half (`0211`) and all other devices were present. The "USB cable" hypothesis is ruled out. The "USB standby setting" hypothesis is unlikely, because E2A013 read 1 on both days. | §6 |

---

## 1. Contradiction-resolution table

| # | Topic | What the earlier reports say | Code and log truth | Resolution |
|---|---|---|---|---|
| R1 | Transport priority | 06 §10 (`06:1096-1107`): I2C is the "recommended default"; implement the VIA hub "only if A fails". 07 §8.1 (`07:635`): prefer `I2cDevChannel` whenever the bus is accessible. 08 §8.1 (`08:703`): USB first if the 0x14 probe passes, "as the Windows app does". | Windows tries the hub first on **every call** and falls back to DDCHelper per call (`PB/Display.cs:354-384, 386-413, 415-445, 447-474`) C. All 233 runtime get/set calls went over the hub, none fell back, all returned 0 (07 §7.5; `LOG26:913-993`) C. | D1: USB first, with a sticky choice and a failover rule (§2.2). This replaces the per-call fallback: when the VIA bridge is dead, the vendor pattern would cost about 3.5 s per call before falling back (§2.2). |
| R2 | Hub path "HID" label | 07 Summary item 1 (`07:7`) says the hub path is "Realtek `RhHidAPI.dll` HID-I2C, or Genesys". 07 §8.1 (`07:631`) calls `UsbHubChannel` "the monitor's HID-I2C bridge". 07 §11 (`07:757-762`) groups `RhHidAPI` under "the transport actually used". | The user's hub is **VIA `2109:8884`**, opened with `CreateFile` + `WinUsb_Initialize` (`ML/Interface13.cs:18-51`). It is driven by **vendor control transfers on EP0**: write `40 B2`, read `C0 A3 wIndex=0x6F` (`ML/Interface13.cs:125-158, 271-293`). The logs show `VID: 0x2109, PID: 0x8884` and `Hub-Scaler: VIA-RTK` (`LOG26:157-158`), and RTK and Genesys were "not detected" (`LOG26:148-149`) C. No HID is involved. | `UsbHubChannel` = libusb control transfers to `2109:8884`. There is no hidraw and no RhHidAPI equivalent on this machine. |
| R3 | Source of the `DispalyData` strings | 07 §3.3 (`07:151-170`) gives DDCHelper strings as "34M2C8600 value": `~35"`, `2.2`, `Rx0.688-Ry0.302`… 06 §4.5 (`06:346-384`) describes EDID256Block (`~xx,x"`) but does not say which one reaches the profile. | `CurSN` = `Displays[0].SN` (`EB/GClass3.cs:155-164`). The hub `Display`s are created first (`EB/GClass3.cs:53-57`), so `CurDisplay` is the hub display. Its `MonitorEDID = new DisplayEDIDInfo(eDID256Block)` (`PB/Display.cs:180-190`, `PB/DisplayEDIDInfo.cs:269-285`). `method_4` copies it into `DispalyData.MonitorEDIDInfo_T` (`PHL/CDevice_PHLDisplay.cs:313`). PROF contains `"ScreenSize":"~34,2\""`, `"DisplayGamma":"2,2"`, `"RedChromaticity":"Rx0,689-Ry0,303"`… C. These are EDID256Block outputs; the DDCHelper equivalents would be `~35"` (`NAT:6684-6693`) and `0.688` (`LOG26:327-328`) C. | The byte-visible strings come from **EDID256Block**. The DDCHelper struct is used only for a `Display` built from a DDC-only entry (`PB/Display.cs:192-200`, `PB/DisplayEDIDInfo.cs:251-267`). That never happened on this machine. |
| R4 | Serial-number source | 07 §2 (`07:68`): merge "DDC factory SN against the hub's EDID SN". 06 §4.3 lists the hub `GetSN` (`FE EF 13 00 20`). 08 §3.7: merge by "EDID serial". | **1.13.0:** the hub `Display.SN = eDID256Block.FnSerialNumber` (`PB/Display.cs:183`). `FnSerialNumber` is set by the registry pairing `MonitorUtil.smethod_6 → smethod_8 → smethod_9` (`ML/.../MonitorUtil.cs:1271-1303, 1337-1338, 1350-1360`). `smethod_9` replaces it with `DeviceData.SN` only when that is non-empty. `GetSN` runs later, in `ReadMonitorDetail` (`ML/Interface0.cs:476-498`, `Zeasn.Monitor.Lib/MonitorService.cs:148-160,193-199`). The log order is pairing (`LOG26:162`) before GetSN (`LOG26:368`) C. So the hub SN is the **EDID 0xFF text**. The DDC `DisplaySN` is the factory SN (`FE EF 13`, 7-byte form) if it has at least 13 characters (07 §3.4.2-3) C. The merge compares the two case-insensitively (`EB/GClass3.cs:62`) C. **1.11.0** called GetSN before pairing (`LOG25:166` then `:168`), so there `FnSerialNumber` was the factory SN (I, from log order; the 1.11.0 code is not in the corpus). Both are `AU00000000001` on this monitor C. | D6: key on the EDID 0xFF serial. Read `FE EF 13` once and log a warning if it differs. On Windows a difference would have split one monitor into two `Display`s (a vendor bug). Do not copy that. |
| R5 | EDID parser choice | 06 §10.3 (`06:1110`): "reuse the §4.5 parser" (EDID256Block). 07 §8.4-J (`07:711`): re-implement `GetEDIDOption` and the §3.3 struct "including the `~35"` quirk". | See R3. The renderer never displays `MonitorEDIDInfo_T` (only defaults at `RA/styles-DAnQi2A8.js:9336-9353`). Only `MonitorResolution` and `MonitorFrequency` are shown (`RA/styles-DAnQi2A8.js:14025-14026`) C. | D4: EDID256Block only. Drop `GetEDIDOption`. |
| R6 | i2c bus for a DP connector | 07 §8.2 (`07:648-653`): (a) the `ddc` symlink first, then (b) the connector's child `i2c-N`. | L: on amdgpu the `ddc` link points to "AMDGPU DM i2c hw bus N" (GPIO DDC engine). The connector's child adapter is "AMDGPU DM aux hw bus N" (I2C-over-AUX). A native DP sink only understands AUX. Evidence that the GPU path to this monitor goes over DP AUX: ADL `DDCBlockAccess` worked (`LOG26:345-360`), and EDID byte 20 = `B5` means a digital DisplayPort interface C. | For DP connectors use the **child AUX adapter first** and the `ddc` link second. For HDMI and DVI use the `ddc` link. |
| R7 | Reply strictness | 07 §8.3 (`07:686`) rejects `L > n` ("be strict"), with n = 8. | The hub accepts any `0 < L`, with `L+3 <= readLength`, and parses relative to L (`ML/Interface2.cs:62-75, 209-214`). DDCHelper accepts `L <= n+3` (07 §4.7) C. The length of the extended-reply is unknown (07 Q1, 06 Q1). | D3: accept `1 <= L <= readLength-3`. Parse relative to L. |
| R8 | VIA capabilities read mode | 06 §10 (`06:1104`): "either A3 fragments … or A7+A9". | The default is `VIAFunction.A7A9` (`ML/Class45.cs:100`) C. With A3 (a 32-byte buffer), any fragment with `L > 29` fails the `L+3 <= 32` check (`ML/Interface13.cs:392-393`) C. | Use A7+A9 (64 bytes), which is proven: 6.7-6.8 s per read (`LOG26:370`). |
| R9 | HDR flag on Linux | 06 §10.6 (`06:1122-1124`): (a) derive from DC or (b) use DRM/compositor. 03 B9: compositor/KMS or `OP_DC >= 32`. | Windows reads the OS advanced-colour state of the output whose friendly name equals `CurDisplay.MonitorName` (`WL/CWinSysDisplayHDR.cs:431-457, 594-609`, `EB/GClass3.cs:356-364`) C. On the user's machine the OS state and DC agreed (DC=0x21 with HDR on, `LOG26:909-913`, PROF) C. | D8: P1 (derive from DC) is the default (§4). |
| R10 | Refresh-rate string | Not specified (06 §10.7: "from DRM/KMS … only needed for display and the MBR rule"). | `dmDisplayFrequency + "Hz"` is an integer (`WL/CWinSysDisplay.cs:554`, `WL/DEVMODE.cs:51`). The constraint rule parses it with `int.TryParse(s.ToLower().Replace("hz",""))`, where a failure gives 0 and so `hz<75` (`EO/DisplayFuncConstraints.cs:127-128,157, 296-314`) C. | D7 (§3.5). |

---

## 2. Linux transport policy

### 2.1 Comparison

| Criterion | VIA USB-DDC (`2109:8884`) | i2c-dev on the amdgpu DP-AUX adapter |
|---|---|---|
| Proven on this monitor | Yes, for everything: probe, identity (FE page), SN, capabilities (A7A9) and ~60 standard and E2A0 codes, with 0 failures (`LOG26:152-163, 365-370, 913-993`) C | Partly: only VCP 0x14 and the `FE EF 13` SN, over ADL on Windows (`LOG26:345-360`) C. E2A0 codes and capabilities never went over the GPU path C |
| Depends on the active video input or DP link state | No. The scaler's DDC slave is reached from the hub (I) | Yes. A DP AUX sink may not answer while another input is shown or the link is down (L) |
| Depends on the USB upstream cable and KVM routing to this PC | Yes | No |
| Kernel prerequisites | None. usbfs allows vendor-type control requests without claiming an interface (L: `devio.c check_ctrlrecip` returns early for `USB_TYPE_VENDOR`) | `i2c-dev` loaded; the right adapter chosen (R6) |
| Permissions | udev `uaccess` on `2109:8884` (08 §8.5) | udev `uaccess` on the GPU `i2c-dev` nodes (§2.9) |
| Other clients on the same path | fwupd's VIA plugin may probe VIA hubs (L, 08 §8.5) | ddcutil and ddcutil-service, and desktop brightness extensions (L) |
| Needed anyway | The same USB cable carries the ENE Ambiglow controller | – |
| Identity to the display | Paired by name/serial queries (§2.3 step 3) | Direct: the adapter is a child of the DRM connector whose EDID we parse |

**Decision D1.** `auto` = USB first, i2c second, and the choice is sticky. The reasons, in order: it is the only path proven for the whole vendor command set on this monitor; it keeps working when the monitor shows another input or the DP link sleeps; and Ambiglow already needs it. i2c-dev is kept as a fully specified fallback. It is the only path when the USB cable is absent or the KVM routes the hub elsewhere.

**Why not the vendor's per-call "hub, then GPU".** When the bridge is present but not answering, each vendor call spends 3 `GetStandardData` attempts. In each attempt the write goes through `Util.smethod_0(…,3,177)`, which sleeps 177 + 354 + 531 ms after its three failed tries, and then the 100 ms write delay. That is about 1.16 s per attempt and about 3.5 s per call before the GPU path is tried (`ML/Zeasn.Monitor.Lib.Utils/Util.cs:24-45`, `ML/Interface13.cs:160-177, 281-286`, `ML/Interface2.cs:42-50`) C for the arithmetic. A sticky choice pays this once, not on every call.

### 2.2 Failover and stickiness rules

1. At connect (§2.3) pick `active` = USB if `usbOk`, otherwise i2c if `i2cOk`, otherwise the display is not connected. `bConnection` needs a supported transport **and** a non-empty capability string, as on Windows (`EB/GClass3.cs:167`) C.
2. Each operation first runs its full retry budget on `active` (§2.4 and §2.5).
3. If it still fails, and the operation is a **get** or an **idempotent set** (an absolute VCP value), run it once on the other transport, if that transport passed its probe. If that succeeds, make it `active` and log it. Otherwise return the error: `err_code = 9` for gets (`PE/AttributeInfo`, 06 §2.3), and -1 for sets.
4. **Never** replay a one-shot or trigger write on the other transport. This covers `OP_F6_PIPPBPSwap` (06 §7.9), `EXT_OP_E2A0_36_PixelRefresh`, `EXT_OP_E2A0_37_PanelRefresh`, and any code 06 §6 marks as an action (I: side effects can happen twice if the first write did reach the scaler).
5. After writing a USB-topology setting (`E2A012` USB-C mode, `E2A014` upstream, `E2A015` KVM), mark USB as suspect, expect a `USBChange`, and probe again (I: these settings re-enumerate the hub; see 06 §2.4 for the codes).
6. Re-evaluate `active` only in `Device_DetectionDisplay`, in `Device_DetectionUSB` (§5), and after a successful failover.

### 2.3 Probe order (replaces `GClass3.ConnectionCkecked` steps 1-5)

All steps run under a global "display scan" lock. Per-monitor steps also hold the monitor mutex (§2.4). Nothing below writes a setting.

1. **DRM, with no bus traffic.** For each `/sys/class/drm/card*-*` whose `status` is `connected`, read `edid` (the full blob, usually 384 bytes for this monitor, see §3.3) and parse it with EDID256Block (§3.3).
   - Keep a connector if `FnPNPID` contains `PHL` (`EB/GClass3.cs:111`, `supportDisplays=["PHL"]` at `PHL/CDevice_PHLDisplay.cs:114`) C, **and** `FnModelName` matches `^((PHL )|(PHL_)|(PHL))?<name>$` (case-insensitive) for a name from MonitorInfo.json with its leading `PHL`/`PHL `/`PHL_` removed (`EB/GClass3.cs:33-48`, `PHL/CDevice_PHLDisplay.cs:115-131`) C.
   - Key each candidate by `FnSerialNumber`. Skip it if the serial is empty (`EB/GClass3.cs:109,120-123`) C.
2. **USB bridges.** List libusb devices with `idVendor == 0x2109` and `bDeviceClass != 0x09`; on the user's machine that is `8884`. This is the Linux form of the vendor rule "every `vid_2109` path in `GUID_DEVINTERFACE_USB_DEVICE`" (`ML/Class5.cs:21-26`; 08 §2.2) C. Do not detach or claim anything. For each bridge, under a bridge-local lock:
   - a. VCP `C8` get. Require `SL == 0x09` (RTK scaler). This is the vendor's `GetScalerIC` (`ML/Interface8.cs:257-287`) C. Timing: `sleepTime = 150` (§2.5).
   - b. Model name `FE E9 0D 00 00` (`ML/Interface2.cs:382-402`) and FW version `FE E1 E6 06 00` (`ML/Interface8.cs:359-379`) C. Expected: `34M2C8600` and `V1.01` (`LOG26:152,154`) C. Skip BOM, DualImageBank, ScalerName and PanelName; they only matter for OTA (08 §3.4).
   - c. Pair the bridge with a candidate. Build the pattern from the EDID 0xFC name after `GetSimpleName` (upper-case, strip a leading `PHL`/`AOC`, trim, trim a leading `_`: `ML/.../Util.cs:377-395`). Test `^((AOC )|(PHL )|(AOC_)|(PHL_)|(AOC)|(PHL))?<simple>$` against the upper-cased bridge model name; if nothing matches, retry with `…<simple>[0-9A-Z]*` (`ML/.../MonitorUtil.cs:1327-1339`) C. If two candidates match, compare the `FE EF 13 00 20` SN with their EDID serials. If it is still ambiguous, leave the bridge unpaired, which means i2c only (I: an improvement over the vendor code).
   - d. Under the paired monitor's mutex: VCP `0x14` probe, `usbOk = ok && 0 < value < 255 && max < 255` (`ML/Interface0.cs:465-473`) C. Expected `0x05` / `0x0D` (`LOG26:163`) C.
3. **i2c-dev.** For each candidate connector, resolve the bus:
   - a. `DP-*` connectors: the child `i2c-*` whose `name` starts with `AMDGPU DM aux hw bus` (L).
   - b. Otherwise, and as the second choice for DP: `readlink ddc`.
   - c. Last resort: the vendor's EDID-equality rule (compare the first 128 bytes; 07 §4.4), but **only** on adapters whose PCI ancestor has class `0x03xxxx`. Never probe SMBus adapters.

   Then, under the monitor mutex, run the VCP `0x14` probe: 3 attempts, then wait 200 ms and try once more. This is the DDCHelper `DDCSupportJudge_C` plus the managed retry (07 §3.4.2) C. Optionally read `FE EF 13 00 00 20` for logging (07 §4.8.4).
4. **Choose `active`** (§2.2, rule 1). Steps 2d and 3 for the same monitor run **one after the other under the same mutex**, so they never overlap. That is D2.
5. **Capabilities.**
   - Cache key: `lower(<version> + "_" + hex2(VCP60 & 0xFF))` (`PB/Display.cs:202-256`) C. The version is `FE E1 E6 06 00` on either transport. On i2c the vendor first tries VCP `C9` and uses it only if `max == 201`, formatted `V%d.%02d` (`PB/Display.cs:258-273`) C. Expected key: `v1.01_0f` (`LOG26:366`) C.
   - On a cache miss, read the capabilities over `active` (§2.6), and cache them only if `AnalyseVcpString` succeeds (`PB/Display.cs:298-323`) C.
6. The full read (`method_4`) and the ENE check follow as in 06 §7.1 and 09.

### 2.4 Locking (D2)

| Level | Scope | Rule |
|---|---|---|
| Transaction | One DDC/CI exchange: write, delays, read (or write and its delay, for a set) | Hold the per-monitor mutex for the whole exchange, on **either** transport. This matches `MonitorService` taking `MonitorLock` around each call (`Zeasn.Monitor.Lib/MonitorService.cs:218-300`) and `NewDDCOper` using the same lock object (`PHL/CDevice_PHLDisplay.cs:133,137`) C. |
| Operation | One bridge call (`PHL_SetInputSource`, `PHL_SetSmartImage`, the EQ loop in `method_4`, Reset, …) | Single-flight queue per monitor. Windows does not serialise these (06 §5.6), which risks interleaving (I). The port should. |
| Process | Another instance of this app | Take an advisory lock file under `$XDG_RUNTIME_DIR/evnia/ddc-<serial>.lock` for each transaction (L). |
| Cross-tool (i2c) | ddcutil and similar tools on the same `/dev/i2c-N` | Take `flock(LOCK_EX)` on the device node for each transaction (L: ddcutil 2.x uses flock-based cross-instance locking; verify). |
| ENE | `0cf2:a201` | A separate lock. Different device, no DDC/CI. |

With OTA removed, the vendor's `InFirmwareUpdate` gate (`NewDDCOper.cs:20-24`, `PHL/CDevice_PHLDisplay.cs:141-145`) has no source and is dropped C.

### 2.5 Common DDC/CI codec (both transports)

**Request frame** (`ML/Interface2.cs:15-30`, `NAT` 07 §4.7) C:

```
frame  = [0x6E, 0x51, 0x80 | (1 + len(cmd)), op, cmd...]      // op = 0x01 get, 0x03 set, 0xF3 caps (no extra op byte for caps)
chk    = XOR of every frame byte, including 0x6E
USB    : send frame + chk            (the address byte is carried in the data)
i2c    : ioctl(I2C_SLAVE, 0x37); write(frame[1..] + chk)   (the kernel sends 0x6E as the address byte)
```

**Reply validation.** Used by both transports (`ML/Interface2.cs:60-76, 132-140, 209`) C:

```
buf    = read(N)                         // N: 32 for gets and FE queries; caps: 64 (USB A7+A9) / 38 (i2c)
ok     = buf[0] == 0x6E
      && (buf[1] & 0x80) && (L = buf[1] & 0x7F) >= 1 && L + 3 <= N
      && (0x50 ^ buf[0] ^ buf[1] ^ ... ^ buf[L+2]) == 0
payload = buf[2 .. 2+L)                  // starts at the reply opcode, except for FE EF 13 (raw ASCII)
```

A null message (`L = 0`) is treated as a failed attempt, as on the hub (`ML/Interface2.cs:63`) C.

**VCP get parse, relative to the length.** The same rule for standard and `E2 A0 xx` codes (`ML/Interface2.cs:209-214, 254-259`) C:

```
require L >= 4 (vendor hub: 1 <= L <= 30)
value = payload[L-2] << 8 | payload[L-1]      // == buf[L]   << 8 | buf[L+1]
max   = payload[L-4] << 8 | payload[L-3]      // == buf[L-2] << 8 | buf[L-1]
rc    = payload[1]                            // log only; the hub does not check it (C); DDCHelper does for standard gets (07 §4.8.1)
```

- For the standard 8-byte reply `02 RC cc TP MH ML SH SL`, this gives `SH:SL` and `MH:ML` C.
- For a possible 10-byte extended reply `02 RC E2 A0 xx TP MH ML SH SL`, it gives the same fields. The DDCHelper fixed offsets `p[4..7]` would not (I). This is why D3 exists; the capture in §7 C6 settles it.

**Other replies:**

- **Factory SN** (`FE EF 13`): `SN = ascii(payload[0..L))` with NUL bytes removed, then non-ASCII bytes removed. Keep the first 14 characters if `L >= 14`. Use `""` if `L < 13`. The vendor's `if L == 32 then L -= 2` quirk applies on USB (`ML/Interface2.cs:293-312`) C.
  - Guard the 14-character cut on the *string* length. The vendor calls `Substring(0,14)` whenever the byte count `L >= 14`, which throws if NULs made the string shorter (C, code).
  - The observed success therefore implies the monitor replied with **L = 13** (I, from `LOG26:368-369`: the "Span Time" line is only logged when no exception occurs).
- **FE-page text** (model, version, scaler): `imethod_8`. The payload is `buf[start ..]` with `start = (buf[5] == 0) ? 6 : 5` and length `L - (start - 2)`. Decode as ASCII and drop NULs (`ML/Interface2.cs:142-153`) C.

**Frames used by the port** (checksums computed with the rule above; C for the 0x14, E2A043, FE and caps frames, which 07 and 08 also list):

| Purpose | Frame on USB (i2c: drop the leading `6E`) | Read N |
|---|---|---|
| Probe VCP 14 | `6E 51 82 01 14 A8` | 32 |
| VCP 60 (input, cache key) | `6E 51 82 01 60 DC` | 32 |
| VCP DC (SmartImage / HDR) | `6E 51 82 01 DC 60` | 32 |
| VCP C8 (scaler IC) | `6E 51 82 01 C8 74` | 32 |
| Model `FE E9 0D 00 00` | `6E 51 86 01 FE E9 0D 00 00 A2` | 32 |
| FW version `FE E1 E6 06 00` | `6E 51 86 01 FE E1 E6 06 00 47` | 32 |
| Factory SN (hub form) | `6E 51 86 01 FE EF 13 00 20 9A` | 32 |
| Extended get E2A039 | `6E 51 84 01 E2 A0 39 C1` | 32 |
| Extended set E2A043 = 1 | `6E 51 86 03 E2 A0 43 00 01 BA` | – |
| Capabilities, offset 0 | `6E 51 83 F3 00 00 4F` | 64 / 38 |

### 2.6 VIA USB-DDC recipe (`2109:8884`, libusb or node-usb)

Request codes and wIndex are from `ML/Interface13.cs:125-158` C. The I2C meaning of each request is INFERRED from the vendor's method names (08 §4.2).

| Primitive | Setup packet | Notes |
|---|---|---|
| write | `bmRequestType 0x40, bRequest 0xB2, wValue 0, wIndex 0, wLength len(frame)+1`, data = frame + chk | Then **sleep 100 ms** (`ML/Interface13.cs:281-286`) C |
| read | `0xC0, 0xA3, wValue 0, wIndex 0x006F, wLength 32` | Then **sleep 50 ms** (`ML/Interface13.cs:288-293`) C. The vendor pre-fills `buf[0] = 0x6F` and sends that as wIndex (`ML/Interface2.cs:54`, `ML/Interface13.cs:154`) C |
| long read (caps) | `0xC0, 0xA7, 0, 0x006F, 32`, then `0xC0, 0xA9, 0, 0x0000, 32`; concatenate into 64 bytes | No 50 ms sleep after it (`ML/Interface13.cs:318-321, 425-438`) C |
| per-transfer retry | Up to 3 tries; after failure *n* (0-based) sleep `(n+1)·177` ms | `ML/.../Util.cs:24-45` with `timeout=177` from `ML/Interface13.cs:160-177` C |

**Get transaction** (`ML/Interface2.cs:32-93, 155-176`) C:

```
for attempt in 1..3:
    write(frame)                       // including its 100 ms delay; on failure: next attempt, no read
    t = elapsed time of the write
    sleep(t > sleepTime ? 15 : sleepTime - t)    // sleepTime: 100 for GetDDC / GetSN / caps; 150 for FE and C8 queries
    buf = read(32)                     // including its 50 ms delay
    if validate(buf): return buf
return failure
```

- Effective timings: VCP get about 100 + 15 + 50 ms + USB time, observed **~185 ms** C. FE/C8 queries about 100 + ~50 + 50 ms. A set is write + 100 ms, observed **~110 ms** C (`LOG26:962-971`).
- **Set:** one write (with its 100 ms delay). There is no read and no read-back (`ML/Interface2.cs:107-124, 178-196`) C.
- **Capabilities** (`ML/Interface13.cs:440-515`) C:
  1. `off = 0`. Loop:
     - Write `F3 off_hi off_lo`, sleep 15 ms after the write delay, then do the A7+A9 read.
     - Require `buf[1] > 0x80` and `buf[2] == 0xE3`.
     - Compute `n = L`; if `n == 32`, use `n - 2`; cap `n` at 30.
     - Append `ascii(buf[5 .. n+2))` without NULs.
     - `off += n - 3`. Stop when `n - 3 < 26`.
  2. Abort after 3 failed fragment reads.
  3. Port change (recommended, I): append all `L - 3` bytes and stop on an empty fragment or when the parentheses balance. Keep the vendor rule as a fallback switch.
  4. Expected: 1265 characters (CACHE, key `v1.01_0f`) in about 6.7 s C.
- Node sketch (L; node-usb is already a dependency of the Electron main, AM:17):

```js
const dev = usb.findByIds(0x2109, 0x8884); dev.open();              // no interface claim, no detach
const ctrlOut = (req, idx, data) => new Promise((ok, ko) => dev.controlTransfer(0x40, req, 0, idx, data, e => e ? ko(e) : ok()));
const ctrlIn  = (req, idx, len)  => new Promise((ok, ko) => dev.controlTransfer(0xC0, req, 0, idx, len, (e, b) => e ? ko(e) : ok(b)));
// write: ctrlOut(0xB2, 0, frameWithChk); read: ctrlIn(0xA3, 0x6F, 32); caps: ctrlIn(0xA7, 0x6F, 32) + ctrlIn(0xA9, 0, 32)
```

### 2.7 i2c-dev recipe (amdgpu DP-AUX)

- Open `/dev/i2c-N` with `O_RDWR`, then `ioctl(I2C_SLAVE, 0x37)` (L). Use two plain syscalls, `write()` then `read()`, never a combined repeated-start `I2C_RDWR`, because DDC/CI needs a STOP and a delay between them (07 §8.3) L.
- **Get:** `write(51 8x 01 cmd… chk)`, sleep 100 ms, sleep 15 ms, `read(32)`, sleep 50 ms. Validate and parse as in §2.5. Up to 3 attempts; a failed `write` or `read` syscall (EIO, ENXIO, EREMOTEIO, ETIMEDOUT) counts as a failed attempt.
  - The timings are the hub's, and the monitor saw them for all runtime traffic. DDCHelper used 100 ms, then 5·attempt ms, then read, then 50 ms (07 §4.7, §4.8.1) C. Either is fine; one shared timing table keeps the two transports alike.
- **Read length 32 is safe on this monitor's GPU path.** DDCHelper read `readLen + 3 = 35` bytes for the SN (07 §4.8.4) C, and the monitor answered with `L = 13` (§2.5) through ADL over DP (`LOG26:356-360`) C. Over-reading therefore did not break the GPU/AUX path on Windows. Linux amdgpu splits I2C-over-AUX into 16-byte chunks transparently (L). If a read of 32 bytes ever fails where 11 works, fall back to `11` for standard gets and to `L+3` (learned from the first byte pair) for the rest.
- **Set:** `write(51 8x 03 …)`, sleep 100 ms, up to 3 attempts (07 §4.8.2) C.
- **Capabilities:** the same loop as §2.6 with `read(38)` (3 + 32 data + 1 checksum, plus spare) and MCCS termination (empty fragment). 07 §8.4-H has the retry counts.

### 2.8 Timing table (both transports, parity values)

| Step | Value | Source |
|---|---|---|
| After any write | 100 ms | `ML/Interface13.cs:284`, `NAT` 07 §4.7 C |
| Write-to-read gap, extra | 15 ms (hub, when the write took ≥ sleepTime) or `sleepTime - t` | `ML/Interface2.cs:55` C |
| After a read | 50 ms (not after A7+A9) | `ML/Interface13.cs:291` C |
| Attempts per get | 3 | `ML/Interface2.cs:42` C |
| USB control-transfer retry | 3 tries; 177, 354, 531 ms | `ML/.../Util.cs:24-45` C |
| i2c probe | 3 attempts, then 200 ms, then 1 more | 07 §3.4.2 C |
| Observed get / set (USB) | ~185 ms / ~110 ms | `LOG26:913-993` C |
| Full module load | ~11.1 s | `LOG26:994` C |

### 2.9 Permissions (the `.deb` ships these; L)

```
# /usr/lib/udev/rules.d/70-evnia-monitor.rules
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="2109", ATTR{idProduct}=="8884", TAG+="uaccess", ATTR{power/control}="on"
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0cf2", ATTR{idProduct}=="a201", TAG+="uaccess"
SUBSYSTEM=="i2c-dev", KERNEL=="i2c-[0-9]*", ATTRS{class}=="0x030000", TAG+="uaccess"
# /usr/lib/modules-load.d/evnia-i2c-dev.conf
i2c-dev
```

The `ATTRS{class}` match limits access to adapters below a VGA-class PCI device (the ddcutil approach, L). Some GPUs report 0x038000; verify with `udevadm info -a`.

---

## 3. Identification and the `DispalyData` strings

### 3.1 Which code produces what (C)

| JSON field | Windows producer | Line |
|---|---|---|
| `DispalyData.MonitorEDIDInfo_T.*` (14 strings) | `new DisplayEDIDInfo(EDID256Block)`, copied at every `method_4` | `PB/Display.cs:188`, `PB/DisplayEDIDInfo.cs:269-285`, `PHL/CDevice_PHLDisplay.cs:313` |
| `MonitorResolution`, `MonitorFrequency` | `CWinSysDisplay.getCurDisplaySetting(curDisplay.DeviceName)`: `"<W>x<H>-<F>Hz"` split on `-` | `WL/CWinSysDisplay.cs:547-557`, `PHL/CDevice_PHLDisplay.cs:314-326` |
| `MonitorOrientation` | `aStrOrientation[dmDisplayOrientation]` = `"0°" / "90°" / "180°" / "270°"`; out of range gives `"0°"` | `WL/CWinSysDisplay.cs:533, 555, 673-681` |
| Defaults when the API fails | `string.Empty` for all three | `EO/DispalyOtherInfo.cs:12-18` |
| Consumers | Constraints `hz` (`EO/DisplayFuncConstraints.cs:127-128`); `BasicInfo.Resolution/RefreshRate` (`PHL/PHLDisplay_Oper.cs:168-169`); the overview card (`RA/styles-DAnQi2A8.js:14025-14026`). `MonitorEDIDInfo_T` and `MonitorOrientation` are **never rendered** (grep of `RA/`) | C |

`DisplayEDIDInfo` serialises in this field order: `sManufacturer, sManufacturerDate, PlugAndPlayID, sMonitorName, sSerialNumber, sVersion, ScreenSize, TimingRecommandation, DisplayGamma, DisplayTypeAndSignal, RedChromaticity, GreenChromaticity, BlueChromaticity, WhitePoint` (`PB/DisplayEDIDInfo.cs:51-245`; PROF shows the same order) C.

### 3.2 Identity fields for the port (C for the Windows values)

| Field | Windows value | Linux rule |
|---|---|---|
| `Display.SN`, `UIDisplayInfo.DisplaySN`, `PHL_SwitchDisplay` argument | `AU00000000001` (EDID 0xFF) | `FnSerialNumber` from sysfs EDID (§3.3) |
| `DisplayName`, `MonitorName`, `CacheDeviceData.ModelName` | `PHL 34M2C8600` (EDID 0xFC via the hub ctor, `PB/Display.cs:184-185`) | `FnModelName` |
| `DeviceName` | `\\.\DISPLAY1` | The compositor connector name, e.g. `DP-1` (the sysfs `card1-DP-1` without `cardN-`). Only used internally (I) |
| Cache `Name` | `PHL 34M2C8600` (CACHE) | `MonitorName` |

### 3.3 EDID256Block, exact algorithm (`ML/Zeasn.Monitor.Lib.Utils/MonitorUtil.cs:793-1123`) C

Input is the **full** EDID. On Windows it comes from the registry (`MonitorUtil.cs:1322-1337`); on Linux from sysfs. Block 0 feeds every field except `TimingRecommandation`, which may also scan extension blocks. `dec` is the decimal separator (§3.4).

```js
function edid256Block(b /* Uint8Array */, dec) {
  const HDR = [0x00,0xFF,0xFF,0xFF,0xFF,0xFF,0xFF,0x00];               // :793-801
  if (b.length < 128 || HDR.some((v, i) => b[i] !== v)) return null;    // vendor: fields stay null; the port skips the monitor
  const ch = String.fromCharCode;                                        // (char)byte = Latin-1
  const pnp = ch(64 + (b[8] >> 2)) + ch((64 + (((b[8] & 3) << 3) & 0xF8)) | ((b[9] >> 5) & 0x1F))
            + ch(64 + (b[9] & 0x1F)) + (b[10] + b[11] * 256).toString(16).toUpperCase().padStart(4, '0');   // :893-897
  const id = b[9] + b[8] * 256;                                          // :989
  let mfg = VENDOR_TABLE[id];                                            // 83 entries, :899-988 (16652 -> "PHL")
  if (!mfg) mfg = String(64 + (id >> 10)) + String((64 + (((id >> 8) & 3) << 3 & 0xF8)) | ((id & 0xFF) >> 5 & 0x1F))
                + String(64 + (id & 0x1F)) + pnp;                        // :991-997, sic: decimal numbers, not letters
  const text = (tag) => { let s = '';                                    // :999-1024, descriptors 0..3, all matches concatenated
    for (let i = 0; i < 4; i++) { const o = 54 + i * 18;
      if (b[o] === 0 && b[o+1] === 0 && b[o+3] === tag)
        for (let j = 0; j < 13 && b[o+5+j] !== 0x0A; j++) s += ch(b[o+5+j]); }
    return s; };
  const model  = text(0xFC);
  const serial = text(0xFF).replace(/[^\x00-\x7F]/g, '');                // smethod_9, :1350-1360
  let rec = '';                                                          // :1025-1043
  if (b[24] & 2) rec = `${b[56] + ((b[58] >> 4) & 0xF) * 256}x${b[59] + ((b[61] >> 4) & 0xF) * 256}`;
  if (['AOC','ENV','AMZ','PHL'].some(x => pnp.toUpperCase().includes(x))) rec = widest(b, rec);   // list_0, :536, :1036-1039
  const g = b[23] + 100;                                                 // :1044  $"{b23/100f+1f:0.##}"
  const gamma = g % 100 === 0 ? String(g / 100)
              : `${Math.floor(g / 100)}${dec}${String(g % 100).padStart(2, '0').replace(/0$/, '')}`;
  const date  = `Week${String(b[16]).padStart(2, '0')}-${String(1990 + b[17]).padStart(2, '0')}`;   // :1046
  const input = (b[20] & 0x80) ? 'DIGITAL' : 'ANALOG';                                            // :1048
  const size  = '~' + (Math.sqrt(b[21]*10*b[21]*10 + b[22]*10*b[22]*10) * 0.03937007).toFixed(1).replace('.', dec) + '"';   // :1052
  const ver   = `${b[18]}.${b[19]}`;                                                              // :1057, literal '.'
  const c = (hi, lo) => ((hi << 2) + lo) / 1024;                                                  // :1072-1107 (exact binary fraction)
  const f3 = (x) => x.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', dec);          // "0.###"
  const chroma = [
    `Rx${f3(c(b[27], b[25] >> 6 & 3))}-Ry${f3(c(b[28], b[25] >> 4 & 3))}`,
    `Gx${f3(c(b[29], b[25] >> 2 & 3))}-Gy${f3(c(b[30], b[25] & 3))}`,
    `Bx${f3(c(b[31], b[26] >> 6 & 3))}-By${f3(c(b[32], b[26] >> 4 & 3))}`,
    `Wx${f3(c(b[33], b[26] >> 2 & 3))}-Wy${f3(c(b[34], b[26] & 3))}` ];                            // :1108-1112
  return { sManufacturer: mfg, sManufacturerDate: date, PlugAndPlayID: pnp, sMonitorName: model,
           sSerialNumber: serial, sVersion: ver, ScreenSize: size, TimingRecommandation: rec,
           DisplayGamma: gamma, DisplayTypeAndSignal: input, RedChromaticity: chroma[0],
           GreenChromaticity: chroma[1], BlueChromaticity: chroma[2], WhitePoint: chroma[3] };      // PB/DisplayEDIDInfo.cs:269-285
}
function widest(b, s) {                                                  // method_2 / method_3, :833-882
  const list = [];
  if (b.length >= 384 && b[256] === 0x70)
    for (let i = 0; i < b.length; i += 128) {
      if (b[i] === 0x02) list.push(s);
      if (b[i] === 0x70) { const a = new Uint8Array(128); a.set(b.subarray(i + 1, i + 128)); list.push(...dispIdType1(a)); } }
  let best = s, w = 0;
  for (const it of list) { const p = it.split('x'); const n = /^[+-]?\d+$/.test(p[0]) ? parseInt(p[0], 10) : NaN;
    if (it && p.length === 2 && n > w) { w = n; best = it; } }
  return best;
}
function dispIdType1(a) {                                                // method_1, :803-831
  const out = []; let i = 4, num = 0;
  while (i < 127 && a[i] === 3 && i + 2 < 128) { num = a[i + 2]; if (num === 0) break;
    for (let j = 0; j < Math.floor(num / 20); j++) { const k = i + 3 + j * 20;
      if (k + 13 < 128) out.push(`${((a[k+5] << 8) | a[k+4]) + 1}x${((a[k+13] << 8) | a[k+12]) + 1}`); }
    i += num; }                                                          // sic: skips num bytes, not num+3
  return out;
}
```

Why these formatters match .NET byte for byte (I, reasoned):

- `(v/1024).toFixed(3)` matches `double.ToString("0.###")`. The value `v/1024` has at most 10 exact decimal digits, and .NET Core custom formats round a 15-digit expansion half away from zero, which equals the JS rule "the larger n on ties" for positive numbers.
- Gamma: the `float` result `b23/100f + 1f` lies within 1e-7 of `(b23+100)/100`, so `"0.##"` always prints the exact hundredths.
- ScreenSize: `toFixed(1)` equals `"f1"` except on exact ties, which cannot occur for these square roots except when the product is exactly `x.x5`.

**Worked example.** The EDID from `LOG26:206`: bytes 0-255, plus a third block (§3.6). Output with `dec = ","`, identical to PROF C:

```
{"MonitorEDIDInfo_T":{"sManufacturer":"PHL","sManufacturerDate":"Week01-2025","PlugAndPlayID":"PHLC29F",
 "sMonitorName":"PHL 34M2C8600","sSerialNumber":"AU00000000001","sVersion":"1.4","ScreenSize":"~34,2\"",
 "TimingRecommandation":"3440x1440","DisplayGamma":"2,2","DisplayTypeAndSignal":"DIGITAL",
 "RedChromaticity":"Rx0,689-Ry0,303","GreenChromaticity":"Gx0,241-Gy0,715","BlueChromaticity":"Bx0,145-By0,059",
 "WhitePoint":"Wx0,313-Wy0,329"},"MonitorResolution":"3440x1440","MonitorFrequency":"175Hz","MonitorOrientation":"0°"}
```

Intermediate values:

- Chromaticity: Rx = 706/1024, Ry = 310, Gx = 247, Gy = 732, Bx = 148, By = 60, Wx = 321, Wy = 337 (each /1024).
- Size: √(800² + 340²) · 0.03937007 = 34.2225…
- Gamma: 0x78 = 120, which gives 2.2.

These were recomputed with a comma culture and match PROF C.

For comparison, the unused DDCHelper output is `~35"` from `(int)(√…·0.03937)+1` (`NAT:6684-6693`) C, and `0.688 / 0.302 / 0.241 / 0.713 / 0.144 / 0.0584 / 0.313 / 0.328` (`LOG26:327-344`) C. The native decoder evidently does not use the full 10-bit chromaticity value; Gy = 0.713 cannot be produced from 732..735/1024 (I). Irrelevant to the port.

JSON quirks to keep for byte parity with PROF: `"` inside `ScreenSize` is escaped as `\"`, and `°` (U+00B0) is written as raw UTF-8 (`C2 B0`), not as `\u00b0` C (PROF bytes).

### 3.4 Locale decision (D5)

- Windows formats `ScreenSize`, `DisplayGamma` and all eight chromaticity values with `CurrentCulture` (`$"{…:0.##}"`, `ToString("f1")`, `$"{…:0.###}"`) C. The user's culture used `,` (PROF, and `LOG25:167` `Span Time : 0,1858926`) C.
- `sVersion` (`"1.4"`), `sManufacturerDate`, `TimingRecommandation` and `MonitorFrequency` contain no culture-dependent separator C.
- **Decision.** Setting `display.edidDecimal = auto | "," | "."`, default `auto`.
  - `auto` takes the decimal symbol from the process locale: the first of `LC_ALL`, `LC_NUMERIC`, `LANG`, mapped to BCP-47, then `Intl.NumberFormat(tag).formatToParts(1.5)`, part `decimal`. Node/ICU does not read `LC_NUMERIC` by itself (L).
  - The unit-test fixture sets `","` and must reproduce the PROF bytes above.
- **Why this is safe.** No backend or renderer code parses these strings back. The only parsed string, `MonitorFrequency`, is an integer (C, §3.1). If a Windows profile is ever imported, accept both separators.

### 3.5 `MonitorResolution`, `MonitorFrequency`, `MonitorOrientation`

Windows semantics:

- `EnumDisplaySettings(DeviceName, ENUM_CURRENT_SETTINGS)` gives `dmPelsWidth + "x" + dmPelsHeight + "-" + dmDisplayFrequency + "Hz"` and `dmDisplayOrientation` (`WL/CWinSysDisplay.cs:547-557`; the fields are `int` in `WL/DEVMODE.cs:24,45-51`) C.
- `dmDisplayFrequency` is an integer; for fractional rates the legacy API truncates. This is L: the well-known 59.94 → "59" and 143.98 → "143" behaviour.
- For a 90° or 270° desktop, `dmPelsWidth` and `dmPelsHeight` are the rotated dimensions (L).

Linux algorithm (the backend runs in the user session):

1. **Mode source**, in order:
   - a. **GNOME Wayland:** `org.gnome.Mutter.DisplayConfig.GetCurrentState` on the session bus. Find the monitor whose connector equals the sysfs connector name without `cardN-`. Take the mode flagged `is-current` (`width`, `height`, `refresh_rate` double). Take `transform` from the logical monitor that contains it (L).
   - b. **X11:** XRandR. Match the output by its `EDID` property, **not by name**: the amdgpu DDX calls it `DisplayPort-0` and modesetting calls it `DP-1`. From the CRTC take the mode (`width`, `height`, `dotClock`, `hTotal`, `vTotal`, flags) and the `rotation` (L).
   - c. **Fallback for both:** read-only libdrm on `/dev/dri/cardN`, using `drmModeGetConnectorCurrent` (it does not force a re-probe), then encoder, CRTC and mode. Orientation is unknown here, so use `"0°"` (L).
2. `exact = refresh_rate`, or `clock_kHz*1000 / (htotal*vtotal)`, times 2 if interlaced, divided by 2 for double-scan, divided by `vscan` if above 1 (the same factors as `drm_mode_vrefresh`, L).
3. `MonitorFrequency = floor(exact + 0.005) + "Hz"`. The 0.005 Hz absorbs pixel-clock quantisation (10 kHz steps / (3600·1500) ≈ 0.002 Hz) and float noise from compositors, while keeping Windows-style truncation (I).
4. `MonitorResolution = W + "x" + H` from the mode, swapped when the transform or rotation is 90° or 270° (I, Windows parity). With GNOME fractional scaling, still use **mode pixels**; Windows DEVMODE is unscaled (L).
5. `MonitorOrientation = ["0°","90°","180°","270°"][r]`, where `r` = transform or rotation in 90° counter-clockwise steps (wl_output, Mutter and RandR use the same sense; the Windows `DMDO_90` "Portrait" is also content rotated counter-clockwise; L/I). Ignore flipped transforms (Windows has none). This field is cosmetic (§3.1).
6. If no source answers, leave all three as `""`, like the vendor default (`EO/DispalyOtherInfo.cs:12-18`) C. Then `hz = 0`, so MBR is disabled (`EO/DisplayFuncConstraints.cs:157`) C. Log a warning.

This monitor's modes, computed from the EDID dump (C for the bytes, I for the arithmetic):

| Timing | Exact Hz | String |
|---|---|---|
| DTD1 (block 0, 319.75 MHz, 3600×1481) | 59.9726 | `59Hz` |
| CTA DTD @0xBD (536.40 MHz, 3600×1490) | 100.0000 | `100Hz` |
| CTA DTD @0xCF (402.75 MHz, 3600×1492) | 74.9832 | `74Hz`: **`hz<75`, so MBR is disabled** |
| CTA DTD @0xE1 (159.87 MHz, 3600×1481) | 29.9854 | `29Hz` |
| 175 Hz mode (third block, not in the 256-byte dump) | ≥ 175.0 (I) | `175Hz` (Windows showed exactly this, PROF C) |

The 74.98 Hz row is the one place where "truncate" and "round" disagree in a way that changes behaviour. Checklist item C10 records the exact 175 Hz timing; open question Q3 covers the 75 Hz case.

### 3.6 EDID length note

- EDID byte `0x7E = 0x02` means **two** extension blocks (`LOG26:206`: row 0x70 of the dump ends `… 20 20 02 BD`, so byte 126 = `02`) C.
- DDCHelper reads only 256 bytes (07 §4.8.6) C. sysfs gives the whole EDID.
- The 175 Hz timing is not among the first-256-byte DTDs (§3.5), so it lives in block 2 (I). Given the vendor's `0x70` DisplayID handling, block 2 is probably DisplayID (I). `widest()` above then scans its type-I timings. The first 3440-wide entry wins, and it cannot beat DTD1's width, so the result stays `3440x1440` (I, consistent with PROF).

---

## 4. `IsSmartImageHDR` policy

### 4.1 What depends on it (C)

| Consumer | Behaviour | Line |
|---|---|---|
| Items split | HDR: `ModuleSmartImageHDR.Items = DC.ValueList ∩ SmartImageHDR_E`. SDR: `ModuleSmartImage.Items = DC.ValueList − SmartImageHDR_E`. Only one of the two lists is filled | `PHL/CDevice_PHLDisplay.cs:331-353` |
| Sub-module read | HDR: if `DC != 32` read `CurSubSmartImage` (10, 12, 3D, 3E, 3F) into the HDR module. SDR: if `DC != 16`, read the 13 SDR attributes | same |
| `PHL_SetSmartImage(v)` | Rejects `v` unless it is in the Items list of the current mode | `PHL/…:1678` |
| `PHL_ResetSmartImage` | "Off" = 32 (HDR) or 16 (SDR) | `PHL/…:1722` |
| `PHL_SetOSD` | Writes into the HDR or SDR `CurSubSmartImage` | `PHL/…:1624` |
| `ParameterToDevice(bForce=true)` (profile or theme switch: `SO:3107`, `EB/GClass0.cs:183`) | SDR: restore the saved DC only if it is in the SDR Items, then restore the SDR sub-attributes (ColorSpace, preset, RGB, gamma, contrast, …). HDR: write DC only if the saved profile was also HDR, then restore 10, 12, 3D, 3E, 3F | `PHL/…:616-673` |
| Constraints `hdr` | Disables SharpShooter, Stark/ShadowBoost and SmartFrame; changes the luminance rule | `EO/DisplayFuncConstraints.cs:133-146`, 03 §3.4 |
| Renderer | Page and sidebar SmartImage vs SmartImageHDR; redirect after each refresh; overview card mode name | 03 §4.1, `RA/styles-DAnQi2A8.js:14027-14029` |

The Items for this monitor (from the DC capability list `DC(00 01 03 04 05 06 07 08 0B 0E 11 20 21 22 23 24 30 33 51 E2)`, CACHE C):

- **HDR** = 32 HDROff, 33 HDRGame, 34 HDRMovie, 35 HDRPhoto, 36 HDRPersonal, 48 HDRTrueBlack, 51 HDRPeak (PROF) C.
- **SDR** = 0 Standard, 1 FPS, 3 Movie, 4 Game1, 5 Game2, 6 Racing, 7 RTS, 8 Economy, 11 LowBlueMode, 14 EasyRead, 17 ConsoleMode, 81 IllustratorMode. This is the `SmartImage_E2` table picked by the trailing `E2` (`PB/DataOSD.cs:195-221`, `PE/SmartImage_E2.cs`) C. The list itself is not in PROF, because the profile was saved in HDR mode (I).
- **`SmartImage_Off` (16) is not in the capability list**, so the SDR "≠ Off" test is always true on this monitor C.

### 4.2 Options

| Policy | GNOME Wayland | X11 | Consistent with the monitor? |
|---|---|---|---|
| **P1 "monitor"** (default): `DC.Value ∈ {32..51}`, using the DC value read in the same `method_4` pass, before the split | Follows the monitor, which follows the signal Mutter sends | Same code. Xorg cannot send HDR metadata, so the monitor stays SDR and P1 gives false (L) | Always, by construction |
| P2 "signal": the KMS connector property `HDR_OUTPUT_METADATA` blob has EOTF 2 (PQ) or 3 (HLG) | Works with any compositor. Needs `/dev/dri/cardN` read access (seat ACL, L) | Always false | Only once the monitor has switched modes (a lag of about 1-3 s, I) |
| P3 "compositor": Mutter `GetCurrentState` monitor property `color-mode` = BT.2100 (L, GNOME with HDR support; absent on older versions) | Closest to Windows semantics (the OS toggle) | No equivalent, so false | Same lag as P2 |
| P4 constant false | Wrong whenever GNOME HDR is on | Correct | No |

### 4.3 Consequences of a mismatch (why D8 picks P1)

| Case | Items shown | Reads | `PHL_SetSmartImage` | `ParameterToDevice(bForce)` |
|---|---|---|---|---|
| flag false, monitor in HDR (DC = 33) | The SDR list, with no active item (33 is not in it) | SDR attributes (gamma, preset, RGB, …) read while the monitor is in an HDR preset, and stored as `SubSmartImages[33]` in the **SDR** module | Offers SDR values; writing an SDR DC into an HDR signal is probably ignored by the monitor (I) | Pushes saved **SDR** gamma, preset, RGB and contrast into the active HDR preset |
| flag true, monitor in SDR | The HDR list, no active item | HDR attributes (10, 12, 3D-3F) of an SDR preset, stored in the HDR module | Offers HDR values; the write is probably ignored (I) | Pushes saved HDR luminance and contrast into the SDR preset |

P1 cannot produce these rows. P2 and P3 can during the 1-3 s after a toggle, and permanently if the monitor ignores the signal (for example with the OSD HDR mode forced; I). **Decision D8:**

- `IsSmartImageHDR = P1`.
- Compute P2 or P3 (whichever is available) as well, and log a warning if it disagrees with P1 for more than 10 s.
- If the DC read fails (`err_code 9`), use `false`. The vendor would also land in the SDR branch, because `Value` defaults to 0 (I).

---

## 5. Hotplug mapping (D9)

The main-process debounce and shields stay exactly as in `AM:17650-17683`:

- `displayChange`: 2000 ms trailing debounce. The shield is checked both when the event arrives and when the timer fires.
- `USBChange`: a lock, then the send after 1000 ms, then unlock after 2000 ms.
- `otherDeviceChange`: the same, with the send after 1700 ms.

The renderer handlers are `displayChange → Device_DetectionDisplay`, `USBChange → Device_DetectionUSB` and `otherDeviceChange → Device_OtherDeviceChange` (`RA/main-CDosWiM3.js:1794-1797`, Bridge `:129-142`) C.

| Linux source (L) | Filter | Electron main | Backend call | Backend action (Linux) | Windows analogue |
|---|---|---|---|---|---|
| udev `SUBSYSTEM=drm ACTION=change` (`HOTPLUG=1`) | any card | `handleDeviceChange("displayChange")` | `Device_DetectionDisplay` | Settle wait, then a display-only scan (§2.3 steps 1-6 plus `method_4`) | `WM_DISPLAYCHANGE` (msg 126, `AM:17234`) C; the backend sleeps 5000 ms, then `smethod_0(Dispaly)` (`SO:241-246`) C |
| Mutter `MonitorsChanged` D-Bus signal (Wayland); RandR `RRScreenChangeNotify` (X11); Electron `screen` `display-added`, `display-removed`, `display-metrics-changed` | our connector, or any | same | same | Also covers refresh-rate changes and HDR toggles; Electron's metrics event does not report refresh-rate-only changes (L) | same |
| libusb or node-usb `attach`/`detach` (udev `usb` add/remove) | any device | `handleDeviceChange("USBChange")` (already in `AM:17237-17242`) | `Device_DetectionUSB` | Refresh the lists, then raise `UsbDeviceChange`. Keep the vendor comparers (see below) | node-usb attach/detach C; `SO:235-239, 205-208` C |
| udev `hidraw` add/remove | any | `handleDeviceChange("otherDeviceChange")` | `Device_OtherDeviceChange` | Monitor-only port: no BLE devices to scan; return the connect list (`SO:248-252`) | `WM_DEVICECHANGE` (msg 537) C |
| udev `i2c-dev` add/remove | GPU adapters | treat as `displayChange` | – | Re-resolve the buses | – |

The "keep the vendor comparers" step for `Device_DetectionUSB` works as follows (C for the vendor logic):

1. Synthesise vendor-style strings so the list-compare logic ports unchanged: devices as `usb#vid_XXXX&pid_XXXX#<serial or bus-port path>`, hubs (`bDeviceClass 0x09`) in a separate list.
2. Use `CListCompareController("vid_2109","vid_0BDA")` on devices, then `FnRecheckConnectionByUSB` (`PHL/CDevice_PHLDisplay.cs:204-216`, `EB/GClass3.cs:190-222`).
3. Use `("vid_05E3","vid_0552")` on hubs.
4. Use `("vid_0cf2")` on devices, then the ENE plug check `method_14(true)` (`PHL/…:754-810`). The comparer semantics are in `DC/Zeasn.Com.Lib/Zeasn.Com.Lib/CListCompareController.cs`.

Rules:

1. **All display-change sources go through `handleDeviceChange`**, so `shieldDisplayChange(true/false, secs)` suppresses them. The renderer raises this shield around AdaptiveSync (`RA/GameMode-C1cXG-_T.js:79`), SharpShooter size (`:201`), HDMI 1-3 refresh rates (`RA/System-DT9nKs1q.js:73,84,95`), PIP (`:333-337`), input switching (`RA/InputSource-DfTEOTzT.js:50`, released with `(false, 10)`) and factory reset (`RA/Setup-D-5j4V-I.js:126-135`) C. The backend must **not** start display rescans from its own udev listeners (I: that would bypass the shield). It may, however, update transport health, for example mark USB down when `8884` detaches.
2. `Device_DetectionDisplay` settle wait: keep 5000 ms by default for parity. It also covers the DP link retrain and the monitor's 1-3 s HDR/SDR switch that P1 depends on (I). This may later be shortened to "until the VCP 0x14 probe succeeds, at most 5000 ms".
3. `Device_DetectionUSB` does not run the display `ConnectionCkecked`; it only runs the comparer path (`SO:144-157`) C. A USB bridge appearing or vanishing therefore changes the transport without a full reload (§2.2).
4. `shieldPeripheralChange` was only used for firmware flashing (03 §4 FW flow). With OTA removed it stays as a no-op-capable IPC (C, I).
5. Writing E2A012, E2A014 or E2A015 re-enumerates the hub. The resulting `USBChange` burst is expected, and USB failover follows §2.2 rule 5.

---

## 6. ENE presence analysis

### 6.1 Facts per scan (C)

| Device (Windows instance ID) | 09-25 scans `LOG25:30-47, 796-813, 857-874, 928-945` | 09-26 scans `LOG26:29-44, 1046-1061, 1201-1216` |
|---|---|---|
| hub `2109:0817` (`msft30000000000`) | yes ×4 | yes ×3 |
| hub `2109:2817` (`msft20000000000`) | yes ×4 | yes ×3 |
| hub `2109:0211` (`7&00000003&4&4`) | yes ×4 | yes ×3 |
| hub `2109:2211` (`7&00000004&3&4`) | yes ×4 | **no** ×3 |
| device `2109:8884` (`0000000000000001`) | yes (`:34,800,861,932`) | yes (`:33,1050,1205`) |
| device `0cf2:a201` (`0000000002`) | yes (`:31,797,858,929`) | **no** |
| HID `0cf2:a201&mi_01` (`a&00000006&0&0000`) | yes (`:16,782,843,914`) | **no** |
| ENE plug result | `USBENE6K7730HelperPlug = True`, FW `03 32 07 0F 0B` (`:650-652`) | `CheckENEUnPlugin … bEnableENE=False` (`:907, 1090`) |
| E2A012 / E2A013 / E2A015 / E2A016 | 01 / 01 / 00 / 00 (`:722-725, 1620-1623`) | 01 / 01 / 00 / 00 (`:977-980, 1160-1163`) |
| USB attach/detach during the session | none logged (ELOG25) | none; only two lone `otherDeviceChange` (`ELOG26:14-15`) |

The E2A0 values mean: USB-C mode "USB3.2", USB standby **ON**, KVM "Auto", SmartPower Off (`PE/E2A0_12_USB_C_Setting_E.cs`, `E2A0_15_KVM_E.cs`, `SwitchFlag_E` via `PB/DataOSD.cs:346, 370`) C.

The ENE and `2211` appear and disappear **together** in all 7 scans (C). No other device differs between the days (C, from the lists above).

### 6.2 Topology, reconstructed from Windows instance IDs (I)

A USB device without a serial number gets the instance ID `<parent's ParentIdPrefix>&<port>`. The leading number of a ParentIdPrefix grows by one per level: the root hub is `5&…`, its children use `6&…`, and so on (L). Applied to the log:

```
xHCI root hub (5&0000001&0&0)                                  prefix given to children: 6&…
└─ VL817 hub pair  0817 (SS) / 2817 (HS)   [serials msft3…/msft2…]  prefix: 7&00000003&4 (SS), 7&00000004&3 (HS)
   ├─ port 4: second VIA hub  0211 (SS, "7&00000003&4&4") / 2211 (HS, "7&00000004&3&4")
   │          └─ ENE 0cf2:a201 (serial) → interface MI_01 (prefix a&00000006&0) → HID "a&00000006&0&0000"
   ├─ 2109:8884 VIA I2C/vendor function (serial; present when 2211 is absent, so not below 2211)
   └─ mouse 0000:0002 and keyboard 0000:0001 (their HID prefixes "9&…" put the devices at the same depth as 0211/2211)
audio device 0000:0003: HID prefix "8&…", so it sits directly on a root port (the PC)
```

The depths are consistent:

- ENE HID `a` (10) → interface 9 → ENE device 8 → parent `2211` (7).
- The ENE is a USB 2.0 function, so it can only hang below an HS hub: `2211` or `2817`. Its co-absence with `2211` points to `2211`.
- `0211` and `2211` both sit on **port 4** of their respective VL817 halves, which is how the two halves of one USB 3 hub attach (I).

### 6.3 Hypotheses

| Hypothesis | Verdict | Reason |
|---|---|---|
| USB upstream cable unplugged or not connected | **Rejected** | The VL817, `8884`, the SS half `0211` and the HID devices behind the VL817 were all present on 09-26 C |
| The second hub lost power (for example because of USB standby, E2A013) | **Unlikely** | Its SS half `0211` enumerated, and both halves share one supply (I). E2A013 read 1 on both days C |
| A setting routed the USB 2.0 lines elsewhere (KVM, USB-C mode) | **Unlikely** | E2A012 and E2A015 were identical on both days C |
| USB 2.0 enumeration of `2211` failed at that power-on (VL817 HS port 4, for example "device descriptor request failed") | **Most likely** (I) | Matches exactly "SS half present, HS half and everything below it absent". 09-26 was a cold boot with auto-start (`ELOG26:1`, `LOG26:1`), while on 09-25 the system had been up since 14:08 (`LOG25:1`). The Windows lists only contain devices with a registered interface, so a failed device would not appear (I) |
| The monitor powered up in standby with "USB standby ON" and did not re-train the internal HS link | Possible variant of the previous row (I) | Needs a test (checklist C12) |

### 6.4 Port implications

- Treat the ENE as optional and hot-pluggable. If it is absent, use the DDC Ambiglow codes E2A019-1D, as Windows did on 09-26 (09 §2; `PHL/…:379-390`) C. When `USBChange` shows `0cf2:a201`, run the ENE plug path with `bUsbChange=true` (`PHL/…:204-216, 754-810`) C.
- The DDC transport choice does not depend on the ENE. Their USB presence is independent (C: `8884` was present both days).
- When the ENE is absent while `0211` is present, show one diagnostic log line: "Ambiglow USB controller missing; its hub enumerated only at SuperSpeed". Suggest power-cycling the monitor or re-plugging the upstream cable. Never unbind or reset USB ports automatically (a system change).

---

## 7. Read-only hardware verification checklist (for the user to run later)

Run these with the app **not running**. Items marked (root) need `sudo` but change nothing persistent. `modprobe i2c-dev` loads a module until reboot and changes no settings.

| # | Command | Expect (Windows evidence) |
|---|---|---|
| C1 | `lsusb` | `2109:0817`, `2109:2817`, `2109:0211`, `2109:8884`; and, if the second hub enumerated, `2109:2211` and `0cf2:a201` (§6.1) |
| C2 | `lsusb -t` | `0211`/`2211` on port 4 of the VL817 halves, and the ENE below `2211` (§6.2; this tests the topology hypothesis) |
| C3 | (root) `lsusb -v -d 2109:8884` | iSerial `0000000000000001` (`LOG26:33`). Record `bDeviceClass`/`bInterfaceClass` (vendor 0xFF or Billboard 0x11 is unknown; 08 Q1) and `bcdDevice`. Check that no kernel driver is bound: `ls /sys/bus/usb/devices/*/driver` for its interfaces |
| C4 | (root) `lsusb -v -d 0cf2:a201`; `grep -l 0CF2 /sys/class/hidraw/*/device/uevent` | iSerial `0000000002` (`LOG25:31`). Interface 0 vendor class (WinUSB) and interface 1 HID (`mi_01`, `LOG25:16`). Dump the HID report descriptor to answer 09 Q1 |
| C5 | `for c in /sys/class/drm/card*-*; do echo "$c $(cat $c/status)"; readlink -f $c/ddc; ls -d $c/i2c-* 2>/dev/null; done; for a in /sys/bus/i2c/devices/i2c-*; do echo "$a $(cat $a/name)"; done` | A `DP-*` connector `connected`, with a child `i2c-N` named `AMDGPU DM aux hw bus …` and `ddc` pointing to `AMDGPU DM i2c hw bus …` (R6, L) |
| C6 | (root) `modprobe i2c-dev; ddcutil detect --verbose` | The display is found on the **aux** bus: mfg `PHL`, model `PHL 34M2C8600`, serial `AU00000000001`, product 0xC29F, MCCS 2.2 (`LOG26:300-310`, CACHE) |
| C7 | `ddcutil --bus N getvcp 14`; `getvcp 60 --verbose`; `getvcp DC` | 0x14 = `0x05`, max `0x0D` (`LOG26:163`, may differ if changed on Linux). 0x60 = `0x0F`, max `0x3616` (`LOG26:949`). DC: an SDR value (0x00-0x11 or 0x51) on an SDR desktop; 0x20-0x33 if GNOME HDR is on. This tests P1, §4 |
| C8 | `ddcutil --bus N capabilities --verbose` | The raw string is 1265 characters, identical to CACHE key `v1.01_0f`. It starts with `(prot(monitor)type(LCD)model(34M2C8600MV)cmds(01 02 03 07 0C E3 F3)` |
| C9 | **E2A039 raw capture over i2c:** `i2ctransfer -y N w7@0x37 0x51 0x84 0x01 0xE2 0xA0 0x39 0xC1; sleep 0.12; i2ctransfer -y N r32@0x37` (two separate calls, so there is a STOP between them) | `buf[0] = 6E`, `L = buf[1] & 0x7F`, checksum valid. **The last 4 payload bytes are `00 10 00 08`** (max 0x10, value 0x08: `LOG26:963-971`). Record `L` (8 or 10?) and `payload[0..3]`. This closes 06 Q1, 07 Q1 and D3 |
| C9b | (optional, same capture over USB, root or uaccess, `python3-usb`): `d=usb.core.find(idVendor=0x2109,idProduct=0x8884); d.ctrl_transfer(0x40,0xB2,0,0,bytes.fromhex('6E518401E2A039C1')); time.sleep(0.115); print(bytes(d.ctrl_transfer(0xC0,0xA3,0,0x6F,32)).hex(' '))` | The same payload as C9. It also proves usbfs accepts the vendor requests without claiming an interface (§2.1, L) |
| C10 | `edid-decode /sys/class/drm/cardX-DP-Y/edid` | 384 bytes; block 0 equal to `LOG26:206`; byte 126 = `02`. Record block 2's type and the exact 175 Hz timing (pixel clock, htotal, vtotal), and apply §3.5 step 3 |
| C11 | GNOME: `gdbus call --session --dest org.gnome.Mutter.DisplayConfig --object-path /org/gnome/Mutter/DisplayConfig --method org.gnome.Mutter.DisplayConfig.GetCurrentState`. X11: `xrandr --verbose` | The current mode 3440×1440 and its exact refresh rate (§3.5); whether a `color-mode` property exists (P3). The connector name equals the sysfs name without `cardN-` |
| C12 | `journalctl -k -b \| grep -iE 'usb [0-9-.]+: (new\|device descriptor\|unable\|error)'` after a cold boot with the monitor on, and again after a boot with the monitor in standby | If `2211` is missing, look for descriptor or enumeration errors on the VL817 port 4 path (§6.3) |
| C13 | (root) `modetest -c` (libdrm tests; read-only listing) | The connector properties `HDR_OUTPUT_METADATA` and `Colorspace` exist (P2 feasibility) |

---

## 8. Corrections to earlier reports

| Report and location | Says | Correction |
|---|---|---|
| 07 Summary item 1 (`07:7`), §8.1 item 2 (`07:631`), §11 (`07:757-762`) | The hub path is RhHidAPI HID-I2C or Genesys; `UsbHubChannel` is a "HID-I2C bridge"; this is "the transport actually used" | The user's hub path is **VIA `2109:8884`, WinUSB vendor control transfers** (`ML/Interface13.cs:125-158, 271-293`; `LOG26:157-158`). Neither HID nor RhHidAPI is involved. RTK and Genesys were not detected (`LOG26:148-149`) C |
| 07 §3.3 table, column "34M2C8600 value (log)" (`07:151-170`) | Presents the DDCHelper strings (`~35"`, `2.2`, `Rx0.688…`) as the monitor's values | These are what DDCHelper computed. The **byte-visible** `DispalyData.MonitorEDIDInfo_T` came from the hub EDID256Block (`~34,2"`, `2,2`, `Rx0,689-Ry0,303`, …; PROF). See R3 C |
| 07 §7.3 EDID comment (`07:594`) | "1 extension" | Byte 126 = `0x02`: **2** extension blocks. The 256-byte dump is missing block 2, which holds the 175 Hz timing C/I (§3.6) |
| 07 §8.2 steps a/b (`07:648-653`) | Try the `ddc` symlink before the connector's AUX child | For DP connectors on amdgpu, try the AUX child first (R6, L) |
| 07 §8.3 (`07:686`) | `if (L > *n) return -EPROTO` with n = 8 ("be strict") | Rejects possible longer extended replies. Use length-relative parsing with a 32-byte read (D3) |
| 07 §8.4-J (`07:711`) | Re-implement `GetEDIDOption` and the `~35"` quirk | Port EDID256Block instead (D4) |
| 06 §4.5 (`06:356`) | `FnModelName` = "first 0xFC descriptor" | **All** 0xFC descriptors are concatenated (the StringBuilder is not reset); the same holds for `FnSerialNumber` and 0xFF (`MonitorUtil.cs:999-1024`) C |
| 06 §10 transport A/B (`06:1096-1107`) and 07 §8.1 (`07:635`) | I2C first; USB optional or fallback | Superseded by D1 (R1) |
| 06 §10 (`06:1104`) | Capabilities "either A3 fragments … or A7+A9" | A3 cannot validate fragments with `L > 29`. Use A7+A9, the vendor default (R8) C |
| 08 §8.1 (`08:703`) | "Try USB if IsSupportUsbDDC, otherwise i2c-dev, as the Windows app does" | Windows falls back **per call** (hub, then DDCHelper), not once per monitor. The port uses sticky selection with explicit failover rules (§2.2) C |
| 08 §2.3 (`08:122-140`) | Lists only the 09-26 hubs; `2109:0211` "role unknown" | On 09-25 `2109:2211` was also present. `0211` is the SuperSpeed half and `2211` the High-Speed half of a second VIA hub on VL817 port 4; the ENE hangs below `2211` (§6, I) |
| 09 §2 row (`09:55`) and 09 Q10, 06 Q4 | Cause of the ENE absence "unknown (USB upstream cable/hub power)" | The cable is ruled out and power is unlikely: `0211`, `8884` and the VL817 devices were present, and the USB settings were identical. Most likely USB 2.0 enumeration of `2211` failed (§6.3) |
| 03 §2 (`03:195`) | `MonitorEDIDInfo_T{...16 strings}` | The backend sends **14** strings (`PB/DisplayEDIDInfo.cs:51-245`). The renderer's default object has 16 keys, with extra `Description` and `sModelName` (`RA/styles-DAnQi2A8.js:9336-9353`), which the backend never fills C |
| 06 §4.3, 08 §3.4 (GetSN) | "Truncated to 14 characters" | The cut is decided by the byte count `L` but applied to the NUL-stripped string. If `L >= 14` and the string is shorter, `Substring(0,14)` throws and GetSN fails (`ML/Interface2.cs:298-308`). The logged success means this monitor replies with `L = 13` (I) |
| 06 §2.4 / §4.5 note on `MonitorFrequency` | "from Windows CWinSysDisplay" (correct), but no format constraint | It must be an integer followed by `Hz`. `"59.94Hz"` would parse to 0 and disable MBR (`EO/DisplayFuncConstraints.cs:296-314`) C |

---

## 9. Open questions

1. **Q1: Extended reply length.** Is it `L = 8` or `L = 10`? Checklist C9/C9b answers this. D3 makes the port independent of the answer.
2. **Q2: What `2109:8884` is.** Its class and interfaces (C3). Does fwupd's VIA plugin touch it at boot? A collision is possible only while fwupd probes (L).
3. **Q3: Windows refresh-rate truncation.** Does Windows' legacy `dmDisplayFrequency` truncate 74.98 Hz to 74 (MBR disabled) or round it to 75? A Windows check: switch to 75 Hz, reload, and read `MonitorFrequency` in PROF. D7 assumes truncation (I).
4. **Q4: DDC/CI over DP-AUX in edge states.** Does it answer while the monitor shows another input, or during DPMS off, on Linux amdgpu? This only matters when USB is unavailable (L).
5. **Q5: The 2211 enumeration failure.** Is it reproducible at cold boot, and is it tied to monitor standby with "USB standby ON"? (C12)
6. **Q6: HDR signal and DC.** Does the monitor always move DC into 0x20-0x33 on an HDR signal and back on SDR, and how long does the switch take (C7 with GNOME HDR toggled)? P1 relies on this (I).
7. **Q7: Mutter HDR property.** The exact name and presence of the HDR or colour-mode property in `GetCurrentState` on the user's GNOME version (C11). This only affects the P3 cross-check.

---

## 10. Online touchpoints

None in this area. Everything above is local: sysfs, libusb, i2c-dev, D-Bus and KMS. The vendor DDC, USB-DDC and EDID code has no network access (07 §9, 08 §9) C. The only related online item, the `MonitorInfo.json` refresh that feeds the model whitelist, is covered in 14 (N-list) and 06 §11. The port ships the bundled table (Version 34).

## 11. Cross-references

- VCP catalogue, modules, constraints and exact sequences: 06 §6-§8.
- DDCHelper internals (not ported): 07 §3-§5.
- VIA ISP and OTA (removed): 08 §4.4, §7.
- ENE register protocol and Ambiglow: 09 §3-§6 and §A.
- Electron main IPC and debounce: 01 §9-§10.
- Renderer pages and the SmartImage/HDR routing: 03 §4.1-§4.3.
