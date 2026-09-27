import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UsbBackend } from '../../../src/backend/types.ts';
import { FakeUsbBackend } from '../../../src/backend/usb/fake-backend.ts';
import { DdcChannelImpl, NO_DELAY_TIMINGS } from '../../../src/backend/ddc/channel.ts';
import { discoverMonitors, isIgnoredI2cAdapter, modelMatchesEdid, scanDrmConnectors } from '../../../src/backend/ddc/discovery.ts';
import type { I2cSyscalls } from '../../../src/backend/ddc/transports/i2cdev.ts';
import type { MockMonitorSpec } from '../../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { USER_34M2C8600 } from '../../fixtures/user-monitor.ts';
import {
  SimulatedMonitor,
  createMockI2cSyscalls,
  mockViaDeviceSpec,
  writeMockSysfs,
} from '../../../src/backend/ddc/transports/mock.ts';
import { realEdid } from './helpers.ts';

/** EDID variant: descriptor texts replaced (13 chars, LF-terminated) and/or another manufacturer. */
function edidVariant(opts: { serial?: string; name?: string; mfg?: [number, number] }): string {
  const e = realEdid();
  const put = (at: number, text: string) => {
    const b = Buffer.from(`${text}\n`.padEnd(13, ' ').slice(0, 13), 'latin1');
    e.set(b, at);
  };
  if (opts.serial) put(77, opts.serial); // 0xFF descriptor text (descriptor 2 at 72)
  if (opts.name) put(95, opts.name); // 0xFC descriptor text (descriptor 3 at 90)
  if (opts.mfg) [e[8], e[9]] = opts.mfg;
  return Buffer.from(e).toString('hex');
}

function monitorWith(overrides: Partial<MockMonitorSpec>): SimulatedMonitor {
  return new SimulatedMonitor({ ...USER_34M2C8600, ...overrides, identity: { ...USER_34M2C8600.identity, ...overrides.identity } });
}

/** Wrap syscalls to record which device nodes were opened. */
function recordingI2c(inner: I2cSyscalls, opened: string[]): I2cSyscalls {
  return { ...inner, open: (p) => (opened.push(p), inner.open(p)) };
}

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'sysfs-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const opts = { devRoot: '/dev', channel: { timings: NO_DELAY_TIMINGS, processLock: null } };

test('ddc link + VIA bridge: one monitor, USB-DDC first, keyed by the EDID serial', () =>
  withRoot(async (root) => {
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    const usb = new FakeUsbBackend();
    const via = usb.attach(mockViaDeviceSpec(monitor));
    await writeMockSysfs(root, monitor, {}, [via]);
    const connectors = await scanDrmConnectors(root);
    assert.deepEqual(connectors.map((c) => [c.name, c.status, c.bus]), [['card1-DP-1', 'connected', { number: 5, source: 'ddc-link' }]]);
    const found = await discoverMonitors({ ...opts, sysfsRoot: root, usb, i2c: createMockI2cSyscalls({ '/dev/i2c-5': monitor }) });
    assert.equal(found.length, 1);
    assert.equal(found[0].key, 'AU00000000001');
    assert.equal(found[0].connector, 'card1-DP-1');
    assert.equal(found[0].edid?.monitorName, 'PHL 34M2C8600');
    assert.deepEqual(found[0].transports.map((t) => t.id), ['via:usb:3-2.4', 'i2c:/dev/i2c-5']);
    // Read-only identification in the vendor order: C8, model name, USB-DDC probe, factory SN (20 §2.3).
    const writes = usb.transfers.filter((t) => t.direction === 'out').map((t) => Buffer.from(t.data).toString('hex'));
    assert.deepEqual(writes, ['6e518201c874', '6e518601fee90d0000a2', '6e51820114a8', '6e518601feef1300209a']);
    for (const t of found[0].transports) await t.close();
  }));

test('AUX child adapter, and EDID matching on the GPU buses when there is no link (07 §8.2)', () =>
  withRoot(async (root) => {
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    await writeMockSysfs(root, monitor, { link: 'aux', auxBus: 7 });
    assert.deepEqual((await scanDrmConnectors(root))[0].bus, { number: 7, source: 'aux-child' });
  }).then(() =>
    withRoot(async (root) => {
      const monitor = new SimulatedMonitor(USER_34M2C8600);
      await writeMockSysfs(root, monitor, { link: 'none', bus: 5 });
      // More adapters under the GPU: one without a device node, and two that are never opened: an SMBus
      // controller and the AMDGPU SMU bus (RAS/FRU EEPROM at 0x50, firmware controller).
      const gpu = join(root, 'devices/pci0000:00/0000:03:00.0');
      for (const [n, name] of [[4, 'AMDGPU DM i2c hw bus 0'], [9, 'SMBus PIIX4 adapter'], [3, 'AMDGPU SMU 0']] as const) {
        await mkdir(join(gpu, `i2c-${n}`), { recursive: true });
        await writeFile(join(gpu, `i2c-${n}`, 'name'), `${name}\n`);
        await symlink(join(gpu, `i2c-${n}`), join(root, 'bus/i2c/devices', `i2c-${n}`));
      }
      const opened: string[] = [];
      const i2c = recordingI2c(createMockI2cSyscalls({ '/dev/i2c-5': monitor }), opened);
      const found = await discoverMonitors({ ...opts, sysfsRoot: root, i2c });
      assert.deepEqual(found[0].transports.map((t) => t.id), ['i2c:/dev/i2c-5']);
      assert.deepEqual(opened, ['/dev/i2c-4', '/dev/i2c-5']);
      assert.deepEqual(['AMDGPU SMU', 'SMBus I801 adapter at efa0', 'NVIDIA i2c adapter 1 at 1:00.0', 'AMDGPU DM aux hw bus 2'].map(isIgnoredI2cAdapter), [true, true, false, false]);
      const noProbe = await discoverMonitors({ ...opts, sysfsRoot: root, i2c, probeUnlinkedBuses: false });
      assert.deepEqual(noProbe[0].transports, []);
      // Only adapters below a display-class PCI device are ever probed.
      await writeFile(join(gpu, 'class'), '0x0c0500\n');
      opened.length = 0;
      const notGpu = await discoverMonitors({ ...opts, sysfsRoot: root, i2c });
      assert.deepEqual([notGpu[0].transports, opened], [[], []]);
    }),
  ));

test('DisplayPort connectors use the AUX child adapter before the ddc link; others the link first (20 R6)', () =>
  withRoot(async (root) => {
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    await writeMockSysfs(root, monitor, { connector: 'DP-1', link: 'both', bus: 5, auxBus: 6 });
    await writeMockSysfs(root, monitor, { connector: 'HDMI-A-1', link: 'both', bus: 7, auxBus: 8 });
    const buses = (await scanDrmConnectors(root)).map((c) => [c.name, c.bus]);
    assert.deepEqual(buses, [
      ['card1-DP-1', { number: 6, source: 'aux-child' }],
      ['card1-HDMI-A-1', { number: 7, source: 'ddc-link' }],
    ]);
  }));

test('bridge identification: unknown scaler ignored, model whitelist, SN tie-break, SN cross-check (20 §2.3, D6)', () =>
  withRoot(async (root) => {
    const warnings: string[] = [];
    const log = { debug() {}, info() {}, warn: (m: unknown) => warnings.push(String(m)), error() {}, child() { return log; } };
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    const twin = monitorWith({ edidHex: edidVariant({ serial: 'AU00000009999' }) }); // same model name
    await writeMockSysfs(root, twin, { connector: 'DP-1', bus: 5 });
    await writeMockSysfs(root, monitor, { connector: 'DP-2', bus: 6 });
    const i2c = createMockI2cSyscalls({});

    // Two displays match "34M2C8600": the factory SN picks DP-2.
    const usb = new FakeUsbBackend();
    await writeMockSysfs(root, monitor, { connector: 'DP-2', bus: 6 }, [usb.attach(mockViaDeviceSpec(monitor))]);
    const found = await discoverMonitors({ ...opts, sysfsRoot: root, usb, i2c, log });
    assert.deepEqual(found.map((m) => [m.connector, m.transports[0].kind]), [['card1-DP-1', 'i2c-dev'], ['card1-DP-2', 'via-usb']]);

    // A factory SN that matches neither leaves the bridge unpaired.
    const stranger = new FakeUsbBackend();
    stranger.attach(mockViaDeviceSpec(monitorWith({ identity: { ...USER_34M2C8600.identity, serialNumber: 'XX00000000000' } })));
    const unpaired = await discoverMonitors({ ...opts, sysfsRoot: root, usb: stranger, i2c, log });
    assert.ok(unpaired.every((m) => m.transports.every((t) => t.kind === 'i2c-dev')));
    assert.ok(warnings.some((w) => w.includes('matches 2 displays')));

    // The model whitelist (MonitorInfo.json) is applied before any bus traffic.
    const whitelisted = await discoverMonitors({ ...opts, sysfsRoot: root, i2c, supportsModel: (name) => name === 'PHL 27M2N5500' });
    assert.deepEqual(whitelisted, []);
    assert.equal((await discoverMonitors({ ...opts, sysfsRoot: root, i2c, supportsModel: (name) => name === 'PHL 34M2C8600' })).length, 2);

    // A bridge whose scaler id is unknown is never paired (GetMonitorInfo needs a known scaler).
    const odd = new FakeUsbBackend();
    const oddVcp = USER_34M2C8600.vcp.map(([c, v, m]) => (c === 0xc8 ? [c, 0x33, m] : [c, v, m]) as [number, number, number]);
    odd.attach(mockViaDeviceSpec(monitorWith({ vcp: oddVcp })));
    const noPair = await discoverMonitors({ ...opts, sysfsRoot: root, usb: odd, i2c });
    assert.ok(noPair.every((m) => m.transports.every((t) => t.kind === 'i2c-dev')));
    assert.equal(odd.transfers.filter((t) => t.direction === 'out').length, 1); // only the C8 query
  }));

test('factory SN different from the EDID serial: paired, keyed by the EDID serial, warning logged (D6)', () =>
  withRoot(async (root) => {
    const warnings: string[] = [];
    const log = { debug() {}, info() {}, warn: (m: unknown) => warnings.push(String(m)), error() {}, child() { return log; } };
    const monitor = monitorWith({ identity: { ...USER_34M2C8600.identity, serialNumber: 'AU00000005555' } });
    const usb = new FakeUsbBackend();
    await writeMockSysfs(root, monitor, {}, [usb.attach(mockViaDeviceSpec(monitor))]);
    const found = await discoverMonitors({ ...opts, sysfsRoot: root, usb, i2c: createMockI2cSyscalls({}), log });
    assert.equal(found[0].key, 'AU00000000001');
    assert.equal(found[0].transports[0].kind, 'via-usb');
    assert.ok(warnings.some((w) => w.includes('factory SN "AU00000005555" differs')));
  }));

test('brand filter on the PnP id, disconnected connectors and serial merge', () =>
  withRoot(async (root) => {
    const phl = new SimulatedMonitor(USER_34M2C8600);
    const dell = monitorWith({ edidHex: edidVariant({ mfg: [0x10, 0xac], serial: 'DELL123456789', name: 'DELL U2723QE' }) });
    await writeMockSysfs(root, phl, { connector: 'DP-1', bus: 5 });
    await writeMockSysfs(root, phl, { connector: 'HDMI-A-1', bus: 6 }); // same monitor on a second input
    await writeMockSysfs(root, dell, { connector: 'DP-2', bus: 8 });
    await writeMockSysfs(root, phl, { connector: 'DP-3', bus: 10 });
    await writeFile(join(root, 'class/drm/card1-DP-3/status'), 'disconnected\n');
    const i2c = createMockI2cSyscalls({});
    const found = await discoverMonitors({ ...opts, sysfsRoot: root, i2c });
    assert.equal(found.length, 1);
    assert.equal(found[0].connector, 'card1-DP-1');
    assert.deepEqual(found[0].transports.map((t) => t.id), ['i2c:/dev/i2c-5', 'i2c:/dev/i2c-6']);
    const all = await discoverMonitors({ ...opts, sysfsRoot: root, i2c, brands: null });
    assert.deepEqual(all.map((m) => [m.key, m.edid?.manufacturer]), [['AU00000000001', 'PHL'], ['DELL123456789', 'DEL']]);
  }));

const silent = { controlIn: () => new Uint8Array(0), controlOut: () => undefined };

test('VIA hubs are never probed; bridges that fail the probe or match no display are dropped', () =>
  withRoot(async (root) => {
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    const usb = new FakeUsbBackend();
    // Even with the hub PIDs configured as bridges, hubs are recognised: by the descriptor class, else
    // by sysfs bDeviceClass, else by the known VIA hub PIDs.
    const viaProductIds = [0x8884, 0x2817, 0x0817, 0x0211];
    const hub = usb.attach({ vendorId: 0x2109, productId: 0x2817, deviceClass: 0x09, busNumber: 3, portNumbers: [2], handler: silent });
    const hub2 = usb.attach({ vendorId: 0x2109, productId: 0x0817, deviceClass: 0x09, busNumber: 4, portNumbers: [1], handler: silent });
    const hub3 = usb.attach({ vendorId: 0x2109, productId: 0x0211, deviceClass: 0x09, busNumber: 4, portNumbers: [2], handler: silent });
    const noDdc = usb.attach(mockViaDeviceSpec(monitorWith({ vcp: USER_34M2C8600.vcp.filter(([c]) => c !== 0x14) }), { portNumbers: [2, 5], deviceAddress: 8 }));
    const other = usb.attach(mockViaDeviceSpec(monitorWith({ identity: { ...USER_34M2C8600.identity, modelName: '27M2N5500' } }), { portNumbers: [2, 6], deviceAddress: 9 }));
    await writeMockSysfs(root, monitor, {}, [noDdc, other]);
    await mkdir(join(root, 'bus/usb/devices/4-1'), { recursive: true });
    await writeFile(join(root, 'bus/usb/devices/4-1/bDeviceClass'), '09\n');
    // A backend without descriptor classes (only UsbDeviceInfo): sysfs and the PID list decide.
    const classless: UsbBackend = {
      list: async (filter) => (await usb.list(filter)).map(({ vendorId, productId, busNumber, deviceAddress, id }) => ({ vendorId, productId, busNumber, deviceAddress, id })),
      open: (info) => usb.open(info),
      onChange: (cb) => usb.onChange(cb),
    };
    for (const backend of [usb, classless]) {
      usb.transfers.length = 0;
      const found = await discoverMonitors({ ...opts, sysfsRoot: root, usb: backend, i2c: createMockI2cSyscalls({}), viaProductIds });
      assert.deepEqual(found[0].transports.map((t) => t.kind), ['i2c-dev']);
      const touched = new Set(usb.transfers.map((t) => t.deviceId));
      assert.deepEqual([hub, hub2, hub3, noDdc, other].map((d) => touched.has(d.id)), [false, false, false, true, true]);
    }
  }));

test('only the known bridge PID gets DDC vendor requests unless others are configured (08 §4.1, WinUSB gate)', () =>
  withRoot(async (root) => {
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    const usb = new FakeUsbBackend();
    // A VIA billboard/PD function: B2/A3/A7 mean something else (or nothing) there.
    const billboard = usb.attach({ vendorId: 0x2109, productId: 0x0100, deviceClass: 0x11, busNumber: 3, portNumbers: [2, 3], handler: silent });
    const bridge = usb.attach(mockViaDeviceSpec(monitor, { productId: 0x8885 })); // e.g. another model's bridge
    await writeMockSysfs(root, monitor, {}, [bridge]);
    const i2c = createMockI2cSyscalls({});
    const found = await discoverMonitors({ ...opts, sysfsRoot: root, usb, i2c });
    assert.deepEqual(found[0].transports.map((t) => t.kind), ['i2c-dev']);
    assert.equal(usb.transfers.length, 0);
    const configured = await discoverMonitors({ ...opts, sysfsRoot: root, usb, i2c, viaProductIds: [0x8884, 0x8885] });
    assert.deepEqual(configured[0].transports.map((t) => t.id), ['via:usb:3-2.4', 'i2c:/dev/i2c-5']);
    assert.equal(usb.transfers.some((t) => t.deviceId === billboard.id), false);
    for (const t of configured[0].transports) await t.close();
  }));

test('a rescan while the driver polls: one queue per bridge path, no split request/reply (20 §2.3/§2.4)', () =>
  withRoot(async (root) => {
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    const usb = new FakeUsbBackend({ journalLimit: Infinity });
    const via = usb.attach(mockViaDeviceSpec(monitor));
    await writeMockSysfs(root, monitor, {}, [via]);
    const i2c = createMockI2cSyscalls({ '/dev/i2c-5': monitor });
    // Small real delays, so that without the shared queue the traffic would interleave.
    const timings = { ...NO_DELAY_TIMINGS, postWriteMs: 2, minPreReadMs: 1, getSleepMs: 3, querySleepMs: 3, postReadMs: 1 };
    const scan = { ...opts, sysfsRoot: root, usb, i2c, channel: { timings, processLock: null } };
    const [first] = await discoverMonitors(scan);
    const driver = new DdcChannelImpl(first.transports, { timings, processLock: null, monitorKey: first.key });
    await driver.probe();
    await driver.setExt(0x19, 3); // Ambiglow mode: a value no identification reply carries
    usb.transfers.length = 0;
    const poll = async () => {
      const out = [];
      for (let i = 0; i < 12; i++) out.push(await driver.getVcp(0x10), await driver.getExt(0x19));
      return out;
    };
    const [values, again, twice] = await Promise.all([poll(), discoverMonitors(scan), discoverMonitors(scan)]);
    for (let i = 0; i < values.length; i += 2) {
      assert.deepEqual(values[i], { value: 0x64, max: 0x64, resultCode: 0 });
      assert.deepEqual(values[i + 1], { value: 0x03, max: 0x07, resultCode: 0 });
    }
    // Every request is followed by its own reply: W R W R ... on the one bridge.
    const dirs = usb.transfers.map((t) => (t.direction === 'out' ? 'W' : 'R')).join('');
    assert.match(dirs, /^(WR)+$/);
    assert.equal(dirs.length, 2 * (24 + 2 * 4)); // 24 polls + two rescans × (C8, ModelName, 0x14 probe, SN)
    for (const m of [again[0], twice[0]]) {
      assert.deepEqual(m.transports.map((t) => t.id), ['via:usb:3-2.4', 'i2c:/dev/i2c-5']);
      for (const t of m.transports) await t.close();
    }
    await driver.close();
  }));

test('ModelName pairing: exact name first, then the loose prefix rule (08 §3.7)', () =>
  withRoot(async (root) => {
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    const near = monitorWith({ edidHex: edidVariant({ serial: 'AU00000009999', name: 'PHL 34M2C860' }) });
    await writeMockSysfs(root, near, { connector: 'DP-1', bus: 5 });
    await writeMockSysfs(root, monitor, { connector: 'DP-2', bus: 6 });
    const usb = new FakeUsbBackend();
    const via = usb.attach(mockViaDeviceSpec(monitor));
    await writeMockSysfs(root, monitor, { connector: 'DP-2', bus: 6 }, [via]);
    const found = await discoverMonitors({ ...opts, sysfsRoot: root, usb, i2c: createMockI2cSyscalls({}) });
    assert.deepEqual(found.map((m) => [m.connector, m.transports[0].kind]), [['card1-DP-1', 'i2c-dev'], ['card1-DP-2', 'via-usb']]);

    assert.equal(modelMatchesEdid('34M2C8600', '34M2C8600', false), true);
    assert.equal(modelMatchesEdid('PHL 34M2C8600', '34M2C8600', false), true);
    assert.equal(modelMatchesEdid('34m2c8600', '34M2C8600', false), true);
    assert.equal(modelMatchesEdid('34M2C8600', '34M2C860', false), false);
    assert.equal(modelMatchesEdid('34M2C8600', '34M2C860', true), true);
    assert.equal(modelMatchesEdid('A1B', 'A+B', true), false); // EDID text is escaped, not a regex
  }));

test('ENE Ambiglow controller attaches by USB topology, or to the only monitor', () =>
  withRoot(async (root) => {
    const monitor = new SimulatedMonitor(USER_34M2C8600);
    const second = monitorWith({ edidHex: edidVariant({ serial: 'AU00000007777' }) });
    await writeMockSysfs(root, monitor, { connector: 'DP-1', bus: 5 });
    await writeMockSysfs(root, second, { connector: 'DP-2', bus: 6 });
    const usb = new FakeUsbBackend();
    const via = usb.attach(mockViaDeviceSpec(second, { portNumbers: [4, 2] }));
    const ene = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, busNumber: 3, portNumbers: [4, 1], handler: { controlIn: () => new Uint8Array(0), controlOut: () => undefined } });
    await writeMockSysfs(root, second, { connector: 'DP-2', bus: 6 }, [via]);
    // Pair the bridge with the second display: its ModelName is the same, so give display 1 another name.
    await writeFile(join(root, 'class/drm/card1-DP-1/edid'), Buffer.from(edidVariant({ name: 'PHL 49M2C8900' }), 'hex'));
    const found = await discoverMonitors({ ...opts, sysfsRoot: root, usb, i2c: createMockI2cSyscalls({}) });
    assert.deepEqual(found.map((m) => [m.key, m.ene?.id ?? null]), [['AU00000000001', null], ['AU00000007777', ene.id]]);
  }).then(() =>
    withRoot(async (root) => {
      await writeMockSysfs(root, new SimulatedMonitor(USER_34M2C8600));
      const usb = new FakeUsbBackend();
      const ene = usb.attach({ vendorId: 0x0cf2, productId: 0xa201, busNumber: 1, portNumbers: [3], handler: { controlIn: () => new Uint8Array(0), controlOut: () => undefined } });
      const found = await discoverMonitors({ ...opts, sysfsRoot: root, usb, i2c: createMockI2cSyscalls({}) });
      assert.equal(found[0].ene?.id, ene.id);
    }),
  ));

test('an empty or missing sysfs yields no monitors', () =>
  withRoot(async (root) => {
    assert.deepEqual(await scanDrmConnectors(join(root, 'nope')), []);
    assert.deepEqual(await discoverMonitors({ ...opts, sysfsRoot: root, i2c: createMockI2cSyscalls({}) }), []);
  }));
