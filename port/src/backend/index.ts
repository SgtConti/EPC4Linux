// Backend composition root (ARCHITECTURE.md "Big picture"). Plain Node, no Electron imports.
// The Electron main process creates one backend, starts it and exposes it to the renderer:
//
//   const token = generateHubToken();                      // per launch, handed to the renderer
//   const backend = createBackend({ host, usb, mockMonitor });   // production composition (compose.ts)
//   await backend.start();
//   const hub = await startHubServer(backend, { token, log });
//   // 127.0.0.1, from port 10010 up; admits Origin file:// (what the loadFile renderer sends) and
//   // Origin-less clients only (APP_RENDERER_ORIGINS, hub/security.ts)
//   // renderer: ws://127.0.0.1:<hub.port>/EvniaHub?k=<token>
//   …
//   await hub.close();       // waits (≤1 s) for requests that are already running
//   await backend.stop();    // start()/stop() are serialized and idempotent
//
// createBackend(options) without a composition builds the production backend: the theme store, the monitor
// manager and the ambiglow service wired together, and every Bridge module (compose.ts). An explicit
// composition replaces that field by field (tests, partial backends): `services` default to none, `modules`
// to API_MODULES. createDefaultBackend(options, overrides) is the production backend with its services
// exposed as their concrete classes (serve.ts, contract tests).
//
// Request path: hub (GetTaskAsync) → Backend.handleRequest → RpcDispatcher (Class0) → handler
// registered by an ApiModule → JsonResult → broadcast. Push path: services call
// `notifier.notify(name, tag)` → Backend.onNotification → hub "Notification" broadcast.

import type { Backend, BackendOptions, HostServices, Logger, Notifier, RpcRegistry } from './types.ts';
// Type-only cycles (services.ts and compose.ts import types from here); these imports are erased.
import type { AmbiglowService, MonitorManager, ThemeStore } from './services.ts';
import type { DefaultCompositionOptions, DefaultServices } from './compose.ts';
import { EventBus } from './core/events.ts';
import { createLogger } from './core/log.ts';
import { RpcDispatcher, type DispatcherOptions } from './rpc/dispatcher.ts';
import { HubNotifier } from './rpc/notifier.ts';
import { DEFAULT_HUB_PORT, NOTIFICATION_TARGET, startSignalRServer } from './hub/signalr-server.ts';
// compose.ts imports only types from this file, so this value import creates no runtime cycle.
import { API_MODULES, defaultComposition } from './compose.ts';

export { generateHubToken } from './hub/security.ts';
export { DEFAULT_HUB_PORT, HUB_PATH } from './hub/signalr-server.ts';
export { API_MODULES, createDefaultServices, defaultComposition, describeHardware } from './compose.ts';
export type { DefaultCompositionOptions, DefaultServices } from './compose.ts';

// ───────────────────────────── Services handed to API modules ─────────────────────────────

/** Lifecycle of a long-lived backend service; both steps are optional. */
export interface BackendService {
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/**
 * Long-lived services the api/ modules call into, created by the composition's `services` factory
 * and typed by their contracts in services.ts, so tsc checks every api/ module against them.
 * They are started in declaration order (themes → monitors → ambiglow) and stopped in reverse:
 * the vendor loads the theme/profile store before the device scan pushes the saved profile to the
 * monitor (SystemOper.InitEnviroment then smethod_0, 05 §2.5), and Ambiglow sits on top of the
 * monitor's DDC channel for its fallback path (09).
 *
 * The production composition fills them with the concrete classes (compose.ts DefaultServices:
 * ThemeStoreImpl, MonitorManagerImpl, AmbiglowServiceImpl). The slots stay typed by the contracts because
 * the api/ modules are written against services.ts and tests compose them with contract-only doubles.
 */
export interface ServiceSlots {
  /** theme/: Theme/DataTheme.cfg, Theme/<theme>/<profile>.pcenter, Config/SoftConfig.data (05 §7). */
  themes?: ThemeStore;
  /** monitor/: discovery, one PHLDisplay driver per monitor, current display selection (06, 12 §3). */
  monitors?: MonitorManager;
  /** ambiglow/: ENE driver, DDC fallback, follow-video/audio and idle lights-off (09). */
  ambiglow?: AmbiglowService;
}

const SERVICE_ORDER = ['themes', 'monitors', 'ambiglow'] as const satisfies readonly (keyof ServiceSlots)[];

/** In-process events (replaces Zeasn.Com.Lib.EventSystem between modules). Extend as needed. */
export type BackendEvents = {
  /** USB or display topology changed (the host debounces, 01 §9); emitted by Backend.hotplug(). */
  hotplug: { kind: 'usb' | 'display' };
};

/** What every service factory and API module receives. */
export interface CoreServices {
  /** Backend logger; modules take `log.child('<scope>')`. */
  readonly log: Logger;
  /** Push to the renderer: SignalR "Notification" with RequestId null (05 §2.4, 02 §6). */
  readonly notifier: Notifier;
  /** Paths, capture, idle time, display mode and foreground app, provided by Electron main or tests. */
  readonly host: HostServices;
  readonly events: EventBus<BackendEvents>;
  /** The options createBackend() was called with (mockMonitor, noHardware, usb). */
  readonly options: BackendOptions;
}

export type ApiServices = CoreServices & Readonly<ServiceSlots>;

/** Registers a family of Bridge functions (PHL_*, Profile_*, Theme_*, Effect_*, …) on the dispatcher. */
export type ApiModule = (registry: RpcRegistry, services: ApiServices) => void;

export interface BackendComposition {
  /** Build the long-lived services (default: none). */
  services?: (core: CoreServices) => ServiceSlots;
  /** API modules to register (default: API_MODULES). */
  modules?: readonly ApiModule[];
  /** Dispatcher settings, e.g. the handler watchdog (default 120 s, rpc/dispatcher.ts). */
  dispatcher?: DispatcherOptions;
  /**
   * Runs at the end of every start phase, once every service has started; backend.start() waits for it and
   * a failure is logged (start() never rejects). `restart` is true when an earlier start phase completed
   * (backend.stop() + backend.start()). The default composition re-enumerates the displays there (compose.ts).
   */
  afterStart?: (services: ApiServices, info: { restart: boolean }) => Promise<void>;
}

// ───────────────────────────── Backend ─────────────────────────────

/**
 * Build a backend. Without `composition` it is the production one (compose.ts defaultComposition: the real
 * services and every Bridge module); an explicit composition is used as given (no services unless it builds
 * them, API_MODULES unless it lists modules).
 */
export function createBackend(options: BackendOptions, composition: BackendComposition = defaultComposition()): Backend {
  const log = options.host.log;
  const notifier = new HubNotifier(log.child('notify'));
  const dispatcher = new RpcDispatcher(log.child('rpc'), composition.dispatcher);
  const events = new EventBus<BackendEvents>();
  const core: CoreServices = { log, notifier, host: options.host, events, options };
  const slots = composition.services?.(core) ?? {};
  const services: ApiServices = { ...core, ...slots };
  for (const register of composition.modules ?? API_MODULES) register(dispatcher, services);

  const lifecycle = SERVICE_ORDER.flatMap((name) => {
    const service = slots[name];
    return service ? [{ name, service }] : [];
  });
  let startedBefore = false; // a start phase has completed (the next one is a restart)
  // A failing service must not keep the UI from connecting: the vendor host also logs and carries
  // on, and every Bridge call then reports its own error to the renderer. Never rejects.
  const runPhase = async (phase: Phase): Promise<void> => {
    for (const { name, service } of phase === 'start' ? lifecycle : [...lifecycle].reverse()) {
      try {
        await service[phase]?.();
      } catch (e) {
        log.error(`${name} ${phase} failed`, e);
      }
    }
    if (phase !== 'start') return;
    const restart = startedBefore;
    startedBefore = true;
    try {
      await composition.afterStart?.(services, { restart });
    } catch (e) {
      log.error('afterStart failed', e);
    }
  };

  // Transitions run strictly one after another on `tail`, so a start phase never overlaps a stop
  // phase. A call asking for the state that the last queued transition leads to shares that
  // transition's promise: concurrent start() or stop() calls run the phase once and all resolve when
  // it has finished, and a start() issued during stop() begins once every service has stopped.
  let started = false; // state reached by the last completed transition
  let queued: Transition | null = null; // last transition that has not completed yet
  let tail: Promise<void> = Promise.resolve();
  const transition = (to: Phase): Promise<void> => {
    if (queued) {
      if (queued.to === to) return queued.done;
    } else if (started === (to === 'start')) {
      return Promise.resolve();
    }
    const entry: Transition = {
      to,
      done: tail.then(async () => {
        await runPhase(to);
        started = to === 'start';
        if (queued === entry) queued = null;
      }),
    };
    queued = entry;
    tail = entry.done;
    return entry.done;
  };

  return {
    handleRequest: (requestJson) => dispatcher.dispatch(requestJson),
    onNotification: (deliver) => notifier.subscribe(deliver),
    hotplug: (kind) => {
      log.debug(`hotplug: ${kind}`);
      events.emit('hotplug', { kind });
    },
    start: () => transition('start'),
    stop: () => transition('stop'),
  };
}

type Phase = 'start' | 'stop';

interface Transition {
  readonly to: Phase;
  readonly done: Promise<void>;
}

/** The production backend together with its services (for serve.ts, diagnostics and contract tests). */
export interface DefaultBackend extends Backend {
  readonly services: DefaultServices;
}

/**
 * createBackend(options) with the production composition, returning its services as well. `overrides` tune
 * the composition (compose.ts DefaultCompositionOptions); production callers pass none.
 */
export function createDefaultBackend(options: BackendOptions, overrides: DefaultCompositionOptions = {}): DefaultBackend {
  let built: DefaultServices | null = null;
  const backend = createBackend(
    options,
    defaultComposition({
      ...overrides,
      onServices: (services, core) => {
        built = services;
        overrides.onServices?.(services, core);
      },
    }),
  );
  // createBackend calls the services factory synchronously.
  const services = built as DefaultServices | null;
  if (!services) throw new Error('createDefaultBackend: the services factory did not run');
  return { ...backend, services };
}

// ───────────────────────────── Hub ─────────────────────────────

export interface HubOptions {
  /** First port to try (default 10010, the vendor's); taken ports are skipped upward. 0 = any. */
  port?: number;
  /** Per-launch token from generateHubToken(); the renderer must connect with `?k=<token>`. */
  token: string;
  log?: Logger;
  /**
   * Origins the renderer may connect from besides "no Origin" (default: APP_RENDERER_ORIGINS, i.e.
   * `file://` only). The renderer loaded with loadFile sends `file://`; `null` comes from opaque origins,
   * which any web page can create (hub/security.ts, impl-hub-rpc §4), so the app's hub does not admit it.
   * A custom-scheme renderer must pass its own origin here; `hub/security.ts ALLOWED_ORIGINS` restores the
   * raw server's default (`file://` and `null`).
   */
  allowedOrigins?: readonly string[];
  /** Overrides of the ASP.NET defaults (15 s / 30 s / 15 s); meant for tests. */
  keepAliveIntervalMs?: number;
  clientTimeoutMs?: number;
  handshakeTimeoutMs?: number;
}

export interface HubHandle {
  /** Port actually bound on 127.0.0.1 (what `startupBackendService` must return to the renderer). */
  readonly port: number;
  /** Renderer connections that completed the SignalR handshake. */
  readonly connectionCount: number;
  /**
   * Disconnect the renderer and stop listening. Resolves once the requests already running in the
   * backend have finished (at most SHUTDOWN_GRACE_MS, 1 s), so backend.stop() can follow directly.
   */
  close(): Promise<void>;
}

/**
 * Origin of the app's own renderer: the vendor UI loaded with BrowserWindow.loadFile sends `Origin: file://`
 * (probed with Electron 44, impl-hub-rpc §4). Non-browser clients (serve.ts users, tests) send no Origin.
 */
export const APP_RENDERER_ORIGINS: readonly string[] = Object.freeze(['file://']);

/** Serve `backend` to the renderer as the SignalR hub /EvniaHub on 127.0.0.1. */
export async function startHubServer(backend: Backend, options: HubOptions): Promise<HubHandle> {
  const server = await startSignalRServer({
    ...options,
    port: options.port ?? DEFAULT_HUB_PORT,
    log: options.log ?? createLogger('hub'),
    allowedOrigins: options.allowedOrigins ?? APP_RENDERER_ORIGINS,
    getTaskAsync: (requestJson) => backend.handleRequest(requestJson),
  });
  const unsubscribe = backend.onNotification((json) => server.broadcast(NOTIFICATION_TARGET, json));
  return {
    port: server.port,
    get connectionCount() {
      return server.connectionCount;
    },
    close: async () => {
      unsubscribe();
      await server.close();
    },
  };
}
