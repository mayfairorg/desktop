'use strict';
// Web apps catalogue: pure logic (validation, in-app host rules, unread count from page titles,
// per-app session names, shortcuts). No scraping and no changes to the sites' own code:
// the only thing read from a site is its window title, which the page already shows the user.
const { JsonStore } = require('./stores');

const ID = /^[a-z][a-z0-9-]{0,31}$/;
// display order of the App Library tabs
const CATEGORIES = ['AI', 'Social', 'Chat', 'Media', 'Mail', 'Office', 'Files', 'Work', 'Design', 'Dev', 'Shopping', 'Travel', 'News', 'Reference', 'Games', 'Tools'];

function validateCatalogue(list) {
  const apps = []; const errors = []; const seen = new Set();
  for (const a of Array.isArray(list) ? list : []) {
    const why = (m) => errors.push((a && a.id || '?') + ': ' + m);
    if (!a || typeof a !== 'object') { why('not an object'); continue; }
    if (!ID.test(a.id || '')) { why('bad id'); continue; }
    if (seen.has(a.id)) { why('duplicate id'); continue; }
    let u; try { u = new URL(a.url); } catch { why('bad url'); continue; }
    if (u.protocol !== 'https:' || u.username || u.password) { why('url must be plain https'); continue; }
    if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 40) { why('bad name'); continue; }
    const hosts = (Array.isArray(a.hosts) ? a.hosts : []).filter((h) => typeof h === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
    const authHosts = (Array.isArray(a.authHosts) ? a.authHosts : []).filter((h) => typeof h === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h));
    // search aliases ('openai' for ChatGPT, 'insta' for Instagram): short lower-case words, at most 12
    const keywords = (Array.isArray(a.keywords) ? a.keywords : []).filter((k) => typeof k === 'string' && /^[a-z0-9][a-z0-9 .&+'-]{0,23}$/.test(k)).slice(0, 12);
    seen.add(a.id);
    apps.push({
      id: a.id, name: a.name.trim(), url: u.toString(), category: CATEGORIES.includes(a.category) ? a.category : 'Tools',
      description: String(a.description || '').slice(0, 120), keywords, hosts: [...new Set([u.hostname, ...hosts, ...authHosts])], authHosts: [...new Set(authHosts)],
      badge: a.badge === 'none' ? 'none' : 'title', drm: !!a.drm, adblock: !!a.adblock,
    });
  }
  return { apps, errors };
}

const partitionFor = (id) => 'persist:app-' + id;

// Registrable domain (no public-suffix list: the usual two-level suffixes are handled, everything else takes the last two labels)
const SLD2 = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.mx', 'com.tr', 'co.in', 'co.za', 'com.cn', 'com.hk', 'com.sg', 'co.kr']);
function registrable(host) {
  const p = String(host || '').toLowerCase().replace(/\.$/, '').split('.');
  if (p.length <= 2) return p.join('.');
  return p.slice(SLD2.has(p.slice(-2).join('.')) ? -3 : -2).join('.');
}
// Which catalogue app does this web address belong to? Own site first (exact host, then sub-domains either way, then the one app
// whose own site shares the registrable domain). Sign-in hosts (authHosts, accounts.google.com...) never match by themselves.
// Ambiguous (several apps on one domain, e.g. Google) -> null.
function matchApp(apps, url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase();
  const own = apps.map((a) => { const x = new URL(a.url); return { id: a.id, host: x.hostname.toLowerCase(), path: x.pathname.toLowerCase().replace(/\/+$/, '') }; });
  const exact = own.filter((x) => x.host === h);
  if (exact.length) {   // several apps on one host (Google Docs and Sheets, the BBC apps): the one whose path the address is under, longest first
    const p = u.pathname.toLowerCase();
    const under = exact.filter((x) => x.path && (p === x.path || p.startsWith(x.path + '/'))).sort((a, b) => b.path.length - a.path.length);
    return (under[0] || exact[0]).id;
  }
  const sub = own.filter((x) => h.endsWith('.' + x.host) || x.host.endsWith('.' + h)); if (sub.length === 1) return sub[0].id;
  if (sub.length > 1) return null;
  const reg = own.filter((x) => registrable(x.host) === registrable(h)); return reg.length === 1 ? reg[0].id : null;
}

// Does this URL stay inside the app (own host, or a listed sign-in host)?
function staysInApp(app, url) {
  let u; try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  return app.hosts.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

// "(3) Title", "[3] Title", "Inbox (5) - me@x.com - Mail", "(99+) Title" -> number; otherwise 0.
function badgeFromTitle(title) {
  const t = String(title || '');
  let m = /^\s*[([](\d{1,4})\+?[)\]]/.exec(t);
  if (!m) m = /\b[Ii]nbox\s*\((\d{1,4})\)/.exec(t);
  if (!m) m = /^\s*(\d{1,4})\s+(?:new|unread)\b/i.exec(t);
  return m ? Math.min(9999, parseInt(m[1], 10)) : 0;
}

// Should a count change raise a native notification? Only when it went up and the app is not in view.
const shouldNotify = (prev, next, inView) => next > prev && next > 0 && !inView;

class AppsStore {
  constructor(file, opts) { this.s = new JsonStore(file, () => ({ installed: {} }), opts); if (!this.s.data.installed) this.s.data.installed = {}; }
  list() { return Object.entries(this.s.data.installed).map(([id, v]) => ({ id, pinned: !!v.pinned, window: !!v.window, added: v.added })); }
  has(id) { return !!this.s.data.installed[id]; }
  add(id, now = Date.now()) { if (!ID.test(id)) return false; if (!this.s.data.installed[id]) this.s.data.installed[id] = { pinned: false, window: false, added: now }; this.s.save(); return true; }
  remove(id) { const had = this.has(id); delete this.s.data.installed[id]; if (had) this.s.save(); return had; }
  setPinned(id, on) { if (!this.has(id)) return false; this.s.data.installed[id].pinned = !!on; this.s.save(); return true; }
  setWindow(id, on) { if (!this.has(id)) return false; this.s.data.installed[id].window = !!on; this.s.save(); return true; }
  pinned() { return this.list().filter((a) => a.pinned).map((a) => a.id); }
  flush() { this.s.flush(); }
}

// Linux launcher file for a pinned app (taskbar/dock/desktop on freedesktop systems).
function desktopEntry(app, exec) {
  const q = (s) => '"' + String(s).replace(/(["`$\\])/g, '\\$1') + '"';
  return `[Desktop Entry]\nType=Application\nName=${app.name}\nComment=${app.name} in Mayfair Desktop\nExec=${q(exec)} --app=${app.id}\nIcon=mayfair-desktop\nCategories=Network;\nStartupWMClass=Mayfair Desktop\n`;
}
const findAppArg = (argv) => { const a = (argv || []).find((x) => typeof x === 'string' && /^--app=[a-z][a-z0-9-]{0,31}$/.test(x)); return a ? a.slice(6) : null; };

module.exports = { registrable, matchApp, validateCatalogue, partitionFor, staysInApp, badgeFromTitle, shouldNotify, AppsStore, desktopEntry, findAppArg, CATEGORIES };
