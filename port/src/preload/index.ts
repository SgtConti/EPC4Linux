// Preload for the main and notice windows (sandbox: true, contextIsolation: true).
//
// Drop-in replacement of the vendor preload (02 §2.1) with the same page-facing shapes; the API itself
// is built in api.ts. Exposed as window.ipc, window.store, window.nodeApi, window.__EVNIA__, window.noop
// and window.__electronLog (the renderer's electron-log bridge, src/main/renderer-log.ts).

import { contextBridge, ipcRenderer } from 'electron';
import { createPreloadApi } from './api.ts';

const api = createPreloadApi(ipcRenderer);

contextBridge.exposeInMainWorld('ipc', api.ipc);
contextBridge.exposeInMainWorld('store', api.store);
contextBridge.exposeInMainWorld('nodeApi', api.nodeApi);
contextBridge.exposeInMainWorld('noop', api.noop);
contextBridge.exposeInMainWorld('__EVNIA__', api.evnia);
contextBridge.exposeInMainWorld('__electronLog', api.electronLog);
