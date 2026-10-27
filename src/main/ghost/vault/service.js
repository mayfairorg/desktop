'use strict';
// The vault as the Browser bridge sees it (group `ghost.vault.*`). The page never gets a key, a path or a file handle:
// it sends passphrases and words in, and gets status and the one-time recovery phrase back. Files are chosen in native dialogs.
const fs = require('node:fs');
const path = require('node:path');
const { Vault, VaultError } = require('./vault');
const { SecureIO } = require('./securefs');

const fail = (e) => ({ ok: false, code: e instanceof VaultError ? e.code : 'error', error: e instanceof VaultError ? e.message : 'Something went wrong with the vault.' });

class VaultService {
  // root: userData. safeStorage: Electron's. files: Mayfair Files adapter { put(name, Buffer), remove(name) } or null. onUnlock(): called after a locked vault opens.
  constructor({ root, safeStorage, dialog = null, getWindow = () => null, files = null, onUnlock = () => {}, vaultOptions = {} }) {
    this.root = root; this.dialog = dialog; this.getWindow = getWindow; this.onUnlock = onUnlock;
    this.vault = new Vault({ dir: path.join(root, 'ghost', 'vault'), safeStorage, sync: files, ...vaultOptions });
    this.startError = null;
    try { this.vault.open(); } catch (e) { this.startError = e; }   // a locked or unreadable vault is reported by status(), never a crash
    this.io = { state: new SecureIO(this.vault, 'connectors'), logs: new SecureIO(this.vault, 'scanlogs'), jobs: new SecureIO(this.vault, 'scanlogs') };
  }
  // Moves files an earlier build wrote in plain into the vault, then overwrites and deletes them.
  migratePlain() {
    if (!this.vault.unlocked) return 0;
    const g = path.join(this.root, 'ghost'); let n = 0;
    const move = (file, io, name) => { try { const t = fs.readFileSync(file, 'utf8'); io.write(name, t); n++; this._shred(file); } catch { /* not there */ } };
    move(path.join(g, 'state.json'), this.io.state, 'state.json');
    move(path.join(g, 'jobs.json'), this.io.jobs, 'jobs.json');
    for (const f of ['audit.jsonl', 'audit.jsonl.1']) { try { const t = fs.readFileSync(path.join(g, f), 'utf8'); for (const l of t.split('\n')) if (l) this.io.logs.append('audit.jsonl', l + '\n', { maxBytes: 5 * 1024 * 1024, keep: 2 }); n++; this._shred(path.join(g, f)); } catch { /* none */ } }
    const ld = path.join(g, 'logs');
    try {
      for (const f of fs.readdirSync(ld).sort().reverse()) { const t = fs.readFileSync(path.join(ld, f), 'utf8'); for (const l of t.split('\n')) if (l) this.io.logs.append('ghost.log', l + '\n', { maxBytes: 256 * 1024, keep: 4 }); n++; this._shred(path.join(ld, f)); }
    } catch { /* none */ }
    return n;
  }
  _shred(f) { try { const sz = fs.statSync(f).size; fs.writeFileSync(f, require('node:crypto').randomBytes(sz)); } catch { /* ignore */ } try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  _win(o) { const w = this.getWindow(); return w && !w.isDestroyed() ? [w, o] : [o]; }
  async _run(fn) { try { return { ok: true, ...(await fn()) }; } catch (e) { return fail(e); } }
  _status() { const s = this.vault.status(); if (this.startError && s.state === 'locked') s.note = this.startError.message; return s; }

  api() {
    if (this._api) return this._api;
    const v = this.vault;
    const afterUnlock = (r) => { if (v.unlocked) this.onUnlock(); return r; };
    return (this._api = {
      'ghost.vault.status': () => this._status(),
      'ghost.vault.unlock': (o) => this._run(async () => { await v.unlock(o || {}); afterUnlock(); return { status: this._status() }; }),
      'ghost.vault.lock': () => ({ ok: true, status: v.lock() }),
      'ghost.vault.backup.begin': (o) => this._run(async () => ({ ...(await v.beginBackup(o)), status: this._status() })),
      'ghost.vault.backup.confirm': (o) => this._run(async () => ({ status: v.confirmBackup(o) })),
      'ghost.vault.backup.cancel': () => ({ ok: true, status: v.cancelBackup() }),
      'ghost.vault.backup.disable': () => this._run(async () => { const r = await v.disableBackup(); return { remote: r.remote, status: this._status() }; }),
      'ghost.vault.backup.newPhrase': () => this._run(async () => ({ ...v.renewPhrase(), status: this._status() })),
      'ghost.vault.changePassphrase': (o) => this._run(async () => ({ status: await v.changePassphrase(o) })),
      'ghost.vault.resetPassphrase': (o) => this._run(async () => { const s = await v.resetPassphrase(o); afterUnlock(); return { status: s }; }),
      'ghost.vault.requirePassphrase': (on) => this._run(async () => ({ status: v.setRequirePassphrase(on) })),
      'ghost.vault.rotateKeys': (o) => this._run(async () => { const r = await v.rotateKeys(o || {}); return { phrase: r.phrase, challenge: r.challenge, records: r.rotated.records, status: this._status() }; }),
      'ghost.vault.syncNow': () => this._run(async () => ({ sync: await v.syncNow(), status: this._status() })),
      'ghost.vault.wipe': (o) => this._run(async () => { const r = await v.wipe(o); return { remote: r.remote, status: this._status() }; }),
      'ghost.vault.exportFile': () => this._run(async () => {
        if (!this.dialog) throw new VaultError('unavailable', 'No file dialog is available.');
        const bytes = v.exportBytes();
        const name = 'mayfair-ghost-vault-' + new Date().toISOString().slice(0, 10) + '.mfvb';
        const r = await this.dialog.showSaveDialog(...this._win({ title: 'Save encrypted vault file', defaultPath: name, filters: [{ name: 'Mayfair Ghost vault', extensions: ['mfvb'] }] }));
        if (r.canceled || !r.filePath) return { saved: false };
        fs.writeFileSync(r.filePath, bytes, { mode: 0o600 });
        return { saved: true, name: path.basename(r.filePath), bytes: bytes.length };
      }),
      'ghost.vault.importFile': (o) => this._run(async () => {
        if (!this.dialog) throw new VaultError('unavailable', 'No file dialog is available.');
        const r = await this.dialog.showOpenDialog(...this._win({ title: 'Choose a vault file', properties: ['openFile'], filters: [{ name: 'Mayfair Ghost vault', extensions: ['mfvb'] }] }));
        if (r.canceled || !r.filePaths[0]) return { imported: false };
        const st = fs.statSync(r.filePaths[0]); if (!st.isFile() || st.size > 512 * 1024 * 1024) throw new VaultError('format', 'That file is not a vault file.');
        const s = await v.importBytes(fs.readFileSync(r.filePaths[0]), o || {});
        afterUnlock();
        return { imported: true, records: s.imported, status: this._status() };
      }),
    });
  }
  shutdown() { this.vault.lock(); }
}
module.exports = { VaultService };
