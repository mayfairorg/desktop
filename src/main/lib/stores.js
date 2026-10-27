'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Small JSON file store: atomic write, debounced, corrupt-file safe.
class JsonStore {
  constructor(file, fallback, { delay = 400 } = {}) {
    this.file = file;
    this.fallback = fallback;
    this.delay = delay;
    this.timer = null;
    this.data = this._load();
  }
  _load() {
    if (!this.file) return this.fallback();
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return v && typeof v === 'object' ? v : this.fallback();
    } catch { return this.fallback(); }
  }
  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
    if (this.timer.unref) this.timer.unref();
  }
  flush() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch { /* disk full or read-only: keep running in memory */ }
  }
}

const cleanUrl = (u) => { try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.toString() : null; } catch { return null; } };

class BookmarkStore {
  constructor(file, opts) { this.s = new JsonStore(file, () => ({ items: [] }), opts); if (!Array.isArray(this.s.data.items)) this.s.data.items = []; }
  list() { return this.s.data.items.slice(); }
  has(url) { const c = cleanUrl(url); return !!c && this.s.data.items.some((b) => b.url === c); }
  add(url, title, now = Date.now()) {
    const c = cleanUrl(url);
    if (!c) return null;
    const hit = this.s.data.items.find((b) => b.url === c);
    if (hit) return hit;
    const item = { id: 'b' + now.toString(36) + Math.random().toString(36).slice(2, 6), url: c, title: String(title || c).slice(0, 200), added: now };
    this.s.data.items.push(item);
    this.s.save();
    return item;
  }
  remove(id) {
    const n = this.s.data.items.length;
    this.s.data.items = this.s.data.items.filter((b) => b.id !== id && b.url !== id);
    if (this.s.data.items.length !== n) this.s.save();
    return this.s.data.items.length !== n;
  }
  toggle(url, title, now) {
    const c = cleanUrl(url);
    if (!c) return { on: false };
    if (this.has(c)) { this.remove(c); return { on: false }; }
    this.add(c, title, now);
    return { on: true };
  }
  update(id, patch) {
    const b = this.s.data.items.find((x) => x.id === id); if (!b || !patch) return false;
    if (typeof patch.title === 'string') b.title = patch.title.slice(0, 200);
    if (typeof patch.url === 'string') { const c = cleanUrl(patch.url); if (!c) return false; b.url = c; }
    this.s.save(); return true;
  }
  // items: [{url,title}] from the Cloud side (http/https only, no duplicates, at most 5000 in total)
  importItems(items, now = Date.now()) {
    let added = 0;
    for (const it of Array.isArray(items) ? items : []) {
      if (this.s.data.items.length >= 5000) break;
      const c = it && cleanUrl(it.url); if (!c || this.s.data.items.some((b) => b.url === c)) continue;
      this.s.data.items.push({ id: 'b' + (now + added).toString(36) + Math.random().toString(36).slice(2, 6), url: c, title: String((it && it.title) || c).slice(0, 200), added: now });
      added++;
    }
    if (added) this.s.save();
    return added;
  }
  rename(id, title) { const b = this.s.data.items.find((x) => x.id === id); if (!b) return false; b.title = String(title).slice(0, 200); this.s.save(); return true; }
  flush() { this.s.flush(); }
}

const newId = (t = Date.now()) => 'h' + Math.floor(t).toString(36) + Math.random().toString(36).slice(2, 8);

class HistoryStore {
  constructor(file, { max = 5000, ...opts } = {}) {
    this.max = max; this.s = new JsonStore(file, () => ({ items: [] }), opts); if (!Array.isArray(this.s.data.items)) this.s.data.items = [];
    this.lastNew = false;      // did the last add() make a NEW entry (not a repeat of the newest one)?
    for (const it of this.s.data.items) if (!it.id) it.id = newId(it.t);
  }
  // private tabs must never reach here; the caller passes private:true to be safe
  add(url, title, now = Date.now(), { private: priv = false } = {}) {
    if (priv) return null;
    const c = cleanUrl(url);
    if (!c) return null;
    const items = this.s.data.items;
    const last = items[0];
    if (last && last.url === c) { if (title) last.title = String(title).slice(0, 200); last.t = now; this.s.save(); this.lastNew = false; return last; }
    const item = { id: newId(now), url: c, title: String(title || c).slice(0, 200), t: now };
    this.lastNew = true;
    items.unshift(item);
    if (items.length > this.max) items.length = this.max;
    this.s.save();
    return item;
  }
  list(limit = 200) { return this.s.data.items.slice(0, limit); }
  search(q, limit = 50) {
    const n = String(q || '').trim().toLowerCase();
    if (!n) return this.list(limit);
    return this.s.data.items.filter((h) => h.url.toLowerCase().includes(n) || h.title.toLowerCase().includes(n)).slice(0, limit);
  }
  // by address or by entry id; returns the ids that went
  removeUrl(key) { const gone = this.s.data.items.filter((h) => h.url === key || h.id === key).map((h) => h.id); if (gone.length) { this.s.data.items = this.s.data.items.filter((h) => !gone.includes(h.id)); this.s.save(); } return gone; }
  clear(sinceMs) {
    this.s.data.items = sinceMs ? this.s.data.items.filter((h) => h.t < sinceMs) : [];
    this.s.save();
  }
  // entries from the user's Mayfair ID record: [{id?,url,title,t}] validated, merged by id or url+t, newest first, capped; never emits anything
  importEntries(list, now = Date.now()) {
    let added = 0, skipped = 0;
    const have = new Set(this.s.data.items.map((h) => h.id)); const key = new Set(this.s.data.items.map((h) => h.url + '|' + h.t));
    for (const e of Array.isArray(list) ? list.slice(0, 5000) : []) {
      const c = e && typeof e === 'object' ? cleanUrl(e.url) : null;
      const t = e && Number(e.t);
      const id = e && typeof e.id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(e.id) ? e.id : null;
      if (!c || !Number.isFinite(t) || t <= 0 || t > now + 86400000 || (e.title !== undefined && typeof e.title !== 'string') || (e.id !== undefined && !id) || (id && have.has(id)) || key.has(c + '|' + t)) { skipped++; continue; }
      const item = { id: id || newId(t), url: c, title: String(e.title || c).slice(0, 200), t: Math.floor(t) };
      this.s.data.items.push(item); have.add(item.id); key.add(c + '|' + item.t); added++;
    }
    if (added) { this.s.data.items.sort((a, b) => b.t - a.t); if (this.s.data.items.length > this.max) this.s.data.items.length = this.max; this.s.save(); }
    return { added, skipped };
  }
  flush() { this.s.flush(); }
}

// Per-site permission decisions: { origin: { permission: "allow" | "deny" } }
const PERMISSIONS = Object.freeze(['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'fullscreen', 'pointerLock', 'openExternal', 'idle-detection', 'display-capture', 'popups']);
class SitePermissionStore {
  constructor(file, opts) { this.s = new JsonStore(file, () => ({ sites: {} }), opts); if (!this.s.data.sites) this.s.data.sites = {}; }
  get(origin, perm) { const v = (this.s.data.sites[origin] || {})[perm]; return v === 'allow' || v === 'deny' ? v : 'ask'; }
  set(origin, perm, value) {
    if (!origin || !PERMISSIONS.includes(perm)) return false;
    const site = this.s.data.sites[origin] || (this.s.data.sites[origin] = {});
    if (value === 'allow' || value === 'deny') site[perm] = value; else delete site[perm];
    if (!Object.keys(site).length) delete this.s.data.sites[origin];
    this.s.save();
    return true;
  }
  forSite(origin) { return { ...(this.s.data.sites[origin] || {}) }; }
  all() { return JSON.parse(JSON.stringify(this.s.data.sites)); }
  resetSite(origin) { delete this.s.data.sites[origin]; this.s.save(); }
  flush() { this.s.flush(); }
}

module.exports = { JsonStore, BookmarkStore, HistoryStore, SitePermissionStore, PERMISSIONS, cleanUrl };
