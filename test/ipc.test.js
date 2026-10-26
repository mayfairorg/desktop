'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CH, check, channelsFor, EVENTS } = require('../src/main/lib/ipc-allowlist');

test('unknown channels and prototype keys are refused for every role', () => {
  for (const role of ['chrome', 'overlay', 'web', 'page', 'nobody', null]) {
    for (const ch of ['fs:read', 'shell:exec', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '']) assert.equal(check(role, ch, []).ok, false, role + ' ' + ch);
  }
});
test('roles are separated: untrusted pages only get password detection', () => {
  assert.deepEqual(channelsFor('page'), ['page:pwDetected']);
  assert.equal(check('page', 'page:pwDetected', [true]).ok, true);
  assert.equal(check('page', 'web:readFile', ['tok']).ok, false);
  assert.equal(check('page', 'tab:new', []).ok, false);
  assert.equal(check('page', 'settings:set', [{ adblock: false }]).ok, false);
});
test('the Mayfair web role cannot drive the browser chrome', () => {
  for (const ch of ['tab:close', 'settings:set', 'hist:clear', 'bm:list', 'perm:setSite', 'app:quit', 'dl:open']) assert.equal(check('web', ch, []).ok, false, ch);
  assert.equal(check('web', 'web:openBrowser', ['https://example.com']).ok, true);
});
test('browser UI roles cannot use the web bridge', () => {
  for (const role of ['chrome', 'overlay']) for (const ch of channelsFor('web')) assert.equal(check(role, ch, ['x']).ok, false, role + ' ' + ch);
});
test('argument validation', () => {
  assert.equal(check('chrome', 'tab:close', [3]).ok, true);
  assert.equal(check('chrome', 'tab:close', ['3']).ok, false);
  assert.equal(check('chrome', 'tab:close', [-1]).ok, false);
  assert.equal(check('chrome', 'tab:close', [1.5]).ok, false);
  assert.equal(check('chrome', 'tab:close', [3, 4]).ok, false);
  assert.equal(check('chrome', 'tab:close', []).ok, false);
  assert.equal(check('chrome', 'tab:go', ['x'.repeat(5000)]).ok, false);
  assert.equal(check('chrome', 'tab:new', []).ok, true);
  assert.equal(check('chrome', 'tab:new', [{ url: 'https://a.com', private: true }]).ok, true);
  assert.equal(check('chrome', 'tab:new', [{ url: 5 }]).ok, false);
  assert.equal(check('chrome', 'tab:new', ['x']).ok, false);
  assert.equal(check('chrome', 'tab:back', [1]).ok, false);
  assert.equal(check('chrome', 'tab:back', 'notarray').ok, false);
  assert.equal(check('chrome', 'zoom:set', ['evil']).ok, false);
  assert.equal(check('chrome', 'zoom:set', ['in']).ok, true);
  assert.equal(check('chrome', 'panel:open', ['downloads']).ok, true);
  assert.equal(check('chrome', 'panel:open', ['devtools']).ok, false);
  assert.equal(check('chrome', 'settings:set', [[1]]).ok, false);
  assert.equal(check('chrome', 'settings:set', [null]).ok, false);
  assert.equal(check('chrome', 'settings:set', [{ tray: true }]).ok, true);
});
test('permission answers only from the overlay, with a real decision', () => {
  assert.equal(check('overlay', 'perm:answer', ['p1', 'allow', true]).ok, true);
  assert.equal(check('overlay', 'perm:answer', ['p1', 'maybe', true]).ok, false);
  assert.equal(check('chrome', 'perm:answer', ['p1', 'allow', true]).ok, false);
  assert.equal(check('web', 'perm:answer', ['p1', 'allow', true]).ok, false);
  assert.equal(check('page', 'perm:answer', ['p1', 'allow', true]).ok, false);
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
});
test('a throwing validator fails closed', () => {
  CH['test:throw'] = { roles: ['chrome'], check: () => { throw new Error('boom'); } };
  assert.equal(check('chrome', 'test:throw', []).ok, false);
  delete CH['test:throw'];
});
test('every channel names at least one role and a checker; events are declared', () => {
  for (const [name, def] of Object.entries(CH)) { assert.ok(def.roles.length, name); assert.equal(typeof def.check, 'function', name); }
  for (const r of ['chrome', 'overlay', 'web', 'page']) assert.ok(Array.isArray(EVENTS[r]));
});
test('main-process handlers cover exactly the allowlist (no orphan channels)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main/browser.js'), 'utf8');
  for (const ch of Object.keys(CH)) assert.ok(src.includes("'" + ch + "'"), 'no handler for ' + ch);
  // handlers registered with ipcMain must come only from the allowlist loop
  assert.equal((src.match(/ipcMain\.handle\(/g) || []).length, 1);
});
