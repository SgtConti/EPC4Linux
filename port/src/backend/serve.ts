// Backend smoke server: the production backend (compose.ts, the composition Electron main uses) and the
// SignalR hub on 127.0.0.1, without Electron. For hardware bring-up and for driving the RPC surface by hand
// (cli.ts, the DDC/CI bring-up tool, belongs to the ddc module; this is its backend-level counterpart).
//
//   node src/backend/serve.ts [serve] [--mock [--model <m>] [--no-ene]] [--port <n>] [--data <dir>]
//                             [--resources <dir>] [--token <t>] [--origin <o>]... [--verbose]
//
// Once the hub listens, exactly ONE JSON line goes to stdout:
//   {"port":10010,"token":"…","url":"ws://127.0.0.1:10010/EvniaHub?k=…","serveDataDir":"…","hardware":"…"}
// Logs go to stderr. SIGINT/SIGTERM close the hub, stop the backend (the order Electron main uses on quit:
// the hub waits ≤1 s for running requests, then the services stop) and remove a temporary data directory;
// the exit code is then 0. A usage error exits 2, a failed start 1.
//
// Options:
//   --mock              simulated monitor instead of real hardware (EVNIA_MOCK_MONITOR semantics,
//                       ARCHITECTURE.md rule 7). --model <m> (default 34M2C8600) and --no-ene (the user's
//                       2026-09-26 session: no ENE MCU) select the variant. The mock host reports the user's
//                       display mode (3440x1440, 175Hz, 0°), so the session matches the golden transcript.
//                       Without --mock: real hardware — USB-DDC through the VIA bridge, i2c-dev, the ENE MCU —
//                       through ONE shared LibusbBackend, as Electron main does; USB hotplug is forwarded to
//                       the backend after 1 s (the host's USBChange debounce, 01 §9). Nothing is written to
//                       the monitor until a client calls a setter.
//   --port <n>          first port to try (default 10010; taken ports are skipped upward; 0 = any free one)
//   --data <dir>        the EvniaServe directory (Config/, Theme/); its sibling <dir>/../evnia is the
//                       Electron userData directory (MonitorInfo.json user copy). Default: a new temporary
//                       directory, removed on exit. ~/.config/EvniaServe uses the app's profiles and capability
//                       cache — never while the app itself runs, both would write them.
//   --resources <dir>   vendor data (MonitorInfo.json, PCenter_DeviceInfo.json, ENE/PCenter_AmbiglowInfo.json);
//                       default: build/vendor-data of this checkout (`npm run import-ui`)
//   --token <t>         the hub token (default: a fresh 256-bit generateHubToken()); at least 16 characters
//   --origin <o>        also admit this browser Origin (repeatable); default file:// only, like the app.
//                       Non-browser clients (Node, websocat) send no Origin and are always admitted.
//   --verbose           debug logging (every GetTaskAsync request)
// The token is printed on stdout only (it is the point of this tool); it is never logged.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { DisplayModeInfo, HostServices, Logger, UsbBackend } from './types.ts';
import { createLogger, type LogSink } from './core/log.ts';
import { MIN_TOKEN_LENGTH } from './hub/security.ts';
import { LibusbBackend } from './usb/libusb-backend.ts';
import { APP_RENDERER_ORIGINS, DEFAULT_HUB_PORT, HUB_PATH, createDefaultBackend, describeHardware, generateHubToken, startHubServer, type DefaultBackend, type HubHandle } from './index.ts';

const USAGE = `usage: serve.ts [serve] [--mock [--model <m>] [--no-ene]] [--port <n>] [--data <dir>] [--resources <dir>]
                [--token <t>] [--origin <o>]... [--verbose]`;

/** build/vendor-data of this checkout (written by scripts/import-vendor-ui.mjs). */
export const DEFAULT_RESOURCES_DIR = fileURLToPath(new URL('../../build/vendor-data/', import.meta.url));

/** The user's display mode during the 2026-09-26 session (reported by the mock host only). */
const MOCK_DISPLAY_MODE: DisplayModeInfo = { resolution: '3440x1440', frequency: '175Hz', orientation: '0°' };

/** Host USBChange debounce before backend.hotplug('usb') (vendor: +1 s delay, 01 §9). */
const USB_HOTPLUG_DEBOUNCE_MS = 1000;

class UsageError extends Error {}

/** Where the server writes; injectable so tests do not touch the process streams. */
export interface ServeIo {
  out(text: string): void;
  err(text: string): void;
}

const processIo: ServeIo = {
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

export interface ServeOptions {
  /** EVNIA_MOCK_MONITOR value (e.g. "34M2C8600", "34M2C8600/no-ene"); undefined = real hardware. */
  mockMonitor?: string;
  /** First hub port to try (default 10010; 0 = any). */
  port?: number;
  /** EvniaServe directory; default: a temporary one, removed by close(). */
  serveDataDir?: string;
  resourcesDir?: string;
  token?: string;
  /** Browser origins admitted besides the app's (file://). */
  extraOrigins?: readonly string[];
  log: Logger;
}

export interface ServeHandle {
  readonly port: number;
  readonly token: string;
  /** ws://127.0.0.1:<port>/EvniaHub?k=<token> */
  readonly url: string;
  readonly serveDataDir: string;
  /** What the backend drives (compose.ts describeHardware). */
  readonly hardware: string;
  readonly backend: DefaultBackend;
  /** Close the hub, stop the backend and remove a temporary data directory. Idempotent. */
  close(): Promise<void>;
}

/** Start the production backend and its hub. Rejects (after cleaning up) when the hub cannot listen. */
export async function serve(options: ServeOptions): Promise<ServeHandle> {
  const { log } = options;
  const token = options.token ?? generateHubToken();
  if (token.length < MIN_TOKEN_LENGTH) throw new UsageError(`--token must have at least ${MIN_TOKEN_LENGTH} characters`);
  const resourcesDir = resolve(options.resourcesDir ?? DEFAULT_RESOURCES_DIR);
  if (!existsSync(join(resourcesDir, 'PCenter_DeviceInfo.json'))) {
    log.warn(`${resourcesDir} has no PCenter_DeviceInfo.json: run \`npm run import-ui\` or pass --resources; no display will be recognised`);
  }

  const temporary = options.serveDataDir === undefined ? await mkdtemp(join(tmpdir(), 'evnia-serve-')) : null;
  const serveDataDir = temporary ? join(temporary, 'EvniaServe') : resolve(options.serveDataDir!);
  const appDataDir = join(dirname(serveDataDir), 'evnia');
  await mkdir(serveDataDir, { recursive: true });
  await mkdir(appDataDir, { recursive: true });

  const mock = options.mockMonitor !== undefined;
  const host: HostServices = {
    log,
    serveDataDir,
    appDataDir,
    resourcesDir,
    getIdleSeconds: () => 0,
    getForegroundAppPath: () => null,
    ...(mock ? { getDisplayMode: () => ({ ...MOCK_DISPLAY_MODE }) } : {}),
  };
  // One libusb context for the VIA bridges and the ENE, as in Electron main (impl-monitor §5 item 4).
  const usb: UsbBackend | undefined = mock ? undefined : new LibusbBackend({ log: log.child('usb') });
  const backendOptions = { host, usb, mockMonitor: options.mockMonitor, noHardware: mock || undefined };
  const backend = createDefaultBackend(backendOptions);

  let stopUsbWatch: (() => void) | null = null;
  let usbTimer: NodeJS.Timeout | null = null;
  if (usb) {
    stopUsbWatch = usb.onChange(() => {
      if (usbTimer) clearTimeout(usbTimer);
      usbTimer = setTimeout(() => {
        usbTimer = null;
        backend.hotplug('usb');
      }, USB_HOTPLUG_DEBOUNCE_MS);
    });
  }

  let hub: HubHandle | null = null;
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      stopUsbWatch?.();
      if (usbTimer) clearTimeout(usbTimer);
      try {
        await hub?.close();
      } catch (e) {
        log.error('hub close failed', e);
      }
      await backend.stop();
      if (temporary) await rm(temporary, { recursive: true, force: true }).catch((e: unknown) => log.warn(`could not remove ${temporary}`, e));
    })());

  try {
    await backend.start();
    hub = await startHubServer(backend, {
      port: options.port ?? DEFAULT_HUB_PORT,
      token,
      log: log.child('hub'),
      allowedOrigins: [...APP_RENDERER_ORIGINS, ...(options.extraOrigins ?? [])],
    });
  } catch (e) {
    await close();
    throw e;
  }
  const port = hub.port;
  return {
    port,
    token,
    url: `ws://127.0.0.1:${port}${HUB_PATH}?k=${encodeURIComponent(token)}`,
    serveDataDir,
    hardware: describeHardware(backendOptions),
    backend,
    close,
  };
}

interface CliArgs {
  help: boolean;
  options: Omit<ServeOptions, 'log'>;
  verbose: boolean;
}

/** Parse the command line; throws UsageError. */
export function parseServeArgs(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        mock: { type: 'boolean' },
        model: { type: 'string' },
        'no-ene': { type: 'boolean' },
        port: { type: 'string' },
        data: { type: 'string' },
        resources: { type: 'string' },
        token: { type: 'string' },
        origin: { type: 'string', multiple: true },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const { values, positionals } = parsed;
  const extra = positionals.filter((p, i) => !(i === 0 && p === 'serve'));
  if (extra.length > 0) throw new UsageError(`unexpected argument "${extra[0]}"`);
  if (!values.mock && (values.model !== undefined || values['no-ene'])) throw new UsageError('--model and --no-ene need --mock');
  let port: number | undefined;
  if (values.port !== undefined) {
    if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new UsageError(`--port must be 0..65535, got "${values.port}"`);
    port = Number(values.port);
  }
  if (values.token !== undefined && values.token.length < MIN_TOKEN_LENGTH) throw new UsageError(`--token must have at least ${MIN_TOKEN_LENGTH} characters`);
  return {
    help: values.help === true,
    verbose: values.verbose === true,
    options: {
      mockMonitor: values.mock ? `${values.model ?? '34M2C8600'}${values['no-ene'] ? '/no-ene' : ''}` : undefined,
      port,
      serveDataDir: values.data,
      resourcesDir: values.resources,
      token: values.token,
      extraOrigins: values.origin,
    },
  };
}

const stderrSink =
  (io: ServeIo): LogSink =>
  (level, scope, args) => {
    io.err(`${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${args.map((a) => (a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' ')}\n`);
  };

/**
 * Run the server until `stopSignal` resolves (default: the first SIGINT or SIGTERM), then shut it down.
 * Returns the exit code: 0 after a clean shutdown (or --help), 1 when the start failed, 2 on a usage error.
 */
export async function main(argv: string[], io: ServeIo = processIo, stopSignal?: Promise<unknown>): Promise<number> {
  let args: CliArgs;
  try {
    args = parseServeArgs(argv);
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }

  const log = createLogger('backend', stderrSink(io), args.verbose ? 'debug' : 'info');
  let handle: ServeHandle;
  try {
    handle = await serve({ ...args.options, log });
  } catch (e) {
    log.error('start failed', e);
    return 1;
  }
  io.out(`${JSON.stringify({ port: handle.port, token: handle.token, url: handle.url, serveDataDir: handle.serveDataDir, hardware: handle.hardware })}\n`);
  log.info(`serving ${handle.hardware} on 127.0.0.1:${handle.port}${HUB_PATH}; Ctrl+C stops`);
  await (stopSignal ?? signalled());
  log.info('stopping');
  await handle.close();
  return 0;
}

/** Resolves on the first SIGINT or SIGTERM; a second one exits at once. */
function signalled(): Promise<NodeJS.Signals> {
  return new Promise((done) => {
    const onSignal = (signal: NodeJS.Signals) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.once('SIGINT', () => process.exit(130));
      process.once('SIGTERM', () => process.exit(143));
      done(signal);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  // libusb's hotplug thread may keep the loop alive after a real-hardware session; everything is stopped.
  setTimeout(() => process.exit(code), 2000).unref();
}
