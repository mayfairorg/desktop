'use strict';
// Ghost app shell: the rail (or bottom bar on a phone), the top bar, the status bar, hash routing and the account dialog.
// Screens are drawn into <main>; each screen is a function in screens.js, module.js or board.js that returns a node.
(function () {
  const GH = window.GH, h = GH.h, MODS = window.GhostModules.MODULES;
  GH.routes = {};      // name -> (arg, rest) => Node | Promise<Node>
  const ROUTE_NAMES = {};
  let current = { name: 'home', arg: '', rest: '' }, token = 0, theme = 'dark';

  const NAV_WORK = [['home', 'Home', 'home'], ['case', 'Case board', 'board']];
  const NAV_TOOLS = [['tools', 'Tool Integrations', 'tool']];

  GH.parseHash = (hash) => {
    const m = /^#\/?([a-z]*)(?:\/([^/?]*))?(?:\/(.*))?$/.exec(hash || '');
    if (!m || !m[1]) return { name: 'home', arg: '', rest: '' };
    const dec = (s) => { try { return decodeURIComponent(s || ''); } catch { return ''; } };
    return { name: m[1], arg: dec(m[2]), rest: dec(m[3]) };
  };
  GH.href = (name, arg, rest) => '#' + name + (arg ? '/' + encodeURIComponent(arg) + (rest ? '/' + encodeURIComponent(rest) : '') : '');
  GH.go = (name, arg, rest) => { const hash = GH.href(name, arg, rest); if (location.hash === hash) renderRoute(); else location.hash = hash; };

  const SHORT = { 'Case board': 'Cases', 'Tool Integrations': 'Tools', 'Domains and networks': 'Domains' };
  const lab = (l) => (SHORT[l] ? [h('span', { class: 'l' }, l), h('span', { class: 's' }, SHORT[l])] : [h('span', {}, l)]);
  function navLink(name, label, icon, active) {
    return h('a', { class: 'nav', href: GH.href(name === 'module' ? 'm' : name), dataset: { nav: name }, 'aria-current': active ? 'page' : null }, GH.icon(icon), h('span', {}, label));
  }
  function buildRail() {
    const st = GH.status || {};
    const mods = MODS.map((m) => h('li', {}, h('a', { class: 'nav', href: GH.href('m', m.id), dataset: { nav: 'm:' + m.id } }, GH.icon(m.icon), h('span', {}, m.name), m.active ? h('i', { class: 'act-dot', title: 'Active scanning', 'aria-hidden': 'true' }) : null)));
    return h('nav', { class: 'rail', 'aria-label': 'Ghost' },
      h('a', { class: 'brand', href: '#home', 'aria-label': 'Mayfair Ghost, home' }, GH.icon('ghost', 'brand-ico'), h('span', { class: 'brand-t' }, h('b', {}, 'MAYFAIR'), h('i', {}, 'GHOST'))),
      h('div', { class: 'rail-scroll' },
        h('ul', { class: 'rail-list' }, NAV_WORK.map(([n, l, i]) => h('li', {}, h('a', { class: 'nav', href: GH.href(n), dataset: { nav: n } }, GH.icon(i), ...lab(l))))),
        h('p', { class: 'rail-h mono' }, 'Investigate'),
        h('ul', { class: 'rail-list' }, h('li', { class: 'm-only' }, h('a', { class: 'nav', href: '#modules', dataset: { nav: 'modules' } }, GH.icon('grid'), h('span', {}, 'Modules'))), mods),
        h('p', { class: 'rail-h mono' }, 'Tools'),
        h('ul', { class: 'rail-list' }, NAV_TOOLS.map(([n, l, i]) => h('li', {}, h('a', { class: 'nav', href: GH.href(n), dataset: { nav: n } }, GH.icon(i), ...lab(l)))),
          h('li', {}, h('button', { class: 'nav', type: 'button', id: 'nav-term', onclick: openTerminal }, GH.icon('term'), h('span', {}, 'Terminal'))))),
      h('div', { class: 'rail-foot mono' }, GH.icon('lock'), h('span', {}, 'Local only. No telemetry.')));
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
    const rows = [['Ctrl Z / Ctrl Shift Z', 'Undo and redo on the case board'], ['/', 'Search the case'], ['Arrow keys', 'Move between entities on the graph'], ['Shift + Arrow keys', 'Nudge the selected entity'], ['Enter', 'Open the selected entity'], ['Delete', 'Remove the selected entities'], ['P', 'Pin or unpin the selected entity'], ['+ and -', 'Zoom the graph'], ['0', 'Fit the graph to the window'], ['Escape', 'Clear the selection, or close a dialog'], ['F11', 'Full screen']];
    return GH.dialog({ title: 'Keyboard shortcuts', body: h('dl', { class: 'kv wide' }, rows.map(([a, b]) => [h('dt', { class: 'mono' }, a), h('dd', {}, b)])), actions: [{ label: 'Close', primary: true, value: null }] });
  }
  GH.shortcuts = shortcuts;

  function setTheme(t) { theme = t; document.documentElement.setAttribute('data-theme', t); const b = document.getElementById('theme'); if (b) { b.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'); GH.clear(b).append(GH.icon(t === 'dark' ? 'sun' : 'moon')); } }
  let fs = false;
  function buildTop() {
    return h('header', { class: 'top' },
      h('div', { class: 'top-l' }, h('a', { class: 'top-brand', href: '#home', 'aria-label': 'Home' }, GH.icon('ghost'), h('b', { class: 'mono' }, 'GHOST')), h('span', { class: 'crumb mono', id: 'crumb' }, 'Home')),
      h('div', { class: 'top-r' },
        GH.btn('', { icon: 'term', ghost: true, title: 'Open the terminal', cls: 'top-term', onclick: openTerminal }),
        GH.btn('', { icon: 'full', ghost: true, title: 'Full screen (F11)', id: 'fs', onclick: () => toggleFs() }),
        h('button', { class: 'btn ghost icon', id: 'theme', type: 'button', title: 'Theme', onclick: () => setTheme(theme === 'dark' ? 'light' : 'dark') }, GH.icon('sun')),
        h('button', { class: 'btn ghost acct', type: 'button', id: 'acct', title: 'Account', onclick: accountDialog }, GH.icon('user'), h('span', { class: 'acct-t mono', id: 'acct-t' }, ''))));
  }
  function toggleFs() { fs = !fs; GH.call(GH.api.window.fullscreen, fs).catch(() => {}); }
  function buildStatus() { return h('footer', { class: 'status mono', id: 'status' }, h('span', { class: 'st-a' }, GH.icon('lock'), h('b', {}, 'Local only. '), 'Lookups go only to the service you run them on.'), h('span', { class: 'st-b', id: 'st-vault' }, ''), h('span', { class: 'st-c', id: 'st-case' }, '')); }
  function updateBars() {
    const st = GH.status || {}, a = document.getElementById('acct-t'); if (a) a.textContent = st.account ? (st.account.email || st.account.name || '') : '';
    const sv = document.getElementById('st-vault'); if (sv) { GH.clear(sv).append(GH.icon('lock'), 'Vault ' + (st.vault ? st.vault.state : '')); }
    const sc = document.getElementById('st-case'), c = GH.cs.current(), s = GH.cs.state.save;
    if (sc) { sc.textContent = c ? c.title.slice(0, 40) + ': ' + ({ saved: 'saved ' + GH.fmtClock(s.at), pending: 'changes not saved yet', saving: 'saving', error: 'not saved: ' + s.error, idle: '' }[s.state] || '') : ''; }
  }
  GH.updateBars = updateBars;

  function crumbOf(r) {
    if (r.name === 'm') { const m = window.GhostModules.byId(r.arg); return m ? m.name : 'Modules'; }
    return { home: 'Home', modules: 'Modules', case: 'Case board', tools: 'Tool Integrations' }[r.name] || 'Home';
  }
  async function renderRoute() {
    const r = GH.parseHash(location.hash); current = r; const my = ++token;
    const fn = GH.routes[r.name] || GH.routes.home;
    document.querySelectorAll('.rail .nav').forEach((a) => { const n = a.dataset.nav; const on = n === r.name || (r.name === 'm' && n === 'm:' + r.arg); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    const cr = document.getElementById('crumb'); if (cr) cr.textContent = crumbOf(r);
    document.getElementById('app').dataset.view = r.name;
    const host = document.getElementById('main'); GH.clear(host); host.append(h('div', { class: 'skel pad', 'aria-hidden': 'true' }, h('i', {}), h('i', {}), h('i', {})));
    let node;
    try { node = await fn(r.arg, r.rest); } catch (e) { node = h('div', { class: 'state' }, GH.icon('alert'), h('h2', {}, 'This screen did not load'), h('p', {}, GH.errText(e)), GH.btn('Try again', { onclick: renderRoute })); }
    if (my !== token) return;
    GH.clear(host); if (node) host.append(node); host.scrollTop = 0; window.scrollTo(0, 0); updateBars();
    if (GH.afterRender) GH.afterRender(r);
  }
  GH.render = renderRoute;
  GH.current = () => current;

  GH.mount = function mount() {
    const root = document.getElementById('root'); GH.clear(root);
    root.append(h('div', { class: 'app', id: 'app', dataset: { view: 'home' } }, buildRail(), h('div', { class: 'main-col' }, buildTop(), h('main', { id: 'main', tabindex: '-1' }), buildStatus())));
    setTheme(theme); renderRoute();
  };
  window.addEventListener('hashchange', () => { if (GH.mounted) renderRoute(); });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F11') { e.preventDefault(); if (GH.mounted) toggleFs(); }
    if (e.key === '?' && !/INPUT|TEXTAREA|SELECT/.test((e.target.tagName || ''))) { e.preventDefault(); shortcuts(); }
  });
  if (GH.api && GH.api.onWindow) GH.api.onWindow((p) => { fs = !!p.fullscreen; });
  GH.cs.on((why) => { if (why === 'save' || why === 'open' || why === 'close') updateBars(); });
})();
