// Preload of the hidden capture window (sandboxed, context-isolated). It only forwards the page's
// frames and status to main; the page cannot reach any other IPC channel.

import { contextBridge, ipcRenderer } from 'electron';
import { INTERNAL_CHANNELS } from '../main/shared/channels.ts';
import type { CaptureBridge, FramePayload } from './protocol.ts';

const bridge: CaptureBridge = {
  frame(session, data, width, height, timestamp) {
    const payload: FramePayload = { session, data, width, height, timestamp };
    ipcRenderer.send(INTERNAL_CHANNELS.captureFrame, payload);
  },
  status(session, kind, detail) {
    ipcRenderer.send(INTERNAL_CHANNELS.captureStatus, session, kind, detail);
  },
};

contextBridge.exposeInMainWorld('evniaCaptureBridge', bridge);
