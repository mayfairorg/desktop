'use strict';
// Mayfair Ghost security connectors: shared helpers.
// CANONICAL SOURCE. `node sync.js` copies this file into every connector folder (a connector folder is copied on its own into
// <userData>/connectors/<id>/, so it cannot require anything outside itself). test/ghost-security-sync.test.js fails if a copy drifts.
// Node built-ins only. Nothing here uses a shell, inherits the environment, or reads a proxy setting.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const { spawn } = require('node:child_process');

// A connector folder is <userData>/connectors/<id>; Ghost's own data is <userData>/ghost/.
const USER_DATA = path.resolve(__dirname, '..', '..');
const TOOLS_DIR = path.join(USER_DATA, 'ghost', 'tools');
const INSTANCES_DIR = path.join(USER_DATA, 'ghost', 'instances');

class UsageError extends Error { constructor(m) { super(m); this.name = 'UsageError'; this.exitCode = 2; } }
class ToolError extends Error { constructor(m, code = 3) { super(m); this.name = 'ToolError'; this.exitCode = code; } }

// ---------- arguments ----------
function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-zA-Z][a-zA-Z0-9_-]*)(?:=([\s\S]*))?$/.exec(a);
    if (!m) throw new UsageError('unexpected argument');
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}
function intArg(v, name, min, max, dflt) {
  if (v === undefined || v === true || v === '') { if (dflt !== undefined) return dflt; throw new UsageError(`${name} is required`); }
  if (!/^-?\d{1,9}$/.test(String(v))) throw new UsageError(`${name} must be a whole number`);
  const n = Number(v);
  if (n < min || n > max) throw new UsageError(`${name} must be from ${min} to ${max}`);
  return n;
}

// ---------- time ----------
// Accepts epoch seconds (number or numeric string, fractions allowed), epoch millis, or an ISO-like string such as
// "2026-10-27T09:00:00.123456+0000" (Suricata). Returns an ISO string or null. Never invents a time.
function isoTs(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    let n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 1e11) n *= 1000;                      // seconds -> ms
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  let s = String(v).trim().replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- result objects ----------
// makeMk(spec, {now, toolVersion}) -> mk(type, value, {confidence, note, raw, url, observedAt, version})
// Every result carries source, observedAt, confidence and (for uncertain) uncertaintyNote. A result is never upgraded here.
function makeMk(spec, opts = {}) {
  const nowIso = opts.now || new Date().toISOString();
  return function mk(type, value, o = {}) {
    const v = String(value).replace(/\0/g, '').slice(0, 2000);
    if (!v) throw new Error('result with an empty value');
    const confidence = o.confidence || 'confirmed';
    if (confidence === 'uncertain' && !o.note) throw new Error('uncertain result without a note');
    const r = {
      entity: { type, value: v },
      source: { tool: spec.tool, connector: spec.id, version: String(o.version || opts.toolVersion || spec.version).slice(0, 64), ...(o.url ? { url: o.url } : {}) },
      observedAt: o.observedAt || nowIso,
      confidence,
    };
    if (o.note) r.uncertaintyNote = String(o.note).slice(0, 500);
    if (o.raw !== undefined) r.raw = o.raw;
    return r;
  };
}
// A parser never drops input silently: when it skips lines it says how many, as an uncertain result.
function skipNote(mk, count, what) {
  return count > 0 ? mk('parse-warning', `${count} ${what} could not be read and were skipped`, { confidence: 'uncertain', note: 'The tool printed lines in a form this parser does not understand; they are not part of the results.' }) : null;
}
function emit(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function progress(p, message) { emit({ progress: Math.max(0, Math.min(1, p)), ...(message ? { message: String(message).slice(0, 200) } : {}) }); }

// ---------- host checks ----------
const FQDN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
function isIPv4(s) { return net.isIPv4(s); }
function inDomain(host, domain) { host = host.toLowerCase(); domain = domain.toLowerCase(); return host === domain || host.endsWith('.' + domain); }
function isPrivateHost(h) {
  h = String(h).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (net.isIPv4(h)) { const [a, b] = h.split('.').map(Number); return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254); }
  if (net.isIPv6(h)) return h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
  return false;
}
// Wrapper-level checks for an ACTIVE target, on top of the manager's scope declaration: one host or one IPv4 address, no wildcards,
// no ranges, no bare TLD, none of the addresses that can never be a single owned target.
function checkActiveTarget(t) {
  if (typeof t !== 'string' || !t) throw new UsageError('target is required');
  if (/[*\/\s,;]/.test(t)) throw new UsageError('target must be one host name or one IPv4 address (no wildcards, ranges or lists)');
  if (net.isIPv4(t)) {
    const [a, , , d] = t.split('.').map(Number);
    if (a === 0 || a >= 224 || d === 255) throw new UsageError('target address is not a single unicast host');
    return t;
  }
  if (net.isIPv6(t)) throw new UsageError('IPv6 targets are not supported by this connector');
  if (t !== 'localhost' && !/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/.test(t)) throw new UsageError('target must be a full host name such as www.example.com');
  return t.toLowerCase();
}
async function resolveTarget(host) {
  if (net.isIP(host)) return { addresses: [host], v4: net.isIPv4(host) ? host : null, pinned: host };
  let list;
  try { list = await dns.promises.lookup(host, { all: true }); } catch (e) { throw new ToolError(`could not resolve ${host}: ${e.code || e.message}`); }
  const addresses = [...new Set(list.map((x) => x.address))];
  const v4 = addresses.find((a) => net.isIPv4(a)) || null;
  if (!addresses.length) throw new ToolError(`could not resolve ${host}`);
  return { addresses, v4, pinned: v4 || addresses[0] };
}

// ---------- the tool the user installed (Ghost tools folder) ----------
const sha256File = (p) => new Promise((resolve, reject) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
});
function readInstallRecord(id) {
  try { return JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, id, 'install.json'), 'utf8')); } catch { return null; }
}
// Finds the installed program. Refuses unless the install record says the installer's self-test passed, the file is a plain file, and
// its SHA-256 still matches the record (a replaced or damaged program is never run).
async function locateTool(spec) {
  const rec = readInstallRecord(spec.id);
  if (!rec || rec.status !== 'installed' || !rec.selfTest || rec.selfTest.passed !== true) throw new ToolError(`${spec.tool} is not installed. Install it from the Ghost tools list; Ghost never runs a tool whose install self-test has not passed.`, 4);
  const exe = rec.adopted ? rec.exe : path.join(TOOLS_DIR, spec.id, rec.exe);
  if (typeof exe !== 'string' || !path.isAbsolute(exe)) throw new ToolError('install record is damaged', 4);
  if (!rec.adopted) {
    const base = path.join(TOOLS_DIR, spec.id);
    const rel = path.relative(fs.realpathSync(base), (() => { try { return fs.realpathSync(exe); } catch { return exe; } })());
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ToolError('install record points outside the tools folder', 4);
  }
  let st;
  try { st = fs.lstatSync(exe); } catch { throw new ToolError(`${spec.tool} files are missing; reinstall it`, 4); }
  if (!st.isFile() && !st.isSymbolicLink()) throw new ToolError(`${spec.tool} program is not a plain file`, 4);
  if (rec.exeSha256 !== await sha256File(exe)) throw new ToolError(`${spec.tool} program changed since it was installed; reinstall it`, 4);
  return { exe, version: rec.version || null, launcher: Array.isArray(rec.launcher) ? rec.launcher : [], record: rec };
}

// ---------- running a program ----------
// Minimal environment: no inherited tokens, and never a proxy variable (active tools are never routed through Tor or any proxy).
function toolEnv(home) {
  const e = {};
  for (const k of process.platform === 'win32' ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH']) if (process.env[k] !== undefined) e[k] = process.env[k];
  if (process.platform !== 'win32') { e.LANG = 'C.UTF-8'; e.TMPDIR = os.tmpdir(); }
  if (home) { e.HOME = home; e.USERPROFILE = home; }
  return e;
}
let currentChild = null;
function stopChild() { if (currentChild && currentChild.exitCode === null) { try { currentChild.kill('SIGTERM'); } catch { /* gone */ } } }
// Only the connector's own run.js installs this (never code that merely loads the helpers): on SIGTERM the tool it started is stopped too.
function installSignalHandler() { process.on('SIGTERM', () => { stopChild(); setTimeout(() => process.exit(143), 50); }); }

function runTool(exe, args, { cwd, timeoutMs = 60000, maxBytes = 8 * 1024 * 1024, launcher = [] } = {}) {
  return new Promise((resolve) => {
    const cmd = launcher.length ? launcher[0] : exe;
    const argv = launcher.length ? [...launcher.slice(1), exe, ...args] : args;
    let child;
    try { child = spawn(cmd, argv, { cwd, shell: false, env: toolEnv(cwd), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return resolve({ code: null, stdout: '', stderr: String(e.code || e.message), spawnError: e.code || 'spawn-failed' }); }
    currentChild = child;
    try { if (process.platform !== 'win32' && child.pid) os.setPriority(child.pid, 10); } catch { /* best effort */ }
    const out = [], err = [];
    let nOut = 0, nErr = 0, timedOut = false, truncated = false, done = false;
    const fin = (r) => { if (done) return; done = true; clearTimeout(timer); currentChild = null; resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8').slice(0, 16384), timedOut, truncated, ...r }); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => { nOut += d.length; if (nOut > maxBytes) { truncated = true; try { child.kill('SIGKILL'); } catch { /* gone */ } return; } out.push(d); });
    child.stderr.on('data', (d) => { nErr += d.length; if (nErr <= 65536) err.push(d); });
    child.on('error', (e) => fin({ code: null, spawnError: e.code || 'spawn-failed' }));
    child.on('close', (code, signal) => fin({ code, signal }));
  });
}
function makeRunDir(id) { return fs.mkdtempSync(path.join(os.tmpdir(), `mfghost-${id}-`)); }
function removeDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
const firstLine = (s) => String(s || '').split(/\r?\n/).map((x) => x.trim()).find(Boolean) || '';

// ---------- the user's own instance (MISP, OpenCTI, OpenSearch, Neo4j) ----------
// Config file: <userData>/ghost/instances/<id>.json, mode 0600, written by the vault-ready helper in instance-config.js.
// {version:1, url, auth:{type, key|token|username+password|vaultRef}, allowSelfSigned?, database?, index?}
const AUTH_TYPES = ['none', 'api-key', 'bearer', 'basic'];
function validateInstanceConfig(c, { authTypes = AUTH_TYPES } = {}) {
  const errors = [];
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const only = (o, keys, w) => { for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${w}: unknown key "${k}"`); };
  if (!isObj(c)) return { ok: false, errors: ['config must be a JSON object'] };
  only(c, ['version', 'url', 'auth', 'allowSelfSigned', 'database', 'index'], 'config');
  if (c.version !== 1) errors.push('version must be 1');
  let u = null;
  if (typeof c.url !== 'string' || c.url.length > 300) errors.push('url is required');
  else {
    try { u = new URL(c.url); } catch { errors.push('url is not a valid address'); }
    if (u) {
      if (u.protocol !== 'https:' && u.protocol !== 'http:') errors.push('url must start with https:// or http://');
      else if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) errors.push('plain http is only allowed for localhost and private-network addresses; use https');
      if (u.username || u.password) errors.push('put credentials in "auth", not in the url');
      if (u.search || u.hash) errors.push('url must not contain a query string or fragment');
    }
  }
  if (!isObj(c.auth)) errors.push('auth is required ({type:"none"} for an open instance)');
  else {
    only(c.auth, ['type', 'key', 'token', 'username', 'password', 'vaultRef'], 'auth');
    if (!authTypes.includes(c.auth.type)) errors.push(`auth.type must be one of ${authTypes.join(', ')}`);
    const s = (v, n) => typeof v === 'string' && v.length >= 1 && v.length <= n;
    const secretOk = (k) => (s(c.auth[k], 2048) && c.auth.vaultRef === undefined) || (c.auth[k] === undefined && s(c.auth.vaultRef, 200) && /^vault:[A-Za-z0-9._-]{1,150}$/.test(c.auth.vaultRef));
    if (c.auth.type === 'api-key' && !secretOk('key')) errors.push('auth.key (or auth.vaultRef "vault:<name>") is required for api-key');
    if (c.auth.type === 'bearer' && !secretOk('token')) errors.push('auth.token (or auth.vaultRef "vault:<name>") is required for bearer');
    if (c.auth.type === 'basic') { if (!s(c.auth.username, 200)) errors.push('auth.username is required for basic'); if (!secretOk('password')) errors.push('auth.password (or auth.vaultRef) is required for basic'); }
    if (c.auth.type === 'none' && (c.auth.key || c.auth.token || c.auth.password || c.auth.vaultRef)) errors.push('auth.type "none" must not carry a secret');
  }
  if (c.allowSelfSigned !== undefined && typeof c.allowSelfSigned !== 'boolean') errors.push('allowSelfSigned must be true or false');
  if (c.allowSelfSigned === true && u && !isPrivateHost(u.hostname)) errors.push('allowSelfSigned is only allowed for localhost and private-network addresses');
  for (const k of ['database', 'index']) if (c[k] !== undefined && !(typeof c[k] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._*,-]{0,99}$/.test(c[k]))) errors.push(`${k} must be a plain name`);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], config: c };
}
function loadInstanceConfig(id, spec) {
  const p = path.join(INSTANCES_DIR, id + '.json');
  let st;
  try { st = fs.statSync(p); } catch { throw new ToolError(`no ${spec.tool} instance is configured. Add your instance address and key in Ghost settings first; nothing is bundled and nothing is guessed.`, 5); }
  if (!st.isFile()) throw new ToolError('instance config is not a plain file', 5);
  if (process.platform !== 'win32' && (st.mode & 0o077)) throw new ToolError('instance config can be read by other users; run chmod 600 on it (Ghost writes it that way)', 5);
  let j;
  try { j = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { throw new ToolError('instance config is not valid JSON', 5); }
  const v = validateInstanceConfig(j, { authTypes: spec.authTypes });
  if (!v.ok) throw new ToolError('instance config problem: ' + v.errors[0], 5);
  if (j.auth.vaultRef) throw new ToolError('this config refers to the Ghost vault (' + j.auth.vaultRef + '), which this build cannot open yet; store the key directly in the config file for now', 5);
  return j;
}
function authHeaders(cfg, spec) {
  const a = cfg.auth, h = {};
  if (a.type === 'api-key') h[spec.apiKeyHeader || 'Authorization'] = a.key;
  else if (a.type === 'bearer') h.Authorization = 'Bearer ' + a.token;
  else if (a.type === 'basic') h.Authorization = 'Basic ' + Buffer.from(a.username + ':' + a.password).toString('base64');
  return h;
}
function secretsOf(cfg) { return [cfg.auth.key, cfg.auth.token, cfg.auth.password].filter(Boolean); }
function scrub(text, secrets) { let s = String(text); for (const x of secrets) if (x) s = s.split(x).join('***'); return s; }

// One JSON request. No redirects (the Authorization header must never follow a redirect to another host), 4 MiB cap, timeout.
function httpJson({ baseUrl, pathname, method = 'GET', headers = {}, body, timeoutMs = 20000, maxBytes = 4 * 1024 * 1024, allowSelfSigned = false }) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl.replace(/\/+$/, '') + pathname);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = mod.request(u, { method, headers: { Accept: 'application/json', 'User-Agent': 'MayfairGhost-connector', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers }, timeout: timeoutMs, ...(u.protocol === 'https:' && allowSelfSigned ? { rejectUnauthorized: false } : {}) }, (res) => {
      const chunks = []; let n = 0;
      res.on('data', (d) => { n += d.length; if (n > maxBytes) { req.destroy(new Error('response is larger than 4 MiB')); return; } chunks.push(d); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('the instance did not answer in time')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Defence in depth for the input rule "no tool accepts a person's email, phone number or handle": adapters refuse such a query even
// though the manifest pattern already cannot match one.
function refusePersonalQuery(q) {
  const s = String(q).trim();
  if (/[^\s@]+@[^\s@]+/.test(s) || /^@\w/.test(s)) throw new UsageError('queries about an email address or account handle are not supported by Mayfair Ghost');
  if (/^\+?[\d\s()-]{7,20}$/.test(s) && (s.match(/\d/g) || []).length >= 7 && (s.match(/\d/g) || []).length <= 15) throw new UsageError('queries about a phone number are not supported by Mayfair Ghost');
  return s;
}
// Indicator kinds the adapters accept. Anything else is refused.
const INDICATOR_KINDS = {
  ip: (v) => net.isIP(v) !== 0,
  domain: (v) => FQDN_RE.test(v.toLowerCase()),
  url: (v) => { try { const u = new URL(v); return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password; } catch { return false; } },
  md5: (v) => /^[a-f0-9]{32}$/i.test(v),
  sha1: (v) => /^[a-f0-9]{40}$/i.test(v),
  sha256: (v) => /^[a-f0-9]{64}$/i.test(v),
  cve: (v) => /^CVE-\d{4}-\d{4,9}$/i.test(v),
};
function checkIndicator(kind, value) {
  const f = INDICATOR_KINDS[kind];
  if (!f) throw new UsageError('indicator kind is not supported');
  refusePersonalQuery(value);
  if (!f(value)) throw new UsageError(`"${value.slice(0, 60)}" is not a valid ${kind}`);
  return value;
}

module.exports = {
  USER_DATA, TOOLS_DIR, INSTANCES_DIR, UsageError, ToolError, parseArgs, intArg, isoTs, makeMk, emit, progress, skipNote, FQDN_RE, isIPv4, inDomain, isPrivateHost,
  checkActiveTarget, resolveTarget, sha256File, readInstallRecord, locateTool, toolEnv, runTool, makeRunDir, removeDir, firstLine, installSignalHandler,
  AUTH_TYPES, validateInstanceConfig, loadInstanceConfig, authHeaders, secretsOf, scrub, httpJson, refusePersonalQuery, INDICATOR_KINDS, checkIndicator,
};
