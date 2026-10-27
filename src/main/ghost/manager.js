'use strict';
// Mayfair Ghost: ConnectorManager. Connectors live in <userData>/connectors/<id>/ (connector.json + the program).
// Trust model, in one place:
//   - A connector can run only when it is registered, valid, APPROVED, ENABLED and its files still match the approval.
//   - Only this (main) process approves, through a native dialog. The Mayfair page can ask (requestApproval) but there is no call that grants.
//   - The approval record stores the SHA-256 of connector.json and of the program; any difference revokes approval.
//   - "installed" is reported only after the connector's own self-test passed on the current files.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('./manifest');
const { runCheck, minimalEnv } = require('./proc');

const MANIFEST_MAX = 64 * 1024;
const AUDIT_MAX = 5 * 1024 * 1024;
const COPY_MAX_FILES = 500, COPY_MAX_BYTES = 100 * 1024 * 1024;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const within = (root, p) => p === root || p.startsWith(root + path.sep);

class ConnectorManager {
  // root: the userData folder. confirm({kind,title,message,detail,ok,cancel}) -> Promise<boolean>: the native dialog (injected so tests can answer it).
  constructor({ root, confirm, nodePath = process.execPath, nodeAvailable = true, utility = null, samplesDir = path.join(__dirname, 'samples'), log = null, now = Date.now, io = null }) {
    this.io = io;   // optional vault storage (vault/securefs.js); without it the files below are plain
    this.root = root;
    this.connectorsDir = path.join(root, 'connectors');
    this.ghostDir = path.join(root, 'ghost');
    this.stateFile = path.join(this.ghostDir, 'state.json');
    this.auditFile = path.join(this.ghostDir, 'audit.jsonl');
    this.confirm = confirm || (async () => false);        // no dialog available: nothing is ever approved
    this.nodePath = nodePath; this.nodeAvailable = nodeAvailable; this.utility = utility;   // false when the app's own node is switched off (the RunAsNode fuse in an installed build): then "@node" is never started, because that would start the app itself
    this.samplesDir = samplesDir; this.log = log; this.now = now;
    this.runner = null;
    this.pending = new Map();                               // id -> promise of a dialog that is already open
    this.hashCache = new Map();
    this.state = this._read();
  }
  setRunner(r) { this.runner = r; }

  // ---------- state file (approvals, enabled flags, test results) ----------
  _read() {
    try {
      const s = JSON.parse(this.io ? this.io.read('state.json') : fs.readFileSync(this.stateFile, 'utf8'));
      if (s && s.v === 1 && s.connectors && typeof s.connectors === 'object') return s;
    } catch { /* first start, or damaged: nothing stays approved */ }
    return { v: 1, connectors: {} };
  }
  reloadState() { this.state = this._read(); this.hashCache.clear(); }   // after the vault was unlocked
  _save() {
    if (this.io) { this.io.write('state.json', JSON.stringify(this.state, null, 1)); return; }
    fs.mkdirSync(this.ghostDir, { recursive: true });
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.stateFile);
  }
  _rec(id) { return Object.prototype.hasOwnProperty.call(this.state.connectors, id) ? this.state.connectors[id] : (this.state.connectors[id] = { approval: null, enabled: false, disabled: false, lastTest: null, req: null, changed: null }); }

  // ---------- reading a connector folder ----------
  discover() {
    let names = [];
    try { names = fs.readdirSync(this.connectorsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && M.ID_RE.test(e.name)).map((e) => e.name); } catch { /* none yet */ }
    return names.sort();
  }
  _executableRels(manifest) {
    const c = manifest.command;
    return [c.executable === M.NODE_TOKEN ? c.args[0] : c.executable, ...(c.files || [])];
  }
  // Parse and validate connector.json in <connectors>/<id>, and check that every file it names is a plain file inside the folder.
  _load(id) {
    if (typeof id !== 'string' || !M.ID_RE.test(id)) return { ok: false, errors: ['invalid connector id'] };
    const dir = path.join(this.connectorsDir, id);
    let real;
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory()) return { ok: false, errors: ['not a folder'], missing: true };
      real = fs.realpathSync(dir);
    } catch { return { ok: false, errors: ['not installed'], missing: true }; }
    const mf = path.join(dir, 'connector.json');
    let buf;
    try {
      const st = fs.lstatSync(mf);
      if (!st.isFile()) return { ok: false, errors: ['connector.json is not a plain file'] };
      if (st.size > MANIFEST_MAX) return { ok: false, errors: ['connector.json is too large'] };
      buf = fs.readFileSync(mf);
    } catch { return { ok: false, errors: ['connector.json is missing'] }; }
    let parsed;
    try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { return { ok: false, errors: ['connector.json is not valid JSON'] }; }
    const v = M.validateManifest(parsed);
    if (!v.ok) return { ok: false, errors: v.errors };
    if (v.manifest.id !== id) return { ok: false, errors: [`id "${v.manifest.id}" does not match the folder name "${id}"`] };
    const files = this._executableRels(v.manifest);
    for (const rel of files) {
      const p = path.join(dir, ...rel.split('/'));
      try {
        const st = fs.lstatSync(p);
        if (!st.isFile()) return { ok: false, errors: [`${rel} is not a plain file (links are refused)`] };
        const rp = fs.realpathSync(p);
        if (!within(real, rp)) return { ok: false, errors: [`${rel} resolves outside the connector folder`] };
      } catch { return { ok: false, errors: [`${rel} is missing`] }; }
    }
    return { ok: true, id, dir, real, manifest: v.manifest, manifestBuf: buf, files };
  }
  _hashFile(p, fresh) {
    const st = fs.statSync(p);
    const c = this.hashCache.get(p);
    if (!fresh && c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.sha;
    const sha = sha256(fs.readFileSync(p));
    this.hashCache.set(p, { size: st.size, mtimeMs: st.mtimeMs, sha });
    return sha;
  }
  _fingerprint(l, fresh) {
    const manifestSha = sha256(l.manifestBuf);
    const files = {};
    for (const rel of l.files) files[rel] = this._hashFile(path.join(l.dir, ...rel.split('/')), fresh);
    const combined = sha256(JSON.stringify([manifestSha, Object.keys(files).sort().map((k) => [k, files[k]])]));
    return { manifestSha, files, combined };
  }

  // Look at one connector now: validity, hashes, health. Revokes approval when the files are not the ones that were approved.
  _assess(id, { fresh = false } = {}) {
    const l = this._load(id);
    const rec = Object.prototype.hasOwnProperty.call(this.state.connectors, id) ? this.state.connectors[id] : null;
    let fp = null;
    if (l.ok) { try { fp = this._fingerprint(l, fresh); } catch { l.ok = false; l.errors = ['a connector file cannot be read']; } }
    if (rec && rec.approval && (!l.ok || !fp || fp.combined !== rec.approval.combined)) {
      rec.changed = { t: this.now(), reason: l.ok ? 'files changed after approval' : 'files missing or invalid after approval' };
      rec.approval = null; rec.enabled = false; rec.disabled = false; rec.lastTest = null; rec.req = null;
      try { this._save(); } catch { /* kept in memory */ }
      if (this.log) this.log.warn('approval-revoked', { connector: id, reason: rec.changed.reason });
    }
    const health = !l.ok ? 'broken' : (rec && rec.changed && !rec.approval) ? 'changed' : 'ok';
    return { id, l, fp, rec, health };
  }
  _stateOf(rec) { return !rec || !rec.approval ? 'not-approved' : rec.enabled ? 'enabled' : rec.disabled ? 'disabled' : 'approved'; }

  _requirements(a) {
    if (!a.l.ok) return [];
    const cached = a.rec && a.rec.req && a.fp && a.rec.req.combined === a.fp.combined ? a.rec.req.items : {};
    return a.l.manifest.installRequirements.map((r) => cached[r.name] ? { name: r.name, status: cached[r.name].status, detail: cached[r.name].detail } : { name: r.name, status: 'untested', detail: 'not checked yet' });
  }
  _entry(a) {
    const rec = a.rec;
    const lt = rec && rec.lastTest ? { t: rec.lastTest.t, ok: rec.lastTest.ok, detail: rec.lastTest.detail } : null;
    const verified = lt ? (lt.ok ? 'tested' : 'failed') : 'not-tested';
    if (!a.l.ok) {
      return { id: a.id, name: a.id, version: '', description: '', capabilities: [], scope: 'local', network: 'unavailable', licence: null, install: { requirements: [], installed: false, verified: 'not-tested', lastTest: null }, permissions: [], externalRestrictions: '', state: 'not-approved', approvedAt: null, health: 'broken', errors: a.l.errors.slice(0, 10) };
    }
    const m = a.l.manifest;
    const requirements = this._requirements(a);
    return {
      id: m.id, name: m.name, version: m.version, description: m.description, capabilities: [...m.capabilities], scope: m.scope, network: m.network,
      licence: { ...m.licence },
      install: { requirements, installed: verified === 'tested' && requirements.every((r) => r.status === 'ok') && a.health === 'ok', verified, lastTest: lt },
      permissions: [...m.permissions], externalRestrictions: m.externalRestrictions,
      state: this._stateOf(rec), approvedAt: rec && rec.approval ? rec.approval.at : null, health: a.health,
    };
  }

  // ---------- queries ----------
  list() { return this.discover().map((id) => this._entry(this._assess(id))); }
  get(id) {
    const a = this._assess(id);
    if (!a.l.ok && a.l.missing) return null;
    const e = this._entry(a);
    if (a.l.ok) { const m = a.l.manifest; e.input = JSON.parse(JSON.stringify(m.input)); e.limits = { ...m.limits }; e.command = { executable: m.command.executable, args: [...m.command.args] }; }
    return e;
  }
  validate(id) {
    const a = this._assess(id, { fresh: true });
    return { ok: a.l.ok && a.health === 'ok', errors: a.l.ok ? [] : a.l.errors, health: a.health };
  }

  // ---------- registering and removing ----------
  // Copy a connector folder into <userData>/connectors/<id>. Nothing is approved or enabled by registering.
  register(srcDir) {
    const mfPath = path.join(srcDir, 'connector.json');
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(mfPath, 'utf8')); } catch { return { ok: false, error: 'bad-manifest', errors: ['connector.json is missing or not valid JSON'] }; }
    const v = M.validateManifest(parsed);
    if (!v.ok) return { ok: false, error: 'bad-manifest', errors: v.errors };
    const id = v.manifest.id;
    const dest = path.join(this.connectorsDir, id);
    if (fs.existsSync(dest)) return { ok: false, error: 'exists', errors: ['a connector with this id is already installed'] };
    let files = 0, bytes = 0;
    const plan = [];
    const walk = (from, to) => {
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        const a = path.join(from, e.name), b = path.join(to, e.name);
        if (e.isSymbolicLink()) throw new Error('links are not allowed inside a connector: ' + e.name);
        if (e.isDirectory()) { plan.push({ dir: b }); walk(a, b); } else if (e.isFile()) { const st = fs.statSync(a); files++; bytes += st.size; if (files > COPY_MAX_FILES || bytes > COPY_MAX_BYTES) throw new Error('connector folder is too large'); plan.push({ from: a, to: b, mode: st.mode & 0o777 }); } else throw new Error('unsupported file type: ' + e.name);
      }
    };
    try {
      walk(srcDir, dest);
      fs.mkdirSync(dest, { recursive: true });
      for (const p of plan) { if (p.dir) fs.mkdirSync(p.dir, { recursive: true }); else fs.writeFileSync(p.to, fs.readFileSync(p.from), { mode: p.mode || 0o644 }); }
    } catch (e) { fs.rmSync(dest, { recursive: true, force: true }); return { ok: false, error: 'copy-failed', errors: [e.message] }; }
    const a = this._assess(id, { fresh: true });
    if (!a.l.ok) { fs.rmSync(dest, { recursive: true, force: true }); return { ok: false, error: 'bad-manifest', errors: a.l.errors }; }
    if (this.log) this.log.info('registered', { connector: id, version: v.manifest.version });
    return { ok: true, id };
  }
  installSample() {
    const id = 'sample-textstats';
    if (fs.existsSync(path.join(this.connectorsDir, id))) return { ok: true, id, alreadyInstalled: true };
    const r = this.register(path.join(this.samplesDir, id));
    return r.ok ? { ok: true, id } : r;
  }
  async remove(id) {
    if (typeof id !== 'string' || !M.ID_RE.test(id)) return { ok: false, error: 'bad-id' };
    const a = this._assess(id);
    if (a.l.missing) return { ok: false, error: 'not-installed' };
    const name = a.l.ok ? a.l.manifest.name : id;
    const yes = await this.confirm({ kind: 'remove', title: 'Remove connector', message: `Remove the connector "${name}"?`, detail: 'Its files and its approval are deleted from this computer. Past results stay in the job history.', ok: 'Remove', cancel: 'Cancel' });
    if (yes !== true) return { ok: false, error: 'declined' };
    if (this.runner) this.runner.cancelConnector(id);
    const dir = path.join(this.connectorsDir, id);
    if (!within(this.connectorsDir, path.resolve(dir)) || path.resolve(dir) === this.connectorsDir) return { ok: false, error: 'bad-id' };
    fs.rmSync(dir, { recursive: true, force: true });
    delete this.state.connectors[id];
    this._save();
    if (this.log) this.log.info('removed', { connector: id });
    return { ok: true };
  }

  // ---------- approval: the only way in is the native dialog ----------
  _approvalText(m) {
    const scopeNote = { local: 'local: works only on data on this computer', passive: 'passive: reads public information, does not touch the target', active: 'ACTIVE: interacts with a target system; every run needs your confirmation that you are authorised, and is written to an audit log' }[m.scope];
    const netNote = { local: 'none (stays on this computer)', 'keyless-external': 'contacts external services without an account key', 'rate-limited': 'contacts external services that limit how often they can be used', unavailable: 'needs a network service that is not available at the moment' }[m.network];
    return [
      `Scope: ${scopeNote}`, `Network: ${m.network} (${netNote})`, `Permissions: ${m.permissions.length ? m.permissions.join(', ') : 'none'}`,
      `Licence: ${m.licence.spdx} (${m.licence.mode === 'bundled' ? 'included with this connector' : 'a separate program with its own licence'})`,
      `Restrictions: ${m.externalRestrictions}`, '',
      'The connector runs as a separate program under your account. If any of its files change later, this approval is withdrawn automatically.',
    ].join('\n');
  }
  // The page may ask. Only the user, in the native dialog, can say yes.
  requestApproval(id) {
    if (typeof id !== 'string' || !M.ID_RE.test(id)) return Promise.resolve({ ok: false, error: 'bad-id' });
    if (this.pending.has(id)) return this.pending.get(id);
    const p = this._requestApproval(id).finally(() => this.pending.delete(id));
    this.pending.set(id, p);
    return p;
  }
  async _requestApproval(id) {
    const a = this._assess(id, { fresh: true });
    if (!a.l.ok) return { ok: false, error: 'invalid', errors: a.l.errors };
    if (a.rec && a.rec.approval) return { ok: true, state: this._stateOf(a.rec), already: true };
    const m = a.l.manifest;
    const yes = await this.confirm({ kind: 'approve', title: 'Approve connector', message: `Allow the connector "${m.name}" (version ${m.version}) to run on this computer?`, detail: this._approvalText(m), ok: 'Approve', cancel: 'Cancel', scope: m.scope });
    if (yes !== true) { if (this.log) this.log.info('approval-declined', { connector: id }); return { ok: false, error: 'declined' }; }
    // the files may have changed while the dialog was open: approve exactly what was shown
    const b = this._assess(id, { fresh: true });
    if (!b.l.ok || !b.fp || b.fp.combined !== a.fp.combined) return { ok: false, error: 'changed-during-approval' };
    const rec = this._rec(id);
    rec.approval = { at: this.now(), version: m.version, scope: m.scope, network: m.network, permissions: [...m.permissions], manifestSha: b.fp.manifestSha, files: b.fp.files, combined: b.fp.combined };
    rec.enabled = false; rec.disabled = false; rec.changed = null; rec.lastTest = null; rec.req = null;
    this._save();
    if (this.log) this.log.info('approved', { connector: id, version: m.version, scope: m.scope, network: m.network });
    return { ok: true, state: this._stateOf(rec) };
  }
  // In-process only (not reachable from the bridge): used by tests and by the smoke hook, which stand in for the dialog.
  _approvedBy(rec) { return !!(rec && rec.approval); }

  enable(id) {
    const a = this._assess(id, { fresh: true });
    if (!a.l.ok) return { ok: false, error: 'invalid' };
    if (!this._approvedBy(a.rec)) return { ok: false, error: 'not-approved' };
    a.rec.enabled = true; a.rec.disabled = false; this._save();
    if (this.log) this.log.info('enabled', { connector: id });
    return { ok: true, state: 'enabled' };
  }
  disable(id) {
    const a = this._assess(id);
    if (a.l.missing) return { ok: false, error: 'not-installed' };
    if (!this._approvedBy(a.rec)) return { ok: true, state: 'not-approved' };
    a.rec.enabled = false; a.rec.disabled = true; this._save();
    if (this.runner) this.runner.cancelConnector(id);
    if (this.log) this.log.info('disabled', { connector: id });
    return { ok: true, state: 'disabled' };
  }

  // Run the install requirement checks (argv arrays, no shell). Only for approved connectors: an unapproved connector's commands never run.
  async checkRequirements(id) {
    const a = this._assess(id, { fresh: true });
    if (!a.l.ok || !this._approvedBy(a.rec)) return this._requirements(a);
    const items = {};
    for (const r of a.l.manifest.installRequirements) {
      const viaUtility = r.check[0] === M.NODE_TOKEN && !this.nodeAvailable && this.utility;
      const res = viaUtility ? await this.utility.runCheck({ argv: r.check, cwd: a.l.dir, resolveRel: (rel) => this._resolveInside(a.l, rel) })
        : await runCheck({ argv: r.check, cwd: a.l.dir, nodePath: this.nodeAvailable ? this.nodePath : null, resolveRel: (rel) => this._resolveInside(a.l, rel) });
      items[r.name] = { ...res, t: this.now() };
    }
    const b = this._assess(id);
    if (b.rec && b.rec.approval && b.fp && b.fp.combined === a.fp.combined) { b.rec.req = { combined: a.fp.combined, items }; this._save(); }
    return a.l.manifest.installRequirements.map((r) => ({ name: r.name, status: items[r.name].status, detail: items[r.name].detail }));
  }
  _resolveInside(l, rel) {
    if (M.relPathError(rel)) return null;
    const p = path.join(l.dir, ...rel.split('/'));
    try { const rp = fs.realpathSync(p); return within(l.real, rp) ? rp : null; } catch { return null; }
  }

  // ---------- self-test ----------
  async test(id, scope) {
    const a = this._assess(id, { fresh: true });
    if (!a.l.ok) return { ok: false, error: 'invalid', errors: a.l.errors };
    if (!this._approvedBy(a.rec)) return { ok: false, error: 'not-approved' };
    const m = a.l.manifest;
    const reqs = await this.checkRequirements(id);
    const missing = reqs.filter((r) => r.status !== 'ok');
    let ok = false, detail = '';
    if (missing.length) detail = 'requirement not met: ' + missing.map((r) => r.name + (r.detail ? ' (' + r.detail + ')' : '')).join('; ');
    else if (m.network === 'unavailable') detail = 'the network service this connector needs is not available';
    else if (m.command.executable === M.NODE_TOKEN && !this.nodeAvailable && !this.utility) detail = 'this build of the app has its built-in Node runtime switched off';
    else if (!this.runner) detail = 'no job runner';
    else {
      const sub = this.runner.submit({ connector: id, input: m.selfTest.input, scope, kind: 'selftest' });
      if (!sub.ok) detail = 'could not start: ' + (sub.message || sub.error);
      else {
        const job = await this.runner.wait(sub.jobId);
        const ev = evaluateSelfTest(m, job);
        ok = ev.ok; detail = ev.detail;
      }
    }
    const b = this._assess(id, { fresh: true });
    if (!b.l.ok || !b.fp || b.fp.combined !== a.fp.combined || !this._approvedBy(b.rec)) return { ok: false, error: 'changed-during-test' };
    b.rec.lastTest = { t: this.now(), ok, detail, hash: a.fp.combined };
    this._save();
    if (this.log) this.log.info('self-test', { connector: id, ok, detail });
    return { ok: true, passed: ok, verified: ok ? 'tested' : 'failed', lastTest: { t: b.rec.lastTest.t, ok, detail } };
  }

  // ---------- the gate every run passes ----------
  // Returns {ok:false, error, message} or {ok:true, spec}. `picks` is the PickStore for file inputs.
  prepareRun(id, input, scope, { picks = null, selftest = false } = {}) {
    const no = (error, message) => ({ ok: false, error, message });
    if (typeof id !== 'string' || !M.ID_RE.test(id)) return no('bad-id', 'invalid connector id');
    const a = this._assess(id, { fresh: true });                   // the files are hashed again for every run
    if (!a.l.ok) return no('broken', 'the connector files are missing or invalid');
    if (a.health !== 'ok') return no('changed', 'the connector files changed since approval: approve it again');
    if (!this._approvedBy(a.rec)) return no('not-approved', 'the connector is not approved');
    if (!selftest && !a.rec.enabled) return no('not-enabled', 'the connector is not enabled');
    const m = a.l.manifest;
    if (m.network === 'unavailable') return no('network-unavailable', 'the network service this connector needs is not available');
    if (m.command.executable === M.NODE_TOKEN && !this.nodeAvailable && !this.utility) return no('runtime-unavailable', 'this build of the app has its built-in Node runtime switched off, so this connector cannot run');
    const vi = M.validateInput(m, input === undefined ? {} : input);
    if (!vi.ok) return { ok: false, error: 'bad-input', message: vi.errors[0], errors: vi.errors };
    // scope guard: an ACTIVE connector needs a declaration for this run
    let declared = null;
    if (m.scope === 'active') {
      if (!M.isObj(scope)) return no('scope-required', 'an active connector needs a scope declaration {target, confirmedAuthorised:true} for every run');
      const extra = Object.keys(scope).filter((k) => k !== 'target' && k !== 'confirmedAuthorised');
      if (extra.length || typeof scope.target !== 'string' || !scope.target.trim() || scope.target.length > 253 || scope.confirmedAuthorised !== true) return no('scope-required', 'the scope declaration must be exactly {target, confirmedAuthorised:true}');
      const hostFields = m.input.fields.filter((f) => f.type === 'url-host').map((f) => vi.values[f.name]).filter(Boolean);
      if (hostFields.length && !hostFields.includes(scope.target.trim().toLowerCase())) return no('scope-mismatch', 'the declared target is not the target in the input');
      declared = { target: scope.target.trim(), confirmedAuthorised: true };
    }
    // file inputs: one-time picker tokens become paths here and nowhere else
    const values = { ...vi.values };
    const tokens = [];
    for (const f of m.input.fields.filter((x) => x.type === 'file')) {
      if (values[f.name] === undefined) continue;
      const pk = picks ? picks.peek(values[f.name]) : null;
      if (!pk) return no('bad-input', `input.${f.name}: the picked file is no longer available; pick it again`);
      let st, rp;
      try { rp = fs.realpathSync(pk.path); st = fs.statSync(rp); } catch { return no('bad-input', `input.${f.name}: the picked file cannot be read`); }
      if (!st.isFile()) return no('bad-input', `input.${f.name}: not a regular file`);
      if (st.size > (f.maxBytes || 50 * 1024 * 1024)) return no('bad-input', `input.${f.name}: the file is larger than allowed`);
      tokens.push(values[f.name]);
      values[f.name] = rp;
    }
    const ex = M.expandArgs(m, values);
    if (!ex.ok) return no('bad-input', ex.error);
    for (const t of tokens) picks.take(t);
    // command
    let exe, args = ex.args, runtime = 'process', execArgv = [];
    if (m.command.executable === M.NODE_TOKEN && !this.nodeAvailable) {
      // installed build (RunAsNode fuse off): the script runs in a utility process, same arguments, same limits
      runtime = 'utility'; exe = path.join(a.l.dir, ...args[0].split('/')); args = args.slice(1);
      if (m.limits.maxMemoryMb) execArgv = [`--max-old-space-size=${m.limits.maxMemoryMb}`];
    } else if (m.command.executable === M.NODE_TOKEN) {
      exe = this.nodePath;
      args = [...(m.limits.maxMemoryMb ? [`--max-old-space-size=${m.limits.maxMemoryMb}`] : []), path.join(a.l.dir, ...args[0].split('/')), ...args.slice(1)];
    } else exe = path.join(a.l.dir, ...m.command.executable.split('/'));
    const sensitive = m.input.fields.filter((f) => f.sensitive);
    const secrets = sensitive.map((f) => (values[f.name] === undefined ? null : String(values[f.name]))).filter(Boolean);
    const summary = {};
    for (const f of m.input.fields) {
      if (values[f.name] === undefined) continue;
      summary[f.name] = f.sensitive ? '***' : f.type === 'file' ? path.basename(String(values[f.name])) : String(values[f.name]).slice(0, 200);
    }
    return { ok: true, spec: { id, version: m.version, dir: a.l.dir, exe, args, runtime, execArgv, node: m.command.executable === M.NODE_TOKEN && runtime === 'process', limits: { ...m.limits }, manifest: m, secrets, summary, scope: declared, scopeKind: m.scope, combined: a.fp.combined } };
  }

  // Just before a queued job starts: the files must still be the approved ones.
  stillValid(spec, selftest = false) {
    const a = this._assess(spec.id, { fresh: true });
    return a.l.ok && a.health === 'ok' && this._approvedBy(a.rec) && a.fp.combined === spec.combined && (selftest || !!a.rec.enabled);
  }

  // Every active run is appended here before it starts. If the audit line cannot be written the run does not start.
  audit(entry) {
    try {
      if (this.io) { this.io.append('audit.jsonl', JSON.stringify({ t: this.now(), ...entry }) + '\n', { maxBytes: AUDIT_MAX, keep: 2 }); return true; }
      fs.mkdirSync(this.ghostDir, { recursive: true });
      try { if (fs.statSync(this.auditFile).size > AUDIT_MAX) fs.renameSync(this.auditFile, this.auditFile + '.1'); } catch { /* none yet */ }
      fs.appendFileSync(this.auditFile, JSON.stringify({ t: this.now(), ...entry }) + '\n', { mode: 0o600 });
      return true;
    } catch { return false; }
  }
}

// A self-test passes only when the job really finished with valid results and every expectation holds.
function evaluateSelfTest(manifest, job) {
  if (!job) return { ok: false, detail: 'the self-test did not run' };
  if (job.status !== 'done') return { ok: false, detail: `the self-test ${job.status}${job.error ? ': ' + job.error : ''}` };
  const ex = manifest.selfTest.expect;
  if (job.rejected) return { ok: false, detail: `${job.rejected} output line(s) were rejected: ${(job.errors[0] || {}).error || ''}` };
  if (ex.minResults !== undefined && job.resultCount < ex.minResults) return { ok: false, detail: `expected at least ${ex.minResults} results, got ${job.resultCount}` };
  for (const c of ex.contains || []) {
    if (!job.results.some((r) => r.entity.type === c.type && r.entity.value === c.value)) return { ok: false, detail: `expected result ${c.type}=${String(c.value).slice(0, 40)} was not produced` };
  }
  return { ok: true, detail: `passed: ${job.resultCount} result(s) as expected` };
}

module.exports = { ConnectorManager, evaluateSelfTest, sha256, minimalEnv };
