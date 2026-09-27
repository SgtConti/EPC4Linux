// The backend smoke server (src/backend/serve.ts): `node src/backend/serve.ts --mock` starts the production
// composition and the hub on 127.0.0.1, prints {port, token, url, …} as one JSON line, answers the vendor
// client (the renderer's @microsoft/signalr 7.0.14 configuration), and shuts down cleanly on SIGTERM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main, parseServeArgs } from '../../src/backend/serve.ts';
import { HUB_PATH } from '../../src/backend/index.ts';
import { VendorRpc, vendorClient } from '../unit/hub/helpers.ts';
import { MOCK_SERIAL } from '../../src/backend/ddc/transports/mock-34m2c8600.ts';
import { composeSkipReason } from './compose.ts';

const PORT_DIR = fileURLToPath(new URL('../../', import.meta.url));

function captureIo(): { io: { out(t: string): void; err(t: string): void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (t) => void out.push(t), err: (t) => void err.push(t) }, out, err };
}

test('command line: usage errors exit 2 without starting anything; --help prints the usage', async () => {
  for (const argv of [['--port', 'x'], ['--port', '70000'], ['--model', '34M2C8600'], ['--no-ene'], ['bogus'], ['--token', 'short'], ['--frobnicate']]) {
    const { io, out, err } = captureIo();
    assert.equal(await main(argv, io, Promise.resolve()), 2, argv.join(' '));
    assert.deepEqual(out, [], 'nothing on stdout');
    assert.match(err.join(''), /usage: serve\.ts/);
  }
  const { io, out } = captureIo();
  assert.equal(await main(['--help'], io, Promise.resolve()), 0);
  assert.match(out.join(''), /^usage: serve\.ts/);
  assert.deepEqual(parseServeArgs(['serve', '--mock', '--no-ene', '--port', '0']).options, {
    mockMonitor: '34M2C8600/no-ene',
    port: 0,
    serveDataDir: undefined,
    resourcesDir: undefined,
    token: undefined,
    extraOrigins: undefined,
  });
  assert.equal(parseServeArgs([]).options.mockMonitor, undefined, 'real hardware without --mock');
});

test('node src/backend/serve.ts --mock: prints the hub, serves the vendor client, stops on SIGTERM', { timeout: 60_000, skip: composeSkipReason() ?? false }, async (t) => {
  const child = spawn(process.execPath, ['src/backend/serve.ts', 'serve', '--mock', '--port', '0'], { cwd: PORT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
  let stdout = '';
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
      const nl = stdout.indexOf('\n');
      if (nl >= 0) resolve(stdout.slice(0, nl));
    });
    void exited.then(({ code }) => reject(new Error(`serve.ts exited with ${code} before listening:\n${stderr}`)));
  });
  const info = JSON.parse(line) as { port: number; token: string; url: string; serveDataDir: string; hardware: string };
  assert.ok(info.port > 0);
  assert.ok(info.token.length >= 43, 'a 256-bit generateHubToken()');
  assert.equal(info.url, `ws://127.0.0.1:${info.port}${HUB_PATH}?k=${encodeURIComponent(info.token)}`);
  assert.equal(info.hardware, 'simulated monitor "34M2C8600" (EVNIA_MOCK_MONITOR)');
  assert.ok(existsSync(info.serveDataDir), 'a temporary EvniaServe directory');
  assert.equal(stderr.includes(info.token), false, 'the token is never logged');

  const hub = vendorClient(info.port, info.token);
  const rpc = new VendorRpc(hub);
  await hub.start();
  try {
    assert.equal(await rpc.invoke('Start'), true);
    const list = (await rpc.invoke('Device_GetConnectList')) as { ExtDeviceInfo: { CurSN: string } }[];
    assert.equal(list.length, 1);
    assert.equal(list[0].ExtDeviceInfo.CurSN, MOCK_SERIAL, 'serve.ts --mock is the simulated monitor of the product (synthetic serial)');
    const data = (await rpc.invoke('Profile_GetDeviceData', 100000)) as { ENEEffectEnable: boolean; OP_DC_DisplayApplication: { Value: number } };
    assert.equal(data.ENEEffectEnable, true, 'the default mock includes the ENE MCU');
    assert.equal(data.OP_DC_DisplayApplication.Value, 33);
    assert.deepEqual(await rpc.invoke('Setting_GlobalData'), { TurnOffLightsWhenIdle: false, TurnOffLightsWhenIdleDuration: 5 });
  } finally {
    await hub.stop();
  }

  child.kill('SIGTERM');
  const { code } = await exited;
  assert.equal(code, 0, `clean shutdown:\n${stderr.slice(-2000)}`);
  assert.equal(existsSync(info.serveDataDir), false, 'the temporary directory is removed');
  assert.match(stderr, /stopping/);
});
