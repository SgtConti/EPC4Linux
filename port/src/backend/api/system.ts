// Bridge.Start → SystemOper.Start (work/dotnet-clean/Zeasn.Framework.Core.Lib/.../SystemOper.cs:107-133),
// adapted per 20-backend-host-tail §7.2.
//
// Vendor semantics:
//   if (!bool_0) {                                   // bool_0: "a device scan has completed"
//     if (!InitEnviroment()) return Error("InitEnviroment error");   // ThemeOper.ThemeInit + current profile
//     smethod_0();                                   // scan all 26 DeviceTypes, Task.WaitAll; catches everything
//     return Succ(true);                             // also when the scan threw (bool_0 then stays false)
//   }
//   return Succ(true);
// On the user's machine this took 21.45 s (6.7 s cold capability read + 11.1 s full VCP read; §7.2).
//
// Port (§7.2 recommendation):
//   - the first Start awaits the theme store (ServiceSlots.themes.start(), the InitEnviroment part) and then
//     the monitor manager's enumeration (services.monitors.scan('all'): EDID/SN, DDC probe, capabilities;
//     the full VCP read continues in the background inside the driver, and the PHL_*/Profile_* handlers
//     await DisplayDevice.ready()) and replies Succ(true) — Tag `true`, err_msg "" (golden step 2);
//   - idempotent: once a Start has loaded the theme store and completed its scan, later calls (renderer
//     reconnects, MN:211-221) reply Succ(true) at once, like the vendor's `bool_0` path;
//   - concurrent Start calls share one in-flight run (the vendor would start a second concurrent scan
//     because bool_0 is still false — §7.2 item 3);
//   - missing services are tolerated: Start still replies Succ(true) and logs a warning (tests, partial
//     compositions, a failed service factory).
// All work is asynchronous; the hub keeps pinging while Start runs (20-backend-host-tail §1.4, §7.2).
//
// Deviations (docs/port/impl-api.md §2):
//   D1 A failing theme store still replies the vendor's `Error("InitEnviroment error")`, but the monitor scan
//      runs anyway so the monitor pages stay usable (the vendor skipped the scan and showed no monitor at
//      all). The renderer tolerates a Start rejection (MN:190-192). Later Starts retry only the theme store
//      while it keeps failing (the display is already enumerated; every renderer reconnect calls Start, so
//      rescanning each time would re-run DDC discovery under the page the user is on). Once the theme store
//      loads, that Start scans once more — the vendor order InitEnviroment → smethod_0, so the driver
//      reloads with the saved profile — and Start is complete.
//   D2 Watchdog: if the run takes longer than `startWatchdogMs` (default 60 s; the vendor's worst observed
//      Start is 21.45 s) Start replies Succ(true) while the scan continues, instead of leaving the renderer
//      on its Startup screen forever (there is no client-side timeout, 02 §4.6). The renderer then fetches
//      Device_GetConnectList at once and stores it (MN:197-198), possibly before the display is enumerated.
//      When such a late run finishes, Start sends NotifyDeviceConnectionStatus
//      {DeviceType: 100000, Data: <display connected>}: the renderer's subscriber (MN:1803-1806) re-fetches
//      Device_GetConnectList and refreshes its device cards (it ignores the Tag; 02 §6 table, 03 §7). The
//      vendor raises this notification only from peripheral drivers (20-backend-host-tail §2.4 #17).

import type { ApiModule, ApiServices, BackendService } from '../index.ts';
import type { MonitorManager } from '../services.ts';
import type { JsonResult, Logger } from '../types.ts';
import { error, succ } from '../core/envelope.ts';

/** SystemOper.Start's only error text (SystemOper.cs:117). */
export const START_INIT_ERROR = 'InitEnviroment error';

/** Default Start watchdog (deviation D2). */
export const DEFAULT_START_WATCHDOG_MS = 60_000;

/** Largest delay setTimeout honours; Node fires longer ones (Infinity included) after 1 ms. */
export const MAX_START_WATCHDOG_MS = 2_147_483_647;

/** Notification_Func.NotifyDeviceConnectionStatus (20-backend-host-tail §2.4 #17), sent after a late Start run (D2). */
export const NOTIFY_DEVICE_CONNECTION_STATUS = 'NotifyDeviceConnectionStatus';

/** DeviceType.PHL_CDeviceDisplay. */
const DISPLAY_DEVICE_TYPE = 100000;

export interface SystemApiOptions {
  /**
   * Reply Succ(true) after this many milliseconds even if the scan has not finished (deviation D2).
   * 0 or a negative value disables the watchdog (vendor behaviour: wait for the scan however long it takes).
   * NaN and values above MAX_START_WATCHDOG_MS (Infinity included) throw a RangeError, like
   * RpcDispatcher's handlerTimeoutMs: setTimeout would otherwise fire after 1 ms and Start would answer
   * before the theme store and the scan ran.
   */
  startWatchdogMs?: number;
}

/**
 * NotificationDataBase (Zeasn.PCenter.Entity.Lib/NotificationDataBase.cs): `DeviceType` (enum → int), then
 * `Data` — the declaration order Newtonsoft writes.
 */
export interface DeviceConnectionStatus {
  DeviceType: number;
  Data: boolean;
}

type Scanner = Pick<MonitorManager, 'scan'>;

function asScanner(service: BackendService | undefined): Scanner | null {
  const candidate = service as Partial<MonitorManager> | undefined;
  return candidate && typeof candidate.scan === 'function' ? (candidate as Scanner) : null;
}

/** Whether the monitor manager lists a connected display (Device_GetConnectList would be non-empty). */
function displayConnected(service: BackendService | undefined, log: Logger): boolean {
  const candidate = service as Partial<MonitorManager> | undefined;
  if (!candidate || typeof candidate.connectList !== 'function') return false;
  try {
    return candidate.connectList().length > 0;
  } catch (e) {
    log.warn('Start: connectList() failed', e);
    return false;
  }
}

/** What the Start runs of one registration have achieved so far. */
interface StartState {
  /** A scan('all') succeeded at least once: the displays are enumerated (possibly while themes failed, D1). */
  scanned: boolean;
  /** Vendor bool_0: the theme store is loaded and a scan succeeded after it. Later Starts reply at once. */
  completed: boolean;
}

/** One Start run shared by the concurrent Start calls. */
interface StartRun {
  readonly reply: Promise<JsonResult>;
  /** Set when a watchdog answered before the run finished (D2). */
  late: boolean;
}

/**
 * Build the `system` API module (Bridge.Start). The Start state is created per registration, so one module
 * value can serve several backends (each createBackend registers it afresh).
 */
export function createSystemApi(options: SystemApiOptions = {}): ApiModule {
  const watchdogMs = options.startWatchdogMs ?? DEFAULT_START_WATCHDOG_MS;
  if (Number.isNaN(watchdogMs) || watchdogMs > MAX_START_WATCHDOG_MS) {
    throw new RangeError(`startWatchdogMs must be at most ${MAX_START_WATCHDOG_MS} ms (0 or less disables the watchdog), got ${watchdogMs}`);
  }

  return (registry, services) => {
    const log = services.log.child('system');
    const state: StartState = { scanned: false, completed: false };
    let inflight: StartRun | null = null;

    const announceLateRun = (): void => {
      const tag: DeviceConnectionStatus = { DeviceType: DISPLAY_DEVICE_TYPE, Data: displayConnected(services.monitors, log) };
      log.info(`Start: the run finished after the watchdog reply; ${NOTIFY_DEVICE_CONNECTION_STATUS} makes the renderer fetch Device_GetConnectList again`);
      services.notifier.notify(NOTIFY_DEVICE_CONNECTION_STATUS, tag);
    };

    const start = (): Promise<JsonResult> => {
      if (state.completed) return Promise.resolve(succ(true));
      let run = inflight;
      if (!run) {
        const created: StartRun = {
          late: false,
          reply: runStart(services, log, state)
            // runStart catches everything itself; this is only a last guard so a Start never rejects.
            .catch((e: unknown) => {
              log.error('Start failed unexpectedly', e);
              return succ(true);
            })
            .then((reply) => {
              if (created.late) announceLateRun();
              return reply;
            })
            .finally(() => {
              if (inflight === created) inflight = null;
            }),
        };
        inflight = run = created;
      }
      return withWatchdog(run, watchdogMs, log);
    };

    // Bridge.cs:13 `public static JsonResult Start()`.
    registry.register('Start', [], () => start());
  };
}

/** The default `system` module (60 s watchdog). */
export const systemApi: ApiModule = createSystemApi();

/** ThemeOper.ThemeInit via ThemeStore.start(); true when loaded or when there is no theme store to load. */
async function initThemes(services: ApiServices, log: Logger): Promise<boolean> {
  const themes: BackendService | undefined = services.themes;
  if (!themes) {
    log.warn('Start: no theme store in this composition; themes and profiles are not loaded');
    return true;
  }
  if (typeof themes.start !== 'function') return true;
  // InitEnviroment (SystemOper.cs:124-133). ThemeStore.start() is idempotent: the backend lifecycle
  // normally ran it already and this resolves at once; after a failure it retries the load.
  try {
    await themes.start();
    return true;
  } catch (e) {
    log.error(`Start: ${START_INIT_ERROR}`, e);
    return false;
  }
}

async function runStart(services: ApiServices, log: Logger, state: StartState): Promise<JsonResult> {
  log.debug('=====================================  Start() ======================================');
  const themesOk = await initThemes(services, log);
  if (!themesOk && state.scanned) {
    // D1: the displays are enumerated already; do not rescan while the theme store keeps failing.
    log.warn('Start: displays already enumerated; the scan runs again once the theme store loads');
    return error(START_INIT_ERROR);
  }

  let scanOk = true;
  const monitors = asScanner(services.monitors);
  if (!monitors) {
    log.warn('Start: no monitor manager in this composition; no display is enumerated');
  } else {
    // smethod_0(ScanDeviceType.All), SystemOper.cs:135-225. The vendor catches every scan exception, keeps
    // bool_0 false and still answers Succ(true); so does the port (the next Start scans again).
    const t0 = performance.now();
    try {
      await monitors.scan('all');
      log.debug(`Start: display enumeration finished in ${Math.round(performance.now() - t0)} ms`);
    } catch (e) {
      scanOk = false;
      log.error('Start: display scan failed', e);
    }
  }
  if (scanOk) state.scanned = true;

  if (!themesOk) return error(START_INIT_ERROR);
  if (scanOk) state.completed = true;
  return succ(true);
}

function withWatchdog(run: StartRun, ms: number, log: Logger): Promise<JsonResult> {
  if (!(ms > 0)) return run.reply;
  return new Promise<JsonResult>((resolve) => {
    // Not unref'd: the timer is always either cleared by the run or fires, so it never outlives Start.
    const timer = setTimeout(() => {
      run.late = true;
      log.warn(`Start: device scan still running after ${ms} ms; replying now, the scan continues in the background`);
      resolve(succ(true));
    }, ms);
    void run.reply.then((r) => {
      clearTimeout(timer);
      resolve(r);
    });
  });
}
