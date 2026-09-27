// `<userData>/config.json`, file-compatible with electron-store 8 / conf as used by the vendor main
// and preload (01 §6, 02 §2.2): one tab-indented JSON object, defaults merged into the file,
// `__internal__.migrations.version` stamped. The main process is the single writer; renderers hold a
// synchronous snapshot (src/preload) and write through IPC, so there is one source of truth instead of
// the vendor's two electron-store instances racing on the same file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../backend/types.ts';
import {
  type StoreData,
  cloneJson,
  coerceForced,
  deletePath,
  getPath,
  normalizeStoreData,
  serializeStore,
  setPath,
  splitKeyPath,
  writeError,
} from './shared/store-schema.ts';

export type StoreChangeListener = (key: string, value: unknown) => void;

export class ConfigStore {
  readonly path: string;
  readonly #log: Logger;
  #data: StoreData;
  readonly #listeners = new Set<StoreChangeListener>();

  constructor(path: string, log: Logger) {
    this.path = path;
    this.#log = log;
    this.#data = this.#load();
    const changes = normalizeStoreData(this.#data);
    if (changes.length > 0) {
      this.#log.info(`config.json normalized: ${changes.join(', ')}`);
      this.#persist();
    }
  }

  get<T = unknown>(key: string): T | undefined {
    return cloneJson(getPath(this.#data, key)) as T | undefined;
  }

  /**
   * electron-store `set(key, value)`. Throws like electron-store on invalid writes. Pinned keys keep
   * their forced value (the call is accepted but has no effect).
   */
  set(key: string, value: unknown): void {
    const err = writeError(key, value);
    if (err) throw new TypeError(err);
    const parts = splitKeyPath(key)!;
    const stored = parts.length === 1 ? coerceForced(parts[0], value) : value;
    setPath(this.#data, key, cloneJson(stored));
    this.#persist();
    this.#notify(key, stored);
  }

  delete(key: string): void {
    if (!deletePath(this.#data, key)) return;
    this.#persist();
    this.#notify(key, undefined);
  }

  /** Whole store (defaults applied), deep-copied, for renderer snapshots. */
  snapshot(): StoreData {
    return cloneJson(this.#data);
  }

  onChange(listener: StoreChangeListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify(key: string, value: unknown): void {
    for (const l of this.#listeners) {
      try {
        l(key, cloneJson(value));
      } catch (e) {
        this.#log.error('Store listener failed', e);
      }
    }
  }

  #load(): StoreData {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.#log.error(`Cannot read ${this.path}`, e);
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as StoreData;
      throw new SyntaxError('top level is not an object');
    } catch (e) {
      // The vendor crashed on an unparseable file; keep the broken copy for the user and start clean.
      const backup = `${this.path}.invalid-${Date.now()}`;
      try {
        renameSync(this.path, backup);
      } catch {
        // best effort: the file is rewritten below either way
      }
      this.#log.error(`config.json is not valid JSON (${(e as Error).message}); moved to ${backup}`);
      return {};
    }
  }

  #persist(): void {
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, serializeStore(this.#data), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (e) {
      this.#log.error(`Cannot write ${this.path}`, e);
    }
  }
}
