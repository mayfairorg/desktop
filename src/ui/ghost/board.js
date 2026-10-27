'use strict';
// Case board: graph, inspector with provenance, timeline, notes, sources, tags, undo/redo, keyboard use, report export.
// Every change goes through GH.cs.mutate so it can be undone. The case lives in the vault; this page holds it in memory only.
(function () {
  const GH = window.GH, h = GH.h, M = window.GhostCase;
  const TABS = [['graph', 'Graph'], ['timeline', 'Timeline'], ['notes', 'Notes'], ['sources', 'Sources']];

  GH.routes.board = async (id) => {
    if (!GH.cs.current() || GH.cs.current().id !== id) { try { await GH.cs.open(id); } catch (e) { return h('div', { class: 'state' }, GH.icon('alert'), h('h2', {}, 'That case did not open'), h('p', {}, GH.errText(e)), GH.btn('Back to cases', { onclick: () => GH.go('case') })); } }
    return boardView();
  };

  function boardView() {
    const ui = { tab: 'graph', sel: [], q: '', hide: new Set(), tag: '', group: false, path: null, pathFrom: null };
    try { const t = sessionStorage.getItem('ghost-tab'); if (TABS.some((x) => x[0] === t)) ui.tab = t; } catch { /* no storage */ }
    const c = () => GH.cs.current();
    const root = h('section', { class: 'view board', 'aria-label': 'Case board' });
    const head = h('div', { class: 'bd-head' }), tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Case views' }), toolbar = h('div', { class: 'bd-tools' }), body = h('div', { class: 'bd-body' });
    const graphPane = h('div', { class: 'gpane' }), inspector = h('aside', { class: 'insp', 'aria-label': 'Inspector' }), other = h('div', { class: 'opane' });
    root.append(head, tabsEl, toolbar, body);
    let graph = null;

    // ---------- header ----------
    function drawHead() {
      const cs = c(), st = M.stats(cs), S = GH.cs.state.save, hist = GH.cs.hist();
      const title = h('input', { class: 'title-in', id: 'bd-title', type: 'text', value: cs.title, maxlength: '200', 'aria-label': 'Case title' });
      title.addEventListener('change', () => { const v = title.value.trim() || 'Untitled case'; if (v !== cs.title) GH.cs.mutate('Rename case', (x) => { x.title = v.slice(0, 200); }); });
      GH.clear(head).append(
        h('div', { class: 'bd-t' }, h('a', { class: 'back', href: '#case' }, GH.icon('back'), h('span', {}, 'Cases')), title,
          h('p', { class: 'mute sm mono' }, [GH.plural(st.entities, 'entity', 'entities'), GH.plural(st.edges, 'link'), GH.plural(st.sources, 'source'), GH.plural(st.notes, 'note')].join(' · ') + ' · ', h('span', { id: 'bd-save', class: S.state === 'error' ? 'err' : '' }, ({ saved: 'Saved ' + GH.fmtClock(S.at) + ', encrypted in your vault', pending: 'Changes not saved yet', saving: 'Saving', error: 'Not saved: ' + S.error, idle: '' })[S.state] || ''))),
        h('div', { class: 'bd-a' }, GH.btn('Undo', { icon: 'undo', disabled: !hist || !hist.canUndo(), title: 'Undo (Ctrl Z)', onclick: () => GH.cs.undo() }), GH.btn('Redo', { icon: 'redo', disabled: !hist || !hist.canRedo(), title: 'Redo (Ctrl Shift Z)', onclick: () => GH.cs.redo() }),
          GH.btn('Add entity', { icon: 'plus', onclick: addEntityDialog }), GH.btn('Export report', { icon: 'report', primary: true, onclick: reportDialog })));
    }
    function drawTabs() {
      GH.clear(tabsEl).append(...TABS.map(([k, l]) => h('button', { class: 'tab', type: 'button', role: 'tab', id: 'tab-' + k, 'aria-selected': String(ui.tab === k), 'aria-controls': 'bd-panel', tabindex: ui.tab === k ? '0' : '-1', onclick: () => { ui.tab = k; try { sessionStorage.setItem('ghost-tab', k); } catch { /* ok */ } drawAll(); }, onkeydown: (e) => { const i = TABS.findIndex((x) => x[0] === ui.tab); const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null; if (n === null) return; e.preventDefault(); ui.tab = TABS[(n + TABS.length) % TABS.length][0]; drawAll(); document.getElementById('tab-' + ui.tab).focus(); } }, l)));
    }

    // ---------- toolbar ----------
    function matchSet() { const cs = c(); if (!ui.q.trim() && !ui.tag) return null; let ids = new Set(M.search(cs, ui.q)); if (ui.tag) ids = new Set([...ids].filter((i) => cs.entities[i].tags.includes(ui.tag))); return ids; }
    function drawTools() {
      const cs = c(); const types = [...new Set(Object.values(cs.entities).map((e) => e.type))].sort(), tags = M.allTags(cs);
      const q = h('input', { id: 'bd-q', type: 'search', placeholder: 'Search the case (/)', value: ui.q, 'aria-label': 'Search the case', autocomplete: 'off' });
      q.addEventListener('input', () => { ui.q = q.value; applyFilters(); });
      const tagSel = h('select', { id: 'bd-tag', 'aria-label': 'Filter by tag' }, h('option', { value: '' }, 'All tags'), tags.map(([t, n]) => h('option', { value: t, selected: ui.tag === t }, t + ' (' + n + ')')));
      tagSel.addEventListener('change', () => { ui.tag = tagSel.value; applyFilters(); });
      GH.clear(toolbar).append(q, tagSel,
        h('div', { class: 'chips', role: 'group', 'aria-label': 'Show entity types' }, types.map((t) => { const on = !ui.hide.has(t); return h('button', { class: 'chip', type: 'button', 'aria-pressed': String(on), onclick: () => { if (on) ui.hide.add(t); else ui.hide.delete(t); applyFilters(); drawTools(); } }, GH.TYPE_PLURAL[t] + ' ' + Object.values(cs.entities).filter((e) => e.type === t).length); })),
        GH.btn('Shortest path', { onclick: pathPick, disabled: Object.keys(cs.entities).length < 2 }), ui.path ? GH.btn('Clear path', { ghost: true, onclick: () => { ui.path = null; if (graph) graph.setPath(null); drawTools(); } }) : null);
    }
    function applyFilters() { if (!graph) return; graph.setMatch(matchSet()); graph.setHiddenTypes(ui.hide); }
    async function pathPick() {
      const cs = c(), ents = Object.values(cs.entities).sort((a, b) => a.label.localeCompare(b.label));
      const opt = (sel) => ents.map((e) => h('option', { value: e.id, selected: sel === e.id }, GH.TYPE_LABEL[e.type] + ': ' + e.label.slice(0, 60)));
      const a = h('select', { id: 'sp-a' }, opt(ui.sel[0])), b = h('select', { id: 'sp-b' }, opt(ui.sel[1] || (ents[1] && ents[1].id)));
      const r = await GH.dialog({ title: 'Shortest path', sub: 'The fewest links between two entities.', body: h('div', { class: 'stack' }, GH.field('From', a), GH.field('To', b)), actions: [{ label: 'Cancel', value: false }, { label: 'Find path', primary: true, value: true }] });
      if (r !== true) return;
      const p = M.shortestPath(cs, a.value, b.value);
      if (!p) { GH.toast('These two are not connected.'); return; }
      ui.path = p; if (graph) graph.setPath({ nodes: p.nodes, edges: p.edges }); GH.toast('Path of ' + GH.plural(p.edges.length, 'link') + ' shown. Clear it from the toolbar.'); drawTools();
    }

    // ---------- graph + inspector ----------
    function drawGraph() {
      GH.clear(graphPane); GH.clear(inspector);
      const cs = c();
      if (!Object.keys(cs.entities).length) {
        graph = null;
        graphPane.append(h('div', { class: 'state' }, GH.icon('board'), h('h2', {}, 'This case is empty'), h('p', {}, 'Run a lookup in any module and add its results, or add an entity by hand. Everything you add keeps its source.'), h('div', { class: 'row-a' }, GH.btn('Add entity', { primary: true, icon: 'plus', onclick: addEntityDialog }), GH.btn('Open modules', { onclick: () => GH.go('modules') }))));
        inspector.append(inspEmpty()); return;
      }
      const host = h('div', { class: 'gcanvas' });
      const bar = h('div', { class: 'gbar', role: 'toolbar', 'aria-label': 'Graph view' }, GH.btn('', { icon: 'plus', ghost: true, title: 'Zoom in (+)', onclick: () => graph.zoomIn() }), GH.btn('', { icon: 'minus', ghost: true, title: 'Zoom out (-)', onclick: () => graph.zoomOut() }), GH.btn('', { icon: 'full', ghost: true, title: 'Fit to window (0)', onclick: () => graph.fit() }), GH.btn('', { icon: 'refresh', ghost: true, title: 'Tidy layout', onclick: tidy }));
      graphPane.append(host, bar, h('p', { class: 'sr' }, 'The graph has ' + GH.plural(Object.keys(cs.entities).length, 'entity', 'entities') + '. The Sources tab and the inspector give the same information as text.'));
      graph = GH.Graph(host, {
        getCase: c,
        onSelect: (ids) => { ui.sel = ids; drawInspector(); },
        onOpen: (id) => { ui.sel = [id]; drawInspector(true); },
        onMoveStart: () => { GH.cs.mutate('Move entities', () => {}, { group: 'move', windowMs: 1500, silent: true }); },
        onMove: () => {},
        onMoveEnd: () => { GH.cs.touched(); },
        onNudge: (id, dx, dy) => { const e = c().entities[id]; if (!e) return; const p = { x: (e.pos ? e.pos.x : .5) * graph.WORLD_W + dx, y: (e.pos ? e.pos.y : .5) * graph.WORLD_H + dy }; GH.cs.mutate('Move entity', () => {}, { group: 'nudge', windowMs: 1500, silent: true }); graph.moveNode(id, p.x, p.y); GH.cs.touched(); },
        onDelete: (ids) => removeEntities(ids),
        onPin: (id) => togglePin(id),
      });
      graph.render(); graph.fit(); applyFilters(); if (ui.path) graph.setPath({ nodes: ui.path.nodes, edges: ui.path.edges });
      ui.sel = ui.sel.filter((i) => cs.entities[i]); if (ui.sel.length) graph.select(ui.sel, { silent: true });
      drawInspector();
    }
    function tidy() { GH.cs.mutate('Tidy layout', (cs) => { for (const e of Object.values(cs.entities)) if (!e.pinned) e.pos = null; M.layout(cs); }); }
    const inspEmpty = () => h('div', { class: 'state sm' }, GH.icon('eye'), h('p', {}, 'Select an entity to see where it came from.'));

    function drawInspector(focus) {
      GH.clear(inspector); const cs = c();
      if (!ui.sel.length) { inspector.append(inspEmpty()); return; }
      if (ui.sel.length > 1) {
        inspector.append(h('h2', {}, GH.plural(ui.sel.length, 'entity', 'entities') + ' selected'), h('div', { class: 'row-a' }, GH.btn('Tag…', { icon: 'tag', onclick: () => tagDialog(ui.sel) }), GH.btn('Remove', { icon: 'trash', onclick: () => removeEntities(ui.sel) })),
          h('ul', { class: 'plain' }, ui.sel.map((i) => cs.entities[i] && h('li', {}, GH.TYPE_LABEL[cs.entities[i].type] + ': ' + cs.entities[i].label)))); return;
      }
      const e = cs.entities[ui.sel[0]]; if (!e) return;
      const un = GH.caseUnsourced(e), nb = M.neighbours(cs, e.id), coords = e.type === 'place' ? M.placeCoords(e) : null;
      const srcs = e.sources.map((s) => cs.sources[s]).filter(Boolean);
      const label = h('input', { id: 'in-label', type: 'text', value: e.label, maxlength: '400', 'aria-label': 'Label' });
      label.addEventListener('change', () => { const v = label.value.trim(); if (v && v !== e.label) GH.cs.mutate('Rename entity', (x) => { x.entities[e.id].label = v.slice(0, 400); }); });
      const hidden = (cs.settings.hideFromReport || []).includes(e.id);
      inspector.append(
        h('div', { class: 'insp-h' }, h('svg', { class: 'ico ico-l', 'aria-hidden': 'true', viewBox: '-20 -20 40 40' }, (() => { const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', GH.shapePath(e.type)); p.setAttribute('class', 'sh'); return p; })()), h('div', {}, h('p', { class: 'eyebrow mono' }, GH.TYPE_LABEL[e.type].toUpperCase()), GH.field('Label', label))),
        un ? h('p', { class: 'flow-note err', role: 'alert' }, GH.icon('alert'), h('span', {}, 'No source is recorded for this item. Do not rely on it.')) : e.manual && !srcs.length ? h('p', { class: 'flow-note' }, GH.icon('user'), h('span', {}, 'Added by hand. No connector produced it.')) : null,
        h('h3', {}, 'Where it came from'),
        srcs.length ? h('ul', { class: 'prov' }, srcs.map((s) => h('li', {}, h('b', { class: 'mono' }, s.connector + (s.connectorVersion ? ' v' + s.connectorVersion : '')), h('span', { class: 'mute sm' }, [s.query ? 'looked up "' + s.query.value + '"' : '', 'fetched ' + GH.fmtTime(s.fetchedAt), s.origin ? s.origin : '', s.licence ? 'licence ' + s.licence : '', s.rawSha256 ? 'raw output sha256 ' + s.rawSha256.slice(0, 12) + '…' : ''].filter(Boolean).join(' · '))))) : h('p', { class: 'mute sm' }, 'None.'),
        h('p', { class: 'mute sm mono' }, 'First seen ' + GH.fmtDate(e.firstSeen) + ', last seen ' + GH.fmtDate(e.lastSeen)),
        Object.keys(e.attrs || {}).length ? [h('h3', {}, 'Details'), h('dl', { class: 'kv' }, Object.entries(e.attrs).slice(0, 40).map(([k, v]) => [h('dt', {}, k), h('dd', { class: 'mono' }, typeof v === 'object' ? JSON.stringify(v) : String(v))]))] : null,
        coords ? h('p', { class: 'mono sm' }, GH.icon('pin'), ' ' + coords.lat.toFixed(5) + ', ' + coords.lon.toFixed(5)) : null,
        h('h3', {}, 'Tags'), h('div', { class: 'chips' }, e.tags.map((t) => h('button', { class: 'chip', type: 'button', title: 'Remove tag ' + t, 'aria-label': 'Remove tag ' + t, onclick: () => GH.cs.mutate('Remove tag', (x) => M.removeTag(x, e.id, t)) }, t + ' ×')), GH.btn('Add tag', { icon: 'tag', onclick: () => tagDialog([e.id]) })),
        h('h3', {}, 'Connections ' + nb.length),
        nb.length ? h('ul', { class: 'plain conn' }, nb.slice(0, 80).map((n) => { const o = cs.entities[n.other]; return o && h('li', {}, h('button', { class: 'linkish', type: 'button', onclick: () => select(o.id) }, GH.TYPE_LABEL[o.type] + ' ' + o.label), h('span', { class: 'mute mono sm' }, ' ' + (n.dir === 'out' ? '→ ' : '← ') + n.edge.rel), h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Remove this link', 'aria-label': 'Remove link to ' + o.label, onclick: () => GH.cs.mutate('Remove link', (x) => M.removeEdge(x, n.edge.id)) }, GH.icon('x'))); })) : h('p', { class: 'mute sm' }, 'No links yet.'),
        h('div', { class: 'row-a wrap' }, GH.btn('Link to…', { icon: 'link', onclick: () => linkDialog(e.id) }), GH.btn(e.pinned ? 'Unpin position' : 'Pin position', { icon: 'pinned', onclick: () => togglePin(e.id) }),
          GH.btn(hidden ? 'Include in report' : 'Hide from report', { icon: 'eye-off', onclick: () => GH.cs.mutate(hidden ? 'Include in report' : 'Hide from report', (x) => { const l = x.settings.hideFromReport; x.settings.hideFromReport = hidden ? l.filter((i) => i !== e.id) : [...l, e.id]; }) }),
          lookable(e) ? GH.btn('Look up', { icon: 'search', onclick: () => GH.go('m', lookable(e), e.label) }) : null, GH.btn('Remove', { icon: 'trash', onclick: () => removeEntities([e.id]) })));
      if (focus) { const l = inspector.querySelector('#in-label'); if (l) l.focus(); }
    }
    function lookable(e) { return { domain: 'domains', ip: 'domains', asn: 'domains', url: 'archive', org: 'companies', place: 'places' }[e.type] || null; }
    function select(id) { ui.sel = [id]; if (graph) { graph.select([id]); graph.focusNode(id); } else drawInspector(); }
    function togglePin(id) { const e = c().entities[id]; if (!e) return; GH.cs.mutate(e.pinned ? 'Unpin position' : 'Pin position', (x) => { x.entities[id].pinned = !x.entities[id].pinned; }); }
    async function removeEntities(ids) {
      const cs = c(); ids = ids.filter((i) => cs.entities[i]); if (!ids.length) return;
      const ok = await GH.confirm('Remove ' + (ids.length === 1 ? cs.entities[ids[0]].label : GH.plural(ids.length, 'entity', 'entities')) + '?', 'Its links go too. You can undo this with Undo.', 'Remove', true);
      if (!ok) return; ui.sel = [];
      GH.cs.mutate('Remove ' + GH.plural(ids.length, 'entity', 'entities'), (x) => { for (const i of ids) M.removeEntity(x, i); }); GH.say(GH.plural(ids.length, 'entity', 'entities') + ' removed. Undo is available.');
    }
    async function tagDialog(ids) {
      const t = h('input', { id: 'tg', type: 'text', maxlength: '40', placeholder: 'for example: needs-review', 'data-autofocus': '', list: 'tg-list' }), dl = h('datalist', { id: 'tg-list' }, M.allTags(c()).map(([x]) => h('option', { value: x })));
      const r = await GH.dialog({ title: 'Add a tag', body: h('div', {}, GH.field('Tag', t), dl), actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }] });
      if (r === true && t.value.trim()) GH.cs.mutate('Add tag', (x) => { for (const i of ids) M.addTag(x, i, t.value); });
    }
    async function linkDialog(from) {
      const cs = c(), ents = Object.values(cs.entities).filter((e) => e.id !== from).sort((a, b) => a.label.localeCompare(b.label)); if (!ents.length) { GH.toast('There is nothing else to link to.'); return; }
      const to = h('select', { id: 'lk-to' }, ents.map((e) => h('option', { value: e.id }, GH.TYPE_LABEL[e.type] + ': ' + e.label.slice(0, 60)))), rel = h('select', { id: 'lk-rel' }, M.REL.map((x) => h('option', { value: x, selected: x === 'linked-to' }, x)));
      const r = await GH.dialog({ title: 'Link entities', sub: 'A link you make yourself is marked as added by hand.', body: h('div', { class: 'stack' }, GH.field('To', to), GH.field('Relation', rel)), actions: [{ label: 'Cancel', value: false }, { label: 'Add link', primary: true, value: true }] });
      if (r === true) GH.cs.mutate('Add link', (x) => M.addEdge(x, { from, to: to.value, rel: rel.value, manual: true }));
    }
    async function addEntityDialog() {
      const type = h('select', { id: 'ae-type' }, M.ENTITY_TYPES.filter((t) => t !== 'email').map((t) => h('option', { value: t, selected: t === 'domain' }, GH.TYPE_LABEL[t]))), val = h('input', { id: 'ae-val', type: 'text', maxlength: '500', 'data-autofocus': '', spellcheck: 'false' }), note = h('input', { id: 'ae-note', type: 'text', maxlength: '300' });
      const r = await GH.dialog({ title: 'Add an entity', sub: 'Added by hand and marked that way. For anything a connector can find, use a module so the source is kept.', body: h('div', { class: 'stack' }, GH.field('Type', type), GH.field('Value', val), GH.field('Note (optional)', note)), actions: [{ label: 'Cancel', value: false }, { label: 'Add', primary: true, value: true }] });
      if (r !== true || !val.value.trim()) return;
      const pr = window.GhostScope.refusePersonQuery(val.value); if (pr.refused) { GH.toast(pr.reason); return; }
      let res; GH.cs.mutate('Add entity', (x) => { res = M.addEntity(x, { type: type.value, value: val.value.trim(), manual: true, attrs: note.value.trim() ? { note: note.value.trim() } : {} }); M.layout(x); });
      if (res && res.error) GH.toast(res.error); else if (res && res.id) { ui.sel = [res.id]; GH.say('Entity added.'); }
    }

    // ---------- timeline ----------
    function drawTimeline() {
      const cs = c(), ev = M.buildTimeline(cs); GH.clear(other);
      const when = h('input', { id: 'tl-t', type: 'date' }), title = h('input', { id: 'tl-title', type: 'text', maxlength: '300' }), who = h('select', { id: 'tl-e' }, h('option', { value: '' }, 'Not tied to an entity'), Object.values(cs.entities).slice(0, 400).map((e) => h('option', { value: e.id }, e.label.slice(0, 50)))), msg = h('p', { class: 'hint', role: 'status' });
      other.append(h('form', { class: 'add-row', onsubmit: (e) => { e.preventDefault(); if (!when.value || !title.value.trim()) { msg.textContent = 'Give the event a date and a title.'; return; } GH.cs.mutate('Add event', (x) => M.addEvent(x, { t: when.value, title: title.value, entity: who.value || null, precision: 'day' })); }, 'aria-label': 'Add an event' }, GH.field('Date', when), GH.field('What happened', title), GH.field('About', who), GH.btn('Add event', { primary: true, type: 'submit', icon: 'plus' })), msg);
      if (!ev.length) { other.append(h('div', { class: 'state sm' }, GH.icon('event'), h('p', {}, 'No dates yet. Registration and certificate dates appear here when a lookup returns them. You can add events by hand.'))); return; }
      other.append(h('ol', { class: 'tl' }, ev.map((x) => h('li', { class: 'tl-i' }, h('time', { class: 'mono', datetime: x.t }, GH.fmtDate(x.t)), h('div', {}, h('b', {}, x.title), h('span', { class: 'mute sm mono' }, ' ' + (x.manual ? 'added by hand' : x.kind) + (x.entity && cs.entities[x.entity] ? ' · ' + cs.entities[x.entity].label : ''))), x.manual && x.id.indexOf('g-') !== 0 ? h('button', { class: 'btn ghost icon sm', type: 'button', title: 'Delete event', 'aria-label': 'Delete event ' + x.title, onclick: () => GH.cs.mutate('Delete event', (y) => M.deleteEvent(y, x.id)) }, GH.icon('trash')) : null))));
    }
    // ---------- notes ----------
    function drawNotes() {
      const cs = c(); GH.clear(other);
      const ta = h('textarea', { id: 'nt-new', rows: '3', maxlength: '8000', placeholder: 'A note about this case. Say what you saw and how sure you are.' });
      other.append(h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); if (!ta.value.trim()) return; GH.cs.mutate('Add note', (x) => M.addNote(x, ta.value, ui.sel.slice())); }, 'aria-label': 'Add a note' }, GH.field('New note' + (ui.sel.length ? ' (linked to the selected entities)' : ''), ta), h('div', { class: 'row-a' }, GH.btn('Add note', { primary: true, type: 'submit', icon: 'plus' }))));
      if (!cs.notes.length) { other.append(h('div', { class: 'state sm' }, GH.icon('note'), h('p', {}, 'No notes yet.'))); return; }
      other.append(h('ul', { class: 'notes' }, cs.notes.slice().reverse().map((n) => {
        const t = h('textarea', { rows: '3', maxlength: '8000', 'aria-label': 'Note from ' + GH.fmtTime(n.t || n.created) }, n.text); t.value = n.text;
        t.addEventListener('change', () => GH.cs.mutate('Edit note', (x) => M.editNote(x, n.id, t.value), { group: 'note-' + n.id, windowMs: 3000 }));
        return h('li', { class: 'note' }, h('div', { class: 'mute sm mono' }, GH.fmtTime(n.t || n.created) + ((n.refs || []).length ? ' · about ' + n.refs.map((r) => cs.entities[r] && cs.entities[r].label).filter(Boolean).slice(0, 4).join(', ') : '')), t, GH.btn('Delete', { ghost: true, icon: 'trash', onclick: () => GH.cs.mutate('Delete note', (x) => M.deleteNote(x, n.id)) }));
      })));
    }
    // ---------- sources ----------
    function drawSources() {
      const cs = c(), srcs = Object.values(cs.sources).sort((a, b) => (a.fetchedAt < b.fetchedAt ? 1 : -1)); GH.clear(other);
      if (!srcs.length) { other.append(h('div', { class: 'state sm' }, GH.icon('doc'), h('p', {}, 'No sources yet. Each lookup you add is recorded here with its tool, version, time and licence.'))); return; }
      const used = {}; for (const e of Object.values(cs.entities)) for (const s of e.sources) used[s] = (used[s] || 0) + 1;
      other.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('caption', { class: 'sr' }, 'Sources for this case'), h('thead', {}, h('tr', {}, ['Tool', 'Looked up', 'Fetched', 'Origin', 'Licence', 'Entities', 'Raw output hash'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, srcs.map((s) => h('tr', {}, h('td', { class: 'mono' }, s.connector + (s.connectorVersion ? ' v' + s.connectorVersion : '')), h('td', { class: 'mono' }, s.query ? s.query.value : ''), h('td', { class: 'mono' }, GH.fmtTime(s.fetchedAt)), h('td', { class: 'mono wrapany' }, s.origin || ''), h('td', {}, s.licence || ''), h('td', { class: 'mono' }, String(used[s.id] || 0)), h('td', { class: 'mono' }, s.rawSha256 ? s.rawSha256.slice(0, 16) + '…' : '')))))));
    }

    // ---------- report ----------
    async function reportDialog() {
      const cs = c(); await GH.cs.flush();
      const author = h('input', { id: 'rp-author', type: 'text', maxlength: '120', value: cs.settings.reportAuthor || '' }), fmt = h('select', { id: 'rp-fmt' }, [['html', 'Web page (HTML)'], ['pdf', 'PDF'], ['json', 'JSON with a hash']].map(([v, l]) => h('option', { value: v }, l)));
      const hidden = cs.settings.hideFromReport || [];
      const r = await GH.dialog({ title: 'Export report', sub: 'Every item lists its sources. The footer credits Mayfair Ghost.', icon: 'report', body: h('div', { class: 'stack' }, GH.field('Format', fmt), GH.field('Author (optional)', author, 'Printed on the report and remembered with the case.'),
        h('p', { class: 'mute sm' }, hidden.length ? GH.plural(hidden.length, 'entity', 'entities') + ' hidden from this report. Change that in the inspector.' : 'Nothing is hidden. Use "Hide from report" in the inspector to leave an entity out.'), h('p', { class: 'mute sm' }, 'The report is a file on this computer. Nothing is uploaded.')), actions: [{ label: 'Cancel', value: false }, { label: 'Choose where to save', primary: true, value: true }] });
      if (r !== true) return;
      if (author.value.trim() !== (cs.settings.reportAuthor || '')) GH.cs.mutate('Set report author', (x) => { x.settings.reportAuthor = author.value.trim().slice(0, 120); }, { silent: true });
      try { const res = await GH.call(GH.api.report.save, { json: JSON.stringify(c()), format: fmt.value, author: author.value.trim() }); if (res && res.saved === false) GH.toast('Not saved.'); else GH.toast('Report saved.'); } catch (x) { GH.toast(GH.errText(x), 'err'); }
    }

    // ---------- assembly ----------
    function drawBody() {
      GH.clear(body); body.setAttribute('role', 'tabpanel'); body.id = 'bd-panel'; body.setAttribute('aria-labelledby', 'tab-' + ui.tab); body.dataset.tab = ui.tab;
      toolbar.hidden = ui.tab !== 'graph';
      if (ui.tab === 'graph') { body.append(graphPane, inspector); drawGraph(); } else { graph = null; body.append(other); ({ timeline: drawTimeline, notes: drawNotes, sources: drawSources })[ui.tab](); }
    }
    function drawAll() { drawHead(); drawTabs(); drawTools(); drawBody(); GH.updateBars && GH.updateBars(); }
    drawAll();

    // Redraw on change, except while the person is typing in a field that the change came from.
    const off = GH.cs.on((why) => {
      if (!root.isConnected) { off(); document.removeEventListener('keydown', keys, true); return; }
      if (why === 'save') { drawHead(); return; }
      if (why === 'change') { const f = document.activeElement; const keep = f && f.id && /^(bd-q|bd-title)$/.test(f.id) ? f.id : null; drawHead(); drawTools(); if (ui.tab === 'graph') { const v = graph; drawGraph(); void v; } else drawBody(); if (keep) { const x = document.getElementById(keep); if (x) x.focus(); } }
    });
    function keys(e) {
      if (!root.isConnected) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName || '') || (e.target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) GH.cs.redo(); else GH.cs.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); GH.cs.redo(); return; }
      if (e.key === '/' && !typing && !document.querySelector('.scrim')) { e.preventDefault(); ui.tab = 'graph'; if (document.getElementById('bd-q') === null) drawAll(); const q = document.getElementById('bd-q'); if (q) q.focus(); }
    }
    document.addEventListener('keydown', keys, true);
    return root;
  }
})();
