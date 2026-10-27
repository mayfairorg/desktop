'use strict';
// Static checks of the Ghost page: policy, skin rules, the hard line, and that every file the page loads exists and parses.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const dir = path.join(__dirname, '..', 'src', 'ui', 'ghost');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const html = read('index.html');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const pageJs = scripts.map((s) => [s, read(s)]);

test('index.html: strict CSP, no inline script or style, every script exists and parses, in the right order', () => {
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'/); assert.equal(/<script(?![^>]*src=)/.test(html), false); assert.equal(/\sstyle=/.test(html.replace(/<symbol[\s\S]*?<\/symbol>/g, '')), false); assert.equal(/\son[a-z]+=/i.test(html), false);
  for (const [s, src] of pageJs) { assert.doesNotThrow(() => new vm.Script(src, { filename: s }), s); assert.ok(fs.existsSync(path.join(dir, s))); }
  const order = ['scope-parse', 'case-model', 'modules', 'util', 'graph', 'casesvc', 'flow', 'shell', 'screens', 'module', 'places', 'board', 'app'].map((n) => scripts.findIndex((s) => s === n + '.js'));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), String(order));
  assert.ok(html.includes('mf-tokens.css') && html.includes('ghost.css'));
});
test('page code never sets inline style attributes, innerHTML, eval or remote addresses', () => {
  for (const [s, src] of pageJs) {
    assert.equal(/\.innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function|setAttribute\(\s*['"]style['"]/.test(src), false, s);
    assert.equal(/https?:\/\/(?!www\.w3\.org)/.test(src.replace(/\/\/.*$/gm, '').replace(/'(https:\/\/doh[^']*)'/g, '')), false, s + ' has a web address');
  }
});
test('skin: tokens only, no hex colours or own radius in ghost.css, no tinted icon chips', () => {
  const css = read('ghost.css'); assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false);
  assert.equal(/border-radius:\s*\d/.test(css), false);
  assert.equal(/\.chip-ico|\.ico-chip|icon-chip|\.ico-bg|\.tint/.test(css + pageJs.map((x) => x[1]).join('')), false);
  assert.ok(/prefers-reduced-motion/.test(css)); assert.ok(/pointer:coarse/.test(css)); assert.ok(/:focus-visible/.test(css));
});
test('hard line: no person inputs, no person tools anywhere in the page, modules or terms', () => {
  const M = require('../src/ui/ghost/modules');
  for (const k of M.INPUT_KINDS) assert.equal(/person|user|email|phone|face|name$/.test(k) && k !== 'org-name', false, k);
  const all = [html, ...pageJs.filter((x) => x[0] !== 'scope-parse.js').map((x) => x[1]), fs.readFileSync(path.join(dir, 'modules.js'), 'utf8')].join('\n');
  assert.equal(/(sherlock|maigret|blackbird|holehe|whatsmyname)/i.test(all.replace(/refusePersonQuery[^\n]*/g, '')), false);
  for (const m of M.MODULES) for (const [id] of m.wants) assert.equal(/sherlock|maigret|blackbird|holehe|whatsmyname/i.test(id), false, id);
});
test('copyright and wording: The Mayfair Organization only, no authorship claims about AI', () => {
  const all = [html, ...pageJs.map((x) => x[1]), read('ghost.css')].join('\n');
  for (const m of all.matchAll(/Copyright[^.\n]{0,60}/g)) assert.match(m[0], /The Mayfair Organization/);
  assert.equal(/\b(written|generated|built|made) (by|with) (an? )?(AI|Claude|Anthropic|ChatGPT|LLM)/i.test(all), false);
  const terms = require('../src/main/ghost/app/terms-text'); assert.equal(/\b(AI|Claude|Anthropic)\b/.test(JSON.stringify(terms.CLAUSES)), false);
});
test('each module screen exists and the not-installed state is labelled', () => {
  const mod = read('module.js'); assert.ok(mod.includes("'Not installed'")); for (const l of ['Needs your approval', 'Not tested', 'Test passed', 'Program missing']) assert.ok((mod + read('modules.js')).includes(l), l); assert.ok(mod.includes('Set up built-in lookups'));
  const places = read('places.js'); assert.ok(/BASEMAP NOT INSTALLED/.test(places) && /NOT CONNECTED/.test(places));
  const M = require('../src/ui/ghost/modules'); assert.deepEqual(M.MODULES.map((m) => m.id), ['domains', 'infra', 'companies', 'files', 'places', 'news', 'archive', 'threat', 'scan']);
  assert.equal(M.MODULES.filter((m) => m.scope === 'active').length, 1);
});
test('the preload exposes a frozen object with no command or path call', () => {
  const p = read('preload.js'); assert.ok(/Object\.freeze\(\{\s*status/.test(p)); assert.equal(/exec|spawn|readFile|path\b/.test(p.replace(/\/\/.*$/gm, '')), false);
});
