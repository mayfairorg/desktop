'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { blake2b } = require('../src/main/ghost/vault/blake2b');
const { argon2id } = require('../src/main/ghost/vault/argon2id');
const { seal, open, peek, VaultError } = require('../src/main/ghost/vault/aead');
const bip = require('../src/main/ghost/vault/bip39');
const kdf = require('../src/main/ghost/vault/kdf');

test('blake2b matches node for many lengths', () => {
  for (const n of [0, 1, 127, 128, 129, 300, 1028]) { const d = crypto.randomBytes(n); assert.ok(blake2b(d, 64).equals(crypto.createHash('blake2b512').update(d).digest())); }
});
test('argon2id matches the RFC 9106 test vector', () => {
  const r = argon2id({ password: Buffer.alloc(32, 1), salt: Buffer.alloc(16, 2), secret: Buffer.alloc(8, 3), ad: Buffer.alloc(12, 4), t: 3, m: 32, p: 4, dkLen: 32 });
  assert.equal(r.toString('hex'), '0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
});
test('argon2id: same input same key, other salt or password other key', () => {
  const a = (pw, s) => argon2id({ password: pw, salt: Buffer.alloc(16, s), t: 1, m: 64, p: 1 }).toString('hex');
  assert.equal(a('x', 1), a('x', 1)); assert.notEqual(a('x', 1), a('x', 2)); assert.notEqual(a('x', 1), a('y', 1));
});
test('kdf worker path gives the same key as inline', async () => {
  const salt = Buffer.alloc(16, 5), p = { m: 64, t: 1, p: 1 };
  const k = await kdf.deriveKey('pass phrase', salt, p, { allowWeak: true, prefer: 'js' });
  assert.ok(k.equals(argon2id({ password: Buffer.from('pass phrase'), salt, ...p, dkLen: 32 })));
  assert.match(kdf.implementation(), /pure JS|argon2|hash-wasm/);
});
test('kdf refuses out-of-range settings (including weak ones from an imported file)', () => {
  for (const p of [{ m: 64, t: 1, p: 1 }, { m: 1 << 30, t: 1, p: 1 }, { m: 65536, t: 99, p: 1 }, { m: 65536, t: 3, p: 9 }, null]) assert.throws(() => kdf.check(p, false), (e) => e.code === 'bad-kdf');
  assert.deepEqual(kdf.check(kdf.DEFAULT, false), kdf.DEFAULT);
});
test('aead: round trip, header, wrong key, wrong context, tamper anywhere, truncation, version', () => {
  const key = crypto.randomBytes(32), env = seal(key, Buffer.from('secret case'), 'ctx-a', 7);
  assert.deepEqual(peek(env), { version: 1, alg: 1, keyId: 7 });
  assert.equal(open(key, env, 'ctx-a').toString(), 'secret case');
  assert.equal(env.includes(Buffer.from('secret case')), false);
  assert.throws(() => open(crypto.randomBytes(32), env, 'ctx-a'), (e) => e.code === 'auth');
  assert.throws(() => open(key, env, 'ctx-b'), (e) => e.code === 'auth');
  for (let i = 0; i < env.length; i++) { const t = Buffer.from(env); t[i] ^= 1; assert.throws(() => open(key, t, 'ctx-a'), VaultError, 'byte ' + i); }
  assert.throws(() => open(key, env.subarray(0, env.length - 1), 'ctx-a'));
  const v2 = Buffer.from(env); v2[4] = 2; assert.throws(() => open(key, v2, 'ctx-a'), (e) => e.code === 'version');
  assert.notDeepEqual(seal(key, Buffer.from('x'), 'c'), seal(key, Buffer.from('x'), 'c'), 'fresh IV every time');
});
test('bip39 construction: 12 words, round trip, checksum, unknown word, list shape', () => {
  const L = bip.words(); assert.equal(L.length, 2048); assert.equal(new Set(L).size, 2048);
  assert.equal(new Set(L.map((w) => w.slice(0, 4))).size, 2048);
  for (let i = 0; i < 50; i++) { const g = bip.generate(); assert.equal(g.words.length, 12); assert.ok(bip.fromWords(g.words.join('  ').toUpperCase()).equals(g.entropy)); }
  const g = bip.generate(); let rejected = 0;   // a wrong word still passes the 4-bit checksum about 1 time in 16, so try several
  for (let k = 1; k <= 12; k++) { const bad = g.words.slice(); bad[3] = L[(L.indexOf(bad[3]) + k) % 2048]; try { bip.fromWords(bad); } catch (e) { if (e.code === 'bad-phrase') rejected++; } }
  assert.ok(rejected >= 6, 'a changed word is caught by the checksum most of the time');
  assert.throws(() => bip.fromWords(g.words.slice(0, 11)), (e) => e.code === 'bad-phrase');
  assert.throws(() => bip.fromWords(['zzzzzz', ...g.words.slice(1)]), (e) => e.code === 'bad-phrase');
  assert.deepEqual(bip.toWords(Buffer.alloc(16, 0)).length, 12);
});
