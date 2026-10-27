'use strict';
// The built-in connectors are registered when Ghost starts, and the module screens ask for the ids the connectors really have.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mockServer, makeApp, signInTo, acceptTerms } = require('./ghost-app-helpers');
const Mods = require('../src/main/ghost/modules');
const Sec = require('../src/main/ghost/connectors-security');
const UI = require('../src/ui/ghost/modules');
const { registerBuiltins } = require('../src/main/ghost/app/builtins');

const done = async (h, m) => { try { h.app.shutdown && h.app.shutdown(); h.ghost.shutdown(); } catch { /* ok */ } await m.close(); };
const modIds = () => Mods.MODULES.map((m) => m.meta.id);

// The check the screens must pass: a wants id is a shipped connector id or is named in PLANNED.
const unknownWants = (M) => M.MODULES.flatMap((m) => m.wants.map((w) => w[0]).filter((id) => !M.BUILTIN.includes(id) && !M.SECURITY.includes(id) && !M.PLANNED.includes(id)).map((id) => m.id + ':' + id));

test('every wants id is a real shipped connector id or on the planned list', () => {
  assert.deepEqual(unknownWants(UI), []);
  // the check really fails for an id that is neither
  const bad = { ...UI, MODULES: [{ id: 'domains', wants: [['rdap', 'x'], ['dns-doh', 'y']] }] };
  assert.deepEqual(unknownWants(bad), ['domains:rdap']);
});
test('the shipped lists equal the connector folders, and nothing planned has shipped', () => {
  assert.deepEqual([...UI.BUILTIN].sort(), [...modIds()].sort());
  assert.deepEqual([...UI.SECURITY].sort(), [...Sec.connectorIds()].sort());
  for (const id of UI.PLANNED) assert.equal(UI.isShipped(id), false, id + ' is planned but already ships');
  for (const m of Mods.MODULES) { const man = Mods.toManifest(m.meta); assert.equal(man.id, m.meta.id); }
  for (const id of Sec.connectorIds()) assert.equal(JSON.parse(fs.readFileSync(path.join(Sec.connectorsDir, id, 'connector.json'), 'utf8')).id, id);
});
test('every shipped connector appears on a screen, no id is listed twice on one screen, and the right ones sit under the right module', () => {
  const placed = new Set(UI.wantedIds());
  for (const id of [...UI.BUILTIN, ...UI.SECURITY]) assert.ok(placed.has(id), id + ' is on no screen');
  for (const m of UI.MODULES) { const ids = m.wants.map((w) => w[0]); assert.equal(new Set(ids).size, ids.length, m.id); }
  const on = (mod) => UI.byId(mod).wants.map((w) => w[0]);
  for (const id of ['exiftool', 'mediainfo', 'ocrmypdf', 'tika']) assert.ok(on('files').includes(id), id);
  for (const id of ['gdal-info', 'qgis-open', 'nasa-cmr', 'usgs-landsat']) assert.ok(on('places').includes(id), id);
  assert.ok(on('archive').includes('archivebox'));
  for (const id of ['yara', 'sigma-match', 'subfinder', 'dnsx', 'amass', 'zeek', 'suricata', 'misp-client', 'opencti-client']) assert.ok(on('threat').includes(id), id);
  for (const id of ['nmap', 'testssl', 'zap-baseline', 'masscan', 'whatweb']) assert.ok(on('scan').includes(id), id);
  // an active connector is never offered on a passive screen
  for (const id of Sec.connectorIds()) { const j = JSON.parse(fs.readFileSync(path.join(Sec.connectorsDir, id, 'connector.json'), 'utf8')); for (const m of UI.MODULES) if (m.wants.some((w) => w[0] === id)) assert.equal(j.scope === 'active', m.id === 'scan', id + ' on ' + m.id); }
  for (const m of UI.MODULES) for (const [id, label] of m.wants) assert.equal(/sherlock|maigret|blackbird|holehe|whatsmyname/i.test(id + label), false);
});
test('screen states are honest: one clear state per connector, never a made-up one', () => {
  const entry = (o) => ({ id: 'x', health: 'ok', state: 'approved', install: { requirements: [{ name: 'p', status: 'ok' }], installed: false, verified: 'not-tested', lastTest: null }, ...o });
  assert.equal(UI.statusOf(null, 'ip-geo-local').label, 'Not installed'); assert.equal(UI.statusOf(null, 'ip-geo-local').planned, true);
  assert.equal(UI.statusOf(null, 'dns-doh').planned, false);
  assert.equal(UI.statusOf(entry({ health: 'broken' }), 'x').label, 'Not installed');
  assert.equal(UI.statusOf(entry({ state: 'not-approved' }), 'x').label, 'Needs your approval');
  assert.equal(UI.statusOf(entry({}), 'x').label, 'Not tested');
  assert.equal(UI.statusOf(entry({ install: { requirements: [{ name: 'Nmap', status: 'missing' }], installed: false, verified: 'failed', lastTest: { detail: 'requirement not met' } } }), 'x').label, 'Program missing');
  assert.equal(UI.statusOf(entry({ install: { requirements: [{ name: 'p', status: 'ok' }], installed: false, verified: 'failed', lastTest: { detail: 'bad output' } } }), 'x').label, 'Test failed');
  assert.equal(UI.statusOf(entry({ install: { requirements: [{ name: 'p', status: 'ok' }], installed: true, verified: 'tested', lastTest: { ok: true } } }), 'x').label, 'Test passed');
  // a connector with a passed test but untested requirements is not "passed"
  assert.notEqual(UI.statusOf(entry({ install: { requirements: [{ name: 'p', status: 'ok' }], installed: false, verified: 'tested', lastTest: { ok: true } } }), 'x').key, 'passed');
});

test('on start (after access is granted) every built-in and security connector is registered, not approved, and it does not touch the network', async () => {
  const m = await mockServer(); const h = makeApp(m);
  await signInTo(h, 'terms');
  assert.equal(fs.existsSync(path.join(h.root, 'connectors', 'dns-doh')), false, 'nothing is registered before access is granted');
  const realFetch = globalThis.fetch, calls = []; globalThis.fetch = (...a) => { calls.push(a[0]); return realFetch(...a); };
  try { assert.equal(acceptTerms(h.app).ok, true); const list = h.app.connectorsList(); h.app.connectorsList(); void list; } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 0, 'registering makes no request');
  const all = h.app.connectorsList(), ids = all.map((c) => c.id);
  for (const id of [...modIds(), ...Sec.connectorIds()]) assert.ok(ids.includes(id), id + ' is registered');
  for (const c of all.filter((x) => [...modIds(), ...Sec.connectorIds()].includes(x.id))) { assert.equal(c.state, 'not-approved', c.id); assert.equal(c.install.installed, false, c.id); }
  assert.equal(h.app.mem.builtins.summary.failed, 0, JSON.stringify(h.app.mem.builtins.summary));
  // the programs that are not on this machine stay "not installed program" after approval and test: nothing pretends otherwise
  const a = await h.app.connectorAction('requestApproval', 'tesseract'); assert.equal(a.ok, true);
  const t = await h.app.connectorAction('test', 'tesseract');
  const e = h.app.connectorGet('tesseract');
  if (!t.passed) { assert.equal(e.install.installed, false); assert.equal(UI.statusOf(e, 'tesseract').key === 'program-missing' || UI.statusOf(e, 'tesseract').key === 'test-failed', true); }
  await done(h, m);
});
test('registering again is idempotent: identical folders are not touched and approvals stay; a changed folder is replaced and loses its approval', async () => {
  const m = await mockServer(); const h = makeApp(m); await signInTo(h); acceptTerms(h.app);
  h.app.connectorsList();
  const mgr = h.ghost.manager;
  assert.equal((await h.app.connectorAction('requestApproval', 'exif-meta')).ok, true);
  const dir = path.join(h.root, 'connectors', 'exif-meta'), before = fs.statSync(path.join(dir, 'connector.json')).mtimeMs;
  const r = registerBuiltins(mgr);
  assert.equal(r.summary.registered + r.summary.updated + r.summary.failed, 0); assert.equal(r.summary.unchanged, modIds().length + Sec.connectorIds().length);
  assert.equal(fs.statSync(path.join(dir, 'connector.json')).mtimeMs, before);
  assert.equal(h.app.connectorGet('exif-meta').state, 'approved');
  // one edited file: restored from the shipped copy, approval withdrawn by the manager
  fs.appendFileSync(path.join(dir, 'run.js'), '\n// edited\n');
  assert.equal(h.app.connectorGet('exif-meta').state, 'not-approved');
  const r2 = registerBuiltins(mgr); assert.deepEqual(r2.modules.filter((x) => x.result !== 'unchanged').map((x) => x.id + ':' + x.result), ['exif-meta:updated']);
  assert.equal(h.app.connectorGet('exif-meta').state, 'not-approved'); assert.equal(UI.statusOf(h.app.connectorGet('exif-meta'), 'exif-meta').key, 'needs-approval'); assert.equal((await h.app.connectorAction('requestApproval', 'exif-meta')).ok, true); assert.equal(h.app.connectorGet('exif-meta').health, 'ok');
  await done(h, m);
});
test('the approval window is the user\'s: one window per connector, naming the outside addresses and the licence; the self-test decides what shows as installed', async () => {
  const m = await mockServer(); const shown = [];
  const h = makeApp(m, { ghost: { dialog: { showMessageBox: async (a, b) => { shown.push(b || a); return { response: 0 }; } } } });
  await signInTo(h); acceptTerms(h.app); h.app.connectorsList();
  for (const id of ['dns-doh', 'ct-crtsh', 'exif-meta']) assert.equal((await h.app.connectorAction('requestApproval', id)).ok, true);
  assert.equal(shown.length, 3);
  assert.match(shown[0].detail, /Contacts: cloudflare-dns\.com, dns\.google/); assert.match(shown[0].detail, /Licence: MIT/);
  assert.match(shown[1].detail, /crt\.sh/); assert.doesNotMatch(shown[2].detail, /Contacts:/);
  const t = await h.app.connectorAction('test', 'exif-meta'); assert.equal(t.passed, true, JSON.stringify(t));
  assert.equal(UI.statusOf(h.app.connectorGet('exif-meta'), 'exif-meta').label, 'Test passed');
  assert.equal(UI.statusOf(h.app.connectorGet('dns-doh'), 'dns-doh').label, 'Not tested', 'approved but never tested');
  assert.equal(h.app.connectorGet('exif-meta').install.installed, true);
  await done(h, m);
});
test('the shipped passive lookups set themselves up after the Terms: approved by the app, tested, switched on only if the test passed; the person\'s own choices and other connectors are left alone', async () => {
  const { autoSetup } = require('../src/main/ghost/app/builtins');
  const m = await mockServer(); const h = makeApp(m); await signInTo(h); acceptTerms(h.app); h.app.connectorsList();
  const mgr = h.ghost.manager;
  assert.equal(mgr.get('hash-file').state, 'not-approved');
  const r = await autoSetup(mgr, { only: ['hash-file', 'exif-meta'] });
  assert.ok(r.approved >= 2, JSON.stringify(r));
  for (const id of ['hash-file', 'exif-meta']) {
    const e = mgr.get(id); assert.ok(e.approvedAt, id + ' approved');
    const passed = !r.failed.includes(id);
    assert.equal(e.state, passed ? 'enabled' : 'approved', id + ' is only switched on when its own test passed');
  }
  // switched off by the person: left off
  mgr.disable('hash-file'); const r2 = await autoSetup(mgr, { only: ['hash-file'] });
  assert.equal(mgr.get('hash-file').state, 'disabled'); assert.deepEqual(r2.skipped, ['hash-file']);
  // a changed folder is not the shipped one: it is never approved by the app
  const dir = path.join(mgr.connectorsDir, 'cisa-kev'); fs.appendFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.js') || f.endsWith('.json'))), '\n');
  const r3 = await autoSetup(mgr, { only: ['cisa-kev'] }); assert.deepEqual(r3.skipped, ['cisa-kev']); assert.equal(mgr.get('cisa-kev').state, 'not-approved');
  // security connectors are not part of it
  const r4 = await autoSetup(mgr, { only: ['nmap'] }); assert.equal(r4.approved, 0);
  await done(h, m);
});
test('a lookup that was switched on by hand but never tested gets its self-test too (that is the "Not tested" card)', async () => {
  const { autoSetup } = require('../src/main/ghost/app/builtins');
  const m = await mockServer(); const h = makeApp(m); await signInTo(h); acceptTerms(h.app); h.app.connectorsList();
  const mgr = h.ghost.manager;
  assert.equal(mgr.approveBuiltin('hash-file').ok, true); assert.equal(mgr.enable('hash-file').ok, true);
  assert.notEqual(mgr.get('hash-file').install.verified, 'tested');
  const r = await autoSetup(mgr, { only: ['hash-file'] });
  assert.equal(mgr.get('hash-file').install.verified, r.failed.includes('hash-file') ? 'failed' : 'tested');
  assert.equal(mgr.get('hash-file').state, 'enabled', 'it stays on; a failed test is shown, not hidden');
  await done(h, m);
});
