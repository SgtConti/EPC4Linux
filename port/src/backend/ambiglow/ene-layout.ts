// Per-model Ambiglow LED layout from the vendor data file PCenter_AmbiglowInfo.json
// (Zeasn.USB.ENE.Lib GClass0/GClass1, 09 §7.3), and ENE ↔ monitor model-name matching.
//
// The file lists, per ENE model name, the four border sub-segments (right, right-up, left-up, left)
// and the centre/bottom counts. The border sub-counts drive the follow-video mapping; the device's
// own registers (0xE0A3/A5/A7) give the group sizes and frame-buffer offsets. The file is also the
// list of supported models: CUSBENE6K7732 only drives a device whose 0xE9F1 name appears here.
// At runtime it is <HostServices.resourcesDir>/ENE/PCenter_AmbiglowInfo.json: the UI import
// (scripts/ui-patches.mjs `copies`) puts the vendor's bin/res/data/ENE/ file into build/vendor-data/ENE/,
// and scripts/build.mjs copies the contents of vendor-data/ into the app's resources/ (= resourcesDir,
// src/main/paths.ts), flattening the vendor's data/ level as for MonitorInfo.json and PCenter_DeviceInfo.json.
// <resourcesDir>/data/ENE/ (the vendor's own level) is accepted as well, so a packaging that keeps
// data/ does not silently disable the ENE path.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../types.ts';
import { parseJson } from '../core/json.ts';

export interface EneModelLayout {
  modelName: string;
  rightLedCount: number;
  rightUpLedCount: number;
  leftUpLedCount: number;
  leftLedCount: number;
  centerLedCount: number;
  bottomLedCount: number;
}

const AMBIGLOW_INFO_FILE = 'PCenter_AmbiglowInfo.json';

/**
 * Locations relative to HostServices.resourcesDir, in the order tried: the build's (the data/ level
 * dropped, see the header; locked to the build by ene-layout.test.ts), then the vendor's
 * <app>/res/data/ENE/ layout (GClass0.cs:15-23).
 */
export const AMBIGLOW_INFO_PATHS: readonly string[] = [join('ENE', AMBIGLOW_INFO_FILE), join('data', 'ENE', AMBIGLOW_INFO_FILE)];

const COUNT_FIELDS = [
  ['rightLedCount', 'RightLedCount'],
  ['rightUpLedCount', 'RightUpLedCount'],
  ['leftUpLedCount', 'LeftUpLedCount'],
  ['leftLedCount', 'LeftLedCount'],
  ['centerLedCount', 'CenterLedCount'],
  ['bottomLedCount', 'BottomLedCount'],
] as const;

/**
 * Parse the file (UTF-8, optional BOM). Like Newtonsoft into GClass1: property names match
 * case-insensitively, a missing count is 0, and unknown members (WriteType) are ignored.
 * Entries without a model name cannot be matched and are dropped. Throws on malformed input.
 */
export function parseAmbiglowInfo(text: string): EneModelLayout[] {
  const root = parseJson<unknown>(text);
  if (!Array.isArray(root)) throw new Error('PCenter_AmbiglowInfo.json: expected a JSON array');
  const layouts: EneModelLayout[] = [];
  root.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) throw new Error(`PCenter_AmbiglowInfo.json[${index}]: expected an object`);
    const byLowerKey = new Map(Object.entries(entry).map(([k, v]) => [k.toLowerCase(), v]));
    const modelName = byLowerKey.get('modelname');
    if (typeof modelName !== 'string' || modelName === '') return;
    const layout: EneModelLayout = {
      modelName,
      rightLedCount: 0,
      rightUpLedCount: 0,
      leftUpLedCount: 0,
      leftLedCount: 0,
      centerLedCount: 0,
      bottomLedCount: 0,
    };
    for (const [field, jsonName] of COUNT_FIELDS) {
      const value = byLowerKey.get(jsonName.toLowerCase());
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
        throw new Error(`PCenter_AmbiglowInfo.json[${index}].${jsonName}: expected an LED count 0..255, got ${JSON.stringify(value)}`);
      }
      layout[field] = value;
    }
    layouts.push(layout);
  });
  return layouts;
}

/**
 * Load the table from resourcesDir: the first of AMBIGLOW_INFO_PATHS that can be read is used (and
 * logged). A missing or malformed table is logged and yields an empty table, which (as in the vendor
 * app) means no ENE device is supported and the DDC path is used.
 */
export async function loadAmbiglowInfo(resourcesDir: string, log: Logger): Promise<EneModelLayout[]> {
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const failures: string[] = [];
  for (const relative of AMBIGLOW_INFO_PATHS) {
    const path = join(resourcesDir, relative);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      failures.push(message(e));
      continue;
    }
    try {
      const layouts = parseAmbiglowInfo(text);
      log.info(`ENE model table ${path}: ${layouts.length} models`);
      return layouts;
    } catch (e) {
      log.warn(`ENE model table ${path} is malformed (${message(e)}); the ENE Ambiglow driver is disabled`);
      return [];
    }
  }
  log.warn(`ENE model table ${AMBIGLOW_INFO_FILE} not found (${failures.join('; ')}); the ENE Ambiglow driver is disabled`);
  return [];
}

/**
 * Layout for an ENE model name. Case-insensitive: the vendor's support check ignores case
 * (CUSBENE6K7732.cs:248) but its layout lookup does not (GClass0.GetENELightNumbersData), which
 * would crash follow-video for a device reporting a differently-cased name. Deviation, 09 §7.3.
 */
export function findModelLayout(layouts: readonly EneModelLayout[], modelName: string): EneModelLayout | undefined {
  const wanted = modelName.toLowerCase();
  return layouts.find((l) => l.modelName.toLowerCase() === wanted);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHL_PREFIX = '^((PHL )|(PHL_)|(PHL))?';

/**
 * CUSBENE6K7732.GetModelName (CUSBENE6K7732.cs:123-135): pair the monitor's DDC/EDID model name
 * (e.g. "PHL 34M2C8600") with the name an ENE device reported. First an ENE name that equals the
 * monitor name minus an optional "PHL"/"PHL "/"PHL_" prefix; otherwise an ENE name that starts with
 * (optional prefix +) the monitor name followed only by letters/digits. Case-insensitive.
 */
export function matchEneModelName(monitorName: string, eneModelNames: readonly string[]): string | undefined {
  if (monitorName === '') return undefined;
  const exact = eneModelNames.find((e) => new RegExp(`${PHL_PREFIX}${escapeRegExp(e)}$`, 'i').test(monitorName));
  if (exact !== undefined) return exact;
  const prefixed = new RegExp(`${PHL_PREFIX}${escapeRegExp(monitorName)}[0-9a-zA-Z]*$`, 'i');
  return eneModelNames.find((e) => prefixed.test(e));
}
