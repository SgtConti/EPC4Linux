// App-bound themes on Linux: Comm_GenAppIcon (GO:134-146) and CheckTopApp (SO:3295-3345).
//
// Vendor model (05 summary, 20-backend-host-tail §2.4): once per second the backend looks at the
// foreground window's executable; when the theme bound to it (or "User" when none is) differs from the
// current theme it sends NotifyUISwitchTheme with Tag = the theme name. The backend does NOT switch by
// itself — the renderer answers with Theme_SwitchApp (MN:1917-1925).
//
// Linux (20-theme §10.2): BindAppFilePath is either a `.desktop` file (desktop-id binding) or an
// executable. HostServices.getForegroundAppPath() gives the foreground executable (X11 only; null on
// GNOME Wayland, where the feature is inert — ARCHITECTURE "Linux integration"). A host may also offer
// the optional getForegroundApp() extension (ForegroundAppHost below) with the window's WM_CLASS /
// app_id, which enables the desktop-id and StartupWMClass rules.

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { Logger } from '../types.ts';
import {
  desktopExecCommand,
  desktopExecTarget,
  desktopIdOf,
  desktopSnapName,
  isInterpreter,
  isScript,
  listDesktopFiles,
  readDesktopEntry,
  realpathOrNull,
  scriptAppDirectories,
  snapNameOfCommand,
  xdgDataDirs,
  type DesktopEntry,
} from './desktop-entry.ts';
import { equalsIgnoreCase, getExtension } from './names.ts';

// ───────────────────────────── Icons (Comm_GenAppIcon) ─────────────────────────────

/** Image types Chromium can show through the local: protocol (main/local-protocol.ts). */
const IMAGE_EXTENSIONS = new Set(['.png', '.svg', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
const MAX_ICON_BYTES = 5 * 1024 * 1024;
/** hicolor sizes, largest first (the UI shows the icon at about 40 px on a HiDPI screen). */
const ICON_SIZES = ['256x256', '512x512', '192x192', '128x128', '96x96', '72x72', '64x64', '48x48', '36x36', '32x32', '24x24', '22x22', '16x16'];
const ICON_CONTEXTS = ['apps', 'applications'];
const ICON_THEMES = ['hicolor', 'Adwaita'];

async function isImageFile(path: string): Promise<boolean> {
  if (!IMAGE_EXTENSIONS.has(getExtension(path).toLowerCase())) return false;
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0 && s.size <= MAX_ICON_BYTES;
  } catch {
    return false;
  }
}

/**
 * Icon Theme Specification lookup of an `Icon=` value, restricted to what a browser can display:
 * an absolute image path as is; otherwise <name>.png in hicolor (then Adwaita) at the sizes above,
 * then <name>.svg in scalable/, then /usr/share/pixmaps/<name>.{png,svg}. XPM is skipped.
 */
export async function lookupIcon(icon: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (isAbsolute(icon)) return (await isImageFile(icon)) ? icon : null;
  const name = icon.replace(/\.(png|svg|xpm)$/i, '');
  if (name === '' || name.includes('/')) return null;
  const home = env.HOME || homedir();
  const bases = [...xdgDataDirs(env).map((d) => join(d, 'icons')), join(home, '.icons')];
  for (const theme of ICON_THEMES) {
    for (const size of ICON_SIZES) {
      for (const base of bases) {
        for (const ctx of ICON_CONTEXTS) {
          const p = join(base, theme, size, ctx, `${name}.png`);
          if (await isImageFile(p)) return p;
        }
      }
    }
    for (const base of bases) {
      for (const ctx of ICON_CONTEXTS) {
        const p = join(base, theme, 'scalable', ctx, `${name}.svg`);
        if (await isImageFile(p)) return p;
      }
    }
  }
  for (const dir of ['/usr/share/pixmaps', ...xdgDataDirs(env).map((d) => join(d, 'pixmaps'))]) {
    for (const ext of ['.png', '.svg']) {
      const p = join(dir, name + ext);
      if (await isImageFile(p)) return p;
    }
  }
  return null;
}

/** An ELF (or script) binding: the desktop entry that launches it, for its Icon= (20-theme §10.2 item 4). */
async function desktopEntryForExecutable(exe: string, env: NodeJS.ProcessEnv): Promise<DesktopEntry | null> {
  const real = await realpathOrNull(exe);
  if (!real) return null;
  for (const file of await listDesktopFiles(env)) {
    const entry = await readDesktopEntry(file);
    if (entry?.icon && (await desktopExecTarget(entry, env)) === real) return entry;
  }
  return null;
}

/**
 * PathBase.PATH_APP_TEMP, created on demand. It is per user (paths.defaultAppTempDir: $XDG_RUNTIME_DIR,
 * else <tmp>/EvniaServe-<uid>), but the fallback lives in the shared /tmp, so it must be a real directory
 * owned by this user (mode 0700): a pre-created foreign directory or a symlink planted by another local
 * user is refused, and the icon falls back to "" (the vendor's failure value).
 */
export async function ensurePrivateDir(dir: string, log: Logger): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const s = await lstat(dir);
    if (!s.isDirectory()) {
      log.warn(`${dir} is not a directory; app icons disabled`);
      return false;
    }
    if (typeof process.getuid === 'function' && s.uid !== process.getuid()) {
      log.warn(`${dir} belongs to uid ${s.uid}; app icons disabled`);
      return false;
    }
    return true;
  } catch (e) {
    log.warn(`cannot create ${dir}:`, (e as Error).message);
    return false;
  }
}

/**
 * GlobalOper.GenAppIcon (GO:134-146) for Linux: "" unless `appPath` is an existing file; a `.desktop`
 * file gives its Icon=, an executable the Icon= of the desktop entry that launches it. The icon is
 * copied to PATH_APP_TEMP/<unix seconds>.<png|svg> and that path is returned; "" when no displayable
 * icon exists.
 *
 * Deviations: the vendor extracted the icon resource of the .exe; its name was whole seconds in China
 * Standard Time, so two icons made in the same second overwrote each other — here a numeric suffix
 * keeps them apart; an SVG icon keeps the .svg extension (the renderer loads it through local://,
 * which types files by extension). `appPath` comes from the renderer, so only what the app picker can
 * bind is looked at (20-theme §10.2 item 1): an absolute path to a `.desktop` file or to an executable
 * file; any other file gives "" without being opened (HostServices.pathAllowed does not apply here: a
 * bound app's path is not a file the user picked in this session).
 */
export async function genAppIcon(appPath: string, appTempDir: string, log: Logger, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (!appPath || !isAbsolute(appPath)) return '';
  try {
    const s = await stat(appPath);
    if (!s.isFile()) return '';
    if (!appPath.endsWith('.desktop') && (s.mode & 0o111) === 0) {
      log.debug(`GenAppIcon: ${appPath} is neither a desktop entry nor an executable`);
      return '';
    }
  } catch {
    return '';
  }
  const entry = appPath.endsWith('.desktop') ? await readDesktopEntry(appPath) : await desktopEntryForExecutable(appPath, env);
  const source = entry?.icon ? await lookupIcon(entry.icon, env) : null;
  if (!source) {
    log.debug(`GenAppIcon: no displayable icon for ${appPath}`);
    return '';
  }
  if (!(await ensurePrivateDir(appTempDir, log))) return '';
  const ext = getExtension(source).toLowerCase() === '.svg' ? '.svg' : '.png';
  const stamp = Math.floor(Date.now() / 1000);
  for (let n = 0; n < 100; n++) {
    const target = join(appTempDir, `${stamp}${n === 0 ? '' : `_${n}`}${ext}`);
    try {
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      const now = new Date();
      await utimes(target, now, now).catch(() => undefined);
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.error(`GenAppIcon: copy ${source} → ${target} failed:`, (e as Error).message);
        return '';
      }
    }
  }
  return '';
}

/** FileUtil.MoveFile (overwrite, directory created); falls back to copy + delete across file systems. */
export async function moveFile(src: string, dst: string): Promise<boolean> {
  try {
    if (!(await stat(src)).isFile()) return false;
    await mkdir(dirname(dst), { recursive: true });
    try {
      await rename(src, dst);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      const tmp = join(dirname(dst), `.evnia-${randomBytes(4).toString('hex')}.tmp`);
      await copyFile(src, tmp);
      await rename(tmp, dst);
      await rm(src, { force: true });
    }
    return true;
  } catch {
    return false;
  }
}

/** Delete stale Comm_GenAppIcon files (the vendor never removed unbound ones, 20-theme §3.4). */
export async function pruneTempIcons(appTempDir: string, maxAgeMs: number, log: Logger): Promise<void> {
  let names: string[];
  try {
    const s = await lstat(appTempDir);
    if (!s.isDirectory() || (typeof process.getuid === 'function' && s.uid !== process.getuid())) return;
    names = await readdir(appTempDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!/^\d+(_\d+)?\.(png|svg)$/.test(name)) continue;
    const p = join(appTempDir, name);
    try {
      const s = await lstat(p);
      if (s.isFile() && s.mtimeMs < cutoff) await rm(p, { force: true });
    } catch (e) {
      log.debug(`pruneTempIcons ${p}:`, (e as Error).message);
    }
  }
}

// ───────────────────────────── Foreground matching (CheckTopApp / smethod_21) ─────────────────────────────

/**
 * What the host knows about the foreground window. `exe` is HostServices.getForegroundAppPath()
 * (/proc/<pid>/exe of `_NET_WM_PID` on X11). `wmClass` (X11 WM_CLASS class part) and `appId` (Wayland
 * app_id, or a Flatpak application id) are optional: a host can report them through the optional
 * `getForegroundApp()` extension below, which enables the desktop-id / StartupWMClass / Flatpak-id rules
 * of 20-theme §10.2 item 5.
 */
export interface ForegroundApp {
  readonly exe: string | null;
  readonly wmClass?: string | null;
  readonly appId?: string | null;
}

/**
 * Optional host extension (duck-typed on HostServices; types.ts is not changed): when present,
 * getForegroundApp() is used instead of getForegroundAppPath(). Documented in docs/port/impl-theme.md §3.4
 * for the main process.
 */
export interface ForegroundAppHost {
  getForegroundApp?(): ForegroundApp | null;
  /**
   * Stop following the foreground window until the next getForegroundApp()/getForegroundAppPath() call,
   * which starts it again (X11: the `xprop -spy` child exits). CheckTopApp calls it while no answer could
   * change anything (AppBindingWatcher), so focus changes are not tracked for nothing.
   */
  releaseForegroundApp?(): void;
}

export interface BindingTheme {
  readonly Name: string | null;
  readonly BindAppInfos: readonly ({ readonly BindAppFilePath: string | null } | null)[];
}

interface ResolvedBinding {
  /** Real path of the launched binary; null for interpreters and snap launchers (they would over-match). */
  realExe: string | null;
  snap: string | null;
  /** Directories of the application when Exec is a wrapper script (scriptAppDirectories). */
  appDirs: readonly string[];
  /** `.desktop` bindings: desktop-file ID and StartupWMClass. */
  desktopId: string | null;
  wmClass: string | null;
  at: number;
}

function inside(path: string | null, dir: string): boolean {
  return path !== null && path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);
}

/** Caches what each binding launches (desktop parsing and PATH lookups run only on foreground changes). */
export class BindingResolver {
  readonly #env: NodeJS.ProcessEnv;
  readonly #ttlMs: number;
  readonly #cache = new Map<string, ResolvedBinding>();

  constructor(env: NodeJS.ProcessEnv = process.env, ttlMs = 30_000) {
    this.#env = env;
    this.#ttlMs = ttlMs;
  }

  /** The launched program (PATH-resolved command, then realpath) with the interpreter/snap/script rules applied. */
  async #launcher(command: string | null): Promise<Pick<ResolvedBinding, 'realExe' | 'snap' | 'appDirs'>> {
    const snap = snapNameOfCommand(command);
    const real = await realpathOrNull(command);
    if (snap !== null || real === null || isInterpreter(real) || (command !== null && isInterpreter(command))) {
      return { realExe: null, snap, appDirs: [] };
    }
    return { realExe: real, snap: null, appDirs: (await isScript(real)) ? scriptAppDirectories(real, this.#env) : [] };
  }

  async #resolve(bindPath: string): Promise<ResolvedBinding> {
    const hit = this.#cache.get(bindPath);
    if (hit && Date.now() - hit.at < this.#ttlMs) return hit;
    let r: ResolvedBinding = { realExe: null, snap: null, appDirs: [], desktopId: null, wmClass: null, at: Date.now() };
    if (bindPath.endsWith('.desktop')) {
      const entry = await readDesktopEntry(bindPath);
      if (entry) {
        const launcher = await this.#launcher(await desktopExecCommand(entry, this.#env));
        const snap = launcher.snap ?? (await desktopSnapName(entry, this.#env));
        r = { ...r, ...launcher, snap, desktopId: desktopIdOf(bindPath), wmClass: entry.startupWmClass };
      }
    } else {
      r = { ...r, ...(await this.#launcher(bindPath)) };
    }
    this.#cache.set(bindPath, r);
    return r;
  }

  /**
   * Does `bindPath` match the foreground app? Vendor rule first (OrdinalIgnoreCase equality of the
   * stored path, SO:3347-3360), then the Linux rules of 20-theme §10.2 item 5:
   *   - `.desktop`: WM_CLASS or app_id equal (ignoring case) to the desktop-file ID or StartupWMClass
   *     (only when the host reports them);
   *   - the real path of the binding (ELF) or of what the entry's Exec runs equals the foreground binary,
   *     except for interpreters (`python3 x.py`, `java -jar`, `sh -c`, `flatpak run`), which would match
   *     every program they run;
   *   - a wrapper script launches a binary of its own application directory (scriptAppDirectories);
   *   - a Snap launcher /snap/bin/<name> (also behind snapd's `env BAMF_DESKTOP_FILE_HINT=…` Exec or found
   *     through PATH) matches any binary inside /snap/<name>/.
   */
  async matches(bindPath: string, fg: ForegroundApp, fgReal: string | null): Promise<boolean> {
    const fgPath = fg.exe ?? null;
    if (fgPath !== null && equalsIgnoreCase(bindPath, fgPath)) return true;
    const r = await this.#resolve(bindPath);
    for (const id of [fg.wmClass, fg.appId]) {
      if (id && (equalsIgnoreCase(id, r.desktopId) || equalsIgnoreCase(id, r.wmClass))) return true;
    }
    if (fgPath === null) return false;
    if (r.realExe !== null && (r.realExe === fgReal || r.realExe === fgPath)) return true;
    if (r.appDirs.some((d) => inside(fgReal, d) || inside(fgPath, d))) return true;
    if (r.snap !== null && (inside(fgPath, `/snap/${r.snap}`) || inside(fgReal, `/snap/${r.snap}`))) return true;
    return false;
  }

  clear(): void {
    this.#cache.clear();
  }
}

/** SystemOper.smethod_21: first theme (index order) with a binding that matches the foreground app. */
export async function findBoundTheme(
  themes: readonly (BindingTheme | null)[],
  fg: ForegroundApp | string,
  resolver: BindingResolver,
): Promise<BindingTheme | null> {
  const app: ForegroundApp = typeof fg === 'string' ? { exe: fg } : fg;
  if (!app.exe && !app.wmClass && !app.appId) return null;
  const fgReal = app.exe ? await realpathOrNull(app.exe) : null;
  for (const t of themes) {
    if (!t) continue;
    for (const b of t.BindAppInfos) {
      if (b?.BindAppFilePath && (await resolver.matches(b.BindAppFilePath, app, fgReal))) return t;
    }
  }
  return null;
}

/** The port's own identities (binary name, desktop-file ID, WM_CLASS). */
const SELF_NAMES = ['evnia-precision-center'];

/** CheckTopApp's hard-coded fallback theme (SO:3317). */
const FALLBACK_THEME = 'User';

export interface AppWatchDeps {
  log: Logger;
  intervalMs: number;
  getForegroundApp: () => ForegroundApp | null;
  /** ForegroundAppHost.releaseForegroundApp: the host may stop tracking (optional). */
  releaseForegroundApp?: () => void;
  themes: () => readonly (BindingTheme | null)[];
  currentThemeName: () => string | null;
  /** Send NotifyUISwitchTheme with Tag = theme name (SO:3326-3331). */
  notify: (themeName: string) => void;
  resolver: BindingResolver;
  /** Executables of this app (never switch on them; fixes vendor bug 13 §4.3). */
  selfExecutables: readonly string[];
}

/**
 * CheckTopApp, run every `intervalMs` once armed (the vendor loop starts with the first hub connection
 * and acts only after the first scan, EvniaHub.cs:45-48, SO:304-314). A tick does nothing while the
 * foreground app is unknown or unchanged (vendor: same window handle / same process name).
 *
 * Data minimisation (port): the vendor looked at every foreground change for the whole session. The
 * answer can only matter while some theme has a bound app, or while a theme other than "User" is current
 * (the next foreground change then switches back to "User", SO:3317-3323). Otherwise a tick asks the host
 * nothing and tells it to stop tracking (ForegroundAppHost.releaseForegroundApp); the next tick that needs
 * the foreground app starts it again. The notifications sent are the vendor's in every case.
 */
export class AppBindingWatcher {
  readonly #d: AppWatchDeps;
  #timer: NodeJS.Timeout | null = null;
  #lastKey: string | null = null;
  #busy = false;
  /** releaseForegroundApp was called and nothing has asked the host since. */
  #released = false;

  constructor(deps: AppWatchDeps) {
    this.#d = deps;
  }

  get armed(): boolean {
    return this.#timer !== null;
  }

  arm(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#d.intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #isSelf(fg: ForegroundApp): boolean {
    if (fg.exe && (this.#d.selfExecutables.includes(fg.exe) || SELF_NAMES.includes(basename(fg.exe)))) return true;
    return [fg.wmClass, fg.appId].some((id) => !!id && SELF_NAMES.some((n) => equalsIgnoreCase(n, id)));
  }

  /** Could a foreground change lead to a notification? (see the class comment) */
  #foregroundMatters(): boolean {
    const current = this.#d.currentThemeName();
    if (current !== null && current !== FALLBACK_THEME) return true;
    return this.#d.themes().some((t) => !!t && t.BindAppInfos.some((b) => !!b?.BindAppFilePath));
  }

  /** One CheckTopApp pass; returns the theme name notified, if any. */
  async tick(): Promise<string | null> {
    if (this.#busy) return null;
    this.#busy = true;
    try {
      if (!this.#foregroundMatters()) {
        // The last app is forgotten: once tracking resumes, the app then in front is evaluated afresh.
        this.#lastKey = null;
        if (!this.#released) {
          this.#released = true;
          this.#d.releaseForegroundApp?.();
        }
        return null;
      }
      this.#released = false;
      let fg: ForegroundApp | null;
      try {
        fg = this.#d.getForegroundApp();
      } catch (e) {
        this.#d.log.warn('getForegroundApp failed:', (e as Error).message);
        this.#lastKey = null;
        return null;
      }
      if (!fg || (!fg.exe && !fg.wmClass && !fg.appId)) return null;
      const key = [fg.exe ?? '', fg.wmClass ?? '', fg.appId ?? ''].join('\n');
      if (key === this.#lastKey) return null;
      this.#lastKey = key;
      if (this.#isSelf(fg)) return null;
      const bound = await findBoundTheme(this.#d.themes(), fg, this.#d.resolver);
      const text = bound?.Name ?? FALLBACK_THEME;
      if (this.#d.currentThemeName() !== text) {
        this.#d.log.debug(`CheckTopApp Theme_Switch("${text}")`);
        this.#d.notify(text);
        return text;
      }
      return null;
    } catch (e) {
      this.#d.log.error('CheckTopApp failed', e);
      this.#lastKey = null;
      return null;
    } finally {
      this.#busy = false;
    }
  }
}
