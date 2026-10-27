'use strict';
// Ghost virtual computer service on a fake qemu and a fake qemu-img (test/fixtures): download, start, isolation of the command line,
// disk encryption keys, terminals, network modes, reset, snapshots, case switching, kill. There is no real QEMU and no network here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { rig, until, killAll } = require('./ghost-vm-helpers');
test.after(() => killAll());

const installed = async (o) => { const r = await rig(o); const x = await r.svc.install(); assert.equal(x.ok, true, JSON.stringify(x)); return r; };
const started = async (o) => { const r = await installed(o); const s = await r.svc.start({ caseId: 'case1' }); assert.equal(s.ok, true, JSON.stringify(s)); return r; };
const arg = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

test('install: asks natively first, downloads from the pinned index, reports progress, and ends installed', async () => {
  const r = await rig();
  assert.equal((await r.svc.refresh()).state, 'not-installed');
  const x = await r.svc.install();
  assert.equal(x.ok, true); assert.equal(x.status.state, 'stopped'); assert.deepEqual(r.asked, ['download']);
  assert.equal(r.fetchLog.length, 4);
  assert.ok(r.events.some(([n, p]) => n === 'vm' && p.state === 'downloading' && p.download && p.download.total > 0));
  assert.equal(r.svc.status().installed, true);
});
test('install: declined means nothing is downloaded; an unpublished index and an unreachable host are said plainly', async () => {
  const no = await rig({ answer: () => false });
  const d = await no.svc.install(); assert.equal(d.code, 'declined'); assert.equal(no.fetchLog.length, 0); assert.equal(no.svc.status().state, 'not-installed');
  const un = await rig({ index: { schema: 1, published: false } });
  const u = await un.svc.install(); assert.equal(u.ok, false); assert.equal(u.code, 'not-published'); assert.match(u.error, /not been published/); assert.equal(un.fetchLog.length, 0); assert.equal(un.svc.status().notPublished, true);
  const dead = await rig({ fetchImpl: async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; } });
  const f = await dead.svc.install(); assert.equal(f.ok, false); assert.equal(f.code, 'unreachable'); assert.match(f.error, /cannot be downloaded from here/); assert.equal(dead.svc.status().state, 'not-installed');
});
test('install: a tampered download is refused; a changed file is caught at the next start', async () => {
  const r = await rig(); r.files[r.u('k')] = Buffer.from('KERNEL');
  const x = await r.svc.install(); assert.equal(x.code, 'checksum'); assert.equal(r.svc.status().state, 'not-installed');
  const g = await installed();
  fs.writeFileSync(g.svc.status().installed ? path.join(g.base, 'assets', 'x86_64', 'initrd') : '', 'swapped!');
  const s = await g.svc.start({ caseId: 'case1' }); assert.equal(s.ok, false); assert.match(s.error, /initrd|failed its check|Download it again/);
});

test('start: the command line has no network card or host access, one shared folder inside the case folder, and keys only as /dev/fd names', async () => {
  const r = await started();
  const run = r.log().find((l) => l.run); const argv = run.argv;
  assert.deepEqual(require('../src/main/ghost/vm/argv').selfCheck(argv), []);
  assert.equal(arg(argv, '-nic'), 'none'); assert.ok(argv.includes('-nodefaults'));
  const fsdev = argv.filter((x, i) => argv[i - 1] === '-fsdev'); assert.equal(fsdev.length, 1);
  const shared = fs.realpathSync(path.join(r.base, 'cases', 'case1', 'shared'));
  assert.ok(fsdev[0].startsWith('local,id=fs0,path=' + shared + ','));
  assert.equal(r.svc.status().share.dir, shared);
  assert.ok(!argv.some((x) => x.includes(require('node:os').homedir() + path.sep) && !x.includes(r.root)));
  // both disks are encrypted; the key reached the program through a descriptor (length seen by the fake), and is in no argument
  assert.deepEqual(run.keyLens, [64, 64]);
  const hex = [...r.vault.m.values()].filter((v) => /^[0-9a-f]{64}$/.test(v)); assert.equal(hex.length, 2);
  for (const k of hex) assert.ok(!JSON.stringify(argv).includes(k));
  assert.ok(argv.some((x) => /^secret,id=sec0,file=\/dev\/fd\/\d+$/.test(x)));
  assert.equal(r.svc.status().disk.encrypted, true); assert.match(r.svc.status().disk.note, /shared folder is not encrypted/);
  assert.equal(r.svc.status().state, 'running'); assert.equal(r.svc.status().accel.name, 'kvm'); assert.equal(r.svc.status().accel.fast, true);
  assert.equal(fs.readdirSync(r.root).filter((n) => n.startsWith('mfvm-')).length, 1, 'one run folder, holding no key file');
  const mounts = r.log().filter((l) => l.req === 'mount').map((l) => l.kind); assert.deepEqual(mounts, ['9p', 'tools']);
  await r.svc.kill();
});
test('start: resource caps are applied, validated and saved; they come from the settings, not from the page', async () => {
  const r = await installed();
  assert.equal(r.svc.setResources({ memMb: 100 }).ok, false); assert.equal(r.svc.setResources({ cpus: 99 }).ok, false); assert.equal(r.svc.setResources({ diskGb: 1 }).ok, false); assert.equal(r.svc.setResources({ memMb: 1024.5 }).ok, false);
  assert.equal(r.svc.setResources({ memMb: 1024, cpus: 1, diskGb: 8 }).ok, true);
  await r.svc.start({ caseId: 'case1' });
  const argv = r.log().find((l) => l.run).argv;
  assert.equal(arg(argv, '-m'), '1024M'); assert.equal(arg(argv, '-smp'), '1');
  assert.deepEqual(r.svc.status().resources, { memMb: 1024, cpus: 1, diskGb: 8 });
  assert.ok(r.log().some((l) => l.tool === 'qemu-img' && l.sub === 'create' && l.args.includes('8G')));
  await r.svc.kill();
});
test('start: without hardware acceleration it asks first, says it is slow, and a refusal starts nothing', async () => {
  const no = await installed({ accel: '', answer: (x) => x.kind !== 'slow' });
  const s = await no.svc.start({ caseId: 'case1' });
  assert.equal(s.ok, false); assert.equal(s.code, 'declined'); assert.ok(no.asked.includes('slow')); assert.equal(no.log().filter((l) => l.run).length, 0);
  assert.equal(no.svc.status().accel.fast, false); assert.match(no.svc.status().accel.notice, /much slower/);
  const yes = await installed({ accel: '' });
  const ok = await yes.svc.start({ caseId: 'case1' }); assert.equal(ok.ok, true);
  assert.equal(arg(yes.log().find((l) => l.run).argv, '-accel'), 'tcg,thread=multi'); assert.equal(yes.svc.status().accel.name, 'tcg');
  await yes.svc.kill();
});
test('start: with the vault locked the disk is made without encryption only after a native confirmation that says so', async () => {
  const no = await installed({ vault: null, answer: (x) => x.kind !== 'plain-disk' });
  const s = await no.svc.start({ caseId: 'case1' }); assert.equal(s.ok, false); assert.equal(s.code, 'declined'); assert.ok(no.asked.includes('plain-disk')); assert.equal(no.log().filter((l) => l.run).length, 0);
  const yes = await installed({ vault: null });
  assert.equal((await yes.svc.start({ caseId: 'case1' })).ok, true);
  assert.equal(yes.svc.status().disk.encrypted, false); assert.match(yes.svc.status().disk.note, /Not encrypted/); assert.deepEqual(yes.log().find((l) => l.run).keyLens, []);
  await yes.svc.kill();
});
test('start: a machine that exits, never reports in, or reports with the wrong token fails with a plain reason and leaves nothing running', async () => {
  const early = await installed({ env: { FAKE_MODE: 'exit-early' } });
  const e = await early.svc.start({ caseId: 'case1' }); assert.equal(e.ok, false); assert.match(e.error, /stopped while starting \(exit code 3\).*could not open the disk/); assert.equal(early.svc.status().state, 'stopped');
  const quiet = await installed({ env: { FAKE_MODE: 'no-hello' }, startTimeoutMs: 400 });
  const q = await quiet.svc.start({ caseId: 'case1' }); assert.equal(q.code, 'start-timeout'); assert.match(q.error, /did not report in/); assert.equal(quiet.svc.proc, null);
  const bad = await installed({ env: { FAKE_MODE: 'badtoken' }, startTimeoutMs: 400 });
  const b = await bad.svc.start({ caseId: 'case1' }); assert.equal(b.ok, false); assert.equal(bad.svc.agent, null);
  assert.equal(fs.readdirSync(early.root).filter((n) => n.startsWith('mfvm-')).length, 0, 'the run folder is removed');
});
test('start: a bad case id never reaches the disk or the share', async () => {
  const r = await installed();
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(41)]) { const s = await r.svc.start({ caseId: bad }); assert.equal(s.ok, false, bad); }
  assert.equal(fs.existsSync(path.join(r.base, 'cases')), false);
  assert.equal((await r.svc.useCase('../x')).ok, false);
});

test('terminals: a terminal runs in the machine; input and output flow; closing and a stopped machine end it', async () => {
  const r = await started();
  const t = await r.svc.open(7, { cols: 80, rows: 24 });
  assert.equal(t.mode, 'vm');
  await until(() => r.emitted.some(([, n, p]) => n === 'data' && p.id === t.id && /ghost\$/.test(p.data)));
  r.svc.input(7, t.id, 'ls\r');
  await until(() => r.emitted.some(([, n, p]) => n === 'data' && p.data === 'ls\r'));
  assert.throws(() => r.svc.input(8, t.id, 'x'), /no such terminal/, 'another window cannot use it');
  assert.throws(() => r.svc.input(7, 'ffff', 'x'), /no such terminal/);
  await assert.rejects(r.svc.open(7, { cols: 1, rows: 24 }), /bad size/);
  await r.svc.kill();
  assert.ok(r.emitted.some(([, n, p]) => n === 'exit' && p.id === t.id && p.signal === 'machine-stopped'));
});
test('commands for other parts of Ghost are argv arrays only', async () => {
  const r = await started();
  const out = await r.svc.runArgv(['echo', 'a b; rm -rf /']);
  assert.equal(out.code, 0); assert.equal(out.stdout, 'ok\n');
  assert.deepEqual(r.log().find((l) => l.req === 'exec').argv, ['echo', 'a b; rm -rf /']);
  await assert.rejects(async () => r.svc.agent.run({ argv: 'echo hi' }), /bad command/);
  await r.svc.kill();
});

test('network: Tor by default; direct needs a native confirmation; none refuses everything; the choice is shown in the status', async () => {
  const r = await rig({ answer: (x) => x.kind !== 'direct' });
  assert.equal(r.svc.status().route.mode, 'tor'); assert.equal(r.svc.status().route.tone, 'ok');
  const d = await r.svc.setNetwork('direct-doh'); assert.equal(d.code, 'declined'); assert.equal(r.svc.status().route.mode, 'tor');
  assert.equal((await r.svc.setNetwork('bogus')).ok, false);
  assert.equal((await r.svc.setNetwork('none')).ok, true); assert.equal(r.svc.status().route.label, 'Off'); assert.equal(r.svc.status().route.exposesIp, false);
  const yes = await rig(); assert.equal((await yes.svc.setNetwork('direct-doh')).ok, true);
  assert.equal(yes.svc.status().route.exposesIp, true); assert.equal(yes.svc.status().route.tone, 'warn'); assert.deepEqual(yes.asked, ['direct']);
  assert.equal((await yes.svc.setNetwork('tor')).ok, true);
  const down = await rig({ tor: { ready: false, state: { status: 'off' }, start: async () => {}, stop() {} } });
  assert.match(down.svc.status().route.text, /Tor not connected: requests are blocked/); assert.equal(down.svc.status().route.tone, 'bad');
});
test('network: starting on Tor starts the shared Tor program; stopping the machine lets its owner release it', async () => {
  let released = 0;
  const r = await installed({ tor: require('./ghost-vm-helpers').fakeTor('off'), svc: { releaseTor: () => { released++; } } });
  await r.svc.start({ caseId: 'case1' });
  await until(() => r.tor.started > 0); assert.equal(r.tor.started, 1);
  await r.svc.stop(); assert.ok(released >= 1); assert.equal(r.svc.status().state, 'stopped');
  assert.equal(r.tor.stopped, 0, 'a normal stop does not stop Tor itself: the owner decides');
});

test('reset: asks first; erases the machine disk and its key, keeps the shared folder and the tools disk, then starts clean', async () => {
  const r = await started();
  fs.writeFileSync(path.join(r.base, 'cases', 'case1', 'shared', 'keep.txt'), 'mine');
  const overlay = path.join(r.base, 'cases', 'case1', 'disk.qcow2'), tools = path.join(r.base, 'tools', 'disk.qcow2');
  assert.ok(fs.existsSync(overlay) && fs.existsSync(tools));
  const keysBefore = [...r.vault.m.keys()];
  assert.deepEqual(keysBefore.sort(), ['connectors/vmkey-case1', 'connectors/vmkey-tools']);
  const no = await rig({ answer: () => false }); no.svc.state = 'stopped'; assert.equal((await no.svc.reset()).code, 'declined');
  r.asked.length = 0;
  const x = await r.svc.reset(); assert.equal(x.ok, true); assert.deepEqual(r.asked.slice(0, 1), ['reset']);
  assert.equal(r.svc.status().state, 'running', 'it came back up');
  assert.equal(fs.readFileSync(path.join(r.base, 'cases', 'case1', 'shared', 'keep.txt'), 'utf8'), 'mine');
  assert.ok(fs.existsSync(tools));
  const runs = r.log().filter((l) => l.run); assert.equal(runs.length, 2);
  assert.equal(r.log().filter((l) => l.tool === 'qemu-img' && l.sub === 'create').length, 3, 'a new machine disk was made (2 first start + 1 after reset)');
  await r.svc.kill();
});
test('snapshots: take, list, restore (asks first) and delete work on the machine disk with the key; bad names are refused', async () => {
  const r = await started();
  assert.deepEqual(await r.svc.listSnapshots(), []);
  assert.equal((await r.svc.snapshot('before-install')).ok, true);
  assert.deepEqual((await r.svc.listSnapshots()).map((s) => s.name), ['before-install']);
  assert.equal(r.svc.status().state, 'running', 'the machine was stopped for the step and started again');
  assert.equal((await r.svc.snapshot('before-install')).code, 'exists');
  for (const bad of ['', 'a b', '../x', 'x'.repeat(41), 'a;b']) assert.equal((await r.svc.snapshot(bad)).ok, false, bad);
  assert.equal((await r.svc.restore('nope')).ok, false);
  r.asked.length = 0;
  assert.equal((await r.svc.restore('before-install')).ok, true); assert.equal(r.asked[0], 'restore');
  assert.ok(r.log().some((l) => l.tool === 'qemu-img' && l.sub === 'snapshot' && l.keyLen === 64), 'the key was handed to qemu-img');
  assert.equal((await r.svc.deleteSnapshot('before-install')).ok, true); assert.deepEqual(await r.svc.listSnapshots(), []);
  const no = await started({ answer: (x) => x.kind !== 'restore' }); await no.svc.snapshot('s1'); assert.equal((await no.svc.restore('s1')).code, 'declined');
  await r.svc.kill(); await no.svc.kill();
});
test('wipe tools: asks first and removes only the tools disk and its key', async () => {
  const r = await started();
  const tools = path.join(r.base, 'tools', 'disk.qcow2'); assert.ok(fs.existsSync(tools));
  const no = await started({ answer: (x) => x.kind !== 'wipe-tools' });
  assert.equal((await no.svc.wipeTools()).code, 'declined'); assert.ok(fs.existsSync(path.join(no.base, 'tools', 'disk.qcow2')));
  await no.svc.kill();
  const oldTools = r.vault.m.get('connectors/vmkey-tools'), oldCase = r.vault.m.get('connectors/vmkey-case1');
  assert.equal((await r.svc.wipeTools()).ok, true); assert.ok(r.asked.includes('wipe-tools'));
  assert.ok(fs.existsSync(path.join(r.base, 'cases', 'case1', 'disk.qcow2')));
  assert.notEqual(r.vault.m.get('connectors/vmkey-tools'), oldTools, 'the old tools key is gone: the restart made a new disk with a new key'); assert.equal(r.vault.m.get('connectors/vmkey-case1'), oldCase, 'the machine disk and its key are untouched');
  assert.equal(r.log().filter((l) => l.tool === 'qemu-img' && l.sub === 'create').length >= 3, true, 'a fresh tools disk was made on the restart');
  await r.svc.kill();
});
test('cases: each case has its own disk and shared folder; switching asks when terminals are open', async () => {
  const r = await started({});
  await r.svc.open(1, { cols: 80, rows: 24 });
  r.asked.length = 0;
  assert.equal((await r.svc.useCase('case2')).ok, true); assert.ok(r.asked.includes('switch-case'));
  assert.equal(r.svc.status().state, 'stopped'); assert.equal(r.svc.status().caseId, 'case2');
  assert.equal((await r.svc.start({})).ok, true);
  assert.equal(r.svc.status().share.dir, fs.realpathSync(path.join(r.base, 'cases', 'case2', 'shared')));
  assert.notEqual(path.join(r.base, 'cases', 'case1', 'shared'), r.svc.status().share.dir);
  assert.deepEqual(r.svc.status().cases.sort(), ['case1', 'case2']);
  const argvs = r.log().filter((l) => l.run).map((l) => l.argv.find((x) => x.startsWith('driver=file,node-name=ovf')));
  assert.ok(argvs[0].includes('case1') && argvs[1].includes('case2'));
  await r.svc.kill();
});

test('kill: immediate; ends the machine, the terminals and the sockets, drops the key files, stops Tor, and the disk stays', async () => {
  const r = await started();
  const t = await r.svc.open(3, { cols: 80, rows: 24 });
  const pid = r.svc.proc.pid;
  const k = await r.svc.kill();
  assert.equal(k.ok, true); assert.equal(k.wasRunning, true);
  assert.equal(r.svc.status().state, 'stopped'); assert.equal(r.svc.proc, null); assert.equal(r.svc.agent, null); assert.equal(r.svc.gateway, null);
  assert.equal(r.tor.stopped, 1);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  assert.ok(r.emitted.some(([, n, p]) => n === 'exit' && p.id === t.id));
  assert.equal(fs.readdirSync(r.root).filter((n) => n.startsWith('mfvm-')).length, 0);
  assert.ok(fs.existsSync(path.join(r.base, 'cases', 'case1', 'disk.qcow2')), 'the disk is kept');
  assert.equal((await r.svc.kill()).wasRunning, false, 'kill twice is safe');
  assert.equal((await r.svc.start({ caseId: 'case1' })).ok, true, 'and it can start again');
  await r.svc.shutdown();
});
test('kill during a download aborts it and keeps nothing', async () => {
  const r = await rig();
  let release; const gate = new Promise((res) => { release = res; });
  const slow = async (url, opts) => { await gate; if (opts && opts.signal && opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } return require('./ghost-vm-helpers').fakeFetch(r.files)(url, opts); };
  const s2 = await rig({ fetchImpl: slow });
  const p = s2.svc.install(); await until(() => s2.svc.status().state === 'downloading');
  await s2.svc.kill(); release();
  const x = await p; assert.equal(x.ok, false); assert.equal(x.code, 'cancelled'); assert.equal(s2.svc.status().state, 'not-installed');
});
