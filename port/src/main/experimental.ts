// The port's opt-in experiments (config.json "linuxExperimental", not a vendor key; impl-electron-shell "Persisted
// settings"). Today one: {"eneFrameBurst": boolean}, the "Fast LED upload (experimental)" checkbox that the
// FAST-LED-UPLOAD patch adds to the Ambiglow page (scripts/ui-patches.mjs): follow-video frames go to the ENE as one
// control transfer instead of six paced writes (impl-usb-ene §2.2).
//
// config.json is the one source of truth. The checkbox writes it through window.__EVNIA__.experimental →
// INTERNAL_CHANNELS.experimentalSet → ipc.ts (main window only, a boolean only) → setEneFrameBurst() here; whoever
// else changes the key (window.store) is followed too. Every change reaches the backend at once
// (AmbiglowService.setEneFrameBurst, from the next frame), and the backend is created with the stored value
// (BackendHost eneFrameBurst). EVNIA_ENE_FRAME_BURST=1 in the environment keeps the burst on whatever the setting; the
// checkbox then shows ticked and disabled (forcedByEnv).
//
// Pure apart from the injected store and backend, so the unit tests use the real ConfigStore.

import type { Logger } from '../backend/types.ts';
import type { ExperimentalState } from './shared/channels.ts';
import { ENE_FRAME_BURST_KEY, EXPERIMENTAL_KEY } from './shared/store-schema.ts';
import type { ConfigStore } from './store.ts';

/** What the settings need of the backend host (BackendHost.setEneFrameBurst). */
export interface ExperimentalBackend {
  setEneFrameBurst(enabled: boolean): void;
}

export interface ExperimentalSettingsOptions {
  store: Pick<ConfigStore, 'get' | 'set' | 'onChange'>;
  backend: ExperimentalBackend;
  /** EVNIA_ENE_FRAME_BURST=1 (ene.ts eneFrameBurstFromEnv). */
  forcedByEnv: boolean;
  log: Logger;
}

export class ExperimentalSettings {
  readonly #o: ExperimentalSettingsOptions;
  readonly #unsubscribe: () => void;

  constructor(o: ExperimentalSettingsOptions) {
    this.#o = o;
    this.#unsubscribe = o.store.onChange((key) => {
      if (key === EXPERIMENTAL_KEY || key === ENE_FRAME_BURST_KEY) o.backend.setEneFrameBurst(this.eneFrameBurst);
    });
    if (o.forcedByEnv) o.log.info('EVNIA_ENE_FRAME_BURST=1: the ENE frame burst is on whatever the "Fast LED upload (experimental)" setting');
  }

  /** The stored "Fast LED upload (experimental)" setting: config.json linuxExperimental.eneFrameBurst, on only when exactly true. */
  get eneFrameBurst(): boolean {
    return this.#o.store.get(ENE_FRAME_BURST_KEY) === true;
  }

  /** window.__EVNIA__.experimental.get() of the main window. */
  state(): ExperimentalState {
    return { eneFrameBurst: this.eneFrameBurst, forcedByEnv: this.#o.forcedByEnv };
  }

  /**
   * The checkbox (ipc.ts checked the sender and the type; this checks the type again): store it; the store listener
   * hands the change to the backend. The same value again writes nothing. Returns the new state.
   */
  setEneFrameBurst(enabled: boolean): ExperimentalState {
    if (typeof enabled !== 'boolean') throw new TypeError('setEneFrameBurst expects a boolean');
    if (this.eneFrameBurst !== enabled) {
      this.#o.log.info(`"Fast LED upload (experimental)" ${enabled ? 'on' : 'off'} (config.json ${ENE_FRAME_BURST_KEY})`);
      this.#o.store.set(ENE_FRAME_BURST_KEY, enabled);
    }
    return this.state();
  }

  dispose(): void {
    this.#unsubscribe();
  }
}
