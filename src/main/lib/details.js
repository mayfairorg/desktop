'use strict';
// 'details-used' bridge event: tells Mayfair that an email or username was used in a submitted form, so the Mayfair ID
// can show where each detail has been used. The value itself never leaves the page process towards Cloud: only a masked label.
const DEDUPE_MS = 30000;
const FIELDS = ['email', 'username'];

function maskLabel(field, value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  const first = Array.from(v)[0];
  if (field === 'email') {
    const at = v.lastIndexOf('@');
    if (at > 0 && at < v.length - 1) return first + '***' + v.slice(at);
  }
  return first + '***';
}
function hostOf(url) { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname : ''; } catch { return ''; } }

class DetailsLog {
  // deps: { enabled: () => boolean, emit: (name, payload) => void, now?: () => number }
  constructor(deps) { this.enabled = deps.enabled; this.emit = deps.emit; this.now = deps.now || Date.now; this.seen = new Map(); }
  // ctx: { url, app?, gid, tabId, private, tor, fields: { email?, username? } }; returns the number of events sent
  note(ctx) {
    if (!ctx || ctx.private || ctx.tor || !this.enabled()) return 0;
    const host = hostOf(ctx.url); if (!host) return 0;
    const t = this.now();
    for (const [k, at] of this.seen) if (t - at >= DEDUPE_MS) this.seen.delete(k);
    let n = 0;
    for (const field of FIELDS) {
      const label = maskLabel(field, ctx.fields && ctx.fields[field]);
      if (!label) continue;
      const key = host + '|' + field + '|' + label;
      if (this.seen.has(key)) continue;
      this.seen.set(key, t);
      this.emit('details-used', { origin: host, ...(ctx.app ? { app: ctx.app } : {}), gid: ctx.gid, tabId: ctx.tabId, field, label, t });
      n++;
    }
    return n;
  }
}
module.exports = { DetailsLog, maskLabel, hostOf, DEDUPE_MS };
