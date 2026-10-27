'use strict';
// The vault wired into Ghost: sealed state, log and audit; migration of old plain files; the bridge allowlist; the UI files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check } = require('../src/main/lib/ipc-allowlist');
const { GhostService } = require('../src/main/ghost');
const { VaultService } = require('../src/main/ghost/vault/service');
const { SecureIO } = require('../src/main/ghost/vault/securefs');
const { GhostLog } = require('../src/main/ghost/logger');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-vsvc-'));
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const fakeOS = () => ({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('OS:' + Buffer.from(s).toString('hex')), decryptString: (b) => Buffer.from(b.toString().slice(3), 'hex').toString() });
const FAST = { kdfParams: { m: 64, t: 1, p: 1 }, allowWeakKdf: true, syncDebounceMs: 5 };
const root = path.join(__dirname, '..');
const ok = (n, ...a) => check('web', 'br:' + n, a).ok;

test('SecureIO: log chunks, rotation by size, tail through GhostLog, ciphertext on disk', () => {
  const r = tmp(), s = new VaultService({ root: r, safeStorage: fakeOS(), vaultOptions: FAST });
  const log = new GhostLog(path.join(r, 'ghost', 'logs'), { io: s.io.logs, maxBytes: 20000, keep: 2 });
  for (let i = 0; i < 400; i++) log.info('event', { jobId: i % 2 ? 'odd-job' : 'even-job', note: 'LOG-MARKER-' + i, secret: 'x'.repeat(50) });
  const t = log.tail({ n: 500 }); assert.ok(t.length > 10 && t.length < 400, 'old chunks dropped');
  assert.equal(t[t.length - 1].note, 'LOG-MARKER-399'); assert.ok(log.tail({ jobId: 'odd-job', n: 50 }).every((x) => x.jobId === 'odd-job'));
  for (const f of walk(r)) assert.equal(fs.readFileSync(f).includes(Buffer.from('LOG-MARKER')), false, f);
  assert.equal(fs.existsSync(path.join(r, 'ghost', 'logs')), false, 'no plain log folder');
});
test('GhostService with the vault: connector state, jobs, audit and log are sealed; nothing plain is created', async () => {
  const r = tmp(), g = new GhostService({ root: r, dialog: {}, isPackaged: true, useVault: true, safeStorage: fakeOS(), vaultOptions: FAST });
  g.manager.audit({ kind: 'run', connector: 'AUDIT-MARKER', scope: 'x' }); g.log.info('hello', { v: 'LOG-MARKER' });
  g.manager.state.connectors['STATE-MARKER'] = { approval: null, enabled: false, disabled: false, lastTest: null, req: null, changed: null }; g.manager._save();
  const files = walk(path.join(r, 'ghost')); assert.ok(files.length > 0);
  for (const f of files) { const b = fs.readFileSync(f); for (const m of ['AUDIT-MARKER', 'LOG-MARKER', 'STATE-MARKER']) assert.equal(b.includes(Buffer.from(m)), false, m + ' in ' + f); }
  for (const n of ['state.json', 'audit.jsonl', 'jobs.json']) assert.equal(fs.existsSync(path.join(r, 'ghost', n)), false, n);
  const g2 = new GhostService({ root: r, dialog: {}, isPackaged: true, useVault: true, safeStorage: fakeOS(), vaultOptions: FAST });
  assert.ok('STATE-MARKER' in g2.manager.state.connectors, 'state survives a restart'); assert.equal(g2.log.tail({}).some((x) => x.event === 'hello'), true);
  const api = Object.keys(g.api()); assert.ok(api.includes('ghost.vault.status') && api.includes('ghost.connectors.list'));
});
test('plain files from an older build are moved into the vault and overwritten', () => {
  const r = tmp(), gd = path.join(r, 'ghost'); fs.mkdirSync(path.join(gd, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'state.json'), JSON.stringify({ v: 1, connectors: { 'old-conn': { approval: null, enabled: false, disabled: false, lastTest: null, req: null, changed: null } } }));
  fs.writeFileSync(path.join(gd, 'audit.jsonl'), JSON.stringify({ t: 1, kind: 'run', connector: 'OLD-AUDIT' }) + '\n');
  fs.writeFileSync(path.join(gd, 'logs', 'ghost.log'), JSON.stringify({ t: 1, level: 'info', event: 'old-event' }) + '\n');
  const g = new GhostService({ root: r, dialog: {}, isPackaged: true, useVault: true, safeStorage: fakeOS(), vaultOptions: FAST });
  assert.ok('old-conn' in g.manager.state.connectors); assert.equal(g.log.tail({}).some((x) => x.event === 'old-event'), true);
  for (const f of walk(gd)) assert.equal(fs.readFileSync(f).includes(Buffer.from('OLD-AUDIT')), false);
  assert.equal(fs.existsSync(path.join(gd, 'state.json')), false); assert.equal(fs.existsSync(path.join(gd, 'audit.jsonl')), false);
});
test('a locked vault: state is empty (nothing approved), writes are refused, unlocking reloads', async () => {
  const r = tmp(), mkS = () => new GhostService({ root: r, dialog: {}, isPackaged: true, useVault: true, safeStorage: fakeOS(), vaultOptions: FAST });
  const a = mkS(), api = a.api();
  const pass = 'long enough passphrase';
  const b = await api['ghost.vault.backup.begin']({ passphrase: pass }); assert.equal(b.ok, true);
  assert.equal((await api['ghost.vault.backup.confirm']({ answers: Object.fromEntries(b.challenge.map((n) => [n, b.phrase[n - 1]])) })).ok, true);
  a.manager.state.connectors['kept'] = { approval: null, enabled: false, disabled: false, lastTest: null, req: null, changed: null }; a.manager._save();
  assert.equal((await api['ghost.vault.requirePassphrase'](true)).ok, true); a.shutdown();
  const c = mkS(), capi = c.api();
  assert.equal(capi['ghost.vault.status']().state, 'locked'); assert.equal('kept' in c.manager.state.connectors, false);
  assert.equal(c.manager.audit({ kind: 'run' }), false, 'an active run cannot start without an audit line');
  const bad = await capi['ghost.vault.unlock']({ passphrase: 'wrong wrong wrong' }); assert.equal(bad.ok, false); assert.equal(bad.code, 'wrong-secret');
  assert.equal((await capi['ghost.vault.unlock']({ passphrase: pass })).ok, true); assert.ok('kept' in c.manager.state.connectors, 'state reloaded after unlock');
  assert.equal(capi['ghost.vault.status']().state, 'unlocked');
});
test('errors reach the page as plain messages, never stack traces or paths', async () => {
  const s = new VaultService({ root: tmp(), safeStorage: fakeOS(), vaultOptions: FAST }), api = s.api();
  const r = await api['ghost.vault.backup.begin']({ passphrase: 'short' }); assert.equal(r.ok, false); assert.match(r.error, /at least 10/); assert.equal(JSON.stringify(r).includes(os.tmpdir()), false);
  const w = await api['ghost.vault.wipe']({ confirm: 'WIPE' }); assert.equal(w.ok, true); assert.equal(w.status.state, 'uninitialised');
  assert.equal(api['ghost.vault.status']().state, 'uninitialised');
});
test('export and import through native dialogs (the page never sees a path)', async () => {
  const dir = tmp(), saved = path.join(dir, 'out.mfvb');
  const dialog = { showSaveDialog: async () => ({ canceled: false, filePath: saved }), showOpenDialog: async () => ({ canceled: false, filePaths: [saved] }) };
  const a = new VaultService({ root: tmp(), safeStorage: fakeOS(), dialog, vaultOptions: FAST }), api = a.api();
  a.vault.putJSON('cases', 'c', { t: 'dialog' });
  const b = await api['ghost.vault.backup.begin']({ passphrase: 'long enough passphrase' });
  await api['ghost.vault.backup.confirm']({ answers: Object.fromEntries(b.challenge.map((n) => [n, b.phrase[n - 1]])) });
  const e = await api['ghost.vault.exportFile'](); assert.equal(e.ok, true); assert.equal(e.saved, true); assert.equal(e.name, 'out.mfvb'); assert.equal(JSON.stringify(e).includes(dir), false);
  assert.equal(fs.readFileSync(saved).includes(Buffer.from('dialog')), false);
  const c = new VaultService({ root: tmp(), safeStorage: fakeOS(), dialog, vaultOptions: FAST });
  const i = await c.api()['ghost.vault.importFile']({ passphrase: 'long enough passphrase' }); assert.equal(i.ok, true); assert.deepEqual(c.vault.getJSON('cases', 'c'), { t: 'dialog' });
  const bad = await new VaultService({ root: tmp(), safeStorage: fakeOS(), dialog, vaultOptions: FAST }).api()['ghost.vault.importFile']({ passphrase: 'not the passphrase!' }); assert.equal(bad.ok, false);
});

test('bridge: vault calls are Mayfair-view only and check their arguments', () => {
  for (const role of ['page', 'start']) assert.equal(check(role, 'br:ghost.vault.status', []).ok, false);
  assert.equal(ok('ghost.vault.status'), true); assert.equal(ok('ghost.vault.status', 1), false);
  assert.equal(ok('ghost.vault.unlock'), true); assert.equal(ok('ghost.vault.unlock', { passphrase: 'x' }), true); assert.equal(ok('ghost.vault.unlock', { phrase: 'a b c' }), true);
  assert.equal(ok('ghost.vault.unlock', { passphrase: 'x', phrase: 'y' }), false); assert.equal(ok('ghost.vault.unlock', { passphrase: 5 }), false); assert.equal(ok('ghost.vault.unlock', { path: '/etc' }), false);
  assert.equal(ok('ghost.vault.backup.begin', { passphrase: 'x' }), true); assert.equal(ok('ghost.vault.backup.begin', {}), false);
  assert.equal(ok('ghost.vault.backup.confirm', { answers: { 1: 'a', 5: 'b', 12: 'c' } }), true); assert.equal(ok('ghost.vault.backup.confirm', { answers: { 1: 'a' } }), false); assert.equal(ok('ghost.vault.backup.confirm', { answers: { 0: 'a', 5: 'b', 12: 'c' } }), false);
  assert.equal(ok('ghost.vault.changePassphrase', { oldPassphrase: 'a', newPassphrase: 'b' }), true); assert.equal(ok('ghost.vault.changePassphrase', { oldPassphrase: 'a' }), false);
  assert.equal(ok('ghost.vault.resetPassphrase', { phrase: 'a', newPassphrase: 'b' }), true);
  assert.equal(ok('ghost.vault.requirePassphrase', true), true); assert.equal(ok('ghost.vault.requirePassphrase', 'yes'), false); assert.equal(ok('ghost.vault.requirePassphrase'), false);
  assert.equal(ok('ghost.vault.rotateKeys'), true); assert.equal(ok('ghost.vault.rotateKeys', { passphrase: 'x' }), true); assert.equal(ok('ghost.vault.rotateKeys', { key: 'x' }), false);
  assert.equal(ok('ghost.vault.wipe', { confirm: 'WIPE' }), true); assert.equal(ok('ghost.vault.wipe', { confirm: 'wipe' }), false); assert.equal(ok('ghost.vault.wipe'), false);
  assert.equal(ok('ghost.vault.importFile'), false); assert.equal(ok('ghost.vault.importFile', { passphrase: 'x', replace: true }), true); assert.equal(ok('ghost.vault.importFile', { passphrase: 'x', phrase: 'y' }), false); assert.equal(ok('ghost.vault.importFile', { replace: true }), false); assert.equal(ok('ghost.vault.importFile', { passphrase: 'x', path: '/tmp/f' }), false);
  for (const n of ['ghost.vault.exportFile', 'ghost.vault.lock', 'ghost.vault.syncNow', 'ghost.vault.backup.disable', 'ghost.vault.backup.cancel', 'ghost.vault.backup.newPhrase']) { assert.equal(ok(n), true, n); assert.equal(ok(n, { path: '/tmp/x' }), false, n); }
  for (const n of ['getKey', 'exportKey', 'setKey', 'readFile', 'writeFile', 'path']) assert.equal(ok('ghost.vault.' + n), false, n);
});
test('UI: Mayfair skin, no inline script, no innerHTML, no outside requests, no key or path handling', () => {
  const d = path.join(root, 'src/ui/ghost-vault'), html = fs.readFileSync(path.join(d, 'index.html'), 'utf8'), js = fs.readFileSync(path.join(d, 'vault.js'), 'utf8'), css = fs.readFileSync(path.join(d, 'vault.css'), 'utf8');
  assert.match(html, /script-src 'self'/); assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/); assert.doesNotMatch(html, /https?:\/\//); assert.match(html, /\.\.\/ui\.css/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|localStorage|sessionStorage|fetch\(|XMLHttpRequest/);
  assert.match(css, /var\(--mf-/); assert.doesNotMatch(css, /https?:\/\//);
  assert.doesNotMatch(html + js + css, /\bAI\b|\bClaude\b|Anthropic|assistant|generated/i);
});
test('static: no profiling tool names, no AI-authorship words anywhere in the vault code', () => {
  for (const f of walk(path.join(root, 'src/main/ghost/vault')).concat(walk(path.join(root, 'src/ui/ghost-vault')))) {
    const t = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /sherlock|maigret|blackbird|holehe|whatsmyname|Claude|Anthropic|AI-generated|written by AI/i, f);
  }
});
void SecureIO;
