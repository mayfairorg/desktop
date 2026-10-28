'use strict';
// The shipped lookups are ready at start: approved and switched on in-process right after the Terms, on every start, without waiting for a test.
// The self-test runs in the background and only records. Failures are logged and shown with their reason. All with the real flow (real manager,
// real vault, real registration); only the self-test run itself is replaced, so no test touches the network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mockServer, makeApp, signInTo, acceptTerms } = require('./ghost-app-helpers');
const Mods = require('../src/main/ghost/modules');
const Sec = require('../src/main/ghost/connectors-security');
const { approveShipped, autoSetup, BuiltinSetup, registerBuiltins } = require('../src/main/ghost/app/builtins');
const TM = require('../src/main/ghost/app/toolmap');

const IDS = Mods.MODULES.map((m) => m.meta.id);
const done = async (h, m) => { try { h.app.shutdown(); h.ghost.shutdown(); } catch { /* ok */ } await m.close(); };
const LOCAL = new Set(['exif-meta', 'hash-file', 'stix-import', 'local-snapshot', 'archivebox']);

// replaces manager.test: local tools pass, everything else fails "offline" (the sandbox has no network). Writes what the real one writes.
function fakeTests(mgr, { gate = null, calls = [] } = {}) {
  mgr.test = async (id) => {
    calls.push(id); if (gate) await gate;
    const a = mgr._assess(id, { fresh: true }); const rec = mgr._rec(id); const ok = LOCAL.has(id);
    const detail = ok ? 'passed: 1 result(s) as expected' : 'the self-test failed: could not reach the service (offline)';
    rec.lastTest = { t: Date.now(), ok, detail, hash: a.fp.combined }; mgr._save();
    return { ok: true, passed: ok, verified: ok ? 'tested' : 'failed', lastTest: { t: rec.lastTest.t, ok, detail } };
  };
  return calls;
}
const start = async (over = {}) => {
  const m = await mockServer(); const h = makeApp(m, over); h.app.autoSetupOn = true;
  return { m, h };
};
const logLines = (h) => { try { return h.ghost.log.tail({ n: 500 }); } catch { return []; } };

test('right after the Terms every shipped lookup is approved and on, before any self-test has finished; security connectors are untouched', async () => {
  const { m, h } = await start();
  await signInTo(h);
  let release; const gate = new Promise((r) => { release = r; }); const calls = fakeTests(h.ghost.manager, { gate });
  acceptTerms(h.app);                                            // no await between here and the checks: nothing has been tested yet
  const list = h.ghost.manager.list(); const by = Object.fromEntries(list.map((e) => [e.id, e]));
  for (const id of IDS) { assert.equal(by[id].state, 'enabled', id); assert.equal(by[id].health, 'ok', id); }
  for (const id of Sec.connectorIds()) assert.equal(by[id].state, 'not-approved', id + ' keeps the native approval window');
  assert.equal(IDS.filter((id) => by[id].install.verified === 'tested').length, 0, 'no test has finished');
  const st = h.app.builtinsStatus(); assert.equal(st.total, IDS.length); assert.equal(st.failed.length, 0);
  const prog = new Set(IDS.filter((id) => (TM.info(id) || {}).program || (TM.info(id) || {}).own));
  assert.ok(st.tools.filter((t) => !prog.has(t.id)).every((t) => t.state === 'ready'), 'every tool that needs no program is ready now');
  assert.equal(st.tools.filter((t) => t.state === 'failed').length, 0);
  assert.ok(calls.length <= 2 + 8, 'tests are running at most two at a time: ' + calls.length);
  release(); await h.app.mem.autoSetup;
  const st2 = h.app.builtinsStatus(); assert.equal(st2.phase, 'done');
  assert.equal(st2.tools.find((t) => t.id === 'hash-file').tested, 'tested');
  await done(h, m);
});
test('a failed self-test records the reason and switches nothing off', async () => {
  const { m, h } = await start();
  await signInTo(h); fakeTests(h.ghost.manager); acceptTerms(h.app); await h.app.mem.autoSetup;
  const st = h.app.builtinsStatus();
  const t = (id) => st.tools.find((x) => x.id === id);
  assert.equal(t('gdelt-doc').state, 'ready'); assert.equal(t('gdelt-doc').tested, 'failed'); assert.match(t('gdelt-doc').testNote, /offline/);
  assert.equal(t('hash-file').tested, 'tested'); assert.equal(t('hash-file').testNote, '');
  assert.equal(h.ghost.manager.get('gdelt-doc').state, 'enabled');
  assert.equal(st.failed.length, 0, 'a failed test is not a failed tool');
  assert.ok(logLines(h).some((l) => l.event === 'builtin-selftest-failed' && l.connector === 'gdelt-doc'), 'logged');
  await done(h, m);
});
test('builtins.status has the contract shape', async () => {
  const { m, h } = await start();
  await signInTo(h); fakeTests(h.ghost.manager); acceptTerms(h.app); await h.app.mem.autoSetup;
  const st = h.app.builtinsStatus();
  for (const k of ['total', 'ready', 'setting-up', 'failed', 'tools']) assert.ok(k in st, k);
  assert.equal(st.tools.length, st.total); assert.ok(Array.isArray(st.failed));
  assert.equal(st.ready + st['setting-up'] + st.needsProgram + st.off + st.failed.length, st.total);
  for (const t of st.tools) {
    assert.deepEqual(Object.keys(t).sort(), ['category', 'description', 'id', 'inputs', 'name', 'note', 'state', 'tested', 'testNote'].sort(), t.id);
    assert.ok(['ready', 'setting-up', 'needs-program', 'off', 'failed'].includes(t.state), t.id + ' ' + t.state);
    assert.ok(['tested', 'failed', 'pending'].includes(t.tested), t.id);
    assert.ok(TM.CATEGORIES.includes(t.category), t.id); assert.ok(Array.isArray(t.inputs)); assert.equal(typeof t.name, 'string'); assert.equal(typeof t.note, 'string'); assert.equal(typeof t.testNote, 'string');
  }
  const d = st.tools.find((t) => t.id === 'dns-doh'); assert.deepEqual(d.inputs, ['domain']); assert.equal(d.category, 'Domains and networks');
  assert.deepEqual(st.tools.find((t) => t.id === 'rdap-ip-asn').inputs, ['ip', 'asn']);
  assert.deepEqual(new Set(st.tools.map((t) => t.category)), new Set(TM.CATEGORIES));
  await done(h, m);
});
test('the status event carries the same object, and the page hears about changes', async () => {
  const { m, h } = await start();
  await signInTo(h); fakeTests(h.ghost.manager); acceptTerms(h.app); await h.app.mem.autoSetup;
  await new Promise((r) => setTimeout(r, 250));
  const ev = h.events.filter(([n]) => n === 'builtins'); assert.ok(ev.length >= 1, 'at least one builtins event');
  const last = ev[ev.length - 1][1]; assert.equal(last.total, IDS.length); assert.equal(last.phase, 'done'); assert.ok(last.ready >= 1);
  await done(h, m);
});
test('regression: setup does not depend on how the first call arrives, runs once, and never waits for the status page: a restart with the Terms already accepted sets up from status() alone', async () => {
  const m = await mockServer();
  const h1 = makeApp(m); await signInTo(h1); acceptTerms(h1.app);               // first run: automatic setup off (like an old install), builtins registered by a gated call
  h1.app.connectorsList();
  assert.equal(h1.ghost.manager.get('gdelt-doc').state, 'not-approved', 'the old flow left it waiting for approval');
  const root = h1.root; try { h1.app.shutdown(); h1.ghost.shutdown(); } catch { /* ok */ }
  // second run on the same folder: only status() is called; nothing else, no change event, no gated call
  const h2 = makeApp(m, { root }); h2.app.autoSetupOn = true; const calls = fakeTests(h2.ghost.manager);
  assert.equal(h2.app.stage(), 'ready', 'session, entitlement and Terms come back from the vault');
  assert.equal(h2.app.mem.builtins, null); h2.app.status();
  assert.ok(h2.app.mem.builtins && h2.app.mem.autoSetup, 'status() started it');
  assert.equal(h2.ghost.manager.get('gdelt-doc').state, 'enabled'); assert.equal(h2.ghost.manager.get('dns-doh').state, 'enabled');
  await h2.app.mem.autoSetup; const n = calls.length;
  // any number of further calls from any path does not run it again (the early-return path)
  const first = h2.app.mem.autoSetup; for (let i = 0; i < 5; i++) { h2.app.status(); h2.app.ensureBuiltins(); h2.app._changed(); h2.app.connectorsList(); }
  assert.equal(h2.app.mem.autoSetup, first); await new Promise((r) => setTimeout(r, 30)); assert.equal(calls.length, n, 'no second round of tests');
  // and it is not started before the Terms or when automatic setup is off
  const h3 = makeApp(m, { root }); h3.app.autoSetupOn = false; h3.app.status(); assert.ok(h3.app.mem.builtins, 'registered'); assert.equal(h3.app.mem.autoSetup, undefined);
  await done(h2, m); try { h3.app.shutdown(); h3.ghost.shutdown(); } catch { /* ok */ }
});
test('the first status() before the Terms starts nothing; accepting the Terms starts it', async () => {
  const { m, h } = await start(); await signInTo(h);
  h.app.status(); assert.equal(h.app.mem.builtins || null, null); assert.equal(h.ghost.manager.get('dns-doh'), null);
  fakeTests(h.ghost.manager); acceptTerms(h.app); assert.equal(h.ghost.manager.get('dns-doh').state, 'enabled');
  await done(h, m);
});
test('the calls are refused until the start steps are done', async () => {
  const { m, h } = await start();
  assert.throws(() => h.app.builtinsStatus(), /start steps/); assert.throws(() => h.app.searchClassify({ query: 'a' }), /start steps/); assert.throws(() => h.app.searchRun({ query: 'a' }), /start steps/); assert.throws(() => h.app.searchCancel({ searchId: 's-0000000000000000' }), /start steps/);
  await done(h, m);
});
test('a failure while approving is logged and shown with its reason, and the other tools are not held back', async () => {
  const { m, h } = await start(); await signInTo(h); fakeTests(h.ghost.manager);
  const mgr = h.ghost.manager, orig = mgr.approveBuiltin.bind(mgr);
  mgr.approveBuiltin = (id) => (id === 'gdelt-doc' ? { ok: false, error: 'disk full' } : id === 'wikidata' ? (() => { throw new Error('vault is locked'); })() : orig(id));
  acceptTerms(h.app); await h.app.mem.autoSetup;
  const st = h.app.builtinsStatus();
  const f = Object.fromEntries(st.failed.map((x) => [x.id, x]));
  assert.match(f['gdelt-doc'].reason, /approval did not go through \(disk full\)/); assert.match(f.wikidata.reason, /vault is locked/);
  assert.equal(st.failed.length, 2); assert.equal(st.ready + st.needsProgram, IDS.length - 2);
  assert.equal(st.tools.find((t) => t.id === 'gdelt-doc').state, 'failed');
  const lines = logLines(h).filter((l) => l.event === 'builtin-setup-failed'); assert.deepEqual(lines.map((l) => l.connector).sort(), ['gdelt-doc', 'wikidata']);
  assert.match(lines.find((l) => l.connector === 'gdelt-doc').reason, /disk full/);
  await done(h, m);
});
test('a folder that is not the shipped one is skipped with the reason and needs the person; the shipped ones are not held back', async () => {
  const { m, h } = await start(); await signInTo(h); fakeTests(h.ghost.manager);
  const mgr = h.ghost.manager;
  h.app.termsAccept; // (terms are accepted below; the folder is edited after registration)
  acceptTerms(h.app); await h.app.mem.autoSetup;
  const dir = path.join(mgr.connectorsDir, 'nvd'); fs.appendFileSync(path.join(dir, 'run.js'), '\n// edited\n');
  const r = approveShipped(mgr);
  assert.deepEqual(r.skipped, ['nvd']); assert.match(r.reasons.nvd, /not the shipped copy \(run\.js differs from the shipped file\)/);
  assert.equal(mgr.get('nvd').state, 'not-approved');
  const t = new BuiltinSetup({ manager: mgr }); t.start(); const row = t.status().tools.find((x) => x.id === 'nvd');
  assert.equal(row.state, 'failed'); assert.match(row.note, /needs your own approval/);
  await t.done; await done(h, m);
});
test('a person\'s switch-off is kept on every start', async () => {
  const { m, h } = await start(); await signInTo(h); fakeTests(h.ghost.manager); acceptTerms(h.app); await h.app.mem.autoSetup;
  const mgr = h.ghost.manager; assert.equal(mgr.disable('wikidata').ok, true);
  const t = new BuiltinSetup({ manager: mgr }); await t.start();
  assert.equal(mgr.get('wikidata').state, 'disabled'); const row = t.status().tools.find((x) => x.id === 'wikidata'); assert.equal(row.state, 'off'); assert.equal(row.note, 'Switched off by you');
  assert.match(t.approval.reasons.wikidata, /switched it off/); assert.equal(t.status().off, 1);
  await done(h, m);
});
test('an unusable working folder is reported for every tool instead of being swallowed', async () => {
  const { m, h } = await start(); await signInTo(h); fakeTests(h.ghost.manager); acceptTerms(h.app); await h.app.mem.autoSetup;
  const warns = []; const r = approveShipped(h.ghost.manager, { stagingRoot: path.join(h.root, 'does', 'not', 'exist'), log: { warn: (e, f) => warns.push([e, f]) } });
  assert.equal(r.failed.length, IDS.length); assert.match(r.reasons['dns-doh'], /working folder/); assert.equal(warns.length, IDS.length);
  await done(h, m);
});
test('tools that need a program that is not here show needs-program with a one-line note, are only checked for the program, and are never tested or run', async () => {
  for (const [published, expect] of [[true, /^Runs in the Ghost virtual computer$/], [false, /^Needs ExifTool \(the Ghost virtual computer is not available yet\)$/]]) {
    const { m, h } = await start({}); h.app.vmPublished = () => published; await signInTo(h);
    const mgr = h.ghost.manager; const calls = fakeTests(mgr); const real = mgr.checkRequirements.bind(mgr); const asked = [];
    mgr.checkRequirements = async (id) => { asked.push(id); return id === 'exiftool' ? mgr._requirements(mgr._assess(id)).map((r) => ({ name: r.name, status: r.name.includes('ExifTool') ? 'missing' : 'ok', detail: r.name.includes('ExifTool') ? 'ExifTool is not installed' : '' })) : real(id); };
    acceptTerms(h.app); await h.app.mem.autoSetup;
    const row = h.app.builtinsStatus().tools.find((t) => t.id === 'exiftool');
    assert.equal(row.state, 'needs-program'); assert.match(row.note, expect); assert.match(row.testNote, /ExifTool/); assert.equal(row.tested, 'pending');
    assert.equal(calls.includes('exiftool'), false, 'never run as a test'); assert.ok(asked.includes('exiftool'));
    assert.equal(mgr.get('exiftool').state, 'enabled', 'switched on so it works as soon as the program exists');
    const ab = h.app.builtinsStatus().tools.find((t) => t.id === 'archivebox'); assert.equal(ab.state, 'needs-program'); assert.match(ab.note, /own ArchiveBox|virtual computer/); assert.equal(calls.includes('archivebox'), false);
    await done(h, m);
  }
});
test('the real program check: a program that is really absent shows needs-program, one that is really there shows ready', async () => {
  const { m, h } = await start(); await signInTo(h); const mgr = h.ghost.manager; const calls = fakeTests(mgr);
  acceptTerms(h.app); await h.app.mem.autoSetup;
  const st = h.app.builtinsStatus(); const present = (names) => { for (const d of (process.env.PATH || '').split(path.delimiter)) for (const n of names) if (d && fs.existsSync(path.join(d, n))) return true; return false; };
  for (const [id, names] of [['exiftool', ['exiftool']], ['mediainfo', ['mediainfo']], ['tika', ['tika', 'tika-app']], ['ocrmypdf', ['ocrmypdf']], ['tesseract', ['tesseract']], ['ffmpeg-frames', ['ffmpeg']], ['gdal-info', ['gdalinfo']]]) {
    const row = st.tools.find((t) => t.id === id);
    if (present(names)) assert.ok(['ready'].includes(row.state), id + ' is on PATH: ' + row.state); else { assert.equal(row.state, 'needs-program', id); assert.equal(calls.includes(id), false); }
  }
  await done(h, m);
});
test('before setup has started every tool says setting-up with the reason, never "needs your approval"', async () => {
  const { m, h } = await start(); await signInTo(h); acceptTerms(h.app); await h.app.mem.autoSetup;
  const t = new BuiltinSetup({ manager: h.ghost.manager }); const st = t.status();
  assert.equal(st.ready, 0); assert.equal(st.failed.length, 0); assert.equal(st['setting-up'] + st.needsProgram, IDS.length);
  for (const x of st.tools.filter((x) => x.state === 'setting-up')) assert.equal(x.note, 'Waiting for the Terms');
  assert.ok(st['setting-up'] >= IDS.length - 9, 'every tool that needs no program is setting up');
  await done(h, m);
});
test('every shipped tool is in the registry once, with a group, and the registry names no tool that does not ship', () => {
  for (const id of IDS) assert.ok(TM.info(id), id); for (const id of Object.keys(TM.TOOLS)) assert.ok(IDS.includes(id), id + ' ships');
  assert.equal(new Set(IDS).size, IDS.length);
});
test('autoSetup keeps its old call shape for tools and tests: approved, enabled, failed, skipped, plus reasons and tests', async () => {
  const { m, h } = await start(); await signInTo(h); const mgr = h.ghost.manager; fakeTests(mgr); acceptTerms(h.app); await h.app.mem.autoSetup;
  mgr.disable('hash-file'); const r = await autoSetup(mgr, { only: ['hash-file', 'exif-meta'], test: false });
  for (const k of ['approved', 'enabled', 'failed', 'skipped', 'reasons', 'ready', 'tests']) assert.ok(k in r, k);
  assert.deepEqual(r.skipped, ['hash-file']); assert.deepEqual(r.ready, ['exif-meta']);
  assert.ok(registerBuiltins);
  await done(h, m);
});
