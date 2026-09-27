// DdcChannel for one monitor over its transports in priority order: VIA USB-DDC first, i2c-dev second
// (20 §2 decision D1; 06 §5.1).
//
// Timing and retries follow the hub implementation that carried all runtime traffic on the user's
// machine (Interface2.GetStandardData + Interface13 primitives; 08 §3.2/§4.1, 20 §2.5-2.8):
//   attempt (max 3):  write [VIA: 3 transfer tries, sleeping (n+1)*177 ms after each failure]
//                     sleep 100 ms (always, even after a failed write)          → failed write: next attempt
//                     sleep max(15, sleepTime - elapsed)   (sleepTime 100 for gets, 150 for TPV queries)
//                     read  [same transfer retries]; sleep 50 ms (not after the VIA A7+A9 capabilities read)
//                     validate: source 0x6E, 1 <= L <= N-3, checksum seeded with 0x50 → otherwise next attempt
// Sets are one write (+100 ms) on the hub and up to three on the GPU path (DDCHelper SetCIValue).
//
// Transport selection (20 §2.2) replaces the vendor's per-call "hub, then GPU" fallback, which costs
// about 3.5 s per call while a bridge is dead:
//   - a transport is used only after its support probe GetVCP(0x14) passed (08 §3.6 / 07 §3.4.2);
//   - the transport that last succeeded stays active ("sticky");
//   - an operation that exhausted its budget on the active transport is run once on the next usable one,
//     which becomes active on success — except one-shot actions, which are never replayed (rule 4);
//   - writing a USB-topology setting marks USB-DDC suspect until the next probe() (rule 5);
//   - probe() (called by the driver on display/USB detection) re-evaluates everything (rule 6).
// Locking (20 §2.4, D2; locks.ts): a whole operation holds this process's queue of every physical path
// of the channel (transport ids) and of the monitor key, so every channel and discovery run touching
// the same bridge, bus or monitor is serialized, whichever transport objects it uses. Each transaction
// (write, delays, read; or one set write) also holds the cross-process flock of its path and monitor.

import type { DdcChannel, DdcTransport, Logger, VcpValue } from '../types.ts';
import { sleep } from '../core/events.ts';
import {
  EXT_BASE,
  PROBE_VCP,
  buildDdcMessage,
  capsRequestPayload,
  checkReply,
  getExtPayload,
  getVcpPayload,
  hex2,
  parseCapsFragment,
  parseVcpReply,
  rawGetPayload,
  setExtPayload,
  setVcpPayload,
  standardReplyEcho,
} from './codec.ts';
import { readCapabilityString } from './capabilities.ts';
import { DdcError, errorText, isBusy, isDdcError } from './errors.ts';
import { type ProcessLock, resolveProcessLock, withPathLocks } from './locks.ts';

export interface DdcTimings {
  /** Sleep after every DDC write, successful or not (Interface1 imethod_2; DDCHelper DDCCIWrite): 100 ms. */
  postWriteMs: number;
  /** Minimum gap between the write helper returning and the read (GetStandardData): 15 ms. */
  minPreReadMs: number;
  /** GetStandardData `sleepTime` for VCP gets, raw GetDDC, GetSN and capability fragments: 100 ms. */
  getSleepMs: number;
  /** GetStandardData default `sleepTime`, used by the TPV identity queries and VCP C8 (imethod_7): 150 ms. */
  querySleepMs: number;
  /** Sleep after every DDC read (Interface1 imethod_3; DDCHelper DDCCIRead): 50 ms. */
  postReadMs: number;
  /** VIA transfer retry: sleep (n+1) × this after the n-th failed control transfer (Util.smethod_0): 177 ms. */
  transferBackoffMs: number;
  /** GPU-path support probe retries once after this delay (JudgeSupportDDCCI, 07 §3.4.2): 200 ms. */
  probeRetryMs: number;
  /** GPU-path capabilities are read a second time after this delay (Display.InitDisplayVcpCode): 2000 ms. */
  capsRetryMs: number;
  /** Delay between retries of one identity query (Interface8 GetMonitorInfo): 150 ms. */
  identityRetryMs: number;
}

export const VENDOR_TIMINGS: Readonly<DdcTimings> = Object.freeze({
  postWriteMs: 100,
  minPreReadMs: 15,
  getSleepMs: 100,
  querySleepMs: 150,
  postReadMs: 50,
  transferBackoffMs: 177,
  probeRetryMs: 200,
  capsRetryMs: 2000,
  identityRetryMs: 150,
});

/** All delays zero: for unit tests and the simulated monitor when speed matters more than realism. */
export const NO_DELAY_TIMINGS: Readonly<DdcTimings> = Object.freeze({
  postWriteMs: 0,
  minPreReadMs: 0,
  getSleepMs: 0,
  querySleepMs: 0,
  postReadMs: 0,
  transferBackoffMs: 0,
  probeRetryMs: 0,
  capsRetryMs: 0,
  identityRetryMs: 0,
});

/** Time source; injectable so tests can run on a virtual clock and assert the exact delays. */
export interface DdcClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: DdcClock = {
  now: () => performance.now(),
  sleep: (ms) => (ms > 0 ? sleep(ms) : Promise.resolve()),
};

/**
 * Writes that trigger an action (06 §6 "T"): restore defaults, window-mask commit, PIP swap, pixel and
 * panel refresh, Ambiglow reset, SmartImage reset, profile action. If the first attempt reached the
 * scaler, a replay would run the action twice (a swap would even undo itself), so they never fail over.
 */
export const ONE_SHOT_CODES: ReadonlySet<number> = new Set([0x04, 0xa4, 0xf6, 0xe2a036, 0xe2a037, 0xe2a038, 0xe2a042, 0xe2a06b]);

/** USB-C mode, USB upstream and KVM: writing them re-enumerates the monitor hub (20 §2.2 rule 5). */
export const USB_TOPOLOGY_CODES: ReadonlySet<number> = new Set([0xe2a012, 0xe2a014, 0xe2a015]);

/** GetStandardData attempts per operation (08 §3.2; DDCHelper uses the same count, 07 §4.8.1). */
const GET_ATTEMPTS = 3;

interface KindPolicy {
  /** Control-transfer attempts inside one write/read primitive (VIA: Util.smethod_0(fn, 3, 177)). */
  transferAttempts: number;
  /** Whether failed transfers back off by (n+1)*transferBackoffMs. */
  transferBackoff: boolean;
  /** Write attempts for a set (hub SetStandardData: 1; DDCHelper SetCIValue: 3). */
  setAttempts: number;
  /** Raw read lengths: 32 for every get on both paths (D3); capabilities 64 (A7+A9) or 38 (i2c). */
  readLength: { get: number; caps: number };
  /** The VIA A7+A9 capabilities read is not followed by the 50 ms read delay (Interface13.method_0). */
  capsPostRead: boolean;
  /** Support probe rule: USB-DDC (0 < value < 255 && max < 255) or DDC/CI (result code 0, one retry). */
  probe: 'usb-ddc' | 'ddc-ci';
  /** Whole capability reads (the GPU path retries once after capsRetryMs). */
  capsAttempts: number;
}

const POLICY: Readonly<Record<DdcTransport['kind'], KindPolicy>> = {
  'via-usb': { transferAttempts: 3, transferBackoff: true, setAttempts: 1, readLength: { get: 32, caps: 64 }, capsPostRead: false, probe: 'usb-ddc', capsAttempts: 1 },
  'i2c-dev': { transferAttempts: 1, transferBackoff: false, setAttempts: 3, readLength: { get: 32, caps: 38 }, capsPostRead: true, probe: 'ddc-ci', capsAttempts: 2 },
  mock: { transferAttempts: 1, transferBackoff: false, setAttempts: 3, readLength: { get: 32, caps: 64 }, capsPostRead: true, probe: 'ddc-ci', capsAttempts: 1 },
};

export interface TransportProbe {
  transportId: string;
  kind: DdcTransport['kind'];
  supported: boolean;
  value?: number;
  max?: number;
  resultCode?: number;
  error?: string;
}

// Probe results belong to the transport object, not to the path: discovery probes a VIA bridge on a
// short-lived channel and the monitor driver's channel over the same objects reuses the result, while
// a re-enumerated bridge (new objects from a new discovery run) is probed again. The queue, by
// contrast, belongs to the path (locks.ts).
const probeResults = new WeakMap<DdcTransport, TransportProbe>();

export interface DdcChannelOptions {
  log?: Logger;
  timings?: Partial<DdcTimings>;
  clock?: DdcClock;
  /**
   * Gate every transport on its support probe (default true). Discovery turns this off to identify a
   * VIA bridge in the vendor order (C8, model name, pairing) before running the probe (20 §2.3).
   */
  requireProbe?: boolean;
  /**
   * The monitor's key (DiscoveredMonitor.key, the EDID serial). It is added to the lock keys, so
   * every channel and every process talking to this monitor, over any path, is serialized (20 §2.4
   * `ddc-<serial>.lock`).
   */
  monitorKey?: string;
  /**
   * Cross-process lock held around each transaction. Default: flock files under
   * $XDG_RUNTIME_DIR/evnia (none without a runtime directory); null: none (simulators, unit tests).
   */
  processLock?: ProcessLock | null;
}

interface RunOptions<T> {
  /** False for one-shot actions: never retried on another transport after an attempt. */
  replay?: boolean;
  describe?: (result: T) => string;
  /** Runs inside the queue after success, with the transport that served the operation. */
  after?: (t: DdcTransport) => void;
}

interface ReadSpec {
  length: number;
  sleepTime: number;
  postRead: boolean;
}

export class DdcChannelImpl implements DdcChannel {
  readonly transports: readonly DdcTransport[];
  readonly timings: Readonly<DdcTimings>;
  readonly #log: Logger | undefined;
  readonly #clock: DdcClock;
  readonly #requireProbe: boolean;
  readonly #monitorKey: string | undefined;
  /** In-process queue keys: the path of every transport, plus the monitor key. */
  readonly #lockKeys: readonly string[];
  readonly #processLock: ProcessLock | null;
  #active: DdcTransport | null = null;
  #closed = false;

  constructor(transports: readonly DdcTransport[], options: DdcChannelOptions = {}) {
    this.transports = [...transports];
    this.timings = Object.freeze({ ...VENDOR_TIMINGS, ...options.timings });
    this.#log = options.log;
    this.#clock = options.clock ?? realClock;
    this.#requireProbe = options.requireProbe ?? true;
    this.#monitorKey = options.monitorKey;
    this.#lockKeys = [...this.transports.map((t) => t.id), ...(options.monitorKey ? [options.monitorKey] : [])];
    this.#processLock = resolveProcessLock(options.processLock);
  }

  /** The transport the next operation tries first (null until one succeeded, or after probe()). */
  get activeTransport(): DdcTransport | null {
    return this.#active;
  }

  async getVcp(code: number): Promise<VcpValue> {
    const payload = getVcpPayload(code);
    return this.#run(`getVcp 0x${hex2(code)}`, (t) => this.#getVcpOn(t, payload, code), { describe: describeVcp });
  }

  async setVcp(code: number, value: number): Promise<void> {
    const payload = setVcpPayload(code, value);
    return this.#run(`setVcp 0x${hex2(code)}=0x${value.toString(16)}`, (t) => this.#setOn(t, payload), { replay: !ONE_SHOT_CODES.has(code) });
  }

  async getExt(sub: number): Promise<VcpValue> {
    const payload = getExtPayload(sub);
    return this.#run(`getExt e2a0${hex2(sub).toLowerCase()}`, (t) => this.#getVcpOn(t, payload, null), { describe: describeVcp });
  }

  async setExt(sub: number, value: number): Promise<void> {
    const payload = setExtPayload(sub, value);
    const code = EXT_BASE | sub;
    return this.#run(`setExt e2a0${hex2(sub).toLowerCase()}=0x${value.toString(16)}`, (t) => this.#setOn(t, payload), {
      replay: !ONE_SHOT_CODES.has(code),
      after: (t) => this.#afterTopologyWrite(t, code),
    });
  }

  /**
   * Interface2.GetDDC: `01 <opcodeAndArgs>` then one validated reply, returned raw (starting with 0x6E).
   * `readLength` is the raw buffer size (default 32); `sleepMs` is GetStandardData's sleepTime (default
   * getSleepMs = 100; the identity queries pass querySleepMs = 150 like imethod_7).
   */
  async rawQuery(opcodeAndArgs: number[], readLength?: number, sleepMs?: number): Promise<Uint8Array> {
    const payload = rawGetPayload(opcodeAndArgs);
    return this.#run(`rawQuery ${opcodeAndArgs.map(hex2).join(' ')}`, (t) =>
      this.#transact(t, payload, { length: readLength ?? POLICY[t.kind].readLength.get, sleepTime: sleepMs ?? this.timings.getSleepMs, postRead: true }, (raw) => raw),
    );
  }

  async capabilities(): Promise<string> {
    return this.#run('capabilities', (t) => this.#capabilitiesOn(t), { describe: (s) => `${s.length} chars` });
  }

  /**
   * Run the support probe on every transport (again) and re-evaluate the active transport: the next
   * operation starts at the first usable transport in priority order. Results are shared with other
   * channels over the same transports.
   */
  async probe(): Promise<TransportProbe[]> {
    this.#assertOpen();
    return this.#queued(async () => {
      const out: TransportProbe[] = [];
      for (const t of this.transports) out.push(await this.#probeOn(t));
      this.#active = null;
      return out;
    });
  }

  /** Close the channel and its transports (the channel owns them). */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queued(async () => {
      for (const t of this.transports) {
        try {
          await t.close();
        } catch (e) {
          this.#log?.warn(`closing ${t.id} failed: ${errorText(e)}`);
        }
      }
    });
  }

  // ───────────────────────────── internals ─────────────────────────────

  #assertOpen(): void {
    if (this.#closed) throw new DdcError('closed', 'DDC channel is closed');
  }

  /** One whole operation: this process's queue of every path of the channel and of the monitor. */
  #queued<T>(fn: () => Promise<T>): Promise<T> {
    return withPathLocks(this.#lockKeys, fn);
  }

  /** One transaction on `t`: the cross-process lock of its path and of the monitor. */
  #exclusive<T>(t: DdcTransport, fn: () => Promise<T>): Promise<T> {
    const lock = this.#processLock;
    return lock ? lock.run(this.#monitorKey ? [t.id, this.#monitorKey] : [t.id], fn, this.#log) : fn();
  }

  /** Active transport first, then the others in priority order. */
  #order(): DdcTransport[] {
    const active = this.#active;
    return active ? [active, ...this.transports.filter((t) => t !== active)] : [...this.transports];
  }

  async #run<T>(op: string, fn: (t: DdcTransport) => Promise<T>, options: RunOptions<T> = {}): Promise<T> {
    this.#assertOpen();
    return this.#queued(async () => {
      const failures: string[] = [];
      let last: unknown;
      for (const t of this.#order()) {
        this.#assertOpen();
        if (this.#requireProbe) {
          const probe = probeResults.get(t) ?? (await this.#probeOn(t));
          if (!probe.supported) continue;
        }
        if (failures.length > 0 && options.replay === false) {
          this.#log?.warn(`${op}: one-shot action not replayed on ${t.id} after a failure`);
          break;
        }
        const started = this.#clock.now();
        try {
          const result = await fn(t);
          const ms = Math.round(this.#clock.now() - started);
          this.#log?.debug(`${op} via ${t.id}${options.describe ? ` -> ${options.describe(result)}` : ''} (${ms} ms)`);
          if (failures.length > 0) this.#log?.warn(`DDC failover: ${op} succeeded via ${t.id}; it is now the active transport`);
          this.#active = t;
          options.after?.(t);
          return result;
        } catch (e) {
          if (isBusy(e)) throw e; // another process is talking to the monitor: another path would interleave too
          last = e;
          failures.push(`${t.id}: ${errorText(e)}`);
          this.#log?.warn(`${op} failed via ${t.id}: ${errorText(e)}`);
        }
      }
      if (last === undefined) throw new DdcError('no-transport', `${op}: no DDC/CI transport passed the support probe`);
      const code = isDdcError(last) ? last.code : 'io';
      throw new DdcError(code, `${op} failed (${failures.join('; ')})`, undefined, { cause: last });
    });
  }

  /** Rule 5: the hub re-enumerates; prefer another probed transport until the driver probes again. */
  #afterTopologyWrite(t: DdcTransport, code: number): void {
    if (t.kind !== 'via-usb' || !USB_TOPOLOGY_CODES.has(code)) return;
    probeResults.delete(t);
    this.#active = this.transports.find((x) => x !== t && probeResults.get(x)?.supported) ?? null;
    this.#log?.info(`${t.id}: USB topology setting 0x${code.toString(16)} written; USB-DDC is re-probed before its next use`);
  }

  async #probeOn(t: DdcTransport): Promise<TransportProbe> {
    const policy = POLICY[t.kind];
    const tries = policy.probe === 'ddc-ci' ? 2 : 1;
    let result: TransportProbe = { transportId: t.id, kind: t.kind, supported: false };
    for (let i = 0; i < tries && !result.supported; i++) {
      if (i > 0) await this.#clock.sleep(this.timings.probeRetryMs);
      try {
        const v = await this.#getVcpOn(t, getVcpPayload(PROBE_VCP), PROBE_VCP);
        const supported = policy.probe === 'usb-ddc'
          ? v.value > 0 && v.value < 255 && v.max < 255
          : v.resultCode === 0;
        result = { transportId: t.id, kind: t.kind, supported, value: v.value, max: v.max, resultCode: v.resultCode };
      } catch (e) {
        if (isBusy(e)) throw e; // says nothing about the transport
        result = { transportId: t.id, kind: t.kind, supported: false, error: errorText(e) };
      }
    }
    const name = policy.probe === 'usb-ddc' ? 'CheckSupportUSBDDC' : 'JudgeSupportDDCCI';
    const detail = result.error ?? `value = 0x${hex2(result.value ?? 0)}, max = 0x${hex2(result.max ?? 0)}, rc = ${result.resultCode}`;
    this.#log?.info(`${name}(0x14) on ${t.id}: isSupport = ${result.supported}, ${detail}`);
    probeResults.set(t, result);
    return result;
  }

  async #getVcpOn(t: DdcTransport, payload: number[], echoCode: number | null): Promise<VcpValue> {
    const spec = { length: POLICY[t.kind].readLength.get, sleepTime: this.timings.getSleepMs, postRead: true };
    return this.#transact(t, payload, spec, (raw) => {
      const value = parseVcpReply(raw);
      const echo = echoCode === null ? null : standardReplyEcho(raw);
      if (echo && echo.code !== echoCode) {
        // The vendor never checks the echo; mismatches are only logged (07 §10 open question 1).
        this.#log?.warn(`VCP reply echoes 0x${hex2(echo.code)} for request 0x${hex2(echoCode ?? 0)} on ${t.id}`);
      }
      return value;
    });
  }

  async #setOn(t: DdcTransport, payload: number[]): Promise<void> {
    const message = buildDdcMessage(payload);
    let last: unknown;
    for (let attempt = 0; attempt < POLICY[t.kind].setAttempts; attempt++) {
      try {
        await this.#exclusive(t, () => this.#write(t, message));
        return;
      } catch (e) {
        if (isBusy(e)) throw e;
        last = e;
      }
    }
    throw last;
  }

  async #capabilitiesOn(t: DdcTransport): Promise<string> {
    const policy = POLICY[t.kind];
    const spec = { length: policy.readLength.caps, sleepTime: this.timings.getSleepMs, postRead: policy.capsPostRead };
    const fetch = (offset: number) => this.#transact(t, capsRequestPayload(offset), spec, parseCapsFragment);
    let last: unknown;
    for (let attempt = 0; attempt < policy.capsAttempts; attempt++) {
      if (attempt > 0) await this.#clock.sleep(this.timings.capsRetryMs);
      try {
        return await readCapabilityString(fetch, { log: this.#log });
      } catch (e) {
        if (isBusy(e)) throw e;
        last = e;
      }
    }
    throw last;
  }

  /** GetStandardData (08 §3.2): write, wait, read, validate, parse; up to GET_ATTEMPTS attempts. */
  async #transact<T>(t: DdcTransport, payload: number[], spec: ReadSpec, parse: (raw: Uint8Array) => T): Promise<T> {
    const message = buildDdcMessage(payload);
    let last: unknown;
    for (let attempt = 1; attempt <= GET_ATTEMPTS; attempt++) {
      let raw: Uint8Array;
      try {
        raw = await this.#exclusive(t, () => this.#exchange(t, message, spec));
      } catch (e) {
        if (isBusy(e)) throw e;
        last = e; // a failed write (then no read) or a failed read: next attempt
        continue;
      }
      const check = checkReply(raw);
      if (!check.ok) {
        last = new DdcError('invalid-reply', `invalid reply (${check.reason})`, t.id);
        this.#log?.debug(`attempt ${attempt} on ${t.id}: ${check.reason}`);
        continue;
      }
      try {
        return parse(raw);
      } catch (e) {
        if (!isDdcError(e) || e.code !== 'invalid-reply') throw e;
        last = new DdcError('invalid-reply', e.message, t.id);
      }
    }
    throw last;
  }

  /** One transaction: write (+100 ms), wait max(15, sleepTime - elapsed), read (+50 ms where due). */
  async #exchange(t: DdcTransport, message: Uint8Array, spec: ReadSpec): Promise<Uint8Array> {
    const started = this.#clock.now();
    await this.#write(t, message);
    const elapsed = this.#clock.now() - started;
    await this.#clock.sleep(Math.max(this.timings.minPreReadMs, spec.sleepTime - elapsed));
    return this.#read(t, spec.length, spec.postRead);
  }

  /** Write primitive with transfer retries, followed by the unconditional post-write delay. */
  async #write(t: DdcTransport, message: Uint8Array): Promise<void> {
    const error = await this.#withTransferRetries(t, () => t.write(message));
    await this.#clock.sleep(this.timings.postWriteMs);
    if (error !== undefined) throw toIoError(error, t, 'write');
  }

  /** Read primitive with transfer retries, followed by the post-read delay where the vendor has one. */
  async #read(t: DdcTransport, length: number, postRead: boolean): Promise<Uint8Array> {
    let data: Uint8Array | undefined;
    const error = await this.#withTransferRetries(t, async () => {
      data = await t.read(length);
    });
    if (postRead) await this.#clock.sleep(this.timings.postReadMs);
    if (error !== undefined || data === undefined) throw toIoError(error, t, 'read');
    return data;
  }

  /** Util.smethod_0(fn, repeat, 177): after the n-th failure sleep (n+1)*177 ms, the last one included. */
  async #withTransferRetries(t: DdcTransport, fn: () => Promise<void>): Promise<unknown> {
    const policy = POLICY[t.kind];
    let error: unknown;
    for (let n = 0; n < policy.transferAttempts; n++) {
      try {
        await fn();
        return undefined;
      } catch (e) {
        error = e;
        if (policy.transferBackoff) await this.#clock.sleep((n + 1) * this.timings.transferBackoffMs);
      }
    }
    return error ?? new Error('transfer failed');
  }
}

function toIoError(e: unknown, t: DdcTransport, what: string): DdcError {
  if (isDdcError(e)) return e;
  return new DdcError('io', `${what} failed: ${errorText(e)}`, t.id, { cause: e });
}

function describeVcp(v: VcpValue): string {
  return `value=0x${v.value.toString(16)} max=0x${v.max.toString(16)} rc=${v.resultCode}`;
}
