// HostServices.getDisplayMode: MonitorResolution / MonitorFrequency / MonitorOrientation of a monitor
// (20-monitor-io-linux-consolidation §3.5). Pure helpers; the sources live in display-sources.ts.
//
// Vendor (CWinSysDisplay.getCurDisplaySetting, WL/CWinSysDisplay.cs:547-557; CDevice_PHLDisplay.cs:314-326):
// EnumDisplaySettings(ENUM_CURRENT_SETTINGS) of the monitor's display device gives "<W>x<H>-<F>Hz" with the
// integer dmDisplayFrequency (fractional rates truncated: 59.94 → "59") and the rotated desktop size, and
// MonitorOrientation = {"0°","90°","180°","270°"}[dmDisplayOrientation]. When the API fails all three stay "".
//
// Linux (§3.5):
//   2. exact = the source's refresh rate, or clock_kHz·1000 / (htotal·vtotal) ×2 interlaced, ÷2 double scan,
//      ÷vscan (vscan > 1) — drm_mode_vrefresh's factors;
//   3. MonitorFrequency  = floor(exact + 0.005) + "Hz" (absorbs pixel-clock quantisation and compositor float
//      noise, keeps Windows-style truncation: 74.9832 → "74Hz", 59.9726 → "59Hz");
//   4. MonitorResolution = mode width x height, swapped for 90°/270°; mode pixels also with fractional scaling;
//   5. MonitorOrientation = ["0°","90°","180°","270°"][r], r = rotation in 90° counter-clockwise steps
//      (wl_output/Mutter transform and RandR rotation; flips ignored);
//   6. no source → null (the backend keeps "", so hz = 0 and MBR is disabled) and a warning.
//
// Matching a source's outputs to the backend's DiscoveredMonitor (connector "card1-DP-2", sysfs EDID):
//   XRandR by the EDID property (never by name: the amdgpu DDX calls DP-1 "DisplayPort-0"), Mutter by its
//   monitor spec (vendor, product, serial = EDID PnP id, 0xFC name, 0xFF serial), libdrm by the connector
//   name; the output name only breaks ties or stands in when a source has no identity.

import type { DiscoveredMonitor, DisplayModeInfo } from '../backend/types.ts';

export const ORIENTATIONS: readonly string[] = Object.freeze(['0°', '90°', '180°', '270°']);

/** The simulated monitor's mode (the user's 3440x1440 at 175 Hz), reported in EVNIA_MOCK_MONITOR mode like backend/serve.ts. */
export const MOCK_DISPLAY_MODE: Readonly<DisplayModeInfo> = Object.freeze({ resolution: '3440x1440', frequency: '175Hz', orientation: '0°' });

export type ModeSourceName = 'mutter' | 'xrandr' | 'drm' | 'electron';

/** An unrotated mode: pixels as the CRTC scans them out, and the exact refresh rate. */
export interface ModeTiming {
  width: number;
  height: number;
  /** Exact refresh rate in Hz (0 when unknown). */
  exactHz: number;
}

/** Mutter's monitor spec (connector, vendor, product, serial) minus the connector. */
export interface MonitorIdentity {
  vendor: string;
  product: string;
  serial: string;
}

/** One connected output as a mode source sees it. */
export interface ModeSnapshot {
  source: ModeSourceName;
  /** The source's output name: "DP-2" (Mutter on Wayland, modesetting), "DisplayPort-0" (amdgpu DDX), "card1-DP-2" (libdrm). */
  connector: string;
  /** Mutter's monitor spec. */
  identity?: MonitorIdentity;
  /** XRandR's EDID property. */
  edid?: Uint8Array;
  /** The current mode; null when the output is connected but shows nothing (disabled, no CRTC). */
  mode: ModeTiming | null;
  /** Rotation in 90° counter-clockwise steps, 0..3. */
  rotation: number;
}

export interface DrmModeTiming {
  clockKHz: number;
  htotal: number;
  vtotal: number;
  vscan?: number;
  interlace?: boolean;
  doubleScan?: boolean;
}

/** §3.5 step 2: the exact refresh rate of a timing (drm_mode_vrefresh without its rounding). */
export function exactRefreshHz(t: DrmModeTiming): number {
  if (!(t.clockKHz > 0) || !(t.htotal > 0) || !(t.vtotal > 0)) return 0;
  let num = t.clockKHz * 1000;
  let den = t.htotal * t.vtotal;
  if (t.interlace) num *= 2;
  if (t.doubleScan) den *= 2;
  if (t.vscan !== undefined && t.vscan > 1) den *= t.vscan;
  return num / den;
}

/** §3.5 step 3: "175Hz"; "" for an unknown rate. */
export function formatFrequency(exactHz: number): string {
  return Number.isFinite(exactHz) && exactHz > 0 ? `${Math.floor(exactHz + 0.005)}Hz` : '';
}

/** Rotation in counter-clockwise 90° steps from a transform/rotation value (flip bits ignored). */
export function rotationSteps(transform: number): number {
  return Number.isInteger(transform) && transform >= 0 ? transform & 3 : 0;
}

/** §3.5 steps 3-5 for a source's current mode. */
export function formatMode(mode: ModeTiming, rotation: number): DisplayModeInfo {
  const r = rotationSteps(rotation);
  const [w, h] = r % 2 === 1 ? [mode.height, mode.width] : [mode.width, mode.height];
  return { resolution: `${w}x${h}`, frequency: formatFrequency(mode.exactHz), orientation: ORIENTATIONS[r] };
}

/** "card1-DP-2" → "DP-2". */
export function connectorOutputName(connector: string | undefined): string | null {
  if (!connector) return null;
  const m = /^card\d+-(.+)$/.exec(connector);
  return m ? m[1] : connector;
}

function same(a: string | undefined | null, b: string | undefined | null): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

const hex = (n: number, digits: number) => `0x${(n >>> 0).toString(16).padStart(digits, '0')}`;

/** Mutter's spec strings for an EDID: its product falls back to the product code, its serial to the 32-bit serial. */
export function identityMatches(id: MonitorIdentity, edid: DiscoveredMonitor['edid']): boolean {
  if (!edid) return false;
  const product = same(id.product, edid.monitorName) || same(id.product, hex(edid.productCode, 4));
  const serial = same(id.serial, edid.serialString) || same(id.serial, hex(edid.serialNumber, 8));
  const vendor = !id.vendor || same(id.vendor, edid.manufacturer);
  return product && serial && vendor;
}

/** Same EDID base block (128 bytes: vendor, product, serial, timings). */
export function edidMatches(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b || a.length < 128 || b.length < 128) return false;
  for (let i = 0; i < 128; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The snapshot of `monitor` among one source's outputs: identity (EDID / Mutter spec) first, the output name
 * breaking ties between identical monitors; the name alone when the source carries no identity for any
 * output or nothing matched by identity. undefined = the source does not list the monitor.
 */
export function matchSnapshot(snapshots: readonly ModeSnapshot[], monitor: Pick<DiscoveredMonitor, 'connector' | 'edid'>): ModeSnapshot | undefined {
  const full = monitor.connector ?? null;
  const output = connectorOutputName(monitor.connector);
  const nameMatches = (s: ModeSnapshot) => (s.source === 'drm' ? same(s.connector, full) : same(s.connector, output));
  const byIdentity = snapshots.filter((s) =>
    s.edid ? edidMatches(s.edid, monitor.edid?.raw) : s.identity ? identityMatches(s.identity, monitor.edid) : false,
  );
  if (byIdentity.length === 1) return byIdentity[0];
  if (byIdentity.length > 1) return byIdentity.find(nameMatches) ?? byIdentity[0];
  return snapshots.find(nameMatches);
}

// ───────────────────────────── Electron screen fallback ─────────────────────────────

/** The subset of Electron.Display used here (kept structural so it is testable without Electron). */
export interface DisplayLike {
  id: number;
  label: string;
  size: { width: number; height: number };
  scaleFactor: number;
  /** Clockwise degrees (Electron), unlike RandR/Mutter. */
  rotation: number;
  displayFrequency: number;
}

export function physicalSize(d: DisplayLike): { width: number; height: number } {
  return { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
}

/**
 * The Electron screen API's view of a display, in the §3.5 format. The size is the rotated desktop in DIP ×
 * scale (already swapped), the rotation is clockwise (Chromium maps RandR/wl_output's counter-clockwise
 * RR_Rotate_90 / WL_OUTPUT_TRANSFORM_90 to ROTATE_270), a 0 rate (Xvfb, some drivers) is unknown.
 */
export function formatElectronDisplay(d: DisplayLike): DisplayModeInfo {
  const { width, height } = physicalSize(d);
  const cw = ((Math.round(d.rotation / 90) % 4) + 4) % 4;
  return { resolution: `${width}x${height}`, frequency: formatFrequency(d.displayFrequency), orientation: ORIENTATIONS[(4 - cw) % 4] };
}

/** Preferred (native) mode from the first EDID detailed timing descriptor (bytes 54..71). */
export function edidPreferredMode(raw: Uint8Array | undefined): { width: number; height: number } | null {
  if (!raw || raw.length < 128) return null;
  const pixelClock = raw[54] | (raw[55] << 8);
  if (pixelClock === 0) return null;
  const width = raw[56] | ((raw[58] & 0xf0) << 4);
  const height = raw[59] | ((raw[61] & 0xf0) << 4);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The Electron display showing `monitor`, only when that is unambiguous: the output name or the EDID model
 * in the display's label, then the only display whose size is the EDID preferred mode, then the only display.
 * No primary-display guess: with several displays a wrong mode is worse than "" (§3.5 step 6).
 */
export function pickDisplayForMonitor(displays: readonly DisplayLike[], monitor: Pick<DiscoveredMonitor, 'connector' | 'edid'>): DisplayLike | null {
  if (displays.length === 0) return null;
  const output = connectorOutputName(monitor.connector);
  const byOutput = displays.find((d) => same(d.label, output));
  if (byOutput) return byOutput;
  const name = monitor.edid?.monitorName?.trim().toLowerCase();
  if (name) {
    const model = name.replace(/^phl[\s_]*/, '');
    const byName = displays.find((d) => {
      const label = d.label.trim().toLowerCase();
      return label === name || (model.length > 0 && label.includes(model));
    });
    if (byName) return byName;
  }
  const native = edidPreferredMode(monitor.edid?.raw);
  if (native) {
    const matches = displays.filter((d) => {
      const p = physicalSize(d);
      return (p.width === native.width && p.height === native.height) || (p.width === native.height && p.height === native.width);
    });
    if (matches.length === 1) return matches[0];
  }
  return displays.length === 1 ? displays[0] : null;
}
