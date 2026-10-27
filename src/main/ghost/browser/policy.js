'use strict';
// Ghost investigation browser: egress policy (pure, no Electron).
// A module declares the hosts it may reach. Everything else is blocked, and every block is recorded where the person can see it.
// Some destinations can never be allowed (this computer, the local network, cloud metadata addresses, non-web schemes).
const CASE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const CASE_ID = { test: (v) => typeof v === 'string' && CASE_RE.test(v) };
const HOST_PATTERN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/;
const MAX_HOSTS = 64, MAX_BLOCKS = 200;
const WEB = new Set(['http:', 'https:', 'ws:', 'wss:']);
const INLINE = new Set(['data:', 'blob:']);          // no network; allowed for sub-resources only

function ipv4(h) { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h); return m ? m.slice(1).map(Number) : null; }
function privateV4(a) {
  const [x, y] = a;
  return x === 0 || x === 10 || x === 127 || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) || (x === 192 && y === 0) || (x === 198 && (y === 18 || y === 19)) || x >= 224;
}
// IPv6 literal (without brackets): loopback, unspecified, unique-local, link-local, mapped IPv4, anything else we cannot classify is refused.
function privateV6(h) {
  const s = h.toLowerCase();
  if (s === '::1' || s === '::') return true;
  const mapped = /^::ffff:(.+)$/.exec(s);
  if (mapped) { const v = ipv4(mapped[1]); if (v) return privateV4(v); return true; }   // hex-form mapped addresses are refused
  if (/^f[cd]/.test(s) || /^fe[89ab]/.test(s) || /^ff/.test(s)) return true;
  return false;
}
// Returns '' when the host may ever be reached, else the plain reason it never can.
function neverReason(host) {
  const h = String(host).replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!h) return 'No host in the address.';
  if (h.includes(':')) return privateV6(h) ? 'This is a local or private network address.' : '';
  const v = ipv4(h);
  if (v) return v.some((n) => n > 255) || privateV4(v) ? 'This is a local or private network address.' : '';
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa') || !h.includes('.')) return 'This is a local network name.';
  return '';
}
const hostMatches = (pattern, host) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1 : host === pattern);

function validateModule(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('A module declaration is an object.');
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(m.id || '')) throw new Error('Module id must be 1 to 40 characters of a-z, 0-9 and -.');
  if (typeof m.name !== 'string' || !m.name || m.name.length > 80) throw new Error('Module needs a name of up to 80 characters.');
  if (m.scope === 'active') throw new Error('Active scanning connectors do not use the browser and are never routed through it.');
  if (!Array.isArray(m.hosts) || m.hosts.length > MAX_HOSTS) throw new Error('Module hosts must be a list of up to ' + MAX_HOSTS + ' entries.');
  const hosts = m.hosts.map((x) => String(x).toLowerCase());
  for (const h of hosts) {
    if (!HOST_PATTERN.test(h)) throw new Error('Not a valid host pattern: ' + h);
    const bare = h.replace(/^\*\./, '');
    if (bare.split('.').length < 2 || neverReason(bare)) throw new Error('Pattern is too broad or not reachable: ' + h);
    if (/^\*\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(h)) throw new Error('Pattern is too broad: ' + h);
  }
  return { id: m.id, name: m.name, hosts: [...new Set(hosts)] };
}

class EgressPolicy {
  // onBlock(entry): called for each blocked request so the window can show it. now(): clock.
  constructor({ onBlock = () => {}, now = Date.now } = {}) {
    this.modules = new Map(); this.cases = new Map(); this.onBlock = onBlock; this.now = now;
  }
  declare(m) { const v = validateModule(m); this.modules.set(v.id, v); return v; }
  // A case window is bound to one module; the person can add hosts for that case only (never the never-list).
  bindCase(caseId, moduleId) {
    if (!CASE_ID.test(caseId)) throw new Error('Bad case id.');
    const m = this.modules.get(moduleId); if (!m) throw new Error('Unknown module.');
    if (!this.cases.has(caseId)) this.cases.set(caseId, { module: m.id, extra: new Set(), blocked: [], blockedCount: 0, grants: [] });
    return this.cases.get(caseId);
  }
  forget(caseId) { this.cases.delete(caseId); }
  allowHost(caseId, host) {
    const c = this.cases.get(caseId); if (!c) throw new Error('No such case window.');
    const h = String(host).toLowerCase().replace(/\.$/, '');
    const bad = neverReason(h); if (bad) throw new Error(bad + ' It cannot be allowed.');
    if (!HOST_PATTERN.test(h) && !ipv4(h)) throw new Error('Not a valid host.');
    c.extra.add(h); c.grants.push({ t: this.now(), host: h });
    return this.allowed(caseId);
  }
  revokeHost(caseId, host) { const c = this.cases.get(caseId); if (c) c.extra.delete(String(host).toLowerCase()); return this.allowed(caseId); }
  allowed(caseId) { const c = this.cases.get(caseId); if (!c) return []; return [...this.modules.get(c.module).hosts, ...c.extra]; }
  grants(caseId) { const c = this.cases.get(caseId); return c ? c.grants.slice() : []; }
  blocked(caseId) { const c = this.cases.get(caseId); return c ? c.blocked.slice() : []; }
  blockedCount(caseId) { const c = this.cases.get(caseId); return c ? c.blockedCount : 0; }
  // kind: 'top' (the page the person navigated to) or 'sub' (anything a page loads). Returns {allow, reason?}.
  decide(caseId, url, kind = 'sub') {
    const c = this.cases.get(caseId);
    let u; try { u = new URL(url); } catch { return this._block(c, caseId, String(url).slice(0, 80), '', kind, 'Not a valid address.', false); }
    if (u.protocol === 'about:' && u.href === 'about:blank') return { allow: true };
    if (INLINE.has(u.protocol)) return kind === 'sub' ? { allow: true } : this._block(c, caseId, u.protocol, '', kind, 'Pages cannot be opened from this kind of address.', false);
    if (!WEB.has(u.protocol)) return this._block(c, caseId, u.protocol + '//', '', kind, 'Only web addresses are allowed in the investigation browser.', false);
    if (u.username || u.password) return this._block(c, caseId, u.origin, u.hostname, kind, 'Addresses with a name or password in them are refused.', false);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    const never = neverReason(host);
    if (never) return this._block(c, caseId, u.origin + u.pathname, host, kind, never, false);
    if (!c) return this._block(c, caseId, u.origin + u.pathname, host, kind, 'No case is open for this window.', false);
    const ok = this.allowed(caseId).some((p) => hostMatches(p, host));
    if (ok) return { allow: true };
    return this._block(c, caseId, u.origin + u.pathname, host, kind, 'Not declared for this case.', true);
  }
  _block(c, caseId, shown, host, kind, reason, canAllow) {
    // Queries and fragments are not stored: they often hold tokens.
    const e = { t: this.now(), url: String(shown).slice(0, 300), host, kind, reason, canAllow };
    if (c) { c.blockedCount++; c.blocked.push(e); if (c.blocked.length > MAX_BLOCKS) c.blocked.shift(); }
    try { this.onBlock(caseId, e); } catch { /* the window may be gone */ }
    return { allow: false, reason, canAllow, host };
  }
}

// Active scanning connectors bypass the browser: they run from the connector runner and are never put on a Tor route.
function connectorRoute(manifest) {
  const active = !!manifest && manifest.scope === 'active';
  return { viaBrowser: false, viaTor: false, note: active ? 'Active scanners connect directly from this computer. They are never sent over Tor, and the scope guard and audit log apply.' : 'Connectors run outside the investigation browser and do not use its route.' };
}

module.exports = { EgressPolicy, validateModule, neverReason, hostMatches, connectorRoute, CASE_ID };
