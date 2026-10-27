'use strict';
// Storage adapter that puts Ghost's own files (connector state, job history, audit trail, scan log) into the vault instead of plain files.
// Same small interface the managers use when no vault is given: read(name), write(name, text), append(name, line, {maxBytes, keep}), readAll(name).
// Logs are kept as small sealed chunks (16 KiB) so one log line never re-encrypts a whole file; the oldest chunks are dropped past maxBytes * keep.
const CHUNK = 16 * 1024;
const idOf = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '-');

class SecureIO {
  constructor(vault, ns) { this.vault = vault; this.ns = ns; }
  read(name) { this.vault.ensure(); const b = this.vault.unlocked ? this.vault.get(this.ns, idOf(name)) : null; return b === null ? null : b.toString('utf8'); }
  write(name, text) { this.vault.put(this.ns, idOf(name), String(text)); }
  _chunks(name) {
    const p = idOf(name) + '.c';
    return this.vault.list(this.ns).filter((i) => i.startsWith(p) && /^\d+$/.test(i.slice(p.length))).map((i) => ({ id: i, n: Number(i.slice(p.length)) })).sort((a, b) => a.n - b.n);
  }
  append(name, line, { maxBytes = 256 * 1024, keep = 4 } = {}) {
    const cs = this._chunks(name), p = idOf(name) + '.c';
    const last = cs[cs.length - 1];
    let cur = last ? this.vault.get(this.ns, last.id).toString('utf8') : '';
    if (!last || Buffer.byteLength(cur) + Buffer.byteLength(line) > CHUNK) { this.vault.put(this.ns, p + (last ? last.n + 1 : 1), line); cs.push({ id: p + (last ? last.n + 1 : 1) }); }
    else this.vault.put(this.ns, last.id, cur + line);
    const maxChunks = Math.max(2, Math.ceil((maxBytes * Math.max(1, keep)) / CHUNK));
    while (cs.length > maxChunks) this.vault.remove(this.ns, cs.shift().id);
  }
  readAll(name) { return this._chunks(name).map((c) => this.vault.get(this.ns, c.id).toString('utf8')); }
}
module.exports = { SecureIO };
