'use strict';
// Ghost Quick notes, main side: the calls the Ghost window and the small pop-out notes window may make (gqn:*), the pop-out window itself, the clipboard,
// the "Capture" helpers (the Ghost browser page, or the screen or a window) and a best guess at where a paste came from.
//   - Electron is handed in, so the logic is testable without a display.
//   - Calls are accepted only from the main frame of the Ghost window or of the pop-out window, while each shows its own local page; every argument is checked
//     (notes-checks.js) before anything runs, and the notes themselves are only reachable once Ghost is ready (stage "ready").
//   - The pop-out window has no network, no permissions, no navigation and no new windows. It stays on top of other windows by default.
//   - Nothing leaves this computer: pictures and notes go only into the vault.
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const QN = require('../../../ui/ghost/qn-model');
const { check, EVENTS } = require('./notes-checks');
const { NoteError } = require('./notes');
const { fail } = require('./service');

const PARTITION = 'mf-ghost-notes';
const MAX_SIDE = 4096;
const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A picture as PNG within the one-picture cap: scaled down in steps when it is too big, JPEG as a last resort.
function fitImage(img, cap = QN.LIMITS.blobBytes) {
  let cur = img, s = cur.getSize();
  if (Math.max(s.width, s.height) > MAX_SIDE) { const k = MAX_SIDE / Math.max(s.width, s.height); cur = cur.resize({ width: Math.max(1, Math.floor(s.width * k)), quality: 'good' }); }
  let png = cur.toPNG();
  for (let i = 0; i < 6 && png.length > cap; i++) { s = cur.getSize(); cur = cur.resize({ width: Math.max(160, Math.floor(s.width * 0.75)), quality: 'good' }); png = cur.toPNG(); }
  if (png.length <= cap) { s = cur.getSize(); return { bytes: png, mime: 'image/png', w: s.width, h: s.height }; }
  const jpg = cur.toJPEG(78); s = cur.getSize();
  if (jpg.length <= cap) return { bytes: jpg, mime: 'image/jpeg', w: s.width, h: s.height };
  throw new NoteError('too-large', 'That picture is too large to keep, even scaled down.');
}

function createNotesHost({ electron, app, uiDir, icon, isPackaged = true, getGhostWindow = () => null, ghostPage, browserBridge = () => null, now = Date.now }) {
  const { BrowserWindow, ipcMain, session, clipboard, desktopCapturer, dialog } = electron;
  const page = pathToFileURL(path.join(uiDir, 'quicknotes.html')).href;
  const preload = path.join(uiDir, 'quicknotes-preload.js');
  let pop = null, popState = { scope: 'inbox', theme: 'dark', onTop: true }, closing = false;
  let hint = null;                                  // { kind, label, url, at }: the last place something was copied from
  const keep = new Map();                           // capture source id -> { img, name, at }
  const focusSig = new Map();                       // window id -> clipboard signature when it gained focus

  const ours = (w) => !!w && ((pop && w === pop) || w === getGhostWindow());
  const frameOk = (e, win, url) => !!win && !win.isDestroyed() && e.sender === win.webContents && !!e.senderFrame && e.senderFrame === e.sender.mainFrame && e.senderFrame.url.split('#')[0] === url;
  const who = (e) => { if (frameOk(e, getGhostWindow(), ghostPage)) return 'ghost'; if (frameOk(e, pop, page)) return 'pop'; return null; };
  const wrap = async (fn) => { try { const r = await fn(); return r && typeof r === 'object' && !Array.isArray(r) && 'ok' in r ? r : { ok: true, data: r === undefined ? null : r }; } catch (e) { return fail(e); } };
  const need = () => { app._need(); if (!app.notes) throw new NoteError('no-vault', 'The vault is not open.'); return app.notes; };
  const emit = (win, name, payload) => { if (win && !win.isDestroyed() && EVENTS.includes(name)) win.webContents.send(name, payload); };
  const emitGhost = (name, p) => emit(getGhostWindow(), name, p);

  // ----- where did the clipboard come from -----
  const sig = () => { try { const t = clipboard.readText() || '', im = clipboard.readImage(); const sz = im && !im.isEmpty() ? im.getSize() : null; return (clipboard.availableFormats() || []).join(',') + '|' + t.length + ':' + t.slice(0, 200) + '|' + (sz ? sz.width + 'x' + sz.height : ''); } catch { return ''; } };
  if (electron.app && typeof electron.app.on === 'function' && clipboard) {
    electron.app.on('browser-window-focus', (_e, w) => { if (w && !ours(w)) focusSig.set(w.id, sig()); });
    electron.app.on('browser-window-blur', (_e, w) => {
      if (!w || ours(w) || w.isDestroyed()) return;
      const before = focusSig.get(w.id); focusSig.delete(w.id);
      if (before === undefined || sig() === before) return;                  // nothing was copied while that window had the focus
      const b = browserBridge(); let info = null; try { info = b && b.describe ? b.describe(w) : null; } catch { info = null; }
      const title = clip(w.getTitle(), 160);
      if (info) hint = { kind: 'ghost-browser', label: 'Ghost browser' + (info.title ? ': ' + clip(info.title, 120) : ''), url: QN.webUrl(info.url), at: now() };
      else hint = { kind: /terminal|shell|vm/i.test(title) ? 'terminal' : 'window', label: title || 'Another window', url: '', at: now() };
    });
  }
  const currentHint = () => (hint && now() - hint.at <= QN.HINT_MAX_AGE_MS ? hint : null);

  // ----- pictures -----
  const storeImage = (scope, img) => { const f = fitImage(img); const r = need().putBlob(scope, f.bytes); return { blob: r.id, sha256: r.sha256, bytes: r.bytes, mime: f.mime, w: f.w, h: f.h }; };

  const handlers = {
    'gqn:get': (e, scope) => need().get(scope),
    'gqn:put': (e, scope, json) => need().put(scope, json),
    'gqn:blob.put': (e, scope, bytes) => { const r = need().putBlob(scope, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)); return r; },
    'gqn:blob.get': (e, scope, id) => need().getBlob(scope, id),
    'gqn:blob.save': async (e, scope, id, name) => {
      const buf = need().getBlob(scope, id); if (!dialog) throw new NoteError('unavailable', 'No file dialog is available.');
      const win = who(e) === 'pop' ? pop : getGhostWindow(); const o = { title: 'Save a copy', defaultPath: clip(name, 120).replace(/[\\/]/g, '-') || 'file' };
      const s = win && !win.isDestroyed() ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o);
      if (s.canceled || !s.filePath) return { saved: false };
      fs.writeFileSync(s.filePath, buf, { mode: 0o600 }); return { saved: true, name: path.basename(s.filePath), bytes: buf.length };
    },
    'gqn:cases': () => { app._need(); return app.casesList().map((c) => ({ id: c.id, title: c.title })); },
    'gqn:clipboard': (e, scope) => {
      need(); const out = { text: clip(clipboard.readText(), 2000000), html: clip(clipboard.readHTML(), 4 * 1024 * 1024), image: null };
      const img = clipboard.readImage(); if (img && !img.isEmpty()) out.image = storeImage(scope, img);
      return out;
    },
    'gqn:hint': () => currentHint(),
    'gqn:copied': (e, h) => { hint = { kind: h.kind, label: clip(h.label, 200), url: '', at: now() }; return true; },
    'gqn:capture.browser': async (e, scope, caseId) => {
      need(); const b = browserBridge(); if (!b || !b.snapshot) throw new NoteError('no-browser', 'The Ghost browser is not open. Open it and load a page first.');
      const s = await b.snapshot(caseId); if (!s || !s.image || s.image.isEmpty()) throw new NoteError('no-page', 'There is no page to capture. Load a page in the Ghost browser first.');
      return { file: storeImage(scope, s.image), url: QN.webUrl(s.url), title: clip(s.title, 200) };
    },
    'gqn:capture.sources': async () => {
      need(); if (!desktopCapturer) throw new NoteError('unavailable', 'Screen capture is not available here.');
      const list = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 2560, height: 1600 }, fetchWindowIcons: false });
      keep.clear(); const out = [];
      for (const s of list.slice(0, 40)) {
        if (!s.thumbnail || s.thumbnail.isEmpty()) continue;
        keep.set(s.id, { img: s.thumbnail, name: s.name, at: now() });
        out.push({ id: s.id, name: clip(s.name, 120) || 'Window', kind: /^screen:/.test(s.id) ? 'screen' : 'window', thumb: s.thumbnail.resize({ width: 240 }).toDataURL() });
      }
      return out;
    },
    'gqn:capture.take': async (e, scope, id) => {
      need(); const k = keep.get(id); if (!k || now() - k.at > 120000) throw new NoteError('stale', 'That list is out of date. Open Capture again.');
      return { file: storeImage(scope, k.img), name: clip(k.name, 120) };
    },
    'gqn:popout.open': (e, o) => { openPop(o); return { open: true }; },
    'gqn:popout.close': () => { if (pop && !pop.isDestroyed()) pop.close(); return { open: false }; },
    'gqn:popout.info': () => ({ open: !!pop && !pop.isDestroyed(), ...popState }),
    'gqn:popout.top': (e, on) => { popState.onTop = on; if (pop && !pop.isDestroyed()) pop.setAlwaysOnTop(on, 'floating'); return { onTop: on }; },
    'gqn:send': (e, p) => {
      const gw = getGhostWindow(); if (!gw) throw new NoteError('no-ghost', 'The Ghost window is closed. Open Ghost, then send again.');
      if (gw.isMinimized()) gw.restore(); gw.show(); gw.focus(); emitGhost('gqn:send', p); return true;
    },
    'gqn:sent': (e, p) => { emit(pop, 'gqn:sent', p); return true; },
  };

  let registered = false;
  function register() {
    if (registered || !ipcMain) return; registered = true;
    for (const ch of Object.keys(handlers)) {
      ipcMain.handle(ch, async (e, ...args) => {
        const w = who(e); if (!w) throw new Error('blocked: untrusted sender');
        const v = check(ch, args); if (!v.ok) throw new Error('blocked: ' + v.reason);
        if ((ch === 'gqn:send' || ch === 'gqn:copied') && w !== (ch === 'gqn:send' ? 'pop' : 'ghost')) throw new Error('blocked: wrong window');
        if (ch === 'gqn:sent' && w !== 'ghost') throw new Error('blocked: wrong window');
        return wrap(() => handlers[ch](e, ...args));
      });
    }
  }

  function openPop(o) {
    if (o) popState = { ...popState, scope: o.scope, theme: o.theme };
    if (pop && !pop.isDestroyed()) { if (pop.isMinimized()) pop.restore(); pop.show(); pop.focus(); return pop; }
    const ses = session.fromPartition(PARTITION);
    ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false)); ses.setPermissionCheckHandler(() => false);
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_d, cb) => cb({ cancel: true }));
    const w = new BrowserWindow({ width: 400, height: 640, minWidth: 300, minHeight: 360, title: 'Quick notes', backgroundColor: '#171716', autoHideMenuBar: true, show: false, icon, alwaysOnTop: popState.onTop,
      webPreferences: { partition: PARTITION, preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: !isPackaged } });
    pop = w; closing = false;
    if (popState.onTop) w.setAlwaysOnTop(true, 'floating');
    const wc = w.webContents, lock = (ev) => ev.preventDefault();
    wc.on('will-navigate', lock); wc.on('will-redirect', lock); wc.on('will-attach-webview', lock); wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Closing waits (briefly) for the page to write its notes into the vault.
    w.on('close', async (ev) => {
      if (closing) return; ev.preventDefault(); closing = true;
      try { await Promise.race([wc.executeJavaScript('window.GH && GH.qn && GH.qn.flush ? GH.qn.flush() : true', true), sleep(2500)]); } catch { /* the page is gone */ }
      try { w.destroy(); } catch { /* gone */ }
    });
    w.on('closed', () => { if (pop === w) pop = null; emitGhost('gqn:popped', { open: false }); });
    w.once('ready-to-show', () => { w.show(); w.focus(); emitGhost('gqn:popped', { open: true }); });
    w.loadURL(page);
    return w;
  }

  register();
  return { handlers, register, who, page, openPop, isPopOpen: () => !!pop && !pop.isDestroyed(), getPop: () => (pop && !pop.isDestroyed() ? pop : null), hint: currentHint, shutdown: () => { if (pop && !pop.isDestroyed()) { closing = true; pop.destroy(); } }, PARTITION };
}
module.exports = { createNotesHost, fitImage, PARTITION };
