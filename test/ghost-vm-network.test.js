'use strict';
// Ghost virtual computer, the egress gateway and the network modes: nothing reaches the network except through Ghost's own gateway.
// The machine's side is played by a pair of in-memory streams; Tor by a small SOCKS5 server on localhost; "the internet" by an echo server.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Duplex } = require('node:stream');
const { EgressGateway, ipv6Bytes, parseTarget, socks5Connect } = require('../src/main/ghost/vm/gateway');
const { T, encode, FrameParser, MAX_PAYLOAD } = require('../src/main/ghost/vm/mux');
const { until } = require('./ghost-vm-helpers');

function pair() {
  const mk = () => { const d = new Duplex({ read() {}, write(c, e, cb) { other.push(c); cb(); } }); return d; };
  const a = mk(), other = a; const b = new Duplex({ read() {}, write(c, e, cb) { a.push(c); cb(); } });
  // a is the gateway's end, b is the machine's end: bytes written to b arrive at a and the other way round
  const aw = a._write; a._write = (c, e, cb) => { b.push(c); cb(); };
  return { gw: a, guest: b };
}
// the machine's side: sends frames, collects the answers
function guest(stream) {
  const frames = []; const p = new FrameParser((f) => frames.push(f)); stream.on('data', (d) => p.push(d));
  const send = (type, conn, payload) => stream.write(encode(type, conn, payload));
  const wait = (type, conn) => until(() => frames.find((f) => f.type === type && f.conn === conn), 3000);
  return { frames, send, wait, open: (conn, target) => send(T.OPEN, conn, target) };
}
const listen = (handler) => new Promise((res) => { const s = net.createServer(handler); const all = new Set(); s.on('connection', (c) => { all.add(c); c.on('close', () => all.delete(c)); }); s.shutdown = () => { for (const c of all) c.destroy(); s.close(); }; s.listen(0, '127.0.0.1', () => res(s)); });
const echo = () => listen((s) => s.on('data', (d) => s.write(Buffer.concat([Buffer.from('echo:'), d]))));

test('mux: frames round trip; oversize and unknown types are refused', () => {
  const got = []; const p = new FrameParser((f) => got.push(f));
  const buf = Buffer.concat([encode(T.OPEN, 7, 'example.org:443'), encode(T.DATA, 7, Buffer.from([1, 2, 3]))]);
  p.push(buf.subarray(0, 5)); p.push(buf.subarray(5));
  assert.equal(got.length, 2); assert.equal(got[0].payload.toString(), 'example.org:443'); assert.deepEqual([...got[1].payload], [1, 2, 3]);
  assert.throws(() => encode(T.DATA, 1, Buffer.alloc(MAX_PAYLOAD + 1)), /too large/);
  let err = null; const q = new FrameParser(() => {}, (e) => { err = e; }); q.push(Buffer.from([9, 0, 0, 0, 1, 0, 0])); assert.ok(err);
});
test('addresses: target parsing and IPv6 bytes', () => {
  assert.deepEqual(parseTarget('Example.ORG.:443'), { host: 'example.org', port: 443 });
  assert.deepEqual(parseTarget('[2001:db8::1]:80'), { host: '2001:db8::1', port: 80 });
  for (const bad of ['nohost', 'a:0', 'a:70000', ':80', 'a b:80', 'a:1:2', '']) assert.equal(parseTarget(bad), null, bad);
  assert.deepEqual([...ipv6Bytes('2001:db8::1')], [0x20, 1, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...ipv6Bytes('::1')], [...Array(15).fill(0), 1]);
  assert.deepEqual([...ipv6Bytes('::ffff:1.2.3.4')], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 1, 2, 3, 4]);
});

test('gateway: off refuses every request and says so; the refusal is logged for the status bar', async () => {
  const { gw, guest: g } = pair(); const c = guest(g);
  const dial = () => { throw new Error('must not dial'); };
  const G = new EgressGateway({ getMode: () => 'none', dial }); G.attach(gw);
  const blocks = []; G.on('block', (b) => blocks.push(b));
  c.open(1, 'example.org:443');
  const f = await c.wait(T.ERR, 1); assert.match(f.payload.toString(), /switched off/);
  assert.equal(G.blocked()[0].host, 'example.org'); assert.equal(blocks.length, 1); assert.equal(G.stats().refused, 1);
});
test('gateway: the never-list applies in every mode to names and to what they resolve to; programs are not special-cased', async () => {
  for (const mode of ['tor', 'direct-doh']) {
    const { gw, guest: g } = pair(); const c = guest(g);
    let dialed = 0;
    const G = new EgressGateway({ getMode: () => mode, getTor: () => ({ ready: true, socksPort: 1 }), dial: async () => { dialed++; throw new Error('no route'); }, resolver: { resolve: async (h) => (h === 'rebind.example' ? ['10.0.0.7'] : ['93.184.216.34']) } });
    G.attach(gw);
    const targets = ['localhost:80', '127.0.0.1:22', '169.254.169.254:80', '192.168.1.1:80', '10.1.2.3:443', '[::1]:80', 'printer.local:631', 'metadata.google.internal:80', 'router.lan:80'];
    targets.forEach((t, i) => c.open(i + 1, t));
    for (let i = 1; i <= targets.length; i++) { const f = await c.wait(T.ERR, i); assert.match(f.payload.toString(), /cannot be reached from the virtual computer/, mode + ' ' + targets[i - 1]); }
    assert.equal(dialed, 0, mode + ': nothing was even tried');
  }
  const { gw, guest: g } = pair(); const c = guest(g);
  const G = new EgressGateway({ getMode: () => 'direct-doh', resolver: { resolve: async () => ['10.0.0.7'] } }); G.attach(gw);
  c.open(1, 'rebind.example:80'); const f = await c.wait(T.ERR, 1); assert.match(f.payload.toString(), /points at a local or private network/);
});
test('gateway: Tor mode with Tor not connected sends nothing and does not fall back', async () => {
  const { gw, guest: g } = pair(); const c = guest(g);
  let connects = 0;
  const G = new EgressGateway({ getMode: () => 'tor', getTor: () => ({ ready: false, socksPort: 0 }), connect: () => { connects++; throw new Error('no'); } }); G.attach(gw);
  c.open(1, 'example.org:443'); const f = await c.wait(T.ERR, 1);
  assert.match(f.payload.toString(), /Tor is not connected.*no fallback/); assert.equal(connects, 0);
});
test('gateway: Tor mode sends the NAME to a SOCKS5 server with per-session login, and data flows both ways', async () => {
  const seen = [];
  const dest = await echo();
  const socks = await listen((s) => {
    let st = 0, buf = Buffer.alloc(0), up = null;
    s.on('data', (d) => {
      if (up) return up.write(d);
      buf = Buffer.concat([buf, d]);
      if (st === 0 && buf.length >= 3) { assert.deepEqual([...buf.subarray(0, 3)], [5, 1, 2]); buf = buf.subarray(3); st = 1; s.write(Buffer.from([5, 2])); }
      if (st === 1 && buf.length >= 2) { const ul = buf[1]; if (buf.length < 2 + ul + 1) return; const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return; seen.push({ user: buf.subarray(2, 2 + ul).toString(), pass: buf.subarray(3 + ul, 3 + ul + pl).toString() }); buf = buf.subarray(3 + ul + pl); st = 2; s.write(Buffer.from([1, 0])); }
      if (st === 2 && buf.length >= 5) {
        const atyp = buf[3]; let host, off;
        if (atyp === 3) { const l = buf[4]; if (buf.length < 5 + l + 2) return; host = buf.subarray(5, 5 + l).toString(); off = 5 + l; } else if (atyp === 1) { host = [...buf.subarray(4, 8)].join('.'); off = 8; } else { host = 'ipv6:' + buf.subarray(4, 20).toString('hex'); off = 20; }
        seen.push({ atyp, host, port: buf.readUInt16BE(off) });
        up = net.connect(dest.address().port, '127.0.0.1', () => s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])));
        up.on('data', (x) => s.write(x)); up.on('close', () => s.destroy());
        st = 3;
      }
    });
  });
  const { gw, guest: g } = pair(); const c = guest(g);
  const G = new EgressGateway({ getMode: () => 'tor', getTor: () => ({ ready: true, socksPort: socks.address().port }) }); G.attach(gw);
  c.open(1, 'hidden.example.org:8080');
  await c.wait(T.OK, 1);
  c.send(T.DATA, 1, 'hi');
  const f = await until(() => c.frames.find((x) => x.type === T.DATA && x.conn === 1 && /echo:hi/.test(x.payload.toString())));
  assert.ok(f);
  assert.deepEqual(seen[1], { atyp: 3, host: 'hidden.example.org', port: 8080 }, 'the name went to Tor to be resolved at the exit');
  assert.match(seen[0].user, /^ghost-[0-9a-f]{12}$/); assert.match(seen[0].pass, /^[0-9a-f]{16}$/);
  c.open(2, '[2001:db8::1]:443'); await c.wait(T.OK, 2);
  assert.equal(seen[3].atyp, 4);
  c.send(T.CLOSE, 1); await until(() => G.stats().open === 1);
  // a second machine session gets other circuits
  const other = new EgressGateway({ getMode: () => 'tor' }); assert.notEqual(other.isolation.user, G.isolation.user);
  G.detach(); await until(() => G.stats().open === 0);
  socks.shutdown(); dest.shutdown();
});
test('gateway: direct mode resolves names only through the encrypted resolver, then connects to the address it gave', async () => {
  const dest = await echo(); const asked = [], dialed = [];
  const { gw, guest: g } = pair(); const c = guest(g);
  const G = new EgressGateway({ getMode: () => 'direct-doh', resolver: { resolve: async (h) => { asked.push(h); return ['93.184.216.34']; } }, connect: ({ host, port }) => { dialed.push([host, port]); return net.connect(dest.address().port, '127.0.0.1'); } });
  G.attach(gw);
  c.open(1, 'example.org:443'); await c.wait(T.OK, 1); c.send(T.DATA, 1, 'x');
  await until(() => c.frames.some((f) => f.type === T.DATA && /echo:x/.test(f.payload.toString())));
  assert.deepEqual(asked, ['example.org']); assert.deepEqual(dialed, [['93.184.216.34', 443]]);
  c.open(2, '93.184.216.35:80'); await c.wait(T.OK, 2); assert.deepEqual(asked, ['example.org'], 'an address is not resolved');
  G.detach(); dest.shutdown();
});
test('gateway: changing the route ends open connections; limits and bad frames are enforced', async () => {
  const dest = await echo(); let mode = 'direct-doh';
  const { gw, guest: g } = pair(); const c = guest(g);
  const G = new EgressGateway({ getMode: () => mode, maxConns: 2, resolver: { resolve: async () => ['93.184.216.34'] }, connect: () => net.connect(dest.address().port, '127.0.0.1') }); G.attach(gw);
  c.open(1, 'a.example:80'); c.open(2, 'b.example:80'); await c.wait(T.OK, 1); await c.wait(T.OK, 2);
  c.open(3, 'c.example:80'); assert.match((await c.wait(T.ERR, 3)).payload.toString(), /Too many connections/);
  c.open(4, 'no-port'); assert.match((await c.wait(T.ERR, 4)).payload.toString(), /not a valid address/);
  G.closeAll(); assert.equal(G.stats().open, 0); mode = 'none';
  c.open(5, 'a.example:80'); assert.match((await c.wait(T.ERR, 5)).payload.toString(), /switched off/);
  g.write(Buffer.from([9, 0, 0, 0, 1, 0, 0])); await until(() => G.stream === null);
  dest.shutdown();
});
test('socks5Connect: a refusing or silent Tor is an error, not a hang', async () => {
  const bad = await listen((s) => s.once('data', () => s.write(Buffer.from([5, 0xff]))));
  await assert.rejects(socks5Connect({ port: bad.address().port, host: '127.0.0.1', destHost: 'a.b', destPort: 80, user: 'u', pass: 'p' }), /refused the login method/);
  const quiet = await listen(() => {});
  await assert.rejects(socks5Connect({ port: quiet.address().port, host: '127.0.0.1', destHost: 'a.b', destPort: 80, user: 'u', pass: 'p', timeoutMs: 150 }), /did not answer in time/);
  bad.shutdown(); quiet.shutdown();
});
