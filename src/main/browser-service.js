'use strict';
// BrowserService: owns the Desktop window, the Mayfair view and every browser tab (one native WebContentsView each).
// The Browser's interface (tab strip, address bar, panes) is drawn by Mayfair Cloud inside the Mayfair view and talks to
// this service through window.mayfairDesktop.browser (src/preload/web.js, contract: audit/browser-bridge-contract.md).
// Only the page content is native: tab views sit above the Mayfair view at the rectangle the Cloud side reports
// (setBounds). When anything of Mayfair overlaps that rectangle the Cloud side calls setOccluded(true): the view is hidden
// and the Cloud side paints capture() in its place.
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  app, BaseWindow, BrowserWindow, WebContentsView, nativeImage, net, session, ipcMain, Menu, Notification, dialog, shell, screen, clipboard,
} = require('electron');

const O = require('./lib/origins');
const { BookmarkStore, HistoryStore, SitePermissionStore, JsonStore } = require('./lib/stores');
const { TabModel } = require('./lib/tabmodel');
const { Settings } = require('./lib/settings');
const { WindowState, sanitizeBounds, MIN } = require('./lib/windowstate');
const { Blocker, parseList } = require('./lib/adblock');
const { safeFilename, uniquePath, chooseDir } = require('./lib/downloads-path');
const { popupAllowed, decidePermission } = require('./lib/policy');
const IPC = require('./lib/ipc-allowlist');
const W = require('./lib/webapps');
const WI = require('./lib/webapp-icons');
const { DetailsLog } = require('./lib/details');
const PV = require('./lib/privacy');
const SG = require('./lib/suggest');
const { AdEngine } = require('./lib/adblock-engine');
const { ExtensionManager } = require('./lib/extensions');
const FILTERS = require('./lib/filter-lists.json');
const ANS = require('../ui/answers.js');
const ONLINE = require('./lib/online-answers');
const { TorManager, binaryPath } = require('./lib/tor');
const PROT = require('./lib/protect');
const { actionForKey } = require('./lib/shortcuts');
const ABOUT = require('./lib/about');
const KC = require('./lib/keepcookies');
const SEARCH_DARK_JS = `(()=>{try{const c=getComputedStyle(document.body).backgroundColor,m=/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(c);return !!m&&(+m[1]+ +m[2]+ +m[3])<260}catch(e){return false}})()`;
const SEARCH_TAB_JS = `(()=>{try{const light=c=>{const m=/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c||'');return !!m&&(m[4]===undefined||+m[4]>0.5)&&+m[1]>190&&+m[2]>190&&+m[3]>190};
const root=document.querySelector('#hdtb,#hdtb-msb,[role=navigation],[role=list]')||document.body;let n=0;
for(const el of root.querySelectorAll('a,div,span,li')){if(n>3||el.hasAttribute('data-mfsel'))continue;const r=el.getBoundingClientRect();if(r.width<10||r.top<0||r.top>400)continue;
const cs=getComputedStyle(el),a=getComputedStyle(el,'::after');
if(light(cs.borderBottomColor)&&parseFloat(cs.borderBottomWidth)>=2&&parseFloat(cs.borderBottomWidth)<=4){el.setAttribute('data-mfsel','1');n++;continue}
if(a.content!=='none'&&light(a.backgroundColor)&&parseFloat(a.height)>=2&&parseFloat(a.height)<=4){el.setAttribute('data-mfsel','1');n++}}}catch(e){}})()`;
const SEARCH_MATCH_CSS = '@media (prefers-color-scheme: dark){html,body,#main,#cnt,#searchform,.sfbg,#hdtb,#hdtb-msb,#appbar,#sfcnt{background-color:#171716 !important}}'
  + ' html{accent-color:#ffa800}input,textarea{caret-color:#ffa800}::selection{background:#ffa800;color:#0a0a0a}:focus-visible{outline-color:#ffa800 !important}'
  + ' [data-mfsel]{border-bottom-color:#ffa800 !important}[data-mfsel]::after,[data-mfsel]::before{background-color:#ffa800 !important;border-color:#ffa800 !important}'
  + ' [role=tab][aria-selected=true]::after,[aria-current=page]::after,#hdtb-msb .hdtb-msel::after{background-color:#ffa800 !important;border-color:#ffa800 !important}';

const UI_DIR = path.join(__dirname, '..', 'ui');
const PRELOAD = (n) => path.join(__dirname, '..', 'preload', n + '.js');
const UI_URL = pathToFileURL(UI_DIR).href;
const START_URL = pathToFileURL(path.join(UI_DIR, 'newtab.html')).href;
const isInternal = (u) => typeof u === 'string' && u.startsWith(UI_URL);
const isStart = (u) => typeof u === 'string' && u.split('?')[0] === START_URL;

const CATALOGUE_FILE = path.join(__dirname, 'lib', 'webapps.json');
const PARTITION = { home: 'persist:mayfair', browse: 'persist:browse', private: 'mf-private', tor: 'mf-tor' };
const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500];
const levelOf = (pct) => Math.log(pct / 100) / Math.log(1.2);
const pctOf = (level) => Math.round(Math.pow(1.2, level) * 100);
const PERM_LABEL = { notifications: 'show notifications', geolocation: 'know your location', 'clipboard-read': 'read your clipboard', midi: 'use MIDI devices', fullscreen: 'go full screen', pointerLock: 'hide your pointer', 'idle-detection': 'know when you are idle', 'display-capture': 'share your screen' };

class BrowserService {
  constructor({ dataDir, version, tampered = null }) {
    this.version = version;
    this.tampered = tampered;      // set by main.js when the installed files do not match the build (lib/protect.js): the Mayfair view then refuses to open Mayfair Cloud
    this.devTools = PROT.devToolsAllowed({ isPackaged: app.isPackaged });
    this.dir = dataDir;
    const f = (n) => path.join(dataDir, n);
    this.settings = new Settings(f('settings.json'));
    this.winState = new WindowState(f('window.json'));
    this.bookmarks = new BookmarkStore(f('bookmarks.json'));
    this.history = new HistoryStore(f('history.json'));
    this.searchLog = new JsonStore(f('searches.json'), () => ({ items: [] }));   // typed web searches: [{id,q,t}], newest first
    if (!Array.isArray(this.searchLog.data.items)) this.searchLog.data.items = [];
    this.histOutbox = [];        // history events waiting for the Mayfair page to subscribe (memory, at most 500)
    this.histPending = new Map(); // history entry id -> timer: a visit is sent a moment after it starts, so it carries its title
    this.histSync = { last: 0, sent: 0 };
    this.appHistories = new Map(); // app id -> HistoryStore (history-app-<id>.json): web app pages never reach the browser history
    this.sitePerms = new SitePermissionStore(f('permissions.json'));
    this.zoomStore = new JsonStore(f('zoom.json'), () => ({ levels: {} }));
    this.tabsStore = new JsonStore(f('tabs.json'), () => ({ urls: [] }));
    const okUrls = (a) => (Array.isArray(a) ? a.filter((u) => typeof u === 'string').slice(0, 30) : []);
    this.restoreList = okUrls(this.tabsStore.data.urls);
    this.restoreGroupList = Array.isArray(this.tabsStore.data.groups) ? this.tabsStore.data.groups.slice(0, 8).map(okUrls).filter((g) => g.length) : [];
    this.appsStore = new W.AppsStore(f('apps.json'));
    this.catalogue = this.loadCatalogue(f('webapps-custom.json'));
    this.icons = new WI.WebAppIcons({ dir: f('webapp-icons'), fetch: (u, o) => this.fetchIcon(u, o), normalise: (buf) => { const im = nativeImage.createFromBuffer(buf); if (im.isEmpty()) return null; const sz = im.getSize(); const out = Math.max(sz.width, sz.height) > 64 ? im.resize({ width: sz.width >= sz.height ? 64 : Math.round(64 * sz.width / sz.height), quality: 'best' }) : im; return { buf: out.toPNG(), mime: 'image/png' }; } });
    this.appBadges = new Map(); // app id -> unread count
    this.appWindows = new Map(); // app id -> BrowserWindow
    this.hardened = new Set();
    this.keepHooked = new Set();
    this.flushTimers = new Map();
    this.tor = new TorManager({ binary: binaryPath({ resourcesPath: process.resourcesPath, root: path.join(__dirname, '..', '..') }) });
    this.tor.on('state', () => { this.emit('tor', this.torStatus()); this.pushState(); });
    this.tor.on('exit', () => { this.notice('Tor stopped'); });
    this.tabSeq = 0;
    this.groups = new Map();      // gid -> { gid, model, bounds, occluded, occSeq, fsTab, closed }  (one per Browser window in Mayfair Cloud)
    this.gidSeq = 0;
    this.focusedGid = null;
    this.dirty = new Set();
    this.createGroup({ quiet: true });
    this.tabs = new Map(); // id -> { gid, view, wc, loading, favicon, pw, blocked, lastInput, crashed, shown, find }
    this.roles = new Map(); // webContents id -> { role, tabId }
    this.home = null;      // { view, wc }: the Mayfair view
    this.adAllow = new JsonStore(f('adblock-allow.json'), () => ({ allow: [] }));
    if (!Array.isArray(this.adAllow.data.allow)) this.adAllow.data.allow = [];
    this.ad = null;
    this.ext = new ExtensionManager({ dir: f('extensions'), storeFile: f('extensions.json') });
    this.extIds = new Map(); // our id -> Electron extension id
    this.blocker = new Blocker(parseList(fs.readFileSync(path.join(__dirname, 'lib', 'blocklist.txt'), 'utf8')));
    this.downloads = [];
    this.perms = new Map();       // request id -> { req, callback, origin, permission, canRemember, timer }
    this.popups = new Map();      // request id -> { tabId, url, priv }
    this.pwWaiters = new Map();
    this.afOffers = new Map();    // form-details offers (email, name, address...): memory only, 2 minutes
    this.afRequests = new Map();  // focus requests waiting for a value from Mayfair
    this.details = new DetailsLog({ enabled: () => this.settings.get().detailsLog !== false, emit: (n, p) => { if (this.subs.has(n)) this.emit(n, p); } });
    this.pwOffers = new Map();    // offer id -> { tabId, gid, origin, url, username, password, kind, timer }: login waiting for the user's yes or no, memory only, never written or logged
    this.fileTokens = new Map();
    this.subs = new Set();        // bridge events the Mayfair page is listening to
    this.shots = new Map();       // tab id -> last capture (data URL)
    this.homeListening = false;
    this.searchListening = false;
    this.searchWaiters = new Map();
    this.rates = (() => { try { return JSON.parse(fs.readFileSync(path.join(UI_DIR, 'rates.json'), 'utf8')); } catch { return null; } })();
    this.pendingHome = []; // [channel, payload] waiting for the Mayfair page to load
    this.quitting = false;
    this.seq = 0;
    this.stateTimer = null;
    this.onSettingsChanged = () => {};
    this.onAppsChanged = () => {};
  }

  loadCatalogue(customFile) {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(CATALOGUE_FILE, 'utf8')).apps; } catch { /* shipped file missing */ }
    try { const extra = JSON.parse(fs.readFileSync(customFile, 'utf8')).apps; if (Array.isArray(extra)) list = list.concat(extra); } catch { /* optional */ }
    const { apps, errors } = W.validateCatalogue(list);
    this.catalogueErrors = errors;
    return apps;
  }
  // History of one web app, kept apart from the browser's: same format and cap, cleared by Reset / Remove / Clear browsing data with Web apps
  histFor(appId) {
    if (!this.appById(appId)) throw new Error('unknown app');
    let h = this.appHistories.get(appId);
    if (!h) { h = new HistoryStore(path.join(this.dir, 'history-app-' + appId + '.json')); this.appHistories.set(appId, h); }
    return h;
  }
  // ---------- history sync to the user's Mayfair ID ----------
  // Events for NEW entries and deletions go to the Mayfair page, which keeps them on the account record (deleted ones for 30 days).
  // Private and Tor tabs never reach here. Imported entries never echo an event. The local files are only a cache.
  sendHist(name, payload) {
    if (!this.settings.get().historySync) return;
    if (!this.subs.has(name)) { this.histOutbox.push([name, payload]); if (this.histOutbox.length > 500) this.histOutbox.shift(); return; }
    this.histSync.last = Date.now(); this.histSync.sent++;
    this.emit(name, payload);
  }
  flushHistOutbox() { const rest = []; for (const [n, p] of this.histOutbox.splice(0)) { if (this.subs.has(n)) { this.histSync.last = Date.now(); this.histSync.sent++; this.emit(n, p); } else rest.push([n, p]); } this.histOutbox = rest; }
  noteVisit(store, appId) {
    if (!store.lastNew) return;
    const it = store.list(1)[0]; if (!it) return;
    const t = setTimeout(() => { this.histPending.delete(it.id); const cur = store.s.data.items.find((x) => x.id === it.id); if (cur) this.sendHist('history-add', { entry: { id: cur.id, url: cur.url, title: cur.title, t: cur.t, kind: 'visit', ...(appId ? { app: appId } : {}) } }); }, 1500);
    if (t.unref) t.unref();
    this.histPending.set(it.id, t);
  }
  noteSearch(q) {
    const text = String(q || '').trim().slice(0, 300); if (!text) return;
    const e = { id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), q: text, t: Date.now() };
    this.searchLog.data.items.unshift(e); if (this.searchLog.data.items.length > 2000) this.searchLog.data.items.length = 2000; this.searchLog.save();
    this.sendHist('history-add', { entry: { id: e.id, kind: 'search', q: e.q, t: e.t } });
  }
  typedInTab(tabId, text) { const m = this.metaOf(tabId); if (m && !m.private && !m.tor && !m.appId && O.isSearchInput(text) && !ANS.parseCommand(text)) this.noteSearch(text); }
  clearSearches(since) { this.searchLog.data.items = since ? this.searchLog.data.items.filter((x) => x.t < since) : []; this.searchLog.save(); }
  histClear(o, since) {
    const h = this.hist(o); h.clear(since);
    if (!(o && o.app)) this.clearSearches(since);
    this.sendHist('history-clear', { ...(o && o.app ? { app: o.app } : {}), ...(since ? { since } : {}) });
  }
  histRemove(key, o) {
    const ids = this.hist(o).removeUrl(key);
    if (!(o && o.app)) { const before = this.searchLog.data.items.length; const gone = this.searchLog.data.items.filter((x) => x.id === key).map((x) => x.id); if (gone.length) { this.searchLog.data.items = this.searchLog.data.items.filter((x) => x.id !== key); this.searchLog.save(); ids.push(...gone); } void before; }
    if (ids.length) this.sendHist('history-remove', { ids, ...(o && o.app ? { app: o.app } : {}) });
    return ids.length > 0;
  }
  histImport(list, o) {
    const arr = Array.isArray(list) ? list.slice(0, 5000) : [];
    const visits = arr.filter((e) => e && e.kind !== 'search');
    const r = this.hist(o).importEntries(visits);
    if (!(o && o.app)) {
      const have = new Set(this.searchLog.data.items.map((x) => x.id));
      for (const e of arr.filter((x) => x && x.kind === 'search')) {
        const t = Number(e.t); const q = typeof e.q === 'string' ? e.q.trim().slice(0, 300) : '';
        const id = typeof e.id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(e.id) ? e.id : null;
        if (!q || !id || !Number.isFinite(t) || t <= 0 || t > Date.now() + 86400000 || have.has(id)) { r.skipped++; continue; }
        this.searchLog.data.items.push({ id, q, t: Math.floor(t) }); have.add(id); r.added++;
      }
      this.searchLog.data.items.sort((a, b) => b.t - a.t); if (this.searchLog.data.items.length > 2000) this.searchLog.data.items.length = 2000; this.searchLog.save();
    }
    return r;
  }
  syncState() {
    const apps = [...this.appHistories.values()].reduce((n, h) => n + h.s.data.items.length, 0);
    return { enabled: !!this.settings.get().historySync, subscribed: this.subs.has('history-add'), entries: this.history.s.data.items.length + this.searchLog.data.items.length + apps, searches: this.searchLog.data.items.length, waiting: this.histOutbox.length, sent: this.histSync.sent, lastEvent: this.histSync.last };
  }
  hist(o) { return o && o.app ? this.histFor(o.app) : this.history; }
  appById(id) { return this.catalogue.find((a) => a.id === id) || null; }

  // ---------- startup ----------
  start({ hidden = false } = {}) {
    this.setupSessions();
    this.initAdblock();
    this.loadExtensions();
    this.registerIpc();
    this.createWindow({ hidden });
    this.createHome();
    this.applyBounds();
    setTimeout(() => this.sweepInstalledApps(), 3000).unref();
    setInterval(() => this.sweepInstalledApps(), 24 * 3600 * 1000).unref();
    setInterval(() => this.flushAppSessions(), 5 * 60 * 1000).unref();
  }

  // Full blocker (Ghostery engine + EasyList/EasyPrivacy/uBlock lists). Falls back to the small
  // built-in host list when the library or the lists are not there, and reports which is active.
  initAdblock() {
    let g = null;
    try { g = require('@ghostery/adblocker-electron'); } catch { /* not installed */ }
    this.ad = new AdEngine({
      ghostery: g, manifest: FILTERS, bundledDir: path.join(__dirname, '..', '..', 'assets', 'filters'), userDir: path.join(this.dir, 'filters'),
      fetchText: (u) => this.fetchList(u), allow: this.adAllow.data.allow,
    });
    this.ad.on('blocked', (r) => { const t = [...this.tabs.values()].find((x) => x.wc.id === r.tabId); if (t) { t.blocked = (t.blocked || 0) + 1; this.pushState(); } });
    this.ad.load().then(() => this.applyAdblock()).catch(() => {});
    const upd = () => this.ad.update().then((r) => { if (r && r.done && r.done.length) this.applyAdblock(); }).catch(() => {});
    setTimeout(upd, 20000).unref();
    setInterval(upd, 6 * 3600 * 1000).unref();
  }
  // ---------- extensions ----------
  // Loaded into the normal browser session only (not Mayfair, Web apps, private or Tor tabs).
  extSession() { const s = session.fromPartition(PARTITION.browse); return s.extensions || s; }
  async loadOne(id, dir) {
    if (this.extIds.has(id)) return;
    try { const x = await this.extSession().loadExtension(dir, { allowFileAccess: false }); this.extIds.set(id, x.id); } catch (e) { this.extErrors = (this.extErrors || []).concat(id + ': ' + e.message); }
  }
  async loadExtensions() {
    for (const { id, dir } of this.ext.loadable()) await this.loadOne(id, dir);
    this.applyExtensionRules();
  }
  // The Tracker blocker's rule file, applied natively. The full ad blocker already blocks these
  // hosts when it is active, so they are only added to the basic blocker (no double counting).
  applyExtensionRules() { for (const d of this.ext.blockerDomains()) this.blocker.domains.add(d); }
  async installExtension(id, url, sha) {
    const r = await this.ext.install(id, url, sha, (u, max) => this.fetchBuffer(u, max));
    if (this.extIds.has(id)) { try { await this.extSession().removeExtension(this.extIds.get(id)); } catch { /* not loaded */ } this.extIds.delete(id); }
    if (!r.native) await this.loadOne(id, this.ext.dirOf(id)); else if (id === 'blocker') this.applyExtensionRules();
    return { ok: true, id: r.id, version: r.version };
  }
  async removeExtension(id) {
    if (this.extIds.has(id)) { try { await this.extSession().removeExtension(this.extIds.get(id)); } catch { /* ignore */ } this.extIds.delete(id); }
    const had = this.ext.remove(id);
    if (id === 'blocker') { this.blocker = new Blocker(parseList(fs.readFileSync(path.join(__dirname, 'lib', 'blocklist.txt'), 'utf8'))); }
    return had;
  }
  // One request for a web app's own icon (or its home page to find it): https only, no cookies, capped size and time, failures just return not-ok
  async fetchIcon(u, { max }) {
    if (this.quitting || this.netBlocked || !WI.safeIconUrl(u)) return { ok: false };
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await net.fetch(u, { headers: { 'user-agent': 'MayfairDesktop/' + this.version + ' (app icon, no tracking)', accept: 'text/html,image/*;q=0.9' }, credentials: 'omit', signal: ctl.signal, redirect: 'follow' });
      if (!r.ok || !r.body || !WI.safeIconUrl(r.url || u)) return { ok: false };
      const len = Number(r.headers.get('content-length') || 0); if (len > max * 4) return { ok: false };
      const chunks = []; let n = 0; const rd = r.body.getReader();
      for (;;) { const { done, value } = await rd.read(); if (done) break; chunks.push(Buffer.from(value)); n += value.length; if (n >= max) { try { await rd.cancel(); } catch { /* ignore */ } break; } }
      return { ok: true, url: r.url || u, buf: Buffer.concat(chunks).subarray(0, max) };
    } catch { return { ok: false }; } finally { clearTimeout(timer); }
  }
  async fetchBuffer(u, max) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await net.fetch(u, { headers: { 'user-agent': 'MayfairDesktop/' + this.version }, credentials: 'omit', signal: ctl.signal, redirect: 'error' });
      if (!r.ok) throw new Error('Download failed (HTTP ' + r.status + ')');
      const len = Number(r.headers.get('content-length') || 0); if (len > max) throw new Error('Download too large');
      const b = Buffer.from(await r.arrayBuffer()); if (b.length > max) throw new Error('Download too large'); return b;
    } finally { clearTimeout(timer); }
  }

  // Mayfair's 'Block network' switch: every browser session goes offline while it is on (Wi-Fi itself is not touched)
  setNetworkBlocked(on) {
    this.netBlocked = !!on;
    const parts = [PARTITION.browse, PARTITION.private, PARTITION.tor, ...this.catalogue.map((a) => W.partitionFor(a.id))];
    for (const p of parts) { try { const s = session.fromPartition(p); if (this.netBlocked) s.enableNetworkEmulation({ offline: true }); else s.disableNetworkEmulation(); } catch { /* ignore */ } }
    return this.netBlocked;
  }

  blockingSessions() {
    const parts = [PARTITION.browse, PARTITION.private, PARTITION.tor, ...this.catalogue.filter((a) => a.adblock).map((a) => W.partitionFor(a.id))];
    return parts.map((p) => session.fromPartition(p));
  }
  applyAdblock() {
    if (!this.ad) return;
    const on = this.settings.get().adblock;
    for (const s of this.blockingSessions()) { try { on && this.ad.active ? this.ad.enable(s) : this.ad.disable(s); } catch { /* ignore */ } }
    this.pushState();
  }
  async fetchList(u) {
    const host = new URL(u).hostname;
    const ok = new Set([...FILTERS.lists.map((l) => new URL(l.url).hostname), new URL(FILTERS.resources).hostname]);
    if (!u.startsWith('https://') || !ok.has(host)) throw new Error('host not allowed');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await net.fetch(u, { headers: { 'user-agent': 'MayfairDesktop (filter list update, no tracking)' }, credentials: 'omit', signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally { clearTimeout(timer); }
  }

  roleOf(wc) { const r = wc && this.roles.get(wc.id); return r ? r.role : null; }

  setupSessions() {
    this.quietSpellcheck(session.defaultSession);
    const ua = (s, extra, lang) => { s.setUserAgent(s.getUserAgent().replace(/ Electron\/[\d.]+/, '').replace(/ mayfair-?desktop\/[\d.]+/ig, '') + (extra || ''), lang); };
    for (const [name, part] of Object.entries(PARTITION)) {
      const s = session.fromPartition(part);
      ua(s, name === 'home' ? ' MayfairDesktop/' + this.version : '', name === 'tor' ? PV.STD.acceptLanguages : undefined);
      this.hardenSession(s, name);
    }
    this.applyNetwork();
  }

  // Secure DNS (all traffic) and the user's own proxy (browser tabs, private tabs, Web apps).
  // Mayfair itself always goes direct. The Tor session only ever uses Tor.
  async applyNetwork() {
    const s = this.settings.get();
    try { app.configureHostResolver({ enableBuiltInResolver: true, ...PV.dohConfig(s.secureDns, s.dnsProvider) }); } catch { /* before ready or unsupported */ }
    const r = PV.proxyConfig(s.proxyMode, s.proxyHost, s.proxyPort);
    const cfg = r.ok ? r.config : { mode: 'direct' };
    for (const part of [PARTITION.browse, PARTITION.private, ...this.hardened]) { try { await session.fromPartition(part).setProxy(cfg); } catch { /* ignore */ } }
    this.proxyActive = cfg.mode !== 'direct';
    this.pushState();
    return r;
  }

  sessionForApp(app) {
    const part = W.partitionFor(app.id);
    const s = session.fromPartition(part);
    if (this.netBlocked) { try { s.enableNetworkEmulation({ offline: true }); } catch { /* ignore */ } }
    if (!this.hardened.has(part)) {
      this.hardened.add(part);
      s.setUserAgent(s.getUserAgent().replace(/ Electron\/[\d.]+/, '').replace(/ mayfair-?desktop\/[\d.]+/ig, ''));
      this.hardenSession(s, 'app');
      this.keepSignedIn(s, part);
      this.applyNetwork();
      if (app.adblock && this.ad) this.applyAdblock();
    }
    return s;
  }

  // ---------- web apps stay signed in ----------
  // Every web app has its own persistent partition ('persist:app-<id>', stored in the app data folder; nothing clears it except the
  // user: Reset, Remove, or Clear browsing data with Web apps ticked). Sign-in cookies without an expiry get 400 days and are renewed
  // on every open and daily; storage is flushed to disk shortly after changes and on quit so a crash or power cut keeps the login.
  keepSignedIn(s, part) {
    if (this.keepHooked.has(part)) return;
    this.keepHooked.add(part);
    s.cookies.on('changed', (_e, cookie, cause, removed) => {
      if (!KC.shouldRewrite(removed, cause)) { if (removed) this.flushSoon(s, part); return; }
      const d = KC.keepCookie(cookie); if (!d) { this.flushSoon(s, part); return; }
      s.cookies.set(d).catch(() => {}).then(() => this.flushSoon(s, part));
    });
  }
  flushSoon(s, part) {
    if (this.flushTimers.has(part)) return;
    const t = setTimeout(() => { this.flushTimers.delete(part); this.flushNow(s); }, 30000); if (t.unref) t.unref();
    this.flushTimers.set(part, t);
  }
  flushNow(s) { try { s.flushStorageData(); } catch { /* gone */ } try { s.cookies.flushStore().catch(() => {}); } catch { /* gone */ } }
  // push session cookies (and ones expiring within 90 days) out to 400 days; web app sessions only
  async sweepApp(a) {
    const s = this.sessionForApp(a); let n = 0;
    try {
      for (const c of await s.cookies.get({})) { const d = KC.keepCookie(c); if (d) { try { await s.cookies.set(d); n++; } catch { /* a cookie Chromium refuses stays as it is */ } } }
    } catch { /* session gone */ }
    if (n) this.flushSoon(s, W.partitionFor(a.id));
    return n;
  }
  sweepInstalledApps() { for (const i of this.appsStore.list()) { const a = this.appById(i.id); if (a) this.sweepApp(a).catch(() => {}); } }
  flushAppSessions() { for (const a of this.catalogue) if (this.hardened.has(W.partitionFor(a.id))) this.flushNow(session.fromPartition(W.partitionFor(a.id))); }

  // Chromium downloads spell-check dictionaries from a Google host (redirector.gvt1.com) on
  // Windows and Linux. Found by watching the network: that was the only unexplained connection.
  // macOS uses the system spell checker with no download, so it stays on there.
  quietSpellcheck(s) {
    if (process.platform === 'darwin') return;
    try { s.setSpellCheckerEnabled(false); s.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/'); } catch { /* older Electron */ }
  }

  hardenSession(s, kind) {
    this.quietSpellcheck(s);
    s.setPermissionRequestHandler((wc, permission, callback, details) => {
      const origin = O.siteKey(details.requestingUrl || (wc && wc.getURL()));
      const mayfair = kind === 'home' && O.isMayfairUrl(details.requestingUrl || '');
      if (permission === 'notifications' && !this.settings.get().notifications) return callback(false);
      const saved = origin ? this.sitePerms.get(origin, permission === 'media' ? 'media' : permission) : 'ask';
      const d = decidePermission(permission, { mayfair, saved });
      if (d !== 'ask') return callback(d === 'allow');
      if (kind === 'private' || kind === 'tor' || !origin) return this.askPermission(wc, origin, permission, details, callback, false);
      return this.askPermission(wc, origin, permission, details, callback, true);
    });
    s.setPermissionCheckHandler((wc, permission, requestingOrigin) => {
      const mayfair = kind === 'home' && O.isMayfairUrl(requestingOrigin);
      const saved = this.sitePerms.get(requestingOrigin, permission);
      return decidePermission(permission, { mayfair, saved }) === 'allow';
    });
    s.setDevicePermissionHandler(() => false);
    s.on('will-download', (e, item, wc) => this.onDownload(item, wc, kind));
    s.webRequest.onBeforeRequest((d, cb) => {
      if (kind === 'home' || kind === 'app' || !this.settings.get().adblock || (this.ad && this.ad.active)) return cb({});
      const tab = d.webContents && [...this.tabs.values()].find((t) => t.wc.id === d.webContents.id);
      const pageUrl = d.webContents ? d.webContents.getURL() : '';
      if (this.blocker.shouldBlock(d.url, { pageUrl, resourceType: d.resourceType })) {
        if (tab) { tab.blocked = (tab.blocked || 0) + 1; this.pushState(); }
        return cb({ cancel: true });
      }
      cb({});
    });
  }

  // ---------- window and the Mayfair view ----------
  createWindow({ hidden }) {
    const st = this.winState.get();
    const displays = screen.getAllDisplays();
    const b = sanitizeBounds(st.bounds, displays);
    this.win = new BaseWindow({
      ...b, minWidth: MIN.width, minHeight: MIN.height, show: false,
      title: 'Mayfair Desktop', backgroundColor: '#0a0a0a', autoHideMenuBar: true,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    });
    if (st.maximized) this.win.maximize();
    this.win.setMenuBarVisibility(false);
    this.win.on('resize', () => { this.applyBounds(); this.rememberBounds(); });
    this.win.on('move', () => this.rememberBounds());
    this.win.on('maximize', () => { this.winState.update({ maximized: true }); this.relayout(); });
    this.win.on('unmaximize', () => { this.winState.update({ maximized: false }); this.relayout(); });
    for (const ev of ['restore', 'show', 'resized', 'will-resize', 'moved']) this.win.on(ev, () => this.relayout());
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed']) screen.on(ev, () => this.relayout());
    this.win.on('enter-full-screen', () => { this.applyBounds(); this.pushState(); });
    this.win.on('leave-full-screen', () => { for (const g of this.groups.values()) if (g.fsTab != null) this.leaveHtmlFullscreen(g); this.applyBounds(); this.pushState(); });
    this.win.on('close', (e) => {
      if (!this.quitting && this.settings.get().tray && this.settings.get().closeToTray) { e.preventDefault(); this.win.hide(); }
    });
    this.win.on('closed', () => { this.win = null; });
    this.win.on('focus', () => { if (this.home && !this.home.wc.isDestroyed() && !this.hasFocusedTab()) this.home.wc.focus(); });
    const s = this.settings.get();
    this.relayout();
    if (!hidden) this.showWindow();
    if (s.startFullscreen) this.win.setFullScreen(true);
  }
  // The Mayfair view always fills the window content area: lay out now and once more after the window system has settled
  // (maximize, restore, show from the tray and the saved window state arrive a moment after the event).
  relayout() {
    this.applyBounds();
    for (const ms of [50, 300, 1000]) { const t = setTimeout(() => { if (this.win && !this.win.isDestroyed()) this.applyBounds(); }, ms); if (t.unref) t.unref(); }
  }
  hasFocusedTab() { for (const g of this.groups.values()) { const t = this.activeTab(g); if (t && t.shown && t.wc.isFocused()) return true; } return false; }

  createHome() {
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION.home, preload: PRELOAD('web'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
        allowRunningInsecureContent: false, spellcheck: process.platform === 'darwin', additionalArguments: ['--mf-role=web'],
        devTools: this.devTools,      // the Mayfair view has no developer tools in an installed build (owner switch: MAYFAIR_DESKTOP_DEVTOOLS=1)
      },
    });
    const wc = view.webContents;
    this.home = { view, wc };
    this.roles.set(wc.id, { role: 'web' });
    this.win.contentView.addChildView(view);
    if (this.tampered) { const orig = wc.loadURL.bind(wc); wc.loadURL = (u, o) => (isInternal(u) || u === 'about:blank' ? orig(u, o) : Promise.resolve()); }   // about:blank must pass: preparePrivacy needs a first navigation. A changed install never opens Mayfair Cloud, whoever asks
    this.wireHome(wc);
    this.preparePrivacy({ wc }, 'home').then(() => {
      if (wc.isDestroyed()) return;
      if (this.tampered) { wc.loadFile(path.join(UI_DIR, 'tampered.html')).catch(() => {}); return; }
      wc.loadURL(O.HOME_URL).catch(() => {});
    });
  }

  wireHome(wc) {
    const lockedNav = (e, url) => {
      if (isInternal(url)) return;
      if (PROT.isViewSource(url)) { e.preventDefault(); return; }      // no view-source: of the Mayfair page
      const c = O.classifyNavigation(url, { locked: true });
      if (c === 'allow') return;
      e.preventDefault();
      this.routeBlockedNav(c, url);
    };
    wc.on('will-navigate', (e, u) => { lockedNav(e, e.url || u); });
    wc.on('will-redirect', (e, u) => { lockedNav(e, e.url || u); });
    wc.setWindowOpenHandler((d) => {
      if (PROT.isViewSource(d.url)) return { action: 'deny' };
      const c = O.classifyNavigation(d.url, { locked: true });
      if (c === 'external') { shell.openExternal(d.url).catch(() => {}); return { action: 'deny' }; }
      if (c === 'block') return { action: 'deny' };
      if (O.isMayfairUrl(d.url)) { setImmediate(() => wc.loadURL(d.url)); return { action: 'deny' }; }
      this.openInBrowser(d.url);
      return { action: 'deny' };
    });
    if (!this.devTools) {      // Mayfair view: developer tools and page source shortcuts do nothing, and if anything still opens them they are closed at once
      wc.on('before-input-event', (e, input) => { if (PROT.isDevToolsKey(input)) e.preventDefault(); });
      wc.on('devtools-opened', () => { try { wc.closeDevTools(); } catch { /* gone */ } });
    }
    wc.on('did-navigate', () => { this.subs.clear(); });   // a new document is loaded: it subscribes again (a refused navigation changes nothing)
    wc.on('dom-ready', () => this.flushHome());
    wc.on('did-stop-loading', () => this.flushHome());      // a same-page (hash) navigation never fires did-finish-load
    wc.on('did-finish-load', () => { if (O.isMayfairUrl(wc.getURL())) this.flushHome(); });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || code === 0) return; // -3 = aborted by a newer navigation
      wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { u: url, e: desc, c: String(code), h: '1' } }).catch(() => {});
    });
    wc.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { u: wc.getURL(), e: 'The page crashed (' + d.reason + ')', c: 'crash', h: '1' } }).catch(() => {}); });
    wc.on('enter-html-full-screen', () => { this.win.setFullScreen(true); });
    wc.on('leave-html-full-screen', () => { if (!this.settings.get().startFullscreen) this.win.setFullScreen(false); });
    wc.on('context-menu', (_e, p) => this.contextMenu(wc, p, { locked: true, priv: false }));
  }

  showWindow() { if (!this.win) return; if (this.win.isMinimized()) this.win.restore(); this.win.show(); this.win.focus(); }
  rememberBounds() { if (!this.win || this.win.isFullScreen() || this.win.isMaximized() || this.win.isMinimized()) return; this.winState.update({ bounds: this.win.getBounds() }); }
  toggleFullscreen(force) {
    if (!this.win) return false;
    const next = typeof force === 'boolean' ? force : !this.win.isFullScreen();
    this.win.setFullScreen(next);
    this.settings.set({ startFullscreen: next });
    this.onSettingsChanged(['startFullscreen']);
    return next;
  }

  // ---------- window groups ----------
  // One group per Browser window in Mayfair Cloud. Every tab belongs to exactly one group; a group has its own tab list,
  // active tab, bounds, occlusion and HTML5 fullscreen tab. Bookmarks, history, downloads, permissions and settings are global.
  createGroup({ quiet = false, focus = true, webapp = null } = {}) {
    const gid = ++this.gidSeq;
    const g = { gid, webapp, model: new TabModel(() => ++this.tabSeq), bounds: { x: 0, y: 0, w: 0, h: 0, visible: false }, occluded: false, occSeq: 0, fsTab: null, closed: [] };
    this.groups.set(gid, g);
    if (focus || this.focusedGid == null) this.focusedGid = gid;
    if (!webapp) this.lastNormalGid = gid;
    if (!quiet) { this.windowsEvent({ created: gid, ...(webapp ? { webapp } : {}) }); this.pushState(); }
    return g;
  }
  // The group a plain call means: the focused group, unless that is a web app window (those hold exactly one app tab);
  // then the last focused normal Browser window, else the lowest normal one, else a new one.
  normalGroup() {
    const f = this.groups.get(this.focusedGid);
    if (f && !f.webapp) return f;
    const l = this.groups.get(this.lastNormalGid);
    if (l && !l.webapp) return l;
    return [...this.groups.values()].filter((x) => !x.webapp).sort((a, b) => a.gid - b.gid)[0] || this.createGroup({ focus: false });
  }
  appGroup(appId) { for (const g of this.groups.values()) if (g.webapp === appId) return g; return null; }
  // A group bound to a web app: reuses the existing one (focus) or makes one holding exactly that app's tab.
  openAppGroup(appId) {
    const a = this.appById(appId); if (!a) throw new Error('unknown app');
    this.appsStore.add(appId);
    let g = this.appGroup(appId);
    if (g) { this.focusedGid = g.gid; const tab = g.model.tabs[0]; return { gid: g.gid, id: tab ? tab.id : null, existing: true }; }
    g = this.createGroup({ quiet: true, webapp: appId });
    const have = this.allMeta().find((t) => t.appId === appId);
    let id;
    if (have) { const r = this.moveTab(have.id, g.gid, {}, true); id = have.id; if (!r.ok) id = null; }
    if (id == null) id = this.newTab({ url: a.url, appId, gid: g.gid });
    this.windowsEvent({ created: g.gid, webapp: appId });
    this.pushState();
    this.onAppsChanged();
    return { gid: g.gid, id, existing: false };
  }
  // gid missing: the focused group, else the lowest one, else a new default group. A wrong gid is an error.
  group(gid) {
    if (gid == null) return this.normalGroup();
    const g = this.groups.get(gid);
    if (!g) throw new Error('no such window');
    return g;
  }
  groupOfTab(id) { const t = this.tabs.get(id); return t ? (this.groups.get(t.gid) || null) : null; }
  allMeta() { const r = []; for (const g of this.groups.values()) r.push(...g.model.tabs); return r; }
  metaOf(id) { for (const g of this.groups.values()) { const m = g.model.get(id); if (m) return m; } return null; }
  windowsEvent(extra = {}) { this.emit('windows', { groups: [...this.groups.keys()].sort((a, b) => a - b), focusedGid: this.focusedGid, apps: this.appGroups(), ...extra }); }
  appGroups() { const o = {}; for (const g of this.groups.values()) if (g.webapp) o[g.gid] = g.webapp; return o; }
  focusGroup(gid) { const g = this.groups.get(gid); if (!g) return false; this.focusedGid = gid; if (!g.webapp) this.lastNormalGid = gid; return true; }
  closeGroup(gid) {
    const g = this.groups.get(gid); if (!g) return false;
    for (const m of g.model.tabs.slice()) this.closeTab(m.id);
    this.groups.delete(gid);
    if (this.lastNormalGid === gid) this.lastNormalGid = null;
    if (this.focusedGid === gid) this.focusedGid = [...this.groups.keys()].sort((a, b) => a - b)[0] ?? null;
    this.windowsEvent({ closed: gid });
    this.pushState();
    return true;
  }
  moveTab(id, to, opts = {}, intoApp = false) {
    const src = this.groupOfTab(id); if (!src) return { ok: false, gid: null };
    let dst;
    if (to === 'new') dst = null; else { dst = this.groups.get(to); if (!dst) throw new Error('no such window'); }
    if (!intoApp && (src.webapp || (dst && dst.webapp))) return { ok: false, gid: src.gid };      // a web app window keeps its one tab
    if (dst === src) return { ok: true, gid: src.gid };
    if (src.fsTab === id) this.leaveHtmlFullscreen(src);
    const t = this.tabs.get(id);
    const meta = src.model.detach(id);
    const created = !dst;
    if (!dst) dst = this.createGroup({ quiet: true });
    dst.model.attach(meta, opts && opts.index);
    t.gid = dst.gid;
    t.shown = false;
    this.focusedGid = dst.gid; if (!dst.webapp) this.lastNormalGid = dst.gid;
    if (created) this.windowsEvent({ created: dst.gid });
    this.applyBounds(); this.saveTabs(); this.pushState();
    return { ok: true, gid: dst.gid };
  }

  // ---------- bounds, occlusion, capture ----------
  zf() { try { return this.home && !this.home.wc.isDestroyed() ? this.home.wc.getZoomFactor() || 1 : 1; } catch { return 1; } }
  homeTab() { return this.home; }
  activeTab(g) { g = g || this.groups.get(this.focusedGid); return g ? this.tabs.get(g.model.activeId) : undefined; }
  anyFullscreen() { for (const g of this.groups.values()) if (g.fsTab != null) return true; return false; }

  applyBounds() {
    if (!this.win || !this.home) return;
    const { width: cw, height: ch } = this.win.getContentBounds();
    this.home.view.setBounds({ x: 0, y: 0, width: cw, height: ch });
    for (const g of this.groups.values()) {
      const active = this.activeTab(g);
      for (const m of g.model.tabs) {
        const t = this.tabs.get(m.id); if (!t) continue;
        const id = m.id;
        if (t !== active) { if (t.shown) { t.view.setVisible(false); t.shown = false; } continue; }
        let r, vis;
        if (g.fsTab === id) { r = { x: 0, y: 0, width: cw, height: ch }; vis = true; }
        else {
          const b = g.bounds, z = this.zf();
          const x = Math.max(0, Math.min(cw, Math.round(b.x * z))), y = Math.max(0, Math.min(ch, Math.round(b.y * z)));
          const w = Math.max(0, Math.min(cw - x, Math.round(b.w * z))), h = Math.max(0, Math.min(ch - y, Math.round(b.h * z)));
          r = { x, y, width: w, height: h };
          vis = !!b.visible && !g.occluded && w >= 1 && h >= 1;
        }
        t.view.setBounds(r);
        t.view.setVisible(vis);
        t.shown = vis;
      }
    }
  }
  setBounds(b, gid) { const g = this.group(gid); g.bounds = { x: b.x, y: b.y, w: b.w, h: b.h, visible: b.visible !== false }; this.applyBounds(); return true; }

  async captureNow(t, timeoutMs) {
    try {
      const img = await Promise.race([t.wc.capturePage(), new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
      if (!img || img.isEmpty()) return '';
      const url = 'data:image/jpeg;base64,' + img.toJPEG(70).toString('base64');
      for (const [id, x] of this.tabs) if (x === t) this.shots.set(id, url);
      return url;
    } catch { return ''; }
  }
  async capture(gid) {
    const g = this.group(gid);
    const t = this.activeTab(g); if (!t) return '';
    const id = g.model.activeId;
    if (g.occluded || !t.shown) return this.shots.get(id) || '';
    return (await this.captureNow(t, 1500)) || this.shots.get(id) || '';
  }
  async setOccluded(on, opts, gid) {
    const g = this.group(gid);
    const seq = ++g.occSeq;
    const t = this.activeTab(g);
    if (on) {
      let captured = false;
      if (!g.occluded && t && t.shown && !(opts && opts.capture === false)) captured = !!(await this.captureNow(t, 350));
      if (seq !== g.occSeq) return { captured };      // a newer call (false) won while the capture ran
      g.occluded = true; this.applyBounds();
      return { captured: captured || !!(t && this.shots.get(g.model.activeId)) };
    }
    g.occluded = false; this.applyBounds();
    if (opts && opts.focus && t) t.wc.focus();
    return { captured: false };
  }

  // ---------- tabs ----------
  newTab({ url = '', private: priv = false, activate = true, afterActive = false, afterId = null, appId = null, tor = false, pinned = false, gid = null } = {}) {
    if (tor && !this.tor.ready) { this.notice('Tor is not connected'); return null; }
    let grp = this.group(gid);
    const webapp = appId ? this.appById(appId) : null;
    if (grp.webapp && (grp.model.tabs.length > 0 || appId !== grp.webapp)) grp = this.normalGroup();      // a web app window never gets a second tab
    if (webapp) { this.sessionForApp(webapp); this.sweepApp(webapp).catch(() => {}); }
    const kind = webapp ? 'app' : tor ? 'tor' : priv ? 'private' : 'browse';
    if (tor) this.torSession();
    const view = new WebContentsView({
      webPreferences: {
        partition: webapp ? W.partitionFor(webapp.id) : PARTITION[kind], preload: PRELOAD('page'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
        allowRunningInsecureContent: false, spellcheck: process.platform === 'darwin', additionalArguments: ['--mf-role=page'],
      },
    });
    const tab = grp.model.add({ pinned, private: priv || tor, tor, url: '', activate, afterActive, afterId, appId: webapp ? webapp.id : null });
    const t = { gid: grp.gid, view, wc: view.webContents, loading: false, favicon: '', pw: false, blocked: 0, lastInput: 0, find: null, crashed: false, shown: false };
    view.setVisible(false);
    this.tabs.set(tab.id, t);
    this.roles.set(t.wc.id, { role: 'page', tabId: tab.id });
    this.win.contentView.addChildView(view);
    this.wireTab(tab.id, t, { priv: priv || tor, webapp });
    const ready = this.preparePrivacy(t, kind);
    const target = url ? (webapp ? url : O.normalizeInput(url, this.settings.get().searchEngine)) : null;
    ready.then(() => {
      if (!this.tabs.has(tab.id)) return;
      if (target) t.wc.loadURL(target).catch(() => {});
      else t.wc.loadFile(path.join(UI_DIR, 'newtab.html'), { query: { e: this.settings.get().searchEngine } }).catch(() => {});
    });
    this.applyBounds();
    this.saveTabs();
    this.pushState();
    return tab.id;
  }

  closeTab(id) {
    const g = this.groupOfTab(id);
    if (!g) return false;
    const r = g.model.close(id);
    if (!r.closed) return false;
    const t = this.tabs.get(id);
    this.tabs.delete(id);
    this.shots.delete(id);
    this.roles.delete(t.wc.id);
    if (g.fsTab === id) g.fsTab = null;
    if (!r.tab.private && !r.tab.tor && r.tab.url) { g.closed.unshift({ url: r.tab.url, appId: r.tab.appId }); g.closed.length = Math.min(g.closed.length, 10); }
    try { this.win.contentView.removeChildView(t.view); } catch { /* gone */ }
    try { t.wc.close(); } catch { /* gone */ }
    for (const [pid, p] of [...this.perms]) if (p.tabId === id) this.dropPerm(pid, true);
    for (const [oid, o] of [...this.pwOffers]) if (o.tabId === id) this.dropOffer(oid);
    for (const [oid, o] of [...this.afOffers]) if (o.tabId === id) this.dropAf(oid);
    for (const [rid, r] of [...this.afRequests]) if (r.tabId === id) { clearTimeout(r.timer); this.afRequests.delete(rid); }
    t.pwCand = null;
    if (r.tab.private && !this.allMeta().some((x) => x.private && !x.tor)) this.wipePrivate();
    if (r.tab.tor && !this.allMeta().some((x) => x.tor)) { this.wipeTor(); this.tor.stop(); }
    if (t.wasFs && !this.anyFullscreen() && this.win && this.win.isFullScreen() && !this.settings.get().startFullscreen) this.win.setFullScreen(false);
    this.applyBounds();
    this.saveTabs();
    this.pushState();
    return true;
  }
  reopenClosed(gid) {
    const g = this.group(gid);
    const c = g.closed.shift(); if (!c) return null;
    return this.newTab({ url: c.url, appId: c.appId, gid: g.gid });
  }
  saveTabs() {
    const per = [...this.groups.values()].sort((a, b) => a.gid - b.gid).map((g) => g.model.tabs.filter((m) => !m.private && !m.tor && !m.appId && m.url).map((m) => m.url)).filter((u) => u.length);
    this.tabsStore.data.groups = per.slice(0, 8).map((u) => u.slice(0, 30));
    this.tabsStore.data.urls = per.flat().slice(0, 30);
    this.tabsStore.save();
  }

  async wipePrivate() {
    const s = session.fromPartition(PARTITION.private);
    try { await s.clearStorageData(); await s.clearCache(); await s.clearAuthCache(); } catch { /* best effort */ }
  }

  torSession() {
    const s = session.fromPartition(PARTITION.tor);
    s.setProxy({ mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:' + this.tor.state.socksPort, proxyBypassRules: '<-loopback>' });
    return s;
  }
  async wipeTor() { const s = session.fromPartition(PARTITION.tor); try { await s.clearStorageData(); await s.clearCache(); await s.clearAuthCache(); await s.closeAllConnections(); } catch { /* best effort */ } }

  // WebRTC leak policy, standard locale and reduced fingerprint, set BEFORE the first load.
  async preparePrivacy(t, kind) {
    const p = PV.tabPrivacy(kind, this.settings.get());
    try { t.wc.setWebRTCIPHandlingPolicy(p.webrtc); } catch { /* ignore */ }
    try {
      t.wc.debugger.attach('1.3');
      // The debugger answers (and a new-document script only takes effect) after a first
      // navigation, so load a blank page, set everything up, then let the real load follow.
      await t.wc.loadURL('about:blank').catch(() => {});
      const send = (m, params) => t.wc.debugger.sendCommand(m, params).catch(() => {});
      await send('Page.enable');
      // Sites decide what they support from the browser identity: a plain Chrome string and Chrome brand list, no app names.
      const full = process.versions.chrome || '140.0.0.0', major = full.split('.')[0];
      const uaStr = t.wc.getUserAgent().replace(/ Electron\/[\d.]+/, '').replace(/ mayfair-?desktop\/[\d.]+/ig, '');
      const plat = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
      await send('Emulation.setUserAgentOverride', {
        userAgent: uaStr, acceptLanguage: p.standardLocale ? 'en-US,en' : undefined,
        userAgentMetadata: {
          brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not=A?Brand', version: '24' }],
          fullVersionList: [{ brand: 'Chromium', version: full }, { brand: 'Google Chrome', version: full }, { brand: 'Not=A?Brand', version: '24.0.0.0' }],
          fullVersion: full, platform: plat, platformVersion: process.platform === 'win32' ? '10.0.0' : process.platform === 'darwin' ? '14.0.0' : '6.0.0',
          architecture: process.arch === 'arm64' ? 'arm' : 'x86', model: '', mobile: false, bitness: '64', wow64: false,
        },
      });
      if (p.standardLocale) {
        await send('Emulation.setTimezoneOverride', { timezoneId: PV.STD.timezone });
        await send('Emulation.setLocaleOverride', { locale: PV.STD.locale });
      }
      if (p.reduceFingerprint) await send('Page.addScriptToEvaluateOnNewDocument', { source: PV.fingerprintScript() });
      t.privacyApplied = p;
    } catch { t.privacyApplied = null; }
  }

  async torNewTab(opts = {}) {
    if (!this.tor.ready) {
      try { await this.tor.start(); } catch (e) { this.notice(e.message); return null; }
    }
    return this.newTab({ ...opts, tor: true });
  }

  activate(id) {
    const g = this.groupOfTab(id);
    if (!g || !g.model.activate(id)) return false;
    this.applyBounds();
    this.pushState();
    return true;
  }

  wireTab(id, t, { priv, webapp }) {
    const wc = t.wc;
    const upd = () => this.pushState(t.gid);
    const nav = (e, url) => {
      if (isInternal(url)) return;
      let c = O.classifyNavigation(url, { locked: false });
      if (webapp && c === 'allow') c = W.staysInApp(webapp, url) ? 'allow' : 'newtab';
      if (c === 'allow') return;
      e.preventDefault();
      this.routeBlockedNav(c, url, { fromPriv: priv });
    };
    wc.on('will-navigate', (e, u) => { nav(e, e.url || u); });
    wc.on('will-redirect', (e, u) => { nav(e, e.url || u); });
    wc.setWindowOpenHandler((d) => {
      const c = O.classifyNavigation(d.url, { locked: false });
      if (c === 'external') { shell.openExternal(d.url).catch(() => {}); return { action: 'deny' }; }
      if (c === 'block') return { action: 'deny' };
      if (webapp && W.staysInApp(webapp, d.url)) { setImmediate(() => wc.loadURL(d.url).catch(() => {})); return { action: 'deny' }; }
      if (webapp && (this.groups.get(t.gid) || {}).webapp) { setImmediate(() => this.openInBrowser(d.url)); return { action: 'deny' }; }   // leaving an app window: a normal Browser window
      const origin = O.siteKey(wc.getURL());
      const userOpened = popupAllowed(Date.now(), t.lastInput);
      const allowedBySite = origin && this.sitePerms.get(origin, 'popups') === 'allow';
      if (userOpened || allowedBySite) { setImmediate(() => this.newTab({ url: d.url, private: priv, afterActive: true, gid: this.tabs.has(id) ? t.gid : null })); return { action: 'deny' }; }
      this.addPopup({ tabId: id, origin: origin || '', url: d.url, priv });
      return { action: 'deny' };
    });
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' || input.type === 'mouseDown') t.lastInput = Date.now();
      const a = actionForKey(input);
      if (a) { e.preventDefault(); this.focusedGid = t.gid; const kg = this.groups.get(t.gid); if (kg && !kg.webapp) this.lastNormalGid = t.gid; this.menuAction(a, t.gid); }
    });
    wc.on('input-event', (_e, ev) => { if (ev.type === 'mouseDown' || ev.type === 'keyDown') t.lastInput = Date.now(); });
    // the page title arrives after the visit was recorded, so the history entry gets it here
    wc.on('page-title-updated', (_e, title) => { const m = this.metaOf(id); if (m) { m.title = title; if (m.url && !priv) { const hs = webapp ? this.histFor(webapp.id) : this.history; if ((hs.list(1)[0] || {}).url === m.url) { const it = hs.list(1)[0]; it.title = String(title).slice(0, 200); hs.s.save(); } } if (webapp) this.setBadge(webapp, W.badgeFromTitle(title), ((this.groupOfTab(id) || {}).model || {}).activeId === id && !!this.win && this.win.isFocused()); upd(); } });
    wc.on('page-favicon-updated', (_e, f) => { t.favicon = (f || []).find((x) => /^https?:/.test(x)) || ''; upd(); });
    wc.on('did-start-loading', () => { t.loading = true; upd(); });
    wc.on('did-stop-loading', () => { t.loading = false; upd(); });
    wc.on('audio-state-changed', upd);
    // the error page itself does not clear the crash mark
    wc.on('did-start-navigation', (_e, url, inPlace, isMain) => { if (isMain && !inPlace) { t.blocked = 0; t.pw = false; if (!isInternal(url)) t.crashed = false; } });
    const onNav = (_e, url) => {
      const m = this.metaOf(id);
      if (!m) return;
      m.url = isInternal(url) ? '' : url;
      this.applyZoom(t, url);
      if (!isInternal(url) && !priv) { const hs = webapp ? this.histFor(webapp.id) : this.history; hs.add(url, wc.getTitle(), Date.now()); this.noteVisit(hs, webapp ? webapp.id : null); }
      this.saveTabs();
      upd();
    };
    wc.on('did-navigate', (e, url) => { onNav(e, url); this.afterNavigation(id, t); });
    // Google's results page already follows the dark theme; this only swaps its grey for Mayfair's own background so the two match. Background only, search pages only.
    const matchOn = () => !webapp && !priv && this.settings.get().matchSearchColors !== false && !wc.isDestroyed() && /^https:\/\/www\.google\.[a-z.]+\/search/.test(wc.getURL());
    // only when Google itself is already showing its dark theme (otherwise a dark background under dark text would be unreadable)
    const matchColors = () => { try { if (!matchOn()) return; wc.executeJavaScript(SEARCH_DARK_JS, true).then((dark) => { if (dark && matchOn()) wc.insertCSS(SEARCH_MATCH_CSS).catch(() => {}); }).catch(() => {}); } catch {} };
    // Google draws the selected tab's underline in a changing class: find the thin light bar under the active result tab by how it looks and mark it, so the CSS can colour it
    const markTab = () => { try { if (!matchOn()) return; wc.executeJavaScript(SEARCH_TAB_JS, true).catch(() => {}); } catch {} };
    wc.on('dom-ready', () => { matchColors(); markTab(); setTimeout(markTab, 700); setTimeout(markTab, 2000); });
    wc.on('did-finish-load', markTab);
    wc.on('did-navigate-in-page', matchColors);
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) onNav(_e, url); });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || code === 0) return; // -3 = aborted by a newer navigation
      wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { u: url, e: desc, c: String(code), h: '0' } }).catch(() => {});
    });
    wc.on('render-process-gone', (_e, d) => {
      if (d.reason === 'clean-exit') return;
      t.crashed = true; upd();
      wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { u: wc.getURL(), e: 'The page crashed (' + d.reason + ')', c: 'crash', h: '0' } }).catch(() => {});
    });
    wc.on('found-in-page', (_e, r) => { this.emit('find-result', { gid: t.gid, id, n: r.activeMatchOrdinal, of: r.matches }); });
    wc.on('enter-html-full-screen', () => this.enterHtmlFullscreen(id));
    wc.on('leave-html-full-screen', () => { const g = this.groupOfTab(id); if (g && g.fsTab === id) this.leaveHtmlFullscreen(g); });
    wc.on('context-menu', (_e, p) => this.contextMenu(wc, p, { locked: false, priv }));
    wc.on('zoom-changed', (_e, dir) => this.zoom(id, dir === 'in' ? 1 : -1));
    wc.on('focus', () => { this.focusedGid = t.gid; const fg = this.groups.get(t.gid); if (fg && !fg.webapp) this.lastNormalGid = t.gid; this.emit('focus', { focused: true, gid: t.gid }); });
    wc.on('blur', () => this.emit('focus', { focused: false, gid: t.gid }));
  }

  enterHtmlFullscreen(id) {
    const g = this.groupOfTab(id); if (!g) return;
    g.fsTab = id;
    const t = this.tabs.get(id);
    if (t) t.wasFs = true;
    this.win.setFullScreen(true);
    if (t) this.win.contentView.addChildView(t.view);       // above everything
    this.applyBounds();
    this.emit('fullscreen', { on: true, tabId: id, gid: g.gid });
  }
  leaveHtmlFullscreen(g) {
    g = g || [...this.groups.values()].find((x) => x.fsTab != null);
    if (!g) return;
    const id = g.fsTab;
    g.fsTab = null;
    const t = this.tabs.get(id); if (t) t.wasFs = false;
    if (!this.anyFullscreen() && !this.settings.get().startFullscreen && this.win && this.win.isFullScreen()) this.win.setFullScreen(false);
    this.applyBounds();
    this.emit('fullscreen', { on: false, tabId: id, gid: g.gid });
  }

  routeBlockedNav(c, url, { fromPriv } = {}) {
    if (c === 'newtab') this.openInBrowser(url, { private: fromPriv });
    else if (c === 'external') shell.openExternal(url).catch(() => {});
  }
  // A web address that Mayfair (or the system) wants shown in the Browser. The Cloud side opens its Browser window and
  // creates the tab; when nothing is listening yet (older Cloud) the system browser is used so the link is never lost.
  openInBrowser(url, { private: priv = false, newWindow = false } = {}) {
    if (O.classifyNavigation(url, { locked: false }) !== 'allow') return false;
    this.showWindow();
    const fgrp = this.groups.get(this.focusedGid), lgrp = this.groups.get(this.lastNormalGid);
    const gid = fgrp && !fgrp.webapp ? fgrp.gid : lgrp && !lgrp.webapp ? lgrp.gid : ([...this.groups.values()].find((x) => !x.webapp) || {}).gid ?? null;
    if (this.subs.has('open-url')) this.emit('open-url', { url, ...(priv ? { private: true } : {}), gid, ...(newWindow ? { newWindow: true } : {}) });
    else shell.openExternal(url).catch(() => {});
    return true;
  }

  contextMenu(wc, p, { locked, priv }) {
    const items = [];
    const sel = (p.selectionText || '').trim();
    const tabEntry = locked ? null : [...this.tabs.values()].find((x) => x.wc === wc);
    const open = (url) => (locked ? this.openInBrowser(url) : this.newTab({ url, afterActive: true, private: priv, gid: tabEntry ? tabEntry.gid : null }));
    if (p.linkURL) {
      const lc = O.classifyNavigation(p.linkURL, { locked: false });
      if (lc === 'allow') items.push({ label: 'Open link in new tab', click: () => open(p.linkURL) });
      if (lc === 'allow' && !locked && !priv) items.push({ label: 'Open link in new window', click: () => { if (tabEntry) this.focusedGid = tabEntry.gid; this.openInBrowser(p.linkURL, { newWindow: true }); } });
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    }
    if (sel) {
      items.push({ role: 'copy' });
      if (!locked) items.push({ label: 'Search for "' + sel.slice(0, 30) + (sel.length > 30 ? '...' : '') + '"', click: () => this.newTab({ url: sel, afterActive: true, private: priv, gid: tabEntry ? tabEntry.gid : null }) });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    if (p.mediaType === 'image' && p.srcURL) items.push({ label: 'Save image', click: () => wc.downloadURL(p.srcURL) });
    if (!items.length && !locked) items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() }, { label: 'Reload', click: () => wc.reload() });
    if (!(locked && !this.devTools) && !app.isPackaged) items.push({ type: 'separator' }, { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    if (items.length && this.win) Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // ---------- zoom ----------
  applyZoom(t, url) { const k = O.siteKey(url); const lv = k && this.zoomStore.data.levels[k]; try { t.wc.setZoomLevel(typeof lv === 'number' ? lv : 0); } catch { /* ignore */ } }
  zoom(id, delta) {
    const t = this.tabs.get(id); if (!t) return 100;
    const cur = pctOf(t.wc.getZoomLevel());
    let i = ZOOM_STEPS.reduce((best, p, ix) => (Math.abs(p - cur) < Math.abs(ZOOM_STEPS[best] - cur) ? ix : best), 0);
    if (delta === 'reset') i = ZOOM_STEPS.indexOf(100); else i = Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + Math.sign(delta) * Math.min(10, Math.abs(delta))));
    const pct = ZOOM_STEPS[i];
    const next = pct === 100 ? 0 : levelOf(pct);
    t.wc.setZoomLevel(next);
    const k = O.siteKey(t.wc.getURL());
    if (k) { if (next === 0) delete this.zoomStore.data.levels[k]; else this.zoomStore.data.levels[k] = next; this.zoomStore.save(); }
    this.pushState();
    return pct;
  }

  // ---------- find ----------
  async find(id, text, o = {}) {
    const t = this.tabs.get(id); if (!t) return { n: 0, of: 0 };
    if (!text) { this.stopFind(id); return { n: 0, of: 0 }; }
    const fwd = o.forward !== false, next = !!o.findNext;
    t.wc.findInPage(text, { forward: fwd, findNext: next, matchCase: !!o.matchCase });
    // Chromium's own count event is not reliable in every environment, so count here too.
    let total = 0;
    try { total = await t.wc.executeJavaScript(`(()=>{const mc=${!!o.matchCase};const f=(x)=>mc?x:x.toLowerCase();const q=f(${JSON.stringify(text)});const s=f((document.body&&document.body.innerText)||'');let n=0,i=0;while(q&&(i=s.indexOf(q,i))>=0){n++;i+=q.length;}return n})()`); } catch { /* page not scriptable */ }
    const f = t.find && t.find.text === text && next ? t.find : { text, idx: 0 };
    f.idx = !total ? 0 : !next || !f.idx ? 1 : fwd ? (f.idx % total) + 1 : ((f.idx - 2 + total) % total) + 1;
    t.find = f;
    const r = { n: f.idx, of: total };
    this.emit('find-result', { gid: (this.tabs.get(id) || {}).gid ?? null, id, ...r });
    return r;
  }
  stopFind(id) { const t = this.tabs.get(id); if (t) { try { t.wc.stopFindInPage('clearSelection'); } catch { /* gone */ } t.find = null; this.emit('find-result', { gid: t.gid, id, n: 0, of: 0 }); } return true; }

  // ---------- events to the Mayfair page ----------
  emit(name, payload) {
    const h = this.home;
    if (!h || h.wc.isDestroyed()) return;
    try { h.wc.send('br:ev', name, payload); } catch { /* page gone */ }
  }
  notice(text) { this.emit('notice', { text: String(text) }); }

  // ---------- permission prompts and pop-ups ----------
  askPermission(wc, origin, permission, details, callback, canRemember) {
    // when the Mayfair page does not listen for prompts nobody could answer: refuse at once
    if (!this.subs.has('permission-request')) return callback(false);
    const tabEntry = [...this.tabs.entries()].find(([, t]) => t.wc.id === (wc && wc.id));
    const id = 'p' + (++this.seq);
    const label = permission === 'media' ? this.mediaLabel(details) : (PERM_LABEL[permission] || 'use your ' + permission);
    const req = { id, tabId: tabEntry ? tabEntry[0] : null, gid: tabEntry ? tabEntry[1].gid : null, origin: origin || 'This page', kind: permission === 'media' ? 'media' : permission, label, canRemember: !!canRemember };
    const timer = setTimeout(() => this.dropPerm(id, true), 120000); if (timer.unref) timer.unref();
    this.perms.set(id, { req, callback, origin, permission, canRemember, tabId: req.tabId, timer });
    this.emit('permission-request', req);
    wc && wc.once('destroyed', () => { if (this.perms.has(id)) this.dropPerm(id, true); });
  }
  dropPerm(id, deny) {
    const p = this.perms.get(id); if (!p) return;
    this.perms.delete(id); clearTimeout(p.timer);
    if (deny) { try { p.callback(false); } catch { /* gone */ } }
    this.emit('permission-cancel', { id });
  }
  answerPermission(id, allow, remember) {
    const p = this.perms.get(id); if (!p) return false;
    this.perms.delete(id); clearTimeout(p.timer);
    if (remember && p.canRemember && p.origin) this.sitePerms.set(p.origin, p.permission, allow ? 'allow' : 'deny');
    p.callback(!!allow);
    return true;
  }
  mediaLabel(d) { const t = (d && d.mediaTypes) || []; return t.includes('video') && t.includes('audio') ? 'camera and microphone' : t.includes('video') ? 'camera' : 'microphone'; }
  addPopup({ tabId, origin, url, priv }) {
    const id = 'w' + (++this.seq);
    const gid = (this.tabs.get(tabId) || {}).gid ?? null;
    this.popups.set(id, { tabId, gid, url, priv });
    if (this.popups.size > 20) this.popups.delete(this.popups.keys().next().value);
    this.emit('new-window-request', { id, tabId, gid, origin, url });
  }

  // ---------- downloads ----------
  dlView(d) { return { id: d.id, name: d.name, received: d.received, total: d.total, state: d.state, dir: path.dirname(d.path || ''), cloud: !!d.cloud, url: d.url || '', ...(d.done ? { done: true } : {}) }; }
  onDownload(item, wc, kind) {
    const s = this.settings.get();
    const home = path.join(app.getPath('documents'), 'Mayfair Drive', 'Downloads');
    const pick = chooseDir(s, { driveDir: home, downloadsDir: app.getPath('downloads') });
    const name = safeFilename(item.getFilename());
    const rec = { id: 'd' + (++this.seq), name, received: 0, total: item.getTotalBytes(), state: 'progressing', path: '', item, cloud: s.downloadMode === 'drive', priv: kind === 'private' || kind === 'tor', url: this.cleanDlUrl(item.getURL()) };
    if (!pick.ask) {
      try { fs.mkdirSync(pick.dir, { recursive: true }); } catch { /* fall back to default dialog */ }
      rec.path = uniquePath(pick.dir, name);
      item.setSavePath(rec.path);
    }
    this.downloads.unshift(rec);
    this.downloads.length = Math.min(this.downloads.length, 50);
    let last = 0;
    item.on('updated', () => {
      rec.received = item.getReceivedBytes(); rec.total = item.getTotalBytes(); rec.state = item.isPaused() ? 'paused' : 'progressing'; if (!rec.path) rec.path = item.getSavePath();
      const now = Date.now(); if (now - last > 200) { last = now; this.emit('download', this.dlView(rec)); }
    });
    item.once('done', (_e, st) => {
      rec.state = st === 'interrupted' ? 'interrupted' : st; rec.path = item.getSavePath() || rec.path; rec.received = item.getReceivedBytes(); rec.item = null; rec.done = true;
      if (st === 'completed') {
        this.notice('Downloaded ' + rec.name);
        if (rec.cloud && !rec.priv) { const tok = this.registerFile(rec.path); if (tok) this.sendHome('download:done', { token: tok.token, name: tok.name, size: tok.size }); }
      }
      this.emit('download', this.dlView(rec));
    });
    this.emit('download', this.dlView(rec));
  }
  cleanDlUrl(u) { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin + x.pathname : ''; } catch { return ''; } }

  // ---------- save-password offers ----------
  // A page tab reports a submitted login (preload/page.js). Main keeps it in memory for this tab and asks Mayfair Passwords
  // ('password-offer') once the login looks accepted: the next page has no password field, or the page itself cleared it.
  // Never for private or Tor tabs, sites on the 'never' list, or when the setting is off.
  onPwSubmit(e, d) {
    const r = this.roles.get(e.sender.id); const t = r && r.tabId ? this.tabs.get(r.tabId) : null; const m = r && r.tabId ? this.metaOf(r.tabId) : null;
    if (!t || !m || m.private || m.tor) return false;
    const origin = O.siteKey(e.senderFrame.url);
    const st = this.settings.get();
    if (!origin || !/^https?:/.test(origin) || !st.passwordOffer || st.passwordNever.includes(origin) || !this.subs.has('password-offer')) return false;
    const c = { origin, url: origin + new URL(e.senderFrame.url).pathname, username: d.username, password: d.password, kind: d.kind, nav: 0, offered: false };
    if (d.settled) { t.pwCand = c; this.offerPassword(r.tabId, t); return true; }
    t.pwCand = c; clearTimeout(t.pwCandTimer); t.pwCandTimer = setTimeout(() => { t.pwCand = null; }, 120000); if (t.pwCandTimer.unref) t.pwCandTimer.unref();
    return true;
  }
  afterNavigation(id, t) {
    const c = t.pwCand; if (!c || c.offered) return;
    c.nav++;
    if (c.nav > 1) { t.pwCand = null; return; }
    setTimeout(() => { if (t.pwCand !== c || !this.tabs.has(id)) return; if (t.pw) t.pwCand = null; else this.offerPassword(id, t); }, 900);     // the same login form again means the login failed
  }
  offerPassword(tabId, t) {
    const c = t.pwCand; t.pwCand = null; clearTimeout(t.pwCandTimer);
    if (!c || c.offered || !this.subs.has('password-offer')) return;
    for (const [oid, o] of [...this.pwOffers]) if (o.tabId === tabId) this.dropOffer(oid);       // one open offer per tab
    const id = 'o' + (++this.seq);
    const timer = setTimeout(() => this.dropOffer(id), 120000); if (timer.unref) timer.unref();
    this.pwOffers.set(id, { ...c, tabId, gid: t.gid, timer });
    this.emit('password-offer', { id, tabId, gid: t.gid, origin: c.origin, username: c.username, kind: c.kind, update: c.kind === 'change' });
  }
  dropOffer(id) { const o = this.pwOffers.get(id); if (!o) return false; clearTimeout(o.timer); o.password = ''; this.pwOffers.delete(id); this.emit('password-offer-cancel', { id }); return true; }
  takeOffer(id) { const o = this.pwOffers.get(id); if (!o) return null; clearTimeout(o.timer); this.pwOffers.delete(id); return { origin: o.origin, url: o.url, username: o.username, password: o.password }; }
  dismissOffer(id, never) {
    const o = this.pwOffers.get(id); if (!o) return false;
    clearTimeout(o.timer); o.password = ''; this.pwOffers.delete(id);
    if (never) { const l = this.settings.get().passwordNever; if (!l.includes(o.origin)) { this.settings.set({ passwordNever: [...l, o.origin] }); this.onSettingsChanged(['passwordNever']); } }
    return true;
  }
  onPwFocus(e) {
    const r = this.roles.get(e.sender.id); const m = r && r.tabId ? this.metaOf(r.tabId) : null; const t = r && r.tabId ? this.tabs.get(r.tabId) : null;
    if (!m || !t || m.private || m.tor || !this.subs.has('password-field')) return false;
    const origin = O.siteKey(e.senderFrame.url);
    if (!origin || !origin.startsWith('https:') || this.settings.get().passwordNever.includes(origin)) return false;
    this.emit('password-field', { tabId: r.tabId, gid: t.gid, origin, host: new URL(origin).hostname });
    return true;
  }

  // ---------- form details for the Mayfair ID (autofill) ----------
  afTab(e) { const r = this.roles.get(e.sender.id); const id = r && r.tabId; const t = id ? this.tabs.get(id) : null; const m = id ? this.metaOf(id) : null; return t && m && !m.private && !m.tor ? { id, t, m } : null; }
  onAfSubmit(e, fields) {
    const x = this.afTab(e); const st = this.settings.get();
    const origin = O.siteKey(e.senderFrame.url);
    if (x && fields && typeof fields === 'object') this.details.note({ url: e.senderFrame.url, app: x.m.appId || undefined, gid: x.t.gid, tabId: x.id, private: x.m.private, tor: x.m.tor, fields: { email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email || '') ? fields.email : '', username: fields.username } });
    if (!x || !origin || !/^https?:/.test(origin) || !st.autofillSave || st.autofillNever.includes(origin) || !this.subs.has('autofill-offer')) return false;
    if (fields.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) delete fields.email;
    if (!Object.keys(fields).length) return false;
    const sig = JSON.stringify(fields);
    if (x.t.afSig === sig) return false;                  // the same details again on this tab: no second offer
    x.t.afSig = sig;
    for (const [oid, o] of [...this.afOffers]) if (o.tabId === x.id) this.dropAf(oid);
    const id = 'a' + (++this.seq);
    const timer = setTimeout(() => this.dropAf(id), 120000); if (timer.unref) timer.unref();
    this.afOffers.set(id, { tabId: x.id, origin, fields: { ...fields }, timer });
    this.emit('autofill-offer', { id, tabId: x.id, gid: x.t.gid, origin, fields: { ...fields } });
    return true;
  }
  dropAf(id) { const o = this.afOffers.get(id); if (!o) return false; clearTimeout(o.timer); this.afOffers.delete(id); this.emit('autofill-offer-cancel', { id }); return true; }
  takeAf(id) { const o = this.afOffers.get(id); if (!o) return null; clearTimeout(o.timer); this.afOffers.delete(id); return { origin: o.origin, fields: o.fields }; }
  dismissAf(id, never) {
    const o = this.afOffers.get(id); if (!o) return false;
    clearTimeout(o.timer); this.afOffers.delete(id);
    if (never) { const l = this.settings.get().autofillNever; if (!l.includes(o.origin)) { this.settings.set({ autofillNever: [...l, o.origin] }); this.onSettingsChanged(['autofillNever']); } }
    return true;
  }
  onAfFocus(e, kind) {
    const x = this.afTab(e); if (!x || !this.subs.has('autofill-request')) return false;
    const origin = O.siteKey(e.senderFrame.url);
    if (!origin || !origin.startsWith('https:') || this.settings.get().autofillNever.includes(origin)) return false;
    for (const [rid, r] of [...this.afRequests]) if (r.tabId === x.id) { clearTimeout(r.timer); this.afRequests.delete(rid); }
    const id = 'r' + (++this.seq);
    const timer = setTimeout(() => this.afRequests.delete(id), 30000); if (timer.unref) timer.unref();
    this.afRequests.set(id, { tabId: x.id, kind, origin, timer });
    this.emit('autofill-request', { id, tabId: x.id, gid: x.t.gid, origin, kind });
    return true;
  }
  answerAf(id, value) {
    const r = this.afRequests.get(id); if (!r) return false;
    clearTimeout(r.timer); this.afRequests.delete(id);
    const t = this.tabs.get(r.tabId);
    if (value === null || !t || t.wc.isDestroyed()) return false;
    if (r.kind === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
    if (O.siteKey(t.wc.getURL()) !== r.origin) return false;       // the tab moved to another site meanwhile
    t.wc.focus(); t.wc.insertText(value); return true;
  }
  fillAf(tabId, profile) {
    const t = this.tabs.get(tabId); const m = this.metaOf(tabId);
    if (!t || !m || m.private || m.tor) return false;
    t.wc.send('af:fill', profile); return true;
  }

  // ---------- files and the Mayfair page ----------
  registerFile(p) {
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return null;
      const token = 'f' + (++this.seq) + Math.random().toString(36).slice(2, 10);
      this.fileTokens.set(token, p);
      if (this.fileTokens.size > 200) this.fileTokens.delete(this.fileTokens.keys().next().value);
      return { token, name: path.basename(p), size: st.size, ext: path.extname(p).slice(1).toLowerCase() };
    } catch { return null; }
  }
  handFile(p) {
    const f = this.registerFile(p);
    if (!f) return false;
    this.goHome();
    this.sendHome('file:open', f);
    return true;
  }
  goHome() { this.showWindow(); if (this.home && !this.home.wc.isDestroyed()) this.home.wc.focus(); }
  sendHome(channel, payload) {
    const h = this.home;
    const ready = h && !h.wc.isLoading() && O.isMayfairUrl(h.wc.getURL());
    if (ready) h.wc.send(channel, payload); else this.pendingHome.push([channel, payload]);
  }
  flushHome() {
    const h = this.home;
    if (!h || !O.isMayfairUrl(h.wc.getURL())) return;
    for (const [c, p] of this.pendingHome.splice(0)) h.wc.send(c, p);
  }
  openDeepLink(link) {
    const d = O.parseDeepLink(link);
    if (!d) return false;
    this.goHome();
    if (d.action === 'browse') {      // mayfair://browse?url=https%3A%2F%2Fexample.com : a web address for the Browser
      const u = d.params.url; if (!u) return false;
      return this.openInBrowser(u, { private: d.params.private === '1' });
    }
    const h = this.home;
    const cur = h.wc.getURL();
    if (!O.isMayfairUrl(cur)) h.wc.loadURL(d.url).catch(() => {});
    else { try { const u = new URL(cur); u.hash = new URL(d.url).hash; h.wc.loadURL(u.toString()).catch(() => {}); } catch { /* ignore */ } }
    this.sendHome('deeplink', { action: d.action, path: d.path, params: d.params });
    return true;
  }

  // ---------- web apps ----------
  appsView() {
    const inst = new Map(this.appsStore.list().map((a) => [a.id, a]));
    return this.catalogue.map((a) => {
      const i = inst.get(a.id);
      const open = this.allMeta().some((t) => t.appId === a.id) || this.appWindows.has(a.id);
      return { ...a, installed: !!i, pinned: !!(i && i.pinned), window: !!(i && i.window), badge: this.appBadges.get(a.id) || 0, open };
    });
  }
  openApp(id, { window: asWindow } = {}) {
    const a = this.appById(id);
    if (!a) return false;
    this.appsStore.add(id);
    if (asWindow !== undefined) this.appsStore.setWindow(id, !!asWindow);
    const wantWindow = asWindow !== undefined ? asWindow : this.appsStore.list().find((x) => x.id === id).window;
    this.showWindow();
    if (wantWindow && this.subs.has('windows')) {
      const r = this.openAppGroup(id);
      if (r.existing) this.emit('menu', { action: 'showApp', gid: r.gid, appId: id });
      this.onAppsChanged(); return true;
    }
    if (wantWindow) { this.openAppWindow(a); this.onAppsChanged(); return true; }
    const ag = this.appGroup(id);
    if (ag) { this.focusedGid = ag.gid; this.emit('menu', { action: 'showApp', gid: ag.gid, appId: id }); this.onAppsChanged(); return true; }
    const have = this.allMeta().find((t) => t.appId === id);
    let gid;
    if (have) { this.activate(have.id); gid = this.tabs.get(have.id).gid; this.focusedGid = gid; } else { const nt = this.newTab({ url: a.url, appId: id, afterActive: false }); gid = nt != null ? this.tabs.get(nt).gid : this.group().gid; }
    this.emit('menu', { action: 'showBrowser', gid });
    this.onAppsChanged();
    return true;
  }
  setBadge(wa, n, inView) {
    const prev = this.appBadges.get(wa.id) || 0;
    if (wa.badge === 'none' || prev === n) return;
    this.appBadges.set(wa.id, n);
    if (W.shouldNotify(prev, n, inView) && this.settings.get().notifications && Notification.isSupported()) {
      const note = new Notification({ title: wa.name, body: n === 1 ? '1 unread' : n + ' unread', silent: false });
      note.on('click', () => this.openApp(wa.id));
      note.show();
    }
    const total = [...this.appBadges.values()].reduce((x, y) => x + y, 0);
    try { app.setBadgeCount(total); } catch { /* unsupported */ }
    if (this.onBadge) this.onBadge(total);
    this.pushState();
  }
  openAppWindow(a) {
    const have = this.appWindows.get(a.id);
    if (have && !have.isDestroyed()) { have.show(); have.focus(); return; }
    // an app lives in a tab or a window, never both: close the tab, the login is shared
    const tab = this.allMeta().find((t) => t.appId === a.id);
    if (tab) this.closeTab(tab.id);
    this.sessionForApp(a); this.sweepApp(a).catch(() => {});
    const w = new BrowserWindow({
      width: 1200, height: 800, minWidth: 480, minHeight: 360, title: a.name, backgroundColor: '#0a0a0a', autoHideMenuBar: true,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      webPreferences: { partition: W.partitionFor(a.id), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: process.platform === 'darwin' },
    });
    const wc = w.webContents;
    this.appWindows.set(a.id, w);
    const guard = (e, u) => { const url = e.url || u; if (W.staysInApp(a, url)) return; e.preventDefault(); const c = O.classifyNavigation(url, { locked: false }); if (c === 'allow') this.openInBrowser(url); else if (c === 'external') shell.openExternal(url).catch(() => {}); };
    wc.on('will-navigate', guard); wc.on('will-redirect', guard);
    wc.setWindowOpenHandler((d) => { if (W.staysInApp(a, d.url)) setImmediate(() => wc.loadURL(d.url).catch(() => {})); else if (O.classifyNavigation(d.url, { locked: false }) === 'allow') setImmediate(() => this.openInBrowser(d.url)); return { action: 'deny' }; });
    // the page title arrives after the visit was recorded, so the history entry gets it here
    wc.on('page-title-updated', (_e, t) => this.setBadge(a, W.badgeFromTitle(t), w.isFocused()));
    wc.on('did-navigate', (_e, url) => { if (!isInternal(url)) { const hs = this.histFor(a.id); hs.add(url, wc.getTitle(), Date.now()); this.noteVisit(hs, a.id); } });
    wc.on('did-fail-load', (_e, code, desc, url, main) => { if (main && code !== -3) wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { u: url, e: desc, c: String(code), h: '0' } }).catch(() => {}); });
    w.on('closed', () => { this.appWindows.delete(a.id); this.pushState(); });
    wc.loadURL(a.url).catch(() => {});
  }
  async wipeApp(a) { this.histClear({ app: a.id }); const s = this.sessionForApp(a); try { await s.clearStorageData(); await s.clearCache(); await s.clearAuthCache(); } catch { /* best effort */ } this.appBadges.delete(a.id); }
  async resetApp(id) {
    const a = this.appById(id); if (!a) return false;
    await this.wipeApp(a);
    const tab = this.allMeta().find((t) => t.appId === id);
    if (tab) this.tabs.get(tab.id).wc.loadURL(a.url).catch(() => {});
    const w = this.appWindows.get(id); if (w && !w.isDestroyed()) w.webContents.loadURL(a.url).catch(() => {});
    this.notice(a.name + ' signed out and reset');
    return true;
  }
  async removeApp(id) {
    const a = this.appById(id); if (!a) return false;
    const ag = this.appGroup(id); if (ag) this.closeGroup(ag.gid);
    const tab = this.allMeta().find((t) => t.appId === id); if (tab) this.closeTab(tab.id);
    const w = this.appWindows.get(id); if (w && !w.isDestroyed()) w.destroy();
    await this.wipeApp(a);
    try { this.histClear({ app: id }); this.histFor(id).flush(); fs.rmSync(path.join(this.dir, 'history-app-' + id + '.json'), { force: true }); this.appHistories.delete(id); } catch { /* none */ }
    this.appsStore.remove(id);
    this.onAppsChanged(); this.pushState();
    return true;
  }
  createShortcut(id) {
    const a = this.appById(id); if (!a) return { ok: false, reason: 'unknown app' };
    const exe = process.env.APPIMAGE || process.execPath;
    try {
      if (process.platform === 'win32') {
        const f = path.join(app.getPath('desktop'), a.name + '.lnk');
        const ok = shell.writeShortcutLink(f, 'create', { target: exe, args: '--app=' + id, description: a.name + ' in Mayfair Desktop', cwd: path.dirname(exe) });
        return { ok, path: f };
      }
      if (process.platform === 'linux') {
        const entry = W.desktopEntry(a, exe);
        const files = [];
        for (const dir of [path.join(app.getPath('home'), '.local', 'share', 'applications'), app.getPath('desktop')]) {
          fs.mkdirSync(dir, { recursive: true });
          const f = path.join(dir, 'mayfair-' + id + '.desktop'); fs.writeFileSync(f, entry, { mode: 0o755 }); files.push(f);
        }
        return { ok: true, path: files[0] };
      }
      return { ok: false, reason: 'macOS cannot create app shortcuts from a running app. Pinned apps are listed in the Dock menu: right-click the Mayfair Desktop Dock icon.' };
    } catch (e) { return { ok: false, reason: e.message }; }
  }

  // ---------- state ----------
  // One 'state' event per Browser window group. pushState(gid) marks one group, pushState() all of them.
  pushState(gid) {
    if (gid == null) for (const k of this.groups.keys()) this.dirty.add(k); else this.dirty.add(gid);
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => { this.stateTimer = null; this.sendState(); }, 30);
  }
  torStatus() {
    const s = this.tor.state;
    return { state: s.status === 'ready' ? 'connected' : s.status, progress: s.progress || 0, socksPort: s.socksPort || 0, message: s.error || '', available: !!this.tor.binary };
  }
  stateObj(g) {
    g = g || this.group();
    return {
      gid: g.gid,
      tabs: g.model.tabs.map((m) => {
        const x = this.tabs.get(m.id);
        let wcOk = false, canBack = false, canFwd = false, audible = false, muted = false, zoom = 100;
        try { if (x && !x.wc.isDestroyed()) { wcOk = true; canBack = x.wc.navigationHistory.canGoBack(); canFwd = x.wc.navigationHistory.canGoForward(); audible = x.wc.isCurrentlyAudible(); muted = x.wc.audioMuted; zoom = pctOf(x.wc.getZoomLevel()); } } catch { /* closing */ }
        const cur = wcOk ? x.wc.getURL() : '';
        return {
          id: m.id, gid: g.gid, title: m.title || (m.url ? m.url : 'New tab'), url: m.url, favicon: x ? x.favicon : '', loading: !!(x && x.loading), canBack, canFwd,
          secure: O.httpsState(m.url), pinned: !!m.pinned, private: !!m.private, tor: !!m.tor, webapp: m.appId || null, audible, muted, zoom, blocked: x ? x.blocked : 0,
          pw: !!(x && x.pw), bookmarked: this.bookmarks.has(m.url), start: isStart(cur), badge: m.appId ? (this.appBadges.get(m.appId) || 0) : 0, crashed: !!(x && x.crashed),
        };
      }),
      activeId: g.model.activeId,
      fullscreen: g.fsTab != null,
      tor: this.torStatus(), proxy: !!this.proxyActive, adblockOn: !!this.settings.get().adblock,
      groups: [...this.groups.keys()].sort((p, q) => p - q), focusedGid: this.focusedGid, webapp: g.webapp || null, apps: this.appGroups(),
    };
  }
  sendState() {
    const ids = [...this.dirty].sort((a, b) => a - b); this.dirty.clear();
    if (!this.win) return;
    for (const gid of ids) { const g = this.groups.get(gid); if (g) this.emit('state', this.stateObj(g)); }
  }

  // ---------- IPC ----------
  registerIpc() {
    ipcMain.on('ipc:allow', (e) => {
      const role = this.roleOf(e.sender);
      e.returnValue = role ? { invoke: IPC.channelsFor(role), events: IPC.EVENTS[role] || [] } : { invoke: [], events: [] };
    });
    const H = this.handlers();
    for (const ch of Object.keys(IPC.CH)) {
      ipcMain.handle(ch, async (e, ...args) => {
        let role = this.roleOf(e.sender);
        if (role === 'page' && e.senderFrame && e.senderFrame === e.sender.mainFrame && isStart(e.senderFrame.url)) role = 'start';
        const v = IPC.check(role, ch, args);
        if (!v.ok) throw new Error('blocked: ' + v.reason);
        if (!this.senderTrusted(e, role)) { if (role === 'page' || role === 'start') return undefined; throw new Error('blocked: untrusted sender'); }
        return H[ch](e, ...args);
      });
    }
  }
  senderTrusted(e, role) {
    if (role === 'web') return !!this.home && e.sender === this.home.wc && e.senderFrame === e.sender.mainFrame && O.isMayfairUrl(e.senderFrame.url);
    if (role === 'page' || role === 'start') return e.senderFrame === e.sender.mainFrame;
    return false;
  }
  tabOf(e) { const r = this.roles.get(e.sender.id); return r && r.tabId ? this.tabs.get(r.tabId) : null; }
  needTab(id) { const t = this.tabs.get(id); if (!t) throw new Error('no such tab'); return t; }

  handlers() {
    const T = (id) => this.needTab(id);
    const navigate = (id, txt) => {
      const t = this.tabs.get(id); if (!t) return false;
      const cmd = ANS.parseCommand(txt); if (cmd) return this.runCommand(cmd);
      const u = O.normalizeInput(txt, this.settings.get().searchEngine); if (!u) return false;
      this.typedInTab(id, txt);
      t.wc.loadURL(u).catch(() => {}); return true;
    };
    const siteOf = (id) => { const t = this.tabs.get(id); return t ? O.siteKey(t.wc.getURL()) : null; };
    const adStats = (id) => {
      const t = id == null ? this.activeTab() : this.tabs.get(id);
      return { enabled: !!this.settings.get().adblock, engine: this.ad ? this.ad.info.engine : 'basic', rules: this.ad && this.ad.active ? this.ad.info.rules : this.blocker.size, blocked: t ? t.blocked : 0, error: this.ad ? this.ad.info.error : '', lastUpdate: this.ad ? this.ad.info.lastUpdate : 0, scriptlets: !!(this.ad && this.ad.info.scriptlets), lists: this.ad && this.ad.info.lists.length ? this.ad.info.lists : FILTERS.lists.map((l) => ({ ...l, loaded: false })), allow: this.ad ? [...this.ad.allow] : [] };
    };
    const set = (patch) => {
      const ch = this.settings.set(patch);
      if (ch.includes('adblock')) this.applyAdblock();
      const net = ch.some((k) => ['secureDns', 'dnsProvider'].includes(k));
      const p = net ? this.applyNetwork() : Promise.resolve();
      if (ch.length) { this.onSettingsChanged(ch); this.pushState(); }
      return p.then(() => ({ changed: ch, restart: ch.includes('ech') || (ch.includes('secureDns') && this.settings.get().ech), settings: this.settingsView() }));
    };
    const B = {
      'br:ready': (e, o) => {
        const g = this.group(o && o.gid);
        const restore = this.settings.get().startup === 'restore';
        const out = {
          version: this.version, platform: process.platform, tor: this.tor.ready, torAvailable: !!this.tor.binary, devtools: this.devTools, fullscreen: g.fsTab != null,
          features: ['tabs', 'windows', 'private', 'tor', 'webapps', 'find', 'zoom', 'print', 'savePage', 'bookmarks', 'history', 'downloads', 'permissions', 'adblock', 'secureDns', 'proxy', 'extensions', 'capture', 'fullscreen', ...(this.devTools ? ['devtools'] : [])],
          state: this.stateObj(g), groups: [...this.groups.keys()].sort((a, b) => a - b), focusedGid: this.focusedGid, apps: this.appGroups(),
          states: Object.fromEntries([...this.groups.values()].map((x) => [x.gid, this.stateObj(x)])),
          pending: [...this.perms.values()].map((p) => p.req), downloads: this.downloads.map((d) => this.dlView(d)),
          restore: restore ? this.restoreList.splice(0) : [], restoreGroups: restore ? this.restoreGroupList.splice(0) : [],
        };
        return out;
      },
      'br:setBounds': (e, b) => this.setBounds(b, b.gid),
      'br:setOccluded': (e, on, o) => this.setOccluded(on, o, o && o.gid),
      'br:capture': (e, o) => this.capture(o && o.gid),
      'br:windows.create': (e, o) => (o && o.webapp ? this.openAppGroup(o.webapp) : { gid: this.createGroup().gid }),
      'br:windows.close': (e, gid) => this.closeGroup(gid),
      'br:windows.focus': (e, gid) => this.focusGroup(gid),
      'br:windows.list': () => [...this.groups.values()].sort((a, b) => a.gid - b.gid).map((g) => ({ gid: g.gid, tabs: g.model.tabs.length, activeId: g.model.activeId, focused: g.gid === this.focusedGid, webapp: g.webapp || null })),
      'br:moveTab': (e, id, to, o) => { T(id); return this.moveTab(id, to, o || {}); },
      'br:focus': (e, id) => { T(id).wc.focus(); return true; },
      'br:newTab': async (e, o = {}) => {
        const g = this.group(o.gid);
        const common = { url: o.url || '', private: !!o.private, activate: !o.background, gid: g.gid };
        const res = (id) => ({ id, gid: id != null && this.tabs.has(id) ? this.tabs.get(id).gid : g.gid });
        if (o.tor) { const id = await this.torNewTab(common); return id ? res(id) : { id: null, error: this.tor.state.error || 'Tor is not available' }; }
        if (o.webapp) { if (!this.appById(o.webapp)) return { id: null, error: 'unknown app' }; this.appsStore.add(o.webapp); return res(this.newTab({ ...common, url: this.appById(o.webapp).url, appId: o.webapp })); }
        return res(this.newTab(common));
      },
      'br:closeTab': (e, id) => this.closeTab(id),
      'br:closeOthers': (e, id) => { const g = this.groupOfTab(id); if (!g) return false; for (const m of g.model.tabs.filter((t) => t.id !== id && !t.pinned)) this.closeTab(m.id); return true; },
      'br:reopenClosed': (e, o) => { const g = this.group(o && o.gid); const id = this.reopenClosed(g.gid); return { id, gid: id != null && this.tabs.has(id) ? this.tabs.get(id).gid : g.gid }; },
      'br:activate': (e, id) => this.activate(id),
      'br:move': (e, id, i) => { const g = this.groupOfTab(id); const ok = !!g && g.model.move(id, i); this.pushState(); return ok; },
      'br:duplicate': (e, id) => { const m = this.metaOf(id); if (!m) return { id: null }; const gid = this.tabs.get(id).gid; return { id: m.url ? this.newTab({ url: m.url, private: m.private && !m.tor, appId: m.appId, afterId: id, gid }) : this.newTab({ afterId: id, private: m.private && !m.tor, gid }) }; },
      'br:pin': (e, id, on) => { const g = this.groupOfTab(id); const ok = !!g && g.model.pin(id, on); this.pushState(); return ok; },
      'br:mute': (e, id, on) => { T(id).wc.setAudioMuted(on); this.pushState(); return true; },
      'br:go': (e, id, txt) => navigate(id, txt),
      'br:back': (e, id) => { const t = T(id); if (t.wc.navigationHistory.canGoBack()) { t.wc.navigationHistory.goBack(); return true; } return false; },
      'br:forward': (e, id) => { const t = T(id); if (t.wc.navigationHistory.canGoForward()) { t.wc.navigationHistory.goForward(); return true; } return false; },
      'br:reload': (e, id, hard) => { const t = T(id); hard ? t.wc.reloadIgnoringCache() : t.wc.reload(); return true; },
      'br:stop': (e, id) => { T(id).wc.stop(); return true; },
      'br:home': () => { this.goHome(); return true; },
      'br:network.block': (e, on) => this.setNetworkBlocked(on),
      'br:suggest': (e, q, o) => { const items = o && o.app ? SG.suggest(q, [], this.histFor(o.app).list(500), 7) : SG.suggest(q, this.bookmarks.list(), this.history.list(500), 7); const u = O.normalizeInput(q, this.settings.get().searchEngine); return u ? [...items, { kind: 'search', title: q, sub: '', url: u }] : items; },
      'br:find': (e, id, text, o) => { T(id); return this.find(id, text, o || {}); },
      'br:stopFind': (e, id) => this.stopFind(id),
      'br:zoom': (e, id, d) => { T(id); return this.zoom(id, d); },
      'br:print': (e, id) => { T(id).wc.print({}); return true; },
      'br:savePage': async (e, id) => {
        const t = T(id); const m = this.metaOf(id);
        const r = await dialog.showSaveDialog(this.win, { defaultPath: safeFilename((m && m.title) || 'page') + '.html', filters: [{ name: 'Web page', extensions: ['html'] }] });
        if (r.canceled || !r.filePath) return false;
        await t.wc.savePage(r.filePath, 'HTMLComplete'); return true;
      },
      'br:devtools': (e, id) => { if (!this.devTools) throw new Error('blocked: devtools'); T(id).wc.openDevTools({ mode: 'detach' }); return true; },
      'br:fullscreen': (e, on, o) => {
        const g = o && o.gid != null ? this.group(o.gid) : ([...this.groups.values()].find((x) => x.fsTab != null) || this.group());
        if (!on && g.fsTab != null) { const t = this.tabs.get(g.fsTab); try { t && t.wc.executeJavaScript('document.exitFullscreen&&document.exitFullscreen()', true).catch(() => {}); } catch { /* gone */ } this.leaveHtmlFullscreen(g); }
        return g.fsTab != null;
      },
      'br:windowFullscreen': (e, on) => this.toggleFullscreen(on),
      'br:fillPassword': (e, id) => this.requestPasswordFill(id),
      'br:bookmarks.list': () => this.bookmarks.list(),
      'br:bookmarks.add': (e, o) => { const r = this.bookmarks.add(o.url, o.title); this.pushState(); return r ? { id: r.id } : null; },
      'br:bookmarks.remove': (e, id) => { const r = this.bookmarks.remove(id); this.pushState(); return r; },
      'br:bookmarks.update': (e, id, p) => { const r = this.bookmarks.update(id, p); this.pushState(); return r; },
      'br:bookmarks.import': (e, items) => { const added = this.bookmarks.importItems(items); this.pushState(); return { added }; },
      'br:webapps.match': (e, u) => W.matchApp(this.catalogue, u),
      'br:history.list': (e, n, o) => { if (n && typeof n === 'object') { o = n; n = o.limit; } return this.hist(o).list(n || 200).map((h) => ({ url: h.url, title: h.title, visited: h.t })); },
      'br:history.search': (e, q, n, o) => { if (n && typeof n === 'object') { o = n; n = o.limit; } return this.hist(o).search(q, n || 50).map((h) => ({ url: h.url, title: h.title, visited: h.t })); },
      'br:history.remove': (e, u, o) => this.histRemove(u, o),
      'br:history.clear': (e, since, o) => { if (since && typeof since === 'object') { o = since; since = o.since; } this.histClear(o, since); return true; },
      'br:history.import': (e, list, o) => this.histImport(list, o),
      'br:history.syncState': () => this.syncState(),
      'br:downloads.list': () => this.downloads.map((d) => this.dlView(d)),
      'br:downloads.cancel': (e, id) => { const d = this.downloads.find((x) => x.id === id); if (d && d.item) { d.item.cancel(); return true; } return false; },
      'br:downloads.show': (e, id) => { const d = this.downloads.find((x) => x.id === id); if (d && d.path && d.state === 'completed') { shell.showItemInFolder(d.path); return true; } return false; },
      'br:downloads.open': async (e, id) => { const d = this.downloads.find((x) => x.id === id); if (d && d.path && d.state === 'completed') { const r = await shell.openPath(d.path); if (r) { this.notice('Could not open the file'); return false; } return true; } return false; },
      'br:downloads.clear': () => { this.downloads = this.downloads.filter((d) => d.state === 'progressing'); return true; },
      'br:settings.get': () => this.settingsView(),
      'br:settings.set': (e, patch) => set(patch),
      'br:settings.setProxy': async (e, mode, host, port) => {
        const r = PV.proxyConfig(mode, host, port);
        if (!r.ok) return { ok: false, error: r.error };
        this.settings.set({ proxyMode: mode, proxyHost: mode === 'off' ? '' : host, proxyPort: mode === 'off' ? 0 : port });
        await this.applyNetwork();
        return { ok: true };
      },
      'br:settings.pickFolder': async () => { const r = await dialog.showOpenDialog(this.win, { properties: ['openDirectory', 'createDirectory'] }); if (r.canceled || !r.filePaths[0]) return null; this.settings.set({ downloadFolder: r.filePaths[0], downloadMode: 'folder' }); return r.filePaths[0]; },
      'br:settings.clearBrowsingData': async (e, o = {}) => {
        const want = (k) => o[k] !== false;
        if (want('history')) this.histClear(null);
        if (want('downloads')) this.downloads = this.downloads.filter((d) => d.state === 'progressing');
        const s = session.fromPartition(PARTITION.browse);
        if (want('cookies')) await s.clearStorageData();
        if (want('cache')) await s.clearCache();
        if (o.webapps === true) for (const a of this.catalogue) await this.wipeApp(a);       // only when the user ticks Web apps
        this.notice('Browsing data cleared');
        return true;
      },
      'br:autofill.take': (e, id) => this.takeAf(id),
      'br:autofill.dismiss': (e, id, o) => this.dismissAf(id, !!(o && o.never)),
      'br:autofill.fill': (e, tabId, p) => { T(tabId); return this.fillAf(tabId, p); },
      'br:autofill.answer': (e, id, v) => this.answerAf(id, v),
      'br:passwords.take': (e, id) => this.takeOffer(id),
      'br:passwords.dismiss': (e, id, o) => this.dismissOffer(id, !!(o && o.never)),
      'br:permissions.list': () => ({ sites: this.sitePerms.all() }),
      'br:permissions.site': (e, id) => {
        const t = T(id); const k = O.siteKey(t.wc.getURL()); const m = this.metaOf(id);
        return { origin: k, secure: O.httpsState(m ? m.url : ''), perms: k ? this.sitePerms.forSite(k) : {}, blocked: t.blocked, adblock: !!this.settings.get().adblock, siteAllowed: k ? ((this.ad && this.ad.active) ? this.ad.isSiteOff(new URL(k).hostname) : this.blocker.allowSites.has(new URL(k).hostname)) : false, engine: this.ad ? this.ad.info.engine : 'basic', internal: !k };
      },
      'br:permissions.set': (e, origin, perm, val) => this.sitePerms.set(origin, perm, val === 'ask' ? null : val),
      'br:permissions.reset': (e, origin) => { this.sitePerms.resetSite(origin); return true; },
      'br:permissions.answer': (e, id, allow, remember) => this.answerPermission(id, allow, remember),
      'br:popups.allow': (e, id) => { const p = this.popups.get(id); if (!p) return false; this.popups.delete(id); this.newTab({ url: p.url, afterActive: true, private: p.priv, gid: p.gid != null && this.groups.has(p.gid) ? p.gid : null }); return true; },
      'br:webapps.catalogue': () => {
        const view = this.appsView(); const ic = this.icons.collect(view).icons;   // icons already known; the rest are fetched in the background and show on the next call
        return view.map((a) => ({ id: a.id, name: a.name, url: a.url, category: a.category, description: a.description, keywords: a.keywords, icon: ic[a.id] || '', adblock: !!a.adblock, badge: this.appById(a.id).badge, installed: a.installed, pinned: a.pinned, window: a.window, badgeCount: a.badge, open: a.open, match: [...new Set([W.registrable(new URL(a.url).hostname)])] }));
      },
      'br:webapps.open': (e, id, o) => this.openApp(id, o && o.window ? { window: true } : {}),
      'br:webapps.pin': (e, id, on) => { if (!this.appById(id)) return false; this.appsStore.add(id); const ok = this.appsStore.setPinned(id, on); this.onAppsChanged(); return ok; },
      'br:webapps.reset': (e, id) => this.resetApp(id),
      'br:webapps.remove': (e, id) => this.removeApp(id),
      'br:webapps.shortcut': (e, id) => this.createShortcut(id),
      'br:tor.status': () => this.torStatus(),
      'br:tor.start': async () => { try { await this.tor.start(); } catch { /* status carries the error */ } return this.torStatus(); },
      'br:tor.stop': () => { for (const m of this.allMeta().filter((x) => x.tor)) this.closeTab(m.id); this.tor.stop(); return true; },
      'br:tor.newIdentity': async () => { try { await this.tor.newIdentity(); await this.wipeTor(); this.torSession(); for (const m of this.allMeta().filter((x) => x.tor)) { const x = this.tabs.get(m.id); if (x) x.wc.reload(); } this.notice('New Tor identity'); return true; } catch (err) { this.notice(err.message); return false; } },
      'br:adblock.stats': (e, id) => adStats(id),
      'br:adblock.toggleSite': (e, id) => {
        const t = T(id); const k = O.siteKey(t.wc.getURL()); if (!k) return false; const h = new URL(k).hostname;
        if (this.ad && this.ad.active) {
          this.ad.setSiteOff(h, !this.ad.isSiteOff(h));
          this.adAllow.data.allow = [...this.ad.allow]; this.adAllow.save();
        } else this.blocker.setSiteAllowed(h, !this.blocker.allowSites.has(h));
        t.wc.reload(); return true;
      },
      'br:adblock.updateNow': async () => { const r = await this.ad.update({ force: true }); this.applyAdblock(); return { done: (r.done || []).length, failed: (r.failed || []).map((f) => f.id + ': ' + f.error) }; },
      'br:extensions.list': () => this.ext.list().map((x) => ({ ...x, native: this.ext.native(x.id) || undefined })),
      'br:extensions.install': async (e, id, url, sha) => { try { return await this.installExtension(id, url, sha); } catch (err) { return { ok: false, error: err.message }; } },
      'br:extensions.remove': (e, id) => this.removeExtension(id),
      'br:about': () => ({ version: this.version, platform: process.platform, components: ABOUT.components(this.version), licenseNote: ABOUT.LICENSE_NOTE, adblock: adStats(null), extensions: this.ext.list() }),
      'br:subscribe': (e, ev, on) => { if (!IPC.BR_EVENTS.includes(ev)) return false; if (on) { this.subs.add(ev); if (ev.startsWith('history-')) this.flushHistOutbox(); } else this.subs.delete(ev); return true; },
    };
    return {
      ...B,
      'web:info': () => ({ version: this.version, platform: process.platform, fullscreen: !!(this.win && this.win.isFullScreen()) }),
      'web:notify': (e, n) => {
        if (!this.settings.get().notifications || !Notification.isSupported()) return false;
        const note = new Notification({ title: n.title || 'Mayfair', body: n.body || '', silent: false });
        note.on('click', () => { this.goHome(); if (n.url && O.isMayfairUrl(n.url)) this.home.wc.loadURL(n.url).catch(() => {}); });
        note.show();
        return true;
      },
      'web:badge': (e, n) => { try { app.setBadgeCount(n); } catch { /* unsupported */ } this.onBadge && this.onBadge(n); },
      'web:openBrowser': (e, url) => this.openInBrowser(url),
      'web:readFile': async (e, token) => {
        const p = this.fileTokens.get(token); if (!p) throw new Error('unknown file token');
        const st = await fs.promises.stat(p);
        if (st.size > 200 * 1024 * 1024) throw new Error('file too large (200 MB limit)');
        const data = await fs.promises.readFile(p);
        return { name: path.basename(p), size: st.size, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
      },
      'web:appsList': () => this.appsView().filter((a) => a.pinned).map((a) => ({ id: a.id, name: a.name, url: a.url, badge: a.badge })),
      'web:appsOpen': (e, id) => { const a = this.appsView().find((x) => x.id === id && x.pinned); if (!a) return false; this.openApp(id); return true; },
      'web:extInstall': async (e, id, url, sha) => { try { return await this.installExtension(id, url, sha); } catch (err) { return { ok: false, error: err.message }; } },
      'web:extRemove': (e, id) => this.removeExtension(id),
      'web:extList': () => this.ext.list().map((x) => ({ ...x, native: this.ext.native(x.id) || undefined })),
      'web:searchListening': (e, on) => { this.searchListening = on; },
      'web:searchRespond': (e, id, results) => { const w = this.searchWaiters.get(id); if (w) { this.searchWaiters.delete(id); w(SG.cleanWebResults(results)); } return !!w; },
      'search:config': () => { const st = this.settings.get(); return { engine: st.searchEngine, engineName: O.ENGINE_NAMES[st.searchEngine], engines: O.ENGINE_NAMES, online: st.onlineAnswers, rates: this.rates, home: true }; },
      'search:setEngine': (e, id) => { if (!O.SEARCH_ENGINES[id]) return false; this.settings.set({ searchEngine: id }); return O.ENGINE_NAMES[id]; },
      'search:suggest': (e, q) => SG.suggest(q, this.bookmarks.list(), this.history.list(500)),
      'search:local': async (e, q) => {
        const mine = SG.suggest(q, this.bookmarks.list(), this.history.list(500), 4);
        const web = await this.queryHomeSearch(q);
        return { items: [...web.map((r) => ({ ...r })), ...mine], webApp: this.searchListening };
      },
      'search:open': (e, o) => {
        if (o.kind === 'link') { if (!SG.cleanWebResults([{ kind: 'file', title: 'x', link: o.value }]).length) return false; return this.openDeepLink('mayfair://open' + o.value); }
        const t = this.tabOf(e); if (!t || O.classifyNavigation(o.value, { locked: false }) !== 'allow') return false;
        t.wc.loadURL(o.value).catch(() => {}); return true;
      },
      'search:go': (e, text) => {
        const cmd = ANS.parseCommand(text); if (cmd) return this.runCommand(cmd);
        const t = this.tabOf(e); const u = O.normalizeInput(text, this.settings.get().searchEngine); if (!t || !u) return false;
        this.typedInTab((this.roles.get(e.sender.id) || {}).tabId, text);
        t.wc.loadURL(u).catch(() => {}); return true;
      },
      'search:command': (e, text) => { const cmd = ANS.parseCommand(text); return cmd ? this.runCommand(cmd) : false; },
      'search:online': async (e, i) => { if (!this.settings.get().onlineAnswers) return null; return ONLINE.run(i, (u) => this.fetchJson(u)); },
      'search:panel': (e, n) => { const t = this.tabOf(e); this.emit('panel-request', { panel: n, gid: t ? t.gid : null }); },
      'search:home': (e) => { const t = this.tabOf(e); this.emit('panel-request', { panel: 'home', gid: t ? t.gid : null }); },
      'web:pwListening': (e, on) => { this.homeListening = on; },
      'web:pwRespond': (e, id, creds) => {
        const w = this.pwWaiters.get(id); if (!w) return false;
        this.pwWaiters.delete(id);
        const t = [...this.tabs.values()].find((x) => x.wc.id === w.wcId);
        if (!t || O.siteKey(t.wc.getURL()) !== w.origin) return false;
        if (!creds.length) { this.notice('No saved login for this site'); return false; }
        t.wc.send('pw:fill', creds[0]);
        return true;
      },
      'page:pwSubmit': (e, d) => this.onPwSubmit(e, d),
      'page:pwFocus': (e) => this.onPwFocus(e),
      'page:afSubmit': (e, f) => this.onAfSubmit(e, f),
      'page:afFocus': (e, k) => this.onAfFocus(e, k),
      'page:pwDetected': (e, has) => { const t = this.tabOf(e); if (t) { t.pw = has; this.pushState(); } },
    };
  }

  settingsView() {
    return { ...this.settings.get(), version: this.version, platform: process.platform, dataDir: this.dir, blocklistSize: this.ad && this.ad.active ? this.ad.info.rules : this.blocker.size, adEngine: this.ad ? this.ad.info.engine : 'basic', torAvailable: !!this.tor.binary, dnsProviders: Object.fromEntries(Object.entries(PV.DNS_PROVIDERS).map(([k, v]) => [k, v.name])), notes: PV.NOTES, searchEngines: O.ENGINE_NAMES };
  }

  // Mayfair Search helpers
  runCommand(cmd) {
    const q = new URLSearchParams(cmd.params).toString();
    return this.openDeepLink('mayfair://' + cmd.action + cmd.path + (q ? '?' + q : ''));
  }
  queryHomeSearch(q) {
    const h = this.home;
    if (!this.searchListening || !h || h.wc.isLoading() || !O.isMayfairUrl(h.wc.getURL())) return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = 's' + (++this.seq);
      const timer = setTimeout(() => { this.searchWaiters.delete(id); resolve([]); }, 700);
      this.searchWaiters.set(id, (r) => { clearTimeout(timer); resolve(r); });
      h.wc.send('search:query', { id, q });
    });
  }
  async fetchJson(u) {
    if (!ONLINE.allowed(u)) throw new Error('host not allowed');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 6000);
    try {
      const r = await net.fetch(u, { headers: { accept: 'application/json', 'user-agent': 'MayfairDesktop/' + this.version + ' (answers; no tracking)' }, credentials: 'omit', signal: ctl.signal, redirect: 'error' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  requestPasswordFill(id) {
    const t = id == null ? this.activeTab() : this.tabs.get(id);
    const origin = t && O.siteKey(t.wc.getURL());
    if (!origin || !origin.startsWith('https:')) { this.notice('Passwords only fill on secure pages'); return false; }
    if (!this.homeListening) { this.notice('Open Mayfair Passwords first'); return false; }
    const rid = 'q' + (++this.seq);
    this.pwWaiters.set(rid, { wcId: t.wc.id, origin });
    setTimeout(() => this.pwWaiters.delete(rid), 30000).unref?.();
    this.sendHome('pw:request', { id: rid, origin, host: new URL(origin).hostname });
    return true;
  }

  // ---------- menu actions for main.js (menu, tray, page key shortcuts) ----------
  flushAll() { this.flushAppSessions(); this.adAllow.flush(); this.tabsStore.flush(); this.tor.stop(); for (const s of [this.appsStore, this.settings, this.winState, this.bookmarks, this.history, this.searchLog, ...this.appHistories.values(), this.sitePerms, this.zoomStore]) { try { (s.flush ? s : s.s).flush(); } catch { /* ignore */ } } }
  // The Browser's interface is in Mayfair Cloud, so an action is reported to it ('menu' event) and it decides what to do.
  menuAction(a, gid) {
    if (a === 'fullscreen') return this.toggleFullscreen();
    if (a === 'quit') return app.quit();
    if (a === 'home') return this.goHome();
    this.showWindow();
    const g = gid != null && this.groups.has(gid) ? gid : (this.groups.has(this.focusedGid) ? this.focusedGid : null);
    this.emit('menu', { action: a, gid: g });
  }
}
module.exports = { BrowserService, UI_DIR };
