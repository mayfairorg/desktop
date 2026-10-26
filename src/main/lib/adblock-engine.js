'use strict';
// Full ad and tracker blocking on top of @ghostery/adblocker-electron (MPL-2.0): network filters,
// cosmetic filters and scriptlets from EasyList, EasyPrivacy and the uBlock filter lists.
// Independent of any browser extension. Lists ship inside the installer and are refreshed from
// their public URLs (plain GET, no identifiers, no telemetry). If the library or the lists are
// missing, the caller falls back to the small built-in host blocker and says so.
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const MAX_LIST_BYTES = 40 * 1024 * 1024;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

// "@@||host^$document" turns every kind of blocking (network, cosmetic, scriptlets) off for a site.
const exceptionFilter = (host) => { const h = String(host || '').toLowerCase(); return HOST.test(h) ? `@@||${h}^$document` : null; };
const looksLikeList = (t) => typeof t === 'string' && t.length > 200 && t.length <= MAX_LIST_BYTES && /^\s*(\[Adblock|!|##|\|\||@@|\/)/m.test(t.slice(0, 4000)) && !/<html|<!doctype/i.test(t.slice(0, 500));
const dueForUpdate = (lastMs, nowMs, everyMs = 3 * 24 * 3600 * 1000) => !Number.isFinite(lastMs) || lastMs <= 0 || nowMs - lastMs >= everyMs || nowMs < lastMs;
const lastLine = (t, re) => { const m = re.exec(String(t).slice(0, 2000)); return m ? m[1].trim() : ''; };

class AdEngine extends EventEmitter {
  constructor({ ghostery, manifest, bundledDir, userDir, fetchText, now = () => Date.now(), allow = [] }) {
    super();
    this.g = ghostery; this.manifest = manifest; this.bundledDir = bundledDir; this.userDir = userDir; this.fetchText = fetchText; this.now = now;
    this.blocker = null; this.sessions = new Set(); this.allow = new Set(allow);
    this.info = { engine: ghostery ? 'ghostery' : 'basic', lists: [], rules: 0, lastUpdate: 0, scriptlets: false, error: '' };
    this.stateFile = path.join(userDir, 'filters-state.json');
  }
  _read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
  _state() { try { return JSON.parse(this._read(this.stateFile) || '{}'); } catch { return {}; } }
  // Newest copy wins: downloaded copy if there is one, otherwise the one in the installer.
  collect() {
    const texts = []; const lists = []; const st = this._state();
    for (const l of this.manifest.lists) {
      const t = [path.join(this.userDir, l.file), path.join(this.bundledDir, l.file)].map((f) => ({ f, t: this._read(f) })).find((x) => looksLikeList(x.t));
      if (!t) { lists.push({ ...l, loaded: false }); continue; }
      texts.push(t.t);
      lists.push({ ...l, loaded: true, source: t.f.startsWith(this.userDir) ? 'updated' : 'bundled', version: lastLine(t.t, /^!\s*Version:\s*(.+)$/m), updated: (st.lists && st.lists[l.id]) || 0 });
    }
    return { text: texts.join('\n'), lists };
  }
  async load() {
    if (!this.g) { this.info = { ...this.info, engine: 'basic', error: 'Ad blocking library is not installed in this build.' }; return false; }
    const { text, lists } = this.collect();
    this.info.lists = lists;
    if (!text) { this.info.engine = 'basic'; this.info.error = 'No filter lists found yet. They download on first use.'; return false; }
    const old = this.blocker;
    const b = this.g.ElectronBlocker.parse(text, { enableCompression: true, loadCosmeticFilters: true, loadNetworkFilters: true, enableMutationObserver: true });
    const res = this._read(path.join(this.userDir, 'resources.txt')) || this._read(path.join(this.bundledDir, 'resources.txt'));
    this.info.scriptlets = false;
    if (res && typeof b.updateResources === 'function') { try { b.updateResources(res, String(res.length)); this.info.scriptlets = true; } catch { /* scriptlets stay off */ } }
    const exc = [...this.allow].map(exceptionFilter).filter(Boolean);
    if (exc.length && typeof b.updateFromDiff === 'function') b.updateFromDiff({ added: exc });
    b.on('request-blocked', (r) => this.emit('blocked', r));
    b.on('request-redirected', (r) => this.emit('blocked', r));
    this.blocker = b;
    for (const s of this.sessions) { if (old) { try { old.disableBlockingInSession(s); } catch { /* gone */ } } b.enableBlockingInSession(s); }
    this.info.engine = 'ghostery'; this.info.error = ''; this.info.rules = this.countRules(text);
    this.info.lastUpdate = this._state().last || 0;
    return true;
  }
  countRules(text) { let n = 0; for (const l of text.split('\n')) if (l && l[0] !== '!' && l[0] !== '[') n++; return n; }
  get active() { return !!this.blocker; }
  enable(session) { this.sessions.add(session); if (this.blocker) this.blocker.enableBlockingInSession(session); }
  disable(session) { this.sessions.delete(session); if (this.blocker) { try { this.blocker.disableBlockingInSession(session); } catch { /* not enabled */ } } }
  setSiteOff(host, off) {
    const f = exceptionFilter(host); if (!f) return false;
    off ? this.allow.add(host.toLowerCase()) : this.allow.delete(host.toLowerCase());
    if (this.blocker && typeof this.blocker.updateFromDiff === 'function') this.blocker.updateFromDiff(off ? { added: [f] } : { removed: [f] });
    return true;
  }
  isSiteOff(host) { return this.allow.has(String(host).toLowerCase()); }

  // Download every list from its public URL. A list that fails keeps its previous copy.
  async update({ force = false } = {}) {
    const st = this._state();
    if (!force && !dueForUpdate(st.last, this.now())) return { skipped: true };
    fs.mkdirSync(this.userDir, { recursive: true });
    const done = []; const failed = []; st.lists = st.lists || {};
    const jobs = [...this.manifest.lists.map((l) => ({ file: l.file, url: l.url, id: l.id })), ...(this.manifest.resources ? [{ file: 'resources.txt', url: this.manifest.resources, id: 'resources', plain: true }] : [])];
    for (const j of jobs) {
      try {
        const t = await this.fetchText(j.url);
        if (!j.plain && !looksLikeList(t)) throw new Error('not a filter list');
        if (j.plain && (typeof t !== 'string' || t.length < 100 || t.length > MAX_LIST_BYTES)) throw new Error('bad resources file');
        const tmp = path.join(this.userDir, j.file + '.tmp'); fs.writeFileSync(tmp, t); fs.renameSync(tmp, path.join(this.userDir, j.file));
        st.lists[j.id] = this.now(); done.push(j.id);
      } catch (e) { failed.push({ id: j.id, error: e.message }); }
    }
    if (done.length) { st.last = this.now(); fs.writeFileSync(this.stateFile, JSON.stringify(st)); await this.load(); }
    return { done, failed };
  }
}
module.exports = { AdEngine, exceptionFilter, looksLikeList, dueForUpdate, MAX_LIST_BYTES };
