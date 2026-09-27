// Config/color.data: the Ambiglow colour palette of Effect_GetColorData / Effect_SetSelfColors
// (SystemOper.cs:1351-1383; EffectColorData.cs; file format 20-theme-profile-engine §3.7, reader and writer
// rules §3.1; fixture 20-enum-valuelist-catalog §6.6; golden step 7 in 20-backend-host-tail §5).
//
//   {"DefColors":[{"R":255,"G":255,"B":255},…13 colours…],"SelfColors":"#rrggbb,#rrggbb,…"}
//
// DefColors is a public field and precedes the SelfColors property. SelfColors is the renderer's CSV
// (Ambiglow-Dvqon39u.js Le(): at most 14 entries), stored verbatim. The file is written only by
// Effect_SetSelfColors; a missing, empty or unreadable file makes both functions use DefData().
// The writer is theme/formats.ts saveConfigFile: UTF-8 BOM + one line, like SaveTXTConfig (atomic rename
// instead of truncate-in-place, impl-theme deviation 1).

import { join } from 'node:path';
import type { Logger } from '../types.ts';
import { Mutex } from '../core/events.ts';
import { bindObject, bindRgb, convList, convString, loadConfigFile, saveConfigFile, type Conv, type RgbModel } from '../theme/formats.ts';
import { CONFIG_DIR_NAME } from '../theme/paths.ts';

export const COLOR_DATA_FILE = 'color.data';

/** EffectColorData (ENT/EffectColorData.cs). A null list element is kept like Newtonsoft's List<RGB>. */
export interface EffectColorData {
  DefColors: (RgbModel | null)[];
  SelfColors: string;
}

const DEF_COLORS: ReadonlyArray<readonly [number, number, number]> = [
  [255, 255, 255],
  [255, 0, 0],
  [255, 0, 127],
  [127, 0, 127],
  [127, 0, 255],
  [0, 0, 255],
  [0, 127, 255],
  [0, 255, 255],
  [0, 255, 127],
  [0, 255, 0],
  [127, 255, 0],
  [255, 255, 0],
  [255, 127, 0],
];

/** EffectColorData.DefData() (EffectColorData.cs:28-49): 13 colours, SelfColors "". */
export function defaultColorData(): EffectColorData {
  return { DefColors: DEF_COLORS.map(([R, G, B]) => ({ R, G, B })), SelfColors: '' };
}

/** Newtonsoft JsonDeserialize<EffectColorData>: field initializers (empty list, ""), nulls ignored. */
export function bindColorData(v: unknown, path = 'EffectColorData'): EffectColorData {
  const rgb: Conv<RgbModel> = (value, p) => bindRgb(value, p);
  return bindObject<EffectColorData>(v, path, () => ({ DefColors: [], SelfColors: '' }), {
    DefColors: convList(rgb, true),
    SelfColors: convString,
  });
}

/** The ordered JSON object (fields first, then properties). */
export function colorDataJson(d: EffectColorData): EffectColorData {
  return { DefColors: d.DefColors.map((c) => (c === null ? null : { R: c.R, G: c.G, B: c.B })), SelfColors: d.SelfColors };
}

/** WorkspacePath.ColorConfigFilePath = <APPDATA>\EvniaServe\Config\color.data (WorkspacePath.cs:36). */
export function colorDataPath(serveDataDir: string): string {
  return join(serveDataDir, CONFIG_DIR_NAME, COLOR_DATA_FILE);
}

export class ColorDataStore {
  readonly path: string;
  readonly #log: Logger;
  readonly #mutex = new Mutex();

  constructor(path: string, log: Logger) {
    this.path = path;
    this.#log = log;
  }

  /** Effect_GetColorData: the parsed file, else DefData() (LoadTXTConfig leaves null → DefData). */
  async get(): Promise<EffectColorData> {
    return this.#mutex.run(async () => (await loadConfigFile(this.path, bindColorData)) ?? defaultColorData());
  }

  /**
   * Effect_SetSelfColors: load (or DefData), set SelfColors, save. The vendor ignores a failed save
   * (SaveTXTConfig returns false and only logs) and still answers with the object; so does the port.
   */
  async setSelfColors(colors: string): Promise<EffectColorData> {
    return this.#mutex.run(async () => {
      const data = (await loadConfigFile(this.path, bindColorData)) ?? defaultColorData();
      data.SelfColors = colors;
      const ok = await saveConfigFile(this.path, colorDataJson(data), {
        onError: (e) => this.#log.error(`SaveTXTConfig ${this.path} failed:`, e instanceof Error ? e.message : e),
      });
      if (ok) this.#log.debug(`saved ${this.path}`);
      return data;
    });
  }
}
