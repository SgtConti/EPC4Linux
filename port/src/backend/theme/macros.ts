// Macro_* file operations (SO:1972-2542): Theme/<theme>/Macro/<name>.macro (20-theme §3.5, §5.6).
//
// Macros belong to the peripheral button editor, which the monitor-only port hides, but the renderer
// calls Macro_GetList at start-up and on every theme change (MN:207-208, MN:1884-1893), and the files
// must stay compatible with the Windows backend. Codes and texts are the vendor's.
//
// The vendor also rewrote button bindings in every profile of the current theme after Rename, Update,
// Del and Import-with-override (IButton.SyncButtonMacro / RemoveButtonMacre). Only peripheral drivers
// implement IButton; with no such driver those loops only re-save the profiles unchanged — except the
// current profile, which was written under Theme/<target theme>/ even when the macro belonged to
// another theme (B-8). The port has no IButton drivers and skips the loops.
//
// Port deviations: a theme name is resolved case-insensitively to its directory (Linux paths are
// case-sensitive, Windows' are not); names that are not valid file names ("." and ".." included) are
// never used as path components (the vendor did not validate the theme name or the macro name outside
// Macro_Add/Copy/Rename, so "../.." reached outside Theme/); Macro_GetList lists *.macro files only;
// Macro_Copy without a new name picks a free name among the macros (the vendor looked at the theme's
// profile files and could overwrite an existing macro).

import { lstat, readdir, rename, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import type { JsonResult, Logger } from '../types.ts';
import { error, exception, succ } from '../core/envelope.ts';
import {
  bindMacroInfo,
  isDirectory,
  isFile,
  loadConfigFile,
  macroInfoJson,
  macroIsComMacro,
  newMacroInfo,
  parseJsonText,
  saveConfigFile,
  type MacroInfoModel,
} from './formats.ts';
import { changeExtension, genValidName, getFileNameWithoutExtension, isValidName, isValidNewName } from './names.ts';
import { MACRO_EXTENSION, type WorkspacePaths } from './paths.ts';

export interface MacroOpsDeps {
  paths: WorkspacePaths;
  log: Logger;
  /** Run on the engine lock. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Canonical directory name of a theme (case-insensitive DataTheme lookup, else the name itself). */
  themeDirName(themeName: string): string;
  /**
   * The host's policy for file paths the renderer sends (HostServices.pathAllowed): Macro_GetDetail(file),
   * Macro_VerifyFile and Macro_Import read them, Macro_Export writes one. Absent: allowed.
   */
  pathAllowed?(path: string, access: 'read' | 'write'): boolean;
}

/** MacroAttributeInfo (EN/MacroAttributeInfo.cs). */
interface MacroAttributeInfo {
  MacroName: string;
  IsComMacro: boolean;
}

export class MacroOps {
  readonly #d: MacroOpsDeps;

  constructor(deps: MacroOpsDeps) {
    this.#d = deps;
  }

  #allowed(path: string, access: 'read' | 'write'): boolean {
    return this.#d.pathAllowed?.(path, access) ?? true;
  }

  /** Path.Combine(ThemeRootDir, themeName) as the vendor prints it in "not exit" errors. */
  #rawThemeDir(themeName: string): string {
    return themeName.startsWith('/') ? themeName : `${this.#d.paths.themeRootDir}/${themeName}`;
  }

  /** The theme directory if the theme name is usable and the directory exists; else the vendor's error 3. */
  async #themeDir(themeName: string): Promise<{ dir: string; name: string } | JsonResult> {
    if (isValidName(themeName)) {
      const name = this.#d.themeDirName(themeName);
      const dir = this.#d.paths.themeDir(name);
      if (await isDirectory(dir)) return { dir, name };
    }
    return error(`Theme=${themeName} path=${this.#rawThemeDir(themeName)} not exit`, 3);
  }

  #macroPath(themeDirName: string, macroName: string): string | null {
    return isValidName(macroName) ? this.#d.paths.macroFilePath(themeDirName, macroName) : null;
  }

  /** smethod_15/16: `new MacroInfo()` then LoadTXTConfig → null when missing or unparsable. */
  async #load(path: string | null): Promise<MacroInfoModel | null> {
    return path ? loadConfigFile(path, bindMacroInfo) : null;
  }

  #save(path: string, m: MacroInfoModel): Promise<boolean> {
    // In place when the file exists: the list is ordered by creation time (see formats.writeFileInPlace).
    return saveConfigFile(path, macroInfoJson(m), { inPlace: true, onError: (e) => this.#d.log.error(`SaveTXTConfig ${path} failed`, e) });
  }

  /** DirectroyUtil.GetFileNameListOrderByCreateTime(Macro dir, false), *.macro only. */
  async #listNames(themeDirName: string): Promise<string[]> {
    const dir = this.#d.paths.macroDir(themeDirName);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const files: { name: string; time: number }[] = [];
    for (const n of names) {
      if (!n.toLowerCase().endsWith(MACRO_EXTENSION)) continue;
      try {
        const s = await lstat(join(dir, n));
        if (!s.isFile()) continue;
        files.push({ name: n.slice(0, -MACRO_EXTENSION.length), time: s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs });
      } catch {
        // vanished
      }
    }
    files.sort((a, b) => a.time - b.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return files.map((f) => f.name);
  }

  async #list(themeDirName: string): Promise<MacroAttributeInfo[]> {
    const names = await this.#listNames(themeDirName);
    return Promise.all(
      names.map(async (MacroName) => {
        const m = await this.#load(this.#macroPath(themeDirName, MacroName));
        return { MacroName, IsComMacro: m ? macroIsComMacro(m) : false };
      }),
    );
  }

  /** Macro_GetList(theme) (SO:1972-2010): [{MacroName, IsComMacro}] by creation time, [] without Macro/. */
  getList(themeName: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      try {
        return succ(await this.#list(t.name));
      } catch (e) {
        return exception(e);
      }
    });
  }

  /** Macro_GetDetail(theme, name) (SO:2012-2020): Tag MacroInfo, or null when missing/unparsable. */
  getDetail(themeName: string, name: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      const m = await this.#load(this.#macroPath(t.name, name));
      return succ(m ? macroInfoJson(m) : null);
    });
  }

  /** Macro_GetDetail(filePath) (SO:2022-2029); a path the host refuses reads as missing. */
  getDetailFile(filePath: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      if (!this.#allowed(filePath, 'read') || !(await isFile(filePath))) return error(`file=${filePath} not exit`, 3);
      const m = await this.#load(filePath);
      return succ(m ? macroInfoJson(m) : null);
    });
  }

  /** Macro_VerifyFile(filePath) (SO:2031-2044): Tag true when the file parses as a MacroInfo. */
  verifyFile(filePath: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      if (!this.#allowed(filePath, 'read') || !(await isFile(filePath))) return succ(false);
      return succ((await this.#load(filePath)) !== null);
    });
  }

  /** Macro_Add(theme, name) (SO:2046-2085): writes {"Name":n,"MacroContent":[],"IsComMacro":true}. */
  add(themeName: string, name: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      try {
        if (!isValidNewName(name)) return error(`The Macro name: ${name} is not valid`, 2);
        const path = this.#d.paths.macroFilePath(t.name, name);
        if (await isFile(path)) return error(`The Macro name: ${name} already exists`, 4);
        if (await this.#save(path, newMacroInfo(name))) {
          const now = new Date();
          await utimes(path, now, now).catch(() => undefined);
          return succ(await this.#list(t.name));
        }
        await rm(path, { force: true });
        return error(`Save Macro error: ${name}`);
      } catch (e) {
        return exception(e);
      }
    });
  }

  /** Macro_Copy(theme, name, newName) (SO:2087-2131); Tag = Macro_GetList. */
  copy(themeName: string, name: string, newName: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      try {
        let target = newName;
        if (target) {
          if (!isValidNewName(target)) return error(`The Macro newName: ${target} is not valid`, 2);
          const p = this.#d.paths.macroFilePath(t.name, target);
          if (await isFile(p)) return error(`The Macro newName: ${p} is exists`, 4);
        } else {
          target = genValidName(await this.#listNames(t.name), name, 'Macro');
        }
        const src = this.#macroPath(t.name, name) ?? `${this.#d.paths.macroDir(t.name)}/${name}${MACRO_EXTENSION}`;
        if (!isValidName(name) || !(await isFile(src))) return error(`The Macro name: ${src} is not exists`);
        const m = await this.#load(src);
        if (!m) return error(`Macro_Copy ori macro=${name} content is not valid`, 5);
        await this.#save(this.#d.paths.macroFilePath(t.name, target), m);
        return succ(await this.#list(t.name));
      } catch (e) {
        return exception(e);
      }
    });
  }

  /** Macro_Rename(theme, old, new) (SO:2133-2224); the file name is authoritative (Name is not updated). */
  rename(themeName: string, oldName: string, newName: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      try {
        if (!isValidNewName(newName)) return error(`The macro newName:${newName}  is not valid`, 2);
        const dst = this.#d.paths.macroFilePath(t.name, newName);
        if (await isFile(dst)) return error(`The macro newName:${newName} already exists`, 4);
        const src = this.#macroPath(t.name, oldName);
        if (!src || !(await isFile(src))) return error('Macro_Update MoveFile error');
        try {
          await rename(src, dst);
        } catch {
          return error('Macro_Update MoveFile error');
        }
        return succ(await this.#list(t.name));
      } catch (e) {
        return exception(e);
      }
    });
  }

  /** Macro_Update(theme, name, macroData) (SO:2226-2311): Tag = the stored MacroInfo. */
  update(themeName: string, name: string, macroData: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      const raw = parseJsonText(macroData);
      let m: MacroInfoModel | null = null;
      try {
        if (raw !== undefined) m = bindMacroInfo(raw);
      } catch {
        m = null;
      }
      if (!m) return error('Macro_UpdateData macroData is not valid', 5);
      const path = this.#macroPath(t.name, name);
      if (!path || !(await this.#save(path, m))) return error('Macro_UpdateData save error');
      return succ(macroInfoJson(m));
    });
  }

  /** Macro_Del(theme, name) (SO:2313-2399); Tag = Macro_GetList. */
  del(themeName: string, name: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      try {
        const path = this.#macroPath(t.name, name);
        if (path) await rm(path, { force: true });
        return succ(await this.#list(t.name));
      } catch (e) {
        return exception(e);
      }
    });
  }

  /** Macro_Import(theme, filePath, bOverride) (SO:2401-2501); Tag = Macro_GetList. */
  import(themeName: string, filePath: string, bOverride: boolean): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      try {
        if (!this.#allowed(filePath, 'read') || !(await isFile(filePath))) return error(`MacroImport filePath=${filePath} is not exit`);
        const base = getFileNameWithoutExtension(filePath);
        const name = bOverride && isValidNewName(base) ? base : genValidName(await this.#listNames(t.name), base, 'Macro');
        const m = await this.#load(filePath);
        if (!m) return error('Macro_Import macro content is not valid', 5);
        await this.#save(this.#d.paths.macroFilePath(t.name, name), m);
        return succ(await this.#list(t.name));
      } catch (e) {
        return exception(e);
      }
    });
  }

  /**
   * Macro_Export(theme, name, exportPath) (SO:2503-2528): written to ChangeExtension(path, ".macro"). Port:
   * that final path must be one the host allows writing (the export dialog's choice), else the vendor's
   * "save file error". So a chosen "Racing" whose "Racing.macro" exists (the dialog confirmed "Racing", not
   * the file the extension change would replace) is refused instead of overwritten.
   */
  export(themeName: string, name: string, exportPath: string): Promise<JsonResult> {
    return this.#d.exclusive(async () => {
      const t = await this.#themeDir(themeName);
      if (!('dir' in t)) return t;
      try {
        const m = await this.#load(this.#macroPath(t.name, name));
        if (!m) return error(`Macro_Export ori macro=${name} content is not valid`, 5);
        const target = exportPath ? changeExtension(exportPath, MACRO_EXTENSION) : '';
        if (!target || !this.#allowed(target, 'write') || !(await saveConfigFile(target, macroInfoJson(m)))) {
          return error('Macro_Export save file error');
        }
        return succ();
      } catch (e) {
        return exception(e);
      }
    });
  }
}
