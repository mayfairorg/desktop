'use strict';
// Preload for the Ghost app window only. It exposes a fixed set of calls to the window's own page; main re-checks the sender and every argument.
// There is no call that takes a command, an argument list or a path: the page names a connector and gives input values, nothing else.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const sub = (ch) => (cb) => { const f = (_e, p) => { try { cb(p); } catch { /* listener failed */ } }; ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };
contextBridge.exposeInMainWorld('ghostApp', Object.freeze({
  status: () => call('gapp:status'), install: () => call('gapp:install'), uninstall: () => call('gapp:uninstall'),
  signIn: Object.freeze({ start: () => call('gapp:signin.start'), open: () => call('gapp:signin.open'), cancel: () => call('gapp:signin.cancel'), out: () => call('gapp:signout') }),
  entitlement: Object.freeze({ check: () => call('gapp:entitlement.check'), apply: () => call('gapp:openApply') }),
  terms: Object.freeze({ get: () => call('gapp:terms.get'), accept: (o) => call('gapp:terms.accept', o) }),
  vault: Object.freeze({ unlock: (o) => call('gapp:vault.unlock', o) }),
  cases: Object.freeze({ list: () => call('gapp:cases.list'), get: (id) => call('gapp:cases.get', id), put: (id, json) => call('gapp:cases.put', id, json), create: (title) => call('gapp:cases.create', title), delete: (id) => call('gapp:cases.delete', id), backups: (id) => call('gapp:cases.backups', id), restore: (id, name) => call('gapp:cases.restore', id, name) }),
  connectors: Object.freeze({ list: () => call('gapp:connectors.list'), get: (id) => call('gapp:connectors.get', id), requestApproval: (id) => call('gapp:connectors.requestApproval', id), test: (id) => call('gapp:connectors.test', id), enable: (id) => call('gapp:connectors.enable', id), disable: (id) => call('gapp:connectors.disable', id) }),
  jobs: Object.freeze({ run: (o) => call('gapp:jobs.run', o), get: (id) => call('gapp:jobs.get', id), cancel: (id) => call('gapp:jobs.cancel', id) }),
  pickFile: () => call('gapp:pickFile'),
  scope: Object.freeze({ declare: (o) => call('gapp:scope.declare', o), revoke: (id) => call('gapp:scope.revoke', id), active: () => call('gapp:scope.active'), log: (n) => call('gapp:scope.log', n), run: (o) => call('gapp:scan.run', o) }),
  report: Object.freeze({ save: (o) => call('gapp:report.save', o) }),
  terminal: Object.freeze({ open: () => call('gapp:terminal.open') }),
  toolIntegrations: Object.freeze({ open: () => call('gapp:tools.open') }),
  window: Object.freeze({ fullscreen: (on) => call('gapp:window.fullscreen', !!on), close: () => call('gapp:window.close') }),
  onStatus: sub('gapp:status'), onInstall: sub('gapp:install'), onJob: sub('gapp:job'), onWindow: sub('gapp:window'),
}));
