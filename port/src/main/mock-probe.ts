// Test probe of the simulated hardware behind EVNIA_MOCK_MONITOR (ARCHITECTURE rule 7).
//
// Gated by the mock environment: index.ts installs it only when EVNIA_MOCK_MONITOR selects the simulated
// monitor, i.e. when the backend runs with noHardware and nothing real is opened. An ordinary run never
// has it. It lives on the main process's globalThis, which the renderer cannot reach (contextIsolation,
// sandbox, no IPC channel exposes it); the e2e walkthrough (test/e2e/walkthrough.test.ts) reads it through
// Playwright's electronApp.evaluate(), which runs in the main process.
//
// What it shows is the device side of the wire, not the backend's model: the control values the simulated
// monitor holds, every Set VCP it received from the host, and the simulated ENE Ambiglow MCU's latched
// registers. That is what a walkthrough must check after a UI interaction ("the monitor changed"), in the
// same terms as the contract tests (test/contract/compose.ts vcpWritesSince, MockEneDevice.state()).
// It can also change the simulated environment the way the outside world would: a setting changed on the
// monitor itself (osdSet), the user's input idle time, and the monitor switched off and on (its USB devices
// and DRM connector, with the host events raised through main's real DeviceChangeGate). It never reaches
// into the backend's model. Besides the simulated hardware it shows what the backend asked of main's own
// screen-capture host (sessions started, interval changes: the Follow video speed tiers).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EXT_BASE, OP_SET_VCP } from '../backend/ddc/codec.ts';
import { DEFAULT_MOCK_SYSFS, mockViaDeviceSpec } from '../backend/ddc/transports/mock.ts';
import type { DefaultBackend } from '../backend/index.ts';
import type { MockHardware } from '../backend/monitor/manager.ts';
import type { UsbDeviceInfo } from '../backend/types.ts';
import type { DeviceEventName } from './device-events.ts';

/** The property of the main process's globalThis that holds the probe. */
export const MOCK_PROBE_KEY = '__evniaMockProbe';

/** One latched ENE LED group (MockEneGroupState), JSON-safe. */
export interface MockProbeEneGroup {
  mode: number;
  swMode: number;
  speed: number;
  direction: number;
  brightness: number;
  color: [number, number, number];
}

export interface MockProbeSnapshot {
  /** The simulated model, e.g. "34M2C8600". */
  model: string;
  /** Current value of every control of the simulated monitor, keyed by VCP code (TPV codes as 0xE2A0xx). */
  vcp: Record<number, number>;
  /** Every Set VCP the host sent, in order, as [code, value] (TPV codes as 0xE2A0xx). */
  writes: Array<[number, number]>;
  /** The simulated ENE MCU; null in the "<model>/no-ene" variant. */
  ene: {
    /** 0x0023: 0x04 while the host drives the LEDs, 0 when released. */
    hostControl: number;
    /** Latched settings per group 1..4 (null until the group's apply register was written). */
    groups: Record<string, MockProbeEneGroup | null>;
    /** The per-LED frame buffer at 0xE300 (R,G,B per LED; FollowVideo uploads). */
    frame: number[];
    /** Refused register accesses (must stay empty). */
    violations: string[];
  } | null;
  /**
   * What the backend asked of main's screen-capture host (ElectronCaptureHost.videoStats): capture sessions started
   * (each a portal dialog on Wayland), in-place interval changes, and the current session's frame interval (null while
   * nothing is captured). null when main gave the probe no capture hook.
   */
  capture: MockProbeCapture | null;
}

/** MockProbeSnapshot.capture (the capture host is part of the environment the backend drives, like the ENE). */
export interface MockProbeCapture {
  starts: number;
  retunes: number;
  intervalMs: number | null;
}

export interface MockProbe {
  /** The simulated hardware's state; null until the backend started and built its mock environment. */
  snapshot(): MockProbeSnapshot | null;
  /**
   * A change made on the monitor itself (OSD keys, or the source switching HDR), not by the app:
   * SimulatedMonitor.osdSet. False when there is no simulated monitor or it has no such control.
   */
  osdSet(code: number, value: number): boolean;
  /**
   * Simulated input idle time in seconds for HostServices.getIdleSeconds ("turn off lights when idle",
   * 09 §11); null returns to the real source. Like the display mode, the idle time is part of the
   * simulated environment: under Xvfb it only grows (synthetic test input is no X input).
   */
  setIdleSeconds(seconds: number | null): void;
  /** HostServices.getIdleSeconds in mock mode: the simulated idle time, else `real()`. */
  idleSeconds(real: () => number): number;
  /**
   * The monitor switched off or unplugged: its DRM connector reports "disconnected" and its USB devices
   * (the VIA bridge and the ENE behind the monitor's hub) leave the fake bus. The host events follow as
   * udev and libusb would raise them (MockProbeHooks.deviceEvent). False when already unplugged.
   */
  unplugMonitor(): Promise<boolean>;
  /** The monitor back: connector "connected", bridge and ENE re-enumerated at new addresses, host events. */
  replugMonitor(): Promise<boolean>;
}

export interface MockProbeHooks {
  /** A raw host device event, through main's DeviceChangeGate (vendor debounce and shields, 01 §9). */
  deviceEvent?: (name: DeviceEventName) => void;
  /** The screen-capture host's video state (ElectronCaptureHost.videoStats). */
  capture?: () => MockProbeCapture;
}

/** Set VCP frames as received on 0x37 (`51 84 03 cc hi lo chk`, `51 86 03 E2 A0 xx hi lo chk`). */
export function decodeSetVcp(frame: Uint8Array): [number, number] | null {
  if (frame.length === 7 && frame[2] === OP_SET_VCP) return [frame[3], (frame[4] << 8) | frame[5]];
  if (frame.length === 9 && frame[2] === OP_SET_VCP && frame[3] === 0xe2 && frame[4] === 0xa0) return [EXT_BASE | frame[5], (frame[6] << 8) | frame[7]];
  return null;
}

export function snapshotOf(hw: MockHardware, capture: MockProbeCapture | null = null): MockProbeSnapshot {
  const monitor = hw.monitor;
  const vcp: Record<number, number> = {};
  for (const [code] of monitor.spec.vcp) {
    const c = monitor.control(code);
    if (c) vcp[code] = c.value;
  }
  const writes = monitor.frames.map(decodeSetVcp).filter((w): w is [number, number] => w !== null);
  let ene: MockProbeSnapshot['ene'] = null;
  if (hw.eneInfo) {
    const state = hw.ene.state();
    const groups: Record<string, MockProbeEneGroup | null> = {};
    for (const [g, s] of Object.entries(state.groups)) groups[g] = s ? { ...s, color: [...s.color] } : null;
    ene = { hostControl: state.hostControl, groups, frame: Array.from(state.frame), violations: [...hw.ene.violations] };
  }
  return { model: monitor.spec.name, vcp, writes, ene, capture: capture ? { ...capture } : null };
}

export function createMockProbe(backend: () => DefaultBackend | null, hooks: MockProbeHooks = {}): MockProbe {
  const hardware = () => backend()?.services.monitors.mockHardware ?? null;
  let idle: number | null = null;
  // The monitor's USB devices while plugged in (MockHardware keeps the first enumeration).
  let plugged: { via: UsbDeviceInfo; ene: UsbDeviceInfo | null } | null = null;
  let unplugged: { hasEne: boolean } | null = null;
  let nextAddress = 30;
  const status = (hw: MockHardware) => join(hw.sysfsRoot, 'class/drm', `${DEFAULT_MOCK_SYSFS.card}-${DEFAULT_MOCK_SYSFS.connector}`, 'status');
  const hostEvents = (): void => {
    for (const name of ['USBChange', 'otherDeviceChange', 'displayChange'] as const) hooks.deviceEvent?.(name);
  };
  return {
    snapshot: () => {
      const hw = hardware();
      return hw ? snapshotOf(hw, hooks.capture?.() ?? null) : null;
    },
    osdSet: (code, value) => hardware()?.monitor.osdSet(code, value) ?? false,
    setIdleSeconds: (seconds) => {
      idle = seconds === null ? null : Math.max(0, Math.floor(seconds));
    },
    idleSeconds: (real) => idle ?? real(),
    unplugMonitor: async () => {
      const hw = hardware();
      if (!hw || unplugged) return false;
      plugged ??= { via: hw.via, ene: hw.eneInfo };
      await writeFile(status(hw), 'disconnected\n');
      hw.usb.detach(plugged.via);
      if (plugged.ene) hw.usb.detach(plugged.ene);
      unplugged = { hasEne: plugged.ene !== null };
      plugged = null;
      hostEvents();
      return true;
    },
    replugMonitor: async () => {
      const hw = hardware();
      if (!hw || !unplugged) return false;
      await writeFile(status(hw), 'connected\n');
      const via = hw.usb.attach(mockViaDeviceSpec(hw.monitor, { deviceAddress: nextAddress++ }));
      const ene = unplugged.hasEne ? hw.usb.attach(hw.ene.spec({ busNumber: 3, portNumbers: [2, 1], deviceAddress: nextAddress++ })) : null;
      plugged = { via, ene };
      unplugged = null;
      hostEvents();
      return true;
    },
  };
}

/** Install the probe (mock mode only, see the header). */
export function installMockProbe(target: object, backend: () => DefaultBackend | null, hooks: MockProbeHooks = {}): MockProbe {
  const probe = createMockProbe(backend, hooks);
  Object.defineProperty(target, MOCK_PROBE_KEY, { value: probe, configurable: true, enumerable: false, writable: false });
  return probe;
}
