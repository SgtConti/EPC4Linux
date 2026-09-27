// Bridge Profile_* functions (Bridge.cs:669-712 → SystemOper.cs:2936-2992 → IProfile of the device type).
// Only the display (DeviceType 100000) has a driver in the port. Dispositions (20-backend-host-tail §3
// rows 131-139): Profile_GetDeviceData and Profile_Reset are implemented; the onboard-memory functions
// (peripherals only, hidden in the port) and every other device type reply
// "functionName: <fn>  return null obj", the vendor's answer when `smethod_19(device)` finds no driver.
//
// Profile_GetDeviceData is serialized with JsonSerialize(IgnoreUI, bIgnoreNullValue:false): the
// dispatcher applies 'uiProfileGet' to it by default (rpc/dispatcher.ts VENDOR_SERIALIZE_MODES).

import type { ApiModule } from '../index.ts';
import { error, succ } from '../core/envelope.ts';
import { DEVICE_TYPE_DISPLAY, connectedDisplay, nullObj } from '../monitor/api-support.ts';

export const profileApi: ApiModule = (registry, services) => {
  const display = (device: unknown) => (device === DEVICE_TYPE_DISPLAY ? connectedDisplay(services) : null);

  // #131 Profile_GetDeviceData(device): DeviceData after the background load (20-backend-host-tail §7.2).
  registry.register('Profile_GetDeviceData', ['int'], async ([device], ctx) => {
    const d = display(device);
    if (!d) return nullObj(ctx);
    await d.ready();
    return succ(d.profile());
  });

  // #132 Profile_Reset(device): VCP 0x04 = 1, 5000 ms, full reload, default data, save (06 §7.12).
  registry.register('Profile_Reset', ['int'], async ([device], ctx) => {
    const d = display(device);
    return d ? d.reset(true) : nullObj(ctx);
  });

  // #133-#138: onboard memory — peripherals only (E, the null-object text).
  registry.register('Profile_GetBoard', ['int'], async (_args, ctx) => nullObj(ctx));
  registry.register('Profile_EnableOnboard', ['int', 'bool'], async (_args, ctx) => nullObj(ctx));
  registry.register('Profile_SwitchOnboard', ['int', 'int'], async (_args, ctx) => nullObj(ctx));
  registry.register('Profile_SyncOnBoard', ['int'], async (_args, ctx) => nullObj(ctx));
  registry.register('Profile_ResetOnboard', ['int', 'int'], async (_args, ctx) => nullObj(ctx));
  registry.register('Profile_ClearOnBoardMacro', ['int', 'int'], async (_args, ctx) => nullObj(ctx));

  // #139 Profile_ApplyOnboard: SystemOper checks the names before resolving the driver (SystemOper.cs:2971-2982).
  registry.register('Profile_ApplyOnboard', ['int', 'int', 'string', 'string'], async ([, , themeName, profileName], ctx) => {
    if (themeName === '') return error('ThemeSwitch themeName is null');
    if (profileName === '') return error('ThemeSwitch profileName is null');
    return nullObj(ctx);
  });
};
