'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mockServer, makeApp, signInTo, acceptTerms } = require('./ghost-app-helpers');

const done = async (h, m) => { try { h.app.shutdown && h.app.shutdown(); h.ghost.shutdown(); } catch { /* ok */ } await m.close(); };

test('stage machine: download, sign in, terms, ready, with no question about keys or purpose', async () => {
  const m = await mockServer(); const h = makeApp(m);
  assert.equal(h.app.stage(), 'download');
  assert.equal(h.app.libraryEntry().category, 'Research'); assert.equal(h.app.libraryEntry().preinstalled, false);
  await signInTo(h, 'terms');
  assert.equal(h.app.status().entitlement.approved, true);
  assert.ok(h.opened.some((u) => u.startsWith(m.base + '/oauth/device')), 'sign-in page opened on the ID address');
  assert.equal(h.app.status().terms.accepted, false);
  assert.equal((await h.app.casesList === undefined), false);
  assert.throws(() => h.app.casesList(), /Finish the start steps/);
  assert.equal(acceptTerms(h.app).ok, true); assert.equal(h.app.stage(), 'ready');
  assert.deepEqual(h.app.casesList(), []);
  await done(h, m);
});
test('terms are accepted once per version, and only the current text', async () => {
  const m = await mockServer(); const h = makeApp(m); await signInTo(h);
  assert.equal(h.app.termsAccept({ version: '0.1', sha256: 'x', lawful: true }).ok, false);
  const T = require('../src/main/ghost/app/terms-text');
  assert.equal(h.app.termsAccept({ version: T.VERSION, sha256: T.SHA256, lawful: false }).ok, false);
  acceptTerms(h.app); assert.equal(h.app.stage(), 'ready');
  const h2 = makeApp(m, { root: h.root }); // a restart on the same folder
  assert.equal(h2.app.termsAccepted(), true);
  require('node:fs').writeFileSync(h.app.termsFile, JSON.stringify({ version: '0.0', sha256: T.SHA256, acceptedAt: new Date().toISOString() }));
  assert.equal(h.app.termsAccepted(), false, 'an older version asks again');
  h2.ghost.shutdown(); await done(h, m);
});
test('unapproved accounts get the apply screen, never the app; operators get every module', async () => {
  for (const status of ['none', 'pending', 'rejected', 'revoked']) {
    const m = await mockServer({ ent: { status } }); const h = makeApp(m); await signInTo(h, 'apply');
    assert.equal(h.app.status().entitlement.status, status); assert.equal(h.app.canUse('scanning'), false);
    assert.throws(() => h.app.casesList(), /Finish/); assert.equal(acceptTerms(h.app).ok, false);
    assert.equal(h.app.openApply().ok, true); assert.ok(h.opened.some((u) => u === m.base + '/ghost/apply'), 'the apply page opens on the ID address'); await done(h, m);
  }
  const m = await mockServer({ ent: { operator: true } }); const h = makeApp(m); await signInTo(h); acceptTerms(h.app);
  assert.equal(h.app.canUse('scanning'), true); assert.equal(h.app.canUse('geolocation'), true); assert.equal(h.app.status().entitlement.operator, true); await done(h, m);
});
test('an account that never applied (404) is shown the apply screen', async () => {
  const m = await mockServer({ ent: 404 }); const h = makeApp(m); await signInTo(h, 'apply'); assert.equal(h.app.status().entitlement.status, 'none'); await done(h, m);
});
test('approved accounts do not get scanning unless it is switched on', async () => {
  const m = await mockServer({ ent: { status: 'approved', modules: { scanning: false } } }); const h = makeApp(m); await signInTo(h); acceptTerms(h.app);
  assert.equal(h.app.canUse('scanning'), false);
  assert.throws(() => h.app.scopeDeclare({ target: 'example.org', basis: 'own', confirm: true }), (e) => e.code === 'module-off'); await done(h, m);
});
test('offline: the last good answer is used for 72 hours, then the app stops; a refusal applies at once', async () => {
  const m = await mockServer(); const h = makeApp(m); await signInTo(h); acceptTerms(h.app); assert.equal(h.app.stage(), 'ready');
  m.down = true; h.clock.t += 5 * 3600 * 1000; await h.app.checkEntitlement(); assert.equal(h.app.stage(), 'ready', 'inside the grace');
  h.clock.t += 80 * 3600 * 1000; await h.app.checkEntitlement(); assert.equal(h.app.stage(), 'offline');
  assert.throws(() => h.app.casesList(), /Finish/);
  m.down = false; await h.app.checkEntitlement(); assert.equal(h.app.stage(), 'ready');
  m.ent = { status: 'revoked' }; await h.app.checkEntitlement(); assert.equal(h.app.stage(), 'apply'); await done(h, m);
});
test('an expired approval is not trusted', async () => {
  const m = await mockServer(); const h = makeApp(m); await signInTo(h);
  m.ent = { status: 'approved', expiresAt: new Date(h.clock.t + 3600e3).toISOString() }; await h.app.checkEntitlement(); acceptTerms(h.app); assert.equal(h.app.stage(), 'ready');
  h.clock.t += 2 * 3600e3; m.down = true; await h.app.checkEntitlement(); assert.notEqual(h.app.stage(), 'ready'); await done(h, m);
});
test('the session survives a restart (sealed in the vault) and refresh tokens rotate', async () => {
  const m = await mockServer({ accessTtl: 300 }); const h = makeApp(m); await signInTo(h); acceptTerms(h.app);
  h.clock.t += 400e3; await h.app.checkEntitlement(); assert.equal(m.refreshes, 1); assert.equal(h.app.stage(), 'ready');
  h.ghost.shutdown();
  const h2 = makeApp(m, { root: h.root, clock: h.clock }); assert.equal(h2.app.stage(), 'ready', 'signed in again without asking');
  h2.app.signOut(); assert.equal(h2.app.stage(), 'signin'); h2.ghost.shutdown(); await m.close();
});
test('person-finding connectors are hidden and refused', async () => {
  const m = await mockServer(); const h = makeApp(m); await signInTo(h); acceptTerms(h.app);
  const bl = ['sherlock', 'maigret', 'blackbird', 'holehe', 'whatsmyname', 'WhatsMyName', 'people-search-x', 'username-check'];
  for (const id of bl) assert.equal(h.app._blocked({ id, name: id, capabilities: [] }), true, id);
  for (const id of ['dns-doh', 'rdap', 'gleif', 'nmap']) assert.equal(h.app._blocked({ id, name: id, capabilities: [] }), false, id);
  await assert.rejects(async () => h.app.jobRun({ connector: 'sherlock', input: {} }), (e) => e.code === 'missing' || e.code === 'blocked'); await done(h, m);
});
test('install: no components list (404) still installs; a server error does not', async () => {
  const m = await mockServer({ index: 404 }); const h = makeApp(m); assert.equal((await h.app.install()).ok, true); await done(h, m);
  const m2 = await mockServer({ index: { nope: 1 } }); const h2 = makeApp(m2); const r = await h2.app.install(); assert.equal(r.ok, false, 'a list that is not a list is a server error'); assert.equal(h2.app.installed(), false); await done(h2, m2);
});
test('uninstall asks first and keeps cases', async () => {
  const m = await mockServer(); const h = makeApp(m, { dialog: { showMessageBox: async () => ({ response: 1 }) } }); await h.app.install();
  assert.equal((await h.app.uninstall()).removed, false); assert.equal(h.app.installed(), true);
  h.app.dialog = { showMessageBox: async () => ({ response: 0 }) }; assert.equal((await h.app.uninstall()).removed, true); assert.equal(h.app.stage(), 'download'); await done(h, m);
});
test('the ID client only talks to the issuer', async () => {
  const { IdClient } = require('../src/main/ghost/app/id-client');
  assert.throws(() => new IdClient({ base: 'https://evil.example' }), /not allowed/);
  assert.throws(() => new IdClient({ base: 'http://127.0.0.1:9999' }), /not allowed/);
  assert.doesNotThrow(() => new IdClient({ base: 'http://127.0.0.1:9999', allowLoopback: true }));
  assert.throws(() => new IdClient({ base: 'http://localhost:9', allowLoopback: true }), /not allowed/);
});
