'use strict';
// Ghost screens: Home, the module index, the case list and Tool Integrations.
(function () {
  const GH = window.GH, h = GH.h, S = window.GhostScope, MODS = window.GhostModules.MODULES;

  // connector list, cached for a few seconds so several screens can ask
  let cache = null, cacheAt = 0;
  GH.conn = {
    async list(force) { if (!force && cache && Date.now() - cacheAt < 4000) return cache; cache = await GH.call(GH.api.connectors.list); cacheAt = Date.now(); return cache; },
    bust() { cache = null; },
    // the installed connector for a wanted id, matching on id or on the capability name `ghost-<module id>`
    find(list, id) { return list.find((c) => c.id === id) || null; },
    forModule(list, m) { const known = new Set(m.wants.map((w) => w[0])); const extra = list.filter((c) => !known.has(c.id) && (c.capabilities || []).includes('ghost-' + m.id)); return { wanted: m.wants.map(([id, label]) => ({ id, label, entry: GH.conn.find(list, id) })), extra }; },
  };

  function moduleCard(m, counts) {
    const c = counts && counts[m.id];
    return h('a', { class: 'mod' + (m.active ? ' act' : ''), href: GH.href('m', m.id) },
      h('div', { class: 'mod-top' }, GH.icon(m.icon, 'ico-l'), h('span', { class: 'tag' + (m.active ? ' act' : '') }, m.active ? 'ACTIVE' : 'PASSIVE')),
      h('h3', {}, m.name), h('p', {}, m.blurb),
      h('div', { class: 'mod-f mono mute' }, h('span', {}, c ? c.ready + ' of ' + c.total + ' connectors installed' : ''), h('span', {}, m.active ? 'scope guard' : 'no scope needed')));
  }
  async function moduleCounts() {
    try {
      const list = await GH.conn.list(); const out = {};
      for (const m of MODS) { const { wanted, extra } = GH.conn.forModule(list, m); const total = wanted.length + extra.length; const ready = wanted.filter((w) => w.entry && w.entry.install && w.entry.install.installed).length + extra.filter((e) => e.install && e.install.installed).length; out[m.id] = { ready, total }; }
      return out;
    } catch { return null; }
  }

  GH.routes.home = async () => {
    const err = h('p', { class: 'cmd-err', role: 'alert', hidden: true }), input = h('input', { id: 'cmdq', class: 'mono', type: 'text', placeholder: 'domain, IP, ASN or URL', 'aria-label': 'What to look up: domain, IP, ASN or URL', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'data-autofocus': '' });
    const kind = h('span', { class: 'cmd-t mono', id: 'cmdt', 'aria-live': 'polite' }, 'auto');
    input.addEventListener('input', () => { const d = S.detectInput(input.value); kind.textContent = d.refused ? 'not looked up' : d.kind || 'auto'; err.hidden = true; });
    const submit = (ev) => {
      ev.preventDefault(); const d = S.detectInput(input.value); err.hidden = false;
      if (!input.value.trim()) { err.textContent = 'Type a domain, IP address, ASN or web address.'; return; }
      if (d.refused) { err.textContent = d.reason; return; }
      if (d.kind === 'cidr') { err.textContent = 'A range is checked in Active scanning, which asks you to declare a target first.'; return; }
      if (!d.kind) { err.textContent = d.reason || 'That is not a domain, IP address, ASN or web address. For an organisation, use Companies and public records.'; return; }
      err.hidden = true; GH.go('m', 'domains', d.value);
    };
    const rec = h('ul', { class: 'list', id: 'recent' }, h('li', { class: 'mute' }, 'Loading'));
    const modsHost = h('div', { class: 'grid mods' }, MODS.map((m) => moduleCard(m, null)));
    moduleCounts().then((c) => { if (c) { GH.clear(modsHost); modsHost.append(...MODS.map((m) => moduleCard(m, c))); } });
    GH.cs.list().then((list) => {
      GH.clear(rec);
      if (!list.length) rec.append(h('li', { class: 'empty-s' }, 'No cases yet. Add results from any module, or start an empty case.'));
      for (const c of list.slice(0, 5)) rec.append(h('li', {}, h('a', { href: GH.href('case', c.id) }, GH.icon('board'), h('span', { class: 't' }, h('b', {}, c.title), h('span', {}, GH.plural(c.entities, 'entity', 'entities') + ', ' + GH.plural(c.sources, 'source') + ', ' + GH.fmtTime(c.updated))), h('span', { class: 'enc', title: 'Encrypted in your vault' }, GH.icon('lock')))));
    }).catch((e) => { GH.clear(rec); rec.append(h('li', { class: 'state-s' }, GH.errText(e))); });
    return h('section', { class: 'view', 'aria-labelledby': 'h-home' },
      h('div', { class: 'hero' }, h('div', { class: 'hero-grid', 'aria-hidden': 'true' }), h('div', { class: 'hero-scan', 'aria-hidden': 'true' }),
        h('div', { class: 'hero-in' }, h('p', { class: 'eyebrow mono' }, 'OPEN-SOURCE INTELLIGENCE'), h('h1', { id: 'h-home' }, 'See what is already public.'),
          h('p', { class: 'lead' }, 'Domains, companies, files, places and news in one case file. Free, no limits, and everything stays on this computer.'),
          h('form', { class: 'cmd', onsubmit: submit, autocomplete: 'off' }, h('label', { class: 'cmd-l mono', for: 'cmdq', 'aria-hidden': 'true' }, '›'), input, kind, GH.btn('Investigate', { primary: true, type: 'submit' })), err,
          h('p', { class: 'try mono' }, 'Names of people, usernames, emails and phone numbers are not looked up.')),
        heroArt()),
      h('div', { class: 'sec-h' }, h('h2', {}, 'Modules'), h('span', { class: 'mute' }, 'Nothing runs until you press a button. Every result keeps its source.')), modsHost,
      h('div', { class: 'two' },
        h('section', { class: 'panel', 'aria-labelledby': 'h-recent' }, h('div', { class: 'panel-h' }, h('h2', { id: 'h-recent' }, 'Recent cases'), h('a', { class: 'link', href: '#case' }, 'All cases')), rec),
        h('section', { class: 'panel', 'aria-labelledby': 'h-rules' }, h('div', { class: 'panel-h' }, h('h2', { id: 'h-rules' }, 'Rules of the road')), h('ul', { class: 'rules' },
          [['Public sources only.', 'No logins, no CAPTCHAs, no people-search.'], ['Scans need a declared target.', 'Your own systems, or written permission. Every scan is logged in your vault.'], ['Nothing leaves this computer', 'except the lookups you run.']].map(([a, b]) => h('li', {}, GH.icon('check'), h('span', {}, h('b', {}, a + ' '), b)))))));
  };
  function heroArt() {
    const NS = 'http://www.w3.org/2000/svg', e = (t, a, txt) => { const x = document.createElementNS(NS, t); for (const [k, v] of Object.entries(a || {})) x.setAttribute(k, v); if (txt) x.textContent = txt; return x; };
    const svg = e('svg', { class: 'hero-art', viewBox: '0 0 360 300', 'aria-hidden': 'true', focusable: 'false' });
    const rings = e('g', { class: 'ra-rings', fill: 'none', stroke: 'var(--mf-line)', 'stroke-width': '1' });
    for (const r of [30, 70, 110]) rings.append(e('circle', { cx: 180, cy: 150, r })); rings.append(e('circle', { cx: 180, cy: 150, r: 146, 'stroke-dasharray': '2 5' }), e('path', { d: 'M180 0v300M20 150h320', 'stroke-dasharray': '1 6' }));
    const ticks = e('g', { stroke: 'var(--mf-mute)', 'stroke-width': '1' });
    for (let i = 0; i < 72; i++) { const a = (i * 5 * Math.PI) / 180, l = i % 6 === 0 ? 8 : 4; ticks.append(e('line', { x1: 180 + Math.sin(a) * 146, y1: 150 - Math.cos(a) * 146, x2: 180 + Math.sin(a) * (146 - l), y2: 150 - Math.cos(a) * (146 - l) })); }
    const defs = e('defs'), lg = e('linearGradient', { id: 'sw', x1: 1, y1: 0, x2: 0, y2: 0 }); lg.append(e('stop', { offset: 0, 'stop-color': 'var(--mf-accent)', 'stop-opacity': 0 }), e('stop', { offset: 1, 'stop-color': 'var(--mf-accent)', 'stop-opacity': 0.22 })); defs.append(lg);
    const sweep = e('g', { class: 'ra-sweep' }); sweep.append(e('path', { d: 'M180 150 180 4A146 146 0 0 1 306 77Z', fill: 'url(#sw)' }), e('path', { d: 'M180 150V4', stroke: 'var(--mf-accent)', 'stroke-width': '1.4' }));
    const dots = e('g', { fill: 'var(--mf-surface)', stroke: 'var(--mf-text)', 'stroke-width': '1.4' }); dots.append(e('circle', { cx: 236, cy: 88, r: 4 }), e('rect', { x: 118, y: 196, width: 8, height: 8, rx: 1.5 }), e('circle', { cx: 262, cy: 176, r: 4 }));
    const blip = e('g', { fill: 'none', stroke: 'var(--mf-accent)', 'stroke-width': '1.2' }); blip.append(e('circle', { class: 'blip', cx: 236, cy: 88, r: 9 }));
    svg.append(rings, ticks, defs, sweep, dots, blip, e('text', { x: 244, y: 84, class: 'ra-t' }, '203.0.113.10'), e('text', { x: 130, y: 214, class: 'ra-t' }, 'AS64496'), e('text', { x: 270, y: 194, class: 'ra-t' }, '198.51.100.7'), e('text', { x: 14, y: 292, class: 'ra-t' }, '53.5511 N  9.9937 E'));
    return svg;
  }

  GH.routes.modules = async () => h('section', { class: 'view' }, h('div', {}, h('p', { class: 'eyebrow mono' }, 'INVESTIGATE'), h('h1', {}, 'Modules'), h('p', { class: 'lead sm' }, 'Each module runs the connectors installed on this computer and shows the ones that are not.')),
    (() => { const g = h('div', { class: 'grid mods' }, MODS.map((m) => moduleCard(m, null))); moduleCounts().then((c) => { if (c) { GH.clear(g); g.append(...MODS.map((m) => moduleCard(m, c))); } }); return g; })());

  // ---------- case list ----------
  GH.routes.case = async (id) => {
    if (id) return GH.routes.board(id);
    let list = [], error = null; try { list = await GH.cs.list(); } catch (e) { error = GH.errText(e); }
    const host = h('div', {}), name = h('input', { type: 'text', id: 'nc-name', value: '', maxlength: '200', placeholder: 'Name of the case', 'aria-label': 'Name of the new case' });
    const create = async (ev) => { ev.preventDefault(); try { const c = await GH.cs.create(name.value.trim() || 'Untitled case'); GH.go('case', c.id); } catch (e) { GH.toast(GH.errText(e)); } };
    const draw = (rows) => {
      GH.clear(host);
      if (error) { host.append(h('div', { class: 'state' }, GH.icon('alert'), h('h2', {}, 'Cases could not be read'), h('p', {}, error), GH.btn('Try again', { onclick: GH.render }))); return; }
      if (!rows.length) { host.append(h('div', { class: 'state' }, GH.icon('board'), h('h2', {}, 'No cases yet'), h('p', {}, 'A case holds what you find, with the source of every item. Start an empty one here, or add results from any module.'))); return; }
      host.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Case', 'Entities', 'Sources', 'Changed', ''].map((t, i) => h('th', { scope: 'col', class: i > 0 && i < 3 ? 'r' : '' }, t)))),
        h('tbody', {}, rows.map((c) => h('tr', {}, h('td', {}, h('a', { class: 'link', href: GH.href('case', c.id) }, c.title)), h('td', { class: 'r' }, String(c.entities)), h('td', { class: 'r' }, String(c.sources)), h('td', { class: 'mono mute' }, GH.fmtTime(c.updated)),
          h('td', { class: 'r' }, GH.btn('', { icon: 'trash', ghost: true, title: 'Delete ' + c.title, onclick: async () => { if (await GH.confirm('Delete this case?', '"' + c.title + '" and its backups are overwritten and removed from your vault. This cannot be undone.', 'Delete case', true)) { try { await GH.cs.remove(c.id); GH.render(); } catch (e) { GH.toast(GH.errText(e)); } } } }))))))));
    };
    draw(list);
    return h('section', { class: 'view' }, h('div', { class: 'case-head' }, h('div', { class: 'case-t' }, h('p', { class: 'eyebrow mono' }, 'CASE BOARD'), h('h1', {}, 'Your cases'), h('p', { class: 'meta mono' }, GH.icon('lock'), ' Sealed in your Ghost vault on this computer')),
      h('form', { class: 'case-a', onsubmit: create }, name, GH.btn('New case', { primary: true, type: 'submit', icon: 'plus' }))), host);
  };

  // ---------- Tool Integrations ----------
  GH.routes.tools = async () => {
    const host = h('div', { class: 'stack' }, h('div', { class: 'skel' }, h('i', {}), h('i', {})));
    const draw = async (force) => {
      let list; try { list = await GH.conn.list(force); } catch (e) { GH.clear(host); host.append(h('div', { class: 'state' }, GH.icon('alert'), h('h2', {}, 'Tools could not be listed'), h('p', {}, GH.errText(e)), GH.btn('Try again', { onclick: () => draw(true) }))); return; }
      GH.clear(host);
      if (!list.length) { host.append(h('div', { class: 'state' }, GH.icon('tool'), h('h2', {}, 'No connectors are installed'), h('p', {}, 'Connectors are separate programs with a manifest. Modules show which ones they look for. Nothing is shown as ready until its own self-test passes on this computer.'))); return; }
      host.append(h('div', { class: 'cards' }, list.map((c) => GH.connectorCard({ entry: c, label: c.name, onChange: () => draw(true), runnable: false }))));
    };
    draw(false);
    return h('section', { class: 'view' }, h('div', { class: 'case-head' }, h('div', { class: 'case-t' }, h('p', { class: 'eyebrow mono' }, 'TOOLS'), h('h1', {}, 'Tool Integrations'), h('p', { class: 'lead sm' }, 'The connectors on this computer: what each one needs, whether it passed its own test, and what it may do. You approve a tool in a native dialog; Ghost cannot approve for you.')),
      h('div', { class: 'case-a' }, GH.btn('Open the full page in Mayfair', { icon: 'link', onclick: async () => { try { await GH.call(GH.api.toolIntegrations.open); } catch (e) { GH.toast(GH.errText(e)); } } }), GH.btn('Terminal', { icon: 'term', onclick: GH.openTerminal }))), host);
  };
})();
