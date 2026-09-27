// The Bridge catalog: every public `JsonResult` overload of Bridge.Lib.Bridge, frozen as data.
//
// Source: work/dotnet-clean/Bridge.Lib/Bridge.Lib/Bridge.cs (163 public static methods: these 162 plus
// `void A_Notification(Notification)`, which sits in Class0's method table but can never be matched by
// JSON arguments — 20-backend-host-tail §1.2 — and is therefore not part of the RPC surface).
// Order, index, Bridge.cs line, C# parameter names and types are the declaration's; the disposition and
// renderer columns are 20-backend-host-tail §3 (the table was cross-checked row by row against Bridge.cs).
//
// Every overload is owned by exactly one api/ module family (the port's module split):
//   system   Start                                                          api/system.ts
//   monitor  PHL_*, SetGamePQ, Device_*, Profile_*, DisplayFW_*               api/{phl,device,profile,displayfw}.ts
//   theme    Theme_*, Macro_*, Setting_*, FactoryReset, Comm_GenAppIcon       api/{theme,macro,setting}.ts
//   ambiglow Effect_*, SyncEffect_*, AmbiScape_EnableFollowVideo              api/{effect,sync-effect}.ts
//   stubs    everything else (peripherals, DTS, FancyZones, Wi-Fi, pairing)  api/stubs.ts
//
// The helpers below audit a set of registrations (a RecordingRegistry, a list, or a live RpcDispatcher)
// against the catalog: which overloads are missing, which registrations are not Bridge overloads at all
// (unknown name or wrong signature), and which were registered more than once. The renderer's argument
// types select the overload (Class0.method_2), so a registration whose signature differs from Bridge.cs
// changes the vendor's "params error" behaviour and is reported as extra + missing.

import type { RpcArgType, RpcHandler, RpcRegistry, SerializeMode } from '../types.ts';

/** Module family that implements an overload (see the header). */
export type ApiOwner = 'system' | 'monitor' | 'theme' | 'ambiglow' | 'stubs';

/**
 * Port disposition (20-backend-host-tail §3): I = implemented, S = static stub (err_code 0),
 * E = error reply (err_code 9, vendor text). Identical to §3 except `GetWifiList`, which the port answers
 * with an empty list (S) instead of §3's "not supported" error: an empty `List<WifiItem>` is what the vendor
 * itself returns on a host without Wi-Fi networks, the renderer's wrapper calls `.filter` on the Tag
 * (styles-DAnQi2A8.js:29943-29951), and the port must never read host Wi-Fi data (the vendor leaked the saved
 * Wi-Fi keys through `netsh wlan show profile key=clear`, SystemOper.cs:316-370).
 */
export type Disposition = 'I' | 'S' | 'E';

/** Whether a renderer chunk calls the function (02 §5 grep): 'hidden' = only from pages the port hides. */
export type RendererUse = 'yes' | 'hidden' | 'no';

export interface BridgeOverload {
  /** 1-based position in Bridge.cs (the `#` column of 20-backend-host-tail §3). */
  readonly index: number;
  readonly name: string;
  /** Exact C# parameter types, in order (Class0 matches them positionally, no widening or defaults). */
  readonly signature: readonly RpcArgType[];
  /** C# parameter names, for documentation and error messages. */
  readonly params: readonly string[];
  /** Line of the declaration in Bridge.cs. */
  readonly line: number;
  readonly owner: ApiOwner;
  readonly disposition: Disposition;
  readonly renderer: RendererUse;
}

function o(
  index: number,
  name: string,
  signature: RpcArgType[],
  params: string[],
  line: number,
  owner: ApiOwner,
  disposition: Disposition,
  renderer: RendererUse,
): BridgeOverload {
  return Object.freeze({
    index,
    name,
    signature: Object.freeze(signature),
    params: Object.freeze(params),
    line,
    owner,
    disposition,
    renderer,
  });
}

/** All 162 Bridge overloads in declaration order. */
export const BRIDGE_OVERLOADS: readonly BridgeOverload[] = Object.freeze([
  o(1, 'Start', [], [], 13, 'system', 'I', 'yes'),
  o(2, 'FactoryReset', [], [], 18, 'theme', 'I', 'yes'),
  o(3, 'Setting_GlobalData', [], [], 23, 'theme', 'I', 'yes'),
  o(4, 'Setting_TurnOffLightsWhenIdle', ['bool'], ['enable'], 28, 'theme', 'I', 'yes'),
  o(5, 'Setting_TurnOffLightsWhenIdleDuration', ['int'], ['duration'], 34, 'theme', 'I', 'yes'),
  o(6, 'GetWifiList', [], [], 44, 'stubs', 'S', 'hidden'), // §3 says E; see Disposition
  o(7, 'AmbiScape_EnableFollowVideo', ['bool', 'int'], ['enable', 'timeInterval'], 49, 'ambiglow', 'S', 'hidden'),
  o(8, 'Button_GetFuncMenu', ['int'], ['device'], 54, 'stubs', 'E', 'hidden'),
  o(9, 'Button_GetStaticData', ['int'], ['device'], 59, 'stubs', 'E', 'no'),
  o(10, 'Button_SetFunc', ['int', 'int', 'int', 'int', 'int', 'string', 'string'], ['device', 'layer', 'buttonId', 'newMenu', 'newFun', 'value', 'ext'], 64, 'stubs', 'E', 'hidden'),
  o(11, 'Button_SetKeyboard', ['int', 'int', 'int', 'int', 'int', 'int', 'int', 'int'], ['device', 'layer', 'buttonId', 'subMenu', 'newFun', 'modify1', 'modify2', 'modify3'], 69, 'stubs', 'E', 'hidden'),
  o(12, 'Button_SetMacro', ['int', 'int', 'int', 'string', 'int', 'int'], ['device', 'layer', 'buttonId', 'macroName', 'macroPlayType', 'macroPlayTimes'], 74, 'stubs', 'E', 'hidden'),
  o(13, 'Button_RestButtons', ['int', 'int'], ['device', 'layer'], 79, 'stubs', 'E', 'hidden'),
  o(14, 'Comm_GenAppIcon', ['string'], ['appApth'], 84, 'theme', 'S', 'yes'),
  o(15, 'ModifierKeyListenerEnable', ['bool'], ['isOn'], 89, 'stubs', 'S', 'no'),
  o(16, 'Device_GetConnectList', [], [], 94, 'monitor', 'I', 'yes'),
  o(17, 'Device_GetDeviceInfo', ['int'], ['device'], 99, 'monitor', 'I', 'hidden'),
  o(18, 'Device_UpgradeFw', ['int', 'string'], ['device', 'path'], 104, 'monitor', 'E', 'hidden'),
  o(19, 'GetPairDevices', [], [], 109, 'stubs', 'S', 'yes'),
  o(20, 'CanEnterPairing', ['int', 'string'], ['device', 'hidStr'], 114, 'stubs', 'E', 'hidden'),
  o(21, 'EnterPairing', ['int', 'string'], ['device', 'hidStr'], 119, 'stubs', 'E', 'hidden'),
  o(22, 'Device_Rescan', [], [], 124, 'monitor', 'I', 'yes'),
  o(23, 'Device_DetectionUSB', [], [], 129, 'monitor', 'I', 'yes'),
  o(24, 'Device_DetectionDisplay', [], [], 134, 'monitor', 'I', 'yes'),
  o(25, 'Device_OtherDeviceChange', [], [], 139, 'monitor', 'I', 'yes'),
  o(26, 'DeviceSteup_GetPowerInfo', ['int'], ['device'], 144, 'stubs', 'E', 'hidden'),
  o(27, 'DeviceSteup_GetBatteryCurrent', ['int'], ['device'], 149, 'stubs', 'E', 'hidden'),
  o(28, 'DeviceSteup_GetSetupMenu', ['int'], ['device'], 154, 'stubs', 'E', 'hidden'),
  o(29, 'DeviceSteup_GetSetupData', ['int'], ['device'], 159, 'stubs', 'E', 'hidden'),
  o(30, 'DeviceSteup_SwitchStartupEffect', ['int', 'bool'], ['device', 'isOn'], 164, 'stubs', 'E', 'hidden'),
  o(31, 'DeviceSteup_SetLowBetteryValue', ['int', 'int'], ['device', 'value'], 169, 'stubs', 'E', 'hidden'),
  o(32, 'DeviceSteup_SwitchLightSleep', ['int', 'bool'], ['device', 'isOn'], 174, 'stubs', 'E', 'hidden'),
  o(33, 'DeviceSteup_SetLightSleepTime', ['int', 'int'], ['device', 'time'], 179, 'stubs', 'E', 'hidden'),
  o(34, 'DeviceSteup_SwitchDeepSleep', ['int', 'bool'], ['device', 'isOn'], 184, 'stubs', 'E', 'hidden'),
  o(35, 'DeviceSteup_SetDeepSleepTime', ['int', 'int'], ['device', 'time'], 189, 'stubs', 'E', 'hidden'),
  o(36, 'DeviceSteup_LightEnable', ['int', 'bool'], ['device', 'enable'], 194, 'stubs', 'E', 'hidden'),
  o(37, 'PHL_Rescan', [], [], 199, 'monitor', 'I', 'no'),
  o(38, 'PHL_SwitchDisplay', ['string'], ['name'], 204, 'monitor', 'I', 'yes'),
  o(39, 'PHL_ReloadData', [], [], 209, 'monitor', 'I', 'yes'),
  o(40, 'PHL_SetOSD', ['string'], ['itemName'], 214, 'monitor', 'E', 'no'),
  o(41, 'PHL_SetOSD', ['string', 'int'], ['itemName', 'iValue'], 219, 'monitor', 'I', 'yes'),
  o(42, 'PHL_SetSmartImage', ['int'], ['iValue'], 224, 'monitor', 'I', 'yes'),
  o(43, 'PHL_ResetSmartImage', ['int'], ['iValue'], 229, 'monitor', 'I', 'yes'),
  o(44, 'PHL_SetColorPreset', ['int'], ['iValue'], 234, 'monitor', 'I', 'yes'),
  o(45, 'PHL_SwitchSmartFrame', ['int'], ['iValue'], 239, 'monitor', 'I', 'yes'),
  o(46, 'PHL_SetSmartFrameSize', ['int'], ['iValue'], 244, 'monitor', 'I', 'yes'),
  o(47, 'PHL_SetInputSource', ['int', 'int', 'int', 'int', 'int'], ['inputSource', 'pippbpSource', 'mode', 'size', 'location'], 249, 'monitor', 'I', 'yes'),
  o(48, 'PHL_SwrapPIPPBP', [], [], 254, 'monitor', 'I', 'yes'),
  o(49, 'PHL_SetAudioEQ', ['int', 'int'], ['index', 'iValue'], 259, 'monitor', 'I', 'yes'),
  o(50, 'PHL_GetConstraints', [], [], 264, 'monitor', 'I', 'yes'),
  o(51, 'SetGamePQ', ['int', 'bool', 'bool', 'bool', 'bool', 'bool', 'bool', 'bool'], ['iValue', 'IsShow', 'R', 'G', 'B', 'C', 'M', 'Y'], 269, 'monitor', 'S', 'no'),
  o(52, 'PHL_ProfileAction', ['int', 'int'], ['iValue', 'action'], 274, 'monitor', 'E', 'no'),
  o(53, 'PHL_GetHotKeyMenu', [], [], 279, 'monitor', 'S', 'no'),
  o(54, 'PHL_GetHotKeyData', [], [], 284, 'monitor', 'S', 'no'),
  o(55, 'PHL_SetHotKeyEnable', ['bool'], ['enable'], 289, 'monitor', 'S', 'no'),
  o(56, 'PHL_SetHotKeyItemEnable', ['string', 'bool'], ['func', 'enable'], 294, 'monitor', 'S', 'no'),
  o(57, 'PHL_SetHotKey', ['string', 'int', 'bool', 'bool', 'bool', 'bool', 'bool'], ['func', 'code', 'alt', 'ctrl', 'shift', 'win', 'bHotKeyExt'], 299, 'monitor', 'S', 'no'),
  o(58, 'PHL_DeleteHotKey', ['string'], ['func'], 304, 'monitor', 'S', 'no'),
  o(59, 'GetHotKeyState', ['int', 'bool', 'bool', 'bool', 'bool'], ['keyCode', 'alt', 'ctrl', 'shift', 'win'], 309, 'stubs', 'S', 'no'),
  o(60, 'PHL_EnableGamePQMouseKey', ['bool'], ['enable'], 314, 'monitor', 'S', 'no'),
  o(61, 'PHL_SetGamePQMouseKeyBind', ['int'], ['mouseButton'], 319, 'monitor', 'S', 'no'),
  o(62, 'DisplayFW_CheckUpstreamCable', [], [], 324, 'monitor', 'S', 'hidden'),
  o(63, 'DisplayFW_GetMonitorCount', [], [], 329, 'monitor', 'S', 'hidden'),
  o(64, 'DisplayFW_GetDeviceList', [], [], 334, 'monitor', 'S', 'yes'),
  o(65, 'DisplayFW_UpdateFirmversion', ['string', 'int', 'string'], ['scalerModelName', 'deviceType', 'fwFile'], 339, 'monitor', 'E', 'hidden'),
  o(66, 'DisplayFW_InstallDriver', ['string', 'string'], ['type', 'exePath'], 344, 'monitor', 'S', 'no'),
  o(67, 'DisplayFW_FWUpdateFailedNextTime', ['int'], ['flag'], 349, 'monitor', 'E', 'no'),
  o(68, 'DTS_Open', ['int'], ['device'], 354, 'stubs', 'E', 'no'),
  o(69, 'DTS_Close', ['int'], ['device'], 359, 'stubs', 'E', 'no'),
  o(70, 'DTS_SetAPO', ['int', 'bool'], ['device', 'enable'], 364, 'stubs', 'E', 'hidden'),
  o(71, 'DTS_SetRooms', ['int', 'int'], ['device', 'room'], 369, 'stubs', 'E', 'hidden'),
  o(72, 'DTS_SetStereoPreference', ['int', 'int'], ['device', 'stereoPreference'], 374, 'stubs', 'E', 'hidden'),
  o(73, 'DTS_SetBassTbhdx', ['int', 'bool'], ['device', 'enable'], 379, 'stubs', 'E', 'hidden'),
  o(74, 'DTS_SetDialogEnhancement', ['int', 'bool'], ['device', 'enable'], 384, 'stubs', 'E', 'hidden'),
  o(75, 'DTS_SetPreset', ['int', 'int'], ['device', 'presetMode'], 389, 'stubs', 'E', 'hidden'),
  o(76, 'DTS_SetGeqBandGain', ['int', 'string'], ['device', 'iValues'], 394, 'stubs', 'E', 'hidden'),
  o(77, 'DTS_GraphicEqRest', ['int'], ['device'], 399, 'stubs', 'E', 'hidden'),
  o(78, 'DTS_SaveGeqBandGain', ['int'], ['device'], 404, 'stubs', 'E', 'hidden'),
  o(79, 'Effect_CheckDynamicLightingEnabled', [], [], 409, 'ambiglow', 'S', 'yes'),
  o(80, 'Effect_OpenDynamicLightingSetting', [], [], 414, 'ambiglow', 'S', 'yes'),
  o(81, 'Effect_GetColorData', [], [], 419, 'ambiglow', 'I', 'yes'),
  o(82, 'Effect_SetSelfColors', ['string'], ['colors'], 424, 'ambiglow', 'I', 'yes'),
  o(83, 'Effect_GetMenu', ['int'], ['device'], 429, 'ambiglow', 'S', 'yes'),
  o(84, 'Effect_GetLEDs', ['int'], ['device'], 434, 'ambiglow', 'E', 'yes'),
  o(85, 'Effect_Enable', ['int', 'bool'], ['device', 'enable'], 439, 'ambiglow', 'I', 'yes'),
  o(86, 'Effect_Change', ['int', 'int'], ['device', 'effect'], 444, 'ambiglow', 'E', 'yes'),
  o(87, 'Effect_RandomEnable', ['int', 'bool'], ['device', 'isRandom'], 449, 'ambiglow', 'E', 'yes'),
  o(88, 'Effect_RainbowEnable', ['int', 'bool'], ['device', 'isRainbow'], 454, 'ambiglow', 'E', 'yes'),
  o(89, 'Effect_ColorChange', ['int', 'int', 'int', 'int'], ['device', 'r', 'g', 'b'], 459, 'ambiglow', 'E', 'yes'),
  o(90, 'Effect_BgColorChange', ['int', 'int', 'int', 'int'], ['device', 'r', 'g', 'b'], 464, 'ambiglow', 'E', 'no'),
  o(91, 'Effect_SpeedChange', ['int', 'int'], ['device', 'speed'], 469, 'ambiglow', 'E', 'yes'),
  o(92, 'Effect_BrightnessChange', ['int', 'int'], ['device', 'brightness'], 474, 'ambiglow', 'E', 'yes'),
  o(93, 'Effect_DirectionChange', ['int', 'int'], ['device', 'direction'], 479, 'ambiglow', 'E', 'yes'),
  o(94, 'Effect_RegionChange', ['int', 'int'], ['device', 'region'], 484, 'ambiglow', 'E', 'yes'),
  o(95, 'Effect_Reset', ['int'], ['device'], 489, 'ambiglow', 'I', 'yes'),
  o(96, 'SyncEffect_GetData', [], [], 494, 'ambiglow', 'I', 'yes'),
  o(97, 'SyncEffect_EnableDevice', ['int', 'string'], ['device', 'selDevices'], 499, 'ambiglow', 'E', 'yes'),
  o(98, 'FancyZones_Enable', ['bool'], ['enable'], 504, 'stubs', 'E', 'hidden'),
  o(99, 'FancyZones_StartEditor', [], [], 509, 'stubs', 'E', 'hidden'),
  o(100, 'FancyZones_GetVersion', [], [], 514, 'stubs', 'S', 'hidden'),
  o(101, 'FancyZones_GetData', [], [], 519, 'stubs', 'E', 'hidden'),
  o(102, 'FancyZones_SetSetting', ['string', 'string'], ['settingName', 'settingValue'], 524, 'stubs', 'E', 'hidden'),
  o(103, 'Keyboard_GetGameMode', ['int'], ['device'], 529, 'stubs', 'E', 'hidden'),
  o(104, 'Keyboard_SwitchGameMode', ['int', 'bool'], ['device', 'enable'], 534, 'stubs', 'E', 'hidden'),
  o(105, 'Keyboard_SetGameMode', ['int', 'int', 'bool'], ['device', 'gameModeType', 'status'], 539, 'stubs', 'E', 'hidden'),
  o(106, 'Keyboard_ResetGameMode', ['int'], ['device'], 544, 'stubs', 'E', 'hidden'),
  o(107, 'Macro_GetList', ['string'], ['themeName'], 549, 'theme', 'I', 'yes'),
  o(108, 'Macro_GetDetail', ['string', 'string'], ['themeName', 'name'], 554, 'theme', 'E', 'hidden'),
  o(109, 'Macro_GetDetail', ['string'], ['filePath'], 559, 'theme', 'E', 'hidden'),
  o(110, 'Macro_Add', ['string', 'string'], ['themeName', 'name'], 564, 'theme', 'E', 'hidden'),
  o(111, 'Macro_VerifyFile', ['string'], ['filePath'], 569, 'theme', 'E', 'hidden'),
  o(112, 'Macro_Copy', ['string', 'string', 'string'], ['themeName', 'name', 'newName'], 574, 'theme', 'E', 'hidden'),
  o(113, 'Macro_Rename', ['string', 'string', 'string'], ['themeName', 'oldName', 'newName'], 579, 'theme', 'E', 'hidden'),
  o(114, 'Macro_Update', ['string', 'string', 'string'], ['themeName', 'name', 'macroData'], 584, 'theme', 'E', 'hidden'),
  o(115, 'Macro_Del', ['string', 'string'], ['themeName', 'name'], 589, 'theme', 'E', 'hidden'),
  o(116, 'Macro_Import', ['string', 'string', 'bool'], ['themeName', 'filePath', 'bOverride'], 594, 'theme', 'E', 'hidden'),
  o(117, 'Macro_Export', ['string', 'string', 'string'], ['themeName', 'name', 'exportPath'], 599, 'theme', 'E', 'hidden'),
  o(118, 'Macro_GetFuncMenu', [], [], 604, 'theme', 'S', 'yes'),
  o(119, 'Mouse_ChangeDPI', ['int', 'int'], ['device', 'dpiIndex'], 609, 'stubs', 'E', 'hidden'),
  o(120, 'Mouse_GetMouseMenu', ['int'], ['device'], 614, 'stubs', 'E', 'hidden'),
  o(121, 'Mouse_ChangeDPIValue', ['int', 'int', 'int', 'int'], ['device', 'dpiLevel', 'dpiIndex', 'dpiValue'], 619, 'stubs', 'E', 'hidden'),
  o(122, 'Mouse_ChangeDPILevel', ['int', 'int'], ['device', 'level'], 624, 'stubs', 'E', 'hidden'),
  o(123, 'Mouse_ChangeSmartDPI', ['int', 'int'], ['device', 'value'], 629, 'stubs', 'E', 'hidden'),
  o(124, 'Mouse_ChangeLod', ['int', 'string'], ['device', 'value'], 634, 'stubs', 'E', 'hidden'),
  o(125, 'Mouse_BindSmartDPIToButton', ['int', 'int', 'int'], ['device', 'buttonId', 'layer'], 639, 'stubs', 'E', 'hidden'),
  o(126, 'Mouse_GetMouseParam', ['int'], ['device'], 644, 'stubs', 'E', 'no'),
  o(127, 'Mouse_ChangeDoubleClickSpeed', ['int', 'int'], ['device', 'speed'], 649, 'stubs', 'E', 'hidden'),
  o(128, 'Mouse_ChangeScrollSpeed', ['int', 'int'], ['device', 'speed'], 654, 'stubs', 'E', 'hidden'),
  o(129, 'Mouse_ResetParam', ['int'], ['device'], 659, 'stubs', 'E', 'hidden'),
  o(130, 'Mouse_ChangeRepotRate', ['int', 'int'], ['device', 'value'], 664, 'stubs', 'E', 'hidden'),
  o(131, 'Profile_GetDeviceData', ['int'], ['device'], 669, 'monitor', 'I', 'yes'),
  o(132, 'Profile_Reset', ['int'], ['device'], 674, 'monitor', 'I', 'yes'),
  o(133, 'Profile_GetBoard', ['int'], ['device'], 679, 'monitor', 'E', 'hidden'),
  o(134, 'Profile_EnableOnboard', ['int', 'bool'], ['device', 'enable'], 684, 'monitor', 'E', 'hidden'),
  o(135, 'Profile_SwitchOnboard', ['int', 'int'], ['device', 'boardId'], 689, 'monitor', 'E', 'hidden'),
  o(136, 'Profile_SyncOnBoard', ['int'], ['device'], 694, 'monitor', 'E', 'hidden'),
  o(137, 'Profile_ResetOnboard', ['int', 'int'], ['device', 'boardId'], 699, 'monitor', 'E', 'hidden'),
  o(138, 'Profile_ClearOnBoardMacro', ['int', 'int'], ['device', 'boardId'], 704, 'monitor', 'E', 'hidden'),
  o(139, 'Profile_ApplyOnboard', ['int', 'int', 'string', 'string'], ['device', 'boardId', 'themeName', 'profileName'], 709, 'monitor', 'E', 'hidden'),
  o(140, 'Theme_GetCurTheme', [], [], 714, 'theme', 'I', 'yes'),
  o(141, 'Theme_GetCurProfile', [], [], 719, 'theme', 'I', 'no'),
  o(142, 'Theme_GetThemeInfos', [], [], 724, 'theme', 'I', 'yes'),
  o(143, 'Theme_Switch', ['string', 'string'], ['themeName', 'profileName'], 729, 'theme', 'I', 'yes'),
  o(144, 'Theme_SwitchApp', ['string'], ['themeName'], 734, 'theme', 'I', 'yes'),
  o(145, 'Theme_Add', ['string', 'string'], ['themeName', 'param'], 739, 'theme', 'I', 'yes'),
  o(146, 'Theme_Del', ['string'], ['themeName'], 744, 'theme', 'I', 'yes'),
  o(147, 'Theme_Rename', ['string', 'string'], ['themeName', 'newThemeName'], 749, 'theme', 'I', 'yes'),
  o(148, 'Theme_UpdateBindApp', ['string', 'string'], ['themeName', 'param'], 754, 'theme', 'I', 'yes'),
  o(149, 'Theme_AddProfile', ['string', 'string'], ['themeName', 'profileName'], 759, 'theme', 'I', 'yes'),
  o(150, 'Theme_CopyProfile', ['string', 'string', 'string'], ['themeName', 'profileName', 'newProfileName'], 764, 'theme', 'I', 'yes'),
  o(151, 'Theme_RenameProfile', ['string', 'string', 'string'], ['themeName', 'profileName', 'newProfileName'], 769, 'theme', 'I', 'yes'),
  o(152, 'Theme_DelProfile', ['string', 'string'], ['themeName', 'profileName'], 774, 'theme', 'I', 'yes'),
  o(153, 'Theme_ImportProfile', ['string', 'string', 'bool'], ['themeName', 'filePath', 'bOverride'], 779, 'theme', 'I', 'yes'),
  o(154, 'Theme_ExportProfile', ['string', 'string', 'string'], ['themeName', 'profileName', 'filePath'], 784, 'theme', 'I', 'yes'),
  o(155, 'Theme_HandleCycleProfile', ['string', 'string', 'bool'], ['themeName', 'profileName', 'bAdd'], 789, 'theme', 'I', 'yes'),
  o(156, 'Theme_ResetCurProfile', [], [], 794, 'theme', 'I', 'yes'),
  o(157, 'Theme_GetDevicesBasicInfo', ['int'], ['equipmentType'], 799, 'theme', 'I', 'yes'),
  o(158, 'Theme_GetDevicesBasicInfo', ['string', 'string', 'int'], ['themeName', 'profileName', 'equipmentType'], 804, 'theme', 'I', 'yes'),
  o(159, 'Theme_GetDevicesBasicInfo', ['string', 'int'], ['profilePath', 'equipmentType'], 809, 'theme', 'I', 'yes'),
  o(160, 'Theme_GetProfileDesc', ['string'], ['profilePath'], 814, 'theme', 'I', 'yes'),
  o(161, 'Theme_GetProfileDesc', ['string', 'string'], ['themeName', 'profileName'], 819, 'theme', 'I', 'yes'),
  o(162, 'Theme_ApplyProfile', ['string', 'string', 'string', 'string'], ['themeName', 'profileName', 'profilePath', 'selDevices'], 824, 'theme', 'E', 'hidden'),
]);

export const BRIDGE_OVERLOAD_COUNT = 162;

/** Module families, in the order the composition registers them. */
export const API_OWNERS: readonly ApiOwner[] = Object.freeze(['system', 'monitor', 'theme', 'ambiglow', 'stubs']);

/** `Name(int,string)` — a compact, unique key for one overload. */
export function overloadKey(name: string, signature: readonly RpcArgType[]): string {
  return `${name}(${signature.join(',')})`;
}

const BY_KEY: ReadonlyMap<string, BridgeOverload> = new Map(BRIDGE_OVERLOADS.map((b) => [overloadKey(b.name, b.signature), b]));
const OWNER_BY_NAME: ReadonlyMap<string, ApiOwner> = new Map(BRIDGE_OVERLOADS.map((b) => [b.name, b.owner]));

/** The catalog entry for an exact name + signature, if Bridge declares it. */
export function findOverload(name: string, signature: readonly RpcArgType[]): BridgeOverload | undefined {
  return BY_KEY.get(overloadKey(name, signature));
}

/** Every overload of `name` in declaration order (empty for a name Bridge does not declare). */
export function overloadsNamed(name: string): BridgeOverload[] {
  return BRIDGE_OVERLOADS.filter((b) => b.name === name);
}

/** Owner of a Bridge function name (all overloads of a name share one owner), or null for unknown names. */
export function ownerOf(name: string): ApiOwner | null {
  return OWNER_BY_NAME.get(name) ?? null;
}

/** The overloads a module family must register. */
export function overloadsOwnedBy(...owners: ApiOwner[]): BridgeOverload[] {
  const set = new Set(owners);
  return BRIDGE_OVERLOADS.filter((b) => set.has(b.owner));
}

// ───────────────────────────── Registration audit ─────────────────────────────

/** One `RpcRegistry.register` call, as far as the catalog is concerned. */
export interface Registration {
  readonly name: string;
  readonly signature: readonly RpcArgType[];
}

export interface RegistrationAudit {
  /** In-scope catalog overloads nobody registered (declaration order). */
  readonly missing: readonly BridgeOverload[];
  /** Registrations that are not a Bridge overload: unknown name, or a signature Bridge does not declare. */
  readonly extra: readonly Registration[];
  /** Catalog overloads registered more than once (each listed once, with its count). */
  readonly duplicates: readonly { overload: BridgeOverload; count: number }[];
  /** Valid Bridge overloads registered although their owner is outside the audited scope. */
  readonly outOfScope: readonly BridgeOverload[];
  /** True when all four lists are empty. */
  readonly ok: boolean;
}

export interface AuditScope {
  /** Owners whose overloads must all be present (default: all five, i.e. the full Bridge surface). */
  owners?: Iterable<ApiOwner>;
}

/** Compare `registrations` with the catalog, restricted to `scope.owners`. */
export function auditRegistrations(registrations: Iterable<Registration>, scope: AuditScope = {}): RegistrationAudit {
  const owners = new Set(scope.owners ?? API_OWNERS);
  const counts = new Map<BridgeOverload, number>();
  const extra: Registration[] = [];
  for (const r of registrations) {
    const b = findOverload(r.name, r.signature);
    if (!b) {
      extra.push({ name: r.name, signature: [...r.signature] });
      continue;
    }
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  const missing = BRIDGE_OVERLOADS.filter((b) => owners.has(b.owner) && !counts.has(b));
  const duplicates = BRIDGE_OVERLOADS.filter((b) => (counts.get(b) ?? 0) > 1).map((b) => ({ overload: b, count: counts.get(b) ?? 0 }));
  const outOfScope = BRIDGE_OVERLOADS.filter((b) => !owners.has(b.owner) && counts.has(b));
  return {
    missing,
    extra,
    duplicates,
    outOfScope,
    ok: missing.length === 0 && extra.length === 0 && duplicates.length === 0 && outOfScope.length === 0,
  };
}

/** Human-readable multi-line summary of an audit (empty string when `ok`). */
export function formatAudit(audit: RegistrationAudit): string {
  const lines: string[] = [];
  const sig = (name: string, s: readonly RpcArgType[]) => overloadKey(name, s);
  if (audit.missing.length) {
    lines.push(`missing (${audit.missing.length}):`);
    for (const b of audit.missing) lines.push(`  #${b.index} ${sig(b.name, b.signature)} [${b.owner}] Bridge.cs:${b.line}`);
  }
  if (audit.extra.length) {
    lines.push(`extra, not a Bridge overload (${audit.extra.length}):`);
    for (const r of audit.extra) {
      const known = overloadsNamed(r.name);
      const hint = known.length ? ` — Bridge declares ${known.map((b) => sig(b.name, b.signature)).join(' | ')}` : ' — unknown function name';
      lines.push(`  ${sig(r.name, r.signature)}${hint}`);
    }
  }
  if (audit.duplicates.length) {
    lines.push(`registered more than once (${audit.duplicates.length}):`);
    for (const d of audit.duplicates) lines.push(`  ${sig(d.overload.name, d.overload.signature)} ×${d.count}`);
  }
  if (audit.outOfScope.length) {
    lines.push(`registered outside the audited owners (${audit.outOfScope.length}):`);
    for (const b of audit.outOfScope) lines.push(`  ${sig(b.name, b.signature)} [${b.owner}]`);
  }
  return lines.join('\n');
}

export interface RecordedRegistration extends Registration {
  readonly handler: RpcHandler;
  readonly serialize?: SerializeMode;
}

/**
 * An RpcRegistry that records every registration (duplicates included, unlike RpcDispatcher, which throws)
 * and optionally forwards it to `inner`. Use it to run ApiModules in tests or to audit a composition before
 * handing the registrations to the real dispatcher.
 */
export class RecordingRegistry implements RpcRegistry {
  readonly registrations: RecordedRegistration[] = [];
  readonly #inner: RpcRegistry | undefined;

  constructor(inner?: RpcRegistry) {
    this.#inner = inner;
  }

  register(name: string, signature: RpcArgType[], handler: RpcHandler, serialize?: SerializeMode): void {
    const entry: RecordedRegistration = serialize === undefined
      ? { name, signature: [...signature], handler }
      : { name, signature: [...signature], handler, serialize };
    this.registrations.push(entry);
    this.#inner?.register(name, signature, handler, serialize);
  }

  has(name: string): boolean {
    return this.registrations.some((r) => r.name === name) || (this.#inner?.has(name) ?? false);
  }

  /** The first handler registered for exactly `name(signature)`. */
  handler(name: string, signature: readonly RpcArgType[]): RpcHandler | undefined {
    const key = overloadKey(name, signature);
    return this.registrations.find((r) => overloadKey(r.name, r.signature) === key)?.handler;
  }

  audit(scope?: AuditScope): RegistrationAudit {
    return auditRegistrations(this.registrations, scope);
  }
}

// ───────────────────────────── Auditing a live dispatcher ─────────────────────────────

/** The part of rpc/dispatcher.ts RpcDispatcher the audit needs. */
export interface InspectableDispatcher {
  functionNames(): string[];
  dispatch(requestJson: string): Promise<string>;
}

/**
 * Probe arguments: 16 Booleans. No Bridge overload has more than 8 parameters, so this list never matches
 * a Bridge signature and Class0.method_2 answers "params error: <every registered overload>" without
 * invoking any handler (20-backend-host-tail §1.2 step 5). Only a non-Bridge registration taking exactly
 * 16 bools would run, and it is reported as extra.
 */
const PROBE_ARITY = 16;
const PARAMS_ERROR = 'params error: ';
const NET_TO_ARG: Readonly<Record<string, RpcArgType>> = { Int32: 'int', 'System.String': 'string', Boolean: 'bool' };

/** Parse one .NET `MethodInfo.ToString()` as produced by rpc/dispatcher.ts netSignature(). */
export function parseNetSignature(text: string): Registration | null {
  const m = /^Zeasn\.Com\.Lib\.JsonResult (\S+)\((.*)\)$/.exec(text.trim());
  if (!m) return null;
  const signature: RpcArgType[] = [];
  for (const t of m[2] === '' ? [] : m[2].split(', ')) {
    const a = NET_TO_ARG[t];
    if (a === undefined) return null;
    signature.push(a);
  }
  return { name: m[1], signature };
}

/**
 * Registrations of a live dispatcher, recovered without running any handler: every registered name is
 * called once with an argument list no Bridge overload accepts, and the vendor "params error" reply lists
 * the registered overloads of that name.
 */
export async function dispatcherRegistrations(dispatcher: InspectableDispatcher): Promise<Registration[]> {
  const out: Registration[] = [];
  const probe = Array.from({ length: PROBE_ARITY }, () => true);
  for (const name of dispatcher.functionNames()) {
    const reply = JSON.parse(await dispatcher.dispatch(JSON.stringify({ functionName: name, requestId: 'api-catalog-audit', parms: probe }))) as {
      err_code: number;
      err_msg: string | null;
    };
    const msg = reply.err_msg ?? '';
    // Class0.method_2 for a name without overloads (only reachable through auditBackend's catalog names).
    if (reply.err_code !== 0 && msg === `functionName: ${name} undefined`) continue;
    if (reply.err_code === 0 || !msg.startsWith(PARAMS_ERROR)) {
      out.push({ name, signature: probe.map(() => 'bool' as const) });
      continue;
    }
    for (const part of msg.slice(PARAMS_ERROR.length).split(' | ')) {
      const r = parseNetSignature(part);
      out.push(r ?? { name: `${name} <unparsable: ${part}>`, signature: [] });
    }
  }
  return out;
}

/** Audit a live dispatcher (e.g. the RpcDispatcher inside createBackend) against the catalog. */
export async function auditDispatcher(dispatcher: InspectableDispatcher, scope?: AuditScope): Promise<RegistrationAudit> {
  return auditRegistrations(await dispatcherRegistrations(dispatcher), scope);
}

/** The part of a composed Backend (types.ts Backend) the audit needs. */
export interface RequestHandlerLike {
  handleRequest(requestJson: string): Promise<string>;
}

/**
 * Audit a composed backend through its request path only (createBackend does not expose its dispatcher):
 * every catalog name is probed as in dispatcherRegistrations; `functionName: X undefined` counts as not
 * registered. Registrations under names outside the catalog cannot be seen this way — run the composition's
 * ApiModules against a RecordingRegistry for those. No handler runs.
 */
export async function auditBackend(backend: RequestHandlerLike, scope?: AuditScope): Promise<RegistrationAudit> {
  const names = [...new Set(BRIDGE_OVERLOADS.map((b) => b.name))];
  return auditDispatcher({ functionNames: () => names, dispatch: (json) => backend.handleRequest(json) }, scope);
}
