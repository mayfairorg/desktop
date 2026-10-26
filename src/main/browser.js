'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const {
  app, BaseWindow, BrowserWindow, WebContentsView, net, session, ipcMain, Menu, Notification, dialog, shell, screen, clipboard,
} = require('electron');

const O = require('./lib/origins');
const { BookmarkStore, HistoryStore, SitePermissionStore, JsonStore } = require('./lib/stores');
const { TabModel } = require('./lib/tabmodel');
const { Settings } = require('./lib/settings');
const { WindowState, sanitizeBounds, MIN } = require('./lib/windowstate');
const { Blocker, parseList } = require('./lib/adblock');
const { safeFilename, uniquePath, chooseDir } = require('./lib/downloads-path');
const { popupAllowed, decidePermission, chromeHeight } = require('./lib/policy');
const IPC = require('./lib/ipc-allowlist');
const W = require('./lib/webapps');
const PV = require('./lib/privacy');
const SG = require('./lib/suggest');
const { AdEngine } = require('./lib/adblock-engine');
const { ExtensionManager } = require('./lib/extensions');
const FILTERS = require('./lib/filter-lists.json');
const ANS = require('../ui/answers.js');
const ONLINE = require('./lib/online-answers');
const { TorManager, binaryPath } = require('./lib/tor');
const PROT = require('./lib/protect');

const UI_DIR = path.join(__dirname, '..', 'ui');
const PRELOAD = (n) => path.join(__dirname, '..', 'preload', n + '.js');
const UI_URL = pathToFileURL(UI_DIR).href;
const START_URL = pathToFileURL(path.join(UI_DIR, 'newtab.html')).href;
const isInternal = (u) => typeof u === 'string' && u.startsWith(UI_URL);

const CATALOGUE_FILE = path.join(__dirname, 'lib', 'webapps.json');
const PARTITION = { home: 'persist:mayfair', browse: 'persist:browse', private: 'mf-private', tor: 'mf-tor' };
const ZOOM_STEP = 0.5;

class Browser {
  constructor({ dataDir, version, tampered = null }) {
    this.version = version;
    this.tampered = tampered;      // set by main.js when the installed files do not match the build (lib/protect.js): the Mayfair tab then refuses to open Mayfair Cloud
    this.devTools = PROT.devToolsAllowed({ isPackaged: app.isPackaged });
    this.dir = dataDir;
    const f = (n) => path.join(dataDir, n);
    this.settings = new Settings(f('settings.json'));
    this.winState = new WindowState(f('window.json'));
    this.bookmarks = new BookmarkStore(f('bookmarks.json'));
    this.history = new HistoryStore(f('history.json'));
    this.sitePerms = new SitePermissionStore(f('permissions.json'));
    this.zoomStore = new JsonStore(f('zoom.json'), () => ({ levels: {} }));
    this.appsStore = new W.AppsStore(f('apps.json'));
    this.catalogue = this.loadCatalogue(f('webapps-custom.json'));
    this.appBadges = new Map(); // app id -> unread count
    this.appWindows = new Map(); // app id -> BrowserWindow
    this.hardened = new Set();
    this.tor = new TorManager({ binary: binaryPath({ resourcesPath: process.resourcesPath, root: path.join(__dirname, '..', '..') }) });
    this.tor.on('state', () => { this.pushState(); });
    this.tor.on('exit', () => { this.notice('Tor stopped'); });
    this.model = new TabModel();
    this.tabs = new Map(); // id -> { view, wc, loading, favicon, pw, blocked, lastInput, canBack, canFwd, find }
    this.roles = new Map(); // webContents id -> { role, tabId }
    this.adAllow = new JsonStore(f('adblock-allow.json'), () => ({ allow: [] }));
    if (!Array.isArray(this.adAllow.data.allow)) this.adAllow.data.allow = [];
    this.ad = null;
    this.ext = new ExtensionManager({ dir: f('extensions'), storeFile: f('extensions.json') });
    this.extIds = new Map(); // our id -> Electron extension id
    this.blocker = new Blocker(parseList(fs.readFileSync(path.join(__dirname, 'lib', 'blocklist.txt'), 'utf8')));
    this.downloads = [];
    this.prompts = [];
    this.permWaiters = new Map();
    this.pwWaiters = new Map();
    this.fileTokens = new Map();
    this.panel = null;
    this.findOpen = false;
    this.htmlFullscreen = false;
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
  appById(id) { return this.catalogue.find((a) => a.id === id) || null; }

  // ---------- startup ----------
  start({ hidden = false } = {}) {
    this.setupSessions();
    this.initAdblock();
    this.loadExtensions();
    this.registerIpc();
    this.createWindow({ hidden });
    this.newTab({ pinned: true, url: O.HOME_URL });
    this.layout();
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
  async fetchBuffer(u, max) {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await net.fetch(u, { headers: { 'user-agent': 'MayfairDesktop/' + this.version }, credentials: 'omit', signal: ctl.signal, redirect: 'error' });
      if (!r.ok) throw new Error('Download failed (HTTP ' + r.status + ')');
      const len = Number(r.headers.get('content-length') || 0); if (len > max) throw new Error('Download too large');
      const b = Buffer.from(await r.arrayBuffer()); if (b.length > max) throw new Error('Download too large'); return b;
    } finally { clearTimeout(timer); }
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
    const ua = (s, extra, lang) => { s.setUserAgent(s.getUserAgent().replace(/ Electron\/[\d.]+/, '').replace(/ mayfair-desktop\/[\d.]+/i, '') + (extra || ''), lang); };
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
    if (!this.hardened.has(part)) {
      this.hardened.add(part);
      s.setUserAgent(s.getUserAgent().replace(/ Electron\/[\d.]+/, '').replace(/ mayfair-desktop\/[\d.]+/i, ''));
      this.hardenSession(s, 'app');
      this.applyNetwork();
      if (app.adblock && this.ad) this.applyAdblock();
    }
    return s;
  }

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

  // ---------- window and views ----------
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

    const uiPrefs = (role) => ({
      preload: PRELOAD('ui'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      webSecurity: true, additionalArguments: ['--mf-role=' + role], spellcheck: false,
    });
    this.chrome = new WebContentsView({ webPreferences: uiPrefs('chrome') });
    this.overlay = new WebContentsView({ webPreferences: uiPrefs('overlay') });
    this.overlay.setBackgroundColor('#00000000');
    for (const [v, role] of [[this.chrome, 'chrome'], [this.overlay, 'overlay']]) {
      this.roles.set(v.webContents.id, { role });
      this.lockUi(v.webContents);
    }
    this.win.contentView.addChildView(this.chrome);
    this.win.contentView.addChildView(this.overlay);
    this.overlay.setVisible(false);
    this.chrome.webContents.loadFile(path.join(UI_DIR, 'chrome.html'));
    this.overlay.webContents.loadFile(path.join(UI_DIR, 'overlay.html'));

    this.win.on('resize', () => { this.layout(); this.rememberBounds(); });
    this.win.on('move', () => this.rememberBounds());
    this.win.on('maximize', () => this.winState.update({ maximized: true }));
    this.win.on('unmaximize', () => this.winState.update({ maximized: false }));
    this.win.on('enter-full-screen', () => { this.layout(); this.pushState(); });
    this.win.on('leave-full-screen', () => { this.htmlFullscreen = false; this.layout(); this.pushState(); });
    this.win.on('close', (e) => {
      if (!this.quitting && this.settings.get().tray && this.settings.get().closeToTray) { e.preventDefault(); this.win.hide(); }
    });
    this.win.on('closed', () => { this.win = null; });
    this.win.on('focus', () => { const t = this.activeTab(); if (t && !this.panel) t.wc.focus(); });

    const s = this.settings.get();
    if (!hidden) this.showWindow();
    if (s.startFullscreen) this.win.setFullScreen(true);
  }

  showWindow() { if (!this.win) return; if (this.win.isMinimized()) this.win.restore(); this.win.show(); this.win.focus(); }
  rememberBounds() { if (!this.win || this.win.isFullScreen() || this.win.isMaximized() || this.win.isMinimized()) return; this.winState.update({ bounds: this.win.getBounds() }); }
  toggleFullscreen() {
    if (!this.win) return;
    const next = !this.win.isFullScreen();
    this.win.setFullScreen(next);
    this.settings.set({ startFullscreen: next });
    this.onSettingsChanged(['startFullscreen']);
  }

  lockUi(wc) {
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  homeTab() { return this.tabs.get(this.model.tabs.find((t) => t.pinned).id); }
  activeTab() { return this.tabs.get(this.model.activeId); }
  activeIsHome() { const a = this.model.active(); return !!a && a.pinned; }

  size() { const [w, h] = this.win.getContentSize(); return { w, h }; }
  chromeH() { return this.htmlFullscreen ? 0 : chromeHeight(this.activeIsHome(), this.settings.get()); }

  layout() {
    if (!this.win) return;
    const { w, h } = this.size();
    const ch = this.chromeH();
    this.chrome.setBounds({ x: 0, y: 0, width: w, height: ch });
    this.chrome.setVisible(ch > 0);
    for (const [id, t] of this.tabs) {
      const on = id === this.model.activeId;
      t.view.setVisible(on);
      if (on) t.view.setBounds({ x: 0, y: ch, width: w, height: Math.max(0, h - ch) });
    }
    this.layoutOverlay();
  }

  overlayKind() { return this.panel ? 'panel' : this.prompts.length ? 'prompt' : this.findOpen ? 'find' : null; }
  layoutOverlay() {
    if (!this.win) return;
    const { w, h } = this.size();
    const ch = this.chromeH();
    const kind = this.overlayKind();
    if (!kind) { this.overlay.setVisible(false); return; }
    const rect = kind === 'panel' ? { x: 0, y: ch, width: w, height: Math.max(0, h - ch) }
      : kind === 'prompt' ? { x: Math.max(0, Math.min(16, w - 440)), y: ch + 8, width: Math.min(440, w), height: Math.min(300, Math.max(0, h - ch)) }
        : { x: Math.max(0, w - 400), y: ch + 8, width: Math.min(392, w), height: 56 };
    this.overlay.setBounds(rect);
    this.overlay.setVisible(true);
    // keep it above the page views
    this.win.contentView.addChildView(this.overlay);
    this.pushOverlay();
    if (kind !== 'prompt') this.overlay.webContents.focus();
  }

  // ---------- tabs ----------
  newTab({ url = '', private: priv = false, pinned = false, activate = true, afterActive = false, appId = null, tor = false } = {}) {
    if (tor && !this.tor.ready) { this.notice('Tor is not connected'); return null; }
    const webapp = appId ? this.appById(appId) : null;
    if (webapp) this.sessionForApp(webapp);
    const kind = pinned ? 'home' : webapp ? 'app' : tor ? 'tor' : priv ? 'private' : 'browse';
    if (tor) this.torSession();
    const role = pinned ? 'web' : 'page';
    const view = new WebContentsView({
      webPreferences: {
        partition: webapp ? W.partitionFor(webapp.id) : PARTITION[kind], preload: PRELOAD(pinned ? 'web' : 'page'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
        allowRunningInsecureContent: false, spellcheck: process.platform === 'darwin', additionalArguments: ['--mf-role=' + role],
        devTools: !pinned || this.devTools,      // the Mayfair tab has no developer tools in an installed build (owner switch: MAYFAIR_DESKTOP_DEVTOOLS=1)
      },
    });
    const tab = this.model.add({ pinned, private: priv || tor, tor, url, activate, afterActive, appId: webapp ? webapp.id : null });
    const t = { view, wc: view.webContents, loading: false, favicon: '', pw: false, blocked: 0, lastInput: 0, find: null };
    this.tabs.set(tab.id, t);
    this.roles.set(t.wc.id, { role, tabId: tab.id });
    this.win.contentView.addChildView(view);
    this.win.contentView.addChildView(this.overlay); // overlay stays on top
    if (pinned && this.tampered) { const orig = t.wc.loadURL.bind(t.wc); t.wc.loadURL = (u, o) => (isInternal(u) ? orig(u, o) : Promise.resolve()); }   // a changed install never opens Mayfair Cloud, whoever asks
    this.wireTab(tab.id, t, { locked: pinned, priv: priv || tor, webapp });
    const ready = this.preparePrivacy(t, kind);
    const target = url ? (pinned || webapp ? url : O.normalizeInput(url, this.settings.get().searchEngine)) : null;
    ready.then(() => {
      if (!this.tabs.has(tab.id)) return;
      if (pinned && this.tampered) { t.wc.loadFile(path.join(UI_DIR, 'tampered.html')).catch(() => {}); return; }
      if (target) t.wc.loadURL(target).catch(() => {});
      else if (!pinned) t.wc.loadFile(path.join(UI_DIR, 'newtab.html'), { query: { e: this.settings.get().searchEngine } });
    });
    if (activate) { this.closePanels(); this.layout(); if (!url && !pinned) this.chrome.webContents.send('focus-address'); }
    this.pushState();
    return tab.id;
  }

  closeTab(id) {
    const r = this.model.close(id);
    if (!r.closed) return false;
    const t = this.tabs.get(id);
    this.tabs.delete(id);
    this.roles.delete(t.wc.id);
    try { this.win.contentView.removeChildView(t.view); } catch { /* gone */ }
    try { t.wc.close(); } catch { /* gone */ }
    if (r.tab.private && !this.model.tabs.some((x) => x.private && !x.tor)) this.wipePrivate();
    if (r.tab.tor && !this.model.tabs.some((x) => x.tor)) { this.wipeTor(); this.tor.stop(); }
    this.closePanels(true);
    this.layout();
    this.pushState();
    return true;
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
    if (!p.standardLocale && !p.reduceFingerprint) return;
    try {
      t.wc.debugger.attach('1.3');
      // The debugger answers (and a new-document script only takes effect) after a first
      // navigation, so load a blank page, set everything up, then let the real load follow.
      await t.wc.loadURL('about:blank').catch(() => {});
      const send = (m, params) => t.wc.debugger.sendCommand(m, params).catch(() => {});
      await send('Page.enable');
      if (p.standardLocale) {
        await send('Emulation.setTimezoneOverride', { timezoneId: PV.STD.timezone });
        await send('Emulation.setLocaleOverride', { locale: PV.STD.locale });
        await send('Network.enable');
        await send('Network.setUserAgentOverride', { userAgent: t.wc.getUserAgent(), acceptLanguage: 'en-US,en' });
      }
      if (p.reduceFingerprint) await send('Page.addScriptToEvaluateOnNewDocument', { source: PV.fingerprintScript() });
      t.privacyApplied = p;
    } catch { t.privacyApplied = null; }
  }

  async torNewTab() {
    if (!this.tor.ready) {
      try { await this.tor.start(); } catch (e) { this.notice(e.message); return null; }
    }
    this.showWindow();
    return this.newTab({ tor: true });
  }

  activate(id) {
    if (!this.model.activate(id)) return;
    this.closePanels(true);
    this.layout();
    const t = this.activeTab();
    if (t) t.wc.focus();
    this.pushState();
  }

  wireTab(id, t, { locked, priv, webapp }) {
    const wc = t.wc;
    const upd = () => this.pushState();
    const lockedNav = (e, url) => {
      if (isInternal(url)) return;
      if (locked && PROT.isViewSource(url)) { e.preventDefault(); return; }      // no view-source: of the Mayfair page
      let c = O.classifyNavigation(url, { locked });
      if (webapp && c === 'allow') c = W.staysInApp(webapp, url) ? 'allow' : 'newtab';
      if (c === 'allow') return;
      e.preventDefault();
      this.routeBlockedNav(c, url, { fromPriv: priv });
    };
    wc.on('will-navigate', (e, u) => { lockedNav(e, e.url || u); });
    wc.on('will-redirect', (e, u) => { lockedNav(e, e.url || u); });
    wc.setWindowOpenHandler((d) => {
      if (locked && PROT.isViewSource(d.url)) return { action: 'deny' };
      const c = O.classifyNavigation(d.url, { locked });
      if (c === 'external') { shell.openExternal(d.url).catch(() => {}); return { action: 'deny' }; }
      if (c === 'block') return { action: 'deny' };
      if (webapp && W.staysInApp(webapp, d.url)) { setImmediate(() => wc.loadURL(d.url).catch(() => {})); return { action: 'deny' }; }
      if (locked && O.isMayfairUrl(d.url)) { setImmediate(() => wc.loadURL(d.url)); return { action: 'deny' }; }
      if (locked) { setImmediate(() => this.newTab({ url: d.url, afterActive: true })); return { action: 'deny' }; }
      const origin = O.siteKey(wc.getURL());
      const userOpened = popupAllowed(Date.now(), t.lastInput);
      const allowedBySite = origin && this.sitePerms.get(origin, 'popups') === 'allow';
      if (userOpened || allowedBySite) { setImmediate(() => this.newTab({ url: d.url, private: priv, afterActive: true })); return { action: 'deny' }; }
      this.addPrompt({ type: 'popup', tabId: id, origin: origin || '', url: d.url });
      return { action: 'deny' };
    });
    wc.on('before-input-event', (_e, input) => { if (input.type === 'keyDown' || input.type === 'mouseDown') t.lastInput = Date.now(); });
    if (locked && !this.devTools) {      // Mayfair tab: developer tools and page source shortcuts do nothing, and if anything still opens them they are closed at once
      wc.on('before-input-event', (e, input) => { if (PROT.isDevToolsKey(input)) e.preventDefault(); });
      wc.on('devtools-opened', () => { try { wc.closeDevTools(); } catch { /* gone */ } });
    }
    wc.on('input-event', (_e, ev) => { if (ev.type === 'mouseDown' || ev.type === 'keyDown') t.lastInput = Date.now(); });
    wc.on('page-title-updated', (_e, title) => { const m = this.model.get(id); if (m) { m.title = title; if (webapp) this.setBadge(webapp, W.badgeFromTitle(title), this.model.activeId === id && !!this.win && this.win.isFocused()); upd(); } });
    wc.on('page-favicon-updated', (_e, f) => { t.favicon = (f || []).find((x) => /^https?:/.test(x)) || ''; upd(); });
    wc.on('did-start-loading', () => { t.loading = true; upd(); });
    wc.on('did-stop-loading', () => { t.loading = false; upd(); });
    wc.on('did-start-navigation', (_e, url, inPlace, isMain) => { if (isMain && !inPlace) { t.blocked = 0; t.pw = false; } });
    const nav = (_e, url) => {
      const m = this.model.get(id);
      if (!m) return;
      m.url = isInternal(url) ? '' : url;
      this.applyZoom(t, url);
      if (!isInternal(url)) this.history.add(url, wc.getTitle(), Date.now(), { private: priv });
      upd();
    };
    wc.on('did-navigate', nav);
    wc.on('did-navigate-in-page', (_e, url, isMain) => { if (isMain) nav(_e, url); });
    wc.on('dom-ready', () => { if (locked) this.flushHome(); });
    wc.on('did-finish-load', () => { if (locked && O.isMayfairUrl(wc.getURL())) this.flushHome(); });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (!isMain || code === -3 || code === 0) return; // -3 = aborted by a newer navigation
      wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { u: url, e: desc, c: String(code), h: locked ? '1' : '0' } }).catch(() => {});
    });
    wc.on('render-process-gone', (_e, d) => { if (d.reason !== 'clean-exit') wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { u: wc.getURL(), e: 'The page crashed (' + d.reason + ')', c: 'crash', h: locked ? '1' : '0' } }).catch(() => {}); });
    wc.on('found-in-page', (_e, r) => { if (this.activeTab() === t) this.overlay.webContents.send('find:result', { n: r.activeMatchOrdinal, of: r.matches }); });
    wc.on('enter-html-full-screen', () => { this.htmlFullscreen = true; this.win.setFullScreen(true); this.layout(); });
    wc.on('leave-html-full-screen', () => { this.htmlFullscreen = false; if (!this.settings.get().startFullscreen) this.win.setFullScreen(false); this.layout(); });
    wc.on('context-menu', (_e, p) => this.contextMenu(wc, p, { locked, priv }));
    wc.on('zoom-changed', (_e, dir) => this.zoom(dir === 'in' ? 'in' : 'out'));
    wc.on('focus', () => { if (this.panel) this.closePanels(); });
  }

  routeBlockedNav(c, url, { fromPriv }) {
    if (c === 'newtab') this.newTab({ url, afterActive: true, private: fromPriv });
    else if (c === 'external') shell.openExternal(url).catch(() => {});
  }

  contextMenu(wc, p, { locked, priv }) {
    const items = [];
    const sel = (p.selectionText || '').trim();
    if (p.linkURL) {
      const lc = O.classifyNavigation(p.linkURL, { locked: false });
      if (lc === 'allow') items.push({ label: 'Open link in new tab', click: () => this.newTab({ url: p.linkURL, afterActive: true, private: priv }) });
      items.push({ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' });
    }
    if (sel) {
      items.push({ role: 'copy' });
      if (!locked) items.push({ label: 'Search for "' + sel.slice(0, 30) + (sel.length > 30 ? '...' : '') + '"', click: () => this.newTab({ url: sel, afterActive: true, private: priv }) });
    }
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    if (p.mediaType === 'image' && p.srcURL) items.push({ label: 'Save image', click: () => wc.downloadURL(p.srcURL) });
    if (!items.length) items.push({ label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() }, { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() }, { label: 'Reload', click: () => wc.reload() });
    if (!(locked && !this.devTools) && !app.isPackaged) items.push({ type: 'separator' }, { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // ---------- zoom ----------
  applyZoom(t, url) { const k = O.siteKey(url); const lv = k && this.zoomStore.data.levels[k]; try { t.wc.setZoomLevel(typeof lv === 'number' ? lv : 0); } catch { /* ignore */ } }
  zoom(dir) {
    const t = this.activeTab(); if (!t) return;
    const cur = t.wc.getZoomLevel();
    const next = dir === 'reset' ? 0 : Math.max(-3, Math.min(5, cur + (dir === 'in' ? ZOOM_STEP : -ZOOM_STEP)));
    t.wc.setZoomLevel(next);
    const k = O.siteKey(t.wc.getURL());
    if (k) { if (next === 0) delete this.zoomStore.data.levels[k]; else this.zoomStore.data.levels[k] = next; this.zoomStore.save(); }
    this.pushState();
  }

  // ---------- find ----------
  openFind() { this.findOpen = true; this.layoutOverlay(); this.overlay.webContents.send('panel', { kind: 'find' }); }
  closeFind() { const t = this.activeTab(); if (t) t.wc.stopFindInPage('clearSelection'); this.findOpen = false; this.overlay.webContents.send('panel', { kind: this.panel }); this.layoutOverlay(); if (t) t.wc.focus(); }

  // ---------- panels and prompts ----------
  openPanel(name) {
    if (name === 'find') return this.openFind();
    this.panel = name;
    this.layoutOverlay();
    this.overlay.webContents.send('panel', { kind: name });
  }
  closePanels(silent) {
    if (!this.panel) return;
    this.panel = null;
    this.overlay.webContents.send('panel', { kind: this.findOpen ? 'find' : null });
    this.layoutOverlay();
    const t = this.activeTab(); if (t) t.wc.focus();
  }
  addPrompt(p) {
    p.id = 'p' + (++this.seq);
    this.prompts.push(p);
    if (p.type === 'notice') setTimeout(() => this.dropPrompt(p.id), 3500).unref?.();
    this.layoutOverlay();
  }
  dropPrompt(id) { this.prompts = this.prompts.filter((p) => p.id !== id); this.layoutOverlay(); }
  notice(text) { this.addPrompt({ type: 'notice', text }); }
  pushOverlay() { if (this.overlay && !this.overlay.webContents.isDestroyed()) { this.overlay.webContents.send('prompts', this.prompts.map((p) => ({ id: p.id, type: p.type, origin: p.origin, permission: p.permission, text: p.text, url: p.url, canRemember: p.canRemember }))); this.overlay.webContents.send('downloads', this.downloads.map((d) => this.dlView(d))); } }

  askPermission(wc, origin, permission, details, callback, canRemember) {
    const tab = [...this.tabs.entries()].find(([, t]) => t.wc.id === (wc && wc.id));
    if (tab && this.model.activeId !== tab[0]) this.activate(tab[0]);
    const p = { type: 'permission', origin: origin || 'This page', permission: permission === 'media' ? this.mediaLabel(details) : permission, rawPermission: permission, canRemember };
    this.addPrompt(p);
    this.permWaiters.set(p.id, { callback, origin, permission, canRemember });
    wc && wc.once('destroyed', () => { if (this.permWaiters.delete(p.id)) this.dropPrompt(p.id); });
  }
  mediaLabel(d) { const t = (d && d.mediaTypes) || []; return t.includes('video') && t.includes('audio') ? 'camera and microphone' : t.includes('video') ? 'camera' : 'microphone'; }

  // ---------- downloads ----------
  dlView(d) { return { id: d.id, name: d.name, received: d.received, total: d.total, state: d.state, dir: path.dirname(d.path || ''), cloud: !!d.cloud }; }
  onDownload(item, wc, kind) {
    const s = this.settings.get();
    const home = path.join(app.getPath('documents'), 'Mayfair Drive', 'Downloads');
    const pick = chooseDir(s, { driveDir: home, downloadsDir: app.getPath('downloads') });
    const name = safeFilename(item.getFilename());
    const rec = { id: 'd' + (++this.seq), name, received: 0, total: item.getTotalBytes(), state: 'progressing', path: '', item, cloud: s.downloadMode === 'drive', priv: kind === 'private' || kind === 'tor' };
    if (!pick.ask) {
      try { fs.mkdirSync(pick.dir, { recursive: true }); } catch { /* fall back to default dialog */ }
      rec.path = uniquePath(pick.dir, name);
      item.setSavePath(rec.path);
    }
    this.downloads.unshift(rec);
    this.downloads.length = Math.min(this.downloads.length, 50);
    item.on('updated', () => { rec.received = item.getReceivedBytes(); rec.total = item.getTotalBytes(); rec.state = item.isPaused() ? 'paused' : 'progressing'; if (!rec.path) rec.path = item.getSavePath(); this.pushOverlay(); });
    item.once('done', (_e, st) => {
      rec.state = st; rec.path = item.getSavePath() || rec.path; rec.received = item.getReceivedBytes(); rec.item = null;
      if (st === 'completed') {
        this.notice('Downloaded ' + rec.name);
        if (rec.cloud && !rec.priv) { const tok = this.registerFile(rec.path); if (tok) this.sendHome('download:done', { token: tok.token, name: tok.name, size: tok.size }); }
      }
      this.pushOverlay();
    });
    if (!this.panel) this.addPrompt({ type: 'notice', text: 'Downloading ' + name });
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
  goHome() { this.showWindow(); const h = this.model.tabs.find((t) => t.pinned); if (h) this.activate(h.id); }
  sendHome(channel, payload) {
    const h = this.homeTab();
    const ready = h && !h.wc.isLoading() && O.isMayfairUrl(h.wc.getURL());
    if (ready) h.wc.send(channel, payload); else this.pendingHome.push([channel, payload]);
  }
  flushHome() {
    const h = this.homeTab();
    if (!h || !O.isMayfairUrl(h.wc.getURL())) return;
    for (const [c, p] of this.pendingHome.splice(0)) h.wc.send(c, p);
  }
  openDeepLink(link) {
    const d = O.parseDeepLink(link);
    if (!d) return false;
    this.goHome();
    const h = this.homeTab();
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
      const open = [...this.model.tabs].some((t) => t.appId === a.id) || this.appWindows.has(a.id);
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
    if (wantWindow) { this.openAppWindow(a); this.onAppsChanged(); return true; }
    const have = this.model.tabs.find((t) => t.appId === id);
    if (have) this.activate(have.id); else this.newTab({ url: a.url, appId: id, afterActive: false });
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
    const tab = this.model.tabs.find((t) => t.appId === a.id);
    if (tab) this.closeTab(tab.id);
    this.sessionForApp(a);
    const w = new BrowserWindow({
      width: 1200, height: 800, minWidth: 480, minHeight: 360, title: a.name, backgroundColor: '#0a0a0a', autoHideMenuBar: true,
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      webPreferences: { partition: W.partitionFor(a.id), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, spellcheck: process.platform === 'darwin' },
    });
    const wc = w.webContents;
    this.appWindows.set(a.id, w);
    const guard = (e, u) => { const url = e.url || u; if (W.staysInApp(a, url)) return; e.preventDefault(); const c = O.classifyNavigation(url, { locked: false }); if (c === 'allow') this.newTab({ url }); else if (c === 'external') shell.openExternal(url).catch(() => {}); };
    wc.on('will-navigate', guard); wc.on('will-redirect', guard);
    wc.setWindowOpenHandler((d) => { if (W.staysInApp(a, d.url)) setImmediate(() => wc.loadURL(d.url).catch(() => {})); else if (O.classifyNavigation(d.url, { locked: false }) === 'allow') setImmediate(() => this.newTab({ url: d.url })); return { action: 'deny' }; });
    wc.on('page-title-updated', (_e, t) => this.setBadge(a, W.badgeFromTitle(t), w.isFocused()));
    wc.on('did-fail-load', (_e, code, desc, url, main) => { if (main && code !== -3) wc.loadFile(path.join(UI_DIR, 'error.html'), { query: { u: url, e: desc, c: String(code), h: '0' } }).catch(() => {}); });
    w.on('closed', () => { this.appWindows.delete(a.id); this.pushState(); });
    wc.loadURL(a.url).catch(() => {});
  }
  async wipeApp(a) { const s = this.sessionForApp(a); try { await s.clearStorageData(); await s.clearCache(); await s.clearAuthCache(); } catch { /* best effort */ } this.appBadges.delete(a.id); }
  async resetApp(id) {
    const a = this.appById(id); if (!a) return false;
    await this.wipeApp(a);
    const tab = this.model.tabs.find((t) => t.appId === id);
    if (tab) this.tabs.get(tab.id).wc.loadURL(a.url).catch(() => {});
    const w = this.appWindows.get(id); if (w && !w.isDestroyed()) w.webContents.loadURL(a.url).catch(() => {});
    this.notice(a.name + ' signed out and reset');
    return true;
  }
  async removeApp(id) {
    const a = this.appById(id); if (!a) return false;
    const tab = this.model.tabs.find((t) => t.appId === id); if (tab) this.closeTab(tab.id);
    const w = this.appWindows.get(id); if (w && !w.isDestroyed()) w.destroy();
    await this.wipeApp(a);
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
  pushState() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => { this.stateTimer = null; this.sendState(); }, 30);
  }
  stateObj() {
    const a = this.model.active();
    const t = this.activeTab();
    const url = a ? a.url : '';
    const s = this.settings.get();
    return {
      tabs: this.model.tabs.map((m) => { const x = this.tabs.get(m.id); return { tor: !!m.tor, badge: m.appId ? (this.appBadges.get(m.appId) || 0) : 0, app: m.appId || null, id: m.id, title: m.title || (m.url ? m.url : 'New tab'), url: m.url, pinned: m.pinned, private: m.private, loading: !!(x && x.loading), favicon: x ? x.favicon : '' }; }),
      activeId: this.model.activeId,
      url, secure: O.httpsState(url), loading: !!(t && t.loading),
      canBack: !!(t && t.wc.navigationHistory.canGoBack()), canForward: !!(t && t.wc.navigationHistory.canGoForward()),
      bookmarked: this.bookmarks.has(url), zoom: t ? t.wc.getZoomLevel() : 0, blocked: t ? t.blocked : 0, pw: !!(t && t.pw),
      home: !!(a && a.pinned), private: !!(a && a.private), tor: !!(a && a.tor), proxy: !!this.proxyActive, torState: { ...this.tor.state }, fullscreen: !!(this.win && this.win.isFullScreen()),
      settings: { bookmarksBar: s.bookmarksBar, hideToolbarOnMayfair: s.hideToolbarOnMayfair },
      bookmarks: this.bookmarks.list().slice(0, 40).map((b) => ({ id: b.id, title: b.title, url: b.url })),
      platform: process.platform,
    };
  }
  sendState() {
    if (!this.win) return;
    const st = this.stateObj();
    if (!this.chrome.webContents.isDestroyed()) this.chrome.webContents.send('state', st);
    if (!this.overlay.webContents.isDestroyed()) this.overlay.webContents.send('state', st);
    const t = this.win.getTitle();
    const a = this.model.active();
    const title = (a && a.title ? a.title + ' - ' : '') + 'Mayfair Desktop';
    if (t !== title) this.win.setTitle(title);
    this.layout();
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
        if (role === 'page' && e.senderFrame && e.senderFrame === e.sender.mainFrame && e.senderFrame.url.split('?')[0] === START_URL) role = 'start';
        const v = IPC.check(role, ch, args);
        if (!v.ok) throw new Error('blocked: ' + v.reason);
        if (!this.senderTrusted(e, role)) { if (role === 'page' || role === 'start') return undefined; throw new Error('blocked: untrusted sender'); }
        return H[ch](e, ...args);
      });
    }
  }
  senderTrusted(e, role) {
    if (role === 'chrome' || role === 'overlay') return e.senderFrame && e.senderFrame.url.startsWith(UI_URL) && e.senderFrame === e.sender.mainFrame;
    if (role === 'web') return e.senderFrame === e.sender.mainFrame && O.isMayfairUrl(e.senderFrame.url);
    if (role === 'page' || role === 'start') return e.senderFrame === e.sender.mainFrame;
    return false;
  }
  tabOf(e) { const r = this.roles.get(e.sender.id); return r && r.tabId ? this.tabs.get(r.tabId) : null; }

  handlers() {
    const act = () => this.activeTab();
    const navTarget = (txt) => { const t = act(); const a = this.model.active(); if (!t || !a || a.pinned) return; const cmd = ANS.parseCommand(txt); if (cmd) return this.runCommand(cmd); const u = O.normalizeInput(txt, this.settings.get().searchEngine); if (u) t.wc.loadURL(u).catch(() => {}); };
    return {
      'tab:new': (e, o) => this.newTab({ url: o && o.url || '', private: !!(o && o.private) }),
      'tab:close': (e, id) => this.closeTab(id),
      'tab:closeOthers': (e, id) => { for (const m of this.model.tabs.filter((t) => !t.pinned && t.id !== id)) this.closeTab(m.id); },
      'tab:activate': (e, id) => this.activate(id),
      'tab:move': (e, id, i) => { const ok = this.model.move(id, i); this.pushState(); return ok; },
      'tab:go': (e, txt) => navTarget(txt),
      'tab:back': () => { const t = act(); if (t && t.wc.navigationHistory.canGoBack()) t.wc.navigationHistory.goBack(); },
      'tab:forward': () => { const t = act(); if (t && t.wc.navigationHistory.canGoForward()) t.wc.navigationHistory.goForward(); },
      'tab:reload': (e, hard) => { const t = act(); if (t) hard ? t.wc.reloadIgnoringCache() : t.wc.reload(); },
      'tab:stop': () => { const t = act(); if (t) t.wc.stop(); },
      'tab:list': () => this.stateObj().tabs,
      'tab:duplicate': (e, id) => { const m = this.model.get(id); if (m && !m.pinned && m.url) this.newTab({ url: m.url, private: m.private, afterActive: true }); },
      'bm:list': () => this.bookmarks.list(),
      'bm:toggle': () => { const a = this.model.active(); if (!a || !a.url) return { on: false }; const r = this.bookmarks.toggle(a.url, a.title); this.pushState(); return r; },
      'bm:remove': (e, id) => { const r = this.bookmarks.remove(id); this.pushState(); return r; },
      'bm:rename': (e, id, t) => this.bookmarks.rename(id, t),
      'hist:list': (e, q) => this.history.search(q || '', 200),
      'hist:remove': (e, u) => this.history.removeUrl(u),
      'hist:clear': (e, since) => this.history.clear(since),
      'panel:open': (e, n) => this.openPanel(n),
      'panel:close': () => { if (this.findOpen) this.closeFind(); this.closePanels(); },
      'find:run': async (e, text, fwd, next) => {
        const t = act(); if (!t) return;
        if (!text) { t.wc.stopFindInPage('clearSelection'); t.find = null; this.overlay.webContents.send('find:result', { n: 0, of: 0 }); return; }
        t.wc.findInPage(text, { forward: fwd, findNext: next });
        // Chromium's own count event is not reliable in every environment, so count here too.
        let total = 0;
        try { total = await t.wc.executeJavaScript(`(()=>{const q=${JSON.stringify(text.toLowerCase())};const s=((document.body&&document.body.innerText)||'').toLowerCase();let n=0,i=0;while(q&&(i=s.indexOf(q,i))>=0){n++;i+=q.length;}return n})()`); } catch { /* page not scriptable */ }
        const f = t.find && t.find.text === text && next ? t.find : { text, idx: 0 };
        f.idx = !total ? 0 : !next || !f.idx ? 1 : fwd ? (f.idx % total) + 1 : ((f.idx - 2 + total) % total) + 1;
        t.find = f;
        this.overlay.webContents.send('find:result', { n: f.idx, of: total });
      },
      'find:stop': () => this.closeFind(),
      'zoom:set': (e, d) => this.zoom(d),
      'page:fullscreenToggle': () => this.toggleFullscreen(),
      'privacy:get': () => ({ ...this.settings.get(), torState: { ...this.tor.state }, torAvailable: !!this.tor.binary, notes: PV.NOTES, dnsProviders: Object.fromEntries(Object.entries(PV.DNS_PROVIDERS).map(([k, v]) => [k, v.name])), proxyActive: !!this.proxyActive }),
      'privacy:set': async (e, patch) => {
        const keys = ['secureDns', 'dnsProvider', 'ech', 'webrtc', 'standardLocale', 'reduceFingerprint'];
        const only = {}; for (const k of keys) if (k in patch) only[k] = patch[k];
        const ch = this.settings.set(only);
        if (ch.some((k) => ['secureDns', 'dnsProvider'].includes(k))) await this.applyNetwork();
        return { changed: ch, restart: ch.includes('ech') || (ch.includes('secureDns') && this.settings.get().ech), ...this.settings.get() };
      },
      'privacy:setProxy': async (e, mode, host, port) => {
        const r = PV.proxyConfig(mode, host, port);
        if (!r.ok) return { ok: false, error: r.error };
        this.settings.set({ proxyMode: mode, proxyHost: mode === 'off' ? '' : host, proxyPort: mode === 'off' ? 0 : port });
        await this.applyNetwork();
        return { ok: true };
      },
      'tor:newTab': () => this.torNewTab().then((id) => !!id),
      'tor:newIdentity': async () => { try { await this.tor.newIdentity(); await this.wipeTor(); this.torSession(); for (const m of this.model.tabs.filter((x) => x.tor)) { const x = this.tabs.get(m.id); if (x) x.wc.reload(); } this.notice('New Tor identity'); return true; } catch (err) { this.notice(err.message); return false; } },
      'tor:stop': () => { for (const m of this.model.tabs.filter((x) => x.tor)) this.closeTab(m.id); this.tor.stop(); },
      'apps:list': () => this.appsView(),
      'apps:open': (e, id) => this.openApp(id),
      'apps:openWindow': (e, id) => this.openApp(id, { window: true }),
      'apps:add': (e, id) => { const ok = this.appById(id) && this.appsStore.add(id); if (ok) this.openApp(id); return !!ok; },
      'apps:remove': (e, id) => this.removeApp(id),
      'apps:reset': (e, id) => this.resetApp(id),
      'apps:pin': (e, id, on) => { if (!this.appById(id)) return false; this.appsStore.add(id); const ok = this.appsStore.setPinned(id, on); this.onAppsChanged(); return ok; },
      'apps:shortcut': (e, id) => this.createShortcut(id),
      'dl:list': () => this.downloads.map((d) => this.dlView(d)),
      'dl:cancel': (e, id) => { const d = this.downloads.find((x) => x.id === id); if (d && d.item) d.item.cancel(); },
      'dl:show': (e, id) => { const d = this.downloads.find((x) => x.id === id); if (d && d.path && d.state === 'completed') shell.showItemInFolder(d.path); },
      'dl:open': async (e, id) => { const d = this.downloads.find((x) => x.id === id); if (d && d.path && d.state === 'completed') { const r = await shell.openPath(d.path); if (r) this.notice('Could not open the file'); } },
      'dl:clear': () => { this.downloads = this.downloads.filter((d) => d.state === 'progressing'); this.pushOverlay(); },
      'settings:get': () => ({ ...this.settings.get(), version: this.version, platform: process.platform, dataDir: this.dir, blocklistSize: this.ad && this.ad.active ? this.ad.info.rules : this.blocker.size, adEngine: this.ad ? this.ad.info.engine : 'basic' }),
      'settings:set': (e, patch) => { const ch = this.settings.set(patch); if (ch.includes('adblock')) this.applyAdblock(); if (ch.length) { this.onSettingsChanged(ch); this.layout(); this.pushState(); } return this.settings.get(); },
      'settings:pickFolder': async () => { const r = await dialog.showOpenDialog(this.win, { properties: ['openDirectory', 'createDirectory'] }); if (r.canceled || !r.filePaths[0]) return null; this.settings.set({ downloadFolder: r.filePaths[0], downloadMode: 'folder' }); return r.filePaths[0]; },
      'perm:answer': (e, id, decision, remember) => {
        const w = this.permWaiters.get(id); if (!w) return;
        this.permWaiters.delete(id); this.dropPrompt(id);
        if (remember && w.canRemember && w.origin) this.sitePerms.set(w.origin, w.permission, decision);
        w.callback(decision === 'allow');
      },
      'perm:site': () => { const t = act(); const k = t && O.siteKey(t.wc.getURL()); const a = this.model.active(); return { origin: k, secure: O.httpsState(a ? a.url : ''), perms: k ? this.sitePerms.forSite(k) : {}, blocked: t ? t.blocked : 0, adblock: this.settings.get().adblock, siteAllowed: k ? ((this.ad && this.ad.active) ? this.ad.isSiteOff(new URL(k).hostname) : this.blocker.allowSites.has(new URL(k).hostname)) : false, engine: this.ad ? this.ad.info.engine : 'basic', internal: !k }; },
      'perm:setSite': (e, origin, perm, val) => { const ok = this.sitePerms.set(origin, perm, val === 'ask' ? null : val); return ok; },
      'perm:reset': (e, origin) => { this.sitePerms.resetSite(origin); },
      'popup:allowOnce': () => {
        const p = this.prompts.find((x) => x.type === 'popup'); if (!p) return;
        this.dropPrompt(p.id);
        this.newTab({ url: p.url, afterActive: true });
      },
      'privacy:clearBrowsing': async () => {
        this.history.clear(); this.downloads = [];
        const s = session.fromPartition(PARTITION.browse);
        await s.clearStorageData(); await s.clearCache();
        this.notice('Browsing data cleared');
      },
      'adblock:toggleSite': () => {
        const t = act(); if (!t) return; const k = O.siteKey(t.wc.getURL()); if (!k) return; const h = new URL(k).hostname;
        if (this.ad && this.ad.active) {
          this.ad.setSiteOff(h, !this.ad.isSiteOff(h));
          this.adAllow.data.allow = [...this.ad.allow]; this.adAllow.save();
        } else this.blocker.setSiteAllowed(h, !this.blocker.allowSites.has(h));
        t.wc.reload();
      },
      'about:get': () => ({ extensions: this.ext.list(), version: this.version, platform: process.platform, adblock: { ...this.ad.info, enabled: this.settings.get().adblock, legacyDomains: this.blocker.size }, lists: this.ad.info.lists.length ? this.ad.info.lists : FILTERS.lists.map((l) => ({ ...l, loaded: false })), allow: [...this.ad.allow] }),
      'adblock:updateNow': async () => { const r = await this.ad.update({ force: true }); this.applyAdblock(); return { done: (r.done || []).length, failed: (r.failed || []).map((f) => f.id + ': ' + f.error) }; },
      'pw:fill': (e) => this.requestPasswordFill(),
      'app:minimize': () => this.win.minimize(),
      'app:toggleFullscreen': () => this.toggleFullscreen(),
      'app:quit': () => app.quit(),
      'ui:ready': () => { this.sendState(); this.pushOverlay(); },

      'web:info': () => ({ version: this.version, platform: process.platform, fullscreen: !!(this.win && this.win.isFullScreen()) }),
      'web:notify': (e, n) => {
        if (!this.settings.get().notifications || !Notification.isSupported()) return false;
        const note = new Notification({ title: n.title || 'Mayfair', body: n.body || '', silent: false });
        note.on('click', () => { this.goHome(); if (n.url && O.isMayfairUrl(n.url)) this.homeTab().wc.loadURL(n.url).catch(() => {}); });
        note.show();
        return true;
      },
      'web:badge': (e, n) => { try { app.setBadgeCount(n); } catch { /* unsupported */ } this.onBadge && this.onBadge(n); },
      'web:openBrowser': (e, url) => { const c = O.classifyNavigation(url, { locked: false }); if (c !== 'allow') return false; this.showWindow(); this.newTab({ url }); return true; },
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
      'search:config': () => { const st = this.settings.get(); return { engine: st.searchEngine, engineName: O.ENGINE_NAMES[st.searchEngine], engines: O.ENGINE_NAMES, online: st.onlineAnswers, rates: this.rates, home: this.homeTab() ? true : false }; },
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
        t.wc.loadURL(u).catch(() => {}); return true;
      },
      'search:command': (e, text) => { const cmd = ANS.parseCommand(text); return cmd ? this.runCommand(cmd) : false; },
      'search:online': async (e, i) => { if (!this.settings.get().onlineAnswers) return null; return ONLINE.run(i, (u) => this.fetchJson(u)); },
      'search:panel': (e, n) => { this.openPanel(n); },
      'search:home': () => this.goHome(),
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
      'page:pwDetected': (e, has) => { const t = this.tabOf(e); if (t) { t.pw = has; this.pushState(); } },
    };
  }

  // Mayfair Search helpers
  runCommand(cmd) {
    const q = new URLSearchParams(cmd.params).toString();
    return this.openDeepLink('mayfair://' + cmd.action + cmd.path + (q ? '?' + q : ''));
  }
  queryHomeSearch(q) {
    const h = this.homeTab();
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

  requestPasswordFill() {
    const t = this.activeTab();
    const origin = t && O.siteKey(t.wc.getURL());
    if (!origin || !origin.startsWith('https:')) return this.notice('Passwords only fill on secure pages');
    if (!this.homeListening) return this.notice('Open Mayfair Passwords first');
    const id = 'q' + (++this.seq);
    this.pwWaiters.set(id, { wcId: t.wc.id, origin });
    setTimeout(() => this.pwWaiters.delete(id), 30000).unref?.();
    this.sendHome('pw:request', { id, origin, host: new URL(origin).hostname });
  }

  // ---------- menu actions for main.js ----------
  flushAll() { this.adAllow.flush(); this.tor.stop(); for (const s of [this.appsStore, this.settings, this.winState, this.bookmarks, this.history, this.sitePerms, this.zoomStore]) { try { (s.flush ? s : s.s).flush(); } catch { /* ignore */ } } }
  menuAction(a) {
    const act = {
      newTab: () => { this.showWindow(); this.newTab({}); },
      newPrivate: () => { this.showWindow(); this.newTab({ private: true }); },
      closeTab: () => { const a2 = this.model.active(); if (a2 && !a2.pinned) this.closeTab(a2.id); },
      next: () => { this.model.step(1); this.activate(this.model.activeId); },
      prev: () => { this.model.step(-1); this.activate(this.model.activeId); },
      reload: () => { const t = this.activeTab(); if (t) t.wc.reload(); },
      address: () => { const a2 = this.model.active(); if (a2 && a2.pinned) return; this.chrome.webContents.focus(); this.chrome.webContents.send('focus-address'); },
      find: () => this.openFind(),
      zoomIn: () => this.zoom('in'), zoomOut: () => this.zoom('out'), zoomReset: () => this.zoom('reset'),
      fullscreen: () => this.toggleFullscreen(),
      home: () => this.goHome(),
      bookmark: () => this.handlers()['bm:toggle'](),
      apps: () => this.openPanel('apps'), about: () => this.openPanel('about'), privacy: () => this.openPanel('privacy'), torTab: () => this.torNewTab(), bookmarks: () => this.openPanel('bookmarks'), history: () => this.openPanel('history'), downloads: () => this.openPanel('downloads'), settings: () => this.openPanel('settings'),
    }[a];
    if (act) act();
  }
}
module.exports = { Browser, UI_DIR };
