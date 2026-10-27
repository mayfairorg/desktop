'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CH, BR, BR_EVENTS, check, channelsFor } = require('../src/main/lib/ipc-allowlist');
const { GhostService } = require('../src/main/ghost');
const { redact } = require('../src/main/ghost/logger');
const { context, stage, tmp, until } = require('./ghost-helpers');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const GHOST_CALLS = ['connectors.list', 'connectors.get', 'connectors.validate', 'connectors.test', 'connectors.requestApproval', 'connectors.enable', 'connectors.disable', 'connectors.remove', 'connectors.installSample', 'jobs.run', 'jobs.cancel', 'jobs.list', 'jobs.get', 'logs.tail', 'pickFile'].map((x) => 'ghost.' + x);
const VAULT_CALLS = ['status', 'unlock', 'lock', 'backup.begin', 'backup.confirm', 'backup.cancel', 'backup.disable', 'backup.newPhrase', 'changePassphrase', 'resetPassphrase', 'requirePassphrase', 'rotateKeys', 'syncNow', 'wipe', 'exportFile', 'importFile'].map((x) => 'ghost.vault.' + x);   // tested in ghost-vault-service.test.js
const ok = (n, ...a) => check('web', 'br:' + n, a).ok;

// The App Library side of the Ghost app (src/main/ghost/app): list, open, remove. They go to the app service, never to the connector core.
const APP_CALLS = ['ghost.app.library', 'ghost.app.open', 'ghost.app.remove'];
test('the ghost bridge group is exactly the documented calls, Mayfair view only', () => {
  const have = Object.keys(BR).filter((k) => k.startsWith('ghost.')).sort();
  assert.deepEqual(have, [...GHOST_CALLS, ...VAULT_CALLS, ...APP_CALLS].sort());
  for (const n of [...GHOST_CALLS, ...VAULT_CALLS, ...APP_CALLS]) { assert.deepEqual(CH['br:' + n].roles, ['web'], n); for (const role of ['page', 'start']) assert.equal(check(role, 'br:' + n, []).ok, false, role + ' ' + n); }
  assert.ok(BR_EVENTS.includes('ghost-job'));
  assert.ok(channelsFor('web').includes('br:ghost.jobs.run'));
  assert.ok(!channelsFor('page').some((c) => c.includes('ghost')) && !channelsFor('start').some((c) => c.includes('ghost')));
});
test('no raw exec: no ghost call takes a command, and none can approve', () => {
  const names = Object.keys(BR).filter((k) => k.startsWith('ghost.'));
  for (const n of names) assert.ok(!/exec|spawn|command|shell|approve$|grant|sudo|eval|run[A-Z]|argv/i.test(n.replace(/^ghost\.jobs\.run$/, '')), n);
  assert.ok(!names.some((n) => /approve|grant|trust/i.test(n.replace('requestApproval', ''))));
  assert.ok(!('br:ghost.connectors.approve' in CH));
  for (const bad of ['ghost.exec', 'ghost.run', 'ghost.spawn', 'ghost.shell', 'ghost.connectors.approve', 'ghost.connectors.register', 'ghost.connectors.install', 'ghost.setConfirm']) assert.equal(check('web', 'br:' + bad, ['x']).ok, false, bad);
});
test('jobs.run accepts a connector id, input values and a scope declaration, nothing else', () => {
  assert.equal(ok('ghost.jobs.run', { connector: 'sample-textstats', input: { text: 'hello' } }), true);
  assert.equal(ok('ghost.jobs.run', { connector: 'sample-textstats' }), true);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: { n: 5, h: 'example.com' }, scope: { target: 'example.com', confirmedAuthorised: true } }), true);
  for (const extra of ['command', 'argv', 'args', 'executable', 'exe', 'cwd', 'env', 'shell', 'path', 'cmd']) assert.equal(ok('ghost.jobs.run', { connector: 'a', input: {}, [extra]: 'x' }), false, extra);
  assert.equal(ok('ghost.jobs.run'), false);
  assert.equal(ok('ghost.jobs.run', 'a'), false);
  assert.equal(ok('ghost.jobs.run', { input: {} }), false);
  assert.equal(ok('ghost.jobs.run', { connector: '../x' }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'A' }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a b' }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'sh -c ls' }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: { text: ['x'] } }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: { text: { $ne: 1 } } }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: { text: 'x'.repeat(5000) } }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: { 'bad key': 'x' } }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: { __proto__x: 'x', Cmd: 'x' } }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: 'x' }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: {}, scope: { target: 'x' } }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: {}, scope: { target: 'x', confirmedAuthorised: 'true' } }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: {}, scope: { target: 'x', confirmedAuthorised: true, extra: 1 } }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: {}, scope: true }), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a' }, 'extra'), false);
  assert.equal(ok('ghost.jobs.run', { connector: 'a', input: new Array(20).fill(0).reduce((o, _, i) => ({ ...o, ['k' + i]: 'v' }), {}) }), false);
});
test('the other ghost calls check their arguments', () => {
  for (const c of ['get', 'validate', 'requestApproval', 'enable', 'disable', 'remove']) {
    assert.equal(ok('ghost.connectors.' + c, 'sample-textstats'), true, c);
    for (const bad of [undefined, 5, '../x', 'A', '', {}, ['a'], 'a'.repeat(50)]) assert.equal(check('web', 'br:ghost.connectors.' + c, bad === undefined ? [] : [bad]).ok, false, c + ' ' + String(bad));
    assert.equal(ok('ghost.connectors.' + c, 'a', true), false, c + ' takes no extra argument');
  }
  assert.equal(ok('ghost.connectors.requestApproval', 'a', { approved: true }), false, 'the page cannot pass a decision');
  assert.equal(ok('ghost.connectors.requestApproval', 'a', true), false);
  assert.equal(ok('ghost.connectors.list'), true); assert.equal(ok('ghost.connectors.list', 1), false);
  assert.equal(ok('ghost.connectors.installSample'), true); assert.equal(ok('ghost.connectors.installSample', 'x'), false);
  assert.equal(ok('ghost.connectors.test', 'a'), true);
  assert.equal(ok('ghost.connectors.test', 'a', { target: 'x.com', confirmedAuthorised: true }), true);
  assert.equal(ok('ghost.connectors.test', 'a', { target: 'x.com' }), false);
  assert.equal(ok('ghost.jobs.cancel', 'j-abc123-ff'), true); assert.equal(ok('ghost.jobs.cancel', '../x'), false); assert.equal(ok('ghost.jobs.cancel', 5), false);
  assert.equal(ok('ghost.jobs.get', 'j-abc123-ff'), true); assert.equal(ok('ghost.jobs.get', ''), false);
  assert.equal(ok('ghost.jobs.list'), true); assert.equal(ok('ghost.jobs.list', { limit: 10, connector: 'a' }), true);
  assert.equal(ok('ghost.jobs.list', { limit: 0 }), false); assert.equal(ok('ghost.jobs.list', { limit: 1000 }), false); assert.equal(ok('ghost.jobs.list', { x: 1 }), false);
  assert.equal(ok('ghost.logs.tail', { n: 50 }), true); assert.equal(ok('ghost.logs.tail', { jobId: 'j-abc123-ff', n: 5 }), true); assert.equal(ok('ghost.logs.tail', {}), true);
  assert.equal(ok('ghost.logs.tail', { n: 0 }), false); assert.equal(ok('ghost.logs.tail', { n: 501 }), false); assert.equal(ok('ghost.logs.tail', { path: '/etc/passwd' }), false); assert.equal(ok('ghost.logs.tail'), false);
  assert.equal(ok('ghost.pickFile'), true); assert.equal(ok('ghost.pickFile', '/etc/passwd'), false);
});
test('preload and contract carry the ghost group and event', () => {
  const src = read('src/preload/web.js');
  for (const n of GHOST_CALLS) assert.ok(src.includes("'" + n + "'"), n);
  assert.ok(src.includes("'ghost-job'"));
  assert.match(src, /for \(const g of parts\.slice\(0, -1\)\)/, 'nested groups are built from the dotted name');
  const f = '/home/claude/audit/browser-bridge-contract.md';
  if (!fs.existsSync(f)) return;
  const doc = fs.readFileSync(f, 'utf8');
  assert.ok(doc.includes('v3.1'));
  assert.ok(doc.includes('`ghost-job`'));
  for (const n of GHOST_CALLS) assert.ok(doc.includes(n), 'not in the contract: ' + n);
});
test('every ghost handler is wired in the main process and goes through the service only', () => {
  const src = read('src/main/browser-service.js');
  for (const n of [...GHOST_CALLS, ...VAULT_CALLS, ...APP_CALLS]) assert.ok(src.includes(`'br:${n}': `), n);
  const lines = src.split('\n').filter((l) => l.includes("'br:ghost."));
  assert.equal(lines.length, GHOST_CALLS.length + VAULT_CALLS.length + APP_CALLS.length);
  for (const l of lines) assert.match(l, l.includes("'br:ghost.app.") ? /this\.ghostApp/ : /this\.ghost\.api\(\)\['ghost\./);
  const api = Object.keys(new GhostService({ root: tmp(), dialog: {} }).api()).sort();
  assert.deepEqual(api, [...GHOST_CALLS].sort(), 'the service exposes exactly the allowlisted calls');
});
test('static: the ghost code never uses a shell, exec, eval or inherited environments', () => {
  for (const f of walk('src/main/ghost').filter((x) => x.endsWith('.js'))) {
    const s = read(f);
    const code = s.replace(/\/\/.*$/gm, '').replace(/\butilityProcess\.fork\(/g, 'utilityProcess.start(');   // Electron's utility process (node-runner adapter), not child_process.fork
    assert.ok(!/shell\s*:\s*true/.test(code), f);
    assert.ok(!/\b(exec|execSync|execFileSync|spawnSync|fork)\s*\(/.test(code.replace(/\.exec\(/g, '')), f);
    assert.ok(!/\beval\s*\(|new Function\s*\(/.test(code), f);
    assert.ok(!/env\s*:\s*process\.env|\.\.\.process\.env/.test(code), f);
    assert.ok(!/require\('electron'\)/.test(code), f + ' stays free of Electron so it can be tested');
  }
  const proc = read('src/main/ghost/proc.js');
  assert.match(proc, /shell: false/);
  assert.equal((read('src/main/ghost/runner.js').match(/spawn\(/g) || []).length, 1, 'one spawn site for jobs');
});

test('approval cannot be granted from the page: only the native dialog decides', async () => {
  const root = tmp(); const shown = [];
  const dialog = { showMessageBox: async (...a) => { shown.push(a.at(-1)); return { response: 1 }; } };   // the user presses Cancel
  const g = new GhostService({ root, dialog, isPackaged: true });
  const api = g.api();
  api['ghost.connectors.installSample']();
  // whatever the page sends, the answer comes from the dialog
  for (const args of [['sample-textstats'], ['sample-textstats', true], ['sample-textstats', { approved: true }], ['sample-textstats', 'yes']]) {
    const r = await api['ghost.connectors.requestApproval'](...args);
    assert.deepEqual(r, { ok: false, error: 'declined' });
  }
  assert.ok(shown.length >= 1);
  assert.deepEqual(shown[0].buttons, ['Approve', 'Cancel']);
  assert.equal(shown[0].defaultId, 1, 'Cancel is the default');
  assert.ok(shown[0].detail.includes('Scope:') && shown[0].message.includes('1.0.0') && shown[0].message.includes('Text statistics'));
  assert.equal(api['ghost.connectors.list']()[0].state, 'not-approved');
  assert.deepEqual(api['ghost.connectors.enable']('sample-textstats'), { ok: false, error: 'not-approved' });
  assert.equal(api['ghost.jobs.run']({ connector: 'sample-textstats', input: { text: 'x' } }).error, 'not-approved');
  // the user presses Approve
  dialog.showMessageBox = async () => ({ response: 0 });
  assert.equal((await api['ghost.connectors.requestApproval']('sample-textstats')).ok, true);
  assert.equal(api['ghost.connectors.list']()[0].state, 'approved');
});
test('the test hook for the dialog is refused in an installed app and outside the smoke run', () => {
  const was = process.env.MF_SMOKE;
  try {
    process.env.MF_SMOKE = '1';
    assert.throws(() => new GhostService({ root: tmp(), dialog: {}, isPackaged: true }).useTestConfirm(() => true), /not available/);
    delete process.env.MF_SMOKE;
    assert.throws(() => new GhostService({ root: tmp(), dialog: {}, isPackaged: false }).useTestConfirm(() => true), /not available/);
    process.env.MF_SMOKE = '1';
    const g = new GhostService({ root: tmp(), dialog: {}, isPackaged: false });
    g.useTestConfirm(() => true);
    assert.equal(typeof g.confirmOverride, 'function');
  } finally { if (was === undefined) delete process.env.MF_SMOKE; else process.env.MF_SMOKE = was; }
  assert.ok(!read('src/main/lib/ipc-allowlist.js').includes('useTestConfirm'));
});

// ---- active scope guard ----
const ACTIVE = {
  scope: 'active', network: 'keyless-external', permissions: ['network'], externalRestrictions: 'Only systems you own or have written permission to test.',
  command: { executable: '@node', args: ['run.js', '--mode={mode}', '--text={target}'] },
  input: { fields: [{ name: 'mode', type: 'enum', values: ['echo', 'ok'] }, { name: 'target', type: 'url-host' }] },
  selfTest: { input: { mode: 'ok', target: 'self.example' }, expect: { minResults: 1 } },
};
test('active scope: every run needs {target, confirmedAuthorised:true} that matches the input', async () => {
  const c = context();
  const id = await c.ready(ACTIVE);
  const input = { mode: 'echo', target: 'Example.com' };
  const no = (scope, err) => { const r = c.runner.submit({ connector: id, input, scope }); assert.equal(r.ok, false, JSON.stringify(scope)); assert.equal(r.error, err, JSON.stringify(scope)); };
  no(undefined, 'scope-required');
  no(null, 'scope-required');
  no({}, 'scope-required');
  no({ target: 'example.com' }, 'scope-required');
  no({ target: 'example.com', confirmedAuthorised: false }, 'scope-required');
  no({ target: 'example.com', confirmedAuthorised: 'true' }, 'scope-required');
  no({ target: 'example.com', confirmedAuthorised: 1 }, 'scope-required');
  no({ target: '', confirmedAuthorised: true }, 'scope-required');
  no({ target: '  ', confirmedAuthorised: true }, 'scope-required');
  no({ target: 'example.com', confirmedAuthorised: true, extra: 1 }, 'scope-required');
  no('example.com', 'scope-required');
  no({ target: 'other.example', confirmedAuthorised: true }, 'scope-mismatch');
  assert.equal(c.runner.list().length, 0, 'no refused run created a job');
  assert.equal(fs.existsSync(path.join(c.root, 'ghost', 'audit.jsonl')), false, 'refused runs are not audit lines (they are in the log)');
  const r = c.runner.submit({ connector: id, input, scope: { target: 'example.com', confirmedAuthorised: true } });
  assert.equal(r.ok, true);
  const job = await c.runner.wait(r.jobId);
  assert.equal(job.status, 'done');
  assert.deepEqual(job.scope, { target: 'example.com', confirmedAuthorised: true });
  assert.ok(c.log.tail({ n: 100 }).some((l) => l.event === 'run-refused' && l.error === 'scope-required'));
});
test('active scope: every active run is appended to the audit log', async () => {
  const c = context();
  const id = await c.ready(ACTIVE);
  const scope = { target: 'example.com', confirmedAuthorised: true };
  const a = await c.runner.wait(c.runner.submit({ connector: id, input: { mode: 'ok', target: 'example.com' }, scope }).jobId);
  const b = await c.runner.wait(c.runner.submit({ connector: id, input: { mode: 'echo', target: 'example.com' }, scope }).jobId);
  const lines = fs.readFileSync(path.join(c.root, 'ghost', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map((l) => l.event), ['run-requested', 'run-finished', 'run-requested', 'run-finished']);
  assert.equal(lines[0].jobId, a.id); assert.equal(lines[2].jobId, b.id);
  assert.equal(lines[0].target, 'example.com'); assert.equal(lines[0].confirmedAuthorised, true);
  assert.equal(lines[0].connector, id); assert.equal(lines[0].version, '1.0.0'); assert.ok(lines[0].t > 0);
  assert.equal(lines[1].status, 'done');
});
test('active scope: if the audit line cannot be written the run does not start', async () => {
  const c = context();
  const id = await c.ready(ACTIVE);
  fs.mkdirSync(path.join(c.root, 'ghost', 'audit.jsonl'), { recursive: true });   // a folder where the file should be
  const r = c.runner.submit({ connector: id, input: { mode: 'ok', target: 'example.com' }, scope: { target: 'example.com', confirmedAuthorised: true } });
  assert.equal(r.ok, false); assert.equal(r.error, 'audit-failed');
  assert.equal(c.runner.list().length, 0);
});
test('active scope: the self-test needs the declaration too and is audited', async () => {
  const c = context();
  const id = c.manager.register(stage(ACTIVE)).id;
  await c.manager.requestApproval(id);
  const t1 = await c.manager.test(id);
  assert.equal(t1.passed, false);
  assert.match(t1.lastTest.detail, /scope declaration/);
  const t2 = await c.manager.test(id, { target: 'self.example', confirmedAuthorised: true });
  assert.equal(t2.passed, true);
  assert.ok(fs.readFileSync(path.join(c.root, 'ghost', 'audit.jsonl'), 'utf8').includes('"kind":"selftest"'));
});
test('local and passive connectors need no declaration and write no audit line', async () => {
  const c = context();
  const id = await c.ready();
  await c.runner.wait(c.runner.submit({ connector: id, input: { mode: 'ok' } }).jobId);
  assert.equal(fs.existsSync(path.join(c.root, 'ghost', 'audit.jsonl')), false);
  const p = await c.ready({ id: 'passive-one', scope: 'passive', network: 'keyless-external', permissions: ['network'], externalRestrictions: 'Public sources only.' });
  const job = await c.runner.wait(c.runner.submit({ connector: p, input: { mode: 'ok' } }).jobId);
  assert.equal(job.status, 'done');
  assert.equal(fs.existsSync(path.join(c.root, 'ghost', 'audit.jsonl')), false);
});
test('a connector whose network service is unavailable does not run', async () => {
  const c = context();
  const id = await c.ready({ network: 'unavailable' });
  assert.equal(c.runner.submit({ connector: id, input: { mode: 'ok' } }).error, 'network-unavailable');
  const t = await c.manager.test(id);
  assert.equal(t.passed, false);
  assert.match(t.lastTest.detail, /not available/);
});

// ---- the sample, end to end, through the service ----
test('sample-textstats: install, approve, test, enable, run on text and on a picked file', async () => {
  const root = tmp(); const file = path.join(tmp(), 'notes.txt'); fs.writeFileSync(file, 'alpha beta\ngamma\n\ndelta epsilon zeta');
  const dialog = { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) };
  const events = [];
  const g = new GhostService({ root, dialog, isPackaged: false, emit: (n, p) => events.push([n, p]) });   // not packaged: the app's own node is available (installed builds have the RunAsNode fuse off)
  const api = g.api();
  assert.equal(api['ghost.connectors.installSample']().ok, true);
  assert.equal((await api['ghost.connectors.requestApproval']('sample-textstats')).ok, true);
  const t = await api['ghost.connectors.test']('sample-textstats');
  assert.equal(t.passed, true, JSON.stringify(t));
  const e = api['ghost.connectors.list']()[0];
  assert.equal(e.install.installed, true); assert.equal(e.install.requirements[0].status, 'ok'); assert.equal(e.state, 'approved');
  assert.equal(api['ghost.connectors.enable']('sample-textstats').state, 'enabled');
  const r = api['ghost.jobs.run']({ connector: 'sample-textstats', input: { text: 'one two three\nfour\n' } });
  assert.equal(r.ok, true);
  const job = await g.runner.wait(r.jobId);
  const by = Object.fromEntries(job.results.map((x) => [x.entity.type, x.entity.value]));
  assert.deepEqual(by, { sha256: require('node:crypto').createHash('sha256').update('one two three\nfour\n').digest('hex'), 'byte-count': '19', 'line-count': '2', 'word-count': '4' });
  assert.ok(events.some(([n, p]) => n === 'ghost-job' && p.status === 'done'));
  // picked file: the page only sees a token, name and size
  const pick = await api['ghost.pickFile']();
  assert.deepEqual(Object.keys(pick).sort(), ['name', 'size', 'token']);
  assert.equal(pick.name, 'notes.txt'); assert.equal(pick.size, fs.statSync(file).size);
  assert.ok(!JSON.stringify(pick).includes(path.dirname(file)), 'the path stays in the main process');
  const r2 = api['ghost.jobs.run']({ connector: 'sample-textstats', input: { file: pick.token } });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  const j2 = await g.runner.wait(r2.jobId);
  assert.equal(j2.status, 'done');
  const by2 = Object.fromEntries(j2.results.map((x) => [x.entity.type, x.entity.value]));
  assert.equal(by2['byte-count'], String(fs.statSync(file).size)); assert.equal(by2['word-count'], '6'); assert.equal(by2['line-count'], '4');
  assert.equal(j2.input.file, 'notes.txt');
  // one-time token
  const again = api['ghost.jobs.run']({ connector: 'sample-textstats', input: { file: pick.token } });
  assert.equal(again.ok, false); assert.equal(again.error, 'bad-input');
  assert.equal(api['ghost.jobs.run']({ connector: 'sample-textstats', input: { file: 'f'.repeat(32) } }).error, 'bad-input', 'a made-up token is refused');
  assert.equal(api['ghost.jobs.run']({ connector: 'sample-textstats', input: { file: '/etc/passwd' } }).error, 'bad-input', 'a path is not a token');
  // text and file together, or neither: the program refuses
  const both = await g.runner.wait(api['ghost.jobs.run']({ connector: 'sample-textstats', input: {} }).jobId);
  assert.equal(both.status, 'failed'); assert.match(both.error, /exactly one of/);
  // list / get / logs through the api
  assert.ok(api['ghost.jobs.list']({}).length >= 4);
  assert.equal(api['ghost.jobs.get'](job.id).results.length, 4);
  assert.equal(api['ghost.jobs.get']('j-nothing'), null);
  assert.ok(api['ghost.logs.tail']({ jobId: job.id, n: 10 }).length >= 3);
  // tampering revokes
  fs.appendFileSync(path.join(root, 'connectors', 'sample-textstats', 'run.js'), '\n// tampered\n');
  assert.equal(api['ghost.connectors.list']()[0].state, 'not-approved');
  assert.equal(api['ghost.jobs.run']({ connector: 'sample-textstats', input: { text: 'x' } }).ok, false);
});
test('pickFile: cancelling returns null; a folder is refused', async () => {
  const d = tmp();
  let reply = { canceled: true, filePaths: [] };
  const g = new GhostService({ root: tmp(), dialog: { showOpenDialog: async () => reply } });
  assert.equal(await g.pickFile(), null);
  reply = { canceled: false, filePaths: [d] };
  assert.equal(await g.pickFile(), null);
  reply = { canceled: false, filePaths: [path.join(d, 'missing')] };
  assert.equal(await g.pickFile(), null);
});
test('pick tokens expire and the store is bounded', () => {
  const { PickStore } = require('../src/main/ghost/picks');
  let t = 0; const s = new PickStore({ ttlMs: 1000, max: 3, now: () => t });
  const a = s.add('/x/a', 1); assert.ok(s.peek(a)); t = 1500; assert.equal(s.peek(a), null);
  const ks = [1, 2, 3, 4].map((i) => s.add('/x/' + i, i)); assert.equal(s.peek(ks[0]), null); assert.ok(s.peek(ks[3]));
  assert.ok(s.take(ks[3])); assert.equal(s.take(ks[3]), null);
});
test('redact replaces every occurrence of a sensitive value', () => {
  assert.equal(redact('a SECRET b SECRET', ['SECRET']), 'a *** b ***');
  assert.equal(redact('nothing', ['', null]), 'nothing');
});
test('an installed build (RunAsNode fuse off) refuses @node connectors instead of starting the app', async () => {
  const g = new GhostService({ root: tmp(), dialog: { showMessageBox: async () => ({ response: 0 }) }, isPackaged: true });
  const api = g.api();
  api['ghost.connectors.installSample']();
  await api['ghost.connectors.requestApproval']('sample-textstats');
  const t = await api['ghost.connectors.test']('sample-textstats');
  assert.equal(t.passed, false);
  assert.match(t.lastTest.detail, /switched off/);
  api['ghost.connectors.enable']('sample-textstats');
  assert.equal(api['ghost.jobs.run']({ connector: 'sample-textstats', input: { text: 'x' } }).error, 'runtime-unavailable');
  assert.equal(api['ghost.connectors.list']()[0].install.installed, false);
});
