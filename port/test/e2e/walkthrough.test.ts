// End-to-end walkthrough of the real vendor UI against the simulated 34M2C8600 (ARCHITECTURE "Build and
// test pipeline" 4; 03 §4 page by page). Runs only when build/vendor-ui exists (npm run import-ui) and an
// X display is available:
//   xvfb-run -a -s "-screen 0 1920x1080x24" node --test test/e2e/walkthrough.test.ts
//
// Two runs, each a fresh app launch:
//   34M2C8600         simulated monitor + ENE Ambiglow MCU, first-run configuration (the vendor tutorials
//                     are walked through): the ENE Ambiglow page (09 §5, 03 §4.5 ENE path)
//   34M2C8600-no-ene  the user's hardware on 2026-09-26 (golden session: no ENE on the bus) with the user's
//                     real Windows data (test/fixtures/windows: config.json, DataTheme.cfg, Default.pcenter,
//                     SoftConfig.data, data.json) migrated into ~/.config: the DDC Ambiglow page
//
// Every step visits a page or tab, performs what a user would, asserts that the simulated monitor or ENE
// changed accordingly (through the main process's mock probe, src/main/mock-probe.ts), and screenshots to
// artifacts/walkthrough/<run>/NN-<page>.png. After every step (Walk.step):
//   - no renderer console error beyond the documented benign ones (CONSOLE_ALLOWLIST);
//   - no renderer exception (uncaught error, unhandled rejection) beyond the one each tolerated vendor reply
//     causes (RPC_ALLOWLIST pageError);
//   - no GetTaskAsync reply with err_code != 0 beyond the documented vendor ones (RPC_ALLOWLIST), no
//     request left without a reply (hang), no malformed hub record;
//   - no loading overlay left visible (Walk.settle waits for every reply and the overlays);
//   - no request leaving the machine: nothing non-local recorded, and the main process's kill-switch log
//     holds exactly the deliberate probe of step 00;
//   - no unhandled rejection / uncaught exception / crashed child process in the main log.

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { Page } from 'playwright-core';
import { MOCK_SERIAL } from '../../src/backend/ddc/transports/mock-34m2c8600.ts';
import type { MockProbeSnapshot } from '../../src/main/mock-probe.ts';
import { ARTIFACTS, availableUis, buildApp, nonLocal, launch, PORT_DIR, snapshot, type BuiltApp, type RpcCall, type Session } from './harness.ts';
import {
  chooseOption,
  menuItem,
  menuTexts,
  overlaysHidden,
  setSlider,
  sidebarIcon,
  toolbarIcon,
  walkTutorial,
} from './vendor-ui.ts';

const MOCK_NAME = 'PHL 34M2C8600';
/** The simulated monitor's serial (synthetic: the shipped mock carries no identifier of the user's unit). */
const MOCK_SN = MOCK_SERIAL;
const WALK_DIR = join(ARTIFACTS, 'walkthrough');
const WINDOWS_DATA = join(PORT_DIR, 'test', 'fixtures', 'windows');
/** A request without a reply after this long is a hang (the longest vendor call is the ~11 s SmartFrame switch). */
const HANG_MS = 20_000;
/** Requests the vendor renderer re-issues continuously while a page is open (never "settled"). */
const POLLED = new Set(['Effect_GetLEDs', 'Effect_CheckDynamicLightingEnabled']);
/** The deliberate kill-switch probe of step 00. */
const PROBE_URL = 'https://kill-switch-probe.invalid/walkthrough';

// VCP codes (06 §6; TPV extended codes as 0xE2A0xx, 07 §4.8)
const VCP = {
  luminance: 0x10,
  input: 0x60,
  volume: 0x62,
  smartImage: 0xdc,
  adaptiveSync: 0xe2a040,
  ambiglowMode: 0xe2a019,
  ambiglowColor: 0xe2a01a,
} as const;

/**
 * Console errors the vendor renderer produces by design. Anything else fails the step.
 * - DeviceImage tries <model>_overview.png first and switches to <model>.png in its error handler
 *   (styles-DAnQi2A8.js:33376-33384); the installer ships no 34M2C8600_overview.png. Accepted only with
 *   the fallback loaded (checked in Walk.step).
 */
const OVERVIEW_MISS = /Failed to load resource: net::ERR_FILE_NOT_FOUND \[(file:\/\/\/.*\/vendor-ui\/monitor\/([^/]+))_overview\.png\]$/;
const CONSOLE_ALLOWLIST: readonly RegExp[] = [
  OVERVIEW_MISS,
  // Applications → "+" → Path: ThemeHeader's v() pushes {path, icon: ""} and only then awaits Comm_GenAppIcon
  // (styles-DAnQi2A8.js:42549-42557), so the bind-icon <img src={"local:///" + icon}> (:42647) is requested
  // once with an empty path, which main's local: handler answers 404 (not an image below an allowed root).
  /^file:\/\/\/profile: Failed to load resource: the server responded with a status of 404 \(Not Found\) \[local:\/\/\/\]$/,
  // DeviceImage before the monitor's ModelName is known (the Monitor shell mounting while Profile_GetDeviceData is
  // still in flight): an empty model token gives "local:///" + pathJoin(userData, "ImageCache", "", "normal.png")
  // (ST:33331-33366); its error handler shows the generic image until the model arrives and the bundled image
  // replaces it (ST:33376-33386). Timing-dependent; only this empty-model form is accepted.
  /: Failed to load resource: the server responded with a status of 404 \(Not Found\) \[local:\/\/\/\/[^\]]*\/evnia\/ImageCache\/(normal|overview|rear|source)\.png\]$/,
];

/**
 * Replies with err_code != 0 that are the vendor's behaviour (fn + err_msg), each with the unhandled
 * rejection it causes in the vendor renderer (`pageError`: one page error per tolerated reply, in that step
 * or a later one, since Chromium may report it after the step settled). `why` is for the reader.
 */
const RPC_ALLOWLIST: ReadonlyArray<{ fn: string; msg: RegExp; pageError?: RegExp; why: string }> = [
  {
    // Switching the ENE effect off: LightSync's watch on `enable` (LightSync-B-QWSZnT.js:375-380, R()
    // :382-391) sends SyncEffect_EnableDevice(dt, "[]") and chains .then() without a catch. With the effect
    // off the display's EffectDetail is the base class's null (CDevice_PHLDisplay.cs:99-108,
    // CDeviceEffectBase.cs:18), so the vendor answers this error (SystemOper.cs:1631) and the renderer's
    // Jc.invoke rejects (styles-DAnQi2A8.js:7925-7929): an unhandled rejection with no visible effect.
    fn: 'SyncEffect_EnableDevice',
    msg: /^Input device=100000 EffectDetail is null$/,
    // the rejected {code, msg} object: Playwright's pageerror has no name and the message "Object"
    pageError: /^file:\/\/\/monitor\/ambiglow: : Object$/,
    why: 'vendor: clearing light sync while the effect is off',
  },
  {
    // The FollowVideo/FollowAudio LED preview re-issues Effect_GetLEDs 30 ms after each reply and has no
    // catch (Ambiglow-Dvqon39u.js:255-263): a poll still in flight when the effect leaves Follow* gets the
    // vendor's rejection (03 §4.5; CDevice_PHLDisplay.cs, api/effect.ts), which is how that loop ends.
    fn: 'Effect_GetLEDs',
    msg: /^not ene follow video or audio$/,
    pageError: /^file:\/\/\/monitor\/ambiglow: : Object$/,
    why: 'vendor: the LED preview loop ends on the first rejection',
  },
];

interface Run {
  name: string;
  mock: string;
  ene: boolean;
  seed?: (configHome: string) => void;
}

const RUNS: Run[] = [
  { name: '34M2C8600', mock: '34M2C8600', ene: true },
  {
    name: '34M2C8600-no-ene',
    mock: '34M2C8600/no-ene',
    ene: false,
    // The user's Windows %APPDATA%\evnia and %APPDATA%\EvniaServe, copied as a user migrating would.
    seed: (home) => {
      cpSync(join(WINDOWS_DATA, 'evnia'), join(home, 'evnia'), { recursive: true });
      cpSync(join(WINDOWS_DATA, 'EvniaServe'), join(home, 'EvniaServe'), { recursive: true });
    },
  },
];

const skip = !process.env.DISPLAY
  ? 'no X display: run under xvfb-run (see test/e2e/harness.ts)'
  : !availableUis().includes('vendor')
    ? 'build/vendor-ui missing: run npm run import-ui first'
    : false;

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${String(last)}` : ''}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

class Walk {
  readonly s: Session;
  readonly dir: string;
  readonly run: Run;
  #n = 0;
  #consoleSeen = 0;
  #pageErrorsSeen = 0;
  /**
   * One entry per tolerated vendor rejection (RPC_ALLOWLIST pageError), consumed by the page error it causes;
   * kept across steps because Chromium may report the page error after the step settled.
   */
  readonly #toleratedPageErrors: RegExp[] = [];
  readonly #notes = new Map<string, number>();
  readonly #reported = new Set<RpcCall>();
  hubPort: number | null = null;

  constructor(s: Session, run: Run) {
    this.s = s;
    this.run = run;
    this.dir = join(WALK_DIR, run.name);
  }

  get w(): Page {
    return this.s.window;
  }

  /** Values one step remembers for a later one. */
  note(key: string, value: number): void {
    this.#notes.set(key, value);
  }

  noted(key: string): number {
    const v = this.#notes.get(key);
    assert.notEqual(v, undefined, `no value noted for ${key} (an earlier step failed)`);
    return v!;
  }

  /** The simulated hardware (src/main/mock-probe.ts), read in the main process. */
  probe(): Promise<MockProbeSnapshot> {
    return this.s.app.evaluate(() => {
      const p = (globalThis as unknown as Record<string, { snapshot(): unknown }>).__evniaMockProbe;
      if (!p) throw new Error('mock probe not installed (EVNIA_MOCK_MONITOR unset?)');
      return p.snapshot();
    }) as Promise<MockProbeSnapshot>;
  }

  /** Monitor off/on (MockProbe.unplugMonitor/replugMonitor). */
  hotplug(what: 'unplugMonitor' | 'replugMonitor'): Promise<boolean> {
    return this.s.app.evaluate(
      (_electron, fn) => (globalThis as unknown as Record<string, Record<string, () => Promise<boolean>>>).__evniaMockProbe[fn](),
      what,
    );
  }

  /** The simulated input idle time (null: the real source). */
  async setIdleSeconds(seconds: number | null): Promise<void> {
    await this.s.app.evaluate(
      (_electron, v) => (globalThis as unknown as Record<string, { setIdleSeconds(v: number | null): void }>).__evniaMockProbe.setIdleSeconds(v),
      seconds,
    );
  }

  /**
   * A frameless window of one colour over the whole (Xvfb) screen, opened from main, so the Follow video capture sees
   * a known picture: every LED gets the same colour. Shown inactive (the app window keeps the focus; Playwright's
   * input goes to the page over CDP, whatever covers it on the screen). Test environment only.
   */
  async solidScreen(css: string): Promise<string> {
    return this.s.app.evaluate(async ({ BrowserWindow, screen }, colour) => {
      const display = screen.getPrimaryDisplay().bounds;
      const win = new BrowserWindow({ ...display, frame: false, show: false, focusable: false, skipTaskbar: true, backgroundColor: colour });
      (globalThis as Record<string, unknown>).__evniaWalkSolidScreen = win;
      await win.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;background:${colour}"></body>`)}`);
      win.showInactive();
      win.setBounds(display);
      await new Promise((r) => setTimeout(r, 300));
      const main = BrowserWindow.getAllWindows().map((w) => `${w.id}:${JSON.stringify(w.getBounds())}:${w.isVisible()}`);
      return `display ${JSON.stringify(display)}, solid ${JSON.stringify(win.getBounds())}, windows ${main.join(' ')}`;
    }, css);
  }

  async closeSolidScreen(): Promise<void> {
    await this.s.app.evaluate(() => {
      const g = globalThis as Record<string, unknown>;
      const win = g.__evniaWalkSolidScreen as { isDestroyed(): boolean; destroy(): void } | undefined;
      if (win && !win.isDestroyed()) win.destroy();
      delete g.__evniaWalkSolidScreen;
    });
  }

  /** A change made on the monitor itself (OSD keys / the source switching HDR). */
  osdSet(code: number, value: number): Promise<boolean> {
    return this.s.app.evaluate(
      (_electron, [c, v]) => (globalThis as unknown as Record<string, { osdSet(c: number, v: number): boolean }>).__evniaMockProbe.osdSet(c, v),
      [code, value] as const,
    );
  }

  async vcp(code: number): Promise<number> {
    const v = (await this.probe()).vcp[code];
    assert.notEqual(v, undefined, `the simulated monitor has no control 0x${code.toString(16)}`);
    return v;
  }

  /** Wait until the simulated monitor holds `value` for `code` (after a UI action). */
  async expectVcp(code: number, value: number, what: string): Promise<void> {
    await until(`${what}: monitor VCP 0x${code.toString(16)} = ${value}`, async () => (await this.vcp(code)) === value);
  }

  /** Writes the monitor received since `from` (index into snapshot.writes). */
  async writesSince(from: number): Promise<Array<[number, number]>> {
    return (await this.probe()).writes.slice(from);
  }

  async writeCount(): Promise<number> {
    return (await this.probe()).writes.length;
  }

  /**
   * Every request answered and no loading overlay, twice in a row 250 ms apart (the vendor shows the
   * overlay 100 ms after loadingShow, styles-DAnQi2A8.js:8296-8302). Only the continuous preview poll
   * (Effect_GetLEDs, re-issued 30 ms after each reply, 03 §4.5) may be in flight, and not for long.
   * A stuck overlay or a hung request fails the step after `timeoutMs`.
   */
  async settle(timeoutMs = 45_000): Promise<void> {
    const quiet = async () => {
      const now = Date.now() - this.s.startedAt;
      const pending = this.s.rpc.calls.filter((c) => !c.reply && !(POLLED.has(c.fn) && now - c.at < 1500));
      return pending.length === 0 && (await overlaysHidden(this.w));
    };
    await until(
      'the UI to settle (loading overlays hidden, every request answered)',
      async () => {
        if (!(await quiet())) return false;
        await this.w.waitForTimeout(250);
        return quiet();
      },
      timeoutMs,
    );
  }

  /** An extra screenshot inside the current step's action: NN-<label>.png next to the step's own NN-<name>.png. */
  async shot(label: string): Promise<void> {
    await snapshot(this.w, join(this.dir, `${String(this.#n - 1).padStart(2, '0')}-${label}.png`));
  }

  /** One walkthrough step: act, settle, screenshot NN-<name>.png, then the global assertions. */
  async step(name: string, action: () => Promise<void>): Promise<void> {
    const file = `${String(this.#n++).padStart(2, '0')}-${name}`;
    try {
      await action();
      await this.settle();
    } catch (e) {
      await snapshot(this.w, join(this.dir, `${file}.failed.png`));
      writeFileSync(join(this.dir, `${file}.failed.html`), await this.w.content().catch(() => ''));
      throw e;
    } finally {
      this.#dumpRpc();
    }
    await snapshot(this.w, join(this.dir, `${file}.png`));
    try {
      this.checkGlobal(name);
    } catch (e) {
      writeFileSync(join(this.dir, `${file}.failed.txt`), e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /** The assertions of the header, over everything recorded so far (new console lines since the last step). */
  checkGlobal(where: string): void {
    const s = this.s;
    const lines = s.consoleErrors.slice(this.#consoleSeen);
    this.#consoleSeen = s.consoleErrors.length;
    const unexpected = lines.filter((l) => !CONSOLE_ALLOWLIST.some((re) => re.test(l)));
    assert.deepEqual(unexpected, [], `${where}: renderer console errors`);
    for (const line of lines) {
      const miss = OVERVIEW_MISS.exec(line);
      if (!miss) continue;
      const fallback = s.network.find((r) => r.url === `${miss[1]}.png`);
      assert.ok(fallback && !fallback.failed, `${where}: ${miss[2]}_overview.png missed without its ${miss[2]}.png fallback`);
    }

    const now = Date.now() - s.startedAt;
    const failed: string[] = [];
    const tolerated = this.#toleratedPageErrors;
    for (const c of s.rpc.calls) {
      if (this.#reported.has(c)) continue;
      if (c.reply) {
        this.#reported.add(c);
        if (c.reply.errCode === 0) continue;
        const allowed = RPC_ALLOWLIST.find((a) => a.fn === c.fn && a.msg.test(c.reply!.errMsg ?? ''));
        if (allowed) {
          if (allowed.pageError) tolerated.push(allowed.pageError);
          continue;
        }
        failed.push(`${c.fn}(${JSON.stringify(c.parms)}) → err_code ${c.reply.errCode}: ${c.reply.errMsg}`);
      } else if (now - c.at > HANG_MS) {
        this.#reported.add(c);
        failed.push(`${c.fn}(${JSON.stringify(c.parms)}) → no reply after ${now - c.at} ms (hang)`);
      }
    }
    assert.deepEqual(failed, [], `${where}: backend requests failed`);
    assert.deepEqual(s.rpc.malformed, [], `${where}: malformed hub records`);
    // renderer exceptions / unhandled rejections: only the one each tolerated vendor reply causes
    const pageErrors = s.pageErrors.slice(this.#pageErrorsSeen);
    this.#pageErrorsSeen = s.pageErrors.length;
    const unexplained = pageErrors.filter((e) => {
      const i = tolerated.findIndex((re) => re.test(e));
      if (i < 0) return true;
      tolerated.splice(i, 1);
      return false;
    });
    assert.deepEqual(unexplained, [], `${where}: renderer exceptions`);

    const offending = nonLocal(s.network, this.hubPort).filter((r) => !(r.url === PROBE_URL && r.failed));
    assert.deepEqual(offending, [], `${where}: non-local requests (the probe must have failed)`);
    const log = s.mainLog();
    const blocked = log.split('\n').filter((l) => /\] Blocked \S+ request to /.test(l));
    assert.deepEqual(
      blocked.filter((l) => !l.includes(PROBE_URL)),
      [],
      `${where}: outbound attempts in the kill-switch log`,
    );
    const crashes = log.split('\n').filter((l) => /Unhandled rejection|An uncaught \S+ error occurred|Render progress gone|Child progress gone/.test(l));
    assert.deepEqual(crashes, [], `${where}: main process errors`);
  }

  #dumpRpc(): void {
    const lines = this.s.rpc.calls.map((c) => {
      const r = c.reply;
      const tag = r ? JSON.stringify(r.tag) : '';
      return `${(c.at / 1000).toFixed(2)} ${c.fn} ${JSON.stringify(c.parms)} → ${
        r ? `[${((r.at - c.at) / 1000).toFixed(2)} s] ${r.errCode}${r.errMsg ? ` ${JSON.stringify(r.errMsg)}` : ''} ${tag.length > 300 ? `${tag.slice(0, 300)}…` : tag}` : 'PENDING'
      }`;
    });
    writeFileSync(join(this.dir, 'rpc.log'), `${lines.join('\n')}\n`);
    const notes = this.s.rpc.notifications.map((n) => `${(n.at / 1000).toFixed(2)} ${JSON.stringify(n.body)}`);
    writeFileSync(join(this.dir, 'notifications.log'), `${notes.join('\n')}\n`);
  }
}

/** The theme index the backend keeps (20-theme §3: UTF-8 BOM, one JSON line). */
function dataTheme(configHome: string): { ThemeInfos: Array<{ Name: string; SelProfileName: string; ProfileNames: string[] }> } {
  const text = readFileSync(join(configHome, 'EvniaServe', 'Theme', 'DataTheme.cfg'), 'utf8').replace(/^﻿/, '');
  return JSON.parse(text.split(/\r?\n/)[0]);
}

/** ~/.config/evnia/config.json (main's electron-store compatible settings, tab-indented JSON). */
function configJson(configHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configHome, 'evnia', 'config.json'), 'utf8')) as Record<string, unknown>;
}

/** The six segment writes of one 34M2C8600 frame (09 §7.3) as the mock probe lists them ([register, length]). */
const SIX_WRITES: Array<[number, number]> = [
  [0xe300, 9],
  [0xe309, 12],
  [0xe315, 12],
  [0xe321, 9],
  [0xe32a, 54],
  [0xe360, 42],
];

/**
 * Recent frame-buffer writes that hold a whole frame as the six segments, in order, and no single-transfer burst. (A
 * snapshot can fall in the middle of a frame, so the list need not start or end on a frame boundary.)
 */
function sixWritesOnly(recent: ReadonlyArray<readonly [number, number]>): boolean {
  const inner = (list: ReadonlyArray<readonly [number, number]>) => JSON.stringify(list).slice(1, -1);
  return !recent.some(([, length]) => length === 138) && inner(recent).includes(inner(SIX_WRITES));
}

/** R,G,B per LED of a frame buffer (or of an Effect_GetLEDs reply). */
const ledTriples = (frame: readonly number[]): Array<[number, number, number]> =>
  Array.from({ length: Math.floor(frame.length / 3) }, (_, i): [number, number, number] => [frame[3 * i], frame[3 * i + 1], frame[3 * i + 2]]);
const nearColour = (a: readonly number[], b: readonly number[], tolerance = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tolerance);
/** LEDs whose cell the X pointer may cover: desktopCapturer draws the cursor into the screen frames. */
const POINTER_LEDS = 4;

/**
 * The colour (about) every LED shows, lit: the full-screen test colour. Up to POINTER_LEDS LEDs may differ (the X
 * pointer over their cell). null otherwise.
 */
function solidColour(frame: readonly number[]): [number, number, number] | null {
  const leds = ledTriples(frame);
  let best: [number, number, number] | null = null;
  let most = 0;
  for (const candidate of leds) {
    const n = leds.filter((c) => nearColour(c, candidate)).length;
    if (n > most) [best, most] = [candidate, n];
  }
  return best && most >= leds.length - POINTER_LEDS && best.some((v) => v > 0) ? best : null;
}

/** Whether (about) every LED of `leds` is `colour` (±1), the pointer's cells aside. */
function allNear(leds: ReadonlyArray<readonly number[]>, colour: readonly number[]): boolean {
  return leds.length > 0 && leds.filter((c) => nearColour(c, colour, 1)).length >= leds.length - POINTER_LEDS;
}

function softConfig(configHome: string): Record<string, unknown> {
  const text = readFileSync(join(configHome, 'EvniaServe', 'Config', 'SoftConfig.data'), 'utf8').replace(/^﻿/, '');
  return JSON.parse(text.split(/\r?\n/)[0]);
}

/** The fields of a stored display section the walkthrough reads (T_PHLDisplay_Profile, profile mode). */
interface StoredDisplay {
  OP_DC_DisplayApplication: { Value: number };
  ModuleAudio: { OP_62_AudioSpeakerVolume: { Value: number } };
}

/**
 * The display section of a stored profile, or null while it is missing (20-theme §3: `Theme/<T>/<P>.pcenter`,
 * UTF-8 BOM, one JSON line; the section's ProfileContent is itself a JSON string).
 */
function storedDisplay(configHome: string, theme: string, profile: string): StoredDisplay | null {
  const path = join(configHome, 'EvniaServe', 'Theme', theme, `${profile}.pcenter`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
  const pcenter = JSON.parse(text.split(/\r?\n/)[0]) as { Profiles: Array<{ ProfileDesc: { DeviceType: number }; ProfileContent: string }> };
  const section = pcenter.Profiles.find((p) => p.ProfileDesc.DeviceType === 100000);
  return section ? (JSON.parse(section.ProfileContent) as StoredDisplay) : null;
}

for (const run of RUNS) {
  describe(`walkthrough ${run.name}`, { skip, concurrency: 1 }, () => {
    let built: BuiltApp;
    let walk: Walk;
    let s: Session;

    before(async () => {
      built = buildApp('vendor', join('walkthrough-app', run.name));
      rmSync(join(WALK_DIR, run.name), { recursive: true, force: true });
      mkdirSync(join(WALK_DIR, run.name), { recursive: true });
      s = await launch(built, { EVNIA_MOCK_MONITOR: run.mock }, [], { seed: run.seed });
      walk = new Walk(s, run);
    });

    after(async () => {
      if (!s) return;
      const dir = join(WALK_DIR, run.name);
      writeFileSync(join(dir, 'network.json'), JSON.stringify(s.network, null, 2));
      writeFileSync(join(dir, 'console-errors.txt'), s.consoleErrors.join('\n'));
      writeFileSync(join(dir, 'page-errors.txt'), s.pageErrors.join('\n'));
      writeFileSync(join(dir, 'main.log'), s.mainLog());
      writeFileSync(join(dir, 'stderr.log'), s.stderr());
      const backendLogs = join(s.configHome, 'EvniaServe', 'logs');
      if (existsSync(backendLogs)) {
        writeFileSync(join(dir, 'backend.log'), readdirSync(backendLogs).sort().map((f) => readFileSync(join(backendLogs, f), 'utf8')).join(''));
      }
      await s.close();
    });

    test('00 startup: the kill-switch is armed, the hub connects, Home shows the monitor card', { timeout: 120_000 }, async () => {
      // The deliberate probe: a window without the vendor CSP navigating off the machine; the main
      // process's webRequest kill-switch must cancel and log it (impl-electron-shell "Network kill-switch").
      await s.app.evaluate(async ({ BrowserWindow }, url) => {
        const probe = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        await probe.loadURL(url).catch(() => undefined);
        probe.destroy();
      }, PROBE_URL);
      await until('the kill-switch probe in the main log', () => s.mainLog().includes(`request to ${PROBE_URL}`), 10_000);
      await walk.step('home', async () => {
        walk.hubPort = await until(
          'the renderer hub socket',
          () => {
            const ws = s.network.find((r) => r.kind === 'websocket' && /^ws:\/\/127\.0\.0\.1:\d+\/EvniaHub\?k=./.test(r.url));
            return ws ? Number(new URL(ws.url).port) : null;
          },
          60_000,
        );
        await s.window.getByText(MOCK_NAME, { exact: true }).first().waitFor({ state: 'visible', timeout: 45_000 });
        await until('the bundled 34M2C8600 image', () =>
          s.window.evaluate(() => [...document.images].some((i) => /\/vendor-ui\/monitor\/34M2C8600\.png$/.test(i.src) && i.complete && i.naturalWidth > 0)),
        );
        assert.equal(await s.window.getByText('Connect Your Evnia Device').count(), 0);
        const snap = await walk.probe();
        assert.equal(snap.model, '34M2C8600');
        assert.equal(snap.ene !== null, run.ene, 'ENE presence');
        assert.equal(snap.vcp[VCP.smartImage], 33, 'the monitor starts in HDR Game (golden session)');
      });
      // First run: the vendor's Home tutorial (3 steps); the migrated Windows config has seen it already.
      const steps = await walkTutorial(s.window, !run.seed);
      assert.equal(steps, run.seed ? 0 : 3, 'Home tutorial steps');
      await walk.step('home-list-view', async () => {
        // the view toggle (ST:8878-8880): category ↔ list, remembered in config.json overviewType
        const icon = s.window.locator('.vc-icon:has(.icon-image[class*="icon-list"]), .vc-icon:has(.icon-image[class*="icon-category"])').first();
        const before = String(readConfig(s.configHome).overviewType ?? 'category');
        await icon.click();
        await until('overviewType toggled', () => String(readConfig(s.configHome).overviewType) !== before);
        await s.window.getByText(MOCK_NAME, { exact: true }).first().waitFor({ state: 'visible' });
        await icon.click();
        await until('overviewType back', () => String(readConfig(s.configHome).overviewType) === before);
      });
      await walk.step('home-rescan', async () => {
        // Rescan (the Home scan icon and the tray's Rescan): a full device scan, the monitor listed again
        const from = s.rpc.calls.length;
        await s.window.locator('.vc-icon:has(.icon-image[class*="icon-scan"])').first().click();
        await until('the rescan answered', () => s.rpc.calls.slice(from).some((c) => /Rescan|Detection|GetConnectList/.test(c.fn) && c.reply?.errCode === 0), 20_000);
        await s.window.getByText(MOCK_NAME, { exact: true }).first().waitFor({ state: 'visible' });
      });
    });

    test('01 monitor shell → SmartImage HDR: preset change reaches the monitor', { timeout: 120_000 }, async () => {
      await walk.step('smartimage-hdr', async () => {
        await s.window.getByText(MOCK_NAME, { exact: true }).first().click();
        await until('the SmartImage HDR page', () => s.window.url().endsWith('/monitor/smartImageHDR'), 30_000);
        await s.window.getByText('HDR Game', { exact: true }).first().waitFor({ state: 'visible' });
        const steps = await walkTutorial(s.window, !run.seed);
        assert.equal(steps, run.seed ? 0 : 1, 'Monitor tutorial steps');
      });
      await walk.step('smartimage-hdr-movie', async () => {
        await s.window.getByText('HDR Movie', { exact: true }).first().click();
        await walk.expectVcp(VCP.smartImage, 34, 'SmartImage HDR Movie');
      });
      await walk.step('smartimage-hdr-game', async () => {
        await s.window.getByText('HDR Game', { exact: true }).first().click();
        await walk.expectVcp(VCP.smartImage, 33, 'SmartImage HDR Game');
      });
    });

    test('02 SmartImage (SDR): the source leaves HDR, Sync re-reads, luminance and preset reach the monitor', { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('smartimage', async () => {
        // HDR switched off at the source: the monitor itself goes to SmartImage Standard (DC 0). The
        // sidebar's Sync (monitorReload → PHL_ReloadData → Profile_GetDeviceData) re-reads it, and the
        // Monitor shell redirects SmartImageHDR → SmartImage (03 §4.1 k()).
        assert.equal(await walk.osdSet(VCP.smartImage, 0), true);
        await sidebarIcon(w, 'nav_sync').click();
        await until('the SmartImage (SDR) page', () => w.url().endsWith('/monitor/smartImage'), 30_000);
        await w.getByText('Standard', { exact: true }).first().waitFor({ state: 'visible' });
        await w.locator('.vc-slider').filter({ hasText: 'Brightness' }).first().waitFor({ state: 'visible' });
        walk.note('standardLuminance', await walk.vcp(VCP.luminance));
      });
      await walk.step('smartimage-luminance', async () => {
        const from = await walk.writeCount();
        await setSlider(w, w.locator('.vc-slider').filter({ hasText: 'Brightness' }).first(), 60, 0, 100);
        await walk.expectVcp(VCP.luminance, 60, 'Brightness slider');
        assert.deepEqual(await walk.writesSince(from), [[VCP.luminance, 60]], 'exactly one luminance write');
      });
      await walk.step('smartimage-movie', async () => {
        await w.getByText('Movie', { exact: true }).first().click();
        await walk.expectVcp(VCP.smartImage, 3, 'SmartImage Movie');
      });
      await walk.step('smartimage-standard', async () => {
        await w.getByText('Standard', { exact: true }).first().click();
        await walk.expectVcp(VCP.smartImage, 0, 'SmartImage Standard');
        // the monitor keeps picture controls per mode: Standard's luminance is still the 60 set above
        assert.equal(await walk.vcp(VCP.luminance), 60);
      });
      await walk.step('smartimage-color-temperature', async () => {
        // PHL_SetColorPreset (03 §4.2): OP_14; the reply is the whole SmartImage sub-module
        const select = w.locator('.vc-select').filter({ has: w.getByText('Color Temperature', { exact: true }) }).first();
        const before = await walk.vcp(0x14);
        await chooseOption(w, select, '9300K');
        await until('colour preset written', async () => (await walk.vcp(0x14)) !== before);
      });
      await walk.step('smartimage-reset', async () => {
        // the reset icon under the preview + confirm: PHL_ResetSmartImage(0) → E2A0_42 = 0x30 (Standard, 03 §4.2)
        const from = await walk.writeCount();
        await w.locator('.vc-icon:has(> .icon-image[class*="icon-reset"])').filter({ visible: true }).first().click();
        await confirmDialog(w).getByText(/^ok$/i).click();
        await until('the SmartImage reset written', async () => (await walk.writesSince(from)).some(([c, v]) => c === 0xe2a042 && v === 0x30));
        await walk.expectVcp(VCP.luminance, walk.noted('standardLuminance'), 'Standard luminance back to its factory value');
      });
      await walk.step('smartimage-movie-again', async () => {
        // Movie for the rest of the walkthrough: Standard/EasyRead (and HDR) constraint-disable SmartFrame
        // (DisplayFuncConstraints.cs:211), which the GameMode step switches on
        await w.getByText('Movie', { exact: true }).first().click();
        await walk.expectVcp(VCP.smartImage, 3, 'SmartImage Movie');
      });
    });

    test('03 GameMode: every tab; Adaptive Sync and SmartFrame reach the monitor', { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('gamemode', async () => {
        await sidebarIcon(w, 'nav_game_mode').click();
        await until('the GameMode page', () => w.url().endsWith('/monitor/gameMode'), 15_000);
        await menuItem(w, 'Adaptive Sync').waitFor({ state: 'visible' });
      });
      const tabs = await menuTexts(w);
      assert.ok(tabs.length >= 5, `GameMode tabs: ${tabs.join(', ')}`);
      for (const tab of tabs.slice(1)) {
        await walk.step(`gamemode-${slug(tab)}`, async () => {
          await menuItem(w, tab).click();
          await until(`${tab} active`, async () => (await menuItem(w, tab).getAttribute('class'))?.includes('item-actived'));
        });
      }
      await walk.step('gamemode-adaptive-sync-off', async () => {
        await menuItem(w, 'Adaptive Sync').click();
        const before = await walk.vcp(VCP.adaptiveSync);
        await w.locator('.vc-switch').filter({ hasText: 'Adaptive Sync' }).locator('.switch-button').click();
        await until('Adaptive Sync written', async () => (await walk.vcp(VCP.adaptiveSync)) !== before);
        walk.note('adaptiveSyncOn', before);
      });
      await walk.step('gamemode-adaptive-sync-on', async () => {
        await w.locator('.vc-switch').filter({ hasText: 'Adaptive Sync' }).locator('.switch-button').click();
        await walk.expectVcp(VCP.adaptiveSync, walk.noted('adaptiveSyncOn'), 'Adaptive Sync back on');
      });
      await walk.step('gamemode-smartframe-on', async () => {
        // PHL_SwitchSmartFrame(On): E2A0_08 = 1, then the driver polls the frame brightness until its max
        // is 100 and re-reads size/position (03 §4.4, CDevice_PHLDisplay.cs 1808-1886)
        // its size/brightness/contrast sliders are disabled while it is off (GameMode-C1cXG-_T.js:450-488)
        await menuItem(w, 'SmartFrame').click();
        const disabledSliders = w.locator('.vc-slider.vc-slider__disabled');
        await until('the SmartFrame controls disabled while off', async () => (await disabledSliders.count()) > 0);
        await w.locator('.vc-switch').filter({ hasText: 'SmartFrame' }).locator('.switch-button').click();
        await walk.expectVcp(0xe2a008, 1, 'SmartFrame on');
        await until('the SmartFrame controls enabled', async () => (await disabledSliders.count()) === 0);
      });
      await walk.step('gamemode-smartframe-off', async () => {
        await w.locator('.vc-switch').filter({ hasText: 'SmartFrame' }).locator('.switch-button').click();
        await walk.expectVcp(0xe2a008, 0, 'SmartFrame off');
        await until('the SmartFrame controls disabled again', async () => (await w.locator('.vc-slider.vc-slider__disabled').count()) > 0);
      });
    });

    test(`04 Ambiglow (${run.ene ? 'ENE effects' : 'DDC fallback'}): effect and colour reach the ${run.ene ? 'ENE MCU' : 'monitor'}`, { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('ambiglow', async () => {
        await sidebarIcon(w, 'nav_ambiglow').click();
        await until('the Ambiglow page', () => w.url().endsWith('/monitor/ambiglow'), 15_000);
        await w.locator('.ambiglow-item .vc-select').first().waitFor({ state: 'visible' });
      });
      const effectSelect = w.locator('.vc-select:not(.profile-select)').first();
      if (run.ene) {
        // ENE path (03 §4.5): Effect_Change / Effect_ColorChange drive the MCU's group registers (09 §5).
        await walk.step('ambiglow-ene-breathing', async () => {
          const before = (await walk.probe()).ene!;
          assert.equal(before.hostControl, 4, 'the host drives the LEDs');
          await chooseOption(w, effectSelect, 'Breathing');
          await until('ENE group 1 re-latched with another mode', async () => {
            const g = (await walk.probe()).ene!.groups['1'];
            return g && g.mode !== before.groups['1']?.mode;
          });
        });
        await walk.step('ambiglow-ene-red', async () => {
          await w.locator('.default-colors .color-preview:not(.color-rainbow-preview)').nth(1).click();
          await until('ENE colour red', async () => JSON.stringify((await walk.probe()).ene!.groups['1']?.color) === '[255,0,0]');
          assert.deepEqual((await walk.probe()).ene!.violations, []);
          walk.note('breathingMode', (await walk.probe()).ene!.groups['1']!.mode);
        });
        await walk.step('ambiglow-ene-off', async () => {
          // Effect_Enable(false): LEDOFF, host control released (0x0023 = 0, 09 §5.3)
          await w.locator('.vc-switch').filter({ hasText: 'Effect' }).locator('.switch-button').click();
          await until('ENE released', async () => {
            const ene = (await walk.probe()).ene!;
            return ene.hostControl === 0 && ene.groups['1']?.mode === 0;
          });
        });
        await walk.step('ambiglow-ene-on', async () => {
          await w.locator('.vc-switch').filter({ hasText: 'Effect' }).locator('.switch-button').click();
          await until('ENE Breathing again', async () => {
            const ene = (await walk.probe()).ene!;
            return ene.hostControl === 4 && ene.groups['1']?.mode === walk.noted('breathingMode');
          });
        });
        await walk.step('ambiglow-ene-follow-video', async () => {
          // FollowVideo (09 §7): the capture host grabs the (Xvfb) screen, 50x40 frames → LED colours
          // uploaded to the frame buffer at 0xE300; the page previews them with Effect_GetLEDs.
          await chooseOption(w, effectSelect, 'Follow Video');
          await until(
            'screen colours in the ENE frame buffer',
            async () => (await walk.probe()).ene!.frame.some((b) => b !== 0),
            30_000,
          );
          await until('the Effect_GetLEDs preview polling', () =>
            s.rpc.calls.some((c) => c.fn === 'Effect_GetLEDs' && c.reply?.errCode === 0 && Array.isArray(c.reply.tag) && c.reply.tag.length > 0),
          );
        });
        await walk.step('ambiglow-follow-video-speed', async () => {
          // The port's Follow Video Speed slider (impl-ambiglow deviation 17): the vendor's own Ambiglow slider,
          // offered by Effect_GetMenu with SupSpeed for FollowVideo. Low = the Windows cadence (300 + 100 ms),
          // Normal (the first-run default, Speed 2) = 100 ms, High = 40 ms; a change retunes the running capture.
          const speed = w.locator('.vc-slider').filter({ hasText: 'Speed' }).first();
          await speed.waitFor({ state: 'visible' });
          assert.deepEqual((await speed.locator('.mark-line span').allInnerTexts()).map((t) => t.trim()), ['Low', 'Normal', 'High']);
          const before = (await walk.probe()).capture!;
          assert.equal(before.intervalMs, 100, 'Normal: the backend asked for a frame every 100 ms');
          const calls = s.rpc.calls.length;
          await setSlider(w, speed, 3, 1, 3);
          await until('Effect_SpeedChange(100000, 3)', () =>
            s.rpc.calls.slice(calls).some((c) => c.fn === 'Effect_SpeedChange' && JSON.stringify(c.parms) === '[100000,3]' && c.reply?.errCode === 0),
          );
          await until('the capture retuned to 40 ms (High)', async () => (await walk.probe()).capture!.intervalMs === 40);
          const after = (await walk.probe()).capture!;
          assert.equal(after.starts, before.starts, 'no new capture session (no ScreenCast dialog on Wayland)');
          assert.equal(after.retunes, before.retunes + 1);
          assert.deepEqual((await walk.probe()).ene!.violations, []);
        });
        await walk.step('ambiglow-follow-video-brightness-burst', async () => {
          // The port's Follow Video Brightness (impl-ambiglow deviation 17): the vendor's own Brightness slider, offered
          // by Effect_GetMenu with SupBrightness for FollowVideo; it dims the frames on the host (Brighter = x 2/3). And
          // the "Fast LED upload (experimental)" checkbox of the FAST-LED-UPLOAD patch (impl-usb-ene §2.2): one control
          // transfer per frame instead of six, stored in config.json. A full-screen window of one colour gives the
          // capture a known picture (every LED that colour, but for the cells under the X pointer, which desktopCapturer
          // draws into the frames).
          const brightness = w.locator('.vc-slider').filter({ hasText: 'Brightness' }).first();
          await brightness.waitFor({ state: 'visible' });
          assert.deepEqual((await brightness.locator('.mark-line span').allInnerTexts()).map((t) => t.trim()), ['Bright', 'Brighter', 'Brightest']);
          const fast = w.locator('.evnia-fast-led-upload');
          await fast.waitFor({ state: 'visible' });
          const box = fast.locator('.vc-checkbox');
          assert.equal((await box.innerText()).trim(), 'Fast LED upload (experimental)');
          assert.match(await fast.innerText(), /Sends each frame in one USB transfer\. Turn off if the lights flicker or freeze\./);
          const ticked = async () => (await box.locator('.checkbox-input-checked').count()) === 1;
          assert.equal(await ticked(), false, 'off by default');
          assert.equal((await walk.probe()).capture!.starts, 1, 'one capture session so far');
          const geometry = await walk.solidScreen('rgb(240, 160, 64)');
          try {
            let lastFrame: number[] = [];
            const full = await until(
              'the test colour on every LED (Brightest, the first-run level)',
              async () => solidColour((lastFrame = (await walk.probe()).ene!.frame)),
              30_000,
            ).catch((e: unknown) => {
              throw new Error(`${e instanceof Error ? e.message : String(e)}; ${geometry}; last frame ${JSON.stringify(lastFrame)}`);
            });
            const expected = full.map((v) => Math.round((v * 2) / 3));
            const near = (c: readonly number[] | null) => c !== null && c.every((v, i) => Math.abs(v - expected[i]) <= 1);

            // Brighter: the uploaded frames are the captured colours x 2/3, and the preview mirror shows the same.
            const calls = s.rpc.calls.length;
            await setSlider(w, brightness, 2, 1, 3);
            await until('Effect_BrightnessChange(100000, 2)', () =>
              s.rpc.calls.slice(calls).some((c) => c.fn === 'Effect_BrightnessChange' && JSON.stringify(c.parms) === '[100000,2]' && c.reply?.errCode === 0),
            );
            const dimmed = await until(`the LEDs at 2/3 of ${JSON.stringify(full)} (Brighter)`, async () => {
              const c = solidColour((await walk.probe()).ene!.frame);
              return near(c) ? c : null;
            });
            await until('the Effect_GetLEDs preview at 2/3', () =>
              s.rpc.calls.slice(calls).some((c) => {
                const tag = c.fn === 'Effect_GetLEDs' && c.reply?.errCode === 0 ? (c.reply.tag as Array<{ R: number; G: number; B: number }>) : null;
                return tag !== null && tag.length === 46 && allNear(tag.map((led) => [led.R, led.G, led.B]), expected);
              }),
            );
            const probe = await walk.probe();
            assert.equal(probe.capture!.starts, 1, 'the same capture session (no ScreenCast dialog on Wayland)');
            assert.equal(s.rpc.calls.slice(calls).filter((c) => c.fn === 'Effect_BrightnessChange').length, 1);
            assert.ok(sixWritesOnly(probe.ene!.frameWrites.recent), `so far the vendor's six paced writes per frame: ${JSON.stringify(probe.ene!.frameWrites.recent)}`);

            // Fast LED upload on: one 138-byte transfer per frame from the next frame; stored in config.json.
            let count = probe.ene!.frameWrites.count;
            await box.click();
            await until('the checkbox ticked', ticked);
            await until('frames as one control transfer at 0xE300', async () => {
              const fw = (await walk.probe()).ene!.frameWrites;
              return fw.count >= count + 3 && fw.recent.slice(-3).every(([reg, length]) => reg === 0xe300 && length === 138);
            });
            assert.deepEqual(configJson(s.configHome).linuxExperimental, { eneFrameBurst: true }, 'persisted');
            assert.ok(near(solidColour((await walk.probe()).ene!.frame)), `the same dimmed colours through the burst: ${JSON.stringify(dimmed)}`);
            await walk.shot('ambiglow-follow-video-brightness-burst-ticked');

            // Off again: the six writes.
            count = (await walk.probe()).ene!.frameWrites.count;
            await box.click();
            await until('the checkbox unticked', async () => !(await ticked()));
            await until('frames as the six paced writes again', async () => {
              const fw = (await walk.probe()).ene!.frameWrites;
              return fw.count >= count + 12 && sixWritesOnly(fw.recent.slice(-12));
            });
            assert.deepEqual(configJson(s.configHome).linuxExperimental, { eneFrameBurst: false });
            const end = await walk.probe();
            assert.equal(end.capture!.starts, 1, 'no capture restart for the checkbox either');
            assert.deepEqual(end.ene!.violations, []);
            assert.ok(/"Fast LED upload \(experimental\)" on/.test(s.mainLog()) && /"Fast LED upload \(experimental\)" off/.test(s.mainLog()));
          } finally {
            await walk.closeSolidScreen();
          }
        });
        await walk.step('ambiglow-ene-breathing-again', async () => {
          await chooseOption(w, effectSelect, 'Breathing');
          await until('ENE Breathing again', async () => (await walk.probe()).ene!.groups['1']?.mode === walk.noted('breathingMode'));
        });
      } else {
        // DDC path (03 §4.5 "DDC path"): the monitor's own Ambiglow over E2A0 19/1A (the user's state: off).
        await walk.step('ambiglow-ddc-on', async () => {
          assert.equal(await walk.vcp(VCP.ambiglowMode), 0, 'Ambiglow off (golden session)');
          await w.locator('.vc-switch').filter({ hasText: 'Effect' }).locator('.switch-button').click();
          await until('Ambiglow on (remembered mode written)', async () => (await walk.vcp(VCP.ambiglowMode)) !== 0);
        });
        await walk.step('ambiglow-ddc-red', async () => {
          await w.locator('.default-colors .color-preview:not(.color-rainbow-preview)').nth(1).click();
          await walk.expectVcp(VCP.ambiglowColor, 2, 'Ambiglow colour Red (E2A0_1A_E Red = 2)');
        });
        await walk.step('ambiglow-ddc-colorwave', async () => {
          await chooseOption(w, effectSelect, 'Color Wave');
          await walk.expectVcp(VCP.ambiglowMode, 4, 'Ambiglow ColorWave (E2A0_19_E = 4)');
        });
        await walk.step('ambiglow-ddc-off', async () => {
          // disable writes AmbiglowOff but remembers the mode (CDevice_PHLDisplay.cs 974-1008)
          await w.locator('.vc-switch').filter({ hasText: 'Effect' }).locator('.switch-button').click();
          await walk.expectVcp(VCP.ambiglowMode, 0, 'Ambiglow off');
        });
        await walk.step('ambiglow-ddc-on-again', async () => {
          await w.locator('.vc-switch').filter({ hasText: 'Effect' }).locator('.switch-button').click();
          await walk.expectVcp(VCP.ambiglowMode, 4, 'Ambiglow back to ColorWave');
        });
        // The DDC page's Speed slider is the monitor's own Ambiglow speed (E2A0_1D, Ambiglow-Dvqon39u.js:1104-1114),
        // enabled per mode by the monitor's function constraints; it is not the host's Follow Video speed.
        const ddcSpeed = w.locator('.vc-slider').filter({ hasText: 'Speed' }).first();
        const ddcSpeedDisabled = () => ddcSpeed.evaluate((e) => e.classList.contains('vc-slider__disabled'));
        await walk.step('ambiglow-ddc-follow-video', async () => {
          // Without the ENE the monitor firmware renders Follow Video (E2A019 = 1): the host captures nothing and
          // offers no Follow Video speed (the ENE menu's Speed slider, deviation 17, is never requested here).
          assert.equal(await ddcSpeedDisabled(), false, 'precondition: Color Wave has the monitor\'s own speed');
          await chooseOption(w, effectSelect, 'Follow Video');
          await walk.expectVcp(VCP.ambiglowMode, 1, 'Ambiglow FollowVideo (E2A0_19_E = 1)');
          await until('no usable Speed slider for Follow Video over DDC (the monitor\'s E2A0_1D disabled)', ddcSpeedDisabled);
          const probe = await walk.probe();
          assert.deepEqual([probe.capture!.starts, probe.capture!.intervalMs], [0, null], 'no screen capture over DDC');
          assert.equal(s.rpc.calls.filter((c) => c.fn === 'Effect_GetMenu').length, 0, 'the renderer asks for the ENE menu only with an ENE');
          assert.equal(s.rpc.calls.filter((c) => c.fn === 'Effect_SpeedChange').length, 0);
        });
        await walk.step('ambiglow-ddc-no-fast-upload', async () => {
          // The FAST-LED-UPLOAD checkbox belongs to the ENE page (the host uploads the frames); over DDC the monitor
          // renders Follow Video itself, so there is nothing to upload: no checkbox, and no host brightness either.
          await w.locator('.vc-slider').filter({ hasText: 'Speed' }).first().waitFor({ state: 'visible' });
          assert.equal(await w.locator('.evnia-fast-led-upload').count(), 0, 'no "Fast LED upload" checkbox without the ENE');
          assert.equal(await w.getByText('Fast LED upload (experimental)').count(), 0);
          assert.equal(s.rpc.calls.filter((c) => c.fn === 'Effect_BrightnessChange').length, 0);
          assert.equal('linuxExperimental' in configJson(s.configHome), false, "the migrated Windows config.json gets no port key");
        });
        await walk.step('ambiglow-ddc-colorwave-again', async () => {
          await chooseOption(w, effectSelect, 'Color Wave');
          await walk.expectVcp(VCP.ambiglowMode, 4, 'Ambiglow ColorWave again');
          await until('the monitor\'s own Speed slider enabled again', async () => !(await ddcSpeedDisabled()));
        });
      }
    });

    test('05 Input: switching the source reaches the monitor', { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('input', async () => {
        await sidebarIcon(w, 'nav_input').click();
        await until('the Input page', () => w.url().endsWith('/monitor/input'), 15_000);
        await w.getByText('HDMI 1', { exact: true }).waitFor({ state: 'visible' });
      });
      await walk.step('input-hdmi1', async () => {
        await w.getByText('HDMI 1', { exact: true }).click();
        await until('input HDMI 1 (VCP_60 17)', async () => ((await walk.vcp(VCP.input)) & 0xff) === 17);
      });
      await walk.step('input-dp1', async () => {
        await w.getByText('DisplayPort 1', { exact: true }).click();
        await until('input DisplayPort 1 (VCP_60 15)', async () => ((await walk.vcp(VCP.input)) & 0xff) === 15);
      });
    });

    test('06 Audio: volume and mute reach the monitor', { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('audio', async () => {
        await sidebarIcon(w, 'nav_audio').click();
        await until('the Audio page', () => w.url().endsWith('/monitor/audio'), 15_000);
      });
      await walk.step('audio-volume', async () => {
        await setSlider(w, w.locator('.vc-slider').filter({ hasText: 'Volume' }).first(), 30, 0, 100);
        await walk.expectVcp(VCP.volume, 30, 'Volume slider');
      });
      await walk.step('audio-mute', async () => {
        // OP_8D_AudioMute: ON 1, OFF 2 (03 §4.7)
        await w.locator('.vc-switch').filter({ hasText: 'Mute' }).locator('.switch-button').click();
        await walk.expectVcp(0x8d, 1, 'muted');
      });
      await walk.step('audio-unmute', async () => {
        await w.locator('.vc-switch').filter({ hasText: 'Mute' }).locator('.switch-button').click();
        await walk.expectVcp(0x8d, 2, 'unmuted');
      });
    });

    test('07 System: every tab; Smart Power and PIP/PBP reach the monitor', { timeout: 180_000 }, async () => {
      const w = s.window;
      await walk.step('system', async () => {
        await sidebarIcon(w, 'nav_system').click();
        await until('the System page', () => w.url().endsWith('/monitor/system'), 15_000);
        await menuItem(w, 'OSD Setting').waitFor({ state: 'visible' });
      });
      const tabs = await menuTexts(w);
      assert.ok(tabs.includes('PIP/PBP'), `System tabs: ${tabs.join(', ')}`);
      for (const tab of tabs.slice(1)) {
        await walk.step(`system-${slug(tab)}`, async () => {
          await menuItem(w, tab).click();
          await until(`${tab} active`, async () => (await menuItem(w, tab).getAttribute('class'))?.includes('item-actived'));
        });
      }
      await walk.step('system-smart-power-toggle', async () => {
        await menuItem(w, 'Smart Power').click();
        const before = await walk.vcp(0xe2a016);
        await w.locator('.vc-switch').filter({ hasText: 'Smart Power' }).locator('.switch-button').click();
        await until('Smart Power written', async () => (await walk.vcp(0xe2a016)) !== before);
        await w.locator('.vc-switch').filter({ hasText: 'Smart Power' }).locator('.switch-button').click();
        await walk.expectVcp(0xe2a016, before, 'Smart Power back');
      });
      await walk.step('system-pip-on', async () => {
        // the PIP/PBP Mode switch applies at once: PHL_SetInputSource(input, pip, 256, size, location) →
        // A5 = mode, EC = size | location << 8, 60, A4 = 0xFFFF (03 §4.6, CDevice_PHLDisplay.cs 1888-1938)
        await menuItem(w, 'PIP/PBP').click();
        await w.locator('.vc-switch').filter({ hasText: 'PIP/PBP Mode' }).locator('.switch-button').click();
        await walk.expectVcp(0xa5, 256, 'PIP window selected');
      });
      await walk.step('system-pip-off', async () => {
        await w.locator('.vc-switch').filter({ hasText: 'PIP/PBP Mode' }).locator('.switch-button').click();
        await walk.expectVcp(0xa5, 0, 'PIP off');
      });
    });

    test('08 Setup: Settings (OSD language) and OLED Panel Care, no firmware-update tab; device navigator', { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('setup', async () => {
        await sidebarIcon(w, 'nav_setup').click();
        await until('the Setup page', () => w.url().endsWith('/monitor/setup'), 15_000);
        await w.getByText(`Model: ${MOCK_NAME} | SN: ${MOCK_SN}`).waitFor({ state: 'visible' });
      });
      // OTA removed (ARCHITECTURE scope; vendor-ui patch OTA-OFF): no "FwUpdate" menu entry
      assert.deepEqual(await menuTexts(w), ['Settings', 'OLED Panel Care']);
      await walk.step('setup-osd-language', async () => {
        // OP_CC_OSDLanguage: the option labels are the ValueList texts (Setup-D-5j4V-I.js:321-328)
        const select = w.locator('.vc-select').filter({ has: w.getByText('Language', { exact: true }) }).first();
        const before = await walk.vcp(0xcc);
        await chooseOption(w, select, 'Deutsch');
        await until('OSD language written', async () => (await walk.vcp(0xcc)) !== before);
        await chooseOption(w, select, 'English');
        await walk.expectVcp(0xcc, before, 'OSD language English again');
      });
      await walk.step('setup-oled-panel-care', async () => {
        await menuItem(w, 'OLED Panel Care').click();
        await until('OLED Panel Care active', async () => (await menuItem(w, 'OLED Panel Care').getAttribute('class'))?.includes('item-actived'));
      });
      await walk.step('setup-device-navigator', async () => {
        // DeviceNav (DeviceLayout-pwnPovdh.js:127-140): the monitor list; picking it = PHL_SwitchDisplay(SN)
        // "more" → the equipment icons → the monitor's model list → the model
        const from = s.rpc.calls.length;
        await w.locator('.device-navigator .vc-icon:has(.icon-image[class*="icon-more"])').click();
        await w.locator('.device-navigator .navigator-menu .vc-icon').first().click();
        await w.locator('.device-navigator span').filter({ hasText: MOCK_NAME }).first().click();
        await until(`PHL_SwitchDisplay(${MOCK_SN}) answered`, () =>
          s.rpc.calls.slice(from).some((c) => c.fn === 'PHL_SwitchDisplay' && JSON.stringify(c.parms) === `["${MOCK_SN}"]` && c.reply?.errCode === 0),
        );
      });
    });

    test('09 Profile: create, switch (the monitor follows), export, import, copy, rename, preview, delete; an application theme', { timeout: 180_000 }, async () => {
      const w = s.window;
      const NAME = 'Walkthrough';
      const IMPORTED = 'Imported';
      const exportDir = join(s.configHome, 'exports');
      mkdirSync(exportDir, { recursive: true });
      const exportPath = join(exportDir, `${IMPORTED}.pcenter`);
      await walk.step('profile', async () => {
        walk.note('defaultLuminance', await walk.vcp(VCP.luminance));
        await w.locator('.profile-entrance').click();
        await until('the Profile page', () => w.url().endsWith('/profile'), 15_000);
        await w.locator('.profile-item').first().waitFor({ state: 'visible' });
      });
      await walk.step('profile-new', async () => {
        const preset = await walk.vcp(VCP.smartImage);
        const volume = await walk.vcp(VCP.volume);
        const from = await walk.writeCount();
        await w.locator('.add-icon').click();
        const box = w.locator('.vc-action-box');
        await box.locator('input').fill(NAME);
        await box.getByText(/^ok$/i).click();
        // Theme_AddProfile + Theme_Switch: the new profile is a snapshot of the monitor's current state
        await until(`${NAME} selected in DataTheme.cfg`, () => dataTheme(s.configHome).ThemeInfos[0]?.SelProfileName === NAME);
        await w.locator('.profile-item.item-actived').filter({ hasText: NAME }).waitFor({ state: 'visible' });
        // it has no display section yet, so the switch applies GetDefaultData(): since impl-monitor deviation 18 the
        // monitor's current state (the vendor took its last full read: Standard and volume 0 here), nothing written
        await until(`${NAME}.pcenter saved with the monitor's preset and volume`, () => {
          const d = storedDisplay(s.configHome, 'User', NAME);
          return d?.OP_DC_DisplayApplication.Value === preset && d.ModuleAudio.OP_62_AudioSpeakerVolume.Value === volume;
        });
        assert.equal(await walk.vcp(VCP.smartImage), preset, 'the monitor keeps its preset');
        assert.deepEqual((await walk.writesSince(from)).filter(([c]) => c === VCP.smartImage), [], 'no preset write');
      });
      await walk.step('profile-new-luminance', async () => {
        await w.locator('.profile-close').click(); // router.back() → the Setup page
        await sidebarIcon(w, 'nav_smart_image').click();
        await until('the SmartImage page', () => w.url().endsWith('/monitor/smartImage'), 15_000);
        // another preset in this profile (Default holds Movie): the switch back must restore it
        await w.getByText('Standard', { exact: true }).first().click();
        await walk.expectVcp(VCP.smartImage, 0, `SmartImage Standard in ${NAME}`);
        await setSlider(w, w.locator('.vc-slider').filter({ hasText: 'Brightness' }).first(), 80, 0, 100);
        await walk.expectVcp(VCP.luminance, 80, `Brightness in ${NAME}`);
      });
      await walk.step('profile-switch-default', async () => {
        // the toolbar's profile selector: back to Default, whose preset and luminance the monitor must get again
        await chooseOption(w, w.locator('.profile-select'), 'User | Default');
        await until('Default selected in DataTheme.cfg', () => dataTheme(s.configHome).ThemeInfos[0]?.SelProfileName === 'Default');
        // impl-monitor deviation 18: the switch compares Default's DC with what the monitor was last given
        // (Standard), not with the last full read (Movie, since the switch into Walkthrough), so DC is written
        await walk.expectVcp(VCP.smartImage, 3, 'Default profile SmartImage Movie restored');
        await walk.expectVcp(VCP.luminance, walk.noted('defaultLuminance'), 'Default profile luminance restored');
        // the volume is no part of a profile switch: the monitor keeps the Audio step's 30, and so do DeviceData and
        // the Default profile the switch saves (not the last full read's 0, deviation 18)
        const volume = await walk.vcp(VCP.volume);
        assert.equal(volume, 30, 'the monitor keeps its volume');
        await until('Default.pcenter saved with the monitor volume', () => storedDisplay(s.configHome, 'User', 'Default')?.ModuleAudio.OP_62_AudioSpeakerVolume.Value === volume);
      });
      await walk.step('profile-export', async () => {
        // Export "Walkthrough": the export box's folder icon → IPC exportFile → the save dialog (stubbed in
        // the main process: GTK dialogs cannot be driven) → Theme_ExportProfile writes the chosen path.
        await stubDialogs(s, { save: exportPath });
        await w.locator('.profile-entrance').click();
        await until('the Profile page', () => w.url().endsWith('/profile'), 15_000);
        const item = w.locator('.profile-item').filter({ hasText: NAME });
        await item.hover();
        await item.locator('.vc-icon:has(.icon-image[class*="icon-export"])').click();
        const box = w.locator('.vc-action-box').filter({ visible: true });
        await box.locator('.vc-file-selector .vc-icon').click();
        await box.getByText(exportPath).waitFor({ state: 'visible' });
        await box.getByText(/^ok$/i).click();
        await until(`${exportPath} written`, () => existsSync(exportPath));
        // a Windows-format .pcenter (20-theme §3): UTF-8 BOM, one JSON line, the display section
        const text = readFileSync(exportPath, 'utf8');
        assert.ok(text.startsWith('﻿'), 'UTF-8 BOM');
        const pcenter = JSON.parse(text.slice(1).split(/\r?\n/)[0]) as { Profiles: Array<{ ProfileDesc: { DeviceType: number }; ProfileContent: string }> };
        const display = pcenter.Profiles.find((p) => p.ProfileDesc.DeviceType === 100000);
        assert.ok(display, 'display section');
        assert.equal(JSON.parse(display.ProfileContent).ModuleSmartImage.CurSubSmartImage.OP_10_Luminance.Value, 80);
      });
      await walk.step('profile-import', async () => {
        // Import it back: the import box's folder icon → IPC fileSelect → the open dialog (stubbed) →
        // nodeApi.copyFileSync into userData → Theme_ImportProfile → nodeApi.unlinkSync (ST:43085-43094).
        await stubDialogs(s, { open: exportPath });
        await w.locator('.import-icon').click();
        const box = w.locator('.vc-action-box').filter({ visible: true });
        await box.locator('.vc-file-selector .vc-icon').click();
        await box.getByText(exportPath).waitFor({ state: 'visible' });
        await box.getByText(/^ok$/i).click();
        await until(`${IMPORTED} in DataTheme.cfg`, () => dataTheme(s.configHome).ThemeInfos[0]?.ProfileNames.includes(IMPORTED));
        await w.locator('.profile-item').filter({ hasText: IMPORTED }).waitFor({ state: 'visible' });
        // the temporary copy in userData is gone again
        assert.equal(existsSync(join(s.configHome, 'evnia', IMPORTED)), false, 'temporary import copy removed');
      });
      await walk.step('profile-switch-imported', async () => {
        await w.locator('.profile-item').filter({ hasText: IMPORTED }).click();
        await until(`${IMPORTED} selected`, () => dataTheme(s.configHome).ThemeInfos[0]?.SelProfileName === IMPORTED);
        await walk.expectVcp(VCP.luminance, 80, 'the imported profile carries the exported luminance');
        await w.locator('.profile-item').filter({ hasText: 'Default' }).first().click();
        await until('Default selected', () => dataTheme(s.configHome).ThemeInfos[0]?.SelProfileName === 'Default');
        await walk.expectVcp(VCP.luminance, walk.noted('defaultLuminance'), 'Default luminance');
      });
      await walk.step('profile-copy', async () => {
        // Theme_CopyProfile(theme, src, src + "(n)") (ST:43466-43477)
        const item = w.locator('.profile-item').filter({ hasText: IMPORTED }).first();
        await item.hover();
        await item.locator('.vc-icon:has(.icon-image[class*="icon-copy"])').click();
        await until(`${IMPORTED}(1) created`, () => dataTheme(s.configHome).ThemeInfos[0]?.ProfileNames.includes(`${IMPORTED}(1)`));
        await w.locator('.profile-item').filter({ hasText: `${IMPORTED}(1)` }).waitFor({ state: 'visible' });
      });
      await walk.step('profile-rename', async () => {
        // the LabelEditor's edit icon → Theme_RenameProfile (ST:43396-43408): the file moves with the name
        const item = w.locator('.profile-item').filter({ hasText: `${IMPORTED}(1)` });
        await item.hover();
        await item.locator('.edit-icon').click();
        // in edit mode the label is an <input> (its value is no text content): the one open editor
        const input = w.locator('.profile-item .label-input input');
        await input.fill('Renamed');
        await input.press('Enter');
        await until('renamed in DataTheme.cfg', () => {
          const names = dataTheme(s.configHome).ThemeInfos[0]?.ProfileNames ?? [];
          return names.includes('Renamed') && !names.includes(`${IMPORTED}(1)`);
        });
        assert.ok(existsSync(join(s.configHome, 'EvniaServe', 'Theme', 'User', 'Renamed.pcenter')), 'Renamed.pcenter');
        assert.equal(existsSync(join(s.configHome, 'EvniaServe', 'Theme', 'User', `${IMPORTED}(1).pcenter`)), false);
      });
      await walk.step('profile-preview', async () => {
        // the eye icon: Theme_GetDevicesBasicInfo(theme, profile) → the stored settings of that profile
        const item = w.locator('.profile-item').filter({ hasText: 'Renamed' });
        await item.hover();
        await item.locator('.vc-icon:has(.icon-image[class*="icon-preview"])').click();
        await until('Theme_GetDevicesBasicInfo for Renamed', () =>
          s.rpc.calls.some((c) => c.fn === 'Theme_GetDevicesBasicInfo' && JSON.stringify(c.parms).includes('Renamed') && c.reply?.errCode === 0),
        );
        const preview = w.locator('.preview-box').filter({ visible: true }).first();
        await preview.getByText(MOCK_NAME).first().waitFor({ state: 'visible' });
        await preview.getByText('3440x1440').first().waitFor({ state: 'visible' });
        // the box's own close icon (ST:43527-43533); it stays open otherwise
        await preview.locator('.vc-icon:has(.icon-image[class*="icon-close"])').first().click();
        await preview.waitFor({ state: 'hidden' });
      });
      for (const name of [NAME, IMPORTED, 'Renamed']) {
        await walk.step(`profile-delete-${slug(name)}`, async () => {
          const item = w.locator('.profile-item').filter({ hasText: name });
          await item.hover();
          await item.locator('.vc-icon:has(.icon-image[class*="icon-delete"])').click();
          await w.locator('.vc-action-box').filter({ visible: true }).getByText(/^ok$/i).click();
          await until(`${name} removed from DataTheme.cfg`, () => !dataTheme(s.configHome).ThemeInfos[0]?.ProfileNames.includes(name));
          await item.waitFor({ state: 'detached' });
          assert.equal(existsSync(join(s.configHome, 'EvniaServe', 'Theme', 'User', `${name}.pcenter`)), false, `${name}.pcenter deleted`);
        });
      }
      // An application-bound theme (20-theme §5.2, §10.2): the app picker offers .desktop files (main swaps the
      // renderer's ["exe"] filter), Comm_GenAppIcon stages the app's icon in PATH_APP_TEMP and the renderer shows
      // it as "local:///" + path (main's local: protocol); Theme_Add moves it into Theme/<T>/Icon/.
      const THEME = 'Walkthrough Game';
      await walk.step('profile-app-theme-new', async () => {
        const appsDir = join(s.configHome, 'applications');
        mkdirSync(appsDir, { recursive: true });
        const icon = join(appsDir, 'walkthrough-game.png');
        cpSync(join(PORT_DIR, 'build', 'vendor-assets', 'favicon.png'), icon);
        const desktop = join(appsDir, 'walkthrough-game.desktop');
        writeFileSync(desktop, `[Desktop Entry]\nType=Application\nName=${THEME}\nExec=/usr/bin/true\nIcon=${icon}\n`);
        await stubDialogs(s, { open: desktop });
        await w.locator('.theme-header .vc-icon:has(.icon-image[class*="icon-add"])').click();
        const box = w.locator('.add-theme-box');
        await box.locator('.theme-name-input input').fill(THEME);
        await box.locator('.vc-file-selector .vc-icon').click();
        await until('the app icon from Comm_GenAppIcon shown through local:', () =>
          w.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.add-theme-box .bind-icon img')].some((i) => i.src.startsWith('local:') && i.complete && i.naturalWidth > 0)),
        );
        await box.getByText(/^ok$/i).click();
        // Theme_Add + Theme_Switch(<theme>, ""): the new theme is current (kept in memory, as in the vendor)
        await until(`${THEME} in DataTheme.cfg`, () => dataTheme(s.configHome).ThemeInfos.some((t) => t.Name === THEME));
        await w.locator('.theme-item.item-actived').filter({ hasText: THEME }).waitFor({ state: 'visible' });
        await until('the profile selector shows it', async () => (await w.locator('.profile-select').innerText()).includes(`${THEME} | Default`));
        // the bound app's icon now lives in Theme/<T>/Icon/ and is shown in the theme list
        await until('the bound app icon shown in the theme list', () =>
          w.evaluate(() => [...document.querySelectorAll<HTMLImageElement>('.theme-item img')].some((i) => i.src.includes('/Icon/') && i.complete && i.naturalWidth > 0)),
        );
      });
      await walk.step('profile-app-theme-delete', async () => {
        await w.locator('.theme-item').filter({ hasText: /^\s*User\s*$/ }).first().click();
        await w.locator('.theme-item.item-actived').filter({ hasText: /^\s*User\s*$/ }).waitFor({ state: 'visible' });
        await until('User current again', async () => (await w.locator('.profile-select').innerText()).includes('User | Default'));
        const item = w.locator('.theme-item').filter({ hasText: THEME });
        await item.hover();
        await item.locator('.vc-icon:has(.icon-image[class*="icon-delete"])').click();
        await w.locator('.vc-action-box').filter({ visible: true }).getByText(/^ok$/i).click();
        await until(`${THEME} removed`, () => !dataTheme(s.configHome).ThemeInfos.some((t) => t.Name === THEME));
        await item.waitFor({ state: 'detached' });
      });
      await stubDialogs(s, {});
    });

    test('10 Settings: General (idle lights, language), About without update controls, About Device', { timeout: 180_000 }, async () => {
      const w = s.window;
      await walk.step('settings-general', async () => {
        await toolbarIcon(w, 'setting').click();
        await until('the Settings page', () => w.url().endsWith('/setting'), 15_000);
        // P9: General, AboutPCenter, AboutDevice only (no FwUpdate, AmbiScape, PairingTool)
        assert.deepEqual(await menuTexts(w), ['General', 'About Evnia Precision Center', 'About Device']);
      });
      await walk.step('settings-idle-lights', async () => {
        assert.equal(softConfig(s.configHome).TurnOffLightsWhenIdle ?? false, false);
        await w.getByText('Idle for', { exact: true }).click();
        await until('TurnOffLightsWhenIdle saved', () => softConfig(s.configHome).TurnOffLightsWhenIdle === true);
      });
      // "Turn off lights when idle" (09 §11): idle ≥ duration → the lights go off, input → back on.
      const duration = Number(softConfig(s.configHome).TurnOffLightsWhenIdleDuration);
      await walk.step('settings-idle-lights-off', async () => {
        // the Ambiglow is on here (step 04 left Breathing on the ENE / ColorWave over DDC)
        if (run.ene) assert.equal((await walk.probe()).ene!.hostControl, 4, 'precondition: the ENE lights are on');
        else assert.equal(await walk.vcp(VCP.ambiglowMode), 4, 'precondition: the DDC Ambiglow is on (ColorWave)');
        await walk.setIdleSeconds(duration * 60);
        if (run.ene) {
          await until('ENE dark and released while idle', async () => {
            const ene = (await walk.probe()).ene!;
            return ene.hostControl === 0 && ene.groups['1']?.mode === 0;
          });
        } else {
          await walk.expectVcp(VCP.ambiglowMode, 0, 'DDC Ambiglow off while idle');
        }
      });
      await walk.step('settings-idle-lights-on', async () => {
        await walk.setIdleSeconds(0);
        if (run.ene) {
          await until('ENE back on input', async () => {
            const ene = (await walk.probe()).ene!;
            return ene.hostControl === 4 && ene.groups['1']?.mode === walk.noted('breathingMode');
          });
        } else {
          await walk.expectVcp(VCP.ambiglowMode, 4, 'DDC Ambiglow ColorWave again');
        }
        await w.getByText('Idle for', { exact: true }).click();
        await until('TurnOffLightsWhenIdle cleared', () => softConfig(s.configHome).TurnOffLightsWhenIdle === false);
        await walk.setIdleSeconds(null);
      });
      await walk.step('settings-language-de', async () => {
        await chooseOption(w, w.locator('.vc-select:not(.profile-select)').first(), 'Deutsch');
        await until('German menu', async () => (await menuTexts(w))[0] === 'Allgemein');
        await until('config.json language de', () => readConfig(s.configHome).language === 'de');
      });
      await walk.step('settings-language-en', async () => {
        await chooseOption(w, w.locator('.vc-select:not(.profile-select)').first(), 'English');
        await until('English menu', async () => (await menuTexts(w))[0] === 'General');
        await until('config.json language en', () => readConfig(s.configHome).language === 'en');
      });
      await walk.step('settings-about', async () => {
        await menuItem(w, 'About Evnia Precision Center').click();
        await w.getByText('Version: 1.13.0').first().waitFor({ state: 'visible' });
        // P10: no update controls
        for (const text of [/check for update/i, /automatic(ally)? update/i, /auto.?update/i]) assert.equal(await w.getByText(text).count(), 0, String(text));
      });
      await walk.step('settings-about-device', async () => {
        await menuItem(w, 'About Device').click();
        await w.getByText(MOCK_NAME).first().waitFor({ state: 'visible' });
        await w.getByText('3440x1440').first().waitFor({ state: 'visible' });
        await w.getByText('175Hz').first().waitFor({ state: 'visible' });
      });
    });

    test('11 Dashboard: overlay items configured, the overlay shows the live monitor values', { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('dashboard', async () => {
        await toolbarIcon(w, 'dashboard').click();
        await until('the Dashboard page', () => w.url().endsWith('/dashboard'), 15_000);
        const steps = await walkTutorial(w, !run.seed);
        assert.equal(steps, run.seed ? 0 : 1, 'Dashboard tutorial steps');
      });
      await walk.step('dashboard-configured', async () => {
        // double-click adds an item to the overlay (ST:29745-29750 addPreview), saved in config.json
        for (const item of ['Resolution', 'Refresh Rate', 'SmartImage', 'Input']) {
          await w.locator('.dashboard-option').filter({ hasText: new RegExp(`^\\s*${item}\\s*$`) }).dblclick();
        }
        await until('dashboardPreview saved', () => /Resolution\/RefreshRate\/SmartImage\/Input/.test(JSON.stringify(readConfig(s.configHome).dashboardPreview ?? {})));
      });
      await walk.step('dashboard-overlay', async () => {
        // the overlay on the monitor pages shows the monitor's live values (Jm.getOptionValue, ST:14002-14030):
        // DispalyData from main's display mode, SmartImage and input from the driver
        await toolbarIcon(w, 'home').click();
        await w.getByText(MOCK_NAME, { exact: true }).first().click();
        await until('the monitor shell', () => w.url().includes('/monitor/'), 15_000);
        const overlay = w.locator('.dashboard-display').filter({ visible: true }).first();
        await overlay.waitFor({ state: 'visible' });
        for (const text of ['3440x1440', '175Hz', 'Movie', 'DisplayPort 1']) await overlay.getByText(text).first().waitFor({ state: 'visible' });
      });
    });

    test('11b monitor switched off and on again (hotplug through main\'s device events)', { timeout: 180_000 }, async () => {
      const w = s.window;
      await walk.step('monitor-off', async () => {
        await toolbarIcon(w, 'home').click();
        await w.getByText(MOCK_NAME, { exact: true }).first().click();
        await until('the monitor shell', () => w.url().includes('/monitor/'), 15_000);
        // connector disconnected + the monitor's USB devices gone → USBChange (1 s) and displayChange (2 s
        // debounce) from main → Device_DetectionUSB, Device_DetectionDisplay (5 s settle) → the monitor is gone
        // and the Monitor shell returns Home (03 §4.1 k(): "no monitor → route /")
        const from = s.rpc.calls.length;
        assert.equal(await walk.hotplug('unplugMonitor'), true);
        await until('the renderer\'s Device_DetectionDisplay after displayChange', () =>
          s.rpc.calls.slice(from).some((c) => c.fn === 'Device_DetectionDisplay' && c.reply?.errCode === 0 && Array.isArray(c.reply.tag) && c.reply.tag.length === 0), 30_000);
        assert.ok(s.rpc.calls.slice(from).some((c) => c.fn === 'Device_DetectionUSB' && c.reply?.errCode === 0), 'Device_DetectionUSB after USBChange');
        await w.getByText('Connect Your Evnia Device').first().waitFor({ state: 'visible', timeout: 15_000 });
        assert.equal(w.url(), 'file:///', 'back Home');
      });
      await walk.step('monitor-on', async () => {
        const from = s.rpc.calls.length;
        assert.equal(await walk.hotplug('replugMonitor'), true);
        await until('the monitor listed again', () =>
          s.rpc.calls.slice(from).some((c) => c.fn === 'Device_DetectionDisplay' && c.reply?.errCode === 0 && Array.isArray(c.reply.tag) && c.reply.tag.length === 1), 30_000);
        await w.getByText(MOCK_NAME, { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
        await w.getByText(MOCK_NAME, { exact: true }).first().click();
        await until('the monitor shell', () => w.url().includes('/monitor/'), 15_000);
        await sidebarIcon(w, 'nav_audio').click();
        await until('the Audio page', () => w.url().endsWith('/monitor/audio'), 15_000);
        await setSlider(w, w.locator('.vc-slider').filter({ hasText: 'Volume' }).first(), 40, 0, 100);
        await walk.expectVcp(VCP.volume, 40, 'the replugged monitor takes settings again');
        if (run.ene) {
          await until('the re-enumerated ENE driven again', async () => (await walk.probe()).ene?.hostControl === 4);
        }
      });
    });

    test('11c Profile: reset the current profile (Theme_ResetCurProfile, VCP 0x04)', { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('profile-reset', async () => {
        // the active profile's reset icon: Theme_ResetCurProfile → VCP 0x04 = 1 (binding decision: kept as in
        // the vendor), 5 s, re-read into the cleared profile (20-theme §6, B-3)
        await w.locator('.profile-entrance').click();
        await until('the Profile page', () => w.url().endsWith('/profile'), 15_000);
        const from = await walk.writeCount();
        const item = w.locator('.profile-item.item-actived').first();
        await item.hover();
        await item.locator('.vc-icon:has(.icon-image[class*="icon-reset"])').click();
        await w.locator('.vc-action-box').filter({ visible: true }).getByText(/^ok$/i).click();
        await until('VCP 0x04 = 1 written', async () => (await walk.writesSince(from)).some(([c, v]) => c === 0x04 && v === 1), 20_000);
        await walk.expectVcp(VCP.smartImage, 33, 'the monitor back in its factory HDR Game');
      });
    });

    test('12 Setup: restore factory settings (VCP 0x04)', { timeout: 120_000 }, async () => {
      const w = s.window;
      await walk.step('setup-factory-reset', async () => {
        await toolbarIcon(w, 'home').click();
        await w.getByText(MOCK_NAME, { exact: true }).first().click();
        await until('the monitor shell', () => w.url().includes('/monitor/'), 15_000);
        await sidebarIcon(w, 'nav_setup').click();
        await until('the Setup page', () => w.url().endsWith('/monitor/setup'), 15_000);
        await menuItem(w, 'Settings').click();
        const from = await walk.writeCount();
        await w.locator('.vc-button, button, div').filter({ hasText: /^Reset$/ }).last().click();
        await confirmDialog(w).getByText(/^ok$/i).click();
        // Profile_Reset: VCP 0x04 = 1, 5 s, full re-read (03 §4.9; binding decision: kept as in the vendor)
        await until('VCP 0x04 = 1 written', async () => (await walk.writesSince(from)).some(([c, v]) => c === 0x04 && v === 1), 20_000);
        await walk.expectVcp(VCP.smartImage, 33, 'the monitor is back in its factory HDR Game');
        await until('the reset profile shown (SmartImage HDR)', async () => {
          await sidebarIcon(w, 'nav_smart_image').click();
          return w.url().endsWith('/monitor/smartImageHDR');
        }, 20_000);
      });
    });

    test('13 Settings: Factory Reset (app data + VCP 0x04) and Tutorials Reset', { timeout: 120_000 }, async () => {
      const w = s.window;
      const resetButton = (row: string) =>
        w.locator('div').filter({ hasText: new RegExp(`^\\s*${row}\\s+Reset\\s*$`) }).last().getByText('Reset', { exact: true });
      await walk.step('settings-factory-reset', async () => {
        // a profile to be wiped
        await w.locator('.profile-entrance').click();
        await until('the Profile page', () => w.url().endsWith('/profile'), 15_000);
        await w.locator('.add-icon').click();
        await w.locator('.vc-action-box').locator('input').fill('Wiped');
        await w.locator('.vc-action-box').getByText(/^ok$/i).click();
        await until('Wiped created', () => dataTheme(s.configHome).ThemeInfos[0]?.ProfileNames.includes('Wiped'));
        await toolbarIcon(w, 'setting').click();
        await until('the Settings page', () => w.url().endsWith('/setting'), 15_000);
        const from = await walk.writeCount();
        await resetButton('Factory Reset').click();
        await confirmDialog(w).getByText(/^ok$/i).click();
        // FactoryReset (20-theme §7; binding decision): the monitor's VCP 0x04 = 1, the app's themes,
        // profiles and settings recreated as on first run
        await until('VCP 0x04 = 1 written', async () => (await walk.writesSince(from)).some(([c, v]) => c === 0x04 && v === 1), 20_000);
        await until('Wiped gone', () => {
          const t = dataTheme(s.configHome);
          return t.ThemeInfos.length === 1 && t.ThemeInfos[0].Name === 'User' && t.ThemeInfos[0].ProfileNames.join() === 'Default';
        }, 20_000);
        await until('the profile selector shows User | Default', async () => (await w.locator('.profile-select').innerText()).includes('User | Default'));
        assert.equal(softConfig(s.configHome).TurnOffLightsWhenIdle, false);
      });
      await walk.step('settings-tutorials-reset', async () => {
        await resetButton('Tutorials Reset').click();
        await confirmDialog(w).getByText(/^ok$/i).click();
        await until('tutorials cleared in config.json', () => JSON.stringify(readConfig(s.configHome).tutorials) === '{}');
      });
    });

    test('14 back Home: the tutorial again, nothing left behind', { timeout: 60_000 }, async () => {
      await walk.step('home-final', async () => {
        await toolbarIcon(s.window, 'home').click();
        await s.window.getByText(MOCK_NAME, { exact: true }).first().waitFor({ state: 'visible' });
        await s.window.locator('.tutorials-view .next-btn').waitFor({ state: 'visible' });
        assert.equal(await walkTutorial(s.window, true), 3, 'Home tutorial after Tutorials Reset');
      });
      const snap = await walk.probe();
      if (run.ene) assert.deepEqual(snap.ene!.violations, [], 'no refused ENE register access');
    });
  });
}

/** The app's electron-store file (~/.config/evnia/config.json). */
function readConfig(configHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(configHome, 'evnia', 'config.json'), 'utf8')) as Record<string, unknown>;
}

/** The vendor's confirm box (main-CDosWiM3.js Confirm, `.vc-confirm`) or dialog. */
function confirmDialog(w: Page) {
  return w.locator('.vc-confirm, .vc-dialog').filter({ visible: true }).last();
}

/**
 * Answer the next native file dialogs in the main process (GTK dialogs cannot be driven from a test):
 * `save` for dialog.showSaveDialog (IPC exportFile), `open` for dialog.showOpenDialog (IPC fileSelect);
 * an empty object restores Electron's own functions.
 */
async function stubDialogs(s: Session, answers: { save?: string; open?: string }): Promise<void> {
  await s.app.evaluate(({ dialog }, a) => {
    const d = dialog as unknown as Record<string, unknown> & { __orig?: Record<string, unknown> };
    d.__orig ??= { showSaveDialog: d.showSaveDialog, showOpenDialog: d.showOpenDialog };
    d.showSaveDialog = a.save ? async () => ({ canceled: false, filePath: a.save }) : d.__orig.showSaveDialog;
    d.showOpenDialog = a.open ? async () => ({ canceled: false, filePaths: [a.open] }) : d.__orig.showOpenDialog;
  }, answers);
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
