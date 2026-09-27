#!/usr/bin/env node
// npm run dist:deb — package build/app as dist/evnia-precision-center_<version>_amd64.deb (ARCHITECTURE
// "Build and test pipeline" 5). Runs in the Linux dev container; never downloads anything.
//
//   node scripts/package-deb.mjs [--app <dir>] [--out <dir>] [--allow-missing-ui]
//
// Environment: DEBEMAIL ("addr" or "Name <addr>"), DEBFULLNAME / NAME (the maintainer, with debchange's
// precedence); without DEBEMAIL the maintainer is the placeholder "Evnia Linux Port <noreply@localhost>",
// never the git identity. SOURCE_DATE_EPOCH dates the changelog entry.
//
// 1. stage       build/app + the production dependency closure of usb, koffi and ws from node_modules
//                (other-platform prebuilds and sources pruned) + package.json with those dependencies
// 2. electron    electron-v<ver>-linux-x64.zip made from node_modules/electron/dist (packager's
//                electronZipDir; the packager would otherwise download it)
// 3. packager    @electron/packager linux/x64, app name evnia-precision-center, asar with every *.node
//                and the koffi/usb packages unpacked, dev dependencies pruned; then the executable's
//                fuses: RunAsNode, NODE_OPTIONS and --inspect off (scripts/lib/fuses.ts)
// 4. deb tree    /opt/evnia-precision-center, /usr/bin symlink, .desktop, hicolor icons, udev rules,
//                modules-load.d, man page, README.Debian, copyright, changelog, lintian overrides,
//                DEBIAN/{control,md5sums,postinst,postrm}; modes normalized (the source tree may come
//                from a Windows bind mount where everything is 0777)
// 5. shlibs      every shared object the shipped ELF files need is shipped or comes from a package in
//                Depends, and the libc6 bound covers their GLIBC_ symbol versions (readelf)
// 6. dpkg-deb    fakeroot dpkg-deb -Zxz --build

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, open, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { packager } from '@electron/packager';
import { describeFuses, fuseState, PACKAGED_FUSES, readFuseWire, setFuses } from './lib/fuses.ts';

const portDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_NAME = 'evnia-precision-center';
const INSTALL_DIR = `/opt/${APP_NAME}`;
/** Files of the Electron distribution that must stay executable; everything else is 0644. */
const EXECUTABLES = new Set([APP_NAME, 'chrome-sandbox', 'chrome_crashpad_handler']);
/** hicolor sizes (index.theme); a vendor icon of another size (favicon_24x24.png is 28x28) is skipped. */
const HICOLOR_SIZES = new Set([16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512]);
/** Runtime packages the main bundle loads from node_modules (scripts/build.mjs externals). */
const RUNTIME_DEPS = ['usb', 'koffi', 'ws'];
/** Pruned from the staged node_modules: other platforms' binaries and build-time sources. */
const PRUNE = [
  (rel) => /^usb\/prebuilds\/(?!linux-x64(\/|$))/.test(rel),
  (rel) => /^usb\/prebuilds\/linux-x64\/.*musl/.test(rel),
  (rel) => /^usb\/(libusb|src|test)(\/|$)/.test(rel),
  (rel) => /^usb\/(binding\.gyp|libusb\.gypi)$/.test(rel),
  // koffi: the loader needs index.cjs, src/koffi/*.cjs and src/koffi/src/*.cjs; C/C++ sources and the
  // node-api headers are only for building from source.
  (rel) => /^koffi\/(doc|lib|vendor)(\/|$)/.test(rel),
  (rel) => /^koffi\/(cnoke\.cjs|src\/koffi\/CMakeLists\.txt)$/.test(rel),
  (rel) => /^koffi\/src\/koffi\/src\/abi(\/|$)/.test(rel),
  (rel) => /^koffi\/src\/koffi\/src\/.*\.(cc|hh|c|h|inc|S|asm)$/.test(rel),
  (rel) => /^@koromix\/koffi-linux-x64\/musl_x64(\/|$)/.test(rel),
];

/** Maintainer without DEBEMAIL: a neutral placeholder (lintian's bogus-mail-host tags are overridden for it). */
const PLACEHOLDER_MAINTAINER = { name: 'Evnia Linux Port', email: 'noreply@localhost' };

/**
 * Shared objects the shipped ELF files list as NEEDED (readelf -d), mapped to the Debian package that ships
 * them (the t64 name; Depends in control.in carries the pre-t64 name as an alternative). Electron 44:
 * electron, chrome_crashpad_handler, libffmpeg.so, libvk_swiftshader.so, libvulkan.so.1, chrome-sandbox;
 * usb 2.18.0 node.napi.glibc.node (libusb linked statically, but libudev.so.1 dynamically); koffi.node.
 * A soname missing here fails the build: add it here and to Depends.
 */
const SONAME_PACKAGES = new Map([
  ['ld-linux-x86-64.so.2', 'libc6'],
  ['libc.so.6', 'libc6'],
  ['libdl.so.2', 'libc6'],
  ['libm.so.6', 'libc6'],
  ['libpthread.so.0', 'libc6'],
  ['libgcc_s.so.1', 'libgcc-s1'],
  ['libstdc++.so.6', 'libstdc++6'],
  ['libasound.so.2', 'libasound2t64'],
  ['libatk-1.0.so.0', 'libatk1.0-0t64'],
  ['libatk-bridge-2.0.so.0', 'libatk-bridge2.0-0t64'],
  ['libatspi.so.0', 'libatspi2.0-0t64'],
  ['libcairo.so.2', 'libcairo2'],
  ['libcups.so.2', 'libcups2t64'],
  ['libdbus-1.so.3', 'libdbus-1-3'],
  ['libexpat.so.1', 'libexpat1'],
  ['libgbm.so.1', 'libgbm1'],
  ['libgio-2.0.so.0', 'libglib2.0-0t64'],
  ['libglib-2.0.so.0', 'libglib2.0-0t64'],
  ['libgobject-2.0.so.0', 'libglib2.0-0t64'],
  ['libgtk-3.so.0', 'libgtk-3-0t64'],
  ['libnspr4.so', 'libnspr4'],
  ['libnss3.so', 'libnss3'],
  ['libnssutil3.so', 'libnss3'],
  ['libsmime3.so', 'libnss3'],
  ['libpango-1.0.so.0', 'libpango-1.0-0'],
  ['libudev.so.1', 'libudev1'],
  ['libX11.so.6', 'libx11-6'],
  ['libxcb.so.1', 'libxcb1'],
  ['libXcomposite.so.1', 'libxcomposite1'],
  ['libXdamage.so.1', 'libxdamage1'],
  ['libXext.so.6', 'libxext6'],
  ['libXfixes.so.3', 'libxfixes3'],
  ['libxkbcommon.so.0', 'libxkbcommon0'],
  ['libXrandr.so.2', 'libxrandr2'],
]);

const { values: args } = parseArgs({
  options: {
    app: { type: 'string' },
    out: { type: 'string' },
    'allow-missing-ui': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});
if (args.help) {
  console.log('usage: node scripts/package-deb.mjs [--app <dir>] [--out <dir>] [--allow-missing-ui]');
  process.exit(0);
}

const appDir = resolve(portDir, args.app ?? 'build/app');
const outDir = resolve(portDir, args.out ?? 'dist');
const work = join(outDir, 'work');
const packagingDir = join(portDir, 'packaging', 'deb');
const log = (msg) => console.log(`dist:deb: ${msg}`);

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

/**
 * The Maintainer (and changelog signature), with debchange's rules: the address from DEBEMAIL ("addr" or
 * "Name <addr>"), the name from DEBFULLNAME, else NAME, else the one in DEBEMAIL. Without DEBEMAIL:
 * the placeholder, whatever the git configuration says.
 */
function maintainerFromEnv(env) {
  const raw = env.DEBEMAIL?.trim();
  if (!raw) return { ...PLACEHOLDER_MAINTAINER, placeholder: true };
  const m = /^(.*?)\s*<([^<>\s]+)>$/.exec(raw);
  const email = m ? m[2] : raw;
  if (!/^[^@\s<>,]+@[^@\s<>,]+$/.test(email)) throw new Error(`DEBEMAIL does not hold an e-mail address: ${JSON.stringify(raw)}`);
  const name = env.DEBFULLNAME?.trim() || env.NAME?.trim() || m?.[1].trim() || PLACEHOLDER_MAINTAINER.name;
  if (/[<>,\n]/.test(name)) throw new Error(`maintainer name must not contain <, > or commas: ${JSON.stringify(name)}`);
  return { name, email, placeholder: false };
}

/** Production dependency closure (dependencies + installed optionalDependencies), npm-flat layout. */
function dependencyClosure(roots, nodeModules) {
  const found = new Map();
  const queue = roots.map((name) => ({ name, optional: false }));
  while (queue.length > 0) {
    const { name, optional } = queue.shift();
    if (found.has(name)) continue;
    const dir = join(nodeModules, name);
    if (!existsSync(join(dir, 'package.json'))) {
      if (optional) continue;
      throw new Error(`runtime dependency ${name} is not installed in ${nodeModules}`);
    }
    found.set(name, dir);
    const pkg = readJson(join(dir, 'package.json'));
    for (const d of Object.keys(pkg.dependencies ?? {})) queue.push({ name: d, optional: false });
    for (const d of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: d, optional: true });
  }
  return found;
}

async function walk(dir, fn, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const p = join(dir, entry.name);
    const rel = relative(base, p);
    const descend = await fn(p, rel, entry);
    if (entry.isDirectory() && descend !== false) await walk(p, fn, base);
  }
}

const posix = (rel) => rel.split(sep).join('/');

async function stage() {
  if (!existsSync(join(appDir, 'main.cjs'))) throw new Error(`${appDir}/main.cjs missing: run "npm run build" first`);
  if (!existsSync(join(appDir, 'vendor-ui', 'index.html')) && !args['allow-missing-ui']) {
    throw new Error(`${appDir}/vendor-ui missing: run "npm run import-ui" and "npm run build" first (or pass --allow-missing-ui)`);
  }
  const stageDir = join(work, 'stage');
  await cp(appDir, stageDir, { recursive: true });
  const portPkg = readJson(join(portDir, 'package.json'));
  const appPkg = readJson(join(appDir, 'package.json'));
  appPkg.dependencies = Object.fromEntries(RUNTIME_DEPS.map((d) => [d, portPkg.dependencies[d]]));
  await writeFile(join(stageDir, 'package.json'), `${JSON.stringify(appPkg, null, 2)}\n`);
  const nodeModules = join(portDir, 'node_modules');
  const closure = dependencyClosure(RUNTIME_DEPS, nodeModules);
  for (const [name, dir] of closure) {
    await cp(dir, join(stageDir, 'node_modules', name), {
      recursive: true,
      filter: (src) => !PRUNE.some((rule) => rule(posix(relative(nodeModules, src)))),
    });
  }
  log(`staged ${relative(portDir, stageDir)} with ${[...closure.keys()].join(', ')}`);
  return { stageDir, version: appPkg.version };
}

async function electronZip() {
  const electronPkg = readJson(join(portDir, 'node_modules', 'electron', 'package.json'));
  const zipDir = join(work, 'electron-zip');
  const zip = join(zipDir, `electron-v${electronPkg.version}-linux-x64.zip`);
  await mkdir(zipDir, { recursive: true });
  // Python's zipfile keeps the POSIX modes the packager's extractor restores (chrome-sandbox etc.).
  execFileSync('python3', [
    '-c',
    [
      'import os, sys, zipfile',
      'src, out = sys.argv[1], sys.argv[2]',
      'with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as z:',
      '    for root, dirs, files in os.walk(src):',
      '        dirs.sort()',
      '        for f in sorted(files):',
      '            p = os.path.join(root, f)',
      '            z.write(p, os.path.relpath(p, src))',
    ].join('\n'),
    join(portDir, 'node_modules', 'electron', 'dist'),
    zip,
  ]);
  log(`electron ${electronPkg.version} zip from node_modules/electron/dist`);
  return { zipDir, electronVersion: electronPkg.version };
}

async function runPackager(stageDir, version, zip) {
  const [appPath] = await packager({
    dir: stageDir,
    out: join(work, 'packager'),
    overwrite: true,
    platform: 'linux',
    arch: 'x64',
    electronVersion: zip.electronVersion,
    electronZipDir: zip.zipDir,
    name: APP_NAME,
    executableName: APP_NAME,
    appVersion: version,
    asar: { unpack: '*.node', unpackDir: '{node_modules/koffi,node_modules/@koromix,node_modules/usb}' },
    prune: true,
    junk: true,
    derefSymlinks: true,
    quiet: true,
  });
  log(`packaged ${relative(portDir, appPath)}`);
  await hardenFuses(join(appPath, APP_NAME));
  return appPath;
}

/**
 * The executable's fuses (scripts/lib/fuses.ts PACKAGED_FUSES): the installed app cannot be turned into a
 * general Node runtime (ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect). Written, then read back.
 */
async function hardenFuses(executable) {
  const binary = await readFile(executable);
  const { mode } = await stat(executable);
  setFuses(binary, PACKAGED_FUSES);
  await writeFile(executable, binary);
  await chmod(executable, mode & 0o7777);
  const wire = readFuseWire(await readFile(executable));
  for (const [name, on] of Object.entries(PACKAGED_FUSES)) {
    if (fuseState(wire, name) !== on) throw new Error(`fuse ${name} is not ${on ? 'on' : 'off'} in ${executable}`);
  }
  log(`fuses: ${describeFuses(wire)}`);
}

/** PNG width/height from the IHDR chunk. */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** RFC 2822 date for the changelog: SOURCE_DATE_EPOCH when set (reproducible builds), else now. */
function changelogDate() {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const d = Number.isInteger(epoch) && epoch > 0 ? new Date(epoch * 1000) : new Date();
  return d.toUTCString().replace(/GMT$/, '+0000');
}

/** Minimal Debian changelog entry for this build (lintian expects one for a non-native version). */
function debianChangelog(version, maintainer) {
  return (
    `${APP_NAME} (${version}) unstable; urgency=low\n\n` +
    '  * Offline Linux port of Evnia Precision Center 1.13.0 (monitor features only).\n\n' +
    ` -- ${maintainer.name} <${maintainer.email}>  ${changelogDate()}\n`
  );
}

/** gzip -9n equivalent (no name, no timestamp), as Debian policy asks for man pages and docs. */
const gzip9n = (buf) => gzipSync(buf, { level: 9 });

function md5(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('md5');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')));
  });
}

/** DEBIAN/md5sums content (dh_md5sums format) for every regular file of the tree. */
async function md5sums(root) {
  const lines = [];
  await walk(root, async (p, rel, entry) => {
    if (rel === 'DEBIAN') return false;
    if (entry.isFile()) lines.push(`${await md5(p)}  ${posix(rel)}`);
    return true;
  });
  return `${lines.join('\n')}\n`;
}

/** Depends of a control file: [[name, …alternatives], …] without version constraints. */
function dependsNames(control) {
  const field = /^Depends: (.*)$/m.exec(control)?.[1] ?? '';
  return field.split(',').map((clause) => clause.split('|').map((alt) => alt.trim().split(/[\s(]/)[0]));
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function isElf(path) {
  const fh = await open(path, 'r');
  try {
    const { bytesRead, buffer } = await fh.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && buffer.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } finally {
    await fh.close();
  }
}

/**
 * Step 5: the NEEDED sonames of every shipped ELF file are either shipped in the package or provided by a
 * package that Depends names (SONAME_PACKAGES), and Depends' libc6 bound is at least the highest GLIBC_
 * symbol version they need. Guards Depends against Electron or prebuild upgrades.
 */
async function checkSharedLibraries(root, control) {
  const shipped = new Set();
  const elfs = [];
  await walk(root, async (p, rel, entry) => {
    if (rel === 'DEBIAN') return false;
    if (!entry.isFile()) return true;
    shipped.add(entry.name);
    if (await isElf(p)) elfs.push({ path: p, rel: posix(rel) });
    return true;
  });
  const depends = dependsNames(control);
  const declared = new Set(depends.flat());
  const problems = [];
  let glibc = '0';
  const needed = new Set();
  for (const elf of elfs) {
    const out = execFileSync('readelf', ['-d', '-V', '-W', elf.path], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    for (const [, soname] of out.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)) {
      needed.add(soname);
      if (shipped.has(soname)) continue;
      const pkg = SONAME_PACKAGES.get(soname);
      if (!pkg) problems.push(`${elf.rel} needs ${soname}, which is neither shipped nor known (add it to SONAME_PACKAGES and Depends)`);
      else if (!declared.has(pkg)) problems.push(`${elf.rel} needs ${soname} from ${pkg}, which Depends does not name`);
    }
    for (const [, v] of out.matchAll(/Name: GLIBC_([\d.]+)\s/g)) if (compareVersions(v, glibc) > 0) glibc = v;
  }
  const libcBound = /(?:^|[\s,])libc6 \(>= ([\d.]+)\)/m.exec(/^Depends: (.*)$/m.exec(control)?.[1] ?? '')?.[1];
  if (!libcBound) problems.push('Depends has no versioned libc6 (>= …)');
  else if (compareVersions(libcBound, glibc) < 0) problems.push(`libc6 (>= ${libcBound}) is below the GLIBC_${glibc} the binaries need`);
  if (problems.length > 0) throw new Error(`shared-library dependencies:\n  ${problems.join('\n  ')}`);
  log(`shlibs: ${elfs.length} ELF files, ${needed.size} sonames, all shipped or in Depends; GLIBC_${glibc} <= libc6 (>= ${libcBound})`);
}

async function debTree(appPath, version, maintainer) {
  const root = join(work, 'deb-root');
  const opt = join(root, INSTALL_DIR.slice(1));
  await cp(appPath, opt, { recursive: true, verbatimSymlinks: true });
  await walk(opt, async (p, rel, entry) => {
    if (entry.isSymbolicLink()) return false;
    await chmod(p, entry.isDirectory() ? 0o755 : EXECUTABLES.has(rel) ? 0o755 : 0o644);
    return true;
  });

  const usrBin = join(root, 'usr', 'bin');
  await mkdir(usrBin, { recursive: true });
  await symlink(`${INSTALL_DIR}/${APP_NAME}`, join(usrBin, APP_NAME));

  const place = async (src, dest, mode = 0o644) => {
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest);
    await chmod(dest, mode);
  };
  const placeData = async (data, dest) => {
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
    await chmod(dest, 0o644);
  };
  const doc = join(root, 'usr', 'share', 'doc', APP_NAME);
  await place(join(packagingDir, `${APP_NAME}.desktop`), join(root, 'usr', 'share', 'applications', `${APP_NAME}.desktop`));
  await place(join(packagingDir, `70-${APP_NAME}.rules`), join(root, 'usr', 'lib', 'udev', 'rules.d', `70-${APP_NAME}.rules`));
  await place(join(packagingDir, `${APP_NAME}-i2c.conf`), join(root, 'usr', 'lib', 'modules-load.d', `${APP_NAME}-i2c.conf`));
  await place(join(packagingDir, 'copyright'), join(doc, 'copyright'));
  await placeData(gzip9n(Buffer.from(debianChangelog(version, maintainer))), join(doc, 'changelog.Debian.gz'));
  await placeData(gzip9n(await readFile(join(packagingDir, 'README.Debian'))), join(doc, 'README.Debian.gz'));
  await placeData(gzip9n(await readFile(join(packagingDir, `${APP_NAME}.1`))), join(root, 'usr', 'share', 'man', 'man1', `${APP_NAME}.1.gz`));

  let overrides = await readFile(join(packagingDir, 'lintian-overrides'), 'utf8');
  if (maintainer.placeholder) {
    overrides +=
      '# No DEBEMAIL at build time: the maintainer is the placeholder of scripts/package-deb.mjs. The package is a\n' +
      '# personal build that is never uploaded, so it deliberately names no reachable person.\n' +
      `${APP_NAME}: bogus-mail-host Maintainer ${maintainer.email}\n` +
      `${APP_NAME}: bogus-mail-host-in-debian-changelog ${maintainer.email} *\n`;
  }
  await placeData(overrides, join(root, 'usr', 'share', 'lintian', 'overrides', APP_NAME));

  const icons = [];
  for (const name of ['favicon.png', 'favicon_16x16.png', 'favicon_24x24.png']) {
    const src = join(appDir, 'resources', name);
    if (!existsSync(src)) continue;
    const size = pngSize(await readFile(src));
    if (!size || size.width !== size.height || !HICOLOR_SIZES.has(size.width)) continue;
    const dest = join(root, 'usr', 'share', 'icons', 'hicolor', `${size.width}x${size.height}`, 'apps', `${APP_NAME}.png`);
    if (existsSync(dest)) continue;
    await place(src, dest);
    icons.push(`${size.width}x${size.height}`);
  }
  if (icons.length === 0) log('warning: no vendor icon found for the hicolor theme (run npm run import-ui)');

  let kib = 0;
  await walk(root, async (p, _rel, entry) => {
    if (entry.isFile()) kib += Math.ceil((await lstat(p)).size / 1024);
    return true;
  });
  const control = (await readFile(join(packagingDir, 'control.in'), 'utf8'))
    .replace('@VERSION@', version)
    .replace('@MAINTAINER@', `${maintainer.name} <${maintainer.email}>`)
    .replace('@INSTALLED_SIZE@', String(kib));
  await checkSharedLibraries(root, control);

  const sums = await md5sums(root);
  const debian = join(root, 'DEBIAN');
  await mkdir(debian, { recursive: true });
  await writeFile(join(debian, 'control'), control);
  await chmod(join(debian, 'control'), 0o644);
  await writeFile(join(debian, 'md5sums'), sums);
  await chmod(join(debian, 'md5sums'), 0o644);
  await place(join(packagingDir, 'postinst'), join(debian, 'postinst'), 0o755);
  await place(join(packagingDir, 'postrm'), join(debian, 'postrm'), 0o755);
  await walk(root, async (p, _rel, entry) => {
    if (entry.isDirectory()) await chmod(p, 0o755);
    return true;
  });
  log(`deb tree ready (${kib} KiB installed, icons: ${icons.join(', ') || 'none'})`);
  return { root, control };
}

async function main() {
  const maintainer = maintainerFromEnv(process.env);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const { stageDir, version } = await stage();
  const zip = await electronZip();
  const appPath = await runPackager(stageDir, version, zip);
  const { root, control } = await debTree(appPath, version, maintainer);
  const deb = join(outDir, `${APP_NAME}_${version}_amd64.deb`);
  execFileSync('fakeroot', ['dpkg-deb', '-Zxz', '--build', root, deb], { stdio: 'inherit' });
  // The staging trees are several hundred MB; they are kept only when a step failed.
  await rm(work, { recursive: true, force: true });
  const size = (await stat(deb)).size;
  log(`maintainer: ${maintainer.name} <${maintainer.email}>${maintainer.placeholder ? ' (placeholder: DEBEMAIL unset)' : ''}`);
  log(`depends: ${/^Depends: (.*)$/m.exec(control)?.[1]}`);
  log(`wrote ${relative(portDir, deb)} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
}

main().catch((e) => {
  console.error(`dist:deb: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
