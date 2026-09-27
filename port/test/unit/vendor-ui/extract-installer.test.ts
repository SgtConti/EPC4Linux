// Tests of scripts/extract-installer.mjs, the extraction of the vendor installer for a build without Windows.
// - The listing, path and version helpers and the CLI's early failures run everywhere.
// - Synthetic installers need 7-Zip (the evnia-port-dev image has it) and a POSIX host: a 7z archive holding
//   app.7z stands in for the NSIS executable, and a small 7-Zip shim reads it with -t7z where the script says
//   -tnsis. Everything after the NSIS layer (listing checks, extraction, verification, output swap) is real.
// - The real vendor installer runs only with EVNIA_VENDOR_INSTALLER pointing at "evnia Setup 1.13.0.exe".

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';
import {
  BUILD_SELECTION,
  checkEntryPath,
  findPayload,
  findSevenZip,
  MARKER_NAME,
  parseSltListing,
  parseVersionResource,
  REFERENCES,
  runExtract,
  sameVersion,
  sevenZipCandidates,
  type ExtractOptions,
  type ExtractTable,
  type Marker,
} from '../../../scripts/extract-installer.ts';
import { loadPatchTable, runImport } from '../../../scripts/lib/import-pipeline.ts';
import { ImportError, sha256 } from '../../../scripts/lib/patch-engine.ts';

const portDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cli = join(portDir, 'scripts', 'extract-installer.mjs');

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: portDir, env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A failure the CLI anticipated: exit 1 and one coded line, never a Node stack trace. */
function assertCodedFailure(r: { status: number | null; stderr: string }, code: string, re: RegExp = /./): void {
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`^extract-installer: ${code}: `, 'm'));
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

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function rejectsWith(p: Promise<unknown>, code: string, re: RegExp = /./): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof ImportError && e.code === code && re.test(e.message));
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────

describe('extract-installer helpers', () => {
  test('parseSltListing reads the -slt blocks: sizes, folders, symbolic links; the archive header is skipped', () => {
    const text = [
      '7-Zip 25.01 (x64) : Copyright (c) 1999-2025 Igor Pavlov : 2025-08-03',
      '',
      'Listing archive: app.7z',
      '',
      '--',
      'Path = app.7z',
      'Type = 7z',
      '',
      '----------',
      'Path = resources',
      'Size = 0',
      'Attributes = D',
      '',
      'Path = resources/app.asar',
      'Size = 24838405',
      'Attributes = A',
      '',
      'Path = $PLUGINSDIR/System.dll',
      'Size = ',
      'Packed Size = 6396',
      'Attributes = ',
      '',
      'Path = resources/bin/res/data/evil',
      'Size = 11',
      'Attributes = A lrwxrwxrwx',
      '',
      'Path = dir2',
      'Folder = +',
      '',
    ].join('\n');
    assert.deepEqual(parseSltListing(text), [
      { path: 'resources', size: 0, folder: true, link: false },
      { path: 'resources/app.asar', size: 24838405, folder: false, link: false },
      { path: '$PLUGINSDIR/System.dll', size: undefined, folder: false, link: false },
      { path: 'resources/bin/res/data/evil', size: 11, folder: false, link: true },
      { path: 'dir2', size: undefined, folder: true, link: false },
    ]);
    assert.deepEqual(parseSltListing('Listing archive: x\nERRORS:\nIs not archive\n'), [], 'no ---------- line: no entries');
  });

  test('checkEntryPath normalizes \\ and refuses absolute, drive and parent paths', () => {
    assert.equal(checkEntryPath('resources/app.asar'), 'resources/app.asar');
    assert.equal(checkEntryPath('resources\\bin\\res\\data'), 'resources/bin/res/data');
    assert.equal(checkEntryPath('$PLUGINSDIR/app-64.7z'), '$PLUGINSDIR/app-64.7z');
    for (const bad of ['', '/etc/passwd', '\\\\server\\share\\x', 'C:/x', 'c:x', '../x', 'a/../../b', 'a/./b', 'a//b', 'a/', 'a\u0000b']) {
      assert.throws(() => checkEntryPath(bad), (e: unknown) => e instanceof ImportError && e.code === 'ARCHIVE_UNSAFE', JSON.stringify(bad));
    }
  });

  test('findPayload: app.7z or $PLUGINSDIR/app-64.7z, exactly one, never a folder', () => {
    const e = (path: string, folder = false) => ({ path, size: 1, folder, link: false });
    assert.equal(findPayload([e('$PLUGINSDIR/System.dll'), e('app.7z')]).path, 'app.7z');
    assert.equal(findPayload([e('$PLUGINSDIR\\app-64.7z')]).path, '$PLUGINSDIR\\app-64.7z');
    assert.throws(() => findPayload([e('app.7z', true), e('app-32.7z')]), (x: unknown) => x instanceof ImportError && x.code === 'NO_PAYLOAD' && /is this the Evnia/.test(x.message));
    assert.throws(() => findPayload([e('app.7z'), e('$PLUGINSDIR/app-64.7z')]), (x: unknown) => x instanceof ImportError && x.code === 'NO_PAYLOAD' && /several/.test(x.message));
  });

  test('parseVersionResource and sameVersion', () => {
    const pe = 'Comment = \n{\nFileVersion: 1.13.0.0\nProductVersion: 1.13.0.0\nProductVersion: 1.13.0\nProductName: Evnia Precision Center\n}\n';
    assert.deepEqual(parseVersionResource(pe), { productName: 'Evnia Precision Center', productVersions: ['1.13.0.0', '1.13.0'] });
    assert.deepEqual(parseVersionResource('Type = 7z\n'), { productVersions: [] });
    assert.ok(sameVersion('1.13.0.0', '1.13.0'));
    assert.ok(sameVersion('1.13', '1.13.0'));
    assert.ok(sameVersion(' 01.13.0 ', '1.13.0'));
    assert.ok(!sameVersion('1.14.0', '1.13.0'));
    assert.ok(!sameVersion('1.13.0.1', '1.13.0'));
    assert.ok(!sameVersion('1.13.0-beta', '1.13.0'));
  });

  test('sevenZipCandidates: --7z, else EVNIA_7Z, else the PATH names that may read NSIS', () => {
    assert.deepEqual(sevenZipCandidates('/opt/7z', { EVNIA_7Z: '/x/7z' }, 'linux'), ['/opt/7z']);
    assert.deepEqual(sevenZipCandidates(undefined, { EVNIA_7Z: '/x/7z' }, 'linux'), ['/x/7z']);
    assert.deepEqual(sevenZipCandidates(undefined, {}, 'linux'), ['7zz', '7z', '7za']);
    assert.equal(sevenZipCandidates(undefined, { ProgramFiles: 'D:\\PF' }, 'win32')[1], join('D:\\PF', '7-Zip', '7z.exe'));
  });

  test('the build selection is what import-ui reads', async () => {
    const table = await loadPatchTable();
    assert.deepEqual([...BUILD_SELECTION], ['resources/app.asar', 'resources/bin/res/data']);
    for (const c of table.copies.filter((c) => c.from === 'resources')) {
      assert.ok(`resources/${c.source}`.startsWith('resources/bin/res/data/'), c.source);
    }
    assert.ok(REFERENCES.some((r) => r.version === table.vendor.version), 'a reference build for the pinned version');
  });
});

describe('extract-installer CLI: usage and early failures', () => {
  let work: string;
  before(() => {
    work = mkdtempSync(join(tmpdir(), 'evnia-extract-cli-'));
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  test('no installer is a usage error (exit 2); so is an unknown option', () => {
    const env = { ...process.env, EVNIA_VENDOR_INSTALLER: '' };
    const r = runCli([], env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--installer <path to the vendor installer> is required \(or set EVNIA_VENDOR_INSTALLER\)/);
    assert.match(r.stderr, /^usage: /m);
    const u = runCli(['--installer', 'x.exe', '--bogus'], env);
    assert.equal(u.status, 2);
    assert.match(u.stderr, /Unknown option '--bogus'/);
  });

  test('a missing installer: INSTALLER_MISSING with the hint; nothing written', () => {
    const out = join(work, 'out-missing');
    assertCodedFailure(runCli(['--installer', join(work, 'nope.exe'), '--out', out]), 'INSTALLER_MISSING', /--installer .*EVNIA_VENDOR_INSTALLER/);
    assert.ok(!existsSync(out));
  });

  test('EVNIA_VENDOR_INSTALLER is the default installer', () => {
    const r = runCli(['--out', join(work, 'o')], { ...process.env, EVNIA_VENDOR_INSTALLER: join(work, 'from-env.exe') });
    assertCodedFailure(r, 'INSTALLER_MISSING', /from-env\.exe/);
  });

  test('no usable 7-Zip: SEVENZIP_MISSING names what was tried and how to install it', () => {
    const installer = join(work, 'evnia Setup 1.13.0.exe');
    writeFileSync(installer, 'MZ');
    const r = runCli(['--installer', installer, '--out', join(work, 'o'), '--7z', join(work, 'no-such-7z')]);
    assertCodedFailure(r, 'SEVENZIP_MISSING', /no-such-7z: not found.*apt install 7zip.*--7z <path>/);
  });

  test('the installer inside the output directory is refused (OUT_REFUSED)', () => {
    const out = join(work, 'inside');
    mkdirSync(out);
    writeFileSync(join(out, 'setup.exe'), 'MZ');
    assertCodedFailure(runCli(['--installer', join(out, 'setup.exe'), '--out', out, '--force']), 'OUT_REFUSED', /is inside the output directory/);
    assert.deepEqual(readdirSync(out), ['setup.exe']);
  });
});

// ── Synthetic installers ────────────────────────────────────────────────────────────────────────────

const sevenZip = await findSevenZip().catch(() => undefined);
const synthSkip =
  process.platform === 'win32' ? 'the 7-Zip shim is a POSIX shell script' : sevenZip ? false : '7-Zip not installed (apt install 7zip; the evnia-port-dev image has it)';

const MAIN = 'export const main = 1;';
const INDEX = '<html><head></head></html>';
const MONITOR_INFO = '{"version":34}';
const DEVICE = '{"devices":[]}';
const AMBIGLOW = '{"models":[]}';

const syntheticTable: ExtractTable = {
  vendor: { product: 'Evnia Precision Center', version: '1.13.0' },
  pinnedFiles: [{ glob: 'assets/main-*.js', path: 'assets/main-Aa1.js', sha256: sha256(MAIN) }],
  copies: [
    { from: 'asar', source: 'MonitorInfo.json', destDir: 'vendor-data', sha256: sha256(MONITOR_INFO) },
    { from: 'resources', source: 'bin/res/data/PCenter_DeviceInfo.json', destDir: 'vendor-data', sha256: sha256(DEVICE) },
    { from: 'resources', source: 'bin/res/data/ENE/PCenter_AmbiglowInfo.json', destDir: 'vendor-data/ENE', sha256: sha256(AMBIGLOW) },
    { from: 'asar', source: 'resources/*.png', destDir: 'vendor-assets' },
  ],
};

const BUILD_FILES = [
  MARKER_NAME,
  'resources/app.asar',
  'resources/bin/res/data/BeiYing/KB.json',
  'resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json',
  'resources/bin/res/data/PCenter_DeviceInfo.json',
];

interface Variant {
  version?: string;
  main?: string;
  device?: string;
  /** Payload name inside the "installer"; default app.7z. */
  payloadName?: string;
  noAsar?: boolean;
  /** Changes to the install tree before it is archived. */
  tree?: (root: string) => void;
}

describe('extract-installer with synthetic installers', { skip: synthSkip }, () => {
  let work: string;
  let shim: string;
  let env: NodeJS.ProcessEnv;
  let n = 0;

  function sevenZ(cwd: string, ...args: string[]): void {
    const r = spawnSync(sevenZip?.bin ?? '7z', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  }

  /** A 7z archive shaped like the vendor installer: it holds app.7z, which holds the installed tree. */
  async function makeInstaller(v: Variant = {}): Promise<string> {
    const root = join(work, `inst-${++n}`);
    const src = join(root, 'asar-src');
    const tree = join(root, 'tree');
    write(join(src, 'package.json'), JSON.stringify({ name: 'evnia', version: v.version ?? '1.13.0' }));
    write(join(src, 'MonitorInfo.json'), MONITOR_INFO);
    write(join(src, 'out/renderer/index.html'), INDEX);
    write(join(src, 'out/renderer/assets/main-Aa1.js'), v.main ?? MAIN);
    write(join(src, 'resources/tray.png'), 'png');
    mkdirSync(join(tree, 'resources'), { recursive: true });
    if (!v.noAsar) await asar.createPackageWithOptions(src, join(tree, 'resources', 'app.asar'), {});
    write(join(tree, 'resources/bin/res/data/PCenter_DeviceInfo.json'), v.device ?? DEVICE);
    write(join(tree, 'resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json'), AMBIGLOW);
    write(join(tree, 'resources/bin/res/data/BeiYing/KB.json'), '{}');
    write(join(tree, 'resources/bin/EvniaServe.dll'), 'MZ');
    write(join(tree, 'Evnia Precision Center.exe'), 'MZ');
    v.tree?.(tree);
    const payloadDir = join(root, 'payload');
    const payload = join(payloadDir, ...(v.payloadName ?? 'app.7z').split('/'));
    mkdirSync(dirname(payload), { recursive: true });
    sevenZ(tree, 'a', '-t7z', '-snl', payload, ...readdirSync(tree));
    const installer = join(root, 'evnia Setup 1.13.0.exe');
    sevenZ(payloadDir, 'a', '-t7z', installer, ...readdirSync(payloadDir));
    return installer;
  }

  function opts(installer: string, outDir: string, extra: Partial<ExtractOptions> = {}): ExtractOptions & { lines: string[] } {
    const lines: string[] = [];
    return { installer, outDir, table: syntheticTable, sevenZip: shim, env, references: [], log: (l) => lines.push(l), lines, ...extra };
  }

  function readMarker(outDir: string): Marker {
    return JSON.parse(readFileSync(join(outDir, MARKER_NAME), 'utf8')) as Marker;
  }

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'evnia-extract-'));
    const shimJs = join(work, 'shim.cjs');
    writeFileSync(
      shimJs,
      [
        "const { spawnSync } = require('node:child_process');",
        'const args = process.argv.slice(2);',
        "const r = spawnSync(process.env.SHIM_REAL_7Z, args.map((a) => (a === '-tnsis' ? '-t7z' : a)), { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 });",
        'let out = r.stdout ?? Buffer.alloc(0);',
        "if (args[0] === 'l' && !args.some((a) => a.startsWith('-t')) && process.env.SHIM_VERSION_RESOURCE) out = Buffer.concat([out, Buffer.from(process.env.SHIM_VERSION_RESOURCE)]);",
        'process.stdout.write(out);',
        'process.exitCode = r.status ?? 2;',
      ].join('\n'),
    );
    shim = join(work, '7z-shim');
    writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath}' '${shimJs}' "$@"\n`, { mode: 0o755 });
    env = { ...process.env, SHIM_REAL_7Z: sevenZip?.bin ?? '7z' };
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  test('extracts resources/app.asar and resources/bin/res/data/ into a new directory, verified, with a marker', async () => {
    const installer = await makeInstaller();
    const parent = join(work, 'fresh', 'nested');
    const out = join(parent, 'Evnia Precision Center');
    const warnings: string[] = [];
    const o = opts(installer, out, {
      references: [{ version: '1.13.0', installer: { size: 1, sha256: '0'.repeat(64) }, asarSha256: '1'.repeat(64) }],
      warn: (l) => warnings.push(l),
    });
    const r = await runExtract(o);
    assert.equal(r.status, 'extracted');
    assert.equal(r.fileCount, BUILD_FILES.length - 1);
    assert.deepEqual(walk(out), BUILD_FILES, 'no exe, no DLL outside the build selection');
    assert.deepEqual(readdirSync(parent), ['Evnia Precision Center'], 'no staging directory left');
    assert.equal(readFileSync(join(out, 'resources/bin/res/data/PCenter_DeviceInfo.json'), 'utf8'), DEVICE);
    const m = readMarker(out);
    assert.deepEqual(m, r.marker);
    assert.deepEqual(m.installer, { size: statSync(installer).size, sha256: sha256(readFileSync(installer)) });
    assert.equal(m.mode, 'build');
    assert.equal(m.payload, 'app.7z');
    assert.deepEqual(Object.keys(m.files).sort(), [
      'resources/app.asar',
      'resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json',
      'resources/bin/res/data/PCenter_DeviceInfo.json',
    ]);
    assert.equal(m.files['resources/app.asar'], sha256(readFileSync(join(out, 'resources/app.asar'))));
    assert.match(o.lines.join('\n'), /1 pinned renderer files and 3 pinned data files verified/);
    assert.deepEqual(warnings.map((w) => w.replace(/ \(.*/, '')), [
      'warning: not the reference Evnia Precision Center 1.13.0 installer',
      'warning: app.asar',
    ]);
  });

  test('a second run is a verified no-op; a modified output needs --force, which repairs it', async () => {
    const installer = await makeInstaller();
    const out = join(work, 'rerun', 'Evnia Precision Center');
    await runExtract(opts(installer, out));
    const markerTime = statSync(join(out, MARKER_NAME)).mtimeMs;
    const again = opts(installer, out);
    const r = await runExtract(again);
    assert.equal(r.status, 'up-to-date');
    assert.match(again.lines.join('\n'), /already holds this installer's files \(verified\); nothing to do/);
    assert.equal(statSync(join(out, MARKER_NAME)).mtimeMs, markerTime, 'untouched');

    const device = join(out, 'resources/bin/res/data/PCenter_DeviceInfo.json');
    writeFileSync(device, '{"edited":true}');
    await rejectsWith(runExtract(opts(installer, out)), 'OUT_MODIFIED', /--force/);
    assert.equal(readFileSync(device, 'utf8'), '{"edited":true}');
    assert.equal((await runExtract(opts(installer, out, { force: true }))).status, 'extracted');
    assert.equal(readFileSync(device, 'utf8'), DEVICE);
    assert.deepEqual(readdirSync(dirname(out)), ['Evnia Precision Center']);
  });

  test('--full extracts the complete installation; a build-mode run then finds it up to date', async () => {
    const installer = await makeInstaller();
    const out = join(work, 'full', 'Evnia Precision Center');
    const r = await runExtract(opts(installer, out, { full: true }));
    assert.equal(r.marker.mode, 'full');
    assert.deepEqual(walk(out), [...BUILD_FILES, 'Evnia Precision Center.exe', 'resources/bin/EvniaServe.dll'].sort());
    assert.equal((await runExtract(opts(installer, out))).status, 'up-to-date');
    // The other way round, a build-mode directory does not hold the complete installation.
    const buildOut = join(work, 'full-b', 'o');
    await runExtract(opts(installer, buildOut));
    await rejectsWith(runExtract(opts(installer, buildOut, { full: true })), 'OUT_EXISTS', /--force/);
  });

  test('an existing directory: empty is used, an installation is replaced only with --force, anything else never', async () => {
    const installer = await makeInstaller();
    const base = join(work, 'existing');

    const empty = join(base, 'empty');
    mkdirSync(empty, { recursive: true });
    assert.equal((await runExtract(opts(installer, empty))).status, 'extracted');

    const foreign = join(base, 'foreign');
    write(join(foreign, 'notes.txt'), 'mine');
    await rejectsWith(runExtract(opts(installer, foreign)), 'OUT_EXISTS', /--force/);
    await rejectsWith(runExtract(opts(installer, foreign, { force: true })), 'OUT_REFUSED', /holds no Evnia installation/);
    assert.deepEqual(walk(foreign), ['notes.txt']);

    const file = join(base, 'a-file');
    writeFileSync(file, 'x');
    await rejectsWith(runExtract(opts(installer, file)), 'OUT_EXISTS');
    await rejectsWith(runExtract(opts(installer, file, { force: true })), 'OUT_REFUSED', /not a directory/);

    const copied = join(base, 'copied-from-windows');
    write(join(copied, 'resources', 'app.asar'), 'old');
    write(join(copied, 'internal-nlog.txt'), 'log');
    await rejectsWith(runExtract(opts(installer, copied)), 'OUT_EXISTS');
    assert.equal((await runExtract(opts(installer, copied, { force: true }))).status, 'extracted');
    assert.deepEqual(walk(copied), BUILD_FILES, 'replaced as a whole');
    assert.deepEqual(readdirSync(base).sort(), ['a-file', 'copied-from-windows', 'empty', 'foreign'], 'no staging directory left');
  });

  test('another vendor version in app.asar is refused and nothing is written (VENDOR_VERSION)', async () => {
    const installer = await makeInstaller({ version: '1.14.0' });
    const parent = join(work, 'v114');
    await rejectsWith(runExtract(opts(installer, join(parent, 'Evnia Precision Center'))), 'VENDOR_VERSION', /contains version 1\.14\.0 .*supports only Evnia Precision Center 1\.13\.0/);
    assert.deepEqual(readdirSync(parent), [], 'no output and no staging directory');
  });

  test('the version resource refuses another product or version before anything is extracted', async () => {
    const installer = await makeInstaller();
    const out = join(work, 'vr', 'o');
    const resource = (name: string, v: string) => ({ ...env, SHIM_VERSION_RESOURCE: `Comment = \n{\nProductVersion: ${v}.0\nProductVersion: ${v}\nProductName: ${name}\n}\n` });
    const wrong = opts(installer, out, { env: resource('Evnia Precision Center', '1.14.0') });
    await rejectsWith(runExtract(wrong), 'INSTALLER_VERSION', /is version 1\.14\.0 \(its version resource\)\. This port supports only Evnia Precision Center 1\.13\.0/);
    assert.ok(!wrong.lines.some((l) => l.startsWith('Extracting')));
    assert.ok(!existsSync(dirname(out)), 'not even the parent directory');
    await rejectsWith(runExtract(opts(installer, out, { env: resource('Other App', '1.13.0') })), 'NOT_EVNIA', /"Other App", not the Evnia Precision Center installer/);
    const right = opts(installer, out, { env: resource('Evnia Precision Center', '1.13.0') });
    await runExtract(right);
    assert.ok(right.lines.includes('  version resource: Evnia Precision Center 1.13.0'));
  });

  test('pins: a changed renderer chunk (PIN_HASH) or data file (COPY_HASH) is refused and nothing is written', async () => {
    const parent = join(work, 'pins');
    await rejectsWith(runExtract(opts(await makeInstaller({ main: 'export const main = 2;' }), join(parent, 'a'))), 'PIN_HASH', /assets\/main-Aa1\.js has SHA-256/);
    await rejectsWith(
      runExtract(opts(await makeInstaller({ device: '{"devices":[1]}' }), join(parent, 'b'))),
      'COPY_HASH',
      /resources\/bin\/res\/data\/PCenter_DeviceInfo\.json has SHA-256 [0-9a-f]{64}, expected/,
    );
    assert.deepEqual(readdirSync(parent), []);
  });

  test('layout: $PLUGINSDIR/app-64.7z is accepted; no payload (NO_PAYLOAD) or no app.asar (PAYLOAD_LAYOUT) is refused', async () => {
    const r = await runExtract(opts(await makeInstaller({ payloadName: '$PLUGINSDIR/app-64.7z' }), join(work, 'layout', 'a')));
    assert.equal(r.marker.payload, '$PLUGINSDIR/app-64.7z');
    await rejectsWith(runExtract(opts(await makeInstaller({ payloadName: 'other.7z' }), join(work, 'layout', 'b'))), 'NO_PAYLOAD', /no app\.7z/);
    await rejectsWith(runExtract(opts(await makeInstaller({ noAsar: true }), join(work, 'layout', 'c'))), 'PAYLOAD_LAYOUT', /has no resources\/app\.asar/);
    assert.deepEqual(readdirSync(join(work, 'layout')), ['a']);
  });

  test('a symbolic link in the payload is refused before extraction (ARCHIVE_UNSAFE)', async () => {
    const installer = await makeInstaller({ tree: (root) => symlinkSync('/etc/passwd', join(root, 'resources/bin/res/data/evil')) });
    const parent = join(work, 'link');
    await rejectsWith(runExtract(opts(installer, join(parent, 'o'))), 'ARCHIVE_UNSAFE', /resources\/bin\/res\/data\/evil is a symbolic link/);
    assert.deepEqual(readdirSync(parent), []);
  });

  test('an interrupted run removes its staging directory and leaves the output alone', async () => {
    const installer = await makeInstaller();
    const parent = join(work, 'abort');
    const controller = new AbortController();
    const o = opts(installer, join(parent, 'o'), {
      signal: controller.signal,
      log: (l) => {
        if (l.startsWith('Extracting')) controller.abort();
      },
    });
    await assert.rejects(runExtract(o), (e: unknown) => (e as Error).name === 'AbortError');
    assert.deepEqual(readdirSync(parent), []);
  });

  test('a file that is not an NSIS installer (real 7-Zip): NOT_NSIS', async () => {
    const junk = join(work, 'junk.exe');
    writeFileSync(junk, Buffer.alloc(4096, 0x5a));
    await rejectsWith(runExtract(opts(junk, join(work, 'junk-out'), { sevenZip: sevenZip?.bin })), 'NOT_NSIS', /is not an NSIS installer/);
    assert.ok(!existsSync(join(work, 'junk-out')));
  });

  test('the CLI reports a failure as one coded line (the real patch table refuses the synthetic build)', async () => {
    const installer = await makeInstaller();
    const out = join(work, 'cli', 'o');
    const r = runCli(['--installer', installer, '--out', out, '--7z', shim, '--quiet'], env);
    assertCodedFailure(r, 'PIN_MISSING', /expected assets\/styles-DAnQi2A8\.js \(Evnia Precision Center 1\.13\.0\)/);
    assert.match(r.stderr, /^warning: not the reference Evnia Precision Center 1\.13\.0 installer/m);
    assert.deepEqual(readdirSync(dirname(out)), []);
  });
});

// ── The real installer ──────────────────────────────────────────────────────────────────────────────

const realInstaller = process.env.EVNIA_VENDOR_INSTALLER;
const realSkip = !realInstaller
  ? 'set EVNIA_VENDOR_INSTALLER to the path of "evnia Setup 1.13.0.exe" to run'
  : !existsSync(realInstaller)
    ? `${realInstaller} not found`
    : sevenZip
      ? false
      : '7-Zip not installed (apt install 7zip; the evnia-port-dev image has it)';

describe('extract-installer with the real Evnia Precision Center 1.13.0 installer', { skip: realSkip }, () => {
  let work: string;
  let out: string;
  let run: { status: number | null; stdout: string; stderr: string };

  before(() => {
    work = mkdtempSync(join(tmpdir(), 'evnia-extract-real-'));
    out = join(work, 'Evnia Precision Center');
    run = runCli(['--installer', realInstaller ?? '', '--out', out]);
  });
  after(() => rmSync(work, { recursive: true, force: true }));

  test('the CLI extracts it and the files match the pins of scripts/ui-patches.mjs', async () => {
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '', 'no warnings: the reference installer and app.asar');
    assert.match(run.stdout, /identical to the reference Evnia Precision Center 1\.13\.0 installer/);
    assert.match(run.stdout, /NSIS payload app\.7z/);
    assert.match(run.stdout, /app\.asar is identical to the reference Evnia Precision Center 1\.13\.0 build/);
    assert.match(run.stdout, /^OK: Evnia Precision Center 1\.13\.0 extracted to .* \(5 files\)\. Next: npm run import-ui -- --asar /m);
    assert.deepEqual(walk(out), [
      MARKER_NAME,
      'resources/app.asar',
      'resources/bin/res/data/BeiYing/KB_K916.json',
      'resources/bin/res/data/ENE/PCenter_AmbiglowInfo.json',
      'resources/bin/res/data/PCenter_DeviceInfo.json',
      'resources/bin/res/data/RongYuan/RongYuan_Keyboard_V1.json',
    ]);
    assert.deepEqual(readdirSync(work), ['Evnia Precision Center'], 'no staging directory left');
    const table = await loadPatchTable();
    for (const c of table.copies.filter((c) => c.from === 'resources')) {
      assert.equal(sha256(readFileSync(join(out, 'resources', ...c.source.split('/')))), c.sha256, c.source);
    }
    assert.equal(sha256(readFileSync(join(out, 'resources', 'app.asar'))), REFERENCES[0].asarSha256);
  });

  test('the import (npm run import-ui) accepts the extracted app.asar and data files', async () => {
    const table = await loadPatchTable();
    const result = await runImport({ asarPath: join(out, 'resources', 'app.asar'), outDir: join(work, 'build'), table });
    assert.equal(result.manifest.vendor.asarSha256, REFERENCES[0].asarSha256);
    assert.equal(result.manifest.patches.length, table.patches.length);
    assert.ok(result.manifest.copied.some((c) => c.dest === 'vendor-data/ENE/PCenter_AmbiglowInfo.json'));
  });

  test('running it again is a verified no-op', () => {
    const r = runCli(['--installer', realInstaller ?? '', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already holds this installer's files \(verified\); nothing to do/);
    assert.match(r.stdout, /^OK: Evnia Precision Center 1\.13\.0 already in /m);
  });
});
