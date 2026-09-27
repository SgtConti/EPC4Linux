import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  API_OWNERS,
  BRIDGE_OVERLOADS,
  BRIDGE_OVERLOAD_COUNT,
  RecordingRegistry,
  auditBackend,
  auditDispatcher,
  auditRegistrations,
  dispatcherRegistrations,
  findOverload,
  formatAudit,
  overloadKey,
  overloadsNamed,
  overloadsOwnedBy,
  ownerOf,
  parseNetSignature,
  type ApiOwner,
} from '../../../src/backend/api/catalog.ts';
import { RpcDispatcher, netSignature } from '../../../src/backend/rpc/dispatcher.ts';
import { succ } from '../../../src/backend/core/envelope.ts';
import { createBackend } from '../../../src/backend/index.ts';
import type { RpcArgType } from '../../../src/backend/types.ts';
import { captureLogger } from '../rpc/helpers.ts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const BRIDGE_CS = `${REPO}work/dotnet-clean/Bridge.Lib/Bridge.Lib/Bridge.cs`;
const HOST_TAIL = `${REPO}docs/re/20-backend-host-tail.md`;

function tally<K extends string>(keys: K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

test('the catalog holds the 162 Bridge overloads in declaration order', () => {
  assert.equal(BRIDGE_OVERLOADS.length, BRIDGE_OVERLOAD_COUNT);
  assert.equal(BRIDGE_OVERLOAD_COUNT, 162);
  BRIDGE_OVERLOADS.forEach((b, i) => {
    assert.equal(b.index, i + 1);
    if (i > 0) assert.ok(b.line > BRIDGE_OVERLOADS[i - 1].line, `${b.name}: lines ascend`);
    assert.equal(b.params.length, b.signature.length, b.name);
    for (const t of b.signature) assert.ok(t === 'int' || t === 'string' || t === 'bool', `${b.name}: ${t}`);
    assert.ok(Object.isFrozen(b) && Object.isFrozen(b.signature), 'entries are frozen');
  });
  assert.ok(Object.isFrozen(BRIDGE_OVERLOADS));
  const keys = new Set(BRIDGE_OVERLOADS.map((b) => overloadKey(b.name, b.signature)));
  assert.equal(keys.size, 162, 'name + signature is unique');
  assert.equal(new Set(BRIDGE_OVERLOADS.map((b) => b.name)).size, 157, '157 names, 5 of them overloaded');
  assert.equal(Math.max(...BRIDGE_OVERLOADS.map((b) => b.signature.length)), 8, 'the widest overloads take 8 arguments');
  assert.deepEqual(overloadsNamed('Theme_GetDevicesBasicInfo').map((b) => b.signature), [['int'], ['string', 'string', 'int'], ['string', 'int']]);
  assert.deepEqual(overloadsNamed('PHL_SetOSD').map((b) => b.signature), [['string'], ['string', 'int']]);
  assert.deepEqual(overloadsNamed('Macro_GetDetail').map((b) => b.signature), [['string', 'string'], ['string']]);
  assert.deepEqual(overloadsNamed('Theme_GetProfileDesc').map((b) => b.signature), [['string'], ['string', 'string']]);
  assert.deepEqual(overloadsNamed('A_Notification'), [], 'the void A_Notification method is not an RPC overload');
});

test('owners follow the module split; dispositions and renderer use follow 20-backend-host-tail §3', () => {
  assert.deepEqual(tally(BRIDGE_OVERLOADS.map((b) => b.owner)), { system: 1, theme: 40, stubs: 55, ambiglow: 20, monitor: 46 });
  // §3 counts 54 I / 23 S / 85 E; GetWifiList moves from E to S (empty list, never host data).
  assert.deepEqual(tally(BRIDGE_OVERLOADS.map((b) => b.disposition)), { I: 54, S: 24, E: 84 });
  assert.equal(findOverload('GetWifiList', [])?.disposition, 'S');
  // §3: 140 overloads are called by some renderer chunk (72 of them only from hidden pages), 22 never.
  assert.deepEqual(tally(BRIDGE_OVERLOADS.map((b) => b.renderer)), { yes: 68, hidden: 72, no: 22 });
  const rule = (name: string): ApiOwner => {
    if (name === 'Start') return 'system';
    if (/^(PHL_|Device_|Profile_|DisplayFW_)/.test(name) || name === 'SetGamePQ') return 'monitor';
    if (/^(Theme_|Macro_|Setting_)/.test(name) || name === 'FactoryReset' || name === 'Comm_GenAppIcon') return 'theme';
    if (/^(Effect_|SyncEffect_)/.test(name) || name === 'AmbiScape_EnableFollowVideo') return 'ambiglow';
    return 'stubs';
  };
  for (const b of BRIDGE_OVERLOADS) assert.equal(b.owner, rule(b.name), b.name);
  assert.equal(ownerOf('DeviceSteup_GetPowerInfo'), 'stubs', 'DeviceSteup_ is not Device_');
  assert.equal(ownerOf('GetHotKeyState'), 'stubs', 'GetHotKeyState is not PHL_');
  assert.equal(ownerOf('Nope'), null);
  assert.deepEqual(API_OWNERS, ['system', 'monitor', 'theme', 'ambiglow', 'stubs']);
  assert.equal(overloadsOwnedBy('system', 'stubs').length, 56);
});

test('the catalog matches Bridge.cs (names, parameter types and names, lines)', { skip: !existsSync(BRIDGE_CS) && 'work/dotnet-clean is not present' }, () => {
  const lines = readFileSync(BRIDGE_CS, 'utf8').split('\n');
  const parsed: { name: string; signature: RpcArgType[]; params: string[]; line: number }[] = [];
  let voidMethods = 0;
  lines.forEach((l, i) => {
    if (/public static void /.test(l)) voidMethods++;
    const m = /public static JsonResult (\w+)\((.*)\)/.exec(l);
    if (!m) return;
    const ps = m[2].trim() === '' ? [] : m[2].split(',').map((p) => /^\s*(int|string|bool) (\w+)/.exec(p));
    assert.ok(ps.every((p) => p !== null), `unexpected parameter type in ${l.trim()}`);
    parsed.push({
      name: m[1],
      signature: ps.map((p) => p![1] as RpcArgType),
      params: ps.map((p) => p![2]),
      line: i + 1,
    });
  });
  assert.equal(voidMethods, 1, 'only A_Notification is void');
  assert.deepEqual(
    BRIDGE_OVERLOADS.map((b) => ({ name: b.name, signature: [...b.signature], params: [...b.params], line: b.line })),
    parsed,
  );
});

test('the catalog matches the §3 table of 20-backend-host-tail', { skip: !existsSync(HOST_TAIL) && 'docs/re is not present' }, () => {
  const rows = [...readFileSync(HOST_TAIL, 'utf8').matchAll(/^\| (\d+) \| `(\w+)\(.*?\)` :(\d+) \| .*? \| (.*?) \| (I|S|E) \| .* \|$/gm)];
  assert.equal(rows.length, 162);
  for (const [, index, name, line, called, disp] of rows) {
    const b = BRIDGE_OVERLOADS[Number(index) - 1];
    assert.equal(b.name, name);
    assert.equal(b.line, Number(line));
    assert.equal(b.disposition, name === 'GetWifiList' ? 'S' : disp, name);
    assert.equal(b.renderer, called.startsWith('Y (hidden') ? 'hidden' : called.startsWith('Y') ? 'yes' : 'no', name);
  }
});

test('parseNetSignature inverts the dispatcher netSignature for every overload', () => {
  for (const b of BRIDGE_OVERLOADS) {
    assert.deepEqual(parseNetSignature(netSignature(b.name, b.signature)), { name: b.name, signature: [...b.signature] });
  }
  assert.equal(parseNetSignature('System.Void A_Notification(Zeasn.PCenter.Entity.Lib.Notification)'), null);
  assert.equal(parseNetSignature('Zeasn.Com.Lib.JsonResult X(Double)'), null);
});

test('auditRegistrations reports missing, extra, duplicate and out-of-scope registrations', () => {
  const all = BRIDGE_OVERLOADS.map((b) => ({ name: b.name, signature: b.signature }));
  const full = auditRegistrations(all);
  assert.equal(full.ok, true);
  assert.equal(formatAudit(full), '');

  const regs = all.filter((r) => r.name !== 'PHL_SetOSD' && r.name !== 'GetPairDevices');
  regs.push({ name: 'PHL_SetOSD', signature: ['string', 'int'] });
  regs.push({ name: 'PHL_SetOSD', signature: ['int'] }); // wrong signature
  regs.push({ name: 'Theme_EnableSmartImage', signature: [] }); // renderer wrapper without a Bridge method (20 §1.3)
  regs.push({ name: 'Start', signature: [] }); // twice
  const a = auditRegistrations(regs);
  assert.equal(a.ok, false);
  assert.deepEqual(a.missing.map((b) => overloadKey(b.name, b.signature)), ['GetPairDevices()', 'PHL_SetOSD(string)']);
  assert.deepEqual(a.extra, [{ name: 'PHL_SetOSD', signature: ['int'] }, { name: 'Theme_EnableSmartImage', signature: [] }]);
  assert.deepEqual(a.duplicates.map((d) => [overloadKey(d.overload.name, d.overload.signature), d.count]), [['Start()', 2]]);
  assert.deepEqual(a.outOfScope, []);
  const text = formatAudit(a);
  assert.match(text, /#40 PHL_SetOSD\(string\) \[monitor\] Bridge\.cs:214/);
  assert.match(text, /PHL_SetOSD\(int\) — Bridge declares PHL_SetOSD\(string\) \| PHL_SetOSD\(string,int\)/);
  assert.match(text, /Theme_EnableSmartImage\(\) — unknown function name/);
  assert.match(text, /Start\(\) ×2/);

  const scoped = auditRegistrations([{ name: 'Start', signature: [] }, { name: 'GetPairDevices', signature: [] }], { owners: ['system'] });
  assert.deepEqual(scoped.missing, []);
  assert.deepEqual(scoped.outOfScope.map((b) => b.name), ['GetPairDevices']);
  assert.equal(scoped.ok, false);
  assert.equal(auditRegistrations([{ name: 'Start', signature: [] }], { owners: ['system'] }).ok, true);
});

test('RecordingRegistry records every registration, keeps duplicates and forwards to an inner registry', async () => {
  const { log } = captureLogger();
  const dispatcher = new RpcDispatcher(log);
  const rec = new RecordingRegistry(dispatcher);
  const handler = () => succ(true);
  rec.register('Start', [], handler);
  rec.register('Profile_GetDeviceData', ['int'], () => succ(null), 'uiProfileGet');
  assert.equal(rec.has('Start'), true);
  assert.equal(dispatcher.has('Start'), true, 'forwarded');
  assert.equal(rec.handler('Start', []), handler);
  assert.equal(rec.handler('Start', ['int']), undefined);
  assert.equal(rec.registrations[1].serialize, 'uiProfileGet');
  assert.throws(() => rec.register('Start', [], handler), /already registered/, 'the inner dispatcher still rejects duplicates');
  assert.equal(rec.registrations.length, 3, 'but the duplicate is recorded for the audit');
  assert.deepEqual(rec.audit({ owners: ['system'] }).duplicates.map((d) => d.overload.name), ['Start']);

  const standalone = new RecordingRegistry();
  standalone.register('X', ['bool'], handler);
  standalone.register('X', ['bool'], handler);
  assert.equal(standalone.registrations.length, 2);
  assert.equal(standalone.has('Y'), false);
});

test('auditDispatcher reads a live RpcDispatcher without running any handler', async () => {
  const { log } = captureLogger();
  const dispatcher = new RpcDispatcher(log);
  let calls = 0;
  const handler = () => {
    calls++;
    return succ(true);
  };
  dispatcher.register('Start', [], handler);
  dispatcher.register('PHL_SetOSD', ['string'], handler);
  dispatcher.register('PHL_SetOSD', ['string', 'int'], handler);
  dispatcher.register('Theme_GetDevicesBasicInfo', ['int'], handler);
  dispatcher.register('Theme_GetDevicesBasicInfo', ['string', 'int'], handler); // one of three
  dispatcher.register('GetWifiList', ['bool'], handler); // wrong signature
  dispatcher.register('Test_Extra', [], handler);

  assert.deepEqual(await dispatcherRegistrations(dispatcher), [
    { name: 'Start', signature: [] },
    { name: 'PHL_SetOSD', signature: ['string'] },
    { name: 'PHL_SetOSD', signature: ['string', 'int'] },
    { name: 'Theme_GetDevicesBasicInfo', signature: ['int'] },
    { name: 'Theme_GetDevicesBasicInfo', signature: ['string', 'int'] },
    { name: 'GetWifiList', signature: ['bool'] },
    { name: 'Test_Extra', signature: [] },
  ]);
  assert.equal(calls, 0, 'probing never invokes a handler');

  const a = await auditDispatcher(dispatcher, { owners: ['system', 'stubs'] });
  assert.deepEqual(a.extra, [{ name: 'GetWifiList', signature: ['bool'] }, { name: 'Test_Extra', signature: [] }]);
  assert.equal(a.missing.length, 55, 'every stub is missing (GetWifiList has the wrong signature)');
  assert.deepEqual(a.outOfScope.map((b) => overloadKey(b.name, b.signature)), [
    'PHL_SetOSD(string)',
    'PHL_SetOSD(string,int)',
    'Theme_GetDevicesBasicInfo(int)',
    'Theme_GetDevicesBasicInfo(string,int)',
  ]);
  const whole = await auditDispatcher(dispatcher);
  assert.ok(whole.missing.some((b) => overloadKey(b.name, b.signature) === 'Theme_GetDevicesBasicInfo(string,string,int)'));
  assert.equal(calls, 0);
});

test('auditBackend reads a composed backend through handleRequest only, without running any handler', async () => {
  const { log } = captureLogger();
  let calls = 0;
  const handler = () => {
    calls++;
    return succ(true);
  };
  const backend = createBackend(
    { host: { log, serveDataDir: '/nonexistent', appDataDir: '/nonexistent', resourcesDir: '/nonexistent' }, noHardware: true },
    {
      modules: [
        (registry) => {
          registry.register('Start', [], handler);
          registry.register('PHL_SetOSD', ['string', 'int'], handler);
          registry.register('GetWifiList', ['bool'], handler); // wrong signature
          registry.register('Test_Extra', [], handler); // outside the catalog: invisible through handleRequest
        },
      ],
    },
  );
  const a = await auditBackend(backend);
  assert.equal(calls, 0, 'probing never invokes a handler');
  assert.deepEqual(a.extra, [{ name: 'GetWifiList', signature: ['bool'] }]);
  assert.equal(a.missing.length, 162 - 2, 'every name without overloads ("functionName: X undefined") is missing');
  assert.equal(a.ok, false);
  assert.ok(!a.missing.some((b) => overloadKey(b.name, b.signature) === 'PHL_SetOSD(string,int)'));
  assert.ok(a.missing.some((b) => overloadKey(b.name, b.signature) === 'PHL_SetOSD(string)'));
});
