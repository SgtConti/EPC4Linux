// Build-time import of the vendor renderer: extract → verify pins → patch → drop unused sub-apps →
// rewrite CSP → static audit → copy vendor data/icons → replace build/vendor-* as a unit.
// Nothing is written to the final output directories unless every step succeeded. Every failure is
// an ImportError with a stable code; file-system errors are wrapped (ASAR_READ, COPY_IO, OUTPUT_IO).

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { AsarSource } from './asar-source.ts';
import { auditFiles, isAuditedFile, type AuditReport } from './audit.ts';
import { readCspPolicies, rewriteCsp, type CspAction } from './csp.ts';
import { errnoOf, messageOf, outputHint, withIo } from './io.ts';
import { acquireOutputLock, swapOutputs } from './output-swap.ts';
import {
  applyPatchTable,
  decodeUtf8Strict,
  ImportError,
  matchGlob,
  sha256,
  validatePatchTable,
  verifyPinnedFiles,
} from './patch-engine.ts';
import { removeFiles, type RemovedFile } from './removals.ts';
import type { AppliedPatch, CopySpec, TouchpointDecision, UiPatchTable } from './types.ts';

/** Renderer root inside app.asar (01 §1). */
export const RENDERER_PREFIX = 'out/renderer';
export const OUTPUT_DIRS = { ui: 'vendor-ui', data: 'vendor-data', assets: 'vendor-assets' } as const;
export const MANIFEST_NAME = 'PATCHES.json';

export interface ImportOptions {
  asarPath: string;
  /** The install's `resources/` directory (default: the directory containing the asar). */
  resourcesDir?: string;
  /** Parent of vendor-ui/, vendor-data/, vendor-assets/ (normally port/build). */
  outDir: string;
  table: UiPatchTable;
  log?: (line: string) => void;
  /** Problems that do not fail the import (e.g. a leftover directory that could not be removed). Default: `log`. */
  warn?: (line: string) => void;
}

export interface CopiedFile {
  dest: string;
  source: string;
  sha256: string;
}

export interface Manifest {
  generator: string;
  vendor: { product: string; version: string; asar: string; asarSha256: string };
  csp: string;
  pinnedFiles: Array<{ path: string; sha256: string; sha256After: string | null }>;
  patches: AppliedPatch[];
  cspRewrites: Array<{ file: string; action: CspAction }>;
  removed: RemovedFile[];
  copied: CopiedFile[];
  touchpoints: TouchpointDecision[];
  audit: {
    filesScanned: number;
    remoteUrls: Array<{ url: string; files: string[]; reason: string }>;
    reviewedSites: number;
    ipcChannels: Record<string, number>;
  };
}

export interface ImportResult {
  manifest: Manifest;
  audit: AuditReport;
  outputs: { ui: string; data: string; assets: string };
}

/** Raised when the static audit finds a reachable remote URL or an unreviewed call site. */
export class AuditFailedError extends ImportError {
  readonly report: AuditReport;
  constructor(report: AuditReport) {
    super('AUDIT_FAILED', `Static audit failed:\n  ${report.failures.join('\n  ')}`);
    this.name = 'AuditFailedError';
    this.report = report;
  }
}

/** Loads and validates the vendor patch table, scripts/ui-patches.mjs. */
export async function loadPatchTable(): Promise<UiPatchTable> {
  const moduleUrl = new URL('../ui-patches.mjs', import.meta.url).href;
  const mod = (await import(moduleUrl)) as { default?: unknown };
  const table = mod.default as UiPatchTable | undefined;
  if (!table || typeof table !== 'object') throw new ImportError('TABLE_INVALID', `${moduleUrl} has no default export`);
  validatePatchTable(table);
  return table;
}

export function defaultPaths(portDir: string, env: NodeJS.ProcessEnv = process.env): { asarPath: string; outDir: string } {
  return {
    asarPath: env.EVNIA_VENDOR_ASAR ? resolve(env.EVNIA_VENDOR_ASAR) : resolve(portDir, '..', 'Evnia Precision Center', 'resources', 'app.asar'),
    outDir: resolve(portDir, 'build'),
  };
}

function applyCsp(files: Map<string, Uint8Array>, table: UiPatchTable): Manifest['cspRewrites'] {
  const html = [...files.keys()].filter((p) => /\.html?$/i.test(p)).sort();
  const expected = table.pinnedFiles.filter((p) => table.cspFiles.includes(p.glob)).map((p) => p.path).sort();
  if (html.join('\n') !== expected.join('\n')) {
    throw new ImportError('CSP_FILESET', `HTML entry points ${html.join(', ')} differ from the reviewed set ${expected.join(', ')}`);
  }
  return html.map((path) => {
    const res = rewriteCsp(path, decodeUtf8Strict(path, files.get(path) ?? new Uint8Array()), table.csp);
    files.set(path, Buffer.from(res.html, 'utf8'));
    return { file: path, action: res.action };
  });
}

interface CollectedCopy {
  dest: string;
  source: string;
  data: Buffer;
}

/** Reads a vendor data file of the Windows installation (the `resources/` directory next to app.asar). */
function readInstallFile(path: string): Buffer {
  const hint = "(expected in the install's resources/ directory next to app.asar; see --resources)";
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch (err) {
    if (errnoOf(err) === 'ENOENT' || errnoOf(err) === 'ENOTDIR') throw new ImportError('COPY_MISSING', `Vendor data file not found: ${path} ${hint}`);
    throw new ImportError('COPY_IO', `Cannot read vendor data file ${path}: ${messageOf(err)}`);
  }
  if (!isFile) throw new ImportError('COPY_IO', `Vendor data file ${path} is not a regular file ${hint}`);
  return withIo('COPY_IO', `Cannot read vendor data file ${path}`, () => readFileSync(path));
}

/** Reads one vendor data file, from the asar or from the install's resources/ directory, and checks its pin. */
function readCopySource(src: AsarSource, resourcesDir: string, spec: CopySpec, rel: string): Buffer {
  const where = spec.from === 'asar' ? `app.asar:${rel}` : join(resourcesDir, ...rel.split('/'));
  const data = spec.from === 'asar' ? src.read(rel) : readInstallFile(where);
  if (spec.sha256 && sha256(data) !== spec.sha256) {
    throw new ImportError('COPY_HASH', `${where} has SHA-256 ${sha256(data)}, expected ${spec.sha256}; unsupported vendor version`);
  }
  return data;
}

function collectCopies(src: AsarSource, resourcesDir: string, specs: readonly CopySpec[]): CollectedCopy[] {
  const out: CollectedCopy[] = [];
  for (const spec of specs) {
    const dir = posix.dirname(spec.source) === '.' ? '' : posix.dirname(spec.source);
    // Globs (icon sets) are only supported inside the asar; validatePatchTable enforces that.
    const names = spec.source.includes('*')
      ? matchGlob(src.listFiles(dir).filter((p) => !p.includes('/')), posix.basename(spec.source))
      : [posix.basename(spec.source)];
    if (names.length === 0) throw new ImportError('COPY_MISSING', `No vendor file matches ${spec.from}:${spec.source}`);
    for (const name of names) {
      const rel = dir ? `${dir}/${name}` : name;
      out.push({ dest: `${spec.destDir}/${name}`, source: `${spec.from}:${rel}`, data: readCopySource(src, resourcesDir, spec, rel) });
    }
  }
  return out;
}

function writeTree(root: string, files: Iterable<[string, Uint8Array]>): void {
  for (const [rel, data] of files) {
    const target = join(root, ...rel.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

function summarizeUrls(report: AuditReport): Manifest['audit']['remoteUrls'] {
  const byUrl = new Map<string, { files: Set<string>; reason: string }>();
  for (const f of report.findings) {
    if (f.kind !== 'url') continue;
    const e = byUrl.get(f.match) ?? { files: new Set<string>(), reason: f.reason };
    e.files.add(f.file);
    byUrl.set(f.match, e);
  }
  return [...byUrl].sort(([a], [b]) => a.localeCompare(b)).map(([url, e]) => ({ url, files: [...e.files].sort(), reason: e.reason }));
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? log;
  const { table } = opts;
  validatePatchTable(table);
  const asarPath = resolve(opts.asarPath);
  const resourcesDir = resolve(opts.resourcesDir ?? dirname(asarPath));
  const outDir = resolve(opts.outDir);

  const src = new AsarSource(asarPath);
  log(`Reading ${asarPath}`);
  const files = new Map<string, Uint8Array>();
  for (const rel of src.listFiles(RENDERER_PREFIX)) files.set(rel, src.read(`${RENDERER_PREFIX}/${rel}`));
  log(`  ${files.size} renderer files`);

  verifyPinnedFiles(files, table.pinnedFiles, table.vendor.version);
  log(`  ${table.pinnedFiles.length} pinned files verified (SHA-256, ${table.vendor.product} ${table.vendor.version})`);

  const applied = applyPatchTable(files, table);
  log(`  ${applied.length} patches applied, each matched exactly its expected count`);

  const removed = removeFiles(files, table.removals);
  log(`  ${removed.length} files dropped (features removed from the port)`);

  const cspRewrites = applyCsp(files, table);
  log(`  CSP rewritten in ${cspRewrites.map((c) => `${c.file} (${c.action})`).join(', ')}`);

  const texts = new Map<string, string>();
  for (const [p, d] of files) if (isAuditedFile(p)) texts.set(p, Buffer.from(d).toString('utf8'));
  const audit = auditFiles(texts, table);
  // The policy itself must be what we wrote (defence against an HTML file that sneaks in a second CSP).
  for (const c of cspRewrites) {
    const policies = readCspPolicies(texts.get(c.file) ?? '');
    if (policies.length !== 1 || policies[0] !== table.csp) audit.failures.push(`${c.file}: CSP is not exactly the local-only policy`);
  }
  if (audit.failures.length) throw new AuditFailedError(audit);
  log(`  audit passed: ${audit.filesScanned} files scanned, ${audit.findings.length} findings, 0 failures`);

  const copies = collectCopies(src, resourcesDir, table.copies);

  const manifest: Manifest = {
    generator: 'scripts/import-vendor-ui.mjs',
    vendor: {
      ...table.vendor,
      asar: basename(asarPath),
      asarSha256: withIo('ASAR_READ', `Cannot read ${asarPath}`, () => sha256(readFileSync(asarPath))),
    },
    csp: table.csp,
    pinnedFiles: table.pinnedFiles.map((p) => {
      const after = files.get(p.path);
      return { path: p.path, sha256: p.sha256, sha256After: after ? sha256(after) : null };
    }),
    patches: applied,
    cspRewrites,
    removed,
    copied: copies.map((c) => ({ dest: c.dest, source: c.source, sha256: sha256(c.data) })),
    touchpoints: table.touchpoints,
    audit: {
      filesScanned: audit.filesScanned,
      remoteUrls: summarizeUrls(audit),
      reviewedSites: audit.findings.filter((f) => f.kind === 'api' && f.verdict === 'reviewed').length,
      ipcChannels: audit.ipcChannels,
    },
  };
  files.set(MANIFEST_NAME, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));

  // Stage everything under the output lock, then replace the three output directories as a unit
  // (output-swap.ts).
  const hint = outputHint(outDir);
  const lock = withIo(
    'OUTPUT_IO',
    `Cannot prepare the output directory ${outDir}`,
    () => {
      mkdirSync(outDir, { recursive: true });
      return acquireOutputLock(outDir);
    },
    hint,
  );
  for (const name of lock.removed) log(`  removed staging directory ${name} of an interrupted import`);
  for (const w of lock.warnings) warn(`warning: ${w}`);
  const fresh = join(lock.staging, 'new');
  let keepStaging = false;
  try {
    withIo(
      'OUTPUT_IO',
      `Cannot write the new outputs to ${lock.staging}`,
      () => {
        writeTree(join(fresh, OUTPUT_DIRS.ui), files);
        const byDir = (d: string) => copies.filter((c) => c.dest.split('/')[0] === d).map((c): [string, Uint8Array] => [c.dest.slice(d.length + 1), c.data]);
        writeTree(join(fresh, OUTPUT_DIRS.data), byDir(OUTPUT_DIRS.data));
        writeTree(join(fresh, OUTPUT_DIRS.assets), byDir(OUTPUT_DIRS.assets));
        for (const d of Object.values(OUTPUT_DIRS)) mkdirSync(join(fresh, d), { recursive: true });
      },
      hint,
    );
    withIo(
      'OUTPUT_IO',
      `Cannot install the new outputs in ${outDir}`,
      () => {
        lock.assertHeld();
        swapOutputs(outDir, lock.staging, Object.values(OUTPUT_DIRS));
      },
      hint,
    );
  } catch (err) {
    // After a failed rollback the staging directory holds the only copy of the previous outputs.
    keepStaging = err instanceof ImportError && err.code === 'OUTPUT_ROLLBACK';
    throw err;
  } finally {
    // A clean-up failure must neither mask the error above nor fail a completed import.
    for (const w of lock.release(keepStaging)) warn(`warning: ${w}`);
  }
  const outputs = { ui: join(outDir, OUTPUT_DIRS.ui), data: join(outDir, OUTPUT_DIRS.data), assets: join(outDir, OUTPUT_DIRS.assets) };
  log(`Wrote ${outputs.ui} (${files.size} files), ${outputs.data}, ${outputs.assets}`);
  return { manifest, audit, outputs };
}
