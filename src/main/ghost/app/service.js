'use strict';
// Mayfair Ghost, the app: what the Ghost window may ask of the main process.
//   start flow:  download (install record) -> sign in with Mayfair ID (device flow) -> entitlement check -> Terms (once per version) -> the app
//   after that:  cases in the vault, connectors and jobs (the existing Ghost connector core), the light scope guard for active scans, reports, the terminal.
// Every call except the start flow is refused until the whole flow is complete ("not-ready"); main re-checks, the page is never trusted.
// There is no question about keys, passphrase or purpose anywhere in the flow: the vault opens with this computer's key store on its own.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const T = require('./terms-text');
const { IdError, normalizeEntitlement } = require('./id-client');
const { CaseStore, CaseError } = require('./cases');
const { PrefStore } = require('./prefs');
const { ScopeGuard, ScopeError } = require('./scopelog');
const R = require('./report');
const { registerBuiltins, BuiltinSetup } = require('./builtins');
const { Search, classify } = require('./search');
const { NoteStore } = require('./notes');
const NR = require('./notes-report');

const CLOUD = 'https://cloud.mayfairmail.com';
const ENT_RECHECK_MS = 6 * 60 * 60 * 1000;          // asked again at start and every 6 hours
const ENT_GRACE_MS = 72 * 60 * 60 * 1000;           // how long the last good answer is used when Mayfair cannot be reached
const SESSION_REC = 'ghost-app-session', ENT_REC = 'ghost-app-entitlement';
// Tools whose purpose is finding or profiling one private person are not part of Ghost. They are never listed here and never run from here.
const BLOCKED = /sherlock|maigret|blackbird|holehe|whats-?my-?name|\bwmn\b|people-?search|username-?(search|check|enum)|account-?(search|finder|enum)|email-?(lookup|registration|osint)|phone-?(lookup|osint)|face-?(search|match|recogni)|reverse-?(image|face)|doxx|social-?(profile|graph)/i;

class AppError extends Error { constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); } }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (e) => ({ ok: false, code: e && e.code ? e.code : 'error', error: e instanceof AppError || e instanceof IdError || e instanceof CaseError || e instanceof ScopeError || (e && e.code) ? e.message : 'Something went wrong.' });

function atomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file);
}

class GhostApp {
  constructor({ userData, ghost, id, cloudBase = CLOUD, fetchImpl = (typeof fetch === 'function' ? fetch : null), allowLoopback = false, shell = null, dialog = null, getWindow = () => null, openTerminal = async () => false, openToolIntegrations = async () => false,
    emit = () => {}, now = Date.now, version = '0.0.0', pollMinMs = 2000, electron = null, autoSetup: autoSetupOn = true, vmPublished = null } = {}) {
    this.vmPublished = typeof vmPublished === 'function' ? vmPublished : () => { try { return !!require('../vm/images').loadIndex().published; } catch { return false; } };
    this.autoSetupOn = autoSetupOn !== false;
    this.userData = userData; this.ghost = ghost; this.id = id; this.fetch = fetchImpl; this.shell = shell; this.dialog = dialog; this.getWindow = getWindow; this.electron = electron;
    this.openTerminal = openTerminal; this.openToolIntegrations = openToolIntegrations; this.emit = emit; this.now = now; this.version = version; this.pollMinMs = pollMinMs;
    const cb = String(cloudBase).replace(/\/+$/, '');
    if (!(cb === CLOUD || (allowLoopback && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(cb)))) throw new AppError('bad-base', 'The Mayfair Cloud address is not allowed.');
    this.cloud = cb; this.allowLoopback = allowLoopback;
    this.dir = path.join(userData, 'ghost'); this.installFile = path.join(this.dir, 'app-install.json'); this.termsFile = path.join(this.dir, 'app-terms.json');
    this.vault = ghost.vaultSvc ? ghost.vaultSvc.vault : null;
    this.cases = this.vault ? new CaseStore({ vault: this.vault, now }) : null;
    this.notes = this.vault ? new NoteStore({ vault: this.vault, now }) : null;      // Quick notes: sealed in the same vault, one document per case
    this.prefs = this.vault ? new PrefStore({ vault: this.vault }) : null;
    this.scope = ghost.vaultSvc ? new ScopeGuard({ io: ghost.vaultSvc.io.logs, now }) : null;
    this.mem = { session: null, ent: null, entAt: 0, loaded: false, signin: null, refreshing: null, checking: false, lastError: null, hiddenConnectors: 0, builtins: null, builtinsErrAt: 0, setup: null, search: null, builtinsTimer: null };
    this.polling = null;
  }

  // ---------- install record ----------
  installRecord() { try { const r = JSON.parse(fs.readFileSync(this.installFile, 'utf8')); return isObj(r) && r.installed === true ? r : null; } catch { return null; } }
  installed() { return !!this.installRecord(); }
  libraryEntry() {
    const r = this.installRecord();
    return { id: 'ghost', name: 'Mayfair Ghost', category: 'Research', preinstalled: false, installed: !!r, version: r ? r.version : null, needsDesktop: true, requiresApproval: true, price: 'Free',
      tagline: 'Free, open-source tools for approved professional investigators. Case board, source tracking and reports. Everything stays on your computer.' };
  }

  // ---------- session and entitlement (kept in the vault) ----------
  _vaultOk() { if (!this.vault) return false; try { this.vault.ensure(); } catch { return false; } return !!this.vault.unlocked; }
  _load() {
    if (this.mem.loaded) return;
    if (!this._vaultOk()) return;
    try { this.mem.session = this.vault.getJSON('connectors', SESSION_REC); } catch { this.mem.session = null; }
    try { const e = this.vault.getJSON('connectors', ENT_REC); if (e && isObj(e.ent)) { this.mem.ent = e.ent; this.mem.entAt = Number(e.at) || 0; if (this.mem.session && e.sub !== this.mem.session.sub) { this.mem.ent = null; this.mem.entAt = 0; } } } catch { /* none */ }
    this.mem.loaded = true;
  }
  _saveSession(s) { this.mem.session = s; if (this._vaultOk()) this.vault.putJSON('connectors', SESSION_REC, s); }
  _saveEnt(ent) { this.mem.ent = ent; this.mem.entAt = this.now(); if (this._vaultOk()) this.vault.putJSON('connectors', ENT_REC, { ent, at: this.mem.entAt, sub: this.mem.session && this.mem.session.sub }); }
  _clearSession() {
    this.mem.session = null; this.mem.ent = null; this.mem.entAt = 0;
    if (this._vaultOk()) { for (const r of [SESSION_REC, ENT_REC]) { try { this.vault.remove('connectors', r); } catch { /* not there */ } } }
  }
  // The entitlement the gate trusts: approved, not expired, and either fresh or inside the offline grace. Operators carry no expiry.
  entitlement() {
    this._load(); const e = this.mem.ent; if (!e || !e.approved) return null;
    const t = this.now();
    if (e.expiresAt && Date.parse(e.expiresAt) <= t) return null;
    if (t - this.mem.entAt > ENT_GRACE_MS) return null;
    return e;
  }
  termsRecord() { try { const r = JSON.parse(fs.readFileSync(this.termsFile, 'utf8')); return isObj(r) ? r : null; } catch { return null; } }
  termsAccepted() { const r = this.termsRecord(); return !!r && r.version === T.VERSION && r.sha256 === T.SHA256 && Number.isFinite(Date.parse(r.acceptedAt)); }

  // The stage the window shows. Exactly one of: download, vault-locked, signin, checking, offline, apply, terms, ready.
  stage() {
    if (!this.installed()) return 'download';
    if (!this._vaultOk()) return 'vault-locked';
    this._load();
    if (!this.mem.session) return 'signin';
    if (this.mem.checking && !this.mem.ent) return 'checking';
    if (!this.mem.ent) return this.mem.lastError === 'offline' ? 'offline' : 'checking';
    if (this.mem.ent.approved) {
      if (!this.entitlement()) return this.mem.lastError === 'offline' || this.now() - this.mem.entAt > ENT_GRACE_MS ? 'offline' : 'apply';
      return this.termsAccepted() ? 'ready' : 'terms';
    }
    return 'apply';
  }
  status() {
    try { this.ensureBuiltins(); } catch (e) { this._logWarn('builtins-ensure-failed', { reason: e && e.message }); }
    this._load(); const rec = this.installRecord(), s = this.mem.session, e = this.mem.ent, vs = this.vault ? this.vault.status() : null;
    const si = this.mem.signin;
    return {
      stage: this.stage(), version: this.version, installed: !!rec,
      account: s ? { email: s.email || null, name: s.name || null } : null,
      entitlement: e ? { status: e.status, approved: !!e.approved, operator: !!e.operator, expiresAt: e.expiresAt, modules: e.modules, applyUrl: e.applyUrl, note: e.note, checkedAt: new Date(this.mem.entAt).toISOString(), offlineGrace: this.mem.lastError === 'offline' } : null,
      terms: { version: T.VERSION, accepted: this.termsAccepted(), record: this.termsRecord() },
      signin: si ? { state: si.state, userCode: si.userCode, verificationUri: si.verificationUri, expiresAt: si.expiresAt ? new Date(si.expiresAt).toISOString() : null, error: si.error || null } : null,
      vault: vs ? { state: vs.state, protection: vs.protection || null } : null, error: this.mem.lastError && this.mem.lastError !== 'offline' ? this.mem.lastError : null,
    };
  }
  _changed() { try { this.emit('status', this.status()); } catch { /* window gone */ } this.ensureBuiltins(); }
  // As soon as access is granted (stage 'ready'), on every start: the connectors that ship with Mayfair are registered with the manager (copy only), then,
  // because the Terms are accepted at that stage, approved and switched on in-process and tested in the background (builtins.js). Safe to call any
  // number of times and from anywhere (status, every gated call, every change): each part happens once per run and nothing here waits on a test.
  ensureBuiltins() {
    if (!this.ghost || !this.ghost.manager || !this.ready()) return this.mem.builtins;
    if (!this.mem.builtins || (this.mem.builtins.error && this.now() - this.mem.builtinsErrAt > 30000)) {
      try { this.mem.builtins = registerBuiltins(this.ghost.manager); }
      catch (e) {
        this.mem.builtins = { modules: [], security: [], summary: { registered: 0, updated: 0, unchanged: 0, failed: 1 }, error: e.message }; this.mem.builtinsErrAt = this.now();
        this._logWarn('builtins-register-failed', { reason: e.message });
      }
    }
    this._autoSetupBuiltins();
    return this.mem.builtins;
  }
  _logWarn(ev, f) { try { const l = this.ghost && this.ghost.log; if (l) l.warn(ev, f); } catch { /* logging never stops the app */ } }
  // The per-tool state the window shows (builtins.js BuiltinSetup). One instance per run; created even when automatic setup is off.
  _setup() {
    if (!this.mem.setup) {
      this.mem.setup = new BuiltinSetup({ manager: this.ghost.manager, log: this.ghost.log, vmPublished: this.vmPublished, onChange: () => this._builtinsChanged() });
    }
    return this.mem.setup;
  }
  _builtinsChanged() {
    if (this.mem.builtinsTimer) return;
    this.mem.builtinsTimer = setTimeout(() => { this.mem.builtinsTimer = null; try { this.emit('builtins', this._setup().status()); } catch { /* window gone */ } }, 120);
    if (this.mem.builtinsTimer.unref) this.mem.builtinsTimer.unref();
  }
  // After the Terms: approve and switch on the shipped lookups (synchronously, here), then the self-test runs in the background and only records.
  _autoSetupBuiltins() {
    if (!this.autoSetupOn || !this.ghost || !this.ghost.manager || !this.ready() || !this.termsAccepted()) return;
    const su = this._setup();
    if (su.phase !== 'idle') return;
    this.mem.autoSetup = su.start().then((r) => { this.mem.autoSetupResult = r; return r; });
  }
  ready() { return this.stage() === 'ready'; }
  _need(what) { if (!this.ready()) throw new AppError('not-ready', 'Finish the start steps first.'); this.ensureBuiltins(); return what; }
  canUse(module) { const e = this.entitlement(); return !!e && (e.operator || e.modules[module] === true); }
  _needModule(m) { this._need(); if (!this.canUse(m)) throw new AppError('module-off', 'This module is not switched on for your account.'); }

  // ---------- start flow ----------
  async _cloudGet(p) {
    if (!this.fetch) throw new AppError('offline', 'No network is available.');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await this.fetch(this.cloud + p, { headers: { accept: 'application/json' }, signal: ctl.signal, redirect: 'error' });
      const text = await res.text();
      if (text.length > 256 * 1024) throw new AppError('service', 'The answer from Mayfair was too large.');
      let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: res.status, json };
    } catch (e) { if (e instanceof AppError) throw e; throw new AppError('offline', 'Mayfair could not be reached. Check your connection and try again.'); }
    finally { clearTimeout(timer); }
  }
  // Step 1. Fetches the small component list (nothing is downloaded that needs approval: tools come later, after the entitlement), then writes the install record.
  async install() {
    if (this.installed()) return { ok: true, status: this.status() };
    const step = (phase, pct) => { try { this.emit('install', { phase, pct }); } catch { /* window gone */ } };
    try {
      step('Contacting Mayfair', 10);
      const r = await this._cloudGet('/ghost/index.json');
      let comps = [];
      if (r.status === 200 && isObj(r.json) && Array.isArray(r.json.components)) {
        comps = r.json.components.filter((c) => isObj(c) && /^[a-z0-9][a-z0-9-]{1,38}$/.test(c.id || '')).slice(0, 200).map((c) => ({ id: c.id, version: String(c.version || '').slice(0, 40), size: Number.isInteger(c.size) ? c.size : null, licence: String(c.licence || '').slice(0, 80) }));
      } else if (r.status !== 404) throw new AppError('service', 'Mayfair did not send the Ghost list. Try again in a moment.');
      step('Checking the list', 55);
      if (!this._vaultOk()) throw new AppError('vault-locked', 'The vault is locked.');
      step('Setting up Ghost on this computer', 85);
      fs.mkdirSync(this.dir, { recursive: true });
      atomic(this.installFile, JSON.stringify({ installed: true, version: this.version, installedAt: new Date(this.now()).toISOString(), components: comps }) + '\n');
      step('Done', 100); this.mem.lastError = null; this._changed();
      return { ok: true, status: this.status() };
    } catch (e) { return fail(e); }
  }
  async uninstall() {
    if (!this.installed()) return { ok: true, removed: false };
    const o = { type: 'question', title: 'Remove Mayfair Ghost', message: 'Remove Mayfair Ghost from this computer?', detail: 'Your cases stay in your encrypted vault. Your Terms acceptance stays on record. You can install Ghost again from the App Library.', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true };
    const win = this.getWindow();
    const r = !this.dialog ? { response: 1 } : win && !win.isDestroyed() ? await this.dialog.showMessageBox(win, o) : await this.dialog.showMessageBox(o);
    if (r.response !== 0) return { ok: true, removed: false };
    this.cancelSignin(); this._clearSession(); try { fs.rmSync(this.installFile, { force: true }); } catch { /* gone */ }
    this._changed(); return { ok: true, removed: true };
  }

  // Step 2. Mayfair ID device flow. The code is shown in the window; the sign-in page opens in the system browser (only on the Mayfair ID address).
  _openUrl(u) {
    try {
      const x = new URL(u); const idOrigin = new URL(this.id.base).origin;
      if (x.origin !== idOrigin || !(x.protocol === 'https:' || (this.allowLoopback && x.protocol === 'http:'))) return false;
      if (this.shell) this.shell.openExternal(x.href); return true;
    } catch { return false; }
  }
  async signInStart() {
    if (!this.installed()) return { ok: false, code: 'not-installed', error: 'Install Ghost first.' };
    if (!this._vaultOk()) return { ok: false, code: 'vault-locked', error: 'The vault is locked.' };
    this.cancelSignin();
    try {
      const d = await this.id.deviceStart('Mayfair Ghost');
      const si = { state: 'waiting', userCode: d.userCode, verificationUri: d.verificationUri, complete: d.verificationUriComplete, deviceCode: d.deviceCode, interval: d.interval, expiresAt: this.now() + d.expiresIn * 1000, cancelled: false, error: null };
      this.mem.signin = si; this.mem.lastError = null;
      this._openUrl(si.complete || si.verificationUri);
      this.polling = this._poll(si); this.polling.catch(() => {});
      this._changed(); return { ok: true, status: this.status() };
    } catch (e) { this.mem.lastError = e.message; this._changed(); return fail(e); }
  }
  openSignInPage() { const si = this.mem.signin; return !!si && si.state === 'waiting' && this._openUrl(si.complete || si.verificationUri); }
  async _poll(si) {
    let interval = Math.max(this.pollMinMs, si.interval * 1000);
    if (this.pollMinMs < 1000) interval = this.pollMinMs;
    while (!si.cancelled && this.mem.signin === si) {
      await new Promise((r) => setTimeout(r, interval));
      if (si.cancelled || this.mem.signin !== si) return;
      if (this.now() >= si.expiresAt) { si.state = 'expired'; si.error = 'The code ran out. Start again.'; this._changed(); return; }
      let r;
      try { r = await this.id.devicePoll(si.deviceCode); } catch (e) { if (e.code === 'offline') continue; si.state = 'error'; si.error = e.message; this._changed(); return; }
      if (r.state === 'pending') continue;
      if (r.state === 'slow') { interval += 2000; continue; }
      if (r.state === 'denied') { si.state = 'denied'; si.error = 'Sign-in was declined.'; this._changed(); return; }
      if (r.state === 'expired') { si.state = 'expired'; si.error = 'The code ran out. Start again.'; this._changed(); return; }
      if (r.state === 'ok') {
        let info = { sub: null, email: null, name: null };
        try { info = await this.id.userinfo(r.tokens.access); } catch { /* the account label is optional */ }
        this._saveSession({ ...r.tokens, sub: info.sub || 'unknown', email: info.email, name: info.name, at: this.now() });
        this.mem.signin = null; this.mem.ent = null; this.mem.entAt = 0; this.mem.lastError = null;
        this._changed();
        await this.checkEntitlement();
        return;
      }
    }
  }
  cancelSignin() { if (this.mem.signin) { this.mem.signin.cancelled = true; this.mem.signin = null; } this._changed(); return true; }
  signOut() { this.cancelSignin(); this._clearSession(); this.mem.lastError = null; this._changed(); return { ok: true, status: this.status() }; }

  async _accessToken() {
    this._load(); const s = this.mem.session; if (!s) throw new IdError('signed-out', 'You need to sign in.');
    if (s.expiresAt - 60000 > this.now()) return s.access;
    if (!s.refresh) { this._clearSession(); throw new IdError('signed-out', 'You need to sign in again.'); }
    if (!this.mem.refreshing) {
      this.mem.refreshing = (async () => {
        try { const t = await this.id.refresh(s.refresh); this._saveSession({ ...s, ...t, refresh: t.refresh || s.refresh }); return this.mem.session.access; }
        catch (e) { if (e.code === 'signed-out') this._clearSession(); throw e; }
        finally { this.mem.refreshing = null; }
      })();
    }
    return this.mem.refreshing;
  }
  // Step 3. GET the entitlement. A refusal from Mayfair takes effect at once; being unreachable keeps the last good answer for up to 72 hours.
  async checkEntitlement() {
    if (!this.installed()) return { ok: false, code: 'not-installed', error: 'Install Ghost first.' };
    this._load();
    this.mem.checking = true; this._changed();
    try {
      const token = await this._accessToken();
      let ent;
      try { ent = await this.id.entitlement(token); }
      catch (e) { if (e.code === 'signed-out') { const t2 = await this._accessTokenForce(); ent = await this.id.entitlement(t2); } else throw e; }
      this._saveEnt(ent); this.mem.lastError = null;
    } catch (e) {
      if (e.code === 'offline') { this.mem.lastError = 'offline'; }
      else if (e.code === 'signed-out') { this._clearSession(); this.mem.lastError = null; }
      else this.mem.lastError = e.message;
    } finally { this.mem.checking = false; this._changed(); }
    return { ok: true, status: this.status() };
  }
  async _accessTokenForce() { const s = this.mem.session; if (!s || !s.refresh) { this._clearSession(); throw new IdError('signed-out', 'You need to sign in again.'); } this.mem.session = { ...s, expiresAt: 0 }; return this._accessToken(); }
  // Called by the window every few minutes while open: re-asks when the last answer is old.
  async recheckIfDue() { if (this.stage() === 'ready' && this.now() - this.mem.entAt > ENT_RECHECK_MS) await this.checkEntitlement(); return this.status(); }
  openApply() { const e = this.mem.ent; const url = (e && e.applyUrl) || this.id.base + '/ghost/apply'; const ok = this._openUrl(url); return { ok, url }; }

  // Step 4. Terms: the text and its hash are fixed in terms-text.js; accepting records version, hash and time on this computer.
  termsGet() { return { version: T.VERSION, sha256: T.SHA256, clauses: T.CLAUSES, draftNotes: T.placeholders().length, accepted: this.termsAccepted(), record: this.termsRecord() }; }
  termsAccept(o) {
    const s = this.stage();
    if (s !== 'terms' && s !== 'ready') return { ok: false, code: 'not-ready', error: 'Finish the start steps first.' };
    if (!isObj(o) || o.version !== T.VERSION || o.sha256 !== T.SHA256 || o.lawful !== true) return { ok: false, code: 'terms', error: 'The Terms on screen are not the current ones. Reload and try again.' };
    atomic(this.termsFile, JSON.stringify({ version: T.VERSION, sha256: T.SHA256, acceptedAt: new Date(this.now()).toISOString(), account: this.mem.session ? this.mem.session.sub : null }) + '\n');
    this._changed(); return { ok: true, status: this.status() };
  }

  // ---------- connectors and jobs (the existing core, behind the gate) ----------
  _blocked(entry) { return BLOCKED.test([entry.id, entry.name, ...(entry.capabilities || [])].join(' ')); }
  connectorsList() {
    this._need(); const all = this.ghost.api()['ghost.connectors.list']();
    const keep = all.filter((c) => !this._blocked(c)); this.mem.hiddenConnectors = all.length - keep.length;
    return keep.map((c) => (c.scope === 'active' && !this.canUse('scanning') ? { ...c, gated: 'scanning' } : c));
  }
  connectorGet(id) { this._need(); const g = this.ghost.api()['ghost.connectors.get'](id); if (g && this._blocked(g)) return null; return g; }
  _conn(id) { const g = this.ghost.api()['ghost.connectors.get'](id); if (!g) throw new AppError('missing', 'That connector is not installed.'); if (this._blocked(g)) throw new AppError('blocked', 'Ghost does not run tools that look up individual people.'); return g; }
  async connectorAction(kind, id) {
    this._need(); const g = this._conn(id); const a = this.ghost.api();
    if (g.scope === 'active') this._needModule('scanning');
    if (kind === 'requestApproval') return a['ghost.connectors.requestApproval'](id);
    if (kind === 'enable') return a['ghost.connectors.enable'](id);
    if (kind === 'disable') return a['ghost.connectors.disable'](id);
    if (kind === 'test') { if (g.scope === 'active') throw new AppError('use-scope', 'Active tools are tested from the Active scanning module, with a declared target.'); return a['ghost.connectors.test'](id); }
    throw new AppError('bad-call', 'Unknown action.');
  }
  async jobRun(o) {
    this._need(); const g = this._conn(o.connector);
    if (g.scope === 'active') throw new AppError('use-scope', 'Active tools run only from the Active scanning module, with a declared target.');
    return this.ghost.api()['ghost.jobs.run']({ connector: o.connector, input: o.input });
  }
  jobGet(id) { this._need(); return this.ghost.api()['ghost.jobs.get'](id); }
  jobCancel(id) { this._need(); return this.ghost.api()['ghost.jobs.cancel'](id); }
  async pickFile() { this._need(); return this.ghost.api()['ghost.pickFile'](); }

  // ---------- the shipped tools and the master search ----------
  builtinsStatus() { this._need(); return this._setup().status(); }
  _search() {
    if (!this.mem.search) this.mem.search = new Search({ setup: this._setup(), manager: this.ghost.manager, runner: this.ghost.runner, picks: this.ghost.picks, log: this.ghost.log, now: this.now, blocked: (e) => this._blocked(e), emit: (n, p) => this.emit(n, p) });
    return this.mem.search;
  }
  searchClassify(o) { this._need(); return classify(o.query); }
  searchRun(o) { this._need(); return this._search().run(o); }
  searchCancel(o) { this._need(); return this._search().cancel(o.searchId); }

  // ---------- active scanning behind the light scope guard ----------
  scopeDeclare(o) { this._needModule('scanning'); return this.scope.declare(o); }
  scopeRevoke(id) { this._needModule('scanning'); return this.scope.revoke(id); }
  scopeActive() { this._need(); return this.scope.active(); }
  scopeLog(n) { this._need(); return { entries: this.scope.recent(n || 200), verify: this.scope.verify() }; }
  // Runs an active connector against the declared target. The page names the connector and the declaration; the target comes from the declaration, not from the page.
  async scanRun({ connector, scopeId, input = {} }) {
    this._needModule('scanning');
    const g = this._conn(connector);
    if (g.scope !== 'active') throw new AppError('not-active', 'That tool is not an active scanner.');
    const sc = this.scope.check(scopeId);
    const fields = (g.input && g.input.fields) || [], hostField = fields.find((f) => f.type === 'url-host');
    const inp = { ...input };
    if (hostField) {
      if (sc.kind === 'cidr') throw new AppError('one-host', 'This tool takes one host. Declare a single host or IP address.');
      if (inp[hostField.name] !== undefined && inp[hostField.name] !== sc.target) this.scope.check(scopeId, String(inp[hostField.name]));
      inp[hostField.name] = sc.target;
    }
    this.scope.log({ action: 'scan.start', scopeId, target: sc.target, connector, connectorVersion: g.version });
    const r = await this.ghost.api()['ghost.jobs.run']({ connector, input: inp, scope: { target: sc.target, confirmedAuthorised: true } });
    if (!r || r.ok === false) { this.scope.log({ action: 'scan.refused', scopeId, target: sc.target, connector, result: r && r.error || 'refused' }); return r; }
    this.ghost.runner.wait(r.jobId).then((job) => this.scope.log({ action: 'scan.end', scopeId, target: sc.target, connector, jobId: r.jobId, result: job && job.status || 'unknown' })).catch(() => {});
    return r;
  }

  // ---------- cases ----------
  casesList() { this._need(); return this.cases.list(); }
  caseGet(id) { this._need(); return this.cases.get(id); }
  casePut(id, json) { this._need(); return this.cases.put(id, json); }
  caseCreate(title) { this._need(); return this.cases.create(title); }
  caseDelete(id) { this._need(); const r = this.cases.delete(id); if (this.notes) { try { this.notes.deleteScope(id); } catch { /* none */ } } return r; }
  caseBackups(id) { this._need(); return this.cases.backups(id); }
  caseRestore(id, name) { this._need(); return this.cases.restore(id, name); }

  // ---------- look and feel ----------
  prefsGet() { this._need(); return this.prefs.get(); }
  prefsSet(o) { this._need(); return this.prefs.set(o); }

  // ---------- reports ----------
  async reportSave({ json, format, author, hide, notesTabs }) {
    this._need();
    let c; try { c = JSON.parse(json); } catch { throw new AppError('bad-case', 'The case could not be read.'); }
    const M = require('../../../ui/ghost/case-model'); const p = M.validate(c); if (p.length) throw new AppError('invalid', p[0]);
    const opts = { author, hide: hide || [], version: this.version, now: this.now() };
    if (Array.isArray(notesTabs) && notesTabs.length && this.notes) { const q = NR.build({ store: this.notes, caseId: c.id, tabs: notesTabs }); if (q) opts.quickNotes = q; }      // the Quick notes appendix: only the tabs the author chose
    const stamp = new Date(this.now()).toISOString().slice(0, 10), base = (String(c.title).replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'ghost-case') + '-' + stamp;
    let data, ext, filters;
    if (format === 'html') { data = Buffer.from(R.reportHtml(c, opts), 'utf8'); ext = 'html'; filters = [{ name: 'Web page', extensions: ['html'] }]; }
    else if (format === 'json') { data = Buffer.from(R.reportJson(c, opts), 'utf8'); ext = 'json'; filters = [{ name: 'JSON', extensions: ['json'] }]; }
    else if (format === 'pdf') { if (!this.electron) throw new AppError('unavailable', 'PDF needs the desktop app.'); data = await R.htmlToPdf(this.electron, R.reportHtml(c, opts)); ext = 'pdf'; filters = [{ name: 'PDF', extensions: ['pdf'] }]; }
    else throw new AppError('bad-format', 'Choose HTML, PDF or JSON.');
    if (!this.dialog) throw new AppError('unavailable', 'No file dialog is available.');
    const win = this.getWindow();
    const o = { title: 'Save report', defaultPath: base + '.' + ext, filters };
    const s = win && !win.isDestroyed() ? await this.dialog.showSaveDialog(win, o) : await this.dialog.showSaveDialog(o);
    if (s.canceled || !s.filePath) return { saved: false };
    fs.writeFileSync(s.filePath, data, { mode: 0o600 });
    this.scope && this.scope.log({ action: 'export', format: ext, caseId: c.id, bytes: data.length });
    return { saved: true, name: path.basename(s.filePath), bytes: data.length };
  }

  // ---------- case file (JSON): save the open case to a file, pick one to import or merge ----------
  async caseExportJson(json) {
    this._need();
    let c; try { c = JSON.parse(json); } catch { throw new AppError('bad-case', 'The case could not be read.'); }
    const M = require('../../../ui/ghost/case-model'); const p = M.validate(c); if (p.length) throw new AppError('invalid', p[0]);
    if (!this.dialog) throw new AppError('unavailable', 'No file dialog is available.');
    const stamp = new Date(this.now()).toISOString().slice(0, 10), base = (String(c.title).replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'ghost-case') + '-' + stamp;
    const win = this.getWindow(), o = { title: 'Save case file', defaultPath: base + '.ghost-case.json', filters: [{ name: 'Ghost case (JSON)', extensions: ['json'] }] };
    const s = win && !win.isDestroyed() ? await this.dialog.showSaveDialog(win, o) : await this.dialog.showSaveDialog(o);
    if (s.canceled || !s.filePath) return { saved: false };
    const data = Buffer.from(M.exportJson(c), 'utf8');
    fs.writeFileSync(s.filePath, data, { mode: 0o600 });
    this.scope && this.scope.log({ action: 'export', format: 'case-json', caseId: c.id, bytes: data.length });
    return { saved: true, name: path.basename(s.filePath), bytes: data.length };
  }
  // The person picks a case file; main reads it (size capped) and hands the text to the page, which checks and merges it with the same model code.
  async caseImportPick() {
    this._need();
    if (!this.dialog) throw new AppError('unavailable', 'No file dialog is available.');
    const win = this.getWindow(), o = { title: 'Choose a case file', properties: ['openFile'], filters: [{ name: 'Ghost case (JSON)', extensions: ['json'] }] };
    const s = win && !win.isDestroyed() ? await this.dialog.showOpenDialog(win, o) : await this.dialog.showOpenDialog(o);
    if (s.canceled || !s.filePaths || !s.filePaths[0]) return { picked: false };
    const f = s.filePaths[0], st = fs.statSync(f);
    if (!st.isFile() || st.size > require('./cases').MAX_BYTES) throw new AppError('too-large', 'That file is not a case file Ghost can read.');
    return { picked: true, name: path.basename(f), text: fs.readFileSync(f, 'utf8') };
  }

  // ---------- the rest ----------
  async terminalOpen(o) { this._need(); return { ok: await this.openTerminal(o || {}) }; }
  async toolPage() { this._need(); return { ok: await this.openToolIntegrations() }; }
  async vaultUnlock(o) { const r = await this.ghost.api()['ghost.vault.unlock'](o); this.mem.loaded = false; this._changed(); return { ok: r.ok, error: r.error, status: this.status() }; }
  shutdown() { this.cancelSignin(); if (this.mem.builtinsTimer) { clearTimeout(this.mem.builtinsTimer); this.mem.builtinsTimer = null; } if (this.mem.setup) this.mem.setup.stop(); if (this.mem.search) this.mem.search.shutdown(); }
}

module.exports = { GhostApp, AppError, fail, BLOCKED, ENT_GRACE_MS, ENT_RECHECK_MS, CLOUD };
