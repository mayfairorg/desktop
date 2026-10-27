'use strict';
// Ghost investigation browser: egress policy, route plans, fingerprint script, connector rule, and static rules for the code itself.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EgressPolicy, validateModule, neverReason, connectorRoute } = require('../src/main/ghost/browser/policy');
const route = require('../src/main/ghost/browser/route');
const FP = require('../src/main/ghost/browser/fingerprint');
const { FakeSession } = require('./ghost-browser-helpers');

const root = path.join(__dirname, '..');
const dirFiles = (d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.js')).map((f) => path.join(root, d, f));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

// ---- egress policy -------------------------------------------------------------------------------------------------------------
const mk = (hosts = ['example.org', '*.cdn.example.org']) => { const blocks = []; const p = new EgressPolicy({ onBlock: (c, e) => blocks.push(e) }); p.declare({ id: 'm1', name: 'Test', hosts }); p.bindCase('c1', 'm1'); return { p, blocks }; };

test('declared hosts pass; everything else is blocked, counted and visible', () => {
  const { p, blocks } = mk();
  assert.equal(p.decide('c1', 'https://example.org/x', 'top').allow, true);
  assert.equal(p.decide('c1', 'https://a.cdn.example.org/i.png').allow, true);
  assert.equal(p.decide('c1', 'https://cdn.example.org/').allow, false, 'wildcard is subdomains only');
  assert.equal(p.decide('c1', 'https://evil-example.org/').allow, false);
  assert.equal(p.decide('c1', 'https://tracker.test/pixel?id=SECRET#frag').allow, false);
  assert.equal(p.blockedCount('c1'), 3); assert.equal(blocks.length, 3);
  const b = p.blocked('c1').pop(); assert.equal(b.canAllow, true); assert.equal(b.url, 'https://tracker.test/pixel'); assert.ok(!JSON.stringify(b).includes('SECRET'), 'queries are not stored');
});
test('the person can allow a host for one case; the never-list cannot be allowed', () => {
  const { p } = mk([]);
  assert.equal(p.decide('c1', 'https://news.example.net/', 'top').allow, false);
  p.allowHost('c1', 'news.example.net');
  assert.equal(p.decide('c1', 'https://news.example.net/', 'top').allow, true);
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.9', '169.254.169.254', '172.20.0.1', 'printer.local', 'db.internal', 'intranet', '[::1]', 'fd00::1']) assert.throws(() => p.allowHost('c1', h), /cannot be allowed/, h);
  assert.deepEqual(p.grants('c1').map((g) => g.host), ['news.example.net']);
  p.bindCase('c2', 'm1'); assert.equal(p.decide('c2', 'https://news.example.net/').allow, false, 'grants are per case');
});
test('local addresses are refused however they are written; non-web schemes and embedded credentials too', () => {
  const { p } = mk(['example.org']);
  for (const u of ['http://localhost/', 'http://127.0.0.1:8080/', 'http://2130706433/', 'http://0x7f.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://metadata.internal/', 'http://router.lan/', 'http://10.0.0.1/']) assert.equal(p.decide('c1', u).allow, false, u);
  for (const u of ['file:///etc/passwd', 'ftp://example.org/', 'chrome://settings', 'javascript:alert(1)', 'view-source:https://example.org/', 'filesystem:https://example.org/x']) assert.equal(p.decide('c1', u).allow, false, u);
  assert.equal(p.decide('c1', 'https://user:pw@example.org/').allow, false);
  assert.equal(p.decide('c1', 'not a url').allow, false);
  assert.equal(p.decide('c1', 'data:image/png;base64,AAAA', 'sub').allow, true); assert.equal(p.decide('c1', 'data:text/html,hi', 'top').allow, false);
  assert.equal(p.decide('c1', 'about:blank', 'top').allow, true);
  assert.equal(p.decide('nope', 'https://example.org/').allow, false, 'no case, no access');
});
test('module declarations are validated: no wildcards for whole suffixes, no active scanners', () => {
  for (const hosts of [['*'], ['*.com'], ['com'], ['*.co.uk'], ['localhost'], ['10.0.0.1'], ['http://example.org'], ['exa mple.org']]) assert.throws(() => validateModule({ id: 'x', name: 'x', hosts }), undefined, JSON.stringify(hosts));
  assert.throws(() => validateModule({ id: 'x', name: 'x', hosts: [], scope: 'active' }), /never routed/);
  assert.throws(() => validateModule({ id: 'X!', name: 'x', hosts: [] }));
  assert.deepEqual(validateModule({ id: 'ok', name: 'Ok', hosts: ['Example.ORG', '*.example.org', 'example.org'] }).hosts, ['example.org', '*.example.org']);
  assert.ok(neverReason('example.org') === '' && neverReason('8.8.8.8') === '');
});

// ---- route -----------------------------------------------------------------------------------------------------------------
test('Tor plan: socks5 (name sent to Tor), no direct fallback, loopback not bypassed, never "socks5-local" or http', () => {
  const p = route.plan({ mode: 'tor', socksPort: 9050 });
  assert.equal(p.proxy.proxyRules, 'socks5://127.0.0.1:9050'); assert.equal(p.proxy.proxyBypassRules, '<-loopback>');
  assert.ok(!/direct|local|http/i.test(p.proxy.proxyRules.replace('socks5://127.0.0.1', '')));
  assert.equal(p.resolver, null); assert.equal(p.exposesIp, false);
  assert.throws(() => route.plan({ mode: 'tor', socksPort: 0 }), /not connected/);
  assert.throws(() => route.plan({ mode: 'vpn' }));
});
test('direct plan: secure DNS mode (no system resolver fallback), one DoH server, honest about the IP', () => {
  const p = route.plan({ mode: 'direct-doh', provider: 'quad9' });
  assert.equal(p.resolver.secureDnsMode, 'secure'); assert.equal(p.resolver.secureDnsServers.length, 1); assert.match(p.resolver.secureDnsServers[0], /^https:\/\/dns\.quad9\.net\//);
  assert.equal(p.exposesIp, true); assert.equal(route.plan({ mode: 'direct-doh', provider: 'nonsense' }).resolver.secureDnsServers[0], 'https://cloudflare-dns.com/dns-query');
});
test('applying a plan is checked: a Tor route that did not take stops the window from opening', async () => {
  const good = new FakeSession('a'); const app = { configureHostResolver() {} };
  assert.match((await route.apply({ session: good, app, plan: route.plan({ mode: 'tor', socksPort: 9050 }) })).proxySeen, /^SOCKS5 127\.0\.0\.1:9050$/);
  const lying = new FakeSession('b'); lying.setProxy = async () => {};
  await assert.rejects(route.apply({ session: lying, app, plan: route.plan({ mode: 'tor', socksPort: 9050 }) }), /did not apply/);
  const proxied = new FakeSession('c'); proxied.resolveProxy = async () => 'PROXY evil:3128';
  await assert.rejects(route.apply({ session: proxied, app, plan: route.plan({ mode: 'direct-doh' }) }), /unexpected proxy/);
});
test('chip says route, DNS mode and case; goes red when Tor is down', () => {
  const p = route.plan({ mode: 'tor', socksPort: 9050 });
  const ok = route.chip({ plan: p, tor: { status: 'ready' }, caseName: 'Case A' });
  assert.deepEqual([ok.route, ok.dns, ok.tone, ok.case], ['tor', 'tor', 'ok', 'Case A']); assert.match(ok.text, /Tor.*Case A/);
  const down = route.chip({ plan: p, tor: { status: 'off' }, caseName: 'Case A' }); assert.equal(down.tone, 'bad'); assert.match(down.text, /blocked/);
  const d = route.chip({ plan: route.plan({ mode: 'direct-doh' }), tor: { status: 'off' }, caseName: 'B' }); assert.equal(d.tone, 'warn'); assert.equal(d.dns, 'doh'); assert.match(d.text, /Direct.*DNS over HTTPS/);
});

// ---- fingerprint -----------------------------------------------------------------------------------------------------------
function world() {
  class Navigator {} class Screen {} class HTMLCanvasElement { toDataURL() { return 'REAL'; } toBlob() {} } class CanvasRenderingContext2D { getImageData() { return { data: [1, 2, 3] }; } }
  class ImageData { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } }
  class WebGLRenderingContext { getParameter(p) { return 'REAL-' + p; } readPixels() {} } class AnalyserNode { getFloatFrequencyData(a) { a.fill(-50); } getByteTimeDomainData(a) { a.fill(9); } }
  class AudioBuffer { constructor() { this.numberOfChannels = 1; this.d = new Float32Array(8).fill(0.7); } getChannelData() { return this.d; } }
  class OfflineAudioContext { startRendering() { return Promise.resolve(new AudioBuffer()); } }
  const sb = { Navigator, Screen, HTMLCanvasElement, CanvasRenderingContext2D, ImageData, WebGLRenderingContext, AnalyserNode, OfflineAudioContext, AudioBuffer, DOMException, atob, Blob, setTimeout, Uint8Array, Object };
  sb.window = sb; sb.RTCPeerConnection = function () {}; sb.webkitRTCPeerConnection = function () {}; sb.devicePixelRatio = 2;
  sb.navigator = new Navigator(); vm.createContext(sb); vm.runInContext(FP.script(), sb); return sb;
}
test('fingerprint script fixes identity values, blanks canvas/audio/WebGL readouts and removes WebRTC', async () => {
  const w = world(); const ev = (s) => vm.runInContext(s, w);
  assert.equal(ev('navigator.hardwareConcurrency'), 4); assert.equal(ev('navigator.platform'), 'Win32'); assert.equal(ev('navigator.language'), 'en-US'); assert.equal(ev('navigator.plugins.length'), 0);
  assert.equal(ev('new Screen().width'), 1920); assert.equal(ev('new Screen().colorDepth'), 24); assert.equal(w.devicePixelRatio, 1);
  assert.match(new w.HTMLCanvasElement().toDataURL(), /^data:image\/png;base64,/); assert.notEqual(new w.HTMLCanvasElement().toDataURL(), 'REAL');
  const img = new w.CanvasRenderingContext2D().getImageData(0, 0, 4, 4); assert.equal(img.data.every((x) => x === 0), true);
  const gl = new w.WebGLRenderingContext(); assert.equal(gl.getParameter(37446), FP.FIXED.glRenderer); assert.equal(gl.getParameter(1), 'REAL-1');
  const a = new Float32Array(4).fill(1); new w.AnalyserNode().getFloatFrequencyData(a); assert.equal(a.every((x) => x === 0), true);
  const buf = await new w.OfflineAudioContext().startRendering(); assert.equal(buf.getChannelData(0).every((x) => x === 0), true);
  assert.equal(w.RTCPeerConnection, undefined); assert.equal(w.webkitRTCPeerConnection, undefined);
  assert.equal(JSON.stringify(await ev('navigator.mediaDevices.enumerateDevices()')), '[]');
});
test('identity commands: fixed UA (no app name), UTC, en-US, fixed screen with real viewport, script before first load', () => {
  const cmds = FP.cdpCommands('141.0.7390.54'); const by = Object.fromEntries(cmds.map(([m, p]) => [m, p]));
  assert.match(by['Emulation.setUserAgentOverride'].userAgent, /Chrome\/141\.0\.0\.0 Safari/); assert.ok(!/Electron|Mayfair|HeadlessChrome/i.test(by['Emulation.setUserAgentOverride'].userAgent));
  assert.equal(by['Emulation.setUserAgentOverride'].acceptLanguage, 'en-US,en;q=0.9'); assert.equal(by['Emulation.setTimezoneOverride'].timezoneId, 'UTC'); assert.equal(by['Emulation.setLocaleOverride'].locale, 'en-US');
  const m = by['Emulation.setDeviceMetricsOverride']; assert.deepEqual([m.width, m.height, m.screenWidth, m.screenHeight], [0, 0, 1920, 1080]);
  assert.ok(by['Page.addScriptToEvaluateOnNewDocument'].source.length > 500);
  assert.ok(FP.LIMITS.length >= 5 && FP.LIMITS.some((l) => /fonts/i.test(l)) && FP.LIMITS.some((l) => /sign in/i.test(l)));
});

// ---- connectors -----------------------------------------------------------------------------------------------------------
test('active scanning connectors are never routed over Tor or through the browser', () => {
  for (const scope of ['active', 'passive', 'local']) { const r = connectorRoute({ scope }); assert.equal(r.viaTor, false); assert.equal(r.viaBrowser, false); }
  assert.match(connectorRoute({ scope: 'active' }).note, /never sent over Tor/);
  for (const f of ['runner.js', 'proc.js', 'manager.js', 'manifest.js']) { const s = fs.readFileSync(path.join(root, 'src/main/ghost', f), 'utf8'); assert.ok(!/browser\/|lib\/tor|socks5|ALL_PROXY|HTTPS?_PROXY/i.test(s), f); }
  const env = require('../src/main/ghost/proc').minimalEnv({ extra: {} }); assert.ok(!Object.keys(env).some((k) => /proxy/i.test(k)), 'connectors start with no proxy variables');
});

// ---- the code itself ---------------------------------------------------------------------------------------------------------
test('browser code makes no network calls of its own, no telemetry, no resolver use, no persistent partition', () => {
  const files = [...dirFiles('src/main/ghost/browser'), ...fs.readdirSync(path.join(root, 'src/ui/ghost-browser')).map((f) => path.join(root, 'src/ui/ghost-browser', f))];
  assert.ok(files.length >= 12);
  const hostsOk = new Set(['cloudflare-dns.com', 'dns.quad9.net']);
  for (const f of files) {
    const s = stripComments(fs.readFileSync(f, 'utf8'));
    assert.ok(!/require\(['"](node:)?(dns|http|https|http2|net|tls|dgram)['"]\)/.test(s), 'network module in ' + f);
    assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|net\.request|dns\.(lookup|resolve)|EventSource|navigator\.connection/.test(s), 'network call in ' + f);
    assert.ok(!/persist:[A-Za-z0-9_-]/.test(s), 'persistent partition in ' + f);
    assert.ok(!/analytics|telemetry|sentry|crash-?report/i.test(s), 'telemetry word in ' + f);
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) assert.ok(hostsOk.has(m[1].toLowerCase()) || /^(www\.w3\.org)$|\.invalid$/.test(m[1]), 'host ' + m[1] + ' in ' + f);
  }
});
test('no wording about how the code was made, and copyright is not claimed by anyone else', () => {
  const all = [...dirFiles('src/main/ghost/browser'), ...fs.readdirSync(path.join(root, 'src/ui/ghost-browser')).map((f) => path.join(root, 'src/ui/ghost-browser', f))].map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!/\b(claude|anthropic|generated|ai-written|written by ai|gpt|llm|copilot)\b/i.test(all));
});
