// Hardware bring-up CLI for the DDC/CI layer (07 §8.5: read-only first, writes only on request).
//
//   node src/backend/cli.ts list                     monitors, connectors, i2c buses, VIA bridges, probes
//   node src/backend/cli.ts caps                     capability string (raw + parsed summary)
//   node src/backend/cli.ts get <code>               VCP read: 10 | 0x10 | e2a019
//   node src/backend/cli.ts set <code> <value> --yes VCP write (refused without --yes)
//   node src/backend/cli.ts identity                 scaler IC, model, BOM, firmware, bank, scaler, serial
// Options: --mock (simulated 34M2C8600), --transport via|i2c, --monitor <serial|connector>, --all,
//          --via-pid <hex> (probe another VIA product id as a USB-DDC bridge; repeatable),
//          --json, --verbose, --sysfs <dir>, --dev <dir>
// Exit codes: 0 success, 1 failure, 2 usage error or refused write.
//
// On real hardware every transaction takes the same locks as the app (20 §2.4; ddc/locks.ts): the
// in-process path locks and the flock files under $XDG_RUNTIME_DIR/evnia (under sudo, the invoking
// user's /run/user/<SUDO_UID>/evnia). The CLI can therefore run while the app is running: the two
// take turns per transaction instead of splitting a request from its reply.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { DiscoveredMonitor, Logger, UsbBackend } from './types.ts';
import { createLogger, type LogSink } from './core/log.ts';
import { analyseVcpString, parseCapabilities } from './ddc/capabilities.ts';
import { DdcChannelImpl, NO_DELAY_TIMINGS } from './ddc/channel.ts';
import { extSub, hex2, isExtCode } from './ddc/codec.ts';
import { type DiscoveryChannelOptions, discoverMonitors } from './ddc/discovery.ts';
import { edidDisplayStrings, type EdidDetails } from './ddc/edid.ts';
import { readMonitorIdentity } from './ddc/identity.ts';
import { linuxI2cSyscalls, type I2cSyscalls } from './ddc/transports/i2cdev.ts';
import { DEFAULT_MOCK_SYSFS, createMock34M2C8600, writeMockSysfs } from './ddc/transports/mock.ts';
import { VIA_DDC_BRIDGE_PID } from './ddc/transports/via.ts';
import { LibusbBackend } from './usb/libusb-backend.ts';

const USAGE = `usage: cli.ts <list|caps|get <code>|set <code> <value> --yes|identity> [--mock] [--transport via|i2c]
              [--monitor <serial|connector>] [--all] [--via-pid <hex>]... [--json] [--verbose] [--sysfs <dir>] [--dev <dir>]
codes: standard VCP as hex (10, 0x10) or TPV extended as e2a0xx (e2a019)`;

class UsageError extends Error {}

/** Where the CLI writes; injectable so tests do not touch the process streams. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const processIo: CliIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

const stderrSink = (io: CliIo): LogSink => (level, scope, args) => {
  io.err(`${level.toUpperCase()} [${scope}] ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}\n`);
};

/** "10", "0x10" → standard code; "e2a019", "0xE2A019" → extended code 0xE2A019. */
export function parseCode(text: string): number {
  const m = /^(?:0x)?([0-9a-f]+)$/i.exec(text.trim());
  const code = m ? parseInt(m[1], 16) : NaN;
  if (m && m[1].length <= 2) return code;
  if (m && isExtCode(code)) return code;
  throw new UsageError(`invalid VCP code "${text}" (use 00..FF or e2a000..e2a0ff)`);
}

/** "8884", "0x8884" → a USB product id. */
export function parseProductId(text: string): number {
  const m = /^(?:0x)?([0-9a-f]{1,4})$/i.exec(text.trim());
  if (!m) throw new UsageError(`invalid USB product id "${text}" (1-4 hex digits)`);
  return parseInt(m[1], 16);
}

export function parseValue(text: string): number {
  const v = /^0x[0-9a-f]+$/i.test(text) ? parseInt(text, 16) : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new UsageError(`invalid value "${text}" (0..65535, decimal or 0x hex)`);
  return v;
}

function codeName(code: number): string {
  return isExtCode(code) ? `e2a0${hex2(extSub(code)).toLowerCase()}` : `0x${hex2(code)}`;
}

interface Session {
  monitors: DiscoveredMonitor[];
  /** Channel settings of the session: simulator timings and no process lock for --mock. */
  channel: DiscoveryChannelOptions;
  cleanup(): Promise<void>;
}

interface SessionOptions {
  mock: boolean;
  all: boolean;
  viaPids: number[];
  sysfs?: string;
  dev?: string;
}

async function openSession(opts: SessionOptions, log: Logger): Promise<Session> {
  const brands = opts.all ? null : undefined;
  const viaProductIds = opts.viaPids.length > 0 ? [VIA_DDC_BRIDGE_PID, ...opts.viaPids] : undefined;
  if (opts.mock) {
    // The full discovery path, against a fake sysfs tree and the simulated monitor on USB and i2c.
    // The simulator is private to this process, so it takes no cross-process lock.
    const bundle = await createMock34M2C8600({ transports: [] });
    const root = await mkdtemp(join(tmpdir(), 'evnia-mock-sysfs-'));
    await writeMockSysfs(root, bundle.monitor, DEFAULT_MOCK_SYSFS, [bundle.viaInfo]);
    const channel: DiscoveryChannelOptions = { timings: NO_DELAY_TIMINGS, processLock: null };
    const monitors = await discoverMonitors({ log, sysfsRoot: root, devRoot: '/dev', usb: bundle.usb, i2c: bundle.i2c, brands, viaProductIds, channel });
    return { monitors, channel, cleanup: () => rm(root, { recursive: true, force: true }) };
  }
  const usb: UsbBackend = new LibusbBackend({ log: log.child('usb') });
  const i2c: I2cSyscalls = linuxI2cSyscalls();
  const monitors = await discoverMonitors({ log, sysfsRoot: opts.sysfs, devRoot: opts.dev, usb, i2c, brands, viaProductIds });
  return { monitors, channel: {}, cleanup: async () => undefined };
}

function pickMonitor(monitors: DiscoveredMonitor[], wanted: string | undefined): DiscoveredMonitor {
  if (monitors.length === 0) throw new Error('no supported monitor found (try --all, --verbose)');
  if (!wanted) return monitors[0];
  const m = monitors.find((x) => x.key.toLowerCase() === wanted.toLowerCase() || x.connector === wanted);
  if (!m) throw new UsageError(`no monitor "${wanted}" (have: ${monitors.map((x) => x.key).join(', ')})`);
  return m;
}

function print(io: CliIo, json: boolean, value: unknown, text: string): void {
  io.out(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

export async function main(argv: string[], io: CliIo = processIo): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        mock: { type: 'boolean', default: false },
        transport: { type: 'string' },
        monitor: { type: 'string' },
        all: { type: 'boolean', default: false },
        'via-pid': { type: 'string', multiple: true, default: [] },
        json: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        yes: { type: 'boolean', default: false },
        sysfs: { type: 'string' },
        dev: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    });
  } catch (e) {
    io.err(`${(e as Error).message}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...args] = positionals;
  if (values.help || !command) {
    io.err(`${USAGE}\n`);
    return values.help ? 0 : 2;
  }
  const log = createLogger('ddc-cli', stderrSink(io), values.verbose ? 'debug' : 'warn');
  let session: Session | null = null;
  try {
    if (values.transport !== undefined && values.transport !== 'via' && values.transport !== 'i2c') throw new UsageError('--transport must be via or i2c');
    // Validate the command line before touching any hardware.
    const code = command === 'get' || command === 'set' ? parseCode(args[0] ?? '') : null;
    const value = command === 'set' ? parseValue(args[1] ?? '') : null;
    const viaPids = values['via-pid'].map(parseProductId);
    if (!['list', 'caps', 'get', 'set', 'identity'].includes(command)) throw new UsageError(`unknown command "${command}"`);
    if (command === 'set' && !values.yes) {
      io.err(`refusing to write ${codeName(code!)} = ${value} without --yes (this changes the monitor's settings)\n`);
      return 2;
    }

    session = await openSession({ mock: values.mock, all: values.all, viaPids, sysfs: values.sysfs, dev: values.dev }, log);
    const kind = values.transport === 'via' ? 'via-usb' : values.transport === 'i2c' ? 'i2c-dev' : null;
    const channelFor = (m: DiscoveredMonitor) =>
      new DdcChannelImpl(kind ? m.transports.filter((t) => t.kind === kind) : m.transports, { log, ...session!.channel, monitorKey: m.key });

    if (command === 'list') {
      const rows = [];
      for (const m of session.monitors) {
        const probes = await channelFor(m).probe();
        const edid = m.edid as EdidDetails | null;
        rows.push({
          key: m.key,
          connector: m.connector ?? null,
          name: edid?.monitorName ?? null,
          pnpId: edid?.pnpId ?? null,
          ene: m.ene?.id ?? null,
          edidInfo: edid ? edidDisplayStrings(edid) : null,
          transports: probes,
        });
      }
      const text = rows.length === 0
        ? 'no supported monitor found'
        : rows.map((r) => [
            `${r.key}  ${r.name ?? '?'}  (${r.pnpId ?? '?'}, ${r.connector ?? 'no connector'})${r.ene ? `  ENE ${r.ene}` : ''}`,
            ...r.transports.map((p) => `  ${p.transportId}: ${p.supported ? 'DDC/CI ok' : 'unusable'}${p.error ? ` (${p.error})` : p.value !== undefined ? ` (VCP 14 = 0x${hex2(p.value)}/0x${hex2(p.max ?? 0)})` : ''}`),
          ].join('\n')).join('\n');
      print(io, values.json, rows, text);
      return 0;
    }

    const monitor = pickMonitor(session.monitors, values.monitor);
    const channel = channelFor(monitor);
    if (command === 'caps') {
      const raw = await channel.capabilities();
      const caps = parseCapabilities(raw);
      const vendor = analyseVcpString(raw);
      print(io, values.json, { raw, parsed: caps, vendorCodes: vendor ? [...vendor.keys()].map(codeName) : null },
        `${raw}\n\nmodel ${caps.model ?? '?'}, MCCS ${caps.mccsVer ?? '?'}, cmds ${caps.cmds.map(hex2).join(' ')}, ${caps.vcp.length} VCP codes` +
        (caps.warnings.length ? `\nwarnings: ${caps.warnings.join('; ')}` : ''));
    } else if (command === 'get') {
      const v = isExtCode(code!) ? await channel.getExt(extSub(code!)) : await channel.getVcp(code!);
      print(io, values.json, { code: codeName(code!), ...v }, `${codeName(code!)}: value ${v.value} (0x${v.value.toString(16)}), max ${v.max} (0x${v.max.toString(16)}), result code ${v.resultCode}`);
    } else if (command === 'set') {
      if (isExtCode(code!)) await channel.setExt(extSub(code!), value!);
      else await channel.setVcp(code!, value!);
      print(io, values.json, { code: codeName(code!), value }, `${codeName(code!)} <- ${value}`);
    } else {
      const id = await readMonitorIdentity(channel);
      const lines = Object.entries(id).filter(([k]) => k !== 'errors').map(([k, v]) => `${k}: ${typeof v === 'number' ? `0x${v.toString(16)}` : v}`);
      for (const [k, e] of Object.entries(id.errors)) lines.push(`${k}: (failed: ${e})`);
      print(io, values.json, id, lines.join('\n'));
    }
    return 0;
  } catch (e) {
    io.err(`${e instanceof UsageError ? `${e.message}\n${USAGE}` : `error: ${(e as Error).message}`}\n`);
    return e instanceof UsageError ? 2 : 1;
  } finally {
    if (session) {
      for (const m of session.monitors) for (const t of m.transports) await t.close().catch(() => undefined);
      await session.cleanup();
    }
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
