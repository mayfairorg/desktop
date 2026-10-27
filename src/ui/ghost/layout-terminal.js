'use strict';
// Layout "Terminal green" (panel grid): a title strip, a function-key bar along the bottom for navigation, and on Home a grid of framed panels:
// the jobs table, connector health gauges, case files, the open case, an activity log and a large vault status with a padlock.
(function () {
  const GH = window.GH, h = GH.h, L = window.GhostLay, V = GH.viz, lay = GH.lay, sv = V.sv;

  // A big padlock drawn in strokes: closed when the vault is locked, open when it is unlocked, a dashed outline when the state is not known.
  function padlock(locked) {
    const shackle = locked === false ? 'M38 64V44a22 22 0 0 1 44 0v6' : 'M38 64V44a22 22 0 0 1 44 0v20';
    return sv('svg', { class: 'padlock ' + (locked === true ? 'is-locked' : locked === false ? 'is-open' : 'is-unknown'), viewBox: '0 0 120 140', 'aria-hidden': 'true', focusable: 'false' },
      sv('path', { class: 'pl-shackle', d: shackle, fill: 'none', 'stroke-width': 9, 'stroke-linecap': 'square' }),
      sv('rect', { class: 'pl-body', x: 18, y: 64, width: 84, height: 66, 'stroke-width': 6 }),
      sv('circle', { class: 'pl-key', cx: 60, cy: 92, r: 8 }), sv('path', { class: 'pl-key', d: 'M56 98h8l3 18H53z' }));
  }
  const folder = () => sv('svg', { class: 'folder', viewBox: '0 0 44 34', 'aria-hidden': 'true', focusable: 'false' }, sv('path', { d: 'M3 6h13l4 4h21v21H3z', fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round' }), sv('path', { d: 'M3 14h38', 'stroke-width': 1.4 }));

  function jobsPanel(s) {
    const run = GH.jobs.running().length, rows = s.jobs.map((j, i) => ({ pid: String(s.jobs.length - i).padStart(3, '0'), tool: j.connector, query: j.query, state: j.status === 'running' && j.progress ? 'RUNNING ' + Math.round(j.progress * 100) + '%' : L.JOB_STATE[j.status] || j.status, age: L.ago(j.startedAt, s.now), results: j.results === undefined ? '--' : String(j.results), st: j.status }));
    return V.panel('Jobs', V.table({ caption: 'Lookups run in this window', cls: 'tm-tbl', empty: 'No jobs have run in this window yet. Run a lookup from a module and it is listed here with its state.', rows: rows.slice(0, 12),
      cols: [{ key: 'pid', label: 'PID', cls: 'mono' }, { key: 'tool', label: 'Command', cls: 'mono' }, { key: 'query', label: 'Target', cls: 'mono wrapany' }, { key: 'state', label: 'State', get: (r) => h('span', { class: 'js-' + r.st }, r.state) }, { key: 'age', label: 'Age', cls: 'r mono' }, { key: 'results', label: 'Results', cls: 'r mono' }] }),
    { cls: 'tm-jobs', meta: run ? run + ' running' : GH.plural(s.jobs.length, 'job') + ' this window' });
  }
  function healthPanel(s) {
    const st = s.stats, issues = st.keys['test-failed'] + st.keys['program-missing'];
    const dials = h('div', { class: 'tm-dials' }, V.dial({ value: st.ready, max: st.expected, label: 'Ready', center: st.ready + '/' + st.expected }), V.dial({ value: st.enabled, max: st.installed, label: 'Switched on', center: st.enabled + '/' + st.installed }), V.dial({ value: issues, max: Math.max(st.installed, 1), label: 'Problems', center: String(issues), tone: issues ? 'bad' : '' }));
    const mods = h('ul', { class: 'tm-mods', 'aria-label': 'Readiness by module' }, st.rows.map((r) => h('li', {}, h('a', { class: 'mono', href: GH.href('m', r.id) }, r.name), V.segbar({ value: r.ready, max: r.total, cells: Math.max(r.total, 1), label: r.name + ': ' + r.ready + ' of ' + r.total + ' ready' }), h('b', { class: 'mono' }, r.ready + '/' + r.total))));
    return V.panel('Connector health', [st.readable ? null : h('p', { class: 'cmd-err', role: 'alert' }, 'The connector list could not be read.'), dials, mods], { cls: 'tm-health', meta: GH.plural(st.installed, 'connector') + ' on this computer' });
  }
  function filesPanel(s) {
    const list = Array.isArray(s.cases) ? s.cases.slice().sort((a, b) => String(b.updated).localeCompare(String(a.updated))) : [];
    const grid = list.length ? h('ul', { class: 'tm-fgrid' }, list.slice(0, 12).map((c) => h('li', {}, h('a', { class: 'tm-file' + (s.current && s.current.id === c.id ? ' cur' : ''), href: GH.href('case', c.id) }, folder(), h('b', { class: 'mono' }, c.title), h('span', { class: 'mono' }, GH.plural(c.entities, 'entity', 'entities') + ', ' + GH.plural(c.sources, 'source')), h('span', { class: 'mono' }, GH.fmtDate(c.updated)))))) : V.empty(s.cases ? 'No cases yet. A case holds what you find, with the source of every item.' : 'Cases could not be read.', GH.btn('New case', { primary: true, onclick: () => GH.cs.pickCase() }));
    return V.panel('Case files', grid, { cls: 'tm-files', meta: GH.plural(list.length, 'case') + ', sealed in the vault' });
  }
  function casePanel(s) {
    const hl = s.health;
    const body = hl ? h('div', {}, h('p', { class: 'tm-case-t mono' }, s.current.title),
      h('ul', { class: 'tm-bars' }, [['Entities', hl.entities, hl.entities], ['With a source', hl.entities - hl.unsourced - hl.handAdded, hl.entities], ['Added by hand', hl.handAdded, hl.entities], ['No source', hl.unsourced, hl.entities], ['Links', hl.edges, Math.max(hl.edges, hl.entities)], ['Places', hl.places, Math.max(hl.entities, 1)]].map(([k, v, m]) => h('li', {}, h('span', {}, k), V.segbar({ value: v, max: m, cells: 24, label: k + ': ' + v }), h('b', { class: 'mono' }, String(v))))),
      h('div', { class: 'row-a' }, GH.btn('Open the board', { primary: true, onclick: () => GH.go('case', s.current.id) }))) : V.empty('No case is open. Open a case file to see its numbers here.', GH.btn('Open or start a case', { onclick: () => GH.cs.pickCase() }));
    return V.panel('Open case', body, { cls: 'tm-case', meta: hl && hl.pct !== null ? hl.pct + '% have a source' : '' });
  }
  function logPanel(s) {
    const lines = s.activity.slice(0, 16);
    const body = lines.length ? h('ol', { class: 'tm-log-l', 'aria-label': 'Activity, newest first' }, lines.map((a) => h('li', { class: 'tone-' + a.tone }, h('time', { class: 'mono', datetime: new Date(a.t).toISOString() }, '[' + V.clock(a.t) + ']'), h('span', { class: 'tm-sig', 'aria-hidden': 'true' }, a.tone === 'ok' ? '+' : a.tone === 'bad' ? '!' : '>'), h('span', {}, a.text)))) : h('p', { class: 'dt-empty tm-cursor' }, 'No activity yet. Lookups, self-tests, scans and case saves are written here as they happen.');
    return V.panel('Activity log', body, { cls: 'tm-log', meta: GH.plural(s.activity.length, 'entry', 'entries') });
  }
  function vaultPanel(s) {
    const w = L.vaultWord(s.vault), ver = s.scopeVerify;
    const rows = [['Protection', s.vault && s.vault.protection ? String(s.vault.protection) : '--'], ['Cases sealed', Array.isArray(s.cases) ? String(s.cases.length) : '--'], ['Scan log', ver ? (ver.ok ? 'intact, ' + GH.plural(ver.lines, 'line') : 'changed at line ' + ver.line) : '--'], ['Access', s.entitlement ? (s.entitlement.operator ? 'operator' : s.entitlement.approved ? 'approved' : 'not approved') : '--']];
    return V.panel('Vault', h('div', { class: 'tm-vault-b' }, padlock(w.locked), h('p', { class: 'tm-vword', role: 'status' }, w.word), h('p', { class: 'tm-vd' }, w.detail), h('dl', { class: 'tm-vkv' }, rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', { class: 'mono' }, v))))), { cls: 'tm-vault ' + (w.locked === true ? 'locked' : w.locked === false ? 'open' : 'unknown'), meta: 'on this computer' });
  }

  GH.layouts.terminal = {
    shell(P) {
      const items = P.navItems();
      const top = h('header', { class: 'tm-top' }, h('a', { class: 'tm-brand', href: '#home', 'aria-label': 'Mayfair Ghost, home' }, h('b', {}, 'MAYFAIR'), h('i', {}, 'GHOST')), h('span', { class: 'tm-host mono' }, 'ghost@local:'), h('span', { class: 'crumb tm-crumb mono', id: 'crumb' }, 'Home'), P.actions());
      const keys = h('nav', { class: 'tm-keys', 'aria-label': 'Ghost' }, h('div', { class: 'tm-keys-in' }, items.map((it, i) => lay.navLink(it, 'tk', it.label)).map((a, i) => { a.prepend(h('i', { class: 'tk-n mono', 'aria-hidden': 'true' }, String(i + 1).padStart(2, '0'))); return a; }), lay.termButton('tk', 'Terminal')));
      return { root: h('div', { class: 'app tm-app', id: 'app', dataset: { view: 'home', layout: 'panel-grid' } }, top, h('main', { id: 'main', tabindex: '-1' }), keys, P.buildStatus()), destroy() {} };
    },
    home() {
      const lk = lay.lookupForm({ cls: 'tm-lk', prompt: 'ghost@local:~$', button: 'Run', placeholder: 'lookup domain, IP, ASN or URL', kind: false, label: 'What to look up: domain, IP, ASN or URL' });
      const grid = h('div', { class: 'tm-grid' });
      const sec = h('section', { class: 'view tm-home', 'aria-label': 'Home' }, h('h1', { class: 'sr' }, 'Home'), V.panel('Prompt', [lk.form, lk.err, h('p', { class: 'tm-hint mono' }, 'Domains, IP addresses, ASNs and web addresses only. Names of people, usernames, emails and phone numbers are not looked up.')], { cls: 'tm-prompt' }), grid);
      const fill = (s) => { GH.clear(grid).append(jobsPanel(s), healthPanel(s), filesPanel(s), casePanel(s), logPanel(s), vaultPanel(s)); };
      const refresh = async () => { try { fill(await GH.data.snapshot()); } catch (e) { GH.clear(grid).append(h('p', { class: 'cmd-err', role: 'alert' }, GH.errText(e))); } };
      GH.clear(grid).append(h('p', { class: 'dt-empty tm-cursor' }, 'Reading this computer'));
      GH.data.watch(sec, refresh); refresh();
      return sec;
    },
    moduleSummary(m) {
      return V.panel('Readiness', lay.withConnectors('tm-msum', (list) => {
        const rows = lay.moduleRows(m, list), ready = rows.filter((r) => r.key === 'passed').length;
        return h('div', {}, h('p', { class: 'tm-msum-t mono' }, 'READY ', V.segbar({ value: ready, max: rows.length, cells: Math.max(rows.length, 1), label: ready + ' of ' + rows.length + ' ready' }), ' ' + ready + '/' + rows.length),
          V.table({ caption: 'Connectors for ' + m.name, cls: 'tm-tbl', cols: [{ key: 'id', label: 'Connector', cls: 'mono' }, { key: 'scope', label: 'Scope', cls: 'mono' }, { key: 'state', label: 'State', get: (r) => h('span', { class: 'st-' + r.key }, r.state.toUpperCase()) }, { key: 'tested', label: 'Tested', cls: 'mono' }], rows }));
      }), { cls: 'tm-msum-p', meta: m.active ? 'ACTIVE' : 'PASSIVE' });
    },
    boardStrip(c) {
      const hl = L.caseHealth(c); if (!hl) return null;
      return h('ul', { class: 'tm-bstrip mono', 'aria-label': 'Case numbers' }, [['ENTITIES', hl.entities], ['LINKS', hl.edges], ['SOURCES', hl.sources], ['PLACES', hl.places], ['NO SOURCE', hl.unsourced], ['PROVENANCE', hl.pct === null ? '--' : hl.pct + '%']].map(([k, v]) => h('li', {}, h('span', {}, k), h('b', {}, String(v)))));
    },
  };
})();
