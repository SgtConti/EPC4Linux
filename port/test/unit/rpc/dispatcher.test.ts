import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HANDLER_TIMEOUT_MS,
  RpcDispatcher,
  VENDOR_QUIET_FUNCTIONS,
  handlerTimeoutMessage,
  netSignature,
} from '../../../src/backend/rpc/dispatcher.ts';
import { error, succ } from '../../../src/backend/core/envelope.ts';
import { toCSharpJson } from '../../../src/backend/core/json.ts';
import type { JsonResult, RpcArg, RpcArgType, RpcCallContext, SerializeMode } from '../../../src/backend/types.ts';
import { captureLogger, vendorRequests } from './helpers.ts';

interface Call {
  fn: string;
  args: RpcArg[];
}

/** A dispatcher with Bridge's real overload sets (Bridge.cs:214-222, 554-562, 799-812) and a call recorder. */
function setup() {
  const { log, lines } = captureLogger();
  const d = new RpcDispatcher(log);
  const calls: Call[] = [];
  const reg = (name: string, sig: RpcArgType[], mode?: SerializeMode) => {
    const id = `${name}(${sig.join(',')})`;
    d.register(name, sig, (args) => {
      calls.push({ fn: id, args });
      return succ(args);
    }, mode);
  };
  reg('Start', []);
  reg('PHL_SetOSD', ['string']);
  reg('PHL_SetOSD', ['string', 'int']);
  reg('Theme_GetDevicesBasicInfo', ['int']);
  reg('Theme_GetDevicesBasicInfo', ['string', 'string', 'int']);
  reg('Theme_GetDevicesBasicInfo', ['string', 'int']);
  reg('Macro_GetDetail', ['string', 'string']);
  reg('Macro_GetDetail', ['string']);
  reg('Effect_Enable', ['int', 'bool']);
  reg('Effect_GetLEDs', ['int']);
  return { d, lines, calls };
}

async function call(d: RpcDispatcher, request: object | string): Promise<JsonResult> {
  return JSON.parse(await d.dispatch(typeof request === 'string' ? request : JSON.stringify(request))) as JsonResult;
}

function assertError(r: JsonResult, msg: string, requestId: string | null, functionName: string | null): void {
  assert.deepEqual(r, { err_code: 9, IsSucc: false, err_msg: msg, RequestId: requestId, Tag: null, FunctionName: functionName, CurrItem: null });
}

test('success reply: exact envelope bytes, RequestId and FunctionName echoed', async () => {
  const { d } = setup();
  const s = await d.dispatch('{"functionName":"Start","requestId":"683a49b0","parms":null}');
  assert.equal(s, '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"683a49b0","Tag":[],"FunctionName":"Start","CurrItem":null}');
});

test('overloads are chosen by the exact type signature of parms', async () => {
  const { d, calls } = setup();
  const cases: [unknown[] | null, string, RpcArg[]][] = [
    [['EXT_OP_E2A0_43_AutoWarning'], 'PHL_SetOSD(string)', ['EXT_OP_E2A0_43_AutoWarning']],
    [['EXT_OP_E2A0_43_AutoWarning', 1], 'PHL_SetOSD(string,int)', ['EXT_OP_E2A0_43_AutoWarning', 1]],
  ];
  for (const [parms, fn, args] of cases) {
    const r = await call(d, { functionName: 'PHL_SetOSD', requestId: 'r', parms });
    assert.equal(r.err_code, 0);
    assert.deepEqual(calls.at(-1), { fn, args });
  }
  await call(d, { functionName: 'Theme_GetDevicesBasicInfo', requestId: 'r', parms: [-1] });
  await call(d, { functionName: 'Theme_GetDevicesBasicInfo', requestId: 'r', parms: ['User', 'Default', -1] });
  await call(d, { functionName: 'Theme_GetDevicesBasicInfo', requestId: 'r', parms: ['/p/x.pcenter', 100000] });
  await call(d, { functionName: 'Macro_GetDetail', requestId: 'r', parms: ['User', 'm1'] });
  await call(d, { functionName: 'Macro_GetDetail', requestId: 'r', parms: ['/p/m1.macro'] });
  await call(d, { functionName: 'Effect_Enable', requestId: 'r', parms: [100000, false] });
  assert.deepEqual(calls.slice(2).map((c) => c.fn), [
    'Theme_GetDevicesBasicInfo(int)',
    'Theme_GetDevicesBasicInfo(string,string,int)',
    'Theme_GetDevicesBasicInfo(string,int)',
    'Macro_GetDetail(string,string)',
    'Macro_GetDetail(string)',
    'Effect_Enable(int,bool)',
  ]);
  assert.deepEqual(calls.at(-1)!.args, [100000, false]);
  // parms [] selects the parameterless overload like parms null
  assert.equal((await call(d, { functionName: 'Start', requestId: 'r', parms: [] })).err_code, 0);
});

test('no matching overload → "params error" listing .NET MethodInfo signatures', async () => {
  const { d } = setup();
  assertError(
    await call(d, { functionName: 'PHL_SetOSD', requestId: 'r', parms: [1] }),
    'params error: Zeasn.Com.Lib.JsonResult PHL_SetOSD(System.String) | Zeasn.Com.Lib.JsonResult PHL_SetOSD(System.String, Int32)',
    'r', 'PHL_SetOSD',
  );
  assertError(await call(d, { functionName: 'Start', requestId: 'r', parms: [true] }), 'params error: Zeasn.Com.Lib.JsonResult Start()', 'r', 'Start');
  assertError(await call(d, { functionName: 'Effect_Enable', requestId: 'r', parms: [1, 'true'] }), 'params error: Zeasn.Com.Lib.JsonResult Effect_Enable(Int32, Boolean)', 'r', 'Effect_Enable');
  assert.equal(netSignature('Theme_GetDevicesBasicInfo', ['string', 'string', 'int']), 'Zeasn.Com.Lib.JsonResult Theme_GetDevicesBasicInfo(System.String, System.String, Int32)');
});

test('unknown function → "functionName: X undefined" (names are case-sensitive)', async () => {
  const { d } = setup();
  assertError(await call(d, { functionName: 'Nope', requestId: 'r2', parms: null }), 'functionName: Nope undefined', 'r2', 'Nope');
  assertError(await call(d, { functionName: 'start', requestId: 'r3' }), 'functionName: start undefined', 'r3', 'start');
});

test('unsupported parameter types are reported before the name lookup', async () => {
  const { d, lines, calls } = setup();
  const cases: [string, string][] = [['1.5', 'Float'], ['1e2', 'Float'], ['null', 'Null'], ['{}', 'Object'], ['[1]', 'Array']];
  for (const [tok, type] of cases) {
    assertError(await call(d, `{"functionName":"PHL_SetOSD","requestId":"r","parms":["x",${tok}]}`), `Unsupported parameter type: ${type}`, 'r', 'PHL_SetOSD');
  }
  assertError(await call(d, '{"functionName":"Nope","requestId":"r","parms":[1,null,2.5]}'), 'Unsupported parameter type: Null', 'r', 'Nope');
  assert.equal(calls.length, 0);
  assert.ok(lines.some((l) => l.level === 'error' && l.text === 'Unsupported parameter type: Float'));
});

test('functionName: null/missing hits the NullReferenceException, blank gives "functionName is null"', async () => {
  const { d } = setup();
  const nre = 'Object reference not set to an instance of an object.';
  assertError(await call(d, { requestId: 'r', parms: null }), nre, 'r', null);
  assertError(await call(d, { functionName: null, requestId: 'r' }), nre, 'r', null);
  assertError(await call(d, {}), nre, null, null);
  for (const blank of ['', ' ', '\t\r\n', String.fromCharCode(0x3000, 0xa0, 0x2028, 0x85)]) {
    assertError(await call(d, { functionName: blank, requestId: 'r' }), 'functionName is null', 'r', blank);
  }
  // U+FEFF is not white space for .NET, so it is looked up (and not found)
  const bom = String.fromCharCode(0xfeff);
  assertError(await call(d, { functionName: bom, requestId: 'r' }), `functionName: ${bom} undefined`, 'r', bom);
});

test('unparsable request → the vendor parse error; nothing to echo when the text is not a JSON object', async () => {
  const { d, lines } = setup();
  const s = await d.dispatch('garbage');
  assert.equal(s, '{"err_code":9,"IsSucc":false,"err_msg":"解析json字符串: garbage失败","RequestId":null,"Tag":null,"FunctionName":null,"CurrItem":null}');
  assertError(await call(d, ''), '解析json字符串: 失败', null, null);
  assertError(await call(d, 'null'), '解析json字符串: null失败', null, null);
  assertError(await call(d, '["Start","r"]'), '解析json字符串: ["Start","r"]失败', null, null);
  assertError(await call(d, '{"functionName":"Start","requestId":"r"'), '解析json字符串: {"functionName":"Start","requestId":"r"失败', null, null);
  assert.ok(lines.some((l) => l.level === 'debug' && l.text === 'GetTaskAsync param = garbage'));
});

test('a request that fails to bind still echoes its ids, so the caller settles (port rule, 20 §1.3)', async () => {
  const { d, calls } = setup();
  const cases: [string, string | null, string | null][] = [
    // reviewer's example: `device` is not an integer
    ['{"functionName":"PHL_SetOSD","requestId":"abc","parms":[1],"device":"x"}', 'abc', 'PHL_SetOSD'],
    ['{"functionName":"Start","requestId":"r1","parms":"x"}', 'r1', 'Start'],
    ['{"functionName":"Start","requestId":"r2","device":1.5}', 'r2', 'Start'],
    // same Newtonsoft conversions as a successful bind: case-insensitive names, numbers by spelling, last one wins
    ['{"FUNCTIONNAME":"Start","RequestID":12.50,"parms":{}}', '12.50', 'Start'],
    ['{"functionName":"A","functionName":"B","requestId":true,"parms":1}', 'true', 'B'],
    // unreadable or null ids stay null
    ['{"functionName":{"x":1},"requestId":null,"parms":1}', null, null],
    ['{"functionName":"Start","requestId":["r"],"parms":1}', null, 'Start'],
  ];
  for (const [raw, requestId, functionName] of cases) {
    assertError(await call(d, raw), `解析json字符串: ${raw}失败`, requestId, functionName);
  }
  assert.equal(calls.length, 0);
});

test('integers outside int32 fail with the .NET OverflowException message; bounds pass', async () => {
  const { d, calls } = setup();
  assertError(
    await call(d, '{"functionName":"PHL_SetOSD","requestId":"r","parms":["x",2147483648]}'),
    'Value was either too large or too small for an Int32.', 'r', 'PHL_SetOSD',
  );
  assertError(
    await call(d, '{"functionName":"Effect_GetLEDs","requestId":"r","parms":[-99999999999999999999]}'),
    'Value was either too large or too small for an Int32.', 'r', 'Effect_GetLEDs',
  );
  assert.equal(calls.length, 0);
  await call(d, '{"functionName":"PHL_SetOSD","requestId":"r","parms":["x",2147483647]}');
  await call(d, '{"functionName":"PHL_SetOSD","requestId":"r","parms":["x",-2147483648]}');
  assert.deepEqual(calls.map((c) => c.args[1]), [2147483647, -2147483648]);
});

test('device is prepended after overload selection (vendor quirk, 02 §4.4)', async () => {
  const { d, calls } = setup();
  // parms null: the vendor invokes with no arguments at all, so device is silently ignored
  const r = await call(d, { functionName: 'Start', requestId: 'r', parms: null, device: 5 });
  assert.equal(r.err_code, 0);
  assert.deepEqual(calls.at(-1), { fn: 'Start()', args: [] });
  // any parms array: one argument too many
  assertError(await call(d, { functionName: 'Start', requestId: 'r', parms: [], device: 5 }), 'Parameter count mismatch.', 'r', 'Start');
  assertError(await call(d, { functionName: 'Effect_GetLEDs', requestId: 'r', parms: [100000], device: 100000 }), 'Parameter count mismatch.', 'r', 'Effect_GetLEDs');
  // the int32 conversion runs before the invocation, so overflow wins
  assertError(await call(d, '{"functionName":"Effect_GetLEDs","requestId":"r","parms":[4294967296],"device":1}'), 'Value was either too large or too small for an Int32.', 'r', 'Effect_GetLEDs');
  // device -1 is the "absent" value
  assert.equal((await call(d, { functionName: 'Effect_GetLEDs', requestId: 'r', parms: [1], device: -1 })).err_code, 0);
  assert.equal(calls.length, 2);
});

test('a handler returning null → "functionName: X  return null obj"', async () => {
  const { d } = setup();
  d.register('Nothing', [], () => null as unknown as JsonResult);
  d.register('Undef', [], async () => undefined as unknown as JsonResult);
  assertError(await call(d, { functionName: 'Nothing', requestId: 'r' }), 'functionName: Nothing  return null obj', 'r', 'Nothing');
  assertError(await call(d, { functionName: 'Undef', requestId: 'r' }), 'functionName: Undef  return null obj', 'r', 'Undef');
});

test('handler exceptions become JsonResult.Exception with the ids echoed; dispatch never rejects', async () => {
  const { d, lines } = setup();
  d.register('Boom', [], () => {
    throw new TypeError('bad state');
  });
  d.register('AsyncBoom', ['int'], async () => {
    throw new Error('device gone');
  });
  for (const [fn, parms, text] of [['Boom', null, 'TypeError: bad state'], ['AsyncBoom', [1], 'Error: device gone']] as const) {
    const r = await call(d, { functionName: fn, requestId: 'rx', parms });
    assert.equal(r.err_code, 9);
    assert.equal(r.IsSucc, false);
    assert.ok(r.err_msg!.startsWith(text), r.err_msg!);
    assert.equal(r.RequestId, 'rx');
    assert.equal(r.FunctionName, fn);
    assert.equal(r.Tag, null);
  }
  assert.ok(lines.some((l) => l.level === 'error' && l.scope === 'test/Boom'));
});

test('handler results are copied, never mutated, and handlers get their call context', async () => {
  const { d } = setup();
  const shared = succ('same');
  let seen: RpcCallContext | null = null;
  d.register('Shared', [], (_args, ctx) => {
    seen = ctx;
    return shared;
  });
  const r = await call(d, { functionName: 'Shared', requestId: 'r9' });
  assert.equal(r.RequestId, 'r9');
  assert.equal(shared.RequestId, null);
  assert.equal(shared.FunctionName, null);
  assert.equal(seen!.functionName, 'Shared');
  assert.equal(seen!.requestId, 'r9');
  assert.equal(typeof seen!.log.info, 'function');
  // explicit error results keep their own code and message
  d.register('Denied', [], () => error('MacroBoundNoSupport', 1005001));
  const e = await call(d, { functionName: 'Denied', requestId: 'r' });
  assert.equal(e.err_code, 1005001);
  assert.equal(e.err_msg, 'MacroBoundNoSupport');
});

test('Profile_GetDeviceData is serialized in uiProfileGet mode by default; modes can be set per overload', async () => {
  const { log } = captureLogger();
  const d = new RpcDispatcher(log);
  const entity = { [toCSharpJson]: (mode: SerializeMode) => (mode === 'uiProfileGet' ? { Shown: 1, Nullable: null } : { Shown: 1, UiOnly: 2 }) };
  d.register('Profile_GetDeviceData', ['int'], () => succ(entity));
  d.register('Other', [], () => succ(entity));
  d.register('Custom', [], () => succ(entity), 'uiProfileGet');
  assert.deepEqual((await call(d, { functionName: 'Profile_GetDeviceData', requestId: 'r', parms: [100000] })).Tag, { Shown: 1, Nullable: null });
  assert.deepEqual((await call(d, { functionName: 'Other', requestId: 'r' })).Tag, { Shown: 1, UiOnly: 2 });
  assert.deepEqual((await call(d, { functionName: 'Custom', requestId: 'r' })).Tag, { Shown: 1, Nullable: null });
});

test('log policy: requests are logged verbatim except Effect_GetLEDs / Effect_CheckDynamicLightingEnabled', async () => {
  const { d, lines } = setup();
  assert.deepEqual(VENDOR_QUIET_FUNCTIONS, ['Effect_GetLEDs', 'Effect_CheckDynamicLightingEnabled']);
  const loud = '{"functionName":"Start","requestId":"a","parms":null}';
  await d.dispatch(loud);
  await d.dispatch('{"functionName":"Effect_GetLEDs","requestId":"b","parms":[100000]}');
  await d.dispatch('{"functionName":"Effect_CheckDynamicLightingEnabled","requestId":"c","parms":null}');
  const logged = lines.filter((l) => l.text.startsWith('GetTaskAsync param = ')).map((l) => l.text);
  assert.deepEqual(logged, [`GetTaskAsync param = ${loud}`]);
});

test('registration validates names, types and duplicate signatures', () => {
  const { d } = setup();
  assert.ok(d.has('PHL_SetOSD'));
  assert.ok(!d.has('Nope'));
  assert.deepEqual(d.functionNames().slice(0, 3), ['Start', 'PHL_SetOSD', 'Theme_GetDevicesBasicInfo']);
  assert.throws(() => d.register('PHL_SetOSD', ['string', 'int'], () => succ()), /already registered/);
  assert.throws(() => d.register('X', ['float' as RpcArgType], () => succ()), /unsupported parameter type/);
  assert.throws(() => d.register(' ', [], () => succ()), /must not be empty/);
  d.register('PHL_SetOSD', ['int'], () => succ()); // a new signature is fine
});

test('a result that cannot be serialized still answers the request', async () => {
  const { d, lines } = setup();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  d.register('Cyclic', [], () => succ(cyclic));
  const r = await call(d, { functionName: 'Cyclic', requestId: 'rc' });
  assert.equal(r.err_code, 9);
  assert.match(r.err_msg!, /^JsonSerialize failed: /);
  assert.equal(r.RequestId, 'rc');
  assert.equal(r.FunctionName, 'Cyclic');
  assert.ok(lines.some((l) => l.level === 'error' && l.text.startsWith('JsonSerialize failed for Cyclic')));
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('handler watchdog: an overrunning handler is answered with err_code 9 and the ids; its late outcome is only logged', async () => {
  const { log, lines } = captureLogger();
  const d = new RpcDispatcher(log, { handlerTimeoutMs: 100 });
  let lateResolved = false;
  d.register('Hang', [], () => new Promise<JsonResult>(() => {}));
  d.register('Late', ['int'], async ([ms]) => {
    await delay(Number(ms));
    lateResolved = true;
    return succ('too late');
  });
  d.register('LateFail', [], async () => {
    await delay(200);
    throw new Error('transfer aborted');
  });
  d.register('Quick', [], async () => {
    await delay(20);
    return succ(true);
  });

  const t0 = performance.now();
  assertError(await call(d, { functionName: 'Hang', requestId: 'rh', parms: null }), handlerTimeoutMessage('Hang', 100), 'rh', 'Hang');
  const took = performance.now() - t0;
  assert.ok(took >= 95 && took < 1000, `answered after the watchdog (${took} ms)`);
  assert.equal(handlerTimeoutMessage('Hang', 100), 'functionName: Hang timed out after 100 ms');
  assert.ok(lines.some((l) => l.level === 'error' && l.scope === 'test/Hang' && l.text.startsWith('no result after 100 ms')));

  assertError(await call(d, { functionName: 'Late', requestId: 'rl', parms: [200] }), handlerTimeoutMessage('Late', 100), 'rl', 'Late');
  assertError(await call(d, { functionName: 'LateFail', requestId: 'rf' }), handlerTimeoutMessage('LateFail', 100), 'rf', 'LateFail');
  await delay(250);
  assert.ok(lateResolved, 'the handler was not cancelled');
  assert.ok(lines.some((l) => l.level === 'warn' && l.scope === 'test/Late' && /^finished \d+ ms after the call started, after the watchdog had answered; result dropped$/.test(l.text)));
  assert.ok(lines.some((l) => l.level === 'error' && l.scope === 'test/LateFail' && l.text.includes('transfer aborted')));

  // handlers inside the limit, and failures inside the limit, are not affected
  assert.equal((await call(d, { functionName: 'Quick', requestId: 'rq' })).Tag, true);
  const fast = await call(d, { functionName: 'Late', requestId: 'r0', parms: [0] });
  assert.equal(fast.Tag, 'too late');
  assert.ok(!lines.some((l) => l.scope === 'test/Quick' && l.level !== 'debug'));
});

test('handler watchdog: 120 s by default, disabled with 0, bounded by the setTimeout range', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(DEFAULT_HANDLER_TIMEOUT_MS, 120_000);
  const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true), Promise.resolve().then(() => false)]);
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const gated = (d: RpcDispatcher) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    d.register('Slow', [], async () => {
      await gate;
      return succ('done');
    });
    return () => release();
  };

  const { log } = captureLogger();
  const byDefault = new RpcDispatcher(log);
  gated(byDefault);
  const p1 = call(byDefault, { functionName: 'Slow', requestId: 'a' });
  await flush();
  t.mock.timers.tick(DEFAULT_HANDLER_TIMEOUT_MS - 1);
  await flush();
  assert.equal(await settled(p1), false, 'still waiting just before 120 s');
  t.mock.timers.tick(1);
  assertError(await p1, handlerTimeoutMessage('Slow', DEFAULT_HANDLER_TIMEOUT_MS), 'a', 'Slow');

  const unbounded = new RpcDispatcher(log, { handlerTimeoutMs: 0 });
  const release = gated(unbounded);
  const p2 = call(unbounded, { functionName: 'Slow', requestId: 'b' });
  await flush();
  t.mock.timers.tick(10 * DEFAULT_HANDLER_TIMEOUT_MS);
  await flush();
  assert.equal(await settled(p2), false, 'no watchdog with handlerTimeoutMs 0 (vendor behaviour)');
  release();
  assert.equal((await p2).Tag, 'done');

  for (const bad of [2 ** 31, Infinity, NaN]) {
    assert.throws(() => new RpcDispatcher(log, { handlerTimeoutMs: bad }), RangeError);
  }
  assert.doesNotThrow(() => new RpcDispatcher(log, { handlerTimeoutMs: -1 }));
});

test('registrations(): read-only view of every overload with its serialize mode, without dispatching', () => {
  const { d, lines, calls } = setup();
  d.register('Profile_GetDeviceData', ['int'], () => succ());
  d.register('Custom', [], () => succ(), 'uiProfileGet');
  const regs = d.registrations();
  assert.deepEqual(regs.slice(0, 6), [
    { name: 'Start', signature: [], serialize: 'ui' },
    { name: 'PHL_SetOSD', signature: ['string'], serialize: 'ui' },
    { name: 'PHL_SetOSD', signature: ['string', 'int'], serialize: 'ui' },
    { name: 'Theme_GetDevicesBasicInfo', signature: ['int'], serialize: 'ui' },
    { name: 'Theme_GetDevicesBasicInfo', signature: ['string', 'string', 'int'], serialize: 'ui' },
    { name: 'Theme_GetDevicesBasicInfo', signature: ['string', 'int'], serialize: 'ui' },
  ]);
  assert.deepEqual(regs.slice(-2), [
    { name: 'Profile_GetDeviceData', signature: ['int'], serialize: 'uiProfileGet' },
    { name: 'Custom', signature: [], serialize: 'uiProfileGet' },
  ]);
  assert.deepEqual([...new Set(regs.map((r) => r.name))], d.functionNames());
  assert.equal(calls.length, 0);
  assert.equal(lines.length, 0, 'nothing dispatched, nothing logged');
  // copies: mutating them does not change the dispatcher
  (regs[1].signature as RpcArgType[]).push('bool');
  assert.deepEqual(d.registrations()[1].signature, ['string']);
});

test('every request from the real Windows logs dispatches to its Bridge signature', async () => {
  const { log } = captureLogger();
  const d = new RpcDispatcher(log);
  const bridge: Record<string, RpcArgType[][]> = {
    Macro_GetList: [['string']],
    PHL_SwitchDisplay: [['string']],
    Profile_GetDeviceData: [['int']],
    PHL_SetOSD: [['string'], ['string', 'int']],
  };
  const requests = vendorRequests();
  for (const raw of requests) {
    const name = (JSON.parse(raw) as { functionName: string }).functionName;
    if (d.has(name)) continue;
    for (const sig of bridge[name] ?? [[]]) d.register(name, sig, (args) => succ(args));
  }
  for (const raw of requests) {
    const req = JSON.parse(raw) as { functionName: string; requestId: string; parms: RpcArg[] | null };
    const r = await call(d, raw);
    assert.equal(r.err_code, 0, raw);
    assert.equal(r.RequestId, req.requestId);
    assert.equal(r.FunctionName, req.functionName);
    assert.deepEqual(r.Tag, req.parms ?? []);
  }
});
