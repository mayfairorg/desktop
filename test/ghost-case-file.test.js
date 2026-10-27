'use strict';
// The case file calls: saving the open case as JSON through a save dialog, picking a case file to import or merge, and the argument checks on both channels.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../src/ui/ghost/case-model');
const { check } = require('../src/main/ghost/app/checks');
const { tmp, mockServer, makeApp, signInTo, acceptTerms } = require('./ghost-app-helpers');

const done = async (h, m) => { try { h.app.shutdown && h.app.shutdown(); h.ghost.shutdown(); } catch { /* ok */ } await m.close(); };

test('channels: case file export takes the case text, import pick takes nothing', () => {
  assert.equal(check('gapp:cases.exportJson', ['{}']).ok, true); assert.equal(check('gapp:cases.exportJson', [5]).ok, false); assert.equal(check('gapp:cases.exportJson', []).ok, false);
  assert.equal(check('gapp:cases.importPick', []).ok, true); assert.equal(check('gapp:cases.importPick', ['/etc/passwd']).ok, false);
});
test('export writes the case JSON to the chosen file and refuses an invalid case; import pick returns the text of the chosen file', async () => {
  const dir = tmp(); const target = path.join(dir, 'out.json'); let pickPath = target; let canceled = false;
  const m = await mockServer();
  const h = makeApp(m, { dialog: { showMessageBox: async () => ({ response: 0 }), showSaveDialog: async (a, b) => ({ canceled, filePath: (b || a).defaultPath && target }), showOpenDialog: async () => ({ canceled, filePaths: [pickPath] }) } });
  await signInTo(h); acceptTerms(h.app);
  const c = M.newCase('Board <1>'); const o = M.addEntity(c, { type: 'org', value: 'Acme', manual: true }).id; M.addField(c, o, { title: 'Home address', value: '1 Test Road', source: 'filing' });
  const r = await h.app.caseExportJson(JSON.stringify(c));
  assert.equal(r.saved, true); assert.equal(r.name, 'out.json'); assert.deepEqual(M.importJson(fs.readFileSync(target, 'utf8')).case, c);
  await assert.rejects(() => h.app.caseExportJson(JSON.stringify({ ...c, format: 'x' })), /Unknown case format/);
  await assert.rejects(() => h.app.caseExportJson('not json'), /could not be read/);
  const p = await h.app.caseImportPick(); assert.equal(p.picked, true); assert.equal(p.name, 'out.json'); assert.equal(M.importJson(p.text).problems.length, 0);
  canceled = true; assert.deepEqual(await h.app.caseImportPick(), { picked: false }); assert.deepEqual(await h.app.caseExportJson(JSON.stringify(c)), { saved: false });
  canceled = false; pickPath = dir; await assert.rejects(() => h.app.caseImportPick(), /not a case file/);
  await done(h, m);
});
test('the page preload exposes exactly these two new calls and window.js routes them', () => {
  const pre = fs.readFileSync(path.join(__dirname, '../src/ui/ghost/preload.js'), 'utf8'), win = fs.readFileSync(path.join(__dirname, '../src/main/ghost/app/window.js'), 'utf8');
  for (const ch of ['gapp:cases.exportJson', 'gapp:cases.importPick']) { assert.ok(pre.includes(ch), ch); assert.ok(win.includes(ch), ch); }
});
