'use strict';
// Ghost investigation browser windows and pages: wiring with a mock Electron, sender checks, argument checks, page rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createGhostBrowser } = require('../src/main/ghost/browser/window');
const { check, CALLS } = require('../src/main/ghost/browser/checks');
const H = require('./ghost-browser-helpers');

const root = path.join(__dirname, '..'); const uiDir = path.join(root, 'src', 'ui', 'ghost-browser');
let nextId = 1;
function mockElectron() {
  const made = { windows: [], views: [], ipc: new Map(), dialogs: [] };
  class WC extends EventEmitter {
    constructor(o) { super(); this.id = nextId++; this.opts = o; this.sent = []; this.loaded = []; this.history = { canGoBack: () => false, canGoForward: () => false }; this.navigationHistory = this.history; this.mainFrame = { url: '' }; this.dbg = []; this.destroyed = false;
      this.debugger = { attach: () => {}, sendCommand: async (m, p) => { this.dbg.push([m, p]); return {}; } }; }
    async loadURL(u) { this.loaded.push(u); this.mainFrame.url = u; } send(c, p) { this.sent.push([c, p]); } setWindowOpenHandler(f) { this.openHandler = f; }
    setWebRTCIPHandlingPolicy(p) { this.webrtc = p; } getURL() { return this.mainFrame.url; } getTitle() { return ''; } isLoading() { return false; } isDestroyed() { return this.destroyed; }
  }
  class BrowserWindow extends EventEmitter {
    constructor(o) { super(); this.opts = o; this.webContents = new WC(o.webPreferences); this.children = []; this.contentView = { addChildView: (v) => this.children.push(v) }; this.d = false; made.windows.push(this); }
    getContentSize() { return [1000, 700]; } isDestroyed() { return this.d; } isMinimized() { return false; } show() {} focus() {} restore() {}
    destroy() { this.d = true; this.emit('closed'); } once(e, f) { super.once(e, f); return this; }
    loadURL(u) { return this.webContents.loadURL(u); }
  }
  // the window's webContents.loadURL is what the code calls on win.webContents
  class WebContentsView { constructor(o) { this.webContents = new WC(o.webPreferences); this.bounds = null; made.views.push(this); } setBounds(b) { this.bounds = b; } }
  const el = { ...H.fakeElectron(), BrowserWindow, WebContentsView, dialog: { showMessageBox: async (...a) => { made.dialogs.push(a); return { response: 0 }; } }, ipcMain: { handle: (ch, fn) => made.ipc.set(ch, fn) } };
  return { el, made };
}
const build = (extra = {}) => { const m = mockElectron(); const tor = new H.FakeTor(); const vault = H.mkVault(); const gb = createGhostBrowser({ electron: m.el, tor, vault: () => vault, uiDir, isPackaged: true, ...extra }); return { ...m, gb, tor, vault }; };
const ev = (b, win, url) => { win.webContents.mainFrame.url = url; return { sender: win.webContents, senderFrame: win.webContents.mainFrame }; };

test('case window: toolbar page has the bridge; the page view has none and its own partition', async () => {
  const b = build(); b.gb.showLauncher(); b.gb.register();
  const r = await b.gb.service.open({ caseId: 'u1', name: 'U One' }); assert.equal(r.ok, true, r.error);
  const tw = b.made.windows[1], view = b.made.views[0], rec = b.gb.service.cases.get('u1');
  assert.equal(tw.opts.webPreferences.preload.endsWith(path.join('ghost-browser', 'preload.js')), true); assert.equal(tw.opts.webPreferences.partition, 'mf-ghost-browser-ui');
  for (const o of [tw.opts.webPreferences, view.webContents.opts]) { assert.equal(o.sandbox, true); assert.equal(o.contextIsolation, true); assert.equal(o.nodeIntegration, false); assert.equal(o.webSecurity, true); }
  assert.equal(view.webContents.opts.preload, undefined); assert.equal(view.webContents.opts.partition, rec.partition); assert.ok(rec.partition.startsWith('mf-ghost-case-'));
  assert.equal(view.webContents.opts.devTools, false); assert.equal(tw.children[0], view); assert.deepEqual([view.bounds.x, view.bounds.y, view.bounds.width, view.bounds.height], [0, 80, 1000, 620]);
  await rec.handle.ready; assert.equal(view.webContents.webrtc, 'disable_non_proxied_udp');
  assert.equal(view.webContents.loaded[0], 'about:blank', 'blank first, identity set before any real load');
  const cmds = view.webContents.dbg.map((x) => x[0]); assert.ok(['Emulation.setUserAgentOverride', 'Emulation.setTimezoneOverride', 'Page.addScriptToEvaluateOnNewDocument'].every((c) => cmds.includes(c)));
  await rec.handle.load('https://example.org/'); assert.deepEqual(view.webContents.loaded, ['about:blank', 'https://example.org/']);
  b.gb.service.allowHost('u1', 'example.org');
});
test('page view navigation is policed (will-navigate, redirects, pop-ups) and cannot attach webviews', async () => {
  const b = build(); await b.gb.service.open({ caseId: 'u2' }); b.gb.service.allowHost('u2', 'example.org');
  const wc = b.made.views[0].webContents; const prevent = (name, url) => { let p = false; wc.emit(name, { preventDefault: () => { p = true; } }, url); return p; };
  assert.equal(prevent('will-navigate', 'https://example.org/x'), false); assert.equal(prevent('will-navigate', 'https://other.test/'), true); assert.equal(prevent('will-redirect', 'http://127.0.0.1/'), true);
  assert.equal(prevent('will-attach-webview', ''), true);
  assert.deepEqual(wc.openHandler({ url: 'https://other.test/' }), { action: 'deny' }); assert.deepEqual(wc.openHandler({ url: 'https://example.org/y' }), { action: 'deny' });
});
test('kill key combination is caught in both web contents and runs the kill switch', async () => {
  const b = build(); await b.gb.service.open({ caseId: 'u3' }); const wc = b.made.views[0].webContents; let p = false;
  wc.emit('before-input-event', { preventDefault: () => { p = true; } }, { type: 'keyDown', key: 'Backspace', shift: true, control: true });
  assert.equal(p, true); await new Promise((r) => setTimeout(r, 20)); assert.equal(b.gb.service.cases.size, 0); assert.equal(b.vault.unlocked, false);
});
test('IPC: refused from any sender that is not that window\'s own toolbar file; case comes from the sender; roles enforced', async () => {
  const b = build(); const launcher = b.gb.showLauncher(); await b.gb.service.open({ caseId: 'ipc1' }); await b.gb.service.open({ caseId: 'ipc2' });
  const [, w1, w2] = b.made.windows; const call = (ch, e, ...a) => b.made.ipc.get(ch)(e, ...a);
  const L = b.gb.PAGES.launcherPage, C = b.gb.PAGES.casePage;
  await assert.rejects(call('gbr:case.info', { sender: { id: 9999 }, senderFrame: {} }), /untrusted/);
  await assert.rejects(call('gbr:case.info', ev(b, w1, 'https://example.org/')), /untrusted/, 'wrong page in the toolbar window');
  await assert.rejects(call('gbr:case.info', { sender: w1.webContents, senderFrame: { url: C } }), /untrusted/, 'a sub-frame is not the main frame');
  assert.equal((await call('gbr:case.info', ev(b, w1, C))).status.caseId, 'ipc1'); assert.equal((await call('gbr:case.info', ev(b, w2, C))).status.caseId, 'ipc2');
  await assert.rejects(call('gbr:launcher.open', ev(b, w1, C), { caseId: 'zz' }), /not for this window/);
  await assert.rejects(call('gbr:case.info', ev(b, launcher, L)), /not for this window/);
  await assert.rejects(call('gbr:case.navigate', ev(b, w1, C), 5), /bad argument/); await assert.rejects(call('gbr:case.navigate', ev(b, w1, C), 'x', 'y'), /wrong number/);
  const o = await call('gbr:launcher.open', ev(b, launcher, L), { caseId: 'ipc3', name: 'Three' }); assert.equal(o.ok, true);
  await assert.rejects(call('gbr:launcher.open', ev(b, launcher, L), { caseId: 'ipc4', extra: 1 }), /bad argument/);
  await assert.rejects(call('gbr:launcher.open', ev(b, launcher, L), { caseId: 'ipc4', route: 'vpn' }), /bad argument/);
  const k = await call('gbr:kill', ev(b, w1, C)); assert.equal(k.report.windows, 3);
});
test('argument checks: shapes, lengths, and that no call carries a path, command or partition', () => {
  assert.equal(check('gbr:case.panel', 'case', [260]).ok, true); assert.equal(check('gbr:case.panel', 'case', [9999]).ok, false);
  assert.equal(check('gbr:case.allowHost', 'case', ['a'.repeat(300)]).ok, false); assert.equal(check('gbr:case.navigate', 'case', ['']).ok, false);
  assert.equal(check('gbr:launcher.open', 'launcher', [{ caseId: 'ok', route: 'direct-doh', directConfirmed: true }]).ok, true);
  assert.equal(check('gbr:launcher.open', 'launcher', [{ caseId: 'ok', partition: 'persist:x' }]).ok, false);
  assert.equal(check('gbr:kill', 'launcher', []).ok, true); assert.equal(check('gbr:kill', 'case', []).ok, true); assert.equal(check('gbr:nope', 'case', []).ok, false);
  const ch = Object.keys(CALLS).join(' '); assert.ok(!/path|exec|command|partition|file/i.test(ch));
});
test('pages: strict CSP, no inline script, no remote content, text-only rendering, Mayfair skin', () => {
  for (const f of ['index.html', 'launcher.html']) {
    const s = fs.readFileSync(path.join(uiDir, f), 'utf8');
    assert.match(s, /default-src 'none'/); assert.ok(!/<script(?![^>]*\bsrc=)/i.test(s)); assert.ok(!/ on[a-z]+=/i.test(s)); assert.ok(!/(src|href)="https?:/i.test(s)); assert.match(s, /\.\.\/ui\.css/);
  }
  for (const f of ['app.js', 'launcher.js']) { const s = fs.readFileSync(path.join(uiDir, f), 'utf8'); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(s), f); }
  const css = fs.readFileSync(path.join(uiDir, 'gbr.css'), 'utf8'); assert.ok(!/mf-tint|mf-tile/.test(css)); assert.match(css, /#07080a/);
  const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8'); for (const id of ['chip', 'kill', 'capture', 'addr', 'blocked']) assert.ok(html.includes('id="' + id + '"'), id);
  const pre = fs.readFileSync(path.join(uiDir, 'preload.js'), 'utf8'); assert.ok(!/ipcRenderer\.send\b|require\((?!'electron')/.test(pre));
});
test('the page being investigated never gets the toolbar preload', () => {
  const s = fs.readFileSync(path.join(root, 'src/main/ghost/browser/window.js'), 'utf8');
  const view = s.slice(s.indexOf('new WebContentsView'), s.indexOf('new WebContentsView') + 420); assert.ok(!/preload/.test(view)); assert.match(view, /partition: rec\.partition/);
});
