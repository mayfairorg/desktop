'use strict';
// Ghost Quick notes: where the notes live. One note document per case (and one "inbox" for notes written with no case open), sealed in the Ghost vault
// (section "cases") with AES-256-GCM before it reaches the disk, exactly like the case file. Images and files are separate sealed records, so a pasted
// screenshot is an encrypted blob and the document only holds its hash, size and type. Nothing here touches the network.
//   qn-<scope>             the document (JSON text, up to 8 MB)
//   qb-<scope>-<blob id>   one blob: the first 16 hex characters of the SHA-256 of its bytes (the same picture pasted twice is stored once)
// Caps: 8 MB for a document, 8 MB for one image or file, 128 MB of blobs for one case. Blobs that no tab (open or closed) refers to are removed the next
// time the notes are opened; the vault overwrites a removed record with random bytes first.
const crypto = require('node:crypto');
const QN = require('../../../ui/ghost/qn-model');

const NS = 'cases';
const SCOPE_RE = /^(inbox|[A-Za-z0-9_-]{8,64})$/;
const PENDING_MS = 10 * 60 * 1000;          // a picture uploaded but not yet in a saved document is kept this long before clean-up may remove it

class NoteError extends Error { constructor(code, message) { super(message); this.code = code; } }
const keyOf = (scope) => (scope.length <= 40 ? scope : crypto.createHash('sha256').update(scope).digest('hex').slice(0, 32));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

class NoteStore {
  constructor({ vault, now = Date.now }) { this.vault = vault; this.now = now; this.pending = new Map(); this.used = new Map(); }
  _ready() { this.vault.ensure(); if (!this.vault.unlocked) throw new NoteError('locked', 'The vault is locked.'); }
  _scope(scope) { if (typeof scope !== 'string' || !SCOPE_RE.test(scope)) throw new NoteError('bad-scope', 'That is not a case.'); return keyOf(scope); }
  _doc(k) { return 'qn-' + k; }
  _blob(k, id) { return 'qb-' + k + '-' + id; }
  _pend(scope) { let m = this.pending.get(scope); if (!m) this.pending.set(scope, (m = new Map())); return m; }
  // The document as text, or null when there is none yet. Also removes blobs nothing refers to.
  read(scope) { this._ready(); const k = this._scope(scope); const b = this.vault.get(NS, this._doc(k)); return b === null ? null : b.toString('utf8'); }
  get(scope) {
    this._ready(); const k = this._scope(scope); const json = this.read(scope);
    let doc = null; if (json !== null) { try { doc = JSON.parse(json); } catch { doc = null; } }
    if (doc && !QN.validate(doc).length) {
      this.gc(scope, doc);
      const u = QN.usage(doc); this.used.set(scope, u.blobBytes); return { json, usage: this._usage(scope, u), limits: this.limits() };
    }
    // Notes that cannot be read are kept aside (sealed, as qx-<scope>) and a fresh document starts; nothing is thrown away silently.
    const broken = json !== null;
    if (broken) this.vault.put(NS, 'qx-' + k, json);
    this.used.set(scope, 0);
    return { json: null, usage: this._usage(scope, { blobs: 0, blobBytes: 0, clips: 0 }), limits: this.limits(), broken };
  }
  limits() { return { docBytes: QN.LIMITS.docBytes, blobBytes: QN.LIMITS.blobBytes, scopeBytes: QN.LIMITS.scopeBytes }; }
  _usage(scope, u) { let pend = 0; const m = this.pending.get(scope); if (m) for (const e of m.values()) pend += e.n; return { ...u, pendingBytes: pend }; }
  put(scope, json) {
    this._ready(); const k = this._scope(scope);
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > QN.LIMITS.docBytes) throw new NoteError('too-large', 'These notes are too large to store.');
    let doc; try { doc = JSON.parse(json); } catch { throw new NoteError('bad-notes', 'The notes could not be read.'); }
    if (!doc || doc.scope !== scope) throw new NoteError('bad-notes', 'The notes do not belong to this case.');
    const problems = QN.validate(doc);
    if (problems.length) throw new NoteError('invalid', problems[0] + (problems.length > 1 ? ' (and ' + (problems.length - 1) + ' more)' : ''));
    this.vault.put(NS, this._doc(k), json);
    const refs = QN.blobRefs(doc), m = this.pending.get(scope); if (m) for (const id of [...m.keys()]) if (refs.has(id)) m.delete(id);
    this.used.set(scope, QN.usage(doc).blobBytes);
    return { scope, bytes: json.length, savedAt: new Date(this.now()).toISOString() };
  }
  // Stores one blob. -> { id, sha256, bytes }. The same bytes stored twice make one record.
  putBlob(scope, bytes) {
    this._ready(); const k = this._scope(scope);
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (!bytes.length) throw new NoteError('empty', 'There is nothing to store.');
    if (bytes.length > QN.LIMITS.blobBytes) throw new NoteError('too-large', 'That is larger than ' + Math.round(QN.LIMITS.blobBytes / 1048576) + ' MB, the most one image or file may take.');
    const h = sha(bytes), id = h.slice(0, 16), name = this._blob(k, id);
    if (this.vault.get(NS, name) === null) {
      if (!this.used.has(scope)) { try { const j = this.read(scope); this.used.set(scope, j ? QN.usage(JSON.parse(j)).blobBytes : 0); } catch { this.used.set(scope, 0); } }
      let pend = 0; const m = this._pend(scope); for (const [id, e] of m) { if (this.now() - e.at > PENDING_MS) m.delete(id); else pend += e.n; }
      if (this.used.get(scope) + pend + bytes.length > QN.LIMITS.scopeBytes) throw new NoteError('quota', 'This case holds ' + Math.round(QN.LIMITS.scopeBytes / 1048576) + ' MB of pictures and files already. Remove some first.');
      this.vault.put(NS, name, bytes);
    }
    this._pend(scope).set(id, { n: bytes.length, at: this.now() });
    return { id, sha256: h, bytes: bytes.length };
  }
  getBlob(scope, id) {
    this._ready(); const k = this._scope(scope);
    if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new NoteError('bad-id', 'That is not a stored picture or file.');
    const b = this.vault.get(NS, this._blob(k, id)); if (b === null) throw new NoteError('missing', 'That picture or file is not in the vault any more.');
    return b;
  }
  gc(scope, doc) {
    const k = this._scope(scope), p = 'qb-' + k + '-'; const keep = new Set(QN.blobRefs(doc)); const m = this.pending.get(scope); if (m) for (const [id, e] of m) { if (this.now() - e.at <= PENDING_MS) keep.add(id); else m.delete(id); }
    let n = 0; for (const name of this.vault.list(NS)) if (name.startsWith(p) && !keep.has(name.slice(p.length))) { this.vault.remove(NS, name); n++; }
    return n;
  }
  deleteScope(scope) {
    this._ready(); const k = this._scope(scope); const p = 'qb-' + k + '-';
    for (const name of this.vault.list(NS)) if (name === this._doc(k) || name === 'qx-' + k || name.startsWith(p)) this.vault.remove(NS, name);
    this.pending.delete(scope); this.used.delete(scope); return true;
  }
}
module.exports = { NoteStore, NoteError, SCOPE_RE, NS };
