// Capture host (src/main/capture-host.ts + src/capture) under Xvfb: X11 desktop capture scaled to the
// 50×40 follow-video grid (09 §7.2), frame delivery stops with stopVideo, start/stop sequencing (stop
// during a pending start, overlapping starts, restart, start timeout) never leaves a stream or a
// capture window behind, and follow-audio resolves false instead of hanging when there is no parec or
// sound server (the dev container has neither).

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
  timeout: { ok: boolean; frames: number; windows: number };
  audioOk: boolean | 'timeout';
}

test('X11 capture delivers 50x40 RGBA frames of the screen, sequences start/stop; audio fails soft', { skip, timeout: 150_000 }, async () => {
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
    }, 90_000);
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
  assert.deepEqual(r.timeout, { ok: false, frames: 0, windows: 0 }, 'a start past its deadline resolves false and cleans up');
  assert.equal(r.audioOk, false, 'no parec/sound server: false, not a hang');
});
