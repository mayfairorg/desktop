'use strict';
// Ghost app: puts the connectors that ship with Mayfair in front of the ConnectorManager. Registering only copies a folder into
// <userData>/connectors/<id>; nothing is approved, enabled or run, and nothing touches the network. The user approves each connector in
// the native dialog, a connector's own self-test decides whether it shows as installed, and any change to the files withdraws approval
// (the manager's hash check, unchanged). A folder that is already identical to the shipped one is left alone.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const modules = require('../modules');
const security = require('../connectors-security');

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
function sameTree(a, b) {
  let A, B;
  try { A = listTree(a); B = listTree(b); } catch { return false; }
  if (A.size !== B.size) return false;
  for (const [rel, pa] of A) {
    const pb = B.get(rel);
    if (!pa || !pb) return false;
    try { if (!fs.readFileSync(pa).equals(fs.readFileSync(pb))) return false; } catch { return false; }
  }
  return true;
}

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

// The passive lookups that ship with Mayfair work straight away: once the person has accepted Ghost's Terms, each one whose installed folder is
// byte-identical to the shipped folder is approved by the app, tested against its own self-test, and switched on if the test passed. A connector the
// person switched off is left off, one that failed its test is left as it is (the page shows why), and anything not shipped by Mayfair, and the
// security / scanning connectors, still need the person's own approval in the native dialog.
// -> Promise<{ approved, enabled, failed:[id], skipped:[id] }>
async function autoSetup(manager, { stagingRoot = os.tmpdir(), only = null, concurrency = 2 } = {}) {
  const out = { approved: 0, enabled: 0, failed: [], skipped: [] };
  const stage = fs.mkdtempSync(path.join(stagingRoot, 'mf-ghost-auto-'));
  const todo = [];
  try {
    for (const m of modules.MODULES) {
      const id = m.meta.id; if (only && !only.includes(id)) continue;
      let shipped = null; try { shipped = modules.materialize(id, stage); } catch { out.skipped.push(id); continue; }
      if (!sameTree(shipped, path.join(manager.connectorsDir, id))) { out.skipped.push(id); continue; }      // not the shipped files: needs the person
      const e = manager.get ? manager.get(id) : null; const st = e && e.state;
      if (st === 'disabled') { out.skipped.push(id); continue; }                                           // the person switched it off
      if (st === 'enabled' && e.install && e.install.verified === 'tested') continue;                      // already on and tested
      todo.push(id);
    }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const id = todo[i++];
      try {
        const e = manager.get(id);
        if (e.state === 'not-approved') { const r = manager.approveBuiltin(id); if (!r.ok) { out.failed.push(id); continue; } out.approved++; }
        const t = await manager.test(id);
        if (t && t.passed === true) { if (manager.get(id).state === 'enabled') out.enabled++; else { const r = manager.enable(id); if (r && r.ok) out.enabled++; else out.failed.push(id); } } else out.failed.push(id);
      } catch { out.failed.push(id); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return out;
}
module.exports = { registerBuiltins, autoSetup, sameTree };
