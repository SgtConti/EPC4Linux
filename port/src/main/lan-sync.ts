// The LAN colour sync setting in main (config.json "linuxLanSync", not a vendor key; impl-electron-shell "Persisted
// settings"): {"enabled": boolean, "host": "192.168.1.20", "port": 39501, "path": "/"}. While Follow Video runs, its colours also go
// to a Hubitat hub or Home Assistant on the local network (backend/ambiglow/lan-sync.ts; receivers in hubitat/, home-assistant/).
//
// config.json is the one source of truth, like experimental.ts. The Ambiglow page's "Send colours to Hubitat / Home Assistant" row (the
// LAN-COLOR-SYNC patch, scripts/ui-patches.mjs) writes it through window.__EVNIA__.lanSync → INTERNAL_CHANNELS.lanSyncSet
// → ipc.ts (main window only) → set() here; whoever else changes the key (window.store, a hand-edited file before start)
// is followed too. Every change
//   1. opens or closes the egress guard's one LAN exception for exactly that address (egress-guard.ts
//      setAllowedLanPeers), before
//   2. the backend gets the setting (AmbiglowService.setLanSync), so the first request is never refused.
// The backend is created with the stored value (BackendHost lanSync). An invalid stored value counts as off.
//
// Pure apart from the injected store, backend and egress hook, so the unit tests use the real ConfigStore.

import { describeLanTarget, normalizeLanSyncSettings, parseLanSyncAddress, type LanSyncSettings } from '../backend/ambiglow/lan-address.ts';
import type { Logger } from '../backend/types.ts';
import type { LanSyncChange } from './shared/channels.ts';
import { LAN_SYNC_KEY } from './shared/store-schema.ts';
import type { ConfigStore } from './store.ts';

/** What the setting needs of the backend host (BackendHost.setLanSync). */
export interface LanSyncBackend {
  setLanSync(settings: LanSyncSettings): void;
}

export interface LanSyncControllerOptions {
  store: Pick<ConfigStore, 'get' | 'set' | 'onChange'>;
  backend: LanSyncBackend;
  /** egress-guard.ts setAllowedLanPeers: the addresses Node may connect to besides loopback. */
  allowPeers: (hosts: readonly string[]) => void;
  log: Logger;
}

export class LanSyncController {
  readonly #o: LanSyncControllerOptions;
  readonly #unsubscribe: () => void;
  #applied: LanSyncSettings;

  constructor(o: LanSyncControllerOptions) {
    this.#o = o;
    this.#applied = this.settings;
    o.allowPeers(this.#applied.enabled ? [this.#applied.host] : []);
    this.#unsubscribe = o.store.onChange((key) => {
      if (key === LAN_SYNC_KEY || key.startsWith(`${LAN_SYNC_KEY}.`)) this.#apply();
    });
  }

  /** The stored setting, normalized (enabled only with a private IPv4 address). */
  get settings(): LanSyncSettings {
    return normalizeLanSyncSettings(this.#o.store.get(LAN_SYNC_KEY));
  }

  /**
   * The Ambiglow page's row (ipc.ts checked the sender): `enabled` and/or `address` ("192.168.1.20[:port]" for Hubitat,
   * "http://192.168.1.20:8123/api/webhook/<id>" for Home Assistant; lan-address.ts parseLanSyncAddress). An
   * invalid address throws (with a text for the user) and changes nothing; turning it on without an address throws
   * too. The same setting again writes nothing. Returns the new setting.
   */
  set(change: LanSyncChange): LanSyncSettings {
    if (change === null || typeof change !== 'object') throw new TypeError('lanSync.set expects {enabled?, address?}');
    const next = { ...this.settings };
    if (change.address !== undefined) {
      if (typeof change.address !== 'string') throw new TypeError('lanSync.set: address must be a string');
      if (change.address.trim() === '') {
        next.host = '';
        next.enabled = false;
      } else {
        const parsed = parseLanSyncAddress(change.address);
        if ('error' in parsed) throw new Error(`Address not saved: ${parsed.error}`);
        next.host = parsed.host;
        next.port = parsed.port;
        next.path = parsed.path;
      }
    }
    if (change.enabled !== undefined) {
      if (typeof change.enabled !== 'boolean') throw new TypeError('lanSync.set: enabled must be a boolean');
      if (change.enabled && next.host === '') throw new Error('Enter the Hubitat IP address or the Home Assistant webhook URL first');
      next.enabled = change.enabled;
    }
    const current = this.settings;
    if (next.enabled !== current.enabled || next.host !== current.host || next.port !== current.port || next.path !== current.path) {
      this.#o.log.info(`LAN colour sync ${next.enabled ? 'on' : 'off'}, target ${describeLanTarget(next)} (config.json ${LAN_SYNC_KEY})`);
      this.#o.store.set(LAN_SYNC_KEY, { enabled: next.enabled, host: next.host, port: next.port, path: next.path });
    }
    return this.settings;
  }

  /** The stored setting changed (any writer): egress exception first, then the backend; only effective changes. */
  #apply(): void {
    const s = this.settings;
    const a = this.#applied;
    this.#applied = s;
    // Off is off: an address saved while the sync is off changes nothing for the guard or the backend.
    if (!s.enabled && !a.enabled) return;
    if (s.enabled === a.enabled && s.host === a.host && s.port === a.port && s.path === a.path) return;
    this.#o.allowPeers(s.enabled ? [s.host] : []);
    this.#o.backend.setLanSync(s);
  }

  dispose(): void {
    this.#unsubscribe();
  }
}
