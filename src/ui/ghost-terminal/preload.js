'use strict';
// Preload for the Ghost terminal window only. It exposes a fixed set of calls to the window's own page; main re-checks the sender and every argument.
// There is no call that takes a command: text reaches the shell only through input(), which the page sends from key presses and pastes.
const { contextBridge, ipcRenderer } = require('electron');
const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const sub = (ch) => (cb) => { const f = (_e, p) => { try { cb(p); } catch { /* listener failed */ } }; ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };
contextBridge.exposeInMainWorld('ghostTerm', Object.freeze({
  info: () => call('gterm:info'),
  open: (cols, rows, local) => call('gterm:open', local ? { cols, rows, local: true } : { cols, rows }),
  localInfo: () => call('gterm:localInfo'),
  input: (id, data) => call('gterm:input', id, data),
  resize: (id, cols, rows) => call('gterm:resize', id, cols, rows),
  interrupt: (id) => call('gterm:interrupt', id),
  close: (id) => call('gterm:close', id),
  ack: (id, n) => call('gterm:ack', id, n),
  openTools: () => call('gterm:openTools'),
  onData: sub('gterm:data'), onExit: sub('gterm:exit'), onJob: sub('gterm:job'), onVm: sub('gterm:vm'),
  // the virtual computer (every call is checked again in main; none takes a command or a path)
  vm: Object.freeze({
    status: () => call('gterm:vm.status'), install: () => call('gterm:vm.install'), cancelInstall: () => call('gterm:vm.cancelInstall'),
    start: (o) => call('gterm:vm.start', o || {}), stop: () => call('gterm:vm.stop'), kill: () => call('gterm:vm.kill'),
    useCase: (o) => call('gterm:vm.useCase', o), network: (o) => call('gterm:vm.network', o), reset: () => call('gterm:vm.reset'),
    snapshots: () => call('gterm:vm.snapshots'), snapshot: (n) => call('gterm:vm.snapshot', n), restore: (n) => call('gterm:vm.restore', n), deleteSnapshot: (n) => call('gterm:vm.deleteSnapshot', n),
    resources: (o) => call('gterm:vm.resources', o), openShare: () => call('gterm:vm.openShare'), wipeTools: () => call('gterm:vm.wipeTools'), log: () => call('gterm:vm.log'),
    gh: Object.freeze({ clone: (o) => call('gterm:vm.gh.clone', o), show: (o) => call('gterm:vm.gh.show', o) }),
  }),
  tools: Object.freeze({
    list: () => call('gterm:tools.list'),
    addFolder: () => call('gterm:tools.addFolder'), addZip: () => call('gterm:tools.addZip'),
    addScript: (form) => call('gterm:tools.addScript', form), addGithub: (o) => call('gterm:tools.addGithub', o),
    commit: (t) => call('gterm:tools.commit', t), cancel: (t) => call('gterm:tools.cancel', t),
    approve: (id) => call('gterm:tools.approve', id), test: (id) => call('gterm:tools.test', id),
    enable: (id) => call('gterm:tools.enable', id), disable: (id) => call('gterm:tools.disable', id), remove: (id) => call('gterm:tools.remove', id),
    run: (o) => call('gterm:tools.run', o), job: (id) => call('gterm:tools.job', id), cancelJob: (id) => call('gterm:tools.cancelJob', id),
  }),
}));
