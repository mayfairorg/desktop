'use strict';
// Layout "Cyan HUD" (ring): a slim column of bracketed labels for navigation, and on Home a status ring in the middle (vault, connectors and case health),
// stat panels either side with small bars and gauges, an activity bar chart, a sweep drawn from the case's places and the last lookups.
// Every card has corner brackets. Every number is from this computer.
(function () {
  const GH = window.GH, h = GH.h, L = window.GhostLay, V = GH.viz, lay = GH.lay, sv = V.sv;
  const card = (title, body, o = {}) => { const id = 'hc-' + Math.random().toString(36).slice(2, 7); return h('section', { class: 'hd-card ' + (o.cls || ''), 'aria-labelledby': id }, h('i', { class: 'br tl', 'aria-hidden': 'true' }), h('i', { class: 'br tr', 'aria-hidden': 'true' }), h('i', { class: 'br bl', 'aria-hidden': 'true' }), h('i', { class: 'br brr', 'aria-hidden': 'true' }), h('div', { class: 'hd-h' }, h('h2', { id }, title), o.meta ? h('span', { class: 'hd-m mono' }, o.meta) : null), h('div', { class: 'hd-b' }, body)); };
  const row = (label, value, max) => h('li', {}, h('span', {}, label), V.meter({ value, max: Math.max(max, 1), label: label + ': ' + value + ' of ' + max }), h('b', { class: 'mono' }, String(value)));

  // The ring. Outer ticks: connectors ready out of expected. Heavy arc: entities that have a source. Inner ring: the vault. Centre: a shield.
  function ring(s) {
    const C = 220, st = s.stats, w = L.vaultWord(s.vault), hl = s.health;
    const svg = sv('svg', { class: 'hd-ring-svg', viewBox: '0 0 440 440', role: 'img', 'aria-label': 'Status ring. Connectors ready: ' + st.ready + ' of ' + st.expected + '. Case health: ' + (hl && hl.pct !== null ? hl.pct + ' percent of entities have a source' : 'no case open') + '. Vault: ' + w.word.toLowerCase() + '.' });
    const N = 120, lit = st.expected ? Math.round((st.ready / st.expected) * N) : 0, ticks = sv('g', { class: 'rg-ticks' });
    for (let i = 0; i < N; i++) { const a = (i / N) * 2 * Math.PI, r0 = i % 10 === 0 ? 180 : 187, r1 = 200; ticks.append(sv('line', { class: i < lit ? 'on' : '', x1: C + Math.sin(a) * r0, y1: C - Math.cos(a) * r0, x2: C + Math.sin(a) * r1, y2: C - Math.cos(a) * r1 })); }
    const R2 = 152, C2 = 2 * Math.PI * R2, f2 = hl && hl.pct !== null ? hl.pct / 100 : 0;
    svg.append(sv('circle', { class: 'rg-dash', cx: C, cy: C, r: 168, fill: 'none' }), ticks,
      sv('circle', { class: 'rg-track', cx: C, cy: C, r: R2, fill: 'none', 'stroke-width': 12 }), hl ? sv('circle', { class: 'rg-arc', cx: C, cy: C, r: R2, fill: 'none', 'stroke-width': 12, 'stroke-dasharray': (f2 * C2).toFixed(1) + ' ' + C2.toFixed(1), transform: 'rotate(-90 ' + C + ' ' + C + ')' }) : null,
      sv('circle', { class: 'rg-vault ' + (w.locked === false ? 'open' : w.locked === true ? 'shut' : 'unk'), cx: C, cy: C, r: 128, fill: 'none', 'stroke-width': 2 }),
      sv('path', { class: 'rg-br', d: 'M120 150v-30h30M290 120h30v30M320 290v30h-30M150 320h-30v-30', fill: 'none', 'stroke-width': 3 }),
      sv('path', { class: 'rg-shield', d: 'M220 122 156 146v58c0 40 26 70 64 84 38-14 64-44 64-84v-58z', fill: 'none', 'stroke-width': 5, 'stroke-linejoin': 'round' }),
      sv('circle', { class: 'rg-key', cx: 220, cy: 192, r: 13 }), sv('path', { class: 'rg-key', d: 'M214 202h12l5 40h-22z' }),
      sv('text', { class: 'rg-word', x: C, y: 330, 'text-anchor': 'middle' }, w.word));
    return svg;
  }
  const ringCard = (s) => {
    const st = s.stats, hl = s.health, w = L.vaultWord(s.vault), lk = lay.lookupForm({ cls: 'hd-lk', button: 'Look up', kind: false, placeholder: 'domain, IP, ASN or URL' });
    return h('section', { class: 'hd-ring', 'aria-label': 'Status' }, h('i', { class: 'br tl', 'aria-hidden': 'true' }), h('i', { class: 'br tr', 'aria-hidden': 'true' }), h('i', { class: 'br bl', 'aria-hidden': 'true' }), h('i', { class: 'br brr', 'aria-hidden': 'true' }),
      h('h1', { class: 'hd-title' }, 'Status'), ring(s),
      h('dl', { class: 'hd-read' }, h('div', {}, h('dt', {}, 'Connectors'), h('dd', { class: 'mono' }, st.ready + ' / ' + st.expected + ' ready')), h('div', {}, h('dt', {}, 'Case health'), h('dd', { class: 'mono' }, hl && hl.pct !== null ? hl.pct + '% sourced' : hl ? 'empty case' : 'no case open')), h('div', {}, h('dt', {}, 'Vault'), h('dd', { class: 'mono' }, w.word))),
      h('div', { class: 'hd-cmd' }, lk.form, lk.err, h('p', { class: 'hd-hint mono' }, 'Domains, IP addresses, ASNs and web addresses only.')));
  };
  function leftCards(s) {
    const st = s.stats, hl = s.health, issues = st.keys['test-failed'] + st.keys['program-missing'];
    const conn = card('Connectors', h('div', {}, h('div', { class: 'hd-big' }, V.dial({ value: st.ready, max: st.expected, label: 'Ready', center: String(st.ready), size: 84 }), h('p', { class: 'mono' }, 'of ' + st.expected + ' expected')),
      h('ul', { class: 'hd-rows' }, row('On this computer', st.installed, st.expected), row('Approved', st.approved, Math.max(st.installed, 1)), row('Switched on', st.enabled, Math.max(st.installed, 1)), row('Problems', issues, Math.max(st.installed, 1)))), { cls: 'hd-conn', meta: st.readable ? '' : 'list not readable' });
    const cases = card('Cases', hl ? h('div', {}, h('p', { class: 'hd-line mono' }, s.current.title), h('ul', { class: 'hd-rows' }, row('Entities', hl.entities, hl.entities), row('With a source', hl.entities - hl.unsourced - hl.handAdded, hl.entities), row('Added by hand', hl.handAdded, hl.entities), row('No source', hl.unsourced, hl.entities)), h('p', { class: 'hd-line mono mute' }, GH.plural(hl.edges, 'link') + ' · ' + GH.plural(hl.sources, 'source') + ' · ' + GH.plural(hl.places, 'place'))) : V.empty(Array.isArray(s.cases) && s.cases.length ? GH.plural(s.cases.length, 'case') + ' in the vault. None is open.' : 'No cases yet.', GH.btn('Open or start a case', { onclick: () => GH.cs.pickCase() })), { cls: 'hd-cases', meta: Array.isArray(s.cases) ? GH.plural(s.cases.length, 'case') : '' });
    const v = s.scopeVerify, ent = s.entitlement;
    const scan = card('Scans', h('ul', { class: 'hd-kv' }, [['Active scanning', ent && ent.modules && ent.modules.scanning ? 'switched on' : 'off for this account'], ['Target declared', s.scopeActive ? (s.scopeActive.length ? s.scopeActive[0].target : 'none') : '--'], ['Scan log', v ? (v.ok ? 'intact, ' + GH.plural(v.lines, 'line') : 'changed at line ' + v.line) : '--']].map(([k, x]) => h('li', {}, h('span', {}, k), h('b', { class: 'mono' }, x)))), { cls: 'hd-scan' });
    return [conn, cases, scan];
  }
  function radarSvg(s) {
    const pts = L.radarPoints(s.pins), R = 100, svg = sv('svg', { class: 'hd-radar-svg', viewBox: '-110 -110 220 220', role: 'img', 'aria-label': pts.length ? 'Sweep of ' + GH.plural(pts.length, 'place') + ' in the open case, by bearing and distance from the middle of the places.' : 'Sweep. The open case has no places with coordinates.' });
    svg.append(sv('circle', { class: 'rd-ring', r: R, fill: 'none' }), sv('circle', { class: 'rd-ring', r: R * 0.66, fill: 'none' }), sv('circle', { class: 'rd-ring', r: R * 0.33, fill: 'none' }), sv('path', { class: 'rd-axis', d: 'M-100 0H100M0 -100V100', fill: 'none' }));
    svg.append(sv('g', { class: 'rd-sweep' }, sv('circle', { class: 'rd-bb', r: R, fill: 'none' }), sv('path', { class: 'rd-wedge', d: 'M0 0 0 -100A100 100 0 0 1 70.7 -70.7Z' }), sv('path', { class: 'rd-line', d: 'M0 0V-100', fill: 'none' })));
    for (const p of pts) svg.append(sv('g', { class: 'rd-blip', transform: 'translate(' + (p.x * R).toFixed(1) + ' ' + (p.y * R).toFixed(1) + ')' }, sv('circle', { r: 4.5 }), sv('title', {}, p.label)));
    return svg;
  }
  function rightCards(s) {
    const act = card('Activity', h('div', {}, V.bars({ counts: s.days.counts, labels: s.days.labels, label: 'Events per day, last 14 days', w: 300, h: 84 }), h('p', { class: 'hd-line mono' }, s.days.total ? GH.plural(s.days.total, 'event') + ' in 14 days' : 'No activity yet.')), { cls: 'hd-act', meta: '14 days' });
    const sweep = card('Sweep', h('div', { class: 'hd-radar' }, radarSvg(s), h('p', { class: 'hd-line mono' }, s.pins.length ? GH.plural(s.pins.length, 'place') + ' in ' + s.current.title : s.current ? 'No place with coordinates in this case.' : 'No case is open.')), { cls: 'hd-sweep', meta: 'places in the open case' });
    const last = card('Last lookups', V.lookupTable(s, { cols: 4, limit: 5, cls: 'hd-tbl' }), { cls: 'hd-last', meta: s.lookups.length ? GH.plural(s.lookups.length, 'lookup') : '' });
    return [act, sweep, last];
  }

  GH.layouts.hud = {
    shell(P) {
      const items = P.navItems();
      const nav = h('nav', { class: 'hd-nav', 'aria-label': 'Ghost' }, h('a', { class: 'hd-brand', href: '#home', 'aria-label': 'Mayfair Ghost, home' }, h('b', {}, 'MAYFAIR'), h('i', {}, 'GHOST')), h('div', { class: 'hd-nav-in' }, items.map((it) => lay.navLink(it, 'hn', it.label)), lay.termButton('hn', 'Terminal')));
      const top = h('header', { class: 'hd-top' }, h('span', { class: 'crumb hd-crumb mono', id: 'crumb' }, 'Home'), P.actions());
      return { root: h('div', { class: 'app hd-app', id: 'app', dataset: { view: 'home', layout: 'ring-hud' } }, nav, h('div', { class: 'hd-col' }, top, h('main', { id: 'main', tabindex: '-1' }), P.buildStatus())), destroy() {} };
    },
    home() {
      const grid = h('div', { class: 'hd-grid' });
      const sec = h('section', { class: 'view hd-home', 'aria-label': 'Home' }, grid);
      const fill = (s) => { GH.clear(grid).append(h('div', { class: 'hd-side hd-l' }, leftCards(s)), ringCard(s), h('div', { class: 'hd-side hd-r' }, rightCards(s))); };
      const refresh = async () => { const f = document.activeElement && grid.contains(document.activeElement) && document.activeElement.id === 'cmdq' ? document.activeElement.value : null; try { fill(await GH.data.snapshot()); } catch (e) { GH.clear(grid).append(h('p', { class: 'cmd-err', role: 'alert' }, GH.errText(e))); } if (f !== null) { const i = document.getElementById('cmdq'); if (i) { i.value = f; i.focus(); } } };
      GH.clear(grid).append(h('p', { class: 'dt-empty' }, 'Reading this computer'));
      GH.data.watch(sec, refresh); refresh();
      return sec;
    },
    moduleSummary(m) {
      return card('Readiness', lay.withConnectors('hd-msum', (list) => {
        const rows = lay.moduleRows(m, list), ready = rows.filter((r) => r.key === 'passed').length, k = (key) => rows.filter((r) => r.key === key).length;
        return h('div', { class: 'hd-msum-in' }, V.dial({ value: ready, max: rows.length, label: 'Ready', center: ready + '/' + rows.length, size: 96 }),
          h('ul', { class: 'hd-rows' }, row('Test passed', ready, rows.length), row('Needs approval', k('needs-approval'), rows.length), row('Not tested', k('not-tested'), rows.length), row('Problems', k('test-failed') + k('program-missing'), rows.length), row('Not installed', k('not-installed'), rows.length)));
      }), { cls: 'hd-msum-c', meta: m.active ? 'active module' : 'passive module' });
    },
    boardStrip(c) {
      const hl = L.caseHealth(c); if (!hl) return null;
      return h('div', { class: 'hd-bstrip' }, h('div', { class: 'hd-bd' }, V.dial({ value: hl.entities - hl.unsourced, max: Math.max(hl.entities, 1), label: 'With a source', center: hl.pct === null ? '--' : hl.pct + '%', size: 72 })),
        h('dl', { class: 'hd-bst' }, [['Entities', hl.entities], ['Links', hl.edges], ['Sources', hl.sources], ['Places', hl.places]].map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { class: 'mono' }, String(v))))),
        h('ul', { class: 'hd-rows hd-bt' }, Object.entries(hl.byType).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => row(GH.TYPE_PLURAL[t] || t, n, hl.entities))));
    },
  };
})();
