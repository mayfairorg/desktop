'use strict';
// A stand-in for window.ghostApp (the Ghost preload) for the tool page harness. Loaded BEFORE util.js so GH.api is this object.
// It answers the calls a tool page makes: builtins.status, connectors.get/test/enable/disable, search.run/cancel + events, jobs.run/get/cancel, pickFile, and the case store.
// Every call is recorded in __mock.calls. The fixtures are made here for the harness; they are never part of the shipped app.
(function () {
  const calls = [];
  const rec = (fn, args) => { calls.push({ fn, args: JSON.parse(JSON.stringify(args === undefined ? null : args)) }); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const searchL = new Set(), builtinsL = new Set();
  const nowIso = () => new Date().toISOString();
  const R = (id, type, value, raw, extra) => ({ entity: { type, value }, source: { tool: id + '-tool', connector: id, version: '1.0.0', url: 'https://service.example/' + id }, observedAt: nowIso(), confidence: 'likely', ...(raw ? { raw } : {}), ...(extra || {}) });

  const FIELDS = {
    domain: [{ name: 'domain', type: 'string', label: 'Domain', maxLength: 253 }, { name: 'types', type: 'enum', label: 'Record types', required: false, values: ['all', 'A', 'AAAA', 'MX', 'NS', 'TXT'] }, { name: 'provider', type: 'enum', label: 'Resolver', required: false, values: ['cloudflare', 'google'] }],
    news: [{ name: 'kind', type: 'enum', label: 'What the query names', values: ['organisation', 'domain', 'place', 'topic'] }, { name: 'query', type: 'string', label: 'Query', maxLength: 120 }, { name: 'mode', type: 'enum', label: 'Result', required: false, values: ['articles', 'timeline'] }, { name: 'limit', type: 'integer', label: 'Most results', required: false, min: 1, max: 25 }],
    file: [{ name: 'file', type: 'file', label: 'File', required: false }, { name: 'types', type: 'enum', label: 'Hashes', required: false, values: ['all', 'sha256', 'sha1', 'md5'] }],
    q: [{ name: 'query', type: 'string', label: 'Query', maxLength: 200 }],
  };
  const many = (n) => Array.from({ length: n }, (_, i) => R('overpass-query', 'ip', '198.51.' + Math.floor(i / 250) + '.' + (i % 250 + 1), { rel: 'address-of', of: 'example.org', country: i % 3 ? 'DE' : 'GB', asn: 'AS' + (64496 + (i % 7)) }));
  // id -> fixture. state/note/tested follow the app's builtins.status contract.
  const T = {
    'dns-doh': { name: 'DNS records (DoH)', category: 'Domains and networks', inputs: ['domain'], fields: 'domain', network: 'keyless-external', desc: 'DNS records of a domain asked of a public DNS-over-HTTPS resolver.', restrictions: 'Sends the domain name you enter to the chosen public resolver, under that resolver\'s privacy policy.', lic: 'MIT', delay: 120,
      results: () => [R('dns-doh', 'ip', '203.0.113.5', { rel: 'address-of', of: 'example.org', rrtype: 'A', ttl: 300 }, { confidence: 'confirmed' }), R('dns-doh', 'ip', '203.0.113.20', { rel: 'address-of', of: 'example.org', rrtype: 'A' }), R('dns-doh', 'ip', '2001:db8::7', { rel: 'address-of', of: 'example.org', rrtype: 'AAAA' }),
        R('dns-doh', 'domain', 'ns1.example.net', { rel: 'nameserver', of: 'example.org' }), R('dns-doh', 'domain', 'mail.example.org', { rel: 'mail-exchanger', of: 'example.org', priority: 10 }), R('dns-doh', 'domain', 'alias.example.org', { rel: 'alias-target', of: 'example.org' }),
        R('dns-doh', 'event', 'TXT example.org: v=spf1 -all', { kind: 'dns-txt', t: '2026-10-01T00:00:00Z' }), R('dns-doh', 'event', 'SOA example.org: primary ns1.example.net, serial 2026102701', { kind: 'dns-soa' })] },
    'rdap-ip-asn': { name: 'IP and network registration (RDAP)', category: 'Domains and networks', inputs: ['ip', 'asn', 'cidr'], fields: 'q', network: 'rate-limited', desc: 'Who the registries say holds an address or network.', lic: 'CC0-1.0', delay: 60,
      results: () => [R('rdap-ip-asn', 'asn', 'AS64496', { name: 'EXAMPLE-NET', country: 'GB', prefix: '203.0.113.0/24' }), R('rdap-ip-asn', 'organisation', 'Example Networks Ltd', { handle: 'ORG-EX1', country: 'GB' })] },
    'ct-crtsh': { name: 'Certificates in public logs', category: 'Domains and networks', inputs: ['domain'], fields: 'q', network: 'keyless-external', state: 'failed', note: 'Could not be set up: its files are not valid.', tested: 'failed', testNote: 'its files are not valid', lic: 'MIT' },
    'rdap-domain': { name: 'Domain registration (RDAP)', category: 'Domains and networks', inputs: ['domain'], fields: 'q', network: 'rate-limited', state: 'off', tested: 'tested', lic: 'CC0-1.0', delay: 40, results: () => [R('rdap-domain', 'organisation', 'Example Registrar Inc', { handle: 'REG-1', country: 'US', status: 'active' })] },
    gleif: { name: 'GLEIF legal entities', category: 'Companies', inputs: ['org-name', 'lei'], fields: 'news', network: 'keyless-external', lic: 'CC0-1.0', delay: 50, error: 'The service answered 503 (try again later).' },
    wikidata: { name: 'Wikidata organisations and places', category: 'Companies', inputs: ['org-name', 'place-text'], fields: 'q', network: 'keyless-external', lic: 'CC0-1.0', delay: 50, results: () => [] },
    'sec-edgar': { name: 'SEC EDGAR filings', category: 'Companies', inputs: ['org-name', 'domain'], fields: 'q', network: 'rate-limited', lic: 'CC0-1.0', delay: 50,
      results: () => [R('sec-edgar', 'organisation', 'Example Holdings Inc', { cik: '0000123456', country: 'US', description: 'Annual report filer' }), R('sec-edgar', 'username', 'someone_private', { rel: 'x' })] },
    exiftool: { name: 'Metadata with ExifTool', category: 'Files and images', inputs: ['file'], fields: 'file', network: 'local', state: 'needs-program', note: 'Needs ExifTool, which is not on this computer. It runs in the virtual computer once the program is there.', tested: 'pending', lic: 'GPL-1.0-or-later', reqs: [{ name: 'exiftool', status: 'missing', detail: 'not found on this computer' }] },
    'hash-file': { name: 'Hashes', category: 'Files and images', inputs: ['file'], fields: 'file', network: 'local', lic: 'MIT', delay: 40, job: true,
      results: () => [R('hash-file', 'document', 'photo.jpg', { sha256: 'a'.repeat(64), sha1: 'b'.repeat(40), size: 204800, mime: 'image/jpeg' }, { confidence: 'confirmed' })] },
    'gdelt-doc': { name: 'News coverage (GDELT)', category: 'News', inputs: ['keyword', 'org-name', 'domain', 'place-text'], fields: 'news', network: 'rate-limited', lic: 'CC-BY-4.0', restrictions: 'Contains data from the GDELT Project; credit the source.', delay: 80,
      results: () => [R('gdelt-doc', 'url', 'https://news.example/harbour-dredging', { title: 'Harbour dredging contract awarded to a regional firm after a long review', domain: 'news.example', seen: '2026-10-20T08:00:00Z', language: 'English', sourceCountry: 'United Kingdom' }),
        R('gdelt-doc', 'url', 'https://daily.example/port-expansion', { title: 'Port expansion plans', domain: 'daily.example', seen: '2026-10-22T10:30:00Z', language: 'English', sourceCountry: 'Germany' }),
        R('gdelt-doc', 'event', 'news volume 2026-10-20 08:00Z: 0.4% of monitored coverage', { kind: 'news-volume', t: '2026-10-20T08:00:00Z' })] },
    nominatim: { name: 'Place search (OpenStreetMap)', category: 'Places', inputs: ['place-text', 'coords'], fields: 'q', network: 'rate-limited', lic: 'ODbL-1.0', delay: 60,
      results: () => [R('nominatim', 'place', 'Rotterdam, South Holland, Netherlands', { lat: 51.9244, lon: 4.4777, kind: 'city' }), R('nominatim', 'place', 'Rotterdam Centraal', { lat: 51.9249, lon: 4.4689, description: 'railway station' })] },
    'overpass-query': { name: 'Map features in a small area', category: 'Places', inputs: ['coords', 'place-text'], fields: 'q', network: 'rate-limited', lic: 'ODbL-1.0', delay: 60, results: () => many(600) },
    'nasa-cmr': { name: 'Satellite data search (NASA Earthdata)', category: 'Places', inputs: ['place-text', 'coords'], fields: 'q', network: 'keyless-external', lic: 'CC0-1.0', delay: 6000, results: () => [R('nasa-cmr', 'url', 'https://cmr.example/granule/1', { title: 'Granule 1' })] },
    'wayback-cdx': { name: 'Internet Archive captures', category: 'Archive', inputs: ['url', 'domain'], fields: 'q', network: 'keyless-external', tested: 'failed', testNote: 'the archive did not answer in time', lic: 'CC0-1.0', delay: 50,
      results: () => [R('wayback-cdx', 'url', 'https://example.org/', { rel: 'capture', title: 'Example Domain', seen: '2024-05-01T00:00:00Z' })] },
    nvd: { name: 'NVD vulnerabilities', category: 'Threat intel', inputs: ['keyword'], fields: 'q', network: 'rate-limited', lic: 'CC0-1.0', delay: 40,
      results: () => [R('nvd', 'vulnerability', 'CVE-2026-0001', { score: 9.8, vector: 'network', summary: 'A flaw in an example library allows remote code execution when parsing a crafted file.', published: '2026-10-01' }), R('nvd', 'vulnerability', 'CVE-2026-0002', { score: 5.3, vector: 'local' })] },
    'cisa-kev': { name: 'CISA known exploited list', category: 'Threat intel', inputs: ['keyword'], fields: 'q', network: 'keyless-external', state: 'setting-up', note: 'Getting ready. This takes a moment.', tested: 'pending', lic: 'CC0-1.0' },
  };
  const toolOf = (id) => T[id] || null;
  const fieldsOf = (t) => FIELDS[t.fields] || FIELDS.q;
  const stateOf = (id) => { const t = T[id]; return t.state || 'ready'; };
  const status = () => ({ total: Object.keys(T).length, ready: Object.keys(T).filter((i) => stateOf(i) === 'ready').length, 'setting-up': 0, failed: [],
    tools: Object.keys(T).map((id) => ({ id, name: T[id].name, category: T[id].category, inputs: T[id].inputs, state: stateOf(id), note: T[id].note || '', tested: T[id].tested || (stateOf(id) === 'ready' ? 'tested' : 'pending'), testNote: T[id].testNote || '' })) });
  const entry = (id) => {
    const t = toolOf(id); if (!t) return null;
    const tested = t.tested || (stateOf(id) === 'ready' ? 'tested' : 'pending');
    return { id, name: t.name, version: '1.0.0', description: t.desc || 'A lookup that ships with Mayfair.', capabilities: ['passive'], scope: 'passive', network: t.network || 'keyless-external', licence: { spdx: t.lic || 'MIT', mode: t.reqs ? 'separate-program' : 'bundled' }, permissions: t.network === 'local' ? [] : ['network'], externalRestrictions: t.restrictions || 'None.',
      install: { requirements: t.reqs || [], installed: stateOf(id) === 'ready', verified: tested === 'tested' ? 'tested' : tested === 'failed' ? 'failed' : 'not-tested', lastTest: tested === 'pending' ? null : { t: '2026-10-27T09:15:00.000Z', ok: tested === 'tested', detail: t.testNote || '' } },
      state: stateOf(id) === 'ready' ? 'enabled' : stateOf(id) === 'off' ? 'disabled' : 'approved', approvedAt: '2026-10-27T09:00:00.000Z', health: stateOf(id) === 'failed' ? 'broken' : 'ok', input: { fields: fieldsOf(t) }, limits: { timeoutMs: 20000, maxOutputBytes: 1000000, maxConcurrent: 1 } };
  };
  const emit = (set, p) => { for (const f of [...set]) { try { f(p); } catch { /* listener failed */ } } };
  let sid = 0; const searches = new Map(); const jobs = new Map(); let jid = 0;

  const db = {};
  const api = {
    status: async () => ({ installed: true }),
    cases: {
      list: async () => Object.values(db).map((j) => { const c = JSON.parse(j); return { id: c.id, title: c.title, entities: Object.keys(c.entities).length, updated: c.updated }; }),
      get: async (id) => db[id],
      put: async (id, json) => { db[id] = json; return { ok: true, savedAt: nowIso() }; },
      create: async (title) => { const c = window.GhostCase.newCase(title); db[c.id] = JSON.stringify(c); return { json: db[c.id] }; },
      delete: async (id) => { delete db[id]; return { ok: true }; },
    },
    connectors: {
      list: async () => Object.keys(T).map(entry),
      get: async (id) => { rec('connectors.get', id); return entry(id); },
      test: async (id) => { rec('connectors.test', id); await wait(60); const t = T[id]; if (t.tested === 'failed') return { passed: false, detail: t.testNote || 'failed' }; t.tested = 'tested'; return { passed: true }; },
      enable: async (id) => { rec('connectors.enable', id); await wait(30); if (T[id].state === 'failed') throw new Error('Its files are not valid, so it cannot be switched on.'); T[id].state = null; emit(builtinsL, {}); return { ok: true }; },
      disable: async (id) => { rec('connectors.disable', id); await wait(30); T[id].state = 'off'; emit(builtinsL, {}); return { ok: true }; },
      requestApproval: async () => ({ ok: true }),
    },
    builtins: { status: async () => { rec('builtins.status'); return status(); } },
    search: {
      classify: async (o) => ({ kind: 'keyword', value: o.query, alternatives: [] }),
      run: async (o) => {
        rec('search.run', o);
        if (!o || !Array.isArray(o.tools) || o.tools.length !== 1) throw new Error('bad arguments');
        const id = o.tools[0], t = toolOf(id); if (!t) throw new Error('That tool is not installed.');
        const searchId = 's' + (++sid); const s = { id: searchId, cancelled: false, tool: id }; searches.set(searchId, s);
        (async () => {
          await wait(15); emit(searchL, { searchId, type: 'tool-start', tool: id });
          const t0 = Date.now(); const end = t0 + (t.delay || 50);
          while (Date.now() < end) { if (s.cancelled) { emit(searchL, { searchId, type: 'done' }); return; } await wait(20); }
          if (s.cancelled) { emit(searchL, { searchId, type: 'done' }); return; }
          if (t.error) emit(searchL, { searchId, type: 'tool-error', tool: id, error: t.error, ms: Date.now() - t0 });
          else { const r = t.results ? t.results() : []; emit(searchL, { searchId, type: r.length ? 'tool-result' : 'tool-empty', tool: id, results: r.length ? r : undefined, ms: Date.now() - t0 }); }
          emit(searchL, { searchId, type: 'done' });
        })();
        return { ok: true, searchId, kind: o.kind, value: o.query, tools: [id] };
      },
      cancel: async (o) => { rec('search.cancel', o); const s = searches.get(o && o.searchId); if (s) s.cancelled = true; return { ok: true }; },
    },
    jobs: {
      run: async (o) => { rec('jobs.run', o); const t = toolOf(o.connector); if (!t) throw new Error('That connector is not installed.'); const jobId = 'j' + (++jid); jobs.set(jobId, { t, n: 0, cancelled: false }); return { jobId }; },
      get: async (id) => { const j = jobs.get(id); if (!j) return null; j.n++; if (j.cancelled) return { status: 'cancelled' }; if (j.n < 2) return { status: 'running', progress: 0.5, message: 'working' }; const r = j.t.results ? j.t.results() : []; return { status: 'done', results: r, resultCount: r.length }; },
      cancel: async (id) => { rec('jobs.cancel', id); const j = jobs.get(id); if (j) j.cancelled = true; return { ok: true }; },
    },
    pickFile: async () => { rec('pickFile'); return { token: 'tok_abcdef123456', name: 'photo.jpg', size: 204800 }; },
    onSearch: (cb) => { searchL.add(cb); return () => searchL.delete(cb); },
    onBuiltins: (cb) => { builtinsL.add(cb); return () => builtinsL.delete(cb); },
  };
  window.ghostApp = api;
  window.__mock = { calls, T, db, reset() { calls.length = 0; }, last: (fn) => [...calls].reverse().find((c) => c.fn === fn) || null, count: (fn) => calls.filter((c) => c.fn === fn).length, emitBuiltins: () => emit(builtinsL, {}) };
})();
