'use strict';
// Ghost drawing parts shared by the skin layouts: dials, bars, character grids, bar charts, tables, panels. SVG and plain elements, no libraries and no images.
// Every part takes real numbers from the layout and draws them as given: a part with nothing to show says so (an empty bar chart is a dotted baseline and a sentence).
(function () {
  const GH = window.GH, h = GH.h, L = window.GhostLay, NS = 'http://www.w3.org/2000/svg';
  const V = (GH.viz = {});
  const sv = (tag, attrs, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : String(v)); for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); return e; };
  V.sv = sv;
  const pct = (v, m) => (m > 0 ? L.clamp(v / m, 0, 1) : 0);
  const num = (n) => (n === null || n === undefined ? '--' : String(n));

  // A framed section with a header. title is the heading; meta is the small text on the right.
  V.panel = (title, body, o = {}) => {
    const id = o.id || 'pn-' + Math.random().toString(36).slice(2, 7);
    return h('section', { class: 'pn ' + (o.cls || ''), 'aria-labelledby': id + '-h', id: o.domId || null },
      h('div', { class: 'pn-h' }, h('h2', { id: id + '-h' }, title), o.meta ? h('span', { class: 'pn-m' }, o.meta) : null, o.actions || null), h('div', { class: 'pn-b' }, body));
  };
  V.empty = (text, ...more) => h('div', { class: 'pn-empty' }, h('p', {}, text), more.length ? h('div', { class: 'row-a' }, ...more) : null);

  // A ring dial: value out of max, the number in the middle.
  V.dial = ({ value, max, label, center, size = 92, tone = '' }) => {
    const R = 40, C = 2 * Math.PI * R, f = pct(value, max);
    const svg = sv('svg', { class: 'dial-svg', viewBox: '0 0 100 100', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' },
      sv('circle', { class: 'dial-track', cx: 50, cy: 50, r: R, fill: 'none', 'stroke-width': 7 }),
      sv('circle', { class: 'dial-arc', cx: 50, cy: 50, r: R, fill: 'none', 'stroke-width': 7, 'stroke-dasharray': (f * C).toFixed(2) + ' ' + C.toFixed(2), transform: 'rotate(-90 50 50)' }),
      sv('g', { class: 'dial-ticks' }, Array.from({ length: 24 }, (_, i) => { const a = (i / 24) * 2 * Math.PI; return sv('line', { x1: 50 + Math.sin(a) * 47, y1: 50 - Math.cos(a) * 47, x2: 50 + Math.sin(a) * 49.5, y2: 50 - Math.cos(a) * 49.5 }); })),
      sv('text', { class: 'dial-v', x: 50, y: 56, 'text-anchor': 'middle' }, center === undefined ? num(value) : center));
    return h('figure', { class: 'dial ' + tone, role: 'img', 'aria-label': label + ': ' + num(value) + (max !== undefined ? ' of ' + max : '') }, svg, h('figcaption', {}, label));
  };
  // A bar of equal cells, the first k lit.
  V.segbar = ({ value, max, cells = 20, label }) => {
    const k = Math.round(pct(value, max) * cells);
    return h('span', { class: 'segbar', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value }, Array.from({ length: cells }, (_, i) => h('i', { class: i < k ? 'on' : '' })));
  };
  // A smooth bar.
  V.meter = ({ value, max, label }) => { const m = h('span', { class: 'meter', role: 'meter', 'aria-label': label, 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value }, h('i', {})); m.firstChild.style.setProperty('--w', (pct(value, max) * 100).toFixed(1) + '%'); return m; };
  // Text drawn in a character grid. The words for a screen reader are `label`.
  V.chars = (text, label, cls) => {
    const kids = []; let run = '';
    for (const ch of String(text)) { if (ch === '#') { if (run) { kids.push(run); run = ''; } kids.push(h('b', {}, '#')); } else run += ch; }
    if (run) kids.push(run);
    return h('span', { class: 'chars ' + (cls || ''), role: 'img', 'aria-label': label }, kids);
  };

  // Bar chart of counts (for example events per day). Draws a dotted baseline and a sentence when every count is zero.
  V.bars = ({ counts, labels, label, w = 320, h: hh = 90 }) => {
    const n = counts.length, total = counts.reduce((a, b) => a + b, 0), max = Math.max(...counts, 1), gap = 3, bw = (w - gap * (n - 1)) / n;
    const svg = sv('svg', { class: 'bars-svg', viewBox: '0 0 ' + w + ' ' + hh, role: 'img', 'aria-label': label + (total ? '. ' + total + ' in total, most in one day ' + Math.max(...counts) + '.' : '. Nothing yet.') });
    svg.append(sv('line', { class: 'bars-base', x1: 0, y1: hh - 1, x2: w, y2: hh - 1 }));
    counts.forEach((c, i) => { const bh = c ? Math.max(3, (c / max) * (hh - 14)) : 0; if (bh) svg.append(sv('rect', { class: 'bars-bar' + (i === n - 1 ? ' last' : ''), x: (i * (bw + gap)).toFixed(2), y: (hh - 1 - bh).toFixed(2), width: bw.toFixed(2), height: bh.toFixed(2) }, sv('title', {}, (labels ? labels[i] + ': ' : '') + c))); });
    return svg;
  };

  // A dense table. cols: [{ key, label, cls, get(row) }]. onRow(row) makes the first cell a button that selects the row. selected(row) marks one.
  V.table = ({ caption, cols, rows, empty, onRow, selected, cls }) => {
    if (!rows.length) return h('p', { class: 'dt-empty' }, empty || 'Nothing yet.');
    const cell = (r, c, i) => { const v = c.get ? c.get(r) : r[c.key]; const txt = v === null || v === undefined ? '' : v; if (i === 0 && onRow) return h('td', { class: c.cls || '' }, h('button', { class: 'rowbtn', type: 'button', onclick: () => onRow(r), 'aria-pressed': selected ? String(!!selected(r)) : null }, txt)); return h('td', { class: c.cls || '' }, txt); };
    return h('div', { class: 'dt-wrap' }, h('table', { class: 'dt ' + (cls || '') }, h('caption', { class: 'sr' }, caption), h('thead', {}, h('tr', {}, cols.map((c) => h('th', { scope: 'col', class: c.cls || '' }, c.label)))),
      h('tbody', {}, rows.map((r) => h('tr', { class: selected && selected(r) ? 'sel' : '' }, cols.map((c, i) => cell(r, c, i)))))));
  };
  // The shape of an entity type, the same shapes as the case graph.
  V.glyph = (type) => sv('svg', { class: 'glyph', viewBox: '-20 -20 40 40', 'aria-hidden': 'true', focusable: 'false' }, sv('path', { d: GH.shapePath(type) }));
  V.fmtAgo = (t) => L.ago(t, Date.now());
  V.clock = (t) => { const d = new Date(t); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : ''; };
  V.when = (t) => (t ? new Date(t).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '');

  // Tables of the same real rows, shared by several layouts.
  V.lookupTable = (snap, o = {}) => V.table({ caption: 'Recent lookups', cls: o.cls, empty: o.empty || 'No lookups yet. Run one from a module and it is listed here.',
    cols: [{ key: 't', label: 'Time', cls: 'mono', get: (r) => (r.t ? V.when(r.t) : '') }, { key: 'tool', label: 'Tool', cls: 'mono' }, { key: 'query', label: 'Query', cls: 'mono wrapany' }, { key: 'state', label: 'State', get: (r) => L.JOB_STATE[r.state] || String(r.state).toUpperCase() }, { key: 'results', label: 'Results', cls: 'r mono', get: (r) => num(r.results) }].slice(0, o.cols || 5), rows: snap.lookups.slice(0, o.limit || 12) });
  V.entityTable = (snap, o = {}) => V.table({ caption: 'Entities in the open case', cls: o.cls, empty: snap.current ? 'This case has no entities yet.' : 'No case is open.', onRow: o.onRow, selected: (r) => r.id === GH.sel.get(),
    cols: [{ key: 'label', label: 'Entity', cls: 'mono wrapany' }, { key: 'type', label: 'Type', get: (r) => GH.TYPE_LABEL[r.type] || r.type }, { key: 'links', label: 'Links', cls: 'r mono' }, { key: 'sources', label: 'Sources', cls: 'r mono' }].slice(0, o.cols || 4), rows: snap.entities.slice(0, o.limit || 12) });
  V.activityList = (snap, o = {}) => (snap.activity.length ? h('ol', { class: 'actlog', 'aria-label': 'Activity, newest first' }, snap.activity.slice(0, o.limit || 14).map((a) => h('li', { class: 'tone-' + a.tone }, h('time', { class: 'mono', datetime: new Date(a.t).toISOString() }, V.clock(a.t)), h('span', {}, a.text)))) : h('p', { class: 'dt-empty' }, 'No activity yet. Lookups, self-tests, scans and case saves appear here as they happen.'));
})();
