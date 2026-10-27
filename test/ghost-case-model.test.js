'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/ui/ghost/case-model');

const conn = { id: 'dns-doh', version: '1.0.0', licence: 'MIT', attribution: '' };
const res = (type, value, extra) => ({ entity: { type, value }, source: { tool: 'dns', connector: 'dns-doh', version: '1.0.0', url: 'https://doh.example/q?name=secret' }, observedAt: '2026-01-01T00:00:00Z', confidence: 'confirmed', ...(extra || {}) });

test('ingest adds entities with a source, merges duplicates, strips URL queries', () => {
  const c = M.newCase('t');
  const a = M.ingest(c, { connector: conn, query: { kind: 'domain', value: 'example.org' }, results: [res('domain', 'Example.ORG.'), res('ip', '203.0.113.5')], rawSha256: 'a'.repeat(64) });
  assert.equal(a.added >= 1, true); assert.equal(Object.keys(c.entities).length, 2);
  const b = M.ingest(c, { connector: conn, query: { kind: 'domain', value: 'example.org' }, results: [res('domain', 'example.org')], rawSha256: '' });
  assert.equal(b.added, 0); assert.equal(Object.values(c.entities).filter((e) => e.type === 'domain').length, 1);
  for (const s of Object.values(c.sources)) assert.equal(s.origin.includes('secret'), false);
  assert.deepEqual(M.validate(c), []);
  for (const e of Object.values(c.entities)) assert.equal(M.isUnsourced(e), false);
});
test('person-type results are withheld and counted, never stored', () => {
  const c = M.newCase('t');
  const r = M.ingest(c, { connector: conn, query: null, results: [res('person', 'Jane Doe'), res('username', 'jdoe'), res('phone', '+4400000'), res('domain', 'example.org')], rawSha256: '' });
  assert.equal(r.withheld, 3); assert.equal(JSON.stringify(c).includes('Jane Doe'), false); assert.equal(Object.keys(c.entities).length >= 1, true);
});
test('email is kept only with an infrastructure role', () => {
  const c = M.newCase('t');
  M.ingest(c, { connector: conn, query: null, results: [res('email', 'x@example.org', { entity: { type: 'email', value: 'x@example.org' } })], rawSha256: '' });
  assert.equal(Object.values(c.entities).filter((e) => e.type === 'email').length, 0);
  M.ingest(c, { connector: conn, query: null, results: [{ ...res('email', 'abuse@example.org'), entity: { type: 'email', value: 'abuse@example.org' }, raw: { role: 'abuse-contact' } }], rawSha256: '' });
  assert.equal(JSON.stringify(c).includes('abuse@example.org'), true);
});
test('validate rejects an unsourced non-manual entity', () => {
  const c = M.newCase('t'); const r = M.addEntity(c, { type: 'domain', value: 'a.example', manual: false });
  assert.ok(M.validate(c).length > 0); assert.equal(M.isUnsourced(c.entities[r.id]), true);
  const d = M.newCase('t'); M.addEntity(d, { type: 'domain', value: 'a.example', manual: true }); assert.deepEqual(M.validate(d), []);
});
test('undo and redo restore snapshots; grouped changes coalesce; limit holds', () => {
  const c = M.newCase('t'), h = new M.History(c);
  h.run('add', (x) => { M.addEntity(x, { type: 'domain', value: 'a.example', manual: true }); });
  h.run('add2', (x) => { M.addEntity(x, { type: 'domain', value: 'b.example', manual: true }); });
  assert.equal(Object.keys(c.entities).length, 2); h.undo(); assert.equal(Object.keys(c.entities).length, 1); h.redo(); assert.equal(Object.keys(c.entities).length, 2);
  for (let i = 0; i < 5; i++) h.run('move', (x) => { x.title = 'n' + i; }, { group: 'g', windowMs: 5000 });
  const before = h.undoStack.length; h.undo(); assert.equal(h.undoStack.length, before - 1); assert.notEqual(c.title, 'n4');
  for (let i = 0; i < 80; i++) h.run('s' + i, (x) => { x.title = 't' + i; });
  assert.ok(h.undoStack.length <= M.UNDO_LIMIT);
});
test('shortest path, neighbours, search, timeline, layout', () => {
  const c = M.newCase('t'); const id = (v) => M.addEntity(c, { type: 'domain', value: v, manual: true }).id;
  const a = id('a.example'), b = id('b.example'), d = id('c.example'), x = id('far.example');
  M.addEdge(c, { from: a, to: b, rel: 'linked-to', manual: true }); M.addEdge(c, { from: b, to: d, rel: 'linked-to', manual: true });
  assert.deepEqual(M.shortestPath(c, a, d).nodes, [a, b, d]); assert.equal(M.shortestPath(c, a, x), null);
  assert.equal(M.neighbours(c, b).length, 2); assert.deepEqual(M.search(c, 'far'), [x]);
  M.addEvent(c, { t: '2026-02-01', title: 'Seen' }); assert.equal(M.buildTimeline(c).some((t) => t.title === 'Seen'), true);
  M.layout(c); for (const e of Object.values(c.entities)) { assert.ok(e.pos.x >= 0 && e.pos.x <= 1 && e.pos.y >= 0 && e.pos.y <= 1); }
  const snap = JSON.stringify(Object.values(c.entities).map((e) => e.pos)); M.layout(c); assert.equal(JSON.stringify(Object.values(c.entities).map((e) => e.pos)), snap, 'stable');
});
test('removing an entity removes its links; place coordinates are range-checked', () => {
  const c = M.newCase('t'); const a = M.addEntity(c, { type: 'domain', value: 'a.example', manual: true }).id, b = M.addEntity(c, { type: 'domain', value: 'b.example', manual: true }).id;
  M.addEdge(c, { from: a, to: b, rel: 'linked-to', manual: true }); M.removeEntity(c, a); assert.equal(Object.keys(c.edges).length, 0);
  assert.equal(M.placeCoords({ attrs: { lat: 91, lon: 0 } }), null); assert.deepEqual(M.placeCoords({ attrs: { lat: '51.5', lon: '-0.1' } }), { lat: 51.5, lon: -0.1 });
});
test('hashRaw is stable and hex', async () => { const h = await M.hashRaw([{ raw: { a: 1 } }]); assert.match(h, /^[0-9a-f]{64}$/); assert.equal(h, await M.hashRaw([{ raw: { a: 1 } }])); });
