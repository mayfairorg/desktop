'use strict';
// Layout "Shell" (menu shell): Ghost drawn like a command-line session. A banner, a boxed status line, a prompt to look something up, and a boxed
// menu of tool categories with a highlighted row (arrow keys and Enter, or click). Everything shown is counted on this computer; the module list is the real one.
(function () {
  const GH = window.GH, h = GH.h, L = window.GhostLay, lay = GH.lay;
  // Block letters, five rows each, for the banner. Only the letters the banner needs.
  const FONT = {
    M: ['█   █', '██ ██', '█ █ █', '█   █', '█   █'], A: [' ███ ', '█   █', '█████', '█   █', '█   █'], Y: ['█   █', ' █ █ ', '  █  ', '  █  ', '  █  '],
    F: ['█████', '█    ', '████ ', '█    ', '█    '], I: ['███', ' █ ', ' █ ', ' █ ', '███'], R: ['████ ', '█   █', '████ ', '█  █ ', '█   █'],
    G: [' ████', '█    ', '█  ██', '█   █', ' ███ '], H: ['█   █', '█   █', '█████', '█   █', '█   █'], O: [' ███ ', '█   █', '█   █', '█   █', ' ███ '],
    S: [' ████', '█    ', ' ███ ', '    █', '████ '], T: ['█████', '  █  ', '  █  ', '  █  ', '  █  '], ' ': ['  ', '  ', '  ', '  ', '  '],
  };
  const banner = (text) => { const rows = ['', '', '', '', '']; for (const ch of text.toUpperCase()) { const g = FONT[ch] || FONT[' ']; for (let i = 0; i < 5; i++) rows[i] += g[i] + ' '; } return rows.join('\n'); };
  const box = (title, body, cls) => h('section', { class: 'sh-box ' + (cls || '') }, title ? h('h2', { class: 'sh-bt' }, title) : null, body);

  function menu(onPick) {
    const MODS = window.GhostModules.MODULES;
    const items = MODS.map((m, i) => ({ id: m.id, name: m.name, blurb: m.blurb || '', key: String(i + 1) }));
    let at = 0;
    const note = h('p', { class: 'sh-note mono', 'aria-live': 'polite' }, items[0] ? items[0].blurb : '');
    const list = h('ul', { class: 'sh-menu', role: 'listbox', 'aria-label': 'Tool categories', tabindex: '0' });
    const rows = items.map((it, i) => h('li', { class: 'sh-mi', role: 'option', id: 'sh-mi-' + it.id, dataset: { mod: it.id }, onclick: () => { at = i; paint(); onPick(it); } }, h('span', { class: 'sh-mk', 'aria-hidden': 'true' }), h('span', { class: 'sh-mn mono' }, it.key), h('span', { class: 'sh-ml' }, it.name)));
    list.append(...rows);
    function paint() { rows.forEach((r, i) => { r.setAttribute('aria-selected', i === at ? 'true' : 'false'); r.classList.toggle('on', i === at); }); list.setAttribute('aria-activedescendant', rows[at] ? rows[at].id : ''); note.textContent = items[at] ? items[at].blurb : ''; }
    list.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { at = (at + 1) % rows.length; paint(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { at = (at - 1 + rows.length) % rows.length; paint(); e.preventDefault(); }
      else if (e.key === 'Enter' && items[at]) { onPick(items[at]); e.preventDefault(); }
      else if (/^[1-9]$/.test(e.key) && items[+e.key - 1]) { at = +e.key - 1; paint(); onPick(items[at]); e.preventDefault(); }
    });
    paint();
    return { node: box('SELECT A TOOL CATEGORY', [list, h('p', { class: 'sh-hint mono' }, '↑/↓ move   Enter open   1-9 jump')], 'sh-menubox'), note, list };
  }

  GH.layouts.shell = {
    shell(P) {
      const items = P.navItems();
      const top = h('header', { class: 'sh-top' }, h('div', { class: 'sh-bar' }, h('a', { class: 'sh-brand mono', href: '#home', 'aria-label': 'Mayfair Ghost, home' }, '> mayfair-ghost'), h('span', { class: 'crumb sh-crumb mono', id: 'crumb' }, 'Home'), P.actions()),
        h('nav', { class: 'sh-nav', 'aria-label': 'Ghost' }, h('div', { class: 'sh-nav-in' }, items.map((it, n) => lay.navLink(it, 'shl mono', '[' + (n + 1) + '] ' + it.label)), lay.termButton('shl mono', '[t] Terminal'))));
      return { root: h('div', { class: 'app sh-app', id: 'app', dataset: { view: 'home', layout: 'menu-shell' } }, top, h('main', { id: 'main', tabindex: '-1' }), P.buildStatus()), destroy() {} };
    },
    home() {
      const lk = lay.lookupForm({ cls: 'sh-search', button: 'Run', kind: false, prompt: 'ghost@local:~$', placeholder: 'domain, IP, ASN, URL, company or place', label: 'What to look up: domain, IP, ASN, URL, company or place', autofocus: true });
      const status = h('p', { class: 'sh-stat mono', role: 'status' }, 'Reading this computer');
      const state = h('p', { class: 'sh-state mono' });
      const m = menu((it) => GH.go('m', it.id));
      const sec = h('section', { class: 'view sh-home', 'aria-label': 'Home' },
        h('h1', { class: 'sr' }, 'Mayfair Ghost'), h('pre', { class: 'sh-banner', 'aria-hidden': 'true' }, banner('GHOST')),
        h('div', { class: 'sh-hello' }, h('p', { class: 'mono' }, 'LOCAL NODE  /  SESSION READY'), h('p', { class: 'mono sh-hi' }, '[ MAYFAIR GHOST ]')),
        state, status, lk.form, lk.err, m.node, m.note,
        h('p', { class: 'sh-foot mono' }, 'Names of people, usernames, emails and phone numbers are not looked up. Everything stays on this computer.'));
      const fill = (s) => {
        const vw = L.vaultWord(s.vault), run = GH.jobs.running()[0], j = s.jobs[0];
        state.textContent = '◆ ' + (run ? 'LOOKING UP  ' + run.connector + (run.query ? ' ' + run.query : '') : j ? 'LAST LOOKUP  ' + (L.JOB_STATE[j.status] || j.status).toUpperCase() + (j.results === undefined || j.results === null ? '' : '  ' + GH.plural(j.results, 'result')) : 'NO LOOKUPS YET IN THIS WINDOW');
        status.textContent = ['TOOLS ' + s.stats.ready + '/' + s.stats.expected + ' READY', 'CASES ' + (Array.isArray(s.cases) ? s.cases.length : '--'), 'ENTITIES ' + (s.health ? s.health.entities : '--'), 'VAULT ' + vw.word].join('   ·   ');
      };
      const refresh = async () => { try { fill(await GH.data.snapshot()); } catch (e) { status.textContent = GH.errText(e); } };
      GH.data.watch(sec, refresh); refresh();
      return sec;
    },
    moduleSummary(m) {
      return lay.withConnectors('sh-msum', (list) => {
        const rows = lay.moduleRows(m, list), ready = rows.filter((r) => r.key === 'passed').length;
        return box('TOOLS  ' + ready + '/' + rows.length + ' READY', h('ul', { class: 'sh-rows mono' }, rows.map((r) => h('li', {}, h('span', { 'aria-hidden': 'true' }, L.cellChar(r.key)), h('span', {}, r.id), h('span', { class: 'st-' + r.key }, r.state)))));
      });
    },
    boardStrip(c) {
      const hl = L.caseHealth(c); if (!hl) return null;
      return h('p', { class: 'sh-bstats mono' }, [hl.entities + ' ENTITIES', hl.edges + ' LINKS', hl.sources + ' SOURCES', hl.places + ' PLACES', (hl.pct === null ? '--' : hl.pct + '%') + ' SOURCED'].join('   ·   '));
    },
  };
})();
