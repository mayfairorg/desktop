'use strict';
// Ghost investigation browser service: route choice, per-case sessions, request rules, capture into the vault, close and kill switch. Mock network only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { GhostBrowserService, PARTITION_PREFIX } = require('../src/main/ghost/browser/service');
const { verifySnapshot, listSnapshots } = require('../src/main/ghost/browser/capture');
const H = require('./ghost-browser-helpers');

function setup({ tor = new H.FakeTor(), confirm = async () => true, vault = H.mkVault() } = {}) {
  const el = H.fakeElectron(), handles = [], events = [], restored = [];
  const svc = new GhostBrowserService({ electron: el, tor, vault: () => vault, makeWindow: H.fakeHandleFactory(handles), confirm, restoreResolver: async () => { restored.push(1); }, emit: (n, p) => events.push([n, p]), chromeVersion: '141.0.7390.54' });
  return { svc, el, tor, vault, handles, events, restored };
}

test('default route is Tor; the window gets its own in-memory partition and a checked proxy', async () => {
  const t = setup(); const r = await t.svc.open({ caseId: 'case-1', name: 'Northwind' });
  assert.equal(r.ok, true); assert.equal(t.tor.starts, 1);
  const names = [...t.el.sessions.keys()]; assert.equal(names.length, 1);
  assert.ok(names[0].startsWith(PARTITION_PREFIX) && !names[0].startsWith('persist:') && !['mf-tor', 'mf-private', 'persist:browse', 'persist:mayfair'].includes(names[0]));
  assert.deepEqual(t.el.sessions.get(names[0]).opts, { cache: false });
  assert.equal(t.el.sessions.get(names[0]).proxy.proxyRules, 'socks5://127.0.0.1:41234');
  assert.equal(r.status.route, 'tor'); assert.equal(r.status.dns, 'tor'); assert.equal(r.status.case, 'Northwind'); assert.equal(t.el.resolver.length, 0, 'the app resolver is not touched on the Tor route');
});
test('two cases get two different random partitions', async () => {
  const t = setup(); await t.svc.open({ caseId: 'a' }); await t.svc.open({ caseId: 'b' });
  const [x, y] = [...t.el.sessions.keys()]; assert.notEqual(x, y); assert.ok(!x.includes('a') || x.length === PARTITION_PREFIX.length + 16);
});
test('Tor unavailable: nothing opens, no silent fallback; the offer to go direct is explicit and needs a native yes', async () => {
  const t = setup({ tor: new H.FakeTor({ fail: true }), confirm: async () => false });
  const r = await t.svc.open({ caseId: 'c1' });
  assert.deepEqual([r.ok, r.code, r.canFallback], [false, 'tor-unavailable', true]); assert.equal(t.handles.length, 0); assert.equal(t.el.sessions.size, 0); assert.equal(t.el.resolver.length, 0);
  const no = await t.svc.open({ caseId: 'c1', route: 'direct-doh' }); assert.equal(no.code, 'declined'); assert.equal(t.handles.length, 0);
  const t2 = setup({ tor: new H.FakeTor({ fail: true }) });
  const ok = await t2.svc.open({ caseId: 'c1', route: 'direct-doh' });
  assert.equal(ok.ok, true); assert.equal(ok.status.tone, 'warn'); assert.equal(ok.status.exposesIp, true); assert.equal(ok.status.dns, 'doh');
  const rs = t2.el.resolver[0]; assert.equal(rs.secureDnsMode, 'secure'); assert.match(rs.secureDnsServers[0], /^https:\/\//);
  assert.equal([...t2.el.sessions.values()][0].proxy.mode, 'direct');
});
test('closing the last direct window puts the app resolver setting back; closing the last Tor window stops Tor', async () => {
  const t = setup(); await t.svc.open({ caseId: 'd', route: 'direct-doh', directConfirmed: true }); await t.svc.open({ caseId: 't' });
  await t.svc.close('d'); assert.equal(t.restored.length, 1); assert.equal(t.tor.stops, 0, 'Tor still needed');
  await t.svc.close('t'); assert.equal(t.tor.stops, 1);
});
test('request rules: policy decides, headers are fixed, referrers trimmed, permissions and downloads refused', async () => {
  const t = setup(); t.svc.declareModule({ id: 'mod', name: 'M', hosts: ['example.org'] }); await t.svc.open({ caseId: 'k', module: 'mod' });
  const s = [...t.el.sessions.values()][0];
  assert.deepEqual(s.request('https://example.org/', 'mainFrame'), { cancel: false });
  assert.deepEqual(s.request('https://ads.example.net/p.js', 'script'), { cancel: true });
  assert.deepEqual(s.request('http://127.0.0.1:9050/', 'xhr'), { cancel: true });
  assert.deepEqual(s.request('wss://example.org/socket', 'webSocket'), { cancel: false });
  assert.equal(t.svc.status('k').blockedCount, 2); assert.ok(t.events.some(([n, p]) => n === 'state' && p.block && p.block.host === 'ads.example.net'));
  const h = s.headers({ 'User-Agent': 'Electron/38 Mayfair', 'accept-language': 'fr-FR', Referer: 'https://example.org/private/path?q=1', Accept: '*/*' });
  assert.match(h['User-Agent'], /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\).*Chrome\/141\.0\.0\.0 Safari\/537\.36$/); assert.equal(h['Accept-Language'], 'en-US,en;q=0.9'); assert.equal(h.Referer, 'https://example.org/'); assert.equal(h.Accept, '*/*');
  assert.ok(!Object.keys(h).some((k) => k === 'user-agent' || k === 'accept-language'));
  let granted = 'unset'; s.handlers.perm(null, 'geolocation', (g) => { granted = g; }); assert.equal(granted, false); assert.equal(s.handlers.check(), false); assert.equal(s.handlers.device(), false);
  let prevented = false; s.handlers['will-download']({ preventDefault: () => { prevented = true; } }); assert.equal(prevented, true);
  assert.ok(s.spell === false && s.ua[1] === 'en-US,en;q=0.9');
});
test('navigate: blocked top-level pages say why and can be allowed for the case; bare names get https', async () => {
  const t = setup(); await t.svc.open({ caseId: 'n' });
  const b = await t.svc.navigate('n', 'example.org/a'); assert.deepEqual([b.ok, b.code, b.canAllow, b.host], [false, 'blocked', true, 'example.org']);
  assert.equal(t.svc.allowHost('n', 'example.org').ok, true);
  assert.equal((await t.svc.navigate('n', 'example.org/a')).ok, true); assert.deepEqual(t.handles[0].loads, ['https://example.org/a']);
  const local = await t.svc.navigate('n', 'http://192.168.1.1/'); assert.equal(local.ok, false); assert.equal(local.canAllow, false); assert.equal(t.svc.allowHost('n', '192.168.1.1').ok, false);
  assert.equal((await t.svc.navigate('n', 'file:///etc/passwd')).ok, false);
});
test('bad input is refused before anything is created', async () => {
  const t = setup();
  for (const o of [{ caseId: '../x' }, { caseId: '' }, { caseId: 'a'.repeat(41) }, { caseId: 'ok', module: 'nope' }, { caseId: 'ok', route: 'vpn' }, undefined]) assert.equal((await t.svc.open(o)).ok, false);
  assert.equal(t.el.sessions.size, 0);
});
test('reopening a case focuses its window instead of creating another', async () => {
  const t = setup(); await t.svc.open({ caseId: 'r' }); const r = await t.svc.open({ caseId: 'r' });
  assert.equal(r.reused, true); assert.equal(t.handles.length, 1); assert.equal(t.handles[0].focusCount, 1); assert.equal(t.tor.starts, 1);
});

// ---- capture --------------------------------------------------------------------------------------------------------------
test('capture: HTML, screenshot, hashes, time and source URL are sealed in the vault; nothing plain on disk', async () => {
  const t = setup(); t.svc.declareModule({ id: 'mod', name: 'M', hosts: ['example.org'] }); await t.svc.open({ caseId: 'cap1', module: 'mod' });
  const r = await t.svc.capture('cap1'); assert.equal(r.ok, true, r.error);
  const m = r.snapshot; assert.equal(m.source.url, 'https://example.org/a?token=SECRET'); assert.equal(m.source.title, 'Example page'); assert.match(m.capturedAt, /^\d{4}-\d\d-\d\dT/);
  assert.match(m.html.sha256, /^[0-9a-f]{64}$/); assert.match(m.screenshot.sha256, /^[0-9a-f]{64}$/); assert.deepEqual([m.route.route, m.route.dns, m.route.exposesIp], ['tor', 'tor', false]); assert.deepEqual(m.egress.allowedHosts, ['example.org']);
  assert.equal(listSnapshots({ vault: t.vault, caseId: 'cap1' }).length, 1);
  assert.equal(verifySnapshot({ vault: t.vault, caseId: 'cap1', id: m.id }).ok, true);
  assert.match(t.vault.get('cases', `cap1.snap.${m.id}.html`).toString(), /PAGE-MARKER-4471/); assert.match(t.vault.get('cases', `cap1.snap.${m.id}.html`).toString(), /captured from https:\/\/example\.org\/a\?token=SECRET/);
  for (const f of H.walk(t.vault.dir)) { const b = fs.readFileSync(f); for (const x of ['PAGE-MARKER', 'PNG-BYTES', 'example.org', 'token=SECRET']) assert.equal(b.includes(Buffer.from(x)), false, x + ' plain in ' + f); }
});
test('capture: refuses when the vault is locked or no page is open; tampering is detected', async () => {
  const t = setup(); await t.svc.open({ caseId: 'cap2' });
  t.vault.lock(); const locked = await t.svc.capture('cap2'); assert.deepEqual([locked.ok, locked.code], [false, 'locked']); assert.equal(t.svc.status('cap2').vault, 'locked');
  const t2 = setup(); await t2.svc.open({ caseId: 'cap3' }); t2.handles[0].url = 'about:blank';
  assert.equal((await t2.svc.capture('cap3')).code, 'no-page');
  t2.handles[0].url = 'https://example.org/'; const ok = await t2.svc.capture('cap3'); assert.equal(ok.ok, true);
  t2.vault.put('cases', `cap3.snap.${ok.snapshot.id}.html`, 'CHANGED'); assert.equal(verifySnapshot({ vault: t2.vault, caseId: 'cap3', id: ok.snapshot.id }).ok, false);
  assert.equal((await t2.svc.capture('missing')).code, 'no-case');
});

// ---- kill switch ----------------------------------------------------------------------------------------------------------
test('kill switch: closes every window, wipes every partition, stops Tor, locks the vault, restores the resolver, reports it', async () => {
  const t = setup(); await t.svc.open({ caseId: 'k1' }); await t.svc.open({ caseId: 'k2', route: 'direct-doh', directConfirmed: true });
  assert.equal(t.vault.unlocked, true);
  const r = await t.svc.kill();
  assert.deepEqual(r.report, { windows: 2, wiped: 2, tor: true, vaultLocked: true, resolverRestored: true });
  assert.ok(t.handles.every((h) => h.closed)); assert.equal(t.vault.unlocked, false); assert.ok(t.tor.stops >= 1); assert.equal(t.svc.cases.size, 0); assert.equal(t.svc.status('k1'), null);
  for (const s of t.el.sessions.values()) for (const c of ['clearStorageData', 'clearCache', 'clearAuthCache', 'clearHostResolverCache', 'closeAllConnections']) assert.ok(s.calls.includes(c), s.name + ' ' + c);
  assert.ok(t.events.some(([n]) => n === 'killed'));
  assert.equal((await t.svc.kill()).report.windows, 0, 'safe to press twice');
});
test('closing a case window wipes its session, forgets its grants and rules', async () => {
  const t = setup(); await t.svc.open({ caseId: 'w' }); t.svc.allowHost('w', 'example.org'); const s = [...t.el.sessions.values()][0];
  await t.svc.close('w'); assert.ok(s.calls.includes('clearStorageData') && s.calls.includes('clearCache')); assert.deepEqual(t.svc.policy.allowed('w'), []);
  await t.svc.open({ caseId: 'w' }); assert.deepEqual(t.svc.policy.allowed('w'), [], 'a new window for the same case starts clean');
});
test('Tor dropping while a window is open turns the chip red and pushes state', async () => {
  const t = setup(); await t.svc.open({ caseId: 'x' }); t.events.length = 0; t.tor.stop();
  const last = t.events.filter(([n]) => n === 'state').pop()[1]; assert.equal(last.tone, 'bad');
});
