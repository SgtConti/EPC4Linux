// Shared helpers for the api/ unit tests and the contract tests (not a test file itself).

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ApiModule, ApiServices, BackendEvents, ServiceSlots } from '../../../src/backend/index.ts';
import { RecordingRegistry, type ApiOwner } from '../../../src/backend/api/catalog.ts';
import { EventBus } from '../../../src/backend/core/events.ts';
import { HubNotifier } from '../../../src/backend/rpc/notifier.ts';
import type { HostServices, Logger } from '../../../src/backend/types.ts';
import { captureLogger, type LogLine } from '../rpc/helpers.ts';

export const API_DIR = fileURLToPath(new URL('../../../src/backend/api/', import.meta.url));

/**
 * The api/ module files of the port and the owner (catalog.ts) whose overloads each one registers.
 * src/backend/compose.ts API_MODULES lists the same modules (test/unit/api/coverage.test.ts checks it).
 */
export const API_MODULE_FILES: readonly { file: string; owner: ApiOwner }[] = [
  { file: 'system.ts', owner: 'system' },
  { file: 'stubs.ts', owner: 'stubs' },
  { file: 'phl.ts', owner: 'monitor' },
  { file: 'device.ts', owner: 'monitor' },
  { file: 'profile.ts', owner: 'monitor' },
  { file: 'displayfw.ts', owner: 'monitor' },
  { file: 'theme.ts', owner: 'theme' },
  { file: 'macro.ts', owner: 'theme' },
  { file: 'setting.ts', owner: 'theme' },
  { file: 'effect.ts', owner: 'ambiglow' },
  { file: 'sync-effect.ts', owner: 'ambiglow' },
];

/** Files in src/backend/api/ that are not module families: the catalog itself. */
export const NON_MODULE_FILES: readonly string[] = ['catalog.ts'];

/** Every .ts file directly in src/backend/api/ (sorted). */
export function apiDirFiles(): string[] {
  if (!existsSync(API_DIR)) return [];
  return readdirSync(API_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
}

/**
 * api/ files that are neither listed in API_MODULE_FILES nor NON_MODULE_FILES. The coverage test fails on
 * them (a different file split must be added to API_MODULE_FILES with its owner); the contract composition
 * loads them anyway (owner null), so the replay does not depend on the exact split.
 */
export function unlistedApiFiles(): string[] {
  const known = new Set([...API_MODULE_FILES.map((f) => f.file), ...NON_MODULE_FILES]);
  return apiDirFiles().filter((f) => !known.has(f));
}

export interface LoadedApiFile {
  readonly file: string;
  /** Owner from API_MODULE_FILES; null for an unlisted file (see unlistedApiFiles). */
  readonly owner: ApiOwner | null;
  readonly status: 'ok' | 'missing' | 'error';
  /** The ApiModules the file exports (see isApiModuleExport). */
  readonly modules: readonly { exportName: string; module: ApiModule }[];
  readonly error?: unknown;
}

/**
 * Convention for api/ files: every exported function whose name ends in `Api` (e.g. `phlApi`,
 * `syncEffectApi`) is an ApiModule, except `create*` factories; a default-exported function counts too.
 */
export function isApiModuleExport(name: string, value: unknown): value is ApiModule {
  if (typeof value !== 'function') return false;
  if (name === 'default') return true;
  return /Api$/.test(name) && !/^create/.test(name);
}

/** Import every api/ module file that exists (dynamically, so missing files only skip their tests). */
export async function loadApiModules(files: readonly { file: string; owner: ApiOwner | null }[] = API_MODULE_FILES): Promise<LoadedApiFile[]> {
  const out: LoadedApiFile[] = [];
  for (const { file, owner } of files) {
    const path = API_DIR + file;
    if (!existsSync(path)) {
      out.push({ file, owner, status: 'missing', modules: [] });
      continue;
    }
    try {
      const ns = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
      const seen = new Set<unknown>();
      const modules: { exportName: string; module: ApiModule }[] = [];
      for (const [exportName, value] of Object.entries(ns)) {
        if (!isApiModuleExport(exportName, value) || seen.has(value)) continue;
        seen.add(value);
        modules.push({ exportName, module: value });
      }
      out.push({ file, owner, status: 'ok', modules });
    } catch (error) {
      out.push({ file, owner, status: 'error', modules: [], error });
    }
  }
  return out;
}

/** The listed module files plus every unlisted .ts file in api/ (owner null). */
export function loadAllApiModules(): Promise<LoadedApiFile[]> {
  return loadApiModules([...API_MODULE_FILES, ...unlistedApiFiles().map((file) => ({ file, owner: null }))]);
}

/**
 * Run ApiModules against a RecordingRegistry with inert services (registration only: a module that
 * subscribes to its services at registration time still registers). Registration errors are collected.
 */
export function recordRegistrations(modules: readonly ApiModule[]): { registry: RecordingRegistry; errors: unknown[] } {
  const registry = new RecordingRegistry();
  const errors: unknown[] = [];
  for (const module of modules) {
    const { services } = testServices({ themes: inertService(), monitors: inertService(), ambiglow: inertService() });
    try {
      module(registry, services);
    } catch (e) {
      errors.push(e);
    }
  }
  return { registry, errors };
}

export function testHost(log: Logger, dirs: Partial<Pick<HostServices, 'serveDataDir' | 'appDataDir' | 'resourcesDir'>> = {}): HostServices {
  return {
    log,
    serveDataDir: dirs.serveDataDir ?? '/nonexistent/EvniaServe',
    appDataDir: dirs.appDataDir ?? '/nonexistent/evnia',
    resourcesDir: dirs.resourcesDir ?? '/nonexistent/res',
  };
}

/** ApiServices for calling an ApiModule directly, with a recording logger and notifier. */
export function testServices(slots: ServiceSlots = {}): { services: ApiServices; lines: LogLine[]; notifications: string[] } {
  const { log, lines } = captureLogger('backend');
  const notifier = new HubNotifier(log.child('notify'));
  const notifications: string[] = [];
  notifier.subscribe((json) => notifications.push(json));
  const host = testHost(log);
  const services: ApiServices = {
    log,
    notifier,
    host,
    events: new EventBus<BackendEvents>(),
    options: { host, noHardware: true },
    ...slots,
  };
  return { services, lines, notifications };
}

/**
 * A service stand-in for registration-only runs: every property is a callable that returns another inert
 * value, and it is not a thenable. Lets an ApiModule that subscribes to its services at registration time
 * register without the real service.
 */
export function inertService(): never {
  const make = (): unknown =>
    new Proxy(function inert() {}, {
      get(_target, prop) {
        if (prop === 'then') return undefined;
        if (prop === Symbol.toPrimitive) return () => '';
        if (prop === Symbol.iterator) return function* empty() {};
        return make();
      },
      apply: () => make(),
      construct: () => make() as object,
    });
  return make() as never;
}

/** A promise with its resolve/reject exposed. */
export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A JSON request string as the renderer builds it (02 §4.4). */
export function request(functionName: string, parms: unknown[] | null = null, requestId = `test-${functionName}`): string {
  return JSON.stringify({ functionName, requestId, parms });
}
