'use strict';
// Person entities, relationships between people and organisations, custom fields on every entity type (add, edit, rename, reorder, delete, search, report, export, import,
// merge), and the rule that nothing is blocked: no title or value, on any entity type, is refused or filtered.
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/ui/ghost/case-model');
const R = require('../src/main/ghost/app/report');
const { CaseStore } = require('../src/main/ghost/app/cases');

const NOW = Date.UTC(2026, 9, 27, 9, 0, 0);
function sample() {
  const c = M.newCase('Board', NOW);
  const org = M.addEntity(c, { type: 'org', value: 'Acme Holdings Ltd', manual: true }).id;
  const ceo = M.addEntity(c, { type: 'person', value: 'Jane Example', manual: true, duplicate: true, fields: [{ title: 'Role / title', value: 'Chief Executive', source: 'Companies register filing', t: '2026-10-01T00:00:00.000Z' }, { title: 'Appointed date', value: '2019-03-04', kind: 'date', source: 'Companies register filing' }, { title: 'Public profile link', value: 'https://example.org/jane', kind: 'link' }] }).id;
  return { c, org, ceo };
}
const titles = (c, id) => M.fieldsOf(c.entities[id]).map((f) => f.title);

test('person type: added, validated, round-trips through JSON, keeps its label', () => {
  assert.ok(M.ENTITY_TYPES.includes('person')); assert.equal(M.mapType('person').type, 'person'); assert.equal(M.mapType('Individual').type, 'person');
  const { c, ceo } = sample();
  assert.deepEqual(M.validate(c), []);
  const e = c.entities[ceo]; assert.equal(e.type, 'person'); assert.equal(e.label, 'Jane Example'); assert.equal(e.manual, true); assert.deepEqual(titles(c, ceo), ['Role / title', 'Appointed date', 'Public profile link']);
  const back = JSON.parse(JSON.stringify(c)); M.normalize(back); assert.deepEqual(M.validate(back), []); assert.deepEqual(back.entities[ceo].fields, e.fields);
  assert.deepEqual(M.PERSON_SUGGESTED.map((x) => x.title), ['Role / title', 'Organisation(s)', 'Appointed date', 'Public profile link']);
});
test('people with the same name stay apart when added by hand, and merge by name when a source names them', () => {
  const c = M.newCase('t'); const a = M.addEntity(c, { type: 'person', value: 'John Smith', manual: true, duplicate: true }).id, b = M.addEntity(c, { type: 'person', value: 'John Smith', manual: true, duplicate: true }).id;
  assert.notEqual(a, b); assert.equal(Object.values(c.entities).filter((e) => e.type === 'person').length, 2);
  assert.equal(M.canonKey('person', '  John   SMITH '), 'john smith'); assert.deepEqual(M.validate(c), []);
});
test('relationships: CEO of, director of, owner of, works with and a free-text label, person to organisation and person to person', () => {
  const { c, org, ceo } = sample();
  const dir = M.addEntity(c, { type: 'person', value: 'Sam Director', manual: true, duplicate: true }).id;
  for (const rel of ['ceo-of', 'director-of', 'owner-of', 'works-with', 'custom']) assert.ok(M.REL.includes(rel), rel);
  assert.ok(M.addEdge(c, { from: ceo, to: org, rel: 'ceo-of', manual: true, sourceNote: 'Annual return 2025' }).id);
  assert.ok(M.addEdge(c, { from: dir, to: org, rel: 'director-of', manual: true }).id);
  assert.ok(M.addEdge(c, { from: dir, to: org, rel: 'owner-of', manual: true }).id);
  const w = M.addEdge(c, { from: ceo, to: dir, rel: 'works-with', manual: true }); assert.ok(w.id);
  assert.equal(M.addEdge(c, { from: dir, to: ceo, rel: 'works-with', manual: true }).merged, true, 'works with reads both ways');
  const f = M.addEdge(c, { from: dir, to: ceo, rel: 'custom', label: 'former chair of the audit committee with', manual: true }); assert.equal(c.edges[f.id].label, 'former chair of the audit committee with');
  assert.equal(M.addEdge(c, { from: dir, to: ceo, rel: 'custom', label: 'a different label', manual: true }).merged, false);
  assert.equal(Object.values(c.edges).find((e) => e.rel === 'ceo-of').sourceNote, 'Annual return 2025');
  assert.deepEqual(M.validate(c), []); assert.equal(M.neighbours(c, org).length, 3); assert.deepEqual(M.shortestPath(c, ceo, org).edges.length, 1);
  assert.equal(M.updateEdge(c, f.id, { label: 'chair of' }), true); assert.equal(c.edges[f.id].label, 'chair of');
  assert.equal(M.updateEdge(c, f.id, { rel: 'works-with', label: '' }), true); assert.equal(c.edges[f.id].label, undefined);
  const bad = JSON.parse(JSON.stringify(c)); bad.edges[f.id].rel = 'not-a-relation'; assert.ok(M.validate(bad).length > 0);
});
test('custom fields on every entity type: add, edit, rename, reorder, delete', () => {
  const c = M.newCase('t', NOW); const ids = {};
  for (const t of M.ENTITY_TYPES) ids[t] = M.addEntity(c, { type: t, value: t === 'email' ? 'x@example.org' : 'v-' + t, manual: true, attrs: t === 'email' ? { role: 'abuse-contact' } : {} }).id;
  for (const [t, id] of Object.entries(ids)) {
    const a = M.addField(c, id, { title: 'First', value: 'one' }, NOW), b = M.addField(c, id, { title: 'Second', value: 'two', kind: 'longtext', source: 'my notes' }, NOW), d = M.addField(c, id, { title: 'Third', value: '3', kind: 'number' }, NOW);
    assert.ok(a && b && d, t); assert.deepEqual(titles(c, id), ['First', 'Second', 'Third']);
    const f = M.fieldsOf(c.entities[id]); assert.equal(f[1].kind, 'longtext'); assert.equal(f[1].source, 'my notes'); assert.equal(f[0].t, new Date(NOW).toISOString());
    assert.equal(M.updateField(c, id, a, { title: 'Renamed', value: 'uno', kind: 'link' }, NOW + 1000), true);
    assert.deepEqual([f[0].title, f[0].value, f[0].kind, f[0].updated], ['Renamed', 'uno', 'link', new Date(NOW + 1000).toISOString()]); assert.equal(f[0].t, new Date(NOW).toISOString());
    assert.equal(M.moveField(c, id, d, 'up'), true); assert.deepEqual(titles(c, id), ['Renamed', 'Third', 'Second']);
    assert.equal(M.moveField(c, id, d, 'top'), true); assert.deepEqual(titles(c, id), ['Third', 'Renamed', 'Second']);
    assert.equal(M.moveField(c, id, d, 2), true); assert.deepEqual(titles(c, id), ['Renamed', 'Second', 'Third']);
    assert.equal(M.moveField(c, id, a, 'up'), false); assert.equal(M.moveField(c, id, 'nope', 'down'), false);
    assert.equal(M.removeField(c, id, b), true); assert.deepEqual(titles(c, id), ['Renamed', 'Third']); assert.equal(M.removeField(c, id, b), false);
  }
  assert.deepEqual(M.validate(c), []);
  assert.equal(M.addField(c, 'missing', { title: 'x', value: 'y' }), null);
  const e = c.entities[ids.domain]; for (let i = 0; i < M.LIMITS.fields; i++) M.addField(c, ids.domain, { title: 't' + i, value: 'v' }); assert.equal(e.fields.length, M.LIMITS.fields); assert.equal(M.addField(c, ids.domain, { title: 'over', value: 'x' }), null);
});
test('nothing is blocked: sensitive-looking titles and values are accepted on every entity type, Person included', () => {
  const c = M.newCase('t'); const sensitive = ['Home address', 'Passport number', 'Date of birth', 'National insurance number', 'Mobile phone', 'Personal email', 'Religion', 'Medical condition', 'Spouse', 'Username', 'Face match', 'password', 'ssn', '12 High Street, Leeds, LS1 1AA', '+44 7700 900123', 'jane@example.org', 'where does Jane live', '@handle'];
  const person = M.addEntity(c, { type: 'person', value: 'Anyone At All', manual: true, duplicate: true }).id; const org = M.addEntity(c, { type: 'org', value: 'Org', manual: true }).id; const pl = M.addEntity(c, { type: 'place', value: 'Somewhere', manual: true }).id;
  for (const id of [person, org, pl]) for (const s of sensitive) { const fid = M.addField(c, id, { title: s, value: s, source: s }); assert.ok(fid, s); const f = c.entities[id].fields.find((x) => x.id === fid); assert.deepEqual([f.title, f.value, f.source], [s, s, s]); }
  M.updateField(c, person, c.entities[person].fields[0].id, { title: 'Home address', value: '10 Downing Street' });
  assert.equal(c.entities[person].fields[0].value, '10 Downing Street'); assert.deepEqual(M.validate(c), []);
  assert.ok(M.addField(c, person, { title: '', value: '' }), 'an empty title is accepted too');
  assert.equal(M.addField(c, person, { title: 'Weird kind', value: 'x', kind: 'whatever' }) !== null, true);
  // a person added by hand with a street address or a phone number as the name, and an entity whose value looks like contact details
  assert.ok(M.addEntity(c, { type: 'person', value: '+44 7700 900123', manual: true, duplicate: true }).id); assert.ok(M.addEntity(c, { type: 'place', value: '12 High Street, Leeds', manual: true }).id);
  assert.deepEqual(M.validate(c), []);
  // and nothing in the code looks for such words in a field
  const src = require('node:fs').readFileSync(require.resolve('../src/ui/ghost/case-model.js'), 'utf8') + require('node:fs').readFileSync(require.resolve('../src/ui/ghost/entity-ui.js'), 'utf8');
  assert.equal(/refusePersonQuery|blocklist|blacklist|forbidden|not allowed/i.test(src), false);
});
test('long text, links, dates and numbers are stored as typed; invalid-looking values are kept', () => {
  const c = M.newCase('t'); const id = M.addEntity(c, { type: 'person', value: 'P', manual: true, duplicate: true }).id;
  const long = 'line one\nline two\n' + 'x'.repeat(5000);
  for (const f of [{ title: 'Bio', value: long, kind: 'longtext' }, { title: 'Link', value: 'not a url at all', kind: 'link' }, { title: 'When', value: 'spring 1999', kind: 'date' }, { title: 'N', value: 12.5, kind: 'number' }, { title: 'N2', value: 'about 40', kind: 'number' }]) assert.ok(M.addField(c, id, f));
  assert.deepEqual(M.fieldsOf(c.entities[id]).map((f) => f.value), [long, 'not a url at all', 'spring 1999', '12.5', 'about 40']);
  assert.equal(M.addField(c, id, { title: 't'.repeat(1000), value: 'v'.repeat(50000) }) !== null, true); const last = M.fieldsOf(c.entities[id]).pop(); assert.equal(last.title.length, M.LIMITS.fieldTitle); assert.equal(last.value.length, M.LIMITS.fieldValue);
});
test('the case search finds field titles, values and sources', () => {
  const { c, ceo, org } = sample();
  M.addField(c, org, { title: 'Registered number', value: 'RC-7731-Q', source: 'Gazette notice' });
  assert.deepEqual(M.search(c, 'chief executive'), [ceo]); assert.deepEqual(M.search(c, 'rc-7731'), [org]); assert.deepEqual(M.search(c, 'gazette'), [org]); assert.deepEqual(M.search(c, 'registered number'), [org]); assert.deepEqual(M.search(c, 'appointed'), [ceo]);
  assert.deepEqual(M.search(c, 'no such text anywhere'), []);
});
test('reports carry the fields with their source and time, relation labels, and the report hash covers them', () => {
  const { c, org, ceo } = sample();
  M.addEdge(c, { from: ceo, to: org, rel: 'custom', label: 'former chair of <b>', manual: true, sourceNote: 'Minutes 2024' }); M.addEdge(c, { from: ceo, to: org, rel: 'ceo-of', manual: true });
  M.addField(c, ceo, { title: 'Home address', value: '1 Test Road <i>x</i>', source: 'Public filing' });
  const html = R.reportHtml(c, { now: NOW });
  for (const s of ['People', 'Jane Example', 'Role / title', 'Chief Executive', 'Companies register filing', 'recorded 2026-10-01', 'Appointed date', '2019-03-04', 'Public profile link', 'https://example.org/jane', 'Home address', '1 Test Road &lt;i&gt;x&lt;/i&gt;', 'Public filing', 'former chair of &lt;b&gt;', 'Minutes 2024', 'CEO of']) assert.ok(html.includes(s), s);
  assert.equal(html.includes('<i>x</i>') || html.includes('former chair of <b>'), false); assert.equal(/<script/i.test(html), false);
  assert.equal(/Personal details found in public records are withheld/.test(html), false);
  const d = JSON.parse(R.reportJson(c, { now: NOW })); const p = d.entities.find((e) => e.id === ceo); assert.equal(p.fields.length, 4); assert.equal(p.fields[3].title, 'Home address');
  const h1 = R.reportJson(c, { now: NOW }); M.updateField(c, ceo, p.fields[0].id, { value: 'Chair' }, NOW); assert.notEqual(R.reportJson(c, { now: NOW }), h1);
  const hidden = R.reportHtml(c, { now: NOW, hide: [ceo] }); assert.equal(hidden.includes('Chief Executive'), false);
});
test('case file export and import keep fields, order, labels and sources; a saved case round-trips through the vault validation', () => {
  const { c, org, ceo } = sample();
  const s = M.addSource(c, { connector: 'rdap-domain', connectorVersion: '1.0.0', origin: 'https://rdap.example/domain/acme.example' }); c.entities[org].sources.push(s);
  M.addEdge(c, { from: ceo, to: org, rel: 'custom', label: 'chair', manual: true, sourceNote: 'Minutes' }); M.addField(c, org, { title: 'A', value: '1' }); M.addField(c, org, { title: 'B', value: '2' }); M.moveField(c, org, M.fieldsOf(c.entities[org])[1].id, 'up');
  const text = M.exportJson(c); const back = M.importJson(text);
  assert.deepEqual(back.problems, []); assert.deepEqual(back.case, c); assert.deepEqual(titles(back.case, org), ['B', 'A']); assert.equal(Object.values(back.case.edges)[0].label, 'chair');
  assert.ok(M.importJson('not json').problems.length); assert.equal(M.importJson('not json').case, null); assert.equal(M.importJson('{"format":"nope"}').case, null); assert.equal(M.importJson('[]').case, null);
  const broken = JSON.parse(text); broken.entities[ceo].fields = 'nope'; assert.deepEqual(M.importJson(JSON.stringify(broken)).case.entities[ceo].fields, [], 'a malformed field list is repaired on load, like other optional parts'); assert.ok(M.validate(Object.assign(JSON.parse(text), { entities: { ...JSON.parse(text).entities, [ceo]: { ...JSON.parse(text).entities[ceo], fields: 'nope' } } })).length > 0, 'but a save with one is refused');
  const old = JSON.parse(text); delete old.entities[org].fields; delete old.entities[ceo].fields; const o = M.importJson(JSON.stringify(old)); assert.deepEqual(o.problems, []); assert.deepEqual(o.case.entities[org].fields, []);
  const vault = new Map(); const store = new CaseStore({ vault: { ensure() {}, unlocked: true, get: (n, k) => (vault.has(n + k) ? Buffer.from(vault.get(n + k)) : null), put: (n, k, v) => vault.set(n + k, String(v)), list: () => [], remove() {} }, now: () => NOW });
  store.put(c.id, text); assert.deepEqual(JSON.parse(store.get(c.id)).entities[ceo].fields, c.entities[ceo].fields);
});
test('merge: matching entities combine and keep every field, new ones are added, nothing is overwritten, links and notes follow', () => {
  const a = sample(); const s1 = M.addSource(a.c, { connector: 'gleif', connectorVersion: '1', origin: 'https://api.gleif.org/x' }); a.c.entities[a.org].sources.push(s1);
  M.addField(a.c, a.org, { title: 'Registered number', value: 'RC-1', source: 'mine' }); M.addEdge(a.c, { from: a.ceo, to: a.org, rel: 'ceo-of', manual: true });
  M.addNote(a.c, 'my note', [a.ceo]);
  // another analyst's copy of the same board: same people and organisation by name, own ids, extra fields, a different value for the same title
  const b = M.newCase('Theirs', NOW); const borg = M.addEntity(b, { type: 'org', value: 'ACME HOLDINGS LTD', manual: true }).id;
  const bceo = M.addEntity(b, { type: 'person', value: 'Jane Example', manual: true, duplicate: true, fields: [{ title: 'Role / title', value: 'Chair', source: 'their source' }, { title: 'Nationality', value: 'British' }] }).id;
  const bnew = M.addEntity(b, { type: 'person', value: 'Pat Owner', manual: true, duplicate: true, fields: [{ title: 'Home address', value: '5 Elm Road' }] }).id; const bs = M.addSource(b, { connector: 'sec-edgar', connectorVersion: '2', origin: 'https://www.sec.gov/y' }); b.entities[bnew].sources.push(bs);
  M.addField(b, borg, { title: 'Registered number', value: 'RC-1', source: 'mine' }); M.addField(b, borg, { title: 'Sector', value: 'Rail' }); M.addTag(b, borg, 'rail');
  M.addEdge(b, { from: bnew, to: borg, rel: 'owner-of', manual: true, label: '', sourceNote: 'filing' }); M.addEdge(b, { from: bceo, to: borg, rel: 'ceo-of', manual: true, sourceNote: 'theirs' }); M.addNote(b, 'their note', [bnew]); M.addEvent(b, { t: '2026-01-01', title: 'Their event', entity: bnew });
  const before = JSON.stringify(a.c.entities[a.ceo].fields);
  const out = M.mergeCase(a.c, JSON.parse(M.exportJson(b)), NOW);
  assert.equal(Object.values(a.c.entities).filter((e) => e.type === 'org').length, 1); assert.equal(Object.values(a.c.entities).filter((e) => e.type === 'person' && e.label === 'Jane Example').length, 1, 'by-hand people with the same name combine on a merge');
  assert.deepEqual([out.entitiesAdded, out.skipped], [1, 0]);
  const ceo = a.c.entities[a.ceo]; assert.ok(before.length && JSON.stringify(ceo.fields).startsWith(before.slice(0, before.length - 1)), 'existing fields keep their place');
  assert.deepEqual(titles(a.c, a.ceo), ['Role / title', 'Appointed date', 'Public profile link', 'Role / title', 'Nationality']); assert.equal(ceo.fields[0].value, 'Chief Executive'); assert.equal(ceo.fields[3].value, 'Chair');
  assert.deepEqual(titles(a.c, a.org), ['Registered number', 'Sector'], 'a field that matches by title, value and kind is not repeated'); assert.deepEqual(a.c.entities[a.org].tags, ['rail']);
  const pat = Object.values(a.c.entities).find((e) => e.label === 'Pat Owner'); assert.equal(pat.fields[0].value, '5 Elm Road'); assert.equal(pat.sources.length, 1); assert.ok(a.c.sources[pat.sources[0]]);
  const edges = Object.values(a.c.edges); assert.equal(edges.filter((e) => e.rel === 'ceo-of').length, 1, 'the same link is not repeated'); assert.equal(edges.find((e) => e.rel === 'owner-of').from, pat.id);
  assert.equal(a.c.notes.length, 2); assert.deepEqual(a.c.notes[1].refs, [pat.id]); const ev = a.c.timeline.find((t) => t.title === 'Their event'); assert.equal(ev.entity, pat.id);
  assert.deepEqual(M.validate(a.c), []);
  const again = M.mergeCase(a.c, JSON.parse(M.exportJson(b)), NOW); assert.deepEqual([again.entitiesAdded, again.linksAdded, again.fieldsAdded, again.notesAdded, again.eventsAdded], [0, 0, 0, 0, 0], 'merging the same file twice adds nothing');
  assert.deepEqual(M.validate(a.c), []);
});
test('merge keeps the history one step and clashing ids get fresh ones', () => {
  const a = M.newCase('a'), b = M.newCase('b'); const ea = M.addEntity(a, { type: 'domain', value: 'one.example', manual: true, id: 'same-id' }).id; M.addEntity(b, { type: 'domain', value: 'two.example', manual: true, id: 'same-id' });
  const h = new M.History(a); const out = h.run('Merge case file', (x) => M.mergeCase(x, b)); assert.equal(out.entitiesAdded, 1); assert.equal(Object.keys(a.entities).length, 2); assert.equal(a.entities[ea].key, 'one.example');
  h.undo(); assert.equal(Object.keys(a.entities).length, 1);
});
