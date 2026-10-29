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
  const order = ['scope-parse', 'case-model', 'modules', 'merge', 'util', 'graph', 'casesvc', 'flow', 'shell', 'screens', 'module', 'workspace', 'results', 'places', 'board', 'app'].map((n) => scripts.findIndex((s) => s === n + '.js'));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), String(order));
  assert.ok(html.includes('mf-tokens.css') && html.includes('ghost.css') && html.includes('workspace.css'));
  assert.ok(html.indexOf('workspace.css') > html.indexOf('layouts.css'), 'the workspace styles come after the skin layouts');
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
test('the connector cards remain for Tool Integrations, Security tools and Active scanning, and the not-installed state is labelled', () => {
  const mod = read('module.js'); assert.ok(mod.includes("'Not installed'")); for (const l of ['Needs your approval', 'Not tested', 'Test passed', 'Program missing']) assert.ok((mod + read('modules.js')).includes(l), l);
  assert.equal(/Set up built-in lookups|setupBuiltins|Review and approve/.test(read('workspace.js') + read('results.js') + read('screens.js') + read('shell.js') + read('workspace.css')), false, 'the Workspace has no approval or set-up step');
  assert.equal(/setupBuiltins|Set up built-in lookups/.test(mod), false, 'the set-up panel for the lookups that ship with Mayfair is gone');
  const places = read('places.js'); assert.ok(/BASEMAP NOT INSTALLED/.test(places) && /NOT CONNECTED/.test(places));
  const M = require('../src/ui/ghost/modules'); assert.deepEqual(M.MODULES.map((m) => m.id), ['domains', 'infra', 'companies', 'files', 'places', 'news', 'archive', 'threat', 'scan']);
  assert.equal(M.MODULES.filter((m) => m.scope === 'active').length, 1);
});
test('the preload exposes a frozen object with no command or path call', () => {
  const p = read('preload.js'); assert.ok(/Object\.freeze\(\{\s*status/.test(p)); assert.equal(/exec|spawn|readFile|path\b/.test(p.replace(/\/\/.*$/gm, '')), false);
});

// ---------- the Workspace ----------
test('Workspace: the routes, the nav and the three ways in', () => {
  const ws = read('workspace.js'), res = read('results.js'), shell = read('shell.js'), scr = read('screens.js');
  for (const r of ['workspace', 'search', 'tool']) assert.match(ws, new RegExp('GH\\.routes\\.' + r + ' = '), r);
  assert.match(scr, /GH\.routes\.home[\s\S]{0,200}GH\.routes\.workspace\(\)/, 'Mayfair Home is the Workspace');
  assert.match(res, /GH\.results = \{/);
  assert.ok(shell.includes("'workspace', 'Workspace'") && shell.includes("'All tools'") && shell.includes("GH.href('tool')"), 'the rail lists the Workspace and the tools');
  assert.equal(/MODS\.map|\.\.\.MODS/.test(shell), false, 'the old module list is not in any navigation');
  assert.ok(shell.includes("'Case board'") && shell.includes("'Tool Integrations'") && shell.includes('nav-term') && shell.includes("'Settings'"), 'case board, Tool Integrations, Terminal and Settings stay');
  assert.match(ws, /e\.key !== '\/'/, 'the / key');
  assert.ok(/GH\.submitLookup = /.test(ws), 'the lookup boxes of the skin layouts go to the master search');
});
test('Workspace: only the closed list of kinds, nothing about people, honest states in plain words', () => {
  const ws = read('workspace.js'), M = require('../src/ui/ghost/modules');
  const kinds = M.INPUT_KINDS.filter((k) => !['entity', 'rules-file', 'log-file', 'instance-url'].includes(k));
  assert.deepEqual(kinds, ['domain', 'ip', 'cidr', 'asn', 'url', 'cert-hash', 'org-name', 'lei', 'file', 'place-text', 'coords', 'keyword']);
  for (const k of kinds) assert.ok(ws.includes("'" + k + "'") || ws.includes(k + ':'), k + ' has a label');
  for (const l of ['Ready', 'Setting up', 'Ghost computer', 'Switched off', 'Not working', 'Tested', 'Test failed', 'Checking', 'Understood as', 'Will ask ', 'Nothing searched in this window yet']) assert.ok(ws.includes(l), l);
  assert.ok(ws.includes('gapp:builtins.status') && ws.includes('gapp:search.run'), 'the calls are named in the file');
  assert.equal(/\bAI\b|Claude|Anthropic|assistant|generated/i.test(ws + read('results.js')), false, 'no authorship text');
});
test('Results: a real tab strip (roles, roving focus, arrow keys), a badge on every tab, tables and no cards', () => {
  const src = read('results.js');
  for (const k of ["role: 'tablist'", "role: 'tab'", "role: 'tabpanel'", "'aria-selected'", "'aria-controls'", 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'aria-live', 'ws-badge']) assert.ok(src.includes(k), k);
  for (const k of ['running', 'error', 'none', 'waiting']) assert.ok(src.includes("'" + k + "'"), 'badge ' + k);
  assert.equal(/\bccard\b|\.card\b|class: 'card/.test(src + read('workspace.js')), false, 'no cards');
  assert.ok(src.includes('Nothing found') && src.includes('No tool could answer') && src.includes('does not prove nothing'), 'empty and error states say what happened');
  assert.ok(src.includes('MG.toIngest') && src.includes('GH.cs.addResults'), 'add to case goes through the case store');
});
test('workspace.css: tokens only, no own radius, no icon chips, narrow and coarse-pointer rules, reduced motion', () => {
  const css = read('workspace.css');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'no hex colour');
  assert.equal(/url\(|data:|@import/i.test(css), false);
  for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) assert.match(m[1].trim(), /^(var\(--mf-r-[a-z]+\)|0)(\s|$)/, 'radius ' + m[1]);
  assert.equal(/font-size:\s*\d/.test(css), false, 'no font size by hand');
  assert.equal(/\.chip-ico|\.ico-chip|icon-chip|\.ico-bg|\.tint/.test(css), false);
  assert.match(css, /@container ws \(max-width:640px\)/); assert.match(css, /pointer:coarse/); assert.match(css, /prefers-reduced-motion:reduce/);
});
