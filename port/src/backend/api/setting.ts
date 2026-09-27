// Setting_* and FactoryReset Bridge functions (Bridge.cs:18-42).
//
// The three Setting_* methods never reach SystemOper: Bridge itself reads and writes the GlobalOper
// singleton (Config/SoftConfig.data, 20-theme §3.6). The ambiglow service reads the same values
// through ThemeStore.getSoftConfig() for idle lights-off (09). FactoryReset is SystemOper.FactoryReset
// (20-theme §7).
//
// Integration: api/system-minimal.ts also registers Setting_GlobalData; registering both throws, so the
// composition must drop that one when adding this module (docs/port/impl-theme.md "Integration").

import type { ApiModule } from '../index.ts';
import type { RpcArg } from '../types.ts';
import { themeEngineFor } from '../theme/store.ts';

export const settingApi: ApiModule = (registry, services) => {
  const engine = themeEngineFor(services);

  // Bridge.FactoryReset → SystemOper.FactoryReset: Tag true, or 9 "InitEnviroment error".
  registry.register('FactoryReset', [], () => engine.factoryReset());
  // Bridge.Setting_GlobalData → JsonResult.Succ(GlobalOper.ConfigData) (Bridge.cs:23-26).
  registry.register('Setting_GlobalData', [], () => engine.globalData());
  // Tag null; the file is rewritten only when the value changes (GO:23-38).
  registry.register('Setting_TurnOffLightsWhenIdle', ['bool'], ([enable]) => engine.setTurnOffLightsWhenIdle(enable as boolean));
  // duration < 1 → Error("at last 1 minutes") (err 9) before anything is stored (Bridge.cs:34-42).
  registry.register('Setting_TurnOffLightsWhenIdleDuration', ['int'], ([duration]: RpcArg[]) =>
    engine.setTurnOffLightsWhenIdleDuration(duration as number),
  );
};
