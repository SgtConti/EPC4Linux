import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { createLogger, silentSink } from '../../../src/backend/core/log.ts';
import { DeviceChangeGate, type DeviceEventName } from '../../../src/main/device-events.ts';

const log = createLogger('test', silentSink);
let sent: [DeviceEventName, number][];
let now: number;
let gate: DeviceChangeGate;

beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout'] });
  sent = [];
  now = 0;
  gate = new DeviceChangeGate((name) => sent.push([name, now]), log);
});

function advance(ms: number): void {
  now += ms;
  mock.timers.tick(ms);
}

test('displayChange is a 2000 ms trailing debounce (01 §9)', () => {
  gate.trigger('displayChange');
  advance(1500);
  gate.trigger('displayChange');
  advance(1999);
  assert.deepEqual(sent, []);
  advance(1);
  assert.deepEqual(sent, [['displayChange', 3500]]);
});

test('USBChange: lock, send after 1000 ms, unlock after 2000 ms', () => {
  gate.trigger('USBChange');
  advance(500);
  gate.trigger('USBChange'); // dropped: locked
  advance(500);
  assert.deepEqual(sent, [['USBChange', 1000]]);
  advance(900);
  gate.trigger('USBChange'); // still locked at 1900
  advance(100); // unlock at 2000
  gate.trigger('USBChange');
  advance(1000);
  assert.deepEqual(sent, [['USBChange', 1000], ['USBChange', 3000]]);
});

test('otherDeviceChange sends after 1700 ms: detach → +1.0 s USBChange, +0.7 s otherDeviceChange (real log pattern)', () => {
  gate.trigger('USBChange');
  gate.trigger('otherDeviceChange');
  advance(1000);
  advance(700);
  assert.deepEqual(sent, [['USBChange', 1000], ['otherDeviceChange', 1700]]);
});

test('shieldPeripheralChange suppresses USB and other-device events on entry and at fire time', () => {
  gate.shieldPeripheralChange(true);
  gate.trigger('USBChange');
  advance(3000);
  assert.deepEqual(sent, []);
  gate.shieldPeripheralChange(false);
  gate.trigger('otherDeviceChange');
  advance(1000);
  gate.shieldPeripheralChange(true); // shield raised while the send is pending
  advance(1000);
  assert.deepEqual(sent, []);
});

test('shieldDisplayChange(true) blocks; (false, seconds) keeps the shield for that long', () => {
  gate.shieldDisplayChange(true);
  gate.trigger('displayChange');
  advance(5000);
  assert.deepEqual(sent, []);
  gate.shieldDisplayChange(false); // default 4 s
  assert.equal(gate.isShielded('displayChange'), true);
  advance(3999);
  assert.equal(gate.isShielded('displayChange'), true);
  advance(1);
  assert.equal(gate.isShielded('displayChange'), false);
  gate.shieldDisplayChange(true);
  gate.shieldDisplayChange(false, 0); // no delay: immediately off
  assert.equal(gate.isShielded('displayChange'), false);
});

test('a pending display event is dropped when the shield goes up before it fires', () => {
  gate.trigger('displayChange');
  advance(1000);
  gate.shieldDisplayChange(true);
  advance(1000);
  assert.deepEqual(sent, []);
});

test('a new shieldDisplayChange cancels the previous timed release', () => {
  gate.shieldDisplayChange(true);
  gate.shieldDisplayChange(false, 1);
  gate.shieldDisplayChange(true);
  advance(2000);
  assert.equal(gate.isShielded('displayChange'), true);
});

test('dispose cancels everything pending', () => {
  gate.trigger('displayChange');
  gate.trigger('USBChange');
  gate.dispose();
  advance(5000);
  assert.deepEqual(sent, []);
});
