'use strict';
// Parsers for the security connectors, run on HAND-WRITTEN FIXTURES (test/fixtures/ghost-security/*.fixture.*, see README.txt there).
// They are not recordings of real tool runs. Every result is also pushed through the app's own result validator.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateResult } = require('../src/main/ghost/result');

const BASE = path.join(__dirname, '..', 'src', 'main', 'ghost', 'connectors-security', 'connectors');
const FIX = path.join(__dirname, 'fixtures', 'ghost-security');
const tool = (id) => require(path.join(BASE, id, 'tool.js'));
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const NOW = '2026-10-27T10:00:00.000Z';
function run(id, raw, input = {}, extra = {}, fn = 'parse') {
  const res = tool(id)[fn](raw, { now: NOW, input, ...extra });
  for (const r of res) { const v = validateResult(r, { connector: id, now: Date.parse(NOW) }); assert.ok(v.ok, `${id}: ${v.error} in ${JSON.stringify(r).slice(0, 200)}`); }
  return res;
}
const of = (res, type) => res.filter((r) => r.entity.type === type);
const vals = (res, type) => of(res, type).map((r) => r.entity.value);
const find = (res, type, sub) => of(res, type).find((r) => r.entity.value.includes(sub));

test('fixtures are labelled as fixtures', () => {
  assert.match(fx('README.txt'), /FIXTURES, NOT RECORDINGS/);
  for (const f of fs.readdirSync(FIX)) if (f !== 'README.txt') assert.match(f, /\.fixture\./, f);
});

test('every uncertain result in every parser carries a note (schema rule)', () => {
  const r = run('subfinder', fx('subfinder.fixture.jsonl'), { domain: 'example.com' });
  for (const x of r) if (x.confidence === 'uncertain') assert.ok(x.uncertaintyNote);
});

test('subfinder: source count sets confidence, wildcard stripped, off-domain refused and counted', () => {
  const r = run('subfinder', fx('subfinder.fixture.jsonl'), { domain: 'example.com' });
  assert.equal(find(r, 'subdomain', 'www.example.com').confidence, 'likely');
  assert.equal(find(r, 'subdomain', 'mail.example.com').confidence, 'uncertain');
  assert.equal(find(r, 'subdomain', 'dev.example.com').confidence, 'likely');
  assert.ok(!vals(r, 'subdomain').some((v) => v.includes('other.org') || v.startsWith('*')));
  assert.match(of(r, 'parse-warning')[0].entity.value, /^2 lines/);
  assert.ok(r.every((x) => x.confidence !== 'confirmed'), 'unresolved passive names are never confirmed');
});
test('findomain and amass: uncertain, deduplicated, bad lines counted', () => {
  const f = run('findomain', fx('findomain.fixture.txt'), { domain: 'example.com' });
  assert.deepEqual(vals(f, 'subdomain').sort(), ['api.example.com', 'mail.example.com', 'www.example.com']);
  assert.ok(of(f, 'subdomain').every((x) => x.confidence === 'uncertain'));
  assert.match(of(f, 'parse-warning')[0].entity.value, /^1 lines/);
  const a = run('amass', fx('amass.fixture.txt'), { domain: 'example.com' });
  assert.deepEqual(vals(a, 'subdomain').sort(), ['shop.example.com', 'vpn.example.com', 'www.example.com']);
  assert.deepEqual(find(a, 'subdomain', 'vpn').raw.sources, ['crtsh']);
  assert.equal(find(a, 'subdomain', 'shop').raw.relations[0].value, '93.184.216.35');
});
test('dnsx: records confirmed with their own timestamp, NXDOMAIN reported', () => {
  const r = run('dnsx', fx('dnsx.fixture.jsonl'), { domain: 'example.com' });
  assert.equal(of(r, 'dns-record').length, 6);
  assert.ok(vals(r, 'dns-record').includes('example.com A 93.184.216.34'));
  assert.equal(of(r, 'dns-record')[0].observedAt, '2026-10-27T09:00:00.123Z');
  assert.deepEqual(vals(r, 'dns-status'), ['nope.example.com NXDOMAIN']);
});

test('nmap: open ports confirmed, service names graded, -Pn does not claim the host is up', () => {
  const r = run('nmap', fx('nmap-gentle.fixture.xml'), { target: 'example.com' });
  assert.deepEqual(vals(r, 'open-port').sort(), ['93.184.216.34:443/tcp', '93.184.216.34:80/tcp', '93.184.216.34:8080/tcp']);
  assert.ok(of(r, 'open-port').every((x) => x.confidence === 'confirmed'));
  assert.equal(of(r, 'host-up').length, 0);
  assert.equal(find(r, 'service', ':80/').confidence, 'uncertain');
  assert.match(find(r, 'service', ':80/').uncertaintyNote, /port-number table/);
  assert.equal(find(r, 'service', ':443/').confidence, 'likely');
  assert.equal(find(r, 'service', ':8080/').confidence, 'uncertain');
  assert.equal(of(r, 'port-state')[0].confidence, 'uncertain');
  assert.match(vals(r, 'port-summary')[0], /96 closed/);
  assert.match(vals(r, 'scan-summary')[0], /1 IP address/);
  assert.equal(of(r, 'no-open-ports').length, 0);
  assert.equal(of(r, 'open-port')[0].observedAt, new Date(1790000009000).toISOString());
});
test('nmap: no open ports is uncertain, not "clean"; broken or hostile XML is refused', () => {
  const r = run('nmap', fx('nmap-none-open.fixture.xml'), { target: '10.0.0.9' });
  assert.equal(of(r, 'no-open-ports')[0].confidence, 'uncertain');
  assert.throws(() => tool('nmap').parse('<nmaprun><host></nmaprun>', {}), /not complete XML/);
  assert.throws(() => tool('nmap').parse('<other/>', {}), /nmaprun/);
  const bomb = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><nmaprun version="1"><host><address addr="1.2.3.4" addrtype="ipv4"/><ports><port protocol="tcp" portid="1"><state state="open"/><service name="&b;"/></port></ports></host></nmaprun>';
  const rb = run('nmap', bomb, { target: '1.2.3.4' });
  assert.ok(!JSON.stringify(rb).includes('aaaa'), 'entities are not expanded');
});
test('nmap: a changed resolution is reported', () => {
  const r = run('nmap', fx('nmap-gentle.fixture.xml'), { target: 'example.com' }, { plan: { pinned: { v4: '93.184.216.34', changed: true } } });
  assert.equal(of(r, 'target-resolution-changed')[0].confidence, 'uncertain');
});
test('masscan: list parsed, lost lines counted, empty is uncertain', () => {
  const r = run('masscan', fx('masscan.fixture.lst'), { target: '93.184.216.34' });
  assert.deepEqual(vals(r, 'open-port'), ['93.184.216.34:443/tcp', '93.184.216.34:22/tcp']);
  assert.match(of(r, 'parse-warning')[0].entity.value, /^1 lines/);
  assert.equal(of(run('masscan', '#masscan\n# end\n', {}), 'no-open-ports')[0].confidence, 'uncertain');
  assert.equal(of(run('masscan', 'open tcp 80 1.2.3.4 1790000000\n', {}), 'scan-incomplete')[0].confidence, 'uncertain');
});
test('masscan: ports and rate are capped', () => {
  const t = tool('masscan');
  assert.equal(t.expandPorts('1-100'), 100);
  assert.throws(() => t.expandPorts('1-101'), /at most 100/);
  assert.throws(() => t.expandPorts('0,80'), /between 1 and 65535/);
  assert.throws(() => t.expandPorts('80;ls'), /look like/);
  assert.throws(() => t.normalizeInput({ rate: '101' }), /1 to 100/);
});
test('whatweb: technologies graded, personal fields left out by design', () => {
  const r = run('whatweb', fx('whatweb.fixture.json'), { target: 'example.com' });
  assert.equal(find(r, 'web-technology', 'nginx 1.24.0').confidence, 'likely');
  assert.equal(find(r, 'web-technology', 'HTML5').confidence, 'uncertain');
  assert.equal(vals(r, 'ip-address')[0], '93.184.216.34');
  assert.equal(vals(r, 'web-title')[0], 'Example Domain');
  const all = JSON.stringify(r);
  assert.ok(!all.includes('someone@example.com') && !all.includes('A. Person') && !all.includes('UNITED STATES'));
  assert.match(vals(r, 'fields-omitted')[0], /Email.*Meta-Author/);
});
test('testssl: protocols, certificate, weaknesses graded, FATAL is uncertain', () => {
  const r = run('testssl', fx('testssl.fixture.json'), { target: 'example.com' });
  assert.deepEqual(vals(r, 'tls-protocol'), ['TLS 1.0 offered', 'TLS 1.2 offered', 'TLS 1.3 offered']);
  assert.equal(of(r, 'tls-certificate').length, 2);
  assert.equal(find(r, 'tls-weakness', 'BREACH').confidence, 'uncertain');
  assert.equal(find(r, 'tls-weakness', 'BREACH').raw.cve, 'CVE-2013-3587');
  assert.equal(find(r, 'tls-weakness', 'ROBOT').confidence, 'likely');
  assert.equal(of(r, 'scan-error')[0].confidence, 'uncertain');
  assert.match(vals(r, 'tls-summary')[0], /checks OK/);
  assert.throws(() => tool('testssl').parse('nope', {}), /readable JSON/);
});
test('zap: confidence maps from ZAP, false positives left out and counted, markup stripped', () => {
  const r = run('zap-baseline', fx('zap-report.fixture.json'), { target: 'example.com' });
  const w = of(r, 'web-alert');
  assert.equal(w.length, 4);
  assert.equal(find(r, 'web-alert', 'Content Security Policy').confidence, 'likely');
  assert.equal(find(r, 'web-alert', 'Anti-clickjacking').confidence, 'uncertain');
  assert.equal(find(r, 'web-alert', 'Anti-CSRF').confidence, 'confirmed');
  assert.ok(!JSON.stringify(r).includes('Dismissed thing'));
  assert.match(vals(r, 'scan-summary')[0], /1 marked false positive/);
  assert.ok(!/</.test(find(r, 'web-alert', 'Content Security').raw.solution));
  assert.match(tool('zap-baseline').planYaml({ target: 'example.com', scheme: 'https', port: 443 }, '/tmp/x'), /includePaths:\n\s+- "https:\/\/example\\\\\.com\/\.\*"/);
  assert.doesNotMatch(tool('zap-baseline').planYaml({ target: 'example.com', scheme: 'https', port: 443 }, '/tmp/x'), /activeScan/);
});

test('yara: matches with tags, quoted metadata and string offsets', () => {
  const r = run('yara', fx('yara.fixture.txt'), { file: '/tmp/sample with space.bin' });
  const m = of(r, 'yara-match');
  assert.deepEqual(m.map((x) => x.entity.value), ['mfselftest', 'OtherRule']);
  assert.deepEqual(m[0].raw.tags, ['test', 'demo']);
  assert.equal(m[0].raw.meta.author, 'Jane Doe');
  assert.equal(m[0].raw.meta.description, 'Demo, with comma');
  assert.equal(m[0].raw.matchedStrings, 2);
  assert.equal(m[0].raw.first[0].offset, 3);
  assert.match(of(r, 'parse-warning')[0].entity.value, /^1 lines/);
  assert.equal(of(run('yara', '', { file: '/x' }), 'yara-no-match')[0].confidence, 'uncertain');
});
test('zeek: records from JSON logs, notices likely, weird entries uncertain', () => {
  const r = run('zeek', { conn: fx('zeek-conn.fixture.log'), dns: fx('zeek-dns.fixture.log'), http: '', ssl: '', notice: fx('zeek-notice.fixture.log'), weird: fx('zeek-weird.fixture.log') });
  assert.equal(of(r, 'network-flow').length, 2);
  assert.ok(vals(r, 'network-flow').includes('192.168.1.5:51234 -> 93.184.216.34:443/tcp'));
  assert.equal(vals(r, 'dns-query')[0], 'example.com A -> 93.184.216.34');
  assert.equal(of(r, 'zeek-notice')[0].confidence, 'likely');
  assert.equal(vals(r, 'protocol-anomaly')[0], 'bad_HTTP_request (2x)');
  assert.equal(of(r, 'protocol-anomaly')[0].confidence, 'uncertain');
  assert.match(of(r, 'parse-warning')[0].entity.value, /^1 log lines/);
  assert.equal(of(run('zeek', {}), 'capture-summary')[0].confidence, 'uncertain');
});
test('suricata: alerts are likely (not proof), other events summarised, timestamps normalised', () => {
  const r = run('suricata', fx('suricata-eve.fixture.jsonl'));
  const a = of(r, 'ids-alert')[0];
  assert.match(a.entity.value, /sid 2100498.*192\.168\.1\.5:51234 -> 93\.184\.216\.34:80/);
  assert.equal(a.confidence, 'likely');
  assert.match(a.uncertaintyNote, /not proof/);
  assert.equal(a.observedAt, '2026-10-27T09:00:00.123Z');
  assert.equal(vals(r, 'dns-query')[0], 'example.com A');
  assert.equal(vals(r, 'tls-session')[0], 'example.com TLS 1.3');
  assert.equal(vals(r, 'events-not-listed')[0], '1 flow, 1 stats event(s) not turned into results');
  assert.match(of(r, 'parse-warning')[0].entity.value, /^1 lines/);
  assert.equal(of(run('suricata', ''), 'capture-summary')[0].confidence, 'uncertain');
});

test('instance adapters: hits graded by the platform\'s own flags, absence is uncertain', () => {
  const input = { kind: 'ip', indicator: '203.0.113.9' }, url = 'https://inst.lan';
  const ps = (id, f, inp = input) => run(id, { json: JSON.parse(fx(f)) }, inp, { url }, 'parseSearch');
  const m = ps('misp-client', 'misp-search.fixture.json');
  assert.equal(of(m, 'threat-intel-hit').length, 2);
  assert.equal(of(m, 'threat-intel-hit')[0].confidence, 'likely');
  assert.equal(of(m, 'threat-intel-hit')[1].confidence, 'uncertain');
  assert.equal(of(m, 'threat-intel-hit')[0].observedAt, new Date(1789000000000).toISOString());
  assert.equal(of(m, 'threat-intel-hit')[0].source.url, url);
  const c = ps('opencti-client', 'opencti-search.fixture.json');
  assert.deepEqual(of(c, 'threat-intel-hit').map((x) => x.confidence), ['likely', 'uncertain', 'uncertain']);
  const o = ps('opensearch-client', 'opensearch-search.fixture.json');
  assert.equal(of(o, 'search-hit')[0].confidence, 'likely');
  assert.equal(of(o, 'search-hit')[0].raw.fields.nested, '[object]');
  assert.match(vals(o, 'output-truncated')[0], /^29 more/);
  const n = ps('neo4j-client', 'neo4j-search.fixture.json', { kind: 'domain', indicator: 'bad.example.net', label: 'Domain', property: 'name' });
  assert.equal(of(n, 'graph-node')[0].confidence, 'confirmed');
  for (const [id, empty] of [['misp-client', { response: { Attribute: [] } }], ['opencti-client', { data: { stixCyberObservables: { edges: [] }, indicators: { edges: [] } } }], ['opensearch-client', { hits: { total: { value: 0 }, hits: [] } }], ['neo4j-client', { results: [{ columns: [], data: [] }], errors: [] }]]) {
    const r = run(id, { json: empty }, { kind: 'domain', indicator: 'a.example.com', label: 'D', property: 'p' }, { url }, 'parseSearch');
    assert.equal(of(r, 'no-record')[0].confidence, 'uncertain', id);
    assert.match(of(r, 'no-record')[0].uncertaintyNote, /not evidence/);
  }
  assert.throws(() => tool('neo4j-client').parseSearch({ json: { results: [], errors: [{ message: 'denied' }] } }, { input }), /refused/);
});
test('instance adapters: pings must look like the right product', () => {
  const p = (id, json, o = {}) => tool(id).parsePing({ json }, { url: 'https://x', ...o });
  assert.equal(p('misp-client', { version: '2.4.190' })[0].source.version, '2.4.190');
  assert.throws(() => p('misp-client', { nope: 1 }), /not like a MISP/);
  assert.equal(p('opencti-client', { data: { about: { version: '6.0.1' } } })[0].entity.value, 'reachable');
  assert.throws(() => p('opensearch-client', { version: { number: '7.10.2' } }), /not OpenSearch/);
  assert.equal(p('opensearch-client', { version: { number: '2.11.0', distribution: 'opensearch' } })[0].source.version, '2.11.0');
  assert.throws(() => p('neo4j-client', {}), /not like a Neo4j/);
});

test('spiderfoot: person events and person modules are discarded, never reported', () => {
  const r = run('spiderfoot', fx('spiderfoot.fixture.json'), { domain: 'example.com' });
  assert.equal(find(r, 'subdomain', 'www.example.com').confidence, 'likely');
  assert.equal(find(r, 'subdomain', 'old.example.com').confidence, 'uncertain');
  assert.equal(vals(r, 'ip-address')[0], '93.184.216.34');
  const all = JSON.stringify(r);
  assert.ok(!all.includes('someone@') && !all.includes('A. Person') && !all.includes('x.example.com'));
  assert.match(vals(r, 'fields-omitted')[0], /^3 person/);
  assert.match(vals(r, 'events-not-listed')[0], /^1 other/);
  assert.ok(r.filter((x) => !['fields-omitted', 'events-not-listed'].includes(x.entity.type)).every((x) => x.confidence !== 'confirmed'));
});
test('recon-ng and theHarvester: hosts only, uncertain; emails and people never reported', () => {
  const r = run('recon-ng', fx('recon-ng.fixture.txt'), { domain: 'example.com', module: 'hackertarget' });
  assert.deepEqual(vals(r, 'subdomain'), ['www.example.com', 'api.example.com']);
  assert.equal(of(run('recon-ng', 'nothing\n', { domain: 'example.com' }), 'no-record')[0].confidence, 'uncertain');
  const h = run('theharvester', fx('theharvester.fixture.json'), { domain: 'example.com' });
  assert.deepEqual(vals(h, 'subdomain'), ['www.example.com', 'dev.example.com']);
  assert.equal(vals(h, 'ip-address')[0], '93.184.216.34');
  assert.ok(!JSON.stringify(h).includes('someone@') && !JSON.stringify(h).includes('A Person'));
  assert.match(vals(h, 'fields-omitted')[0], /2 emails, 1 linkedin_people/);
});
test('bbot: passive results uncertain, person events dropped; active run grades non-name assets likely', () => {
  const p = run('bbot', fx('bbot.fixture.jsonl'), { domain: 'example.com' });
  assert.deepEqual(vals(p, 'subdomain'), ['www.example.com', 'api.example.com']);
  assert.deepEqual(vals(p, 'url'), ['https://www.example.com/']);
  assert.ok(p.filter((x) => !['fields-omitted', 'events-not-listed'].includes(x.entity.type)).every((x) => x.confidence !== 'confirmed'));
  assert.match(vals(p, 'fields-omitted')[0], /^2 person/);
  assert.match(vals(p, 'events-not-listed')[0], /^2 other/);
  assert.ok(!JSON.stringify(p).includes('someone'));
  const a = run('bbot-active', fx('bbot.fixture.jsonl'), { target: 'example.com' });
  assert.equal(of(a, 'url')[0].confidence, 'likely');
  assert.equal(find(a, 'subdomain', 'www').confidence, 'uncertain');
});
test('photon: same-host URLs only, other hosts counted, intel never read', () => {
  const r = run('photon', { internal: fx('photon-internal.fixture.txt'), scripts: fx('photon-scripts.fixture.txt'), external: fx('photon-external.fixture.txt'), files: '', intel: 'a@b.c' }, { target: 'example.com' });
  assert.deepEqual(vals(r, 'crawled-url'), ['https://example.com/', 'https://example.com/about']);
  assert.deepEqual(vals(r, 'script-url'), ['https://example.com/app.js']);
  assert.match(vals(r, 'external-links')[0], /^2 link/);
  assert.match(vals(r, 'events-not-listed')[0], /^1 URL/);
  assert.match(of(r, 'parse-warning')[0].entity.value, /^1 lines/);
  assert.ok(!JSON.stringify(r).includes('a@b.c') && !JSON.stringify(r).includes('evil.net'));
});
