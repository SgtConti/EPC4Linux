import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DEPTH, parseInputParams, parseJToken, salvageRequestIds, toInt32 } from '../../../src/backend/rpc/input-params.ts';
import { vendorRequests } from './helpers.ts';

const BS = '\\';
const BOM = String.fromCharCode(0xfeff);

test('every request in the real Windows logs parses like Newtonsoft', () => {
  const requests = vendorRequests();
  assert.ok(requests.length >= 40, `expected the 50 logged requests, got ${requests.length}`);
  for (const raw of requests) {
    const p = parseInputParams(raw);
    assert.ok(p, raw);
    assert.equal(typeof p.functionName, 'string');
    assert.match(p.requestId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(p.device, -1);
    for (const t of p.parms ?? []) assert.ok(t.type === 'Integer' || t.type === 'String', raw);
  }
  const osd = parseInputParams(requests.find((r) => r.includes('PHL_SetOSD'))!)!;
  assert.deepEqual(osd.parms, [{ type: 'String', value: 'EXT_OP_E2A0_43_AutoWarning' }, { type: 'Integer', lexeme: '1' }]);
  assert.equal(parseInputParams(requests[0])!.parms, null); // Start sends "parms":null
});

test('numbers keep Newtonsoft Integer/Float typing by spelling', () => {
  const types = (json: string) => (parseInputParams(`{"functionName":"f","parms":${json}}`)!.parms ?? []).map((t) => t.type);
  assert.deepEqual(types('[1,-0,2147483648,99999999999999999999]'), ['Integer', 'Integer', 'Integer', 'Integer']);
  assert.deepEqual(types('[1.0,1e3,1E+2,-0.5,1e400]'), ['Float', 'Float', 'Float', 'Float', 'Float']);
  assert.deepEqual(types('[null,{},[],true,"x"]'), ['Null', 'Object', 'Array', 'Boolean', 'String']);
  // ISO date-time strings stay strings (deviation from DateParseHandling.DateTime, see impl notes).
  assert.deepEqual(types('["2026-09-26T07:52:30","/Date(1)/"]'), ['String', 'String']);
});

test('toInt32 applies the C# range with the .NET overflow message', () => {
  assert.equal(toInt32('2147483647'), 2147483647);
  assert.equal(toInt32('-2147483648'), -2147483648);
  assert.ok(Object.is(toInt32('-0'), 0));
  assert.throws(() => toInt32('2147483648'), { message: 'Value was either too large or too small for an Int32.' });
  assert.throws(() => toInt32('-99999999999999999999999'), RangeError);
});

test('property binding: case-insensitive names, unknown ignored, nulls skipped, last wins, parms appended', () => {
  assert.deepEqual(parseInputParams('{"FUNCTIONNAME":"Start","RequestID":"r","Extra":{"a":[1]}}'), {
    device: -1, functionName: 'Start', requestId: 'r', parms: null,
  });
  // exact-case match is preferred but both spellings bind the same property; later wins
  assert.equal(parseInputParams('{"functionName":"A","FunctionName":"B"}')!.functionName, 'B');
  // null is ignored (NullValueHandling.Ignore) and does not reset an earlier value
  assert.equal(parseInputParams('{"functionName":"A","functionName":null}')!.functionName, 'A');
  assert.equal(parseInputParams('{"device":null}')!.device, -1);
  // ObjectCreationHandling.Auto reuses the existing List<JToken>
  assert.deepEqual(parseInputParams('{"parms":[1],"parms":["x"]}')!.parms!.map((t) => t.type), ['Integer', 'String']);
  assert.deepEqual(parseInputParams('{"parms":[]}')!.parms, []);
});

test('string properties read numbers and booleans as text (JsonTextReader.ReadAsString)', () => {
  assert.equal(parseInputParams('{"functionName":12.50}')!.functionName, '12.50');
  assert.equal(parseInputParams('{"functionName":true,"requestId":7}')!.functionName, 'true');
  assert.equal(parseInputParams('{"functionName":true,"requestId":7}')!.requestId, '7');
  assert.equal(parseInputParams('{"functionName":{}}'), null);
  assert.equal(parseInputParams('{"requestId":[]}'), null);
});

test('device reads like ReadAsInt32', () => {
  assert.equal(parseInputParams('{"device":100000}')!.device, 100000);
  assert.equal(parseInputParams('{"device":" +42 "}')!.device, 42);
  assert.equal(parseInputParams('{"device":""}')!.device, -1);
  for (const bad of ['1.0', '"1.5"', '"abc"', 'true', '2147483648', '"2147483648"', '[]']) {
    assert.equal(parseInputParams(`{"device":${bad}}`), null, bad);
  }
});

test('anything Newtonsoft would fail on yields null', () => {
  for (const bad of [
    '', ' ', 'null', '[]', '"x"', '1', 'true', '{', '{"functionName":"a"} x', '{"a":1,}', '[1,]',
    "{'functionName':'a'}", '{functionName:"a"}', '{"parms":"x"}', '{"parms":{}}', '{"parms":1}',
    '{"a":01}', '{"a":NaN}', '{"a":.5}', `{"a":"${BS}x"}`, `{"a":"${BS}u12"}`, '{"a":"unterminated',
    '/* c */{}', BOM + '{}',
  ]) {
    assert.equal(parseInputParams(bad), null, JSON.stringify(bad));
  }
});

test('string escapes and raw control characters', () => {
  const json = `{"functionName":"${BS}u0053tart${BS}n${BS}"${BS}${BS}${BS}/","requestId":"a\tb"}`;
  const p = parseInputParams(json)!;
  assert.equal(p.functionName, 'Start\n"\\/');
  assert.equal(p.requestId, 'a\tb'); // Newtonsoft accepts unescaped control characters
});

test('nesting is limited to MaxDepth like Newtonsoft 13', () => {
  const nest = (n: number) => '['.repeat(n) + ']'.repeat(n);
  assert.equal(parseJToken(nest(MAX_DEPTH)).type, 'Array');
  assert.throws(() => parseJToken(nest(MAX_DEPTH + 1)), SyntaxError);
  assert.equal(parseInputParams(`{"parms":${nest(MAX_DEPTH)}}`), null); // object adds one level
  assert.doesNotThrow(() => parseInputParams(`{"parms":${nest(100_000)}}`)); // no stack overflow
});

test('salvageRequestIds reads the ids of a request that failed to bind, best-effort', () => {
  const none = { functionName: null, requestId: null };
  const raw = '{"functionName":"PHL_SetOSD","requestId":"abc","parms":[1],"device":"x"}';
  assert.equal(parseInputParams(raw), null);
  assert.deepEqual(salvageRequestIds(raw), { functionName: 'PHL_SetOSD', requestId: 'abc' });
  assert.deepEqual(salvageRequestIds('{"FunctionName":7,"REQUESTID":false,"parms":"x"}'), { functionName: '7', requestId: 'false' });
  assert.deepEqual(salvageRequestIds('{"functionName":[],"requestId":"r","requestId":{}}'), { functionName: null, requestId: 'r' });
  for (const text of ['', 'garbage', 'null', '"x"', '[{"functionName":"Start"}]', '{"functionName":"Start"', `${'['.repeat(MAX_DEPTH + 1)}`]) {
    assert.deepEqual(salvageRequestIds(text), none, text);
  }
});
