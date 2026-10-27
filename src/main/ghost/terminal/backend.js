'use strict';
// Ghost terminal: three ways to give the shell a terminal, best first. All three start the shell from an argv array with shell:false
// and none passes it a command.
//   pty     node-pty (optional dependency, native): a real terminal on every OS (ConPTY on Windows). Needs a prebuilt or compiled binary.
//   python  POSIX only, no native code: a few lines of Python's standard "pty" module give the shell a real terminal. Needs python3.
//   basic   pipes only: no terminal. Works everywhere, but full-screen programs and some prompts do not.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const PY_HELPER = fs.readFileSync(path.join(__dirname, 'pty-helper.py'), 'utf8');

class Backend extends EventEmitter {
  constructor(mode) { super(); this.mode = mode; this.pid = 0; this.exited = false; }
  _data(s) { if (s) this.emit('data', s); }
  _exit(code, signal) { if (this.exited) return; this.exited = true; this.emit('exit', { code: code === null || code === undefined ? null : code, signal: signal || null }); }
}

const killGroup = (pid, sig) => { try { process.kill(-pid, sig); return true; } catch { try { process.kill(pid, sig); return true; } catch { return false; } } };

class PtyBackend extends Backend {
  constructor(ptyMod, { file, args, cwd, env, cols, rows }) {
    super('pty');
    this.p = ptyMod.spawn(file, args, { name: env.TERM || 'xterm-256color', cols, rows, cwd, env });
    this.pid = this.p.pid;
    this.p.onData((d) => this._data(d));
    this.p.onExit((e) => this._exit(e.exitCode, e.signal ? String(e.signal) : null));
  }
  write(s) { if (!this.exited) this.p.write(s); }
  resize(c, r) { if (!this.exited) { try { this.p.resize(c, r); } catch { /* shell already gone */ } } }
  pause() { try { this.p.pause(); } catch { /* old node-pty */ } }
  resume() { try { this.p.resume(); } catch { /* old node-pty */ } }
  interrupt() { this.write('\x03'); return true; }
  kill() {
    if (this.exited) return;
    if (process.platform === 'win32') { try { this.p.kill(); } catch { /* gone */ } return; }
    killGroup(this.pid, 'SIGHUP');
    const t = setTimeout(() => killGroup(this.pid, 'SIGKILL'), 800); if (t.unref) t.unref();
    this.once('exit', () => clearTimeout(t));
  }
}

class PythonBackend extends Backend {
  constructor(python, { file, args, cwd, env, cols, rows }) {
    super('python');
    const c = spawn(python, ['-I', '-c', PY_HELPER, String(cols), String(rows), file, ...args], { cwd, env, shell: false, windowsHide: true, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    this.c = c; this.pid = c.pid || 0;
    c.stdout.setEncoding('utf8'); c.stdout.on('data', (d) => this._data(d));
    c.stderr.on('data', () => {});
    c.stdin.on('error', () => {}); c.stdio[3].on('error', () => {});
    c.on('error', () => this._exit(127, null));
    c.on('close', (code, sig) => this._exit(code, sig));
  }
  write(s) { if (!this.exited) this.c.stdin.write(s); }
  resize(cols, rows) { if (!this.exited) this.c.stdio[3].write(`R ${cols} ${rows}\n`); }
  pause() { this.c.stdout.pause(); }
  resume() { this.c.stdout.resume(); }
  interrupt() { this.write('\x03'); return true; }
  kill() {
    if (this.exited) return;
    killGroup(this.pid, 'SIGTERM');           // the helper hangs up the shell's own session, then leaves
    const t = setTimeout(() => killGroup(this.pid, 'SIGKILL'), 1200); if (t.unref) t.unref();
    this.once('exit', () => clearTimeout(t));
  }
}

class PipeBackend extends Backend {
  constructor({ file, args, cwd, env }) {
    super('basic');
    const posix = process.platform !== 'win32';
    const c = spawn(file, args, { cwd, env, shell: false, windowsHide: true, detached: posix, stdio: ['pipe', 'pipe', 'pipe'] });
    this.c = c; this.pid = c.pid || 0;
    for (const s of [c.stdout, c.stderr]) { s.setEncoding('utf8'); s.on('data', (d) => this._data(d)); }
    c.stdin.on('error', () => {});
    c.on('error', (e) => { this._data(`\r\n[could not start: ${e.code || e.message}]\r\n`); this._exit(127, null); });
    c.on('close', (code, sig) => this._exit(code, sig));
  }
  write(s) { if (!this.exited) this.c.stdin.write(s); }
  resize() {}
  pause() { this.c.stdout.pause(); this.c.stderr.pause(); }
  resume() { this.c.stdout.resume(); this.c.stderr.resume(); }
  // POSIX: Ctrl+C reaches the programs the shell started (an interactive shell ignores it itself). Windows pipes have no equivalent.
  interrupt() { return process.platform !== 'win32' && killGroup(this.pid, 'SIGINT'); }
  kill() {
    if (this.exited) return;
    if (process.platform === 'win32') { const { killTree } = require('../proc'); killTree(this.c); return; }
    killGroup(this.pid, 'SIGTERM');
    const t = setTimeout(() => killGroup(this.pid, 'SIGKILL'), 800); if (t.unref) t.unref();
    this.once('exit', () => clearTimeout(t));
  }
}

// One-time check that python3 can give a shell a terminal here (exit code 0 from importing the modules the helper needs).
function probePython(python, env) {
  return new Promise((resolve) => {
    if (!python || process.platform === 'win32') return resolve(false);
    let c, done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    try { c = spawn(python, ['-I', '-c', 'import pty,termios,fcntl,select,os'], { env, shell: false, stdio: 'ignore', windowsHide: true }); } catch { return fin(false); }
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } fin(false); }, 4000);
    c.on('error', () => { clearTimeout(t); fin(false); });
    c.on('close', (code) => { clearTimeout(t); fin(code === 0); });
  });
}

// Load node-pty if it is installed and its native part loads. Never throws.
function loadPty(req = require) {
  try { const m = req('node-pty'); return m && typeof m.spawn === 'function' ? m : null; } catch { return null; }
}

// allowed: modes the caller permits (default all). Returns the first that works, in the order pty, python, basic.
// basic: {file,args,env} used instead of the main ones when the pipe backend ends up being the one (it needs -i and a plain environment).
function createBackend({ pty, python, allowed = ['pty', 'python', 'basic'], basic = null, ...o }) {
  const errs = [];
  if (pty && allowed.includes('pty')) { try { return new PtyBackend(pty, o); } catch (e) { errs.push('pty: ' + e.message); } }
  if (python && allowed.includes('python')) { try { return new PythonBackend(python, o); } catch (e) { errs.push('python: ' + e.message); } }
  if (allowed.includes('basic')) return new PipeBackend({ ...o, ...(basic || {}) });
  throw new Error('no terminal backend available' + (errs.length ? ' (' + errs.join('; ') + ')' : ''));
}

module.exports = { createBackend, probePython, loadPty, PtyBackend, PythonBackend, PipeBackend, PY_HELPER };
