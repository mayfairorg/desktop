'use strict';
// Ghost graph canvas: SVG, no libraries. Entity types are told apart by SHAPE (never by colour); the selection is the amber accent.
// Drag a node to move it, drag the background to pan, wheel or +/- to zoom, arrow keys to move between nodes, Enter to open, Delete to remove.
// The canvas never changes the case itself: it calls back (onMoveStart/onMove/onMoveEnd, onNudge, onDelete) and the board applies the change with undo.
(function () {
  const GH = window.GH, h = GH.h;
  const WORLD_W = 800, WORLD_H = 520, S = 16;
  const ZMIN = 0.2, ZMAX = 4;

  function shape(type) {
    const r = S, f = (n) => Math.round(n * 100) / 100;
    const poly = (pts) => 'M' + pts.map((p) => f(p[0]) + ' ' + f(p[1])).join('L') + 'Z';
    const circle = (cx, cy, rr) => 'M' + f(cx - rr) + ' ' + cy + 'a' + rr + ' ' + rr + ' 0 1 0 ' + rr * 2 + ' 0a' + rr + ' ' + rr + ' 0 1 0 -' + rr * 2 + ' 0Z';
    const rrect = (w, hh, c) => 'M' + f(-w + c) + ' ' + f(-hh) + 'H' + f(w - c) + 'a' + c + ' ' + c + ' 0 0 1 ' + c + ' ' + c + 'V' + f(hh - c) + 'a' + c + ' ' + c + ' 0 0 1 -' + c + ' ' + c + 'H' + f(-w + c) + 'a' + c + ' ' + c + ' 0 0 1 -' + c + ' -' + c + 'V' + f(-hh + c) + 'a' + c + ' ' + c + ' 0 0 1 ' + c + ' -' + c + 'Z';
    switch (type) {
      case 'domain': return circle(0, 0, r);
      case 'ip': return rrect(r * 0.9, r * 0.9, 3);
      case 'asn': return poly([[0, -r], [r * 0.95, -r * 0.5], [r * 0.95, r * 0.5], [0, r], [-r * 0.95, r * 0.5], [-r * 0.95, -r * 0.5]]);
      case 'cert': return poly([[0, -r * 1.1], [r * 1.1, 0], [0, r * 1.1], [-r * 1.1, 0]]);
      case 'org': return rrect(r * 1.55, r * 0.85, 5);
      case 'person': return circle(0, -r * 0.45, r * 0.5) + poly([[-r * 0.95, r * 0.95], [-r * 0.7, r * 0.2], [r * 0.7, r * 0.2], [r * 0.95, r * 0.95]]);
      case 'place': return poly([[0, -r * 1.05], [r * 1.05, r * 0.85], [-r * 1.05, r * 0.85]]);
      case 'email': return circle(0, 0, r) + circle(0, 0, r * 0.45);
      case 'document': return poly([[-r * 0.7, -r], [r * 0.25, -r], [r * 0.7, -r * 0.55], [r * 0.7, r], [-r * 0.7, r]]);
      case 'image': return rrect(r * 1.2, r * 0.85, 2) + 'M' + f(-r * 0.9) + ' ' + f(r * 0.45) + 'l' + f(r * 0.7) + ' ' + f(-r * 0.7) + 'l' + f(r * 0.6) + ' ' + f(r * 0.5) + 'l' + f(r * 0.45) + ' ' + f(-r * 0.35);
      case 'event': return rrect(r, r * 0.95, 3) + 'M' + f(-r) + ' ' + f(-r * 0.3) + 'H' + f(r);
      case 'url': return rrect(r * 1.55, r * 0.6, r * 0.6);
      case 'service': { const k = r * 0.42; return poly([[-k, -r], [k, -r], [r, -k], [r, k], [k, r], [-k, r], [-r, k], [-r, -k]]); }
      default: { const a = r * 0.38; return poly([[-a, -r], [a, -r], [a, -a], [r, -a], [r, a], [a, a], [a, r], [-a, r], [-a, a], [-r, a], [-r, -a], [-a, -a]]); }
    }
  }
  GH.shapePath = shape;
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) e.setAttribute(k, v); return e; };
  const clipLabel = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // opts: { getCase(), onSelect(ids), onOpen(id), onMoveStart(), onMove(id,x,y), onMoveEnd(), onNudge(id,dx,dy), onDelete(ids), onPin(id), onFocus(id) }
  GH.Graph = function Graph(container, opts) {
    const svg = sv('svg', { class: 'graph', role: 'application', 'aria-roledescription': 'graph', 'aria-label': 'Case graph. Arrow keys move between entities, Enter opens one, Delete removes it, plus and minus zoom.', tabindex: '-1' });
    const world = sv('g', { class: 'world' }), gEdges = sv('g', { class: 'edges' }), gLabels = sv('g', { class: 'elabels' }), gNodes = sv('g', { class: 'nodes' });
    world.append(gEdges, gLabels, gNodes); svg.append(world); container.append(svg);
    let tx = 0, ty = 0, k = 1, userView = false, sel = [], focusId = null, match = null, hiddenTypes = new Set(), pathSet = null, nodeEls = new Map(), edgeEls = new Map();
    const view = () => world.setAttribute('transform', 'translate(' + tx.toFixed(2) + ' ' + ty.toFixed(2) + ') scale(' + k.toFixed(4) + ')');
    const size = () => { const r = svg.getBoundingClientRect(); return { w: r.width || 800, h: r.height || 500 }; };
    const pos = (e) => ({ x: (e.pos ? e.pos.x : 0.5) * WORLD_W, y: (e.pos ? e.pos.y : 0.5) * WORLD_H });
    function fit(animate) {
      const c = opts.getCase(), ids = Object.keys(c.entities); const { w, h: hh } = size();
      if (!ids.length) { k = Math.min(w / WORLD_W, hh / WORLD_H); tx = (w - WORLD_W * k) / 2; ty = (hh - WORLD_H * k) / 2; view(); return; }
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const id of ids) { if (hiddenTypes.has(c.entities[id].type)) continue; const p = pos(c.entities[id]); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
      if (x0 > x1) { x0 = 0; y0 = 0; x1 = WORLD_W; y1 = WORLD_H; }
      const pad = 70, bw = Math.max(x1 - x0, 120) + pad * 2, bh = Math.max(y1 - y0, 120) + pad * 2;
      k = Math.min(ZMAX * 0.6, Math.max(ZMIN, Math.min(w / bw, hh / bh)));
      tx = w / 2 - ((x0 + x1) / 2) * k; ty = hh / 2 - ((y0 + y1) / 2) * k; userView = false; view();
    }
    function zoomAt(f, cx, cy) {
      const { w, h: hh } = size(); cx = cx === undefined ? w / 2 : cx; cy = cy === undefined ? hh / 2 : cy;
      const nk = Math.min(ZMAX, Math.max(ZMIN, k * f)); const wx = (cx - tx) / k, wy = (cy - ty) / k;
      k = nk; tx = cx - wx * k; ty = cy - wy * k; userView = true; view();
    }
    const toWorld = (ev) => { const r = svg.getBoundingClientRect(); return { x: (ev.clientX - r.left - tx) / k, y: (ev.clientY - r.top - ty) / k }; };

    function nodeLabel(e, c) {
      const n = Object.values(c.edges).filter((x) => x.from === e.id || x.to === e.id).length;
      return GH.TYPE_LABEL[e.type] + ' ' + e.label + ', ' + GH.plural(n, 'link') + ', ' + (GH.caseUnsourced(e) ? 'no source' : e.manual && !e.sources.length ? 'added by hand' : GH.plural(e.sources.length, 'source'));
    }
    function render() {
      const c = opts.getCase(); nodeEls.clear(); edgeEls.clear(); GH.clear(gEdges); GH.clear(gLabels); GH.clear(gNodes);
      for (const e of Object.values(c.edges)) {
        const a = c.entities[e.from], b = c.entities[e.to]; if (!a || !b) continue;
        const pa = pos(a), pb = pos(b);
        const ln = sv('line', { class: 'edge', x1: pa.x, y1: pa.y, x2: pb.x, y2: pb.y, 'data-id': e.id }); ln.append(sv('title')); ln.firstChild.textContent = e.rel;
        gEdges.append(ln); edgeEls.set(e.id, ln);
      }
      for (const e of Object.values(c.entities)) {
        const p = pos(e);
        const g = sv('g', { class: 'node', 'data-id': e.id, 'data-type': e.type, role: 'button', tabindex: '-1', transform: 'translate(' + p.x + ' ' + p.y + ')', 'aria-label': nodeLabel(e, c) });
        g.append(sv('path', { class: 'sh', d: shape(e.type), 'fill-rule': 'evenodd' }));
        const lb = sv('text', { class: 'lb', y: S + 15 }); lb.textContent = clipLabel(e.label, 24); g.append(lb);
        if (e.pinned) { const pin = sv('circle', { class: 'pinmark', cx: S, cy: -S, r: 3 }); g.append(pin); }
        if (GH.caseUnsourced(e)) { const w = sv('text', { class: 'warnmark', x: -S - 6, y: -S + 2 }); w.textContent = '!'; g.append(w); }
        gNodes.append(g); nodeEls.set(e.id, g);
      }
      if (!focusId || !c.entities[focusId]) focusId = sel[sel.length - 1] || Object.keys(c.entities)[0] || null;
      sel = sel.filter((id) => c.entities[id]);
      paint();
    }
    function paint() {
      const c = opts.getCase(); const on = new Set(sel);
      const adj = new Set(); if (sel.length === 1) for (const e of Object.values(c.edges)) { if (e.from === sel[0]) adj.add(e.id); else if (e.to === sel[0]) adj.add(e.id); }
      for (const [id, g] of nodeEls) {
        const e = c.entities[id]; const hide = hiddenTypes.has(e.type);
        g.classList.toggle('sel', on.has(id)); g.classList.toggle('dim', !!match && !match.has(id)); g.classList.toggle('off', hide); g.classList.toggle('path', !!pathSet && pathSet.nodes.includes(id));
        g.setAttribute('tabindex', id === focusId && !hide ? '0' : '-1'); g.setAttribute('aria-pressed', on.has(id) ? 'true' : 'false');
      }
      GH.clear(gLabels);
      for (const [id, ln] of edgeEls) {
        const e = c.edges[id]; const hide = hiddenTypes.has(c.entities[e.from].type) || hiddenTypes.has(c.entities[e.to].type);
        ln.classList.toggle('hi', adj.has(id)); ln.classList.toggle('off', hide); ln.classList.toggle('path', !!pathSet && pathSet.edges.includes(id));
        ln.classList.toggle('dim', !!match && !(match.has(e.from) && match.has(e.to)));
        if (adj.has(id) && !hide) { const a = pos(c.entities[e.from]), b = pos(c.entities[e.to]); const t = sv('text', { class: 'el', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4 }); t.textContent = e.rel; gLabels.append(t); }
      }
    }
    function moveNode(id, x, y) {
      const c = opts.getCase(), e = c.entities[id]; if (!e) return;
      e.pos = { x: Math.min(1, Math.max(0, x / WORLD_W)), y: Math.min(1, Math.max(0, y / WORLD_H)) };
      const p = pos(e); nodeEls.get(id).setAttribute('transform', 'translate(' + p.x + ' ' + p.y + ')');
      for (const ed of Object.values(c.edges)) if (ed.from === id || ed.to === id) { const ln = edgeEls.get(ed.id); if (!ln) continue; if (ed.from === id) { ln.setAttribute('x1', p.x); ln.setAttribute('y1', p.y); } else { ln.setAttribute('x2', p.x); ln.setAttribute('y2', p.y); } }
    }
    function select(ids, o) {
      sel = ids.filter((id) => opts.getCase().entities[id]); if (sel.length) focusId = sel[sel.length - 1];
      paint(); if (!(o && o.silent) && opts.onSelect) opts.onSelect(sel.slice());
    }
    function focusNode(id) { focusId = id; paint(); const g = nodeEls.get(id); if (g) g.focus({ preventScroll: true }); if (opts.onFocus) opts.onFocus(id); }

    // ---- pointer ----
    let drag = null;
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      const node = ev.target.closest && ev.target.closest('.node');
      svg.setPointerCapture(ev.pointerId);
      if (node) {
        const id = node.getAttribute('data-id');
        if (ev.shiftKey) { select(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]); }
        else if (!sel.includes(id)) select([id]); else { sel = [id]; focusId = id; paint(); if (opts.onSelect) opts.onSelect(sel.slice()); }
        const w = toWorld(ev), e = opts.getCase().entities[id], p = pos(e);
        drag = { kind: 'node', id, dx: w.x - p.x, dy: w.y - p.y, moved: false, sx: ev.clientX, sy: ev.clientY, pointer: ev.pointerId };
        node.focus({ preventScroll: true });
      } else drag = { kind: 'pan', sx: ev.clientX, sy: ev.clientY, tx, ty, moved: false, pointer: ev.pointerId };
    });
    svg.addEventListener('pointermove', (ev) => {
      if (!drag || ev.pointerId !== drag.pointer) return;
      const dist = Math.hypot(ev.clientX - drag.sx, ev.clientY - drag.sy);
      if (!drag.moved && dist < 4) return;
      if (drag.kind === 'pan') { drag.moved = true; tx = drag.tx + ev.clientX - drag.sx; ty = drag.ty + ev.clientY - drag.sy; userView = true; view(); return; }
      if (!drag.moved) { drag.moved = true; if (opts.onMoveStart) opts.onMoveStart(); }
      const w = toWorld(ev); moveNode(drag.id, w.x - drag.dx, w.y - drag.dy);
      if (opts.onMove) opts.onMove(drag.id);
    });
    const end = (ev) => {
      if (!drag || (ev && ev.pointerId !== drag.pointer)) return;
      const d = drag; drag = null;
      if (d.kind === 'node' && d.moved) { paint(); if (opts.onMoveEnd) opts.onMoveEnd(); }
      else if (d.kind === 'pan' && !d.moved) select([]);
    };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
    svg.addEventListener('dblclick', (ev) => { const node = ev.target.closest && ev.target.closest('.node'); if (node && opts.onOpen) opts.onOpen(node.getAttribute('data-id')); });
    svg.addEventListener('wheel', (ev) => { ev.preventDefault(); const r = svg.getBoundingClientRect(); zoomAt(ev.deltaY < 0 ? 1.12 : 1 / 1.12, ev.clientX - r.left, ev.clientY - r.top); }, { passive: false });

    // ---- keyboard ----
    function neighbourIn(dir) {
      const c = opts.getCase(); const cur = c.entities[focusId]; if (!cur) return null; const p = pos(cur); let best = null, bd = 1e12;
      for (const e of Object.values(c.entities)) {
        if (e.id === focusId || hiddenTypes.has(e.type)) continue; const q = pos(e); const dx = q.x - p.x, dy = q.y - p.y;
        const along = dir === 'ArrowRight' ? dx : dir === 'ArrowLeft' ? -dx : dir === 'ArrowDown' ? dy : -dy; const across = dir === 'ArrowRight' || dir === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
        if (along <= 1 || across > along * 1.6) continue; const d = along + across * 1.5; if (d < bd) { bd = d; best = e.id; }
      }
      return best;
    }
    svg.addEventListener('keydown', (ev) => {
      const node = ev.target.closest && ev.target.closest('.node'); const id = node ? node.getAttribute('data-id') : focusId;
      const arrow = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key);
      if (arrow && ev.shiftKey && id && opts.onNudge) { ev.preventDefault(); const step = ev.altKey ? 2 : 12; opts.onNudge(id, ev.key === 'ArrowRight' ? step : ev.key === 'ArrowLeft' ? -step : 0, ev.key === 'ArrowDown' ? step : ev.key === 'ArrowUp' ? -step : 0); return; }
      if (arrow) { ev.preventDefault(); const n = neighbourIn(ev.key); if (n) { focusNode(n); if (!ev.ctrlKey) select([n], { silent: false }); } return; }
      if ((ev.key === 'Enter' || ev.key === ' ') && id) { ev.preventDefault(); if (ev.key === 'Enter' && sel.includes(id) && opts.onOpen) opts.onOpen(id); else select(ev.ctrlKey || ev.shiftKey ? (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]) : [id]); return; }
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && sel.length && opts.onDelete) { ev.preventDefault(); opts.onDelete(sel.slice()); return; }
      if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomAt(1.2); return; }
      if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomAt(1 / 1.2); return; }
      if (ev.key === '0') { ev.preventDefault(); fit(); return; }
      if (ev.key === 'Escape') { select([]); return; }
      if ((ev.key === 'p' || ev.key === 'P') && id && opts.onPin && !ev.ctrlKey && !ev.metaKey) { ev.preventDefault(); opts.onPin(id); return; }
      if (ev.key === 'Home') { ev.preventDefault(); const f = Object.keys(opts.getCase().entities)[0]; if (f) focusNode(f); }
    });
    svg.addEventListener('focusin', (ev) => { const node = ev.target.closest && ev.target.closest('.node'); if (node) { focusId = node.getAttribute('data-id'); } });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (!userView) fit(); }).observe(container);

    return {
      svg, render, paint, fit, select, focusNode, selection: () => sel.slice(), moveNode, zoomIn: () => zoomAt(1.25), zoomOut: () => zoomAt(1 / 1.25),
      setMatch: (set) => { match = set; paint(); }, setHiddenTypes: (set) => { hiddenTypes = set; paint(); }, setPath: (p) => { pathSet = p; paint(); }, focusId: () => focusId,
      pxToWorld: (dx, dy) => ({ x: dx / k, y: dy / k }), WORLD_W, WORLD_H,
    };
  };
})();
