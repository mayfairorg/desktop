'use strict';
// Ghost Quick notes, main side: argument checks, who may call, the pop-out window, the clipboard, capture, and where a paste came from. Electron is faked.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const N = require('../src/ui/ghost/qn-model');
const { check, CALLS, EVENTS } = require('../src/main/ghost/app/notes-checks');
const { createNotesHost, fitImage, PARTITION } = require('../src/main/ghost/app/notes-host');
const { NoteStore } = require('../src/main/ghost/app/notes');
const { GhostService } = require('../src/main/ghost');
const { tmp, fakeOS, FAST } = require('./ghost-app-helpers');

const ui = path.join(__dirname, '..', 'src', 'ui', 'ghost');
const GHOST_PAGE = pathToFileURL(path.join(ui, 'index.html')).href, NOTES_PAGE = pathToFileURL(path.join(ui, 'quicknotes.html')).href;
const CASE = 'case-aaaa-1111-bbbb';

// a picture whose PNG size is w*h/4 bytes, so scaling it down visibly shrinks it
class Img {
  constructor(w, h, o = {}) { this.w = w; this.h = h; this.o = o; }
  isEmpty() { return !this.w || !this.h; } getSize() { return { width: this.w, height: this.h }; }
  resize({ width }) { return new Img(width, Math.max(1, Math.round(this.h * width / this.w)), this.o); }
  toPNG() { return Buffer.alloc(Math.max(8, Math.floor(this.w * this.h / (this.o.dense ? 1 : 4))), 1 + (this.o.seed || 0)); }
  toJPEG() { return Buffer.alloc(Math.max(8, Math.floor(this.w * this.h / 40)), 2); }
  toDataURL() { return 'data:image/png;base64,AAAA'; }
}
function fakeElectron(over = {}) {
  const handlers = {}, wins = [], appEvents = {}, log = { webreq: null, perm: null, permCheck: null };
  class BW {
    constructor(o) { this.o = o; this.id = wins.length + 100; this.destroyed = false; this.top = !!o.alwaysOnTop; this.title = o.title; this.sent = []; this.on_ = {}; this.once_ = {}; const wc = this.webContents = { on: (n, f) => { (wc._on[n] = wc._on[n] || []).push(f); }, _on: {}, setWindowOpenHandler: (f) => { this.open = f; }, send: (n, p) => { this.sent.push([n, p]); }, executeJavaScript: async (code) => { this.js = code; if (this.flushed) await this.flushed(); return true; }, mainFrame: { url: '' } }; wc.mainFrame = { url: '' }; wins.push(this); }
    on(n, f) { this.on_[n] = f; } once(n, f) { this.once_[n] = f; } loadURL(u) { this.url = u; this.webContents.mainFrame.url = u; }
    setAlwaysOnTop(v, lvl) { this.top = v; this.level = lvl; } isDestroyed() { return this.destroyed; } isMinimized() { return false; } restore() {} show() { this.shown = true; } focus() { this.focused = true; } getTitle() { return this.title || ''; }
    close() { if (this.on_.close) { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; this.closeEv = ev; return Promise.resolve(this.on_.close(ev)); } this.destroy(); return undefined; }
    destroy() { if (this.destroyed) return; this.destroyed = true; if (this.on_.closed) this.on_.closed(); }
  }
  const ses = { setPermissionRequestHandler: (f) => { log.perm = f; }, setPermissionCheckHandler: (f) => { log.permCheck = f; }, webRequest: { onBeforeRequest: (_f, cb) => { log.webreq = cb; } } };
  const clip = { text: '', html: '', image: new Img(0, 0), formats: [] };
  const electron = { BrowserWindow: BW, ipcMain: { handle: (ch, f) => { handlers[ch] = f; } }, session: { fromPartition: (p) => { log.partition = p; return ses; } },
    clipboard: { readText: () => clip.text, readHTML: () => clip.html, readImage: () => clip.image, availableFormats: () => clip.formats },
    desktopCapturer: { getSources: async () => over.sources || [] }, dialog: { showSaveDialog: async () => ({ canceled: true }) },
    app: { on: (n, f) => { appEvents[n] = f; } } };
  return { electron, handlers, wins, log, clip, appEvents };
}
function makeHost(o = {}) {
  const f = fakeElectron(o); const root = tmp('mfd-qnh-'); const g = new GhostService({ root, dialog: {}, isPackaged: false, safeStorage: fakeOS(), useVault: true, vaultOptions: FAST });
  const store = new NoteStore({ vault: g.vaultSvc.vault, now: () => clock.t }); const clock = { t: 1_800_000_000_000 };
  const ghostWin = new f.electron.BrowserWindow({ title: 'Mayfair Ghost' }); ghostWin.webContents.mainFrame.url = GHOST_PAGE; ghostWin.url = GHOST_PAGE;
  let ready = true; const app = { _need() { if (!ready) throw Object.assign(new Error('Finish the start steps first.'), { code: 'not-ready' }); }, notes: store, casesList: () => [{ id: CASE, title: 'Northwind' }, { id: 'case-bbbb-2222-cccc', title: 'Other' }] };
  const bridge = o.bridge === undefined ? null : o.bridge;
  const host = createNotesHost({ electron: f.electron, app, uiDir: ui, isPackaged: true, getGhostWindow: () => (ghostWin.destroyed ? null : ghostWin), ghostPage: GHOST_PAGE, browserBridge: () => bridge, now: () => clock.t });
  const call = (ch, who, ...args) => { const win = who === 'ghost' ? ghostWin : host.getPop(); const e = { sender: win.webContents, senderFrame: win.webContents.mainFrame }; e.sender.mainFrame = e.senderFrame; return f.handlers[ch](e, ...args); };
  return { f, host, g, store, ghostWin, app, call, clock, setReady: (v) => { ready = v; }, done: () => g.shutdown() };
}
const openPop = (h) => { h.host.openPop({ scope: CASE, theme: 'dark' }); const pop = h.host.getPop(); pop.webContents.mainFrame.url = NOTES_PAGE; pop.once_['ready-to-show'](); return pop; };

test('checks: every channel has a fixed argument shape; anything else is refused', () => {
  assert.ok(Object.keys(CALLS).every((c) => c.startsWith('gqn:')));
  assert.equal(check('gqn:get', [CASE]).ok, true); assert.equal(check('gqn:get', ['inbox']).ok, true); assert.equal(check('gqn:get', ['../x']).ok, false); assert.equal(check('gqn:get', []).ok, false); assert.equal(check('gqn:get', [CASE, 'x']).ok, false); assert.equal(check('gqn:nope', []).ok, false); assert.equal(check('constructor', []).ok, false);
  assert.equal(check('gqn:blob.put', [CASE, new Uint8Array(5)]).ok, true); assert.equal(check('gqn:blob.put', [CASE, new Uint8Array(0)]).ok, false); assert.equal(check('gqn:blob.put', [CASE, 'text']).ok, false); assert.equal(check('gqn:blob.put', [CASE, new Uint8Array(N.LIMITS.blobBytes + 1)]).ok, false);
  assert.equal(check('gqn:blob.get', [CASE, 'a'.repeat(16)]).ok, true); assert.equal(check('gqn:blob.get', [CASE, '../etc']).ok, false);
  assert.equal(check('gqn:copied', [{ kind: 'tool', label: 'Tool: x' }]).ok, true); assert.equal(check('gqn:copied', [{ kind: 'ghost-browser', label: 'x' }]).ok, false, 'only main may say the Ghost browser'); assert.equal(check('gqn:copied', [{ kind: 'tool', label: 'x', url: 'https://x' }]).ok, false);
  assert.equal(check('gqn:popout.open', [{ scope: CASE, theme: 'light' }]).ok, true); assert.equal(check('gqn:popout.open', [{ scope: CASE, theme: 'pink' }]).ok, false); assert.equal(check('gqn:popout.top', ['yes']).ok, false);
  assert.equal(check('gqn:capture.take', [CASE, 'window:123:0']).ok, true); assert.equal(check('gqn:capture.take', [CASE, '../../x y']).ok, false); assert.equal(check('gqn:capture.browser', [CASE, null]).ok, true); assert.equal(check('gqn:capture.browser', [CASE, 'bad id']).ok, false);
  assert.equal(check('gqn:send', [{ scope: CASE, clip: { id: 'c-1' } }]).ok, true); assert.equal(check('gqn:send', [{ scope: CASE, clip: 'x' }]).ok, false); assert.equal(check('gqn:send', [{ scope: CASE, clip: { x: 'y'.repeat(400001) } }]).ok, false);
  assert.equal(check('gqn:put', [CASE, 'x'.repeat(N.LIMITS.docBytes + 1)]).ok, false); assert.deepEqual(EVENTS.sort(), ['gqn:popped', 'gqn:send', 'gqn:sent']);
});
test('who may call: only the Ghost window and the pop-out, main frame only, on their own page; the wrong window cannot use the other one\'s calls', async () => {
  const h = makeHost(); const pop = openPop(h);
  const c = (sender, frame, ch, ...a) => h.f.handlers[ch]({ sender, senderFrame: frame }, ...a);
  const gw = h.ghostWin.webContents, pw = pop.webContents;
  assert.equal((await h.call('gqn:get', 'ghost', CASE)).ok, true); assert.equal((await h.call('gqn:get', 'pop', CASE)).ok, true);
  await assert.rejects(() => c({ id: 9 }, { url: GHOST_PAGE }, 'gqn:get', CASE), /untrusted/);                                  // some other window
  await assert.rejects(() => c(gw, { url: GHOST_PAGE }, 'gqn:get', CASE), /untrusted/);                                           // not the main frame
  await assert.rejects(() => c(pw, { ...pw.mainFrame, url: 'https://evil.example/' }, 'gqn:get', CASE), /untrusted/);              // a page that is not the notes page
  gw.mainFrame.url = GHOST_PAGE + '#home'; assert.equal((await h.call('gqn:get', 'ghost', CASE)).ok, true, 'the page routes with #fragments'); gw.mainFrame.url = GHOST_PAGE + '?x=1'; await assert.rejects(() => h.call('gqn:get', 'ghost', CASE), /untrusted/); gw.mainFrame.url = GHOST_PAGE;
  await assert.rejects(() => h.call('gqn:get', 'ghost', '../../x'), /bad argument/); await assert.rejects(() => h.call('gqn:get', 'ghost'), /wrong number/);
  await assert.rejects(() => h.call('gqn:send', 'ghost', { scope: CASE, clip: { id: 'c-1' } }), /wrong window/); await assert.rejects(() => h.call('gqn:copied', 'pop', { kind: 'tool', label: 'x' }), /wrong window/); await assert.rejects(() => h.call('gqn:sent', 'pop', { clipId: 'c-1', entityId: 'e', label: 'l', caseId: CASE }), /wrong window/);
  h.setReady(false); const r = await h.call('gqn:get', 'ghost', CASE); assert.equal(r.ok, false); assert.equal(r.code, 'not-ready'); h.done();
});
test('notes through the calls: save, read, pictures; the vault is the only place they go', async () => {
  const h = makeHost(); const doc = N.newDoc(CASE, 1);
  assert.equal((await h.call('gqn:get', 'ghost', CASE)).data.json, null);
  const png = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), crypto.randomBytes(300)])); const b = (await h.call('gqn:blob.put', 'ghost', CASE, png)).data; assert.equal(b.bytes, png.length); assert.match(b.id, /^[0-9a-f]{16}$/);
  assert.equal((await h.call('gqn:put', 'ghost', CASE, JSON.stringify(doc))).ok, true); assert.equal(JSON.parse((await h.call('gqn:get', 'ghost', CASE)).data.json).scope, CASE);
  assert.ok(Buffer.from((await h.call('gqn:blob.get', 'ghost', CASE, b.id)).data).equals(Buffer.from(png)));
  const bad = await h.call('gqn:put', 'ghost', CASE, JSON.stringify({ ...doc, format: 'x' })); assert.equal(bad.ok, false); assert.equal(bad.code, 'invalid');
  assert.deepEqual((await h.call('gqn:cases', 'ghost')).data.map((x) => x.title), ['Northwind', 'Other']); h.done();
});
test('pictures are scaled to fit the cap: PNG first, JPEG last, refused when nothing fits', () => {
  const small = fitImage(new Img(400, 300)); assert.deepEqual([small.mime, small.w, small.h], ['image/png', 400, 300]);
  const big = fitImage(new Img(6000, 4000), 1_000_000); assert.equal(big.mime, 'image/png'); assert.ok(big.bytes.length <= 1_000_000); assert.ok(Math.max(big.w, big.h) <= 4096);
  const dense = fitImage(new Img(3000, 3000, { dense: true }), 2_000_000); assert.ok(dense.bytes.length <= 2_000_000); assert.ok(dense.w < 3000);
  assert.throws(() => fitImage(new Img(4000, 4000, { dense: true }), 100), (e) => e.code === 'too-large');
  assert.ok(fitImage(new Img(1000, 1000, { dense: true }), 100_000).bytes.length <= 100_000);
});
test('clipboard: text, html and a picture are read in main; the picture goes straight into the vault and comes back as a descriptor', async () => {
  const h = makeHost(); h.f.clip.text = 'copied words'; h.f.clip.html = '<b>copied</b> words'; h.f.clip.image = new Img(640, 480, { seed: 3 });
  const r = (await h.call('gqn:clipboard', 'ghost', CASE)).data; assert.equal(r.text, 'copied words'); assert.equal(r.html, '<b>copied</b> words'); assert.equal(r.image.mime, 'image/png'); assert.deepEqual([r.image.w, r.image.h], [640, 480]);
  const stored = h.store.getBlob(CASE, r.image.blob); assert.equal(stored.length, r.image.bytes); assert.equal(crypto.createHash('sha256').update(stored).digest('hex'), r.image.sha256);
  h.f.clip.image = new Img(0, 0); assert.equal((await h.call('gqn:clipboard', 'ghost', CASE)).data.image, null); h.done();
});
test('capture: the Ghost browser page (only when that browser is open), and screens and windows by an id main just listed', async () => {
  let h = makeHost(); let r = await h.call('gqn:capture.browser', 'ghost', CASE, null); assert.equal(r.ok, false); assert.equal(r.code, 'no-browser'); h.done();
  const asked = []; const bridge = { snapshot: async (id) => { asked.push(id); return { image: new Img(800, 600), url: 'https://example.org/page?x=1', title: 'Example page' }; }, describe: () => null };
  h = makeHost({ bridge }); r = (await h.call('gqn:capture.browser', 'ghost', CASE, CASE)).data; assert.deepEqual(asked, [CASE]); assert.deepEqual([r.url, r.title, r.file.mime], ['https://example.org/page?x=1', 'Example page', 'image/png']); assert.ok(h.store.getBlob(CASE, r.file.blob).length > 0); h.done();
  h = makeHost({ bridge: { snapshot: async () => null } }); r = await h.call('gqn:capture.browser', 'ghost', CASE, null); assert.equal(r.code, 'no-page'); h.done();
  h = makeHost({ bridge: { snapshot: async () => ({ image: new Img(10, 10), url: 'javascript:alert(1)', title: 't' }) } }); assert.equal((await h.call('gqn:capture.browser', 'ghost', CASE, null)).data.url, '', 'only web addresses are kept'); h.done();
  const sources = [{ id: 'screen:0:0', name: 'Entire screen', thumbnail: new Img(2560, 1440) }, { id: 'window:42:0', name: 'Terminal', thumbnail: new Img(1280, 800) }, { id: 'window:43:0', name: 'Empty', thumbnail: new Img(0, 0) }];
  h = makeHost({ sources }); const list = (await h.call('gqn:capture.sources', 'ghost')).data; assert.deepEqual(list.map((s) => [s.id, s.kind]), [['screen:0:0', 'screen'], ['window:42:0', 'window']]); assert.ok(list.every((s) => s.thumb.startsWith('data:image/')));
  assert.equal((await h.call('gqn:capture.take', 'ghost', CASE, 'window:99:0')).code, 'stale', 'an id main did not list is refused');
  const t = (await h.call('gqn:capture.take', 'ghost', CASE, 'window:42:0')).data; assert.equal(t.name, 'Terminal'); assert.ok(h.store.getBlob(CASE, t.file.blob).length > 0);
  h.clock.t += 3 * 60 * 1000; assert.equal((await h.call('gqn:capture.take', 'ghost', CASE, 'window:42:0')).code, 'stale'); h.done();
});
test('pop-out window: always on top, no network, no permissions, no navigation, own session; close waits for the page to save', async () => {
  const h = makeHost(); const pop = openPop(h), o = pop.o, wp = o.webPreferences;
  assert.equal(o.alwaysOnTop, true); assert.equal(pop.level, 'floating'); assert.equal(wp.sandbox, true); assert.equal(wp.contextIsolation, true); assert.equal(wp.nodeIntegration, false); assert.equal(wp.partition, PARTITION); assert.equal(PARTITION.startsWith('persist:'), false); assert.equal(wp.devTools, false);
  assert.equal(path.basename(wp.preload), 'quicknotes-preload.js'); assert.equal(pop.url, NOTES_PAGE);
  let r; h.f.log.webreq({ url: 'https://example.org/' }, (x) => { r = x; }); assert.equal(r.cancel, true); let p; h.f.log.perm({}, 'clipboard-read', (x) => { p = x; }); assert.equal(p, false); assert.equal(h.f.log.permCheck(), false);
  assert.deepEqual(pop.open({ url: 'https://x' }), { action: 'deny' }); let prevented = 0; for (const n of ['will-navigate', 'will-redirect', 'will-attach-webview']) pop.webContents._on[n][0]({ preventDefault: () => { prevented++; } }); assert.equal(prevented, 3);
  assert.deepEqual(h.ghostWin.sent.at(-1), ['gqn:popped', { open: true }]);
  assert.deepEqual((await h.call('gqn:popout.info', 'pop')).data, { open: true, scope: CASE, theme: 'dark', onTop: true });
  await h.call('gqn:popout.top', 'pop', false); assert.equal(pop.top, false); await h.call('gqn:popout.top', 'pop', true); assert.equal(pop.top, true);
  h.host.openPop({ scope: CASE, theme: 'light' }); assert.equal(h.f.wins.filter((w) => w.o.title === 'Quick notes').length, 1, 'a second open focuses the same window'); assert.equal(pop.focused, true);
  let saved = false; pop.flushed = async () => { await new Promise((x) => setTimeout(x, 20)); saved = true; };
  await pop.close(); assert.equal(pop.closeEv.prevented, true); assert.match(pop.js, /GH\.qn\.flush/); assert.equal(saved, true); assert.equal(pop.destroyed, true); assert.equal(h.host.isPopOpen(), false);
  assert.deepEqual(h.ghostWin.sent.at(-1), ['gqn:popped', { open: false }]); h.done();
});
test('pop-out: a window that never answers does not keep the notes open for ever', async () => {
  const h = makeHost(); const pop = openPop(h); pop.flushed = () => new Promise(() => {}); const t = Date.now(); await pop.close(); assert.ok(Date.now() - t < 4000); assert.equal(pop.destroyed, true); h.done();
});
test('send to case from the pop-out goes to the Ghost window, which answers back; with no Ghost window it says so', async () => {
  const h = makeHost(); const pop = openPop(h); const clip = N.makeClip({ kind: 'text', text: 'x', hash: crypto.createHash('sha256').update('x').digest('hex') }, { now: 1 });
  assert.equal((await h.call('gqn:send', 'pop', { scope: CASE, clip })).ok, true); assert.deepEqual(h.ghostWin.sent.at(-1)[0], 'gqn:send'); assert.equal(h.ghostWin.sent.at(-1)[1].clip.id, clip.id); assert.equal(h.ghostWin.focused, true);
  assert.equal((await h.call('gqn:sent', 'ghost', { clipId: clip.id, entityId: 'e1', label: 'x', caseId: CASE })).ok, true); assert.equal(pop.sent.at(-1)[0], 'gqn:sent');
  h.ghostWin.destroyed = true; const r = await h.call('gqn:send', 'pop', { scope: CASE, clip }); assert.equal(r.ok, false); assert.equal(r.code, 'no-ghost'); h.done();
});
test('where a paste came from: a copy made in a Ghost window while it had focus, never a guess', async () => {
  const bridge = { snapshot: async () => null, describe: (w) => (w.title === 'Ghost investigation: Northwind' ? { url: 'https://reg.example/co/42', title: 'Company 42' } : null) };
  const h = makeHost({ bridge }); const { appEvents, clip } = h.f; const br = new h.f.electron.BrowserWindow({ title: 'Ghost investigation: Northwind' }), term = new h.f.electron.BrowserWindow({ title: 'Ghost terminal' });
  assert.equal((await h.call('gqn:hint', 'ghost')).data, null);
  clip.text = 'old'; appEvents['browser-window-focus']({}, br); clip.text = 'new text copied in the browser'; appEvents['browser-window-blur']({}, br);
  let hint = (await h.call('gqn:hint', 'ghost')).data; assert.deepEqual([hint.kind, hint.label, hint.url], ['ghost-browser', 'Ghost browser: Company 42', 'https://reg.example/co/42']);
  assert.deepEqual(N.fromHint(hint, h.clock.t), { kind: 'ghost-browser', label: 'Ghost browser: Company 42', url: 'https://reg.example/co/42', auto: true });
  h.clock.t += 3 * 60 * 1000; assert.equal((await h.call('gqn:hint', 'ghost')).data, null, 'a hint goes stale after two minutes');
  appEvents['browser-window-focus']({}, term); appEvents['browser-window-blur']({}, term); assert.equal((await h.call('gqn:hint', 'ghost')).data, null, 'focus without a copy leaves no hint');
  appEvents['browser-window-focus']({}, term); clip.text = 'ls -la output'; appEvents['browser-window-blur']({}, term); hint = (await h.call('gqn:hint', 'ghost')).data; assert.deepEqual([hint.kind, hint.label], ['terminal', 'Ghost terminal']);
  const pop = openPop(h); appEvents['browser-window-focus']({}, pop); clip.text = 'copied inside the notes'; appEvents['browser-window-blur']({}, pop); assert.equal((await h.call('gqn:hint', 'ghost')).data.kind, 'terminal', 'our own windows never set a hint');
  assert.equal((await h.call('gqn:copied', 'ghost', { kind: 'tool', label: 'Tool: RDAP lookup' })).ok, true); hint = (await h.call('gqn:hint', 'pop')).data; assert.deepEqual([hint.kind, hint.label, hint.url], ['tool', 'Tool: RDAP lookup', '']); h.done();
});
