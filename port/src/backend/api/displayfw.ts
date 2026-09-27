// Bridge DisplayFW_* functions (Bridge.cs:324-352 → SystemOper.cs:1116-1144 → PHLDisplayFW). Monitor
// firmware OTA is removed from the port (ARCHITECTURE.md scope; 14 N-list): nothing here reads or sends
// online data, and no flashing code exists. Dispositions: 20-backend-host-tail §3 rows 62-67, §3.1.
//
// PHLDisplayFW builds several replies with `new JsonResult { … }`, i.e. err_msg null instead of Succ's ""
// (20-backend-host-tail §1.3): CheckUpstreamCable, GetMonitorCount and InstallDriver keep that shape.

import type { ApiModule } from '../index.ts';
import { error, result, succ, SUCC } from '../core/envelope.ts';
import { monitorsOf } from '../monitor/api-support.ts';

/** The port's reply to every firmware-update entry point. */
export const FW_UPDATE_UNSUPPORTED = 'firmware update not supported';

export const displayFwApi: ApiModule = (registry, services) => {
  // #62 DisplayFW_CheckUpstreamCable: S, Tag true, err_msg null (only the hidden FW-upgrade validation calls it).
  registry.register('DisplayFW_CheckUpstreamCable', [], async () => result(SUCC, null, true));

  // #63 DisplayFW_GetMonitorCount: S, err_msg null; the number of Philips monitors found (1 for the user).
  registry.register('DisplayFW_GetMonitorCount', [], async () => result(SUCC, null, monitorsOf(services)?.displays().length ?? 0));

  // #64 DisplayFW_GetDeviceList: S, Tag [] (20-backend-host-tail §3.1, §5 step 4 R(port)). saveDeviceList does
  // not await it and only stores the list in localStorage.monitorFw; an empty list involves no online lookup.
  registry.register('DisplayFW_GetDeviceList', [], async () => succ([]));

  // #65 DisplayFW_UpdateFirmversion: E (OTA removed).
  registry.register('DisplayFW_UpdateFirmversion', ['string', 'int', 'string'], async () => error(FW_UPDATE_UNSUPPORTED));

  // #66 DisplayFW_InstallDriver: S, `new JsonResult { err_code = 0 }` (Tag null, err_msg null).
  registry.register('DisplayFW_InstallDriver', ['string', 'string'], async () => result(SUCC, null, null));

  // #67 DisplayFW_FWUpdateFailedNextTime: E (the ISP-failure flag belongs to the removed updater).
  registry.register('DisplayFW_FWUpdateFailedNextTime', ['int'], async () => error(FW_UPDATE_UNSUPPORTED));
};
