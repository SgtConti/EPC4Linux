// api/effect.ts + api/sync-effect.ts against the Bridge catalog (every ambiglow-owned overload exactly once,
// with the C# signature), and the fallback engine of a composition without the ambiglow service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAudit, overloadsOwnedBy } from '../../../src/backend/api/catalog.ts';
import { effectApi } from '../../../src/backend/api/effect.ts';
import { syncEffectApi } from '../../../src/backend/api/sync-effect.ts';
import { RpcDispatcher } from '../../../src/backend/rpc/dispatcher.ts';
import { AmbiglowServiceImpl, ambiglowEngineFor } from '../../../src/backend/ambiglow/service.ts';
import type { AmbiglowService } from '../../../src/backend/services.ts';
import { recordRegistrations, testServices } from '../api/helpers.ts';
import { silentLog } from './helpers.ts';

test('the two modules register the 20 ambiglow overloads of Bridge.cs exactly, and nothing else', () => {
  const { registry, errors } = recordRegistrations([effectApi, syncEffectApi]);
  assert.deepEqual(errors, []);
  const audit = registry.audit({ owners: ['ambiglow'] });
  assert.equal(formatAudit(audit), '');
  assert.equal(registry.registrations.length, overloadsOwnedBy('ambiglow').length);
  assert.equal(registry.registrations.length, 20);
});

test('without an ambiglow service the modules still answer (DDC-only fallback engine, no display → null obj)', async () => {
  const { services } = testServices({});
  const dispatcher = new RpcDispatcher(silentLog);
  effectApi(dispatcher, services);
  syncEffectApi(dispatcher, services);
  const call = async (functionName: string, parms: unknown[] | null = null) =>
    JSON.parse(await dispatcher.dispatch(JSON.stringify({ functionName, requestId: 'x', parms }))) as { err_code: number; err_msg: string; Tag: unknown };
  assert.equal((await call('Effect_GetMenu', [100000])).err_msg, 'functionName: Effect_GetMenu  return null obj');
  assert.equal((await call('Effect_CheckDynamicLightingEnabled')).Tag, -1);
  const sync = await call('SyncEffect_GetData');
  assert.equal(sync.err_code, 0);
  assert.deepEqual((sync.Tag as { SyncDevices: unknown[] }).SyncDevices, []);
  assert.equal(ambiglowEngineFor(services), ambiglowEngineFor(services), 'one fallback engine per composition');
});

test('ambiglowEngineFor: the real service, a full delegate, or — for a partial stand-in — the detached engine plus one error', () => {
  // A delegate that forwards the whole Bridge-facing surface is used as is.
  const { services: plain } = testServices({});
  const real = ambiglowEngineFor(plain) as AmbiglowServiceImpl;
  const delegate = Object.fromEntries(
    ['attach', 'driverFor', 'getMenu', 'getLeds', 'effectEnable', 'effectChange', 'effectRandomEnable', 'effectRainbowEnable', 'effectColorChange',
      'effectBgColorChange', 'effectSpeedChange', 'effectBrightnessChange', 'effectDirectionChange', 'effectRegionChange', 'effectReset',
      'getColorData', 'setSelfColors', 'syncEffectGetData', 'syncEffectEnableDevice'].map((m) => [m, (...args: unknown[]) => (real as any)[m](...args)]),
  ) as unknown as AmbiglowService;
  const { services: wrapped, lines: quiet } = testServices({ ambiglow: delegate });
  assert.equal(ambiglowEngineFor(wrapped), delegate);
  assert.deepEqual(quiet.filter((l) => l.level === 'error'), []);

  // A stand-in that only forwards attach() would leave every Effect_* on a USB-less engine: logged once.
  const standIn: AmbiglowService = { attach: async () => undefined };
  const { services, lines } = testServices({ ambiglow: standIn });
  const engine = ambiglowEngineFor(services);
  assert.ok(engine instanceof AmbiglowServiceImpl);
  assert.equal(ambiglowEngineFor(services), engine);
  const errors = lines.filter((l) => l.level === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].text, /does not implement the Effect_\* engine/);
});
