'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { actionForKey } = require('../src/main/lib/shortcuts');
const { BookmarkStore } = require('../src/main/lib/stores');
const { Settings } = require('../src/main/lib/settings');
const P = require('../src/main/lib/policy');
const ABOUT = require('../src/main/lib/about');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-br-'));

test('page-tab key shortcuts map to menu actions (Windows/Linux uses Ctrl, macOS uses Cmd)', () => {
  const k = (o, pf = 'linux') => actionForKey({ type: 'keyDown', ...o }, pf);
  assert.equal(k({ key: 't', control: true }), 'newTab');
  assert.equal(k({ key: 't', meta: true }, 'darwin'), 'newTab');
  assert.equal(k({ key: 't', control: true }, 'darwin'), null, 'Ctrl+T is not the Mac shortcut');
  assert.equal(k({ key: 'T', control: true, shift: true }), 'reopenClosed');
  assert.equal(k({ key: 'N', control: true, shift: true }), 'newPrivate');
  assert.equal(k({ key: 't', control: true, alt: true }), 'torTab');
  assert.equal(k({ key: 'w', control: true }), 'closeTab');
  assert.equal(k({ key: 'l', control: true }), 'address');
  assert.equal(k({ key: 'f', control: true }), 'find');
  assert.equal(k({ key: 'd', control: true }), 'bookmark');
  assert.equal(k({ key: 'Tab', control: true }), 'nextTab');
  assert.equal(k({ key: 'Tab', control: true, shift: true }), 'prevTab');
  assert.equal(k({ key: 'F5' }), 'reload');
  assert.equal(k({ key: 'F5', control: true }), 'hardReload');
  assert.equal(k({ key: 'ArrowLeft', alt: true }), 'back');
  assert.equal(k({ key: 'ArrowRight', alt: true }), 'forward');
  assert.equal(k({ key: '=', control: true }), 'zoomIn');
  assert.equal(k({ key: '-', control: true }), 'zoomOut');
  assert.equal(k({ key: '0', control: true }), 'zoomReset');
  assert.equal(k({ key: '3', control: true }), 'tab3');
  assert.equal(k({ key: 'y', control: true }), 'history');
  assert.equal(k({ key: 'o', control: true, shift: true }), 'bookmarks');
});
test('ordinary typing and editing keys are never taken from a page', () => {
  const k = (o) => actionForKey({ type: 'keyDown', ...o }, 'linux');
  for (const key of ['a', 'Enter', 'Escape', 'ArrowLeft', 'Backspace', ' ']) assert.equal(k({ key }), null, key);
  for (const key of ['c', 'v', 'x', 'z', 'a', 's', 'b', 'i', 'u']) assert.equal(k({ key, control: true }), null, 'Ctrl+' + key);
  assert.equal(actionForKey({ type: 'keyUp', key: 't', control: true }, 'linux'), null);
  assert.equal(actionForKey(null), null);
});
test('the menu shows the browser keys but does not register them (Mayfair apps keep Ctrl+F, Ctrl+Y, Ctrl+D...)', () => {
  const m = read('src/main/main.js');
  assert.match(m, /registerAccelerator = false/);
  assert.match(m, /it\.label === 'Quit'/);
});
test('bookmark update and import', () => {
  const s = new BookmarkStore(path.join(tmp(), 'b.json'));
  const b = s.add('https://a.com/', 'A');
  assert.equal(s.update(b.id, { title: 'Alpha' }), true);
  assert.equal(s.list()[0].title, 'Alpha');
  assert.equal(s.update(b.id, { url: 'javascript:1' }), false);
  assert.equal(s.update('nope', { title: 'x' }), false);
  assert.equal(s.importItems([{ url: 'https://a.com/', title: 'dup' }, { url: 'https://b.com/x', title: 'B' }, { url: 'ftp://c', title: 'C' }, null, { title: 'no url' }]), 1);
  assert.deepEqual(s.list().map((x) => x.url), ['https://a.com/', 'https://b.com/x']);
  assert.equal(s.importItems('nope'), 0);
});
test('settings: startup option is validated, hideToolbarOnMayfair is gone', () => {
  const st = new Settings(path.join(tmp(), 's.json'));
  assert.equal(st.get().startup, 'start');
  assert.deepEqual(st.set({ startup: 'restore' }), ['startup']);
  assert.deepEqual(st.set({ startup: 'bogus' }), []);
  assert.equal(st.get().startup, 'restore');
  assert.equal('hideToolbarOnMayfair' in st.get(), false);
});
test('full screen from a page needs no prompt unless the site was blocked', () => {
  assert.equal(P.decidePermission('fullscreen', { mayfair: false }), 'allow');
  assert.equal(P.decidePermission('fullscreen', { mayfair: false, saved: 'deny' }), 'deny');
  assert.equal(P.decidePermission('geolocation', { mayfair: false }), 'ask');
});
test('the old strip and overlay interface is gone from the app', () => {
  for (const f of ['chrome.html', 'chrome.js', 'chrome.css', 'overlay.html', 'overlay.js', 'overlay.css']) assert.ok(!fs.existsSync(path.join(root, 'src/ui', f)), f);
  assert.ok(!fs.existsSync(path.join(root, 'src/preload/ui.js')));
  assert.ok(!fs.existsSync(path.join(root, 'src/main/browser.js')));
  const svc = read('src/main/browser-service.js');
  assert.ok(!/this\.chrome\b|this\.overlay\b/.test(svc));
  for (const k of ['setBounds', 'setOccluded', 'capture', 'applyBounds', 'getZoomFactor']) assert.ok(svc.includes(k), k);
});
test('tab views are added above the Mayfair view, hidden until bounds are known', () => {
  const svc = read('src/main/browser-service.js');
  assert.match(svc, /this\.win\.contentView\.addChildView\(view\);\n[^\n]*\n    this\.wireHome/, 'the Mayfair view is the first child');
  assert.match(svc, /this\.win\.contentView\.addChildView\(view\);\n    this\.wireTab/, 'tab views are added later, so they draw above it');
  assert.match(svc, /view\.setVisible\(false\);\n    this\.tabs\.set/);
  assert.match(svc, /vis = !!b\.visible && !this\.occluded && w >= 1 && h >= 1/);
  assert.match(svc, /toJPEG\(70\)/);
});
test('Mayfair view: open-url is the only way a foreign link leaves it, and it falls back to the system browser when nobody listens', () => {
  const svc = read('src/main/browser-service.js');
  assert.match(svc, /this\.subs\.has\('open-url'\)/);
  assert.match(svc, /shell\.openExternal\(url\)/);
  assert.match(svc, /if \(!this\.subs\.has\('permission-request'\)\) return callback\(false\)/);
});
test('About content: components and the licence note are served from main', () => {
  const c = ABOUT.components('9.9.9');
  assert.ok(c.length >= 6);
  assert.ok(c[0][0].includes('9.9.9'));
  for (const [n, t] of c) { assert.ok(n && t); assert.ok(!/\bAI\b|assistant|vibe/i.test(t), n); }
  assert.match(ABOUT.LICENSE_NOTE, /THIRD_PARTY_NOTICES\.txt/);
});
test('contract file lists every bridge method and event', () => {
  const f = '/home/claude/audit/browser-bridge-contract.md';
  if (!fs.existsSync(f)) return;      // the contract lives outside this folder
  const doc = fs.readFileSync(f, 'utf8');
  const { BR, BR_EVENTS } = require('../src/main/lib/ipc-allowlist');
  for (const e of BR_EVENTS) assert.ok(doc.includes('`' + e + '`'), 'event not in the contract: ' + e);
  for (const n of Object.keys(BR).filter((x) => x !== 'subscribe')) assert.ok(doc.includes(n.split('.').pop().replace(/^./, (c) => c)) , 'method not in the contract: ' + n);
});
