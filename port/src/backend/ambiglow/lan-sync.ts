// LAN colour sync: Follow Video colours → a smart-home hub on the local network, Hubitat or Home Assistant (port feature,
// not in the vendor app; docs/port/impl-ambiglow.md §11, hubitat/README.md, home-assistant/README.md).
//
// The FollowVideoEngine hands every captured 50×40 frame to this sender while the uploads run (not paused), and null
// when the capture stops or pauses (idle lights-off, another effect, the service stopping). The sender reduces a frame
// to five average colours — the whole screen and a left/right/top/bottom border band — and POSTs them as one small
// JSON document to the receiver (lan-address.ts): Hubitat's LAN port (TCP 39501, delivered to the device whose network
// id is the sender's IP or MAC address; the "Ambient Color Receiver" driver of hubitat/) or a Home Assistant webhook
// (the "Ambient Color Sync" integration of home-assistant/, /api/webhook/<id> on port 8123). "The hub" below is either.
//
//   {"source":"EPC4Linux","version":1,"seq":17,"active":true,"color":[r,g,b],
//    "zones":{"left":[r,g,b],"right":[r,g,b],"top":[r,g,b],"bottom":[r,g,b]}}
//   {"source":"EPC4Linux","version":1,"seq":18,"active":false}      (the stream ended: the hub may restore its lights)
//
// Pacing: a document goes out only when a colour changed noticeably (LAN_SYNC_CHANGE_DELTA), at most every
// lanSyncMinInterval() — LAN_SYNC_MIN_INTERVAL_MS (20 per second) for Home Assistant, which paces each light itself
// with backpressure, so the screen's own capture rate (the Follow Video Speed: 100 ms Normal, 40 ms High) is the limit;
// LAN_SYNC_HUBITAT_INTERVAL_MS for Hubitat, whose hub parses every LAN message in its driver — and with a heartbeat every
// LAN_SYNC_HEARTBEAT_MS while the screen is static (the receiver's "source went away" timeout). One request at a time,
// newest colours win, nothing is queued; Home Assistant's connection is kept open between requests. While the hub does
// not answer, attempts slow to LAN_SYNC_FAILING_INTERVAL_MS and the failure is logged once (and its end once).
//
// Nothing online (ARCHITECTURE rule 4): the destination must be a private IPv4 literal (RFC 1918 or link-local); host
// names are refused (no DNS lookup ever happens), and main's egress guard lets the Node side reach exactly that one
// address (src/main/egress-guard.ts setAllowedLanPeers). The address rules are lan-address.ts; the setting is off unless the user turns it on
// (config.json linuxLanSync, src/main/lan-sync.ts).

import http from 'node:http';
import type { CaptureFrame, Logger } from '../types.ts';
import { describeLanTarget, LAN_SYNC_OFF, normalizeLanSyncSettings, type LanSyncSettings } from './lan-address.ts';
import { realTimers, type EffectTimers } from './timers.ts';

export * from './lan-address.ts';

/** At most one document per this interval to Home Assistant (20 per second): the integration paces each light itself. */
export const LAN_SYNC_MIN_INTERVAL_MS = 50;
/** At most one document per this interval to Hubitat (5 per second): its driver parses each one on the hub. */
export const LAN_SYNC_HUBITAT_INTERVAL_MS = 200;
/** A document at least this often while active, even for a static screen (the hub's inactivity timeout is 15 s). */
export const LAN_SYNC_HEARTBEAT_MS = 5000;
/** Interval between attempts while the hub does not answer. */
export const LAN_SYNC_FAILING_INTERVAL_MS = 2000;
/** The request timeout (connect + answer). */
export const LAN_SYNC_TIMEOUT_MS = 2000;
/** A colour channel of any zone must move by at least this much (0..255) for a new document. */
export const LAN_SYNC_CHANGE_DELTA = 4;
/** The share of the width (left/right) and height (top/bottom) a border zone averages. */
export const LAN_SYNC_BAND = 0.2;

export type Rgb = [number, number, number];

export interface ColorZones {
  all: Rgb;
  left: Rgb;
  right: Rgb;
  top: Rgb;
  bottom: Rgb;
}

const ZONE_NAMES = ['all', 'left', 'right', 'top', 'bottom'] as const;

// ───────────────────────────── colours ─────────────────────────────

/**
 * The five average colours of an RGBA frame (CaptureFrame: 50×40): the whole screen, and the left, right, top and
 * bottom bands of LAN_SYNC_BAND of the width or height (at least one column or row).
 */
export function frameZones(frame: Pick<CaptureFrame, 'width' | 'height' | 'data'>): ColorZones {
  const { width: w, height: h, data } = frame;
  const bandX = Math.max(1, Math.round(w * LAN_SYNC_BAND));
  const bandY = Math.max(1, Math.round(h * LAN_SYNC_BAND));
  const sums = ZONE_NAMES.map(() => [0, 0, 0, 0]);
  const add = (z: number, i: number) => {
    const s = sums[z];
    s[0] += data[i];
    s[1] += data[i + 1];
    s[2] += data[i + 2];
    s[3]++;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      add(0, i);
      if (x < bandX) add(1, i);
      if (x >= w - bandX) add(2, i);
      if (y < bandY) add(3, i);
      if (y >= h - bandY) add(4, i);
    }
  }
  const avg = (s: number[]): Rgb => (s[3] === 0 ? [0, 0, 0] : [Math.round(s[0] / s[3]), Math.round(s[1] / s[3]), Math.round(s[2] / s[3])]);
  return { all: avg(sums[0]), left: avg(sums[1]), right: avg(sums[2]), top: avg(sums[3]), bottom: avg(sums[4]) };
}

/** The largest channel difference between two zone sets (Infinity when there is no previous one). */
export function zonesDelta(a: ColorZones, b: ColorZones | null): number {
  if (!b) return Infinity;
  let d = 0;
  for (const z of ZONE_NAMES) for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a[z][c] - b[z][c]));
  return d;
}

/** The JSON document of one update (see the header). */
export function lanSyncDocument(seq: number, zones: ColorZones | null): string {
  if (!zones) return JSON.stringify({ source: 'EPC4Linux', version: 1, seq, active: false });
  const { all, ...border } = zones;
  return JSON.stringify({ source: 'EPC4Linux', version: 1, seq, active: true, color: all, zones: border });
}

// ───────────────────────────── transport ─────────────────────────────

/** The minimum interval between documents for a target: Hubitat (path '/') or a Home Assistant webhook (any other path). */
export function lanSyncMinInterval(target: Pick<LanSyncSettings, 'path'>): number {
  return target.path === '/' ? LAN_SYNC_HUBITAT_INTERVAL_MS : LAN_SYNC_MIN_INTERVAL_MS;
}

/** One kept-open connection for Home Assistant (aiohttp keeps it alive): no TCP handshake per document at 20 per second. */
const keepAlive = new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 10_000 });

/**
 * POST `body` (JSON) to http://host:port<path>; resolves on any HTTP answer, rejects on a socket error or the timeout.
 * Hubitat (path '/') gets one connection per request, as its LAN port expects; a webhook reuses a kept-open one.
 */
export type LanPost = (host: string, port: number, path: string, body: string, timeoutMs: number) => Promise<number>;

export const httpPost: LanPost = (host, port, path, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method: 'POST',
        path,
        agent: path === '/' ? false : keepAlive,
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...(path === '/' ? { Connection: 'close' } : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });

// ───────────────────────────── sender ─────────────────────────────

export interface LanColorSenderOptions {
  log: Logger;
  settings?: LanSyncSettings;
  timers?: EffectTimers;
  now?: () => number;
  post?: LanPost;
}

export class LanColorSender {
  readonly #log: Logger;
  readonly #timers: EffectTimers;
  readonly #now: () => number;
  readonly #post: LanPost;
  #settings: LanSyncSettings = { ...LAN_SYNC_OFF };
  /** Colours of the newest frame while the stream is active; null while inactive. */
  #latest: ColorZones | null = null;
  /** The colours the hub got last (null: none since the stream became active). */
  #sentZones: ColorZones | null = null;
  #sentAt = -Infinity;
  /** The hub was told the stream is active and has not been told it ended. */
  #hubActive = false;
  #inFlight: Promise<void> | null = null;
  #wake: unknown = null;
  #seq = 0;
  #sent = 0;
  #failing = false;

  constructor(o: LanColorSenderOptions) {
    this.#log = o.log;
    this.#timers = o.timers ?? realTimers;
    this.#now = o.now ?? (() => Date.now());
    this.#post = o.post ?? httpPost;
    this.configure(o.settings ?? LAN_SYNC_OFF, { quiet: true });
  }

  get settings(): LanSyncSettings {
    return { ...this.#settings };
  }

  /** Documents handed to the transport since construction. */
  get sent(): number {
    return this.#sent;
  }

  /** The last attempt failed (and none succeeded since). */
  get failing(): boolean {
    return this.#failing;
  }

  /**
   * A new setting (normalized: enabled only with a private address). The same setting again is a no-op. Turning it
   * off, or pointing it elsewhere, first tells the old hub that the stream ended (so it can restore its lights).
   */
  configure(next: LanSyncSettings, options: { quiet?: boolean } = {}): void {
    const s = normalizeLanSyncSettings(next);
    const old = this.#settings;
    if (s.enabled === old.enabled && s.host === old.host && s.port === old.port && s.path === old.path) return;
    if (this.#hubActive && old.enabled) void this.#attempt(old, lanSyncDocument(++this.#seq, null));
    this.#settings = s;
    this.#hubActive = false;
    this.#sentZones = null;
    this.#sentAt = -Infinity;
    this.#failing = false;
    this.#clearWake();
    if (!options.quiet) this.#log.info(s.enabled ? `LAN colour sync on: Follow Video colours to ${describeLanTarget(s)}` : 'LAN colour sync off');
    if (s.enabled && this.#latest) this.#pump();
  }

  /** A captured frame while the Follow Video uploads run, or null: the stream ended (paused, stopped). */
  push(frame: CaptureFrame | null): void {
    if (frame === null) {
      if (this.#latest === null && !this.#hubActive) return;
      this.#latest = null;
      this.#clearWake();
      this.#pump();
      return;
    }
    if (!this.#settings.enabled) return;
    this.#latest = frameZones(frame);
    this.#pump();
  }

  /** The service stops: tell the hub the stream ended, waiting at most `timeoutMs` for it; no further documents. */
  async close(timeoutMs = 1000): Promise<void> {
    this.push(null);
    const pending = this.#drain();
    let timer: unknown = null;
    await Promise.race([pending, new Promise<void>((r) => (timer = this.#timers.setTimeout(r, timeoutMs)))]);
    if (timer !== null) this.#timers.clearTimeout(timer);
    this.#clearWake();
  }

  /** Until no request is in flight and nothing else is due (the end-of-stream document included). */
  async #drain(): Promise<void> {
    while (this.#inFlight) await this.#inFlight;
  }

  #clearWake(): void {
    if (this.#wake !== null) this.#timers.clearTimeout(this.#wake);
    this.#wake = null;
  }

  #schedule(ms: number): void {
    this.#clearWake();
    this.#wake = this.#timers.setTimeout(() => {
      this.#wake = null;
      this.#pump();
    }, Math.max(0, ms));
  }

  /** Send what is due now, or schedule the next look; one request at a time. */
  #pump(): void {
    if (this.#inFlight || !this.#settings.enabled) return;
    const zones = this.#latest;
    if (zones === null) {
      if (this.#hubActive) this.#send(null);
      return;
    }
    const now = this.#now();
    const minGap = this.#failing ? LAN_SYNC_FAILING_INTERVAL_MS : lanSyncMinInterval(this.#settings);
    const since = now - this.#sentAt;
    const changed = !this.#hubActive || zonesDelta(zones, this.#sentZones) >= LAN_SYNC_CHANGE_DELTA;
    if (!changed && since < LAN_SYNC_HEARTBEAT_MS) {
      this.#schedule(LAN_SYNC_HEARTBEAT_MS - since);
      return;
    }
    if (since < minGap) {
      this.#schedule(minGap - since);
      return;
    }
    this.#send(zones);
  }

  #send(zones: ColorZones | null): void {
    this.#clearWake();
    this.#sentAt = this.#now();
    this.#sentZones = zones;
    this.#hubActive = zones !== null;
    const done = this.#attempt(this.#settings, lanSyncDocument(++this.#seq, zones));
    this.#inFlight = done.finally(() => {
      this.#inFlight = null;
      this.#pump();
    });
  }

  /** One POST; logs the first failure of a streak and its end. Never rejects. */
  async #attempt(target: LanSyncSettings, body: string): Promise<void> {
    this.#sent++;
    try {
      const status = await this.#post(target.host, target.port, target.path, body, LAN_SYNC_TIMEOUT_MS);
      if (target !== this.#settings) return;
      if (this.#failing) this.#log.info(`LAN colour sync: ${describeLanTarget(target)} answers again (HTTP ${status})`);
      else if (this.#sent === 1 || status >= 400) this.#log.info(`LAN colour sync: ${describeLanTarget(target)} answered HTTP ${status}`);
      this.#failing = false;
    } catch (e) {
      if (target !== this.#settings) return;
      if (!this.#failing) {
        this.#log.warn(
          `LAN colour sync: ${describeLanTarget(target)} not reachable (${e instanceof Error ? e.message : String(e)}); retrying every ${LAN_SYNC_FAILING_INTERVAL_MS / 1000} s`,
        );
      }
      this.#failing = true;
    }
  }
}
