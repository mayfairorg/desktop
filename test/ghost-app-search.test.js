'use strict';
// The master search run: which tools join, what each one is given, the event stream, cancel, and that nothing ever throws to the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const Mods = require('../src/main/ghost/modules');
const M = require('../src/main/ghost/manifest');
const { PickStore } = require('../src/main/ghost/picks');
const { Search, KINDS } = require('../src/main/ghost/app/search');
const TM = require('../src/main/ghost/app/toolmap');
const { BLOCKED } = require('../src/main/ghost/app/service');

const IDS = Mods.MODULES.map((m) => m.meta.id);
const manifests = Object.fromEntries(Mods.MODULES.map((m) => [m.meta.id, Mods.toManifest(m.meta)]));

// A set of fakes: tool rows, a manager that knows the real input fields, and a runner whose answers the test scripts.
function rig(over = {}) {
  const rows = {}; for (const id of IDS) rows[id] = { id, name: id, state: 'ready', note: '', ...(over.rows && over.rows[id] || {}) };
  for (const [id, st] of Object.entries(over.states || {})) rows[id].state = st;
  const setup = { row: (id) => rows[id] || null };
  const manager = { get: (id) => (manifests[id] ? { id, scope: manifests[id].scope, input: manifests[id].input } : null) };
  const submitted = [], cancelled = [], jobs = new Map(); let n = 0, running = 0, peak = 0;
  const script = over.script || (() => ({ status: 'done', results: [{ entity: { type: 'domain', value: 'example.com' } }], resultCount: 1 }));
  const runner = {
    submit: over.submit || ((a) => { submitted.push(a); const jobId = 'j' + (++n); jobs.set(jobId, a); return { ok: true, jobId, status: 'queued' }; }),
    wait: async (jobId) => {
      running++; peak = Math.max(peak, running);
      try {
        if (!jobs.has(jobId)) jobs.set(jobId, { connector: 'unknown' });
        const a = jobs.get(jobId); await new Promise((r) => setTimeout(r, over.delay || 1));
        if (over.hold && over.hold(a)) await new Promise((res) => { a.release = res; });
        return a.cancelled ? { status: 'cancelled', results: [] } : script(a);
      } finally { running--; }
    },
    cancel: (jobId) => { cancelled.push(jobId); const a = jobs.get(jobId); if (a) { a.cancelled = true; if (a.release) a.release(); } return true; },
  };
  const picks = new PickStore(); const events = [], logs = [];
  const emit = (name, p) => { assert.equal(name, 'search'); events.push(p); };
  const search = new Search({ setup, manager, runner, picks, emit, log: { warn: (e, f) => logs.push([e, f]) }, blocked: over.blocked || ((e) => BLOCKED.test([e.id, e.name].join(' '))), queueRetryMs: 1, ...(over.opts || {}) });
  const finished = (id) => new Promise((res) => { const t = setInterval(() => { if (events.some((e) => e.searchId === id && e.type === 'done')) { clearInterval(t); res(events.filter((e) => e.searchId === id)); } }, 2); });
  return { search, submitted, cancelled, events, logs, picks, finished, peak: () => peak, rows };
}

test('every master-search input is accepted by the tool\'s own manifest, for every kind the tool takes', () => {
  const sample = { domain: 'example.com', ip: '8.8.8.8', asn: 'AS15169', url: 'https://example.com/a', 'org-name': 'Acme Corp', lei: '5493001KJTIIGC8Y1R12', 'place-text': 'Eiffel Tower, Paris', coords: '51.5007,-0.1246', keyword: 'ransomware', file: 'abcdefgh12345678', 'cert-hash': 'a'.repeat(64), cidr: '10.0.0.0/8' };
  let checked = 0;
  for (const [id, t] of Object.entries(TM.TOOLS)) {
    assert.ok(manifests[id], id + ' is a shipped tool');
    for (const k of t.kinds) {
      assert.ok(KINDS.includes(k), id + ' ' + k);
      const input = t.input(k, sample[k]);
      const v = M.validateInput(manifests[id], input);
      assert.ok(v.ok, id + ' / ' + k + ': ' + JSON.stringify(v.errors) + ' ' + JSON.stringify(input)); checked++;
    }
  }
  assert.ok(checked >= 30, 'checked ' + checked);
  for (const id of IDS) assert.ok(TM.TOOLS[id], id + ' has a place in the tool index');
  assert.deepEqual(Object.values(TM.TOOLS).map((t) => t.category).filter((c) => !TM.CATEGORIES.includes(c)), []);
  // a CVE id goes to NVD as a CVE; a bare number for coords never leaves the box
  assert.equal(TM.TOOLS.nvd.input('keyword', 'cve-2021-44228').kind, 'cve');
  assert.equal(TM.TOOLS.nvd.input('keyword', 'log4j').kind, 'keyword');
  assert.equal(TM.TOOLS['usgs-landsat'].input('coords', '51.5,-0.12').bbox, '-0.17,51.45,-0.07,51.55');
});
test('no tool takes a kind that is a person, username, email or phone, and no tool of that sort is mapped', () => {
  for (const id of Object.keys(TM.TOOLS)) assert.doesNotMatch(id, BLOCKED, id);
  for (const t of Object.values(TM.TOOLS)) for (const k of t.kinds) assert.doesNotMatch(k, /person|user|email|phone/);
});

test('a domain search asks exactly the ready tools that take a domain, all at once, and streams one event per tool, then done', async () => {
  const r = rig({ script: (a) => (a.connector === 'ct-crtsh' ? { status: 'done', results: [], resultCount: 0 } : a.connector === 'rdap-domain' ? { status: 'failed', error: 'exit code 1: boom', results: [] } : { status: 'done', results: [{ entity: { type: 'domain', value: 'example.com' } }, { entity: { type: 'ip', value: '1.2.3.4' } }], resultCount: 2 }) });
  const res = r.search.run({ query: 'Example.com', caseId: 'case-1234abcd' });
  assert.equal(res.ok, true); assert.match(res.searchId, /^s-[a-f0-9]{16}$/); assert.equal(res.kind, 'domain'); assert.equal(res.value, 'example.com');
  const want = Object.entries(TM.TOOLS).filter(([, t]) => t.kinds.includes('domain') && !t.own).map(([id]) => id).sort();
  assert.deepEqual([...res.tools].sort(), want);
  assert.ok(want.length >= 6);
  const ev = await r.finished(res.searchId);
  assert.deepEqual(r.submitted.map((s) => s.connector).sort(), want, 'every one of them was started');
  for (const id of want) {
    const mine = ev.filter((e) => e.tool === id).map((e) => e.type);
    assert.equal(mine[0], 'tool-start', id); assert.equal(mine.length, 2, id + ' ' + mine);
    assert.ok(['tool-result', 'tool-empty', 'tool-error'].includes(mine[1]), id);
  }
  assert.equal(ev.find((e) => e.tool === 'ct-crtsh' && e.type !== 'tool-start').type, 'tool-empty');
  const bad = ev.find((e) => e.tool === 'rdap-domain' && e.type === 'tool-error'); assert.match(bad.error, /boom/);
  const ok = ev.find((e) => e.tool === 'dns-doh' && e.type === 'tool-result'); assert.equal(ok.results.length, 2); assert.equal(typeof ok.ms, 'number');
  assert.equal(ev[ev.length - 1].type, 'done'); assert.equal(ev.filter((e) => e.type === 'done').length, 1);
  assert.equal(ev.every((e) => e.caseId === 'case-1234abcd'), true);
  const s = ev[ev.length - 1].summary; assert.equal(s.ran, want.length); assert.equal(s.empty, 1); assert.equal(s.errors, 1);
  // what each tool was handed
  const dns = r.submitted.find((s) => s.connector === 'dns-doh').input; assert.deepEqual(dns, { domain: 'example.com', types: 'all' });
  assert.equal(r.submitted.every((s) => s.scope === undefined), true, 'passive tools need no scope');
});
test('tools that are not ready are never run: a program that is missing, a tool switched off, one still setting up, one that failed', async () => {
  const r = rig({ states: { 'gdelt-doc': 'off', 'dns-doh': 'setting-up', 'rdap-domain': 'failed' }, rows: { 'ct-crtsh': { state: 'needs-program', note: 'Runs in the Ghost virtual computer' } } });
  const res = r.search.run({ query: 'example.com' });
  assert.equal(res.tools.includes('dns-doh'), false); assert.equal(res.tools.includes('rdap-domain'), false); assert.equal(res.tools.includes('gdelt-doc'), false); assert.equal(res.tools.includes('ct-crtsh'), false);
  const ev = await r.finished(res.searchId);
  assert.equal(r.submitted.some((s) => ['dns-doh', 'rdap-domain', 'gdelt-doc', 'ct-crtsh'].includes(s.connector)), false);
  const st = (id) => ev.find((e) => e.tool === id);
  assert.equal(st('ct-crtsh').state, 'needs-program'); assert.equal(st('ct-crtsh').error, 'Runs in the Ghost virtual computer');
  assert.equal(st('gdelt-doc').state, 'off'); assert.equal(st('dns-doh').state, 'setting-up'); assert.equal(st('rdap-domain').state, 'failed');
});
test('the tools that need a program join a file search only when they are ready (their requirement check passed)', async () => {
  const r = rig({ states: { exiftool: 'needs-program', mediainfo: 'needs-program', tika: 'needs-program', ocrmypdf: 'needs-program', 'gdal-info': 'needs-program' } });
  const tok = r.picks.add('/tmp/some-file.jpg', 10);
  const res = r.search.run({ query: tok, kind: 'file' });
  assert.equal(res.ok, true);
  assert.deepEqual([...res.tools].sort(), ['exif-meta', 'ffmpeg-frames', 'hash-file', 'local-snapshot', 'tesseract']);
  const ev = await r.finished(res.searchId);
  assert.equal(r.submitted.length, 5);
  const tokens = r.submitted.map((s) => s.input.file); assert.equal(new Set(tokens).size, 5, 'each tool has its own one-time token'); assert.equal(tokens.includes(tok), false);
  for (const t of tokens) assert.ok(r.picks.peek(t), 'the token stands for the chosen file'); assert.equal(r.picks.peek(tokens[0]).path, '/tmp/some-file.jpg');
  assert.equal(ev.filter((e) => e.state === 'needs-program').length, 5);
  assert.equal(ev.filter((e) => e.state === 'needs-program').every((e) => !/fail/i.test(e.error)), true);
});
test('a file search with a token that is gone, a kind that is not a kind, or nothing typed is refused in plain words, not thrown', () => {
  const r = rig();
  for (const o of [{ query: 'abcdefgh12345678', kind: 'file' }, { query: 'x', kind: 'email' }, { query: '', }, { query: '   ' }, { query: 'nope', kind: 'ip' }, null, undefined, 5, { query: { a: 1 } }, { query: 42 }]) {
    let out; assert.doesNotThrow(() => { out = r.search.run(o); }); assert.equal(out.ok, false); assert.match(out.error, /\S/); assert.equal(out.searchId, undefined);
  }
  assert.equal(r.submitted.length, 0);
});
test('a kind nothing takes yet answers no-tools, with the not-ready tools named; cidr and certificate hashes have no ready tool', () => {
  const r = rig();
  for (const q of ['10.0.0.0/8', 'a'.repeat(64)]) { const out = r.search.run({ query: q }); assert.equal(out.ok, false); assert.equal(out.code, 'no-tools'); assert.match(out.error, /No tool that is ready/); }
  const r2 = rig({ states: { exiftool: 'needs-program', mediainfo: 'needs-program', tika: 'needs-program', ocrmypdf: 'needs-program', 'gdal-info': 'needs-program', 'exif-meta': 'off', 'hash-file': 'off', tesseract: 'needs-program', 'ffmpeg-frames': 'needs-program', 'local-snapshot': 'off' } });
  const tok = r2.picks.add('/tmp/f.bin', 1); const out = r2.search.run({ query: tok, kind: 'file' });
  assert.equal(out.code, 'no-tools'); assert.match(out.error, /need a program/); assert.ok(out.skipped.length >= 5);
});
test('naming tools asks exactly those tools; a tool that cannot take the kind, a tool switched off and an unknown tool are answered honestly', async () => {
  const r = rig({ states: { 'gdelt-doc': 'off' } });
  const res = r.search.run({ query: 'example.com', tools: ['dns-doh', 'gdelt-doc', 'rdns', 'nope-tool', 'overpass-query'] });
  assert.equal(res.ok, true); assert.deepEqual(res.tools, ['dns-doh']);
  const ev = await r.finished(res.searchId);
  assert.deepEqual(r.submitted.map((s) => s.connector), ['dns-doh']);
  assert.equal(ev.find((e) => e.tool === 'gdelt-doc').state, 'off');
  assert.match(ev.find((e) => e.tool === 'rdns').error, /own page/); assert.match(ev.find((e) => e.tool === 'nope-tool').error, /not part of Ghost/); assert.match(ev.find((e) => e.tool === 'overpass-query').error, /own page/);
});
test('a tool page runs one tool through the same path with the kind it chose; the person\'s own kind overrides the guess', async () => {
  const r = rig();
  const res = r.search.run({ query: 'https://www.Example.com/x', kind: 'domain', tools: ['rdap-domain'] });
  assert.equal(res.value, 'www.example.com'); assert.deepEqual(res.tools, ['rdap-domain']);
  await r.finished(res.searchId); assert.deepEqual(r.submitted[0].input, { domain: 'www.example.com' });
  const r2 = rig(); const res2 = r2.search.run({ query: 'someone@example.com' }); assert.equal(res2.kind, 'keyword');
  const res3 = r2.search.run({ query: 'someone@example.com', kind: 'domain' }); assert.equal(res3.ok, false, 'the whole address is not a domain; the page offers the domain part as the alternative');
});
test('a tool the Ghost list blocks is never run, even when named', async () => {
  const r = rig({ blocked: (e) => e.id === 'rdns' });
  const res = r.search.run({ query: '8.8.8.8', tools: ['rdns', 'rdap-ip-asn'] });
  await r.finished(res.searchId); assert.deepEqual(r.submitted.map((s) => s.connector), ['rdap-ip-asn']);
});
test('an active tool is never part of a search', async () => {
  const r = rig(); const m = manifests['dns-doh'];
  const orig = r.search.manager.get; r.search.manager.get = (id) => (id === 'dns-doh' ? { ...orig(id), scope: 'active' } : orig(id));
  const res = r.search.run({ query: 'example.com', tools: ['dns-doh'] }); const ev = await r.finished(res.searchId);
  assert.equal(r.submitted.length, 0); assert.match(ev.find((e) => e.tool === 'dns-doh').error, /Not available/); assert.ok(m);
});
test('cancel stops the tools that are running and the ones still waiting, and "done" says it was cancelled', async () => {
  const r = rig({ hold: () => true, opts: { maxParallel: 2 } });
  const res = r.search.run({ query: 'example.com' });
  await new Promise((x) => setTimeout(x, 30));
  assert.equal(r.submitted.length, 2, 'only two at a time were started');
  assert.deepEqual(r.search.cancel(res.searchId), { ok: true, cancelled: true });
  const ev = await r.finished(res.searchId);
  assert.equal(r.cancelled.length, 2); assert.equal(r.submitted.length, 2, 'the waiting ones never started');
  assert.equal(ev[ev.length - 1].cancelled, true); assert.equal(ev.some((e) => e.type === 'tool-result'), false);
  assert.deepEqual(r.search.cancel(res.searchId), { ok: true, cancelled: false });
  assert.deepEqual(r.search.cancel('s-0000000000000000'), { ok: true, cancelled: false });
});
test('at most six tools of one search run at once', async () => {
  const r = rig({ delay: 15 }); const res = r.search.run({ query: 'ransomware' }); await r.finished(res.searchId);
  assert.ok(r.peak() <= 6 && r.peak() >= 2, 'peak ' + r.peak());
});
test('a full job queue is waited out, not reported as a failure', async () => {
  let tries = 0; const r = rig({ submit: (a) => { if (a.connector === 'dns-doh' && ++tries < 4) return { ok: false, error: 'queue-full', message: 'too many jobs are waiting' }; return { ok: true, jobId: 'x' + Math.random(), status: 'queued' }; }, script: () => ({ status: 'done', results: [], resultCount: 0 }) });
  const res = r.search.run({ query: 'example.com' }); const ev = await r.finished(res.searchId);
  assert.equal(tries, 4); assert.equal(ev.find((e) => e.tool === 'dns-doh' && e.type !== 'tool-start').type, 'tool-empty');
});
test('nothing throws to the page: a runner that throws, refuses or never answers properly becomes a tool-error and the search still ends', async () => {
  const r = rig({ submit: (a) => { if (a.connector === 'dns-doh') throw new Error('runner exploded'); if (a.connector === 'rdap-domain') return { ok: false, error: 'not-enabled', message: 'the connector is not enabled' }; return { ok: true, jobId: 'k' + a.connector, status: 'queued' }; }, script: (a) => (a.connector === 'ct-crtsh' ? null : { status: 'timed-out', error: 'no answer within 1000 ms', results: [] }) });
  r.search.runner.wait = async (id) => (id === 'kct-crtsh' ? null : { status: 'timed-out', error: 'no answer within 1000 ms', results: [] });
  const res = r.search.run({ query: 'example.com' }); const ev = await r.finished(res.searchId);
  const er = (id) => ev.find((e) => e.tool === id && e.type === 'tool-error');
  assert.match(er('dns-doh').error, /runner exploded/); assert.match(er('rdap-domain').error, /not enabled/); assert.match(er('ct-crtsh').error, /did not answer/); assert.match(er('common-crawl-index').error, /no answer within/);
  assert.equal(ev[ev.length - 1].type, 'done');
  assert.ok(r.logs.some(([e]) => e === 'search-tool-refused'), 'refusals are logged');
  // an emit that throws, and a setup that throws, are swallowed
  const r2 = rig(); r2.search.emit = () => { throw new Error('window gone'); }; assert.doesNotThrow(() => r2.search.run({ query: 'example.com' }));
  const r3 = rig(); r3.search.setup = { row: () => { throw new Error('boom'); } }; const o = r3.search.run({ query: 'example.com' }); assert.equal(o.ok, false); assert.match(o.error, /could not start/);
});
test('a tool that says its program is not installed is shown as needs-program, not as a failed tool', async () => {
  const r = rig({ script: (a) => (a.connector === 'tesseract' ? { status: 'failed', error: 'exit code 3: Tesseract is not installed', results: [] } : { status: 'done', results: [], resultCount: 0 }) });
  const tok = r.picks.add('/tmp/x.png', 5); const res = r.search.run({ query: tok, kind: 'file' }); const ev = await r.finished(res.searchId);
  assert.equal(ev.find((e) => e.tool === 'tesseract' && e.type === 'tool-error').state, 'needs-program');
});
test('results are the runner\'s normalised results, capped at 1000 with the true total reported', async () => {
  const big = Array.from({ length: 1200 }, (_, i) => ({ entity: { type: 'domain', value: 'h' + i + '.example.com' } }));
  const r = rig({ script: () => ({ status: 'done', results: big, resultCount: 1200 }) });
  const res = r.search.run({ query: '8.8.8.8', tools: ['rdns'] }); const ev = await r.finished(res.searchId);
  const e = ev.find((x) => x.type === 'tool-result'); assert.equal(e.results.length, 1000); assert.equal(e.total, 1200); assert.equal(e.truncated, true);
});
