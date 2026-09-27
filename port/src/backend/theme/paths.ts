// WorkspacePath (EN/WorkspacePath.cs) rooted at HostServices.serveDataDir, which mirrors
// %APPDATA%\EvniaServe (20-theme §2, §10.1). Relative layout identical to Windows so files can be
// copied across in both directions.

import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';

export const THEME_DIR_NAME = 'Theme';
export const CONFIG_DIR_NAME = 'Config';
export const LOGS_DIR_NAME = 'logs';
export const DATA_THEME_FILE = 'DataTheme.cfg';
export const SOFT_CONFIG_FILE = 'SoftConfig.data';
export const PROFILE_EXTENSION = '.pcenter';
export const MACRO_DIR_NAME = 'Macro';
export const MACRO_EXTENSION = '.macro';
export const ICON_DIR_NAME = 'Icon';
/** WorkspacePath.CONST_USER / CONST_PROFILE_NAME / CONST_THEME_NAME. */
export const USER_THEME = 'User';
export const DEFAULT_PROFILE = 'Default';
export const SERVE_DATA_NAME = 'EvniaServe';

/**
 * PathBase.PATH_APP_TEMP on Linux (20-theme §10.1): `$XDG_RUNTIME_DIR/EvniaServe` (the per-user runtime
 * directory, mode 0700 by the XDG spec), else `<os.tmpdir()>/EvniaServe-<uid>`. The vendor used
 * `%TEMP%\EvniaServe`, which is per user on Windows; a single shared `/tmp/EvniaServe` would belong to
 * whichever user created it first, so every other user would get no app icons (ensurePrivateDir refuses
 * a foreign directory) and any local user could pre-create it to disable them.
 *
 * Integration: the main process must serve the same directory through `local:` (main/index.ts
 * `privateRoots`), so it should call this function instead of hard-coding a path.
 */
export function defaultAppTempDir(env: NodeJS.ProcessEnv = process.env): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) return join(runtime, SERVE_DATA_NAME);
  let uid: number | string;
  if (typeof process.getuid === 'function') uid = process.getuid();
  else {
    try {
      uid = userInfo().username;
    } catch {
      uid = 'user';
    }
  }
  return join(tmpdir(), `${SERVE_DATA_NAME}-${uid}`);
}

export class WorkspacePaths {
  /** PathBase.PATH_APP_DATA. */
  readonly appData: string;
  /** PathBase.PATH_APP_TEMP (Comm_GenAppIcon staging), see defaultAppTempDir. */
  readonly appTemp: string;

  constructor(serveDataDir: string, appTemp: string = defaultAppTempDir()) {
    this.appData = serveDataDir;
    this.appTemp = appTemp;
  }

  /** WorkspacePath.ThemeRootDir. */
  get themeRootDir(): string {
    return join(this.appData, THEME_DIR_NAME);
  }

  get configDir(): string {
    return join(this.appData, CONFIG_DIR_NAME);
  }

  get dataThemePath(): string {
    return join(this.themeRootDir, DATA_THEME_FILE);
  }

  get softConfigPath(): string {
    return join(this.configDir, SOFT_CONFIG_FILE);
  }

  /** GetThemeProfileDir(name) = Theme/<name>. */
  themeDir(themeName: string): string {
    return join(this.themeRootDir, themeName);
  }

  /** GetProfilePath(theme, profile) = Theme/<theme>/<profile>.pcenter. */
  profilePath(themeName: string, profileName: string): string {
    return join(this.themeDir(themeName), profileName + PROFILE_EXTENSION);
  }

  /** GetMacroDir(theme) = Theme/<theme>/Macro. */
  macroDir(themeName: string): string {
    return join(this.themeDir(themeName), MACRO_DIR_NAME);
  }

  /** GetMacroFilePath(theme, name) = Theme/<theme>/Macro/<name>.macro. */
  macroFilePath(themeName: string, macroName: string): string {
    return join(this.macroDir(themeName), macroName + MACRO_EXTENSION);
  }

  /** Theme/<theme>/Icon/<file> (TO:194). */
  iconPath(themeName: string, fileName: string): string {
    return join(this.themeDir(themeName), ICON_DIR_NAME, fileName);
  }
}
