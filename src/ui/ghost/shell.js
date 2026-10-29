'use strict';
// Ghost app shell: the rail (or bottom bar on a phone), the top bar, the status bar, hash routing and the account dialog.
// Screens are drawn into <main>; each screen is a function in screens.js, module.js or board.js that returns a node.
(function () {
  const GH = window.GH, h = GH.h, MODS = window.GhostModules.MODULES;
  GH.routes = {};      // name -> (arg, rest) => Node | Promise<Node>
  const ROUTE_NAMES = {};
  let current = { name: 'home', arg: '', rest: '' }, token = 0;

  const NAV_WORK = [['workspace', 'Workspace', 'search'], ['case', 'Case board', 'board']];
  const NAV_TOOLS = [['tools', 'Tool Integrations', 'tool']];
  // The tools that are not part of the master search: security tools you approve yourself, and active scanning behind the scope guard.
  const NAV_MORE = [{ id: 'threat', label: 'Security tools', icon: 'shield' }, { id: 'scan', label: 'Active scanning', icon: 'scan', active: true }];

  GH.parseHash = (hash) => {
    const m = /^#\/?([a-z]*)(?:\/([^/?]*))?(?:\/(.*))?$/.exec(hash || '');
    if (!m || !m[1]) return { name: 'home', arg: '', rest: '' };
    const dec = (s) => { try { return decodeURIComponent(s || ''); } catch { return ''; } };
    return { name: m[1], arg: dec(m[2]), rest: dec(m[3]) };
  };
  GH.href = (name, arg, rest) => '#' + name + (arg ? '/' + encodeURIComponent(arg) + (rest ? '/' + encodeURIComponent(rest) : '') : '');
  GH.go = (name, arg, rest) => { const hash = GH.href(name, arg, rest); if (location.hash === hash) renderRoute(); else location.hash = hash; };

  const SHORT = { 'Case board': 'Cases', 'Tool Integrations': 'Own tools', 'All tools': 'Tools', 'Security tools': 'Security', 'Active scanning': 'Scanning' };
  const lab = (l) => (SHORT[l] ? [h('span', { class: 'l' }, l), h('span', { class: 's' }, SHORT[l])] : [h('span', {}, l)]);
  function navLink(name, label, icon, active) {
    return h('a', { class: 'nav', href: GH.href(name === 'module' ? 'm' : name), dataset: { nav: name }, 'aria-current': active ? 'page' : null }, GH.icon(icon), h('span', {}, label));
  }
  function buildRail() {
    const st = GH.status || {};
    const more = NAV_MORE.map((m) => h('li', {}, h('a', { class: 'nav', href: GH.href('m', m.id), dataset: { nav: 'm:' + m.id } }, GH.icon(m.icon), h('span', {}, m.label), m.active ? h('i', { class: 'act-dot', title: 'Active scanning', 'aria-hidden': 'true' }) : null)));
    return h('nav', { class: 'rail', 'aria-label': 'Ghost' },
      h('a', { class: 'brand', href: '#workspace', 'aria-label': 'Mayfair Ghost, Workspace' }, GH.icon('ghost', 'brand-ico'), h('span', { class: 'brand-t' }, h('b', {}, 'MAYFAIR'), h('i', {}, 'GHOST'))),
      h('div', { class: 'rail-scroll' },
        h('ul', { class: 'rail-list' }, NAV_WORK.map(([n, l, i]) => h('li', {}, h('a', { class: 'nav', href: GH.href(n), dataset: { nav: n } }, GH.icon(i), ...lab(l))))),
        h('p', { class: 'rail-h' }, 'Tools'),
        h('ul', { class: 'rail-list' }, h('li', { class: 'm-only' }, h('a', { class: 'nav', href: GH.href('tool'), dataset: { nav: 'tool' } }, GH.icon('grid'), ...lab('All tools'))), more),
        h('p', { class: 'rail-h' }, 'More'),
        h('ul', { class: 'rail-list' }, NAV_TOOLS.map(([n, l, i]) => h('li', {}, h('a', { class: 'nav', href: GH.href(n), dataset: { nav: n } }, GH.icon(i), ...lab(l)))),
          h('li', {}, h('button', { class: 'nav', type: 'button', id: 'nav-term', onclick: openTerminal }, GH.icon('term'), h('span', {}, 'Terminal'))),
          h('li', {}, h('a', { class: 'nav', href: GH.href('settings'), dataset: { nav: 'settings' } }, GH.icon('gear'), h('span', {}, 'Settings'))))),
      h('div', { class: 'rail-foot' }, GH.icon('lock'), h('span', {}, 'Local only. No telemetry. Update 22')));
  }
  async function openTerminal() { try { await GH.call(GH.api.terminal.open); } catch (e) { GH.toast(GH.errText(e)); } }
  GH.openTerminal = openTerminal;

  function accountDialog() {
    const st = GH.status || {}, e = st.entitlement || {};
    const kv = [['Account', st.account && (st.account.email || st.account.name) || 'Signed in'], ['Access', e.operator ? 'Operator: every module, no expiry' : e.approved ? 'Approved' + (e.expiresAt ? ' until ' + GH.fmtDate(e.expiresAt) : '') : 'Not approved'],
      ['Active scanning', e.modules && e.modules.scanning ? 'Switched on' : 'Off for this account'], ['Image geolocation', e.modules && e.modules.geolocation ? 'Switched on' : 'Off for this account'], ['Last checked', GH.fmtTime(e.checkedAt)], ['Terms', st.terms && st.terms.record ? 'Version ' + st.terms.record.version + ', accepted ' + GH.fmtDate(st.terms.record.acceptedAt) : '']];
    return GH.dialog({ title: 'Account', sub: 'Your Mayfair ID and what it allows.', icon: 'user',
      body: h('div', { class: 'stack' }, h('dl', { class: 'kv wide' }, kv.filter((x) => x[1]).map(([a, b]) => [h('dt', {}, a), h('dd', {}, b)])),
        h('div', { class: 'row-a' }, GH.btn('Keyboard shortcuts', { onclick: () => { setTimeout(shortcuts, 0); document.querySelector('.scrim')._close(null); } }))),
      actions: [{ label: 'Remove Ghost', danger: true, value: 'remove' }, { label: 'Sign out', value: 'out' }, { label: 'Close', primary: true, value: null }] }).then(async (v) => {
      try { if (v === 'out') await GH.call(GH.api.signIn.out); if (v === 'remove') await GH.call(GH.api.uninstall); } catch (x) { GH.toast(GH.errText(x)); }
    });
  }
  function shortcuts() {
    const rows = [['/', 'Jump to the master search (on the case board: search the case)'], ['Ctrl Z / Ctrl Shift Z', 'Undo and redo on the case board'], ['Arrow keys', 'Move between entities on the graph'], ['Shift + Arrow keys', 'Nudge the selected entity'], ['Enter', 'Open the selected entity'], ['Delete', 'Remove the selected entities'], ['P', 'Pin or unpin the selected entity'], ['+ and -', 'Zoom the graph'], ['0', 'Fit the graph to the window'], ['Escape', 'Clear the selection, or close a dialog'], ['F11', 'Full screen'], ...(GH.qn ? GH.qn.SHORTCUTS : [])];
    return GH.dialog({ title: 'Keyboard shortcuts', body: h('dl', { class: 'kv wide' }, rows.map(([a, b]) => [h('dt', { class: 'mono' }, a), h('dd', {}, b)])), actions: [{ label: 'Close', primary: true, value: null }] });
  }
  GH.shortcuts = shortcuts;

  // The light/dark button. The drawn theme and the skin belong to GH.appearance (settings.js); this only shows the button for the current state.
  function syncThemeButton() {
    const b = document.getElementById('theme'); if (!b) return; const A = GH.appearance, t = A.theme(), only = A.darkOnly();
    b.disabled = only; b.setAttribute('aria-label', only ? 'This skin is dark only. Choose Mayfair in Settings to use the light theme.' : t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'); b.title = only ? 'This skin is dark only' : 'Theme';
    GH.clear(b).append(GH.icon(t === 'dark' ? 'sun' : 'moon'));
  }
  GH.syncThemeButton = syncThemeButton;
  let fs = false;
  function buildTop() {
    return h('header', { class: 'top' },
      h('div', { class: 'top-l' }, h('a', { class: 'top-brand', href: '#home', 'aria-label': 'Home' }, GH.icon('ghost'), h('b', {}, 'GHOST')), h('span', { class: 'crumb', id: 'crumb' }, 'Home')),
      h('div', { class: 'top-r' },
        GH.qn ? GH.qn.topButton() : null,
        GH.btn('', { icon: 'term', ghost: true, title: 'Open the terminal', cls: 'top-term', onclick: openTerminal }),
        GH.btn('', { icon: 'full', ghost: true, title: 'Full screen (F11)', id: 'fs', onclick: () => toggleFs() }),
        h('button', { class: 'btn ghost icon', id: 'theme', type: 'button', title: 'Theme', onclick: () => GH.appearance.set({ theme: GH.appearance.theme() === 'dark' ? 'light' : 'dark' }) }, GH.icon('sun')),
        h('button', { class: 'btn ghost acct', type: 'button', id: 'acct', title: 'Account', onclick: accountDialog }, GH.icon('user'), h('span', { class: 'acct-t', id: 'acct-t' }, ''))));
  }
  function toggleFs() { fs = !fs; GH.call(GH.api.window.fullscreen, fs).catch(() => {}); }
  function buildStatus() { return h('footer', { class: 'status', id: 'status' }, h('span', { class: 'st-a' }, GH.icon('lock'), h('b', {}, 'Local only. '), 'Lookups go only to the service you run them on.'), h('span', { class: 'st-b', id: 'st-vault' }, ''), h('span', { class: 'st-c', id: 'st-case' }, '')); }
  function updateBars() {
    const st = GH.status || {}, a = document.getElementById('acct-t'); if (a) a.textContent = st.account ? (st.account.email || st.account.name || '') : '';
    const sv = document.getElementById('st-vault'); if (sv) { GH.clear(sv).append(GH.icon('lock'), 'Vault ' + (st.vault ? st.vault.state : '')); }
    const sc = document.getElementById('st-case'), c = GH.cs.current(), s = GH.cs.state.save;
    if (sc) { sc.textContent = c ? c.title.slice(0, 40) + ': ' + ({ saved: 'saved ' + GH.fmtClock(s.at), pending: 'changes not saved yet', saving: 'saving', error: 'not saved: ' + s.error, idle: '' }[s.state] || '') : ''; }
  }
  GH.updateBars = updateBars;

  function crumbOf(r) {
    if (r.name === 'm') { const m = window.GhostModules.byId(r.arg), x = NAV_MORE.find((n) => n.id === r.arg); return x ? x.label : m ? m.name : 'Workspace'; }
    if (r.name === 'search') return 'Results: ' + (r.rest || '');
    if (r.name === 'tool') { const t = GH.ws && GH.ws.tool(r.arg); return r.arg ? (t ? t.name : 'Tool') : 'All tools'; }
    const lx = GH.layout && GH.layout();
    return { home: lx && lx.home ? 'Home' : 'Workspace', workspace: 'Workspace', case: 'Case board', tools: 'Tool Integrations', settings: r.arg === 'appearance' || !r.arg ? 'Settings / Appearance' : 'Settings' }[r.name] || 'Workspace';
  }
  async function renderRoute() {
    const r = GH.parseHash(location.hash); current = r; const my = ++token;
    const fn = GH.routes[r.name] || GH.routes.home;
    const lay0 = GH.layout && GH.layout(), key = r.name === 'home' && !(lay0 && lay0.home) ? 'workspace' : r.name === 'search' ? 'workspace' : r.name;
    document.querySelectorAll('#app [data-nav]').forEach((a) => { const n = a.dataset.nav; const on = n === key || (r.name === 'm' && n === 'm:' + r.arg); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const cr = document.getElementById('crumb'); if (cr) cr.textContent = crumbOf(r);
    document.getElementById('app').dataset.view = r.name;
    const host = document.getElementById('main'); GH.clear(host); host.append(h('div', { class: 'skel pad', 'aria-hidden': 'true' }, h('i', {}), h('i', {}), h('i', {})));
    let node;
    try { node = await fn(r.arg, r.rest); } catch (e) { node = h('div', { class: 'state' }, GH.icon('alert'), h('h2', {}, 'This screen did not load'), h('p', {}, GH.errText(e)), GH.btn('Try again', { onclick: renderRoute })); }
    if (my !== token) return;
    GH.clear(host); if (node) host.append(node); host.scrollTop = 0; window.scrollTo(0, 0); updateBars();
    const Lx = GH.layout(); if (Lx && Lx.after) Lx.after(r);
    if (GH.afterRender) GH.afterRender(r);
  }
  GH.render = renderRoute;
  GH.current = () => current;

  // Each skin other than Mayfair has its own layout (layouts-*.js register into GH.layouts). A layout builds the whole window frame around <main id="main">:
  // its own navigation, side panels and bars. Mayfair keeps the rail and top bar above. Switching skin in Settings rebuilds the frame at once.
  GH.layouts = {};
  GH.layoutId = () => { const id = GH.appearance ? GH.appearance.skin() : 'mayfair'; return GH.layouts[id] ? id : 'mayfair'; };
  GH.layout = () => GH.layouts[GH.layoutId()] || null;
  const navItems = () => [{ nav: 'home', href: GH.href('home'), label: 'Home' }, { nav: 'workspace', href: GH.href('workspace'), label: 'Workspace' }, { nav: 'case', href: GH.href('case'), label: 'Case board', short: 'Cases' },
    { nav: 'tool', href: GH.href('tool'), label: 'All tools', short: 'Tools' },
    ...NAV_MORE.map((m) => ({ nav: 'm:' + m.id, href: GH.href('m', m.id), label: m.label, short: SHORT[m.label] || null, active: m.active, module: true })),
    { nav: 'tools', href: GH.href('tools'), label: 'Tool Integrations', short: 'Own tools' }, { nav: 'settings', href: GH.href('settings'), label: 'Settings' }];
  GH.shellParts = { MODS, navItems, openTerminal, accountDialog, toggleFs: () => toggleFs(), buildStatus, crumbOf, shortcuts,
    actions() { return h('div', { class: 'top-r' }, GH.btn('', { icon: 'term', ghost: true, title: 'Open the terminal', cls: 'top-term', onclick: openTerminal }), GH.btn('', { icon: 'full', ghost: true, title: 'Full screen (F11)', id: 'fs', onclick: () => toggleFs() }),
      h('button', { class: 'btn ghost icon', id: 'theme', type: 'button', title: 'Theme', onclick: () => GH.appearance.set({ theme: GH.appearance.theme() === 'dark' ? 'light' : 'dark' }) }, GH.icon('sun')),
      h('button', { class: 'btn ghost acct', type: 'button', id: 'acct', title: 'Account', onclick: accountDialog }, GH.icon('user'), h('span', { class: 'acct-t', id: 'acct-t' }, ''))); },
  };
  let teardown = null;
  function buildApp() {
    if (teardown) { try { teardown(); } catch { /* ok */ } teardown = null; }
    const L = GH.layout();
    if (L && L.shell) { const r = L.shell(GH.shellParts); teardown = r.destroy || null; return r.root; }
    return h('div', { class: 'app', id: 'app', dataset: { view: 'home' } }, buildRail(), h('div', { class: 'main-col' }, buildTop(), h('main', { id: 'main', tabindex: '-1' }), buildStatus()));
  }
  GH.mount = async function mount() {
    try { await GH.appearance.load(); } catch { /* the default skin stays */ }
    const root = document.getElementById('root'); GH.clear(root); root.append(buildApp());
    syncThemeButton(); renderRoute();
    if (GH.qn) GH.qn.attach(document.getElementById('app'));      // Quick notes: the side drawer
  };
  // Called by Settings when the skin changes while the app is open: new frame, same screen, focus kept on the picker.
  GH.relayout = function relayout() {
    if (!GH.mounted || !document.getElementById('app')) return;
    const root = document.getElementById('root'); GH.clear(root); root.append(buildApp()); syncThemeButton(); updateBars();
    if (GH.qn) GH.qn.attach(document.getElementById('app'));
    const r = GH.parseHash(location.hash); const sk = r.name === 'settings'; renderRoute().then(() => { if (sk) { const f = document.querySelector('.sk input:checked'); if (f) f.focus({ preventScroll: true }); } });
  };
  window.addEventListener('hashchange', () => { if (GH.mounted) renderRoute(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); if (GH.mounted) toggleFs(); }
    if (e.key === '?' && !/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) { e.preventDefault(); shortcuts(); }
  });
  if (GH.api && GH.api.onWindow) GH.api.onWindow((p) => { fs = !!p.fullscreen; });
  GH.cs.on((why) => { if (why === 'save' || why === 'open' || why === 'close') updateBars(); });
})();
