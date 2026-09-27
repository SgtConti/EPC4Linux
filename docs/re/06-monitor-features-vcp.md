# Evnia Precision Center 1.13.0: monitor features and DDC/CI VCP mapping (RE spec)

## Summary

The monitor side of the backend has three layers:

1. **Feature layer.** `CDevice_PHLDisplay` (DeviceType `100000`, name `PHL_CDeviceDisplay`) owns a `T_PHLDisplay_Profile`. The profile has eight "modules": SmartImage, SmartImageHDR, GameMode, Ambiglow, Input, Audio, System and Setup. Each module is a bag of `AttributeInfo` objects, and each `AttributeInfo` corresponds to exactly one VCP code. An attribute's **name is the OSD item name** that the UI sends to `PHL_SetOSD` (for example `OP_10_Luminance` or `EXT_OP_E2A0_19_AmbiglowLightMode`).
2. **VCP layer.** `DataOSD`, `Display` and `Extension_AttributeInfo` in `Zeasn.PCenter.Base.Lib` handle this layer:
   - They parse the monitor's MCCS capability string. Standard VCP codes are 1 byte. TPV/Philips "extended" codes are the 3-byte VCP codes `E2 A0 xx`. The enum value is `0xE2A000 | xx`.
   - They decide which attributes are available (`err_code` 0 means available, 9 means not supported).
   - They perform reads and writes.
3. **Transport layer.** Every read or write first tries **USB-DDC through the monitor's built-in USB hub** (`Zeasn.Monitor.Lib`, `MonitorService`). If that fails, it falls back to **DDC/CI over the GPU I2C bus** through `DDCHelperLib.dll` (`Zeasn.DDC.Lib.New.NewDDCOper`). Both transports carry ordinary DDC/CI packets. Standard get: `6E 51 82 01 <vcp> chk`. Extended get: `6E 51 84 01 E2 A0 <xx> chk`. Extended set: `6E 51 86 03 E2 A0 <xx> <hi> <lo> chk`.

Ground truth from the user's machine: the Philips 34M2C8600 was enumerated as **hub type VIA (USB `2109:8884`) with a Realtek RTD2738VL scaler** (`Hub-Scaler: VIA-RTK`). USB-DDC was supported, so **all real VCP traffic went over the VIA hub** as WinUSB vendor control transfers:
- write: `bmRequestType 0x40`, `bRequest 0xB2`
- read: `0xC0`, `0xA3`, `wIndex 0x006F`

The GPU path (AMD ADL) also worked and was available as a fallback. A get takes about 187 ms and a set about 110 ms. Loading the full profile at connect takes about 12 s, and reading the capability string about 6.8 s; the capability string is then cached in `Config\data.json`. The full capability string (`model(34M2C8600MV)`, MCCS 2.2) and all values the app read are reproduced in §4.8 and §6.

What is dead in 1.13.0:
- All **hotkey** functions (`PHL_GetHotKeyMenu/Data`, `PHL_SetHotKey*`, `PHL_DeleteHotKey`).
- **GamePQ** (`SetGamePQ`, `PHL_EnableGamePQMouseKey`, `PHL_SetGamePQMouseKeyBind`).

These functions are stubs that return success, and the code that would act on them is unreachable. The UI never calls them, nor `PHL_ProfileAction`. The only intended behaviour left is recoverable from dead code (§7.13–7.14).

**Linux port.** Implement a small VCP engine that:
- uses `/dev/i2c-*` (DRM DDC bus) and/or libusb for the VIA hub;
- parses the capability string the same way;
- reproduces the module/attribute JSON model so the existing renderer keeps working.

Then drop OTA, the online MonitorInfo.json refresh, Windows HDR/driver helpers and the dead hotkey/GamePQ code.

Conventions:
- **CONFIRMED** means read in code, or seen in the user's logs or config. **INFERRED** means reasoned but not observed.
- Path prefixes:

| Prefix | Path |
|---|---|
| `DC/` | `work/dotnet-clean/` |
| `ML/` | `DC/Zeasn.Monitor.Lib/` |
| `EO/` | `DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/` |
| `PHL/` | `DC/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/` |
| `PB/` | `DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/` |
| `PE/` | `DC/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/` |
| `EB/` | `DC/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/` |
| `SO` | `DC/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs` |
| `BR` | `DC/Bridge.Lib/Bridge.Lib/Bridge.cs` |
| `AP/` | `work/app-pretty/` |
| `LOG25`, `LOG26` | `%APPDATA%/EvniaServe/logs/2026-09-25.txt` and `2026-09-26.txt` |
| `PROF` | `%APPDATA%/EvniaServe/Theme/User/Default.pcenter` |
| `CACHE` | `%APPDATA%/EvniaServe/Config/data.json` |

- Line numbers are the `dotnet-clean` ones.
- The LOG26 build's log strings match the decompiled code; LOG25 comes from a slightly older build (INFERRED; for example, it lacks the `TryGetCapabilites` line).

---

## 1. Call chain (CONFIRMED)

```
renderer  --SignalR GetTaskAsync {functionName:"PHL_SetOSD", parms:["OP_10_Luminance",50]}-->
EvniaServe Class0.method_2 (overload chosen by parms count + JSON token types int/string/bool; DC/EvniaServe/Class0.cs:115-170)
  -> BR:199-321  (PHL_* wrappers; note the GamePQ one is named "SetGamePQ", not "PHL_SetGamePQ", BR:269)
  -> SO:987-1114 (SystemOper.PHL_*  -> GetDeviceByType<IDisplay>(DeviceType.PHL_CDeviceDisplay))
  -> PHL/PHLDisplay_Oper.cs (singleton, AnalyseBasicInfo only) : PHL/CDevice_PHLDisplay.cs (all logic)
       : EB/GClass3.cs (= "CDeviceDisplayBase<T>": enumeration, SwitchDisplay, Rescan, HDR query)
  -> AttributeInfo.GetValue()/SetValue()       PB/Extension_AttributeInfo.cs:68-156
  -> DataOSD.Get/SetStandardValue, Get/SetTPVExternValue   PB/DataOSD.cs:481-499
  -> Display (current display) Get/SetStandardValue, Get/SetTPVExternValue   PB/Display.cs:354-474
       1st: MonitorService (USB hub)      ML/Zeasn.Monitor.Lib/MonitorService.cs:250-280
       2nd: NewDDCOper (DDCHelperLib)     DC/Zeasn.DDC.Lib/Zeasn.DDC.Lib.New/NewDDCOper.cs:111-161
```

- The dispatcher resolves the two `PHL_SetOSD` overloads (`(string)` and `(string,int)`) by the number of parameters (CONFIRMED, DC/EvniaServe/Class0.cs:150-164).
- The HTTP REST controller also exposes two display functions:
  - `GET /Display/PHL_SwitchDisplay?parm=`
  - `GET /Display/PHL_SetGamePQ?iValue=&IsShow=&R=&G=&B=&C=&M=&Y=`

  See DC/EvniaServe/Evnia/DisplayController.cs:13-29. The GamePQ one is a no-op (§7.14).

---

## 2. Object model

### 2.1 Device classes (CONFIRMED)

| Class | File | Role |
|---|---|---|
| `PHLDisplay_Oper : CDevice_PHLDisplay` | PHL/PHLDisplay_Oper.cs:11-182 | Singleton (`Equipment(DeviceType)`). Only adds `AnalyseBasicInfo`, which feeds the overview card fields `LightSync`, `LightMode`, `Resolution`, `RefreshRate`, `SmartImage` (enum Name), `AdaptiveSync` (`"On"/"Off"/"/"`) and `Input` (enum Name). |
| `CDevice_PHLDisplay : GClass3<T_PHLDisplay_Profile>` | PHL/CDevice_PHLDisplay.cs | All PHL_* logic, ENE/Ambiglow glue, profile load and apply. |
| `GClass3<T>` (really "CDeviceDisplayBase") | EB/GClass3.cs | Connection check, merging USB and DDC displays, model whitelist, `SwitchDisplay`, `Rescan`, `GetMonitorHDR`. Holds the virtual defaults, which all return `Notimplemented()` (EB/GClass3.cs:291-419). |

The constructor (PHL/CDevice_PHLDisplay.cs:111-139) does the following:
- `supportDisplays = ["PHL"]`.
- `supportModelNames` = every `Name` from MonitorInfo.json, with a leading `"PHL "`, `"PHL_"` or `"PHL"` stripped.
- `NewDDCOper.SwitchGetCommandChecksum(true)`: DDCHelperLib validates reply checksums.
- `MonitorService.SetSetting("PHILIPS")`, which sets `Class45.bool_0` (the Philips BOM rules in OTA code).
- Shares one global lock `Const_Lock.Monitor` between the DDC lib and the Monitor lib.
- Subscribes to `OTAStateChanged`, which sets `InFirmwareUpdate`. While that flag is set, all DDCHelper calls return -1.

Private state:

| Field | Meaning |
|---|---|
| `bool_2` | ENE lighting controller present |
| `string_0` | ENE model name |
| `cusbene6K7732_0` | ENE USB helper |
| `clistCompareController_0` | USB list watcher for `vid_0cf2` (ENE) |
| `clistCompareController_1` | hubs `vid_05E3`/`vid_0552` |
| `clistCompareController_2` | devices `vid_2109`/`vid_0BDA` |

When any USB list changes (`EVT_Com.UsbDeviceChange`, PHL/CDevice_PHLDisplay.cs:204-216):
- `FnRecheckConnectionByUSB` re-enumerates the hub devices.
- The ENE check (`method_14`) runs again.

### 2.2 Display registry (CONFIRMED)

- `DataOSD` (PB/DataOSD.cs) is static and has these members:
  - `s_MonitorDevices` (USB hub devices)
  - `s_DDCDisplayInfos` (DDCHelper displays)
  - `s_DataDisplay` (a `DataDisplay`)
  - `StandardList` / `E2A0_ExternList`: all enum items **without** `[UnbindEnumExtended]` (PB/DataOSD.cs:15-17). These are the only codes the app handles.
- `DataDisplay` (DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Entity.Lib/DataDisplay.cs) has:
  - `CurSN`
  - `CurDisplay`: the display whose `SN == CurSN`, otherwise an empty `Display`
  - `Displays`
  - `UIDisplayInfos`: `{DisplayName, MonitorName, DeviceName, DisplaySN}`
  - `SupportOSDList`: the `AttributeInfo` list built from the capability string
- `Display` (PB/Display.cs) holds a single physical monitor:
  - `SN`, `DisplayName`, `MonitorName`, `DeviceName` (`\\.\DISPLAYn`)
  - `MonitorEDID` (`DisplayEDIDInfo`)
  - `VcpCode` (the capability string)
  - `MonitorDevice` (`IMonitorDevice` from the USB hub, may be null)
  - `DDCDisplays` (a list of DDCHelper displays)
  - `IsSupport = MonitorDevice != null || any DDCDisplays[i].IsSupportDDCCI` (PB/Display.cs:153-174)
- All VCP operations go to `CurDisplay` only. The `displayIndex` parameter of the DataOSD helpers is ignored (PB/DataOSD.cs:481-499). `PHL_SwitchDisplay(sn)` changes `CurSN` and reconnects (EB/GClass3.cs:258-274). The UI passes the EDID serial (LOG26:1019 `parms:["AU00000000001"]`).

### 2.3 `AttributeInfo` (PE/AttributeInfo.cs) (CONFIRMED)

| JSON field | Type | Notes |
|---|---|---|
| `VCPOpCode` | int | Standard code (for example 16), or extended code `0xE2A0xx` (for example 14852121 = 0xE2A019). |
| `VCPOpCodeName` | string | Enum member name, and the key used by `PHL_SetOSD`. `[JsonIgnoreEx(IgnoreProfile)]`: sent to the UI, not saved in the profile. |
| `Value` | object (int) | Current value, the full 16-bit VCP "current" field. |
| `MinValue` | int | Never set, always 0. IgnoreProfile. |
| `MaxValue` | int | The VCP "maximum" field from the last read. IgnoreProfile. |
| `StepValue` | int | Always 1. IgnoreProfile. |
| `ValueList` | `EnumItem[]` | Allowed values: the capability-string values intersected with the enum (see §4.8). IgnoreProfile. |
| `err_code` | int | 0 means available or last read OK. 9 means unsupported, not in the capability string, or last read failed (`SetErrMsg`). |
| (`VCPOpCodeDesc`, `err_msg`, `IsAvailable`) | | `[JsonIgnore]`. `IsAvailable := err_code == 0`. |

`EnumItem` is `{Name, Text, Value}` (DC/Zeasn.Com.Lib/Zeasn.Com.Lib/EnumItem.cs), for example `{"Name":"HDRGame","Text":"HDR Game","Value":33}`.

Read (`GetValue`, PB/Extension_AttributeInfo.cs:68-120):
- Standard codes use `GetStandardValue(code)`.
- Extended codes take the hex string of `VCPOpCode`, which must be 6 characters. Its last 2 hex digits become `extCode`, and the read is `GetTPVExternValue(0xE2, 0xA0, extCode)`.
- On success it sets `Value` and `MaxValue` and resets `err_code` to 0. On failure it sets `err_code = 9`.

Write (`SetValue`, :122-156):
- Writes `Value.ToInt32()` in the same way.
- **The result of the write is ignored.** `err_code` is not updated, there is no read-back and there is no delay.
- On the hub path the value goes through `ToUInt16()`, so anything outside 0..65535 is sent as 0 (DC/Zeasn.Com.Lib/Zeasn.Com.Lib/Extension_Number.cs:7-17).

Module reads (`GetValue<T>(module)`, :33-59):
- Reflection walks every `AttributeInfo` property **in declaration order**.
- If the code is not in `SupportOSDList`, the attribute gets `err_code = 9` and no I/O happens.
- Otherwise it copies `ValueList` from the support list (if the attribute has none yet) and reads the device.
- Because the order is fixed, the order of reads on the bus is deterministic (see §5.7).

### 2.4 `T_PHLDisplay_Profile` and modules (EO/*.cs) (CONFIRMED)

Top-level fields, in declaration order (EO/T_PHLDisplay_Profile.cs):

| Field | Notes |
|---|---|
| `IsSmartImageHDR` | bool |
| `HasUSBSetting` | bool, IgnoreProfile |
| `OP_DC_DisplayApplication` | `AttributeInfo`, VCP 0xDC |
| `ModuleSmartImage` | |
| `ModuleSmartImageHDR` | |
| `ModuleGameMode` | |
| `ModuleAmbiglow` | |
| `ModuleInput` | |
| `ModuleAudio` | |
| `ModuleSystem` | |
| `ModuleSetup` | |
| `ENEEffectEnable` | bool |
| `EffectInfo` | `DisplayEffectInfo`, ENE lighting; see the ENE report |
| `DispalyData` | `DispalyOtherInfo`: `MonitorEDIDInfo_T`, `MonitorResolution`, `MonitorFrequency`, `MonitorOrientation` |
| `EquipmentType`, `DeviceType`, `ModelName`, `ExtModel` | from `T_DeviceProfile_Base` |

Module contents (property names are the OSD item names; order = I/O order):

| Module (file) | Properties in order |
|---|---|
| `ModuleSmartImage` (DisplayModuleSmartImage.cs) | `Items` (`EnumItem[]`, SDR SmartImage presets), `CurSubSmartImage` (SubModuleSmartImage), `SubSmartImages` (dict keyed by the DC value as a string) |
| `SubModuleSmartImage` (SubModuleSmartImage.cs:9-45) | `OP_10_Luminance`, `OP_12_Contrast`, `OP_F0_SmartContrast`, `OP_72_Gamma`, `OP_87_Sharpness`, `EXT_OP_E2A0_20_ColorSpace`, `OP_14_SelectColorPreset`, `OP_16_VideoGainDriveRed`, `OP_18_VideoGainDriveGreen`, `OP_1A_VideoGainDriveBlue`, `OP_8A_Saturation`, `OP_90_Hue`, `EXT_OP_E2A0_24_DLBL` |
| `ModuleSmartImageHDR` (DisplayModuleSmartImageHDR.cs) | `Items`, `CurSubSmartImage` (SubModuleSmartImageHDR), `SubSmartImages` |
| `SubModuleSmartImageHDR` | `OP_10_Luminance`, `OP_12_Contrast`, `EXT_OP_E2A0_3D_LightEnhancement`, `EXT_OP_E2A0_3E_ColorEnhancement`, `EXT_OP_E2A0_3F_DarkEnhancement` |
| `ModuleGameMode` (DisplayModuleGameMode.cs:9-63) | `EXT_OP_E2A0_40_AdaptiveSync`, `_02_MBR`, `_03_MBRSync`, `_04_SmartCrosshair`, `_44_StarkShadowBoost`, `_45_ShadowBoost`, `_06_SharpShooter_Size`, `_25_SharpShooter_Location`, `_07_LowInputLag`, `OP_EB_SmartResponse`, `_4C_Overclock`, `_08_SmartFrame`, `_09_SmartFrameSize`, `_0A_SmartFrameBrightness`, `_0B_SmartFrameContrast`, `_0C_SmartFrameHPosition`, `_0D_SmartFrameVPosition`, `_59_DualResolution`, `_68_AutoRefineAIStatus` (the `EXT_OP_E2A0` prefix is omitted) |
| `ModuleAmbiglow` (DisplayModuleAmbiglow.cs) | `EXT_OP_E2A0_19_AmbiglowLightMode`, `_1A_AmbiglowColors`, `_1B_AmbiglowLightPosition`, `_1C_AmbiglowLightBrightness`, `_1D_AmbiglowLightSpeed`, `_1E_AmbiglowLightDirection`, `EffectEnable` (bool) |
| `ModuleInput` (DisplayModuleInput.cs) | `OP_ED_InputAuto`, `OP_60_InputSource`, `OP_A5_WindowSelect`, `OP_EC_PIPPBPSizeLocation`, `OP_F6_PIPPBPSwap`, `InputSourceList`, `PIPPBPSourceList`, `InputSourceInfo {Mode, Size, Location, PIPPBPSource, InputSource}` (DisplayInputSourceInfo.cs), `PIPLocationList` (computed: `VCP_EC_PIP_Location` enum) |
| `ModuleAudio` (DisplayModuleAudio.cs) | `OP_62_AudioSpeakerVolume`, `OP_8D_AudioMute`, `EXT_OP_E2A0_00_AudioMode`, `OP_E0_AudioSource`, `EQItems[] {Name, Index, Value, MaxValue}` (EO/GClass0.cs) |
| `ModuleSystem` (DisplayModuleSystem.cs:9-57) | `EXT_OP_E2A0_3A/3B/3C_HDMIxRefreshRate`, `_0E_OSDSettingHorizontal`, `_0F_OSDSettingVertical`, `_10_OSDSettingTransparency`, `_11_OSDSettingTimeOut`, `OP_86_DisplayScaling`, `_12_USB_C_Setting`, `_13_USB_StandbyMode`, `_14_USB_Upstream`, `_15_KVM`, `_16_SmartPower`, `_18_LocalDimming`, `OP_54_PerformancePreservation`, `OP_DA_ScanMode`, `_6B_Profile` |
| `ModuleSetup` (DisplayModuleSetup.cs:9-66) | `OP_F2_PowerLED`, `OP_CC_OSDLanguage`, `OP_E9_ResolutionNotifier`, `_17_CEC`, `_35_ScreenSaver`, `_34_PixelOrbiting`, `_36_PixelRefresh`, `_37_PanelRefresh`, `_43_AutoWarning`, `_47_UniBright`, `_48_MultiLogoProtection`, `_49_BoundaryDimmer`, `_4A_TaskbarDimmer`, `_4B_ThermalProtection`, `_61_AutoPixelRefresh`, `WorkingTime` (int), `TimeAfterPixelRefresh` (int), `_54_PixelRefreshCounts`, `_55_PanelRefreshCounts`, `_41_FanControl` |

Derived fields computed in `method_4` (PHL/CDevice_PHLDisplay.cs:296-468):
- **`HasUSBSetting`** is true if any of E2A012, E2A014 or E2A015 is available (:491-506).
- **`WorkingTime`** is `(E2A04D << 16) | E2A04E`. **`TimeAfterPixelRefresh`** is `(E2A050 << 16) | E2A051`. Either is -1 if the code is unsupported (:518-557). The E2A04F and E2A053 "M" (middle-word) codes exist in the enum but are never used.
- **`IsSmartImageHDR`** comes from **Windows**: `GetMonitorHDR().Item2`, which is `CWinSysDisplayHDR.GetHDR(MonitorName).Enabled` (EB/GClass3.cs:356-364). This is not derived from VCP. See the port plan (§10).

The two SmartImage item lists are built from the DC `ValueList`:
- **`ModuleSmartImage.Items`** = DC `ValueList` **except** the `SmartImageHDR_E` values. It is filled only when not in HDR.
- **`ModuleSmartImageHDR.Items`** = DC `ValueList` **intersected with** `SmartImageHDR_E`. It is filled only when in HDR.
- Only the sub-module for the current DC value is read (:336-353).

### 2.5 `Zeasn.Monitor.Lib` object model (USB-hub side) (CONFIRMED)

- **`MonitorService`** (ML/Zeasn.Monitor.Lib/MonitorService.cs) is a singleton facade. Every method takes `MonitorLock`. Relevant calls:
  - `EnumerateMonitorOTADevices(WithDeviceInfo.Simple)`
  - `GetMonitorInfo`
  - `ReadMonitorDetail` (SN + capability string)
  - `Get/SetStandardDDC(dev, code[, value])`
  - `Get/SetExtendDDC(dev, pre2, aCode01, ext[, value])`
  - `Get/SetDDC(raw)`
  - `SetSetting`
  - `method_0`, the USB-DDC probe (named `CheckIsSupportUSBDDC` at the call site PB/DataOSD.cs:83; INFERRED to be the same method, a de-obfuscation naming mismatch)
  - The rest (OTA, Genesys driver install, `ISPStep`) is out of scope.
- **`IMonitorDevice`** (ML/Zeasn.Monitor.Lib.ScalerFW.Devices/IMonitorDevice.cs) declares `GetMonitorInfo`, `GetModelName`, `GetDDC`, `SetDDC`, `Get/SetStandardDDC`, `Get/SetExtendDDC`, `GetCapabilitiesString` and `GetSN`.
  - `Interface2` (ML/Interface2.cs) implements all of them generically on top of four I2C primitives from `Interface1` (ML/Interface1.cs): write, read, write+100 ms, read+50 ms.
- Device class = hub transport × scaler flavour. `Class6.vmethod_0` picks the concrete class after `GetScalerIC`:

| Hub (transport interface) | Detected by | Scaler RTK | MTK | NTK | HVW |
|---|---|---|---|---|---|
| VIA (`Interface13`, WinUSB) | any `vid_2109` in `GUID_DEVINTERFACE_USB_DEVICE` (ML/Class5.cs:21-26) | `Class15` (Interface23+Interface7) | Class16 | Class17 | Class18 |
| RTK (`Interface12`, `lib\RTK\RhHidAPI.dll` HID-I2C) | HID `VID 0BDA PID 1100`, DevType 4 (ML/Class4.cs:78-84) | Class10 | … | | |
| Genesys (`Interface10`, `lib\Genesys\GL_SDK.dll`) | a `vid_05e3` hub in `GUID_DEVINTERFACE_USB_HUB`, or `OtherOTAUtil.GetUsbHubType` (ML/Zeasn.Monitor.Lib.Utils/Util.cs:293-315) | Class7/8/9… | | | |

- **`DeviceData`** (ML/Zeasn.Monitor.Lib.ScalerFW.Data/DeviceData.cs:148-670) carries identification, per-hub handles and OTA state. The fields relevant here are:
  - identification: `HubType`, `ScalerType`, `ScalerIC`, `VID`, `PID`, `ModelName`, `BOMString`, `Version`, `ScalerName`, `PanelName`, `DualImageBank`
  - `IsSupportUsbDDC`, `CapabilitiesString`, `SN`, `DeviceName` (`\\.\DISPLAYn`), `MonitorIdNumber`
  - `eDID256Block`
- `HubType`: Unknown 0, VIA 1, RTK 2, Genesys 3. `ScalerType`: MTK 5, RTK 9, NTK 18, HVW 36 (the same numbers as the VCP C8 controller id).

---

## 3. Public PHL_* surface (CONFIRMED; BR:199-321, SO:987-1114)

| Hub function (BR line) | Params | Implementation | Returns in `Tag` | Called by UI? |
|---|---|---|---|---|
| `PHL_Rescan` (199) | – | `GClass3.Rescan`: ClearCache + `ConnectionCkecked()` (EB/GClass3.cs:276-284) | full profile, or error `"Display unconnected"` | yes (`rescan`) |
| `PHL_SwitchDisplay` (204) | string SN | EB/GClass3.cs:258-274 | full profile | yes |
| `PHL_ReloadData` (209) | – | `ReloadOSD` (PHL/…:559-574) | full profile | yes |
| `PHL_SetOSD` (214) | string item | PHL/…:1603-1620 | `AttributeInfo` | (`OP_F6` only) |
| `PHL_SetOSD` (219) | string item, int value | PHL/…:1622-1673 | `AttributeInfo` or null | yes (main entry point) |
| `PHL_SetSmartImage` (224) | int | PHL/…:1675-1717 | `{Item1: DC attr, Item2: ModuleSmartImage[HDR]}` | yes |
| `PHL_ResetSmartImage` (229) | int | PHL/…:1719-1775 | same tuple | yes |
| `PHL_SetColorPreset` (234) | int | PHL/…:1777-1806 | `ModuleSmartImage` | yes |
| `PHL_SwitchSmartFrame` (239) | int | PHL/…:1808-1862 | `ModuleGameMode` | yes |
| `PHL_SetSmartFrameSize` (244) | int | PHL/…:1864-1886 | `ModuleGameMode` | yes |
| `PHL_SetInputSource` (249) | int input, int pipSrc, int mode, int size, int location | PHL/…:1888-1938 | `ModuleInput` | yes |
| `PHL_SwrapPIPPBP` (254) | – | PHL/…:1940-1974 | `ModuleInput` | yes |
| `PHL_SetAudioEQ` (259) | int band index, int gain | PHL/…:1976-1996 | `ModuleAudio` | yes |
| `PHL_GetConstraints` (264) | – | PHL/…:2021-2025 | `DisplayFuncConstraints` (+ notification) | yes |
| `SetGamePQ` (269) | int, bool IsShow, bool R, G, B, C, M, Y | **stub** (PHL/…:2027-2030) | `ModuleGameMode` | no |
| `PHL_ProfileAction` (274) | int profile, int action | PHL/…:2032-2049 | null, or error `"EXT_OP_E2A0_6B_Profile Unavailable"` | no |
| `PHL_GetHotKeyMenu` (279) | – | returns the empty `HotKeyItems` list | `[]` | no |
| `PHL_GetHotKeyData` (284) | – | stub | null | no |
| `PHL_SetHotKeyEnable` (289), `PHL_SetHotKeyItemEnable` (294), `PHL_SetHotKey` (299), `PHL_DeleteHotKey` (304) | … | stubs `JsonResult.Succ()` (PHL/…:1364-1382) | null | no |
| `GetHotKeyState` (309) | int key, bool alt, bool ctrl, bool shift, bool win | display `CheckHotKeyBind` (always false) OR `InputEventManager.IsHotkeyOccupied` (SO:1092-1099) | bool | no (display) |
| `PHL_EnableGamePQMouseKey` (314), `PHL_SetGamePQMouseKeyBind` (319) | bool / int | stubs (PHL/…:1413-1421) | null | no |
| `Profile_GetDeviceData(100000)` (669) | device | `GetDeviceData` returns the in-memory profile | full profile | yes |
| `Profile_Reset(100000)` (674) | device | `CDevice_PHLDisplay.Reset` (PHL/…:1998-2019) | full profile | yes (`monitorReset`) |
| `Device_DetectionDisplay` (134) | – | `SystemOper.DisplayDeviceChange`: `Sleep(5000)` then rescan displays (SO:241-246) | connect list | yes |

"Called by UI" is based on AP/renderer/assets/styles-DAnQi2A8.js:8310-8488 (the `yu()` display API) and a grep over all renderer assets:
- There are **no** references to hotkey, GamePQ or ProfileAction functions.
- `PHL_Rescan` is reached through the `system.rescan()` path.

---

## 4. Enumeration and identification

### 4.1 Connection sequence `GClass3.ConnectionCkecked` (EB/GClass3.cs:143-188) (CONFIRMED, with timings from LOG26:152-1003)

1. **Clear the caches, then enumerate USB monitors.** `DataOSD.EnumerateUsbMonitors()` (PB/DataOSD.cs:72-90) runs:
   - `MonitorService.EnumerateMonitorOTADevices(Simple)`: hub detection, open, VCP C8 scaler id, class selection, and `GetMonitorInfo` (§4.3); each device is then matched to a Windows display through its EDID (§4.5).
   - For each device, the USB-DDC probe (§4.4).
2. **Enumerate DDCHelper displays.** `NewDDCOper.DDCHelAPIIni("PHL")` (DC/Zeasn.DDC.Lib/Zeasn.DDC.Lib.New/NewDDCOper.cs:17-75) does the following (§4.6):
   - DDCHelper initialisation and display enumeration (via AMD ADL on the user's machine, LOG25:185-266);
   - `DDCSupportJudge_C`, which fills `IsSupportDDCCI` and the EDID.
3. **Merge** (EB/GClass3.cs:50-74, §4.7):
   - Build a `Display` from every hub device that passes `method_5` (USB-DDC supported, EDID+SN present, PNP ID contains `PHL`, model whitelisted).
   - Attach the DDCHelper displays to hub `Display`s with the same SN (case-insensitive). Unmatched DDCHelper displays become their own `Display` if whitelisted.
4. **Pick the current display.** Keep the previous `CurSN` if it is still present, otherwise use the first display.
5. **`CurDisplay.InitDisplayVcpCode()`** (PB/Display.cs:275-324): capability string from the cache or the device (§4.8).
6. **Connection result.** `bConnection = IsSupport && VcpCode != ""`. `OnConnect` leads to `InitDisplayData`, then `DataOSD.InitDisplayInfo()` (parse caps into `SupportOSDList`), `method_4` (read all modules) and `DeviceDataCheck`.
7. **`DeviceDataCheck`** (EB/GClass3.cs:234-250) loads the saved profile and calls `ParameterToDevice(profile)` with **bForce=false**. For the display this means no VCP writes, only ENE lighting (§7.1, §7.12).

Observed on the 34M2C8600 (LOG26): step 1 took about 1.8 s, the capability read about 6.7 s, and `CacheDeviceDataLoad` (all module reads) about 11–12 s (LOG25:739 `TotalMilliseconds=12002`). "ConnectionCheckedTime PHL_CDeviceDisplay ==> 22602" ms in total (LOG25).

### 4.2 USB hub device discovery (CONFIRMED)

- Device lists come from SetupAPI enumeration (ML/Class40.cs:10-60):
  - `GUID_DEVINTERFACE_USB_DEVICE` `{A5DCBF10-6530-11D2-901F-00C04FB951ED}` (ML/Class44.cs:53)
  - `GUID_DEVINTERFACE_USB_HUB` `{F18A0E88-C30C-11D0-8815-00A0C906BED8}` (:55)
- **VIA**: every USB device path containing `vid_2109` is opened with `CreateFile` + `WinUsb_Initialize` (ML/Interface13.cs:18-51). Then:
  - `GetScalerIC` (VCP C8)
  - close and reopen as the scaler-specific class (ML/Class5.cs:28-64, ML/Class14.cs)
- On the user's machine the device is **VID 0x2109, PID 0x8884**, "Hub-Scaler: VIA-RTK", scaler "RTD2738VL" (LOG26:153-160). LOG25 printed VID/PID 0x0000 (older build).
- RTK hub: `RH_ListAllHidDev`, keeping entries with DevType 4, VID `0BDA` and PID `1100`; I2C slave is configured with `RH_HidI2CConfig(h, 0x6E, 1, 0)` (ML/Class4.cs:52-84, ML/Interface12.cs:12-50).
- Genesys hub: through GL_SDK. The "open" sends `0xC0/0xC1 wValue=0x0300 wLength=1` and then sleeps 500 ms (ML/Interface10.cs:224-238).
- These two are only summarised here; neither is present on the user's machine (LOG26:151-152 "没有检测到 RTK-Hub/Genesys-Hub 机台", i.e. "no RTK-Hub/Genesys-Hub machine detected").

### 4.3 Scaler/factory identification commands (DDC/CI over the hub) (CONFIRMED, ML/Interface8.cs, ML/Interface2.cs, ML/Interface7.cs)

All of these are DDC/CI "Get VCP" (opcode 0x01) requests. The first byte is the I2C destination 0x6E and the source is 0x51. The TPV factory extension puts `FE xx yy zz` in place of a single-byte VCP code. The reply payload is extracted by `imethod_8`: `len = reply[1]-0x80`; the data starts at `reply[5]` (or `reply[6]` if `reply[5]==0`) (ML/Interface2.cs:142-148).

| Purpose | Request bytes (before checksum) | Parse | Source |
|---|---|---|---|
| Scaler IC | `6E 51 82 01 C8` | `payload=reply[5..]`, `payload[4]` (= SL): 9 RTK, 5 MTK, 18 NTK, 36 HVW | ML/Interface8.cs:257-287 |
| Model name | `6E 51 86 01 FE E9 0D 00 00` | ASCII → `DeviceData.ModelName` (for example `34M2C8600`) | ML/Interface2.cs:382-402 |
| BOM string | `6E 51 86 01 FE E1 E6 1D 00` | ASCII. Philips mode requires `payload[4]=='P'` or BOM `100GARVGG88NT1SXXY` | ML/Interface8.cs:289-334 |
| FW version | `6E 51 86 01 FE E1 E6 06 00` | ASCII, for example `V1.01` | :359-379 |
| Scaler name | `6E 51 86 01 FE E1 E8 00 00` | ASCII, for example `RTD2738VL` | :381-401 |
| Panel name | `6E 51 86 01 FE E1 A7 07 00` | ASCII | :403-423 |
| Dual image bank | `6E 51 86 01 FE E1 A1 01 00` | `(p[1]<<8)\|p[2]` (NTK: `p[2]`), for example `0x40` | :336-357 |
| Boot flag address (RTK scaler) | `6E 51 86 01 FE E1 A1 01 01` | 32-bit BE `p[1..4]` | ML/Interface7.cs:45-71 |
| Serial number | `6E 51 86 01 FE EF 13 00 20` | ASCII `reply[2..len+2]`, non-ASCII stripped, truncated to 14 characters, or empty if shorter than 13 | ML/Interface2.cs:284-322 |

`GetMonitorInfo` (ML/Interface8.cs:144-255) calls model, BOM, version, dual-image, scaler name and so on, each **retried 3× with 150 ms sleeps**. Any failure only clears `IsReadyForFirmwareUpdate`, which matters for OTA only.

The log banner printed afterwards (LOG26:153-162):

```
ModelName: 34M2C8600 / BomString: 100GPRS2003NA1SXXY / Version: V1.01 / DualImageBank: 0x40 /
ScalerName: RTD2738VL / VID: 0x2109, PID: 0x8884 / Hub-Scaler: VIA-RTK
```

### 4.4 USB-DDC support probe (CONFIRMED)

`Interface0.imethod_5` (ML/Interface0.cs:465-473) reads **VCP 0x14** over the hub. It succeeds when the read works, `0 < value < 255` and `max < 255`, and the result is stored in `IsSupportUsbDDC`. Log: `CheckSupportUSBDDC(0x14): isSupport = True，value = 0x05，max = 0x0D` (LOG25:165, LOG26).

Hub devices without USB-DDC are dropped from display merging (EB/GClass3.cs:100-126). They can still be driven over GPU DDC/CI if DDCHelper finds them.

### 4.5 EDID handling (CONFIRMED)

- **Hub devices.** `MonitorUtil.smethod_6` (ML/Zeasn.Monitor.Lib.Utils/MonitorUtil.cs:1271-1312):
  - Enumerates Windows monitors (`EnumDisplayMonitors`/`EnumDisplayDevices`).
  - Reads each monitor's EDID from `HKLM\SYSTEM\CurrentControlSet\Enum\DISPLAY\<id>\<instance>\Device Parameters\EDID` (:1314-1349).
  - Takes the 0xFC name descriptor, strips `PHL`/`AOC`, and regex-matches it against the scaler model name: first exactly `^((AOC )|(PHL )|(AOC_)|(PHL_)|(AOC)|(PHL))?<name>$`, then as a prefix `…<name>[0-9A-Z]*`.
  - On a match, parses the EDID into `EDID256Block` and records `DeviceName`/`MonitorIdNumber`.
- **`EDID256Block.FnSetaByteEDID`** (MonitorUtil.cs:884-1125) extracts:
  - `FnPNPID` = 3-letter vendor code + product code as 4 hex digits (bytes 10–11, little-endian)
  - `FnIDManufacturerName` (lookup table, 0x410C gives "PHL")
  - `FnModelName` (first 0xFC descriptor, up to 13 characters, stops at LF)
  - `FnSerialNumber` (0xFF descriptor)
  - `FnRecXRecY` (preferred timing)
  - `FnGamma` (`byte23/100+1`)
  - `FnManuFactureDate` (`Week%02d-%d`)
  - `FnInput` (DIGITAL/ANALOG)
  - `FnScreenSize` ("~xx,x\"")
  - `FnVersion`
  - chromaticity strings
- **`DisplayEDIDInfo`** (PB/DisplayEDIDInfo.cs:247-285) is the JSON form. Fields: `sManufacturer`, `sManufacturerDate`, `PlugAndPlayID`, `sMonitorName`, `sSerialNumber`, `sVersion`, `ScreenSize`, `TimingRecommandation`, `DisplayGamma`, `DisplayTypeAndSignal`, `RedChromaticity`, `GreenChromaticity`, `BlueChromaticity`, `WhitePoint`.

The user's EDID (DDCHelper raw dump, LOG25:212), decoded:

| Bytes | Value |
|---|---|
| 8–9 `41 0C` | PNP `PHL` |
| 10–11 `9F C2` | product **0xC29F** (PnP ID `PHLC29F`) |
| 12–15 `01 00 00 00` | serial 1 |
| 16–17 `01 23` | week 1 / 2025 |
| 18–19 `01 04` | EDID 1.4 |
| 20 `B5` | digital, 10 bpc, DisplayPort |
| 21–22 `50 22` | 80×34 cm |
| DTD1 | 319.75 MHz, 3440×1440 |
| 0xFF desc | `AU00000000001` |
| 0xFC desc | `PHL 34M2C8600` |
| 0xFD desc | vertical 48–175 Hz |
| 126 | 2 extension blocks |

The stored `DispalyData.MonitorEDIDInfo_T` in PROF matches: `"PlugAndPlayID":"PHLC29F","sMonitorName":"PHL 34M2C8600","sSerialNumber":"AU00000000001","TimingRecommandation":"3440x1440"`, plus `MonitorResolution:"3440x1440"`, `MonitorFrequency:"175Hz"`, `MonitorOrientation:"0°"` (these three come from Windows `CWinSysDisplay`, PHL/…:314-327).

### 4.6 DDCHelper (GPU I2C) enumeration (CONFIRMED)

- `EnumDisplayIDIni` returns `strName` as `;`-separated entries of the form `"<PNPID>_<EDID name>"`. `DisplayName` = `"<index>-<entry>"`; `MonitorName` = the text after the first `_` (DC/Zeasn.DDC.Lib/Class1.cs:106-178).
- A display is kept only if the text before `_` contains a supported brand (`"PHL"`; SupportBrand also defines `AOC`, `ENV`, `AMZ`).
- `DDCSupportJudge_C` returns the EDID struct and `IsSupportDDCCI` (NewDDCOper.cs:50-64).
- User's machine: `DDCHelAPIIni Display=0-PHLC29F_PHL 34M2C8600 IsSupportDDCCI = True sn = AU00000000001` (LOG25, LOG26:361).

### 4.7 Model whitelist and per-model data: MonitorInfo.json (CONFIRMED)

- **Loading.** `DictMgr.Init` (PB/DictMgr.cs:14-28) reads **`%APPDATA%\evnia\MonitorInfo.json`**. That file is written by the Electron main process (§11), and a bundled copy exists at `work/app/MonitorInfo.json`, Version 34.
- **Schema.** `{"EdidToFactory":null, "Monitors":[{Name, SupUsbDDC, SupOTA, SupLightEffect, SupLightSync, HDR}], "Notes", "Version"}`. The C# class has only `Name/SupUsbDDC/SupOTA/SupLightEffect/SupLightSync` (PE/DictDisplayInfo.cs). `HDR` and `LimitVer_PCenter` are read only by Electron (AP/main/index.js:17584-17600).
- **Lookup.** `Data_DisplayInfo.GetDisplayInfoItem(model)` returns the first entry where `Regex.IsMatch(model, "^((PHL )|(PHL_)|(PHL))?" + Name + "$", IgnoreCase)` (PE/Data_DisplayInfo.cs). The same regex, applied to the stripped name list, is the **support whitelist** (EB/GClass3.cs:33-48). A monitor whose EDID model is not listed is ignored completely ("IsSupportModelName … not support").
- **Entries for this monitor** (work/app/MonitorInfo.json:1101-1107 and 1141-1147): `34M2C8600` and `PHL 34M2C8600`, both with `SupUsbDDC:true, SupOTA:true, SupLightEffect:true, SupLightSync:true, HDR:400`.
- **What the backend uses them for.** `SupLightEffect`/`SupLightSync` become `DeviceInfo.SupEffect`/`SupSync` (PHL/…:218-246) and drive `BasicInfo.LightSync`. `SupUsbDDC` is **not used** by the backend. The USB-DDC decision is the live probe in §4.4.
- **Embedded resources.** `Zeasn.Monitor.Lib` has **no per-model data and no functional embedded resources**. The only manifest resource referenced is the .NET Reactor runtime blob `aVJrSn85x0TmLRvW4l.UUwea19BoSyWoj7VGI` (ML/Class47.cs:347), an obfuscator string/method table. The per-model behaviour is driven entirely by the monitor's capability string plus MonitorInfo.json. `ML/Class38.cs` holds static `ushort[]` register tables used by the OTA/ISP code, so it is out of scope. `resources/bin/res/data/PCenter_DeviceInfo.json` record `DeviceType 100000` gives `ModelName:"Display"`, `SupEffect:true`, `SupSync:true`, `ProfileCount:1`.

### 4.8 Capability string: acquisition, cache, parse (CONFIRMED)

**Cache key** (PB/Display.cs:202-256). The key is `lower("<FW version>_<VCP60 low byte as %02X>")`:
- The hub path uses `DeviceData.Version`.
- The DDCHelper path uses VCP C9 if its max is 201, formatted `V%d.%02d`; otherwise it uses `GetDisplayFWVersion`.
- Observed: `TryGetCapabilites cacheKey=v1.01_0f` (LOG26). The input byte is part of the key because the capability string can depend on the active input.

**Cache file** (PB/CacheVcpMgr.cs). The file is `%APPDATA%\EvniaServe\config\data.json`, holding `List<{Name: EDID model name, Datas:[{Key, Vcp}]}>`:
- It is wrapped as `{"data":"<json>","sign":"<base64 HMAC-SHA256(key='WhaleTV_Serizlize_2026', data)>"}` (DC/Zeasn.Com.Lib/Zeasn.Com.Lib/SerializedFileUtil.cs:166-240). If the signature does not verify, the file is ignored.
- Lookup is `Datas.Find(x => x.Key.Contains(cacheKey))`.

**Acquisition order** (PB/Display.cs:275-324):
1. The cache.
2. If the hub device supports USB-DDC: `ReadMonitorDetail`, i.e. GetSN, then `GetCapabilitiesString` over the hub.
3. Otherwise DDCHelper `EnumMonitorCapabilitesStr`, retried once after 2000 ms.

A successful parse is written to the cache.

**Capabilities over the VIA hub** (ML/Interface13.cs:440-515). The default is `VIAFunction.A7A9`, ML/Class45.cs:100.

- The request is `6E 51 83 F3 <offHi> <offLo> chk`. The read uses the A7/A9 split (two 32-byte control reads, 64-byte buffer).
- The reply must satisfy `reply[1] > 0x80` and `reply[2] == 0xE3`.
- For each fragment:
  - `n = reply[1]-0x80`; if `n==32`, `n-=2`; cap at 30.
  - Append `reply[5 .. n+2)` (skipping `E3 offHi offLo`).
  - Advance the offset by `n-3`.
  - Stop when `n-3 < 26`.
- 3 failed fragment reads abort. The whole read took about 6.8 s (LOG25:169).
- Generic hubs (`Interface2`, :324-380) use a single 64-byte read and the same logic.

**Parse** (`ComUtil.AnalyseVcpString`, DC/Zeasn.Com.Lib/Zeasn.Com.Lib/ComUtil.cs:124-240):
- Uppercases the string, extracts the balanced `vcp( … )` group, then splits it into major items `([0-9A-F]{2})+` with optional `( … )` sub-lists of 2-hex-digit values.
- Major keys can be multi-byte: `E2A019` becomes 0xE2A019.
- Duplicate keys and duplicate values are dropped with a warning. If the string has no spaces, spaces are inserted and multi-byte support is lost.
- `DataOSD.InitDisplayInfo` (PB/DataOSD.cs:92-138) creates an `AttributeInfo` for every key that is a *handled* standard or E2A0 code and sets its `ValueList` (smethod_1/2, :158-382):
  - normally `enum ∩ caps`, sorted by value;
  - for GamePQ (E2A088), DualResolution (E2A059) and Profile (E2A06B), the capability order is kept (smethod_4).
- Codes it does not handle are logged as `UnHandle vcpCode = N`. On this monitor these are 02, 05, 08, 0B, 0C, 52, 6C, 6E, 70, AC, AE, B2, B6, C0, C6, C8, CA, DF, FD, FF (LOG25:630-649).
- Special value-list rules:
  - `DC`: the **last** byte of DC's sub-list selects the SmartImage table: E1→`SmartImage_E1`, E2→`_E2`, E3→`_E3`, E4→`_E4` (enum `VCP_DC_SmartImage` = 225..228). The `SmartImageHDR_E` items present in the list are appended.
  - `F7`: `ValueList[0]` selects the A5 PIP/PBP mode table (§6.4).
  - `EC`: value list = `VCP_EC_PIP_Size`.
  - `09`/`33`: `Num_0_E`. `10`/`48`/`49`/`4A`: `Num_Off_E`. Many on/off codes: `SwitchFlag_E`. `24`/`44`/`45`/`68`: `Level_Off_E`.

**34M2C8600 capability string** (CONFIRMED, CACHE and LOG25:373):

```
(prot(monitor)type(LCD)model(34M2C8600MV)cmds(01 02 03 07 0C E3 F3)vcp(02 04 05 08 0B 0C 10 12 14(02 04 05 06 07 08 0A 0B 0D ) 16 18 1A 52 54(00 01) 60(11 12 0F 15 21 22 2F 35 ) 62 6C 6E 70 72(50 64 78 8C A0) 86(01 0A 12 13 14 15 16 17 18 19 1A 1B 23)87 8D(01 02) A4 A5 AC AE B2 B6 C0 C6 C8 CA(01 02) CC(01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 12 14 16 17 1A 1E 24) D6(01 04 05) DA(00 02) DC(00 01 03 04 05 06 07 08 0B 0E 11 20 21 22 23 24 30 33 51 E2) DF E9(00 02) E0(01 02 03 05) E2A000(46 47 48 49 4A 4B) E2A001(00 01 02 03 04) E2A004(00 01 02) E2A006(00 01 02 03) E2A007(00 01) E2A008(00 01) E2A009(01 02 03 04 05 06 07) E2A00A E2A00B E2A00C E2A00D E2A00E E2A00F E2A010(00 01 02 03 04) E2A011(00 01 02 03 04) E2A012(00 01) E2A013(00 01) E2A015(00 01 02) E2A016(00 01) E2A017(00 01) E2A019(00 01 02 03 04 05 06 07) E2A01A(00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D) E2A01B(00 01 02 03) E2A01C(00 01 02) E2A01D(00 01 02) E2A020(02 03 04  0F) E2A024(00 01 02 03 04) E2A034(00 02 03 04) E2A035(00 02 03) E2A036(00 01) E2A038(01) E2A039 E2A040(00 01) E2A041(00 01 02) E2A042(30 31 32 33 34 35 36 37 38 39 3A 3B 3C 3D 3E 3F) E2A043(00 01) E2A044(00 01 02 03) EC(01 02 03) ED(00 01) F0(00 01) F2(00 01 02 03 04) F6(01) F7(42)FD FF)mswhql(1)asset_eep(40)mccs_ver(2.2))
```

(`E2A020(02 03 04  0F)` really contains a double space.)

---

## 5. Transport layer

### 5.1 Selection and fallback (PB/Display.cs:354-474) (CONFIRMED)

The same pattern is used for `GetStandardValue`, `SetStandardValue`, `GetTPVExternValue` and `SetTPVExternValue`:
1. If `MonitorDevice != null`, try the hub: `MonitorService.Get/SetStandardDDC` or `Get/SetExtendDDC(dev, 0xE2, 0xA0, ext)`. `ErrorCode.Success` returns 0. Otherwise it logs `Hub … errorCode=…` and falls through.
2. For each `DDCDisplays` entry with `IsSupportDDCCI`, call `NewDDCOper.*` with `DisplayID`. The first result of 0 wins, and otherwise the method returns -1 or the last error.

Log formats (useful for diffing a Linux implementation):
- `Hub GetStandardValue command=%02x value=%x maxValue=%x result=%d`
- `Hub GetTPVExternValue command=e2a0%02x …`
- `Hub SetTPVExternValue command=… value=…`
- The DDC variants start with `DDC …`.
- The display-probe line at PB/Display.cs:235 prints "Hub SetStandardDDC" even though it performs a **Get** of VCP 60.

### 5.2 DDC/CI packet formats (CONFIRMED: ML/Interface2.cs:15-30,155-282; DDCHelper DC/Zeasn.DDC.Lib/Class1.cs:332-462 + work/native/DDCHelperLib.dll.c:6913-6980, 9004-9230)

Host → monitor (7-bit I2C address 0x37; the 8-bit write address 0x6E is the first byte on the hub path):

| Operation | Bytes (chk = XOR of every preceding byte, including 0x6E) |
|---|---|
| Get standard VCP `cc` | `6E 51 82 01 cc chk` |
| Set standard VCP `cc` = v | `6E 51 84 03 cc vH vL chk` |
| **Get extended `E2A0xx`** | `6E 51 84 01 E2 A0 xx chk` |
| **Set extended `E2A0xx`** = v | `6E 51 86 03 E2 A0 xx vH vL chk` |
| Capabilities fragment | `6E 51 83 F3 offH offL chk` |
| Raw `GetDDC(cmds…)` | `6E 51 (0x80+len+1) 01 cmds… chk`, where cmds are at most 27 bytes |
| Raw `SetDDC(cmds…)` | `6E 51 (0x80+len+1) 03 cmds… chk` |

Notes on the request side:
- `imethod_4` places the checksum at index `len` of a zero-padded 32-byte buffer and sends `len+1` bytes (ML/Interface2.cs:15-30).
- DDCHelper builds the same frame without the leading 0x6E: `51, 0x80|n, payload…, chk` with `chk = (0x80|n) ^ 0x3F ^ …`, where 0x3F = 0x6E^0x51. It **sleeps 100 ms after every write** (DDCHelperLib.dll.c FUN_1000be10).

Monitor → host reply (read from 0x6F):

```
6E  (0x80|n)  data[0..n-1]  chk      with   0x50 ^ 6E ^ (0x80|n) ^ data… ^ chk == 0
```

Standard VCP reply data: `02 RC cc TP MH ML SH SL` (n=8).

- **Hub parsing is length-relative.** `n = reply[1]-0x80`, `value = reply[n]<<8 | reply[n+1]`, `max = reply[n-2]<<8 | reply[n-1]`. The last 4 data bytes are always max and current, whatever n is (ML/Interface2.cs:209-214, 254-259).
- **DDCHelper parsing uses fixed positions.** It reads n (at most 8), then takes `max = data[4..5]` and `value = data[6..7]` (DDCHelperLib.dll.c:6946-6951, FUN_1000b980). It **sleeps 50 ms after every read**.
- **INFERRED:** because the vendor treats both paths as equivalent, the monitor answers extended gets with a standard 8-byte reply. A port should still parse relative to the length.
- Reply validation on the hub: `reply[0]==0x6E`, `reply[1]>0x80`, `n<=30`, checksum OK. Can be disabled with the setting `DISABLE_CHECK_SUM` (ML/Class45.cs:139-144).

### 5.3 USB-DDC over the VIA hub (the user's path) (CONFIRMED: ML/Interface13.cs, ML/Class44.cs)

- Open: `CreateFile(path, GENERIC_READ|WRITE, FILE_SHARE_READ|WRITE, OPEN_EXISTING, FILE_FLAG_OVERLAPPED|FILE_ATTRIBUTE_NORMAL)` (ML/Class40.cs:12-15), then `WinUsb_Initialize`.
- All I2C traffic uses **WinUSB control transfers on the default pipe** with `WINUSB_SETUP_PACKET {RequestType, Request, Value, Index, Length}` (ML/Class44.cs:8-19):

| Primitive (real method name kept in code) | bmRequestType | bRequest | wValue | wIndex | wLength / data | Used for |
|---|---|---|---|---|---|---|
| `imethod_11` I2C write (full) | 0x40 | **0xB2** | 0 | 0 | len, data = the frame starting with `6E` | every DDC write/request |
| `imethod_12` I2C read (full) | 0xC0 | **0xA3** | 0 | `buf[0]` = **0x6F** (read address, pre-filled) | 32 | every DDC reply |
| `I2CReadCmd_Start` | 0xC0 | 0xA7 | 0 | `buf[0]` = 0x6F | 32 | capabilities (A7A9 mode) first half |
| `I2CReadCmd_DataACK` | 0xC0 | 0xA8 | 0 | `buf[0]` | n | (not used for DDC) |
| `I2CReadCmd_DataNACK` | 0xC0 | 0xA9 | 0 | `buf[0]` = 0 | 32 | capabilities second half, appended at offset 32 |
| `I2CWriteCmd_Start` | 0x40 | 0xB7 | 0 | 0 | n | ISP (RTK scaler, address 0x94); OTA only |
| `I2CWriteCmd_DataNP` | 0x40 | 0xB8 | 0 | 0 | n | ISP |
| `I2CWriteCmd_DataP` | 0x40 | 0xB9 | 0 | 0 | n | ISP |

- The `Interface1` wrappers used by `Interface2` are write-then-sleep-100 ms and read-then-sleep-50 ms (ML/Interface13.cs:271-293).
  - INFERRED mapping: `imethod_2` = write+100 ms and `imethod_3` = read+50 ms. This comes from declaration order and matches the observed timings: sets take about 108–110 ms and gets about 185–200 ms.
  - The same pairing holds for the RTK (ML/Interface12.cs:62-84) and Genesys (ML/Interface10.cs:142-219) transports.
- **Each control transfer** is retried by `Util.smethod_0(func, 3, 177)`: up to 3 attempts, sleeping `(n+1)*177` ms after the n-th failure (ML/Zeasn.Monitor.Lib.Utils/Util.cs:24-45).
- **Each DDC get** (`GetStandardData`, ML/Interface2.cs:32-93):
  1. Write (+100 ms).
  2. Sleep `max(15, sleepTime - elapsedWriteMs)`, with sleepTime = 100 for `GetDDC`.
  3. Read 32 bytes (+50 ms).
  4. Verify the checksum.
  5. Repeat up to **3 attempts**.
- Setting `DEMO_MODE` logs raw frames (`Class45.bool_3`).

### 5.4 Other hub transports (summary, CONFIRMED)

- **RTK HID** (`lib\RTK\RhHidAPI.dll`, ML/Interface12.cs:62-84):
  - write `RH_HidI2CWrite(h, 0x51, frame[2..], len-2)` (strips `6E 51`)
  - read `RH_HidI2CRead(h, 0x51, buf, len)`
- **Genesys** (`GL_SDK.dll SendControlPipe`, ML/Interface10.cs:142-219):
  - DDC write `0x40/0x7C (124), wValue 0, wIndex 0`
  - DDC read `0xC0/0x7F (127), wValue 1, wLength len+1`; the reply is shifted by one byte
  - ISP modes use requests 0x7A/0x7B/0xAA/0xAB
- See the native RTK/Genesys reports.

### 5.5 GPU I2C through DDCHelperLib (fallback) (CONFIRMED, see the DDC report for internals)

- The P/Invoke struct `Struct0` (DC/Zeasn.DDC.Lib/Struct0.cs) contains:
  - `byte[520] send`, `byte sendLen`, `byte[520] recv`, `byte recvLen`
  - `int displayId`, `byte vcp`, `int value`, `int mode`, `int max`
- `getTPVExternDDCCIValue_C` sends `send = [01, E2, A0, xx]`, len 4, expecting 8 bytes back (Class1.cs:409-435).
- `setTPVExternDDCCIValue_C` sends `[03, E2, A0, xx, vH, vL]`, len 6 (Class1.cs:437-462).
- Native retry: up to 3 write+read pairs with `Sleep(attempt*5)` between them; on failure it returns 0x70000000 (DDCHelperLib.dll.c:6917-6955).
- Every call goes through `Task.Run(...).Wait()` under a static lock.
- On the user's machine DDCHelper works through AMD ADL (`EnumA_ATI`, `atiA_Invoke`); its WinRing0/PCI driver path is unavailable (`CreateFile Failed: 2`, LOG25:176-177).

### 5.6 Concurrency and state guards (CONFIRMED)

- One process-wide lock (`Const_Lock.Monitor`) serialises `MonitorService` and `NewDDCOper`.
- While `InFirmwareUpdate` is true, all DDCHelper calls return -1 (NewDDCOper.cs:100-161).
- PHL_* calls are otherwise not serialised against each other beyond this lock. For example, `SetInputSource` is a multi-step sequence and could interleave with a UI-triggered read (INFERRED risk).

### 5.7 Real traffic on the 34M2C8600 (CONFIRMED, LOG25:656-739 and LOG26:913-993)

This is the connect/reload read sequence, all over the VIA hub. The monitor was in HDR mode: DC=0x21 ("HDR Game"), and `IsSmartImageHDR` was true in PROF.

| Code | Value (hex) | Max (hex) | Code | Value (hex) | Max (hex) |
|---|---|---|---|---|---|
| DC | 21 | 35 | E2A00E | 32 | 64 |
| 10 | 64 | 64 | E2A00F | 32 | 64 |
| 12 | 32 | 64 | E2A010 | 00 | 04 |
| E2A040 | 01 | 01 | E2A011 | 02 | 04 |
| E2A004 | 00 | 02 | 86 | 02 | 23 |
| E2A044 | 00 | 03 | E2A012 | 01 | 01 |
| E2A006 | 00 | 03 | E2A013 | 01 | 01 |
| E2A007 | 00 | 01 | E2A015 | 00 | 02 |
| E2A008 | 00 | 01 | E2A016 | 00 | 01 |
| E2A009 | 01 | 07 | 54 | 02 | 04 |
| E2A00A | 64 | 64 | DA | 02 | 08 |
| E2A00B | 32 | 64 | F2 | 01 | 04 |
| E2A00C | 00 | 05 | CC | 02 | 24 |
| E2A00D | 00 | 00 | E9 | 00 | 02 |
| E2A019 | 00 | 07 | E2A017 | 00 | 01 |
| E2A01A | 06 | 0d | E2A035 | 02 | 03 |
| E2A01B | 00 | 03 | E2A034 | 03 | 04 |
| E2A01C | 02 | 02 | E2A036 | 00 | 01 |
| E2A01D | 00 | 02 | E2A043 | 00 | 01 |
| ED | 01 | 01 | E2A041 | 01 | 02 |
| 60 | 0f | 3616 | 14 (probe) | 05 | 0D |
| A5 | 00 | 200 | | | |
| EC | 00 | 00 | | | |
| F6 | 00 | 00 | | | |
| 62 | 00 | 64 | | | |
| 8D | 02 | 02 | | | |
| E2A000 | 46 | 4b | | | |
| E0 | 03 | 08 | | | |

Between E0 and E2A00E, the EQ loop runs 5 times: `set E2A001=b; 100 ms; get E2A039 → 08/10` (b = 0..4).

The only user-initiated write in the logs: `PHL_SetOSD ["EXT_OP_E2A0_43_AutoWarning",1]`, which produced `Hub SetTPVExternValue command=e2a043 value=01 result=0` (LOG26:1087-1088). The subsequent reload read back E2A043 = 01.

---

## 6. Complete VCP table

Legend:
- **R/W** is what the app does:
  - R = read in module loads
  - W = written by `PHL_SetOSD` or the named function
  - T = trigger (write-only command)
- **34M2C8600** column: `–` means not in the capability string (the attribute gets `err_code` 9). Otherwise it gives the capability values and the value read (see §5.7).
- The source for every enum is `PE/<EnumName>.cs`. Values are decimal unless written 0x….
- All values travel as the 16-bit current value of the VCP (`vH vL`).

### 6.1 Standard MCCS codes handled (StandardVCPOpCode_E without `[UnbindEnumExtended]`, PE/StandardVCPOpCode_E.cs)

| VCP | OSD item name | Feature / module | Value encoding | R/W | 34M2C8600 |
|---|---|---|---|---|---|
| 0x04 | `OP_04_RestoreFactoryDefaults` | factory reset (`Profile_Reset`) | write 1 (`SwitchFlag_E.ON`), then wait 5000 ms | T | supported |
| 0x10 | `OP_10_Luminance` | brightness; SmartImage / SmartImageHDR sub-module | 0..max (max 100) | R/W | 0x64 |
| 0x12 | `OP_12_Contrast` | contrast; both sub-modules | 0..max | R/W | 0x32 |
| 0x14 | `OP_14_SelectColorPreset` | colour temperature (`PHL_SetColorPreset`) | `VCP_14_SelectColorPreset`: 1 sRGB, 2 Native, 4 5000K, 5 6500K, 6 7500K, 7 8200K, 8 9300K, 10 11500K, **11 User1/UserRGB**, 12 User2 (AdobeRGB), 13 User3 | R/W | (02 04 05 06 07 08 0A 0B 0D); 0x05 |
| 0x16 / 0x18 / 0x1A | `OP_16_VideoGainDriveRed` / `OP_18_…Green` / `OP_1A_…Blue` | user RGB gains (only meaningful when 0x14 = 11) | 0..max | R/W | supported (not read while in HDR) |
| 0x54 | `OP_54_PerformancePreservation` | "Pixel Orbiting" (standard code); System | `VCP_54_PixelOrbiting`: 0 ON, 1 OFF | R/W | (00 01); read 0x02 (outside the enum) |
| 0x60 | `OP_60_InputSource` | input + PIP/PBP sub-source; Input | **low byte** = main input (`VCP_60_InputSource_E`: 1 VGA1, 2 VGA2, 3 DVI1, 15 DP1, 16 DP2, 17 HDMI1, 18 HDMI2, 19 HDMI3, 21 USB-C1, 22 USB-C2, 23 TB1, 24 TB2); **high byte** = PIP/PBP sub-source (`VCP_60_PIPPBPSource_E`: 33 HDMI1, 34 HDMI2, 35 HDMI3, 36 DVI1, 47 DP1, 48 DP2, 49 VGA1, 50 VGA2, 53 USB-C1, 54 USB-C2, 55 TB1, 56 TB2) | R/W | (0F 11 12 15 \| 21 22 2F 35); 0x0F |
| 0x62 | `OP_62_AudioSpeakerVolume` | volume; Audio | 0..max (100) | R/W | 0x00 |
| 0x72 | `OP_72_Gamma` | gamma; SmartImage | `VCP_72_Gamma`: 80 = 1.8, 100 = 2.0, 120 = 2.2, 122 = sRGB, 140 = 2.4, 160 = 2.6 | R/W | (50 64 78 8C A0) |
| 0x86 | `OP_86_DisplayScaling` | "SmartSize"/aspect; System | `VCP_86_DisplayScaling` (1 1:1, 2 MaxImage, 4 16:9, 8 Zoom, 17–27 panel-size emulations 17"…27"W, 33/34 Movie1/2, 35 4:3, 36–47 more sizes). **10 = "Support Smart Size" is Unbind**, so it is excluded | R/W | (01 0A 12..1B 23); 0x02 |
| 0x87 | `OP_87_Sharpness` | sharpness; SmartImage | 0..max | R/W | supported |
| 0x8A | `OP_8A_Saturation` | saturation; SmartImage | 0..max | R/W | – |
| 0x8D | `OP_8D_AudioMute` | mute; Audio | `VCP_8D_AudioMute`: 1 On (muted), 2 Off | R/W | (01 02); 0x02 |
| 0x90 | `OP_90_Hue` | hue; SmartImage | 0..max | R/W | – |
| 0xA4 | `OP_A4_WindowMaskControl` | "commit" after an input/PIP change | written 0xFFFF | T | supported |
| 0xA5 | `OP_A5_WindowSelect` | PIP/PBP mode; Input | table chosen by F7 (§6.4): 0 off, 0x100 PIP, 0x200 PBP-1, 0x400 PBP-2, 0x800 PBP-3 | R/W | supported; 0 (max 0x200) |
| 0xAA | `OP_AA_ScreenOrientation` | parsed (`VCP_AA_ScreenOrientation` 1 = 0°, 2 = 90°, 4 = 270°, 5 PMS) but **no module property**, so unused | – | – | – |
| 0xCC | `OP_CC_OSDLanguage` | OSD language; Setup | `VCP_CC_OSDLanguage`: 1 zh-TW, 2 en, 3 fr, 4 de, 5 it, 6 ja, 7 ko, 8 pt-PT, 9 ru, 10 es, 11 sv, 12 tr, 13 zh-CN, 14 pt-BR, 18 cs, 20 nl, 22 fi, 23 el, 26 hu, 30 pl, 36 uk | R/W | 21 values; 0x02 |
| 0xD6 | `OP_D6_PowerMode` | parsed (`VCP_D6_SmartPower` 1 on, 4 standby, 5 off); **no module property** | – | – | (01 04 05) |
| 0xDA | `OP_DA_ScanMode` | overscan; System | `VCP_DA_ScanMode`: 0 normal, 2 overscan | R/W | (00 02); 0x02 |
| 0xDC | `OP_DC_DisplayApplication` | **SmartImage preset** (`PHL_SetSmartImage`) | see §6.3 | R/W | see §6.3; 0x21 |
| 0xE0 | `OP_E0_AudioSource` | audio source; Audio | `VCP_E0_AudioSourceSelect`: 0 PC/Line-in, 1 HDMI1, 2 HDMI2, 3 DP1, 4 DP2, 5 USB-C1, 6 USB-C2, 7 HDMI3, 8 AUTO, 9 TB1, 10 TB2 | R/W | (01 02 03 05); 0x03 |
| 0xE9 | `OP_E9_ResolutionNotifier` | resolution notice; Setup | 0 off, 2 on | R/W | (00 02); 0 |
| 0xEB | `OP_EB_SmartResponse` | overdrive; GameMode | 0 off, 1 fast, 2 faster, 3 fastest | R/W | – |
| 0xEC | `OP_EC_PIPPBPSizeLocation` | PIP size + position; Input | **low byte** = size (`VCP_EC_PIP_Size` 1 small, 2 middle, 3 large); **high byte** = location (`VCP_EC_PIP_Location` 1 upper-right, 2 lower-right, 3 upper-left, 4 lower-left) | R/W | (01 02 03); 0 |
| 0xED | `OP_ED_InputAuto` | auto input; Input | 0/1 | R/W | (00 01); 1 |
| 0xF0 | `OP_F0_SmartContrast` | SmartContrast; SmartImage | 0/1 | R/W | (00 01) |
| 0xF2 | `OP_F2_PowerLED` | power LED level; Setup | 0..4 | R/W | (00..04); 1 |
| 0xF6 | `OP_F6_PIPPBPSwap` | swap main and sub | write 1 | T (also R) | (01); 0 |
| 0xF7 | `OP_F7_PIPPBPType` | PIP/PBP capability (from caps only, never read) | 2/3/4 = PBP-only with 2/3/4 windows; 64 PIP only; 66/67/68 PIP + PBP 2/3/4 | caps | (42) = PIP + 2-window PBP |

Codes used only by `Zeasn.Monitor.Lib` or the DDC layer:
- 0xC8 (controller type, gives ScalerIC)
- 0xC9 (FW level, for the cache key when there is no hub)
- 0xF3/0xE3 (capabilities request/reply)

Codes that are Unbind and therefore ignored even when present: 0x00–0x03, 0x05–0x0F, 0x11, 0x13, 0x15, 0x17, 0x1B–0x52, 0x59–0x5F, 0x6C–0x70, 0x73–0x85, 0x88, 0x8B, 0x8C, 0x8E, 0x8F, 0x91–0xA3, 0xA6–0xC9, 0xCA, 0xCD–0xD5, 0xD7–0xDB, 0xDD–0xDF, 0xE1–0xE8, 0xEA, 0xEE, 0xEF, 0xF1, 0xF3–0xF5, 0xF8–0xFF (PE/StandardVCPOpCode_E.cs).

### 6.2 TPV/Philips extended codes `E2 A0 xx` (PE/E2A0_ExternVCPOpCode_E.cs; value lists PB/DataOSD.cs:245-382)

| xx | OSD item name (`EXT_OP_E2A0_…`) | Module | Values (enum) | R/W | 34M2C8600 |
|---|---|---|---|---|---|
| 00 | `00_AudioMode` | Audio | `E2A0_00_AudioMode_E`: 64 Standard, 65 Game, 66 Classical, 67 Rock, 68 Live, 69 Theater, **70 Off**, 71 Sports&Racing, 72 RPG&Adventure, 73 Shooting&Action, 74 Movie, 75 Music, 76 Personal, 80–84 "BASS+" variants of 71–75 | R/W | (46..4B); 0x46 Off |
| 01 | `01_AudioEQ` | EQ **band selector** | `E2A0_01_AudioEQ_E`: 0 = 100 Hz, 1 = 300 Hz, 2 = 1 kHz, 3 = 3 kHz, 4 = 10 kHz | W (index) | (00..04) |
| 02 | `02_MBR` | GameMode | >0 means on (no value list) | R/W | – |
| 03 | `03_MBRSync` | GameMode | 0/1 | R/W | – |
| 04 | `04_SmartCrosshair` | GameMode | 0 Off, 1 On, 2 "Smart Crosshair On" | R/W | (00 01 02); 0 |
| 05 | `05_ShadowBoost` | **Unbind (ignored)** | `E2A0_05_ShadowBoost_E` 0..3 | – | – |
| 06 | `06_SharpShooter_Size` | "Smart Sniper" size | 0 Off, 1 = 1.0, 2 = 1.5, 3 = 2.0 | R/W | (00..03); 0 |
| 07 | `07_LowInputLag` | GameMode | 0/1 | R/W | (00 01); 0 |
| 08 | `08_SmartFrame` | on/off (`PHL_SwitchSmartFrame`) | 0/1 | R/W | (00 01); 0 |
| 09 | `09_SmartFrameSize` | `PHL_SetSmartFrameSize` | `Num_0_E` 0..7 | R/W | (01..07); 1 |
| 0A | `0A_SmartFrameBrightness` | GameMode | 0..max (100) | R/W | 0x64 |
| 0B | `0B_SmartFrameContrast` | GameMode | 0..max (100) | R/W | 0x32 |
| 0C | `0C_SmartFrameHPosition` | GameMode | 0..max (max depends on size; was 5) | R/W | 0 |
| 0D | `0D_SmartFrameVPosition` | GameMode | 0..max (was 0) | R/W | 0 |
| 0E | `0E_OSDSettingHorizontal` | System | 0..100 | R/W | 0x32 |
| 0F | `0F_OSDSettingVertical` | System | 0..100 | R/W | 0x32 |
| 10 | `10_OSDSettingTransparency` | System | `Num_Off_E` 0 Off, 1..7 | R/W | (00..04); 0 |
| 11 | `11_OSDSettingTimeOut` | System | 0 = 5 s, 1 = 10 s, 2 = 20 s, 3 = 30 s, 4 = 60 s | R/W | (00..04); 2 |
| 12 | `12_USB_C_Setting` | System | 0 USB 2.0 (high resolution), 1 USB 3.2 (high data speed) | R/W | (00 01); 1 |
| 13 | `13_USB_StandbyMode` | System | 0/1 | R/W | (00 01); 1 |
| 14 | `14_USB_Upstream` | System | 0 USB-C, 1 USB-Up | R/W | – |
| 15 | `15_KVM` | System | 0 Auto, 1 USB-C, 2 USB-Up, 3 USB-C2, 4 Thunderbolt | R/W | (00 01 02); 0 |
| 16 | `16_SmartPower` | System | 0/1 | R/W | (00 01); 0 |
| 17 | `17_CEC` | Setup | 0/1 | R/W | (00 01); 0 |
| 18 | `18_LocalDimming` | System | 0 Off, 1 On, 2 weak, 3 medium, 4 strong | R/W | – |
| 19 | `19_AmbiglowLightMode` | Ambiglow | `E2A0_19_AmbiglowLightMode_E`: **0 Off (Unbind, so never in ValueList)**, 1 FollowVideo, 2 FollowAudio, 3 ColorShift, 4 ColorWave, 5 ColorBreathing, 6 StarryNight, 7 Static, 8 ColorFlowReverse, 9 ColorFlow | R/W | (00..07); 0 |
| 1A | `1A_AmbiglowColors` | Ambiglow | 0 Rainbow, 1 White, 2 Red, 3 Rose, 4 Magenta, 5 Violet, 6 Blue, 7 Azure, 8 Cyan, 9 Aqua, 10 Green, 11 Pear, 12 Yellow, 13 Orange | R/W | (00..0D); 6 |
| 1B | `1B_AmbiglowLightPosition` | Ambiglow | 0 All zones, 1 4-sided, 2 Central, 3 Bottom, 4 3-sided-A, 5 3-sided-B, 6 Right-Left | R/W | (00..03); 0 |
| 1C | `1C_AmbiglowLightBrightness` | Ambiglow | 0 Bright, 1 Brighter, 2 Brightest | R/W | (00..02); 2 |
| 1D | `1D_AmbiglowLightSpeed` | Ambiglow | 0 Low, 1 Normal, 2 High | R/W | (00..02); 0 |
| 1E | `1E_AmbiglowLightDirection` | Ambiglow | 0 R→L, 1 L→R | R/W | – |
| 1F | `1F_HDMIRefreshRate` | (parsed, no module property) | 0..2 = HDMI1..3 status | – | – |
| 20 | `20_ColorSpace` | SmartImage | `E2A0_20_ColorSpace_E`: 0 Standard, 1 NTSC, 2 sRGB, 3 AdobeRGB, 4 DCI-P3, 5 Rec2020, 6 Rec709, 7 D-mode, 8 Rec2020 HDR, 9 DCI-P3 HDR, 10 Off, 11 On, 12 AdobeRGB (D50), 13 DCI-P3 (D50), 14 Display-P3, 15 Native, 16 AutoGamut, 17 Multi-ColorSync | R/W | (02 03 04 0F) |
| 21 | `21_DPOutMultiStream` | (parsed only) | 1 Clone, 2 Extend | – | – |
| 22 | `22_ErgoSensor` | (parsed only) | 0 Off, 1 On, 2 Demo | – | – |
| 23 | `23_LightSensor` | (parsed only) | 0/1 | – | – |
| 24 | `24_DLBL` | "LowBlue" level; SmartImage | `Level_Off_E` 0 Off, 1..4 | R/W | (00..04) |
| 25 | `25_SharpShooter_Location` | GameMode | 0 Center, 1 Top | R/W | – |
| 26–2F | DPS, SmartDemo, AudioStandAlone, NoiseCancelling, AudioRecover, Bluetooth, OSDRotate, PowerOnLogo, SetupRS232, MiracastUpdate | parsed only (on/off), no module property | 0/1 | – | – |
| 30 / 31 | `30/31_OSDSettingUserKey1/2` | parsed only | `E2A0_SettingUser_E` 0 AudioSource, 1 Volume, 2 Input, 3 PowerSensor, 4 ColorSpace, 5 KVM, 6 MultiView, 7 Brightness, 8 USB setting, 9 HDR colour space | – | – |
| 32 / 33 | Webcam, WebcamLight | parsed only | 0/1; `Num_0_E` | – | – |
| 34 | `34_PixelOrbiting` | Setup (OLED) | 0 Off, 1 On, 2 Slow, 3 Normal, 4 Fast | R/W | (00 02 03 04); 3 |
| 35 | `35_ScreenSaver` | Setup (OLED) | 0 Off, 1 On, 2 Slow, 3 Fast | R/W | (00 02 03); 2 |
| 36 | `36_PixelRefresh` | Setup (OLED) | UI "Refresh" button sends the ON value (1) after a confirmation dialog (AP/renderer/assets/Setup-D-5j4V-I.js:48-68,244-251) | R / T | (00 01); 0 |
| 37 | `37_PanelRefresh` | Setup | same as 36 | R / T | – |
| 38 | `38_AmbiglowSet` | Ambiglow reset (`Effect_Reset` without ENE) | write 1, then 200 ms, then re-read Ambiglow | T | (01) |
| 39 | `39_AudioEQGain` | EQ gain for the band selected by 01 | 0..max (max 16; 8 = flat) | R/W (indexed) | 08/0x10 |
| 3A/3B/3C | `3A/3B/3C_HDMIxRefreshRate` | System | `E2A0_HDMIRefreshRate_E`: 0 = 120 Hz, 1 = 138, 2 = 144, 3 = 165, 4 = 200, 5 = 240, 6 = 260, 7 = 280, 8 = 300, 9 = 320, 10 = 360, 11 = 380, 12 = 4K, 13 = 5K, 14 = 540, 15 = 600, 16 = 160, 17 = 500, 18 = 610, 19 = 400, 20 = 310, 21 = 425, 22 = 340, 23 = 1000 | R/W | – |
| 3D/3E/3F | `3D_LightEnhancement` / `3E_ColorEnhancement` / `3F_DarkEnhancement` | SmartImageHDR | 0..max | R/W | – |
| 40 | `40_AdaptiveSync` | GameMode | 0/1 | R/W | (00 01); 1 |
| 41 | `41_FanControl` | Setup | 0 Off, 1 Auto, 2 Quiet | R/W | (00 01 02); 1 |
| 42 | `42_FunctionReset` | SmartImage reset (`PHL_ResetSmartImage`) | `E2A0_42_ResetSmartImage_E` (§6.3) | T | (30..3F) |
| 43 | `43_AutoWarning` | Setup | 0/1 | R/W | (00 01); 0, then set to 1 by the user |
| 44 | `44_StarkShadowBoost` | GameMode | `Level_Off_E` 0 Off, 1..4 | R/W | (00..03); 0 |
| 45 | `45_ShadowBoost` | GameMode | `Level_Off_E` | R/W | – |
| 46 / 47 | LEA / `47_UniBright` | 47 in Setup | 0/1 | R/W | – |
| 48 / 49 / 4A | `48_MultiLogoProtection` / `49_BoundaryDimmer` / `4A_TaskbarDimmer` | Setup (OLED) | `Num_Off_E` 0 Off, 1..7 | R/W | – |
| 4B | `4B_ThermalProtection` | Setup | 0/1 | R/W | – |
| 4C | `4C_Overclock` | GameMode | 0/1; also filters DualResolution (§7.11) | R/W | – |
| 4D/4E, (4F) | `OLEDInfoWorkingTimeH/L/(M)` | builds `ModuleSetup.WorkingTime = (H<<16)\|L` (hours per the UI "H" suffix) | 16-bit words | R | – (WorkingTime = -1) |
| 50/51, (53) | `OLEDInfoTimeAfterPixelRefreshH/L/(M)` | `TimeAfterPixelRefresh = (H<<16)\|L` | 16-bit words | R | – (-1) |
| 54 / 55 | `54_PixelRefreshCounts` / `55_PanelRefreshCounts` | Setup info | counters | R | – |
| 59 | `59_DualResolution` | GameMode | **low byte** = mode (`E2A0_59_DualResolution_E`, 34 entries: 0 UHD120, 1 UHD160, 6 UHD180, 19 UHD190, 7 UHD200, 4 UHD240, 50 FHD240, 3 FHD320, 2 FHD360, 20 FHD380, 8 FHD400, 5 FHD480, 9 WUHD120, 16 WFHD240, 17 5K165, 38 5K175, 24 5K180, 32 QHD144, 39 QHD200, 51 QHD230, 34 QHD240, 35 QHD260, 41 QHD275, 18 QHD330, 37 QHD350, 25 QHD360, 21 QHD500, 22 QHD540, 40 HD280, 33 HD288, 36 HD400, 48 HD500, 49 HD540, 23 HD1000); **high byte** = split index (§7.11). Value list keeps the capability order | R/W | – |
| 61 | `61_AutoPixelRefresh` | Setup | 0/1 | R/W | – |
| 68 | `68_AutoRefineAIStatus` | GameMode | `Level_Off_E` | R/W | – |
| 6B | `6B_Profile` | System (`PHL_ProfileAction`) | write `(action_code<<8) \| profile`; action 0 → 0xA0, 1 → 0xA1, 2 → 0xA2, other → 0xA0; profile values `E2A0_6B_Profile_E` 1 / 2. Meaning of A0/A1/A2 is INFERRED to be recall/save/reset | T | – |
| 88 | `88_GamePQ` | (parsed; **never written**, §7.14) | `E2A0_88_GamePQ_E`: 0 Off, 1 ObjectOutlineEnhancement, 2 NegativeEffect, 3 ColorFilter (+ mask in the high byte), 4 NonLinearScaling | – | – |

### 6.3 SmartImage (VCP DC) tables and the reset mapping (CONFIRMED)

The last byte of DC's capability sub-list selects the table (PB/DataOSD.cs:195-222):

| Table | Values |
|---|---|
| `SmartImage_E1` (0xE1) | 0 Standard, 1 Office, 2 Photo, 3 Movie, 5 Games, 8 Economy, 14 EasyRead, 31 SmartUniformity, 80 D-Mode |
| **`SmartImage_E2` (0xE2)** (user's monitor) | 0 Standard, 1 FPS, 3 Movie, 4 Game1, 5 Game2, 6 Racing, 7 RTS, 8 Economy, 11 LowBlueMode, 14 EasyRead, 15 XBoxMode, **16 Off**, 17 ConsoleMode, 31 SmartUniformity, 80 D-Mode, 81 Illustrator |
| `SmartImage_E3` (0xE3) | 0 Standard, 1 Internet, 5 Games, 11 LowBlueMode, 14 EasyRead |
| `SmartImage_E4` (0xE4) | 0 Off, 1 Text, 2 Level1, 3 Video, 4 Standard, 5 sRGB, 7 Clinical D-Image |
| `SmartImageHDR_E` (always appended if present) | 32 HDR Off, 33 Game, 34 Movie, 35 Photo, 36 Personal, 37 Normal, 38 DisplayHDR-xxxx, 39 Xbox, 40 Rec2020, 41 DCI, 42 Adobe, 43 Rec709, 44 Premium, 45 Effect, 46 Warm, 47 Basic, 48 TrueBlack, 49 HLG, 50 Vivid, 51 Peak |

34M2C8600 decoded (caps `DC(00 01 03 04 05 06 07 08 0B 0E 11 20 21 22 23 24 30 33 51 E2)`):
- **SDR**: Standard, FPS, Movie, Game1, Game2, Racing, RTS, Economy, LowBlue, EasyRead, ConsoleMode, Illustrator.
- **HDR**: Off, Game, Movie, Photo, Personal, TrueBlack, Peak.
- This matches `ModuleSmartImageHDR.Items` in PROF.

`PHL_ResetSmartImage(dc)` writes `E2A042 = GetResetSmartImageValue(dc)` (PB/DataOSD.cs:433-479). Mapping, as coded:

| DC | E2A042 | DC | E2A042 |
|---|---|---|---|
| 0 Standard | 48 (0x30) | 17 ConsoleMode | 63 |
| 1 FPS | 49 | 31 SmartUniformity | 56 |
| 3 Movie | 52 | 33 HDR Game | 59 |
| 4 Game1 | 57 | 34 HDR Movie | **48** (enum says 60; probably a vendor bug) |
| 5 Game2 | 58 | 35 HDR Photo | **61** (= HDR Vivid reset) |
| 6 Racing | 50 | 36 HDR Personal | 62 |
| 7 RTS | 51 | 50 HDR Vivid | 61 |
| 8 Economy | 55 | 51 HDR Peak | 65 |
| 11 LowBlue | 53 | 81 Illustrator | 64 |
| 14 EasyRead | 54 | **any other** (for example 48 HDR TrueBlack) | logs an error and **writes 0** |

"Off" (16 SDR, 32 HDR) returns an error before any I/O.

### 6.4 PIP/PBP mode tables for A5, chosen by `F7ValueList[0]` (PB/DataOSD.cs:406-431, PE/VCP_A5_PIPPBPType_*.cs)

| F7 | A5 values |
|---|---|
| 0x02 | 0 Off, 0x200 PBP |
| 0x03 | 0, 0x200, 0x400 |
| 0x04 | 0, 0x200, 0x400, 0x800 |
| 0x40 | 0, 0x100 PIP |
| **0x42** (user's) | **0, 0x100 PIP, 0x200 PBP** |
| 0x43 | 0, 0x100, 0x200, 0x400 |
| 0x44 | 0, 0x100, 0x200, 0x400, 0x800 |

The UI's mode dropdown is this list without 0 (AP/renderer/assets/System-DT9nKs1q.js:349).

---

## 7. Feature semantics (exact sequences)

All delays are `Thread.Sleep` in the backend, on top of the transport delays in §5.3. Unless noted, every function ends with `RecheckFuncConstraints` (§8) and `SaveProfile` (fires `EVT_Com.SaveCurThemeProfile`, which persists to the theme `.pcenter` file).

### 7.1 Load: `method_4` (connect / `PHL_ReloadData` / after Reset) (PHL/…:296-468)

1. **USB watchers and cache object.** Snapshot the USB watchers. Create a new `CacheDeviceData` with `ModelName = CurDisplay.MonitorName` and `DispalyData.MonitorEDIDInfo_T` = the EDID. Resolution, frequency and orientation come from Windows.
2. **If `CurDisplay.IsSupport`:**
   - a. `method_14`: ENE lighting check (USB `vid_0cf2`; see the ENE report).
   - b. `IsSmartImageHDR` = the Windows HDR state. Read DC. If HDR: `ModuleSmartImageHDR.Items = DC.ValueList ∩ HDR`, and if DC ≠ 32, read `CurSubSmartImageHDR` and store it in `SubSmartImages[DC]`. Otherwise: `ModuleSmartImage.Items = DC.ValueList − HDR`, and if DC ≠ 16 (SmartImage_E2 "Off"), read `CurSubSmartImage` and store it.
   - c. Read `ModuleGameMode`, then apply the DualResolution post-processing (§7.11).
   - d. Read `ModuleAmbiglow`. `ENEEffectEnable = ENE present`. Without ENE: `Ambiglow.EffectEnable = (E2A019 available && value ≠ 0)`. If it is off, the cached mode **value is replaced by 7 (Static)** so the UI shows a sensible mode (this is why PROF stores 7 while the device returned 0).
   - e. Read `ModuleInput`:
     - `InputSourceList = 60.ValueList ∩ VCP_60_InputSource_E`; `PIPPBPSourceList = 60.ValueList ∩ VCP_60_PIPPBPSource_E`.
     - `InputSource = 60 & 0xFF`; `PIPPBPSource = 60 >> 8`. If that is 0, default to 34 (HDMI2) if listed, else 47 (DP1).
     - If A5 is available and F7 gives a table: `A5.ValueList` = that table, `Mode` = A5, `Size = EC & 0xFF`, `Location = EC >> 8`.
   - f. Read `ModuleAudio`. If E2A001 and E2A039 are available, for each band in `E2A001.ValueList`: write E2A001 = band; **100 ms**; read E2A039; add `{Name, Index, Value, MaxValue}` to `EQItems`. This loop leaves the monitor's EQ selector on the last band.
   - g. Read `ModuleSystem` and `ModuleSetup`, then compute `HasUSBSetting` and the OLED timers.
   - h. DualResolution: if the current main input is DP1, DP2, USB-C1 or USB-C2 (15/16/21/22), remove `UHD120Hz` from E2A059's list.
3. **`ReloadOSD`** (:559-574):
   - The first time, `DeviceData = CacheDeviceData`.
   - Later, `ParameterToDevice(DeviceData, bForce=false)` copies the fresh cache into `DeviceData`. The only possible device writes are ENE lighting when ENE is present; there are no VCP writes.
   - Returns `DeviceData`.

### 7.2 `PHL_SetOSD(item, value)` (PHL/…:1622-1673)

- Searches for `VCPOpCodeName == item` in this order, stopping at the first module that *has a property with that name*:
  1. the current SmartImage sub-module (HDR or SDR, depending on `IsSmartImageHDR`)
  2. GameMode, Ambiglow, Input, Audio, System, Setup
- If the attribute is available: `Value = value; SetValue()`. That is one write, with no read-back, no clamping and no delay.
- If the attribute exists but is unavailable, nothing is written and it is returned with `err_code` 9.
- If no property matches, `Tag = null`.
- Bug (harmless): it always stores `ModuleSmartImage.CurSubSmartImage` into `ModuleSmartImage.SubSmartImages[DC]`, even in HDR.
- Items that **cannot** be set through `PHL_SetOSD` (not module properties): 04, A4, AA, D6, F7, E2A038, E2A039, E2A042, E2A06B-style actions (6B *is* in ModuleSystem, so a raw write is possible), E2A088, and the OLED info counters 4D–55 (54/55 are properties, so writable in principle).

### 7.3 `PHL_SetOSD(item)` (1-arg) (PHL/…:1603-1620)

- Only `OP_F6_PIPPBPSwap` does something: it writes F6 = 1. Any other name logs "Wait for Set".
- Returns the `SupportOSDList` entry (its `Value` is null).

### 7.4 `PHL_SetSmartImage(v)` (PHL/…:1675-1717)

1. `v` must be in the current Items list (HDR or SDR); otherwise the error is `"SetSmartImage iValue is not valid"`.
2. If DC ≠ v: write DC = v and **sleep 1000 ms**.
3. Unless `v` is "Off" (32 or 16): clone the saved sub-module for `v` (or the current one), re-read it from the monitor, and make it current.

### 7.5 `PHL_ResetSmartImage(v)` (PHL/…:1719-1775)

1. Reject Off.
2. Require E2A042 to be available.
3. Write `E2A042 = map(v)` (§6.3) and **sleep 1000 ms**.
4. If `v` is the current DC, re-read the current sub-module; otherwise re-read the saved `SubSmartImages[v]` if there is one.

The function returns the error `"Not Support ResetSmartImage"` if E2A042 is missing.

### 7.6 `PHL_SetColorPreset(v)` (PHL/…:1777-1806)

1. Write 0x14 = v (SDR sub-module attribute only).
2. If v == 11 (UserRGB): **sleep 50 ms**, then read 0x16, 0x18 and 0x1A.
3. No constraints recheck.

### 7.7 SmartFrame (PHL/…:1808-1886)

`PHL_SwitchSmartFrame(v)`:
1. Write E2A008 = v and **sleep 100 ms**.
2. Poll E2A00A until its **MaxValue == 100**: up to 10 re-reads, **1000 ms apart**.
3. Then, each preceded by **100 ms**, read 0B, 09, 0C and 0D.

`PHL_SetSmartFrameSize(v)`:
1. Write E2A009 = v and **sleep 1000 ms**.
2. Read 0C, then **100 ms**, then read 0D. The position maxima depend on the size.
3. No constraints recheck.

### 7.8 `PHL_SetInputSource(input, pipSrc, mode, size, location)` (PHL/…:1888-1938)

- `v60 = input | (pipSrc << 8)` and `vEC = size | (location << 8)`.
- **If** any of pipSrc, mode, size or location changed **and** A5 is available:
  1. Write A5 = mode, then 100 ms.
  2. Write EC = vEC, then 100 ms.
  3. Write 60 = v60, then 100 ms.
  4. Write **A4 = 0xFFFF**.
- **Else, if** v60 differs from the cached value: write 60 = v60, then 100 ms, then A4 = 0xFFFF.
- There is no read-back. `InputSourceInfo` is updated from the arguments.

### 7.9 `PHL_SwrapPIPPBP()` (PHL/…:1940-1974)

Only when `InputSourceInfo.Mode ≠ 0`:
1. Write F6 = 1 and **sleep 5000 ms**.
2. Read 60, then re-derive `InputSource`/`PIPPBPSource` (default 34/47 as in §7.1).

### 7.10 `PHL_SetAudioEQ(index, gain)` (PHL/…:1976-1996)

1. The `EQItems[index]` entry must exist and `gain ≤ MaxValue`. Otherwise the error is `SetAudioEQ Error index=… iValue=… MaxValue=…`.
2. Write E2A001 = index, then **100 ms**, then write E2A039 = gain.
3. No constraints recheck.

### 7.11 DualResolution post-processing (PHL/…:355-378, 445-459)

1. After reading E2A059 (value v): `low = v & 0xFF`, `split = v >> 8`, and `Value = low`.
2. If `0 < split < list.Count` and E2A04C (Overclock) is available:
   - Overclock ON: remove list entries `[0, split)`.
   - Otherwise: remove entries `[split, end)`.
3. The UHD120 removal for DP/USB-C inputs is described in §7.1 h.
4. When writing, the UI sends the plain mode value through `PHL_SetOSD` (no split byte).

### 7.12 Reset, theme apply, Ambiglow without ENE

**`Profile_Reset(100000)`** runs `CDevice_PHLDisplay.Reset` (PHL/…:1998-2019):
1. Requires 0x04. Writes 0x04 = 1.
2. Clears the ENE state and resets `EffectInfo`.
3. **Sleeps 5000 ms**, then runs a full reload (§7.1).
4. `DeviceData = default`, then recheck and save.

**Theme switch** (`SystemOper.smethod_20`, SO:3085-3115): for the display, `ParameterToDevice(profile, bForce: true)` is **always** called (PHL/…:585-614).
- `method_10` (SmartImage) runs:
  - SDR: if the profile's DC is in Items and differs, write DC and sleep 1000 ms. Then **force-write** these values from the profile, in order: E2A020, 14, [16, 18, 1A if 14 == 11], 72, 12, F0, 87, 10, 8A, 90, E2A024. Each is written only if available and the profile value is non-null.
  - HDR: write DC (and sleep 1000 ms) only if the profile is also HDR and differs. Then force-write 10, 12, E2A03D, E2A03E and E2A03F.
- `method_12` (lighting) runs:
  - Without ENE: if the profile has Ambiglow enabled, write E2A019 = profile mode (Off becomes Static 7), then write 1A–1E where they differ. If it is disabled, write E2A019 = 0.
  - With ENE: push `EffectInfo` to ENE.
- **GameMode settings are never re-applied**: `method_11`, which would write 04/44/45/06/25/07/08–0D, has no callers (PHL/…:675-689). Neither are Input/Audio/System/Setup.

**Ambiglow without ENE** (the `Effect_*` functions, cross-reference):
- `Effect_Enable(100000, on)`: on writes the stored E2A019 mode; off writes E2A019 = 0 (PHL/…:974-1008).
- `Effect_Reset`: E2A038 = 1, then 200 ms, then re-read Ambiglow (PHL/…:1154-1180).
- `EffectEnableTemp`, used for idle lights-off: writes E2A019 = 0 or restores the stored mode (PHL/…:954-972).
- Note `method_15` uses `AmbiglowOff.GetHalfValue()` = 0/2 = 0. Same result.

### 7.13 Hotkeys (dead in 1.13.0)

**What the code does:**
- `HotKeyItems` is never populated. The factory `method_6` has no callers, so `PHL_GetHotKeyMenu` returns `[]`.
- `PHL_GetHotKeyData`, `SetHotKeyEnable`, `SetHotKeyItemEnable`, `SetHotKey` and `DeleteHotKey` are stubs returning `Succ()` (PHL/…:1354-1382).
- `CheckHotKeyBind` returns false.
- `RegisterHotKey` (PHL/…:1393-1402) would register the key through `InputEventManager.RegisterHotKey`, a Windows low-level hook (DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib.HotKeyMgr/InputEventManager.cs:580). It has no callers, and its dispatcher `method_20` (:1409-1411) is empty.

**Surviving intended actions** (unreachable handlers; CONFIRMED code, INFERRED intent):

| `DisplayHotKeyFunc` (EO/DisplayHotKeyFunc.cs) | Handler | Action |
|---|---|---|
| 0 Brightness | `method_23` (:1442-1467) | ±10 on 0x10 of the current (SDR/HDR) sub-module, clamped to 0..100, write then read back; notify `NotifyHotKeyExecute` |
| 1 Contrast | `method_24` (:1469-1496) | ±10 on 0x12, same pattern |
| 2 Sharpness | `method_25` (:1498-1523) | ±10 on 0x87 (SDR) |
| 3 SmartImage | `method_26` (:1525-1566) | cycle to the next entry of the current Items list, then `SetSmartImage` |
| 4 ColorSpace | `method_27` (:1568-1597) | SDR only: cycle to the next E2A020 value, write then read |
| 5–9 GamePQ variants | `method_28` (:1599-1601) | empty |

`HotKeyCommand`: 0 Execute, 1 Circle, 2 Increase, 3 Decrease (EO/HotKeyCommand.cs).

`DisplayHotKeyItem` JSON: `{Func:int, FuncName:string, Enable:bool, HotKey:HotKeyInfo, HotKeyExt:HotKeyInfo|null}`.

`HotKeyInfo`: `{Type:HotKeyCommand, Code:int (virtual-key), Alt, Ctrl, Shift, Win, RegState:bool}` (EO/DisplayHotKeyItem.cs, EO/HotKeyInfo.cs). `DispalyHotkeyData {Enable, Items[]}` exists but is unused.

### 7.14 GamePQ and the mouse-key bind (dead in 1.13.0)

- `SetGamePQ(iValue, IsShow, R, G, B, C, M, Y)` returns `ModuleGameMode` without doing any I/O (PHL/…:2027-2030).
- `PHL_EnableGamePQMouseKey` and `PHL_SetGamePQMouseKeyBind` are stubs.
- `method_22` (PHL/…:1428-1440) would map a mouse `LongPress` to GamePQ `NegativeEffect` and `LongPressRelease` to `OFF` through the empty `method_28`. `MouseButton`: 0 Left, 1 Right, 2 Middle, 3 XButton1, 4 XButton2. `MouseEventType`: 0 Click, 1 DoubleClick, 2 LongPress, 3 LongPressRelease, 4 Down, 5 Up.
- **Colour-filter encoding** (INFERRED intent, from EO/GameQPInfo_Extension.cs:8-15):

  ```
  E2A088 = (mask << 8) | 3
  mask   = (R==IsShow)<<5 | (G==IsShow)<<4 | (B==IsShow)<<3 | (C==IsShow)<<2 | (M==IsShow)<<1 | (Y==IsShow)
  ```

  `GamePQInfo` defaults: `IsShow=true`, `R=true`, others false (EO/GamePQInfo.cs).
- The 34M2C8600 does not advertise E2A088.

### 7.15 `PHL_ProfileAction(profile, action)` (PHL/…:2032-2049)

- Requires E2A06B. Writes `((action==1 ? 0xA1 : action==2 ? 0xA2 : 0xA0) << 8) | profile`.
- Returns `Succ()`, or the error `"EXT_OP_E2A0_6B_Profile Unavailable"`.
- Not called by the UI, and not supported by the 34M2C8600.

---

## 8. Constraints: `PHL_GetConstraints` / `DisplayFuncConstraints` (EO/DisplayFuncConstraints.cs:64-335) (CONFIRMED)

**State semantics:**
- `State` 1 means **enabled** and 2 means **disabled**. The renderer uses `optionControl[id] = (State === 1)` (AP/renderer/assets/styles-DAnQi2A8.js:9584; the map is built in AP/renderer/assets/main-CDosWiM3.js:1834-1840, keyed by both `FuncId` and `FuncName`, plus -1 for `AudioEQ` and -2 for `ModuleGameMode`).
- `ModuleGameMode` and `AudioEQ` are always 1.

**Evaluation:**
- The rules are re-evaluated after every mutating call.
- `GetConstraints` also pushes a `NotifyUIDisplayFuncConstraintsChange` notification. `RecheckFuncConstraints` pushes it only when the serialized state changed.

**Inputs** (computed at :125-179):

| Name | Meaning |
|---|---|
| `pip` | A5 available && F7 table non-empty && A5 ≠ 0 |
| `hdr` | `IsSmartImageHDR` |
| `saver` | E2A035 available && ≠ 0 |
| `sniper` | !(pip\|\|hdr) && E2A006 available && ≠ 0 |
| `async` | !pip && E2A040 available && ≠ 0 |
| `hz` | `int(MonitorFrequency without "Hz")` |
| `mbr` | !(pip \|\| hz<75 \|\| async) && E2A002 available && > 0 |
| `mbrSync` | !pip && async && E2A003 available && ≠ 0 |
| `dc` | DC value |

**Rules** ("disabled when …"):

| FuncId / FuncName | Disabled when |
|---|---|
| 14852160 `EXT_OP_E2A0_40_AdaptiveSync` | pip |
| 14852098 `…_02_MBR` | pip \|\| hz<75 \|\| async |
| 14852099 `…_03_MBRSync` | pip \|\| !async |
| 14852100 `…_04_SmartCrosshair` | pip |
| 14852164 `…_44_StarkShadowBoost`, 14852165 `…_45_ShadowBoost`, 14852102 `…_06_SharpShooter_Size` | pip \|\| hdr |
| 14852103 `…_07_LowInputLag` | pip \|\| sniper |
| 235 `OP_EB_SmartResponse`, 14852172 `…_4C_Overclock` | pip |
| 16 `OP_10_Luminance` | (only if DC available) SDR: mbr \|\| mbrSync; HDR: never |
| 18 `OP_12_Contrast` | dc == 14 (EasyRead) |
| 240 `OP_F0_SmartContrast` | pip \|\| saver \|\| sniper \|\| mbr \|\| mbrSync |
| 20 `OP_14_SelectColorPreset`, 14852128 `…_20_ColorSpace` | dc ∈ {14 EasyRead, 11 LowBlue} |
| 14852132 `…_24_DLBL` | dc ≠ 11 (enabled **only** in LowBlue mode) |
| 14852104 `…_08_SmartFrame` | pip \|\| hdr \|\| sniper \|\| dc ∈ {0 Standard, 14 EasyRead} |
| 14852122..26 Ambiglow 1A..1E | if E2A019 is unavailable: all disabled. Otherwise by the current E2A019 mode (C = colours, P = position, B = brightness, S = speed, D = direction; 1 = enabled): FollowVideo C2 P2 B1 S2 D2; FollowAudio C1 P1 B2 S2 D2; ColorShift/Wave/Breathing all 1; StarryNight C1 P2 B1 S1 D1; Static C1 P1 B1 S2 D1; ColorFlow(Reverse) C2 P2 B1 S1 D2; Off or unknown: unchanged (1) |
| 224 `OP_E0_AudioSource` | **!pip**. As coded, the audio source is enabled only while PIP/PBP is active |
| 84 `OP_54_PerformancePreservation` | pip |
| 134 `OP_86_DisplayScaling` | never |
| 218 `OP_DA_ScanMode` | when 86 is enabled && available && 86 == 1 (1:1) |

Expected result for the user's current state (INFERRED from the code plus PROF values: HDR, AdaptiveSync on, ScreenSaver 2, DC 33, 175 Hz, Ambiglow value 7):
- **Disabled (2):** MBR, StarkShadowBoost, ShadowBoost, SharpShooter, SmartContrast, DLBL, SmartFrame, AmbiglowLightSpeed, AudioSource.
- **Enabled (1):** everything else.

---

## 9. JSON shapes

### 9.1 Envelope

`{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"…","Tag":<payload>,"FunctionName":"PHL_…","CurrItem":null}`. It is serialized with nulls included (DC/EvniaServe/Class0.cs:46-50). See the backend report for transport details.

Additional rules:
- C# `ValueTuple` payloads serialize as `{"Item1":…,"Item2":…}`.
- `JsonIgnoreEx(IgnoreProfile)` fields are **included** in UI results and **omitted** from the saved `.pcenter` `ProfileContent`, which is also written with nulls ignored (EB/GClass0.cs:168-171).

### 9.2 `PHL_ReloadData` / `Profile_GetDeviceData(100000)` / `PHL_SwitchDisplay` / `PHL_Rescan` / `Profile_Reset` → `T_PHLDisplay_Profile`

The skeleton below uses the user's real values (PROF). It shows the UI form, i.e. including the IgnoreProfile fields `VCPOpCodeName`, `MinValue`, `MaxValue`, `StepValue`, `ValueList` and `HasUSBSetting`. For brevity, only one attribute is written out in full; every `{…}` attribute has the same 8 fields.

```json
{
  "IsSmartImageHDR": true,
  "HasUSBSetting": true,
  "OP_DC_DisplayApplication": {"VCPOpCode":220,"VCPOpCodeName":"OP_DC_DisplayApplication","Value":33,"MinValue":0,"MaxValue":53,"StepValue":1,
     "ValueList":[{"Name":"SmartImage_Standard","Text":"Standard","Value":0}, "... SDR items ...", {"Name":"HDROff","Text":"HDR Off","Value":32}, "... HDR items ..."],"err_code":0},
  "ModuleSmartImage": {"Items":[], "CurSubSmartImage":{"OP_10_Luminance":{…},"OP_12_Contrast":{…},"OP_F0_SmartContrast":{…},"OP_72_Gamma":{…},"OP_87_Sharpness":{…},
      "EXT_OP_E2A0_20_ColorSpace":{…},"OP_14_SelectColorPreset":{…},"OP_16_VideoGainDriveRed":{…},"OP_18_VideoGainDriveGreen":{…},"OP_1A_VideoGainDriveBlue":{…},
      "OP_8A_Saturation":{…,"err_code":9},"OP_90_Hue":{…,"err_code":9},"EXT_OP_E2A0_24_DLBL":{…}}, "SubSmartImages":{}},
  "ModuleSmartImageHDR": {"Items":[{"Name":"HDROff","Text":"HDR Off","Value":32},{"Name":"HDRGame","Text":"HDR Game","Value":33},{"Name":"HDRMovie","Text":"HDR Movie","Value":34},
      {"Name":"HDRPhoto","Text":"HDR Photo","Value":35},{"Name":"HDRPersonal","Text":"HDR Personal","Value":36},{"Name":"HDRTrueBlack","Text":"HDR True Black","Value":48},{"Name":"HDRPeak","Text":"HDR Peak","Value":51}],
      "CurSubSmartImage":{"OP_10_Luminance":{"VCPOpCode":16,"Value":100,…},"OP_12_Contrast":{"VCPOpCode":18,"Value":50,…},
         "EXT_OP_E2A0_3D_LightEnhancement":{"VCPOpCode":14852157,"err_code":9},"EXT_OP_E2A0_3E_ColorEnhancement":{…9},"EXT_OP_E2A0_3F_DarkEnhancement":{…9}},
      "SubSmartImages":{"33":{ "…same shape as CurSubSmartImage…" }}},
  "ModuleGameMode": {"EXT_OP_E2A0_40_AdaptiveSync":{"Value":1},"EXT_OP_E2A0_02_MBR":{"err_code":9},"EXT_OP_E2A0_03_MBRSync":{9},"EXT_OP_E2A0_04_SmartCrosshair":{0},
      "EXT_OP_E2A0_44_StarkShadowBoost":{0},"EXT_OP_E2A0_45_ShadowBoost":{9},"EXT_OP_E2A0_06_SharpShooter_Size":{0},"EXT_OP_E2A0_25_SharpShooter_Location":{9},
      "EXT_OP_E2A0_07_LowInputLag":{0},"OP_EB_SmartResponse":{9},"EXT_OP_E2A0_4C_Overclock":{9},"EXT_OP_E2A0_08_SmartFrame":{0},"EXT_OP_E2A0_09_SmartFrameSize":{1},
      "EXT_OP_E2A0_0A_SmartFrameBrightness":{100},"EXT_OP_E2A0_0B_SmartFrameContrast":{50},"EXT_OP_E2A0_0C_SmartFrameHPosition":{0},"EXT_OP_E2A0_0D_SmartFrameVPosition":{0},
      "EXT_OP_E2A0_59_DualResolution":{9},"EXT_OP_E2A0_68_AutoRefineAIStatus":{9}},
  "ModuleAmbiglow": {"EXT_OP_E2A0_19_AmbiglowLightMode":{"Value":7},"EXT_OP_E2A0_1A_AmbiglowColors":{6},"EXT_OP_E2A0_1B_AmbiglowLightPosition":{0},
      "EXT_OP_E2A0_1C_AmbiglowLightBrightness":{2},"EXT_OP_E2A0_1D_AmbiglowLightSpeed":{0},"EXT_OP_E2A0_1E_AmbiglowLightDirection":{9},"EffectEnable":false},
  "ModuleInput": {"OP_ED_InputAuto":{1},"OP_60_InputSource":{15},"OP_A5_WindowSelect":{0, "ValueList":[{"Name":"PIPPBP__OFF","Value":0},{"Name":"PIPPBP__PIP","Value":256},{"Name":"PIPPBP__PBP_1","Value":512}]},
      "OP_EC_PIPPBPSizeLocation":{0},"OP_F6_PIPPBPSwap":{0},
      "InputSourceList":[{"Name":"Normal_DisplayPort1","Text":"DisplayPort 1","Value":15},{"Name":"Normal_DigitalHDMI1","Value":17},{"Name":"Normal_DigitalHDMI2","Value":18},{"Name":"Normal_USBC1","Value":21}],
      "PIPPBPSourceList":[{"Name":"PIPPBP_DigitalHDMI1","Value":33},{"Name":"PIPPBP_DigitalHDMI2","Value":34},{"Name":"PIPPBP_DisplayPort1","Value":47},{"Name":"PIPPBP_USBC1","Value":53}],
      "InputSourceInfo":{"Mode":0,"Size":0,"Location":0,"PIPPBPSource":34,"InputSource":15},
      "PIPLocationList":[{"Name":"UpperRight","Text":"UpperRight","Value":1},{"Name":"LowerRight","Value":2},{"Name":"UpperLeft","Value":3},{"Name":"LowerLeft","Value":4}]},
  "ModuleAudio": {"OP_62_AudioSpeakerVolume":{0},"OP_8D_AudioMute":{2},"EXT_OP_E2A0_00_AudioMode":{70},"OP_E0_AudioSource":{3},
      "EQItems":[{"Name":"EQ_100","Index":0,"Value":8,"MaxValue":16},{"Name":"EQ_300","Index":1,…},{"Name":"EQ_1000","Index":2,…},{"Name":"EQ_3000","Index":3,…},{"Name":"EQ_10000","Index":4,"Value":8,"MaxValue":16}]},
  "ModuleSystem": {"EXT_OP_E2A0_3A_HDMI1RefreshRate":{9},"…3B":{9},"…3C":{9},"EXT_OP_E2A0_0E_OSDSettingHorizontal":{50},"…0F":{50},"…10_OSDSettingTransparency":{0},
      "…11_OSDSettingTimeOut":{2},"OP_86_DisplayScaling":{2},"…12_USB_C_Setting":{1},"…13_USB_StandbyMode":{1},"…14_USB_Upstream":{9},"…15_KVM":{0},"…16_SmartPower":{0},
      "…18_LocalDimming":{9},"OP_54_PerformancePreservation":{2},"OP_DA_ScanMode":{2},"…6B_Profile":{9}},
  "ModuleSetup": {"OP_F2_PowerLED":{1},"OP_CC_OSDLanguage":{2},"OP_E9_ResolutionNotifier":{0},"…17_CEC":{0},"…35_ScreenSaver":{2},"…34_PixelOrbiting":{3},
      "…36_PixelRefresh":{0},"…37_PanelRefresh":{9},"…43_AutoWarning":{1},"…47_UniBright":{9},"…48":{9},"…49":{9},"…4A":{9},"…4B":{9},"…61":{9},
      "WorkingTime":-1,"TimeAfterPixelRefresh":-1,"…54_PixelRefreshCounts":{9},"…55_PanelRefreshCounts":{9},"…41_FanControl":{1}},
  "ENEEffectEnable": false,
  "EffectInfo": {"EffectList":[ "…see ENE report…" ],"EffectDetail":{…},"EffectEnable":true,"CurrEffect":{"Name":"FollowVideo","Text":"…","Value":1}},
  "DispalyData": {"MonitorEDIDInfo_T":{"sManufacturer":"PHL","sManufacturerDate":"Week01-2025","PlugAndPlayID":"PHLC29F","sMonitorName":"PHL 34M2C8600",
      "sSerialNumber":"AU00000000001","sVersion":"1.4","ScreenSize":"~34,2\"","TimingRecommandation":"3440x1440","DisplayGamma":"2,2","DisplayTypeAndSignal":"DIGITAL",
      "RedChromaticity":"Rx0,689-Ry0,303","GreenChromaticity":"Gx0,241-Gy0,715","BlueChromaticity":"Bx0,145-By0,059","WhitePoint":"Wx0,313-Wy0,329"},
      "MonitorResolution":"3440x1440","MonitorFrequency":"175Hz","MonitorOrientation":"0°"},
  "EquipmentType": 1, "DeviceType": 100000, "ModelName": "PHL 34M2C8600", "ExtModel": ""
}
```

Notes:
- `{9}` means `err_code 9`; `{n}` means `Value n`.
- The number formatting in the EDID strings (`"2,2"`) follows the Windows locale; this machine uses a decimal comma.
- The renderer turns each attribute into `{…, Support: err_code===0}`. Binary attributes become `{On, Off, Value:bool, Support}` (`Qu`/`Xu`/`rd`, AP/renderer/assets/styles-DAnQi2A8.js:9046-9075, 9297-9312).

### 9.3 Other payloads

| Function | `Tag` |
|---|---|
| `PHL_GetConstraints` | `{"FuncItems":[{"FuncId":16,"FuncName":"OP_10_Luminance","State":1}, … 26 items in the §8 order: 16, 18, 240, 14852128, 20, 14852132, 14852160, 14852098, 14852099, 14852100, 14852164, 14852165, 14852102, 14852103, 235, 14852172, 14852104, 14852122–14852126, 224, 134, 84, 218], "ModuleGameMode":1, "AudioEQ":1}` |
| `PHL_GetHotKeyMenu` | `[]` |
| `PHL_GetHotKeyData`, `PHL_SetHotKey*`, `PHL_DeleteHotKey`, `PHL_EnableGamePQMouseKey`, `PHL_SetGamePQMouseKeyBind`, `PHL_ProfileAction` (success) | `null` |
| `GetHotKeyState` | `true`/`false` |
| `PHL_SetOSD` | `AttributeInfo`, or `null` |
| `PHL_SetSmartImage`, `PHL_ResetSmartImage` | `{"Item1":<DC AttributeInfo>,"Item2":<ModuleSmartImage or ModuleSmartImageHDR>}` |
| `PHL_SetColorPreset` | `ModuleSmartImage` |
| `PHL_SwitchSmartFrame`, `PHL_SetSmartFrameSize`, `SetGamePQ` | `ModuleGameMode` |
| `PHL_SetInputSource`, `PHL_SwrapPIPPBP` | `ModuleInput` |
| `PHL_SetAudioEQ` | `ModuleAudio` |

Notifications emitted by this area (sent as `Notification` events; see the backend report):

| Notification | Tag |
|---|---|
| `NotifyUIDisplayFuncConstraintsChange` | `DisplayFuncConstraints` |
| `NotifyUIDisplayEffectChange` | `{"Item1":ENEEffectEnable,"Item2":EffectInfo,"Item3":ModuleAmbiglow}` (PHL/…:787-792, 851-856) |
| `NotifyEffectChange` | `{DeviceType:100000, Data:EffectInfo}` |
| `NotifyEffectSyncDevicesChange` | |
| `NotifyHotKeyExecute` | `{DeviceType:100000, Data:EnumItem(DisplayHotKeyFunc)}`, dead |

---

## 10. Linux port plan (monitor features)

1. **Transport A: I2C (recommended default).**
   - Find the connector's DDC bus: `/sys/class/drm/card*-<conn>/ddc`, which links to `i2c-N`. Open `/dev/i2c-N` (the `i2c-dev` module) at address 0x37.
   - Frames are exactly as in §5.2: write `[0x51, 0x80|n, payload…, chk]`, where chk = 0x6E^0x51^…; read `[0x6E, 0x80|n, data…, chk]`, verified by 0x50^… == 0.
   - Timings: sleep ≥ 50 ms between a get request and its read (the vendor uses 100 ms after writes and 50 ms after reads). Use ≥ 100 ms after sets; up to 3 retries.
   - Parse get replies relative to the length (last 4 data bytes = max, current).
   - This covers the standard **and** the `E2 A0 xx` extended codes. ddcutil cannot address 3-byte VCP codes, but its raw API or a ~200-line custom implementation can.
   - AMDGPU exposes DP-AUX I2C for DDC/CI.
2. **Transport B: VIA hub USB-DDC (optional, matches Windows behaviour).**
   - Use libusb on `2109:8884`: `ctrl(0x40, 0xB2, 0, 0, frame)`, then `ctrl(0xC0, 0xA3, 0, 0x006F, 32)`. For capabilities, either A3 fragments (≤ 26 data bytes each) or `0xA7` + `0xA9` 32+32.
   - Needs a udev rule (for example `SUBSYSTEM=="usb", ATTRS{idVendor}=="2109", ATTRS{idProduct}=="8884", MODE="0660", GROUP="plugdev"`).
   - Vendor-type device-recipient control transfers normally don't require claiming an interface (INFERRED; verify with `lsusb -v -d 2109:8884`).
   - Implement B only if A fails, for example on a KVM/USB-C setup where the GPU DDC is not reachable.
   - Do **not** implement the ISP requests (0xB7/0xB8/0xB9), RTK HID or Genesys paths unless OTA is wanted.
3. **Identification.**
   - Read EDID from sysfs and reuse the §4.5 parser. The key is the serial from the 0xFF descriptor; the whitelist uses the model from 0xFC with `PHL` stripped.
   - Ship the bundled MonitorInfo.json (Version 34) read-only, or relax the whitelist to "PNP ID starts with PHL and DDC/CI answers".
   - Hub-only identification (model/BOM/version via `FE E1/E9` commands) is not needed for features.
4. **Capabilities.**
   - Standard DDC/CI capabilities read (F3/E3).
   - Implement `AnalyseVcpString` with multi-byte keys.
   - Cache in `$XDG_CACHE_HOME` keyed by `<fwversion>_<input>`. VCP C9 gives the FW level; the DDCHelper path formats it as `V%d.%02d` when max == 201. The HMAC wrapper can be kept for format compatibility (key `WhaleTV_Serizlize_2026`) or dropped.
5. **Model layer.**
   - Port the enums as JSON tables (Tables §6.1–6.4), respecting the Unbind exclusions, and the module/attribute structure in §2.4.
   - Keep the read order in §5.7, but consider reading only the visible page to avoid the ~12 s load. Each get costs about 100–190 ms.
   - Keep the exact sequences and delays of §7 (SmartImage 1000 ms, SmartFrame polling, input/PIP A5→EC→60→A4, swap 5000 ms, reset 5000 ms, EQ select/100 ms/gain).
   - Report write failures instead of ignoring them, as the original does (§2.3).
6. **HDR flag.** Replace the Windows query with one of:
   - (a) derive from VCP DC: `IsSmartImageHDR = DC ∈ SmartImageHDR_E (32..51)`. This is consistent with the user's data (DC 33 ⇔ HDR on), INFERRED.
   - (b) the DRM connector property `HDR_OUTPUT_METADATA` / `Colorspace` (compositor-dependent).
7. **Resolution and refresh.** Take these from DRM/KMS (current CRTC mode) or the compositor (`wlr-randr`/`kscreen-doctor`/`xrandr`). They are only needed for display and for the `MBR` rule (<75 Hz).
8. **Constraints.** Port §8 verbatim, including the odd rules (`E0` enabled only in PIP, `DLBL` only in LowBlue).
9. **Hotkeys and GamePQ.** Omit them, since they are dead in this version. If desired, implement brightness/contrast ±10 and the SmartImage cycle as desktop-environment global shortcuts calling the local API (§7.13); no low-level input hooks are needed.
10. **Ambiglow.**
    - Without ENE, drive E2A019–1E and E2A038 over DDC (§7.12). The 34M2C8600 advertises E2A019–1D.
    - The ENE USB controller (`0CF2`, "CUSBENE6K7732") takes over when present; see the ENE report. Decide on one owner to avoid conflicts (open question).
11. **API compatibility.** If the Electron renderer is reused, expose the §3 function names with the §9 JSON shapes over a loopback-only socket. Bind to 127.0.0.1, not `*`.

---

## 11. Online touchpoints (this area)

| What | Where | Trigger | Strip recommendation |
|---|---|---|---|
| MonitorInfo.json refresh (model whitelist + `SupOTA`/`SupLightEffect`/`SupLightSync`/`HDR` + `LimitVer_PCenter`) downloaded from the vendor OTA service: query `{deviceType:"PhilipsMonitorsOTA", componentId:"PrecisionCenter_Monitors_OTA_JSON", version}` → `{url, hashMethod, hashValue, version}` → download → rename to `%APPDATA%\evnia\MonitorInfo.json` | AP/main/index.js:13508-13545 (`verifyMonitorInfoJson`), consumed by PB/DictMgr.cs:23 and AP/main/index.js:17584-17600 | every backend start | Remove it. Ship a static MonitorInfo.json (bundled Version 34, work/app/MonitorInfo.json) or relax the whitelist. |
| Monitor firmware OTA (`DisplayFW_*` → `PHLDisplayFW.UpdateFirmversion` → `MonitorService.UpdateMonitorOTADeviceFirmware`). The firmware zips come from the vendor server; vendor EXEs inside the zips are run via `Executor.Execute` (ML/Class20.cs:41-414, ML/Zeasn.Monitor.Lib.ScalerFW.Operator.OperatorHandler/Ambiglow.cs:32-48). There is also the Genesys driver installer `"/di /d"` (ML/Class3.cs:105). | PHL/PHLDisplayFW.cs:114-457, SO `DisplayFW_*` | user action; OTA availability depends on the downloaded JSON | Remove all of it: online, and risky (flashing, running downloaded binaries). |
| LAN-exposed local API: EvniaServe listens on `http://*:10010`, including `GET /Display/PHL_SwitchDisplay` and `GET /Display/PHL_SetGamePQ` | DC/EvniaServe/Evnia/DisplayController.cs:13-29 | always | Loopback/IPC only. |
| **None** inside the VCP/DDC code | grep for Http/WebClient/URLs in `Zeasn.Monitor.Lib`, `Zeasn.DDC.Lib`, `PHLDisplay`, `PCenter.Base` (only MacroMgr has an unrelated URL helper) | – | – |

---

## 12. Open questions

1. **Extended-code reply format.** Is it 8 bytes (`02 RC ?? TP MH ML SH SL`) or 10 bytes (`02 RC E2 A0 xx TP MH ML SH SL`)? The DDCHelper path expects at most 8 data bytes (DDCHelperLib.dll.c:6917-6955 + FUN_1000b980), which suggests 8. No raw reply was logged (`DEMO_MODE` was off). Capture one with `DEMO_MODE` in `SetSetting`, or on Linux.
2. **VIA vendor requests.** The meaning of 0xB2/0xA3/0xA7/0xA9 is inferred from method names (`I2CWriteCmd_*`/`I2CReadCmd_*`). Whether Linux usbfs allows these vendor requests without claiming an interface on `2109:8884`, and which interface/driver that device exposes, still needs `lsusb -v`.
3. **Interface1 mapping.** `imethod_2`/`imethod_3` were mapped to "write+100 ms"/"read+50 ms" by declaration order and timing, not by name (the explicit implementations have mangled names).
4. **ENE vs DDC Ambiglow.**
   - On 09-25 the ENE controller was detected ("USBENE6K7730HelperPlug = True", FW `03 32 07 0F 0B`); on 09-26 it was not ("CheckENEUnPlugin"). Why is unknown (cable/USB state?).
   - While ENE drives the LEDs, does E2A019 read 0 (Off)? It read 0 in both logs.
5. **VCP 0x54.** It reads 2 (max 4), but the capabilities list only 00/01 and the enum maps 0 = ON, 1 = OFF. The OSD semantics of the 0x54 value on this panel are unknown.
6. **VCP 0x60.** Max returned 0x3616. The meaning is unknown and it is not used.
7. **`GetResetSmartImageValue` mapping** for 34 (HDR Movie → 0x30), 35 (HDR Photo → 0x3D) and missing 48 (HDR TrueBlack → writes 0). These are probably vendor bugs; the correct values need testing on hardware.
8. **E2A036/E2A037** (pixel/panel refresh): is writing 1 a one-shot trigger? Does the monitor reset it to 0, and is there any required post-command delay or blanking period?
9. **E2A06B profile actions** 0xA0/0xA1/0xA2: meaning (recall/save/delete?) unknown, and the code is unused.
10. **Build mismatch.** LOG25 was produced by a slightly older backend build (different obfuscated names; no capability-cache lines). The LOG26 behaviour matches the decompiled 1.13.0 code.

---

## 13. Cross-references (outside this scope)

- **DDCHelperLib.dll internals** (ADL/NVAPI/WinRing0 I2C, `EnumDisplayIDIni`, `DDCSupportJudge_C`, capability enumeration, `SwitchGetCommandChecksum` quirk: accepts a bad checksum when length == expected): native/DDC report. Files: work/native/DDCHelperLib.dll.c, DC/Zeasn.DDC.Lib/Class1.cs.
- **ENE Ambiglow controller** (`CUSBENE6K7732`, `EneEc.dll`, USB `vid_0cf2`, `DisplayEffectInfo`/`ENEDataConvert`, follow-video/audio streaming, `res/data/ENE/PCenter_AmbiglowInfo.json`): ENE report. Entry points: PHL/CDevice_PHLDisplay.cs:754-1348.
- **OTA / firmware** (`PHLDisplayFW`, scaler ISP in ML/Interface3–7, 14–23, ML/Class20/21 accessory OTA, PD controller over RTK hub (ML/Class2.cs:156-206), `SleepPreventService`, register tables ML/Class38.cs): OTA report.
- **RTK hub HID** (`lib\RTK\RhHidAPI.dll`, ML/Class23.cs) and **Genesys hub** (`lib\Genesys\GL_SDK.dll`, ML/Zeasn.Monitor.Lib.ScalerFW.Devices.Monitor.HubAPI/GenesysAPI.cs): native reports.
- **Global input hooks** (`InputEventManager`, `SetWindowsHookEx`, used by macros and the dead display hotkeys): input/macro report. File: DC/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib.HotKeyMgr/InputEventManager.cs.
- **Windows display helpers** (`CWinSysDisplay` resolution/refresh/orientation, `CWinSysDisplayHDR` HDR state): DC/Zeasn.Win.Lib/Zeasn.Win.Lib/CWinSysDisplay*.cs.
- **Host, dispatcher, notifications, profile/theme persistence** (`.pcenter`, `ThemeSaveCurProfiles`, signed `data.json` util): docs/re/05-backend-host.md.
- **Electron MonitorInfo.json seeding/refresh and `getMonitorJsonConfig`**: docs/re/01-electron-main.md §8.
- **Renderer mapping** of attributes to controls (Qu/Xu/rd transforms, per-page `vcpName` lists: SmartImage-*.js, GameMode-*.js, Ambiglow-*.js, Audio-*.js, System-DT9nKs1q.js, Setup-D-5j4V-I.js): renderer report.
