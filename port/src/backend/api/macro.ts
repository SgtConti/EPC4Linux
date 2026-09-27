// Macro_* Bridge functions (Bridge.cs:549-606 → SystemOper.Macro_*, SO:1972-2552).
//
// File-compatible implementations of the peripheral macro store (theme/macros.ts) — the renderer calls
// Macro_GetList at start-up and on every active-theme change even with only a monitor (MN:207-208,
// MN:1884-1893) — and Macro_GetFuncMenu, the static menu derived from the vendor code in
// theme/macro-menu.ts (20-backend-host-tail §5 step 9: 4025-character Tag, byte-checked in the tests).

import type { ApiModule } from '../index.ts';
import type { RpcArg } from '../types.ts';
import { succ } from '../core/envelope.ts';
import { makeMacroCmdMenuData, type ButtonMenuDataJson } from '../theme/macro-menu.ts';
import { themeEngineFor } from '../theme/store.ts';

const s = (a: RpcArg): string => a as string;
const b = (a: RpcArg): boolean => a as boolean;

export const macroApi: ApiModule = (registry, services) => {
  const macros = themeEngineFor(services).macros;
  // SystemOper.buttonMenuData_0: built once, then served from the cache (SO:2544-2552).
  let menu: ButtonMenuDataJson | null = null;

  registry.register('Macro_GetList', ['string'], ([t]) => macros.getList(s(t)));
  registry.register('Macro_GetDetail', ['string', 'string'], ([t, n]) => macros.getDetail(s(t), s(n)));
  registry.register('Macro_GetDetail', ['string'], ([f]) => macros.getDetailFile(s(f)));
  registry.register('Macro_Add', ['string', 'string'], ([t, n]) => macros.add(s(t), s(n)));
  registry.register('Macro_VerifyFile', ['string'], ([f]) => macros.verifyFile(s(f)));
  registry.register('Macro_Copy', ['string', 'string', 'string'], ([t, n, nn]) => macros.copy(s(t), s(n), s(nn)));
  registry.register('Macro_Rename', ['string', 'string', 'string'], ([t, o, n]) => macros.rename(s(t), s(o), s(n)));
  registry.register('Macro_Update', ['string', 'string', 'string'], ([t, n, d]) => macros.update(s(t), s(n), s(d)));
  registry.register('Macro_Del', ['string', 'string'], ([t, n]) => macros.del(s(t), s(n)));
  registry.register('Macro_Import', ['string', 'string', 'bool'], ([t, f, o]) => macros.import(s(t), s(f), b(o)));
  registry.register('Macro_Export', ['string', 'string', 'string'], ([t, n, p]) => macros.export(s(t), s(n), s(p)));
  registry.register('Macro_GetFuncMenu', [], () => succ((menu ??= makeMacroCmdMenuData())));
};
