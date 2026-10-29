'use strict';
// Ghost skins: every skin defines the same variables, every skin passes contrast (WCAG AA) for text, status colours, focus and the case graph,
// the choice is remembered in the vault, motion and decorations stay under control, and reports ignore the skin.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const H = require('./ghost-skins-helpers');
const K = require('../src/ui/ghost/skins');
const { PrefStore, PrefError } = require('../src/main/ghost/app/prefs');
const { check } = require('../src/main/ghost/app/checks');

const EXPECT = ['mayfair', 'terminal', 'hud', 'mono', 'shell', 'ops'];
const MODES = (id) => (id === 'mayfair' ? ['dark', 'light'] : ['dark']);

test('the picker lists the six skins, and each one has a block in skins.css', () => {
  assert.deepEqual(K.IDS, EXPECT); assert.equal(K.DEFAULT, 'mayfair');
  assert.deepEqual(K.SKINS.map((s) => s.label), ['Mayfair', 'Terminal green', 'Cyan HUD', 'Mono minimal', 'Shell', 'Operations']);
  for (const id of K.IDS) assert.ok(H.skinBlocks(id).length >= 1, id);
  const named = new Set(H.SKIN.flatMap((b) => b.sels).map((s) => (/^\[data-skin=(\w+)\]/.exec(s) || [])[1]).filter(Boolean)); assert.deepEqual([...named].sort(), [...EXPECT].sort());
  assert.deepEqual(K.SKINS.filter((s) => !s.dark).map((s) => s.id), ['mayfair'], 'only Mayfair has a light version');
});

test('token completeness: every skin defines the same variables, and every one resolves to a colour or a value', () => {
  const own = (id) => { const o = {}; for (const b of H.skinBlocks(id)) Object.assign(o, b.decl); return o; };
  const all = new Set(); for (const id of K.IDS) for (const k of Object.keys(own(id))) all.add(k);
  assert.ok(all.size >= 40, 'skins define a real token set (' + all.size + ')');
  for (const id of K.IDS) {
    for (const mode of MODES(id)) {
      const v = H.resolveAll(id, mode); const missing = [...all].filter((k) => !(k in v)); assert.deepEqual(missing, [], id + '/' + mode + ' misses variables');
    }
    if (id !== 'mayfair') { const missing = [...all].filter((k) => !(k in own(id))); assert.deepEqual(missing, [], id + ' must define every skin variable itself (not borrow Mayfair\'s)'); }
  }
  // the skin-only (--gh-*) variables are defined by Mayfair too, in both modes
  const gh = [...all].filter((k) => k.startsWith('--gh-')); for (const mode of ['dark', 'light']) { const v = H.resolveAll('mayfair', mode); for (const k of gh) assert.ok(k in v, k); }
  // colour variables really are colours in every skin
  const colours = [...all].filter((k) => /^--(mf-(surface|soft2?|text|mute|line|accent|accent-ink|on-accent|danger|ok|warn|info|scene|hov|act|black)|gh-(bg|panel|raised|rail|grid|focus|hot|g-bg|g-ink|g-edge|g-hi|g-sel|dot))$/.test(k));
  for (const id of K.IDS) for (const mode of MODES(id)) { const v = H.resolveAll(id, mode); for (const k of colours) assert.doesNotThrow(() => H.color(v, v[k]), id + ' ' + k); }
});

// pairs: [label, foreground, background, minimum ratio]
const TEXT = 4.5, UI = 3;
function failures(id, mode) {
  const v = H.resolveAll(id, mode), C = (x) => H.color(v, v[x] !== undefined ? v[x] : x), out = [];
  const eq = (name, fg, bg, min) => { const b = H.over(C(bg), { r: 0, g: 0, b: 0, a: 1 }); const f = H.over(C(fg), b); const r = H.ratio(f, b); if (r < min) out.push(`${name}: ${fg} on ${bg} is ${r.toFixed(2)}, needs ${min}`); };
  const surfaces = ['--mf-surface', '--mf-soft', '--mf-soft2', '--gh-bg', '--gh-panel', '--gh-raised', '--gh-rail'];
  for (const b of surfaces) { eq('text', '--mf-text', b, TEXT); eq('muted text', '--mf-mute', b, TEXT); eq('accent as text', '--mf-accent-ink', b, TEXT); eq('hot', '--gh-hot', b, TEXT); eq('focus ring', '--gh-focus', b, UI); for (const s of ['--mf-danger', '--mf-ok', '--mf-warn', '--mf-info']) eq('status ' + s, s, b, TEXT); }
  // the open row / selected chip: text over the accent wash, on each surface it can sit on
  for (const b of ['--mf-surface', '--mf-soft']) { const wash = H.over(C('--mf-sel'), C(b)); for (const t of ['--mf-text']) { const r = H.ratio(C(t), wash); if (r < TEXT) out.push(`${t} on the open-row wash over ${b} is ${r.toFixed(2)}`); } const r2 = H.ratio(C('--mf-accent-ink'), wash); if (r2 < UI) out.push(`accent icon on the open-row wash over ${b} is ${r2.toFixed(2)}`); }
  eq('button label', '--mf-on-accent', '--mf-accent', TEXT);
  eq('tile edge when picked', '--mf-accent-ink', '--gh-panel', UI);
  // the case board and the graph: labels, lines, highlights, the selected node
  eq('graph label', '--gh-g-ink', '--gh-g-bg', TEXT); eq('graph dimmed label', '--gh-g-edge', '--gh-g-bg', TEXT);
  eq('graph line', '--gh-g-edge', '--gh-g-bg', UI); eq('graph highlight', '--gh-g-hi', '--gh-g-bg', UI);
  eq('selected node label', '--gh-g-ink', '--gh-g-sel', TEXT); eq('selected node outline', '--gh-g-hi', '--gh-g-sel', UI);
  eq('toast', '--mf-surface', '--mf-text', TEXT);
  return out;
}
for (const id of EXPECT) for (const mode of MODES(id)) test(`contrast (WCAG AA): ${id} ${mode}`, () => assert.deepEqual(failures(id, mode), []));

test('the contrast check can fail: a skin with grey text on grey is caught', () => {
  const v = H.resolveAll('mono', 'dark'); v['--mf-mute'] = '#3a3a3a'; const r = H.ratio(H.color(v, v['--mf-mute']), H.color(v, v['--mf-surface'])); assert.ok(r < 4.5, String(r));
});

test('decorations are CSS only, faint, and can be switched off; nothing is imagery', () => {
  const skins = H.read('skins.css'), css = H.read('ghost.css');
  for (const id of K.IDS) for (const b of H.skinBlocks(id)) { const g = b.decl['--gh-deco-grid'], s = b.decl['--gh-deco-scan']; if (s !== undefined) assert.ok(Number(s) <= 0.06, id + ' scan lines must stay very faint'); if (g !== undefined) assert.ok(Number(g) <= 0.3, id + ' grid'); }
  assert.match(skins, /html\[data-deco=off\]\{[^}]*--gh-deco-grid:0[^}]*--gh-deco-scan:0[^}]*--gh-bracket:0px/);
  assert.equal(/url\(|data:|\.png|\.jpe?g|\.svg|@import/i.test(skins + css), false, 'no image files, no stock art, no remote css');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(css), false, 'ghost.css keeps colours out');
  assert.equal(/pointer-events:none/.test(css.slice(css.indexOf('body::before'), css.indexOf('body::after') + 400)), true, 'decorations never take clicks');
});
test('reduced motion stops every animation and transition', () => {
  const css = H.read('ghost.css'); assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important;transition:none!important\}\}/);
  assert.ok(/animation:/.test(css), 'there are animations for it to stop');
});
test('the Mayfair skin follows Mayfair: tokens, 34px nav rows with an amber bar, group labels, no icon chips, no mono for labels', () => {
  const css = H.read('ghost.css'), v = H.resolveAll('mayfair', 'dark'), t = H.read('mf-tokens.css');
  assert.equal(v['--mf-accent'], '#ffa800'); assert.equal(v['--mf-r-ctl'], '8px'); assert.equal(v['--mf-r-pop'], '16px'); assert.equal(v['--mf-surface'], '#171716'); assert.equal(v['--mf-soft'], '#1f1f1d');
  assert.equal(v['--gh-rail'], 'var(--mf-soft)'); assert.equal(v['--gh-bg'], 'var(--mf-surface)');
  assert.match(css, /\.nav\{[^}]*min-height:var\(--mf-row-nav\)/); assert.match(css, /\.nav\[aria-current=page\]::before\{[^}]*background:var\(--mf-accent\)/); assert.match(css, /\.rail-h\{[^}]*text-transform:uppercase/);
  assert.match(css, /:root\{--gh-rail-w:var\(--mf-side-w\)\}/); assert.match(t, /--mf-side-w:240px/);
  assert.equal(/\.chip-ico|\.ico-chip|icon-chip|\.ico-bg/.test(css), false);
  assert.match(css, /\.eyebrow,\.try,\.mod-f\{font-family:var\(--mf-font\)\}/);
});

test('reports always use their own neutral print style, whatever the skin', () => {
  const R = require('../src/main/ghost/app/report'), M = require('../src/ui/ghost/case-model');
  const c = M.newCase('Skin check'); const base = R.reportHtml(c, { now: 1, version: '1.0.0' });
  assert.equal(R.reportHtml(c, { now: 1, version: '1.0.0', skin: 'terminal', theme: 'dark' }), base);
  assert.equal(/var\(--|data-skin|data-theme|skins\.css|prefers-color-scheme/.test(base), false);
  assert.match(base, /color-scheme:light/); assert.match(base, /background:#fff/);
});

// ---------- persistence ----------
const mkVault = () => { const m = new Map(); return { unlocked: true, ensure() {}, get: (ns, id) => (m.has(ns + '/' + id) ? Buffer.from(m.get(ns + '/' + id)) : null), put: (ns, id, d) => m.set(ns + '/' + id, String(d)), _m: m }; };
test('the stored choice: default, partial updates, refusal of unknown values, locked vault', () => {
  const v = mkVault(), p = new PrefStore({ vault: v });
  assert.deepEqual(p.get(), { skin: 'mayfair', theme: 'dark', deco: true });
  assert.deepEqual(p.set({ skin: 'hud' }), { skin: 'hud', theme: 'dark', deco: true });
  assert.deepEqual(p.set({ theme: 'light' }), { skin: 'hud', theme: 'light', deco: true }, 'a partial update keeps the other fields');
  assert.deepEqual(p.set({ deco: false }), { skin: 'hud', theme: 'light', deco: false });
  assert.deepEqual(new PrefStore({ vault: v }).get(), { skin: 'hud', theme: 'light', deco: false }, 'a new store over the same vault reads it back');
  for (const bad of [{ skin: 'neon' }, { skin: 'mayfair', theme: 'sepia' }, { deco: 'yes' }, null, [], 'x']) assert.throws(() => p.set(bad), PrefError);
  v._m.set('prefs/ui', '{broken'); assert.deepEqual(p.get(), { skin: 'mayfair', theme: 'dark', deco: true }, 'a damaged record reads as the default');
  v._m.set('prefs/ui', JSON.stringify({ skin: '<script>', theme: 7, deco: 3 })); assert.deepEqual(p.get(), { skin: 'mayfair', theme: 'dark', deco: true });
  v.unlocked = false; assert.throws(() => p.get(), /locked/);
});
test('the window accepts only well-formed prefs calls', () => {
  assert.equal(check('gapp:prefs.get', []).ok, true);
  assert.equal(check('gapp:prefs.set', [{ skin: 'ops', theme: 'dark', deco: true }]).ok, true);
  for (const bad of [[{ skin: 'x y' }], [{ theme: 'blue' }], [{ deco: 1 }], [{ skin: 'ops', extra: 1 }], [null], [], ['ops']]) assert.equal(check('gapp:prefs.set', bad).ok, false, JSON.stringify(bad));
});
test('end to end through the app: saved in the vault, sealed on disk, and still there for the next session', async () => {
  const { mockServer, makeApp, signInTo, acceptTerms } = require('./ghost-app-helpers');
  const mock = await mockServer({ pollsBeforeOk: 1 });
  try {
    const h = makeApp(mock); await signInTo(h); acceptTerms(h.app);
    assert.deepEqual(await h.app.prefsGet(), { skin: 'mayfair', theme: 'dark', deco: true });
    await h.app.prefsSet({ skin: 'terminal' });
    assert.equal((await h.app.prefsGet()).skin, 'terminal');
    await assert.rejects(async () => h.app.prefsSet({ skin: 'neon' }), PrefError);
    const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); } }; walk(h.root);
    assert.equal(files.some((f) => /"skin"|terminal/.test(fs.readFileSync(f).toString('latin1')) && /vault/i.test(f)), false, 'the choice is not in the clear in the vault files');
    h.app.shutdown && h.app.shutdown(); h.ghost.shutdown();
  } finally { await mock.close(); }
});

// ---------- the page side: GH.appearance, run on a stand-in document ----------
function page() {
  const attrs = {}, store = { v: null }, el = { setAttribute: (k, v) => { attrs[k] = String(v); }, removeAttribute: (k) => { delete attrs[k]; } };
  const GH = { hasBridge: true, h: () => ({}), toast: (m) => { GH.toasts.push(m); }, toasts: [], errText: (e) => e.message, routes: {}, syncThemeButton() { GH.synced = (GH.synced || 0) + 1; },
    api: { prefs: { get: async () => ({ ok: true, data: store.v }), set: async (o) => { if (GH.fail) return { ok: false, error: 'vault is locked' }; store.v = { ...(store.v || { skin: 'mayfair', theme: 'dark', deco: true }), ...o }; return { ok: true, data: store.v }; } } },
    call: async (fn, ...a) => { const r = await fn(...a); if (r && r.ok === false) throw new Error(r.error); return r && r.ok ? r.data : r; } };
  const win = { GH, GhostSkins: K }; const ctx = vm.createContext({ window: win, document: { documentElement: el, querySelector: () => null, querySelectorAll: () => [] } });
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'ghost', 'settings.js'), 'utf8')).runInContext(ctx);
  return { GH, attrs, store };
}
test('picker persistence (page): choosing applies at once, is saved, and loads back; a dark-only skin draws dark; a failed save is said plainly', async () => {
  const p = page(); await p.GH.appearance.load();
  assert.deepEqual([p.attrs['data-skin'], p.attrs['data-theme']], ['mayfair', 'dark']);
  await p.GH.appearance.set({ theme: 'light' }); assert.equal(p.attrs['data-theme'], 'light'); assert.equal(p.GH.appearance.theme(), 'light');
  const pending = p.GH.appearance.set({ skin: 'ops' }); assert.equal(p.attrs['data-skin'], 'ops', 'live: shown before the save returns'); await pending;
  assert.equal(p.attrs['data-theme'], 'dark', 'ops is dark only'); assert.equal(p.GH.appearance.darkOnly(), true);
  assert.equal(p.store.v.skin, 'ops'); assert.equal(p.store.v.theme, 'light', 'the light choice is kept for when Mayfair comes back');
  await p.GH.appearance.set({ skin: 'mayfair' }); assert.equal(p.attrs['data-theme'], 'light');
  await p.GH.appearance.set({ deco: false }); assert.equal(p.attrs['data-deco'], 'off'); await p.GH.appearance.set({ deco: true }); assert.equal('data-deco' in p.attrs, false);
  // the next session: a fresh page reads the saved record
  p.GH.appearance.apply(null); assert.equal(p.attrs['data-skin'], 'mayfair'); await p.GH.appearance.set({ skin: 'hud' });
  const next = page(); next.store.v = p.store.v; await next.GH.appearance.load(); assert.equal(next.attrs['data-skin'], 'hud');
  // junk in the store never reaches the page
  const bad = page(); bad.store.v = { skin: 'x"onload=1', theme: '<b>' }; await bad.GH.appearance.load(); assert.deepEqual([bad.attrs['data-skin'], bad.attrs['data-theme']], ['mayfair', 'dark']);
  // a save that fails keeps the choice on screen and says why
  const f = page(); await f.GH.appearance.load(); f.GH.fail = true; await f.GH.appearance.set({ skin: 'mono' }); assert.equal(f.attrs['data-skin'], 'mono'); assert.match(f.GH.toasts[0], /could not be saved: vault is locked/);
});
test('page shell: the Settings screen and the rail entry exist, and the start screens use the default skin', () => {
  const dir = path.join(__dirname, '..', 'src', 'ui', 'ghost'), r = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  assert.match(r('index.html'), /<html [^>]*data-skin="mayfair"/); assert.ok(r('index.html').includes('skins.css') && r('index.html').includes('skins.js') && r('index.html').includes('settings.js'));
  assert.ok(r('shell.js').includes("GH.href('settings')")); assert.ok(r('settings.js').includes('GH.routes.settings')); assert.match(r('app.js'), /GH\.appearance\.apply\(null\)/);
  for (const l of ['Appearance', 'Skin', 'Light or dark', 'Decorations']) assert.ok(r('settings.js').includes(l), l);
  const sc = r('index.html'); assert.ok(sc.indexOf('skins.js') < sc.indexOf('shell.js') && sc.indexOf('shell.js') < sc.indexOf('settings.js') && sc.indexOf('settings.js') < sc.indexOf('app.js'));
});
