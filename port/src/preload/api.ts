// The page-facing API of the main/notice window preload (02 §2.1, §L.2), built over an ipcRenderer.
// src/preload/index.ts exposes it through contextBridge; unit tests drive it with a fake ipcRenderer.
//
//   ipc      {send, invoke, on, once, removeAllListeners, listeners}; channels outside the allowlist
//            are answered inertly here (02 §L.2 OFFLINE_DEFAULTS) and never reach main. Listeners
//            receive an empty event object, not the IpcRendererEvent, so the page cannot reach
//            ipcRenderer through `event.sender` (the vendor leaked it).
//   store    {get, set, delete} over a synchronous snapshot taken at load (the renderer reads the store
//            at module top level, 02 §1.3); writes go through to main, which owns config.json
//            (src/main/store.ts) and broadcasts other windows' changes on storeChanged.
//   nodeApi  the calls the renderer makes (02 §2.1): existsSync, readFileSync, readFile, copyFileSync,
//            unlinkSync, getBaseName, pathJoin — file access via synchronous IPC, confined by main to
//            the app's data directories and dialog-picked files (src/main/fs-guard.ts).
//   evnia    window.__EVNIA__ {hubToken, platform} for the patched SignalR URL (ARCHITECTURE "Big picture"), and
//            {experimental: {get, setEneFrameBurst}} for the port's opt-in experiments: the Ambiglow page's
//            "Fast LED upload (experimental)" checkbox (scripts/ui-patches.mjs FAST-LED-UPLOAD). get() is synchronous
//            (the store snapshot of the bootstrap, so the first render is right) and follows config.json.
//   noop     the vendor defined it only in the isolated world, so the page's `.catch(window.noop)`
//            swallowed nothing; exposing it makes those catches work as intended.
//   electronLog  window.__electronLog {sendToMain, log, error, …}: the renderer's electron-log lines into
//            main's log (src/main/renderer-log.ts), as electron-log's own preload did for the vendor.
// Pure module apart from the injected ipcRenderer: it must stay importable in the sandboxed preload.

import {
  type BootstrapData,
  DROPPED_SEND_CHANNELS,
  EVENT_CHANNELS,
  EXPERIMENTAL_NONE,
  type ExperimentalState,
  type FsSyncResult,
  INTERNAL_CHANNELS,
  INVOKE_CHANNELS,
  LOCAL_EVENT_CHANNELS,
  OFFLINE_INVOKE_DEFAULTS,
  SEND_CHANNELS,
  syntheticReply,
} from '../main/shared/channels.ts';
import { basename, join } from '../main/shared/posix-path.ts';
import {
  cloneJson,
  coerceForced,
  deletePath,
  ENE_FRAME_BURST_KEY,
  getPath,
  setPath,
  splitKeyPath,
  writeError,
} from '../main/shared/store-schema.ts';

type IpcListener = (event: unknown, ...args: unknown[]) => void;

/** The part of Electron's ipcRenderer the preload uses. */
export interface IpcRendererLike {
  send(channel: string, ...args: unknown[]): void;
  sendSync(channel: string, ...args: unknown[]): unknown;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: IpcListener): unknown;
  once(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
}

/** Console used for the preload's own warnings (injected so tests stay quiet). */
export interface PreloadConsole {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

type Listener = (event: object, ...args: unknown[]) => void;
type ReadCallback = (err: Error | null, data?: string | Uint8Array) => void;

export interface PreloadApi {
  ipc: {
    send(channel: string, ...args: unknown[]): void;
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
    on(channel: string, listener: Listener): () => void;
    once(channel: string, listener: Listener): () => void;
    removeAllListeners(channel: string): void;
    listeners(channel: string): Listener[];
  };
  store: {
    get(key: string): unknown;
    set(key: string | Record<string, unknown>, value?: unknown): void;
    delete(key: string): void;
  };
  nodeApi: {
    existsSync(p: string): boolean;
    readFileSync(p: string, options?: string | { encoding?: string }): string | Uint8Array;
    readFile(p: string, a?: string | { encoding?: string } | ReadCallback, b?: ReadCallback): void;
    copyFileSync(src: string, dest: string): void;
    unlinkSync(p: string): void;
    getBaseName(p: string, ext?: string): string;
    pathJoin(...parts: string[]): string;
  };
  evnia: {
    hubToken: string;
    platform: 'linux';
    /**
     * The port's opt-in experiments. Only the main window gets the real state (other windows see everything off and
     * are refused by main). Nothing of this is a vendor API; only the FAST-LED-UPLOAD patch of the Ambiglow page uses it.
     */
    experimental: {
      /** Synchronous: {eneFrameBurst: the saved "Fast LED upload" setting, forcedByEnv: EVNIA_ENE_FRAME_BURST=1}. */
      get(): ExperimentalState;
      /** Save the setting (config.json linuxExperimental.eneFrameBurst) and switch the ENE frame burst; rejects for a non-boolean or a refused sender. */
      setEneFrameBurst(enabled: boolean): Promise<void>;
    };
  };
  noop: () => void;
  /**
   * window.__electronLog: the bridge electron-log 5's own preload exposed in the vendor app (its renderer IPC
   * transport calls sendToMain, styles-DAnQi2A8.js:30995-31010). The lines go to main's log
   * (src/main/renderer-log.ts); without the bridge the renderer logs a console error instead.
   */
  electronLog: {
    sendToMain(message: unknown): void;
    log(...data: unknown[]): void;
    error(...data: unknown[]): void;
    warn(...data: unknown[]): void;
    info(...data: unknown[]): void;
    verbose(...data: unknown[]): void;
    debug(...data: unknown[]): void;
    silly(...data: unknown[]): void;
  };
}

function fsError(r: { code: string; message: string }): Error {
  return Object.assign(new Error(r.message), { code: r.code });
}

function unwrap<T>(r: FsSyncResult<T>): T {
  if (r.ok) return r.value;
  throw fsError(r);
}

export function createPreloadApi(ipcRenderer: IpcRendererLike, out: PreloadConsole = console): PreloadApi {
  const invokeSet = new Set<string>(INVOKE_CHANNELS);
  const sendSet = new Set<string>(SEND_CHANNELS);
  const eventSet = new Set<string>(EVENT_CHANNELS);
  const localEventSet = new Set<string>(LOCAL_EVENT_CHANNELS);
  const droppedSendSet = new Set<string>(DROPPED_SEND_CHANNELS);

  const boot = ipcRenderer.sendSync(INTERNAL_CHANNELS.bootstrap) as BootstrapData;

  // ───────────── ipc ─────────────

  /** page listener → the wrapper registered on ipcRenderer. */
  const wrappers = new Map<string, Map<Listener, IpcListener>>();
  /** Listeners on channels only the preload itself can emit (synthetic replies). */
  const localListeners = new Map<string, Set<Listener>>();

  function emitLocal(channel: string, ...args: unknown[]): void {
    for (const l of [...(localListeners.get(channel) ?? [])]) {
      try {
        l({}, ...args);
      } catch (e) {
        out.error(`[preload] listener for ${channel} failed`, e);
      }
    }
  }

  function subscribe(channel: string, listener: Listener, once: boolean): () => void {
    if (typeof listener !== 'function') return () => {};
    if (eventSet.has(channel)) {
      const wrapper: IpcListener = (_e, ...args) => {
        if (once) wrappers.get(channel)?.delete(listener);
        listener({}, ...args);
      };
      let byListener = wrappers.get(channel);
      if (!byListener) wrappers.set(channel, (byListener = new Map()));
      byListener.set(listener, wrapper);
      if (once) ipcRenderer.once(channel, wrapper);
      else ipcRenderer.on(channel, wrapper);
      return () => {
        ipcRenderer.removeListener(channel, wrapper);
        byListener.delete(listener);
      };
    }
    if (localEventSet.has(channel)) {
      let set = localListeners.get(channel);
      if (!set) localListeners.set(channel, (set = new Set()));
      const entry: Listener = once
        ? (event, ...args) => {
            set.delete(entry);
            listener(event, ...args);
          }
        : listener;
      set.add(entry);
      return () => set.delete(entry);
    }
    out.warn(`[preload] ignored subscription to unknown channel ${channel}`);
    return () => {};
  }

  const ipc: PreloadApi['ipc'] = {
    send(channel, ...args) {
      if (sendSet.has(channel)) {
        ipcRenderer.send(channel, ...args);
        return;
      }
      const reply = syntheticReply(channel, args);
      if (reply) {
        setTimeout(() => emitLocal(reply[0], reply[1]), 0);
        return;
      }
      if (!droppedSendSet.has(channel)) out.warn(`[preload] dropped send on unknown channel ${channel}`);
    },
    invoke(channel, ...args) {
      if (invokeSet.has(channel)) return ipcRenderer.invoke(channel, ...args);
      if (Object.hasOwn(OFFLINE_INVOKE_DEFAULTS, channel)) return Promise.resolve(cloneJson(OFFLINE_INVOKE_DEFAULTS[channel]));
      out.warn(`[preload] invoke on unknown channel ${channel} answered with undefined`);
      return Promise.resolve(undefined);
    },
    on: (channel, listener) => subscribe(channel, listener, false),
    once: (channel, listener) => subscribe(channel, listener, true),
    removeAllListeners(channel) {
      if (eventSet.has(channel)) {
        for (const wrapper of wrappers.get(channel)?.values() ?? []) ipcRenderer.removeListener(channel, wrapper);
        wrappers.delete(channel);
      }
      localListeners.delete(channel);
    },
    listeners(channel) {
      return [...(wrappers.get(channel)?.keys() ?? []), ...(localListeners.get(channel) ?? [])];
    },
  };

  // ───────────── store ─────────────

  const snapshot: Record<string, unknown> = boot.store;
  ipcRenderer.on(INTERNAL_CHANNELS.storeChanged, (_e, key, value) => {
    if (typeof key !== 'string') return;
    if (value === undefined) deletePath(snapshot, key);
    else setPath(snapshot, key, value);
  });

  function storeSetOne(key: string, value: unknown): void {
    const err = writeError(key, value);
    if (err) throw new TypeError(err);
    const parts = splitKeyPath(key)!;
    const stored = parts.length === 1 ? coerceForced(parts[0], value) : value;
    setPath(snapshot, key, cloneJson(stored));
    ipcRenderer.send(INTERNAL_CHANNELS.storeSet, key, value);
  }

  const store: PreloadApi['store'] = {
    get: (key) => cloneJson(getPath(snapshot, key)),
    set(key, value) {
      if (typeof key === 'object' && key !== null) {
        for (const [k, v] of Object.entries(key)) storeSetOne(k, v);
        return;
      }
      storeSetOne(key, value);
    },
    delete(key) {
      if (deletePath(snapshot, key)) ipcRenderer.send(INTERNAL_CHANNELS.storeDelete, key);
    },
  };

  // ───────────── nodeApi ─────────────

  const nodeApi: PreloadApi['nodeApi'] = {
    existsSync: (p) => ipcRenderer.sendSync(INTERNAL_CHANNELS.fsExists, p) === true,
    readFileSync(p, options) {
      const encoding = typeof options === 'string' ? options : options?.encoding;
      return unwrap(ipcRenderer.sendSync(INTERNAL_CHANNELS.fsReadSync, p, encoding ?? null) as FsSyncResult<string | Uint8Array>);
    },
    readFile(p, a, b) {
      const callback = typeof a === 'function' ? a : b;
      const encoding = typeof a === 'string' ? a : typeof a === 'object' && a !== null ? a.encoding : undefined;
      if (typeof callback !== 'function') throw new TypeError('The "cb" argument must be of type function');
      ipcRenderer
        .invoke(INTERNAL_CHANNELS.fsRead, p, encoding ?? null)
        .then((r) => {
          const res = r as FsSyncResult<string | Uint8Array>;
          if (res.ok) callback(null, res.value);
          else callback(fsError(res));
        })
        .catch((e: unknown) => callback(e instanceof Error ? e : new Error(String(e))));
    },
    copyFileSync(src, dest) {
      unwrap(ipcRenderer.sendSync(INTERNAL_CHANNELS.fsCopySync, src, dest) as FsSyncResult<null>);
    },
    /** Vendor wrapper: errors are logged, never thrown (PL:7355-7361). */
    unlinkSync(p) {
      const r = ipcRenderer.sendSync(INTERNAL_CHANNELS.fsUnlinkSync, p) as FsSyncResult<null>;
      if (!r.ok) out.error('Unlink file error', p, r.message);
    },
    getBaseName: (p, ext) => basename(p, ext),
    pathJoin: (...parts) => join(...parts),
  };

  // ───────────── electron-log bridge ─────────────

  const sendToMain = (message: unknown): void => {
    try {
      ipcRenderer.send(INTERNAL_CHANNELS.rendererLog, message);
    } catch (e) {
      // e.g. a value IPC cannot clone; electron-log's preload reports the failure the same way
      out.error('electronLog.sendToMain', e);
    }
  };
  const level = (name: string) => (...data: unknown[]) => sendToMain({ data, level: name });
  const electronLog: PreloadApi['electronLog'] = {
    sendToMain,
    log: level('info'),
    error: level('error'),
    warn: level('warn'),
    info: level('info'),
    verbose: level('verbose'),
    debug: level('debug'),
    silly: level('silly'),
  };

  // ───────────── experiments (window.__EVNIA__.experimental) ─────────────

  // Main sends the real state to the main window only (the one with the hub token) and EXPERIMENTAL_NONE to the others.
  // The setting itself is config.json linuxExperimental.eneFrameBurst, so the main window reads it from its store
  // snapshot, which follows every write (its own, main's broadcasts); forcedByEnv is fixed for the app's run.
  const isMainWindow = boot.hubToken !== '';
  const forcedByEnv = (boot.experimental ?? EXPERIMENTAL_NONE).forcedByEnv === true;
  const experimental: PreloadApi['evnia']['experimental'] = {
    get: (): ExperimentalState => ({ eneFrameBurst: isMainWindow && getPath(snapshot, ENE_FRAME_BURST_KEY) === true, forcedByEnv }),
    async setEneFrameBurst(enabled) {
      if (typeof enabled !== 'boolean') throw new TypeError('setEneFrameBurst expects a boolean');
      const next = (await ipcRenderer.invoke(INTERNAL_CHANNELS.experimentalSet, enabled)) as Partial<ExperimentalState> | null;
      // The snapshot now (main's broadcast of the same write may arrive after this reply).
      setPath(snapshot, ENE_FRAME_BURST_KEY, next?.eneFrameBurst === true);
    },
  };

  return {
    ipc,
    store,
    nodeApi,
    evnia: { hubToken: boot.hubToken, platform: 'linux', experimental },
    noop: () => {},
    electronLog,
  };
}
