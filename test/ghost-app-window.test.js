'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createGhostWindow, PARTITION } = require('../src/main/ghost/app/window');

function fakeElectron() {
  const handlers = {}, wins = [], log = { webreq: null, perm: null, opts: null };
  class BW { constructor(o) { log.opts = o; this.o = o; this.destroyed = false; const on = {}; this.webContents = { on: (n, f) => { on[n] = f; }, setWindowOpenHandler: (f) => { this.open = f; }, send: (...a) => { this.sent = a; }, _on: on }; this.webContents.mainFrame = { url: '' }; wins.push(this); } on() {} once(n, f) { this.ready = f; } loadURL(u) { this.url = u; this.webContents.mainFrame.url = u; } isDestroyed() { return this.destroyed; } maximize() { this.maxed = true; } show() { this.shown = true; } setFullScreen(v) { this.fs = v; } close() { this.destroyed = true; } isMinimized() { return false; } focus() {} restore() {} destroy() { this.destroyed = true; } }
  const ses = { setPermissionRequestHandler: (f) => { log.perm = f; }, setPermissionCheckHandler: (f) => { log.permCheck = f; }, webRequest: { onBeforeRequest: (_f, cb) => { log.webreq = cb; } } };
  return { log, wins, handlers, electron: { BrowserWindow: BW, ipcMain: { handle: (ch, f) => { handlers[ch] = f; } }, shell: {}, session: { fromPartition: (p) => { log.partition = p; return ses; } } } };
}
const app = { status: () => ({ stage: 'ready' }), casesList: () => [], emit: null };
const ui = path.join(__dirname, '..', 'src', 'ui', 'ghost');

test('window: sandboxed, isolated, no network, maximised by default, one local page', async () => {
  const f = fakeElectron(); const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true }); w.show();
  const win = f.wins[0], wp = win.o.webPreferences;
  assert.equal(wp.contextIsolation, true); assert.equal(wp.sandbox, true); assert.equal(wp.nodeIntegration, false); assert.equal(wp.devTools, false); assert.equal(wp.partition, PARTITION); assert.equal(PARTITION.startsWith('persist:'), false);
  assert.equal(win.url, pathToFileURL(path.join(ui, 'index.html')).href);
  win.ready(); assert.equal(win.maxed, true); assert.equal(win.shown, true);
  let r; f.log.webreq({ url: 'https://example.org/' }, (x) => { r = x; }); assert.equal(r.cancel, true);
  let p; f.log.perm({}, 'geolocation', (x) => { p = x; }); assert.equal(p, false); assert.equal(f.log.permCheck(), false);
  assert.deepEqual(win.open({ url: 'https://x' }), { action: 'deny' });
  let prevented = false; win.webContents._on['will-navigate']({ preventDefault: () => { prevented = true; } }); assert.equal(prevented, true);
});
test('window: calls from any other sender, frame or page are refused; arguments are checked', async () => {
  const f = fakeElectron(); const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true }); w.show(); const win = f.wins[0], h = f.handlers['gapp:cases.get'];
  const good = { sender: win.webContents, senderFrame: { url: w.page } }; good.sender.mainFrame = good.senderFrame;
  assert.deepEqual(await f.handlers['gapp:cases.list'](good), { ok: true, data: [] });
  await assert.rejects(() => f.handlers['gapp:cases.list']({ sender: {}, senderFrame: { url: w.page } }), /untrusted/);
  await assert.rejects(() => f.handlers['gapp:cases.list']({ sender: win.webContents, senderFrame: { url: 'https://evil.example/' } }), /untrusted/);
  assert.deepEqual(await f.handlers['gapp:cases.list']({ sender: win.webContents, senderFrame: Object.assign(good.senderFrame, { url: w.page + '#m/domains' }) }), { ok: true, data: [] }, 'hash routes keep working');
  good.senderFrame.url = w.page;
  await assert.rejects(() => f.handlers['gapp:cases.list']({ sender: win.webContents, senderFrame: { url: w.page + '?x=1' } }), /untrusted/);
  const sub = { url: w.page }; await assert.rejects(() => f.handlers['gapp:cases.list']({ sender: win.webContents, senderFrame: sub }), /untrusted/, 'sub frames are refused');
  await assert.rejects(() => h(good, '../../x'), /blocked/);
  const maxFalse = fakeElectron(); createGhostWindow({ electron: maxFalse.electron, app, uiDir: ui, maximize: false }).show(); maxFalse.wins[0].ready(); assert.equal(maxFalse.wins[0].maxed, undefined);
});
test('window: events go only to its own channels', () => {
  const f = fakeElectron(); const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true }); w.show(); const win = f.wins[0];
  app.emit('status', { a: 1 }); assert.deepEqual(win.sent, ['gapp:status', { a: 1 }]); app.emit('evil', 1); assert.deepEqual(win.sent, ['gapp:status', { a: 1 }]);
});

// ---- embedded in the Mayfair main window ----
function fakeEmbed() {
  const f = fakeElectron(), views = [];
  class WC { constructor() { this.on_ = {}; this.destroyed = false; this.focused = false; this.mainFrame = { url: '' }; this.sent = []; } on(n, fn) { this.on_[n] = fn; } setWindowOpenHandler(fn) { this.open = fn; } send(...a) { this.sent.push(a); } loadURL(u) { this.url = u; this.mainFrame.url = u; return Promise.resolve(); } isDestroyed() { return this.destroyed; } focus() { this.focused = true; } isFocused() { return this.focused; } close() { this.destroyed = true; } }
  class View { constructor(o) { this.o = o; this.webContents = new WC(); this.bounds = null; this.visible = true; views.push(this); } setBounds(b) { this.bounds = b; } setVisible(v) { this.visible = v; } getVisible() { return this.visible; } setBackgroundColor(c) { this.bg = c; } }
  const children = [], listeners = {};
  const main = { fs: false, size: { width: 1000, height: 700 }, destroyed: false, minimized: false,
    contentView: { addChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); children.push(v); }, removeChildView: (v) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1); }, get children() { return children; } },
    getContentBounds() { return { x: 0, y: 0, ...this.size }; }, isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; }, restore() { this.minimized = false; }, show() { this.shownN = (this.shownN || 0) + 1; }, focus() {},
    isFullScreen() { return this.fs; }, setFullScreen(v) { this.fs = v; (listeners[v ? 'enter-full-screen' : 'leave-full-screen'] || []).forEach((fn) => fn()); },
    on(n, fn) { (listeners[n] = listeners[n] || []).push(fn); }, once(n, fn) { this.on(n, fn); }, removeListener(n, fn) { listeners[n] = (listeners[n] || []).filter((x) => x !== fn); }, emit(n) { (listeners[n] || []).slice().forEach((fn) => fn()); } };
  f.electron.WebContentsView = View;
  return { ...f, views, main, children, listeners };
}
const goodFrom = (wc, url) => { const fr = { url }; wc.mainFrame = fr; return { sender: wc, senderFrame: fr }; };

test('embedded: Ghost is a view inside the main window, not a separate window', () => {
  const f = fakeEmbed(); const changes = [];
  const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true, getMainWindow: () => f.main, onChange: (s) => changes.push(s) });
  w.show();
  assert.equal(f.wins.length, 0, 'no BrowserWindow was created'); assert.equal(f.views.length, 1);
  const v = f.views[0], wp = v.o.webPreferences;
  assert.deepEqual(f.children, [v]); assert.equal(w.isEmbedded(), true); assert.equal(w.getView(), v);
  assert.equal(wp.contextIsolation, true); assert.equal(wp.sandbox, true); assert.equal(wp.nodeIntegration, false); assert.equal(wp.devTools, false); assert.equal(wp.partition, PARTITION); assert.equal(wp.preload, path.join(ui, 'preload.js'));
  assert.equal(v.webContents.url, pathToFileURL(path.join(ui, 'index.html')).href);
  assert.deepEqual(v.bounds, { x: 0, y: 0, width: 1000, height: 700 }, 'fills the app area by default'); assert.equal(v.visible, true); assert.equal(v.bg, '#0a0a0a');
  assert.equal(changes.at(-1).embedded, true); assert.equal(changes.at(-1).shown, true);
  // hardening is the same as in the window
  let r; f.log.webreq({ url: 'https://example.org/' }, (x) => { r = x; }); assert.equal(r.cancel, true);
  let p; f.log.perm({}, 'geolocation', (x) => { p = x; }); assert.equal(p, false);
  assert.deepEqual(v.webContents.open({ url: 'https://x' }), { action: 'deny' });
  let nav = false; v.webContents.on_['will-navigate']({ preventDefault: () => { nav = true; } }); assert.equal(nav, true);
  let att = false; v.webContents.on_['will-attach-webview']({ preventDefault: () => { att = true; } }); assert.equal(att, true);
});
test('embedded: sender checks use the view own webContents; the main window and Cloud page are refused', async () => {
  const f = fakeEmbed(); const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true, getMainWindow: () => f.main }); w.show();
  const wc = f.views[0].webContents, h = f.handlers['gapp:cases.list'];
  assert.deepEqual(await h(goodFrom(wc, w.page)), { ok: true, data: [] });
  assert.deepEqual(await h(goodFrom(wc, w.page + '#case/1')), { ok: true, data: [] });
  const cloud = new (f.views[0].webContents.constructor)(); // another page of the same window (the Mayfair view, a tab)
  await assert.rejects(() => h(goodFrom(cloud, w.page)), /untrusted/, 'another webContents with the right url is refused');
  await assert.rejects(() => h({ sender: wc, senderFrame: { url: 'https://cloud.mayfairmail.com/' } }), /untrusted/);
  await assert.rejects(() => h({ sender: wc, senderFrame: { url: w.page + '?x=1' } }), /untrusted/);
  await assert.rejects(() => h({ sender: wc, senderFrame: { url: w.page } }), /untrusted/, 'a frame that is not the main frame is refused');
  await assert.rejects(() => f.handlers['gapp:cases.get'](goodFrom(wc, w.page), '../../x'), /blocked/);
  // after release no sender is trusted
  const g = goodFrom(wc, w.page); w.release(); await assert.rejects(() => h(g), /untrusted/);
});
test('embedded: the area comes from Mayfair Cloud, follows the window, and hides without closing', () => {
  const f = fakeEmbed(); const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true, getMainWindow: () => f.main, getZoom: () => 1.25 }); w.show();
  const v = f.views[0];
  assert.equal(w.setBounds({ x: 80, y: 40, w: 600, h: 500 }), true);
  assert.deepEqual(v.bounds, { x: 100, y: 50, width: 750, height: 625 }, 'scaled by the Mayfair view zoom'); assert.equal(v.visible, true);
  w.setBounds({ x: 900, y: 650, w: 600, h: 500 }); assert.deepEqual(v.bounds, { x: 1000, y: 700, width: 0, height: 0 }); assert.equal(v.visible, false, 'nothing visible outside the window');
  w.setBounds({ x: 0, y: 0, w: 400, h: 400, visible: false }); assert.equal(v.visible, false, 'Cloud minimised its window');
  w.setBounds({ x: 0, y: 0, w: 400, h: 400 }); f.main.size = { width: 390, height: 844 }; f.main.emit('resize'); assert.deepEqual(v.bounds, { x: 0, y: 0, width: 390, height: 500 }, 'follows a narrow main window');
  assert.equal(w.isVisible(), true);
  w.hide(); assert.equal(v.visible, false); assert.equal(w.isOpen(), true, 'kept alive'); assert.equal(v.webContents.destroyed, false); assert.equal(w.state().shown, false);
  w.show(); assert.equal(f.views.length, 1, 'same view, same page'); assert.equal(v.visible, true); assert.deepEqual(v.bounds, { x: 0, y: 0, width: 390, height: 844 }, 'full area again until Cloud places it');
});
test('embedded: occlusion hides the view, and a window of Cloud that is about to open is waited for', async () => {
  const f = fakeEmbed(); let host = true; const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true, getMainWindow: () => f.main, hasHost: () => host }); w.show();
  const v = f.views[0]; assert.equal(v.visible, false, 'waits for the area Cloud will report instead of flashing full size'); assert.equal(w.isVisible(), false);
  w.setBounds({ x: 10, y: 10, w: 300, h: 300 }); assert.equal(v.visible, true);
  const r = await w.setOccluded(true, { capture: false }); assert.equal(v.visible, false); assert.equal(r.captured, false);
  await w.setOccluded(false, { focus: true }); assert.equal(v.visible, true); assert.equal(v.webContents.focused, true);
  host = false; w.hide(); w.show(); assert.equal(v.visible, true, 'no Cloud window to wait for: fills the area');
});
test('embedded: full screen, close, Ctrl+Shift+R and release', async () => {
  const f = fakeEmbed(); const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true, getMainWindow: () => f.main }); w.show();
  const v = f.views[0], wc = v.webContents, g = goodFrom(wc, w.page);
  w.setBounds({ x: 50, y: 50, w: 300, h: 300 });
  await f.handlers['gapp:window.fullscreen'](g, true); assert.equal(f.main.fs, true); assert.deepEqual(v.bounds, { x: 0, y: 0, width: 1000, height: 700 }); assert.deepEqual(wc.sent.at(-1), ['gapp:window', { fullscreen: true }]);
  f.main.setFullScreen(false); assert.deepEqual(wc.sent.at(-1), ['gapp:window', { fullscreen: false }], 'the main window leaving full screen is told to the page'); assert.deepEqual(v.bounds, { x: 50, y: 50, width: 300, height: 300 });
  // reload keys are swallowed: the page (and an open case board) is not reloaded, Mayfair's own shortcuts do not see them
  for (const input of [{ type: 'keyDown', key: 'R', control: true, shift: true }, { type: 'keyDown', key: 'r', control: true }, { type: 'keyDown', key: 'F5' }, { type: 'keyDown', key: 'r', meta: true }]) { let stop = false; wc.on_['before-input-event']({ preventDefault: () => { stop = true; } }, input); assert.equal(stop, true, JSON.stringify(input)); }
  let other = false; wc.on_['before-input-event']({ preventDefault: () => { other = true; } }, { type: 'keyDown', key: 'F11' }); assert.equal(other, false, 'F11 stays with the page');
  await f.handlers['gapp:window.close'](g); assert.equal(w.state().shown, false); assert.equal(wc.destroyed, false, 'the page close button hides, it does not destroy');
  w.show(); w.release(); assert.equal(wc.destroyed, true); assert.deepEqual(f.children, []); assert.equal(w.isOpen(), false); assert.equal(f.listeners.resize.length, 0, 'main window listeners removed');
  w.show(); assert.equal(f.views.length, 2, 'opens fresh after a release');
  f.main.emit('closed'); assert.equal(w.isOpen(), false, 'closing the main window releases it');
});
test('fallback: the old separate window is used only when there is no main window', () => {
  const f = fakeEmbed(); let m = null;
  const w = createGhostWindow({ electron: f.electron, app, uiDir: ui, isPackaged: true, getMainWindow: () => m }); w.show();
  assert.equal(f.wins.length, 1); assert.equal(f.views.length, 0); assert.equal(w.isEmbedded(), false); assert.equal(w.isOpen(), true);
  w.show(); assert.equal(f.wins.length, 1, 'reused');
  const f2 = fakeEmbed(); const w2 = createGhostWindow({ electron: f2.electron, app, uiDir: ui, isPackaged: true, getMainWindow: () => f2.main }); w2.show(); assert.equal(f2.wins.length, 0);
});
