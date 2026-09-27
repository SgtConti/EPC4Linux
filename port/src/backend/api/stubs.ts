// Every Bridge overload owned by no device module (catalog.ts owner 'stubs'): peripheral drivers (Button_*,
// DeviceSteup_*, Keyboard_*, Mouse_*, pairing), the TAG headset DTS_* functions, SmartDesktop (FancyZones_*),
// Wi-Fi for bulb pairing, and the global hotkey hooks. The monitor-only port has none of these devices, so
// each function answers exactly what the vendor answers when no such device is connected
// (20-backend-host-tail §3 dispositions and §3.1 consumer notes), read from SystemOper.cs:
//
//   GetDeviceByType<IButton|IDTS|IKeyboard|IMouse>(device) is null → Error("No driver found!")
//     The display driver (CDevice_PHLDisplay : CDeviceDisplayBase<T>) implements only IDisplay, IEffect,
//     IProfile and IDevice (work/dotnet/…/CDeviceDisplayBase.cs:17), so this holds for device 100000 too.
//   GetDeviceByType<IDeviceSetup|IMouse>(device)?.X() is null → Class0 "functionName: X  return null obj"
//     (DeviceSteup_*, the Mouse_* methods without an explicit null check; two spaces, Class0.cs:101).
//   CanEnterPairing/EnterPairing use GetDeviceByType<IDevice>: "No driver found!" unless `device` is the
//     connected display (100000), whose CDeviceBase default answers Error("operation is not implemented")
//     (CDeviceBase.cs:116-124, 149-152). "Connected" = the driver passed ConnectionCkecked and is in the
//     device dictionary (SystemOper.cs:846-870) = MonitorManager.connectList() is non-empty.
//   GetPairDevices sums the IsSucc pair lists of all devices; the display's is Notimplemented → Succ([]).
//   ModifierKeyListenerEnable → Succ(true); GetHotKeyState → Succ(false) (no hotkey hook on Linux, and the
//     display's hotkey table is never filled, 12 §3.7).
//   FancyZones_GetVersion → the vendor "not installed" object; the other FancyZones_* → "not supported".
//   GetWifiList → Succ([]) and never touches the host (catalog.ts Disposition; §3 said "not supported").
//
// None of these reads host data or changes host state. Replies are built fresh per call.

import type { ApiModule } from '../index.ts';
import type { MonitorManager } from '../services.ts';
import type { JsonResult, RpcArg } from '../types.ts';
import { error, succ } from '../core/envelope.ts';
import { DispatchErrors } from '../rpc/dispatcher.ts';
import { overloadKey, overloadsOwnedBy } from './catalog.ts';

/** Vendor error texts used by the stubs, verbatim. */
export const StubTexts = {
  /** SystemOper: GetDeviceByType<…>(device) returned null. */
  noDriver: 'No driver found!',
  /** CDeviceBase.Notimplemented() (CDeviceBase.cs:149-152). */
  notImplemented: 'operation is not implemented',
  /** Port text for removed Windows-only features (20-backend-host-tail §3). */
  notSupported: 'not supported',
} as const;

/** DeviceType.PHL_CDeviceDisplay. */
export const DISPLAY_DEVICE_TYPE = 100000;

/**
 * FancyZonesOper.FancyZonesVersionModel when PowerToys FancyZones is not installed (FancyZonesOper.cs:20-37,
 * 189-211): fields `StrVersion`, `Version` first, then the ExternInfoBase properties (20-backend-host-tail §3.1).
 */
export function fancyZonesVersionNotInstalled(): { StrVersion: string; Version: number; DP_DeviceType: string; DP_ComponentID: string } {
  return { StrVersion: 'V0.0.0.0', Version: 0, DP_DeviceType: 'SmartDesktop', DP_ComponentID: 'Philips_SmartDesktop' };
}

/** How one stub answers. */
export type StubReply =
  | { readonly kind: 'succ'; readonly tag: () => unknown }
  | { readonly kind: 'error'; readonly msg: string }
  /** The vendor method returned null (`?.` on a missing driver); Class0 turns that into this error. */
  | { readonly kind: 'null' }
  /** IDevice pairing call: display present and addressed → notImplemented, else noDriver. */
  | { readonly kind: 'pairing' };

const NO_DRIVER: StubReply = { kind: 'error', msg: StubTexts.noDriver };
const NULL_OBJ: StubReply = { kind: 'null' };
const NOT_SUPPORTED: StubReply = { kind: 'error', msg: StubTexts.notSupported };

/** Reply per stub function name (every 'stubs' name has exactly one overload). */
export const STUB_REPLIES: ReadonlyMap<string, StubReply> = new Map<string, StubReply>([
  // SystemOper.GetWifiList:316 (see header).
  ['GetWifiList', { kind: 'succ', tag: () => [] }],
  // SystemOper.Button_*:389-692 (IButton).
  ['Button_GetFuncMenu', NO_DRIVER],
  ['Button_GetStaticData', NO_DRIVER],
  ['Button_SetFunc', NO_DRIVER],
  ['Button_SetKeyboard', NO_DRIVER],
  ['Button_SetMacro', NO_DRIVER],
  ['Button_RestButtons', NO_DRIVER],
  // SystemOper.ModifierKeyListenerEnable:699-704.
  ['ModifierKeyListenerEnable', { kind: 'succ', tag: () => true }],
  // SystemOper.GetPairDevices:774-790; consumer ST:35338-35341 maps it (§3.1).
  ['GetPairDevices', { kind: 'succ', tag: () => [] }],
  // SystemOper.CanEnterPairing:792-800, EnterPairing:802-810 (IDevice).
  ['CanEnterPairing', { kind: 'pairing' }],
  ['EnterPairing', { kind: 'pairing' }],
  // SystemOper.DeviceSteup_*:932-985 (IDeviceSetup, `?.`).
  ['DeviceSteup_GetPowerInfo', NULL_OBJ],
  ['DeviceSteup_GetBatteryCurrent', NULL_OBJ],
  ['DeviceSteup_GetSetupMenu', NULL_OBJ],
  ['DeviceSteup_GetSetupData', NULL_OBJ],
  ['DeviceSteup_SwitchStartupEffect', NULL_OBJ],
  ['DeviceSteup_SetLowBetteryValue', NULL_OBJ],
  ['DeviceSteup_SwitchLightSleep', NULL_OBJ],
  ['DeviceSteup_SetLightSleepTime', NULL_OBJ],
  ['DeviceSteup_SwitchDeepSleep', NULL_OBJ],
  ['DeviceSteup_SetDeepSleepTime', NULL_OBJ],
  ['DeviceSteup_LightEnable', NULL_OBJ],
  // SystemOper.GetHotKeyState:1092-1099.
  ['GetHotKeyState', { kind: 'succ', tag: () => false }],
  // SystemOper.DTS_*:1151-1340 (IDTS; null check before any argument parsing).
  ['DTS_Open', NO_DRIVER],
  ['DTS_Close', NO_DRIVER],
  ['DTS_SetAPO', NO_DRIVER],
  ['DTS_SetRooms', NO_DRIVER],
  ['DTS_SetStereoPreference', NO_DRIVER],
  ['DTS_SetBassTbhdx', NO_DRIVER],
  ['DTS_SetDialogEnhancement', NO_DRIVER],
  ['DTS_SetPreset', NO_DRIVER],
  ['DTS_SetGeqBandGain', NO_DRIVER],
  ['DTS_GraphicEqRest', NO_DRIVER],
  ['DTS_SaveGeqBandGain', NO_DRIVER],
  // SystemOper.*FancyZones*:1901-1925; SmartDesktop is hidden by 02 P11.
  ['FancyZones_Enable', NOT_SUPPORTED],
  ['FancyZones_StartEditor', NOT_SUPPORTED],
  ['FancyZones_GetVersion', { kind: 'succ', tag: fancyZonesVersionNotInstalled }],
  ['FancyZones_GetData', NOT_SUPPORTED],
  ['FancyZones_SetSetting', NOT_SUPPORTED],
  // SystemOper.Keyboard_*:1932-1970 (IKeyboard).
  ['Keyboard_GetGameMode', NO_DRIVER],
  ['Keyboard_SwitchGameMode', NO_DRIVER],
  ['Keyboard_SetGameMode', NO_DRIVER],
  ['Keyboard_ResetGameMode', NO_DRIVER],
  // SystemOper.Mouse_*:2849-2936 (IMouse, `?.` except BindSmartDPIToButton's explicit null check).
  ['Mouse_ChangeDPI', NULL_OBJ],
  ['Mouse_GetMouseMenu', NULL_OBJ],
  ['Mouse_ChangeDPIValue', NULL_OBJ],
  ['Mouse_ChangeDPILevel', NULL_OBJ],
  ['Mouse_ChangeSmartDPI', NULL_OBJ],
  ['Mouse_ChangeLod', NULL_OBJ],
  ['Mouse_BindSmartDPIToButton', NO_DRIVER],
  ['Mouse_GetMouseParam', NULL_OBJ],
  ['Mouse_ChangeDoubleClickSpeed', NULL_OBJ],
  ['Mouse_ChangeScrollSpeed', NULL_OBJ],
  ['Mouse_ResetParam', NULL_OBJ],
  ['Mouse_ChangeRepotRate', NULL_OBJ],
]);

/** Registers every catalog overload owned by 'stubs', exactly once, with the reply from STUB_REPLIES. */
export const stubsApi: ApiModule = (registry, services) => {
  // GetDeviceByType<IDevice>(PHL_CDeviceDisplay) is non-null only while the display driver sits in
  // SystemOper.concurrentDictionary_0, i.e. after its ConnectionCkecked() succeeded; a failed check removes it
  // (SystemOper.cs:706-717, 846-870). MonitorManager.connectList() is non-empty exactly then — displays()
  // also lists discovered displays that are not connected or not supported.
  const displayConnected = (): boolean => {
    const monitors = services.monitors as Partial<MonitorManager> | undefined;
    if (!monitors || typeof monitors.connectList !== 'function') return false;
    try {
      return monitors.connectList().length > 0;
    } catch {
      return false;
    }
  };

  for (const overload of overloadsOwnedBy('stubs')) {
    const reply = STUB_REPLIES.get(overload.name);
    if (!reply) throw new Error(`api/stubs.ts: no reply defined for ${overloadKey(overload.name, overload.signature)}`);
    registry.register(overload.name, [...overload.signature], (args: RpcArg[], ctx): JsonResult => {
      switch (reply.kind) {
        case 'succ':
          return succ(reply.tag());
        case 'error':
          return error(reply.msg);
        case 'null':
          return error(DispatchErrors.nullResult(ctx.functionName));
        case 'pairing':
          return error(args[0] === DISPLAY_DEVICE_TYPE && displayConnected() ? StubTexts.notImplemented : StubTexts.noDriver);
      }
    });
  }
};
