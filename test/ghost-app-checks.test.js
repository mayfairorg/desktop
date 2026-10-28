'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { check, CALLS, EVENTS } = require('../src/main/ghost/app/checks');
const T = require('../src/main/ghost/app/terms-text');

test('unknown channels, prototype keys and wrong argument counts are refused', () => {
  for (const ch of ['gapp:exec', '__proto__', 'constructor', 'toString', '', 'br:ready', 'fs:read']) assert.equal(check(ch, []).ok, false, ch);
  assert.equal(check('gapp:status', [1]).ok, false); assert.equal(check('gapp:cases.get', []).ok, false);
});
test('arguments are shaped: ids, inputs, scope, report', () => {
  assert.equal(check('gapp:cases.get', ['../../etc/passwd']).ok, false); assert.equal(check('gapp:cases.get', ['abcd1234efgh']).ok, true);
  assert.equal(check('gapp:jobs.run', [{ connector: 'dns-doh', input: { domain: 'example.org' } }]).ok, true);
  assert.equal(check('gapp:jobs.run', [{ connector: 'dns-doh', input: { domain: 'example.org' }, argv: ['x'] }]).ok, false, 'no extra keys');
  assert.equal(check('gapp:jobs.run', [{ connector: 'dns-doh', input: JSON.parse('{"__proto__":"x"}') }]).ok, false);
  assert.equal(check('gapp:jobs.run', [{ connector: '../x', input: {} }]).ok, false);
  assert.equal(check('gapp:scan.run', [{ connector: 'nmap', scopeId: 'nope', input: {} }]).ok, false);
  assert.equal(check('gapp:scan.run', [{ connector: 'nmap', scopeId: 'sc-0123456789abcdef', input: {} }]).ok, true);
  assert.equal(check('gapp:report.save', [{ json: '{}', format: 'exe' }]).ok, false); assert.equal(check('gapp:report.save', [{ json: '{}', format: 'pdf' }]).ok, true);
  assert.equal(check('gapp:terms.accept', [{ version: T.VERSION, sha256: T.SHA256, lawful: true }]).ok, true);
  assert.equal(check('gapp:terms.accept', [{ version: T.VERSION, sha256: 'x', lawful: true }]).ok, false);
});
test('there is no call that takes a command, path, or arguments', () => {
  for (const ch of Object.keys(CALLS)) assert.equal(/exec|spawn|shell|argv|path|command|eval/i.test(ch), false, ch);
  assert.deepEqual(EVENTS, ['gapp:status', 'gapp:install', 'gapp:job', 'gapp:window', 'gapp:builtins', 'gapp:search']);
});
test('the Ghost channels are not part of the Browser bridge allowlist', () => {
  const { CH, BR } = require('../src/main/lib/ipc-allowlist');
  for (const ch of Object.keys(CALLS)) { assert.equal(ch in CH, false); assert.equal(ch.replace(/^gapp:/, '') in BR, false); }
  assert.ok('ghost.app.library' in BR && 'ghost.app.open' in BR && 'ghost.app.remove' in BR);
});
