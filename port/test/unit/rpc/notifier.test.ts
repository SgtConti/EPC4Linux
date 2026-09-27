import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubNotifier, NOTIFICATION_LOG_LIMIT } from '../../../src/backend/rpc/notifier.ts';
import { captureLogger } from './helpers.ts';

test('notifications use the vendor envelope: err_msg null, RequestId null, FunctionName = name', () => {
  const { log } = captureLogger();
  const n = new HubNotifier(log);
  const got: string[] = [];
  n.subscribe((json) => got.push(json));
  n.notify('NotifyUIDisplayFuncConstraintsChange', { FuncItems: [{ FuncId: 1, FuncName: 'x', State: 1 }], AudioEQ: 0, ModuleGameMode: 1 });
  assert.deepEqual(got, [
    '{"err_code":0,"IsSucc":true,"err_msg":null,"RequestId":null,"Tag":{"FuncItems":[{"FuncId":1,"FuncName":"x","State":1}],"AudioEQ":0,"ModuleGameMode":1},"FunctionName":"NotifyUIDisplayFuncConstraintsChange","CurrItem":null}',
  ]);
});

test('every subscriber receives each notification until it unsubscribes; a failing one does not block others', () => {
  const { log, lines } = captureLogger();
  const n = new HubNotifier(log);
  const a: string[] = [];
  const b: string[] = [];
  const offA = n.subscribe((j) => a.push(j));
  n.subscribe(() => {
    throw new Error('subscriber broke');
  });
  n.subscribe((j) => b.push(j));
  n.notify('FirmwareUpdateProgressData', { Name: 'Update Firmware Progress', Type: 'OSD', Value: 1 });
  offA();
  n.notify('NotifyDeviceConnectionStatus', { DeviceType: 100000, Data: true });
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
  assert.ok(lines.some((l) => l.level === 'error' && l.text.includes('subscriber broke')));
});

test('log line mirrors HandleEvent: payloads over 1024 characters are not printed', () => {
  const { log, lines } = captureLogger();
  const n = new HubNotifier(log);
  n.notify('Small', 1);
  n.notify('Big', 'x'.repeat(NOTIFICATION_LOG_LIMIT));
  const texts = lines.filter((l) => l.text.startsWith('OnNotification')).map((l) => l.text);
  assert.equal(texts.length, 2);
  assert.ok(texts[0].endsWith('"FunctionName":"Small","CurrItem":null}'));
  assert.ok(texts[1].endsWith("param='The parameter exceeds the print limit'"));
});

test('an unserializable payload is dropped with an error log instead of throwing', () => {
  const { log, lines } = captureLogger();
  const n = new HubNotifier(log);
  const got: string[] = [];
  n.subscribe((j) => got.push(j));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.doesNotThrow(() => n.notify('Cyclic', cyclic));
  assert.equal(got.length, 0);
  assert.ok(lines.some((l) => l.level === 'error' && l.text.includes('Cyclic')));
});
