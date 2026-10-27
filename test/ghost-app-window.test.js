'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createGhostWindow, PARTITION } = require('../src/main/ghost/app/window');

function fakeElectron() {
  const handlers = {}, wins = [], log = { webreq: null, perm: null, opts: null };
  class BW { constructor(o) { log.opts = o; this.o = o; this.destroyed = false; const on = {}; this.webContents = { on: (n, f) => { on[n] = f; }, setWindowOpenHandler: (f) => { this.open = f; }, send: (...a) => { this.sent = a; }, _on: on }; this.webContents.mainFrame = { url: '' }; wins.push(this); } on() {} once(n, f) { this.ready = f; } loadURL(u) { this.url = u; this.webContents.mainFrame.url = u; } isDestroyed() { return this.destroyed; } maximize() { this.maxed = true; } show() { this.shown = true; } setFullScreen(v) { this.fs = v; } close() { this.destroyed = true; } isMinimized() { return false; } }
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
