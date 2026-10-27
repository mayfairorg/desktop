'use strict';
// "Add tool": folder, zip, single script, GitHub (mocked). Importing never runs anything; approval, hashing, removal go through the existing connector manager.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tmp, makeZip, manifest, toolFiles, writeFolder, waitFor } = require('./ghost-terminal-helpers');
const { ToolHost, manifestFromForm, LIMITS } = require('../src/main/ghost/terminal/addtool');
const T = require('../src/main/ghost/terminal/tools');

function rig({ pickPath = null, answers = [true], fetchImpl } = {}) {
  const userData = tmp(), toolsDir = path.join(userData, 'ghost', 'tools'); const asked = [];
  const r = { userData, toolsDir, asked, pickPath };
  r.host = new ToolHost({ userData, toolsDir, isPackaged: false, fetchImpl, confirm: async (o) => { asked.push(o); return answers.length ? answers.shift() : false; }, pick: async () => r.pickPath });
  return r;
}
const zipTo = (entries) => { const p = path.join(tmp(), 't.zip'); fs.writeFileSync(p, makeZip(entries)); return p; };
async function addZip(r, entries) { r.pickPath = zipTo(entries); const p = await r.host.prepareZip(); return p; }

test('a good zip: previewed as data (manifest, README, licence), nothing runs, nothing lands until the person adds it, and it starts unapproved and untested', async () => {
  const r = rig(); const marker = path.join(r.userData, 'ran');
  const files = toolFiles(); files.push({ name: 'setup.py', data: `open(${JSON.stringify(marker)},'w')` }, { name: 'package.json', data: '{"scripts":{"postinstall":"touch x"}}' });
  const p = await addZip(r, files);
  assert.equal(p.ok, true); assert.equal(p.valid, true, JSON.stringify(p.errors));
  assert.equal(p.manifest.id, 'echo-tool'); assert.match(p.readme.text, /Echo/); assert.match(p.licenceFile.text, /MIT/);
  assert.ok(p.warnings.some((w) => /setup\.py.*never runs/i.test(w)) && p.warnings.some((w) => /install scripts/i.test(w)));
  assert.equal(fs.existsSync(path.join(r.toolsDir, 'echo-tool')), false, 'staged only');
  assert.equal(fs.existsSync(marker), false);
  const c = r.host.commit(p.token);
  assert.deepEqual(c, { ok: true, id: 'echo-tool' });
  const l = r.host.list()[0];
  assert.equal(l.state, 'not-approved'); assert.equal(l.status, 'Not tested'); assert.equal(l.install.installed, false);
  assert.equal(r.asked.length, 0, 'no dialog yet');
  assert.equal(fs.existsSync(marker), false, 'no install script ran');
  assert.equal(fs.existsSync(path.join(r.userData, 'ghost', 'term', 'stage', p.token)), false, 'staging is cleaned up');
});
test('running needs the native approval first; the self-test sets an honest status; a failing tool says failed', async () => {
  const r = rig({ answers: [true, true] });
  const p = await addZip(r, toolFiles()); r.host.commit(p.token);
  let j = r.host.run({ id: 'echo-tool', input: { text: 'hi' } });
  assert.equal(j.ok, false, 'not approved: refused');
  assert.equal((await r.host.test('echo-tool')).ok, false);
  const a = await r.host.approve('echo-tool');
  assert.equal(a.ok, true); assert.equal(r.asked.length, 1); assert.equal(r.asked[0].kind, 'approve'); assert.match(r.asked[0].detail, /MIT/);
  assert.equal(r.host.run({ id: 'echo-tool', input: { text: 'hi' } }).ok, false, 'approved but not enabled');
  const t = await r.host.test('echo-tool'); assert.equal(t.passed, true);
  assert.equal(r.host.list()[0].status, 'Test passed');
  assert.equal(r.host.enable('echo-tool').ok, true);
  const run = r.host.run({ id: 'echo-tool', input: { text: 'hello world; touch /tmp/pwned' } });
  assert.equal(run.ok, true);
  const job = await r.host.runner.wait(run.jobId);
  assert.equal(job.status, 'done'); assert.equal(job.results[0].entity.value, 'hello world; touch /tmp/pwned', 'input is one argument, never a shell string');
  // a tool whose self-test cannot pass
  const bad = await addZip(r, toolFiles({ id: 'bad-tool', selfTest: { input: { text: 'x' }, expect: { contains: [{ type: 'echo', value: 'nope' }] } } }));
  r.host.commit(bad.token); await r.host.approve('bad-tool');
  const bt = await r.host.test('bad-tool'); assert.equal(bt.passed, false);
  assert.equal(r.host.list().find((x) => x.id === 'bad-tool').status, 'Test failed');
});
test('declining the approval leaves the tool unapproved', async () => {
  const r = rig({ answers: [false] });
  const p = await addZip(r, toolFiles()); r.host.commit(p.token);
  const a = await r.host.approve('echo-tool'); assert.equal(a.ok, false); assert.equal(r.host.list()[0].state, 'not-approved');
});
test('zip with a bad manifest: shown with its errors, cannot be added', async () => {
  const r = rig();
  const bad = [{ name: 'connector.json', data: JSON.stringify({ ...manifest(), scope: 'everything', surprise: 1 }) }, { name: 'run.js', data: 'x' }];
  const p = await addZip(r, bad);
  assert.equal(p.ok, true); assert.equal(p.valid, false); assert.ok(p.errors.length >= 1); assert.equal(p.manifest, null);
  assert.equal(r.host.commit(p.token).ok, false); assert.equal(fs.existsSync(path.join(r.toolsDir, 'echo-tool')), false);
  const notJson = await addZip(r, [{ name: 'connector.json', data: '{nope' }]); assert.equal(notJson.valid, false); assert.match(notJson.errors[0], /not valid JSON/);
  const none = await addZip(r, [{ name: 'readme.txt', data: 'hi' }]); assert.equal(none.valid, false); assert.match(none.errors[0], /connector\.json is missing/);
  const missingExe = await addZip(r, [{ name: 'connector.json', data: JSON.stringify(manifest()) }]); assert.equal(missingExe.valid, false); assert.ok(missingExe.errors.some((e) => /run\.js/.test(e)));
  const dup = await addZip(r, toolFiles()); r.host.commit(dup.token);
  const again = await addZip(r, toolFiles()); assert.equal(again.valid, false); assert.ok(again.errors.some((e) => /already installed/.test(e)));
});
test('zip with path traversal, absolute paths, drive letters, backslashes: refused, nothing written outside staging', async () => {
  const r = rig(); const outside = path.join(r.userData, 'ghost', 'term', 'evil.txt');
  for (const name of ['../evil.txt', '../../evil.txt', '/etc/evil.txt', 'C:/evil.txt', 'a\\..\\..\\evil.txt', 'ok/../../evil.txt', 'a/b:stream']) {
    const res = await addZip(r, [...toolFiles(), { name, data: 'pwn' }]);
    assert.equal(res.ok, false, name); assert.equal(res.error, 'import-failed');
    assert.ok(!fs.existsSync(outside) && !fs.existsSync(path.join(r.userData, 'evil.txt')), name);
  }
  assert.equal(fs.existsSync(r.toolsDir) ? fs.readdirSync(r.toolsDir).length : 0, 0);
  assert.equal(r.host.stages.size, 0, 'failed imports leave no staging');
});
test('oversized archives, too many files, and zip bombs are refused', async () => {
  const r = rig();
  const big = path.join(tmp(), 'big.zip'); fs.writeFileSync(big, crypto.randomBytes(LIMITS.archive + 10)); r.pickPath = big;
  let p = await r.host.prepareZip(); assert.equal(p.ok, false); assert.match(p.errors[0], /too large/);
  const bomb = makeZip([{ name: 'connector.json', data: JSON.stringify(manifest()) }, { name: 'zeros.bin', data: Buffer.alloc(LIMITS.single + 1024, 0), deflate: true }]);
  assert.ok(bomb.length < 100000, 'compresses to almost nothing');
  r.pickPath = path.join(tmp(), 'b.zip'); fs.writeFileSync(r.pickPath, bomb); p = await r.host.prepareZip(); assert.equal(p.ok, false); assert.match(p.errors[0], /too large/);
  const many = makeZip(Array.from({ length: LIMITS.files + 5 }, (_, i) => ({ name: 'f' + i, data: 'x' })));
  r.pickPath = path.join(tmp(), 'm.zip'); fs.writeFileSync(r.pickPath, many); p = await r.host.prepareZip(); assert.equal(p.ok, false); assert.match(p.errors[0], /too many/);
  r.pickPath = path.join(tmp(), 'notzip.zip'); fs.writeFileSync(r.pickPath, 'hello'); p = await r.host.prepareZip(); assert.equal(p.ok, false); assert.match(p.errors[0], /Not a zip/);
});
test('a folder: copied as data; links and oversize folders refused', { skip: process.platform === 'win32' }, async () => {
  const r = rig(); const src = writeFolder(tmp(), toolFiles()); r.pickPath = src;
  let p = await r.host.prepareFolder(); assert.equal(p.valid, true); assert.equal(r.host.commit(p.token).ok, true);
  const r2 = rig(); const src2 = writeFolder(tmp(), toolFiles()); fs.symlinkSync('/etc/passwd', path.join(src2, 'link')); r2.pickPath = src2;
  p = await r2.host.prepareFolder(); assert.equal(p.ok, false); assert.match(p.errors[0], /links are not allowed/);
  const r3 = rig(); const src3 = writeFolder(tmp(), toolFiles()); for (let i = 0; i < LIMITS.files + 1; i++) fs.writeFileSync(path.join(src3, 'f' + i), ''); r3.pickPath = src3;
  p = await r3.host.prepareFolder(); assert.equal(p.ok, false); assert.match(p.errors[0], /too large/);
  r3.pickPath = null; assert.equal((await r3.host.prepareFolder()).error, 'cancelled');
});
test('changed hash: any file change revokes approval, the status says so, and a re-approval is needed', async () => {
  const r = rig({ answers: [true, true, true, true, true] });
  const files = toolFiles(); files.push({ name: 'data/extra.txt', data: 'v1' });        // a file the manifest does not name
  const p = await addZip(r, files); r.host.commit(p.token);
  await r.host.approve('echo-tool'); await r.host.test('echo-tool'); r.host.enable('echo-tool');
  assert.equal(r.host.list()[0].state, 'enabled');
  fs.writeFileSync(path.join(r.toolsDir, 'echo-tool', 'data', 'extra.txt'), 'v2');
  let l = r.host.list()[0];
  assert.equal(l.state, 'not-approved'); assert.equal(l.health, 'changed'); assert.match(l.status, /changed/i);
  assert.equal(r.host.run({ id: 'echo-tool', input: { text: 'x' } }).ok, false);
  await r.host.approve('echo-tool'); r.host.enable('echo-tool');
  assert.equal(r.host.run({ id: 'echo-tool', input: { text: 'x' } }).ok, true);
  fs.appendFileSync(path.join(r.toolsDir, 'echo-tool', 'run.js'), '\n// edited');     // the program itself (the manager's own hash)
  assert.equal(r.host.run({ id: 'echo-tool', input: { text: 'x' } }).ok, false);
  fs.writeFileSync(path.join(r.toolsDir, 'echo-tool', 'new-file.txt'), 'added');
  l = r.host.list()[0]; assert.equal(l.state, 'not-approved');
  // a file added after approval is caught too
  await r.host.approve('echo-tool'); assert.equal(r.host.list()[0].state, 'approved');
  fs.writeFileSync(path.join(r.toolsDir, 'echo-tool', 'another.txt'), 'late');
  assert.equal(r.host.list()[0].state, 'not-approved');
});
test('removal is independent and clean: only that tool goes, its approval record goes, others keep working; declining keeps it', async () => {
  const r = rig({ answers: [true, true, false, true] });
  for (const id of ['tool-a', 'tool-b']) { const p = await addZip(r, toolFiles({ id, name: id })); r.host.commit(p.token); await r.host.approve(id); }
  assert.equal((await r.host.remove('tool-a')).error, 'declined');
  assert.ok(fs.existsSync(path.join(r.toolsDir, 'tool-a')));
  assert.equal((await r.host.remove('tool-a')).ok, true);
  assert.ok(!fs.existsSync(path.join(r.toolsDir, 'tool-a'))); assert.ok(fs.existsSync(path.join(r.toolsDir, 'tool-b')));
  assert.deepEqual(r.host.list().map((x) => [x.id, x.state]), [['tool-b', 'approved']]);
  const st = JSON.parse(fs.readFileSync(path.join(r.userData, 'ghost', 'term', 'ghost', 'state.json'), 'utf8'));
  assert.deepEqual(Object.keys(st.connectors), ['tool-b']);
  assert.ok(!('tool-a' in JSON.parse(fs.readFileSync(path.join(r.userData, 'ghost', 'term', 'ghost', 'tool-trees.json'), 'utf8')).trees));
  assert.equal((await r.host.remove('nope-x')).ok, false);
  // re-adding after removal starts from scratch
  const p = await addZip(r, toolFiles({ id: 'tool-a', name: 'tool-a' })); r.host.commit(p.token); assert.equal(r.host.list().find((x) => x.id === 'tool-a').state, 'not-approved');
});
test('added tools are never on PATH and their state is not shared with the Cloud-side connectors', async () => {
  const r = rig(); const p = await addZip(r, [...toolFiles(), { name: 'bin/helper', data: '#!/bin/sh\n' }]); r.host.commit(p.token);
  assert.ok(!T.toolDirs(r.toolsDir).some((d) => d.includes('echo-tool')));
  assert.ok(!r.host.manager.stateFile.startsWith(path.join(r.userData, 'ghost', 'state.json')) && r.host.manager.stateFile.includes(path.join('ghost', 'term')));
  assert.equal(path.dirname(path.join(r.userData, 'connectors')) !== r.toolsDir, true);
});

// ---- single script + form ----
test('one script and a form: the manifest is generated and validated; plain-text output is not accepted as results', { skip: process.platform === 'win32' }, async () => {
  const r = rig({ answers: [true] });
  const script = path.join(tmp(), 'my tool!.js'); fs.writeFileSync(script, RUN());
  r.pickPath = script;
  const form = { name: 'My checker', description: 'Echoes text', runtime: 'node', scope: 'local', network: 'local', licence: 'MIT', inputLabel: 'Text', args: ['--text={text}'], selfTestInput: 'ping' };
  const p = await r.host.prepareScript(form);
  assert.equal(p.valid, true, JSON.stringify(p.errors)); assert.equal(p.generated, true);
  assert.equal(p.manifest.id, 'my-checker'); assert.deepEqual(p.manifest.command, { executable: '@node', args: ['run/my_tool_.js', '--text={text}'] });
  assert.equal(r.host.commit(p.token).ok, true);
  await r.host.approve('my-checker'); const t = await r.host.test('my-checker'); assert.equal(t.passed, true, JSON.stringify(t));
  // bad forms are refused before a file is even asked for
  r.pickPath = script;
  for (const bad of [{ ...form, name: '!!!' }, { ...form, licence: 'not valid!' }, { ...form, scope: 'active' }, { ...form, args: Array(20).fill('a') }, { ...form, args: ['{unknown}'] }]) {
    const res = await r.host.prepareScript(bad);
    assert.ok(res.ok === false || res.valid === false, JSON.stringify(bad.args));
  }
  // a program that prints plain text fails its own self-test: nothing is invented
  const r2 = rig({ answers: [true] }); const plain = path.join(tmp(), 'plain.js'); fs.writeFileSync(plain, "console.log('just text')"); r2.pickPath = plain;
  const p2 = await r2.host.prepareScript(form); r2.host.commit(p2.token); await r2.host.approve('my-checker');
  assert.equal((await r2.host.test('my-checker')).passed, false);
  assert.equal(r2.host.list()[0].status, 'Test failed');
  assert.throws(() => manifestFromForm({ name: 'bin', licence: 'MIT' }, 'x'), /name/);
});
const RUN = () => require('./ghost-terminal-helpers').RUN_JS;

// ---- GitHub, mocked ----
function ghMock({ sha = 'a'.repeat(40), zip, redirectHost = 'codeload.github.com', status = {} } = {}) {
  const calls = [];
  const res = (code, body, headers = {}) => ({ status: code, ok: code >= 200 && code < 300, headers: { get: (k) => headers[k.toLowerCase()] || null }, arrayBuffer: async () => { const b = Buffer.isBuffer(body) ? body : Buffer.from(body); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); } });
  const f = async (url, opts) => {
    calls.push({ url, opts });
    const u = new URL(url);
    if (status[u.pathname]) return res(status[u.pathname], '');
    if (u.hostname === 'api.github.com' && /\/commits\//.test(u.pathname)) return res(200, JSON.stringify({ sha }));
    if (u.hostname === 'api.github.com' && /\/zipball\//.test(u.pathname)) return res(302, '', { location: 'https://' + redirectHost + '/legacy.zip/' + sha });
    if (u.hostname === 'codeload.github.com') return res(200, zip);
    return res(404, '');
  };
  f.calls = calls; return f;
}
const ghZip = (over) => makeZip(toolFiles(over).map((e) => ({ name: 'owner-repo-' + 'a'.repeat(7) + '/' + e.name, data: e.data })));

test('GitHub: the commit is resolved and pinned, the exact archive is fetched from GitHub hosts only, and the pin is shown and stored with the tool', async () => {
  const f = ghMock({ zip: ghZip() }); const r = rig({ fetchImpl: f });
  const p = await r.host.prepareGithub({ url: 'https://github.com/owner/repo.git', ref: 'v1.2.0' });
  assert.equal(p.valid, true, JSON.stringify(p.errors));
  assert.deepEqual([p.source.repo, p.source.commit, p.source.requestedRef], ['owner/repo', 'a'.repeat(40), 'v1.2.0']);
  assert.match(p.source.archiveSha256, /^[0-9a-f]{64}$/);
  assert.match(f.calls[0].url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\/commits\/v1\.2\.0$/);
  assert.match(f.calls[1].url, /zipball\/a{40}$/);                                  // the commit, not the moving ref
  assert.ok(f.calls.every((c) => ['api.github.com', 'codeload.github.com'].includes(new URL(c.url).hostname)));
  assert.ok(f.calls.every((c) => !c.opts.headers.authorization && !c.opts.headers.cookie), 'no credentials');
  assert.match(p.readme.text, /Echo/); assert.equal(p.manifest.id, 'echo-tool');
  assert.equal(fs.existsSync(path.join(r.toolsDir, 'echo-tool')), false);
  r.host.commit(p.token);
  const l = r.host.list()[0]; assert.deepEqual(l.source, { type: 'github', repo: 'owner/repo', commit: 'a'.repeat(40) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.toolsDir, 'echo-tool', 'ghost-source.json'), 'utf8')).commit, 'a'.repeat(40));
});
test('GitHub: tree URL gives the ref, bad URLs and refs are refused without any request, other hosts and redirects are refused', async () => {
  const f = ghMock({ zip: ghZip() }); const r = rig({ fetchImpl: f });
  assert.deepEqual(ToolHost.parseRepo('https://github.com/o/r/tree/main'), { owner: 'o', repo: 'r', ref: 'main' });
  assert.deepEqual(ToolHost.parseRepo('https://github.com/o/r', 'abc123'), { owner: 'o', repo: 'r', ref: 'abc123' });
  for (const u of ['http://github.com/o/r', 'https://evil.example/o/r', 'https://github.com.evil.example/o/r', 'https://github.com/o', 'git@github.com:o/r.git', 'https://github.com/o/r/../../x', 'file:///etc/passwd', '']) assert.equal(ToolHost.parseRepo(u), null, u);
  assert.equal(ToolHost.parseRepo('https://github.com/o/r', '--upload-pack=x'), null); assert.equal(ToolHost.parseRepo('https://github.com/o/r', 'a..b'), null);
  assert.equal((await r.host.prepareGithub({ url: 'https://evil.example/o/r' })).error, 'bad-url');
  assert.equal(f.calls.length, 0);
  const evil = rig({ fetchImpl: ghMock({ zip: ghZip(), redirectHost: 'evil.example' }) });
  const p = await evil.host.prepareGithub({ url: 'https://github.com/o/r' }); assert.equal(p.ok, false); assert.match(p.errors[0], /not a GitHub download host/);
  const nf = rig({ fetchImpl: ghMock({ zip: ghZip(), status: { '/repos/o/r/commits/HEAD': 404 } }) });
  const q = await nf.host.prepareGithub({ url: 'https://github.com/o/r' }); assert.equal(q.ok, false); assert.match(q.errors[0], /404/);
  const badSha = rig({ fetchImpl: ghMock({ sha: 'not-a-sha', zip: ghZip() }) }); assert.equal((await badSha.host.prepareGithub({ url: 'https://github.com/o/r' })).ok, false);
});
test('GitHub: a repository archive with traversal, an oversize download, or no manifest is refused or shown as not a tool', async () => {
  const trav = rig({ fetchImpl: ghMock({ zip: makeZip([{ name: 'o-r-aaaaaaa/connector.json', data: '{}' }, { name: 'o-r-aaaaaaa/../../evil', data: 'x' }]) }) });
  const a = await trav.host.prepareGithub({ url: 'https://github.com/o/r' }); assert.equal(a.ok, false);
  const none = rig({ fetchImpl: ghMock({ zip: makeZip([{ name: 'o-r-aaaaaaa/README.md', data: '# Just a repo' }, { name: 'o-r-aaaaaaa/LICENSE', data: 'Apache' }]) }) });
  const b = await none.host.prepareGithub({ url: 'https://github.com/o/r' }); assert.equal(b.valid, false); assert.match(b.errors[0], /not a Ghost tool/); assert.match(b.readme.text, /Just a repo/); assert.equal(none.host.commit(b.token).ok, false);
  const big = ghMock({ zip: ghZip() }); const orig = big; const huge = async (u, o) => { const x = await orig(u, o); if (new URL(u).hostname === 'codeload.github.com') x.headers = { get: (k) => (k === 'content-length' ? String(LIMITS.archive + 1) : null) }; return x; };
  const c = rig({ fetchImpl: huge }); const d = await c.host.prepareGithub({ url: 'https://github.com/o/r' }); assert.equal(d.ok, false); assert.match(d.errors[0], /too large/);
});
test('staging expires, is cleared at start, and cancel removes it', async () => {
  const r = rig(); const p = await addZip(r, toolFiles());
  const dir = path.join(r.userData, 'ghost', 'term', 'stage', p.token); assert.ok(fs.existsSync(dir));
  r.host.cancel(p.token); assert.ok(!fs.existsSync(dir)); assert.equal(r.host.commit(p.token).error, 'expired');
  const q = await addZip(r, toolFiles()); const d2 = path.join(r.userData, 'ghost', 'term', 'stage', q.token);
  const later = new ToolHost({ userData: r.userData, toolsDir: r.toolsDir, confirm: async () => false }); assert.ok(!fs.existsSync(d2), 'a new session starts clean'); later.shutdown();
});
test('no tool for finding one person\'s accounts is shipped: nothing under the terminal code or UI names one', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = [...walk(path.join(__dirname, '..', 'src', 'main', 'ghost', 'terminal')), ...walk(path.join(__dirname, '..', 'src', 'ui', 'ghost-terminal'))];
  const re = new RegExp(['sher' + 'lock', 'mai' + 'gret', 'black' + 'bird', 'hol' + 'ehe', 'whatsmy' + 'name', 'user' + 'name.?lookup', 'email.?(account|registration)'].join('|'), 'i');
  for (const f of files) assert.ok(!re.test(fs.readFileSync(f, 'utf8')), f);
  assert.ok(files.every((f) => !/samples?[\\/]/.test(f)), 'no sample connectors added');
});
