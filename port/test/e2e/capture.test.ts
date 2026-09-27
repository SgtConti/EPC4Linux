// Capture host (src/main/capture-host.ts + src/capture) under Xvfb: X11 desktop capture scaled to the
// 50×40 follow-video grid (09 §7.2), frame delivery stops with stopVideo, start/stop sequencing (stop
// during a pending start, overlapping starts, restart, start timeout) never leaves a stream or a
// capture window behind, a running (or starting) capture is retuned in place by setVideoInterval (the Follow
// video speed tiers: no new session), the page samples each source frame as it arrives (a frame every 300 ms at
// Low, a screen change seen within about one interval), and follow-audio resolves false instead of hanging when
// there is no parec or sound server (the dev container has neither).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { ARTIFACTS, buildApp, E2E_DIR, PORT_DIR } from './harness.ts';

const skip = process.env.DISPLAY ? false : 'no X display: run under xvfb-run (see test/e2e/harness.ts)';

interface CaptureResult {
  videoOk: boolean;
  frames: number;
  framesAfterStop: number;
  windowsAfterStop: number;
  width: number;
  height: number;
  bytes: number;
  avgRed: number;
  avgGreen: number;
  stopDuringStart: { ok: boolean; frames: number; windows: number };
  doubleStart: { okA: boolean; okB: boolean; framesA: number; framesB2s: number };
  restart: { okD: boolean; framesOldAfter: number; framesNew: number };
  windowsAtEnd: number;
  retune: {
    okG: boolean;
    frames100: number;
    frames40: number;
    frames300: number;
    windowsDuringRetune: number;
    lastFrameWidth: number;
    starts: number;
    retunes: number;
    intervalMs: number | null;
    okH: boolean;
    pendingFrames40: number;
    idle: { starts: number; retunes: number; intervalMs: number | null };
    windowsAfter: number;
  };
  lag: { gaps300: number[]; latencies: number[] };
  timeout: { ok: boolean; frames: number; windows: number };
  audioOk: boolean | 'timeout';
}

test('X11 capture delivers 50x40 RGBA frames of the screen, sequences start/stop; audio fails soft', { skip, timeout: 180_000 }, async () => {
  const built = buildApp('placeholder', 'capture');
  const harness = join(ARTIFACTS, 'capture', 'harness');
  mkdirSync(harness, { recursive: true });
  await build({
    entryPoints: [join(E2E_DIR, 'fixtures', 'capture-main.ts')],
    outfile: join(harness, 'main.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
    absWorkingDir: PORT_DIR,
  });
  writeFileSync(join(harness, 'package.json'), JSON.stringify({ name: 'evnia-capture-e2e', main: 'main.cjs' }));

  const electronPath = createRequire(import.meta.url)('electron') as unknown as string;
  const home = mkdtempSync(join(tmpdir(), 'evnia-capture-'));
  // A private X server, so windows of tests running in parallel cannot cover the red test window.
  const electronArgs = ['--no-sandbox', '--disable-gpu', harness];
  const hasXvfbRun = spawnSync('sh', ['-c', 'command -v xvfb-run']).status === 0;
  const [cmd, args] = hasXvfbRun
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', electronPath, ...electronArgs]]
    : [electronPath, electronArgs];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, EVNIA_APP_DIR: built.dir, XDG_CONFIG_HOME: home, XDG_SESSION_TYPE: 'x11' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`capture harness timed out:\n${out}`));
    }, 120_000);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  rmSync(home, { recursive: true, force: true });
  writeFileSync(join(ARTIFACTS, 'capture', 'harness.log'), output);
  const line = output.split('\n').find((l) => l.startsWith('RESULT '));
  assert.ok(line, `no RESULT line:\n${output}`);
  const r = JSON.parse(line.slice('RESULT '.length)) as CaptureResult;

  assert.equal(r.videoOk, true, output);
  assert.ok(r.frames >= 5, `about 10 fps for 1.5 s, got ${r.frames}`);
  assert.equal(r.framesAfterStop, 0, 'no frames after stopVideo');
  assert.equal(r.windowsAfterStop, 0, 'stopVideo releases the capture window');
  assert.deepEqual([r.width, r.height, r.bytes], [50, 40, 50 * 40 * 4]);
  assert.ok(r.avgRed > 200 && r.avgGreen < 60, `the red window is visible in the frame (R=${r.avgRed}, G=${r.avgGreen})`);

  assert.deepEqual(r.stopDuringStart, { ok: false, frames: 0, windows: 0 }, 'a stop issued during the start wins');
  const d = r.doubleStart;
  assert.deepEqual([d.okA, d.okB, d.framesA], [false, true, 0], 'overlapping starts: the later wins, the earlier gets nothing');
  assert.ok(d.framesB2s >= 8 && d.framesB2s <= 26, `one stream at about 10 fps, not two (got ${d.framesB2s} frames in 2 s)`);
  assert.equal(r.restart.okD, true);
  assert.equal(r.restart.framesOldAfter, 0, 'the replaced callback stops at once');
  assert.ok(r.restart.framesNew >= 5);
  assert.equal(r.windowsAtEnd, 0);

  // Retune in place (the Follow video speed tiers, CaptureHost.setVideoInterval): one session, one window.
  const t = r.retune;
  assert.equal(t.okG, true);
  assert.deepEqual([t.starts, t.windowsDuringRetune, t.lastFrameWidth], [1, 1, 50], 'no new session, no second capture window');
  assert.ok(t.frames40 >= Math.max(12, 1.5 * t.frames100), `40 ms gives more frames than 100 ms (1 s each: ${t.frames40} vs ${t.frames100})`);
  assert.ok(t.frames300 <= 8 && t.frames300 >= 2, `300 ms: about 5 frames in 1.5 s, got ${t.frames300}`);
  assert.deepEqual([t.retunes, t.intervalMs], [2, 300], 'the host counts the retunes and reports the current interval');
  assert.equal(t.okH, true);
  assert.ok(t.pendingFrames40 >= 12, `a retune during the start is applied when the stream is up (${t.pendingFrames40} frames in 1 s)`);
  assert.equal(t.idle.intervalMs, null, 'stopped: no interval; a setVideoInterval then is a no-op');
  assert.equal(t.idle.retunes, 3);
  assert.equal(t.windowsAfter, 0);
  assert.match(output, /capture video-retuned: every 40 ms/, 'the page reports the retune');

  // Frame-driven sampling (src/capture/page.ts, MediaStreamTrackProcessor): each source frame as it arrives.
  assert.match(output, /capture video-started: .*sampling each new source frame/, 'Electron exposes MediaStreamTrackProcessor to the page');
  assert.doesNotMatch(output, /no MediaStreamTrackProcessor/);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const { gaps300, latencies } = r.lag;
  assert.ok(gaps300.length >= 4, `frames at 300 ms: ${JSON.stringify(gaps300)}`);
  const gap = median(gaps300);
  assert.ok(gap >= 280 && gap <= 320, `Low: a frame every 300 ms (the source asked 3.33 fps, not 3 = 333 ms); median gap ${gap} of ${JSON.stringify(gaps300)}`);
  assert.ok(latencies.every((ms) => ms >= 0), `every screen change reached the frame callback: ${JSON.stringify(latencies)}`);
  // One source interval (≤ 300 ms, ~150 on average) plus paint, grab and delivery; a timer sampling out of phase
  // with the source would add up to another 300 ms (median ~2x).
  const lagMedian = median(latencies);
  assert.ok(lagMedian < 300, `lag of a screen change at 300 ms: median ${lagMedian} ms of ${JSON.stringify(latencies)}`);
  writeFileSync(join(ARTIFACTS, 'capture', 'lag.json'), JSON.stringify({ gaps300, latencies, gapMedian: gap, lagMedian }, null, 2));
  assert.deepEqual(r.timeout, { ok: false, frames: 0, windows: 0 }, 'a start past its deadline resolves false and cleans up');
  assert.equal(r.audioOk, false, 'no parec/sound server: false, not a hang');
});
