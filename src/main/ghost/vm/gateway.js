'use strict';
// Ghost virtual computer: the egress gateway. The machine has no network card. Its programs reach the network only through a proxy
// inside the machine (ghost-netd) that sends each connection to THIS file over a serial channel, so every connection is decided here, in Ghost:
//   off          every request is refused.
//   tor          connect through Ghost's own Tor program (SOCKS5, the host NAME goes to Tor and is resolved at the exit; one circuit
//                set per machine session). If Tor is not ready nothing is sent and nothing falls back.
//   direct-doh   connect from this computer; names are looked up only through DNS over HTTPS (the browser's provider list). The sites
//                see the real address.
// In every mode the browser's never-list applies (this computer, the local network, link-local and cloud metadata addresses, local
// names), to names AND to the addresses a name resolves to. Nothing is special-cased by program: a scanner is treated like any other
// program. Programs that ignore proxy settings, and anything that is not TCP (ping, UDP, raw scans), cannot connect at all.
const net = require('node:net');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { neverReason } = require('../browser/policy');
const { T, MAX_PAYLOAD, encode, FrameParser } = require('./mux');

const MODES = ['tor', 'direct-doh', 'none'];
const HOST_RE = /^[A-Za-z0-9._:\-\[\]]{1,253}$/;

// 16 bytes of an IPv6 address (any textual form, including :: and a trailing IPv4 part).
function ipv6Bytes(text) {
  let t = String(text).split('%')[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (v4) { const o = v4[1].split('.').map(Number); t = t.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16); }
  const [a, b] = t.split('::');
  const left = a ? a.split(':') : [], right = b !== undefined && b ? b.split(':') : [];
  const mid = b === undefined ? [] : new Array(8 - left.length - right.length).fill('0');
  const out = Buffer.alloc(16);
  [...left, ...mid, ...right].forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return out;
}

// SOCKS5 client with user/password so each machine session gets its own Tor circuits (IsolateSOCKSAuth).
function socks5Connect({ port, host, destHost, destPort, user, pass, timeoutMs = 30000, connect = net.connect }) {
  return new Promise((resolve, reject) => {
    const s = connect({ host, port });
    let stage = 0, buf = Buffer.alloc(0), done = false;
    const fail = (m) => { if (done) return; done = true; clearTimeout(t); s.destroy(); reject(new Error(m)); };
    const t = setTimeout(() => fail('Tor did not answer in time.'), timeoutMs); if (t.unref) t.unref();
    s.on('error', (e) => fail('Tor connection failed: ' + (e.code || e.message)));
    s.on('close', () => fail('Tor closed the connection.'));
    s.once('connect', () => s.write(Buffer.from([5, 1, 2])));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[0] !== 5 || buf[1] !== 2) return fail('Tor refused the login method.');
        buf = buf.subarray(2); stage = 1;
        const u = Buffer.from(user), p = Buffer.from(pass);
        s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
      }
      if (stage === 1 && buf.length >= 2) {
        if (buf[1] !== 0) return fail('Tor refused the login.');
        buf = buf.subarray(2); stage = 2;
        let addr;
        if (net.isIPv4(destHost)) addr = Buffer.concat([Buffer.from([1]), Buffer.from(destHost.split('.').map(Number))]);
        else if (net.isIPv6(destHost)) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(destHost)]);
        if (!addr) { const h = Buffer.from(destHost); addr = Buffer.concat([Buffer.from([3, h.length]), h]); }
        const pb = Buffer.alloc(2); pb.writeUInt16BE(destPort);
        s.write(Buffer.concat([Buffer.from([5, 1, 0]), addr, pb]));
      }
      if (stage === 2 && buf.length >= 10) {
        if (buf[1] !== 0) return fail('Tor could not connect (code ' + buf[1] + ').');
        const atyp = buf[3], need = atyp === 1 ? 10 : atyp === 4 ? 22 : 7 + (buf[4] || 0);
        if (buf.length < need) return;
        const rest = buf.subarray(need);
        done = true; clearTimeout(t); s.removeAllListeners('data'); s.removeAllListeners('close'); s.removeAllListeners('error'); s.on('error', () => {});
        resolve({ socket: s, rest });
      }
    });
  });
}

function parseTarget(text) {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:\[\]]+):(\d{1,5})$/.exec(String(text));
  if (!m) return null;
  const port = Number(m[2]);
  const host = m[1].replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (port < 1 || port > 65535 || !host || !HOST_RE.test(m[1])) return null;
  return { host, port };
}

class EgressGateway extends EventEmitter {
  // getMode() -> 'tor' | 'direct-doh' | 'none'. getTor() -> {ready, socksPort}. resolver: {resolve(host)}. dial: test double ({host, port, mode, ips}) -> Promise<{socket, rest?}>.
  constructor({ getMode, getTor = () => ({ ready: false, socksPort: 0 }), resolver = null, dial = null, now = Date.now, maxConns = 128, connect = net.connect } = {}) {
    super();
    this.getMode = getMode; this.getTor = getTor; this.resolver = resolver; this.dialImpl = dial; this.now = now; this.maxConns = maxConns; this.connect = connect;
    this.conns = new Map(); this.stream = null; this.blockedLog = []; this.counts = { opened: 0, refused: 0, bytesOut: 0, bytesIn: 0 };
    this.isolation = { user: 'ghost-' + crypto.randomBytes(6).toString('hex'), pass: crypto.randomBytes(8).toString('hex') };
  }
  attach(stream) {
    this.detach();
    this.stream = stream; this.parser = new FrameParser((f) => this._frame(f), () => this.detach());
    stream.on('data', (d) => this.parser.push(d));
    stream.on('close', () => { if (this.stream === stream) this.detach(); });
    stream.on('error', () => {});
    stream.on('drain', () => { for (const c of this.conns.values()) if (c.socket && c.paused) { c.paused = false; c.socket.resume(); } });
  }
  detach() { this.closeAll(); this.stream = null; this.parser = null; }
  closeAll() { for (const [id, c] of [...this.conns]) this._end(id, false); }
  stats() { return { open: this.conns.size, ...this.counts }; }
  blocked() { return this.blockedLog.slice(); }
  _send(type, conn, payload) {
    if (!this.stream || this.stream.destroyed) return true;
    try { return this.stream.write(encode(type, conn, payload)); } catch { return true; }
  }
  _refuse(conn, host, port, reason, canAllow = false) {
    this.counts.refused++;
    const e = { t: this.now(), host, port, reason, canAllow };
    this.blockedLog.push(e); if (this.blockedLog.length > 200) this.blockedLog.shift();
    this.emit('block', e);
    this._send(T.ERR, conn, reason);
  }
  _end(id, notify) {
    const c = this.conns.get(id); if (!c) return;
    this.conns.delete(id);
    if (c.socket) { c.socket.removeAllListeners('data'); try { c.socket.destroy(); } catch { /* gone */ } }
    if (notify) this._send(T.CLOSE, id);
  }
  _frame({ type, conn, payload }) {
    if (type === T.OPEN) return this._open(conn, payload.toString('utf8')).catch(() => this._end(conn, true));
    const c = this.conns.get(conn); if (!c) return;
    if (type === T.DATA) {
      if (!c.socket) { c.early.push(Buffer.from(payload)); return; }
      this.counts.bytesOut += payload.length;
      if (!c.socket.write(payload) && this.stream) { this.stream.pause(); c.socket.once('drain', () => { if (this.stream) this.stream.resume(); }); }
    } else if (type === T.CLOSE) this._end(conn, false);
  }
  async _open(conn, text) {
    if (this.conns.has(conn)) return;
    const tgt = parseTarget(text);
    if (!tgt) return this._refuse(conn, String(text).slice(0, 60), 0, 'That is not a valid address.');
    const { host, port } = tgt;
    const mode = this.getMode();
    if (mode === 'none' || !MODES.includes(mode)) return this._refuse(conn, host, port, 'The network is switched off for this virtual computer.', true);
    const never = neverReason(host);
    if (never) return this._refuse(conn, host, port, never + ' It cannot be reached from the virtual computer.');
    if (this.conns.size >= this.maxConns) return this._refuse(conn, host, port, 'Too many connections are open.');
    const rec = { socket: null, early: [], paused: false };
    this.conns.set(conn, rec);
    let res;
    try {
      if (this.dialImpl) res = await this.dialImpl({ host, port, mode });
      else if (mode === 'tor') {
        const tor = this.getTor();
        if (!tor || !tor.ready || !tor.socksPort) { this.conns.delete(conn); return this._refuse(conn, host, port, 'Tor is not connected, so nothing was sent. There is no fallback to a direct connection.'); }
        res = await socks5Connect({ port: tor.socksPort, host: '127.0.0.1', destHost: host, destPort: port, ...this.isolation, connect: this.connect });
      } else {
        let ips = [host];
        if (!net.isIP(host)) {
          if (!this.resolver) throw new Error('no resolver');
          ips = await this.resolver.resolve(host);
        }
        const ok = ips.filter((ip) => !neverReason(ip));
        if (!ok.length) { this.conns.delete(conn); return this._refuse(conn, host, port, 'This name points at a local or private network address. It cannot be reached from the virtual computer.'); }
        res = await new Promise((resolve, reject) => {
          let i = 0;
          const next = () => {
            if (i >= ok.length) return reject(new Error('could not connect'));
            const s = this.connect({ host: ok[i++], port }); s.setTimeout(30000);
            s.once('connect', () => { s.setTimeout(0); s.removeAllListeners('error'); s.on('error', () => {}); resolve({ socket: s }); });
            s.once('timeout', () => { s.destroy(); next(); });
            s.once('error', () => { s.destroy(); next(); });
          };
          next();
        });
      }
    } catch (e) {
      if (this.conns.get(conn) === rec) { this.conns.delete(conn); this._refuse(conn, host, port, String((e && e.message) || 'Could not connect.').slice(0, 200)); }
      return;
    }
    if (this.conns.get(conn) !== rec) { try { res.socket.destroy(); } catch { /* gone */ } return; }
    const s = res.socket; rec.socket = s; this.counts.opened++;
    this._send(T.OK, conn);
    const push = (d) => { this.counts.bytesIn += d.length; for (let o = 0; o < d.length; o += MAX_PAYLOAD) if (!this._send(T.DATA, conn, d.subarray(o, o + MAX_PAYLOAD)) && !rec.paused) { rec.paused = true; s.pause(); } };
    if (res.rest && res.rest.length) push(res.rest);
    s.on('data', push);
    s.on('end', () => this._end(conn, true));
    s.on('close', () => this._end(conn, true));
    s.on('error', () => this._end(conn, true));
    for (const b of rec.early) { this.counts.bytesOut += b.length; s.write(b); }
    rec.early = [];
  }
}

module.exports = { EgressGateway, socks5Connect, parseTarget, ipv6Bytes, MODES };
