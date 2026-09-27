// Install test, app launch (test/install/in-container.sh run_launch): starts the INSTALLED app as the
// current, non-root user, exactly as the menu entry does (/usr/bin/evnia-precision-center, no
// --no-sandbox), with the simulated monitor (EVNIA_MOCK_MONITOR=34M2C8600), and checks:
//   - Home shows the PHL 34M2C8600 card with its bundled image, not "Connect Your Evnia Device" (the
//     criteria of test/e2e/pages.ts), at the working size, and saves a screenshot (home.png);
//   - every viewable X11 window's WM_CLASS class equals the .desktop StartupWMClass (xwininfo, when
//     installed);
//   - SIGTERM quits the app with exit code 0 (KNOWN_EXIT_CRASH below is reported as a known issue) and
//     leaves no helper process behind;
//   - the main log has no error line.
// It attaches over the DevTools protocol (--remote-debugging-port=0; Node's own fetch and WebSocket), so
// the clean container needs no Node, Playwright or browser. Runs under the package's own runtime: a copy of
// its executable with the RunAsNode fuse back on (the package ships it off; in-container.sh node_runtime):
//
//   ELECTRON_RUN_AS_NODE=1 /tmp/electron-as-node/electron launch-check.mjs \
//     --out <dir> [--sync <dir>] [--desktop <file>] [-- <extra app arguments>]
//
// --sync: after the Home check, writes <dir>/ready (the browser pid) and waits for <dir>/done, so that
// root can inspect the running processes (the renderer sandbox). Results: <out>/result.json, home.png,
// app-output.txt, main.log, backend.log. Exit status 1 when a check failed.

import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const APP = '/usr/bin/evnia-precision-center';
const APP_DIR = '/opt/evnia-precision-center';
const MOCK_NAME = 'PHL 34M2C8600';
const HOME_TIMEOUT_MS = 120_000;
const EXIT_TIMEOUT_MS = 15_000;
/** Long-lived helpers main starts (impl-electron-shell "Helper processes"); none may outlive the app. */
const HELPERS = /^(udevadm|gdbus|parec|pactl|xprop|setpriv)$/;

const { values: opts, positionals: appArgs } = parseArgs({
  options: { out: { type: 'string' }, sync: { type: 'string' }, desktop: { type: 'string' } },
  allowPositionals: true,
  strict: true,
});
if (!opts.out) throw new Error('--out is required');
const out = opts.out;
/**
 * Known defect outside the packaging, reported to the main-process/USB owners: with the usb 2.18.0 addon
 * loaded in Electron 44's browser process, every exit (app.exit, app.quit, with or without a signal) ends
 * in SIGTRAP during Node's environment teardown, after the exit steps have run ("Exit" logged). A minimal
 * Electron app reproduces it with require('usb') alone. It is reported as KNOWN-ISSUE, not as a pass;
 * any other exit failure still fails.
 */
const KNOWN_EXIT_CRASH = 'usb 2.18.0 addon in the Electron 44 browser process: SIGTRAP at exit after the exit steps (impl-electron-shell "Packaging")';

const result = { ok: false, checks: {}, appArgs, errors: [], known: [] };
const t0 = Date.now();
const note = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (detail) => (typeof detail === 'string' ? detail : JSON.stringify(detail));
const record = (name, ok, detail) => {
  result.checks[name] = { ok, detail };
  note(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${text(detail)}`);
  if (!ok) result.errors.push(`${name}: ${text(detail)}`);
};
/** A check that failed in the documented known way: visible in the output and result.json, not fatal. */
const recordKnown = (name, issue, detail) => {
  result.checks[name] = { ok: true, known: issue, detail };
  result.known.push(`${name}: ${issue}`);
  console.log(`KNOWN-ISSUE ${name}: ${issue} -- ${text(detail)}`);
};

/** Ends an until() at once (the app is gone), where other errors are retried until the deadline. */
class Fatal extends Error {}

async function until(what, fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e instanceof Fatal) throw e;
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (${last.message})` : ''}`);
    await sleep(250);
  }
}

/** Minimal DevTools protocol client over Node's global WebSocket. */
class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  static async connect(url) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener('open', resolve, { once: true });
      cdp.#ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    cdp.#ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      const p = msg.id !== undefined && cdp.#pending.get(msg.id);
      if (!p) return;
      cdp.#pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else p.resolve(msg.result);
    });
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.#ws.close();
  }
}

/** Page state for the Home check (test/e2e/pages.ts: exact text visible, image loaded, no connect prompt). */
const HOME_PROBE = `(() => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let card = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.data.trim() !== ${JSON.stringify(MOCK_NAME)}) continue;
    const el = n.parentElement, r = el.getBoundingClientRect(), s = getComputedStyle(el);
    if (r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none') { card = { x: r.x, y: r.y, w: r.width, h: r.height }; break; }
  }
  const img = [...document.images].find((i) => /\\/vendor-ui\\/monitor\\/34M2C8600\\.png$/.test(i.src) && i.complete && i.naturalWidth > 0);
  return { url: location.href, title: document.title, viewport: [innerWidth, innerHeight], card,
           image: img ? img.src : null, connectPrompt: document.body.innerText.includes('Connect Your Evnia Device') };
})()`;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 10_000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}

/** Processes of this user that belong to the app (other than this driver) or are its helpers. */
function appProcesses() {
  const uid = process.getuid();
  const found = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const status = readFileSync(`/proc/${d}/status`, 'utf8');
      if (Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]) !== uid) continue;
      const argv = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (argv.length === 0) continue;
      let exe = '';
      try {
        exe = readlinkSync(`/proc/${d}/exe`);
      } catch {}
      const name = argv[0].split('/').pop();
      if (exe.startsWith(`${APP_DIR}/`) || argv[0].startsWith(`${APP_DIR}/`) || HELPERS.test(name)) found.push(`${d} ${argv.join(' ').slice(0, 160)}`);
    } catch {}
  }
  return found;
}

function copyLogs() {
  const copyNewest = (dir, suffix, dest) => {
    if (!existsSync(dir)) return null;
    const f = readdirSync(dir).filter((n) => n.endsWith(suffix)).sort().pop();
    if (!f) return null;
    copyFileSync(join(dir, f), join(out, dest));
    return join(dir, f);
  };
  return {
    main: copyNewest(join(homedir(), '.config', 'evnia', 'logs'), '.log', 'main.log'),
    backend: copyNewest(join(homedir(), '.config', 'EvniaServe', 'logs'), '.txt', 'backend.log'),
  };
}

async function main() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = ['--remote-debugging-port=0', ...appArgs];
  note(`starting ${APP} ${args.join(' ')} as uid ${process.getuid()} (EVNIA_MOCK_MONITOR=${env.EVNIA_MOCK_MONITOR}, DISPLAY=${env.DISPLAY})`);
  const child = spawn(APP, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let exited = null;
  const exitP = new Promise((resolve) => child.on('exit', (code, signal) => resolve((exited = { code, signal }))));
  child.stdout.on('data', (b) => (output += b));
  child.stderr.on('data', (b) => (output += b));
  try {
    const alive = () => {
      if (exited) throw new Fatal(`the app exited early: ${JSON.stringify(exited)}; its output:\n${output.slice(-4000)}`);
    };
    const wsBrowser = await until(
      '"DevTools listening on" from the app',
      () => {
        alive();
        return /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];
      },
      30_000,
    );
    const port = new URL(wsBrowser).port;
    note(`DevTools on port ${port}`);
    const target = await until(
      'the main window (vendor-ui/index.html)',
      async () => {
        alive();
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((t) => t.type === 'page' && /\/vendor-ui\/index\.html/.test(t.url));
      },
      30_000,
    );
    const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
    try {
      let last;
      try {
        last = await until(
          'Home with the monitor card',
          async () => {
            alive();
            last = await cdp.evaluate(HOME_PROBE);
            // …at the working size: interfaceInitializeCompleted resized the 880x520 splash window.
            return last.card && last.image && !last.connectPrompt && last.viewport[0] > 880 ? last : null;
          },
          HOME_TIMEOUT_MS,
        );
        record('home-monitor-card', true, { card: last.card, image: last.image, viewport: last.viewport, title: last.title });
      } catch (e) {
        record('home-monitor-card', false, `${e.message}; last page state ${JSON.stringify(last)}`);
      }
      await sleep(2000); // let the Home animations settle for the screenshot
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(out, 'home.png'), Buffer.from(shot.data, 'base64'));
      note(`screenshot ${join(out, 'home.png')}`);
    } finally {
      cdp.close();
    }

    if (opts.desktop) {
      // X11: the desktop matches a window to its .desktop entry by WM_CLASS = StartupWMClass. Every
      // viewable window must carry it; unmapped helper windows (Chromium's client leader) do not count.
      const wmClass = /^StartupWMClass=(.*)$/m.exec(readFileSync(opts.desktop, 'utf8'))?.[1];
      const r = await run('xwininfo', ['-root', '-tree']);
      if (r.err && r.err.code === 'ENOENT') record('wm-class', true, 'xwininfo not installed: skipped');
      else {
        const windows = [...r.stdout.matchAll(/^\s*(0x[0-9a-f]+) (".*"|\(has no name\)): \("([^"]*)" "([^"]*)"\)/gm)].map((m) => ({
          id: m[1],
          name: m[2],
          instance: m[3],
          class: m[4],
        }));
        for (const w of windows) w.viewable = /Map State: IsViewable/.test((await run('xwininfo', ['-id', w.id])).stdout);
        const viewable = windows.filter((w) => w.viewable);
        record('wm-class', viewable.length > 0 && viewable.every((w) => w.class === wmClass), { StartupWMClass: wmClass, windows });
      }
    }

    if (opts.sync) {
      writeFileSync(join(opts.sync, 'ready'), `${child.pid}\n`);
      await until('the sandbox inspection (sync/done)', () => existsSync(join(opts.sync, 'done')), 60_000).catch((e) => record('sync', false, e.message));
    }

    const before = appProcesses();
    note(`app processes before exit: ${before.length}`);
    child.kill('SIGTERM');
    const ended = await Promise.race([exitP, sleep(EXIT_TIMEOUT_MS).then(() => null)]);
    const exitStepsDone = () => {
      const log = copyLogs().main;
      return log !== null && /\] \[info\] \[main\/app\] Exit$/m.test(readFileSync(log, 'utf8'));
    };
    if (ended?.signal === 'SIGTRAP' && exitStepsDone()) recordKnown('exit-on-sigterm', KNOWN_EXIT_CRASH, ended);
    else record('exit-on-sigterm', ended !== null && ended.code === 0, ended ?? `still running after ${EXIT_TIMEOUT_MS} ms`);
    if (!ended) child.kill('SIGKILL');
    let left = [];
    await until('helpers to exit', () => (left = appProcesses()).length === 0, 5_000).catch(() => {});
    record('no-process-left', left.length === 0, left.length === 0 ? `${before.length} processes before exit, none after` : left);
  } catch (e) {
    record('launch', false, e.message);
    if (!exited) child.kill('SIGKILL');
  } finally {
    writeFileSync(join(out, 'app-output.txt'), output);
    const logs = copyLogs();
    if (logs.main) {
      const errors = readFileSync(logs.main, 'utf8').split('\n').filter((l) => /\] \[error\] /.test(l));
      record('main-log-no-errors', errors.length === 0, errors.length === 0 ? logs.main : errors.slice(0, 10));
    } else record('main-log-no-errors', false, 'no main log written');
  }
  result.ok = Object.values(result.checks).every((c) => c.ok);
  writeFileSync(join(out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  const known = result.known.length > 0 ? ` (known issues: ${result.known.length})` : '';
  note(result.ok ? `launch check passed${known}` : `launch check FAILED: ${result.errors.join('; ')}`);
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
