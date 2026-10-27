'use strict';
// Shared by the ghost-app-*.test.js files: a local stand-in for Mayfair ID and the cloud list, and a ready GhostApp on a throw-away folder.
const { mockServer, live: mockLive } = require('./ghost-app-mock');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GhostService } = require('../src/main/ghost');
const { GhostApp } = require('../src/main/ghost/app/service');
const { IdClient } = require('../src/main/ghost/app/id-client');

const live = { servers: mockLive.servers, ghosts: [], apps: [] };
require('node:test').after(async () => { for (const a of live.apps) { try { a.cancelSignin(); } catch { /* ok */ } } for (const g of live.ghosts) { try { g.shutdown(); } catch { /* ok */ } } for (const s of live.servers) { try { await s.close(); } catch { /* ok */ } } });
const tmp = (p = 'mfd-gapp-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const fakeOS = () => ({ isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('OS:' + Buffer.from(s).toString('hex')), decryptString: (b) => Buffer.from(b.toString().slice(3), 'hex').toString() });
const FAST = { kdfParams: { m: 64, t: 1, p: 1 }, allowWeakKdf: true, syncDebounceMs: 5 };

// A GhostApp over a real GhostService with the vault on (fake OS key store). `clock.t` can be moved to test expiry and the offline grace.
function makeApp(mock, over = {}) {
  const root = over.root || tmp(); const clock = over.clock || { t: Date.now() }; const events = [];
  const ghost = new GhostService({ root, dialog: { showMessageBox: async () => ({ response: 0 }) }, isPackaged: false, safeStorage: fakeOS(), useVault: true, vaultOptions: FAST, ...(over.ghost || {}) });
  const id = new IdClient({ base: mock.base, allowLoopback: true, now: () => clock.t });
  const opened = [];
  const app = new GhostApp({ userData: root, ghost, id, cloudBase: mock.base, allowLoopback: true, shell: { openExternal: (u) => opened.push(u) }, dialog: over.dialog || { showMessageBox: async () => ({ response: 0 }), showSaveDialog: async () => ({ canceled: true }) }, emit: (n, p) => events.push([n, p]), now: () => clock.t, version: '1.0.0-test', pollMinMs: 10, openTerminal: async () => true, openToolIntegrations: async () => true });
  live.ghosts.push(ghost); live.apps.push(app);
  return { app, ghost, root, clock, events, opened };
}
// Install, sign in, and wait until the stage settles (or a stage is reached).
async function signInTo(h, stage = 'terms') {
  const i = await h.app.install(); if (!i.ok) throw new Error('install: ' + i.error);
  const s = await h.app.signInStart(); if (!s.ok) throw new Error('signin: ' + s.error);
  for (let n = 0; n < 300; n++) { const st = h.app.stage(); if (st === stage) return h.app.status(); await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('stage ' + h.app.stage() + ' (wanted ' + stage + ')');
}
const T = require('../src/main/ghost/app/terms-text');
const acceptTerms = (app) => app.termsAccept({ version: T.VERSION, sha256: T.SHA256, lawful: true });
module.exports = { tmp, fakeOS, FAST, mockServer, makeApp, signInTo, acceptTerms };
