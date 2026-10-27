'use strict';
// Ghost virtual computer: entry point used by src/main/main.js.
//   createGhostVm({electron, userData, getGhost, getVault, tor, releaseTor}) -> {service, runtime, library, installer, terminalBridge, appBridge, onStatus, kill, shutdown}
// service        the machine (download, start, network, reset, snapshots, terminals)       runtime  how connector jobs run inside it
// library        the tool library list (toollib.js)                                         installer  "Add a tool" (installer.js)
// terminalBridge / appBridge   the IPC handlers for the terminal window and the Ghost window (ipc.js)
const fs = require('node:fs');
const path = require('node:path');
const { VmService } = require('./service');
const { ToolRuntime } = require('./toolrun');
const { ToolLibrary } = require('./toollib');
const { VmToolInstaller } = require('./installer');
const { makeOps, bind, TERMINAL_OPS, APP_OPS } = require('./ipc');

function createGhostVm({ electron, userData, getGhost, getVault = () => null, tor = null, releaseTor = null, now = Date.now, service: svcOpts = {} }) {
  const { dialog, shell } = electron;
  const listeners = [];
  const confirm = async (o) => {
    const g = getGhost && getGhost();
    if (g && typeof g._confirm === 'function') return g._confirm(o);        // the same native dialog Ghost uses for approvals (parented to the Mayfair window)
    const r = await dialog.showMessageBox({ type: 'question', title: o.title, message: o.message, detail: o.detail, buttons: [o.ok, o.cancel], defaultId: 1, cancelId: 1, noLink: true });
    return r.response === 0;
  };
  const service = new VmService({ root: userData, vault: getVault, tor, confirm, releaseTor, notify: (_n, st) => { for (const f of listeners) { try { f(st); } catch { /* window gone */ } } }, ...svcOpts });
  const runtime = new ToolRuntime({ vm: () => service });
  const ghostDir = path.join(userData, 'ghost');
  const library = new ToolLibrary({ file: path.join(ghostDir, 'toollib.json'), now });
  const g = getGhost && getGhost();
  if (g && g.setVm) g.setVm(runtime);
  const pick = async ({ kind }) => {
    const o = kind === 'folder' ? { title: 'Choose a tool folder', properties: ['openDirectory'] } : kind === 'zip' ? { title: 'Choose a tool .zip', properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] } : { title: 'Choose the script or program', properties: ['openFile'] };
    const r = await dialog.showOpenDialog(o);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };
  const installer = new VmToolInstaller({ vm: service, manager: g.manager, library, dir: path.join(ghostDir, 'vm'), confirm, pick, now });
  const { ops } = makeOps({
    vm: service, installer, library,
    openPath: (p) => shell.openPath(p),
    saveJson: async (name, text) => { const r = await dialog.showSaveDialog({ title: 'Save the tool library list', defaultPath: name, filters: [{ name: 'JSON', extensions: ['json'] }] }); if (r.canceled || !r.filePath) return null; fs.writeFileSync(r.filePath, text); return r.filePath; },
    pickJson: async () => { const r = await dialog.showOpenDialog({ title: 'Choose a tool library list', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] }); if (r.canceled || !r.filePaths[0]) return null; const st = fs.statSync(r.filePaths[0]); if (st.size > 4 * 1024 * 1024) return '{}'; return fs.readFileSync(r.filePaths[0], 'utf8'); },
  });
  const terminalBridge = bind('gterm:vm.', TERMINAL_OPS, ops), appBridge = bind('gapp:vm.', APP_OPS, ops);

  // The kill switch also covers the virtual computer: locking the vault (which the Ghost kill switch does) stops the machine first, because
  // its disk can no longer be read once the key is gone.
  const v = getVault();
  if (v && typeof v.lock === 'function' && !v.__vmWrapped) {
    const orig = v.lock.bind(v);
    v.lock = (...a) => { try { service.kill(); } catch { /* already stopped */ } return orig(...a); };
    v.__vmWrapped = true;
  }
  return {
    service, runtime, library, installer, ops, terminalBridge, appBridge,
    onStatus: (fn) => { listeners.push(fn); },
    kill: () => service.kill(), shutdown: () => { installer.shutdown(); return service.shutdown(); },
  };
}

module.exports = { createGhostVm };
