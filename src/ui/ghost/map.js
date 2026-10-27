'use strict';
// Ghost case map: the places of the open case drawn on a plain latitude and longitude plot (SVG), with lines between related places.
// No basemap, imagery or coastline ships with Ghost, so the map says so on its face. Pins come only from place entities that have coordinates.
// Entities that are linked to a place but have no coordinates (an organisation, a domain) are drawn as small dots beside that place, not by location.
(function () {
  const GH = window.GH, h = GH.h, L = window.GhostLay, sv = GH.viz.sv;
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  // o: { onSelect(id), empty: Node (what to show when there is no place), note: text for the corner }
  GH.placeMap = function placeMap(getSnap, o = {}) {
    const opt = { labels: true, sats: true, world: false };
    const stage = h('div', { class: 'pmap' }), wrap = h('div', { class: 'pmap-wrap' });
    const tog = (key, label) => { const c = GH.chk(label, { checked: opt[key], onchange: (e) => { opt[key] = e.target.checked; draw(); } }); return c.el; };
    const ctl = h('div', { class: 'pmap-ctl', role: 'group', 'aria-label': 'Map options' }, tog('labels', 'Labels'), tog('sats', 'Linked entities'), tog('world', 'Whole world'));
    wrap.append(stage, ctl);
    let ro = null, last = '';
    function draw() {
      const snap = getSnap(); if (!snap) return;
      const r = stage.getBoundingClientRect(), W = Math.max(280, Math.round(r.width)), H = Math.max(200, Math.round(r.height));
      const pins = snap.pins, sel = GH.sel.get(), view = L.fitAspect(L.viewFor(pins, { world: opt.world }), W, H);
      const P = (lat, lon) => L.project(view, W, H, lat, lon);
      const svg = sv('svg', { class: 'pmap-svg', viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'group', 'aria-label': pins.length ? 'Map of ' + GH.plural(pins.length, 'place') + ' in the open case, on a latitude and longitude grid with no basemap.' : 'Map grid. The open case has no places with coordinates.' });
      const g = L.graticule(view), grid = sv('g', { class: 'pm-grid' });
      for (const lon of g.lons) { const x = P(0, lon).x; grid.append(sv('line', { class: lon === 0 ? 'z' : '', x1: x, y1: 0, x2: x, y2: H })); grid.append(sv('text', { class: 'pm-ax', x: x + 3, y: H - 4 }, L.fmtLon(lon))); }
      for (const lat of g.lats) { const y = P(lat, 0).y; grid.append(sv('line', { class: lat === 0 ? 'z' : '', x1: 0, y1: y, x2: W, y2: y })); grid.append(sv('text', { class: 'pm-ax', x: 4, y: y - 3 }, L.fmtLat(lat))); }
      svg.append(grid);
      const at = {}; for (const p of pins) at[p.id] = P(p.lat, p.lon);
      const links = sv('g', { class: 'pm-links' });
      for (const k of snap.links) { const a = at[k.a], b = at[k.b]; if (!a || !b) continue; const via = k.via && snap.current.entities[k.via] ? snap.current.entities[k.via].label : null; links.append(sv('line', { class: 'pm-link' + (sel && (k.a === sel || k.b === sel) ? ' hi' : ''), x1: a.x, y1: a.y, x2: b.x, y2: b.y }, sv('title', {}, snap.current.entities[k.a].label + ' to ' + snap.current.entities[k.b].label + (via ? ' via ' + via : ' (' + k.rel + ')')))); }
      svg.append(links);
      if (opt.sats) {
        const gs = sv('g', { class: 'pm-sats' });
        for (const s of snap.satellites) {
          const c = at[s.place]; if (!c) continue; const a = (s.i / s.n) * 2 * Math.PI - Math.PI / 2 + 0.4, rr = 24 + (s.n > 6 ? 10 : 0) + (s.i % 2) * 8, x = c.x + Math.cos(a) * rr, y = c.y + Math.sin(a) * rr, on = sel === s.id;
          const n = sv('g', { class: 'pm-sat' + (on ? ' on' : ''), tabindex: 0, role: 'button', 'aria-pressed': String(on), 'aria-label': (GH.TYPE_LABEL[s.type] || s.type) + ' ' + s.label + ', linked to ' + snap.current.entities[s.place].label });
          n.append(sv('line', { x1: c.x, y1: c.y, x2: x, y2: y }), sv('circle', { cx: x, cy: y, r: on ? 5 : 3.5 }), sv('circle', { class: 'hit', cx: x, cy: y, r: 11 }), (opt.labels || on) ? sv('text', { x: x + 7, y: y + 3 }, clip(s.label, on ? 40 : 18)) : null);
          const pick = () => o.onSelect && o.onSelect(s.id); n.addEventListener('click', pick); n.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
          gs.append(n);
        }
        svg.append(gs);
      }
      const gp = sv('g', { class: 'pm-pins' });
      for (const p of pins) {
        const c = at[p.id], on = sel === p.id;
        const n = sv('g', { class: 'pm-pin' + (on ? ' on' : ''), transform: 'translate(' + c.x.toFixed(1) + ' ' + c.y.toFixed(1) + ')', tabindex: 0, role: 'button', 'aria-pressed': String(on), 'aria-label': 'Place ' + p.label + ', ' + p.lat.toFixed(4) + ', ' + p.lon.toFixed(4) });
        n.append(sv('circle', { class: 'ring', r: 13 }), sv('path', { d: GH.shapePath('place'), transform: 'scale(.62)' }), sv('circle', { class: 'hit', r: 16 }), (opt.labels || on) ? sv('text', { x: 14, y: 4 }, clip(p.label, 28)) : null, sv('title', {}, p.label + ' (' + p.lat.toFixed(4) + ', ' + p.lon.toFixed(4) + ')'));
        const pick = () => o.onSelect && o.onSelect(p.id); n.addEventListener('click', pick); n.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); } });
        gp.append(n);
      }
      svg.append(gp);
      svg.append(sv('text', { class: 'pm-note', x: W - 8, y: 16, 'text-anchor': 'end' }, o.note || 'Plain latitude and longitude grid. No basemap is installed.'));
      const focus = document.activeElement && stage.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
      GH.clear(stage).append(svg);
      if (!pins.length && o.empty) stage.append(h('div', { class: 'pmap-empty' }, o.empty(snap)));
      if (focus) { const f = [...stage.querySelectorAll('[tabindex]')].find((x) => x.getAttribute('aria-label') === focus); if (f) f.focus({ preventScroll: true }); }
      last = W + 'x' + H;
    }
    // draw once the element is on the page and again when its size changes
    const start = () => { if (ro || typeof ResizeObserver === 'undefined') { draw(); return; } let raf = 0; ro = new ResizeObserver(() => { const r = stage.getBoundingClientRect(); if (Math.round(r.width) + 'x' + Math.round(r.height) === last || !stage.isConnected) return; cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }); ro.observe(stage); draw(); };
    return { el: wrap, redraw: draw, start };
  };
})();
