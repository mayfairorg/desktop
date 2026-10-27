'use strict';
// Web app icons: every catalogue app shows its OWN site's favicon / apple-touch-icon, fetched by the main process the first time the
// App Library asks for the catalogue, kept on disk, and handed to the page as a small data: URL.  Nothing is bundled with the app.
//   - https only (also after redirects), no sign-in data sent (credentials omitted), no IP-address or local hosts
//   - HTML read capped at 256 KB, one icon capped at 40 KB (after resizing), only real image types (sniffed from the bytes, not trusted from the server)
//   - every failure is ignored: the app simply keeps the neutral letter tile the library draws
//   - successes are kept 30 days, failures 3 days; at most 3 sites are asked at a time
// Pure logic with the network and the image resizer injected, so it can be tested without Electron.
const fs = require('node:fs');
const path = require('node:path');

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const HTML_MAX = 256 * 1024;
const ICON_MAX = 40 * 1024;
const OK_TTL = 30 * 24 * 3600 * 1000;
const FAIL_TTL = 3 * 24 * 3600 * 1000;
const MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/x-icon', 'image/svg+xml'];

// https, no credentials, a real public-looking name (not an IP address, not localhost / .local / .internal)
function safeIconUrl(u) {
  let x; try { x = new URL(u); } catch { return null; }
  if (x.protocol !== 'https:' || x.username || x.password) return null;
  const h = x.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) || /\.(local|localhost|internal|lan|home|corp)$/.test(h) || h === 'localhost') return null;
  return x.toString();
}

function sniff(b) {
  if (!Buffer.isBuffer(b) || b.length < 8) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  const head = b.toString('utf8', 0, Math.min(b.length, 600)).toLowerCase();
  if (head.includes('<svg') && !/^\s*<!doctype html|<html/.test(head)) return 'image/svg+xml';
  return '';
}

const attr = (tag, name) => { const m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(tag); return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : ''; };
const sizeOf = (s) => { const m = /(\d+)x(\d+)/i.exec(String(s || '')); return m ? Math.min(+m[1], +m[2]) : 0; };

// The icon addresses a page offers, best first: apple-touch-icon (largest), then the page's icon links, then /favicon.ico.
function pickIcons(html, base) {
  const out = [];
  const add = (href, score) => {
    if (!href || /^data:/i.test(href)) return;
    let abs; try { abs = new URL(href.trim(), base).toString(); } catch { return; }
    const ok = safeIconUrl(abs); if (ok && !out.some((o) => o.url === ok)) out.push({ url: ok, score });
  };
  const tags = String(html || '').slice(0, HTML_MAX).match(/<link\b[^>]*>/gi) || [];
  for (const t of tags) {
    const rel = attr(t, 'rel').toLowerCase().split(/\s+/);
    if (rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) add(attr(t, 'href'), 1000 + Math.min(sizeOf(attr(t, 'sizes')), 256));
    else if (rel.includes('icon')) { const sz = sizeOf(attr(t, 'sizes')), svg = /svg/i.test(attr(t, 'type')) || /\.svg(\?|$)/i.test(attr(t, 'href')); add(attr(t, 'href'), 500 + (svg ? 64 : Math.min(sz, 256))); }
  }
  out.sort((a, b) => b.score - a.score);
  const list = out.map((o) => o.url);
  const fav = safeIconUrl(new URL('/favicon.ico', base).toString()); if (fav && !list.includes(fav)) list.push(fav);
  return list.slice(0, 4);
}

class WebAppIcons {
  // fetch(url, { max }) -> { ok, url, buf } (buf is a Buffer, already capped at max bytes); normalise(buf, mime) -> { buf, mime } | null (resize to a small icon)
  constructor({ dir, fetch, normalise, now = Date.now, concurrency = 3 }) {
    this.dir = dir; this.fetch = fetch; this.normalise = normalise || null; this.now = now; this.concurrency = concurrency;
    this.mem = new Map();      // id -> data URL ('' = no icon found)
    this.tried = new Map();    // id -> time of the last attempt this session
    this.queue = []; this.active = 0; this.queued = new Set(); this.stopped = false;
  }
  file(id) { return path.join(this.dir, id + '.json'); }
  _disk(id) {
    try {
      const j = JSON.parse(fs.readFileSync(this.file(id), 'utf8'));
      const age = this.now() - (+j.t || 0);
      if (j.fail) return age < FAIL_TTL ? { fresh: true, data: '' } : { fresh: false, data: '' };
      if (!MIMES.includes(j.mime) || typeof j.b64 !== 'string') return null;
      return { fresh: age < OK_TTL, data: 'data:' + j.mime + ';base64,' + j.b64 };
    } catch { return null; }
  }
  // Icons known right now ({ id: dataUrl }), and the number still being fetched; sites without a fresh answer are queued.
  collect(apps) {
    const icons = {}; let pending = 0;
    for (const a of apps) {
      if (!ID.test(a.id)) continue;
      if (!this.mem.has(a.id)) { const d = this._disk(a.id); if (d) { this.mem.set(a.id, d.data); if (!d.fresh) this._queue(a); } else this._queue(a); }
      const v = this.mem.get(a.id); if (v) icons[a.id] = v;
      if (!v && this.queued.has(a.id)) pending++;
    }
    return { icons, pending };
  }
  _queue(a) {
    if (this.stopped || this.queued.has(a.id)) return;
    const t = this.tried.get(a.id); if (t && this.now() - t < FAIL_TTL) return;
    this.queued.add(a.id); this.queue.push(a); this._pump();
  }
  _pump() {
    while (!this.stopped && this.active < this.concurrency && this.queue.length) {
      const a = this.queue.shift(); this.active++;
      this.one(a).catch(() => {}).finally(() => { this.active--; this.queued.delete(a.id); this.tried.set(a.id, this.now()); this._pump(); });
    }
  }
  async one(a) {
    let base; try { base = safeIconUrl(new URL('/', a.url).toString()); } catch { base = null; }
    if (!base) return this._save(a.id, null);
    let cands = [];
    try { const r = await this.fetch(base, { max: HTML_MAX }); if (r && r.ok && safeIconUrl(r.url || base)) cands = pickIcons(r.buf.toString('utf8'), r.url || base); } catch { /* ignore */ }
    if (!cands.length) { const f = safeIconUrl(new URL('/favicon.ico', base).toString()); if (f) cands = [f]; }
    for (const u of cands) {
      try {
        const r = await this.fetch(u, { max: 200 * 1024 });
        if (!r || !r.ok || !safeIconUrl(r.url || u)) continue;
        let buf = r.buf, mime = sniff(buf); if (!mime) continue;
        if (this.normalise && mime !== 'image/svg+xml') { try { const n = this.normalise(buf, mime); if (n && n.buf && n.buf.length && MIMES.includes(n.mime)) { buf = n.buf; mime = n.mime; } } catch { /* keep the original */ } }
        if (buf.length > ICON_MAX || buf.length < 16) continue;
        return this._save(a.id, { mime, b64: buf.toString('base64') });
      } catch { /* next candidate */ }
    }
    return this._save(a.id, null);
  }
  _save(id, icon) {
    this.mem.set(id, icon ? 'data:' + icon.mime + ';base64,' + icon.b64 : '');
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const f = this.file(id), tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(icon ? { t: this.now(), ...icon } : { t: this.now(), fail: true })); fs.renameSync(tmp, f);
    } catch { /* the icon still shows this session */ }
  }
  stop() { this.stopped = true; this.queue = []; }
}

module.exports = { WebAppIcons, pickIcons, safeIconUrl, sniff, ICON_MAX, HTML_MAX };
