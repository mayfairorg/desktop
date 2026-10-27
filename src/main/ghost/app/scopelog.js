'use strict';
// Ghost scope declarations and the scan log. A declaration is the light scope guard: a target, "I own it" or "I have written permission", and one tick.
// Every declaration, scan start and scan end is written to the vault (scan-log section) as a chained line: each line holds the SHA-256 of the one before, so an
// edit, a removed line or a reordering is found by verify(). The log never leaves the computer.
const crypto = require('node:crypto');
const P = require('../../../ui/ghost/scope-parse');

const LOG = 'ghost-scope.log';
const TTL_MS = 12 * 60 * 60 * 1000;
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);

class ScopeError extends Error { constructor(code, message) { super(message); this.code = code; } }

class ScopeGuard {
  // io: SecureIO over the scan-log section (append, readAll). now: clock.
  constructor({ io, now = Date.now, ttlMs = TTL_MS }) { this.io = io; this.now = now; this.ttl = ttlMs; this.scopes = new Map(); }
  _lines() { const out = []; for (const chunk of this.io.readAll(LOG)) for (const l of chunk.split('\n')) if (l) out.push(l); return out; }
  _append(entry) {
    const lines = this._lines(); let prev = '0'.repeat(64), n = 1;
    if (lines.length) { try { const last = JSON.parse(lines[lines.length - 1]); prev = last.hash; n = last.n + 1; } catch { /* a broken last line: verify() reports it; a new chain starts here */ } }
    const body = { n, t: new Date(this.now()).toISOString(), ...entry, prev };
    const line = JSON.stringify({ ...body, hash: sha(JSON.stringify(body)) });
    this.io.append(LOG, line + '\n', { maxBytes: 5 * 1024 * 1024, keep: 4 });
    return n;
  }
  log(entry) { return this._append(entry); }
  // o: { target, basis:'own'|'permission', who?, when?, confirm:true }
  declare(o) {
    const t = P.parseTarget(o && o.target);
    if (!t.ok) throw new ScopeError('bad-target', t.reason);
    if (!o || (o.basis !== 'own' && o.basis !== 'permission')) throw new ScopeError('basis', 'Say whether you own the target or have written permission to test it.');
    const who = clip(o.who, 200).trim(), when = clip(o.when, 100).trim();
    if (o.basis === 'permission' && who.length < 3) throw new ScopeError('who', 'Write who gave you permission (a name or organisation).');
    if (o.confirm !== true) throw new ScopeError('confirm', 'Tick the box to confirm you own the target or have written permission.');
    const id = 'sc-' + crypto.randomBytes(8).toString('hex'), at = this.now();
    const sc = { id, target: t.value, kind: t.kind, basis: o.basis, who, when, declaredAt: at, expiresAt: at + this.ttl };
    this.scopes.set(id, sc);
    this._append({ action: 'scope.declare', scopeId: id, target: sc.target, basis: sc.basis, statement: o.basis === 'own' ? 'I own this target' : 'I have written permission', permission: o.basis === 'permission' ? { who, when } : undefined });
    return { scopeId: id, target: sc.target, kind: sc.kind, basis: sc.basis, expiresAt: new Date(sc.expiresAt).toISOString() };
  }
  // The declaration that is still valid, or throws. `host` (optional) must lie inside it.
  check(scopeId, host) {
    const sc = this.scopes.get(scopeId);
    if (!sc) throw new ScopeError('no-scope', 'Declare the target first.');
    if (this.now() >= sc.expiresAt) { this.scopes.delete(scopeId); throw new ScopeError('expired', 'That declaration has expired. Declare the target again.'); }
    if (host !== undefined && !P.inside(sc.target, host)) throw new ScopeError('outside', 'That is outside the target you declared.');
    return sc;
  }
  revoke(scopeId) { const ok = this.scopes.delete(scopeId); if (ok) this._append({ action: 'scope.revoke', scopeId }); return ok; }
  active() { const t = this.now(); return [...this.scopes.values()].filter((s) => s.expiresAt > t).map((s) => ({ scopeId: s.id, target: s.target, basis: s.basis, expiresAt: new Date(s.expiresAt).toISOString() })); }
  recent(limit = 200) {
    const out = []; for (const l of this._lines().slice(-limit)) { try { out.push(JSON.parse(l)); } catch { out.push({ broken: true }); } }
    return out.reverse();
  }
  // -> { ok:true, lines } or { ok:false, line, reason } for the first line that does not match its hash or its predecessor.
  verify() {
    const lines = this._lines(); let prev = null, count = 0;
    for (let i = 0; i < lines.length; i++) {
      let e; try { e = JSON.parse(lines[i]); } catch { return { ok: false, line: i + 1, reason: 'A line is not readable.' }; }
      const { hash, ...body } = e;
      if (sha(JSON.stringify(body)) !== hash) return { ok: false, line: i + 1, reason: 'A line was changed.' };
      if (prev !== null && e.prev !== prev) return { ok: false, line: i + 1, reason: 'A line was removed or moved.' };
      if (prev !== null && e.n !== count + 1) return { ok: false, line: i + 1, reason: 'The numbering has a gap.' };
      prev = hash; count = e.n;
    }
    return { ok: true, lines: lines.length };
  }
}
module.exports = { ScopeGuard, ScopeError, TTL_MS, LOG };
