// Electron e2e harness (ARCHITECTURE "Build and test pipeline" 4): builds the app, launches it with
// Playwright under Xvfb with the simulated monitor, and records every request/WebSocket the renderers
// make so tests can assert that nothing leaves the machine.
//
// Run in the dev container:
//   xvfb-run -a -s "-screen 0 1920x1080x24" node --test test/e2e/
// With build/vendor-ui present (npm run import-ui) the real vendor UI is tested; otherwise the
// placeholder renderer in fixtures/placeholder-ui exercises the same shell contract.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication, type Page, type WebSocket } from 'playwright-core';

export const PORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const E2E_DIR = join(PORT_DIR, 'test', 'e2e');
export const ARTIFACTS = join(E2E_DIR, 'artifacts');

/** Schemes that never leave the machine (mirror of src/main/network-guard.ts LOCAL_PROTOCOLS). */
const LOCAL_SCHEMES = new Set(['file:', 'data:', 'blob:', 'devtools:', 'chrome:', 'local:', 'chrome-extension:']);

export type UiKind = 'vendor' | 'placeholder';

export interface BuiltApp {
  dir: string;
  ui: UiKind;
  /** Screenshots and logs of this run. */
  artifacts: string;
}

/** The placeholder renderer always runs; the vendor UI only once `npm run import-ui` produced it. */
export function availableUis(): UiKind[] {
  return existsSync(join(PORT_DIR, 'build', 'vendor-ui', 'index.html')) ? ['placeholder', 'vendor'] : ['placeholder'];
}

/** Build into artifacts/<name>/app (name defaults to the UI kind) with the chosen renderer. */
export function buildApp(ui: UiKind, name: string = ui): BuiltApp {
  const artifacts = join(ARTIFACTS, name);
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  const dir = join(artifacts, 'app');
  const args = [join(PORT_DIR, 'scripts', 'build.mjs'), '--out', dir];
  if (ui === 'placeholder') {
    args.push('--vendor-ui', join(E2E_DIR, 'fixtures', 'placeholder-ui'));
    if (!existsSync(join(PORT_DIR, 'build', 'vendor-data'))) args.push('--vendor-data', join(E2E_DIR, 'fixtures', 'vendor-data'));
  }
  const r = spawnSync(process.execPath, args, { cwd: PORT_DIR, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
  return { dir, ui, artifacts };
}

export interface NetworkRecord {
  url: string;
  kind: 'request' | 'websocket';
  failed?: string;
}

/** One GetTaskAsync request of the renderer on the app's hub (02 §4.4), with its reply once it arrived. */
export interface RpcCall {
  /** ms since launch */
  at: number;
  fn: string;
  requestId: string;
  parms: unknown;
  reply?: { at: number; errCode: number; errMsg: string | null; tag: unknown };
}

/** The renderer's hub traffic: requests and their replies (matched by RequestId), and notifications. */
export interface RpcLog {
  calls: RpcCall[];
  notifications: Array<{ at: number; body: Record<string, unknown> }>;
  /** Records on the hub socket that could not be parsed as SignalR JSON (must stay empty). */
  malformed: string[];
}

/**
 * Records the SignalR JSON records of a hub socket (02 §4.2: `{"type":1,"target":"GetTaskAsync",
 * "arguments":["<json>"]}` both ways, `"Notification"` from the backend, 0x1E-separated).
 */
function recordHub(ws: WebSocket, log: RpcLog, t0: number): void {
  const pending = new Map<string, RpcCall>();
  const parse = (payload: string | Buffer, sent: boolean) => {
    for (const record of String(payload).split('\x1e')) {
      if (!record) continue;
      let m: { type?: number; target?: string; arguments?: unknown[] };
      try {
        m = JSON.parse(record) as typeof m;
      } catch {
        log.malformed.push(record.slice(0, 200));
        continue;
      }
      if (m.type !== 1 || typeof m.arguments?.[0] !== 'string') continue; // handshake, completion, ping, close
      const at = Date.now() - t0;
      try {
        const body = JSON.parse(m.arguments[0]) as Record<string, unknown>;
        if (sent && m.target === 'GetTaskAsync') {
          const call: RpcCall = { at, fn: String(body.functionName), requestId: String(body.requestId), parms: body.parms };
          log.calls.push(call);
          pending.set(call.requestId, call);
        } else if (!sent && m.target === 'GetTaskAsync') {
          const call = pending.get(String(body.RequestId));
          if (!call) continue; // not a reply to this window (the vendor hub broadcast replies, 20 §1.4)
          pending.delete(call.requestId);
          call.reply = { at, errCode: Number(body.err_code), errMsg: (body.err_msg as string | null) ?? null, tag: body.Tag };
        } else if (!sent && m.target === 'Notification') {
          log.notifications.push({ at, body });
        }
      } catch {
        log.malformed.push(record.slice(0, 200));
      }
    }
  };
  ws.on('framesent', (f) => parse(f.payload, true));
  ws.on('framereceived', (f) => parse(f.payload, false));
}

export interface LaunchOptions {
  /** Prepare ~/.config (XDG_CONFIG_HOME) before the app starts, e.g. copy the user's Windows data in. */
  seed?: (configHome: string) => void;
}

export interface Session {
  app: ElectronApplication;
  window: Page;
  configHome: string;
  network: NetworkRecord[];
  consoleErrors: string[];
  /** Uncaught exceptions and unhandled rejections in any page ("pageerror"). */
  pageErrors: string[];
  /** The main window's hub traffic. */
  rpc: RpcLog;
  /** Date.now() at launch; RpcCall.at is relative to it. */
  startedAt: number;
  /** Main-process log lines written so far (~/.config/evnia/logs). */
  mainLog(): string;
  /** The Electron process's stderr so far (Chromium diagnostics, and the app log's console copy). */
  stderr(): string;
  close(): Promise<void>;
}

/** The main window (vendor-ui/index.html); the notice toast window loads too and may come first. */
async function mainWindow(app: ElectronApplication): Promise<Page> {
  const isMain = (p: Page) => p.url().endsWith('/vendor-ui/index.html');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const found = app.windows().find(isMain);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`main window not found; windows: ${app.windows().map((p) => p.url()).join(', ')}`);
}

export async function launch(
  built: BuiltApp,
  extraEnv: Record<string, string> = {},
  appArgs: readonly string[] = [],
  options: LaunchOptions = {},
): Promise<Session> {
  const electronPath = createRequire(import.meta.url)('electron') as unknown as string;
  const configHome = mkdtempSync(join(tmpdir(), 'evnia-e2e-'));
  options.seed?.(configHome);
  const t0 = Date.now();
  const rpc: RpcLog = { calls: [], notifications: [], malformed: [] };
  const app = await electron.launch({
    executablePath: electronPath,
    // --disable-dev-shm-usage: Docker's default /dev/shm is 64 MB. A full-window screenshot readback
    // (viz CopyOutputResult, ~8 MB at 1920x1080) on top of the renderers' shared memory exhausts it, the
    // result fails mojo deserialization and the browser kills the GPU process ("GPU process exited
    // unexpectedly: exit_code=9"). Chromium then keeps shared memory in /tmp. Test environment only.
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', built.dir, ...appArgs],
    env: {
      ...process.env,
      EVNIA_MOCK_MONITOR: '34M2C8600',
      XDG_CONFIG_HOME: configHome,
      XDG_SESSION_TYPE: 'x11',
      ...extraEnv,
    } as Record<string, string>,
    timeout: 60_000,
  });
  // Chromium's own diagnostics (GPU process, sandbox, …) go to the process's stderr, not to the app log.
  const stderr: string[] = [];
  app.process().stderr?.on('data', (d: Buffer) => stderr.push(d.toString('utf8')));
  const network: NetworkRecord[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  // Requests are recorded on the context (covers every window); the main process's own "Blocked"
  // log lines (kill-switch) are the authoritative record for anything Playwright attached too late for.
  app.context().on('request', (r) => network.push({ url: r.url(), kind: 'request' }));
  app.context().on('requestfailed', (r) => {
    const rec = network.find((n) => n.url === r.url() && n.kind === 'request' && n.failed === undefined);
    if (rec) rec.failed = r.failure()?.errorText ?? 'failed';
  });
  const watch = (page: Page) => {
    page.on('websocket', (ws) => {
      network.push({ url: ws.url(), kind: 'websocket' });
      if (page.url().endsWith('/vendor-ui/index.html') || /\/EvniaHub\?k=/.test(ws.url())) recordHub(ws, rpc, t0);
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      // For "Failed to load resource" Chromium reports the resource as the message location.
      const at = m.location()?.url;
      consoleErrors.push(`${page.url().slice(0, 80)}: ${m.text()}${at ? ` [${at}]` : ''}`);
    });
    // Uncaught exceptions and unhandled promise rejections of the page (Runtime.exceptionThrown); Chromium
    // reports them outside the console API, so the console listener above never sees them.
    page.on('pageerror', (e) => pageErrors.push(`${page.url().slice(0, 80)}: ${e.name}: ${e.message}`));
  };
  app.context().pages().forEach(watch);
  app.context().on('page', watch);
  const window = await mainWindow(app);
  return {
    app,
    window,
    configHome,
    network,
    consoleErrors,
    pageErrors,
    rpc,
    startedAt: t0,
    stderr: () => stderr.join(''),
    mainLog: () => {
      const dir = join(configHome, 'evnia', 'logs');
      if (!existsSync(dir)) return '';
      return readdirSync(dir)
        .sort()
        .map((f) => readFileSync(join(dir, f), 'utf8'))
        .join('');
    },
    close: async () => {
      await app.close().catch(() => undefined);
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

/**
 * Screenshots are artifacts, not assertions: Chromium under Xvfb occasionally refuses a capture while a
 * window is being resized, which must not fail a test. The reason is kept next to the missing image.
 */
export async function snapshot(page: Page, path: string): Promise<void> {
  try {
    await page.screenshot({ path });
  } catch (e) {
    writeFileSync(`${path}.error.txt`, e instanceof Error ? e.message : String(e));
  }
}

/** Requests that could have left the machine: anything but local schemes and the loopback hub. */
export function nonLocal(records: readonly NetworkRecord[], hubPort: number | null): NetworkRecord[] {
  return records.filter((r) => {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      return true;
    }
    if (LOCAL_SCHEMES.has(u.protocol)) return false;
    return !(u.protocol === 'ws:' && u.hostname === '127.0.0.1' && hubPort !== null && u.port === String(hubPort) && u.pathname === '/EvniaHub');
  });
}

/** One monitor page to visit once the vendor UI and the monitor driver exist (wave 2). */
export interface PageCheck {
  name: string;
  /** Run inside the main window; throw to fail. Take screenshots into ARTIFACTS. */
  run(window: Page): Promise<void>;
}
