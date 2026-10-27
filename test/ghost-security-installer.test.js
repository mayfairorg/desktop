'use strict';
// Install on demand: download -> checksum -> unpack -> self-test -> only then "installed". The download host is a stand-in (a fake fetch); the
// "tools" in the archives are tiny scripts written here. No real host is contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { tmp } = require('./ghost-helpers');
const { ToolInstaller } = require('../src/main/ghost/connectors-security/installer');
const { CATALOG } = require('../src/main/ghost/connectors-security/catalog');
const isWin = process.platform === 'win32';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function tarGz(files, { symlink, evil } = {}) {
  const src = tmp('mfsec-src-'); const out = path.join(tmp('mfsec-tar-'), 'a.tgz');
  for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(src, n)), { recursive: true }); fs.writeFileSync(path.join(src, n), c, { mode: 0o755 }); }
  if (symlink) fs.symlinkSync('/etc/passwd', path.join(src, 'link'));
  execFileSync('tar', ['-czf', out, ...(evil ? ['--transform', 's,^,../,'] : []), '-C', src, '.']);
  return fs.readFileSync(out);
}
function zipStored(files) {   // a minimal ZIP writer (stored entries), enough for the extractor
  const parts = [], central = []; let off = 0;
  for (const [name, data] of Object.entries(files)) {
    const nb = Buffer.from(name), d = Buffer.from(data), crc = zlib.crc32(d);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(d.length, 18); lh.writeUInt32LE(d.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, d);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(d.length, 20); ch.writeUInt32LE(d.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(0o100755 << 16 >>> 0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, nb); off += 30 + nb.length + d.length;
  }
  const cd = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const script = (text) => `#!/bin/sh\necho "${text}"\n`;
const GOOD = script('Nmap version 7.95 ( https://nmap.org )');
const entry = (over = {}) => ({ tool: 'nmap', requestedVersion: '7.95', hosts: ['dl.example.test', 'cdn.example.test'], maxBytes: 5 * 1024 * 1024, verified: false, checksums: null, exeName: { default: 'nmap' }, versionArgs: ['--version'], versionRe: 'Nmap version (\\d+\\.\\d+[\\w.]*)', platforms: { 'linux-x64': { url: 'https://dl.example.test/nmap.tgz', file: 'nmap.tgz', archive: 'tar.gz', sha256: null } }, ...over });
// routes: url -> {body, status, headers} or an Error to throw
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('missing', { status: 404 });
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? null : r.body, { status: r.status || 200, headers: r.headers || {} });
  };
  f.calls = calls; return f;
}
const mkInstaller = (cat, routes, over = {}) => { const root = tmp('mfsec-root-'); const fetchImpl = fakeFetch(routes); return { root, fetchImpl, inst: new ToolInstaller({ root, catalog: { nmap: cat }, fetchImpl, platform: 'linux', arch: 'x64', ...over }) }; };
const unreachable = (code = 'ENOTFOUND') => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo'), { code }) });
const noRecordInstalled = async (inst) => assert.equal((await inst.status('nmap')).installed, false);

test('install: pinned checksum, unpack, self-test, then (and only then) installed', { skip: isWin }, async () => {
  const body = tarGz({ 'nmap-7.95/nmap': GOOD });
  const cat = entry(); cat.platforms['linux-x64'].sha256 = sha(body);
  const { inst, root } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': { body } });
  const steps = [];
  const r = await inst.install('nmap', { licenceAccepted: true, onProgress: (p) => steps.push(p.state) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([...new Set(steps)], ['checksum', 'downloading', 'extracting', 'testing', 'done']);
  assert.equal(r.status.installed, true);
  assert.equal(r.status.version, '7.95');
  assert.equal(r.status.source.verifiedBy, 'pinned');
  const rec = JSON.parse(fs.readFileSync(path.join(root, 'ghost', 'tools', 'nmap', 'install.json'), 'utf8'));
  assert.equal(rec.status, 'installed'); assert.equal(rec.selfTest.passed, true);
  assert.equal(rec.exeSha256, sha(fs.readFileSync(path.join(root, 'ghost', 'tools', 'nmap', rec.exe))));
  assert.ok(!fs.existsSync(path.join(root, 'ghost', 'tools', '.staging')) || fs.readdirSync(path.join(root, 'ghost', 'tools', '.staging')).length === 0, 'staging is cleaned up');
  // a changed program is no longer "installed"
  fs.appendFileSync(path.join(root, 'ghost', 'tools', 'nmap', rec.exe), '# x');
  const st = await inst.status('nmap');
  assert.equal(st.installed, false); assert.equal(st.state, 'changed');
});
test('install: the licence must be accepted first; nothing is fetched otherwise', async () => {
  const { inst, fetchImpl } = mkInstaller(entry(), {});
  assert.equal((await inst.install('nmap', {})).error, 'licence-not-accepted');
  assert.equal((await inst.install('nmap', { licenceAccepted: 'yes' })).error, 'licence-not-accepted');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal((await inst.install('../etc', { licenceAccepted: true })).error, 'unknown-tool');
});
test('download host unreachable: says so, names the host, installs nothing', async () => {
  const cat = entry(); cat.platforms['linux-x64'].sha256 = 'a'.repeat(64);
  for (const code of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT']) {
    const { inst, root } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': unreachable(code) });
    const r = await inst.install('nmap', { licenceAccepted: true });
    assert.equal(r.ok, false); assert.equal(r.error, 'host-unreachable'); assert.equal(r.host, 'dl.example.test');
    assert.match(r.message, /Could not reach dl\.example\.test.*Nothing was downloaded or installed/);
    await noRecordInstalled(inst);
    assert.ok(!fs.existsSync(path.join(root, 'ghost', 'tools', 'nmap', 'pkg')));
    assert.equal((await inst.status('nmap')).state, 'failed');
  }
});
test('blocked or failing host (HTTP 403, 500) is reported with the status', async () => {
  const cat = entry(); cat.platforms['linux-x64'].sha256 = 'a'.repeat(64);
  for (const status of [403, 500]) {
    const { inst } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': { status, body: 'no' } });
    const r = await inst.install('nmap', { licenceAccepted: true });
    assert.equal(r.error, 'download-failed'); assert.equal(r.status, status); assert.match(r.message, new RegExp('HTTP ' + status));
    await noRecordInstalled(inst);
  }
});
test('checksum mismatch: deleted, not installed', { skip: isWin }, async () => {
  const body = tarGz({ nmap: GOOD });
  const cat = entry(); cat.platforms['linux-x64'].sha256 = sha(Buffer.from('something else'));
  const { inst, root } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': { body } });
  const r = await inst.install('nmap', { licenceAccepted: true });
  assert.equal(r.error, 'checksum-mismatch');
  await noRecordInstalled(inst);
  assert.ok(!fs.existsSync(path.join(root, 'ghost', 'tools', 'nmap', 'pkg')));
});
test('no pinned checksum and none published: refused before any download', async () => {
  const { inst, fetchImpl } = mkInstaller(entry(), { 'https://dl.example.test/nmap.tgz': { body: 'x' } });
  const r = await inst.install('nmap', { licenceAccepted: true });
  assert.equal(r.error, 'no-checksum'); assert.equal(fetchImpl.calls.length, 0);
  assert.match(r.message, /will not install it/);
});
test('upstream checksum file is used when nothing is pinned, and recorded as such', { skip: isWin }, async () => {
  const body = tarGz({ nmap: GOOD });
  const cat = entry({ checksums: { url: 'https://dl.example.test/sums.txt' } });
  const sums = `${'0'.repeat(64)}  other.tgz\n${sha(body)}  nmap.tgz\n`;
  const { inst } = mkInstaller(cat, { 'https://dl.example.test/sums.txt': { body: sums }, 'https://dl.example.test/nmap.tgz': { body } });
  const r = await inst.install('nmap', { licenceAccepted: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status.source.verifiedBy, 'upstream-checksum-file');
  const { inst: i2 } = mkInstaller(entry({ checksums: { url: 'https://dl.example.test/sums.txt' } }), { 'https://dl.example.test/sums.txt': { body: `${'1'.repeat(64)}  elsewhere.tgz\n` } });
  assert.equal((await i2.install('nmap', { licenceAccepted: true })).error, 'no-checksum');
});
test('self-test failure: verified download but wrong program is NOT installed, and a working install is kept', { skip: isWin }, async () => {
  const good = tarGz({ nmap: GOOD }), bad = tarGz({ nmap: script('definitely not the tool') });
  const routes = { 'https://dl.example.test/nmap.tgz': { body: good } };
  const cat = entry(); cat.platforms['linux-x64'].sha256 = sha(good);
  const { inst, root } = mkInstaller(cat, routes);
  assert.equal((await inst.install('nmap', { licenceAccepted: true })).ok, true);
  cat.platforms['linux-x64'].sha256 = sha(bad); routes['https://dl.example.test/nmap.tgz'] = { body: bad };
  const r = await inst.install('nmap', { licenceAccepted: true });
  assert.equal(r.error, 'selftest-failed'); assert.match(r.message, /NOT installed/);
  const st = await inst.status('nmap');
  assert.equal(st.installed, true, 'the previous good install is untouched'); assert.equal(st.version, '7.95');
  assert.ok(!fs.existsSync(path.join(root, 'ghost', 'tools', 'nmap', 'pkg.prev')));
  // first install ever with a bad program: no installed record
  const { inst: i3 } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': { body: bad } });
  const r3 = await i3.install('nmap', { licenceAccepted: true });
  assert.equal(r3.error, 'selftest-failed');
  await noRecordInstalled(i3);
  assert.equal((await i3.status('nmap')).state, 'failed');
});
test('a program that cannot start fails the self-test too', { skip: isWin }, async () => {
  const body = tarGz({ nmap: '\x7fELF-not-really' });
  const cat = entry(); cat.platforms['linux-x64'].sha256 = sha(body);
  const { inst } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': { body } });
  const r = await inst.install('nmap', { licenceAccepted: true });
  assert.equal(r.error, 'selftest-failed');
  await noRecordInstalled(inst);
});
test('redirects: only to allowed https hosts', async () => {
  const cat = entry(); cat.platforms['linux-x64'].sha256 = 'a'.repeat(64);
  for (const loc of ['https://evil.example.test/x', 'http://dl.example.test/x']) {
    const { inst, fetchImpl } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': { status: 302, headers: { location: loc } } });
    const r = await inst.install('nmap', { licenceAccepted: true });
    assert.ok(['host-not-allowed', 'bad-url'].includes(r.error), r.error);
    assert.equal(fetchImpl.calls.length, 1);
  }
});
test('redirect to an allowed host is followed', { skip: isWin }, async () => {
  const body = tarGz({ nmap: GOOD });
  const cat = entry(); cat.platforms['linux-x64'].sha256 = sha(body);
  const { inst } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': { status: 302, headers: { location: 'https://cdn.example.test/blob' } }, 'https://cdn.example.test/blob': { body } });
  assert.equal((await inst.install('nmap', { licenceAccepted: true })).ok, true);
});
test('size limits and unsafe archives are refused', { skip: isWin }, async () => {
  const body = tarGz({ nmap: GOOD });
  const cat = entry({ maxBytes: 100 }); cat.platforms['linux-x64'].sha256 = sha(body);
  const { inst } = mkInstaller(cat, { 'https://dl.example.test/nmap.tgz': { body, headers: { 'content-length': String(body.length) } } });
  assert.equal((await inst.install('nmap', { licenceAccepted: true })).error, 'too-large');
  const evil = tarGz({ nmap: GOOD }, { evil: true });
  const c2 = entry(); c2.platforms['linux-x64'].sha256 = sha(evil);
  const r2 = await mkInstaller(c2, { 'https://dl.example.test/nmap.tgz': { body: evil } }).inst.install('nmap', { licenceAccepted: true });
  assert.equal(r2.error, 'extract-failed');
  const link = tarGz({ nmap: GOOD }, { symlink: true });
  const c3 = entry(); c3.platforms['linux-x64'].sha256 = sha(link);
  const m3 = mkInstaller(c3, { 'https://dl.example.test/nmap.tgz': { body: link } });
  const r3 = await m3.inst.install('nmap', { licenceAccepted: true });
  assert.equal(r3.error, 'extract-failed'); assert.match(r3.message, /symbolic link/);
  await noRecordInstalled(m3.inst);
  const none = tarGz({ other: GOOD });
  const c4 = entry(); c4.platforms['linux-x64'].sha256 = sha(none);
  assert.match((await mkInstaller(c4, { 'https://dl.example.test/nmap.tgz': { body: none } }).inst.install('nmap', { licenceAccepted: true })).message, /does not contain nmap/);
});
test('zip archives unpack and install', { skip: isWin || !fs.existsSync('/usr/bin/unzip') }, async () => {
  const body = zipStored({ 'nmap-dir/nmap': GOOD });
  const cat = entry(); cat.platforms['linux-x64'] = { url: 'https://dl.example.test/nmap.zip', file: 'nmap.zip', archive: 'zip', sha256: sha(body) };
  const { inst } = mkInstaller(cat, { 'https://dl.example.test/nmap.zip': { body } });
  const r = await inst.install('nmap', { licenceAccepted: true });
  assert.equal(r.ok, true, JSON.stringify(r));
});
test('unsupported platform: says what to do instead', async () => {
  const { inst } = mkInstaller(entry({ manualHint: 'Install it with your package manager.' }), {}, { platform: 'darwin', arch: 'arm64' });
  const r = await inst.install('nmap', { licenceAccepted: true });
  assert.equal(r.error, 'unsupported-platform'); assert.match(r.message, /package manager/);
  assert.equal((await inst.status('nmap')).supported, false);
});
test('adopt: your own copy is registered only if it passes the self-test', { skip: isWin }, async () => {
  const { inst, root } = mkInstaller(entry(), {});
  const dir = tmp('mfsec-own-');
  const good = path.join(dir, 'nmap'), bad = path.join(dir, 'other');
  fs.writeFileSync(good, GOOD, { mode: 0o755 }); fs.writeFileSync(bad, script('hello'), { mode: 0o755 });
  assert.equal((await inst.adopt('nmap', bad, { licenceAccepted: true })).error, 'selftest-failed');
  await noRecordInstalled(inst);
  assert.equal((await inst.adopt('nmap', 'relative/nmap', { licenceAccepted: true })).error, 'bad-path');
  assert.equal((await inst.adopt('nmap', good, {})).error, 'licence-not-accepted');
  const r = await inst.adopt('nmap', good, { licenceAccepted: true });
  assert.equal(r.ok, true); assert.equal(r.status.adopted, true); assert.equal(r.status.source.verifiedBy, 'user-supplied');
  assert.ok(fs.existsSync(good), 'nothing was copied or moved');
  assert.ok(!fs.existsSync(path.join(root, 'ghost', 'tools', 'nmap', 'pkg')));
  fs.appendFileSync(good, '# changed');
  assert.equal((await inst.status('nmap')).installed, false);
});
test('the shipped catalog cannot install anything it cannot verify, and an unreachable host is reported honestly', async () => {
  const root = tmp('mfsec-root-');
  const calls = [];
  const down = async (u) => { calls.push(u); throw unreachable('ENOTFOUND'); };
  const inst = new ToolInstaller({ root, fetchImpl: down, platform: 'linux', arch: 'x64' });
  // no pinned sha and no checksum list: refused with no network call
  for (const id of ['findomain', 'whatweb', 'testssl', 'zap-baseline', 'spiderfoot', 'recon-ng', 'theharvester', 'photon']) assert.equal((await inst.install(id, { licenceAccepted: true })).error, 'no-checksum', id);
  assert.equal(calls.length, 0);
  // upstream checksum list exists but its host cannot be reached
  const r = await inst.install('subfinder', { licenceAccepted: true });
  assert.equal(r.error, 'host-unreachable'); assert.equal(r.host, 'github.com');
  assert.equal((await inst.status('subfinder')).installed, false);
  // nothing the catalog lists points at a Mayfair host or a non-https address, and every entry knows its own allowed hosts
  for (const [id, c] of Object.entries(CATALOG)) for (const p of Object.values(c.platforms)) { assert.match(p.url, /^https:\/\//, id); assert.ok(c.hosts.includes(new URL(p.url).hostname), id); }
  // Windows-only Nmap archive, no checksum: refused too
  const w = new ToolInstaller({ root, fetchImpl: down, platform: 'win32', arch: 'x64' });
  assert.equal((await w.install('nmap', { licenceAccepted: true })).error, 'no-checksum');
  for (const id of ['masscan', 'zeek', 'suricata', 'bbot', 'bbot-active']) assert.equal((await inst.install(id, { licenceAccepted: true })).error, 'unsupported-platform', id);
  assert.equal((await new ToolInstaller({ root, platform: 'linux', arch: 'x64' }).status('nmap')).urlsVerified, false);
});
