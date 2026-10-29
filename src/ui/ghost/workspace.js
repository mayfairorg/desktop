'use strict';
// Ghost Workspace: the master search, the tool index and the search runs.
// One box takes what the person types or drops, works out what it is (a domain, an address, a company, a place, a file ...), says what it understood, and on Enter asks every
// ready tool that accepts that kind, at once. The tools are Mayfair's own lookups; they are ready when Ghost starts. Everything here comes from the app's own calls
// (the tool list and the search run): the page never lists a tool, a state or a result it was not told about, and it keeps nothing outside this window.
(function () {
  const GH = window.GH, h = GH.h, S = window.GhostScope, MODS = window.GhostModules, MG = window.GhostMerge;
  const ws = (GH.ws = { searches: [], next: null });

  // ---------- kinds ----------
  // The closed list of what a search can be: the module input kinds without the ones that only make sense inside a case, a rules file, a log file or an instance.
  const KINDS = MODS.INPUT_KINDS.filter((k) => !['entity', 'rules-file', 'log-file', 'instance-url'].includes(k));
  const KIND_LABEL = { domain: 'Domain', ip: 'IP address', cidr: 'Network range', asn: 'Network (ASN)', url: 'Web address', 'cert-hash': 'Certificate fingerprint', 'org-name': 'Organisation name', lei: 'LEI (legal entity identifier)', file: 'File', 'place-text': 'Place', coords: 'Coordinates', keyword: 'Keyword' };
  const KIND_SHORT = { domain: 'domain', ip: 'IP address', cidr: 'network range', asn: 'ASN', url: 'web address', 'cert-hash': 'certificate fingerprint', 'org-name': 'organisation', lei: 'LEI', file: 'file', 'place-text': 'place', coords: 'coordinates', keyword: 'keyword' };
  ws.KINDS = KINDS; ws.kindLabel = (k) => KIND_LABEL[k] || k;
  const TYPE_LABEL = { ...GH.TYPE_LABEL, person: 'Person in a public record' }, TYPE_PLURAL = { ...GH.TYPE_PLURAL, person: 'People in public records' };
  ws.typeLabel = (t) => TYPE_LABEL[t] || (t ? t[0].toUpperCase() + t.slice(1) : 'Other'); ws.typePlural = (t) => TYPE_PLURAL[t] || ws.typeLabel(t);
  const TYPE_ICON = { domain: 'globe', ip: 'ip', asn: 'asn', cert: 'cert', org: 'org', person: 'user', document: 'doc', image: 'image', place: 'pin', event: 'event', url: 'link', email: 'mail', service: 'net', finding: 'board' };
  ws.typeIcon = (t) => TYPE_ICON[t] || 'board';

  // The groups of the tool index, in order. `module` is the Ghost module whose list of wanted tools names the same ones, used when the app gives no category.
  const CATS = [['domains', 'Domains and networks'], ['companies', 'Companies'], ['files', 'Files and images'], ['places', 'Places'], ['news', 'News'], ['archive', 'Archive'], ['threat', 'Threat intel'], ['other', 'Other']];
  ws.CATS = CATS;
  const catOf = (t) => {
    const c = String(t.category || '').toLowerCase();
    for (const [id, label] of CATS) if (c === id || c === label.toLowerCase()) return id;
    if (/domain|network|dns/.test(c)) return 'domains'; if (/compan|organi|entit|record/.test(c)) return 'companies'; if (/file|image|media|document/.test(c)) return 'files'; if (/place|map|geo|satellite/.test(c)) return 'places';
    if (/news|event/.test(c)) return 'news'; if (/archive|web/.test(c)) return 'archive'; if (/threat|vuln|intel|security/.test(c)) return 'threat';
    const m = MODS.MODULES.find((x) => x.wants.some((w) => w[0] === t.id)); return m && ({ domains: 'domains', infra: 'domains', companies: 'companies', files: 'files', places: 'places', news: 'news', archive: 'archive', threat: 'threat' })[m.id] || 'other';
  };

  // ---------- the app's calls ----------
  // gapp:builtins.status, gapp:search.classify, gapp:search.run, gapp:search.cancel and the events gapp:builtins and gapp:search (see the contract).
  const A = () => GH.api || {};
  const hasSearch = () => !!(A().search && A().search.run && A().builtins && A().builtins.status);
  ws.available = hasSearch;
  const noApi = () => { const e = new Error('This version of Ghost cannot run searches. Update Mayfair Desktop and open Ghost again.'); e.code = 'no-api'; return e; };

  // ---------- the tool list ----------
  const ST = { data: null, error: null, p: null, subs: new Set(), timer: null, ping: null };
  const STATES = ['ready', 'setting-up', 'needs-program', 'off', 'failed'];
  function normStatus(r) {
    const tools = (Array.isArray(r && r.tools) ? r.tools : []).filter((t) => t && typeof t.id === 'string').map((t) => ({ id: t.id, name: t.name || t.id, category: catOf(t), inputs: Array.isArray(t.inputs) ? t.inputs.filter((k) => typeof k === 'string') : [], state: STATES.includes(t.state) ? t.state : 'setting-up', note: String(t.note || ''), tested: ['tested', 'offline', 'failed', 'pending'].includes(t.tested) ? t.tested : 'pending', testNote: String(t.testNote || '') }));
    const n = (s) => tools.filter((t) => t.state === s).length;
    return { total: tools.length, ready: n('ready'), settingUp: n('setting-up'), needsProgram: n('needs-program'), off: n('off'), failed: Array.isArray(r && r.failed) ? r.failed : tools.filter((t) => t.state === 'failed').map((t) => ({ id: t.id, name: t.name, reason: t.note || t.testNote })), tools };
  }
  const notify = () => { for (const f of [...ST.subs]) { try { f(ST.data); } catch { /* listener failed */ } } };
  ws.status = {
    get: () => ST.data, error: () => ST.error,
    on(f) { ST.subs.add(f); return () => ST.subs.delete(f); },
    load(force) {
      if (!hasSearch()) { ST.error = noApi(); return Promise.resolve(null); }
      if (ST.p && !force) return ST.p;
      ST.p = (async () => {
        try { ST.data = normStatus(await GH.call(A().builtins.status)); ST.error = null; } catch (e) { ST.error = e; }
        finally { ST.p = null; }
        clearTimeout(ST.timer); if (ST.data && ST.data.settingUp) { ST.delay = Math.min(15000, (ST.delay || 1250) * 2); ST.timer = setTimeout(() => ws.status.load(true), ST.delay); if (ST.timer && ST.timer.unref) ST.timer.unref(); } else ST.delay = 0;
        notify(); return ST.data;
      })();
      return ST.p;
    },
  };
  ws.tool = (id) => (ST.data && ST.data.tools.find((t) => t.id === id)) || null;
  // Tools that accept a kind: { ready, other } (other: set up soon, need a program, switched off or not working)
  ws.toolsFor = (kind) => { const all = ST.data ? ST.data.tools.filter((t) => t.inputs.includes(kind)) : []; return { ready: all.filter((t) => t.state === 'ready'), other: all.filter((t) => t.state !== 'ready') }; };
  const bound = {};
  function listen() {
    const a = A();
    if (a.onBuiltins && bound.b !== a.onBuiltins) { bound.b = a.onBuiltins; a.onBuiltins((p) => { if (p && Array.isArray(p.tools)) { ST.data = normStatus(p); notify(); } else { clearTimeout(ST.ping); ST.ping = setTimeout(() => ws.status.load(true), 150); } }); }
    if (a.onSearch && bound.s !== a.onSearch) { bound.s = a.onSearch; a.onSearch((ev) => ws._event(ev)); }
  }

  // ---------- what the box understood ----------
  const LEI = /^[A-Z0-9]{18}[0-9]{2}$/, COORD = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/, ORG_WORD = /\b(ltd|limited|plc|inc|llc|gmbh|corp|corporation|holdings|group|company|co\.|ag|sa|bv|nv|s\.a\.|pty|llp)\b/i;
  // The page's own reading of a typed text. Used only when the app's classify call is not there; the app's answer is the one that counts when it is.
  function localClassify(q) {
    const t = q.trim(), pr = S.refusePersonQuery(t); if (pr.refused) { const e = new Error(pr.reason); e.code = 'refused'; throw e; }
    const d = S.detectInput(t); if (d.kind) return { kind: d.kind, value: d.value, alternatives: d.kind === 'domain' ? [{ kind: 'keyword', value: t }] : [] };
    if (LEI.test(t)) return { kind: 'lei', value: t, alternatives: [{ kind: 'keyword', value: t }] };
    const c = COORD.exec(t); if (c && Math.abs(+c[1]) <= 90 && Math.abs(+c[2]) <= 180) return { kind: 'coords', value: +c[1] + ', ' + +c[2], alternatives: [{ kind: 'place-text', value: t }] };
    if (ORG_WORD.test(t)) return { kind: 'org-name', value: t, alternatives: [{ kind: 'keyword', value: t }, { kind: 'place-text', value: t }] };
    return { kind: 'keyword', value: t, alternatives: [{ kind: 'org-name', value: t }, { kind: 'place-text', value: t }] };
  }
  ws.classify = async (q) => {
    if (!A().search || !A().search.classify) { const r = localClassify(q); return { ...r, local: true }; }
    const r = await GH.call(A().search.classify, { query: q });
    return { kind: r.kind, value: r.value === undefined ? q : r.value, alternatives: Array.isArray(r.alternatives) ? r.alternatives.filter((a) => a && KINDS.includes(a.kind)) : [] };
  };

  // ---------- running a search ----------
  const subsOf = (s) => s.subs;
  const ping = (s) => { for (const f of [...s.subs]) { try { f(s); } catch { /* listener failed */ } } };
  const pending = new Map();   // events that arrive before the run call has answered
  const toolRow = (id) => { const t = ws.tool(id); return { id, name: t ? t.name : id, status: 'waiting', count: 0, withheld: 0, error: '', ms: null, got: false }; };
  ws.latestFor = (kind, value) => ws.searches.find((s) => s.kind === kind && s.value === value) || null;
  ws.begin = async function begin(o) {
    listen();
    if (!hasSearch()) throw noApi();
    const body = { query: o.kind === 'file' ? o.token : o.value, kind: o.kind }; if (o.tools && o.tools.length) body.tools = o.tools.slice();
    const r = await GH.call(A().search.run, body);
    const s = { id: r.searchId, kind: r.kind || o.kind, value: o.kind === 'file' ? o.value : r.value === undefined ? o.value : r.value, label: o.value, startedAt: Date.now(), endedAt: null, status: 'running', tools: (r.tools || []).map(toolRow), merge: MG.create(), selected: new Set(), subs: new Set(), tab: 'overview', panel: {}, stopping: false };
    ws.searches.unshift(s); if (ws.searches.length > 20) ws.searches.length = 20;
    for (const ev of pending.get(s.id) || []) ws._apply(s, ev); pending.delete(s.id);
    ping(s); return s;
  };
  ws._event = (ev) => {
    if (!ev || typeof ev.searchId !== 'string') return;
    const s = ws.searches.find((x) => x.id === ev.searchId);
    if (!s) { const l = pending.get(ev.searchId) || []; if (l.length < 500) l.push(ev); pending.set(ev.searchId, l); if (pending.size > 40) pending.delete(pending.keys().next().value); return; }
    ws._apply(s, ev); ping(s);
  };
  ws._apply = (s, ev) => {
    const row = ev.tool ? (s.tools.find((t) => t.id === ev.tool) || (s.tools.push(toolRow(ev.tool)), s.tools[s.tools.length - 1])) : null;
    if (ev.type === 'tool-start' && row) { row.status = 'running'; row.startedAt = Date.now(); }
    else if (ev.type === 'tool-result' && row) {
      const res = Array.isArray(ev.results) ? ev.results : [], r = MG.add(s.merge, row.id, res);
      row.ms = typeof ev.ms === 'number' ? ev.ms : row.ms; row.got = true; row.withheld += r.withheld;
      row.count = MG.countFor(s.merge, row.id); row.status = row.count ? 'done' : 'empty';
    } else if (ev.type === 'tool-empty' && row) { row.status = 'empty'; row.ms = typeof ev.ms === 'number' ? ev.ms : row.ms; row.got = true; }
    else if (ev.type === 'tool-error' && row && ['needs-program', 'off', 'setting-up'].includes(ev.state)) {
      // the app did not run this tool at all (it needs a program, is switched off or is still being set up): that is not a failure of the search
      row.status = 'skipped'; row.why = ev.state; row.error = String(ev.error || '').slice(0, 300); row.ms = null; row.got = true;
    }
    else if (ev.type === 'tool-error' && row) { row.status = 'error'; row.error = String(ev.error && ev.error.message ? ev.error.message : ev.error || 'The tool reported an error.').slice(0, 300); row.ms = typeof ev.ms === 'number' ? ev.ms : row.ms; row.got = true; }
    else if (ev.type === 'done') {
      s.endedAt = Date.now(); s.status = s.stopping || ev.cancelled ? 'stopped' : 'done'; if (ev.error) s.problem = String(ev.error).slice(0, 300);
      for (const t of s.tools) if (t.status === 'running' || t.status === 'waiting') { t.status = 'error'; t.error = s.stopping || ev.cancelled ? 'Stopped before it answered.' : 'It did not report back.'; }
    }
  };
  ws.stop = async (s) => {
    if (s.status !== 'running' || s.stopping) return; s.stopping = true; ping(s);
    try { await GH.call(A().search.cancel, { searchId: s.id }); } catch (e) { GH.toast(GH.errText(e)); }
    setTimeout(() => { if (s.status === 'running') ws._apply(s, { type: 'done' }), ping(s); }, 3000);
  };
  ws.counts = (s) => { const c = { total: s.tools.length, done: 0, empty: 0, error: 0, skipped: 0, running: 0, waiting: 0 }; for (const t of s.tools) { if (t.status === 'done') c.done++; else c[t.status]++; } c.finished = c.done + c.empty + c.error + c.skipped; return c; };
  // A new run of the same search, from a result page.
  ws.again = (s) => { ws.next = { kind: s.kind, value: s.value, tools: s.tools.map((t) => t.id), token: s.token || null, force: true }; GH.go('search', s.kind, s.value); };

  // ---------- small pieces ----------
  const LABEL = { ready: 'Ready', 'setting-up': 'Setting up', 'needs-program': 'Ghost computer', off: 'Switched off', failed: 'Not working' };
  const EXPLAIN = { ready: 'Ready to use.', 'setting-up': 'Ghost is getting this ready. It can be used as soon as setup finishes.', 'needs-program': 'It needs a program that is not on this computer. It works as soon as the program exists, for example in the virtual computer.', off: 'You switched this tool off. Switch it on in Tool Integrations to use it again.', failed: 'It did not start.' };
  ws.stateLabel = (t) => LABEL[t.state] || t.state;
  ws.stateExplain = (t) => { const base = EXPLAIN[t.state] || ''; return t.note && t.state !== 'ready' ? t.note + (t.state === 'failed' ? '' : '. ' + base) : base; };
  ws.stateTag = (t) => h('span', { class: 'ws-st st-' + t.state, title: ws.stateExplain(t) }, ws.stateLabel(t));
  ws.testTag = (t) => h('span', { class: 'ws-tb tb-' + t.tested, title: t.testNote || null }, { tested: 'Tested', offline: 'Online check later', failed: 'Test failed', pending: 'Checking' }[t.tested] || 'Checking');
  const kindsText = (t) => t.inputs.filter((k) => KINDS.includes(k)).map((k) => KIND_SHORT[k] || k).join(', ') || 'nothing yet';
  const icon = (n) => GH.icon(n);
  const errState = (title, msg, retry) => h('div', { class: 'state', role: 'alert' }, icon('alert'), h('h2', {}, title), h('p', {}, msg), retry ? GH.btn('Try again', { onclick: retry }) : null);

  // ---------- the tool index ----------
  // o: { activeId, compact, kind (highlights the tools that accept it) }
  ws.toolIndex = function toolIndex(o = {}) {
    const host = h('section', { class: 'ws-idx' + (o.compact ? ' compact' : ''), 'aria-labelledby': 'ws-idx-h' });
    const head = h('div', { class: 'ws-idx-h' }, h('h2', { id: 'ws-idx-h', class: o.compact ? 'sr' : null }, 'Tools'), h('p', { class: 'ws-count', role: 'status', 'aria-live': 'polite' }, ''));
    const filter = h('input', { type: 'search', class: 'ws-filter', 'aria-label': 'Filter the tools by name or by what they accept', placeholder: 'Filter tools', autocomplete: 'off', spellcheck: 'false' });
    const body = h('div', { class: 'ws-idx-b' });
    let unsub = null;
    const draw = () => {
      if (!host.isConnected && unsub && host.dataset.drawn) { unsub(); return; }
      host.dataset.drawn = '1';
      const st = ST.data, cnt = head.querySelector('.ws-count'); GH.clear(body);
      if (!st) {
        if (ST.error) { cnt.textContent = ''; body.append(errState('The tool list could not be read', GH.errText(ST.error), () => { ws.status.load(true); })); }
        else { cnt.textContent = 'Reading the tool list'; body.append(h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i', {}), h('i', {}), h('i', {}))); }
        return;
      }
      if (ST.error && !o.compact) body.append(h('div', { class: 'ws-fail', role: 'alert' }, h('p', {}, h('b', {}, 'The tool list could not be refreshed. '), GH.errText(ST.error), ' What is shown was read earlier.'), GH.btn('Try again', { onclick: () => { ws.status.load(true); } })));
      const bits = [st.ready + ' of ' + st.total + ' ready']; if (st.settingUp) bits.push(st.settingUp + ' setting up'); if (st.needsProgram) bits.push(st.needsProgram + ' need a program'); if (st.off) bits.push(st.off + ' switched off'); if (st.failed.length) bits.push(st.failed.length + ' not working');
      cnt.textContent = bits.join(', ');
      if (!st.total) { body.append(h('div', { class: 'state sm' }, icon('tool'), h('p', {}, 'Ghost has not listed any tools yet. It lists them as soon as they are set up. Tools you add yourself are in Tool Integrations.'))); return; }
      if (st.failed.length && !o.compact) body.append(h('div', { class: 'ws-fail', role: 'alert' }, h('p', {}, h('b', {}, st.failed.length === 1 ? '1 tool did not start.' : st.failed.length + ' tools did not start.'), ' The others work.'), h('ul', {}, st.failed.slice(0, 8).map((f) => h('li', {}, h('span', { class: 'mono' }, f.name || f.id), ': ', f.reason || 'No reason was given.')))));
      const q = filter.value.trim().toLowerCase(); let shown = 0;
      for (const [cid, label] of CATS) {
        const list = st.tools.filter((t) => catOf(t) === cid && (!q || (t.name + ' ' + t.id + ' ' + kindsText(t)).toLowerCase().includes(q))); if (!list.length) continue; shown += list.length;
        const id = 'ws-cat-' + cid + (o.compact ? '-c' : '');
        body.append(h('section', { class: 'ws-cat', 'aria-labelledby': id }, h('h3', { id }, label, h('span', { class: 'ws-n mono' }, String(list.length))),
          h('ul', { class: 'ws-tools' }, list.map((t) => h('li', {}, h('a', { class: 'ws-tool' + (o.kind && t.inputs.includes(o.kind) && t.state === 'ready' ? ' fits' : ''), href: GH.href('tool', t.id), 'aria-current': o.activeId === t.id ? 'page' : null, dataset: { tool: t.id } },
            h('span', { class: 'ws-tn' }, t.name), o.compact ? null : h('span', { class: 'ws-tk' }, 'Takes: ' + kindsText(t)), h('span', { class: 'ws-tg' }, ws.stateTag(t), t.state === 'ready' && (!o.compact || t.tested !== 'tested') ? ws.testTag(t) : null)))))));
      }
      if (!shown) body.append(h('p', { class: 'ws-none' }, 'No tool matches "' + filter.value.trim() + '".'));
    };
    filter.addEventListener('input', draw);
    host.append(head, h('div', { class: 'ws-filter-w' }, filter), body);
    unsub = ws.status.on(draw); draw(); if (!ST.data && !ST.p) ws.status.load(false).then(() => { if (!ST.data && !ST.error) draw(); });
    return host;
  };

  // ---------- the master search box ----------
  // o: { value, kind, compact }
  ws.searchBox = function searchBox(o = {}) {
    const compact = !!o.compact, state = { cur: null, pick: null, file: null, tools: null, err: '', q: '' };
    const input = h('input', { id: 'ws-q', class: 'ws-in mono', type: 'text', placeholder: 'Domain, IP, ASN, URL, company, place or keyword', 'aria-label': 'What to look up', 'aria-describedby': 'ws-u', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', value: o.value || '', 'data-autofocus': compact ? null : '' });
    const u = h('div', { id: 'ws-u', class: 'ws-u', 'aria-live': 'polite' });
    const fileBtn = GH.btn('Choose a file', { icon: 'doc', cls: 'ws-file', onclick: () => chooseFile() });
    const go = GH.btn('Search', { primary: true, type: 'submit', icon: 'search', cls: 'ws-go' });
    const form = h('form', { class: 'ws-search', role: 'search', onsubmit: (ev) => { ev.preventDefault(); submit(); }, autocomplete: 'off' },
      h('div', { class: 'ws-row' }, h('span', { class: 'ws-ico', 'aria-hidden': 'true' }, icon('search')), input, go), h('div', { class: 'ws-row2', hidden: compact }, fileBtn), u);
    const drop = h('p', { class: 'ws-drop', 'aria-hidden': 'true' }, 'Drop a file here, or choose one. Files stay on this computer.');
    form.append(drop);
    form.addEventListener('dragover', (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) { e.preventDefault(); form.classList.add('over'); } });
    form.addEventListener('dragleave', () => form.classList.remove('over'));
    form.addEventListener('drop', (e) => { form.classList.remove('over'); if (!(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length)) return; e.preventDefault(); const f = e.dataTransfer.files[0]; state.pick = { kind: 'file', value: f.name }; paint(); chooseFile(f.name); });
    const kindNow = () => (state.pick || state.cur || {}).kind || null;
    const eff = () => (state.pick ? state.pick : state.cur && !state.cur.error ? state.cur : null);
    let seq = 0;
    async function doClassify() {
      const q = input.value.trim(), my = ++seq; state.q = q;
      if (!q) { state.cur = null; state.pick = state.pick && state.pick.kind === 'file' ? state.pick : null; paint(); return; }
      if (state.pick && state.pick.kind === 'file') state.pick = null;
      try { const r = await ws.classify(q); if (my !== seq) return; state.cur = r; state.pick = null; state.tools = null; }
      catch (e) { if (my !== seq) return; state.cur = { error: GH.errText(e) }; state.pick = null; }
      paint();
    }
    const soon = GH.debounce(doClassify, 170);
    input.addEventListener('input', () => { state.err = ''; soon(); });
    async function chooseFile(name) {
      let p = null; try { p = await GH.call(A().pickFile); } catch (e) { GH.toast(GH.errText(e)); }
      if (!p) { if (name) { state.pick = null; state.err = 'Nothing was chosen. Drop the file again or press Choose a file.'; } paint(); return null; }
      state.file = p; state.pick = { kind: 'file', value: p.name }; state.cur = state.cur && !state.cur.error ? state.cur : null; state.err = ''; input.value = ''; paint(); return p;
    }
    function accepts(k) {
      const el = h('div', { class: 'ws-acc' });
      if (!k) return el;
      if (!ST.data) { el.append(h('p', { class: 'hint' }, ST.error ? 'The tool list could not be read, so Ghost cannot say which tools will answer.' : 'Reading the tool list.')); return el; }
      const t = ws.toolsFor(k);
      if (t.ready.length) {
        const picked = state.tools || new Set(t.ready.map((x) => x.id)); state.tools = picked;
        el.append(h('p', { class: 'ws-ask' }, 'Will ask ', h('b', {}, GH.plural(picked.size, 'tool')), picked.size === t.ready.length ? ' (every ready tool that takes a ' + (KIND_SHORT[k] || k) + ')' : ' of ' + t.ready.length + ' that take a ' + (KIND_SHORT[k] || k), '.'));
        if (!compact && t.ready.length > 1) {
          const boxes = t.ready.map((x) => { const c = GH.chk(x.name, { checked: picked.has(x.id), onchange: (ev) => { if (ev.target.checked) picked.add(x.id); else picked.delete(x.id); el.querySelector('.ws-ask').replaceWith(accepts(k).querySelector('.ws-ask')); go.disabled = picked.size === 0; } }); c.input.dataset.tool = x.id; return c.el; });
          el.append(h('details', { class: 'ws-pick' }, h('summary', {}, 'Choose which tools to ask'), h('div', { class: 'ws-pick-l' }, boxes)));
        }
      } else if (k === 'cidr') el.append(h('p', { class: 'ws-warn' }, 'No lookup takes a network range. Checking a range is Active scanning, which asks you to declare a target first. ', h('a', { class: 'link', href: GH.href('m', 'scan') }, 'Open Active scanning')));
      else el.append(h('p', { class: 'ws-warn' }, 'No ready tool takes a ' + (KIND_SHORT[k] || k) + ' yet.' + (t.other.length ? ' ' + GH.plural(t.other.length, 'tool') + ' that do ' + (t.other.length === 1 ? 'is' : 'are') + ' not ready: ' + t.other.slice(0, 4).map((x) => x.name + ' (' + ws.stateLabel(x).toLowerCase() + ')').join(', ') + '.' : '') + ' Try changing what this is.'));
      return el;
    }
    function paint() {
      GH.clear(u); fileBtn.hidden = false; drop.hidden = compact;
      const e = eff(), q = input.value.trim();
      if (state.err) u.append(h('p', { class: 'cmd-err', role: 'alert' }, state.err));
      if (state.cur && state.cur.error && !state.pick) { u.append(h('p', { class: 'cmd-err', role: 'alert' }, state.cur.error)); return; }
      if (!e) { if (!q && !compact) u.append(h('p', { class: 'ws-hint' }, 'Type or paste something and Ghost works out what it is, then asks every ready tool that can help. Press / to come back here from anywhere.')); return; }
      const sel = h('select', { class: 'ws-kind', id: 'ws-kind', 'aria-label': 'Change what this is' });
      const seen = new Set(), opt = (k, v, lab) => { seen.add(k); return h('option', { value: k + '|' + v, selected: e.kind === k }, lab || KIND_LABEL[k] || k); };
      const grp = (label, items) => (items.length ? h('optgroup', { label }, items) : null);
      const base = state.cur && !state.cur.error ? state.cur : { kind: e.kind, value: e.value, alternatives: [] };
      const first = [opt(base.kind, base.value, KIND_LABEL[base.kind] + ' (understood)')];
      const alts = (base.alternatives || []).filter((a) => !seen.has(a.kind)).map((a) => opt(a.kind, a.value));
      const rest = KINDS.filter((k) => !seen.has(k)).map((k) => opt(k, q || e.value));
      sel.append(grp('Understood as', first), grp('It could also be', alts), grp('Treat it as', rest));
      if (e.kind && ![...sel.options].some((o) => o.value.startsWith(e.kind + '|'))) sel.prepend(h('option', { value: e.kind + '|' + e.value, selected: true }, KIND_LABEL[e.kind] || e.kind));
      const valueEl = h('span', { class: 'mono ws-val' }, e.kind === 'file' ? (state.file ? state.file.name : 'no file chosen yet') : e.value);
      const accHost = h('div', {});
      sel.addEventListener('change', () => { const [k, ...v] = sel.value.split('|'); state.pick = { kind: k, value: v.join('|') }; state.tools = null; valueEl.textContent = k === 'file' ? (state.file ? state.file.name : 'no file chosen yet') : state.pick.value; GH.clear(accHost).append(accepts(k)); go.disabled = false; if (k === 'file' && !state.file) chooseFile(); });
      u.append(h('div', { class: 'ws-understood' }, h('p', {}, h('span', { class: 'mute' }, 'Understood as '), h('b', {}, KIND_LABEL[e.kind] || e.kind), ': ', valueEl), h('label', { class: 'ws-change', for: 'ws-kind' }, h('span', {}, 'Change'), sel)));
      if (e.kind === 'file' && !state.file) u.append(h('p', { class: 'hint' }, 'Choose the file to look at. It is read on this computer and never sent anywhere.'));
      accHost.append(accepts(e.kind)); u.append(accHost);
      go.disabled = !!(state.tools && state.tools.size === 0 && e.kind !== 'file' && ST.data && ws.toolsFor(e.kind).ready.length);
    }
    async function submit() {
      const q = input.value.trim(); state.err = '';
      if (kindNow() === 'file' && !state.file) { if (!(await chooseFile())) return; }
      else if (!q && !(state.pick && state.pick.kind === 'file')) { state.err = 'Type or paste something to look up, or choose a file.'; paint(); input.focus(); return; }
      if (!state.pick && (!state.cur || state.q !== q)) { soon.cancel(); await doClassify(); }
      const e = eff(); if (!e) { input.focus(); return; }
      if (ST.data) { const t = ws.toolsFor(e.kind); if (!t.ready.length) { paint(); GH.say('No ready tool takes that.'); return; } }
      const all = ST.data ? ws.toolsFor(e.kind).ready.map((x) => x.id) : [], chosen = state.tools && ST.data ? [...state.tools] : null;
      ws.next = { kind: e.kind, value: e.value, tools: chosen && chosen.length && chosen.length < all.length ? chosen : null, token: e.kind === 'file' && state.file ? state.file.token : null, force: true };
      GH.go('search', e.kind, e.value);
    }
    if (o.kind && o.value !== undefined) { state.cur = { kind: o.kind, value: o.value, alternatives: [] }; if (o.kind === 'file') { state.pick = { kind: 'file', value: o.value }; state.file = o.file || null; input.value = ''; } }
    paint(); if (!ST.data) ws.status.load(false).then(() => { if (form.isConnected) paint(); }); const un = ws.status.on(() => { if (!form.isConnected) un(); else if (!state.tools) paint(); });
    if (!o.kind && o.value) soon();
    return { el: form, input, focus: () => input.focus({ preventScroll: true }), submit };
  };

  // ---------- the Workspace screen ----------
  const recentSearches = () => {
    const rows = ws.searches.slice(0, 6); if (!rows.length) return h('p', { class: 'empty-s' }, 'Nothing searched in this window yet.');
    return h('ul', { class: 'list ws-recent' }, rows.map((s) => { const c = ws.counts(s), sm = MG.summary(s.merge); return h('li', {}, h('a', { href: GH.href('search', s.kind, s.value), class: 'ws-rs' }, icon('search'), h('span', { class: 't' }, h('b', { class: 'mono' }, s.label || s.value), h('span', {}, (KIND_LABEL[s.kind] || s.kind) + ': ' + (s.status === 'running' ? 'running, ' + c.finished + ' of ' + c.total + ' tools done' : GH.plural(sm.entities, 'finding') + ' from ' + GH.plural(c.total, 'tool')))))); }));
  };
  GH.routes.workspace = async () => {
    listen(); ws.status.load(false);
    const box = ws.searchBox({}), rec = h('ul', { class: 'list', id: 'recent' }, h('li', { class: 'mute' }, 'Loading'));
    GH.cs.list().then((list) => {
      GH.clear(rec);
      if (!list.length) rec.append(h('li', { class: 'empty-s' }, 'No cases yet. Add results from a search, or start an empty case.'));
      for (const c of list.slice(0, 5)) rec.append(h('li', {}, h('a', { href: GH.href('case', c.id) }, icon('board'), h('span', { class: 't' }, h('b', {}, c.title), h('span', {}, GH.plural(c.entities, 'entity', 'entities') + ', ' + GH.plural(c.sources, 'source') + ', ' + GH.fmtTime(c.updated))), h('span', { class: 'enc', title: 'Encrypted in your vault' }, icon('lock')))));
    }).catch((e) => { GH.clear(rec); rec.append(h('li', { class: 'state-s' }, GH.errText(e))); });
    const view = h('section', { class: 'view ws', 'aria-labelledby': 'h-ws' },
      h('div', { class: 'ws-head' }, h('p', { class: 'eyebrow mono' }, 'WORKSPACE'), h('h1', { id: 'h-ws' }, 'Search once. Ask every tool.'), h('p', { class: 'lead sm' }, 'Type or drop what you have. Ghost works out what it is and asks every ready tool that takes it, at once, politely. Public sources only, and everything stays on this computer.')),
      box.el, ws.toolIndex({ kind: null }),
      h('div', { class: 'two' },
        h('section', { class: 'panel', 'aria-labelledby': 'h-rs' }, h('div', { class: 'panel-h' }, h('h2', { id: 'h-rs' }, 'Searched in this window'), h('span', { class: 'mute' }, 'Kept only until you close Ghost')), recentSearches()),
        h('section', { class: 'panel', 'aria-labelledby': 'h-recent' }, h('div', { class: 'panel-h' }, h('h2', { id: 'h-recent' }, 'Recent cases'), h('a', { class: 'link', href: '#case' }, 'All cases')), rec)),
      h('p', { class: 'ws-rules mono' }, 'Names of people, usernames, emails and phone numbers are not looked up.'));
    if (!window.matchMedia || !window.matchMedia('(pointer:coarse)').matches) setTimeout(() => { if (box.input.isConnected && !document.querySelector('.scrim') && (!document.activeElement || document.activeElement === document.body || document.activeElement.id === 'main')) box.focus(); }, 30);
    return view;
  };

  // ---------- #search/<kind>/<value> ----------
  GH.routes.search = async (kind, value) => {
    listen(); await ws.status.load(false);
    if (!KINDS.includes(kind) || !String(value || '').trim()) return GH.routes.workspace();
    const next = ws.next && ws.next.kind === kind && ws.next.value === value ? ws.next : null; ws.next = null;
    let s = next && next.force ? null : ws.latestFor(kind, value);
    if (!s) {
      if (kind === 'file' && !(next && next.token)) return h('section', { class: 'view ws' }, h('div', { class: 'state' }, icon('doc'), h('h2', {}, 'Choose the file again'), h('p', {}, 'Ghost does not keep a file after you close its window or leave the page. Choose it again to look at it.'), GH.btn('Back to the Workspace', { primary: true, onclick: () => GH.go('workspace') })));
      try { s = await ws.begin({ kind, value, tools: next && next.tools, token: next && next.token }); }
      catch (e) { return h('section', { class: 'view ws' }, errState('This search did not start', GH.errText(e)), h('div', { class: 'row-a' }, GH.btn('Back to the Workspace', { primary: true, onclick: () => GH.go('workspace') }))); }
      if (next && next.token) s.token = next.token;
    }
    return GH.results.view(s);
  };

  // ---------- #tool and #tool/<id> ----------
  GH.routes.tool = async (id, query) => {
    listen(); await ws.status.load(false);
    if (!id) return h('section', { class: 'view ws', 'aria-labelledby': 'h-tools' }, h('div', { class: 'ws-head' }, h('p', { class: 'eyebrow mono' }, 'TOOLS'), h('h1', { id: 'h-tools' }, 'All tools'),
      h('p', { class: 'lead sm' }, 'Every lookup that ships with Mayfair, grouped by what it does. Open one to use it on its own. Tools you add yourself, and security tools, are in Tool Integrations.'), h('div', { class: 'row-a' }, GH.btn('Back to the Workspace', { onclick: () => GH.go('workspace') }), GH.btn('Tool Integrations', { icon: 'tool', onclick: () => GH.go('tools') }))), ws.toolIndex({}));
    const t = ws.tool(id);
    if (!t) return h('section', { class: 'view ws' }, h('div', { class: 'state' }, icon('tool'), h('h2', {}, ST.data ? 'There is no tool called "' + id + '"' : 'Tools could not be listed'), h('p', {}, ST.data ? 'It may have been removed, or the address is wrong.' : GH.errText(ST.error || new Error('Reading the tool list failed.'))), GH.btn('Open all tools', { primary: true, onclick: () => GH.go('tool') })));
    let kind; if (query) { try { kind = (await ws.classify(query)).kind; } catch { kind = undefined; } }
    let page;
    try { page = typeof GH.toolPage === 'function' ? await GH.toolPage(id, { query: query || undefined, kind }) : null; } catch (e) { page = errState('This tool page did not load', GH.errText(e), GH.render); }
    if (!page) page = h('div', { class: 'state' }, icon('tool'), h('h2', {}, t.name), h('p', {}, 'The page for this tool is not part of this build.'), h('p', { class: 'mono' }, ws.stateLabel(t) + '. ' + ws.stateExplain(t)));
    return h('section', { class: 'view ws ws-toolv', 'aria-label': t.name },
      h('nav', { class: 'ws-crumbs', 'aria-label': 'Where you are' }, h('a', { class: 'link', href: GH.href('workspace') }, 'Workspace'), icon('chev'), h('a', { class: 'link', href: GH.href('tool') }, 'All tools'), icon('chev'), h('span', { 'aria-current': 'page' }, t.name)),
      h('div', { class: 'ws-split' }, h('div', { class: 'ws-split-in' }, h('details', { class: 'ws-aside', open: true }, h('summary', {}, 'All tools'), ws.toolIndex({ activeId: id, compact: true })), h('div', { class: 'ws-main' }, page))));
  };

  // ---------- what the lookup boxes of the skin layouts do ----------
  // They keep their own box. What is typed goes to the master search; a refusal is explained at once, and anything else is classified by the app.
  GH.submitLookup = (value) => {
    const v = String(value || '').trim();
    if (!v) return 'Type a domain, IP address, ASN, web address, company, place or keyword.';
    const pr = S.refusePersonQuery(v); if (pr.refused) return pr.reason;
    ws.classify(v).then((r) => { ws.next = { kind: r.kind, value: r.value, tools: null, token: null, force: true }; GH.go('search', r.kind, r.value); }).catch((e) => GH.toast(GH.errText(e)));
    return null;
  };

  // ---------- the / key ----------
  window.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || !GH.mounted) return;
    const t = e.target, tag = (t && t.tagName) || ''; if (/INPUT|TEXTAREA|SELECT/.test(tag) || (t && t.isContentEditable) || document.querySelector('.scrim')) return;
    const r = GH.current ? GH.current() : { name: '' }; if (r.name === 'case' && r.arg) return;      // on the case board "/" searches the case
    e.preventDefault();
    const q = document.getElementById('ws-q');
    if (q) { q.focus(); q.select(); return; }
    GH.go('workspace'); setTimeout(() => { const b = document.getElementById('ws-q'); if (b) b.focus(); }, 80);
  });
})();
