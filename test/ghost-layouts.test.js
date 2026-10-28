'use strict';
// Ghost skin layouts: each skin other than Mayfair has its own layout (frame, Home, module screens, case board summary), every number comes from this computer,
// empty inputs give empty results (never sample data), colours pass AA on the surfaces the layouts use, and the drawn page is checked in the real window
// at 1280, 1024, 768 and 390 wide (structure, empty and filled data, reflow, keyboard, reduced motion, contrast, picker).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const H = require('./ghost-skins-helpers');
const K = require('../src/ui/ghost/skins');
const L = require('../src/ui/ghost/lay-core');
const M = require('../src/ui/ghost/case-model');
const MODS = require('../src/ui/ghost/modules');
const dir = path.join(__dirname, '..', 'src', 'ui', 'ghost');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

// ---------- the skins and their layouts ----------
test('every skin names its layout; Mayfair keeps the sidebar and the others each have their own', () => {
  assert.deepEqual(K.SKINS.map((s) => [s.id, s.layout]), [['mayfair', 'sidebar'], ['terminal', 'panel-grid'], ['hud', 'ring-hud'], ['mono', 'single-column'], ['ops', 'console']]);
  assert.equal(new Set(K.SKINS.map((s) => s.layout)).size, 5, 'five different layouts');
  assert.equal(K.DEFAULT, 'mayfair');
  for (const s of K.SKINS) assert.ok(s.blurb.length > 40, s.id + ' describes its layout');
});
test('each layout file registers a frame, a Home, a module summary and a board summary; Mayfair registers none', () => {
  const files = { ops: 'layout-ops.js', terminal: 'layout-terminal.js', hud: 'layout-hud.js', mono: 'layout-mono.js' };
  for (const [id, f] of Object.entries(files)) {
    const src = read(f); assert.match(src, new RegExp('GH\\.layouts\\.' + id + ' = \\{'), id);
    for (const fn of ['shell(', 'home(', 'moduleSummary(', 'boardStrip(']) assert.ok(src.includes(fn), id + ' ' + fn);
  }
  assert.equal(/GH\.layouts\.mayfair/.test(Object.values(files).map(read).join('')), false);
  const shell = read('shell.js'); assert.ok(shell.includes('GH.layouts = {}') && shell.includes('GH.relayout') && shell.includes('GH.layoutId'));
  assert.match(read('settings.js'), /GH\.relayout\(\)/, 'a skin change rebuilds the frame live');
  assert.match(read('screens.js'), /Lx\.home\(\)/); assert.match(read('module.js'), /Lx\.moduleSummary/); assert.match(read('board.js'), /Lx\.boardStrip/);
});
test('every layout lists Workspace and Tools in its navigation, not the module list', () => {
  const shell = read('shell.js'), i = shell.indexOf('const navItems'), nav = shell.slice(i, shell.indexOf('GH.shellParts', i));
  for (const l of ["label: 'Workspace'", "label: 'All tools'", "label: 'Case board'", "label: 'Tool Integrations'", "label: 'Settings'"]) assert.ok(nav.includes(l), l);
  assert.equal(/MODS\.map|\.\.\.MODS/.test(nav), false);
  for (const f of ['layout-ops.js', 'layout-terminal.js', 'layout-hud.js', 'layout-mono.js']) assert.ok(read(f).includes('P.navItems()'), f + ' draws its navigation from the shared list');
});
test('page order: pure core and data before the shell, layouts after it, all scripts present and parse', () => {
  const html = read('index.html'), scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const at = (n) => scripts.indexOf(n); const vm = require('node:vm');
  for (const s of ['lay-core.js', 'data.js', 'viz.js', 'map.js', 'layouts.js', 'layout-ops.js', 'layout-terminal.js', 'layout-hud.js', 'layout-mono.js']) { assert.ok(at(s) > 0, s); assert.doesNotThrow(() => new vm.Script(read(s), { filename: s })); }
  assert.ok(at('modules.js') < at('lay-core.js') && at('casesvc.js') < at('data.js') && at('shell.js') < at('layout-ops.js') && at('viz.js') < at('map.js') && at('map.js') < at('layouts.js') && at('layouts.js') < at('layout-ops.js') && at('layout-mono.js') < at('app.js'));
  assert.ok(html.indexOf('ghost.css') < html.indexOf('layouts.css'));
});
test('layouts.css: tokens only, no images, no own radius, no icon chips, and every layout has its regions styled', () => {
  const css = read('layouts.css');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'no hex colour');
  assert.equal(/url\(|data:|@import|\.png|\.jpe?g/i.test(css), false, 'no images or remote css');
  for (const m of css.matchAll(/border-radius:\s*([^;}]+)/g)) assert.match(m[1].trim(), /^(var\(--mf-r-[a-z]+\)|50%|0)(\s|$)/, 'radius ' + m[1]);
  assert.equal(/\.chip-ico|\.ico-chip|icon-chip|\.ico-bg|\.tint/.test(css), false);
  for (const sel of ['.ops-menu', '.ops-tabs', '.ops-tree', '.ops-detail', '.ops-map', '.ops-tables', '.tm-keys', '.tm-grid', '.tm-vault', '.padlock', '.hd-ring', '.hd-card', '.hd-nav', '.hd-radar-svg', '.mn-h', '.mn-search', '.mn-grid', '.mn-stats', '.pmap', '.pm-link']) assert.ok(css.includes(sel), sel);
  assert.match(css, /@media \(max-width:719px\)/); assert.match(css, /@media \(max-width:1099px\)/); assert.match(css, /pointer:coarse/); assert.match(css, /prefers-reduced-motion:reduce/);
});
test('motion: every animation is subtle, and the global reduced-motion rule plus the layout rule turn them all off', () => {
  const css = read('layouts.css') + read('ghost.css');
  const anims = [...css.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)s\s+([\w()-]+)/g)];
  assert.ok(anims.length >= 3);
  for (const [, name, secs] of anims) assert.ok(['sweep', 'blink', 'blip', 'scan', 'spin', 'shim'].includes(name) && Number(secs) >= 1, name + ' ' + secs);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important\}\}/);
  assert.match(read('layouts.css'), /prefers-reduced-motion:reduce\)\{\.rd-sweep,\.mn-cur,\.tm-cursor::after\{animation:none!important\}\}/);
});
test('keyboard: the tree is a real tree, the map pins and linked dots are buttons, the tab bars are links', () => {
  const ops = read('layout-ops.js'), map = read('map.js');
  for (const k of ['role: \'tree\'', 'role: \'treeitem\'', 'aria-expanded', 'ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'Enter']) assert.ok(ops.includes(k), k);
  assert.ok(map.includes("tabindex: 0, role: 'button'") && map.includes("ev.key === 'Enter'"));
  const lay = read('layouts.js'); assert.ok(lay.includes("h('a', { class: cls, href: it.href"));
});
test('no sample data in the layouts: no addresses, names or invented numbers, and random only for element ids', () => {
  const src = ['lay-core.js', 'data.js', 'viz.js', 'map.js', 'layouts.js', 'layout-ops.js', 'layout-terminal.js', 'layout-hud.js', 'layout-mono.js'].map(read).join('\n').replace(/\/\/.*$/gm, '');
  assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(src), false, 'no IP addresses');
  assert.equal(/example\.(org|com|net)|lorem|sample data|fake|dummy|placeholder data/i.test(src), false);
  for (const m of src.matchAll(/Math\.random\(\)([^;]{0,30})/g)) assert.match(m[1], /^\.toString\(36\)/, 'random is only used to make element ids');
  assert.equal(/Date\.now\(\) - \d{4,}|new Array\(\d+\)\.fill\([1-9]/.test(src), false);
});
test('the page code stays text-only: no innerHTML, no inline style attributes, no web addresses', () => {
  for (const f of ['lay-core.js', 'data.js', 'viz.js', 'map.js', 'layouts.js', 'layout-ops.js', 'layout-terminal.js', 'layout-hud.js', 'layout-mono.js']) {
    const src = read(f).replace(/\/\/.*$/gm, '');
    assert.equal(/\.innerHTML|insertAdjacentHTML|outerHTML|document\.write|eval\(|new Function|setAttribute\(\s*['"]style['"]|https?:\/\//.test(src), false, f);
  }
  assert.equal(/AI-?(written|generated)|written (by|with) (an? )?(AI|Claude|Anthropic)/i.test(['layouts.css', ...fs.readdirSync(dir).filter((x) => /^(layout|lay-|viz|map|data)/.test(x) && x.endsWith('.js'))].map(read).join('')), false);
});

// ---------- colour: the surfaces the layouts use, in every skin ----------
test('contrast (WCAG AA) on the surfaces the layouts add: tinted table rows, bracketed cards, the map, the function-key bar, the inverse tab', () => {
  const out = [];
  for (const id of K.IDS) for (const mode of id === 'mayfair' ? ['dark', 'light'] : ['dark']) {
    const v = H.resolveAll(id, mode), C = (x) => H.color(v, v[x] !== undefined ? v[x] : x), blend = (top, pct, base) => H.over({ ...C(top), a: pct / 100 }, H.over(C(base), { r: 0, g: 0, b: 0, a: 1 }));
    const chk = (name, fg, bg, min) => { const r = H.ratio(H.over(C(fg), bg), bg); if (r < min) out.push(`${id}/${mode} ${name} ${r.toFixed(2)} < ${min}`); };
    for (const panel of ['--gh-panel', '--mf-surface']) {
      chk('text on a no-source row', '--mf-text', blend('--mf-danger', 20, panel), 4.5);
      chk('text on the selected row', '--mf-text', blend('--gh-hot', 24, panel), 4.5);
      chk('text on a bracket card', '--mf-text', blend('--mf-accent', 4, panel), 4.5); chk('muted text on a bracket card', '--mf-mute', blend('--mf-accent', 4, panel), 4.5); chk('accent text on a bracket card', '--mf-accent-ink', blend('--mf-accent', 4, panel), 4.5);
    }
    chk('table header on the accent', '--mf-on-accent', C('--mf-accent'), 4.5);
    chk('function-key number', '--mf-surface', C('--mf-text'), 4.5); chk('active key number', '--mf-accent', C('--mf-on-accent'), 3);
    chk('map axis text', '--gh-g-edge', C('--gh-g-bg'), 4.5); chk('map label', '--gh-g-ink', C('--gh-g-bg'), 4.5); chk('map pin', '--gh-hot', C('--gh-g-bg'), 3); chk('map line', '--gh-hot', C('--gh-g-bg'), 3);
    chk('muted text on the map', '--mf-mute', C('--gh-g-bg'), 4.5);
    for (const t of ['--mf-ok', '--mf-warn', '--mf-danger', '--mf-info']) chk('status ' + t + ' on the page', t, C('--gh-bg'), 4.5);
  }
  assert.deepEqual(out, []);
});

// ---------- the pure core: real inputs in, honest outputs out ----------
const entry = (id, over = {}) => ({ id, name: id, version: '1.0.0', scope: 'passive', state: 'enabled', health: 'ok', capabilities: [], install: { requirements: [], installed: true, verified: 'tested', lastTest: { t: Date.UTC(2026, 9, 1), ok: true, detail: '' } }, ...over });
test('connector counts: nothing installed is all "not installed", never invented readiness', () => {
  const none = L.connStats([]), unread = L.connStats(null);
  assert.equal(none.ready, 0); assert.equal(none.installed, 0); assert.equal(none.keys['not-installed'], none.expected); assert.ok(none.expected > 20);
  assert.equal(unread.readable, false); assert.equal(none.readable, true);
  assert.equal(none.rows.length, MODS.MODULES.length); for (const r of none.rows) { assert.equal(r.ready, 0); assert.equal(r.cells.length, r.total); }
  const f = L.connStats([entry('dns-doh'), entry('rdap-domain', { state: 'not-approved', install: { requirements: [], installed: false, verified: 'not-tested', lastTest: null } }), entry('ct-crtsh', { install: { requirements: [], installed: false, verified: 'failed', lastTest: { t: 1, ok: false, detail: 'x' } } })]);
  assert.equal(f.ready, 1); assert.equal(f.installed, 3); assert.equal(f.enabled, 2); assert.equal(f.keys['needs-approval'], 1); assert.equal(f.keys['test-failed'], 1);
  assert.equal(f.byModule.domains.ready, 1); assert.equal(f.byModule.domains.cells.find((c) => c.id === 'dns-doh').key, 'passed');
  assert.equal(Object.values(f.keys).reduce((a, b) => a + b, 0), f.expected, 'every expected connector is counted once');
});
test('character grids: # ready, : not ready, . not installed, and bars scale to the real ratio', () => {
  assert.deepEqual(['passed', 'needs-approval', 'test-failed', 'not-installed'].map(L.cellChar), ['#', ':', ':', '.']);
  assert.equal(L.charBar(0, 0, 10), '::::::::::'); assert.equal(L.charBar(5, 10, 10), '#####:::::'); assert.equal(L.charBar(1, 1, 4), '####'); assert.equal(L.charBar(9, 3, 4), '####', 'never over');
});
const mkCase = () => {
  const c = M.newCase('T'); const s = M.addSource(c, { connector: 'dns-doh', connectorVersion: '1', query: { kind: 'domain', value: 'a.test' }, origin: '', licence: 'MIT', rawSha256: 'a'.repeat(64) });
  const ids = {}; const E = (k, o) => { ids[k] = M.addEntity(c, o).id; };
  E('d', { type: 'domain', value: 'a.test', sources: [s] }); E('o', { type: 'org', value: 'Org A', sources: [s] }); E('o2', { type: 'org', value: 'Org B', sources: [s] }); E('x', { type: 'domain', value: 'b.test', manual: true });
  for (const [k, lat, lon] of [['p1', 51.5, -0.12], ['p2', 53.55, 9.99], ['p3', 51.92, 4.47]]) E(k, { type: 'place', value: k, label: k, manual: true, attrs: { lat, lon } });
  E('nopl', { type: 'place', value: 'nowhere', label: 'nowhere', manual: true, attrs: {} });
  for (const [f, t] of [['o', 'p1'], ['o', 'p2'], ['o2', 'p3'], ['p2', 'p3'], ['d', 'o']]) M.addEdge(c, { from: ids[f], to: ids[t], rel: 'located-at', sources: [s] });
  return { c, ids };
};
test('case numbers, pins, lines between places and linked dots come only from the case', () => {
  assert.equal(L.caseHealth(null), null); assert.deepEqual(L.placePins(null), []); assert.deepEqual(L.placeLinks(null), []); assert.deepEqual(L.placeSatellites(null), []);
  const empty = M.newCase('E'); assert.equal(L.caseHealth(empty).pct, null); assert.equal(L.caseHealth(empty).entities, 0); assert.deepEqual(L.placePins(empty), []);
  const { c, ids } = mkCase(), hl = L.caseHealth(c);
  assert.equal(hl.entities, 8); assert.equal(hl.places, 3, 'a place without coordinates is not a pin'); assert.equal(hl.handAdded, 5); assert.equal(hl.unsourced, 0); assert.equal(hl.pct, 100);
  const pins = L.placePins(c); assert.deepEqual(pins.map((p) => p.label).sort(), ['p1', 'p2', 'p3']);
  const links = L.placeLinks(c); const has = (a, b) => links.some((l) => (l.a === ids[a] && l.b === ids[b]) || (l.a === ids[b] && l.b === ids[a]));
  assert.ok(has('p2', 'p3'), 'a direct link'); assert.ok(has('p1', 'p2'), 'two places that share an organisation'); assert.equal(has('p1', 'p3'), false, 'not related, not drawn');
  assert.equal(links.find((l) => l.rel === 'via').via, ids.o);
  const sats = L.placeSatellites(c); assert.deepEqual(sats.map((s) => c.entities[s.id].label).sort(), ['Org A', 'Org B'].sort()); assert.ok(sats.every((s) => c.entities[s.place].type === 'place'));
  const un = M.newCase('U'); un.entities.q = { id: 'q', type: 'domain', label: 'q', key: 'q', sources: [], manual: false, tags: [], attrs: {} }; assert.equal(L.caseHealth(un).unsourced, 1); assert.equal(L.caseHealth(un).pct, 0);
});
test('map geometry: pins land inside the box, one pin still gets a sensible view, no pin shows the whole world, the scale is equal on both axes', () => {
  assert.deepEqual(L.viewFor([]), L.WORLD); assert.deepEqual(L.viewFor([{ lat: 1, lon: 1 }], { world: true }), L.WORLD);
  const one = L.fitAspect(L.viewFor([{ lat: 51.5, lon: -0.1 }]), 800, 400); assert.ok(one.lon0 < -0.1 && one.lon1 > -0.1 && one.lat0 < 51.5 && one.lat1 > 51.5);
  const pins = [{ lat: 51.5, lon: -0.12 }, { lat: 53.55, lon: 9.99 }], v = L.fitAspect(L.viewFor(pins), 900, 450);
  assert.ok(Math.abs((v.lon1 - v.lon0) / (v.lat1 - v.lat0) - 2) < 1e-9, 'same degrees per pixel on both axes');
  for (const p of pins) { const q = L.project(v, 900, 450, p.lat, p.lon); assert.ok(q.x > 0 && q.x < 900 && q.y > 0 && q.y < 450, JSON.stringify(q)); }
  assert.ok(v.lon0 >= -180 && v.lon1 <= 180 && v.lat0 >= -90 && v.lat1 <= 90);
  const w = L.fitAspect(L.WORLD, 400, 400); assert.ok(w.lon1 - w.lon0 <= 360 && w.lat1 - w.lat0 <= 180);
  const g = L.graticule(v); assert.ok(g.lons.length >= 2 && g.lons.length <= 14 && g.lats.length >= 1); assert.equal(L.fmtLat(-12.34), '12.3°S'); assert.equal(L.fmtLon(-0.12), '0.1°W');
  const r = L.radarPoints([{ id: 'a', label: 'a', lat: 10, lon: 10 }, { id: 'b', label: 'b', lat: 20, lon: 30 }]); assert.ok(r.every((p) => Math.hypot(p.x, p.y) <= 0.86)); assert.deepEqual(L.radarPoints([]), []);
  assert.deepEqual(L.radarPoints([{ id: 'a', label: 'a', lat: 5, lon: 5 }]).map((p) => [p.x, p.y]), [[0, 0]]);
});
test('activity chart buckets, lookups and the activity log are built from real timestamps only', () => {
  const now = Date.UTC(2026, 9, 27, 12); const b = L.dayBuckets([now, now - 1000, now - 86400000, now - 40 * 86400000, 'nope', null], 14, now);
  assert.equal(b.counts.length, 14); assert.equal(b.counts[13], 2); assert.equal(b.counts[12], 1); assert.equal(b.total, 3, 'older than the window, or not a date, is not counted'); assert.equal(b.labels[13], '2026-10-27');
  assert.equal(L.dayBuckets([], 7, now).total, 0);
  assert.equal(L.ago(now - 5000, now), '5s'); assert.equal(L.ago(now - 7200000, now), '2h'); assert.equal(L.ago('bad', now), '');
  const { c } = mkCase(); const src = Object.values(c.sources)[0]; src.fetchedAt = new Date(now - 60000).toISOString();
  const jobs = [{ id: 'j1', connector: 'dns-doh', query: 'a.test', status: 'done', startedAt: now - 61000, finishedAt: now - 59000, results: 4 }, { id: 'j2', connector: 'rdap-domain', query: 'a.test', status: 'failed', startedAt: now - 5000, finishedAt: now - 4000, results: 0 }];
  const lk = L.lookups(jobs, c); assert.equal(lk.length, 2, 'the case source of the same run is not listed twice'); assert.equal(lk[0].tool, 'rdap-domain'); assert.deepEqual(L.lookups([], null), []);
  src.fetchedAt = new Date(now - 90 * 60000).toISOString(); assert.equal(L.lookups(jobs, c).length, 3, 'an older lookup recorded in the case is listed with where it came from'); assert.equal(L.lookups(jobs, c)[2].where, 'case');
  const acts = L.activity({ jobs, conns: [entry('dns-doh')], scopeLog: [{ t: new Date(now - 1000).toISOString(), action: 'declare', target: 'x' }], save: { state: 'saved', at: new Date(now).toISOString() } });
  assert.ok(acts.length >= 6); for (let i = 1; i < acts.length; i++) assert.ok(acts[i - 1].t >= acts[i].t, 'newest first'); assert.deepEqual(L.activity({}), []);
});
test('the tree, the entity table and the vault word', () => {
  const { c } = mkCase(); const t = L.buildTree([{ id: c.id, title: 'T', entities: 8 }], c, { org: 'Organisation', domain: 'Domain', place: 'Place' });
  assert.equal(t[0].label, 'Cases'); assert.equal(t[0].kids[0].current, true); assert.equal(t[1].label, 'T'); assert.equal(t[1].count, 8); assert.deepEqual(t[1].kids.map((k) => k.label), ['Domain', 'Organisation', 'Place']); assert.equal(t[1].kids[2].kids.length, 4);
  assert.equal(L.buildTree([], null).length, 1); assert.equal(L.buildTree(null, null)[0].kids.length, 0);
  const top = L.topEntities(c, 3); assert.equal(top.length, 3); assert.ok(top[0].links >= top[1].links); assert.deepEqual(L.topEntities(null), []);
  assert.deepEqual([null, { state: 'unlocked' }, { state: 'locked' }, { state: 'uninitialised' }].map((v) => L.vaultWord(v).word), ['NOT IN USE', 'UNLOCKED', 'LOCKED', 'NOT SET UP']); assert.equal(L.vaultWord({ state: 'locked' }).locked, true); assert.equal(L.vaultWord({ state: 'unlocked' }).locked, false);
});

// ---------- the drawn page, in the real window, at the four widths ----------
const bins = () => [process.env.ELECTRON_BIN, path.join(__dirname, '..', 'node_modules/electron/dist/electron'), path.join(__dirname, '..', '.electron-dl/dist/electron')].filter(Boolean).find((p) => fs.existsSync(p));
const haveXvfb = () => spawnSync('which', ['xvfb-run']).status === 0;
test('layouts in the real Ghost window: structure, empty and filled data, reflow at 1280/1024/768/390, keyboard, reduced motion, contrast, picker', { timeout: 40 * 60 * 1000 }, (t) => {
  if (process.env.GHOST_SKIP_E2E === '1') return t.skip('GHOST_SKIP_E2E=1');
  if (!bins() || !haveXvfb()) return t.skip('needs the Electron binary and xvfb-run');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-layout-e2e-'));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'ghost-layout-shots.js')], { env: { ...process.env, GHOST_OUT: out }, encoding: 'utf8', timeout: 38 * 60 * 1000 });
  const failed = [];
  for (const w of ['1280', '1024', '768', '390']) {
    const f = path.join(out, `${w}-layout-results.json`); assert.ok(fs.existsSync(f), `no results for ${w}: ${String(r.stderr).slice(-400)}`);
    const res = JSON.parse(fs.readFileSync(f, 'utf8')); assert.ok(res.length > 100, w + ' ran ' + res.length + ' checks');
    for (const x of res) if (!x.ok) failed.push(w + ' ' + x.name + ' :: ' + x.detail);
  }
  assert.deepEqual(failed, []);
});
