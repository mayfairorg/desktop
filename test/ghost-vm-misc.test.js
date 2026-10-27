'use strict';
// Ghost virtual computer: the tool library list, "Run from GitHub", the encrypted disk module, the guest programs, and how the Ghost browser's
// kill switch and Tor use cover the virtual computer. No real QEMU and no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tmp, FAKE_IMG, launcher, FakeVm, makeRepo, MIT, RUN_SH, fakeVault, readLog } = require('./ghost-vm-helpers');
const { ToolLibrary, validateEntry, merge } = require('../src/main/ghost/vm/toollib');
const { RunFromGithub } = require('../src/main/ghost/vm/rungh');
const { VmDisk, keyDelivery } = require('../src/main/ghost/vm/disk');
const { validateResult } = require('../src/main/ghost/result');
const { GhostBrowserService } = require('../src/main/ghost/browser/service');
const H = require('./ghost-browser-helpers');

const SHA = 'a'.repeat(40), SUM = 'b'.repeat(64);
const entry = (o = {}) => ({ name: 'demo', source: { type: 'github', url: 'https://github.com/o/demo', repo: 'o/demo' }, commit: SHA, checksum: { algo: 'sha256', value: SUM }, version: '1.2.3', notes: ['ran on 2025-01-01: make'], ...o });

// ---- the tool library list
test('library list: fields are name, source, pinned commit, checksum, version, notes; export then import on another computer round trips', () => {
  const a = new ToolLibrary({ file: path.join(tmp(), 'g', 'toollib.json') });
  a.put(entry()); a.put(entry({ name: 'second', source: { type: 'upload', name: 'my-folder' }, commit: undefined }));
  const x = a.export(); assert.equal(x.schema, 1); assert.equal(x.kind, 'ghost-tool-library'); assert.deepEqual(x.tools.map((t) => t.name), ['demo', 'second']);
  assert.equal(fs.statSync(a.file).mode & 0o077, 0, 'private file');
  const b = new ToolLibrary({ file: path.join(tmp(), 'toollib.json') });
  const r = b.import(JSON.parse(JSON.stringify(x))); assert.equal(r.ok, true); assert.deepEqual(r.added, ['demo', 'second']);
  assert.deepEqual(r.fetch.map((e) => e.name), ['demo'], 'only a GitHub tool can be fetched again'); assert.deepEqual(r.manual, [{ name: 'second', source: 'my-folder' }]);
  assert.deepEqual(b.list().map((e) => [e.name, e.commit]), a.list().map((e) => [e.name, e.commit]));
  assert.deepEqual(new ToolLibrary({ file: b.file }).list(), b.list(), 'it is saved to the file and read back');
  const again = b.import(x); assert.deepEqual(again.fetch, []); assert.deepEqual(again.kept.sort(), ['demo', 'second']);
});
test('library list: only the listed fields are accepted, so no case data, results, notes of a case, secrets or paths can ride along', () => {
  for (const extra of [{ caseId: 'c1' }, { results: [1] }, { sharedFolder: '/home/me' }, { token: 'x' }, { path: '/etc' }, { entities: [] }]) assert.equal(validateEntry({ ...entry(), ...extra }).ok, false, Object.keys(extra)[0]);
  assert.equal(validateEntry(entry({ source: { type: 'github', url: 'https://github.com/o/demo', repo: 'o/demo', cwd: '/x' } })).ok, false);
  assert.equal(validateEntry(entry({ connector: { program: 'bin/run', secret: 'x' } })).ok, false);
  assert.equal(validateEntry(entry({ commit: 'main' })).ok, false, 'a GitHub tool is pinned to a 40-character commit'); assert.equal(validateEntry(entry({ commit: undefined })).ok, false);
  assert.equal(validateEntry(entry({ name: 'Bad Name' })).ok, false); assert.equal(validateEntry(entry({ name: '../x' })).ok, false);
  assert.equal(validateEntry(entry({ source: { type: 'github', url: 'http://github.com/o/demo', repo: 'o/demo' } })).ok, false);
  assert.equal(validateEntry(entry({ source: { type: 'github', url: 'https://evil.example/o/demo', repo: 'o/demo' } })).ok, false);
  assert.equal(validateEntry(entry({ checksum: { algo: 'md5', value: SUM } })).ok, false); assert.equal(validateEntry(entry({ checksum: { algo: 'sha256', value: 'zz' } })).ok, false);
  assert.equal(validateEntry(entry({ notes: new Array(31).fill('x') })).ok, false);
  const clean = validateEntry(entry()); assert.equal(clean.ok, true); assert.deepEqual(Object.keys(clean.entry).sort(), ['checksum', 'commit', 'name', 'notes', 'source', 'version']);
});
test('library list: a damaged or foreign file is ignored; a list with bad entries imports the good ones and names the rest', () => {
  const f = path.join(tmp(), 'toollib.json'); fs.writeFileSync(f, '{not json'); assert.deepEqual(new ToolLibrary({ file: f }).list(), []);
  fs.writeFileSync(f, JSON.stringify({ schema: 7, tools: [entry()] })); assert.deepEqual(new ToolLibrary({ file: f }).list(), []);
  const l = new ToolLibrary({ file: path.join(tmp(), 't.json') });
  assert.equal(l.import({ schema: 2 }).ok, false); assert.equal(l.import(null).ok, false); assert.equal(l.import({ schema: 1, kind: 'other', tools: [] }).ok, false);
  const r = l.import({ schema: 1, kind: 'ghost-tool-library', tools: [entry(), { ...entry({ name: 'bad' }), caseId: 'c' }, entry()] });
  assert.equal(r.ok, true); assert.deepEqual(r.added, ['demo']); assert.deepEqual(r.rejected.map((x) => x.name), ['bad']); assert.equal(l.list().length, 1, 'duplicates collapse');
});
test('library list: the same commit keeps this computer\'s entry; a different commit is a reported conflict and the newer change wins', () => {
  const t = (iso) => ({ addedAt: iso, updatedAt: iso });
  const local = [{ ...entry(), ...t('2025-01-02T00:00:00.000Z') }], remote = [{ ...entry({ commit: 'c'.repeat(40), checksum: { algo: 'sha256', value: 'd'.repeat(64) } }), ...t('2025-03-01T00:00:00.000Z') }];
  const m = merge(local, remote); assert.equal(m.conflicts[0].chose, 'remote'); assert.equal(m.tools[0].commit, 'c'.repeat(40)); assert.deepEqual(m.updated, ['demo']);
  const m2 = merge(remote, local); assert.equal(m2.conflicts[0].chose, 'remote' === 'local' ? '' : 'local'); assert.equal(m2.tools[0].commit, 'c'.repeat(40));
  const same = merge([{ ...entry(), ...t('2025-01-02T00:00:00.000Z') }], [{ ...entry({ licence: 'MIT' }), ...t('2025-01-01T00:00:00.000Z') }]); assert.equal(same.conflicts.length, 0); assert.equal(same.tools[0].licence, 'MIT', 'a missing field is filled in');
  const l = new ToolLibrary({ file: path.join(tmp(), 't.json'), now: () => Date.parse('2025-06-01T00:00:00Z') });
  l.put(entry()); assert.equal(l.get('demo').updatedAt, '2025-06-01T00:00:00.000Z'); assert.equal(l.remove('demo'), true); assert.equal(l.remove('demo'), false);
  assert.throws(() => l.put({ ...entry(), extra: 1 }), /unknown keys/);
});

// ---- Run from GitHub
test('Run from GitHub: clones one commit inside the machine, shows README, licence and commands, never runs anything, and the page only asks by id', async () => {
  const root = tmp('mfd-rg-'); const repo = makeRepo(root, 'acme/cli', { 'README.md': '# CLI', LICENSE: MIT, 'package.json': JSON.stringify({ name: 'cli', scripts: { start: 'node x.js' } }), 'go.mod': 'module x\n' });
  const vm = new FakeVm(path.join(root, 'guest'), { 'acme/cli': repo.bare }); const g = new RunFromGithub({ vm });
  const r = await g.clone({ url: 'https://github.com/acme/cli' });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.dir, '/home/ghost/src/acme-cli'); assert.equal(r.commit, repo.commit); assert.deepEqual(r.detected.sort(), ['go', 'node']);
  assert.match(r.readme.text, /# CLI/); assert.equal(r.licenceFile.name, 'LICENSE'); assert.equal(r.replaced, false); assert.match(r.note, /Nothing has been run/);
  const cmds = r.suggestions.map((s) => s.command); assert.ok(cmds.includes('cd /home/ghost/src/acme-cli && npm install')); assert.ok(cmds.includes('cd /home/ghost/src/acme-cli && go build ./...'));
  assert.ok(r.suggestions.every((s) => !('argv' in s)));
  assert.ok(!fs.existsSync(path.join(root, 'guest', 'home', 'src', 'acme-cli', 'node_modules')));
  assert.ok(vm.calls.every((a) => !['npm', 'go', 'make', 'pip'].includes(a[0])), 'no setup command was run');
  const s = g.commandText({ name: 'acme-cli', id: r.suggestions[0].id }); assert.equal(s.ok, true); assert.equal(s.command, r.suggestions[0].command);
  assert.equal(g.commandText({ name: 'acme-cli', id: 'node-99' }).ok, false); assert.equal(g.commandText({ name: 'other', id: 'node-0' }).ok, false);
  assert.equal((await g.clone({ url: 'https://github.com/acme/cli' })).replaced, true, 'cloning again replaces the old copy');
  const first = repo.commit; repo.add({ 'README.md': '# CLI 2' }); assert.equal((await g.clone({ url: 'https://github.com/acme/cli', ref: first })).commit, first, 'a commit can be asked for');
  assert.equal((await g.clone({ url: 'https://example.com/a/b' })).code, 'bad-url'); assert.equal((await g.clone({ url: 'https://github.com/acme/cli', ref: '--x' })).code, 'bad-url');
  assert.equal((await g.clone({ url: 'https://github.com/acme/missing' })).code, 'clone-failed');
});

// ---- the encrypted disk
function diskRig(vault) {
  const dir = tmp('mfd-disk-'), log = path.join(dir, 'log'); const img = launcher(dir, 'qemu-img', FAKE_IMG);
  const d = new VmDisk({ caseId: 'c1', dir: path.join(dir, 'case'), vault: () => vault, qemuImg: () => img, env: { PATH: process.env.PATH, FAKE_LOG: log } });
  return { d, dir, log: () => readLog(log) };
}
test('disk: encrypted under a random key kept in the vault; the key goes to qemu-img by descriptor and never into a command line', async () => {
  const v = fakeVault(); const { d, log } = diskRig(v);
  assert.deepEqual(await d.ensure({ baseDisk: '/b.qcow2', baseId: 'id1' }), { created: true, encrypted: true });
  const k = v.m.get('connectors/vmkey-c1'); assert.match(k, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(log()).includes(k)); assert.equal(log()[0].keyLen, 64); assert.ok(log()[0].args.includes('encrypt.format=luks,encrypt.key-secret=sec0'));
  assert.equal(d.encrypted(), true); assert.equal(fs.statSync(d.overlay).mode & 0o077, 0);
  assert.deepEqual(await d.snapshots(), []); await d.snapshot('s1'); assert.deepEqual((await d.snapshots()).map((s) => s.name), ['s1']);
  await assert.rejects(d.snapshot('s1'), (e) => e.code === 'exists'); await assert.rejects(d.snapshot('bad name'), (e) => e.code === 'bad-input');
  await assert.rejects(d.restore('missing'), (e) => e.code === 'snapshot');
  v.unlocked = false; await assert.rejects(d.snapshots(), (e) => e.code === 'vault-locked' && /Unlock the vault/.test(e.message));
  v.unlocked = true; v.m.clear(); await assert.rejects(d.snapshots(), (e) => e.code === 'key-missing' && /Reset the virtual computer/.test(e.message));
  d.reset(); assert.equal(d.exists(), false); assert.equal(d.encrypted(), false); assert.equal(v.m.size, 0);
});
test('disk: no vault means no disk until a plain one is allowed; a base image that changed needs a reset; a failed create leaves nothing', async () => {
  const { d } = diskRig(null);
  await assert.rejects(d.ensure({ baseDisk: '/b' }), (e) => e.code === 'vault-unavailable');
  assert.deepEqual(await d.ensure({ baseDisk: '/b', baseId: 'id1', allowPlain: true }), { created: true, encrypted: false });
  assert.deepEqual(await d.ensure({ baseDisk: '/b', baseId: 'id1' }), { created: false, encrypted: false });
  await assert.rejects(d.ensure({ baseDisk: '/b', baseId: 'id2' }), (e) => e.code === 'base-changed' && /Reset the virtual computer/.test(e.message));
  const v = fakeVault(); const r = diskRig(v);
  const dir = tmp(); const img = launcher(dir, 'qemu-img', FAKE_IMG);
  const bad = new VmDisk({ caseId: 'c2', dir: path.join(dir, 'c'), vault: () => v, qemuImg: () => img, env: { PATH: process.env.PATH, FAKE_IMG_FAIL: 'create' } });
  await assert.rejects(bad.ensure({ baseDisk: '/b' }), (e) => e.code === 'disk-create' && /fake failure/.test(e.message)); assert.equal(v.m.size, 0, 'the key is removed again'); assert.equal(bad.exists(), false);
  assert.throws(() => new VmDisk({ caseId: '../x', dir: '/x' }), /Bad case id/);
});
test('disk: key files have no name on disk on Linux and macOS; on Windows they exist only until cleanup, which overwrites and removes them', () => {
  const run = tmp('mfd-keys-');
  const p = keyDelivery({ platform: 'linux', keys: ['k'.repeat(64)], runDir: path.join(run, 'a') });
  assert.deepEqual(fs.readdirSync(path.join(run, 'a')), [], 'unlinked at once'); assert.match(p.fileArgs[0], /^\/dev\/fd\/3$/); assert.equal(fs.readFileSync('/dev/fd/' + p.stdio[3], 'utf8'), 'k'.repeat(64), 'the descriptor the child inherits holds the key'); p.cleanup();
  const w = keyDelivery({ platform: 'win32', keys: ['k'.repeat(64)], runDir: path.join(run, 'b') });
  assert.equal(fs.readdirSync(path.join(run, 'b')).length, 1); assert.equal(fs.readFileSync(w.fileArgs[0], 'utf8'), 'k'.repeat(64)); w.cleanup(); assert.deepEqual(fs.readdirSync(path.join(run, 'b')), []);
});

// ---- the guest programs
const py = (() => { try { cp.execFileSync('python3', ['-c', '1']); return true; } catch { return false; } })();
test('guest: the Python programs compile; the converter turns plain output into result lines Ghost accepts, marked uncertain', { skip: !py }, () => {
  const g = path.join(__dirname, '..', 'tools', 'ghost-vm', 'guest'); const run = (args, env = {}) => cp.spawnSync('python3', ['-I', path.join(g, 'ghost-wrap.py'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, MF_CONNECTOR_ID: 'demo-tool', ...env } });
  for (const f of ['ghost-agent.py', 'ghost-netd.py', 'ghost-wrap.py']) assert.equal(cp.spawnSync('python3', ['-I', '-c', 'import sys;compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', path.join(g, f)]).status, 0, f);
  const lines = run(['--as', 'lines', '--type', 'domain', '--tool', 'demo', '--version', '1.0.0', '--', 'printf', 'a.example\n\nb.example\n']);
  assert.equal(lines.status, 0); const out = lines.stdout.trim().split('\n').map((l) => JSON.parse(l)); assert.equal(out.length, 2);
  for (const o of out) { const v = validateResult(o, { connector: 'demo-tool' }); assert.equal(v.ok, true, v.error); assert.equal(o.confidence, 'uncertain'); assert.ok(o.uncertaintyNote); }
  assert.deepEqual(out.map((o) => o.entity.value), ['a.example', 'b.example']);
  const json = run(['--as', 'json', '--type', 'finding', '--', 'printf', '[{"a":1},"two",3]']); assert.deepEqual(json.stdout.trim().split('\n').map((l) => JSON.parse(l).entity.value), ['{"a":1}', 'two', '3']);
  const bad = run(['--as', 'json', '--type', 'finding', '--', 'printf', 'not json']); assert.notEqual(bad.status, 0); assert.equal(bad.stdout, ''); assert.match(bad.stderr, /valid JSON/);
  assert.equal(run(['--as', 'lines', '--type', 'Bad Type', '--', 'true']).status, 2); assert.equal(run(['--as', 'lines']).status, 2); assert.equal(run(['--as', 'lines', '--type', 'x', '--', '/nonexistent/prog']).status, 127);
  assert.equal(run(['--as', 'lines', '--type', 'x', '--', 'sh', '-c', 'echo hi; exit 7']).status, 7, 'the program\'s exit code is kept');
});
test('guest: the agent only touches files under the tools and home folders', { skip: !py }, () => {
  const g = path.join(__dirname, '..', 'tools', 'ghost-vm', 'guest', 'ghost-agent.py');
  const code = `import importlib.util, json, sys\nspec = importlib.util.spec_from_file_location('ga', sys.argv[1]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\na = m.Agent.__new__(m.Agent); a.prefixes = m.ALLOWED\nprint(json.dumps([a.safe_path(p) for p in json.loads(sys.argv[2])]))`;
  const cases = ['/opt/ghost-tools/x/y.py', '/home/ghost/src/z', '/opt/ghost-tools', '/opt/ghost-tools/', '/opt/ghost-toolsx/a', '/etc/passwd', '/opt/ghost-tools/../etc/passwd', '/opt/ghost-tools/a/../../etc', 'relative/path', '/home/ghostly/x', '/home/ghost/..', '', '/opt/ghost-tools//a'];
  const r = cp.spawnSync('python3', ['-I', '-B', '-c', code, g, JSON.stringify(cases)], { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } }); assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['/opt/ghost-tools/x/y.py', '/home/ghost/src/z', null, null, null, null, null, null, null, null, null, null, null]);
});

// ---- the Ghost browser's kill switch and Tor cover the virtual computer
function browser() {
  const el = H.fakeElectron(), handles = [], tor = new H.FakeTor(), vault = H.mkVault();
  const svc = new GhostBrowserService({ electron: el, tor, vault: () => vault, makeWindow: H.fakeHandleFactory(handles), confirm: async () => true, restoreResolver: async () => {}, emit: () => {}, chromeVersion: '141.0.7390.54' });
  return { svc, tor, vault, handles };
}
test('kill switch: the Ghost kill also stops the virtual computer (before the vault locks), and one failing hook does not stop the others', async () => {
  const t = browser(); const order = [];
  t.svc.killHooks.push(async () => { order.push('vm:' + t.vault.unlocked); }, () => { throw new Error('boom'); }, () => { order.push('other'); });
  await t.svc.open({ caseId: 'k1' });
  const r = await t.svc.kill(); assert.deepEqual(order, ['vm:true', 'other']); assert.equal(r.report.hooks, 2); assert.equal(r.report.vaultLocked, true);
});
test('Tor is shared: closing the last Ghost browser window keeps Tor while the virtual computer routes through it', async () => {
  const t = browser(); let vmUses = true; t.svc.torHolds.push(() => vmUses);
  await t.svc.open({ caseId: 'a' }); assert.equal(t.tor.starts, 1);
  await t.svc.close('a'); assert.equal(t.tor.stops, 0, 'still held by the virtual computer');
  vmUses = false; await t.svc.open({ caseId: 'b' }); await t.svc.close('b'); assert.ok(t.tor.stops >= 1, 'released when nothing else uses it');
});
