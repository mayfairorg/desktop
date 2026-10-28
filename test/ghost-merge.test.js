'use strict';
// The Overview merge of a master search: one row per entity (type + normalised value), the tools that found it, first and last source time, groups by type,
// what is left out, and the selection turned back into per-tool results for the case store.
const test = require('node:test');
const assert = require('node:assert/strict');
const MG = require('../src/ui/ghost/merge');
const M = require('../src/ui/ghost/case-model');

const res = (type, value, o = {}) => ({ entity: { type, value }, source: { tool: o.tool || 'x', connector: o.tool || 'x', version: o.version || '1.0.0', ...(o.url ? { url: o.url } : {}) }, observedAt: o.at || '2026-10-27T10:00:00.000Z', confidence: o.conf || 'confirmed', ...(o.note ? { uncertaintyNote: o.note } : {}), ...(o.raw ? { raw: o.raw } : {}) });

test('the key is the type plus the value as the case file writes it', () => {
  assert.equal(MG.entityKey('domain', 'Example.ORG.'), 'domain:example.org');
  assert.equal(MG.entityKey('hostname', 'WWW.example.org'), 'domain:www.example.org', 'an alias maps to the same type');
  assert.equal(MG.entityKey('asn', 'as64496'), 'asn:AS64496'); assert.equal(MG.entityKey('asn', '64496'), 'asn:AS64496');
  assert.equal(MG.entityKey('ip', '2001:0DB8:0:0:0:0:0:1'), 'ip:2001:db8::1');
  assert.equal(MG.entityKey('cert', 'AA:BB:cc'), 'cert:aabbcc');
  assert.equal(MG.entityKey('org', '  Example   Holdings LTD '), 'org:example holdings ltd');
  assert.equal(MG.entityKey('url', 'HTTPS://Example.org/'), 'url:https://example.org');
  assert.notEqual(MG.entityKey('domain', 'example.org'), MG.entityKey('org', 'example.org'), 'the type is part of the key');
  for (const [t, v] of [['domain', 'a.example.org'], ['ip', '203.0.113.5'], ['org', 'Acme Ltd'], ['url', 'https://a.example.org/x']]) assert.equal(MG.entityKey(t, v), (() => { const m = M.mapType(t); return m.type + ':' + M.canonKey(m.type, v, m.kind); })(), 'same canon as the case');
});

test('the same thing from two tools is one row that remembers both tools', () => {
  const st = MG.create();
  const a = MG.add(st, 'dns-doh', [res('domain', 'www.example.org', { tool: 'dns-doh', at: '2026-10-27T10:00:05.000Z', url: 'https://a.example/q' }), res('ip', '203.0.113.5', { tool: 'dns-doh' })]);
  const b = MG.add(st, 'ct-crtsh', [res('hostname', 'WWW.Example.org.', { tool: 'ct-crtsh', at: '2026-10-27T09:00:00.000Z', conf: 'likely' })]);
  assert.deepEqual(a, { added: 2, merged: 0, withheld: 0 }); assert.deepEqual(b, { added: 0, merged: 1, withheld: 0 });
  const rows = MG.entities(st); assert.equal(rows.length, 2);
  const w = rows.find((r) => r.type === 'domain');
  assert.deepEqual(w.tools, ['dns-doh', 'ct-crtsh']); assert.equal(w.value, 'www.example.org'); assert.equal(w.sources.length, 2);
  assert.equal(w.first, '2026-10-27T09:00:00.000Z'); assert.equal(w.last, '2026-10-27T10:00:05.000Z', 'first and last source time');
  assert.equal(w.confidence, 'confirmed', 'the best confidence any tool reported');
  assert.equal(rows[0], w, 'the row found by the most tools comes first');
  assert.equal(MG.summary(st).corroborated, 1); assert.equal(MG.summary(st).entities, 2); assert.equal(MG.summary(st).results, 3);
});

test('the same tool repeating a result adds no second source and no second tool', () => {
  const st = MG.create(); const r = res('ip', '203.0.113.5', { tool: 'dns-doh', url: 'https://a.example/q' });
  MG.add(st, 'dns-doh', [r, r, { ...r }]);
  const [e] = MG.entities(st); assert.deepEqual(e.tools, ['dns-doh']); assert.equal(e.sources.length, 1); assert.equal(e.hits.length, 3, 'every result is kept for the case');
  assert.equal(MG.countFor(st, 'dns-doh'), 1, 'the badge counts things, not lines');
});

test('groups by entity type in a fixed order, most corroborated first, and skips empty types', () => {
  const st = MG.create();
  MG.add(st, 'a', [res('org', 'Zed Ltd'), res('domain', 'b.example.org'), res('domain', 'a.example.org'), res('ip', '203.0.113.9'), res('place', '51.5,-0.1'), res('weird-kind', 'thing')]);
  MG.add(st, 'b', [res('domain', 'b.example.org')]);
  const g = MG.groups(st);
  assert.deepEqual(g.map((x) => x.type), ['domain', 'ip', 'org', 'place', 'finding']);
  assert.deepEqual(g[0].items.map((e) => e.value), ['b.example.org', 'a.example.org'], 'two tools beats one, then by value');
  assert.deepEqual(MG.groups(st, { tool: 'b' }).map((x) => x.type), ['domain']);
  assert.deepEqual(MG.groups(MG.create()), []);
});

test('results aimed at one private person are counted and never shown', () => {
  const st = MG.create();
  const r = MG.add(st, 't', [res('username', 'someone'), res('phone', '+441234567890'), res('profile', 'x'), res('email', 'person@example.org'), res('email', 'abuse@example.org', { raw: { role: 'abuse-contact' } }), res('domain', 'example.org'), { entity: { type: 'domain' } }, null, 'x', res('domain', '   ')]);
  assert.equal(r.added, 2, 'the domain and the email with an infrastructure role'); assert.equal(r.withheld, 8);
  const s = MG.summary(st); assert.equal(s.withheld, 8); assert.equal(s.reasons.account, 3); assert.equal(s.reasons.email, 1); assert.equal(s.reasons.invalid, 4);
  assert.ok(!MG.entities(st).some((e) => /someone|person@|\+44/.test(e.value)));
  assert.equal(MG.withheldFor(st, 't'), 8); assert.equal(MG.withheldFor(st, 'none'), 0);
});

test('bad times do not break the first and last, and a missing time is shown as none', () => {
  const st = MG.create();
  MG.add(st, 't', [res('domain', 'a.example.org', { at: 'not a date' }), { ...res('domain', 'b.example.org'), observedAt: undefined }]);
  for (const e of MG.entities(st)) { assert.equal(e.first, null); assert.equal(e.last, null); }
  MG.add(st, 'u', [res('domain', 'a.example.org', { at: '2026-01-01T00:00:00Z' })]);
  const a = MG.entities(st).find((e) => e.value === 'a.example.org'); assert.equal(a.first, '2026-01-01T00:00:00.000Z'); assert.equal(a.last, a.first);
  assert.deepEqual(MG.span(MG.entities(st)), { first: '2026-01-01T00:00:00.000Z', last: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(MG.span([]), { first: null, last: null });
});

test('uncertainty notes are kept with the row', () => {
  const st = MG.create(); MG.add(st, 't', [res('org', 'Acme Ltd', { conf: 'uncertain', note: 'Name match only' })]);
  const [e] = MG.entities(st); assert.equal(e.confidence, 'uncertain'); assert.deepEqual(e.notes, ['Name match only']); assert.equal(e.sources[0].note, 'Name match only');
});

test('a tool tab gets that tool\'s own results, as printed, with type value and key for a table', () => {
  const st = MG.create(); MG.add(st, 'a', [res('domain', 'a.example.org', { tool: 'a' })]); MG.add(st, 'b', [res('domain', 'A.example.org', { tool: 'b' }), res('ip', '203.0.113.7', { tool: 'b' })]);
  const rows = MG.resultsOf(st, 'b'); assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.key).sort(), ['domain:a.example.org', 'ip:203.0.113.7']);
  assert.equal(rows[0].source.tool, 'b'); assert.equal(rows[0].entity.value.length > 0, true); assert.ok(rows.every((r) => r.type && r.value && r.label));
  assert.deepEqual(MG.resultsOf(st, 'nobody'), []);
});

test('the selection turns back into per-tool results, so each case entity keeps its own source', () => {
  const st = MG.create();
  MG.add(st, 'dns-doh', [res('domain', 'a.example.org', { tool: 'dns-doh' }), res('ip', '203.0.113.5', { tool: 'dns-doh' })]);
  MG.add(st, 'ct-crtsh', [res('domain', 'a.example.org', { tool: 'ct-crtsh' }), res('domain', 'b.example.org', { tool: 'ct-crtsh' })]);
  const out = MG.toIngest(st, new Set(['domain:a.example.org', 'domain:b.example.org', 'ip:missing']));
  assert.deepEqual(out.map((x) => x.tool).sort(), ['ct-crtsh', 'dns-doh']);
  const by = Object.fromEntries(out.map((x) => [x.tool, x.results.map((r) => r.entity.value).sort()]));
  assert.deepEqual(by, { 'dns-doh': ['a.example.org'], 'ct-crtsh': ['a.example.org', 'b.example.org'] });
  assert.deepEqual(MG.toIngest(st, []), []);
  // and the case store takes exactly that
  const c = M.newCase('t');
  for (const p of out) M.ingest(c, { connector: { id: p.tool, version: '1.0.0' }, query: { kind: 'domain', value: 'example.org' }, results: p.results, rawSha256: 'a'.repeat(64) });
  const doms = Object.values(c.entities).filter((e) => e.type === 'domain' && e.label !== 'example.org');
  assert.equal(doms.length, 2); assert.ok(doms.every((e) => e.sources.length >= 1)); assert.equal(doms.find((e) => e.label === 'a.example.org').sources.length, 2, 'both tools are recorded as sources');
});

test('the module is pure: no DOM, no timers, no network, no storage', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/ui/ghost/merge'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.equal(/document\.|window\.|setTimeout|fetch\(|localStorage|XMLHttp|Math\.random|Date\.now|innerHTML/.test(src), false);
});
