'use strict';
// Mayfair Ghost passive modules: shared core. One small HTTPS client that every module uses for every request, and the helpers that
// turn a module's findings into result lines (the schema in ../../result.js). Nothing here knows about a particular service.
//
// The client enforces, before any request leaves the process: https only, no credentials in the address, port 443, an exact host
// allowlist (plus hosts a module adds after reading a registry's own bootstrap file), the optional Ghost egress hook, a per-host rate
// limit, a request cap per run, a response size cap, a timeout and manual, re-checked redirects. Failures are classified so a module can
// say honestly what happened: unavailable, rate-limited, blocked, bad-response.
const { isIP } = require('node:net');

const EXIT = { ok: 0, badInput: 2, badResponse: 76, unavailable: 69, rateLimited: 75, blocked: 77, internal: 70 };
const KIND_EXIT = { 'bad-input': EXIT.badInput, 'bad-response': EXIT.badResponse, unavailable: EXIT.unavailable, 'rate-limited': EXIT.rateLimited, blocked: EXIT.blocked };

class ModuleError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); }
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const isDnsName = (h) => typeof h === 'string' && HOST_RE.test(h) && !isIP(h) && !/^\d+$/.test(h.split('.').pop());

// createClient: every option is injectable so tests never touch the network.
//   fetch: WHATWG fetch. egress: optional async ({url, host, module, purpose}) => true | false | {allow:false, reason}: the Ghost egress policy hook.
//   hosts: exact https host allowlist. dynamic: true lets the module call allow(host) for hosts named by a registry bootstrap file.
function createClient({ fetch = globalThis.fetch, egress = null, module = 'module', hosts = [], dynamic = false, ownAllowed = false, rps = 1, timeoutMs = 15000, maxBytes = 1048576, maxRequests = 20, userAgent = 'MayfairGhost/1', sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const allowed = new Set(hosts.map((h) => h.toLowerCase()));
  const last = new Map();
  const state = { requests: 0, rateLimited: false, unreachable: false, hosts: new Set() };
  const gap = rps > 0 ? Math.ceil(1000 / rps) : 0;

  function allow(host) {
    if (!dynamic) throw new ModuleError('blocked', 'this module cannot add hosts');
    const h = String(host).toLowerCase();
    if (!isDnsName(h)) throw new ModuleError('blocked', 'refused host name from a registry file: ' + String(host).slice(0, 80));
    allowed.add(h);
  }
  // allowOwn: for a connector that talks to an instance the user named (their own server). Any host is accepted, but plain http only for
  // this computer or a private network address, and never for link-local addresses (cloud metadata services).
  const ownPlain = new Set(), ownPorts = new Map();
  function allowOwn(url) {
    if (!ownAllowed) throw new ModuleError('blocked', 'this module cannot connect to an instance address');
    let u;
    try { u = new URL(url); } catch { throw new ModuleError('bad-input', 'the instance address is not valid'); }
    if (u.username || u.password) throw new ModuleError('bad-input', 'put the address without a user name or password');
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isIP(h) && inCidr(h, h.includes(':') ? 'fe80::/10' : '169.254.0.0/16')) throw new ModuleError('blocked', 'link-local addresses are refused');
    const local = h === 'localhost' || (isIP(h) && isReservedIp(h)) || h.endsWith('.local');
    if (u.protocol === 'http:') { if (!local) throw new ModuleError('bad-input', 'an instance outside this computer or your network needs an https address'); ownPlain.add(u.hostname.toLowerCase()); }
    else if (u.protocol !== 'https:') throw new ModuleError('bad-input', 'the instance address must start with https:// (or http:// on this computer or your own network)');
    allowed.add(u.hostname.toLowerCase());
    ownPorts.set(u.hostname.toLowerCase(), u.port || (u.protocol === 'https:' ? '443' : '80'));
    return u.origin;
  }
  function parse(url) {
    let u;
    try { u = new URL(url); } catch { throw new ModuleError('blocked', 'not a valid address'); }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ownPlain.has(host))) throw new ModuleError('blocked', 'only https is allowed: ' + u.host);
    if (u.username || u.password) throw new ModuleError('blocked', 'addresses with credentials are refused');
    if (ownPorts.has(host)) { if ((u.port || (u.protocol === 'https:' ? '443' : '80')) !== ownPorts.get(host)) throw new ModuleError('blocked', 'only the port of the instance address is allowed: ' + u.host); }
    else if (u.port && u.port !== '443') throw new ModuleError('blocked', 'only port 443 is allowed: ' + u.host);
    if (!allowed.has(u.hostname.toLowerCase())) throw new ModuleError('blocked', 'host is not on this module\'s allowlist: ' + u.hostname);
    return u;
  }
  async function readBody(res) {
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (declared > maxBytes) throw new ModuleError('bad-response', `the answer is larger than ${maxBytes} bytes`);
    if (!res.body || typeof res.body.getReader !== 'function') {
      const t = await res.text();
      if (Buffer.byteLength(t) > maxBytes) throw new ModuleError('bad-response', `the answer is larger than ${maxBytes} bytes`);
      return t;
    }
    const rd = res.body.getReader(), chunks = []; let n = 0;
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.length;
      if (n > maxBytes) { try { await rd.cancel(); } catch { /* closed */ } throw new ModuleError('bad-response', `the answer is larger than ${maxBytes} bytes`); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const retryAfter = (res) => { const h = res.headers.get('retry-after'); if (h === null || h.trim() === '') return null; const v = Number(h); return Number.isFinite(v) && v >= 0 ? Math.min(v, 3600) : null; };

  // GET one address. Returns {status, text, json()}; 404 is returned to the caller, other failures throw ModuleError.
  async function get(url, { accept = 'application/json', purpose = 'lookup', headers = {} } = {}) {
    let target = url;
    for (let hop = 0; hop < 4; hop++) {
      const u = parse(target);
      if (state.requests >= maxRequests) throw new ModuleError('blocked', `request cap reached (${maxRequests} per run)`);
      if (egress) {
        let verdict;
        try { verdict = await egress({ url: u.href, host: u.hostname, module, purpose }); } catch (e) { throw new ModuleError('blocked', 'egress policy error: ' + (e && e.message || e)); }
        if (verdict === false || (verdict && verdict.allow === false)) throw new ModuleError('blocked', 'egress policy refused ' + u.hostname + (verdict && verdict.reason ? ': ' + verdict.reason : ''));
      }
      const wait = (last.get(u.hostname) || 0) + gap - now();
      if (wait > 0) await sleep(wait);
      last.set(u.hostname, now());
      state.requests++; state.hosts.add(u.hostname);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let res, text;
      try {
        res = await fetch(u.href, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: ctl.signal, headers: { accept, 'user-agent': userAgent, ...(hop === 0 ? headers : {}) } });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          target = new URL(res.headers.get('location'), u).href;
          try { if (res.body && res.body.cancel) await res.body.cancel(); } catch { /* closed */ }
          continue;
        }
        if (res.status === 429 || (res.status === 503 && retryAfter(res) !== null)) {
          state.rateLimited = true;
          const ra = retryAfter(res);
          throw new ModuleError('rate-limited', `${u.hostname} asked us to slow down${ra !== null ? ` (retry after ${ra} s)` : ''}`, { retryAfter: ra });
        }
        if (res.status === 401 || res.status === 403) { state.unreachable = true; throw new ModuleError('unavailable', `${u.hostname} needs an account login or refused access (HTTP ${res.status}); Ghost does not log in to services`, { loginRequired: true }); }
        if (res.status >= 500) { state.unreachable = true; throw new ModuleError('unavailable', `${u.hostname} is not available right now (HTTP ${res.status})`); }
        text = await readBody(res);
      } catch (e) {
        if (e instanceof ModuleError) throw e;
        state.unreachable = true;
        throw new ModuleError('unavailable', ctl.signal.aborted ? `${u.hostname} did not answer within ${timeoutMs} ms` : `could not reach ${u.hostname}`);
      } finally { clearTimeout(timer); }
      const status = res.status;
      if (status >= 400 && status !== 404) throw new ModuleError('bad-response', `${u.hostname} answered HTTP ${status}`);
      return { status, url: u.href, text, json() { try { return JSON.parse(text); } catch { throw new ModuleError('bad-response', `${u.hostname} did not return JSON`); } } };
    }
    throw new ModuleError('bad-response', 'too many redirects');
  }
  return { get, allow, allowOwn, state, hosts: () => [...allowed] };
}

// ---- IP helpers (pure, no network) ----
function ipToBig(ip) {
  const v = isIP(ip);
  if (v === 4) { const p = ip.split('.').map(Number); return { v: 4, n: p.reduce((a, b) => (a << 8n) + BigInt(b), 0n) }; }
  if (v !== 6) return null;
  let s = ip.toLowerCase();
  const z = s.indexOf('%'); if (z >= 0) s = s.slice(0, z);
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) { const q = m[1].split('.').map(Number); s = s.slice(0, -m[1].length) + ((q[0] << 8) | q[1]).toString(16) + ':' + ((q[2] << 8) | q[3]).toString(16); }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const parts = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  if (parts.length !== 8) return null;
  return { v: 6, n: parts.reduce((a, b) => (a << 16n) + BigInt(parseInt(b, 16)), 0n) };
}
function inCidr(ip, cidr) {
  const a = ipToBig(ip); const [base, bitsS] = String(cidr).split('/');
  const b = ipToBig(base); const bits = Number(bitsS);
  if (!a || !b || a.v !== b.v || !Number.isInteger(bits)) return false;
  const total = a.v === 4 ? 32 : 128;
  if (bits < 0 || bits > total) return false;
  const shift = BigInt(total - bits);
  return (a.n >> shift) === (b.n >> shift);
}
const RESERVED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '::/128', '::1/128', '::ffff:0:0/96', '64:ff9b::/96', '100::/64', '2001:db8::/32', 'fc00::/7', 'fe80::/10', 'ff00::/8'];
const isReservedIp = (ip) => RESERVED.some((c) => inCidr(ip, c));

// ---- result lines ----
const TYPES = ['domain', 'ip', 'asn', 'cert', 'org', 'person', 'document', 'image', 'place', 'event', 'url', 'email'];
const EMAIL_ROLES = ['abuse-contact', 'registrar-contact', 'security-contact', 'mx', 'cert-subject', 'dmarc-report', 'soa-contact'];
const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// A line that looks like an email address is only allowed as an infrastructure `email` with a permitted role (spec section 6);
// anything else containing '@' is withheld by the caller via looksPersonal(). A `person` result is a name a source published (for example an RDAP contact).
const looksPersonal = (s) => /[^\s@]+@[^\s@]+\.[^\s@]+/.test(String(s));

// Builds the context a module's run() receives. onResult gets each finished result line.
function makeContext({ meta, client, tools = null, onResult, onProgress = () => {}, now = () => new Date() }) {
  const out = { notes: [], count: 0, dropped: 0, seen: new Set() };
  const ctx = {
    client, tools, meta, notes: out.notes,
    note(msg) { out.notes.push(String(msg)); },
    progress(p, msg) { onProgress(Math.max(0, Math.min(1, p)), msg ? clip(msg, 200) : undefined); },
    // emit({type, value, confidence?, uncertaintyNote?, raw?, url?, dedupe?}); returns false when dropped or a duplicate
    emit({ type, value, confidence = 'confirmed', uncertaintyNote, raw, url, dedupe = true }) {
      if (!TYPES.includes(type)) throw new Error('module bug: entity type outside the closed list: ' + type);
      value = clip(value, 2000);
      if (type === 'email' && !(raw && EMAIL_ROLES.includes(raw.role))) { out.dropped++; return false; }
      const key = type + '\u0000' + value;
      if (dedupe && out.seen.has(key)) return false;
      out.seen.add(key);
      const line = { entity: { type, value }, source: { tool: meta.tool || meta.id, connector: meta.id, version: meta.version, ...(url ? { url } : {}) }, observedAt: now().toISOString(), confidence };
      if (uncertaintyNote) line.uncertaintyNote = clip(uncertaintyNote, 500);
      if (raw !== undefined) line.raw = raw;
      out.count++;
      onResult(line);
      return true;
    },
  };
  ctx.out = out;
  return ctx;
}

// Runs a module in-process (tests, main-process use) or from run.js. Returns {status, network, results, notes, message, exitCode}.
//   status: 'ok' | 'bad-input' | 'bad-response' | 'unavailable' | 'rate-limited' | 'blocked' | 'internal'
//   network: the honest state of this run: 'local' | 'keyless-external' | 'rate-limited' | 'unavailable'
async function execute(mod, input, opts = {}) {
  const meta = mod.meta;
  const results = [];
  const onResult = opts.onResult || ((r) => results.push(r));
  const client = meta.network === 'local' ? null : createClient({ ...(meta.client || {}), hosts: meta.hosts || [], dynamic: !!meta.dynamicHosts, ownAllowed: !!meta.ownInstance, module: meta.id, userAgent: `MayfairGhost/${meta.version} (passive module ${meta.id})`, fetch: opts.fetch || globalThis.fetch, egress: opts.egress || null, sleep: opts.sleep, now: opts.clock });
  const tools = meta.program ? (opts.tools || require('./tool-run').realTools()) : null;
  const ctx = makeContext({ meta, client, tools, onResult, onProgress: opts.onProgress, now: opts.now });
  let status = 'ok', message = '';
  try { await mod.run(ctx, input || {}); } catch (e) {
    if (e instanceof ModuleError) { status = e.kind; message = e.message; } else { status = 'internal'; message = 'internal error: ' + (e && e.message || e); }
  }
  let network = meta.network;
  if (client) {
    if (client.state.rateLimited) network = 'rate-limited';
    else if (status === 'unavailable' || (client.state.unreachable && ctx.out.count === 0)) network = 'unavailable';
  }
  return { status, network, declaredNetwork: meta.network, results, notes: ctx.out.notes, dropped: ctx.out.dropped, requests: client ? client.state.requests : 0, message, exitCode: status === 'ok' ? 0 : (KIND_EXIT[status] || EXIT.internal) };
}

// ---- argument parsing for run.js: --name=value, as built from the manifest templates ----
function parseArgs(argv, fields) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-zA-Z][a-zA-Z0-9_]*)=([\s\S]*)$/.exec(a);
    if (!m) throw new ModuleError('bad-input', 'unexpected argument');
    if (!fields.some((f) => f.name === m[1])) throw new ModuleError('bad-input', 'unknown input: ' + m[1]);
    out[m[1]] = m[2];
  }
  return out;
}

// ---- small shared validators ----
const toAscii = (s) => { try { return require('node:url').domainToASCII(String(s).trim().toLowerCase().replace(/\.$/, '')); } catch { return ''; } };
function needDomain(v, { minLabels = 2 } = {}) {
  const d = toAscii(v || '');
  if (!d || !isDnsName(d) || d.split('.').length < minLabels) throw new ModuleError('bad-input', 'enter a domain name such as example.com (no scheme, path or address)');
  return d;
}
const isoDate = (s) => { const t = Date.parse(s); return Number.isNaN(t) ? null : new Date(t).toISOString(); };

module.exports = { EXIT, ModuleError, createClient, makeContext, execute, parseArgs, ipToBig, inCidr, isReservedIp, isDnsName, needDomain, toAscii, looksPersonal, isoDate, clip, TYPES, EMAIL_ROLES };
