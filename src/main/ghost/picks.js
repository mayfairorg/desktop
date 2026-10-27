'use strict';
// Mayfair Ghost: one-time tokens for files the user chose in the native file picker. The page only ever sees the token and the
// file name; the path stays in the main process. A token works once, for one run, and expires.
const crypto = require('node:crypto');

class PickStore {
  constructor({ ttlMs = 10 * 60 * 1000, max = 20, now = Date.now } = {}) { this.ttlMs = ttlMs; this.max = max; this.now = now; this.m = new Map(); }
  add(filePath, size) {
    this.sweep();
    while (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    const token = crypto.randomBytes(16).toString('hex');
    this.m.set(token, { path: filePath, size, t: this.now() });
    return token;
  }
  sweep() { for (const [k, v] of this.m) if (this.now() - v.t > this.ttlMs) this.m.delete(k); }
  peek(token) { this.sweep(); const v = this.m.get(token); return v ? { path: v.path, size: v.size } : null; }
  // consume: returns the entry once, then never again
  take(token) { const v = this.peek(token); if (v) this.m.delete(token); return v; }
}
module.exports = { PickStore };
