'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TabModel } = require('../src/main/lib/tabmodel');
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
  assert.match(svc, /vis = !!b\.visible && !g\.occluded && w >= 1 && h >= 1/);
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

test('v3 window groups: ids are shared, tabs move between groups, pinned block is kept', () => {
  let n = 0; const next = () => ++n;
  const a = new TabModel(next), b = new TabModel(next);
  const t1 = a.add({ url: 'https://a.com' }), t2 = b.add({ url: 'https://b.com' }), t3 = a.add({ url: 'https://c.com' });
  assert.deepEqual([t1.id, t2.id, t3.id], [1, 2, 3], 'one id sequence across groups');
  const moved = a.detach(t1.id);
  assert.equal(a.activeId, t3.id, 'the neighbour becomes active in the source');
  b.attach(moved, 0);
  assert.deepEqual(b.tabs.map((t) => t.id), [t1.id, t2.id]);
  assert.equal(b.activeId, t1.id);
  const p = b.add({ pinned: true });
  const x = a.detach(t3.id); x.pinned = true; b.attach(x, 99);
  assert.deepEqual(b.tabs.map((t) => t.id), [p.id, x.id, t1.id, t2.id], 'a pinned tab stays inside the pinned block');
  assert.equal(a.detach(999), null);
  assert.equal(a.activeId, null);
});
test('v3 allowlist: gid is optional and checked, windows calls need real ids', () => {
  const { check } = require('../src/main/lib/ipc-allowlist');
  const ok = (ch, ...a) => check('web', 'br:' + ch, a).ok;
  assert.equal(ok('ready'), true); assert.equal(ok('ready', { gid: 2 }), true); assert.equal(ok('ready', { gid: 0 }), false); assert.equal(ok('ready', { gid: 'x' }), false);
  assert.equal(ok('ready', undefined), true);
  assert.equal(ok('setBounds', { x: 0, y: 0, w: 1, h: 1, gid: 3 }), true); assert.equal(ok('setBounds', { x: 0, y: 0, w: 1, h: 1, gid: -1 }), false);
  assert.equal(ok('setOccluded', true, { gid: 2 }), true); assert.equal(ok('setOccluded', true, { gid: 1.5 }), false);
  assert.equal(ok('capture'), true); assert.equal(ok('capture', { gid: 2 }), true); assert.equal(ok('capture', 'x'), false);
  assert.equal(ok('newTab', { url: 'https://a.com', gid: 2 }), true); assert.equal(ok('newTab', { gid: 'a' }), false);
  assert.equal(ok('reopenClosed'), true); assert.equal(ok('reopenClosed', { gid: 2 }), true);
  assert.equal(ok('fullscreen', false), true); assert.equal(ok('fullscreen', false, { gid: 2 }), true); assert.equal(ok('fullscreen', 'no'), false);
  assert.equal(ok('windows.create'), true); assert.equal(ok("windows.create", 1), false); assert.equal(ok("windows.create", { webapp: "gmail" }), true); assert.equal(ok("windows.create", { webapp: 5 }), false);
  assert.equal(ok('windows.close', 2), true); assert.equal(ok('windows.close'), false); assert.equal(ok('windows.close', 'a'), false);
  assert.equal(ok('windows.focus', 2), true); assert.equal(ok('windows.list'), true);
  assert.equal(ok('moveTab', 5, 'new'), true); assert.equal(ok('moveTab', 5, 2), true); assert.equal(ok('moveTab', 5, 2, { index: 0 }), true);
  assert.equal(ok('moveTab', 5, 'old'), false); assert.equal(ok('moveTab', 5), false); assert.equal(ok('moveTab', 5, 2, { index: -1 }), false); assert.equal(ok('moveTab', 'a', 2), false);
  for (const ch of ['windows.create', 'windows.close', 'windows.focus', 'windows.list', 'moveTab']) assert.equal(check('page', 'br:' + ch, ch === 'windows.close' || ch === 'windows.focus' ? [1] : ch === 'moveTab' ? [1, 'new'] : []).ok, false, 'pages cannot call ' + ch);
});
test('v3: Ctrl+N is a new window, Ctrl+Shift+N stays a private tab', () => {
  const k = (o) => actionForKey({ type: 'keyDown', ...o }, 'linux');
  assert.equal(k({ key: 'n', control: true }), 'newWindow');
  assert.equal(k({ key: 'N', control: true, shift: true }), 'newPrivate');
});
test('v3 service shape: per-group state, bounds, occlusion, fullscreen; events carry gid', () => {
  const svc = read('src/main/browser-service.js');
  assert.ok(!/this\.model\b|this\.fsTab\b|this\.occluded\b/.test(svc), 'no single-window globals left');
  for (const k of ["'br:windows.create'", "'br:windows.close'", "'br:windows.focus'", "'br:windows.list'", "'br:moveTab'", 'closeGroup(', 'moveTab(', "emit('windows'", 'restoreGroups']) assert.ok(svc.includes(k), k);
  for (const ev of ["emit('fullscreen', { on: true, tabId: id, gid", "emit('find-result', { gid", "emit('menu', { action: a, gid", "{ focused: true, gid"]) assert.ok(svc.includes(ev), ev);
});

test('save-password offers: page channel is checked, bridge calls need the Mayfair view', () => {
  const { check } = require('../src/main/lib/ipc-allowlist');
  const good = { username: 'ann@example.com', password: 'pw', kind: 'new', settled: false };
  assert.equal(check('page', 'page:pwSubmit', [good]).ok, true);
  assert.equal(check('page', 'page:pwSubmit', [{ ...good, password: '' }]).ok, false, 'empty password is never handed over');
  assert.equal(check('page', 'page:pwSubmit', [{ ...good, password: 'x'.repeat(1001) }]).ok, false);
  assert.equal(check('page', 'page:pwSubmit', [{ ...good, kind: 'other' }]).ok, false);
  assert.equal(check('page', 'page:pwSubmit', [{ ...good, settled: 'yes' }]).ok, false);
  assert.equal(check('page', 'page:pwSubmit', [{ ...good, username: 5 }]).ok, false);
  assert.equal(check('web', 'page:pwSubmit', [good]).ok, false, 'the Mayfair view cannot fake a submission');
  assert.equal(check('page', 'page:pwFocus', []).ok, true);
  const w = (ch, ...a) => check('web', 'br:' + ch, a).ok;
  assert.equal(w('passwords.take', 'o1'), true); assert.equal(w('passwords.take', 5), false); assert.equal(w('passwords.take'), false);
  assert.equal(w('passwords.dismiss', 'o1'), true); assert.equal(w('passwords.dismiss', 'o1', { never: true }), true); assert.equal(w('passwords.dismiss', 'o1', { never: 'x' }), false);
  assert.equal(check('page', 'br:passwords.take', ['o1']).ok, false);
  const svc = read('src/main/browser-service.js');
  assert.ok(/m\.private \|\| m\.tor/.test(svc), 'private and Tor tabs never offer');
  assert.ok(!/console\.\w+\([^)]*password/i.test(svc), 'passwords are never logged');
  const { Settings } = require('../src/main/lib/settings');
  const st = new Settings(path.join(require('node:os').tmpdir(), 'mfd-set-' + process.pid + '.json'));
  assert.deepEqual(st.get().passwordNever, []);
  assert.deepEqual(st.set({ passwordNever: ['https://a.com'] }), ['passwordNever']);
  assert.deepEqual(st.get().passwordNever, ['https://a.com']);
  assert.deepEqual(st.set({ passwordNever: [5] }), [], 'wrong type ignored'); assert.deepEqual(st.set({ passwordNever: ['https://a.com'] }), [], 'unchanged list is not a change');
  assert.equal(st.get().passwordOffer, true);
});
