'use strict';
// Ghost terminal: "Add tool". A tool is an ordinary Ghost connector (connector.json + files, docs/connectors.md). It can come from
//   - a folder or a .zip the person picks (native picker: the page never supplies a path),
//   - one script or program plus a small form that writes the manifest,
//   - a GitHub repository (https only, github hosts only, the commit is resolved and pinned).
// Rules kept here:
//   * Importing only COPIES FILES into a staging folder and reads them as data. Nothing is run, no install script, no hook, ever.
//   * The person sees the manifest, README and licence (and the pinned commit) before anything lands in the Ghost tools folder.
//   * A tool lands as <tools>/<id>/ and is managed by the existing ConnectorManager: it can only run after the native approval dialog,
//     only from argv arrays in its manifest, and approval is withdrawn when files change. The manager hashes the manifest and the
//     program; this module also hashes EVERY file in the folder and withdraws approval when any of them changes.
//   * Tool folders are never added to PATH (tools.js): they run through the approved runner, not by typing a name.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('../manifest');
const { ConnectorManager } = require('../manager');
const { JobRunner } = require('../runner');
const { GhostLog } = require('../logger');
const { PickStore } = require('../picks');
const { readZip, safeName } = require('../../lib/zip');
const { FUSES } = require('../../lib/protect');

const LIMITS = { files: 500, bytes: 24 * 1024 * 1024, single: 8 * 1024 * 1024, archive: 24 * 1024 * 1024, text: 6000, stageTtlMs: 30 * 60 * 1000, stages: 6 };
const GH_HOSTS = ['api.github.com', 'codeload.github.com'];
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const within = (root, p) => p === root || p.startsWith(root + path.sep);
const fail = (error, errors) => ({ ok: false, error, errors: errors || [error] });
const INSTALL_SCRIPTS = ['setup.py', 'setup.cfg', 'pyproject.toml', 'Makefile', 'install.sh', 'install.ps1', 'install.bat', 'configure', 'postinstall.js', 'preinstall.js'];

// ---------- reading files into a staging folder (data only) ----------

// entries: [{name, data}] with names already checked. Writes under dest, refusing anything that would land outside it.
function writeEntries(entries, dest) {
  let bytes = 0;
  if (entries.length > LIMITS.files) throw new Error('too many files (limit ' + LIMITS.files + ')');
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  for (const e of entries) {
    if (!safeName(e.name) || e.name.includes(':') || e.name.split('/').some((s) => s === '' || s === '.' || s === '.git' || s.length > 100)) throw new Error('unsafe file name: ' + e.name.slice(0, 60));
    bytes += e.data.length;
    if (e.data.length > LIMITS.single || bytes > LIMITS.bytes) throw new Error('too large when unpacked');
    const p = path.resolve(root, ...e.name.split('/'));
    if (!within(root, p) || p === root) throw new Error('unsafe file name: ' + e.name.slice(0, 60));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, e.data, { mode: 0o644 });
  }
  return { files: entries.length, bytes };
}

// A zip, or a GitHub zipball, has the files either at the top or inside one folder; strip that one folder.
function stripTop(entries) {
  const names = entries.map((e) => e.name);
  if (names.includes('connector.json')) return entries;
  const tops = new Set(names.map((n) => n.split('/')[0]));
  if (tops.size === 1 && names.every((n) => n.includes('/'))) { const t = [...tops][0] + '/'; return entries.map((e) => ({ name: e.name.slice(t.length), data: e.data })); }
  return entries;
}

function unzipTo(buf, dest) {
  if (buf.length > LIMITS.archive) throw new Error('the archive is too large (limit ' + (LIMITS.archive >> 20) + ' MiB)');
  const entries = readZip(buf, { entries: LIMITS.files, total: LIMITS.bytes, single: LIMITS.single });     // rejects ../, absolute and drive paths, encrypted, bad checksums
  return writeEntries(stripTop(entries).filter((e) => !e.name.startsWith('.git/') && !/(^|\/)\.DS_Store$/.test(e.name)), dest);
}

// Copy a folder as data: no links, no devices, caps on count and size.
function copyFolder(src, dest) {
  let files = 0, bytes = 0;
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isSymbolicLink()) throw new Error('links are not allowed inside a tool: ' + e.name);
      if (e.isDirectory()) walk(a, b);
      else if (e.isFile()) {
        const st = fs.statSync(a); files++; bytes += st.size;
        if (files > LIMITS.files || bytes > LIMITS.bytes || st.size > LIMITS.single) throw new Error('the folder is too large (limits: ' + LIMITS.files + ' files, ' + (LIMITS.bytes >> 20) + ' MiB)');
        fs.writeFileSync(b, fs.readFileSync(a), { mode: 0o644 });
      } else throw new Error('unsupported file type: ' + e.name);
    }
  };
  walk(src, dest);
  return { files, bytes };
}

// SHA-256 over every file (relative path + content), sorted. Detects any change anywhere in the folder.
function treeHash(dir) {
  const h = crypto.createHash('sha256'); let n = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) { h.update('L:' + r + '\0'); continue; }
      if (e.isDirectory()) { if (++n > 5000) throw new Error('too many entries'); walk(p, r); } else if (e.isFile()) { if (++n > 5000) throw new Error('too many entries'); h.update('F:' + r + '\0' + sha256(fs.readFileSync(p)) + '\0'); }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

const readText = (p) => { try { return fs.readFileSync(p, 'utf8').replace(/\0/g, '').slice(0, LIMITS.text); } catch { return ''; } };
function findDoc(dir, re) { try { const n = fs.readdirSync(dir).find((x) => re.test(x) && fs.statSync(path.join(dir, x)).isFile()); return n ? { name: n, text: readText(path.join(dir, n)) } : null; } catch { return null; } }

// ---------- the manifest for a single script or program ----------
const SPDX_RE = /^[A-Za-z0-9.+-]{1,64}$/;
function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, ''); }
function fileSafe(n) { return String(n).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 60) || 'tool'; }

// form: {name, description, runtime:'native'|'node', scope:'local'|'passive', network:'local'|'keyless-external'|'rate-limited', licence, restrictions?,
//        inputLabel? (adds one text input "text"), args: string[] (templates, one per argument), selfTestInput?, timeoutSec?}
function manifestFromForm(form, fileName) {
  if (!form || typeof form !== 'object') throw new Error('the form is missing');
  const id = slug(form.name);
  if (!id || id === 'bin') throw new Error('give the tool a name (letters and digits)');
  const net = form.network || 'local';
  const scope = form.scope || 'local';
  if (!['local', 'passive'].includes(scope)) throw new Error('only local and passive tools can be created from a form');
  if (!SPDX_RE.test(String(form.licence || ''))) throw new Error('licence: enter an SPDX identifier such as MIT, Apache-2.0 or GPL-3.0-only');
  const rel = 'run/' + fileSafe(fileName);
  const hasInput = typeof form.inputLabel === 'string' && form.inputLabel.trim() !== '';
  const args = Array.isArray(form.args) ? form.args.map(String).filter((a) => a !== '') : [];
  if (args.length > 16) throw new Error('at most 16 arguments');
  const node = form.runtime === 'node';
  const m = {
    id, name: String(form.name).slice(0, 80), version: '1.0.0', description: String(form.description || form.name).slice(0, 500),
    capabilities: ['user-tool'], scope, network: net,
    licence: { spdx: form.licence, url: 'https://' + 'spdx.org/licenses/' + form.licence + '.html', mode: 'separate-program' },
    installRequirements: [],
    command: { executable: node ? '@node' : rel, args: node ? [rel, ...args] : args },
    input: { fields: hasInput ? [{ name: 'text', type: 'string', label: String(form.inputLabel).slice(0, 80), maxLength: 1000 }] : [] },
    output: { format: 'jsonl' },
    limits: { timeoutMs: Math.min(600000, Math.max(1000, Math.round((+form.timeoutSec || 60) * 1000))), maxOutputBytes: 1024 * 1024, maxConcurrent: 1 },
    permissions: net === 'local' ? [] : ['network'],
    externalRestrictions: String(form.restrictions || 'None.').slice(0, 1000),
    selfTest: { input: hasInput ? { text: String(form.selfTestInput || 'test').slice(0, 1000) } : {}, expect: { minResults: 1 } },
  };
  return { manifest: m, rel };
}

// ---------- the host ----------
class ToolHost {
  // userData: the app's userData folder. confirm: native dialog (same shape as GhostService._confirm). pick: async ({kind}) -> path|null (native picker).
  constructor({ userData, toolsDir, confirm, emit = () => {}, pick = async () => null, fetchImpl = (typeof fetch === 'function' ? fetch : null), nodePath = process.execPath, isPackaged = true, now = Date.now }) {
    this.toolsDir = toolsDir; this.pick = pick; this.fetch = fetchImpl; this.now = now;
    const root = path.join(userData, 'ghost', 'term');             // its own state: approvals here are separate from the Cloud page's connectors
    this.stageDir = path.join(root, 'stage');
    this.treeFile = path.join(root, 'ghost', 'tool-trees.json');
    this.log = new GhostLog(path.join(root, 'ghost', 'logs'));
    this.picks = new PickStore();
    this.manager = new ConnectorManager({ root, nodePath, nodeAvailable: !isPackaged || FUSES.RunAsNode === true, log: this.log, confirm });
    this.manager.connectorsDir = toolsDir;                         // tools live in the Ghost tools folder
    this.runner = new JobRunner({ manager: this.manager, log: this.log, ghostDir: this.manager.ghostDir, picks: this.picks, emit });
    this.manager.setRunner(this.runner);
    this.stages = new Map();
    this.trees = this._readTrees();
    fs.rmSync(this.stageDir, { recursive: true, force: true });    // nothing from an earlier session stays staged
  }
  _readTrees() { try { const d = JSON.parse(fs.readFileSync(this.treeFile, 'utf8')); return d && d.v === 1 && d.trees ? d.trees : {}; } catch { return {}; } }
  _saveTrees() { fs.mkdirSync(path.dirname(this.treeFile), { recursive: true }); fs.writeFileSync(this.treeFile + '.tmp', JSON.stringify({ v: 1, trees: this.trees }), { mode: 0o600 }); fs.renameSync(this.treeFile + '.tmp', this.treeFile); }

  // ----- staging -----
  _newStage() {
    this._sweep();
    while (this.stages.size >= LIMITS.stages) this.cancel(this.stages.keys().next().value);
    const token = crypto.randomBytes(12).toString('hex');
    const dir = path.join(this.stageDir, token);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { token, dir };
  }
  _sweep() { for (const [t, s] of this.stages) if (this.now() - s.at > LIMITS.stageTtlMs) this.cancel(t); }
  cancel(token) { const s = this.stages.get(token); if (!s) return { ok: true }; this.stages.delete(token); fs.rmSync(s.root, { recursive: true, force: true }); return { ok: true }; }
  shutdown() { for (const t of [...this.stages.keys()]) this.cancel(t); this.runner.shutdown(); }

  // Read the staged package as data and describe it. Nothing is executed.
  _preview(token, root, pkg, source, extra = {}) {
    let parsed = null, manifestErrors = [];
    const mf = path.join(pkg, 'connector.json');
    if (!fs.existsSync(mf)) manifestErrors = ['connector.json is missing: this is not a Ghost tool (see the connector guide)'];
    else {
      try { if (fs.statSync(mf).size > 64 * 1024) throw new Error('too large'); parsed = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { manifestErrors = ['connector.json is not valid JSON (or is too large)']; }
      if (parsed) { const v = M.validateManifest(parsed); if (!v.ok) manifestErrors = v.errors; else parsed = v.manifest; }
    }
    const ok = manifestErrors.length === 0;
    const warnings = [];
    let exists = false;
    if (ok) {
      if (parsed.id === 'bin') { manifestErrors.push('id "bin" is reserved'); }
      if (fs.existsSync(path.join(this.toolsDir, parsed.id))) manifestErrors.push('a tool with the id "' + parsed.id + '" is already installed: remove it first');
      for (const rel of this.manager._executableRels(parsed)) { const p = path.join(pkg, ...rel.split('/')); if (!fs.existsSync(p) || !fs.statSync(p).isFile()) manifestErrors.push(rel + ' is named in the manifest but is not in the package'); }
      exists = true;
    }
    for (const n of INSTALL_SCRIPTS) if (fs.existsSync(path.join(pkg, n))) warnings.push(n + ' is in the package. Ghost never runs install scripts: only the command in the manifest can run, and only after you approve it.');
    try { const pj = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')); if (pj && pj.scripts && ['preinstall', 'install', 'postinstall'].some((k) => pj.scripts[k])) warnings.push('package.json has install scripts. Ghost never runs them.'); } catch { /* none */ }
    const licenceDoc = findDoc(pkg, /^(licen[sc]e|copying)/i);
    if (!licenceDoc) warnings.push('No licence file found in the package. Check the licence before you use the tool.');
    const readme = findDoc(pkg, /^readme/i);
    const all = []; let bytes = 0;
    (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else { all.push(r); bytes += fs.statSync(path.join(d, e.name)).size; } } })(pkg, '');
    const s = { token, root, pkg, at: this.now(), source, ok: ok && manifestErrors.length === 0, id: ok ? parsed.id : null };
    this.stages.set(token, s);
    const m = ok ? parsed : null;
    return {
      ok: true, token, valid: s.ok, errors: manifestErrors, warnings, source,
      files: all.length, bytes, fileList: all.slice(0, 40),
      manifest: m ? { id: m.id, name: m.name, version: m.version, description: m.description, scope: m.scope, network: m.network, permissions: m.permissions, licence: m.licence, externalRestrictions: m.externalRestrictions, command: m.command, selfTest: true } : null,
      manifestText: readText(mf), readme: readme || null, licenceFile: licenceDoc || null, exists, ...extra,
    };
  }

  async prepareFolder() {
    const src = await this.pick({ kind: 'folder' });
    if (!src) return { ok: false, error: 'cancelled' };
    const st = this._newStage();
    try {
      const real = fs.realpathSync(src);
      if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
      copyFolder(real, path.join(st.dir, 'pkg'));
      return this._preview(st.token, st.dir, path.join(st.dir, 'pkg'), { type: 'folder', name: path.basename(real) });
    } catch (e) { fs.rmSync(st.dir, { recursive: true, force: true }); return fail('import-failed', [e.message]); }
  }
  async prepareZip() {
    const src = await this.pick({ kind: 'zip' });
    if (!src) return { ok: false, error: 'cancelled' };
    const st = this._newStage();
    try {
      const real = fs.realpathSync(src);
      const stt = fs.statSync(real);
      if (!stt.isFile()) throw new Error('not a file');
      if (stt.size > LIMITS.archive) throw new Error('the archive is too large (limit ' + (LIMITS.archive >> 20) + ' MiB)');
      const buf = fs.readFileSync(real);
      unzipTo(buf, path.join(st.dir, 'pkg'));
      return this._preview(st.token, st.dir, path.join(st.dir, 'pkg'), { type: 'zip', name: path.basename(real), archiveSha256: sha256(buf) });
    } catch (e) { fs.rmSync(st.dir, { recursive: true, force: true }); return fail('import-failed', [e.message]); }
  }
  async prepareScript(form) {
    let built;
    try { built = manifestFromForm(form, 'x'); } catch (e) { return fail('bad-form', [e.message]); }       // check the form before asking for a file
    const src = await this.pick({ kind: 'file' });
    if (!src) return { ok: false, error: 'cancelled' };
    const st = this._newStage();
    try {
      const real = fs.realpathSync(src);
      const stt = fs.statSync(real);
      if (!stt.isFile()) throw new Error('not a file');
      if (stt.size > LIMITS.single) throw new Error('the file is too large (limit ' + (LIMITS.single >> 20) + ' MiB)');
      const { manifest, rel } = manifestFromForm(form, path.basename(real));
      const pkg = path.join(st.dir, 'pkg');
      fs.mkdirSync(path.join(pkg, 'run'), { recursive: true });
      fs.writeFileSync(path.join(pkg, ...rel.split('/')), fs.readFileSync(real));
      fs.writeFileSync(path.join(pkg, 'connector.json'), JSON.stringify(manifest, null, 2) + '\n');
      return this._preview(st.token, st.dir, pkg, { type: 'file', name: path.basename(real) }, { generated: true });
    } catch (e) { fs.rmSync(st.dir, { recursive: true, force: true }); return fail('import-failed', [e.message]); }
  }

  // GitHub: a repository address (https, the github.com host, /<owner>/<repo>, optionally /tree/<ref>) plus an optional tag, branch or commit. The commit is resolved first and the
  // archive of exactly that commit is downloaded, so what is shown is what lands. Only github hosts are contacted; no credentials.
  static parseRepo(url, ref) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?(?:\/tree\/([^\s?#]{1,200}))?\/?$/.exec(String(url || '').trim());
    if (!m || m[2] === '.' || m[2] === '..') return null;
    const r = ref || m[3] || 'HEAD';
    if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(r) || r.includes('..') || r.startsWith('-')) return null;
    return { owner: m[1], repo: m[2], ref: r };
  }
  async _get(url, accept, limit) {
    let u = url;
    for (let hop = 0; hop < 4; hop++) {
      const h = new URL(u);
      if (h.protocol !== 'https:' || !GH_HOSTS.includes(h.hostname)) throw new Error('refused: ' + h.hostname + ' is not a GitHub download host');
      const r = await this.fetch(u, { redirect: 'manual', headers: { 'user-agent': 'MayfairGhost', accept }, signal: AbortSignal.timeout(60000) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
      if (!r.ok) throw new Error('GitHub answered ' + r.status + (r.status === 404 ? ' (no such repository, tag or commit, or it is private)' : ''));
      const len = Number(r.headers.get('content-length') || 0);
      if (len > limit) throw new Error('the download is too large (limit ' + (limit >> 20) + ' MiB)');
      const chunks = []; let n = 0;
      const rd = r.body && r.body.getReader ? r.body.getReader() : null;
      if (rd) { for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > limit) { try { await rd.cancel(); } catch { /* closing */ } throw new Error('the download is too large (limit ' + (limit >> 20) + ' MiB)'); } chunks.push(Buffer.from(value)); } } else { const b = Buffer.from(await r.arrayBuffer()); if (b.length > limit) throw new Error('the download is too large'); chunks.push(b); }
      return Buffer.concat(chunks);
    }
    throw new Error('too many redirects');
  }
  async prepareGithub({ url, ref } = {}) {
    if (!this.fetch) return fail('no-network', ['no network client is available']);
    const p = ToolHost.parseRepo(url, ref);
    if (!p) return fail('bad-url', ['Enter a GitHub repository address: https, github.com, then owner/repo (and optionally a tag or commit).']);
    const base = 'https://' + 'api.github.com/repos/' + p.owner + '/' + p.repo;
    const st = this._newStage();
    try {
      const meta = JSON.parse((await this._get(base + '/commits/' + encodeURIComponent(p.ref), 'application/vnd.github+json', 1 << 20)).toString('utf8'));
      if (!meta || !/^[0-9a-f]{40}$/.test(meta.sha || '')) throw new Error('could not resolve a commit');
      const buf = await this._get(base + '/zipball/' + meta.sha, 'application/zip', LIMITS.archive);
      const pkg = path.join(st.dir, 'pkg');
      unzipTo(buf, pkg);
      const source = { type: 'github', repo: p.owner + '/' + p.repo, requestedRef: p.ref, commit: meta.sha, archiveSha256: sha256(buf), fetchedAt: new Date(this.now()).toISOString() };
      fs.writeFileSync(path.join(pkg, 'ghost-source.json'), JSON.stringify(source, null, 2) + '\n');         // the pin travels with the tool and is covered by its hash
      return this._preview(st.token, st.dir, pkg, source);
    } catch (e) { fs.rmSync(st.dir, { recursive: true, force: true }); return fail('import-failed', [e.message]); }
  }

  // The person has seen the preview and chose to add it: register it (copies into the tools folder). It is NOT approved or enabled.
  commit(token) {
    const s = this.stages.get(token);
    if (!s) return fail('expired', ['this import has expired: start again']);
    if (!s.ok) return fail('invalid', ['the package is not valid']);
    fs.mkdirSync(this.toolsDir, { recursive: true, mode: 0o700 });
    const r = this.manager.register(s.pkg);
    if (!r.ok) return r;
    try { // the manifest's program must be runnable by its owner on POSIX; nothing else gets an execute bit
      const l = this.manager._load(r.id);
      if (l.ok && process.platform !== 'win32') { const rel = this.manager._executableRels(l.manifest)[0]; fs.chmodSync(path.join(l.dir, ...rel.split('/')), 0o755); }
    } catch { /* a program that cannot be made executable fails its own test */ }
    this.cancel(token);
    this.log.info('tool-added', { connector: r.id, source: s.source.type });
    return { ok: true, id: r.id };
  }

  // ----- after landing -----
  // Withdraw approval when ANY file in the tool's folder differs from what was approved (the manager covers the manifest and the program).
  _checkTree(id) {
    const dir = path.join(this.toolsDir, id);
    const rec = this.manager.state.connectors[id];
    if (!rec || !rec.approval) return;
    let now = null; try { now = treeHash(dir); } catch { now = null; }
    if (!this.trees[id] || now !== this.trees[id]) {
      rec.changed = { t: this.now(), reason: 'files changed after approval' };
      rec.approval = null; rec.enabled = false; rec.disabled = false; rec.lastTest = null; rec.req = null;
      try { this.manager._save(); } catch { /* kept in memory */ }
      delete this.trees[id]; try { this._saveTrees(); } catch { /* ignore */ }
      this.log.warn('approval-revoked', { connector: id, reason: 'tree hash changed' });
    }
  }
  _ids() { return this.manager.discover().filter((id) => fs.existsSync(path.join(this.toolsDir, id, 'connector.json'))); }
  list() {
    return this._ids().map((id) => {
      this._checkTree(id);
      const a = this.manager._assess(id);
      const e = this.manager._entry(a);
      e.fields = a.l.ok ? JSON.parse(JSON.stringify(a.l.manifest.input.fields)) : [];
      let source = null; try { source = JSON.parse(fs.readFileSync(path.join(this.toolsDir, id, 'ghost-source.json'), 'utf8')); } catch { /* not from GitHub */ }
      const status = e.health === 'broken' ? 'Broken' : e.health === 'changed' ? 'Files changed: approve again' : e.install.verified === 'tested' ? 'Test passed' : e.install.verified === 'failed' ? 'Test failed' : 'Not tested';
      return { ...e, status, source: source ? { type: source.type, repo: source.repo, commit: source.commit } : null };
    });
  }
  get(id) { if (!this._ids().includes(id)) return null; this._checkTree(id); return this.manager.get(id); }
  async approve(id) {
    if (!this._ids().includes(id)) return fail('not-installed');
    const r = await this.manager.requestApproval(id);
    if (r.ok) { try { this.trees[id] = treeHash(path.join(this.toolsDir, id)); this._saveTrees(); } catch { /* without a tree hash the next check withdraws approval */ } }
    return r;
  }
  async test(id, scope) { this._checkTree(id); return this.manager.test(id, scope); }
  enable(id) { this._checkTree(id); return this.manager.enable(id); }
  disable(id) { return this.manager.disable(id); }
  run({ id, input, scope }) { if (!this._ids().includes(id)) return fail('not-installed'); this._checkTree(id); return this.runner.submit({ connector: id, input: input || {}, scope }); }
  job(jobId) { return this.runner.get(jobId); }
  cancelJob(jobId) { return this.runner.cancel(jobId); }
  async remove(id) {
    if (!this._ids().includes(id)) return fail('not-installed');
    const r = await this.manager.remove(id);
    if (r.ok) { delete this.trees[id]; try { this._saveTrees(); } catch { /* ignore */ } }
    return r;
  }
}

module.exports = { ToolHost, manifestFromForm, treeHash, unzipTo, copyFolder, LIMITS };
