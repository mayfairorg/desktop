'use strict';
// Preload for the Ghost app window only. It exposes a fixed set of calls to the window's own page; main re-checks the sender and every argument.
// There is no call that takes a command, an argument list or a path: the page names a connector and gives input values, nothing else.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const sub = (ch) => (cb) => { const f = (_e, p) => { try { cb(p); } catch { /* listener failed */ } }; ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };
const Z = (op) => () => call('gapp:vm.' + op), O = (op) => (a) => call('gapp:vm.' + op, a);      // the virtual computer's calls (src/main/ghost/vm/ipc.js)
contextBridge.exposeInMainWorld('ghostApp', Object.freeze({
  status: () => call('gapp:status'), install: () => call('gapp:install'), uninstall: () => call('gapp:uninstall'),
  signIn: Object.freeze({ start: () => call('gapp:signin.start'), open: () => call('gapp:signin.open'), cancel: () => call('gapp:signin.cancel'), out: () => call('gapp:signout') }),
  entitlement: Object.freeze({ check: () => call('gapp:entitlement.check'), apply: () => call('gapp:openApply') }),
  terms: Object.freeze({ get: () => call('gapp:terms.get'), accept: (o) => call('gapp:terms.accept', o) }),
  vault: Object.freeze({ unlock: (o) => call('gapp:vault.unlock', o) }),
  cases: Object.freeze({ list: () => call('gapp:cases.list'), get: (id) => call('gapp:cases.get', id), put: (id, json) => call('gapp:cases.put', id, json), create: (title) => call('gapp:cases.create', title), delete: (id) => call('gapp:cases.delete', id), backups: (id) => call('gapp:cases.backups', id), restore: (id, name) => call('gapp:cases.restore', id, name), exportJson: (json) => call('gapp:cases.exportJson', json), importPick: () => call('gapp:cases.importPick') }),
  prefs: Object.freeze({ get: () => call('gapp:prefs.get'), set: (o) => call('gapp:prefs.set', o) }),
  connectors: Object.freeze({ list: () => call('gapp:connectors.list'), get: (id) => call('gapp:connectors.get', id), requestApproval: (id) => call('gapp:connectors.requestApproval', id), test: (id) => call('gapp:connectors.test', id), enable: (id) => call('gapp:connectors.enable', id), disable: (id) => call('gapp:connectors.disable', id) }),
  jobs: Object.freeze({ run: (o) => call('gapp:jobs.run', o), get: (id) => call('gapp:jobs.get', id), cancel: (id) => call('gapp:jobs.cancel', id) }),
  pickFile: () => call('gapp:pickFile'),
  builtins: Object.freeze({ status: () => call('gapp:builtins.status') }),
  search: Object.freeze({ classify: (o) => call('gapp:search.classify', o), run: (o) => call('gapp:search.run', o), cancel: (o) => call('gapp:search.cancel', o) }),
  scope: Object.freeze({ declare: (o) => call('gapp:scope.declare', o), revoke: (id) => call('gapp:scope.revoke', id), active: () => call('gapp:scope.active'), log: (n) => call('gapp:scope.log', n), run: (o) => call('gapp:scan.run', o) }),
  report: Object.freeze({ save: (o) => call('gapp:report.save', o) }),
  terminal: Object.freeze({ open: (o) => call('gapp:terminal.open', o || {}) }),
  vm: Object.freeze({
    status: Z('status'), install: Z('install'), cancelInstall: Z('cancelInstall'), start: O('start'), network: O('network'), kill: Z('kill'),
    tools: Object.freeze({ list: Z('tools.list'), verify: Z('tools.verify'), prepareGithub: O('tools.prepareGithub'), prepareUpload: O('tools.prepareUpload'), cancel: O('tools.cancel'), commit: O('tools.commit'), setupOptions: O('tools.setupOptions'), runSetup: O('tools.runSetup'), setupRun: O('tools.setupRun'), cancelSetup: O('tools.cancelSetup'), previewConnector: O('tools.previewConnector'), register: O('tools.register'), unregister: O('tools.unregister'), prepareUpdate: O('tools.prepareUpdate'), applyUpdate: O('tools.applyUpdate'), remove: O('tools.remove') }),
    library: Object.freeze({ list: Z('library.list'), exportFile: Z('library.exportFile'), importFile: Z('library.importFile'), importStatus: Z('library.importStatus') }),
  }),
  toolIntegrations: Object.freeze({ open: () => call('gapp:tools.open') }),
  window: Object.freeze({ fullscreen: (on) => call('gapp:window.fullscreen', !!on), close: () => call('gapp:window.close') }),
  notes: Object.freeze({
    get: (s) => call('gqn:get', s), put: (s, json) => call('gqn:put', s, json),
    blob: Object.freeze({ put: (s, bytes) => call('gqn:blob.put', s, bytes), get: (s, id) => call('gqn:blob.get', s, id), save: (s, id, name) => call('gqn:blob.save', s, id, name) }),
    cases: () => call('gqn:cases'), clipboard: (s) => call('gqn:clipboard', s), hint: () => call('gqn:hint'), copied: (o) => call('gqn:copied', o),
    capture: Object.freeze({ browser: (s, c) => call('gqn:capture.browser', s, c), sources: () => call('gqn:capture.sources'), take: (s, id) => call('gqn:capture.take', s, id) }),
    popout: Object.freeze({ open: (o) => call('gqn:popout.open', o), close: () => call('gqn:popout.close'), info: () => call('gqn:popout.info'), top: (on) => call('gqn:popout.top', !!on) }),
    send: (p) => call('gqn:send', p), sent: (p) => call('gqn:sent', p),
    onPopped: sub('gqn:popped'), onSend: sub('gqn:send'), onSent: sub('gqn:sent'),
  }),
  onStatus: sub('gapp:status'), onInstall: sub('gapp:install'), onJob: sub('gapp:job'), onWindow: sub('gapp:window'), onBuiltins: sub('gapp:builtins'), onSearch: sub('gapp:search'),
}));
