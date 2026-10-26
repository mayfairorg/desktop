'use strict';
// Preload for the app's own UI (tab strip, toolbar, panels). Sandboxed: only electron is required.
const { contextBridge, ipcRenderer } = require('electron');

const allow = ipcRenderer.sendSync('ipc:allow') || { invoke: [], events: [] };
const invokeOk = new Set(allow.invoke);
const eventOk = new Set(allow.events);

contextBridge.exposeInMainWorld('mf', {
  invoke(channel, ...args) {
    if (!invokeOk.has(channel)) return Promise.reject(new Error('blocked channel: ' + channel));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel, cb) {
    if (!eventOk.has(channel) || typeof cb !== 'function') return () => {};
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
