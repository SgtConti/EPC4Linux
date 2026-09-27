// Rate limit for the hub's "rejected …" warnings (docs/port/impl-hub-rpc.md §4).
//
// Any web page open in the user's browser can make it hit 127.0.0.1:<port> as often as it likes: a
// `new WebSocket(...)` with its own Origin, an <img> or fetch() to some path. The vendor host never
// logged these; one warn line per attempt would let such a page fill the persisted backend log and
// bury real diagnostics. So, per kind of rejection, only the first `burst` rejections of a window are
// logged individually; the rest are counted and reported in one summary line when the window ends.
// Times are monotonic milliseconds supplied by the caller (the hub's ticker drives flush()).

import type { Logger } from '../types.ts';

export const REJECTION_LOG_DEFAULTS = {
  /** Rejections of one kind logged individually per window. */
  burst: 5,
  /** Window length. */
  windowMs: 60_000,
} as const;

interface Window {
  readonly openedAt: number;
  logged: number;
  suppressed: number;
}

export class RejectionLog {
  readonly #log: Logger;
  readonly #burst: number;
  readonly #windowMs: number;
  readonly #windows = new Map<string, Window>();

  constructor(log: Logger, burst: number = REJECTION_LOG_DEFAULTS.burst, windowMs: number = REJECTION_LOG_DEFAULTS.windowMs) {
    this.#log = log;
    this.#burst = burst;
    this.#windowMs = windowMs;
  }

  /** Log `message` at warn unless `kind` already used up its burst in the current window. */
  record(kind: string, message: string, now: number): void {
    this.flush(now);
    let w = this.#windows.get(kind);
    if (!w) this.#windows.set(kind, (w = { openedAt: now, logged: 0, suppressed: 0 }));
    if (w.logged < this.#burst) {
      w.logged++;
      this.#log.warn(w.logged === this.#burst ? `${message} (further rejections of this kind are summarized)` : message);
    } else {
      w.suppressed++;
    }
  }

  /** End every window older than the window length (all of them for `now = Infinity`), reporting what it suppressed. */
  flush(now: number): void {
    for (const [kind, w] of this.#windows) {
      if (now - w.openedAt < this.#windowMs) continue;
      this.#windows.delete(kind);
      if (w.suppressed > 0) this.#log.warn(`${w.suppressed} more rejected hub request(s) not logged individually (${kind})`);
    }
  }
}
