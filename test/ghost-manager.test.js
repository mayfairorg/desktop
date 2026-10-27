'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { context, stage, tmp, baseManifest, SCRIPT } = require('./ghost-helpers');
const { ConnectorManager } = require('../src/main/ghost/manager');

const ENTRY_KEYS = ['approvedAt', 'capabilities', 'description', 'externalRestrictions', 'health', 'id', 'install', 'licence', 'name', 'network', 'permissions', 'scope', 'state', 'version'];

test('the sample installs into userData on request, no network, and starts not approved', () => {
  const c = context();
  const r = c.manager.installSample();
  assert.deepEqual(r, { ok: true, id: 'sample-textstats' });
  assert.ok(fs.existsSync(path.join(c.root, 'connectors', 'sample-textstats', 'connector.json')));
  assert.ok(fs.existsSync(path.join(c.root, 'connectors', 'sample-textstats', 'run.js')));
  assert.deepEqual(c.manager.installSample(), { ok: true, id: 'sample-textstats', alreadyInstalled: true });
  const [e] = c.manager.list();
  assert.deepEqual(Object.keys(e).sort(), ENTRY_KEYS);
  assert.equal(e.state, 'not-approved');
  assert.equal(e.approvedAt, null);
  assert.equal(e.health, 'ok');
  assert.equal(e.network, 'local');
  assert.deepEqual(e.install, { requirements: [{ name: "Mayfair's built-in Node runtime", status: 'untested', detail: 'not checked yet' }], installed: false, verified: 'not-tested', lastTest: null });
});
test('list entries have the exact documented shape', () => {
  const c = context();
  c.manager.installSample();
  const e = c.manager.list()[0];
  assert.equal(typeof e.id, 'string'); assert.equal(typeof e.name, 'string'); assert.equal(typeof e.version, 'string'); assert.equal(typeof e.description, 'string');
  assert.ok(Array.isArray(e.capabilities)); assert.ok(['local', 'passive', 'active'].includes(e.scope));
  assert.deepEqual(Object.keys(e.licence).sort(), ['mode', 'spdx', 'url']);
  assert.deepEqual(Object.keys(e.install).sort(), ['installed', 'lastTest', 'requirements', 'verified']);
  assert.ok(Array.isArray(e.permissions)); assert.equal(typeof e.externalRestrictions, 'string');
  const g = c.manager.get('sample-textstats');
  assert.ok(g.input.fields.length === 2 && g.limits.timeoutMs && g.command.executable === '@node');
  assert.equal(c.manager.get('nothing-here'), null);
});

test('state machine: not-approved -> approved -> enabled -> disabled -> enabled; declined stays not-approved', async () => {
  const c = context();
  const id = c.manager.register(stage()).id;
  c.answer.value = false;
  assert.deepEqual(await c.manager.requestApproval(id), { ok: false, error: 'declined' });
  assert.equal(c.manager.list()[0].state, 'not-approved');
  assert.deepEqual(c.manager.enable(id), { ok: false, error: 'not-approved' }, 'cannot enable without approval');
  c.answer.value = true;
  const a = await c.manager.requestApproval(id);
  assert.deepEqual(a, { ok: true, state: 'approved' });
  let e = c.manager.list()[0];
  assert.equal(e.state, 'approved'); assert.ok(e.approvedAt > 0);
  assert.deepEqual(c.manager.enable(id), { ok: true, state: 'enabled' });
  assert.equal(c.manager.list()[0].state, 'enabled');
  assert.deepEqual(c.manager.disable(id), { ok: true, state: 'disabled' });
  assert.equal(c.manager.list()[0].state, 'disabled');
  assert.equal(c.manager.enable(id).state, 'enabled');
  assert.equal((await c.manager.requestApproval(id)).already, true, 'asking again does not open another dialog');
  assert.equal(c.answer.calls.filter((x) => x.kind === 'approve').length, 2);
});
test('the approval dialog names the connector, version, scope, network and permissions', async () => {
  const c = context();
  const id = c.manager.register(stage({ permissions: ['temp-files'], externalRestrictions: 'Only for your own domains.' })).id;
  await c.manager.requestApproval(id);
  const o = c.answer.calls[0];
  assert.equal(o.kind, 'approve');
  const all = o.title + '\n' + o.message + '\n' + o.detail;
  for (const t of ['Test connector', '1.0.0', 'local', 'temp-files', 'Only for your own domains.', 'MIT']) assert.ok(all.includes(t), t);
  assert.ok(/Scope:/.test(o.detail) && /Network:/.test(o.detail) && /Permissions:/.test(o.detail));
});
test('the approval record stores the manifest and program hashes', async () => {
  const c = context();
  const id = c.manager.register(stage()).id;
  await c.manager.requestApproval(id);
  const st = JSON.parse(fs.readFileSync(path.join(c.root, 'ghost', 'state.json'), 'utf8'));
  const ap = st.connectors[id].approval;
  assert.match(ap.manifestSha, /^[0-9a-f]{64}$/);
  assert.match(ap.files['run.js'], /^[0-9a-f]{64}$/);
  assert.match(ap.combined, /^[0-9a-f]{64}$/);
  assert.equal(ap.version, '1.0.0'); assert.equal(ap.scope, 'local');
});
test('approval is revoked when the program file changes', async () => {
  const c = context();
  const id = await c.ready();
  assert.equal(c.manager.list()[0].state, 'enabled');
  fs.appendFileSync(path.join(c.root, 'connectors', id, 'run.js'), '\n// changed\n');
  const e = c.manager.list()[0];
  assert.equal(e.state, 'not-approved');
  assert.equal(e.health, 'changed');
  assert.equal(e.approvedAt, null);
  assert.equal(e.install.verified, 'not-tested');
  const r = c.runner.submit({ connector: id, input: { mode: 'ok' } });
  assert.equal(r.ok, false);
  assert.ok(['changed', 'not-approved'].includes(r.error));
  assert.deepEqual(c.manager.enable(id), { ok: false, error: 'not-approved' });
  // approving the new files clears the flag
  await c.manager.requestApproval(id);
  assert.equal(c.manager.list()[0].health, 'ok');
  assert.equal(c.manager.list()[0].state, 'approved');
});
test('approval is revoked when connector.json changes, even by one byte of whitespace', async () => {
  const c = context();
  const id = await c.ready();
  const f = path.join(c.root, 'connectors', id, 'connector.json');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + '\n');
  assert.equal(c.manager.list()[0].state, 'not-approved');
  assert.equal(c.manager.list()[0].health, 'changed');
});
test('the revocation is remembered across a restart', async () => {
  const c = context();
  const id = await c.ready();
  fs.appendFileSync(path.join(c.root, 'connectors', id, 'run.js'), '//x');
  c.manager.list();
  const m2 = new ConnectorManager({ root: c.root, confirm: async () => false });
  assert.equal(m2.list()[0].state, 'not-approved');
  assert.equal(m2.list()[0].health, 'changed');
});
test('a connector approved with one set of files is still approved after a restart if the files are unchanged', async () => {
  const c = context();
  const id = await c.ready();
  const m2 = new ConnectorManager({ root: c.root, confirm: async () => false });
  assert.equal(m2.list()[0].state, 'enabled');
  assert.equal(m2.list()[0].id, id);
});
test('a missing or damaged program is "broken" and revokes approval', async () => {
  const c = context();
  const id = await c.ready();
  fs.rmSync(path.join(c.root, 'connectors', id, 'run.js'));
  const e = c.manager.list()[0];
  assert.equal(e.health, 'broken');
  assert.equal(e.state, 'not-approved');
  assert.ok(e.errors.length);
  assert.equal(c.manager.validate(id).ok, false);
});
test('a broken manifest is listed as broken, not hidden', () => {
  const c = context();
  fs.mkdirSync(path.join(c.root, 'connectors', 'bad-one'), { recursive: true });
  fs.writeFileSync(path.join(c.root, 'connectors', 'bad-one', 'connector.json'), '{ not json');
  const [e] = c.manager.list();
  assert.equal(e.id, 'bad-one'); assert.equal(e.health, 'broken'); assert.equal(e.install.installed, false);
});
test('a corrupt state file approves nothing', async () => {
  const c = context();
  const id = await c.ready();
  fs.writeFileSync(path.join(c.root, 'ghost', 'state.json'), 'garbage');
  const m2 = new ConnectorManager({ root: c.root, confirm: async () => false });
  assert.equal(m2.list().find((x) => x.id === id).state, 'not-approved');
});

test('"installed" is never reported until the self-test passes', async () => {
  const c = context();
  const id = c.manager.register(stage()).id;
  assert.equal(c.manager.list()[0].install.installed, false);
  assert.deepEqual(await c.manager.test(id), { ok: false, error: 'not-approved' }, 'an unapproved connector is never run, not even for its self-test');
  await c.manager.requestApproval(id);
  c.manager.enable(id);
  let e = c.manager.list()[0];
  assert.equal(e.state, 'enabled');
  assert.equal(e.install.installed, false, 'approved and enabled is not the same as working');
  assert.equal(e.install.verified, 'not-tested');
  const t = await c.manager.test(id);
  assert.equal(t.passed, true);
  assert.equal(t.verified, 'tested');
  e = c.manager.list()[0];
  assert.equal(e.install.installed, true);
  assert.equal(e.install.verified, 'tested');
  assert.equal(e.install.lastTest.ok, true);
  assert.ok(e.install.lastTest.t > 0 && /passed/.test(e.install.lastTest.detail));
});
test('a failing self-test marks the connector failed and not installed', async () => {
  const c = context();
  const id = c.manager.register(stage({ selfTest: { input: { mode: 'fail' }, expect: { minResults: 1 } } })).id;
  await c.manager.requestApproval(id);
  const t = await c.manager.test(id);
  assert.equal(t.passed, false);
  assert.equal(t.verified, 'failed');
  const e = c.manager.list()[0];
  assert.equal(e.install.verified, 'failed'); assert.equal(e.install.installed, false);
  assert.match(e.install.lastTest.detail, /exit code 3/);
});
test('a self-test whose results do not match the expectation fails', async () => {
  const c = context();
  const id = c.manager.register(stage({ selfTest: { input: { mode: 'ok' }, expect: { minResults: 2, contains: [{ type: 'note', value: 'three' }] } } })).id;
  await c.manager.requestApproval(id);
  const t = await c.manager.test(id);
  assert.equal(t.verified, 'failed');
  assert.match(t.lastTest.detail, /was not produced/);
});
test('a self-test that prints an invalid line fails even if the exit code is 0', async () => {
  const c = context();
  const id = c.manager.register(stage({ selfTest: { input: { mode: 'badjson' }, expect: { minResults: 1 } } })).id;
  await c.manager.requestApproval(id);
  const t = await c.manager.test(id);
  assert.equal(t.verified, 'failed');
  assert.match(t.lastTest.detail, /rejected/);
});
test('an unmet install requirement fails the test without running the connector', async () => {
  const c = context();
  const id = c.manager.register(stage({ installRequirements: [{ name: 'Missing tool', check: ['definitely-not-a-real-program-xyz'] }] })).id;
  await c.manager.requestApproval(id);
  const t = await c.manager.test(id);
  assert.equal(t.verified, 'failed');
  assert.match(t.lastTest.detail, /requirement not met: Missing tool/);
  const e = c.manager.list()[0];
  assert.equal(e.install.requirements[0].status, 'missing');
  assert.equal(e.install.installed, false);
  assert.equal(c.runner.list().length, 0, 'no job was started');
});
test('requirement checks run only after approval, and only as argv', async () => {
  const c = context();
  const marker = path.join(tmp(), 'ran');
  const id = c.manager.register(stage({ installRequirements: [{ name: 'Touch', check: ['@node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`] }] })).id;
  c.manager.list(); c.manager.validate(id); c.manager.get(id);
  assert.equal(fs.existsSync(marker), false, 'nothing runs before approval');
  assert.equal((await c.manager.checkRequirements(id))[0].status, 'untested');
  await c.manager.requestApproval(id);
  const r = await c.manager.checkRequirements(id);
  assert.equal(r[0].status, 'ok');
  assert.equal(fs.existsSync(marker), true);
  assert.equal(c.manager.list()[0].install.requirements[0].status, 'ok');
});
test('a change after the test voids the test result', async () => {
  const c = context();
  const id = await c.ready();
  await c.manager.test(id);
  assert.equal(c.manager.list()[0].install.installed, true);
  fs.appendFileSync(path.join(c.root, 'connectors', id, 'run.js'), '//');
  const e = c.manager.list()[0];
  assert.equal(e.install.installed, false); assert.equal(e.install.verified, 'not-tested');
});

test('remove asks natively; declined keeps everything, confirmed deletes files and approval', async () => {
  const c = context();
  const id = await c.ready();
  c.answer.value = false;
  assert.deepEqual(await c.manager.remove(id), { ok: false, error: 'declined' });
  assert.equal(c.manager.list().length, 1);
  c.answer.value = true;
  assert.deepEqual(await c.manager.remove(id), { ok: true });
  assert.equal(c.answer.calls.at(-1).kind, 'remove');
  assert.equal(c.manager.list().length, 0);
  assert.ok(!fs.existsSync(path.join(c.root, 'connectors', id)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.root, 'ghost', 'state.json'), 'utf8')).connectors[id], undefined);
  assert.deepEqual(await c.manager.remove(id), { ok: false, error: 'not-installed' });
  assert.deepEqual(await c.manager.remove('../etc'), { ok: false, error: 'bad-id' });
  // reinstalling starts from scratch: not approved
  c.manager.register(stage());
  assert.equal(c.manager.list()[0].state, 'not-approved');
});
test('removing a connector cancels its running jobs', async () => {
  const c = context();
  const id = await c.ready();
  const j = c.runner.submit({ connector: id, input: { mode: 'sleep' } });
  await new Promise((r) => setTimeout(r, 300));
  await c.manager.remove(id);
  const job = await c.runner.wait(j.jobId);
  assert.equal(job.status, 'cancelled');
});

test('register refuses bad manifests, id mismatch, duplicates, links and oversized folders', () => {
  const c = context();
  const badDir = tmp('mfd-stage-'); fs.writeFileSync(path.join(badDir, 'connector.json'), JSON.stringify({ ...baseManifest(), command: { executable: '../../bin/sh', args: [] } }));
  const r1 = c.manager.register(badDir);
  assert.equal(r1.ok, false); assert.equal(r1.error, 'bad-manifest');
  assert.equal(c.manager.register(tmp('mfd-empty-')).error, 'bad-manifest');
  const ok = stage();
  assert.equal(c.manager.register(ok).ok, true);
  assert.equal(c.manager.register(ok).error, 'exists');
  const link = stage({ id: 'with-link' });
  fs.symlinkSync('/etc/passwd', path.join(link, 'passwd-link'));
  const r2 = c.manager.register(link);
  assert.equal(r2.ok, false); assert.match(r2.errors[0], /links are not allowed/);
  assert.ok(!fs.existsSync(path.join(c.root, 'connectors', 'with-link')), 'nothing is left behind');
  const miss = stage({ id: 'no-exe', command: { executable: '@node', args: ['absent.js'] } });
  const r3 = c.manager.register(miss);
  assert.equal(r3.ok, false); assert.match(r3.errors[0], /absent\.js is missing/);
});
test('a symlinked program that points outside the folder is refused at load', async () => {
  const c = context();
  const id = c.manager.register(stage()).id;
  const outside = path.join(tmp(), 'evil.js'); fs.writeFileSync(outside, 'process.exit(0)');
  const exe = path.join(c.root, 'connectors', id, 'run.js');
  fs.rmSync(exe); fs.symlinkSync(outside, exe);
  const e = c.manager.list()[0];
  assert.equal(e.health, 'broken');
  assert.match(e.errors[0], /not a plain file/);
  assert.equal((await c.manager.requestApproval(id)).ok, false);
});
test('the folder name must match the manifest id', () => {
  const c = context();
  fs.mkdirSync(path.join(c.root, 'connectors', 'other-name'), { recursive: true });
  fs.writeFileSync(path.join(c.root, 'connectors', 'other-name', 'connector.json'), JSON.stringify(baseManifest()));
  fs.writeFileSync(path.join(c.root, 'connectors', 'other-name', 'run.js'), SCRIPT);
  const e = c.manager.list()[0];
  assert.equal(e.health, 'broken'); assert.match(e.errors[0], /does not match the folder name/);
});
test('without a dialog nothing is ever approved', async () => {
  const root = tmp();
  const m = new ConnectorManager({ root });
  m.register(stage());
  assert.deepEqual(await m.requestApproval('test-conn'), { ok: false, error: 'declined' });
  assert.equal(m.list()[0].state, 'not-approved');
});
test('only a literal true from the dialog approves', async () => {
  const root = tmp();
  for (const v of [undefined, null, 1, 'yes', {}, 0]) {
    const m = new ConnectorManager({ root: tmp(), confirm: async () => v });
    m.register(stage());
    assert.equal((await m.requestApproval('test-conn')).ok, false, String(v));
  }
});
test('two requests while the dialog is open share one dialog', async () => {
  const root = tmp();
  let opened = 0, release;
  const gate = new Promise((r) => { release = r; });
  const m = new ConnectorManager({ root, confirm: async () => { opened++; await gate; return true; } });
  m.register(stage());
  const a = m.requestApproval('test-conn'), b = m.requestApproval('test-conn');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(opened, 1); assert.equal(ra.ok, true); assert.equal(rb.ok, true);
});
test('files that change while the approval dialog is open are not approved', async () => {
  const root = tmp();
  let m;
  m = new ConnectorManager({ root, confirm: async () => { fs.appendFileSync(path.join(root, 'connectors', 'test-conn', 'run.js'), '//swapped'); return true; } });
  m.register(stage());
  assert.deepEqual(await m.requestApproval('test-conn'), { ok: false, error: 'changed-during-approval' });
  assert.equal(m.list()[0].state, 'not-approved');
});

test('when the app\'s own node is switched off (installed build), "@node" is never started and the reason is shown', async () => {
  const root = tmp(); const marker = path.join(tmp(), 'started');
  const m = new ConnectorManager({ root, confirm: async () => true, nodeAvailable: false, nodePath: process.execPath });
  const { JobRunner } = require('../src/main/ghost/runner');
  const r = new JobRunner({ manager: m, ghostDir: path.join(root, 'ghost') }); m.setRunner(r);
  const id = m.register(stage({ installRequirements: [{ name: 'node', check: ['@node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'x')`] }] })).id;
  await m.requestApproval(id); m.enable(id);
  assert.equal(r.submit({ connector: id, input: { mode: 'ok' } }).error, 'runtime-unavailable');
  const t = await m.test(id);
  assert.equal(t.passed, false);
  assert.match(t.lastTest.detail, /switched off/);
  assert.equal(m.list()[0].install.installed, false);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(r.list().length, 0);
});
