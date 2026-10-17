// Ambiglow from the command line (src/main/ambiglow-remote.ts): `--ambiglow=<value>` parsing, the restore point of an
// app run, the user's own change winning over restore, commands in arrival order, and the wait for the monitor.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AmbiglowRemoteState } from '../../../src/backend/ambiglow/service.ts';
import { createLogger } from '../../../src/backend/core/log.ts';
import { AMBIGLOW_READY_TIMEOUT_MS, AmbiglowRemote, parseAmbiglowCommand, type RemoteEffects } from '../../../src/main/ambiglow-remote.ts';

const lines: string[] = [];
const log = createLogger('test', (level, _scope, args) => void lines.push(`${level} ${args.map(String).join(' ')}`), 'debug');

/** The ambiglow service as the command line sees it; `null` state = no display with an ENE loaded yet. */
class FakeEffects implements RemoteEffects {
  state: AmbiglowRemoteState | null;
  readonly sets: Partial<AmbiglowRemoteState>[] = [];
  constructor(state: AmbiglowRemoteState | null) {
    this.state = state;
  }
  async remoteEffect() {
    return this.state ? { ...this.state } : null;
  }
  async setRemoteEffect(target: Partial<AmbiglowRemoteState>) {
    this.sets.push(target);
    this.state = { ...this.state!, ...target };
    return { ...this.state };
  }
}

function remote(effects: FakeEffects, o: { started?: () => number } = {}) {
  let now = 0;
  const r = new AmbiglowRemote({
    start: async () => o.started?.() ?? 10010,
    effects: () => effects,
    log,
    sleep: async (ms) => void (now += ms),
    now: () => now,
  });
  return { r, elapsed: () => now };
}

const STATIC_ON = { enabled: true, effect: 7 };

test('parseAmbiglowCommand: effects by name (case, - and _ ignored), on/off/restore, the last switch wins, bad values reported', () => {
  assert.equal(parseAmbiglowCommand(['/usr/bin/evnia-precision-center']), null);
  assert.equal(parseAmbiglowCommand(['--openAsHidden']), null);
  assert.deepEqual(parseAmbiglowCommand(['x', '--ambiglow=FollowVideo']), { kind: 'set', target: { effect: 1, enabled: true } });
  assert.deepEqual(parseAmbiglowCommand(['--ambiglow=follow-video']), { kind: 'set', target: { effect: 1, enabled: true } });
  assert.deepEqual(parseAmbiglowCommand(['--ambiglow=STARRY_NIGHT']), { kind: 'set', target: { effect: 6, enabled: true } });
  assert.deepEqual(parseAmbiglowCommand(['--ambiglow', 'static']), { kind: 'set', target: { effect: 7, enabled: true } });
  assert.deepEqual(parseAmbiglowCommand(['--ambiglow=on']), { kind: 'set', target: { enabled: true } });
  assert.deepEqual(parseAmbiglowCommand(['--ambiglow=Off']), { kind: 'set', target: { enabled: false } });
  assert.deepEqual(parseAmbiglowCommand(['--ambiglow=off', '--ambiglow=restore']), { kind: 'restore' });
  assert.match(parseAmbiglowCommand(['--ambiglow=disco']) as string, /unknown value "disco".*FollowVideo/);
  assert.match(parseAmbiglowCommand(['--ambiglow', '--openAsHidden']) as string, /unknown value ""/);
  assert.equal(parseAmbiglowCommand(['--ambiglowx=on']), null);
});

test('set then restore: the state before the first set comes back; later sets keep that restore point; a second restore does nothing', async () => {
  const effects = new FakeEffects(STATIC_ON);
  const { r } = remote(effects);
  await r.run({ kind: 'set', target: { effect: 1, enabled: true } });
  await r.run({ kind: 'set', target: { enabled: false } });
  assert.deepEqual(effects.state, { enabled: false, effect: 1 });
  await r.run({ kind: 'restore' });
  assert.deepEqual(effects.state, STATIC_ON);
  assert.deepEqual(effects.sets.at(-1), STATIC_ON);
  const count = effects.sets.length;
  lines.length = 0;
  await r.run({ kind: 'restore' });
  assert.equal(effects.sets.length, count);
  assert.ok(lines.some((l) => l.includes('nothing to restore')));
});

test('restore after the user changed the effect (Ambiglow page, profile): the user\'s choice is kept, the restore point dropped', async () => {
  const effects = new FakeEffects(STATIC_ON);
  const { r } = remote(effects);
  await r.run({ kind: 'set', target: { effect: 1, enabled: true } });
  effects.state = { enabled: true, effect: 3 };
  lines.length = 0;
  await r.run({ kind: 'restore' });
  assert.deepEqual(effects.state, { enabled: true, effect: 3 });
  assert.equal(effects.sets.length, 1);
  assert.ok(lines.some((l) => l.includes('changed since, kept')));
  // A set after a user change takes that change as its restore point.
  await r.run({ kind: 'set', target: { effect: 1, enabled: true } });
  effects.state!.effect = 1;
  await r.run({ kind: 'restore' });
  assert.deepEqual(effects.state, { enabled: true, effect: 3 });
});

test('commands run in arrival order, a failing one does not stop the next (logged, never rejected)', async () => {
  const effects = new FakeEffects(STATIC_ON);
  const { r } = remote(effects);
  const order: string[] = [];
  const set = effects.setRemoteEffect.bind(effects);
  effects.setRemoteEffect = async (t) => {
    order.push(JSON.stringify(t));
    if (t.effect === 2) throw new Error('ENE busy');
    return set(t);
  };
  lines.length = 0;
  await Promise.all([
    r.run({ kind: 'set', target: { effect: 2, enabled: true } }),
    r.run({ kind: 'set', target: { effect: 1, enabled: true } }),
    r.run({ kind: 'restore' }),
  ]);
  assert.deepEqual(order, ['{"effect":2,"enabled":true}', '{"effect":1,"enabled":true}', JSON.stringify(STATIC_ON)]);
  assert.deepEqual(effects.state, STATIC_ON);
  assert.ok(lines.some((l) => l.startsWith('error --ambiglow: ENE busy')));
});

test('a command waits for the backend and a display with an ENE; without one it gives up after AMBIGLOW_READY_TIMEOUT_MS', async () => {
  const effects = new FakeEffects(null);
  let starts = 0;
  const { r, elapsed } = remote(effects, { started: () => (++starts < 3 ? -1 : 10010) });
  const loaded = new FakeEffects(null);
  // The display appears after a few polls.
  let polls = 0;
  loaded.remoteEffect = async () => (++polls > 4 ? { ...STATIC_ON } : null);
  const late = remote(loaded);
  await late.r.run({ kind: 'set', target: { effect: 1, enabled: true } });
  assert.deepEqual(loaded.sets, [{ effect: 1, enabled: true }]);

  lines.length = 0;
  await r.run({ kind: 'set', target: { effect: 1, enabled: true } });
  assert.ok(starts >= 3, 'the backend start is retried');
  assert.equal(effects.sets.length, 0);
  assert.ok(elapsed() >= AMBIGLOW_READY_TIMEOUT_MS);
  assert.ok(lines.some((l) => l.includes('no display with an Ambiglow controller (ENE) after 30 s')));
});
