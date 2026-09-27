// Follow-audio recorder (src/main/audio-monitor.ts): parec/pactl are replaced by small scripts on PATH,
// so the real spawn/stream/restart code runs without a sound server.
//
// Fake parec modes (file `mode`): sine:<amplitude> (1 kHz stereo float32le at 48 kHz, 20 ms chunks),
// fail (stderr + exit 1), nodata (stays silent), once (200 ms of audio, then exits), stall (100 ms of
// audio, then stays silent), delayed (audio after 400 ms). Fake pactl: `subscribe` prints the lines
// appended to `events`; get-default-sink / get-sink-mute read `sink` / `mute`.

import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { AUDIO_FFT_SIZE } from '../../../src/main/audio-level.ts';
import { MonoRing, PAREC_ARGS, parseMute, parsePulseEvent, PulseMonitorCapture } from '../../../src/main/audio-monitor.ts';

const log = createLogger('test', silentSink);
let dir: string;
let emptyDir: string;

const FAKE_PAREC = `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify('__DIR__')};
fs.appendFileSync(dir + '/spawns', process.pid + '\\n');
fs.writeFileSync(dir + '/args', JSON.stringify(process.argv.slice(2)));
const [mode, arg] = fs.readFileSync(dir + '/mode', 'utf8').trim().split(':');
if (mode === 'fail') { process.stderr.write('Connection failure: Connection refused\\n'); process.exit(1); }
const amp = mode === 'sine' ? Number(arg) : 0.5;
let t = 0;
const chunk = () => {
  const b = Buffer.alloc(960 * 8);
  for (let i = 0; i < 960; i++, t++) {
    const v = amp * Math.sin(2 * Math.PI * 1000 * t / 48000);
    b.writeFloatLE(v, i * 8); b.writeFloatLE(v, i * 8 + 4);
  }
  process.stdout.write(b);
};
const started = Date.now();
setInterval(() => {
  const age = Date.now() - started;
  if (mode === 'nodata') return;
  if (mode === 'delayed' && age < 400) return;
  if (mode === 'stall' && age > 100) return;
  if (mode === 'once' && age > 200) process.exit(0);
  chunk();
}, 20);
`;

const FAKE_PACTL = `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify('__DIR__')};
const read = (f, d) => { try { return fs.readFileSync(dir + '/' + f, 'utf8').trim(); } catch { return d; } };
const [cmd] = process.argv.slice(2);
if (cmd === 'get-default-sink') { console.log(read('sink', 'alsa_output.default')); process.exit(0); }
if (cmd === 'get-sink-mute') { console.log('Mute: ' + read('mute', 'no')); process.exit(0); }
if (cmd === 'subscribe') {
  let seen = 0;
  setInterval(() => {
    const lines = read('events', '').split('\\n').filter(Boolean);
    for (; seen < lines.length; seen++) console.log(lines[seen]);
  }, 30);
} else process.exit(1);
`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'evnia-audio-'));
  emptyDir = mkdtempSync(join(tmpdir(), 'evnia-audio-empty-'));
  for (const [name, text] of [['parec', FAKE_PAREC], ['pactl', FAKE_PACTL]] as const) {
    writeFileSync(join(dir, name), text.replaceAll(JSON.stringify('__DIR__'), JSON.stringify(dir)));
    chmodSync(join(dir, name), 0o755);
  }
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const f of ['spawns', 'args', 'events', 'mute', 'sink']) rmSync(join(dir, f), { force: true });
  writeFileSync(join(dir, 'mode'), 'sine:0.5');
});

const FAST = { restartDelayMs: 100, startTimeoutMs: 1500, watchdogMs: 300, muteQueryDelayMs: 20 };
// The fakes come first on PATH; the system directories provide setpriv (child-process.ts).
const capture = (path = `${dir}:/usr/bin:/bin`, timing = FAST) => new PulseMonitorCapture({ log, env: { PATH: path }, timing });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spawns = () => (existsSync(join(dir, 'spawns')) ? readFileSync(join(dir, 'spawns'), 'utf8').trim().split('\n').filter(Boolean) : []);

async function until(what: string, cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('parsers: pactl subscribe events and get-sink-mute', () => {
  assert.equal(parsePulseEvent("Event 'change' on server #0"), 'server');
  assert.equal(parsePulseEvent("Event 'change' on server"), 'server');
  assert.equal(parsePulseEvent("Event 'change' on sink #56"), 'sink');
  assert.equal(parsePulseEvent("Event 'new' on sink-input #120"), null);
  assert.equal(parsePulseEvent("Event 'change' on source #3"), null);
  assert.equal(parseMute('Mute: yes\n'), true);
  assert.equal(parseMute('Mute: no\n'), false);
  assert.equal(parseMute('Failure: No such entity\n'), null);
});

test('MonoRing: channel mean, frames split across chunks, oldest sample first', () => {
  const ring = new MonoRing(4, 2);
  const frames = (...pairs: number[][]) => {
    const b = Buffer.alloc(pairs.length * 8);
    pairs.forEach(([l, r], i) => {
      b.writeFloatLE(l, i * 8);
      b.writeFloatLE(r, i * 8 + 4);
    });
    return b;
  };
  const all = frames([1, 3], [2, 4], [0, 1], [5, 5], [-1, 1]);
  ring.push(all.subarray(0, 11));
  ring.push(all.subarray(11));
  assert.deepEqual([...ring.snapshot()], [3, 0.5, 5, 0]);
  ring.clear();
  assert.deepEqual([...ring.snapshot()], [0, 0, 0, 0]);
});

test('records @DEFAULT_MONITOR@ and reports the vendor level every 40 ms', async () => {
  const c = capture();
  const levels: { level: number; bins: number }[] = [];
  assert.equal(await c.start((level, spectrum) => levels.push({ level, bins: spectrum?.length ?? -1 })), true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'args'), 'utf8')), PAREC_ARGS);
  await sleep(400);
  c.stop();
  const n = levels.length;
  assert.ok(n >= 6 && n <= 14, `about 10 levels in 400 ms, got ${n}`);
  assert.ok(levels.every((l) => l.bins === Math.floor(2500 / Math.floor(48000 / AUDIO_FFT_SIZE))), '108 bins (09 §8.1)');
  assert.ok(levels.at(-1)!.level > 0, 'a 1 kHz tone is not silence');
  await sleep(150);
  assert.equal(levels.length, n, 'no level after stop()');
  const [pid] = spawns().map(Number);
  await until('parec killed', () => !alive(pid));
});

test('silence gives level 0', async () => {
  writeFileSync(join(dir, 'mode'), 'sine:0');
  const c = capture();
  const levels: number[] = [];
  assert.equal(await c.start((l) => levels.push(l)), true);
  await sleep(200);
  c.stop();
  assert.ok(levels.length > 0 && levels.every((l) => l === 0));
});

test('a muted default sink gives level 0 (vendor: muted endpoint → empty buffer)', async () => {
  const c = capture();
  const levels: { level: number; bins: number }[] = [];
  assert.equal(await c.start((level, spectrum) => levels.push({ level, bins: spectrum?.length ?? -1 })), true);
  await until('levels', () => levels.length > 3);
  assert.ok(levels.at(-1)!.level > 0);
  writeFileSync(join(dir, 'mute'), 'yes');
  appendFileSync(join(dir, 'events'), "Event 'change' on sink #56\n");
  await until('muted level 0', () => levels.at(-1)!.level === 0 && levels.at(-1)!.bins === 0);
  writeFileSync(join(dir, 'mute'), 'no');
  appendFileSync(join(dir, 'events'), "Event 'change' on sink #56\n");
  await until('unmuted', () => levels.at(-1)!.level > 0);
  c.stop();
});

test('a new default sink restarts parec on its monitor (OnDefaultDeviceChanged)', async () => {
  writeFileSync(join(dir, 'sink'), 'alsa_output.speakers');
  const c = capture();
  assert.equal(await c.start(() => {}), true);
  await sleep(200);
  appendFileSync(join(dir, 'events'), "Event 'change' on server #0\n");
  await sleep(200);
  assert.equal(spawns().length, 1, 'same default sink: no restart');
  writeFileSync(join(dir, 'sink'), 'bluez_output.headset');
  appendFileSync(join(dir, 'events'), "Event 'change' on server #0\n");
  await until('restart', () => spawns().length === 2);
  const [first] = spawns().map(Number);
  await until('old parec killed', () => !alive(first));
  c.stop();
});

test('parec is restarted when it exits and when it stalls (vendor 3 s watchdog)', async () => {
  writeFileSync(join(dir, 'mode'), 'once');
  const c = capture();
  const levels: number[] = [];
  assert.equal(await c.start((l) => levels.push(l)), true);
  await until('restart after exit', () => spawns().length >= 2);
  writeFileSync(join(dir, 'mode'), 'stall');
  await until('restart after stall', () => spawns().length >= 4, 5000);
  c.stop();
  assert.ok(levels.length > 0);
});

test('start resolves false without parec, when it fails, or when it sends nothing', async () => {
  const t0 = Date.now();
  assert.equal(await capture(emptyDir).start(() => {}), false, 'not installed');
  assert.ok(Date.now() - t0 < 1000);
  writeFileSync(join(dir, 'mode'), 'fail');
  assert.equal(await capture().start(() => {}), false, 'sound server unreachable');
  writeFileSync(join(dir, 'mode'), 'nodata');
  assert.equal(await capture(undefined, { ...FAST, startTimeoutMs: 300 }).start(() => {}), false, 'no data');
  const pids = spawns().map(Number);
  await until('silent parec killed', () => !alive(pids.at(-1)!));
});

test('stop during a pending start resolves it false and kills parec', async () => {
  writeFileSync(join(dir, 'mode'), 'delayed');
  const c = capture();
  const levels: number[] = [];
  const pending = c.start((l) => levels.push(l));
  await until('parec spawned', () => spawns().length === 1);
  c.stop();
  assert.equal(await pending, false);
  await sleep(600);
  assert.equal(levels.length, 0);
  assert.equal(alive(Number(spawns()[0])), false);
});

test('a second start supersedes the first', async () => {
  writeFileSync(join(dir, 'mode'), 'delayed');
  const c = capture();
  const a: number[] = [];
  const b: number[] = [];
  const [okA, okB] = await Promise.all([c.start((l) => a.push(l)), c.start((l) => b.push(l))]);
  assert.deepEqual([okA, okB], [false, true]);
  await sleep(200);
  c.stop();
  assert.equal(a.length, 0);
  assert.ok(b.length > 0);
  // The first parec may be killed before it even ran its script, so only the processes that did are known.
  const pids = spawns().map(Number);
  assert.ok(pids.length >= 1);
  await until('every parec process gone', () => pids.every((p) => !alive(p)));
});
