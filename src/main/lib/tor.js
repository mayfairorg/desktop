'use strict';
// Runs the open-source Tor daemon (BSD-3-Clause, see assets/licenses/TOR-NOTICE.txt) as a local
// SOCKS5 proxy. The tab that uses it never falls back to a direct connection: if Tor is not
// ready, the tab is not created.
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

function torrc({ socksPort, controlPort, dataDir, cookieFile }) {
  return [
    `SocksPort 127.0.0.1:${socksPort} IsolateClientAddr IsolateSOCKSAuth`,
    `ControlPort 127.0.0.1:${controlPort}`,
    'CookieAuthentication 1',
    `CookieAuthFile ${cookieFile}`,
    `DataDirectory ${dataDir}`,
    'ClientOnly 1', 'AvoidDiskWrites 1', 'SafeLogging 1', 'DisableDebuggerAttachment 1',
    'Log notice stdout', '',
  ].join('\n');
}
const parseBootstrap = (line) => { const m = /Bootstrapped (\d{1,3})%(?: \(([a-z_]+)\))?/.exec(line); return m ? { pct: Math.min(100, +m[1]), tag: m[2] || '' } : null; };
const newnymCommands = (cookieHex) => `AUTHENTICATE ${cookieHex}\r\nSIGNAL NEWNYM\r\nQUIT\r\n`;
// control replies: "250 OK" lines; anything starting 4xx/5xx is a failure
const controlOk = (reply) => { const codes = String(reply).split(/\r?\n/).filter(Boolean).map((l) => l.slice(0, 3)); return codes.length >= 2 && codes.filter((c) => c === '250').length >= 2 && !codes.some((c) => /^[45]/.test(c)); };
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

function binaryPath({ resourcesPath, root, platform = process.platform, arch = process.arch, exists = fs.existsSync }) {
  const exe = platform === 'win32' ? 'tor.exe' : 'tor';
  const plat = platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux';
  const c = [resourcesPath && path.join(resourcesPath, 'tor', 'tor', exe), resourcesPath && path.join(resourcesPath, 'tor', exe), root && path.join(root, 'vendor', 'tor', `${plat}-${arch}`, 'tor', exe), root && path.join(root, 'vendor', 'tor', `${plat}-${arch}`, exe), process.env.MAYFAIR_TOR_BIN].filter(Boolean);
  return c.find((p) => exists(p)) || null;
}

class TorManager extends EventEmitter {
  constructor({ binary, tmpBase = os.tmpdir(), timeoutMs = 120000 }) {
    super();
    this.binary = binary; this.tmpBase = tmpBase; this.timeoutMs = timeoutMs;
    this.state = { status: 'off', progress: 0, error: '', socksPort: 0 };
    this.proc = null; this.dir = null; this.controlPort = 0; this.starting = null;
  }
  _set(p) { Object.assign(this.state, p); this.emit('state', { ...this.state }); }
  get ready() { return this.state.status === 'ready'; }
  start() {
    if (this.ready) return Promise.resolve(this.state.socksPort);
    if (this.starting) return this.starting;
    if (!this.binary) { this._set({ status: 'error', error: 'Tor is not included in this build.' }); return Promise.reject(new Error(this.state.error)); }
    this.starting = this._start().finally(() => { this.starting = null; });
    return this.starting;
  }
  async _start() {
    this._set({ status: 'starting', progress: 0, error: '' });
    const socksPort = await freePort(); const controlPort = await freePort();
    this.controlPort = controlPort;
    this.dir = fs.mkdtempSync(path.join(this.tmpBase, 'mayfair-tor-'));
    const dataDir = path.join(this.dir, 'data'); fs.mkdirSync(dataDir, { mode: 0o700 });
    this.cookieFile = path.join(this.dir, 'control_auth_cookie');
    const rc = path.join(this.dir, 'torrc'); fs.writeFileSync(rc, torrc({ socksPort, controlPort, dataDir, cookieFile: this.cookieFile }));
    return new Promise((resolve, reject) => {
      let done = false;
      const fail = (msg) => { if (done) return; done = true; clearTimeout(timer); this._cleanup(); this._set({ status: 'error', error: msg, progress: 0, socksPort: 0 }); reject(new Error(msg)); };
      const timer = setTimeout(() => { this._kill(); fail('Tor did not connect in time. Your network may block it.'); }, this.timeoutMs);
      if (timer.unref) timer.unref();
      const p = spawn(this.binary, ['-f', rc], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: path.dirname(this.binary) });
      this.proc = p;
      let buf = '';
      p.stdout.on('data', (d) => {
        buf += d; let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          const b = parseBootstrap(line);
          if (b) { this._set({ progress: b.pct }); if (b.pct >= 100 && !done) { done = true; clearTimeout(timer); this._set({ status: 'ready', progress: 100, socksPort }); resolve(socksPort); } }
        }
      });
      p.on('error', (e) => fail('Could not start Tor: ' + e.message));
      p.on('exit', (code) => { const was = this.state.status; this.proc = null; if (!done) fail('Tor stopped (code ' + code + ').'); else { this._cleanup(); this._set({ status: 'off', progress: 0, socksPort: 0 }); if (was === 'ready') this.emit('exit'); } });
    });
  }
  // A fresh circuit for new connections. Needs the control cookie Tor wrote.
  newIdentity() {
    return new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error('Tor is not running'));
      let cookie; try { cookie = fs.readFileSync(this.cookieFile).toString('hex'); } catch { return reject(new Error('Tor control cookie missing')); }
      const s = net.connect(this.controlPort, '127.0.0.1'); let out = '';
      s.on('connect', () => s.write(newnymCommands(cookie)));
      s.on('data', (d) => { out += d; });
      s.on('close', () => (controlOk(out) ? resolve(true) : reject(new Error('Tor refused the request'))));
      s.on('error', (e) => reject(e));
      s.setTimeout(8000, () => { s.destroy(); reject(new Error('Tor control timed out')); });
    });
  }
  _kill() { if (this.proc) { try { this.proc.kill('SIGTERM'); } catch { /* gone */ } } }
  _cleanup() { if (this.dir) { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ } this.dir = null; } }
  stop() { this._kill(); if (!this.proc) { this._cleanup(); this._set({ status: 'off', progress: 0, socksPort: 0, error: '' }); } }
}
module.exports = { TorManager, torrc, parseBootstrap, newnymCommands, controlOk, binaryPath, freePort };
