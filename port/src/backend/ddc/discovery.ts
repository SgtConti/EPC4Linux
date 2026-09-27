// Monitor discovery on Linux: the enumeration half of GClass3.ConnectionCkecked (06 §4.1), in the
// probe order of 20 §2.3:
//   1. DRM connectors (/sys/class/drm/card*-*), no bus traffic: status, EDID, brand filter "PHL" on the
//      PnP id (supportDisplays) and an optional model whitelist. The DDC bus is the connector's AUX
//      child adapter for DisplayPort and the `ddc` link otherwise (20 R6); without either, the GPU's
//      other adapters are matched by reading EDID at 0x50 (the vendor's EDID-equality rule, 07 §8.2).
//   2. VIA USB-DDC bridges (2109:8884 unless configured otherwise, never hubs; 08 §4.1, 20 §2.3 step
//      2): VCP C8, ModelName, pairing with a display's EDID name (MonitorUtil.smethod_6/8, 08 §3.7),
//      then the USB-DDC probe (08 §3.6).
//   3. Merge by the EDID serial (20 D6; GClass3.method_3/4) and attach the ENE Ambiglow controller
//      (0cf2:a201, 09 §3, 20 §6) by USB topology.
// Everything runs under a process-wide "display scan" lock, and every bus access holds the lock of
// that bridge or bus (and of the monitor once it is known), shared with the driver's channels and
// with other processes (20 §2.3/§2.4, locks.ts). A rescan can therefore run while the driver polls.
// The current-display choice, the capability read and the transport selection belong to the driver.

import { readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DdcTransport, DiscoveredMonitor, Logger, UsbBackend, UsbDeviceInfo } from '../types.ts';
import { Mutex } from '../core/events.ts';
import { type DdcChannelOptions, type DdcClock, DdcChannelImpl, realClock } from './channel.ts';
import { type EdidDetails, parseEdid, edidPairingName, sameEdidBase } from './edid.ts';
import { errorText, isBusy } from './errors.ts';
import { readFactorySerial, readScalerIc, readTpvString } from './identity.ts';
import { type ProcessLock, resolveProcessLock, withExclusiveAccess } from './locks.ts';
import { I2cDevTransport, type I2cSyscalls, i2cTransportId, linuxI2cSyscalls, readEdidOverI2c } from './transports/i2cdev.ts';
import { VIA_DDC_BRIDGE_PID, VIA_VENDOR_ID, ViaUsbTransport } from './transports/via.ts';
import { USB_CLASS_HUB, formatVidPid, usbDeviceClass } from '../usb/ids.ts';

export const ENE_VENDOR_ID = 0x0cf2;
export const ENE_PRODUCT_ID = 0xa201;

/** VIA hub PIDs seen on the user's machine (08 §2.3, 20 §6.1); used only when neither the descriptor nor sysfs can tell. */
const KNOWN_VIA_HUB_PIDS = new Set([0x0211, 0x0817, 0x2817, 0x2211]);

/**
 * i2c adapters that are never probed for EDID, whatever GPU they sit under: the adapters ddcutil
 * ignores for the same reason. They are SMBus host controllers, the AMDGPU SMU bus (RAS/FRU EEPROM,
 * firmware controller), DesignWare and Raspberry Pi DSI controllers, and the PowerMac buses whose
 * probing hangs the machine (20 §2.3 step 3c: "never probe SMBus adapters"). The package's udev rule
 * (packaging/deb/70-evnia-precision-center.rules) grants no seat access to these adapters either; a
 * packaging test keeps both lists in sync.
 */
export const IGNORED_ADAPTER_PREFIXES: readonly string[] = ['SMBus', 'AMDGPU SMU', 'Synopsys DesignWare', 'soc:i2cdsi', 'smu', 'mac-io', 'u4'];

export function isIgnoredI2cAdapter(name: string): boolean {
  return /smbus/i.test(name) || IGNORED_ADAPTER_PREFIXES.some((p) => name.startsWith(p));
}

export interface DrmConnector {
  /** Connector directory name, e.g. "card1-DP-1". */
  name: string;
  card: string;
  status: string;
  edid: Uint8Array | null;
  /** i2c adapter number of the connector's DDC bus, and how it was found. */
  bus?: { number: number; source: 'ddc-link' | 'aux-child' | 'edid-match' };
}

async function readText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return null;
  }
}

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    const b = await readFile(path);
    return b.length > 0 ? new Uint8Array(b) : null;
  } catch {
    return null;
  }
}

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

function busNumber(name: string): number | null {
  const m = /^i2c-(\d+)$/.exec(name);
  return m ? Number(m[1]) : null;
}

const naturalOrder = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/**
 * DRM connectors with their EDID and DDC bus. A native DP sink only speaks I2C-over-AUX, so DP and eDP
 * connectors use their AUX child adapter ("AMDGPU DM aux hw bus N", "DPDDC-x", …) before the `ddc`
 * link, which on amdgpu points at the GPIO DDC engine; other connectors use the `ddc` link first (20 R6).
 */
export async function scanDrmConnectors(sysfsRoot = '/sys'): Promise<DrmConnector[]> {
  const drm = join(sysfsRoot, 'class/drm');
  const out: DrmConnector[] = [];
  for (const name of (await list(drm)).sort(naturalOrder)) {
    const m = /^(card\d+)-(.+)$/.exec(name);
    if (!m) continue;
    const dir = join(drm, name);
    const connector: DrmConnector = {
      name,
      card: m[1],
      status: (await readText(join(dir, 'status'))) ?? 'unknown',
      edid: await readBytes(join(dir, 'edid')),
    };
    let link: number | null = null;
    try {
      link = busNumber(basename(await realpath(join(dir, 'ddc'))));
    } catch {
      // no ddc link (driver without drm_connector_init_with_ddc)
    }
    const children = (await list(dir)).map(busNumber).filter((n): n is number => n !== null);
    const aux = children.length > 0 ? Math.min(...children) : null;
    const isDp = /^e?DP-/.test(m[2]);
    if (isDp && aux !== null) connector.bus = { number: aux, source: 'aux-child' };
    else if (link !== null) connector.bus = { number: link, source: 'ddc-link' };
    else if (aux !== null) connector.bus = { number: aux, source: 'aux-child' };
    out.push(connector);
  }
  return out;
}

/**
 * i2c adapters of a DRM card's GPU: their sysfs path lies under the card's PCI device, which must be a
 * display controller (PCI class 0x03xxxx), and their name is not on the ignore list (SMBus, AMDGPU
 * SMU, …; 20 §2.3 step 3c). The NVIDIA driver names every adapter "NVIDIA i2c adapter N"; those are
 * all read at 0x50, like ddcutil and the vendor's FindMonitorByEDID do.
 */
async function gpuI2cBuses(sysfsRoot: string, card: string): Promise<Array<{ number: number; name: string }>> {
  let gpu: string;
  try {
    gpu = await realpath(join(sysfsRoot, 'class/drm', card, 'device'));
  } catch {
    return [];
  }
  if (!/^0x03/i.test((await readText(join(gpu, 'class'))) ?? '')) return [];
  const buses: Array<{ number: number; name: string }> = [];
  const root = join(sysfsRoot, 'bus/i2c/devices');
  for (const entry of (await list(root)).sort(naturalOrder)) {
    const n = busNumber(entry);
    if (n === null) continue;
    let real: string;
    try {
      real = await realpath(join(root, entry));
    } catch {
      continue;
    }
    if (!real.startsWith(`${gpu}/`)) continue;
    const name = (await readText(join(real, 'name'))) ?? '';
    if (isIgnoredI2cAdapter(name)) continue;
    buses.push({ number: n, name });
  }
  return buses;
}

// ───────────────────────────── USB ─────────────────────────────

function usbPortPath(info: UsbDeviceInfo): { bus: number; ports: number[]; sysfs: string } | null {
  const m = /^usb:(\d+)-([\d.]+)$/.exec(info.id);
  return m ? { bus: Number(m[1]), ports: m[2].split('.').map(Number), sysfs: `${m[1]}-${m[2]}` } : null;
}

/** bDeviceClass 0x09, from the descriptor (libusb/fake backends), else sysfs, else the known hub PIDs. */
async function isUsbHub(sysfsRoot: string, info: UsbDeviceInfo): Promise<boolean> {
  const descriptorClass = usbDeviceClass(info);
  if (descriptorClass !== undefined) return descriptorClass === USB_CLASS_HUB;
  const path = usbPortPath(info);
  const cls = path ? await readText(join(sysfsRoot, 'bus/usb/devices', path.sysfs, 'bDeviceClass')) : null;
  if (cls !== null && /^[0-9a-f]{2}$/i.test(cls)) return parseInt(cls, 16) === USB_CLASS_HUB;
  return KNOWN_VIA_HUB_PIDS.has(info.productId);
}

/** Common USB port-path prefix length (same bus); 0 when unrelated. */
function topologyScore(a: UsbDeviceInfo, b: UsbDeviceInfo): number {
  const pa = usbPortPath(a);
  const pb = usbPortPath(b);
  if (!pa || !pb || pa.bus !== pb.bus) return 0;
  let n = 0;
  while (n < pa.ports.length && n < pb.ports.length && pa.ports[n] === pb.ports[n]) n++;
  return n;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const BRAND_PREFIX = '^((AOC )|(PHL )|(AOC_)|(PHL_)|(AOC)|(PHL))?';

/**
 * MonitorUtil.smethod_8 (08 §3.7): the USB ModelName must match the EDID name (brand prefix removed),
 * first exactly, then as a prefix followed by [0-9A-Z]*. The vendor interpolates the EDID name into the
 * regex unescaped; we escape it.
 */
export function modelMatchesEdid(modelName: string, edidName: string, loose: boolean): boolean {
  const pattern = BRAND_PREFIX + escapeRegex(edidName) + (loose ? '[0-9A-Z]*' : '$');
  return new RegExp(pattern, 'i').test(modelName.toUpperCase());
}

// ───────────────────────────── discovery ─────────────────────────────

export interface DiscoveryOptions {
  log?: Logger;
  /** Root of sysfs (tests pass a temporary fake tree). */
  sysfsRoot?: string;
  /** Directory holding the i2c-dev nodes. */
  devRoot?: string;
  /** USB access; without it only i2c-dev transports are found. */
  usb?: UsbBackend;
  /** i2c syscalls for the transports and for EDID probing of unlinked buses. */
  i2c?: I2cSyscalls;
  /** PnP-id brand filter (vendor supportDisplays = ["PHL"]); null keeps every connected display. */
  brands?: readonly string[] | null;
  /** Model whitelist on the EDID monitor name (MonitorInfo.json via GClass3.method_2); default: all. */
  supportsModel?: (edidModelName: string) => boolean;
  /** Read EDID over i2c on GPU buses for connectors without a bus link (07 §8.2, 20 §2.3 step 3c). */
  probeUnlinkedBuses?: boolean;
  /**
   * VIA product ids treated as USB-DDC bridges (default: 0x8884, the user's bridge). The vendor tries
   * every 2109 non-hub device, but on Windows only functions bound to WinUSB open
   * (Interface13 WinUsb_Initialize). On Linux, usbfs lets a privileged process send vendor requests to
   * any VIA function, such as billboard, PD or dock controllers, whose meaning for B2/A3/A7 is unknown.
   * Others are therefore only probed when listed here.
   */
  viaProductIds?: readonly number[];
  /** Timings, clock and process lock for the VIA identification queries and probe; the process lock also covers the EDID reads. */
  channel?: DiscoveryChannelOptions;
}

export type DiscoveryChannelOptions = Pick<DdcChannelOptions, 'timings' | 'clock' | 'processLock'>;

interface Candidate {
  key: string;
  edid: EdidDetails;
  connectors: DrmConnector[];
  via?: ViaUsbTransport;
  ene?: UsbDeviceInfo;
}

/** 20 §2.3: every discovery step runs under one process-wide "display scan" lock. */
const displayScan = new Mutex();

export function discoverMonitors(options: DiscoveryOptions = {}): Promise<DiscoveredMonitor[]> {
  return displayScan.run(() => scan(options));
}

async function scan(options: DiscoveryOptions): Promise<DiscoveredMonitor[]> {
  const log = options.log;
  const sysfs = options.sysfsRoot ?? '/sys';
  const dev = options.devRoot ?? '/dev';
  const i2c = options.i2c ?? linuxI2cSyscalls();
  const brands = options.brands === undefined ? ['PHL'] : options.brands;
  const processLock = resolveProcessLock(options.channel?.processLock);

  // 1. Connected connectors with a parseable EDID of a supported brand (DDCHelAPIIni("PHL") filter).
  const connectors = await scanDrmConnectors(sysfs);
  const displays: Array<{ connector: DrmConnector; edid: EdidDetails }> = [];
  for (const c of connectors) {
    if (c.status !== 'connected') continue;
    if (!c.edid) {
      log?.debug(`${c.name}: connected but no EDID`);
      continue;
    }
    let edid: EdidDetails;
    try {
      edid = parseEdid(c.edid);
    } catch (e) {
      log?.warn(`${c.name}: ${errorText(e)}`);
      continue;
    }
    if (brands && !brands.some((b) => edid.pnpId.toUpperCase().includes(b.toUpperCase()))) {
      log?.debug(`${c.name}: ${edid.pnpId} is not a supported brand`);
      continue;
    }
    if (options.supportsModel && !options.supportsModel(edid.monitorName)) {
      log?.info(`${c.name}: model "${edid.monitorName}" is not supported`);
      continue;
    }
    displays.push({ connector: c, edid });
  }
  if (options.probeUnlinkedBuses ?? true) await matchUnlinkedBuses(displays, connectors, sysfs, dev, i2c, processLock, log);

  // 2. Merge by EDID serial (one physical monitor may be connected twice). The vendor requires a serial;
  //    we fall back to the 32-bit EDID serial (DDCHelper's rule) and then to the connector name.
  const candidates: Candidate[] = [];
  for (const d of displays) {
    const key = d.edid.serialString || (d.edid.serialNumber ? String(d.edid.serialNumber) : d.connector.name);
    const existing = candidates.find((c) => c.key.toLowerCase() === key.toLowerCase());
    if (existing) existing.connectors.push(d.connector);
    else candidates.push({ key, edid: d.edid, connectors: [d.connector] });
  }

  // 3. USB bridges and the ENE controller.
  if (options.usb) {
    const viaPids = new Set(options.viaProductIds ?? [VIA_DDC_BRIDGE_PID]);
    await pairViaBridges(options.usb, viaPids, candidates, sysfs, options.channel, log);
    await attachEne(options.usb, candidates, log);
  }

  return candidates.map((c) => {
    const transports: DdcTransport[] = [];
    if (c.via) transports.push(c.via);
    for (const conn of c.connectors) {
      if (!conn.bus) continue;
      transports.push(new I2cDevTransport(join(dev, `i2c-${conn.bus.number}`), i2c, { log }));
    }
    if (transports.length === 0) log?.warn(`${c.key}: no DDC/CI path (no i2c bus and no USB bridge)`);
    const monitor: DiscoveredMonitor = { key: c.key, edid: c.edid, connector: c.connectors[0].name, transports };
    if (c.ene) monitor.ene = c.ene;
    return monitor;
  });
}

/**
 * Step 3c: EDID equality on the GPU's remaining adapters (FindMonitorByEDID compares 128 bytes). Each
 * read holds the bus's lock: the bus may already carry a driver channel's DDC/CI traffic.
 */
async function matchUnlinkedBuses(
  displays: Array<{ connector: DrmConnector; edid: EdidDetails }>,
  all: DrmConnector[],
  sysfs: string,
  dev: string,
  i2c: I2cSyscalls,
  processLock: ProcessLock | null,
  log: Logger | undefined,
): Promise<void> {
  const taken = new Set(all.flatMap((c) => (c.bus ? [c.bus.number] : [])));
  for (const d of displays) {
    if (d.connector.bus) continue;
    for (const bus of await gpuI2cBuses(sysfs, d.connector.card)) {
      if (taken.has(bus.number)) continue;
      const path = join(dev, `i2c-${bus.number}`);
      try {
        const edid = await withExclusiveAccess([i2cTransportId(path)], processLock, () => readEdidOverI2c(path, i2c), log);
        if (!sameEdidBase(edid, d.edid.raw)) continue;
        d.connector.bus = { number: bus.number, source: 'edid-match' };
        taken.add(bus.number);
        log?.info(`${d.connector.name}: DDC bus i2c-${bus.number} (${bus.name}) matched by EDID`);
        break;
      } catch (e) {
        log?.debug(`i2c-${bus.number}: no EDID (${errorText(e)})`);
      }
    }
  }
}

async function pairViaBridges(
  usb: UsbBackend,
  viaPids: ReadonlySet<number>,
  candidates: Candidate[],
  sysfs: string,
  channelOptions: DiscoveryChannelOptions | undefined,
  log: Logger | undefined,
): Promise<void> {
  const bridges: UsbDeviceInfo[] = [];
  for (const info of await usb.list((d) => d.vendorId === VIA_VENDOR_ID)) {
    if (await isUsbHub(sysfs, info)) continue;
    if (!viaPids.has(info.productId)) {
      log?.debug(`VIA ${info.id} (${formatVidPid(info.vendorId, info.productId)}): not a configured USB-DDC bridge; not probed`);
      continue;
    }
    bridges.push(info);
  }
  for (const info of bridges) {
    let transport: ViaUsbTransport;
    try {
      transport = new ViaUsbTransport(await usb.open(info));
    } catch (e) {
      log?.warn(`VIA ${info.id} (${formatVidPid(info.vendorId, info.productId)}): cannot open: ${errorText(e)}`);
      continue;
    }
    // Identification runs before the support probe, as in the vendor (EnumerateMonitorOTADevices, then
    // CheckSupportUSBDDC), so the channel must not gate the queries on the probe. It holds the lock of
    // the bridge's path, like any channel the driver already has on it.
    const options: DdcChannelOptions = { log, ...channelOptions, requireProbe: false };
    const keep = await identifyBridge(options, transport, candidates, channelOptions?.clock ?? realClock, log);
    if (!keep) await transport.close();
  }
}

type Named = { c: Candidate; name: string };

/**
 * 20 §2.3 step 2: (a) VCP C8 — GetMonitorInfo only runs for a known scaler family; (b) ModelName, 3 tries
 * 150 ms apart; (c) pairing, exact then loose, ties broken by the factory SN (FE EF 13), ambiguity leaves
 * the bridge unpaired; (d) under the paired monitor's lock, the USB-DDC probe. The factory SN is
 * compared with the EDID serial and a mismatch is logged (D6). Returns true when the bridge was
 * attached to a monitor.
 */
async function identifyBridge(
  options: DdcChannelOptions,
  transport: ViaUsbTransport,
  candidates: Candidate[],
  clock: DdcClock,
  log: Logger | undefined,
): Promise<boolean> {
  const channel = new DdcChannelImpl([transport], options);
  try {
    const { scalerIc, scalerType } = await readScalerIc(channel);
    if (scalerType === 'Unknown') {
      log?.info(`${transport.id}: unknown scaler IC 0x${scalerIc.toString(16)}; bridge ignored`);
      return false;
    }
    log?.debug(`${transport.id}: scaler ${scalerType}`);
  } catch (e) {
    const why = isBusy(e) ? 'bridge busy' : 'no DDC/CI answer';
    log?.info(`${transport.id}: ${why} (VCP C8: ${errorText(e)}); bridge ignored`);
    return false;
  }

  let modelName: string | null = null;
  for (let i = 0; i < 3 && modelName === null; i++) {
    if (i > 0) await clock.sleep(channel.timings.identityRetryMs);
    try {
      modelName = await readTpvString(channel, 'modelName');
    } catch (e) {
      log?.debug(`${transport.id}: ModelName attempt ${i + 1}: ${errorText(e)}`);
      if (isBusy(e)) break;
    }
  }
  if (modelName === null) {
    log?.warn(`${transport.id}: ModelName unreadable; bridge ignored`);
    return false;
  }

  let factorySerial: string | undefined;
  const serial = async (over: DdcChannelImpl) => (factorySerial ??= await readFactorySerial(over).catch(() => ''));
  const named = candidates
    .filter((c) => !c.via)
    .map((c) => ({ c, name: edidPairingName(c.edid.raw) }))
    .filter((x): x is Named => x.name !== null);
  const pick = async (loose: boolean): Promise<Named | null | undefined> => {
    const matches = named.filter((x) => modelMatchesEdid(modelName, x.name, loose));
    if (matches.length <= 1) return matches[0];
    const sn = (await serial(channel)).toLowerCase();
    const bySerial = matches.filter((x) => sn !== '' && x.c.edid.serialString.toLowerCase() === sn);
    if (bySerial.length === 1) return bySerial[0];
    log?.warn(`${transport.id}: ModelName "${modelName}" matches ${matches.length} displays; bridge left unpaired`);
    return null;
  };
  const exact = await pick(false);
  const match = exact === undefined ? await pick(true) : exact;
  if (!match) {
    if (match === undefined) log?.warn(`${transport.id}: ModelName "${modelName}" matches no connected display; bridge ignored (08 §3.7)`);
    return false;
  }

  // From here on the monitor is known: also hold its lock, shared with its channels on any path.
  const paired = new DdcChannelImpl([transport], { ...options, monitorKey: match.c.key });
  const probe = await paired.probe().then(
    ([p]) => p,
    (e: unknown) => void log?.warn(`${transport.id}: USB-DDC probe failed (${errorText(e)}); ${match.c.key} stays on i2c-dev`),
  );
  if (!probe) return false;
  if (!probe.supported) {
    log?.info(`${transport.id}: USB-DDC not supported; ${match.c.key} stays on i2c-dev`);
    return false;
  }
  const sn = await serial(paired);
  if (sn && sn.toLowerCase() !== match.c.edid.serialString.toLowerCase()) {
    log?.warn(`${transport.id}: factory SN "${sn}" differs from EDID serial "${match.c.edid.serialString}"; keyed by the EDID serial`);
  }
  match.c.via = transport;
  log?.info(`${transport.id}: ModelName "${modelName}" paired with ${match.c.connectors[0].name} (${match.c.key})`);
  return true;
}

async function attachEne(usb: UsbBackend, candidates: Candidate[], log: Logger | undefined): Promise<void> {
  const enes = await usb.list((d) => d.vendorId === ENE_VENDOR_ID && d.productId === ENE_PRODUCT_ID);
  for (const ene of enes) {
    const free = candidates.filter((c) => !c.ene);
    let best: Candidate | undefined;
    let bestScore = 0;
    for (const c of free) {
      const score = c.via ? topologyScore(ene, c.via.info) : 0;
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    // Without topology evidence the vendor simply uses the ENE with the current display; do the same
    // only when that is unambiguous.
    if (!best && candidates.length === 1 && free.length === 1) best = free[0];
    if (best) {
      best.ene = ene;
      log?.info(`ENE ${ene.id} attached to ${best.key}`);
    } else {
      log?.warn(`ENE ${ene.id}: cannot tell which monitor it belongs to; not attached`);
    }
  }
}
