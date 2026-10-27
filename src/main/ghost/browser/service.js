'use strict';
// Ghost investigation browser: the service. Electron objects and the window factory are handed in so every rule here is testable.
//  - One partition per case, named at random, never "persist:": nothing reaches disk and nothing touches the normal browser profile.
//  - Route: Tor by default (Ghost's own Tor process). Direct with DNS over HTTPS only when the person says so in a native dialog.
//  - Egress: policy.js decides every request; blocks are kept and shown.
//  - Kill switch: close every case window, wipe every case partition, stop Tor (drops circuits), lock the vault.
const crypto = require('node:crypto');
const { EgressPolicy, CASE_ID } = require('./policy');
const route = require('./route');
const FP = require('./fingerprint');
const cap = require('./capture');

const PARTITION_PREFIX = 'mf-ghost-case-';
const OPEN_WEB = { id: 'open-web', name: 'Open web investigation', hosts: [] };   // nothing declared: every site is one the person allows for the case

class GhostBrowserService {
  // electron: { app, session }. tor: a TorManager. vault: () => the open Vault or null. makeWindow(rec, hooks) -> handle. confirm(opts) -> bool.
  constructor({ electron, tor, vault = () => null, makeWindow, confirm = async () => false, restoreResolver = async () => {}, chromeVersion = process.versions.chrome, emit = () => {}, now = Date.now, provider = 'cloudflare' }) {
    this.electron = electron; this.tor = tor; this.vault = vault; this.makeWindow = makeWindow; this.confirm = confirm; this.restoreResolver = restoreResolver;
    this.chromeVersion = chromeVersion; this.emit = emit; this.now = now; this.provider = provider;
    this.cases = new Map();
    this.policy = new EgressPolicy({ now, onBlock: (caseId, e) => this._pushState(caseId, { block: e }) });
    this.policy.declare(OPEN_WEB);
    this.resolverChanged = false;
    if (tor && tor.on) tor.on('state', () => { for (const id of this.cases.keys()) this._pushState(id); });
  }
  declareModule(m) { return this.policy.declare(m); }

  // ---- opening -----------------------------------------------------------------------------------------------------------------
  async open({ caseId, name = '', module: moduleId = 'open-web', url = '', route: want = 'tor', directConfirmed = false } = {}) {
    if (!CASE_ID.test(caseId)) return { ok: false, code: 'bad-input', error: 'Case id must be 1 to 40 letters, digits, - or _.' };
    if (!this.policy.modules.has(moduleId)) return { ok: false, code: 'bad-input', error: 'Unknown module.' };
    if (!route.MODES.includes(want)) return { ok: false, code: 'bad-input', error: 'Unknown route.' };
    const existing = this.cases.get(caseId);
    if (existing) { existing.handle.focus(); if (url) await this.navigate(caseId, url); return { ok: true, reused: true, status: this.status(caseId) }; }
    let socksPort = 0;
    if (want === 'tor') {
      try { socksPort = await this.tor.start(); } catch (e) {
        return { ok: false, code: 'tor-unavailable', canFallback: true, error: (e && e.message) || 'Tor did not connect.' };   // never silently falls back
      }
    } else if (!directConfirmed) {
      const yes = await this.confirm({ kind: 'direct', title: 'Connect without Tor?', message: 'This case window will connect directly from your computer.', detail: 'Websites and your network will see your real IP address. Name lookups go to one encrypted DNS server (DNS over HTTPS) instead of your own resolver. Use Tor if you can.', ok: 'Connect directly', cancel: 'Cancel' });
      if (!yes) return { ok: false, code: 'declined', error: 'Cancelled.' };
    }
    const plan = route.plan({ mode: want, socksPort, provider: this.provider });
    const partition = PARTITION_PREFIX + crypto.randomBytes(8).toString('hex');
    const ses = this.electron.session.fromPartition(partition, { cache: false });
    const rec = { id: caseId, name: String(name || caseId).slice(0, 80), module: moduleId, partition, session: ses, plan, handle: null, closing: false };
    try {
      this.policy.bindCase(caseId, moduleId);
      await route.apply({ session: ses, app: this.electron.app, plan });
      if (plan.mode === 'direct-doh') this.resolverChanged = true;
      this._lockSession(ses, rec);
    } catch (e) {
      this.policy.forget(caseId); await this._wipe(ses);
      return { ok: false, code: 'route-failed', error: e.message };
    }
    this.cases.set(caseId, rec);
    rec.handle = this.makeWindow(rec, {
      policy: this.policy,
      fingerprintCommands: () => FP.cdpCommands(this.chromeVersion),
      onClosed: () => this._closed(caseId),
      onState: () => this._pushState(caseId),
      status: () => this.status(caseId),
    });
    if (url) await this.navigate(caseId, url);
    this._pushState(caseId);
    return { ok: true, status: this.status(caseId) };
  }

  // Session rules: every request goes through the policy; headers are fixed; no permissions; no downloads; no devices.
  _lockSession(ses, rec) {
    const fp = FP.FIXED, ua = FP.userAgent(this.chromeVersion);
    ses.setUserAgent(ua, fp.acceptLanguage);
    if (ses.setPermissionRequestHandler) ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    if (ses.setPermissionCheckHandler) ses.setPermissionCheckHandler(() => false);
    if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
    if (ses.setSpellCheckerEnabled) ses.setSpellCheckerEnabled(false);
    ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (d, cb) => {
      const kind = d.resourceType === 'mainFrame' ? 'top' : 'sub';
      cb({ cancel: !this.policy.decide(rec.id, d.url, kind).allow });
    });
    ses.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (d, cb) => {
      const h = { ...d.requestHeaders };
      for (const k of Object.keys(h)) if (/^(user-agent|accept-language)$/i.test(k)) delete h[k];
      h['User-Agent'] = ua; h['Accept-Language'] = fp.acceptLanguage;
      for (const k of Object.keys(h)) if (/^referer$/i.test(k)) { try { h[k] = new URL(h[k]).origin + '/'; } catch { delete h[k]; } }   // origin only
      cb({ requestHeaders: h });
    });
    if (ses.on) ses.on('will-download', (e) => { e.preventDefault(); this._pushState(rec.id, { notice: 'Downloads are off in the investigation browser. Use Capture to keep a page.' }); });
  }

  async navigate(caseId, url) {
    const rec = this.cases.get(caseId); if (!rec) return { ok: false, code: 'no-case', error: 'No such case window.' };
    let u = String(url || '').trim();
    if (u && !/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
    const d = this.policy.decide(caseId, u, 'top');
    if (!d.allow) return { ok: false, code: 'blocked', error: d.reason, host: d.host, canAllow: d.canAllow };
    rec.handle.load(u);
    return { ok: true };
  }
  allowHost(caseId, host) {
    if (!this.cases.has(caseId)) return { ok: false, code: 'no-case', error: 'No such case window.' };
    try { const allowed = this.policy.allowHost(caseId, host); this._pushState(caseId); return { ok: true, allowed }; } catch (e) { return { ok: false, code: 'refused', error: e.message }; }
  }

  // ---- state -------------------------------------------------------------------------------------------------------------------
  status(caseId) {
    const rec = this.cases.get(caseId); if (!rec) return null;
    const v = this.vault();
    return {
      ...route.chip({ plan: rec.plan, tor: this.tor && this.tor.state, caseName: rec.name }),
      caseId, module: rec.module, allowed: this.policy.allowed(caseId), blockedCount: this.policy.blockedCount(caseId), blocked: this.policy.blocked(caseId).slice(-50),
      vault: v ? (v.unlocked ? 'unlocked' : 'locked') : 'unavailable', limits: FP.LIMITS,
      nav: rec.handle && rec.handle.nav ? rec.handle.nav() : null,
    };
  }
  _pushState(caseId, extra) { const s = this.status(caseId); if (s) this.emit('state', { ...s, ...(extra || {}) }); }

  // ---- capture -----------------------------------------------------------------------------------------------------------------
  async capture(caseId) {
    const rec = this.cases.get(caseId); if (!rec) return { ok: false, code: 'no-case', error: 'No such case window.' };
    try {
      const s = this.status(caseId);
      const meta = await cap.capturePage({ wc: rec.handle.wc, vault: this.vault(), caseId, now: this.now, ctx: { route: s.route, dns: s.dns, exposesIp: s.exposesIp, allowedHosts: s.allowed, blockedCount: s.blockedCount } });
      return { ok: true, snapshot: meta };
    } catch (e) { return { ok: false, code: e.code || 'error', error: e.message }; }
  }
  snapshots(caseId) { try { return { ok: true, snapshots: cap.listSnapshots({ vault: this.vault(), caseId }) }; } catch (e) { return { ok: false, code: e.code || 'error', error: e.message }; } }

  // ---- closing and the kill switch ---------------------------------------------------------------------------------------------
  async _wipe(ses) {
    for (const f of [() => ses.clearStorageData(), () => ses.clearCache(), () => ses.clearAuthCache(), () => ses.clearHostResolverCache && ses.clearHostResolverCache(), () => ses.closeAllConnections()]) { try { await f(); } catch { /* best effort */ } }
  }
  async _closed(caseId) {
    const rec = this.cases.get(caseId); if (!rec) return;
    this.cases.delete(caseId); this.policy.forget(caseId);
    await this._wipe(rec.session);
    await this._maybeRelease();
  }
  async _maybeRelease() {
    if (![...this.cases.values()].some((r) => r.plan.mode === 'tor') && this.tor) { try { this.tor.stop(); } catch { /* stopped */ } }
    if (this.resolverChanged && ![...this.cases.values()].some((r) => r.plan.mode === 'direct-doh')) { this.resolverChanged = false; try { await this.restoreResolver(); } catch { /* ignore */ } }
  }
  async close(caseId) { const rec = this.cases.get(caseId); if (!rec) return { ok: false, code: 'no-case', error: 'No such case window.' }; rec.closing = true; rec.handle.close(); await this._closed(caseId); return { ok: true }; }

  // One action. Order matters: windows first so nothing is loading, then data, then the route, then the key.
  async kill() {
    const recs = [...this.cases.values()];
    const report = { windows: recs.length, wiped: 0, tor: false, vaultLocked: false, resolverRestored: false };
    for (const r of recs) { r.closing = true; try { r.handle.close(); } catch { /* gone */ } }
    for (const r of recs) { await this._wipe(r.session); report.wiped++; this.cases.delete(r.id); this.policy.forget(r.id); }
    if (this.tor) { try { this.tor.stop(); report.tor = true; } catch { /* stopped */ } }
    if (this.resolverChanged) { this.resolverChanged = false; try { await this.restoreResolver(); report.resolverRestored = true; } catch { /* ignore */ } }
    const v = this.vault(); if (v) { try { v.lock(); report.vaultLocked = !v.unlocked; } catch { /* locked already */ } }
    this.emit('killed', report);
    return { ok: true, report };
  }
  shutdown() { return this.kill(); }
}

module.exports = { GhostBrowserService, PARTITION_PREFIX, OPEN_WEB };
