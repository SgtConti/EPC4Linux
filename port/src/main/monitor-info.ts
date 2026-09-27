// MonitorInfo.json handling: the capability table that gates Ambiglow / LightSync / HDR in the UI.
//
// Vendor behaviour (01 §8, 14 §7):
//   - main seeds %APPDATA%\evnia\MonitorInfo.json from an embedded v34 copy and refreshes it online on
//     every backend start (N01, stripped);
//   - getMonitorJsonConfig derives {OTAEnable, config} once per process (01 §8.3).
// Linux (14 §7.5): ship the v34 file read-only in <resources>/MonitorInfo.json; a user copy at
// <userData>/MonitorInfo.json wins when its Version >= the bundled one (same rule as the vendor's
// getLocalMonitorInfoVersion, 01 §8.1). OTAEnable is always false: firmware OTA is not part of the port.

import { readFileSync } from 'node:fs';
import type { Logger } from '../backend/types.ts';

export interface MonitorEntry {
  Name: string;
  SupUsbDDC?: boolean;
  SupOTA?: boolean;
  SupLightEffect?: boolean;
  SupLightSync?: boolean;
  HDR?: number;
  [extra: string]: unknown;
}

export interface MonitorInfoFile {
  Version?: number;
  Monitors?: MonitorEntry[];
  LimitVer_PCenter?: number[];
  [extra: string]: unknown;
}

export interface MonitorJsonConfig {
  OTAEnable: boolean;
  config: Record<string, MonitorEntry>;
}

/**
 * Vendor `Wf` (01 §8.3): "1.13.0" → 101300. First field as is, middle fields padded to 3 digits,
 * last field to 2 digits. Kept for parity of the (ignored) LimitVer_PCenter semantics in logs.
 */
export function versionToInt(version: string): number {
  const parts = version.toLowerCase().replace('v', '').split('.');
  return Number(parts.map((p, i) => (i === 0 ? p : i === parts.length - 1 ? p.padStart(2, '0') : p.padStart(3, '0'))).join(''));
}

/**
 * Key derivation of getMonitorJsonConfig, byte-for-byte with the vendor (01 §8.3, index.js:17594-17600):
 *   Name.trim().slice(Name.startsWith("PHL") ? 3 : 0).split(/[\s+|_]/).at(-1) || ""
 * Note the quirks kept on purpose: startsWith() tests the untrimmed name, and the character class
 * splits on whitespace, '+', '|' and '_'.
 */
export function monitorKey(name: string): string {
  return (
    name
      .trim()
      .slice(name.startsWith('PHL') ? 3 : 0)
      .split(/[\s+|_]/)
      .at(-1) || ''
  );
}

/** getMonitorJsonConfig payload. Later entries overwrite earlier ones with the same key (vendor reduce). */
export function buildMonitorJsonConfig(info: MonitorInfoFile | null): MonitorJsonConfig {
  const config: Record<string, MonitorEntry> = {};
  for (const m of Array.isArray(info?.Monitors) ? info.Monitors : []) {
    if (typeof m?.Name !== 'string') continue;
    const key = monitorKey(m.Name);
    if (key) config[key] = m;
  }
  // Vendor: OTAEnable = !LimitVer.includes(-1) && !LimitVer.includes(101300). The port never offers
  // OTA (ARCHITECTURE scope table), which hides the FwUpdate tab and the OTA auto-check (02 §L.3).
  return { OTAEnable: false, config };
}

function parseInfo(text: string): MonitorInfoFile | null {
  const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as MonitorInfoFile).Monitors)) return null;
  return parsed as MonitorInfoFile;
}

function readInfo(path: string, log: Logger): MonitorInfoFile | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`Cannot read ${path}:`, (e as Error).message);
    return null;
  }
  try {
    const info = parseInfo(text);
    if (!info) log.warn(`Ignoring ${path}: no Monitors array`);
    return info;
  } catch (e) {
    log.warn(`Ignoring ${path}: invalid JSON (${(e as Error).message})`);
    return null;
  }
}

/** 14 §7.5: the user copy wins when its Version is >= the bundled Version. */
export function selectMonitorInfo(bundled: MonitorInfoFile | null, user: MonitorInfoFile | null): MonitorInfoFile | null {
  if (!user) return bundled;
  if (!bundled) return user;
  return Number(user.Version ?? 0) >= Number(bundled.Version ?? 0) ? user : bundled;
}

export function loadMonitorInfo(bundledPath: string, userPath: string, log: Logger): MonitorInfoFile | null {
  const bundled = readInfo(bundledPath, log);
  const user = readInfo(userPath, log);
  const chosen = selectMonitorInfo(bundled, user);
  if (!chosen) log.error(`No usable MonitorInfo.json (looked at ${bundledPath} and ${userPath})`);
  else log.info(`MonitorInfo.json v${String(chosen.Version)} from ${chosen === user ? userPath : bundledPath}`);
  return chosen;
}
