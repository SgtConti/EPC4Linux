// .deb packaging assets (packaging/deb) and the build scripts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeFuses, FUSE, FUSE_SENTINEL, fuseState, PACKAGED_FUSES, readFuseWire, setFuses } from '../../../scripts/lib/fuses.ts';
import { IGNORED_ADAPTER_PREFIXES, isIgnoredI2cAdapter } from '../../../src/backend/ddc/discovery.ts';
import { MOCK_34M2C8600 } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { USER_34M2C8600, USER_ENE_SERIAL, USER_MONITOR_SERIAL } from '../../fixtures/user-monitor.ts';

const PORT = join(import.meta.dirname, '..', '..', '..');
const deb = (f: string) => readFileSync(join(PORT, 'packaging', 'deb', f), 'utf8');
const rules = () => deb('70-evnia-precision-center.rules').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

test('udev: uaccess for exactly the VIA DDC bridge and the ENE Ambiglow MCU, not all of VIA Labs', () => {
  const usb = rules().filter((l) => l.includes('SUBSYSTEM=="usb"'));
  assert.deepEqual(
    usb.map((l) => /idVendor}=="(\w+)".*idProduct}=="(\w+)"/.exec(l)?.slice(1).join(':')),
    ['2109:8884', '0cf2:a201'],
  );
  for (const l of usb) {
    assert.match(l, /ENV\{DEVTYPE\}=="usb_device"/);
    assert.match(l, /, TAG\+="uaccess"(, |$)/);
  }
  assert.ok(!rules().some((l) => /idVendor}=="2109"/.test(l) && !/idProduct}=="8884"/.test(l)), 'no 2109:* wildcard');
  assert.ok(!rules().some((l) => /MODE=|GROUP=/.test(l)), 'no world/group permissions, uaccess only');
});

test('udev: the VIA DDC bridge is kept out of USB autosuspend (20-consolidation §2.9, 08 §8.5)', () => {
  const [via, ene] = rules().filter((l) => l.includes('SUBSYSTEM=="usb"'));
  assert.equal(
    via,
    'SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="2109", ATTR{idProduct}=="8884", TAG+="uaccess", ATTR{power/control}="on"',
  );
  assert.doesNotMatch(ene, /power\/control/, 'the ENE rule is as specified');
});

test('udev: i2c-dev nodes of display adapters only (ddcutil approach)', () => {
  const i2c = rules().filter((l) => l.includes('SUBSYSTEM=="i2c-dev"'));
  assert.deepEqual(i2c.map((l) => /ATTRS\{class\}=="(0x\w+)"/.exec(l)?.[1]), ['0x030000', '0x038000']);
  for (const l of i2c) assert.match(l, /KERNEL=="i2c-\[0-9\]\*".*TAG\+="uaccess"$/);
});

/** udev's fnmatch-style pattern (`*`, `?`, `[…]`) as an anchored RegExp. */
function udevGlob(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      re += pattern.slice(i, end + 1);
      i = end;
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

test('udev: no seat access to the GPU adapters the backend never probes (AMDGPU SMU, SMBus, … — 20 §2.3 step 3c)', () => {
  const i2c = rules().filter((l) => l.includes('SUBSYSTEM=="i2c-dev"'));
  assert.equal(i2c.length, 2);
  for (const l of i2c) {
    const m = /ATTR\{name\}!="([^"]+)"/.exec(l);
    assert.ok(m, `${l}: excludes adapters by name`);
    const excluded = m[1].split('|').map(udevGlob);
    const isExcluded = (name: string) => excluded.some((re) => re.test(name));
    // Kept in sync with the backend's list (discovery.ts isIgnoredI2cAdapter): every ignored adapter is excluded …
    for (const prefix of IGNORED_ADAPTER_PREFIXES) {
      for (const name of [prefix, `${prefix} 0`, `${prefix}-x`]) {
        assert.equal(isIgnoredI2cAdapter(name), true, name);
        assert.ok(isExcluded(name), `${name} must stay root-only`);
      }
    }
    for (const name of ['AMDGPU SMU 0', 'AMDGPU SMU 1', 'SMBus PIIX4 adapter port 0 at 0b00', 'NVIDIA i2c smbus adapter', 'nvkm-0000:01:00.0-SMBUS']) {
      assert.equal(isIgnoredI2cAdapter(name), true, name);
      assert.ok(isExcluded(name), `${name} must stay root-only`);
    }
    // … and the display buses stay available (amdgpu DC, i915, nouveau, radeon).
    for (const name of ['AMDGPU DM i2c hw bus 0', 'AMDGPU DM aux hw bus 2', 'i915 gmbus dpb', 'DPDDC-B', 'nvkm-0000:01:00.0-bus-0005', 'radeon i2c bit bus 0x90']) {
      assert.equal(isIgnoredI2cAdapter(name), false, name);
      assert.ok(!isExcluded(name), `${name} is a display bus`);
    }
  }
});

test('udev rules run before 73-seat-late (uaccess) and parse', { skip: !has('udevadm') && 'udevadm not installed' }, () => {
  const r = spawnSync('udevadm', ['verify', join(PORT, 'packaging', 'deb', '70-evnia-precision-center.rules')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('modules-load.d loads i2c-dev', () => {
  assert.ok(deb('evnia-precision-center-i2c.conf').split('\n').includes('i2c-dev'));
});

test('control: required runtime dependencies and recommendations', () => {
  const control = deb('control.in');
  // Clauses as package names (version constraints dropped); scripts/package-deb.mjs checks them against the
  // NEEDED sonames of the shipped ELF files at build time.
  const clauses = (field: string) =>
    new RegExp(`^${field}: (.*)$`, 'm').exec(control)![1].split(', ').map((c) => c.split(' | ').map((a) => a.split(' ')[0]).join(' | '));
  const depends = clauses('Depends');
  for (const d of ['libc6', 'libgtk-3-0t64 | libgtk-3-0', 'libnss3', 'libasound2t64 | libasound2', 'libgbm1', 'libudev1', 'libstdc++6']) {
    assert.ok(depends.includes(d), d);
  }
  assert.match(control, /^Depends: .*\blibc6 \(>= [\d.]+\)/m, 'versioned libc6 (lintian missing-dependency-on-libc)');
  const recommends = clauses('Recommends');
  assert.ok(recommends.includes('xdg-desktop-portal') && recommends.includes('x11-utils'));
  assert.ok(recommends.includes('pulseaudio-utils'), 'parec records the sink monitor for follow-audio');
  assert.match(control, /^Package: evnia-precision-center$/m);
  assert.match(control, /^Architecture: amd64$/m);
});

test('maintainer scripts: setuid sandbox, i2c-dev, udev reload/trigger; valid sh', () => {
  const postinst = deb('postinst');
  assert.match(postinst, /chown root:root "\$APP_DIR\/chrome-sandbox"/);
  assert.match(postinst, /chmod 4755 "\$APP_DIR\/chrome-sandbox"/);
  assert.match(postinst, /modprobe i2c-dev .*\|\| true/);
  assert.match(postinst, /udevadm control --reload-rules/);
  assert.match(postinst, /udevadm trigger .*--subsystem-match=usb --attr-match=idVendor=2109 --attr-match=idProduct=8884/);
  assert.match(postinst, /udevadm trigger .*--subsystem-match=i2c-dev/);
  assert.match(deb('postrm'), /udevadm control --reload-rules/);
  for (const f of ['postinst', 'postrm']) {
    assert.ok(!deb(f).includes('\r'), `${f} must use LF line endings`);
    const r = spawnSync('sh', ['-n', join(PORT, 'packaging', 'deb', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

test('desktop entry is valid', { skip: !has('desktop-file-validate') && 'desktop-file-utils not installed' }, () => {
  const r = spawnSync('desktop-file-validate', [join(PORT, 'packaging', 'deb', 'evnia-precision-center.desktop')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(deb('evnia-precision-center.desktop'), /^Exec=evnia-precision-center$/m);
});

test('desktop entry StartupWMClass is the WM_CLASS Electron 44 derives from desktopName; user docs state the VCP 0x04 resets', () => {
  // Electron sets the X11 WM_CLASS (and the Wayland app_id) of its windows from package.json desktopName
  // (scripts/build.mjs); test/install/launch-check.mjs checks the running windows.
  const desktopName = /desktopName: '([^']+)\.desktop'/.exec(readFileSync(join(PORT, 'scripts', 'build.mjs'), 'utf8'))?.[1];
  assert.equal(/^StartupWMClass=(.*)$/m.exec(deb('evnia-precision-center.desktop'))?.[1], desktopName);
  // Binding decision (impl-integration §5): Reset and Factory reset also restore the monitor (VCP 0x04 = 1).
  for (const doc of ['README.Debian', 'evnia-precision-center.1', 'control.in']) assert.match(deb(doc), /VCP 0x04/, doc);
});

test('build and packaging scripts parse', () => {
  for (const f of ['build.mjs', 'package-deb.mjs']) {
    const r = spawnSync(process.execPath, ['--check', join(PORT, 'scripts', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
});

const ELECTRON_BINARY = join(PORT, 'node_modules', 'electron', 'dist', 'electron');

test('fuses: the packaged executable cannot be used as Node (RunAsNode, NODE_OPTIONS, --inspect off; file: privileges kept)', { skip: !existsSync(ELECTRON_BINARY) && 'Electron not installed' }, () => {
  // The Electron that scripts/package-deb.mjs packages: its default wire, then what hardenFuses writes.
  const original = readFileSync(ELECTRON_BINARY);
  const before = readFuseWire(original);
  assert.equal(before.version, 1);
  assert.ok(before.fuses.length > FUSE.GrantFileProtocolExtraPrivileges, `${before.fuses.length} fuses`);
  assert.equal(fuseState(before, 'RunAsNode'), true, 'Electron default: ELECTRON_RUN_AS_NODE works');
  assert.equal(fuseState(before, 'EnableNodeOptionsEnvironmentVariable'), true);
  assert.equal(fuseState(before, 'EnableNodeCliInspectArguments'), true);
  const packaged = Buffer.from(original);
  const after = setFuses(packaged, PACKAGED_FUSES);
  assert.deepEqual(readFuseWire(packaged), after, 'read back from the written bytes');
  assert.equal(fuseState(after, 'RunAsNode'), false);
  assert.equal(fuseState(after, 'EnableNodeOptionsEnvironmentVariable'), false);
  assert.equal(fuseState(after, 'EnableNodeCliInspectArguments'), false);
  // The vendor UI's file:// module scripts need it; network-guard.ts confines file: to the app tree.
  assert.equal(fuseState(after, 'GrantFileProtocolExtraPrivileges'), true);
  // Nothing else of the executable changes: exactly the three fuse bytes.
  const changed: number[] = [];
  for (let i = 0; i < original.length; i++) if (original[i] !== packaged[i]) changed.push(i - before.offset - FUSE_SENTINEL.length - 2);
  assert.deepEqual(changed, [FUSE.RunAsNode, FUSE.EnableNodeOptionsEnvironmentVariable, FUSE.EnableNodeCliInspectArguments]);
  // package-deb.mjs applies them to the packaged executable right after the packager.
  const script = readFileSync(join(PORT, 'scripts', 'package-deb.mjs'), 'utf8');
  assert.match(script, /await hardenFuses\(join\(appPath, APP_NAME\)\)/);
  assert.match(script, /setFuses\(binary, PACKAGED_FUSES\)/);
});

test('fuses: the wire parser refuses what it does not understand', () => {
  const wire = (version: number, fuses: string) => Buffer.concat([Buffer.from('ELF…'), Buffer.from(FUSE_SENTINEL), Buffer.from([version, fuses.length]), Buffer.from(fuses), Buffer.from('…')]);
  assert.deepEqual(readFuseWire(wire(1, '101100011')).fuses, [...'101100011']);
  assert.throws(() => readFuseWire(Buffer.from('no wire here')), /sentinel not found/);
  assert.throws(() => readFuseWire(wire(2, '1011')), /version 2/);
  assert.throws(() => readFuseWire(Buffer.concat([wire(1, '1'), wire(1, '1')])), /more than once/);
  assert.throws(() => readFuseWire(wire(1, '1x')), /invalid fuse state/);
  assert.throws(() => setFuses(wire(1, 'r011'), { RunAsNode: false }), /removed/);
  assert.throws(() => setFuses(wire(1, '1011'), { GrantFileProtocolExtraPrivileges: true }), /not in this Electron's wire/);
  const b = wire(1, '10110001');
  assert.equal(describeFuses(setFuses(b, { RunAsNode: false })), 'RunAsNode=0 EnableCookieEncryption=0 EnableNodeOptionsEnvironmentVariable=1 EnableNodeCliInspectArguments=1 EnableEmbeddedAsarIntegrityValidation=0 OnlyLoadAppFromAsar=0 LoadBrowserProcessSpecificV8Snapshot=0 GrantFileProtocolExtraPrivileges=1');
});

test('privacy: nothing that ships (sources of the bundles, scripts, packaging, the built app) carries the fixtures\' unit identifiers', () => {
  // The simulated monitor and ENE are part of the product (EVNIA_MOCK_MONITOR); their identities are synthetic.
  // The identity of the captured unit (anonymized by tools/sanitize-public.py) lives in test/fixtures only
  // (user-monitor.ts, windows/) and is never compiled into the product.
  const needles = [...new Set([
    USER_MONITOR_SERIAL,
    Buffer.from(USER_MONITOR_SERIAL, 'latin1').toString('hex').toUpperCase(), // inside an EDID hex string
    Buffer.from(USER_MONITOR_SERIAL, 'latin1').toString('hex'),
    USER_ENE_SERIAL, // the ENE MCU's USB serial (logs/EvniaServe-2026-09-25.txt:31)
  ])];
  const roots = ['src', 'scripts', 'packaging', join('build', 'app')].map((d) => join(PORT, d)).filter((d) => existsSync(d));
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== 'vendor-ui' && e.name !== 'resources') walk(p);
      } else if (/\.(ts|mjs|cjs|js|json|html|css|rules|in|desktop|1|conf)$|^(postinst|postrm|copyright|README\.Debian|lintian-overrides)$/.test(e.name)) {
        const text = readFileSync(p, 'latin1');
        for (const n of needles) if (text.includes(n)) offenders.push(`${p.slice(PORT.length + 1)}: ${n}`);
      }
    }
  };
  for (const r of roots) walk(r);
  assert.deepEqual(offenders, [], 'rebuild (npm run build) if only build/app is listed');
  assert.notEqual(MOCK_34M2C8600.identity.serialNumber, USER_MONITOR_SERIAL);
  assert.notEqual(MOCK_34M2C8600.edidHex, USER_34M2C8600.edidHex);
});
