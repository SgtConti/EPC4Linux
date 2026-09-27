// HostServices (src/backend/types.ts) provided by the Electron main process.
//   idle time        powerMonitor.getSystemIdleTime(), plus Mutter's idle monitor on GNOME Wayland (idle-time.ts)
//   display mode     20-monitor-io §3.5: Mutter / XRandR / libdrm snapshots (display-sources.ts); the
//                    simulated monitor's mode in EVNIA_MOCK_MONITOR mode
//   foreground app   X11 _NET_ACTIVE_WINDOW tracking, null on Wayland (foreground-app.ts), with the optional
//                    getForegroundApp()/releaseForegroundApp() extension of backend/theme/app-binding.ts
//   capture          hidden capture window + parec (capture-host.ts)
//   path policy      pathAllowed: the backend's Theme_*/Macro_* file arguments are confined like nodeApi
//                    (fs-guard.ts backendMayAccess: dialog picks and app data for reads, the export dialog's
//                    choice and userData temp files for writes)

import type { ForegroundAppHost } from '../backend/theme/app-binding.ts';
import type { CaptureHost, HostServices, Logger } from '../backend/types.ts';
import { MOCK_DISPLAY_MODE } from './display-mode.ts';
import type { DisplayModeProvider } from './display-sources.ts';
import type { X11ForegroundTracker } from './foreground-app.ts';
import type { PathGuard } from './fs-guard.ts';
import type { IdleTimeSource } from './idle-time.ts';
import type { AppPaths } from './paths.ts';

export type MainHostServices = HostServices & Required<ForegroundAppHost> & Required<Pick<HostServices, 'pathAllowed'>>;

export function createHostServices(o: {
  log: Logger;
  paths: AppPaths;
  capture: CaptureHost;
  foreground: Pick<X11ForegroundTracker, 'current' | 'currentApp' | 'release'>;
  idle: Pick<IdleTimeSource, 'seconds'>;
  /** null in mock mode: the simulated monitor reports MOCK_DISPLAY_MODE. */
  displayModes: DisplayModeProvider | null;
  /** nodeApi's guard, which also holds the export-dialog write grants. */
  guard: Pick<PathGuard, 'backendMayAccess'>;
}): MainHostServices {
  const modes = o.displayModes;
  return {
    log: o.log,
    serveDataDir: o.paths.serveDataDir,
    appDataDir: o.paths.userData,
    resourcesDir: o.paths.resourcesDir,
    capture: o.capture,
    getIdleSeconds: () => o.idle.seconds(),
    getDisplayMode: (monitor) => (modes ? modes.get(monitor) : { ...MOCK_DISPLAY_MODE }),
    getForegroundAppPath: () => o.foreground.current(),
    getForegroundApp: () => o.foreground.currentApp(),
    releaseForegroundApp: () => o.foreground.release(),
    pathAllowed: (path, access) => o.guard.backendMayAccess(path, access),
  };
}
