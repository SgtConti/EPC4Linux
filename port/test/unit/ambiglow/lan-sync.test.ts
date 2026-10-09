// LAN colour sync (src/backend/ambiglow/lan-sync.ts, lan-address.ts): the address rules, the five zone averages of a
// frame, the JSON document, the sender's pacing (change threshold, minimum interval, heartbeat, one request at a time,
// the end-of-stream document, failure back-off) with manual timers and a fake transport, the FollowVideoEngine's frame
// sink, and a real HTTP round trip to a loopback server.

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { FollowVideoEngine } from '../../../src/backend/ambiglow/follow-video.ts';
import {
  describeLanTarget,
  frameZones,
  httpPost,
  isPrivateIpv4,
  LAN_SYNC_CHANGE_DELTA,
  LAN_SYNC_FAILING_INTERVAL_MS,
  LAN_SYNC_HEARTBEAT_MS,
  LAN_SYNC_HUBITAT_INTERVAL_MS,
  LAN_SYNC_MIN_INTERVAL_MS,
  lanSyncMinInterval,
  LanColorSender,
  lanSyncAddressText,
  lanSyncDocument,
  normalizeLanSyncSettings,
  parseLanSyncAddress,
  type LanSyncSettings,
} from '../../../src/backend/ambiglow/lan-sync.ts';
import type { CaptureFrame } from '../../../src/backend/types.ts';
import { FakeCaptureHost, ManualTimers, flush, rgbaFrame, rig, silentLog } from './helpers.ts';

const ON: LanSyncSettings = { enabled: true, host: '192.168.1.20', port: 39501, path: '/' };
const solid = (r: number, g: number, b: number): CaptureFrame => rgbaFrame(() => [r, g, b]);

test('addresses: private IPv4 literals only, with an optional port', () => {
  for (const ok of ['10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.20', '169.254.10.10']) assert.equal(isPrivateIpv4(ok), true, ok);
  for (const no of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '127.0.0.1', '0.0.0.0', '192.169.0.1', '192.168.001.20', '192.168.1', 'hubitat.local', '::1', 'fd00::1', '']) {
    assert.equal(isPrivateIpv4(no), false, no);
  }
  assert.deepEqual(parseLanSyncAddress(' 192.168.1.20 '), { host: '192.168.1.20', port: 39501, path: '/' });
  assert.deepEqual(parseLanSyncAddress('http://10.1.2.3:8080/'), { host: '10.1.2.3', port: 8080, path: '/' });
  assert.match((parseLanSyncAddress('hubitat.local') as { error: string }).error, /host names are not looked up/);
  assert.match((parseLanSyncAddress('1.1.1.1') as { error: string }).error, /not a private network address/);
  assert.match((parseLanSyncAddress('192.168.1.20:70000') as { error: string }).error, /out of range/);
  assert.match((parseLanSyncAddress('192.168.1.20:0') as { error: string }).error, /out of range/);
  assert.match((parseLanSyncAddress('') as { error: string }).error, /no address/);
  assert.equal(lanSyncAddressText({ host: '192.168.1.20', port: 39501, path: '/' }), '192.168.1.20');
  assert.equal(lanSyncAddressText({ host: '192.168.1.20', port: 8080, path: '/' }), '192.168.1.20:8080');
});

test('addresses: a Home Assistant webhook URL (port 8123 unless given), its id kept out of descriptions', () => {
  assert.deepEqual(parseLanSyncAddress('http://192.168.1.5/api/webhook/abcDEF-123_x'), { host: '192.168.1.5', port: 8123, path: '/api/webhook/abcDEF-123_x' });
  assert.deepEqual(parseLanSyncAddress('192.168.1.5:9000/api/webhook/x/'), { host: '192.168.1.5', port: 9000, path: '/api/webhook/x' });
  assert.deepEqual(parseLanSyncAddress('192.168.1.5/custom'), { host: '192.168.1.5', port: 39501, path: '/custom' }, 'other paths keep the Hubitat port');
  assert.match((parseLanSyncAddress('https://192.168.1.5:8123/api/webhook/x') as { error: string }).error, /https is not supported/);
  assert.match((parseLanSyncAddress('http://homeassistant.local:8123/api/webhook/x') as { error: string }).error, /host names/);
  assert.match((parseLanSyncAddress('192.168.1.5/api/webhook/a b') as { error: string }).error, /not a usable path/);
  assert.match((parseLanSyncAddress('192.168.1.5/api/../x') as { error: string }).error, /not a usable path/);
  assert.match((parseLanSyncAddress('192.168.1.5/api/webhook/x?y=1') as { error: string }).error, /not an IPv4 address/);
  const ha = { host: '192.168.1.5', port: 8123, path: '/api/webhook/3f9a6c0d2b1e' };
  assert.equal(lanSyncAddressText(ha), 'http://192.168.1.5:8123/api/webhook/3f9a6c0d2b1e');
  assert.equal(describeLanTarget(ha), '192.168.1.5:8123/api/webhook/3f9a…');
  assert.deepEqual(normalizeLanSyncSettings({ enabled: true, host: '192.168.1.5', port: 8123, path: '/api/webhook/x' }).path, '/api/webhook/x');
  assert.equal(normalizeLanSyncSettings({ enabled: true, host: '192.168.1.5', path: 'no-slash' }).path, '/');
});

test('the stored setting is normalized: on only with a private host', () => {
  assert.deepEqual(normalizeLanSyncSettings(undefined), { enabled: false, host: '', port: 39501, path: '/' });
  assert.deepEqual(normalizeLanSyncSettings({ enabled: true, host: '192.168.1.20', port: 8080, path: '/' }), { enabled: true, host: '192.168.1.20', port: 8080, path: '/' });
  assert.deepEqual(normalizeLanSyncSettings({ enabled: true, host: '1.1.1.1' }), { enabled: false, host: '', port: 39501, path: '/' });
  assert.deepEqual(normalizeLanSyncSettings({ enabled: 'yes', host: '10.0.0.2', port: 'x' }), { enabled: false, host: '10.0.0.2', port: 39501, path: '/' });
});

test('frameZones: the whole screen and 20 % border bands; the document', () => {
  // Left 10 columns red, right 10 blue, everything else black; top 8 rows get green added.
  const frame = rgbaFrame((row, col) => [col < 10 ? 200 : 0, row < 8 ? 100 : 0, col >= 40 ? 250 : 0]);
  const z = frameZones(frame);
  assert.deepEqual(z.left, [200, 20, 0]);
  assert.deepEqual(z.right, [0, 20, 250]);
  assert.deepEqual(z.top, [40, 100, 50]);
  assert.deepEqual(z.bottom, [40, 0, 50]);
  assert.deepEqual(z.all, [40, 20, 50]);
  assert.deepEqual(JSON.parse(lanSyncDocument(7, z)), {
    source: 'EPC4Linux',
    version: 1,
    seq: 7,
    active: true,
    color: [40, 20, 50],
    zones: { left: [200, 20, 0], right: [0, 20, 250], top: [40, 100, 50], bottom: [40, 0, 50] },
  });
  assert.deepEqual(JSON.parse(lanSyncDocument(8, null)), { source: 'EPC4Linux', version: 1, seq: 8, active: false });
});

/** A sender over manual timers whose requests finish when the test says so. */
function senderRig(settings: LanSyncSettings = ON) {
  const timers = new ManualTimers();
  const posts: Array<{ host: string; port: number; path: string; doc: Record<string, unknown>; done: (ok: boolean) => void }> = [];
  const sender = new LanColorSender({
    log: silentLog,
    settings,
    timers,
    now: () => timers.now,
    post: (host, port, path, body) =>
      new Promise((resolve, reject) => {
        posts.push({ host, port, path, doc: JSON.parse(body), done: (ok) => (ok ? resolve(200) : reject(new Error('ECONNREFUSED'))) });
      }),
  });
  /** Finish the open request (and let the sender react). */
  const answer = async (ok = true) => {
    posts.at(-1)!.done(ok);
    await flush();
  };
  return { timers, posts, sender, answer };
}

test('sender: off by default; on, the first frame goes out at once; one request at a time, newest wins', async () => {
  const off = senderRig({ enabled: false, host: '', port: 39501, path: '/' });
  off.sender.push(solid(10, 20, 30));
  assert.equal(off.posts.length, 0);

  const { timers, posts, sender, answer } = senderRig();
  sender.push(solid(10, 20, 30));
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0].host, posts[0].port, posts[0].doc.active, posts[0].doc.color], ['192.168.1.20', 39501, true, [10, 20, 30]]);
  timers.advance(LAN_SYNC_HUBITAT_INTERVAL_MS * 2);
  sender.push(solid(100, 0, 0));
  sender.push(solid(0, 100, 0));
  assert.equal(posts.length, 1, 'the request is still open: nothing else is sent');
  await answer();
  assert.equal(posts.length, 2, 'the newest colours as soon as it finished');
  assert.deepEqual(posts[1].doc.color, [0, 100, 0]);
  assert.equal(posts[1].doc.seq, (posts[0].doc.seq as number) + 1);
});

test('sender: small changes wait for the heartbeat, big ones for the minimum interval', async () => {
  const { timers, posts, sender, answer } = senderRig();
  sender.push(solid(10, 20, 30));
  await answer();
  sender.push(solid(10 + LAN_SYNC_CHANGE_DELTA - 1, 20, 30));
  timers.advance(LAN_SYNC_HEARTBEAT_MS - 1);
  assert.equal(posts.length, 1, 'below the threshold: nothing until the heartbeat');
  timers.advance(1);
  assert.equal(posts.length, 2, 'the heartbeat');
  await answer();
  sender.push(solid(200, 20, 30));
  assert.equal(posts.length, 2, 'a big change right after a send waits for the minimum interval');
  timers.advance(LAN_SYNC_HUBITAT_INTERVAL_MS);
  assert.equal(posts.length, 3);
  assert.deepEqual(posts[2].doc.color, [200, 20, 30]);
});

test('sender: the end of the stream is sent once; close() waits for it; turning off or moving tells the old hub', async () => {
  const { timers, posts, sender, answer } = senderRig();
  sender.push(null);
  assert.equal(posts.length, 0, 'nothing was active: nothing to end');
  sender.push(solid(1, 2, 3));
  await answer();
  sender.push(null);
  sender.push(null);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].doc, { source: 'EPC4Linux', version: 1, seq: posts[1].doc.seq, active: false });
  await answer();
  timers.advance(LAN_SYNC_HEARTBEAT_MS * 3);
  assert.equal(posts.length, 2, 'no heartbeat while inactive');

  sender.push(solid(9, 9, 9));
  await answer();
  const closing = sender.close(1000);
  assert.equal(posts.at(-1)!.doc.active, false);
  posts.at(-1)!.done(true);
  await closing;

  sender.push(solid(5, 5, 5));
  await answer();
  sender.configure({ enabled: true, host: '10.0.0.7', port: 8080, path: '/' });
  assert.deepEqual([posts.at(-2)!.host, posts.at(-2)!.doc.active], ['192.168.1.20', false], 'the old hub hears the end');
  posts.at(-2)!.done(true);
  assert.deepEqual([posts.at(-1)!.host, posts.at(-1)!.port, posts.at(-1)!.doc.active, posts.at(-1)!.doc.color], ['10.0.0.7', 8080, true, [5, 5, 5]], 'the new one gets the newest colours at once');
  await answer();
  const before = posts.length;
  sender.configure({ enabled: false, host: '10.0.0.7', port: 8080, path: '/' });
  assert.equal(posts.length, before + 1);
  assert.deepEqual([posts.at(-1)!.host, posts.at(-1)!.doc.active], ['10.0.0.7', false]);
  sender.push(solid(7, 7, 7));
  assert.equal(posts.length, before + 1, 'off: nothing more');
});

test('sender: Home Assistant gets up to 20 documents per second, Hubitat 5', async () => {
  assert.equal(lanSyncMinInterval({ path: '/' }), LAN_SYNC_HUBITAT_INTERVAL_MS);
  assert.equal(lanSyncMinInterval({ path: '/api/webhook/x' }), LAN_SYNC_MIN_INTERVAL_MS);
  assert.deepEqual([LAN_SYNC_MIN_INTERVAL_MS, LAN_SYNC_HUBITAT_INTERVAL_MS], [50, 200]);
  const { timers, posts, sender, answer } = senderRig({ enabled: true, host: '192.168.1.5', port: 8123, path: '/api/webhook/x' });
  sender.push(solid(10, 20, 30));
  await answer();
  sender.push(solid(200, 20, 30));
  timers.advance(LAN_SYNC_MIN_INTERVAL_MS - 1);
  assert.equal(posts.length, 1);
  timers.advance(1);
  assert.equal(posts.length, 2, 'after 50 ms');
  assert.equal(posts[1].path, '/api/webhook/x');
});

test('sender: an unreachable hub slows the attempts down, logged once', async () => {
  const { timers, posts, sender, answer } = senderRig();
  sender.push(solid(1, 2, 3));
  await answer(false);
  assert.equal(sender.failing, true);
  sender.push(solid(200, 2, 3));
  timers.advance(LAN_SYNC_HUBITAT_INTERVAL_MS);
  assert.equal(posts.length, 1, 'not at the normal rate');
  timers.advance(LAN_SYNC_FAILING_INTERVAL_MS - LAN_SYNC_HUBITAT_INTERVAL_MS);
  assert.equal(posts.length, 2);
  await answer(true);
  assert.equal(sender.failing, false);
});

test('FollowVideoEngine frame sink: frames while the uploads run, null once on pause and stop', async () => {
  const capture = new FakeCaptureHost();
  const timers = new ManualTimers();
  const seen: Array<string> = [];
  const engine = new FollowVideoEngine({
    log: silentLog,
    capture,
    target: () => null,
    timers,
    frameSink: (f) => seen.push(f ? `frame ${f.data[0]}` : 'null'),
  });
  engine.setWanted(true);
  await flush();
  capture.frame(solid(1, 0, 0));
  capture.frame(solid(2, 0, 0));
  engine.setPaused(true);
  capture.frame(solid(3, 0, 0));
  engine.setPaused(false);
  capture.frame(solid(4, 0, 0));
  engine.setWanted(false);
  engine.setWanted(false);
  assert.deepEqual(seen, ['frame 1', 'frame 2', 'null', 'frame 4', 'null'], 'no ENE needed; paused frames are not passed on');

  const throwing = new FollowVideoEngine({ log: silentLog, capture: new FakeCaptureHost(), target: () => null, timers, frameSink: () => { throw new Error('boom'); } });
  throwing.setWanted(true);
  await flush();
  assert.doesNotThrow(() => throwing.setWanted(false));
});

test('httpPost: a real POST to a loopback server', async () => {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      bodies.push(`${req.method} ${req.url} ${req.headers['content-type']} ${body}`);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address() as AddressInfo;
    assert.equal(await httpPost('127.0.0.1', port, '/', '{"a":1}', 2000), 200);
    assert.deepEqual(bodies, ['POST / application/json {"a":1}']);
    // A webhook path: one kept-open connection for consecutive requests.
    const sockets = new Set<unknown>();
    server.on('connection', (sock) => sockets.add(sock));
    assert.equal(await httpPost('127.0.0.1', port, '/api/webhook/t', '{"b":1}', 2000), 200);
    assert.equal(await httpPost('127.0.0.1', port, '/api/webhook/t', '{"b":2}', 2000), 200);
    assert.deepEqual(bodies.slice(1), ['POST /api/webhook/t application/json {"b":1}', 'POST /api/webhook/t application/json {"b":2}']);
    assert.equal(sockets.size, 1, 'the connection was reused');
  } finally {
    server.closeAllConnections();
    server.close();
  }
  await assert.rejects(httpPost('127.0.0.1', 1, '/', '{}', 2000), /ECONNREFUSED/);
});

test('AmbiglowService: Follow Video frames reach the hub while the effect runs; another effect and stop() end the stream; setLanSync switches live', async () => {
  const docs: Array<{ host: string; doc: Record<string, unknown> }> = [];
  const r = await rig({
    service: {
      lanSync: ON,
      lanPost: async (host, _port, _path, body) => {
        docs.push({ host, doc: JSON.parse(body) });
        return 200;
      },
    },
  });
  try {
    assert.equal(r.service.followVideo.state, 'running', "the user's profile: FollowVideo with the ENE");
    r.capture.frame(rgbaFrame(() => [10, 20, 30]));
    await flush();
    assert.deepEqual(docs.map((d) => [d.host, d.doc.active, d.doc.color]), [['192.168.1.20', true, [10, 20, 30]]]);
    assert.deepEqual([...r.mock!.state().frame.subarray(0, 3)], [10, 20, 30], 'the LEDs are driven as before');

    // Breathing instead of FollowVideo: the capture stops and the hub hears the end of the stream.
    assert.equal((await r.call('Effect_Change', [100000, 5])).err_code, 0);
    await flush();
    assert.equal(r.service.followVideo.state, 'stopped');
    assert.equal(docs.at(-1)!.doc.active, false);

    assert.equal((await r.call('Effect_Change', [100000, 1])).err_code, 0);
    await flush();
    r.service.setLanSync({ enabled: true, host: '10.0.0.9', port: 39501, path: '/' });
    r.timers.advance(1000);
    r.capture.frame(rgbaFrame(() => [200, 0, 0]));
    await flush();
    assert.deepEqual([docs.at(-1)!.host, docs.at(-1)!.doc.color], ['10.0.0.9', [200, 0, 0]]);

    const before = docs.length;
    await r.service.stop();
    assert.deepEqual([docs.length, docs.at(-1)!.host, docs.at(-1)!.doc.active], [before + 1, '10.0.0.9', false], 'stop() ends the stream');
  } finally {
    await r.cleanup();
  }
});
