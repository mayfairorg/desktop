'use strict';
// Ghost virtual computer: the TOOL INSTALLER ("Add a tool" on the Tool Integrations screen).
//
// Where tools live:   inside the virtual computer, on its persistent tools disk: /opt/ghost-tools/<name>. They survive a reset of the machine's
//                     own disk and go only when the person wipes the tools disk or removes the tool. Nothing from a tool is ever written on
//                     this computer, except the small connector description (connector.json + ghost-vm.json) of a tool that was registered.
// Where they come from:  a GitHub address (optionally a tag, branch or commit) cloned INSIDE the machine, or a folder, a .zip or one script the
//                     person picks (copied into the machine as data). Either way the tool is pinned to a commit: an upload is committed to a
//                     private git history inside the machine so it can be checked the same way.
// What the person sees first:  the README and licence, the file list, the pinned commit, a SHA-256 of the files, and the setup commands Ghost
//                     would offer (python, node, go, rust, make). Ghost never runs a command from a README. A setup command runs only when the
//                     person presses its button, and the page can only name a command by the id Ghost gave it: the page never supplies one.
// Registering:         the person describes how the tool is run (program, arguments, one input, what kind of output); Ghost writes a connector
//                     description that runs INSIDE the machine (argv only, JSON lines out; plain-text or JSON output goes through ghost-wrap).
//                     The connector is not approved: the existing native approval dialog does that, and it names the machine and the commit.
// Updating:            fetch a newer commit, show what changed, then re-pin. The pin is part of what was approved, so approval is withdrawn
//                     and the person approves again.
// No blocklist, no name or address checks beyond "is this a valid GitHub address", and no tool of any kind is named, listed or suggested here.
//
// `vm` is a VmService (or a stand-in with the same few members): ensureRunning(), exec(argv, opts), execStream(argv, opts), agent.put/rmtree, status().
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('../manifest');
const { readZip } = require('../../lib/zip');
const GH = require('./github');

const TOOLS = '/opt/ghost-tools';
const LIMITS = { files: 1000, bytes: 64 * 1024 * 1024, single: 16 * 1024 * 1024, stages: 4, output: 64 * 1024, setupMs: 30 * 60 * 1000 };
const SEG_RE = /^[A-Za-z0-9._@+=-][A-Za-z0-9._ @+=,-]{0,99}$/;
const PROGRAMS = ['python3', 'node', 'go', 'cargo', 'make'];            // plain program names a connector may name (everything else is a path inside the tool folder)
const OUTPUTS = ['jsonl', 'lines', 'json'];
const SPDX_RE = /^[A-Za-z0-9.+() -]{1,100}$/;
const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
const errMsg = (e) => String((e && e.message) || e || 'failed').replace(/^Error: /, '').slice(0, 300);

// Hash of the tool's own files: every file except git data and the environments setup creates. Computed inside the machine.
const TREE_HASH = 'cd "$1" || exit 3; find . \\( -name .git -o -name .venv -o -name node_modules -o -name target -o -name __pycache__ -o -name .ghost-pin.json \\) -prune -o -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1';
const PRESENT = 'for d in "$@"; do [ -d "$d" ] && echo "$d"; done; exit 0';

const toolName = (owner, repo) => String(owner + '-' + repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
const guestDir = (name) => TOOLS + '/' + name;
const shortHash = (s) => String(s || '').slice(0, 12);

// ---- the connector description (pure; exported for tests)
// form: {id?, title?, description?, program, args:[template], output:'jsonl'|'lines'|'json', entityType?, inputLabel?, network, scope, licence, restrictions?, timeoutSec?, selfTestInput?}
// tool: {name, commit, version?}.  -> {manifest, marker}
function buildConnector(tool, form) {
  if (!form || typeof form !== 'object') throw new Error('the form is missing');
  const id = String(form.id || tool.name);
  if (!M.ID_RE.test(id)) throw new Error('the connector name must be 1 to 40 letters, digits or hyphens');
  if (guestDir(id) !== guestDir(tool.name)) throw new Error('the connector name must be the tool name (' + tool.name + ')');
  const output = form.output || 'lines';
  if (!OUTPUTS.includes(output)) throw new Error('output is jsonl, lines or json');
  const net = form.network || 'local', scope = form.scope || 'local';
  if (!M.NETWORKS.includes(net) || net === 'unavailable') throw new Error('network: ' + M.NETWORKS.filter((n) => n !== 'unavailable').join(', '));
  if (!M.SCOPES.includes(scope)) throw new Error('scope: ' + M.SCOPES.join(', '));
  if (!SPDX_RE.test(String(form.licence || ''))) throw new Error('licence: enter an SPDX identifier such as MIT, Apache-2.0 or GPL-3.0-only (or NOASSERTION when you do not know)');
  const program = String(form.program || '');
  let exe;
  if (PROGRAMS.includes(program)) exe = program;
  else {
    const e = M.relPathError(program);
    if (e) throw new Error('program: a plain program name (' + PROGRAMS.join(', ') + ') or a path inside the tool folder; ' + e);
    exe = guestDir(tool.name) + '/' + program;
  }
  const args = Array.isArray(form.args) ? form.args.map(String).filter((a) => a !== '') : [];
  if (args.length > 20) throw new Error('at most 20 arguments');
  const hasInput = typeof form.inputLabel === 'string' && form.inputLabel.trim() !== '';
  const type = String(form.entityType || 'text');
  if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(type)) throw new Error('result type: lowercase letters, digits, dot, dash, underscore (up to 40)');
  const version = /^\d+\.\d+\.\d+$/.test(String(tool.version || '')) ? tool.version : '1.0.0';
  const wrapped = output !== 'jsonl';
  const cmdArgs = wrapped ? ['--as', output, '--type', type, '--tool', tool.name, '--version', version, '--', exe, ...args] : args;
  const m = {
    id, name: String(form.title || tool.name).slice(0, 80), version, description: String(form.description || 'A tool in the Ghost virtual computer: ' + tool.name).slice(0, 500),
    capabilities: ['user-tool', 'virtual-computer'], scope, network: net,
    licence: { spdx: form.licence, url: 'https://' + 'spdx.org/licenses/' + (/^[A-Za-z0-9.+-]+$/.test(form.licence) ? form.licence + '.html' : ''), mode: 'separate-program' },
    installRequirements: [{ name: 'Tool files in the virtual computer', check: ['test', '-d', guestDir(tool.name)] }],
    command: { executable: 'ghost-vm.json', args: cmdArgs },
    input: { fields: hasInput ? [{ name: 'text', type: 'string', label: String(form.inputLabel).trim().slice(0, 80), maxLength: 1000 }] : [] },
    output: { format: 'jsonl' },
    limits: { timeoutMs: Math.min(1800000, Math.max(1000, Math.round((+form.timeoutSec || 120) * 1000))), maxOutputBytes: 4 * 1024 * 1024, maxConcurrent: 1 },
    permissions: net === 'local' ? [] : ['network'],
    externalRestrictions: String(form.restrictions || 'None stated.').slice(0, 1000),
    selfTest: { input: hasInput ? { text: String(form.selfTestInput || 'test').slice(0, 1000) } : {}, expect: { minResults: 1 } },
  };
  const v = M.validateManifest(m);
  if (!v.ok) throw new Error(v.errors[0]);
  return { manifest: m, marker: { v: 1, mode: 'pin', guestDir: guestDir(tool.name), commit: tool.commit, exe: wrapped ? 'ghost-wrap' : exe } };
}

class VmToolInstaller {
  // dir: <Ghost data>/vm (tools.json lives there). manager: the Ghost ConnectorManager. library: a ToolLibrary. confirm: native dialog. pick({kind}) -> path|null (native picker).
  constructor({ vm, manager, library, dir, confirm = async () => false, pick = async () => null, now = Date.now, log = null }) {
    this.vm = vm; this.manager = manager; this.library = library; this.confirm = confirm; this.pick = pick; this.now = now; this.log = log;
    this.file = path.join(dir, 'tools.json'); this.state = this._read();
    this.stages = new Map();           // token -> {name, dir, source, commit, at, suggestions}
    this.suggestions = new Map();      // name -> suggestions (what the setup buttons can run)
    this.runs = new Map();             // runId -> {name, status, output, current, steps, handle, cancelled}
    this.busy = false; this.importJob = null;
  }
  _read() { try { const d = JSON.parse(fs.readFileSync(this.file, 'utf8')); return d && d.v === 1 && d.tools && typeof d.tools === 'object' ? d : { v: 1, tools: {} }; } catch { return { v: 1, tools: {} }; } }
  _save() { fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); }
  _rec(name) { return Object.prototype.hasOwnProperty.call(this.state.tools, name) ? this.state.tools[name] : null; }
  async _exclusive(fn) {
    if (this.busy) return fail('busy', 'Another tool step is still running. Wait for it to finish.');
    this.busy = true;
    try { return await fn(); } catch (e) { return fail(e.code || 'error', errMsg(e)); } finally { this.busy = false; }
  }

  // ------------------------------------------------------------------ listing
  list() {
    let conns = []; try { conns = this.manager.list(); } catch { /* none */ }
    const byId = new Map(conns.map((c) => [c.id, c]));
    return Object.entries(this.state.tools).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, t]) => {
      const c = t.connector ? byId.get(t.connector) : null;
      return { name, guestDir: guestDir(name), source: t.source, commit: t.commit, checksum: t.checksum, version: t.version || '', installedAt: t.installedAt, updatedAt: t.updatedAt || t.installedAt, licence: t.licence || '',
        registered: !!t.connector, connector: c || null, present: t.present === undefined ? null : t.present };
    });
  }
  // Looks inside the machine for the tool folders (only when it is running; it is never started just to look).
  async verifyPresent() {
    if (this.vm.status && this.vm.status().state !== 'running') return this.list();
    const names = Object.keys(this.state.tools);
    if (!names.length) return [];
    try {
      const r = await this.vm.runArgv(['sh', '-c', PRESENT, 'sh', ...names.map(guestDir)], { timeoutMs: 15000 });
      const here = new Set(r.stdout.split('\n').filter(Boolean));
      for (const n of names) this.state.tools[n].present = here.has(guestDir(n));
      this._save();
    } catch { /* leave unknown */ }
    return this.list();
  }

  // ------------------------------------------------------------------ adding: GitHub
  async prepareGithub({ url, ref, name } = {}) {
    return this._exclusive(async () => {
      const p = GH.parseRepo(url, ref);
      if (!p) return fail('bad-url', 'Enter a GitHub repository address: https://github.com/owner/repo (and optionally a tag, branch or commit).');
      const nm = name ? String(name) : toolName(p.owner, p.repo);
      if (!M.ID_RE.test(nm)) return fail('bad-name', 'A tool name is 1 to 40 letters, digits or hyphens.');
      if (this._rec(nm)) return fail('exists', 'A tool named "' + nm + '" is already added. Remove it first, or choose another name.');
      await this.vm.ensureRunning();
      this._dropStalePending(nm);
      const dir = guestDir(nm);
      let got;
      try { got = await GH.cloneInto(this.vm, p, dir); } catch (e) { await this._discard(dir); return fail('clone-failed', errMsg(e)); }
      return this._preview({ name: nm, dir, source: { type: 'github', url: p.https, repo: p.owner + '/' + p.repo, ref: p.ref }, commit: got.commit });
    });
  }

  // ------------------------------------------------------------------ adding: upload
  async prepareUpload({ kind, name } = {}) {
    if (!['folder', 'zip', 'script'].includes(kind)) return fail('bad-input', 'Choose a folder, a .zip or a script.');
    return this._exclusive(async () => {
      const src = await this.pick({ kind });
      if (!src) return fail('cancelled', 'Cancelled.');
      const real = fs.realpathSync(src); const st = fs.statSync(real);
      const base = path.basename(real).replace(/\.zip$/i, '');
      const nm = name ? String(name) : toolName('upload', base).replace(/^upload-/, '') || 'tool';
      if (!M.ID_RE.test(nm)) return fail('bad-name', 'A tool name is 1 to 40 letters, digits or hyphens. Give it a name.');
      if (this._rec(nm)) return fail('exists', 'A tool named "' + nm + '" is already added. Remove it first, or choose another name.');
      const files = this._readUpload(kind, real, st);       // [{rel, data, exec}] (host side, data only)
      await this.vm.ensureRunning();
      this._dropStalePending(nm);
      const dir = guestDir(nm);
      try {
        await this.vm.agent.rmtree(dir).catch(() => {});
        await this._ok(['mkdir', '-p', dir]);
        for (const f of files) await this.vm.agent.put(dir + '/' + f.rel, f.data, { mode: f.exec ? 0o755 : 0o644 });
        const git = ['git', '-C', dir, '-c', 'core.hooksPath=/dev/null'];
        await this._ok([...git, 'init', '-q']);
        await this._ok([...git, 'add', '-A']);
        await this._ok([...git, '-c', 'user.name=Ghost', '-c', 'user.email=ghost@localhost', 'commit', '-q', '--allow-empty', '-m', 'Files as added to Ghost']);
        const head = await this._ok([...git, 'rev-parse', 'HEAD']);
        return await this._preview({ name: nm, dir, source: { type: 'upload', name: path.basename(real).slice(0, 120) }, commit: head.stdout.trim() });
      } catch (e) { await this._discard(dir); return fail('upload-failed', errMsg(e)); }
    });
  }
  _readUpload(kind, real, st) {
    const out = []; let bytes = 0;
    const take = (rel, data, exec) => {
      if (out.length >= LIMITS.files) throw new Error('too many files (limit ' + LIMITS.files + ')');
      bytes += data.length; if (data.length > LIMITS.single || bytes > LIMITS.bytes) throw new Error('too large (limits: ' + (LIMITS.single >> 20) + ' MiB a file, ' + (LIMITS.bytes >> 20) + ' MiB in all)');
      const segs = rel.split('/');
      if (segs.some((s) => !SEG_RE.test(s) || s === '.git' || s === '..')) throw new Error('a file name is not allowed: ' + rel.slice(0, 60));
      out.push({ rel, data, exec });
    };
    if (kind === 'script') {
      if (!st.isFile()) throw new Error('not a file');
      take(path.basename(real), fs.readFileSync(real), true);
    } else if (kind === 'zip') {
      if (!st.isFile()) throw new Error('not a file');
      if (st.size > LIMITS.bytes) throw new Error('the archive is too large');
      let es = readZip(fs.readFileSync(real), { entries: LIMITS.files, total: LIMITS.bytes, single: LIMITS.single });
      const names = es.map((e) => e.name), tops = new Set(names.map((n) => n.split('/')[0]));
      if (tops.size === 1 && names.every((n) => n.includes('/'))) { const t = [...tops][0] + '/'; es = es.map((e) => ({ name: e.name.slice(t.length), data: e.data })); }
      for (const e of es) { if (e.name.startsWith('.git/') || /(^|\/)\.DS_Store$/.test(e.name)) continue; take(e.name, e.data, false); }
    } else {
      if (!st.isDirectory()) throw new Error('not a folder');
      const walk = (d, rel) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === '.git' || e.name === '.DS_Store') continue;
          const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
          if (e.isSymbolicLink()) throw new Error('links are not allowed inside a tool: ' + r.slice(0, 60));
          if (e.isDirectory()) walk(p, r); else if (e.isFile()) take(r, fs.readFileSync(p), process.platform !== 'win32' && (fs.statSync(p).mode & 0o111) !== 0); else throw new Error('unsupported file type: ' + r.slice(0, 60));
        }
      };
      walk(real, '');
    }
    return out;
  }

  // ------------------------------------------------------------------ the preview shown before anything is kept
  async _ok(argv, opts = {}) {
    const r = await this.vm.runArgv(argv, { timeoutMs: 300000, ...opts });
    if (r.code !== 0) throw new Error((argv[0] === 'git' ? 'git ' + (argv.find((a) => ['init', 'add', 'commit', 'rev-parse', 'fetch', 'checkout', 'reset'].includes(a)) || '') : argv[0]).trim() + ' failed: ' + (r.stderr.trim().split('\n').pop() || 'exit code ' + r.code).slice(0, 200));
    return r;
  }
  async _discard(dir) { try { await this.vm.agent.rmtree(dir); } catch { /* nothing there */ } }
  _dropStalePending(name) { for (const [t, s] of this.stages) if (s.name === name) this.stages.delete(t); }
  async _checksum(dir) {
    const r = await this.vm.runArgv(['sh', '-c', TREE_HASH, 'sh', dir], { timeoutMs: 120000 });
    const v = r.stdout.trim();
    if (r.code !== 0 || !/^[0-9a-f]{64}$/.test(v)) throw new Error('could not compute the checksum of the files');
    return v;
  }
  async _preview({ name, dir, source, commit }) {
    while (this.stages.size >= LIMITS.stages) { const [t, s] = this.stages.entries().next().value; this.stages.delete(t); await this._discard(s.dir); }
    const ins = await GH.inspectDir(this.vm, dir);
    let programs = {}; try { programs = await GH.probePrograms(this.vm); } catch { /* unknown */ }
    const suggestions = GH.suggest(ins, dir, programs);
    const checksum = await this._checksum(dir);
    const token = crypto.randomBytes(12).toString('hex');
    this.stages.set(token, { name, dir, source, commit, checksum, at: this.now(), suggestions, licence: guessLicence(ins.licence && ins.licence.text) });
    return { ok: true, token, name, guestDir: dir, source, commit, checksum, files: ins.files.filter((f) => f !== '.git').slice(0, 200), readme: ins.readme, licenceFile: ins.licence, licenceGuess: guessLicence(ins.licence && ins.licence.text),
      detected: GH.detect(ins), suggestions: suggestions.map(publicSuggestion), note: 'Nothing has been run. These files are in the virtual computer only. Setup commands run when you press their button.' };
  }
  async cancel(token) {
    const s = this.stages.get(token); if (!s) return { ok: true };
    this.stages.delete(token);
    if (!this._rec(s.name)) await this._discard(s.dir);
    return { ok: true };
  }
  // The person saw the preview and keeps the tool: it is recorded here and in the library list. It is not registered as a connector yet.
  async commit(token) {
    const s = this.stages.get(token);
    if (!s) return fail('expired', 'This step expired. Add the tool again.');
    if (this._rec(s.name)) return fail('exists', 'A tool with this name is already added.');
    this.stages.delete(token);
    const t = new Date(this.now()).toISOString();
    this.state.tools[s.name] = { source: s.source, commit: s.commit, checksum: { algo: 'sha256', value: s.checksum }, installedAt: t, licence: s.licence || '', connector: null, present: true };
    this.suggestions.set(s.name, s.suggestions);
    this._save();
    try { this.library.put(this._libEntry(s.name)); } catch (e) { return { ok: true, name: s.name, warning: 'The tool is added but the library list could not be saved: ' + errMsg(e) }; }
    try { await this.vm.agent.put(s.dir + '/.ghost-pin.json', JSON.stringify({ type: s.source.type, source: s.source, commit: s.commit, checksum: s.checksum, pinnedAt: t }, null, 2) + '\n'); } catch { /* the pin is also in tools.json */ }
    return { ok: true, name: s.name, commit: s.commit, suggestions: s.suggestions.map(publicSuggestion) };
  }
  _libEntry(name) {
    const t = this.state.tools[name];
    return { name, source: t.source.type === 'github' ? { type: 'github', url: t.source.url, repo: t.source.repo, ...(t.source.ref ? { ref: t.source.ref } : {}) } : { type: 'upload', name: t.source.name },
      commit: t.commit, checksum: t.checksum, ...(t.version ? { version: t.version } : {}), ...(t.notes && t.notes.length ? { notes: t.notes.slice(-30) } : {}),
      ...(t.setup && t.setup.length ? { setup: t.setup.slice(-20) } : {}), ...(t.licence ? { licence: t.licence } : {}), ...(t.form ? { connector: t.form } : {}) };
  }
  // Suggestions are rebuilt from the files in the machine when the person asks again (after a restart of the app).
  async setupOptions(name) {
    if (!this._rec(name)) return fail('not-installed', 'No such tool.');
    return this._exclusive(async () => {
      await this.vm.ensureRunning();
      const dir = guestDir(name);
      const ins = await GH.inspectDir(this.vm, dir);
      let programs = {}; try { programs = await GH.probePrograms(this.vm); } catch { /* unknown */ }
      const sg = GH.suggest(ins, dir, programs); this.suggestions.set(name, sg);
      return { ok: true, name, suggestions: sg.map(publicSuggestion), readme: ins.readme, licenceFile: ins.licence };
    });
  }

  // ------------------------------------------------------------------ setup commands (shown first; run on a click; named by id)
  runSetup({ name, ids } = {}) {
    if (!this._rec(name) && ![...this.stages.values()].some((s) => s.name === name)) return fail('not-installed', 'No such tool.');
    const all = this.suggestions.get(name) || [...this.stages.values()].find((s) => s.name === name)?.suggestions || [];
    if (!Array.isArray(ids) || !ids.length || ids.length > 12) return fail('bad-input', 'Choose the commands to run.');
    const steps = ids.map((id) => all.find((x) => x.id === id));
    if (steps.some((x) => !x)) return fail('bad-input', 'Unknown command. Reload the commands and try again.');
    for (const r of this.runs.values()) if (r.name === name && r.status === 'running') return fail('busy', 'Setup for this tool is still running.');
    const runId = 'r' + crypto.randomBytes(5).toString('hex');
    const run = { id: runId, name, status: 'running', output: '', current: 0, steps: steps.map((x) => ({ id: x.id, label: x.label, command: x.command, state: 'waiting', code: null })), handle: null, cancelled: false, startedAt: this.now() };
    this.runs.set(runId, run);
    while (this.runs.size > 8) this.runs.delete(this.runs.keys().next().value);
    (async () => {
      try {
        await this.vm.ensureRunning();
        for (let i = 0; i < steps.length; i++) {
          if (run.cancelled) break;
          run.current = i; run.steps[i].state = 'running'; this._out(run, '\n$ ' + steps[i].command + '\n');
          const h = this.vm.execStream(steps[i].argv, { cwd: steps[i].cwd, timeoutMs: LIMITS.setupMs, onOut: (_ch, b) => this._out(run, b.toString('utf8')) });
          run.handle = h; const r = await h.done; run.handle = null;
          run.steps[i].code = r.code; run.steps[i].state = r.code === 0 ? 'done' : 'failed';
          if (r.code !== 0) { run.status = run.cancelled ? 'cancelled' : 'failed'; this._out(run, '\n[exit code ' + (r.code === null ? 'none' : r.code) + (r.signal ? ', ' + r.signal : '') + ']\n'); break; }
        }
        if (run.status === 'running') run.status = run.cancelled ? 'cancelled' : 'done';
      } catch (e) { run.status = 'failed'; this._out(run, '\n' + errMsg(e) + '\n'); }
      if (run.status === 'done') this._noteSetup(name, run.steps);
      run.endedAt = this.now();
    })();
    return { ok: true, runId };
  }
  _out(run, s) { run.output = (run.output + s).slice(-LIMITS.output); }
  _noteSetup(name, steps) {
    const t = this._rec(name); if (!t) return;
    const day = new Date(this.now()).toISOString().slice(0, 10);
    t.notes = [...(t.notes || []), ...steps.map((s) => ('ran on ' + day + ': ' + s.command).slice(0, 400))].slice(-30);
    t.setup = [...(t.setup || []).filter((x) => !steps.some((s) => s.command === x.command)), ...steps.map((s) => ({ label: s.label.slice(0, 120), command: s.command.slice(0, 600) }))].slice(-20);
    this._save();
    try { this.library.put(this._libEntry(name)); } catch { /* library list is best effort here */ }
  }
  setupRun(runId) { const r = this.runs.get(runId); return r ? { ok: true, id: r.id, name: r.name, status: r.status, output: r.output, steps: r.steps, current: r.current } : fail('not-found', 'No such run.'); }
  cancelSetup(runId) { const r = this.runs.get(runId); if (!r) return { ok: true }; r.cancelled = true; if (r.handle) r.handle.kill(); return { ok: true }; }

  // ------------------------------------------------------------------ registering as a connector
  async register({ name, form } = {}) {
    return this._exclusive(async () => {
      const t = this._rec(name);
      if (!t) return fail('not-installed', 'No such tool.');
      if (t.connector) return fail('exists', 'This tool is already registered as a connector. Remove the connector first to describe it again.');
      const r = this._writeConnector(name, form);
      if (!r.ok) return r;
      try { this.library.put(this._libEntry(name)); } catch { /* best effort */ }
      return { ok: true, id: r.id, preview: r.built.manifest, marker: r.built.marker, note: 'Registered, not approved. Approve it on the Tool Integrations screen: the native dialog names the virtual computer and the pinned commit.' };
    });
  }
  // Writes connector.json + ghost-vm.json for a tool through the connector manager (which checks them). Used by register() and by the library import.
  _writeConnector(name, form) {
    const t = this._rec(name);
    let built; try { built = buildConnector({ name, commit: t.commit, version: t.version }, form); } catch (e) { return fail('bad-form', errMsg(e)); }
    const root = path.join(path.dirname(this.file), 'reg-' + crypto.randomBytes(5).toString('hex')), tmp = path.join(root, built.manifest.id);
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(path.join(tmp, 'connector.json'), JSON.stringify(built.manifest, null, 2) + '\n');
      fs.writeFileSync(path.join(tmp, 'ghost-vm.json'), JSON.stringify(built.marker, null, 2) + '\n');
      const r = this.manager.register(tmp);
      if (!r.ok) return fail(r.error || 'register-failed', (r.errors && r.errors[0]) || 'The connector could not be registered.');
      t.connector = r.id; t.form = cleanForm(form); t.version = built.manifest.version; this._save();
      return { ok: true, id: r.id, built };
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  // What register() would write, without writing anything: shown before the person presses Register.
  previewConnector({ name, form } = {}) {
    const t = this._rec(name); if (!t) return fail('not-installed', 'No such tool.');
    try { const b = buildConnector({ name, commit: t.commit, version: t.version }, form); return { ok: true, manifest: b.manifest, marker: b.marker, command: [b.marker.exe, ...b.manifest.command.args].join(' ') }; } catch (e) { return fail('bad-form', errMsg(e)); }
  }
  async unregister(name) {
    const t = this._rec(name); if (!t || !t.connector) return { ok: true };
    const r = await this.manager.remove(t.connector);
    if (r.ok || r.error === 'not-installed') { t.connector = null; delete t.form; this._save(); try { this.library.put(this._libEntry(name)); } catch { /* best effort */ } return { ok: true }; }
    return fail(r.error || 'failed', 'The connector could not be removed.');
  }

  // ------------------------------------------------------------------ updating (fetch, show, re-pin)
  async prepareUpdate({ name, ref } = {}) {
    return this._exclusive(async () => {
      const t = this._rec(name);
      if (!t) return fail('not-installed', 'No such tool.');
      if (t.source.type !== 'github') return fail('not-github', 'This tool was added from your own files, so there is nothing to fetch. Remove it and add the newer files.');
      const r = ref !== undefined && ref !== '' ? ref : (t.source.ref || 'HEAD');
      if (!/^[A-Za-z0-9._\/-]{1,200}$/.test(r) || r.includes('..') || r.startsWith('-')) return fail('bad-input', 'That tag or commit is not valid.');
      await this.vm.ensureRunning();
      const dir = guestDir(name), git = ['git', '-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];
      await this._ok([...git, 'fetch', '-q', '--depth', '1', '--no-tags', '--no-recurse-submodules', 'origin', r]);
      const to = (await this._ok([...git, 'rev-parse', 'FETCH_HEAD'], { timeoutMs: 20000 })).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(to)) throw new Error('could not resolve the new commit');
      if (to === t.commit) return { ok: true, upToDate: true, commit: to };
      const stat = await this.vm.runArgv([...git, 'diff', '--stat', '--no-color', 'HEAD', 'FETCH_HEAD'], { timeoutMs: 60000, maxBytes: 64 * 1024 });
      const names = await this.vm.runArgv([...git, 'diff', '--name-only', 'HEAD', 'FETCH_HEAD'], { timeoutMs: 60000, maxBytes: 64 * 1024 });
      const changed = names.stdout.split('\n').filter(Boolean);
      const dirty = await this.vm.runArgv([...git, 'status', '--porcelain', '--untracked-files=no'], { timeoutMs: 30000, maxBytes: 16 * 1024 });
      const token = crypto.randomBytes(12).toString('hex');
      this.stages.set(token, { update: true, name, dir, to, ref: r, at: this.now() });
      return { ok: true, token, name, from: t.commit, to, ref: r, stat: stat.stdout.slice(0, 8000), changedFiles: changed.length, licenceTouched: changed.some((f) => /(^|\/)(licen[sc]e|copying)/i.test(f)),
        localChanges: dirty.stdout.split('\n').filter(Boolean).slice(0, 20), registered: !!t.connector,
        note: t.connector ? 'Updating re-pins the tool. Your approval is withdrawn and you approve the new commit again.' : 'Updating re-pins the tool to the new commit.' };
    });
  }
  async applyUpdate({ token, discardChanges = false } = {}) {
    const s = this.stages.get(token);
    if (!s || !s.update) return fail('expired', 'This step expired. Check for updates again.');
    return this._exclusive(async () => {
      const t = this._rec(s.name); if (!t) return fail('not-installed', 'No such tool.');
      await this.vm.ensureRunning();
      const git = ['git', '-C', s.dir, '-c', 'core.hooksPath=/dev/null', '-c', 'advice.detachedHead=false'];
      const dirty = await this.vm.runArgv([...git, 'status', '--porcelain', '--untracked-files=no'], { timeoutMs: 30000, maxBytes: 16 * 1024 });
      if (dirty.stdout.trim() && !discardChanges) return fail('local-changes', 'Files of this tool were changed inside the virtual computer. Updating would overwrite them: confirm to discard those changes.');
      if (dirty.stdout.trim()) await this._ok([...git, 'reset', '-q', '--hard', 'HEAD']);
      const have = await this.vm.runArgv([...git, 'cat-file', '-e', s.to + '^{commit}'], { timeoutMs: 20000 });
      if (have.code !== 0) { await this._ok([...git, '-c', 'protocol.file.allow=never', 'fetch', '-q', '--depth', '1', '--no-tags', 'origin', s.to]); }
      await this._ok([...git, 'checkout', '-q', '--detach', s.to]);
      const head = (await this._ok([...git, 'rev-parse', 'HEAD'], { timeoutMs: 20000 })).stdout.trim();
      if (head !== s.to) throw new Error('the files did not move to the new commit');
      const checksum = await this._checksum(s.dir);
      this.stages.delete(token);
      const old = t.commit; t.commit = head; t.checksum = { algo: 'sha256', value: checksum }; t.updatedAt = new Date(this.now()).toISOString();
      t.notes = [...(t.notes || []), ('updated to ' + shortHash(head) + ' on ' + t.updatedAt.slice(0, 10)).slice(0, 400)].slice(-30);
      if (t.connector) await this._rewriteMarker(t, head);
      this._save();
      try { await this.vm.agent.put(s.dir + '/.ghost-pin.json', JSON.stringify({ type: 'github', source: t.source, commit: head, checksum, pinnedAt: t.updatedAt, previous: old }, null, 2) + '\n'); } catch { /* tools.json has it */ }
      try { this.library.put(this._libEntry(s.name)); } catch { /* best effort */ }
      const ins = await GH.inspectDir(this.vm, s.dir).catch(() => null);
      const sg = ins ? GH.suggest(ins, s.dir, {}) : []; this.suggestions.set(s.name, sg);
      return { ok: true, name: s.name, from: old, commit: head, needsApproval: !!t.connector, suggestions: sg.map(publicSuggestion) };
    });
  }
  // The pinned commit is part of the connector's marker file; changing it changes the connector's hash, which withdraws approval.
  async _rewriteMarker(t, commit) {
    const f = path.join(this.manager.connectorsDir, t.connector, 'ghost-vm.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8')); d.commit = commit;
    fs.writeFileSync(f + '.tmp', JSON.stringify(d, null, 2) + '\n'); fs.renameSync(f + '.tmp', f);
  }

  // ------------------------------------------------------------------ removing
  // deleteFiles: also delete the tool's folder inside the machine (starts the machine when it is stopped). The connector is always removed.
  async remove({ name, deleteFiles = true } = {}) {
    return this._exclusive(async () => {
      const t = this._rec(name);
      if (!t) return fail('not-installed', 'No such tool.');
      const u = await this.unregister(name); if (!u.ok) return u;
      let filesGone = false, note = '';
      if (deleteFiles) {
        try { await this.vm.ensureRunning(); await this.vm.agent.rmtree(guestDir(name)); filesGone = true; } catch (e) { note = 'The tool is removed from Ghost, but its files could not be deleted from the virtual computer now (' + errMsg(e) + '). They go when you wipe the tools disk.'; }
      }
      delete this.state.tools[name]; this.suggestions.delete(name); this._save();
      this.library.remove(name);
      return { ok: true, filesGone, ...(note ? { note } : {}) };
    });
  }

  // ------------------------------------------------------------------ the library list on a new computer
  // Takes a list from export(). Tools are fetched again at their pinned commit, the commit and the SHA-256 are compared with the list, and
  // a mismatch is refused (the files are deleted again). Connectors come back registered but NOT approved: every computer approves for itself.
  // Returns at once with a plan; progress is in importStatus().
  importLibrary(list) {
    if (this.importJob && !this.importJob.done) return fail('busy', 'An import is already running.');
    const r = this.library.import(list);
    if (!r.ok) return fail('bad-list', r.error);
    const items = r.fetch.map((e) => ({ name: e.name, status: 'waiting', error: '' }));
    const job = this.importJob = { done: false, items, manual: r.manual, conflicts: r.conflicts, rejected: r.rejected, added: r.added, updated: r.updated };
    (async () => {
      for (let i = 0; i < r.fetch.length; i++) {
        const e = r.fetch[i], it = items[i]; it.status = 'fetching';
        try { const s = await this._restoreOne(e); it.status = s.status; it.error = s.error || ''; } catch (err) { it.status = 'failed'; it.error = errMsg(err); }
      }
      job.done = true;
    })();
    return { ok: true, plan: items.map((x) => x.name), manual: r.manual, conflicts: r.conflicts, rejected: r.rejected };
  }
  importStatus() { const j = this.importJob; return j ? { ok: true, done: j.done, items: j.items, manual: j.manual, conflicts: j.conflicts, rejected: j.rejected } : { ok: true, done: true, items: [], manual: [], conflicts: [], rejected: [] }; }
  async _restoreOne(e) {
    const have = this._rec(e.name);
    await this.vm.ensureRunning();
    const dir = guestDir(e.name);
    if (have && have.commit === e.commit && have.checksum.value === e.checksum.value) {
      const here = await this.vm.runArgv(['test', '-d', dir], { timeoutMs: 10000 });
      if (here.code === 0) return { status: 'present' };
    }
    const p = GH.parseRepo(e.source.url, e.commit);
    if (!p) return { status: 'failed', error: 'the source address is not valid' };
    let got;
    try { got = await GH.cloneInto(this.vm, { ...p, ref: e.commit }, dir); } catch (err) { await this._discard(dir); return { status: 'failed', error: errMsg(err) }; }
    if (got.commit !== e.commit) { await this._discard(dir); return { status: 'failed', error: 'the commit that came back (' + shortHash(got.commit) + ') is not the pinned one (' + shortHash(e.commit) + '), so it was deleted' }; }
    const sum = await this._checksum(dir);
    if (sum !== e.checksum.value) { await this._discard(dir); return { status: 'failed', error: 'the files do not match the checksum in the list, so they were deleted' }; }
    this.state.tools[e.name] = { source: { type: 'github', url: e.source.url, repo: e.source.repo, ...(e.source.ref ? { ref: e.source.ref } : {}) }, commit: e.commit, checksum: e.checksum, version: e.version || '',
      installedAt: new Date(this.now()).toISOString(), licence: e.licence || '', notes: e.notes || [], setup: e.setup || [], connector: null, present: true };
    this._save();
    if (e.connector) {
      // registered again from the list's description; approval is NOT carried over
      const r = this._writeConnector(e.name, e.connector);
      if (!r.ok) return { status: 'installed', error: 'The tool is in place but its connector could not be registered: ' + r.error };
    }
    return { status: 'installed' };
  }
  shutdown() { for (const r of this.runs.values()) { r.cancelled = true; if (r.handle) { try { r.handle.kill(); } catch { /* gone */ } } } this.stages.clear(); }
}

const FORM_KEYS = ['id', 'title', 'description', 'program', 'args', 'output', 'entityType', 'inputLabel', 'network', 'scope', 'licence', 'restrictions', 'timeoutSec', 'selfTestInput'];
function cleanForm(f) {
  const o = {};
  for (const k of FORM_KEYS) if (f && f[k] !== undefined) o[k] = k === 'args' ? f.args.map(String) : k === 'timeoutSec' ? Number(f.timeoutSec) : String(f[k]);
  return o;
}
const publicSuggestion = (s) => ({ id: s.id, label: s.label, runtime: s.runtime, kind: s.kind, command: s.command, note: s.note });
// A best-effort reading of a licence text for the form's default. The person confirms or changes it.
function guessLicence(t) {
  const x = String(t || '').slice(0, 3000);
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(x)) return 'AGPL-3.0-only';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(x)) return /Version 2\.1/.test(x) ? 'LGPL-2.1-only' : 'LGPL-3.0-only';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(x)) return /Version 2/.test(x) ? 'GPL-2.0-only' : 'GPL-3.0-only';
  if (/Apache License/i.test(x) && /Version 2\.0/.test(x)) return 'Apache-2.0';
  if (/Mozilla Public License/i.test(x)) return 'MPL-2.0';
  if (/Permission is hereby granted, free of charge/i.test(x)) return 'MIT';
  if (/Redistribution and use in source and binary forms/i.test(x)) return /Neither the name/i.test(x) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (/ISC License|Permission to use, copy, modify, and\/or distribute/i.test(x)) return 'ISC';
  if (/This is free and unencumbered software released into the public domain/i.test(x)) return 'Unlicense';
  return '';
}

module.exports = { FORM_KEYS, cleanForm, VmToolInstaller, buildConnector, guessLicence, toolName, guestDir, TREE_HASH, LIMITS, TOOLS, PROGRAMS };
