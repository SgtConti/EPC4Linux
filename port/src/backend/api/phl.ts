// Bridge PHL_* functions and SetGamePQ (Bridge.cs:199-321 → SystemOper.cs:987-1114 → the display driver,
// monitor/display.ts). Dispositions: 20-backend-host-tail §3 rows 37-61 (GetHotKeyState, row 59, belongs
// to api/stubs.ts). Every overload is registered with its exact C# signature, in Bridge declaration
// order, so a wrong renderer argument type gets the vendor's "params error" text.
//
// With no connected display each driver call answers "functionName: <fn>  return null obj" like the
// vendor's `GetDeviceByType<IDisplay>(…)?.X()` (monitor/api-support.ts). PHL_Rescan goes through the
// driver singleton instead (SystemOper.PHL_Rescan → smethod_6) and answers "Display unconnected".

import type { ApiModule } from '../index.ts';
import type { JsonResult, RpcArg } from '../types.ts';
import { error, succ } from '../core/envelope.ts';
import { connectedDisplay, monitorsOf, nullObj, withDisplay } from '../monitor/api-support.ts';
import type { PhlDisplay } from '../monitor/display.ts';

const int = (v: unknown) => v as number;
const str = (v: unknown) => v as string;

export const phlApi: ApiModule = (registry, services) => {
  const on = (fn: (d: PhlDisplay, args: RpcArg[]) => Promise<JsonResult>) => withDisplay(services, fn);

  // #37 PHL_Rescan (never called by the renderer): GClass3.Rescan = ClearCache + ConnectionCkecked.
  registry.register('PHL_Rescan', [], async () => {
    const m = monitorsOf(services);
    if (m) await m.scan('display');
    const d = connectedDisplay(services);
    if (!d) return error('Display unconnected');
    await d.ready();
    return succ(d.profile());
  });

  // #38 PHL_SwitchDisplay(name): GClass3.SwitchDisplay (20-backend-host-tail §5 step 11, §6 item 4).
  registry.register('PHL_SwitchDisplay', ['string'], async ([name], ctx) => {
    const m = monitorsOf(services);
    if (!m || !connectedDisplay(services)) return nullObj(ctx);
    const sn = str(name);
    if (!(await m.select(sn))) return error(`Display sn=${sn} is not exit or not support`);
    const d = connectedDisplay(services);
    if (!d) return error(`Display sn=${sn} is not exit or not support`);
    await d.ready();
    return succ(d.profile());
  });

  // #39 PHL_ReloadData: ReloadOSD — full re-read, ParameterToDevice(bForce:false), save.
  registry.register('PHL_ReloadData', [], on(async (d) => d.reload()));

  // #40 PHL_SetOSD(itemName): E "not supported" (renderer never calls it; vendor only wrote F6 = 1).
  registry.register('PHL_SetOSD', ['string'], async () => error('not supported'));

  // #41 PHL_SetOSD(itemName, iValue): Tag = the AttributeInfo, or null for an unknown name (03 §5).
  registry.register('PHL_SetOSD', ['string', 'int'], on(async (d, [item, value]) => d.setOsd(str(item), int(value))));

  // #42-#49: the multi-step setters (06 §7.4-7.10).
  registry.register('PHL_SetSmartImage', ['int'], on(async (d, [v]) => d.setSmartImage(int(v))));
  registry.register('PHL_ResetSmartImage', ['int'], on(async (d, [v]) => d.resetSmartImage(int(v))));
  registry.register('PHL_SetColorPreset', ['int'], on(async (d, [v]) => d.setColorPreset(int(v))));
  registry.register('PHL_SwitchSmartFrame', ['int'], on(async (d, [v]) => d.switchSmartFrame(int(v))));
  registry.register('PHL_SetSmartFrameSize', ['int'], on(async (d, [v]) => d.setSmartFrameSize(int(v))));
  registry.register(
    'PHL_SetInputSource',
    ['int', 'int', 'int', 'int', 'int'],
    on(async (d, [input, pip, mode, size, location]) => d.setInputSource(int(input), int(pip), int(mode), int(size), int(location))),
  );
  registry.register('PHL_SwrapPIPPBP', [], on(async (d) => d.swapPipPbp()));
  registry.register('PHL_SetAudioEQ', ['int', 'int'], on(async (d, [index, value]) => d.setAudioEq(int(index), int(value))));

  // #50 PHL_GetConstraints: NotifyUIDisplayFuncConstraintsChange first, then the Tag (§5 step 13).
  registry.register('PHL_GetConstraints', [], on(async (d) => d.getConstraints()));

  // #51 SetGamePQ (→ SystemOper.PHL_SetGamePQ): dead in 1.13.0, Tag ModuleGameMode without I/O.
  registry.register('SetGamePQ', ['int', 'bool', 'bool', 'bool', 'bool', 'bool', 'bool', 'bool'], on(async (d) => d.setGamePQ()));

  // #52 PHL_ProfileAction: E2A06B; the 34M2C8600 lacks it → "EXT_OP_E2A0_6B_Profile Unavailable".
  registry.register('PHL_ProfileAction', ['int', 'int'], on(async (d, [v, action]) => d.profileAction(int(v), int(action))));

  // #53-#61 (without #59): the dead hotkey / GamePQ mouse-key stubs (PHL/CDevice_PHLDisplay.cs:1354-1421).
  registry.register('PHL_GetHotKeyMenu', [], on(async () => succ([])));
  registry.register('PHL_GetHotKeyData', [], on(async () => succ()));
  registry.register('PHL_SetHotKeyEnable', ['bool'], on(async () => succ()));
  registry.register('PHL_SetHotKeyItemEnable', ['string', 'bool'], on(async () => succ()));
  registry.register('PHL_SetHotKey', ['string', 'int', 'bool', 'bool', 'bool', 'bool', 'bool'], on(async () => succ()));
  registry.register('PHL_DeleteHotKey', ['string'], on(async () => succ()));
  registry.register('PHL_EnableGamePQMouseKey', ['bool'], on(async () => succ()));
  registry.register('PHL_SetGamePQMouseKeyBind', ['int'], on(async () => succ()));
};
