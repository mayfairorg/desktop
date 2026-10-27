'use strict';
// Shared by the ghost-vm-*.test.js files. There is no real QEMU, no image and no network in these tests: "qemu" is a small script
// (fake-qemu.js) that records its command line and, when it is given the agent socket, plays the part of the guest.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = (p = 'mfd-vm-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const FAKE_QEMU = path.join(__dirname, 'fixtures', 'fake-qemu.js');
const FAKE_IMG = path.join(__dirname, 'fixtures', 'fake-qemu-img.js');

// An executable file that runs a node script (the shebang uses the node that runs the tests).
function launcher(dir, name, script, env = {}) {
  const f = path.join(dir, name);
  const e = Object.entries(env).map(([k, v]) => `process.env.${k}=${JSON.stringify(String(v))};`).join('');
  fs.writeFileSync(f, `#!${process.execPath}\n${e}require(${JSON.stringify(script)});\n`, { mode: 0o755 });
  return f;
}
module.exports = { tmp, FAKE_QEMU, FAKE_IMG, launcher };

// A store-only zip (the QEMU "package" in the download test).
const zlib = require('node:zlib');
function makeZip(entries) {
  const parts = []; const cd = []; let off = 0;
  for (const [name, data] of entries) {
    const nb = Buffer.from(name), raw = Buffer.from(data), crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(raw.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, raw);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(raw.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, nb); off += 30 + nb.length + raw.length;
  }
  const cdb = Buffer.concat(cd); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(entries.length, 8); e.writeUInt16LE(entries.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdb, e]);
}
const sha = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex');

// A fetch that serves a map {url: Buffer | {status, headers, body}} and records what was asked.
function fakeFetch(files, log = []) {
  return async (url, opts) => {
    log.push(String(url));
    const f = files[url];
    if (f === undefined) { const e = new Error('connect ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
    const o = Buffer.isBuffer(f) ? { status: 200, body: f } : f;
    const body = o.body === undefined ? Buffer.alloc(0) : o.body;
    const headers = new Map(Object.entries({ 'content-length': String(body.length), ...(o.headers || {}) }));
    return { ok: o.status >= 200 && o.status < 300, status: o.status, headers: { get: (k) => headers.get(String(k).toLowerCase()) || null }, body: null, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length) };
  };
}
Object.assign(module.exports, { makeZip, sha, fakeFetch });

// ---- a complete VmService rig on fake programs
const fs2 = require('node:fs');
function fakeVault(unlocked = true) {
  const m = new Map();
  return { unlocked, m, get: (ns, id) => { const v = m.get(ns + '/' + id); return v === undefined ? null : Buffer.from(v); }, put: (ns, id, v) => { m.set(ns + '/' + id, String(v)); }, remove: (ns, id) => { m.delete(ns + '/' + id); } };
}
function fakeTor(status = 'ready') {
  const t = { ready: status === 'ready', state: { status, socksPort: 9050 }, started: 0, stopped: 0, start: async () => { t.started++; t.ready = true; t.state.status = 'ready'; }, stop: () => { t.stopped++; t.ready = false; t.state.status = 'off'; } };
  return t;
}
function readLog(file) { try { return fs2.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }
const live = [];
async function rig(o = {}) {
  const { VmService } = require('../src/main/ghost/vm/service');
  const root = tmp(), logFile = path.join(root, 'fake.log');
  const qemuScript = fs2.readFileSync(launcher(root, 'q', FAKE_QEMU));
  const imgScript = fs2.readFileSync(launcher(root, 'i', FAKE_IMG));
  const kernel = Buffer.from('kernel'), initrd = Buffer.from('initrd'), disk = Buffer.from('base-disk-image');
  const q = makeZip([['qemu-system-x86_64', qemuScript], ['qemu-img', imgScript]]);
  const u = (n) => 'https://github.com/o/r/releases/download/t1/' + n;
  const files = { [u('q.zip')]: q, [u('k')]: kernel, [u('i')]: initrd, [u('d')]: disk };
  const index = o.index || { schema: 1, published: true, releaseTag: 't1', qemu: { 'linux-x64': { url: u('q.zip'), sha256: sha(q), size: q.length, exec: ['qemu-system-x86_64', 'qemu-img'] } },
    images: { x86_64: { version: '1.0', kernel: { url: u('k'), sha256: sha(kernel), size: kernel.length }, initrd: { url: u('i'), sha256: sha(initrd), size: initrd.length }, disk: { url: u('d'), sha256: sha(disk), size: disk.length } } } };
  const asked = [], events = [], emitted = [], fetchLog = [];
  const vault = o.vault === undefined ? fakeVault() : o.vault;
  const tor = o.tor === undefined ? fakeTor() : o.tor;
  const answer = o.answer || (() => true);
  const svc = new VmService({ root, vault: () => vault, tor, platform: 'linux', arch: 'x64', index, fetchImpl: o.fetchImpl || fakeFetch(files, fetchLog), startTimeoutMs: o.startTimeoutMs || 8000, stopWaitMs: 3000, flushMs: 1,
    confirm: async (x) => { asked.push(x.kind); return answer(x); }, notify: (n, p) => events.push([n, p]), emit: (owner, name, p) => emitted.push([owner, name, p]), host: { totalMemMb: 16000, cpus: 8 },
    env: { PATH: process.env.PATH, FAKE_LOG: logFile, FAKE_ACCEL: o.accel === undefined ? 'kvm' : o.accel, ...(o.env || {}) }, runDirBase: root, accelHint: async () => ({ ok: true, reason: '' }), ...(o.svc || {}) });
  live.push(svc);
  return { svc, root, logFile, vault, tor, asked, events, emitted, fetchLog, files, index, log: () => readLog(logFile), u, base: path.join(root, 'ghost', 'vm') };
}
const until = async (fn, ms = 4000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 15)); } };
// A test that fails half way must not leave a fake machine running (it would keep the test process alive).
const killAll = () => Promise.all(live.map((x) => x.kill().catch(() => {})));
Object.assign(module.exports, { fakeVault, fakeTor, readLog, rig, until, killAll });

// ---- a stand-in for the running machine, for the tool installer and the "Run from GitHub" tests.
// Guest paths (/opt/ghost-tools, /home/ghost) live in a temporary folder; commands run on this computer with those paths swapped in, so the
// REAL git and the REAL shell scripts of the installer run against a REAL (local) repository. https://github.com/<owner>/<repo> is swapped for a
// local bare repository. Nothing here touches the network or a real virtual machine.
const cp = require('node:child_process');
class FakeVm {
  constructor(root, repos = {}) {
    this.root = root; this.repos = repos; this.calls = [];
    fs2.mkdirSync(path.join(root, 'tools'), { recursive: true }); fs2.mkdirSync(path.join(root, 'home', 'src'), { recursive: true });
    this.agent = {
      put: async (p, data, { mode = 0o644 } = {}) => { const f = this.map(p); fs2.mkdirSync(path.dirname(f), { recursive: true }); fs2.writeFileSync(f, Buffer.isBuffer(data) ? data : Buffer.from(String(data)), { mode }); fs2.chmodSync(f, mode); return { ok: true }; },
      rmtree: async (p) => { const f = this.map(p); if (!f.startsWith(this.root + path.sep)) throw new Error('outside'); fs2.rmSync(f, { recursive: true, force: true }); return { ok: true }; },
    };
  }
  status() { return { state: 'running' }; }
  async ensureRunning() {}
  map(s) {
    let o = String(s).split('/opt/ghost-tools').join(path.join(this.root, 'tools')).split('/home/ghost').join(path.join(this.root, 'home'));
    o = o.replace(/https:\/\/github\.com\/([^/]+\/[^/.]+?)(\.git)?$/, (m, r) => this.repos[r] || m);
    return o === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : o;
  }
  _spawn(argv, { cwd, env = {}, timeoutMs = 60000 } = {}) {
    this.calls.push(argv);
    const a = argv.map((x) => this.map(x));
    return cp.spawn(a[0], a.slice(1), { cwd: cwd ? this.map(cwd) : this.root, env: { PATH: process.env.PATH, HOME: this.root, GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C', ...env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
  }
  runArgv(argv, opts = {}) {
    return new Promise((resolve) => {
      const c = this._spawn(argv, opts); let out = '', err = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
      c.on('error', (e) => resolve({ code: 127, signal: null, stdout: out, stderr: String(e.message) }));
      c.on('close', (code, signal) => resolve({ code, signal, stdout: out.split(this.root).join(''), stderr: err.split(this.root).join('') }));
    });
  }
  execStream(argv, opts = {}) {
    const c = this._spawn(argv, opts);
    const done = new Promise((resolve) => { c.on('error', () => resolve({ code: 127, signal: null })); c.on('close', (code, signal) => resolve({ code, signal })); });
    c.stdout.on('data', (d) => opts.onOut && opts.onOut('o', d)); c.stderr.on('data', (d) => opts.onOut && opts.onOut('e', d));
    return { id: 'x', done, kill: () => { try { c.kill('SIGKILL'); } catch { /* gone */ } } };
  }
  guest(p) { return this.map(p); }
}
// A local "GitHub repository": a bare repository holding the given files; returns {bare, commit, add(files, msg)}.
function makeRepo(root, name, files) {
  const work = path.join(root, 'work-' + name.replace('/', '-')), bare = path.join(root, 'bare-' + name.replace('/', '-') + '.git');
  fs2.mkdirSync(work, { recursive: true });
  const git = (...a) => cp.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@localhost', '-c', 'init.defaultBranch=main', ...a], { cwd: work, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  git('init', '-q');
  const write = (fl) => { for (const [f, c] of Object.entries(fl)) { const p = path.join(work, f); fs2.mkdirSync(path.dirname(p), { recursive: true }); fs2.writeFileSync(p, c, { mode: /^bin\//.test(f) ? 0o755 : 0o644 }); } };
  write(files); git('add', '-A'); git('commit', '-q', '-m', 'first');
  cp.execFileSync('git', ['clone', '-q', '--bare', work, bare]);
  const r = { bare, work, commit: git('rev-parse', 'HEAD'), add(fl, msg = 'next') { write(fl); git('add', '-A'); git('commit', '-q', '-m', msg); git('push', '-q', bare, 'HEAD:main'); r.commit = git('rev-parse', 'HEAD'); return r.commit; } };
  return r;
}
const MIT = 'MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n';
const RUN_SH = (tag) => `#!/bin/sh\nprintf '{"entity":{"type":"finding","value":"${tag}-%s"},"source":{"tool":"demo","connector":"%s","version":"1.0.0"},"observedAt":"2025-01-01T00:00:00Z","confidence":"confirmed"}\\n' "$1" "$MF_CONNECTOR_ID"\n`;
Object.assign(module.exports, { FakeVm, makeRepo, MIT, RUN_SH });
