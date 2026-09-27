// The production composition of the backend (ARCHITECTURE.md "Big picture", docs/port/impl-integration.md):
// the three long-lived services wired the way the vendor's SystemOper holds them, and every Bridge module.
// index.ts createBackend(options) uses it when no composition is passed, which is what Electron main
// (src/main/backend-host.ts) and the smoke server (serve.ts) do.
//
// Services (services.ts contracts, concrete classes):
//   themes   = createThemeStore(core)                       theme/store.ts: DataTheme.cfg, *.pcenter, SoftConfig
//   monitors = createMonitorManager(core, { themes })       monitor/manager.ts: discovery, PhlDisplay drivers
//   ambiglow = createAmbiglowService(core, { themes, monitors })   ambiglow/service.ts: ENE, DDC fallback, engines
//   monitors.bindAmbiglow(ambiglow)
// The ambiglow service needs the monitor manager (driverFor, the mock USB bus), and the manager must call
// AmbiglowService.attach() after every load/reload/apply/reset of the current display and checkEne() at the
// top of every full read (vendor CDevice_PHLDisplay.method_14/method_17, PHL/CDevice_PHLDisplay.cs:328). So
// the manager is created first and the service is bound to it late (impl-monitor §5 item 1). Without the
// binding the display never learns about its ENE and the renderer shows the DDC Ambiglow page.
// createBackend starts the slots in declaration order — themes → monitors → ambiglow — and stops them in
// reverse: the vendor loads the theme store (InitEnviroment) before the device scan pushes the saved profile
// (SystemOper.Start, SystemOper.cs:107-133; 05 §2.5).
//
// Hardware selection (BackendOptions, ARCHITECTURE.md rule 7), decided by the services themselves:
//   mockMonitor "34M2C8600"          simulated monitor behind a fake VIA bridge + fake /dev/i2c-5, plus a
//                                    simulated ENE MCU on the same fake USB bus (monitor/manager.ts);
//   mockMonitor "34M2C8600/no-ene"   the same without the ENE: the user's 2026-09-26 golden session;
//   noHardware (without mockMonitor) no monitors, and no USB for the ENE even when `usb` is given;
//   otherwise                        real hardware: BackendOptions.usb (one LibusbBackend per process, shared
//                                    by the VIA bridges and the ENE) plus /sys, /dev/i2c-*.
// A mock monitor wins over noHardware: the simulated devices are not real hardware.
//
// Restart (impl-api §6): api/system.ts latches a completed Start (vendor bool_0), so a Start after
// backend.stop() + backend.start() replies at once without scanning, while MonitorManager.stop() has
// disposed every display. The vendor never had this state (its Start latch lived and died with the
// EvniaServe process). The default composition therefore re-enumerates the displays at the end of such a
// restart (afterStart), when an earlier run had scanned; the renderer's next Start/Device_GetConnectList then
// sees the displays again, as after a vendor process restart.

import type { ApiModule, ApiServices, BackendComposition, CoreServices } from './index.ts';
import type { BackendOptions } from './types.ts';
import type { DispatcherOptions } from './rpc/dispatcher.ts';
import { systemApi } from './api/system.ts';
import { stubsApi } from './api/stubs.ts';
import { phlApi } from './api/phl.ts';
import { deviceApi } from './api/device.ts';
import { profileApi } from './api/profile.ts';
import { displayFwApi } from './api/displayfw.ts';
import { themeApi } from './api/theme.ts';
import { macroApi } from './api/macro.ts';
import { settingApi } from './api/setting.ts';
import { effectApi } from './api/effect.ts';
import { syncEffectApi } from './api/sync-effect.ts';
import { createThemeStore, type ThemeStoreImpl, type ThemeStoreOptions } from './theme/store.ts';
import { createMonitorManager, type MonitorManagerImpl, type MonitorManagerOptions } from './monitor/manager.ts';
import { createAmbiglowService, type AmbiglowServiceImpl, type AmbiglowServiceOptions } from './ambiglow/service.ts';

/**
 * Every Bridge module, each registering the overloads its family owns in api/catalog.ts (162 overloads, each
 * exactly once — test/unit/api/coverage.test.ts): Start; the 55 stubs; the monitor family (PHL_*, SetGamePQ,
 * Device_*, Profile_*, DisplayFW_*); the theme family (Theme_*, Macro_*, Setting_*, FactoryReset,
 * Comm_GenAppIcon); the ambiglow family (Effect_*, SyncEffect_*, AmbiScape_EnableFollowVideo).
 */
export const API_MODULES: readonly ApiModule[] = Object.freeze([
  systemApi,
  stubsApi,
  phlApi,
  deviceApi,
  profileApi,
  displayFwApi,
  themeApi,
  macroApi,
  settingApi,
  effectApi,
  syncEffectApi,
]);

/** The production services, typed with their concrete classes (ServiceSlots only promises the contracts). */
export interface DefaultServices {
  readonly themes: ThemeStoreImpl;
  readonly monitors: MonitorManagerImpl;
  readonly ambiglow: AmbiglowServiceImpl;
}

/** Tuning of the default composition. Production callers pass nothing. */
export interface DefaultCompositionOptions {
  /** theme/store.ts options, e.g. `appTempDir` (the PATH_APP_TEMP that main must also serve through local:). */
  themes?: ThemeStoreOptions;
  /** monitor/manager.ts seams (clock, discovery, settle time); production passes none. */
  monitors?: MonitorManagerOptions;
  /** ambiglow/service.ts options (USB backend, timers, layout table; main passes the "Fast LED upload" setting when on). */
  ambiglow?: AmbiglowServiceOptions;
  /** API modules (default API_MODULES). */
  modules?: readonly ApiModule[];
  /** Dispatcher settings, e.g. the handler watchdog (default 120 s). */
  dispatcher?: DispatcherOptions;
  /** Called with the services right after they are built, before any of them starts (diagnostics, tests). */
  onServices?: (services: DefaultServices, core: CoreServices) => void;
}

/**
 * Build the production services for one backend (see the header for the wiring). Nothing starts here and no
 * I/O happens: createBackend's lifecycle starts them, and the renderer's `Start` runs the first scan.
 */
export function createDefaultServices(core: CoreServices, options: DefaultCompositionOptions = {}): DefaultServices {
  const themes = createThemeStore(core, options.themes);
  const monitors = createMonitorManager(core, { themes }, options.monitors);
  const ambiglow = createAmbiglowService(core, { themes, monitors }, ambiglowOptions(core.options, options.ambiglow));
  monitors.bindAmbiglow(ambiglow);
  return { themes, monitors, ambiglow };
}

/** "noHardware" also keeps the ENE driver off USB (the ambiglow service would otherwise use a given `usb`). */
function ambiglowOptions(backend: BackendOptions, given: AmbiglowServiceOptions | undefined): AmbiglowServiceOptions | undefined {
  if (backend.noHardware && !backend.mockMonitor && given?.usb === undefined) return { ...given, usb: null };
  return given;
}

/** A human-readable description of the hardware a backend with these options drives (one log line at start). */
export function describeHardware(options: BackendOptions): string {
  if (options.mockMonitor) return `simulated monitor "${options.mockMonitor}" (EVNIA_MOCK_MONITOR)`;
  if (options.noHardware) return 'no hardware access (noHardware)';
  return options.usb ? 'real hardware (shared USB backend)' : 'real hardware';
}

/**
 * The production composition: createDefaultServices + API_MODULES, and the re-enumeration after a restart
 * (header). Each createBackend() call that receives it builds its own services.
 */
export function defaultComposition(options: DefaultCompositionOptions = {}): BackendComposition {
  // Per backend: whether a display scan ever completed (MonitorManager.onChanged fires at the end of every
  // full scan, USB reconcile and selection; stop() does not fire it).
  const scanned = new WeakMap<object, { done: boolean }>();
  return {
    services: (core) => {
      core.log.info(`backend composition: ${describeHardware(core.options)}`);
      const services = createDefaultServices(core, options);
      const state = { done: false };
      services.monitors.onChanged(() => {
        state.done = true;
      });
      scanned.set(services.monitors, state);
      options.onServices?.(services, core);
      return services;
    },
    modules: options.modules ?? API_MODULES,
    dispatcher: options.dispatcher,
    afterStart: async (services: ApiServices, { restart }) => {
      const monitors = services.monitors;
      if (!restart || !monitors || !scanned.get(monitors)?.done) return;
      services.log.info('backend restarted: re-enumerating the displays (the Start latch of the first run still holds)');
      await monitors.scan('all');
    },
  };
}
