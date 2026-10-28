'use strict';
// Logic of the Ghost tool page and the result table (the parts that need no page): kinds, status, runs through search and jobs, columns, sort, filter, groups.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TP = require('../src/ui/ghost/toolpage.js');
const RT = require('../src/ui/ghost/resulttable.js');
const dir = path.join(__dirname, '..', 'src', 'ui', 'ghost');

const R = (type, value, raw, extra) => ({ entity: { type, value }, source: { tool: 't', connector: 'dns-doh', version: '1.0.0' }, observedAt: '2026-10-27T09:15:00.000Z', confidence: 'likely', ...(raw ? { raw } : {}), ...(extra || {}) });

test('guessKind: understands what was typed, and says when the tool does not take it', () => {
  assert.equal(TP.guessKind('Example.org', ['domain']).kind, 'domain');
  assert.equal(TP.guessKind('203.0.113.5', ['ip', 'asn']).kind, 'ip');
  assert.equal(TP.guessKind('51.5074, -0.1278', ['coords']).kind, 'coords');
  assert.equal(TP.guessKind('Example Holdings Ltd', ['org-name', 'keyword']).kind, 'org-name');
  assert.equal(TP.guessKind('harbour dredging', ['keyword']).kind, 'keyword');
  const no = TP.guessKind('203.0.113.5', ['domain']);
  assert.equal(no.ok, false); assert.match(no.hint, /IP address/); assert.match(no.hint, /domain/);
  assert.equal(TP.guessKind('', ['domain']).kind, null);
});
test('statusOf: ready, off, needs a program, failed, getting ready, running; only ready can run', () => {
  const t = (state, more) => TP.statusOf({ tool: { state, ...(more || {}) }, entry: null });
  assert.deepEqual([t('ready').state, t('ready').canRun], ['ready', true]);
  for (const s of ['off', 'needs-program', 'failed', 'setting-up']) assert.equal(t(s).canRun, false, s);
  assert.match(t('needs-program', { note: 'needs ExifTool' }).line, /ExifTool/);
  assert.match(t('failed', { note: 'files are not valid' }).line, /not valid/);
  assert.equal(TP.statusOf({ tool: { state: 'ready' }, entry: null, running: true }).state, 'running');
  assert.equal(TP.statusOf({ tool: null, entry: null }).canRun, false);
  // without the app's status line it falls back to the connector entry
  assert.equal(TP.statusOf({ tool: null, entry: { state: 'enabled', install: { requirements: [] } } }).canRun, true);
  assert.equal(TP.statusOf({ tool: null, entry: { state: 'not-approved', install: { requirements: [] } } }).state, 'off');
  assert.equal(TP.statusOf({ tool: null, entry: { state: 'enabled', install: { requirements: [{ name: 'exiftool', status: 'missing' }] } } }).state, 'needs-program');
});
test('testNote: a failed self-test is reported with its reason and never blocks', () => {
  assert.equal(TP.testNote({ tool: { tested: 'tested' } }).kind, 'tested');
  const f = TP.testNote({ tool: { tested: 'failed', testNote: 'did not answer in time' } });
  assert.equal(f.kind, 'failed'); assert.match(f.text, /did not answer in time/);
  assert.equal(TP.statusOf({ tool: { state: 'ready', tested: 'failed' }, entry: null }).canRun, true);
  assert.equal(TP.testNote({ tool: { tested: 'pending' } }).kind, 'pending');
});
test('inputKindsOf: the app list wins, the form never offers a kind that is not a lookup kind', () => {
  assert.deepEqual(TP.inputKindsOf({ inputs: ['domain', 'entity', 'rules-file', 'cidr'] }, null), ['domain', 'cidr']);
  assert.ok(TP.inputKindsOf(null, { id: 'dns-doh', input: { fields: [] } }).includes('domain'));
  assert.deepEqual(TP.inputKindsOf(null, { id: 'unknown-x', input: { fields: [{ type: 'file' }] } }), ['file']);
});
test('buildJobInput: the main field gets the value, set options are kept, a required list suits the kind', () => {
  const fields = [{ name: 'kind', type: 'enum', values: ['organisation', 'domain', 'place', 'topic'] }, { name: 'query', type: 'string' }, { name: 'limit', type: 'integer', required: false, min: 1 }, { name: 'mode', type: 'enum', required: false, values: ['a', 'b'] }];
  assert.deepEqual(TP.buildJobInput(fields, { kind: 'domain', value: 'example.org', options: {} }), { query: 'example.org', kind: 'domain' });
  assert.deepEqual(TP.buildJobInput(fields, { kind: 'keyword', value: 'x', options: { limit: '5', mode: 'b' } }), { query: 'x', kind: 'topic', limit: 5, mode: 'b' });
  assert.deepEqual(TP.buildJobInput([{ name: 'file', type: 'file' }], { kind: 'file', value: 'a.jpg', fileToken: 'tok' }), { file: 'tok' });
});

// ---- runs ----
function fakeApi(plan) {
  const subs = new Set(); let n = 0; const calls = [];
  const emit = (e) => { for (const f of [...subs]) f(e); };
  return {
    calls, emit,
    onSearch: (cb) => { subs.add(cb); return () => subs.delete(cb); },
    searchRun: async (o) => { calls.push(['run', o]); const searchId = 's' + (++n); setTimeout(() => plan(searchId, emit), 0); return { searchId }; },
    searchCancel: async (id) => { calls.push(['cancel', id]); },
    jobsRun: async (o) => { calls.push(['jobs.run', o]); return { jobId: 'j1' }; },
    jobsGet: async () => ({ status: 'done', results: [R('ip', '1.1.1.1')], resultCount: 1 }),
    jobsCancel: async () => {},
  };
}
test('startRun through search: result, empty, error with the reason, and events of other searches are ignored', async () => {
  const ok = fakeApi((id, emit) => { emit({ searchId: 'other', type: 'tool-error', tool: 'dns-doh', error: 'not mine' }); emit({ searchId: id, type: 'tool-start', tool: 'dns-doh' }); emit({ searchId: id, type: 'tool-result', tool: 'dns-doh', results: [R('ip', '1.1.1.1')], ms: 12, truncated: true }); emit({ searchId: id, type: 'done' }); });
  const a = await TP.startRun({ api: ok }, { tool: 'dns-doh', mode: 'search', query: 'example.org', kind: 'domain' }).promise;
  assert.equal(a.status, 'done'); assert.equal(a.results.length, 1); assert.equal(a.ms, 12); assert.equal(a.truncated, true);
  assert.deepEqual(ok.calls[0][1], { query: 'example.org', kind: 'domain', tools: ['dns-doh'] });
  const empty = fakeApi((id, emit) => { emit({ searchId: id, type: 'tool-empty', tool: 'dns-doh', ms: 3 }); emit({ searchId: id, type: 'done' }); });
  assert.equal((await TP.startRun({ api: empty }, { tool: 'dns-doh', mode: 'search', query: 'x', kind: 'domain' }).promise).status, 'empty');
  const bad = fakeApi((id, emit) => { emit({ searchId: id, type: 'tool-error', tool: 'dns-doh', error: 'The service answered 503.', ms: 4 }); emit({ searchId: id, type: 'done' }); });
  const b = await TP.startRun({ api: bad }, { tool: 'dns-doh', mode: 'search', query: 'x', kind: 'domain' }).promise;
  assert.equal(b.status, 'error'); assert.match(b.error, /503/);
  const np = fakeApi((id, emit) => { emit({ searchId: id, type: 'tool-error', tool: 'exiftool', state: 'needs-program', error: 'needs ExifTool' }); emit({ searchId: id, type: 'done' }); });
  const c = await TP.startRun({ api: np }, { tool: 'exiftool', mode: 'search', query: 'tok', kind: 'file' }).promise;
  assert.equal(c.state, 'needs-program');
  const none = fakeApi((id, emit) => emit({ searchId: id, type: 'done' }));
  assert.equal((await TP.startRun({ api: none }, { tool: 'dns-doh', mode: 'search', query: 'x', kind: 'domain' }).promise).status, 'error');
});
test('startRun: a refused run (ok:false is thrown by the page bridge) is an error with its message; a file search sends the token, not the name', async () => {
  const api = fakeApi(() => {}); api.searchRun = async () => { throw new Error('No ready tool takes that.'); };
  const r = await TP.startRun({ api }, { tool: 'x', mode: 'search', query: 'q', kind: 'domain' }).promise;
  assert.equal(r.status, 'error'); assert.match(r.error, /No ready tool/);
  const f = fakeApi((id, emit) => { emit({ searchId: id, type: 'tool-empty', tool: 'hash-file' }); emit({ searchId: id, type: 'done' }); });
  await TP.startRun({ api: f }, { tool: 'hash-file', mode: 'search', query: 'photo.jpg', searchQuery: 'tok_1', kind: 'file' }).promise;
  assert.deepEqual(f.calls[0][1], { query: 'tok_1', kind: 'file', tools: ['hash-file'] });
});
test('startRun: cancel stops a running search and says cancelled; a job run polls until done', async () => {
  const api = fakeApi(() => {});
  const h = TP.startRun({ api }, { tool: 'dns-doh', mode: 'search', query: 'x', kind: 'domain' });
  await new Promise((r) => setTimeout(r, 20)); await h.cancel();
  const out = await h.promise; assert.equal(out.status, 'cancelled'); assert.ok(api.calls.some((c) => c[0] === 'cancel'));
  const j = await TP.startRun({ api: fakeApi(() => {}), sleep: async () => {} }, { tool: 'overpass-query', mode: 'job', input: { query: 'x' } }).promise;
  assert.equal(j.status, 'done'); assert.equal(j.results.length, 1);
});
test('History keeps the newest 20 runs per tool', () => {
  const H = TP.History(); for (let i = 0; i < 25; i++) H.add('a', { i });
  assert.equal(H.list('a').length, 20); assert.equal(H.list('a')[0].i, 24); assert.equal(H.list('b').length, 0);
});

// ---- the table ----
test('table: kinds are recognised, unknown kinds fall back to key and value, groups are biggest first', () => {
  const rows = RT.normAll([R('ip', '1.1.1.1'), R('ip', '2.2.2.2'), R('hostname', 'a.example.org'), R('vulnerability', 'CVE-2026-1', { score: 9.8 })]);
  assert.deepEqual(rows.map((r) => r.type), ['ip', 'ip', 'domain', 'unknown']);
  const g = RT.groups(rows); assert.equal(g[0].type, 'ip'); assert.equal(g[0].rows.length, 2);
  assert.equal(g.find((x) => x.type === 'unknown').label, 'Vulnerability (other)');
  assert.deepEqual(RT.columnsFor('unknown').map((c) => c.key).slice(0, 3), ['t', 'v', 'about']);
  assert.match(RT.columnsFor('unknown')[2].get(rows[3]), /score: 9\.8/);
});
test('table: merged entities (tools list) work as well as connector results', () => {
  const rows = RT.normAll([{ type: 'domain', value: 'a.example.org', tools: ['DNS', 'Certificates'], time: '2026-10-27T09:00:00Z' }], { DNS: 'DNS records' });
  assert.equal(rows[0].source, 'DNS records, Certificates'); assert.equal(rows[0].type, 'domain');
});
test('table: columns per kind, compact keeps three plus the tail, and a place gets coordinates from its value', () => {
  const cols = RT.columnsFor('place').map((c) => c.label); assert.deepEqual(cols.slice(0, 3), ['Place', 'Latitude', 'Longitude']);
  const c = RT.columnsFor('ip', { compact: true }); assert.equal(c.length, 3 + 2); assert.equal(c.some((x) => x.key === 'conf'), false);
  const p = RT.normAll([R('place', '51.5, -0.12')])[0]; assert.equal(RT.columnsFor('place')[1].get(p), '51.5');
});
test('table: sort is numeric, stable, empty last; filter needs every word', () => {
  const rows = RT.normAll([R('ip', '10.0.0.9', { asn: 'AS3' }), R('ip', '10.0.0.10', { asn: 'AS20' }), R('ip', '10.0.0.2'), R('ip', '10.0.0.5', { asn: 'AS3' })]);
  const col = RT.columnsFor('ip').find((c) => c.key === 'v');
  assert.deepEqual(RT.sortRows(rows, col, 'asc').map((r) => r.value), ['10.0.0.10', '10.0.0.2', '10.0.0.5', '10.0.0.9'].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  const net = RT.columnsFor('ip').find((c) => c.key === 'net');
  assert.equal(RT.sortRows(rows, net, 'desc').at(-1).value, '10.0.0.2');
  assert.deepEqual(RT.sortRows(rows, net, 'asc').slice(0, 2).map((r) => r.value), ['10.0.0.9', '10.0.0.5']);
  const cols = RT.columnsFor('ip');
  assert.equal(RT.filterRows(rows, cols, 'as3 10.0.0.5').length, 1); assert.equal(RT.filterRows(rows, cols, '').length, 4); assert.equal(RT.filterRows(rows, cols, 'zzz').length, 0);
});
test('table: details list every raw field, long values are clipped, hash kind is named, sizes are readable', () => {
  const n = RT.normAll([R('file', 'a.jpg', { sha256: 'a'.repeat(64), size: 204800, blob: 'x'.repeat(2000), nested: { a: 1 } })])[0];
  const d = Object.fromEntries(RT.details(n)); assert.ok(d.blob.length <= 600); assert.equal(d.nested, '{"a":1}'); assert.equal(d.Source, 'dns-doh 1.0.0');
  assert.equal(RT.fmtSize(204800), '200 KB'); assert.equal(RT.fmtSize(12), '12 B');
  assert.equal(RT.columnsFor('hash').find((c) => c.key === 'kind').get(RT.normAll([R('hash', 'f'.repeat(40))])[0]), 'SHA-1');
});
test('table: bad input does not throw', () => {
  assert.deepEqual(RT.normAll(null), []);
  const rows = RT.normAll([null, 5, {}, { entity: 3 }]); assert.equal(rows.length, 4);
  for (const r of rows) assert.doesNotThrow(() => RT.columnsFor(r.type).map((c) => c.get(r)));
});
test('files: both scripts are in index.html after map.js and before layouts.js, the page code uses textContent only, no hex colours or own radius in toolpage.css', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const at = (s) => html.indexOf('<script src="' + s + '">');
  assert.ok(at('map.js') > 0 && at('resulttable.js') > at('map.js') && at('toolpage.js') > at('resulttable.js') && at('layouts.js') > at('toolpage.js'));
  assert.ok(html.includes('href="toolpage.css"'));
  for (const f of ['toolpage.js', 'resulttable.js']) assert.equal(/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/.test(fs.readFileSync(path.join(dir, f), 'utf8')), false, f);
  const css = fs.readFileSync(path.join(dir, 'toolpage.css'), 'utf8');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false); assert.equal(/border-radius:\s*\d/.test(css), false);
  assert.ok(/prefers-reduced-motion/.test(css)); assert.ok(/:focus-visible/.test(css));
});
