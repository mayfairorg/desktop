'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vault, VaultError } = require('../src/main/ghost/vault/vault');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-vault-'));
const FAST = { m: 64, t: 1, p: 1 };
// a stand-in for Electron's safeStorage (reversible, not secure: tests only)
const fakeOS = () => ({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('OS:' + Buffer.from(s).toString('hex')), decryptString: (b) => { const t = b.toString(); if (!t.startsWith('OS:')) throw new Error('bad'); return Buffer.from(t.slice(3), 'hex').toString(); } });
const mk = (dir = path.join(tmp(), 'vault'), o = {}) => new Vault({ dir, safeStorage: fakeOS(), kdfParams: FAST, allowWeakKdf: true, syncDebounceMs: 5, ...o });
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const PASS = 'correct horse battery staple';
const answers = (b) => Object.fromEntries(b.challenge.map((n) => [n, b.phrase[n - 1]]));
async function withBackup(v) { const b = await v.beginBackup({ passphrase: PASS }); v.confirmBackup({ answers: answers(b) }); return b.phrase; }
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof VaultError && (!code || e.code === code), 'expected ' + code);

test('first start creates the vault silently, unlocked, with the OS key store', () => {
  const v = mk(); const s = v.open();
  assert.equal(s.state, 'unlocked'); assert.equal(s.protection, 'os'); assert.equal(s.backup.on, false); assert.equal(s.keyId, 1);
  const g = mk(v.dir); assert.equal(g.open().state, 'unlocked', 'reopens with no question');
});
test('data, logs and connector config are ciphertext on disk and key material is never plain', () => {
  const v = mk(); v.open();
  v.putJSON('cases', 'c1', { title: 'NORTHWIND-MARKER-9137', entities: [] }); v.put('scanlogs', 'l1', 'SCAN-MARKER-5521'); v.putJSON('connectors', 'rdap', { apiKey: 'CONNECTOR-MARKER-7788' });
  assert.deepEqual(v.getJSON('cases', 'c1').title, 'NORTHWIND-MARKER-9137');
  const mvkHex = v.mvk.toString('hex'), mvkB64 = v.mvk.toString('base64'), dekB64 = v.keyring.keys[1].toString('base64');
  for (const f of walk(v.dir)) {
    const raw = fs.readFileSync(f); const t = raw.toString('latin1');
    for (const m of ['NORTHWIND-MARKER', 'SCAN-MARKER', 'CONNECTOR-MARKER', mvkHex, mvkB64, dekB64]) assert.equal(t.includes(m), false, `${m} found in ${path.basename(f)}`);
    assert.equal(raw.includes(v.mvk), false); assert.equal(raw.includes(v.keyring.keys[1]), false);
  }
  const dev = JSON.parse(fs.readFileSync(path.join(v.dir, 'device.key'), 'utf8')); assert.equal(dev.mode, 'os');
  assert.equal(fs.readFileSync(path.join(v.dir, 'device.key'), 'utf8').includes(v.mvk.toString('hex')), false);
});
test('no OS key store: honest fallback message and a vault that still works', () => {
  const v = new Vault({ dir: path.join(tmp(), 'v'), safeStorage: null, kdfParams: FAST, allowWeakKdf: true }); const s = v.open();
  assert.equal(s.protection, 'file-permissions'); assert.match(s.message, /no secure key store/i); assert.match(s.message, /file permissions/i);
  v.put('cases', 'a', 'hello'); const w = new Vault({ dir: v.dir, safeStorage: null, kdfParams: FAST, allowWeakKdf: true }); w.open(); assert.equal(w.get('cases', 'a').toString(), 'hello');
  const x = new Vault({ dir: v.dir, safeStorage: null, kdfParams: FAST, allowWeakKdf: true, identity: () => 'someone-else|other-host|linux' });
  assert.throws(() => x.open(), (e) => e.code === 'device-key', 'copied to another account or machine: not readable');
  const basic = { ...fakeOS(), getSelectedStorageBackend: () => 'basic_text' };
  assert.equal(new Vault({ dir: path.join(tmp(), 'v'), safeStorage: basic, platform: 'linux', kdfParams: FAST, allowWeakKdf: true }).open().protection, 'file-permissions', 'Linux basic_text is not treated as protection');
});
test('a changed OS key store (key cannot be released) locks with a clear message', () => {
  const v = mk(); v.open(); v.put('cases', 'a', 'x');
  const broken = fakeOS(); broken.decryptString = () => { throw new Error('keychain changed'); };
  assert.throws(() => mk(v.dir, { safeStorage: broken }).open(), (e) => e.code === 'device-key' && /passphrase or recovery phrase/.test(e.message));
});
test('tamper: a flipped byte, a swapped record, a deleted-and-replaced record are all refused', () => {
  const v = mk(); v.open(); v.putJSON('cases', 'one', { a: 1 }); v.putJSON('cases', 'two', { b: 2 });
  const f1 = path.join(v.dir, 'data', 'cases', 'one.mfv'), f2 = path.join(v.dir, 'data', 'cases', 'two.mfv');
  const orig = fs.readFileSync(f1), b = Buffer.from(orig); b[b.length - 20] ^= 4; fs.writeFileSync(f1, b);
  assert.throws(() => v.get('cases', 'one'), (e) => e.code === 'tamper'); fs.writeFileSync(f1, orig); assert.deepEqual(v.getJSON('cases', 'one'), { a: 1 });
  fs.copyFileSync(f2, f1); assert.throws(() => v.get('cases', 'one'), (e) => e.code === 'tamper', 'a record moved to another id');
  fs.writeFileSync(f1, orig); fs.mkdirSync(path.join(v.dir, 'data', 'scanlogs'), { recursive: true }); fs.copyFileSync(f1, path.join(v.dir, 'data', 'scanlogs', 'one.mfv'));
  assert.throws(() => v.get('scanlogs', 'one'), (e) => e.code === 'tamper', 'a record moved to another namespace');
  fs.writeFileSync(f1, Buffer.from('not encrypted at all')); assert.throws(() => v.get('cases', 'one'), (e) => e.code === 'tamper');
});
test('tamper: a changed wrapped key or key table stops the vault opening', () => {
  const v = mk(); v.open(); const mf = path.join(v.dir, 'meta.json');
  for (const field of ['deviceWrap', 'keyring']) {
    const m = JSON.parse(fs.readFileSync(mf, 'utf8')), raw = Buffer.from(m[field], 'base64'); raw[raw.length - 3] ^= 1; const saved = fs.readFileSync(mf, 'utf8');
    m[field] = raw.toString('base64'); fs.writeFileSync(mf, JSON.stringify(m));
    assert.throws(() => mk(v.dir).open(), (e) => e.code === 'tamper' || e.code === 'device-key', field); fs.writeFileSync(mf, saved);
  }
  assert.equal(mk(v.dir).open().state, 'unlocked');
});
test('names are validated (no path tricks) and namespaces are fixed', () => {
  const v = mk(); v.open();
  for (const id of ['../x', 'a/b', '', '.hidden', 'a'.repeat(81)]) assert.throws(() => v.put('cases', id, 'x'), (e) => e.code === 'bad-input');
  assert.throws(() => v.put('elsewhere', 'a', 'x'), (e) => e.code === 'bad-input');
  assert.throws(() => v.put('_vault', 'a', 'x'), (e) => e.code === 'bad-input', 'the internal section is not open to callers');
  assert.throws(() => v.get('_vault', 'state'), (e) => e.code === 'bad-input');
});
test('lock and unlock: locked vault refuses everything and holds no key', async () => {
  const v = mk(); v.open(); v.put('cases', 'a', 'x');
  v.lock(); assert.equal(v.status().state, 'locked'); assert.equal(v.mvk, null);
  assert.throws(() => v.get('cases', 'a'), (e) => e.code === 'locked'); assert.throws(() => v.put('cases', 'b', 'y'), (e) => e.code === 'locked');
  await v.unlock(); assert.equal(v.get('cases', 'a').toString(), 'x');
});

test('backup: off by default; begin shows 12 words once; nothing is on until 3 words are confirmed', async () => {
  const v = mk(); v.open();
  await rejects(v.beginBackup({ passphrase: 'short' }), 'weak-passphrase');
  const b = await v.beginBackup({ passphrase: PASS });
  assert.equal(b.phrase.length, 12); assert.equal(b.challenge.length, 3); assert.equal(new Set(b.challenge).size, 3);
  assert.equal(v.status().backup.on, false, 'not on yet'); assert.equal(v.status().backup.pending, true);
  assert.equal(JSON.stringify(v.status()).includes(b.phrase[0] + ' ' + b.phrase[1]), false, 'status never repeats the phrase');
  assert.throws(() => v.confirmBackup({ answers: Object.fromEntries(b.challenge.map((n) => [n, 'wrong'])) }), (e) => e.code === 'confirm-failed');
  assert.equal(v.status().backup.on, false);
  assert.equal(v.confirmBackup({ answers: answers(b) }).backup.on, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(v.dir, 'meta.json'), 'utf8')).passWrap.kdf.m, FAST.m);
  assert.equal(fs.readFileSync(path.join(v.dir, 'meta.json'), 'utf8').includes(PASS), false);
});
test('backup: five wrong confirmations discard the phrase', async () => {
  const v = mk(); v.open(); const b = await v.beginBackup({ passphrase: PASS });
  for (let i = 0; i < 4; i++) assert.throws(() => v.confirmBackup({ answers: { 1: 'x' } }), (e) => e.code === 'confirm-failed');
  assert.throws(() => v.confirmBackup({ answers: answers(b) }) && v.confirmBackup({ answers: { 1: 'x' } }), () => true);
  const w = mk(); w.open(); const c = await w.beginBackup({ passphrase: PASS });
  for (let i = 0; i < 5; i++) assert.throws(() => w.confirmBackup({ answers: {} }), (e) => e.code === 'confirm-failed');
  assert.throws(() => w.confirmBackup({ answers: answers(c) }), (e) => e.code === 'no-pending');
});
test('wrong passphrase and wrong phrase are refused; right ones unlock (device key not needed)', async () => {
  const v = mk(); v.open(); v.putJSON('cases', 'a', { ok: 1 }); const phrase = await withBackup(v);
  v.setRequirePassphrase(true); v.lock();
  const w = mk(v.dir); assert.equal(w.status().state, 'locked'); await rejects(w.unlock(), 'passphrase-required');
  await rejects(w.unlock({ passphrase: PASS + 'x' }), 'wrong-secret');
  const other = (await (async () => { const o = mk(); o.open(); return withBackup(o); })());
  await rejects(w.unlock({ phrase: other }), 'wrong-secret');
  await rejects(w.unlock({ phrase: phrase.slice(0, 11) }), 'bad-phrase');
  const typo = phrase.slice(); typo[0] = typo[0] === 'zz' ? 'aa' : bipOther(typo[0]); await rejects(w.unlock({ phrase: typo }), 'bad-phrase');
  assert.equal(w.status().state, 'locked');
  await w.unlock({ passphrase: PASS }); assert.deepEqual(w.getJSON('cases', 'a'), { ok: 1 });
  const x = mk(v.dir); await x.unlock({ phrase: phrase.join(' ').toUpperCase() }); assert.deepEqual(x.getJSON('cases', 'a'), { ok: 1 });
});
function bipOther(w) { const L = require('../src/main/ghost/vault/bip39').words(); return L[(L.indexOf(w) + 5) % 2048]; }
test('requirePassphrase removes the device key; turning it off brings it back', async () => {
  const v = mk(); v.open(); await rejects(Promise.resolve().then(() => v.setRequirePassphrase(true)), 'backup-off');
  await withBackup(v); v.setRequirePassphrase(true);
  assert.equal(fs.existsSync(path.join(v.dir, 'device.key')), false); assert.equal(v.status().requirePassphrase, true);
  v.setRequirePassphrase(false); assert.equal(fs.existsSync(path.join(v.dir, 'device.key')), true);
  v.lock(); await v.unlock(); assert.equal(v.status().state, 'unlocked');
});
test('change passphrase and reset with the recovery phrase', async () => {
  const v = mk(); v.open(); v.put('cases', 'a', 'x'); const phrase = await withBackup(v);
  await rejects(v.changePassphrase({ oldPassphrase: 'nope nope nope', newPassphrase: 'a brand new passphrase' }), 'wrong-secret');
  await v.changePassphrase({ oldPassphrase: PASS, newPassphrase: 'a brand new passphrase' });
  v.setRequirePassphrase(true); v.lock(); const w = mk(v.dir);
  await rejects(w.unlock({ passphrase: PASS }), 'wrong-secret'); await w.unlock({ passphrase: 'a brand new passphrase' }); w.lock();
  const z = mk(v.dir); await z.resetPassphrase({ phrase, newPassphrase: 'third passphrase here' }); assert.equal(z.status().state, 'unlocked');
  const q = mk(v.dir); await q.unlock({ passphrase: 'third passphrase here' });
});

test('export and import round trip across two "computers", with a passphrase or the phrase', async () => {
  const a = mk(); a.open(); a.putJSON('cases', 'c1', { title: 'Round trip' }); a.put('scanlogs', 'l', 'log line'); a.putJSON('connectors', 'k', { v: 1 });
  await rejects(Promise.resolve().then(() => a.exportBytes()), 'backup-off');
  const phrase = await withBackup(a); const file = a.exportBytes();
  assert.equal(file.includes(Buffer.from('Round trip')), false); assert.equal(file.includes(Buffer.from(PASS)), false);
  for (const secret of [{ passphrase: PASS }, { phrase: phrase.join(' ') }]) {
    const b = mk(); b.open(); const s = await b.importBytes(file, secret);
    assert.equal(s.state, 'unlocked'); assert.deepEqual(b.getJSON('cases', 'c1'), { title: 'Round trip' }); assert.equal(b.get('scanlogs', 'l').toString(), 'log line'); assert.equal(s.backup.on, true);
    const again = mk(b.dir); again.open(); assert.deepEqual(again.getJSON('connectors', 'k'), { v: 1 }, 'survives restart under the new computer\'s device key');
  }
});
test('import: wrong passphrase / wrong phrase / tampered or truncated file change nothing', async () => {
  const a = mk(); a.open(); a.putJSON('cases', 'c1', { t: 1 }); const phrase = await withBackup(a); const file = a.exportBytes();
  const b = mk(); b.open(); b.putJSON('cases', 'mine', { keep: true });
  await rejects(b.importBytes(file, { passphrase: PASS, replace: false }), 'would-replace');
  await rejects(b.importBytes(file, { passphrase: PASS + 'x', replace: true }), 'wrong-secret');
  const other = mk(); other.open(); const op = await withBackup(other);
  await rejects(b.importBytes(file, { phrase: op, replace: true }), 'wrong-secret');
  await rejects(b.importBytes(file, { replace: true }), 'bad-input');
  const outer = JSON.parse(file.subarray(6).toString()), body = JSON.parse(outer.body);
  const rec = body.records.cases.c1, raw = Buffer.from(rec, 'base64'); raw[raw.length - 5] ^= 1; body.records.cases.c1 = raw.toString('base64');
  const forged = Buffer.from('MFVB1\n' + JSON.stringify({ body: JSON.stringify(body), mac: outer.mac }));
  await rejects(b.importBytes(forged, { passphrase: PASS, replace: true }), 'tamper');
  const dropped = JSON.parse(outer.body); dropped.records.cases = {}; await rejects(b.importBytes(Buffer.from('MFVB1\n' + JSON.stringify({ body: JSON.stringify(dropped), mac: outer.mac })), { passphrase: PASS, replace: true }), 'tamper');
  await rejects(b.importBytes(file.subarray(0, 200), { passphrase: PASS, replace: true }), 'format');
  await rejects(b.importBytes(Buffer.from('hello'), { passphrase: PASS, replace: true }), 'format');
  assert.deepEqual(b.getJSON('cases', 'mine'), { keep: true }, 'nothing changed');
  assert.equal(b.status().backup.on, false);
  const s = await b.importBytes(file, { passphrase: PASS, replace: true }); assert.equal(s.imported >= 1, true); assert.equal(b.get('cases', 'mine'), null); assert.deepEqual(b.getJSON('cases', 'c1'), { t: 1 });
  void phrase;
});
test('import with a hostile KDF cost in the file is refused before any work', async () => {
  const a = new Vault({ dir: path.join(tmp(), 'v'), safeStorage: fakeOS(), kdfParams: { m: 19456, t: 1, p: 1 } }); a.open();
  const b = await a.beginBackup({ passphrase: PASS }); a.confirmBackup({ answers: answers(b) }); const file = a.exportBytes();
  const outer = JSON.parse(file.subarray(6).toString()), body = JSON.parse(outer.body); body.passWrap.kdf = { m: 1 << 30, t: 1, p: 1 };
  const bad = Buffer.from('MFVB1\n' + JSON.stringify({ body: JSON.stringify(body), mac: outer.mac }));
  const t = Date.now(); await rejects(mk().importBytes(bad, { passphrase: PASS, replace: true }), 'bad-kdf'); assert.ok(Date.now() - t < 2000);
  body.passWrap.kdf = { m: 8, t: 1, p: 1 };
  await rejects(new Vault({ dir: path.join(tmp(), 'v'), safeStorage: fakeOS() }).importBytes(Buffer.from('MFVB1\n' + JSON.stringify({ body: JSON.stringify(body), mac: outer.mac })), { passphrase: PASS, replace: true }), 'bad-kdf');
});

test('rotation: new key generation, every record re-encrypted and readable, old keys gone, no backup', async () => {
  const v = mk(); v.open(); for (let i = 0; i < 5; i++) v.putJSON('cases', 'c' + i, { i }); v.put('scanlogs', 'l', 'log');
  const before = fs.readFileSync(path.join(v.dir, 'data', 'cases', 'c0.mfv')), oldDek = Buffer.from(v.keyring.keys[1]), oldMvk = Buffer.from(v.mvk), oldDev = fs.readFileSync(path.join(v.dir, 'device.key'), 'utf8');
  const s = await v.rotateKeys();
  assert.equal(s.keyId, 2); assert.equal(s.rotated.records >= 6, true);
  for (let i = 0; i < 5; i++) assert.deepEqual(v.getJSON('cases', 'c' + i), { i });
  const after = fs.readFileSync(path.join(v.dir, 'data', 'cases', 'c0.mfv')); assert.notDeepEqual(before, after); assert.equal(after.readUInt32BE(6), 2);
  assert.equal(Object.keys(v.keyring.keys).length, 1); assert.ok(!v.keyring.keys[2].equals(oldDek)); assert.ok(!v.mvk.equals(oldMvk));
  assert.notEqual(fs.readFileSync(path.join(v.dir, 'device.key'), 'utf8'), oldDev, 'device key replaced');
  const w = mk(v.dir); assert.equal(w.open().state, 'unlocked'); assert.deepEqual(w.getJSON('cases', 'c3'), { i: 3 });
  const k1 = require('../src/main/ghost/vault/aead'); assert.throws(() => k1.open(require('../src/main/ghost/vault/aead').hkdf(oldDek, 'mf-vault-ns|cases'), after, `mf-vault-rec|${v.meta.id}|cases|c0`), (e) => e.code === 'auth', 'old data key opens nothing now');
});
test('rotation with Backup on: needs the passphrase, old recovery phrase stops working, new one confirms', async () => {
  const v = mk(); v.open(); v.putJSON('cases', 'a', { x: 1 }); const oldPhrase = await withBackup(v);
  await rejects(v.rotateKeys(), 'passphrase-required'); await rejects(v.rotateKeys({ passphrase: 'wrong wrong wrong' }), 'wrong-secret');
  const r = await v.rotateKeys({ passphrase: PASS });
  assert.equal(r.phrase.length, 12); assert.notDeepEqual(r.phrase, oldPhrase); assert.equal(v.status().backup.on, false, 'phrase not active until confirmed');
  v.confirmBackup({ answers: answers(r) }); assert.equal(v.status().backup.on, true);
  v.setRequirePassphrase(true); v.lock(); const w = mk(v.dir);
  await rejects(w.unlock({ phrase: oldPhrase }), 'wrong-secret'); await w.unlock({ phrase: r.phrase }); assert.deepEqual(w.getJSON('cases', 'a'), { x: 1 }); w.lock(); await w.unlock({ passphrase: PASS });
  const oldFileVault = mk(); oldFileVault.open();
});
test('an old downloaded file and old phrase do not open data written after rotation', async () => {
  const v = mk(); v.open(); v.putJSON('cases', 'a', { n: 1 }); const oldPhrase = await withBackup(v); const oldFile = v.exportBytes();
  const r = await v.rotateKeys({ passphrase: PASS }); v.confirmBackup({ answers: answers(r) }); v.putJSON('cases', 'later', { secret: 'after rotation' });
  const x = mk(); x.open(); await x.importBytes(oldFile, { phrase: oldPhrase.join(' ') });
  assert.equal(x.get('cases', 'later'), null); assert.deepEqual(x.getJSON('cases', 'a'), { n: 1 });
  const liveLater = fs.readFileSync(path.join(v.dir, 'data', 'cases', 'later.mfv'));
  const ak = require('../src/main/ghost/vault/aead');
  for (const dek of Object.values(x.keyring.keys)) assert.throws(() => ak.open(ak.hkdf(dek, 'mf-vault-ns|cases'), liveLater, `mf-vault-rec|${v.meta.id}|cases|later`), (e) => e.code === 'auth');
});
test('rotation survives an interruption: both keys readable until the switch', async () => {
  const v = mk(); v.open(); for (let i = 0; i < 3; i++) v.putJSON('cases', 'c' + i, { i });
  const real = v._get.bind(v); let n = 0;
  v._get = (ns, id) => { if (ns === 'cases' && ++n === 2) throw new Error('crash'); return real(ns, id); };
  await assert.rejects(v.rotateKeys(), /crash/);
  const w = mk(v.dir); w.open(); for (let i = 0; i < 3; i++) assert.deepEqual(w.getJSON('cases', 'c' + i), { i }, 'mixed old/new records all open');
  assert.equal(Object.keys(w.keyring.keys).length, 2);
});

test('sync: nothing is sent while Backup is off; on sends only the encrypted file; off stops and deletes the copy', async () => {
  const calls = []; const sync = { put: async (n, b) => { calls.push(['put', n, b]); }, remove: async (n) => { calls.push(['remove', n]); } };
  const v = mk(undefined, { sync }); v.open(); v.putJSON('cases', 'a', { title: 'PLAINTEXT-TITLE' });
  await new Promise((r) => setTimeout(r, 40)); assert.equal(calls.length, 0, 'backup off: no sync at all');
  assert.deepEqual(await v.syncNow(), { ok: false, skipped: 'backup-off' });
  await withBackup(v); await new Promise((r) => setTimeout(r, 60));
  assert.ok(calls.length >= 1); const put = calls.find((c) => c[0] === 'put'); assert.equal(put[1], 'ghost/vault-backup.mfvb');
  assert.equal(put[2].includes(Buffer.from('PLAINTEXT-TITLE')), false); assert.equal(put[2].includes(Buffer.from(PASS)), false);
  calls.length = 0; v.putJSON('cases', 'b', { n: 2 }); await new Promise((r) => setTimeout(r, 60)); assert.equal(calls.filter((c) => c[0] === 'put').length >= 1, true, 'a change syncs');
  calls.length = 0; const r = await v.disableBackup(); assert.equal(r.remote, 'removed'); assert.deepEqual(calls, [['remove', 'ghost/vault-backup.mfvb']]);
  calls.length = 0; v.putJSON('cases', 'c', { n: 3 }); await new Promise((r2) => setTimeout(r2, 60)); assert.equal(calls.length, 0, 'after turning off: no more sync');
  assert.equal(v.status().backup.on, false); assert.equal(JSON.parse(fs.readFileSync(path.join(v.dir, 'meta.json'), 'utf8')).passWrap, null);
});
test('turning Backup off replaces keys so the old passphrase, phrase and file open nothing new', async () => {
  const v = mk(); v.open(); v.putJSON('cases', 'a', { n: 1 }); const phrase = await withBackup(v); const file = v.exportBytes();
  await v.disableBackup(); v.putJSON('cases', 'new', { s: 1 });
  const x = mk(); x.open(); await x.importBytes(file, { phrase: phrase.join(' ') }); assert.equal(x.get('cases', 'new'), null);
  const sync = { put: async () => { throw new Error('offline'); }, remove: async () => { throw new Error('offline'); } };
  const y = mk(undefined, { sync }); y.open(); await withBackup(y); const d = await y.disableBackup(); assert.equal(d.remote, 'failed');
  assert.equal((await y.syncNow()).skipped, 'backup-off');
});
test('sync failure is reported, never thrown, and the vault keeps working', async () => {
  const v = mk(undefined, { sync: { put: async () => { throw new Error('network down'); }, remove: async () => {} } }); v.open(); await withBackup(v);
  const r = await v.syncNow(); assert.equal(r.ok, false); assert.match(r.error, /network down/); v.put('cases', 'z', 'ok'); assert.equal(v.get('cases', 'z').toString(), 'ok');
});

test('wipe: confirmation required, every file gone, keys destroyed, next use starts a fresh empty vault', async () => {
  const dir = path.join(tmp(), 'v'), calls = [];
  const v = mk(dir, { sync: { put: async () => {}, remove: async (n) => calls.push(n) } }); v.open(); v.putJSON('cases', 'a', { t: 1 }); await withBackup(v);
  const oldId = v.meta.id, oldMvk = Buffer.from(v.mvk);
  await rejects(v.wipe({ confirm: 'no' }), 'bad-input'); assert.equal(v.status().state, 'unlocked');
  const r = await v.wipe({ confirm: 'WIPE' }); assert.equal(r.remote, 'removed'); assert.deepEqual(calls, ['ghost/vault-backup.mfvb']);
  assert.equal(fs.existsSync(dir), false); assert.equal(v.status().state, 'uninitialised');
  v.put('cases', 'n', 'fresh'); assert.notEqual(v.meta.id, oldId); assert.deepEqual(v.list('cases'), ['n']); assert.ok(!v.mvk.equals(oldMvk));
});
test('status never contains key material', async () => {
  const v = mk(); v.open(); const ph = await withBackup(v); const t = JSON.stringify(v.status());
  for (const k of [v.mvk.toString('hex'), v.mvk.toString('base64'), PASS, ph.join(' ')]) assert.equal(t.includes(k), false);
});
