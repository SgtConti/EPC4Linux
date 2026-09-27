# 09 - Ambiglow / light effects / screen and music sync (ENE, Display32, Audio.Sync)

## Summary

The Philips Evnia 34M2C8600's rear "Ambiglow" LEDs can be driven two ways:

1. **ENE USB path (the one the 34M2C8600 uses when its USB upstream cable is connected).** The monitor has an internal ENE Technology MCU (vendor-named "USB ENE 6K7732", chip ID `0x7730`) on USB **VID `0x0CF2`, PID `0xA201`**. `EneEc.dll` reaches it only through **vendor control transfers on endpoint 0 via WinUSB**: `bmRequestType 0x40 / bRequest 0x80` writes a register and `0xC0 / 0x81` reads one. The register address goes in `wValue:wIndex`. On top of this the C# layer builds a small register map. There is a per-zone mode/speed/direction/brightness/apply block at `0xE020..0xE05F`, per-zone static colours at `0xE980..`, a per-LED frame buffer at `0xE300..` used for software "follow video" and synced breathing, audio-level registers at `0xE960..0xE972`, a host-control flag at `0x0023`, and identification registers (`0x4000/0x4001` chip ID, `0xE9F0/0xE9F1` model name, `0xB500` FW version, `0xE0A1..0xE0A9` LED counts). The monitor firmware renders static, colour-shift, wave, breathing, starry-night and audio-level effects itself. The PC streams per-LED colours only for FollowVideo (and for breathing when it is synced with other Philips peripherals).
2. **DDC/CI fallback path.** When the ENE USB device is absent, the app uses Philips/TPV extended VCP codes `E2 A0 19..1E` (mode, colour, position, brightness, speed, direction) and `E2 A0 38` (reset). In this mode the monitor does "follow video/audio" by itself, and the PC streams nothing.

The user's real logs show that on 2026-09-25 the ENE path was active: model name `34M2C8600`, FW `03 32 07 0F 0B`, effect FollowVideo, with the PC capturing the screen. On 2026-09-26 the `0cf2:a201` device was absent (not on the USB bus), so the app fell back to the DDC path.

Screen capture for FollowVideo is **not** in `Zeasn.Display32.Lib`. That library is only monitor enumeration and virtual-desktop IDs for FancyZones. Capture is plain GDI `BitBlt` of the **primary** screen in `Zeasn.PCenter.Base.Lib/ScreenCaptureMgr.cs`, sampled into a 50×40 grid with a 5-point-per-cell average and mapped to LEDs with fixed formulas. Music sync (`Zeasn.Audio.Sync.Lib`) is NAudio WASAPI loopback of the default render device, followed by an FFT (0–2500 Hz). A heuristic turns the spectrum into one 0–255 "level" byte every 40 ms, which is written to the ENE audio registers. The monitor firmware does the visualisation. "Dynamic Lighting" support is only a registry read of `HKCU\Software\Microsoft\Lighting\AmbientLightingEnabled` plus opening `ms-settings:personalization-lighting`; there is no LampArray code. No networking exists in this area, apart from AmbiScape (Matter smart bulbs fed with screen-zone colours) and the ENE firmware OTA, both of which should be dropped.

For Linux, the whole ENE path can be done in user space with libusb (no kernel driver), a udev rule, PipeWire/X11 capture and a PipeWire/PulseAudio monitor source.

Legend used below: **[C]** = CONFIRMED (read in decompiled code / native decompile / seen in the user's logs or files); **[I]** = INFERRED.

All paths are relative to the repository root unless absolute. `dc/` = `work/dotnet-clean/`, `nat/` = `work/native/`, `rp/` = `work/app-pretty/renderer/assets/`, `logs/` = `%APPDATA%/EvniaServe/logs/`.

---

## 1. Component map

```
Renderer (Vue)  --SignalR GetTaskAsync {functionName:"Effect_*", parms:[device, ...]}-->  EvniaServe
  Bridge.Lib/Bridge.cs:28-52, 409-500           -> SystemOper (dc/Zeasn.Framework.Core.Lib/.../SystemOper.cs:377, 1351-1535)
     -> IEffect = CDevice_PHLDisplay (dc/Zeasn.Equipment.Option.Lib/.../PHLDisplay/CDevice_PHLDisplay.cs)
          ENE path:  ENEDataConvert.MapTMain_ParameterSet -> CUSBENE6K7732 (dc/Zeasn.USB.ENE.Lib/Zeasn.USB.ENE.Lib/CUSBENE6K7732.cs)
                     -> Class0 register writer (dc/Zeasn.USB.ENE.Lib/Class0.cs) -> ENEWrapper P/Invoke -> lib/ENE/EneEc.dll
                     -> winusb.dll WinUsb_ControlTransfer -> USB 0cf2:a201 (ENE MCU inside monitor)
          DDC path:  AttributeInfo(EXT_OP_E2A0_19..1E).SetValue()  -> DDC/CI (see DDC report)
  EffectTimerMgr (dc/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/EffectTimerMgr.cs) - 4 background threads:
     screen capture 300 ms | video frame 100 ms | audio level 40 ms | breathing tick 40 ms
     -> EventSystem EVT_Effect.* -> HandleEvent (dc/EvniaServe/Evnia/HandleEvent.cs:39-66) -> SystemOper.OnVideoData/OnAudioData/OnBreathingData
     -> CDevice_PHLDisplay.OnFollowVideo/OnFollowAudio/OnBreathing (CDevice_PHLDisplay.cs:1223-1316)
  AudioSyncController (dc/Zeasn.Audio.Sync.Lib/.../AudioSyncController.cs) - NAudio WasapiLoopbackCapture
  ScreenCaptureMgr (dc/Zeasn.PCenter.Base.Lib/.../ScreenCaptureMgr.cs) - GDI BitBlt
  AmbiScapeOper (dc/Zeasn.Equipment.Option.Lib/.../AmbiScapeOper.cs) - zone colours for smart bulbs (renderer -> Matter)
  DynamicLghtingUtil (dc/Zeasn.Framework.Core.Lib/.../DynamicLghtingUtil.cs) - registry probe only
  GlobalOper.CheckIdle (dc/Zeasn.PCenter.Base.Lib/.../GlobalOper.cs:108-118) - "turn off lights when idle"
```

---

## 2. Which path the user's 34M2C8600 uses (log evidence)

| Evidence | Source | Meaning |
|---|---|---|
| `\\?\usb#vid_0cf2&pid_a201#0000000002#{a5dcbf10-...}` in UsbDevices, and `\\?\hid#vid_0cf2&pid_a201&mi_01#...` in the HID list | `logs/2026-09-25.txt:16,31` | ENE MCU present: composite USB device 0CF2:A201, serial `0000000002`. Interface 1 is HID [C]. The WinUSB (vendor) interface is therefore very likely interface 0 [I]. |
| `GetFWModelName sModelName:34M2C8600` | `logs/2026-09-25.txt:650` | Read from ENE regs `0xE9F0/0xE9F1` [C] |
| `GetFWVersion FWVersion:03 32 07 0F 0B` | `logs/2026-09-25.txt:651` | 5 bytes from ENE reg `0xB500`; `FWVersion` = last byte `0x0B` [C] |
| `CheckENE Display USBENE6K7730HelperPlug = True` | `logs/2026-09-25.txt:652` | `CUSBENE6K7732.Plug()` succeeded [C] |
| `{"EffectList":[...],"EffectDetail":{"Effect":{"Name":"FollowVideo",...}},"EffectEnable":true,"CurrEffect":{"Name":"FollowVideo","Text":"光影同步","Value":1}}` | `logs/2026-09-25.txt:740` | Effect state pushed to the ENE (FollowVideo, so the PC captures the screen) [C] |
| `USBCableLivingSwitch 0 : 34M2C8600 ret = True` then `ParameterSet 0 : 34M2C8600 ret = True` 458 ms later | `logs/2026-09-25.txt:741-742` | Reg `0x0023` ← 4, then the 28-write ParameterSet sequence (§6.3). About 16 ms per write, which matches `Thread.Sleep(10)` at Windows' 15.6 ms timer granularity [C/I] |
| No `vid_0cf2` in UsbDevices; hub `2109:2211` also missing; `CheckENEUnPlugin bUsbChange=False bEnableENE=False` | `logs/2026-09-26.txt:29-34,907` | ENE absent that day, so the DDC path was used [C]. Cause unknown (USB upstream cable/hub power) [I] |
| `Hub GetTPVExternValue command=e2a019 value=00 ... e2a01a value=06 ... e2a01b 00 ... e2a01c 02 ... e2a01d 00` | `logs/2026-09-25.txt` (≈19:13:53) and `logs/2026-09-26.txt` (≈07:52:43) | DDC Ambiglow state: Off, Blue, AllZones, Brightest, Low [C] |
| Capabilities string lists `E2A019(00-07) E2A01A(00-0D) E2A01B(00-03) E2A01C(00-02) E2A01D(00-02) E2A038(01)`, no `E2A01E` | `%APPDATA%/EvniaServe/Config/data.json` | DDC Ambiglow codes supported by this monitor. Direction is not supported [C] |
| Persisted profile: `"ENEEffectEnable":false`, `ModuleAmbiglow` {19:7, 1A:6, 1B:0, 1C:2, 1D:0, 1E err_code 9}, `EffectInfo.EffectList[...]` | `%APPDATA%/EvniaServe/Theme/User/Default.pcenter` | Last save was in DDC mode [C] |

Conclusion: the 34M2C8600 **uses the ENE USB path whenever `0cf2:a201` is enumerated**, and the DDC `E2A0` path otherwise [C]. The ENE check is only triggered when a USB device path containing `vid_0cf2` is present (`CDevice_PHLDisplay.cs:25` `new CListCompareController("vid_0cf2")`, `:761` `if (!clistCompareController_0.HasData) -> unplug`; `dc/Zeasn.Com.Lib/Zeasn.Com.Lib/CListCompareController.cs`).

---

## 3. USB transport (`EneEc.dll`, native)

### 3.1 Exports used and the P/Invoke surface [C]
`dc/Zeasn.USB.ENE.Lib/Zeasn.USB.ENE.Lib/ENEWrapper.cs:8-36` (cdecl, `lib/ENE/EneEc.dll`):

| Export | Signature | Native impl (`nat/EneEc.dll.c`) |
|---|---|---|
| `Ec_Init` | `void* Ec_Init(EcInitParam* p)` | line 265. `p->size` must equal 16; `bus==4` (ECBUS_WINUSB) → connType 3 → WinUSB transport (`FUN_10001e40` line 1050 → `FUN_10004280` line 3103) |
| `Ec_Exit` | `void Ec_Exit(void* h)` | line 319: frees the transport (WinUsb_Free + CloseHandle, `FUN_10004210`) |
| `Ec_ReadRegs` | `bool (void* h, uint reg, byte* buf, int len)` | line 448 → transport vtable+4 = `FUN_100039c0` (line 2644) |
| `Ec_WriteRegs` | `bool (void* h, uint reg, byte* buf, int len)` | line 462 → vtable+8 = `FUN_10003a90` (line 2686) |
| `Ec_GetChipId` | `ushort (void* h)` | line 426: cached `*(u16*)(h+4)` |
| `Ec_GetRevId` | `byte (void* h)` | line 437: cached `*(u8*)(h+6)` (declared, unused by C#) |
| `Ec_GetVID` / `Ec_GetPID` | `ushort (void* h)` | lines 392-424 → `FUN_10003860` (line 2577): standard GET_DESCRIPTOR(Device) |
| `Ec_ResetAndStop`, `Ec_Run` | declared private, never called | lines 476-535 (toggle bit0 of the E51RST reg) |

`EcInitParam` (`EcInitParam.cs`): `{int size=16; int bus=4 (ECBUS_WINUSB); uint slaveAdr=200; uint ftClkKhz=100}` (`CUSBENE6K7732.cs:68-73`). For WinUSB only `bus` matters. `slaveAdr`/`ftClkKhz` are for the FTDI debug-kit buses (`ECBUS.cs`: 1 EDI-over-FTSPI, 2 EDI-over-FTI2C, 3 FTSMBD, 4 WINUSB, 100 FAKE) [C]. The DLL also contains an FTDI "KBC Debug Kit" / "ENE X-Writer" transport (`FTD2XX.dll`, strings at `nat/EneEc.dll.symbols.txt` 0x100187b4..0x10018b68) that is not used.

### 3.2 Device discovery [C]
- `FUN_10003d30` (line 2824) calls `SetupDiGetClassDevsA(guid, NULL, NULL, DIGCF_PRESENT|DIGCF_DEVICEINTERFACE (0x12))` for **two device-interface GUIDs** (read from the DLL's `.rdata` at VA `0x10018508` / `0x10018518`):
  - `{6987B675-8CBC-4BD3-A557-C627CEA223DC}`
  - `{8B0F5A33-31D5-4532-B75B-79D41C7C3283}` (a flag `transport+0x24 = 1` records that the device came from this GUID; it is never read afterwards)

  These are WinUSB `DeviceInterfaceGUIDs` that the device advertises in its MS OS descriptors [I]. **There is no VID/PID filter in the DLL.** `FUN_10003b60` (line 2729) only parses `VID_%hx&PID_%hx` for metadata. `FUN_10003c20` (line 2764) walks `CM_Get_Parent` while the VID/PID stays the same (composite parent) and reads `CM_DRP_LOCATION_INFORMATION` (0x0E).
- `FUN_10004040` (line 2978): `CreateFileA(path, GENERIC_READ|GENERIC_WRITE, share=0 (exclusive), OPEN_EXISTING, FILE_FLAG_OVERLAPPED|NORMAL)` then `WinUsb_Initialize`. `ERROR_ACCESS_DENIED` means "opened by someone else", so the DLL tries the next device (`FUN_10004130` line 3025). This is how `CUSBENE6K7732.Plug()` gets up to 8 devices by calling `Ec_Init` repeatedly (`CUSBENE6K7732.cs:75-83`).
- `WinUsb_SetPipePolicy` is not imported, so the default control-transfer timeout (5 s) applies [I].

### 3.3 Control-transfer encoding (the wire protocol) [C]
`WINUSB_SETUP_PACKET` is passed by value as two dwords (`FUN_100039c0` line 2659, `FUN_10003a90` line 2701):

| Operation | bmRequestType | bRequest | wValue | wIndex | wLength | Data stage |
|---|---|---|---|---|---|---|
| **Read regs** | `0xC0` (vendor, device, IN) | `0x81` | `reg >> 16` (always `0x0000` here) | `reg & 0xFFFF` | `len` (≤ 0x1000 per chunk) | device→host `len` bytes |
| **Write regs** | `0x40` (vendor, device, OUT) | `0x80` | `reg >> 16` | `reg & 0xFFFF` | `len` (≤ 0x1000 per chunk) | host→device `len` bytes |
| GetVID/GetPID | `0x80` | `0x06` GET_DESCRIPTOR | `0x0100` (Device) | 0 | 18 | device descriptor (line 2592 `0x1000680`) |

- Multi-byte transfers auto-increment the register address on the device side. The vendor writes 3/9/12/42/54-byte blocks at a single start address (§6, §7) [C for usage; auto-increment semantics I].
- Chunking > 0x1000 bytes re-sends the **same** `wIndex` (a DLL quirk). It is irrelevant here because the largest transfer is 54 bytes [C].
- Example setup packet, "write `0x01` to `0xE021`": `40 80 00 00 21 E0 01 00` + data `01`.
- Example, "read model-name length": `C0 81 00 00 F0 E9 01 00` → 1 byte.

### 3.4 What `Ec_Init` does on the wire (WinUSB, chip 0x77xx) [C]
`FUN_10004e80` (line 3738):
1. Chip ID: read 1 byte `0x4000` (high) and 1 byte `0x4001` (low) → `0x7730` for this monitor (`FUN_10005ed0` lines 4492-4506). For `(id & 0xFFF0) == 0x7730` the revision is read from `0x0244` (1 byte). IDs `0x0000`/`0xFFFF` are rejected.
2. `FUN_100049f0` (line 3540) / `FUN_10004720` (line 3427) set internal register addresses for the 0x77xx family. E51RST=`0x0202`, WDTCFG=`0x0600`, and the embedded-flash controller regs `0x0410..0x0417`, `0x0485/0x0486`, `0x0424`. Flash size 64 KiB. No I/O happens here.
3. `FUN_100052c0` (line 3955): read 1 byte from `0x0415`. If non-zero, done. If zero, the DLL runs a **trim-load** (`FUN_10005dc0` line 4428 / `FUN_10005530`): it drives the flash controller (writes `0x90` read command to `0x0415`, address to `0x0411/0x0412`), looks for a `'Z'` tag in a "special row", and copies trim bytes into `0x0244..0x0246`. It then re-reads the chip ID. This is debug-kit/bring-up logic. On a running monitor it is either skipped or only loads volatile trim registers [I]. **The Linux port should not replicate the flash sequence** (see Open questions).

### 3.5 Timing [C]
Every C# write goes through `Class0.method_4` (`dc/Zeasn.USB.ENE.Lib/Class0.cs:179-205`), which does `Ec_WriteRegs` and then **`Thread.Sleep(10)`** (`int_0 = 10`, line 37). With the Windows default timer resolution this is about 15.6 ms per write, which the log confirms (§2). Reads have no delay. The `0x0023` switch writes bypass the sleep (`CUSBENE6K7732.cs:339-350`).
If the target device index is not connected, `method_4` writes **to every connected ENE device** instead (lines 192-202) [C].

---

## 4. ENE register map (as used by the app)

All addresses are 16-bit `wIndex` values (`wValue` = 0). Byte order of colours is **R, G, B** [C] (`Light.rgb = {R,G,B}` in `ENEDataConvert.cs:22-27`; frame bytes come from `ScreenCaptureMgr.CalcRGBs`, which stores R,G,B at `3j,3j+1,3j+2`, `ScreenCaptureMgr.cs:184-187`).

### 4.1 Identification / configuration (read at plug time)
| Reg | Len | R/W | Meaning | Source |
|---|---|---|---|---|
| `0x4000`,`0x4001` | 1+1 | R | Chip ID high/low → `0x7730` (`ENEIC_E.ENE_0x7730 = 30512`) | `nat/EneEc.dll.c:4492-4500`; `ENEIC_E.cs`; check at `CUSBENE6K7732.cs:91-92` [C] |
| `0x0244` | 1 | R | Chip revision (0x77xx family) | `nat/EneEc.dll.c:4506` [C] |
| `0x0415` | 1 | R | Flash-controller command/status. The DLL treats non-zero as "trim loaded" | `nat/EneEc.dll.c:3988` [C], meaning [I] |
| `0xE0A1` | 1 | R | Number of LED groups (the app clamps it to ≤3) | `CUSBENE6K7732.cs:274`; clamp `ENEDeviceLedGroup.cs:30-37` [C] |
| `0xE0A3` | 1 | R | LED count, group 1 "Border4Sided" (read if groups ≥1) | `CUSBENE6K7732.cs:279` [C] |
| `0xE0A5` | 1 | R | LED count, group 2 "Central" (if ≥2) | `:285` [C] |
| `0xE0A7` | 1 | R | LED count, group 3 "Bottom" (if ≥3) | `:291` [C] |
| `0xE0A9` | 1 | R | LED count, group 4 "Clock4" (if ≥4; unreachable because of the clamp) | `:297` [C] |
| `0xE9F0` | 1 | R | Model-name length L | `:240` [C] |
| `0xE9F1` | L | R | Model name, ASCII, NUL-terminated (user: `34M2C8600`). The C# buffer is 15 bytes, so L>15 would overflow; cap L at 15 | `:245-248` [C] |
| `0xB500` | 5 | R | FW version bytes (user: `03 32 07 0F 0B`). `EcDEV.FWVersion` = byte[4]. All-zero bytes[0..3] → device rejected | `:257-267`, `:98-106` [C] |

### 4.2 Control / effect registers (written)
Per-group register blocks. Group g ∈ {1 = Border/4-sided, 2 = Central, 3 = Bottom, 4 = "Clock4"} has base `B(g) = 0xE010 + 0x10*g` (g1 → `0xE020`, g2 → `0xE030`, g3 → `0xE040`, g4 → `0xE050`) [C] (`Class0.cs:45-91`):

| Offset | g1 / g2 / g3 / g4 | Field | Values written | Source |
|---|---|---|---|---|
| +0x0 | `E020`/`E030`/`E040`/`E050` | `effect_sel_SWMode` ("software/direct mode" flag) | always `0` (`Effect_sel_SWMode_E.Normal`) | `Class0.cs:302-306`, `Effect_sel_SWMode_E.cs` [C] |
| +0x1 | `E021`/`E031`/`E041`/`E051` | Effect mode (`MNTLightEffect_E`, §5.1) | 0..14 | `Class0.cs:293-301` [C] |
| +0x2 | `E022`/`E032`/`E042`/`E052` | Speed (`Speed_E`) | `0x02` Low, `0x00` Normal, `0xFE` High | `Class0.cs:307-311`; `Speed_E.cs` [C] |
| +0x3 | `E023`/`E033`/`E043`/`E053` | Direction | always `0` in this version (see §5.2) | `Class0.cs:312-316` [C] |
| +0x9 | `E029`/`E039`/`E049`/`E059` | Brightness (`Bright_E`) | `0x04` Bright, `0x02` Brighter, `0x00` Brightest | `Class0.cs:317-321`; `Bright_E.cs` [C] |
| +0xF | `E02F`/`E03F`/`E04F`/`E05F` | Apply/commit | `1` | `Class0.cs:336-340` [C] |

This layout (+0 direct flag, +1 mode, +2 speed, +3 direction, separate apply) matches the ENE "Aura" RGB controller convention (`0x8020..0x8023` + apply) [I, analogy only].

| Reg | Len | Meaning | Source |
|---|---|---|---|
| `0xE980` / `0xE983` / `0xE986` / `0xE989` | 3 each | Static/base colour R,G,B for group 1/2/3/4 (used when SWMode = Normal, i.e. always) | `Class0.cs:99-121,331-334` [C] |
| `0xE100 + 3*i` | 3 | Per-LED colour for SW mode ≠ Normal (never used; the code would write the same RGB to every LED) | `Class0.cs:93,324-327` [C] |
| **`0xE300 + 3*i`** | 3 per LED | **Per-LED frame buffer** used with mode 14 (UserDefine) for FollowVideo and synced Breathing. LED order is §7.3 | `Class0.cs:534-536, 587-658` [C] |
| `0xE960`,`0xE961`,`0xE962` | 1 each | Audio level 0..255 (non-rainbow FollowAudio), same value written to all three | `Class0.cs:123-127,508-510` [C]. One register per group [I] |
| `0xE970`,`0xE971`,`0xE972` | 1 each | Audio level 0..255 (rainbow FollowAudio) | `Class0.cs:129-133,502-504` [C] |
| **`0x0023`** | 1 | "USBCableLivingSwitch": `0x04` before any ParameterSet with mode ≠ OFF, `0x00` when mode = OFF and on `UnPlug()` | `CUSBENE6K7732.cs:137-150, 303-350` [C]. Meaning: "host (PC) control active" flag [I] |

---

## 5. Parameter model

### 5.1 Device effect modes `MNTLightEffect_E` [C] (`dc/Zeasn.USB.ENE.Lib/Zeasn.USB.ENE.Lib/MNTLightEffect_E.cs`)
| Value | Name | Used by app? |
|---|---|---|
| 0 | LEDOFF | yes (effect disabled / idle) |
| 1 / 2 | StaticMode / StaticModeRainbow | yes |
| 3 / 4 | ColorShift / ColorShiftRainbow | yes |
| 5 / 6 | ColorWave / ColorWaveRainbow | yes |
| 7 / 8 | ColorBreathing / ColorBreathingRainbow | yes (Breathing when not synced) |
| 9 / 10 | FollowAudio / FollowAudioRainbow | yes (+ level stream) |
| 11 | FollowVideo | **never sent** (the app maps FollowVideo to 14 and streams frames) |
| 12 / 13 | StarryNight / StarryNightRainbow | yes |
| 14 | UserDefine | yes (FollowVideo; Breathing when synced) → frame buffer `0xE300` |

The rainbow variant is chosen by `light.rainbow` inside `Class0.method_5` (`Class0.cs:211-288`). For modes 11/14 the code forces speed=Normal(0), brightness=Brightest(0), direction=0 (`:282-287`) [C].

### 5.2 UI model → device (`ENEDataConvert.MapTMain_ParameterSet`, `dc/Zeasn.Equipment.Option.Lib/.../PHLDisplay/ENEDataConvert.cs:9-86`) [C]
| UI field (`DisplayEffectDetailInfo`) | Device field | Mapping |
|---|---|---|
| `EffectInfo.EffectEnable=false` | mode | `0` LEDOFF |
| `Effect.Value` (`EffectType`) | mode | FollowVideo(1)→14, FollowAudio(2)→9, ColorShift(3)→3, ColorWave(4)→5, Breathing(5)→14 (then overridden to 7 unless synced, `CDevice_PHLDisplay.cs:1190-1203`), StarryNight(6)→12, Static(7)→1, other→1. Rainbow variants via `IsRainbowColor` |
| `IsRainbowColor` | `light.rainbow` | bool |
| `CurRGB {R,G,B}` | `light.rgb` | bytes |
| `Brightness` 1/2/3 | `brightness` | `0x04`/`0x02`/`0x00` (other → `0x02`) |
| `Speed` 1/2/3 | `speed` | `0x02`/`0x00`/`0xFE` (other → `0x00`) |
| `CurRegion` (`RegionType`) | `device_sel_e` | AllZones(0)/default → 5 (AllZone); FourSided(1)/ThirdSidedA(4)/ThirdSidedB(5) → 1; Central(2) → 2; Bottom(3) → 3 |
| `CurDir` | `direction` | **not mapped**. `default(TMain_ParameterSet)` leaves it `0` (`Effect_DirectionChange` has no effect on ENE) |
| `IsRandomColor`, `BgRGB`, `CurStarCount` | — | not mapped |

`Device_sel_E` (`Device_sel_E.cs`): 1 Border4Sided, 2 Central, 3 Bottom, 4 Clock4, 5 AllZone.

### 5.3 Defaults (`DisplayEffectInfo.Default`, `dc/Zeasn.Equipment.Option.Lib/.../DisplayEffectInfo.cs:45-83`) [C]
For each of FollowVideo, FollowAudio, ColorShift, ColorWave, Breathing, StarryNight, Static: `Speed=2, Brightness=3, IsRandomColor=false, IsRainbowColor=true, CurRGB=Blue(0,0,255)` (Black for FollowVideo/FollowAudio), `BgRGB=Black, CurDir=-1, CurRegion=0`. `CurrEffect = Static`. The user's actual state JSON is at `logs/2026-09-25.txt:740`.

---

## 6. `ParameterSet` – exact write sequences [C]
Entry: `CUSBENE6K7732.ParameterSet(TMain, model)` (`CUSBENE6K7732.cs:137-156`):
1. `USBCableLivingSwitch`: write `0x0023 ← [mode != 0 ? 0x04 : 0x00]` (no sleep).
2. Mirror update (`Class1.method_2`, only for UI preview).
3. `Class0.method_5` (`Class0.cs:207-494`): normalise the mode (§5.1), then write depending on `device_sel_e`. Every write is followed by the 10 ms sleep.

### 6.1 AllZone (5) – the default for all effects (`Class0.cs:291-341`)
```
E021←m  E031←m  E041←m  E051←m            ; mode
E020←0  E030←0  E040←0  E050←0            ; SW mode
E022←s  E032←s  E042←s  E052←s            ; speed
E023←0  E033←0  E043←0  E053←0            ; direction
E029←b  E039←b  E049←b  E059←b            ; brightness
E980←RGB E983←RGB E986←RGB E989←RGB       ; 3 bytes each
E02F←1  E03F←1  E04F←1  E05F←1            ; apply
```
28 writes. Group-4 registers are written even though the 34M2C8600 has 3 groups.

### 6.2 Region variants
| Region | Sequence (in order) | Source |
|---|---|---|
| Border4Sided (1) = "4-sided"/"3-sided" | `E031←0, E030←0, E03F←1` (central off) · `E021←m, E020←0, E022←s, E023←0, E029←b, E980←RGB, E02F←1` · `E041←m, E040←0, E042←s, E043←0, E049←b, E986←RGB, E04F←1` (border **and bottom** on) | `Class0.cs:342-395` |
| Central (2) | `E021←0, E041←0, E020←0, E040←0, E02F←1, E04F←1` · `E031←m, E030←0, E032←s, E033←0, E039←b, E983←RGB, E03F←1` | `:396-428` |
| Bottom (3) | `E021←0, E031←0, E020←0, E030←0, E02F←1, E03F←1` · `E041←m, E040←0, E042←s, E043←0, E049←b, E986←RGB, E04F←1` | `:429-462` |
| Clock4 (4) (unused) | `E051←m, E050, E052, E053, E059, E989←RGB, E05F←1` | `:463-492` |

### 6.3 Worked example (user's log): FollowVideo, AllZones, rainbow flag ignored
`0023←04`; mode 14 (`0x0E`), speed 0, brightness 0, dir 0, colour = CurRGB (0,0,0):
`E021..E051←0E`, `E020..E050←00`, `E022..E052←00`, `E023..E053←00`, `E029..E059←00`, `E980/E983/E986/E989←00 00 00`, `E02F..E05F←01`. After that, frames go to `0xE300` (§7).

Static red, brightness 3, speed irrelevant: `0023←04`, mode `01` in `E021..E051`, speed `00`, bright `00`, colour `FF 00 00` ×4, apply ×4.
Effect off: `0023←00`, then mode `00` in all groups + apply.

### 6.4 When `ParameterSet` is called (`CDevice_PHLDisplay.method_17`, line 1190) [C]
It is called on plug (`method_14`, line 754), `Effect_Enable`, `Effect_Change`, `Effect_ColorChange` (which also clears rainbow/random), `Effect_RainbowEnable`, `Effect_RandomEnable`, `Effect_BgColorChange`, `Effect_DirectionChange`, `Effect_RegionChange`, `Effect_Reset`, and on `Effect_SpeedChange`/`Effect_BrightnessChange` **except** when the current effect is FollowVideo/FollowAudio/Breathing (`:1088-1121`). It is also called on idle enter/leave (`EffectEnableTemp`, `:954-972`), sync (`method_16`, `:881-952`) and breathing mode switch (`OnBreathing`, `:1269-1316`). If Breathing is not synced, `method_17` calls `ParameterSet` twice with mode 7/8 (a harmless duplicate).

---

## 7. FollowVideo ("光影同步") – software screen sync

### 7.1 Capture pipeline (Windows) [C]
- `EffectTimerMgr` threads (`EffectTimerMgr.cs:65-175`):
  - **Capture thread** `method_0`: while enabled, `ScreenCaptureMgr.CaptureScreen()` then `Sleep(300)`, pushed into `ScreenBitmapQueue` (max 2, oldest dropped; `ScreenBitmapQueue.cs`). The enable flag defaults to `true` (`:29`), so one or more captures happen right at startup before the first `EnableFollowVideoTimer(false)`.
  - **Frame thread** `method_2`: every 100 ms, take a bitmap (`GetBitmap` returns a *clone of the same frame* if only one is queued), compute `CalcRGBs(6,7,3,5,11,bmp)` (a 5-sample strip used by keyboards/mice), and raise `EVT_Effect.Effect_VideoData (bitmap, strip)`.
- `CaptureScreen()` with no argument captures **`Screen.PrimaryScreen`**, not necessarily the Evnia monitor (`ScreenCaptureMgr.cs:43-71`). Implementation: `SetThreadDpiAwarenessContext(-4 = PER_MONITOR_AWARE_V2)`, find the monitor rect by `MONITORINFOEX.szDevice`, `new Bitmap(w,h,Format24bppRgb)`, `BitBlt(..., GetDC(GetDesktopWindow()), SRCCOPY 0x00CC0020)` (`ScreenCaptureMgr.cs:73-145`; `dc/Zeasn.PCenter.Base.Lib/Class0.cs:11,23,29`).
- `SystemOper.OnVideoData` (`SystemOper.cs:1765-1780`) calls `OnFollowVideo` on every connected device whose `EffectType == FollowVideo` and **waits** for them (`Task.WaitAll`).
- `CDevice_PHLDisplay.OnFollowVideo` (`:1223-1246`) requires `ENEEffectEnable && CurrEffect == FollowVideo`, then `ParameterVideoSync(CalcRGBs(50, 40, bmp), model)`.

Effective rate: fresh screen content about every 300 ms. LED writes happen about every 100 ms + 6 writes × ~15.6 ms ≈ **5 Hz** [C for sleeps, I for the resulting rate].

### 7.2 Grid sampling (`CalcRGBs(width=50, height=40)`, `ScreenCaptureMgr.cs:147-203, 312-342`) [C]
- Screen W×H px. Cell width `cw = W/50` (integer), height `ch = H/40`. The **last column/row absorbs the remainder** (`W - cw*49`, `H - ch*39`).
- Cell (row r, col c) origin `(c*cw, r*ch)`. Its colour is the **integer mean of 5 pixels**: the 4 corners `(x0,y0)`, `(x0+w-1,y0)`, `(x0,y0+h-1)`, `(x0+w-1,y0+h-1)` and the centre `(x0+w/2, y0+h/2)`. The source is BGR(A) and the output is R,G,B.
- Output: `byte[40][150]`, row-major, `[r][3c..3c+2] = R,G,B`.
- For 3440×1440: `cw=68` (last col 108 px), `ch=36`.

### 7.3 Grid → LED mapping and write layout (`Class0.method_7..10`, `Class0.cs:516-658`) [C]
Constants: grid width `Wg=50`, height `Hg=40`, `half = 25` (`GetHalfValue` = int/2, `dc/Zeasn.Com.Lib/Zeasn.Com.Lib/Extension.cs:130`). `round()` = `Convert.ToInt32(double)` = **round-half-to-even** (`Extension_Number.cs:35-45`).
Counts: **border sub-counts come from `PCenter_AmbiglowInfo.json`**. **Central and bottom counts come from device registers `0xE0A5/0xE0A7`.** Base addresses come from device counts: `A1 = 0xE300`, `A2 = A1 + 3*Border(dev)`, `A3 = A2 + 3*Central(dev)`.

| Segment (write order) | LED k | Grid cell | Written at |
|---|---|---|---|
| Right, n=RightLedCount | k=0..n-1 | row `round((n-k)*40/(n+1))`, col 49 (bottom→top) | `A1` + 3k |
| RightUp, n=RightUpLedCount | k=0..n-1 | row 0, col `round(49 - k*25/n)` (right edge→centre) | continues |
| LeftUp, n=LeftUpLedCount | k=0..n-1 | row 0, col `round((n-1-k)*25/n)` (centre→left edge) | continues |
| Left, n=LeftLedCount | k=0..n-1 | row `round((k+1)*40/(n+1))`, col 0 (top→bottom) | continues. The 4 blocks are 4 separate writes |
| Central, n=Central(dev) | k=0..n-1 | row `round(k*40/n)`, **col 25** (vertical centre line, top→bottom) | `A2`, one write |
| Bottom, n=Bottom(dev) | k=0..n-1 | row 39, col `round(k*50/n)`; **last LED forced to col 49** | `A3`, one write |

No apply/commit register is written after frames. Mode 14 displays the buffer directly [C for "no commit", I for firmware behaviour].

#### Concrete table for the 34M2C8600 (JSON: R=3, RU=4, LU=4, L=3, C=18, B=14; device counts assumed 14/18/14 [I], corroborated by the renderer slicing `slice(0,14)` border / `slice(14,32)` central at `rp/Ambiglow-Dvqon39u.js:274-275`)
| LED | Reg | Segment | Grid (row,col) |
|---|---|---|---|
| 0 | E300 | Right | (30,49) |
| 1 | E303 | Right | (20,49) |
| 2 | E306 | Right | (10,49) |
| 3 | E309 | RightUp | (0,49) |
| 4 | E30C | RightUp | (0,43) |
| 5 | E30F | RightUp | (0,36) |
| 6 | E312 | RightUp | (0,30) |
| 7 | E315 | LeftUp | (0,19) |
| 8 | E318 | LeftUp | (0,12) |
| 9 | E31B | LeftUp | (0,6) |
| 10 | E31E | LeftUp | (0,0) |
| 11 | E321 | Left | (10,0) |
| 12 | E324 | Left | (20,0) |
| 13 | E327 | Left | (30,0) |
| 14..31 | E32A + 3(k-14) | Central | rows 0,2,4,7,9,11,13,16,18,20,22,24,27,29,31,33,36,38 @ col 25 |
| 32..45 | E360 + 3(k-32) | Bottom | row 39, cols 0,4,7,11,14,18,21,25,29,32,36,39,43,**49** |

Per frame the host sends 6 control-OUT transfers: 9 B @E300, 12 B @E309, 12 B @E315, 9 B @E321, 54 B @E32A, 42 B @E360 (138 bytes total, contiguous `0xE300..0xE389`).

Other models in `Evnia Precision Center/resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json` [C]:

| Model | R | RU | LU | L | Center | Bottom |
|---|---|---|---|---|---|---|
| 49M2C8900L / 49M2C8900 | 3 | 9 | 9 | 3 | 20 | 0 |
| 42M2N8900 | 4 | 4 | 4 | 4 | 34 | 0 |
| **34M2C8600** | **3** | **4** | **4** | **3** | **18** | **14** |
| 34M2C7600MV | 3 | 4 | 4 | 3 | 22 | 14 |
| 34M2C6500 | 3 | 4 | 4 | 3 | 18 | 0 |
| 34M2C5501 | 4 | 5 | 5 | 4 | 0 | 0 |
| 32M2N8900 / 32M2N8800 | 4 | 5 | 5 | 4 | 24 | 0 |
| 32M2N6800MW / ML / M | 4 | 4 | 4 | 4 | 13 | 0 |
| 32M2N6800MD | 4 | 4 | 4 | 4 | 0 | 0 |
| 27M2N8800 / 27M2N8500X / 27M2N6500P / 27M2N6500 | 4 | 5 | 5 | 4 | 0 | 0 |
| 27M2N8500 | 4 | 5 | 5 | 4 | 12 | 0 |
| 27M2N5900A | 4 | 4 | 4 | 4 | 0 | 0 |

`WriteType` (always 1) is a private property and is ignored by the deserializer (`GClass1.cs:141-155`). The file is loaded from `res/data/ENE/PCenter_AmbiglowInfo.json` (`GClass0.cs:15-23`, originally `ENELightStaticTable`/`ENELightNumbersData`). A device whose `0xE9F1` name is not in this list is still opened but gets `ModelName=""` and is never used [C] (`CUSBENE6K7732.cs:248-253`).

Frame preconditions: `rows ≥ 40` and `row[0].Length ≥ 50` (bytes; 150 are actually needed) (`Class0.cs:528`).

### 7.4 Preview mirror (`Effect_GetLEDs`) [C]
`Class1` (`dc/Zeasn.USB.ENE.Lib/Class1.cs`) keeps an `RGB[]` "what the LEDs show", which `Effect_GetLEDs` returns (`CDevice_PHLDisplay.cs:1205-1212`, only in FollowVideo/FollowAudio, otherwise error `"not ene follow video or audio"`). Vendor bugs: the right segment uses `RightUpLedCount` (`Class1.cs:56-64`), and the Central/Bottom loops in `method_2` never execute (`:150-165`). For FollowAudio the colours are scaled by `level/255` (`:27-38`). The renderer polls it every ~30 ms + RTT (`rp/Ambiglow-Dvqon39u.js:254-263`) and uses 14 border (reversed) + 18 central for this model.

---

## 8. FollowAudio ("光音同步") – music sync

### 8.1 Capture (`dc/Zeasn.Audio.Sync.Lib/Zeasn.Audio.Sync.Lib/AudioSyncController.cs`) [C]
- NAudio `WasapiLoopbackCapture()` on the **default render endpoint** (`:179-184`). On `DataAvailable` (`:117-157`) the latest buffer is converted to `float[]` (assumes 32-bit float: `BitConverter.ToSingle`, stride = BitsPerSample/8) and **replaces** the previous buffer. If the default render endpoint is **muted**, the buffer is emptied, which gives level 0.
- A watchdog task restarts capture if no data arrives for >3 s (`:261-289`). It also restarts on `OnDefaultDeviceChanged` via `IMMNotificationClient` (`:16-55,200-208`).
- `GetDftData(minHz=0, maxHz=2500, sqrt=1)` (`:291-359`, parameters from `GlobalData.cs`): de-interleave, **average channels**, truncate to `N = 2^floor(log2(frames))`, NAudio `FastFourierTransform.FFT(forward:false, m, data)`. That is an unscaled transform, so the magnitudes equal unnormalised |DFT| [I from NAudio behaviour]. Keep bins `[0 .. N/2)`, then slice `[minBin, maxBin)` with `binHz = SampleRate / N` (**integer division**), `minBin = 0/binHz = 0`, `maxBin = 2500/binHz`, and apply `sqrt()` once per value.
- The chunk size depends on NAudio's polling (about half of its 100 ms default buffer ≈ 2400 frames @48 kHz → N=2048, binHz=23, 108 bins) [I; the NAudio.Wasapi version/internals are not in the corpus].

### 8.2 Level heuristic (`AudioSyncUtil.ConvertToSingleData`, `AudioSyncUtil.cs:48-75`; constants `GlobalData.cs:9-49`) [C]
```
avg = mean(d); mx = max(d)
mx = min(mx, avg*5.0)            ; MaxMultipleAverage
mx = min(mx, 50.0)               ; MaxPercent
mx = max(mx, 5.0)                ; MinPercent
v  = (avg + (avg > mx*0.1 ? 0.1*mx : 0)) * 1.5   ; ExceptBarDataMoveUpMin/Multiple, ExceptBarWaveStrenghMultiple
v  = min(v, mx)
level = (byte)(v / mx * 255)     ; empty spectrum -> 0
```

### 8.3 Scheduling and output [C]
- `EffectTimerMgr.method_3` (`EffectTimerMgr.cs:127-159`): every **40 ms**, compute level (plus an RGB palette crossfade used only by keyboards/mice: 8 colours, +5 % per tick). Raise `Effect_AudioData (dft[], level, rgb)`.
- `CDevice_PHLDisplay.OnFollowAudio` (`:1248-1267`) → `ParameterAudioSync(level, ...)` → `Class0.method_6` (`Class0.cs:496-514`): write `level` (1 byte) to `0xE960, 0xE961, 0xE962` (non-rainbow) or `0xE970, 0xE971, 0xE972` (rainbow), each followed by the 10 ms sleep. The effect itself (mode 9/10, colour, region) was set earlier by `ParameterSet`. Effective update rate about 11 Hz [I].

---

## 9. Breathing and other effects [C]
- Static, ColorShift, ColorWave, StarryNight and **Breathing (when not synced)** are **firmware-rendered**. The PC only sends `ParameterSet`.
- Breathing when the display is in a Light-Sync group with more than one device (`IsCanBreathingSync`, `dc/Zeasn.Equipment.Base.Lib/.../CDeviceEffectBase.cs:165-177`): mode 14 plus a software breathing curve every 40 ms (`EffectTimerMgr.method_4`) → `SystemOper.OnBreathingData` (`SystemOper.cs:1799-1847`). Brightness factor `f = clamp(Brightness,1,3)/3`. The ramp goes up `0..Nup` (Nup = 6/4/2 steps for speed 1/2/3) and down from `Ndown` (24/16/8). Output = `rgb*f*(step/N)` with the current N. Rainbow cycles an 8-colour palette (`SystemOper.cs:59-69`) once per cycle. `OnBreathing` (`CDevice_PHLDisplay.cs:1269-1316`) fills a 40×50 grid with that colour and calls `ParameterLedSync`, so all LEDs get the same colour through the §7.3 mapping. **Irrelevant for this user** (no other Philips devices).

---

## 10. Bridge API for this area (JSON contract to keep if the renderer is reused) [C]
`device` is `DeviceType`; the monitor is `PHL_CDeviceDisplay = 100000` (`dc/Zeasn.PCenter.Entity.Lib/.../DeviceType.cs:13`). Results are `JsonResult {err_code (0 ok / 9 error), err_msg, RequestId, Tag, FunctionName, CurrItem}` (`dc/Zeasn.Com.Lib/Zeasn.Com.Lib/JsonResult.cs`).

| Function (Bridge.cs line) | Params | Behaviour (ENE mode) | DDC mode |
|---|---|---|---|
| `Effect_GetMenu` (429) | device | `DisplayEffectMenu.Default(model)` (§10.1) | same object |
| `Effect_GetColorData` (419) | – | `Config/color.data` (JSON line) or defaults: 13 `DefColors` (white, red, (255,0,127), (127,0,127), (127,0,255), blue, (0,127,255), cyan, (0,255,127), green, (127,255,0), yellow, (255,127,0)), `SelfColors:""` (`EffectColorData.cs`) | same |
| `Effect_SetSelfColors` (424) | `"#rrggbb,#rrggbb,..."` (renderer caps at 14) | saves to `color.data` | same |
| `Effect_Enable` (439) | device, bool | EffectInfo.EffectEnable → ParameterSet (mode 0 when false) → save; disabling also cancels sync | writes VCP `E2A019` = saved mode or `0` |
| `Effect_Change` (444) | device, EffectType int | CurrEffect → ParameterSet → returns EffectInfo | error `"Not Support ENE"` (the renderer writes VCP itself via PHL_SetOSD) |
| `Effect_RandomEnable` / `Effect_RainbowEnable` (449/454) | device, bool | set flag → ParameterSet | error |
| `Effect_ColorChange` (459) | device, r, g, b | CurRGB, rainbow=false, random=false → ParameterSet | error |
| `Effect_BgColorChange` (464) | device, r, g, b | stored, ParameterSet (no device effect) | error |
| `Effect_SpeedChange` / `Effect_BrightnessChange` (469/474) | device, 1..3 | stored; ParameterSet unless FollowVideo/FollowAudio/Breathing | error |
| `Effect_DirectionChange` (479) | device, DirectionType | stored; ParameterSet (direction always 0) | error |
| `Effect_RegionChange` (484) | device, RegionType | stored; ParameterSet with region mapping | error |
| `Effect_Reset` (489) | device | remove from sync, EffectInfo = defaults, ParameterSet | write `E2A038 = 1`, wait 200 ms, re-read `E2A019..1E` (`CDevice_PHLDisplay.cs:1163-1182`) |
| `Effect_GetLEDs` (434) | device | `RGB[]` mirror (§7.4) | error |
| `Effect_CheckDynamicLightingEnabled` (409) | – | int: `-1` no value, `0` off, `1` on (registry) | – |
| `Effect_OpenDynamicLightingSetting` (414) | – | launches `ms-settings:personalization-lighting` | – |
| `SyncEffect_GetData` (494) | – | `T_Sync_Profile {EffectDetailInfo, SyncDevices[]}`. With ≤1 device syncing, all `SyncStatus=false` (`SystemOper.cs:1518-1533`) | – |
| `SyncEffect_EnableDevice` (499) | device, JSON `[{DeviceType, ModelName, ExtValue}]` | builds the sync group, raises `Effect_Sync` (`SystemOper.cs:1535-1635`) | – |
| `AmbiScape_EnableFollowVideo` (49) | bool, intervalMs | §13 | – |
| `Setting_TurnOffLightsWhenIdle` (28) | bool | §11 | – |
| `Setting_TurnOffLightsWhenIdleDuration` (34) | minutes ≥1 (else error `"at last 1 minutes"`) | §11 | – |

Notifications (SignalR `"Notification"` with a serialized `JsonResult`, `HandleEvent.cs:92-104`):
- `NotifyUIDisplayEffectChange`: `Tag` is a C# ValueTuple `(bool ENEEffectEnable, DisplayEffectInfo, DisplayModuleAmbiglow)` (`CDevice_PHLDisplay.cs:786-792, 851-857`). Newtonsoft serialises it as `Item1/Item2/Item3` [I, consistent with other tuple consumers using `Item1/Item2` at `rp/SmartImage-DuKfuYFN.js:72`]. The renderer reads `a.ENEEnable / a.EffectInfo / a.ModuleAmbiglow` (`rp/Monitor-D4qz4RBn.js:85-90`), which is a vendor mismatch [I]. A port should send `{ENEEnable, EffectInfo, ModuleAmbiglow}`.
- `NotifyEffectChange` `{DeviceType, Data: EffectInfo}`; `NotifyEffectSyncDevicesChange` (T_Sync_Profile); `NotifyAmbiScapeFollowVideoData` (§13).

### 10.1 `Effect_GetMenu` content for 34M2C8600 (`DisplayEffectMenu.cs:51-163`) [C]
Base item: `SupSync=true, SupSpeed=true, Min/MaxSpeed=1/3, SpeedStep=1, SupBrightness=true, Min/MaxBrightness=1/3, BrightnessStep=1, SupRandomColor=false, SupRainbowColor=true, SupColor=true, SupBgColor=false, SupDir=false, SupRegion=false, SupStarCount=false`. Per effect:
- FollowVideo: speed/brightness/rainbow/colour/region all false.
- FollowAudio: no speed/brightness; rainbow + colour; regions.
- ColorShift/ColorWave/Breathing: all true + regions.
- StarryNight: speed/brightness/rainbow/colour, no region.
- Static: no speed; brightness/rainbow/colour + regions.

`RegionList` for this model (JSON: bottom>0, all four edges>0, centre>0) = `[AllZones(0), Bottom(3), FourSided(1), Central(2)]`, `SupRegion=true`. `EnumItem` JSON = `{"Name":"FollowVideo","Text":"光影同步","Value":1}`.

---

## 11. "Turn off lights when idle" [C]
- Stored in `%APPDATA%/EvniaServe/Config/SoftConfig.data` as one JSON line (UTF-8 BOM). User's file: `{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5}` (`SoftConfigInfo.cs`, defaults false/5; `WorkspacePath.cs:34`; `GlobalOper.cs:23-53,77-106`).
- Every **1 s** after the first SignalR connection (`dc/EvniaServe/Evnia/EvniaHub.cs:41-49` → `SystemOper.RunPerSecondAtStart`, `SystemOper.cs:304`), `GlobalOper.CheckIdle()` sets `IsIdle = (now - GetLastInputInfo) >= Duration*60000` if enabled (`GlobalOper.cs:108-118`; `dc/Zeasn.Win.Lib/Zeasn.Win.Lib/CWinSysWithoutOperate.cs`).
- An `IsIdle` change raises `EffectEnableTemp` → `SystemOper.EffectEnableTemp` (`SystemOper.cs:1481-1502`). For each device, `EffectEnableTemp(!idle)`. On idle, all effect timers stop (capture/audio/breathing); on return they restart per effect. On the monitor:
  - ENE: `ParameterSet` with a *copy* of EffectInfo whose `EffectEnable=idle?false:true` (mode 0 + `0x0023←0` on idle; full restore on wake).
  - DDC: `E2A019` ← 0 (AmbiglowOff) or back to the stored mode (`CDevice_PHLDisplay.cs:954-972`).

---

## 12. Windows 11 "Dynamic Lighting" [C]
`DynamicLghtingUtil.cs:9-26`: returns `HKCU\Software\Microsoft\Lighting\AmbientLightingEnabled` as −1/0/1 and opens `ms-settings:personalization-lighting`. The renderer polls every 2 s while the Ambiglow page is open and shows `ToDynamicLightingTip` ("To configure Ambiglow, disable Dynamic Lighting in Windows Settings.") when the value is 1. It stops polling when the value is −1 (`rp/Ambiglow-Dvqon39u.js:884-895`; strings `rp/styles-DAnQi2A8.js:14831`). There is **no** LampArray/HID code anywhere in the app or in `EneEc.dll` (no `hid.dll` imports, `nat/EneEc.dll.symbols.txt`). The warning suggests the ENE's HID interface (`mi_01`) is a HID LampArray that Windows can take over [I].

---

## 13. AmbiScape follow-video (smart bulbs) [C]
`AmbiScapeOper` (`dc/Zeasn.Equipment.Option.Lib/.../AmbiScapeOper.cs`) subscribes to `Effect_VideoData`. When enabled via `AmbiScape_EnableFollowVideo(true, interval)` (the renderer passes 100 ms, `rp/main-CDosWiM3.js:2179-2188`; default 2000 ms), it samples an **8×6** grid (`CalcRGBs(8,6)`) and averages 10 zones:
- L3 = rows 0–2 @ col 0
- L4 = row 0 cols 1–2
- T = row 0 cols 3–4
- R4 = row 0 cols 5–6
- R3 = rows 0–2 @ col 7
- R2 = rows 3–5 @ col 7
- R1 = row 5 cols 5–6
- B = row 5 cols 3–4
- L1 = row 5 cols 1–2
- L2 = rows 3–5 @ col 0

It pushes `NotifyAmbiScapeFollowVideoData {L1..L4,T,R1..R4,B: {R,G,B}}` to the renderer. The renderer converts each zone to HSV and calls Electron `ipc.invoke("setBulbAttribute", uniqueId, endpointId, "HSV", {H,S[,V]})` (`rp/main-CDosWiM3.js:2152-2175`). That goes to Matter controller subprocesses in the main process (`work/app-pretty/main/index.js:17019-17032`) [C]. It depends on the network (LAN/Matter; the renderer checks `isNetworkOnline`), and the user has no bulbs, so **drop**.

---

## 14. DDC fallback path (for completeness; transport in the DDC report) [C]
VCP opcodes are "TPV extern" 3-byte codes `E2 A0 xx` (`E2A0_ExternVCPOpCode_E.cs`, e.g. `EXT_OP_E2A0_38_AmbiglowSet = 0xE2A038`). The data model is `DisplayModuleAmbiglow` (`dc/Zeasn.Equipment.Option.Lib/.../DisplayModuleAmbiglow.cs`).

| Code | Enum (file under `dc/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/`) | Values |
|---|---|---|
| `E2A019` LightMode | `E2A0_19_AmbiglowLightMode_E.cs` | 0 Off, 1 FollowVideo, 2 FollowAudio, 3 ColorShift, 4 ColorWave, 5 ColorBreathing, 6 StarryNight, 7 Static, 8 ColorFlowReverse, 9 ColorFlow (34M2C8600 caps: 00–07) |
| `E2A01A` Colors | `E2A0_1A_AmbiglowColors_E.cs` | 0 Rainbow, 1 White, 2 Red, 3 Rose, 4 Magenta, 5 Violet, 6 Blue, 7 Azure, 8 Cyan, 9 Aqua, 10 Green, 11 Pear, 12 Yellow, 13 Orange |
| `E2A01B` Position | `E2A0_1B_AmbiglowLightPosition_E.cs` | 0 AllZones, 1 4-sided, 2 Central, 3 Bottom, 4 3-sided-A, 5 3-sided-B, 6 Right-Left (caps: 00–03) |
| `E2A01C` Brightness | `..._1C_...` | 0 Bright, 1 Brighter, 2 Brightest |
| `E2A01D` Speed | `..._1D_...` | 0 Low, 1 Normal, 2 High |
| `E2A01E` Direction | `..._1E_...` | 0 R→L, 1 L→R (not in 34M2C8600 caps; profile shows err_code 9) |
| `E2A038` AmbiglowSet | – | write 1 = reset to factory Ambiglow settings |

"Off" is emulated by writing `E2A019=0` while remembering the previous mode (`CDevice_PHLDisplay.cs:974-1008`). In this mode **FollowVideo/FollowAudio are done by the monitor itself** (the PC never streams without ENE, `:1233,1255`) [C]. This gives a capture-free option on Linux [I: that the monitor firmware really does it, but the OSD exposes these modes].

---

## 15. `Zeasn.Display32.Lib` – what it is [C]
It is not a capture library. It contains monitor enumeration (`EnumDisplayMonitors`, `GetMonitorInfo`, `EnumDisplayDevices`, `EnumDisplaySettings`, `MonitorFromPoint/Window`, `dc/Zeasn.Display32.Lib/Zeasn.Display32.Lib/Monitor.cs:232-653`), DPI helpers (`DPIAware.cs`), Win32 structs/error constants (`Structs.cs`, `WinError.cs` – DXGI constants only as error codes), and the COM `IVirtualDesktopManager` (`VirtualDesktop.cs`, `Zeasn.Display32.Lib.COM/*`). Its only consumers are FancyZones (`dc/Zeasn.Equipment.Option.Lib/.../FancyZonesOper.cs:9,90,170`; `dc/Zeasn.FZ32.Lib/Zeasn.FZ32.Lib.FancyZones/EditorParameters.cs:187,205`). Screen capture is `ScreenCaptureMgr` (GDI BitBlt, §7.1). No DXGI Desktop Duplication is used anywhere in this area.

---

## 16. Vendor quirks worth knowing (do not copy blindly)
1. Capture targets the **primary** screen, not the Evnia (`ScreenCaptureMgr.cs:48-50`).
2. Only 5 pixels per cell are sampled, so flat colours are fine but detailed content flickers (`ScreenCaptureMgr.cs:312-342`).
3. `GetBitmap` re-emits the same frame between captures, so ~2/3 of LED writes are duplicates (`ScreenBitmapQueue.cs:385-406`).
4. Direction is never sent. Speed/brightness changes are not applied live for FollowVideo/FollowAudio/Breathing.
5. `Class1` preview mirror bugs (§7.4). `NotifyUIDisplayEffectChange` tuple/field-name mismatch (§10).
6. `0x0023` is not released at process exit (only on OFF, `UnPlug`, and before OTA at `PHLDisplayFW.cs:377`).
7. `0xE9F1` read into a 15-byte buffer without a length cap.
8. `Plug()` first calls `UnPlug()` (writes `0x0023←0`) on every USB change, so the LEDs may briefly revert to firmware behaviour on unrelated USB hot-plug events [I].
9. `EffectTimerMgr` capture flag defaults to `true` (one capture at startup).

---

## Linux port plan (this area)

### A. ENE USB driver (user space, libusb-1.0 / pyusb / rusb)
1. **Permissions**: udev rule, e.g. `/etc/udev/rules.d/70-evnia-ambiglow.rules`:
   `SUBSYSTEM=="usb", ATTRS{idVendor}=="0cf2", ATTRS{idProduct}=="a201", MODE="0660", TAG+="uaccess"`
2. **Discovery**: enumerate `0cf2:a201`. Hotplug via libusb hotplug or udev monitor, replacing the Windows `vid_0cf2` path check. Optionally accept other `0cf2:*` devices only after they read chip ID `0x7730` (do not probe unrelated ENE devices by default). Optionally verify the MS OS 2.0 DeviceInterfaceGUID `{6987B675-...}`/`{8B0F5A33-...}`.
3. **Open**: do not detach the HID interface (`mi_01`, kernel `usbhid`). Control transfers to recipient=device need no claimed interface on Linux usbfs. To mimic Windows' exclusive open, claim the vendor-class interface (find `bInterfaceClass==0xFF` in the config descriptor; expected interface 0 [I]).
4. **Primitives** (timeout 1000 ms):
   ```c
   int ene_read (h, uint16_t reg, uint8_t *buf, uint16_t n) { return libusb_control_transfer(h, 0xC0, 0x81, 0x0000, reg, buf, n, 1000); }
   int ene_write(h, uint16_t reg, const uint8_t *buf, uint16_t n) { r = libusb_control_transfer(h, 0x40, 0x80, 0x0000, reg, (uint8_t*)buf, n, 1000); usleep(10000); return r; }
   ```
   Keep the 10 ms post-write pacing initially (vendor behaviour). The OS/USB stack is not the bottleneck, so reducing it to ~1–2 ms is a test item.
5. **Probe** (read-only, safe):
   - `0x4000,0x4001` → must be `0x77 0x30`
   - `0x0244` (rev)
   - `0x0415` (log only; **never run the trim/flash sequence**)
   - `0xE0A1` groups; `0xE0A3/0xE0A5/0xE0A7` counts per group
   - `0xE9F0` len (cap 15) + `0xE9F1` name
   - `0xB500` ×5 (reject if bytes 0..3 are all zero)

   Match the name against the model table (§7.3), embedding `PCenter_AmbiglowInfo.json`. Match the DDC/EDID model name with the regex `^((PHL )|(PHL_)|(PHL))?<name>$` (case-insensitive) (`CUSBENE6K7732.cs:123-135`).
6. **Set effect**: implement §6 exactly (sequence tables), including `0x0023` ←4 / ←0.
7. **Stream frame** (mode 14): compute the 46-LED array (§7.3) and send it as the vendor's 6 writes (or, after testing, one 138-byte write at `0xE300` [I]). Target 15–30 Hz, dropping frames if USB is busy.
8. **Audio level**: write the level byte to `0xE960..62` or `0xE970..72` (rainbow) every 40 ms.
9. **Release**: on exit/suspend write `0x0023←0` (improvement over vendor), or set mode 0. On resume/hotplug re-run probe + `ParameterSet`.
10. **Persist** effect state in a local JSON file (same schema as `EffectInfo`, §5.3), not the vendor's `.pcenter` store.

### B. Screen capture for FollowVideo
- **Pick the output** by EDID: read `/sys/class/drm/card*-*/edid`, match manufacturer `PHL` / product `0xC29F`, and map to the RandR output (X11) or `wl_output.name`/`xdg_output` (Wayland). Default to that output, not "primary". Offer a manual override.
- **X11**: XRandR for the CRTC rectangle. `XShmGetImage` of the root window restricted to that rectangle (or `xcb_shm_get_image`), 10–30 fps. Optionally grab only the needed cells: with the vendor layout only grid row 0, row 39, col 0, col 49 and col 25 are used.
- **Wayland (generic)**: `org.freedesktop.portal.ScreenCast` (CreateSession → SelectSources{types: MONITOR, multiple: false, cursor_mode: HIDDEN, persist_mode: 2} → Start → OpenPipeWireRemote). Consume the PipeWire video stream (SHM or DMA-BUF), preferring a small negotiated size where the compositor supports scaling. Store the `restore_token` so the consent dialog appears once. Requires the user's one-time consent; this is local only and not an online feature.
- **wlroots** compositors: `ext-image-copy-capture-v1` / `wlr-screencopy-unstable-v1` as an alternative. Avoid KMS `kmsgrab` (needs CAP_SYS_ADMIN).
- **Downsample** to 50×40. Two modes:
  - "vendor-exact": 5-point sampling per cell, integer means, last row/col remainder (§7.2)
  - "smooth" (recommended default): full-cell mean via area-averaged downscale, plus optional temporal smoothing
- **Map** with the §7.3 formulas using `round-half-even` for bit-exact parity.
- HDR: the portal gives SDR frames, which matches Windows GDI behaviour [I].
- **Zero-capture alternative**: when the user prefers, use the DDC path `E2A019=1` (monitor-native FollowVideo). Needs a hardware test to confirm whether it works while ENE/USB is connected (Open questions).

### C. Audio loopback for FollowAudio
- **PipeWire** (preferred): `pw_stream` capture with `stream.capture.sink = true` (monitor of the default sink), `F32` interleaved, 48 kHz. Follow default-sink changes (metadata `default.audio.sink`).
- **PulseAudio** / pipewire-pulse: record from `@DEFAULT_MONITOR@` (pa_simple or libpulse), F32LE.
- Mute: if the default sink is muted, send level 0 (vendor behaviour).
- **Level**: every 40 ms take the most recent `N=2048` mono samples (mean of channels), unscaled FFT magnitude, bins `[0, 2500/(sr/N))` with integer `sr/N`, `sqrt` once, then §8.2 exactly. Tune N if the result differs (Open questions).
- Linux monitor sources deliver continuous silence, so the vendor's 3 s "no data → restart" watchdog is unnecessary.

### D. Idle turn-off
Poll every 1 s. Get idle time from:
- X11: `XScreenSaverQueryInfo` (libXss)
- Wayland: `ext-idle-notify-v1` where available
- GNOME: `org.gnome.Mutter.IdleMonitor.GetIdletime`
- KDE: `org.freedesktop.ScreenSaver.GetSessionIdleTime`
- Fallback: logind `IdleHint`

On transition, apply §11 behaviour (mode 0 + `0x0023←0`; restore on activity). Persist `{TurnOffLightsWhenIdle, TurnOffLightsWhenIdleDuration}` (minutes ≥1).

### E. Stubs / drops
- `Effect_CheckDynamicLightingEnabled` → return `-1` (the renderer then stops polling and hides the tip). `Effect_OpenDynamicLightingSetting` → no-op success.
- `AmbiScape_EnableFollowVideo` → no-op success (drop bulbs/Matter).
- `SyncEffect_*` → keep minimal: `SyncEffect_GetData` returns `{EffectDetailInfo:null, SyncDevices:[]}` (or the display only, `SyncStatus:false`); `SyncEffect_EnableDevice` → no-op. The user owns no Philips peripherals.
- `Effect_GetLEDs` → return the last 46-LED frame actually sent, in `0xE300` order (a better preview than the vendor mirror). The renderer slices `[0,14)` border / `[14,32)` central.
- Keep `Effect_GetMenu`, `Effect_GetColorData`/`Effect_SetSelfColors` (local file) as in §10.

### F. Safety / bring-up checklist
1. Read-only probe first (§A.5) and log all values. Confirm `0x7730`, name `34M2C8600`, counts 14/18/14, FW `03 32 07 0F 0B`.
2. Test `0x0023←04` + Static red (§6.3). Then mode 14 + one frame. Then FollowAudio level writes.
3. Never write to `0x04xx` (flash controller), `0x0202` (E51RST), `0x0600` (WDTCFG) or any address not listed in §4. Never run `Ec_ResetAndStop`/`Ec_Run` equivalents.
4. Never invoke the ENE firmware updater.

---

## Online touchpoints (this area)

| What | Where | Trigger | Endpoint | Strip recommendation |
|---|---|---|---|---|
| AmbiScape bulb colour streaming (Matter/Wi-Fi bulbs) | `dc/Zeasn.Equipment.Option.Lib/.../AmbiScapeOper.cs`; `rp/main-CDosWiM3.js:2152-2188`; `work/app-pretty/main/index.js:17019-17032` (`setBulbAttribute` → Matter controller process) | Bulb paired + AmbiScape enabled | LAN Matter/IP (plus whatever the Matter layer uses; see main-process report) | Drop entirely. Stub `AmbiScape_EnableFollowVideo` |
| ENE (Ambiglow) firmware OTA | `dc/Zeasn.Monitor.Lib/Zeasn.Monitor.Lib.ScalerFW.Operator.OperatorHandler/Ambiglow.cs` (runs a downloaded updater with `/usb /index:N`, `/c`, `/s`); `dc/Zeasn.Monitor.Lib/Class20.cs:374-400`; device list `dc/Zeasn.Equipment.Option.Lib/.../PHLDisplayFW.cs:485-507` (uses `EcDEV.FWVersion/VID/PID`); `UnPlug()` before OTA `PHLDisplayFW.cs:377` | User-initiated display FW update | Firmware package from vendor cloud (see OTA report) | Drop. Never run the updater |
| Capability flags `SupLightEffect`/`SupLightSync` | `work/app/MonitorInfo.json` (34M2C8600 entries lines 1101-1147), loaded by `DictMgr` from `%APPDATA%/evnia/MonitorInfo.json` | Startup | Possibly refreshed from cloud (see DictMgr/renderer reports) | Ship a static copy |
| None in ENE lib / EneEc.dll / Audio.Sync / Display32 / ScreenCaptureMgr / DynamicLghtingUtil | grep for Http/WebClient/Socket/URLs is negative | – | – | – |

---

## Open questions
1. **Interface/descriptor details of 0CF2:A201**: which interface carries the WinUSB GUIDs (expected 0), and is `mi_01` a HID LampArray (usage page 0x59)? Dump with `lsusb -v -d 0cf2:a201` and `/sys/class/hidraw/*/device/report_descriptor` on Linux. A LampArray would give a standards-based alternative path (and explains the Dynamic Lighting warning).
2. **Semantics of `0x0023`** (values 0/4): is it "host control active"? What happens to the LEDs when it is 0: OSD/DDC Ambiglow settings, or last state?
3. **Device-reported counts** `0xE0A1/A3/A5/A7` on the 34M2C8600: assumed 3 groups, 14/18/14. The central base address depends on them.
4. **Does a single 138-byte write at `0xE300` work** (auto-increment across segments)? Is the 10 ms pacing required by the firmware?
5. **`0x0415` value** on the real device. If it reads 0, `EneEc.dll` performs the trim-load sequence on every plug. Confirm it is non-zero so no flash-controller access is needed.
6. **Firmware-native FollowVideo**: does ENE mode 11 (`FollowVideo`) do anything? Does DDC `E2A019=1` work while the USB ENE is connected? If yes, capture can be optional.
7. **Audio level calibration**: the exact FFT length on Windows depends on NAudio's loopback chunking (not in corpus). The Linux N=2048 choice may need tuning of `MaxPercent/MinPercent` for a similar dynamic range.
8. `0xE960..62` vs per-group meaning. Does writing a single register suffice?
9. Physical placement of the "Central" 18 LEDs (sampled from the vertical centre column) and the "Bottom" 14 LEDs (not drawn in the renderer's preview for this model).
10. Why the ENE device (and hub `2109:2211`) was absent on 2026-09-26: cable/hub power state, or a monitor setting such as USB standby?

---

## Cross-references (outside this area)
- **DDC/CI transport and TPV extended VCP `E2 A0 xx`** (read/write framing, USB-DDC "SupUsbDDC" path, `GetTPVExternValue`/`SetTPVExternValue` in the logs) → DDC report. Ambiglow codes are listed in §14.
- **SignalR hub / Bridge dispatch / notification serialization** (`dc/EvniaServe/Evnia/EvniaHub.cs`, `HandleEvent.cs`, `Bridge.Lib/Bridge.Lib/Notification.cs`) → backend architecture report. Note the `NotifyUIDisplayEffectChange` tuple mismatch (§10).
- **Firmware OTA** (ENE updater exe, `Fail_Ene_OTA_*` error codes, `PHLDisplayFW` device list incl. `DeviceType.Ambiglow`) → OTA report.
- **Matter / smart bulbs** (`matter-control.mjs`, `setBulbAttribute`, bulb pairing, `rp/AmbiScape-B35D_GM2.js`) → Electron main / online-features report.
- **Peripheral light effects and Light-Sync** (RongYuan keyboard/mouse/mousepad, BeiYing K916 `OnFollowAudio/OnFollowVideo` using `AudioSyncUtil.GetKeyboardSyncData`, the 5-sample `CalcRGBs(6,7,3,5,11)` strip, and the audio RGB crossfade) → peripherals report. Not applicable to this user's hardware.
- **Device scanning** (`Global.UsbDevices/UsbHubs`, `CListCompareController` filters `vid_0cf2`, `vid_2109`/`vid_0BDA`, `vid_05E3`/`vid_0552` in `CDevice_PHLDisplay.cs:25-29,204-216`) → device-discovery report.
- **FancyZones** (sole consumer of `Zeasn.Display32.Lib`) → FancyZones report.
- **Idle timer loop** also runs `SystemOper.CheckTopApp()` (per-app profile switching, `EvniaHub.cs:45-48`) → profiles report.
