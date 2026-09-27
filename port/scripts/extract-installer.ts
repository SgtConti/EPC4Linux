// Reproducible extraction of the vendor's Windows installer, so the port can be built without Windows
// (CLI: scripts/extract-installer.mjs). The installer ("evnia Setup 1.13.0.exe") is an NSIS executable whose
// payload is one stored 7z archive, app.7z, holding the installed directory tree:
//
//   evnia Setup 1.13.0.exe ──7z -tnsis──▶ app.7z ──7z──▶ resources/app.asar, resources/bin/res/data/**  (default)
//                                                      └▶ the complete installation                     (--full)
//
// Nothing from the installer is executed; 7-Zip only reads it. Before anything is extracted, every entry name of
// app.7z is checked (no absolute or `..` paths, no symbolic links) and its size bounded. The result is verified
// against the pins of scripts/ui-patches.mjs (the renderer files and the vendor data files) and against the
// version in app.asar's package.json, in a staging directory next to the output, which then replaces the output
// directory in one rename. Every anticipated failure is an ImportError with a stable code.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AsarSource } from './lib/asar-source.ts';
import { RENDERER_PREFIX } from './lib/import-pipeline.ts';
import { errnoOf, messageOf, outputHint, withIo } from './lib/io.ts';
import { ImportError, sha256, verifyPinnedFiles } from './lib/patch-engine.ts';
import type { UiPatchTable } from './lib/types.ts';

/** The part of the patch table the extraction checks. */
export type ExtractTable = Pick<UiPatchTable, 'vendor' | 'pinnedFiles' | 'copies'>;

/** Known-good reference build, for information only: the pins decide, so a re-signed download still works. */
export interface ReferenceBuild {
  version: string;
  installer: { size: number; sha256: string };
  asarSha256: string;
}

/** The vendor download the 1.13.0 patch table was written against. */
export const REFERENCES: readonly ReferenceBuild[] = [
  {
    version: '1.13.0',
    installer: { size: 144_233_136, sha256: '3b8d3406e1d11b16b3054cacce5663b54f6b9b585e412d9bdb53dbc78389928f' },
    asarSha256: '3e1c9fe50622283a5b089933084678f3eb0163a208fa9de8562950f70ea49797',
  },
];

/** What the build reads (scripts/import-vendor-ui.mjs): the renderer archive and the backend data tables. */
export const BUILD_SELECTION = ['resources/app.asar', 'resources/bin/res/data'] as const;
/** Provenance record written into the output directory; makes a repeated run a verified no-op. */
export const MARKER_NAME = 'extract-installer.json';
export const GENERATOR = 'scripts/extract-installer.mjs';
/** The NSIS payload: app.7z (Evnia 1.13.0) or electron-builder's $PLUGINSDIR/app-64.7z. */
export const PAYLOAD_RE = /^(?:\$PLUGINSDIR\/)?app(?:-64)?\.7z$/i;
/** Upper bound for the payload and for the files one run extracts (the complete 1.13.0 installation is ~0.4 GB). */
export const MAX_EXTRACT_BYTES = 2 * 1024 ** 3;
const MAX_LISTING_BYTES = 64 * 1024 ** 2;
const MAX_STDERR_BYTES = 1024 ** 2;

export type ExtractMode = 'build' | 'full';

export interface Marker {
  generator: string;
  product: string;
  version: string;
  installer: { size: number; sha256: string };
  payload: string;
  mode: ExtractMode;
  /** The verified files (paths relative to the output directory) and their SHA-256. */
  files: Record<string, string>;
}

export interface ExtractOptions {
  installer: string;
  outDir: string;
  table: ExtractTable;
  /** 7-Zip executable (default: $EVNIA_7Z, else the first of 7zz, 7z, 7za on PATH that reads NSIS). */
  sevenZip?: string;
  /** Extract the complete installation instead of BUILD_SELECTION. */
  full?: boolean;
  /** Replace an existing output directory (only one that is empty or holds an Evnia installation). */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** Problems that do not fail the extraction. Default: `log`. */
  warn?: (line: string) => void;
  /** Reference builds to compare with (information only). Default: REFERENCES. */
  references?: readonly ReferenceBuild[];
}

export interface ExtractResult {
  status: 'extracted' | 'up-to-date';
  outDir: string;
  marker: Marker;
  /** Regular files written (0 when up to date). */
  fileCount: number;
}

// ── 7-Zip ───────────────────────────────────────────────────────────────────────────────────────────

export interface SevenZip {
  bin: string;
  /** First line of `7z i`, e.g. "7-Zip 25.01 (x64) : Copyright (c) 1999-2025 Igor Pavlov : 2025-08-03". */
  version: string;
}

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started (e.g. ENOENT). */
  spawnError?: string;
}

function run(bin: string, args: readonly string[], env: NodeJS.ProcessEnv | undefined, signal: AbortSignal | undefined): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env, signal, windowsHide: true });
    } catch (err) {
      settle(() => resolvePromise({ code: null, signal: null, stdout: '', stderr: '', spawnError: errnoOf(err) ?? messageOf(err) }));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let overflow = false;
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > MAX_LISTING_BYTES) {
        overflow = true;
        child.kill();
      } else out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (errLen < MAX_STDERR_BYTES) err.push(d);
      errLen += d.length;
    });
    let aborted: Error | undefined;
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (e.name === 'AbortError') {
        // The child was sent SIGTERM; reject once it has exited, so the caller's clean-up of the staging
        // directory cannot race a 7-Zip that is still writing into it.
        aborted = e;
        if (child.pid === undefined) settle(() => reject(e));
      } else {
        settle(() => resolvePromise({ code: null, signal: null, stdout: '', stderr: '', spawnError: e.code ?? e.message }));
      }
    });
    child.on('close', (code, sig) => {
      if (aborted) {
        const e = aborted;
        settle(() => reject(e));
        return;
      }
      if (overflow) {
        settle(() => reject(new ImportError('SEVENZIP_OUTPUT', `${bin} ${args[0]} printed more than ${MAX_LISTING_BYTES} bytes; refusing the archive`)));
        return;
      }
      settle(() =>
        resolvePromise({ code, signal: sig, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }),
      );
    });
  });
}

/** The last meaningful lines 7-Zip printed, for an error message. */
function sevenZipDiagnostics(r: RunResult): string {
  const lines = `${r.stderr}\n${r.stdout}`
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /error|cannot|can not|unsupported|is not|unexpected|warning|denied|no space/i.test(l));
  const uniq = [...new Set(lines)].slice(-4);
  const how = r.signal ? `killed by ${r.signal}` : `exit ${r.code}`;
  return uniq.length ? `${how}: ${uniq.join(' | ')}` : how;
}

/** Runs 7-Zip; exit 0 (ok) and 1 (warning, e.g. the signature after the NSIS data) count as success. */
async function sevenZip(sz: SevenZip, args: readonly string[], code: string, what: string, opts: Pick<ExtractOptions, 'env' | 'signal'>): Promise<RunResult> {
  const r = await run(sz.bin, args, opts.env, opts.signal);
  if (r.spawnError) throw new ImportError('SEVENZIP_MISSING', `Cannot run ${sz.bin}: ${r.spawnError}`);
  if (r.code !== 0 && r.code !== 1) throw new ImportError(code, `${what} (7-Zip ${sevenZipDiagnostics(r)})`);
  return r;
}

/** The candidate 7-Zip programs, in order. */
export function sevenZipCandidates(explicit: string | undefined, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  if (explicit) return [explicit];
  if (env.EVNIA_7Z) return [env.EVNIA_7Z];
  if (platform === 'win32') return ['7z', join(env.ProgramFiles ?? 'C:\\Program Files', '7-Zip', '7z.exe')];
  return ['7zz', '7z', '7za'];
}

/** Finds a 7-Zip that can read NSIS installers (7zr and some 7za builds cannot). */
export async function findSevenZip(explicit?: string, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<SevenZip> {
  const tried: string[] = [];
  for (const bin of sevenZipCandidates(explicit, env)) {
    const r = await run(bin, ['i'], env, signal);
    if (r.spawnError) {
      tried.push(`${bin}: ${r.spawnError === 'ENOENT' ? 'not found' : r.spawnError}`);
      continue;
    }
    if (!/\bNsis\b/.test(r.stdout)) {
      tried.push(`${bin}: no NSIS support`);
      continue;
    }
    const version = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /7-Zip/.test(l)) ?? '7-Zip';
    return { bin, version };
  }
  throw new ImportError(
    'SEVENZIP_MISSING',
    `No 7-Zip that reads NSIS installers was found (${tried.join('; ')}). Install 7-Zip (Debian/Ubuntu: ` +
      'apt install 7zip; Fedora: dnf install 7zip; Arch: pacman -S 7zip; it is in the evnia-port-dev image) ' +
      'or pass --7z <path> / set EVNIA_7Z.',
  );
}

// ── Listings ────────────────────────────────────────────────────────────────────────────────────────

export interface ArchiveEntry {
  /** As listed (7-Zip on Windows separates with `\`). */
  path: string;
  size: number | undefined;
  folder: boolean;
  /** A symbolic link (a Unix mode starting with `l` in the attributes). */
  link: boolean;
}

/** Parses the entries of `7z l -slt` (the blocks after the `----------` line). */
export function parseSltListing(text: string): ArchiveEntry[] {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf('----------');
  if (start < 0) return [];
  const entries: ArchiveEntry[] = [];
  let cur: Map<string, string> | undefined;
  const flush = (): void => {
    const path = cur?.get('Path');
    if (cur && path !== undefined) {
      const attributes = cur.get('Attributes') ?? '';
      const size = /^\d+$/.test(cur.get('Size') ?? '') ? Number(cur.get('Size')) : undefined;
      entries.push({
        path,
        size,
        folder: cur.get('Folder') === '+' || /^D/.test(attributes),
        link: /(?:^|\s)l[r-][w-][xsStT-]/.test(attributes),
      });
    }
    cur = undefined;
  };
  for (const line of lines.slice(start + 1)) {
    if (line === '') {
      flush();
      continue;
    }
    const m = /^([A-Za-z][A-Za-z ]*?) = ?(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Path' && cur?.has('Path')) flush();
    (cur ??= new Map()).set(m[1], m[2]);
  }
  flush();
  return entries;
}

/** Normalizes an entry name to `/` separators, or throws ARCHIVE_UNSAFE for one that could leave the target. */
export function checkEntryPath(raw: string): string {
  const p = raw.replaceAll('\\', '/');
  const unsafe =
    p === '' ||
    p.startsWith('/') ||
    /^[A-Za-z]:/.test(p) ||
    p.includes('\0') ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (unsafe) throw new ImportError('ARCHIVE_UNSAFE', `Refusing archive entry ${JSON.stringify(raw)}: absolute or relative-parent path`);
  return p;
}

/** The single app payload of the NSIS listing. */
export function findPayload(entries: readonly ArchiveEntry[]): ArchiveEntry {
  const found = entries.filter((e) => !e.folder && PAYLOAD_RE.test(e.path.replaceAll('\\', '/')));
  if (found.length === 0) {
    throw new ImportError(
      'NO_PAYLOAD',
      `The installer holds no app.7z / app-64.7z (entries: ${entries.slice(0, 8).map((e) => e.path).join(', ')}` +
        `${entries.length > 8 ? ', ...' : ''}); is this the Evnia Precision Center installer?`,
    );
  }
  if (found.length > 1) throw new ImportError('NO_PAYLOAD', `The installer holds several payloads (${found.map((e) => e.path).join(', ')})`);
  return found[0];
}

export interface VersionResource {
  productName?: string;
  productVersions: string[];
}

/** ProductName / ProductVersion from the PE version resource, as `7z l -slt <exe>` prints it. */
export function parseVersionResource(text: string): VersionResource {
  const productName = /^ProductName: (.+?)\s*$/m.exec(text)?.[1];
  const productVersions = [...text.matchAll(/^ProductVersion: (.+?)\s*$/gm)].map((m) => m[1]);
  return productName === undefined ? { productVersions } : { productName, productVersions };
}

/** "1.13.0.0" and "1.13.0" are the same version. */
export function sameVersion(a: string, b: string): boolean {
  const norm = (v: string): string[] => {
    const parts = v.trim().split('.').map((s) => (/^\d+$/.test(s) ? String(Number(s)) : s));
    while (parts.length > 1 && parts.at(-1) === '0') parts.pop();
    return parts;
  };
  return norm(a).join('.') === norm(b).join('.');
}

// ── Verification ────────────────────────────────────────────────────────────────────────────────────

export interface Verified {
  version: string;
  asarSha256: string;
  /** resources/app.asar and every pinned resources/ data file, relative to the checked directory. */
  files: Record<string, string>;
}

function unsupported(table: ExtractTable): string {
  return (
    `This port supports only ${table.vendor.product} ${table.vendor.version}, the version scripts/ui-patches.mjs is ` +
    'pinned to. Use that installer, or port the patch table to the new version first (docs/port/MAINTAINING.md).'
  );
}

/**
 * Checks an extracted installation `dir`: the version in app.asar's package.json, the pinned renderer files and
 * the pinned vendor data files (the same pins scripts/import-vendor-ui.mjs checks).
 */
export function verifyExtraction(dir: string, table: ExtractTable): Verified {
  const asarPath = join(dir, 'resources', 'app.asar');
  if (!existsSync(asarPath)) throw new ImportError('PAYLOAD_LAYOUT', `${asarPath} is missing`);
  const src = new AsarSource(asarPath);
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = JSON.parse(src.read('package.json').toString('utf8')) as typeof pkg;
  } catch (err) {
    throw new ImportError('VENDOR_VERSION', `app.asar has no readable package.json (${messageOf(err)}); not an ${table.vendor.product} build. ${unsupported(table)}`);
  }
  const version = typeof pkg.version === 'string' ? pkg.version : '(no version)';
  if (!sameVersion(version, table.vendor.version)) {
    throw new ImportError('VENDOR_VERSION', `The installer contains version ${version} (app.asar package.json). ${unsupported(table)}`);
  }
  const renderer = new Map<string, Uint8Array>();
  for (const rel of src.listFiles(RENDERER_PREFIX)) renderer.set(rel, src.read(`${RENDERER_PREFIX}/${rel}`));
  verifyPinnedFiles(renderer, table.pinnedFiles, table.vendor.version);

  const asarSha256 = withIo('EXTRACT_IO', `Cannot read ${asarPath}`, () => sha256(readFileSync(asarPath)));
  const files: Record<string, string> = { 'resources/app.asar': asarSha256 };
  for (const spec of table.copies) {
    if (!spec.sha256) continue; // globbed icon sets are copied unpinned
    const rel = spec.from === 'asar' ? `app.asar:${spec.source}` : `resources/${spec.source}`;
    let data: Buffer;
    if (spec.from === 'asar') {
      data = src.read(spec.source);
    } else {
      const path = join(dir, ...rel.split('/'));
      if (!existsSync(path)) throw new ImportError('COPY_MISSING', `Vendor data file ${rel} is missing from the installer`);
      data = withIo('EXTRACT_IO', `Cannot read ${path}`, () => readFileSync(path));
    }
    const actual = sha256(data);
    if (actual !== spec.sha256) {
      throw new ImportError('COPY_HASH', `${rel} has SHA-256 ${actual}, expected ${spec.sha256}. ${unsupported(table)}`);
    }
    if (spec.from === 'resources') files[rel] = actual;
  }
  return { version, asarSha256, files };
}

// ── Output directory ────────────────────────────────────────────────────────────────────────────────

type OutState = 'absent' | 'empty' | 'installation' | 'other' | 'not-a-directory';

function outState(outDir: string): OutState {
  let st;
  try {
    st = lstatSync(outDir);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return 'absent';
    throw new ImportError('OUTPUT_IO', `Cannot inspect ${outDir}: ${messageOf(err)}`);
  }
  if (!st.isDirectory()) return 'not-a-directory';
  const names = withIo('OUTPUT_IO', `Cannot read ${outDir}`, () => readdirSync(outDir));
  if (names.length === 0) return 'empty';
  if (existsSync(join(outDir, MARKER_NAME)) || existsSync(join(outDir, 'resources', 'app.asar'))) return 'installation';
  return 'other';
}

function readMarker(outDir: string): Marker | undefined {
  try {
    const m = JSON.parse(readFileSync(join(outDir, MARKER_NAME), 'utf8')) as Marker;
    return m && typeof m === 'object' && m.generator === GENERATOR && typeof m.installer?.sha256 === 'string' ? m : undefined;
  } catch {
    return undefined;
  }
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  return ka.join('\n') === Object.keys(b).sort().join('\n') && ka.every((k) => a[k] === b[k]);
}

/** Regular files below `root`; throws ARCHIVE_UNSAFE for anything that is neither a file nor a directory. */
function countPlainFiles(root: string): number {
  let count = 0;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) count++;
      else throw new ImportError('ARCHIVE_UNSAFE', `Extracted entry ${relative(root, p)} is not a regular file or directory; refusing the installer`);
    }
  };
  walk(root);
  return count;
}

/** `child` is `parent` or below it (both absolute). */
function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

// ── Extraction ──────────────────────────────────────────────────────────────────────────────────────

async function hashFile(path: string, signal: AbortSignal | undefined): Promise<{ size: number; sha256: string }> {
  const h = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of createReadStream(path, { signal })) {
      h.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ImportError('INSTALLER_READ', `Cannot read ${path}: ${messageOf(err)}`);
  }
  return { size, sha256: h.digest('hex') };
}

export async function runExtract(opts: ExtractOptions): Promise<ExtractResult> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? log;
  const { table, signal } = opts;
  const env = opts.env ?? process.env;
  const runOpts = { env, signal };
  const installer = resolve(opts.installer);
  const outDir = resolve(opts.outDir);
  const mode: ExtractMode = opts.full ? 'full' : 'build';
  const product = `${table.vendor.product} ${table.vendor.version}`;

  // 1. The installer and 7-Zip.
  let st;
  try {
    st = statSync(installer);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT' || errnoOf(err) === 'ENOTDIR') {
      throw new ImportError('INSTALLER_MISSING', `Installer not found: ${installer}. Pass --installer <path to "evnia Setup ${table.vendor.version}.exe"> or set EVNIA_VENDOR_INSTALLER.`);
    }
    throw new ImportError('INSTALLER_READ', `Cannot read ${installer}: ${messageOf(err)}`);
  }
  if (!st.isFile()) throw new ImportError('INSTALLER_MISSING', `${installer} is not a file; pass the installer .exe itself`);
  if (isInside(installer, outDir)) {
    throw new ImportError('OUT_REFUSED', `The installer ${installer} is inside the output directory ${outDir}; choose another --out`);
  }
  const sz = await findSevenZip(opts.sevenZip, env, signal);
  log(`Using ${sz.bin} (${sz.version})`);

  log(`Reading ${installer}`);
  const inst = await hashFile(installer, signal);
  log(`  ${inst.size} bytes, SHA-256 ${inst.sha256}`);
  const ref = (opts.references ?? REFERENCES).find((r) => sameVersion(r.version, table.vendor.version));
  if (ref && ref.installer.sha256 === inst.sha256) log(`  identical to the reference ${product} installer`);
  else if (ref) warn(`warning: not the reference ${product} installer (SHA-256 ${ref.installer.sha256}); continuing, the extracted files are checked against the pins`);

  // 2. Product and version from the PE version resource (best effort: an early, clear refusal).
  const probe = await run(sz.bin, ['l', '-slt', installer], env, signal);
  if (probe.spawnError) throw new ImportError('SEVENZIP_MISSING', `Cannot run ${sz.bin}: ${probe.spawnError}`);
  const vr = parseVersionResource(probe.stdout);
  if (vr.productName !== undefined && vr.productName !== table.vendor.product) {
    throw new ImportError('NOT_EVNIA', `${basename(installer)} is "${vr.productName}", not the ${table.vendor.product} installer`);
  }
  if (vr.productVersions.length && !vr.productVersions.some((v) => sameVersion(v, table.vendor.version))) {
    throw new ImportError('INSTALLER_VERSION', `${basename(installer)} is version ${vr.productVersions.at(-1)} (its version resource). ${unsupported(table)}`);
  }
  if (vr.productVersions.length) log(`  version resource: ${vr.productName ?? '?'} ${vr.productVersions.at(-1)}`);

  // 3. The NSIS payload.
  const nsis = await sevenZip(sz, ['l', '-slt', '-tnsis', installer], 'NOT_NSIS', `${installer} is not an NSIS installer 7-Zip can read`, runOpts);
  const nsisEntries = parseSltListing(nsis.stdout);
  if (nsisEntries.length === 0) throw new ImportError('NOT_NSIS', `${installer} is not an NSIS installer 7-Zip can read (no entries)`);
  const payload = findPayload(nsisEntries);
  const payloadPath = checkEntryPath(payload.path);
  if (payload.size !== undefined && payload.size > MAX_EXTRACT_BYTES) {
    throw new ImportError('ARCHIVE_TOO_LARGE', `${payloadPath} is ${payload.size} bytes (limit ${MAX_EXTRACT_BYTES})`);
  }
  log(`  NSIS payload ${payloadPath}${payload.size !== undefined ? ` (${payload.size} bytes)` : ''}`);

  // 4. The output directory: an earlier run from the same installer is a verified no-op.
  const state = outState(outDir);
  if (state === 'installation' && !opts.force) {
    const marker = readMarker(outDir);
    if (marker && marker.installer.sha256 === inst.sha256 && (marker.mode === mode || marker.mode === 'full') && sameVersion(marker.version, table.vendor.version)) {
      let verified: Verified | undefined;
      try {
        verified = verifyExtraction(outDir, table);
      } catch (err) {
        if (!(err instanceof ImportError)) throw err;
      }
      if (verified && sameFiles(verified.files, marker.files)) {
        log(`${outDir} already holds this installer's files (verified); nothing to do`);
        return { status: 'up-to-date', outDir, marker, fileCount: 0 };
      }
      throw new ImportError('OUT_MODIFIED', `${outDir} was extracted from this installer but no longer matches it. Pass --force to extract it again.`);
    }
  }
  if ((state === 'installation' || state === 'other' || state === 'not-a-directory') && !opts.force) {
    throw new ImportError('OUT_EXISTS', `${outDir} already exists. Pass --force to replace it, or choose another --out.`);
  }
  if (state === 'other' || state === 'not-a-directory') {
    throw new ImportError(
      'OUT_REFUSED',
      `Refusing to replace ${outDir}: it is ${state === 'other' ? 'not empty and holds no Evnia installation (no resources/app.asar)' : 'not a directory (or a symbolic link)'}. ` +
        'Choose another --out.',
    );
  }

  // 5. Extract into a staging directory next to the output (same file system: the final step is a rename).
  const parent = dirname(outDir);
  const hint = outputHint(parent);
  withIo('OUTPUT_IO', `Cannot create ${parent}`, () => mkdirSync(parent, { recursive: true }), hint);
  const stagingPrefix = `.${basename(outDir)}.extract-`;
  const leftovers = withIo('OUTPUT_IO', `Cannot read ${parent}`, () => readdirSync(parent)).filter((n) => n.startsWith(stagingPrefix));
  const staging = withIo('OUTPUT_IO', `Cannot create a staging directory in ${parent}`, () => mkdtempSync(join(parent, stagingPrefix)), hint);
  for (const n of leftovers) warn(`warning: ${join(parent, n)} is left over from an interrupted run; delete it`);
  const payloadDir = join(staging, 'payload');
  const tree = join(staging, 'tree');
  let keepStaging = false;
  try {
    await sevenZip(sz, ['x', '-tnsis', '-y', '-bsp0', '-bso0', `-o${payloadDir}`, installer, payload.path], 'EXTRACT_FAILED', `Cannot extract ${payloadPath} from ${installer}`, runOpts);
    const payloadFile = join(payloadDir, ...payloadPath.split('/'));
    if (!existsSync(payloadFile) || !statSync(payloadFile).isFile()) {
      throw new ImportError('EXTRACT_FAILED', `7-Zip did not produce ${payloadPath} from ${installer}`);
    }

    const listing = await sevenZip(sz, ['l', '-slt', payloadFile], 'PAYLOAD_INVALID', `${payloadPath} is not an archive 7-Zip can read`, runOpts);
    const entries = parseSltListing(listing.stdout).map((e) => ({ ...e, path: checkEntryPath(e.path) }));
    const link = entries.find((e) => e.link);
    if (link) throw new ImportError('ARCHIVE_UNSAFE', `Refusing ${payloadPath}: ${link.path} is a symbolic link`);
    const files = new Set(entries.filter((e) => !e.folder).map((e) => e.path));
    const required = ['resources/app.asar', ...table.copies.filter((c) => c.from === 'resources').map((c) => `resources/${c.source}`)];
    const missing = required.filter((p) => !files.has(p));
    if (missing.length) {
      throw new ImportError('PAYLOAD_LAYOUT', `${payloadPath} has no ${missing.join(', ')}; is this the ${table.vendor.product} installer?`);
    }
    const selected = mode === 'full' ? entries : entries.filter((e) => BUILD_SELECTION.some((s) => e.path === s || e.path.startsWith(`${s}/`)));
    const bytes = selected.reduce((n, e) => n + (e.size ?? 0), 0);
    if (bytes > MAX_EXTRACT_BYTES) throw new ImportError('ARCHIVE_TOO_LARGE', `${payloadPath} would extract ${bytes} bytes (limit ${MAX_EXTRACT_BYTES})`);

    log(`Extracting ${mode === 'full' ? 'the complete installation' : BUILD_SELECTION.join(', ')} (${bytes} bytes)`);
    await sevenZip(
      sz,
      ['x', '-y', '-bsp0', '-bso0', `-o${tree}`, payloadFile, ...(mode === 'full' ? [] : BUILD_SELECTION)],
      'EXTRACT_FAILED',
      `Cannot extract ${payloadPath}`,
      runOpts,
    );
    rmSync(payloadDir, { recursive: true, force: true });
    if (!existsSync(tree)) throw new ImportError('EXTRACT_FAILED', `7-Zip extracted nothing from ${payloadPath}`);
    const fileCount = withIo('EXTRACT_IO', `Cannot read the extracted files in ${tree}`, () => countPlainFiles(tree));
    log(`  ${fileCount} files`);

    // 6. Verify before anything replaces the output.
    const verified = verifyExtraction(tree, table);
    log(`  ${product}: app.asar package.json version, ${table.pinnedFiles.length} pinned renderer files and ` +
      `${table.copies.filter((c) => c.sha256).length} pinned data files verified (SHA-256)`);
    if (ref && ref.asarSha256 === verified.asarSha256) log(`  app.asar is identical to the reference ${product} build`);
    else if (ref) warn(`warning: app.asar (SHA-256 ${verified.asarSha256}) differs from the reference ${product} build; the pinned files match`);

    const marker: Marker = {
      generator: GENERATOR,
      product: table.vendor.product,
      version: table.vendor.version,
      installer: inst,
      payload: payloadPath,
      mode,
      files: verified.files,
    };
    withIo('OUTPUT_IO', `Cannot write ${join(tree, MARKER_NAME)}`, () => writeFileSync(join(tree, MARKER_NAME), `${JSON.stringify(marker, null, 2)}\n`), hint);

    // 7. Install: one rename; an existing directory is moved aside first and restored if that fails.
    const previous = join(staging, 'previous');
    withIo(
      'OUTPUT_IO',
      `Cannot install ${outDir}`,
      () => {
        if (state === 'empty') rmdirSync(outDir);
        if (state === 'installation') renameSync(outDir, previous);
        try {
          renameSync(tree, outDir);
        } catch (err) {
          if (state === 'installation') {
            try {
              renameSync(previous, outDir);
            } catch (rollback) {
              keepStaging = true;
              throw new ImportError(
                'OUTPUT_ROLLBACK',
                `Cannot install ${outDir} (${messageOf(err)}) nor restore the previous directory (${messageOf(rollback)}); it is kept in ${previous}`,
              );
            }
          }
          throw err;
        }
      },
      hint,
    );
    log(`Wrote ${outDir}`);
    return { status: 'extracted', outDir, marker, fileCount };
  } finally {
    if (!keepStaging) {
      try {
        rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
      } catch (err) {
        warn(`warning: cannot remove the staging directory ${staging}: ${messageOf(err)}`);
      }
    }
  }
}
