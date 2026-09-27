// startupBackendService (01 §7, §10.1 #2 Adapt).
//
// Vendor: locate EvniaServe.exe, refresh MonitorInfo.json online, probe for a running instance with
// PowerShell/netstat, spawn `EvniaServe.exe --urls http://*:<port>` (all interfaces, no auth) and
// resolve the port immediately, before the backend listened.
// Port: the backend runs in this process (src/backend). The first call starts it and the loopback
// SignalR hub (127.0.0.1, ports probed upward from 10010 by the hub, token-protected, Origin file:// only)
// and resolves with the port once the hub is listening. Later calls — the renderer re-invokes the channel
// 3 s after every SignalR reconnect (02 §4.7) — return the same port. A failed start resolves -1 (the
// vendor's failure value) and is retried on the next call. The 10 s --openAsHidden backend delay is dropped:
// it only spread the Windows login load of a separate .NET process.
//
// The backend is the production composition (src/backend/compose.ts via createDefaultBackend; impl-integration
// §2): theme store, monitor manager, ambiglow service and every Bridge module.
//   real hardware   BackendOptions.usb = the ONE LibusbBackend of this process, shared by the VIA USB-DDC
//                   bridges (monitor manager) and the ENE Ambiglow controller (ambiglow service); main also
//                   subscribes to it for USBChange (impl-monitor §5 item 4, impl-usb-ene §5);
//   EVNIA_MOCK_MONITOR=<model>[/no-ene]   the simulated monitor (and ENE) of ARCHITECTURE rule 7 with
//                   noHardware: nothing real is opened, like backend/serve.ts --mock;
//   themes.appTempDir   PATH_APP_TEMP (Comm_GenAppIcon icons), the same directory main serves through local:.

import { createDefaultBackend, startHubServer, type DefaultBackend, type HubHandle } from '../backend/index.ts';
import type { DefaultCompositionOptions } from '../backend/compose.ts';
import type { BackendOptions, HostServices, Logger, UsbBackend } from '../backend/types.ts';

/** EVNIA_MOCK_MONITOR (ARCHITECTURE rule 7): the simulated model, e.g. "34M2C8600" or "34M2C8600/no-ene". */
export function mockMonitorFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.EVNIA_MOCK_MONITOR?.trim();
  return v ? v : undefined;
}

export interface BackendHostOptions {
  host: HostServices;
  log: Logger;
  token: string;
  /** The process's shared LibusbBackend (real hardware only). */
  usb?: UsbBackend;
  /** EVNIA_MOCK_MONITOR model name (ARCHITECTURE rule 7). */
  mockMonitor?: string;
  /** PATH_APP_TEMP for Comm_GenAppIcon (theme/paths.ts defaultAppTempDir), also served by local:. */
  appTempDir?: string;
  /**
   * The "Fast LED upload (experimental)" setting (config.json linuxExperimental.eneFrameBurst), read when the backend is
   * created (AmbiglowServiceOptions.eneFrameBurst); later changes go through setEneFrameBurst().
   */
  eneFrameBurst?: () => boolean;
  /** Backend factory (tests); default createDefaultBackend. */
  createBackend?: (options: BackendOptions, overrides: DefaultCompositionOptions) => DefaultBackend;
}

/**
 * The BackendOptions and composition overrides main uses. `eneFrameBurst` is the "Fast LED upload (experimental)"
 * setting at backend creation; only a setting that is on is passed (off is the service's default).
 */
export function backendConfiguration(o: Pick<BackendHostOptions, 'host' | 'usb' | 'mockMonitor' | 'appTempDir'> & { eneFrameBurst?: boolean }): {
  options: BackendOptions;
  overrides: DefaultCompositionOptions;
} {
  const options: BackendOptions = o.mockMonitor ? { host: o.host, mockMonitor: o.mockMonitor, noHardware: true } : { host: o.host, usb: o.usb };
  const overrides: DefaultCompositionOptions = {
    ...(o.appTempDir ? { themes: { appTempDir: o.appTempDir } } : {}),
    ...(o.eneFrameBurst === true ? { ambiglow: { eneFrameBurst: true } } : {}),
  };
  return { options, overrides };
}

export class BackendHost {
  readonly #o: BackendHostOptions;
  #backend: DefaultBackend | null = null;
  #hub: HubHandle | null = null;
  #starting: Promise<number> | null = null;
  #stopped = false;

  constructor(o: BackendHostOptions) {
    this.#o = o;
  }

  /** Port of the running hub (the network kill-switch lets exactly this port through). */
  get port(): number | null {
    return this.#hub?.port ?? null;
  }

  /** The backend once created (diagnostics, tests). */
  get backend(): DefaultBackend | null {
    return this.#backend;
  }

  ensureStarted(): Promise<number> {
    if (this.#hub) return Promise.resolve(this.#hub.port);
    this.#starting ??= this.#start().finally(() => {
      this.#starting = null;
    });
    return this.#starting;
  }

  /** Debounced hotplug from the host (01 §9) → backend services. */
  hotplug(kind: 'usb' | 'display'): void {
    this.#backend?.hotplug(kind);
  }

  /**
   * The "Fast LED upload (experimental)" checkbox changed (AmbiglowService.setEneFrameBurst, from the next frame). Before
   * the backend exists nothing is to do: it is created with the current setting (BackendHostOptions.eneFrameBurst).
   */
  setEneFrameBurst(enabled: boolean): void {
    try {
      this.#backend?.services.ambiglow.setEneFrameBurst?.(enabled);
    } catch (e) {
      this.#o.log.error('setEneFrameBurst failed', e);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    // A start still in flight finishes first, so its hub and services are stopped too.
    await this.#starting?.catch(() => undefined);
    const hub = this.#hub;
    this.#hub = null;
    try {
      await hub?.close();
    } catch (e) {
      this.#o.log.error('Hub close failed', e);
    }
    try {
      await this.#backend?.stop();
    } catch (e) {
      this.#o.log.error('Backend stop failed', e);
    }
  }

  async #start(): Promise<number> {
    const { log } = this.#o;
    if (this.#stopped) return -1;
    log.info('Backend service run');
    try {
      if (!this.#backend) {
        const { options, overrides } = backendConfiguration({ ...this.#o, eneFrameBurst: this.#o.eneFrameBurst?.() === true });
        this.#backend = (this.#o.createBackend ?? createDefaultBackend)(options, overrides);
      }
      await this.#backend.start();
      if (this.#stopped) return -1;
      const hub = await startHubServer(this.#backend, { token: this.#o.token, log: this.#o.host.log.child('hub') });
      if (this.#stopped) {
        await hub.close();
        return -1;
      }
      this.#hub = hub;
      log.info(`Backend startup completed, hub on 127.0.0.1:${hub.port}`);
      return hub.port;
    } catch (e) {
      log.error('Backend startup failed', e);
      return -1;
    }
  }
}
