'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BookmarkStore, HistoryStore, SitePermissionStore } = require('../src/main/lib/stores');
const { Settings, DEFAULTS } = require('../src/main/lib/settings');
const { sanitizeBounds, WindowState } = require('../src/main/lib/windowstate');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-'));

test('bookmarks: add, dedupe, toggle, remove, persist', () => {
  const f = path.join(tmp(), 'b.json');
  const b = new BookmarkStore(f, { delay: 1 });
  const a = b.add('https://a.com/x', 'A');
  assert.equal(b.add('https://a.com/x', 'again').id, a.id);
  assert.equal(b.list().length, 1);
  assert.equal(b.add('javascript:1', 'x'), null);
  assert.equal(b.add('file:///x', 'x'), null);
  assert.deepEqual(b.toggle('https://b.com', 'B'), { on: true });
  assert.deepEqual(b.toggle('https://b.com'), { on: false });
  assert.equal(b.has('https://b.com'), false);
  b.flush();
  const again = new BookmarkStore(f);
  assert.equal(again.list().length, 1);
  assert.ok(again.has('https://a.com/x'));
  assert.ok(again.remove(a.id));
  assert.equal(again.remove('nope'), false);
});
test('history: newest first, merges repeats, caps, search, clear, private never stored', () => {
  const f = path.join(tmp(), 'h.json');
  const h = new HistoryStore(f, { max: 3, delay: 1 });
  h.add('https://a.com', 'A', 1);
  h.add('https://a.com', 'A2', 2);
  assert.equal(h.list().length, 1);
  assert.equal(h.list()[0].title, 'A2');
  h.add('https://b.com', 'Bee', 3); h.add('https://c.com', 'C', 4); h.add('https://d.com', 'D', 5);
  assert.deepEqual(h.list().map((x) => x.url), ['https://d.com/', 'https://c.com/', 'https://b.com/'].map((x) => x.replace(/\/$/, '')).map((x) => x + '/'));
  assert.equal(h.add('https://secret.com', 's', 6, { private: true }), null);
  assert.equal(h.search('secret').length, 0);
  assert.equal(h.search('bee').length, 1);
  assert.equal(h.add('chrome://settings', 'x'), null);
  h.clear(5); // removes entries visited at or after t=5
  assert.equal(h.list().length, 2);
  h.clear();
  assert.equal(h.list().length, 0);
  h.flush();
  assert.equal(new HistoryStore(f).list().length, 0);
});
test('stores survive a corrupt file', () => {
  const d = tmp(); const f = path.join(d, 'x.json');
  fs.writeFileSync(f, '{not json');
  assert.equal(new BookmarkStore(f).list().length, 0);
  fs.writeFileSync(f, '[1,2]');
  assert.equal(new HistoryStore(f).list().length, 0);
  fs.writeFileSync(f, JSON.stringify({ items: 'oops' }));
  assert.equal(new BookmarkStore(f).list().length, 0);
});
test('site permissions: default ask, allow, deny, reset, unknown permission refused', () => {
  const p = new SitePermissionStore(path.join(tmp(), 'p.json'), { delay: 1 });
  assert.equal(p.get('https://a.com', 'media'), 'ask');
  assert.ok(p.set('https://a.com', 'media', 'allow'));
  assert.equal(p.get('https://a.com', 'media'), 'allow');
  assert.equal(p.get('https://b.com', 'media'), 'ask');
  p.set('https://a.com', 'media', 'deny');
  assert.equal(p.get('https://a.com', 'media'), 'deny');
  assert.equal(p.set('https://a.com', 'evil-perm', 'allow'), false);
  p.set('https://a.com', 'media', null);
  assert.deepEqual(p.all(), {});
  p.set('https://a.com', 'popups', 'allow'); p.resetSite('https://a.com');
  assert.equal(p.get('https://a.com', 'popups'), 'ask');
});
test('settings: defaults, validation, unknown keys ignored', () => {
  const s = new Settings(path.join(tmp(), 's.json'), { delay: 1 });
  assert.equal(s.get().startFullscreen, true);
  assert.deepEqual(s.set({ startFullscreen: false, bogus: 1, tray: 'yes', searchEngine: 'evil', downloadMode: 'folder' }), ['startFullscreen', 'downloadMode']);
  assert.equal(s.get().startFullscreen, false);
  assert.equal(s.get().tray, DEFAULTS.tray);
  assert.equal(s.get().searchEngine, 'google');
  assert.equal(s.get().bogus, undefined);
  assert.deepEqual(s.set({ startFullscreen: false }), []);
});
test('window state: off-screen bounds are pulled back, small ones enlarged', () => {
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
  assert.deepEqual(sanitizeBounds({ x: 100, y: 80, width: 1200, height: 800 }, displays), { x: 100, y: 80, width: 1200, height: 800 });
  const off = sanitizeBounds({ x: 5000, y: 5000, width: 1200, height: 800 }, displays);
  assert.ok(off.x >= 0 && off.x + off.width <= 1920 && off.y >= 0);
  const small = sanitizeBounds({ x: 10, y: 10, width: 100, height: 100 }, displays);
  assert.ok(small.width >= 900 && small.height >= 600);
  const nan = sanitizeBounds({ x: NaN }, displays);
  assert.ok(nan.width > 0 && Number.isFinite(nan.x));
  assert.ok(sanitizeBounds(null, displays).width > 0);
  // monitor unplugged: window was on a second display at x=2000
  assert.ok(sanitizeBounds({ x: 2100, y: 50, width: 1000, height: 700 }, displays).x < 1920);
  // still visible on a second display
  const two = [...displays, { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } }];
  assert.equal(sanitizeBounds({ x: 2100, y: 50, width: 1000, height: 700 }, two).x, 2100);
});
test('window state persists', () => {
  const f = path.join(tmp(), 'w.json');
  const w = new WindowState(f, { delay: 1 });
  w.update({ maximized: true, bounds: { x: 1, y: 2, width: 3, height: 4 } });
  w.flush();
  assert.equal(new WindowState(f).get().maximized, true);
  assert.equal(new WindowState(f).get().fullscreen, null);
});
