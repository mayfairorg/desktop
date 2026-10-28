'use strict';
// The strict argument checks for the new calls, the preload names and the window's handlers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { check, CALLS, EVENTS } = require('../src/main/ghost/app/checks');

const ok = (ch, ...a) => check(ch, a).ok, no = (ch, ...a) => !check(ch, a).ok;

test('builtins.status takes nothing', () => {
  assert.ok(ok('gapp:builtins.status')); assert.ok(no('gapp:builtins.status', {})); assert.ok(no('gapp:builtins.status', 'x'));
});
test('search.classify takes exactly { query: text up to 2000 characters }', () => {
  assert.ok(ok('gapp:search.classify', { query: 'example.com' })); assert.ok(ok('gapp:search.classify', { query: '' })); assert.ok(ok('gapp:search.classify', { query: 'x'.repeat(2000) }));
  for (const bad of [{ query: 'x'.repeat(2001) }, { query: 5 }, {}, { query: 'a', extra: 1 }, { query: 'a\0b' }, 'example.com', null, [], [{ query: 'a' }]]) assert.ok(no('gapp:search.classify', bad), JSON.stringify(bad));
  assert.ok(no('gapp:search.classify')); assert.ok(no('gapp:search.classify', { query: 'a' }, 1));
});
test('search.run takes { query, kind?, tools?, caseId? } and nothing else', () => {
  const g = 'abcdefgh12345678';
  assert.ok(ok('gapp:search.run', { query: 'example.com' }));
  assert.ok(ok('gapp:search.run', { query: 'example.com', kind: 'domain', tools: ['dns-doh', 'rdap-domain'], caseId: 'case-1234abcd' }));
  assert.ok(ok('gapp:search.run', { query: g, kind: 'file' }));
  for (const k of ['domain', 'ip', 'cidr', 'asn', 'url', 'cert-hash', 'org-name', 'lei', 'file', 'place-text', 'coords', 'keyword']) assert.ok(ok('gapp:search.run', { query: 'x', kind: k }), k);
  const bad = [
    {}, { query: '' }, { query: '   ' }, { query: 5 }, { query: 'x'.repeat(2001) }, { query: 'a\0' },
    { query: 'a', kind: 'email' }, { query: 'a', kind: 'username' }, { query: 'a', kind: 'person' }, { query: 'a', kind: 'phone' }, { query: 'a', kind: 'entity' }, { query: 'a', kind: 'rules-file' }, { query: 'a', kind: 'instance-url' }, { query: 'a', kind: 7 },
    { query: 'a', tools: [] }, { query: 'a', tools: 'dns-doh' }, { query: 'a', tools: ['DNS'] }, { query: 'a', tools: ['../x'] }, { query: 'a', tools: [1] }, { query: 'a', tools: ['dns-doh', 'dns-doh'] }, { query: 'a', tools: Array.from({ length: 65 }, (_, i) => 't' + i + 'x') },
    { query: 'a', caseId: 'x' }, { query: 'a', caseId: '../../etc' }, { query: 'a', caseId: 5 },
    { query: 'a', command: 'ls' }, { query: 'a', path: '/etc/passwd' }, { query: 'a', scope: { target: 'x' } }, { query: 'a', input: {} }, null, 'x', [], [{ query: 'a' }],
  ];
  for (const b of bad) assert.ok(no('gapp:search.run', b), JSON.stringify(b));
  assert.ok(no('gapp:search.run')); assert.ok(no('gapp:search.run', { query: 'a' }, { query: 'b' }));
});
test('search.cancel takes exactly { searchId } in the form the app hands out', () => {
  assert.ok(ok('gapp:search.cancel', { searchId: 's-0123456789abcdef' }));
  for (const bad of [{}, { searchId: 's-0123' }, { searchId: 'j-0123456789abcdef' }, { searchId: 's-0123456789ABCDEF' }, { searchId: 5 }, { searchId: 's-0123456789abcdef', x: 1 }, 's-0123456789abcdef', null]) assert.ok(no('gapp:search.cancel', bad), JSON.stringify(bad));
});
test('the new events are on the list and the new calls do not carry a command, a path or arguments', () => {
  assert.ok(EVENTS.includes('gapp:builtins') && EVENTS.includes('gapp:search'));
  for (const ch of ['gapp:builtins.status', 'gapp:search.classify', 'gapp:search.run', 'gapp:search.cancel']) assert.ok(ch in CALLS);
});
test('the window answers every new call, the preload exposes them, and the bridge document describes them', () => {
  const win = fs.readFileSync(path.join(__dirname, '../src/main/ghost/app/window.js'), 'utf8');
  for (const ch of ['gapp:builtins.status', 'gapp:search.classify', 'gapp:search.run', 'gapp:search.cancel']) assert.ok(win.includes("'" + ch + "'"), ch);
  const pre = fs.readFileSync(path.join(__dirname, '../src/ui/ghost/preload.js'), 'utf8');
  for (const ch of ['gapp:builtins.status', 'gapp:search.classify', 'gapp:search.run', 'gapp:search.cancel', 'gapp:builtins', 'gapp:search']) assert.ok(pre.includes("'" + ch + "'"), ch);
  assert.match(pre, /onBuiltins/); assert.match(pre, /onSearch/);
  const doc = fs.readFileSync(path.join(__dirname, '../docs/ghost-app.md'), 'utf8');
  for (const ch of ['gapp:builtins.status', 'gapp:search.classify', 'gapp:search.run', 'gapp:search.cancel']) assert.ok(doc.includes(ch), ch + ' is in docs/ghost-app.md');
});
