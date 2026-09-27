// The Node-side egress ban of the main process (src/main/egress-guard.ts): loopback and Unix sockets only,
// no DNS. Installed in this test process only (each test file runs in its own process).

import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { after, before, test } from 'node:test';
import { connectTarget, EgressBlockedError, installEgressGuard, isAllowedPeer, isLoopbackIp } from '../../../src/main/egress-guard.ts';
import { captureLogger, type LogLine } from '../rpc/helpers.ts';

let lines: LogLine[];
let uninstall: () => void;
before(() => {
  const c = captureLogger('egress');
  lines = c.lines;
  uninstall = installEgressGuard(c.log);
});
after(() => uninstall());

const blocked = (e: unknown) => e instanceof EgressBlockedError && (e as NodeJS.ErrnoException).code === 'EACCES';

test('loopback literals and "localhost" are the only peers', () => {
  for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::FFFF:127.9.9.9', 'localhost', 'LOCALHOST.']) {
    assert.equal(isAllowedPeer(ok), true, ok);
  }
  for (const no of ['192.0.2.1', '10.0.0.1', '0.0.0.0', '::', '::2', 'fe80::1%eth0', '::ffff:192.0.2.1', '128.0.0.1', 'example.com', 'localhost.example.com', 'evil-localhost', '']) {
    assert.equal(isAllowedPeer(no), false, no);
  }
  assert.equal(isLoopbackIp('localhost'), false, 'a name is not a literal');
});

test('connect() arguments in every form Node accepts', () => {
  assert.deepEqual(connectTarget([{ host: '192.0.2.1', port: 80 }]), { host: '192.0.2.1', port: 80 });
  assert.deepEqual(connectTarget([[{ host: 'example.com', port: 443 }, null]]), { host: 'example.com', port: 443 }, 'normalized args');
  assert.deepEqual(connectTarget([{ port: 80 }]), { host: 'localhost', port: 80 });
  assert.deepEqual(connectTarget([{ path: '/run/x.sock' }]), { path: '/run/x.sock' });
  assert.deepEqual(connectTarget([8080, '10.0.0.1', () => {}]), { host: '10.0.0.1', port: 8080 });
  assert.deepEqual(connectTarget(['8080']), { host: 'localhost', port: '8080' });
  assert.deepEqual(connectTarget(['/tmp/sock']), { path: '/tmp/sock' });
});

test('outbound TCP/TLS/HTTP/fetch to a non-loopback peer is refused before any packet, and logged', async () => {
  lines.length = 0;
  assert.throws(() => net.connect({ host: '192.0.2.1', port: 9 }), blocked);
  assert.throws(() => net.connect(9, '10.0.0.1'), blocked);
  assert.throws(() => net.createConnection({ host: 'example.com', port: 80 }), blocked, 'by name, before DNS');
  assert.throws(() => new net.Socket().connect(443, '2001:db8::1'), blocked);
  assert.throws(() => tls.connect({ host: '192.0.2.1', port: 443 }), blocked);
  // http: the agent's createConnection throws inside http.get (or, were it deferred, as the request's error)
  await new Promise<void>((resolve, reject) => {
    const check = (e: unknown) => (blocked(e) ? resolve() : reject(e));
    try {
      http.get('http://192.0.2.1/').on('error', check).on('response', () => reject(new Error('connected')));
    } catch (e) {
      check(e);
    }
  });
  await assert.rejects(fetch('http://192.0.2.1/', { signal: AbortSignal.timeout(5000) }), (e: unknown) => blocked((e as Error).cause ?? e));
  assert.ok(lines.some((l) => l.level === 'warn' && l.text.includes('Blocked outbound connection to 192.0.2.1:9')), JSON.stringify(lines));
});

test('DNS: no lookups but localhost, no c-ares queries at all', async () => {
  await new Promise<void>((resolve) =>
    dns.lookup('example.com', (err) => {
      assert.ok(blocked(err), String(err));
      resolve();
    }),
  );
  await assert.rejects(dns.promises.lookup('example.com'), blocked);
  await assert.rejects(dns.promises.resolve4('example.com'), blocked);
  await assert.rejects(new dns.promises.Resolver().resolveTxt('example.com'), blocked);
  await new Promise<void>((resolve) =>
    dns.resolve4('example.com', (err) => {
      assert.ok(blocked(err));
      resolve();
    }),
  );
  await new Promise<void>((resolve) =>
    new dns.Resolver().reverse('192.0.2.1', (err) => {
      assert.ok(blocked(err));
      resolve();
    }),
  );
  const local = await dns.promises.lookup('localhost');
  assert.ok(isLoopbackIp(local.address), local.address);
  assert.equal((await dns.promises.lookup('192.0.2.1')).address, '192.0.2.1', 'a literal needs no query');
});

test('UDP to a non-loopback address is refused; loopback works', async () => {
  const s = dgram.createSocket('udp4');
  try {
    assert.throws(() => s.send('x', 53, '8.8.8.8'), blocked);
    assert.throws(() => s.send(Buffer.from('x'), 0, 1, 53, '192.0.2.1'), blocked);
    assert.throws(() => s.connect(53, '192.0.2.1'), blocked);
    const r = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => r.bind(0, '127.0.0.1', () => resolve()));
    const got = new Promise<string>((resolve) => r.once('message', (m) => resolve(String(m))));
    s.send('ping', r.address().port, '127.0.0.1');
    assert.equal(await got, 'ping');
    r.close();
  } finally {
    s.close();
  }
});

test('loopback TCP (the hub) and Unix sockets still work; servers are not affected', async () => {
  const server = net.createServer((c) => c.end('hub'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  const read = (c: net.Socket) => new Promise<string>((resolve, reject) => {
    let s = '';
    c.on('data', (d) => (s += d)).on('end', () => resolve(s)).on('error', reject);
  });
  assert.equal(await read(net.connect(port, '127.0.0.1')), 'hub');
  assert.equal(await read(net.connect({ port, host: 'localhost', family: 4 })), 'hub');
  server.close();
  const dir = mkdtempSync(join(tmpdir(), 'evnia-egress-'));
  try {
    const sock = join(dir, 's.sock');
    const unix = net.createServer((c) => c.end('unix'));
    await new Promise<void>((resolve) => unix.listen(sock, resolve));
    assert.equal(await read(net.connect(sock)), 'unix');
    assert.equal(await read(net.connect({ path: sock })), 'unix');
    unix.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('install is idempotent and the uninstaller restores Node', () => {
  const again = installEgressGuard(captureLogger('x').log);
  assert.equal(again, uninstall, 'the same guard');
  const guarded = net.Socket.prototype.connect;
  uninstall();
  assert.notEqual(net.Socket.prototype.connect, guarded, 'restored');
  uninstall = installEgressGuard(captureLogger('egress').log);
  assert.throws(() => net.connect(9, '192.0.2.1'), blocked);
});
