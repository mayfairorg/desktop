'use strict';
// Ghost "Add a tool": GitHub or uploaded files go into the virtual computer (a stand-in here, running real git against local repositories),
// are pinned, previewed, set up by commands that are shown first, registered as a connector that runs INSIDE the machine through the
// existing approval, updated, removed, and carried to another computer by the library list. No network and no real QEMU.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp, FakeVm, makeRepo, MIT, RUN_SH, makeZip, until } = require('./ghost-vm-helpers');
const { ConnectorManager } = require('../src/main/ghost/manager');
const { JobRunner } = require('../src/main/ghost/runner');
const { GhostLog } = require('../src/main/ghost/logger');
const { ToolRuntime } = require('../src/main/ghost/vm/toolrun');
const { ToolLibrary } = require('../src/main/ghost/vm/toollib');
const { VmToolInstaller, buildConnector } = require('../src/main/ghost/vm/installer');

const FILES = (tag = 'v1') => ({ 'README.md': '# Demo tool\nDoes a demo.\n', LICENSE: MIT, Makefile: 'all:\n\techo built > built.txt\n', 'bin/run': RUN_SH(tag) });
const FORM = { program: 'bin/run', args: ['{text}'], output: 'jsonl', entityType: 'finding', inputLabel: 'Target', network: 'local', scope: 'local', licence: 'MIT', restrictions: 'None.' };

// One "computer": a stand-in machine, a connector manager and runner that know about it, a library list and the installer.
function computer(repos, o = {}) {
  const root = tmp('mfd-vmi-'); const vm = new FakeVm(path.join(root, 'guest'), repos);
  const asked = []; const answer = { value: true };
  const log = new GhostLog(path.join(root, 'ghost', 'logs'));
  const runtime = new ToolRuntime({ vm: () => vm });
  const manager = new ConnectorManager({ root, confirm: async (x) => { asked.push(x); return answer.value; }, log, vm: runtime });
  const runner = new JobRunner({ manager, log, ghostDir: path.join(root, 'ghost'), vm: runtime, emit: () => {} });
  manager.setRunner(runner);
  const library = new ToolLibrary({ file: path.join(root, 'ghost', 'toollib.json') });
  const picks = { next: null };
  const inst = new VmToolInstaller({ vm, manager, library, dir: path.join(root, 'ghost', 'vm'), pick: async () => picks.next, ...(o.inst || {}) });
  return { root, vm, asked, answer, manager, runner, library, inst, picks };
}
const demo = () => { const root = tmp('mfd-vmr-'); return { root, demo: makeRepo(root, 'acme/demo-tool', FILES()) }; };
const GH = 'https://github.com/acme/demo-tool';

async function added(c, repo, o = {}) {
  const p = await c.inst.prepareGithub({ url: GH, ...o }); assert.equal(p.ok, true, JSON.stringify(p));
  const k = await c.inst.commit(p.token); assert.equal(k.ok, true, JSON.stringify(k));
  return { p, k };
}

test('GitHub: the commit is fetched inside the machine, pinned, and shown with README, licence, checksum and suggested setup; nothing is kept until asked', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const p = await c.inst.prepareGithub({ url: GH });
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.commit, repo.commit); assert.match(p.commit, /^[0-9a-f]{40}$/); assert.match(p.checksum, /^[0-9a-f]{64}$/);
  assert.equal(p.name, 'acme-demo-tool'); assert.equal(p.guestDir, '/opt/ghost-tools/acme-demo-tool');
  assert.match(p.readme.text, /Demo tool/); assert.equal(p.licenceFile.name, 'LICENSE'); assert.equal(p.licenceGuess, 'MIT');
  assert.deepEqual(p.detected, ['make']);
  assert.equal(p.suggestions[0].command, 'cd /opt/ghost-tools/acme-demo-tool && make'); assert.ok(!('argv' in p.suggestions[0]), 'the page sees text, not what is run');
  assert.match(p.note, /Nothing has been run/);
  assert.deepEqual(c.inst.list(), [], 'not kept yet'); assert.deepEqual(c.library.list(), []);
  assert.ok(fs.existsSync(c.vm.guest(p.guestDir + '/Makefile')));
  assert.ok(!fs.existsSync(c.vm.guest(p.guestDir + '/built.txt')), 'the Makefile was NOT run');
  await c.inst.cancel(p.token);
  assert.ok(!fs.existsSync(c.vm.guest(p.guestDir)), 'cancel removes it from the machine');
});
test('GitHub: a tag or commit can be asked for; bad addresses and refs are refused; a name that is taken is refused', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const first = repo.commit; repo.add(FILES('v2'), 'second');
  const old = await c.inst.prepareGithub({ url: GH, ref: first }); assert.equal(old.ok, true, JSON.stringify(old)); assert.equal(old.commit, first);
  await c.inst.cancel(old.token);
  for (const bad of ['http://github.com/a/b', 'https://gitlab.com/a/b', 'https://github.com/a', 'ftp://x', '', 'https://github.com/a/b/../../c']) assert.equal((await c.inst.prepareGithub({ url: bad })).code, 'bad-url', bad);
  for (const bad of ['--upload-pack=x', 'a..b', '-x']) assert.equal((await c.inst.prepareGithub({ url: GH, ref: bad })).code, 'bad-url', bad);
  await added(c, repo);
  assert.equal((await c.inst.prepareGithub({ url: GH })).code, 'exists');
  const missing = await c.inst.prepareGithub({ url: 'https://github.com/acme/none' }); assert.equal(missing.ok, false); assert.equal(missing.code, 'clone-failed');
});
test('keeping a tool records the pin in the tools list and the library list (no case data), and writes the pin next to the files', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo);
  assert.equal(k.name, 'acme-demo-tool');
  const [t] = c.inst.list(); assert.equal(t.commit, repo.commit); assert.equal(t.registered, false); assert.equal(t.source.url, GH);
  const [e] = c.library.list(); assert.deepEqual(Object.keys(e).sort(), ['addedAt', 'checksum', 'commit', 'licence', 'name', 'source', 'updatedAt']);
  assert.equal(e.commit, repo.commit); assert.equal(e.checksum.algo, 'sha256'); assert.deepEqual(e.source, { type: 'github', url: GH, repo: 'acme/demo-tool', ref: 'HEAD' });
  const pin = JSON.parse(fs.readFileSync(c.vm.guest('/opt/ghost-tools/acme-demo-tool/.ghost-pin.json'), 'utf8')); assert.equal(pin.commit, repo.commit);
  const again = await c.inst.commit(k.token || 'a'.repeat(24)); assert.equal(again.ok, false);
});
test('nothing blocks what a person adds: no name checks, no lists of tools; Ghost itself ships and suggests none', async () => {
  const root = tmp('mfd-vmr-'); const repos = {};
  for (const r of ['sherlock-project/sherlock', 'megadose/holehe', 'soxoj/maigret']) repos[r] = makeRepo(root, r, { 'README.md': 'x', 'requirements.txt': 'requests\n' }).bare;
  const c = computer(repos);
  for (const u of Object.keys(repos)) { const p = await c.inst.prepareGithub({ url: 'https://github.com/' + u }); assert.equal(p.ok, true, u); assert.equal((await c.inst.commit(p.token)).ok, true, u); }
  assert.equal(c.inst.list().length, 3);
  // the shipped code names no such tool
  const names = /sherlock|holehe|maigret|whatsmyname|phoneinfoga|socialscan|ignorant|blackbird|spiderfoot/i;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  for (const f of [...walk(path.join(__dirname, '..', 'src', 'main', 'ghost', 'vm')), ...walk(path.join(__dirname, '..', 'src', 'ui', 'ghost-vm')), ...walk(path.join(__dirname, '..', 'tools', 'ghost-vm'))]) assert.ok(!names.test(fs.readFileSync(f, 'utf8')), f);
});

test('setup commands: shown by id, run only on request inside the machine, output kept, notes recorded; unknown ids refused', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const p = await c.inst.prepareGithub({ url: GH });
  const r = c.inst.runSetup({ name: p.name, ids: [p.suggestions[0].id] }); assert.equal(r.ok, true);
  assert.equal((await c.inst.runSetup({ name: p.name, ids: [p.suggestions[0].id] })).code, 'busy');
  await until(() => c.inst.setupRun(r.runId).status !== 'running');
  const run = c.inst.setupRun(r.runId); assert.equal(run.status, 'done'); assert.match(run.output, /\$ cd \/opt\/ghost-tools\/acme-demo-tool && make/);
  assert.equal(fs.readFileSync(c.vm.guest(p.guestDir + '/built.txt'), 'utf8').trim(), 'built');
  assert.equal(c.inst.runSetup({ name: p.name, ids: ['rm -rf /'] }).code, 'bad-input'); assert.equal(c.inst.runSetup({ name: p.name, ids: [] }).code, 'bad-input'); assert.equal(c.inst.runSetup({ name: 'nope', ids: ['make-0'] }).code, 'not-installed');
  assert.equal((await c.inst.commit(p.token)).ok, true);
  const r2 = c.inst.runSetup({ name: p.name, ids: ['make-0'] }); await until(() => c.inst.setupRun(r2.runId).status !== 'running');
  const [e] = c.library.list(); assert.match(e.notes[0], /^ran on \d{4}-\d\d-\d\d: cd \/opt\/ghost-tools\/acme-demo-tool && make$/); assert.equal(e.setup[0].label, 'Build');
  const o = await c.inst.setupOptions(p.name); assert.equal(o.ok, true); assert.equal(o.suggestions[0].id, 'make-0');
});
test('setup commands that fail are reported with their exit code, and a run can be cancelled', async () => {
  const root = tmp('mfd-vmr-'); const repo = makeRepo(root, 'acme/broken', { Makefile: 'all:\n\t@echo oops >&2; exit 3\n' }); const c = computer({ 'acme/broken': repo.bare });
  const p = await c.inst.prepareGithub({ url: 'https://github.com/acme/broken' });
  const r = c.inst.runSetup({ name: p.name, ids: ['make-0'] }); await until(() => c.inst.setupRun(r.runId).status !== 'running');
  const run = c.inst.setupRun(r.runId); assert.equal(run.status, 'failed'); assert.match(run.output, /oops/); assert.match(run.output, /exit code 2/); assert.equal(run.steps[0].state, 'failed');
  assert.equal(c.inst.cancelSetup('rnope').ok, true);
});

test('connector: the description is checked, previewed first, and registered NOT approved; the approval dialog names the machine and the commit', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo);
  const pv = c.inst.previewConnector({ name: k.name, form: FORM });
  assert.equal(pv.ok, true); assert.equal(pv.command, '/opt/ghost-tools/acme-demo-tool/bin/run {text}');
  assert.equal(pv.manifest.command.executable, 'ghost-vm.json'); assert.deepEqual(pv.manifest.command.args, ['{text}']);
  assert.equal(pv.marker.commit, repo.commit); assert.equal(c.manager.list().length, 0, 'a preview writes nothing');
  for (const bad of [{ ...FORM, licence: '' }, { ...FORM, program: '../../bin/sh' }, { ...FORM, program: '/bin/sh' }, { ...FORM, output: 'xml' }, { ...FORM, network: 'unavailable' }, { ...FORM, scope: 'root' }, { ...FORM, id: 'other-name' }, { ...FORM, entityType: 'Bad Type' }, { ...FORM, args: ['--x={text}', '{nope}'] }]) {
    const r = c.inst.previewConnector({ name: k.name, form: bad }); assert.equal(r.ok, false, JSON.stringify(bad)); assert.equal(r.code, 'bad-form');
  }
  const reg = await c.inst.register({ name: k.name, form: FORM }); assert.equal(reg.ok, true, JSON.stringify(reg));
  assert.equal((await c.inst.register({ name: k.name, form: FORM })).code, 'exists');
  const [cn] = c.manager.list(); assert.equal(cn.id, 'acme-demo-tool'); assert.equal(cn.state, 'not-approved');
  assert.deepEqual(fs.readdirSync(path.join(c.root, 'connectors', 'acme-demo-tool')).sort(), ['connector.json', 'ghost-vm.json']);
  assert.equal(c.inst.list()[0].registered, true);
  assert.equal(c.library.list()[0].connector.program, 'bin/run');
  const ok = await c.manager.requestApproval('acme-demo-tool'); assert.ok(ok);
  const dlg = c.asked.at(-1); assert.equal(dlg.kind, 'approve');
  assert.match(dlg.detail, /^Runs INSIDE the Ghost virtual computer, not on this computer\./); assert.match(dlg.detail, new RegExp('commit ' + repo.commit.slice(0, 12)));
});
test('connector: runs inside the machine through the runner (argv only, jsonl), self-test passes, and results carry the connector id', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo); await c.inst.register({ name: k.name, form: FORM });
  assert.equal((await c.manager.test('acme-demo-tool')).error, 'not-approved', 'nothing runs before approval');
  assert.equal(c.vm.calls.filter((a) => a[0].includes('bin/run')).length, 0);
  await c.manager.requestApproval('acme-demo-tool');
  const t = await c.manager.test('acme-demo-tool'); assert.equal(t.passed, true, JSON.stringify(t));
  assert.equal(c.manager.enable('acme-demo-tool').ok, true);
  const sub = c.runner.submit({ connector: 'acme-demo-tool', input: { text: 'a b; touch /tmp/pwned' } }); assert.equal(sub.ok, true, JSON.stringify(sub));
  const job = await c.runner.wait(sub.jobId); assert.equal(job.status, 'done', JSON.stringify(job.error));
  assert.equal(job.results[0].entity.value, 'v1-a b; touch /tmp/pwned'); assert.equal(job.results[0].source.connector, 'acme-demo-tool');
  const call = c.vm.calls.filter((a) => a[0].endsWith('/bin/run')).at(-1); assert.deepEqual(call, ['/opt/ghost-tools/acme-demo-tool/bin/run', 'a b; touch /tmp/pwned'], 'the input is one argument, never parsed by a shell');
  assert.ok(!fs.existsSync('/tmp/pwned'));
});
test('connector: a file changed inside the machine after approval is not run; a different commit is not run', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo); await c.inst.register({ name: k.name, form: FORM }); await c.manager.requestApproval('acme-demo-tool'); c.manager.enable('acme-demo-tool');
  const f = c.vm.guest('/opt/ghost-tools/acme-demo-tool/bin/run'); const orig = fs.readFileSync(f, 'utf8');
  fs.appendFileSync(f, '\necho tampered\n');
  const j1 = await c.runner.wait(c.runner.submit({ connector: 'acme-demo-tool', input: { text: 'x' } }).jobId);
  assert.notEqual(j1.status, 'done'); assert.match(String(j1.error + JSON.stringify(j1.stderr || '')), /changed inside the virtual computer/);
  fs.writeFileSync(f, orig, { mode: 0o755 });
  const j2 = await c.runner.wait(c.runner.submit({ connector: 'acme-demo-tool', input: { text: 'x' } }).jobId); assert.equal(j2.status, 'done');
  const cp = require('node:child_process'); const dir = c.vm.guest('/opt/ghost-tools/acme-demo-tool');
  cp.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@l', 'commit', '-q', '--allow-empty', '-m', 'sneaky'], { cwd: dir });
  const j3 = await c.runner.wait(c.runner.submit({ connector: 'acme-demo-tool', input: { text: 'x' } }).jobId);
  assert.notEqual(j3.status, 'done'); assert.match(String(j3.error + JSON.stringify(j3.stderr || '')), /different commit/);
});
test('connector: a tool whose files are gone (tools disk wiped) says so; and without the virtual computer a marked connector is refused on the host', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo); await c.inst.register({ name: k.name, form: FORM }); await c.manager.requestApproval('acme-demo-tool'); c.manager.enable('acme-demo-tool');
  fs.rmSync(c.vm.guest('/opt/ghost-tools/acme-demo-tool'), { recursive: true });
  const j = await c.runner.wait(c.runner.submit({ connector: 'acme-demo-tool', input: { text: 'x' } }).jobId); assert.notEqual(j.status, 'done');
  assert.match(String(j.error + JSON.stringify(j.stderr || '')), /not in the virtual computer|tools disk/);
  assert.equal((await c.inst.verifyPresent())[0].present, false);
  // the same connector folder on a manager that has no virtual computer
  const m2 = new ConnectorManager({ root: c.root, confirm: async () => true });
  const g = m2.get('acme-demo-tool'); assert.ok(g);
  const run = m2.prepareRun('acme-demo-tool', { text: 'x' }); assert.equal(run.ok, false); assert.equal(run.error, 'vm-unavailable');
});
test('connector: the marker is validated; a program that is not on the short list, a wrong folder or a bad commit is never started', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo); await c.inst.register({ name: k.name, form: FORM });
  const f = path.join(c.root, 'connectors', 'acme-demo-tool', 'ghost-vm.json'); const good = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const bad of [{ exe: 'sh' }, { exe: '/bin/sh' }, { exe: '/opt/ghost-tools/acme-demo-tool/../x' }, { exe: 'bash' }, { guestDir: '/opt/ghost-tools/other' }, { commit: 'HEAD' }, { mode: 'push' }, { v: 2 }]) {
    fs.writeFileSync(f, JSON.stringify({ ...good, ...bad }));
    assert.equal(c.manager._vmMarker(c.manager._assess('acme-demo-tool', { fresh: true }).l), null, JSON.stringify(bad));
  }
  fs.writeFileSync(f, JSON.stringify(good)); assert.ok(c.manager._vmMarker(c.manager._assess('acme-demo-tool', { fresh: true }).l));
});

test('update: shows what changed, re-pins on confirmation, and approval is withdrawn until the person approves the new commit', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo); await c.inst.register({ name: k.name, form: FORM }); await c.manager.requestApproval('acme-demo-tool'); c.manager.enable('acme-demo-tool');
  const same = await c.inst.prepareUpdate({ name: k.name }); assert.equal(same.upToDate, true);
  const old = repo.commit; const next = repo.add({ ...FILES('v2'), LICENSE: MIT + '\nExtra clause.\n' }, 'second');
  const u = await c.inst.prepareUpdate({ name: k.name }); assert.equal(u.ok, true, JSON.stringify(u));
  assert.equal(u.from, old); assert.equal(u.to, next); assert.ok(u.changedFiles >= 2); assert.equal(u.licenceTouched, true); assert.match(u.stat, /bin\/run/); assert.equal(u.registered, true);
  assert.equal(c.inst.list()[0].commit, old, 'nothing moved yet');
  const a = await c.inst.applyUpdate({ token: u.token }); assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.commit, next); assert.equal(a.needsApproval, true);
  assert.equal(c.inst.list()[0].commit, next); assert.equal(c.library.list()[0].commit, next);
  assert.equal(c.manager.list()[0].state, 'not-approved', 'the old approval no longer applies');
  const blocked = c.runner.submit({ connector: 'acme-demo-tool', input: { text: 'x' } }); assert.equal(blocked.ok, false, 'it does not run until approved again');
  await c.manager.requestApproval('acme-demo-tool'); assert.match(c.asked.at(-1).detail, new RegExp(next.slice(0, 12))); c.manager.enable('acme-demo-tool');
  const j2 = await c.runner.wait(c.runner.submit({ connector: 'acme-demo-tool', input: { text: 'x' } }).jobId); assert.equal(j2.status, 'done'); assert.equal(j2.results[0].entity.value, 'v2-x');
});
test('update: local changes inside the machine are named and only discarded on an explicit yes; a used-up token is refused', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo); repo.add(FILES('v2'));
  fs.appendFileSync(c.vm.guest('/opt/ghost-tools/acme-demo-tool/README.md'), 'local edit\n');
  const u = await c.inst.prepareUpdate({ name: k.name }); assert.deepEqual(u.localChanges.map((l) => l.trim().split(/\s+/).pop()), ['README.md']);
  const no = await c.inst.applyUpdate({ token: u.token }); assert.equal(no.code, 'local-changes');
  const yes = await c.inst.applyUpdate({ token: u.token, discardChanges: true }); assert.equal(yes.ok, true);
  assert.ok(!/local edit/.test(fs.readFileSync(c.vm.guest('/opt/ghost-tools/acme-demo-tool/README.md'), 'utf8')));
  assert.equal((await c.inst.applyUpdate({ token: u.token })).code, 'expired');
  for (const bad of ['--upload-pack=x', 'a..b']) assert.equal((await c.inst.prepareUpdate({ name: k.name, ref: bad })).code, 'bad-input');
  assert.equal((await c.inst.prepareUpdate({ name: 'zzz' })).code, 'not-installed');
});
test('remove: forgets the tool, removes its connector and library entry, and deletes its files in the machine', async () => {
  const { demo: repo } = demo(); const c = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(c, repo); await c.inst.register({ name: k.name, form: FORM }); await c.manager.requestApproval('acme-demo-tool');
  const r = await c.inst.remove({ name: k.name }); assert.equal(r.ok, true); assert.equal(r.filesGone, true);
  assert.deepEqual(c.inst.list(), []); assert.deepEqual(c.library.list(), []); assert.deepEqual(c.manager.list(), []);
  assert.ok(!fs.existsSync(c.vm.guest('/opt/ghost-tools/acme-demo-tool')));
  assert.equal((await c.inst.remove({ name: k.name })).code, 'not-installed');
});

test('upload: a folder, a zip or a script becomes a pinned checkout inside the machine; links, bad names and oversize are refused', async () => {
  const c = computer({}); const src = tmp('mfd-up-');
  fs.mkdirSync(path.join(src, 'mytool', 'bin'), { recursive: true }); fs.writeFileSync(path.join(src, 'mytool', 'README.md'), 'mine'); fs.writeFileSync(path.join(src, 'mytool', 'bin', 'run'), RUN_SH('up'), { mode: 0o755 });
  c.picks.next = path.join(src, 'mytool');
  const p = await c.inst.prepareUpload({ kind: 'folder' }); assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.name, 'mytool'); assert.equal(p.source.type, 'upload'); assert.match(p.commit, /^[0-9a-f]{40}$/); assert.ok(p.files.includes('bin'));
  assert.equal((await c.inst.commit(p.token)).ok, true);
  assert.equal(c.library.list()[0].source.type, 'upload'); assert.equal(c.library.list()[0].commit, p.commit);
  assert.ok(fs.statSync(c.vm.guest('/opt/ghost-tools/mytool/bin/run')).mode & 0o100, 'the executable bit is kept');
  const z = path.join(src, 'zt.zip'); fs.writeFileSync(z, makeZip([['zt-main/README.md', 'z'], ['zt-main/tool.py', 'print(1)']])); c.picks.next = z;
  const pz = await c.inst.prepareUpload({ kind: 'zip' }); assert.equal(pz.ok, true, JSON.stringify(pz)); assert.equal(pz.name, 'zt'); assert.deepEqual(pz.files.sort(), ['README.md', 'tool.py']);
  const s = path.join(src, 'one.py'); fs.writeFileSync(s, 'print(2)'); c.picks.next = s;
  const ps = await c.inst.prepareUpload({ kind: 'script', name: 'one-script' }); assert.equal(ps.ok, true); assert.deepEqual(ps.files, ['one.py']);
  fs.symlinkSync('/etc', path.join(src, 'mytool', 'link')); c.picks.next = path.join(src, 'mytool');
  const bad = await c.inst.prepareUpload({ kind: 'folder', name: 'other' }); assert.equal(bad.ok, false); assert.match(bad.error, /links are not allowed/);
  fs.unlinkSync(path.join(src, 'mytool', 'link')); fs.writeFileSync(path.join(src, 'mytool', 'bad;name'), 'x');
  assert.match((await c.inst.prepareUpload({ kind: 'folder', name: 'other' })).error, /file name is not allowed/);
  c.picks.next = null; assert.equal((await c.inst.prepareUpload({ kind: 'folder' })).code, 'cancelled');
  assert.equal((await c.inst.prepareUpload({ kind: 'exe' })).code, 'bad-input');
  assert.ok(!fs.existsSync(c.vm.guest('/opt/ghost-tools/other')), 'a refused upload leaves nothing in the machine');
});

test('library list: another computer fetches each tool again at its pinned commit, verifies the checksum, and every connector needs approval again', async () => {
  const { demo: repo } = demo(); const a = computer({ 'acme/demo-tool': repo.bare });
  const { k } = await added(a, repo); await a.inst.register({ name: k.name, form: FORM }); await a.manager.requestApproval('acme-demo-tool'); a.manager.enable('acme-demo-tool');
  const list = a.library.export(); assert.equal(list.kind, 'ghost-tool-library'); assert.equal(list.tools.length, 1);
  repo.add(FILES('v2'), 'later');                                               // the repository moved on; the list pins the old commit
  const b = computer({ 'acme/demo-tool': repo.bare });
  const r = b.inst.importLibrary(JSON.parse(JSON.stringify(list))); assert.equal(r.ok, true); assert.deepEqual(r.plan, ['acme-demo-tool']);
  await until(() => b.inst.importStatus().done);
  const st = b.inst.importStatus(); assert.equal(st.items[0].status, 'installed', JSON.stringify(st));
  assert.equal(b.inst.list()[0].commit, list.tools[0].commit); assert.equal(b.inst.list()[0].checksum.value, list.tools[0].checksum.value);
  assert.equal(b.manager.list()[0].state, 'not-approved', 'approval is not carried over');
  assert.equal(b.asked.length, 0);
  await b.manager.requestApproval('acme-demo-tool'); b.manager.enable('acme-demo-tool');
  const j = await b.runner.wait(b.runner.submit({ connector: 'acme-demo-tool', input: { text: 'x' } }).jobId); assert.equal(j.status, 'done'); assert.equal(j.results[0].entity.value, 'v1-x', 'the pinned (old) commit, not the newest');
  const again = b.inst.importLibrary(list); await until(() => b.inst.importStatus().done); assert.equal(b.inst.importStatus().items.length, 0, 'nothing new to fetch the second time');
});
test('library list: a checksum or commit that does not match deletes what was fetched; bad lists are refused; uploaded tools are listed for manual adding', async () => {
  const { demo: repo } = demo(); const a = computer({ 'acme/demo-tool': repo.bare });
  await added(a, repo);
  const list = a.library.export();
  const tampered = JSON.parse(JSON.stringify(list)); tampered.tools[0].checksum.value = 'f'.repeat(64);
  const b = computer({ 'acme/demo-tool': repo.bare }); b.inst.importLibrary(tampered); await until(() => b.inst.importStatus().done);
  const it = b.inst.importStatus().items[0]; assert.equal(it.status, 'failed'); assert.match(it.error, /do not match the checksum/);
  assert.ok(!fs.existsSync(b.vm.guest('/opt/ghost-tools/acme-demo-tool')), 'deleted again'); assert.deepEqual(b.inst.list(), []);
  const wrong = JSON.parse(JSON.stringify(list)); wrong.tools[0].commit = '0'.repeat(40);
  const c = computer({ 'acme/demo-tool': repo.bare }); c.inst.importLibrary(wrong); await until(() => c.inst.importStatus().done); assert.equal(c.inst.importStatus().items[0].status, 'failed');
  assert.equal(c.inst.importLibrary({ schema: 9 }).code, 'bad-list');
  assert.equal(c.inst.importLibrary({ schema: 1, kind: 'ghost-tool-library', tools: [{ name: 'x', extra: 1 }] }).ok, true);
  assert.equal(c.inst.importStatus().items.length === 0, true);
});
test('buildConnector: wraps plain output with the converter, keeps jsonl as is, and every manifest it writes passes the manifest checks', () => {
  const t = { name: 'demo', commit: 'a'.repeat(40) };
  const j = buildConnector(t, { ...FORM }); assert.equal(j.marker.exe, '/opt/ghost-tools/demo/bin/run'); assert.deepEqual(j.manifest.command.args, ['{text}']);
  const p = buildConnector(t, { ...FORM, output: 'lines', program: 'python3', args: ['main.py', '{text}'] });
  assert.equal(p.marker.exe, 'ghost-wrap'); assert.deepEqual(p.manifest.command.args.slice(0, 8), ['--as', 'lines', '--type', 'finding', '--tool', 'demo', '--version', '1.0.0']); assert.deepEqual(p.manifest.command.args.slice(-3), ['python3', 'main.py', '{text}']);
  const n = buildConnector(t, { program: 'make', licence: 'NOASSERTION', inputLabel: '' }); assert.deepEqual(n.manifest.input.fields, []);
  assert.equal(buildConnector(t, { ...FORM, network: 'keyless-external', scope: 'passive' }).manifest.permissions[0], 'network');
});
