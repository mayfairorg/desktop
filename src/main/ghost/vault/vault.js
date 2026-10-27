'use strict';
// Mayfair Ghost vault core. Key hierarchy:
//   device key (OS key store)  --wraps-->  master key (MVK, random 32 bytes)
//   passphrase KEK (Argon2id)  --wraps-->  MVK          (only when "Backup and passphrase" is on)
//   recovery-phrase KEK (HKDF) --wraps-->  MVK          (only when Backup is on)
//   MVK --seals--> keyring { current id, data keys (DEK) by id }
//   DEK --HKDF per namespace--> record keys; every record is AES-256-GCM with its own IV, bound to vault id + namespace + record id.
// Nothing secret is ever written unwrapped. meta.json holds only wrapped keys, KDF settings and timestamps.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { seal, open, peek, hkdf, wipe, VaultError } = require('./aead');
const bip = require('./bip39');
const kdf = require('./kdf');
const { DeviceKeyStore } = require('./keystore');

const NAMESPACES = ['cases', 'scanlogs', 'connectors', 'prefs'];      // what callers may use; '_vault' is internal
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SYNC_NAME = 'ghost/vault-backup.mfvb';
const EXPORT_MAGIC = 'MFVB1\n';
const b64 = (b) => Buffer.from(b).toString('base64'), unb64 = (s) => Buffer.from(String(s), 'base64');
const normPass = (s) => String(s).normalize('NFKC');

function shred(file) {
  try { const n = fs.statSync(file).size; const fd = fs.openSync(file, 'r+'); fs.writeSync(fd, crypto.randomBytes(Math.max(n, 1)), 0, Math.max(n, 1), 0); fs.fsyncSync(fd); fs.closeSync(fd); } catch { /* best effort: the key is destroyed as well */ }
  try { fs.rmSync(file, { force: true }); } catch { /* gone */ }
}
function atomicWrite(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, buf, { mode: 0o600 }); fs.renameSync(tmp, file);
}
function walk(dir) {
  const out = [];
  let es = []; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) { const f = path.join(dir, e.name); if (e.isDirectory()) out.push(...walk(f)); else out.push(f); }
  return out;
}

class Vault {
  // dir: <userData>/ghost/vault   safeStorage: Electron's (or a stand-in)   sync: { put(name, Buffer), remove(name) } for Mayfair Files, or null
  constructor({ dir, safeStorage = null, platform = process.platform, kdfParams = kdf.DEFAULT, allowWeakKdf = false, sync = null, syncDebounceMs = 3000, now = Date.now, identity } = {}) {
    if (!dir) throw new Error('vault: dir is required');
    this.dir = dir; this.metaFile = path.join(dir, 'meta.json'); this.dataDir = path.join(dir, 'data');
    this.ks = new DeviceKeyStore({ file: path.join(dir, 'device.key'), safeStorage, platform, ...(identity ? { identity } : {}) });
    this.kdfParams = kdf.check(kdfParams, allowWeakKdf); this.allowWeak = allowWeakKdf;
    this.syncAdapter = sync; this.debounce = syncDebounceMs; this.now = now;
    this.meta = null; this.mvk = null; this.keyring = null; this.nsKeys = new Map(); this.pending = null;
    this.timer = null; this.syncGen = 0; this.lastSync = null;
  }

  // ---------- lifecycle ----------
  get unlocked() { return !!this.mvk; }
  _meta() { if (!this.meta) { try { this.meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')); } catch { this.meta = null; } } return this.meta; }
  _writeMeta() { atomicWrite(this.metaFile, JSON.stringify(this.meta, null, 1)); }
  ensure() { if (!this.mvk && !this._meta()) this.open(); }   // after a wipe the next use silently starts a new vault
  _need() { this.ensure(); if (!this.mvk) throw new VaultError('locked', 'The vault is locked.'); }
  _ctx(kind) { return `mf-vault-${kind}|${this.meta.id}`; }

  // Silent start: creates the vault on first use with no questions, otherwise unlocks with the device key.
  open() {
    if (!this._meta()) this._create();
    else if (!this.mvk && this.meta.deviceWrap) this._unlockDevice();
    return this.status();
  }
  _create() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const id = crypto.randomUUID(), mvk = crypto.randomBytes(32), dek = crypto.randomBytes(32), dk = this.ks.create();
    this.meta = { v: 1, id, created: new Date(this.now()).toISOString(), rotated: null, deviceWrap: null, passWrap: null, phraseWrap: null, keyring: null };
    this.keyring = { current: 1, keys: { 1: dek } };
    this.meta.deviceWrap = b64(seal(dk, mvk, this._ctx('wrap-device')));
    this.meta.keyring = b64(this._sealKeyring(mvk));
    this._writeMeta(); wipe(dk);
    this.mvk = mvk; this.nsKeys.clear();
    this._setState({ backupSince: null });
  }
  _sealKeyring(mvk, kr = this.keyring) {
    const o = { current: kr.current, keys: Object.fromEntries(Object.entries(kr.keys).map(([k, v]) => [k, b64(v)])) };
    return seal(mvk, Buffer.from(JSON.stringify(o)), this._ctx('keyring'));
  }
  _install(mvk) {
    let kr;
    try { kr = JSON.parse(open(mvk, unb64(this.meta.keyring), this._ctx('keyring')).toString()); } catch { throw new VaultError('tamper', 'The vault key table did not verify. The vault file has been changed or damaged.'); }
    this.keyring = { current: kr.current, keys: Object.fromEntries(Object.entries(kr.keys).map(([k, v]) => [Number(k), unb64(v)])) };
    this.mvk = mvk; this.nsKeys.clear();
  }
  _unlockDevice() {
    let dk = this.ks.load();
    const tryWrap = (key) => { try { return open(key, unb64(this.meta.deviceWrap), this._ctx('wrap-device')); } catch { return null; } };
    let mvk = dk && tryWrap(dk);
    if (!mvk && this.ks.hasStaged()) { const sk = this.ks.loadStaged(); mvk = sk && tryWrap(sk); if (mvk) this.ks.commit(); }   // a key replacement that was interrupted after the vault file was written
    if (!mvk) throw new VaultError(dk ? 'tamper' : 'device-key', dk ? 'The vault key did not verify. The vault file has been changed or damaged.' : 'The device key is missing. Unlock with your passphrase or recovery phrase if Backup is on.');
    this._install(mvk);
  }
  async unlock({ passphrase, phrase } = {}) {
    if (!this._meta()) { this.open(); return this.status(); }
    if (this.mvk) return this.status();
    if (passphrase !== undefined) {
      const w = this.meta.passWrap; if (!w) throw new VaultError('backup-off', 'No passphrase has been set for this vault.');
      const key = await kdf.deriveKey(normPass(passphrase), unb64(w.salt), kdf.check(w.kdf, this.allowWeak), { allowWeak: this.allowWeak });
      let mvk; try { mvk = open(key, unb64(w.env), this._ctx('wrap-pass')); } catch { throw new VaultError('wrong-secret', 'Wrong passphrase, or the vault file has been changed.'); } finally { wipe(key); }
      this._install(mvk);
    } else if (phrase !== undefined) {
      const w = this.meta.phraseWrap; if (!w) throw new VaultError('backup-off', 'No recovery phrase has been set for this vault.');
      const ent = bip.fromWords(phrase);
      if (w.list !== bip.listId()) throw new VaultError('bad-phrase', 'This vault was made with a different word list.');
      const key = hkdf(ent, 'mf-vault-phrase-kek', unb64(w.salt));
      let mvk; try { mvk = open(key, unb64(w.env), this._ctx('wrap-phrase')); } catch { throw new VaultError('wrong-secret', 'That is not the recovery phrase for this vault.'); } finally { wipe(key); wipe(ent); }
      this._install(mvk);
    } else {
      if (!this.meta.deviceWrap) throw new VaultError('passphrase-required', 'This vault asks for the passphrase to unlock.');
      this._unlockDevice();
    }
    return this.status();
  }
  lock() {
    wipe(this.mvk); if (this.keyring) for (const k of Object.values(this.keyring.keys)) wipe(k);
    for (const k of this.nsKeys.values()) wipe(k);
    this.mvk = null; this.keyring = null; this.nsKeys.clear(); this.pending = null;
    clearTimeout(this.timer); this.timer = null;
    return this.status();
  }

  status() {
    const m = this._meta();
    const base = { state: !m ? 'uninitialised' : this.mvk ? 'unlocked' : 'locked', kdf: kdf.implementation(), format: 'MFV1 / AES-256-GCM' };
    if (!m) return { ...base, ...this.ks.describe(this.ks.osUsable() ? 'os' : 'file'), backup: { on: false, pending: false }, requirePassphrase: false, counts: {} };
    const counts = {}; for (const ns of [...NAMESPACES]) { try { counts[ns] = fs.readdirSync(path.join(this.dataDir, ns)).filter((f) => f.endsWith('.mfv')).length; } catch { counts[ns] = 0; } }
    return { ...base, ...this.ks.describe(), created: m.created, rotated: m.rotated, keyId: this.keyring ? this.keyring.current : null,
      backup: { on: !!(m.passWrap && m.phraseWrap), passphraseSet: !!m.passWrap, phraseSet: !!m.phraseWrap, pending: !!this.pending, challenge: this.pending ? this.pending.challenge : null, lastSync: this.lastSync, syncTarget: !!this.syncAdapter },
      requirePassphrase: !m.deviceWrap, counts };
  }
  get backupOn() { const m = this._meta(); return !!(m && m.passWrap && m.phraseWrap); }

  // ---------- records ----------
  _nsKey(ns, keyId) {
    const k = `${keyId}|${ns}`; let v = this.nsKeys.get(k);
    if (!v) { const dek = this.keyring.keys[keyId]; if (!dek) throw new VaultError('tamper', 'A record uses a key that is not in the vault.'); v = hkdf(dek, 'mf-vault-ns|' + ns); this.nsKeys.set(k, v); }
    return v;
  }
  _file(ns, id) {
    if (!(NAMESPACES.includes(ns) || ns === '_vault') || !ID_RE.test(String(id)) || String(id).startsWith('.')) throw new VaultError('bad-input', 'bad record name');
    return path.join(this.dataDir, ns, id + '.mfv');
  }
  _recCtx(ns, id) { return `mf-vault-rec|${this.meta.id}|${ns}|${id}`; }
  _put(ns, id, buf, quiet) {
    this._need();
    atomicWrite(this._file(ns, id), seal(this._nsKey(ns, this.keyring.current), buf, this._recCtx(ns, id), this.keyring.current));
    if (!quiet) this._dirty();
  }
  put(ns, id, data) { this._pub(ns); this._put(ns, id, Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')); }
  putJSON(ns, id, obj) { this.put(ns, id, JSON.stringify(obj)); }
  get(ns, id) { this._pub(ns); return this._get(ns, id); }
  _pub(ns) { if (!NAMESPACES.includes(ns)) throw new VaultError('bad-input', 'bad record name'); }
  _get(ns, id) {
    this._need();
    let env; try { env = fs.readFileSync(this._file(ns, id)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { return open(this._nsKey(ns, peek(env).keyId), env, this._recCtx(ns, id)); }
    catch (e) { if (e.code === 'auth' || e.code === 'format') throw new VaultError('tamper', `The ${ns} record "${id}" did not verify: it has been changed, damaged, or moved.`); throw e; }
  }
  getJSON(ns, id) { const b = this.get(ns, id); return b === null ? null : JSON.parse(b.toString('utf8')); }
  list(ns) { this._pub(ns); this._need(); this._file(ns, 'x'); try { return fs.readdirSync(path.join(this.dataDir, ns)).filter((f) => f.endsWith('.mfv')).map((f) => f.slice(0, -4)).sort(); } catch { return []; } }
  remove(ns, id) { this._pub(ns); this._need(); shred(this._file(ns, id)); this._dirty(); }
  _state() { try { const b = this._get('_vault', 'state'); return b ? JSON.parse(b.toString()) : {}; } catch { return {}; } }
  _setState(patch) { this._put('_vault', 'state', Buffer.from(JSON.stringify({ ...this._state(), ...patch })), true); }

  // ---------- backup and passphrase ----------
  async _passWrap(passphrase, mvk) {
    const salt = crypto.randomBytes(16), params = this.kdfParams;
    const key = await kdf.deriveKey(normPass(passphrase), salt, params, { allowWeak: this.allowWeak });
    const env = seal(key, mvk, this._ctx('wrap-pass')); wipe(key);
    return { kdf: params, salt: b64(salt), env: b64(env) };
  }
  _phrasePending(kind, mvk = this.mvk) {
    const g = bip.generate(), salt = crypto.randomBytes(16), key = hkdf(g.entropy, 'mf-vault-phrase-kek', salt);
    const wrap = { salt: b64(salt), env: b64(seal(key, mvk, this._ctx('wrap-phrase'))), list: bip.listId() }; wipe(key);
    const pos = []; while (pos.length < 3) { const p = crypto.randomInt(1, 13); if (!pos.includes(p)) pos.push(p); }
    pos.sort((a, b) => a - b);
    return { kind, wrap, words: g.words, challenge: pos, tries: 0 };
  }
  _checkPass(p) { if (typeof p !== 'string' || p.normalize('NFKC').length < 10) throw new VaultError('weak-passphrase', 'Use a passphrase of at least 10 characters (a few words together works well).'); }
  // Step 1: returns the 12 words once. Nothing is switched on until confirmBackup().
  async beginBackup({ passphrase } = {}) {
    this._need(); this._checkPass(passphrase);
    if (this.backupOn) throw new VaultError('already-on', 'Backup is already on.');
    const passWrap = await this._passWrap(passphrase, this.mvk);
    this.pending = { ...this._phrasePending('enable'), passWrap };
    return { phrase: this.pending.words.slice(), challenge: this.pending.challenge };
  }
  // Step 2: the person re-enters three of the words ({ "3": "word", ... }).
  confirmBackup({ answers } = {}) {
    this._need(); const p = this.pending; if (!p) throw new VaultError('no-pending', 'There is no recovery phrase waiting to be confirmed.');
    const ok = answers && p.challenge.every((n) => typeof answers[n] === 'string' && bip.normalise(answers[n])[0] === p.words[n - 1]);
    if (!ok) {
      if (++p.tries >= 5) { this.pending = null; throw new VaultError('confirm-failed', 'Too many wrong answers. Start again to get a new phrase.'); }
      throw new VaultError('confirm-failed', 'Those words do not match. Check the phrase you wrote down.');
    }
    if (p.passWrap) this.meta.passWrap = p.passWrap;
    this.meta.phraseWrap = p.wrap; this._writeMeta(); this.pending = null;
    this._setState({ backupSince: new Date(this.now()).toISOString() });
    this._dirty(true);
    return this.status();
  }
  cancelBackup() { this.pending = null; return this.status(); }
  // A new recovery phrase (the old one stops working once the new one is confirmed). Needs Backup on.
  renewPhrase() {
    this._need(); if (!this.meta.passWrap) throw new VaultError('backup-off', 'Turn Backup on first.');
    this.pending = this._phrasePending('phrase'); return { phrase: this.pending.words.slice(), challenge: this.pending.challenge };
  }
  async _verifyPass(passphrase) {
    const w = this.meta.passWrap; if (!w) throw new VaultError('backup-off', 'Backup is off.');
    const key = await kdf.deriveKey(normPass(passphrase), unb64(w.salt), kdf.check(w.kdf, this.allowWeak), { allowWeak: this.allowWeak });
    try { open(key, unb64(w.env), this._ctx('wrap-pass')); } catch { throw new VaultError('wrong-secret', 'Wrong passphrase.'); } finally { wipe(key); }
  }
  async changePassphrase({ oldPassphrase, newPassphrase } = {}) {
    this._need(); this._checkPass(newPassphrase); await this._verifyPass(oldPassphrase);
    this.meta.passWrap = await this._passWrap(newPassphrase, this.mvk); this._writeMeta(); this._dirty(true);
    return this.status();
  }
  // Locked and forgotten the passphrase: the recovery phrase unlocks, then a new passphrase is set.
  async resetPassphrase({ phrase, newPassphrase } = {}) {
    this._checkPass(newPassphrase);
    if (!this.mvk) await this.unlock({ phrase });
    this.meta.passWrap = await this._passWrap(newPassphrase, this.mvk); this._writeMeta(); this._dirty(true);
    return this.status();
  }
  // Turning Backup off stops sync, asks Mayfair Files to delete the copy, and replaces every key so the old passphrase, phrase and downloaded files no longer open anything written from now on.
  async disableBackup() {
    this._need(); const was = this.backupOn || !!this.meta.passWrap; this.pending = null;
    this.syncGen++; clearTimeout(this.timer); this.timer = null;
    await this._rotateAll();
    let remote = 'none';
    if (was && this.syncAdapter) { try { await this.syncAdapter.remove(SYNC_NAME); remote = 'removed'; } catch { remote = 'failed'; } }
    this.lastSync = null;
    return { ...this.status(), remote };
  }
  // true: no vault unlock without the passphrase (the device key is destroyed). false: device key is used again.
  setRequirePassphrase(on) {
    this._need();
    if (on) {
      if (!this.backupOn) throw new VaultError('backup-off', 'Turn Backup and passphrase on first.');
      this.meta.deviceWrap = null; this._writeMeta(); this.ks.destroy();
    } else if (!this.meta.deviceWrap) {
      const dk = this.ks.create(); this.meta.deviceWrap = b64(seal(dk, this.mvk, this._ctx('wrap-device'))); this._writeMeta(); wipe(dk);
    }
    return this.status();
  }

  // ---------- key rotation ----------
  // Replaces the data key, the master key and the device key, re-encrypting every record. With Backup on the passphrase is needed again
  // (to re-wrap the master key); the old recovery phrase stops working and a new one is returned for confirmation.
  async rotateKeys({ passphrase } = {}) {
    this._need();
    const withBackup = !!this.meta.passWrap;
    if (withBackup) {
      if (typeof passphrase !== 'string') throw new VaultError('passphrase-required', 'Enter your passphrase to rotate keys while Backup is on.');
      await this._verifyPass(passphrase);
    }
    const r = await this._rotateAll({ passphrase: withBackup ? passphrase : undefined, keepRequire: !this.meta.deviceWrap });
    if (withBackup) { this.pending = this._phrasePending('phrase'); return { ...this.status(), rotated: r, phrase: this.pending.words.slice(), challenge: this.pending.challenge }; }
    this._dirty();
    return { ...this.status(), rotated: r };
  }
  async _rotateAll({ passphrase, keepRequire = false } = {}) {
    const oldMvk = this.mvk, oldKr = this.keyring, newMvk = crypto.randomBytes(32), newDek = crypto.randomBytes(32), newId = oldKr.current + 1;
    // A: both data keys valid under the old master key, so a crash while re-encrypting loses nothing
    const both = { current: newId, keys: { ...oldKr.keys, [newId]: newDek } };
    this.meta.keyring = b64(this._sealKeyring(oldMvk, both)); this._writeMeta();
    this.keyring = both; this.nsKeys.clear();
    let n = 0;
    for (const ns of [...NAMESPACES, '_vault']) for (const f of (() => { try { return fs.readdirSync(path.join(this.dataDir, ns)); } catch { return []; } })()) {
      if (!f.endsWith('.mfv')) continue;
      const id = f.slice(0, -4), plain = this._get(ns, id); this._put(ns, id, plain, true); wipe(plain); n++;
    }
    // C: one meta write moves everything to the new master key
    const nk = { current: newId, keys: { [newId]: newDek } };
    const pw = passphrase !== undefined ? await this._passWrap(passphrase, newMvk) : null;
    const next = { ...this.meta, keyring: b64(this._sealKeyring(newMvk, nk)), rotated: new Date(this.now()).toISOString(), passWrap: pw, phraseWrap: null };
    let stagedKey = null;
    if (!keepRequire) { stagedKey = this.ks.stage(); next.deviceWrap = b64(seal(stagedKey, newMvk, `mf-vault-wrap-device|${this.meta.id}`)); }
    else next.deviceWrap = null;
    this.meta = next; this._writeMeta();
    if (stagedKey) { this.ks.commit(); wipe(stagedKey); }
    wipe(oldMvk); for (const k of Object.values(oldKr.keys)) wipe(k);
    this.mvk = newMvk; this.keyring = { current: newId, keys: { [newId]: newDek } }; this.nsKeys.clear();
    return { records: n, keyId: newId };
  }

  // ---------- download and restore ----------
  exportBytes() {
    this._need(); const m = this.meta;
    if (!(m.passWrap && m.phraseWrap)) throw new VaultError('backup-off', 'Turn on Backup and passphrase to download an encrypted vault file.');
    const records = {};
    for (const ns of [...NAMESPACES, '_vault']) {
      let fs_ = []; try { fs_ = fs.readdirSync(path.join(this.dataDir, ns)).filter((f) => f.endsWith('.mfv')).sort(); } catch { /* none */ }
      if (fs_.length) records[ns] = Object.fromEntries(fs_.map((f) => [f.slice(0, -4), b64(fs.readFileSync(path.join(this.dataDir, ns, f)))]));
    }
    const body = JSON.stringify({ v: 1, id: m.id, created: m.created, passWrap: m.passWrap, phraseWrap: m.phraseWrap, keyring: m.keyring, records });
    const mac = crypto.createHmac('sha256', hkdf(this.mvk, 'mf-vault-export-mac')).update(body).digest();
    return Buffer.from(EXPORT_MAGIC + JSON.stringify({ body, mac: b64(mac) }));
  }
  // Checks everything first (secret, file MAC, key table, every record) and only then replaces the vault's contents.
  async importBytes(buf, { passphrase, phrase, replace = false } = {}) {
    if (!Buffer.isBuffer(buf) || buf.length > 512 * 1024 * 1024 || buf.subarray(0, EXPORT_MAGIC.length).toString() !== EXPORT_MAGIC) throw new VaultError('format', 'This is not a Mayfair Ghost vault file.');
    let outer, body;
    try { outer = JSON.parse(buf.subarray(EXPORT_MAGIC.length).toString('utf8')); body = JSON.parse(outer.body); } catch { throw new VaultError('format', 'The vault file is damaged.'); }
    if (body.v !== 1 || !body.id || !body.keyring || !body.passWrap || !body.phraseWrap) throw new VaultError('version', 'This vault file version is not supported.');
    if (this._meta() === null) this.open();
    if (!replace && this.mvk && (NAMESPACES.some((ns) => this.list(ns).length))) throw new VaultError('would-replace', 'This vault already holds data. Importing replaces it: confirm to continue.');
    const ctx = (k) => `mf-vault-${k}|${body.id}`;
    let mvk;
    if (passphrase !== undefined) {
      const w = body.passWrap, key = await kdf.deriveKey(normPass(passphrase), unb64(w.salt), kdf.check(w.kdf, this.allowWeak), { allowWeak: this.allowWeak });
      try { mvk = open(key, unb64(w.env), ctx('wrap-pass')); } catch { throw new VaultError('wrong-secret', 'Wrong passphrase, or the vault file has been changed.'); } finally { wipe(key); }
    } else if (phrase !== undefined) {
      const ent = bip.fromWords(phrase), w = body.phraseWrap;
      if (w.list !== bip.listId()) throw new VaultError('bad-phrase', 'This file was made with a different word list.');
      const key = hkdf(ent, 'mf-vault-phrase-kek', unb64(w.salt));
      try { mvk = open(key, unb64(w.env), ctx('wrap-phrase')); } catch { throw new VaultError('wrong-secret', 'That is not the recovery phrase for this vault file.'); } finally { wipe(key); wipe(ent); }
    } else throw new VaultError('bad-input', 'Give the passphrase or the recovery phrase.');
    const want = crypto.createHmac('sha256', hkdf(mvk, 'mf-vault-export-mac')).update(outer.body).digest(), got = unb64(outer.mac);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw new VaultError('tamper', 'The vault file has been changed or is incomplete.');
    let kr;
    try { const o = JSON.parse(open(mvk, unb64(body.keyring), ctx('keyring')).toString()); kr = { current: o.current, keys: Object.fromEntries(Object.entries(o.keys).map(([k, v]) => [Number(k), unb64(v)])) }; }
    catch { throw new VaultError('tamper', 'The vault file has been changed or is damaged.'); }
    const files = [];
    for (const [ns, recs] of Object.entries(body.records || {})) {
      if (!NAMESPACES.includes(ns) && ns !== '_vault') throw new VaultError('tamper', 'The vault file holds an unknown section.');
      for (const [id, v] of Object.entries(recs)) {
        if (!ID_RE.test(id) || id.startsWith('.')) throw new VaultError('tamper', 'The vault file holds a bad record name.');
        const env = unb64(v), dek = kr.keys[peek(env).keyId];
        if (!dek) throw new VaultError('tamper', 'A record uses a missing key.');
        try { open(hkdf(dek, 'mf-vault-ns|' + ns), env, `mf-vault-rec|${body.id}|${ns}|${id}`); } catch { throw new VaultError('tamper', `The record "${id}" in the vault file did not verify.`); }
        files.push([ns, id, env]);
      }
    }
    // install
    this.syncGen++; clearTimeout(this.timer);
    const stage = this.dataDir + '.import';
    fs.rmSync(stage, { recursive: true, force: true });
    for (const [ns, id, env] of files) atomicWrite(path.join(stage, ns, id + '.mfv'), env);
    const dk = this.ks.load() || this.ks.create();
    const keep = this.meta;
    this.meta = { v: 1, id: body.id, created: body.created, rotated: new Date(this.now()).toISOString(), deviceWrap: null, passWrap: body.passWrap, phraseWrap: body.phraseWrap, keyring: body.keyring };
    this.meta.deviceWrap = b64(seal(dk, mvk, ctx('wrap-device'))); wipe(dk);
    const old = this.dataDir + '.old'; fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(this.dataDir)) fs.renameSync(this.dataDir, old);
    fs.mkdirSync(stage, { recursive: true }); fs.renameSync(stage, this.dataDir);
    this._writeMeta();
    for (const f of walk(old)) shred(f); fs.rmSync(old, { recursive: true, force: true });
    void keep;
    this.mvk = null; this._install(mvk);
    this.pending = null;
    this._dirty(true);
    return { ...this.status(), imported: files.length };
  }

  // ---------- sync to Mayfair Files (only while Backup is on) ----------
  _dirty(now = false) {
    if (!this.backupOn || !this.syncAdapter) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.syncNow().catch(() => {}); }, now ? 0 : this.debounce);
    if (this.timer.unref) this.timer.unref();
  }
  async syncNow() {
    if (!this.backupOn) return { ok: false, skipped: 'backup-off' };
    if (!this.syncAdapter) return { ok: false, skipped: 'no-target' };
    if (!this.mvk) return { ok: false, skipped: 'locked' };
    const gen = this.syncGen, bytes = this.exportBytes();
    try {
      if (gen !== this.syncGen || !this.backupOn) return { ok: false, skipped: 'backup-off' };
      await this.syncAdapter.put(SYNC_NAME, bytes);
      this.lastSync = { at: new Date(this.now()).toISOString(), ok: true, bytes: bytes.length };
    } catch (e) { this.lastSync = { at: new Date(this.now()).toISOString(), ok: false, error: String(e && e.message || e).slice(0, 200) }; }
    return { ok: !!this.lastSync.ok, ...this.lastSync };
  }

  // ---------- wipe ----------
  async wipe({ confirm } = {}) {
    if (confirm !== 'WIPE') throw new VaultError('bad-input', 'Type WIPE to confirm.');
    const had = this.backupOn; this.syncGen++;
    this.lock();
    for (const f of walk(this.dir)) shred(f);
    this.ks.destroy();
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.meta = null; this.lastSync = null;
    let remote = 'none';
    if (had && this.syncAdapter) { try { await this.syncAdapter.remove(SYNC_NAME); remote = 'removed'; } catch { remote = 'failed'; } }
    return { ok: true, remote };
  }
}
module.exports = { Vault, VaultError, NAMESPACES, SYNC_NAME };
