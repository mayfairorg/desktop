'use strict';
// Mayfair browser extensions (Manifest V3, our own nine). Download, verify, unpack, record.
// Loading into a session is done by browser-service.js; this file is pure and testable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readZip } = require('./zip');
const { JsonStore } = require('./stores');

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_DOWNLOAD = 8 * 1024 * 1024;
const DENY_PERMS = ['nativeMessaging', 'debugger', 'proxy', 'management', 'enterprise.deviceAttributes', 'enterprise.platformKeys', 'system.storage', 'processes', 'vpnProvider', 'webRequestBlocking'];
// Handled by the app itself, so they are NOT loaded into Chromium:
//  blocker   needs declarativeNetRequest, which Electron lacks: its rule file is applied natively
//  passwords the extension finds the Passwords page by looking for a Mayfair tab, which the pinned
//            Mayfair tab (a separate session) never is; the app answers mf.pw.request itself
const NATIVE = { blocker: 'rules', passwords: 'bridge' };

// Only Mayfair Cloud's /ext/ folder, https, no query, no credentials, no odd ports.
function validDownloadUrl(u) {
  let x; try { x = new URL(String(u)); } catch { return false; }
  return x.protocol === 'https:' && x.hostname === 'cloud.mayfairmail.com' && !x.port && !x.username && !x.password && !x.search && !x.hash && /^\/ext\/[A-Za-z0-9._-]{1,80}\.zip$/.test(x.pathname);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function checkManifest(m, id) {
  if (!m || typeof m !== 'object') throw new Error('Extension has no manifest');
  if (m.manifest_version !== 3) throw new Error('Only Manifest V3 extensions are allowed');
  if (typeof m.name !== 'string' || !/^\d+(\.\d+){0,3}$/.test(String(m.version))) throw new Error('Extension manifest is incomplete');
  const perms = [...(m.permissions || []), ...(m.optional_permissions || [])];
  const bad = perms.filter((p) => DENY_PERMS.includes(p));
  if (bad.length) throw new Error('Extension asks for a permission that is not allowed: ' + bad[0]);
  if (m.update_url || m.externally_connectable || m.key) throw new Error('Extension manifest has fields that are not allowed');
  return { name: m.name, version: String(m.version) };
}

// DNR block rules like {"condition":{"urlFilter":"||host^","domainType":"thirdParty"}} -> hosts
function rulesToDomains(rules) {
  const out = new Set();
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || !r.action || r.action.type !== 'block' || !r.condition) continue;
    const m = /^\|\|([a-z0-9.-]+\.[a-z]{2,})\^$/i.exec(String(r.condition.urlFilter || ''));
    if (m) out.add(m[1].toLowerCase());
  }
  return out;
}

class ExtensionManager {
  constructor({ dir, storeFile, now = () => Date.now() }) {
    this.dir = dir; this.now = now;
    this.s = new JsonStore(storeFile, () => ({ installed: {} }));
    if (!this.s.data.installed) this.s.data.installed = {};
  }
  list() { return Object.entries(this.s.data.installed).map(([id, v]) => ({ id, version: v.version, enabled: v.enabled !== false })); }
  has(id) { return !!this.s.data.installed[id]; }
  native(id) { return NATIVE[id] || null; }
  // Folders of installed extensions that should be loaded into Chromium.
  loadable() { return Object.entries(this.s.data.installed).filter(([id, v]) => v.enabled !== false && !NATIVE[id] && fs.existsSync(v.dir)).map(([id, v]) => ({ id, dir: v.dir })); }
  dirOf(id) { return this.s.data.installed[id] && this.s.data.installed[id].dir; }

  async install(id, url, sha, fetchBuf) {
    if (!ID.test(String(id))) throw new Error('Bad extension id');
    if (!validDownloadUrl(url)) throw new Error('Extensions can only be downloaded from cloud.mayfairmail.com/ext/');
    const want = String(sha).toLowerCase();
    if (!SHA.test(want)) throw new Error('Bad checksum');
    const buf = await fetchBuf(String(url), MAX_DOWNLOAD);
    if (!Buffer.isBuffer(buf) || buf.length > MAX_DOWNLOAD) throw new Error('Download too large');
    if (!sameHash(sha256(buf), want)) throw new Error('Checksum does not match. The download was not installed.');
    const files = readZip(buf);
    const mf = files.find((f) => f.name === 'manifest.json');
    if (!mf) throw new Error('Extension has no manifest');
    let m; try { m = JSON.parse(mf.data.toString('utf8')); } catch { throw new Error('Extension manifest is damaged'); }
    const info = checkManifest(m, id);
    const base = path.join(this.dir, id);
    const target = path.join(base, info.version);
    const tmp = path.join(base, '.tmp-' + this.now());
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const f of files) {
      const dest = path.join(tmp, f.name);
      if (!dest.startsWith(tmp + path.sep)) throw new Error('Unsafe file name');
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, f.data);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
    for (const old of fs.readdirSync(base)) if (old !== info.version) fs.rmSync(path.join(base, old), { recursive: true, force: true });
    this.s.data.installed[id] = { version: info.version, dir: target, enabled: true, name: info.name, sha256: want, at: this.now() };
    this.s.save(); this.s.flush();
    return { id, version: info.version, native: NATIVE[id] || null };
  }
  remove(id) {
    if (!ID.test(String(id))) return false;
    const v = this.s.data.installed[id]; if (!v) return false;
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    delete this.s.data.installed[id]; this.s.save(); this.s.flush();
    return true;
  }
  // Tracker hosts from an installed blocker extension's own rule file.
  blockerDomains() {
    const d = this.dirOf('blocker'); if (!d) return new Set();
    try { return rulesToDomains(JSON.parse(fs.readFileSync(path.join(d, 'rules', 'trackers.json'), 'utf8'))); } catch { return new Set(); }
  }
}
module.exports = { ExtensionManager, validDownloadUrl, checkManifest, rulesToDomains, NATIVE, DENY_PERMS, sha256, ID };
