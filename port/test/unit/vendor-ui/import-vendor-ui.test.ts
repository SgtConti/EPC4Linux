// Runs the real import (npm run import-ui) against the user's vendor app.asar into a temp directory
// and checks the result end to end. The first two suites are skipped when the vendor installation is
// not available; the last one uses synthetic archives.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';
import { transform } from 'esbuild';
import { AsarSource } from '../../../scripts/lib/asar-source.ts';
import { auditFiles, isAuditedFile } from '../../../scripts/lib/audit.ts';
import { readCspPolicies } from '../../../scripts/lib/csp.ts';
import {
  AuditFailedError,
  defaultPaths,
  loadPatchTable,
  OUTPUT_DIRS,
  RENDERER_PREFIX,
  runImport,
  type ImportOptions,
  type Manifest,
} from '../../../scripts/lib/import-pipeline.ts';
import { LOCK_NAME } from '../../../scripts/lib/output-swap.ts';
import { applyPatchTable, ImportError, sha256, verifyPinnedFiles } from '../../../scripts/lib/patch-engine.ts';
import type { UiPatchTable } from '../../../scripts/lib/types.ts';

const portDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(portDir, 'scripts', 'import-vendor-ui.mjs');
const { asarPath } = defaultPaths(portDir);
const skip = existsSync(asarPath) ? false : `vendor archive not found at ${asarPath} (set EVNIA_VENDOR_ASAR)`;

function runCli(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: opts.cwd ?? portDir, env: opts.env ?? process.env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A failure the CLI anticipated: exit 1 and one coded line, never a Node stack trace. */
function assertCodedFailure(r: { status: number | null; stderr: string }, code: string, re: RegExp = /./): void {
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`^import-vendor-ui: ${code}: `, 'm'));
  assert.match(r.stderr, re);
  assert.doesNotMatch(r.stderr, /^\s+at /m, 'no stack trace');
}

/** All files below `root`, as sorted `/`-separated paths relative to `root`. */
function walk(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(root, p));
    else out.push(relative(root, p).split('\\').join('/'));
  }
  return out.sort();
}

describe('import-vendor-ui against the real 1.13.0 app.asar', { skip }, () => {
  let work: string;
  let out: string;
  let ui: string;
  let table: UiPatchTable;
  let manifest: Manifest;
  let run: { status: number | null; stdout: string; stderr: string };

  before(async () => {
    table = await loadPatchTable();
    work = mkdtempSync(join(tmpdir(), 'evnia-import-'));
    out = join(work, 'build');
    ui = join(out, 'vendor-ui');
    run = runCli(['--asar', asarPath, '--out', out]);
    if (run.status === 0) manifest = JSON.parse(readFileSync(join(ui, 'PATCHES.json'), 'utf8')) as Manifest;
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  test('the CLI succeeds, prints the audit table and leaves no staging directory behind', () => {
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /VERDICT +KIND +FILE/);
    assert.match(run.stdout, /loopback +url +assets\/styles-DAnQi2A8\.js/);
    assert.match(run.stdout, /reviewed +api +assets\/styles-DAnQi2A8\.js +1 +EventSource/);
    assert.match(run.stdout, /reviewed +url +assets\/ButtonFunc-DdsMNio-\.js +1 +http:\/\/ +Input placeholder/);
    assert.match(run.stdout, /reviewed +url +assets\/styles-DAnQi2A8\.js +1 +https:\/\/ +SignalR HttpConnection\._resolveUrl/);
    assert.doesNotMatch(run.stdout, /^FAIL/m);
    assert.equal(run.stderr, '', 'no warnings');
    assert.deepEqual(readdirSync(out).sort(), ['vendor-assets', 'vendor-data', 'vendor-ui'], 'no lock or staging directory left');
  });

  test('the manifest records the audit: remaining URLs and scheme literals with reasons', () => {
    assert.equal(manifest.audit.reviewedSites, table.reviewedSites.reduce((n, s) => n + s.count, 0));
    const schemesSeen = manifest.audit.remoteUrls.filter((u) => /^[a-z]+:\/\/$/.test(u.url));
    assert.deepEqual(schemesSeen.map((u) => [u.url, u.files]), [
      ['http://', ['assets/ButtonFunc-DdsMNio-.js', 'assets/styles-DAnQi2A8.js']],
      ['https://', ['assets/styles-DAnQi2A8.js']],
    ]);
  });

  test('every patch of the table was applied exactly its expected number of times', () => {
    assert.deepEqual(manifest.patches.map((p) => p.id), table.patches.map((p) => p.id));
    for (const p of table.patches) {
      const applied = manifest.patches.find((a) => a.id === p.id);
      assert.equal(applied?.count, p.expectCount ?? 1, p.id);
    }
  });

  test('pinned hashes match the vendor archive and are recorded before/after', () => {
    const src = new AsarSource(asarPath);
    const files = new Map(table.pinnedFiles.map((p) => [p.path, src.read(`${RENDERER_PREFIX}/${p.path}`)]));
    verifyPinnedFiles(files, table.pinnedFiles, table.vendor.version);
    for (const p of table.pinnedFiles) {
      const rec = manifest.pinnedFiles.find((r) => r.path === p.path);
      assert.equal(rec?.sha256, p.sha256);
      assert.equal(rec?.sha256After, sha256(readFileSync(join(ui, p.path))), `${p.path} on disk matches the manifest`);
      assert.notEqual(rec?.sha256After, p.sha256, `${p.path} was modified`);
    }
  });

  test('every HTML page carries exactly the local-only CSP', () => {
    const html = walk(ui).filter((p) => p.endsWith('.html'));
    assert.deepEqual(html, ['index.html', 'notice/notice.html']);
    for (const p of html) assert.deepEqual(readCspPolicies(readFileSync(join(ui, p), 'utf8')), [table.csp], p);
    assert.deepEqual(manifest.cspRewrites, [{ file: 'index.html', action: 'replaced' }, { file: 'notice/notice.html', action: 'inserted' }]);
  });

  test('an independent re-scan of the output passes the audit and finds no cloud host', () => {
    const texts = new Map(walk(ui).filter(isAuditedFile).map((p) => [p, readFileSync(join(ui, p), 'utf8')]));
    const report = auditFiles(texts, table);
    assert.deepEqual(report.failures, []);
    for (const [p, t] of texts) {
      assert.doesNotMatch(t, /zeasn|jsdelivr|amazonaws|evnia\.philips|localhost/i, p);
    }
    const styles = texts.get('assets/styles-DAnQi2A8.js') ?? '';
    assert.ok(styles.includes('`http://127.0.0.1:${e}/EvniaHub?k=${encodeURIComponent(window.__EVNIA__?.hubToken??"")}`'));
    assert.ok(!/AccessKey:"[^"]+"/.test(styles), 'saas HMAC credentials are blanked');
  });

  test('patched and kept chunks are still valid ES modules', async () => {
    for (const p of walk(ui).filter((x) => x.endsWith('.js'))) {
      await transform(readFileSync(join(ui, p), 'utf8'), { loader: 'js', format: 'esm', target: 'esnext' });
    }
  });

  test('removed sub-apps are gone and kept assets stay in the renderer layout', () => {
    const files = new Set(walk(ui));
    for (const r of table.removals) assert.ok(!files.has(r.path), r.path);
    assert.deepEqual(manifest.removed.map((r) => [r.path, r.mapDepsEntries]), table.removals.map((r) => [r.path, r.mapDepsEntries]));
    assert.ok(!existsSync(join(ui, 'feedback')));
    for (const p of ['monitor/34M2C8600.png', 'monitor/34M2C8600_rear.png', 'monitor/34M2C8600_source.png', 'assets/main-CDosWiM3.js', 'notice/notice.html']) {
      assert.ok(files.has(p), p);
    }
  });

  test('vendor data files and icons are copied with their pinned hashes', () => {
    const data = join(out, 'vendor-data');
    assert.deepEqual(walk(data), ['ENE/PCenter_AmbiglowInfo.json', 'MonitorInfo.json', 'PCenter_DeviceInfo.json']);
    for (const c of table.copies.filter((x) => x.sha256)) {
      const name = c.source.split('/').at(-1) ?? '';
      assert.equal(sha256(readFileSync(join(out, c.destDir, name))), c.sha256, c.source);
    }
    const monitorInfo = JSON.parse(readFileSync(join(data, 'MonitorInfo.json'), 'utf8')) as { Version: number; Monitors: Array<{ Name: string }> };
    assert.equal(monitorInfo.Version, 34);
    assert.ok(monitorInfo.Monitors.some((m) => m.Name === '34M2C8600'));
    const icons = walk(join(out, 'vendor-assets'));
    for (const i of ['favicon.png', 'favicon_16x16.png', 'tray_close.png', 'tray_rescan.png', 'tray_setting.png']) assert.ok(icons.includes(i), i);
  });

  test('a duplicated anchor in the real bundle makes the patch engine fail loudly', () => {
    const src = new AsarSource(asarPath);
    const main = table.pinnedFiles.find((p) => p.glob === 'assets/main-*.js');
    assert.ok(main);
    const text = src.read(`${RENDERER_PREFIX}/${main.path}`).toString('utf8');
    const p5 = table.patches.find((p) => p.id === 'P5');
    assert.ok(p5 && typeof p5.find === 'string');
    const files = new Map<string, Uint8Array>([[main.path, Buffer.from(`${text};${p5.find}`)]]);
    assert.throws(
      () => applyPatchTable(files, { pinnedFiles: table.pinnedFiles, patches: [p5] }),
      (e: unknown) => e instanceof ImportError && e.code === 'PATCH_COUNT' && /P5 .*matched 2 time\(s\)/.test(e.message),
    );
  });
});

// Each guard of the pipeline, triggered on the real archive through a modified table (or install
// layout): the import must abort with the right code and leave the previous output untouched.
describe('import-vendor-ui guards against the real 1.13.0 app.asar', { skip }, () => {
  let work: string;
  let table: UiPatchTable;

  before(async () => {
    table = await loadPatchTable();
    work = mkdtempSync(join(tmpdir(), 'evnia-import-guard-'));
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  /** Runs the import into a directory holding a previous output and checks that it survives the failure. */
  async function expectFailure(name: string, opts: Partial<ImportOptions>, code: string, re: RegExp): Promise<ImportError> {
    const outDir = join(work, name);
    for (const d of Object.values(OUTPUT_DIRS)) {
      mkdirSync(join(outDir, d), { recursive: true });
      writeFileSync(join(outDir, d, 'previous.txt'), `previous ${d}`);
    }
    let caught: unknown;
    try {
      await runImport({ asarPath, outDir, table, ...opts });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof ImportError, `expected ImportError ${code}, got ${String(caught)}`);
    assert.equal(caught.code, code, caught.message);
    assert.match(caught.message, re);
    assert.deepEqual(readdirSync(outDir).sort(), ['vendor-assets', 'vendor-data', 'vendor-ui'], 'no staging directory left');
    for (const d of Object.values(OUTPUT_DIRS)) {
      assert.deepEqual(walk(join(outDir, d)), ['previous.txt'], d);
      assert.equal(readFileSync(join(outDir, d, 'previous.txt'), 'utf8'), `previous ${d}`);
    }
    return caught;
  }

  test('REMOVAL_REFERENCED: dropping the patch that unlinks a removed chunk', async () => {
    const without = 'ROUTE-SMARTDESKTOP';
    const t: UiPatchTable = {
      ...table,
      patches: table.patches.filter((p) => p.id !== without),
      touchpoints: table.touchpoints.map((tp) => ({ ...tp, patches: tp.patches.filter((id) => id !== without) })),
    };
    await expectFailure('removal', { table: t }, 'REMOVAL_REFERENCED', /assets\/SmartDesktop-By8ZEPkl\.js is still (?:preloaded|referenced)/);
  });

  test('REMOVAL_MAPDEPS: the reviewed number of inert preload-table entries is exact', async () => {
    const t: UiPatchTable = {
      ...table,
      removals: table.removals.map((r) => (r.path === 'assets/Bulb-vdvqR6Jj.js' ? { ...r, mapDepsEntries: 0 } : r)),
    };
    await expectFailure('mapdeps', { table: t }, 'REMOVAL_MAPDEPS', /assets\/Bulb-vdvqR6Jj\.js is named by 1 inert/);
  });

  test('CSP_FILESET: an HTML entry point outside the reviewed set', async () => {
    const t: UiPatchTable = { ...table, removals: table.removals.filter((r) => !r.path.includes('feedback')) };
    await expectFailure('csp', { table: t }, 'CSP_FILESET', /feedback\/feedback\.html/);
  });

  test('AUDIT_FAILED: a URL that is no longer allowlisted', async () => {
    const t: UiPatchTable = { ...table, urlAllowlist: table.urlAllowlist.filter((a) => a.url !== 'http://www.w3.org/2000/svg') };
    const err = await expectFailure('audit', { table: t }, 'AUDIT_FAILED', /remote URL not allowlisted: http:\/\/www\.w3\.org\/2000\/svg/);
    assert.ok(err instanceof AuditFailedError);
    assert.ok(err.report.findings.some((f) => f.verdict === 'FAIL' && f.match === 'http://www.w3.org/2000/svg'));
  });

  test('COPY_HASH: a vendor data file with another hash', async () => {
    const t: UiPatchTable = { ...table, copies: table.copies.map((c, i) => (i === 0 ? { ...c, sha256: '0'.repeat(64) } : c)) };
    await expectFailure('copy-hash', { table: t }, 'COPY_HASH', /app\.asar:MonitorInfo\.json has SHA-256 [0-9a-f]{64}, expected 0{64}/);
  });

  test('COPY_MISSING: an install without resources/bin/res/data', async () => {
    const empty = join(work, 'empty-resources');
    mkdirSync(empty, { recursive: true });
    await expectFailure('copy-missing', { resourcesDir: empty }, 'COPY_MISSING', /PCenter_DeviceInfo\.json .*see --resources/);
  });

  test('COPY_IO: a directory where a vendor data file is expected', async () => {
    const odd = join(work, 'odd-resources');
    mkdirSync(join(odd, 'bin', 'res', 'data', 'PCenter_DeviceInfo.json'), { recursive: true });
    await expectFailure('copy-dir', { resourcesDir: odd }, 'COPY_IO', /PCenter_DeviceInfo\.json is not a regular file .*see --resources/);
  });

  test('OUTPUT_LOCKED: another import holds the output directory; nothing of it is touched', async () => {
    const outDir = join(work, 'locked');
    const other = join(outDir, '.vendor-import-1');
    mkdirSync(join(other, 'new', 'vendor-ui'), { recursive: true });
    const lock = `${JSON.stringify({ host: 'another-container', pid: 1, started: new Date().toISOString(), token: 'f'.repeat(32) })}\n`;
    writeFileSync(join(outDir, LOCK_NAME), lock);
    await assert.rejects(runImport({ asarPath, outDir, table }), (e: unknown) => {
      return e instanceof ImportError && e.code === 'OUTPUT_LOCKED' && /pid 1 on host another-container/.test(e.message);
    });
    assert.deepEqual(readdirSync(outDir).sort(), ['.vendor-import-1', LOCK_NAME]);
    assert.equal(readFileSync(join(outDir, LOCK_NAME), 'utf8'), lock);
    assert.ok(existsSync(join(other, 'new', 'vendor-ui')));
  });

  test('OUTPUT_IO: an unwritable output location is a coded CLI failure, not a stack trace', () => {
    const file = join(work, 'not-a-dir');
    writeFileSync(file, 'x');
    const r = runCli(['--asar', asarPath, '--out', join(file, 'build'), '--quiet']);
    assertCodedFailure(r, 'OUTPUT_IO', /Cannot prepare the output directory .*not-a-dir\/build: ENOTDIR/);
  });

  test('the CLI takes the data files from --resources', () => {
    const resources = join(work, 'copied-resources');
    for (const c of table.copies.filter((x) => x.from === 'resources')) {
      const dest = join(resources, ...c.source.split('/'));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(join(dirname(asarPath), ...c.source.split('/'))));
    }
    const out = join(work, 'with-resources');
    const ok = runCli(['--asar', asarPath, '--resources', resources, '--out', out, '--quiet']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(walk(join(out, 'vendor-data')), ['ENE/PCenter_AmbiglowInfo.json', 'MonitorInfo.json', 'PCenter_DeviceInfo.json']);
    const manifest = JSON.parse(readFileSync(join(out, 'vendor-ui', 'PATCHES.json'), 'utf8')) as Manifest;
    assert.ok(manifest.copied.some((c) => c.source === 'resources:bin/res/data/PCenter_DeviceInfo.json'));

    // The flag is honoured: an empty directory fails although the asar's own directory has the files.
    const empty = join(work, 'empty-resources-cli');
    mkdirSync(empty, { recursive: true });
    assertCodedFailure(runCli(['--asar', asarPath, '--resources', empty, '--out', join(work, 'x'), '--quiet']), 'COPY_MISSING', new RegExp(`${empty}/bin/res/data/PCenter_DeviceInfo\\.json`));
  });
});

// These use synthetic archives and run even without a vendor installation.
describe('import-vendor-ui rejects other vendor builds without touching the output', () => {
  let work: string;
  before(() => {
    work = mkdtempSync(join(tmpdir(), 'evnia-import-bad-'));
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  async function fakeAsar(
    name: string,
    files: Record<string, string>,
    prepare?: (root: string) => void,
    options: asar.CreateOptions = {},
  ): Promise<string> {
    const root = join(work, `${name}-src`);
    for (const [p, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), content);
    }
    prepare?.(root);
    const dest = join(work, name, 'resources', 'app.asar');
    mkdirSync(dirname(dest), { recursive: true });
    await asar.createPackageWithOptions(root, dest, options);
    return dest;
  }

  /**
   * Renames the header entry `from` to the entry name `to` in place (createPackage cannot produce
   * such names). The JSON key is padded with whitespace so the header keeps its size.
   */
  function renameHeaderEntry(asarPath: string, from: string, to: string): void {
    const buf = readFileSync(asarPath);
    const headerEnd = 8 + buf.readUInt32LE(4);
    const key = `"${from}":`;
    const at = buf.indexOf(key);
    const replacement = JSON.stringify(to);
    assert.ok(at > 0 && at < headerEnd && replacement.length < key.length);
    buf.write(`${replacement}${' '.repeat(key.length - replacement.length - 1)}:`, at);
    writeFileSync(asarPath, buf);
  }

  const renderer = {
    'out/renderer/index.html': '<html><head></head></html>',
    'out/renderer/assets/main-Yy8Yy8Yy.js': 'export{}',
  };

  test('an unsafe entry name anywhere in the archive is refused (ASAR_UNSAFE_PATH) before anything is written', async () => {
    const cases: Array<{ name: string; evil: string; dir: string; libraryAccepts: boolean }> = [
      // @electron/asar 4.3 already rejects "." and ".." while reading the header; the code is the same.
      { name: 'dotdot', evil: '..', dir: 'out/renderer', libraryAccepts: false },
      { name: 'dot', evil: '.', dir: 'out/renderer', libraryAccepts: false },
      // Names only our own check (SAFE_SEGMENT) refuses, also outside the renderer subtree.
      { name: 'empty', evil: '', dir: 'out/renderer', libraryAccepts: true },
      { name: 'nul', evil: '\u0000', dir: 'out/renderer/assets', libraryAccepts: true },
      { name: 'nul-outside', evil: 'a\u0000b', dir: 'node_modules', libraryAccepts: true },
    ];
    for (const { name, evil, dir, libraryAccepts } of cases) {
      const placeholder = `QQQQQQ${name}`;
      const a = await fakeAsar(name, { ...renderer, [`${dir}/${placeholder}/x.js`]: 'export{}' });
      renameHeaderEntry(a, placeholder, evil);
      if (libraryAccepts) assert.doesNotThrow(() => asar.getRawHeader(a), `${name}: the library accepts it`);
      assert.throws(
        () => new AsarSource(a),
        (e: unknown) => e instanceof ImportError && e.code === 'ASAR_UNSAFE_PATH' && e.message.includes(JSON.stringify(evil)),
        name,
      );
      const out = join(work, `out-${name}`);
      assertCodedFailure(runCli(['--asar', a, '--out', out, '--quiet']), 'ASAR_UNSAFE_PATH');
      assert.ok(!existsSync(out), 'nothing written');
    }
  });

  test('an unpacked entry without app.asar.unpacked/ is a coded ASAR_READ failure with a hint', async () => {
    const a = await fakeAsar('unpacked', renderer, undefined, { unpack: '*.js' });
    rmSync(`${a}.unpacked`, { recursive: true, force: true });
    assert.throws(
      () => new AsarSource(a).read('out/renderer/assets/main-Yy8Yy8Yy.js'),
      (e: unknown) => e instanceof ImportError && e.code === 'ASAR_READ' && e.message.includes('app.asar.unpacked/; copy that directory'),
    );
    assertCodedFailure(runCli(['--asar', a, '--out', join(work, 'out-unpacked'), '--quiet']), 'ASAR_READ', /ENOENT.*app\.asar\.unpacked\//);
  });

  test('a symlink inside the renderer is refused (ASAR_LINK) and never read as a file', async () => {
    const a = await fakeAsar('link', renderer, (root) => symlinkSync('main-Yy8Yy8Yy.js', join(root, 'out/renderer/assets/alias.js')));
    assert.throws(
      () => new AsarSource(a).listFiles(RENDERER_PREFIX),
      (e: unknown) => e instanceof ImportError && e.code === 'ASAR_LINK' && e.message.includes('out/renderer/assets/alias.js'),
    );
    assert.equal(new AsarSource(a).has('out/renderer/assets/alias.js'), false);
  });

  test('renamed chunks: PIN_MISSING names the pinned and the found file', async () => {
    const a = await fakeAsar('renamed', {
      'out/renderer/index.html': '<html><head></head></html>',
      'out/renderer/notice/notice.html': '<html><head></head></html>',
      'out/renderer/assets/styles-Zz9Zz9Zz.js': 'export{}',
      'out/renderer/assets/main-Yy8Yy8Yy.js': 'export{}',
    });
    const out = join(work, 'out-renamed');
    mkdirSync(join(out, 'vendor-ui'), { recursive: true });
    writeFileSync(join(out, 'vendor-ui', 'previous.txt'), 'keep');
    const r = runCli(['--asar', a, '--out', out, '--quiet']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PIN_MISSING: Vendor UI mismatch: expected assets\/styles-DAnQi2A8\.js \(Evnia Precision Center 1\.13\.0\) but found assets\/styles-Zz9Zz9Zz\.js/);
    assert.equal(readFileSync(join(out, 'vendor-ui', 'previous.txt'), 'utf8'), 'keep', 'previous import left intact');
  });

  test('same names, different content: PIN_HASH', async () => {
    const a = await fakeAsar('modified', {
      'out/renderer/index.html': '<html><head></head></html>',
      'out/renderer/notice/notice.html': '<html><head></head></html>',
      'out/renderer/assets/styles-DAnQi2A8.js': 'export const modified=1',
      'out/renderer/assets/main-CDosWiM3.js': 'export{}',
    });
    const r = runCli(['--asar', a, '--out', join(work, 'out-modified'), '--quiet']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /PIN_HASH: Vendor UI mismatch: assets\/styles-DAnQi2A8\.js has SHA-256 [0-9a-f]{64}, expected c3b4f412/);
    assert.ok(!existsSync(join(work, 'out-modified', 'vendor-ui')));
  });

  test('missing archive: a clear hint about --asar / EVNIA_VENDOR_ASAR', () => {
    const r = runCli(['--asar', join(work, 'nope', 'app.asar'), '--out', join(work, 'x'), '--quiet']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ASAR_MISSING: .*--asar .*EVNIA_VENDOR_ASAR/);
  });

  test('defaultPaths: the installer copy next to the repository, or EVNIA_VENDOR_ASAR resolved against the cwd', () => {
    const port = resolve('/src/thebenchmark/port');
    const installed = resolve('/src/thebenchmark/Evnia Precision Center/resources/app.asar');
    assert.deepEqual(defaultPaths(port, {}), { asarPath: installed, outDir: resolve(port, 'build') });
    assert.equal(defaultPaths(port, { EVNIA_VENDOR_ASAR: '' }).asarPath, installed, 'an empty variable counts as unset');
    assert.equal(defaultPaths(port, { EVNIA_VENDOR_ASAR: 'vendor/app.asar' }).asarPath, resolve(process.cwd(), 'vendor/app.asar'));
    assert.equal(defaultPaths(port, { EVNIA_VENDOR_ASAR: '/opt/evnia/app.asar' }).asarPath, resolve('/opt/evnia/app.asar'));
    assert.equal(defaultPaths(port, { EVNIA_VENDOR_ASAR: '/opt/evnia/app.asar' }).outDir, resolve(port, 'build'));
  });

  test('the CLI reads EVNIA_VENDOR_ASAR (relative to its cwd) and --asar overrides it', () => {
    const env = { ...process.env, EVNIA_VENDOR_ASAR: join('rel', 'app.asar') };
    const viaEnv = runCli(['--out', join(work, 'env-out'), '--quiet'], { cwd: work, env });
    assertCodedFailure(viaEnv, 'ASAR_MISSING', new RegExp(`Vendor archive not found: ${join(work, 'rel', 'app.asar')}\\.`));
    const viaFlag = runCli(['--asar', 'flag.asar', '--out', join(work, 'env-out'), '--quiet'], { cwd: work, env });
    assertCodedFailure(viaFlag, 'ASAR_MISSING', new RegExp(`Vendor archive not found: ${join(work, 'flag.asar')}\\.`));
  });

  test('usage errors exit with status 2', () => {
    assert.equal(runCli(['--bogus']).status, 2);
  });
});
