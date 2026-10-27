'use strict';
// Ghost virtual computer: the host side of the control channel to the program inside the machine (tools/ghost-vm/guest/ghost-agent.py).
// One JSON object per line. The host asks; the agent starts terminals (real pseudo-terminals) and argv-only commands, copies files into
// the machine, and reports output. There is no shell string anywhere: a command is an array. The first line from the machine must be
// {"ev":"hello","token":<the token on its kernel command line>}; anything else is dropped.
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

const MAX_LINE = 4 * 1024 * 1024, CHUNK = 256 * 1024;
const b64 = (b) => Buffer.from(b).toString('base64');

class AgentClient extends EventEmitter {
  constructor({ token, helloTimeoutMs = 0 } = {}) {
    super(); this.token = token; this.stream = null; this.ready = false; this.buf = ''; this.rid = 1; this.pending = new Map(); this.execs = new Map(); this.helloTimeoutMs = helloTimeoutMs;
  }
  attach(stream) {
    this.detach(); this.stream = stream; this.ready = false; this.buf = '';
    stream.setEncoding && stream.setEncoding('utf8');
    stream.on('data', (d) => this._data(String(d)));
    stream.on('close', () => { if (this.stream === stream) this._lost(); });
    stream.on('error', () => {});
  }
  detach() { if (this.stream) { const s = this.stream; this.stream = null; try { s.destroy(); } catch { /* gone */ } } this._lost(); }
  _lost() {
    const was = this.ready; this.ready = false;
    for (const [, p] of this.pending) p.reject(new Error('The virtual computer is not connected.'));
    this.pending.clear();
    for (const [, x] of this.execs) x.finish({ code: null, signal: 'lost' });
    this.execs.clear();
    if (was) this.emit('lost');
  }
  _data(s) {
    this.buf += s;
    if (this.buf.length > MAX_LINE * 2) { this.detach(); return; }
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      if (line.length > MAX_LINE) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (!m || typeof m !== 'object') continue;
      if (!this.ready) {
        if (m.ev === 'hello' && typeof m.token === 'string' && this.token && m.token === this.token) { this.ready = true; this.info = { version: m.version || 0 }; this.emit('hello', m); } else this.emit('refused');
        continue;
      }
      this._msg(m);
    }
  }
  _msg(m) {
    if (m.ev === 'data' && typeof m.sid === 'string') this.emit('shell-data', m.sid, Buffer.from(String(m.b64 || ''), 'base64'));
    else if (m.ev === 'exit' && typeof m.sid === 'string') this.emit('shell-exit', m.sid, m.code, m.signal);
    else if (m.ev === 'x-out') { const x = this.execs.get(m.xid); if (x) x.out(m.ch, Buffer.from(String(m.b64 || ''), 'base64')); }
    else if (m.ev === 'x-exit') { const x = this.execs.get(m.xid); if (x) { this.execs.delete(m.xid); x.finish({ code: m.code, signal: m.signal || null }); } }
    else if (m.ev === 'ack') { const p = this.pending.get(m.rid); if (p) { this.pending.delete(m.rid); m.ok ? p.resolve(m) : p.reject(new Error(String(m.err || 'failed').slice(0, 300))); } }
  }
  _send(o) { if (!this.ready || !this.stream || this.stream.destroyed) throw new Error('The virtual computer is not connected.'); this.stream.write(JSON.stringify(o) + '\n'); }
  _req(o, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const rid = this.rid++;
      const t = setTimeout(() => { this.pending.delete(rid); reject(new Error('The virtual computer did not answer in time.')); }, timeoutMs); if (t.unref) t.unref();
      this.pending.set(rid, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      try { this._send({ ...o, rid }); } catch (e) { clearTimeout(t); this.pending.delete(rid); reject(e); }
    });
  }
  // ----- terminals -----
  shell(sid, { cols, rows, cwd } = {}) { return this._req({ op: 'shell', sid, cols, rows, ...(cwd ? { cwd } : {}) }); }
  write(sid, str) { this._send({ op: 'in', sid, b64: b64(Buffer.from(str, 'utf8')) }); }
  resize(sid, cols, rows) { this._send({ op: 'resize', sid, cols, rows }); }
  pause(sid) { try { this._send({ op: 'pause', sid }); } catch { /* gone */ } }
  resume(sid) { try { this._send({ op: 'resume', sid }); } catch { /* gone */ } }
  closeShell(sid) { try { this._send({ op: 'close', sid }); } catch { /* gone */ } }
  // ----- commands (argv only) -----
  // -> {id, done: Promise<{code, signal}>, kill()}. onOut(channel 'o'|'e', Buffer). The caller applies its own output cap by calling kill().
  startArgv({ argv, cwd, env, timeoutMs = 60000, onOut = () => {} }) {
    if (!Array.isArray(argv) || !argv.length || argv.length > 64 || !argv.every((a) => typeof a === 'string' && a.length < 8192 && !a.includes('\0'))) throw new Error('bad command');
    const xid = 'x' + crypto.randomBytes(5).toString('hex');
    let finish; const done = new Promise((r) => { finish = r; });
    this.execs.set(xid, { out: onOut, finish });
    try { this._send({ op: 'exec', xid, argv, cwd, env, timeoutMs }); } catch (e) { this.execs.delete(xid); throw e; }
    return { id: xid, done, kill: () => { try { this._send({ op: 'xkill', xid }); } catch { /* gone */ } } };
  }
  async run(opts) {
    const out = [], err = []; let n = 0; const cap = opts.maxBytes || 4 * 1024 * 1024; let h;
    h = this.startArgv({ ...opts, onOut: (ch, b) => { n += b.length; if (n > cap) { h && h.kill(); return; } (ch === 'o' ? out : err).push(b); } });
    const r = await h.done;
    return { ...r, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), truncated: n > cap };
  }
  // ----- files -----
  async put(path, data, { mode = 0o644 } = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!buf.length) return this._req({ op: 'put', path, mode, b64: '', append: false });
    for (let o = 0; o < buf.length; o += CHUNK) await this._req({ op: 'put', path, mode, b64: b64(buf.subarray(o, o + CHUNK)), append: o > 0 }, 60000);
    return { ok: true };
  }
  rmtree(path) { return this._req({ op: 'rm', path }); }
  ping() { return this._req({ op: 'ping' }, 5000); }
  poweroff() { try { this._send({ op: 'poweroff' }); } catch { /* gone */ } }
  mount(kind) { return this._req({ op: 'mount', kind }, 60000); }
}
module.exports = { AgentClient, MAX_LINE };
