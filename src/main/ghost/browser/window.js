'use strict';
// Ghost investigation browser: the windows. Electron is handed in (not required here) so the wiring is testable.
//  - A small control window (launcher) and one window per case. A case window is two web contents: the toolbar page (our own file, no network,
//    the only thing with a bridge) and the page view (a sandboxed view in the case's own partition with NO preload and no bridge at all).
//  - Calls from the toolbar pages use gbr:* channels, accepted only from that window's own main frame while it shows our file, and the case
//    is taken from the sender, never from the arguments.
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { check, EVENTS } = require('./checks');
const { GhostBrowserService } = require('./service');

const CHROME_PARTITION = 'mf-ghost-browser-ui';     // in-memory; toolbar pages only; every web request is cancelled
const BAR_H = 80;

function createGhostBrowser({ electron, tor, vault, uiDir, isPackaged = true, icon, restoreResolver, chromeVersion }) {
  const { BrowserWindow, WebContentsView, ipcMain, dialog, session, app } = electron;
  const preload = path.join(uiDir, 'preload.js');
  const pageUrl = (f) => pathToFileURL(path.join(uiDir, f)).href;
  const launcherPage = pageUrl('launcher.html'), casePage = pageUrl('index.html');
  const roles = new Map();             // webContents id -> { role, caseId?, win }
  let launcher = null;

  // ---- the service, with real windows -------------------------------------------------------------------------------------------
  const confirm = async (o) => {
    const opts = { type: 'warning', title: o.title, message: o.message, detail: o.detail, buttons: [o.ok, o.cancel], defaultId: 1, cancelId: 1, noLink: true };
    const r = launcher && !launcher.isDestroyed() ? await dialog.showMessageBox(launcher, opts) : await dialog.showMessageBox(opts);
    return r.response === 0;
  };
  const toCase = (caseId, name, payload) => { for (const [, r] of roles) if (r.role === 'case' && r.caseId === caseId && !r.win.isDestroyed()) r.win.webContents.send(name, payload); };
  const toAll = (name, payload) => { for (const [, r] of roles) if (!r.win.isDestroyed()) r.win.webContents.send(name, payload); };
  const service = new GhostBrowserService({
    electron, tor, vault, confirm, restoreResolver, chromeVersion,
    makeWindow: (rec, hooks) => makeCaseWindow(rec, hooks),
    emit: (name, p) => { if (name === 'killed') toAll('gbr:killed', p); else if (p && p.caseId) toCase(p.caseId, 'gbr:state', p); },
  });

  function lockUi(wc) {
    const stop = (e) => e.preventDefault();
    wc.on('will-navigate', stop); wc.on('will-redirect', stop); wc.on('will-attach-webview', stop);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  }
  const killKey = (service_) => (e, input) => { if (input.type === 'keyDown' && input.shift && (input.control || input.meta) && input.key === 'Backspace') { e.preventDefault(); service_.kill(); } };

  function chromeSession() {
    const ses = session.fromPartition(CHROME_PARTITION);
    ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_d, cb) => cb({ cancel: true }));
    return ses;
  }
  const uiPrefs = (devTools) => ({ partition: CHROME_PARTITION, preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools });

  // ---- case window ----------------------------------------------------------------------------------------------------------
  function makeCaseWindow(rec, hooks) {
    chromeSession();
    const win = new BrowserWindow({ width: 1280, height: 860, minWidth: 640, minHeight: 420, title: 'Ghost investigation: ' + rec.name, backgroundColor: '#07080a', autoHideMenuBar: true, show: false, icon, webPreferences: uiPrefs(!isPackaged) });
    // The page view: its own partition, no preload, nothing exposed.
    const view = new WebContentsView({ webPreferences: { partition: rec.partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: false, webviewTag: false, navigateOnDragDrop: false, enableWebSQL: false } });
    win.contentView.addChildView(view);
    const wc = view.webContents;
    let panel = 0;
    const layout = () => { const [w, h] = win.getContentSize(); const top = BAR_H + panel; view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) }); };
    win.on('resize', layout); layout();
    const entry = { role: 'case', caseId: rec.id, win }; roles.set(win.webContents.id, entry);

    let broken = '';
    const nav = () => ({ url: wc.isDestroyed() ? '' : wc.getURL(), title: wc.isDestroyed() ? '' : wc.getTitle(), loading: !wc.isDestroyed() && wc.isLoading(), canGoBack: !wc.isDestroyed() && wc.navigationHistory.canGoBack(), canGoForward: !wc.isDestroyed() && wc.navigationHistory.canGoForward(), error: broken });
    for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-fail-load']) wc.on(ev, () => hooks.onState());

    // Set up before the first real page: leak policy for WebRTC, then the fixed identity. If any step fails the window stays blank and says so.
    const ready = (async () => {
      try {
        wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        wc.debugger.attach('1.3');
        await wc.loadURL('about:blank');
        for (const [m, p] of hooks.fingerprintCommands()) await wc.debugger.sendCommand(m, p);
      } catch (e) { broken = 'Privacy set-up failed, so no page was loaded: ' + (e && e.message ? e.message : 'unknown'); hooks.onState(); }
    })();

    const vet = (e, url) => { if (!hooks.policy.decide(rec.id, url, 'top').allow) e.preventDefault(); };
    wc.on('will-navigate', vet); wc.on('will-redirect', vet); wc.on('will-attach-webview', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => { if (hooks.policy.decide(rec.id, url, 'top').allow) setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {}); }); return { action: 'deny' }; });
    wc.on('before-input-event', killKey(service)); win.webContents.on('before-input-event', killKey(service));
    lockUi(win.webContents);
    win.webContents.loadURL(casePage);
    win.once('ready-to-show', () => win.show());
    win.on('closed', () => { roles.delete(win.webContents.id); hooks.onClosed(); });

    return {
      wc, win, ready, nav,
      focus() { if (win.isMinimized()) win.restore(); win.show(); win.focus(); },
      async load(url) { await ready; if (broken) return; wc.loadURL(url).catch(() => {}); },
      close() { if (!win.isDestroyed()) win.destroy(); },
      setPanel(px) { panel = px; layout(); },
      cmd(name) { const h = wc.navigationHistory; if (name === 'back' && h.canGoBack()) h.goBack(); else if (name === 'forward' && h.canGoForward()) h.goForward(); else if (name === 'reload') wc.reload(); else if (name === 'stop') wc.stop(); },
    };
  }

  // ---- launcher window ------------------------------------------------------------------------------------------------------
  function showLauncher() {
    if (launcher && !launcher.isDestroyed()) { if (launcher.isMinimized()) launcher.restore(); launcher.show(); launcher.focus(); return launcher; }
    chromeSession(); register();
    const w = new BrowserWindow({ width: 760, height: 640, minWidth: 420, minHeight: 360, title: 'Ghost investigation browser', backgroundColor: '#07080a', autoHideMenuBar: true, show: false, icon, webPreferences: uiPrefs(!isPackaged) });
    launcher = w; roles.set(w.webContents.id, { role: 'launcher', win: w });
    lockUi(w.webContents); w.webContents.on('before-input-event', killKey(service));
    w.once('ready-to-show', () => w.show());
    w.on('closed', () => { roles.delete(w.webContents.id); if (launcher === w) launcher = null; });
    w.loadURL(launcherPage);
    return w;
  }

  // ---- IPC ----------------------------------------------------------------------------------------------------------------
  const senderRole = (e) => {
    const r = roles.get(e.sender.id);
    if (!r || r.win.isDestroyed() || e.sender !== r.win.webContents || !e.senderFrame || e.senderFrame !== e.sender.mainFrame) return null;
    if (e.senderFrame.url !== (r.role === 'launcher' ? launcherPage : casePage)) return null;
    return r;
  };
  const caseRec = (r) => service.cases.get(r.caseId);
  const handlers = {
    'gbr:launcher.open': (r, o) => service.open(o),
    'gbr:launcher.cases': () => ({ ok: true, cases: [...service.cases.values()].map((c) => service.status(c.id)) }),
    'gbr:launcher.tor': () => ({ ok: true, tor: { ...tor.state }, hasBinary: !!tor.binary }),
    'gbr:case.info': (r) => ({ ok: true, status: service.status(r.caseId) }),
    'gbr:case.navigate': (r, u) => service.navigate(r.caseId, u),
    'gbr:case.back': (r) => (caseRec(r).handle.cmd('back'), { ok: true }),
    'gbr:case.forward': (r) => (caseRec(r).handle.cmd('forward'), { ok: true }),
    'gbr:case.reload': (r) => (caseRec(r).handle.cmd('reload'), { ok: true }),
    'gbr:case.stop': (r) => (caseRec(r).handle.cmd('stop'), { ok: true }),
    'gbr:case.allowHost': (r, h) => service.allowHost(r.caseId, h),
    'gbr:case.capture': (r) => service.capture(r.caseId),
    'gbr:case.snapshots': (r) => service.snapshots(r.caseId),
    'gbr:case.panel': (r, px) => { caseRec(r).handle.setPanel(px); return { ok: true }; },
    'gbr:case.close': (r) => service.close(r.caseId),
    'gbr:kill': () => service.kill(),
  };
  let registered = false;
  function register() {
    if (registered) return; registered = true;
    for (const ch of Object.keys(handlers)) {
      ipcMain.handle(ch, async (e, ...args) => {
        const r = senderRole(e); if (!r) throw new Error('blocked: untrusted sender');
        const v = check(ch, r.role, args); if (!v.ok) throw new Error('blocked: ' + v.reason);
        if (r.role === 'case' && !service.cases.has(r.caseId)) throw new Error('blocked: case is closed');
        return handlers[ch](r, ...args);
      });
    }
  }
  // For Ghost Quick notes: a picture of a case window's page (the one for `caseId`, else the first that is open), and what a window is showing. Read only.
  const caseWc = (rec) => (rec && rec.handle && rec.handle.wc && !rec.handle.wc.isDestroyed() ? rec.handle.wc : null);
  const notesBridge = {
    async snapshot(caseId) {
      const wc = caseWc((caseId && service.cases.get(caseId)) || [...service.cases.values()].find((r) => caseWc(r)));
      if (!wc || !/^https?:/.test(wc.getURL())) return null;
      return { image: await wc.capturePage(), url: wc.getURL(), title: wc.getTitle() };
    },
    describe(win) { for (const r of roles.values()) if (r.role === 'case' && r.win === win) { const wc = caseWc(service.cases.get(r.caseId)); return { url: wc ? wc.getURL() : '', title: wc ? wc.getTitle() : '' }; } return null; },
  };
  return { service, showLauncher, register, handlers, senderRole, shutdown: () => service.kill(), isOpen: () => service.cases.size > 0, notesBridge, PAGES: { launcherPage, casePage } };
}

module.exports = { createGhostBrowser, CHROME_PARTITION, BAR_H, EVENTS };
