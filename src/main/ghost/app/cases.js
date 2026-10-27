'use strict';
// Ghost case store: every case is a record in the Ghost vault (section "cases"), sealed with AES-256-GCM before it touches the disk. The page sends and receives the
// case as JSON text; main parses it, runs the same validation the page uses (the provenance rule) and only then writes. 20 rolling backups per case.
// Delete overwrites the sealed files with random bytes before removing them (vault.remove).
const crypto = require('node:crypto');
const M = require('../../../ui/ghost/case-model');

const NS = 'cases';
const MAX_BYTES = 32 * 1024 * 1024;
const BACKUPS = 20;
const BACKUP_EVERY_MS = 5 * 60 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

class CaseError extends Error { constructor(code, message) { super(message); this.code = code; } }
const rec = (id) => 'case-' + id;
const bak = (id, t) => 'bak-' + id + '-' + String(t).padStart(14, '0');

class CaseStore {
  constructor({ vault, now = Date.now }) { this.vault = vault; this.now = now; this.lastBackup = new Map(); }
  _ready() { this.vault.ensure(); if (!this.vault.unlocked) throw new CaseError('locked', 'The vault is locked.'); }
  _read(id) { const b = this.vault.get(NS, rec(id)); return b === null ? null : b.toString('utf8'); }
  _ids() { return this.vault.list(NS).filter((n) => n.startsWith('case-')).map((n) => n.slice(5)); }
  list() {
    this._ready(); const out = [];
    for (const id of this._ids()) {
      try { const c = JSON.parse(this._read(id)); const s = M.stats(c); out.push({ id, title: String(c.title || '').slice(0, 200), created: c.created, updated: c.updated, entities: s.entities, sources: s.sources }); }
      catch { out.push({ id, title: '(unreadable case)', created: null, updated: null, entities: 0, sources: 0, broken: true }); }
    }
    return out.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')));
  }
  get(id) { this._ready(); this._id(id); const t = this._read(id); if (t === null) throw new CaseError('missing', 'That case was not found.'); return t; }
  _id(id) { if (typeof id !== 'string' || !ID_RE.test(id)) throw new CaseError('bad-id', 'That is not a case id.'); }
  // json: the case as text. The id inside must equal `id`.
  put(id, json) {
    this._ready(); this._id(id);
    if (typeof json !== 'string' || json.length > MAX_BYTES) throw new CaseError('too-large', 'That case is too large to store.');
    let c; try { c = JSON.parse(json); } catch { throw new CaseError('bad-case', 'The case could not be read.'); }
    if (!c || c.id !== id) throw new CaseError('bad-case', 'The case does not match its id.');
    const problems = M.validate(c);
    if (problems.length) throw new CaseError('invalid', problems[0] + (problems.length > 1 ? ' (and ' + (problems.length - 1) + ' more)' : ''));
    const t = this.now(), last = this.lastBackup.get(id) || 0;
    if (t - last >= BACKUP_EVERY_MS) { const prev = this._read(id); if (prev !== null && prev !== json) { this.vault.put(NS, bak(id, t), prev); this.lastBackup.set(id, t); this._trim(id); } }
    this.vault.put(NS, rec(id), json);
    return { id, bytes: json.length, savedAt: new Date(t).toISOString() };
  }
  _trim(id) { const p = 'bak-' + id + '-'; const all = this.vault.list(NS).filter((n) => n.startsWith(p)).sort(); while (all.length > BACKUPS) this.vault.remove(NS, all.shift()); }
  backups(id) { this._ready(); this._id(id); const p = 'bak-' + id + '-'; return this.vault.list(NS).filter((n) => n.startsWith(p)).sort().reverse().map((n) => ({ name: n, at: new Date(Number(n.slice(p.length))).toISOString() })); }
  restore(id, name) {
    this._ready(); this._id(id); const p = 'bak-' + id + '-';
    if (typeof name !== 'string' || !name.startsWith(p) || !/^[A-Za-z0-9_-]+$/.test(name)) throw new CaseError('bad-id', 'That is not a backup of this case.');
    const b = this.vault.get(NS, name); if (b === null) throw new CaseError('missing', 'That backup was not found.');
    return b.toString('utf8');
  }
  create(title) { this._ready(); const c = M.newCase(String(title || 'Untitled case').slice(0, 200), this.now()); const json = JSON.stringify(c); this.put(c.id, json); return { id: c.id, json }; }
  delete(id) {
    this._ready(); this._id(id);
    this.vault.remove(NS, rec(id));
    for (const n of this.vault.list(NS).filter((x) => x.startsWith('bak-' + id + '-'))) this.vault.remove(NS, n);
    this.lastBackup.delete(id); return true;
  }
}
module.exports = { CaseStore, CaseError, BACKUPS, MAX_BYTES, ID_RE };
