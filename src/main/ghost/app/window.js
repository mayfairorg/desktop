'use strict';
// Ghost app: shown INSIDE the Mayfair Desktop main window. Electron is handed in so the logic stays testable.
//  - Embedded (normal): one WebContentsView added to the main window's content view, above the Mayfair view, in the app area Mayfair Cloud reports
//    (browser.ghost.app.bounds). Until Cloud reports an area it fills the whole content area. No title bar of its own, no second set of bars.
//    Closing it hides the view and keeps the page alive (case state is not lost); release() (Remove, main window closed, quit) destroys it.
//  - Fallback: a separate BrowserWindow, used ONLY when the main window does not exist yet (for example --ghost at start-up).
//  - Its IPC channels (gapp:*) are separate from the Browser bridge. A call is accepted only from this view's own webContents (its main frame, showing that file).
//  - No network: every http(s) request from this page is cancelled, navigation and new windows are refused, permissions are denied.
//  - The terminal and the investigation browser stay separate windows (not part of this file).
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, EVENTS } = require('./checks');
const { fail } = require('./service');
const { isDevToolsKey } = require('../../lib/protect');

const PARTITION = 'mf-ghost-app';           // not "persist:": nothing is stored by the page
const RELOAD = (i) => i && i.type === 'keyDown' && (i.key === 'F5' || ((i.control || i.meta) && String(i.key).toLowerCase() === 'r'));   // F5, Ctrl/Cmd+R, Ctrl/Cmd+Shift+R

function createGhostWindow({ electron, app, uiDir, isPackaged = true, icon, maximize = true, getMainWindow = () => null, getZoom = () => 1, onChange = () => {}, hasHost = () => false }) {
  const { BrowserWindow, WebContentsView, ipcMain, session } = electron;
  const page = pathToFileURL(path.join(uiDir, 'index.html')).href;
  const preload = path.join(uiDir, 'preload.js');
  let view = null;                       // embedded: the WebContentsView in the main window
  let win = null;                        // fallback only: a separate BrowserWindow
  let main = null, mainOff = null;       // the main window the view lives in, and the function that removes our listeners from it
  const st = { shown: false, full: false, wasFs: false, host: null, occluded: false, shot: '', grace: false };
  let graceTimer = null;
  const live = (o) => !!o && !o.isDestroyed();
  const wcOf = () => (live(view && view.webContents) ? view.webContents : win && !win.isDestroyed() ? win.webContents : null);
  const trusted = (e) => { const wc = wcOf(); return !!wc && e.sender === wc && !!e.senderFrame && e.senderFrame === e.sender.mainFrame && e.senderFrame.url.split('#')[0] === page; };      // the page routes with #fragments; nothing else may differ
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
    'gapp:prefs.get': () => A.prefsGet(), 'gapp:prefs.set': (e, o) => A.prefsSet(o),
    'gapp:connectors.list': () => A.connectorsList(), 'gapp:connectors.get': (e, id) => A.connectorGet(id),
    'gapp:connectors.requestApproval': (e, id) => A.connectorAction('requestApproval', id), 'gapp:connectors.test': (e, id) => A.connectorAction('test', id),
    'gapp:connectors.enable': (e, id) => A.connectorAction('enable', id), 'gapp:connectors.disable': (e, id) => A.connectorAction('disable', id),
    'gapp:jobs.run': (e, o) => A.jobRun(o), 'gapp:jobs.get': (e, id) => A.jobGet(id), 'gapp:jobs.cancel': (e, id) => A.jobCancel(id), 'gapp:pickFile': () => A.pickFile(),
    'gapp:scope.declare': (e, o) => A.scopeDeclare(o), 'gapp:scope.revoke': (e, id) => A.scopeRevoke(id), 'gapp:scope.active': () => A.scopeActive(), 'gapp:scope.log': (e, n) => A.scopeLog(n),
    'gapp:scan.run': (e, o) => A.scanRun(o),
    'gapp:report.save': (e, o) => A.reportSave(o),
    'gapp:cases.exportJson': (e, j) => A.caseExportJson(j), 'gapp:cases.importPick': () => A.caseImportPick(),
    'gapp:terminal.open': (e, o) => A.terminalOpen(o), 'gapp:tools.open': () => A.toolPage(),
    'gapp:window.fullscreen': (e, on) => { setFull(!!on); return { ok: true }; },
    'gapp:window.close': () => { hide(); return { ok: true }; },
  };
  if (A.vmBridge) Object.assign(handlers, A.vmBridge.handlers);       // the virtual computer's calls for "Add a tool"
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
  function send(name, payload) { const ch = 'gapp:' + name; const wc = wcOf(); if (wc && EVENTS.includes(ch)) wc.send(ch, payload); }
  A.emit = send;

  // ---- the same hardening for the view and for the fallback window ----
  const webPrefs = () => ({ partition: PARTITION, preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !isPackaged });
  function harden(wc) {
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_d, cb) => cb({ cancel: true }));
    const lock = (e) => e.preventDefault();
    wc.on('will-navigate', lock); wc.on('will-redirect', lock); wc.on('will-attach-webview', lock);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Inside Mayfair the page is not reloaded by a key (that would drop an open case board): Ctrl+R, F5 and Ctrl+Shift+R do nothing here, and nothing reaches Mayfair's own shortcuts.
    wc.on('before-input-event', (e, input) => { if (RELOAD(input) || (isPackaged && isDevToolsKey(input))) e.preventDefault(); });
  }

  // ---- layout of the embedded view ----
  const mainLive = () => (live(main) ? main : null);
  function layout() {
    const m = mainLive(); if (!view || !m) return;
    const { width: cw, height: ch } = m.getContentBounds();
    const waiting = !st.host && st.grace;                                         // Mayfair Cloud was told to open Ghost and has not placed it yet
    let r = { x: 0, y: 0, width: cw, height: ch }, vis = st.shown && !st.occluded && !waiting;
    if (st.host && !st.full) {
      const z = Number(getZoom()) || 1, b = st.host;
      const x = Math.max(0, Math.min(cw, Math.round(b.x * z))), y = Math.max(0, Math.min(ch, Math.round(b.y * z)));
      r = { x, y, width: Math.max(0, Math.min(cw - x, Math.round(b.w * z))), height: Math.max(0, Math.min(ch - y, Math.round(b.h * z))) };
      vis = vis && b.visible !== false;
    }
    if (r.width < 1 || r.height < 1) vis = false;
    try { view.setBounds(r); view.setVisible(vis); } catch { /* gone */ }
  }
  function relayout() { layout(); for (const ms of [50, 300]) { const t = setTimeout(layout, ms); if (t.unref) t.unref(); } }       // after maximize, restore and show the window system settles a moment later
  function snapshot() { const m = mainLive(); return { open: !!view, shown: !!view && st.shown, fullscreen: st.full, placed: !!st.host, embedded: !!view, fallback: !!win && !win.isDestroyed(), main: !!m }; }
  const changed = (extra) => { try { onChange({ ...snapshot(), ...(extra || {}) }); } catch { /* listener failed */ } };

  function buildView(m) {
    const v = new WebContentsView({ webPreferences: webPrefs() });
    try { v.setBackgroundColor('#0a0a0a'); } catch { /* older Electron */ }
    const wc = v.webContents;
    harden(wc);
    v.setVisible(false);
    m.contentView.addChildView(v);
    const onMain = () => { if (st.full && !m.isFullScreen()) { st.full = false; send('window', { fullscreen: false }); } relayout(); };
    const evs = ['resize', 'resized', 'maximize', 'unmaximize', 'restore', 'show', 'enter-full-screen', 'leave-full-screen', 'moved'];
    for (const ev of evs) m.on(ev, onMain);
    const onFocus = () => { if (view && st.shown && view.getVisible && view.getVisible() && live(wc)) wc.focus(); };
    m.on('focus', onFocus);
    const onClosed = () => release();
    m.once('closed', onClosed);
    mainOff = () => { for (const ev of evs) { try { m.removeListener(ev, onMain); } catch { /* gone */ } } try { m.removeListener('focus', onFocus); m.removeListener('closed', onClosed); } catch { /* gone */ } };
    wc.on('render-process-gone', () => { if (live(wc)) wc.loadURL(page).catch(() => {}); });
    wc.loadURL(page).catch(() => {});
    main = m; view = v;
    return v;
  }
  function buildWindow() {
    const w = new BrowserWindow({
      width: 1280, height: 820, minWidth: 360, minHeight: 480, title: 'Mayfair Ghost', backgroundColor: '#0a0a0a', autoHideMenuBar: true, show: false, icon,
      webPreferences: webPrefs(),
    });
    harden(w.webContents);
    w.on('enter-full-screen', () => send('window', { fullscreen: true }));
    w.on('leave-full-screen', () => send('window', { fullscreen: false }));
    w.on('closed', () => { if (win === w) win = null; changed(); });
    w.once('ready-to-show', () => { if (maximize) w.maximize(); w.show(); });
    w.loadURL(page);
    return w;
  }

  // ---- what Mayfair (menu, tray, App Library, Cloud window) asks for ----
  function show() {
    register();
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return true; }       // fallback window already there
    const m = mainLive() || (getMainWindow() && !getMainWindow().isDestroyed() ? getMainWindow() : null);
    if (!m) { win = buildWindow(); changed(); return true; }                 // no main window yet: the old separate window, only for this case
    if (m.isMinimized()) m.restore(); m.show(); m.focus();
    if (!view) buildView(m); else m.contentView.addChildView(view);          // raised above the Mayfair view and any Browser tab views
    st.shown = true;
    clearTimeout(graceTimer); st.grace = false;
    if (!st.host && hasHost()) { st.grace = true; graceTimer = setTimeout(() => { st.grace = false; layout(); }, 1500); if (graceTimer.unref) graceTimer.unref(); }   // Cloud has a Ghost window to open: wait for its area instead of flashing full size
    layout();
    const wc = view.webContents; if (live(wc) && !st.grace) wc.focus();
    changed({ focus: true });
    return true;
  }
  function hide() {                                                           // closing the app window or the page's own close: keep the page alive, forget the area
    if (win && !win.isDestroyed()) { win.close(); return true; }
    if (!view) return false;
    if (st.full) setFull(false);
    st.shown = false; st.host = null; st.occluded = false; st.grace = false; clearTimeout(graceTimer);
    layout(); changed();
    return true;
  }
  function release() {                                                        // Remove, the main window closing and quit: the page is destroyed
    clearTimeout(graceTimer);
    if (mainOff) { mainOff(); mainOff = null; }
    const v = view, m = main; view = null; main = null; st.shown = false; st.host = null; st.full = false; st.occluded = false; st.grace = false;
    if (v) { try { if (live(m)) m.contentView.removeChildView(v); } catch { /* gone */ } try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { /* gone */ } }
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    changed();
    return true;
  }
  function setFull(on) {
    if (win && !win.isDestroyed()) { win.setFullScreen(on); return; }
    const m = mainLive(); if (!view || !m || st.full === on) return;
    if (on) { st.wasFs = m.isFullScreen(); st.full = true; if (!st.wasFs) m.setFullScreen(true); }
    else { st.full = false; if (!st.wasFs && m.isFullScreen()) m.setFullScreen(false); }
    send('window', { fullscreen: st.full }); relayout();
  }
  // Mayfair Cloud's Ghost window reports where the app area is (CSS pixels of the Mayfair view), like a Browser tab does.
  function setBounds(b) {
    if (!view) return false;
    st.host = { x: b.x, y: b.y, w: b.w, h: b.h, visible: b.visible !== false };
    st.grace = false; clearTimeout(graceTimer);
    layout(); changed();
    return true;
  }
  async function setOccluded(on, o) {
    if (!view) return { captured: false };
    on = !!on;
    if (on && !st.occluded && st.shown && !(o && o.capture === false)) await capture(true);
    st.occluded = on; layout();
    if (!on && o && o.focus) { const wc = view && view.webContents; if (live(wc)) wc.focus(); }
    return { captured: !!st.shot };
  }
  async function capture(fresh) {
    const wc = view && view.webContents;
    if (!live(wc)) return '';
    if (!fresh && (st.occluded || !st.shown)) return st.shot;
    try {
      const img = await Promise.race([wc.capturePage(), new Promise((r) => setTimeout(() => r(null), 600))]);
      if (img && !img.isEmpty()) st.shot = 'data:image/jpeg;base64,' + img.toJPEG(70).toString('base64');
    } catch { /* keep the last picture */ }
    return st.shot;
  }
  return {
    show, hide, release, setBounds, setOccluded, capture, setFull, relayout,
    isOpen: () => !!view || (!!win && !win.isDestroyed()),
    isEmbedded: () => !!view,
    isVisible: () => !!view && st.shown && !st.occluded && (!st.host || st.host.visible !== false) && !st.grace,
    isFocused: () => { const wc = view && view.webContents; return !!live(wc) && !!st.shown && wc.isFocused(); },
    state: () => ({ ...snapshot(), title: 'Mayfair Ghost' }),
    close: () => { hide(); },
    sendJob: (n, p) => { if (n === 'ghost-job') send('job', p); },
    getWindow: () => (win && !win.isDestroyed() ? win : mainLive()),                // the parent for native dialogs
    getView: () => view, getWebContents: wcOf, getMainWindow: mainLive,
    page, handlers, trusted, send,
  };
}
module.exports = { createGhostWindow, PARTITION };
