'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/ui/ghost/scope-parse');
const { ScopeGuard } = require('../src/main/ghost/app/scopelog');

const mem = () => { const chunks = []; return { append: (n, t) => { chunks.push(t); }, readAll: () => chunks.slice(), _c: chunks }; };

test('targets: one domain, one IP, small ranges only', () => {
  for (const ok of ['example.org', 'EXAMPLE.org.', '203.0.113.5', '203.0.113.0/24', '203.0.113.0/28', '2001:db8::1']) assert.equal(P.parseTarget(ok).ok, true, ok);
  for (const bad of ['', '*.example.org', 'example.org, example.com', '10.0.0.0/8', '10.0.0.0/16', '0.0.0.0/0', '203.0.113.1-203.0.113.9', 'com', '.com', 'a@example.org', 'http://example.org/x', '2001:db8::/32']) assert.equal(P.parseTarget(bad).ok, false, bad);
});
test('inside: hosts and ranges against a declared target', () => {
  assert.equal(P.inside('203.0.113.0/28', '203.0.113.7'), true); assert.equal(P.inside('203.0.113.0/28', '203.0.113.20'), false);
  assert.equal(P.inside('example.org', 'example.org'), true); assert.equal(P.inside('example.org', 'example.com'), false); assert.equal(P.inside('example.org', 'a.example.org'), false);
});
test('people queries are refused before any lookup', () => {
  for (const q of ['who lives at 12 High Street', 'jane@example.org', '+44 20 7946 0958', 'find username jdoe', 'face search', '@someone', 'sherlock jdoe', 'whose number is this', 'owner of 12 High Street']) assert.equal(P.refusePersonQuery(q).refused, true, q);
  for (const q of ['example.org', '203.0.113.5', 'AS64496', 'https://example.org/page', 'Acme Holdings Ltd']) assert.equal(P.refusePersonQuery(q).refused, false, q);
  assert.equal(P.detectInput('example.org').kind, 'domain'); assert.equal(P.detectInput('AS64496').kind, 'asn'); assert.equal(P.detectInput('203.0.113.5').kind, 'ip');
});
test('guard: needs a target, a basis, who for permission, and the tick; expires; stays inside', () => {
  let t = 1_000_000; const g = new ScopeGuard({ io: mem(), now: () => t });
  assert.throws(() => g.declare({ target: '*.example.org', basis: 'own', confirm: true }), (e) => e.code === 'bad-target');
  assert.throws(() => g.declare({ target: 'example.org', basis: 'own', confirm: false }), (e) => e.code === 'confirm');
  assert.throws(() => g.declare({ target: 'example.org', basis: 'permission', confirm: true }), (e) => e.code === 'who');
  assert.throws(() => g.declare({ target: 'example.org', basis: 'maybe', confirm: true }), (e) => e.code === 'basis');
  const d = g.declare({ target: '203.0.113.0/28', basis: 'permission', who: 'A. Client Ltd', when: '2026-01-01', confirm: true });
  assert.equal(g.check(d.scopeId, '203.0.113.3').target, '203.0.113.0/28');
  assert.throws(() => g.check(d.scopeId, '198.51.100.1'), (e) => e.code === 'outside');
  assert.equal(g.active().length, 1); t += 13 * 3600e3; assert.throws(() => g.check(d.scopeId), (e) => e.code === 'expired'); assert.equal(g.active().length, 0);
});
test('log is a hash chain: edits, removals and reordering are found', () => {
  const io = mem(); const g = new ScopeGuard({ io });
  const d = g.declare({ target: 'example.org', basis: 'own', confirm: true }); g.log({ action: 'scan.start', scopeId: d.scopeId, target: 'example.org' }); g.revoke(d.scopeId);
  assert.equal(g.verify().ok, true); assert.equal(g.recent(10).length, 3);
  const lines = io._c.join('').split('\n').filter(Boolean);
  const tamper = (arr) => { const i2 = mem(); i2._c.push(arr.join('\n') + '\n'); i2.readAll = () => i2._c; return new ScopeGuard({ io: i2 }).verify(); };
  assert.equal(tamper(lines.map((l, i) => (i === 1 ? l.replace('example.org', 'victim.example') : l))).ok, false);
  assert.equal(tamper([lines[0], lines[2]]).ok, false); assert.equal(tamper([lines[1], lines[0], lines[2]]).ok, false);
});
