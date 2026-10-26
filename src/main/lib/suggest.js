'use strict';
// Search suggestions from the user's own bookmarks and history only. No network.
function suggest(q, bookmarks, history, limit = 6) {
  const n = String(q || '').trim().toLowerCase();
  if (!n) return [];
  const score = (title, url) => { const t = String(title).toLowerCase(); const u = String(url).toLowerCase(); if (t.startsWith(n)) return 3; if (t.includes(n)) return 2; if (u.replace(/^https?:\/\/(www\.)?/, '').startsWith(n)) return 2; return u.includes(n) ? 1 : 0; };
  const seen = new Set(); const out = [];
  for (const [kind, list] of [['bookmark', bookmarks], ['history', history]]) {
    for (const it of list) {
      const sc = score(it.title, it.url); if (!sc || seen.has(it.url)) continue;
      seen.add(it.url); out.push({ kind, title: String(it.title).slice(0, 120), sub: it.url, url: it.url, sc: sc + (kind === 'bookmark' ? 0.5 : 0) });
    }
  }
  return out.sort((a, b) => b.sc - a.sc).slice(0, limit).map(({ sc, ...r }) => r);
}
// Results the Mayfair web app sends back for files, notes, contacts. Never trusted as-is.
const LINK = /^\/[A-Za-z0-9/_\-.~%]{1,200}$/;
const KINDS = ['file', 'note', 'contact', 'event', 'mail'];
function cleanWebResults(list, max = 6) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== 'object' || !KINDS.includes(r.kind) || typeof r.title !== 'string' || !r.title || typeof r.link !== 'string' || !LINK.test(r.link) || r.link.includes('..')) continue;
    out.push({ kind: r.kind, title: r.title.slice(0, 120), sub: typeof r.subtitle === 'string' ? r.subtitle.slice(0, 160) : '', link: r.link });
    if (out.length >= max) break;
  }
  return out;
}
module.exports = { suggest, cleanWebResults, KINDS };
