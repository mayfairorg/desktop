'use strict';
// Places panels: map pins, globe, street-level imagery. All three draw only places that are in the open case and have coordinates.
// No basemap, globe texture or street imagery ships with Ghost, so each panel says what is missing instead of drawing something that looks real.
(function () {
  const GH = window.GH, h = GH.h, M = window.GhostCase;
  const NS = 'http://www.w3.org/2000/svg';
  const sv = (tag, a) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a || {})) if (v !== undefined && v !== null) e.setAttribute(k, v); return e; };
  const pinsOf = (c) => (c ? Object.values(c.entities).filter((e) => e.type === 'place').map((e) => ({ e, p: M.placeCoords(e) })).filter((x) => x.p) : []);
  const fmt = (p) => p.lat.toFixed(4) + ', ' + p.lon.toFixed(4);

  function flatMap(pins) {
    const W = 720, H = 360, svg = sv('svg', { class: 'plot', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Pins on a plain latitude and longitude plot. ' + GH.plural(pins.length, 'pin') + '.' });
    svg.append(sv('rect', { class: 'plot-bg', x: 0, y: 0, width: W, height: H }));
    for (let lon = -180; lon <= 180; lon += 30) { const x = (lon + 180) / 360 * W; svg.append(sv('line', { class: 'grid' + (lon === 0 ? ' z' : ''), x1: x, y1: 0, x2: x, y2: H })); }
    for (let lat = -90; lat <= 90; lat += 30) { const y = (90 - lat) / 180 * H; svg.append(sv('line', { class: 'grid' + (lat === 0 ? ' z' : ''), x1: 0, y1: y, x2: W, y2: y })); }
    for (const { e, p } of pins) { const x = (p.lon + 180) / 360 * W, y = (90 - p.lat) / 180 * H; const g = sv('g', { class: 'pin', transform: 'translate(' + x.toFixed(1) + ' ' + y.toFixed(1) + ')' }); g.append(sv('path', { d: GH.shapePath('place'), transform: 'scale(.6)' })); const t = sv('text', { x: 9, y: 4 }); t.textContent = e.label.slice(0, 28); g.append(t); const ti = sv('title'); ti.textContent = e.label + ' (' + fmt(p) + ')'; g.append(ti); svg.append(g); }
    return svg;
  }

  // Orthographic projection: rotate by (lon0, lat0), keep the points on the near side.
  function globe(pins, state, redraw) {
    const R = 150, svg = sv('svg', { class: 'plot globe', viewBox: '-170 -170 340 340', role: 'img', tabindex: '0', 'aria-label': 'Globe. Drag or use the arrow keys to turn it. ' + GH.plural(pins.length, 'pin') + '.' });
    svg.append(sv('circle', { class: 'sphere', r: R }));
    const proj = (lat, lon) => {
      const la = lat * Math.PI / 180, lo = (lon - state.lon) * Math.PI / 180, la0 = state.lat * Math.PI / 180;
      const x = Math.cos(la) * Math.sin(lo), y = Math.cos(la0) * Math.sin(la) - Math.sin(la0) * Math.cos(la) * Math.cos(lo), z = Math.sin(la0) * Math.sin(la) + Math.cos(la0) * Math.cos(la) * Math.cos(lo);
      return { x: x * R, y: -y * R, z };
    };
    const line = (pts) => { let d = '', pen = false; for (const [la, lo] of pts) { const q = proj(la, lo); if (q.z < 0) { pen = false; continue; } d += (pen ? 'L' : 'M') + q.x.toFixed(1) + ' ' + q.y.toFixed(1); pen = true; } return d; };
    for (let lon = -180; lon < 180; lon += 30) { const pts = []; for (let la = -90; la <= 90; la += 5) pts.push([la, lon]); svg.append(sv('path', { class: 'grid', d: line(pts) })); }
    for (let la = -60; la <= 60; la += 30) { const pts = []; for (let lo = -180; lo <= 180; lo += 5) pts.push([la, lo]); svg.append(sv('path', { class: 'grid', d: line(pts) })); }
    for (const { e, p } of pins) { const q = proj(p.lat, p.lon); if (q.z < 0) continue; const g = sv('g', { class: 'pin', transform: 'translate(' + q.x.toFixed(1) + ' ' + q.y.toFixed(1) + ')' }); g.append(sv('circle', { r: 4 })); const t = sv('text', { x: 7, y: 4 }); t.textContent = e.label.slice(0, 20); g.append(t); svg.append(g); }
    let drag = null;
    svg.addEventListener('pointerdown', (ev) => { drag = { x: ev.clientX, y: ev.clientY, lon: state.lon, lat: state.lat }; svg.setPointerCapture(ev.pointerId); });
    svg.addEventListener('pointermove', (ev) => { if (!drag) return; const w = svg.getBoundingClientRect().width || 340, s = 340 / w; state.lon = ((drag.lon - (ev.clientX - drag.x) * s * 0.5 + 540) % 360) - 180; state.lat = Math.max(-80, Math.min(80, drag.lat + (ev.clientY - drag.y) * s * 0.5)); redraw(); });
    const up = () => { drag = null; }; svg.addEventListener('pointerup', up); svg.addEventListener('pointercancel', up);
    svg.addEventListener('keydown', (ev) => { const d = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, 10], ArrowDown: [0, -10] }[ev.key]; if (!d) return; ev.preventDefault(); state.lon = ((state.lon + d[0] + 540) % 360) - 180; state.lat = Math.max(-80, Math.min(80, state.lat + d[1])); redraw(true); });
    return svg;
  }

  GH.placesPanels = function () {
    const host = h('div', { class: 'places' }); const gstate = { lon: 0, lat: 15 };
    const draw = (keepFocus) => {
      const c = GH.cs.current(), pins = pinsOf(c); const had = keepFocus && document.activeElement && document.activeElement.classList.contains('globe');
      GH.clear(host);
      const lat = h('input', { id: 'pl-lat', type: 'number', step: 'any', min: '-90', max: '90', inputmode: 'decimal' }), lon = h('input', { id: 'pl-lon', type: 'number', step: 'any', min: '-180', max: '180', inputmode: 'decimal' }), nm = h('input', { id: 'pl-name', type: 'text', maxlength: '200', placeholder: 'Site, landmark or organisation address' }), msg = h('p', { class: 'hint', role: 'status' });
      const add = async (ev) => {
        ev.preventDefault(); const la = Number(lat.value), lo = Number(lon.value);
        if (!nm.value.trim()) { msg.textContent = 'Give the place a name.'; return; }
        if (lat.value === '' || lon.value === '' || !(Math.abs(la) <= 90) || !(Math.abs(lo) <= 180)) { msg.textContent = 'Latitude is -90 to 90 and longitude is -180 to 180.'; return; }
        if (!c && !(await GH.cs.pickCase())) return;
        GH.cs.mutate('Add place', (cc) => { const r = M.addEntity(cc, { type: 'place', value: la.toFixed(5) + ',' + lo.toFixed(5), label: nm.value.trim(), manual: true, attrs: { lat: la, lon: lo, note: 'Coordinates entered by hand' } }); M.layout(cc); return r; });
        nm.value = ''; lat.value = ''; lon.value = ''; draw();
      };
      host.append(
        h('section', { class: 'panel', 'aria-labelledby': 'h-pins' }, h('div', { class: 'panel-h' }, h('h2', { id: 'h-pins' }, 'Map pins'), h('span', { class: 'tag' }, 'BASEMAP NOT INSTALLED')),
          pins.length ? [flatMap(pins), h('p', { class: 'mute sm' }, 'A plain latitude and longitude plot. Install a map connector (Offline map region) to show streets and borders.')] : h('div', { class: 'state sm' }, GH.icon('pin'), h('p', {}, c ? 'No place in "' + c.title + '" has coordinates yet. Look a place up, or add one below.' : 'Open a case to see its places here.'), c ? null : GH.btn('Open a case', { onclick: async () => { if (await GH.cs.pickCase()) draw(); } })),
          pins.length ? h('ul', { class: 'pinlist mono' }, pins.map(({ e, p }) => h('li', {}, h('span', {}, e.label), h('span', { class: 'mute' }, fmt(p))))) : null),
        h('section', { class: 'panel', 'aria-labelledby': 'h-globe' }, h('div', { class: 'panel-h' }, h('h2', { id: 'h-globe' }, 'Globe'), h('span', { class: 'tag' }, 'NO IMAGERY LAYER')),
          globe(pins, gstate, draw), h('p', { class: 'mute sm' }, 'Drag to turn, or use the arrow keys. It shows a grid and your pins only; satellite layers appear when a connector for them is installed.')),
        h('section', { class: 'panel', 'aria-labelledby': 'h-street' }, h('div', { class: 'panel-h' }, h('h2', { id: 'h-street' }, 'Street-level imagery'), h('span', { class: 'tag' }, 'NOT CONNECTED')),
          h('div', { class: 'state sm' }, GH.icon('street'), h('p', {}, 'No street-level imagery connector is installed, so nothing is shown here. Ghost does not draw a stand-in picture.'))),
        h('section', { class: 'panel', 'aria-labelledby': 'h-addp' }, h('div', { class: 'panel-h' }, h('h2', { id: 'h-addp' }, 'Add a place by coordinates')),
          h('form', { class: 'two-f', onsubmit: add }, GH.field('Name', nm), GH.field('Latitude', lat), GH.field('Longitude', lon), h('div', { class: 'row-a' }, GH.btn('Add place', { primary: true, type: 'submit', icon: 'plus' }))), msg));
      if (had) { const g = host.querySelector('.globe'); if (g) g.focus(); }
    };
    draw(); const off = GH.cs.on((why) => { if (!host.isConnected) { off(); return; } if (why === 'open' || why === 'close' || why === 'change') draw(); });
    return host;
  };
})();
