'use strict';
// The keyless connectors: gleif, sec-edgar, nominatim, overpass-query, nasa-gibs, earth-search-stac, gdelt-geo, common-crawl-index, rdns,
// cisa-kev, nvd (network) and hash-file, stix-import, local-snapshot (local). No test reaches the network: the global fetch is a trap and
// every module gets a mock transport built from hand-labelled, invented fixtures (test/fixtures/ghost-modules-keyless.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tmp } = require('./ghost-helpers');
const { makeFetch } = require('./fixtures/ghost-modules-mock');
const fixtures = require('./fixtures/ghost-modules-keyless.json');
const mods = require('../src/main/ghost/modules');
const { validateResult } = require('../src/main/ghost/result');
const { validateManifest } = require('../src/main/ghost/manifest');
const L = (id) => require('../src/main/ghost/modules/lib/' + id);

const realFetch = globalThis.fetch;
globalThis.fetch = async (u) => { throw new Error('LIVE NETWORK CALL IN A TEST: ' + u); };
test.after(() => { globalThis.fetch = realFetch; });

const NOW = new Date('2026-10-27T09:00:00.000Z');
const noSleep = async () => {};
const NETWORK = { gleif: 'rate-limited', 'sec-edgar': 'rate-limited', nominatim: 'rate-limited', 'overpass-query': 'rate-limited', 'nasa-gibs': 'rate-limited', 'earth-search-stac': 'rate-limited', 'gdelt-geo': 'rate-limited', 'common-crawl-index': 'rate-limited', rdns: 'keyless-external', 'cisa-kev': 'rate-limited', nvd: 'rate-limited' };
const LOCAL = ['hash-file', 'stix-import', 'local-snapshot'];
const IDS = [...Object.keys(NETWORK), ...LOCAL];

// isolate the two modules that keep a small file between runs
function isolate() {
  const dir = tmp('mfd-kl-');
  const kev = L('cisa-kev').cache, nvd = L('nvd').budget;
  Object.assign(kev, { dir: () => dir, ttlMs: 12 * 3600 * 1000, now: () => NOW.getTime() });
  Object.assign(nvd, { file: () => path.join(dir, 'nvd.json'), now: () => NOW.getTime() });
  return dir;
}
function run(id, input, { overrides = [], egress = null, fetch = null } = {}) {
  isolate();
  const f = fetch || makeFetch(fixtures, { overrides });
  return mods.runModule(id, input, { fetch: f, sleep: noSleep, now: () => NOW, egress }).then((r) => { r.fetch = f; return r; });
}
function valid(r, id) {
  assert.ok(r.results.length > 0, 'has results');
  for (const line of r.results) { const v = validateResult(line, { connector: id, now: NOW.getTime() }); assert.equal(v.ok, true, v.error + ' ' + JSON.stringify(line)); }
  assert.deepEqual(r.fetch ? r.fetch.unmocked : [], [], 'every request was mocked');
}
const vals = (r, type) => r.results.filter((x) => x.entity.type === type).map((x) => x.entity.value);
const text = (r) => JSON.stringify(r.results);
const hits = (r) => (r.fetch && r.fetch.log ? r.fetch.log.length : 0);

// ---------------- registration, manifests, honest network class ----------------
test('keyless: 14 connectors registered with valid manifests, the right network class, attribution and no person input', () => {
  for (const id of IDS) {
    const m = mods.byId(id);
    assert.ok(m, id);
    const man = mods.toManifest(m.meta);
    const v = validateManifest(man);
    assert.equal(v.ok, true, id + ' ' + JSON.stringify(v.errors || v));
    assert.equal(man.network, NETWORK[id] || 'local', id);
    assert.equal(man.permissions.includes('network'), man.network !== 'local', id);
    assert.equal(man.licence.mode, 'bundled');
    assert.ok(m.meta.attribution && m.meta.dataTerms && m.meta.restrictions, id + ' states attribution, data terms and restrictions');
    assert.match(man.externalRestrictions, /Data terms:/);
    assert.ok(m.meta.selfTest.expect.minResults >= 1, id);
    for (const f of m.meta.files) assert.ok(fs.existsSync(path.join(__dirname, '..', 'src/main/ghost/modules/lib', f)), id + ' ' + f);
    for (const f of man.input.fields) assert.ok(!/e-?mail|user(name)?|handle|phone|person|people|^name$/i.test(f.name), id + ' ' + f.name);
    if (man.network === 'local') { assert.deepEqual(m.meta.hosts, [], id); assert.equal(man.permissions.includes('network'), false); }
  }
});
test('keyless: client-side limits sit at or under each service\'s published policy', () => {
  const c = (id) => mods.byId(id).meta.client;
  assert.ok(c('sec-edgar').rps <= 10 && c('sec-edgar').rps >= 1, 'SEC 10 req/s cap');
  assert.ok(c('nominatim').rps <= 1 && c('nominatim').maxRequests === 1, 'Nominatim 1 req/s, one place a run');
  assert.ok(c('gdelt-geo').rps <= 0.2, 'GDELT one request per 5 s');
  assert.ok(c('overpass-query').rps <= 1 && c('overpass-query').maxRequests === 1);
  assert.ok(c('gleif').rps <= 1);
  assert.ok(c('common-crawl-index').rps <= 1);
  assert.ok(c('nasa-gibs').maxRequests <= 2);
  assert.ok(c('nvd').maxRequests === 1);
  // a run of N requests to one host is spaced by the shared client: prove it with the real client for the 5/s and the 1/5 s cases
  const { createClient } = require('../src/main/ghost/modules/lib/core');
  const sleeps = [];
  let t = 1e12;
  const cl = createClient({ fetch: async () => new Response('{}'), hosts: ['a.example'], rps: c('gdelt-geo').rps, sleep: async (ms) => { sleeps.push(ms); }, now: () => t });
  return cl.get('https://a.example/1').then(() => cl.get('https://a.example/2')).then(() => assert.deepEqual(sleeps, [5000]));
});
test('keyless: every network connector honours the egress policy and reports 429, 5xx and offline honestly', async () => {
  const INPUT = {
    gleif: { kind: 'lei', query: 'FIXLEI0000000000AB01' }, 'sec-edgar': { kind: 'company', query: 'Fixture Rail' }, nominatim: { kind: 'geocode', query: 'Fixture Cathedral, Fixtureville' },
    'overpass-query': { query: 'amenity=cafe', bbox: '2.29,48.855,2.30,48.862' }, 'nasa-gibs': { query: 'MODIS_Terra_CorrectedReflectance_TrueColor', mode: 'probe', start: '2024-06-15' },
    'earth-search-stac': { bbox: '-1,51,0,52' }, 'gdelt-geo': { kind: 'organisation', query: 'Fixture Org' }, 'common-crawl-index': { domain: 'fixture-site.example' },
    rdns: { value: '8.8.8.8' }, 'cisa-kev': { query: 'CVE-2099-0001' }, nvd: { kind: 'cve', query: 'CVE-2099-0001' },
  };
  for (const id of Object.keys(NETWORK)) {
    const ok = await run(id, INPUT[id]);
    assert.equal(ok.status, 'ok', id + ' ' + ok.message); valid(ok, id);
    assert.equal(ok.declaredNetwork, NETWORK[id]);
    const denied = await run(id, INPUT[id], { egress: async () => ({ allow: false, reason: 'policy' }) });
    assert.equal(denied.status, 'blocked', id); assert.equal(hits(denied), 0, id + ' sent nothing');
    const r429 = await run(id, INPUT[id], { fetch: async () => new Response('slow', { status: 429, headers: { 'retry-after': '9' } }) });
    assert.equal(r429.status, 'rate-limited', id); assert.equal(r429.network, 'rate-limited', id); assert.equal(r429.exitCode, 75);
    const r503 = await run(id, INPUT[id], { fetch: async () => new Response('down', { status: 503 }) });
    assert.equal(r503.status, 'unavailable', id); assert.equal(r503.network, 'unavailable', id); assert.match(r503.message, /not available right now/);
    const off = await run(id, INPUT[id], { fetch: async () => { throw new Error('ENOTFOUND'); } });
    assert.equal(off.status, 'unavailable', id); assert.equal(off.network, 'unavailable', id); assert.equal(off.results.length, 0); assert.match(off.message, /could not reach/);
    const bad = await run(id, INPUT[id], { fetch: async () => new Response('<html>not what we expect</html>') });
    assert.ok(['bad-response', 'bad-input', 'ok'].includes(bad.status), id + ' ' + bad.status); assert.notEqual(bad.status, 'internal', id);
  }
});

// ---------------- gleif ----------------
test('gleif: organisations by name or LEI, sole proprietors withheld, bad input refused with no request', async () => {
  const r = await run('gleif', { kind: 'name', query: 'Fixture Holdings', limit: '5' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'gleif');
  assert.deepEqual(vals(r, 'org'), ['Fixture Holdings Ltd', 'Fixture Holdings (Overseas) SA']);
  const a = r.results[0];
  assert.equal(a.confidence, 'likely'); assert.equal(a.raw.lei, 'FIXLEI0000000000AB01'); assert.equal(a.raw.legalAddress.country, 'GB'); assert.equal(a.source.url, 'https://search.gleif.org/#/record/FIXLEI0000000000AB01');
  assert.equal(a.raw.legalAddress.postalCode, undefined); assert.ok(!text(r).includes('Invented Row'), 'street address lines are not kept');
  assert.equal(r.results[1].raw.registrationStatus, 'LAPSED'); assert.equal(r.results[1].raw.entityStatus, 'INACTIVE');
  assert.ok(!text(r).includes('Sole Trader')); assert.ok(r.notes.some((n) => /1 record\(s\) of sole proprietors were withheld/.test(n)));
  assert.match(r.fetch.log[0], /filter%5Bfulltext%5D=Fixture%20Holdings/); assert.match(r.fetch.log[0], /page%5Bsize%5D=5/);
  const l = await run('gleif', { kind: 'lei', query: ' fixlei0000000000ab01 ' });
  assert.equal(l.results[0].confidence, 'confirmed'); assert.equal(l.fetch.log[0], 'https://api.gleif.org/api/v1/lei-records/FIXLEI0000000000AB01');
  const none = await run('gleif', { kind: 'name', query: 'Nothing Matches Fixture' }); assert.equal(none.status, 'ok'); assert.equal(none.results.length, 0); assert.ok(none.notes.some((n) => /no legal entity matches/.test(n)));
  const unk = await run('gleif', { kind: 'lei', query: 'FIXLEI0000000000ZZ99' }); assert.equal(unk.status, 'ok'); assert.ok(unk.notes.some((n) => /no record for this LEI/.test(n)));
  for (const bad of [{ kind: 'lei', query: 'TOO-SHORT' }, { kind: 'name', query: 'someone@example.com' }, { kind: 'name', query: '+44 7700 900123' }, { kind: 'x', query: 'abc' }]) { const b = await run('gleif', bad); assert.equal(b.status, 'bad-input', JSON.stringify(bad)); assert.equal(hits(b), 0); }
  assert.equal((await run('gleif', { kind: 'name', query: 'Fixture Holdings' }, { fetch: async () => new Response('{"data":"nope"}') })).status, 'bad-response');
});

// ---------------- sec-edgar ----------------
test('sec-edgar: company search, filings list without insider forms, descriptive User-Agent, individual filers withheld', async () => {
  const c = await run('sec-edgar', { kind: 'company', query: 'fixture rail holdings' });
  assert.equal(c.status, 'ok', c.message); valid(c, 'sec-edgar');
  assert.deepEqual(vals(c, 'org'), ['Fixture Rail Holdings Inc.', 'Fixture Rail Holdings Group plc']);
  assert.equal(c.results[0].raw.cik, '0001234567'); assert.equal(c.results[0].raw.ticker, 'FXTR'); assert.equal(c.results[0].confidence, 'likely');
  const t = await run('sec-edgar', { kind: 'company', query: 'fxtr' }); assert.equal(t.results[0].confidence, 'confirmed'); assert.equal(t.results.length, 1);
  assert.deepEqual(vals(await run('sec-edgar', { kind: 'company', query: '7654321' }), 'org'), ['Fixture Air Holdings Corp']);
  const f = await run('sec-edgar', { kind: 'filings', query: '1234567' });
  assert.equal(f.status, 'ok', f.message); valid(f, 'sec-edgar');
  assert.deepEqual(vals(f, 'org'), ['Fixture Rail Holdings Inc.']);
  assert.deepEqual(vals(f, 'document'), ['10-K filed 2026-03-01 by Fixture Rail Holdings Inc.', '8-K filed 2026-02-10 by Fixture Rail Holdings Inc.', '10-Q filed 2025-11-05 by Fixture Rail Holdings Inc.']);
  assert.equal(f.results[1].source.url, 'https://www.sec.gov/Archives/edgar/data/1234567/000123456726000010/fxtr-10k.htm');
  assert.equal(f.results[1].raw.accession, '0001234567-26-000010'); assert.ok(f.notes.some((n) => /2 insider-transaction filing\(s\)/.test(n)));
  assert.ok(!text(f).includes('form4'));
  const w = await run('sec-edgar', { kind: 'filings', query: '1234567', types: '4,4/A' }); assert.deepEqual(w.results.filter((x) => x.entity.type === 'document').map((x) => x.raw.form), ['4', '4/A']);
  const byName = await run('sec-edgar', { kind: 'filings', query: 'FXTR' }); assert.equal(byName.status, 'ok'); assert.equal(byName.requests, 2);
  const many = await run('sec-edgar', { kind: 'filings', query: 'fixture rail' }); assert.equal(many.status, 'bad-input'); assert.match(many.message, /matches several companies/);
  const ind = await run('sec-edgar', { kind: 'filings', query: '999999' }); assert.equal(ind.status, 'ok'); assert.equal(ind.results.length, 0); assert.ok(ind.notes.some((n) => /individual filer/.test(n))); assert.ok(!text(ind).includes('Invented, Person'));
  const nf = await run('sec-edgar', { kind: 'filings', query: '404' }); assert.equal(nf.status, 'ok'); assert.ok(nf.notes.some((n) => /no filer/.test(n)));
  // 403 from the SEC means rate or User-Agent, not a login
  const forbidden = await run('sec-edgar', { kind: 'filings', query: '403' }); assert.equal(forbidden.status, 'unavailable'); assert.match(forbidden.message, /fair-access limit or User-Agent/); assert.ok(!/login/.test(forbidden.message));
  // the descriptive User-Agent travels on every request, and every request stays on the two SEC hosts
  const seen = [];
  const spy = async (u, o) => { seen.push([u, o]); return fixtureResponse(u); };
  function fixtureResponse(u) { const m = makeFetch(fixtures); return m(u); }
  await mods.runModule('sec-edgar', { kind: 'filings', query: 'FXTR' }, { fetch: spy, sleep: noSleep, now: () => NOW });
  assert.equal(seen.length, 2);
  for (const [u, o] of seen) { assert.match(o.headers['user-agent'], /^Mayfair Organization MayfairGhost\/\d\S* \S+@\S+$/); assert.ok(['www.sec.gov', 'data.sec.gov'].includes(new URL(u).hostname)); assert.equal(o.credentials, 'omit'); }
  assert.equal((await run('sec-edgar', { kind: 'company', query: 'a@b.co' })).status, 'bad-input');
});

// ---------------- nominatim ----------------
test('nominatim: the personal-address check is gone', () => {
  assert.equal(L('nominatim').looksLikePersonalAddress, undefined);
  assert.equal(/personal street address|private individual|never returns house numbers/i.test(JSON.stringify(L('nominatim').meta)), false);
});
test('nominatim: geocode returns what OpenStreetMap holds, house numbers, roads and postcodes included', async () => {
  const r = await run('nominatim', { kind: 'geocode', query: 'Fixture Cathedral, Fixtureville', limit: '3' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'nominatim');
  assert.deepEqual(vals(r, 'place'), ['Fixture Cathedral, 1 Cathedral Close, FX1 1AA, Fixtureville, Fixtureland', '12 Cathedral Close, FX1 1AA, Fixtureville, Fixtureland', '14 Cathedral Close, Fixtureville, Fixtureland']);
  assert.equal(r.results[0].raw.lat, 51.5001); assert.equal(r.results[0].raw.osmId, 1001); assert.equal(r.results[0].source.url, 'https://www.openstreetmap.org/way/1001');
  assert.equal(r.results[1].raw.houseNumber, '12'); assert.equal(r.results[1].raw.road, 'Cathedral Close'); assert.equal(r.results[1].raw.postcode, 'FX1 1AA');
  assert.match(r.results[0].raw.attribution, /OpenStreetMap contributors/);
  assert.ok(!r.notes.some((n) => /withheld|address-level/.test(n)));
  const u = new URL(r.fetch.log[0]); assert.equal(u.searchParams.get('limit'), '3'); assert.equal(u.searchParams.get('format'), 'jsonv2'); assert.equal(r.requests, 1);
  assert.equal((await run('nominatim', { kind: 'geocode', query: 'Nowhere Fixture Landmark' })).results.length, 0);
});
test('nominatim: queries that look like a street address with a name are searched, not refused; bulk and bad input still are', async () => {
  const one = { match: { host: 'nominatim.openstreetmap.org', path: '/search' }, json: [{ osm_type: 'way', osm_id: 5, lat: '51.5', lon: '-0.1', category: 'building', type: 'house', addresstype: 'building', name: '', display_name: '12, High Street, Leeds', address: { house_number: '12', road: 'High Street', city: 'Leeds', country: 'United Kingdom' } }] };
  for (const q of ['John Smith, 12 High Street, Leeds', 'Mr Smith 12 Acacia Avenue', 'Jane Doe 221B Baker Street', 'where does Jane Doe live', 'home address of Ann Lee, 4 Rose Lane']) {
    const b = await run('nominatim', { kind: 'geocode', query: q }, { overrides: [one] });
    assert.equal(b.status, 'ok', q); assert.equal(hits(b), 1, q); assert.deepEqual(vals(b, 'place'), ['12 High Street, Leeds, United Kingdom'], q);
  }
  for (const q of ['Fixture Cathedral; Fixture Bridge; Fixture Hall', 'a\nb']) { const b = await run('nominatim', { kind: 'geocode', query: q }); assert.equal(b.status, 'bad-input', q); assert.equal(hits(b), 0); }
});
test('nominatim: reverse asks for the building and returns house number, road and postcode when they are there', async () => {
  const r = await run('nominatim', { kind: 'reverse', query: '51.5, -0.12' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'nominatim');
  assert.deepEqual(vals(r, 'place'), ['Fixture Quarter, 5 Some Road, FX1 2BB, Fixtureville, Fixtureland']);
  const u = new URL(r.fetch.log[0]); assert.equal(u.searchParams.get('zoom'), '18'); assert.equal(u.searchParams.get('lat'), '51.5');
  assert.equal(r.results[0].raw.houseNumber, '5'); assert.equal(r.results[0].raw.road, 'Some Road'); assert.equal(r.results[0].raw.postcode, 'FX1 2BB'); assert.equal(r.results[0].raw.level, 'suburb');
  const house = await run('nominatim', { kind: 'reverse', query: '51.6,-0.2' });
  assert.deepEqual(vals(house, 'place'), ['7 Quiet Road, FX1 3CC, Fixtureville, Fixtureland']); assert.equal(house.results[0].raw.houseNumber, '7');
  assert.ok(!r.notes.concat(house.notes).some((n) => /never returned|neighbourhood level/.test(n)));
  const sea = await run('nominatim', { kind: 'reverse', query: '0,0' }); assert.equal(sea.status, 'ok'); assert.equal(sea.results.length, 0);
  for (const q of ['not coordinates', '95,0', '10,200', '10']) { const b = await run('nominatim', { kind: 'reverse', query: q }); assert.equal(b.status, 'bad-input', q); assert.equal(hits(b), 0); }
});

// ---------------- overpass-query ----------------
test('overpass-query: named features only, tags trimmed, caps on area, radius and filters', async () => {
  const r = await run('overpass-query', { query: 'amenity=cafe', bbox: '2.29,48.855,2.30,48.862', limit: '10' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'overpass-query');
  assert.deepEqual(vals(r, 'place'), ['Fixture Cafe', 'Fixture Bistro']);
  assert.deepEqual(r.results[0].raw.tags, { amenity: 'cafe' }); assert.equal(r.results[1].raw.lat, 48.859); assert.equal(r.results[1].raw.tags.building, 'commercial');
  for (const bad of ['Invented Street', '+00 000', 'opening_hours', 'housenumber']) assert.ok(!text(r).includes(bad), 'no ' + bad);
  assert.ok(r.notes.some((n) => /1 unnamed feature/.test(n)));
  const ql = decodeURIComponent(new URL(r.fetch.log[0]).searchParams.get('data'));
  assert.match(ql, /^\[out:json\]\[timeout:20\]\[maxsize:5000000\];/); assert.match(ql, /node\["amenity"="cafe"\]\(48\.855,2\.29,48\.862,2\.3\)/); assert.match(ql, /out tags center 20;$/);
  const circle = await run('overpass-query', { query: 'amenity=cafe', value: '48.858,2.294,500' });
  assert.match(decodeURIComponent(new URL(circle.fetch.log[0]).searchParams.get('data')), /\(around:500,48\.858,2\.294\)/);
  const refuse = [
    { query: 'amenity=cafe' }, { query: 'amenity=cafe', bbox: '2.29,48.855,2.30,48.862', value: '48.858,2.294,500' },
    { query: 'amenity=cafe', bbox: '2,48,3,49' }, { query: 'amenity=cafe', bbox: '2.29,48.855,2.50,48.862' }, { query: 'amenity=cafe', value: '48.858,2.294,5000' }, { query: 'amenity=cafe', value: '48.858,2.294,5' },
    { query: 'building=house', bbox: '2.29,48.855,2.30,48.862' }, { query: 'building=yes', bbox: '2.29,48.855,2.30,48.862' }, { query: 'building=residential', value: '48.858,2.294,500' },
    { query: 'name=smith', bbox: '2.29,48.855,2.30,48.862' }, { query: 'addr:housenumber=1', bbox: '2.29,48.855,2.30,48.862' }, { query: 'phone=1234', bbox: '2.29,48.855,2.30,48.862' },
    { query: 'amenity=cafe"];out;', bbox: '2.29,48.855,2.30,48.862' }, { query: 'amenity', bbox: '2.29,48.855,2.30,48.862' }, { query: 'amenity=cafe', bbox: '5,5,1,1' },
  ];
  for (const bad of refuse) { const b = await run('overpass-query', bad); assert.equal(b.status, 'bad-input', JSON.stringify(bad)); assert.equal(hits(b), 0); }
  const over = await run('overpass-query', { query: 'amenity=cafe', bbox: '2.29,48.855,2.30,48.862' }, { overrides: [{ match: { host: 'overpass-api.de', path: '/api/interpreter' }, json: { elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 21 seconds.' } }] });
  assert.equal(over.status, 'unavailable'); assert.match(over.message, /smaller area/);
  const empty = await run('overpass-query', { query: 'amenity=cafe', bbox: '2.29,48.855,2.30,48.862' }, { overrides: [{ match: { host: 'overpass-api.de', path: '/api/interpreter' }, json: { elements: [] } }] });
  assert.equal(empty.status, 'ok'); assert.ok(empty.notes.some((n) => /no features of this kind/.test(n)));
});

// ---------------- nasa-gibs ----------------
test('nasa-gibs: tile builder with a tile cap, dates from the schedule, probe fetches at most two small tiles', async () => {
  const G = L('nasa-gibs');
  assert.equal(G.tileUrl('MODIS_Terra_CorrectedReflectance_TrueColor', '2024-06-15', 3, 4, 2), 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2024-06-15/GoogleMapsCompatible_Level9/3/2/4.jpg');
  assert.equal(G.tileUrl('VIIRS_SNPP_DayNightBand_ENCC', '2024-06-15', 2, 1, 1), 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_DayNightBand_ENCC/default/2024-06-15/GoogleMapsCompatible_Level8/2/1/1.png');
  // London (0.1W, 51.5N) at zoom 5 is tile x=15,y=10 (standard slippy-map arithmetic)
  const t = await run('nasa-gibs', { query: 'MODIS_Terra_CorrectedReflectance_TrueColor', mode: 'tiles', start: '2024-06-15', bbox: '-0.2,51.4,-0.05,51.6', max: '5' });
  assert.equal(t.status, 'ok', t.message); valid(t, 'nasa-gibs'); assert.equal(t.requests, 0, 'tile addresses are built, not fetched');
  assert.deepEqual(vals(t, 'url'), ['https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/2024-06-15/GoogleMapsCompatible_Level9/5/10/15.jpg']);
  assert.equal(t.results[0].confidence, 'likely'); assert.match(t.results[0].raw.attribution, /NASA/);
  const world = await run('nasa-gibs', { query: 'MODIS_Terra_CorrectedReflectance_TrueColor', mode: 'tiles', start: '2024-06-15', max: '1' }); assert.equal(world.results.length, 4);
  const big = await run('nasa-gibs', { query: 'MODIS_Terra_CorrectedReflectance_TrueColor', mode: 'tiles', start: '2024-06-15', bbox: '-10,40,10,60', max: '8' }); assert.equal(big.status, 'bad-input'); assert.match(big.message, /at most 16/);
  const d = await run('nasa-gibs', { query: 'MODIS_Terra_CorrectedReflectance_TrueColor', mode: 'dates', start: '2024-06-14', end: '2024-06-17' });
  assert.deepEqual(d.results.map((x) => x.raw.date), ['2024-06-14', '2024-06-15', '2024-06-16', '2024-06-17']); assert.equal(d.requests, 0); assert.ok(d.notes.some((n) => /probe mode/.test(n)));
  const p = await run('nasa-gibs', { query: 'MODIS_Terra_CorrectedReflectance_TrueColor', mode: 'probe', start: '2024-06-15', end: '2024-06-16' });
  assert.equal(p.status, 'ok', p.message); valid(p, 'nasa-gibs'); assert.equal(p.requests, 2); assert.equal(p.results.length, 1); assert.equal(p.results[0].confidence, 'confirmed'); assert.equal(p.results[0].raw.date, '2024-06-15');
  assert.ok(p.notes.some((n) => /no imagery tile found for 2024-06-16/.test(n)));
  assert.ok(p.fetch.log.every((u) => /\/0\/0\/0\.jpg$/.test(u)), 'only the 256 pixel world overview tile');
  for (const bad of [{ start: '1999-01-01' }, { start: '2099-01-01' }, { start: '2024-02-30' }, { start: '2024-06-15', end: '2024-06-01' }, { start: '2022-01-01', end: '2024-06-01' }, { query: 'NOT_A_LAYER', start: '2024-06-15' }]) {
    const b = await run('nasa-gibs', { query: 'MODIS_Terra_CorrectedReflectance_TrueColor', mode: 'dates', ...bad }); assert.equal(b.status, 'bad-input', JSON.stringify(bad)); assert.equal(hits(b), 0);
  }
});

// ---------------- earth-search-stac ----------------
test('earth-search-stac: scenes by area and period, cloud filter, https thumbnails only, area cap', async () => {
  const r = await run('earth-search-stac', { bbox: '-0.5,51.3,0.3,51.7', start: '2024-06-01', end: '2024-06-30', maxCloud: '50', limit: '5' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'earth-search-stac');
  assert.deepEqual(vals(r, 'image'), ['S2A_30UXC_20240615_0_L2A']);
  assert.equal(r.results[0].raw.thumbnail, 'https://thumbs.example.org/S2A_30UXC_20240615.jpg'); assert.equal(r.results[0].raw.cloudCoverPercent, 8.2); assert.equal(r.results[0].raw.acquired, '2024-06-15T11:05:00.000Z');
  assert.equal(r.results[0].source.url, 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_30UXC_20240615_0_L2A');
  assert.ok(r.notes.some((n) => /1 scene\(s\) above 50% cloud cover were left out/.test(n)));
  const u = new URL(r.fetch.log[0]); assert.equal(u.searchParams.get('datetime'), '2024-06-01T00:00:00Z/2024-06-30T23:59:59Z'); assert.equal(u.searchParams.get('bbox'), '-0.5,51.3,0.3,51.7'); assert.equal(u.searchParams.get('collections'), 'sentinel-2-l2a'); assert.equal(u.searchParams.get('limit'), '5');
  const all = await run('earth-search-stac', { bbox: '-1,51,0,52' }); assert.equal(all.results[1].raw.thumbnail, undefined, 'an http thumbnail is dropped');
  for (const bad of [{ bbox: '1,1,0,0' }, { bbox: '-20,40,20,60' }, { bbox: '-1,51,0,52', start: '2024-13-01' }, { bbox: '-1,51,0,52', query: 'bad collection!' }, { bbox: '-1,51,0,52', start: '2024-06-10', end: '2024-06-01' }]) { const b = await run('earth-search-stac', bad); assert.equal(b.status, 'bad-input', JSON.stringify(bad)); assert.equal(hits(b), 0); }
  assert.equal((await run('earth-search-stac', { bbox: '-1,51,0,52' }, { fetch: async () => new Response('{"type":"x"}') })).status, 'bad-response');
});

// ---------------- gdelt-geo ----------------
test('gdelt-geo: places ranked by article count, honest about throttling, contact-shaped queries are sent as typed', async () => {
  const r = await run('gdelt-geo', { kind: 'organisation', query: 'Fixture Org', timespan: '7d', limit: '2' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'gdelt-geo');
  assert.deepEqual(vals(r, 'place'), ['Testburg, Exampleland', 'Fixtureville, Fixtureland']);
  assert.equal(r.results[0].raw.lat, 52.5); assert.equal(r.results[0].raw.lon, 13.4); assert.equal(r.results[0].raw.articleCount, 40); assert.ok(!text(r).includes('news.example.org'), 'article html is not kept');
  const u = new URL(r.fetch.log[0]); assert.equal(u.searchParams.get('format'), 'geojson'); assert.equal(u.searchParams.get('maxpoints'), '2'); assert.equal(u.searchParams.get('timespan'), '7d');
  const th = await run('gdelt-geo', { kind: 'organisation', query: 'Throttle Fixture' }); assert.equal(th.status, 'rate-limited'); assert.equal(th.network, 'rate-limited');
  const none = await run('gdelt-geo', { kind: 'topic', query: 'Silence Fixture' }); assert.equal(none.status, 'ok'); assert.equal(none.results.length, 0);
  const geo = { match: { host: 'api.gdeltproject.org', path: '/api/v2/geo/geo' }, json: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'Fixtureville, Fixtureland', count: 2 }, geometry: { type: 'Point', coordinates: [-0.12, 51.5] } }] } };
  for (const q of ['someone@example.com', '+44 7700 900123', '@handle', '#tag', 'a/b']) { const b = await run('gdelt-geo', { kind: 'topic', query: q }, { overrides: [geo] }); assert.equal(b.status, 'ok', q); assert.equal(hits(b), 1, q); assert.deepEqual(vals(b, 'place'), ['Fixtureville, Fixtureland'], q); }
  assert.equal(/contact details|refused/i.test(JSON.stringify(L('gdelt-geo').meta)), false);
  for (const bad of [{ kind: 'domain', query: 'not a domain' }, { kind: 'person', query: 'abc' }]) { const b = await run('gdelt-geo', bad); assert.equal(b.status, 'bad-input', JSON.stringify(bad)); assert.equal(hits(b), 0); }
});

// ---------------- common-crawl-index ----------------
test('common-crawl-index: picks the latest crawl, lists captures, skips junk lines, says when there are none', async () => {
  const r = await run('common-crawl-index', { domain: 'Fixture-Site.example', limit: '10' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'common-crawl-index');
  assert.deepEqual(vals(r, 'url'), ['https://fixture-site.example/', 'https://www.fixture-site.example/about']);
  assert.equal(r.results[0].raw.crawl, 'CC-MAIN-2024-33'); assert.equal(r.results[0].raw.captured, '2024-08-10T10:10:10.000Z'); assert.equal(r.results[1].raw.status, '301'); assert.equal(r.results[0].confidence, 'confirmed');
  assert.equal(r.requests, 2); assert.equal(r.fetch.log[0], 'https://index.commoncrawl.org/collinfo.json');
  const u = new URL(r.fetch.log[1]); assert.equal(u.pathname, '/CC-MAIN-2024-33-index'); assert.equal(u.searchParams.get('matchType'), 'domain'); assert.equal(u.searchParams.get('limit'), '10'); assert.equal(u.searchParams.get('url'), 'fixture-site.example');
  assert.ok(r.notes.some((n) => /2 unreadable line\(s\) skipped/.test(n)));
  const none = await run('common-crawl-index', { domain: 'nothing-here.example' }); assert.equal(none.status, 'ok'); assert.equal(none.results.length, 0); assert.ok(none.notes.some((n) => /holds no capture/.test(n)));
  for (const bad of ['192.0.2.1', 'bad domain', 'localhost', '']) { const b = await run('common-crawl-index', { domain: bad }); assert.equal(b.status, 'bad-input', bad); assert.equal(hits(b), 0); }
  assert.equal((await run('common-crawl-index', { domain: 'fixture-site.example' }, { overrides: [{ match: { host: 'index.commoncrawl.org', path: '/collinfo.json' }, json: { not: 'a list' } }] })).status, 'bad-response');
});

// ---------------- rdns ----------------
test('rdns: PTR names are confirmed only by a forward lookup, reserved addresses refused, IPv6 name built from nibbles', async () => {
  const r = await run('rdns', { value: '8.8.8.8' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'rdns');
  assert.deepEqual(vals(r, 'domain'), ['resolver-fixture.example.net', 'spoof.example.org']);
  assert.equal(r.results[0].confidence, 'confirmed'); assert.equal(r.results[0].raw.forwardConfirmed, true);
  assert.equal(r.results[1].confidence, 'uncertain'); assert.match(r.results[1].uncertaintyNote, /does not point back/); assert.equal(r.results[1].raw.forwardConfirmed, false);
  assert.equal(r.requests, 3); assert.ok(r.fetch.log.every((u) => new URL(u).hostname === 'cloudflare-dns.com'));
  const nx = await run('rdns', { value: '1.1.1.1' }); assert.equal(nx.status, 'ok'); assert.equal(nx.results.length, 0); assert.ok(nx.notes.some((n) => /NXDOMAIN/.test(n)));
  const R = L('rdns');
  assert.equal(R.arpaName('8.8.4.4'), '4.4.8.8.in-addr.arpa');
  assert.equal(R.arpaName('2a00:1450:4001::1'), '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1.0.0.4.0.5.4.1.0.0.a.2.ip6.arpa');
  const v6 = await run('rdns', { value: '2a00:1450:4001::1', provider: 'google' }, { overrides: [{ match: { host: 'dns.google', path: '/resolve', query: { name: R.arpaName('2a00:1450:4001::1'), type: 'PTR' } }, json: { Status: 0, Answer: [{ name: 'x', type: 12, TTL: 5, data: 'v6-fixture.example.net.' }] } }, { match: { host: 'dns.google', path: '/resolve', query: { name: 'v6-fixture.example.net', type: 'AAAA' } }, json: { Status: 0, Answer: [{ name: 'v6-fixture.example.net', type: 28, TTL: 5, data: '2a00:1450:4001:0:0:0:0:1' }] } }] });
  assert.equal(v6.status, 'ok', v6.message); assert.equal(v6.results[0].confidence, 'confirmed', 'IPv6 forward match ignores notation');
  for (const bad of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '169.254.1.1', '::1', 'fe80::1', 'example.com', '999.1.1.1', '']) { const b = await run('rdns', { value: bad }); assert.equal(b.status, 'bad-input', bad); assert.equal(hits(b), 0); }
});

// ---------------- cisa-kev ----------------
test('cisa-kev: lookups by CVE, keyword and date; cached for 12 hours; stale copy used and labelled when CISA is down', async () => {
  const dir = isolate();
  const f = makeFetch(fixtures);
  const go = (input, fetch = f, nowMs = NOW.getTime()) => { L('cisa-kev').cache.now = () => nowMs; return mods.runModule('cisa-kev', input, { fetch, sleep: noSleep, now: () => NOW }); };
  const a = await go({ query: 'CVE-2099-0001' });
  assert.equal(a.status, 'ok', a.message); assert.equal(a.requests, 1);
  assert.deepEqual(vals(a, 'document'), ['CVE-2099-0001']); a.fetch = f; valid(a, 'cisa-kev');
  assert.equal(a.results[0].confidence, 'confirmed'); assert.equal(a.results[0].raw.dueDate, '2026-11-09'); assert.equal(a.results[0].raw.knownRansomwareCampaignUse, 'Known'); assert.equal(a.results[0].raw.source, 'network'); assert.deepEqual(a.results[0].raw.cwes, ['CWE-78']);
  assert.ok(a.notes.some((n) => /catalogue version 2026\.10\.20, 3 entries/.test(n)));
  assert.ok(fs.existsSync(path.join(dir, 'mayfair-ghost-cisa-kev.json')));
  const b = await go({ query: 'fixture vendor' });                          // from the cache: no request
  assert.equal(b.requests, 0); assert.deepEqual(vals(b, 'document'), ['CVE-2099-0001', 'CVE-2099-0002']); assert.equal(b.results[0].raw.source, 'cache'); assert.ok(b.notes.some((n) => /no request was sent/.test(n))); assert.equal(f.log.length, 1);
  assert.deepEqual(vals(await go({ start: '2026-09-15' }), 'document'), ['CVE-2099-0001']);
  assert.deepEqual(vals(await go({ query: 'other suite' }), 'document'), ['CVE-2098-1234']);
  assert.deepEqual(vals(await go({ limit: '2' }), 'document'), ['CVE-2099-0001', 'CVE-2099-0002']);
  const none = await go({ query: 'CVE-2000-0001' }); assert.equal(none.results.length, 0); assert.ok(none.notes.some((n) => /no entry/.test(n)));
  // after 12 hours it asks again; CISA down: the older copy is used, marked likely, and says so
  const later = NOW.getTime() + 13 * 3600 * 1000;
  const down = await go({ query: 'CVE-2099-0001' }, async () => new Response('down', { status: 503 }), later);
  assert.equal(down.status, 'ok'); assert.equal(down.results[0].confidence, 'likely'); assert.equal(down.results[0].raw.source, 'stale-cache'); assert.ok(down.notes.some((n) => /could not be reached.*may be out of date/.test(n)));
  const fresh = await go({ query: 'CVE-2099-0001' }, f, later); assert.equal(fresh.requests, 1); assert.equal(fresh.results[0].raw.source, 'network');
  // no cache and no CISA: honest failure
  isolate();
  const off = await go({ query: 'CVE-2099-0001' }, async () => { throw new Error('ENOTFOUND'); }); assert.equal(off.status, 'unavailable');
  // a damaged cache is ignored, not trusted
  const dir2 = isolate(); fs.writeFileSync(path.join(dir2, 'mayfair-ghost-cisa-kev.json'), '{"savedAt":1,"doc":"x"');
  const dmg = await go({ query: 'CVE-2099-0001' }); assert.equal(dmg.requests, 1); assert.equal(dmg.status, 'ok');
  for (const bad of [{ start: '2026-13-40' }]) { const x = await go(bad); assert.equal(x.status, 'bad-input'); }
});

// ---------------- nvd ----------------
test('nvd: CVE and keyword lookups, five-requests-in-30-seconds window kept between runs, 403 reported as the rate limit', async () => {
  const r = await run('nvd', { kind: 'cve', query: 'cve-2099-0001' });
  assert.equal(r.status, 'ok', r.message); valid(r, 'nvd');
  const c = r.results[0];
  assert.equal(c.entity.value, 'CVE-2099-0001'); assert.equal(c.raw.cvss.score, 9.8); assert.equal(c.raw.cvss.severity, 'CRITICAL'); assert.equal(c.raw.cvss.version, '3.1'); assert.deepEqual(c.raw.cwes, ['CWE-78']);
  assert.match(c.raw.description, /^An invented flaw/); assert.deepEqual(c.raw.references, ['https://vendor.example.org/advisory/1']); assert.deepEqual(c.raw.exploitedInTheWild, { added: '2026-10-19', due: '2026-11-09' });
  assert.equal(c.source.url, 'https://nvd.nist.gov/vuln/detail/CVE-2099-0001'); assert.match(c.raw.attribution, /not endorsed or certified by the NVD/);
  const k = await run('nvd', { kind: 'keyword', query: 'fixture gateway', limit: '2' });
  assert.deepEqual(vals(k, 'document'), ['CVE-2099-0001', 'CVE-2099-0002']); assert.equal(k.results[1].raw.cvss, undefined); assert.ok(k.notes.some((n) => /7 CVEs match; the first 2 are shown/.test(n)));
  assert.equal(new URL(k.fetch.log[0]).searchParams.get('resultsPerPage'), '2');
  const none = await run('nvd', { kind: 'cve', query: 'CVE-2099-9999' }); assert.equal(none.status, 'ok'); assert.equal(none.results.length, 0);
  const lim = await run('nvd', { kind: 'cve', query: 'CVE-2099-0403' });
  assert.equal(lim.status, 'rate-limited'); assert.equal(lim.network, 'rate-limited'); assert.match(lim.message, /403.*5 requests in 30 seconds/); assert.ok(!/login/.test(lim.message));
  for (const bad of [{ kind: 'cve', query: 'CVE-99-1' }, { kind: 'keyword', query: 'someone@example.com' }, { kind: 'x', query: 'abcd' }]) { const b = await run('nvd', bad); assert.equal(b.status, 'bad-input', JSON.stringify(bad)); assert.equal(hits(b), 0); }
  // the window: five requests go, the sixth is refused with a wait time and sends nothing; after 30 s it goes again
  isolate();
  const f = makeFetch(fixtures); const B = L('nvd').budget;
  const go = (t) => { B.now = () => NOW.getTime() + t; return mods.runModule('nvd', { kind: 'cve', query: 'CVE-2099-0001' }, { fetch: f, sleep: noSleep, now: () => NOW }); };
  for (let i = 0; i < 5; i++) assert.equal((await go(i * 1000)).status, 'ok', 'request ' + (i + 1));
  const sixth = await go(6000); assert.equal(sixth.status, 'rate-limited'); assert.equal(sixth.requests, 0); assert.match(sixth.message, /try again in 24 s/); assert.equal(f.log.length, 5); assert.equal(sixth.network, 'rate-limited');
  assert.equal((await go(30500)).status, 'ok'); assert.equal(f.log.length, 6);
});

// ---------------- local connectors ----------------
const sha = (algo, buf) => crypto.createHash(algo).update(buf).digest('hex');
function tmpFile(name, content) { const d = tmp('mfd-kl-f-'); const p = path.join(d, name); fs.writeFileSync(p, content); return p; }
test('hash-file: SHA-256, SHA-1 and MD5 of a picked file, no network, directories and missing files refused', async () => {
  const p = tmpFile('evidence.bin', 'abc');
  const r = await mods.runModule('hash-file', { file: p }, { fetch: async () => { throw new Error('network used'); }, now: () => NOW });
  assert.equal(r.status, 'ok', r.message); assert.equal(r.requests, 0); assert.equal(r.network, 'local'); valid({ ...r, fetch: null }, 'hash-file');
  assert.equal(r.results[0].entity.value, 'evidence.bin'); assert.equal(r.results[0].raw.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); assert.equal(r.results[0].raw.sha1, 'a9993e364706816aba3e25717850c26c9cd0d89d'); assert.equal(r.results[0].raw.md5, '900150983cd24fb0d6963f7d28e17f72'); assert.equal(r.results[0].raw.size, 3);
  assert.ok(r.notes.some((n) => /MD5 and SHA-1 can be forged/.test(n)));
  const one = await mods.runModule('hash-file', { file: p, types: 'sha256' }, { now: () => NOW }); assert.deepEqual(Object.keys(one.results[0].raw).sort(), ['kind', 'sha256', 'size']); assert.equal(one.notes.length, 0);
  const big = crypto.randomBytes(3 * 1048576 + 17); const bp = tmpFile('big.bin', big);
  assert.equal((await mods.runModule('hash-file', { file: bp }, { now: () => NOW })).results[0].raw.sha256, sha('sha256', big));
  const empty = await mods.runModule('hash-file', { file: tmpFile('empty', '') }, { now: () => NOW }); assert.equal(empty.results[0].raw.sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal((await mods.runModule('hash-file', { file: path.dirname(p) }, { now: () => NOW })).status, 'bad-input');
  assert.equal((await mods.runModule('hash-file', { file: path.join(path.dirname(p), 'missing') }, { now: () => NOW })).status, 'bad-input');
  assert.equal((await mods.runModule('hash-file', {}, { now: () => NOW })).status, 'bad-input');
  const st = await mods.runModule('hash-file', { check: 'selftest' }, { now: () => NOW }); assert.equal(st.status, 'ok'); assert.equal(st.results[0].entity.value, 'self-check-sample');
});

const BUNDLE = { type: 'bundle', id: 'bundle--aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', objects: [
  { type: 'indicator', spec_version: '2.1', id: 'indicator--00000000-0000-4000-8000-000000000001', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z', name: 'Fixture C2 domain', pattern: "[domain-name:value = 'c2.fixture.example'] OR [ipv4-addr:value = '203.0.113.7'] OR [url:value = 'https://c2.fixture.example/gate.php']", pattern_type: 'stix', valid_from: '2026-01-01T00:00:00Z', confidence: 90, labels: ['malicious-activity'] },
  { type: 'indicator', spec_version: '2.1', id: 'indicator--00000000-0000-4000-8000-000000000002', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', name: 'Fixture hash', pattern: "[file:hashes.'SHA-256' = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']", pattern_type: 'stix', valid_from: '2026-01-01T00:00:00Z' },
  { type: 'indicator', spec_version: '2.1', id: 'indicator--00000000-0000-4000-8000-000000000003', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', name: 'Complex rule', pattern: "[process:name = 'x' AND process:pid > 4]", pattern_type: 'stix', valid_from: '2026-01-01T00:00:00Z' },
  { type: 'domain-name', spec_version: '2.1', id: 'domain-name--00000000-0000-4000-8000-000000000004', value: 'bad domain!' },
  { type: 'ipv6-addr', spec_version: '2.1', id: 'ipv6-addr--00000000-0000-4000-8000-000000000005', value: '2001:db8::7' },
  { type: 'autonomous-system', spec_version: '2.1', id: 'autonomous-system--00000000-0000-4000-8000-000000000006', number: 64496, name: 'FIXTURE-AS' },
  { type: 'identity', spec_version: '2.1', id: 'identity--00000000-0000-4000-8000-000000000007', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', name: 'Fixture Security Ltd', identity_class: 'organization' },
  { type: 'identity', spec_version: '2.1', id: 'identity--00000000-0000-4000-8000-000000000008', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', name: 'Invented Person Name', identity_class: 'individual' },
  { type: 'email-addr', spec_version: '2.1', id: 'email-addr--00000000-0000-4000-8000-000000000009', value: 'someone@fixture.example' },
  { type: 'user-account', spec_version: '2.1', id: 'user-account--00000000-0000-4000-8000-00000000000a', user_id: 'invented-account' },
  { type: 'threat-actor', spec_version: '2.1', id: 'threat-actor--00000000-0000-4000-8000-00000000000b', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', name: 'FIXTURE-GROUP', aliases: ['Fixture Bear'], threat_actor_types: ['crime-syndicate'] },
  { type: 'malware', spec_version: '2.1', id: 'malware--00000000-0000-4000-8000-00000000000c', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', name: 'FixtureLoader', is_family: true },
  { type: 'vulnerability', spec_version: '2.1', id: 'vulnerability--00000000-0000-4000-8000-00000000000d', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', name: 'CVE-2099-0001' },
  { type: 'location', spec_version: '2.1', id: 'location--00000000-0000-4000-8000-00000000000e', created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z', country: 'GB', city: 'Fixtureville', latitude: 51.5, longitude: -0.12 },
  { type: 'file', spec_version: '2.1', id: 'file--00000000-0000-4000-8000-00000000000f', name: 'dropper.exe', hashes: { 'SHA-256': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }, size: 1234 },
  { type: 'relationship', spec_version: '2.1', id: 'relationship--00000000-0000-4000-8000-000000000010', relationship_type: 'uses', source_ref: 'a--b', target_ref: 'c--d' },
  { type: 'marking-definition', spec_version: '2.1', id: 'marking-definition--00000000-0000-4000-8000-000000000011' },
] };
test('stix-import: entities from a bundle, third-party claims never confirmed, individuals withheld, caps enforced', async () => {
  const p = tmpFile('bundle.json', JSON.stringify(BUNDLE));
  const r = await mods.runModule('stix-import', { file: p }, { fetch: async () => { throw new Error('network used'); }, now: () => NOW });
  assert.equal(r.status, 'ok', r.message); assert.equal(r.requests, 0); assert.equal(r.network, 'local'); valid({ ...r, fetch: null }, 'stix-import');
  assert.deepEqual(vals(r, 'domain'), ['c2.fixture.example']);
  assert.deepEqual(vals(r, 'ip'), ['203.0.113.7', '2001:db8::7']); assert.deepEqual(vals(r, 'url'), ['https://c2.fixture.example/gate.php']); assert.deepEqual(vals(r, 'asn'), ['AS64496']);
  assert.deepEqual(vals(r, 'org'), ['Fixture Security Ltd']); assert.deepEqual(vals(r, 'place'), ['Fixtureville, GB']);
  const docs = vals(r, 'document');
  for (const d of ['sha256:' + 'a'.repeat(64), 'sha256:' + 'b'.repeat(64), 'threat-actor: FIXTURE-GROUP', 'malware: FixtureLoader', 'vulnerability: CVE-2099-0001', 'indicator: Fixture C2 domain', 'indicator: Complex rule']) assert.ok(docs.includes(d), d);
  assert.ok(r.results.every((x) => x.confidence !== 'confirmed'), 'a bundle is the publisher\'s claim');
  assert.equal(r.results.find((x) => x.entity.value === 'c2.fixture.example').confidence, 'likely'); assert.equal(r.results.find((x) => x.entity.value === 'AS64496').confidence, 'uncertain');
  assert.match(r.results.find((x) => x.entity.value === 'AS64496').uncertaintyNote, /no confidence score/);
  assert.ok(!text(r).includes('Invented Person Name') && !text(r).includes('someone@fixture.example') && !text(r).includes('invented-account'));
  assert.ok(r.notes.some((n) => /3 object\(s\) about individuals, email addresses or accounts were withheld/.test(n)));
  assert.ok(r.notes.some((n) => /1 indicator\(s\) use a pattern too complex/.test(n))); assert.ok(r.notes.some((n) => /relationship x1/.test(n)));
  const lim = await mods.runModule('stix-import', { file: p, limit: '3' }, { now: () => NOW }); assert.equal(lim.results.length, 3); assert.ok(lim.notes.some((n) => /stopped at 3 entries/.test(n)));
  const st = await mods.runModule('stix-import', { check: 'selftest' }, { now: () => NOW }); assert.equal(st.status, 'ok'); assert.ok(st.results.length >= 4); assert.deepEqual(vals(st, 'domain'), ['selftest.example']);
  // caps and refusals
  const refuse = async (content, why) => { const b = await mods.runModule('stix-import', { file: tmpFile('x.json', content) }, { now: () => NOW }); assert.equal(b.status, 'bad-input', why); assert.equal(b.results.length, 0); return b; };
  assert.match((await refuse('['.repeat(40) + ']'.repeat(40), 'depth')).message, /nested more than 32 levels/);
  assert.match((await refuse('{"type":"bundle","objects":' + '['.repeat(50) + ']'.repeat(50) + '}', 'depth in objects')).message, /nested/);
  assert.equal(L('keyless-common').textDepth('{"a":"' + '[[['.repeat(40) + '\\"[[["}', 99), 1, 'brackets inside a string (and escaped quotes) are not nesting');
  assert.match((await refuse('not json', 'json')).message, /not valid JSON/);
  assert.match((await refuse('{"type":"indicator"}', 'not a bundle')).message, /not a STIX bundle/);
  assert.match((await refuse(JSON.stringify({ type: 'bundle', spec_version: '2.0', objects: [] }), '2.0')).message, /STIX 2\.0/);
  assert.match((await refuse(JSON.stringify({ type: 'bundle', id: 'bundle--x', objects: [{ type: 'ipv4-addr', spec_version: '2.0', id: 'ipv4-addr--x', value: '1.2.3.4' }] }), '2.0 objects')).message, /STIX 2\.0/);
  assert.match((await refuse(JSON.stringify({ type: 'bundle', objects: Array.from({ length: 20001 }, (_, i) => ({ type: 'relationship', id: 'r--' + i })) }), 'too many objects')).message, /20001 objects/);
  const huge = tmpFile('huge.json', Buffer.alloc(10 * 1048576 + 1, 32)); const h = await mods.runModule('stix-import', { file: huge }, { now: () => NOW }); assert.equal(h.status, 'bad-input'); assert.match(h.message, /the limit is 10 MB/);
  assert.equal((await mods.runModule('stix-import', { file: path.dirname(p) }, { now: () => NOW })).status, 'bad-input');
  assert.equal((await mods.runModule('stix-import', {}, { now: () => NOW })).status, 'bad-input');
  const ok = await mods.runModule('stix-import', { file: tmpFile('quote.json', JSON.stringify({ type: 'bundle', id: 'bundle--q', objects: [{ type: 'identity', spec_version: '2.1', id: 'identity--q', name: 'Brackets [[[[ Ltd', identity_class: 'organization' }] })) }, { now: () => NOW });
  assert.equal(ok.status, 'ok'); assert.deepEqual(vals(ok, 'org'), ['Brackets [[[[ Ltd']);
});

test('local-snapshot: records URL, time and SHA-256 of a saved page, no network, credentials and odd schemes refused', async () => {
  const content = '<html><body>saved page</body></html>';
  const p = tmpFile('page.html', content);
  const mtime = new Date('2026-10-26T12:34:56.000Z'); fs.utimesSync(p, mtime, mtime);
  const r = await mods.runModule('local-snapshot', { url: 'https://fixture-site.example/news?id=7#section', file: p }, { fetch: async () => { throw new Error('network used'); }, now: () => NOW });
  assert.equal(r.status, 'ok', r.message); assert.equal(r.requests, 0); assert.equal(r.network, 'local'); valid({ ...r, fetch: null }, 'local-snapshot');
  assert.deepEqual(vals(r, 'url'), ['https://fixture-site.example/news?id=7']); assert.deepEqual(vals(r, 'document'), ['page.html']);
  const raw = r.results[0].raw; assert.equal(raw.sha256, sha('sha256', content)); assert.equal(raw.savedAt, '2026-10-26T12:34:56.000Z'); assert.equal(raw.size, content.length); assert.equal(raw.contentType, 'text/html'); assert.equal(raw.timeSource, 'file-time');
  assert.equal(r.results[0].confidence, 'likely'); assert.equal(r.results[1].confidence, 'confirmed'); assert.equal(r.results[1].raw.rel, 'saved-copy-of');
  assert.ok(r.notes.some((n) => /cannot prove the file was saved from there/.test(n)));
  const given = await mods.runModule('local-snapshot', { url: 'https://fixture-site.example/', file: p, timestamp: '2026-10-25T08:00:00Z' }, { now: () => NOW }); assert.equal(given.results[0].raw.savedAt, '2026-10-25T08:00:00.000Z'); assert.equal(given.results[0].raw.timeSource, 'given');
  const bad = [{ url: 'https://user:pass@fixture-site.example/', file: p }, { url: 'ftp://fixture-site.example/', file: p }, { url: 'javascript:alert(1)', file: p }, { url: 'not a url', file: p }, { file: p }, { url: 'https://fixture-site.example/' }, { url: 'https://fixture-site.example/', file: path.dirname(p) }, { url: 'https://fixture-site.example/', file: p, timestamp: '2099-01-01' }, { url: 'https://fixture-site.example/', file: p, timestamp: '2026-13-45' }];
  for (const b of bad) { const x = await mods.runModule('local-snapshot', b, { now: () => NOW }); assert.equal(x.status, 'bad-input', JSON.stringify(b)); assert.equal(x.results.length, 0); }
  const st = await mods.runModule('local-snapshot', { check: 'selftest' }, { now: () => NOW }); assert.equal(st.status, 'ok'); assert.equal(st.results.length, 2); assert.deepEqual(vals(st, 'url'), ['https://example.com/snapshot-selftest']);
});

// ---------------- as real connector folders ----------------
test('keyless: materialized connectors run from their own folder; the local ones and a mocked network one print valid result lines', () => {
  const root = tmp('mfd-kl-m-');
  const FIX = path.join(__dirname, 'fixtures');
  const prelude = `globalThis.fetch = require(${JSON.stringify(path.join(FIX, 'ghost-modules-mock.js'))}).makeFetch(require(${JSON.stringify(path.join(FIX, 'ghost-modules-keyless.json'))}));`;
  const trace = (id, args, pre) => {
    const dir = mods.materialize(id, root, { prelude: pre });
    const man = JSON.parse(fs.readFileSync(path.join(dir, 'connector.json'), 'utf8'));
    for (const f of man.command.files) assert.ok(fs.existsSync(path.join(dir, f)), id + ' ships ' + f);
    const out = spawnSync(process.execPath, ['run.js', ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, TMPDIR: root } });
    const lines = out.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.entity);
    return { code: out.status, lines, err: out.stderr };
  };
  for (const id of LOCAL) { const t = trace(id, ['--check=selftest']); assert.equal(t.code, 0, id + t.err); assert.ok(t.lines.length >= 1, id); for (const l of t.lines) assert.equal(validateResult(l, { connector: id }).ok, true, id); assert.match(t.err, /network: local/); }
  const g = trace('gleif', ['--kind=lei', '--query=FIXLEI0000000000AB01'], prelude);
  assert.equal(g.code, 0, g.err); assert.equal(g.lines[0].entity.value, 'Fixture Holdings Ltd'); assert.equal(validateResult(g.lines[0], { connector: 'gleif' }).ok, true); assert.match(g.err, /network: rate-limited \(1 request\)/);
  const n = trace('nominatim', ['--kind=geocode', '--query=Fixture Cathedral; Fixture Bridge'], prelude);
  assert.equal(n.code, 2); assert.match(n.err, /bad-input: one place per run/); assert.equal(n.lines.length, 0);
});

test('keyless: the code carries no person-lookup tool and the new connectors name no AI authorship', () => {
  const dir = path.join(__dirname, '..', 'src/main/ghost/modules/lib');
  for (const id of IDS) for (const f of [id + '.js']) { const s = fs.readFileSync(path.join(dir, f), 'utf8'); assert.ok(!/sherlock|maigret|holehe|blackbird|whatsmyname|gallery-dl/i.test(s), f); assert.ok(!/\b(claude|anthropic|chatgpt|openai|generated by (an )?ai|ai-generated)\b/i.test(s), f); }
  const s = fs.readFileSync(path.join(dir, 'keyless-common.js'), 'utf8'); assert.ok(!/\b(claude|anthropic|chatgpt|openai)\b/i.test(s));
  assert.ok(!/\b(claude|anthropic|chatgpt|openai)\b/i.test(fs.readFileSync(path.join(__dirname, 'fixtures/ghost-modules-keyless.json'), 'utf8')));
  assert.ok(!fs.existsSync(path.join(dir, 'companies-house.js')) && !fs.existsSync(path.join(dir, 'opencorporates.js')));
});
