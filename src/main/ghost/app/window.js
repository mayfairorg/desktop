'use strict';
// Ghost app: its own window. Electron is handed in so the logic stays testable.
//  - A separate BrowserWindow that loads one local file (src/ui/ghost/index.html). It is never a view inside Mayfair Cloud.
//  - Opens maximised by default and can go full screen (F11 or the button). The window has the system frame, so it can always be closed or minimised.
//  - Its IPC channels (gapp:*) are separate from the Browser bridge. A call is accepted only from this window's own main frame while it shows that file.
//  - No network: every http(s) request from this window is cancelled, navigation and new windows are refused, permissions are denied.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, EVENTS } = require('./checks');
const { fail } = require('./service');

const PARTITION = 'mf-ghost-app';           // not "persist:": nothing is stored by the page

function createGhostWindow({ electron, app, uiDir, isPackaged = true, icon, maximize = true }) {
  const { BrowserWindow, ipcMain, shell, session } = electron;
  const page = pathToFileURL(path.join(uiDir, 'index.html')).href;
  const preload = path.join(uiDir, 'preload.js');
  let win = null;
  const trusted = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents && !!e.senderFrame && e.senderFrame === e.sender.mainFrame && e.senderFrame.url.split('#')[0] === page;      // the page routes with #fragments; nothing else may differ
  const wrap = async (fn) => {
    try {
      const r = await fn();
      if (r && typeof r === 'object' && !Array.isArray(r) && 'ok' in r) return r.ok === false && r.message ? { ok: false, code: r.error || 'error', error: r.message } : r;     // the runner answers { ok:false, error:<code>, message }
      return { ok: true, data: r === undefined ? null : r };
    }
    catch (e) { return fail(e); }
  };
  const A = app;
  const handlers = {
    'gapp:status': () => A.status(),
    'gapp:install': () => A.install(),
    'gapp:uninstall': () => A.uninstall(),
    'gapp:signin.start': () => A.signInStart(),
    'gapp:signin.open': () => ({ ok: A.openSignInPage() }),
    'gapp:signin.cancel': () => { A.cancelSignin(); return A.status(); },
    'gapp:signout': () => A.signOut(),
    'gapp:entitlement.check': () => A.checkEntitlement(),
    'gapp:openApply': () => A.openApply(),
    'gapp:terms.get': () => A.termsGet(),
    'gapp:terms.accept': (e, o) => A.termsAccept(o),
    'gapp:vault.unlock': (e, o) => A.vaultUnlock(o),
    'gapp:cases.list': () => A.casesList(), 'gapp:cases.get': (e, id) => A.caseGet(id), 'gapp:cases.put': (e, id, j) => A.casePut(id, j), 'gapp:cases.create': (e, t) => A.caseCreate(t),
    'gapp:cases.delete': (e, id) => A.caseDelete(id), 'gapp:cases.backups': (e, id) => A.caseBackups(id), 'gapp:cases.restore': (e, id, n) => A.caseRestore(id, n),
    'gapp:connectors.list': () => A.connectorsList(), 'gapp:connectors.get': (e, id) => A.connectorGet(id),
    'gapp:connectors.requestApproval': (e, id) => A.connectorAction('requestApproval', id), 'gapp:connectors.test': (e, id) => A.connectorAction('test', id),
    'gapp:connectors.enable': (e, id) => A.connectorAction('enable', id), 'gapp:connectors.disable': (e, id) => A.connectorAction('disable', id),
    'gapp:jobs.run': (e, o) => A.jobRun(o), 'gapp:jobs.get': (e, id) => A.jobGet(id), 'gapp:jobs.cancel': (e, id) => A.jobCancel(id), 'gapp:pickFile': () => A.pickFile(),
    'gapp:scope.declare': (e, o) => A.scopeDeclare(o), 'gapp:scope.revoke': (e, id) => A.scopeRevoke(id), 'gapp:scope.active': () => A.scopeActive(), 'gapp:scope.log': (e, n) => A.scopeLog(n),
    'gapp:scan.run': (e, o) => A.scanRun(o),
    'gapp:report.save': (e, o) => A.reportSave(o),
    'gapp:terminal.open': () => A.terminalOpen(), 'gapp:tools.open': () => A.toolPage(),
    'gapp:window.fullscreen': (e, on) => { if (win && !win.isDestroyed()) win.setFullScreen(on); return { ok: true }; },
    'gapp:window.close': () => { if (win && !win.isDestroyed()) win.close(); return { ok: true }; },
  };
  let registered = false;
  function register() {
    if (registered) return; registered = true;
    for (const ch of Object.keys(handlers)) {
      ipcMain.handle(ch, async (e, ...args) => {
        if (!trusted(e)) throw new Error('blocked: untrusted sender');
        const v = check(ch, args);
        if (!v.ok) throw new Error('blocked: ' + v.reason);
        return wrap(() => handlers[ch](e, ...args));
      });
    }
  }
  function send(name, payload) { const ch = 'gapp:' + name; if (win && !win.isDestroyed() && EVENTS.includes(ch)) win.webContents.send(ch, payload); }
  A.emit = send;

  function build() {
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_d, cb) => cb({ cancel: true }));
    const w = new BrowserWindow({
      width: 1280, height: 820, minWidth: 360, minHeight: 480, title: 'Mayfair Ghost', backgroundColor: '#0a0a0a', autoHideMenuBar: true, show: false, icon,
      webPreferences: { partition: PARTITION, preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !isPackaged },
    });
    const wc = w.webContents;
    const lock = (e) => e.preventDefault();
    wc.on('will-navigate', lock); wc.on('will-redirect', lock); wc.on('will-attach-webview', lock);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.on('enter-full-screen', () => send('window', { fullscreen: true }));
    w.on('leave-full-screen', () => send('window', { fullscreen: false }));
    w.on('closed', () => { if (win === w) win = null; });
    w.once('ready-to-show', () => { if (maximize) w.maximize(); w.show(); });
    w.loadURL(page);
    return w;
  }
  function show() {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true; }
    register(); win = build(); return true;
  }
  return { show, isOpen: () => !!win && !win.isDestroyed(), close: () => { if (win && !win.isDestroyed()) win.close(); }, sendJob: (n, p) => { if (n === 'ghost-job') send('job', p); }, getWindow: () => (win && !win.isDestroyed() ? win : null), page, handlers, trusted, send };
}
module.exports = { createGhostWindow, PARTITION };
