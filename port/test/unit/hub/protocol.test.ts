import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as signalR from '@microsoft/signalr';
import {
  HANDSHAKE_OK,
  HubProtocolError,
  MessageType,
  PING_RECORD,
  RecordReader,
  checkHandshake,
  closeRecord,
  completionRecord,
  handshakeErrorRecord,
  invocationRecord,
  parseHubMessage,
} from '../../../src/backend/hub/protocol.ts';
import { RS } from './helpers.ts';

const b = (s: string) => Buffer.from(s, 'utf8');

test('RecordReader: several records per chunk and records split across chunks', () => {
  const r = new RecordReader(1024);
  assert.deepEqual(r.push(b(`{"type":6}${RS}{"type":6}${RS}{"ty`)), ['{"type":6}', '{"type":6}']);
  assert.equal(r.pendingBytes, 4);
  assert.deepEqual(r.push(b('pe":')), []);
  assert.deepEqual(r.push(b(`7}${RS}`)), ['{"type":7}']);
  assert.equal(r.pendingBytes, 0);
  assert.deepEqual(r.push(b(`${RS}`)), ['']); // empty record: rejected later by the JSON parser
});

test('RecordReader: a multi-byte UTF-8 character split between chunks survives', () => {
  const r = new RecordReader(1024);
  const bytes = b(`"解析"${RS}`);
  assert.deepEqual(r.push(bytes.subarray(0, 2)), []);
  assert.deepEqual(r.push(bytes.subarray(2, 5)), []);
  assert.deepEqual(r.push(bytes.subarray(5)), ['"解析"']);
});

test('RecordReader: enforces the 1 MiB record limit and rejects invalid UTF-8', () => {
  const r = new RecordReader(10);
  assert.throws(() => r.push(b('x'.repeat(11))), HubProtocolError);
  const r2 = new RecordReader(10);
  r2.push(b('x'.repeat(6)));
  assert.throws(() => r2.push(b(`${'x'.repeat(5)}${RS}`)), /maximum message size of 10B/);
  assert.throws(() => new RecordReader(10).push(Buffer.from([0x22, 0xc3, 0x28, 0x22, 0x1e])), /not valid UTF-8/);
});

test('handshake validation follows ASP.NET Core', () => {
  assert.equal(checkHandshake('{"protocol":"json","version":1}'), null);
  assert.equal(checkHandshake('{"version":1,"protocol":"JSON","extra":true}'), null);
  assert.equal(checkHandshake('{"protocol":"messagepack","version":1}'), "The protocol 'messagepack' is not supported.");
  assert.equal(checkHandshake('{"protocol":"json","version":2}'), "The server does not support version 2 of the 'json' protocol.");
  assert.equal(
    checkHandshake('{"version":1}'),
    "An unexpected error occurred during connection handshake. InvalidDataException: Missing required property 'protocol'. Message content: {\"version\":1}",
  );
  assert.match(checkHandshake('{"protocol":"json"}')!, /Missing required property 'version'/);
  assert.match(checkHandshake('{"protocol":1,"version":1}')!, /Expected 'protocol' to be of type String/);
  assert.match(checkHandshake('{"protocol":"json","version":"1"}')!, /Expected 'version' to be of type Number/);
  assert.match(checkHandshake('not json')!, /^An unexpected error occurred during connection handshake\. InvalidDataException: Invalid JSON/);
  assert.match(checkHandshake('[]')!, /Unexpected JSON Token Type 'StartArray'/);
});

test('parseHubMessage accepts what the 7.0.14 client writes', () => {
  const proto = new signalR.JsonHubProtocol();
  const written = proto.writeMessage({ type: signalR.MessageType.Invocation, invocationId: '0', target: 'GetTaskAsync', arguments: ['{"functionName":"Start"}'], streamIds: [] }) as string;
  assert.ok(written.endsWith(RS));
  assert.deepEqual(parseHubMessage(written.slice(0, -1)), {
    type: 1, invocationId: '0', target: 'GetTaskAsync', arguments: ['{"functionName":"Start"}'], streamIds: [],
  });
  const ping = proto.writeMessage({ type: signalR.MessageType.Ping }) as string;
  assert.deepEqual(parseHubMessage(ping.slice(0, -1)), { type: MessageType.Ping });
  assert.deepEqual(parseHubMessage('{"type":7,"error":"bye"}'), { type: 7, error: 'bye' });
  for (const t of [2, 3, 5, 8, 9]) assert.deepEqual(parseHubMessage(`{"type":${t},"invocationId":"1"}`), { type: t });
  // non-blocking invocation (hub.send): no invocationId
  assert.deepEqual(parseHubMessage('{"type":1,"target":"GetTaskAsync","arguments":["x"]}'), { type: 1, target: 'GetTaskAsync', arguments: ['x'] });
});

test('parseHubMessage rejects malformed messages with InvalidDataException', () => {
  const bad: [string, RegExp][] = [
    ['', /Invalid JSON/],
    ['{"type":1', /Invalid JSON/],
    ['"x"', /Expected a JSON Object/],
    ['{}', /Missing required property 'type'/],
    ['{"type":"1"}', /Expected 'type' to be of type Number/],
    ['{"type":1.5}', /Expected 'type' to be of type Number/],
    ['{"type":42}', /Unknown message type: 42/],
    ['{"type":1,"arguments":[]}', /Missing required property 'target'/],
    ['{"type":1,"target":5,"arguments":[]}', /Expected 'target' to be of type String/],
    ['{"type":1,"target":"GetTaskAsync"}', /Missing required property 'arguments'/],
    ['{"type":1,"target":"GetTaskAsync","arguments":"x"}', /Expected 'arguments' to be of type Array/],
    ['{"type":1,"target":"GetTaskAsync","arguments":[],"invocationId":0}', /Expected 'invocationId' to be of type String/],
    ['{"type":4,"target":"GetTaskAsync","arguments":[]}', /Missing required property 'invocationId'/],
    ['{"type":1,"target":"GetTaskAsync","arguments":[],"streamIds":"x"}', /Expected 'streamIds' to be of type Array/],
  ];
  for (const [record, re] of bad) {
    assert.throws(() => parseHubMessage(record), (e: unknown) => e instanceof HubProtocolError && e.name === 'InvalidDataException' && re.test(e.message), record);
  }
});

test('server records have ASP.NET byte layout and parse in the 7.0.14 client', () => {
  assert.equal(HANDSHAKE_OK, `{}${RS}`);
  assert.equal(handshakeErrorRecord('nope'), `{"error":"nope"}${RS}`);
  assert.equal(PING_RECORD, `{"type":6}${RS}`);
  assert.equal(invocationRecord('GetTaskAsync', ['{"a":1}']), `{"type":1,"target":"GetTaskAsync","arguments":["{\\"a\\":1}"]}${RS}`);
  // CompletionMessage.WithResult(id, null) for the void Task GetTaskAsync (20-backend-host-tail §1.4)
  assert.equal(completionRecord('0'), `{"type":3,"invocationId":"0","result":null}${RS}`);
  assert.equal(completionRecord('7', 'boom'), `{"type":3,"invocationId":"7","error":"boom"}${RS}`);
  assert.equal(closeRecord(), `{"type":7,"allowReconnect":true}${RS}`);
  assert.equal(closeRecord('err', false), `{"type":7,"error":"err"}${RS}`);

  const all = invocationRecord('Notification', ['{}']) + completionRecord('1') + PING_RECORD + closeRecord('x');
  const parsed = new signalR.JsonHubProtocol().parseMessages(all, signalR.NullLogger.instance);
  assert.deepEqual(parsed, [
    { type: 1, target: 'Notification', arguments: ['{}'] },
    { type: 3, invocationId: '1', result: null },
    { type: 6 },
    { type: 7, error: 'x', allowReconnect: true },
  ]);
});
