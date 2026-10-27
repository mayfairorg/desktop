'use strict';
// Ghost terminal (main side): environment, PATH, shell choice, first-use notice, sessions, the terminal window's IPC rules. No display needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { tmp, waitFor } = require('./ghost-terminal-helpers');
const { buildEnv, buildPath, isDropped } = require('../src/main/ghost/terminal/env');
const { pickShell } = require('../src/main/ghost/terminal/shell');
const T = require('../src/main/ghost/terminal/tools');
const { TermsStore, ensureAccepted, noticeOptions } = require('../src/main/ghost/terminal/terms');
const { TerminalService, LIMITS } = require('../src/main/ghost/terminal/service');
const { probePython } = require('../src/main/ghost/terminal/backend');
const { check, CALLS } = require('../src/main/ghost/terminal/checks');
const { createTerminalWindow } = require('../src/main/ghost/terminal/window');

const posix = process.platform !== 'win32';
const live = [];                                   // every service a test starts is shut down afterwards, even when the test fails
test.afterEach(() => { for (const s of live.splice(0)) s.shutdown(); });

test('environment: app-internal variables are dropped, the user\'s own are kept, PATH gets the tools folder first', () => {
  const home = tmp(), tools = path.join(home, 'tools');
  const base = { PATH: '/usr/bin:/bin', HOME: home, USER: 'sam', GH_TOKEN: 'mine', ELECTRON_RUN_AS_NODE: '1', ELECTRON_ENABLE_LOGGING: '1', NODE_OPTIONS: '--inspect', MAYFAIR_DESKTOP_DATA: '/x', MF_SMOKE: '1', APPIMAGE: '/a.AppImage', LANG: 'en_GB.UTF-8' };
  const copy = { ...base };
  const env = buildEnv(base, { platform: 'linux', home, toolsDir: tools, toolDirs: [tools, path.join(tools, 'bin')], exists: () => false });
  assert.deepEqual(base, copy, 'the input is not modified');
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS', 'MAYFAIR_DESKTOP_DATA', 'MF_SMOKE', 'APPIMAGE']) assert.equal(env[k], undefined, k);
  assert.equal(env.GH_TOKEN, 'mine'); assert.equal(env.USER, 'sam'); assert.equal(env.LANG, 'en_GB.UTF-8');
  assert.equal(env.PATH.split(':')[0], tools);
  assert.equal(env.PATH.split(':')[1], path.join(tools, 'bin'));
  assert.equal(env.TERM, 'xterm-256color'); assert.equal(env.MAYFAIR_GHOST_TOOLS, tools);
  assert.ok(isDropped('ELECTRON_FOO') && !isDropped('HOME'));
});
test('PATH: extras are added only when they exist, no duplicates, Windows is case-insensitive', () => {
  const p = buildPath({ platform: 'linux', basePath: '/usr/bin:/bin', toolDirs: ['/t'], extras: ['/opt/homebrew/bin', '/usr/bin', '/nope'], exists: (d) => d === '/opt/homebrew/bin' || d === '/usr/bin' });
  assert.equal(p, '/t:/usr/bin:/bin:/opt/homebrew/bin');
  const w = buildEnv({ Path: 'C:\\Windows', USERPROFILE: 'C:\\Users\\a' }, { platform: 'win32', home: 'C:\\Users\\a', toolsDir: 'C:\\t', toolDirs: ['C:\\t'], exists: () => true });
  assert.ok(w.Path.startsWith('C:\\t;C:\\Windows;')); assert.equal(w.PATH, undefined);
  assert.ok(w.Path.includes('Git\\cmd') && w.Path.includes('nodejs') && w.Path.includes('.local\\bin'));
});
test('basic mode: no pager waits for a terminal that is not there', () => {
  const e = buildEnv({ PATH: '/bin', COLORTERM: 'x' }, { platform: 'linux', home: '/h', mode: 'basic', exists: () => false });
  assert.equal(e.PAGER, 'cat'); assert.equal(e.GIT_PAGER, 'cat'); assert.equal(e.TERM, 'dumb'); assert.equal(e.COLORTERM, undefined);
});
test('shell choice: starts with no command on every platform; login shell on POSIX; -i only in basic mode', () => {
  const ex = (set) => (p) => set.includes(p);
  let s = pickShell({ platform: 'linux', env: { SHELL: '/bin/zsh' }, exists: ex(['/bin/zsh', '/bin/bash']) });
  assert.deepEqual([s.file, s.args, s.name], ['/bin/zsh', ['-l'], 'zsh']);
  s = pickShell({ platform: 'linux', env: { SHELL: '/bin/zsh' }, mode: 'basic', exists: ex(['/bin/zsh']) });
  assert.deepEqual(s.args, ['-l', '-i']);
  s = pickShell({ platform: 'darwin', env: {}, exists: ex(['/bin/zsh']) }); assert.equal(s.file, '/bin/zsh');
  s = pickShell({ platform: 'linux', env: { SHELL: 'relative/sh' }, exists: ex(['/bin/bash']) }); assert.equal(s.file, '/bin/bash', 'a relative SHELL is ignored');
  assert.throws(() => pickShell({ platform: 'linux', env: {}, exists: () => false }), /no shell/);
  s = pickShell({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' }, exists: ex(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']) });
  assert.equal(s.name, 'powershell'); assert.deepEqual(s.args, ['-NoLogo']);
  for (const m of ['pty', 'basic']) for (const plat of ['linux', 'win32']) { const r = pickShell({ platform: plat, env: { SHELL: '/bin/bash', SystemRoot: 'C:\\Windows' }, mode: m, exists: () => true }); assert.ok(!r.args.includes('-c') && !r.args.includes('/c') && !r.args.includes('-Command') || (plat === 'win32' && r.args.join(' ').endsWith('-Command -')), plat + m); }
});
test('tools folder: bin dirs are on PATH, added tools (connector.json) and links are not; programs are found without running anything', { skip: !posix }, () => {
  const root = tmp(); const tools = path.join(root, 'tools');
  for (const d of ['bin', 'mytool/bin', 'conn/bin', 'noexe']) fs.mkdirSync(path.join(tools, d), { recursive: true });
  fs.writeFileSync(path.join(tools, 'conn', 'connector.json'), '{}');
  fs.writeFileSync(path.join(tools, 'bin', 'hello'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tools, 'bin', 'plain.txt'), 'x', { mode: 0o644 });
  fs.writeFileSync(path.join(tools, 'mytool', 'bin', 'mine'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(os_tmp(), path.join(tools, 'link'));
  const dirs = T.toolDirs(tools);
  assert.ok(dirs.includes(path.join(tools, 'bin')) && dirs.includes(path.join(tools, 'mytool', 'bin')));
  assert.ok(!dirs.includes(path.join(tools, 'conn', 'bin')), 'a connector folder never goes on PATH');
  assert.ok(!dirs.some((d) => d.includes('link')));
  assert.deepEqual(T.listTools(tools), ['hello', 'mine']);
  const bin = path.join(root, 'b'); fs.mkdirSync(bin); fs.writeFileSync(path.join(bin, 'git'), '');
  const pr = T.probe(bin, 'linux');
  assert.equal(pr.find((x) => x.id === 'git').found, true);
  const gh = pr.find((x) => x.id === 'gh'); assert.equal(gh.found, false); assert.match(gh.hint, /gh/);
  function os_tmp() { return require('node:os').tmpdir(); }
});

test('first-use notice: native dialog, cancel is the default, nothing recorded unless the first button is clicked, a new major asks again', async () => {
  const dir = tmp(); const store = new TermsStore(path.join(dir, 'ghost', 'terminal.json'));
  const calls = [];
  const dlg = (resp) => ({ showMessageBox: async (...a) => { calls.push(a[a.length - 1]); return { response: resp }; } });
  assert.equal(store.accepted(), false);
  assert.equal(await ensureAccepted({ store, dialog: dlg(1), parent: null, toolsDir: '/t' }), false);
  assert.equal(store.accepted(), false);
  assert.equal(await ensureAccepted({ store, dialog: dlg(0), parent: null, toolsDir: '/t' }), true);
  assert.equal(store.accepted(), true);
  const n = calls.length;
  assert.equal(await ensureAccepted({ store, dialog: dlg(1), parent: null, toolsDir: '/t' }), true);
  assert.equal(calls.length, n, 'no second dialog once accepted');
  const o = calls[0];
  assert.equal(o.defaultId, 1); assert.equal(o.cancelId, 1); assert.match(o.buttons[0], /understand/i); assert.match(o.detail, /real commands|runs as you/i); assert.match(o.detail, /web page/i);
  assert.ok(o.detail.includes('/t'), 'names the tools folder');
  fs.writeFileSync(store.file, JSON.stringify({ version: '0.9', acceptedAt: new Date().toISOString() }));
  assert.equal(store.accepted(), false, 'an older major version asks again');
  fs.writeFileSync(store.file, 'garbage'); assert.equal(store.accepted(), false);
  assert.ok(!/\bAI\b|Claude|Anthropic|assistant/i.test(JSON.stringify(noticeOptions('/t'))));
});

// ---- sessions ----
function svc(over = {}) {
  const root = tmp(); const out = [];
  const terms = { accepted: () => true };
  const s = new TerminalService({ root, terms, mode: 'basic', baseEnv: { PATH: process.env.PATH, HOME: root }, home: root, emit: (o, n, p) => out.push([o, n, p]), flushMs: 5, ...over });
  live.push(s);
  const text = (owner, id) => out.filter((x) => x[0] === owner && x[1] === 'data' && x[2].id === id).map((x) => x[2].data).join('');
  return { s, out, root, text };
}
test('open is refused until the first-use notice is accepted, and for bad sizes', async () => {
  const { s } = svc({ terms: { accepted: () => false } });
  await assert.rejects(() => s.open(1, { cols: 80, rows: 24 }), /first-use notice/);
  const b = svc().s;
  await assert.rejects(() => b.open(1, { cols: 5, rows: 24 }), /bad size/);
  await assert.rejects(() => b.open(1, { cols: 80, rows: 9999 }), /bad size/);
});
test('a shell starts with no command and nothing runs until input arrives', { skip: !posix }, async () => {
  const { s, text, root } = svc();
  const marker = path.join(root, 'ran');
  const r = await s.open(1, { cols: 80, rows: 24 });
  await new Promise((x) => setTimeout(x, 600));
  assert.equal(fs.existsSync(marker), false);
  s.input(1, r.id, 'echo hi > "' + marker + '"; echo done-$((20+22))\n');
  await waitFor(() => text(1, r.id).includes('done-42'));
  assert.equal(fs.existsSync(marker), true);
  s.shutdown();
});
test('input only works for the window that opened the terminal; bad ids, sizes and oversize input are refused', { skip: !posix }, async () => {
  const { s } = svc();
  const r = await s.open(1, { cols: 80, rows: 24 });
  assert.throws(() => s.input(2, r.id, 'ls\n'), /no such terminal/);
  assert.throws(() => s.input(1, 'deadbeefdeadbeef', 'ls\n'), /no such terminal/);
  assert.throws(() => s.input(1, r.id, 'x'.repeat(LIMITS.input + 1)), /bad input/);
  assert.throws(() => s.input(1, r.id, 5), /bad input/);
  assert.throws(() => s.resize(1, r.id, 3, 3), /bad size/);
  assert.throws(() => s.close(2, r.id), /no such terminal/);
  s.shutdown();
});
test('the session limit holds, and closing a window closes its shells', { skip: !posix }, async () => {
  const { s, out } = svc();
  const ids = []; for (let i = 0; i < LIMITS.sessions; i++) ids.push((await s.open(7, { cols: 80, rows: 24 })).id);
  await assert.rejects(() => s.open(7, { cols: 80, rows: 24 }), /too many/);
  s.closeOwner(7);
  await waitFor(() => s.count() === 0, 8000);
  assert.equal(out.filter((x) => x[1] === 'exit').length, LIMITS.sessions);
});
test('basic mode: the shell sees the scrubbed environment and the tools folder on PATH; Ctrl+C reaches the running command', { skip: !posix }, async () => {
  const { s, text, root } = svc({ baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME || '/', ELECTRON_RUN_AS_NODE: '1', MF_SMOKE: '1', KEEP_ME: 'yes' } });
  const r = await s.open(1, { cols: 80, rows: 24 });
  assert.equal(r.mode, 'basic');
  s.input(1, r.id, 'echo E=[$ELECTRON_RUN_AS_NODE$MF_SMOKE] K=[$KEEP_ME] P=$PATH\n');
  await waitFor(() => /P=\S+/.test(text(1, r.id)));
  const t = text(1, r.id);
  assert.match(t, /E=\[\]/); assert.match(t, /K=\[yes\]/);
  assert.ok(t.includes(path.join(root, 'ghost', 'tools') + ':') && t.includes(path.join(root, 'ghost', 'tools', 'bin')), 'the tools folder is on PATH (a login shell\'s profile may reorder it)');
  s.input(1, r.id, 'sleep 30\n');
  await new Promise((x) => setTimeout(x, 400));
  assert.equal(s.interrupt(1, r.id), true);
  s.input(1, r.id, 'echo after-$((1+1))\n');
  await waitFor(() => text(1, r.id).includes('after-2'));
  s.shutdown();
});
test('python helper gives the shell a real terminal (tty, TERM, size, resize)', { skip: !posix }, async (t) => {
  const py = require('../src/main/ghost/terminal/tools').which('python3', process.env.PATH, 'linux');
  if (!py || !(await probePython(py, { PATH: process.env.PATH }))) return t.skip('python3 not available');
  const { s, text } = svc({ mode: 'python' });
  const r = await s.open(1, { cols: 91, rows: 23 });
  assert.equal(r.mode, 'python');
  await waitFor(() => /\$ $|# $|% $|> $/.test(text(1, r.id).replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, '')));
  s.input(1, r.id, 'tty; echo T=$TERM; stty size\n');
  await waitFor(() => text(1, r.id).includes('23 91'));
  assert.match(text(1, r.id), /\/dev\/(pts|tty)/); assert.match(text(1, r.id), /T=xterm-256color/);
  s.resize(1, r.id, 100, 30);
  await new Promise((x) => setTimeout(x, 200));
  s.input(1, r.id, 'stty size\n');
  await waitFor(() => text(1, r.id).includes('30 100'));
  s.input(1, r.id, 'exit 7\n');
  await waitFor(() => s.count() === 0);
});
test('output flow control: unacknowledged output pauses the shell and an ack resumes it', async () => {
  const log = []; const b = new EventEmitter(); b.mode = 'pty'; b.pid = 1; b.write = () => {}; b.resize = () => {}; b.interrupt = () => true; b.kill = () => {}; b.pause = () => log.push('pause'); b.resume = () => log.push('resume');
  const out = [];
  const s = new TerminalService({ root: tmp(), terms: { accepted: () => true }, mode: 'pty', pty: { spawn: () => ({ pid: 1, onData: (f) => { b.on('data', f); }, onExit: () => {}, write() {}, resize() {}, pause: b.pause, resume: b.resume, kill() {} }) }, baseEnv: { PATH: process.env.PATH }, home: tmp(), emit: (o, n, p) => out.push([n, p]), flushMs: 1 });
  const r = await s.open(1, { cols: 80, rows: 24 });
  assert.equal(r.mode, 'pty');
  for (let i = 0; i < 20; i++) b.emit('data', 'x'.repeat(LIMITS.chunk));
  await waitFor(() => log.includes('pause'));
  assert.ok(out.every((x) => x[1].data.length <= LIMITS.chunk));
  const total = out.reduce((n, x) => n + x[1].data.length, 0);
  s.ack(1, r.id, total);
  assert.deepEqual(log, ['pause', 'resume']);
});

// ---- the window and its IPC rules ----
function fakeElectron({ response = 0 } = {}) {
  const handlers = new Map(), wins = [], dialogs = [];
  class BW extends EventEmitter {
    constructor(o) { super(); this.o = o; const wc = new EventEmitter(); wc.id = 100 + wins.length; wc.sent = []; wc.send = (...a) => wc.sent.push(a); wc.setWindowOpenHandler = (f) => { wc.openHandler = f; }; wc.mainFrame = { url: '' }; wc.loadURL = (u) => { wc.mainFrame.url = u; }; this.webContents = wc; wins.push(this); }
    loadURL(u) { this.webContents.loadURL(u); } isDestroyed() { return !!this.dead; } isMinimized() { return false; } show() { this.shown = true; } focus() {} close() { this.dead = true; this.emit('closed'); }
  }
  const sessions = [];
  const ses = { setPermissionRequestHandler(f) { ses.perm = f; }, setPermissionCheckHandler(f) { ses.permCheck = f; }, webRequest: { onBeforeRequest(f, cb) { ses.filter = f; ses.block = cb; } } };
  return { BrowserWindow: BW, ipcMain: { handle: (ch, f) => handlers.set(ch, f) }, dialog: { showMessageBox: async (...a) => { dialogs.push(a[a.length - 1]); return { response }; } }, shell: { openPath: async () => '' }, session: { fromPartition: (p) => { ses.partition = p; return ses; } }, handlers, wins, dialogs, ses, sessions };
}
function windowRig(opts) {
  const el = fakeElectron(opts), dir = tmp(); const terms = new TermsStore(path.join(dir, 't.json'));
  const service = new TerminalService({ root: dir, terms, mode: 'basic', baseEnv: { PATH: process.env.PATH }, home: dir, flushMs: 2 });
  const uiDir = path.join(__dirname, '..', 'src', 'ui', 'ghost-terminal');
  live.push(service);
  const w = createTerminalWindow({ electron: el, service, terms, uiDir, isPackaged: true });
  return { el, service, w, dir, terms, uiDir };
}
test('window: the notice comes first; declining opens nothing and registers no channel', async () => {
  const { el, w } = windowRig({ response: 1 });
  assert.equal(await w.show(), false);
  assert.equal(el.wins.length, 0); assert.equal(el.handlers.size, 0); assert.equal(el.dialogs.length, 1);
});
test('window: isolated, no network, no navigation, no new windows, no permissions, separate in-memory partition', async () => {
  const { el, w } = windowRig({ response: 0 });
  assert.equal(await w.show(), true);
  const win = el.wins[0], wp = win.o.webPreferences;
  assert.equal(wp.contextIsolation, true); assert.equal(wp.sandbox, true); assert.equal(wp.nodeIntegration, false); assert.equal(wp.webSecurity, true);
  assert.ok(wp.partition && !wp.partition.startsWith('persist:'));
  assert.ok(wp.preload.endsWith(path.join('ghost-terminal', 'preload.js')));
  assert.equal(win.webContents.openHandler({ url: 'https://example.com' }).action, 'deny');
  let prevented = 0; for (const ev of ['will-navigate', 'will-redirect', 'will-attach-webview']) win.webContents.emit(ev, { preventDefault: () => prevented++ });
  assert.equal(prevented, 3);
  let allowed = null; el.ses.perm({}, 'media', (v) => { allowed = v; }); assert.equal(allowed, false); assert.equal(el.ses.permCheck(), false);
  assert.ok(el.ses.filter.urls.includes('https://*/*')); let cancelled = null; el.ses.block({}, (r) => { cancelled = r.cancel; }); assert.equal(cancelled, true);
  assert.ok(win.webContents.mainFrame.url.startsWith('file://') && win.webContents.mainFrame.url.endsWith('/ghost-terminal/index.html'));
  assert.equal(await w.show(), true); assert.equal(el.wins.length, 1, 'a second show focuses the same window');
});
test('window: only the terminal window\'s own page can call; every other sender is refused', async () => {
  const { el, w, service } = windowRig({ response: 0 });
  await w.show();
  const win = el.wins[0], wc = win.webContents;
  const good = { sender: wc, senderFrame: wc.mainFrame };
  wc.mainFrame = { url: w.page }; good.senderFrame = wc.mainFrame; wc.mainFrame.url = w.page;
  const call = (ch, e, ...a) => el.handlers.get(ch)(e, ...a);
  const info = await call('gterm:info', good); assert.ok(info.toolsDir);
  const other = { id: 5, mainFrame: { url: 'https://cloud.mayfairmail.com/' } };
  await assert.rejects(() => call('gterm:info', { sender: other, senderFrame: other.mainFrame }), /untrusted sender/);
  await assert.rejects(() => call('gterm:open', { sender: other, senderFrame: other.mainFrame }, { cols: 80, rows: 24 }), /untrusted sender/);
  await assert.rejects(() => call('gterm:input', { sender: wc, senderFrame: { url: w.page } }, 'a'.repeat(16), 'ls\n'), /untrusted sender/, 'a sub-frame is refused');
  wc.mainFrame.url = 'https://evil.example/'; await assert.rejects(() => call('gterm:info', good), /untrusted sender/, 'the window navigated away: refused');
  wc.mainFrame.url = w.page;
  await assert.rejects(() => call('gterm:input', good, 'zz', 'ls\n'), /bad argument 1/);
  await assert.rejects(() => call('gterm:open', good, { cols: 80, rows: 24, cmd: 'rm -rf /' }), /bad argument 1/);
  await assert.rejects(() => call('gterm:input', good, 'a'.repeat(16), 'ls\n'), /no such terminal/);
  service.shutdown();
});
test('window: events go only to the terminal window; closing it closes its shells', { skip: !posix }, async () => {
  const { el, w, service } = windowRig({ response: 0 });
  await w.show();
  const wc = el.wins[0].webContents; wc.mainFrame = { url: w.page };
  const good = { sender: wc, senderFrame: wc.mainFrame };
  const r = await el.handlers.get('gterm:open')(good, { cols: 80, rows: 24 });
  await el.handlers.get('gterm:input')(good, r.id, 'echo from-$((3+4))\n');
  await waitFor(() => wc.sent.some((a) => a[0] === 'gterm:data' && a[1].data.includes('from-7')));
  w.close();
  await waitFor(() => service.count() === 0, 8000);
});
test('channels: all are gterm:*, none takes a command, and none is part of the Browser bridge allowlist', () => {
  const names = Object.keys(CALLS);
  assert.ok(names.every((n) => n.startsWith('gterm:')));
  assert.ok(!names.some((n) => /exec|spawn|command|shell|eval|argv|sudo/i.test(n)));
  const IPC = require('../src/main/lib/ipc-allowlist');
  const all = JSON.stringify([IPC.CH, IPC.EVENTS]);
  assert.ok(!all.includes('gterm'), 'not in the Browser bridge');
  for (const role of ['web', 'page', 'start']) assert.ok(!IPC.channelsFor(role).some((c) => c.includes('gterm')), role);
  assert.equal(check('gterm:exec', ['ls']).ok, false);
  assert.equal(check('gterm:input', ['0123456789abcdef', 'ls\n']).ok, true);
  assert.equal(check('gterm:input', ['0123456789abcdef', '']).ok, false);
  assert.equal(check('gterm:tools.run', [{ id: 'echo-tool', input: { text: 'a' }, extra: 1 }]).ok, false);
  assert.equal(check('gterm:tools.run', [{ id: 'echo-tool', scope: { target: 'x', confirmedAuthorised: 'yes' } }]).ok, false);
});
