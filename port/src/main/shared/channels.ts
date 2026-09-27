// IPC contract between the vendor renderer, the preload and the main process.
//
// Pure module shared by src/main (handler registration, tests) and the sandboxed preload.
// The vendor preload forwarded every channel (02 §2.1, §2.3: no allowlist). The port forwards only
// the channels 01 §10 marks Keep/Adapt; every other channel the renderer uses (02 §3) is answered
// inertly inside the preload so no renderer promise hangs and no request reaches main (02 §L.2).

/** renderer → main request/response channels forwarded to ipcMain.handle (01 §10.1 Keep/Adapt). */
export const INVOKE_CHANNELS = [
  'getRunConfig', // 01 #1
  'startupBackendService', // 01 #2 (Adapt: in-process backend + loopback hub)
  'maximizedValue', // 01 #6
  'maximizeToggler', // 01 #7
  'fileSelect', // 01 #9
  'getFileSize', // 01 #10
  'exportFile', // 01 #11
  'getFileMd5', // 01 #19
  'getMonitorJsonConfig', // 01 #21 (OTAEnable always false)
] as const;

/** renderer → main fire-and-forget channels forwarded to ipcMain.on (01 §10.1 Keep/Adapt). */
export const SEND_CHANNELS = [
  'resetToStartSize', // 01 #3
  'interfaceInitializeCompleted', // 01 #4
  'minimize', // 01 #5
  'close', // 01 #8
  'setWindowSize', // 01 #16
  'setLanguage', // 01 #17
  'setAutoStartUp', // 01 #18 (Adapt: XDG autostart)
  'disableTrayExit', // 01 #22
  'disableTrayFunction', // 01 #23
  'shieldDisplayChange', // 01 #27
  'shieldPeripheralChange', // 01 #28
  'notice', // 01 #31
] as const;

/** main → renderer events the preload lets through (01 §10.2 minus the stripped online ones). */
export const EVENT_CHANNELS = [
  'displayChange',
  'USBChange',
  'otherDeviceChange',
  'rescan',
  'toPageView',
  'mainWindowShow',
  'setNotice', // notice window
  'setLanguage', // notice window
] as const;

/**
 * Events the renderer subscribes to (02 §3.2) that only the stripped online/Matter features emit.
 * Subscriptions succeed and return an unsubscribe function; only the preload's own synthetic replies
 * (below) are ever delivered on them.
 */
export const LOCAL_EVENT_CHANNELS = [
  'newVersionPrompt',
  'versionCheckResult',
  'checkSoftwareUpgrade',
  'thirdPartySuccess',
  'loginShow',
  'matterNotification',
  'downloadProgressUpdate',
  'downloadSuccess',
  'downloadFail',
] as const;

const BULB_DISABLED = { success: false, error: 'disabled' };

/**
 * Inert answers for stripped invoke channels (02 §L.2 OFFLINE_DEFAULTS; 01 §10.1 Strip rows).
 * Returned as fresh copies so the renderer can never mutate a shared default.
 */
export const OFFLINE_INVOKE_DEFAULTS: Readonly<Record<string, unknown>> = {
  runCommand: { error: { message: 'disabled' }, stdout: '' },
  getMac: '',
  extractZip: '',
  findExe: '',
  getSystemInfo: {},
  imageResourceDownload: '',
  getCloudFileCacheOrDownload: '',
  checkNodeAvailable: { available: false, extractPath: '' },
  getCurrentProcess: '',
  discoverBulb: BULB_DISABLED,
  pairingBulb: BULB_DISABLED,
  commissionBulb: BULB_DISABLED,
  openCommissioningWindow: BULB_DISABLED,
  identifyBulb: BULB_DISABLED,
  getBulbAttribute: BULB_DISABLED,
  setBulbAttribute: BULB_DISABLED,
  removeBulb: BULB_DISABLED,
  destroyBulbProcess: false,
  clearCache: false,
};

/**
 * Stripped send channels whose vendor handler answered with an event the renderer waits for.
 * `checkSoftwareVersion` shows a loading overlay until `versionCheckResult` arrives (02 §3.1 P10);
 * `createDownload` callers wait for `downloadSuccess`/`downloadFail` (01 port plan 7).
 */
export function syntheticReply(channel: string, args: readonly unknown[]): [string, unknown] | null {
  switch (channel) {
    case 'checkSoftwareVersion':
      return ['versionCheckResult', { state: 0, isStartup: false, versionNum: '', packageUrl: '', description: [] }];
    case 'createDownload':
      return ['downloadFail', { url: typeof args[0] === 'string' ? args[0] : '', msg: 'offline' }];
    default:
      return null;
  }
}

/** Stripped send channels that are silently dropped (online, feedback, updater, browser launch). */
export const DROPPED_SEND_CHANNELS = [
  'checkSoftwareVersion',
  'createDownload',
  'cancelDownload',
  'softwareDownload',
  'softwareInstall',
  'cancelSoftwareUpgrade',
  'openDefaultBrowser',
  'openFeedbackWindow',
  'closeFeedbackWindow',
] as const;

/** Internal channels between our preloads and main (never reachable from page code). */
export const INTERNAL_CHANNELS = {
  /** sync: BootstrapData for the calling window. */
  bootstrap: 'evnia:bootstrap',
  /** send: (key, value) write-through of window.store.set. */
  storeSet: 'evnia:store-set',
  /** send: (key) write-through of window.store.delete. */
  storeDelete: 'evnia:store-delete',
  /** main → preload: (key, value | undefined) change made by another window or by main. */
  storeChanged: 'evnia:store-changed',
  /** sync nodeApi file access, confined by main (see src/main/fs-guard.ts). */
  fsExists: 'evnia:fs-exists',
  fsReadSync: 'evnia:fs-read-sync',
  fsCopySync: 'evnia:fs-copy-sync',
  fsUnlinkSync: 'evnia:fs-unlink-sync',
  /** invoke: async nodeApi.readFile. */
  fsRead: 'evnia:fs-read',
  /**
   * send: (message) a line of the renderer's electron-log (window.__electronLog.sendToMain, the bridge
   * electron-log's own preload provided in the vendor app) for the main log (src/main/renderer-log.ts).
   */
  rendererLog: 'evnia:renderer-log',
  /** capture window → main (src/capture/protocol.ts). */
  captureFrame: 'evnia:capture-frame',
  captureStatus: 'evnia:capture-status',
} as const;

/** The vendor electron-store sync channel (01 §10.1 #50), kept for compatibility. */
export const ELECTRON_STORE_SYNC_CHANNEL = 'electron-store-get-data';

export interface BootstrapData {
  /** Full config.json snapshot (defaults applied). */
  store: Record<string, unknown>;
  /** Per-launch hub token for the main window, '' for other windows. */
  hubToken: string;
}

/** Result envelope of the synchronous nodeApi channels (errors cannot cross sendSync as throws). */
export type FsSyncResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };
