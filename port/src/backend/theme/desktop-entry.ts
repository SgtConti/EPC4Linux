// XDG desktop entries for app-bound themes on Linux (20-theme §10.2, 13 §4.4).
//
// The renderer stores whatever path the file picker returned as BindAppFilePath. On Linux that is
// either a `.desktop` file (an application binding; the main process opens the chooser in
// /usr/share/applications) or an executable. This module parses desktop entries (Desktop Entry
// Specification 1.5: [Desktop Entry] group, unlocalized keys, value escapes, Exec quoting and field
// codes) and resolves what they launch, without new dependencies.

import type { Dirent } from 'node:fs';
import { type FileHandle, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';

export interface DesktopEntry {
  /** Unlocalized keys of the [Desktop Entry] group (first occurrence wins). */
  readonly keys: ReadonlyMap<string, string>;
  readonly name: string | null;
  readonly icon: string | null;
  readonly exec: string | null;
  readonly tryExec: string | null;
  readonly startupWmClass: string | null;
}

/** Value escapes of the spec: \s \n \t \r \\ (other sequences are kept verbatim). */
function unescapeValue(v: string): string {
  return v.replace(/\\([sntr\\])/g, (_m, c: string) => ({ s: ' ', n: '\n', t: '\t', r: '\r', '\\': '\\' })[c] ?? c);
}

export function parseDesktopEntry(text: string): DesktopEntry {
  const keys = new Map<string, string>();
  let inMain = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key.includes('[')) continue; // localized variant, e.g. Name[de]
    if (!keys.has(key)) keys.set(key, unescapeValue(line.slice(eq + 1).trim()));
  }
  const get = (k: string): string | null => {
    const v = keys.get(k);
    return v === undefined || v === '' ? null : v;
  };
  return { keys, name: get('Name'), icon: get('Icon'), exec: get('Exec'), tryExec: get('TryExec'), startupWmClass: get('StartupWMClass') };
}

/**
 * Exec value → argv (spec "The Exec key"): double-quoted arguments with \" \` \$ \\ escapes, field
 * codes (%f %F %u %U %i %c %k and the deprecated ones) dropped, %% → %.
 */
export function splitExec(exec: string): string[] {
  const args: string[] = [];
  let cur = '';
  let has = false;
  let quoted = false;
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i];
    if (quoted) {
      if (c === '\\' && i + 1 < exec.length && '"`$\\'.includes(exec[i + 1])) {
        cur += exec[++i];
      } else if (c === '"') {
        quoted = false;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
      has = true;
    } else if (c === ' ' || c === '\t') {
      if (has) args.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) args.push(cur);
  return args
    .map((a) => a.replace(/%(.)/g, (_m, code: string) => (code === '%' ? '%' : '')))
    .filter((a, i) => a !== '' || i === 0);
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && (s.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

/** `command -v`: an absolute path as is, else the first executable match on PATH. */
export async function resolveCommand(cmd: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (cmd === '') return null;
  if (cmd.includes('/')) return isAbsolute(cmd) && (await isExecutableFile(cmd)) ? cmd : null;
  for (const dir of (env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (await isExecutableFile(p)) return p;
  }
  return null;
}

export async function realpathOrNull(p: string | null): Promise<string | null> {
  if (!p) return null;
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * The program an entry's Exec runs, as written (first token; `env [-opts] VAR=x … prog` wrappers are
 * skipped, as snapd writes them: `Exec=env BAMF_DESKTOP_FILE_HINT=… /snap/bin/firefox %u`); TryExec when
 * Exec is empty.
 */
export function desktopExecProgram(entry: DesktopEntry): string | null {
  const argv = entry.exec ? splitExec(entry.exec) : [];
  let i = 0;
  if (argv[i] === 'env' || argv[i] === '/usr/bin/env' || argv[i] === '/bin/env') {
    i++;
    while (i < argv.length && (argv[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]))) i++;
  }
  return argv[i] ?? entry.tryExec ?? null;
}

/** The PATH-resolved program of the entry (`command -v`), not yet through realpath. */
export async function desktopExecCommand(entry: DesktopEntry, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const prog = desktopExecProgram(entry);
  return prog ? resolveCommand(prog, env) : null;
}

/** What the entry launches, as a real path (desktopExecCommand through realpath). */
export async function desktopExecTarget(entry: DesktopEntry, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return realpathOrNull(await desktopExecCommand(entry, env));
}

/** Snap launcher path (/snap/bin/<name>[.<app>]) → <name>; the binaries run from /snap/<name>/<rev>/…. */
export function snapNameOfCommand(path: string | null): string | null {
  const m = /^\/snap\/bin\/([^/.]+)(?:\.[^/]+)?$/.exec(path ?? '');
  return m ? m[1] : null;
}

/**
 * The snap an entry launches, or null: its program is a /snap/bin launcher, either written as such
 * (also after an `env …` wrapper, the format snapd generates) or found through PATH (`Exec=firefox` with
 * /snap/bin/firefox first on PATH). Checked before realpath, which would only give /usr/bin/snap.
 */
export async function desktopSnapName(entry: DesktopEntry, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const prog = desktopExecProgram(entry);
  if (!prog) return null;
  return snapNameOfCommand(prog) ?? (prog.includes('/') ? null : snapNameOfCommand(await resolveCommand(prog, env)));
}

/**
 * Programs that run someone else's code (`python3 app.py`, `java -jar`, `sh -c …`, `flatpak run …`):
 * their binary is shared by every program they run, so an Exec pointing at one says nothing about the
 * foreground window (20-theme §10.2 item 5 matches on the realpath of Exec only for real launchers).
 */
const INTERPRETER = /^(?:python[\d.]*|pypy[\d.]*|perl[\d.]*|ruby[\d.]*|node(?:js)?|bun|deno|java|javaw|mono|dotnet|wine(?:64)?(?:-preloader)?|gjs|lua(?:jit)?[\d.]*|php[\d.]*|tclsh[\d.]*|wish[\d.]*|guile[\d.]*|sh|bash|dash|zsh|ksh|mksh|fish|csh|tcsh|env|flatpak|snap|electron\d*|xdg-open|gtk-launch|gio|kioclient\d*|exo-open)$/;

export function isInterpreter(path: string): boolean {
  return INTERPRETER.test(basename(path));
}

/** Does the file start with `#!` (a wrapper script such as /usr/bin/google-chrome)? */
export async function isScript(path: string): Promise<boolean> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(path, 'r');
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf[0] === 0x23 && buf[1] === 0x21;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Directories many unrelated programs live in; never used for the wrapper-script rule. */
function isSharedDirectory(dir: string, env: NodeJS.ProcessEnv): boolean {
  const home = env.HOME || homedir();
  const shared = new Set([
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/local/lib',
    '/usr/local/libexec',
    '/usr/local/share',
    '/usr/local/games',
    '/var/lib/flatpak',
    '/var/lib/snapd',
    join(home, 'bin'),
    join(home, '.local'),
    join(home, '.local', 'bin'),
    join(home, '.local', 'lib'),
    join(home, '.local', 'share'),
    join(home, 'Applications'),
    join(home, 'Downloads'),
    join(home, 'Desktop'),
  ]);
  if (dir === home || shared.has(dir)) return true;
  // Multi-arch library directories (/usr/lib/x86_64-linux-gnu, …).
  return /^\/usr\/lib(?:32|64|x32)?\/[a-z0-9_]+-linux-[a-z0-9_]+$/.test(dir);
}

/**
 * Wrapper scripts (Chrome's /opt/google/chrome/google-chrome, VS Code's /usr/share/code/bin/code) exec a
 * binary next to them, so the foreground executable is not the Exec target. For a script inside an
 * application's own directory, the directories whose binaries count as "this app": the script's
 * directory and, for `<app>/bin/<script>`, `<app>/`. Directories shared by many programs (/usr/bin,
 * ~/.local/bin, less than three levels deep, …) never qualify, so /usr/bin/firefox-style scripts stay
 * unmatched (documented limitation; the StartupWMClass rule covers them when the host reports WM_CLASS).
 */
export function scriptAppDirectories(scriptRealPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = dirname(scriptRealPath);
  const candidates = basename(dir) === 'bin' ? [dir, dirname(dir)] : [dir];
  return candidates.filter((d) => d.split('/').filter(Boolean).length >= 3 && !isSharedDirectory(d, env));
}

/** Desktop-file ID of a .desktop path (basename without the extension; subdirectory prefixes ignored). */
export function desktopIdOf(path: string): string {
  return basename(path).replace(/\.desktop$/, '');
}

export async function readDesktopEntry(path: string): Promise<DesktopEntry | null> {
  try {
    const s = await stat(path);
    if (!s.isFile() || s.size > 1024 * 1024) return null;
    return parseDesktopEntry(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** $XDG_DATA_HOME and $XDG_DATA_DIRS (XDG Base Directory Specification defaults). */
export function xdgDataDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || homedir();
  const dataHome = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  const dirs = (env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter((d) => d !== '' && isAbsolute(d));
  return [dataHome, ...dirs.filter((d) => d !== dataHome)];
}

/** Every *.desktop file below the applications/ directories (one level of sub-directories). */
export async function listDesktopFiles(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const out: string[] = [];
  for (const base of xdgDataDirs(env)) {
    const appsDir = join(base, 'applications');
    let names: Dirent[];
    try {
      names = await readdir(appsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      if (d.isFile() && d.name.endsWith('.desktop')) out.push(join(appsDir, d.name));
      else if (d.isDirectory()) {
        try {
          for (const sub of await readdir(join(appsDir, d.name), { withFileTypes: true })) {
            if (sub.isFile() && sub.name.endsWith('.desktop')) out.push(join(appsDir, d.name, sub.name));
          }
        } catch {
          // unreadable sub-directory
        }
      }
    }
  }
  return out;
}
