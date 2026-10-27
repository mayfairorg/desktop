'use strict';
// End to end through the real ConnectorManager and JobRunner: approval, self-test, scope guard, argv, output parsing.
// The "tools" are STAND-IN programs written by this test (a small Node script that prints a hand-written fixture), installed the way the
// installer would record them. They prove our wrappers, argv, scope and parsing; they do not prove a real nmap/subfinder/... behaves like them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { context, tmp } = require('./ghost-helpers');
const SEC = path.join(__dirname, '..', 'src', 'main', 'ghost', 'connectors-security');
const FIX = path.join(__dirname, 'fixtures', 'ghost-security');
const instanceConfig = require(path.join(SEC, 'instance-config'));
const fx = (n) => path.join(FIX, n);
const isWin = process.platform === 'win32';

// how each stand-in delivers its fixture: stdout, or a file named by an argument, or files in a directory
const TOOLS = {
  subfinder: { v: ['-version'], out: 'Current Version: v2.6.6', fixture: 'subfinder.fixture.jsonl' },
  findomain: { v: ['--version'], out: 'findomain 9.0.4', fixture: 'findomain.fixture.txt' },
  amass: { v: ['-version'], out: 'v4.2.0', file: ['-o', 'amass.fixture.txt'] },
  dnsx: { v: ['-version'], out: 'Current Version: v1.2.1', fixture: 'dnsx.fixture.jsonl' },
  whatweb: { v: ['--version'], out: 'WhatWeb version 0.5.5 ( http://www.morningstarsecurity.com/research/whatweb )', prefix: ['--log-json=', 'whatweb.fixture.json'] },
  testssl: { v: ['--version'], out: '  testssl.sh       3.2.0 from https://testssl.sh/', file: ['--jsonfile', 'testssl.fixture.json'] },
  nmap: { v: ['--version'], out: 'Nmap version 7.95 ( https://nmap.org )', fixture: 'nmap-gentle.fixture.xml' },
  masscan: { v: ['--version'], out: 'Masscan version 1.3.2 ( https://github.com/robertdavidgraham/masscan )', file: ['-oL', 'masscan.fixture.lst'] },
  'zap-baseline': { v: ['-version'], out: '2.16.0', zap: 'zap-report.fixture.json' },
  zeek: { v: ['--version'], out: 'zeek version 7.0.3', dirfiles: { cwd: true, files: { 'conn.log': 'zeek-conn.fixture.log', 'dns.log': 'zeek-dns.fixture.log' } } },
  suricata: { v: ['-V'], out: 'This is Suricata version 7.0.5 RELEASE', dirfiles: { flag: '-l', files: { 'eve.json': 'suricata-eve.fixture.jsonl' } } },
  yara: { v: ['--version'], out: '4.5.2', yara: true },
  spiderfoot: { v: ['-V'], out: 'SpiderFoot 4.0.0: Open Source Intelligence Automation.', fixture: 'spiderfoot.fixture.json' },
  'recon-ng': { v: ['--version'], out: 'Recon-ng v5.1.2', fixture: 'recon-ng.fixture.txt' },
  theharvester: { v: ['-h'], out: 'theHarvester 4.6.0', basejson: ['-f', 'theharvester.fixture.json'] },
  bbot: { v: ['--version'], out: 'v2.1.0', fixture: 'bbot.fixture.jsonl' },
  'bbot-active': { v: ['--version'], out: 'v2.1.0', fixture: 'bbot.fixture.jsonl' },
  photon: { v: ['-h'], out: 'Photon v1.3.0', dirfiles: { flag: '-o', files: { 'internal.txt': 'photon-internal.fixture.txt', 'scripts.txt': 'photon-scripts.fixture.txt', 'external.txt': 'photon-external.fixture.txt' } } },
};
const STAND_IN = (specPath, logPath) => `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const spec = JSON.parse(fs.readFileSync(${JSON.stringify(specPath)}, 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(argv) + '\\n');
const fx = (n) => fs.readFileSync(path.join(${JSON.stringify(FIX)}, n), 'utf8');
if (JSON.stringify(argv) === JSON.stringify(spec.v)) { console.log(spec.out); process.exit(0); }
if (spec.yara) { const f = argv[argv.length - 2], s = fs.readFileSync(argv[argv.length - 1], 'utf8'); if (s.includes('mayfair-selftest-marker') && argv.length === 3) console.log('mfselftest ' + argv[argv.length - 1]); else console.log(fx('yara.fixture.txt').split('/tmp/sample with space.bin').join(argv[argv.length - 1])); process.exit(0); }
if (spec.fixture) process.stdout.write(fx(spec.fixture));
if (spec.file) fs.writeFileSync(argv[argv.indexOf(spec.file[0]) + 1], fx(spec.file[1]));
if (spec.prefix) fs.writeFileSync(argv.find((a) => a.startsWith(spec.prefix[0])).slice(spec.prefix[0].length), fx(spec.prefix[1]));
if (spec.basejson) fs.writeFileSync(argv[argv.indexOf(spec.basejson[0]) + 1] + '.json', fx(spec.basejson[1]));
if (spec.zap) { const plan = fs.readFileSync(argv[argv.indexOf('-autorun') + 1], 'utf8'); const dir = JSON.parse(/reportDir: (".*")/.exec(plan)[1]); fs.writeFileSync(path.join(dir, 'zap-report.json'), fx(spec.zap)); }
if (spec.dirfiles) { const dir = spec.dirfiles.cwd ? process.cwd() : argv[argv.indexOf(spec.dirfiles.flag) + 1]; fs.mkdirSync(dir, { recursive: true }); for (const [n, f] of Object.entries(spec.dirfiles.files)) fs.writeFileSync(path.join(dir, n), fx(f)); }
`;

// Records a stand-in the way the installer does (install.json with a passed self-test and the program's SHA-256).
function installStandIn(root, id) {
  const t = TOOLS[id];
  const dir = path.join(root, 'ghost', 'tools', id, 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  const specPath = path.join(dir, 'spec.json'), logPath = path.join(root, `argv-${id}.log`), exe = path.join(dir, 'tool.js');
  fs.writeFileSync(specPath, JSON.stringify(t));
  fs.writeFileSync(exe, STAND_IN(specPath, logPath));
  fs.writeFileSync(logPath, '');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  fs.writeFileSync(path.join(root, 'ghost', 'tools', id, 'install.json'), JSON.stringify({ status: 'installed', tool: id, version: '0.0.0', exe: 'pkg/tool.js', exeSha256: sha, installedAt: new Date().toISOString(), launcher: [process.execPath], selfTest: { passed: true, t: new Date().toISOString(), detail: 'stand-in' } }));
  return { logPath, exe };
}
const argvLog = (root, id) => fs.readFileSync(path.join(root, `argv-${id}.log`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function ready(c, id) {
  const r = c.manager.register(path.join(SEC, 'connectors', id));
  assert.ok(r.ok, JSON.stringify(r));
  await c.manager.requestApproval(id);
  c.manager.enable(id);
  return id;
}
const scopeFor = (target) => ({ target, confirmedAuthorised: true });
async function selfTest(c, id, active) { return c.manager.test(id, active ? scopeFor('localhost') : undefined); }
async function runJob(c, id, input, scope) {
  const s = c.runner.submit({ connector: id, input, scope });
  assert.ok(s.ok, JSON.stringify(s));
  return c.runner.wait(s.jobId);
}
const types = (job) => job.results.map((r) => r.entity.type);
const ACTIVE = ['whatweb', 'testssl', 'nmap', 'masscan', 'zap-baseline', 'bbot-active', 'photon'];

test('nothing is installed or ready until the tool exists AND its self-test passes', { skip: isWin }, async () => {
  const c = context();
  for (const id of ['nmap', 'subfinder', 'yara']) {
    await ready(c, id);
    const e = c.manager.list().find((x) => x.id === id);
    assert.equal(e.install.installed, false);
    const t = await selfTest(c, id, id === 'nmap');
    assert.equal(t.passed, false);
    assert.match(t.lastTest.detail, /requirement not met/);
    assert.equal(c.manager.list().find((x) => x.id === id).install.installed, false);
  }
});

test('every connector with a stand-in tool passes its self-test through the manager, and only then shows as installed', { skip: isWin }, async () => {
  const c = context();
  for (const id of Object.keys(TOOLS)) {
    installStandIn(c.root, id);
    await ready(c, id);
    const t = await selfTest(c, id, ACTIVE.includes(id));
    assert.equal(t.passed, true, `${id}: ${t.lastTest && t.lastTest.detail}`);
    const e = c.manager.list().find((x) => x.id === id);
    assert.equal(e.install.installed, true, id);
    assert.equal(e.install.verified, 'tested');
    // the self-test only ran the version command (plus, for yara, a built-in rule on a built-in file): never a scan
    for (const a of argvLog(c.root, id)) assert.ok(!a.includes('localhost') && !a.includes('127.0.0.1'), `${id}: ${a}`);
  }
});

test('a tool that starts but is not the expected program fails its self-test', { skip: isWin }, async () => {
  const c = context();
  installStandIn(c.root, 'nmap');
  fs.writeFileSync(path.join(c.root, 'ghost', 'tools', 'nmap', 'pkg', 'spec.json'), JSON.stringify({ v: ['--version'], out: 'something else entirely' }));
  await ready(c, 'nmap');
  const t = await selfTest(c, 'nmap', true);
  assert.equal(t.passed, false);
  assert.match(t.lastTest.detail, /did not report a version we recognise|failed|exited/);
  assert.equal(c.manager.list().find((x) => x.id === 'nmap').install.installed, false);
});

test('a tool file changed after install is refused (hash re-checked on every run)', { skip: isWin }, async () => {
  const c = context();
  const { exe } = installStandIn(c.root, 'subfinder');
  await ready(c, 'subfinder');
  assert.equal((await selfTest(c, 'subfinder')).passed, true);
  fs.appendFileSync(exe, '\n// tampered\n');
  const job = await runJob(c, 'subfinder', { action: 'scan', domain: 'example.com' });
  assert.equal(job.status, 'failed');
  assert.match(job.error, /changed since it was installed/);
});

test('passive tools: run end to end with parsed, graded results', { skip: isWin }, async () => {
  const c = context();
  installStandIn(c.root, 'subfinder'); await ready(c, 'subfinder');
  const job = await runJob(c, 'subfinder', { action: 'scan', domain: 'example.com' });
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.rejected, 0);
  const www = job.results.find((r) => r.entity.value === 'www.example.com');
  assert.equal(www.confidence, 'likely');
  assert.equal(www.source.connector, 'subfinder');
  assert.deepEqual(argvLog(c.root, 'subfinder').pop().slice(0, 3), ['-d', 'example.com', '-json']);
  installStandIn(c.root, 'amass'); await ready(c, 'amass');
  const a = await runJob(c, 'amass', { action: 'scan', domain: 'example.com' });
  assert.equal(a.status, 'done', a.error);
  assert.ok(argvLog(c.root, 'amass').pop().includes('-passive'));
  assert.ok(!argvLog(c.root, 'amass').pop().some((x) => /^-(active|brute)$/.test(x)), 'passive only');
});

test('active tools: refused without a matching scope declaration, run with one, argv pins the address and has no scripts, proxy or elevation', { skip: isWin }, async () => {
  const c = context();
  installStandIn(c.root, 'nmap'); await ready(c, 'nmap');
  const s0 = c.runner.submit({ connector: 'nmap', input: { target: 'localhost' } });
  assert.equal(s0.error, 'scope-required');
  const s1 = c.runner.submit({ connector: 'nmap', input: { target: 'localhost' }, scope: scopeFor('example.com') });
  assert.equal(s1.error, 'scope-mismatch');
  assert.equal(argvLog(c.root, 'nmap').length, 0, 'the tool was never started');
  const job = await runJob(c, 'nmap', { target: 'localhost', preset: 'gentle' }, scopeFor('localhost'));
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.results.filter((r) => r.entity.type === 'open-port').length, 3);
  const argv = argvLog(c.root, 'nmap').pop();
  assert.deepEqual(argv.slice(-4), ['-oX', '-', '--', '127.0.0.1']);
  assert.ok(argv.includes('-sT') && !argv.some((x) => /^(-sS|-sU|-A|-O|--script|--privileged|-iL)/.test(x)), argv.join(' '));
  const audit = fs.readFileSync(path.join(c.root, 'ghost', 'audit.jsonl'), 'utf8');
  assert.match(audit, /"event":"run-requested"/);
  assert.match(audit, /"target":"localhost"/);
});

test('active tools: a range, wildcard or list as target never reaches the program', { skip: isWin }, async () => {
  const c = context();
  installStandIn(c.root, 'masscan'); await ready(c, 'masscan');
  for (const bad of ['10.0.0.0/24', '*.example.com', 'a.com,b.com', '0.0.0.0', '255.255.255.255', 'com']) {
    const s = c.runner.submit({ connector: 'masscan', input: { target: bad }, scope: scopeFor(bad) });
    if (s.ok) { const j = await c.runner.wait(s.jobId); assert.equal(j.status, 'failed', bad); } else assert.ok(['bad-input', 'scope-required'].includes(s.error), bad + ' ' + s.error);
  }
  assert.equal(argvLog(c.root, 'masscan').length, 0);
  const j = await runJob(c, 'masscan', { target: 'localhost', ports: '22,443', rate: 50 }, scopeFor('localhost'));
  assert.equal(j.status, 'done', j.error);
  const a = argvLog(c.root, 'masscan').pop();
  assert.ok(a.includes('127.0.0.1') && a[a.indexOf('--rate') + 1] === '50' && a[a.indexOf('-p') + 1] === '22,443', a.join(' '));
  const big = c.runner.submit({ connector: 'masscan', input: { target: 'localhost', ports: '1-500' }, scope: scopeFor('localhost') });
  assert.equal((await c.runner.wait(big.jobId)).status, 'failed');
  const fast = c.runner.submit({ connector: 'masscan', input: { target: 'localhost', rate: 1000 }, scope: scopeFor('localhost') });
  assert.equal(fast.error, 'bad-input');
});

test('masscan without raw sockets: honest failure, no elevation asked', { skip: isWin }, async () => {
  const c = context();
  const { exe } = installStandIn(c.root, 'masscan');
  const body = fs.readFileSync(exe, 'utf8').replace("const argv = process.argv.slice(2);", "const argv = process.argv.slice(2); if (argv.includes('-oL')) { process.stderr.write('FAIL: permission denied\\n'); process.exit(1); }");
  fs.writeFileSync(exe, body);
  const rec = path.join(c.root, 'ghost', 'tools', 'masscan', 'install.json');
  const j = JSON.parse(fs.readFileSync(rec, 'utf8')); j.exeSha256 = crypto.createHash('sha256').update(body).digest('hex'); fs.writeFileSync(rec, JSON.stringify(j));
  await ready(c, 'masscan');
  const job = await runJob(c, 'masscan', { target: 'localhost' }, scopeFor('localhost'));
  assert.equal(job.status, 'failed');
  assert.match(job.error, /raw sockets.*never asks for administrator/);
});

test('all other active tools run end to end and produce valid, graded results', { skip: isWin }, async () => {
  const c = context();
  const expect = { whatweb: ['web-technology', 3], testssl: ['tls-protocol', 3], 'zap-baseline': ['web-alert', 4], 'bbot-active': ['ip-address', 1], photon: ['external-links', 1] };
  for (const [id, [type, n]] of Object.entries(expect)) {
    installStandIn(c.root, id); await ready(c, id);
    const job = await runJob(c, id, { target: 'localhost' }, scopeFor('localhost'));
    assert.equal(job.status, 'done', `${id}: ${job.error}`);
    assert.equal(job.rejected, 0, id);
    assert.ok(job.results.filter((r) => r.entity.type === type).length >= n, `${id}: ${types(job)}`);
    assert.ok(job.results.every((r) => r.source.connector === id && r.observedAt && r.confidence));
  }
  const tls = argvLog(c.root, 'testssl').pop();
  assert.ok(tls.includes('--ip') && tls[tls.indexOf('--ip') + 1] === '127.0.0.1' && tls.at(-1) === 'localhost:443');
  const bbr = await runJob(c, 'bbot-active', { target: 'localhost' }, scopeFor('localhost'));
  assert.ok(!bbr.results.some((r) => r.entity.type === 'subdomain'), 'names outside the declared host are filtered out');
  const bb = argvLog(c.root, 'bbot-active').pop();
  assert.ok(bb.includes('--strict-scope') && bb[bb.indexOf('-ef') + 1] === 'aggressive,deadly' && !bb.includes('-rf'));
  const ww = argvLog(c.root, 'whatweb').pop();
  assert.ok(ww.includes('-a') && ww[ww.indexOf('-a') + 1] === '1' && ww.includes('--follow-redirect=never'));
});

test('person-lookup modules cannot be invoked: unknown fields, module names and presets are refused before any program starts', { skip: isWin }, async () => {
  const c = context();
  for (const id of ['spiderfoot', 'recon-ng', 'theharvester', 'bbot']) { installStandIn(c.root, id); await ready(c, id); }
  const tries = [
    ['spiderfoot', { domain: 'example.com', modules: 'sfp_accounts' }], ['spiderfoot', { domain: 'example.com', preset: 'sfp_accounts' }], ['spiderfoot', { domain: 'example.com', preset: 'infrastructure,sfp_email' }], ['spiderfoot', { domain: 'someone@example.com' }],
    ['recon-ng', { domain: 'example.com', module: 'recon/profiles-profiles/namechk' }], ['recon-ng', { domain: 'example.com', module: 'recon/contacts-contacts/unmask_gender' }], ['recon-ng', { domain: 'example.com', module: '../../reporting/csv' }],
    ['theharvester', { domain: 'example.com', sources: 'linkedin' }], ['theharvester', { domain: 'example.com', source: 'twitter' }], ['theharvester', { domain: 'someone@example.com' }],
    ['bbot', { domain: 'example.com', preset: 'email-enum' }], ['bbot', { domain: 'example.com', flags: 'social' }], ['bbot', { domain: 'example.com', module: 'emailformat' }],
  ];
  for (const [id, input] of tries) {
    const s = c.runner.submit({ connector: id, input: { action: 'scan', ...input } });
    assert.equal(s.ok, false, `${id} ${JSON.stringify(input)} was accepted`);
    assert.equal(s.error, 'bad-input');
  }
  for (const id of ['spiderfoot', 'recon-ng', 'theharvester', 'bbot']) assert.equal(argvLog(c.root, id).length, 0, id + ' was started');
  // the allowed runs pass only the fixed lists
  const sf = await runJob(c, 'spiderfoot', { action: 'scan', domain: 'example.com' });
  assert.equal(sf.status, 'done', sf.error);
  const sfArgv = argvLog(c.root, 'spiderfoot').pop();
  const mods = sfArgv[sfArgv.indexOf('-m') + 1].split(',');
  assert.ok(mods.length >= 2 && mods.every((m) => /^sfp_(crt|certspotter|hackertarget|dnsgrep|robtex|whois|bgpview)$/.test(m)), mods.join());
  assert.equal(sfArgv[sfArgv.indexOf('-u') + 1], 'passive');
  assert.ok(!JSON.stringify(sf.results).match(/someone@|A\. Person/));
  const th = await runJob(c, 'theharvester', { action: 'scan', domain: 'example.com' });
  assert.equal(th.status, 'done', th.error);
  const thArgv = argvLog(c.root, 'theharvester').pop();
  assert.equal(thArgv[thArgv.indexOf('-b') + 1], 'crtsh,hackertarget,rapiddns,anubis,threatminer,certspotter');
  assert.ok(!JSON.stringify(th.results).match(/someone@|other@|A Person/));
  const rn = await runJob(c, 'recon-ng', { action: 'scan', domain: 'example.com', module: 'hackertarget' });
  assert.equal(rn.status, 'done', rn.error);
  assert.equal(argvLog(c.root, 'recon-ng').pop()[argvLog(c.root, 'recon-ng').pop().indexOf('-m') + 1], 'recon/domains-hosts/hackertarget');
});

test('zeek, suricata, yara and sigma work on files you pick, offline', { skip: isWin }, async () => {
  const c = context();
  const pick = (f) => c.picks.add(f, fs.statSync(f).size);
  const pcap = path.join(tmp(), 'x.pcap'); fs.writeFileSync(pcap, 'not a real capture; the stand-in ignores it');
  installStandIn(c.root, 'zeek'); await ready(c, 'zeek');
  const z = await runJob(c, 'zeek', { pcap: pick(pcap) });
  assert.equal(z.status, 'done', z.error);
  assert.equal(z.results.filter((r) => r.entity.type === 'network-flow').length, 2);
  assert.ok(argvLog(c.root, 'zeek').pop().includes('-r') && !argvLog(c.root, 'zeek').pop().includes('-i'), 'offline read, never live capture');
  installStandIn(c.root, 'suricata'); await ready(c, 'suricata');
  const s = await runJob(c, 'suricata', { pcap: pick(pcap) });
  assert.equal(s.status, 'done', s.error);
  assert.equal(s.results.find((r) => r.entity.type === 'ids-alert').confidence, 'likely');
  const sa = argvLog(c.root, 'suricata').pop();
  assert.ok(sa.includes('-r') && !sa.includes('-i') && !sa.includes('-q') && !sa.includes('--af-packet'));
  installStandIn(c.root, 'yara'); await ready(c, 'yara');
  const rules = path.join(tmp(), 'r.yar'); fs.writeFileSync(rules, 'rule X { condition: true }');
  const y = await runJob(c, 'yara', { rules: pick(rules), file: pick(pcap) });
  assert.equal(y.status, 'done', y.error);
  assert.deepEqual(y.results.filter((r) => r.entity.type === 'yara-match').map((r) => r.entity.value), ['mfselftest', 'OtherRule']);
  // Sigma needs no tool at all
  await ready(c, 'sigma-match');
  assert.equal((await selfTest(c, 'sigma-match')).passed, true);
  assert.equal(c.manager.list().find((x) => x.id === 'sigma-match').install.installed, true);
  const dir = tmp();
  const rf = path.join(dir, 'rules.yml'), lf = path.join(dir, 'events.jsonl');
  fs.writeFileSync(rf, 'title: Whoami run\nid: 1111\nstatus: stable\nlevel: medium\nauthor: Test Author\nlicense: DRL-1.1\nfalsepositives:\n  - admins\ndetection:\n  sel:\n    Image|endswith: \\whoami.exe\n  condition: sel\n---\ntitle: Needs aggregation\ndetection:\n  sel:\n    a: 1\n  condition: sel | count() > 3\n');
  fs.writeFileSync(lf, '{"Image":"C:\\\\Windows\\\\System32\\\\WHOAMI.EXE","@timestamp":"2026-10-01T00:00:00Z"}\n{"Image":"C:\\\\x\\\\cmd.exe"}\nbroken\n');
  const sg = await runJob(c, 'sigma-match', { action: 'evaluate', rules: pick(rf), logs: pick(lf) });
  assert.equal(sg.status, 'done', sg.error);
  const m = sg.results.find((r) => r.entity.type === 'sigma-match');
  assert.equal(m.confidence, 'likely');
  assert.equal(m.raw.author, 'Test Author');
  assert.equal(m.raw.license, 'DRL-1.1');
  assert.equal(m.observedAt, '2026-10-01T00:00:00.000Z');
  assert.match(m.uncertaintyNote, /admins/);
  assert.equal(sg.results.find((r) => r.entity.type === 'sigma-rule-skipped').confidence, 'uncertain');
  assert.match(sg.results.find((r) => r.entity.type === 'sigma-summary').entity.value, /1 rules evaluated, 1 skipped, 2 events read, 1 matches/);
});

test('OpenOSINT placeholder can never run or show as installed', { skip: isWin }, async () => {
  const c = context();
  await ready(c, 'openosint');
  const t = await c.manager.test('openosint');
  assert.equal(t.passed, false);
  assert.equal(c.manager.list().find((x) => x.id === 'openosint').install.installed, false);
  const { ToolInstaller } = require(path.join(SEC, 'installer'));
  const inst = new ToolInstaller({ root: c.root, fetchImpl: async () => { throw new Error('must not fetch'); } });
  assert.equal((await inst.install('openosint', { licenceAccepted: true })).error, 'owner-url-missing');
  assert.match(require(path.join(SEC, 'connectors', 'openosint', 'tool.js')).NOT_DEFINED, /will not invent/);
});

// ---------- instance adapters against a local stand-in server ----------
function server(handler) {
  return new Promise((res) => { const seen = []; const s = http.createServer((req, rsp) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body: b }); handler(req, rsp, b); }); }); s.listen(0, '127.0.0.1', () => res({ s, seen, url: `http://127.0.0.1:${s.address().port}` })); });
}
const json = (rsp, o, code = 200) => { rsp.writeHead(code, { 'Content-Type': 'application/json' }); rsp.end(JSON.stringify(o)); };
const readJ = (n) => JSON.parse(fs.readFileSync(fx(n), 'utf8'));
const KEY = 'SECRET-KEY-do-not-log-1234567890';

test('MISP adapter: no instance configured is an honest failure; with one it pings, searches and never leaks the key', { skip: isWin }, async () => {
  const c = context();
  const srv = await server((req, rsp) => { if (req.url === '/servers/getVersion') return json(rsp, { version: '2.4.190' }); if (req.url === '/attributes/restSearch') return json(rsp, readJ('misp-search.fixture.json')); json(rsp, {}, 404); });
  try {
    await ready(c, 'misp-client');
    let t = await c.manager.test('misp-client');
    assert.equal(t.passed, false);
    assert.match(t.lastTest.detail, /requirement not met/);
    assert.equal(c.manager.list().find((x) => x.id === 'misp-client').install.installed, false);
    assert.equal(instanceConfig.save(c.root, 'misp-client', { version: 1, url: 'http://example.org', auth: { type: 'api-key', key: KEY } }).ok, false, 'plain http to a public host is refused');
    assert.equal(instanceConfig.save(c.root, 'misp-client', { version: 1, url: srv.url, auth: { type: 'bearer', token: KEY } }).ok, false, 'wrong auth type for MISP');
    const saved = instanceConfig.save(c.root, 'misp-client', { version: 1, url: srv.url, auth: { type: 'api-key', key: KEY } });
    assert.equal(saved.ok, true);
    assert.ok(!JSON.stringify(saved).includes(KEY), 'the saved result never echoes the key');
    assert.equal(fs.statSync(path.join(c.root, 'ghost', 'instances', 'misp-client.json')).mode & 0o077, 0, 'owner-only file');
    t = await c.manager.test('misp-client');
    assert.equal(t.passed, true, t.lastTest && t.lastTest.detail);
    assert.equal(c.manager.list().find((x) => x.id === 'misp-client').install.installed, true);
    const job = await runJob(c, 'misp-client', { action: 'search', kind: 'ip', indicator: '203.0.113.9' });
    assert.equal(job.status, 'done', job.error);
    assert.deepEqual(job.results.filter((r) => r.entity.type === 'threat-intel-hit').map((r) => r.confidence), ['likely', 'uncertain']);
    const call = srv.seen.find((x) => x.url === '/attributes/restSearch');
    assert.equal(call.headers.authorization, KEY);
    assert.equal(JSON.parse(call.body).value, '203.0.113.9');
    const everything = JSON.stringify(job) + JSON.stringify(c.runner.list({})) + fs.readFileSync(path.join(c.root, 'ghost', 'logs', 'ghost.log'), 'utf8');
    assert.ok(!everything.includes(KEY), 'the key is in no result, history or log');
    // refusals: person queries never reach the server
    const before = srv.seen.length;
    for (const bad of ['someone@example.com', '+44 20 7946 0958', '@handle', 'a b']) {
      const s = c.runner.submit({ connector: 'misp-client', input: { action: 'search', kind: 'domain', indicator: bad } });
      assert.equal(s.ok, false, bad); assert.equal(s.error, 'bad-input');
    }
    const wrongKind = await runJob(c, 'misp-client', { action: 'search', kind: 'ip', indicator: 'example.com' });
    assert.equal(wrongKind.status, 'failed');
    assert.equal(srv.seen.length, before);
    // other people on this computer must not be able to read the key
    fs.chmodSync(path.join(c.root, 'ghost', 'instances', 'misp-client.json'), 0o644);
    const lax = await runJob(c, 'misp-client', { action: 'search', kind: 'ip', indicator: '203.0.113.9' });
    assert.equal(lax.status, 'failed'); assert.match(lax.error, /chmod 600/);
  } finally { srv.s.close(); }
});
test('adapters: rejected credentials, wrong product and vault references are reported plainly', { skip: isWin }, async () => {
  const c = context();
  let mode = 'deny';
  const srv = await server((req, rsp) => { if (mode === 'deny') return json(rsp, { message: 'nope' }, 401); if (mode === 'es') return json(rsp, { version: { number: '7.10.2', distribution: 'elasticsearch' } }); json(rsp, { version: { number: '2.11.0', distribution: 'opensearch' }, cluster_name: 'c' }); });
  try {
    await ready(c, 'opensearch-client');
    instanceConfig.save(c.root, 'opensearch-client', { version: 1, url: srv.url, auth: { type: 'basic', username: 'u', password: KEY }, index: 'ioc-*' });
    let t = await c.manager.test('opensearch-client');
    assert.equal(t.passed, false); assert.match(t.lastTest.detail, /rejected the credentials/); assert.ok(!t.lastTest.detail.includes(KEY));
    mode = 'es';
    t = await c.manager.test('opensearch-client');
    assert.equal(t.passed, false); assert.match(t.lastTest.detail, /not OpenSearch/);
    mode = 'ok';
    t = await c.manager.test('opensearch-client');
    assert.equal(t.passed, true, t.lastTest.detail);
    instanceConfig.save(c.root, 'opensearch-client', { version: 1, url: srv.url, auth: { type: 'api-key', vaultRef: 'vault:opensearch' } });
    assert.equal(instanceConfig.describe(c.root, 'opensearch-client').usesVault, true);
    t = await c.manager.test('opensearch-client');
    assert.equal(t.passed, false);
    const vj = await runJob(c, 'opensearch-client', { action: 'ping' });
    assert.equal(vj.status, 'failed'); assert.match(vj.error, /Ghost vault/);
  } finally { srv.s.close(); }
});
test('OpenCTI, OpenSearch and Neo4j adapters send only their fixed queries', { skip: isWin }, async () => {
  const c = context();
  const srv = await server((req, rsp, body) => {
    if (req.url === '/graphql') return json(rsp, body.includes('about') ? { data: { about: { version: '6.0.1' } } } : readJ('opencti-search.fixture.json'));
    if (req.url.startsWith('/ioc-2026/_search')) return json(rsp, readJ('opensearch-search.fixture.json'));
    if (req.url === '/') return json(rsp, req.headers.authorization && req.headers.authorization.startsWith('Basic') ? { neo4j_version: '5.18.0', neo4j_edition: 'community' } : { version: { number: '2.11.0', distribution: 'opensearch' } });
    if (req.url === '/db/neo4j/tx/commit') return json(rsp, readJ('neo4j-search.fixture.json'));
    json(rsp, {}, 404);
  });
  try {
    const cfg = (auth, extra = {}) => ({ version: 1, url: srv.url, auth, ...extra });
    instanceConfig.save(c.root, 'opencti-client', cfg({ type: 'bearer', token: KEY }));
    instanceConfig.save(c.root, 'opensearch-client', cfg({ type: 'none' }, { index: 'ioc-2026' }));
    instanceConfig.save(c.root, 'neo4j-client', cfg({ type: 'basic', username: 'reader', password: KEY }));
    for (const id of ['opencti-client', 'opensearch-client', 'neo4j-client']) { await ready(c, id); assert.equal((await c.manager.test(id)).passed, true, id); }
    const ct = await runJob(c, 'opencti-client', { action: 'search', kind: 'ip', indicator: '203.0.113.9' });
    assert.equal(ct.status, 'done', ct.error);
    assert.equal(srv.seen.filter((x) => x.url === '/graphql').pop().headers.authorization, 'Bearer ' + KEY);
    assert.equal(JSON.parse(srv.seen.filter((x) => x.url === '/graphql').pop().body).variables.s, '203.0.113.9');
    const os_ = await runJob(c, 'opensearch-client', { action: 'search', kind: 'cve', indicator: 'CVE-2024-12345' });
    assert.equal(os_.status, 'done', os_.error);
    assert.equal(JSON.parse(srv.seen.filter((x) => x.url.includes('_search')).pop().body).query.multi_match.type, 'phrase');
    const ng = await runJob(c, 'neo4j-client', { action: 'search', kind: 'domain', indicator: 'bad.example.net', label: 'Domain', property: 'name' });
    assert.equal(ng.status, 'done', ng.error);
    const q = JSON.parse(srv.seen.filter((x) => x.url.includes('/tx/commit')).pop().body).statements[0];
    assert.match(q.statement, /^MATCH \(n:`Domain`\) WHERE .* RETURN .* LIMIT 25$/);
    assert.ok(!/DELETE|SET |CREATE|MERGE|REMOVE|CALL|LOAD/i.test(q.statement));
    assert.deepEqual(q.parameters, { v: 'bad.example.net' });
    for (const bad of ['Domain`) DETACH DELETE (n) //', 'a b', 'x;y']) { const s = c.runner.submit({ connector: 'neo4j-client', input: { action: 'search', kind: 'domain', indicator: 'a.example.com', label: bad, property: 'name' } }); assert.equal(s.ok, false, bad); }
    assert.ok(!(JSON.stringify(ng) + JSON.stringify(ct)).includes(KEY));
  } finally { srv.s.close(); }
});
