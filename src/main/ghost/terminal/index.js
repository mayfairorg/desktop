'use strict';
// Ghost terminal: entry point used by src/main/main.js. createTerminal({electron, userData, isPackaged}) -> {show, shutdown, ...}.
const path = require('node:path');
const { TerminalService } = require('./service');
const { TermsStore } = require('./terms');
const { createTerminalWindow } = require('./window');
const { ToolHost } = require('./addtool');

function createTerminal({ electron, userData, isPackaged = true, icon, baseEnv, mode = null }) {
  const terms = new TermsStore(path.join(userData, 'ghost', 'terminal.json'));
  const service = new TerminalService({ root: userData, terms, ...(baseEnv ? { baseEnv } : {}), mode: mode || process.env.MF_GHOST_TERM_MODE || null });
  const uiDir = path.join(__dirname, '..', '..', '..', 'ui', 'ghost-terminal');
  const { dialog } = electron;
  let w = null;
  const parent = () => (w && w.getWindow()) || undefined;
  // Native dialogs for approving and removing tools: same shape as the Cloud-side Ghost service. Cancel is the default.
  const confirm = async (o) => {
    const opts = { type: o.kind === 'approve' && o.scope === 'active' ? 'warning' : 'question', title: o.title, message: o.message, detail: o.detail, buttons: [o.ok, o.cancel], defaultId: 1, cancelId: 1, noLink: true };
    const p = parent();
    const r = p ? await dialog.showMessageBox(p, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  };
  // The picker returns a path to main only; the terminal page never sees or supplies a path.
  const pick = async ({ kind }) => {
    const o = kind === 'folder' ? { title: 'Choose a tool folder', properties: ['openDirectory'] } : kind === 'zip' ? { title: 'Choose a tool .zip', properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] } : { title: 'Choose the script or program', properties: ['openFile'] };
    const p = parent();
    const r = p ? await dialog.showOpenDialog(p, o) : await dialog.showOpenDialog(o);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  };
  const tools = new ToolHost({ userData, toolsDir: service.toolsDir, confirm, pick, isPackaged, emit: (n, p) => { if (w) w.sendJob(n, p); } });
  w = createTerminalWindow({ electron, service, tools, terms, uiDir, isPackaged, icon });
  return { ...w, service, terms, tools };
}

module.exports = { createTerminal };
