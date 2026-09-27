import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../../../src/backend/index.ts';
import { BRIDGE_OVERLOADS, RecordingRegistry, overloadKey, overloadsOwnedBy, type BridgeOverload } from '../../../src/backend/api/catalog.ts';
import { DISPLAY_DEVICE_TYPE, STUB_REPLIES, StubTexts, fancyZonesVersionNotInstalled, stubsApi } from '../../../src/backend/api/stubs.ts';
import type { MonitorManager } from '../../../src/backend/services.ts';
import type { Backend, RpcArg } from '../../../src/backend/types.ts';
import { captureLogger } from '../rpc/helpers.ts';
import { testHost, testServices } from './helpers.ts';

function backendWith(slots: { monitors?: MonitorManager } = {}): Backend {
  const { log } = captureLogger('backend');
  return createBackend({ host: testHost(log), noHardware: true }, { services: () => slots, modules: [stubsApi] });
}

/**
 * A monitor manager with `displayCount` discovered displays, of which `connectedCount` passed
 * ConnectionCkecked (connectList() lists the display driver then, MonitorManagerImpl.connectList()).
 */
function monitorsWith(displayCount: number, connectedCount = displayCount): MonitorManager {
  return {
    displays: () => Array.from({ length: displayCount }, () => ({})),
    connectList: () => (connectedCount > 0 ? [{ DeviceType: DISPLAY_DEVICE_TYPE }] : []),
  } as unknown as MonitorManager;
}

/** Plausible renderer arguments for an overload: the display device type for `device`, else zero values. */
function sampleArgs(b: BridgeOverload): RpcArg[] {
  return b.signature.map((t, i) => (t === 'int' ? (b.params[i] === 'device' ? DISPLAY_DEVICE_TYPE : 0) : t === 'string' ? '' : false));
}

async function call(backend: Backend, name: string, parms: RpcArg[] | null, requestId = 'stub-test'): Promise<Record<string, unknown>> {
  return JSON.parse(await backend.handleRequest(JSON.stringify({ functionName: name, requestId, parms })));
}

test('stubs.ts registers every overload owned by stubs, exactly once, with the Bridge signature', () => {
  const { services } = testServices();
  const registry = new RecordingRegistry();
  stubsApi(registry, services);
  const audit = registry.audit({ owners: ['stubs'] });
  assert.equal(audit.ok, true, JSON.stringify(audit));
  assert.equal(registry.registrations.length, 55);
  assert.deepEqual(
    [...STUB_REPLIES.keys()].sort(),
    overloadsOwnedBy('stubs').map((b) => b.name).sort(),
    'one reply per stub name, no dead entries',
  );
});

test('every stub answers with the vendor no-device reply', async () => {
  const backend = backendWith();
  const expected = (b: BridgeOverload): { err_code: number; err_msg: string; Tag: unknown } => {
    const r = STUB_REPLIES.get(b.name)!;
    switch (r.kind) {
      case 'succ':
        return { err_code: 0, err_msg: '', Tag: r.tag() };
      case 'error':
        return { err_code: 9, err_msg: r.msg, Tag: null };
      case 'null':
        return { err_code: 9, err_msg: `functionName: ${b.name}  return null obj`, Tag: null };
      case 'pairing':
        return { err_code: 9, err_msg: StubTexts.noDriver, Tag: null };
    }
  };
  for (const b of overloadsOwnedBy('stubs')) {
    const reply = await call(backend, b.name, b.signature.length ? sampleArgs(b) : null, `id-${b.index}`);
    const e = expected(b);
    assert.deepEqual(
      reply,
      { err_code: e.err_code, IsSucc: e.err_code === 0, err_msg: e.err_msg, RequestId: `id-${b.index}`, Tag: e.Tag, FunctionName: b.name, CurrItem: null },
      overloadKey(b.name, b.signature),
    );
    assert.equal(e.err_code === 0 ? 'S' : 'E', b.disposition, `${b.name}: catalog disposition`);
  }
});

test('the dispositions are the vendor texts of 20-backend-host-tail §3', () => {
  const texts: Record<string, string> = {};
  for (const [name, r] of STUB_REPLIES) texts[name] = r.kind === 'error' ? r.msg : r.kind;
  assert.equal(texts.Button_SetKeyboard, 'No driver found!');
  assert.equal(texts.DTS_SetGeqBandGain, 'No driver found!');
  assert.equal(texts.Keyboard_SetGameMode, 'No driver found!');
  assert.equal(texts.Mouse_BindSmartDPIToButton, 'No driver found!', 'the one Mouse_* method with an explicit null check');
  assert.equal(texts.Mouse_ChangeDPI, 'null');
  assert.equal(texts.DeviceSteup_LightEnable, 'null');
  assert.equal(texts.FancyZones_SetSetting, 'not supported');
  assert.equal(texts.CanEnterPairing, 'pairing');
});

test('GetPairDevices replies the golden step 15 bytes', async () => {
  const backend = backendWith();
  assert.equal(
    await backend.handleRequest('{"functionName":"GetPairDevices","requestId":"a475cf3f-a975-48fd-8adc-26ae004d4ae3","parms":null}'),
    '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"a475cf3f-a975-48fd-8adc-26ae004d4ae3","Tag":[],"FunctionName":"GetPairDevices","CurrItem":null}',
  );
});

test('FancyZones_GetVersion replies the vendor "not installed" object (request from the 2026-09-26 log)', async () => {
  const backend = backendWith();
  assert.equal(
    await backend.handleRequest('{"functionName":"FancyZones_GetVersion","requestId":"c553b299-76f6-49ab-8bf4-66881f27154f","parms":null}'),
    '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"c553b299-76f6-49ab-8bf4-66881f27154f","Tag":{"StrVersion":"V0.0.0.0","Version":0,"DP_DeviceType":"SmartDesktop","DP_ComponentID":"Philips_SmartDesktop"},"FunctionName":"FancyZones_GetVersion","CurrItem":null}',
  );
  const a = fancyZonesVersionNotInstalled();
  a.Version = 99;
  assert.equal(fancyZonesVersionNotInstalled().Version, 0, 'each reply is a fresh object');
});

test('GetWifiList is an empty list, never host data', async () => {
  const backend = backendWith();
  const r = await call(backend, 'GetWifiList', null);
  assert.equal(r.err_code, 0);
  assert.deepEqual(r.Tag, []);
});

test('the null-returning vendor paths keep Class0 text with two spaces', async () => {
  const backend = backendWith();
  const r = await call(backend, 'DeviceSteup_GetPowerInfo', [DISPLAY_DEVICE_TYPE]);
  assert.equal(r.err_msg, 'functionName: DeviceSteup_GetPowerInfo  return null obj');
  const m = await call(backend, 'Mouse_ChangeLod', [1, '400']);
  assert.equal(m.err_msg, 'functionName: Mouse_ChangeLod  return null obj');
});

test('pairing calls reach the display driver only when the display is connected and addressed', async () => {
  for (const name of ['CanEnterPairing', 'EnterPairing']) {
    const none = backendWith();
    assert.equal((await call(none, name, [DISPLAY_DEVICE_TYPE, 'hid']))?.err_msg, 'No driver found!', `${name}: no monitor service`);
    const empty = backendWith({ monitors: monitorsWith(0) });
    assert.equal((await call(empty, name, [DISPLAY_DEVICE_TYPE, 'hid']))?.err_msg, 'No driver found!', `${name}: no display`);
    const one = backendWith({ monitors: monitorsWith(1) });
    assert.equal((await call(one, name, [DISPLAY_DEVICE_TYPE, 'hid']))?.err_msg, 'operation is not implemented', `${name}: display driver`);
    assert.equal((await call(one, name, [100001, 'hid']))?.err_msg, 'No driver found!', `${name}: another device type`);
    // Discovered but not connected (or not supported): ConnectionCkecked failed, so the vendor removed the
    // driver from its dictionary (SystemOper.cs:846-870) and answers "No driver found!".
    const disconnected = backendWith({ monitors: monitorsWith(1, 0) });
    assert.equal((await call(disconnected, name, [DISPLAY_DEVICE_TYPE, 'hid']))?.err_msg, 'No driver found!', `${name}: discovered, not connected`);
  }
  const broken = backendWith({
    monitors: {
      displays: () => [{}],
      connectList: () => {
        throw new Error('boom');
      },
    } as unknown as MonitorManager,
  });
  assert.equal((await call(broken, 'CanEnterPairing', [DISPLAY_DEVICE_TYPE, '']))?.err_msg, 'No driver found!');
});

test('wrong argument types get the vendor overload error naming the exact Bridge signature', async () => {
  const backend = backendWith();
  const r = await call(backend, 'DTS_SetAPO', [DISPLAY_DEVICE_TYPE, 1]);
  assert.equal(r.err_msg, 'params error: Zeasn.Com.Lib.JsonResult DTS_SetAPO(Int32, Boolean)');
  const b = await call(backend, 'Button_SetFunc', [1]);
  assert.equal(b.err_msg, 'params error: Zeasn.Com.Lib.JsonResult Button_SetFunc(Int32, Int32, Int32, Int32, Int32, System.String, System.String)');
  assert.equal(BRIDGE_OVERLOADS.filter((x) => x.owner === 'stubs' && x.signature.length === 0).length, 5);
});
