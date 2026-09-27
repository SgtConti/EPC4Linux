// ENE Ambiglow driver (USB 0cf2:a201): the Linux counterpart of Zeasn.USB.ENE.Lib's CUSBENE6K7732
// for one device (09 §3-§8).
//
//   EneDevice.open()     identification exactly as Ec_Init + CUSBENE6K7732.Plug (09 §3.4, §4.1)
//   setEffect()          CUSBENE6K7732.ParameterSet: 0x0023 switch + region sequence (09 §6);
//                        { suspended } records it while idle without lighting the LEDs
//   writeVideoFrame()    ParameterVideoSync / ParameterLedSync: 50×40 grid → frame buffer (09 §7.3)
//   writeAudioLevel()    ParameterAudioSync: level byte → E960..62 / E970..72 (09 §8.3)
//   lightsOff/lightsOn() EffectEnableTemp(false/true): idle suspend and resume (09 §11)
//   close()              UnPlug: 0x0023 ← 0, then release the USB handle (09 §4.2)
//   lost / isCurrent()   whether the device went away or re-enumerated (01 §9, 09 §16.8)
//
// One operation runs at a time (the vendor's threads could interleave register writes of a
// ParameterSet with frame or audio writes; here they queue). Timing and follow-video/audio
// scheduling belong to the effect engine above this driver.

import type { Logger, UsbBackend, UsbDeviceInfo } from '../types.ts';
import { Mutex } from '../core/events.ts';
import { UsbError } from '../usb/errors.ts';
import { isSameEnumeration } from '../usb/ids.ts';
import { findModelLayout, type EneModelLayout } from './ene-layout.ts';
import { burstFrameWrite, planFrame, renderFrame, type EneLedCounts, type FramePlan, type FrameWrite, type VideoGrid } from './ene-frame.ts';
import {
  audioLevelByte,
  audioLevelWrites,
  normalizeParameterSet,
  parameterSetWrites,
  releaseWrites,
  type EneParameterSet,
  type EneRegisterWrite,
} from './ene-params.ts';
import {
  ENE_CHIP_ID,
  ENE_FW_VERSION_LENGTH,
  ENE_MAX_LED_GROUPS,
  ENE_MODEL_NAME_MAX,
  ENE_PRODUCT_ID,
  ENE_VENDOR_ID,
  EneMode,
  EneReg,
  EneRegion,
} from './ene-registers.ts';
import { EneError, EneTransport, type EneTransportOptions } from './ene-transport.ts';

export interface EneIdentity {
  /** 0x4000:0x4001, 0x7730 for Evnia monitors. */
  chipId: number;
  /** 0x0244. */
  revision: number;
  /** 0x0415, logged only: EneEc.dll would run a flash trim-load when it reads 0; this port never does. */
  trimStatus: number;
  /** 0xE0A1 as read (the app uses at most 3 groups). */
  ledGroups: number;
  /** LED counts of groups 1..3 (0xE0A3/A5/A7); 0 for groups the device does not report. */
  counts: EneLedCounts;
  /** 0xE9F1.., e.g. "34M2C8600". */
  modelName: string;
  /** 5 bytes at 0xB500, e.g. 03 32 07 0F 0B. */
  firmware: Uint8Array;
  /** EcDEV.FWVersion = firmware[4]. */
  fwVersion: number;
}

export interface EneDeviceOptions extends EneTransportOptions {
  /** Parsed PCenter_AmbiglowInfo.json (ene-layout.ts loadAmbiglowInfo). */
  layouts: readonly EneModelLayout[];
  /**
   * Called once when an operation finds the device gone (UsbError 'no-device': unplugged or
   * re-enumerated). The owner should close() it and re-probe; see EneDevice.lost.
   */
  onLost?: (device: EneDevice) => void;
  /**
   * Experimental (09 plan A.7, open question 4; default off): send a follow-video frame as ONE control
   * transfer at 0xE300 (138 bytes on the 34M2C8600) instead of the vendor's six paced segment writes. Only when
   * the frame's segments are contiguous; the transport's frame-buffer window still bounds it. The vendor never
   * sends more than one 64-byte packet per transfer, so a controller may refuse it: the first failure is logged
   * as a warning, and after ENE_FRAME_BURST_MAX_FAILURES in a row the device goes back to the six paced writes.
   */
  frameBurst?: boolean;
}

/** Environment switch for EneDeviceOptions.frameBurst ("1" = on). */
export const ENE_FRAME_BURST_ENV = 'EVNIA_ENE_FRAME_BURST';

/** Failed burst writes in a row (other than a vanished device) after which a device uses the six paced writes again. */
export const ENE_FRAME_BURST_MAX_FAILURES = 3;

export function eneFrameBurstFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[ENE_FRAME_BURST_ENV]?.trim() === '1';
}

export function isEneDevice(info: Pick<UsbDeviceInfo, 'vendorId' | 'productId'>): boolean {
  return info.vendorId === ENE_VENDOR_ID && info.productId === ENE_PRODUCT_ID;
}

/**
 * Candidate Ambiglow controllers. Only 0cf2:a201 is probed — EneEc.dll has no VID/PID filter
 * (it opens whatever advertises its WinUSB interface GUIDs, 09 §3.2), but unrelated ENE devices
 * must not be poked (09 plan A.2).
 */
export function findEneDevices(usb: UsbBackend): Promise<UsbDeviceInfo[]> {
  return usb.list(isEneDevice);
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/**
 * Read-only probe in the vendor's order (09 plan A.5):
 *   Ec_Init            0x4000, 0x4001 (chip id); for the 0x773x family 0x0244 (revision), 0x0415 (trim)
 *   Plug → method_4    0xE0A1 groups (clamped to 3), then 0xE0A3 / 0xE0A5 / 0xE0A7 per present group
 *   Plug → method_2    0xE9F0 name length L; if L > 0, L bytes at 0xE9F1 (capped at 15; NUL-terminated ASCII)
 *   Plug → method_3    5 bytes at 0xB500
 * Throws EneError 'not-ene' (chip id) or 'invalid-firmware' (FW bytes 0..3 all zero).
 * Deviations: chips outside the 0x773x family are rejected right after the id read (the DLL would go on
 * reading family-specific registers), the name length is capped, and the flash trim-load is never run.
 */
export async function identifyEne(t: EneTransport, log: Logger): Promise<EneIdentity> {
  const chipId = ((await t.readReg(EneReg.CHIP_ID_HI)) << 8) | (await t.readReg(EneReg.CHIP_ID_LO));
  if ((chipId & 0xfff0) !== (ENE_CHIP_ID & 0xfff0)) {
    throw new EneError('not-ene', `ENE chip id 0x${chipId.toString(16).padStart(4, '0')} is not an Ambiglow controller (expected 0x7730)`);
  }
  const revision = await t.readReg(EneReg.CHIP_REV);
  const trimStatus = await t.readReg(EneReg.TRIM_STATUS);
  if (chipId !== ENE_CHIP_ID) {
    throw new EneError('not-ene', `ENE chip id 0x${chipId.toString(16)} is not 0x7730 (CUSBENE6K7732 accepts only ENE_0x7730)`);
  }
  if (trimStatus === 0) log.warn('ENE trim status 0x0415 reads 0; EneEc.dll would reload flash trim here, which this port deliberately skips');

  const ledGroups = await t.readReg(EneReg.LED_GROUPS);
  const groups = Math.min(ledGroups, ENE_MAX_LED_GROUPS);
  const counts: EneLedCounts = { border: 0, central: 0, bottom: 0 };
  if (groups >= 1) counts.border = await t.readReg(EneReg.LED_COUNT_BORDER);
  if (groups >= 2) counts.central = await t.readReg(EneReg.LED_COUNT_CENTRAL);
  if (groups >= 3) counts.bottom = await t.readReg(EneReg.LED_COUNT_BOTTOM);

  let modelName = '';
  const nameLength = Math.min(await t.readReg(EneReg.MODEL_NAME_LEN), ENE_MODEL_NAME_MAX);
  if (nameLength > 0) {
    const raw = await t.readRegs(EneReg.MODEL_NAME, nameLength);
    const end = raw.indexOf(0);
    modelName = String.fromCharCode(...raw.subarray(0, end === -1 ? raw.length : end));
  }

  const firmware = await t.readRegs(EneReg.FW_VERSION, ENE_FW_VERSION_LENGTH);
  const identity: EneIdentity = { chipId, revision, trimStatus, ledGroups, counts, modelName, firmware, fwVersion: firmware[4] };
  log.info(
    `ENE ${t.handle.info.id}: chip 0x${chipId.toString(16)} rev ${revision}, model "${modelName}", FW ${hex(firmware)}, ` +
      `groups ${ledGroups} (border ${counts.border}, central ${counts.central}, bottom ${counts.bottom})`,
  );
  if (firmware[0] === 0 && firmware[1] === 0 && firmware[2] === 0 && firmware[3] === 0) {
    throw new EneError('invalid-firmware', `ENE ${t.handle.info.id} reports FW version ${hex(firmware)}; device rejected as in CUSBENE6K7732.Plug`);
  }
  return identity;
}

const copyParameterSet = (ps: EneParameterSet): EneParameterSet => ({ ...ps, rgb: [ps.rgb[0], ps.rgb[1], ps.rgb[2]] });

export class EneDevice {
  readonly info: UsbDeviceInfo;
  readonly identity: EneIdentity;
  readonly layout: EneModelLayout;
  /** LEDs in groups 1..3 (46 on the 34M2C8600): the size of the frame buffer and of ledColors(). */
  readonly ledCount: number;
  readonly #t: EneTransport;
  readonly #log: Logger;
  readonly #onLost: ((device: EneDevice) => void) | undefined;
  readonly #plan: FramePlan;
  /** EneDeviceOptions.frameBurst; switched off after ENE_FRAME_BURST_MAX_FAILURES failed bursts in a row. */
  #frameBurst: boolean;
  #burstFallbackLogged = false;
  #burstFailures = 0;
  #burstFailureWarned = false;
  readonly #mutex = new Mutex();
  #pending = 0;
  #closed = false;
  #lost = false;
  #hostControl = false;
  #applied: Required<EneParameterSet> | null = null;
  /** The parameter set of the last setEffect() as passed in: what the owner wants shown. */
  #requested: EneParameterSet | null = null;
  /** lightsOff() switched #requested off for idle; lightsOn() restores it. */
  #suspended = false;
  #audioLevel = 0;
  /** What the LEDs were last told to show, R,G,B per LED in frame-buffer order. */
  readonly #mirror: Uint8Array;

  /**
   * Open and identify an ENE device. Rejected devices (EneError 'not-ene', 'invalid-firmware',
   * 'unsupported-model') are closed again without any register write. USB errors (UsbError, e.g.
   * 'access' when the udev rule is missing) propagate unchanged.
   */
  static async open(usb: UsbBackend, info: UsbDeviceInfo, options: EneDeviceOptions): Promise<EneDevice> {
    const log = options.log;
    const t = new EneTransport(await usb.open(info), options);
    try {
      const identity = await identifyEne(t, log);
      const layout = findModelLayout(options.layouts, identity.modelName);
      if (!layout) {
        throw new EneError('unsupported-model', `ENE model "${identity.modelName}" is not in PCenter_AmbiglowInfo.json; the device is not driven (vendor behaviour)`);
      }
      return new EneDevice(t, identity, layout, log, options.onLost, options.frameBurst === true);
    } catch (e) {
      await t.close().catch(() => undefined);
      throw e;
    }
  }

  private constructor(
    t: EneTransport,
    identity: EneIdentity,
    layout: EneModelLayout,
    log: Logger,
    onLost: ((device: EneDevice) => void) | undefined,
    frameBurst: boolean,
  ) {
    this.#frameBurst = frameBurst;
    this.#t = t;
    this.info = t.handle.info;
    this.identity = identity;
    this.layout = layout;
    this.#log = log;
    this.#onLost = onLost;
    this.#plan = planFrame(layout, identity.counts);
    this.ledCount = identity.counts.border + identity.counts.central + identity.counts.bottom;
    this.#mirror = new Uint8Array(3 * this.ledCount);
    // Frame writes are bounded by the LEDs this device reports, not by the JSON (09 plan F.3).
    t.setFrameBufferLeds(this.ledCount);
    const jsonBorder = layout.rightLedCount + layout.rightUpLedCount + layout.leftUpLedCount + layout.leftLedCount;
    if (identity.counts.border > 0 && jsonBorder !== identity.counts.border) {
      log.warn(
        `ENE ${this.info.id}: PCenter_AmbiglowInfo.json gives "${layout.modelName}" ${jsonBorder} border LEDs, the device reports ${identity.counts.border}; ` +
          `follow-video border colours will be misplaced (frame writes stay inside the device's ${this.ledCount}-LED buffer)`,
      );
    }
  }

  get modelName(): string {
    return this.identity.modelName;
  }

  /** Whether 0x0023 was last set to 0x04 (host control) by this driver. */
  get hostControl(): boolean {
    return this.#hostControl;
  }

  /** The last parameter set fully written (normalised), or null before the first / after a failed one. */
  get applied(): Readonly<Required<EneParameterSet>> | null {
    return this.#applied;
  }

  /** True while an operation is running or queued; a frame source can skip frames meanwhile (09 plan A.7). */
  get busy(): boolean {
    return this.#pending > 0;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** True while lightsOff() holds the requested effect switched off (idle). */
  get suspended(): boolean {
    return this.#suspended;
  }

  /**
   * The device went away: an operation failed with UsbError 'no-device' (unplugged, or
   * re-enumerated at a new address — the USB handle is dead for good either way). Further
   * operations fail with EneError 'lost'; close() skips the release write. The owner closes the
   * device and re-probes (a fresh EneDevice.open() on the current enumeration, then setEffect()).
   */
  get lost(): boolean {
    return this.#lost;
  }

  /**
   * Whether this device is still usable as the ENE at its port: open, not lost, and `present`
   * (a fresh findEneDevices() result) holds the same enumeration — same id AND bus address.
   * The id alone is stable across re-enumeration, so an unplug/replug that falls into one
   * USBChange throttle window (01 §9) leaves the id present while this handle is dead.
   */
  isCurrent(present: readonly UsbDeviceInfo[]): boolean {
    return !this.#closed && !this.#lost && present.some((d) => isSameEnumeration(d, this.info));
  }

  /**
   * Apply an effect: the exact ParameterSet transfer sequence (09 §6), ~28 paced writes (~300 ms).
   * This is the owner's explicit state and ends an idle suspension (lightsOff()).
   *
   * With `suspended` (the owner is idle: a profile switch, reload or re-open while the lights are off
   * for idle) the effect only becomes the requested state: the device stays (or goes) dark and
   * suspended, and lightsOn() shows it later. Nothing is written when the applied state is already
   * LEDOFF; otherwise the requested effect's LEDOFF variant is sent (the lightsOff() bytes), so a
   * freshly opened device that still runs the firmware's own effect goes dark too. An effect that
   * is itself LEDOFF is applied as without the option and ends the suspension.
   */
  async setEffect(ps: EneParameterSet, options: { suspended?: boolean } = {}): Promise<void> {
    const requested = copyParameterSet(ps);
    return this.#op(async () => {
      this.#requested = requested;
      if (options.suspended && normalizeParameterSet(requested).mode !== EneMode.LEDOFF) {
        this.#suspended = true;
        if (this.#applied?.mode === EneMode.LEDOFF) return;
        await this.#apply({ ...requested, mode: EneMode.LEDOFF });
        return;
      }
      this.#suspended = false;
      await this.#apply(requested);
    });
  }

  /**
   * Idle suspend (EffectEnableTemp(false), 09 §11; CDevice_PHLDisplay.cs:954-972): the requested
   * effect with mode LEDOFF, which also releases host control (0x0023 ← 0). As in the vendor, only an
   * effect that is on is switched: resolves false without any write when nothing was requested, the
   * requested effect is LEDOFF (the user disabled the Ambiglow) or the device is already suspended.
   * The off sequence carries the requested region/colour/speed/brightness bytes, byte-identical to
   * the vendor's ParameterSet for the same EffectInfo with EffectEnable = false.
   */
  async lightsOff(): Promise<boolean> {
    return this.#op(async () => {
      const requested = this.#requested;
      if (this.#suspended || !requested || normalizeParameterSet(requested).mode === EneMode.LEDOFF) return false;
      this.#suspended = true;
      await this.#apply({ ...requested, mode: EneMode.LEDOFF });
      return true;
    });
  }

  /**
   * Resume after lightsOff() (EffectEnableTemp(true)): re-applies the requested effect. Resolves
   * false without any write unless the device is suspended, so it can never switch on LEDs the owner
   * switched off with setEffect().
   */
  async lightsOn(): Promise<boolean> {
    return this.#op(async () => {
      const requested = this.#requested;
      if (!this.#suspended || !requested) return false;
      this.#suspended = false;
      await this.#apply(requested);
      return true;
    });
  }

  /**
   * Stream one follow-video frame (50×40 RGB/RGBA grid) into the frame buffer: six paced writes on
   * the 34M2C8600. Frames only take effect in mode 14 (UserDefine, or 11); in any other mode —
   * including after lightsOff() — the frame is dropped and false is returned, so a late frame
   * cannot write into a buffer the firmware is not showing.
   *
   * With `frameBurst` (experimental, EneDeviceOptions) the six segments go out as one paced transfer at
   * 0xE300 when they are contiguous (burstFrameWrite); otherwise, and by default, as the vendor's six writes.
   * A failed burst rejects like a failed segment write (the next frame is the retry); see #writeBurst.
   */
  async writeVideoFrame(grid: VideoGrid): Promise<boolean> {
    const writes = renderFrame(this.#plan, grid);
    const burst = this.#frameBurst ? burstFrameWrite(writes) : null;
    if (this.#frameBurst && !burst && !this.#burstFallbackLogged) {
      this.#burstFallbackLogged = true;
      this.#log.info(`ENE ${this.info.id}: frame segments are not contiguous; frame burst off, six paced writes are used`);
    }
    return this.#op(async () => {
      const mode = this.#applied?.mode;
      if (mode !== EneMode.UserDefine && mode !== EneMode.FollowVideo) return false;
      // (a burst switched off while this frame was queued goes out as the six writes)
      if (burst && this.#frameBurst) await this.#writeBurst(burst);
      else await this.#write(writes.map((w) => ({ ...w, paced: true })));
      for (const w of writes) {
        const offset = w.reg - EneReg.FRAME_BUFFER;
        const room = this.#mirror.length - offset;
        if (room > 0) this.#mirror.set(w.data.subarray(0, room), offset);
      }
      return true;
    });
  }

  /**
   * Write the FollowAudio level to the register bank the applied mode listens to: E970..E972 for
   * FollowAudioRainbow (10), E960..E962 for FollowAudio (9). The CaptureHost level (0..255, possibly
   * fractional) is truncated to a byte like the vendor's cast (audioLevelByte, 09 §8.2). In any other
   * mode nothing is written and false is returned.
   */
  async writeAudioLevel(level: number): Promise<boolean> {
    return this.#op(async () => {
      const mode = this.#applied?.mode;
      if (mode !== EneMode.FollowAudio && mode !== EneMode.FollowAudioRainbow) return false;
      await this.#write(audioLevelWrites(level, mode === EneMode.FollowAudioRainbow));
      this.#audioLevel = audioLevelByte(level);
      return true;
    });
  }

  /**
   * Preview of the LED colours (Effect_GetLEDs, 09 §7.4 and plan E): R,G,B per LED in frame-buffer
   * order — border (right → up → left), central (top → bottom), bottom (left → right). In FollowAudio
   * the effect colour is scaled by the last level like the vendor mirror (RGB.Multiply, truncating).
   * Unlike the vendor mirror (Class1), the region fill and the segment ordering are correct.
   */
  ledColors(): Uint8Array {
    const out = Uint8Array.from(this.#mirror);
    const mode = this.#applied?.mode;
    if (mode === EneMode.FollowAudio || mode === EneMode.FollowAudioRainbow) {
      const f = Math.fround(this.#audioLevel / 255);
      for (let i = 0; i < out.length; i++) out[i] = Math.trunc(Math.fround(out[i] * f));
    }
    return out;
  }

  /**
   * Release and close. With `release` (default, like UnPlug) 0x0023 ← 0 hands the LEDs back to the
   * monitor firmware first; the vendor never does this at process exit (09 §16.6). A lost device
   * gets no release write; a failed release is logged and the handle is closed anyway.
   */
  async close(options: { release?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    const release = options.release ?? true;
    await this.#mutex.run(async () => {
      if (this.#closed) return;
      this.#closed = true;
      if (release && !this.#lost) {
        try {
          await this.#write(releaseWrites());
          this.#hostControl = false;
        } catch (e) {
          this.#log.debug(`ENE ${this.info.id}: release of 0x0023 failed:`, e instanceof Error ? e.message : e);
        }
      }
      await this.#t.close();
    });
  }

  async #op<T>(fn: () => Promise<T>): Promise<T> {
    this.#checkUsable();
    this.#pending++;
    try {
      return await this.#mutex.run(() => {
        this.#checkUsable();
        return fn();
      });
    } catch (e) {
      if (e instanceof UsbError && e.code === 'no-device') this.#markLost(e);
      throw e;
    } finally {
      this.#pending--;
    }
  }

  #checkUsable(): void {
    if (this.#closed) throw new EneError('closed', `ENE ${this.info.id} is closed`);
    if (this.#lost) throw new EneError('lost', `ENE ${this.info.id} is gone (unplugged or re-enumerated); close it and probe again`);
  }

  #markLost(cause: UsbError): void {
    if (this.#lost) return;
    this.#lost = true;
    this.#hostControl = false;
    this.#log.info(`ENE ${this.info.id} is gone: ${cause.message}`);
    try {
      this.#onLost?.(this);
    } catch (e) {
      this.#log.error(`ENE ${this.info.id}: onLost handler failed:`, e);
    }
  }

  async #write(writes: readonly EneRegisterWrite[]): Promise<void> {
    for (const w of writes) await this.#t.writeRegs(w.reg, w.data, w.paced);
  }

  /**
   * One experimental frame burst. A failure other than a vanished device (UsbError 'no-device', handled by #op) is
   * the burst's own: a firmware that stalls a multi-packet EP0 data stage fails every frame, which the owner logs at
   * debug level only. So the first one is a warning naming the switch, and after ENE_FRAME_BURST_MAX_FAILURES in a
   * row this device goes back to the vendor's six paced writes; a success starts the count again.
   */
  async #writeBurst(burst: FrameWrite): Promise<void> {
    try {
      await this.#write([{ ...burst, paced: true }]);
      this.#burstFailures = 0;
    } catch (e) {
      if (!(e instanceof UsbError && e.code === 'no-device')) this.#burstFailed(e);
      throw e;
    }
  }

  #burstFailed(e: unknown): void {
    this.#burstFailures++;
    if (!this.#burstFailureWarned) {
      this.#burstFailureWarned = true;
      this.#log.warn(
        `ENE ${this.info.id}: the experimental frame burst (${ENE_FRAME_BURST_ENV}=1) failed: ${e instanceof Error ? e.message : String(e)}; ` +
          `after ${ENE_FRAME_BURST_MAX_FAILURES} failures in a row the six paced writes are used again`,
      );
    }
    if (this.#frameBurst && this.#burstFailures >= ENE_FRAME_BURST_MAX_FAILURES) {
      this.#frameBurst = false;
      this.#log.warn(
        `ENE ${this.info.id}: frame burst failed ${this.#burstFailures} times in a row; switched off, Follow video frames use the six paced writes (unset ${ENE_FRAME_BURST_ENV})`,
      );
    }
  }

  /** The ParameterSet transfer sequence for `ps`; `applied` is null until all of it went out. */
  async #apply(ps: EneParameterSet): Promise<void> {
    const p = normalizeParameterSet(ps);
    const [hostSwitch, ...sequence] = parameterSetWrites(p);
    this.#applied = null;
    await this.#write([hostSwitch]);
    this.#hostControl = p.mode !== EneMode.LEDOFF;
    await this.#write(sequence);
    this.#applied = p;
    this.#mirrorEffect(p);
  }

  /** Mirror of a ParameterSet: lit groups show the effect colour, groups switched off are black. */
  #mirrorEffect(p: Required<EneParameterSet>): void {
    if (p.mode === EneMode.UserDefine || p.mode === EneMode.FollowVideo) return; // frames fill the buffer
    const { border, central, bottom } = this.identity.counts;
    const ranges = {
      border: [0, border],
      central: [border, border + central],
      bottom: [border + central, border + central + bottom],
    } as const;
    const lit =
      p.mode === EneMode.LEDOFF ? []
      : p.region === EneRegion.Border4Sided ? [ranges.border, ranges.bottom]
      : p.region === EneRegion.Central ? [ranges.central]
      : p.region === EneRegion.Bottom ? [ranges.bottom]
      : p.region === EneRegion.Clock4 ? null // group 4 only; groups 1..3 are untouched
      : [ranges.border, ranges.central, ranges.bottom];
    if (lit === null) return;
    this.#mirror.fill(0);
    for (const [from, to] of lit) {
      for (let led = from; led < to; led++) this.#mirror.set(p.rgb, 3 * led);
    }
  }
}
