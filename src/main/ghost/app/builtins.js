'use strict';
// Ghost app: puts the connectors that ship with Mayfair in front of the ConnectorManager.
//  1. registerBuiltins copies each shipped folder into <userData>/connectors/<id>; nothing is approved, enabled or run, no network.
//  2. approveShipped (synchronous, no dialog, no network, no waiting for a test): once the person has accepted Ghost's Terms, every shipped lookup whose
//     installed folder is byte-identical to the shipped one is approved in-process (manager.approveBuiltin) and switched on. A person's own "switch off"
//     is kept. Security connectors and anything that is not the shipped folder are not touched: they keep the native approval window.
//  3. selfTests (background, 2 at a time, per-service politeness unchanged) only RECORD tested / failed and the reason. A failed test never switches
//     anything off. Tools that need a program that is not here are only checked for that program, never run.
// Any change to a file still withdraws approval (the manager's hash check, unchanged). Every failure is logged and shown with its reason (BuiltinSetup.status).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modules = require('../modules');
const security = require('../connectors-security');
const TM = require('./toolmap');

function listTree(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name, p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r); else if (e.isFile()) out.set(r, p); else out.set(r, null);   // links and other types never match
    }
  };
  walk(root, '');
  return out;
}
// null when the two folders are byte-identical, otherwise one plain sentence about the first difference
function treeDiff(a, b) {
  let A, B;
  try { A = listTree(a); } catch (e) { return 'the shipped files could not be read (' + (e.code || e.message) + ')'; }
  try { B = listTree(b); } catch (e) { return 'the installed folder could not be read (' + (e.code || e.message) + ')'; }
  for (const rel of A.keys()) if (!B.has(rel)) return 'the installed copy is missing ' + rel;
  for (const rel of B.keys()) if (!A.has(rel)) return 'the installed copy has an extra file: ' + rel;
  for (const [rel, pa] of A) {
    const pb = B.get(rel);
    if (!pa || !pb) return rel + ' is not a plain file';
    try { if (!fs.readFileSync(pa).equals(fs.readFileSync(pb))) return rel + ' differs from the shipped file'; } catch (e) { return rel + ' could not be read (' + (e.code || e.message) + ')'; }
  }
  return null;
}
const sameTree = (a, b) => treeDiff(a, b) === null;

// -> { modules: [{id, result}], security: [{id, result}], summary }  result: 'registered' | 'unchanged' | 'updated' | 'failed'
function registerBuiltins(manager, { stagingRoot = os.tmpdir() } = {}) {
  const out = { modules: [], security: [] };
  const place = (id, src, list) => {
    const dest = path.join(manager.connectorsDir, id);
    try {
      let result = 'registered';
      if (fs.existsSync(dest)) {
        if (sameTree(src, dest)) { list.push({ id, result: 'unchanged' }); return; }
        // an older or edited copy: replace it with the shipped one; the approval record no longer matches the files, so the manager withdraws it
        fs.rmSync(dest, { recursive: true, force: true }); result = 'updated';
      }
      const r = manager.register(src);
      list.push(r.ok ? { id, result } : { id, result: 'failed', error: (r.errors && r.errors[0]) || r.error });
    } catch (e) { list.push({ id, result: 'failed', error: e.message }); }
  };
  const stage = fs.mkdtempSync(path.join(stagingRoot, 'mf-ghost-modules-'));
  try {
    for (const m of modules.MODULES) { const id = m.meta.id; try { place(id, modules.materialize(id, stage), out.modules); } catch (e) { out.modules.push({ id, result: 'failed', error: e.message }); } }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  for (const id of security.connectorIds()) place(id, path.join(security.connectorsDir, id), out.security);
  const all = [...out.modules, ...out.security], n = (r) => all.filter((x) => x.result === r).length;
  out.summary = { registered: n('registered'), updated: n('updated'), unchanged: n('unchanged'), failed: n('failed') };
  return out;
}


// ---------------------------------------------------------------------------------------------------------------------------------------------
// Step 2: approve and switch on. Synchronous on purpose: nothing before the last line can be awaited, so no earlier error or slow test can hold it back.
// -> { approved, enabled, failed:[id], skipped:[id], reasons:{id: 'plain sentence'}, ready:[id] }
function approveShipped(manager, { stagingRoot = os.tmpdir(), only = null, log = manager && manager.log } = {}) {
  const out = { approved: 0, enabled: 0, failed: [], skipped: [], reasons: {}, ready: [] };
  const why = (id, list, reason, event) => { list.push(id); out.reasons[id] = reason; if (log && event) { try { log.warn(event, { connector: id, reason }); } catch { /* logging never stops setup */ } } };
  let stage = null;
  try { stage = fs.mkdtempSync(path.join(stagingRoot, 'mf-ghost-auto-')); }
  catch (e) {
    for (const m of modules.MODULES) if (!only || only.includes(m.meta.id)) why(m.meta.id, out.failed, 'Ghost could not prepare its working folder (' + (e.code || e.message) + ')', 'builtin-setup-failed');
    return out;
  }
  try {
    for (const m of modules.MODULES) {
      const id = m.meta.id; if (only && !only.includes(id)) continue;
      try {
        let shipped; try { shipped = modules.materialize(id, stage); } catch (e) { why(id, out.failed, 'the shipped files could not be prepared: ' + e.message, 'builtin-setup-failed'); continue; }
        let e = manager.get(id);
        if (!e) { why(id, out.failed, 'it is not installed on this computer', 'builtin-setup-failed'); continue; }
        const diff = treeDiff(shipped, path.join(manager.connectorsDir, id));
        if (diff) { why(id, out.skipped, 'not the shipped copy (' + diff + '), so it needs your own approval', 'builtin-setup-skipped'); continue; }
        if (e.state === 'disabled') { why(id, out.skipped, 'you switched it off', null); continue; }
        if (e.state === 'not-approved') {
          const r = manager.approveBuiltin(id);
          if (!r || !r.ok) { why(id, out.failed, 'approval did not go through (' + ((r && r.error) || 'no answer') + ')', 'builtin-setup-failed'); continue; }
          out.approved++; e = manager.get(id);
        }
        if (e.state !== 'enabled') {
          const r = manager.enable(id);
          if (!r || !r.ok) { why(id, out.failed, 'it could not be switched on (' + ((r && r.error) || 'no answer') + ')', 'builtin-setup-failed'); continue; }
          out.enabled++;
        }
        out.ready.push(id);
      } catch (e) { why(id, out.failed, 'setup stopped: ' + (e && e.message), 'builtin-setup-failed'); }
    }
  } finally { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* temp folder */ } }
  return out;
}

// Step 3: the background self-test. Records only. -> { passed:[id], failed:[id], needsProgram:[id], skipped:[id], reasons:{id} }
async function selfTests(manager, ids, { concurrency = 2, log = manager && manager.log, onStart = () => {}, onDone = () => {}, isStopped = () => false } = {}) {
  const out = { passed: [], failed: [], needsProgram: [], skipped: [], reasons: {} };
  let i = 0;
  const one = async (id) => {
    const t = TM.info(id);
    const e = manager.get(id);
    if (!e || e.state === 'disabled' || e.state === 'not-approved') { out.skipped.push(id); return; }
    if (t && t.program) {
      const reqs = await manager.checkRequirements(id);
      const bad = reqs.find((r) => r.status !== 'ok');
      if (bad) { out.needsProgram.push(id); out.reasons[id] = bad.name + (bad.detail ? ' (' + bad.detail + ')' : ''); onDone(id, { state: 'needs-program', note: out.reasons[id] }); return; }
    }
    if (t && t.own) { out.skipped.push(id); onDone(id, { state: 'skipped', note: 'Needs ' + t.own }); return; }
    if (e.install && e.install.verified === 'tested') { out.passed.push(id); onDone(id, { state: 'tested', note: '' }); return; }
    onStart(id);
    const r = await manager.test(id);
    if (r && r.ok && r.passed) { out.passed.push(id); onDone(id, { state: 'tested', note: '' }); return; }
    const reason = r && r.lastTest ? r.lastTest.detail : (r && (r.error || 'no answer')) || 'no answer';
    out.failed.push(id); out.reasons[id] = String(reason);
    if (log) { try { log.warn('builtin-selftest-failed', { connector: id, reason: String(reason) }); } catch { /* ok */ } }
    onDone(id, { state: 'failed', note: String(reason) });
  };
  const worker = async () => {
    while (i < ids.length && !isStopped()) {
      const id = ids[i++];
      try { await one(id); } catch (e) {
        out.failed.push(id); out.reasons[id] = 'the test could not run: ' + (e && e.message);
        if (log) { try { log.warn('builtin-selftest-error', { connector: id, reason: out.reasons[id] }); } catch { /* ok */ } }
        try { onDone(id, { state: 'failed', note: out.reasons[id] }); } catch { /* ok */ }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}

// Both steps for callers that want one call (tests, tools): approve and switch on first, then record the self-tests.
// -> Promise<{ approved, enabled, failed:[id], skipped:[id], reasons, ready, tests }>   (failed = could not be approved or switched on; test results are in tests)
async function autoSetup(manager, { stagingRoot = os.tmpdir(), only = null, concurrency = 2, test = true, log } = {}) {
  const out = approveShipped(manager, { stagingRoot, only, log });
  out.tests = test ? await selfTests(manager, out.ready, { concurrency, log }) : { passed: [], failed: [], needsProgram: [], skipped: [], reasons: {} };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the window may ask: one honest row per shipped tool. States: ready | setting-up | needs-program | off | failed.
class BuiltinSetup {
  constructor({ manager, log = null, onChange = () => {}, vmPublished = () => false, stagingRoot = os.tmpdir(), concurrency = 2 } = {}) {
    this.manager = manager; this.log = log || (manager && manager.log) || null; this.onChange = onChange; this.vmPublished = vmPublished;
    this.stagingRoot = stagingRoot; this.concurrency = concurrency;
    this.phase = 'idle';                 // idle -> testing -> done
    this.approval = null;                // the result of approveShipped
    this.tests = new Map();              // id -> { state: 'running' | 'tested' | 'failed' | 'needs-program' | 'skipped', note }
    this.error = null; this.done = null; this.startedAt = 0; this.stopped = false;
  }
  _changed() { try { this.onChange(); } catch { /* listener failed */ } }
  // Idempotent per instance. The approval part has finished when this returns; the promise it hands back is the background self-test (it never rejects).
  start() {
    if (this.phase !== 'idle') return this.done;
    this.phase = 'testing';
    try { this.approval = approveShipped(this.manager, { stagingRoot: this.stagingRoot, log: this.log }); }
    catch (e) { this.error = e && e.message ? e.message : 'setup failed'; this.approval = { approved: 0, enabled: 0, failed: [], skipped: [], reasons: {}, ready: [] }; if (this.log) this.log.error('builtin-setup-error', { reason: this.error }); }
    if (this.log) this.log.info('builtin-setup', { approved: this.approval.approved, enabled: this.approval.enabled, ready: this.approval.ready.length, failed: this.approval.failed.length, skipped: this.approval.skipped.length });
    this._changed();
    this.done = selfTests(this.manager, this.approval.ready, {
      concurrency: this.concurrency, log: this.log, isStopped: () => this.stopped,
      onStart: (id) => { this.tests.set(id, { state: 'running', note: 'Testing now' }); this._changed(); },
      onDone: (id, r) => { this.tests.set(id, r); this._changed(); },
    }).catch((e) => { this.error = e && e.message ? e.message : 'self-test stopped'; if (this.log) this.log.error('builtin-selftest-stopped', { reason: this.error }); return null; })
      .then((r) => { this.phase = 'done'; this._changed(); return r; });
    return this.done;
  }
  stop() { this.stopped = true; }
  _row(id, m) {
    const t = TM.info(id) || { category: 'Threat intel', kinds: [] };
    const meta = m.meta, e = this.manager.get(id), ap = this.approval, tr = this.tests.get(id);
    const row = { id, name: meta.name, category: t.category, inputs: [...t.kinds], state: 'setting-up', note: '', tested: 'pending', testNote: '', description: meta.description || '' };
    const pgm = t.program || null;
    const programNote = () => (this.vmPublished() ? 'Runs in the Ghost virtual computer' : 'Needs ' + (pgm || t.own) + ' (the Ghost virtual computer is not available yet)');
    if (!e) { if (ap) { row.state = 'failed'; row.note = (ap.reasons[id]) || 'it is not installed on this computer'; } else row.note = 'Waiting for the Terms'; return row; }
    if (e.health === 'broken') { row.state = 'failed'; row.note = 'its files are missing or not valid' + (e.errors && e.errors[0] ? ': ' + e.errors[0] : ''); return row; }
    if (e.state === 'disabled') { row.state = 'off'; row.note = 'Switched off by you'; }
    else if (!ap) { row.note = 'Waiting for the Terms'; }
    else if (e.state === 'not-approved' || e.state === 'approved') { row.state = 'failed'; row.note = ap.reasons[id] || (e.health === 'changed' ? 'its files changed after approval, so it needs your approval again' : 'it was not approved'); }
    else row.state = 'ready';
    if (row.state === 'ready' || row.state === 'setting-up') {
      if (t.own) { row.state = 'needs-program'; row.note = 'Needs ' + t.own; }
      else if (pgm) {
        const reqs = (e.install && e.install.requirements) || [];
        const bad = reqs.find((r) => r.status !== 'ok' && r.status !== 'untested');
        if (bad || (tr && tr.state === 'needs-program')) { row.state = 'needs-program'; row.note = programNote(); row.testNote = (tr && tr.note) || (bad ? bad.name + (bad.detail ? ' (' + bad.detail + ')' : '') : ''); }
        else if (row.state === 'ready' && !reqs.every((r) => r.status === 'ok')) { row.state = 'setting-up'; row.note = 'Looking for ' + pgm; }
      }
    }
    if (row.state === 'ready' || row.state === 'off') {
      const v = e.install && e.install.verified;
      if (v === 'tested') row.tested = 'tested';
      else if (v === 'failed') {
        const d = String((e.install.lastTest && e.install.lastTest.detail) || '');
        // a service that could not be reached during the check says nothing about the tool: it stays ready and is checked again when a search runs
        if (/unavailable: could not reach|rate-limited|asked us to slow down|network service .* not available|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(d)) { row.tested = 'offline'; row.testNote = 'The service could not be reached during the check. It is used as soon as you search.'; }
        else { row.tested = 'failed'; row.testNote = d; }
      }
      else row.testNote = tr && tr.state === 'running' ? 'Testing now' : this.phase === 'done' ? 'Not tested' : 'Test is queued';
    }
    return row;
  }
  // -> { total, ready, 'setting-up', failed:[{id,name,reason}], tools:[...] } plus needsProgram, off, phase, tests:{done,total}
  status() {
    const tools = modules.MODULES.map((m) => { try { return this._row(m.meta.id, m); } catch (e) { return { id: m.meta.id, name: m.meta.name, category: 'Threat intel', inputs: [], state: 'failed', note: 'status unavailable: ' + e.message, tested: 'pending', testNote: '', description: '' }; } });
    const n = (s) => tools.filter((x) => x.state === s).length;
    const testable = tools.filter((x) => x.state === 'ready');
    return {
      total: tools.length, ready: n('ready'), 'setting-up': n('setting-up'), needsProgram: n('needs-program'), off: n('off'),
      failed: tools.filter((x) => x.state === 'failed').map((x) => ({ id: x.id, name: x.name, reason: x.note })),
      phase: this.phase, error: this.error, tests: { done: testable.filter((x) => x.tested !== 'pending').length, total: testable.length },
      tools,
    };
  }
  // The row for one tool, or null (used by the search planner).
  row(id) { const m = modules.MODULES.find((x) => x.meta.id === id); return m ? this._row(id, m) : null; }
}

module.exports = { registerBuiltins, approveShipped, selfTests, autoSetup, sameTree, treeDiff, BuiltinSetup };
