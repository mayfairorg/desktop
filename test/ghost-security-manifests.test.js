'use strict';
// Manifests, licences, scope, hard-line and packaging rules for the security connectors.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/main/ghost/manifest');
const SEC = path.join(__dirname, '..', 'src', 'main', 'ghost', 'connectors-security');
const BASE = path.join(SEC, 'connectors');
const ids = fs.readdirSync(BASE).sort();
const man = (id) => JSON.parse(fs.readFileSync(path.join(BASE, id, 'connector.json'), 'utf8'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

const LICENCE = {
  yara: ['BSD-3-Clause', 'separate-program'], 'sigma-match': ['LicenseRef-Mayfair-Proprietary', 'bundled'], subfinder: ['MIT', 'separate-program'], dnsx: ['MIT', 'separate-program'],
  amass: ['Apache-2.0', 'separate-program'], findomain: ['GPL-3.0-or-later', 'separate-program'], whatweb: ['GPL-2.0-only', 'separate-program'], testssl: ['GPL-2.0-only', 'separate-program'],
  nmap: ['LicenseRef-Nmap-NPSL', 'separate-program'], masscan: ['AGPL-3.0-only', 'separate-program'], 'zap-baseline': ['Apache-2.0', 'separate-program'], zeek: ['BSD-3-Clause', 'separate-program'],
  suricata: ['GPL-2.0-only', 'separate-program'], 'misp-client': ['AGPL-3.0-or-later', 'separate-program'], 'opencti-client': ['Apache-2.0', 'separate-program'],
  'opensearch-client': ['Apache-2.0', 'separate-program'], 'neo4j-client': ['GPL-3.0-only', 'separate-program'], spiderfoot: ['MIT', 'separate-program'], 'recon-ng': ['GPL-3.0-only', 'separate-program'],
  theharvester: ['GPL-2.0-only', 'separate-program'], bbot: ['AGPL-3.0-only', 'separate-program'], 'bbot-active': ['AGPL-3.0-only', 'separate-program'], photon: ['GPL-3.0-only', 'separate-program'],
  openosint: ['NOASSERTION', 'separate-program'],
};
const ACTIVE = ['whatweb', 'testssl', 'nmap', 'masscan', 'zap-baseline', 'bbot-active', 'photon'];

test('all manifests are valid, named after their folder, with the files they declare', () => {
  assert.equal(ids.length, 24);
  assert.deepEqual(ids, Object.keys(LICENCE).sort());
  for (const id of ids) {
    const r = M.validateManifest(man(id));
    assert.ok(r.ok, id + ': ' + (r.errors || []).join('; '));
    assert.equal(man(id).id, id);
    for (const f of ['connector.json', 'run.js', 'common.js', 'tool.js']) assert.ok(fs.existsSync(path.join(BASE, id, f)), `${id}/${f}`);
  }
});
test('licence {spdx,url,mode} is as audited; strong copyleft, NPSL and AGPL are only ever separate programs', () => {
  for (const id of ids) {
    const l = man(id).licence;
    assert.deepEqual([l.spdx, l.mode], LICENCE[id], id);
    assert.match(l.url, /^https:\/\//);
    if (/GPL|NPSL|AGPL/.test(l.spdx)) assert.equal(l.mode, 'separate-program', id);
  }
  assert.equal(man('nmap').licence.url, 'https://nmap.org/npsl/');
  assert.deepEqual(ids.filter((i) => man(i).licence.mode === 'bundled'), ['sigma-match'], 'only Mayfair\'s own JavaScript matcher is bundled');
  assert.match(man('sigma-match').externalRestrictions, /Detection Rule License/);
});
test('no program is bundled: connector folders hold only .json and .js files', () => {
  for (const f of walk(BASE)) assert.match(f, /\.(json|js)$/, f);
  for (const f of walk(BASE)) assert.ok(fs.statSync(f).size < 120 * 1024, f);
  const { CATALOG } = require(path.join(SEC, 'catalog'));
  for (const id of ['nmap', 'masscan', 'zap-baseline', 'bbot', 'bbot-active', 'findomain']) assert.ok(CATALOG[id], id);
  for (const c of Object.values(CATALOG)) for (const p of Object.values(c.platforms)) assert.ok(!/mayfair/i.test(p.url), 'Mayfair never mirrors a catalog download: ' + p.url);
  assert.deepEqual(Object.keys(CATALOG.nmap.platforms), ['win32-x64'], 'Nmap: only the project\'s own Windows archive; otherwise use your own copy');
});
test('active tools: scope "active" with one host target, never local or passive; passive tools never take a target to scan', () => {
  assert.deepEqual(ids.filter((i) => man(i).scope === 'active').sort(), [...ACTIVE].sort());
  for (const id of ACTIVE) {
    const m = man(id);
    assert.notEqual(m.network, 'local');
    const t = m.input.fields.find((f) => f.name === 'target');
    assert.equal(t && t.type, 'url-host', id);                    // the manager ties the declaration to this field
    assert.equal(t.required !== false, true);
    assert.equal(m.selfTest.input.target, 'localhost');           // self-test never contacts anything but a version command
    assert.match(m.externalRestrictions, /never routed through Tor/);
    assert.match(m.externalRestrictions, /audit log/);
  }
  for (const id of ids.filter((i) => !ACTIVE.includes(i))) assert.ok(!man(id).input.fields.some((f) => f.name === 'target'), id);
});
test('active tools are never routed through Tor or any proxy: no proxy argument, no proxy variable', async () => {
  const common = require(path.join(BASE, 'nmap', 'common.js'));
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1'; process.env.ALL_PROXY = 'socks5://127.0.0.1:9050'; process.env.http_proxy = 'x';
  try { const e = common.toolEnv('/tmp'); assert.ok(!Object.keys(e).some((k) => /proxy/i.test(k)), JSON.stringify(Object.keys(e))); }
  finally { delete process.env.HTTPS_PROXY; delete process.env.ALL_PROXY; delete process.env.http_proxy; }
  const ctx = { runDir: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mfsec-')), resolveTarget: async () => ({ addresses: ['127.0.0.1'], v4: '127.0.0.1', pinned: '127.0.0.1' }) };
  for (const id of ACTIVE) {
    const t = require(path.join(BASE, id, 'tool.js'));
    const input = { ...t.normalizeInput({}), target: 'localhost' };
    const plan = await t.buildArgs(input, ctx);
    for (const a of plan.argv) assert.doesNotMatch(String(a), /^(--?proxy|-x$|--proxies|--socks|--tor|proxychains|--http-proxy|--https-proxy)/i, id + ' ' + a);
  }
  fs.rmSync(ctx.runDir, { recursive: true, force: true });
  for (const f of walk(SEC).filter((x) => x.endsWith('.js') && !x.endsWith('test.js'))) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /socks|torify|proxychains|HTTPS?_PROXY|ALL_PROXY|setGlobalDispatcher|ProxyAgent/i, f);
    assert.doesNotMatch(src, /shell:\s*true|child_process['"]\)\.exec\b|\beval\(|new Function/, f);
  }
});
test('the active self-test is only a version command (declaring localhost does not trigger a scan)', async () => {
  for (const id of ACTIVE) assert.equal(man(id).selfTest.input.action, 'selftest');
});
test('hard line: nothing for person or account lookup, no paid or capped service, no personal-data input fields', () => {
  const BAN = /sherlock|maigret|blackbird|holehe|whatsmyname|gallery-dl|shodan|censys|virustotal|abuseipdb|haveibeenpwned|\bhibp\b|maltego|people-?search|pimeyes|username-?search/i;
  for (const id of ids) {
    assert.doesNotMatch(id, BAN);
    const m = JSON.stringify(man(id));
    assert.doesNotMatch(m.replace(/people, social profiles|people and social/gi, ''), BAN, id);
    for (const f of man(id).input.fields) assert.doesNotMatch(f.name, /email|user|phone|person|name$|handle|profile|face|account/i, id + '.' + f.name);
  }
  for (const f of ['catalog.js', 'index.js', 'installer.js', 'instance-config.js', 'sync.js']) assert.doesNotMatch(fs.readFileSync(path.join(SEC, f), 'utf8'), BAN, f);
  const { CATALOG } = require(path.join(SEC, 'catalog'));
  for (const k of Object.keys(CATALOG)) assert.doesNotMatch(k, BAN);
});
test('no mention of AI authorship in shipped content', () => {
  for (const f of [...walk(SEC), ...walk(path.join(__dirname, 'fixtures', 'ghost-security'))]) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /\bclaude\b|anthropic|chatgpt|openai|gpt-?\d|ai[- ]generated|generated (by|with)|language model|\bllm\b|co-authored/i, f);
  }
});
test('copied helper and runner files match the shared sources (run node sync.js to fix)', () => {
  assert.deepEqual(require(path.join(SEC, 'sync.js')).sync({ check: true }), []);
});
test('catalog version regex and flags equal each connector\'s own SPEC', () => {
  const { CATALOG } = require(path.join(SEC, 'catalog'));
  for (const [id, c] of Object.entries(CATALOG)) {
    const { SPEC } = require(path.join(BASE, id, 'tool.js'));
    assert.deepEqual(c.versionArgs, SPEC.versionArgs, id);
    assert.equal(new RegExp(c.versionRe).source, SPEC.versionRe.source, id);
  }
});
test('instance adapters: network is the user\'s own instance, no key fields in the manifest, instance-config auth types match', () => {
  const ic = require(path.join(SEC, 'instance-config'));
  for (const id of Object.keys(ic.AUTH)) {
    const m = man(id);
    assert.equal(m.scope, 'passive');
    assert.ok(!m.input.fields.some((f) => /key|token|password|url/i.test(f.name)), 'secrets and the address never travel as inputs: ' + id);
    assert.ok(!m.input.fields.some((f) => f.sensitive));
    assert.deepEqual(require(path.join(BASE, id, 'tool.js')).SPEC.authTypes, ic.AUTH[id], id);
    assert.match(m.externalRestrictions, /nothing is bundled/);
    assert.ok(m.input.fields.find((f) => f.name === 'indicator').pattern && !new RegExp(m.input.fields.find((f) => f.name === 'indicator').pattern).test('someone@example.com'));
  }
});
test('person-lookup modules: every allowlist is clear of the denylists, every banned name is refused', () => {
  const sf = require(path.join(BASE, 'spiderfoot', 'tool.js'));
  for (const list of Object.values(sf.PRESETS)) for (const m of list) assert.doesNotMatch(m, sf.DENIED_MODULE, m);
  for (const bad of ['sfp_accounts', 'sfp_email', 'sfp_emailformat', 'sfp_haveibeenpwned', 'sfp_phone', 'sfp_pgp', 'sfp_names', 'sfp_twitter', 'sfp_github', 'sfp_social', 'sfp_username', 'sfp_pastebin', 'sfp_hunter']) assert.match(bad, sf.DENIED_MODULE, bad);
  for (const bad of ['EMAILADDR', 'PHONE_NUMBER', 'HUMAN_NAME', 'USERNAME', 'SOCIAL_MEDIA', 'ACCOUNT_EXTERNAL_OWNED']) assert.match(bad, sf.PERSON_EVENTS, bad);
  assert.throws(() => sf.normalizeInput({ preset: 'sfp_accounts', domain: 'example.com' }), /preset must be/);
  const rn = require(path.join(BASE, 'recon-ng', 'tool.js'));
  for (const p of Object.values(rn.MODULES)) { assert.doesNotMatch(p, rn.DENIED_PATH, p); assert.match(p, /^recon\/domains-hosts\//); }
  for (const bad of ['recon/profiles-profiles/namechk', 'recon/profiles-profiles/profiler', 'recon/contacts-contacts/unmask_gender', 'recon/domains-contacts/whois_pocs', 'recon/contacts-credentials/hibp_breach', 'recon/domains-credentials/pwnedlist/account_creds', 'reporting/csv', 'exploitation/injection/command_injector', 'recon/domains-hosts/brute_hosts', 'recon/companies-contacts/bing_linkedin_cache']) assert.match(bad, rn.DENIED_PATH, bad);
  assert.throws(() => rn.normalizeInput({ module: 'recon/profiles-profiles/namechk', domain: 'example.com' }), /module must be/);
  assert.throws(() => rn.normalizeInput({ module: '__proto__', domain: 'example.com' }), /module must be/);
  const th = require(path.join(BASE, 'theharvester', 'tool.js'));
  for (const s of th.SOURCES) assert.doesNotMatch(s, th.DENIED_SOURCE, s);
  for (const bad of ['linkedin', 'twitter', 'hunter', 'shodan', 'censys', 'virustotal', 'github-code', 'bing', 'intelx', 'haveibeenpwned']) assert.match(bad, th.DENIED_SOURCE, bad);
  const bb = require(path.join(BASE, 'bbot', 'tool.js'));
  for (const p of bb.PRESETS) assert.doesNotMatch(p, bb.DENIED_PRESET);
  for (const bad of ['email-enum', 'username-enum', 'social', 'cloud-enum', 'kitchen-sink']) assert.match(bad, bb.DENIED_PRESET, bad);
  assert.throws(() => bb.normalizeInput({ preset: 'email-enum', domain: 'example.com' }), /preset must be/);
  assert.throws(() => require(path.join(BASE, 'bbot-active', 'tool.js')).normalizeInput({ preset: 'email-enum' }), /preset must be/);
});

test('every web address in the security connectors is on an explicit list (download hosts, licence pages, project pages)', () => {
  const allowed = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'nmap.org', 'spdx.org', 'mayfairmail.com', 'example.com', 'misp.lan', 'inst.lan']);
  for (const f of walk(SEC).filter((x) => /\.(js|json)$/.test(x))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) assert.ok(allowed.has(m[1].toLowerCase()), `${path.relative(SEC, f)}: unexpected host ${m[1]}`);
  }
});
