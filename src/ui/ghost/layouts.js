'use strict';
// Shared pieces of the skin layouts: navigation links, the lookup box, the entity detail, small helpers. Each layout (layout-*.js) builds its own frame and Home from these and from GH.viz.
(function () {
  const GH = window.GH, h = GH.h, L = window.GhostLay;
  const lay = (GH.lay = {});

  // A navigation link for the item list GH.shellParts.navItems() returns.
  lay.navLink = (it, cls, text) => h('a', { class: cls, href: it.href, dataset: { nav: it.nav }, title: it.label }, h('span', {}, text || it.label), it.active ? h('i', { class: 'act-dot', title: 'Active scanning', 'aria-hidden': 'true' }) : null);
  lay.termButton = (cls, text) => h('button', { class: cls, type: 'button', id: 'nav-term', onclick: GH.shellParts.openTerminal }, h('span', {}, text || 'Terminal'));

  // The lookup box. It takes only what Home takes (a domain, IP, ASN or web address) and says plainly when it refuses.
  // o: { id, cls, label, placeholder, button, prompt }
  lay.lookupForm = (o = {}) => {
    const S = window.GhostScope;
    const err = h('p', { class: 'cmd-err lk-err', role: 'alert', hidden: true }), input = h('input', { id: o.id || 'cmdq', class: 'mono lk-in', type: 'text', placeholder: o.placeholder || 'domain, IP, ASN, URL, company or place', 'aria-label': o.label || 'What to look up: domain, IP, ASN, URL, company or place', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'data-autofocus': o.autofocus ? '' : null });
    const kind = h('span', { class: 'lk-kind mono', 'aria-live': 'polite' }, 'auto');
    input.addEventListener('input', () => { const d = S.detectInput(input.value); kind.textContent = d.refused ? 'not looked up' : d.kind || 'auto'; err.hidden = true; });
    const form = h('form', { class: 'lk ' + (o.cls || ''), autocomplete: 'off', onsubmit: (ev) => { ev.preventDefault(); const why = GH.submitLookup(input.value); err.hidden = !why; err.textContent = why || ''; } },
      o.prompt ? h('label', { class: 'lk-p mono', for: input.id }, o.prompt) : null, input, o.kind === false ? null : kind, GH.btn(o.button || 'Look up', { primary: true, type: 'submit' }));
    return { form, input, err };
  };

  const MODULE_OF = { domain: 'domains', ip: 'domains', asn: 'domains', url: 'archive', org: 'companies', place: 'places' };
  // Everything known about one entity of the open case, as a node. Used by the Operations detail panel.
  lay.entityDetail = (c, id, o = {}) => {
    const e = c && c.entities[id]; if (!e) return null;
    const M = window.GhostCase, nb = M.neighbours(c, id), srcs = e.sources.map((s) => c.sources[s]).filter(Boolean), un = GH.caseUnsourced(e), coords = e.type === 'place' ? M.placeCoords(e) : null;
    const go = (x) => { GH.sel.set(x, 'detail'); };
    const facts = h('dl', { class: 'ed-facts' },
      h('div', {}, h('dt', {}, 'First seen'), h('dd', { class: 'mono' }, GH.fmtDate(e.firstSeen) || '--')), h('div', {}, h('dt', {}, 'Last seen'), h('dd', { class: 'mono' }, GH.fmtDate(e.lastSeen) || '--')),
      h('div', {}, h('dt', {}, 'Sources'), h('dd', { class: 'mono' }, String(srcs.length))), h('div', {}, h('dt', {}, 'Links'), h('dd', { class: 'mono' }, String(nb.length))));
    const rows = nb.slice(0, 40).map((n) => { const x = c.entities[n.other]; return x ? { id: x.id, rel: (n.dir === 'out' ? '→ ' : '← ') + n.edge.rel, label: x.label, type: x.type, warn: GH.caseUnsourced(x) } : null; }).filter(Boolean);
    const conn = rows.length ? h('div', { class: 'dt-wrap' }, h('table', { class: 'dt ed-conn' }, h('caption', { class: 'sr' }, 'Connections of ' + e.label), h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Relation'), h('th', { scope: 'col' }, 'Entity'))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r.warn ? 'warn' : '' }, h('td', { class: 'mono' }, r.rel), h('td', {}, h('button', { class: 'rowbtn mono', type: 'button', onclick: () => go(r.id), title: r.warn ? 'No source is recorded for this entity' : null }, r.label))))))) : h('p', { class: 'dt-empty' }, 'No links yet.');
    const mod = MODULE_OF[e.type];
    return h('div', { class: 'ed' },
      h('p', { class: 'ed-type' }, (GH.TYPE_LABEL[e.type] || e.type) + (o.caseTitle ? ' in ' + o.caseTitle : '')),
      h('p', { class: 'ed-val mono' }, e.label),
      un ? h('p', { class: 'ed-warn', role: 'status' }, 'No source is recorded for this item. Do not rely on it.') : e.manual && !srcs.length ? h('p', { class: 'ed-note' }, 'Added by hand. No connector produced it.') : null,
      facts, coords ? h('p', { class: 'mono sm mute' }, coords.lat.toFixed(5) + ', ' + coords.lon.toFixed(5)) : null,
      h('h3', { class: 'ed-h' }, 'Connections'), conn,
      h('h3', { class: 'ed-h' }, 'Where it came from'),
      srcs.length ? h('ul', { class: 'ed-src' }, srcs.slice(0, 6).map((s) => h('li', {}, h('b', { class: 'mono' }, s.connector + (s.connectorVersion ? ' v' + s.connectorVersion : '')), h('span', { class: 'mute sm' }, [s.query ? 'looked up "' + s.query.value + '"' : '', 'fetched ' + GH.fmtTime(s.fetchedAt)].filter(Boolean).join(' · '))))) : h('p', { class: 'dt-empty' }, 'None recorded.'),
      h('div', { class: 'row-a' }, GH.btn('Show on the case board', { onclick: () => GH.go('case', c.id) }), mod ? GH.btn('Look up', { onclick: () => GH.go('m', mod, e.label) }) : null));
  };

  const testedText = (entry) => { const i = entry && entry.install, lt = i && i.lastTest, t = lt ? L.toMs(lt.t) : null; if (!i || i.verified === 'not-tested' || t === null) return 'no'; return (i.verified === 'tested' ? 'passed ' : 'failed ') + new Date(t).toISOString().slice(0, 10); };
  // The state of one module's connectors as rows: used by the module screens of several layouts.
  lay.moduleRows = (m, list) => {
    const S = window.GhostModules, by = new Map((list || []).map((c) => [c.id, c])), seen = new Set(), rows = [];
    const add = (id, label, entry) => { if (seen.has(id)) return; seen.add(id); const st = S.statusOf(entry, id); rows.push({ id, name: entry ? entry.name : label, key: st.key, state: st.label, scope: entry ? (entry.scope || '').toUpperCase() : '', version: entry && entry.version ? 'v' + entry.version : '', tested: testedText(entry) }); };
    for (const w of m.wants) add(w[0], w[1], by.get(w[0]) || null);
    for (const c of list || []) if (!seen.has(c.id) && (c.capabilities || []).includes('ghost-' + m.id)) add(c.id, c.name, c);
    return rows;
  };
  // A node that fills itself with the connector rows once the list has loaded. build(rows, stats) -> Node
  lay.withConnectors = (cls, build) => {
    const host = h('div', { class: cls }, h('p', { class: 'dt-empty' }, 'Reading the connector list'));
    GH.conn.list().then((list) => { const st = L.connStats(list); GH.clear(host).append(build(list, st)); }).catch((e) => { GH.clear(host).append(h('p', { class: 'dt-empty', role: 'alert' }, 'The connector list could not be read: ' + GH.errText(e))); });
    return host;
  };
})();
