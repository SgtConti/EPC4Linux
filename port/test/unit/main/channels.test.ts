import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DROPPED_SEND_CHANNELS,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  LOCAL_EVENT_CHANNELS,
  OFFLINE_INVOKE_DEFAULTS,
  SEND_CHANNELS,
  syntheticReply,
} from '../../../src/main/shared/channels.ts';

// Every channel the vendor renderer uses (02 §3.1 / §3.2, grep of work/app-pretty/renderer).
const RENDERER_INVOKE = [
  'getRunConfig', 'startupBackendService', 'getMonitorJsonConfig', 'maximizedValue', 'maximizeToggler', 'fileSelect',
  'exportFile', 'getFileSize', 'getFileMd5', 'runCommand', 'extractZip', 'findExe', 'imageResourceDownload',
  'getCloudFileCacheOrDownload', 'getSystemInfo', 'getMac', 'checkNodeAvailable', 'discoverBulb', 'pairingBulb',
  'commissionBulb', 'openCommissioningWindow', 'identifyBulb', 'getBulbAttribute', 'setBulbAttribute', 'removeBulb',
  'clearCache', 'destroyBulbProcess',
];
const RENDERER_SEND = [
  'interfaceInitializeCompleted', 'resetToStartSize', 'minimize', 'close', 'setLanguage', 'setAutoStartUp', 'notice',
  'checkSoftwareVersion', 'softwareDownload', 'softwareInstall', 'cancelSoftwareUpgrade', 'createDownload',
  'cancelDownload', 'openDefaultBrowser', 'openFeedbackWindow', 'closeFeedbackWindow', 'disableTrayExit',
  'disableTrayFunction', 'shieldDisplayChange', 'shieldPeripheralChange',
];
const RENDERER_EVENTS = [
  'displayChange', 'USBChange', 'otherDeviceChange', 'newVersionPrompt', 'versionCheckResult', 'checkSoftwareUpgrade',
  'toPageView', 'rescan', 'mainWindowShow', 'thirdPartySuccess', 'matterNotification', 'loginShow',
  'downloadProgressUpdate', 'downloadSuccess', 'downloadFail', 'setNotice', 'setLanguage',
];

// 01 §10.1 rows marked Keep or Adapt.
const KEEP_ADAPT = [
  'getRunConfig', 'startupBackendService', 'resetToStartSize', 'interfaceInitializeCompleted', 'minimize',
  'maximizedValue', 'maximizeToggler', 'close', 'fileSelect', 'getFileSize', 'exportFile', 'setWindowSize',
  'setLanguage', 'setAutoStartUp', 'getFileMd5', 'getMonitorJsonConfig', 'disableTrayExit', 'disableTrayFunction',
  'shieldDisplayChange', 'shieldPeripheralChange', 'notice',
];

test('main handles exactly the Keep/Adapt channels of 01 §10.1', () => {
  assert.deepEqual([...INVOKE_CHANNELS, ...SEND_CHANNELS].sort(), [...KEEP_ADAPT].sort());
});

test('the dangerous and online channels never reach main', () => {
  const forwarded = new Set<string>([...INVOKE_CHANNELS, ...SEND_CHANNELS]);
  for (const ch of ['runCommand', 'findExe', 'extractZip', 'getMac', 'getSystemInfo', 'openDefaultBrowser', 'createDownload', 'imageResourceDownload', 'getCloudFileCacheOrDownload', 'softwareInstall', 'openFeedbackWindow']) {
    assert.ok(!forwarded.has(ch), ch);
  }
});

test('every invoke channel the renderer uses is forwarded or answered inertly (no hanging promise)', () => {
  for (const ch of RENDERER_INVOKE) {
    assert.ok((INVOKE_CHANNELS as readonly string[]).includes(ch) || Object.hasOwn(OFFLINE_INVOKE_DEFAULTS, ch), ch);
  }
  assert.deepEqual(OFFLINE_INVOKE_DEFAULTS.runCommand, { error: { message: 'disabled' }, stdout: '' });
  assert.deepEqual(OFFLINE_INVOKE_DEFAULTS.checkNodeAvailable, { available: false, extractPath: '' });
  assert.equal(OFFLINE_INVOKE_DEFAULTS.imageResourceDownload, '');
});

test('every send channel the renderer uses is forwarded or deliberately dropped', () => {
  for (const ch of RENDERER_SEND) {
    assert.ok((SEND_CHANNELS as readonly string[]).includes(ch) || (DROPPED_SEND_CHANNELS as readonly string[]).includes(ch), ch);
  }
});

test('every event channel the renderer subscribes to is either delivered or a local-only channel', () => {
  for (const ch of RENDERER_EVENTS) {
    assert.ok((EVENT_CHANNELS as readonly string[]).includes(ch) || (LOCAL_EVENT_CHANNELS as readonly string[]).includes(ch), ch);
  }
});

test('dropped senders the renderer waits on get a synthetic reply', () => {
  assert.deepEqual(syntheticReply('checkSoftwareVersion', []), [
    'versionCheckResult',
    { state: 0, isStartup: false, versionNum: '', packageUrl: '', description: [] },
  ]);
  assert.deepEqual(syntheticReply('createDownload', ['https://x/fw.zip', 'md5']), ['downloadFail', { url: 'https://x/fw.zip', msg: 'offline' }]);
  assert.equal(syntheticReply('openFeedbackWindow', []), null);
  for (const ch of ['checkSoftwareVersion', 'createDownload']) {
    const [event] = syntheticReply(ch, [])!;
    assert.ok((LOCAL_EVENT_CHANNELS as readonly string[]).includes(event), `${event} must be subscribable locally`);
    assert.ok((DROPPED_SEND_CHANNELS as readonly string[]).includes(ch));
  }
});
