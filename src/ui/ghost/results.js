'use strict';
// Ghost Results: what a master search shows. A tab strip: Overview (every finding merged into one row, grouped by type, with the tools that found it) and one tab per tool
// that was asked, each with a badge (how many it found, running, error, nothing found). Tables and plain lines, no cards. Every tool tab can also open that tool's own page.
(function () {
  const GH = window.GH, h = GH.h, MG = window.GhostMerge, ws = GH.ws;
  const icon = (n) => GH.icon(n);
  const WITHHELD = 'The tool sent them in a form Ghost could not read.';
  const when = (iso) => (iso ? GH.fmtTime(iso) : 'no time given');
  const toolName = (s, id) => { const t = s.tools.find((x) => x.id === id), k = ws.tool(id); return (k && k.name) || (t && t.name) || id; };

  // the case store takes the kinds it knows; the others are added without a query entity
  const queryFor = (s) => { const k = ({ 'org-name': 'org', lei: 'org', 'place-text': 'place' })[s.kind] || s.kind; return ['domain', 'ip', 'asn', 'url', 'cert-hash', 'org', 'place'].includes(k) ? { kind: k, value: s.value } : null; };
  async function addToCase(s, keys) {
    const parts = MG.toIngest(s.merge, keys); if (!parts.length) return;
    let conns = []; try { conns = await GH.conn.list(); } catch { /* the sources are still recorded from the results */ }
    let added = 0, merged = 0, withheld = 0, title = '';
    for (const p of parts) {
      const entry = conns.find((c) => c.id === p.tool) || { id: p.tool, version: (p.results[0] && p.results[0].source && p.results[0].source.version) || '' };
      const out = await GH.cs.addResults({ connector: entry, query: queryFor(s), results: p.results }); if (out === null) return;
      added += out.added; merged += out.merged; withheld += out.withheld;
    }
    const c = GH.cs.current(); title = c ? c.title : 'the case';
    GH.toast('Added to "' + title + '": ' + GH.plural(added, 'new entity', 'new entities') + (merged ? ', ' + merged + ' merged' : '') + (withheld ? ', ' + withheld + ' not added' : '') + '.');
  }

  // a plain table for one tool's results; used only when the tool-page module's own table is not there
  function plainTable(rows) {
    return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl ws-plain' }, h('caption', { class: 'sr' }, 'Results'), h('thead', {}, h('tr', {}, ['Type', 'Value', 'Confidence', 'Seen'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, ws.typeLabel(r.type)), h('td', { class: 'mono' }, r.value), h('td', {}, r.confidence || ''), h('td', { class: 'mono mute' }, when(r.observedAt)))))));
  }

  // ---------- Overview ----------
  function overview(s) {
    const root = h('div', { class: 'ws-ov' }), sm = MG.summary(s.merge), c = ws.counts(s);
    if (!sm.entities) {
      if (s.status === 'running') return h('div', { class: 'ws-wait' }, h('p', { role: 'status' }, 'Waiting for the first answer. ' + GH.plural(c.running + c.waiting, 'tool') + ' still working.'), h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i', {}), h('i', {}), h('i', {})));
      if (c.total && c.error + c.skipped === c.total) return h('div', { class: 'state', role: 'alert' }, icon('alert'), h('h2', {}, 'No tool could answer'), h('p', {}, 'Every tool reported a problem or could not run. Open a tool tab to read why. Nothing was made up in its place.'), GH.btn('Search again', { primary: true, onclick: () => ws.again(s) }));
      return h('div', { class: 'state' }, icon('search'), h('h2', {}, 'Nothing found'), h('p', {}, 'No public record matched. That does not prove nothing is there: the tools only see what is published, and some of them may have had a problem' + (c.error ? ' (' + GH.plural(c.error, 'tool') + ' did).' : '.')), sm.withheld ? h('p', { class: 'flow-note' }, icon('lock'), h('span', {}, GH.plural(sm.withheld, 'result') + ' left out. ' + WITHHELD)) : null);
    }
    const groups = MG.groups(s.merge), total = sm.entities, sel = s.selected;
    const count = h('span', { class: 'ws-selcount', role: 'status', 'aria-live': 'polite' }, ''), add = GH.btn('Add to case', { primary: true, icon: 'plus', cls: 'ws-add' });
    const paintSel = () => { count.textContent = sel.size ? sel.size + ' selected' : 'Nothing selected'; add.querySelector('span').textContent = sel.size ? 'Add ' + sel.size + ' to case' : 'Add to case'; add.disabled = !sel.size; };
    add.addEventListener('click', async () => { add.disabled = true; try { await addToCase(s, sel); } catch (e) { GH.toast(GH.errText(e)); } paintSel(); });
    const allKeys = groups.flatMap((g) => g.items.map((e) => e.key));
    root.append(h('div', { class: 'ws-bar' }, h('p', { class: 'ws-sum' }, h('b', {}, GH.plural(total, 'finding')), ' from ' + GH.plural(c.done, 'tool') + (sm.corroborated ? '; ' + sm.corroborated + ' found by more than one tool.' : '.')),
      h('div', { class: 'row-a' }, GH.btn('Select all', { ghost: true, onclick: () => { allKeys.forEach((k) => sel.add(k)); sync(); } }), GH.btn('Clear', { ghost: true, onclick: () => { sel.clear(); sync(); } }), count, add)));
    if (sm.withheld) root.append(h('p', { class: 'flow-note' }, icon('lock'), h('span', {}, GH.plural(sm.withheld, 'result') + ' left out. ' + WITHHELD)));
    const boxes = [];
    const sync = () => { for (const b of boxes) b.checked = b.dataset.key ? sel.has(b.dataset.key) : b._grp.every((k) => sel.has(k)); paintSel(); };
    for (const g of groups) {
      const hid = 'ws-g-' + g.type, keys = g.items.map((e) => e.key);
      const gbox = h('input', { type: 'checkbox', 'aria-label': 'Select every ' + ws.typeLabel(g.type).toLowerCase() + ' in the list', dataset: { fid: 'g-' + g.type } }); gbox._grp = keys; boxes.push(gbox);
      gbox.addEventListener('change', () => { for (const k of keys) { if (gbox.checked) sel.add(k); else sel.delete(k); } sync(); });
      root.append(h('section', { class: 'ws-g', 'aria-labelledby': hid }, h('h3', { id: hid }, icon(ws.typeIcon(g.type)), ws.typePlural(g.type), h('span', { class: 'ws-n mono' }, String(g.items.length))),
        h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl ws-tbl' }, h('caption', { class: 'sr' }, ws.typePlural(g.type) + ' found by the tools'),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col', class: 'ck' }, gbox), h('th', { scope: 'col' }, 'Found'), h('th', { scope: 'col' }, 'Found by'), h('th', { scope: 'col' }, 'Seen'))),
          h('tbody', {}, g.items.map((e) => {
            const cb = h('input', { type: 'checkbox', checked: sel.has(e.key), 'aria-label': 'Select ' + e.value, dataset: { key: e.key, fid: e.key } }); boxes.push(cb);
            cb.addEventListener('change', () => { if (cb.checked) sel.add(e.key); else sel.delete(e.key); sync(); });
            const span = e.first === null ? 'no time given' : e.first === e.last ? GH.fmtTime(e.first) : GH.fmtTime(e.first) + ' to ' + GH.fmtTime(e.last);
            return h('tr', { class: e.confidence === 'uncertain' ? 'unsure' : '' },
              h('td', { class: 'ck' }, cb),
              h('td', { class: 'ws-v', dataset: { label: 'Found' } }, h('span', { class: 'mono' }, e.value), e.kind ? h('span', { class: 'mute sm' }, ' (' + e.kind + ')') : null,
                h('details', { class: 'ws-src' }, h('summary', {}, GH.plural(e.sources.length, 'source') + ', ' + ({ confirmed: 'confirmed', likely: 'likely', uncertain: 'uncertain' })[e.confidence]),
                  h('ul', { class: 'sm' }, e.sources.map((x) => h('li', {}, h('b', { class: 'mono' }, toolName(s, x.tool) + (x.version ? ' ' + x.version : '')), ' ', h('span', { class: 'mute' }, when(x.observedAt) + (x.url ? ' · ' + x.url : '')), x.note ? h('span', { class: 'mute' }, ' · ' + x.note) : null))))),
              h('td', { class: 'ws-fb', dataset: { label: 'Found by' } }, e.tools.map((t) => h('button', { type: 'button', class: 'ws-chip', title: 'Open the ' + toolName(s, t) + ' tab', onclick: () => s._open && s._open(t) }, toolName(s, t)))),
              h('td', { class: 'mono mute ws-when', dataset: { label: 'Seen' } }, span));
          }))))));
    }
    paintSel(); return root;
  }

  // ---------- one tool's tab ----------
  function toolTab(s, t) {
    const k = ws.tool(t.id), root = h('div', { class: 'ws-tt' }), mode = s.panel[t.id] || 'search';
    const strip = h('dl', { class: 'ws-strip' },
      h('div', {}, h('dt', {}, 'State'), h('dd', {}, k ? ws.stateTag(k) : 'Unknown', k && k.state === 'ready' ? ws.testTag(k) : null)),
      h('div', {}, h('dt', {}, 'In this search'), h('dd', {}, { waiting: 'Waiting', running: 'Running', done: GH.plural(t.count, 'finding'), empty: 'Nothing found', error: 'Error', skipped: 'Did not run' }[t.status] + (t.ms !== null && t.status !== 'running' && t.status !== 'waiting' ? ', ' + (t.ms < 1000 ? Math.round(t.ms) + ' ms' : (t.ms / 1000).toFixed(1) + ' s') : ''))),
      h('div', {}, h('dt', {}, 'Asked for'), h('dd', { class: 'mono' }, ws.kindLabel(s.kind) + ': ' + s.value)));
    const sw = h('div', { class: 'ws-sw', role: 'group', 'aria-label': 'What to show for ' + t.name },
      GH.btn('This search', { cls: 'seg', onclick: () => { s.panel[t.id] = 'search'; redraw(); } }), GH.btn('Tool page', { cls: 'seg', onclick: () => { s.panel[t.id] = 'page'; redraw(); } }));
    sw.children[0].setAttribute('aria-pressed', String(mode === 'search')); sw.children[1].setAttribute('aria-pressed', String(mode === 'page'));
    const body = h('div', { class: 'ws-tt-b' });
    function redraw() { const m = s.panel[t.id] || 'search'; sw.children[0].setAttribute('aria-pressed', String(m === 'search')); sw.children[1].setAttribute('aria-pressed', String(m === 'page')); GH.clear(body); body.append(m === 'page' ? pageView() : searchView()); }
    function pageView() {
      let p = null; try { p = typeof GH.toolPage === 'function' ? GH.toolPage(t.id, { query: s.kind === 'file' ? undefined : s.value, kind: s.kind }) : null; } catch (e) { return h('p', { class: 'cmd-err', role: 'alert' }, GH.errText(e)); }
      if (p && typeof p.then === 'function') { const ph = h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i', {}), h('i', {})); p.then((n) => ph.replaceWith(n)).catch((e) => ph.replaceWith(h('p', { class: 'cmd-err', role: 'alert' }, GH.errText(e)))); return ph; }
      return p || h('p', { class: 'mute' }, 'The page for this tool is not part of this build. ', h('a', { class: 'link', href: GH.href('tool', t.id) }, 'Open it on its own'));
    }
    function searchView() {
      if (t.status === 'waiting' || t.status === 'running') return h('div', { class: 'ws-wait' }, h('p', { role: 'status' }, t.status === 'waiting' ? t.name + ' is waiting its turn. Ghost spaces out requests to each service.' : t.name + ' is running.'), h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i', {}), h('i', {})));
      if (t.status === 'skipped') return h('div', { class: 'state sm' }, icon('tool'), h('h2', {}, t.name + ' did not run'), h('p', {}, t.error || 'It is not ready.'), k ? h('p', { class: 'mono' }, ws.stateLabel(k) + '. ' + ws.stateExplain(k)) : null, GH.btn('Open the tool page', { onclick: () => { s.panel[t.id] = 'page'; redraw(); } }));
      if (t.status === 'error') return h('div', { class: 'state sm', role: 'alert' }, icon('alert'), h('h2', {}, t.name + ' could not answer'), h('p', {}, t.error || 'The tool reported an error.'), k && k.state !== 'ready' ? h('p', { class: 'mono' }, ws.stateLabel(k) + '. ' + ws.stateExplain(k)) : null, GH.btn('Open the tool page', { onclick: () => { s.panel[t.id] = 'page'; redraw(); } }));
      if (t.status === 'empty') return h('div', { class: 'state sm' }, icon('search'), h('h2', {}, 'Nothing found by ' + t.name), h('p', {}, 'No public record matched. That does not prove nothing is there.'));
      const rows = MG.resultsOf(s.merge, t.id), keys = [...new Set(rows.map((r) => r.key))];
      const table = typeof GH.resultTable === 'function' ? GH.resultTable(rows, { compact: false }) : plainTable(rows);
      return h('div', { class: 'stack' }, h('div', { class: 'ws-bar' }, h('p', { class: 'ws-sum' }, h('b', {}, GH.plural(rows.length, 'result')), ' from ' + t.name + '.'), GH.btn('Add these to case', { primary: true, icon: 'plus', onclick: async (ev) => { ev.currentTarget.disabled = true; try { await addToCase(s, keys); } catch (e) { GH.toast(GH.errText(e)); } ev.currentTarget.disabled = false; } })),
        t.withheld ? h('p', { class: 'flow-note' }, icon('lock'), h('span', {}, GH.plural(t.withheld, 'result') + ' left out. ' + WITHHELD)) : null, table);
    }
    redraw(); root.append(h('div', { class: 'ws-tt-h' }, h('h2', {}, t.name), sw), strip, body); return root;
  }

  // ---------- the screen ----------
  const badge = (t) => ({ waiting: 'waiting', running: 'running', done: String(t.count), empty: 'none', error: 'error', skipped: ({ 'needs-program': 'ghost computer', off: 'off', 'setting-up': 'setting up' })[t.why] || 'not run' }[t.status]);
  GH.results = {
    view(s) {
      const host = h('section', { class: 'view ws ws-res', 'aria-labelledby': 'ws-rh' });
      const box = ws.searchBox({ value: s.kind === 'file' ? '' : s.value, kind: s.kind, file: s.token ? { token: s.token, name: s.value } : null, compact: true });
      const sumEl = h('p', { class: 'ws-prog-t', role: 'status', 'aria-live': 'polite' }, ''), prog = h('progress', { class: 'ws-prog', max: '1', value: '0', 'aria-label': 'Tools finished' });
      const stop = GH.btn('Stop', { icon: 'stop', onclick: () => ws.stop(s) }), again = GH.btn('Search again', { icon: 'refresh', onclick: () => ws.again(s) });
      const tabs = h('div', { class: 'ws-tabs', role: 'tablist', 'aria-label': 'Overview and one tab for each tool' }), panel = h('div', { class: 'ws-panel', id: 'ws-panel', role: 'tabpanel', tabindex: '0' });
      const btns = new Map();
      const tabList = () => [{ id: 'overview', label: 'Overview' }, ...s.tools.map((t) => ({ id: t.id, label: t.name }))];
      const tid = (id) => 'ws-tab-' + id.replace(/[^a-z0-9_-]/gi, '_');
      const buildTabs = () => {
        const cur = document.activeElement && tabs.contains(document.activeElement) ? document.activeElement.dataset.tab : null;
        GH.clear(tabs); btns.clear();
        for (const tb of tabList()) {
          const t = s.tools.find((x) => x.id === tb.id), b = h('button', { type: 'button', role: 'tab', class: 'ws-tab', id: tid(tb.id), dataset: { tab: tb.id }, 'aria-selected': String(s.tab === tb.id), 'aria-controls': 'ws-panel', tabindex: s.tab === tb.id ? '0' : '-1' },
            h('span', { class: 'ws-tl' }, tb.label), h('span', { class: 'ws-badge b-' + (t ? t.status : 'overview') }, t ? badge(t) : String(MG.summary(s.merge).entities)));
          b.addEventListener('click', () => select(tb.id)); b.addEventListener('keydown', (ev) => {
            const ids = tabList().map((x) => x.id); let i = ids.indexOf(tb.id), n = null;
            if (ev.key === 'ArrowRight') n = ids[(i + 1) % ids.length]; else if (ev.key === 'ArrowLeft') n = ids[(i - 1 + ids.length) % ids.length]; else if (ev.key === 'Home') n = ids[0]; else if (ev.key === 'End') n = ids[ids.length - 1];
            if (n) { ev.preventDefault(); select(n, true); }
          });
          btns.set(tb.id, b); tabs.append(b);
        }
        if (cur && btns.get(cur)) btns.get(cur).focus({ preventScroll: true });
      };
      const patchTabs = () => {
        const want = tabList(); if (want.length !== btns.size) { buildTabs(); return; }
        for (const tb of want) { const b = btns.get(tb.id); if (!b) { buildTabs(); return; } const t = s.tools.find((x) => x.id === tb.id), bd = b.querySelector('.ws-badge'), txt = t ? badge(t) : String(MG.summary(s.merge).entities); if (bd.textContent !== txt) bd.textContent = txt; const cls = 'ws-badge b-' + (t ? t.status : 'overview'); if (bd.getAttribute('class') !== cls) bd.setAttribute('class', cls); }
      };
      function drawPanel() {
        const keep = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.dataset.fid : null, top = panel.scrollTop;
        GH.clear(panel); panel.setAttribute('aria-labelledby', tid(s.tab));
        const t = s.tools.find((x) => x.id === s.tab); panel.append(t ? toolTab(s, t) : overview(s));
        if (keep) { const el = [...panel.querySelectorAll('[data-fid]')].find((x) => x.dataset.fid === keep); if (el) el.focus({ preventScroll: true }); }
        panel.scrollTop = top;
      }
      function select(id, focus) { s.tab = id; for (const [k, b] of btns) { b.setAttribute('aria-selected', String(k === id)); b.tabIndex = k === id ? 0 : -1; } drawPanel(); if (focus) btns.get(id).focus(); }
      s._open = (id) => select(id, false);
      const header = () => {
        const c = ws.counts(s), sm = MG.summary(s.merge), run = s.status === 'running';
        const bits = [GH.plural(c.total, 'tool') + ' asked'];
        if (c.done) bits.push(c.done + ' found something'); if (c.empty) bits.push(c.empty + ' found nothing'); if (c.error) bits.push(c.error + (c.error === 1 ? ' had a problem' : ' had problems')); if (c.skipped) bits.push(c.skipped + ' could not run'); if (c.running + c.waiting) bits.push((c.running + c.waiting) + ' still working');
        sumEl.textContent = (s.status === 'stopped' ? 'Stopped. ' : s.status === 'done' ? 'Finished. ' : s.stopping ? 'Stopping. ' : '') + bits.join(', ') + '. ' + GH.plural(sm.entities, 'finding') + (run ? ' so far.' : '.');
        if (s.problem) sumEl.textContent += ' ' + s.problem;
        prog.max = Math.max(1, c.total); prog.value = c.finished; stop.hidden = !run; stop.disabled = s.stopping; again.hidden = run;
      };
      let timer = null, dirty = false;
      const refresh = () => {
        if (!host.isConnected) { s.subs.delete(fn); return; }
        header(); patchTabs();
        const t = s.tools.find((x) => x.id === s.tab);
        if (!t) drawPanel(); else if (s.panel[t.id] !== 'page') drawPanel();
      };
      const fn = () => { if (dirty) return; dirty = true; clearTimeout(timer); timer = setTimeout(() => { dirty = false; refresh(); }, 200); };
      s.subs.add(fn);
      if (!s.tools.some((t) => t.id === s.tab) && s.tab !== 'overview') s.tab = 'overview';
      host.append(h('div', { class: 'ws-head' }, h('p', { class: 'eyebrow mono' }, 'RESULTS'), h('h1', { id: 'ws-rh' }, 'Results for ', h('span', { class: 'mono ws-rv' }, s.value)), h('p', { class: 'lead sm' }, ws.kindLabel(s.kind) + '. Started ' + GH.fmtClock(new Date(s.startedAt).toISOString()) + '. Each tool asks its service politely, so some answers arrive before others.')),
        box.el, h('div', { class: 'ws-progress' }, prog, sumEl, h('div', { class: 'row-a' }, stop, again, GH.btn('Workspace', { ghost: true, onclick: () => GH.go('workspace') }))), tabs, panel);
      buildTabs(); header(); drawPanel();
      return host;
    },
  };
})();
