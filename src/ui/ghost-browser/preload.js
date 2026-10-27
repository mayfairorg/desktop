'use strict';
// Preload for the Ghost investigation browser's own toolbar pages only (never the pages being investigated, which get no preload at all).
// A fixed set of calls; main re-checks the sender and every argument, and takes the case from the sender.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const sub = (ch) => (cb) => { const f = (_e, p) => { try { cb(p); } catch { /* listener failed */ } }; ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };
contextBridge.exposeInMainWorld('ghostBrowser', Object.freeze({
  launcher: Object.freeze({ open: (o) => call('gbr:launcher.open', o), cases: () => call('gbr:launcher.cases'), tor: () => call('gbr:launcher.tor') }),
  info: () => call('gbr:case.info'),
  navigate: (u) => call('gbr:case.navigate', u), back: () => call('gbr:case.back'), forward: () => call('gbr:case.forward'),
  reload: () => call('gbr:case.reload'), stop: () => call('gbr:case.stop'),
  allowHost: (h) => call('gbr:case.allowHost', h), capture: () => call('gbr:case.capture'), snapshots: () => call('gbr:case.snapshots'),
  panel: (px) => call('gbr:case.panel', px), close: () => call('gbr:case.close'),
  kill: () => call('gbr:kill'),
  onState: sub('gbr:state'), onKilled: sub('gbr:killed'),
}));
