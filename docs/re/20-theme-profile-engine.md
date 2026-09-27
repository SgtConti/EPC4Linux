# 20 — Theme/profile engine, the `/profile` page and on-disk formats

## Summary

A **theme** ("App" in the UI) is a named group of **profiles**. Each profile is one file, `Theme/<Theme>/<Profile>.pcenter`, holding one opaque JSON string of settings per device model. A theme can be bound to up to 7 executables, and the foreground app then selects the theme. The index of all themes lives in `Theme/DataTheme.cfg`. The built-in theme is always called `User`, cannot be deleted, renamed or bound, and is **always** the startup theme. The first profile of any theme is called `Default`. The engine is `ThemeOper` (files and index) plus `SystemOper` (the in-memory current theme and profile, switching, saving). It is fully local. The only online parts are renderer-side cloud upload, download and "apply" UI (14 N29), and those can be dropped.

Key findings for the monitor-only Linux port:

1. **All files round-trip byte-identically through an order-preserving compact serializer.** The rule is UTF-8 BOM + `JSON.stringify` + no newline, with member order as listed in §3. I verified this on the user's `DataTheme.cfg`, `Default.pcenter` (including the nested `ProfileContent` string), `SoftConfig.data` and `data.json` (CONFIRMED, §3.1). The vendor reader parses **only the first line**, so multi-line (pretty-printed) files are rejected.
2. **The `data.json` signature is verified but not required.** A file with a bad signature is discarded. A plain unsigned JSON array ("old version") is accepted without any check (§3.8), so the signature adds no integrity.
3. **Switching profiles re-applies only the SmartImage/HDR picture group and Ambiglow.** On the user's monitor, which is in HDR, that is 3 DDC writes: `0x10`, `0x12`, `E2A019`. A SmartImage change adds a write to `0xDC` plus 1000 ms. GameMode, Input, Audio, System and Setup are **not** re-applied. Instead, the engine saves the monitor's cached state (possibly stale) **into the target profile** (§5.5, §6).
4. **`Theme_ResetCurProfile` ("Reset" on the Profile page) and `FactoryReset` both write VCP `0x04 = 1`** ("Restore Factory Defaults") to the monitor. Each then sleeps 5 s and re-reads everything. The UI texts do not say that the monitor itself is reset (§6, §7).
5. **No write is atomic** (truncate, then write in place). A torn `DataTheme.cfg` is silently replaced by a fresh default on the next start. The current `.pcenter` is rewritten after every setting change and after **every device scan** (§8).
6. **Windows-exported `.pcenter` files import unchanged on Linux.** The display section is matched by `DeviceType 100000` plus an **exact, case-sensitive** `ModelName` (`"PHL 34M2C8600"`). The Linux backend must therefore report the same EDID monitor name (§5.5, §10).
7. **The Linux app picker needs no bundle patch.** The new main process swaps the `["exe"]` file dialog for a `.desktop` chooser and sets `runConfig.processPath` to the port's own `.desktop` file. The backend then treats a `.desktop` path as an app-id binding (§10.2).

Corrections to reports 03, 05, 12, 13, 14 and 02 are in §12.

---

## 0. Sources, abbreviations, evidence

- **CONFIRMED** means read in code, or seen in the user's files and logs. **INFERRED** means reasoned from code, framework semantics or naming, but not observed at runtime.
- Source abbreviations (all under the repository root):

  | Abbrev. | Path |
  |---|---|
  | `TO` | `work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/ThemeOper.cs` |
  | `GO` | `work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/GlobalOper.cs` |
  | `CV` | `work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/CacheVcpMgr.cs` |
  | `SO` | `work/dotnet-clean/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/SystemOper.cs` |
  | `SFU` | `work/dotnet-clean/Zeasn.Com.Lib/Zeasn.Com.Lib/SerializedFileUtil.cs` |
  | `COM/` | `work/dotnet-clean/Zeasn.Com.Lib/Zeasn.Com.Lib/` |
  | `EN/` | `work/dotnet-clean/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/` |
  | `G0`, `G3` | `work/dotnet-clean/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/GClass0.cs` ("CDeviceProfileBase"), `GClass3.cs` ("CDeviceDisplayBase") |
  | `PHL`, `PHLO` | `work/dotnet-clean/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/CDevice_PHLDisplay.cs`, `PHLDisplay_Oper.cs` |
  | `OPT/` | `work/dotnet-clean/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/` |
  | `CL0` | `work/dotnet-clean/EvniaServe/Class0.cs` (dispatcher) |
  | `HE` | `work/dotnet-clean/EvniaServe/Evnia/HandleEvent.cs` |
  | `BR` | `work/dotnet-clean/Bridge.Lib/Bridge.Lib/Bridge.cs` |
  | `ST`, `MN` | `work/app-pretty/renderer/assets/styles-DAnQi2A8.js`, `main-CDosWiM3.js` |
  | `EM` | `work/app-pretty/main/index.js` |
  | `CFG/`, `LOG/` | `%APPDATA%/EvniaServe/`, `%APPDATA%/EvniaServe/logs/` |

- Ground truth:
  - `CFG/Theme/DataTheme.cfg` (156 B), `CFG/Theme/User/Default.pcenter` (12 401 B), `CFG/Config/SoftConfig.data` (68 B) and `CFG/Config/data.json` (1 411 B). All four start with `EF BB BF` and contain 0 CR/LF.
  - The directory holds **no** `color.data`, `Cache/`, `Icon/`, `Macro/` or `BoardInfo/`.
  - Birth times: `Theme/` 2026-07-14 21:08:59.8, `Config/SoftConfig.data` 21:09:21.8, `data.json` 2026-09-26 07:52:41.
- Log versions (CONFIRMED, `%APPDATA%/evnia/logs/26-09-2x.log`): `LOG/2026-09-25.txt` comes from app **1.11.0**, and `LOG/2026-09-26.txt` from **1.13.0**. The two builds log differently: only 1.11.0 prints the `ThemeSaveCurProfiles` markers.

---

## 1. Object model and in-memory state

| Object | Where | Meaning |
|---|---|---|
| `ThemeOper.dataTheme_0 : DataTheme` | `TO:14-18` | The parsed `DataTheme.cfg`. The path is `Path.Combine(ThemeRootDir,"DataTheme.cfg")`. Loaded once in `Init()` when the file exists (`TO:20-26`) |
| `SystemOper.themeInfo_0 : ThemeInfo` | `SO:79` | The **current theme**, a reference into `dataTheme_0.ThemeInfos` |
| `SystemOper.t_Theme_Profile_0 : T_Theme_Profile` | `SO:81` | The **current profile** in memory. Devices write into it, and `ThemeSaveCurProfiles` persists it |
| `IProfile.CurThemeInfo / CurThemeProfile` | `G0:26-52` | Per-driver references, set during the scan (`SO:846-878`), switch (`SO:3100-3101`) and factory reset (`SO:286-287`) |
| `CDevice_PHLDisplay.CacheDeviceData` | `PHL:55` | The last full read from the monitor (`method_4`). A theme switch applies **onto this object**, not onto `DeviceData` (§5.5) |
| `GClass0.DeviceData` | `G0:77-89` | The live display state, returned by `Profile_GetDeviceData`. `PurifyProfile()` serializes it into the profile (`G0:168-171`) |

The theme model (CONFIRMED):
- Theme names are compared **case-insensitively** (`EN/DataTheme.cs:60-64`, `OrdinalIgnoreCase`).
- Profile names are compared **case-sensitively** (`EN/ThemeInfo.cs:147-150`, `List.Contains`). The exceptions are `Theme_Switch`'s "same profile" shortcut and `Theme_DelProfile`'s "current profile" guard, which ignore case (`SO:3033`, `SO:3246`).
- `DataTheme.UserThemeInfo` looks up the name `"User"` with **case-sensitive** `Equals` (`EN/DataTheme.cs:28`).

---

## 2. File layout (Windows, as the code builds it)

```
%APPDATA%\EvniaServe\                       PathBase.PATH_APP_DATA = ApplicationData + AppDomain.FriendlyName ("EvniaServe")  [COM/PathBase.cs:10-16]
├─ Theme\                                   WorkspacePath.ThemeRootDir                                  [EN/WorkspacePath.cs:30]
│  ├─ DataTheme.cfg                         theme index                                                   [TO:14]
│  ├─ User\                                 GetThemeProfileDir(name) = Theme\<name>                      [EN/WorkspacePath.cs:55-58]
│  │  ├─ Default.pcenter                    GetProfilePath = Theme\<theme>\<profile>.pcenter             [EN/WorkspacePath.cs:60-63]
│  │  ├─ Macro\<name>.macro                 GetMacroFilePath (peripheral macros)                         [EN/WorkspacePath.cs:40-48]
│  │  └─ Icon\<sha1(appPath)[0..10]>.png    bound-app icons (never for "User": it cannot bind)          [TO:194]
│  └─ <Theme N>\ …                          same structure
├─ Config\                                  WorkspacePath.ConfigDir                                       [EN/WorkspacePath.cs:32]
│  ├─ SoftConfig.data                       idle-lights settings                                          [EN/WorkspacePath.cs:34]
│  ├─ color.data                            Ambiglow custom colours (created only by Effect_SetSelfColors) [EN/WorkspacePath.cs:36]
│  ├─ BoardInfo\<DeviceType enum NAME>.data peripherals only (device.ToString())                          [EN/WorkspacePath.cs:65-68]
│  └─ data.json   (code spells "config")    signed VCP capability cache                                   [CV:17]
├─ Cache\Theme\, Cache\Macro\               cloud-merge scratch (Theme_SyncProfileDesc: not in Bridge → dead) [EN/WorkspacePath.cs:26-28, TO:605]
└─ logs\                                    NLog; spared by FactoryReset                                  [COM/PathBase.cs:28, SO:272]
%TEMP%\EvniaServe\<unix-seconds>.png        Comm_GenAppIcon output (PathBase.PATH_APP_TEMP)               [COM/PathBase.cs:31, GO:134-146]
```
All paths: CONFIRMED.

---

## 3. On-disk formats (deliverable a)

### 3.1 Common writer and reader rules (CONFIRMED unless marked)

**Writer** (`SFU:101-132` `SaveTXTConfig` → `SFU:282-309` `SaveTxtData`):
1. `obj.JsonSerialize()` uses Newtonsoft 13 with default settings plus `ReferenceLoopHandling.Ignore` (`COM/Extension_Json.cs:37-60`). **Nulls are written.** `[JsonIgnoreEx]` is ignored. Members are ordered fields first, then properties, most-derived class first (12 §2.2).
2. The text is `Trim()`med (`SFU:114`). It is refused if re-deserializing it yields null (`SFU:115`) or if it contains `"\r\n"` (`SFU:120`). A lone `\n` is not checked, but JSON escaping makes both impossible.
3. `SaveTxtData` creates the directory and file if missing (`COM/Extension_IO.cs:59-66`). It then opens `new StreamWriter(path, append:false, UTF8Encoding(BOM:true))` (`SFU:293`), which truncates the file, writes BOM + text with no trailing newline, flushes and closes. No temp file, no rename, no fsync.
4. **Nested device content** (`T_Profile.ProfileContent`) is produced separately by `PurifyProfile()` = `JsonSerialize(IgnoreProfile, bIgnoreNullValue:true)`. That drops members tagged `[JsonIgnoreEx(IgnoreProfile)]` and all nulls (`G0:168-171`, 12 §2.1). The wrapper then stores it as a JSON string, so it is escaped once more.

**Reader** (`SFU:134-164` `LoadTXTConfig`):
1. Opens with `FileShare.ReadWrite` and a `StreamReader(UTF8Encoding)`, which detects and strips a BOM (`SFU:142`).
2. Reads all lines but deserializes **only line 1** (`SFU:144-157`). A pretty-printed or multi-line file gives `null` ("load error").
3. An empty file gives `null`. Invalid JSON gives `null`, because the exception is swallowed (`COM/Extension_Json.cs:89-127`).
4. `JsonConvert.DeserializeObject<T>` with `NullValueHandling.Ignore` (`COM/Extension_Json.cs:116-119`). From Newtonsoft defaults (INFERRED):
   - unknown members are ignored;
   - member names match case-insensitively;
   - a JSON `null` leaves the C# field initializer in place;
   - read-only collections (`T_Theme_Profile.Profiles`) are populated in place;
   - integers are accepted for enums (names are also accepted).

**Byte compatibility check** (CONFIRMED by script in this session): re-serializing each of the four ground-truth files and both nested strings (`ProfileContent`, `data`) with an order-preserving compact serializer gives byte-identical output. The serializer used was Python `json.dumps(separators=(',',':'), ensure_ascii=False)`, which matches `JSON.stringify` here. Non-ASCII is written raw (`°`, `光影同步`).

Newtonsoft always escapes U+0085, U+2028 and U+2029 as `\u0085`, `\u2028` and `\u2029`. `JSON.stringify` does not (INFERRED from Newtonsoft `JavaScriptUtils`). None of these characters occurs in names, so a Node writer only needs that one replacement to be exact.

### 3.2 `Theme/DataTheme.cfg`

Classes: `DataTheme : T_Profile_Base { List<ThemeInfo> ThemeInfos }` (`EN/DataTheme.cs:8-25`; `UserThemeInfo` is `[JsonIgnore]`, `:27-28`). `ThemeInfo` (`EN/ThemeInfo.cs:11-212`; `ProfileDir`, `BindAppInfo`, `IsBind` and `SelProfilePath` are `[JsonIgnore]`, `:101-145`). `BindAppInfo` (`EN/BindAppInfo.cs:5-39`).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "evnia/DataTheme.cfg",
  "title": "EvniaServe theme index (UTF-8 BOM, one line, member order as listed)",
  "type": "object",
  "properties": {
    "ThemeInfos": { "type": ["array", "null"], "items": { "$ref": "#/$defs/ThemeInfo" } }
  },
  "$defs": {
    "ThemeInfo": {
      "type": "object",
      "properties": {
        "Name":              { "type": ["string", "null"], "description": "Directory name under Theme/. Unique case-insensitively. Built-in = \"User\" (case-sensitive lookup)." },
        "IsDefault":         { "type": "boolean", "default": false, "description": "true only for User; blocks Del/Rename/UpdateBindApp" },
        "SelProfileName":    { "type": ["string", "null"], "default": "Default", "description": "Last selected profile of this theme (per-theme memory)" },
        "ProfileNames":      { "type": ["array", "null"], "items": { "type": "string" }, "description": "Display order; ≥1 after Check()" },
        "CycleProfileNames": { "type": ["array", "null"], "items": { "type": "string" }, "description": "Subset used by peripheral profile-cycle buttons, ordered like ProfileNames" },
        "BindAppInfos":      { "type": ["array", "null"], "items": { "$ref": "#/$defs/BindAppInfo" }, "maxItems": 7 }
      }
    },
    "BindAppInfo": {
      "type": "object",
      "properties": {
        "BindAppFilePath": { "type": ["string", "null"], "description": "Absolute exe path, compared OrdinalIgnoreCase by CheckTopApp" },
        "BindAppIconPath": { "type": ["string", "null"], "default": "", "description": "Absolute path of Theme/<T>/Icon/<sha10>.png or \"\"" }
      }
    }
  }
}
```
`maxItems: 7` is enforced only by the renderer (`ST:42533`, `ST:42747`). The backend has no limit (CONFIRMED).

Annotated example (the file on disk is one line):
```jsonc
{"ThemeInfos":[
  {"Name":"User","IsDefault":true,            // built-in, always index 0 when (re)created (EN/DataTheme.cs:30-52)
   "SelProfileName":"Default",
   "ProfileNames":["Default"],
   "CycleProfileNames":["Default"],
   "BindAppInfos":[]},                         // User can never be bound (TO:138, UI hides the button ST:42995)
  {"Name":"New Application","IsDefault":false, // UI default name "New Application[ N]" (ST:42527-42529)
   "SelProfileName":"Default","ProfileNames":["Default","Default 1"],"CycleProfileNames":["Default","Default 1"],
   "BindAppInfos":[{"BindAppFilePath":"C:\\Windows\\notepad.exe",
                    "BindAppIconPath":"C:\\Users\\u\\AppData\\Roaming\\EvniaServe\\Theme\\New Application\\Icon\\6ee69b7475.png"}]}
]}
```
The first entry equals the user's real file byte for byte (153 JSON bytes + BOM = 156, CONFIRMED). The second entry is illustrative. Its icon name is `sha1("C:\Windows\notepad.exe")[0..10]`, computed in this session.

### 3.3 `Theme/<Theme>/<Profile>.pcenter` (also the import/export format)

Classes (all CONFIRMED):
- `T_Theme_Profile { T_Sync_Profile Sync_Profile (default null); List<T_Profile> Profiles (get-only, initialised) }` (`EN/T_Theme_Profile.cs:11-33`).
- `T_Profile { T_DeviceProfile_Base ProfileDesc; string ProfileContent }` (`EN/T_Profile.cs:7-41`).
- `T_DeviceProfile_Base { EquipmentType, DeviceType, ModelName, ExtModel }` (`EN/T_DeviceProfile_Base.cs:19-73`).
- `T_Sync_Profile { BaseEffectDetailInfo EffectDetailInfo (default null); List<SyncDeviceInfo> SyncDevices (default []) }` (`EN/T_Sync_Profile.cs:8-42`).
- `SyncDeviceInfo : T_DeviceProfile_Base { SyncStatus, Connect }` (`EN/SyncDeviceInfo.cs:5-39`). Own members are written first.
- `BaseEffectDetailInfo` defaults (`EN/BaseEffectDetailInfo.cs:9-36`): `Effect = Off{Name:"Off",Text:"关闭",Value:0}`, `Speed 2`, `Brightness 2`, `IsRandomColor false`, `IsRainbowColor false`, `CurRGB {255,0,0}`, `BgRGB {0,0,0}`, `CurDir -1`, `CurRegion 0`, `CurStarCount 1`.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "evnia/profile.pcenter",
  "title": "EvniaServe profile (UTF-8 BOM, one line). Also the exact export/import format.",
  "type": "object",
  "properties": {
    "Sync_Profile": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/T_Sync_Profile" } ] },
    "Profiles":     { "type": "array", "items": { "$ref": "#/$defs/T_Profile" },
                      "description": "Import/Export/GetProfileDesc reject an empty or missing list with err 10" }
  },
  "$defs": {
    "T_Profile": {
      "type": "object",
      "properties": {
        "ProfileDesc":    { "$ref": "#/$defs/T_DeviceProfile_Base" },
        "ProfileContent": { "type": ["string", "null"], "contentMediaType": "application/json",
                            "contentSchema": { "$ref": "#/$defs/DisplayContent" },
                            "description": "PurifyProfile(): JsonIgnoreEx(IgnoreProfile) members and all nulls removed" }
      }
    },
    "T_DeviceProfile_Base": {
      "type": "object",
      "properties": {
        "EquipmentType": { "type": "integer", "description": "1 = Display" },
        "DeviceType":    { "type": "integer", "description": "100000 = PHL_CDeviceDisplay; lookup key #1 (exact)" },
        "ModelName":     { "type": ["string", "null"], "description": "EDID monitor name, e.g. \"PHL 34M2C8600\"; lookup key #2 (ordinal ==, case-sensitive)" },
        "ExtModel":      { "type": ["string", "null"], "description": "DeviceInfo.ExtModel; \"\" for the display" }
      }
    },
    "T_Sync_Profile": {
      "type": "object",
      "properties": {
        "EffectDetailInfo": { "oneOf": [ { "type": "null" }, { "$ref": "#/$defs/BaseEffectDetailInfo" } ] },
        "SyncDevices":      { "type": ["array", "null"], "items": { "$ref": "#/$defs/SyncDeviceInfo" } }
      }
    },
    "SyncDeviceInfo": {
      "type": "object",
      "properties": {
        "SyncStatus": { "type": "boolean" }, "Connect": { "type": "boolean" },
        "EquipmentType": { "type": "integer" }, "DeviceType": { "type": "integer" },
        "ModelName": { "type": ["string", "null"] }, "ExtModel": { "type": ["string", "null"] }
      }
    },
    "BaseEffectDetailInfo": {
      "type": "object",
      "properties": {
        "Effect": { "$ref": "#/$defs/EnumItem" }, "Speed": { "type": "integer" }, "Brightness": { "type": "integer" },
        "IsRandomColor": { "type": "boolean" }, "IsRainbowColor": { "type": "boolean" },
        "CurRGB": { "$ref": "#/$defs/RGB" }, "BgRGB": { "$ref": "#/$defs/RGB" },
        "CurDir": { "type": "integer" }, "CurRegion": { "type": "integer" }, "CurStarCount": { "type": "integer" }
      }
    },
    "EnumItem": { "type": "object", "properties": { "Name": { "type": ["string", "null"] }, "Text": { "type": ["string", "null"] }, "Value": { "type": "integer" } } },
    "RGB": { "type": "object", "properties": { "R": { "type": "integer", "minimum": 0, "maximum": 255 }, "G": { "type": "integer", "minimum": 0, "maximum": 255 }, "B": { "type": "integer", "minimum": 0, "maximum": 255 } } },
    "DisplayContent": {
      "type": "object",
      "description": "T_PHLDisplay_Profile, full member list and order in 12 §3; members below are the lookup-relevant ones",
      "properties": { "IsSmartImageHDR": { "type": "boolean" }, "EquipmentType": { "const": 1 }, "DeviceType": { "const": 100000 }, "ModelName": { "type": "string" } }
    }
  }
}
```

There are **no other wrapper fields**: no version, checksum, theme name or profile name. The profile name is the file name (CONFIRMED, `EN/T_Theme_Profile.cs`, `EN/WorkspacePath.cs:60-63`).

The user's file, abbreviated (CONFIRMED structure):
```jsonc
{"Sync_Profile":{"EffectDetailInfo":null,"SyncDevices":[]},   // either this or "Sync_Profile":null (fresh file, §4); both must load
 "Profiles":[
  {"ProfileDesc":{"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":""},
   "ProfileContent":"{\"IsSmartImageHDR\":true,\"OP_DC_DisplayApplication\":{\"VCPOpCode\":220,\"Value\":33,\"err_code\":0},
      \"ModuleSmartImage\":{…},\"ModuleSmartImageHDR\":{…},\"ModuleGameMode\":{…},\"ModuleAmbiglow\":{…,\"EffectEnable\":false},
      \"ModuleInput\":{…},\"ModuleAudio\":{…},\"ModuleSystem\":{…},\"ModuleSetup\":{…},\"ENEEffectEnable\":false,
      \"EffectInfo\":{\"EffectList\":[…7 effects…],\"EffectDetail\":{…},\"EffectEnable\":true,\"CurrEffect\":{\"Name\":\"FollowVideo\",…}},
      \"DispalyData\":{…\"MonitorResolution\":\"3440x1440\",\"MonitorFrequency\":\"175Hz\",\"MonitorOrientation\":\"0°\"},
      \"EquipmentType\":1,\"DeviceType\":100000,\"ModelName\":\"PHL 34M2C8600\"}"}]}   // content: 10 737 chars; no ExtModel (null dropped)
```
- Sub-device types (types that carry `MainDeviceTypeAttribute`) are folded into the main type on save and lookup (`EN/T_Theme_Profile.cs:96-115`).
- The display has no such attribute, so its key is `(100000, ModelName)`.
- One profile can hold content for several monitor models side by side (INFERRED from `SaveProfileContent` `:65-94`).

The `"Sync_Profile":{"EffectDetailInfo":null,"SyncDevices":[]}` form is created only by `SyncEffect_EnableDevice` (`SO:1537-1540`). It creates `new T_Sync_Profile()` without `Check()` in the current profile before anything can fail (INFERRED origin; the file dates from 2026-07-14). The renderer never needs this block for a single monitor. A port must preserve it verbatim.

### 3.4 Bound-app icon files

- The name is `Theme/<ThemeName>/Icon/<first 10 lowercase hex chars of SHA1(UTF-8(BindAppFilePath))>.png` (`TO:194`, `COM/SHA1Util.cs:10-37`). The path is hashed exactly as the renderer sent it, case preserved.
- Examples computed in this session:

  | `BindAppFilePath` | Icon name |
  |---|---|
  | `C:\Windows\notepad.exe` | `6ee69b7475` |
  | `/usr/share/applications/firefox.desktop` | `53127c7233` |

- An icon is **moved** there only when `BindAppIconPath` contains `%TEMP%\EvniaServe` (case-insensitive). Otherwise the given path is kept. If the file does not exist afterwards, the path becomes `""` (`TO:190-206`).
- If the move fails, the stored path is `""`.
- Icons of apps removed from the list are deleted (`TO:183-189`).
- `Comm_GenAppIcon` writes `%TEMP%\EvniaServe\<ToTimestamp()>.png`. `ToTimestamp()` is whole seconds since 1970 in "China Standard Time" (`COM/Extension_DateTime.cs:42-46`), so two icons generated in the same second overwrite each other (INFERRED). Unbound temp icons are never deleted (INFERRED).

### 3.5 Macro files and folders (needed only for `Macro_GetList` at startup)

- The folder is `Theme/<Theme>/Macro/` (`EN/WorkspacePath.cs:40-48`) and files are `<MacroName>.macro`. The folder is created lazily by the first write. It does not exist on the user's machine.
- `Macro_GetList` returns file names without extension, **sorted by file creation time** (`SO:1972-2010`, `COM/DirectroyUtil.cs:153-170`, `COM/FileComparer.cs`).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "evnia/macro",
  "type": "object",
  "properties": {
    "Name":         { "type": "string", "default": "", "description": "Not updated on rename/import (file name is authoritative)" },
    "MacroContent": { "type": "array", "items": { "$ref": "#/$defs/MacroDetail" } },
    "IsComMacro":   { "type": "boolean", "description": "Computed on write (no Text/RunCommand step); ignored on read" }
  },
  "$defs": {
    "MacroDetail": {
      "type": "object",
      "properties": {
        "MacroTag": { "type": ["string", "null"] },
        "MacroType": { "type": "integer", "enum": [0, 1, 2, 3, 4], "description": "0 Null, 1 KeyBoard, 2 Mouse, 3 Text, 4 RunCommand" },
        "MacroTypeName": { "type": "string", "description": "computed MacroType.ToString()" },
        "MacroAction": { "type": "integer", "enum": [0, 1, 2], "description": "0 Null, 1 Down, 2 Up" },
        "MacroActionName": { "type": "string", "description": "computed" },
        "DelayTime": { "type": "integer" },
        "MacroValue": { "type": "string", "default": "" },
        "Extra": { "type": "string", "default": "" }
      }
    }
  }
}
```
Sources (CONFIRMED): `EN/MacroInfo.cs:16-44`, `EN/MacroDetail.cs:25-99`, `EN/MacroType.cs`, `EN/MacroAction.cs`. A new macro is written as `{"Name":"<n>","MacroContent":[],"IsComMacro":true}` (`SO:2060-2063`). The Tag list item is `MacroAttributeInfo {MacroName, IsComMacro}` (`EN/MacroAttributeInfo.cs:13-27`).

### 3.6 `Config/SoftConfig.data`

```json
{ "$id": "evnia/SoftConfig.data", "type": "object",
  "properties": {
    "TurnOffLightsWhenIdle":         { "type": "boolean", "default": false },
    "TurnOffLightsWhenIdleDuration": { "type": "integer", "default": 5, "description": "minutes; API rejects < 1 ('at last 1 minutes', err 9, BR:37-44); file not validated" } } }
```
- User's file: `{"TurnOffLightsWhenIdle":false,"TurnOffLightsWhenIdleDuration":5}` (CONFIRMED).
- Loaded lazily by the `GlobalOper` singleton. If the file is missing or unparsable, defaults are used and written immediately (`GO:77-94`).
- Saved only when a setter changes the value (`GO:23-53`).
- Tag of `Setting_GlobalData` = this object (`BR:23-26`).

### 3.7 `Config/color.data`

```json
{ "$id": "evnia/color.data", "type": "object",
  "properties": {
    "DefColors":  { "type": "array", "items": { "type": "object", "properties": { "R": {"type":"integer"}, "G": {"type":"integer"}, "B": {"type":"integer"} } } },
    "SelfColors": { "type": "string", "default": "", "description": "renderer CSV \"#rrggbb,#rrggbb,…\" (≤14, 03 §4.5), stored verbatim" } } }
```
- `DefColors` is a public **field**, so it is written first. `SelfColors` is a property (`EN/EffectColorData.cs:9-26`).
- The file is created only by `Effect_SetSelfColors`, which loads the file or `DefData()`, sets `SelfColors` and saves (`SO:1365-1383`). `Effect_GetColorData` returns the parsed file, else `DefData()` (`SO:1351-1363`).
- Example: `{"DefColors":[{"R":255,"G":255,"B":255},{"R":255,"G":0,"B":0},{"R":255,"G":0,"B":127},{"R":127,"G":0,"B":127},{"R":127,"G":0,"B":255},{"R":0,"G":0,"B":255},{"R":0,"G":127,"B":255},{"R":0,"G":255,"B":255},{"R":0,"G":255,"B":127},{"R":0,"G":255,"B":0},{"R":127,"G":255,"B":0},{"R":255,"G":255,"B":0},{"R":255,"G":127,"B":0}],"SelfColors":"#12ab34"}` (defaults from `EN/EffectColorData.cs:28-49`; the `SelfColors` value is illustrative).

### 3.8 `Config/data.json` (VCP capability cache)

The code path is `Path.Combine(PATH_APP_DATA,"config","data.json")`, with a **lower-case** `config` (`CV:17`). On Windows it lands in the existing `Config` folder.

```json
{ "$id": "evnia/data.json", "type": "object", "required": ["data", "sign"],
  "properties": {
    "data": { "type": "string", "contentMediaType": "application/json", "contentSchema": { "$ref": "#/$defs/CacheList" } },
    "sign": { "type": "string", "description": "base64(HMAC-SHA256(key=UTF-8 'WhaleTV_Serizlize_2026', msg=UTF-8(data)))" } },
  "$defs": {
    "CacheList": { "type": "array", "items": { "type": "object", "properties": {
      "Name":  { "type": "string", "description": "EDID monitor name (\"PHL 34M2C8600\")" },
      "Datas": { "type": "array", "items": { "type": "object", "properties": {
        "Key": { "type": "string", "description": "lower(\"<FW version>_<VCP60 low byte %02X>\"), e.g. v1.01_0f (06 §4.8)" },
        "Vcp": { "type": "string", "description": "raw MCCS capabilities string" } } } } } } } } }
```
- Writer (`SFU:166-207`): the inner text is `JsonSerialize()` of `List<CacheDisplayInfo>`, trimmed. It must re-deserialize and contain neither `\r\n` nor `\n`. The file is then `JsonConvert.SerializeObject(new {data, sign})` (anonymous-type order `data`, `sign`), written with a BOM.
- The user's signature verifies, both with the stated formula and in Python in this session (`Tsp5rMqtwjyGNk+TolTxhiSrLJlvsF4d3085ZOkUyfo=`, CONFIRMED).

**Exact load rules** (`SFU:209-254`, `COM/HmacSha1Util.cs:36-49` in file order, CONFIRMED):

| # | Condition | Result |
|---|---|---|
| 1 | File missing | `null` → empty cache (`CV:18`) |
| 2 | Text (BOM stripped by `ReadAllText`) is empty or whitespace | `null` |
| 3 | `DeserializeObject<SignedData>` throws, e.g. because the root is an array (the legacy format) | **treated as unsigned legacy**: `JsonDeserialize<List<…>>(whole text)` is used **without any check** (log `old version config, no signature, skip verification`) |
| 4 | Root is an object but `data` or `sign` is missing, null or whitespace | same legacy path. Deserializing an object as a list fails, so the result is `null` |
| 5 | `sign` is not valid base64, or the HMAC is computed over something else (e.g. re-escaped `data`) or has the wrong length (`FixedTimeEquals` returns false on length mismatch) | **rejected**: log `signature check failed! File may be tampered.`, result `null` |
| 6 | Signature OK but `data` is not a valid list JSON | `null` (exception swallowed) |
| 7 | Any other exception | `null` |

- A `null` result makes the cache empty. The capability string is then re-read from the monitor (about 6.8 s, 06 §0) and the file is rewritten on that save.
- `Device_Rescan` clears the cache and writes `{"data":"[]","sign":…}` (`CV:75-82`, `SO:228-233`).
- **Consequence:** because rule 3 accepts unsigned arrays, the signature provides no integrity. A port may verify it for compatibility and ignore failures.

---

## 4. Start-up and first-run path (deliverable c)

`Start` → `InitEnviroment(reset:false)` (`SO:107-133`):

1. **`ThemeOper` singleton construction.** It loads `DataTheme.cfg` if it exists (`TO:20-26`).
2. **`ThemeInit(false)`** (`TO:28-39`):
   - If a file was loaded, it runs `DataTheme.Check()` and returns **without saving** (`TO:30-34`). `Check()` does three things:
     - it inserts a `User` theme at index 0 if no theme is named exactly `User` (`EN/DataTheme.cs:42-52`);
     - `ThemeInfo.Check()` runs for every theme: an empty `ProfileNames` becomes `["Default"]` with `SelProfileName = "Default"`, and `"Default"` is added to `CycleProfileNames` (`EN/ThemeInfo.cs:184-198`);
     - every `Theme/<Name>/` directory is created (`:199-209`).
   - If no file exists, or it is unparsable (→ null), it builds a new `DataTheme`: `InitDefData()` gives `[{Name:"User", IsDefault:true}]` (`EN/DataTheme.cs:30-40`), then `Check()`, then **saves**.
   - Result on first run: `DataTheme.cfg` = `{"ThemeInfos":[{"Name":"User","IsDefault":true,"SelProfileName":"Default","ProfileNames":["Default"],"CycleProfileNames":["Default"],"BindAppInfos":[]}]}`, identical to the user's file (CONFIRMED).
3. **Current theme.** `themeInfo_0 = UserThemeInfo`, always `User`, whatever theme was active before (`SO:130`).
4. **Current profile.** `t_Theme_Profile_0 = themeInfo_0.LoadCurProfile()` (`EN/ThemeInfo.cs:152-167`). If `Theme/User/Default.pcenter` is missing or unparsable, a `new T_Theme_Profile()` goes through `InitDefData()` and is **saved**: `{"Sync_Profile":null,"Profiles":[]}` (CONFIRMED by code; not observed, since the user's file predates the logs).
5. **Device scan.** For the display, `ConnectionCkecked` → `OnConnect` → `InitDevice` → `InitDisplayData` → `method_4` (full VCP read into `CacheDeviceData`) → `DeviceDataCheck` (`CDeviceBase.OnConnect`, `work/dotnet-clean/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/CDeviceBase.cs:83-92`; `G3:143-188`, `G3:234-250`). In detail:
   - `GetProfileContent(100000, "PHL 34M2C8600")` returns `""`, so `DeviceData = GetDefaultData()`.
   - For the display, `GetDefaultData()` returns **`CacheDeviceData` itself** after setting `EffectInfo = new DisplayEffectInfo()` when no ENE controller was found. With ENE it sets `DisplayEffectInfo.Default(model)` instead (`PHL:248-264`).
   - Then `ParameterToDevice(DeviceData)` with **`bForce:false`** (`G3:244`). This does **no VCP writes** for a non-ENE monitor and copies `EffectInfo` (`PHL:693-698`), then calls `SaveProfile()`.
   - **Default display `EffectInfo` on first run (CONFIRMED by code): not null.** `new DisplayEffectInfo()` serializes in `ProfileContent` as
     `{"EffectDetail":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":2,"Brightness":2,"IsRandomColor":false,"IsRainbowColor":false,"CurRGB":{"R":255,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"EffectEnable":true,"CurrEffect":{"Value":0}}`
     - `EffectList` is null and dropped. `EffectDetail` falls back to `new DisplayEffectDetailInfo()` because `EffectList.ToList()` is the null-safe `COM/Extension.cs:29-47` (`OPT/DisplayEffectInfo.cs:27,44-47`; `EN/BaseEffectInfo.cs` defaults `EffectEnable=true`, `CurrEffect=new EnumItem()`).
     - Over the hub (`Profile_GetDeviceData`, nulls kept) the renderer receives `"EffectList":null,…,"CurrEffect":{"Name":null,"Text":null,"Value":0}`. `saveMonitorData` handles this (`ST:9429-9437` uses `EffectList?.map` and `CurrEffect.Value`).
6. **Profile content first written.** The `SaveProfile` of step 5 runs **before** the display joins `EquipmentDic` (`SO:846-878`). So the first `ThemeSaveCurProfiles` finds no connected device and rewrites the empty profile. The display content is first written by the `ThemeSaveCurProfiles` at the end of `OnSyncEffect` (`SO:1762`), which is triggered by `SendEvent(Effect_Sync)` after every scan (`SO:212`).
   - This two-save pattern is CONFIRMED on a normal start in the 1.11 log. `LOG/2026-09-25.txt:747-755` shows `ThemeSaveCurProfiles 36` with no device listed, followed by `ThemeSaveCurProfiles 35 … ConnectionDevice PHL_CDeviceDisplay`.
   - Resulting first-run `Default.pcenter`: `{"Sync_Profile":null,"Profiles":[{"ProfileDesc":{"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":""},"ProfileContent":"<live readout, EffectInfo as above>"}]}` (INFERRED composition from the CONFIRMED steps).
7. **`SoftConfig.data`** is created when `GlobalOper` is first touched. That happens at the first `CheckIdle`, once the scan has finished (`SO:304-314`), or at `Setting_GlobalData`. The birth-time gap of 22 s after `Theme/`, which matches the about-21 s display scan, fits this (INFERRED).
8. **`data.json`** is created at the first capability-cache miss (`work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/Display.cs:275-324`; the user's copy was born 2026-09-26 07:52:41, which is `LOG/2026-09-26.txt` around line 908, CONFIRMED timing).

**Repairs the vendor does not do** (the port should add them; INFERRED risk):
- `SelProfileName ∉ ProfileNames` is not fixed.
- `CycleProfileNames` entries not in `ProfileNames` are not removed.
- Case-variant duplicates (`User`/`user`) are not merged.
- `IsDefault:true` on themes other than `User` makes them undeletable.

---

## 5. Bridge functions (deliverable b)

### 5.0 Calling convention (CONFIRMED)

- Overloads are selected by **exact arity and JSON token type**: Integer→`int`, String→`string`, Boolean→`bool`. JSON `null` gives `"Unsupported parameter type: Null"` with err 9 (`CL0:115-172`).
- **C# default parameters are not optional over RPC.** `Theme_ImportProfile` must get 3 arguments, and `Theme_GetDevicesBasicInfo` must get the trailing `-1`.
- The reply envelope is `{err_code, IsSucc, err_msg, RequestId, Tag, FunctionName, CurrItem}`. `Succ()` sets `err_msg:""`. `Error(msg, code=9)` has Tag `null` (`COM/JsonResult.cs:143-155`; 12 §2.3).
- An exception inside a Bridge method becomes err 9 with `ex.Message` (`CL0:106-112`).
- The renderer treats `err_code≠0 || err_msg` as rejection `{code,msg}` (05 §3.1).
- Only the latest request per function name is resolved, except `Theme_GetThemeInfos`, which may overlap (02 §4.5).
- Hub calls from one connection are serialized, so a long `Theme_Switch` blocks the UI's other requests (INFERRED from ASP.NET Core 3.1 SignalR semantics; `EvniaServe/Evnia/EvniaHub.cs:62-66`).
- `Tag = ThemeInfos` below means `List<ThemeInfo>` serialized as in §3.2 (`TO:234-237`).
- File names: every name is checked with `CheckFileNameValid` = non-empty and none of .NET's `Path.GetInvalidFileNameChars()` (`COM/FileUtil.cs:12-19`). On Windows the invalid characters are `" < > | : * ? \ /`, NUL and 0x01–0x1F. **`.` and `..` pass the check** (§11 B-1).

### 5.1 Read-only queries

**`Theme_GetThemeInfos()`** (`BR:724`, `SO:3004-3007`)
- Tag: ThemeInfos. No files touched.
- Consumers:
  - startup `C()` (`MN:202-204`);
  - Profile page mount (`ST:43715`);
  - mapped by `Wm` (`ST:13384-13396`). `SmartImageSwitch`, `SmartImages` and `SelSmartImage` do not exist in 1.13, so they map to `undefined`.

**`Theme_GetCurTheme()`** (`BR:714`, `SO:2994-2997`)
- Tag: the current `ThemeInfo` object, or `null` before `Start`.
- Consumers: startup `saveActivedTheme` (`MN:205-206`), after a theme rename (`ST:42827`), after a cloud apply.

**`Theme_GetCurProfile()`** (`SO:2999-3002`)
- Tag: the in-memory `T_Theme_Profile`, with nulls kept.
- **Never called by the renderer** (02 §5.8). Stub.

**`Theme_GetDevicesBasicInfo`**: three overloads (`BR:799-811`, `SO:3363-3439`, all CONFIRMED).

| Overload | Arguments | Source profile | Consumer |
|---|---|---|---|
| `(int equipmentType)` | `[-1]` | current theme + `SelProfileName` (goes through the 3-argument form). Err 9 `当前主题对象为空` ("current theme object is empty") if there is no current theme | Dashboard/"About device" card `AboutDevice` (`ST:33546-33560`, via `Gh().getThemeGetDevicesBasicInfo`). It filters to connected devices |
| `(string theme, string profile, int)` | `["User","Default",-1]` | `GetThemeProfile(theme, profile)`. Unknown theme/profile or unreadable file gives an empty result, not an error | Profile page "View detail" popup (`ST:43444`) |
| `(string path, int)` | `["<file>.pcenter",-1]` | any readable file | Cloud preview only (`ST:39896`) |

- Algorithm `smethod_22`, called with `bool_2:false`, so disconnected devices are included:
  - for each `Profiles[i]`, skip sub-device types and `JiangMeng_Mouse_Dongle_8K`;
  - look up `EquipmentType` in the device dictionary;
  - filter by `equipmentType` unless it is `-1`;
  - call `driver.AnalyseBasicInfo(ProfileContent, Sync_Profile)`;
  - append the result to the matching list.
- Tag `DataBasicInfo` (`EN/DataBasicInfo.cs:26-110`): `{"SyncEquipment":"","Display":[BasicInfo_Display…],"Keyboard":[],"Mouse":[],"MousePad":[],"Headset":[]}`. `SyncEquipment` is never assigned. The renderer skips keys whose value has `length` 0 (`ST:33421-33425`).
- `BasicInfo_Display` rules are in 12 §3.8 (`PHLO:148-181`). Member order: `LightSync, LightMode, Resolution, RefreshRate, SmartImage, Input, AdaptiveSync, Connect, EquipmentType, DeviceType, ModelName, ExtModel`. The preview shows the first seven in this order (`ST:33427-33441`).
- Tag computed from the user's profile (INFERRED from CONFIRMED rules and file values):
  ```json
  {"SyncEquipment":"","Display":[{"LightSync":"Off","LightMode":"StaticMode","Resolution":"3440x1440","RefreshRate":"175Hz","SmartImage":"/","Input":"Normal_DisplayPort1","AdaptiveSync":"On","Connect":true,"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":null}],"Keyboard":[],"Mouse":[],"MousePad":[],"Headset":[]}
  ```
  - `LightMode` reads `"StaticMode"` even though Ambiglow is **off**. Without ENE the mode `Value` is rewritten to 7 when the effect is disabled (`PHL:382-389`), and `LightMode` ignores `EffectEnable` (`PHLO:56-75`).
  - `SmartImage` is `"/"` in HDR (12 §3.8).

**`Theme_GetProfileDesc`**: two overloads (`BR:814-821`, `TO:536-586`, CONFIRMED). Tag is the value tuple `{"Item1":"<profile file path>","Item2":[T_DeviceProfile_Base…]}`, with sub-device types filtered out.

| Overload | Errors (code: exact `err_msg`) |
|---|---|
| `(string profilePath)` | 8: `AnalyseProfile ProfilePath=<p> Not Exist`; 7: `AnalyseProfile LoadProfile=<p> Error`; 10: `AnalyseProfile  LoadProfile=<p> Profiles is empty` (two spaces) |
| `(string theme, string profile)` | 3: `GetProfileDesc Error ThemeName=<t> Not Exist`; 5: `GetProfileDesc Error ProfileName=<n> Not Exist`; 8: `GetProfileDesc Error ProfilePath=<p> Not Exist`; 7: `GetProfileDesc LoadProfile=<p> Error`; 10: `AnalyseProfile  LoadProfile=<p> Profiles is empty` |

- The 3-argument cloud-merge variant `Theme_SyncProfileDesc` is not exposed in Bridge (dead).
- Consumers: **cloud upload only**. `ST:39540` (`XT.cloudProfileUpload`, `Item2` becomes the cloud `remark`) and `ST:40145` (MyProfiles sync). The port can stub it.
- Example Tag: `{"Item1":"C:\\Users\\user\\AppData\\Roaming\\EvniaServe\\Theme\\User\\Default.pcenter","Item2":[{"EquipmentType":1,"DeviceType":100000,"ModelName":"PHL 34M2C8600","ExtModel":""}]}`.

### 5.2 Theme management

**`Theme_Add(name, paramJson)`** (`BR:739`, `TO:41-71`)
- Checks, in order:
  - 2: `ThemeAdd Error ThemeName=<n> Not Valid`;
  - 4: `ThemeAdd Error ThemeName=<n> Exist` (case-insensitive);
  - `param` is parsed as `[{BindAppFilePath, BindAppIconPath}]`, keeping only entries whose file **exists**. If none is left, or the JSON is invalid or empty: 8 `ThemeAdd Error param=<json> Not Exist`. **A theme cannot be created without at least one existing app.**
- Algorithm:
  1. `new ThemeInfo{Name, IsDefault:false}`.
  2. **Deletes any existing `Theme/<n>/` directory** (`TO:57-61`).
  3. `Check()` gives `["Default"]`, `SelProfileName` `Default`, cycle `["Default"]` and creates the directory.
  4. Moves the icons (§3.4), appends the theme, saves `DataTheme.cfg`.
  - **No `.pcenter` is created.**
- Tag: ThemeInfos.
- Consumer: ThemeHeader "New App" (`ST:42606-42611`), then an immediate `Theme_Switch(name,"")`.

**`Theme_Rename(old, new)`** (`BR:749`, `TO:89-132`)
- Checks, in order:
  - 2: `ThemeRename Error ThemeName=<new> Not Valid`;
  - 4: `ThemeAdd Error ThemeName=<old> Exist` (sic: the message says "ThemeAdd" and shows the **old** name, raised when `<new>` exists);
  - 3: `ThemeRename Error ThemeName=<old> Not Exist`;
  - 7: `ThemeRename Error ThemeName=<old> IsDefault`.
- Algorithm:
  - If `Theme/<old>` exists: delete `Theme/<new>` if present, then `Directory.Move`.
  - Rewrite `Bind*Path` values with a case-sensitive string `Replace(oldDir, newDir)`.
  - Set `Name` and save.
  - Renaming the current theme is allowed: `themeInfo_0` is the same object.
- Tag: ThemeInfos. Consumer: ThemeList name editor (`ST:42822-42833`, then `getCurTheme`).

**`Theme_Del(name)`** (`BR:744`, `SO:3066-3073`, `TO:73-87`)
- Checks:
  - 8: `Can't del curThemeInfo <n>` (current theme, `SO:3068-3071`);
  - 3: `ThemeDel Error ThemeName=<n> Not Exist`;
  - 7: `ThemeDel Error ThemeName=<n> IsDefault`.
- Algorithm: removes the theme and **recursively deletes `Theme/<n>/`** (profiles, macros, icons), then saves.
- Tag: ThemeInfos. Consumer: ThemeList delete (`ST:42861`), which is shown only for a non-built-in, non-active theme (`ST:42876`).

**`Theme_UpdateBindApp(name, paramJson)`** (`BR:754`, `SO:3080-3083`, `TO:134-152`)
- Checks:
  - 3: `ThemeUpdateBindApp Error ThemeName=<n> Not Exist`;
  - 7: `ThemeUpdateBindApp Error Error ThemeName=<n> IsDefault` (sic, doubled "Error");
  - 8: `ThemeUpdateBindApp Error AppPath=<json> Not Exist` (no existing file left, so apps cannot all be unbound).
- Algorithm: replaces `BindAppInfos`, deletes the icons of removed apps, moves new temp icons, saves.
- Tag: ThemeInfos. Consumer: ThemeList "Binding" dialog (`ST:42912`).

**`Comm_GenAppIcon(path)`** is covered in 13 §4.2. Tag: the temp PNG path or `""`.

### 5.3 Profile management

**`Theme_AddProfile(theme, name)`** (`BR:759`, `SO:3229-3232`, `TO:268-289`)
- Checks:
  - 2: `ThemeCopyProfile Error ProfileName=<n> Not Valid` (sic, the message names Copy);
  - 3: `ThemeAddProfile Error ThemeName=<t> Not Exist`;
  - 6: `ThemeAddProfile Error ProfileName=<n> Exist`.
- Algorithm: appends to `ProfileNames` and to `CycleProfileNames`, saves `DataTheme.cfg`. **No file is written.**
- Tag: ThemeInfos.
- Consumer: ProfileList "New profile" (`ST:43321-43330`), followed by `Theme_Switch(theme,name)`. That switch creates the file and fills it with the monitor's current (cached) state (§5.5). **A "new profile" is therefore a snapshot of the current monitor state, not factory defaults** (CONFIRMED by code path).

**`Theme_CopyProfile(theme, src, dst)`** (`BR:764`, `TO:291-332`)
- Errors:
  - 3: `ThemeCopyProfile Error ThemeName=<t> Not Exist`;
  - 5: `ThemeCopyProfile Error ProfileName=<s> Not Exist`;
  - 5: `ThemeCopyProfile Error OriProfilePath=<path> Not Exist`;
  - 2: `ThemeCopyProfile Error newProfileName=<d> Not Valid`;
  - 6: `ThemeCopyProfile Error NewProfileName=<d> Exist`;
  - 7: `ThemeCopyProfile LoadProfile=<path> Error`;
  - 9: `ThemeCopyProfile SaveTXTConfig Error`.
- Algorithm: load the source file, write the destination file, append to both lists, save.
- Consumer: `ST:43466-43477`. The name is `src + "(" + n + ")"`, where `n` = the lowest free index from `Mm` (`ST:13303-13322`). Copying a never-activated profile fails with 5 (no file).

**`Theme_RenameProfile(theme, old, new)`** (`BR:769`, `TO:334-386`)
- Errors: 3; 5 `…ProfileName=<o> Not Exist`; 5 `…OriProfilePath=<p> Not Exist`; 2 `…newProfileName=<n> Not Valid`; 6 `…NewProfileName=<n> Exist`; 5 `…UnFind ProfileName=<o>`; 7 `ThemeRenameProfile LoadProfile=<p> Error`; 9 `ThemeRenameProfile SaveTXTConfig Error`. Each message is prefixed `ThemeRenameProfile Error `.
- Algorithm: load, move the file, rewrite it, replace the name in `ProfileNames`, `SelProfileName` and `CycleProfileNames`, save.
- Consumer: ProfileList label editor (`ST:43396-43408`).

**`Theme_DelProfile(theme, name)`** (`BR:774`, `SO:3244-3251`, `TO:388-411`)
- Errors:
  - 9 `Can't del curThemeInfo <t> | <n>` (current theme **and** its selected profile, compared case-insensitively);
  - 3; 5 `ThemeDelProfile Error ProfileName=<n> Not Exist`;
  - 9 `ThemeDelProfile Error ProfileNames Count at last one` (cannot delete the last profile).
- Algorithm: remove the name from both lists. If it was that theme's `SelProfileName`, set it to `ProfileNames[0]`. Delete the file and save.
- Consumer: `ST:43660-43669`. The UI shows delete only when `theme.activeProfile !== name` (`ST:43682`).

**`Theme_HandleCycleProfile(theme, name, bAdd)`** (`BR:789`, `TO:480-501`)
- Errors: 3 `ThemeHandleCycleProfile Error ThemeName=<t> Not Exist`; 5 `…ProfileName=<n> Not Exist`.
- Algorithm: add (then re-sort by `ProfileNames` order) or remove, then save.
- Tag: ThemeInfos. Consumer: the cycle icon (`ST:43415-43427`).
- The list is consumed only by **peripheral** button actions (§5.7), so it has no function on a monitor-only system.

### 5.4 Import and export

**`Theme_ImportProfile(theme, filePath, bOverride)`**: exactly 3 arguments (`BR:779`, `SO:3253-3265`, `TO:413-446`)
- Errors:
  - 3 `ThemeImportProfile Error ThemeName=<t> Not Exist`;
  - 8 `ThemeImportProfile Error FilePath=<f> Not Exist`;
  - 7 `ThemeImportProfile LoadProfile=<f> Error` (unparsable: invalid JSON, a multi-line file, or an empty file);
  - 10 `ThemeImportProfile  LoadProfile=<f> Profiles is empty` (two spaces).
- Algorithm:
  - `name = GetFileNameWithoutExtension(filePath)`.
  - With `bOverride`: use `name` as is (no validity check).
  - Otherwise: `GenValidName(ProfileNames, name, "Default")`. An invalid name becomes `Default`; a collision becomes `name(1)`, `name(2)`, … with no space (`GO:120-132`).
  - Append to both lists if new, write `Theme/<t>/<name>.pcenter` with `SaveTXTConfig`, save the index.
  - **No content validation**: any non-null object with a non-empty `Profiles` array is accepted.
  - If `bOverride` and `(theme, name)` is the **current** theme and profile: `Theme_Switch(theme, name, bApply:true)`, which applies to the monitor (§6).
- Tag: ThemeInfos.
- Renderer (`ST:43076-43097`, `ST:43154-43170`):
  - refuses files larger than 20 971 520 bytes (`ProfileSizeExceed`);
  - copies the chosen file to `<userData>/<basename without .pcenter, cut to 30 chars>` (**no extension**), imports that copy, then deletes it;
  - "Overwrite" (`repeatMode 1`, the default) or "New" (0, `ST:39390-39409`).
- Consequences:
  - The profile name is the file name cut to 30 characters.
  - A base name containing a dot loses its last `.suffix` (`GetFileNameWithoutExtension`) (INFERRED).

**`Theme_ExportProfile(theme, profile, filePath)`** (`BR:784`, `TO:448-478`)
- Errors: 3; 5 `ThemeExportProfile Error ProfileName=<n> Not Exist`; 5 `…OriProfilePath=<p> Not Exist` (a profile never switched to has no file); 7; 10 `ThemeExportProfile  LoadProfile=<p> Profiles is empty`; 9 `ThemeExportProfile SaveTXTConfig Error`.
- **Exported format:** the stored file is loaded and re-written with `SaveTXTConfig` to **exactly** `filePath` (no extension is forced, unlike `Macro_Export`). The result is the §3.3 format: BOM, one line, nulls kept, byte-equal to the stored file after re-serialization (CONFIRMED by §3.1 round-trip). The export is **not** refreshed from the device; the stored file is already current (§8).
- Tag: `null`.
- Consumer: `ST:43520-43527`, save dialog via `exportFile`, `defaultPath` = profile name (`ST:43596-43611`). The renderer error mapping (`QT`, `ST:39411-39425`) is 5 → `MacoParseErr` ("The Macro parsing error." — the wrong text for profiles), 7 → `ProfileParseErr`, 10 → `ProfileEmptyErr`. Codes 3, 8 and 9 show nothing.

**Can a Windows-exported file be imported on Linux?** Yes, unchanged (CONFIRMED format identity, INFERRED behaviour):
- The wrapper is UTF-8 with or without BOM, **single line**.
- The display section is used only when `ProfileDesc.DeviceType == 100000` and `ModelName` equals, **ordinal and case-sensitive**, the name the Linux backend reports for the connected monitor (`EN/T_Theme_Profile.cs:54-63`). For the user this is `"PHL 34M2C8600"`, from the EDID monitor-name descriptor (see 07/08).
- A non-matching section is kept but ignored.
- The reverse direction (Linux export to Windows) requires the port to write the BOM, one line, and names restricted to the Windows-valid character set.

### 5.5 Switching and applying

**`Theme_Switch(theme, profile)`** (`BR:729`, 2 arguments, so `bApply=false`; `SO:3019-3052`)
1. Empty theme: 9 `ThemeSwitch themeName is null`.
2. Empty profile: use that theme's `SelProfileName`. If the theme is unknown: 9 `ThemeSwitch themeName=<t> not exit profileName is null`.
3. If `!bApply` and both names equal the current ones (**case-insensitive**): return `Theme_GetCurTheme()` with **no side effects**.
4. `ThemeOper.ThemeSwitch`: the theme is looked up case-insensitively and the profile by `ProfileNames.Contains` (case-sensitive). Otherwise 9 `ThemeSwitch ThemeName=<t> or ProfileName=<p> not contains`. On success the target's `SelProfileName = profile` (`TO:211-219`).
5. `themeInfo_0 = target`, then `t_Theme_Profile_0 = LoadCurProfile()`. If the file is missing it is created as `{"Sync_Profile":null,"Profiles":[]}`.
6. `smethod_20(clone, bApply)` (`SO:3085-3117`). For every device in `EquipmentDic` (wireless-offline ones are skipped):
   - set `CurThemeInfo` / `CurThemeProfile`;
   - get `content = GetProfileContent(type, model)`;
   - `Task.Run(ParameterToDevice(content, bForce: type==Display || bApply, needSave:false))`.
   - `WaitAll`, then `ThemeSaveCurProfiles()`.
7. For the display, `ParameterToDevice(string)` deserializes the content, or uses `GetDefaultData()` (the live `CacheDeviceData`) when it is empty (`G0:218-233`). Then `PHL:585-614`:
   - `method_10(CacheDeviceData, profile)` rewrites the SmartImage/HDR group (§6);
   - `method_12` rewrites Ambiglow;
   - `DeviceData = CacheDeviceData.Clone()`;
   - `RecheckFuncConstraints`, which may notify `NotifyUIDisplayFuncConstraintsChange`.
   - **Everything outside the SmartImage/HDR sub-module and Ambiglow comes from `CacheDeviceData`**: GameMode, Input, Audio, System, Setup, `DispalyData`. That object is the last full read (connect or `PHL_ReloadData`), mutated by earlier switches. `PHL_SetOSD` and friends edit only `DeviceData` (`PHL:1622-1656`), never `CacheDeviceData`.
   - So after, for example, changing a GameMode option and then switching profile, `DeviceData` and the **saved target profile** revert to the cached value. The monitor keeps the new value (CONFIRMED code path; INFERRED user-visible effect).
8. Tag: the new current `ThemeInfo`. Consumers:
   - header profile selector (`MN:1896-1905`);
   - ProfileList click (`ST:43105-43108`);
   - Profile page theme click with `""` (`ST:43747`);
   - after `Theme_Add` (`ST:42610`);
   - the `NotifyUISwitchTheme` handler when the Tag contains `|` (`MN:1917-1925`).
   - Each then calls `saveActivedTheme` and emits `refreshDeviceData`, which leads to `Profile_GetDeviceData`.

**`Theme_SwitchApp(theme)`** (`BR:734`, `SO:3054-3059`)
- `Theme_Switch(theme,"")`, then `EVT_Com.ThemeSwitchApp`. That event is consumed only by `RongYuanMouse_Oper` and is irrelevant here (13 §4.2).
- Consumer: the `NotifyUISwitchTheme` handler when the Tag has no `|`, i.e. from `CheckTopApp` (`MN:1921`). The handler also shows the toast `ProfileActived` (`"{key} is active"`).

**`Theme_ApplyProfile(theme, profile, profilePath, selDevicesJson)`** (`BR:824`, `SO:3456-3464`, `TO:622-699`)
- **The backend is local-file based. Only its renderer caller is cloud-only.**
- The only call site is the cloud "My profiles → Apply" dialog, after downloading to the cloud cache (`ST:40439-40470`). No local UI uses it.
- Checks:
  - 2 `ApplyProfile Error ThemeName=<t> or  ProfileName=<p> Not Valid` (two spaces);
  - `selDevices` = `[{DeviceType, ModelName, ExtValue}]` (`EN/DeviceInfoBase.cs`). An empty list gives 9 `ApplyProfile selDevices=<json> is error`. Invalid JSON throws NullReference, which becomes 9 `Object reference not set to an instance of an object.`;
  - 7 `ApplyProfile LoadProfile=<path> Error`;
  - 10 `ApplyProfile LoadProfile=<path> sel profiles is empty` (no `(DeviceType, ModelName)` matched).
- Algorithm:
  - Keep the selected devices' `T_Profile` entries.
  - Theme missing: **create it** with no bound apps, `IsDefault:false`, `ProfileNames=[profile]` (it deletes a pre-existing `Theme/<t>/` first).
  - Profile missing: add it and write the filtered file.
  - Profile exists: merge the entries into the existing file with `SaveProfileContent`. If that file is missing, `LoadProfileByName` returns null → NullReference → err 9.
  - Then `Theme_Switch(theme, profile, bApply:true)`, which applies even if it is already current.
- Tag: ThemeInfos, computed **before** the switch.
- Port: omit, or keep as local-only (§10.4).

**`Theme_ResetCurProfile()`** (`BR:794`, `SO:3277-3293`)
- Algorithm:
  - `t_Theme_Profile_0.InitDefData()` clears `Profiles` and `SyncDevices`, keeping `Sync_Profile` (`EN/T_Theme_Profile.cs:35-42`).
  - Every connected device runs `Reset(needSave:false)` in parallel. The display runs `PHL:1998-2019`: **VCP 0x04 = 1**, clear ENE state, 5000 ms, full reload, `DeviceData = GetDefaultData()`.
  - `ThemeSaveCurProfiles`.
- Tag: `null`, **always success**. If 0x04 is unsupported, the display's `"not support rest"` error is swallowed.
- Consumer: the "Reset" icon, shown only on the active theme's active profile (`ST:43628-43652`). Its confirmation text is "Are you sure you want to reset {key}?". **Nothing refreshes the UI afterwards**: only the loading spinner hides (`ST:43639`).

### 5.6 Macros (only what the monitor-only port needs)

| Function | Behaviour (CONFIRMED) | Port |
|---|---|---|
| `Macro_GetList(theme)` (`SO:1972-2010`) | If `Theme/<t>/` is missing: 3 `Theme=<t> path=<dir> not exit`. Otherwise Tag `[{MacroName, IsComMacro}]` in creation-time order (§3.5), `[]` when there is no `Macro/` folder. **Called at startup (`MN:207-208`) and on every active-theme change (`MN:1884-1893`)** | implement: list the folder, or return `[]` |
| `Macro_GetFuncMenu()` (`SO:2544-2552`) | static menu `{Items:[…]}` built from a fixed `SupportButtonFunc` list (`SO:2554+`). Called at startup | return `{"Items":[]}` (INFERRED safe: `CP(e)` maps the array, `ST:40748-40751`) |
| `Macro_Import(theme, file, bOverride)` (`SO:2401-2501`) | 3 (theme directory); 9 `MacroImport filePath=<f> is not exit`; name = base name, or `GenValidName(…, "Macro")`; parse fails give 5 `Macro_Import macro content is not valid`; writes `Macro/<name>.macro`. With `bOverride` it also rewrites button bindings in **the current theme's** profiles, writing them under `Theme/<theme>/…` — mixing the two themes (vendor bug, INFERRED). Tag = `Macro_GetList` result | stub or skip (the KeyBind UI is peripheral-only) |
| `Macro_Export(theme, name, path)` (`SO:2503-2528`) | 3; 5 `Macro_Export ori macro=<n> content is not valid`; 9 `Macro_Export save file error`; writes to `ChangeExtension(path, ".macro")`. Tag `null` | stub |

The other `Macro_*` functions (`VerifyFile`, `GetDetail`, `Add`, `Copy`, `Rename`, `Update`, `Del`) are peripheral-only; formats are in §3.5.

### 5.7 Notifications and profile-cycle handlers

- **`NotifyUISwitchTheme`** (`Notification_Func.const_2` in the deobfuscated tree; 13 §4.3) is sent through `HE:89-101` as the full `JsonResult` JSON with `RequestId:null`. Its Tag is either:
  - `"<Theme>"` from `CheckTopApp` (`SO:3295-3345`), or
  - `"<Theme>|<Profile>"` from `SwitchProfileNotification` (`SO:3219-3227`).
- Profile-cycle handlers (`SO:3142-3217`, registered in `HE:67-86`):

  | Handler | Behaviour |
  |---|---|
  | `NextProfile` | next entry in `CycleProfileNames`, **no wrap** |
  | `PreviousProfile` | previous entry, no wrap |
  | `CycleDownProfile` | next entry, wraps |
  | `CycleUpProfile` | previous entry, wraps |
  | `SpecificProfile("T \| P")` | only within the current theme |

  - Each sends `NotifyUISwitchTheme` with `"<CurTheme>|<P>"`. **The backend does not switch; the renderer calls `Theme_Switch`.**
  - The only senders are peripheral button actions (`work/dotnet-clean/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/CDeviceButtonBase.cs:134-146`).
  - On a monitor-only system there is **no trigger**. A port may add a desktop shortcut or CLI that calls these (INFERRED option).

### 5.8 `FactoryReset()` — see §7.

---

## 6. DDC writes and sleeps per operation on the 34M2C8600 (deliverable d)

Assumptions:
- No ENE controller. The 1.13.0 log shows none, and the user's profile has `ENEEffectEnable:false`.
- Capability string from `CFG/Config/data.json` (CONFIRMED).
- "Available" = `err_code==0` in the **cached** attribute. Unread attributes count as available, but are written only if the **profile** has a non-null `Value` (`PHL:745-752`; 12 §2.3).
- Each set costs about 110 ms of transport time (write + 100 ms; 06 §0, 07 §8.4). Supported codes include `04 10 12 14 16 18 1A 72 87 F0 DC E2A019 E2A01A–1D E2A020 E2A024`. **Not supported:** `8A 90 E2A01E E2A03D E2A03E E2A03F` (their `err_code` is 9 in the user's profile).

| Operation | Writes, in order | Backend sleeps | Evidence |
|---|---|---|---|
| **`Theme_Switch` / `Theme_SwitchApp`** to a different theme or profile, monitor in **HDR** (the user's state: DC=33 HDR Game) | (a) `DC` = profile DC, only if the profile is also HDR and DC differs, then **1000 ms**. (b) `0x10` = profile HDR luminance, `0x12` = profile HDR contrast (forced; E2A03D/3E/3F skipped as unsupported). (c) Ambiglow: if the profile's `ModuleAmbiglow.EffectEnable`: `E2A019` = mode (0 becomes 7, forced), then `E2A01A`, `E2A01B`, `E2A01C`, `E2A01D` **only where they differ from the cache**. Otherwise `E2A019 = 0`. **With the user's current profile: `0x10=100`, `0x12=50`, `E2A019=0`, i.e. 3 writes, about 0.33 s** | 1000 ms only on DC change | `PHL:632-637`, `PHL:661-672` (HDR), `PHL:691-731` (Ambiglow); values from `Default.pcenter` |
| same, monitor in **SDR** | (a) `DC` if the profile's DC is in the SDR `Items` and differs, then 1000 ms. (b) Forced, each only if the profile has a value: `E2A020`, `14`, [`16`,`18`,`1A` if `14==11` UserRGB], `72`, `12`, `F0`, `87`, `10`, (`8A`, `90` skipped), `E2A024`. (c) Ambiglow as above | 1000 ms on DC change | `PHL:619-631`, `PHL:638-660` |
| Switch to the **same** theme and profile | none (early return) | – | `SO:3033-3037` |
| Switch to a profile with **no content** for this ModelName (new or empty profile) | same sequences, with `CacheDeviceData` as the source: DC unchanged, the group re-written with the cached values, Ambiglow re-written | as above | `G0:218-233`, `PHL:248-264` |
| **`Theme_ApplyProfile`** / **`Theme_ImportProfile`** (override of the current profile) | as `Theme_Switch`, even when "same" (`bApply:true`). Import of a non-current profile: **no DDC** | as above | `SO:3456-3464`, `SO:3253-3265` |
| **`Theme_ResetCurProfile`** | `0x04 = 1` ("Restore Factory Defaults"), then a full re-read (`method_4`) that includes the EQ-band loop: 5 × (`E2A001 = band` for bands 00–04, **100 ms**, read `E2A039`) | **5000 ms** after 0x04, plus 5 × 100 ms | `PHL:1998-2019`, `PHL:418-438` |
| **`FactoryReset`** | identical DDC traffic to `Theme_ResetCurProfile` | 5000 ms + 5 × 100 ms | `SO:278-292` |
| All other `Theme_*`, `Macro_*`, `GetProfileDesc`, `GetDevicesBasicInfo`, Export | none | – | code |
| Connect / `Start` (context) | none for the display (`bForce:false`); the log shows `ParameterToDevice TotalMilliseconds=3,0051` | – | `G3:234-250`; `LOG/2026-09-26.txt:995-997` |

- GameMode (`method_11`) exists but has **no caller**, so it is never re-applied (`PHL:675-689`; 06 §7.12).
- With ENE present, as in the 1.11 log on 09-25, `method_12` pushes `EffectInfo` to the ENE USB controller instead of writing E2A019 (report 09).

---

## 7. `FactoryReset` (deliverable e)

`BR:18-21` → `SO:254-303` (CONFIRMED):
1. **Delete every file directly in `%APPDATA%\EvniaServe\`** (normally none) (`SO:257-265`).
2. **Delete every sub-directory except the one named exactly `logs`** (case-sensitive; `SO:266-277`). That removes:
   - `Theme\`: all themes, profiles, macros and icons;
   - `Config\`: `SoftConfig.data`, `color.data`, **`data.json`**, `BoardInfo\`;
   - `Cache\`.
   - Deletion errors are logged and ignored (`COM/DirectroyUtil.cs:28-44`).
3. **`InitEnviroment(reset:true)`**: write a fresh `DataTheme.cfg` (User/Default only) and a fresh `Theme/User/Default.pcenter` = `{"Sync_Profile":null,"Profiles":[]}` (`TO:28-39`, `EN/ThemeInfo.cs:152-167`).
4. For every **connected** device: rebind to the new theme and profile, then `Reset(needSave:false)` in parallel. The monitor gets **VCP 0x04 = 1 (yes, FactoryReset writes 0x04)**, 5000 ms, and a full re-read (§6). `DeviceData` becomes the fresh read with `EffectInfo = new DisplayEffectInfo()` when no ENE is present (`PHL:1998-2019`, `PHL:248-264`).
5. `EVT_Effect.CheckSoftEffect` (timers), then `ThemeSaveCurProfiles`, which writes the display's post-reset state into the new `Default.pcenter`. Tag `true`.
   - Failure: 9 `InitEnviroment error`.

**Not reset** (CONFIRMED by the absence of reset code; the effects are INFERRED):
- **In-memory `SoftConfigInfo`** (`GO:17`) survives: idle-lights settings stay active until restart, and the file reappears only on the next setting change.
- **In-memory VCP cache** (`CV:10`) survives: `data.json` is not recreated until a cache miss, so the next process start re-reads the capability string.
- Electron-side settings in `%APPDATA%\evnia\config.json`.
- The monitor's firmware state other than what 0x04 resets.

UI (`ST:30055-30080`): the confirmation text `ResetTip1` says it "will clear all profiles and macro files". It does **not** say the monitor is reset. Afterwards the renderer emits `factoryReset`, which resets its stores (`MN:1841-1843`) and reloads the theme and macro lists (`MN:198`, `MN:202-208`).

---

## 8. When files are written, and atomicity (deliverable f)

**`ThemeSaveCurProfiles()`** (`SO:3119-3140`, under `lock(object_0)`) is the one writer of the current profile:
1. For every connected, online device, `t_Theme_Profile_0.SaveProfileContent(desc, driver.PurifyProfile())`.
2. Write `Theme/<cur>/<SelProfileName>.pcenter`.
3. Write `DataTheme.cfg`.
Both files are rewritten every time.

Triggers (CONFIRMED):

| Trigger | Where |
|---|---|
| `EVT_Com.SaveCurThemeProfile`, raised by `GClass0.SaveProfile()` | `HE:35-38`, `G0:191-194` |
| … from the display: `ReloadOSD` (first time), `ParameterToDevice(needSave)` (every **connect/rescan** and `PHL_ReloadData`), ENE detect, idle lights-off/on (`method_15`), every `Effect_*` setter, `EffectReset`, `SetOSD`, `SetSmartImage`, `ResetSmartImage`, `SetColorPreset`, `SwitchSmartFrame`, `SetSmartFrameSize`, `SetInputSource`, `SwrapPIPPBP`, `SetAudioEQ`, `Reset(needSave)` | `PHL:566,604,783,849,980,1001,1021-1149,1177,1185,1654,1706,1767,1803,1858,1883,1936,1970,1991,2016` |
| End of **every** device scan (`Start`, `Device_Rescan`, `Device_DetectionUSB`/`Display`, `Device_OtherDeviceChange`), via `Effect_Sync` → `OnSyncEffect` | `SO:212`, `SO:1738-1762`. CONFIRMED on disk: both files have mtime 08:24:28.25, the second an `Other` scan ended (`LOG/2026-09-26.txt:1222-1229`) |
| `Theme_Switch`/`SwitchApp`/`ApplyProfile`/Import-override-current (via `smethod_20`), `Theme_ResetCurProfile`, `FactoryReset`, `SyncEffect_EnableDevice`, peripheral button ops | `SO:3115`, `SO:3291`, `SO:294`, `SO:1600,1626`, `SO:462,586,626,2887,2904` |

Other writers (CONFIRMED):
- `DataTheme.cfg` alone: every successful `ThemeOper` mutation (`method_2`, `TO:244-252`) and `ThemeInit` when creating.
- Other `.pcenter` files: Copy, Rename (move + rewrite), Import, ApplyProfile, and `LoadCurProfile` on a missing file. `Macro_Import` with override rewrites every profile of the current theme.
- `Macro/*.macro`: macro functions.
- `Icon/*.png`: Add/UpdateBindApp.
- `SoftConfig.data`, `color.data`, `data.json`: §3.6–3.8.

Atomicity and robustness:
- **Not atomic.** `SaveTxtData` truncates and writes in place, with no temp file, rename or fsync (`SFU:282-309`). A crash or power loss mid-write leaves an empty or partial file. The reader then returns `null`, and:
  - `DataTheme.cfg` is **recreated as default on the next start**, so every app theme disappears from the index while its directory stays orphaned (`TO:35-38`);
  - the current `.pcenter` is recreated empty and refilled with the live state at the next connect (`EN/ThemeInfo.cs:159-164`) (INFERRED consequence).
- **Races (INFERRED).**
  - `ThemeOper.method_2` is not synchronized with `ThemeSaveCurProfiles` (which is locked). Device-thread saves can overlap hub-thread index writes.
  - Two `StreamWriter`s on one file give a sharing-violation exception, which is caught and logged as `SaveDataTheme Error`.
  - Enumerating `ThemeInfos` while it is mutated gives "Collection was modified", which is also caught.
- Write amplification: every UI slider change rewrites the 12 KB profile and the index.

---

## 9. Renderer: store, header selector and `/profile` page

**Store `Gm` ("theme")** (`ST:13397-13434`):
- state `{themes, activedThemeName:"User", activedProfileName:"default1"}`;
- getters `allProfileList` / `activedProfileList` yield `"Theme | Profile"` option strings;
- `isAppBound(path)` compares paths **case-sensitively** (the backend `CheckTopApp` compares case-insensitively);
- mapper `Wm` (`ST:13384-13396`).

**Header selector** (`MN:1882`, `MN:1896-1905`, `MN:1993-2004`):
- options are all `"Theme | Profile"` strings;
- `onChange` splits on `|`, trims, and calls `Theme_Switch(theme, profile)`. Names cannot contain `|`.
- A watcher on `activedThemeName` calls `Macro_GetList(theme)` (`MN:1884-1893`).
- `NotifyUISwitchTheme` handling: `MN:1917-1927` (§5.5).

**Page `Profile`** (`ST:43706-43760`; route `/profile`, `ST:43779`). Layout: title "Apps"; `ThemeHeader` (search + "New App", `ST:42505-42707`); `ThemeList` (`ST:42709-43020`); `ProfileList` (`ST:43036-43701`).
- Clicking a theme calls `Theme_Switch(name,"")`. While a search is active, clicking only selects.

| UI action | Hub call(s) | Limits / validation (renderer) |
|---|---|---|
| New App | `Comm_GenAppIcon` per picked exe → `Theme_Add(name, json)` → `Theme_Switch(name,"")` | ≤50 themes (`ThemeUpperLimit`); ≤7 apps (`AppBindLimit`); `CannotBindSelf` if the path equals `runConfig.processPath`; `AppAlreadyBind`; name `"New Application[ N]"`, trimmed, maxlength 30, validator `/[\\/:*?"<>\|]/` and non-empty (`ST:39717-39731`); error 2 → `NameInvalid`, 4 → `NameExisted` |
| Rename / delete app | `Theme_Rename` (+ `Theme_GetCurTheme`) / `Theme_Del` | delete hidden for built-in and active themes |
| Bind apps | `Comm_GenAppIcon`, `Theme_UpdateBindApp` | hidden for built-in; at least one app |
| Import profile | `getFileSize` → copy → `Theme_ImportProfile(t, copy, overwrite)` | ≤50 profiles (`ProfileUpperLimit`), ≤20 MiB, filter `["pcenter"]` |
| New profile | `Theme_AddProfile` → `Theme_Switch(t, name)` | name `"Default[ N]"`, maxlength 30; 2 → `NameInvalid`, 6 → `NameExisted` |
| Select, rename, cycle, preview, copy | `Theme_Switch`, `Theme_RenameProfile`, `Theme_HandleCycleProfile`, `Theme_GetDevicesBasicInfo(t,p,-1)`, `Theme_CopyProfile` | copy ≤50 |
| Export | `exportFile` dialog → `Theme_ExportProfile(t, p, path)` | filter `["pcenter"]` |
| Reset (active profile only) | `Theme_ResetCurProfile` | writes 0x04 (§6) |
| Delete (non-selected profiles) | `Theme_DelProfile` | – |

**Cloud-only branches to strip** (all CONFIRMED locations):

| Branch | Location | How to strip |
|---|---|---|
| Import dialog radio "From Cloud" and cloud picker | `ST:39390-39398` (`qT`), `ST:43154-43165`, `ST:43174-43228` | keep only `FromLocal`, or leave `loginState` permanently false: the option is `disabled: !loginState` |
| Export dialog "Export to cloud" / "Login to cloud" link and tooltip | `ST:43576-43595`; handler `W()` opens login (`ST:43117-43119`) | remove the `ub` div or make `W` a no-op |
| Cloud upload helpers | `XT` (`ST:39509-39578`), `tP` (`ST:39602-39715`), `$T` (`ST:39426-39508`) | dead once login is unreachable |
| `ProfilePreview` (cloud) and `MyProfiles`/`MyMacros` | `ST:39883-39945`, `ST:39949-40735`, `ST:42017-42370` | reachable only from the Account page (`ST:42408`); remove that route |

`ProfileList.b` fetches cloud profiles only when `cloudThemes` is non-empty, which requires login (`ST:43073-43076`).

---

## 10. Linux port (deliverable g)

### 10.1 Path mapping

| Windows (vendor) | Linux | Notes |
|---|---|---|
| `%APPDATA%\EvniaServe\` | `$XDG_CONFIG_HOME/EvniaServe/` (default `~/.config/EvniaServe/`) | Keep the relative tree, so Windows files can be copied in |
| `…\Theme\DataTheme.cfg`, `…\Theme\<T>\<P>.pcenter`, `…\Theme\<T>\Icon\`, `…\Theme\<T>\Macro\` | same relative paths | Theme and profile names become file names verbatim. Keep the **Windows** invalid-character set, also reject `.`, `..`, leading/trailing space or dot and names over 30 characters, and enforce case-insensitive uniqueness for profiles too (a Windows file system cannot hold `Default` and `default`) |
| `…\Config\SoftConfig.data`, `…\Config\color.data` | `…/Config/` | – |
| `…\config\data.json` (code) = `…\Config\data.json` (disk) | `…/Config/data.json`; on read also try `…/config/data.json` | Case matters on Linux. It is a cache, so `$XDG_CACHE_HOME/EvniaServe/data.json` is also acceptable if FactoryReset clears it |
| `…\logs\` | `$XDG_STATE_HOME/EvniaServe/logs/` | Outside the tree that FactoryReset wipes |
| `…\Config\BoardInfo\`, `…\Cache\` | not created | peripherals / dead cloud merge |
| `%TEMP%\EvniaServe\` (`PATH_APP_TEMP`) | `$XDG_RUNTIME_DIR/EvniaServe/` (fallback `/tmp/EvniaServe-$UID`, mode 0700) | Icon staging; delete unbound temp icons |
| `%APPDATA%\evnia\` (Electron `userData`) | `$XDG_CONFIG_HOME/evnia/` | Import staging copies (§5.4), `config.json` |

**Migration from Windows** (INFERRED rules):
- Copy `Theme/` and `Config/SoftConfig.data` as they are; BOM and one-line format are already compatible.
- `BindAppInfos` holding `C:\…` paths will never match. The vendor's own `UpdateBindApp` would drop them because the file does not exist. Drop them on import, together with their icon paths.
- Profile content applies only if the Linux backend's `ModelName` is `"PHL 34M2C8600"`.
- `data.json` can be copied (valid signature) or regenerated.

**Writer requirements:**
- BOM, one line, member order as in §3 and 12 §3;
- nulls kept in wrappers and dropped in `ProfileContent`;
- `\u2028`/`\u2029`/`\u0085` escaped;
- **write to `<file>.tmp`, fsync, then rename** (fixes §8);
- one mutex for the index and profile writers;
- debounce saves (for example 250 ms) to avoid the rewrite storm.

### 10.2 App binding without the `.exe` picker: minimal patches

Renderer facts (CONFIRMED):
- The picker is `FileSelector.open()` → `ipc.invoke("fileSelect", {filters:[{name:"Application", extensions:["exe"]}]})` (`ST:39812-39832`; main handler `EM:17491-17512`).
- The returned `path` becomes `BindAppFilePath` exactly. Icons are displayed as `local:///<icon path>`.
- `CannotBindSelf` compares against `window.runConfig.processPath` (`ST:42535,42550,42749,42764`), its only use.
- The renderer sends only `{BindAppFilePath, BindAppIconPath}`, so an extra `AppId` field (13 §4.4) could not come from the renderer anyway.

Recommendation (**zero bundle patches**; INFERRED design):
1. **Main-side dialog swap.** In the new `fileSelect` handler, when `filters?.[0]?.extensions` equals `["exe"]`, open the GTK chooser with:
   - `defaultPath:"/usr/share/applications"`;
   - `filters:[{name:"Applications", extensions:["desktop"]}, {name:"All files", extensions:["*"]}]`.
   - Return `{path, size, buffer:null}`. Mention `~/.local/share/applications` and `/var/lib/flatpak/exports/share/applications` in the dialog title, or accept any executable file.
2. **`runConfig.processPath`** := the installed `.desktop` of the port, e.g. `/usr/share/applications/evnia-precision-center.desktop`. `CannotBindSelf` then fires for the natural "self" choice. The backend should also refuse its own executable.
3. **Backend semantics for `BindAppFilePath`:**
   - A path ending in `.desktop` is an **app binding** with desktop-id = basename without `.desktop`. The file exists, so the vendor `File.Exists` rule is kept (`TO:169-176`).
   - Any other path is an **executable binding**.
4. **`Comm_GenAppIcon(path)`:**
   - For `.desktop`: parse `Icon=` and resolve it through the icon theme (hicolor, sizes 256→48, then `/usr/share/pixmaps`). SVG may be copied as `.svg`: the renderer only needs a loadable file through `local://`, and the `.png` name in `TO:194` is cosmetic. Do not rely on Chromium sniffing SVG content served under a `.png` name.
   - For an ELF path: find a `.desktop` whose `Exec` resolves to it, else use a generic icon.
5. **Foreground matching** (replaces `CheckTopApp`, 13 §4.4). Move the decision into the backend and send `NotifyUISwitchTheme` only after switching, or keep the vendor split. A theme matches when any binding matches:

   | Binding | Matches when |
   |---|---|
   | `.desktop` | focused-window `app_id` (Wayland) or `WM_CLASS`/`StartupWMClass` (X11) equals the desktop-id or its `StartupWMClass`; or the realpath of `Exec`'s first token equals `readlink /proc/<pid>/exe`; or the Flatpak id equals the desktop-id |
   | ELF | `realpath(path) == readlink(/proc/<pid>/exe)` |

   - On **GNOME Wayland** the focused window is not observable without a small Shell extension (13 §4.4). On **X11**, use `_NET_ACTIVE_WINDOW` + `_NET_WM_PID`.
   - Exclude the port's own window by `app_id`/pid. This fixes vendor bug 13 §4.3, where the exclusion list uses the wrong process name.
6. **`local://`** must accept absolute POSIX paths (`local:////home/…`) and should restrict them to the config tree and `$XDG_RUNTIME_DIR/EvniaServe` (01 §L).
7. **Save dialog:** GTK does not append `.pcenter`. In `exportFile`, append the single filter extension when it is missing. The backend writes exactly the given path (§5.4).

Optional one-line renderer patch, cosmetic only: change the `FileSelector` default `filterName:"Application"`/`extensions:["exe"]` at `ST:39819-39820` to `["desktop"]`. Main then needs no special-casing.

### 10.3 Behaviour to keep vs fix

| Item | Keep (compatibility) | Fix (recommended; INFERRED) |
|---|---|---|
| Startup theme | always `User` (§4) | – |
| Profile switch scope | SmartImage/HDR group + Ambiglow only (§6) | base non-applied modules on `DeviceData`, not the stale `CacheDeviceData` (§5.5 step 7) |
| New profile | snapshot of the current state | – |
| `Theme_ResetCurProfile` | vendor writes 0x04 | **decision for the user**: keep, or reset only the stored profile |
| Names | vendor validator | also reject `.`, `..`, and case-only duplicates (§11 B-1) |
| `data.json` | accept signed and unsigned | – |

### 10.4 Minimal function set for the monitor-only backend

| Status | Functions |
|---|---|
| Implement | `Theme_GetThemeInfos`, `Theme_GetCurTheme`, `Theme_Switch`, `Theme_SwitchApp`, `Theme_Add`, `Theme_Rename`, `Theme_Del`, `Theme_UpdateBindApp`, `Comm_GenAppIcon`, `Theme_AddProfile`, `Theme_CopyProfile`, `Theme_RenameProfile`, `Theme_DelProfile`, `Theme_HandleCycleProfile`, `Theme_ImportProfile`, `Theme_ExportProfile`, `Theme_ResetCurProfile`, `Theme_GetDevicesBasicInfo` (1- and 3-argument forms), `Macro_GetList`, `Macro_GetFuncMenu`, `FactoryReset`, `Setting_GlobalData`, `Setting_TurnOffLightsWhenIdle[Duration]`, `Effect_GetColorData`, `Effect_SetSelfColors` |
| Stub or omit (cloud-only callers) | `Theme_GetProfileDesc` ×2, `Theme_ApplyProfile`, `Theme_GetDevicesBasicInfo(path,int)` |
| Stub (not called) | `Theme_GetCurProfile`, other `Macro_*` |

---

## 11. Vendor bugs and quirks relevant to the port

| ID | Issue | Evidence | Status |
|---|---|---|---|
| B-1 | **Path traversal.** `CheckFileNameValid` accepts `.` and `..`. `Theme_Add("..", validApps)` or `Theme_ApplyProfile("..",…)` would recursively delete `Theme/..` = the whole `EvniaServe` directory before creating the theme. The renderer validator does not block `..`. The hub is unauthenticated and LAN-reachable (14 N33) | `COM/FileUtil.cs:12-19`, `TO:57-61`, `TO:649-653`, `ST:39717-39731` | INFERRED (not executed) |
| B-2 | `Theme_Switch` saves stale `CacheDeviceData` modules into the target profile | `PHL:585-614`, `PHL:1622-1656` | CONFIRMED code / INFERRED effect |
| B-3 | "Reset profile" performs a monitor factory reset (0x04) without saying so | `SO:3277-3293`, `PHL:1998-2006`, `ST:43628-43652` | CONFIRMED |
| B-4 | Non-atomic writes; a torn index silently resets all themes | §8 | CONFIRMED code / INFERRED effect |
| B-5 | `LightMode` in the preview shows `StaticMode` when Ambiglow is off (no ENE) | `PHL:382-389`, `PHLO:56-75` | CONFIRMED code |
| B-6 | Renderer maps import/export error 5 to "Macro parsing error" | `ST:39421-39423` | CONFIRMED |
| B-7 | Wrong or copy-pasted `err_msg` texts: "ThemeAdd…Exist" from Rename; "ThemeCopyProfile…Not Valid" from AddProfile; doubled "Error" in UpdateBindApp | `TO:129,272,149` | CONFIRMED |
| B-8 | `Macro_Import(bOverride)` mixes the current theme's profile list with the target theme's directory | `SO:2420-2488` | INFERRED |
| B-9 | The unsigned legacy `data.json` path bypasses the signature | `SFU:232-233` | CONFIRMED |
| B-10 | Profile names are case-sensitive in the model but share one file on Windows (`Default` vs `default`) | `EN/ThemeInfo.cs:147-150` | INFERRED |
| B-11 | FactoryReset leaves in-memory SoftConfig and the VCP cache alive | §7 | CONFIRMED code |

---

## 12. Corrections to earlier reports

1. **05 §2.5**, display bullet under step 4. The claim was that `ConnectionCkecked` "loads the saved profile content and pushes it to the monitor (`GClass0.DeviceDataCheck` … `ParameterToDevice(..., bForce:true)`)". **Wrong for the display.** The display overrides it with `GClass3.DeviceDataCheck` (`G3:234-250`), which calls `ParameterToDevice(DeviceData)` with **`bForce:false`**. For a non-ENE monitor that writes **no VCP values**: it only adopts `EffectInfo` from the saved profile, then saves. The log confirms it (`LOG/2026-09-26.txt:995-997`: `TotalMilliseconds=3,0051`, caller `CDeviceDisplayBase`1.DeviceDataCheck`). 06 §4.1 step 7 already had this right.
2. **03 §9, bug B3.**
   - The claims that "a fresh non-ENE profile would break the store" and that `new DisplayEffectInfo()`'s `EffectDetail` getter "throws during serialization" are **wrong**. On a fresh profile `DeviceData` comes from `GetDefaultData()`, which sets `EffectInfo = new DisplayEffectInfo()` (non-null) when no ENE is present (`PHL:248-264`). `EffectDetail` does not throw, because `EffectList.ToList()` is the null-safe `COM/Extension.cs:29-47`. A deserialized profile lacking `EffectInfo` also gets a non-null default from the field initializer (`OPT/T_PHLDisplay_Profile.cs:46`).
   - `EffectInfo == null` reaches the renderer only through `ReloadOSD` when `DeviceData` is null (`PHL:562-567` with `CacheDeviceData.EffectInfo = null` at `PHL:381`), e.g. `PHL_ReloadData` after the device data was released.
   - The port recommendation (always send a non-null `EffectInfo`) still stands.
3. **12 §3.3 step 4.** "Afterwards `ParameterToDevice(DeviceData, bForce:false)` pushes stored values to the monitor" is inaccurate. With `bForce:false` and no ENE nothing is written; `DeviceData` is **replaced by the fresh read** except `EffectInfo` (`PHL:568-572`, `PHL:585-614`, `PHL:693-698`). Also, connect runs `DeviceDataCheck`, not `ReloadOSD`; `ReloadOSD` is `PHL_ReloadData`.
4. **13 §4.3.**
   - `Theme_Switch` spans `SO:3019-3052`, not 3016.
   - "The display always gets a full `ParameterToDevice(..., apply=true)` … so every app switch re-sends many DDC writes" overstates it. Only the SmartImage/HDR group and Ambiglow are rewritten. On the user's HDR monitor that is 3 writes (plus `DC` and 1 s if the SmartImage mode differs) (§6).
5. **05 intro and §2.5.** References to "§7" and "§7.6" point to sections missing from the truncated 05. The persistence specification is now this report (§3, §8).
   - Also, `data.json` is opened by the code as `…\config\data.json` (lower case, `CV:17`). It is the same directory on Windows, but the case matters on Linux.
6. **10 §1 and 12 §2.1.** The board-info file is `Config/BoardInfo/<DeviceType enum **name**>.data` (`device.ToString()`, `EN/WorkspacePath.cs:65-68`), not a numeric type.
7. **14 N29.** `importSourceOptions` is at `ST:39390-39398` (`qT`), not 39400-39410.
8. **02 §5.7.** `Theme_ApplyProfile` is labelled "(cloud apply)". The backend function is local-file based and takes any readable `.pcenter` path. Only its single renderer caller is in the cloud UI (§5.5).

---

## 13. Open questions

1. Does VCP `0x04` on the 34M2C8600 also reset input, KVM/USB and Ambiglow settings, and how long is the monitor unresponsive afterwards? The vendor waits a fixed 5 s. This was not observed.
2. How will the Linux backend decide `IsSmartImageHDR`? On Windows it comes from the OS HDR state (06 §4). It selects which group a profile switch re-applies and whether `DC` is written.
3. Should the port keep the vendor's "Reset profile = monitor factory reset" (B-3)? This is a user decision.
4. Are the Newtonsoft reader tolerances (case-insensitive member names, enum names as strings) ever relied on by real files? All four ground-truth files use exact names and integers.
5. Which GNOME Shell extension, or none, is acceptable for focused-app detection on Wayland (13 §4.4)? Without one, app binding works only on X11.
6. Is file birth time available for macro ordering on the target file system? Node `fs.stat().birthtime` needs statx support, with `mtime` as the fallback. This matters only if macros are ever shown.

## 14. Cross-references

- Display profile member list and serializer details: 12 §2–§3.
- VCP semantics and write sequences: 06 §7.
- DDC timing: 07 §8.4.
- Ambiglow/ENE: 09.
- Foreground tracking and icons: 13 §4.
- SignalR envelope and client rules: 02 §4, 05 §3.
- Online inventory: 14 (N29 cloud profiles).
