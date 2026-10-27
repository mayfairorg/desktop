'use strict';
// Ghost Quick notes: storage in the vault (round trip, restart, sealed on disk, caps, clean-up), through the service, and the report appendix.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const N = require('../src/ui/ghost/qn-model');
const M = require('../src/ui/ghost/case-model');
const R = require('../src/main/ghost/app/report');
const NR = require('../src/main/ghost/app/notes-report');
const { NoteStore, NoteError } = require('../src/main/ghost/app/notes');
const { GhostService } = require('../src/main/ghost');
const { tmp, fakeOS, FAST, mockServer, makeApp, signInTo, acceptTerms } = require('./ghost-app-helpers');

const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const T0 = Date.UTC(2026, 9, 27, 9, 30, 0);
const CASE = 'case-aaaa-1111-bbbb';
const clock = { t: T0 };
const open = (root) => { const g = new GhostService({ root, dialog: {}, isPackaged: false, safeStorage: fakeOS(), useVault: true, vaultOptions: FAST }); return { g, s: new NoteStore({ vault: g.vaultSvc.vault, now: () => clock.t }) }; };
const png = (n, seed = 1) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.createHash('sha512').update(String(seed)).digest(), Buffer.alloc(n)]);

// A note document with text, rich text, a link, a picture and a file, a highlight with a comment and a second tab.
function sample(store, scope) {
  const doc = N.newDoc(scope, T0), img = png(2000, 'shot');
  const b = store.putBlob(scope, img), fb = store.putBlob(scope, Buffer.from('%PDF-1.4 SEALED-FILE-MARKER'));
  const rich = N.sanitizeHtml('<h1>Heading SEALED-RICH-MARKER</h1><p>Body <b>bold</b></p>');
  const clips = [
    N.makeClip({ kind: 'text', text: 'Plain note SEALED-TEXT-MARKER about northwind-freight.example', hash: sha('p') }, { now: T0, from: { kind: 'ghost-browser', label: 'Ghost browser: Registry', url: 'https://reg.example/co/42', auto: true } }),
    N.makeClip({ kind: 'rich', tree: rich.tree, text: rich.text, hash: sha('r') }, { now: T0 + 1000, from: { kind: 'tool', label: 'Tool: RDAP', url: '', auto: true } }),
    N.makeClip({ kind: 'link', url: 'https://news.example/story', title: 'The story', text: 'https://news.example/story', hash: sha('l') }, { now: T0 + 2000 }),
    N.makeClip({ kind: 'image', title: 'Shopfront', image: { blob: b.id, mime: 'image/png', bytes: b.bytes, w: 10, h: 8, name: 'shop.png' }, hash: b.sha256 }, { now: T0 + 3000, from: { kind: 'capture-screen', label: 'Screen capture: Viewer', url: '', auto: true } }),
    N.makeClip({ kind: 'file', title: 'Filing', file: { blob: fb.id, name: 'filing.pdf', mime: 'application/pdf', bytes: fb.bytes }, hash: fb.sha256 }, { now: T0 + 4000 }),
  ];
  N.addClips(doc, doc.active, clips, T0); N.addHighlight(doc, clips[0].id, { a: 0, b: 5, color: 'yellow', comment: 'check <this> "carefully"' }, T0); N.addTag(doc, clips[0].id, 'lead', T0);
  const t2 = N.addTab(doc, 'Scratch', T0).tab; N.addClips(doc, t2.id, [N.makeClip({ kind: 'text', text: 'Scratch only SECRET-SCRATCH-MARKER', hash: sha('s') }, { now: T0 })], T0);
  doc.tabs[0].report = true; doc.active = doc.tabs[0].id;
  return { doc, clips, b, fb };
}

test('round trip: a document with every kind of clip is saved, read back identical, and survives a restart', () => {
  const root = tmp('mfd-qn-'); let { g, s } = open(root);
  const { doc, b } = sample(s, CASE); const json = JSON.stringify(doc); s.put(CASE, json);
  assert.equal(s.get(CASE).json, json); assert.deepEqual(N.validate(JSON.parse(s.get(CASE).json)), []); assert.ok(s.getBlob(CASE, b.id).equals(png(2000, 'shot')));
  g.shutdown(); ({ g, s } = open(root));                                  // a new process on the same folder: the vault opens with this computer's key store
  const back = s.get(CASE); assert.equal(back.json, json); assert.equal(back.usage.blobs, 2); assert.ok(s.getBlob(CASE, b.id).equals(png(2000, 'shot')));
  assert.equal(s.get('inbox').json, null, 'another scope is separate'); g.shutdown();
});
test('everything is sealed: no marker from a note, a picture or a file appears on disk', () => {
  const root = tmp('mfd-qn-'); const { g, s } = open(root); const { doc } = sample(s, CASE); s.put(CASE, JSON.stringify(doc));
  const files = walk(root).filter((f) => f.endsWith('.mfv')); assert.ok(files.length >= 4, 'document and blobs are records of their own');
  for (const f of walk(root)) { const b = fs.readFileSync(f); for (const m of ['SEALED-TEXT-MARKER', 'SEALED-RICH-MARKER', 'SEALED-FILE-MARKER', 'SECRET-SCRATCH-MARKER', 'northwind-freight', 'Shopfront', 'reg.example', 'PNG']) assert.equal(b.includes(Buffer.from(m)), false, m + ' in ' + f); }
  g.shutdown();
});
test('autosave replaces the document; undo/redo states are just later saves; closed tabs and their pictures are kept', () => {
  const { g, s } = open(tmp('mfd-qn-')); const { doc } = sample(s, CASE); s.put(CASE, JSON.stringify(doc));
  const closed = doc.tabs[0].id; N.closeTab(doc, closed, T0); s.put(CASE, JSON.stringify(doc));
  const back = JSON.parse(s.get(CASE).json); assert.equal(back.closed.length, 1); assert.equal(back.closed[0].tab.id, closed); assert.equal(s.get(CASE).usage.blobs, 2, 'pictures in a closed tab are not cleaned away');
  N.restoreTab(doc, closed, T0); s.put(CASE, JSON.stringify(doc)); assert.equal(JSON.parse(s.get(CASE).json).closed.length, 0); g.shutdown();
});
test('put refuses: wrong scope, bad scope names, unknown format, a foreign tag, oversize, garbage', () => {
  const { g, s } = open(tmp('mfd-qn-')); const doc = N.newDoc(CASE, T0);
  assert.throws(() => s.put('inbox', JSON.stringify(doc)), (e) => e.code === 'bad-notes'); assert.throws(() => s.put('../x', JSON.stringify(doc)), (e) => e.code === 'bad-scope'); assert.throws(() => s.get('a b'), (e) => e.code === 'bad-scope');
  assert.throws(() => s.put(CASE, '{nope'), (e) => e.code === 'bad-notes'); assert.throws(() => s.put(CASE, JSON.stringify({ ...doc, format: 'x' })), (e) => e.code === 'invalid');
  const rich = N.sanitizeHtml('<p><b>x</b></p>'); const c = N.makeClip({ kind: 'rich', tree: rich.tree, text: rich.text, hash: sha('r') }, { now: T0 }); N.addClips(doc, doc.active, [c], T0); c.tree = [{ t: 'script', c: ['x'] }];
  assert.throws(() => s.put(CASE, JSON.stringify(doc)), (e) => e.code === 'invalid');
  assert.throws(() => s.put(CASE, 'x'.repeat(N.LIMITS.docBytes + 1)), (e) => e.code === 'too-large'); assert.ok(NoteError); g.shutdown();
});
test('pictures: the same bytes make one record, the cap is 8 MB each and 128 MB a case, unreferenced ones are cleaned up on the next open', () => {
  const { g, s } = open(tmp('mfd-qn-')); const vault = g.vaultSvc.vault;
  const a = s.putBlob(CASE, png(100, 1)), a2 = s.putBlob(CASE, png(100, 1)); assert.equal(a.id, a2.id); assert.equal(vault.list('cases').filter((n) => n.startsWith('qb-')).length, 1);
  assert.throws(() => s.putBlob(CASE, Buffer.alloc(N.LIMITS.blobBytes + 1, 1)), (e) => e.code === 'too-large'); assert.throws(() => s.putBlob(CASE, Buffer.alloc(0)), (e) => e.code === 'empty');
  assert.throws(() => s.getBlob(CASE, 'zz'), (e) => e.code === 'bad-id'); assert.throws(() => s.getBlob(CASE, 'f'.repeat(16)), (e) => e.code === 'missing');
  const keepB = s.putBlob(CASE, png(50, 2)); const doc = N.newDoc(CASE, T0);
  N.addClips(doc, doc.active, [N.makeClip({ kind: 'image', title: '', image: { blob: keepB.id, mime: 'image/png', bytes: keepB.bytes, w: 1, h: 1, name: 'k.png' }, hash: keepB.sha256 }, { now: T0 })], T0); s.put(CASE, JSON.stringify(doc));
  clock.t += 11 * 60 * 1000; const pend = s.putBlob(CASE, png(60, 3));                      // uploaded just now, not in the saved document yet (the page is about to save); the first one is long past that
  assert.equal(s.get(CASE).json !== null, true); const names = vault.list('cases').filter((n) => n.startsWith('qb-')).map((n) => n.slice(-16));
  assert.ok(names.includes(keepB.id) && names.includes(pend.id) && !names.includes(a.id), 'the unreferenced one went, the saved one and the pending one stayed');
  // quota: fill with 8 MB pictures (distinct bytes) until the case is full
  let n = 0; assert.throws(() => { for (; n < 40; n++) s.putBlob('quota-case-0001', Buffer.concat([png(1, 'q' + n), Buffer.alloc(8 * 1024 * 1024 - 100, n + 1)])); }, (e) => e.code === 'quota'); assert.ok(n >= 15 && n <= 16, 'stopped at ' + n);
  clock.t = T0; g.shutdown();
});
test('notes that cannot be read are kept aside, not thrown away; deleting a case removes its notes and pictures', () => {
  const { g, s } = open(tmp('mfd-qn-')); const vault = g.vaultSvc.vault;
  vault.put('cases', 'qn-' + CASE, '{"format":"mayfair-ghost-notes/1","scope":"' + CASE + '","tabs":"bad"}');
  const r = s.get(CASE); assert.equal(r.json, null); assert.equal(r.broken, true); assert.ok(vault.list('cases').includes('qx-' + CASE));
  const { doc } = sample(s, CASE); s.put(CASE, JSON.stringify(doc)); assert.ok(vault.list('cases').filter((x) => x.includes(CASE)).length >= 4);
  s.deleteScope(CASE); assert.deepEqual(vault.list('cases').filter((x) => x.includes(CASE)), []); g.shutdown();
});

// ---------- through the service: gate, case delete, report ----------
test('service: notes follow the case; deleting the case deletes its notes; the report appendix prints only the chosen tabs, with provenance', async () => {
  const m = await mockServer(); const out = path.join(tmp('mfd-qn-out-'), 'report.html');
  const h = makeApp(m, { dialog: { showMessageBox: async () => ({ response: 0 }), showSaveDialog: async () => ({ canceled: false, filePath: out }) } });
  await signInTo(h); assert.equal(acceptTerms(h.app).ok, true); const A = h.app;
  const { id, json } = A.caseCreate('Northwind <review>'); const c = JSON.parse(json);
  const { doc, clips } = sample(A.notes, id); doc.scope = id; A.notes.put(id, JSON.stringify(doc));
  const sc = JSON.parse(A.caseGet(id)); assert.equal(sc.id, id);
  const sent = N.sendToCase(M, c, clips[0], { mode: 'new', type: 'domain', value: 'northwind-freight.example', now: T0 }); assert.ok(sent.entityId); N.markSent(doc, clips[0].id, { entityId: sent.entityId, label: 'northwind-freight.example', caseId: id }, T0); A.notes.put(id, JSON.stringify(doc));
  A.casePut(id, JSON.stringify(c));
  const tabs = [doc.tabs[0].id];
  const res = await A.reportSave({ json: JSON.stringify(c), format: 'html', author: 'A', notesTabs: tabs }); assert.equal(res.saved, true);
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes('Appendix: Quick notes')); assert.ok(html.includes('SEALED-TEXT-MARKER')); assert.ok(html.includes('Ghost browser: Registry')); assert.ok(html.includes('https://reg.example/co/42')); assert.ok(html.includes('Tool: RDAP'));
  assert.ok(html.includes(sha('p')), 'the full item hash is printed'); assert.ok(html.includes('Screen capture: Viewer')); assert.ok(html.includes('data:image/png;base64,'), 'the picture is embedded, not linked');
  assert.equal(html.includes('SECRET-SCRATCH-MARKER'), false, 'a tab that was not chosen stays out'); assert.ok(html.includes('check &lt;this&gt; &quot;carefully&quot;')); assert.ok(html.includes('<mark class="h h-yellow">'));
  assert.ok(html.includes('northwind-freight.example') && html.includes('Sent to the case board as'));
  assert.equal(/<script|onerror=|<iframe/i.test(html), false); assert.equal(/(src|href)=["']https?:\/\/(?!reg\.example|news\.example)/i.test(html), false);
  assert.ok(html.includes('Made with Mayfair Ghost. Copyright The Mayfair Organization.'));
  const without = await A.reportSave({ json: JSON.stringify(c), format: 'html', author: 'A' }); assert.equal(without.saved, true); const plain = fs.readFileSync(out, 'utf8'); assert.equal(plain.includes('Appendix: Quick notes'), false);
  const jr = await A.reportSave({ json: JSON.stringify(c), format: 'json', author: 'A', notesTabs: [doc.tabs[1].id] }); assert.equal(jr.saved, true); const jj = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(jj.quickNotes.tabs.length, 1); assert.equal(jj.quickNotes.tabs[0].title, 'Scratch'); assert.equal(/<script/.test(JSON.stringify(jj)), false);
  A.caseDelete(id); assert.deepEqual(h.ghost.vaultSvc.vault.list('cases').filter((x) => x.includes(id)), []);
  await (async () => { try { h.app.shutdown && h.app.shutdown(); h.ghost.shutdown(); } catch { /* ok */ } await m.close(); })();
});

// ---------- the appendix itself ----------
test('appendix: provenance, hashes and highlights per clip; the report hash covers it; nothing from an unchosen tab; pictures over the cap are left out', () => {
  const { g, s } = open(tmp('mfd-qn-')); const { doc, clips } = sample(s, CASE); s.put(CASE, JSON.stringify(doc));
  assert.equal(NR.build({ store: s, caseId: CASE, tabs: [] }), null); assert.equal(NR.build({ store: s, caseId: CASE, tabs: ['nope'] }), null); assert.equal(NR.build({ store: s, caseId: 'inbox', tabs: [doc.tabs[0].id] }), null);
  const q = NR.build({ store: s, caseId: CASE, tabs: [doc.tabs[0].id] });
  assert.equal(q.data.tabs.length, 1); assert.equal(q.data.tabs[0].clips.length, 5); const first = q.data.tabs[0].clips.find((x) => x.id === clips[0].id);
  assert.deepEqual([first.hash, first.from.label, first.from.url, first.saved], [sha('p'), 'Ghost browser: Registry', 'https://reg.example/co/42', '2026-10-27T09:30:00.000Z']); assert.equal(first.highlights[0].comment, 'check <this> "carefully"');
  assert.equal(JSON.stringify(q.data).includes('base64'), false, 'the data that is hashed holds no picture bytes');
  const mkc = () => { const c = M.newCase('t', T0); M.addEntity(c, { type: 'domain', value: 'a.example', manual: true }); return c; }; const c = mkc();
  const h1 = R.reportHtml(c, { now: T0, quickNotes: q }), h2 = R.reportHtml(c, { now: T0 }), q2 = NR.build({ store: s, caseId: CASE, tabs: doc.tabs.map((t) => t.id) });
  const hash = (html) => /Report data SHA-256: <span class="m">([0-9a-f]{64})/.exec(html)[1];
  assert.notEqual(hash(h1), hash(h2)); assert.notEqual(hash(h1), hash(R.reportHtml(c, { now: T0, quickNotes: q2 })));
  assert.equal(hash(R.reportHtml(c, { now: T0 })), hash(h2), 'a report without the appendix is exactly as before');
  assert.ok(h1.indexOf('Appendix: Quick notes') < h1.indexOf('Report data SHA-256'), 'the appendix comes before the footer');
  NR.IMG_TOTAL_CAP; const big = NR.build({ store: Object.assign(Object.create(Object.getPrototypeOf(s)), s, { getBlob: () => Buffer.alloc(10) }), caseId: CASE, tabs: [doc.tabs[0].id] }); assert.ok(big.html.includes('data:image/png;base64,'));
  g.shutdown();
});
