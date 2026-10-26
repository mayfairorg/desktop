'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AdEngine, exceptionFilter, looksLikeList, dueForUpdate } = require('../src/main/lib/adblock-engine');
const manifest = require('../src/main/lib/filter-lists.json');

const LIST = (n) => `[Adblock Plus 2.0]\n! Title: t${n}\n! Version: 2026.${n}\n||ads.example^\n##.banner\n@@||ok.example^\n` + '||filler.example^\n'.repeat(20);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-ad-'));

function fakeGhostery() {
  const made = [];
  class B {
    constructor(text) { this.text = text; this.enabled = new Set(); this.diffs = []; this.res = null; this.h = {}; made.push(this); }
    static parse(text, cfg) { B.cfg = cfg; return new B(text); }
    on(e, f) { this.h[e] = f; }
    enableBlockingInSession(s) { this.enabled.add(s); }
    disableBlockingInSession(s) { this.enabled.delete(s); }
    updateFromDiff(d) { this.diffs.push(d); }
    updateResources(r) { this.res = r; }
  }
  return { ElectronBlocker: B, made };
}
const mk = (over = {}) => {
  const g = fakeGhostery(); const dir = tmp();
  const bundled = path.join(dir, 'bundled'); fs.mkdirSync(bundled);
  for (const [i, l] of manifest.lists.entries()) fs.writeFileSync(path.join(bundled, l.file), LIST(i));
  const e = new AdEngine({ ghostery: g, manifest, bundledDir: bundled, userDir: path.join(dir, 'user'), fetchText: async (u) => LIST(99), ...over });
  return { e, g, dir, bundled };
};

test('manifest covers EasyList, EasyPrivacy and the uBlock lists with licences and credits', () => {
  const ids = manifest.lists.map((l) => l.id);
  for (const id of ['easylist', 'easyprivacy', 'ublock-filters', 'ublock-annoyances', 'ublock-quick-fixes']) assert.ok(ids.includes(id), id);
  for (const l of manifest.lists) { assert.ok(l.license && l.credit && l.homepage && l.name); assert.ok(l.url.startsWith('https://')); assert.match(l.file, /^[a-z0-9-]+\.txt$/); }
  assert.equal(new Set(manifest.lists.map((l) => l.file)).size, manifest.lists.length);
  assert.ok(manifest.resources.startsWith('https://'));
});
test('site exception filter: only valid hosts, whole-site $document', () => {
  assert.equal(exceptionFilter('Example.com'), '@@||example.com^$document');
  for (const bad of ['', 'a b', 'x.com/path', '||x.com', 'x', null, 'x.com^$script']) assert.equal(exceptionFilter(bad), null, String(bad));
});
test('list sanity check refuses HTML error pages and tiny files', () => {
  assert.equal(looksLikeList(LIST(1)), true);
  assert.equal(looksLikeList('<!doctype html><html>' + 'x'.repeat(500)), false);
  assert.equal(looksLikeList('! tiny'), false);
  assert.equal(looksLikeList(null), false);
});
test('update schedule', () => {
  const day = 86400000;
  assert.equal(dueForUpdate(0, 1000), true); assert.equal(dueForUpdate(NaN, 1000), true);
  assert.equal(dueForUpdate(1000, 1000 + day), false); assert.equal(dueForUpdate(1000, 1000 + 3 * day), true); assert.equal(dueForUpdate(5000, 1000), true);
});
test('loads bundled lists, enables blocking in sessions, counts rules', async () => {
  const { e, g } = mk();
  const s1 = { n: 1 }; e.enable(s1);
  assert.equal(e.active, false);
  assert.equal(await e.load(), true);
  assert.equal(e.active, true); assert.equal(e.info.engine, 'ghostery');
  assert.ok(e.info.rules > 100);
  assert.equal(e.info.lists.filter((l) => l.loaded && l.source === 'bundled').length, manifest.lists.length);
  assert.equal(e.info.lists[0].version, '2026.0');
  assert.equal(g.ElectronBlocker.cfg.loadCosmeticFilters, true);
  assert.equal(g.made[0].enabled.has(s1), true, 'session enabled after load');
  e.disable(s1); assert.equal(g.made[0].enabled.has(s1), false);
});
test('works with zero browser extensions: no extension API is touched', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/lib/adblock-engine.js'), 'utf8');
  assert.ok(!/loadExtension|extensions\./.test(src));
});
test('falls back to the basic blocker and says why when the library or lists are missing', async () => {
  const none = new AdEngine({ ghostery: null, manifest, bundledDir: '/nope', userDir: tmp(), fetchText: async () => '' });
  assert.equal(await none.load(), false); assert.equal(none.info.engine, 'basic'); assert.match(none.info.error, /not installed/);
  const g = fakeGhostery();
  const empty = new AdEngine({ ghostery: g, manifest, bundledDir: '/nope', userDir: tmp(), fetchText: async () => '' });
  assert.equal(await empty.load(), false); assert.match(empty.info.error, /No filter lists/);
});
test('per-site off and on uses $document exceptions; allow-list restored at load', async () => {
  const { e, g } = mk({ allow: ['kept.example'] });
  await e.load();
  assert.deepEqual(g.made[0].diffs[0], { added: ['@@||kept.example^$document'] });
  assert.equal(e.setSiteOff('news.example', true), true); assert.equal(e.isSiteOff('news.example'), true);
  assert.deepEqual(g.made[0].diffs.at(-1), { added: ['@@||news.example^$document'] });
  e.setSiteOff('news.example', false);
  assert.deepEqual(g.made[0].diffs.at(-1), { removed: ['@@||news.example^$document'] }); assert.equal(e.isSiteOff('news.example'), false);
  assert.equal(e.setSiteOff('bad host', true), false);
});
test('blocked and redirected requests are counted through the event', async () => {
  const { e, g } = mk(); await e.load();
  let n = 0; e.on('blocked', () => n++);
  g.made[0].h['request-blocked']({ tabId: 5 }); g.made[0].h['request-redirected']({ tabId: 5 });
  assert.equal(n, 2);
});
test('update downloads every list, keeps old copy on failure, swaps the engine and re-enables sessions', async () => {
  let calls = 0;
  const { e, g, dir } = mk({ fetchText: async (u) => { calls++; if (u.includes('badware')) throw new Error('HTTP 404'); if (u.includes('privacy.min')) return '<html>nope</html>'; return LIST(77); } });
  const s = { n: 2 }; e.enable(s); await e.load();
  const r = await e.update({ force: true });
  assert.equal(calls, manifest.lists.length + 1);
  assert.deepEqual(r.failed.map((f) => f.id).sort(), ['ublock-badware', 'ublock-privacy']);
  assert.ok(r.done.includes('easylist') && r.done.includes('resources'));
  assert.equal(g.made.length, 2, 'engine rebuilt');
  assert.equal(g.made[0].enabled.size, 0, 'old engine released the session'); assert.equal(g.made[1].enabled.has(s), true);
  assert.equal(g.made[1].res !== null, true, 'scriptlet resources loaded'); assert.equal(e.info.scriptlets, true);
  assert.match(fs.readFileSync(path.join(dir, 'user', 'easylist.txt'), 'utf8'), /Version: 2026\.77|t77/);
  assert.equal(fs.existsSync(path.join(dir, 'user', 'ublock-privacy.txt')), false, 'bad download not stored');
  assert.equal(e.info.lists.find((l) => l.id === 'easylist').source, 'updated');
  assert.equal(e.info.lists.find((l) => l.id === 'ublock-badware').source, 'bundled');
  const again = await e.update();
  assert.equal(again.skipped, true, 'not due yet');
});
