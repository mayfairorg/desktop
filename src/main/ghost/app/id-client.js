'use strict';
// Ghost: a small client for the Mayfair ID service (the OpenID provider on https://mayfairmail.com).
//  - sign in with the device flow (RFC 8628, the way desktop apps use Mayfair ID): start, poll, refresh
//  - GET the Ghost entitlement with the access token
// Only the issuer's own address is ever called (discovery may not point anywhere else). Responses are size-capped, calls time out, and nothing
// from the service is shown without being reduced to known fields. `fetch` is passed in so tests run against a local mock and never the network.
const ISSUER = 'https://mayfairmail.com';
const CLIENT_ID = 'mayfair-ghost';
const SCOPE = 'openid profile email offline_access';
const GRANT_DEVICE = 'urn:ietf:params:oauth:grant-type:device_code';
const ENTITLEMENT_PATH = '/api/ghost/entitlement';
const APPLY_URL = ISSUER + '/ghost/apply';
const MAX_BODY = 64 * 1024;
const MODULES = ['scanning', 'geolocation'];          // modules that are off until an operator switches them on for the account

class IdError extends Error { constructor(code, message, extra) { super(message); this.code = code; Object.assign(this, extra || {}); } }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const strOrNull = (v, n) => (typeof v === 'string' && v.length <= n ? v : null);

// Reduces what the service sent to the fields Ghost uses. Anything unexpected means "not approved".
function normalizeEntitlement(raw, { now = Date.now(), issuer = ISSUER } = {}) {
  const e = isObj(raw) ? raw : {};
  const known = ['approved', 'none', 'pending', 'rejected', 'revoked', 'expired'];
  let status = known.includes(e.status) ? e.status : (e.approved === true ? 'approved' : 'none');
  const operator = e.operator === true;
  const expiresAt = typeof e.expiresAt === 'string' && Number.isFinite(Date.parse(e.expiresAt)) ? new Date(Date.parse(e.expiresAt)).toISOString() : null;
  if (operator) status = 'approved';
  else if (status === 'approved' && expiresAt && Date.parse(expiresAt) <= now) status = 'expired';
  const modules = {};
  const given = isObj(e.modules) ? e.modules : {};
  for (const m of MODULES) modules[m] = operator ? true : (status === 'approved' && given[m] === true);
  let applyUrl = issuer + '/ghost/apply';
  try { const u = new URL(String(e.applyUrl || '')); if (u.origin === issuer && u.protocol === 'https:') applyUrl = u.origin + u.pathname; } catch { /* keep the default */ }
  return { status, approved: status === 'approved', operator, expiresAt: operator ? null : expiresAt, modules, applyUrl, note: strOrNull(e.note, 300) };
}

class IdClient {
  // base: the issuer. Anything but https://mayfairmail.com is refused unless `allowLoopback` (tests and the screenshot run) and the address is http://127.0.0.1 (a local stand-in)
  constructor({ base = ISSUER, fetchImpl = (typeof fetch === 'function' ? fetch : null), allowLoopback = false, clientId = CLIENT_ID, timeoutMs = 15000, now = Date.now } = {}) {
    const b = String(base).replace(/\/+$/, '');
    const ok = b === ISSUER || (allowLoopback && /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(b));
    if (!ok) throw new IdError('bad-base', 'The Mayfair ID address is not allowed.');
    this.base = b; this.fetch = fetchImpl; this.clientId = clientId; this.timeoutMs = timeoutMs; this.now = now; this.doc = null;
    this.applyUrlDefault = b + '/ghost/apply';
  }
  async _call(url, { method = 'GET', headers = {}, body } = {}) {
    if (!this.fetch) throw new IdError('offline', 'No network is available.');
    if (new URL(url).origin !== new URL(this.base).origin) throw new IdError('bad-url', 'Refused to call another address.');
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res;
    try { res = await this.fetch(url, { method, headers: { accept: 'application/json', ...headers }, body, signal: ctl.signal, redirect: 'error' }); }
    catch (e) { throw new IdError('offline', 'Mayfair could not be reached.'); }
    finally { clearTimeout(timer); }
    let text = ''; try { text = await res.text(); } catch { throw new IdError('offline', 'Mayfair could not be reached.'); }
    if (text.length > MAX_BODY) throw new IdError('too-large', 'The answer from Mayfair was too large.');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, json };
  }
  async discover() {
    if (this.doc) return this.doc;
    const r = await this._call(this.base + '/.well-known/openid-configuration');
    if (r.status !== 200 || !isObj(r.json)) throw new IdError('service', 'Mayfair ID did not answer correctly.', { status: r.status });
    const pick = (k) => { const u = r.json[k]; if (typeof u !== 'string') throw new IdError('service', 'Mayfair ID did not describe itself fully.'); if (new URL(u).origin !== new URL(this.base).origin) throw new IdError('service', 'Mayfair ID pointed somewhere unexpected.'); return u; };
    this.doc = { device: pick('device_authorization_endpoint'), token: pick('token_endpoint'), userinfo: pick('userinfo_endpoint') };
    return this.doc;
  }
  _form(o) { return Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
  async deviceStart(deviceName = 'Mayfair Ghost') {
    const d = await this.discover();
    const r = await this._call(d.device, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: this._form({ client_id: this.clientId, scope: SCOPE, device_name: deviceName }) });
    const j = r.json;
    if (r.status !== 200 || !isObj(j) || typeof j.device_code !== 'string' || typeof j.user_code !== 'string' || typeof j.verification_uri !== 'string') {
      const code = isObj(j) && j.error === 'unauthorized_client' ? 'not-registered' : r.status === 429 ? 'busy' : 'service';
      throw new IdError(code, code === 'not-registered' ? 'This app is not switched on for sign-in yet.' : code === 'busy' ? 'Too many sign-in attempts. Wait a minute and try again.' : 'Sign-in could not be started.', { status: r.status });
    }
    const origin = new URL(this.base).origin;
    const safe = (u) => { try { const x = new URL(u); return x.origin === origin ? x.href : null; } catch { return null; } };
    return { deviceCode: j.device_code, userCode: String(j.user_code).slice(0, 20), verificationUri: safe(j.verification_uri) || origin + '/oauth/device', verificationUriComplete: safe(j.verification_uri_complete), interval: Math.min(30, Math.max(2, Number(j.interval) || 5)), expiresIn: Math.min(1800, Math.max(30, Number(j.expires_in) || 600)) };
  }
  _tokens(j) {
    if (!isObj(j) || typeof j.access_token !== 'string' || !j.access_token) throw new IdError('service', 'Mayfair ID sent no access token.');
    return { access: j.access_token, refresh: typeof j.refresh_token === 'string' ? j.refresh_token : null, expiresAt: this.now() + Math.max(30, Number(j.expires_in) || 900) * 1000 };
  }
  // -> { state:'pending'|'slow'|'denied'|'expired'|'ok', tokens? }
  async devicePoll(deviceCode) {
    const d = await this.discover();
    const r = await this._call(d.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: this._form({ grant_type: GRANT_DEVICE, device_code: deviceCode, client_id: this.clientId }) });
    if (r.status === 200) return { state: 'ok', tokens: this._tokens(r.json) };
    const err = isObj(r.json) ? r.json.error : '';
    if (err === 'authorization_pending') return { state: 'pending' };
    if (err === 'slow_down') return { state: 'slow' };
    if (err === 'access_denied') return { state: 'denied' };
    if (err === 'expired_token' || err === 'invalid_grant') return { state: 'expired' };
    if (r.status === 429) return { state: 'slow' };
    throw new IdError('service', 'Sign-in could not be completed.', { status: r.status });
  }
  // Refresh tokens rotate: the caller must store the new one before using the new access token.
  async refresh(refreshToken) {
    const d = await this.discover();
    const r = await this._call(d.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: this._form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.clientId }) });
    if (r.status === 200) return this._tokens(r.json);
    if (r.status === 400 || r.status === 401) throw new IdError('signed-out', 'You need to sign in again.');
    throw new IdError('service', 'The sign-in could not be renewed.', { status: r.status });
  }
  async userinfo(access) {
    const d = await this.discover();
    const r = await this._call(d.userinfo, { headers: { authorization: 'Bearer ' + access } });
    if (r.status === 401) throw new IdError('signed-out', 'You need to sign in again.');
    if (r.status !== 200 || !isObj(r.json)) throw new IdError('service', 'Account details could not be read.', { status: r.status });
    return { sub: strOrNull(r.json.sub, 200), email: strOrNull(r.json.email, 254), name: strOrNull(r.json.name, 200) || strOrNull(r.json.preferred_username, 100) };
  }
  // GET the Ghost entitlement for the signed-in account.
  async entitlement(access) {
    const r = await this._call(this.base + ENTITLEMENT_PATH, { headers: { authorization: 'Bearer ' + access } });
    if (r.status === 401) throw new IdError('signed-out', 'You need to sign in again.');
    if (r.status === 404) return normalizeEntitlement({ status: 'none' }, { now: this.now(), issuer: this.base });      // an account that has never applied
    if (r.status !== 200 || !isObj(r.json)) throw new IdError('service', 'Your access could not be checked.', { status: r.status });
    return normalizeEntitlement(r.json, { now: this.now(), issuer: this.base });
  }
}

module.exports = { IdClient, IdError, normalizeEntitlement, ISSUER, CLIENT_ID, SCOPE, ENTITLEMENT_PATH, APPLY_URL, MODULES };
