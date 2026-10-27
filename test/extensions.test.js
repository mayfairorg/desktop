'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const E = require('../src/main/lib/extensions');
const { readZip } = require('../src/main/lib/zip');
const { check } = require('../src/main/lib/ipc-allowlist');

const FX = path.join(__dirname, 'fixtures', 'ext');
const index = JSON.parse(fs.readFileSync(path.join(FX, 'index.json'), 'utf8'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-ext-'));
const mgr = () => { const d = tmp(); return { m: new E.ExtensionManager({ dir: path.join(d, 'extensions'), storeFile: path.join(d, 'ext.json') }), d }; };
const serve = (file) => async () => fs.readFileSync(path.join(FX, file));
const URL_OF = (f) => 'https://cloud.mayfairmail.com/ext/' + f;

// tiny zip writer for hostile test archives
function makeZip(entries) {
  const parts = []; const cd = []; let off = 0;
  for (const [name, data, method = 8] of entries) {
    const nb = Buffer.from(name); const raw = Buffer.from(data); const comp = method === 8 ? zlib.deflateRawSync(raw) : raw; const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, nb); off += 30 + nb.length + comp.length;
  }
  const cdb = Buffer.concat(cd); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, e]);
}
const goodManifest = JSON.stringify({ manifest_version: 3, name: 'T', version: '1.0.0' });

test('index.json lists nine extensions and every shipped zip matches its sha256', () => {
  assert.equal(index.extensions.length, 9);
  for (const x of index.extensions) assert.equal(E.sha256(fs.readFileSync(path.join(FX, x.file))), x.sha256, x.id);
});
test('download URL rule: Cloud /ext/*.zip over https only', () => {
  assert.equal(E.validDownloadUrl('https://cloud.mayfairmail.com/ext/deals-1.0.0.zip'), true);
  for (const u of ['http://cloud.mayfairmail.com/ext/a.zip', 'https://mayfairmail.com/ext/a.zip', 'https://cloud.mayfairmail.com/other/a.zip', 'https://cloud.mayfairmail.com/ext/a.zip?x=1', 'https://cloud.mayfairmail.com/ext/../a.zip', 'https://cloud.mayfairmail.com/ext/a.exe', 'https://cloud.mayfairmail.com.evil.com/ext/a.zip', 'https://u:p@cloud.mayfairmail.com/ext/a.zip', 'https://cloud.mayfairmail.com:8443/ext/a.zip', 'https://cloud.mayfairmail.com/ext/a/b.zip', 'ftp://x', '', null]) assert.equal(E.validDownloadUrl(u), false, String(u));
});
test('installs a real extension: verifies hash, unpacks, records, lists', async () => {
  const x = index.extensions.find((e) => e.id === 'deals'); const { m, d } = mgr();
  const r = await m.install('deals', URL_OF(x.file), x.sha256, serve(x.file));
  assert.equal(r.version, x.version);
  assert.ok(fs.existsSync(path.join(d, 'extensions', 'deals', x.version, 'manifest.json')));
  assert.deepEqual(m.list(), [{ id: 'deals', version: x.version, enabled: true }]);
  assert.equal(m.loadable().length, 1);
  assert.equal(new E.ExtensionManager({ dir: path.join(d, 'extensions'), storeFile: path.join(d, 'ext.json') }).list().length, 1, 'persisted');
  assert.equal(m.remove('deals'), true); assert.equal(m.remove('deals'), false);
  assert.equal(fs.existsSync(path.join(d, 'extensions', 'deals')), false);
});
test('all nine real packages install; blocker and passwords are handled natively, not loaded', async () => {
  const { m } = mgr();
  for (const x of index.extensions) await m.install(x.id, URL_OF(x.file), x.sha256, serve(x.file));
  assert.equal(m.list().length, 9);
  const loadable = m.loadable().map((x) => x.id).sort();
  assert.deepEqual(loadable, ['clipper', 'dark', 'deals', 'reader', 'screenshot', 'tabsaver', 'translate']);
  assert.equal(m.native('blocker'), 'rules'); assert.equal(m.native('passwords'), 'bridge'); assert.equal(m.native('deals'), null);
});
test('wrong hash, wrong host, bad id, oversize are all refused and nothing is written', async () => {
  const x = index.extensions[0]; const { m, d } = mgr();
  await assert.rejects(() => m.install(x.id, URL_OF(x.file), '0'.repeat(64), serve(x.file)), /Checksum does not match/);
  await assert.rejects(() => m.install(x.id, 'https://evil.com/ext/a.zip', x.sha256, serve(x.file)), /only be downloaded from cloud/);
  await assert.rejects(() => m.install('../x', URL_OF(x.file), x.sha256, serve(x.file)), /Bad extension id/);
  await assert.rejects(() => m.install(x.id, URL_OF(x.file), 'zz', serve(x.file)), /Bad checksum/);
  await assert.rejects(() => m.install(x.id, URL_OF(x.file), x.sha256, async () => Buffer.alloc(9 * 1024 * 1024)), /too large/);
  assert.equal(m.list().length, 0); assert.equal(fs.existsSync(path.join(d, 'extensions')), false);
});
test('zip-slip, absolute paths, encrypted flag and junk are refused', () => {
  for (const bad of ['../evil.js', 'a/../../evil.js', '/etc/passwd', 'C:/x.js', 'a\\b.js']) assert.throws(() => readZip(makeZip([[bad, 'x']])), /Unsafe file name/, bad);
  assert.throws(() => readZip(Buffer.from('not a zip at all, really not')), /Not a zip/);
  assert.throws(() => readZip(Buffer.alloc(10)), /Not a zip/);
  const z = makeZip([['manifest.json', goodManifest]]); z[30 + 'manifest.json'.length + 3] ^= 0xff;
  assert.throws(() => readZip(z));
  assert.equal(readZip(makeZip([['a.txt', 'hello', 0], ['d/b.txt', 'x'.repeat(1000)]])).length, 2);
  assert.throws(() => readZip(makeZip([['big.bin', 'x'.repeat(100)]]), { entries: 600, total: 50, single: 50 }), /too large/);
});
test('manifest rules: MV3 only, no dangerous permissions, no update_url', async () => {
  const mk = (m) => makeZip([['manifest.json', JSON.stringify(m)]]);
  const tryIt = async (m) => { const buf = mk(m); const { m: mg } = mgr(); return mg.install('tt', URL_OF('t.zip'), E.sha256(buf), async () => buf); };
  assert.equal((await tryIt({ manifest_version: 3, name: 'T', version: '1.2' })).version, '1.2');
  await assert.rejects(() => tryIt({ manifest_version: 2, name: 'T', version: '1' }), /Manifest V3/);
  await assert.rejects(() => tryIt({ manifest_version: 3, name: 'T', version: '1', permissions: ['nativeMessaging'] }), /not allowed: nativeMessaging/);
  await assert.rejects(() => tryIt({ manifest_version: 3, name: 'T', version: '1', optional_permissions: ['debugger'] }), /debugger/);
  await assert.rejects(() => tryIt({ manifest_version: 3, name: 'T', version: '1', update_url: 'https://x' }), /not allowed/);
  await assert.rejects(() => tryIt({ manifest_version: 3, name: 'T', version: 'x' }), /incomplete/);
  const buf = makeZip([['readme.txt', 'x']]); const { m: mg } = mgr();
  await assert.rejects(() => mg.install('tt', URL_OF('t.zip'), E.sha256(buf), async () => buf), /no manifest/);
});
test('updating replaces the old version folder', async () => {
  const { m, d } = mgr(); const v = (ver) => makeZip([['manifest.json', JSON.stringify({ manifest_version: 3, name: 'T', version: ver })]]);
  for (const ver of ['1.0.0', '1.1.0']) { const b = v(ver); await m.install('tt', URL_OF('t.zip'), E.sha256(b), async () => b); }
  assert.deepEqual(fs.readdirSync(path.join(d, 'extensions', 'tt')), ['1.1.0']); assert.equal(m.list()[0].version, '1.1.0');
});
test('Tracker blocker rule file becomes native host rules', async () => {
  const x = index.extensions.find((e) => e.id === 'blocker'); const { m } = mgr();
  await m.install('blocker', URL_OF(x.file), x.sha256, serve(x.file));
  const doms = m.blockerDomains();
  assert.ok(doms.size >= 100, String(doms.size)); assert.ok(doms.has('doubleclick.net')); assert.ok(![...doms].some((h) => h.includes('mayfair')));
  assert.equal(E.rulesToDomains([{ action: { type: 'allow' }, condition: { urlFilter: '||x.com^' } }, { action: { type: 'block' }, condition: { urlFilter: '/ads/*' } }, null]).size, 0);
  assert.equal(new E.ExtensionManager({ dir: tmp(), storeFile: path.join(tmp(), 'x.json') }).blockerDomains().size, 0);
});
test('bridge channels: only the Mayfair web role, argument shapes enforced', () => {
  const sha = 'a'.repeat(64);
  assert.equal(check('web', 'web:extInstall', ['deals', 'https://cloud.mayfairmail.com/ext/deals-1.0.0.zip', sha]).ok, true);
  assert.equal(check('web', 'web:extInstall', ['deals', 5, sha]).ok, false);
  assert.equal(check('web', 'web:extInstall', ['deals', 'u']).ok, false);
  assert.equal(check('web', 'web:extRemove', ['deals']).ok, true); assert.equal(check('web', 'web:extList', []).ok, true);
  for (const r of ['page', 'start', 'chrome', 'overlay']) for (const c of ['web:extInstall', 'web:extRemove', 'web:extList']) assert.equal(check(r, c, ['deals', 'x', sha]).ok, false, r + c);
});
test('bridge is exposed only by the Mayfair-view preload, on Mayfair origins', () => {
  const web = fs.readFileSync(path.join(__dirname, '../src/preload/web.js'), 'utf8');
  assert.match(web, /MAYFAIR\.includes\(location\.origin\)/); assert.match(web, /installExtension/); assert.match(web, /mf\.pw\.request/); assert.match(web, /e\.source !== window \|\| e\.origin !== location\.origin/);
  const br = fs.readFileSync(path.join(__dirname, '../src/main/browser-service.js'), 'utf8');
  assert.match(br, /preload: PRELOAD\('web'\)/); assert.match(br, /preload: PRELOAD\('page'\)/);
});
