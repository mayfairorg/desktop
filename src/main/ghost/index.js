'use strict';
// Mayfair Ghost: the service the Browser bridge talks to (group `ghost`). It wires ConnectorManager, JobRunner, the log and the
// file picker together. There is deliberately no call here that takes a command, an argv, a path or an environment from the page:
// the page names a registered connector and gives input values; everything else comes from the approved manifest.
const fs = require('node:fs');
const path = require('node:path');
const { ConnectorManager } = require('./manager');
const { JobRunner } = require('./runner');
const { GhostLog } = require('./logger');
const { PickStore } = require('./picks');
const { FUSES } = require('../lib/protect');
const { VaultService } = require('./vault/service');
const { createUtilityRunner } = require('./node-runner/adapter');

class GhostService {
  // root: the userData folder. dialog: Electron's dialog. getWindow(): the parent window for native dialogs. emit(name, payload): bridge events.
  constructor({ root, dialog, getWindow = () => null, emit = () => {}, nodePath = process.execPath, isPackaged = true, samplesDir, safeStorage = null, useVault = false, files = null, vaultOptions = {}, utilityProcess = null, vm = null }) {
    this.dialog = dialog; this.getWindow = getWindow; this.isPackaged = isPackaged;
    this.ghostDir = path.join(root, 'ghost');
    // With the vault on (the app), connector state, job history, the audit trail and the scan log are sealed at rest. Without it (tests) they are plain files as before.
    this.vaultSvc = useVault ? new VaultService({ root, safeStorage, dialog, getWindow, files, vaultOptions, onUnlock: () => { try { this.vaultSvc.migratePlain(); this.manager.reloadState(); } catch { /* shown by status */ } } }) : null;
    if (this.vaultSvc) this.vaultSvc.migratePlain();
    const vio = this.vaultSvc ? this.vaultSvc.io : {};
    this.log = new GhostLog(path.join(this.ghostDir, 'logs'), { io: vio.logs || null });
    this.picks = new PickStore();
    const nodeAvailable = !isPackaged || FUSES.RunAsNode === true;
    // fuse off (installed build): '@node' connectors run in an Electron utilityProcess through the node-runner adapter
    this.utility = nodeAvailable ? null : createUtilityRunner({ utilityProcess });
    this.manager = new ConnectorManager({ root, io: vio.state || null, nodePath, nodeAvailable, utility: this.utility, vm, log: this.log, confirm: (o) => this._confirm(o), ...(samplesDir ? { samplesDir } : {}) });
    this.runner = new JobRunner({ manager: this.manager, log: this.log, ghostDir: this.ghostDir, picks: this.picks, utility: this.utility, vm, emit, io: vio.jobs || null });
    this.manager.setRunner(this.runner);
    this.confirmOverride = null;
  }
  async _confirm(o) {
    if (this.confirmOverride) return this.confirmOverride(o) === true;
    const win = this.getWindow();
    const opts = { type: o.kind === 'approve' && o.scope === 'active' ? 'warning' : 'question', title: o.title, message: o.message, detail: o.detail, buttons: [o.ok, o.cancel], defaultId: 1, cancelId: 1, noLink: true };
    const r = win && !win.isDestroyed() ? await this.dialog.showMessageBox(win, opts) : await this.dialog.showMessageBox(opts);
    return r.response === 0;
  }
  // For the smoke test only: stands in for the user clicking the native dialog. Refused in an installed app.
  useTestConfirm(fn) {
    if (this.isPackaged || !process.env.MF_SMOKE) throw new Error('test hook is not available');
    this.confirmOverride = fn;
  }
  async pickFile() {
    const win = this.getWindow();
    const o = { title: 'Choose a file', properties: ['openFile'] };
    const r = win && !win.isDestroyed() ? await this.dialog.showOpenDialog(win, o) : await this.dialog.showOpenDialog(o);
    if (r.canceled || !r.filePaths[0]) return null;
    let st;
    try { st = fs.statSync(r.filePaths[0]); } catch { return null; }
    if (!st.isFile()) return null;
    return { token: this.picks.add(r.filePaths[0], st.size), name: path.basename(r.filePaths[0]), size: st.size };
  }
  // The virtual computer's connector runtime (src/main/ghost/vm/toolrun.js): connectors with a ghost-vm.json marker run inside it, never on this computer.
  setVm(vm) { this.vm = vm; this.manager.vm = vm; this.runner.vm = vm; }
  shutdown() { this.runner.shutdown(); if (this.vaultSvc) this.vaultSvc.shutdown(); }

  // The bridge: one entry per allowlisted call (src/main/lib/ipc-allowlist.js, GH). Argument shapes are checked there first.
  api() {
    if (this._api) return this._api;
    const m = this.manager, r = this.runner;
    return (this._api = {
      ...(this.vaultSvc ? this.vaultSvc.api() : {}),
      'ghost.connectors.list': () => m.list(),
      'ghost.connectors.get': (id) => m.get(id),
      'ghost.connectors.validate': (id) => m.validate(id),
      'ghost.connectors.test': (id, scope) => m.test(id, scope),
      'ghost.connectors.requestApproval': (id) => m.requestApproval(id),
      'ghost.connectors.enable': (id) => m.enable(id),
      'ghost.connectors.disable': (id) => m.disable(id),
      'ghost.connectors.remove': (id) => m.remove(id),
      'ghost.connectors.installSample': () => m.installSample(),
      'ghost.jobs.run': (o) => r.submit({ connector: o.connector, input: o.input, scope: o.scope }),
      'ghost.jobs.cancel': (id) => r.cancel(id),
      'ghost.jobs.list': (o) => r.list(o || {}),
      'ghost.jobs.get': (id) => r.get(id),
      'ghost.logs.tail': (o) => this.log.tail(o || {}),
      'ghost.pickFile': () => this.pickFile(),
    });
  }
}
module.exports = { GhostService };
