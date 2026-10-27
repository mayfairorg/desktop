'use strict';
// Ghost virtual computer wired into the terminal window and the Ghost app window: the terminal opens the virtual computer by default, the
// local terminal needs a native confirmation every time, every call is checked, and the kill key and the vault lock stop the machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { rig, tmp, until, fakeVault, killAll } = require('./ghost-vm-helpers');
test.after(() => killAll());
const { createTerminal } = require('../src/main/ghost/terminal');
const { makeOps, bind, CALLS, TERMINAL_OPS, APP_OPS } = require('../src/main/ghost/vm/ipc');
const TC = require('../src/main/ghost/terminal/checks');
const AC = require('../src/main/ghost/app/checks');
const posix = process.platform !== 'win32';

function fakeElectron({ response = 0 } = {}) {
  const handlers = new Map(), wins = [], dialogs = [];
  class BW extends EventEmitter {
    constructor(o) { super(); this.o = o; const wc = new EventEmitter(); wc.id = 100 + wins.length; wc.sent = []; wc.send = (...a) => wc.sent.push(a); wc.setWindowOpenHandler = () => {}; wc.mainFrame = { url: '' }; wc.loadURL = (u) => { wc.mainFrame.url = u; }; this.webContents = wc; wins.push(this); }
    loadURL(u) { this.webContents.loadURL(u); } isDestroyed() { return !!this.dead; } isMinimized() { return false; } show() {} focus() {} close() { this.dead = true; this.emit('closed'); }
  }
  const ses = { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } };
  const el = { BrowserWindow: BW, ipcMain: { handle: (ch, f) => handlers.set(ch, f) }, dialog: { showMessageBox: async (...a) => { dialogs.push(a[a.length - 1]); return { response: el.response }; } }, shell: { openPath: async () => '' }, session: { fromPartition: () => ses }, handlers, wins, dialogs, response };
  return el;
}
async function terminalRig(o = {}) {
  const r = await rig({ answer: () => true, ...o });
  await r.svc.install();
  const el = fakeElectron({ response: 0 });
  const ops = makeOps({ vm: r.svc, installer: {}, library: {} }).ops;
  const userData = tmp('mfd-vmw-');
  const t = createTerminal({ electron: el, userData, vm: { service: r.svc, terminalBridge: bind('gterm:vm.', TERMINAL_OPS, ops), onStatus: (f) => { r.svc.notify = (n, p) => f(p); } }, baseEnv: { PATH: process.env.PATH }, mode: 'basic' });
  await t.show();
  const wc = el.wins[0].webContents; wc.mainFrame = { url: t.page };
  const good = { sender: wc, senderFrame: wc.mainFrame };
  const call = (ch, ...a) => el.handlers.get(ch)(good, ...a);
  return { r, el, t, wc, call, good, userData };
}

test('the terminal window opens the virtual computer by default and shows no local-terminal notice', async () => {
  const { r, el, call, t, wc } = await terminalRig();
  assert.equal(el.dialogs.length, 0, 'no notice: nothing runs on this computer');
  const info = await call('gterm:info'); assert.equal(info.mode, 'vm'); assert.equal(info.local.available, true);
  const term = await call('gterm:open', { cols: 80, rows: 24 }); assert.equal(term.mode, 'vm');
  await until(() => wc.sent.some((a) => a[0] === 'gterm:data' && /ghost\$/.test(a[1].data)));
  await call('gterm:input', term.id, 'ls\r');
  await until(() => wc.sent.some((a) => a[0] === 'gterm:data' && a[1].data === 'ls\r'));
  assert.equal(r.log().filter((l) => l.req === 'shell').length, 1);
  assert.ok(wc.sent.some((a) => a[0] === 'gterm:vm' && a[1].state === 'running'), 'the status bar gets the machine state');
  assert.equal(el.dialogs.length, 0);
  await r.svc.kill(); t.shutdown();
});
test('the local terminal is an explicit advanced choice that asks in a native dialog EVERY time and says what is lost', async () => {
  const { r, el, call, t } = await terminalRig();
  el.response = 1;
  await assert.rejects(call('gterm:open', { cols: 80, rows: 24, local: true }), /blocked: the notice for the local terminal was not accepted/);
  assert.equal(el.dialogs.length, 1); assert.match(el.dialogs[0].message, /outside the Ghost virtual computer/); assert.match(el.dialogs[0].detail, /none of the virtual computer's protection|does not: it has none of that protection/);
  assert.equal(r.log().filter((l) => l.req === 'shell').length, 0);
  el.response = 0;
  const a = await call('gterm:open', { cols: 80, rows: 24, local: true }); assert.notEqual(a.mode, 'vm');
  const b = await call('gterm:open', { cols: 80, rows: 24, local: true }); assert.equal(el.dialogs.length, 3, 'asked again for the second one');
  assert.equal((await call('gterm:localInfo')).mode === 'vm', false);
  await call('gterm:close', a.id); await call('gterm:close', b.id);
  assert.equal((await call('gterm:open', { cols: 80, rows: 24 })).mode, 'vm', 'and the next default terminal is the virtual computer again');
  assert.equal(el.dialogs.length, 3);
  await r.svc.kill(); t.shutdown();
});
test('terminal window: virtual-computer calls are checked; an unknown field, a command or a path is refused; other senders are refused', async () => {
  const { r, el, call, t, wc } = await terminalRig();
  await assert.rejects(call('gterm:vm.network', { mode: 'wide-open' }), /bad argument/);
  await assert.rejects(call('gterm:vm.network', { mode: 'tor', host: 'x' }), /bad argument/);
  await assert.rejects(call('gterm:vm.start', { caseId: '../x' }), /bad argument/);
  await assert.rejects(call('gterm:vm.start', { argv: ['sh'] }), /bad argument/);
  await assert.rejects(call('gterm:vm.useCase', { caseId: 'a/b' }), /bad argument/);
  await assert.rejects(call('gterm:vm.snapshot', '../etc'), /bad argument/);
  await assert.rejects(call('gterm:vm.resources', { memMb: 1.5 }), /bad argument/);
  await assert.rejects(call('gterm:vm.resources', { memMb: 1024, path: '/' }), /bad argument/);
  await assert.rejects(call('gterm:vm.gh.clone', { url: 'https://github.com/a/b', cmd: 'x' }), /bad argument/);
  await assert.rejects(call('gterm:vm.gh.show', { name: '../x', id: 'make-0' }), /bad argument/);
  await assert.rejects(call('gterm:vm.gh.show', { name: 'x', id: 'rm -rf' }), /bad argument/);
  await assert.rejects(call('gterm:vm.status', 'extra'), /bad argument|arguments/);
  const st = await call('gterm:vm.status'); assert.equal(st.state, 'stopped'); assert.equal(st.route.mode, 'tor');
  assert.equal((await call('gterm:vm.network', { mode: 'none' })).ok, true);
  const other = { id: 5, mainFrame: { url: 'https://cloud.mayfairmail.com/' } };
  await assert.rejects(() => el.handlers.get('gterm:vm.kill')({ sender: other, senderFrame: other.mainFrame }), /untrusted sender/);
  await assert.rejects(() => el.handlers.get('gterm:vm.install')({ sender: other, senderFrame: other.mainFrame }), /untrusted sender/);
  t.shutdown();
});
test('the kill key and the kill button stop the machine; Ghost\'s own kill and a vault lock do too', async () => {
  const { r, el, call, t, wc } = await terminalRig();
  await r.svc.start({ caseId: 'case1' }); const term = await call('gterm:open', { cols: 80, rows: 24 });
  let prevented = 0; wc.emit('before-input-event', { preventDefault: () => prevented++ }, { type: 'keyDown', shift: true, control: true, key: 'Backspace' });
  assert.equal(prevented, 1); await until(() => r.svc.status().state === 'stopped');
  assert.ok(wc.sent.some((a) => a[0] === 'gterm:exit' && a[1].id === term.id));
  await r.svc.start({ caseId: 'case1' }); assert.equal((await call('gterm:vm.kill')).vm, true); assert.equal(r.svc.status().state, 'stopped');
  // the vault lock (what Ghost's kill switch calls) stops the machine first
  const { createGhostVm } = require('../src/main/ghost/vm');
  const vault = fakeVault(); let locked = 0; vault.lock = () => { locked++; vault.unlocked = false; };
  const el2 = fakeElectron(); const r2 = await rig({ vault });
  const g = { _confirm: async () => true, setVm() {}, manager: {} };
  const vmx = createGhostVm({ electron: el2, userData: r2.root, getGhost: () => g, getVault: () => vault, service: { index: r2.index, env: { PATH: process.env.PATH }, platform: 'linux', arch: 'x64', accelHint: async () => ({ ok: true, reason: '' }), runDirBase: r2.root, fetchImpl: async () => { throw new Error('no network'); } } });
  assert.ok(vmx.service && vmx.terminalBridge.handlers['gterm:vm.status'] && vmx.appBridge.handlers['gapp:vm.tools.list']);
  let killed = 0; const orig = vmx.service.kill.bind(vmx.service); vmx.service.kill = () => { killed++; return orig(); };
  vault.lock(); assert.equal(killed, 1); assert.equal(locked, 1);
  t.shutdown();
});
test('calls: every virtual-computer call has a validator, the two windows get only their own, and none takes a command, a program or a path', () => {
  for (const n of [...TERMINAL_OPS, ...APP_OPS]) assert.ok(Array.isArray(CALLS[n]), n);
  assert.ok(TERMINAL_OPS.every((n) => 'gterm:vm.' + n in TC.CALLS || TC.check('gterm:vm.' + n, []).ok !== undefined));
  for (const n of TERMINAL_OPS) assert.equal(typeof TC.check('gterm:vm.' + n, new Array(CALLS[n].length).fill(undefined)).ok, 'boolean', n);
  for (const n of APP_OPS) assert.equal(typeof AC.check('gapp:vm.' + n, new Array(CALLS[n].length).fill(undefined)).ok, 'boolean', n);
  assert.equal(TC.check('gterm:vm.tools.list', []).ok, false, 'tools calls belong to the Ghost window only');
  assert.equal(AC.check('gapp:vm.reset', []).ok, false, 'reset and snapshots are the terminal window\'s'); assert.equal(AC.check('gapp:vm.wipeTools', []).ok, false);
  for (const n of [...TERMINAL_OPS, ...APP_OPS]) assert.ok(!/exec|spawn|command|shell|eval|argv|sudo|path|file(?!s)/i.test(n.replace('exportFile', '').replace('importFile', '')), n);
  assert.ok(!TERMINAL_OPS.concat(APP_OPS).some((n) => /^tools\.(run|exec)$/.test(n)));
  // the Ghost window can only name a tool by its id, a connector by a checked form, and a setup command by an id main produced
  assert.equal(AC.check('gapp:vm.tools.runSetup', [{ name: 'x', ids: ['sh -c id'] }]).ok, false);
  assert.equal(AC.check('gapp:vm.tools.runSetup', [{ name: 'x', ids: ['make-0'] }]).ok, true);
  assert.equal(AC.check('gapp:vm.tools.register', [{ name: 'x', form: { program: 'bin/run', exec: 'x' } }]).ok, false);
  assert.equal(AC.check('gapp:vm.tools.prepareUpload', [{ kind: 'folder', path: '/etc' }]).ok, false);
  assert.equal(AC.check('gapp:vm.tools.prepareUpload', [{ kind: 'folder' }]).ok, true);
  assert.equal(AC.check('gapp:vm.tools.prepareGithub', [{ url: 'https://github.com/a/b', ref: 'v1' }]).ok, true);
  assert.equal(AC.check('gapp:terminal.open', [{ caseId: '../x' }]).ok, false); assert.equal(AC.check('gapp:terminal.open', [{ caseId: 'case-1' }]).ok, true); assert.equal(AC.check('gapp:terminal.open', [{ cmd: 'x' }]).ok, false);
});
test('preload files expose exactly the calls the main side registers', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8');
  const term = read('ghost-terminal/preload.js');
  const used = new Set([...term.matchAll(/gterm:vm\.([A-Za-z.]+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), [...TERMINAL_OPS].sort());
  const app = read('ghost/preload.js');
  const z = [...app.matchAll(/\b[ZO]\('([A-Za-z.]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(z)].sort(), [...APP_OPS].sort());
});
test('the virtual-computer pages use text nodes only: no innerHTML, no inline handlers, no remote addresses', () => {
  for (const f of ['ghost-vm/vm-term.js', 'ghost-vm/tools-vm.js']) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest|WebSocket|sendBeacon|\.src\s*=/.test(s), f);
  }
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'ghost-vm', 'vm.css'), 'utf8');
  assert.ok(!/#[0-9a-f]{3,8}\b(?![^)]*\))/i.test(css.replace(/var\([^)]*\)/g, '')) , 'colours come from the --mf tokens (fallbacks only inside var())');
  for (const f of ['ghost-terminal/index.html', 'ghost/index.html']) { const h = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', f), 'utf8'); assert.ok(/ghost-vm\//.test(h), f); assert.ok(!/<script>[^<]|onclick=|style=/.test(h), f); }
});
