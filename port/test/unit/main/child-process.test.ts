// Helpers started with spawnTied (src/main/child-process.ts) die with the app, even when the app dies
// without running its exit path (crash, SIGKILL).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { findOnPath, tiedArgv } from '../../../src/main/child-process.ts';

const hasSetpriv = findOnPath('setpriv') !== null;
const MODULE = join(import.meta.dirname, '..', '..', '..', 'src', 'main', 'child-process.ts');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('argv: setpriv --pdeathsig TERM with the resolved executable; plain spawn otherwise', () => {
  const env = { PATH: '/nonexistent:/usr/bin:/bin' };
  const sh = findOnPath('sh', env);
  assert.ok(sh?.endsWith('/sh'));
  if (hasSetpriv) assert.deepEqual(tiedArgv('sh', ['-c', 'true'], env), [findOnPath('setpriv', env), ['--pdeathsig', 'TERM', '--', sh, '-c', 'true']]);
  assert.deepEqual(tiedArgv('evnia-missing-tool', ['x'], env), ['evnia-missing-tool', ['x']], 'missing: spawn reports ENOENT as usual');
  assert.deepEqual(tiedArgv('sh', [], { PATH: '/nonexistent' }), ['sh', []]);
  assert.equal(findOnPath('sh', { PATH: 'relative/dir' }), null, 'relative PATH entries are ignored');
});

test('a tied helper is terminated when its parent is SIGKILLed', { skip: !hasSetpriv && 'setpriv (util-linux) not installed' }, async () => {
  const script = `
    import { spawnTied } from ${JSON.stringify(MODULE)};
    const c = spawnTied('sleep', ['30'], { stdio: 'ignore', env: process.env });
    c.on('spawn', () => console.log(c.pid));
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const childPid = await new Promise<number>((resolve, reject) => {
    parent.stdout.once('data', (d: Buffer) => resolve(Number(String(d).trim())));
    parent.once('exit', () => reject(new Error('parent exited early')));
  });
  await new Promise((r) => setTimeout(r, 200)); // let setpriv exec sleep
  assert.equal(alive(childPid), true);
  assert.match(spawnSync('ps', ['-o', 'args=', '-p', String(childPid)], { encoding: 'utf8' }).stdout, /sleep 30/);
  parent.kill('SIGKILL');
  const deadline = Date.now() + 3000;
  while (alive(childPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(childPid), false, 'no orphan left behind');
});
