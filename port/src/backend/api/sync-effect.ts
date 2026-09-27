// Bridge SyncEffect_* functions (Bridge.cs:494-502 → SystemOper.cs:1518-1636), for the ambiglow service
// (ambiglow/service.ts, ambiglow/sync.ts). Dispositions: 20-backend-host-tail §3 rows 96-97 and §3.1.
//
//   SyncEffect_GetData()                     Tag T_Sync_Profile, normalized (smethod_11) — golden step 6:
//                                            {"EffectDetailInfo":{…Off…},"SyncDevices":[]} without ENE.
//   SyncEffect_EnableDevice(device, sel)     the light-sync group edit. In the monitor-only port the display is
//                                            the only sync-capable device; without ENE (or with the effect off)
//                                            the vendor answers "Input device=100000 EffectDetail is null".
//
// The Sync_Profile lives in the current theme profile (ThemeStore.getSyncProfile / setSyncProfile).

import type { ApiModule } from '../index.ts';
import { ambiglowEngineFor } from '../ambiglow/service.ts';

export const syncEffectApi: ApiModule = (registry, services) => {
  const engine = () => ambiglowEngineFor(services);

  // #96 SyncEffect_GetData.
  registry.register('SyncEffect_GetData', [], () => engine().syncEffectGetData());
  // #97 SyncEffect_EnableDevice(device, selDevices): selDevices is the renderer's JSON list of
  // {DeviceType, ModelName, ExtValue} (styles-DAnQi2A8.js:8667-8671).
  registry.register('SyncEffect_EnableDevice', ['int', 'string'], ([device, sel]) => engine().syncEffectEnableDevice(device as number, sel as string));
};
