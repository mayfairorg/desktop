'use strict';
// Layout "Mono minimal" (single column): almost no chrome. A thin top line with the name and the pages as plain links, then a column of large fixed-width type.
// Home: a giant headline, a big search box, the state of the last lookup, a row of stats, and beside them every connector drawn as one character
// (# test passed, : on this computer but not ready, . not installed) in a grid per module. All of it is counted from this computer.
(function () {
  const GH = window.GH, h = GH.h, L = window.GhostLay, V = GH.viz, lay = GH.lay;
  const cellsOf = (row) => row.cells.map((c) => L.cellChar(c.key)).join('');
  const WIDTH = 36;

  function gridPanel(s) {
    const st = s.stats, j = s.jobs[0];
    const mods = st.rows.map((r) => h('div', { class: 'mn-mod' }, h('p', { class: 'mn-mh' }, h('a', { href: GH.href('m', r.id) }, r.name.toUpperCase()), h('span', { class: 'mono' }, r.ready + ' / ' + r.total + ' READY')), V.chars(cellsOf(r) || '.', r.name + ': ' + r.ready + ' of ' + r.total + ' connectors ready', 'mn-ch')));
    let last;
    if (j) { const frac = j.status === 'done' ? 1 : j.status === 'running' || j.status === 'queued' ? j.progress || 0 : 0; last = h('div', { class: 'mn-last' }, h('p', { class: 'mn-mh' }, h('span', {}, 'LAST LOOKUP'), h('span', { class: 'mono' }, L.JOB_STATE[j.status] || j.status)), h('p', { class: 'mn-lq mono' }, j.connector + (j.query ? '  ' + j.query : '')), V.chars(L.charBar(frac, 1, WIDTH), 'Progress of the last lookup: ' + Math.round(frac * 100) + ' percent', 'mn-ch')); }
    else last = h('div', { class: 'mn-last' }, h('p', { class: 'mn-mh' }, h('span', {}, 'LAST LOOKUP'), h('span', { class: 'mono' }, 'NONE')), h('p', { class: 'mn-lq mono mute' }, 'No lookups have run in this window.'));
    return h('section', { class: 'mn-grid', 'aria-labelledby': 'h-mngrid' }, h('div', { class: 'mn-gh' }, h('h2', { id: 'h-mngrid' }, st.ready + ' / ' + st.expected), h('span', { class: 'mono' }, 'CONNECTORS READY'), h('span', { class: 'mono mn-gi' }, st.installed + ' ON THIS COMPUTER')), h('div', { class: 'mn-mods' }, mods), last,
      h('p', { class: 'mn-key mono', 'aria-label': 'Key' }, h('span', {}, '# TEST PASSED'), h('span', {}, ': NOT READY'), h('span', {}, '. NOT INSTALLED')));
  }

  GH.layouts.mono = {
    shell(P) {
      const items = P.navItems();
      const top = h('header', { class: 'mn-top' }, h('div', { class: 'mn-bar' }, h('a', { class: 'mn-brand', href: '#home', 'aria-label': 'Mayfair Ghost, home' }, 'mayfair ghost'), h('span', { class: 'crumb mn-crumb', id: 'crumb' }, 'Home'), P.actions()),
        h('nav', { class: 'mn-nav', 'aria-label': 'Ghost' }, h('div', { class: 'mn-nav-in' }, items.map((it) => lay.navLink(it, 'mnl', it.label)), lay.termButton('mnl', 'Terminal'))));
      return { root: h('div', { class: 'app mn-app', id: 'app', dataset: { view: 'home', layout: 'single-column' } }, top, h('main', { id: 'main', tabindex: '-1' }), P.buildStatus()), destroy() {} };
    },
    home() {
      const lk = lay.lookupForm({ cls: 'mn-search', button: 'Look up →', kind: false, placeholder: 'domain, IP, ASN, URL, company or place', label: 'What to look up: domain, IP, ASN, URL, company or place', autofocus: true });
      const status = h('p', { class: 'mn-status mono', role: 'status' }, 'Reading this computer'), tryRow = h('p', { class: 'mn-try mono', hidden: true }), stats = h('dl', { class: 'mn-stats' }), right = h('div', { class: 'mn-right' });
      const sec = h('section', { class: 'view mn-home', 'aria-label': 'Home' }, h('div', { class: 'mn-cols' },
        h('div', { class: 'mn-left' }, h('h1', { class: 'mn-h' }, 'See what is already public.', h('span', { class: 'mn-cur', 'aria-hidden': 'true' })), h('p', { class: 'mn-lead' }, 'Domains, companies, files, places and news in one case file. Free, no limits, and everything stays on this computer.'),
          lk.form, lk.err, status, tryRow, h('p', { class: 'mn-note mono' }, 'Names of people, usernames, emails and phone numbers are not looked up.'), stats), right));
      const fill = (s) => {
        const j = s.jobs[0], run = GH.jobs.running()[0];
        status.textContent = run ? 'Looking up · ' + run.connector + (run.query ? ' ' + run.query : '') : j ? 'Last lookup ' + (L.JOB_STATE[j.status] || j.status).toLowerCase() + ' · ' + (j.results === undefined || j.results === null ? 'no results counted' : GH.plural(j.results, 'result')) : 'Ready · nothing looked up in this window yet';
        const recent = [...new Set(s.lookups.map((r) => r.query).filter(Boolean))].slice(0, 5);
        GH.clear(tryRow); tryRow.hidden = !recent.length; if (recent.length) { tryRow.append('RECENT '); recent.forEach((q) => tryRow.append(h('button', { class: 'mn-tryb', type: 'button', onclick: () => { lk.input.value = q; lk.input.dispatchEvent(new Event('input')); lk.input.focus(); } }, q), ' ')); }
        GH.clear(stats).append(...[[s.stats.ready + '/' + s.stats.expected, 'connectors ready'], [Array.isArray(s.cases) ? String(s.cases.length) : '--', 'cases in the vault'], [s.health ? String(s.health.entities) : '--', s.current ? 'entities in ' + s.current.title : 'entities (no case open)']].map(([v, k]) => h('div', {}, h('dt', { class: 'mono' }, v), h('dd', {}, k))));
        GH.clear(right).append(gridPanel(s));
      };
      const refresh = async () => { try { fill(await GH.data.snapshot()); } catch (e) { status.textContent = GH.errText(e); } };
      GH.data.watch(sec, refresh); refresh();
      return sec;
    },
    moduleSummary(m) {
      return lay.withConnectors('mn-msum', (list) => {
        const rows = lay.moduleRows(m, list), ready = rows.filter((r) => r.key === 'passed').length;
        return h('div', {}, h('p', { class: 'mn-mh' }, h('span', {}, 'CONNECTORS'), h('span', { class: 'mono' }, ready + ' / ' + rows.length + ' READY')), V.chars(rows.map((r) => L.cellChar(r.key)).join('') || '.', ready + ' of ' + rows.length + ' connectors ready', 'mn-ch'),
          h('ul', { class: 'mn-rows mono' }, rows.map((r) => h('li', {}, h('span', { 'aria-hidden': 'true' }, L.cellChar(r.key)), h('span', {}, r.id), h('span', { class: 'st-' + r.key }, r.state)))));
      });
    },
    boardStrip(c) {
      const hl = L.caseHealth(c); if (!hl) return null;
      return h('dl', { class: 'mn-stats mn-bstats' }, [[hl.entities, 'entities'], [hl.edges, 'links'], [hl.sources, 'sources'], [hl.places, 'places'], [hl.pct === null ? '--' : hl.pct + '%', 'have a source']].map(([v, k]) => h('div', {}, h('dt', { class: 'mono' }, String(v)), h('dd', {}, k))));
    },
  };
})();
