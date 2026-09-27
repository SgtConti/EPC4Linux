// Device-change fan-out with the vendor's exact debounce/throttle/shield semantics (01 §9,
// work/app-pretty/main/index.js:17650-17683).
//
//   displayChange       trailing debounce 2000 ms; the shield is checked on entry and again at fire time.
//   USBChange           leading-edge throttle: lock, send after 1000 ms unless shielded then, unlock at 2000 ms.
//   otherDeviceChange   same as USBChange but the send is delayed 1700 ms.
//   shieldDisplayChange(flag, seconds=4)   flag || !seconds → shield = flag; else clear the shield after seconds.
//   shieldPeripheralChange(flag)           shields USBChange and otherDeviceChange together.
//
// Timers are injectable so the logic is unit-tested with mocked time.

import type { Logger } from '../backend/types.ts';

export type DeviceEventName = 'displayChange' | 'USBChange' | 'otherDeviceChange';

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export const DISPLAY_DEBOUNCE_MS = 2000;
export const USB_SEND_DELAY_MS = 1000;
export const OTHER_DEVICE_SEND_DELAY_MS = 1700;
export const THROTTLE_LOCK_MS = 2000;
export const DEFAULT_SHIELD_SECONDS = 4;

export class DeviceChangeGate {
  readonly #emit: (name: DeviceEventName) => void;
  readonly #log: Logger;
  readonly #timers: TimerApi;
  readonly #shield: Partial<Record<DeviceEventName, boolean>> = {};
  readonly #locked: Partial<Record<DeviceEventName, boolean>> = {};
  readonly #pending = new Set<unknown>();
  #displayTimer: unknown = undefined;
  #shieldDisplayTimer: unknown = undefined;

  constructor(emit: (name: DeviceEventName) => void, log: Logger, timers: TimerApi = realTimers) {
    this.#emit = emit;
    this.#log = log;
    this.#timers = timers;
  }

  /** Raw event from a source (screen, libusb hotplug). */
  trigger(name: DeviceEventName): void {
    if (this.#shield[name]) {
      this.#log.info(`${name} change return by shieldState true`, Date.now());
      return;
    }
    if (name === 'displayChange') {
      if (this.#displayTimer !== undefined) this.#clear(this.#displayTimer);
      this.#displayTimer = this.#after(DISPLAY_DEBOUNCE_MS, () => {
        this.#displayTimer = undefined;
        this.#fire(name);
      });
      return;
    }
    if (this.#locked[name]) return;
    this.#locked[name] = true;
    this.#after(name === 'otherDeviceChange' ? OTHER_DEVICE_SEND_DELAY_MS : USB_SEND_DELAY_MS, () => this.#fire(name));
    this.#after(THROTTLE_LOCK_MS, () => {
      this.#locked[name] = false;
    });
  }

  /** IPC shieldDisplayChange (01 §10.1 #27). */
  shieldDisplayChange(flag: boolean, seconds: number = DEFAULT_SHIELD_SECONDS): void {
    if (this.#shieldDisplayTimer !== undefined) {
      this.#clear(this.#shieldDisplayTimer);
      this.#shieldDisplayTimer = undefined;
    }
    if (flag || !seconds) {
      this.#shield.displayChange = flag;
      return;
    }
    this.#shieldDisplayTimer = this.#after(seconds * 1000, () => {
      this.#shieldDisplayTimer = undefined;
      this.#shield.displayChange = false;
    });
  }

  /** IPC shieldPeripheralChange (01 §10.1 #28). */
  shieldPeripheralChange(flag: boolean): void {
    this.#shield.USBChange = flag;
    this.#shield.otherDeviceChange = flag;
  }

  isShielded(name: DeviceEventName): boolean {
    return this.#shield[name] === true;
  }

  dispose(): void {
    for (const h of this.#pending) this.#timers.clearTimeout(h);
    this.#pending.clear();
    this.#displayTimer = undefined;
    this.#shieldDisplayTimer = undefined;
  }

  #fire(name: DeviceEventName): void {
    if (this.#shield[name]) {
      this.#log.info(`${name} return by shieldState true`, Date.now());
      return;
    }
    this.#log.info(`${name} send`, Date.now());
    this.#emit(name);
  }

  #after(ms: number, fn: () => void): unknown {
    const handle: unknown = this.#timers.setTimeout(() => {
      this.#pending.delete(handle);
      fn();
    }, ms);
    this.#pending.add(handle);
    return handle;
  }

  #clear(handle: unknown): void {
    this.#pending.delete(handle);
    this.#timers.clearTimeout(handle);
  }
}
