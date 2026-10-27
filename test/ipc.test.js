'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CH, BR, BR_EVENTS, check, channelsFor, EVENTS } = require('../src/main/lib/ipc-allowlist');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('unknown channels and prototype keys are refused for every role', () => {
  for (const role of ['web', 'start', 'page', 'chrome', 'overlay', 'nobody', null]) {
    for (const ch of ['fs:read', 'shell:exec', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '', 'br:__proto__', 'br:exec']) assert.equal(check(role, ch, []).ok, false, role + ' ' + ch);
  }
});
test('there is no UI role any more: the old strip and overlay channels are gone', () => {
  assert.deepEqual(channelsFor('chrome'), []);
  assert.deepEqual(channelsFor('overlay'), []);
  for (const ch of ['tab:new', 'panel:open', 'find:run', 'perm:answer', 'zoom:set', 'settings:set']) assert.equal(ch in CH, false, ch);
});
test('roles are separated: untrusted pages only get password detection, login hand-over and the focus hint', () => {
  assert.deepEqual(channelsFor('page').sort(), ['page:afFocus', 'page:afSubmit', 'page:pwDetected', 'page:pwFocus', 'page:pwSubmit']);
  assert.equal(check('start', 'page:pwSubmit', [{ username: 'a', password: 'b', kind: 'new', settled: false }]).ok, false, 'the start page cannot hand over logins');
  assert.equal(check('page', 'page:pwDetected', [true]).ok, true);
  assert.equal(check('page', 'web:readFile', ['tok']).ok, false);
  assert.equal(check('page', 'br:ready', []).ok, false);
  assert.equal(check('page', 'br:newTab', [{}]).ok, false);
});
test('the start page may use search channels and nothing of the bridge', () => {
  assert.equal(check('start', 'search:go', ['x']).ok, true);
  for (const ch of Object.keys(CH).filter((c) => c.startsWith('br:') || c.startsWith('web:'))) assert.equal(check('start', ch, []).ok, false, ch);
  for (const r of ['page', 'web']) assert.equal(check(r, 'search:go', ['x']).ok, false, r);
});
test('every Browser bridge channel is for the Mayfair role only', () => {
  const br = Object.keys(CH).filter((c) => c.startsWith('br:'));
  assert.equal(br.length, Object.keys(BR).length);
  for (const ch of br) assert.deepEqual(CH[ch].roles, ['web'], ch);
});
test('the preload exposes exactly the allowlisted calls and events', () => {
  const src = read('src/preload/web.js');
  const list = (name) => [...src.match(new RegExp(name + " = \\[([^\\]]*)\\]", 's'))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(list('BR_NAMES').sort(), Object.keys(BR).filter((k) => k !== 'subscribe').sort());
  assert.deepEqual(list('BR_EVENTS').sort(), [...BR_EVENTS].sort());
  assert.match(src, /MAYFAIR\.includes\(location\.origin\)/);
  assert.match(src, /browser,\n/);
});
test('argument validation of the bridge', () => {
  const ok = (n, ...a) => check('web', 'br:' + n, a).ok;
  assert.equal(ok('closeTab', 3), true);
  assert.equal(ok('closeTab', '3'), false);
  assert.equal(ok('closeTab', -1), false);
  assert.equal(ok('closeTab', 1.5), false);
  assert.equal(ok('closeTab', 3, 4), false);
  assert.equal(ok('closeTab'), false);
  assert.equal(ok('go', 1, 'x'.repeat(5000)), false);
  assert.equal(ok('go', 1, 'cats'), true);
  assert.equal(ok('go', 1, 5), false);
  assert.equal(ok('newTab'), true);
  assert.equal(ok('newTab', { url: 'https://a.com', private: true, webapp: 'gmail' }), true);
  assert.equal(ok('newTab', { url: 5 }), false);
  assert.equal(ok('newTab', 'x'), false);
  assert.equal(ok('setBounds', { x: 1, y: 2, w: 3, h: 4 }), true);
  assert.equal(ok('setBounds', { x: 1, y: 2, w: 3, h: 4, visible: false }), true);
  assert.equal(ok('setBounds', { x: 'a', y: 2, w: 3, h: 4 }), false);
  assert.equal(ok('setBounds', { x: NaN, y: 2, w: 3, h: 4 }), false);
  assert.equal(ok('setBounds', { x: Infinity, y: 2, w: 3, h: 4 }), false);
  assert.equal(ok('setOccluded', true), true);
  assert.equal(ok('setOccluded', true, { focus: true }), true);
  assert.equal(ok('setOccluded', 'yes'), false);
  assert.equal(ok('zoom', 1, 'reset'), true);
  assert.equal(ok('zoom', 1, 1), true);
  assert.equal(ok('zoom', 1, 'evil'), false);
  assert.equal(ok('zoom', 1, 99), false);
  assert.equal(ok('find', 1, 'x'), true);
  assert.equal(ok('find', 1, 'x', { forward: false, findNext: true }), true);
  assert.equal(ok('find', 1, 'x', 5), false);
  assert.equal(ok('settings.set', { adblock: false }), true);
  assert.equal(ok('settings.set', [1]), false);
  assert.equal(ok('settings.set', null), false);
  assert.equal(ok('settings.setProxy', 'socks5', 'h.example', 1080), true);
  assert.equal(ok('settings.setProxy', 'ftp', 'h.example', 1080), false);
  assert.equal(ok('permissions.answer', 'p1', true, false), true);
  assert.equal(ok('permissions.answer', 'p1', 'maybe', false), false);
  assert.equal(ok('permissions.set', 'https://a.com', 'media', 'allow'), true);
  assert.equal(ok('permissions.set', 'https://a.com', 'media', 'always'), false);
  assert.equal(ok('bookmarks.add', { url: 'https://a.com', title: 'A' }), true);
  assert.equal(ok('bookmarks.add', { title: 'A' }), false);
  assert.equal(ok('bookmarks.import', new Array(5001).fill({ url: 'https://a.com' })), false);
  assert.equal(ok('bookmarks.import', [{ url: 'https://a.com', title: 'A' }]), true);
  assert.equal(ok('history.search', 'x', 10), true);
  assert.equal(ok('history.search', 'x', 99999), false);
  assert.equal(ok('webapps.open', 'gmail', { window: true }), true);
  assert.equal(ok('webapps.open', 'gmail', 'window'), false);
  assert.equal(ok('extensions.install', 'deals', 'https://cloud.mayfairmail.com/ext/x.zip', 'a'.repeat(64)), true);
  assert.equal(ok('subscribe', 'menu', true), true);
  assert.equal(ok('subscribe', 'menu', 1), false);
  assert.equal(check('web', 'br:closeTab', 'notarray').ok, false);
});
test('web bridge arguments: notify, password reply, file token', () => {
  assert.equal(check('web', 'web:notify', [{ title: 'Hi', body: 'x' }]).ok, true);
  assert.equal(check('web', 'web:notify', [{ title: 5 }]).ok, false);
  assert.equal(check('web', 'web:notify', ['str']).ok, false);
  assert.equal(check('web', 'web:notify', [{ title: 'x'.repeat(500) }]).ok, false);
  assert.equal(check('web', 'web:pwRespond', ['q1', [{ username: 'a', password: 'b' }]]).ok, true);
  assert.equal(check('web', 'web:pwRespond', ['q1', [{ username: 'a', password: 5 }]]).ok, false);
  assert.equal(check('web', 'web:pwRespond', ['q1', new Array(50).fill({ username: 'a', password: 'b' })]).ok, false);
  assert.equal(check('web', 'web:pwRespond', ['q1', 'nope']).ok, false);
  assert.equal(check('web', 'web:readFile', [{ path: '/etc/passwd' }]).ok, false);
  assert.equal(check('web', 'web:badge', [-1]).ok, false);
  assert.equal(check('web', 'web:badge', [3]).ok, true);
  assert.equal(check('web', 'web:openBrowser', ['https://example.com']).ok, true);
});
test('a throwing validator fails closed', () => {
  CH['test:throw'] = { roles: ['web'], check: () => { throw new Error('boom'); } };
  assert.equal(check('web', 'test:throw', []).ok, false);
  delete CH['test:throw'];
});
test('every channel names at least one role and a checker; events are declared', () => {
  for (const [name, def] of Object.entries(CH)) { assert.ok(def.roles.length, name); assert.equal(typeof def.check, 'function', name); }
  for (const r of ['web', 'start', 'page']) assert.ok(Array.isArray(EVENTS[r]));
  assert.ok(EVENTS.web.includes('br:ev'));
  for (const e of ['state', 'find-result', 'download', 'permission-request', 'new-window-request', 'open-url', 'fullscreen']) assert.ok(BR_EVENTS.includes(e), e);
});
test('main-process handlers cover exactly the allowlist (no orphan channels)', () => {
  const src = read('src/main/browser-service.js');
  for (const ch of Object.keys(CH)) assert.ok(src.includes("'" + ch + "'"), 'no handler for ' + ch);
  // handlers registered with ipcMain must come only from the allowlist loop
  assert.equal((src.match(/ipcMain\.handle\(/g) || []).length, 1);
  // every handler key is an allowlisted channel
  const keys = [...src.matchAll(/^\s{6}'((?:br|web|search|page):[A-Za-z.:]+)':/gm)].map((m) => m[1]);
  for (const k of keys) assert.ok(k in CH, 'handler without allowlist entry: ' + k);
});
test('the bridge checks the sender: Mayfair view, main frame, Mayfair origin', () => {
  const src = read('src/main/browser-service.js');
  assert.match(src, /e\.sender === this\.home\.wc && e\.senderFrame === e\.sender\.mainFrame && O\.isMayfairUrl\(e\.senderFrame\.url\)/);
});
