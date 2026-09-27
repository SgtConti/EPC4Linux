// Install test, "deps" phase (test/install/in-container.sh): run in the clean container right after
// "apt-get install --no-install-recommends ./pkg.deb", before any test tool is installed, by the package's
// own runtime: a copy of its executable with the RunAsNode fuse back on (the package ships it off;
// in-container.sh node_runtime), otherwise byte-identical and next to the package's own files:
//
//   ELECTRON_RUN_AS_NODE=1 /tmp/electron-as-node/electron shlibs-check.mjs
//
// 1. For every ELF file of the package, the direct DT_NEEDED sonames (parsed here: no binutils in a clean
//    image) are either shipped in the package or resolved by ldconfig to a file whose owning package
//    (dpkg -S) is named in Depends. The base image already has some of them (libc6, libgcc-s1,
//    libstdc++6, libudev1), so "ldd finds it" alone would not prove the declaration.
// 2. The native addons load the way the app loads them (through app.asar, redirected to app.asar.unpacked):
//    usb (libusb static, libudev dynamic) and koffi, which then opens libc through its FFI.
// Exit status 1 on any failure.

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';

const PKG = 'evnia-precision-center';
const APP_DIR = `/opt/${PKG}`;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const DT_NEEDED = 1n;
const DT_STRTAB = 5n;

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, offset);
  return buf.subarray(0, n);
}

/** DT_NEEDED entries of an x86-64 ELF (little-endian ELF64), or null when the file is not ELF64. */
function neededOf(path) {
  const fd = openSync(path, 'r');
  try {
    const eh = readAt(fd, 0, 64);
    if (eh.length < 64 || eh.readUInt32BE(0) !== 0x7f454c46 || eh[4] !== 2 || eh[5] !== 1) return null;
    const phoff = Number(eh.readBigUInt64LE(0x20));
    const phentsize = eh.readUInt16LE(0x36);
    const phnum = eh.readUInt16LE(0x38);
    const ph = readAt(fd, phoff, phentsize * phnum);
    const loads = [];
    let dyn = null;
    for (let i = 0; i < phnum; i++) {
      const o = i * phentsize;
      const type = ph.readUInt32LE(o);
      const seg = { offset: Number(ph.readBigUInt64LE(o + 8)), vaddr: Number(ph.readBigUInt64LE(o + 16)), filesz: Number(ph.readBigUInt64LE(o + 32)) };
      if (type === PT_LOAD) loads.push(seg);
      else if (type === PT_DYNAMIC) dyn = seg;
    }
    if (!dyn) return [];
    const d = readAt(fd, dyn.offset, dyn.filesz);
    const needed = [];
    let strtab = null;
    for (let o = 0; o + 16 <= d.length; o += 16) {
      const tag = d.readBigInt64LE(o);
      const val = d.readBigUInt64LE(o + 8);
      if (tag === 0n) break;
      if (tag === DT_NEEDED) needed.push(Number(val));
      else if (tag === DT_STRTAB) strtab = Number(val);
    }
    if (strtab === null) throw new Error('DT_STRTAB missing');
    const seg = loads.find((s) => strtab >= s.vaddr && strtab < s.vaddr + s.filesz);
    if (!seg) throw new Error('DT_STRTAB outside the PT_LOAD segments');
    const strOff = strtab - seg.vaddr + seg.offset;
    return needed.map((off) => {
      const s = readAt(fd, strOff + off, 256);
      return s.toString('latin1', 0, s.indexOf(0));
    });
  } finally {
    closeSync(fd);
  }
}

/** Depends as a set of package names (every alternative, no versions). */
function dependsNames() {
  const field = execFileSync('dpkg-query', ['-W', '-f=${Depends}', PKG], { encoding: 'utf8' });
  return new Set(field.split(/[,|]/).map((a) => a.trim().split(/[\s(]/)[0]).filter(Boolean));
}

/** soname → path for this architecture, from the dynamic linker cache. */
function ldconfigMap() {
  const map = new Map();
  for (const line of execFileSync('ldconfig', ['-p'], { encoding: 'utf8' }).split('\n')) {
    const m = /^\s+(\S+) \(([^)]*)\) => (\S+)$/.exec(line);
    if (m && m[2].includes('x86-64') && !map.has(m[1])) map.set(m[1], m[3]);
  }
  return map;
}

/** Owning package of a library file; tries the merged-/usr aliases dpkg may have registered instead. */
function owner(path) {
  const candidates = new Set([path]);
  try {
    candidates.add(realpathSync(path));
  } catch {}
  for (const p of [...candidates]) {
    if (p.startsWith('/usr/lib/')) candidates.add(p.slice(4));
    else if (p.startsWith('/lib/')) candidates.add(`/usr${p}`);
  }
  for (const p of candidates) {
    try {
      const out = execFileSync('dpkg', ['-S', p], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.split('\n')[0].split(':')[0].trim();
    } catch {}
  }
  return null;
}

let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`FAIL ${msg}`);
};

// Electron's fs treats app.asar as a directory; the scan reads the package's files as they are on disk.
process.noAsar = true;
const files = execFileSync('dpkg', ['-L', PKG], { encoding: 'utf8' }).split('\n').filter((p) => p.startsWith(`${APP_DIR}/`));
const shipped = new Set(files.map((p) => basename(p)));
const depends = dependsNames();
const libs = ldconfigMap();
const providers = new Map();
let elfs = 0;
for (const file of files) {
  let needed;
  try {
    needed = neededOf(file);
  } catch (e) {
    if (e.code === 'EISDIR') continue;
    fail(`${file}: ${e.message}`);
    continue;
  }
  if (!needed) continue;
  elfs++;
  for (const soname of needed) {
    if (shipped.has(soname)) {
      providers.set(soname, '(shipped in the package)');
      continue;
    }
    const path = libs.get(soname);
    const pkg = path ? owner(path) : null;
    if (!path) fail(`${file}: ${soname} is not in the ldconfig cache`);
    else if (!pkg) fail(`${file}: ${soname} (${path}) belongs to no package`);
    else if (!depends.has(pkg)) fail(`${file}: ${soname} comes from ${pkg}, which Depends does not name`);
    providers.set(soname, pkg ?? '?');
  }
}
console.log(`${elfs} ELF files; direct NEEDED libraries and their packages:`);
for (const [soname, pkg] of [...providers].sort()) console.log(`  ${soname.padEnd(26)} ${pkg}`);

// The native addons, loaded like the app loads them (asar support back on).
process.noAsar = false;
const require = createRequire(`${APP_DIR}/resources/app.asar/main.cjs`);
for (const [name, probe] of [
  ['usb', (m) => `getDeviceList() -> ${m.getDeviceList().length} devices (none in a container)`],
  ['koffi', (m) => `load("libc.so.6").getpid() = ${m.load('libc.so.6').func('int getpid()')()}`],
]) {
  try {
    const m = require(name);
    let detail;
    try {
      detail = probe(m);
    } catch (e) {
      // Loaded and linked; a runtime error of the probe (no USB in a container) is not a packaging defect.
      detail = `loaded; probe: ${e.message}`;
    }
    console.log(`ok   ${name}: ${detail}`);
  } catch (e) {
    fail(`${name} does not load: ${e.message}`);
  }
}

console.log(failed ? 'RESULT: FAIL' : 'RESULT: ok');
process.exitCode = failed ? 1 : 0;
