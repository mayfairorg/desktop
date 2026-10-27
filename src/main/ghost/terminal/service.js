'use strict';
// Ghost terminal: the session manager. It starts shells and moves bytes. It has no call that takes a command: the only way text
// reaches a shell is input(), and the window module only forwards input() from the terminal window's own page.
// Free of Electron so it can be tested; electron pieces (dialog, windows, ipc) are in window.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildEnv } = require('./env');
const { pickShell } = require('./shell');
const { toolDirs, ensureToolsDir, listTools, which, probe } = require('./tools');
const { createBackend, probePython, loadPty } = require('./backend');

const LIMITS = { sessions: 8, input: 64 * 1024, chunk: 64 * 1024, flushMs: 8, high: 1024 * 1024, low: 256 * 1024, cols: [10, 500], rows: [2, 200] };
const int = (v, [lo, hi]) => Number.isInteger(v) && v >= lo && v <= hi;

class TerminalService {
  // root: the userData folder. baseEnv: environment to start shells from. emit(ownerId, name, payload): output events to the owner's window.
  // mode: force 'pty' | 'python' | 'basic' (tests, support); default is the best that works.
  constructor({ root, terms, baseEnv = process.env, platform = process.platform, home = os.homedir(), emit = () => {}, mode = null, pty = undefined, exists = fs.existsSync, flushMs = LIMITS.flushMs } = {}) {
    this.root = root; this.terms = terms; this.baseEnv = baseEnv; this.platform = platform; this.home = home; this.emit = emit;
    this.forcedMode = ['pty', 'python', 'basic'].includes(mode) ? mode : null; this.exists = exists; this.flushMs = flushMs;
    this.toolsDir = path.join(root, 'ghost', 'tools');
    this.ptyMod = pty === undefined ? undefined : pty;       // undefined: load lazily; null: none
    this.python = undefined;                                  // undefined: not probed yet
    this.sessions = new Map();
  }

  _pty() { if (this.ptyMod === undefined) this.ptyMod = loadPty(); return this.ptyMod; }
  async _python() {
    if (this.python !== undefined) return this.python;
    const pathValue = this._env('pty').PATH || '';
    const cand = ['python3', 'python'].map((n) => which(n, pathValue, this.platform, this.exists)).filter(Boolean);
    this.python = null;
    for (const c of cand) if (await probePython(c, this._env('pty'))) { this.python = c; break; }
    return this.python;
  }
  _env(mode) {
    return buildEnv(this.baseEnv, { platform: this.platform, home: this.home, toolsDir: this.toolsDir, toolDirs: toolDirs(this.toolsDir), mode, exists: this.exists });
  }

  async available() {
    if (this.forcedMode) return this.forcedMode;
    if (this._pty()) return 'pty';
    return (await this._python()) ? 'python' : 'basic';
  }

  // What the window shows in its footer: how the terminal works here, which tools were found (by looking, not running), the tools folder.
  async info() {
    ensureToolsDir(this.toolsDir);
    const mode = await this.available();
    const env = this._env(mode === 'basic' ? 'basic' : 'pty');
    const sh = pickShell({ platform: this.platform, env, mode: mode === 'basic' ? 'basic' : 'pty', exists: this.exists });
    return { mode, shell: sh.name, platform: this.platform, toolsDir: this.toolsDir, tools: listTools(this.toolsDir, this.platform), programs: probe(env.PATH || env.Path || '', this.platform, this.exists), accepted: this.terms.accepted() };
  }

  async open(owner, { cols = 100, rows = 30 } = {}) {
    if (!this.terms.accepted()) throw new Error('blocked: the first-use notice has not been accepted');
    if (!int(cols, LIMITS.cols) || !int(rows, LIMITS.rows)) throw new Error('blocked: bad size');
    if (this.sessions.size >= LIMITS.sessions) throw new Error('too many terminals are open (' + LIMITS.sessions + ')');
    ensureToolsDir(this.toolsDir);
    const mode = await this.available();
    const plan = (m) => { const env = this._env(m); const sh = pickShell({ platform: this.platform, env, mode: m, exists: this.exists }); return { env, sh, file: sh.file, args: sh.args }; };
    const main = plan(mode === 'basic' ? 'basic' : 'pty'), basic = plan('basic');
    const cwd = this.exists(this.home) ? this.home : (this.platform === 'win32' ? undefined : '/');
    const b = createBackend({ pty: mode === 'pty' ? this._pty() : null, python: mode === 'basic' ? null : await this._python(), allowed: this.forcedMode ? [this.forcedMode] : ['pty', 'python', 'basic'],
      file: main.file, args: main.args, cwd, env: main.env, basic: { file: basic.file, args: basic.args, env: basic.env }, cols, rows });
    const sh = b.mode === 'basic' ? basic.sh : main.sh;
    const id = crypto.randomBytes(8).toString('hex');
    const s = { id, owner, b, buf: '', timer: null, unacked: 0, paused: false, closed: false };
    this.sessions.set(id, s);
    b.on('data', (d) => this._out(s, d));
    b.on('exit', (e) => { this._flush(s); s.closed = true; this.sessions.delete(id); this.emit(owner, 'exit', { id, code: e.code, signal: e.signal }); });
    return { id, mode: b.mode, shell: sh.name, cols, rows, pid: b.pid };
  }

  _get(owner, id) {
    const s = typeof id === 'string' ? this.sessions.get(id) : null;
    if (!s || s.owner !== owner) throw new Error('blocked: no such terminal');
    return s;
  }
  _out(s, d) {
    s.buf += d;
    if (s.buf.length >= LIMITS.chunk) return this._flush(s);
    if (!s.timer) { s.timer = setTimeout(() => this._flush(s), this.flushMs); if (s.timer.unref) s.timer.unref(); }
  }
  _flush(s) {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    while (s.buf) {
      const part = s.buf.slice(0, LIMITS.chunk); s.buf = s.buf.slice(part.length);
      s.unacked += part.length;
      this.emit(s.owner, 'data', { id: s.id, data: part });
    }
    if (!s.paused && s.unacked > LIMITS.high) { s.paused = true; s.b.pause(); }
  }

  // The only way text reaches a shell. owner is the window that opened the terminal.
  input(owner, id, data) {
    const s = this._get(owner, id);
    if (typeof data !== 'string' || data.length > LIMITS.input) throw new Error('blocked: bad input');
    s.b.write(data);
  }
  resize(owner, id, cols, rows) {
    const s = this._get(owner, id);
    if (!int(cols, LIMITS.cols) || !int(rows, LIMITS.rows)) throw new Error('blocked: bad size');
    s.b.resize(cols, rows);
  }
  interrupt(owner, id) { return this._get(owner, id).b.interrupt(); }
  ack(owner, id, n) {
    const s = this._get(owner, id);
    if (!Number.isInteger(n) || n < 0 || n > 1 << 30) throw new Error('blocked: bad ack');
    s.unacked = Math.max(0, s.unacked - n);
    if (s.paused && s.unacked < LIMITS.low) { s.paused = false; s.b.resume(); }
  }
  close(owner, id) { const s = this._get(owner, id); s.b.kill(); }
  closeOwner(owner) { for (const s of [...this.sessions.values()]) if (s.owner === owner) s.b.kill(); }
  shutdown() { for (const s of [...this.sessions.values()]) s.b.kill(); }
  count() { return this.sessions.size; }
}

module.exports = { TerminalService, LIMITS };
