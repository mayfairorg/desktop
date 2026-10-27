'use strict';
// Ghost terminal: the terminal's own window. Electron is handed in (not required here) so the logic stays testable.
//  - A separate BrowserWindow that loads one local file (src/ui/ghost-terminal/index.html). It is never a view inside Mayfair Cloud.
//  - Its IPC channels (gterm:*) are separate from the Browser bridge. A call is accepted only from this window's own main frame while
//    it shows that file. Any other sender (the Mayfair view, a page tab, a web app window, a frame) is refused.
//  - No network: every http(s) request from this window is cancelled, navigation and new windows are refused, permissions are denied.
//  - The first-use notice is a native dialog shown before the window exists.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, EVENTS } = require('./checks');
const { ensureAccepted, confirmLocal } = require('./terms');

const PARTITION = 'mf-ghost-term';            // not "persist:": nothing is stored

// vm / vmBridge: the Ghost virtual computer (src/main/ghost/vm/). With them, a new terminal is the virtual computer and the first-use notice (which is about the LOCAL terminal)
// is shown only when the person asks for the local one. Without them the window is the plain local terminal and shows the notice first.
function createTerminalWindow({ electron, service, tools = null, terms, uiDir, isPackaged = true, icon, vm = null, vmBridge = null }) {
  const { BrowserWindow, ipcMain, dialog, shell, session } = electron;
  const page = pathToFileURL(path.join(uiDir, 'index.html')).href;
  const preload = path.join(uiDir, 'preload.js');
  let win = null, opening = null;

  const trusted = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents && !!e.senderFrame && e.senderFrame === e.sender.mainFrame && e.senderFrame.url === page;
  const handlers = {
    'gterm:info': () => service.info(),
    'gterm:open': async (e, o) => {
      if (vm && o && o.local && !(await confirmLocal({ store: terms, dialog, parent: win, toolsDir: service.toolsDir }))) throw new Error('blocked: the notice for the local terminal was not accepted');
      return service.open(e.sender.id, o);
    },
    'gterm:localInfo': () => (service.localInfo ? service.localInfo() : service.info()),
    'gterm:input': (e, id, data) => service.input(e.sender.id, id, data),
    'gterm:resize': (e, id, c, r) => service.resize(e.sender.id, id, c, r),
    'gterm:interrupt': (e, id) => service.interrupt(e.sender.id, id),
    'gterm:close': (e, id) => service.close(e.sender.id, id),
    'gterm:ack': (e, id, n) => service.ack(e.sender.id, id, n),
    'gterm:openTools': async () => { const { ensureToolsDir } = require('./tools'); ensureToolsDir(service.toolsDir); await shell.openPath(service.toolsDir); },
  };
  if (tools) {
    const T = tools;
    Object.assign(handlers, {
      'gterm:tools.list': () => T.list(),
      'gterm:tools.addFolder': () => T.prepareFolder(),
      'gterm:tools.addZip': () => T.prepareZip(),
      'gterm:tools.addScript': (e, f) => T.prepareScript(f),
      'gterm:tools.addGithub': (e, o) => T.prepareGithub(o),
      'gterm:tools.commit': (e, t) => T.commit(t),
      'gterm:tools.cancel': (e, t) => T.cancel(t),
      'gterm:tools.approve': (e, id) => T.approve(id),
      'gterm:tools.test': (e, id) => T.test(id),
      'gterm:tools.enable': (e, id) => T.enable(id),
      'gterm:tools.disable': (e, id) => T.disable(id),
      'gterm:tools.remove': (e, id) => T.remove(id),
      'gterm:tools.run': (e, o) => T.run(o),
      'gterm:tools.job': (e, id) => T.job(id),
      'gterm:tools.cancelJob': (e, id) => T.cancelJob(id),
    });
  }
  if (vmBridge) Object.assign(handlers, vmBridge.handlers);
  let registered = false;
  function register() {
    if (registered) return; registered = true;
    for (const ch of Object.keys(handlers)) {
      ipcMain.handle(ch, async (e, ...args) => {
        if (!trusted(e)) throw new Error('blocked: untrusted sender');
        const v = check(ch, args);
        if (!v.ok) throw new Error('blocked: ' + v.reason);
        return handlers[ch](e, ...args);
      });
    }
  }
  function send(owner, name, payload) {
    if (!win || win.isDestroyed() || win.webContents.id !== owner) return;
    const ch = 'gterm:' + name;
    if (EVENTS.includes(ch)) win.webContents.send(ch, payload);
  }
  service.emit = send;
  const sendVm = (payload) => { if (win && !win.isDestroyed()) win.webContents.send('gterm:vm', payload); };
  const sendJob = (name, payload) => { if (name === 'ghost-job' && win && !win.isDestroyed()) win.webContents.send('gterm:job', payload); };

  function build() {
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_d, cb) => cb({ cancel: true }));
    const w = new BrowserWindow({
      width: 1080, height: 680, minWidth: 520, minHeight: 320, title: 'Ghost terminal', backgroundColor: '#07080a', autoHideMenuBar: true, show: false, icon,
      webPreferences: { partition: PARTITION, preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !isPackaged },
    });
    const wc = w.webContents;
    const lock = (e) => e.preventDefault();
    wc.on('will-navigate', lock); wc.on('will-redirect', lock); wc.on('will-attach-webview', lock);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // the kill switch from the keyboard (the same keys as the Ghost browser's): the virtual computer stops at once
    if (vm) wc.on('before-input-event', (e, input) => { if (input.type === 'keyDown' && input.shift && (input.control || input.meta) && input.key === 'Backspace') { e.preventDefault(); vm.kill(); } });
    const owner = wc.id;
    w.on('closed', () => { service.closeOwner(owner); if (win === w) win = null; });
    w.once('ready-to-show', () => w.show());
    w.loadURL(page);
    return w;
  }

  // Shows the notice if needed, then the window. Resolves true when the window is up.
  async function show() {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true; }
    if (opening) return opening;
    opening = (async () => {
      if (!vm) { const ok = await ensureAccepted({ store: terms, dialog, parent: null, toolsDir: service.toolsDir }); if (!ok) return false; }
      register();
      win = build();
      return true;
    })().finally(() => { opening = null; });
    return opening;
  }
  return { show, sendVm, isOpen: () => !!win && !win.isDestroyed(), close: () => { if (win && !win.isDestroyed()) win.close(); }, shutdown: () => { service.shutdown(); if (tools) tools.shutdown(); }, sendJob, getWindow: () => (win && !win.isDestroyed() ? win : null), page, handlers, trusted };
}

module.exports = { createTerminalWindow, PARTITION };
