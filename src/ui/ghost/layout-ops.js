'use strict';
// Layout "Operations" (console): a menu bar with the lookup box, a row of module tabs, a case tree on the left, the work in the middle and a detail panel on the right.
// Home is a map of the places in the open case with the lines between related places, tables of lookups, entities and activity below, and the selected entity on the right.
(function () {
  const GH = window.GH, h = GH.h, L = window.GhostLay, V = GH.viz, lay = GH.lay;
  const open = new Set(['cases', 'ents']);   // folders of the tree that are open: kept while the frame is redrawn

  // ---------- left: the tree of cases and the entities of the open case ----------
  function tree() {
    const el = h('aside', { class: 'ops-tree', 'aria-label': 'Case files' }), body = h('div', { class: 'ot-body', role: 'tree', 'aria-label': 'Cases and entities' });
    const toggle = h('button', { class: 'ot-toggle', type: 'button', 'aria-expanded': 'true', 'aria-controls': 'ot-body' }, h('span', {}, 'Case files'));
    body.id = 'ot-body';
    const setOpen = (on) => { toggle.setAttribute('aria-expanded', String(on)); el.classList.toggle('shut', !on); };
    toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
    if (window.innerWidth < 720) setOpen(false);
    el.append(h('h2', { class: 'ot-h' }, toggle), body, h('div', { class: 'ot-f' }, GH.btn('Open or start a case', { onclick: async () => { await GH.cs.pickCase(); } })));
    let flat = [], snap = null;
    const nodeFor = (n, level, pos, size) => {
      const folder = !!n.kids, on = open.has(n.id), cur = n.current || (n.entityId && GH.sel.get() === n.entityId);
      const row = h('div', { class: 'otn ' + (folder ? 'fold' : 'leaf') + (cur ? ' cur' : ''), role: 'treeitem', tabindex: '-1', 'aria-level': String(level), 'aria-posinset': String(pos), 'aria-setsize': String(size), 'aria-expanded': folder ? String(on) : null, 'aria-selected': folder ? null : String(!!cur), dataset: { id: n.id } },
        folder ? h('i', { class: 'otn-c', 'aria-hidden': 'true' }) : n.type ? V.glyph(n.type) : h('i', { class: 'otn-f', 'aria-hidden': 'true' }), h('span', { class: 'otn-l' + (n.entityId ? ' mono' : '') }, n.label), n.count !== undefined ? h('span', { class: 'otn-n mono' }, String(n.count)) : n.meta ? h('span', { class: 'otn-n mono', title: 'entities' }, n.meta) : null);
      row.style.setProperty('--lv', String(level - 1));
      row.addEventListener('click', () => act(n));
      return row;
    };
    function act(n) {
      if (n.kids) { if (open.has(n.id)) open.delete(n.id); else open.add(n.id); draw(snap, n.id); return; }
      if (n.kind === 'case') { if (!n.current) GH.cs.open(n.caseId).catch((e) => GH.toast(GH.errText(e))); return; }
      if (n.entityId) GH.sel.set(n.entityId, 'tree');
    }
    function draw(s, focusId) {
      snap = s; GH.clear(body); flat = [];
      const nodes = L.buildTree(s && s.cases, s && s.current, GH.TYPE_LABEL);
      if (s && s.cases && !s.cases.length && !s.current) body.append(h('p', { class: 'dt-empty' }, 'No cases yet. Start one below, or add results from any module.'));
      if (s && !s.cases) body.append(h('p', { class: 'dt-empty', role: 'alert' }, 'Cases could not be read.'));
      const selE = GH.sel.get() && s && s.current ? s.current.entities[GH.sel.get()] : null, selType = selE ? selE.type : null; if (selType) open.add('type:' + selType);
      const walk = (list, level) => list.forEach((n, i) => {
        const row = nodeFor(n, level, i + 1, list.length); body.append(row); flat.push(row);
        if (n.kids && open.has(n.id)) { walk(n.kids, level + 1); if (n.more) body.append(h('p', { class: 'otn-more mono' }, 'and ' + n.more + ' more: use the board or the tables')); }
      });
      walk(nodes, 1);
      const want = (focusId && flat.find((r) => r.dataset.id === focusId)) || flat.find((r) => r.classList.contains('cur')) || flat[0]; if (want) want.tabIndex = 0;
      if (focusId && want) want.focus({ preventScroll: true });
    }
    body.addEventListener('keydown', (ev) => {
      const i = flat.indexOf(document.activeElement); if (i < 0) return;
      const go = (j) => { const r = flat[Math.max(0, Math.min(flat.length - 1, j))]; if (r) { flat.forEach((x) => { x.tabIndex = -1; }); r.tabIndex = 0; r.focus(); } };
      const id = document.activeElement.dataset.id, n = findNode(id), isOpen = open.has(id);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); go(i + 1); } else if (ev.key === 'ArrowUp') { ev.preventDefault(); go(i - 1); } else if (ev.key === 'Home') { ev.preventDefault(); go(0); } else if (ev.key === 'End') { ev.preventDefault(); go(flat.length - 1); }
      else if (ev.key === 'ArrowRight' && n && n.kids) { ev.preventDefault(); if (!isOpen) { open.add(id); draw(snap, id); } else go(i + 1); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); if (n && n.kids && isOpen) { open.delete(id); draw(snap, id); } else { const lv = Number(document.activeElement.getAttribute('aria-level')); for (let j = i - 1; j >= 0; j--) if (Number(flat[j].getAttribute('aria-level')) < lv) { go(j); break; } } }
      else if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (n) act(n); }
    });
    function findNode(id) { let out = null; const walk = (l) => { for (const n of l) { if (n.id === id) { out = n; return; } if (n.kids) walk(n.kids); } }; walk(L.buildTree(snap && snap.cases, snap && snap.current, GH.TYPE_LABEL)); return out; }
    const refresh = async () => { try { draw(await GH.data.snapshot()); } catch { draw(null); } };
    const offs = [GH.cs.on((why) => { if (why !== 'save') { GH.data.bust(); refresh(); } }), GH.sel.on((id, from) => { if (from !== 'tree') draw(snap, null); })];
    refresh();
    return { el, refresh, destroy: () => offs.forEach((o) => o()) };
  }

  // ---------- right: the selected entity ----------
  function detail() {
    const el = h('aside', { class: 'ops-detail', 'aria-label': 'Entity details' }), body = h('div', { class: 'od-b', 'aria-live': 'polite' });
    el.append(h('h2', { class: 'od-h' }, 'Entity details'), body);
    const draw = () => {
      GH.clear(body); const c = GH.cs.current(), id = GH.sel.get();
      if (!c) { body.append(V.empty('No case is open. Open or start one to see what it holds.', GH.btn('Open or start a case', { primary: true, onclick: () => GH.cs.pickCase() }))); return; }
      if (!id) { body.append(h('p', { class: 'od-case mono' }, c.title), V.empty(Object.keys(c.entities).length ? 'Select an entity in the tree, on the map or in a table to see where it came from.' : 'This case has no entities yet. Run a lookup in any module and add its results.')); return; }
      body.append(lay.entityDetail(c, id, { caseTitle: c.title }));
    };
    draw();
    const offs = [GH.sel.on(draw), GH.cs.on((why) => { if (why !== 'save') draw(); })];
    return { el, destroy: () => offs.forEach((o) => o()) };
  }

  GH.layouts.ops = {
    shell(P) {
      const items = P.navItems(), lk = lay.lookupForm({ cls: 'ops-cmd', button: 'Look up', prompt: 'Look up', kind: false });
      const menu = h('header', { class: 'ops-menu' }, h('a', { class: 'ops-brand', href: '#home', 'aria-label': 'Mayfair Ghost, home' }, GH.icon('ghost', 'brand-ico'), h('b', {}, 'MAYFAIR'), h('i', {}, 'GHOST')), h('span', { class: 'crumb', id: 'crumb' }, 'Home'), h('div', { class: 'ops-cmdw' }, lk.form, lk.err), P.actions());
      const tabs = h('nav', { class: 'ops-tabs', 'aria-label': 'Ghost' }, h('div', { class: 'ops-tabs-in' }, items.map((it) => lay.navLink(it, 'otab', it.short && it.nav !== 'case' && it.nav !== 'tools' ? it.label : it.label)), lay.termButton('otab')));
      const t = tree(), d = detail();
      if (!GH.cs.current()) GH.cs.list().then((l) => { if (!GH.cs.current() && Array.isArray(l) && l.length) { const last = l.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0]; return GH.cs.open(last.id); } }).catch(() => {});
      const root = h('div', { class: 'app ops-app', id: 'app', dataset: { view: 'home', layout: 'console' } }, menu, tabs, h('div', { class: 'ops-body' }, t.el, h('main', { id: 'main', tabindex: '-1' }), d.el), P.buildStatus());
      return { root, destroy() { t.destroy(); d.destroy(); } };
    },

    home() {
      let snap = null;
      const pm = GH.placeMap(() => snap, { onSelect: (id) => GH.sel.set(id, 'map'), note: 'Plain latitude and longitude grid. No basemap is installed.',
        empty: (s) => V.empty(s.current ? 'This case has no places with coordinates yet. Add a place in Places, or look one up, and it is drawn here with the lines between related places.' : 'No case is open. Open or start a case, then add places to see them here.', s.current ? GH.btn('Add a place', { primary: true, onclick: () => GH.go('m', 'places') }) : GH.btn('Open or start a case', { primary: true, onclick: () => GH.cs.pickCase() })) });
      const meta = h('span', { class: 'pn-m mono' }, 'Reading the case'), tl = h('div', {}, h('p', { class: 'dt-empty' }, 'Loading')), te = h('div', {}), ta = h('div', {});
      const legend = h('ul', { class: 'pm-legend', 'aria-label': 'Map key' }, h('li', {}, h('i', { class: 'k-pin' }), 'Place with coordinates'), h('li', {}, h('i', { class: 'k-sat' }), 'Linked entity, drawn beside its place'), h('li', {}, h('i', { class: 'k-link' }), 'Related places'));
      const sec = h('section', { class: 'view ops-home', 'aria-label': 'Operations home' },
        h('section', { class: 'pn ops-map', 'aria-labelledby': 'h-opsmap' }, h('div', { class: 'pn-h' }, h('h2', { id: 'h-opsmap' }, 'Case map'), meta), h('div', { class: 'pn-b' }, pm.el, legend)),
        h('div', { class: 'ops-tables' }, V.panel('Recent lookups', tl, { cls: 'ops-t1', meta: 'this window and the open case' }), V.panel('Entities in this case', te, { cls: 'ops-t2', meta: 'most linked first' }), V.panel('Activity', ta, { cls: 'ops-t3', meta: 'newest first' })));
      const fill = (s) => {
        snap = s;
        meta.textContent = s.current ? s.current.title + ' · ' + GH.plural(s.pins.length, 'place') + ' · ' + GH.plural(s.links.length, 'line') + ' between places' : 'No case open';
        GH.clear(tl).append(V.lookupTable(s, { cols: 5, limit: 10 }));
        GH.clear(te).append(V.entityTable(s, { limit: 10, onRow: (r) => GH.sel.set(r.id, 'table'), cols: 4 }));
        GH.clear(ta).append(V.activityList(s, { limit: 10 }));
        pm.redraw();
      };
      const refresh = async (why) => { try { const s = await GH.data.snapshot(why !== 'sel'); fill(s); } catch (e) { meta.textContent = GH.errText(e); } };
      GH.data.watch(sec, refresh, { sel: true, save: false }); refresh();
      requestAnimationFrame(() => pm.start());
      return sec;
    },

    // The state of this module's connectors as a table above the connector cards.
    moduleSummary(m) {
      return V.panel('Connector status', lay.withConnectors('ops-msum-b', (list) => {
        const rows = lay.moduleRows(m, list), ready = rows.filter((r) => r.key === 'passed').length;
        return h('div', {}, h('p', { class: 'ops-msum-t mono' }, ready + ' of ' + rows.length + ' ready · ' + rows.filter((r) => r.key === 'not-installed').length + ' not installed · ' + rows.filter((r) => r.key === 'needs-approval').length + ' need approval'),
          V.table({ caption: 'Connectors for ' + m.name, cols: [{ key: 'name', label: 'Connector' }, { key: 'id', label: 'Id', cls: 'mono' }, { key: 'scope', label: 'Scope', cls: 'mono' }, { key: 'state', label: 'State', get: (r) => h('span', { class: 'st-' + r.key }, r.state) }, { key: 'tested', label: 'Tested', cls: 'mono' }], rows }));
      }), { cls: 'ops-msum', meta: m.active ? 'active module' : 'passive module' });
    },

    // Above the case board: counts and the entities by type, from the open case.
    boardStrip(c) {
      const hl = L.caseHealth(c); if (!hl) return null;
      const types = Object.entries(hl.byType).sort((a, b) => b[1] - a[1]);
      return h('div', { class: 'ops-bstrip' },
        h('dl', { class: 'ops-bstats' }, [['Entities', hl.entities], ['Links', hl.edges], ['Sources', hl.sources], ['Places', hl.places], ['With a source', hl.pct === null ? '--' : hl.pct + '%']].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { class: 'mono' }, String(v))))),
        h('ul', { class: 'ops-btypes', 'aria-label': 'Entities by type' }, types.map(([t, n]) => h('li', {}, h('span', { class: 'mono' }, GH.TYPE_PLURAL[t] || t), V.meter({ value: n, max: hl.entities, label: (GH.TYPE_PLURAL[t] || t) + ': ' + n + ' of ' + hl.entities }), h('b', { class: 'mono' }, String(n))))));
    },
  };
})();
