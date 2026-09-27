# 20 — Enum and ValueList catalog, ValueList rules, and 34M2C8600 JSON fixtures

**Scope.** This report fills gaps left by report 12. That report cites Appendices C and D.1 to D.6 as complete, but they were never written. It also answers open question 2 of report 03: how `DataOSD` turns a capability string into `ValueList` names.

The report covers four things:
- every value enum on the monitor path, with exact `Name`, `Text` and `Value`;
- the rule that builds each `AttributeInfo.ValueList`;
- the computed lists and a full `Profile_GetDeviceData` Tag for the user's Philips 34M2C8600 in its current HDR state;
- the static fixtures (effect menu, effect defaults, constraints, colour palette), plus every renderer place that compares or keys on a ValueList `Name` or `Text`, with i18n coverage.

**Summary.**

- **One rule builds every ValueList** (`PBASE/DataOSD.cs:92-404`, CONFIRMED).
  - The start is `Extension_Enum.GetDatas(enum)`: the enum without `[UnbindEnumExtended]` members, sorted by `Value`.
  - That list is filtered to the capability sub-list bytes (`(byte)e.Value ∈ caps`).
  - There are three exceptions:
    - **DC (SmartImage):** the table is picked by the **last** caps byte, and the `SmartImageHDR_E` part is **appended**.
    - **E2A059 DualResolution, E2A06B Profile and E2A088 GamePQ:** the **capability order** is kept (`smethod_4`).
    - **A5 (PIP/PBP mode):** the list is **replaced** by the table chosen by `F7`.
  - Codes without a sub-list, and codes with no rule, get `ValueList:null`.
  - `MinValue` is always 0 and `StepValue` always 1; nothing in the code base assigns them. `MaxValue` is the maximum the monitor returns on each read.
- **Names are the real C# member names.** 19 members in `Zeasn.PCenter.Entity.Lib` are renamed `const_N` in `work/dotnet-clean`. The real names come from `work/dotnet` (§2.1). The catalogue below never uses `const_N`. On the monitor path the relevant ones are:
  - `HDRPersonal` and 5 other `SmartImageHDR_E` members;
  - `ShootingActionBASS` and `MusicBASS`;
  - `WUHD120Hz` and `WFHD240Hz`;
  - `USBCSetting`;
  - `OP_56_HMoiré` and `OP_58_VMoiré` (both Unbind, so they never reach JSON).
- **The emulation is validated byte for byte.** A scratch emulation of `CDevice_PHLDisplay.method_4` + `method_12` + Newtonsoft ordering was fed the cached capability string (`CAPS`) and the reads from `LOG26`. Projected to the on-disk form (IgnoreProfile, nulls dropped), it reproduces the real `Default.pcenter` `ProfileContent` **byte for byte**: 10812 bytes, sha256 `ccff11e5f491b2525557034706dd464a5f2bd26a3f1c48658984b0f2470c39af`. The UI form in §5 differs only by the code-derived members (`VCPOpCodeName`, `MinValue`, `MaxValue`, `StepValue`, `ValueList`, `HasUSBSetting`, nulls).
- **The user's monitor** (§4): the capability parse yields 65 handled codes, 45 of them with a ValueList. The HDR-state Tag carries 38 non-null ValueLists. DC has 19 entries: 12 SDR + 7 HDR. **`SmartImage_Off` is not offered**, because caps DC has no `0x10`. `Scaling_MaxImage` (the current value 2) is **not** in the 0x86 list.
- **Fixtures (§6).**
  - `Effect_GetMenu(100000)` with ENE model `34M2C8600` and without ENE.
  - `DisplayEffectInfo.Default`. It is **not** identical to the stored profile, which is a correction to report 12: `CurrEffect` and `EffectDetail` differ (Static vs FollowVideo).
  - The EffectInfo a fresh install or `Profile_Reset` without ENE produces (`EffectList:null`, `CurrEffect.Value 0`).
  - The current-state `DisplayFuncConstraints`.
  - The default `EffectColorData`.
- **Renderer (§7).**
  - Every ValueList `Name` that reaches a Select, Radio, Menu, Cascader, Checkbox or Equalizer is used as an **i18n key** (`$t(name)`; a missing key shows the key raw).
  - On the user's monitor every reachable name has a key in all 10 languages, except by-design numeric labels: `"1.0"`, `"1.5"`, `"2.0"` (Smart Sniper size), `"1"`..`"4"` (OSD transparency) and the PowerLED digits `"0"`..`"4"`.
  - OSD language names are shown from `Text`.
  - 39 other enum names lack keys and would show raw on other monitors. `SmartImage_Games` and `ColorFlow` are examples.
- **Corrections** to reports 12 and 06 are in §8. The most important:
  - Report 12's `OP_DA_ScanMode` constraint rule is inverted.
  - Report 12's "DisplayEffectInfo.Default is byte-identical to the stored profile" is false.
  - DualResolution trimming only happens when Overclock is *available*.

---

## 0. Conventions and evidence

- **Paths.**
  - `ENT/` = `work/dotnet-clean/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/`
  - `ENTO/` = `work/dotnet/Zeasn.PCenter.Entity.Lib/Zeasn.PCenter.Entity.Lib/` (obfuscated originals)
  - `PBASE/` = `work/dotnet-clean/Zeasn.PCenter.Base.Lib/Zeasn.PCenter.Base.Lib/`
  - `OPT/` = `work/dotnet-clean/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib/`
  - `PHL/` = `work/dotnet-clean/Zeasn.Equipment.Option.Lib/Zeasn.Equipment.Option.Lib.PHLDisplay/`
  - `COM/` = `work/dotnet-clean/Zeasn.Com.Lib/Zeasn.Com.Lib/`
  - `CORE/` = `work/dotnet-clean/Zeasn.Framework.Core.Lib/Zeasn.Framework.Core.Lib/`
  - `EBASE/` = `work/dotnet-clean/Zeasn.Equipment.Base.Lib/Zeasn.Equipment.Base.Lib/`
  - `R/` = `work/app-pretty/renderer/assets/`
- **Runtime artefacts.**
  - `LOG26` = `%APPDATA%/EvniaServe/logs/2026-09-26.txt`; `LOG25` = `…/2026-09-25.txt`
  - `PROF` = the `ProfileContent` string inside `%APPDATA%/EvniaServe/Theme/User/Default.pcenter`
  - `CAPS` = `%APPDATA%/EvniaServe/Config/data.json`. Strip the BOM, parse `{data,sign}`, then take `data[0].Datas[0]`, key `v1.01_0f`.
- **Evidence labels.**
  - **CONFIRMED** means read in code or seen in a runtime artefact. File and line are given.
  - **INFERRED** means reasoned from library behaviour (for example Newtonsoft member order) or not directly observed.
  - The whole-object fixtures in §5 and §6 are **computed**, because there is no wire capture of `Profile_GetDeviceData` (see §5 for provenance). Their building rules are CONFIRMED. Their profile-form projection is CONFIRMED against `PROF`.
- **Enum extraction.**
  - All 98 enums in `Zeasn.PCenter.Entity.Lib` were parsed from both trees.
  - Members, values, `[Description]` texts and `[UnbindEnumExtended]` flags match 1:1 between the trees.
  - Only 19 member names differ (§2.1).
  - Member line numbers are identical in both trees. The `ENT/` lines are cited.
- **Capability parse (CONFIRMED).** The parsed dictionary used here equals the one EvniaServe logged at `LOG26:542-627` (`| INFO | 5. 匹配完毕的 VCP`), entry by entry. Examples:
  - `E2A020(02 03 04  0F)` (with the double space) parses to `[02,03,04,0F]`;
  - `86(... 23)87` parses to two items;
  - `F7(42)FD FF` parses to `F7:[42]`, `FD:[]`, `FF:[]`.
- **Hex in logs.** `Hub Get*Value ... value=XX maxValue=YY` are **hexadecimal**. Evidence: `e2a01a maxValue=0d`, and `dc value=21` = 33 = PROF `OP_DC.Value`.

---

## 1. How a `ValueList` is built (answers report 03 open question 2)

### 1.1 `EnumItem`, `GetItem`, `GetDatas` (CONFIRMED)

- **`EnumItem`** (`COM/EnumItem.cs:7-63`) serializes as `{"Name","Text","Value"}`. `CompareTo` returns `Value - other.Value` (`:60-63`).
- **`e.GetItem()`** (`COM/Extension_Enum.cs:26-34`) returns:
  - `Name = e.ToString()`;
  - `Text` = the first `[Description]`, else the name;
  - `Value = e.GetHashCode()` (the integer value for these `int` enums).
  - It does **not** look at `[UnbindEnumExtended]`. This is why `EffectType.Off` (not Unbind) and even an Unbind member can be emitted when code calls `GetItem()` directly.
- **`GetDatas(Type, bSort=true)`** (`COM/Extension_Enum.cs:108-148`):
  - iterates `type.GetFields(Static|Public)`;
  - **skips `[UnbindEnumExtended]`** (`:116-119`);
  - sets `Name` = field name and `Text` = `[Description]` or name (`:122-139`);
  - then `List.Sort()` by `Value` (`:143-146`).
  - No enum in the corpus has duplicate values, so the result is deterministic even though `List.Sort` is unstable.
- **`EnumItemCompare`** (`OPT/EnumItemCompare.cs:6-20`) compares on `Value` only. `GetHashCode` is `Value.GetHashCode()`. It is used for the LINQ `Intersect` and `Except` below.
  - Both keep the **first** sequence's objects and order. So names and texts always come from the first list.

### 1.2 Capability string → `DataOSD.SupportOSDList` (CONFIRMED)

- **Parse.** `ComUtil.AnalyseVcpString` (`COM/ComUtil.cs:124-238`) produces an insertion-ordered `Dictionary<int, List<byte>>`. Duplicate sub-bytes are dropped (`:171-179`).
- **Build.** `DataOSD.InitDisplayInfo` (`PBASE/DataOSD.cs:92-138`) walks the dictionary in capability order:
  1. If the code's value is in `StandardList` (the `GetDatas(StandardVCPOpCode_E)` result, i.e. the 32 bound standard codes, `:15`), it creates `new AttributeInfo(code)`. If the sub-list is non-empty it runs `smethod_1` (`:109-118`).
  2. Else, if it is in `E2A0_ExternList` (89 bound E2A0 codes, `:17`), it creates the attribute and runs `smethod_2` when the sub-list is non-empty (`:119-128`).
  3. Else it logs `UnHandle vcpCode = N` (`:131`). On the 34M2C8600 the unhandled codes are:
     `02 05 08 0B 0C 52 6C 6E 70 AC AE B2 B6 C0 C6 C8 CA DF FD FF`
- **Consequence for bound codes.** A bound code with an empty sub-list, or with no `case`, keeps `ValueList = null`. Examples: `10 12 16 18 1A 62 87 A4 A5 F6`, `E2A00A..0F`, `E2A038`, `E2A039`, and `E2A042` despite its 16 caps bytes.

### 1.3 Per-code rule: `smethod_1` / `smethod_2` → `smethod_3` / `smethod_4` (CONFIRMED)

- **`smethod_3(enum, caps)`** (`PBASE/DataOSD.cs:384-389`) returns `GetDatas(enum)` (sorted) where `caps.Contains((byte)e.Value)`.
  - The `(byte)` truncation would matter only for enums with values ≥ 256. None of the `smethod_3` enums has such values; the A5 tables with 0x100 and up are not built this way.
- **`smethod_4(enum, caps)`** (`:391-404`) walks the **caps bytes in capability order**. It looks each byte up in the unsorted `GetDatas(enum)`. Bytes without a member are skipped.
- **DC** (`:195-221`):
  1. The last caps byte is parsed as `VCP_DC_SmartImage` (225..228 → `SmartImage_E1..E4`).
  2. The matching table goes through `smethod_3`.
  3. `smethod_3(SmartImageHDR_E, caps)` is `AddRange`d after it.
  4. If the last byte is not 0xE1..0xE4, `Enum.Parse` still succeeds with an undefined value, no case matches, and the list is the HDR part alone.
- **F7 → A5** (`:406-431`):
  - `PIPPBPEnable(out list)` takes `F7.ValueList[0].Value`: 2, 3 or 4 → `VCP_A5_PIPPBPType_02/03/04_E`; 64, 66, 67 or 68 → `_40/42/43/44_E`.
  - It returns the sorted `GetDatas` of that table.
  - It is true only if the table is non-empty.
- **EC** (`:232-233`): `VCP_EC_PIP_Size` only. The location half of the packed value has its own fixed list (§1.4).
- **The complete code→enum map** is table §3 (column "ValueList source", with the exact `case` line).

### 1.4 From the global list to the module attribute, and load-time rules (CONFIRMED)

- **Copy.** `Extension_AttributeInfo.GetValue<T>` (`PBASE/Extension_AttributeInfo.cs:33-59`) looks at every `AttributeInfo`-typed property. It finds the global attribute by `VCPOpCodeName`.
  - If the global attribute is available, the module attribute gets the **same `List` instance** when its own list is empty (`:47-50`), and then it is read (`:51`, `:68-120`).
  - Otherwise `SetErrMsg` sets `err_code` 9 (`:53-56`).
  - A read sets only `Value` (int), `MaxValue` and `err_code` (`:92-94`, `:107-109`).
- **`CDevice_PHLDisplay.method_4`** (`PHL/CDevice_PHLDisplay.cs:296-468`) then applies these rules:
  - **SmartImage split** (`:333-353`). In HDR, `ModuleSmartImageHDR.Items = DC.ValueList ∩ GetDatas(SmartImageHDR_E)`. Otherwise `ModuleSmartImage.Items = DC.ValueList − SmartImageHDR_E`. The other `Items` keeps its initializer `[]` (`OPT/DisplayModuleSmartImage.cs:9`, `OPT/DisplayModuleSmartImageHDR.cs:9`).
  - **DualResolution** (`:355-378`):
    1. Clone the attribute.
    2. `Value = raw & 0xFF`, `hi = raw >> 8`.
    3. If `0 < hi < Count` **and** `EXT_OP_E2A0_4C_Overclock.IsAvailable`: when Overclock is ON, `RemoveRange(0, hi)`; otherwise `RemoveRange(hi, Count-hi)`.
    4. After the input is known (`:445-459`), remove `UHD120Hz` (0) when `InputSource ∈ {15, 16, 21, 22}`.
  - **Ambiglow without ENE** (`:382-389`): `EffectEnable = E2A019 available && Value != 0`. If false, `E2A019.Value = 7` (`StaticMode`).
  - **Input** (`:391-420`):
    - `InputSourceList = OP_60.ValueList ∩ GetDatas(VCP_60_InputSource_E)`;
    - `PIPPBPSourceList = OP_60.ValueList ∩ GetDatas(VCP_60_PIPPBPSource_E)`;
    - `InputSourceInfo` = the byte split of 0x60 (the PIP source defaults to 34, then 47);
    - if A5 is available and `PIPPBPEnable`: `A5.ValueList = F7 table`, `Mode = A5`, `Size/Location` = the byte split of EC.
    - `PIPLocationList` is a get-only property returning `GetDatas(VCP_EC_PIP_Location)` (`OPT/DisplayModuleInput.cs:146`). It is not filtered by caps.
  - **EQ** (`:421-440`): for each item of the **global** `E2A001.ValueList`, write the band, sleep 100 ms, read E2A039, and add `{Name=item.Name, Index=item.Value, Value, MaxValue}` (`OPT/GClass0.cs`).
- **Where the UI Tag comes from.** `DeviceData`, which `Profile_GetDeviceData` returns (`EBASE/GClass0.cs:163-166`), is always `CacheDeviceData.ToCloning()` after `ParameterToDevice` (`PHL/…:600`).
  - It is not the profile read from disk. `DeviceDataCheck` loads `PROF` (`EBASE/GClass0.cs:173-189`), which has no ValueLists, only to push values.
  - `method_12` copies `EffectInfo` from the stored profile when there is no ENE (`PHL/…:695`).
  - `ToCloning` is a default-mode `JsonSerialize`/`JsonDeserialize` round trip (`COM/Extension_Object.cs:18-29`). It preserves `ValueList`, `VCPOpCodeName`, `MinValue`, `MaxValue` and `StepValue`, and drops only `[JsonIgnore]` members.

### 1.5 `AttributeInfo` in each serializer mode (CONFIRMED `ENT/AttributeInfo.cs:8-237`)

| Member | Default | Attribute | UI (`Profile_GetDeviceData`, IgnoreUI, nulls kept) | other hub replies (default) | profile on disk (IgnoreProfile, nulls dropped) |
|---|---|---|---|---|---|
| `VCPOpCode` | code | — | yes | yes | yes |
| `VCPOpCodeName` | enum member name (ctor `:194-222`) | `JsonIgnoreEx(IgnoreProfile)` `:54` | yes | yes | no |
| `VCPOpCodeDesc` | `[Description]` | `[JsonIgnore]` `:69` | no | no | no |
| `IsAvailable` | `err_code==0` | `[JsonIgnore]` `:84` | no | no | no |
| `Value` | null | — | yes (null kept) | yes | only when non-null |
| `MinValue` | 0 (never assigned) | IgnoreProfile `:101` | yes | yes | no |
| `MaxValue` | 0 | IgnoreProfile `:116` | yes | yes | no |
| `StepValue` | **1** (`int_3 = 1`, `:29`; never assigned) | IgnoreProfile `:131` | yes | yes | no |
| `ValueList` | null | IgnoreProfile `:146` | yes (null kept) | yes | no |
| `err_code` | 0 | — | yes | yes | yes |
| `err_msg` | "" | `[JsonIgnore]` `:175` | no | no | no |

**Port note (INFERRED from `R/styles-DAnQi2A8.js:9297-9314`).** Keep `"ValueList":null` in UI replies. The renderer's `rd()` sends an attribute through `Xu` (which turns `null` into `[]`) only when the key `ValueList` **exists**. If the key is absent, `.ValueList` stays `undefined`. Then `ambiglowTitle` (`:9391-9394`, `ValueList.some`) and `System-DT9nKs1q.js:412` (`ValueList.forEach`) would throw.

### 1.6 Port algorithm (reference, INFERRED; validated by the byte-exact PROF reproduction)

```js
// catalog = §2 JSON blocks; caps = ordered Map<int code, int[] subBytes> (after the vendor parse rules of §1.2)
const datas = (en, sort = true) => { const l = catalog[en].members.filter(m => !m.Unbind)
  .map(m => ({ Name: m.Name, Text: m.Text, Value: m.Value })); return sort ? l.sort((a, b) => a.Value - b.Value) : l; };
const s3 = (en, sub) => datas(en).filter(e => sub.includes(e.Value & 0xFF));
const s4 = (en, sub) => sub.map(b => datas(en, false).find(e => e.Value === b)).filter(Boolean);
function globalValueList(code, sub) {                 // null unless a rule matches and sub.length > 0
  if (!sub.length) return null;
  if (code === 0xDC) { const t = { 0xE1: 'SmartImage_E1', 0xE2: 'SmartImage_E2', 0xE3: 'SmartImage_E3', 0xE4: 'SmartImage_E4' }[sub.at(-1)];
                       return [...(t ? s3(t, sub) : []), ...s3('SmartImageHDR_E', sub)]; }
  if (RULE_S4[code]) return s4(RULE_S4[code], sub);   // 0xE2A059, 0xE2A06B, 0xE2A088
  if (RULE_S3[code]) return s3(RULE_S3[code], sub);   // table §3
  return null;
}
```

---

## 2. (a) Enum catalog (monitor path)

### 2.1 Real names of the renamed members (CONFIRMED by diff `ENT/` vs `ENTO/`)

These are all the renames in Entity.Lib. The rows marked with ★ are on the monitor path.

| Enum | `dotnet-clean` | **real name** (use this) | Value | `ENT/` line |
|---|---|---|---|---|
| `ButtonFunc` | `const_214` | **`PShiftKey`** | 912 | `ENT/ButtonFunc.cs:438` |
| `ButtonMenu` | `const_5` | **`SwitchDPI`** | 4 | `ENT/ButtonMenu.cs:20` |
| `ButtonMenu` | `const_12` | **`PShiftKey`** | 11 | `ENT/ButtonMenu.cs:34` |
| `E2A0_00_AudioMode_E` ★ | `const_15` | **`ShootingActionBASS`** | 82 | `ENT/E2A0_00_AudioMode_E.cs:38` |
| `E2A0_00_AudioMode_E` ★ | `const_17` | **`MusicBASS`** | 84 | `ENT/E2A0_00_AudioMode_E.cs:42` |
| `E2A0_59_DualResolution_E` ★ | `const_12` | **`WUHD120Hz`** | 9 | `ENT/E2A0_59_DualResolution_E.cs:32` |
| `E2A0_59_DualResolution_E` ★ | `const_13` | **`WFHD240Hz`** | 16 | `ENT/E2A0_59_DualResolution_E.cs:34` |
| `E2A0_SettingUser_E` ★ | `const_8` | **`USBCSetting`** | 8 | `ENT/E2A0_SettingUser_E.cs:24` |
| `KeyboardGameModeType` | `const_4` | **`SwitchWASD`** | 100 | `ENT/KeyboardGameModeType.cs:16` |
| `Notification_Func` | `const_2` | **`NotifyUISwitchTheme`** | 2 | `ENT/Notification_Func.cs:7` |
| `Notification_Func` | `const_7` | **`NotifyMouseDPIChange`** | 7 | `ENT/Notification_Func.cs:12` |
| `SmartImageHDR_E` ★ | `const_4` | **`HDRPersonal`** | 36 | `ENT/SmartImageHDR_E.cs:16` |
| `SmartImageHDR_E` ★ | `const_5` | **`HDRNormal`** | 37 | `ENT/SmartImageHDR_E.cs:18` |
| `SmartImageHDR_E` ★ | `const_8` | **`HDRRec2020`** | 40 | `ENT/SmartImageHDR_E.cs:24` |
| `SmartImageHDR_E` ★ | `const_11` | **`HDRRec709`** | 43 | `ENT/SmartImageHDR_E.cs:30` |
| `SmartImageHDR_E` ★ | `const_12` | **`HDRPremium`** | 44 | `ENT/SmartImageHDR_E.cs:32` |
| `SmartImageHDR_E` ★ | `const_13` | **`HDREffect`** | 45 | `ENT/SmartImageHDR_E.cs:34` |
| `StandardVCPOpCode_E` ★ | `const_86` | **`OP_56_HMoiré`** | 86 | `ENT/StandardVCPOpCode_E.cs:186` |
| `StandardVCPOpCode_E` ★ | `const_88` | **`OP_58_VMoiré`** | 88 | `ENT/StandardVCPOpCode_E.cs:190` |

Report 12 §2.6 also lists two Option.Lib renames: `DisplayHotKeyFunc.const_5/const_7` = `GamePQOff`/`GamePQNegativeEffect`. They are dead code in 1.13.0 (report 12 §3.7).

### 2.2 Catalog format

- **One block per enum:** `{"enum":…,"members":[{"Name","Text","Value","Unbind"}]}`.
- **Order.** Members are sorted by `Value`, which is the order `GetDatas` yields.
- **Unbind members.** `"Unbind":true` marks `[UnbindEnumExtended]` members. **`GetDatas` omits them**, so they never appear in a `ValueList`, `StandardList` or `E2A0_ExternList`. They are listed here for completeness and for direct `GetItem()` users.
- **`Text`** is the `[Description]` string exactly as written (C# escapes resolved: `17"` is `17\"` in JSON), or the name when there is none.
- **Non-ASCII texts are exact UTF-8.** Examples: `EffectType` Chinese texts, `VCP_CC_OSDLanguage` native names, `OP_56_HMoiré`. They match `PROF` and `LOG25`/`LOG26` byte for byte where they appear (for example `光影同步`, `恒亮模式`).
- **Declaration order vs value order.** Declaration order differs from value order in these enums: `E2A0_19_AmbiglowLightMode_E` (9 before 8), `E2A0_59_DualResolution_E`, `VCP_72_Gamma` (122 last), `DirectionType` (5 before 4), and `E2A0_42_ResetSmartImage_E` (the only five in this catalog). `E2A0_HDMIRefreshRate_E` is declared in value order, but its values do not follow refresh-rate order (16 = 160 Hz). `smethod_4` lists (DualResolution, Profile, GamePQ) use **capability order**, not either of these.

#### Opcode enums (VCPOpCodeName / FuncName / StandardList / E2A0_ExternList)

`StandardVCPOpCode_E` — `ENT/StandardVCPOpCode_E.cs:6`, 256 members, 224 `[UnbindEnumExtended]`; renamed in `work/dotnet-clean` (real names used here): `const_86`→`OP_56_HMoiré`, `const_88`→`OP_58_VMoiré`

```json
{"enum":"StandardVCPOpCode_E","members":[
  {"Name":"OP_00_NULL","Text":"OP_00_NULL","Value":0,"Unbind":true},
  {"Name":"OP_01_Degauss","Text":"OP_01_Degauss","Value":1,"Unbind":true},
  {"Name":"OP_02_NewControlValue","Text":"OP_02_NewControlValue","Value":2,"Unbind":true},
  {"Name":"OP_03_SoftControls","Text":"OP_03_SoftControls","Value":3,"Unbind":true},
  {"Name":"OP_04_RestoreFactoryDefaults","Text":"重置OSD","Value":4,"Unbind":false},
  {"Name":"OP_05_RestoreFactoryLumContrastDef","Text":"OP_05_RestoreFactoryLumContrastDef","Value":5,"Unbind":true},
  {"Name":"OP_06_RestoreFactoryGeometryDefaults","Text":"OP_06_RestoreFactoryGeometryDefaults","Value":6,"Unbind":true},
  {"Name":"OP_07_NULL","Text":"OP_07_NULL","Value":7,"Unbind":true},
  {"Name":"OP_08_RestoreFactoryColorDefaults","Text":"OP_08_RestoreFactoryColorDefaults","Value":8,"Unbind":true},
  {"Name":"OP_09_NULL","Text":"OP_09_NULL","Value":9,"Unbind":true},
  {"Name":"OP_0A_RestoreFactoryTVDefaults","Text":"OP_0A_RestoreFactoryTVDefaults","Value":10,"Unbind":true},
  {"Name":"OP_0B_ColorTemperatureIncrement","Text":"OP_0B_ColorTemperatureIncrement","Value":11,"Unbind":true},
  {"Name":"OP_0C_ColorTemperatureRequest","Text":"OP_0C_ColorTemperatureRequest","Value":12,"Unbind":true},
  {"Name":"OP_0D_NULL","Text":"OP_0D_NULL","Value":13,"Unbind":true},
  {"Name":"OP_0E_Clock","Text":"VGA 信号中 的总时钟Clock","Value":14,"Unbind":true},
  {"Name":"OP_0F_NULL","Text":"OP_0F_NULL","Value":15,"Unbind":true},
  {"Name":"OP_10_Luminance","Text":"亮度","Value":16,"Unbind":false},
  {"Name":"OP_11_FleshToneEnhancement","Text":"OP_11_FleshToneEnhancement","Value":17,"Unbind":true},
  {"Name":"OP_12_Contrast","Text":"对比度","Value":18,"Unbind":false},
  {"Name":"OP_13_BacklightControl","Text":"OP_13_BacklightControl","Value":19,"Unbind":true},
  {"Name":"OP_14_SelectColorPreset","Text":"色温","Value":20,"Unbind":false},
  {"Name":"OP_15_NULL","Text":"OP_15_NULL","Value":21,"Unbind":true},
  {"Name":"OP_16_VideoGainDriveRed","Text":"红色色温占比","Value":22,"Unbind":false},
  {"Name":"OP_17_UserColorVisionCompensation","Text":"OP_17_UserColorVisionCompensation","Value":23,"Unbind":true},
  {"Name":"OP_18_VideoGainDriveGreen","Text":"绿色色温占比","Value":24,"Unbind":false},
  {"Name":"OP_19_NULL","Text":"OP_19_NULL","Value":25,"Unbind":true},
  {"Name":"OP_1A_VideoGainDriveBlue","Text":"蓝色色温占比","Value":26,"Unbind":false},
  {"Name":"OP_1B_NULL","Text":"OP_1B_NULL","Value":27,"Unbind":true},
  {"Name":"OP_1C_Focus","Text":"OP_1C_Focus","Value":28,"Unbind":true},
  {"Name":"OP_1D_NULL","Text":"OP_1D_NULL","Value":29,"Unbind":true},
  {"Name":"OP_1E_AutoSetup","Text":"vag自动调整","Value":30,"Unbind":true},
  {"Name":"OP_1F_AutoColorSetup","Text":"OP_1F_AutoColorSetup","Value":31,"Unbind":true},
  {"Name":"OP_20_HorizontalPositionPhase","Text":"Horizontal Position","Value":32,"Unbind":true},
  {"Name":"OP_21_NULL","Text":"OP_21_NULL","Value":33,"Unbind":true},
  {"Name":"OP_22_HorizontalSize","Text":"OP_22_HorizontalSize","Value":34,"Unbind":true},
  {"Name":"OP_23_NULL","Text":"OP_23_NULL","Value":35,"Unbind":true},
  {"Name":"OP_24_HorizontalPincushion","Text":"OP_24_HorizontalPincushion","Value":36,"Unbind":true},
  {"Name":"OP_25_NULL","Text":"OP_25_NULL","Value":37,"Unbind":true},
  {"Name":"OP_26_HorizontalPincushionBalance","Text":"OP_26_HorizontalPincushionBalance","Value":38,"Unbind":true},
  {"Name":"OP_27_NULL","Text":"OP_27_NULL","Value":39,"Unbind":true},
  {"Name":"OP_28_HorizontalConvergenceRB","Text":"OP_28_HorizontalConvergenceRB","Value":40,"Unbind":true},
  {"Name":"OP_29_HorizontalConvergenceMG","Text":"OP_29_HorizontalConvergenceMG","Value":41,"Unbind":true},
  {"Name":"OP_2A_HorizontalLinearity","Text":"OP_2A_HorizontalLinearity","Value":42,"Unbind":true},
  {"Name":"OP_2B_NULL","Text":"OP_2B_NULL","Value":43,"Unbind":true},
  {"Name":"OP_2C_HorizontalLinearityBalance","Text":"OP_2C_HorizontalLinearityBalance","Value":44,"Unbind":true},
  {"Name":"OP_2D_NULL","Text":"OP_2D_NULL","Value":45,"Unbind":true},
  {"Name":"OP_2E_GrayScaleExpansion","Text":"OP_2E_GrayScaleExpansion","Value":46,"Unbind":true},
  {"Name":"OP_2F_NULL","Text":"OP_2F_NULL","Value":47,"Unbind":true},
  {"Name":"OP_30_VerticalPositionPhase","Text":"Vertical Position","Value":48,"Unbind":true},
  {"Name":"OP_31_NULL","Text":"OP_31_NULL","Value":49,"Unbind":true},
  {"Name":"OP_32_VerticalSize","Text":"OP_32_VerticalSize","Value":50,"Unbind":true},
  {"Name":"OP_33_NULL","Text":"OP_33_NULL","Value":51,"Unbind":true},
  {"Name":"OP_34_VerticalPincushion","Text":"OP_34_VerticalPincushion","Value":52,"Unbind":true},
  {"Name":"OP_35_NULL","Text":"OP_35_NULL","Value":53,"Unbind":true},
  {"Name":"OP_36_VerticalPincushionBalance","Text":"OP_36_VerticalPincushionBalance","Value":54,"Unbind":true},
  {"Name":"OP_37_NULL","Text":"OP_37_NULL","Value":55,"Unbind":true},
  {"Name":"OP_38_VerticalConvergenceRB","Text":"OP_38_VerticalConvergenceRB","Value":56,"Unbind":true},
  {"Name":"OP_39_VerticalConvergenceMG","Text":"OP_39_VerticalConvergenceMG","Value":57,"Unbind":true},
  {"Name":"OP_3A_VerticalLinearity","Text":"OP_3A_VerticalLinearity","Value":58,"Unbind":true},
  {"Name":"OP_3B_NULL","Text":"OP_3B_NULL","Value":59,"Unbind":true},
  {"Name":"OP_3C_VerticalLinearityBalance","Text":"OP_3C_VerticalLinearityBalance","Value":60,"Unbind":true},
  {"Name":"OP_3D_NULL","Text":"OP_3D_NULL","Value":61,"Unbind":true},
  {"Name":"OP_3E_ClockPhase","Text":"VGA 相位","Value":62,"Unbind":true},
  {"Name":"OP_3F_NULL","Text":"OP_3F_NULL","Value":63,"Unbind":true},
  {"Name":"OP_40_HorizontalParallelogram","Text":"OP_40_HorizontalParallelogram","Value":64,"Unbind":true},
  {"Name":"OP_41_VerticalParallelogram","Text":"OP_41_VerticalParallelogram","Value":65,"Unbind":true},
  {"Name":"OP_42_HorizontalKeystone","Text":"OP_42_HorizontalKeystone","Value":66,"Unbind":true},
  {"Name":"OP_43_VerticalKeystone","Text":"OP_43_VerticalKeystone","Value":67,"Unbind":true},
  {"Name":"OP_44_Rotation","Text":"OP_44_Rotation","Value":68,"Unbind":true},
  {"Name":"OP_45_NULL","Text":"OP_45_NULL","Value":69,"Unbind":true},
  {"Name":"OP_46_TopCornerFlare","Text":"OP_46_TopCornerFlare","Value":70,"Unbind":true},
  {"Name":"OP_47_NULL","Text":"OP_47_NULL","Value":71,"Unbind":true},
  {"Name":"OP_48_TopCornerHook","Text":"OP_48_TopCornerHook","Value":72,"Unbind":true},
  {"Name":"OP_49_NULL","Text":"OP_49_NULL","Value":73,"Unbind":true},
  {"Name":"OP_4A_BottomCornerFlare","Text":"OP_4A_BottomCornerFlare","Value":74,"Unbind":true},
  {"Name":"OP_4B_NULL","Text":"OP_4B_NULL","Value":75,"Unbind":true},
  {"Name":"OP_4C_BottomCornerHook","Text":"OP_4C_BottomCornerHook","Value":76,"Unbind":true},
  {"Name":"OP_4D_NULL","Text":"OP_4D_NULL","Value":77,"Unbind":true},
  {"Name":"OP_4E_NULL","Text":"OP_4E_NULL","Value":78,"Unbind":true},
  {"Name":"OP_4F_NULL","Text":"OP_4F_NULL","Value":79,"Unbind":true},
  {"Name":"OP_50_NULL","Text":"OP_50_NULL","Value":80,"Unbind":true},
  {"Name":"OP_51_NULL","Text":"OP_51_NULL","Value":81,"Unbind":true},
  {"Name":"OP_52_ActiveControl","Text":"OP_52_ActiveControl","Value":82,"Unbind":true},
  {"Name":"OP_53_NULL","Text":"OP_53_NULL","Value":83,"Unbind":true},
  {"Name":"OP_54_PerformancePreservation","Text":"Pixel Orbiting","Value":84,"Unbind":false},
  {"Name":"OP_55_NULL","Text":"OP_55_NULL","Value":85,"Unbind":true},
  {"Name":"OP_56_HMoiré","Text":"OP_56_HMoiré","Value":86,"Unbind":true},
  {"Name":"OP_57_NULL","Text":"OP_57_NULL","Value":87,"Unbind":true},
  {"Name":"OP_58_VMoiré","Text":"OP_58_VMoiré","Value":88,"Unbind":true},
  {"Name":"OP_59_6AxisSaturationControlRed","Text":"OP_59_6AxisSaturationControlRed","Value":89,"Unbind":true},
  {"Name":"OP_5A_6AxisSaturationControlYellow","Text":"OP_5A_6AxisSaturationControlYellow","Value":90,"Unbind":true},
  {"Name":"OP_5B_6AxisSaturationControlGreen","Text":"OP_5B_6AxisSaturationControlGreen","Value":91,"Unbind":true},
  {"Name":"OP_5C_6AxisSaturationControlCyan","Text":"OP_5C_6AxisSaturationControlCyan","Value":92,"Unbind":true},
  {"Name":"OP_5D_6AxisSaturationControlBlue","Text":"OP_5D_6AxisSaturationControlBlue","Value":93,"Unbind":true},
  {"Name":"OP_5E_6AxisSaturationControlMagenta","Text":"OP_5E_6AxisSaturationControlMagenta","Value":94,"Unbind":true},
  {"Name":"OP_5F_NULL","Text":"OP_5F_NULL","Value":95,"Unbind":true},
  {"Name":"OP_60_InputSource","Text":"PIPPB信号源","Value":96,"Unbind":false},
  {"Name":"OP_61_NULL","Text":"OP_61_NULL","Value":97,"Unbind":true},
  {"Name":"OP_62_AudioSpeakerVolume","Text":"显示器声音","Value":98,"Unbind":false},
  {"Name":"OP_63_AudioSpeakerPairSelect","Text":"OP_63_AudioSpeakerPairSelect","Value":99,"Unbind":true},
  {"Name":"OP_64_AudioMicrophoneVolume","Text":"OP_64_AudioMicrophoneVolume","Value":100,"Unbind":true},
  {"Name":"OP_65_NULL","Text":"OP_65_NULL","Value":101,"Unbind":true},
  {"Name":"OP_66_AmbientLightSensor","Text":"OP_66_AmbientLightSensor","Value":102,"Unbind":true},
  {"Name":"OP_67_NULL","Text":"OP_67_NULL","Value":103,"Unbind":true},
  {"Name":"OP_68_NULL","Text":"OP_68_NULL","Value":104,"Unbind":true},
  {"Name":"OP_69_NULL","Text":"OP_69_NULL","Value":105,"Unbind":true},
  {"Name":"OP_6A_NULL","Text":"OP_6A_NULL","Value":106,"Unbind":true},
  {"Name":"OP_6B_NULL","Text":"OP_6B_NULL","Value":107,"Unbind":true},
  {"Name":"OP_6C_Video__BlackLevelRed","Text":"OP_6C_Video__BlackLevelRed","Value":108,"Unbind":true},
  {"Name":"OP_6D_NULL","Text":"OP_6D_NULL","Value":109,"Unbind":true},
  {"Name":"OP_6E_Video__BlackLevelGreen","Text":"OP_6E_Video__BlackLevelGreen","Value":110,"Unbind":true},
  {"Name":"OP_6F_NULL","Text":"OP_6F_NULL","Value":111,"Unbind":true},
  {"Name":"OP_70_Video__BlackLevelBlue","Text":"OP_70_Video__BlackLevelBlue","Value":112,"Unbind":true},
  {"Name":"OP_71_NULL","Text":"OP_71_NULL","Value":113,"Unbind":true},
  {"Name":"OP_72_Gamma","Text":"伽马值","Value":114,"Unbind":false},
  {"Name":"OP_73_LUTSize","Text":"OP_73_LUTSize","Value":115,"Unbind":true},
  {"Name":"OP_74_SinglePointLUTOperation","Text":"OP_74_SinglePointLUTOperation","Value":116,"Unbind":true},
  {"Name":"OP_75_BlockLUTOperation","Text":"OP_75_BlockLUTOperation","Value":117,"Unbind":true},
  {"Name":"OP_76_RemoteProcedureCall","Text":"OP_76_RemoteProcedureCall","Value":118,"Unbind":true},
  {"Name":"OP_77_NULL","Text":"OP_77_NULL","Value":119,"Unbind":true},
  {"Name":"OP_78_EDIDOperation","Text":"OP_78_EDIDOperation","Value":120,"Unbind":true},
  {"Name":"OP_79_NULL","Text":"OP_79_NULL","Value":121,"Unbind":true},
  {"Name":"OP_7A_NULL","Text":"OP_7A_NULL","Value":122,"Unbind":true},
  {"Name":"OP_7B_NULL","Text":"OP_7B_NULL","Value":123,"Unbind":true},
  {"Name":"OP_7C_AdjustZoom","Text":"OP_7C_AdjustZoom","Value":124,"Unbind":true},
  {"Name":"OP_7D_NULL","Text":"OP_7D_NULL","Value":125,"Unbind":true},
  {"Name":"OP_7E_NULL","Text":"OP_7E_NULL","Value":126,"Unbind":true},
  {"Name":"OP_7F_NULL","Text":"OP_7F_NULL","Value":127,"Unbind":true},
  {"Name":"OP_80_NULL","Text":"OP_80_NULL","Value":128,"Unbind":true},
  {"Name":"OP_81_NULL","Text":"OP_81_NULL","Value":129,"Unbind":true},
  {"Name":"OP_82_HorizontalMirrorFlip","Text":"OP_82_HorizontalMirrorFlip","Value":130,"Unbind":true},
  {"Name":"OP_83_NULL","Text":"OP_83_NULL","Value":131,"Unbind":true},
  {"Name":"OP_84_VerticalMirrorFlip","Text":"OP_84_VerticalMirrorFlip","Value":132,"Unbind":true},
  {"Name":"OP_85_NULL","Text":"OP_85_NULL","Value":133,"Unbind":true},
  {"Name":"OP_86_DisplayScaling","Text":"图像比例","Value":134,"Unbind":false},
  {"Name":"OP_87_Sharpness","Text":"高清晰度","Value":135,"Unbind":false},
  {"Name":"OP_88_VelocityScanModulation","Text":"OP_88_VelocityScanModulation","Value":136,"Unbind":true},
  {"Name":"OP_89_NULL","Text":"OP_89_NULL","Value":137,"Unbind":true},
  {"Name":"OP_8A_Saturation","Text":"OP_8A_Saturation","Value":138,"Unbind":false},
  {"Name":"OP_8B_TVChannelUpDown","Text":"OP_8B_TVChannelUpDown","Value":139,"Unbind":true},
  {"Name":"OP_8C_TVSharpness","Text":"OP_8C_TVSharpness","Value":140,"Unbind":true},
  {"Name":"OP_8D_AudioMute","Text":"静音","Value":141,"Unbind":false},
  {"Name":"OP_8E_TVContrast","Text":"OP_8E_TVContrast","Value":142,"Unbind":true},
  {"Name":"OP_8F_AudioTreble","Text":"OP_8F_AudioTreble","Value":143,"Unbind":true},
  {"Name":"OP_90_Hue","Text":"OP_90_Hue","Value":144,"Unbind":false},
  {"Name":"OP_91_AudioBass","Text":"OP_91_AudioBass","Value":145,"Unbind":true},
  {"Name":"OP_92_TVBlackLevelLuminance","Text":"OP_92_TVBlackLevelLuminance","Value":146,"Unbind":true},
  {"Name":"OP_93_AudioBalanceLR","Text":"OP_93_AudioBalanceLR","Value":147,"Unbind":true},
  {"Name":"OP_94_AudioProcessorMode","Text":"OP_94_AudioProcessorMode","Value":148,"Unbind":true},
  {"Name":"OP_95_WindowPositionTL_X","Text":"OP_95_WindowPositionTL_X","Value":149,"Unbind":true},
  {"Name":"OP_96_WindowPositionTL_Y","Text":"OP_96_WindowPositionTL_Y","Value":150,"Unbind":true},
  {"Name":"OP_97_WindowPositionBR_X","Text":"OP_97_WindowPositionBR_X","Value":151,"Unbind":true},
  {"Name":"OP_98_WindowPositionBR_X","Text":"OP_98_WindowPositionBR_X","Value":152,"Unbind":true},
  {"Name":"OP_99_NULL","Text":"OP_99_NULL","Value":153,"Unbind":true},
  {"Name":"OP_9A_WindowBackground","Text":"OP_9A_WindowBackground","Value":154,"Unbind":true},
  {"Name":"OP_9B_6AxisColorControlRed","Text":"OP_9B_6AxisColorControlRed","Value":155,"Unbind":true},
  {"Name":"OP_9C_6AxisColorControlYellow","Text":"OP_9C_6AxisColorControlYellow","Value":156,"Unbind":true},
  {"Name":"OP_9D_6AxisColorControlGreen","Text":"OP_9D_6AxisColorControlGreen","Value":157,"Unbind":true},
  {"Name":"OP_9E_6AxisColorControlCyan","Text":"OP_9E_6AxisColorControlCyan","Value":158,"Unbind":true},
  {"Name":"OP_9F_6AxisColorControlBlue","Text":"OP_9F_6AxisColorControlBlue","Value":159,"Unbind":true},
  {"Name":"OP_A0_6AxisColorControlMagenta","Text":"OP_A0_6AxisColorControlMagenta","Value":160,"Unbind":true},
  {"Name":"OP_A1_NULL","Text":"OP_A1_NULL","Value":161,"Unbind":true},
  {"Name":"OP_A2_AutoSetupOnOff","Text":"OP_A2_AutoSetupOnOff","Value":162,"Unbind":true},
  {"Name":"OP_A3_NULL","Text":"OP_A3_NULL","Value":163,"Unbind":true},
  {"Name":"OP_A4_WindowMaskControl","Text":"OP_A4_WindowMaskControl","Value":164,"Unbind":false},
  {"Name":"OP_A5_WindowSelect","Text":"PIPPBP切换","Value":165,"Unbind":false},
  {"Name":"OP_A6_NULL","Text":"OP_A6_NULL","Value":166,"Unbind":true},
  {"Name":"OP_A7_NULL","Text":"OP_A7_NULL","Value":167,"Unbind":true},
  {"Name":"OP_A8_NULL","Text":"OP_A8_NULL","Value":168,"Unbind":true},
  {"Name":"OP_A9_NULL","Text":"OP_A9_NULL","Value":169,"Unbind":true},
  {"Name":"OP_AA_ScreenOrientation","Text":"屏幕方向","Value":170,"Unbind":false},
  {"Name":"OP_AB_NULL","Text":"OP_AB_NULL","Value":171,"Unbind":true},
  {"Name":"OP_AC_HorizontalFrequency","Text":"OP_AC_HorizontalFrequency","Value":172,"Unbind":true},
  {"Name":"OP_AD_NULL","Text":"OP_AD_NULL","Value":173,"Unbind":true},
  {"Name":"OP_AE_VerticalFrequency","Text":"OP_AE_VerticalFrequency","Value":174,"Unbind":true},
  {"Name":"OP_AF_NULL","Text":"OP_AF_NULL","Value":175,"Unbind":true},
  {"Name":"OP_B0_Settings","Text":"OP_B0_Settings","Value":176,"Unbind":true},
  {"Name":"OP_B1_NULL","Text":"OP_B1_NULL","Value":177,"Unbind":true},
  {"Name":"OP_B2_FlatPanelSubPixelLayout","Text":"OP_B2_FlatPanelSubPixelLayout","Value":178,"Unbind":true},
  {"Name":"OP_B3_NULL","Text":"OP_B3_NULL","Value":179,"Unbind":true},
  {"Name":"OP_B4_SourceTimingMode","Text":"OP_B4_SourceTimingMode","Value":180,"Unbind":true},
  {"Name":"OP_B5_SourceColorCoding","Text":"OP_B5_SourceColorCoding","Value":181,"Unbind":true},
  {"Name":"OP_B6_DisplayTechnologyType","Text":"OP_B6_DisplayTechnologyType","Value":182,"Unbind":true},
  {"Name":"OP_B7_DPVLDisplaystatus","Text":"OP_B7_DPVLDisplaystatus","Value":183,"Unbind":true},
  {"Name":"OP_B8_DPVLPacketcount","Text":"OP_B8_DPVLPacketcount","Value":184,"Unbind":true},
  {"Name":"OP_B9_DPVLDisplayXorigin","Text":"OP_B9_DPVLDisplayXorigin","Value":185,"Unbind":true},
  {"Name":"OP_BA_DPVLDisplayYorigin","Text":"OP_BA_DPVLDisplayYorigin","Value":186,"Unbind":true},
  {"Name":"OP_BB_DPVLHeaderCRCerrorcount","Text":"OP_BB_DPVLHeaderCRCerrorcount","Value":187,"Unbind":true},
  {"Name":"OP_BC_DPVLBodyCRCerrorcount","Text":"OP_BC_DPVLBodyCRCerrorcount","Value":188,"Unbind":true},
  {"Name":"OP_BD_DPVLClientID","Text":"OP_BD_DPVLClientID","Value":189,"Unbind":true},
  {"Name":"OP_BE_DPVLLinkcontrol","Text":"OP_BE_DPVLLinkcontrol","Value":190,"Unbind":true},
  {"Name":"OP_BF_NULL","Text":"OP_BF_NULL","Value":191,"Unbind":true},
  {"Name":"OP_C0_DisplayUsageTime","Text":"OP_C0_DisplayUsageTime","Value":192,"Unbind":true},
  {"Name":"OP_C1_NULL","Text":"OP_C1_NULL","Value":193,"Unbind":true},
  {"Name":"OP_C2_DisplayDescriptorLength","Text":"OP_C2_DisplayDescriptorLength","Value":194,"Unbind":true},
  {"Name":"OP_C3_TransmitDisplayDescriptor","Text":"OP_C3_TransmitDisplayDescriptor","Value":195,"Unbind":true},
  {"Name":"OP_C4_EnableDisplayofDisplayDescriptor","Text":"OP_C4_EnableDisplayofDisplayDescriptor","Value":196,"Unbind":true},
  {"Name":"OP_C5_NULL","Text":"OP_C5_NULL","Value":197,"Unbind":true},
  {"Name":"OP_C6_ApplicationEnableKey","Text":"OP_C6_ApplicationEnableKey","Value":198,"Unbind":true},
  {"Name":"OP_C7_NULL","Text":"OP_C7_NULL","Value":199,"Unbind":true},
  {"Name":"OP_C8_DisplayControllerType","Text":"OP_C8_DisplayControllerType","Value":200,"Unbind":true},
  {"Name":"OP_C9_DisplayFirmwareLevel","Text":"OP_C9_DisplayFirmwareLevel","Value":201,"Unbind":true},
  {"Name":"OP_CA_OSD","Text":"OP_CA_OSD","Value":202,"Unbind":true},
  {"Name":"OP_CB_NULL","Text":"OP_CB_NULL","Value":203,"Unbind":true},
  {"Name":"OP_CC_OSDLanguage","Text":"OSD语言","Value":204,"Unbind":false},
  {"Name":"OP_CD_StatusIndicators","Text":"OP_CD_StatusIndicators","Value":205,"Unbind":true},
  {"Name":"OP_CE_AuxiliaryDisplaySize","Text":"OP_CE_AuxiliaryDisplaySize","Value":206,"Unbind":true},
  {"Name":"OP_CF_AuxiliaryDisplayData","Text":"OP_CF_AuxiliaryDisplayData","Value":207,"Unbind":true},
  {"Name":"OP_D0_OutputSelection","Text":"OP_D0_OutputSelection","Value":208,"Unbind":true},
  {"Name":"OP_D1_NULL","Text":"OP_D1_NULL","Value":209,"Unbind":true},
  {"Name":"OP_D2_AssetTag","Text":"OP_D2_AssetTag","Value":210,"Unbind":true},
  {"Name":"OP_D3_NULL","Text":"OP_D3_NULL","Value":211,"Unbind":true},
  {"Name":"OP_D4_StereoVideoMode","Text":"OP_D4_StereoVideoMode","Value":212,"Unbind":true},
  {"Name":"OP_D5_NULL","Text":"OP_D5_NULL","Value":213,"Unbind":true},
  {"Name":"OP_D6_PowerMode","Text":"电源选项","Value":214,"Unbind":false},
  {"Name":"OP_D7_AuxiliaryPowerOutput","Text":"OP_D7_AuxiliaryPowerOutput","Value":215,"Unbind":true},
  {"Name":"OP_D8_NULL","Text":"OP_D8_NULL","Value":216,"Unbind":true},
  {"Name":"OP_D9_NULL","Text":"OP_D9_NULL","Value":217,"Unbind":true},
  {"Name":"OP_DA_ScanMode","Text":"ScanMode","Value":218,"Unbind":false},
  {"Name":"OP_DB_ImageMode","Text":"OP_DB_ImageMode","Value":219,"Unbind":true},
  {"Name":"OP_DC_DisplayApplication","Text":"SmartImage","Value":220,"Unbind":false},
  {"Name":"OP_DD_NULL","Text":"OP_DD_NULL","Value":221,"Unbind":true},
  {"Name":"OP_DE_ScratchPad","Text":"OP_DE_ScratchPad","Value":222,"Unbind":true},
  {"Name":"OP_DF_VCPVersion","Text":"OP_DF_VCPVersion","Value":223,"Unbind":true},
  {"Name":"OP_E0_AudioSource","Text":"Audio Source","Value":224,"Unbind":false},
  {"Name":"OP_E1_NULL","Text":"OP_E1_NULL","Value":225,"Unbind":true},
  {"Name":"OP_E2_Extern","Text":"OP_E2_Extern","Value":226,"Unbind":true},
  {"Name":"OP_E3_NULL","Text":"OP_E3_NULL","Value":227,"Unbind":true},
  {"Name":"OP_E4_NULL","Text":"OP_E4_NULL","Value":228,"Unbind":true},
  {"Name":"OP_E5_NULL","Text":"OP_E5_NULL","Value":229,"Unbind":true},
  {"Name":"OP_E6_NULL","Text":"OP_E6_NULL","Value":230,"Unbind":true},
  {"Name":"OP_E7_NULL","Text":"OP_E7_NULL","Value":231,"Unbind":true},
  {"Name":"OP_E8_NULL","Text":"OP_E8_NULL","Value":232,"Unbind":true},
  {"Name":"OP_E9_ResolutionNotifier","Text":"分辨率通知","Value":233,"Unbind":false},
  {"Name":"OP_EA_NULL","Text":"OP_EA_NULL","Value":234,"Unbind":true},
  {"Name":"OP_EB_SmartResponse","Text":"SmartResponse","Value":235,"Unbind":false},
  {"Name":"OP_EC_PIPPBPSizeLocation","Text":"PIPPBP的大小和位置","Value":236,"Unbind":false},
  {"Name":"OP_ED_InputAuto","Text":"Input Auto Source","Value":237,"Unbind":false},
  {"Name":"OP_EE_NULL","Text":"OP_EE_NULL","Value":238,"Unbind":true},
  {"Name":"OP_EF_NULL","Text":"OP_EF_NULL","Value":239,"Unbind":true},
  {"Name":"OP_F0_SmartContrast","Text":"智能对比度","Value":240,"Unbind":false},
  {"Name":"OP_F1_NULL","Text":"OP_F1_NULL","Value":241,"Unbind":true},
  {"Name":"OP_F2_PowerLED","Text":"电源灯亮度","Value":242,"Unbind":false},
  {"Name":"OP_F3_NULL","Text":"OP_F3_NULL","Value":243,"Unbind":true},
  {"Name":"OP_F4_NULL","Text":"OP_F4_NULL","Value":244,"Unbind":true},
  {"Name":"OP_F5_NULL","Text":"OP_F5_NULL","Value":245,"Unbind":true},
  {"Name":"OP_F6_PIPPBPSwap","Text":"PIPPBP输入交换","Value":246,"Unbind":false},
  {"Name":"OP_F7_PIPPBPType","Text":"判断PIPPBP类型","Value":247,"Unbind":false},
  {"Name":"OP_F8_NULL","Text":"OP_F8_NULL","Value":248,"Unbind":true},
  {"Name":"OP_F9_NULL","Text":"OP_F9_NULL","Value":249,"Unbind":true},
  {"Name":"OP_FA_NULL","Text":"OP_FA_NULL","Value":250,"Unbind":true},
  {"Name":"OP_FB_NULL","Text":"OP_FB_NULL","Value":251,"Unbind":true},
  {"Name":"OP_FC_NULL","Text":"OP_FC_NULL","Value":252,"Unbind":true},
  {"Name":"OP_FD_NULL","Text":"OP_FD_NULL","Value":253,"Unbind":true},
  {"Name":"OP_FE_NULL","Text":"OP_FE_NULL","Value":254,"Unbind":true},
  {"Name":"OP_FF_NULL","Text":"OP_FF_NULL","Value":255,"Unbind":true}
]}
```

`E2A0_ExternVCPOpCode_E` — `ENT/E2A0_ExternVCPOpCode_E.cs:6`, 91 members, 2 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_ExternVCPOpCode_E","members":[
  {"Name":"EXT_OP_E2A0_Null","Text":"EXT_OP_E2A0_Null","Value":0,"Unbind":true},
  {"Name":"EXT_OP_E2A0_00_AudioMode","Text":"AudioMode","Value":14852096,"Unbind":false},
  {"Name":"EXT_OP_E2A0_01_AudioEQ","Text":"EQ","Value":14852097,"Unbind":false},
  {"Name":"EXT_OP_E2A0_02_MBR","Text":"MBR","Value":14852098,"Unbind":false},
  {"Name":"EXT_OP_E2A0_03_MBRSync","Text":"MBR Sync","Value":14852099,"Unbind":false},
  {"Name":"EXT_OP_E2A0_04_SmartCrosshair","Text":"Smart Crosshair","Value":14852100,"Unbind":false},
  {"Name":"EXT_OP_E2A0_05_ShadowBoost","Text":"ShadowBoost","Value":14852101,"Unbind":true},
  {"Name":"EXT_OP_E2A0_06_SharpShooter_Size","Text":"Smart Sniper_Size","Value":14852102,"Unbind":false},
  {"Name":"EXT_OP_E2A0_07_LowInputLag","Text":"Low Input Lag","Value":14852103,"Unbind":false},
  {"Name":"EXT_OP_E2A0_08_SmartFrame","Text":"SmartFrame","Value":14852104,"Unbind":false},
  {"Name":"EXT_OP_E2A0_09_SmartFrameSize","Text":"SmartFrame Size","Value":14852105,"Unbind":false},
  {"Name":"EXT_OP_E2A0_0A_SmartFrameBrightness","Text":"SmartFrame Brightness","Value":14852106,"Unbind":false},
  {"Name":"EXT_OP_E2A0_0B_SmartFrameContrast","Text":"SmartFrame Contrast","Value":14852107,"Unbind":false},
  {"Name":"EXT_OP_E2A0_0C_SmartFrameHPosition","Text":"SmartFrame H.position","Value":14852108,"Unbind":false},
  {"Name":"EXT_OP_E2A0_0D_SmartFrameVPosition","Text":"SmartFrame V.position","Value":14852109,"Unbind":false},
  {"Name":"EXT_OP_E2A0_0E_OSDSettingHorizontal","Text":"OSD Setting Horizontal","Value":14852110,"Unbind":false},
  {"Name":"EXT_OP_E2A0_0F_OSDSettingVertical","Text":"OSD Setting Vertical","Value":14852111,"Unbind":false},
  {"Name":"EXT_OP_E2A0_10_OSDSettingTransparency","Text":"OSD Setting Transparency","Value":14852112,"Unbind":false},
  {"Name":"EXT_OP_E2A0_11_OSDSettingTimeOut","Text":"OSD Setting Time Out","Value":14852113,"Unbind":false},
  {"Name":"EXT_OP_E2A0_12_USB_C_Setting","Text":"USB-C Setting","Value":14852114,"Unbind":false},
  {"Name":"EXT_OP_E2A0_13_USB_StandbyMode","Text":"USB Standby Mode","Value":14852115,"Unbind":false},
  {"Name":"EXT_OP_E2A0_14_USB_Upstream","Text":"USB Upstream","Value":14852116,"Unbind":false},
  {"Name":"EXT_OP_E2A0_15_KVM","Text":"KVM","Value":14852117,"Unbind":false},
  {"Name":"EXT_OP_E2A0_16_SmartPower","Text":"Smart Power","Value":14852118,"Unbind":false},
  {"Name":"EXT_OP_E2A0_17_CEC","Text":"CEC","Value":14852119,"Unbind":false},
  {"Name":"EXT_OP_E2A0_18_LocalDimming","Text":"Local Dimming","Value":14852120,"Unbind":false},
  {"Name":"EXT_OP_E2A0_19_AmbiglowLightMode","Text":"Ambiglow Light Mode","Value":14852121,"Unbind":false},
  {"Name":"EXT_OP_E2A0_1A_AmbiglowColors","Text":"Ambiglow Colors","Value":14852122,"Unbind":false},
  {"Name":"EXT_OP_E2A0_1B_AmbiglowLightPosition","Text":"Ambiglow Light Position","Value":14852123,"Unbind":false},
  {"Name":"EXT_OP_E2A0_1C_AmbiglowLightBrightness","Text":"Ambiglow Light Brightness","Value":14852124,"Unbind":false},
  {"Name":"EXT_OP_E2A0_1D_AmbiglowLightSpeed","Text":"Ambiglow Light Speed","Value":14852125,"Unbind":false},
  {"Name":"EXT_OP_E2A0_1E_AmbiglowLightDirection","Text":"Ambiglow Light Direction","Value":14852126,"Unbind":false},
  {"Name":"EXT_OP_E2A0_1F_HDMIRefreshRate","Text":"HDMI Refresh Rate","Value":14852127,"Unbind":false},
  {"Name":"EXT_OP_E2A0_20_ColorSpace","Text":"Color Space","Value":14852128,"Unbind":false},
  {"Name":"EXT_OP_E2A0_21_DPOutMultiStream","Text":"DP Out Multi-Stream","Value":14852129,"Unbind":false},
  {"Name":"EXT_OP_E2A0_22_ErgoSensor","Text":"Ergo Sensor","Value":14852130,"Unbind":false},
  {"Name":"EXT_OP_E2A0_23_LightSensor","Text":"Light Sensor","Value":14852131,"Unbind":false},
  {"Name":"EXT_OP_E2A0_24_DLBL","Text":"DLBL(Low Blue Mode)","Value":14852132,"Unbind":false},
  {"Name":"EXT_OP_E2A0_25_SharpShooter_Location","Text":"Smart Sniper_Location","Value":14852133,"Unbind":false},
  {"Name":"EXT_OP_E2A0_26_DPS","Text":"DPS","Value":14852134,"Unbind":false},
  {"Name":"EXT_OP_E2A0_27_SmartDemo","Text":"SmartDemo","Value":14852135,"Unbind":false},
  {"Name":"EXT_OP_E2A0_28_AudioStandAlone","Text":"Audio Stand-Alone","Value":14852136,"Unbind":false},
  {"Name":"EXT_OP_E2A0_29_NoiseCancelling","Text":"Noise Cancelling","Value":14852137,"Unbind":false},
  {"Name":"EXT_OP_E2A0_2A_AudioRecover","Text":"Audio Recover","Value":14852138,"Unbind":false},
  {"Name":"EXT_OP_E2A0_2B_Bluebooth","Text":"Bluebooth","Value":14852139,"Unbind":false},
  {"Name":"EXT_OP_E2A0_2C_OSDRotate","Text":"OSD Rotate","Value":14852140,"Unbind":false},
  {"Name":"EXT_OP_E2A0_2D_PowerOnLogo","Text":"Power On Logo","Value":14852141,"Unbind":false},
  {"Name":"EXT_OP_E2A0_2E_SetupRS232","Text":"Setup RS232","Value":14852142,"Unbind":false},
  {"Name":"EXT_OP_E2A0_2F_MiracastUpdate","Text":"Miracast Update","Value":14852143,"Unbind":false},
  {"Name":"EXT_OP_E2A0_30_OSDSettingUserKey1","Text":"OSD Setting USER KEY1","Value":14852144,"Unbind":false},
  {"Name":"EXT_OP_E2A0_31_OSDSettingUserKey2","Text":"OSD Setting USER KEY2","Value":14852145,"Unbind":false},
  {"Name":"EXT_OP_E2A0_32_Webcam","Text":"Webcam","Value":14852146,"Unbind":false},
  {"Name":"EXT_OP_E2A0_33_WebcamLight","Text":"Webcam Light","Value":14852147,"Unbind":false},
  {"Name":"EXT_OP_E2A0_34_PixelOrbiting","Text":"Pixel Orbiting","Value":14852148,"Unbind":false},
  {"Name":"EXT_OP_E2A0_35_ScreenSaver","Text":"Screen Saver","Value":14852149,"Unbind":false},
  {"Name":"EXT_OP_E2A0_36_PixelRefresh","Text":"Pixel Refresh","Value":14852150,"Unbind":false},
  {"Name":"EXT_OP_E2A0_37_PanelRefresh","Text":"Panel Refresh","Value":14852151,"Unbind":false},
  {"Name":"EXT_OP_E2A0_38_AmbiglowSet","Text":"Ambiglow Set","Value":14852152,"Unbind":false},
  {"Name":"EXT_OP_E2A0_39_AudioEQGain","Text":"Audio EQGain","Value":14852153,"Unbind":false},
  {"Name":"EXT_OP_E2A0_3A_HDMI1RefreshRate","Text":"HDMI1 RefreshRate","Value":14852154,"Unbind":false},
  {"Name":"EXT_OP_E2A0_3B_HDMI2RefreshRate","Text":"HDMI2 RefreshRate","Value":14852155,"Unbind":false},
  {"Name":"EXT_OP_E2A0_3C_HDMI3RefreshRate","Text":"HDMI3 RefreshRate","Value":14852156,"Unbind":false},
  {"Name":"EXT_OP_E2A0_3D_LightEnhancement","Text":"Light Enhancement","Value":14852157,"Unbind":false},
  {"Name":"EXT_OP_E2A0_3E_ColorEnhancement","Text":"Color Enhancement","Value":14852158,"Unbind":false},
  {"Name":"EXT_OP_E2A0_3F_DarkEnhancement","Text":"Dark Enhancement","Value":14852159,"Unbind":false},
  {"Name":"EXT_OP_E2A0_40_AdaptiveSync","Text":"Adaptive Sync","Value":14852160,"Unbind":false},
  {"Name":"EXT_OP_E2A0_41_FanControl","Text":"Fan Control","Value":14852161,"Unbind":false},
  {"Name":"EXT_OP_E2A0_42_FunctionReset","Text":"Function Reset","Value":14852162,"Unbind":false},
  {"Name":"EXT_OP_E2A0_43_AutoWarning","Text":"Auto Warning","Value":14852163,"Unbind":false},
  {"Name":"EXT_OP_E2A0_44_StarkShadowBoost","Text":"StarkShadowBoost","Value":14852164,"Unbind":false},
  {"Name":"EXT_OP_E2A0_45_ShadowBoost","Text":"ShadowBoost","Value":14852165,"Unbind":false},
  {"Name":"EXT_OP_E2A0_46_LEA","Text":"LEA","Value":14852166,"Unbind":false},
  {"Name":"EXT_OP_E2A0_47_UniBright","Text":"UniBright","Value":14852167,"Unbind":false},
  {"Name":"EXT_OP_E2A0_48_MultiLogoProtection","Text":"Multi-Logo Protection","Value":14852168,"Unbind":false},
  {"Name":"EXT_OP_E2A0_49_BoundaryDimmer","Text":"Boundary Dimmer","Value":14852169,"Unbind":false},
  {"Name":"EXT_OP_E2A0_4A_TaskbarDimmer","Text":"Taskbar Dimmer","Value":14852170,"Unbind":false},
  {"Name":"EXT_OP_E2A0_4B_ThermalProtection","Text":"Thermal Protection","Value":14852171,"Unbind":false},
  {"Name":"EXT_OP_E2A0_4C_Overclock","Text":"Overclock","Value":14852172,"Unbind":false},
  {"Name":"EXT_OP_E2A0_4D_OLEDInfoWorkingTimeH","Text":"EXT_OP_E2A0_4D_OLEDInfoWorkingTimeH","Value":14852173,"Unbind":false},
  {"Name":"EXT_OP_E2A0_4E_OLEDInfoWorkingTimeL","Text":"EXT_OP_E2A0_4E_OLEDInfoWorkingTimeL","Value":14852174,"Unbind":false},
  {"Name":"EXT_OP_E2A0_4F_OLEDInfoWorkingTimeM","Text":"EXT_OP_E2A0_4F_OLEDInfoWorkingTimeM","Value":14852175,"Unbind":false},
  {"Name":"EXT_OP_E2A0_50_OLEDInfoTimeAfterPixelRefreshH","Text":"EXT_OP_E2A0_50_OLEDInfoTimeAfterPixelRefreshH","Value":14852176,"Unbind":false},
  {"Name":"EXT_OP_E2A0_51_OLEDInfoTimeAfterPixelRefreshL","Text":"EXT_OP_E2A0_51_OLEDInfoTimeAfterPixelRefreshL","Value":14852177,"Unbind":false},
  {"Name":"EXT_OP_E2A0_53_OLEDInfoTimeAfterPixelRefreshM","Text":"EXT_OP_E2A0_53_OLEDInfoTimeAfterPixelRefreshM","Value":14852179,"Unbind":false},
  {"Name":"EXT_OP_E2A0_54_PixelRefreshCounts","Text":"EXT_OP_E2A0_54_PixelRefreshCounts","Value":14852180,"Unbind":false},
  {"Name":"EXT_OP_E2A0_55_PanelRefreshCounts","Text":"EXT_OP_E2A0_55_PanelRefreshCounts","Value":14852181,"Unbind":false},
  {"Name":"EXT_OP_E2A0_59_DualResolution","Text":"EXT_OP_E2A0_59_DualResolution","Value":14852185,"Unbind":false},
  {"Name":"EXT_OP_E2A0_61_AutoPixelRefresh","Text":"EXT_OP_E2A0_61_AutoPixelRefresh","Value":14852193,"Unbind":false},
  {"Name":"EXT_OP_E2A0_68_AutoRefineAIStatus","Text":"EXT_OP_E2A0_68_AutoRefineAIStatus","Value":14852200,"Unbind":false},
  {"Name":"EXT_OP_E2A0_6B_Profile","Text":"EXT_OP_E2A0_6B_Profile","Value":14852203,"Unbind":false},
  {"Name":"EXT_OP_E2A0_88_GamePQ","Text":"EXT_OP_E2A0_88_GamePQ","Value":14852232,"Unbind":false}
]}
```

#### Standard-VCP value enums

`VCP_14_SelectColorPreset` — `ENT/VCP_14_SelectColorPreset.cs:5`, 11 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_14_SelectColorPreset","members":[
  {"Name":"Preset_SRGB","Text":"sRGB","Value":1,"Unbind":false},
  {"Name":"Preset_Native","Text":"Display Native","Value":2,"Unbind":false},
  {"Name":"Preset_5000K","Text":"5000K","Value":4,"Unbind":false},
  {"Name":"Preset_6500K","Text":"6500K","Value":5,"Unbind":false},
  {"Name":"Preset_7500K","Text":"7500K","Value":6,"Unbind":false},
  {"Name":"Preset_8200K","Text":"8200K","Value":7,"Unbind":false},
  {"Name":"Preset_9300K","Text":"9300K","Value":8,"Unbind":false},
  {"Name":"Preset_11500K","Text":"11500K","Value":10,"Unbind":false},
  {"Name":"Preset_UserRGB","Text":"User 1(User Define)","Value":11,"Unbind":false},
  {"Name":"Preset_USER2","Text":"User 2(Adobe RGB)","Value":12,"Unbind":false},
  {"Name":"Preset_USER3","Text":"User 3","Value":13,"Unbind":false}
]}
```

`VCP_54_PixelOrbiting` — `ENT/VCP_54_PixelOrbiting.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_54_PixelOrbiting","members":[
  {"Name":"ON","Text":"On","Value":0,"Unbind":false},
  {"Name":"OFF","Text":"Off","Value":1,"Unbind":false}
]}
```

`VCP_60_InputSource` — `ENT/VCP_60_InputSource.cs:5`, 24 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_60_InputSource","members":[
  {"Name":"Normal_VGA1","Text":"VGA 1","Value":1,"Unbind":false},
  {"Name":"Normal_VGA2","Text":"VGA2","Value":2,"Unbind":false},
  {"Name":"Normal_DigitalDVI1","Text":"Digital DVI 1","Value":3,"Unbind":false},
  {"Name":"Normal_DisplayPort1","Text":"DisplayPort 1","Value":15,"Unbind":false},
  {"Name":"Normal_DisplayPort2","Text":"DisplayPort 2","Value":16,"Unbind":false},
  {"Name":"Normal_DigitalHDMI1","Text":"Digital HDMI 1","Value":17,"Unbind":false},
  {"Name":"Normal_DigitalHDMI2","Text":"Digital HDMI 2","Value":18,"Unbind":false},
  {"Name":"Normal_DigitalHDMI3","Text":"Digital HDMI 3","Value":19,"Unbind":false},
  {"Name":"Normal_USBC1","Text":"USB C1","Value":21,"Unbind":false},
  {"Name":"Normal_USBC2","Text":"USB C2","Value":22,"Unbind":false},
  {"Name":"Normal_Thunderbolt1","Text":"Thunderbolt1","Value":23,"Unbind":false},
  {"Name":"Normal_Thunderbolt2","Text":"Thunderbolt2","Value":24,"Unbind":false},
  {"Name":"PIPPBP_DigitalHDMI1","Text":"Digital HDMI 1","Value":33,"Unbind":false},
  {"Name":"PIPPBP_DigitalHDMI2","Text":"Digital HDMI 2","Value":34,"Unbind":false},
  {"Name":"PIPPBP_DigitalHDMI3","Text":"Digital HDMI 3","Value":35,"Unbind":false},
  {"Name":"PIPPBP_DigitalDVI1","Text":"Digital DVI 1","Value":36,"Unbind":false},
  {"Name":"PIPPBP_DisplayPort1","Text":"DisplayPort 1","Value":47,"Unbind":false},
  {"Name":"PIPPBP_DisplayPort2","Text":"DisplayPort 2","Value":48,"Unbind":false},
  {"Name":"PIPPBP_VGA1","Text":"VGA 1","Value":49,"Unbind":false},
  {"Name":"PIPPBP_VGA2","Text":"VGA 2","Value":50,"Unbind":false},
  {"Name":"PIPPBP_USBC1","Text":"USB C1","Value":53,"Unbind":false},
  {"Name":"PIPPBP_USBC2","Text":"USB C2","Value":54,"Unbind":false},
  {"Name":"PIPPBP_Thunderbolt1","Text":"Thunderbolt1","Value":55,"Unbind":false},
  {"Name":"PIPPBP_Thunderbolt2","Text":"Thunderbolt2","Value":56,"Unbind":false}
]}
```

`VCP_60_InputSource_E` — `ENT/VCP_60_InputSource_E.cs:5`, 12 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_60_InputSource_E","members":[
  {"Name":"Normal_VGA1","Text":"VGA 1","Value":1,"Unbind":false},
  {"Name":"Normal_VGA2","Text":"VGA2","Value":2,"Unbind":false},
  {"Name":"Normal_DigitalDVI1","Text":"Digital DVI 1","Value":3,"Unbind":false},
  {"Name":"Normal_DisplayPort1","Text":"DisplayPort 1","Value":15,"Unbind":false},
  {"Name":"Normal_DisplayPort2","Text":"DisplayPort 2","Value":16,"Unbind":false},
  {"Name":"Normal_DigitalHDMI1","Text":"Digital HDMI 1","Value":17,"Unbind":false},
  {"Name":"Normal_DigitalHDMI2","Text":"Digital HDMI 2","Value":18,"Unbind":false},
  {"Name":"Normal_DigitalHDMI3","Text":"Digital HDMI 3","Value":19,"Unbind":false},
  {"Name":"Normal_USBC1","Text":"USB C1","Value":21,"Unbind":false},
  {"Name":"Normal_USBC2","Text":"USB C2","Value":22,"Unbind":false},
  {"Name":"Normal_Thunderbolt1","Text":"Thunderbolt1","Value":23,"Unbind":false},
  {"Name":"Normal_Thunderbolt2","Text":"Thunderbolt2","Value":24,"Unbind":false}
]}
```

`VCP_60_PIPPBPSource_E` — `ENT/VCP_60_PIPPBPSource_E.cs:5`, 12 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_60_PIPPBPSource_E","members":[
  {"Name":"PIPPBP_DigitalHDMI1","Text":"Digital HDMI 1","Value":33,"Unbind":false},
  {"Name":"PIPPBP_DigitalHDMI2","Text":"Digital HDMI 2","Value":34,"Unbind":false},
  {"Name":"PIPPBP_DigitalHDMI3","Text":"Digital HDMI 3","Value":35,"Unbind":false},
  {"Name":"PIPPBP_DigitalDVI1","Text":"Digital DVI 1","Value":36,"Unbind":false},
  {"Name":"PIPPBP_DisplayPort1","Text":"DisplayPort 1","Value":47,"Unbind":false},
  {"Name":"PIPPBP_DisplayPort2","Text":"DisplayPort 2","Value":48,"Unbind":false},
  {"Name":"PIPPBP_VGA1","Text":"VGA 1","Value":49,"Unbind":false},
  {"Name":"PIPPBP_VGA2","Text":"VGA 2","Value":50,"Unbind":false},
  {"Name":"PIPPBP_USBC1","Text":"USB C1","Value":53,"Unbind":false},
  {"Name":"PIPPBP_USBC2","Text":"USB C2","Value":54,"Unbind":false},
  {"Name":"PIPPBP_Thunderbolt1","Text":"Thunderbolt1","Value":55,"Unbind":false},
  {"Name":"PIPPBP_Thunderbolt2","Text":"Thunderbolt2","Value":56,"Unbind":false}
]}
```

`VCP_72_Gamma` — `ENT/VCP_72_Gamma.cs:5`, 6 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_72_Gamma","members":[
  {"Name":"VCP_GAMMA_18","Text":"1.8","Value":80,"Unbind":false},
  {"Name":"VCP_GAMMA_20","Text":"2.0","Value":100,"Unbind":false},
  {"Name":"VCP_GAMMA_22","Text":"2.2","Value":120,"Unbind":false},
  {"Name":"sRGB","Text":"sRGB","Value":122,"Unbind":false},
  {"Name":"VCP_GAMMA_24","Text":"2.4","Value":140,"Unbind":false},
  {"Name":"VCP_GAMMA_26","Text":"2.6","Value":160,"Unbind":false}
]}
```

`VCP_86_DisplayScaling` — `ENT/VCP_86_DisplayScaling.cs:6`, 31 members, 1 `[UnbindEnumExtended]`

```json
{"enum":"VCP_86_DisplayScaling","members":[
  {"Name":"Scaling_NoScaling","Text":"No Scaling (1:1)","Value":1,"Unbind":false},
  {"Name":"Scaling_MaxImage","Text":"Max Image","Value":2,"Unbind":false},
  {"Name":"Scaling_16_9","Text":"16:9","Value":4,"Unbind":false},
  {"Name":"Scaling_ZoomMode","Text":"Zoom Mode","Value":8,"Unbind":false},
  {"Name":"Scaling_SupportSmartSize","Text":"Support Smart Size","Value":10,"Unbind":true},
  {"Name":"Scaling_17","Text":"17\"","Value":17,"Unbind":false},
  {"Name":"Scaling_19","Text":"19\"","Value":18,"Unbind":false},
  {"Name":"Scaling_19_W","Text":"19\"W","Value":19,"Unbind":false},
  {"Name":"Scaling_22_W","Text":"22\"W","Value":20,"Unbind":false},
  {"Name":"Scaling_18_5_W","Text":"18.5\"W","Value":21,"Unbind":false},
  {"Name":"Scaling_19_5_W","Text":"19.5\"W","Value":22,"Unbind":false},
  {"Name":"Scaling_20_W","Text":"20\"W","Value":23,"Unbind":false},
  {"Name":"Scaling_21_5_W","Text":"21.5\"W","Value":24,"Unbind":false},
  {"Name":"Scaling_23_W","Text":"23\"W","Value":25,"Unbind":false},
  {"Name":"Scaling_24_W","Text":"24\"W","Value":26,"Unbind":false},
  {"Name":"Scaling_27_W","Text":"27\"W","Value":27,"Unbind":false},
  {"Name":"Scaling_Movie1","Text":"Movie 1","Value":33,"Unbind":false},
  {"Name":"Scaling_Movie2","Text":"Movie 1","Value":34,"Unbind":false},
  {"Name":"Scaling_Aspect_4to3","Text":"4:3(Aspect)","Value":35,"Unbind":false},
  {"Name":"Scaling_25_W","Text":"25\"W","Value":36,"Unbind":false},
  {"Name":"Scaling_32_W","Text":"32\"W","Value":37,"Unbind":false},
  {"Name":"Scaling_34_W","Text":"34\"W","Value":38,"Unbind":false},
  {"Name":"Scaling_42_W","Text":"42\"W","Value":39,"Unbind":false},
  {"Name":"Scaling_49_W","Text":"49\"W","Value":40,"Unbind":false},
  {"Name":"Scaling_Aspect","Text":"Aspect","Value":41,"Unbind":false},
  {"Name":"Scaling_Full_16to9","Text":"Full(16:9)","Value":42,"Unbind":false},
  {"Name":"Scaling_1to1_16to9","Text":"1:1(16:9)","Value":43,"Unbind":false},
  {"Name":"Scaling_Full_Square","Text":"Full(Square)","Value":44,"Unbind":false},
  {"Name":"Scaling_1to1_Square","Text":"1:1(Square)","Value":45,"Unbind":false},
  {"Name":"Scaling_24_5","Text":"24.5\"","Value":46,"Unbind":false},
  {"Name":"Scaling_27","Text":"27\"","Value":47,"Unbind":false}
]}
```

`VCP_8D_AudioMute` — `ENT/VCP_8D_AudioMute.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_8D_AudioMute","members":[
  {"Name":"ON","Text":"On","Value":1,"Unbind":false},
  {"Name":"OFF","Text":"Off","Value":2,"Unbind":false}
]}
```

`VCP_A5_PIPPBPType_02_E` — `ENT/VCP_A5_PIPPBPType_02_E.cs:3`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_A5_PIPPBPType_02_E","members":[
  {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0,"Unbind":false},
  {"Name":"PIPPBP__PBP_1","Text":"PIPPBP__PBP_1","Value":512,"Unbind":false}
]}
```

`VCP_A5_PIPPBPType_03_E` — `ENT/VCP_A5_PIPPBPType_03_E.cs:3`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_A5_PIPPBPType_03_E","members":[
  {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0,"Unbind":false},
  {"Name":"PIPPBP__PBP_1","Text":"PIPPBP__PBP_1","Value":512,"Unbind":false},
  {"Name":"PIPPBP__PBP_2","Text":"PIPPBP__PBP_2","Value":1024,"Unbind":false}
]}
```

`VCP_A5_PIPPBPType_04_E` — `ENT/VCP_A5_PIPPBPType_04_E.cs:3`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_A5_PIPPBPType_04_E","members":[
  {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0,"Unbind":false},
  {"Name":"PIPPBP__PBP_1","Text":"PIPPBP__PBP_1","Value":512,"Unbind":false},
  {"Name":"PIPPBP__PBP_2","Text":"PIPPBP__PBP_2","Value":1024,"Unbind":false},
  {"Name":"PIPPBP__PBP_3","Text":"PIPPBP__PBP_3","Value":2048,"Unbind":false}
]}
```

`VCP_A5_PIPPBPType_40_E` — `ENT/VCP_A5_PIPPBPType_40_E.cs:3`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_A5_PIPPBPType_40_E","members":[
  {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0,"Unbind":false},
  {"Name":"PIPPBP__PIP","Text":"PIPPBP__PIP","Value":256,"Unbind":false}
]}
```

`VCP_A5_PIPPBPType_42_E` — `ENT/VCP_A5_PIPPBPType_42_E.cs:3`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_A5_PIPPBPType_42_E","members":[
  {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0,"Unbind":false},
  {"Name":"PIPPBP__PIP","Text":"PIPPBP__PIP","Value":256,"Unbind":false},
  {"Name":"PIPPBP__PBP_1","Text":"PIPPBP__PBP_1","Value":512,"Unbind":false}
]}
```

`VCP_A5_PIPPBPType_43_E` — `ENT/VCP_A5_PIPPBPType_43_E.cs:3`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_A5_PIPPBPType_43_E","members":[
  {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0,"Unbind":false},
  {"Name":"PIPPBP__PIP","Text":"PIPPBP__PIP","Value":256,"Unbind":false},
  {"Name":"PIPPBP__PBP_1","Text":"PIPPBP__PBP_1","Value":512,"Unbind":false},
  {"Name":"PIPPBP__PBP_2","Text":"PIPPBP__PBP_2","Value":1024,"Unbind":false}
]}
```

`VCP_A5_PIPPBPType_44_E` — `ENT/VCP_A5_PIPPBPType_44_E.cs:3`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_A5_PIPPBPType_44_E","members":[
  {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0,"Unbind":false},
  {"Name":"PIPPBP__PIP","Text":"PIPPBP__PIP","Value":256,"Unbind":false},
  {"Name":"PIPPBP__PBP_1","Text":"PIPPBP__PBP_1","Value":512,"Unbind":false},
  {"Name":"PIPPBP__PBP_2","Text":"PIPPBP__PBP_2","Value":1024,"Unbind":false},
  {"Name":"PIPPBP__PBP_3","Text":"PIPPBP__PBP_3","Value":2048,"Unbind":false}
]}
```

`VCP_AA_ScreenOrientation` — `ENT/VCP_AA_ScreenOrientation.cs:5`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_AA_ScreenOrientation","members":[
  {"Name":"Orientation_0","Text":"0°","Value":1,"Unbind":false},
  {"Name":"Orientation_90","Text":"90°","Value":2,"Unbind":false},
  {"Name":"Orientation_270","Text":"270°","Value":4,"Unbind":false},
  {"Name":"Orientation_PMS","Text":"PMS","Value":5,"Unbind":false}
]}
```

`VCP_CC_OSDLanguage` — `ENT/VCP_CC_OSDLanguage.cs:5`, 21 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_CC_OSDLanguage","members":[
  {"Name":"Chinese_tw","Text":"繁体中文","Value":1,"Unbind":false},
  {"Name":"English","Text":"English","Value":2,"Unbind":false},
  {"Name":"French","Text":"Français","Value":3,"Unbind":false},
  {"Name":"German","Text":"Deutsch","Value":4,"Unbind":false},
  {"Name":"Italian","Text":"Italiano","Value":5,"Unbind":false},
  {"Name":"Japanese","Text":"日本語","Value":6,"Unbind":false},
  {"Name":"Korean","Text":"한국어","Value":7,"Unbind":false},
  {"Name":"Portuguese_Portugal","Text":"Português","Value":8,"Unbind":false},
  {"Name":"Russian","Text":"Русский","Value":9,"Unbind":false},
  {"Name":"Spanish","Text":"Español","Value":10,"Unbind":false},
  {"Name":"Swedish","Text":"Svenska","Value":11,"Unbind":false},
  {"Name":"Turkish","Text":"Türkçe","Value":12,"Unbind":false},
  {"Name":"Chinese_cn","Text":"简体中文","Value":13,"Unbind":false},
  {"Name":"Portuguese_Brazil","Text":"Português do Brasil","Value":14,"Unbind":false},
  {"Name":"Czech","Text":"Česky","Value":18,"Unbind":false},
  {"Name":"Dutch","Text":"Nederlands","Value":20,"Unbind":false},
  {"Name":"Finnish","Text":"Suomi","Value":22,"Unbind":false},
  {"Name":"Greek","Text":"Ελληνικά","Value":23,"Unbind":false},
  {"Name":"Hungarian","Text":"Magyar","Value":26,"Unbind":false},
  {"Name":"Polish","Text":"Polski","Value":30,"Unbind":false},
  {"Name":"Ukrainian","Text":"Українська","Value":36,"Unbind":false}
]}
```

`VCP_D6_SmartPower` — `ENT/VCP_D6_SmartPower.cs:5`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_D6_SmartPower","members":[
  {"Name":"ON","Text":"打开显示器","Value":1,"Unbind":false},
  {"Name":"OFF_WithRecovery","Text":"显示器待机状态","Value":4,"Unbind":false},
  {"Name":"OFF","Text":"关闭显示器","Value":5,"Unbind":false}
]}
```

`VCP_DA_ScanMode` — `ENT/VCP_DA_ScanMode.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_DA_ScanMode","members":[
  {"Name":"OFF","Text":"Normal operation","Value":0,"Unbind":false},
  {"Name":"ON","Text":"Overscan","Value":2,"Unbind":false}
]}
```

`VCP_DC_SmartImage` — `ENT/VCP_DC_SmartImage.cs:3`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_DC_SmartImage","members":[
  {"Name":"SmartImage_E1","Text":"SmartImage_E1","Value":225,"Unbind":false},
  {"Name":"SmartImage_E2","Text":"SmartImage_E2","Value":226,"Unbind":false},
  {"Name":"SmartImage_E3","Text":"SmartImage_E3","Value":227,"Unbind":false},
  {"Name":"SmartImage_E4","Text":"SmartImage_E4","Value":228,"Unbind":false}
]}
```

`VCP_E0_AudioSourceSelect` — `ENT/VCP_E0_AudioSourceSelect.cs:5`, 11 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_E0_AudioSourceSelect","members":[
  {"Name":"AudioSource_PCIn","Text":"PC In/Audio In","Value":0,"Unbind":false},
  {"Name":"AudioSource_HDMI1","Text":"HDMI1","Value":1,"Unbind":false},
  {"Name":"AudioSource_HDMI2","Text":"HDMI2","Value":2,"Unbind":false},
  {"Name":"AudioSource_DisplayPort1","Text":"Display Port 1","Value":3,"Unbind":false},
  {"Name":"AudioSource_DisplayPort2","Text":"Display Port 2","Value":4,"Unbind":false},
  {"Name":"AudioSource_USBC1","Text":"USB C1","Value":5,"Unbind":false},
  {"Name":"AudioSource_USBC2","Text":"USB C2","Value":6,"Unbind":false},
  {"Name":"AudioSource_HDMI3","Text":"HDMI3","Value":7,"Unbind":false},
  {"Name":"AudioSource_AUTO","Text":"AUTO","Value":8,"Unbind":false},
  {"Name":"AudioSource_Thunderbolt1","Text":"Thunderbolt 1","Value":9,"Unbind":false},
  {"Name":"AudioSource_Thunderbolt2","Text":"Thunderbolt 2","Value":10,"Unbind":false}
]}
```

`VCP_E9_ResolutionNotifier` — `ENT/VCP_E9_ResolutionNotifier.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_E9_ResolutionNotifier","members":[
  {"Name":"OFF","Text":"ResolutionNotifierOff","Value":0,"Unbind":false},
  {"Name":"ON","Text":"ResolutionNotifierOn","Value":2,"Unbind":false}
]}
```

`VCP_EB_SmartResponse` — `ENT/VCP_EB_SmartResponse.cs:5`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_EB_SmartResponse","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"Enable_FAST","Text":"Fast","Value":1,"Unbind":false},
  {"Name":"Enable_FASTER","Text":"Faster","Value":2,"Unbind":false},
  {"Name":"Enable_FASTEST","Text":"Fastest","Value":3,"Unbind":false}
]}
```

`VCP_EC_PIP_Location` — `ENT/VCP_EC_PIP_Location.cs:3`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_EC_PIP_Location","members":[
  {"Name":"UpperRight","Text":"UpperRight","Value":1,"Unbind":false},
  {"Name":"LowerRight","Text":"LowerRight","Value":2,"Unbind":false},
  {"Name":"UpperLeft","Text":"UpperLeft","Value":3,"Unbind":false},
  {"Name":"LowerLeft","Text":"LowerLeft","Value":4,"Unbind":false}
]}
```

`VCP_EC_PIP_Size` — `ENT/VCP_EC_PIP_Size.cs:3`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_EC_PIP_Size","members":[
  {"Name":"Small","Text":"Small","Value":1,"Unbind":false},
  {"Name":"Middle","Text":"Middle","Value":2,"Unbind":false},
  {"Name":"Large","Text":"Large","Value":3,"Unbind":false}
]}
```

`VCP_F2_PowerLED` — `ENT/VCP_F2_PowerLED.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_F2_PowerLED","members":[
  {"Name":"POWER_LED_STEP0","Text":"等级0","Value":0,"Unbind":false},
  {"Name":"POWER_LED_STEP1","Text":"等级1","Value":1,"Unbind":false},
  {"Name":"POWER_LED_STEP2","Text":"等级2","Value":2,"Unbind":false},
  {"Name":"POWER_LED_STEP3","Text":"等级3","Value":3,"Unbind":false},
  {"Name":"POWER_LED_STEP4","Text":"等级4","Value":4,"Unbind":false}
]}
```

`VCP_F7_PIPPBPType` — `ENT/VCP_F7_PIPPBPType.cs:3`, 7 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_F7_PIPPBPType","members":[
  {"Name":"PIP_0_PBP_2","Text":"PIP_0_PBP_2","Value":2,"Unbind":false},
  {"Name":"PIP_0_PBP_3","Text":"PIP_0_PBP_3","Value":3,"Unbind":false},
  {"Name":"PIP_0_PBP_4","Text":"PIP_0_PBP_4","Value":4,"Unbind":false},
  {"Name":"PIP_2_PBP_0","Text":"PIP_2_PBP_0","Value":64,"Unbind":false},
  {"Name":"PIP_2_PBP_2","Text":"PIP_2_PBP_2","Value":66,"Unbind":false},
  {"Name":"PIP_2_PBP_3","Text":"PIP_2_PBP_3","Value":67,"Unbind":false},
  {"Name":"PIP_2_PBP_4","Text":"PIP_2_PBP_4","Value":68,"Unbind":false}
]}
```

`VCP_1E_AutoSetUp` — `ENT/VCP_1E_AutoSetUp.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_1E_AutoSetUp","members":[
  {"Name":"NoOperate","Text":"No operate","Value":0,"Unbind":false},
  {"Name":"PerformAutoSetup","Text":"Perform auto setup","Value":1,"Unbind":false}
]}
```

`VCP_CA_OSDLock` — `ENT/VCP_CA_OSDLock.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"VCP_CA_OSDLock","members":[
  {"Name":"ON","Text":"On","Value":1,"Unbind":false},
  {"Name":"OFF","Text":"Off","Value":2,"Unbind":false}
]}
```

#### SmartImage (VCP 0xDC) enums

`SmartImage_E1` — `ENT/SmartImage_E1.cs:5`, 9 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"SmartImage_E1","members":[
  {"Name":"SmartImage_Standard","Text":"Standard","Value":0,"Unbind":false},
  {"Name":"SmartImage_Office","Text":"Office","Value":1,"Unbind":false},
  {"Name":"SmartImage_Photo","Text":"Photo","Value":2,"Unbind":false},
  {"Name":"SmartImage_Movie","Text":"Movie","Value":3,"Unbind":false},
  {"Name":"SmartImage_Games","Text":"Games","Value":5,"Unbind":false},
  {"Name":"SmartImage_Economy","Text":"Economy","Value":8,"Unbind":false},
  {"Name":"SmartImage_EasyRead","Text":"EasyRead","Value":14,"Unbind":false},
  {"Name":"SmartImage_SmartUniformity","Text":"SmartUniformity","Value":31,"Unbind":false},
  {"Name":"SmartImage_DMode","Text":"D-Mode","Value":80,"Unbind":false}
]}
```

`SmartImage_E2` — `ENT/SmartImage_E2.cs:5`, 16 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"SmartImage_E2","members":[
  {"Name":"SmartImage_Standard","Text":"Standard","Value":0,"Unbind":false},
  {"Name":"SmartImage_FPS","Text":"FPS","Value":1,"Unbind":false},
  {"Name":"SmartImage_Movie","Text":"Movie","Value":3,"Unbind":false},
  {"Name":"SmartImage_Game1","Text":"Game1","Value":4,"Unbind":false},
  {"Name":"SmartImage_Game2","Text":"Game2","Value":5,"Unbind":false},
  {"Name":"SmartImage_Racing","Text":"Racing","Value":6,"Unbind":false},
  {"Name":"SmartImage_RTS","Text":"RTS","Value":7,"Unbind":false},
  {"Name":"SmartImage_Economy","Text":"Economy","Value":8,"Unbind":false},
  {"Name":"SmartImage_LowBlueMode","Text":"LowBlueMode","Value":11,"Unbind":false},
  {"Name":"SmartImage_EasyRead","Text":"EasyRead","Value":14,"Unbind":false},
  {"Name":"SmartImage_XBoxMode","Text":"XBoxMode","Value":15,"Unbind":false},
  {"Name":"SmartImage_Off","Text":"Off","Value":16,"Unbind":false},
  {"Name":"SmartImage_ConsoleMode","Text":"ConsoleMode","Value":17,"Unbind":false},
  {"Name":"SmartImage_SmartUniformity","Text":"SmartUniformity","Value":31,"Unbind":false},
  {"Name":"SmartImage_DMode","Text":"D-Mode","Value":80,"Unbind":false},
  {"Name":"SmartImage_IllustratorMode","Text":"Illustrator Mode","Value":81,"Unbind":false}
]}
```

`SmartImage_E3` — `ENT/SmartImage_E3.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"SmartImage_E3","members":[
  {"Name":"SmartImage_Standard","Text":"Standard","Value":0,"Unbind":false},
  {"Name":"SmartImage_Internet","Text":"Internet","Value":1,"Unbind":false},
  {"Name":"SmartImage_Games","Text":"Games","Value":5,"Unbind":false},
  {"Name":"SmartImage_LowBlueMode","Text":"LowBlueMode","Value":11,"Unbind":false},
  {"Name":"SmartImage_EasyRead","Text":"EasyRead","Value":14,"Unbind":false}
]}
```

`SmartImage_E4` — `ENT/SmartImage_E4.cs:5`, 7 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"SmartImage_E4","members":[
  {"Name":"SmartImage_Off","Text":"Off","Value":0,"Unbind":false},
  {"Name":"SmartImage_Text","Text":"Text","Value":1,"Unbind":false},
  {"Name":"SmartImage_Level1","Text":"Level 1","Value":2,"Unbind":false},
  {"Name":"SmartImage_Video","Text":"Video","Value":3,"Unbind":false},
  {"Name":"SmartImage_Standard","Text":"Standard","Value":4,"Unbind":false},
  {"Name":"SmartImage_sRGBImage","Text":"sRGB Image","Value":5,"Unbind":false},
  {"Name":"SmartImage_CliniaclDImage","Text":"Cliniacl D-Image","Value":7,"Unbind":false}
]}
```

`SmartImageHDR_E` — `ENT/SmartImageHDR_E.cs:5`, 20 members, 0 `[UnbindEnumExtended]`; renamed in `work/dotnet-clean` (real names used here): `const_4`→`HDRPersonal`, `const_5`→`HDRNormal`, `const_8`→`HDRRec2020`, `const_11`→`HDRRec709`, `const_12`→`HDRPremium`, `const_13`→`HDREffect`

```json
{"enum":"SmartImageHDR_E","members":[
  {"Name":"HDROff","Text":"HDR Off","Value":32,"Unbind":false},
  {"Name":"HDRGame","Text":"HDR Game","Value":33,"Unbind":false},
  {"Name":"HDRMovie","Text":"HDR Movie","Value":34,"Unbind":false},
  {"Name":"HDRPhoto","Text":"HDR Photo","Value":35,"Unbind":false},
  {"Name":"HDRPersonal","Text":"HDR Personal","Value":36,"Unbind":false},
  {"Name":"HDRNormal","Text":"HDR Normal","Value":37,"Unbind":false},
  {"Name":"DisplayHDRXXXX","Text":"HDR DisplayHDRXXXX","Value":38,"Unbind":false},
  {"Name":"Xbox","Text":"HDR Xbox","Value":39,"Unbind":false},
  {"Name":"HDRRec2020","Text":"HDR Rec 2020","Value":40,"Unbind":false},
  {"Name":"HDRDCI","Text":"HDR DCI","Value":41,"Unbind":false},
  {"Name":"HDRAdobe","Text":"HDR Adobe","Value":42,"Unbind":false},
  {"Name":"HDRRec709","Text":"HDR Rec 709","Value":43,"Unbind":false},
  {"Name":"HDRPremium","Text":"HDR Premium","Value":44,"Unbind":false},
  {"Name":"HDREffect","Text":"HDR Effect","Value":45,"Unbind":false},
  {"Name":"HDRWarm","Text":"HDR Warm","Value":46,"Unbind":false},
  {"Name":"HDRBasic","Text":"HDR Basic","Value":47,"Unbind":false},
  {"Name":"HDRTrueBlack","Text":"HDR True Black","Value":48,"Unbind":false},
  {"Name":"HDRHLG","Text":"HDR HLG","Value":49,"Unbind":false},
  {"Name":"HDRVivid","Text":"HDR Vivid","Value":50,"Unbind":false},
  {"Name":"HDRPeak","Text":"HDR Peak","Value":51,"Unbind":false}
]}
```

#### TPV extended (E2 A0 xx) value enums

`E2A021_DPOutMultiStream_E` — `ENT/E2A021_DPOutMultiStream_E.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A021_DPOutMultiStream_E","members":[
  {"Name":"Clone","Text":"Clone","Value":1,"Unbind":false},
  {"Name":"Extend","Text":"Extend","Value":2,"Unbind":false}
]}
```

`E2A0_00_AudioMode_E` — `ENT/E2A0_00_AudioMode_E.cs:5`, 18 members, 0 `[UnbindEnumExtended]`; renamed in `work/dotnet-clean` (real names used here): `const_15`→`ShootingActionBASS`, `const_17`→`MusicBASS`

```json
{"enum":"E2A0_00_AudioMode_E","members":[
  {"Name":"Standard","Text":"Standard","Value":64,"Unbind":false},
  {"Name":"Game","Text":"Game","Value":65,"Unbind":false},
  {"Name":"Classical","Text":"Classical","Value":66,"Unbind":false},
  {"Name":"Rock","Text":"Rock","Value":67,"Unbind":false},
  {"Name":"Live","Text":"Live","Value":68,"Unbind":false},
  {"Name":"Theater","Text":"Theater","Value":69,"Unbind":false},
  {"Name":"OFF","Text":"Off","Value":70,"Unbind":false},
  {"Name":"SportsRacing","Text":"Sports & Racing","Value":71,"Unbind":false},
  {"Name":"RPGAdventure","Text":"RPG & Adventure","Value":72,"Unbind":false},
  {"Name":"ShootingAction","Text":"Shooting & Action","Value":73,"Unbind":false},
  {"Name":"MovieWatching","Text":"Movie Watching","Value":74,"Unbind":false},
  {"Name":"Music","Text":"Music","Value":75,"Unbind":false},
  {"Name":"Personal","Text":"Personal","Value":76,"Unbind":false},
  {"Name":"SportsRacingBASS","Text":"Sports & Racing BASS+","Value":80,"Unbind":false},
  {"Name":"RPGAdventureBASS","Text":"RPG & Adventure BASS+","Value":81,"Unbind":false},
  {"Name":"ShootingActionBASS","Text":"Shooting & Action BASS+","Value":82,"Unbind":false},
  {"Name":"MovieWatchingBASS","Text":"Movie Watching BASS+","Value":83,"Unbind":false},
  {"Name":"MusicBASS","Text":"Music BASS+","Value":84,"Unbind":false}
]}
```

`E2A0_01_AudioEQ_E` — `ENT/E2A0_01_AudioEQ_E.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_01_AudioEQ_E","members":[
  {"Name":"EQ_100","Text":"100Hz","Value":0,"Unbind":false},
  {"Name":"EQ_300","Text":"300Hz","Value":1,"Unbind":false},
  {"Name":"EQ_1000","Text":"1kHz","Value":2,"Unbind":false},
  {"Name":"EQ_3000","Text":"3kHz","Value":3,"Unbind":false},
  {"Name":"EQ_10000","Text":"10kHz","Value":4,"Unbind":false}
]}
```

`E2A0_04_SmartCrosshair_E` — `ENT/E2A0_04_SmartCrosshair_E.cs:5`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_04_SmartCrosshair_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"ON","Text":"On","Value":1,"Unbind":false},
  {"Name":"SmartCrosshairOn","Text":"Smart Crosshair On","Value":2,"Unbind":false}
]}
```

`E2A0_05_ShadowBoost_E` — `ENT/E2A0_05_ShadowBoost_E.cs:5`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_05_ShadowBoost_E","members":[
  {"Name":"Level1","Text":"Level 1","Value":0,"Unbind":false},
  {"Name":"Level2","Text":"Level 2","Value":1,"Unbind":false},
  {"Name":"Level3","Text":"Level 3","Value":2,"Unbind":false},
  {"Name":"Dynamic","Text":"Dynamic","Value":3,"Unbind":false}
]}
```

`E2A0_06_SharpShooterSize_E` — `ENT/E2A0_06_SharpShooterSize_E.cs:5`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_06_SharpShooterSize_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"Num_1_0","Text":"1","Value":1,"Unbind":false},
  {"Name":"Num_1_5","Text":"1.5","Value":2,"Unbind":false},
  {"Name":"Num_2_0","Text":"2.0","Value":3,"Unbind":false}
]}
```

`E2A0_11_OSDSettingTimeOut_E` — `ENT/E2A0_11_OSDSettingTimeOut_E.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_11_OSDSettingTimeOut_E","members":[
  {"Name":"Time_5","Text":"5 s","Value":0,"Unbind":false},
  {"Name":"Time_10","Text":"10 s","Value":1,"Unbind":false},
  {"Name":"Time_20","Text":"20 s","Value":2,"Unbind":false},
  {"Name":"Time_30","Text":"30 s","Value":3,"Unbind":false},
  {"Name":"Time_60","Text":"60 s","Value":4,"Unbind":false}
]}
```

`E2A0_12_USB_C_Setting_E` — `ENT/E2A0_12_USB_C_Setting_E.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_12_USB_C_Setting_E","members":[
  {"Name":"USB_2_0","Text":"USB2.0(High Resolution)","Value":0,"Unbind":false},
  {"Name":"USB_3_2","Text":"USB3.2(High Data Speed)","Value":1,"Unbind":false}
]}
```

`E2A0_14_USB_Upstream_E` — `ENT/E2A0_14_USB_Upstream_E.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_14_USB_Upstream_E","members":[
  {"Name":"USB_C","Text":"USB C","Value":0,"Unbind":false},
  {"Name":"USB_Up","Text":"USB Up","Value":1,"Unbind":false}
]}
```

`E2A0_15_KVM_E` — `ENT/E2A0_15_KVM_E.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_15_KVM_E","members":[
  {"Name":"KVM_Status_Auto","Text":"Auto","Value":0,"Unbind":false},
  {"Name":"KVM_Status_USB_C","Text":"Usb C","Value":1,"Unbind":false},
  {"Name":"KVM_Status_USB_Up","Text":"Usb Up","Value":2,"Unbind":false},
  {"Name":"KVM_Status_USB_C2","Text":"Usb C2","Value":3,"Unbind":false},
  {"Name":"KVM_Status_Thunderbolt","Text":"Thunderbolt","Value":4,"Unbind":false}
]}
```

`E2A0_18_LocalDimming_E` — `ENT/E2A0_18_LocalDimming_E.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_18_LocalDimming_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"ON","Text":"On","Value":1,"Unbind":false},
  {"Name":"Weak","Text":"弱","Value":2,"Unbind":false},
  {"Name":"Medium","Text":"中","Value":3,"Unbind":false},
  {"Name":"Strong","Text":"强","Value":4,"Unbind":false}
]}
```

`E2A0_19_AmbiglowLightMode_E` — `ENT/E2A0_19_AmbiglowLightMode_E.cs:6`, 10 members, 1 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_19_AmbiglowLightMode_E","members":[
  {"Name":"AmbiglowOff","Text":"Ambiglow Off","Value":0,"Unbind":true},
  {"Name":"FollowVideo","Text":"Follow Video","Value":1,"Unbind":false},
  {"Name":"FollowAudio","Text":"Follow Audio","Value":2,"Unbind":false},
  {"Name":"ColorShift","Text":"Color Shift","Value":3,"Unbind":false},
  {"Name":"ColorWave","Text":"Color Wave","Value":4,"Unbind":false},
  {"Name":"ColorBreathing","Text":"Color Breathing","Value":5,"Unbind":false},
  {"Name":"StarryNight","Text":"Starry Night","Value":6,"Unbind":false},
  {"Name":"StaticMode","Text":"Static Mode","Value":7,"Unbind":false},
  {"Name":"ColorFlowReverse","Text":"Color Flow Reverse","Value":8,"Unbind":false},
  {"Name":"ColorFlow","Text":"Color Flow","Value":9,"Unbind":false}
]}
```

`E2A0_1A_AmbiglowColors_E` — `ENT/E2A0_1A_AmbiglowColors_E.cs:5`, 14 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_1A_AmbiglowColors_E","members":[
  {"Name":"Rainbow","Text":"Rainbow","Value":0,"Unbind":false},
  {"Name":"White","Text":"White","Value":1,"Unbind":false},
  {"Name":"Red","Text":"Red","Value":2,"Unbind":false},
  {"Name":"Rose","Text":"Rose","Value":3,"Unbind":false},
  {"Name":"Magenta","Text":"Magenta","Value":4,"Unbind":false},
  {"Name":"Violet","Text":"Violet","Value":5,"Unbind":false},
  {"Name":"Blue","Text":"Blue","Value":6,"Unbind":false},
  {"Name":"Azure","Text":"Azure","Value":7,"Unbind":false},
  {"Name":"Cyan","Text":"Cyan","Value":8,"Unbind":false},
  {"Name":"Aqua","Text":"Aqua","Value":9,"Unbind":false},
  {"Name":"Green","Text":"Green","Value":10,"Unbind":false},
  {"Name":"Pear","Text":"Pear","Value":11,"Unbind":false},
  {"Name":"Yellow","Text":"Yellow","Value":12,"Unbind":false},
  {"Name":"Orange","Text":"Orange","Value":13,"Unbind":false}
]}
```

`E2A0_1B_AmbiglowLightPosition_E` — `ENT/E2A0_1B_AmbiglowLightPosition_E.cs:5`, 7 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_1B_AmbiglowLightPosition_E","members":[
  {"Name":"AllZones","Text":"All Zones","Value":0,"Unbind":false},
  {"Name":"FourSided","Text":"4-sided","Value":1,"Unbind":false},
  {"Name":"Central","Text":"Central","Value":2,"Unbind":false},
  {"Name":"Bottom","Text":"Bottom","Value":3,"Unbind":false},
  {"Name":"ThirdSidedA","Text":"3-sided-A","Value":4,"Unbind":false},
  {"Name":"ThirdSidedB","Text":"3-sided-B","Value":5,"Unbind":false},
  {"Name":"Right_Left","Text":"Right-Left","Value":6,"Unbind":false}
]}
```

`E2A0_1C_AmbiglowLightBrightness_E` — `ENT/E2A0_1C_AmbiglowLightBrightness_E.cs:5`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_1C_AmbiglowLightBrightness_E","members":[
  {"Name":"Bright","Text":"Bright","Value":0,"Unbind":false},
  {"Name":"Brighter","Text":"Brighter","Value":1,"Unbind":false},
  {"Name":"Brightest","Text":"Brightest","Value":2,"Unbind":false}
]}
```

`E2A0_1D_AmbiglowLightSpeed_E` — `ENT/E2A0_1D_AmbiglowLightSpeed_E.cs:5`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_1D_AmbiglowLightSpeed_E","members":[
  {"Name":"Low","Text":"Low","Value":0,"Unbind":false},
  {"Name":"Normal","Text":"Normal","Value":1,"Unbind":false},
  {"Name":"High","Text":"High","Value":2,"Unbind":false}
]}
```

`E2A0_1E_AmbiglowLightDirection_E` — `ENT/E2A0_1E_AmbiglowLightDirection_E.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_1E_AmbiglowLightDirection_E","members":[
  {"Name":"RtoL","Text":"R to L","Value":0,"Unbind":false},
  {"Name":"LtoR","Text":"L to R","Value":1,"Unbind":false}
]}
```

`E2A0_1F_HDMIRefreshRate_E` — `ENT/E2A0_1F_HDMIRefreshRate_E.cs:5`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_1F_HDMIRefreshRate_E","members":[
  {"Name":"HDMI1RefreshRateStatus","Text":"HDMI 1 Refresh Rate Status","Value":0,"Unbind":false},
  {"Name":"HDMI2RefreshRateStatus","Text":"HDMI 2 Refresh Rate Status","Value":1,"Unbind":false},
  {"Name":"HDMI3RefreshRateStatus","Text":"HDMI 3 Refresh Rate Status","Value":2,"Unbind":false}
]}
```

`E2A0_20_ColorSpace_E` — `ENT/E2A0_20_ColorSpace_E.cs:5`, 18 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_20_ColorSpace_E","members":[
  {"Name":"Standard","Text":"Standard","Value":0,"Unbind":false},
  {"Name":"NTSC","Text":"NTSC","Value":1,"Unbind":false},
  {"Name":"sRGB","Text":"sRGB","Value":2,"Unbind":false},
  {"Name":"AdboeRGB","Text":"Adboe RGB","Value":3,"Unbind":false},
  {"Name":"DCI_P3","Text":"DCI - P3","Value":4,"Unbind":false},
  {"Name":"Rec2020","Text":"Rec 2020","Value":5,"Unbind":false},
  {"Name":"Rec709","Text":"Rec 709","Value":6,"Unbind":false},
  {"Name":"D_mode","Text":"D-mode","Value":7,"Unbind":false},
  {"Name":"REC2020_HDR","Text":"REC 2020(HDR)","Value":8,"Unbind":false},
  {"Name":"DCI_P3_HDR","Text":"DCI-P3(HDR)","Value":9,"Unbind":false},
  {"Name":"OFF","Text":"Off","Value":10,"Unbind":false},
  {"Name":"ON","Text":"On","Value":11,"Unbind":false},
  {"Name":"AdboeRGB_D50","Text":"Adoby RGB(D50)","Value":12,"Unbind":false},
  {"Name":"DCI_P3_D50","Text":"DCI - P3(D50)","Value":13,"Unbind":false},
  {"Name":"Display_P3","Text":"Display-P3","Value":14,"Unbind":false},
  {"Name":"Native","Text":"Native","Value":15,"Unbind":false},
  {"Name":"AutoGamut","Text":"Auto Gamut","Value":16,"Unbind":false},
  {"Name":"MultiColorSync","Text":"Multi-ColorSync","Value":17,"Unbind":false}
]}
```

`E2A0_22_ErgoSensor_E` — `ENT/E2A0_22_ErgoSensor_E.cs:5`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_22_ErgoSensor_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"ON","Text":"On","Value":1,"Unbind":false},
  {"Name":"DEMO","Text":"Demo","Value":2,"Unbind":false}
]}
```

`E2A0_25_SharpShooterLocation_E` — `ENT/E2A0_25_SharpShooterLocation_E.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_25_SharpShooterLocation_E","members":[
  {"Name":"Center","Text":"Center","Value":0,"Unbind":false},
  {"Name":"Top","Text":"Top","Value":1,"Unbind":false}
]}
```

`E2A0_34_PixelOrbiting_E` — `ENT/E2A0_34_PixelOrbiting_E.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_34_PixelOrbiting_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"ON","Text":"On","Value":1,"Unbind":false},
  {"Name":"Slow","Text":"Slow","Value":2,"Unbind":false},
  {"Name":"Normal","Text":"Normal","Value":3,"Unbind":false},
  {"Name":"Fast","Text":"Fast","Value":4,"Unbind":false}
]}
```

`E2A0_35_ScreenSaver_E` — `ENT/E2A0_35_ScreenSaver_E.cs:5`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_35_ScreenSaver_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"ON","Text":"On","Value":1,"Unbind":false},
  {"Name":"Slow","Text":"Slow","Value":2,"Unbind":false},
  {"Name":"Fast","Text":"Fast","Value":3,"Unbind":false}
]}
```

`E2A0_41_FanControl_E` — `ENT/E2A0_41_FanControl_E.cs:5`, 3 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_41_FanControl_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"Auto","Text":"Auto","Value":1,"Unbind":false},
  {"Name":"Quiet","Text":"Quiet","Value":2,"Unbind":false}
]}
```

`E2A0_42_ResetSmartImage_E` — `ENT/E2A0_42_ResetSmartImage_E.cs:3`, 18 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_42_ResetSmartImage_E","members":[
  {"Name":"Reset_SmartImage_Standard","Text":"Reset_SmartImage_Standard","Value":48,"Unbind":false},
  {"Name":"Reset_SmartImage_FPS","Text":"Reset_SmartImage_FPS","Value":49,"Unbind":false},
  {"Name":"Reset_SmartImage_Racing","Text":"Reset_SmartImage_Racing","Value":50,"Unbind":false},
  {"Name":"Reset_SmartImage_RTS","Text":"Reset_SmartImage_RTS","Value":51,"Unbind":false},
  {"Name":"Reset_SmartImage_Movie","Text":"Reset_SmartImage_Movie","Value":52,"Unbind":false},
  {"Name":"Reset_SmartImage_LowBlueMode","Text":"Reset_SmartImage_LowBlueMode","Value":53,"Unbind":false},
  {"Name":"Reset_SmartImage_EasyRead","Text":"Reset_SmartImage_EasyRead","Value":54,"Unbind":false},
  {"Name":"Reset_SmartImage_Economy","Text":"Reset_SmartImage_Economy","Value":55,"Unbind":false},
  {"Name":"Reset_SmartImage_SmartUniformity","Text":"Reset_SmartImage_SmartUniformity","Value":56,"Unbind":false},
  {"Name":"Reset_SmartImage_Game1","Text":"Reset_SmartImage_Game1","Value":57,"Unbind":false},
  {"Name":"Reset_SmartImage_Game2","Text":"Reset_SmartImage_Game2","Value":58,"Unbind":false},
  {"Name":"Reset_SmartImageHDRGame","Text":"Reset_SmartImageHDRGame","Value":59,"Unbind":false},
  {"Name":"Reset_SmartImageHDRMovie","Text":"Reset_SmartImageHDRMovie","Value":60,"Unbind":false},
  {"Name":"Reset_SmartImageHDRVivid","Text":"Reset_SmartImageHDRVivid","Value":61,"Unbind":false},
  {"Name":"Reset_SmartImageHDRPersonal","Text":"Reset_SmartImageHDRPersonal","Value":62,"Unbind":false},
  {"Name":"Reset_SmartImage_ConsoleMode","Text":"Reset_SmartImage_ConsoleMode","Value":63,"Unbind":false},
  {"Name":"Reset_SmartImage_IllustratorMode","Text":"Reset_SmartImage_IllustratorMode","Value":64,"Unbind":false},
  {"Name":"Reset_SmartImageHDRPeak","Text":"Reset_SmartImageHDRPeak","Value":65,"Unbind":false}
]}
```

`E2A0_59_DualResolution_E` — `ENT/E2A0_59_DualResolution_E.cs:5`, 34 members, 0 `[UnbindEnumExtended]`; renamed in `work/dotnet-clean` (real names used here): `const_12`→`WUHD120Hz`, `const_13`→`WFHD240Hz`

```json
{"enum":"E2A0_59_DualResolution_E","members":[
  {"Name":"UHD120Hz","Text":"UHD 120Hz","Value":0,"Unbind":false},
  {"Name":"UHD160Hz","Text":"UHD 160Hz","Value":1,"Unbind":false},
  {"Name":"FHD360HZ","Text":"FHD 360Hz","Value":2,"Unbind":false},
  {"Name":"FHD320HZ","Text":"FHD 320Hz","Value":3,"Unbind":false},
  {"Name":"UHD240Hz","Text":"UHD 240Hz","Value":4,"Unbind":false},
  {"Name":"FHD480HZ","Text":"FHD 480Hz","Value":5,"Unbind":false},
  {"Name":"UHD180Hz","Text":"UHD 180Hz","Value":6,"Unbind":false},
  {"Name":"UHD200Hz","Text":"UHD 200Hz","Value":7,"Unbind":false},
  {"Name":"FHD400HZ","Text":"FHD 400Hz","Value":8,"Unbind":false},
  {"Name":"WUHD120Hz","Text":"WUHD 120Hz","Value":9,"Unbind":false},
  {"Name":"WFHD240Hz","Text":"WFHD 240Hz","Value":16,"Unbind":false},
  {"Name":"_5K_165Hz","Text":"5K 165Hz","Value":17,"Unbind":false},
  {"Name":"QHD330Hz","Text":"QHD 330Hz","Value":18,"Unbind":false},
  {"Name":"UHD190Hz","Text":"UHD 190Hz","Value":19,"Unbind":false},
  {"Name":"FHD380Hz","Text":"FHD 380Hz","Value":20,"Unbind":false},
  {"Name":"QHD500Hz","Text":"QHD 500Hz","Value":21,"Unbind":false},
  {"Name":"QHD540Hz","Text":"QHD 540Hz","Value":22,"Unbind":false},
  {"Name":"HD1000Hz","Text":"HD 1000Hz","Value":23,"Unbind":false},
  {"Name":"_5K_180Hz","Text":"5K 180Hz","Value":24,"Unbind":false},
  {"Name":"QHD360Hz","Text":"QHD 360Hz","Value":25,"Unbind":false},
  {"Name":"QHD144Hz","Text":"QHD 144Hz","Value":32,"Unbind":false},
  {"Name":"HD288Hz","Text":"HD 288Hz","Value":33,"Unbind":false},
  {"Name":"QHD240Hz","Text":"QHD 240Hz","Value":34,"Unbind":false},
  {"Name":"QHD260Hz","Text":"QHD 260Hz","Value":35,"Unbind":false},
  {"Name":"HD400Hz","Text":"HD 400Hz","Value":36,"Unbind":false},
  {"Name":"QHD350Hz","Text":"QHD 350Hz","Value":37,"Unbind":false},
  {"Name":"_5K_175Hz","Text":"5K 175Hz","Value":38,"Unbind":false},
  {"Name":"QHD200Hz","Text":"QHD 200Hz","Value":39,"Unbind":false},
  {"Name":"HD280Hz","Text":"HD 280Hz","Value":40,"Unbind":false},
  {"Name":"QHD275Hz","Text":"QHD 275Hz","Value":41,"Unbind":false},
  {"Name":"HD500Hz","Text":"HD 500Hz","Value":48,"Unbind":false},
  {"Name":"HD540Hz","Text":"HD 540Hz","Value":49,"Unbind":false},
  {"Name":"FHD240HZ","Text":"FHD 240Hz","Value":50,"Unbind":false},
  {"Name":"QHD230Hz","Text":"QHD 230Hz","Value":51,"Unbind":false}
]}
```

`E2A0_6B_Profile_E` — `ENT/E2A0_6B_Profile_E.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_6B_Profile_E","members":[
  {"Name":"Profile1","Text":"Profile 1","Value":1,"Unbind":false},
  {"Name":"Profile2","Text":"Profile 2","Value":2,"Unbind":false}
]}
```

`E2A0_88_GamePQ_E` — `ENT/E2A0_88_GamePQ_E.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_88_GamePQ_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"ObjectOutlineEnhancement","Text":"Object Outline Enhancement","Value":1,"Unbind":false},
  {"Name":"NegativeEffect","Text":"Negative Effect","Value":2,"Unbind":false},
  {"Name":"ColorFilter","Text":"Color Filter","Value":3,"Unbind":false},
  {"Name":"NonLinearScaling","Text":"Non Linear Scaling","Value":4,"Unbind":false}
]}
```

`E2A0_HDMIRefreshRate_E` — `ENT/E2A0_HDMIRefreshRate_E.cs:5`, 24 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"E2A0_HDMIRefreshRate_E","members":[
  {"Name":"RefreshRate_120Hz","Text":"120Hz","Value":0,"Unbind":false},
  {"Name":"RefreshRate_138Hz","Text":"138Hz","Value":1,"Unbind":false},
  {"Name":"RefreshRate_144Hz","Text":"144Hz","Value":2,"Unbind":false},
  {"Name":"RefreshRate_165Hz","Text":"165Hz","Value":3,"Unbind":false},
  {"Name":"RefreshRate_200Hz","Text":"200Hz","Value":4,"Unbind":false},
  {"Name":"RefreshRate_240Hz","Text":"240Hz","Value":5,"Unbind":false},
  {"Name":"RefreshRate_260Hz","Text":"260Hz","Value":6,"Unbind":false},
  {"Name":"RefreshRate_280Hz","Text":"280Hz","Value":7,"Unbind":false},
  {"Name":"RefreshRate_300Hz","Text":"300Hz","Value":8,"Unbind":false},
  {"Name":"RefreshRate_320Hz","Text":"320Hz","Value":9,"Unbind":false},
  {"Name":"RefreshRate_360Hz","Text":"360Hz","Value":10,"Unbind":false},
  {"Name":"RefreshRate_380Hz","Text":"380Hz","Value":11,"Unbind":false},
  {"Name":"RefreshRate_4K","Text":"4K","Value":12,"Unbind":false},
  {"Name":"RefreshRate_5K","Text":"5K","Value":13,"Unbind":false},
  {"Name":"RefreshRate_540Hz","Text":"540Hz","Value":14,"Unbind":false},
  {"Name":"RefreshRate_600Hz","Text":"600Hz","Value":15,"Unbind":false},
  {"Name":"RefreshRate_160Hz","Text":"160Hz","Value":16,"Unbind":false},
  {"Name":"RefreshRate_500Hz","Text":"500Hz","Value":17,"Unbind":false},
  {"Name":"RefreshRate_610Hz","Text":"610Hz","Value":18,"Unbind":false},
  {"Name":"RefreshRate_400Hz","Text":"400Hz","Value":19,"Unbind":false},
  {"Name":"RefreshRate_310Hz","Text":"310Hz","Value":20,"Unbind":false},
  {"Name":"RefreshRate_425Hz","Text":"425Hz","Value":21,"Unbind":false},
  {"Name":"RefreshRate_340Hz","Text":"340Hz","Value":22,"Unbind":false},
  {"Name":"RefreshRate_1000Hz","Text":"1000Hz","Value":23,"Unbind":false}
]}
```

`E2A0_SettingUser_E` — `ENT/E2A0_SettingUser_E.cs:5`, 10 members, 0 `[UnbindEnumExtended]`; renamed in `work/dotnet-clean` (real names used here): `const_8`→`USBCSetting`

```json
{"enum":"E2A0_SettingUser_E","members":[
  {"Name":"AudioSource","Text":"Audio Source","Value":0,"Unbind":false},
  {"Name":"Volume","Text":"Volume","Value":1,"Unbind":false},
  {"Name":"Input","Text":"Input","Value":2,"Unbind":false},
  {"Name":"PowerSensor","Text":"Power Sensor","Value":3,"Unbind":false},
  {"Name":"ColorSpace","Text":"Color Space","Value":4,"Unbind":false},
  {"Name":"KVM","Text":"KVM","Value":5,"Unbind":false},
  {"Name":"MultiView","Text":"MultiView","Value":6,"Unbind":false},
  {"Name":"Brightness","Text":"Brightness","Value":7,"Unbind":false},
  {"Name":"USBCSetting","Text":"USB Setting","Value":8,"Unbind":false},
  {"Name":"HDRColorSpace","Text":"HDR Color Space","Value":9,"Unbind":false}
]}
```

#### Generic value enums

`Level_Off_E` — `ENT/Level_Off_E.cs:5`, 5 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"Level_Off_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"Level1","Text":"Level 1","Value":1,"Unbind":false},
  {"Name":"Level2","Text":"Level 2","Value":2,"Unbind":false},
  {"Name":"Level3","Text":"Level 3","Value":3,"Unbind":false},
  {"Name":"Level4","Text":"Level 4","Value":4,"Unbind":false}
]}
```

`Num_0_E` — `ENT/Num_0_E.cs:5`, 8 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"Num_0_E","members":[
  {"Name":"Num_0","Text":"0","Value":0,"Unbind":false},
  {"Name":"Num_1","Text":"1","Value":1,"Unbind":false},
  {"Name":"Num_2","Text":"2","Value":2,"Unbind":false},
  {"Name":"Num_3","Text":"3","Value":3,"Unbind":false},
  {"Name":"Num_4","Text":"4","Value":4,"Unbind":false},
  {"Name":"Num_5","Text":"5","Value":5,"Unbind":false},
  {"Name":"Num_6","Text":"6","Value":6,"Unbind":false},
  {"Name":"Num_7","Text":"7","Value":7,"Unbind":false}
]}
```

`Num_Off_E` — `ENT/Num_Off_E.cs:5`, 8 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"Num_Off_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"Num_1","Text":"1","Value":1,"Unbind":false},
  {"Name":"Num_2","Text":"2","Value":2,"Unbind":false},
  {"Name":"Num_3","Text":"3","Value":3,"Unbind":false},
  {"Name":"Num_4","Text":"4","Value":4,"Unbind":false},
  {"Name":"Num_5","Text":"5","Value":5,"Unbind":false},
  {"Name":"Num_6","Text":"6","Value":6,"Unbind":false},
  {"Name":"Num_7","Text":"7","Value":7,"Unbind":false}
]}
```

`SwitchFlag_E` — `ENT/SwitchFlag_E.cs:5`, 2 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"SwitchFlag_E","members":[
  {"Name":"OFF","Text":"Off","Value":0,"Unbind":false},
  {"Name":"ON","Text":"On","Value":1,"Unbind":false}
]}
```

#### Effect and device enums

`EffectType` — `ENT/EffectType.cs:6`, 38 members, 1 `[UnbindEnumExtended]`

```json
{"enum":"EffectType","members":[
  {"Name":"Default","Text":"默认","Value":-1,"Unbind":true},
  {"Name":"Off","Text":"关闭","Value":0,"Unbind":false},
  {"Name":"FollowVideo","Text":"光影同步","Value":1,"Unbind":false},
  {"Name":"FollowAudio","Text":"光音同步","Value":2,"Unbind":false},
  {"Name":"ColorShift","Text":"跑马灯模式","Value":3,"Unbind":false},
  {"Name":"ColorWave","Text":"波浪模式","Value":4,"Unbind":false},
  {"Name":"Breathing","Text":"呼吸模式","Value":5,"Unbind":false},
  {"Name":"StarryNight","Text":"繁星模式","Value":6,"Unbind":false},
  {"Name":"Static","Text":"恒亮模式","Value":7,"Unbind":false},
  {"Name":"Blink","Text":"闪烁模式","Value":8,"Unbind":false},
  {"Name":"Neon","Text":"霓虹模式","Value":9,"Unbind":false},
  {"Name":"ColorWaveW","Text":"W波浪模式","Value":10,"Unbind":false},
  {"Name":"ColorWaveLine","Text":"线条波浪模式","Value":11,"Unbind":false},
  {"Name":"Radar","Text":"雷达模式","Value":12,"Unbind":false},
  {"Name":"Laser","Text":"激光模式","Value":13,"Unbind":false},
  {"Name":"Ripple","Text":"涟漪模式","Value":14,"Unbind":false},
  {"Name":"PressActionOn","Text":"反应模式[灭->亮->灭]","Value":20,"Unbind":false},
  {"Name":"PressActionOff","Text":"反应模式[亮->灭->亮]","Value":21,"Unbind":false},
  {"Name":"Coverge","Text":"Coverge模式","Value":22,"Unbind":false},
  {"Name":"Kaleidoscope","Text":"Kaleidoscope模式","Value":23,"Unbind":false},
  {"Name":"Dazzing","Text":"Dazzing","Value":24,"Unbind":false},
  {"Name":"RainDown","Text":"下雨","Value":25,"Unbind":false},
  {"Name":"Meteor","Text":"流星","Value":26,"Unbind":false},
  {"Name":"BeiYing_Static","Text":"常亮","Value":101,"Unbind":false},
  {"Name":"BeiYing_Breathing","Text":"呼吸","Value":102,"Unbind":false},
  {"Name":"BeiYing_Neon","Text":"霓虹","Value":103,"Unbind":false},
  {"Name":"BeiYing_Laser","Text":"一触即发","Value":104,"Unbind":false},
  {"Name":"BeiYing_RainDown","Text":"雨落珠帘","Value":105,"Unbind":false},
  {"Name":"BeiYing_RainbowRoulette","Text":"彩虹轮盘","Value":106,"Unbind":false},
  {"Name":"BeiYing_ColorWaveLine","Text":"按键涟漪","Value":107,"Unbind":false},
  {"Name":"BeiYing_StarryNight","Text":"繁星点点","Value":108,"Unbind":false},
  {"Name":"BeiYing_ColorShift","Text":"川流不息","Value":109,"Unbind":false},
  {"Name":"BeiYing_ColorWave","Text":"随波逐流","Value":110,"Unbind":false},
  {"Name":"BeiYing_PressActionOn","Text":"单点亮","Value":111,"Unbind":false},
  {"Name":"BeiYing_ColorWaveW","Text":"正炫光波","Value":112,"Unbind":false},
  {"Name":"BeiYing_RotaryWindmill","Text":"旋转风车","Value":113,"Unbind":false},
  {"Name":"BeiYing_RainbowFalls","Text":"彩虹瀑布","Value":114,"Unbind":false},
  {"Name":"BeiYing_Kaleidoscope","Text":"花开富贵","Value":115,"Unbind":false}
]}
```

`RegionType` — `ENT/RegionType.cs:6`, 7 members, 1 `[UnbindEnumExtended]`

```json
{"enum":"RegionType","members":[
  {"Name":"Default","Text":"默认","Value":-1,"Unbind":true},
  {"Name":"AllZones","Text":"All Zones","Value":0,"Unbind":false},
  {"Name":"FourSided","Text":"4-sided","Value":1,"Unbind":false},
  {"Name":"Central","Text":"Central","Value":2,"Unbind":false},
  {"Name":"Bottom","Text":"Bottom","Value":3,"Unbind":false},
  {"Name":"ThirdSidedA","Text":"3-sided-A","Value":4,"Unbind":false},
  {"Name":"ThirdSidedB","Text":"3-sided-B","Value":5,"Unbind":false}
]}
```

`DirectionType` — `ENT/DirectionType.cs:6`, 13 members, 1 `[UnbindEnumExtended]`

```json
{"enum":"DirectionType","members":[
  {"Name":"Default","Text":"默认","Value":-1,"Unbind":true},
  {"Name":"LeftToRight","Text":"从左至右","Value":0,"Unbind":false},
  {"Name":"RightToLeft","Text":"从右至左","Value":1,"Unbind":false},
  {"Name":"UpToDown","Text":"从上至下","Value":2,"Unbind":false},
  {"Name":"DownToUp","Text":"从下至上","Value":3,"Unbind":false},
  {"Name":"Gathered","Text":"聚拢","Value":4,"Unbind":false},
  {"Name":"Spread","Text":"扩散","Value":5,"Unbind":false},
  {"Name":"ClockWise","Text":"顺时针","Value":6,"Unbind":false},
  {"Name":"CounterClockWise","Text":"逆时针","Value":7,"Unbind":false},
  {"Name":"LeftOrBotton","Text":"LeftOrBotton","Value":8,"Unbind":false},
  {"Name":"RightOrTop","Text":"RightOrTop","Value":9,"Unbind":false},
  {"Name":"Sequence","Text":"Sequence","Value":10,"Unbind":false},
  {"Name":"Clip","Text":"Clip","Value":11,"Unbind":false}
]}
```

`EquipmentType` — `ENT/EquipmentType.cs:6`, 6 members, 1 `[UnbindEnumExtended]`

```json
{"enum":"EquipmentType","members":[
  {"Name":"Unknown","Text":"未知","Value":0,"Unbind":true},
  {"Name":"Display","Text":"显示器","Value":1,"Unbind":false},
  {"Name":"Keyboard","Text":"键盘","Value":2,"Unbind":false},
  {"Name":"Mouse","Text":"鼠标","Value":3,"Unbind":false},
  {"Name":"MousePad","Text":"鼠标垫","Value":4,"Unbind":false},
  {"Name":"Headset","Text":"耳机","Value":5,"Unbind":false}
]}
```

`DeviceType` — `ENT/DeviceType.cs:7`, 29 members, 3 `[UnbindEnumExtended]`

```json
{"enum":"DeviceType","members":[
  {"Name":"Unknown","Text":"未知","Value":0,"Unbind":true},
  {"Name":"PHL_CDeviceDisplay","Text":"Display","Value":100000,"Unbind":false},
  {"Name":"RongYuan_KeyboardSPK8708","Text":"SPK8708","Value":200000,"Unbind":false},
  {"Name":"RongYuan_KeyboardSPK8508","Text":"SPK8508","Value":200001,"Unbind":false},
  {"Name":"RongYuan_KeyboardSPK8308","Text":"SPK8308","Value":200002,"Unbind":false},
  {"Name":"RongYuan_KeyboardSPK8708_BLE","Text":"SPK8708","Value":200003,"Unbind":false},
  {"Name":"RongYuan_KeyboardSPK8708_24G","Text":"SPK8708","Value":200004,"Unbind":false},
  {"Name":"BeiYing_KeyboardSPK8618","Text":"SPK8618","Value":201000,"Unbind":false},
  {"Name":"BeiYing_KeyboardSPK8618_24G","Text":"SPK8618","Value":201001,"Unbind":false},
  {"Name":"RongYuan_MouseSPK9708","Text":"SPK9708","Value":300000,"Unbind":false},
  {"Name":"RongYuan_MouseSPK9508","Text":"SPK9508","Value":300001,"Unbind":false},
  {"Name":"RongYuan_MouseSPK9308","Text":"SPK9308","Value":300002,"Unbind":false},
  {"Name":"RongYuan_MouseSPK9708_BLE","Text":"Bluetooth_SPK9708","Value":300003,"Unbind":true},
  {"Name":"RongYuan_MouseSPK9708_24G","Text":"Bluetooth_SPK9708","Value":300004,"Unbind":false},
  {"Name":"JiangMeng_MouseSPK9718","Text":"SPK9718","Value":301000,"Unbind":false},
  {"Name":"JiangMeng_Mouse_Dongle_8K","Text":"Dongle","Value":301001,"Unbind":false},
  {"Name":"JiangMeng_MouseSPK9728","Text":"SPK9728","Value":301002,"Unbind":false},
  {"Name":"YongJiaXing_MouseSPK9618","Text":"SPK9618","Value":302000,"Unbind":false},
  {"Name":"YongJiaXing_MouseSPK9618_24G","Text":"SPK9618 24G","Value":302001,"Unbind":false},
  {"Name":"YongJiaXing_MouseSPK9418","Text":"SPK9418","Value":302002,"Unbind":false},
  {"Name":"YongJiaXing_MouseSPK9418_24G","Text":"SPK9418 24G","Value":302003,"Unbind":false},
  {"Name":"HaiHui_MouseSPK9618_3395","Text":"SPK9618","Value":303000,"Unbind":false},
  {"Name":"HaiHui_MouseSPK9618_3395_24G","Text":"SPK9618_24G","Value":303001,"Unbind":false},
  {"Name":"HaiHui_MouseSPK9618_3395_BLE","Text":"SPK9618_BLE","Value":303002,"Unbind":true},
  {"Name":"HaiHui_MouseSPK9618_8960","Text":"SPK9618","Value":303003,"Unbind":false},
  {"Name":"HaiHui_MouseSPK9618_8960_24G","Text":"SPK9618_24G","Value":303004,"Unbind":false},
  {"Name":"RongYuan_MousePadSPL7508","Text":"SPL7508","Value":400001,"Unbind":false},
  {"Name":"PHL_CDeviceTAG4106","Text":"Headset","Value":500000,"Unbind":false},
  {"Name":"PHL_CDeviceTAG5106","Text":"Headset","Value":500001,"Unbind":false}
]}
```

`ConnectMode` — `ENT/ConnectMode.cs:3`, 4 members, 0 `[UnbindEnumExtended]`

```json
{"enum":"ConnectMode","members":[
  {"Name":"Unknown","Text":"Unknown","Value":-1,"Unbind":false},
  {"Name":"USB","Text":"USB","Value":0,"Unbind":false},
  {"Name":"BLE","Text":"BLE","Value":1,"Unbind":false},
  {"Name":"Dongle","Text":"Dongle","Value":2,"Unbind":false}
]}
```


---

## 3. (b) Every `AttributeInfo` in `T_PHLDisplay_Profile` → VCP → ValueList source → special rule

- **Scope.** There are 88 `AttributeInfo` properties, in JSON order: `OP_DC` + 13 SmartImage + 5 SmartImageHDR + 19 GameMode + 6 Ambiglow + 5 Input + 4 Audio + 17 System + 18 Setup.
- **Sources.** Property lists: `OPT/T_PHLDisplay_Profile.cs:16`, `OPT/SubModuleSmartImage.cs`, `OPT/SubModuleSmartImageHDR.cs`, `OPT/DisplayModule*.cs`. Each property's initializer was checked to construct the same VCP as its name.
- **Column "Bound?".** `yes` means the code is in `StandardList`/`E2A0_ExternList` (not Unbind). All 88 are bound.
- **Column "caps".** The user's capability sub-list; `–` means the code is not in caps, so `err_code` is 9.
- **Rule location.** Every "ValueList source" and "Rule location" entry is CONFIRMED at the cited `PBASE/DataOSD.cs` line.

| # | JSON path (`T_PHLDisplay_Profile.`) | VCP | Bound? | ValueList source | Rule location | 34M2C8600 caps sub-list | Special rule |
|---|---|---|---|---|---|---|---|
| 1 | `OP_DC_DisplayApplication` | 0xDC | yes | smethod_1 (DC tables) | DataOSD.cs:195-221 | (00 01 03 04 05 06 07 08 0B 0E 11 20 21 22 23 24 30 33 51 E2) | Table chosen by the LAST caps byte of DC (0xE1..0xE4 → `SmartImage_E1..E4`, DataOSD.cs:197-211); `SmartImageHDR_E` ∩ caps appended after it (212-220), so the list is [SDR sorted] + [HDR sorted], not globally sorted. If the last byte is not E1..E4 the list is the HDR part only. method_4 then splits it: HDR → `ModuleSmartImageHDR.Items` = list ∩ `SmartImageHDR_E` (CDevice_PHLDisplay.cs:338); SDR → `ModuleSmartImage.Items` = list − `SmartImageHDR_E` (347). The other Items list is never touched and stays `[]`. |
| 2 | `ModuleSmartImage.CurSubSmartImage.OP_10_Luminance` | 0x10 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 3 | `ModuleSmartImage.CurSubSmartImage.OP_12_Contrast` | 0x12 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 4 | `ModuleSmartImage.CurSubSmartImage.OP_F0_SmartContrast` | 0xF0 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:236 | (00 01) |  |
| 5 | `ModuleSmartImage.CurSubSmartImage.OP_72_Gamma` | 0x72 | yes | `VCP_72_Gamma` (smethod_3) | DataOSD.cs:174 | (50 64 78 8C A0) |  |
| 6 | `ModuleSmartImage.CurSubSmartImage.OP_87_Sharpness` | 0x87 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 7 | `ModuleSmartImage.CurSubSmartImage.EXT_OP_E2A0_20_ColorSpace` | 0xE2A020 | yes | `E2A0_20_ColorSpace_E` (smethod_3) | DataOSD.cs:300 | (02 03 04 0F) | Renderer: if exactly 2 entries and one has `Text=="sRGB"`, shows an sRGB switch instead of a select (SmartImage-DuKfuYFN.js:168-173). |
| 8 | `ModuleSmartImage.CurSubSmartImage.OP_14_SelectColorPreset` | 0x14 | yes | `VCP_14_SelectColorPreset` (smethod_3) | DataOSD.cs:168 | (02 04 05 06 07 08 0A 0B 0D) | Renderer shows R/G/B sliders only when the selected entry name is `Preset_UserRGB` (SmartImage-DuKfuYFN.js:411); backend re-reads 16/18/1A when value 11. |
| 9 | `ModuleSmartImage.CurSubSmartImage.OP_16_VideoGainDriveRed` | 0x16 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 10 | `ModuleSmartImage.CurSubSmartImage.OP_18_VideoGainDriveGreen` | 0x18 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 11 | `ModuleSmartImage.CurSubSmartImage.OP_1A_VideoGainDriveBlue` | 0x1A | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 12 | `ModuleSmartImage.CurSubSmartImage.OP_8A_Saturation` | 0x8A | yes | — (no case) | DataOSD.cs:158-243 (no case) | – |  |
| 13 | `ModuleSmartImage.CurSubSmartImage.OP_90_Hue` | 0x90 | yes | — (no case) | DataOSD.cs:158-243 (no case) | – |  |
| 14 | `ModuleSmartImage.CurSubSmartImage.EXT_OP_E2A0_24_DLBL` | 0xE2A024 | yes | `Level_Off_E` (smethod_3) | DataOSD.cs:372 | (00 01 02 03 04) | `Level_Off_E` (shared with E2A044/45/68, DataOSD.cs:372-376). |
| 15 | `ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance` | 0x10 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 16 | `ModuleSmartImageHDR.CurSubSmartImage.OP_12_Contrast` | 0x12 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 17 | `ModuleSmartImageHDR.CurSubSmartImage.EXT_OP_E2A0_3D_LightEnhancement` | 0xE2A03D | yes | — (no case) | DataOSD.cs:245-382 (no case) | – |  |
| 18 | `ModuleSmartImageHDR.CurSubSmartImage.EXT_OP_E2A0_3E_ColorEnhancement` | 0xE2A03E | yes | — (no case) | DataOSD.cs:245-382 (no case) | – |  |
| 19 | `ModuleSmartImageHDR.CurSubSmartImage.EXT_OP_E2A0_3F_DarkEnhancement` | 0xE2A03F | yes | — (no case) | DataOSD.cs:245-382 (no case) | – |  |
| 20 | `ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync` | 0xE2A040 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:363 | (00 01) |  |
| 21 | `ModuleGameMode.EXT_OP_E2A0_02_MBR` | 0xE2A002 | yes | — (no case) | DataOSD.cs:245-382 (no case) | – |  |
| 22 | `ModuleGameMode.EXT_OP_E2A0_03_MBRSync` | 0xE2A003 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:343 | – |  |
| 23 | `ModuleGameMode.EXT_OP_E2A0_04_SmartCrosshair` | 0xE2A004 | yes | `E2A0_04_SmartCrosshair_E` (smethod_3) | DataOSD.cs:258 | (00 01 02) |  |
| 24 | `ModuleGameMode.EXT_OP_E2A0_44_StarkShadowBoost` | 0xE2A044 | yes | `Level_Off_E` (smethod_3) | DataOSD.cs:373 | (00 01 02 03) |  |
| 25 | `ModuleGameMode.EXT_OP_E2A0_45_ShadowBoost` | 0xE2A045 | yes | `Level_Off_E` (smethod_3) | DataOSD.cs:374 | – |  |
| 26 | `ModuleGameMode.EXT_OP_E2A0_06_SharpShooter_Size` | 0xE2A006 | yes | `E2A0_06_SharpShooterSize_E` (smethod_3) | DataOSD.cs:261 | (00 01 02 03) | Names `Num_1_0/Num_1_5/Num_2_0` are rewritten by the renderer to "1.0"/"1.5"/"2.0" (Xu); their `Text` is "1"/"1.5"/"2.0". |
| 27 | `ModuleGameMode.EXT_OP_E2A0_25_SharpShooter_Location` | 0xE2A025 | yes | `E2A0_25_SharpShooterLocation_E` (smethod_3) | DataOSD.cs:309 | – |  |
| 28 | `ModuleGameMode.EXT_OP_E2A0_07_LowInputLag` | 0xE2A007 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:344 | (00 01) |  |
| 29 | `ModuleGameMode.OP_EB_SmartResponse` | 0xEB | yes | `VCP_EB_SmartResponse` (smethod_3) | DataOSD.cs:229 | – |  |
| 30 | `ModuleGameMode.EXT_OP_E2A0_4C_Overclock` | 0xE2A04C | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:368 | – |  |
| 31 | `ModuleGameMode.EXT_OP_E2A0_08_SmartFrame` | 0xE2A008 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:345 | (00 01) |  |
| 32 | `ModuleGameMode.EXT_OP_E2A0_09_SmartFrameSize` | 0xE2A009 | yes | `Num_0_E` (smethod_3) | DataOSD.cs:316 | (01 02 03 04 05 06 07) | `Num_0_E`; renderer uses only the values (GameMode-C1cXG-_T.js:305-306). |
| 33 | `ModuleGameMode.EXT_OP_E2A0_0A_SmartFrameBrightness` | 0xE2A00A | yes | — (no case) | DataOSD.cs:245-382 (no case) | (none) |  |
| 34 | `ModuleGameMode.EXT_OP_E2A0_0B_SmartFrameContrast` | 0xE2A00B | yes | — (no case) | DataOSD.cs:245-382 (no case) | (none) |  |
| 35 | `ModuleGameMode.EXT_OP_E2A0_0C_SmartFrameHPosition` | 0xE2A00C | yes | — (no case) | DataOSD.cs:245-382 (no case) | (none) |  |
| 36 | `ModuleGameMode.EXT_OP_E2A0_0D_SmartFrameVPosition` | 0xE2A00D | yes | — (no case) | DataOSD.cs:245-382 (no case) | (none) |  |
| 37 | `ModuleGameMode.EXT_OP_E2A0_59_DualResolution` | 0xE2A059 | yes | `E2A0_59_DualResolution_E` (smethod_4, caps order) | DataOSD.cs:340 | – | smethod_4: capability ORDER kept, no sort (DataOSD.cs:340-341, 391-404). On load the attribute is cloned; `Value = raw & 0xFF`, `hi = raw >> 8`; if `0 < hi < Count` AND Overclock (E2A04C) is available: Overclock ON → drop the first `hi` entries, else keep only the first `hi` (CDevice_PHLDisplay.cs:355-378). Later, if `UHD120Hz` (0) is present and the input is DP1/DP2/USB-C1/USB-C2 (15/16/21/22), it is removed (445-459). |
| 38 | `ModuleGameMode.EXT_OP_E2A0_68_AutoRefineAIStatus` | 0xE2A068 | yes | `Level_Off_E` (smethod_3) | DataOSD.cs:375 | – |  |
| 39 | `ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode` | 0xE2A019 | yes | `E2A0_19_AmbiglowLightMode_E` (smethod_3) | DataOSD.cs:279 | (00 01 02 03 04 05 06 07) | `AmbiglowOff` (0) is `[UnbindEnumExtended]`, so never in the list. Without ENE, `ModuleAmbiglow.EffectEnable = available && Value != 0`, and a 0 read is rewritten to 7 `StaticMode` (CDevice_PHLDisplay.cs:382-389; again in method_12 :706-726). |
| 40 | `ModuleAmbiglow.EXT_OP_E2A0_1A_AmbiglowColors` | 0xE2A01A | yes | `E2A0_1A_AmbiglowColors_E` (smethod_3) | DataOSD.cs:282 | (00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D) |  |
| 41 | `ModuleAmbiglow.EXT_OP_E2A0_1B_AmbiglowLightPosition` | 0xE2A01B | yes | `E2A0_1B_AmbiglowLightPosition_E` (smethod_3) | DataOSD.cs:285 | (00 01 02 03) |  |
| 42 | `ModuleAmbiglow.EXT_OP_E2A0_1C_AmbiglowLightBrightness` | 0xE2A01C | yes | `E2A0_1C_AmbiglowLightBrightness_E` (smethod_3) | DataOSD.cs:288 | (00 01 02) |  |
| 43 | `ModuleAmbiglow.EXT_OP_E2A0_1D_AmbiglowLightSpeed` | 0xE2A01D | yes | `E2A0_1D_AmbiglowLightSpeed_E` (smethod_3) | DataOSD.cs:291 | (00 01 02) |  |
| 44 | `ModuleAmbiglow.EXT_OP_E2A0_1E_AmbiglowLightDirection` | 0xE2A01E | yes | `E2A0_1E_AmbiglowLightDirection_E` (smethod_3) | DataOSD.cs:294 | – |  |
| 45 | `ModuleInput.OP_ED_InputAuto` | 0xED | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:235 | (00 01) | `SwitchFlag_E` (shared with 0xF0, DataOSD.cs:235-237). |
| 46 | `ModuleInput.OP_60_InputSource` | 0x60 | yes | `VCP_60_InputSource` (smethod_3) | DataOSD.cs:162 | (11 12 0F 15 21 22 2F 35) | Combined enum `VCP_60_InputSource` (Normal_* + PIPPBP_*). Then `InputSourceList` = ValueList ∩ `VCP_60_InputSource_E`, `PIPPBPSourceList` = ValueList ∩ `VCP_60_PIPPBPSource_E` (CDevice_PHLDisplay.cs:393-396; LINQ Intersect keeps the first list's objects and order, so names/texts come from `VCP_60_InputSource`). Raw value split: byte0 → `InputSourceInfo.InputSource`, byte1 → `PIPPBPSource`, default 34 then 47 when byte1 = 0 (397-412). |
| 47 | `ModuleInput.OP_A5_WindowSelect` | 0xA5 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) | No smethod case. If A5 is available and `PIPPBPEnable` finds a table, ValueList is REPLACED by `VCP_A5_PIPPBPType_<F7>_E` chosen by `F7.ValueList[0]` (CDevice_PHLDisplay.cs:413-416, DataOSD.cs:406-431); Mode = A5 value. |
| 48 | `ModuleInput.OP_EC_PIPPBPSizeLocation` | 0xEC | yes | `VCP_EC_PIP_Size` (smethod_3) | DataOSD.cs:232 | (01 02 03) | `VCP_EC_PIP_Size` ∩ caps (sizes only). Raw value split byte0 → `Size`, byte1 → `Location` (CDevice_PHLDisplay.cs:417-419). Location choices come from the get-only `PIPLocationList` = full `GetDatas(VCP_EC_PIP_Location)` (not caps-filtered). |
| 49 | `ModuleInput.OP_F6_PIPPBPSwap` | 0xF6 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (01) | The caps sub-list `(01)` is ignored (no case), so ValueList is null; `PHL_SwrapPIPPBP` writes 1. |
| 50 | `ModuleAudio.OP_62_AudioSpeakerVolume` | 0x62 | yes | — (no case) | DataOSD.cs:158-243 (no case) | (none) |  |
| 51 | `ModuleAudio.OP_8D_AudioMute` | 0x8D | yes | `VCP_8D_AudioMute` (smethod_3) | DataOSD.cs:180 | (01 02) | ON=1, OFF=2 (`Qu` On=1/Off=2). |
| 52 | `ModuleAudio.EXT_OP_E2A0_00_AudioMode` | 0xE2A000 | yes | `E2A0_00_AudioMode_E` (smethod_3) | DataOSD.cs:252 | (46 47 48 49 4A 4B) |  |
| 53 | `ModuleAudio.OP_E0_AudioSource` | 0xE0 | yes | `VCP_E0_AudioSourceSelect` (smethod_3) | DataOSD.cs:192 | (01 02 03 05) |  |
| 54 | `ModuleSystem.EXT_OP_E2A0_3A_HDMI1RefreshRate` | 0xE2A03A | yes | `E2A0_HDMIRefreshRate_E` (smethod_3) | DataOSD.cs:326 | – |  |
| 55 | `ModuleSystem.EXT_OP_E2A0_3B_HDMI2RefreshRate` | 0xE2A03B | yes | `E2A0_HDMIRefreshRate_E` (smethod_3) | DataOSD.cs:327 | – |  |
| 56 | `ModuleSystem.EXT_OP_E2A0_3C_HDMI3RefreshRate` | 0xE2A03C | yes | `E2A0_HDMIRefreshRate_E` (smethod_3) | DataOSD.cs:328 | – |  |
| 57 | `ModuleSystem.EXT_OP_E2A0_0E_OSDSettingHorizontal` | 0xE2A00E | yes | — (no case) | DataOSD.cs:245-382 (no case) | (none) |  |
| 58 | `ModuleSystem.EXT_OP_E2A0_0F_OSDSettingVertical` | 0xE2A00F | yes | — (no case) | DataOSD.cs:245-382 (no case) | (none) |  |
| 59 | `ModuleSystem.EXT_OP_E2A0_10_OSDSettingTransparency` | 0xE2A010 | yes | `Num_Off_E` (smethod_3) | DataOSD.cs:334 | (00 01 02 03 04) | `Num_Off_E` (shared with E2A048/49/4A, DataOSD.cs:334-338). |
| 60 | `ModuleSystem.EXT_OP_E2A0_11_OSDSettingTimeOut` | 0xE2A011 | yes | `E2A0_11_OSDSettingTimeOut_E` (smethod_3) | DataOSD.cs:264 | (00 01 02 03 04) |  |
| 61 | `ModuleSystem.OP_86_DisplayScaling` | 0x86 | yes | `VCP_86_DisplayScaling` (smethod_3) | DataOSD.cs:171 | (01 0A 12 13 14 15 16 17 18 19 1A 1B 23) | `Scaling_SupportSmartSize` (10) is Unbind → dropped even when caps contain 0x0A. |
| 62 | `ModuleSystem.EXT_OP_E2A0_12_USB_C_Setting` | 0xE2A012 | yes | `E2A0_12_USB_C_Setting_E` (smethod_3) | DataOSD.cs:267 | (00 01) |  |
| 63 | `ModuleSystem.EXT_OP_E2A0_13_USB_StandbyMode` | 0xE2A013 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:346 | (00 01) |  |
| 64 | `ModuleSystem.EXT_OP_E2A0_14_USB_Upstream` | 0xE2A014 | yes | `E2A0_14_USB_Upstream_E` (smethod_3) | DataOSD.cs:270 | – |  |
| 65 | `ModuleSystem.EXT_OP_E2A0_15_KVM` | 0xE2A015 | yes | `E2A0_15_KVM_E` (smethod_3) | DataOSD.cs:273 | (00 01 02) |  |
| 66 | `ModuleSystem.EXT_OP_E2A0_16_SmartPower` | 0xE2A016 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:347 | (00 01) |  |
| 67 | `ModuleSystem.EXT_OP_E2A0_18_LocalDimming` | 0xE2A018 | yes | `E2A0_18_LocalDimming_E` (smethod_3) | DataOSD.cs:276 | – |  |
| 68 | `ModuleSystem.OP_54_PerformancePreservation` | 0x54 | yes | `VCP_54_PixelOrbiting` (smethod_3) | DataOSD.cs:165 | (00 01) | `VCP_54_PixelOrbiting` has ON=0, OFF=1 (inverted vs. SwitchFlag_E); `Qu` therefore gives On=0/Off=1. |
| 69 | `ModuleSystem.OP_DA_ScanMode` | 0xDA | yes | `VCP_DA_ScanMode` (smethod_3) | DataOSD.cs:183 | (00 02) | OFF=0 ("Normal operation"), ON=2 ("Overscan"). |
| 70 | `ModuleSystem.EXT_OP_E2A0_6B_Profile` | 0xE2A06B | yes | `E2A0_6B_Profile_E` (smethod_4, caps order) | DataOSD.cs:378 | – | smethod_4: capability order kept (DataOSD.cs:378-379). |
| 71 | `ModuleSetup.OP_F2_PowerLED` | 0xF2 | yes | `VCP_F2_PowerLED` (smethod_3) | DataOSD.cs:239 | (00 01 02 03 04) | Renderer shows the numeric value instead of `Name` (Setup-D-5j4V-I.js:325-326). |
| 72 | `ModuleSetup.OP_CC_OSDLanguage` | 0xCC | yes | `VCP_CC_OSDLanguage` (smethod_3) | DataOSD.cs:189 | (01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 12 14 16 17 1A 1E 24) | Renderer shows `Text` (native language name) instead of `Name` (Setup-D-5j4V-I.js:327-328). |
| 73 | `ModuleSetup.OP_E9_ResolutionNotifier` | 0xE9 | yes | `VCP_E9_ResolutionNotifier` (smethod_3) | DataOSD.cs:226 | (00 02) | OFF=0, ON=2 (`Qu` On=2/Off=0). |
| 74 | `ModuleSetup.EXT_OP_E2A0_17_CEC` | 0xE2A017 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:348 | (00 01) |  |
| 75 | `ModuleSetup.EXT_OP_E2A0_35_ScreenSaver` | 0xE2A035 | yes | `E2A0_35_ScreenSaver_E` (smethod_3) | DataOSD.cs:323 | (00 02 03) |  |
| 76 | `ModuleSetup.EXT_OP_E2A0_34_PixelOrbiting` | 0xE2A034 | yes | `E2A0_34_PixelOrbiting_E` (smethod_3) | DataOSD.cs:320 | (00 02 03 04) |  |
| 77 | `ModuleSetup.EXT_OP_E2A0_36_PixelRefresh` | 0xE2A036 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:361 | (00 01) |  |
| 78 | `ModuleSetup.EXT_OP_E2A0_37_PanelRefresh` | 0xE2A037 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:362 | – |  |
| 79 | `ModuleSetup.EXT_OP_E2A0_43_AutoWarning` | 0xE2A043 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:364 | (00 01) |  |
| 80 | `ModuleSetup.EXT_OP_E2A0_47_UniBright` | 0xE2A047 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:366 | – |  |
| 81 | `ModuleSetup.EXT_OP_E2A0_48_MultiLogoProtection` | 0xE2A048 | yes | `Num_Off_E` (smethod_3) | DataOSD.cs:335 | – |  |
| 82 | `ModuleSetup.EXT_OP_E2A0_49_BoundaryDimmer` | 0xE2A049 | yes | `Num_Off_E` (smethod_3) | DataOSD.cs:336 | – |  |
| 83 | `ModuleSetup.EXT_OP_E2A0_4A_TaskbarDimmer` | 0xE2A04A | yes | `Num_Off_E` (smethod_3) | DataOSD.cs:337 | – |  |
| 84 | `ModuleSetup.EXT_OP_E2A0_4B_ThermalProtection` | 0xE2A04B | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:367 | – |  |
| 85 | `ModuleSetup.EXT_OP_E2A0_61_AutoPixelRefresh` | 0xE2A061 | yes | `SwitchFlag_E` (smethod_3) | DataOSD.cs:369 | – |  |
| 86 | `ModuleSetup.EXT_OP_E2A0_54_PixelRefreshCounts` | 0xE2A054 | yes | — (no case) | DataOSD.cs:245-382 (no case) | – |  |
| 87 | `ModuleSetup.EXT_OP_E2A0_55_PanelRefreshCounts` | 0xE2A055 | yes | — (no case) | DataOSD.cs:245-382 (no case) | – |  |
| 88 | `ModuleSetup.EXT_OP_E2A0_41_FanControl` | 0xE2A041 | yes | `E2A0_41_FanControl_E` (smethod_3) | DataOSD.cs:331 | (00 01 02) |  |

**Non-`AttributeInfo` list members (CONFIRMED):**

| JSON path | Built by | Source |
|---|---|---|
| `ModuleSmartImage.Items` (public field) | `DC.ValueList − GetDatas(SmartImageHDR_E)` when **not** HDR; else stays `[]` | `PHL/…:347` |
| `ModuleSmartImageHDR.Items` (public field) | `DC.ValueList ∩ GetDatas(SmartImageHDR_E)` when HDR; else stays `[]` | `PHL/…:338` |
| `ModuleInput.InputSourceList` | `OP_60.ValueList ∩ GetDatas(VCP_60_InputSource_E)` | `PHL/…:393-394` |
| `ModuleInput.PIPPBPSourceList` | `OP_60.ValueList ∩ GetDatas(VCP_60_PIPPBPSource_E)` | `PHL/…:395-396` |
| `ModuleInput.PIPLocationList` (get-only) | `GetDatas(VCP_EC_PIP_Location)` (no caps filter) | `OPT/DisplayModuleInput.cs:146` |
| `ModuleInput.InputSourceInfo` (5 public fields) | 0x60 byte split, PIP default 34 then 47; A5, and the EC split only when PIP/PBP is enabled | `PHL/…:397-420` |
| `ModuleAudio.EQItems` | one `{Name,Index,Value,MaxValue}` per **global** `E2A001.ValueList` item, gain from E2A039 | `PHL/…:421-440` |
| `ModuleSetup.WorkingTime` / `TimeAfterPixelRefresh` | `(E2A04D<<16)\|E2A04E` / `(E2A050<<16)\|E2A051`, else -1 | `PHL/…:518-557` |
| `HasUSBSetting` (IgnoreProfile) | E2A012 ∨ E2A014 ∨ E2A015 available in the global list | `PHL/…:491-516` |

---

## 4. (c) Computed ValueLists for the user's 34M2C8600

### 4.1 Inputs

- **Capabilities.** `CAPS` (CONFIRMED; identical to the `LOG26:542-627` parse dump). Global `F7.ValueList = `[{"Name":"PIP_2_PBP_2","Text":"PIP_2_PBP_2","Value":66}]``, so `PIPPBPEnable` is true with the `VCP_A5_PIPPBPType_42_E` table.
- **Values and maxima.** From the `PHL_ReloadData` read at `LOG26:1096-1176` (08:02:52–08:03:03, hex).
  - They are identical to the 07:52 connect read (`LOG26:913-993`), except `E2A043` (0 → 1 after the user's `PHL_SetOSD` at `LOG26:1087-1088`).
  - They equal the `Value`s stored in `PROF` (08:24).
- **State.** `IsSmartImageHDR = true`, `ENEEffectEnable = false` (PROF, CONFIRMED).

### 4.2 Per-attribute result

`MinValue` is 0 and `StepValue` is 1 for **every** attribute. A grep of all `work/dotnet-clean` for `MinValue =`/`StepValue =` finds no `AttributeInfo` assignment (CONFIRMED). `MaxValue` is 0 for unavailable and unread attributes.

| JSON path | err_code | Value | MinValue | MaxValue | StepValue | ValueList (Name, in order) | Value source |
|---|---|---|---|---|---|---|---|
| `OP_DC_DisplayApplication` | 0 | 33 | 0 | 53 | 1 | [SmartImage_Standard 0, SmartImage_FPS 1, SmartImage_Movie 3, SmartImage_Game1 4, SmartImage_Game2 5, SmartImage_Racing 6, SmartImage_RTS 7, SmartImage_Economy 8, SmartImage_LowBlueMode 11, SmartImage_EasyRead 14, SmartImage_ConsoleMode 17, SmartImage_IllustratorMode 81, HDROff 32, HDRGame 33, HDRMovie 34, HDRPhoto 35, HDRPersonal 36, HDRTrueBlack 48, HDRPeak 51] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSmartImage.CurSubSmartImage.OP_10_Luminance` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_12_Contrast` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_F0_SmartContrast` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_72_Gamma` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_87_Sharpness` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.EXT_OP_E2A0_20_ColorSpace` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_14_SelectColorPreset` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_16_VideoGainDriveRed` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_18_VideoGainDriveGreen` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_1A_VideoGainDriveBlue` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_8A_Saturation` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.OP_90_Hue` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImage.CurSubSmartImage.EXT_OP_E2A0_24_DLBL` | 0 | null | 0 | 0 | 1 | null | unread (SDR sub-module not polled in HDR; PROF has no Value) |
| `ModuleSmartImageHDR.CurSubSmartImage.OP_10_Luminance` | 0 | 100 | 0 | 100 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSmartImageHDR.CurSubSmartImage.OP_12_Contrast` | 0 | 50 | 0 | 100 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSmartImageHDR.CurSubSmartImage.EXT_OP_E2A0_3D_LightEnhancement` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSmartImageHDR.CurSubSmartImage.EXT_OP_E2A0_3E_ColorEnhancement` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSmartImageHDR.CurSubSmartImage.EXT_OP_E2A0_3F_DarkEnhancement` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync` | 0 | 1 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_02_MBR` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleGameMode.EXT_OP_E2A0_03_MBRSync` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleGameMode.EXT_OP_E2A0_04_SmartCrosshair` | 0 | 0 | 0 | 2 | 1 | [OFF 0, ON 1, SmartCrosshairOn 2] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_44_StarkShadowBoost` | 0 | 0 | 0 | 3 | 1 | [OFF 0, Level1 1, Level2 2, Level3 3] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_45_ShadowBoost` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleGameMode.EXT_OP_E2A0_06_SharpShooter_Size` | 0 | 0 | 0 | 3 | 1 | [OFF 0, Num_1_0 1, Num_1_5 2, Num_2_0 3] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_25_SharpShooter_Location` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleGameMode.EXT_OP_E2A0_07_LowInputLag` | 0 | 0 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.OP_EB_SmartResponse` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleGameMode.EXT_OP_E2A0_4C_Overclock` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleGameMode.EXT_OP_E2A0_08_SmartFrame` | 0 | 0 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_09_SmartFrameSize` | 0 | 1 | 0 | 7 | 1 | [Num_1 1, Num_2 2, Num_3 3, Num_4 4, Num_5 5, Num_6 6, Num_7 7] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_0A_SmartFrameBrightness` | 0 | 100 | 0 | 100 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_0B_SmartFrameContrast` | 0 | 50 | 0 | 100 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_0C_SmartFrameHPosition` | 0 | 0 | 0 | 5 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_0D_SmartFrameVPosition` | 0 | 0 | 0 | 0 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleGameMode.EXT_OP_E2A0_59_DualResolution` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleGameMode.EXT_OP_E2A0_68_AutoRefineAIStatus` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode` | 0 | 7 | 0 | 7 | 1 | [FollowVideo 1, FollowAudio 2, ColorShift 3, ColorWave 4, ColorBreathing 5, StarryNight 6, StaticMode 7] | read 0 (LOG26:1125) → rewritten to 7 (CDevice_PHLDisplay.cs:388); PROF 7 |
| `ModuleAmbiglow.EXT_OP_E2A0_1A_AmbiglowColors` | 0 | 6 | 0 | 13 | 1 | [Rainbow 0, White 1, Red 2, Rose 3, Magenta 4, Violet 5, Blue 6, Azure 7, Cyan 8, Aqua 9, Green 10, Pear 11, Yellow 12, Orange 13] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleAmbiglow.EXT_OP_E2A0_1B_AmbiglowLightPosition` | 0 | 0 | 0 | 3 | 1 | [AllZones 0, FourSided 1, Central 2, Bottom 3] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleAmbiglow.EXT_OP_E2A0_1C_AmbiglowLightBrightness` | 0 | 2 | 0 | 2 | 1 | [Bright 0, Brighter 1, Brightest 2] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleAmbiglow.EXT_OP_E2A0_1D_AmbiglowLightSpeed` | 0 | 0 | 0 | 2 | 1 | [Low 0, Normal 1, High 2] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleAmbiglow.EXT_OP_E2A0_1E_AmbiglowLightDirection` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleInput.OP_ED_InputAuto` | 0 | 1 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleInput.OP_60_InputSource` | 0 | 15 | 0 | 13846 | 1 | [Normal_DisplayPort1 15, Normal_DigitalHDMI1 17, Normal_DigitalHDMI2 18, Normal_USBC1 21, PIPPBP_DigitalHDMI1 33, PIPPBP_DigitalHDMI2 34, PIPPBP_DisplayPort1 47, PIPPBP_USBC1 53] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleInput.OP_A5_WindowSelect` | 0 | 0 | 0 | 512 | 1 | [PIPPBP__OFF 0, PIPPBP__PIP 256, PIPPBP__PBP_1 512] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleInput.OP_EC_PIPPBPSizeLocation` | 0 | 0 | 0 | 0 | 1 | [Small 1, Middle 2, Large 3] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleInput.OP_F6_PIPPBPSwap` | 0 | 0 | 0 | 0 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleAudio.OP_62_AudioSpeakerVolume` | 0 | 0 | 0 | 100 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleAudio.OP_8D_AudioMute` | 0 | 2 | 0 | 2 | 1 | [ON 1, OFF 2] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleAudio.EXT_OP_E2A0_00_AudioMode` | 0 | 70 | 0 | 75 | 1 | [OFF 70, SportsRacing 71, RPGAdventure 72, ShootingAction 73, MovieWatching 74, Music 75] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleAudio.OP_E0_AudioSource` | 0 | 3 | 0 | 8 | 1 | [AudioSource_HDMI1 1, AudioSource_HDMI2 2, AudioSource_DisplayPort1 3, AudioSource_USBC1 5] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_3A_HDMI1RefreshRate` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSystem.EXT_OP_E2A0_3B_HDMI2RefreshRate` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSystem.EXT_OP_E2A0_3C_HDMI3RefreshRate` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSystem.EXT_OP_E2A0_0E_OSDSettingHorizontal` | 0 | 50 | 0 | 100 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_0F_OSDSettingVertical` | 0 | 50 | 0 | 100 | 1 | null | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_10_OSDSettingTransparency` | 0 | 0 | 0 | 4 | 1 | [OFF 0, Num_1 1, Num_2 2, Num_3 3, Num_4 4] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_11_OSDSettingTimeOut` | 0 | 2 | 0 | 4 | 1 | [Time_5 0, Time_10 1, Time_20 2, Time_30 3, Time_60 4] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.OP_86_DisplayScaling` | 0 | 2 | 0 | 35 | 1 | [Scaling_NoScaling 1, Scaling_19 18, Scaling_19_W 19, Scaling_22_W 20, Scaling_18_5_W 21, Scaling_19_5_W 22, Scaling_20_W 23, Scaling_21_5_W 24, Scaling_23_W 25, Scaling_24_W 26, Scaling_27_W 27, Scaling_Aspect_4to3 35] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_12_USB_C_Setting` | 0 | 1 | 0 | 1 | 1 | [USB_2_0 0, USB_3_2 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_13_USB_StandbyMode` | 0 | 1 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_14_USB_Upstream` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSystem.EXT_OP_E2A0_15_KVM` | 0 | 0 | 0 | 2 | 1 | [KVM_Status_Auto 0, KVM_Status_USB_C 1, KVM_Status_USB_Up 2] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_16_SmartPower` | 0 | 0 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_18_LocalDimming` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSystem.OP_54_PerformancePreservation` | 0 | 2 | 0 | 4 | 1 | [ON 0, OFF 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.OP_DA_ScanMode` | 0 | 2 | 0 | 8 | 1 | [OFF 0, ON 2] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSystem.EXT_OP_E2A0_6B_Profile` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.OP_F2_PowerLED` | 0 | 1 | 0 | 4 | 1 | [POWER_LED_STEP0 0, POWER_LED_STEP1 1, POWER_LED_STEP2 2, POWER_LED_STEP3 3, POWER_LED_STEP4 4] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSetup.OP_CC_OSDLanguage` | 0 | 2 | 0 | 36 | 1 | [Chinese_tw 1, English 2, French 3, German 4, Italian 5, Japanese 6, Korean 7, Portuguese_Portugal 8, Russian 9, Spanish 10, Swedish 11, Turkish 12, Chinese_cn 13, Portuguese_Brazil 14, Czech 18, Dutch 20, Finnish 22, Greek 23, Hungarian 26, Polish 30, Ukrainian 36] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSetup.OP_E9_ResolutionNotifier` | 0 | 0 | 0 | 2 | 1 | [OFF 0, ON 2] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSetup.EXT_OP_E2A0_17_CEC` | 0 | 0 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSetup.EXT_OP_E2A0_35_ScreenSaver` | 0 | 2 | 0 | 3 | 1 | [OFF 0, Slow 2, Fast 3] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSetup.EXT_OP_E2A0_34_PixelOrbiting` | 0 | 3 | 0 | 4 | 1 | [OFF 0, Slow 2, Normal 3, Fast 4] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSetup.EXT_OP_E2A0_36_PixelRefresh` | 0 | 0 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSetup.EXT_OP_E2A0_37_PanelRefresh` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_43_AutoWarning` | 0 | 1 | 0 | 1 | 1 | [OFF 0, ON 1] | LOG26 reload 08:02:52-08:03:03 = PROF |
| `ModuleSetup.EXT_OP_E2A0_47_UniBright` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_48_MultiLogoProtection` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_49_BoundaryDimmer` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_4A_TaskbarDimmer` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_4B_ThermalProtection` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_61_AutoPixelRefresh` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_54_PixelRefreshCounts` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_55_PanelRefreshCounts` | 9 | null | 0 | 0 | 1 | null | n/a (not in caps; PROF err_code 9) |
| `ModuleSetup.EXT_OP_E2A0_41_FanControl` | 0 | 1 | 0 | 2 | 1 | [OFF 0, Auto 1, Quiet 2] | LOG26 reload 08:02:52-08:03:03 = PROF |

### 4.3 Exact ValueList JSON (global lists copied into the module attributes; UI form)

Compact wire form: `"ValueList":[{"Name":…,"Text":…,"Value":…},…]` in exactly this order.

```json
{
  "OP_DC_DisplayApplication": [
    {"Name":"SmartImage_Standard","Text":"Standard","Value":0},
    {"Name":"SmartImage_FPS","Text":"FPS","Value":1},
    {"Name":"SmartImage_Movie","Text":"Movie","Value":3},
    {"Name":"SmartImage_Game1","Text":"Game1","Value":4},
    {"Name":"SmartImage_Game2","Text":"Game2","Value":5},
    {"Name":"SmartImage_Racing","Text":"Racing","Value":6},
    {"Name":"SmartImage_RTS","Text":"RTS","Value":7},
    {"Name":"SmartImage_Economy","Text":"Economy","Value":8},
    {"Name":"SmartImage_LowBlueMode","Text":"LowBlueMode","Value":11},
    {"Name":"SmartImage_EasyRead","Text":"EasyRead","Value":14},
    {"Name":"SmartImage_ConsoleMode","Text":"ConsoleMode","Value":17},
    {"Name":"SmartImage_IllustratorMode","Text":"Illustrator Mode","Value":81},
    {"Name":"HDROff","Text":"HDR Off","Value":32},
    {"Name":"HDRGame","Text":"HDR Game","Value":33},
    {"Name":"HDRMovie","Text":"HDR Movie","Value":34},
    {"Name":"HDRPhoto","Text":"HDR Photo","Value":35},
    {"Name":"HDRPersonal","Text":"HDR Personal","Value":36},
    {"Name":"HDRTrueBlack","Text":"HDR True Black","Value":48},
    {"Name":"HDRPeak","Text":"HDR Peak","Value":51}
  ],
  "ModuleGameMode.EXT_OP_E2A0_40_AdaptiveSync": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleGameMode.EXT_OP_E2A0_04_SmartCrosshair": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1},{"Name":"SmartCrosshairOn","Text":"Smart Crosshair On","Value":2}],
  "ModuleGameMode.EXT_OP_E2A0_44_StarkShadowBoost": [
    {"Name":"OFF","Text":"Off","Value":0},
    {"Name":"Level1","Text":"Level 1","Value":1},
    {"Name":"Level2","Text":"Level 2","Value":2},
    {"Name":"Level3","Text":"Level 3","Value":3}
  ],
  "ModuleGameMode.EXT_OP_E2A0_06_SharpShooter_Size": [
    {"Name":"OFF","Text":"Off","Value":0},
    {"Name":"Num_1_0","Text":"1","Value":1},
    {"Name":"Num_1_5","Text":"1.5","Value":2},
    {"Name":"Num_2_0","Text":"2.0","Value":3}
  ],
  "ModuleGameMode.EXT_OP_E2A0_07_LowInputLag": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleGameMode.EXT_OP_E2A0_08_SmartFrame": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleGameMode.EXT_OP_E2A0_09_SmartFrameSize": [
    {"Name":"Num_1","Text":"1","Value":1},
    {"Name":"Num_2","Text":"2","Value":2},
    {"Name":"Num_3","Text":"3","Value":3},
    {"Name":"Num_4","Text":"4","Value":4},
    {"Name":"Num_5","Text":"5","Value":5},
    {"Name":"Num_6","Text":"6","Value":6},
    {"Name":"Num_7","Text":"7","Value":7}
  ],
  "ModuleAmbiglow.EXT_OP_E2A0_19_AmbiglowLightMode": [
    {"Name":"FollowVideo","Text":"Follow Video","Value":1},
    {"Name":"FollowAudio","Text":"Follow Audio","Value":2},
    {"Name":"ColorShift","Text":"Color Shift","Value":3},
    {"Name":"ColorWave","Text":"Color Wave","Value":4},
    {"Name":"ColorBreathing","Text":"Color Breathing","Value":5},
    {"Name":"StarryNight","Text":"Starry Night","Value":6},
    {"Name":"StaticMode","Text":"Static Mode","Value":7}
  ],
  "ModuleAmbiglow.EXT_OP_E2A0_1A_AmbiglowColors": [
    {"Name":"Rainbow","Text":"Rainbow","Value":0},
    {"Name":"White","Text":"White","Value":1},
    {"Name":"Red","Text":"Red","Value":2},
    {"Name":"Rose","Text":"Rose","Value":3},
    {"Name":"Magenta","Text":"Magenta","Value":4},
    {"Name":"Violet","Text":"Violet","Value":5},
    {"Name":"Blue","Text":"Blue","Value":6},
    {"Name":"Azure","Text":"Azure","Value":7},
    {"Name":"Cyan","Text":"Cyan","Value":8},
    {"Name":"Aqua","Text":"Aqua","Value":9},
    {"Name":"Green","Text":"Green","Value":10},
    {"Name":"Pear","Text":"Pear","Value":11},
    {"Name":"Yellow","Text":"Yellow","Value":12},
    {"Name":"Orange","Text":"Orange","Value":13}
  ],
  "ModuleAmbiglow.EXT_OP_E2A0_1B_AmbiglowLightPosition": [
    {"Name":"AllZones","Text":"All Zones","Value":0},
    {"Name":"FourSided","Text":"4-sided","Value":1},
    {"Name":"Central","Text":"Central","Value":2},
    {"Name":"Bottom","Text":"Bottom","Value":3}
  ],
  "ModuleAmbiglow.EXT_OP_E2A0_1C_AmbiglowLightBrightness": [{"Name":"Bright","Text":"Bright","Value":0},{"Name":"Brighter","Text":"Brighter","Value":1},{"Name":"Brightest","Text":"Brightest","Value":2}],
  "ModuleAmbiglow.EXT_OP_E2A0_1D_AmbiglowLightSpeed": [{"Name":"Low","Text":"Low","Value":0},{"Name":"Normal","Text":"Normal","Value":1},{"Name":"High","Text":"High","Value":2}],
  "ModuleInput.OP_ED_InputAuto": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleInput.OP_60_InputSource": [
    {"Name":"Normal_DisplayPort1","Text":"DisplayPort 1","Value":15},
    {"Name":"Normal_DigitalHDMI1","Text":"Digital HDMI 1","Value":17},
    {"Name":"Normal_DigitalHDMI2","Text":"Digital HDMI 2","Value":18},
    {"Name":"Normal_USBC1","Text":"USB C1","Value":21},
    {"Name":"PIPPBP_DigitalHDMI1","Text":"Digital HDMI 1","Value":33},
    {"Name":"PIPPBP_DigitalHDMI2","Text":"Digital HDMI 2","Value":34},
    {"Name":"PIPPBP_DisplayPort1","Text":"DisplayPort 1","Value":47},
    {"Name":"PIPPBP_USBC1","Text":"USB C1","Value":53}
  ],
  "ModuleInput.OP_A5_WindowSelect": [
    {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0},
    {"Name":"PIPPBP__PIP","Text":"PIPPBP__PIP","Value":256},
    {"Name":"PIPPBP__PBP_1","Text":"PIPPBP__PBP_1","Value":512}
  ],
  "ModuleInput.OP_EC_PIPPBPSizeLocation": [{"Name":"Small","Text":"Small","Value":1},{"Name":"Middle","Text":"Middle","Value":2},{"Name":"Large","Text":"Large","Value":3}],
  "ModuleAudio.OP_8D_AudioMute": [{"Name":"ON","Text":"On","Value":1},{"Name":"OFF","Text":"Off","Value":2}],
  "ModuleAudio.EXT_OP_E2A0_00_AudioMode": [
    {"Name":"OFF","Text":"Off","Value":70},
    {"Name":"SportsRacing","Text":"Sports & Racing","Value":71},
    {"Name":"RPGAdventure","Text":"RPG & Adventure","Value":72},
    {"Name":"ShootingAction","Text":"Shooting & Action","Value":73},
    {"Name":"MovieWatching","Text":"Movie Watching","Value":74},
    {"Name":"Music","Text":"Music","Value":75}
  ],
  "ModuleAudio.OP_E0_AudioSource": [
    {"Name":"AudioSource_HDMI1","Text":"HDMI1","Value":1},
    {"Name":"AudioSource_HDMI2","Text":"HDMI2","Value":2},
    {"Name":"AudioSource_DisplayPort1","Text":"Display Port 1","Value":3},
    {"Name":"AudioSource_USBC1","Text":"USB C1","Value":5}
  ],
  "ModuleSystem.EXT_OP_E2A0_10_OSDSettingTransparency": [
    {"Name":"OFF","Text":"Off","Value":0},
    {"Name":"Num_1","Text":"1","Value":1},
    {"Name":"Num_2","Text":"2","Value":2},
    {"Name":"Num_3","Text":"3","Value":3},
    {"Name":"Num_4","Text":"4","Value":4}
  ],
  "ModuleSystem.EXT_OP_E2A0_11_OSDSettingTimeOut": [
    {"Name":"Time_5","Text":"5 s","Value":0},
    {"Name":"Time_10","Text":"10 s","Value":1},
    {"Name":"Time_20","Text":"20 s","Value":2},
    {"Name":"Time_30","Text":"30 s","Value":3},
    {"Name":"Time_60","Text":"60 s","Value":4}
  ],
  "ModuleSystem.OP_86_DisplayScaling": [
    {"Name":"Scaling_NoScaling","Text":"No Scaling (1:1)","Value":1},
    {"Name":"Scaling_19","Text":"19\"","Value":18},
    {"Name":"Scaling_19_W","Text":"19\"W","Value":19},
    {"Name":"Scaling_22_W","Text":"22\"W","Value":20},
    {"Name":"Scaling_18_5_W","Text":"18.5\"W","Value":21},
    {"Name":"Scaling_19_5_W","Text":"19.5\"W","Value":22},
    {"Name":"Scaling_20_W","Text":"20\"W","Value":23},
    {"Name":"Scaling_21_5_W","Text":"21.5\"W","Value":24},
    {"Name":"Scaling_23_W","Text":"23\"W","Value":25},
    {"Name":"Scaling_24_W","Text":"24\"W","Value":26},
    {"Name":"Scaling_27_W","Text":"27\"W","Value":27},
    {"Name":"Scaling_Aspect_4to3","Text":"4:3(Aspect)","Value":35}
  ],
  "ModuleSystem.EXT_OP_E2A0_12_USB_C_Setting": [{"Name":"USB_2_0","Text":"USB2.0(High Resolution)","Value":0},{"Name":"USB_3_2","Text":"USB3.2(High Data Speed)","Value":1}],
  "ModuleSystem.EXT_OP_E2A0_13_USB_StandbyMode": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleSystem.EXT_OP_E2A0_15_KVM": [
    {"Name":"KVM_Status_Auto","Text":"Auto","Value":0},
    {"Name":"KVM_Status_USB_C","Text":"Usb C","Value":1},
    {"Name":"KVM_Status_USB_Up","Text":"Usb Up","Value":2}
  ],
  "ModuleSystem.EXT_OP_E2A0_16_SmartPower": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleSystem.OP_54_PerformancePreservation": [{"Name":"ON","Text":"On","Value":0},{"Name":"OFF","Text":"Off","Value":1}],
  "ModuleSystem.OP_DA_ScanMode": [{"Name":"OFF","Text":"Normal operation","Value":0},{"Name":"ON","Text":"Overscan","Value":2}],
  "ModuleSetup.OP_F2_PowerLED": [
    {"Name":"POWER_LED_STEP0","Text":"等级0","Value":0},
    {"Name":"POWER_LED_STEP1","Text":"等级1","Value":1},
    {"Name":"POWER_LED_STEP2","Text":"等级2","Value":2},
    {"Name":"POWER_LED_STEP3","Text":"等级3","Value":3},
    {"Name":"POWER_LED_STEP4","Text":"等级4","Value":4}
  ],
  "ModuleSetup.OP_CC_OSDLanguage": [
    {"Name":"Chinese_tw","Text":"繁体中文","Value":1},
    {"Name":"English","Text":"English","Value":2},
    {"Name":"French","Text":"Français","Value":3},
    {"Name":"German","Text":"Deutsch","Value":4},
    {"Name":"Italian","Text":"Italiano","Value":5},
    {"Name":"Japanese","Text":"日本語","Value":6},
    {"Name":"Korean","Text":"한국어","Value":7},
    {"Name":"Portuguese_Portugal","Text":"Português","Value":8},
    {"Name":"Russian","Text":"Русский","Value":9},
    {"Name":"Spanish","Text":"Español","Value":10},
    {"Name":"Swedish","Text":"Svenska","Value":11},
    {"Name":"Turkish","Text":"Türkçe","Value":12},
    {"Name":"Chinese_cn","Text":"简体中文","Value":13},
    {"Name":"Portuguese_Brazil","Text":"Português do Brasil","Value":14},
    {"Name":"Czech","Text":"Česky","Value":18},
    {"Name":"Dutch","Text":"Nederlands","Value":20},
    {"Name":"Finnish","Text":"Suomi","Value":22},
    {"Name":"Greek","Text":"Ελληνικά","Value":23},
    {"Name":"Hungarian","Text":"Magyar","Value":26},
    {"Name":"Polish","Text":"Polski","Value":30},
    {"Name":"Ukrainian","Text":"Українська","Value":36}
  ],
  "ModuleSetup.OP_E9_ResolutionNotifier": [{"Name":"OFF","Text":"ResolutionNotifierOff","Value":0},{"Name":"ON","Text":"ResolutionNotifierOn","Value":2}],
  "ModuleSetup.EXT_OP_E2A0_17_CEC": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleSetup.EXT_OP_E2A0_35_ScreenSaver": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"Slow","Text":"Slow","Value":2},{"Name":"Fast","Text":"Fast","Value":3}],
  "ModuleSetup.EXT_OP_E2A0_34_PixelOrbiting": [
    {"Name":"OFF","Text":"Off","Value":0},
    {"Name":"Slow","Text":"Slow","Value":2},
    {"Name":"Normal","Text":"Normal","Value":3},
    {"Name":"Fast","Text":"Fast","Value":4}
  ],
  "ModuleSetup.EXT_OP_E2A0_36_PixelRefresh": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleSetup.EXT_OP_E2A0_43_AutoWarning": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "ModuleSetup.EXT_OP_E2A0_41_FanControl": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"Auto","Text":"Auto","Value":1},{"Name":"Quiet","Text":"Quiet","Value":2}]
}
```

**Global lists that are not in the HDR-state Tag** (computed by the same rules; CONFIRMED rule lines in §3):
- The five `ModuleSmartImage.CurSubSmartImage` lists are copied into the Tag only when `IsSmartImageHDR` is false and the SDR sub-module is read (`PHL/…:350`).
- `OP_D6`, `E2A001` and `OP_F7` have no module property. `E2A001` drives `EQItems`, and `F7` selects the A5 table.

```json
{
  "OP_14_SelectColorPreset": [
    {"Name":"Preset_Native","Text":"Display Native","Value":2},
    {"Name":"Preset_5000K","Text":"5000K","Value":4},
    {"Name":"Preset_6500K","Text":"6500K","Value":5},
    {"Name":"Preset_7500K","Text":"7500K","Value":6},
    {"Name":"Preset_8200K","Text":"8200K","Value":7},
    {"Name":"Preset_9300K","Text":"9300K","Value":8},
    {"Name":"Preset_11500K","Text":"11500K","Value":10},
    {"Name":"Preset_UserRGB","Text":"User 1(User Define)","Value":11},
    {"Name":"Preset_USER3","Text":"User 3","Value":13}
  ],
  "OP_72_Gamma": [
    {"Name":"VCP_GAMMA_18","Text":"1.8","Value":80},
    {"Name":"VCP_GAMMA_20","Text":"2.0","Value":100},
    {"Name":"VCP_GAMMA_22","Text":"2.2","Value":120},
    {"Name":"VCP_GAMMA_24","Text":"2.4","Value":140},
    {"Name":"VCP_GAMMA_26","Text":"2.6","Value":160}
  ],
  "EXT_OP_E2A0_20_ColorSpace": [
    {"Name":"sRGB","Text":"sRGB","Value":2},
    {"Name":"AdboeRGB","Text":"Adboe RGB","Value":3},
    {"Name":"DCI_P3","Text":"DCI - P3","Value":4},
    {"Name":"Native","Text":"Native","Value":15}
  ],
  "EXT_OP_E2A0_24_DLBL": [
    {"Name":"OFF","Text":"Off","Value":0},
    {"Name":"Level1","Text":"Level 1","Value":1},
    {"Name":"Level2","Text":"Level 2","Value":2},
    {"Name":"Level3","Text":"Level 3","Value":3},
    {"Name":"Level4","Text":"Level 4","Value":4}
  ],
  "OP_F0_SmartContrast": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],
  "OP_D6_PowerMode": [{"Name":"ON","Text":"打开显示器","Value":1},{"Name":"OFF_WithRecovery","Text":"显示器待机状态","Value":4},{"Name":"OFF","Text":"关闭显示器","Value":5}],
  "EXT_OP_E2A0_01_AudioEQ": [
    {"Name":"EQ_100","Text":"100Hz","Value":0},
    {"Name":"EQ_300","Text":"300Hz","Value":1},
    {"Name":"EQ_1000","Text":"1kHz","Value":2},
    {"Name":"EQ_3000","Text":"3kHz","Value":3},
    {"Name":"EQ_10000","Text":"10kHz","Value":4}
  ],
  "OP_F7_PIPPBPType": [{"Name":"PIP_2_PBP_2","Text":"PIP_2_PBP_2","Value":66}]
}
```

### 4.4 Derived lists

**`ModuleSmartImage.Items`.**
- In the user's HDR state it is `[]`: CONFIRMED by PROF, and it is serialized as `[]`.
- If Windows HDR is off (`GetMonitorHDR().Item2 == false`), it becomes the SDR part of DC (INFERRED from `PHL/…:347`):

```json
[
  {"Name":"SmartImage_Standard","Text":"Standard","Value":0},
  {"Name":"SmartImage_FPS","Text":"FPS","Value":1},
  {"Name":"SmartImage_Movie","Text":"Movie","Value":3},
  {"Name":"SmartImage_Game1","Text":"Game1","Value":4},
  {"Name":"SmartImage_Game2","Text":"Game2","Value":5},
  {"Name":"SmartImage_Racing","Text":"Racing","Value":6},
  {"Name":"SmartImage_RTS","Text":"RTS","Value":7},
  {"Name":"SmartImage_Economy","Text":"Economy","Value":8},
  {
    "Name": "SmartImage_LowBlueMode",
    "Text": "LowBlueMode",
    "Value": 11
  },
  {
    "Name": "SmartImage_EasyRead",
    "Text": "EasyRead",
    "Value": 14
  },
  {
    "Name": "SmartImage_ConsoleMode",
    "Text": "ConsoleMode",
    "Value": 17
  },
  {
    "Name": "SmartImage_IllustratorMode",
    "Text": "Illustrator Mode",
    "Value": 81
  }
]
```

**`ModuleSmartImageHDR.Items`** in HDR state (CONFIRMED, equal to PROF). In SDR state it would be `[]`.

```json
[
  {"Name":"HDROff","Text":"HDR Off","Value":32},
  {"Name":"HDRGame","Text":"HDR Game","Value":33},
  {"Name":"HDRMovie","Text":"HDR Movie","Value":34},
  {"Name":"HDRPhoto","Text":"HDR Photo","Value":35},
  {"Name":"HDRPersonal","Text":"HDR Personal","Value":36},
  {"Name":"HDRTrueBlack","Text":"HDR True Black","Value":48},
  {"Name":"HDRPeak","Text":"HDR Peak","Value":51}
]
```

**`ModuleInput.InputSourceList`** (CONFIRMED = PROF):

```json
[
  {
    "Name": "Normal_DisplayPort1",
    "Text": "DisplayPort 1",
    "Value": 15
  },
  {
    "Name": "Normal_DigitalHDMI1",
    "Text": "Digital HDMI 1",
    "Value": 17
  },
  {
    "Name": "Normal_DigitalHDMI2",
    "Text": "Digital HDMI 2",
    "Value": 18
  },
  {"Name":"Normal_USBC1","Text":"USB C1","Value":21}
]
```

**`ModuleInput.PIPPBPSourceList`** (CONFIRMED = PROF):

```json
[
  {
    "Name": "PIPPBP_DigitalHDMI1",
    "Text": "Digital HDMI 1",
    "Value": 33
  },
  {
    "Name": "PIPPBP_DigitalHDMI2",
    "Text": "Digital HDMI 2",
    "Value": 34
  },
  {
    "Name": "PIPPBP_DisplayPort1",
    "Text": "DisplayPort 1",
    "Value": 47
  },
  {"Name":"PIPPBP_USBC1","Text":"USB C1","Value":53}
]
```

**`ModuleInput.PIPLocationList`** (CONFIRMED = PROF; `VCP_EC_PIP_Location` has no `[Description]`, so `Text` = `Name`):

```json
[
  {"Name":"UpperRight","Text":"UpperRight","Value":1},
  {"Name":"LowerRight","Text":"LowerRight","Value":2},
  {"Name":"UpperLeft","Text":"UpperLeft","Value":3},
  {"Name":"LowerLeft","Text":"LowerLeft","Value":4}
]
```

**`OP_A5_WindowSelect.ValueList`** (computed: F7 = 0x42 selects `VCP_A5_PIPPBPType_42_E`, which has no descriptions). The UI drops the `0` entry (`R/System-DT9nKs1q.js:349-352`).

```json
[
  {"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0},
  {"Name":"PIPPBP__PIP","Text":"PIPPBP__PIP","Value":256},
  {
    "Name": "PIPPBP__PBP_1",
    "Text": "PIPPBP__PBP_1",
    "Value": 512
  }
]
```

**`ModuleAudio.EQItems`** (CONFIRMED = PROF; `EQ_*` names from `E2A0_01_AudioEQ_E`; gain 8 of max 16 = flat):

```json
[
  {"Name":"EQ_100","Index":0,"Value":8,"MaxValue":16},
  {"Name":"EQ_300","Index":1,"Value":8,"MaxValue":16},
  {"Name":"EQ_1000","Index":2,"Value":8,"MaxValue":16},
  {"Name":"EQ_3000","Index":3,"Value":8,"MaxValue":16},
  {"Name":"EQ_10000","Index":4,"Value":8,"MaxValue":16}
]
```

---

## 5. (d) Full UI-form `Profile_GetDeviceData` Tag, user's HDR state

**Serializer.** `JsonSerialize(IgnoreUI, bIgnoreNullValue:false)` (report 12 §2.1). In practice this is the default contract with nulls kept, because no member on this type is tagged `IgnoreUI`.

**Wire form and verification.** The wire form is the **compact** serialization: no whitespace, keys in the order shown, and non-ASCII raw. It is **29403 bytes, sha256 `91e8a59c09e6a94d2e67d0422ed35519be6c8111499da17187c368c460d45a45`**. The block below is the same object pretty-printed (any object or array whose compact form fits in about 230 characters is kept on one line). `JSON.stringify(JSON.parse(block))` in Node reproduces the compact bytes, because every value is an int, a bool, null or a plain string, and `"` inside `ScreenSize` is escaped identically.

**Provenance.**
- **Observed (CONFIRMED)**, from PROF and/or LOG26:
  - every `Value` and `err_code`;
  - `IsSmartImageHDR`, `ENEEffectEnable`;
  - both `Items` lists, `InputSourceList`, `PIPPBPSourceList`, `InputSourceInfo`, `PIPLocationList`, `EQItems`;
  - `SubSmartImages` keys and values;
  - `WorkingTime`, `TimeAfterPixelRefresh`;
  - `EffectInfo` (the stored one, copied by `method_12`);
  - `DispalyData` (EDID strings with locale commas, `3440x1440`, `175Hz`, `0°`);
  - `EquipmentType`, `DeviceType`, `ModelName`.
- **Observed in LOG26 only:** every `MaxValue`.
- **Computed from code (CONFIRMED rules):**
  - `VCPOpCodeName` (constructor names);
  - `MinValue` 0 and `StepValue` 1;
  - every `ValueList` (§4), including the A5 replacement;
  - `HasUSBSetting:true` (E2A012 available);
  - `ExtModel:null`;
  - every `null`;
  - key order.
- **Check.** Stripping the computed members reproduces PROF exactly (§0).
- **Path independence.** The Tag is the same whether it was produced by the connect path (`DeviceDataCheck` → `ParameterToDevice(bForce:true)`, `LOG26:995-997`) or by `PHL_ReloadData` (`ReloadOSD` → `ParameterToDevice(bForce:false)`, `LOG26:1096-1179`). The only data the forced path adds are `SubSmartImages` entries merged from PROF, and PROF has only `"33"`.
- **Unread SDR attributes.** In HDR, `ModuleSmartImage.CurSubSmartImage` attributes are never read: `Value:null`, `MaxValue:0`, `ValueList:null`, `err_code:0`.

```json
{
  "IsSmartImageHDR": true,
  "HasUSBSetting": true,
  "OP_DC_DisplayApplication": {
    "VCPOpCode": 220,
    "VCPOpCodeName": "OP_DC_DisplayApplication",
    "Value": 33,
    "MinValue": 0,
    "MaxValue": 53,
    "StepValue": 1,
    "ValueList": [
      {"Name":"SmartImage_Standard","Text":"Standard","Value":0},
      {"Name":"SmartImage_FPS","Text":"FPS","Value":1},
      {"Name":"SmartImage_Movie","Text":"Movie","Value":3},
      {"Name":"SmartImage_Game1","Text":"Game1","Value":4},
      {"Name":"SmartImage_Game2","Text":"Game2","Value":5},
      {"Name":"SmartImage_Racing","Text":"Racing","Value":6},
      {"Name":"SmartImage_RTS","Text":"RTS","Value":7},
      {"Name":"SmartImage_Economy","Text":"Economy","Value":8},
      {"Name":"SmartImage_LowBlueMode","Text":"LowBlueMode","Value":11},
      {"Name":"SmartImage_EasyRead","Text":"EasyRead","Value":14},
      {"Name":"SmartImage_ConsoleMode","Text":"ConsoleMode","Value":17},
      {"Name":"SmartImage_IllustratorMode","Text":"Illustrator Mode","Value":81},
      {"Name":"HDROff","Text":"HDR Off","Value":32},
      {"Name":"HDRGame","Text":"HDR Game","Value":33},
      {"Name":"HDRMovie","Text":"HDR Movie","Value":34},
      {"Name":"HDRPhoto","Text":"HDR Photo","Value":35},
      {"Name":"HDRPersonal","Text":"HDR Personal","Value":36},
      {"Name":"HDRTrueBlack","Text":"HDR True Black","Value":48},
      {"Name":"HDRPeak","Text":"HDR Peak","Value":51}
    ],
    "err_code": 0
  },
  "ModuleSmartImage": {
    "Items": [],
    "CurSubSmartImage": {
      "OP_10_Luminance": {"VCPOpCode":16,"VCPOpCodeName":"OP_10_Luminance","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_12_Contrast": {"VCPOpCode":18,"VCPOpCodeName":"OP_12_Contrast","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_F0_SmartContrast": {"VCPOpCode":240,"VCPOpCodeName":"OP_F0_SmartContrast","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_72_Gamma": {"VCPOpCode":114,"VCPOpCodeName":"OP_72_Gamma","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_87_Sharpness": {"VCPOpCode":135,"VCPOpCodeName":"OP_87_Sharpness","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "EXT_OP_E2A0_20_ColorSpace": {"VCPOpCode":14852128,"VCPOpCodeName":"EXT_OP_E2A0_20_ColorSpace","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_14_SelectColorPreset": {"VCPOpCode":20,"VCPOpCodeName":"OP_14_SelectColorPreset","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_16_VideoGainDriveRed": {"VCPOpCode":22,"VCPOpCodeName":"OP_16_VideoGainDriveRed","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_18_VideoGainDriveGreen": {"VCPOpCode":24,"VCPOpCodeName":"OP_18_VideoGainDriveGreen","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_1A_VideoGainDriveBlue": {"VCPOpCode":26,"VCPOpCodeName":"OP_1A_VideoGainDriveBlue","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_8A_Saturation": {"VCPOpCode":138,"VCPOpCodeName":"OP_8A_Saturation","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_90_Hue": {"VCPOpCode":144,"VCPOpCodeName":"OP_90_Hue","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
      "EXT_OP_E2A0_24_DLBL": {"VCPOpCode":14852132,"VCPOpCodeName":"EXT_OP_E2A0_24_DLBL","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0}
    },
    "SubSmartImages": {}
  },
  "ModuleSmartImageHDR": {
    "Items": [
      {"Name":"HDROff","Text":"HDR Off","Value":32},
      {"Name":"HDRGame","Text":"HDR Game","Value":33},
      {"Name":"HDRMovie","Text":"HDR Movie","Value":34},
      {"Name":"HDRPhoto","Text":"HDR Photo","Value":35},
      {"Name":"HDRPersonal","Text":"HDR Personal","Value":36},
      {"Name":"HDRTrueBlack","Text":"HDR True Black","Value":48},
      {"Name":"HDRPeak","Text":"HDR Peak","Value":51}
    ],
    "CurSubSmartImage": {
      "OP_10_Luminance": {"VCPOpCode":16,"VCPOpCodeName":"OP_10_Luminance","Value":100,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
      "OP_12_Contrast": {"VCPOpCode":18,"VCPOpCodeName":"OP_12_Contrast","Value":50,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
      "EXT_OP_E2A0_3D_LightEnhancement": {"VCPOpCode":14852157,"VCPOpCodeName":"EXT_OP_E2A0_3D_LightEnhancement","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
      "EXT_OP_E2A0_3E_ColorEnhancement": {"VCPOpCode":14852158,"VCPOpCodeName":"EXT_OP_E2A0_3E_ColorEnhancement","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
      "EXT_OP_E2A0_3F_DarkEnhancement": {"VCPOpCode":14852159,"VCPOpCodeName":"EXT_OP_E2A0_3F_DarkEnhancement","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9}
    },
    "SubSmartImages": {
      "33": {
        "OP_10_Luminance": {"VCPOpCode":16,"VCPOpCodeName":"OP_10_Luminance","Value":100,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
        "OP_12_Contrast": {"VCPOpCode":18,"VCPOpCodeName":"OP_12_Contrast","Value":50,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
        "EXT_OP_E2A0_3D_LightEnhancement": {"VCPOpCode":14852157,"VCPOpCodeName":"EXT_OP_E2A0_3D_LightEnhancement","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
        "EXT_OP_E2A0_3E_ColorEnhancement": {"VCPOpCode":14852158,"VCPOpCodeName":"EXT_OP_E2A0_3E_ColorEnhancement","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
        "EXT_OP_E2A0_3F_DarkEnhancement": {"VCPOpCode":14852159,"VCPOpCodeName":"EXT_OP_E2A0_3F_DarkEnhancement","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9}
      }
    }
  },
  "ModuleGameMode": {
    "EXT_OP_E2A0_40_AdaptiveSync": {"VCPOpCode":14852160,"VCPOpCodeName":"EXT_OP_E2A0_40_AdaptiveSync","Value":1,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "EXT_OP_E2A0_02_MBR": {"VCPOpCode":14852098,"VCPOpCodeName":"EXT_OP_E2A0_02_MBR","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_03_MBRSync": {"VCPOpCode":14852099,"VCPOpCodeName":"EXT_OP_E2A0_03_MBRSync","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_04_SmartCrosshair": {
      "VCPOpCode": 14852100,
      "VCPOpCodeName": "EXT_OP_E2A0_04_SmartCrosshair",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 2,
      "StepValue": 1,
      "ValueList": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1},{"Name":"SmartCrosshairOn","Text":"Smart Crosshair On","Value":2}],
      "err_code": 0
    },
    "EXT_OP_E2A0_44_StarkShadowBoost": {
      "VCPOpCode": 14852164,
      "VCPOpCodeName": "EXT_OP_E2A0_44_StarkShadowBoost",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 3,
      "StepValue": 1,
      "ValueList": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"Level1","Text":"Level 1","Value":1},{"Name":"Level2","Text":"Level 2","Value":2},{"Name":"Level3","Text":"Level 3","Value":3}],
      "err_code": 0
    },
    "EXT_OP_E2A0_45_ShadowBoost": {"VCPOpCode":14852165,"VCPOpCodeName":"EXT_OP_E2A0_45_ShadowBoost","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_06_SharpShooter_Size": {
      "VCPOpCode": 14852102,
      "VCPOpCodeName": "EXT_OP_E2A0_06_SharpShooter_Size",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 3,
      "StepValue": 1,
      "ValueList": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"Num_1_0","Text":"1","Value":1},{"Name":"Num_1_5","Text":"1.5","Value":2},{"Name":"Num_2_0","Text":"2.0","Value":3}],
      "err_code": 0
    },
    "EXT_OP_E2A0_25_SharpShooter_Location": {"VCPOpCode":14852133,"VCPOpCodeName":"EXT_OP_E2A0_25_SharpShooter_Location","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_07_LowInputLag": {"VCPOpCode":14852103,"VCPOpCodeName":"EXT_OP_E2A0_07_LowInputLag","Value":0,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "OP_EB_SmartResponse": {"VCPOpCode":235,"VCPOpCodeName":"OP_EB_SmartResponse","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_4C_Overclock": {"VCPOpCode":14852172,"VCPOpCodeName":"EXT_OP_E2A0_4C_Overclock","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_08_SmartFrame": {"VCPOpCode":14852104,"VCPOpCodeName":"EXT_OP_E2A0_08_SmartFrame","Value":0,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "EXT_OP_E2A0_09_SmartFrameSize": {
      "VCPOpCode": 14852105,
      "VCPOpCodeName": "EXT_OP_E2A0_09_SmartFrameSize",
      "Value": 1,
      "MinValue": 0,
      "MaxValue": 7,
      "StepValue": 1,
      "ValueList": [
        {"Name":"Num_1","Text":"1","Value":1},
        {"Name":"Num_2","Text":"2","Value":2},
        {"Name":"Num_3","Text":"3","Value":3},
        {"Name":"Num_4","Text":"4","Value":4},
        {"Name":"Num_5","Text":"5","Value":5},
        {"Name":"Num_6","Text":"6","Value":6},
        {"Name":"Num_7","Text":"7","Value":7}
      ],
      "err_code": 0
    },
    "EXT_OP_E2A0_0A_SmartFrameBrightness": {"VCPOpCode":14852106,"VCPOpCodeName":"EXT_OP_E2A0_0A_SmartFrameBrightness","Value":100,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
    "EXT_OP_E2A0_0B_SmartFrameContrast": {"VCPOpCode":14852107,"VCPOpCodeName":"EXT_OP_E2A0_0B_SmartFrameContrast","Value":50,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
    "EXT_OP_E2A0_0C_SmartFrameHPosition": {"VCPOpCode":14852108,"VCPOpCodeName":"EXT_OP_E2A0_0C_SmartFrameHPosition","Value":0,"MinValue":0,"MaxValue":5,"StepValue":1,"ValueList":null,"err_code":0},
    "EXT_OP_E2A0_0D_SmartFrameVPosition": {"VCPOpCode":14852109,"VCPOpCodeName":"EXT_OP_E2A0_0D_SmartFrameVPosition","Value":0,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
    "EXT_OP_E2A0_59_DualResolution": {"VCPOpCode":14852185,"VCPOpCodeName":"EXT_OP_E2A0_59_DualResolution","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_68_AutoRefineAIStatus": {"VCPOpCode":14852200,"VCPOpCodeName":"EXT_OP_E2A0_68_AutoRefineAIStatus","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9}
  },
  "ModuleAmbiglow": {
    "EXT_OP_E2A0_19_AmbiglowLightMode": {
      "VCPOpCode": 14852121,
      "VCPOpCodeName": "EXT_OP_E2A0_19_AmbiglowLightMode",
      "Value": 7,
      "MinValue": 0,
      "MaxValue": 7,
      "StepValue": 1,
      "ValueList": [
        {"Name":"FollowVideo","Text":"Follow Video","Value":1},
        {"Name":"FollowAudio","Text":"Follow Audio","Value":2},
        {"Name":"ColorShift","Text":"Color Shift","Value":3},
        {"Name":"ColorWave","Text":"Color Wave","Value":4},
        {"Name":"ColorBreathing","Text":"Color Breathing","Value":5},
        {"Name":"StarryNight","Text":"Starry Night","Value":6},
        {"Name":"StaticMode","Text":"Static Mode","Value":7}
      ],
      "err_code": 0
    },
    "EXT_OP_E2A0_1A_AmbiglowColors": {
      "VCPOpCode": 14852122,
      "VCPOpCodeName": "EXT_OP_E2A0_1A_AmbiglowColors",
      "Value": 6,
      "MinValue": 0,
      "MaxValue": 13,
      "StepValue": 1,
      "ValueList": [
        {"Name":"Rainbow","Text":"Rainbow","Value":0},
        {"Name":"White","Text":"White","Value":1},
        {"Name":"Red","Text":"Red","Value":2},
        {"Name":"Rose","Text":"Rose","Value":3},
        {"Name":"Magenta","Text":"Magenta","Value":4},
        {"Name":"Violet","Text":"Violet","Value":5},
        {"Name":"Blue","Text":"Blue","Value":6},
        {"Name":"Azure","Text":"Azure","Value":7},
        {"Name":"Cyan","Text":"Cyan","Value":8},
        {"Name":"Aqua","Text":"Aqua","Value":9},
        {"Name":"Green","Text":"Green","Value":10},
        {"Name":"Pear","Text":"Pear","Value":11},
        {"Name":"Yellow","Text":"Yellow","Value":12},
        {"Name":"Orange","Text":"Orange","Value":13}
      ],
      "err_code": 0
    },
    "EXT_OP_E2A0_1B_AmbiglowLightPosition": {
      "VCPOpCode": 14852123,
      "VCPOpCodeName": "EXT_OP_E2A0_1B_AmbiglowLightPosition",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 3,
      "StepValue": 1,
      "ValueList": [{"Name":"AllZones","Text":"All Zones","Value":0},{"Name":"FourSided","Text":"4-sided","Value":1},{"Name":"Central","Text":"Central","Value":2},{"Name":"Bottom","Text":"Bottom","Value":3}],
      "err_code": 0
    },
    "EXT_OP_E2A0_1C_AmbiglowLightBrightness": {
      "VCPOpCode": 14852124,
      "VCPOpCodeName": "EXT_OP_E2A0_1C_AmbiglowLightBrightness",
      "Value": 2,
      "MinValue": 0,
      "MaxValue": 2,
      "StepValue": 1,
      "ValueList": [{"Name":"Bright","Text":"Bright","Value":0},{"Name":"Brighter","Text":"Brighter","Value":1},{"Name":"Brightest","Text":"Brightest","Value":2}],
      "err_code": 0
    },
    "EXT_OP_E2A0_1D_AmbiglowLightSpeed": {
      "VCPOpCode": 14852125,
      "VCPOpCodeName": "EXT_OP_E2A0_1D_AmbiglowLightSpeed",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 2,
      "StepValue": 1,
      "ValueList": [{"Name":"Low","Text":"Low","Value":0},{"Name":"Normal","Text":"Normal","Value":1},{"Name":"High","Text":"High","Value":2}],
      "err_code": 0
    },
    "EXT_OP_E2A0_1E_AmbiglowLightDirection": {"VCPOpCode":14852126,"VCPOpCodeName":"EXT_OP_E2A0_1E_AmbiglowLightDirection","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EffectEnable": false
  },
  "ModuleInput": {
    "OP_ED_InputAuto": {"VCPOpCode":237,"VCPOpCodeName":"OP_ED_InputAuto","Value":1,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "OP_60_InputSource": {
      "VCPOpCode": 96,
      "VCPOpCodeName": "OP_60_InputSource",
      "Value": 15,
      "MinValue": 0,
      "MaxValue": 13846,
      "StepValue": 1,
      "ValueList": [
        {"Name":"Normal_DisplayPort1","Text":"DisplayPort 1","Value":15},
        {"Name":"Normal_DigitalHDMI1","Text":"Digital HDMI 1","Value":17},
        {"Name":"Normal_DigitalHDMI2","Text":"Digital HDMI 2","Value":18},
        {"Name":"Normal_USBC1","Text":"USB C1","Value":21},
        {"Name":"PIPPBP_DigitalHDMI1","Text":"Digital HDMI 1","Value":33},
        {"Name":"PIPPBP_DigitalHDMI2","Text":"Digital HDMI 2","Value":34},
        {"Name":"PIPPBP_DisplayPort1","Text":"DisplayPort 1","Value":47},
        {"Name":"PIPPBP_USBC1","Text":"USB C1","Value":53}
      ],
      "err_code": 0
    },
    "OP_A5_WindowSelect": {
      "VCPOpCode": 165,
      "VCPOpCodeName": "OP_A5_WindowSelect",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 512,
      "StepValue": 1,
      "ValueList": [{"Name":"PIPPBP__OFF","Text":"PIPPBP__OFF","Value":0},{"Name":"PIPPBP__PIP","Text":"PIPPBP__PIP","Value":256},{"Name":"PIPPBP__PBP_1","Text":"PIPPBP__PBP_1","Value":512}],
      "err_code": 0
    },
    "OP_EC_PIPPBPSizeLocation": {
      "VCPOpCode": 236,
      "VCPOpCodeName": "OP_EC_PIPPBPSizeLocation",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 0,
      "StepValue": 1,
      "ValueList": [{"Name":"Small","Text":"Small","Value":1},{"Name":"Middle","Text":"Middle","Value":2},{"Name":"Large","Text":"Large","Value":3}],
      "err_code": 0
    },
    "OP_F6_PIPPBPSwap": {"VCPOpCode":246,"VCPOpCodeName":"OP_F6_PIPPBPSwap","Value":0,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":0},
    "InputSourceList": [
      {"Name":"Normal_DisplayPort1","Text":"DisplayPort 1","Value":15},
      {"Name":"Normal_DigitalHDMI1","Text":"Digital HDMI 1","Value":17},
      {"Name":"Normal_DigitalHDMI2","Text":"Digital HDMI 2","Value":18},
      {"Name":"Normal_USBC1","Text":"USB C1","Value":21}
    ],
    "PIPPBPSourceList": [
      {"Name":"PIPPBP_DigitalHDMI1","Text":"Digital HDMI 1","Value":33},
      {"Name":"PIPPBP_DigitalHDMI2","Text":"Digital HDMI 2","Value":34},
      {"Name":"PIPPBP_DisplayPort1","Text":"DisplayPort 1","Value":47},
      {"Name":"PIPPBP_USBC1","Text":"USB C1","Value":53}
    ],
    "InputSourceInfo": {"Mode":0,"Size":0,"Location":0,"PIPPBPSource":34,"InputSource":15},
    "PIPLocationList": [{"Name":"UpperRight","Text":"UpperRight","Value":1},{"Name":"LowerRight","Text":"LowerRight","Value":2},{"Name":"UpperLeft","Text":"UpperLeft","Value":3},{"Name":"LowerLeft","Text":"LowerLeft","Value":4}]
  },
  "ModuleAudio": {
    "OP_62_AudioSpeakerVolume": {"VCPOpCode":98,"VCPOpCodeName":"OP_62_AudioSpeakerVolume","Value":0,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
    "OP_8D_AudioMute": {"VCPOpCode":141,"VCPOpCodeName":"OP_8D_AudioMute","Value":2,"MinValue":0,"MaxValue":2,"StepValue":1,"ValueList":[{"Name":"ON","Text":"On","Value":1},{"Name":"OFF","Text":"Off","Value":2}],"err_code":0},
    "EXT_OP_E2A0_00_AudioMode": {
      "VCPOpCode": 14852096,
      "VCPOpCodeName": "EXT_OP_E2A0_00_AudioMode",
      "Value": 70,
      "MinValue": 0,
      "MaxValue": 75,
      "StepValue": 1,
      "ValueList": [
        {"Name":"OFF","Text":"Off","Value":70},
        {"Name":"SportsRacing","Text":"Sports & Racing","Value":71},
        {"Name":"RPGAdventure","Text":"RPG & Adventure","Value":72},
        {"Name":"ShootingAction","Text":"Shooting & Action","Value":73},
        {"Name":"MovieWatching","Text":"Movie Watching","Value":74},
        {"Name":"Music","Text":"Music","Value":75}
      ],
      "err_code": 0
    },
    "OP_E0_AudioSource": {
      "VCPOpCode": 224,
      "VCPOpCodeName": "OP_E0_AudioSource",
      "Value": 3,
      "MinValue": 0,
      "MaxValue": 8,
      "StepValue": 1,
      "ValueList": [
        {"Name":"AudioSource_HDMI1","Text":"HDMI1","Value":1},
        {"Name":"AudioSource_HDMI2","Text":"HDMI2","Value":2},
        {"Name":"AudioSource_DisplayPort1","Text":"Display Port 1","Value":3},
        {"Name":"AudioSource_USBC1","Text":"USB C1","Value":5}
      ],
      "err_code": 0
    },
    "EQItems": [
      {"Name":"EQ_100","Index":0,"Value":8,"MaxValue":16},
      {"Name":"EQ_300","Index":1,"Value":8,"MaxValue":16},
      {"Name":"EQ_1000","Index":2,"Value":8,"MaxValue":16},
      {"Name":"EQ_3000","Index":3,"Value":8,"MaxValue":16},
      {"Name":"EQ_10000","Index":4,"Value":8,"MaxValue":16}
    ]
  },
  "ModuleSystem": {
    "EXT_OP_E2A0_3A_HDMI1RefreshRate": {"VCPOpCode":14852154,"VCPOpCodeName":"EXT_OP_E2A0_3A_HDMI1RefreshRate","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_3B_HDMI2RefreshRate": {"VCPOpCode":14852155,"VCPOpCodeName":"EXT_OP_E2A0_3B_HDMI2RefreshRate","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_3C_HDMI3RefreshRate": {"VCPOpCode":14852156,"VCPOpCodeName":"EXT_OP_E2A0_3C_HDMI3RefreshRate","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_0E_OSDSettingHorizontal": {"VCPOpCode":14852110,"VCPOpCodeName":"EXT_OP_E2A0_0E_OSDSettingHorizontal","Value":50,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
    "EXT_OP_E2A0_0F_OSDSettingVertical": {"VCPOpCode":14852111,"VCPOpCodeName":"EXT_OP_E2A0_0F_OSDSettingVertical","Value":50,"MinValue":0,"MaxValue":100,"StepValue":1,"ValueList":null,"err_code":0},
    "EXT_OP_E2A0_10_OSDSettingTransparency": {
      "VCPOpCode": 14852112,
      "VCPOpCodeName": "EXT_OP_E2A0_10_OSDSettingTransparency",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 4,
      "StepValue": 1,
      "ValueList": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"Num_1","Text":"1","Value":1},{"Name":"Num_2","Text":"2","Value":2},{"Name":"Num_3","Text":"3","Value":3},{"Name":"Num_4","Text":"4","Value":4}],
      "err_code": 0
    },
    "EXT_OP_E2A0_11_OSDSettingTimeOut": {
      "VCPOpCode": 14852113,
      "VCPOpCodeName": "EXT_OP_E2A0_11_OSDSettingTimeOut",
      "Value": 2,
      "MinValue": 0,
      "MaxValue": 4,
      "StepValue": 1,
      "ValueList": [{"Name":"Time_5","Text":"5 s","Value":0},{"Name":"Time_10","Text":"10 s","Value":1},{"Name":"Time_20","Text":"20 s","Value":2},{"Name":"Time_30","Text":"30 s","Value":3},{"Name":"Time_60","Text":"60 s","Value":4}],
      "err_code": 0
    },
    "OP_86_DisplayScaling": {
      "VCPOpCode": 134,
      "VCPOpCodeName": "OP_86_DisplayScaling",
      "Value": 2,
      "MinValue": 0,
      "MaxValue": 35,
      "StepValue": 1,
      "ValueList": [
        {"Name":"Scaling_NoScaling","Text":"No Scaling (1:1)","Value":1},
        {"Name":"Scaling_19","Text":"19\"","Value":18},
        {"Name":"Scaling_19_W","Text":"19\"W","Value":19},
        {"Name":"Scaling_22_W","Text":"22\"W","Value":20},
        {"Name":"Scaling_18_5_W","Text":"18.5\"W","Value":21},
        {"Name":"Scaling_19_5_W","Text":"19.5\"W","Value":22},
        {"Name":"Scaling_20_W","Text":"20\"W","Value":23},
        {"Name":"Scaling_21_5_W","Text":"21.5\"W","Value":24},
        {"Name":"Scaling_23_W","Text":"23\"W","Value":25},
        {"Name":"Scaling_24_W","Text":"24\"W","Value":26},
        {"Name":"Scaling_27_W","Text":"27\"W","Value":27},
        {"Name":"Scaling_Aspect_4to3","Text":"4:3(Aspect)","Value":35}
      ],
      "err_code": 0
    },
    "EXT_OP_E2A0_12_USB_C_Setting": {
      "VCPOpCode": 14852114,
      "VCPOpCodeName": "EXT_OP_E2A0_12_USB_C_Setting",
      "Value": 1,
      "MinValue": 0,
      "MaxValue": 1,
      "StepValue": 1,
      "ValueList": [{"Name":"USB_2_0","Text":"USB2.0(High Resolution)","Value":0},{"Name":"USB_3_2","Text":"USB3.2(High Data Speed)","Value":1}],
      "err_code": 0
    },
    "EXT_OP_E2A0_13_USB_StandbyMode": {"VCPOpCode":14852115,"VCPOpCodeName":"EXT_OP_E2A0_13_USB_StandbyMode","Value":1,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "EXT_OP_E2A0_14_USB_Upstream": {"VCPOpCode":14852116,"VCPOpCodeName":"EXT_OP_E2A0_14_USB_Upstream","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_15_KVM": {
      "VCPOpCode": 14852117,
      "VCPOpCodeName": "EXT_OP_E2A0_15_KVM",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 2,
      "StepValue": 1,
      "ValueList": [{"Name":"KVM_Status_Auto","Text":"Auto","Value":0},{"Name":"KVM_Status_USB_C","Text":"Usb C","Value":1},{"Name":"KVM_Status_USB_Up","Text":"Usb Up","Value":2}],
      "err_code": 0
    },
    "EXT_OP_E2A0_16_SmartPower": {"VCPOpCode":14852118,"VCPOpCodeName":"EXT_OP_E2A0_16_SmartPower","Value":0,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "EXT_OP_E2A0_18_LocalDimming": {"VCPOpCode":14852120,"VCPOpCodeName":"EXT_OP_E2A0_18_LocalDimming","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "OP_54_PerformancePreservation": {"VCPOpCode":84,"VCPOpCodeName":"OP_54_PerformancePreservation","Value":2,"MinValue":0,"MaxValue":4,"StepValue":1,"ValueList":[{"Name":"ON","Text":"On","Value":0},{"Name":"OFF","Text":"Off","Value":1}],"err_code":0},
    "OP_DA_ScanMode": {"VCPOpCode":218,"VCPOpCodeName":"OP_DA_ScanMode","Value":2,"MinValue":0,"MaxValue":8,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Normal operation","Value":0},{"Name":"ON","Text":"Overscan","Value":2}],"err_code":0},
    "EXT_OP_E2A0_6B_Profile": {"VCPOpCode":14852203,"VCPOpCodeName":"EXT_OP_E2A0_6B_Profile","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9}
  },
  "ModuleSetup": {
    "OP_F2_PowerLED": {
      "VCPOpCode": 242,
      "VCPOpCodeName": "OP_F2_PowerLED",
      "Value": 1,
      "MinValue": 0,
      "MaxValue": 4,
      "StepValue": 1,
      "ValueList": [
        {"Name":"POWER_LED_STEP0","Text":"等级0","Value":0},
        {"Name":"POWER_LED_STEP1","Text":"等级1","Value":1},
        {"Name":"POWER_LED_STEP2","Text":"等级2","Value":2},
        {"Name":"POWER_LED_STEP3","Text":"等级3","Value":3},
        {"Name":"POWER_LED_STEP4","Text":"等级4","Value":4}
      ],
      "err_code": 0
    },
    "OP_CC_OSDLanguage": {
      "VCPOpCode": 204,
      "VCPOpCodeName": "OP_CC_OSDLanguage",
      "Value": 2,
      "MinValue": 0,
      "MaxValue": 36,
      "StepValue": 1,
      "ValueList": [
        {"Name":"Chinese_tw","Text":"繁体中文","Value":1},
        {"Name":"English","Text":"English","Value":2},
        {"Name":"French","Text":"Français","Value":3},
        {"Name":"German","Text":"Deutsch","Value":4},
        {"Name":"Italian","Text":"Italiano","Value":5},
        {"Name":"Japanese","Text":"日本語","Value":6},
        {"Name":"Korean","Text":"한국어","Value":7},
        {"Name":"Portuguese_Portugal","Text":"Português","Value":8},
        {"Name":"Russian","Text":"Русский","Value":9},
        {"Name":"Spanish","Text":"Español","Value":10},
        {"Name":"Swedish","Text":"Svenska","Value":11},
        {"Name":"Turkish","Text":"Türkçe","Value":12},
        {"Name":"Chinese_cn","Text":"简体中文","Value":13},
        {"Name":"Portuguese_Brazil","Text":"Português do Brasil","Value":14},
        {"Name":"Czech","Text":"Česky","Value":18},
        {"Name":"Dutch","Text":"Nederlands","Value":20},
        {"Name":"Finnish","Text":"Suomi","Value":22},
        {"Name":"Greek","Text":"Ελληνικά","Value":23},
        {"Name":"Hungarian","Text":"Magyar","Value":26},
        {"Name":"Polish","Text":"Polski","Value":30},
        {"Name":"Ukrainian","Text":"Українська","Value":36}
      ],
      "err_code": 0
    },
    "OP_E9_ResolutionNotifier": {
      "VCPOpCode": 233,
      "VCPOpCodeName": "OP_E9_ResolutionNotifier",
      "Value": 0,
      "MinValue": 0,
      "MaxValue": 2,
      "StepValue": 1,
      "ValueList": [{"Name":"OFF","Text":"ResolutionNotifierOff","Value":0},{"Name":"ON","Text":"ResolutionNotifierOn","Value":2}],
      "err_code": 0
    },
    "EXT_OP_E2A0_17_CEC": {"VCPOpCode":14852119,"VCPOpCodeName":"EXT_OP_E2A0_17_CEC","Value":0,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "EXT_OP_E2A0_35_ScreenSaver": {
      "VCPOpCode": 14852149,
      "VCPOpCodeName": "EXT_OP_E2A0_35_ScreenSaver",
      "Value": 2,
      "MinValue": 0,
      "MaxValue": 3,
      "StepValue": 1,
      "ValueList": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"Slow","Text":"Slow","Value":2},{"Name":"Fast","Text":"Fast","Value":3}],
      "err_code": 0
    },
    "EXT_OP_E2A0_34_PixelOrbiting": {
      "VCPOpCode": 14852148,
      "VCPOpCodeName": "EXT_OP_E2A0_34_PixelOrbiting",
      "Value": 3,
      "MinValue": 0,
      "MaxValue": 4,
      "StepValue": 1,
      "ValueList": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"Slow","Text":"Slow","Value":2},{"Name":"Normal","Text":"Normal","Value":3},{"Name":"Fast","Text":"Fast","Value":4}],
      "err_code": 0
    },
    "EXT_OP_E2A0_36_PixelRefresh": {"VCPOpCode":14852150,"VCPOpCodeName":"EXT_OP_E2A0_36_PixelRefresh","Value":0,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "EXT_OP_E2A0_37_PanelRefresh": {"VCPOpCode":14852151,"VCPOpCodeName":"EXT_OP_E2A0_37_PanelRefresh","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_43_AutoWarning": {"VCPOpCode":14852163,"VCPOpCodeName":"EXT_OP_E2A0_43_AutoWarning","Value":1,"MinValue":0,"MaxValue":1,"StepValue":1,"ValueList":[{"Name":"OFF","Text":"Off","Value":0},{"Name":"ON","Text":"On","Value":1}],"err_code":0},
    "EXT_OP_E2A0_47_UniBright": {"VCPOpCode":14852167,"VCPOpCodeName":"EXT_OP_E2A0_47_UniBright","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_48_MultiLogoProtection": {"VCPOpCode":14852168,"VCPOpCodeName":"EXT_OP_E2A0_48_MultiLogoProtection","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_49_BoundaryDimmer": {"VCPOpCode":14852169,"VCPOpCodeName":"EXT_OP_E2A0_49_BoundaryDimmer","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_4A_TaskbarDimmer": {"VCPOpCode":14852170,"VCPOpCodeName":"EXT_OP_E2A0_4A_TaskbarDimmer","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_4B_ThermalProtection": {"VCPOpCode":14852171,"VCPOpCodeName":"EXT_OP_E2A0_4B_ThermalProtection","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_61_AutoPixelRefresh": {"VCPOpCode":14852193,"VCPOpCodeName":"EXT_OP_E2A0_61_AutoPixelRefresh","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "WorkingTime": -1,
    "TimeAfterPixelRefresh": -1,
    "EXT_OP_E2A0_54_PixelRefreshCounts": {"VCPOpCode":14852180,"VCPOpCodeName":"EXT_OP_E2A0_54_PixelRefreshCounts","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_55_PanelRefreshCounts": {"VCPOpCode":14852181,"VCPOpCodeName":"EXT_OP_E2A0_55_PanelRefreshCounts","Value":null,"MinValue":0,"MaxValue":0,"StepValue":1,"ValueList":null,"err_code":9},
    "EXT_OP_E2A0_41_FanControl": {
      "VCPOpCode": 14852161,
      "VCPOpCodeName": "EXT_OP_E2A0_41_FanControl",
      "Value": 1,
      "MinValue": 0,
      "MaxValue": 2,
      "StepValue": 1,
      "ValueList": [{"Name":"OFF","Text":"Off","Value":0},{"Name":"Auto","Text":"Auto","Value":1},{"Name":"Quiet","Text":"Quiet","Value":2}],
      "err_code": 0
    }
  },
  "ENEEffectEnable": false,
  "EffectInfo": {
    "EffectList": [
      {
        "Effect": {"Name":"FollowVideo","Text":"光影同步","Value":1},
        "Speed": 2,
        "Brightness": 3,
        "IsRandomColor": false,
        "IsRainbowColor": true,
        "CurRGB": {"R":0,"G":0,"B":0},
        "BgRGB": {"R":0,"G":0,"B":0},
        "CurDir": -1,
        "CurRegion": 0,
        "CurStarCount": 1
      },
      {
        "Effect": {"Name":"FollowAudio","Text":"光音同步","Value":2},
        "Speed": 2,
        "Brightness": 3,
        "IsRandomColor": false,
        "IsRainbowColor": true,
        "CurRGB": {"R":0,"G":0,"B":0},
        "BgRGB": {"R":0,"G":0,"B":0},
        "CurDir": -1,
        "CurRegion": 0,
        "CurStarCount": 1
      },
      {
        "Effect": {"Name":"ColorShift","Text":"跑马灯模式","Value":3},
        "Speed": 2,
        "Brightness": 3,
        "IsRandomColor": false,
        "IsRainbowColor": true,
        "CurRGB": {"R":0,"G":0,"B":255},
        "BgRGB": {"R":0,"G":0,"B":0},
        "CurDir": -1,
        "CurRegion": 0,
        "CurStarCount": 1
      },
      {
        "Effect": {"Name":"ColorWave","Text":"波浪模式","Value":4},
        "Speed": 2,
        "Brightness": 3,
        "IsRandomColor": false,
        "IsRainbowColor": true,
        "CurRGB": {"R":0,"G":0,"B":255},
        "BgRGB": {"R":0,"G":0,"B":0},
        "CurDir": -1,
        "CurRegion": 0,
        "CurStarCount": 1
      },
      {
        "Effect": {"Name":"Breathing","Text":"呼吸模式","Value":5},
        "Speed": 2,
        "Brightness": 3,
        "IsRandomColor": false,
        "IsRainbowColor": true,
        "CurRGB": {"R":0,"G":0,"B":255},
        "BgRGB": {"R":0,"G":0,"B":0},
        "CurDir": -1,
        "CurRegion": 0,
        "CurStarCount": 1
      },
      {
        "Effect": {"Name":"StarryNight","Text":"繁星模式","Value":6},
        "Speed": 2,
        "Brightness": 3,
        "IsRandomColor": false,
        "IsRainbowColor": true,
        "CurRGB": {"R":0,"G":0,"B":255},
        "BgRGB": {"R":0,"G":0,"B":0},
        "CurDir": -1,
        "CurRegion": 0,
        "CurStarCount": 1
      },
      {"Effect":{"Name":"Static","Text":"恒亮模式","Value":7},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":255},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1}
    ],
    "EffectDetail": {"Effect":{"Name":"FollowVideo","Text":"光影同步","Value":1},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},
    "EffectEnable": true,
    "CurrEffect": {"Name":"FollowVideo","Text":"光影同步","Value":1}
  },
  "DispalyData": {
    "MonitorEDIDInfo_T": {
      "sManufacturer": "PHL",
      "sManufacturerDate": "Week01-2025",
      "PlugAndPlayID": "PHLC29F",
      "sMonitorName": "PHL 34M2C8600",
      "sSerialNumber": "AU00000000001",
      "sVersion": "1.4",
      "ScreenSize": "~34,2\"",
      "TimingRecommandation": "3440x1440",
      "DisplayGamma": "2,2",
      "DisplayTypeAndSignal": "DIGITAL",
      "RedChromaticity": "Rx0,689-Ry0,303",
      "GreenChromaticity": "Gx0,241-Gy0,715",
      "BlueChromaticity": "Bx0,145-By0,059",
      "WhitePoint": "Wx0,313-Wy0,329"
    },
    "MonitorResolution": "3440x1440",
    "MonitorFrequency": "175Hz",
    "MonitorOrientation": "0°"
  },
  "EquipmentType": 1,
  "DeviceType": 100000,
  "ModelName": "PHL 34M2C8600",
  "ExtModel": null
}
```

---

## 6. (e) Static fixtures

**Envelope.** Every hub reply is `{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"<id>","Tag":<fixture>,"FunctionName":"<fn>","CurrItem":null}` (report 12 §2.3).
- These are default-mode serializations with nulls kept.
- All five are code-derived. The rules are CONFIRMED at the cited lines; the whole JSON is computed.
- Each block is the exact compact wire form (one line).

### 6.1 `Effect_GetMenu(100000)` with ENE model `"34M2C8600"` — 3962 bytes, sha256 `516cd5fad0f6938f314663ae956a79b845a816d272b7446b6bf605f77b290af2`

**Source.** `CORE/SystemOper.cs:1401-1404` → `EBASE/CDeviceEffectBase.cs:41-44` → `PHL/CDevice_PHLDisplay.cs:866-879`, cached per ENE model string `string_0` (set at `:771`) → `OPT/DisplayEffectMenu.cs:49-168`.

**Item defaults.**
- Base per item: `SupSync:true`, speed and brightness 1..3 step 1, `SupRainbowColor:true`, `SupColor:true` (`:54-73`).
- `DirList` is never set, so it is null. The star-count fields keep the `BaseEffectMenuItem` defaults 1/3/1 (`ENT/BaseEffectMenuItem.cs:63-72`).

**Region list.** `RegionList` for the 34M2C8600 comes from `res/data/ENE/PCenter_AmbiglowInfo.json`:
- the record (`"34M2C8600"`, Right 3, RightUp 4, LeftUp 4, Left 3, Center 18, Bottom 14);
- looked up by exact `ModelName` (`work/dotnet-clean/Zeasn.USB.ENE.Lib/Zeasn.USB.ENE.Lib/GClass0.cs:25-28`).
- The result is `[AllZones, Bottom, FourSided, Central]` (`OPT/DisplayEffectMenu.cs:140-168`). `Text` comes from `RegionType` `[Description]`.

**Renderer use.** The renderer asks for this menu only when `ENEEffectEnable` is true (`R/Monitor-D4qz4RBn.js:45-47`, `R/Setup-D-5j4V-I.js:129-131`).

```json
{"EffectList":[{"Effect":{"Name":"FollowVideo","Text":"光影同步","Value":1},"SupSync":true,"SupSpeed":false,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":false,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":false,"SupColor":false,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":null,"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"FollowAudio","Text":"光音同步","Value":2},"SupSync":true,"SupSpeed":false,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":false,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":true,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0},{"Name":"Bottom","Text":"Bottom","Value":3},{"Name":"FourSided","Text":"4-sided","Value":1},{"Name":"Central","Text":"Central","Value":2}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"ColorShift","Text":"跑马灯模式","Value":3},"SupSync":true,"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":true,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0},{"Name":"Bottom","Text":"Bottom","Value":3},{"Name":"FourSided","Text":"4-sided","Value":1},{"Name":"Central","Text":"Central","Value":2}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"ColorWave","Text":"波浪模式","Value":4},"SupSync":true,"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":true,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0},{"Name":"Bottom","Text":"Bottom","Value":3},{"Name":"FourSided","Text":"4-sided","Value":1},{"Name":"Central","Text":"Central","Value":2}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"Breathing","Text":"呼吸模式","Value":5},"SupSync":true,"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":true,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0},{"Name":"Bottom","Text":"Bottom","Value":3},{"Name":"FourSided","Text":"4-sided","Value":1},{"Name":"Central","Text":"Central","Value":2}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"StarryNight","Text":"繁星模式","Value":6},"SupSync":true,"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":null,"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"Static","Text":"恒亮模式","Value":7},"SupSync":true,"SupSpeed":false,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":true,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0},{"Name":"Bottom","Text":"Bottom","Value":3},{"Name":"FourSided","Text":"4-sided","Value":1},{"Name":"Central","Text":"Central","Value":2}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1}]}
```

### 6.2 `Effect_GetMenu(100000)` without ENE (`string_0 = ""`) — 3277 bytes, sha256 `cd09882c69487c4bc4c2c08251d34db1119beb152a6be887c1aa63609306a236`

`GetENELightNumbersData("")` finds no record: none of the 19 records has an empty `ModelName` (CONFIRMED). So `RegionList = [AllZones]` and `SupRegion:false` for FollowAudio, ColorShift, ColorWave, Breathing and Static. FollowVideo and StarryNight keep `RegionList:null`. The 1.13.0 renderer never requests this variant for the monitor (§6.1), but the backend answers it.

```json
{"EffectList":[{"Effect":{"Name":"FollowVideo","Text":"光影同步","Value":1},"SupSync":true,"SupSpeed":false,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":false,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":false,"SupColor":false,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":null,"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"FollowAudio","Text":"光音同步","Value":2},"SupSync":true,"SupSpeed":false,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":false,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"ColorShift","Text":"跑马灯模式","Value":3},"SupSync":true,"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"ColorWave","Text":"波浪模式","Value":4},"SupSync":true,"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"Breathing","Text":"呼吸模式","Value":5},"SupSync":true,"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"StarryNight","Text":"繁星模式","Value":6},"SupSync":true,"SupSpeed":true,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":null,"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1},{"Effect":{"Name":"Static","Text":"恒亮模式","Value":7},"SupSync":true,"SupSpeed":false,"MinSpeed":1,"MaxSpeed":3,"SpeedStep":1,"SupBrightness":true,"MinBrightness":1,"MaxBrightness":3,"BrightnessStep":1,"SupRandomColor":false,"SupRainbowColor":true,"SupColor":true,"SupBgColor":false,"SupDir":false,"DirList":null,"SupRegion":false,"RegionList":[{"Name":"AllZones","Text":"All Zones","Value":0}],"SupStarCount":false,"MinStarCount":1,"MaxStarCount":3,"StarCountStep":1}]}
```

### 6.3 `DisplayEffectInfo.Default("34M2C8600")` — 1994 bytes, sha256 `341006d3282ac2e6986a94ba8878498107baa0c0f0516f9fe11da3baa36f41e8`

**Source.** `OPT/DisplayEffectInfo.cs:49-90`. `modelName` is ignored; the effects are always the same 7.

**Values.**
- `CurrEffect = EffectType.Static.GetItem()`.
- Each detail: `Speed 2`, `Brightness 3`, `IsRandomColor false`, `IsRainbowColor true`, `CurRGB` blue (black for FollowVideo/FollowAudio), `BgRGB` black, `CurDir -1` (`DirectionType.Default`), `CurRegion 0`.
- `CurStarCount 1` is the `BaseEffectDetailInfo` default (`ENT/BaseEffectDetailInfo.cs:36`).
- `EffectDetail` is the get-only `GetEffectDetail(CurrEffect.Value)` (`:27`).
- `EffectEnable` is the base default `true` (`ENT/BaseEffectInfo.cs:9`).
- Member order: derived `EffectList, EffectDetail`, then base `EffectEnable, CurrEffect` (CONFIRMED against PROF).

```json
{"EffectList":[{"Effect":{"Name":"FollowVideo","Text":"光影同步","Value":1},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},{"Effect":{"Name":"FollowAudio","Text":"光音同步","Value":2},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},{"Effect":{"Name":"ColorShift","Text":"跑马灯模式","Value":3},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":255},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},{"Effect":{"Name":"ColorWave","Text":"波浪模式","Value":4},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":255},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},{"Effect":{"Name":"Breathing","Text":"呼吸模式","Value":5},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":255},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},{"Effect":{"Name":"StarryNight","Text":"繁星模式","Value":6},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":255},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},{"Effect":{"Name":"Static","Text":"恒亮模式","Value":7},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":255},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1}],"EffectDetail":{"Effect":{"Name":"Static","Text":"恒亮模式","Value":7},"Speed":2,"Brightness":3,"IsRandomColor":false,"IsRainbowColor":true,"CurRGB":{"R":0,"G":0,"B":255},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"EffectEnable":true,"CurrEffect":{"Name":"Static","Text":"恒亮模式","Value":7}}
```

**Diff against the stored `PROF.EffectInfo`** (CONFIRMED). The key order and all 7 `EffectList` entries are identical. `EffectEnable` is `true` in both. The differences are:

| Path | `Default("34M2C8600")` | `PROF` (Default.pcenter, and the value logged at `LOG25:740,1638`) |
|---|---|---|
| `/EffectDetail/Effect/Name` | "Static" | "FollowVideo" |
| `/EffectDetail/Effect/Text` | "恒亮模式" | "光影同步" |
| `/EffectDetail/Effect/Value` | 7 | 1 |
| `/EffectDetail/CurRGB/B` | 255 | 0 |
| `/CurrEffect/Name` | "Static" | "FollowVideo" |
| `/CurrEffect/Text` | "恒亮模式" | "光影同步" |
| `/CurrEffect/Value` | 7 | 1 |

**Interpretation.** On 2026-09-25, with ENE present, the stored `EffectInfo` was kept (`method_14` keeps an existing `EffectInfo`, report 12 §3.6) and later switched to FollowVideo. It is **not** a fresh default. Report 12 §3.6 claimed byte identity; see §8.

### 6.4 `EffectInfo` on a fresh install or after `Profile_Reset` without ENE (CONFIRMED by code; answers part of report 03 open question 7)

**How it arises.**
- `GetDefaultData()` sets `EffectInfo = new DisplayEffectInfo()` when the ENE model string is empty (`PHL/CDevice_PHLDisplay.cs:248-258`).
- `Reset` does the same (`:1998-2012`).
- `method_12` then copies it into the Tag (`:695`).

**Values.**
- `EffectList` is null.
- `EffectDetail` is the `?? new DisplayEffectDetailInfo()` fallback (`OPT/DisplayEffectInfo.cs:27,44-47`). Its defaults come from `ENT/BaseEffectDetailInfo.cs:9-36`: `EffectType.Off`, Speed 2, Brightness 2, rainbow false, `RGB.Red`.
  - `EffectList.ToList()` here is the null-safe `Zeasn.Com.Lib` extension (`COM/Extension.cs:29-48`; `System.Linq` is not imported in that file), so it does not throw.
- `CurrEffect` is `new EnumItem()`.

**UI form:**

```json
{"EffectList":null,"EffectDetail":{"Effect":{"Name":"Off","Text":"关闭","Value":0},"Speed":2,"Brightness":2,"IsRandomColor":false,"IsRainbowColor":false,"CurRGB":{"R":255,"G":0,"B":0},"BgRGB":{"R":0,"G":0,"B":0},"CurDir":-1,"CurRegion":0,"CurStarCount":1},"EffectEnable":true,"CurrEffect":{"Name":null,"Text":null,"Value":0}}
```

**Renderer effect.** `saveMonitorData` survives this: `CurrEffect.Value` = 0, and `EffectList?.map(...) || []` gives `[]` (`R/styles-DAnQi2A8.js:9429-9441`). A port that returns `EffectInfo:null` instead would crash it at `e.EffectInfo.CurrEffect`.

### 6.5 `DisplayFuncConstraints`, all 26 `FuncItems` in constructor order, user's current state — 1788 bytes, sha256 `dd5eea9268eabc7929cd62bcd890bb9c56c8ecd6960d13a7f01db143fd4a2384`

**Construction.**
- Constructor order: `OPT/DisplayFuncConstraints.cs:64-92`.
- `FuncId = e.GetHashCode()` and `FuncName = e.ToString()` (`OPT/FuncContraintItem.cs:59-67`).
- The initial state after construction is every `State:1`, with `"ModuleGameMode":1,"AudioEQ":1`.

**State evaluated by `RecheckFuncConstraints`** (`:125-294`):
- `pip = false` (A5 = 0)
- `hdr = true`
- `hz = 175`
- `ScreenSaver = 2 ≠ 0`, so `ss = true`
- `sniper = false` (HDR)
- `AdaptiveSync = 1`, so `async = true`
- `mbr` and `mbrSync` false (unavailable)
- DC = 33
- Ambiglow mode 7 (Static, after the 0→7 rewrite)

**Result.** Disabled (2): SmartContrast, DLBL, MBR, StarkShadowBoost, ShadowBoost, SharpShooter_Size, SmartFrame, AmbiglowLightSpeed, AudioSource. This matches the expectation in report 06 §8.
- `OP_DA_ScanMode` is **1**: 0x86 = 2 (MaxImage) ≠ 1, and the rule is "disabled when 86 == NoScaling" (`:281-288`; see §8).
- `EXT_OP_E2A0_1E_AmbiglowLightDirection` is 1 (Static mode), even though the monitor does not support 0x1E.

```json
{"FuncItems":[{"FuncId":16,"FuncName":"OP_10_Luminance","State":1},{"FuncId":18,"FuncName":"OP_12_Contrast","State":1},{"FuncId":240,"FuncName":"OP_F0_SmartContrast","State":2},{"FuncId":14852128,"FuncName":"EXT_OP_E2A0_20_ColorSpace","State":1},{"FuncId":20,"FuncName":"OP_14_SelectColorPreset","State":1},{"FuncId":14852132,"FuncName":"EXT_OP_E2A0_24_DLBL","State":2},{"FuncId":14852160,"FuncName":"EXT_OP_E2A0_40_AdaptiveSync","State":1},{"FuncId":14852098,"FuncName":"EXT_OP_E2A0_02_MBR","State":2},{"FuncId":14852099,"FuncName":"EXT_OP_E2A0_03_MBRSync","State":1},{"FuncId":14852100,"FuncName":"EXT_OP_E2A0_04_SmartCrosshair","State":1},{"FuncId":14852164,"FuncName":"EXT_OP_E2A0_44_StarkShadowBoost","State":2},{"FuncId":14852165,"FuncName":"EXT_OP_E2A0_45_ShadowBoost","State":2},{"FuncId":14852102,"FuncName":"EXT_OP_E2A0_06_SharpShooter_Size","State":2},{"FuncId":14852103,"FuncName":"EXT_OP_E2A0_07_LowInputLag","State":1},{"FuncId":235,"FuncName":"OP_EB_SmartResponse","State":1},{"FuncId":14852172,"FuncName":"EXT_OP_E2A0_4C_Overclock","State":1},{"FuncId":14852104,"FuncName":"EXT_OP_E2A0_08_SmartFrame","State":2},{"FuncId":14852122,"FuncName":"EXT_OP_E2A0_1A_AmbiglowColors","State":1},{"FuncId":14852123,"FuncName":"EXT_OP_E2A0_1B_AmbiglowLightPosition","State":1},{"FuncId":14852124,"FuncName":"EXT_OP_E2A0_1C_AmbiglowLightBrightness","State":1},{"FuncId":14852125,"FuncName":"EXT_OP_E2A0_1D_AmbiglowLightSpeed","State":2},{"FuncId":14852126,"FuncName":"EXT_OP_E2A0_1E_AmbiglowLightDirection","State":1},{"FuncId":224,"FuncName":"OP_E0_AudioSource","State":2},{"FuncId":134,"FuncName":"OP_86_DisplayScaling","State":1},{"FuncId":84,"FuncName":"OP_54_PerformancePreservation","State":1},{"FuncId":218,"FuncName":"OP_DA_ScanMode","State":1}],"ModuleGameMode":1,"AudioEQ":1}
```

### 6.6 `EffectColorData` default (`Effect_GetColorData`) — 339 bytes, sha256 `254b126c5d724a942b509f19adbfbbb507cdd266a3a2768e9f87ccc66527fa1b`

**When it is returned.** `CORE/SystemOper.cs:1351-1363` loads `Config/color.data`. `LoadTXTConfig` sets `obj = null` when the file is missing or empty (`COM/SerializedFileUtil.cs:151-154`), and the handler then returns `DefData()`. The user has no `color.data` (CONFIRMED: `EvniaServe/Config` holds only `SoftConfig.data` and `data.json`), so this default is what the user's UI receives.

**Contents.**
- `DefColors` (public field, so it serializes first) holds 13 colours (`ENT/EffectColorData.cs:28-48`).
- `SelfColors` defaults to `""` (`:12`).
- `RGB` serializes only `R,G,B` (`COM/RGB.cs`); the static `Red/Green/Blue/Black` are not serialized.

```json
{"DefColors":[{"R":255,"G":255,"B":255},{"R":255,"G":0,"B":0},{"R":255,"G":0,"B":127},{"R":127,"G":0,"B":127},{"R":127,"G":0,"B":255},{"R":0,"G":0,"B":255},{"R":0,"G":127,"B":255},{"R":0,"G":255,"B":255},{"R":0,"G":255,"B":127},{"R":0,"G":255,"B":0},{"R":127,"G":255,"B":0},{"R":255,"G":255,"B":0},{"R":255,"G":127,"B":0}],"SelfColors":""}
```

---

## 7. (f) Renderer places that compare or key on a ValueList `Name` or `Text`

### 7.1 Normalizers (`R/styles-DAnQi2A8.js`, CONFIRMED)

- **`Qu`** (`:9046-9056`) turns an attribute into a switch:
  - `On` = the `Value` of the `ValueList` entry whose **`Name.toUpperCase()==="ON"`** (default 1);
  - `Off` = the entry whose name upper-cases to `"OFF"` (default 0);
  - `Value = (raw === On)`, `Support = err_code === 0`.
  - `Qu` runs on the **raw** backend object (capital `Name`).
- **`$u`/`Xu`** (`:9057-9076`) map to `{name,text,value}`. Names starting with `Num_` are rewritten:
  - split on `_`; take part 1, then add `.` + part 2 when present;
  - so `Num_1_5`→`"1.5"`, `Num_1_0`→`"1.0"`, `Num_7`→`"7"`.
  - `null` becomes `[]`.
- **`rd`** (`:9297-9314`):
  - `InputSourceList`, `PIPLocationList` and `PIPPBPSourceList` become `{name,text,value}` (no `Num_` rewrite);
  - objects with a `ValueList` key go through `Xu`;
  - objects with only `err_code` get `Support`;
  - the rest is copied.
- **Other normalizers.**
  - `saveMonitorData` (`:9401-9463`) keeps `Items` **raw** (capital `Name`). It maps `EffectInfo.EffectList` to `{name: Effect.Name, text: Effect.Text, value}`.
  - `updateMonitorEffectInfo` (`:9512-9521`) does the same mapping.

`Qu` results on the user's monitor (computed from §5):

| Attribute | ValueList names | On | Off | raw Value | `Value` (bool) | Support |
|---|---|---|---|---|---|---|
| `OP_F0_SmartContrast` | (null) | 1 | 0 | null | false | true |
| `EXT_OP_E2A0_40_AdaptiveSync` | OFF, ON | 1 | 0 | 1 | true | true |
| `EXT_OP_E2A0_03_MBRSync` | (null) | 1 | 0 | null | false | false |
| `EXT_OP_E2A0_07_LowInputLag` | OFF, ON | 1 | 0 | 0 | false | true |
| `EXT_OP_E2A0_4C_Overclock` | (null) | 1 | 0 | null | false | false |
| `EXT_OP_E2A0_08_SmartFrame` | OFF, ON | 1 | 0 | 0 | false | true |
| `OP_8D_AudioMute` | ON, OFF | 1 | 2 | 2 | false | true |
| `OP_ED_InputAuto` | OFF, ON | 1 | 0 | 1 | true | true |
| `OP_E9_ResolutionNotifier` | OFF, ON | 2 | 0 | 0 | false | true |
| `EXT_OP_E2A0_17_CEC` | OFF, ON | 1 | 0 | 0 | false | true |
| `EXT_OP_E2A0_36_PixelRefresh` | OFF, ON | 1 | 0 | 0 | false | true |
| `EXT_OP_E2A0_61_AutoPixelRefresh` | (null) | 1 | 0 | null | false | false |
| `EXT_OP_E2A0_37_PanelRefresh` | (null) | 1 | 0 | null | false | false |
| `EXT_OP_E2A0_43_AutoWarning` | OFF, ON | 1 | 0 | 1 | true | true |
| `EXT_OP_E2A0_47_UniBright` | (null) | 1 | 0 | null | false | false |
| `EXT_OP_E2A0_4B_ThermalProtection` | (null) | 1 | 0 | null | false | false |
| `EXT_OP_E2A0_16_SmartPower` | OFF, ON | 1 | 0 | 0 | false | true |
| `EXT_OP_E2A0_13_USB_StandbyMode` | OFF, ON | 1 | 0 | 1 | true | true |
| `OP_54_PerformancePreservation` | ON, OFF | 0 | 1 | 2 | false | true |
| `OP_DA_ScanMode` | OFF, ON | 2 | 0 | 2 | true | true |

### 7.2 Components that turn a `name` into display text (CONFIRMED)

**The components.** They render `$t(option.name)` by default (`i18n` prop default `true`):
- `Select` (`R/main-CDosWiM3.js:2608-2866`, selected label `:2757`, list `:2866`);
- `Radio` (`:3185`);
- `Cascader` (`:3722`, `:3794`);
- `Menu` (`R/Menu-DxkEEx1J.js:79`);
- `Checkbox` label (`R/directive-B2r732H0.js:289-330`);
- `Equalizer` band label (`R/Equalizer-bwdWX0U6.js:98`).

**Lookup.** `$t` = `dh` (`R/styles-DAnQi2A8.js:29389-29398`). It looks up the **current language only**, with no English fallback, and returns the **key itself** when missing.
- The dictionary is `ah` (`:14295-29380`): 10 languages (`en` at 14297 … `de` at 27846), each with the **same 1419 keys** (CONFIRMED by set comparison).
- A missing name therefore shows raw in every language.
- A packaged app may override the dictionary with `patchPath/translation.json` (`:29399-29421`).

### 7.3 Inventory of Name/Text-keyed logic (CONFIRMED; line = `R/<file>:<line>`)

| # | Where | What is compared or keyed | Names/Texts involved | On the user's monitor |
|---|---|---|---|---|
| 1 | `styles-DAnQi2A8.js:9050-9051` `Qu` | `Name.toUpperCase()` = `ON`/`OFF` | `SwitchFlag_E`, `VCP_8D_AudioMute`, `VCP_E9_ResolutionNotifier`, `VCP_54_PixelOrbiting`, `VCP_DA_ScanMode` | table §7.1; 0x54 on=0/off=1; 0xE9 on=2; 0xDA on=2 |
| 2 | `styles-DAnQi2A8.js:9071` `Xu` | `Name.startsWith("Num_")` → numeric label | `Num_0_E`, `Num_Off_E`, `E2A0_06_SharpShooterSize_E` | E2A006 `OFF/1.0/1.5/2.0`; E2A009 `1..7`; E2A010 `OFF/1..4` |
| 3 | `styles-DAnQi2A8.js:9391-9394` `ambiglowTitle` | E2A019 list has `name==="FollowVideo"` → "Ambiglow", else "Halolight" | `E2A0_19_AmbiglowLightMode_E` | "Ambiglow" |
| 4 | `SmartImage-DuKfuYFN.js:47,49,205` | `Items[].Name` → Menu `$t(name)`; active name `F` | `SmartImage_E1..E4` | HDR state: `Items` is `[]`, so the page is unused (the shell routes to SmartImageHDR, `Monitor-D4qz4RBn.js:50-56`) |
| 5 | `SmartImage-DuKfuYFN.js:50-67` | `F ∈` 14 names → show `$t(F)`, `$t(F+"_Desc")`, class `image-${F}` (`:499-500`) | SmartImage_Standard, FPS, Movie, Game1, Game2, Racing, RTS, Economy, LowBlueMode, EasyRead, SmartUniformity, ConsoleMode, IllustratorMode, DMode | all 12 SDR names of the user are in the list; all `_Desc` keys exist; CSS `image-*` exist (`SmartImage-BiPfGjmi.css`) |
| 6 | `SmartImage-DuKfuYFN.js:76` | settings hidden when `F === "SmartImage_Off"` | `SmartImage_E2`/`E4` `SmartImage_Off` | never: 0x10 not in caps |
| 7 | `SmartImage-DuKfuYFN.js:168-173` | ColorSpace list of length 2 with **`text === "sRGB"`** → sRGB switch | `E2A0_20_ColorSpace_E.sRGB` Text | 4 entries, so a Select is shown |
| 8 | `SmartImage-DuKfuYFN.js:134,411` | R/G/B sliders when preset name `=== "Preset_UserRGB"` | `VCP_14_SelectColorPreset` | available in SDR |
| 9 | `SmartImage-DuKfuYFN.js:528` | `$t("ResetRemind", $t(F))` | SmartImage names | keys exist |
| 10 | `SmartImageHDR-BQ1gioFP.js:47-53` | `Items[].Name`; `DisplayHDRXXXX` → `getTranslation("DisplayHDRXXXX") + " " + configInJson.HDR` | `SmartImageHDR_E` | user list has no 38 |
| 11 | `SmartImageHDR-BQ1gioFP.js:56-67` | name ∈ {HDROff, HDRGame, HDRMovie, HDRPeak, HDRPhoto, HDRVivid, HDRPersonal, HDRTrueBlack, DisplayHDRXXXX} → title, `_Desc`, `image-` (`:270-273`) | `SmartImageHDR_E` | all 7 user names are covered |
| 12 | `SmartImageHDR-BQ1gioFP.js:78-84` | sliders hidden for `HDROff`, `HDRTrueBlack`, `DisplayHDRXXXX` | `SmartImageHDR_E` | HDRGame (current) shows the sliders |
| 13 | `GameMode-C1cXG-_T.js:392` | SharpShooter size **`text.toLocaleLowerCase() === "off"`** disables Location | `E2A0_06_SharpShooterSize_E.OFF` Text "Off" | E2A025 n/a |
| 14 | `GameMode-C1cXG-_T.js:305-306` | SmartFrame size: ValueList **values** only | `Num_0_E` | `[1..7]` |
| 15 | `useMonitorPropertyHandler-BOOFue3H.js:70-80,118-125` | PropertyRenderer Select `options = ValueList` (Xu names) → `$t(name)` | all GameMode/System/Setup select lists | see §7.4 |
| 16 | `useMonitorPropertyHandler-BOOFue3H.js:239-244` | switch writes `On`/`Off` from `Qu` | as #1 | — |
| 17 | `System-DT9nKs1q.js:349-352` | A5 options: drop value 0; icon by **name** `PIPPBP__PIP`→`pip`, `PIPPBP__PBP_1`→`pbp` | `VCP_A5_PIPPBPType_*_E` | PIP and PBP both get icons |
| 18 | `System-DT9nKs1q.js:354-363` | Window A/B, size and location options = `InputSourceList`, `PIPPBPSourceList`, EC `ValueList`, `PIPLocationList` → `$t(name)` | `VCP_60_InputSource`, `VCP_EC_PIP_Size`, `VCP_EC_PIP_Location` | keys exist |
| 19 | `System-DT9nKs1q.js:411-431` | 0x86 names split into "aspect" (`Scaling_NoScaling, _Aspect, _Aspect_4to3, _Full_16to9, _1to1_16to9, _Full_Square, _1to1_Square, _24_5, _27`) vs "screen sizes"; special case: exactly `[Scaling_MaxImage]` + `[Scaling_Aspect]` → Radio "PictureFormat" | `VCP_86_DisplayScaling` | aspect = [NoScaling, Aspect_4to3]; sizes = the 10 `Scaling_NN[_5][_W]` |
| 20 | `System-DT9nKs1q.js:433` + `styles-DAnQi2A8.js:13367-13374` `xm` | sizes sorted **descending by the numeric parts of the name** (`Scaling_18_5_W`→18.5) | `VCP_86_DisplayScaling` | 27_W, 24_W, 23_W, 22_W, 21_5_W, 20_W, 19_5_W, 19, 19_W, 18_5_W (19/19_W tie) |
| 21 | `System-DT9nKs1q.js:434, 652-700` | current 0x86 value 2 is in neither list, so the "ScreenSize" checkbox is checked with an empty placeholder | — | UI quirk; Checkbox `$t(e.name)` for the aspect names |
| 22 | `System-DT9nKs1q.js:436-437` | `OP_DA_ScanMode`/`OP_54_*` disabled via `optionControl[FuncName]` | FuncName = `StandardVCPOpCode_E` names | both enabled |
| 23 | `Setup-D-5j4V-I.js:318-330` | option label = `value.toString()` for `OP_F2_PowerLED`; **`text`** for `OP_CC_OSDLanguage`; otherwise `name` | `VCP_F2_PowerLED`, `VCP_CC_OSDLanguage` | PowerLED shows `0..4`; languages show native `Text` |
| 24 | `Audio-C89vcIta.js:58-81` | AudioMode names ending in **`BASS`** are grouped under the base name; the children are shown as `"BASS+"` / `"DTS"` (raw, no keys) | `E2A0_00_AudioMode_E` | no BASS entries, so a flat list of 6 |
| 25 | `Audio-C89vcIta.js:90, 113-116` | E0 options → `$t(name)`; `EQItems[].Name` → Equalizer `$t(name)` | `VCP_E0_AudioSourceSelect`, `E2A0_01_AudioEQ_E` | keys exist |
| 26 | `InputSource-DfTEOTzT.js:35-51,109` | icon map keyed by `Normal_*` name; tile label `$t(name)` | `VCP_60_InputSource` | DP1 `input_dp`, HDMI1/2 `input_hdmi`, USB-C1 `input_usbc` |
| 27 | `Ambiglow-Dvqon39u.js:1075, 904, 1164` | mode Select (`$t(name)`); current mode **name** `Se` drives the preview | `E2A0_19_*` (DDC) or `EffectType` (ENE `EffectList`) | 7 DDC names |
| 28 | `Ambiglow-Dvqon39u.js:163-185, 319-338` | preview `switch(effect)`: `Breathing`/`ColorBreathing`, `StarryNight`, `Static`/`StaticMode`, `ColorShift`, `ColorWave`, `FollowVideo`, `FollowAudio` | both enums; `ColorFlow`/`ColorFlowReverse` fall to `default` (no preview) | covered |
| 29 | `Ambiglow-Dvqon39u.js:131, 162, 968, 537, 563` | position names `AllZones`/`FourSided`/`ThirdSidedA` (edge LEDs) and `AllZones`/`Central` (centre LEDs); default `"AllZones"` | `E2A0_1B_*` / `RegionType` | `Bottom` lights neither group (INFERRED preview gap) |
| 30 | `Ambiglow-Dvqon39u.js:993-1006, 1080-1083` | DDC colours: **name → hex** map `sa` (White…Orange); `Rainbow` kept as name | `E2A0_1A_AmbiglowColors_E` (exact names required) | 14 swatches |
| 31 | `Ambiglow-Dvqon39u.js:1205-1226, 1292, 1524` | `name === "Rainbow"` → rainbow preview class | `E2A0_1A_*` | — |
| 32 | `Ambiglow-Dvqon39u.js:1095-1114` | brightness and speed marks by **list position**: `["Bright","Brighter","Brightest"]` / `["Low","Normal","High"]`, not by name | `E2A0_1C/1D` | 3 each |
| 33 | `Ambiglow-Dvqon39u.js:1039, 1383-1415` | ENE path `RegionList[].Name` → position Select | `RegionType` | — (no ENE) |
| 34 | `styles-DAnQi2A8.js:33409-33530` (About/Device card) | BasicInfo values rendered as `$t(value)` (`:33517`). Values are names from `PHL/PHLDisplay_Oper.cs:25-102` (`method_3` E2A019 `Name` or `EffectInfo.CurrEffect.Name`; `method_4` SDR `Items` Name; `method_5` `InputSourceList` Name; `"On"`/`"Off"`/`"/"`) | `E2A0_19_*`, `EffectType`, `SmartImage_*`, `VCP_60_InputSource` | `StaticMode`→"Static Mode", `Normal_DisplayPort1`→"DisplayPort 1", SmartImage `"/"` (HDR), LightSync `"Off"`, AdaptiveSync `"On"` |
| 35 | `main-CDosWiM3.js:1834-1841` | constraints keyed by `FuncId` **and** `FuncName` (enum names) | `StandardVCPOpCode_E`/`E2A0_ExternVCPOpCode_E` | §6.5 |

### 7.4 i18n coverage (CONFIRMED against `R/styles-DAnQi2A8.js:14295-29380`; same result in all 10 languages)

**User-reachable names.** Every `Name` in the user's lists that reaches a translating component has a key:
- DC: 19/19;
- 0x14: 9/9; 0x72: 5/5; E2A020: 4/4; E2A024: 5/5;
- 0x60 lists: 8/8; EC: 3/3; `PIPLocationList`: 4/4; A5: `PIPPBP__PIP`/`PIPPBP__PBP_1`;
- E2A000: 6/6; E0: 4/4; `EQ_*`: 5/5;
- E2A004, E2A044, E2A011, E2A012, E2A015, 0x86 (12/12), E2A034, E2A035, E2A041;
- E2A019: 7/7; E2A01B: 4/4;
- `ON`/`OFF` (`:15694-15695`).

Examples of en lines: `HDRGame` 14806, `Normal_DisplayPort1` 14616, `Scaling_19_W` 14682, `StaticMode` 14574, `Time_20` 14670, `KVM_Status_Auto` 14692.

Also present:
- the `_Desc` keys for all 12 SDR and 7 HDR names (for example `SmartImage_Standard_Desc` 14769, `HDRGame_Desc` 14885);
- `ResetRemind` 15472.

**Shown raw on the user's monitor (by design, no key):**
- E2A006 `"1.0"`, `"1.5"`, `"2.0"`; E2A009 `"1"`–`"7"` (values only, not shown as text); E2A010 `"1"`–`"4"`;
- PowerLED `"0"`–`"4"` (from the value);
- OSD language native `Text` (`English`, `Français`, `繁体中文`, …);
- dashboard `"/"`, `3440x1440`, `175Hz`.

**Not translated but not displayed as text:** `PIPPBP__OFF` (filtered out) and the `E2A0_1A` colour names (only `Red`, `Blue`, `Aqua`, `Green` and `Pear` have keys; colours are rendered as swatches).

**Label surprises (keys exist, but the text differs from the enum `Text`):**
- `HDRPhoto` → "HDR Vivid" (en `:14808`);
- `HDROff` → "Off";
- `HDRPersonal` → "Personal";
- `Preset_USER2`/`Preset_USER3` → "Preset" (`:14598-14599`);
- `Preset_UserRGB` → "R.G.B. Settings";
- `Preset_Native` → "Native";
- `Scaling_NoScaling` → "1:1";
- `Scaling_Aspect_4to3` → "4:3";
- `SmartImage_IllustratorMode` → "Illustrator".

**Names with no key anywhere** (would show raw on other monitors that expose them):

| Enum | Names without an i18n key |
|---|---|
| `SmartImage_E1`/`E3`/`E4` | `SmartImage_Games`, `SmartImage_Level1`, `SmartImage_Video`, `SmartImage_sRGBImage`, `SmartImage_CliniaclDImage` (and no `_Desc` for `SmartImage_Office`, `_Photo`, `_Internet`, `_Text`, `_XBoxMode`, `_Off`, which are not in the `_Desc` list anyway) |
| `SmartImageHDR_E` | none (every name has a key; `_Desc` exists only for Off, Game, Movie, Photo, Vivid, Personal, TrueBlack, Peak, DisplayHDRXXXX) |
| `E2A0_20_ColorSpace_E` | `Rec2020`, `Rec709`, `D_mode`, `REC2020_HDR`, `DCI_P3_HDR`, `AutoGamut`, `MultiColorSync` |
| `E2A0_59_DualResolution_E` | `FHD240HZ`, `QHD200Hz`, `QHD230Hz`, `QHD275Hz`, `HD280Hz`, `HD500Hz`, `HD540Hz` |
| `E2A0_19_AmbiglowLightMode_E` | `ColorFlow`, `ColorFlowReverse` |
| `E2A0_1E_AmbiglowLightDirection_E` | `RtoL`, `LtoR` |
| `VCP_E0_AudioSourceSelect` | `AudioSource_PCIn`, `AudioSource_Thunderbolt2` |
| `E2A0_HDMIRefreshRate_E` | `RefreshRate_4K`, `RefreshRate_5K`, `RefreshRate_340Hz`, `RefreshRate_1000Hz` |
| `VCP_86_DisplayScaling` | `Scaling_16_9`, `Scaling_Movie1`, `Scaling_Movie2` |
| `VCP_A5_PIPPBPType_*` | `PIPPBP__PBP_2`, `PIPPBP__PBP_3` (`PIPPBP__OFF` is filtered) |
| `E2A0_6B_Profile_E` | `Profile1`, `Profile2` (no UI consumer) |
| `EffectType` | `Blink` (peripheral) |
| `DirectionType` | `LeftOrBotton`, `RightOrTop` (peripheral) |

**Port implications:**
1. The backend must emit the exact `Name`s of §2, including typos such as `AdboeRGB` and `SmartImage_CliniaclDImage`, and the capitalisation of `FHD240HZ`. They are i18n keys, CSS class suffixes and logic keys.
2. Do not "fix" `Text`. It is used as a key in exactly two places: `text==="sRGB"` (#7) and `text.toLowerCase()==="off"` (#13). Otherwise it is displayed only for OSD languages (#23).
3. For the missing keys above, add them to the patched renderer dictionary if other monitors are ever supported. The 34M2C8600 needs none.

---

## 8. Corrections to earlier reports

1. **Report 12 §3.5, row `0xDA ScanMode`: inverted.**
   - Report 12 says the item is disabled ("2") *unless* 0x86 is enabled, available and equal to 1.
   - The code (`OPT/DisplayFuncConstraints.cs:281-288`) sets `State=2` **when** the 0x86 item state is 1, 0x86 is available **and** 0x86 == `Scaling_NoScaling` (1). Otherwise it sets 1.
   - Reports 03 §3.4 and 06 §8 state it correctly. For the user (0x86 = 2) ScanMode is **enabled** (§6.5).
2. **Report 12 §3.6: "DisplayEffectInfo.Default … byte-identical to the stored profile (verified by script; Appendix D.3)" is false.**
   - The stored `EffectInfo` has `CurrEffect`/`EffectDetail` = FollowVideo. The default has Static (§6.3 diff).
   - Only `EffectList` and `EffectEnable` coincide.
   - Appendix D.3 never existed.
3. **Report 12 §3.3 step 5 (DualResolution): missing guard.**
   - Trimming by `raw>>8` happens only when `EXT_OP_E2A0_4C_Overclock.IsAvailable` (`PHL/CDevice_PHLDisplay.cs:365`). If Overclock is unsupported the list is left untouched.
   - The attribute is **cloned** before trimming (`:355`), so the shared global list is not mutated.
4. **Report 12 §3.3 step 6 / §3.1: `EffectInfo`.**
   - `method_4` sets it to `null` without ENE, but that value is transient: `method_12` replaces it with the stored profile's `EffectInfo` (`:695`).
   - On a fresh install or after `Profile_Reset` without ENE, the value is `new DisplayEffectInfo()` (`:255-258`, `:2009`), not `null` (§6.4).
5. **Report 12 §3.1: `EXT_OP_E2A0_44_StarkShadowBoost | Level_Off_E (INFERRED)`.** This is CONFIRMED (`PBASE/DataOSD.cs:372-376`, shared with E2A024/45/68).
6. **Report 12 references Appendices A, B, C and D.1 to D.6 as present. None exist.** This report supplies:
   - C as §2;
   - D.1 as §6.1;
   - D.2 as §6.2;
   - D.3 as §6.3;
   - D.4 as §6.5, with states for the current state as well as the constructor order;
   - D.6 as §6.6.
   **Still missing:** A and B (class member tables) and D.5 (`Macro_GetFuncMenu` JSON, which the renderer requests at start-up even with only a monitor: `LOG26:1017`).
7. **Report 06 §6.2, row `20_ColorSpace`: names.** The real member names are `AdboeRGB` (value 3, Text `"Adboe RGB"`) and `AdboeRGB_D50` (12, Text `"Adoby RGB(D50)"`), not "AdobeRGB". `DCI_P3` has Text `"DCI - P3"`. The renderer i18n key `AdboeRGB` exists ("Adobe RGB").
8. **Report 06 §6.3, `SmartImage_E4`: names and texts.** Value 5 is `SmartImage_sRGBImage` (Text "sRGB Image"). Value 7 is `SmartImage_CliniaclDImage` (Text "Cliniacl D-Image", vendor typo).
9. **Report 06 §6.1, 0x86 "33/34 Movie1/2".** `Scaling_Movie2` (34) carries the Text **"Movie 1"** (vendor copy-paste). Value 10 `Scaling_SupportSmartSize` is Unbind, as stated.
10. **Report 06 §6.2, row `06_SharpShooter_Size`, "1 = 1.0".** The `Text` of `Num_1_0` is `"1"`. The UI shows `"1.0"` only because `Xu` rewrites the *name* (§7.1).
11. **Clarification, not an error: report 06 §5.7 lists maxima in hex, as its header says.** The decimal values that end up in `MaxValue` are:
    - 0x60: `3616` = **13846**;
    - 0xDC: `35` = 53;
    - 0xA5: `200` = 512;
    - 0xCC: `24` = 36;
    - 0x86: `23` = 35;
    - E2A01A: `0d` = 13;
    - E2A039: `10` = 16.

    A port that replays the log must convert them.

---

## 9. Open questions

1. **No wire capture of `Profile_GetDeviceData`.** The full Tag (§5) is validated only through its profile projection. A single capture of the hub reply would confirm `MaxValue` placement and the A5 `ValueList` replacement end to end. The notification is logged as "exceeds the print limit" (`LOG26:996`).
2. **`OP_54_PerformancePreservation` reads 2** while its only enum values are ON=0 and OFF=1 (caps `54(00 01)`). The UI switch therefore shows Off and writes 0 or 1. What 2 means on the 34M2C8600 is still unverified (report 03 open question 4).
3. **`OP_DA_ScanMode` reads 2 = `ON` "Overscan".** The OverScan switch shows **on** for the user. Verify on hardware that 0xDA = 2 really means overscan on this panel.
4. **DC maximum 53 and 0x86 current value 2.** The DC max (0x35) and the 0x86 value (`Scaling_MaxImage`, absent from caps) come from the monitor. The System page then shows no selected screen-size or aspect option (§7.3 #21). Is this how the Windows app looks on the user's machine?
5. **Appendix D.5** (`Macro_GetFuncMenu`, `CORE/SystemOper.cs:2544-2851`) and **Appendices A and B** remain to be generated if a byte-compatible start-up is required. For a monitor-only port, `Macro_GetFuncMenu` is consumed only by the hidden peripheral pages (INFERRED).
6. **Preview gap for `Bottom`.** The monitor preview (`Ambiglow-Dvqon39u.js:131,162`) lights no LED group for position `Bottom` (value 3), which is in the user's list. Real hardware behaviour and the Windows UI appearance were not observed.

---

## 10. Cross-references

- Report 12 §2 (serializer modes, member order), §3 (object tree, load sequence), §3.5 (constraint rules, corrected here).
- Report 06 §4.8 (capability acquisition and cache), §5.7 (the read traffic used for values and maxima), §6 (VCP semantics).
- Report 03 §3 (store normalizers), §4 (pages). Open question 2 is answered by §1–§4 here; open question 7 is partly answered by §6.4.
- Report 09 (Ambiglow over ENE and DDC) for what the effect menu and effect info drive.
