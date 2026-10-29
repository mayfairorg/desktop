'use strict';
// The Workspace's search bookkeeping, run in a bare page context (no DOM): events from the app turn into per-tool rows and one merged Overview,
// events that arrive before the run call has answered are not lost, a tool that never reports is not shown as fine, Stop is honest, and the tool list is read as given.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dir = path.join(__dirname, '..', 'src', 'ui', 'ghost');

function page(api) {
  const GH = { h: () => ({}), routes: {}, TYPE_LABEL: { domain: 'Domain' }, TYPE_PLURAL: { domain: 'Domains' }, api, toast() {}, say() {}, mounted: true, plural: (n, a, b) => n + ' ' + (n === 1 ? a : b || a + 's'), errText: (e) => (e && e.message) || 'x' };
  GH.call = async (fn, ...a) => { const r = await fn(...a); if (r && r.ok === false) { const e = new Error(r.error || 'That did not work.'); e.code = r.code; throw e; } return r && r.ok === true && 'data' in r ? r.data : r; };
  const ctx = { console, setTimeout, clearTimeout, GH, document: { querySelector: () => null, getElementById: () => null }, matchMedia: () => ({ matches: false }) };
  ctx.window = ctx; ctx.addEventListener = () => {};
  vm.createContext(ctx);
  for (const f of ['scope-parse.js', 'case-model.js', 'modules.js', 'merge.js', 'workspace.js']) vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
  return ctx;
}
const J = (x) => JSON.parse(JSON.stringify(x));
const R = (tool, type, value, at) => ({ entity: { type, value }, source: { tool, connector: tool, version: '1' }, observedAt: at || '2026-10-27T10:00:00.000Z', confidence: 'confirmed' });
const TOOLS = [
  { id: 'a', name: 'Tool A', category: 'Domains and networks', inputs: ['domain'], state: 'ready', note: '', tested: 'tested', testNote: '' },
  { id: 'b', name: 'Tool B', category: 'domains', inputs: ['domain', 'ip'], state: 'ready', note: '', tested: 'pending', testNote: '' },
  { id: 'c', name: 'Tool C', category: 'Files and images', inputs: ['file'], state: 'needs-program', note: 'Runs in the virtual computer', tested: 'pending', testNote: '' },
  { id: 'd', name: 'Tool D', category: 'News', inputs: ['domain', 'keyword'], state: 'setting-up', note: '', tested: 'pending', testNote: '' },
  { id: 'e', name: 'Tool E', category: 'Strange new group', inputs: ['bogus'], state: 'mystery', note: '', tested: 'whatever', testNote: '' },
];
const mk = () => {
  const calls = { run: [], cancel: [] }, listeners = [];
  const api = { builtins: { status: async () => ({ ok: true, total: 5, ready: 2, failed: [], tools: TOOLS }) },
    search: { classify: async ({ query }) => (/@/.test(query) ? { ok: false, error: 'No people.' } : { ok: true, kind: 'domain', value: query.toLowerCase(), alternatives: [{ kind: 'keyword', value: query }, { kind: 'bogus-kind', value: query }] }),
      run: async (o) => { calls.run.push(o); return { ok: true, searchId: 's1', kind: o.kind, value: o.query, tools: o.tools || ['a', 'b'] }; }, cancel: async (o) => { calls.cancel.push(o); return { ok: true }; } },
    onSearch: (cb) => { listeners.push(cb); return () => {}; }, onBuiltins: () => () => {} };
  return { api, calls, emit: (ev) => listeners.forEach((f) => f(ev)) };
};

test('the tool list is read as given: states, categories, unknown values made safe', async () => {
  const { api } = mk(), ctx = page(api), ws = ctx.GH.ws;
  assert.equal(ws.available(), true);
  const st = await ws.status.load(true);
  assert.equal(st.total, 5); assert.equal(st.ready, 1 + 1); assert.equal(st.needsProgram, 1); assert.equal(st.settingUp, 2, 'an unknown state counts as still setting up, never as ready');
  const by = Object.fromEntries(st.tools.map((t) => [t.id, t]));
  assert.equal(by.a.category, 'domains'); assert.equal(by.b.category, 'domains'); assert.equal(by.c.category, 'files'); assert.equal(by.d.category, 'news'); assert.equal(by.e.state, 'setting-up'); assert.equal(by.e.tested, 'pending');
  assert.deepEqual(ws.toolsFor('domain').ready.map((t) => t.id), ['a', 'b']); assert.deepEqual(ws.toolsFor('domain').other.map((t) => t.id), ['d']); assert.deepEqual(ws.toolsFor('file').ready, []);
  assert.equal(ws.stateLabel(by.c), 'Ghost computer'); assert.match(ws.stateExplain(by.c), /Runs in the virtual computer/);
});
test('without the app calls the page says so instead of listing anything', async () => {
  const ctx = page({}), ws = ctx.GH.ws;
  assert.equal(ws.available(), false); assert.equal(await ws.status.load(true), null); assert.match(ws.status.error().message, /cannot run searches/);
  await assert.rejects(() => ws.begin({ kind: 'domain', value: 'a.example' }), /cannot run searches/);
});
test('classify uses the app, drops kinds that are not on the closed list, and passes a refusal on', async () => {
  const ctx = page(mk().api), ws = ctx.GH.ws;
  const r = await ws.classify('Example.ORG'); assert.equal(r.kind, 'domain'); assert.equal(r.value, 'example.org'); assert.deepEqual(r.alternatives.map((a) => a.kind), ['keyword']);
  await assert.rejects(() => ws.classify('someone@example.org'), /No people/);
  // and the page's own reading, used only when the app has no classify call
  const L = page({ builtins: { status: async () => ({ ok: true, tools: [] }) }, search: { run: async () => ({}) } }).GH.ws;
  assert.equal((await L.classify('Example.ORG')).kind, 'domain'); assert.equal((await L.classify('AS64496')).value, 'AS64496'); assert.equal((await L.classify('51.5074, -0.1278')).kind, 'coords');
  assert.equal((await L.classify('529900T8BM49AURSDO55')).kind, 'lei'); assert.equal((await L.classify('Example Holdings Ltd')).kind, 'org-name'); assert.equal((await L.classify('harbour fire')).kind, 'keyword');
  await assert.rejects(() => L.classify('someone@example.org'), /does not look up/);
});
test('run: the app is asked for the typed value and kind, tools only when narrowed, a file by its token', async () => {
  const m = mk(), ctx = page(m.api), ws = ctx.GH.ws; await ws.status.load(true);
  await ws.begin({ kind: 'domain', value: 'a.example' }); assert.deepEqual(J(m.calls.run[0]), { query: 'a.example', kind: 'domain' });
  await ws.begin({ kind: 'domain', value: 'b.example', tools: ['b'] }); assert.deepEqual(J(m.calls.run[1]), { query: 'b.example', kind: 'domain', tools: ['b'] });
  const f = await ws.begin({ kind: 'file', value: 'report.pdf', token: 'tok' }); assert.deepEqual(J(m.calls.run[2]), { query: 'tok', kind: 'file' }); assert.equal(f.value, 'report.pdf', 'the screen shows the name, the app gets the token');
  assert.ok(ws.latestFor('domain', 'b.example')); assert.equal(ws.latestFor('domain', 'zzz'), null);
});
test('events become per-tool rows and one merged Overview; progress counts follow', async () => {
  const m = mk(), ctx = page(m.api), ws = ctx.GH.ws, MG = ctx.GhostMerge; await ws.status.load(true);
  const s = await ws.begin({ kind: 'domain', value: 'a.example' });
  assert.deepEqual(s.tools.map((t) => [t.id, t.status]), [['a', 'waiting'], ['b', 'waiting']]);
  m.emit({ searchId: 's1', type: 'tool-start', tool: 'a' }); assert.equal(s.tools[0].status, 'running'); assert.deepEqual({ ...ws.counts(s) }, { total: 2, done: 0, empty: 0, error: 0, skipped: 0, running: 1, waiting: 1, finished: 0 });
  m.emit({ searchId: 's1', type: 'tool-result', tool: 'a', ms: 120, results: [R('a', 'domain', 'a.example'), R('a', 'ip', '203.0.113.5'), R('a', 'username', 'x')] });
  m.emit({ searchId: 's1', type: 'tool-result', tool: 'b', ms: 300, results: [R('b', 'domain', 'A.EXAMPLE.')] });
  assert.equal(s.tools[0].status, 'done'); assert.equal(s.tools[0].count, 3); assert.equal(s.tools[0].withheld, 0); assert.equal(s.tools[0].ms, 120);
  assert.equal(MG.summary(s.merge).entities, 3); assert.equal(MG.summary(s.merge).corroborated, 1);
  assert.equal(s.status, 'running'); m.emit({ searchId: 's1', type: 'done' }); assert.equal(s.status, 'done'); assert.equal(ws.counts(s).finished, 2);
});
test('error, empty and a result list with nothing usable are each shown as what they are', async () => {
  const m = mk(), ctx = page(m.api), ws = ctx.GH.ws; await ws.status.load(true);
  const s = await ws.begin({ kind: 'domain', value: 'a.example' });
  m.emit({ searchId: 's1', type: 'tool-error', tool: 'a', error: { message: 'The service said too many requests.' }, ms: 50 });
  m.emit({ searchId: 's1', type: 'tool-result', tool: 'b', results: [R('b', 'domain', '   ')] });
  assert.equal(s.tools[0].status, 'error'); assert.match(s.tools[0].error, /too many requests/);
  assert.equal(s.tools[1].status, 'empty', 'a tool whose only results were left out found nothing to show'); assert.equal(s.tools[1].withheld, 1);
  m.emit({ searchId: 's1', type: 'tool-error', tool: 'a', error: 'plain text' }); assert.equal(s.tools[0].error, 'plain text');
  m.emit({ searchId: 's1', type: 'tool-empty', tool: 'b' }); assert.equal(s.tools[1].status, 'empty');
});
test('a tool the app did not run (needs a program, off, setting up) is "did not run", not a failure; a cancelled run is stopped', async () => {
  const m = mk(), ctx = page(m.api), ws = ctx.GH.ws; await ws.status.load(true);
  const s = await ws.begin({ kind: 'domain', value: 'a.example' });
  m.emit({ searchId: 's1', type: 'tool-error', tool: 'a', state: 'needs-program', error: 'Runs in the Ghost virtual computer', ms: 0 });
  assert.equal(s.tools[0].status, 'skipped'); assert.equal(s.tools[0].why, 'needs-program'); assert.match(s.tools[0].error, /virtual computer/);
  m.emit({ searchId: 's1', type: 'tool-error', tool: 'b', state: 'failed', error: 'Not available in a search.', ms: 0 }); assert.equal(s.tools[1].status, 'error');
  const c = ws.counts(s); assert.equal(c.skipped, 1); assert.equal(c.error, 1); assert.equal(c.finished, 2);
  m.emit({ searchId: 's1', type: 'done', cancelled: true, summary: { ran: 0 } }); assert.equal(s.status, 'stopped');
});
test('events that arrive before the run call has answered are kept and replayed', async () => {
  const m = mk(), ctx = page(m.api), ws = ctx.GH.ws; await ws.status.load(true);
  const run = m.api.search.run; m.api.search.run = async (o) => { m.emit({ searchId: 's1', type: 'tool-start', tool: 'a' }); m.emit({ searchId: 's1', type: 'tool-result', tool: 'a', results: [R('a', 'domain', 'a.example')] }); return run(o); };
  ctx.GH.api = m.api;
  const s = await ws.begin({ kind: 'domain', value: 'a.example' }); assert.equal(s.tools[0].status, 'done'); assert.equal(s.tools[0].count, 1);
  m.emit({ searchId: 'someone-elses', type: 'done' }); m.emit(null); m.emit({ type: 'done' }); assert.equal(s.status, 'running', 'events for another search or without an id change nothing');
});
test('a tool that never reports is an error when the run ends, and Stop says it stopped', async () => {
  const m = mk(), ctx = page(m.api), ws = ctx.GH.ws; await ws.status.load(true);
  const s = await ws.begin({ kind: 'domain', value: 'a.example' });
  m.emit({ searchId: 's1', type: 'tool-start', tool: 'a' }); m.emit({ searchId: 's1', type: 'tool-result', tool: 'b', results: [R('b', 'domain', 'a.example')] });
  await ws.stop(s); assert.deepEqual(J(m.calls.cancel), [{ searchId: 's1' }]); assert.equal(s.stopping, true);
  m.emit({ searchId: 's1', type: 'done' });
  assert.equal(s.status, 'stopped'); assert.equal(s.tools[0].status, 'error'); assert.match(s.tools[0].error, /Stopped before it answered/); assert.equal(s.tools[1].status, 'done');
  const t = await ws.begin({ kind: 'domain', value: 'q.example' }); m.emit({ searchId: 's1', type: 'done' });
  assert.match(t.tools[0].error, /did not report back|Stopped/);
});
test('a failed run call is passed on in words, and the app\'s refusal is the message', async () => {
  const m = mk(), ctx = page(m.api), ws = ctx.GH.ws; await ws.status.load(true);
  m.api.search.run = async () => ({ ok: false, error: 'No ready tool takes that kind of input.' }); ctx.GH.api = m.api;
  await assert.rejects(() => ws.begin({ kind: 'cidr', value: '10.0.0.0/24' }), /No ready tool takes that/);
  assert.equal(ws.searches.length, 0, 'nothing is listed for a search that did not start');
});
test('the search keeps its list small and orders newest first', async () => {
  const m = mk(), ctx = page(m.api), ws = ctx.GH.ws; await ws.status.load(true);
  let n = 0; m.api.search.run = async (o) => ({ ok: true, searchId: 'x' + ++n, kind: o.kind, value: o.query, tools: ['a'] }); ctx.GH.api = m.api;
  for (let i = 0; i < 25; i++) await ws.begin({ kind: 'domain', value: 'd' + i + '.example' });
  assert.equal(ws.searches.length, 20); assert.equal(ws.searches[0].value, 'd24.example');
});
