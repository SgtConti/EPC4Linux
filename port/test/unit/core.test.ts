import { test } from 'node:test';
import assert from 'node:assert/strict';
import { succ, error, serializeResult } from '../../src/backend/core/envelope.ts';
import { serialize, toCSharpJson, parseJson } from '../../src/backend/core/json.ts';
import { Mutex, sleep } from '../../src/backend/core/events.ts';

test('envelope key order and success semantics match Zeasn JsonResult', () => {
  const r = { ...succ({ a: 1 }), RequestId: 'x', FunctionName: 'Start' };
  assert.equal(serializeResult(r), '{"err_code":0,"IsSucc":true,"err_msg":"","RequestId":"x","Tag":{"a":1},"FunctionName":"Start","CurrItem":null}');
  const e = error('boom', 0);
  assert.equal(e.err_code, 9);
  assert.equal(JSON.parse(serializeResult(e)).IsSucc, false);
});

test('serializer modes: ui keeps nulls, profile drops nulls, custom hook sees mode', () => {
  const entity = { [toCSharpJson]: (mode: string) => (mode === 'uiProfileGet' ? { Name: 'n' } : { Name: 'n', Hidden: 1 }) };
  assert.equal(serialize({ x: null, e: entity }, 'ui'), '{"x":null,"e":{"Name":"n","Hidden":1}}');
  assert.equal(serialize({ x: null, e: entity }, 'profile'), '{"e":{"Name":"n","Hidden":1}}');
  assert.equal(serialize({ e: entity }, 'uiProfileGet'), '{"e":{"Name":"n"}}');
  assert.equal(serialize(new Uint8Array([1, 2, 3])), '"AQID"');
  assert.deepEqual(parseJson('﻿{"a":1}\n'), { a: 1 });
});

test('mutex serializes async work', async () => {
  const m = new Mutex();
  const order: number[] = [];
  await Promise.all([
    m.run(async () => { await sleep(20); order.push(1); }),
    m.run(async () => { order.push(2); }),
  ]);
  assert.deepEqual(order, [1, 2]);
});
