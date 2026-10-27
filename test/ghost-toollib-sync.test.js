'use strict';
// The tool library list and the Mayfair account, desktop half: the server-shape mapping, the keep-it-on-this-computer switch, restoring a server list through the
// installer (fetch at the pinned commit, SHA-256, approval again), the change event, and the bridge allowlist. No network and no real QEMU.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp, FakeVm, makeRepo, MIT, RUN_SH, until } = require('./ghost-vm-helpers');
const { ConnectorManager } = require('../src/main/ghost/manager');
const { JobRunner } = require('../src/main/ghost/runner');
const { GhostLog } = require('../src/main/ghost/logger');
const { ToolRuntime } = require('../src/main/ghost/vm/toolrun');
const { ToolLibrary } = require('../src/main/ghost/vm/toollib');
const { VmToolInstaller } = require('../src/main/ghost/vm/installer');
const { ToolSync, toServer, fromServer, notesText } = require('../src/main/ghost/vm/toolsync');
const { CH, BR, BR_EVENTS, check, channelsFor } = require('../src/main/lib/ipc-allowlist');

const A40 = 'a'.repeat(40), S64 = 'b'.repeat(64);
const entry = (o = {}) => ({ name: 'demo-tool', source: { type: 'github', url: 'https://github.com/acme/demo-tool', repo: 'acme/demo-tool' }, commit: A40, checksum: { algo: 'sha256', value: S64 }, version: '1.2.0', notes: ['ran on 2026-10-01: make'], addedAt: '2026-10-01T10:00:00.000Z', updatedAt: '2026-10-02T10:00:00.000Z', ...o });
const upload = (o = {}) => entry({ name: 'my-script', source: { type: 'upload', name: 'one.py' }, ...o });
const FILES = (tag = 'v1') => ({ 'README.md': '# Demo tool\n', LICENSE: MIT, Makefile: 'all:\n\techo built > built.txt\n', 'bin/run': RUN_SH(tag) });
const GH = 'https://github.com/acme/demo-tool';

function computer(repos) {
  const root = tmp('mfd-tls-'); const vm = new FakeVm(path.join(root, 'guest'), repos);
  const log = new GhostLog(path.join(root, 'ghost', 'logs')); const runtime = new ToolRuntime({ vm: () => vm });
  const manager = new ConnectorManager({ root, confirm: async () => true, log, vm: runtime });
  manager.setRunner(new JobRunner({ manager, log, ghostDir: path.join(root, 'ghost'), vm: runtime, emit: () => {} }));
  const library = new ToolLibrary({ file: path.join(root, 'ghost', 'toollib.json') });
  const inst = new VmToolInstaller({ vm, manager, library, dir: path.join(root, 'ghost', 'vm') });
  const sync = new ToolSync({ dir: path.join(root, 'ghost'), getLibrary: () => library, getInstaller: () => inst });
  return { root, vm, manager, library, inst, sync };
}

test('toServer: a GitHub tool carries its address, an upload has source_url empty, nothing else rides along', () => {
  const now = Date.parse('2026-10-27T00:00:00Z');
  const { tools } = toServer([entry({ setup: [{ label: 'x', command: 'make' }], connector: { program: 'bin/run' }, licence: 'MIT' }), upload()], now);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools[0], { tool_key: 'demo-tool', name: 'demo-tool', source_url: GH, pinned_ref: A40, checksum: S64, version: '1.2.0', notes: 'ran on 2026-10-01: make', added_at: Date.parse('2026-10-01T10:00:00.000Z') });
  assert.equal(tools[1].source_url, ''); assert.equal(tools[1].pinned_ref, A40);
  for (const t of tools) assert.deepEqual(Object.keys(t).filter((k) => !['tool_key', 'name', 'source_url', 'pinned_ref', 'checksum', 'version', 'notes', 'added_at'].includes(k)), []);
  assert.equal(toServer([entry({ addedAt: '2999-01-01T00:00:00Z' })], now).tools[0].added_at, now, 'never in the future');
  assert.equal('added_at' in toServer([entry({ addedAt: undefined })], now).tools[0], false);
  assert.equal(toServer([upload({ commit: undefined })], now).tools[0].pinned_ref, '');
});
test('notesText keeps the newest whole lines within 500 characters', () => {
  const lines = Array.from({ length: 10 }, (_, i) => String(i).repeat(100));
  const t = notesText(lines); assert.ok(t.length <= 500); assert.ok(t.endsWith('9'.repeat(100))); assert.ok(!t.includes('0'.repeat(100)));
  assert.equal(notesText([]), ''); assert.equal(notesText(undefined), ''); assert.equal(notesText(['a\u0000b']), 'a b');
});

test('fromServer: GitHub url + pinned_ref become source + commit, checksum and version come back, and incomplete tools are skipped and reported', () => {
  const good = { tool_key: 'demo-tool', name: 'Demo', source_url: GH, pinned_ref: A40, checksum: S64, version: '1.2.0', notes: 'one\ntwo', added_at: 1790000000000, updated_at: 1790000100000 };
  const r = fromServer({ tools: [
    good,
    { ...good, tool_key: 'with-prefix', checksum: 'sha256:' + S64.toUpperCase() },
    { ...good, tool_key: 'no-commit', pinned_ref: '' }, { ...good, tool_key: 'short-commit', pinned_ref: 'abc123' }, { ...good, tool_key: 'upper-commit', pinned_ref: 'A'.repeat(40) },
    { ...good, tool_key: 'no-sum', checksum: '' }, { ...good, tool_key: 'md5', checksum: 'md5:' + 'c'.repeat(32) },
    { ...good, tool_key: 'not-github', source_url: 'https://example.com/x/y' }, { ...good, tool_key: 'http-github', source_url: 'http://github.com/a/b' },
    { ...good, tool_key: 'Bad Key' }, { ...good, tool_key: 'extra', surprise: 1 },
    { tool_key: 'my-script', name: 'My script', source_url: '', pinned_ref: A40, checksum: S64 },
    { ...good, tool_key: 'demo-tool' },
  ] });
  const names = r.list.tools.map((e) => e.name); assert.deepEqual(names, ['demo-tool', 'with-prefix']);
  const e = r.list.tools[0];
  assert.deepEqual(e.source, { type: 'github', url: GH, repo: 'acme/demo-tool' }); assert.equal(e.commit, A40); assert.deepEqual(e.checksum, { algo: 'sha256', value: S64 }); assert.equal(e.version, '1.2.0');
  assert.deepEqual(e.notes, ['one', 'two']); assert.equal(e.addedAt, new Date(1790000000000).toISOString()); assert.equal(e.updatedAt, new Date(1790000100000).toISOString());
  assert.equal(r.list.tools[1].checksum.value, S64, 'a sha256: prefix is accepted');
  assert.deepEqual(r.skipped.map((s) => s.key).sort(), ['Bad Key', 'extra', 'http-github', 'md5', 'no-commit', 'no-sum', 'not-github', 'short-commit', 'upper-commit']);
  assert.match(r.skipped.find((s) => s.key === 'no-commit').reason, /pinned commit/); assert.match(r.skipped.find((s) => s.key === 'no-sum').reason, /SHA-256/);
  assert.deepEqual(r.manual, [{ key: 'my-script', name: 'My script' }], 'uploads cannot be restored: listed for adding by hand');
  assert.deepEqual(fromServer(null).list.tools, []); assert.deepEqual(fromServer({ tools: 'x' }).list.tools, []);
  assert.equal(fromServer({ tools: Array.from({ length: 500 }, (_, i) => ({ ...good, tool_key: 't' + i })) }).list.tools.length, 200, 'at most the server cap');
});
test('round trip: what the desktop sends is what it accepts back', () => {
  const back = fromServer(toServer([entry(), entry({ name: 'other', source: { type: 'github', url: 'https://github.com/acme/other', repo: 'acme/other' } })]));
  assert.equal(back.skipped.length, 0); assert.deepEqual(back.list.tools.map((e) => [e.name, e.commit, e.checksum.value, e.version]), [['demo-tool', A40, S64, '1.2.0'], ['other', A40, S64, '1.2.0']]);
});

test('the switch: sync is on by default, local-only is stored in the Ghost data folder, nothing is read out or imported while it is on', () => {
  const root = tmp('mfd-tls-'); const dir = path.join(root, 'ghost');
  const lib = new ToolLibrary({ file: path.join(dir, 'toollib.json') }); lib.put(entry());
  let installs = 0; const s = new ToolSync({ dir, getLibrary: () => lib, getInstaller: () => ({ importLibrary: () => { installs++; return { ok: true, plan: [], conflicts: [], rejected: [] }; }, importStatus: () => ({ ok: true }) }) });
  assert.deepEqual(s.localOnly(), { ok: true, localOnly: false }); assert.equal(s.list().tools.length, 1); assert.equal(s.list().localOnly, false);
  assert.deepEqual(s.setLocalOnly(true), { ok: true, localOnly: true });
  assert.ok(fs.existsSync(path.join(dir, 'toollib-sync.json'))); assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'toollib-sync.json'), 'utf8')).localOnly, true);
  assert.deepEqual(s.list(), { ok: true, localOnly: true, tools: [] });
  const r = s.import({ tools: [{ tool_key: 'demo-tool', source_url: GH, pinned_ref: A40, checksum: S64 }] }); assert.equal(r.ok, false); assert.equal(r.code, 'local-only'); assert.equal(installs, 0);
  assert.equal(new ToolSync({ dir, getLibrary: () => lib, getInstaller: () => null }).isLocalOnly(), true, 'it survives a restart');
  assert.deepEqual(s.setLocalOnly(false), { ok: true, localOnly: false }); assert.equal(s.list().tools.length, 1);
  for (const bad of ['yes', 1, null, undefined, {}]) assert.equal(s.setLocalOnly(bad).ok, false);
  fs.writeFileSync(path.join(dir, 'toollib-sync.json'), '{not json'); assert.equal(s.isLocalOnly(), false, 'unreadable means the default');
  fs.writeFileSync(path.join(dir, 'toollib-sync.json'), JSON.stringify({ v: 2, localOnly: true })); assert.equal(s.isLocalOnly(), false);
  assert.equal(fs.readFileSync(path.join(dir, 'toollib.json'), 'utf8').includes('localOnly'), false, 'the switch is not part of the list');
});

test('onChange: install, update and removal save the list and tell the listener; a failing listener does not break saving', () => {
  const root = tmp('mfd-tls-'); const lib = new ToolLibrary({ file: path.join(root, 'toollib.json') });
  let n = 0; lib.onChange(() => { n++; }); lib.onChange(() => { throw new Error('boom'); }); lib.onChange('nope');
  lib.put(entry()); assert.equal(n, 1); lib.put(entry({ commit: 'c'.repeat(40) })); assert.equal(n, 2);
  assert.equal(lib.remove('missing'), false); assert.equal(n, 2, 'nothing removed, nothing to tell');
  assert.equal(lib.remove('demo-tool'), true); assert.equal(n, 3);
  lib.import({ schema: 1, kind: 'ghost-tool-library', tools: [entry()] }); assert.equal(n, 4);
  assert.equal(new ToolLibrary({ file: path.join(root, 'toollib.json') }).list().length, 1, 'saved');
});

test('restoring: the server list goes through importLibrary, so the checksum is verified, nothing is approved, and bad entries are reported', async () => {
  const root = tmp('mfd-tlr-'); const repo = makeRepo(root, 'acme/demo-tool', FILES());
  const a = computer({ 'acme/demo-tool': repo.bare });
  const p = await a.inst.prepareGithub({ url: GH }); const k = await a.inst.commit(p.token); assert.equal(k.ok, true);
  const mine = a.sync.list(); assert.equal(mine.tools.length, 1); const t = mine.tools[0]; assert.equal(t.source_url, GH); assert.match(t.pinned_ref, /^[0-9a-f]{40}$/); assert.match(t.checksum, /^[0-9a-f]{64}$/);
  repo.add(FILES('v2'), 'later');
  const b = computer({ 'acme/demo-tool': repo.bare });
  const server = { tools: [{ ...t, updated_at: Date.now() }, { tool_key: 'my-script', name: 'my-script', source_url: '', pinned_ref: A40, checksum: S64 }, { tool_key: 'no-pin', name: 'no-pin', source_url: 'https://github.com/acme/x', pinned_ref: '', checksum: S64 }] };
  const r = b.sync.import(server); assert.equal(r.ok, true, JSON.stringify(r)); assert.deepEqual(r.plan, ['acme-demo-tool']);
  assert.deepEqual(r.manual, [{ key: 'my-script', name: 'my-script' }]); assert.deepEqual(r.skipped.map((s) => s.key), ['no-pin']);
  await until(() => b.sync.importStatus().done); const st = b.sync.importStatus(); assert.equal(st.items[0].status, 'installed', JSON.stringify(st));
  assert.equal(b.inst.list()[0].commit, t.pinned_ref); assert.equal(b.inst.list().length, 1, 'only the verifiable tool was installed');
  assert.deepEqual(b.manager.list(), [], 'a plain tool has no connector, and approval is never carried over');
  // a wrong checksum is refused and deleted again, exactly as for a file import
  const c = computer({ 'acme/demo-tool': repo.bare }); c.sync.import({ tools: [{ ...t, checksum: 'f'.repeat(64) }] }); await until(() => c.sync.importStatus().done);
  assert.equal(c.sync.importStatus().items[0].status, 'failed'); assert.deepEqual(c.inst.list(), []);
  // nothing importable: ok, nothing fetched
  const d = computer({}); const e = d.sync.import({ tools: [] }); assert.deepEqual([e.ok, e.plan], [true, []]);
});

// ---- the bridge allowlist
const ok = (n, ...a) => check('web', 'br:' + n, a).ok;
test('toollib bridge: Mayfair view only, exact argument shapes, no extra fields', () => {
  for (const n of ['list', 'import', 'importStatus', 'localOnly', 'setLocalOnly']) { assert.deepEqual(CH['br:ghost.toollib.' + n].roles, ['web'], n); for (const role of ['page', 'start']) assert.equal(check(role, 'br:ghost.toollib.' + n, []).ok, false); }
  assert.ok(channelsFor('web').includes('br:ghost.toollib.import')); assert.ok(BR_EVENTS.includes('ghost-toollib'));
  for (const n of ['list', 'importStatus', 'localOnly']) { assert.equal(ok('ghost.toollib.' + n), true, n); assert.equal(ok('ghost.toollib.' + n, 1), false, n); assert.equal(ok('ghost.toollib.' + n, {}), false, n); }
  assert.equal(ok('ghost.toollib.setLocalOnly', true), true); assert.equal(ok('ghost.toollib.setLocalOnly', false), true);
  for (const bad of ['true', 1, null, {}, undefined]) assert.equal(check('web', 'br:ghost.toollib.setLocalOnly', bad === undefined ? [] : [bad]).ok, false);
  assert.equal(ok('ghost.toollib.setLocalOnly', true, true), false);
  const tool = { tool_key: 'demo-tool', name: 'Demo', source_url: GH, pinned_ref: A40, checksum: S64, version: '1', notes: 'n', added_at: 1790000000000, updated_at: 1790000000000 };
  assert.equal(ok('ghost.toollib.import', { tools: [tool] }), true); assert.equal(ok('ghost.toollib.import', { tools: [] }), true); assert.equal(ok('ghost.toollib.import', { tools: [{ tool_key: 'x' }] }), true);
  const no = (v) => assert.equal(ok('ghost.toollib.import', v), false, String(JSON.stringify(v)).slice(0, 80));
  no(); no(null); no([]); no('x'); no({}); no({ tools: 'x' }); no({ tools: [], replace: true }); no({ tools: [tool], extra: 1 });
  no({ tools: [{ ...tool, path: '/etc' }] }); no({ tools: [{ ...tool, command: 'sh' }] }); no({ tools: [{ ...tool, tool_key: '' }] }); no({ tools: [{ ...tool, tool_key: 'a'.repeat(65) }] });
  no({ tools: [{ ...tool, notes: 'n'.repeat(501) }] }); no({ tools: [{ ...tool, source_url: 5 }] }); no({ tools: [{ ...tool, added_at: 1.5 }] }); no({ tools: [{ ...tool, added_at: '1' }] }); no({ tools: [{ ...tool, added_at: -1 }] });
  no({ tools: ['demo'] }); no({ tools: [null] }); no({ tools: Array.from({ length: 201 }, () => tool) });
  assert.equal(ok('ghost.toollib.import', { tools: Array.from({ length: 200 }, () => tool) }), true);
  assert.equal(ok('ghost.toollib.import', { tools: [tool] }, 'extra'), false);
});
test('toollib bridge: preload names and events equal the allowlist, and main wires the change event', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'web.js'), 'utf8');
  for (const n of Object.keys(BR).filter((k) => k.startsWith('ghost.toollib.'))) assert.ok(pre.includes("'" + n + "'"), n);
  assert.ok(pre.includes("'ghost-toollib'"));
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /br\.emit\('ghost-toollib'/); assert.match(main, /br\.ghostToolLib = toolSync\(\)/);
  const bs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'browser-service.js'), 'utf8');
  for (const n of Object.keys(BR).filter((k) => k.startsWith('ghost.toollib.'))) assert.ok(bs.includes("'br:" + n + "'"), 'handler for ' + n);
});
