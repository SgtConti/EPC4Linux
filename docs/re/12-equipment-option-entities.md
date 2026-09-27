# 12 — Device options, menus and entity JSON (Zeasn.Equipment.Option.Lib + Zeasn.PCenter.Entity.Lib)

**Scope.** `work/dotnet-clean/Zeasn.Equipment.Option.Lib` (109 files, about 43.8K lines) and `work/dotnet-clean/Zeasn.PCenter.Entity.Lib` (167 files, about 9.8K lines). Both target .NET Core 3.1. Option.Lib is WindowsDesktop/WinForms (`Zeasn.Equipment.Option.Lib.csproj`).

**Summary.**

- **Entity.Lib is a plain data-contract library.** It holds DTOs, enums and a few helpers. It has no I/O except `WorkspacePath` path constants and three getters that call Win32 (`DoubleClickSpeedData.DoubleClickSpeed`, `ScrollSpeedData.ScrollSpeed`, `ThemeInfo.IsBind`). Every object that reaches the renderer is one of these classes (or an Option.Lib class). Newtonsoft.Json serializes it with **default contract rules**. Nothing is renamed: there is no `[JsonProperty]`, no `StringEnumConverter` and no camel-casing.
- **Option.Lib holds the device drivers ("Oper" classes)** and their per-device option and menu data:
  - The Philips monitor: `CDevice_PHLDisplay`, `PHLDisplay_Oper` and `PHLDisplayFW`.
  - The ENE/DDC Ambiglow effect catalogue.
  - Screen-sampling "AmbiScape" and PowerToys-FancyZones glue.
  - The TAG headset/DTS driver.
  - Drivers for six families of Philips peripherals, from RongYuan, BeiYing, JiangMeng, YongJiaXing and HaiHui. The user does not own any of them.
- **No functional embedded resources.** Each DLL has exactly one ManifestResource, and it is the .NET Reactor encrypted string table (`OduIkS0yWo2Gc1HOHf.9IRk8lXZ0eIGo5sO1D` / `v7tsLIQnODZk1anYnu.eiAb346gmOhMPeXFw5`). NETReactorSlayer has already decrypted it into literals. All catalogues (effects, menus, default key layouts, setup ranges, constraint rules) are **code-driven** C# tables. The only **data-driven** inputs are the external JSON files `res/data/PCenter_DeviceInfo.json`, `res/data/ENE/PCenter_AmbiglowInfo.json`, `res/data/BeiYing/KB_K916.json`, `res/data/RongYuan/RongYuan_Keyboard_V1.json` and `%APPDATA%/evnia/MonitorInfo.json` (the last one is downloaded online).
- **The monitor model is `T_PHLDisplay_Profile`.** It is a tree of 9 modules and about 90 `AttributeInfo` objects. Each object is bound to a standard MCCS VCP code or to a Philips/TPV extended code `0xE2A0xx` (sent as DDC app-command 0xE2, a-code 0xA0, sub-code xx). This report maps every attribute. It also gives the real availability and values read from the user's 34M2C8600 profile on disk.
- **Serialization differs by path** (see §2):
  - `Profile_GetDeviceData` uses `IgnoreUI` mode and keeps nulls.
  - Every other hub response and notification uses plain `JsonConvert` defaults. Nulls are kept and `[JsonIgnoreEx]` has no effect.
  - Profiles on disk use `IgnoreProfile` mode with nulls dropped.

  The Python emulation in the appendix reproduces a real on-disk profile fragment **byte-for-byte**.
- **Deobfuscation broke enum member names.** The "clean" decompilation renamed 21 legitimate enum members to `const_N`, for example `SmartImageHDR_E.HDRPersonal` became `const_4`. These names appear in JSON (`EnumItem.Name`, `FuncName`, `FunctionName`). The corrected names are listed in §2.6 and are CONFIRMED against `work/dotnet/`.
- **Several vendor quirks must be reproduced or consciously fixed:**
  - `PHL_GetHotKeyMenu` always returns `[]` (the list is never populated).
  - `SetGamePQ` and all hotkey setters are no-ops.
  - `NotifyUIDisplayEffectChange` sends a C# `ValueTuple` (`Item1..3`), but the renderer reads `ENEEnable/EffectInfo/ModuleAmbiglow`, so it breaks.
  - `SetSmartImage`/`ResetSmartImage` return `{Item1,Item2}` tuples.
  - Unread attributes report `err_code:0` ("available") with `Value:null`.

---

## 0. Conventions and evidence

- Paths are relative to the repository root. Abbreviations:
  - `OPT/` = `work/dotnet-clean/Zeasn.Equipment.Option.Lib/`
  - `ENT/` = `work/dotnet-clean/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/`
  - `COM/` = `work/dotnet-clean/Zeasn.Com.Lib/Zeasn.Com.Lib/`
  - `CORE/` = `work/dotnet-clean/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/`
  - `PBASE/` = `work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/`
- Line numbers refer to the original `work/dotnet-clean` files.
- **CONFIRMED** means read in code, or seen in the runtime artefacts listed below. **INFERRED** means reasoned from library behaviour or naming.
- Runtime ground truth used:
  - `%APPDATA%/EvniaServe/Theme/User/Default.pcenter`: the real 34M2C8600 profile, 12.4 KB.
  - `%APPDATA%/EvniaServe/Theme/DataTheme.cfg` and `Config/SoftConfig.data` (both match the entity shapes exactly).
  - `%APPDATA%/EvniaServe/Config/data.json`: the VCP capability string cache.
  - `%APPDATA%/EvniaServe/logs/2026-09-2{5,6}.txt`: shows ENE detection on 09-25 and absence on 09-26.
  - `%APPDATA%/evnia/MonitorInfo.json`.
- The renderer consumer code was cross-checked in `work/app-pretty/renderer/assets/*.js`.

---

## 1. What the two assemblies contain

### 1.1 Zeasn.Equipment.Option.Lib: file map

| Namespace / folder | Files | Purpose | User relevance |
|---|---|---|---|
| `Zeasn.Equipment.Option.Lib.PHLDisplay` | `CDevice_PHLDisplay.cs` (2078 l.), `PHLDisplay_Oper.cs`, `PHLDisplayFW.cs`, `ENEDataConvert.cs` | Philips monitor driver: DDC/CI option read and write, SmartImage/HDR, input/PIP, audio EQ, Ambiglow (DDC) or ENE USB light effects, function constraints, monitor firmware OTA, BasicInfo summary | **HIGH (34M2C8600)** |
| `Zeasn.Equipment.Option.Lib` (root) | `T_PHLDisplay_Profile`, `DisplayModule*` (8), `SubModuleSmartImage[HDR]`, `AttributeInfo` users, `DisplayFuncConstraints`, `FuncContraintItem`, `DisplayEffectInfo/Menu[Item]/DetailInfo`, `DispalyOtherInfo`, `ExternDispalyInfo`, `DisplayInputSourceInfo`, `GClass0` (EQ item), `DisplayHotKey*`, `HotKey*`, `DispalyHotkeyData`, `GamePQInfo` + `GameQPInfo_Extension`, `EnumItemCompare` | Monitor profile/entity model and menu catalogue | **HIGH** |
| same | `AmbiScapeOper`, `AmbiScapeFollowVideoData` | Screen-capture preview of 10 Ambiglow zones sent to the UI | Medium (UI preview only) |
| same | `FancyZonesOper`, `FancyZonesData` | Wrapper that launches, kills and configures PowerToys FancyZones ("SmartDesktop") | Drop on Linux |
| same | `CDevice_TAGHeadsetDTS`, `TAGHeadsetDTS_Oper`, `ExternRongYuanInfo` | TAG4106/TAG5106 headset + DTS APO | Not owned |
| `...RongYuan`, `.RongYuan.Keyboard/.Mouse/.MousePad`, `.Option.RongYuan.Mouse`, `.Option.RongYuan.Base.Bluetooth` (`GClass1`) | ~25 | RongYuan SPK8708/8508/8308 keyboards, SPK9708/9508/9308 mice, SPL7508 pad (USB HID feature reports, 2.4G dongle, BLE) | Not owned |
| `...Option.BeiYing.KB_K916`, `.ProfileEntity.BeiYing.KB_K916[.Effect]`, `Zeasn.USB.BeiYing.Lib.KB_K916.Entitys` | 10 | BeiYing SPK8618 keyboard | Not owned |
| `...JiangMeng`, `.JiangMeng.Mouse`, `.ProfileEntity.JiangMeng` | 6 | JiangMeng SPK9718/9728 + 8K dongle | Not owned |
| `...Option.YongJiaXing[.Mouse]`, `.ProfileEntity.YongJiaXing[.Mouse]` | 6 | YongJiaXing SPK9618/9418 | Not owned |
| `...Option.HaiHui.Mouse.M3395/.M8960`, `.ProfileEntity.HaiHui[.Mouse]` | 9 | HaiHui SPK9618 (PAW3395 / 8960 sensors) | Not owned |
| `Class0.cs`, `Class3.cs`, `-Module-...cs`, `-PrivateImplementationDetails-.cs` (0 bytes) | 4 | .NET Reactor runtime stub (string decryptor, AES key table). No static data arrays. | None |

**Embedded resources (CONFIRMED).** A metadata table parse of `Evnia Precision Center/resources/bin/Zeasn.Equipment.Option.Lib.dll` finds exactly **1 ManifestResource**. It is named `OduIkS0yWo2Gc1HOHf.9IRk8lXZ0eIGo5sO1D` and is read only by the Reactor stub at `OPT/Class0.cs:347`. It is the encrypted string pool. No `.resources` (magic `0xBEEFCACE`) blob exists. `Zeasn.PCenter.Entity.Lib.dll` likewise has 1 resource, `v7tsLIQnODZk1anYnu.eiAb346gmOhMPeXFw5` (`ENT/../Class0.cs:347`). **Nothing needs extracting.** The catalogues live in code.

### 1.2 Zeasn.PCenter.Entity.Lib: groups

| Group | Types |
|---|---|
| Envelope/common | `AttributeInfo`, `NotificationDataBase`, `Notification_Func`, `EVT_Com`, `EVT_Effect`, `EVT_Profile`, `Const_Display`, `AudioTipsDefine`, `WorkspacePath` |
| Device dictionary | `DictDeviceInfo`, `DeviceInfo`, `DeviceInfoBase`, `Data_DeviceInfo`, `DictDisplayInfo`, `Data_DisplayInfo`, `DeviceType`, `FactoryType`, `EquipmentType`, `ConnectMode`, `ChargeStatus`, `PowerInfo`, `PairInfo`, `MainDeviceTypeAttribute`, `UpgradeFwErrorType`, `ExternInfoBase`, `DTSExternInfo` |
| Profiles/themes | `T_Profile_Base`, `T_DeviceProfile_Base`, `T_Profile`, `T_Theme_Profile`, `T_Sync_Profile`, `SyncDeviceInfo`, `T_BoardInfo_Profile`, `BoardItem`, `T_DTSHeadSetInfo_Profile`, `DataTheme`, `ThemeInfo`, `BindAppInfo`, `ProfileAttributeInfo`, `SoftConfigInfo` |
| BasicInfo summaries | `DataBasicInfo`, `BasicInfoBase`, `BasicInfo_Display/Keyboard/Mouse/MousePad/HeadsetDTS` |
| Effects | `BaseEffectInfo`, `BaseEffectDetailInfo`, `BaseEffectMenu`, `BaseEffectMenuItem`, `EffectType`, `DirectionType`, `RegionType`, `EffectColorData` |
| Buttons/macros | `ButtonInfo`, `ExtButtonInfo`, `LayerButton(s)`, `ButtonLayer`, `ButtonMenu`, `ButtonFunc`, `ButtonAction`, `ButtonExtFunc`, `ButtonSubMenu_*` (5), `ButtonMenuData`, `ButtonMenuItem`, `ButtonMenus`, `SupportButtonFunc`, `ExtEnumItem`, `KeyboardEnumItem`, `MacroInfo`, `MacroDetail`, `MacroType`, `MacroAction`, `MacroPlayType`, `MacroAttributeInfo` |
| Mouse/keyboard params | `ParamMouse`, `DPIData`, `DPIItem`, `DoubleClickSpeedData`, `ScrollSpeedData`, `ReportRate`, `MouseMenu`, `KeyboardGameModeInfo/Item/Type` |
| Monitor VCP value enums | `StandardVCPOpCode_E` (0x00–0xFF), `E2A0_ExternVCPOpCode_E` (0xE2A000–0xE2A088), `VCP_*` (26), `E2A0_*_E` (27), `SmartImage_E1..E4`, `SmartImageHDR_E`, `Level_Off_E`, `Num_0_E`, `Num_Off_E`, `SwitchFlag_E` |
| Misc | `WifiItem` |

`UIDisplayInfo` (namespace `Zeasn.PCenter.Entity.Lib`) physically lives in `Zeasn.PCenter.Base.Lib` (`work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Entity.Lib/UIDisplayInfo.cs`). It has 4 public **fields**: `DisplayName`, `MonitorName`, `DeviceName`, `DisplaySN`. `DisplayEDIDInfo` is in `PBASE/DisplayEDIDInfo.cs`.

---

## 2. The JSON contract

### 2.1 Serializer settings per path (CONFIRMED)

| Path | Code | Settings | Effect |
|---|---|---|---|
| Hub response for **`Profile_GetDeviceData`** only | `work/dotnet-clean/EvniaServe/Class0.cs:15,46-48` (`list_1 = {"Profile_GetDeviceData"}`) | `JsonSerialize(JsonIgnoreExType.IgnoreUI, bIgnoreNullValue:false)` → `ReferenceLoopHandling.Ignore`, `ContractResolver = ConditionContractResolver(IgnoreUI)`, `NullValueHandling.Include` | Drops members tagged `[JsonIgnoreEx(IgnoreUI)]`. Keeps `IgnoreProfile` members. Keeps nulls. |
| Every other hub response | same file `:50` | `JsonSerialize()` → `ReferenceLoopHandling.Ignore` only (`COM/Extension_Json.cs:37-60`) | Default contract: **`[JsonIgnoreEx]` is ignored entirely**. Nulls kept. |
| Notifications (`"Notification"` event) | `work/dotnet-clean/EvniaServe/Evnia/HandleEvent.cs:91-101` | `JsonSerialize()` of the `JsonResult` | Same as above. The whole `JsonResult` is sent as a string argument. |
| Device profile content stored in `.pcenter` (`T_Profile.ProfileContent`) | `work/dotnet-clean/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/GClass0.cs:170` (`PurifyProfile`); peripheral Opers e.g. `OPT/Zeasn.Equipment.Option.Lib.RongYuan/RongYuanKeyboard_Oper.cs:2612` | `JsonSerialize(IgnoreProfile, bIgnoreNullValue:true)` | Drops `IgnoreProfile` members **and nulls** (seen in `Default.pcenter`, e.g. unread `AttributeInfo` without `"Value"`). |
| Board info `Config/BoardInfo/<DeviceType>.data` | same `GClass0.cs:73` | IgnoreProfile + drop nulls | |
| `.pcenter` wrapper, `DataTheme.cfg`, `SoftConfig.data`, `color.data`, `SmartDesktop.data` | `COM/SerializedFileUtil.cs:101-132` (`SaveTXTConfig`) → `SaveTxtData` `:282-300` | `JsonSerialize()` (nulls kept), trimmed, must not contain `\r\n`, written **UTF-8 with BOM**, single line | CONFIRMED by hexdump (`EF BB BF 7B ...`) |
| `Config/data.json` (VCP cache) | `COM/SerializedFileUtil.cs:166-205` `SaveTXTConfigWithSign` | `{"data":"<json>","sign":"<HMAC>"}`. Key `"WhaleTV_Serizlize_2026"` (`HmacSha256Encrypt`) | Out of scope. See report 05/07. |

`ConditionContractResolver` (`COM/ConditionContractResolver.cs:19-27`) removes a property when any `[JsonIgnoreEx(t)]` on it satisfies `t.HasFlag(mode)`. The enum `JsonIgnoreExType { None=0, IgnoreProfile=1, IgnoreUI=2 }` (`COM/JsonIgnoreExType.cs`) is not `[Flags]`, but `HasFlag` is bitwise, so each value only matches itself. Mode `None` bypasses filtering.

**Attribute census in scope (CONFIRMED by grep):**
- 27× `[JsonIgnoreEx(IgnoreProfile)]` (UI-only data).
- 3× `[JsonIgnoreEx(IgnoreUI)]` (profile-only data): `T_RongYuanKeyboard_Profile.GameMode`, `T_RongYuanKeyboard_Profile.SetupData`, `T_BeiYing_KB_K916_Profile.SetupData`.
- 14× `[JsonIgnore]` (never serialized).

### 2.2 Newtonsoft default behaviours a port must mimic

1. **Names are the C# member names verbatim.** PascalCase, plus a few snake_case (`err_code`, `err_msg`). Typos are part of the contract: `DispalyData`, `SupLowBetteryAlertSwitch`, `EquimentName` (ignored), `DTSDectected`, `CurStarCount`, `TurnUpSleep`.
2. **Member order** (INFERRED from Newtonsoft `ReflectionUtils.GetFieldsAndProperties`, and CONFIRMED where observable):
   - Public instance **fields** come first, then public **properties**.
   - Within each kind, the **most-derived class comes first, then base classes**, each in declaration order.
   - Confirmed by `Default.pcenter`: `T_PHLDisplay_Profile` ends with the base `EquipmentType, DeviceType, ModelName`. `DisplayEffectInfo` emits `EffectList, EffectDetail` before base `EffectEnable, CurrEffect`. `ButtonMenuItem` emits `ChildList` before `Name, Text, Value`.
3. **Get-only properties are serialized.** Examples: `JsonResult.IsSucc`, `DisplayEffectInfo.EffectDetail`, `DisplayModuleInput.PIPLocationList`, `ButtonInfo.PreFuncName/ButtonMenuName/FuncText`, `PowerInfo.ConnectName/ChargeName`, `KeyboardGameModeItem.GameModeName`, `MacroDetail.MacroTypeName/MacroActionName`, `T_BoardInfo_Profile.IsHardwareBoard`, `BoardItem.Name`, `ProfileAttributeInfo.Name`, `DoubleClickSpeedData.DoubleClickSpeed` (reads the Win32 double-click time), `ScrollSpeedData.ScrollSpeed` (Win32 wheel lines), `SupportButtonFunc.ButtonMenuName/FuncName/FuncText`.
4. **Static members, `const` fields and private fields are not serialized.** For example `RGB.Red`, `JsonResult.SUCC`, `BasicInfoBase.STR_*` are skipped.
5. **Enums serialize as integers.** Examples: `DeviceType` → `100000`, `CurDir:-1`, `CreateDevice:1`.
6. **`Dictionary<int,T>` keys become strings** (`"SubSmartImages":{"33":{...}}`). `Dictionary<ButtonMenu,...>` keys become enum **names** (`"KeyboardFunc"`).
7. **`ValueTuple<...>` serializes as `{"Item1":…,"Item2":…[,"Item3":…]}`.**
8. `float`/`double` always carry a decimal point (`PowerInfo.Time` default `-1.0`; `UpdateFirmwareProgressInfo.Value` e.g. `12.5`). `byte` values are plain numbers (`RGB.R`).
9. **String escaping:** only `"`, `\` and control characters are escaped. Non-ASCII is written raw in UTF-8 (CONFIRMED: Chinese `Text` values such as `光影同步` appear raw in `Default.pcenter`).
10. No indentation and no trailing newline.
11. `object` members (`AttributeInfo.Value`, `JsonResult.Tag`, `DeviceInfo.ExtDeviceInfo`, `NotificationDataBase.Data`) serialize as the runtime type. `AttributeInfo.Value` is normally `int`, but may be an enum (`OP_04 = SwitchFlag_E.ON` → `1`) or `long` after a round-trip through disk. All of these emit plain numbers.

### 2.3 Envelope (`COM/JsonResult.cs`)

```text
{"err_code":<int>,"IsSucc":<bool>,"err_msg":<string|null>,"RequestId":<string|null>,"Tag":<any>,"FunctionName":<string>,"CurrItem":null}
```

- Order is as written above. `IsSucc` is `err_code==0`. `CurrItem` is `[Obsolete]` but still emitted as `null`. `JsonResult.Succ(tag,msg="")` gives `err_msg:""`. `Error(msg)` gives `err_code:9`.
- The renderer resolves a request only when `err_code===0 && !err_msg` and hands over `.Tag` (`work/app-pretty/renderer/assets/styles-DAnQi2A8.js:7926-7931`).
- For notifications the renderer dispatches on `FunctionName` and passes `.Tag` (`:7961-7969`). Responses carry `RequestId`. Notifications have `RequestId:null`.

### 2.4 `EnumItem` and enum helpers (`COM/EnumItem.cs`, `COM/Extension_Enum.cs`)

- `EnumItem` is `{"Name":string,"Text":string,"Value":int}`.
- `e.GetItem()` (`Extension_Enum.cs:26-34`) returns:
  - `Name = e.ToString()` (the member name; **see §2.6**),
  - `Text` = the `[Description]` text, or the name if there is none,
  - `Value = (int)e`.
- `Extension_Enum.GetDatas(Type)` (`:108-148`):
  - enumerates public static fields,
  - **skips members tagged `[UnbindEnumExtended]`** (marked "U" in the enum appendix),
  - builds the same `EnumItem`s,
  - then **sorts by `Value`** (`List.Sort`, `CompareTo` = value difference).
  - Sorting is unstable, but no in-scope enum has duplicate values.
- Most `ValueList`s and all menus are built this way.
- `EnumItemCompare` (`OPT/Zeasn.Equipment.Option.Lib/EnumItemCompare.cs`) compares on `Value` only. It is used for `Intersect`/`Except` of capability lists.

### 2.5 Class member tables

The complete per-class member tables are in **Appendix A** (Entity.Lib) and **Appendix B** (Option.Lib entities). They were machine-extracted from the decompiled sources and cover JSON key, CLR type, kind (property, public field, computed), JsonIgnore attributes and default value.

### 2.6 Deobfuscation name corrections (CONFIRMED; **must use these in JSON**)

`work/dotnet-clean` renamed these **real enum members** to `const_N`. They are correct in the obfuscated tree `work/dotnet/`. Because `EnumItem.Name`, `FuncName`, `Notification.FunctionName` etc. are produced with `Enum.ToString()`, the runtime emits the **real** names. `Default.pcenter` confirms this: it contains `"Name":"HDRPersonal"`.

| Enum (file) | clean name | **real name** | value |
|---|---|---|---|
| `ButtonFunc` | `const_214` | `PShiftKey` | 912 |
| `ButtonMenu` | `const_5` | `SwitchDPI` | 4 |
| `ButtonMenu` | `const_12` | `PShiftKey` | 11 |
| `E2A0_00_AudioMode_E` | `const_15` | `ShootingActionBASS` | 82 |
| `E2A0_00_AudioMode_E` | `const_17` | `MusicBASS` | 84 |
| `E2A0_59_DualResolution_E` | `const_12` | `WUHD120Hz` | 9 |
| `E2A0_59_DualResolution_E` | `const_13` | `WFHD240Hz` | 16 |
| `E2A0_SettingUser_E` | `const_8` | `USBCSetting` | 8 |
| `KeyboardGameModeType` | `const_4` | `SwitchWASD` | 100 |
| `Notification_Func` (also `Bridge.Lib.Notification`) | `const_2` | `NotifyUISwitchTheme` | 2 |
| `Notification_Func` (also `Bridge.Lib.Notification`) | `const_7` | `NotifyMouseDPIChange` | 7 |
| `SmartImageHDR_E` | `const_4` | `HDRPersonal` | 36 |
| `SmartImageHDR_E` | `const_5` | `HDRNormal` | 37 |
| `SmartImageHDR_E` | `const_8` | `HDRRec2020` | 40 |
| `SmartImageHDR_E` | `const_11` | `HDRRec709` | 43 |
| `SmartImageHDR_E` | `const_12` | `HDRPremium` | 44 |
| `SmartImageHDR_E` | `const_13` | `HDREffect` | 45 |
| `StandardVCPOpCode_E` | `const_86` | `OP_56_HMoiré` (UTF-8 `C3 A9`) | 0x56 |
| `StandardVCPOpCode_E` | `const_88` | `OP_58_VMoiré` | 0x58 |
| `DisplayHotKeyFunc` (Option.Lib) | `const_5` | `GamePQOff` | 5 |
| `DisplayHotKeyFunc` (Option.Lib) | `const_7` | `GamePQNegativeEffect` | 7 |

A name-by-name comparison of all public property and field names finds **no other public renames** in the two assemblies. Only closure/private names differ. The same check on `Zeasn.Monitor.Lib` found `ScalerFW.Constants.DeviceType.const_7 = PDControl` (out of scope). The enum appendix (C) was generated from `work/dotnet/`, so it already shows the real names.

---

## 3. The monitor model (Philips 34M2C8600)

### 3.1 Object tree of `T_PHLDisplay_Profile` (`OPT/Zeasn.Equipment.Option.Lib/T_PHLDisplay_Profile.cs`)

JSON key order is shown. Each `AttributeInfo` below is `new AttributeInfo(code)`: `VCPOpCode` = the numeric code, `VCPOpCodeName` = the enum member name (used for lookup, §3.2).

The "34M2C8600" column comes from the user's real `Default.pcenter`, captured in HDR mode:
- a number is the last value read;
- `n/a` means `err_code:9`, not supported;
- `unread` means `err_code:0` and no `Value`. The attribute was never read because the SDR sub-module is not polled while HDR is active.

| JSON path | VCP | Enum for values (`ValueList` source) | 34M2C8600 |
|---|---|---|---|
| `IsSmartImageHDR` (bool) | — | `CDeviceDisplayBase.GetMonitorHDR().Item2` | `true` |
| `HasUSBSetting` (bool, IgnoreProfile) | — | true if E2A012 or E2A014 or E2A015 available | (UI only) |
| `OP_DC_DisplayApplication` | 0xDC | `SmartImage_E2` / `SmartImageHDR_E` (split, §3.3) | 33 (HDR Game) |
| `ModuleSmartImage.Items` (public **field**, `List<EnumItem>`) | — | DC capability list **minus** `SmartImageHDR_E` values | `[]` (HDR mode) |
| `ModuleSmartImage.CurSubSmartImage.OP_10_Luminance` | 0x10 | range | unread |
| `…OP_12_Contrast` | 0x12 | range | unread |
| `…OP_F0_SmartContrast` | 0xF0 | on/off | unread |
| `…OP_72_Gamma` | 0x72 | `VCP_72_Gamma` (80/100/120/140/160/122) | unread |
| `…OP_87_Sharpness` | 0x87 | range | unread |
| `…EXT_OP_E2A0_20_ColorSpace` | 0xE2A020 | `E2A0_20_ColorSpace_E` | unread |
| `…OP_14_SelectColorPreset` | 0x14 | `VCP_14_SelectColorPreset` | unread |
| `…OP_16_VideoGainDriveRed` / `OP_18_…Green` / `OP_1A_…Blue` | 0x16/0x18/0x1A | range (only written when preset = 11 UserRGB) | unread |
| `…OP_8A_Saturation`, `…OP_90_Hue` | 0x8A/0x90 | range | unread |
| `…EXT_OP_E2A0_24_DLBL` | 0xE2A024 | Low-blue level | unread |
| `ModuleSmartImage.SubSmartImages` | — | `Dictionary<int (DC value), SubModuleSmartImage>` | `{}` |
| `ModuleSmartImageHDR.Items` (field) | — | DC list ∩ `SmartImageHDR_E` | 32 HDROff, 33 HDRGame, 34 HDRMovie, 35 HDRPhoto, 36 HDRPersonal, 48 HDRTrueBlack, 51 HDRPeak |
| `ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance` / `OP_12_Contrast` | 0x10/0x12 | range | 100 / 50 |
| `….EXT_OP_E2A0_3D_LightEnhancement` / `3E_ColorEnhancement` / `3F_DarkEnhancement` | 0xE2A03D/3E/3F | | n/a |
| `ModuleSmartImageHDR.SubSmartImages` | — | `{ "33": {…} }` | present |
| `ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync` | 0xE2A040 | `SwitchFlag_E` | 1 |
| `….EXT_OP_E2A0_02_MBR` / `03_MBRSync` | 0xE2A002/03 | | n/a |
| `….EXT_OP_E2A0_04_SmartCrosshair` | 0xE2A004 | `E2A0_04_SmartCrosshair_E` | 0 |
| `….EXT_OP_E2A0_44_StarkShadowBoost` | 0xE2A044 | `Level_Off_E` (INFERRED) | 0 |
| `….EXT_OP_E2A0_45_ShadowBoost` | 0xE2A045 | | n/a |
| `….EXT_OP_E2A0_06_SharpShooter_Size` | 0xE2A006 | `E2A0_06_SharpShooterSize_E` | 0 |
| `….EXT_OP_E2A0_25_SharpShooter_Location` | 0xE2A025 | | n/a |
| `….EXT_OP_E2A0_07_LowInputLag` | 0xE2A007 | `SwitchFlag_E` | 0 |
| `….OP_EB_SmartResponse` | 0xEB | `VCP_EB_SmartResponse` | n/a |
| `….EXT_OP_E2A0_4C_Overclock` | 0xE2A04C | | n/a |
| `….EXT_OP_E2A0_08_SmartFrame` | 0xE2A008 | `SwitchFlag_E` | 0 |
| `….EXT_OP_E2A0_09_SmartFrameSize` | 0xE2A009 | `Num_0_E`/1..7 | 1 |
| `….EXT_OP_E2A0_0A_SmartFrameBrightness` / `0B_…Contrast` | 0xE2A00A/0B | range | 100 / 50 |
| `….EXT_OP_E2A0_0C_SmartFrameHPosition` / `0D_…VPosition` | 0xE2A00C/0D | range | 0 / 0 |
| `….EXT_OP_E2A0_59_DualResolution` | 0xE2A059 | `E2A0_59_DualResolution_E` (§3.3) | n/a |
| `….EXT_OP_E2A0_68_AutoRefineAIStatus` | 0xE2A068 | | n/a |
| `ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode` | 0xE2A019 | `E2A0_19_AmbiglowLightMode_E` | 7 (Static) |
| `….EXT_OP_E2A0_1A_AmbiglowColors` | 0xE2A01A | `E2A0_1A_AmbiglowColors_E` | 6 (Blue) |
| `….EXT_OP_E2A0_1B_AmbiglowLightPosition` | 0xE2A01B | `E2A0_1B_AmbiglowLightPosition_E` | 0 |
| `….EXT_OP_E2A0_1C_AmbiglowLightBrightness` | 0xE2A01C | `E2A0_1C_…_E` | 2 |
| `….EXT_OP_E2A0_1D_AmbiglowLightSpeed` | 0xE2A01D | `E2A0_1D_…_E` | 0 |
| `….EXT_OP_E2A0_1E_AmbiglowLightDirection` | 0xE2A01E | `E2A0_1E_…_E` | n/a |
| `ModuleAmbiglow.EffectEnable` (bool) | — | UI switch (mode ≠ 0) | false |
| `ModuleInput.OP_ED_InputAuto` | 0xED | | 1 |
| `….OP_60_InputSource` | 0x60 | packed (§3.3) | 15 (DP1) |
| `….OP_A5_WindowSelect` | 0xA5 | PIP/PBP mode | 0 |
| `….OP_EC_PIPPBPSizeLocation` | 0xEC | packed | 0 |
| `….OP_F6_PIPPBPSwap` | 0xF6 | | 0 |
| `ModuleInput.InputSourceList` / `PIPPBPSourceList` | — | 0x60 caps ∩ `VCP_60_InputSource_E` / `VCP_60_PIPPBPSource_E` | DP1 15, HDMI1 17, HDMI2 18, USBC1 21 / 33, 34, 47, 53 |
| `ModuleInput.InputSourceInfo` | — | `DisplayInputSourceInfo` (5 public **fields**: `Mode, Size, Location, PIPPBPSource, InputSource`) | `{0,0,0,34,15}` |
| `ModuleInput.PIPLocationList` (get-only) | — | `GetDatas(VCP_EC_PIP_Location)`: UpperRight 1, LowerRight 2, UpperLeft 3, LowerLeft 4 | always |
| `ModuleAudio.OP_62_AudioSpeakerVolume` | 0x62 | range | 0 |
| `….OP_8D_AudioMute` | 0x8D | `VCP_8D_AudioMute` (1 on / 2 off) | 2 |
| `….EXT_OP_E2A0_00_AudioMode` | 0xE2A000 | `E2A0_00_AudioMode_E` (64..84) | 70 (Off) |
| `….OP_E0_AudioSource` | 0xE0 | `VCP_E0_AudioSourceSelect` | 3 (DP1) |
| `ModuleAudio.EQItems` | — | `List<GClass0 {Name, Index, Value, MaxValue}>` built from 0xE2A001/0xE2A039 | 5 × `{EQ_100..EQ_10000, Value 8, MaxValue 16}` |
| `ModuleSystem.EXT_OP_E2A0_3A/3B/3C_HDMI{1,2,3}RefreshRate` | 0xE2A03A–3C | `E2A0_HDMIRefreshRate_E` | n/a |
| `….EXT_OP_E2A0_0E_OSDSettingHorizontal` / `0F_…Vertical` / `10_…Transparency` / `11_…TimeOut` | 0xE2A00E–11 | ranges / `E2A0_11_OSDSettingTimeOut_E` | 50/50/0/2 |
| `….OP_86_DisplayScaling` | 0x86 | `VCP_86_DisplayScaling` | 2 |
| `….EXT_OP_E2A0_12_USB_C_Setting` / `13_USB_StandbyMode` / `14_USB_Upstream` / `15_KVM` / `16_SmartPower` | 0xE2A012–16 | `E2A0_12/14/15_…_E` | 1/1/n/a/0/0 |
| `….EXT_OP_E2A0_18_LocalDimming` | 0xE2A018 | | n/a |
| `….OP_54_PerformancePreservation` | 0x54 | (Pixel Orbiting std) | 2 |
| `….OP_DA_ScanMode` | 0xDA | `VCP_DA_ScanMode` | 2 |
| `….EXT_OP_E2A0_6B_Profile` | 0xE2A06B | `E2A0_6B_Profile_E` | n/a |
| `ModuleSetup.OP_F2_PowerLED` | 0xF2 | `VCP_F2_PowerLED` | 1 |
| `….OP_CC_OSDLanguage` | 0xCC | `VCP_CC_OSDLanguage` | 2 (English) |
| `….OP_E9_ResolutionNotifier` | 0xE9 | `VCP_E9_ResolutionNotifier` | 0 |
| `….EXT_OP_E2A0_17_CEC` / `35_ScreenSaver` / `34_PixelOrbiting` / `36_PixelRefresh` / `37_PanelRefresh` / `43_AutoWarning` | | `E2A0_35/34_…_E` | 0/2/3/0/n/a/1 |
| `….EXT_OP_E2A0_47_UniBright` … `4B_ThermalProtection`, `61_AutoPixelRefresh`, `54_PixelRefreshCounts`, `55_PanelRefreshCounts` | | | all n/a |
| `ModuleSetup.WorkingTime` / `TimeAfterPixelRefresh` (int) | — | `(E2A04D<<16)\|E2A04E`, `(E2A050<<16)\|E2A051`; -1 if unavailable | -1 / -1 |
| `….EXT_OP_E2A0_41_FanControl` | 0xE2A041 | `E2A0_41_FanControl_E` | 1 |
| `ENEEffectEnable` (bool) | — | ENE USB light controller present | false (09-26), true (09-25) |
| `EffectInfo` (`DisplayEffectInfo`) | — | §3.6 | 7-effect list, current FollowVideo |
| `DispalyData` (`DispalyOtherInfo`) | — | `MonitorEDIDInfo_T` (14 EDID strings), `MonitorResolution` "3440x1440", `MonitorFrequency` "175Hz", `MonitorOrientation` "0°" | see note below |
| `EquipmentType`, `DeviceType`, `ModelName`, `ExtModel` (base) | — | 1, 100000, "PHL 34M2C8600", null | |

`MonitorEDIDInfo_T` for the user's monitor (CONFIRMED):

```text
{"sManufacturer":"PHL","sManufacturerDate":"Week01-2025","PlugAndPlayID":"PHLC29F","sMonitorName":"PHL 34M2C8600","sSerialNumber":"AU00000000001","sVersion":"1.4","ScreenSize":"~34,2\"","TimingRecommandation":"3440x1440","DisplayGamma":"2,2","DisplayTypeAndSignal":"DIGITAL","RedChromaticity":"Rx0,689-Ry0,303","GreenChromaticity":"Gx0,241-Gy0,715","BlueChromaticity":"Bx0,145-By0,059","WhitePoint":"Wx0,313-Wy0,329"}
```

The decimal **commas** show that the EDID strings are formatted with the Windows **current culture**. The user's locale uses `,`. **INFERRED:** a port should use `.` or reproduce the locale deliberately.

**Standard vs extended attributes** (`PBASE/Extension_AttributeInfo.cs:68-120`, CONFIRMED):
- **Standard:** if `VCPOpCodeName` is in `DataOSD.StandardList`, the code calls `DataOSD.GetStandardValue(code, ref value, ref max)`. This is the MCCS Get VCP Feature.
- **Extended:** otherwise, if the name is in `E2A0_ExternList`, the 6-hex-digit code is split. The last byte becomes `extCode` and the code calls `DataOSD.GetTPVExternValue(extCode, appCmd = 0xE2 (226), aCode = 0xA0 (160), …)`. This matches `Const_Display.CONST_PRE2 = 226` and `CONST_ACODE01 = 160` (`ENT/Const_Display.cs`).
- Writes follow the same split (`:122-150`) through `SetStandardValue` / `SetTPVExternValue`.
- Wire framing is in report 07.

### 3.2 `AttributeInfo` semantics (`ENT/AttributeInfo.cs`)

- JSON order: `VCPOpCode, VCPOpCodeName*, Value, MinValue*, MaxValue*, StepValue*, ValueList*, err_code`. Members marked `*` are `IgnoreProfile` and never written to disk. `VCPOpCodeDesc`, `IsAvailable` and `err_msg` are `[JsonIgnore]`.
- `IsAvailable := err_code == 0`. The default is `err_code:0`, so **a never-read attribute counts as available** (CONFIRMED: SDR attributes in `Default.pcenter` have `err_code:0` and no `Value`).
- `GetValue()` only sets `Value`, `MaxValue` and `err_code`. **`MinValue` stays 0 and `StepValue` stays 1** for all module attributes. `ValueList` is copied from the global `DataOSD` attribute (capability-string parse, report 07) when the module's own list is empty (`Extension_AttributeInfo.cs:33-57`).
- On failure `SetErrMsg` sets `err_code = 9` and fills `err_msg` (hidden).
- When a profile is loaded from disk, `VCPOpCodeName` is not stored, yet it survives. **INFERRED:** Newtonsoft `ObjectCreationHandling.Auto` populates the pre-constructed `AttributeInfo` instances created by the field initialisers. A port that loads profiles must rebuild the name from `VCPOpCode`.

### 3.3 Load sequence `CDevice_PHLDisplay.method_4` (`OPT/…PHLDisplay/CDevice_PHLDisplay.cs:296-464`, CONFIRMED)

1. Create `CacheDeviceData = new T_PHLDisplay_Profile{EquipmentType=Display, DeviceType=100000}` and set `ModelName = CurDisplay.MonitorName`.
2. Set `DispalyData.MonitorEDIDInfo_T` from the parsed EDID. `MonitorOrientation`, `MonitorResolution` and `MonitorFrequency` come from `CWinSysDisplay.getCurDisplaySetting`, using the string `"<WxH>-<N>Hz"` split on `-`.
3. If `CurDisplay.IsSupport`:
   1. Run the ENE check `method_14` (§3.6).
   2. Read `IsSmartImageHDR = GetMonitorHDR().Item2`.
   3. `CacheDeviceData.GetValue()` reads **only direct `AttributeInfo` properties** (i.e. `OP_DC`). The logs show `GetValue<T> ModuleAmbiglow is not AttributeInfo` for the rest.
   4. SmartImage split:
      - HDR case: `ModuleSmartImageHDR.Items = DC.ValueList ∩ SmartImageHDR_E`. If DC ≠ 32, read `CurSubSmartImage` and store it in `SubSmartImages[DC]`.
      - Otherwise: `ModuleSmartImage.Items = DC.ValueList − SmartImageHDR_E`. If DC ≠ 16 (`SmartImage_Off`), read and store the same way.
   5. Read `ModuleGameMode`. **DualResolution (0xE2A059):**
      - raw → `Value = raw & 0xFF`, `hi = raw >> 8`.
      - If `0 < hi < ValueList.Count`: when Overclock (0xE2A04C) = 1, remove the first `hi` entries; otherwise keep only the first `hi` entries (`:355-377`).
      - Later (`:445-459`), if the current input is DP1 (15), DP2 (16), USBC1 (21) or USBC2 (22), remove the `UHD120Hz` (0) entry.
   6. Read `ModuleAmbiglow`. Set `ENEEffectEnable = ENE present`, and set `EffectInfo = DisplayEffectInfo.Default(eneModel)` only if ENE is present, else `null`.

      If ENE is absent: `ModuleAmbiglow.EffectEnable = (mode available && mode ≠ 0)`. If the effect is disabled, the stored **`Value` of E2A019 is rewritten to 7 (StaticMode)**, so the UI never shows "Off" as a mode.
   7. **Input.** Read `ModuleInput`.
      - Lists: `InputSourceList = caps(0x60) ∩ VCP_60_InputSource_E`; `PIPPBPSourceList = caps(0x60) ∩ VCP_60_PIPPBPSource_E`.
      - The raw 0x60 value is split little-endian into `InputSource = byte0` and `PIPPBPSource = byte1`. If `byte1 == 0`, the default is 34 (HDMI2) if present in the list, else 47 (DP1) (`:398-410`).
      - If `A5` is available and `DataOSD.PIPPBPEnable(out list)` is true: `A5.ValueList = list`, `Mode = A5.Value`, and `EC` is split into `Size = byte0`, `Location = byte1`.
   8. **Audio.** Read `ModuleAudio`. EQ: for each `item` in `E2A001.ValueList`:
      1. write `E2A001 = item.Value`;
      2. `Thread.Sleep(100)`;
      3. read `E2A039`;
      4. add `{Name=item.Name, Index=item.Value, Value, MaxValue}` (`:418-438`).
   9. Read `ModuleSystem` and `ModuleSetup`. Set `HasUSBSetting` (`method_7`, `:491-506`). OLED counters (`method_9`, `:518-557`).
4. The first time, `ReloadOSD` (`:559-574`) clones this into `DeviceData`, rechecks constraints and saves. Afterwards `ParameterToDevice(DeviceData, bForce:false)` pushes stored values to the monitor.

**`ParameterToDevice`** (`:585-614`):
- With `bForce` (profile switch or apply), `method_10` (`:616-675`) re-applies SmartImage (DC, sleep 1000 ms) and then, in fixed order, ColorSpace, ColorPreset (R/G/B gains only if preset = 11), Gamma, Contrast, SmartContrast, Sharpness, Luminance, Saturation, Hue, DLBL. In HDR the order is Lum, Contrast, 3D, 3E, 3F.
- It always runs `method_12` (`:691-743`, Ambiglow/ENE). `method_11` (game-mode re-apply) exists but has **no caller** in this version.
- `method_13` (`:745-752`) writes only if available and (`force` or the value changed).

### 3.4 Monitor operations: hub function → driver → VCP traffic → response `Tag`

| Bridge function (report 05) | Driver method (line) | DDC side effects (CONFIRMED) | `Tag` returned |
|---|---|---|---|
| `Profile_GetDeviceData(100000)` | base `GetDeviceData` | none | `T_PHLDisplay_Profile` (IgnoreUI mode, nulls kept) |
| `PHL_ReloadData` | `ReloadOSD` :559 | full re-read (§3.3) + re-apply | `T_PHLDisplay_Profile` |
| `PHL_SetOSD(name)` | `SetOSD(string)` :1603 | only `OP_F6_PIPPBPSwap` → write 1; other names only log `"Wait for Set"` | global `DataOSD` `AttributeInfo` |
| `PHL_SetOSD(name, v)` | `SetOSD(string,int)` :1622 | finds attribute by `VCPOpCodeName` in the current SmartImage(HDR) sub-module, then GameMode, Ambiglow, Input, Audio, System, Setup; writes `v`. Then `RecheckFuncConstraints` + save. Bug: always stores `ModuleSmartImage.SubSmartImages[DC] = CurSubSmartImage`, even in HDR. | matched `AttributeInfo` or `null` |
| `PHL_SetSmartImage(v)` | :1675 | error unless `v` is in `Items`; write DC; sleep 1000 ms; re-read the sub-module (clone from `SubSmartImages[v]` if cached) | **`{"Item1":<AttributeInfo DC>,"Item2":<DisplayModuleSmartImage or …HDR>}`** (renderer uses `e.Item2.CurSubSmartImage`, `e.Item1.Value`) |
| `PHL_ResetSmartImage(v)` | :1719 | error if v is Off (16 / 32); write `E2A042 = DataOSD.GetResetSmartImageValue(v)` (values `E2A0_42_ResetSmartImage_E`); sleep 1000 ms; re-read | tuple as above |
| `PHL_SetColorPreset(v)` | :1777 | write 0x14; if `v == 11`: sleep 50 ms, re-read 0x16/0x18/0x1A | `DisplayModuleSmartImage` |
| `PHL_SwitchSmartFrame(v)` | :1808 | write E2A008; sleep 100; poll E2A00A until `MaxValue == 100` (≤ 10 × 1000 ms); then re-read 0B, 09, 0C, 0D (100 ms apart) | `DisplayModuleGameMode` |
| `PHL_SetSmartFrameSize(v)` | :1864 | write E2A009; sleep 1000; re-read 0C, 0D | `DisplayModuleGameMode` |
| `PHL_SetInputSource(in, pip, mode, size, loc)` | :1888 | if pip, mode, size or loc changed and A5 is available: write A5 = mode (100 ms), EC = `size \| loc<<8` (100 ms), 0x60 = `in \| pip<<8` (100 ms), **then `OP_A4_WindowMaskControl = 0xFFFF`**. Else if only the input changed: write 0x60, then A4 = 0xFFFF. | `DisplayModuleInput` |
| `PHL_SwrapPIPPBP` | :1940 | only if Mode ≠ 0: write F6 = 1; **sleep 5000 ms**; re-read 0x60 | `DisplayModuleInput` |
| `PHL_SetAudioEQ(index, v)` | :1976 | error if index is unknown or `v > MaxValue`; write E2A001 = index; sleep 100; write E2A039 = v | `DisplayModuleAudio` |
| `PHL_GetConstraints` | :2021 | also sends notification `NotifyUIDisplayFuncConstraintsChange` | `DisplayFuncConstraints` |
| `PHL_ProfileAction(v, action)` | :2032 | write E2A06B = `((0xA0 / 0xA1 / 0xA2 for action 0 / 1 / 2; default 0xA0) << 8) \| v` | none (n/a on 34M2C8600) |
| `Profile_Reset` → `Reset` | :1998 | write `OP_04 = 1`; drop ENE; **sleep 5000 ms**; full reload | `T_PHLDisplay_Profile` |
| `SetGamePQ(...)` | :2027 | **none (stub)** | `DisplayModuleGameMode` |
| `PHL_GetHotKeyMenu` | :1354 | none | **always `[]`**: `HotKeyItems` is never filled. The builder `method_6` (:474) has no caller. The renderer never calls it (grep of `renderer/assets`). |
| `PHL_GetHotKeyData`, `PHL_SetHotKey*`, `PHL_DeleteHotKey`, `PHL_EnableGamePQMouseKey`, `PHL_SetGamePQMouseKeyBind` | :1359-1422 | none | `null` Tag (`Succ()`) |
| `Effect_*` for device 100000 | §3.6 | ENE USB or DDC Ambiglow | see §3.6 |
| `Theme_GetDevicesBasicInfo` | `PHLDisplay_Oper.AnalyseBasicInfo` (`PHLDisplay_Oper.cs:148-181`) | none | `BasicInfo_Display` inside `DataBasicInfo.Display[]` (§3.8) |
| `Device_GetDeviceInfo(100000)`, `Device_GetConnectList` | `GetDeviceInfo` :218 | none | `DeviceInfo` (§3.9) |
| `DisplayFW_*` | `PHLDisplayFW` | OTA (§3.10) | various |

**Timings** (CONFIRMED `Thread.Sleep` values): DC switch 1000 ms; EQ band select 100 ms; SmartFrame 100 ms per step, with polls of 1000 ms up to 10 tries; PIP writes 100 ms each; PIP swap 5000 ms; factory reset 5000 ms; Ambiglow reset (E2A038) 200 ms; color-preset reread 50 ms.

### 3.5 Function constraints (`OPT/Zeasn.Equipment.Option.Lib/DisplayFuncConstraints.cs`)

**JSON shape:** `{"FuncItems":[{"FuncId":int,"FuncName":string,"State":1|2},…26],"ModuleGameMode":1,"AudioEQ":1}`.
- `FuncId` = the VCP code, e.g. 14852160 for 0xE2A040. `FuncName` = the enum name.
- `State 1` means **enabled** and `2` means **disabled**. The renderer does `optionControl[key] = (1 === state)` (`styles-DAnQi2A8.js:9581-9587`) and indexes by both FuncId and FuncName, with `-1` → AudioEQ and `-2` → ModuleGameMode (`main-CDosWiM3.js:1834-1841`).

The fixed item order (ctor `:64-98`) is in Appendix D.4. `RecheckFuncConstraints(profile)` (`:125-294`) first resets every state to 1 and then applies the rules below. It sends `NotifyUIDisplayFuncConstraintsChange` only if the serialized JSON changed (`:288-293`).

Definitions:
- `pip` = A5 available ∧ `DataOSD.PIPPBPEnable` ∧ A5 ≠ 0
- `hdr` = `IsSmartImageHDR`
- `hz` = int(`DispalyData.MonitorFrequency` without the "Hz" suffix)
- `ss` = ScreenSaver E2A035 available ∧ ≠ 0
- `sniper` = ¬(pip ∨ hdr) ∧ E2A006 available ∧ ≠ 0
- `async` = ¬pip ∧ E2A040 available ∧ ≠ 0
- `mbrOn` = ¬(pip ∨ hz < 75 ∨ async) ∧ E2A002 available ∧ > 0
- `mbrSyncOn` = ¬pip ∧ async ∧ E2A003 available ∧ ≠ 0
- `dc` = DC value

| Item | Disabled when |
|---|---|
| E2A040 AdaptiveSync | pip |
| E2A002 MBR | pip ∨ hz < 75 ∨ async |
| E2A003 MBRSync | pip ∨ ¬async |
| E2A004 SmartCrosshair, 0xEB SmartResponse, E2A04C Overclock, 0x54 | pip |
| E2A044, E2A045, E2A006 | pip ∨ hdr |
| E2A007 LowInputLag | pip ∨ sniper |
| 0x10 Luminance | (only if DC available) ¬hdr ∧ (mbrOn ∨ mbrSyncOn); never in HDR |
| 0x12 Contrast | dc == 14 (EasyRead) |
| 0xF0 SmartContrast | pip ∨ ss ∨ sniper ∨ mbrOn ∨ mbrSyncOn |
| 0x14 ColorPreset, E2A020 ColorSpace | dc ∈ {14, 11 (LowBlue)} |
| E2A024 DLBL | dc ≠ 11 |
| E2A008 SmartFrame | pip ∨ hdr ∨ sniper ∨ dc ∈ {0 Standard, 14 EasyRead} |
| E2A01A–1E Ambiglow sub-items | E2A019 unavailable → all 2. Otherwise per mode, as (Colors, Position, Brightness, Speed, Direction): FollowVideo(1) = 2,2,1,2,2; FollowAudio(2) = 1,1,2,2,2; ColorShift/Wave/Breathing(3/4/5) = 1,1,1,1,1; StarryNight(6) = 1,2,1,1,1; Static(7) = 1,1,1,2,1; ColorFlow(9)/Reverse(8) = 2,2,1,1,2 |
| 0xE0 AudioSource | pip ? enabled(1) : disabled(2) (note: inverted) |
| 0xDA ScanMode | 2 unless (0x86 item enabled ∧ 0x86 available ∧ 0x86 == 1 NoScaling) |
| `ModuleGameMode`, `AudioEQ` | always 1 |

### 3.6 Light effects on the monitor: two back ends

**A. DDC "Ambiglow" (no ENE USB).**
- The UI edits `ModuleAmbiglow` through `PHL_SetOSD("EXT_OP_E2A0_19_AmbiglowLightMode", v)` etc.
- `Effect_Enable(100000, on)` (`CDevice_PHLDisplay.cs:974-1008`): if E2A019 is available, set `ModuleAmbiglow.EffectEnable`. For **on**, write the stored mode. For **off**, write `0` (AmbiglowOff) while keeping the stored mode. Then recheck constraints and save. **Tag = the bool `enable`.** Returns `Error("NotSupport")` if E2A019 is unavailable.
- `Effect_Reset` (`:1154-1188`): writes E2A038 = 1, waits 200 ms, re-reads the module, and returns **`DisplayModuleAmbiglow`**. It also removes the display from `Sync_Profile.SyncDevices` and notifies `NotifyEffectSyncDevicesChange` (Tag = `T_Sync_Profile`).
- Every other `Effect_*` (Change, Color, Speed …) returns `Error("Not Support ENE")` without ENE.

**B. ENE USB controller** (the ENE 6K7732 hub light MCU, USB VID `0x0CF2`; protocol in report 09).
- **Detection** (`method_14` :754-810):
  - on USB change, compare the device list for `vid_0cf2`;
  - `CUSBENE6K7732.Plug()`;
  - `GetModelName(MonitorName)` → e.g. `"34M2C8600"` (log 2026-09-25: `GetFWModelName sModelName:34M2C8600`, `FWVersion 03 32 07 0F 0B`).
- **On detection:**
  - `ENEEffectEnable = true`;
  - `EffectInfo` is kept, or set to `DisplayEffectInfo.Default(model)`;
  - the effect is pushed with `method_17`;
  - the profile is saved;
  - if detection happened on a USB change, notification `NotifyUIDisplayEffectChange` is sent.
- **Loss** (`method_15` :812-864): if the effect was enabled, re-arm DDC Ambiglow (write mode, mapping 0 → 7), recheck constraints, save, and send the same notification.
- The **hub-change triggers** also watch `vid_05E3`/`vid_0552` (hubs) and `vid_2109`/`vid_0BDA` (devices) to recheck the DDC-over-USB connection (`:25-29`, `:204-216`).
- **`NotifyUIDisplayEffectChange` Tag is a ValueTuple** `(bool ENEEffectEnable, DisplayEffectInfo EffectInfo, DisplayModuleAmbiglow ModuleAmbiglow)` (`:790`, `:854`), so the JSON is `{"Item1":…,"Item2":…,"Item3":…}`. The renderer handler reads `a.ENEEnable`, `a.EffectInfo` and `a.ModuleAmbiglow` (`work/app-pretty/renderer/assets/Monitor-D4qz4RBn.js:85-91`). This is a **vendor bug**: the handler throws on `Object.keys(undefined)`.
- **Effect menu** (`Effect_GetMenu(100000)`) = `DisplayEffectMenu.Default(eneModel)` (`OPT/…/DisplayEffectMenu.cs:49-138`). It is cached per ENE model string, with `""` when there is no ENE. There are 7 effects in fixed order:
  - FollowVideo(1), FollowAudio(2), ColorShift(3), ColorWave(4), Breathing(5), StarryNight(6), Static(7).
  - Base flags: SupSync = true, speed 1..3 step 1, brightness 1..3 step 1, SupColor = true, SupRainbow = true.
  - Per-effect overrides: FollowVideo has no speed, brightness, rainbow or color. FollowAudio has no speed or brightness. Static has no speed. FollowAudio, ColorShift/Wave/Breathing and Static get `RegionList = GetRegions(model)` with `SupRegion = RegionList.Length > 1`.
  - `GetRegions` (`:140-168`) looks up `PCenter_AmbiglowInfo.json` by exact `ModelName`:
    - always AllZones(0);
    - if `BottomLedCount > 0`: Bottom(3), then FourSided(1) if all four side counts are > 0;
    - else ThirdSidedA(4) if all four side counts are > 0;
    - then Central(2) if `CenterLedCount > 0`.
  - For **34M2C8600** (`Right 3, RightUp 4, LeftUp 4, Left 3, Center 18, Bottom 14`) the list is **[AllZones, Bottom, FourSided, Central]**. Exact JSON is in Appendix D.1. Without ENE the list is only `[AllZones]` and `SupRegion:false` (D.2).
- **Effect info default** (`DisplayEffectInfo.Default`, `:49-76`):
  - `CurrEffect = Static`;
  - each effect gets `Speed 2, Brightness 3, IsRandomColor false, IsRainbowColor true, CurRGB (0,0,255), BgRGB (0,0,0), CurDir -1, CurRegion 0, CurStarCount 1`;
  - FollowVideo and FollowAudio use `CurRGB (0,0,0)`.
  - **Byte-identical to the stored profile** (verified by script; Appendix D.3).
- **Effect setters** (`Effect_Change/Color/BgColor/Speed/Brightness/Direction/Region/Random/Rainbow`, `:1010-1152`):
  - They update `EffectInfo.EffectDetail` (for Color, rainbow and random are also forced false), push with `method_17`, save unless in sync, and return **`DisplayEffectInfo`**.
  - Speed and Brightness changes do not push while FollowVideo, FollowAudio or Breathing is active. Those are streamed.
  - `Effect_Enable` with ENE returns the bool.
- **Mapping to the ENE parameter set** (`OPT/…PHLDisplay/ENEDataConvert.cs:9-86`, CONFIRMED):

| UI | ENE `TMain_ParameterSet` |
|---|---|
| `EffectEnable=false` | `light.mode = MNTLightEffect_E.LEDOFF` |
| FollowVideo, Breathing | `UserDefine`. Frames are streamed by the host: video via `ParameterVideoSync(CalcRGBs(50 cols, 40 rows))`; breathing fills 40×50 RGB with one colour (`:1269-1316`). If breathing cannot sync, `ColorBreathing` is sent instead. |
| FollowAudio | `FollowAudio` + `ParameterAudioSync(level byte)` |
| ColorShift / ColorWave / StarryNight / Static / other | same-named `MNTLightEffect_E` / `StaticMode` |
| Brightness 1/2/3/other | `Bright_E.Bright/Brighter/Brightest/Brighter` |
| Speed 1/2/3/other | `Speed_E.Low/Normal/High/Normal` |
| CurRegion | Central→`Central`, Bottom→`Bottom`, FourSided/ThirdSidedA/B→`Border4Sided`, default→`AllZone` |
| `light.rainbow` / `light.rgb` | `IsRainbowColor` / `CurRGB` |

- **Sync with peripherals:** `OnSyncEffect` clamps brightness to 1..3 and copies only the fields the menu item supports (`:1318-1336`, `method_16` :881-952). It then sends `NotifyEffectChange` with Tag `NotificationDataBase{DeviceType:100000, Data: DisplayEffectInfo}`.
- `Effect_GetLEDs(100000)`: only with ENE and FollowVideo/FollowAudio; returns `cusbene.GetLightColors(model)` (shape in report 09); otherwise `Error("not ene follow video or audio")`.

**AmbiScape preview** (`OPT/…/AmbiScapeOper.cs`):
- `AmbiScape_EnableFollowVideo(enable, intervalMs)` turns on down-sampling of each captured frame to an 8×6 grid (`CalcRGBs(8,6)`, `:61`), rate-limited to `interval` (default 2000 ms).
- It emits `NotifyAmbiScapeFollowVideoData` with Tag `{"T","B","R1","R2","R3","R4","L1","L2","L3","L4"}`, each an `RGB`.
- Zone formulas (averages; `[row][col]`):

| Zone | Formula |
|---|---|
| L3 | rows 0–2 @ col 0 |
| L4 | row 0 @ cols 1–2 |
| T | row 0 @ cols 3–4 |
| R4 | row 0 @ cols 5–6 |
| R3 | rows 0–2 @ col 7 |
| R2 | rows 3–5 @ col 7 |
| R1 | row 5 @ cols 5–6 |
| B | row 5 @ cols 3–4 |
| L1 | row 5 @ cols 1–2 |
| L2 | rows 3–5 @ col 0 |

  JSON property order is `T, B, R1, R2, R3, R4, L1, L2, L3, L4` (class order).

### 3.7 GamePQ / hotkeys (dead code in 1.13.0)

- `GamePQInfo` and `GameQPInfo_Extension.GetColorFilterValue` define the Color-Filter value: `((R==IsShow)<<5 | (G==IsShow)<<4 | (B==IsShow)<<3 | (C==IsShow)<<2 | (M==IsShow)<<1 | (Y==IsShow)) << 8 | 3`, for VCP 0xE2A088 (`E2A0_88_GamePQ_E.ColorFilter=3`).
- **No caller writes it** (`SetGamePQ` is a stub; `method_28` is empty).
- The brightness, contrast and sharpness hotkeys (`method_23..27`, ±10, clamped 0..100, then `NotifyHotKeyExecute{DeviceType:100000, Data: DisplayHotKeyFunc item}`) are reachable only through `RegisterHotKey`. Nothing registers them because `HotKeyItems` is empty.

### 3.8 `BasicInfo_Display` (dashboard card; `PHLDisplay_Oper.cs:148-181`)

**JSON order:** `LightSync, LightMode, Resolution, RefreshRate, SmartImage, Input, AdaptiveSync, Connect, EquipmentType, DeviceType, ModelName, ExtModel`. `"/"` means not supported.

| Field | Value |
|---|---|
| `Connect` | a `UIDisplayInfo.MonitorName` equals `ModelName` |
| `LightSync` | `"/"` unless `MonitorInfo.json.SupLightSync`; then `"On"` if the display is in `SyncDevices` and more than one device syncs, else `"Off"` |
| `LightMode` | with ENE: `EffectInfo.CurrEffect.Name`; else the **`Name`** of `E2A0_19_AmbiglowLightMode_E` matching the E2A019 value (AmbiglowOff is Unbind, so it gives `"/"`) |
| `Resolution`, `RefreshRate` | from `DispalyData` |
| `SmartImage` | the `Items` entry `Name` matching DC. Only the SDR list is searched, so in HDR it is `"/"`. |
| `AdaptiveSync` | `"On"`/`"Off"`/`"/"` |
| `Input` | `InputSourceList` `Name` (e.g. `"Normal_DisplayPort1"`) |

### 3.9 `DeviceInfo` for the monitor (`CDevice_PHLDisplay.cs:218-246`)

The object is built from the `PCenter_DeviceInfo.json` record for 100000, then:
- `ModelName = CurDisplay.MonitorName`;
- `SupEffect/SupSync` come from `MonitorInfo.json` (`SupLightEffect/SupLightSync`);
- `ExtDeviceInfo = ExternDispalyInfo{CurSN, DisplayList:[UIDisplayInfo…]}`.

JSON order:

```text
StrFwVersion(null), FwVersion(0), ExtDeviceInfo{CurSN,DisplayList[{DisplayName,MonitorName,DeviceName,DisplaySN}]}, DeviceType 100000, FactoryType 1, EquipmentType 1, ModelName, ExtModel "", HasBattery false, Vid 0, Pid 0, IUSB_USAGE_PAGE 0, IUSB_USAGE 0, CreateDevice 0, CheckFState 0, SupEffect, SupSync, ProfileCount 1, SupGameMode false, Extra "", ConnectMode -1
```

### 3.10 Monitor firmware OTA (`OPT/…PHLDisplay/PHLDisplayFW.cs`, online-related)

- **`DisplayFW_CheckUpstreamCable`:** Tag = `MonitorService.CheckUpstreamCable()`.
- **`DisplayFW_GetMonitorCount`:** Tag = count of scaler-capable USB monitors plus EDID-only displays. If exactly one of each exists, it returns `1` when `%APPDATA%/evnia/MonitorInfo.json` lists the EDID name, under `Monitors[].Name`, with the factory name in `FactoryModelNames` (`:468-512`).
- **`DisplayFW_GetDeviceList`:** Tag = `List<MonitorInformation>`, where each item has public fields `ShowName, StrFwVersion ("V…"), FwVersion, ScalerModelName, ScalerBomInfo, UsbHubCount (0), DeviceType, AdmWarning`. It also lists extra OTA devices (USB hubs; ENE Ambiglow with its FW version). Error codes are placed directly in `err_code`:

  | err_code | Hex | Meaning |
  |---|---|---|
  | -536739837 | 0xE0020003 | NoDisplays |
  | -536739838 | 0xE0020002 | GetMonitorCount (more than one monitor) |
  | -536735736 | 0xE0021008 | NotReady |
  | -536739836 | 0xE0020004 | WrongUpstreamCable; `err_msg` = monitor name; this is the no-USB-upstream case |
  | -536858613 | 0xE000300B | FirmwareUpdating |

  Values are from `work/dotnet-clean/Zeasn.Monitor.Lib/Zeasn.Monitor.Lib.ScalerFW.Constants/ErrorCode.cs`.
- **`DisplayFW_UpdateFirmversion(scaler, type, zipPath)`:** flashes a **local .zip** through `MonitorService.UpdateMonitorOTADeviceFirmware` / `UpdateOtherOTADeviceFirmware`. The ENE is unplugged first. It emits `FirmwareUpdateProgressData` every 2000 ms with Tag `{"Name":"Update Firmware Progress","Type":"OSD","Value":<double %>}`.
- **`DisplayFW_InstallDriver`:** no-op, `err_code 0`. **`DisplayFW_FWUpdateFailedNextTime(flag)`:** sets `ISPForceFailedStep`, a test hook.
- The .zip is downloaded online by the Electron side (report 01).

### 3.11 FancyZones / SmartDesktop (`OPT/…/FancyZonesOper.cs`)

This is Windows-only glue to `%APPDATA%/SmartControl/Modules/SmartDesktop/modules/FancyZones/PowerToys.FancyZones.exe` and `PowerToys.FancyZonesEditor.exe`, with state in `%APPDATA%/SmartControl/SmartDesktop.data` (`FancyZonesData{FancyZonesSettings (field), Enable}`).

`FancyZones_GetVersion` returns `FancyZonesVersionModel`:

```text
{"StrVersion":"V<fileversion|0.0.0.0>","Version":int,"DP_DeviceType":"SmartDesktop","DP_ComponentID":"Philips_SmartDesktop"}
```

The fields come first. The DP ids are OTA identifiers. `FancyZones_SetSetting` accepts about 60 setting names in both camel and Pascal case. **Drop on Linux** (report 13).

---

## 4. How menus are built

| Hub function | Builder | Data or code | Cached |
|---|---|---|---|
| `Effect_GetMenu(dev)` | `CDeviceEffectBase.GetEffectMenu` → `GetEffectMenuData()` → per-device `InitEffectMenu()` (`work/dotnet-clean/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/CDeviceEffectBase.cs:41-64`) | Code (`*EffectMenu.Default`); display regions come from data (`PCenter_AmbiglowInfo.json`) | per `deviceType.ToString()` (display: per ENE model) |
| `Button_GetFuncMenu(dev)` | `CDeviceButtonBase.GetButtonFuncMenu` → `GlobalOper.MakeButtonMenuData(GetSupportButtonFuncs())` (`PBASE/GlobalOper.cs:148-230`) | Code (`GetSupportButtonFuncs` tables in each Oper) + `System.Windows.Forms.Keys` enumeration | per device instance |
| `Macro_GetFuncMenu()` | `SystemOper.Macro_GetFuncMenu` (`CORE/SystemOper.cs:2544-2552`) → `GlobalOper.MakeMacroCmdMenuData(smethod_17())` (`PBASE/GlobalOper.cs:232-278`) | Code, **fully static**: Appendix D.5 | static |
| `Mouse_GetMouseMenu(dev)` | `CDeviceMouseBase.GetMouseMenu` = `new MouseMenu()` → `{"SupReportRate":true}` | Code | no |
| `DeviceSteup_GetSetupMenu(dev)` | per-Oper `GetSetupMenu` | Code | per instance |
| `PHL_GetHotKeyMenu()` | `CDevice_PHLDisplay.GetHotKeyMenu` | none | always `[]` |

### 4.1 `ButtonMenuData` / `ButtonMenuItem` shapes

- `ButtonMenuData` = `{"Items":[ButtonMenuItem…],"ExtFuncDef":[{"Name":"ApplyToThemeCycleProfiles","Text":"将功能应用到当前主题下所有循环Profile中","Value":0},{"Name":"ApplyToThemeCycleOnBoards","Text":"将功能应用到所有板载中","Value":1}]}`.
- `ButtonMenuItem` = `{"ChildList":[…],"Name","Text","Value"}`. `ChildList` is `List<object>` and holds heterogeneous items:
  - nested `ButtonMenuItem`s;
  - `ExtEnumItem` `{"ExtData","Name","Text","Value"}`, used for function entries (`ExtData` from `SupportButtonFunc.ExtData`, default `""`);
  - `KeyboardEnumItem` `{"SupModify","Name","Text","Value"}`, used for keyboard entries;
  - plain `EnumItem`, used for Macro play types.

**`MakeButtonMenuData` algorithm** (`GlobalOper.cs:148-230`). For each `ButtonMenu` from `GetDatas`, sorted 0..13, skipping NULL: if the device supports no entry with that menu, skip it. Otherwise:
- **AppUser (12) / DeviceFunc (13):** for each submenu from `GetDatas(ButtonSubMenu_AppUser/DeviceFunc)`, add a child `ButtonMenuItem(submenu)` whose children are `ExtEnumItem(func.GetItem(), ExtData)` for the entries with `SubMenu == submenu.Value`.
- **Macro (5):** children = `GetDatas(MacroPlayType)`, i.e. `MacroPlayOnce 0, MacroPlayMultiple 1, MacroTogglePlayback 2, MacroPressToPlay 3`.
- **KeyboardFunc (2):** for each `ButtonSubMenu_Keyboard` (KeyRecording 0 … SymbolsMore 7):
  - **KeyRecording** children = every distinct `System.Windows.Forms.Keys` value whose `KeyboardHIDScanCode_Extension.ToUsbKeys(k) != 0`, as `KeyboardEnumItem(k.GetItem(), SupModify:false)`. Name and Text are the WinForms `Keys` member name.
  - other submenus: `KeyboardEnumItem(func.GetItem(), supModify)` for matching `SubMenu`; skip if empty.
- **All other menus:** children = `ExtEnumItem`s.

**`MakeMacroCmdMenuData`** (for macro "command" steps) iterates the same `ButtonMenu` order but emits flat `Items`:
- LaunchProgram → one item per function (LaunchExe 864, LaunchWebsite 865);
- Media → one item `{Name:"Media",Text:"多媒体",Value:10}` with 7 children (880..886);
- AppUser → one item per submenu (Productivity 0, Windows 1, Editing 2, Navigation 3).

The input list is hard-coded in `CORE/SystemOper.cs:2554-2851` (48 entries). The exact JSON (4025 bytes) is in **Appendix D.5**. The renderer calls it on start-up even with only a monitor attached (logs `2026-09-25/26`).

**Per-device supported-function tables** (`GetSupportButtonFuncs`, counts by `ButtonMenu`; CONFIRMED):

| Oper (line) | total | Preset | Disable | KeyboardFunc | MouseFunc | SwitchDPI | Macro | Text | SwitchProfile | SwitchLighting | LaunchProgram | Media | PShiftKey | AppUser | DeviceFunc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `RongYuanKeyboard_Oper.cs:530` | 213 | 1 | 1 | 124 | 10 | – | 1 | 1 | 5 | 6 | 2 | 7 | 1 | 39 | 15 |
| `RongYuanMouse_Oper.cs:624` | 214 | 1 | 1 | 124 | 10 | 4 | 1 | 1 | 5 | 6 | 2 | 7 | 1 | 39 | 12 |
| `BeiYing_KB_K916_Oper.cs:174` | 176 | 1 | 1 | 124 | 5 | – | 1 | – | – | – | – | 7 | – | 37 | – |
| `JiangMengMouse_Oper.cs:335` | 185 | 1 | 1 | 124 | 10 | 4 | 1 | – | – | – | – | 7 | – | 37 | – |
| `HaiHui_9618_3395_Mouse_Oper.cs:365` | 185 | 1 | 1 | 124 | 10 | 4 | 1 | – | – | – | – | 7 | – | 37 | – |
| `HaiHui_9618_8960_Mouse_Oper.cs:340` | 184 | 1 | 1 | 124 | 10 | 3 | 1 | – | – | – | – | 7 | – | 37 | – |
| `YongJiaXingMouse_Oper.cs:337` | 184 | 1 | 1 | 124 | 10 | 3 | 1 | – | – | – | – | 7 | – | 37 | – |

### 4.2 Setup menus (`DeviceSteup_GetSetupMenu`)

All five setup-menu classes have the same 14 members:

```text
SupStartupEffect, SupLowBetteryAlertSwitch, MinLowBetteryValue, MaxLowBetteryValue, StepLowBetteryValue(=1), SupLightSleepTimeSwitch, MinLightSleepTime, MaxLightSleepTime, StepLightSleepTime(=1), SupDeepSleepTimeSwitch, MinDeepSleepTime, MaxDeepSleepTime, StepDeepSleepTime(=1), SupLightEnable
```

`BeiYing_KB_916_SetupMenu` differs only in the default `MinLightSleepTime = 1`. Values set by each Oper (CONFIRMED):

| Device | StartupEff | LowBatt (min..max step) | LightSleep (sw, min..max) | DeepSleep (sw, min..max) | LightEnable |
|---|---|---|---|---|---|
| RongYuan keyboard (wired) | true | false | false, 0..0 | false, 0..0 | true |
| RongYuan keyboard BLE/2.4G | true | **true**, 10..50 | true, 1..10 | true, 1..10 | true |
| RongYuan mouse (wired) | true | false | false | false | true |
| RongYuan mouse BLE/2.4G | true | **false**, 10..50 | true, 1..10 | false, 1..10 | true |
| RongYuan mouse pad | true | false | false | false | true |
| BeiYing SPK8618 / 24G | false | false | true, 1..100 | false | false |
| JiangMeng (all) | false | true | only Dongle_8K: true; min 1, max 50 | false, min 1 | false |
| HaiHui 3395 / 8960, YongJiaXing | false | true | false; min 1, max 50 | false, min 1 | false |

Source lines: `RongYuanKeyboard_Oper.cs:2187`, `RongYuanMouse_Oper.cs:2278`, `RongYuanMousePad_Oper.cs:123`, `BeiYing_KB_K916_Oper.cs:1487`, `JiangMengMouse_Oper.cs:1578`, `HaiHui_9618_3395_Mouse_Oper.cs:1622`, `HaiHui_9618_8960_Mouse_Oper.cs:1610`, `YongJiaXingMouse_Oper.cs:1607`.

`MouseMenu.SupReportRate` is set false for HaiHui-3395 over BLE, and for HaiHui-8960/YongJiaXing over **USB**. That last one looks inverted, but it is what the code does.

### 4.3 Effect catalogues for peripherals (code-driven)

| Menu class | Effects (order) | Ranges / notable flags |
|---|---|---|
| `KeyboardEffectMenu` (RongYuan KB) | FollowVideo, FollowAudio, ColorWave, Breathing, StarryNight, ColorShift, Static, Coverge, PressActionOn, ColorWaveW, Kaleidoscope, PressActionOff, ColorWaveLine, Laser, Radar, Dazzing, RainDown, Meteor, Neon, Ripple (20) | speed and brightness 1..5. `DirList`: ColorShift {Sequence 10, Clip 11}, ColorWave {RtoL 1, LtoR 0, UpToDown 2, DownToUp 3}, ColorWaveLine {1, 0}, Radar {6, 7}, Kaleidoscope {5, 4}. Many have `SupSync=false`. |
| `MouseEffectMenu` (RongYuan mouse) | FollowVideo, FollowAudio, ColorWave, Breathing, StarryNight, ColorShift, Static, Neon | 1..5 |
| `MousePadEffectMenu` | FollowVideo, FollowAudio, ColorWave, Breathing, StarryNight, ColorShift, Static | 1..5 |
| `BeiYingKB_K916_EffectMenu` | BeiYing_Static 101 … BeiYing_Kaleidoscope 115 (15). SPK8618 wired also gets FollowVideo, FollowAudio at the front. | 1..5. **Every item ends with `SupSync=false`**: it is set after `SetEffect`, and the stored object is the same reference. |

The defaults for `*EffectInfo.Default()` are in the source files. For example `KeyboardEffectInfo`: `CurrEffect=ColorWave`, `Speed 3`, `Brightness 5`, white colours, and directions per effect.

### 4.4 Default key layouts (code-driven static tables)

`T_*_Profile.GetBasicButtons()` / `GetFnButtons()` hold `ButtonInfo{ButtonId, ButtonMenu=Preset, PreFunc, ButtonFunc}` rows (CONFIRMED counts):

| Profile | Base layer | Fn layer |
|---|---|---|
| RongYuan keyboard | 109 (ids 0..125) | 109 |
| BeiYing SPK8618 | 82 (ids 0..95) | 82 |
| RongYuan mouse | 8 | 8 |
| HaiHui 3395 | 8 | 6 |
| HaiHui 8960 | 7 | 6 |
| YongJiaXing | 8 | 6 |
| JiangMeng | 6 | 6 |

`Layers` = `GetDatas(ButtonLayer)` = `[{"Name":"LayerBase","Text":"标准层","Value":1},{"Name":"LayerFn","Text":"Fn 层键盘","Value":2}]`.

USB usage and firmware code maps are in the data files `res/data/RongYuan/RongYuan_Keyboard_V1.json` (126 records: `ButtonID, UsageID, Keys, KeyName, BaseValue, BaseCanDef, FnKeyName, FnValue, FnCanDef, Exits, Desc`) and `res/data/BeiYing/KB_K916.json` (82 records: `ButtonID, UsageID, Keys, ButtonDefValue, ButtonFnValue, KeyName, Exits, Desc`). Those files are read by `Zeasn.USB.*` (other reports).

---

## 5. Peripheral drivers in Option.Lib (not owned by the user)

| DeviceType (value) | VID:PID (usage page / usage) | ConnectMode | Oper → CDevice → converter | Profile class | Transport (from Option.Lib code) |
|---|---|---|---|---|---|
| RongYuan_KeyboardSPK8708 (200000) / 8508 (200001) / 8308 (200002) | 25AA:2007 / 2006 / 2005 (FFFF/1, `mi_02`) | USB | `RongYuanKeyboard_Oper` → `CDevice_RongYuanKeyboard[Base]` → `RongYuanDataConvert` / `RongYuanIO` | `T_RongYuanKeyboard_Profile` | HID **feature reports, 64 bytes**, report id 0. Header 8 bytes, payload 56 bytes per page; byte0 = command (`FEA_CMD`); an optional page-index byte. 2.4G link probing with commands 0xF7/0xFE/0xF6/0xFC (`OPT/…RongYuan/RongYuanIO.cs:31-57, 262-460, 464-520`). |
| …SPK8708_BLE (200003) / _24G (200004) | — / 25AA:2008 | BLE / Dongle | same + `GClass1` (BLE HID) | same | BLE GATT HID (`Option.RongYuan.Base.Bluetooth/GClass1.cs`) |
| RongYuan_MouseSPK9708/9508/9308 (300000-2), _BLE (300003), _24G (300004) | 25AA:4007/4006/4005, 4008 | USB/BLE/Dongle | `RongYuanMouse_Oper` → `CDevice_RongYuanMouse[Base]` | `T_RongYuanMouse_Profile` | same as keyboard |
| RongYuan_MousePadSPL7508 (400001) | 25AA:8002 (FFFF/2) | USB | `RongYuanMousePad_Oper` → `CDevice_RongYuanMousePad[Base]` | `T_RongYuanMousePad_Profile` | same |
| BeiYing_KeyboardSPK8618 (201000) / _24G (201001) | 25AA:200D / 3554:FA09 | USB / Dongle | `BeiYing_KB_K916_Oper` → `CDevice_BeiYing_KB_K916` → `BeiYing_KB_K916_DataConvert` | `T_BeiYing_KB_K916_Profile` | via `KB_K916_Controller` (Zeasn.USB.BeiYing.Lib) |
| JiangMeng_MouseSPK9718 (301000), Dongle_8K (301001), SPK9728 (301002) | 25AA:4010, 400F, 400D (`mi_01&col05`) | USB/Dongle | `JiangMengMouse_Oper` → `CDevice_JiangMeng_Mouse` → `JiangMengDataConvert` (FlashDataMap) | `T_JiangMengMouse_Profile` | Zeasn.USB.JiangMeng.Lib / Mouse_SPK9718.dll |
| YongJiaXing_MouseSPK9618 (302000), _24G (302001), SPK9418 (302002), _24G (302003) | 25AA:200F, 2010, 2011, 2012 | USB/Dongle | `YongJiaXingMouse_Oper` → `CDevice_YongJiaXing_Mouse` → `YongJiaXingDataConvert` (`M_9618_Struct`) | `T_YongJiaXingMouse_Profile` | Zeasn.USB.YongJiaXing.Lib |
| HaiHui_MouseSPK9618_3395 (303000), _24G (303001), _BLE (303002) | 25AA:4019, 4018; BLE `vid&023151_pid&503c` (FF55/514) | USB/Dongle/BLE | `HaiHui_9618_3395_Mouse_Oper` → `CDevice_9618_3395_Mouse` | `T_HaiHui_9618_3395_Mouse_Profile` | Zeasn.USB.HaiHui.Lib |
| HaiHui_MouseSPK9618_8960 (303003), _24G (303004) | 25AA:401B, 401A | USB/Dongle | `HaiHui_9618_8960_Mouse_Oper` → `CDevice_9618_8960_Mouse` | `T_HaiHui_9618_8960_Mouse_Profile` | Zeasn.USB.HaiHui.Lib |
| PHL_CDeviceTAG4106 (500000) / TAG5106 (500001) | 25AA:6002 (000C/1) / 6003 (FF01/513) | USB | `TAGHeadsetDTS_Oper` → `CDevice_TAGHeadsetDTS` | `T_DTSHeadSetInfo_Profile` | HID + DTS APO (report 13) |

VID/PID and usage values come from `res/data/PCenter_DeviceInfo.json` (CONFIRMED). The user's other HID devices (unrelated third-party keyboard, mouse and audio devices) match **no** record, so none of these drivers would attach.

**Notifications emitted by Option.Lib.** Every one wraps its Tag in `NotificationDataBase{DeviceType,Data}`, except where noted:

| Function name | Emitters |
|---|---|
| `NotifyDeviceConnectionStatus` | peripheral bases |
| `NotifyMouseDPIChange` | Tag data is the anonymous `{Data: DPIData, ModelName}` |
| `NotifyButtonsChange`, `NotifyEffectChange` | peripherals, display |
| `NotifyLightEnableChange`, `NotifyOnboardChange`, `NotifyMacroKeyPressed`, `NotifyResetDevice`, `BatteryLowPowerReport`, `NotifyKeyboardGameModeChange` | RongYuan |
| `NotifyDevicePairResult` | Tag is a bool; `err_code` 1002001 on failure |
| `NotifyDeviceUpgradeFwProgress` | JiangMeng, HaiHui-8960, YongJiaXing |
| `DTSStateChange` | headset |
| `NotifyUIDisplayEffectChange`, `NotifyUIDisplayFuncConstraintsChange`, `NotifyEffectSyncDevicesChange`, `NotifyHotKeyExecute`, `FirmwareUpdateProgressData`, `NotifyAmbiScapeFollowVideoData` | display (§3) |

The full grep list with line numbers is reproducible with `grep -rn "FunctionName = Notification_Func" OPT`.

---

## 6. Data-driven vs code-driven (what can become static JSON)

| Item | Today | For the Linux port |
|---|---|---|
| Device dictionary (VID/PID, flags) | **data**: `res/data/PCenter_DeviceInfo.json` (`{"RECORDS":[…]}`, all values are strings; Newtonsoft coerces them and matches `Records` case-insensitively) | ship as-is; keep only the `100000` record if peripherals are dropped |
| Monitor capability flags (`SupUsbDDC/SupOTA/SupLightEffect/SupLightSync`, `HDR`) | **data (online-updated)**: `%APPDATA%/evnia/MonitorInfo.json` (Version 34, 143 monitors, identical to `work/app/MonitorInfo.json`); matched by regex `^((PHL )\|(PHL_)\|(PHL))?<Name>$` (case-insensitive, `ENT/Data_DisplayInfo.cs`) | ship the bundled copy read-only; drop the download |
| Ambiglow LED counts per model | **data**: `res/data/ENE/PCenter_AmbiglowInfo.json` (19 models; 34M2C8600 = R3 RU4 LU4 L3 C18 B14) | ship |
| Keyboard key maps | **data**: RongYuan/BeiYing JSONs | ship only if peripherals are supported |
| Monitor attribute tree, VCP bindings, module membership | code (`T_PHLDisplay_Profile`, `DisplayModule*`) | re-declare as a static schema (table §3.1) |
| Value enums (names, texts, values) | code (Entity.Lib enums + `[Description]`) | **export to static JSON** (Appendix C is complete) |
| Display effect menu and effect defaults | code | generate; exact JSON in Appendix D |
| Function-constraint rules | code | port the rules (§3.5) |
| Macro command menu | code, static | ship Appendix D.5 verbatim |
| Button function menus per peripheral | code + WinForms `Keys` | only if peripherals are kept; export once from a Windows run or re-derive |
| Setup menus, mouse menu | code | static JSON per device (§4.2) |
| Default key layouts | code tables | export if needed |
| Colour palette | code (`EffectColorData.DefData`, 13 colours) + user `Config/color.data` | ship default (Appendix D.6) |
| Capability-derived `ValueList`s, `Items`, `InputSourceList`, EQ bands | **runtime** from DDC capability string + reads | compute at runtime (report 07) |

---

## 7. Linux port plan (for this area)

1. **Serializer.** Implement three modes: `ui` (default), `uiProfileGet` (drop `IgnoreUI`) and `profile` (drop `IgnoreProfile` and nulls). Emit keys in the order given in Appendices A and B (fields first, derived before base). Emit enums as ints, dictionary keys as strings, tuples as `Item1..n`, and UTF-8 without `\u` escapes. For JS consumers order is cosmetic, but keeping it lets you diff against the Windows app and keeps `.pcenter` files interchangeable. Validate against `Default.pcenter` (Appendix D.3 already matches byte-for-byte).
2. **Types.** Port only the classes reachable from the monitor path:
   - `JsonResult`, `EnumItem`, `RGB`;
   - `AttributeInfo`, `T_PHLDisplay_Profile` and its modules, `DisplayFuncConstraints`, `FuncContraintItem`;
   - `DisplayEffectInfo/Menu`, `BaseEffect*`, `DispalyOtherInfo`, `DisplayEDIDInfo`, `ExternDispalyInfo`, `UIDisplayInfo`, `DisplayInputSourceInfo`, `GClass0` (EQ item);
   - `DeviceInfo`/`DictDeviceInfo`, `BasicInfo_Display`/`DataBasicInfo`, `T_Theme_Profile`, `T_Profile`, `T_Sync_Profile`, `SyncDeviceInfo`, `DataTheme`/`ThemeInfo`/`BindAppInfo`, `SoftConfigInfo`, `EffectColorData`, `NotificationDataBase`.

   Keep `ButtonMenuData`/`ButtonMenuItem`/`ExtEnumItem`/`SupportButtonFunc`/`MacroPlayType` only to serve `Macro_GetFuncMenu` statically.
3. **Enum names.** Use the real names from §2.6 and Appendix C. Never emit `const_N`.
4. **Monitor driver.** Re-implement `CDevice_PHLDisplay` over Linux DDC/CI (`/dev/i2c-*` via `ddcutil`/libddcutil, or USB-DDC; see report 07):
   - load sequence §3.3;
   - operations and sleeps §3.4;
   - constraints §3.5.

   Extended codes use `appCmd 0xE2, aCode 0xA0, sub = low byte`. Keep the quirks the renderer depends on:
   - the SmartImage tuple response;
   - `HasUSBSetting`;
   - EQ enumeration;
   - input byte-packing with the trailing `A4 = 0xFFFF` write;
   - the PIP default of 34/47;
   - the rewrite of Ambiglow mode 0 → 7.
5. **Resolution and refresh.** Replace `CWinSysDisplay` with DRM/XRandR/Wayland output info to fill `MonitorResolution` (`"3440x1440"`), `MonitorFrequency` (`"175Hz"`) and `MonitorOrientation` (`"0°"`, `"90°"`, …). Format EDID strings with the invariant culture (or deliberately mimic the Windows output; see open questions).
6. **Light effects.**
   - DDC Ambiglow path: keep it (pure VCP).
   - ENE path: implement `CUSBENE6K7732` over hidraw/libusb (report 09), detecting VID 0x0CF2 through udev instead of the Windows hub-list diff.
   - Screen-follow (`OnFollowVideo`, `AmbiScape`) needs a Linux capture back end (PipeWire/xdg-desktop-portal ScreenCast, or X11 `XShmGetImage`). Otherwise disable FollowVideo in the menu.
   - Audio-follow needs PipeWire/PulseAudio monitor capture.
7. **Fix or keep bugs** (decide consciously):
   - `NotifyUIDisplayEffectChange`: emit **both** `Item1..3` and `ENEEnable`/`EffectInfo`/`ModuleAmbiglow` keys. This is harmless and fixes the renderer.
   - `PHL_GetHotKeyMenu` → `[]`.
   - GamePQ/hotkey setters → `Succ()`.
   - Keep `err_code:0` for unread attributes. The UI relies on `IsAvailable` semantics.
8. **Drop:** FancyZones/SmartDesktop, TAG/DTS, all peripheral Opers (the user owns none), `WifiItem`, `DoubleClickSpeedData`/`ScrollSpeedData` (Win32 getters). If peripheral classes are kept for schema compatibility, return fixed defaults (double-click 500 ms, 3 lines).
9. **OTA:** stub `DisplayFW_GetDeviceList` to return `err_code:0` with a local-only `MonitorInformation` list (FW version from the DDC/USB scaler query), or an empty list. Make `DisplayFW_UpdateFirmversion` return an error, `Fail_FirmwareUpdate_CanNotFind` = 3758231562 cast to int. Do not ship any flashing path by default.
10. **Data files:** ship `PCenter_DeviceInfo.json` (display record), `PCenter_AmbiglowInfo.json`, and a frozen `MonitorInfo.json` (or only the 34M2C8600 entries) under `/usr/share/<app>/`. Read `MonitorInfo.json` from there instead of `$XDG_CONFIG_HOME`.
11. **Persistence:** keep the file formats (UTF-8 BOM, single-line JSON) under `$XDG_CONFIG_HOME/EvniaServe/{Theme,Config}` so that profiles copied from Windows load as-is.

---

## 8. Online touchpoints (in or adjacent to this scope)

This scope contains no HTTP code (grep for `http|WebClient|WebRequest|Socket` in both assemblies finds nothing but the `ButtonSubMenu_ProgramType.Url` enum member). The online features are driven by identifiers and files this code produces or consumes:

| # | What | Where | Trigger | Strip recommendation |
|---|---|---|---|---|
| 1 | OTA identifiers `DP_DeviceType`/`DP_ComponentID` (`ExternInfoBase`). Values: `"EVNIA_KB_<model>"`, `"EVNIA_MS_<model>"`, `"EVNIA_MT_<model>"` + `"_<VID>_<PID>[_<IDCode>]"`, `"EVNIA_DTS_<model>…"`, `"SmartDesktop"`/`"Philips_SmartDesktop"`, JiangMeng receiver ids | `CDevice_RongYuanKeyboard.cs:140`, `CDevice_RongYuanMouse.cs:142`, `CDevice_RongYuanMousePad.cs:87`, `CDevice_JiangMeng_Mouse.cs:65`, `CDevice_9618_*_Mouse.cs:52`, `CDevice_YongJiaXing_Mouse.cs:54`, `CDevice_TAGHeadsetDTS.cs:49`, `FancyZonesOper.cs:35` | The renderer sends them to the vendor update server (`styles-DAnQi2A8.js:33945`, `:34385`, `SmartDesktop-By8ZEPkl.js:70`, `Setup-daShw_PC.js:133`) | Omit, or leave empty; remove the renderer update checks (report 01/renderer) |
| 2 | Monitor firmware OTA: device enumeration and flashing of a downloaded .zip; ENE Ambiglow FW listed as an OTA target | `PHLDisplayFW.cs` (all) | `DisplayFW_GetDeviceList` is called at every start-up (logs) | Stub (§7.9) |
| 3 | `MonitorInfo.json` (capability flags + `EdidToFactory`/`FactoryModelNames`) | read by `DictMgr` (`PBASE/DictMgr.cs:14-27`) and `PHLDisplayFW.cs:468-512`; downloaded by Electron `verifyMonitorInfoJson` (deviceType `PhilipsMonitorsOTA`, componentId `PrecisionCenter_Monitors_OTA_JSON`, `work/app-pretty/main/index.js:13508-13545`) | app start | Ship the bundled copy; never download |
| 4 | Peripheral firmware upgrade (`Device_UpgradeFw` → `NotifyDeviceUpgradeFwProgress`) from a downloaded file | JiangMeng/HaiHui/YJX Opers | user action | Drop with the peripherals |
| 5 | `ButtonFunc.LaunchWebsite` (865) macro/button action opens a user URL | button/macro engine (Framework.Core) | user-configured | Harmless local action; optional |
| 6 | `WifiItem` (SSID/password DTO for `GetWifiList`) | `ENT/../Zeasn.PCenter.Entity.Lib.System/WifiItem.cs` | Bridge `GetWifiList` | Drop (report 13) |

---

## 9. Open questions

1. **Member order when a public field is declared after properties.** No in-scope class has this, so it never matters in practice. The fields-first rule is INFERRED from Newtonsoft internals and not observed.
2. **`DataOSD.GetResetSmartImageValue(v)` mapping** for `E2A042` (the `E2A0_42_ResetSmartImage_E` values 48..65) lives in Zeasn.DDC.Lib (report 07). Its exact table was not re-verified here.
3. **Which SmartImage enum (`SmartImage_E1..E4`) decorates the SDR `Items` for this model.** It depends on the DC selector 0xE2 (= `SmartImage_E2` 226) in the capability string, parsed by `DataOSD`. `Default.pcenter` was captured in HDR mode, so the SDR `Items` list and all SDR `CurSubSmartImage` values are unobserved. A second capture in SDR mode would confirm them.
4. **`MonitorResolution`/`MonitorFrequency`/`MonitorOrientation` string formats** for rotated or fractional-rate modes (e.g. "59Hz" vs "59.94Hz"). Only `"175Hz"` and `"0°"` were observed.
5. **ENE `GetLightColors` shape** (the Tag of `Effect_GetLEDs`) and the `TMain_ParameterSet` wire layout are in Zeasn.USB.ENE.Lib (report 09).
6. **Whether `DisplayFW_GetDeviceList` succeeds without a USB upstream cable.** The code returns `WrongUpstreamCable` (-536739836). The user's logs show the call but not the result.
7. **`KeyRecording` child list** depends on `System.Windows.Forms.Keys` and `KeyboardHIDScanCode_Extension.ToUsbKeys` (Zeasn.Win.Lib). It is irrelevant without peripherals.
8. **Culture-dependent EDID strings** (`"~34,2\""`, `"Rx0,689-Ry0,303"`). Does the renderer parse them? A grep of `app-pretty` for `MonitorEDIDInfo_T` finds 1 consumer, and it looks display-only (not verified).

---

## 10. Cross-references (outside this scope)

- **Report 05 (host/Bridge):**
  - `EvniaServe/Class0` dispatch and the `list_0` log suppression for `Effect_GetLEDs`/`Effect_CheckDynamicLightingEnabled`;
  - `HandleEvent` notification push;
  - `SystemOper` routing (`smethod_7/9/18/19` resolve devices by `DeviceType`);
  - `ThemeOper` (`.pcenter` and `DataTheme.cfg` handling);
  - `GlobalOper.ConfigData` (`SoftConfigInfo`);
  - `Config/data.json` signed cache (`HmacSha256`, key string `WhaleTV_Serizlize_2026`).
- **Report 07 (DDC):**
  - `DataOSD` (capability parse → `ValueList`s, `StandardList`/`E2A0_ExternList`, `GetTPVExternValue`/`SetTPVExternValue`, `PIPPBPEnable`, `GetResetSmartImageValue`, `s_DataDisplay.UIDisplayInfos/CurSN/CurDisplay`);
  - `NewDDCOper.SwitchGetCommandChecksum(true)` (set in the `CDevice_PHLDisplay` ctor :132);
  - `MonitorService.SetSetting("PHILIPS")` (:136).
- **Report 09 (ENE/Ambiglow):** `CUSBENE6K7732` (Plug, GetModelName, ParameterSet, ParameterVideoSync/AudioSync/LedSync, GetLightColors, USBCableLivingSwitch), `MNTLightEffect_E`, `Bright_E`, `Speed_E`, `Device_sel_E`, `ScreenCaptureMgr.CalcRGBs`, `ENELightStaticTable` (= `Zeasn.USB.ENE.Lib.GClass0`, reading `PCenter_AmbiglowInfo.json`).
- **Zeasn.Equipment.Base.Lib** (`CDeviceDisplayBase`: `GetMonitorHDR`, `SwitchDisplay`, `UpdateOTADevice`, `FnRecheckConnectionByUSB`; `CDeviceProfileBase.SaveProfile/PurifyProfile`; `CDeviceEffectBase` sync helpers): base-class behaviour used here but not specified.
- **Zeasn.Monitor.Lib** (`MonitorService` OTA, `ErrorCode`, `IMonitorDevice`/`IOTADevice`): the scaler firmware path behind `PHLDisplayFW`. Note its own `const_7 → PDControl` rename.
- **Report 13:** FancyZones (`Zeasn.FZ32.*`), DTS, Wi-Fi, hotkey manager (`InputEventManager`), `CWinSysInfo`/`CWinSysDisplay`.
- **Renderer:**
  - `NotifyUIDisplayEffectChange` consumer bug (`Monitor-D4qz4RBn.js:85-91`);
  - SmartImage tuple consumers (`SmartImage-DuKfuYFN.js:72,188`, `SmartImageHDR-BQ1gioFP.js:74,138`);
  - constraints consumer (`main-CDosWiM3.js:1834`).
- **USB peripheral libraries** (`Zeasn.USB.RongYuan/BeiYing/JiangMeng/YongJiaXing/HaiHui.Lib`, native `KBAccess_SPK8618.dll`, `Mouse_SPK9718.dll`, `Mouse_SPK9418/9618*.dll`): protocol details for the drivers inventoried in §5. `RongYuanSleepData` (`Zeasn.USB.RongYuan.Lib`) carries its own `[JsonIgnoreEx]` attributes.

---
