'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/ui/ghost/case-model');
const { CaseStore } = require('../src/main/ghost/app/cases');
const { GhostService } = require('../src/main/ghost');
const { tmp, fakeOS, FAST } = require('./ghost-app-helpers');

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
function store(clock) { const root = tmp(); const g = new GhostService({ root, dialog: {}, isPackaged: false, safeStorage: fakeOS(), useVault: true, vaultOptions: FAST }); return { root, g, s: new CaseStore({ vault: g.vaultSvc.vault, now: () => clock.t }) }; }

test('cases are sealed in the vault: the marker never appears on disk', () => {
  const clock = { t: Date.now() }; const { root, g, s } = store(clock);
  const c = JSON.parse(s.create('Case SEALED-MARKER-77').json);
  M.addEntity(c, { type: 'domain', value: 'sealed-marker-domain.example', manual: true }); s.put(c.id, JSON.stringify(c));
  assert.equal(JSON.parse(s.get(c.id)).entities[Object.keys(c.entities)[0]].label, 'sealed-marker-domain.example');
  for (const f of walk(root)) { const b = fs.readFileSync(f); assert.equal(b.includes(Buffer.from('SEALED-MARKER')) || b.includes(Buffer.from('sealed-marker-domain')), false, f); }
  assert.equal(s.list().length, 1); g.shutdown();
});
test('put validates: wrong id, unsourced entity, garbage and oversize are refused', () => {
  const clock = { t: Date.now() }; const { g, s } = store(clock);
  const c = JSON.parse(s.create('x').json);
  assert.throws(() => s.put('abcd1234efgh', JSON.stringify(c)), (e) => e.code === 'bad-case');
  assert.throws(() => s.put(c.id, '{not json'), (e) => e.code === 'bad-case');
  M.addEntity(c, { type: 'domain', value: 'u.example', manual: false });
  assert.throws(() => s.put(c.id, JSON.stringify(c)), (e) => e.code === 'invalid');
  assert.throws(() => s.get('../x'), (e) => e.code === 'bad-id'); assert.throws(() => s.get('abcd1234efgh'), (e) => e.code === 'missing');
  assert.throws(() => s.put(c.id, 'x'.repeat(33 * 1024 * 1024)), (e) => e.code === 'too-large'); g.shutdown();
});
test('backups are taken at most every five minutes, trimmed to 20, and restorable', () => {
  const clock = { t: 1_800_000_000_000 }; const { g, s } = store(clock);
  const c = JSON.parse(s.create('v0').json);
  for (let i = 1; i <= 30; i++) { clock.t += 6 * 60 * 1000; c.title = 'v' + i; s.put(c.id, JSON.stringify(c)); }
  const b = s.backups(c.id); assert.ok(b.length <= 20 && b.length >= 10, 'kept ' + b.length);
  clock.t += 1000; c.title = 'quick'; s.put(c.id, JSON.stringify(c)); c.title = 'quick2'; s.put(c.id, JSON.stringify(c)); assert.ok(s.backups(c.id).length <= b.length + 1);
  const old = s.restore(c.id, b[b.length - 1].name || b[b.length - 1]); assert.notEqual(JSON.parse(old).title, 'quick2'); g.shutdown();
});
test('delete removes the case and its backups', () => {
  const clock = { t: Date.now() }; const { g, s } = store(clock); const c = JSON.parse(s.create('d').json); clock.t += 6 * 60e3; c.title = 'd2'; s.put(c.id, JSON.stringify(c)); s.delete(c.id);
  assert.equal(s.list().length, 0); assert.equal(s.backups(c.id).length, 0); g.shutdown();
});
