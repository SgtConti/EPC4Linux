import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { HubConnectionState } from '@microsoft/signalr';
import {
  HUB_DEFAULTS,
  MAX_BUFFERED_BYTES,
  SHUTDOWN_GRACE_MS,
  startSignalRServer,
  type HubServer,
  type HubServerOptions,
} from '../../../src/backend/hub/signalr-server.ts';
import { REJECTION_LOG_DEFAULTS } from '../../../src/backend/hub/rejection-log.ts';
import { generateHubToken } from '../../../src/backend/hub/security.ts';
import { captureLogger, type LogLine } from '../rpc/helpers.ts';
import { HANDSHAKE, RS, RawClient, invocation, sleep, vendorClient, waitFor } from './helpers.ts';

interface Harness {
  server: HubServer;
  token: string;
  lines: LogLine[];
  requests: string[];
}

/** Echo backend: replies with a JsonResult-like object carrying the request's ids and the raw request as Tag. */
function echo(request: string): string {
  let RequestId: unknown = null;
  let FunctionName: unknown = null;
  try {
    ({ requestId: RequestId = null, functionName: FunctionName = null } = JSON.parse(request) as Record<string, unknown>);
  } catch {
    // not JSON: reply without ids
  }
  return JSON.stringify({ err_code: 0, err_msg: '', RequestId, FunctionName, Tag: request });
}

async function start(t: TestContext, o: Partial<HubServerOptions> = {}): Promise<Harness> {
  const { log, lines } = captureLogger('hub');
  const token = generateHubToken();
  const requests: string[] = [];
  const server = await startSignalRServer({
    port: 0,
    token,
    log,
    getTaskAsync: async (request) => {
      requests.push(request);
      return echo(request);
    },
    ...o,
  });
  t.after(() => server.close());
  return { server, token, lines, requests };
}

const req = (functionName: string, requestId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ functionName, requestId, parms: null, ...extra });

/** Status code of a plain HTTP request to the hub port. */
function httpStatus(port: number, method: string, path: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, method, path }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject).end();
  });
}

test('vendor-configured 7.0.14 client: invoke GetTaskAsync, reply arrives as a "GetTaskAsync" event before the Completion', async (t) => {
  const { server, token, requests } = await start(t);
  const hub = vendorClient(server.port, token);
  const events: string[] = [];
  hub.on('GetTaskAsync', (json: string) => events.push(json));
  await hub.start();
  t.after(() => hub.stop());
  assert.equal(server.connectionCount, 1);

  const request = req('Start', '683a49b0-ff8e-4e9e-aa25-30a2e8d09b87');
  const completion = await hub.invoke('GetTaskAsync', request);
  assert.equal(completion, null); // Task GetTaskAsync → Completion with "result":null, as ASP.NET Core 3.1
  assert.equal(events.length, 1, 'the broadcast is processed before the Completion');
  assert.deepEqual(JSON.parse(events[0]), JSON.parse(echo(request)));
  assert.deepEqual(requests, [request]);
});

test('replies go to the caller only (security spec §10.7, vendor S4); notifications are broadcast to every client', async (t) => {
  const { server, token } = await start(t);
  const clients = [vendorClient(server.port, token), vendorClient(server.port, token)];
  const got = clients.map(() => ({ replies: [] as string[], notes: [] as string[] }));
  clients.forEach((c, i) => {
    c.on('GetTaskAsync', (j: string) => got[i].replies.push(j));
    c.on('Notification', (j: string) => got[i].notes.push(j));
  });
  await Promise.all(clients.map((c) => c.start()));
  t.after(() => Promise.all(clients.map((c) => c.stop())));
  assert.equal(server.connectionCount, 2);

  // The vendor's Clients.All would have shown client 0's reply (serials, file paths) to client 1 too.
  const a = req('Theme_GetThemeInfos', 'a');
  await clients[0].invoke('GetTaskAsync', a);
  assert.deepEqual(got[0].replies, [echo(a)], 'the caller gets its reply before the Completion');
  const b = req('Device_GetConnectList', 'b');
  await clients[1].invoke('GetTaskAsync', b);
  assert.deepEqual(got[1].replies, [echo(b)]);
  // A further round trip on each connection: anything sent to a client earlier (in order) has arrived by then.
  await Promise.all(clients.map((c) => c.invoke('GetTaskAsync', req('Start', 'flush'))));
  assert.deepEqual(got[0].replies, [echo(a), echo(req('Start', 'flush'))], 'client 0 never sees client 1\'s reply');
  assert.deepEqual(got[1].replies, [echo(b), echo(req('Start', 'flush'))], 'client 1 never sees client 0\'s reply');

  const note = '{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":1,"FunctionName":"NotifyDeviceConnectionStatus","CurrItem":null}';
  server.broadcast('Notification', note);
  await waitFor(() => got.every((g) => g.notes.length === 1), 3000, 'notifications');
  assert.deepEqual(got.map((g) => g.notes[0]), [note, note]);
});

test('wrong or missing token, foreign Origin, other paths and plain HTTP are rejected and logged', async (t) => {
  const { server, token, lines } = await start(t);
  const port = server.port;

  await assert.rejects(vendorClient(port, 'x'.repeat(43)).start());
  await assert.rejects(RawClient.open(port, ''), /HTTP 403/);
  await assert.rejects(RawClient.open(port, `?k=${token}x`), /HTTP 403/);
  await assert.rejects(vendorClient(port, token, { headers: { Origin: 'https://evil.example' } }).start());
  await assert.rejects(RawClient.open(port, `?k=${token}`, { Origin: 'http://localhost:10010' }), /HTTP 403/);
  await assert.rejects(RawClient.open(port, `?k=${token}`, {}, '/Other'), /HTTP 404/);
  await assert.rejects(RawClient.open(port, `?k=${token}`, {}, '/EvniaHub/negotiate'), /HTTP 404/);
  await assert.rejects(RawClient.open(port, `?k=${token}`, { Host: `rebound.example:${port}` }), /HTTP 403/);
  assert.equal(server.connectionCount, 0);
  // an upgrade without any Host header never gets through either
  const noHost = await new Promise<string>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET /EvniaHub?k=${token} HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let data = '';
    s.on('data', (d) => (data += String(d)));
    s.on('close', () => resolve(data));
    s.on('error', reject);
  });
  assert.match(noHost, /^HTTP\/1\.1 (400|403) /);

  assert.equal(await httpStatus(port, 'POST', `/EvniaHub/negotiate?negotiateVersion=1&k=${token}`), 404);
  assert.equal(await httpStatus(port, 'GET', `/EvniaHub?k=${token}`), 404);
  assert.equal(await httpStatus(port, 'GET', '/swagger/index.html'), 404);

  const rejected = lines.filter((l) => l.level === 'warn' && l.text.startsWith('rejected'));
  assert.ok(rejected.some((l) => l.text.includes('missing or wrong token')));
  assert.ok(rejected.some((l) => l.text.includes('foreign Origin') && l.text.includes('https://evil.example')));
  assert.ok(rejected.some((l) => l.text.includes('not the hub endpoint')));
  assert.ok(rejected.some((l) => l.text.includes(`unexpected Host rebound.example:${port}`)));
  assert.ok(rejected.some((l) => l.text.startsWith('rejected HTTP POST /EvniaHub/negotiate')));
  assert.ok(lines.every((l) => !l.text.includes(token)), 'the token is never logged');

  // The app's own origins are accepted (Electron file:// pages, opaque origins), also via "localhost".
  for (const origin of ['file://', 'null']) {
    const hub = vendorClient(port, token, { headers: { Origin: origin } });
    await hub.start();
    await hub.stop();
  }
  const viaLocalhost = await RawClient.open(port, `?k=${token}`, { Host: `localhost:${port}`, Origin: 'file://' });
  await viaLocalhost.handshake();
  viaLocalhost.ws.terminate();
});

test('the hub listens on 127.0.0.1 only', async (t) => {
  const { server } = await start(t);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return t.skip('no non-loopback IPv4 interface');
  const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    const s = net.connect(server.port, lan.address);
    s.once('connect', () => {
      s.destroy();
      resolve(null);
    });
    s.once('error', resolve);
  });
  assert.equal(error?.code, 'ECONNREFUSED');
});

test('server pings keep an idle vendor client connected', async (t) => {
  const { server, token } = await start(t, { keepAliveIntervalMs: 200 });
  const hub = vendorClient(server.port, token, { serverTimeoutMs: 1000 });
  let dropped = false;
  hub.onreconnecting(() => (dropped = true));
  hub.onclose(() => (dropped = true));
  await hub.start();
  t.after(() => hub.stop());

  const raw = await RawClient.open(server.port, `?k=${token}`);
  t.after(() => raw.ws.terminate());
  await raw.handshake();
  await sleep(2500);
  assert.equal(hub.state, HubConnectionState.Connected);
  assert.equal(dropped, false);
  const pings = raw.records.filter((r) => r === '{"type":6}').length;
  assert.ok(pings >= 6 && pings <= 16, `about one ping per 200 ms while idle, got ${pings}`);
  assert.equal(HUB_DEFAULTS.keepAliveIntervalMs, 15_000);
});

test('a GetTaskAsync that outlasts both timeouts keeps the vendor client connected (the 21 s Start, 20 §1.4/§7.2)', async (t) => {
  // Scaled down 15 s / 30 s / 30 s: server pings every 200 ms, both sides give up after 1 s of silence,
  // and the handler runs 3 s while the connection's invocation queue is busy.
  const slowMs = 3000;
  const { server, token } = await start(t, {
    keepAliveIntervalMs: 200,
    clientTimeoutMs: 1000,
    getTaskAsync: async (request) => {
      if ((JSON.parse(request) as { functionName: string }).functionName === 'Start') await sleep(slowMs);
      return echo(request);
    },
  });
  const hub = vendorClient(server.port, token, { serverTimeoutMs: 1000, keepAliveMs: 200 });
  const events: string[] = [];
  hub.on('GetTaskAsync', (json: string) => events.push((JSON.parse(json) as { RequestId: string }).RequestId));
  let dropped = '';
  hub.onreconnecting((e) => (dropped ||= `reconnecting: ${String(e?.message)}`));
  hub.onclose((e) => (dropped ||= `closed: ${String(e?.message)}`));
  await hub.start();
  t.after(() => hub.stop());

  let minConnections = Infinity;
  const sampler = setInterval(() => (minConnections = Math.min(minConnections, server.connectionCount)), 50);
  t.after(() => clearInterval(sampler));
  const t0 = performance.now();
  const slow = hub.invoke('GetTaskAsync', req('Start', 'slow')).then(() => performance.now() - t0);
  const queued = hub.invoke('GetTaskAsync', req('Setting_GlobalData', 'queued')).then(() => performance.now() - t0);
  const [slowAt, queuedAt] = await Promise.all([slow, queued]);
  clearInterval(sampler);

  assert.ok(slowAt >= slowMs - 20, `the slow reply came after ${Math.round(slowAt)} ms`);
  assert.ok(queuedAt >= slowAt, 'the second request waited in the queue behind the slow one');
  assert.deepEqual(events, ['slow', 'queued']);
  assert.equal(dropped, '', 'no reconnect or close on the client');
  assert.equal(hub.state, HubConnectionState.Connected);
  assert.equal(minConnections, 1, 'the server never dropped the connection');
  assert.equal(server.connectionCount, 1);
});

test('without server pings the client gives up (why the 15 s keep-alive matters)', async (t) => {
  const { server, token } = await start(t, { keepAliveIntervalMs: 60_000 });
  const hub = vendorClient(server.port, token, { serverTimeoutMs: 600 });
  const reconnecting = new Promise<Error | undefined>((resolve) => hub.onreconnecting(resolve));
  await hub.start();
  t.after(() => hub.stop());
  const err = await reconnecting;
  assert.match(String(err?.message), /Server timeout elapsed without receiving a message from the server/);
});

test('silent connections are dropped: no handshake, or nothing received for the client timeout', async (t) => {
  const { server, token, lines } = await start(t, { handshakeTimeoutMs: 300, clientTimeoutMs: 500, keepAliveIntervalMs: 100 });
  const noHandshake = await RawClient.open(server.port, `?k=${token}`);
  const mute = await RawClient.open(server.port, `?k=${token}`);
  await mute.handshake();
  const hub = vendorClient(server.port, token, { keepAliveMs: 100 }); // the real client pings back
  await hub.start();
  t.after(() => hub.stop());

  await Promise.all([noHandshake.closed, mute.closed]);
  await sleep(600);
  assert.equal(hub.state, HubConnectionState.Connected);
  assert.equal(server.connectionCount, 1);
  assert.ok(lines.some((l) => l.text.includes('no handshake within 300 ms')));
  assert.ok(lines.some((l) => l.text.includes('nothing received for 500 ms')));
});

test('framing: handshake plus requests in one message, records split across text and binary frames', async (t) => {
  const { server, token, requests } = await start(t);
  const raw = await RawClient.open(server.port, `?k=${token}`);
  t.after(() => raw.ws.terminate());

  const r0 = req('Start', 'r0');
  raw.send(HANDSHAKE + invocation(r0, '0'));
  assert.deepEqual(await raw.next(), {});
  assert.deepEqual(await raw.next(), { type: 1, target: 'GetTaskAsync', arguments: [echo(r0)] });
  assert.deepEqual(await raw.next(), { type: 3, invocationId: '0', result: null });

  // one record in three frames, split inside the 3-byte UTF-8 sequence of "解"
  const r1 = req('Macro_GetList', 'r1', { parms: ['解析'] });
  const bytes = Buffer.from(invocation(r1, '1'), 'utf8');
  const cut = bytes.indexOf(Buffer.from('解', 'utf8')) + 1;
  raw.send(bytes.subarray(0, 20).toString('utf8'));
  raw.send(bytes.subarray(20, cut));
  raw.send(bytes.subarray(cut));
  assert.deepEqual(await raw.nextNonPing(), { type: 1, target: 'GetTaskAsync', arguments: [echo(r1)] });
  assert.deepEqual(await raw.nextNonPing(), { type: 3, invocationId: '1', result: null });

  // several records in one message: ping, blocking and non-blocking invocations
  const r2 = req('Theme_GetCurTheme', 'r2');
  const r3 = req('Macro_GetFuncMenu', 'r3');
  raw.send(`{"type":6}${RS}${invocation(r2)}${invocation(r3, '2')}`);
  assert.deepEqual(await raw.nextNonPing(), { type: 1, target: 'GetTaskAsync', arguments: [echo(r2)] });
  assert.deepEqual(await raw.nextNonPing(), { type: 1, target: 'GetTaskAsync', arguments: [echo(r3)] });
  assert.deepEqual(await raw.nextNonPing(), { type: 3, invocationId: '2', result: null }); // none for the non-blocking one
  assert.deepEqual(requests, [r0, r1, r2, r3]);
});

test('invocation binding follows ASP.NET: unknown methods, wrong arity/types and streams get error Completions', async (t) => {
  const { server, token, requests } = await start(t);
  const raw = await RawClient.open(server.port, `?k=${token}`);
  t.after(() => raw.ws.terminate());
  await raw.handshake();
  const generic = "Failed to invoke 'GetTaskAsync' due to an error on the server.";
  const cases: [string, Record<string, unknown>][] = [
    [invocation('x', 'a', 'Nope'), { type: 3, invocationId: 'a', error: "Failed to invoke 'Nope' due to an error on the server. HubException: Method does not exist." }],
    [`{"type":1,"invocationId":"b","target":"GetTaskAsync","arguments":["x","y"]}${RS}`, { type: 3, invocationId: 'b', error: generic }],
    [`{"type":1,"invocationId":"c","target":"GetTaskAsync","arguments":[42]}${RS}`, { type: 3, invocationId: 'c', error: generic }],
    [`{"type":1,"invocationId":"d","target":"GetTaskAsync","arguments":["x"],"streamIds":["s"]}${RS}`, { type: 3, invocationId: 'd', error: generic }],
    [`{"type":4,"invocationId":"e","target":"GetTaskAsync","arguments":["x"]}${RS}`, { type: 3, invocationId: 'e', error: "The client attempted to invoke the non-streaming 'GetTaskAsync' method with a streaming invocation." }],
  ];
  for (const [frame, expected] of cases) {
    raw.send(frame);
    assert.deepEqual(await raw.nextNonPing(), expected);
  }
  assert.deepEqual(requests, []);

  // method names are case-insensitive; a null argument reaches the backend as ""
  raw.send(invocation(req('Start', 'f'), 'f', 'gettaskasync'));
  assert.equal((await raw.nextNonPing()).type, 1);
  assert.deepEqual(await raw.nextNonPing(), { type: 3, invocationId: 'f', result: null });
  raw.send(`{"type":1,"invocationId":"g","target":"GetTaskAsync","arguments":[null]}${RS}`);
  assert.deepEqual(await raw.nextNonPing(), { type: 1, target: 'GetTaskAsync', arguments: [echo('')] });
  assert.deepEqual(await raw.nextNonPing(), { type: 3, invocationId: 'g', result: null });
  assert.deepEqual(requests.slice(1), ['']);

  // a client Close ends the connection normally
  raw.send(`{"type":7}${RS}`);
  assert.equal((await raw.closed).code, 1000);
});

test('a backend failure answers the caller with an error Completion and broadcasts nothing', async (t) => {
  const { server, token, lines } = await start(t, {
    getTaskAsync: async () => {
      throw new Error('backend exploded');
    },
  });
  const hub = vendorClient(server.port, token);
  const events: string[] = [];
  hub.on('GetTaskAsync', (j: string) => events.push(j));
  await hub.start();
  t.after(() => hub.stop());
  await assert.rejects(hub.invoke('GetTaskAsync', req('Start', 'r')), /An unexpected error occurred invoking 'GetTaskAsync' on the server\./);
  assert.equal(events.length, 0);
  assert.equal(hub.state, HubConnectionState.Connected);
  assert.ok(lines.some((l) => l.level === 'error' && l.text.includes('backend exploded')));
});

test('malformed input closes only the offending connection; the server keeps serving', async (t) => {
  const { server, token, lines } = await start(t, { maxMessageBytes: 4096 });
  const hub = vendorClient(server.port, token);
  const replies: string[] = [];
  hub.on('GetTaskAsync', (j: string) => replies.push(j));
  await hub.start();
  t.after(() => hub.stop());

  const afterHandshake: [string, string | Buffer][] = [
    ['invalid JSON', `not json${RS}`],
    ['empty record', RS],
    ['JSON array', `[1,2]${RS}`],
    ['unknown message type', `{"type":42}${RS}`],
    ['invocation without target', `{"type":1,"arguments":[]}${RS}`],
    ['invalid UTF-8', Buffer.from([0x7b, 0xff, 0x7d, 0x1e])],
    ['oversized record', 'x'.repeat(4097)],
  ];
  for (const [what, frame] of afterHandshake) {
    const raw = await RawClient.open(server.port, `?k=${token}`);
    await raw.handshake();
    raw.send(frame);
    const closed = await raw.closed;
    assert.equal(closed.code, 1011, what);
    assert.deepEqual(JSON.parse(raw.records.filter((r) => r !== '{"type":6}').at(-1)!), { type: 7, error: 'Connection closed with an error.', allowReconnect: true }, what);
  }

  const beforeHandshake: [string, RegExp][] = [
    ['garbage', /^An unexpected error occurred during connection handshake\. InvalidDataException: Invalid JSON/],
    [`{"type":6}`, /Missing required property 'protocol'/],
    [`{"protocol":"messagepack","version":1}`, /^The protocol 'messagepack' is not supported\.$/],
  ];
  for (const [first, expected] of beforeHandshake) {
    const raw = await RawClient.open(server.port, `?k=${token}`);
    raw.send(first + RS);
    const response = await raw.next();
    assert.match(String(response.error), expected);
    assert.equal((await raw.closed).code, 1000);
  }

  // a WebSocket message above the transport limit is refused by ws itself
  const huge = await RawClient.open(server.port, `?k=${token}`);
  await huge.handshake();
  huge.send('x'.repeat(3 * 4096));
  assert.equal((await huge.closed).code, 1009);

  assert.ok(lines.filter((l) => l.text.includes('protocol error')).length >= afterHandshake.length);
  // the well-behaved client never noticed
  await hub.invoke('GetTaskAsync', req('Start', 'still-alive'));
  assert.equal(replies.length, 1);
  assert.equal(hub.state, HubConnectionState.Connected);
  const fresh = vendorClient(server.port, token);
  await fresh.start();
  await fresh.stop();
});

test('invocations from one connection run one at a time; other connections are not blocked', async (t) => {
  const started: string[] = [];
  const finished: string[] = [];
  const { server, token } = await start(t, {
    getTaskAsync: async (request) => {
      const { requestId, delay } = JSON.parse(request) as { requestId: string; delay: number };
      started.push(requestId);
      await sleep(delay);
      finished.push(requestId);
      return echo(request);
    },
  });
  const a = await RawClient.open(server.port, `?k=${token}`);
  const b = await RawClient.open(server.port, `?k=${token}`);
  t.after(() => {
    a.ws.terminate();
    b.ws.terminate();
  });
  await a.handshake();
  await b.handshake();
  a.send(invocation(req('Start', 'a1', { delay: 300 }), '1') + invocation(req('Start', 'a2', { delay: 0 }), '2'));
  await waitFor(() => started.length === 1, 3000, 'a1 to start');
  b.send(invocation(req('Start', 'b1', { delay: 0 }), '1'));
  await waitFor(() => finished.length === 3, 3000, 'all requests');
  assert.deepEqual(started, ['a1', 'b1', 'a2']);
  assert.deepEqual(finished, ['b1', 'a1', 'a2']);
});

test('port selection skips a busy port upward like the vendor', async (t) => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen({ port: 0, host: '127.0.0.1' }, resolve));
  t.after(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const busy = (blocker.address() as net.AddressInfo).port;
  const { server, lines } = await start(t, { port: busy });
  assert.ok(server.port > busy && server.port <= busy + 10, `bound ${server.port} after busy ${busy}`);
  assert.ok(lines.some((l) => l.text === `Port ${busy} is unavailable (EADDRINUSE), trying ${busy + 1}`));

  await assert.rejects(startSignalRServer({ port: 0, token: 'short', log: captureLogger().log, getTaskAsync: async () => '' }), /at least 16 characters/);
});

test('close(): clients get a reconnectable Close, the port is released, and close is idempotent', async (t) => {
  const { server, token } = await start(t);
  const port = server.port;
  const raw = await RawClient.open(port, `?k=${token}`);
  await raw.handshake();
  const hub = vendorClient(port, token);
  let reconnecting = false;
  hub.onreconnecting(() => (reconnecting = true));
  await hub.start();
  t.after(() => hub.stop());

  await server.close();
  assert.deepEqual(await raw.nextNonPing(), { type: 7, allowReconnect: true });
  assert.equal((await raw.closed).code, 1001);
  await waitFor(() => reconnecting, 3000, 'automatic reconnect to start');
  assert.equal(server.connectionCount, 0);
  await assert.rejects(RawClient.open(port, `?k=${token}`), /ECONNREFUSED/);
  await server.close();
  const reuse = net.createServer();
  await new Promise<void>((resolve, reject) => reuse.once('error', reject).listen({ port, host: '127.0.0.1' }, resolve));
  await new Promise<void>((resolve) => reuse.close(() => resolve()));
});

test('rejections are logged rate-limited: a flood from a web page gives a few lines and one summary per kind', async (t) => {
  const { server, lines } = await start(t);
  const port = server.port;
  const flood = 40;
  const { burst } = REJECTION_LOG_DEFAULTS;
  for (let i = 0; i < flood; i++) {
    await assert.rejects(RawClient.open(port, '', { Origin: 'https://evil.example' }), /HTTP 403/);
  }
  const statuses = await Promise.all(Array.from({ length: flood }, (_, i) => httpStatus(port, 'GET', `/img${i}.png`)));
  assert.ok(statuses.every((s) => s === 404));

  const warned = (kind: string) => lines.filter((l) => l.level === 'warn' && l.text.startsWith('rejected') && l.text.includes(kind));
  assert.equal(warned('foreign Origin').length, burst);
  assert.equal(warned('not a hub WebSocket upgrade').length, burst);
  assert.match(warned('foreign Origin').at(-1)!.text, /\(further rejections of this kind are summarized\)$/);
  assert.equal(lines.filter((l) => l.level === 'warn').length, 2 * burst);

  // the suppressed ones are reported when the window ends (here: at shutdown)
  await server.close();
  const summaries = lines.filter((l) => l.text.endsWith('not logged individually (foreign Origin)') || l.text.endsWith('not logged individually (plain HTTP request)'));
  assert.deepEqual(summaries.map((l) => [l.level, l.text.split(' ')[0]]), [['warn', String(flood - burst)], ['warn', String(flood - burst)]]);
});

test('keep-alive and timeouts use a monotonic clock: wall-clock steps neither drop clients nor stop pings', async (t) => {
  const { server, token } = await start(t, { keepAliveIntervalMs: 200, clientTimeoutMs: 1000 });
  const hub = vendorClient(server.port, token, { serverTimeoutMs: 1000, keepAliveMs: 200 }); // pings back within the 1 s client timeout
  let dropped = false;
  hub.onreconnecting(() => (dropped = true));
  hub.onclose(() => (dropped = true));
  await hub.start();
  t.after(() => hub.stop());
  const raw = await RawClient.open(server.port, `?k=${token}`);
  t.after(() => raw.ws.terminate());
  await raw.handshake();
  const clientPings = setInterval(() => raw.send(`{"type":6}${RS}`), 200);
  t.after(() => clearInterval(clientPings));

  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  // resume after a 1 h suspend (the wall clock jumps forward), then a correction backwards
  for (const step of [3_600_000, -3_600_000]) {
    Date.now = () => realNow() + step;
    const before = raw.records.length;
    await sleep(1500);
    const pings = raw.records.slice(before).filter((r) => r === '{"type":6}').length;
    assert.ok(pings >= 4, `server pings continue after a ${step} ms clock step (got ${pings})`);
    assert.equal(server.connectionCount, 2, `nobody dropped after a ${step} ms clock step`);
    assert.equal(hub.state, HubConnectionState.Connected);
    assert.equal(dropped, false);
  }
  Date.now = realNow;
});

test('invocations still queued on a connection that closes are dropped', async (t) => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { server, token } = await start(t, {
    getTaskAsync: async (request) => {
      started.push((JSON.parse(request) as { requestId: string }).requestId);
      await gate;
      return echo(request);
    },
  });
  const raw = await RawClient.open(server.port, `?k=${token}`);
  await raw.handshake();
  raw.send(invocation(req('Start', 'q1'), '1') + invocation(req('Start', 'q2'), '2'));
  await waitFor(() => started.length === 1, 3000, 'q1 to start');
  raw.ws.terminate();
  await waitFor(() => server.connectionCount === 0, 3000, 'the server to see the close');
  release();
  await sleep(100);
  assert.deepEqual(started, ['q1']);
});

test('a client that stops reading is dropped once 16 MiB are queued for it; the others are unaffected', async (t) => {
  const { server, token, lines } = await start(t);
  const good = await RawClient.open(server.port, `?k=${token}`);
  const slow = await RawClient.open(server.port, `?k=${token}`);
  t.after(() => {
    good.ws.terminate();
    slow.ws.terminate();
  });
  await good.handshake();
  await slow.handshake();
  slow.ws.pause();

  const chunk = 'x'.repeat(1_048_576);
  let sent = 0;
  while (server.connectionCount === 2 && sent < 4 * MAX_BUFFERED_BYTES) {
    server.broadcast('Notification', chunk);
    sent += chunk.length;
    await sleep(1); // lets the good client read
  }
  assert.equal(server.connectionCount, 1);
  assert.ok(sent > MAX_BUFFERED_BYTES, `dropped only after more than 16 MiB (${sent} bytes broadcast)`);
  assert.ok(lines.some((l) => l.level === 'warn' && /client is not reading \(\d+ bytes queued\), dropping it/.test(l.text)));
  assert.equal(good.ws.readyState, good.ws.OPEN);
  await waitFor(() => good.records.length === 1 + sent / chunk.length, 5000, 'the good client to receive every broadcast');
});

test('close() waits for GetTaskAsync calls that are already running and drops queued ones', async (t) => {
  const started: string[] = [];
  const finished: string[] = [];
  const { server, token } = await start(t, {
    getTaskAsync: async (request) => {
      const { requestId, delay } = JSON.parse(request) as { requestId: string; delay: number };
      started.push(requestId);
      await sleep(delay);
      finished.push(requestId);
      return echo(request);
    },
  });
  const raw = await RawClient.open(server.port, `?k=${token}`);
  t.after(() => raw.ws.terminate());
  await raw.handshake();
  raw.send(invocation(req('PHL_SetOSD', 'running', { delay: 300 }), '1') + invocation(req('Start', 'queued', { delay: 0 }), '2'));
  await waitFor(() => started.length === 1, 3000, 'the first call to start');
  const t0 = performance.now();
  await server.close();
  assert.deepEqual(finished, ['running'], 'close() resolved only after the running call finished');
  assert.ok(performance.now() - t0 < SHUTDOWN_GRACE_MS);
  await sleep(50);
  assert.deepEqual(started, ['running'], 'the queued call never ran');
});

test('close() stops waiting for a hung call after the grace period and says so', async (t) => {
  let calls = 0;
  const { server, token, lines } = await start(t, {
    getTaskAsync: () => {
      calls++;
      return new Promise<string>(() => {});
    },
  });
  const raw = await RawClient.open(server.port, `?k=${token}`);
  t.after(() => raw.ws.terminate());
  await raw.handshake();
  raw.send(invocation(req('Start', 'hung'), '1'));
  await waitFor(() => calls === 1, 3000, 'the call to start');
  const t0 = performance.now();
  await server.close();
  const took = performance.now() - t0;
  assert.ok(took >= SHUTDOWN_GRACE_MS - 20 && took < SHUTDOWN_GRACE_MS + 1000, `close() took ${took} ms`);
  assert.ok(lines.some((l) => l.level === 'warn' && l.text === `1 GetTaskAsync call(s) still running after ${SHUTDOWN_GRACE_MS} ms, stopping anyway`));
});
