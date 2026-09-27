// Electron entry for test/e2e/capture.test.ts: drives ElectronCaptureHost directly (the backend is its
// only production caller). A red full-screen window gives the X11 capture something to see; the result
// is printed as one `RESULT <json>` line.
//
// Scenarios: a normal start/stop; stop issued while the start is still pending; two overlapping starts;
// a restart while running; retuning a running (and a starting) capture; the frame spacing at 300 ms and the lag of
// a screen change (frame-driven sampling); a start that times out; follow-audio without a sound server.

import { app, BrowserWindow } from 'electron';
import { createLogger, consoleSink } from '../../../src/backend/core/log.ts';
import type { CaptureFrame } from '../../../src/backend/types.ts';
import { ElectronCaptureHost } from '../../../src/main/capture-host.ts';
import { resolveAppPaths } from '../../../src/main/paths.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Windows other than the red test pattern, i.e. capture windows still alive. */
const captureWindows = (red: BrowserWindow) => BrowserWindow.getAllWindows().filter((w) => w !== red).length;

app.whenReady().then(async () => {
  const appDir = process.env.EVNIA_APP_DIR ?? '';
  const paths = resolveAppPaths(appDir, app.getPath('userData'), app.getPath('temp'));
  const log = createLogger('capture-e2e', consoleSink, 'debug');
  const red = new BrowserWindow({ x: 0, y: 0, width: 1920, height: 1080, frame: false, backgroundColor: '#ff0000' });
  await red.loadURL('data:text/html,<body style="margin:0;background:#ff0000"></body>');
  await sleep(1000);

  const host = new ElectronCaptureHost({ paths, log, wayland: false });

  // 1. normal start, 1.5 s of frames, stop
  const frames: CaptureFrame[] = [];
  const videoOk = await host.startVideo(100, (f) => frames.push(f));
  await sleep(1500);
  host.stopVideo();
  const countAtStop = frames.length;
  await sleep(500);
  const windowsAfterStop = captureWindows(red);

  // 2. stop while the start is still pending
  const early: CaptureFrame[] = [];
  const pending = host.startVideo(100, (f) => early.push(f));
  host.stopVideo();
  const stopDuringStartOk = await pending;
  await sleep(1500);
  const stopDuringStart = { ok: stopDuringStartOk, frames: early.length, windows: captureWindows(red) };

  // 3. two overlapping starts: the later one wins, only one stream runs
  const a: CaptureFrame[] = [];
  const b: CaptureFrame[] = [];
  const [okA, okB] = await Promise.all([host.startVideo(100, (f) => a.push(f)), host.startVideo(100, (f) => b.push(f))]);
  const b0 = b.length;
  await sleep(2000);
  const doubleStart = { okA, okB, framesA: a.length, framesB2s: b.length - b0 };
  host.stopVideo();

  // 4. restart while running: the old callback stops at once
  const c: CaptureFrame[] = [];
  const d: CaptureFrame[] = [];
  await host.startVideo(100, (f) => c.push(f));
  await sleep(600);
  const okD = await host.startVideo(100, (f) => d.push(f));
  const c0 = c.length;
  await sleep(1000);
  const restart = { okD, framesOldAfter: c.length - c0, framesNew: d.length };
  host.stopVideo();
  await sleep(300);
  const windowsAtEnd = captureWindows(red);

  // 4b. retune a running capture in place (Follow video speed tiers): same session and window, other frame rate
  const startsBefore = host.videoStats.starts;
  const tuned: CaptureFrame[] = [];
  const okG = await host.startVideo(100, (f) => tuned.push(f));
  await sleep(300);
  const g0 = tuned.length;
  await sleep(1000);
  const frames100 = tuned.length - g0;
  host.setVideoInterval(40); // High
  await sleep(500); // applyConstraints, and on X11 possibly the silent re-open of the desktop source
  const windowsDuringRetune = captureWindows(red);
  const g1 = tuned.length;
  await sleep(1000);
  const frames40 = tuned.length - g1;
  host.setVideoInterval(300); // Low
  await sleep(500);
  const g2 = tuned.length;
  await sleep(1500);
  const frames300 = tuned.length - g2;
  const running = host.videoStats;
  // a retune while the start is still in flight: the new interval wins
  const quick: CaptureFrame[] = [];
  const pendingH = host.startVideo(300, (f) => quick.push(f));
  host.setVideoInterval(40);
  const okH = await pendingH;
  await sleep(300);
  const h0 = quick.length;
  await sleep(1000);
  const pendingFrames40 = quick.length - h0;
  host.stopVideo();
  host.setVideoInterval(100); // nothing captured: a no-op
  await sleep(300);
  const retune = {
    okG,
    frames100,
    frames40,
    frames300,
    windowsDuringRetune,
    lastFrameWidth: tuned.at(-1)?.width,
    starts: running.starts - startsBefore,
    retunes: running.retunes,
    intervalMs: running.intervalMs,
    okH,
    pendingFrames40,
    idle: host.videoStats,
    windowsAfter: captureWindows(red),
  };

  // 4c. frame-driven sampling (src/capture/page.ts): at Low (300 ms) the source delivers a frame every 300 ms
  //     (3.33 fps, not 3), and a screen change reaches the frame callback within about one source interval. A
  //     timer sampling the page out of phase with the source would add up to another interval (median ~2x).
  const setColour = (css: string) => red.webContents.executeJavaScript(`document.body.style.background = '${css}'`);
  const colourOf = (f: CaptureFrame): 'red' | 'green' | 'other' => {
    const i = (20 * f.width + 25) * 4; // the centre of the 50×40 grid
    const [r, g] = [f.data[i], f.data[i + 1]];
    return r > 200 && g < 60 ? 'red' : g > 200 && r < 60 ? 'green' : 'other';
  };
  const low: CaptureFrame[] = [];
  let waiter: ((f: CaptureFrame) => void) | null = null;
  await host.startVideo(300, (f) => {
    low.push(f);
    waiter?.(f);
  });
  await sleep(2000);
  const steady = low.slice(1).map((f) => f.timestamp);
  const gaps300 = steady.slice(1).map((t, i) => t - steady[i]);
  const latencies: number[] = [];
  for (let i = 0; i < 12; i++) {
    await sleep(350 + Math.random() * 300); // a random phase against the source; the previous colour is settled
    const target = i % 2 === 0 ? 'green' : 'red';
    const t0 = Date.now();
    const seen = new Promise<number>((resolve) => {
      const timeout = setTimeout(() => {
        waiter = null;
        resolve(-1);
      }, 3000);
      waiter = (f) => {
        if (colourOf(f) !== target) return;
        clearTimeout(timeout);
        waiter = null;
        resolve(Date.now() - t0);
      };
    });
    await setColour(target === 'green' ? '#00ff00' : '#ff0000');
    latencies.push(await seen);
  }
  host.stopVideo();
  await setColour('#ff0000');
  await sleep(300);
  const lag = { gaps300, latencies };

  // 5. a start that cannot finish in time resolves false and cleans up (portal dialog left open)
  const impatient = new ElectronCaptureHost({ paths, log, wayland: false, videoStartTimeoutMs: 1 });
  const late: CaptureFrame[] = [];
  const timeoutOk = await impatient.startVideo(100, (f) => late.push(f));
  await sleep(1500);
  const timeout = { ok: timeoutOk, frames: late.length, windows: captureWindows(red) };
  impatient.dispose();

  // 6. follow-audio: no parec/sound server in the container → false, never a hang
  const audioOk = await Promise.race([host.startAudio(() => {}), sleep(15000).then(() => 'timeout')]);
  host.stopAudio();

  const last = frames.at(-1);
  let r = 0;
  let g = 0;
  let px = 0;
  for (let i = 0; last && i < last.data.length; i += 4, px++) {
    r += last.data[i];
    g += last.data[i + 1];
  }
  const result = {
    videoOk,
    frames: countAtStop,
    framesAfterStop: frames.length - countAtStop,
    windowsAfterStop,
    width: last?.width,
    height: last?.height,
    bytes: last?.data.length,
    avgRed: px ? r / px : 0,
    avgGreen: px ? g / px : 0,
    stopDuringStart,
    doubleStart,
    restart,
    windowsAtEnd,
    retune,
    lag,
    timeout,
    audioOk,
  };
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  host.dispose();
  app.exit(0);
});
