'use strict';
// Part B: Ghost passive modules (phase 1). No test reaches the network: the global fetch is replaced by a trap, and every module gets an
// injected mock transport built from hand-labelled fixtures (test/fixtures/ghost-modules.json).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tmp } = require('./ghost-helpers');
const { makeFetch } = require('./fixtures/ghost-modules-mock');
const fixtures = require('./fixtures/ghost-modules.json');
const mods = require('../src/main/ghost/modules');
const { core } = mods;
const { validateResult } = require('../src/main/ghost/result');
const M_gdeltDoc = require('../src/main/ghost/modules/lib/gdelt-doc');
const { validateManifest } = require('../src/main/ghost/manifest');
const X = require('../src/main/ghost/modules/lib/exif-parse');

const realFetch = globalThis.fetch;
let trapHits = 0;
globalThis.fetch = async (u) => { trapHits++; throw new Error('LIVE NETWORK CALL IN A TEST: ' + u); };
test.after(() => { globalThis.fetch = realFetch; });

const NOW = new Date('2026-10-27T09:00:00.000Z');
const noSleep = async () => {};
function run(id, input, { overrides = [], egress = null } = {}) {
  const f = makeFetch(fixtures, { overrides });
  return mods.runModule(id, input, { fetch: f, sleep: noSleep, now: () => NOW, egress }).then((r) => { r.fetch = f; return r; });
}
// every line must pass the real result validator, with the connector id as the only allowed source
function valid(r, id) {
  for (const line of r.results) { const v = validateResult(line, { connector: id, now: NOW.getTime() }); assert.equal(v.ok, true, v.error + ' ' + JSON.stringify(line)); }
  assert.deepEqual(r.fetch ? r.fetch.unmocked : [], [], 'every request was mocked');
}
const vals = (r, type) => r.results.filter((x) => x.entity.type === type).map((x) => x.entity.value);
const find = (r, type, value) => r.results.find((x) => x.entity.type === type && x.entity.value === value);
const text = (r) => JSON.stringify(r.results);

// ---------------- core client ----------------
const res = (body, init = {}) => new Response(body, init);
function client(over = {}) {
  const calls = [];
  let t = 1e12;
  const fetch = over.fetch || (async (u, o) => { calls.push([u, o]); return res('{}'); });
  const sleeps = [];
  const c = core.createClient({ fetch, hosts: ['a.example'], sleep: async (ms) => { sleeps.push(ms); }, now: () => t, ...over });
  return { c, calls, sleeps, tick: (ms) => { t += ms; } };
}
const kind = (p) => p.then(() => 'resolved', (e) => e.kind);

test('client: https, allowlist, credentials, port and the egress hook are checked before any request', async () => {
  const { c, calls } = client();
  assert.equal(await kind(c.get('http://a.example/x')), 'blocked');
  assert.equal(await kind(c.get('https://b.example/x')), 'blocked');
  assert.equal(await kind(c.get('https://u:p@a.example/x')), 'blocked');
  assert.equal(await kind(c.get('https://a.example:8443/x')), 'blocked');
  assert.equal(await kind(c.get('not a url')), 'blocked');
  assert.equal(calls.length, 0);
  const seen = [];
  const e = client({ egress: async (r) => { seen.push(r); return r.purpose !== 'no'; }, module: 'm1' });
  assert.equal(await kind(e.c.get('https://a.example/x', { purpose: 'yes' })), 'resolved');
  assert.equal(await kind(e.c.get('https://a.example/y', { purpose: 'no' })), 'blocked');
  assert.equal(e.calls.length, 1);
  assert.deepEqual(seen[0], { url: 'https://a.example/x', host: 'a.example', module: 'm1', purpose: 'yes' });
  assert.equal(await kind(client({ egress: async () => ({ allow: false, reason: 'policy' }) }).c.get('https://a.example/')), 'blocked');
  assert.equal(await kind(client({ egress: async () => { throw new Error('boom'); } }).c.get('https://a.example/')), 'blocked');
});
test('client: rate limit between requests to one host, request cap, redirects re-checked', async () => {
  const k = client({ rps: 1 });
  await k.c.get('https://a.example/1'); await k.c.get('https://a.example/2');
  assert.deepEqual(k.sleeps, [1000]);
  const cap = client({ maxRequests: 2 });
  await cap.c.get('https://a.example/1'); await cap.c.get('https://a.example/2');
  assert.equal(await kind(cap.c.get('https://a.example/3')), 'blocked');
  const ok = client({ fetch: async (u) => (u.endsWith('/x') ? res(null, { status: 302, headers: { location: '/y' } }) : res('{"y":1}')) });
  assert.deepEqual((await ok.c.get('https://a.example/x')).json(), { y: 1 });
  const evil = client({ fetch: async () => res(null, { status: 302, headers: { location: 'https://evil.example/' } }) });
  assert.equal(await kind(evil.c.get('https://a.example/x')), 'blocked');
  const loop = client({ fetch: async () => res(null, { status: 302, headers: { location: '/again' } }) });
  assert.equal(await kind(loop.c.get('https://a.example/x')), 'bad-response');
});
test('client: honest failure classes (rate-limited, unavailable, bad-response) and size cap', async () => {
  const r429 = client({ fetch: async () => res('x', { status: 429, headers: { 'retry-after': '7' } }) });
  await assert.rejects(r429.c.get('https://a.example/'), (e) => e.kind === 'rate-limited' && e.retryAfter === 7);
  assert.equal(r429.c.state.rateLimited, true);
  assert.equal(await kind(client({ fetch: async () => res('x', { status: 503, headers: { 'retry-after': '5' } }) }).c.get('https://a.example/')), 'rate-limited');
  assert.equal(await kind(client({ fetch: async () => res('x', { status: 503 }) }).c.get('https://a.example/')), 'unavailable');
  assert.equal(await kind(client({ fetch: async () => res('x', { status: 500 }) }).c.get('https://a.example/')), 'unavailable');
  assert.equal(await kind(client({ fetch: async () => { throw new Error('ECONNRESET'); } }).c.get('https://a.example/')), 'unavailable');
  await assert.rejects(client({ fetch: async () => res('x', { status: 401 }) }).c.get('https://a.example/'), (e) => e.kind === 'unavailable' && e.loginRequired === true && /needs an account login/.test(e.message));
  assert.equal(await kind(client({ fetch: async () => res('x', { status: 403 }) }).c.get('https://a.example/')), 'unavailable');
  assert.equal(await kind(client({ fetch: async () => res('x', { status: 400 }) }).c.get('https://a.example/')), 'bad-response');
  assert.equal((await client({ fetch: async () => res('', { status: 404 }) }).c.get('https://a.example/')).status, 404);
  assert.equal(await kind(client({ maxBytes: 1000, fetch: async () => res('x'.repeat(2000)) }).c.get('https://a.example/')), 'bad-response');
  assert.equal(await kind(client({ maxBytes: 1000, fetch: async () => res('x', { headers: { 'content-length': '5000' } }) }).c.get('https://a.example/')), 'bad-response');
  await assert.rejects(client({ fetch: async () => res('not json') }).c.get('https://a.example/').then((r) => r.json()), (e) => e.kind === 'bad-response');
  const slow = client({ timeoutMs: 30, fetch: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  await assert.rejects(slow.c.get('https://a.example/'), (e) => e.kind === 'unavailable' && /did not answer/.test(e.message));
});
test('client: only a dynamic client accepts registry-named hosts, and only real DNS names', () => {
  assert.throws(() => client().c.allow('rdap.example'), (e) => e.kind === 'blocked');
  const d = client({ dynamic: true }).c;
  d.allow('rdap.example');
  for (const bad of ['localhost', '127.0.0.1', '10.0.0.1', '[::1]', 'a b.example', 'x.123']) assert.throws(() => d.allow(bad), (e) => e.kind === 'blocked', bad);
});
test('ip helpers: CIDR matching for v4 and v6, reserved ranges', () => {
  assert.equal(core.inCidr('11.22.33.44', '11.0.0.0/8'), true);
  assert.equal(core.inCidr('12.22.33.44', '11.0.0.0/8'), false);
  assert.equal(core.inCidr('2a00:1450:4001::1', '2a00:1450::/32'), true);
  assert.equal(core.inCidr('2a00:1451::1', '2a00:1450::/32'), false);
  assert.equal(core.inCidr('::ffff:1.2.3.4', '::ffff:0:0/96'), true);
  for (const ip of ['10.1.1.1', '127.0.0.1', '169.254.1.1', '192.168.0.1', '172.20.0.1', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '2001:db8::1', '203.0.113.5']) assert.equal(core.isReservedIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '11.22.33.44', '2a00:1450:4001::1']) assert.equal(core.isReservedIp(ip), false, ip);
});

// ---------------- manifests ----------------
test('every module has a valid connector manifest with an honest network class and no person input', () => {
  const ALLOWED_INPUTS = new Set(['bbox', 'start', 'end', 'maxCloud', 'instance', 'url', 'token', 'language', 'every', 'max', 'domain', 'types', 'provider', 'kind', 'value', 'expired', 'target', 'mode', 'timestamp', 'limit', 'query', 'timespan', 'file', 'check']);
  assert.ok(mods.MODULES.length >= 8);
  const expected = { 'dns-doh': 'keyless-external', 'rdap-domain': 'rate-limited', 'rdap-ip-asn': 'rate-limited', 'ct-crtsh': 'rate-limited', 'wayback-cdx': 'rate-limited', 'exif-meta': 'local', 'gdelt-doc': 'rate-limited', wikidata: 'rate-limited' };
  for (const m of mods.MODULES) {
    const man = mods.toManifest(m.meta);
    const v = validateManifest(man);
    assert.equal(v.ok, true, m.meta.id + ' ' + JSON.stringify(v.errors || v));
    if (expected[m.meta.id]) assert.equal(man.network, expected[m.meta.id]);
    assert.equal(man.permissions.includes('network'), man.network !== 'local');
    assert.equal(man.licence.mode, m.meta.separateProgram ? 'separate-program' : 'bundled');
    for (const f of man.input.fields) assert.ok(ALLOWED_INPUTS.has(f.name), 'unexpected input ' + f.name);
    assert.ok(!man.input.fields.some((f) => /e-?mail|user(name)?|handle|phone|person|people|^name$/i.test(f.name)));
    for (const r of man.command.files) assert.ok(fs.existsSync(path.join(__dirname, '..', 'src/main/ghost/modules', r)), r);
  }
  assert.deepEqual(mods.describe().filter((d) => expected[d.id]).map((d) => d.network).sort(), Object.values(expected).sort());
});

// ---------------- dns-doh ----------------
test('dns-doh: all record types, entity mapping, DNSSEC state decides confidence, no mailbox leaks', async () => {
  const r = await run('dns-doh', { domain: 'example.com', types: 'all' });
  assert.equal(r.status, 'ok'); valid(r, 'dns-doh');
  assert.equal(r.network, 'keyless-external'); assert.equal(r.requests, 7);
  assert.deepEqual(vals(r, 'ip').sort(), ['198.51.100.7', '2001:db8::7']);
  assert.equal(find(r, 'ip', '198.51.100.7').confidence, 'confirmed');       // AD true
  assert.equal(find(r, 'ip', '2001:db8::7').confidence, 'likely');           // AD false
  assert.deepEqual(vals(r, 'domain').sort(), ['mail.example.com', 'mail2.example.com', 'ns1.example.com', 'ns2.example.com']);
  assert.equal(find(r, 'domain', 'mail2.example.com').raw.priority, 20);
  assert.equal(find(r, 'domain', 'ns1.example.com').raw.rel, 'nameserver');
  const ev = vals(r, 'event');
  assert.ok(ev.includes('TXT example.com: v=spf1 include:_spf.example.com ~all'));
  assert.ok(ev.includes('TXT example.com: helloworld'));
  assert.ok(ev.includes('SOA example.com: primary ns1.example.com, serial 2024050101'));
  assert.ok(ev.includes('CAA example.com: issue letsencrypt.org'));
  assert.equal(r.results.length, 11);
  assert.ok(!/hostmaster|@/.test(text(r)), 'no mailbox in results');
  assert.equal(r.results.find((x) => x.raw.tag === 'iodef').raw.contactWithheld, true);
  assert.equal(r.results[0].source.connector, 'dns-doh'); assert.equal(r.results[0].observedAt, NOW.toISOString());
});
test('dns-doh: CNAME chain, NXDOMAIN, other resolver, bad input and no request for bad input', async () => {
  const c = await run('dns-doh', { domain: 'www.example.com', types: 'A' });
  assert.equal(find(c, 'domain', 'edge.example.net').raw.rel, 'alias-target');
  assert.equal(find(c, 'ip', '198.51.100.9').entity.type, 'ip');
  const n = await run('dns-doh', { domain: 'missing.example.com', types: 'A' });
  assert.equal(n.status, 'ok'); assert.equal(n.results.length, 0); assert.ok(n.notes.some((x) => /NXDOMAIN/.test(x)));
  const g = await run('dns-doh', { domain: 'example.com', types: 'A', provider: 'google' });
  assert.deepEqual(vals(g, 'ip'), ['198.51.100.8']); assert.ok(g.fetch.log[0].startsWith('https://dns.google/resolve?'));
  assert.equal(g.results[0].confidence, 'likely');
  for (const bad of ['10.0.0.1', 'localhost', 'a b.example', '']) { const b = await run('dns-doh', { domain: bad }); assert.equal(b.status, 'bad-input', bad); assert.equal(b.requests, 0); }
  assert.equal((await run('dns-doh', { domain: 'example.com', provider: 'evil' })).status, 'bad-input');
  const u = await run('dns-doh', { domain: '_dmarc.example.com', types: 'A' }, { overrides: [{ match: { host: 'cloudflare-dns.com', query: { name: '_dmarc.example.com' } }, json: { Status: 0, Answer: [] } }] });
  assert.equal(u.status, 'ok');
});

// ---------------- rdap-domain ----------------
test('rdap-domain: registration facts from the registry the bootstrap names; contacts passed on as published, registry redactions counted', async () => {
  const r = await run('rdap-domain', { domain: 'EXAMPLE.com' });
  assert.equal(r.status, 'ok'); valid(r, 'rdap-domain');
  assert.equal(r.network, 'rate-limited'); assert.equal(r.requests, 2);
  assert.deepEqual(r.fetch.log, ['https://data.iana.org/rdap/dns.json', 'https://rdap.registry-fixture.example/domain/example.com']);
  const d = find(r, 'domain', 'example.com');
  assert.deepEqual(d.raw.status, ['client transfer prohibited', 'active']);
  assert.equal(d.raw.dnssec, true); assert.equal(d.raw.redacted, true); assert.equal(d.raw.registryRedactedContacts, 1); assert.equal(d.raw.personalContactsWithheld, undefined);
  assert.deepEqual(vals(r, 'event'), ['registration of example.com: 1995-08-14', 'expiration of example.com: 2027-08-13', 'last changed of example.com: 2026-08-14']);
  assert.equal(find(r, 'event', 'expiration of example.com: 2027-08-13').raw.t, '2027-08-13T04:00:00.000Z');
  assert.deepEqual(vals(r, 'domain').sort(), ['example.com', 'ns1.example.com', 'ns2.example.com']);
  assert.deepEqual(vals(r, 'org'), ['Fixture Registrar Inc.']);
  const mail = r.results.find((x) => x.entity.type === 'email');
  assert.equal(mail.entity.value, 'abuse@registrar-fixture.example'); assert.equal(mail.raw.role, 'abuse-contact');
  // the individual the registry published is passed on, with the role and the mailbox as published; the registry's own REDACTED placeholder is not reported
  assert.deepEqual(vals(r, 'person'), ['Jane Fixture-Person']);
  const jane = find(r, 'person', 'Jane Fixture-Person'); assert.deepEqual(jane.raw.roles, ['technical']); assert.deepEqual(jane.raw.emails, ['jane@person-fixture.example']); assert.equal(jane.raw.of, 'example.com');
  assert.ok(!/REDACTED/.test(text(r))); assert.ok(r.notes.some((n) => /1 contact\(s\) were redacted by the registry itself/.test(n)));
  assert.equal(r.results.filter((x) => x.entity.type === 'email').length, 1, 'only the abuse mailbox is an email result');
  assert.equal(r.results.every((x) => x.source.url.startsWith('https://rdap.registry-fixture.example/')), true);
});
test('rdap-domain: not found, TLD without service, wrong object, hostile bootstrap, bad input', async () => {
  const nf = await run('rdap-domain', { domain: 'unregistered.com' });
  assert.equal(nf.status, 'ok'); assert.equal(nf.results.length, 0); assert.ok(nf.notes.some((x) => /no record/.test(x)));
  const tld = await run('rdap-domain', { domain: 'a.xyz' });
  assert.equal(tld.status, 'unavailable'); assert.match(tld.message, /\.xyz/); assert.equal(tld.network, 'unavailable');
  const org = await run('rdap-domain', { domain: 'x.org' });      // the http:// registry URL is skipped, the https one is used
  assert.equal(org.status, 'bad-response'); assert.equal(org.fetch.log[1], 'https://rdap.org-fixture.example/rdap/domain/x.org');
  for (const url of ['https://127.0.0.1/', 'https://localhost/', 'https://u:p@evil.example/', 'https://evil.example:8443/', 'http://evil.example/']) {
    const h = await run('rdap-domain', { domain: 'a.com' }, { overrides: [{ match: { host: 'data.iana.org', path: '/rdap/dns.json' }, json: { services: [[['com'], [url]]] } }] });
    assert.equal(h.status, 'unavailable', url); assert.equal(h.requests, 1, url);
  }
  for (const bad of ['example', '192.0.2.1', 'bad domain', '']) { const b = await run('rdap-domain', { domain: bad }); assert.equal(b.status, 'bad-input', bad); assert.equal(b.requests, 0); }
});

// ---------------- rdap-ip-asn ----------------
test('rdap-ip-asn: IP block record with operator organisation, individual contact passed on', async () => {
  const r = await run('rdap-ip-asn', { kind: 'ip', value: '11.22.33.44' });
  assert.equal(r.status, 'ok'); valid(r, 'rdap-ip-asn');
  const ip = find(r, 'ip', '11.22.33.0/24');
  assert.equal(ip.raw.name, 'FIXTURE-NET'); assert.equal(ip.raw.country, 'GB'); assert.equal(ip.raw.queried, '11.22.33.44'); assert.equal(ip.raw.redacted, undefined);
  assert.deepEqual(vals(r, 'org'), ['Fixture Network Operations Ltd']);
  assert.equal(r.results.find((x) => x.entity.type === 'email').entity.value, 'abuse@fno-fixture.example');
  assert.equal(vals(r, 'event').length, 2);
  assert.deepEqual(vals(r, 'person'), ['Pat Fixture-Person']); assert.deepEqual(find(r, 'person', 'Pat Fixture-Person').raw.roles, ['technical']);
  assert.deepEqual(r.fetch.log, ['https://data.iana.org/rdap/ipv4.json', 'https://rdap.rir-fixture.example/ip/11.22.33.44']);
  const v6 = await run('rdap-ip-asn', { kind: 'ip', value: '2a00:1450:4001::1' });
  assert.equal(v6.status, 'ok'); assert.equal(v6.fetch.log[0], 'https://data.iana.org/rdap/ipv6.json');
});
test('rdap-ip-asn: AS numbers, not found, unlisted, and refusal of private or malformed values', async () => {
  const a = await run('rdap-ip-asn', { kind: 'asn', value: 'as64500' });
  assert.equal(a.status, 'ok'); valid(a, 'rdap-ip-asn');
  assert.equal(find(a, 'asn', 'AS64500').raw.name, 'FIXTURE-AS'); assert.deepEqual(vals(a, 'org'), ['Fixture Transit plc']);
  assert.equal((await run('rdap-ip-asn', { kind: 'asn', value: '64500' })).results.length, 3);
  const nf = await run('rdap-ip-asn', { kind: 'asn', value: '65000' });
  assert.equal(nf.status, 'ok'); assert.equal(nf.results.length, 0);
  assert.equal((await run('rdap-ip-asn', { kind: 'asn', value: '99999' })).status, 'unavailable');
  for (const [k, v] of [['ip', '10.0.0.1'], ['ip', '127.0.0.1'], ['ip', '::1'], ['ip', '192.168.1.1'], ['ip', 'not-an-ip'], ['asn', 'AS0'], ['asn', 'AS99999999999'], ['asn', 'banana']]) {
    const b = await run('rdap-ip-asn', { kind: k, value: v });
    assert.equal(b.status, 'bad-input', v); assert.equal(b.requests, 0, v);
  }
});

// ---------------- ct-crtsh ----------------
test('ct-crtsh: certificates and in-scope names; email-like names, other domains and duplicates handled', async () => {
  const r = await run('ct-crtsh', { domain: 'example.com', expired: 'exclude' });
  assert.equal(r.status, 'ok'); valid(r, 'ct-crtsh');
  assert.ok(r.fetch.log[0].includes('exclude=expired'));
  assert.deepEqual(vals(r, 'cert'), ['crtsh:1003', 'crtsh:1002', 'crtsh:1001']);
  assert.deepEqual(vals(r, 'domain'), ['api.example.com', 'example.com', 'www.example.com']);
  const ex = find(r, 'domain', 'example.com');
  assert.equal(ex.raw.certificates, 2); assert.equal(ex.raw.wildcardSeen, true); assert.equal(ex.raw.firstNotBefore, '2024-01-01T00:00:00.000Z'); assert.equal(ex.raw.lastNotAfter, '2024-09-01T23:59:59.000Z');
  assert.equal(find(r, 'domain', 'www.example.com').raw.certificates, 1);
  const c = find(r, 'cert', 'crtsh:1003');
  assert.equal(c.source.url, 'https://crt.sh/?id=1003'); assert.equal(c.raw.namesInScope, 1); assert.equal(c.raw.namesOutOfScope, 2); assert.equal(c.raw.notAfter, '2025-04-01T23:59:59.000Z');
  assert.ok(!/user@|other-site/.test(text(r)));
  assert.ok(r.notes.some((n) => /1 certificate name\(s\) that are not host names were withheld/.test(n)));
  assert.equal(r.requests, 1); assert.equal((await run('ct-crtsh', { domain: 'example.com' })).fetch.log[0].includes('exclude'), false);
});
test('ct-crtsh: empty answer, overloaded service and throttling are reported as what they are', async () => {
  const e = await run('ct-crtsh', { domain: 'nothing.example.com' });
  assert.equal(e.status, 'ok'); assert.equal(e.results.length, 0);
  const u = await run('ct-crtsh', { domain: 'busy.example.com' });
  assert.equal(u.status, 'unavailable'); assert.equal(u.network, 'unavailable'); assert.equal(u.exitCode, 69);
  const l = await run('ct-crtsh', { domain: 'limited.example.com' });
  assert.equal(l.status, 'rate-limited'); assert.equal(l.network, 'rate-limited'); assert.equal(l.exitCode, 75); assert.match(l.message, /retry after 30 s/);
  const bad = await run('ct-crtsh', { domain: 'example.com' }, { overrides: [{ match: { host: 'crt.sh' }, text: '<html>oops</html>' }] });
  assert.equal(bad.status, 'bad-response');
  const big = await mods.runModule('ct-crtsh', { domain: 'example.com' }, { fetch: async () => new Response('x'.repeat(9 * 1024 * 1024)), sleep: noSleep });
  assert.equal(big.status, 'bad-response');
  assert.equal((await run('ct-crtsh', { domain: 'x' })).status, 'bad-input');
});

// ---------------- wayback-cdx ----------------
test('wayback-cdx summary: first and last capture, years, snapshot links', async () => {
  const r = await run('wayback-cdx', { target: 'example.com' });
  assert.equal(r.status, 'ok'); valid(r, 'wayback-cdx'); assert.equal(r.requests, 3);
  assert.deepEqual(vals(r, 'event'), ['first capture of example.com: 1996-01-01', 'last capture of example.com: 2026-03-01', 'captured in 3 calendar year(s): 1996, 2005, 2026']);
  assert.deepEqual(vals(r, 'url'), ['https://web.archive.org/web/19960101000000/http://example.com/', 'https://web.archive.org/web/20260301120000/https://example.com/']);
  assert.equal(find(r, 'event', 'first capture of example.com: 1996-01-01').raw.t, '1996-01-01T00:00:00.000Z');
  assert.equal(r.results.filter((x) => x.entity.type === 'url').every((x) => x.source.tool === 'wayback-cdx'), true);
});
test('wayback-cdx snapshots, closest, empty and hostile answers', async () => {
  const s = await run('wayback-cdx', { target: 'example.com', mode: 'snapshots', limit: '5' });
  assert.equal(s.status, 'ok'); valid(s, 'wayback-cdx'); assert.equal(vals(s, 'url').length, 3);
  assert.ok(s.fetch.log[0].includes('limit=5') && s.fetch.log[0].includes('collapse=timestamp%3A6'));
  assert.equal(find(s, 'url', 'https://web.archive.org/web/20200220010101/https://example.com/').raw.status, '301');
  assert.ok((await run('wayback-cdx', { target: 'example.com', mode: 'snapshots' })).fetch.log[0].includes('limit=100'));
  const c = await run('wayback-cdx', { target: 'example.com', mode: 'closest', timestamp: '2015' });
  assert.deepEqual(vals(c, 'url'), ['https://web.archive.org/web/20150304050607/http://example.com/']);
  assert.ok(c.fetch.log[0].includes('timestamp=2015')); assert.equal(c.results.length, 2);
  assert.equal((await run('wayback-cdx', { target: 'nothing.example.net', mode: 'closest' })).results.length, 0);
  assert.equal((await run('wayback-cdx', { target: 'nothing.example.net' })).results.length, 0);
  assert.equal((await run('wayback-cdx', { target: 'evil.example.net', mode: 'closest' })).status, 'bad-response');
  const odd = await run('wayback-cdx', { target: 'example.com', mode: 'snapshots' }, { overrides: [{ match: { host: 'web.archive.org' }, text: '{"a":1}' }] });
  assert.equal(odd.status, 'bad-response');
  assert.equal((await run('wayback-cdx', { target: 'example.com', mode: 'save' })).status, 'bad-input');
});
test('wayback-cdx target normalising', () => {
  const n = require('../src/main/ghost/modules/lib/wayback-cdx').normaliseTarget;
  assert.equal(n('https://Example.com/path?x=1#frag'), 'example.com/path?x=1');
  assert.equal(n('example.com'), 'example.com'); assert.equal(n('http://user:pw@example.com:8080/a'), 'example.com/a');
  for (const bad of ['ftp://example.com', 'javascript:alert(1)', 'a b', '', '192.0.2.1', 'http://localhost/', '<x>']) assert.throws(() => n(bad), (e) => e.kind === 'bad-input', bad);
});

// ---------------- gdelt-doc ----------------
test('gdelt-doc: articles and timeline, one request, citation-ready, relevance not claimed', async () => {
  const a = await run('gdelt-doc', { kind: 'organisation', query: 'Fixture Corp' });
  assert.equal(a.status, 'ok'); valid(a, 'gdelt-doc'); assert.equal(a.requests, 1);
  assert.deepEqual(vals(a, 'url'), ['https://news.example.org/a1', 'https://daily.example.net/b2']);
  assert.equal(a.results[0].confidence, 'likely'); assert.equal(a.results[0].raw.seen, '2026-03-10T09:15:00.000Z'); assert.equal(a.results[0].raw.domain, 'news.example.org');
  const u = new URL(a.fetch.log[0]);
  assert.equal(u.searchParams.get('query'), '"Fixture Corp"'); assert.equal(u.searchParams.get('mode'), 'artlist'); assert.equal(u.searchParams.get('timespan'), '7d');
  const d = await run('gdelt-doc', { kind: 'domain', query: 'Example.com', timespan: '1month' });
  assert.equal(new URL(d.fetch.log[0]).searchParams.get('query'), 'domain:example.com');
  const t = await run('gdelt-doc', { kind: 'topic', query: 'plant', mode: 'timeline' });
  assert.equal(t.status, 'ok'); valid(t, 'gdelt-doc');
  assert.deepEqual(t.results.map((x) => x.raw.t), ['2026-03-01T00:00:00.000Z', '2026-03-02T00:00:00.000Z']); assert.equal(t.results[1].raw.volumePercent, 0.034);
});
test('gdelt-doc: no query is refused for how it looks; it is sent as typed, and bad input is still caught', async () => {
  for (const q of ['someone@example.com', '+44 7700 900123', '07700 900123', '@somehandle', '#tag', 'https://example.com/x', 'a/b']) {
    const r = await run('gdelt-doc', { kind: 'topic', query: q }, { overrides: [{ match: { host: 'api.gdeltproject.org' }, json: { articles: [{ url: 'https://news.example.org/q', title: 'Fixture', seendate: '20260310T091500Z', domain: 'news.example.org' }] } }] });
    assert.equal(r.status, 'ok', q); assert.equal(r.requests, 1, q); assert.equal(r.results.length, 1, q);
  }
  assert.equal(M_gdeltDoc.buildQuery('topic', 'someone@example.com'), 'someone@example.com');
  assert.equal((await run('gdelt-doc', { kind: 'domain', query: 'not a domain' })).status, 'bad-input');
  const rl = await run('gdelt-doc', { kind: 'topic', query: 'plant' }, { overrides: [{ match: { host: 'api.gdeltproject.org' }, text: 'Please limit requests to one every 5 seconds or review the API documentation.' }] });
  assert.equal(rl.status, 'rate-limited'); assert.equal(rl.exitCode, 75);
  const rej = await run('gdelt-doc', { kind: 'topic', query: 'plant' }, { overrides: [{ match: { host: 'api.gdeltproject.org' }, text: 'Your query was too short or too long.' }] });
  assert.equal(rej.status, 'bad-input');
  const em = await run('gdelt-doc', { kind: 'topic', query: 'plant' }, { overrides: [{ match: { host: 'api.gdeltproject.org' }, text: '' }] });
  assert.equal(em.status, 'ok'); assert.equal(em.results.length, 0);
});

// ---------------- wikidata ----------------
test('wikidata organisations: items for people are reported as people, website and inception reported, matches marked likely', async () => {
  const r = await run('wikidata', { kind: 'organisation', query: 'Fixture Corp' });
  assert.equal(r.status, 'ok'); valid(r, 'wikidata'); assert.equal(r.requests, 2);
  assert.deepEqual(vals(r, 'org'), ['Fixture Corp', 'Fixture Corp Holdings']);
  assert.equal(find(r, 'org', 'Fixture Corp').raw.qid, 'Q1001'); assert.equal(find(r, 'org', 'Fixture Corp').source.url, 'https://www.wikidata.org/wiki/Q1001');
  assert.equal(find(r, 'org', 'Fixture Corp Holdings').raw.matchNote.includes('not an exact label match'), true);
  assert.deepEqual(vals(r, 'url'), ['https://www.fixture-corp.example/']);
  assert.deepEqual(vals(r, 'event'), ['inception of Fixture Corp: 1998-09-04']);
  assert.equal(r.results.every((x) => x.confidence === 'likely'), true);
  const human = find(r, 'person', 'Fixture Corp'); assert.equal(human.raw.qid, 'Q1002'); assert.equal(human.raw.description, 'a person with this name'); assert.equal(human.source.url, 'https://www.wikidata.org/wiki/Q1002'); assert.equal(human.confidence, 'likely');
  assert.ok(!r.notes.some((n) => /withheld/.test(n)));
});
test('wikidata places and edge cases', async () => {
  const r = await run('wikidata', { kind: 'place', query: 'Fixtureville' });
  assert.equal(r.status, 'ok'); valid(r, 'wikidata');
  const p = find(r, 'place', 'Fixtureville');
  assert.equal(p.confidence, 'likely'); assert.equal(p.raw.lat, 51.5); assert.equal(p.raw.lon, -0.12);
  const q = find(r, 'place', 'Fixtureville Township');
  assert.equal(q.confidence, 'uncertain'); assert.match(q.uncertaintyNote, /no coordinates/);
  assert.equal((await run('wikidata', { kind: 'place', query: 'Nothing Matches This' })).results.length, 0);
  for (const bad of ['x', 'a@b.example', 'https://example.com']) assert.equal((await run('wikidata', { kind: 'organisation', query: bad })).status, 'bad-input', bad);
  assert.equal((await run('wikidata', { kind: 'person', query: 'Fixture Corp' })).status, 'bad-input');
});

// ---------------- exif-meta ----------------
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function put(name, buf) { const p = path.join(tmp('mfd-exif-'), name); fs.writeFileSync(p, buf); return p; }
const runFile = (file) => mods.runModule('exif-meta', { file }, { now: () => NOW });
test('exif-meta JPEG: camera, software, times with zone, GPS; personal fields withheld; entirely local', async () => {
  const buf = X.buildExifJpeg({ make: 'Acme', model: 'Cam 1', software: 'Edit 2', dateOriginal: '2024:05:01 12:30:00', offsetOriginal: '+01:00', artist: 'Zed Fixture-Person', lat: 51.5007, lon: -0.1246, alt: 11.2, width: 640, height: 480 });
  const r = await runFile(put('holiday.jpg', buf));
  assert.equal(r.status, 'ok'); valid(r, 'exif-meta');
  assert.equal(r.network, 'local'); assert.equal(r.requests, 0); assert.equal(trapHits, 0);
  const img = find(r, 'image', 'holiday.jpg');
  assert.deepEqual(JSON.parse(JSON.stringify(img.raw)), { format: 'jpeg', size: buf.length, sha256: sha(buf), width: 640, height: 480, make: 'Acme', model: 'Cam 1', software: 'Edit 2', personalFieldsWithheld: ['Artist'] });
  const ev = r.results.find((x) => x.entity.type === 'event');
  assert.equal(ev.raw.kind, 'capture'); assert.equal(ev.raw.t, '2024-05-01T11:30:00.000Z'); assert.equal(ev.raw.zoneStated, true);
  const place = r.results.find((x) => x.entity.type === 'place');
  assert.equal(place.entity.value, '51.5007,-0.1246'); assert.equal(place.raw.altitudeM, 11.2); assert.equal(place.confidence, 'likely');
  assert.ok(!/Zed|Fixture-Person/.test(text(r)));
  assert.ok(r.notes.some((n) => /personal fields withheld: Artist/.test(n)));
});
test('exif-meta: big-endian, southern and western positions, no zone means none is claimed, missing EXIF', async () => {
  const r = await runFile(put('b.jpg', X.buildExifJpeg({ make: 'Big', bigEndian: true, lat: -33.8568, lon: 151.2153, dateOriginal: '2020:01:02 03:04:05' })));
  assert.equal(find(r, 'place', '-33.8568,151.2153').raw.rel, 'embedded-gps');
  const ev = r.results.find((x) => x.entity.type === 'event');
  assert.equal(ev.raw.t, '2020-01-02T03:04:05'); assert.equal(ev.raw.zoneStated, false);
  const w = await runFile(put('w.jpg', X.buildExifJpeg({ lat: 40.7128, lon: -74.006 })));
  assert.ok(find(w, 'place', '40.7128,-74.006'));
  const none = await runFile(put('plain.jpg', X.buildExifJpeg({})));
  assert.equal(none.results.length, 1); assert.equal(none.results[0].entity.type, 'image');
});
test('exif-meta PNG and PDF', async () => {
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32, 0); ihdr.writeUInt32BE(16, 4);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Software\0Paint 1')), chunk('tEXt', Buffer.from('Author\0Zed Fixture-Person')), chunk('tIME', Buffer.from([0x07, 0xe8, 6, 7, 8, 9, 10])), chunk('IEND', Buffer.alloc(0))]);
  const p = await runFile(put('pic.png', png));
  assert.equal(p.status, 'ok'); valid(p, 'exif-meta');
  const img = find(p, 'image', 'pic.png');
  assert.equal(img.raw.width, 32); assert.equal(img.raw.height, 16); assert.equal(img.raw.software, 'Paint 1'); assert.deepEqual(img.raw.personalFieldsWithheld, ['Author']);
  assert.equal(p.results.find((x) => x.entity.type === 'event').raw.t, '2024-06-07T08:09:10Z');
  assert.ok(!/Zed/.test(text(p)));
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Title (Fixture doc) /Author (Zed Fixture-Person) /Creator (Writer 1) /Producer (PDF \\(Lib\\) 2) /CreationDate (D:20240102030405+01\'00\') >>\nendobj\ntrailer\n');
  const d = await runFile(put('doc.pdf', pdf));
  assert.equal(d.status, 'ok'); valid(d, 'exif-meta');
  const doc = find(d, 'document', 'doc.pdf');
  assert.equal(doc.confidence, 'confirmed'); assert.equal(doc.raw.creator, 'Writer 1'); assert.equal(doc.raw.producer, 'PDF (Lib) 2'); assert.deepEqual(doc.raw.personalFieldsWithheld, ['Author']);
  const ev = d.results.find((x) => x.entity.type === 'event');
  assert.equal(ev.confidence, 'likely'); assert.equal(ev.raw.t, '2024-01-02T02:04:05.000Z');
  assert.ok(!/Zed/.test(text(d)));
});
test('exif-meta: damaged, unsupported, missing and non-file inputs fail cleanly', async () => {
  const good = X.buildExifJpeg({ make: 'Acme', lat: 1, lon: 2 });
  const cut = await runFile(put('cut.jpg', good.subarray(0, 40)));
  assert.equal(cut.status, 'ok'); assert.equal(cut.results[0].entity.type, 'image');
  const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20]), Buffer.from('Exif\0\0'), Buffer.from('MM\0*\xff\xff\xff\xff', 'latin1'), Buffer.alloc(40, 0xff)]);
  assert.equal((await runFile(put('junk.jpg', junk))).status, 'ok');
  assert.equal((await runFile(put('notes.txt', Buffer.from('just words')))).status, 'bad-input');
  assert.equal((await runFile(path.join(tmp(), 'nope.jpg'))).status, 'bad-input');
  assert.equal((await runFile(tmp())).status, 'bad-input');
  assert.equal((await mods.runModule('exif-meta', {}, {})).status, 'bad-input');
  const sc = await mods.runModule('exif-meta', { check: 'parser' }, { now: () => NOW });
  assert.equal(sc.status, 'ok'); assert.equal(sc.results.length, 1); assert.equal(sc.results[0].entity.value, 'self-check-sample'); assert.equal(sc.results[0].raw.selfCheck, true);
});

// ---------------- the hard line, honesty and shipped content ----------------
test('hard line and the egress rules are visible in the code', () => {
  const root = path.join(__dirname, '..', 'src/main/ghost');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'samples') walk(p); } else if (/\.(js|json)$/.test(e.name) && /modules|node-runner/.test(p)) files.push(p); } };
  walk(root);
  assert.ok(files.length >= 28);
  const allHosts = new Set(['data.iana.org', 'opensource.org', 'github.com', 'exiftool.org', 'mediaarea.net', 'gdal.org', 'www.qgis.org', 'ffmpeg.org', 'www.apache.org', 'example.com', 'nvd.nist.gov', 'search.gleif.org', 'www.openstreetmap.org']);   // the licence links (and a sample address in a parser self-check) in manifests, never requested
  for (const m of mods.MODULES) for (const h of m.meta.hosts) allHosts.add(h);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/sherlock|maigret|blackbird|holehe|whatsmyname|people-?search|username enumer/i.test(src), f);
    assert.ok(!/\bClaude\b|Anthropic|\bAI[- ]generated|generated by (an )?AI|written by (an )?AI|language model/i.test(src), 'authorship wording in ' + f);
    assert.ok(!/child_process|\beval\(|new Function|shell:\s*true/.test(src.replace(/\/\/.*$/gm, '')) || /node-runner\/adapter\.js$|modules\/lib\/tool-run\.js$/.test(f), 'process APIs only in the adapter and the tool runner: ' + f);
    if (!/exif-parse/.test(f) && !/fixtures/.test(f)) for (const m of src.matchAll(/https:\/\/([a-z0-9.-]+)/g)) assert.ok(allHosts.has(m[1]), `host ${m[1]} in ${f} is not on any allowlist`);
  }
  assert.ok(!fs.readFileSync(path.join(root, 'modules/lib/wayback-cdx.js'), 'utf8').includes('/save'), 'no "save page now" call');
  // every request is made through the one client
  for (const f of files.filter((x) => /modules\/lib/.test(x) && !/core\.js$/.test(x))) assert.ok(!/\bfetch\(/.test(fs.readFileSync(f, 'utf8')), 'direct fetch in ' + f);
  assert.equal(trapHits, 0, 'no test touched the real network');
});
test('shipped connector folders: manifest, run.js and library copy; the test transport is never part of production output', () => {
  const dir = mods.materialize('dns-doh', tmp('mfd-mat-'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['connector.json', 'lib', 'run.js']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'lib')).sort(), ['core.js', 'dns-doh.js', 'runtime.js']);
  const run1 = fs.readFileSync(path.join(dir, 'run.js'), 'utf8');
  assert.equal(run1, "'use strict';\nrequire('./lib/runtime').main(require('./lib/dns-doh'));\n");
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'connector.json'), 'utf8'));
  assert.equal(validateManifest(man).ok, true);
  assert.deepEqual(man.command.args, ['run.js', '--domain={domain}', '--types={types}', '--provider={provider}']);
  assert.throws(() => mods.materialize('nope', tmp()), /unknown module/);
  const ex = mods.materialize('exif-meta', tmp('mfd-mat-'));
  assert.ok(fs.existsSync(path.join(ex, 'lib', 'exif-parse.js')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ex, 'connector.json'), 'utf8')).permissions, ['read-picked-file']);
});
