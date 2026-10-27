'use strict';
// Preload for the Quick notes pop-out window only. A fixed set of calls, no path, no command, no URL. Main re-checks the sender and every argument.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const sub = (ch) => (cb) => { const f = (_e, p) => { try { cb(p); } catch { /* listener failed */ } }; ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };
contextBridge.exposeInMainWorld('ghostApp', Object.freeze({
  notes: Object.freeze({
    get: (s) => call('gqn:get', s), put: (s, json) => call('gqn:put', s, json),
    blob: Object.freeze({ put: (s, bytes) => call('gqn:blob.put', s, bytes), get: (s, id) => call('gqn:blob.get', s, id), save: (s, id, name) => call('gqn:blob.save', s, id, name) }),
    cases: () => call('gqn:cases'), clipboard: (s) => call('gqn:clipboard', s), hint: () => call('gqn:hint'),
    capture: Object.freeze({ browser: (s, c) => call('gqn:capture.browser', s, c), sources: () => call('gqn:capture.sources'), take: (s, id) => call('gqn:capture.take', s, id) }),
    popout: Object.freeze({ open: (o) => call('gqn:popout.open', o), close: () => call('gqn:popout.close'), info: () => call('gqn:popout.info'), top: (on) => call('gqn:popout.top', !!on) }),
    send: (p) => call('gqn:send', p), onSent: sub('gqn:sent'),
  }),
}));
