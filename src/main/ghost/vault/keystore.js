'use strict';
// The per-device key: 32 random bytes that wrap the vault's master key.
//   mode "os":   Electron safeStorage (Windows DPAPI, macOS Keychain, Linux libsecret/kwallet). The file holds only the OS-encrypted blob.
//   mode "file": used only when the OS offers no usable secure store (no safeStorage, or the Linux "basic_text" backend, which is a fixed password).
//                The key is sealed under a key derived from the user name, host name and a random salt: this stops copying the folder to another
//                account or machine, and nothing more. Any program running as the same user can reproduce it. The status says so in plain words.
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { seal, open, hkdf, VaultError } = require('./aead');

const MSG = {
  os: 'The vault key is protected by this computer\'s secure key store.',
  file: 'This computer has no secure key store available, so the vault key is protected only by file permissions and a machine-bound seal. Anyone who can run programs as you on this computer can read the vault. Turn on "Backup and passphrase" and "Ask for the passphrase to unlock" for stronger protection.',
};
class DeviceKeyStore {
  constructor({ file, safeStorage = null, platform = process.platform, identity = () => `${os.userInfo().username}|${os.hostname()}|${platform}` }) {
    this.file = file; this.ss = safeStorage; this.platform = platform; this.identity = identity;
  }
  osUsable() {
    try {
      if (!this.ss || typeof this.ss.isEncryptionAvailable !== 'function' || !this.ss.isEncryptionAvailable()) return false;
      if (this.platform === 'linux' && typeof this.ss.getSelectedStorageBackend === 'function' && this.ss.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    } catch { return false; }
  }
  exists() { return fs.existsSync(this.file); }
  mode() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).mode; } catch { return this.osUsable() ? 'os' : 'file'; }
  }
  describe(mode = this.mode()) { return { protection: mode === 'os' ? 'os' : 'file-permissions', message: MSG[mode === 'os' ? 'os' : 'file'] }; }
  _fileKey(salt) { return hkdf(Buffer.from(this.identity()), 'mf-vault-device-file', salt); }
  create() {
    const key = crypto.randomBytes(32);
    this._write(key);
    return key;
  }
  // stage a replacement without touching the live file; commit() renames it
  stage() { const key = crypto.randomBytes(32); this._write(key, this.file + '.new'); return key; }
  commit() { fs.renameSync(this.file + '.new', this.file); }
  _write(key, file = this.file) {
    let rec;
    if (this.osUsable()) rec = { v: 1, mode: 'os', data: this.ss.encryptString(key.toString('base64')).toString('base64') };
    else { const salt = crypto.randomBytes(32); rec = { v: 1, mode: 'file', salt: salt.toString('base64'), data: seal(this._fileKey(salt), key, 'mf-vault-device-file').toString('base64') }; }
    fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(rec), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  loadStaged() { return this.load(this.file + '.new'); }
  hasStaged() { return fs.existsSync(this.file + '.new'); }
  load(file = this.file) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    try {
      if (rec.mode === 'os') {
        if (!this.osUsable()) throw new Error('os store unavailable');
        return Buffer.from(this.ss.decryptString(Buffer.from(rec.data, 'base64')), 'base64');
      }
      return open(this._fileKey(Buffer.from(rec.salt, 'base64')), Buffer.from(rec.data, 'base64'), 'mf-vault-device-file');
    } catch {
      throw new VaultError('device-key', 'This computer\'s key store could not release the vault key (the OS account or key store changed). Unlock with your passphrase or recovery phrase if Backup is on.');
    }
  }
  destroy() {
    for (const f of [this.file, this.file + '.new', this.file + '.tmp']) {
      try { const n = fs.statSync(f).size; fs.writeFileSync(f, crypto.randomBytes(n)); } catch { /* none */ }
      try { fs.rmSync(f, { force: true }); } catch { /* none */ }
    }
  }
}
module.exports = { DeviceKeyStore, MSG };
