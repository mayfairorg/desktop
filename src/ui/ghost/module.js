'use strict';
// Ghost module screens and connector cards. A module runs the connectors that are installed (through the Ghost connector core) and shows each one it expected but
// cannot find as "Connector not installed". There is no sample data anywhere: a result on screen came from a connector run on this computer.
(function () {
  const GH = window.GH, h = GH.h, S = window.GhostScope, M = window.GhostCase, MODS = window.GhostModules;
  const TERMINAL = ['done', 'failed', 'cancelled', 'timed-out'];
  const NET = { local: ['Works on this computer only', 'Sends nothing anywhere.'], 'keyless-external': ['Uses outside services', 'No account key needed.'], 'rate-limited': ['Uses outside services with limits', 'Ghost keeps to each service\'s fair-use rule.'], unavailable: ['Not available now', 'The service it needs cannot be used right now.'] };
  const STATE = { 'not-approved': 'Not approved', approved: 'Approved, switched off', enabled: 'Switched on', disabled: 'Switched off' };
  const SCOPE_TAG = { local: 'LOCAL', passive: 'PASSIVE', active: 'ACTIVE' };

  const reqLine = (r) => h('li', { class: 'req ' + r.status }, h('span', { class: 'mono' }, r.status === 'ok' ? 'Ready' : r.status === 'untested' ? 'Not checked' : 'Missing'), h('span', {}, r.name), r.detail && r.status !== 'ok' && r.status !== 'untested' ? h('span', { class: 'mute' }, ' ' + String(r.detail).slice(0, 120)) : null);
  const fieldsOf = (g) => (g && g.input && g.input.fields) || [];

  // o: { entry|null, label, id, onChange(), runnable, input() -> {kind,value}, needScope() -> scopeId|null, module }
  GH.connectorCard = function connectorCard(o) {
    const e = o.entry, host = h('article', { class: 'ccard' + (e ? '' : ' missing') + (e && e.scope === 'active' ? ' active' : ''), 'aria-label': (e ? e.name : o.label) });
    const head = h('div', { class: 'cc-h' }, h('div', { class: 'cc-t' }, h('h3', {}, e ? e.name : o.label), h('span', { class: 'mono mute' }, (e ? e.id : o.id) + (e && e.version ? '  v' + e.version : ''))), e ? h('span', { class: 'tag' + (e.scope === 'active' ? ' act' : '') }, SCOPE_TAG[e.scope] || 'ACTIVE') : h('span', { class: 'tag' }, 'NOT INSTALLED'));
    host.append(head);
    if (!e) {
      host.append(h('p', { class: 'cc-state' }, GH.icon('alert'), h('b', {}, 'Connector not installed')), h('p', { class: 'mute sm' }, 'Ghost has no "' + o.id + '" connector on this computer. It is shown so you know it is expected here. No results are made up in its place.'));
      return host;
    }
    const net = NET[e.network] || NET.unavailable;
    const gated = e.gated === 'scanning';
    host.append(h('p', { class: 'cc-d' }, e.description));
    const facts = h('dl', { class: 'kv' },
      h('dt', {}, 'State'), h('dd', {}, STATE[e.state] || 'Not approved'),
      h('dt', {}, 'Network'), h('dd', {}, net[0] + '. ' + net[1]),
      h('dt', {}, 'Installed'), h('dd', {}, e.install.installed ? 'Yes: it passed its own test on this computer' : 'Not yet: ' + (e.install.requirements.some((r) => r.status !== 'ok' && r.status !== 'untested') ? 'something it needs is missing' : 'its self-test has not passed')),
      h('dt', {}, 'Tested'), h('dd', {}, e.install.verified === 'tested' ? 'Passed on ' + GH.fmtTime(e.install.lastTest && e.install.lastTest.t) : e.install.verified === 'failed' ? 'Failed: ' + String(e.install.lastTest && e.install.lastTest.detail || '').slice(0, 160) : 'Not tested'),
      h('dt', {}, 'Licence'), h('dd', {}, (e.licence ? e.licence.spdx + ', ' + (e.licence.mode === 'bundled' ? 'ships with the connector' : 'separate program') : 'unknown')));
    host.append(facts);
    if (e.install.requirements.length) host.append(h('ul', { class: 'reqs', 'aria-label': 'What it needs' }, e.install.requirements.map(reqLine)));
    if (e.permissions.length) host.append(h('p', { class: 'mute sm' }, 'It needs permission to: ' + e.permissions.join(', ') + '.'));
    if (e.externalRestrictions && e.externalRestrictions !== 'None.') host.append(h('p', { class: 'mute sm' }, e.externalRestrictions.slice(0, 400)));
    if (e.health !== 'ok') host.append(h('p', { class: 'cc-state err', role: 'alert' }, GH.icon('alert'), h('span', {}, e.health === 'changed' ? 'Its files changed after you approved it. Approval was withdrawn. Approve it again if you trust the change.' : 'It is broken: its files are missing or not valid.')));
    if (e.scope === 'active') host.append(h('p', { class: 'cc-state' }, GH.icon('scan'), h('span', {}, 'Active: it talks to the target itself. It runs only against a target you declare, and every run is logged in your vault.')));
    if (gated) { host.append(h('p', { class: 'cc-state err' }, GH.icon('lock'), h('span', {}, 'Active scanning is not switched on for your account.'))); return host; }

    const act = h('div', { class: 'row-a' }), msg = h('p', { class: 'hint', role: 'status' });
    const doit = (label, fn, extra) => GH.btn(label, { ...extra, onclick: async (ev) => { const b = ev.currentTarget; b.disabled = true; msg.textContent = ''; try { const r = await fn(); if (r && r.passed === false) msg.textContent = 'The self-test failed: ' + (r.detail || 'see the details above.'); else if (r && r.declined) msg.textContent = 'Not approved.'; } catch (x) { msg.textContent = GH.errText(x); } GH.conn.bust(); if (o.onChange) o.onChange(); } });
    if (e.state === 'not-approved') act.append(doit('Approve…', () => GH.call(GH.api.connectors.requestApproval, e.id), { primary: true }));
    if (e.state === 'approved' || e.state === 'enabled' || e.state === 'disabled') { if (e.scope !== 'active') act.append(doit('Run self-test', () => GH.call(GH.api.connectors.test, e.id))); }
    if (e.state === 'approved' || e.state === 'disabled') act.append(doit('Switch on', () => GH.call(GH.api.connectors.enable, e.id), { primary: e.install.installed }));
    if (e.state === 'enabled') act.append(doit('Switch off', () => GH.call(GH.api.connectors.disable, e.id)));
    if (e.state === 'not-approved' && e.scope === 'active') act.append(h('span', { class: 'mute sm' }, 'You approve a tool in a native dialog.'));
    host.append(act, msg);
    if (o.runnable && e.state === 'enabled' && e.health === 'ok') host.append(runPanel(e, o));
    else if (o.runnable && e.state === 'enabled') host.append(h('p', { class: 'mute sm' }, 'Not ready to run.'));
    return host;
  };

  // ---------- running a connector ----------
  function runPanel(e, o) {
    const box = h('div', { class: 'runbox' }), form = h('form', { class: 'rform', onsubmit: (ev) => { ev.preventDefault(); start(); } });
    const out = h('div', { class: 'rout' }); const values = {}; const pickers = {};
    const status = h('p', { class: 'run-s mono', role: 'status' }, ''), cancel = GH.btn('Cancel', { ghost: true, onclick: async () => { if (live) await GH.call(GH.api.jobs.cancel, live).catch(() => {}); } });
    let fields = null, live = null, userEdited = false;
    const submit = GH.btn(e.scope === 'active' ? 'Start scan' : 'Run', { primary: true, type: 'submit', disabled: true });
    box.append(h('div', { class: 'skel' }, h('i', {})));
    GH.call(GH.api.connectors.get, e.id).then((g) => {
      fields = fieldsOf(g); GH.clear(box); build(); box.append(form, status, out);
    }).catch((x) => { GH.clear(box); box.append(h('p', { class: 'hint err' }, GH.errText(x))); });
    function mainTarget() { return o.input ? o.input() : null; }
    function build() {
      let primarySet = false;
      for (const f of fields) {
        const id = 'rf-' + e.id + '-' + f.name; const label = f.label || f.name; let ctl;
        if (f.type === 'file') {
          const name = h('span', { class: 'mono mute sm' }, 'No file chosen');
          ctl = h('div', { class: 'filepick' }, GH.btn('Choose a file…', { onclick: async () => { try { const p = await GH.call(GH.api.pickFile); if (p) { pickers[f.name] = p; name.textContent = p.name + ' (' + Math.ceil(p.size / 1024) + ' KB)'; refresh(); } } catch (x) { GH.toast(GH.errText(x)); } } }), name);
        } else if (f.type === 'enum') {
          ctl = h('select', { id }, f.values.map((v) => h('option', { value: v }, v))); values[f.name] = () => ctl.value;
        } else if (f.type === 'integer') {
          ctl = h('input', { id, type: 'number', min: f.min, max: f.max, value: String(f.min) }); values[f.name] = () => ctl.value;
        } else {
          ctl = h('input', { id, type: f.sensitive ? 'password' : 'text', maxlength: f.maxLength || 4096, autocomplete: 'off', spellcheck: 'false' });
          if (!primarySet && (f.type === 'url-host' || f.type === 'string') && f.required !== false) { primarySet = true; ctl.dataset.primary = '1'; const t = mainTarget(); if (t && t.value) ctl.value = t.value; }
          ctl.addEventListener('input', () => { userEdited = true; refresh(); }); values[f.name] = () => ctl.value;
        }
        if (e.scope === 'active' && f.type === 'url-host') { ctl.value = (o.scopeTarget && o.scopeTarget()) || ''; ctl.readOnly = true; }
        form.append(GH.field(label + (f.required === false ? ' (optional)' : ''), ctl, f.sensitive ? 'Not written to logs.' : null));
        form.querySelector('#' + CSS.escape(id)) && null;
      }
      form.append(h('div', { class: 'row-a' }, submit, cancel)); cancel.hidden = true;
      box.refreshInput = () => { if (!userEdited) { const t = mainTarget(); const p = form.querySelector('[data-primary]'); if (p && t) p.value = t.value || ''; } refresh(); };
      refresh();
    }
    function ready() {
      for (const f of fields) {
        if (f.type === 'file') { if (f.required !== false && !pickers[f.name]) return false; continue; }
        const v = values[f.name] ? String(values[f.name]()).trim() : ''; if (f.required !== false && !v && f.type !== 'integer') return false;
      }
      if (e.scope === 'active' && !(o.needScope && o.needScope())) return false;
      return true;
    }
    function refresh() { submit.disabled = !!live || !ready(); }
    async function start() {
      if (live || !ready()) return;
      const input = {};
      for (const f of fields) { if (f.type === 'file') { if (pickers[f.name]) input[f.name] = pickers[f.name].token; continue; } const v = String(values[f.name]()).trim(); if (v === '' && f.required === false) continue; input[f.name] = f.type === 'integer' ? Number(v) : v; }
      for (const f of fields) if (f.type === 'string' || f.type === 'url-host') { const pr = S.refusePersonQuery(input[f.name] || ''); if (pr.refused) { status.textContent = pr.reason; return; } }
      GH.clear(out); status.textContent = 'Starting'; submit.disabled = true; cancel.hidden = false;
      let r;
      try { r = e.scope === 'active' ? await GH.call(GH.api.scope.run, { connector: e.id, scopeId: o.needScope(), input: Object.fromEntries(Object.entries(input).filter(([k]) => !(fields.find((f) => f.name === k) || {}).type || (fields.find((f) => f.name === k) || {}).type !== 'url-host')) }) : await GH.call(GH.api.jobs.run, { connector: e.id, input }); }
      catch (x) { status.textContent = GH.errText(x); cancel.hidden = true; refresh(); return; }
      live = r.jobId; let job = null;
      while (true) {
        try { job = await GH.call(GH.api.jobs.get, live); } catch (x) { status.textContent = GH.errText(x); break; }
        if (!job) { status.textContent = 'The job was not found.'; break; }
        status.textContent = ({ queued: 'Waiting in line', running: 'Running' + (job.progress ? ' ' + Math.round(job.progress * 100) + '%' : '') + (job.message ? ': ' + job.message : '') })[job.status] || '';
        if (TERMINAL.includes(job.status)) break;
        await new Promise((res) => setTimeout(res, 700));
      }
      live = null; cancel.hidden = true;
      if (job) finish(job);
      refresh();
    }
    function finish(job) {
      const n = job.resultCount || (job.results || []).length;
      status.textContent = job.status === 'done' ? 'Done: ' + GH.plural(n, 'result') + (job.rejected ? ', ' + GH.plural(job.rejected, 'line') + ' rejected' : '') + '.' : job.status === 'cancelled' ? 'Cancelled.' : job.status === 'timed-out' ? 'Stopped: it took too long.' : 'Failed: ' + (job.message || 'the tool reported an error') + '.';
      if (job.errors && job.errors.length) out.append(h('details', { class: 'errs' }, h('summary', {}, GH.plural(job.errors.length, 'rejected line') + ' (first ones)'), h('ul', { class: 'mono sm' }, job.errors.slice(0, 5).map((x) => h('li', {}, 'line ' + x.line + ': ' + x.error)))));
      if (job.status === 'done' || n) out.append(resultsView(e, o.input ? o.input() : null, job));
      if (job.status !== 'done' && !n) return;
    }
    box.refreshInput = box.refreshInput || (() => {});
    host_registry.set(e.id, box);
    return box;
  }
  const host_registry = new Map();

  // The list of what a run returned: grouped by type, each with its source, and "Add to case".
  function resultsView(entry, query, job) {
    const results = job.results || []; const wrap = h('div', { class: 'results' });
    const person = results.filter((r) => r && r.entity && M.isPersonType(r.entity.type)).length;
    const shown = results.filter((r) => r && r.entity && !M.isPersonType(r.entity.type));
    const qk = query && query.kind; const q = query && query.value ? { kind: ({ 'org-name': 'org', lei: 'org', 'place-text': 'place' })[qk] || qk, value: query.value } : null;
    const q2 = q && ['domain', 'ip', 'asn', 'url', 'cert-hash', 'org', 'place'].includes(q.kind) ? q : null;
    const addAll = GH.btn('Add all to case', { primary: true, icon: 'plus', disabled: !shown.length, onclick: async () => { await GH.cs.addResults({ connector: entry, query: q2, results: shown }); } });
    wrap.append(h('div', { class: 'res-h' }, h('h4', {}, GH.plural(shown.length, 'result')), job.resultsTruncated ? h('span', { class: 'mute sm' }, 'Showing the first ' + shown.length) : null, addAll));
    if (person) wrap.append(h('p', { class: 'flow-note' }, GH.icon('lock'), h('span', {}, GH.plural(person, 'result') + ' withheld: Ghost does not show or store details about private people.')));
    if (!shown.length) { wrap.append(h('div', { class: 'state sm' }, GH.icon('search'), h('p', {}, 'No public records found. That does not prove nothing is there.'))); return wrap; }
    const groups = {}; for (const r of shown) { const t = M.mapType(r.entity.type).type; (groups[t] = groups[t] || []).push(r); }
    for (const [t, rows] of Object.entries(groups)) {
      wrap.append(h('div', { class: 'eg mono' }, GH.icon(({ domain: 'globe', ip: 'ip', asn: 'asn', cert: 'cert', org: 'org', document: 'doc', image: 'image', place: 'pin', event: 'event', url: 'link', email: 'mail' })[t] || 'board'), GH.TYPE_PLURAL[t] + ' ' + rows.length));
      wrap.append(h('ul', { class: 'elist' }, rows.slice(0, 300).map((r) => h('li', { class: 'er' }, h('div', { class: 'er-m' }, h('span', { class: 'v' }, r.entity.value), h('span', { class: 'a' }, [r.entity.type !== t ? r.entity.type + ', ' : '', ({ confirmed: 'Confirmed', likely: 'Likely', uncertain: 'Uncertain' })[r.confidence] || '', r.uncertaintyNote ? ': ' + r.uncertaintyNote : '', ' · ' + (r.source && r.source.tool || entry.id) + ' ' + (r.source && r.source.version || ''), r.source && r.source.url ? ' · ' + r.source.url : ''].join(''))),
        GH.btn('', { icon: 'plus', ghost: true, title: 'Add ' + r.entity.value + ' to case', onclick: async () => { await GH.cs.addResults({ connector: entry, query: q2, results: [r] }); } })))));
    }
    return wrap;
  }

  // ---------- input checks per module ----------
  function checkInput(m, text) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, reason: 'Type something to look up.' };
    const pr = S.refusePersonQuery(t); if (pr.refused) return { ok: false, reason: pr.reason, refused: true };
    if (m.id === 'scan') { const p = S.parseTarget(t); return p.ok ? { ok: true, kind: p.kind, value: p.value } : { ok: false, reason: p.reason }; }
    if (m.id === 'domains' || m.id === 'archive') { const d = S.detectInput(t); const allowed = m.id === 'domains' ? ['domain', 'ip', 'asn', 'url', 'cert-hash'] : ['url', 'domain']; return allowed.includes(d.kind) ? { ok: true, kind: d.kind, value: d.value } : { ok: false, reason: d.reason || 'Enter ' + (m.id === 'domains' ? 'a domain, IP address, ASN (AS64496) or web address.' : 'a web address or domain.') }; }
    if (m.id === 'places') { const c = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(t); if (c && Math.abs(+c[1]) <= 90 && Math.abs(+c[2]) <= 180) return { ok: true, kind: 'coords', value: +c[1] + ', ' + +c[2], lat: +c[1], lon: +c[2] }; return { ok: true, kind: 'place-text', value: t }; }
    if (m.id === 'companies') { if (/^[A-Z0-9]{20}$/.test(t)) return { ok: true, kind: 'lei', value: t }; const d = S.detectInput(t); if (d.kind === 'domain') return { ok: true, kind: 'domain', value: d.value }; return { ok: true, kind: 'org-name', value: t }; }
    const d = S.detectInput(t); return { ok: true, kind: d.kind || 'keyword', value: d.kind ? d.value : t };
  }
  GH.checkInput = checkInput;

  // ---------- the screen ----------
  GH.routes.m = async (id, value) => {
    const m = MODS.byId(id); if (!m) return GH.routes.modules();
    const entitled = !m.active || (GH.status && GH.status.entitlement && GH.status.entitlement.modules && GH.status.entitlement.modules.scanning);
    const state = { scopeId: null, scopeTarget: null };
    const input = h('input', { id: 'm-in', class: 'mono', type: 'text', placeholder: m.placeholder, 'aria-label': m.placeholder, spellcheck: 'false', autocomplete: 'off', value: value || '', 'data-autofocus': '' });
    const kindEl = h('span', { class: 'cmd-t mono', 'aria-live': 'polite' }, 'auto'), err = h('p', { class: 'cmd-err', role: 'alert', hidden: true });
    const cardsHost = h('div', { class: 'cards' }, h('div', { class: 'skel' }, h('i', {}), h('i', {})));
    const mainInput = () => { const r = checkInput(m, input.value); return r.ok ? r : null; };
    input.addEventListener('input', () => { const r = input.value.trim() ? checkInput(m, input.value) : null; kindEl.textContent = !r ? 'auto' : r.ok ? r.kind : r.refused ? 'not looked up' : 'check input'; err.hidden = true; for (const b of host_registry.values()) b.refreshInput && b.refreshInput(); });
    let listCache = null;
    const draw = async (force) => {
      let list; try { list = await GH.conn.list(force); } catch (x) { GH.clear(cardsHost); cardsHost.append(h('div', { class: 'state' }, GH.icon('alert'), h('h2', {}, 'Connectors could not be listed'), h('p', {}, GH.errText(x)), GH.btn('Try again', { onclick: () => draw(true) }))); return; }
      listCache = list; host_registry.clear(); GH.clear(cardsHost);
      const { wanted, extra } = GH.conn.forModule(list, m);
      const mk = (w) => GH.connectorCard({ entry: w.entry, label: w.label, id: w.id, module: m, runnable: entitled, onChange: () => draw(true), input: mainInput, needScope: () => state.scopeId, scopeTarget: () => state.scopeTarget });
      for (const w of wanted) cardsHost.append(mk(w));
      for (const x of extra) cardsHost.append(mk({ entry: x, label: x.name, id: x.id }));
      for (const b of host_registry.values()) b.refreshInput && b.refreshInput();
    };
    const go = async (ev) => {
      ev.preventDefault(); const r = checkInput(m, input.value); err.hidden = false;
      if (!r.ok) { err.textContent = r.reason; return; }
      err.hidden = true; input.value = r.value;
      for (const b of host_registry.values()) b.refreshInput && b.refreshInput();
      const forms = [...document.querySelectorAll('.rform')].filter((f) => f.querySelector('.btn.primary:not([disabled])'));
      if (!forms.length) { err.hidden = false; err.textContent = 'No connector here is ready to run. Approve and switch one on below, or see Tool Integrations.'; return; }
      forms.forEach((f) => f.requestSubmit());
    };
    draw(false);
    const top = [];
    top.push(h('div', {}, h('p', { class: 'eyebrow mono' }, (m.active ? 'ACTIVE' : 'PASSIVE') + ' MODULE'), h('h1', {}, m.name), h('p', { class: 'lead sm' }, m.blurb)));
    if (m.active) top.push(scopePanel(m, state, entitled, draw));
    if (!m.fileInput && m.local !== 'pivots' && entitled) top.push(h('form', { class: 'cmd mod-cmd', onsubmit: go, autocomplete: 'off' }, h('label', { class: 'cmd-l mono', for: 'm-in', 'aria-hidden': 'true' }, '›'), input, kindEl, GH.btn(m.active ? 'Run ready tools' : 'Look up', { primary: true, type: 'submit' })), err);
    if (m.local === 'pivots') top.push(GH.pivotsPanel());
    if (m.places) top.push(GH.placesPanels());
    return h('section', { class: 'view mod-view' }, ...top, h('div', { class: 'sec-h' }, h('h2', {}, 'Connectors'), h('span', { class: 'mute' }, m.fileInput ? 'Each tool asks for the file it should read. Files never leave this computer.' : 'Only connectors installed on this computer can run. The rest show as not installed.')), cardsHost);
  };

  // ---------- infrastructure pivots (local: computed from the open case) ----------
  GH.pivotsPanel = function () {
    const host = h('section', { class: 'panel', 'aria-labelledby': 'h-piv' });
    const draw = () => {
      GH.clear(host); const c = GH.cs.current();
      host.append(h('div', { class: 'panel-h' }, h('h2', { id: 'h-piv' }, 'Shared infrastructure in this case'), c ? h('span', { class: 'mute mono' }, c.title) : null));
      if (!c) { host.append(h('div', { class: 'state sm' }, GH.icon('net'), h('p', {}, 'Open a case with domains, addresses or certificates to see what they share.'), GH.btn('Open a case', { onclick: async () => { if (await GH.cs.pickCase()) draw(); } }))); return; }
      const groups = GH.pivots(c);
      if (!groups.length) { host.append(h('div', { class: 'state sm' }, GH.icon('net'), h('p', {}, 'Nothing is shared yet. Pivots appear when two entities in the case point at the same address, certificate, name server or network.'))); return; }
      host.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Shared by', 'Relation', 'Used by'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', {}, groups.map((g) => h('tr', {}, h('td', { class: 'mono' }, GH.TYPE_LABEL[g.shared.type] + ' ' + g.shared.label), h('td', { class: 'mono mute' }, [...g.rels].join(', ')), h('td', { class: 'mono' }, g.members.map((x) => x.label).slice(0, 8).join(', ') + (g.members.length > 8 ? ' and ' + (g.members.length - 8) + ' more' : '')))))))), host.append(GH.btn('Show on the case board', { onclick: () => GH.go('case', c.id) }));
    };
    draw(); return host;
  };
  // entities that two or more other entities of one type point at (or are pointed at by)
  GH.pivots = function (c) {
    const out = [];
    for (const e of Object.values(c.entities)) {
      const by = {};
      for (const n of M.neighbours(c, e.id)) { const o = c.entities[n.other]; if (!o || o.id === e.id) continue; (by[o.type] = by[o.type] || { rels: new Set(), members: [] }); by[o.type].rels.add(n.edge.rel); by[o.type].members.push(o); }
      for (const [t, g] of Object.entries(by)) if (g.members.length >= 2 && t !== e.type) out.push({ shared: e, type: t, rels: g.rels, members: g.members });
    }
    return out.sort((a, b) => b.members.length - a.members.length);
  };

  // ---------- the scope guard (active scanning) ----------
  function scopePanel(m, state, entitled, redraw) {
    const host = h('section', { class: 'panel scope-panel', 'aria-labelledby': 'h-scope' });
    const draw = async () => {
      GH.clear(host);
      host.append(h('div', { class: 'panel-h' }, h('h2', { id: 'h-scope' }, 'Scope guard'), h('span', { class: 'mute mono' }, 'declared targets are logged in your vault')));
      if (!entitled) { host.append(h('div', { class: 'state sm' }, GH.icon('lock'), h('h2', {}, 'Not switched on for your account'), h('p', {}, 'Active scanning is off until Mayfair switches it on for your account. Everything else in Ghost works.'))); return; }
      let act = []; try { act = await GH.call(GH.api.scope.active); } catch { /* none */ }
      const sc = act[0] || null; state.scopeId = sc ? sc.scopeId : null; state.scopeTarget = sc ? sc.target : null;
      if (sc) host.append(h('div', { class: 'declared' }, h('p', {}, GH.icon('check'), h('span', {}, h('b', {}, 'Target declared: '), h('span', { class: 'mono' }, sc.target), ' (' + (sc.basis === 'own' ? 'you own it' : 'written permission') + ')')), h('p', { class: 'mute sm mono' }, 'Valid until ' + GH.fmtTime(sc.expiresAt) + ' or until Ghost closes')));
      else host.append(h('p', { class: 'mute' }, 'No target is declared. Active tools stay locked until you name one you own or may test.'));
      host.append(h('div', { class: 'row-a' }, GH.btn(sc ? 'Change target…' : 'Declare a target…', { primary: !sc, onclick: async () => { if (await declareDialog()) { await draw(); redraw(true); } } }),
        sc ? GH.btn('Revoke', { onclick: async () => { try { await GH.call(GH.api.scope.revoke, sc.scopeId); } catch (x) { GH.toast(GH.errText(x)); } await draw(); redraw(true); } }) : null,
        GH.btn('Scan log', { icon: 'report', onclick: logDialog })));
    };
    draw(); return host;
  }
  async function declareDialog() {
    const target = h('input', { type: 'text', id: 'sd-target', class: 'mono', placeholder: 'example.org, 203.0.113.5 or 203.0.113.0/28', spellcheck: 'false', autocomplete: 'off', 'data-autofocus': '' });
    const own = h('input', { type: 'radio', name: 'sd-basis', id: 'sd-own', value: 'own', checked: true }), perm = h('input', { type: 'radio', name: 'sd-basis', id: 'sd-perm', value: 'permission' });
    const who = h('input', { type: 'text', id: 'sd-who', placeholder: 'Name or organisation', maxlength: '200' }), when = h('input', { type: 'text', id: 'sd-when', placeholder: 'Date, for example 2026-10-01', maxlength: '100' });
    const whoBox = h('div', { class: 'two-f', hidden: true }, GH.field('Who gave permission', who), GH.field('When', when));
    const ck = GH.chk('I own this target, or I have written permission to test it. I understand the scan is recorded in the log on this computer.', { id: 'sd-ck' });
    const hint = h('p', { class: 'hint', id: 'sd-hint', 'aria-live': 'polite' }, '');
    let dlgEl = null, startBtn = null;
    const check = () => {
      const p = S.parseTarget(target.value); whoBox.hidden = !perm.checked; let why = '';
      if (!target.value.trim()) why = 'Enter the target.'; else if (!p.ok) why = p.reason; else if (perm.checked && who.value.trim().length < 3) why = 'Say who gave you permission.'; else if (!ck.input.checked) why = 'Tick the box to confirm.';
      hint.textContent = target.value.trim() && !p.ok ? p.reason : p.ok ? 'Target: ' + p.value + (p.kind === 'cidr' ? ' (a range of up to 256 addresses)' : '') : ''; target.setAttribute('aria-invalid', target.value.trim() && !p.ok ? 'true' : 'false');
      if (dlgEl) { dlgEl._why.textContent = why; dlgEl._why.className = 'why' + (why && target.value.trim() && !p.ok ? ' err' : ''); startBtn.disabled = !!why; }
      return !why;
    };
    for (const x of [target, own, perm, who, when, ck.input]) { x.addEventListener('input', check); x.addEventListener('change', check); }
    const body = h('div', { class: 'stack' }, GH.field('Target', target, 'One domain, one IP address, or a range no bigger than /24. No wildcards.'), hint,
      h('fieldset', { class: 'fld' }, h('legend', {}, 'Basis'), h('label', { class: 'radio' }, own, h('span', {}, 'I own it')), h('label', { class: 'radio' }, perm, h('span', {}, 'I have written permission')), whoBox), ck.el,
      h('p', { class: 'mute sm' }, 'Ghost scans only the target you name, and only with checks that read information. The declaration is written to your vault with the time and your statement, and lasts 12 hours.'));
    let result = false;
    await GH.dialog({ title: 'Declare a target', sub: 'Active tools send traffic to the target. Only scan what you may.', icon: 'scan', body, width: 620, modal: true,
      actions: [{ label: 'Cancel', value: false }, { label: 'Confirm scope', primary: true, disabled: true, keep: true, onclick: async (close) => {
        try { await GH.call(GH.api.scope.declare, { target: target.value, basis: perm.checked ? 'permission' : 'own', who: perm.checked ? who.value : undefined, when: perm.checked ? when.value : undefined, confirm: ck.input.checked }); result = true; close(true); } catch (x) { dlgEl._why.textContent = GH.errText(x); dlgEl._why.className = 'why err'; } return false; } }],
      onopen: (el) => { dlgEl = el; startBtn = el._actions[1]; startBtn.disabled = true; check(); } });
    return result;
  }
  async function logDialog() {
    let data; try { data = await GH.call(GH.api.scope.log, 200); } catch (x) { GH.toast(GH.errText(x)); return; }
    const v = data.verify;
    const rows = data.entries.length ? data.entries.map((x) => h('tr', {}, h('td', { class: 'mono mute' }, GH.fmtTime(x.t)), h('td', { class: 'mono' }, x.action || '?'), h('td', { class: 'mono' }, x.target || x.connector || ''), h('td', { class: 'mute' }, x.statement || x.result || ''))) : [h('tr', {}, h('td', { colspan: '4', class: 'mute' }, 'Nothing is logged yet.'))];
    return GH.dialog({ title: 'Scan log', sub: 'Kept in your vault. Never sent anywhere.', icon: 'report', width: 760, body: h('div', { class: 'stack' },
      h('p', { class: v.ok ? 'flow-note' : 'flow-note err', role: 'status' }, GH.icon(v.ok ? 'check' : 'alert'), h('span', {}, v.ok ? 'The chain of ' + GH.plural(v.lines, 'line') + ' is intact.' : 'The log was changed: line ' + v.line + '. ' + v.reason)),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Time', 'Action', 'Target', 'Detail'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', {}, rows)))), actions: [{ label: 'Close', primary: true, value: null }] });
  }
})();
