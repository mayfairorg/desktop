'use strict';
// Ghost virtual computer: the service. One machine at a time (one case). Electron is not required here: native dialogs arrive as confirm().
//
//   download   first use: the QEMU program and the system image, pinned by SHA-256 (images.js). Nothing is bundled.
//   start      verify files, detect the accelerator, make the disks (encrypted under the vault key where it is available), share ONE folder,
//              start QEMU with a command line built by argv.js, wait for the agent inside to say hello with the one-time token.
//   network    no card. The gateway (gateway.js) decides every connection: tor (default), direct with encrypted DNS (native confirm), or off.
//   stop/kill  stop asks the machine to power off and kills it after a short wait. kill is immediate, drops every connection and every
//              key file. The disk is kept; reset deletes it.
//   terminals  real pseudo-terminals started by the agent; the terminal window draws them with the same emulator as the local terminal.
// This object is deliberately NOT an EventEmitter: like TerminalService, `emit(owner, name, payload)` is assigned by the window.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { killTree } = require('../proc');
const { Assets, VmError, loadIndex, plan } = require('./images');
const P = require('./platform');
const { buildArgv, resources, shareMode, selfCheck } = require('./argv');
const { VmDisk, keyDelivery, CASE_RE } = require('./disk');
const { ensureShare } = require('./share');
const { AgentClient } = require('./agent');
const { EgressGateway } = require('./gateway');
const { createResolver } = require('./doh');
const route = require('../browser/route');
const { MIN, MAX } = require('./argv');

const LIMITS = { sessions: 8, input: 64 * 1024, chunk: 64 * 1024, flushMs: 8, high: 1024 * 1024, low: 256 * 1024, cols: [10, 500], rows: [2, 200] };
const int = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;
const ROUTES = ['tor', 'direct-doh', 'none'];
const LOG_MAX = 64 * 1024;

class VmService {
  // root: userData. vault: () => Vault|null. tor: a TorManager (or null). confirm(opts) -> bool. notify(name, payload): status and download events for the window.
  constructor({ root, vault = () => null, tor = null, confirm = async () => false, notify = () => {}, platform = process.platform, arch = process.arch, spawnImpl = spawn, fetchImpl = (typeof fetch === 'function' ? fetch : null),
    index = null, host = {}, dnsProvider = 'cloudflare', resolver = null, runDirBase = os.tmpdir(), startTimeoutMs = null, stopWaitMs = 15000, diskRun, freeBytes, emit = () => {}, now = Date.now, flushMs = LIMITS.flushMs, env = null, releaseTor = null, confirmDownload = true, accelHint = null } = {}) {
    this.accelHint = accelHint;                        // test seam: replaces the operating-system check (/dev/kvm, sysctl)
    this.confirmDownload = confirmDownload;
    this.releaseTor = releaseTor;                      // called when the machine stops: the owner of the shared Tor program decides whether anything else still uses it
    this.root = root; this.vault = vault; this.tor = tor; this.confirm = confirm; this.notify = notify; this.platform = platform; this.arch = arch; this.spawn = spawnImpl;
    this.index = index || loadIndex(); this.host = { totalMemMb: Math.floor(os.totalmem() / 1048576), cpus: os.cpus().length, ...host };
    this.base = path.join(root, 'ghost', 'vm'); this.runDirBase = runDirBase; this.startTimeoutMs = startTimeoutMs; this.stopWaitMs = stopWaitMs; this.diskRun = diskRun; this.now = now; this.flushMs = flushMs;
    this.assets = new Assets({ dir: path.join(this.base, 'assets'), fetchImpl, freeBytes });
    this.sys = { platform, arch };
    this.envBase = env || (platform === 'win32' ? { SystemRoot: process.env.SystemRoot || '', TEMP: process.env.TEMP || '', PATH: process.env.PATH || '' } : { PATH: process.env.PATH || '', LANG: 'C.UTF-8' });
    this.emit = emit;                                  // (owner, name, payload): terminal output events, set by the window
    this.mode = 'tor'; this.state = 'unknown'; this.error = ''; this.caseId = 'default';
    this.accel = null; this.slowOk = false; this.installInfo = null; this.download = null; this.abort = null;
    this.proc = null; this.agent = null; this.gateway = null; this.run = null; this.startP = null; this.stopP = null; this.sessions = new Map();
    this.bootLog = ''; this.errLog = ''; this.resolver = resolver || createResolver({ fetchImpl, provider: dnsProvider });
    this.dnsProvider = dnsProvider; this.shareInfo = null; this.res = null; this.diskInfo = null; this.toolsInfo = { present: false, encrypted: false }; this.snaps = [];
    this.lastBlockPush = 0;
    this.settingsFile = path.join(this.base, 'settings.json'); this.settings = this._readSettings();
  }
  _readSettings() {
    try { const d = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); if (d && d.v === 1) return { memMb: d.memMb, cpus: d.cpus, diskGb: d.diskGb }; } catch { /* defaults */ }
    return {};
  }
  // Resource caps. They apply the next time the machine starts; the disk size only when a disk is made (after a reset).
  setResources({ memMb, cpus, diskGb } = {}) {
    const okInt = (v, lo, hi) => v === undefined || (Number.isInteger(v) && v >= lo && v <= hi);
    if (!okInt(memMb, MIN.memMb, MAX.memMb) || !okInt(cpus, MIN.cpus, MAX.cpus) || !okInt(diskGb, 4, 64)) return { ok: false, code: 'bad-input', error: 'Memory is ' + MIN.memMb + ' to ' + MAX.memMb + ' MB, processors ' + MIN.cpus + ' to ' + MAX.cpus + ', disk 4 to 64 GB.' };
    this.settings = { ...this.settings, ...(memMb !== undefined ? { memMb } : {}), ...(cpus !== undefined ? { cpus } : {}), ...(diskGb !== undefined ? { diskGb } : {}) };
    fs.mkdirSync(this.base, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.settingsFile + '.tmp', JSON.stringify({ v: 1, ...this.settings }), { mode: 0o600 }); fs.renameSync(this.settingsFile + '.tmp', this.settingsFile);
    this.push(true);
    return { ok: true, settings: this.settings, appliesOnNextStart: true };
  }

  // ---------------------------------------------------------------- status
  async refresh() {
    if (this.state === 'downloading' || this.state === 'starting' || this.state === 'running' || this.state === 'stopping') return this.status();
    const st = await this.assets.status(this.index, this.sys);
    this.installInfo = st;
    this.state = st.installed ? 'stopped' : 'not-installed';
    return this.status();
  }
  routeInfo() {
    if (this.mode === 'none') return { mode: 'none', label: 'Off', detail: 'No network', exposesIp: false, tone: 'ok' };
    const torState = this.tor ? this.tor.state && this.tor.state.status : 'off';
    const p = route.plan({ mode: this.mode, socksPort: this.mode === 'tor' ? 1 : 0, provider: this.dnsProvider });
    const down = this.mode === 'tor' && torState !== 'ready';
    return { mode: this.mode, label: p.routeLabel, detail: p.dnsLabel, exposesIp: p.exposesIp, tone: down ? 'bad' : p.mode === 'tor' ? 'ok' : 'warn', torDown: down, text: down ? 'Tor not connected: requests are blocked' : p.routeLabel + ' · ' + p.dnsLabel };
  }
  status() {
    const a = this.accel;
    return {
      state: this.state, error: this.error, caseId: this.caseId, guest: this.installInfo && this.installInfo.guest, version: this.installInfo && this.installInfo.version || '',
      installed: this.state !== 'not-installed' && this.state !== 'unknown', missing: this.installInfo && this.installInfo.missing || [], totalBytes: this.installInfo && this.installInfo.total || 0,
      notPublished: !!(this.installInfo && this.installInfo.code === 'not-published'), installNote: this.installInfo && this.installInfo.ok === false ? this.installInfo.error : '',
      download: this.download, accel: a ? { name: a.accel, label: a.label, fast: a.fast, hardware: a.hardware, notice: a.notice, tried: a.tried } : null,
      route: this.routeInfo(), gateway: this.gateway ? this.gateway.stats() : null, blocked: this.gateway ? this.gateway.blocked().slice(-20) : [],
      share: this.shareInfo, resources: this.res, disk: this.diskInfo, tools: this.toolsInfo, snapshots: this.snaps, agent: !!(this.agent && this.agent.ready), sessions: this.sessions.size,
      platform: this.platform, cases: this._cases(), settings: { ...this.settings },
    };
  }
  _set(state, extra = {}) { this.state = state; if (state !== 'error') this.error = ''; Object.assign(this, extra); this.push(); }
  push(force) { const t = this.now(); if (!force && t - this.lastBlockPush < 150) return; this.lastBlockPush = t; try { this.notify('vm', this.status()); } catch { /* window gone */ } }

  // ---------------------------------------------------------------- download
  async install() {
    if (this.state === 'downloading') return this.status();
    await this.refresh();
    if (this.state !== 'not-installed') return this.status();
    if (this.installInfo.ok === false) { this.error = this.installInfo.error; this.push(true); return { ok: false, code: this.installInfo.code, error: this.installInfo.error, status: this.status() }; }
    if (this.confirmDownload) {
      const mb = Math.ceil(this.installInfo.total / 1048576);
      const yes = await this.confirm({ kind: 'download', title: 'Download the Ghost virtual computer?', message: 'About ' + mb + ' MB will be downloaded from github.com, once.',
        detail: 'It is a separate program (QEMU) and a small Linux system image, not part of Mayfair. Every file is checked against a SHA-256 value listed in this app before it is used, and a file that does not match is deleted.\n\nThis download goes straight from your computer to GitHub, so GitHub sees your IP address. No case data is involved. After that the virtual computer starts without downloading anything.', ok: 'Download', cancel: 'Cancel' });
      if (!yes) return { ok: false, code: 'declined', error: 'Cancelled.', status: this.status() };
    }
    this.abort = new AbortController();
    this._set('downloading', { download: { item: '', received: 0, size: 0, doneBytes: 0, total: this.installInfo.total } });
    try {
      await this.assets.install(this.index, this.sys, { signal: this.abort.signal, onProgress: (p) => { this.download = p; this.push(); } });
      this.download = null; this.state = 'unknown'; await this.refresh();
      return { ok: true, status: this.status() };
    } catch (e) {
      this.download = null; this.state = 'not-installed'; this.error = e.message; this.push(true);
      return { ok: false, code: e.code || 'error', error: e.message, status: this.status() };
    } finally { this.abort = null; }
  }
  cancelInstall() { if (this.abort) this.abort.abort(); return { ok: true }; }

  // ---------------------------------------------------------------- start
  async start({ caseId = this.caseId } = {}) {
    if (this.state === 'running' && caseId === this.caseId) return { ok: true, status: this.status() };
    if (this.startP) return this.startP;
    if (this.state === 'running' || this.state === 'stopping') await this.stop();
    this.startP = this._start(caseId).then((r) => r, (e) => this._startFailed(e)).finally(() => { this.startP = null; });
    return this.startP;
  }
  _startFailed(e) {
    this._teardown();
    this.state = 'stopped'; this.error = e.message || 'The virtual computer did not start.'; this.push(true);
    return { ok: false, code: e.code || 'error', error: this.error, status: this.status() };
  }
  async ensureRunning() {
    if (this.state === 'running' && this.agent && this.agent.ready) return;
    if (this.startP) { const r = await this.startP; if (!r.ok) throw new VmError(r.code, r.error); return; }
    await this.refresh();
    if (this.state === 'not-installed') throw new VmError('not-installed', 'The virtual computer is not downloaded yet. Open the Ghost terminal and choose "Download the virtual computer".');
    if (this.state === 'stopped') { const r = await this.start(); if (!r.ok) throw new VmError(r.code, r.error); return; }
    throw new VmError('busy', 'The virtual computer is busy (' + this.state + ').');
  }

  async _detectAccel(paths) {
    if (this.accel) return this.accel;
    const probe = P.qemuProbe(paths.qemu, { spawnImpl: this.spawn, env: this.envBase });
    const sysctl = async (k) => new Promise((res) => require('node:child_process').execFile('sysctl', ['-n', k], (e, o) => res(e ? '' : o)));
    this.accel = await P.detectAccel({ platform: this.platform, arch: this.arch, probe, hint: this.accelHint || ((a) => P.hostHint(a, { platform: this.platform, sysctl })) });
    return this.accel;
  }
  _listen(runDir, name) {
    return new Promise((resolve, reject) => {
      const srv = net.createServer(); let sock = null; let onConn = () => {};
      srv.on('error', reject);
      srv.on('connection', (s) => { if (sock) { s.destroy(); return; } sock = s; srv.close(); onConn(s); });
      const done = () => resolve({ srv, spec: this.platform === 'win32' ? { port: srv.address().port } : { path: path.join(runDir, name + '.sock') }, onConnection: (f) => { onConn = f; if (sock) f(sock); }, socket: () => sock });
      if (this.platform === 'win32') srv.listen(0, '127.0.0.1', done); else srv.listen(path.join(runDir, name + '.sock'), done);
    });
  }

  async _start(caseId) {
    if (!CASE_RE.test(String(caseId))) throw new VmError('bad-input', 'Case id must be 1 to 40 letters, digits, - or _.');
    this.caseId = caseId; this.error = ''; this.bootLog = ''; this.errLog = '';
    this._set('starting');
    const st = await this.assets.status(this.index, this.sys);
    this.installInfo = st;
    if (!st.installed) { this.state = st.ok === false ? 'not-installed' : 'not-installed'; throw new VmError(st.code || 'not-installed', st.ok === false ? st.error : 'The virtual computer is not downloaded, or a file changed and failed its check (' + (st.missing || []).join(', ') + '). Download it again.'); }
    const paths = st.paths;
    const accel = await this._detectAccel(paths);
    if (!accel.supported) throw new VmError('unsupported', accel.notice);
    if (!accel.fast && !this.slowOk) {
      const yes = await this.confirm({ kind: 'slow', title: 'Start in slow mode?', message: 'This computer cannot accelerate the virtual computer.', detail: accel.notice, ok: 'Start anyway', cancel: 'Cancel' });
      if (!yes) throw new VmError('declined', 'Cancelled.');
      this.slowOk = true;
    }
    const res = resources({ memMb: this.settings.memMb, cpus: this.settings.cpus, hostMemMb: this.host.totalMemMb, hostCpus: this.host.cpus });
    this.res = { ...res, diskGb: this.settings.diskGb || 16 };
    // share and disks
    const shareDir = ensureShare(this.base, caseId);
    const mode = shareMode(this.platform);
    this.shareInfo = { dir: shareDir, mode, readOnly: false, experimental: mode === 'fat' };
    const mkDisk = (id, dir, keyName) => new VmDisk({ caseId: id, dir, vault: this.vault, qemuImg: () => paths.qemuImg, platform: this.platform, run: this.diskRun, env: this.envBase, keyName, runDirBase: path.join(this.base, '.run') });
    const disk = this.disk = mkDisk(caseId, path.join(this.base, 'cases', caseId), null);
    const tools = this.toolsDisk = mkDisk('tools', path.join(this.base, 'tools'), 'vmkey-tools');
    const baseId = this.index.images[st.guest].disk.sha256;
    for (const [d, base, gb] of [[disk, paths.disk, this.res.diskGb], [tools, null, 16]]) {
      try { await d.ensure({ baseDisk: base, baseId: base ? baseId : undefined, sizeGb: gb }); } catch (e) {
        if (e.code !== 'vault-unavailable') throw e;
        const yes = await this.confirm({ kind: 'plain-disk', title: 'Store the disk without encryption?', message: 'The Ghost vault is not available, so the virtual disk cannot be encrypted.', detail: 'The disk would be an ordinary file on this computer. Unlock or set up the Ghost vault to encrypt it. The shared folder is never encrypted.', ok: 'Continue without encryption', cancel: 'Cancel' });
        if (!yes) throw new VmError('declined', 'Cancelled.');
        await d.ensure({ baseDisk: base, baseId: base ? baseId : undefined, sizeGb: gb, allowPlain: true });
      }
    }
    this.diskInfo = { encrypted: disk.encrypted(), note: disk.encrypted() ? 'Encrypted with your Ghost vault key. The shared folder is not encrypted.' : 'Not encrypted (the vault was not available when this disk was made).' };
    this.toolsInfo = { present: true, encrypted: tools.encrypted() };
    this.snaps = await disk.snapshots().catch(() => []);
    // keys: delivered by inherited descriptor, never in the command line
    const rootKey = disk.key(), toolsKey = tools.key();
    const keys = [rootKey, toolsKey].filter(Boolean);
    const runDir = fs.mkdtempSync(path.join(this.runDirBase, 'mfvm-'));
    const token = crypto.randomBytes(24).toString('hex');
    const agentCh = await this._listen(runDir, 'agent'), netCh = await this._listen(runDir, 'net');
    const run = this.run = { runDir, delivery: null, agentCh, netCh, token, closing: false, exited: false };
    this.agent = new AgentClient({ token });
    this.gateway = new EgressGateway({ getMode: () => this.mode, getTor: () => ({ ready: !!(this.tor && this.tor.ready), socksPort: this.tor && this.tor.state ? this.tor.state.socksPort : 0 }), resolver: this.resolver });
    this.gateway.on('block', () => this.push());
    agentCh.onConnection((s) => this.agent.attach(s));
    netCh.onConnection((s) => this.gateway.attach(s));
    const hello = new Promise((resolve, reject) => { this.agent.once('hello', resolve); run.rejectHello = reject; });
    hello.catch(() => {});

    const launch = (sandbox) => {
      const delivery = run.delivery = keyDelivery({ platform: this.platform, keys, runDir });
      let ki = 0; const keyFiles = { root: rootKey ? delivery.fileArgs[ki++] : null, tools: toolsKey ? delivery.fileArgs[ki++] : null };
      const dataDir = path.join(paths.qdir, 'share', 'qemu');
      const argv = buildArgv({ platform: this.platform, guest: st.guest, dataDir: fs.existsSync(dataDir) ? dataDir : null, accel: accel.accel, memMb: res.memMb, cpus: res.cpus, kernel: paths.kernel, initrd: paths.initrd, baseDisk: paths.disk, overlay: disk.overlay,
        keyFiles, toolsDisk: tools.overlay, share: { dir: shareDir, mode, readOnly: false }, token, channels: { agent: agentCh.spec, net: netCh.spec }, sandbox });
      const bad = selfCheck(argv);
      if (bad.length) throw new VmError('argv-check', 'The machine command line contains something the design rules out (' + bad.join(', ') + '), so it was not started.');
      this.lastArgv = argv;
      const p = this.spawn(paths.qemu, argv, { shell: false, windowsHide: true, cwd: runDir, env: this.envBase, stdio: delivery.stdio, detached: this.platform !== 'win32' });
      this.proc = p; run.sandbox = sandbox;
      if (this.platform !== 'win32') { delivery.cleanup(); run.keyCleaned = true; }       // the child holds its own copies of the descriptors; Windows removes the file after hello
      p.stdout && p.stdout.on('data', (d) => { this.bootLog = (this.bootLog + d).slice(-LOG_MAX); });
      p.stderr && p.stderr.on('data', (d) => { this.errLog = (this.errLog + d).slice(-8192); });
      p.on('error', (e) => { this.errLog += 'cannot start: ' + (e.code || e.message); this._exited(p, null); });
      p.on('close', (code) => this._exited(p, code));
      return p;
    };
    this._launch = launch;
    launch(this.platform === 'linux');
    const limit = this.startTimeoutMs || (accel.fast ? 120000 : 600000);
    const timer = setTimeout(() => run.rejectHello(new VmError('start-timeout', 'The virtual computer did not report in within ' + Math.round(limit / 1000) + ' seconds.' + (accel.fast ? '' : ' Software emulation is slow: try again and wait longer.'))), limit); if (timer.unref) timer.unref();
    this.agent.on('refused', () => { this.errLog += 'a connection with the wrong token was refused\n'; });
    try { await hello; } finally { clearTimeout(timer); if (!run.keyCleaned && run.delivery) { run.delivery.cleanup(); run.keyCleaned = true; } }
    // inside: shared folder, tools disk
    const notes = [];
    try { await this.agent.mount(mode === 'fat' ? 'fat' : '9p'); } catch (e) { notes.push('shared folder: ' + e.message); }
    try { await this.agent.mount('tools'); } catch (e) { notes.push('tools disk: ' + e.message); this.toolsInfo = { ...this.toolsInfo, mounted: false, error: e.message }; }
    this.agent.on('shell-data', (sid, b) => { const s = this.sessions.get(sid); if (s) this._out(s, b.toString('utf8')); });
    this.agent.on('shell-exit', (sid, code, signal) => { const s = this.sessions.get(sid); if (s) { this._flush(s); s.closed = true; this.sessions.delete(sid); this.emit(s.owner, 'exit', { id: sid, code: code === undefined ? null : code, signal: signal || null }); this.push(); } });
    this.agent.on('lost', () => { if (!run.closing) this.push(true); });
    this.state = 'running'; this.error = notes.join('; ');
    if (this.mode === 'tor') this._ensureTor();
    this.push(true);
    return { ok: true, status: this.status(), notes };
  }
  _ensureTor() { if (this.tor && this.tor.start && !(this.tor.state && this.tor.state.status === 'ready')) this.tor.start().then(() => this.push(true), () => this.push(true)); }

  _exited(p, code) {
    if (this.proc !== p) return;
    const run = this.run;
    if (run && !run.exited) {
      run.exited = true;
      const early = this.state === 'starting';
      if (early && run.sandbox && /seccomp|sandbox/i.test(this.errLog) && !run.retried) { run.retried = true; run.exited = false; this.errLog = ''; try { this._launch(false); return; } catch { /* fall through */ } }
      if (early && run.rejectHello) run.rejectHello(new VmError('qemu-exit', 'The QEMU program stopped while starting' + (code !== null ? ' (exit code ' + code + ')' : '') + (this.errLog.trim() ? ': ' + this.errLog.trim().split('\n')[0].slice(0, 200) : '.')));
    }
    if (!run || !run.closing) { const was = this.state; this._teardown(); if (was === 'running') { this.state = 'stopped'; this.error = 'The virtual computer stopped' + (code ? ' (exit code ' + code + ')' : '') + '.'; } this.push(true); }
  }
  // Close everything that belongs to the running machine. Safe to call twice.
  _teardown() {
    const run = this.run; this.run = null;
    const proc = this.proc; this.proc = null;
    if (run) { run.closing = true; try { if (run.delivery) run.delivery.cleanup(); } catch { /* ignore */ } for (const c of [run.agentCh, run.netCh]) { try { c.srv.close(); } catch { /* closed */ } const s = c.socket(); if (s) try { s.destroy(); } catch { /* gone */ } } }
    if (this.agent) { try { this.agent.detach(); } catch { /* gone */ } this.agent = null; }
    if (this.gateway) { try { this.gateway.detach(); } catch { /* gone */ } this.gateway = null; }
    if (proc) killTree(proc, 300);
    if (run) { try { fs.rmSync(run.runDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    for (const s of [...this.sessions.values()]) { s.closed = true; this.emit(s.owner, 'exit', { id: s.id, code: null, signal: 'machine-stopped' }); }
    this.sessions.clear();
    if (this.releaseTor) { try { this.releaseTor(); } catch { /* owner decides */ } }
  }

  // ---------------------------------------------------------------- stop, kill
  async stop() {
    if (this.stopP) return this.stopP;
    if (!this.proc) { if (this.state !== 'not-installed') this.state = 'stopped'; return { ok: true }; }
    this.stopP = (async () => {
      this._set('stopping');
      const p = this.proc, run = this.run; if (run) run.closing = true;
      if (this.agent && this.agent.ready) this.agent.poweroff();
      await new Promise((resolve) => { let done = false; const fin = () => { if (!done) { done = true; clearTimeout(t); resolve(); } }; const t = setTimeout(fin, this.stopWaitMs); if (t.unref) t.unref(); p.once('close', fin); if (p.exitCode !== null && p.exitCode !== undefined) fin(); });
      this._teardown(); this.state = 'stopped'; this.push(true);
      return { ok: true };
    })().finally(() => { this.stopP = null; });
    return this.stopP;
  }
  // Immediate. Part of the Ghost kill switch. The disk stays; with the vault locked it cannot be read.
  async kill() {
    const was = !!this.proc || this.state === 'starting';
    if (this.abort) this.abort.abort();
    if (this.run) this.run.closing = true;
    if (this.run && this.run.rejectHello) this.run.rejectHello(new VmError('killed', 'Stopped by the kill switch.'));
    this._teardown();
    if (this.tor && this.tor.stop) { try { this.tor.stop(); } catch { /* stopped */ } }       // the kill switch always drops the Tor circuits
    if (this.state !== 'not-installed' && this.state !== 'unknown') this.state = 'stopped';
    this.push(true);
    return { ok: true, vm: true, wasRunning: was };
  }
  shutdown() { return this.kill(); }

  // ---------------------------------------------------------------- the case this machine belongs to
  // Each case has its own disk and its own shared folder. Changing case stops the machine (after a native question when terminals are open)
  // and the next start uses the other case's disk.
  async useCase(caseId) {
    if (!CASE_RE.test(String(caseId))) return { ok: false, code: 'bad-input', error: 'Case id must be 1 to 40 letters, digits, - or _.' };
    if (caseId === this.caseId) return { ok: true, status: this.status() };
    if (this.proc || this.state === 'starting') {
      if (this.sessions.size) {
        const yes = await this.confirm({ kind: 'switch-case', title: 'Switch the virtual computer to another case?', message: 'The virtual computer belongs to one case at a time.', detail: 'Open terminals close and the machine restarts with the disk and shared folder of the other case. Nothing is deleted.', ok: 'Switch', cancel: 'Cancel' });
        if (!yes) return { ok: false, code: 'declined', error: 'Cancelled.' };
      }
      await this.stop();
    }
    this.caseId = caseId; this.shareInfo = null; this.diskInfo = null; this.snaps = []; this.push(true);
    return { ok: true, status: this.status() };
  }
  _cases() { try { return fs.readdirSync(path.join(this.base, 'cases'), { withFileTypes: true }).filter((e) => e.isDirectory() && CASE_RE.test(e.name)).map((e) => e.name).sort().slice(0, 200); } catch { return []; } }

  // ---------------------------------------------------------------- network
  async setNetwork(mode, { confirmed = false } = {}) {
    if (!ROUTES.includes(mode)) return { ok: false, code: 'bad-input', error: 'Unknown route.' };
    if (mode === this.mode) return { ok: true, status: this.status() };
    if (mode === 'direct-doh' && !confirmed) {
      const yes = await this.confirm({ kind: 'direct', title: 'Connect without Tor?', message: 'The virtual computer will connect directly from your computer.', detail: 'Websites and your network will see your real IP address. Name lookups go to one encrypted DNS server (DNS over HTTPS) instead of your own resolver. Programs that ignore proxy settings, and anything that is not TCP, still cannot connect. Use Tor if you can.', ok: 'Connect directly', cancel: 'Cancel' });
      if (!yes) return { ok: false, code: 'declined', error: 'Cancelled.' };
    }
    this.mode = mode;
    if (this.gateway) this.gateway.closeAll();                     // open connections end so nothing keeps using the old route
    if (mode === 'tor' && this.state === 'running') this._ensureTor();
    this.push(true);
    return { ok: true, status: this.status() };
  }

  // ---------------------------------------------------------------- reset, snapshots, tools disk
  async _withStopped(fn, { restart = true } = {}) {
    const wasRunning = this.state === 'running'; const caseId = this.caseId;
    if (wasRunning || this.proc) await this.stop();
    try { return await fn(); } finally { if (wasRunning && restart) await this.start({ caseId }); }
  }
  _diskFor(caseId) {
    return new VmDisk({ caseId, dir: path.join(this.base, 'cases', caseId), vault: this.vault, qemuImg: () => this.installInfo.paths.qemuImg, platform: this.platform, run: this.diskRun, env: this.envBase, runDirBase: path.join(this.base, '.run') });
  }
  async reset() {
    const yes = await this.confirm({ kind: 'reset', title: 'Reset the virtual computer?', message: 'This erases the virtual computer\'s disk for case "' + this.caseId + '" and goes back to the clean image.', detail: 'Everything installed or saved inside it (except the tools disk and the shared folder) is deleted, including snapshots. The shared folder and the tools disk are kept.', ok: 'Reset', cancel: 'Cancel' });
    if (!yes) return { ok: false, code: 'declined', error: 'Cancelled.' };
    const caseId = this.caseId;
    await this._withStopped(async () => { this._diskFor(caseId).reset(); this.snaps = []; this.diskInfo = null; });
    return { ok: true, status: this.status() };
  }
  async snapshot(name) {
    await this.refresh(); if (!this.installInfo.installed) return { ok: false, code: 'not-installed', error: 'Not installed.' };
    try { await this._withStopped(() => this._diskFor(this.caseId).snapshot(name)); this.snaps = await this._diskFor(this.caseId).snapshots(); this.push(true); return { ok: true, snapshots: this.snaps }; } catch (e) { return { ok: false, code: e.code || 'error', error: e.message }; }
  }
  async restore(name) {
    const yes = await this.confirm({ kind: 'restore', title: 'Restore snapshot "' + String(name).slice(0, 40) + '"?', message: 'The disk goes back to how it was when the snapshot was taken.', detail: 'Changes made since then are lost. The shared folder is not touched.', ok: 'Restore', cancel: 'Cancel' });
    if (!yes) return { ok: false, code: 'declined', error: 'Cancelled.' };
    try { await this._withStopped(() => this._diskFor(this.caseId).restore(name)); return { ok: true }; } catch (e) { return { ok: false, code: e.code || 'error', error: e.message }; }
  }
  async deleteSnapshot(name) { try { await this._withStopped(() => this._diskFor(this.caseId).delete(name), { restart: false }); this.snaps = await this._diskFor(this.caseId).snapshots(); this.push(true); return { ok: true, snapshots: this.snaps }; } catch (e) { return { ok: false, code: e.code || 'error', error: e.message }; } }
  async listSnapshots() { try { await this.refresh(); if (!this.installInfo.installed) return []; this.snaps = await this._diskFor(this.caseId).snapshots(); return this.snaps; } catch { return []; } }
  async wipeTools() {
    const yes = await this.confirm({ kind: 'wipe-tools', title: 'Wipe the tools disk?', message: 'This deletes every tool kept inside the virtual computer.', detail: 'Tools you added to Ghost live on this separate disk so they survive a reset. Wiping removes their files and environments; connectors you registered stay listed but cannot run until you add the tools again.', ok: 'Wipe tools', cancel: 'Cancel' });
    if (!yes) return { ok: false, code: 'declined', error: 'Cancelled.' };
    await this._withStopped(async () => { const d = new VmDisk({ caseId: 'tools', keyName: 'vmkey-tools', dir: path.join(this.base, 'tools'), vault: this.vault, qemuImg: () => this.installInfo.paths.qemuImg, platform: this.platform, run: this.diskRun, env: this.envBase }); d.reset(); this.toolsInfo = { present: false, encrypted: false }; });
    return { ok: true };
  }

  // ---------------------------------------------------------------- commands for other parts of Ghost (argv only)
  async runArgv(argv, opts = {}) { await this.ensureRunning(); return this.agent.run({ argv, ...opts }); }
  execStream(argv, opts) { return this.agent.startArgv({ argv, ...opts }); }

  // ---------------------------------------------------------------- terminals (same surface as TerminalService)
  info() { return { mode: 'vm', shell: 'sh', platform: this.platform, vm: this.status() }; }
  async open(owner, { cols = 100, rows = 30 } = {}) {
    if (!int(cols, LIMITS.cols) || !int(rows, LIMITS.rows)) throw new Error('blocked: bad size');
    if (this.sessions.size >= LIMITS.sessions) throw new Error('too many terminals are open (' + LIMITS.sessions + ')');
    await this.ensureRunning();
    const id = crypto.randomBytes(8).toString('hex');
    const s = { id, owner, buf: '', timer: null, unacked: 0, paused: false, closed: false };
    this.sessions.set(id, s);
    try { await this.agent.shell(id, { cols, rows, cwd: this.shareInfo ? '/home/ghost' : undefined }); } catch (e) { this.sessions.delete(id); throw new Error('Could not start a terminal: ' + e.message); }
    this.push();
    return { id, mode: 'vm', shell: 'sh', cols, rows, pid: 0 };
  }
  _get(owner, id) { const s = typeof id === 'string' ? this.sessions.get(id) : null; if (!s || s.owner !== owner) throw new Error('blocked: no such terminal'); return s; }
  _out(s, d) { s.buf += d; if (s.buf.length >= LIMITS.chunk) return this._flush(s); if (!s.timer) { s.timer = setTimeout(() => this._flush(s), this.flushMs); if (s.timer.unref) s.timer.unref(); } }
  _flush(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    while (s.buf) { const part = s.buf.slice(0, LIMITS.chunk); s.buf = s.buf.slice(part.length); s.unacked += part.length; this.emit(s.owner, 'data', { id: s.id, data: part }); }
    if (!s.paused && s.unacked > LIMITS.high && this.agent) { s.paused = true; this.agent.pause(s.id); }
  }
  input(owner, id, data) { const s = this._get(owner, id); if (typeof data !== 'string' || data.length > LIMITS.input) throw new Error('blocked: bad input'); this.agent.write(s.id, data); }
  resize(owner, id, cols, rows) { const s = this._get(owner, id); if (!int(cols, LIMITS.cols) || !int(rows, LIMITS.rows)) throw new Error('blocked: bad size'); this.agent.resize(s.id, cols, rows); }
  interrupt(owner, id) { const s = this._get(owner, id); this.agent.write(s.id, '\x03'); }
  ack(owner, id, n) {
    const s = this._get(owner, id);
    if (!Number.isInteger(n) || n < 0 || n > 1 << 30) throw new Error('blocked: bad ack');
    s.unacked = Math.max(0, s.unacked - n);
    if (s.paused && s.unacked < LIMITS.low && this.agent) { s.paused = false; this.agent.resume(s.id); }
  }
  close(owner, id) { const s = this._get(owner, id); if (this.agent) this.agent.closeShell(s.id); }
  closeOwner(owner) { for (const s of [...this.sessions.values()]) if (s.owner === owner && this.agent) this.agent.closeShell(s.id); }
  count() { return this.sessions.size; }
  getBootLog() { return { boot: this.bootLog.slice(-16384), errors: this.errLog }; }
  planInfo() { return plan(this.index, this.sys); }
}

module.exports = { VmService, LIMITS, ROUTES };
