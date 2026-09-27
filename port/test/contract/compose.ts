// Builds the PRODUCTION backend in mock mode for the contract tests (not a test file itself).
//
// Composition = src/backend/index.ts createDefaultBackend(options), i.e. exactly what Electron main's
// createBackend({ host, usb, mockMonitor }) builds (src/backend/compose.ts): the real theme store, monitor
// manager and ambiglow service wired together, and index.ts API_MODULES. Nothing is wired test-locally; the
// tests only observe the services the composition exposes. The options are:
//   - mockMonitor (EVNIA_MOCK_MONITOR semantics, ARCHITECTURE.md rule 7) and noHardware = true (no /dev/i2c*,
//     no real USB):
//       "34M2C8600/no-ene"  the hardware state of the golden session (20-backend-host-tail §5 "Setup"): the
//                           monitor over USB-DDC through the VIA bridge, the ENE controller ABSENT (default);
//       "34M2C8600"         the same plus the simulated ENE MCU on USB 3-2.1 (`{ ene: true }`);
//   - the simulated monitor with the user's real EDID and serial (test/fixtures/user-monitor.ts, passed as
//     MonitorManagerOptions.mockSpec), since the golden replies carry them; the product's mock monitor has a
//     synthetic serial;
//   - the user's real persisted state copied to a temporary EvniaServe/ and evnia/ directory
//     (test/fixtures/windows: Config/SoftConfig.data, Config/data.json, Theme/DataTheme.cfg,
//     Theme/User/Default.pcenter, evnia/config.json);
//   - the bundled vendor data (MonitorInfo.json, PCenter_DeviceInfo.json, ENE/PCenter_AmbiglowInfo.json) from
//     build/vendor-data (written by `npm run import-ui` from the user's installer copy, never committed);
//   - a host whose display mode is the user's (3440x1440, 175Hz, 0°; 20-backend-host-tail §5 step 12) and
//     whose idle time is 0; no capture host (follow-video/audio engines stay idle).
// When build/vendor-data is missing, composeMockBackend() returns { skip: <reason> } and the tests skip.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDefaultBackend, type DefaultBackend, type DefaultCompositionOptions } from '../../src/backend/index.ts';
import type { MockHardware } from '../../src/backend/monitor/manager.ts';
import type { DisplayModeInfo, HostServices } from '../../src/backend/types.ts';
import { ENE_PRODUCT_ID, ENE_VENDOR_ID } from '../../src/backend/ddc/discovery.ts';
import { EXT_BASE } from '../../src/backend/ddc/codec.ts';
import { captureLogger, type LogLine } from '../unit/rpc/helpers.ts';
import { USER_34M2C8600, USER_MONITOR_SERIAL } from '../fixtures/user-monitor.ts';
import { WINDOWS_FIXTURES } from './golden.ts';

export const VENDOR_DATA_DIR = fileURLToPath(new URL('../../build/vendor-data/', import.meta.url));

/** The user's display mode during the 2026-09-26 session (Default.pcenter DispalyData). */
export const USER_DISPLAY_MODE: DisplayModeInfo = { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' };

/** The serial string of the user's monitor (EDID, golden step 11). */
export const USER_DISPLAY_KEY = USER_MONITOR_SERIAL;

export interface ComposeOptions {
  /** Keep the simulated ENE MCU on USB 3-2.1 (default false: the golden session had no ENE, §5 "Setup"). */
  ene?: boolean;
  /** Composition tuning (DefaultCompositionOptions); the contract tests pass none. */
  overrides?: DefaultCompositionOptions;
}

export interface ComposedBackend {
  readonly backend: DefaultBackend;
  /** Every notification JSON string, in arrival order (live). */
  readonly notifications: string[];
  readonly logLines: LogLine[];
  readonly serveDataDir: string;
  /** A scratch directory next to EvniaServe/ and evnia/ (removed by cleanup), e.g. for files to import. */
  readonly scratchDir: string;
  readonly mockMonitor: string;
  /** The simulated hardware (monitor, fake USB bus, VIA bridge, ENE MCU); exists once the first scan ran. */
  hardware(): MockHardware;
  /** Stop the backend (as Electron main does on quit) and remove the temporary directories. */
  cleanup(): Promise<void>;
}

/** Why the composed tests cannot run here, or null. */
export function composeSkipReason(): string | null {
  if (!existsSync(join(VENDOR_DATA_DIR, 'MonitorInfo.json')) || !existsSync(join(VENDOR_DATA_DIR, 'PCenter_DeviceInfo.json'))) {
    return 'build/vendor-data is missing (run `npm run import-ui` with the vendor installer copy)';
  }
  return null;
}

export async function composeMockBackend(options: ComposeOptions = {}): Promise<ComposedBackend | { skip: string }> {
  const skip = composeSkipReason();
  if (skip) return { skip: `composed backend not available: ${skip}` };

  const root = mkdtempSync(join(tmpdir(), 'evnia-contract-'));
  const serveDataDir = join(root, 'EvniaServe');
  const appDataDir = join(root, 'evnia');
  const scratchDir = join(root, 'scratch');
  cpSync(join(WINDOWS_FIXTURES, 'EvniaServe'), serveDataDir, { recursive: true });
  cpSync(join(WINDOWS_FIXTURES, 'evnia'), appDataDir, { recursive: true });
  mkdirSync(scratchDir);

  const { log, lines } = captureLogger('backend');
  const host: HostServices = {
    log,
    serveDataDir,
    appDataDir,
    resourcesDir: VENDOR_DATA_DIR,
    getIdleSeconds: () => 0,
    getDisplayMode: () => ({ ...USER_DISPLAY_MODE }),
    getForegroundAppPath: () => null,
  };

  const mockMonitor = options.ene ? '34M2C8600' : '34M2C8600/no-ene';
  // The simulated monitor with the user's real EDID and serial (the product's mock carries synthetic ones):
  // the golden replies were captured on the user's unit.
  const overrides = { ...options.overrides, monitors: { mockSpec: USER_34M2C8600, ...options.overrides?.monitors } };
  const backend = createDefaultBackend({ host, mockMonitor, noHardware: true }, overrides);
  const notifications: string[] = [];
  const unsubscribe = backend.onNotification((json) => notifications.push(json));
  await backend.start();
  return {
    backend,
    notifications,
    logLines: lines,
    serveDataDir,
    scratchDir,
    mockMonitor,
    hardware: () => {
      const hw = backend.services.monitors.mockHardware;
      if (!hw) throw new Error('the simulated hardware exists only after the first scan (Start)');
      return hw;
    },
    cleanup: async () => {
      unsubscribe();
      await backend.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** ENE MCUs present on the simulated USB bus. */
export async function mockEnes(c: ComposedBackend): Promise<number> {
  return (await c.hardware().usb.list((d) => d.vendorId === ENE_VENDOR_ID && d.productId === ENE_PRODUCT_ID)).length;
}

/** A VCP write the simulated monitor received: standard code or TPV extended 0xE2A0xx, and the value. */
export interface VcpWrite {
  code: number;
  value: number;
}

/**
 * The Set VCP Feature commands among the frames the simulated monitor received from index `from` on
 * (DDC/CI `51 (80|n) 03 cc hi lo chk` and the TPV form `51 86 03 E2 A0 xx hi lo chk`, 07 §2, 06 §6.2).
 */
export function vcpWritesSince(hw: MockHardware, from: number): VcpWrite[] {
  return hw.monitor.frames.slice(from).flatMap((f): VcpWrite[] => {
    if (f.length === 7 && f[2] === 0x03) return [{ code: f[3], value: (f[4] << 8) | f[5] }];
    if (f.length === 9 && f[2] === 0x03 && f[3] === 0xe2 && f[4] === 0xa0) return [{ code: EXT_BASE | f[5], value: (f[6] << 8) | f[7] }];
    return [];
  });
}

interface PcenterFile {
  Sync_Profile: unknown;
  Profiles: { ProfileDesc: { DeviceType: number }; ProfileContent: string }[];
}

function readPcenter(path: string): PcenterFile {
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  return JSON.parse(text.split(/\r?\n/)[0]) as PcenterFile;
}

function displaySection(profile: PcenterFile, path: string): PcenterFile['Profiles'][number] {
  const section = profile.Profiles.find((p) => p.ProfileDesc.DeviceType === 100000);
  if (!section) throw new Error(`${path}: no display section`);
  return section;
}

/** The display section of a stored .pcenter profile (UTF-8 BOM, one JSON line; 20-theme §3), parsed. */
export function storedDisplayContent(pcenterPath: string): Record<string, any> {
  return JSON.parse(displaySection(readPcenter(pcenterPath), pcenterPath).ProfileContent) as Record<string, any>;
}

/**
 * Write a Windows-format .pcenter (UTF-8 BOM, one JSON line) made from `fromPath` with its display section
 * edited, e.g. a profile exported on Windows with another SmartImage (for Theme_ImportProfile).
 */
export function writeEditedProfile(fromPath: string, toPath: string, edit: (content: Record<string, any>) => void): void {
  const profile = readPcenter(fromPath);
  const section = displaySection(profile, fromPath);
  const content = JSON.parse(section.ProfileContent) as Record<string, any>;
  edit(content);
  section.ProfileContent = JSON.stringify(content);
  writeFileSync(toPath, `﻿${JSON.stringify(profile)}`);
}

/** The raw bytes of a reply's Tag (the reply is `{…,"Tag":<Tag>,"FunctionName":…,"CurrItem":null}`). */
export function rawTag(replyJson: string): string {
  const start = replyJson.indexOf('"Tag":');
  const end = replyJson.lastIndexOf(',"FunctionName":');
  if (start < 0 || end < start) throw new Error(`not a JsonResult: ${replyJson.slice(0, 120)}`);
  return replyJson.slice(start + '"Tag":'.length, end);
}
