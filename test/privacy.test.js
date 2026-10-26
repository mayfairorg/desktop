'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PV = require('../src/main/lib/privacy');
const { Settings, DEFAULTS } = require('../src/main/lib/settings');
const T = require('../src/main/lib/tor');

test('proxy config: valid HTTP and SOCKS5, loopback not bypassed', () => {
  assert.deepEqual(PV.proxyConfig('off').config, { mode: 'direct' });
  const s = PV.proxyConfig('socks5', 'proxy.example.net', 1080);
  assert.equal(s.ok, true); assert.equal(s.config.proxyRules, 'socks5://proxy.example.net:1080'); assert.equal(s.config.proxyBypassRules, '<-loopback>');
  assert.equal(PV.proxyConfig('http', '10.0.0.5', 8080).config.proxyRules, 'http://10.0.0.5:8080');
  assert.equal(PV.proxyConfig('socks5', '[::1]', 9050).ok, true);
});
test('proxy config rejects bad hosts, schemes, ports, modes', () => {
  for (const h of ['http://x.com', 'x.com/path', 'a b', 'user@host', '', 'x.com:80', '-bad.com', 'a'.repeat(300), 'host;rm']) assert.equal(PV.proxyConfig('http', h, 80).ok, false, h);
  for (const p of [0, -1, 70000, 1.5, '80', NaN, null]) assert.equal(PV.proxyConfig('http', 'x.com', p).ok, false, String(p));
  assert.equal(PV.proxyConfig('ftp', 'x.com', 80).ok, false);
  assert.match(PV.proxyConfig('http', 'http://x', 80).error, /host name/);
});
test('secure DNS: Cloudflare default, Quad9 choice, off falls back to automatic', () => {
  assert.deepEqual(PV.dohConfig(true, 'cloudflare'), { secureDnsMode: 'secure', secureDnsServers: ['https://cloudflare-dns.com/dns-query'] });
  assert.deepEqual(PV.dohConfig(true, 'quad9'), { secureDnsMode: 'secure', secureDnsServers: ['https://dns.quad9.net/dns-query'] });
  assert.equal(PV.dohConfig(true, 'unknown').secureDnsServers[0], PV.DNS_PROVIDERS.cloudflare.url);
  assert.deepEqual(PV.dohConfig(false, 'quad9'), { secureDnsMode: 'automatic', secureDnsServers: [] });
});
test('ECH feature only with secure DNS', () => {
  assert.match(PV.featureSwitches({ secureDns: true, ech: true }).enable, /EncryptedClientHello/);
  assert.doesNotMatch(PV.featureSwitches({ secureDns: true, ech: true }).disable, /EncryptedClientHello/);
  assert.match(PV.featureSwitches({ secureDns: false, ech: true }).disable, /EncryptedClientHello/);
  assert.match(PV.featureSwitches({ secureDns: true, ech: false }).disable, /EncryptedClientHello/);
  assert.match(PV.featureSwitches({ secureDns: false, ech: false }).disable, /Translate/);
});
test('WebRTC policy by tab kind', () => {
  assert.equal(PV.webrtcPolicy('tor', 'off'), 'disable_non_proxied_udp');
  assert.equal(PV.webrtcPolicy('browse', 'strict'), 'disable_non_proxied_udp');
  assert.equal(PV.webrtcPolicy('private', 'public'), 'default_public_interface_only');
  assert.equal(PV.webrtcPolicy('browse', 'off'), 'default');
  assert.equal(PV.webrtcPolicy('home', 'strict'), 'default', 'Mayfair calls keep working');
  assert.equal(PV.webrtcPolicy('app', 'strict'), 'default');
  assert.equal(PV.webrtcPolicy('browse', 'nonsense'), 'disable_non_proxied_udp');
});
test('tab privacy: Tor always standard + reduced; Mayfair and apps untouched', () => {
  const s = { standardLocale: false, reduceFingerprint: false, webrtc: 'off' };
  assert.deepEqual(PV.tabPrivacy('tor', s), { standardLocale: true, reduceFingerprint: true, webrtc: 'disable_non_proxied_udp' });
  assert.equal(PV.tabPrivacy('home', { standardLocale: true, reduceFingerprint: true }).standardLocale, false);
  assert.equal(PV.tabPrivacy('app', { standardLocale: true, reduceFingerprint: true }).reduceFingerprint, false);
  assert.equal(PV.tabPrivacy('browse', { standardLocale: true, reduceFingerprint: false }).standardLocale, true);
  assert.equal(PV.tabPrivacy('private', { standardLocale: false, reduceFingerprint: true }).reduceFingerprint, true);
});
test('fingerprint script is valid JavaScript and only narrows values', () => {
  const src = PV.fingerprintScript();
  new Function(src);
  assert.doesNotMatch(src, /fetch|XMLHttp|document\.cookie|eval/);
});
test('honest labels are present in the notes', () => {
  assert.match(PV.NOTES.dns, /not a VPN/i);
  assert.match(PV.NOTES.dns, /does not hide your IP/i);
  assert.match(PV.NOTES.tor, /slow/i); assert.match(PV.NOTES.tor, /block Tor/i); assert.match(PV.NOTES.tor, /not Tor Browser/i);
  assert.match(PV.NOTES.rules, /school or workplace/i);
});
test('privacy settings validated and persisted', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-')), 's.json');
  const s = new Settings(f, { delay: 1 });
  assert.equal(s.get().secureDns, false); assert.equal(s.get().webrtc, 'strict'); assert.equal(s.get().dnsProvider, 'cloudflare');
  assert.deepEqual(s.set({ secureDns: true, dnsProvider: 'quad9', webrtc: 'public', proxyMode: 'socks5', proxyHost: 'p.example.net', proxyPort: 1080 }), ['secureDns', 'dnsProvider', 'webrtc', 'proxyMode', 'proxyHost', 'proxyPort']);
  assert.deepEqual(s.set({ dnsProvider: 'evil', webrtc: 'x', proxyMode: 'tor', proxyHost: 'http://x', proxyPort: 99999, secureDns: 'yes' }), []);
  s.flush();
  const again = new Settings(f).get();
  assert.equal(again.dnsProvider, 'quad9'); assert.equal(again.proxyPort, 1080);
  assert.ok('reduceFingerprint' in DEFAULTS && 'ech' in DEFAULTS);
});
test('torrc: local-only ports, cookie auth, no disk writes', () => {
  const rc = T.torrc({ socksPort: 9150, controlPort: 9151, dataDir: '/d', cookieFile: '/c' });
  assert.match(rc, /^SocksPort 127\.0\.0\.1:9150/m); assert.match(rc, /^ControlPort 127\.0\.0\.1:9151/m);
  assert.match(rc, /CookieAuthentication 1/); assert.match(rc, /ClientOnly 1/); assert.match(rc, /AvoidDiskWrites 1/);
  assert.doesNotMatch(rc, /0\.0\.0\.0/);
});
test('tor parsing helpers', () => {
  assert.deepEqual(T.parseBootstrap('Oct 26 [notice] Bootstrapped 85% (ap_conn): Connecting'), { pct: 85, tag: 'ap_conn' });
  assert.equal(T.parseBootstrap('nothing'), null);
  assert.equal(T.newnymCommands('ab'), 'AUTHENTICATE ab\r\nSIGNAL NEWNYM\r\nQUIT\r\n');
  assert.equal(T.controlOk('250 OK\r\n250 OK\r\n250 closing\r\n'), true);
  assert.equal(T.controlOk('515 Authentication failed\r\n'), false);
  assert.equal(T.controlOk('250 OK\r\n514 Authentication required\r\n'), false);
});
test('tor binary lookup: bundled path preferred, missing -> null', () => {
  const seen = new Set(['/r/tor/tor/tor']);
  assert.equal(T.binaryPath({ resourcesPath: '/r', root: '/x', platform: 'linux', arch: 'x64', exists: (p) => seen.has(p) }), '/r/tor/tor/tor');
  assert.equal(T.binaryPath({ resourcesPath: '/r', root: '/x', platform: 'win32', arch: 'x64', exists: (p) => p === '/x/vendor/tor/win-x64/tor/tor.exe' || p.endsWith('tor.exe') && p.startsWith('/x') }) !== null, true);
  assert.equal(T.binaryPath({ resourcesPath: '/r', root: '/x', exists: () => false }), null);
});
const FAKE = path.join(__dirname, 'fixtures', 'fake-tor.js');
test('TorManager (with a stand-in tor): starts, reports progress, new identity, stops, cleans up', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-tor-'));
  const m = new T.TorManager({ binary: FAKE, tmpBase, timeoutMs: 8000 });
  const seen = []; m.on('state', (s) => seen.push(s.progress));
  const port = await m.start();
  assert.ok(port > 0 && m.ready);
  assert.ok(seen.includes(100));
  assert.equal(fs.readdirSync(tmpBase).length, 1);
  assert.equal(await m.newIdentity(), true);
  const dir = path.join(tmpBase, fs.readdirSync(tmpBase)[0]);
  assert.ok(fs.existsSync(path.join(dir, 'control_auth_cookie.newnym')), 'NEWNYM reached the control port');
  m.stop();
  await new Promise((r) => { const t = setInterval(() => { if (m.state.status === 'off') { clearInterval(t); r(); } }, 20); });
  assert.equal(fs.readdirSync(tmpBase).length, 0, 'data directory removed (no persistence)');
  await assert.rejects(() => m.newIdentity(), /not running/);
});
test('TorManager reports a crash and a missing binary, never claims ready', async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-tor-'));
  process.env.FAKE_TOR_MODE = 'crash';
  const c = new T.TorManager({ binary: FAKE, tmpBase, timeoutMs: 5000 });
  await assert.rejects(() => c.start(), /Tor stopped/);
  assert.equal(c.ready, false); assert.equal(c.state.status, 'error');
  process.env.FAKE_TOR_MODE = 'hang';
  const h = new T.TorManager({ binary: FAKE, tmpBase, timeoutMs: 400 });
  await assert.rejects(() => h.start(), /did not connect in time/);
  assert.equal(h.ready, false);
  delete process.env.FAKE_TOR_MODE;
  const none = new T.TorManager({ binary: null, tmpBase });
  await assert.rejects(() => none.start(), /not included/);
  assert.equal(fs.readdirSync(tmpBase).length, 0, 'temp dirs cleaned');
});
