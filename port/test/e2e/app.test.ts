// End-to-end: the app boots under Xvfb, creates its window, starts the in-process backend and the
// loopback hub, and never talks to the network. See harness.ts for how to run it.
//
// Two suites: "placeholder" (always) drives the shell contract with fixtures/placeholder-ui, including a
// deliberate outbound request that the kill-switch must cancel; "vendor" (after npm run import-ui) runs
// the real renderer and then the per-page checks of pages.ts.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import WebSocket from 'ws';
import { availableUis, buildApp, launch, nonLocal, snapshot, type BuiltApp, type Session, type UiKind } from './harness.ts';
import { MONITOR_PAGE_CHECKS } from './pages.ts';

/** What the preload exposes to the page, as seen from test code evaluated in the renderer. */
interface ShellWindow {
  ipc?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
  store?: { get(key: string): unknown };
  nodeApi?: { pathJoin(...p: string[]): string };
  __EVNIA__?: {
    platform: string;
    hubToken: string;
    experimental?: { get(): { eneFrameBurst: boolean; forcedByEnv: boolean }; setEneFrameBurst(on: unknown): Promise<void> };
  };
  require?: unknown;
  process?: unknown;
  __placeholderResult?: { done: boolean; hubPort: number; steps: Record<string, { ok: boolean; detail: unknown }> };
}

const PROBE = 'https://kill-switch-probe.invalid/';
/** The vendor renderer's deliberate miss of a monitor's "_overview" face (see CONSOLE_ERROR_ALLOWLIST). */
const OVERVIEW_MISS = /Failed to load resource: net::ERR_FILE_NOT_FOUND \[(file:\/\/\/.*\/vendor-ui\/monitor\/([^/]+))_overview\.png\]$/;

/**
 * Console errors a suite may show (ARCHITECTURE "Build and test pipeline" 4: no console errors).
 * Anything else fails the run; wave 2 adds entries here only with a reason.
 */
const CONSOLE_ERROR_ALLOWLIST: Readonly<Record<UiKind, readonly RegExp[]>> = {
  // the placeholder's deliberate fetch of PROBE, cancelled by the kill-switch
  placeholder: [/Failed to load resource: net::ERR_BLOCKED_BY_CLIENT( \[https:\/\/kill-switch-probe\.invalid\/probe\])?$/],
  // The vendor DeviceImage component tries <model>_overview.png first and switches to <model>.png in its
  // error handler (styles-DAnQi2A8.js:33376-33384, `src.endsWith("overview.png")`); the installer ships no
  // 34M2C8600_overview.png, so Chromium logs the miss. Only accepted together with the loaded fallback
  // (checked in "no unexpected console errors").
  vendor: [OVERVIEW_MISS],
};
const skip = process.env.DISPLAY ? false : 'no X display: run under xvfb-run (see test/e2e/harness.ts)';

async function waitFor<T>(what: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function hubPortFromSocket(s: Session): number | null {
  const ws = s.network.find((r) => r.kind === 'websocket' && /^ws:\/\/127\.0\.0\.1:\d+\/EvniaHub\?k=./.test(r.url));
  return ws ? Number(new URL(ws.url).port) : null;
}

for (const ui of availableUis()) {
  describe(`${ui} renderer`, { skip }, () => {
    let built: BuiltApp;
    let s: Session;
    let hubPort: number | null = null;
    const is = (kind: UiKind) => ui === kind;

    before(async () => {
      built = buildApp(ui);
      s = await launch(built);
    });

    after(async () => {
      if (!s) return;
      writeFileSync(join(built.artifacts, 'network.json'), JSON.stringify(s.network, null, 2));
      writeFileSync(join(built.artifacts, 'console-errors.txt'), s.consoleErrors.join('\n'));
      writeFileSync(join(built.artifacts, 'page-errors.txt'), s.pageErrors.join('\n'));
      writeFileSync(join(built.artifacts, 'main.log'), s.mainLog());
      await s.close();
    });

    test('main window is created and the renderer loads with the sandboxed preload', { timeout: 60_000 }, async () => {
      await s.window.waitForLoadState('domcontentloaded');
      const shape = await s.window.evaluate(() => {
        const w = window as unknown as ShellWindow;
        return {
          ipc: typeof w.ipc?.invoke,
          store: typeof w.store?.get,
          nodeApi: typeof w.nodeApi?.pathJoin,
          platform: w.__EVNIA__?.platform,
          // Node integration must be off: no require/process in the page.
          require: typeof w.require,
          process: typeof w.process,
        };
      });
      assert.deepEqual(shape, { ipc: 'function', store: 'function', nodeApi: 'function', platform: 'linux', require: 'undefined', process: 'undefined' });
      // The port's experiments across the real contextBridge (the FAST-LED-UPLOAD checkbox's API): a synchronous
      // snapshot, and a setter that main refuses for anything but a boolean.
      const experimental = await s.window.evaluate(async () => {
        const x = (window as unknown as ShellWindow).__EVNIA__?.experimental;
        const refused = await x?.setEneFrameBurst('yes').then(
          () => 'accepted',
          (e: unknown) => String(e),
        );
        return { get: x?.get(), refused };
      });
      assert.deepEqual(experimental.get, { eneFrameBurst: false, forcedByEnv: false });
      assert.match(String(experimental.refused), /setEneFrameBurst expects a boolean/);
      assert.deepEqual(await s.window.evaluate(() => window.innerWidth), 880, 'splash window is 880 wide (01 §4)');
      await snapshot(s.window, join(built.artifacts, 'boot.png'));
    });

    test('backend and hub start; the renderer connects over the token-protected loopback hub', { timeout: 90_000 }, async () => {
      if (is('placeholder')) {
        await s.window.waitForFunction(() => (window as unknown as ShellWindow).__placeholderResult?.done === true, undefined, { timeout: 60_000 });
        const result = await s.window.evaluate(() => (window as unknown as ShellWindow).__placeholderResult!);
        const failed = Object.entries(result.steps).filter(([, v]) => !v.ok);
        assert.deepEqual(failed, [], `failed steps: ${JSON.stringify(failed, null, 2)}`);
        // The placeholder connects immediately; its own hub round trip (checked above) is the proof.
        hubPort = result.hubPort;
      } else {
        // The vendor Startup view sleeps 3 s before startupBackendService (02 §4.8).
        hubPort = await waitFor('the renderer hub socket', () => hubPortFromSocket(s), 60_000);
      }
      assert.ok(hubPort > 0);
      await snapshot(s.window, join(built.artifacts, 'startup.png'));
    });

    test('hub refuses connections without the per-launch token', { timeout: 30_000 }, async () => {
      assert.ok(hubPort, 'hub port known from the startup test');
      const outcome = await new Promise<number | string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/EvniaHub`);
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => {
          ws.close();
          resolve('open');
        });
        ws.on('error', (e) => resolve(e.message));
      });
      assert.notEqual(outcome, 'open');
    });

    test('interfaceInitializeCompleted resizes the window to the working size', { timeout: 30_000 }, async () => {
      const size = await waitFor(
        'the working size (run Xvfb with a 1920x1080 screen)',
        async () => {
          const sz = await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((b) => b.isResizable())?.getSize() ?? null);
          return sz && sz[0] >= 1280 && sz[1] >= 720 ? sz : null;
        },
        15_000,
      );
      assert.ok(size[0] >= 1280 && size[1] >= 720);
      await snapshot(s.window, join(built.artifacts, 'working-size.png'));
    });

    if (is('vendor')) {
      for (const check of MONITOR_PAGE_CHECKS) {
        test(`page: ${check.name}`, { timeout: 60_000 }, async () => {
          await check.run(s.window);
        });
      }
    }

    test('no request left the machine', { timeout: 30_000 }, async () => {
      if (is('vendor')) await s.window.waitForTimeout(3000); // let the post-connect startup calls run
      const offending = nonLocal(s.network, hubPort).filter((r) => !(is('placeholder') && r.url.startsWith(PROBE)));
      assert.deepEqual(offending, [], `non-local requests: ${JSON.stringify(offending, null, 2)}`);
      // Every cancelled request is logged by the main process, whatever Playwright observed.
      const blocked = s.mainLog().split('\n').filter((l) => /\] Blocked \S+ request to /.test(l));
      assert.deepEqual(blocked.filter((l) => !(is('placeholder') && l.includes('kill-switch-probe.invalid'))), [], 'unexpected outbound attempts');
      if (is('placeholder')) {
        assert.ok(s.network.find((r) => r.url.startsWith(PROBE))?.failed, 'the probe request must fail');
        assert.match(s.mainLog(), /Blocked \S+ request to https:\/\/kill-switch-probe\.invalid\/probe/);
      }
      await snapshot(s.window, join(built.artifacts, 'final.png'));
    });

    test('no unexpected console errors in any window', () => {
      const unexpected = s.consoleErrors.filter((line) => !CONSOLE_ERROR_ALLOWLIST[ui].some((re) => re.test(line)));
      assert.deepEqual(unexpected, [], `console errors:\n${unexpected.join('\n')}`);
      // uncaught exceptions / unhandled rejections are reported outside the console (harness "pageerror")
      assert.deepEqual(s.pageErrors, [], 'renderer exceptions');
      // an allowed overview miss must have been followed by the vendor's fallback image, loaded
      for (const line of s.consoleErrors) {
        const miss = OVERVIEW_MISS.exec(line);
        if (!miss) continue;
        const fallback = s.network.find((r) => r.url === `${miss[1]}.png`);
        assert.ok(fallback && !fallback.failed, `${miss[2]}_overview.png missed without its ${miss[2]}.png fallback`);
      }
    });
  });
}

// Login autostart with autoStartupMinimize passes --openAsHidden (01 §3.4). Hidden is only reachable
// through a tray icon; the container has no D-Bus, so a GNOME session means "no tray host" and a
// non-GNOME X11 session means an XEmbed tray (src/main/tray-host.ts).
describe('--openAsHidden', { skip }, () => {
  let built: BuiltApp;
  before(() => {
    built = buildApp('placeholder', 'hidden');
  });

  const mainVisible = (s: Session) =>
    s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/vendor-ui/index.html'))?.isVisible() ?? null);

  for (const [desktop, tray] of [['GNOME', false], ['XFCE', true]] as const) {
    test(`${desktop}: ${tray ? 'stays hidden in the tray' : 'no tray host, so the window is shown'}`, { timeout: 90_000 }, async () => {
      const s = await launch(built, { XDG_CURRENT_DESKTOP: desktop }, ['--openAsHidden']);
      try {
        await waitFor('main window start', () => /--OpenAsHidden (1|-1)/.test(s.mainLog()), 30_000);
        assert.match(s.mainLog(), tray ? /--OpenAsHidden 1/ : /--openAsHidden ignored: no system tray[\s\S]*--OpenAsHidden -1/);
        if (tray) {
          await s.window.waitForFunction(() => (window as unknown as ShellWindow).__placeholderResult?.done === true, undefined, { timeout: 60_000 });
          await s.window.waitForTimeout(1000); // past interfaceInitializeCompleted's resize
          assert.equal(await mainVisible(s), false);
        } else {
          assert.equal(await waitFor('the window shown', () => mainVisible(s), 15_000), true);
        }
      } finally {
        writeFileSync(join(built.artifacts, `main-${desktop}.log`), s.mainLog());
        await s.close();
      }
    });
  }
});
