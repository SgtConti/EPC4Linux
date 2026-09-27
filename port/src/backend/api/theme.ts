// Theme_* Bridge functions and Comm_GenAppIcon (Bridge.cs:84-86, 714-826 → SystemOper / ThemeOper),
// per docs/re/20-theme-profile-engine.md §5 and 20-backend-host-tail §3 rows 14, 140-162.
//
// Overloads are registered in Bridge declaration order with the exact C# parameter types, so a call
// with the wrong argument types gets the vendor's "params error: …" listing (rpc/dispatcher.ts).
// The algorithms, check order, error codes and texts live in theme/store.ts (ThemeOper/SystemOper);
// this module only binds them to the dispatcher and computes Theme_GetDevicesBasicInfo's DataBasicInfo
// from the stored profile plus the connected displays (services.monitors).

import type { ApiModule, ApiServices } from '../index.ts';
import type { MonitorManager } from '../services.ts';
import type { RpcArg } from '../types.ts';
import { error, succ } from '../core/envelope.ts';
import { buildDataBasicInfo, MonitorInfoTable, type BasicInfoContext } from '../theme/basic-info.ts';
import { themeEngineFor } from '../theme/store.ts';

const s = (a: RpcArg): string => a as string;
const i = (a: RpcArg): number => a as number;
const b = (a: RpcArg): boolean => a as boolean;

function monitorManagerOf(services: ApiServices): MonitorManager | null {
  const m = services.monitors as Partial<MonitorManager> | undefined;
  return m && typeof m.displays === 'function' ? (m as MonitorManager) : null;
}

export const themeApi: ApiModule = (registry, services) => {
  const engine = themeEngineFor(services);
  const monitorInfo = new MonitorInfoTable(services.host);
  const log = services.log.child('theme-api');

  /** Inputs of AnalyseBasicInfo: connected displays' EDID names and MonitorInfo.json (DictMgr). */
  const basicInfoContext = async (): Promise<BasicInfoContext> => {
    const monitors = await monitorInfo.load();
    let names: string[] = [];
    try {
      names = monitorManagerOf(services)?.displays().map((d) => d.monitorName) ?? [];
    } catch (e) {
      log.error('monitors.displays() failed', e);
    }
    return { connectedMonitorNames: names, supLightSync: (model) => MonitorInfoTable.supLightSync(monitors, model) };
  };

  // ── queries (SO:2994-3007) ──
  registry.register('Theme_GetCurTheme', [], () => {
    engine.armAppWatch();
    return engine.getCurTheme();
  });
  registry.register('Theme_GetCurProfile', [], () => engine.getCurProfile());
  registry.register('Theme_GetThemeInfos', [], () => {
    engine.armAppWatch();
    return engine.getThemeInfos();
  });

  // ── switching (SO:3019-3059) ──
  registry.register('Theme_Switch', ['string', 'string'], ([t, p]) => engine.switchTheme(s(t), s(p)));
  registry.register('Theme_SwitchApp', ['string'], ([t]) => engine.switchApp(s(t)));

  // ── theme management (TO:41-152) ──
  registry.register('Theme_Add', ['string', 'string'], ([t, param]) => engine.addTheme(s(t), s(param)));
  registry.register('Theme_Del', ['string'], ([t]) => engine.delTheme(s(t)));
  registry.register('Theme_Rename', ['string', 'string'], ([t, n]) => engine.renameTheme(s(t), s(n)));
  registry.register('Theme_UpdateBindApp', ['string', 'string'], ([t, param]) => engine.updateBindApp(s(t), s(param)));
  registry.register('Comm_GenAppIcon', ['string'], ([path]) => engine.genAppIcon(s(path)));

  // ── profile management (TO:268-501) ──
  registry.register('Theme_AddProfile', ['string', 'string'], ([t, p]) => engine.addProfile(s(t), s(p)));
  registry.register('Theme_CopyProfile', ['string', 'string', 'string'], ([t, p, n]) => engine.copyProfile(s(t), s(p), s(n)));
  registry.register('Theme_RenameProfile', ['string', 'string', 'string'], ([t, p, n]) => engine.renameProfile(s(t), s(p), s(n)));
  registry.register('Theme_DelProfile', ['string', 'string'], ([t, p]) => engine.delProfile(s(t), s(p)));
  registry.register('Theme_ImportProfile', ['string', 'string', 'bool'], ([t, f, o]) => engine.importProfile(s(t), s(f), b(o)));
  registry.register('Theme_ExportProfile', ['string', 'string', 'string'], ([t, p, f]) => engine.exportProfile(s(t), s(p), s(f)));
  registry.register('Theme_HandleCycleProfile', ['string', 'string', 'bool'], ([t, p, add]) => engine.handleCycleProfile(s(t), s(p), b(add)));
  registry.register('Theme_ResetCurProfile', [], () => engine.resetCurProfile());

  // ── Theme_GetDevicesBasicInfo ×3 (SO:3363-3439); the C# default `equipmentType = -1` is not optional over RPC ──
  registry.register('Theme_GetDevicesBasicInfo', ['int'], async ([eq]) => {
    const sel = await engine.currentSelection();
    if (!sel) return error('当前主题对象为空');
    const profile = await engine.loadThemeProfile(sel.theme, sel.profile);
    return succ(buildDataBasicInfo(profile, i(eq), await basicInfoContext()));
  });
  registry.register('Theme_GetDevicesBasicInfo', ['string', 'string', 'int'], async ([t, p, eq]) => {
    const profile = await engine.loadThemeProfile(s(t), s(p));
    return succ(buildDataBasicInfo(profile, i(eq), await basicInfoContext()));
  });
  registry.register('Theme_GetDevicesBasicInfo', ['string', 'int'], async ([path, eq]) => {
    const profile = await engine.loadProfileFile(s(path));
    return succ(buildDataBasicInfo(profile, i(eq), await basicInfoContext()));
  });

  // ── Theme_GetProfileDesc ×2 (TO:536-586) and Theme_ApplyProfile (TO:622-699) ──
  registry.register('Theme_GetProfileDesc', ['string'], ([path]) => engine.getProfileDescByPath(s(path)));
  registry.register('Theme_GetProfileDesc', ['string', 'string'], ([t, p]) => engine.getProfileDesc(s(t), s(p)));
  registry.register('Theme_ApplyProfile', ['string', 'string', 'string', 'string'], ([t, p, path, sel]) =>
    engine.applyProfile(s(t), s(p), s(path), s(sel)),
  );
};
