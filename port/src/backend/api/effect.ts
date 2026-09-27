// Bridge Effect_* functions and AmbiScape_EnableFollowVideo (Bridge.cs:49-52, 409-492 → SystemOper.cs:377-382,
// 1351-1466 → the display driver's IEffect members), for the ambiglow service (ambiglow/service.ts).
// Dispositions: 20-backend-host-tail §3 rows 7 and 79-95; every overload is registered with its exact C#
// signature, in Bridge declaration order, so a wrong argument type gets the vendor's "params error".
//
// Device dispatch: `smethod_9(device)?.X()` = GetDeviceByType<IEffect>(device): only the connected display
// (DeviceType 100000) has an effect driver in the monitor-only port; any other device, or no connected
// display, answers "functionName: <fn>  return null obj" (two spaces; 20-backend-host-tail §1.3).
//
// The global functions (no device argument):
//   Effect_CheckDynamicLightingEnabled  Tag -1: the vendor's "registry value absent" answer; the Ambiglow page
//                                       then stops polling and hides the Windows Dynamic Lighting hint (09 §12).
//   Effect_OpenDynamicLightingSetting   Tag null, nothing opened (ms-settings: has no Linux counterpart).
//   Effect_GetColorData / SetSelfColors Config/color.data (ambiglow/color-data.ts).
//   AmbiScape_EnableFollowVideo         Tag null, no-op: AmbiScape smart bulbs (Matter/LAN) are removed from the
//                                       port (ARCHITECTURE.md scope). The vendor also switched the screen-capture
//                                       timer with it (EnableFollowVideoTimer(enable)), which stopped the
//                                       display's own FollowVideo when the bulb page disabled AmbiScape; the port
//                                       leaves the display's capture alone.

import type { ApiModule } from '../index.ts';
import type { DisplayDevice } from '../services.ts';
import type { JsonResult, RpcArg, RpcCallContext, RpcHandler } from '../types.ts';
import { error, succ } from '../core/envelope.ts';
import { DispatchErrors } from '../rpc/dispatcher.ts';
import { DYNAMIC_LIGHTING_UNAVAILABLE, ambiglowEngineFor, type AmbiglowEngine } from '../ambiglow/service.ts';

const int = (v: RpcArg) => v as number;
const bool = (v: RpcArg) => v as boolean;
const str = (v: RpcArg) => v as string;

/** "functionName: <fn>  return null obj": the vendor's reply when smethod_9(device) found no driver. */
function nullObj(ctx: RpcCallContext): JsonResult {
  return error(DispatchErrors.nullResult(ctx.functionName));
}

export const effectApi: ApiModule = (registry, services) => {
  // Resolved per call: registration may run with inert services (test/unit/api/helpers.ts).
  const engine = () => ambiglowEngineFor(services);
  const onDevice =
    (fn: (e: AmbiglowEngine, display: DisplayDevice, args: RpcArg[]) => JsonResult | Promise<JsonResult>): RpcHandler =>
    async (args, ctx) => {
      const e = engine();
      const display = e.driverFor(int(args[0]));
      return display ? fn(e, display, args) : nullObj(ctx);
    };

  // #7 AmbiScape_EnableFollowVideo(enable, timeInterval): bulbs removed → Succ() (see the header).
  registry.register('AmbiScape_EnableFollowVideo', ['bool', 'int'], () => succ());

  // #79-#82: global functions.
  registry.register('Effect_CheckDynamicLightingEnabled', [], () => succ(DYNAMIC_LIGHTING_UNAVAILABLE));
  registry.register('Effect_OpenDynamicLightingSetting', [], () => succ());
  registry.register('Effect_GetColorData', [], () => engine().getColorData());
  registry.register('Effect_SetSelfColors', ['string'], ([colors]) => engine().setSelfColors(str(colors)));

  // #83 Effect_GetMenu(device): DisplayEffectMenu.Default(ENE model) (20-enum §6.1/§6.2).
  registry.register('Effect_GetMenu', ['int'], onDevice((e, d) => e.getMenu(d)));
  // #84 Effect_GetLEDs(device): preview mirror (FollowVideo/FollowAudio with ENE), else "not ene follow video or audio".
  registry.register('Effect_GetLEDs', ['int'], onDevice((e, d) => e.getLeds(d)));
  // #85 Effect_Enable(device, enable): ENE ParameterSet, or DDC E2A019 (Tag: enable).
  registry.register('Effect_Enable', ['int', 'bool'], onDevice((e, d, [, enable]) => e.effectEnable(d, bool(enable))));
  // #86-#94: ENE-only setters ("Not Support ENE" without ENE); Tag: EffectInfo.
  registry.register('Effect_Change', ['int', 'int'], onDevice((e, d, [, effect]) => e.effectChange(d, int(effect))));
  registry.register('Effect_RandomEnable', ['int', 'bool'], onDevice((e, d, [, v]) => e.effectRandomEnable(d, bool(v))));
  registry.register('Effect_RainbowEnable', ['int', 'bool'], onDevice((e, d, [, v]) => e.effectRainbowEnable(d, bool(v))));
  registry.register(
    'Effect_ColorChange',
    ['int', 'int', 'int', 'int'],
    onDevice((e, d, [, r, g, b]) => e.effectColorChange(d, int(r), int(g), int(b))),
  );
  registry.register(
    'Effect_BgColorChange',
    ['int', 'int', 'int', 'int'],
    onDevice((e, d, [, r, g, b]) => e.effectBgColorChange(d, int(r), int(g), int(b))),
  );
  registry.register('Effect_SpeedChange', ['int', 'int'], onDevice((e, d, [, v]) => e.effectSpeedChange(d, int(v))));
  registry.register('Effect_BrightnessChange', ['int', 'int'], onDevice((e, d, [, v]) => e.effectBrightnessChange(d, int(v))));
  registry.register('Effect_DirectionChange', ['int', 'int'], onDevice((e, d, [, v]) => e.effectDirectionChange(d, int(v))));
  registry.register('Effect_RegionChange', ['int', 'int'], onDevice((e, d, [, v]) => e.effectRegionChange(d, int(v))));
  // #95 Effect_Reset(device): NotifyEffectSyncDevicesChange, then DDC E2A038 or ENE defaults.
  registry.register('Effect_Reset', ['int'], onDevice((e, d) => e.effectReset(d)));
};
