// rendererLogLine (src/main/renderer-log.ts): the messages of the vendor renderer's electron-log IPC transport
// (styles-DAnQi2A8.js:30995-31010 sendToMain; the error handler's {cmd:"errorHandler"}, :31070-31080).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RENDERER_LOG_CHARS, rendererLogLine } from '../../../src/main/renderer-log.ts';

test('a named logger line (renderer/useConnectDetection on a monitor unplug) keeps its level and data', () => {
  // what electron-log's transform sends for Qf("renderer/useConnectDetection").info(…) (main-CDosWiM3.js:1749)
  const message = { data: ['[renderer/useConnectDetection]', 'To overview device list empty'], level: 'info', logId: 'default', scope: undefined, variables: { processType: 'renderer' } };
  assert.deepEqual(rendererLogLine(message), { level: 'info', text: '[renderer/useConnectDetection] To overview device list empty' });
  assert.deepEqual(rendererLogLine({ data: ['x', { a: 1 }, 2, null], level: 'warn' }), { level: 'warn', text: 'x {"a":1} 2 null' });
  assert.equal(rendererLogLine({ data: 'single', level: 'error' })?.text, 'single');
});

test('levels: electron-log verbose/silly map to debug, anything unknown to info', () => {
  assert.equal(rendererLogLine({ data: [], level: 'verbose' })?.level, 'debug');
  assert.equal(rendererLogLine({ data: [], level: 'silly' })?.level, 'debug');
  assert.equal(rendererLogLine({ data: [], level: 'debug' })?.level, 'debug');
  assert.equal(rendererLogLine({ data: [], level: 'fatal' })?.level, 'info');
  assert.equal(rendererLogLine({ data: [], level: 3 })?.level, 'info');
  assert.equal(rendererLogLine({ data: [] })?.level, 'info');
});

test('the error handler message: errorName and the stack, flattened to one line', () => {
  const line = rendererLogLine({
    cmd: 'errorHandler',
    errorName: 'Unhandled rejection',
    error: { name: 'TypeError', message: 'x is undefined', stack: 'TypeError: x is undefined\n    at a (file:///x.js:1:2)\n    at b' },
    logId: 'default',
    showDialog: false,
  });
  assert.deepEqual(line, { level: 'error', text: 'Unhandled rejection TypeError: x is undefined | at a (file:///x.js:1:2) | at b' });
  assert.deepEqual(rendererLogLine({ cmd: 'errorHandler', error: { message: 'm' } }), { level: 'error', text: 'Error: m' });
});

test('untrusted input: non-objects ignored, one bounded line, no control characters', () => {
  for (const m of [null, undefined, 'text', 5, ['data'], { level: 'info' }]) assert.equal(rendererLogLine(m), null, JSON.stringify(m));
  const long = rendererLogLine({ data: ['x'.repeat(MAX_RENDERER_LOG_CHARS + 10)], level: 'info' })!;
  assert.ok(long.text.length < MAX_RENDERER_LOG_CHARS + 40);
  assert.match(long.text, /… \(4106 chars\)$/);
  assert.equal(rendererLogLine({ data: ['a\r\nb\u0000c\u001bd'], level: 'info' })!.text, 'a | b c d');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(rendererLogLine({ data: [circular], level: 'info' })!.text, '[object Object]');
});
