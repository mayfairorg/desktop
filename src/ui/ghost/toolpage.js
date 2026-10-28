'use strict';
// Ghost tool page: the page of ONE tool (not a card). Its own state strip, input form (from what the tool takes and its own options), Run and Cancel,
// live progress, a results table, the raw answer, the runs of this session, "Add to case", and an About drawer.
//   GH.toolPage(toolId, { query?, kind?, run?, results? }) -> HTMLElement      (the element also has .tp: { run, setQuery, reload, focus })
// The first half of this file is plain logic (no page needed) so Node can test it; the second half draws it. The page draws with textContent only.
//
// What the page asks of the app (see docs/ghost-app.md, "Tool pages"):
//   ghostApp.builtins.status()                      -> { tools:[{ id, name, category, inputs, state, note, tested, testNote }], ... }    (optional: the page can work from connectors.get alone)
//   ghostApp.search.run({ query, kind, tools:[id] }) -> { searchId }, then events from ghostApp.onSearch(cb) -> unsubscribe:
//        { searchId, type: 'tool-start'|'tool-result'|'tool-error'|'tool-empty'|'done', tool, results?, error?, ms }
//   ghostApp.search.cancel({ searchId })
//   ghostApp.onBuiltins(cb)                         -> unsubscribe, called when a tool's state changes
//   When the person sets an option or chooses a file, the page uses the existing ghostApp.jobs.run / get / cancel (the tool's own manifest fields) instead.
(function () {
  const logic = (() => {
    const isNode = typeof module === 'object' && module.exports;
    const S = isNode ? require('./scope-parse') : window.GhostScope;
    const MODS = isNode ? require('./modules') : window.GhostModules;
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const clip = (s, n) => { s = String(s === undefined || s === null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

    const KIND_LABEL = { domain: 'Domain', ip: 'IP address', cidr: 'Address range', asn: 'Network number (ASN)', url: 'Web address', 'cert-hash': 'Certificate fingerprint', 'org-name': 'Organisation name', lei: 'Company ID (LEI)', file: 'File', 'place-text': 'Place name', coords: 'Coordinates', keyword: 'Keyword' };
    const KIND_HINT = { domain: 'example.com', ip: '203.0.113.5', cidr: '203.0.113.0/24', asn: 'AS64496', url: 'a full web address, starting with http', 'cert-hash': '64 letters and numbers', 'org-name': 'Example Holdings Ltd', lei: '20 letters and numbers', file: 'choose a file on this computer', 'place-text': 'a site, landmark or town', coords: '51.5074, -0.1278', keyword: 'a word or phrase' };
    const KINDS = Object.keys(KIND_LABEL);
    const NOT_FORM = ['entity', 'rules-file', 'log-file', 'instance-url'];
    const CATEGORY = { domains: 'Domains and networks', companies: 'Companies', files: 'Files and images', places: 'Places', news: 'News', archive: 'Archive', threat: 'Threat intel', scan: 'Active scanning' };
    const CAT_ORDER = ['domains', 'companies', 'files', 'places', 'news', 'archive', 'threat', 'scan'];

    // ----- what the person typed -> what kind of thing it is -----
    // allowed: the kinds this tool takes. -> { kind, value, ok, hint }  kind is what the text looks like (or the tool's best fit for plain words); ok = the tool takes it.
    function guessKind(text, allowed) {
      const t = String(text === undefined || text === null ? '' : text).trim();
      const al = Array.isArray(allowed) ? allowed : [];
      if (!t) return { kind: null, value: '', ok: false, hint: '' };
      const label = (k) => KIND_LABEL[k] || k;
      const list = al.map((k) => label(k).toLowerCase());
      let kind = null, value = t;
      const d = S.detectInput(t);
      if (d.refused) return { kind: null, value: t, ok: false, refused: true, hint: d.reason };
      if (d.kind) { kind = d.kind; value = d.value; }
      else if (d.reason && /^[^\s/@]+\.[^\s/@]+$/.test(t)) return { kind: null, value: t, ok: false, hint: d.reason };
      else {
        const c = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(t);
        if (c && Math.abs(+c[1]) <= 90 && Math.abs(+c[2]) <= 180) { kind = 'coords'; value = +c[1] + ', ' + +c[2]; }
        else if (/^[A-Z0-9]{20}$/.test(t) && /\d/.test(t)) { kind = 'lei'; value = t; }
        else { kind = ['org-name', 'place-text', 'keyword'].find((k) => al.includes(k)) || 'keyword'; }
      }
      const ok = al.length === 0 || al.includes(kind);
      return { kind, value, ok, hint: ok ? '' : 'That looks like ' + (/^(ip|a|e|i|o|u)/i.test(label(kind)) && !/^(un|uni)/i.test(label(kind)) ? 'an ' : 'a ') + (kind === 'ip' ? label(kind) : label(kind).toLowerCase()) + '. This tool takes ' + (list.join(', ') || 'something else') + '.' };
    }

    // ----- the state of a tool, in plain words -----
    const STATE_LABEL = { ready: 'Ready', running: 'Running', 'needs-program': 'Needs a program', off: 'Off', failed: 'Failed', 'setting-up': 'Getting ready' };
    const missingNames = (entry) => ((entry && entry.install && entry.install.requirements) || []).filter((r) => r && r.status !== 'ok' && r.status !== 'untested').map((r) => r.name);
    // tool: the app's status line for this tool (or null), entry: the connector's own entry (or null).
    // -> { state, label, line, canRun }   line is ONE plain sentence, or '' when there is nothing to say.
    function statusOf({ tool, entry, running }) {
      if (!tool && !entry) return { state: 'failed', label: STATE_LABEL.failed, line: 'This tool is not installed on this computer.', canRun: false };
      let state = tool && STATE_LABEL[tool.state] && tool.state !== 'running' ? tool.state : null, line = '';
      const miss = missingNames(entry);
      if (!state) {
        if (entry && entry.health === 'broken') { state = 'failed'; line = 'Its files are missing or not valid.'; }
        else if (miss.length) state = 'needs-program';
        else if (entry && entry.state === 'enabled') state = 'ready';
        else if (entry && entry.state === 'not-approved') { state = 'off'; line = 'It has not been approved yet. Approve it in Tool Integrations.'; }
        else state = 'off';
      }
      if (state === 'needs-program') line = (tool && tool.note) || (miss.length ? 'Needs ' + miss.join(' and ') + ', which ' + (miss.length === 1 ? 'is' : 'are') + ' not on this computer. It works as soon as ' + (miss.length === 1 ? 'it is' : 'they are') + ' there.' : 'Needs a program that is not on this computer.');
      else if (state === 'failed') line = line || (tool && (tool.note || tool.testNote)) || 'It could not be set up.';
      else if (state === 'off') line = line || 'This tool is switched off.';
      else if (state === 'setting-up') line = (tool && tool.note) || 'Getting ready. This takes a moment.';
      if (running && state === 'ready') return { state: 'running', label: STATE_LABEL.running, line: '', canRun: false };
      return { state, label: STATE_LABEL[state], line, canRun: state === 'ready' };
    }
    // The last self-test, as one honest line. A failed test never blocks use; it is only reported.
    function testNote({ tool, entry }) {
      const lt = entry && entry.install && entry.install.lastTest;
      let v = tool && tool.tested;
      if (!v) v = entry && entry.install ? (entry.install.verified === 'tested' ? 'tested' : entry.install.verified === 'failed' ? 'failed' : 'pending') : 'pending';
      if (v === 'tested') return { tone: 'ok', kind: 'tested', time: lt && lt.t || '', text: 'Self-test passed' };
      if (v === 'failed') return { tone: 'bad', kind: 'failed', time: lt && lt.t || '', text: 'Self-test failed: ' + clip((tool && tool.testNote) || (lt && lt.detail) || 'no reason was recorded', 240) };
      return { tone: 'mute', kind: 'pending', time: '', text: 'Self-test has not run yet' };
    }
    function categoryOf(id, tool) {
      if (tool && tool.category) return tool.category;
      for (const mid of CAT_ORDER) { const m = MODS.byId(mid); if (m && m.wants.some((w) => w[0] === id)) return CATEGORY[mid]; }
      return 'Other tools';
    }
    const fieldsOf = (entry) => (entry && entry.input && Array.isArray(entry.input.fields) ? entry.input.fields : []);
    // The kinds the form offers: what the app says the tool takes; without that, what the modules list and the manifest allow.
    function inputKindsOf(tool, entry) {
      let k = tool && Array.isArray(tool.inputs) ? tool.inputs.slice() : null;
      if (!k || !k.length) {
        k = []; for (const m of MODS.MODULES) if (m.wants.some((w) => entry && w[0] === entry.id)) for (const x of m.inputs) if (!k.includes(x)) k.push(x);
        const hasFile = fieldsOf(entry).some((f) => f.type === 'file');
        k = k.filter((x) => x !== 'file'); if (hasFile) k.push('file');
        if (!k.length) k = hasFile ? ['file'] : ['keyword'];
      }
      return k.filter((x) => KINDS.includes(x) && !NOT_FORM.includes(x));
    }
    // ----- the tool's own fields -----
    function mainField(fields, kind) {
      if (kind === 'file') return fields.find((f) => f.type === 'file') || null;
      const strs = fields.filter((f) => f.type === 'string' || f.type === 'url-host');
      return strs.find((f) => f.required !== false) || strs[0] || null;
    }
    const optionFields = (fields, main) => fields.filter((f) => f !== main && !(f.type === 'file' && main && main.type !== 'file') && f.type !== 'file');
    const ENUM_FOR = { domain: ['domain'], 'org-name': ['organisation', 'organization', 'name', 'org'], lei: ['lei'], 'place-text': ['place', 'geocode'], coords: ['reverse'], keyword: ['topic', 'keyword'], url: ['url'], ip: ['ip'], asn: ['asn'] };
    function pickEnum(f, kind) { const vals = f.values || []; for (const c of ENUM_FOR[kind] || []) if (vals.includes(c)) return c; return vals[0]; }
    // The input for jobs.run: the main field gets the value (or the file token), options the person set keep their value, and a required list is chosen to suit the kind.
    function buildJobInput(fields, { kind, value, fileToken, options }) {
      const out = {}, opts = options || {}, main = mainField(fields, kind);
      if (main) out[main.name] = main.type === 'file' ? fileToken : value;
      for (const f of fields) {
        if (f === main) continue;
        const v = opts[f.name];
        if (v !== undefined && v !== '') { out[f.name] = f.type === 'integer' ? Number(v) : v; continue; }
        if (f.required === false) continue;
        if (f.type === 'enum') out[f.name] = pickEnum(f, kind);
        else if (f.type === 'integer') out[f.name] = f.min;
      }
      return out;
    }
    const optionsText = (options) => Object.entries(options || {}).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => k + ' ' + v).join(', ');

    // ----- one run of one tool -----
    // deps: { api:{ hasSearch, searchRun(o), searchCancel(id), onSearch(cb)->off, jobsRun(o), jobsGet(id), jobsCancel(id) }, now(), sleep(ms) }
    // req:  { tool, mode:'search'|'job', query, kind, input (for 'job'), onProgress({message, progress}) }
    // -> { promise -> { status:'done'|'empty'|'error'|'cancelled', results, error, ms, rejected, truncated, mode }, cancel() }
    function startRun(deps, req) {
      const now = deps.now || Date.now, sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms))), api = deps.api, t0 = now();
      const say = (m) => { if (req.onProgress) { try { req.onProgress(m); } catch { /* the page's own handler failed */ } } };
      let cancelled = false, cancelNow = null;
      const fin = (o) => ({ results: [], error: '', rejected: 0, truncated: false, mode: req.mode, ms: now() - t0, ...o });
      const viaSearch = async () => {
        let id = null, off = null, settle = null, got = null;
        const buf = [], done = new Promise((r) => { settle = r; });
        const handle = (ev) => {
          if (!ev || ev.searchId !== id) return;
          if (ev.type === 'tool-start') say({ message: 'Asking ' + (req.name || req.tool) });
          else if (ev.type === 'tool-result' && (!ev.tool || ev.tool === req.tool)) { const r = Array.isArray(ev.results) ? ev.results : []; got = fin({ status: r.length ? 'done' : 'empty', results: r, truncated: !!ev.truncated, ms: Number.isFinite(ev.ms) ? ev.ms : now() - t0 }); }
          else if (ev.type === 'tool-empty' && (!ev.tool || ev.tool === req.tool)) got = fin({ status: 'empty', ms: Number.isFinite(ev.ms) ? ev.ms : now() - t0 });
          else if (ev.type === 'tool-error' && (!ev.tool || ev.tool === req.tool)) got = fin({ status: 'error', state: ev.state || '', error: String(ev.error || ev.note || 'The tool reported an error without saying why.'), ms: Number.isFinite(ev.ms) ? ev.ms : now() - t0 });
          if (typeof ev.progress === 'number' || ev.message) say({ progress: ev.progress, message: ev.message });
          if (ev.type === 'done') settle(true);
        };
        try {
          off = api.onSearch((ev) => { if (id === null) buf.push(ev); else handle(ev); });
          const r = await api.searchRun({ query: req.searchQuery !== undefined ? req.searchQuery : req.query, kind: req.kind, tools: [req.tool] });
          id = r && r.searchId;
          if (!id) return fin({ status: 'error', error: 'The app did not start the search.' });
          cancelNow = () => api.searchCancel(id);
          if (cancelled) { try { await cancelNow(); } catch { /* it may already be over */ } return fin({ status: 'cancelled' }); }
          for (const ev of buf.splice(0)) handle(ev);
          await Promise.race([done, new Promise((res) => { cancelNow.abort = res; })]);
          if (cancelled) return fin({ status: 'cancelled' });
          return got || fin({ status: 'error', error: 'The search finished without an answer from this tool.' });
        } finally { if (typeof off === 'function') off(); }
      };
      const viaJob = async () => {
        const r = await api.jobsRun({ connector: req.tool, input: req.input });
        const jobId = r && r.jobId;
        if (!jobId) return fin({ status: 'error', error: 'The app did not start the job.' });
        cancelNow = () => api.jobsCancel(jobId);
        if (cancelled) { try { await cancelNow(); } catch { /* it may already be over */ } return fin({ status: 'cancelled' }); }
        for (;;) {
          let job; try { job = await api.jobsGet(jobId); } catch (e) { return fin({ status: 'error', error: String((e && e.message) || 'The job could not be read.') }); }
          if (cancelled) return fin({ status: 'cancelled' });
          if (!job) return fin({ status: 'error', error: 'The job was not found.' });
          if (job.status === 'queued' || job.status === 'running') { say({ progress: job.progress, message: job.status === 'queued' ? 'Waiting in line' : job.message }); await sleep(500); continue; }
          const results = Array.isArray(job.results) ? job.results : [], n = job.resultCount || results.length;
          if (job.status === 'done') return fin({ status: n ? 'done' : 'empty', results, rejected: job.rejected || 0, truncated: !!job.resultsTruncated });
          if (job.status === 'cancelled') return fin({ status: 'cancelled', results });
          if (job.status === 'timed-out') return fin({ status: 'error', error: 'It took too long and was stopped.', results });
          return fin({ status: 'error', error: String(job.message || 'The tool reported an error without saying why.'), results });
        }
      };
      const promise = (async () => { try { return await (req.mode === 'search' ? viaSearch() : viaJob()); } catch (e) { return fin({ status: cancelled ? 'cancelled' : 'error', error: cancelled ? '' : String((e && e.message) || 'That did not work.') }); } })();
      return { promise, cancel: async () => { cancelled = true; if (cancelNow) { try { await cancelNow(); } catch { /* it may already be over */ } if (cancelNow.abort) cancelNow.abort(true); } } };
    }

    // ----- the runs of this session (memory only) -----
    const HIST_MAX = 20;
    function History() { const m = new Map(); return { add(tool, rec) { const l = m.get(tool) || []; l.unshift(rec); if (l.length > HIST_MAX) l.length = HIST_MAX; m.set(tool, l); return rec; }, list: (tool) => (m.get(tool) || []).slice(), clear: (tool) => { if (tool) m.delete(tool); else m.clear(); } }; }
    const outcomeText = (r) => ({ done: 'Found ' + r.count, empty: 'Nothing found', error: 'Failed', cancelled: 'Cancelled' })[r.status] || r.status;
    return { KIND_LABEL, KIND_HINT, KINDS, STATE_LABEL, guessKind, statusOf, testNote, categoryOf, inputKindsOf, mainField, optionFields, buildJobInput, pickEnum, optionsText, startRun, History, outcomeText, fieldsOf, missingNames };
  })();

  if (typeof module === 'object' && module.exports) module.exports = logic;
  if (typeof window === 'undefined' || !window.GH) return;

  // ================= the page part =================
  const GH = window.GH, h = GH.h, L = logic, M = window.GhostCase, SC = window.GhostScope;
  GH.toolHistory = GH.toolHistory || L.History();
  let seq = 0;

  // What the app offers, looked up each time so a test can swap GH.api.
  GH.toolApi = function toolApi() {
    const A = GH.api || {}, S = A.search || {}, J = A.jobs || {}, B = A.builtins || {}, C = A.connectors || {};
    const on = A.onSearch || S.on || null;
    return {
      hasSearch: !!(S.run && S.cancel && on),
      builtinsStatus: B.status ? () => GH.call(B.status) : null,
      onBuiltins: A.onBuiltins || B.on || null,
      onSearch: on ? (cb) => on(cb) : null,
      searchRun: (o) => GH.call(S.run, o), searchCancel: (id) => GH.call(S.cancel, { searchId: id }),
      jobsRun: (o) => GH.call(J.run, o), jobsGet: (id) => GH.call(J.get, id), jobsCancel: (id) => GH.call(J.cancel, id),
      connGet: (id) => GH.call(C.get, id), connTest: (id) => GH.call(C.test, id), connEnable: (id) => GH.call(C.enable, id), connDisable: (id) => GH.call(C.disable, id),
      pickFile: () => GH.call(A.pickFile),
    };
  };
  const NET = { local: ['Nothing leaves this computer', 'This tool works on this computer only.'], 'keyless-external': ['An outside service, no account needed', 'It sends what you type to a public service.'], 'rate-limited': ['An outside service with limits', 'It sends what you type to a public service, and Ghost keeps to that service\'s fair-use rule.'], unavailable: ['Not available right now', 'The service it needs cannot be used right now.'] };
  const SCOPE_TEXT = { local: 'Local: reads only what you give it.', passive: 'Passive: asks public services and never touches the target itself.', 'passive-local': 'Works on what you give it, on this computer.', active: 'Active: talks to the target itself. Only against a target you declared.' };
  const TAB_IDS = ['results', 'raw', 'history'];
  const when = (iso) => (iso ? GH.fmtTime(iso) : '');

  GH.toolPage = function toolPage(toolId, opts) {
    const o = opts || {}, uid = 'tp' + (++seq), id = String(toolId || '');
    const S = { tool: null, entry: null, all: null, entryErr: '', statusErr: '', kinds: [], kind: null, kindManual: false, file: null, options: {}, running: null, view: null, tab: 'results', selected: [], loading: true, busy: false, msg: '', msgBad: false, drawer: null, name: id, tick: null };
    const root = h('section', { class: 'view tp', dataset: { tool: id }, 'aria-labelledby': uid + '-h' });
    const offs = [];
    const live = () => root.isConnected;
    const ad = () => GH.toolApi();

    // ---------- loading ----------
    async function load() {
      const a = ad();
      const [st, en] = await Promise.all([
        a.builtinsStatus ? a.builtinsStatus().then((r) => ({ r }), (e) => ({ e })) : Promise.resolve({}),
        a.connGet(id).then((r) => ({ r }), (e) => ({ e })),
      ]);
      S.all = st.r || null; S.statusErr = st.e ? GH.errText(st.e) : '';
      S.tool = st.r && Array.isArray(st.r.tools) ? st.r.tools.find((t) => t.id === id) || null : null;
      S.entry = en.r || null; S.entryErr = en.e ? GH.errText(en.e) : '';
      S.name = (S.tool && S.tool.name) || (S.entry && S.entry.name) || id;
      S.kinds = S.entry || S.tool ? L.inputKindsOf(S.tool, S.entry) : [];
      if (!S.kind || !S.kinds.includes(S.kind)) S.kind = S.kinds[0] || null;
      S.loading = false;
    }

    // ---------- header, state, banner ----------
    const head = h('header', { class: 'tp-head' }), banner = h('div', { class: 'tp-banner', hidden: true }), msg = h('p', { class: 'tp-msg', role: 'status', hidden: true });
    function status() { return S.loading ? { state: 'setting-up', label: 'Loading', line: '', canRun: false } : L.statusOf({ tool: S.tool, entry: S.entry, running: !!S.running }); }
    function drawHead() {
      GH.clear(head);
      const st = status(), tn = L.testNote({ tool: S.tool, entry: S.entry }), e = S.entry || {};
      const cat = L.categoryOf(id, S.tool);
      const canToggle = !!S.entry && (st.state === 'ready' || st.state === 'off' || st.state === 'running') && e.scope !== 'active';
      head.append(
        h('div', { class: 'tp-title' }, h('p', { class: 'eyebrow mono' }, cat), h('h1', { id: uid + '-h' }, S.name), h('p', { class: 'mono mute sm tp-id' }, id + (e.version ? '  v' + e.version : ''))),
        h('div', { class: 'tp-badges' }, h('span', { class: 'tp-badge', dataset: { state: st.state }, role: 'status' }, st.label),
          h('span', { class: 'tp-test ' + tn.tone, dataset: { test: tn.kind } }, tn.text + (tn.time ? ' on ' + when(tn.time) : '')),
        h('div', { class: 'tp-tools' },
          GH.btn('About this tool', { cls: 'tp-about-btn', onclick: (ev) => openAbout(ev.currentTarget) }),
          canToggle ? GH.btn(st.state === 'off' ? 'Switch on' : 'Switch off', { cls: 'tp-toggle', disabled: S.busy || !!S.running, onclick: toggle }) : null,
          S.entry && e.scope !== 'active' && st.state !== 'setting-up' && st.state !== 'needs-program' ? GH.btn('Test again', { cls: 'tp-retest', disabled: S.busy || !!S.running, onclick: retest }) : null)),
        e.description ? h('p', { class: 'tp-desc' }, e.description) : null);
      // the one plain line for a tool that cannot run
      const bt = st.line || (S.entryErr && !S.entry ? S.entryErr : '');
      banner.hidden = !bt; banner.textContent = bt;
      banner.className = 'tp-banner ' + (st.state === 'failed' || (!st.line && bt) ? 'bad' : 'warn'); banner.dataset.state = st.state;
      banner.setAttribute('role', st.state === 'failed' || (!st.line && bt) ? 'alert' : 'status');
      msg.hidden = !S.msg; msg.textContent = S.msg; msg.className = 'tp-msg' + (S.msgBad ? ' bad' : '');
      syncForm();
    }
    async function toggle() {
      const st = status(); S.busy = true; S.msg = ''; drawHead();
      try { await (st.state === 'off' ? ad().connEnable(id) : ad().connDisable(id)); S.msg = st.state === 'off' ? 'Switched on.' : 'Switched off.'; S.msgBad = false; }
      catch (e) { S.msg = GH.errText(e); S.msgBad = true; }
      GH.conn && GH.conn.bust && GH.conn.bust(); await refresh(); S.busy = false; drawHead(); GH.say(S.msg);
    }
    async function retest() {
      S.busy = true; S.msg = 'Testing…'; S.msgBad = false; drawHead();
      try { const r = await ad().connTest(id); S.msg = r && r.passed === false ? 'The self-test failed: ' + (r.detail || 'no reason was recorded') + '.' : 'The self-test passed.'; S.msgBad = !!(r && r.passed === false); }
      catch (e) { S.msg = GH.errText(e); S.msgBad = true; }
      GH.conn && GH.conn.bust && GH.conn.bust(); await refresh(); S.busy = false; drawHead(); GH.say(S.msg);
    }
    async function refresh() { try { await load(); } catch { /* keep what is shown */ } if (live()) { drawHead(); if (S.drawer) fillAbout(); } }

    // ---------- the form ----------
    const form = h('form', { class: 'tp-form', autocomplete: 'off', novalidate: true, onsubmit: (ev) => { ev.preventDefault(); doRun(); } });
    const fs = h('fieldset', { class: 'tp-fs' });
    const kindSel = h('select', { id: uid + '-kind', onchange: () => { S.kind = kindSel.value; S.kindManual = true; S.file = null; drawFormBits(); } });
    const valueIn = h('input', { type: 'text', id: uid + '-q', class: 'mono tp-q', maxlength: '2000', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': uid + '-under', oninput: () => { onType(); } });
    const under = h('p', { class: 'tp-under mono sm', id: uid + '-under', 'aria-live': 'polite' });
    const err = h('p', { class: 'hint err tp-err', role: 'alert', hidden: true });
    const fileName = h('span', { class: 'mono sm tp-filename' }, 'No file chosen');
    const fileBtn = GH.btn('Choose a file…', { cls: 'tp-choose', onclick: chooseFile });
    const drop = h('div', { class: 'tp-drop', tabindex: '-1' }, h('span', {}, 'Drop a file here, or '), fileBtn, fileName);
    const optHost = h('details', { class: 'tp-opts' });
    const runBtn = GH.btn('Run', { primary: true, type: 'submit', cls: 'tp-run' });
    const cancelBtn = GH.btn('Cancel', { cls: 'tp-cancel', onclick: () => cancelRun() });
    const prog = h('div', { class: 'tp-prog', role: 'status', 'aria-live': 'polite', hidden: true });
    const progText = h('span', { class: 'tp-prog-t mono sm' }), progBar = h('progress', { class: 'tp-bar', max: '1', 'aria-label': 'Progress' });
    prog.append(progBar, progText);
    form.append(fs);
    fs.append(h('div', { class: 'tp-inrow' },
      h('div', { class: 'fld tp-kindf' }, h('label', { for: uid + '-kind' }, 'What you are looking up'), kindSel),
      h('div', { class: 'fld tp-valf' }, h('label', { for: uid + '-q' }, 'Look up'), valueIn, drop),
      h('div', { class: 'tp-act' }, runBtn, cancelBtn),
    ), under, optHost, err);
    cancelBtn.hidden = true;

    function drawFormBits() {
      const k = S.kind, isFile = k === 'file';
      GH.clear(kindSel); for (const x of S.kinds) kindSel.append(h('option', { value: x, selected: x === k }, L.KIND_LABEL[x] || x)); kindSel.value = k || '';
      kindSel.disabled = S.kinds.length < 2; kindSel.closest('.tp-kindf').hidden = S.kinds.length < 2;
      valueIn.hidden = isFile; drop.hidden = !isFile; valueIn.placeholder = L.KIND_HINT[k] || '';
      fileName.textContent = S.file ? S.file.name + (S.file.size !== undefined ? ' (' + Math.max(1, Math.ceil(S.file.size / 1024)) + ' KB)' : '') : 'No file chosen';
      const lbl = valueIn.closest('.tp-valf').querySelector('label'); lbl.textContent = isFile ? 'File' : 'Look up';
      onType(true); drawOptions(); syncForm();
    }
    function onType(quiet) {
      const t = valueIn.value; err.hidden = true;
      if (S.kind === 'file') { under.textContent = S.kinds.length > 1 ? '' : 'Takes a file from this computer. Files never leave it.'; return; }
      if (!t.trim()) { under.textContent = S.kinds.length === 1 ? 'Takes: ' + (L.KIND_LABEL[S.kinds[0]] || S.kinds[0]).toLowerCase() + '.' : ''; syncForm(); return; }
      const g = L.guessKind(t, S.kinds.filter((x) => x !== 'file'));
      if (g.refused) { under.textContent = ''; err.hidden = false; err.textContent = g.hint; syncForm(); return; }
      if (!S.kindManual && g.kind && g.ok && S.kinds.includes(g.kind)) { S.kind = g.kind; if (kindSel.value !== g.kind) { kindSel.value = g.kind; drawOptions(); } }
      const showKind = S.kind;
      under.textContent = g.hint && !S.kindManual ? g.hint : 'Understood as ' + (L.KIND_LABEL[showKind] || showKind) + ': ' + (g.kind === showKind ? g.value : t.trim());
      syncForm();
    }
    function drawOptions() {
      const fields = L.fieldsOf(S.entry), main = L.mainField(fields, S.kind), list = L.optionFields(fields, main);
      GH.clear(optHost); optHost.hidden = list.length === 0; if (!list.length) return;
      const n = Object.values(S.options).filter((v) => v !== '' && v !== undefined).length;
      optHost.append(h('summary', {}, 'Options' + (n ? ' (' + n + ' set)' : '')), h('p', { class: 'hint' }, 'Leave a box on Automatic and the tool picks what suits what you typed.'));
      const grid = h('div', { class: 'tp-optgrid' });
      for (const f of list) {
        const fid = uid + '-o-' + f.name, label = (f.label || f.name) + (f.sensitive ? ' (not written to logs)' : '');
        let ctl;
        if (f.type === 'enum') { ctl = h('select', { id: fid }, h('option', { value: '' }, 'Automatic'), (f.values || []).map((v) => h('option', { value: v, selected: S.options[f.name] === v }, v))); }
        else if (f.type === 'integer') ctl = h('input', { id: fid, type: 'number', min: f.min, max: f.max, placeholder: 'Automatic', value: S.options[f.name] === undefined ? '' : String(S.options[f.name]) });
        else ctl = h('input', { id: fid, type: f.sensitive ? 'password' : 'text', maxlength: String(f.maxLength || 4096), autocomplete: 'off', spellcheck: 'false', placeholder: f.required === false ? 'Automatic' : '', value: S.options[f.name] || '' });
        ctl.addEventListener('input', () => { const v = ctl.value; if (v === '') delete S.options[f.name]; else S.options[f.name] = v; const k = Object.keys(S.options).length; optHost.querySelector('summary').textContent = 'Options' + (k ? ' (' + k + ' set)' : ''); });
        ctl.addEventListener('change', () => ctl.dispatchEvent(new Event('input')));
        grid.append(GH.field(label, ctl));
      }
      optHost.append(grid);
    }
    function syncForm() {
      const st = status(), run = !!S.running;
      fs.disabled = !st.canRun && !run ? true : false;
      runBtn.disabled = !st.canRun || run; runBtn.hidden = false; cancelBtn.hidden = !run;
      const idle = !st.canRun && !run, none = idle && !S.view && history().length === 0;
      form.hidden = S.loading || idle; fs.hidden = S.loading; tabbar.hidden = none; panel.hidden = none;
      runBtn.title = !st.canRun && !run ? (st.line || 'This tool cannot run right now.') : '';
      for (const el of [kindSel, valueIn]) el.disabled = run || (el === kindSel && S.kinds.length < 2) || !st.canRun;
      fileBtn.disabled = run || !st.canRun;
    }
    async function chooseFile() {
      try { const p = await ad().pickFile(); if (p) { S.file = p; fileName.textContent = p.name + (p.size !== undefined ? ' (' + Math.max(1, Math.ceil(p.size / 1024)) + ' KB)' : ''); err.hidden = true; } }
      catch (e) { err.hidden = false; err.textContent = GH.errText(e); }
    }
    // Dropping a file gives the page no path it may use, so the drop opens the same chooser. The page says so instead of pretending the file was read.
    drop.addEventListener('dragover', (ev) => { ev.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (ev) => { ev.preventDefault(); drop.classList.remove('over'); under.textContent = 'A dropped file cannot be read directly. Choose it in the window that opens.'; if (!fileBtn.disabled) chooseFile(); });

    // ---------- running ----------
    const history = () => GH.toolHistory.list(id);
    function setProgress(m) {
      if (!S.running) return;
      if (m && m.message) S.running.message = String(m.message);
      if (m && typeof m.progress === 'number' && Number.isFinite(m.progress)) S.running.progress = Math.max(0, Math.min(1, m.progress));
      drawProg();
    }
    function drawProg() {
      const r = S.running; prog.hidden = !r; if (!r) return;
      const s = Math.max(0, Math.round((Date.now() - r.t0) / 1000));
      progText.textContent = (r.message || 'Running') + ' · ' + s + ' s';
      if (typeof r.progress === 'number' && r.progress > 0) progBar.value = r.progress; else progBar.removeAttribute('value');
    }
    async function doRun(auto) {
      if (S.running) return;
      const st = status(); if (!st.canRun) return;
      err.hidden = true;
      const fields = L.fieldsOf(S.entry), isFile = S.kind === 'file';
      let value = valueIn.value.trim(), kind = S.kind;
      if (isFile) { if (!S.file) { err.hidden = false; err.textContent = 'Choose a file first.'; return; } value = S.file.name; }
      else {
        if (!value) { err.hidden = false; err.textContent = 'Type something to look up.'; valueIn.focus(); return; }
        const pr = SC && SC.refusePersonQuery ? SC.refusePersonQuery(value) : { refused: false };
        if (pr.refused) { err.hidden = false; err.textContent = pr.reason; return; }
        const g = L.guessKind(value, S.kinds.filter((x) => x !== 'file'));
        if (g.kind === kind) value = g.value;
      }
      const opt = { ...S.options }, a = ad();
      // Through the master-search path only when the app maps this tool to the kind (its status says so) and no option was set; otherwise its own job.
      const viaSearch = a.hasSearch && !!(S.tool && Array.isArray(S.tool.inputs) && S.tool.inputs.includes(kind)) && Object.keys(opt).length === 0 && (!isFile || !!(S.file && S.file.token));
      const req = { tool: id, name: S.name, mode: viaSearch ? 'search' : 'job', query: value, searchQuery: isFile ? S.file.token : value, kind, onProgress: setProgress };
      if (!viaSearch) req.input = L.buildJobInput(fields, { kind, value, fileToken: S.file && S.file.token, options: opt });
      const handle = L.startRun({ api: a }, req);
      S.running = { t0: Date.now(), message: 'Starting', progress: 0, cancel: handle.cancel }; S.msg = ''; drawHead(); drawProg();
      clearInterval(S.tick); S.tick = setInterval(() => { if (!live()) { clearInterval(S.tick); return; } drawProg(); }, 500);
      GH.say('Running ' + S.name);
      const out = await handle.promise;
      clearInterval(S.tick); S.tick = null; S.running = null;
      const results = out.results || [];
      const rec = GH.toolHistory.add(id, { id: 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: new Date().toISOString(), query: value, kind, optionsText: L.optionsText(opt), count: results.length, ms: out.ms, status: out.status, error: out.error || '', results, rejected: out.rejected || 0, truncated: !!out.truncated, mode: out.mode });
      S.view = rec; S.selected = []; S.tab = 'results'; drawHead(); drawProg(); drawTabs();
      GH.say(out.status === 'done' ? 'Found ' + GH.plural(results.length, 'result') + '.' : out.status === 'empty' ? 'Nothing found.' : out.status === 'cancelled' ? 'Cancelled.' : 'Failed: ' + out.error);
    }
    async function cancelRun() { if (S.running) { cancelBtn.disabled = true; try { await S.running.cancel(); } finally { cancelBtn.disabled = false; } } }

    // ---------- results, raw, history ----------
    const tabbar = h('div', { class: 'tp-tabs', role: 'tablist', 'aria-label': 'Results, raw answer and history' });
    const panel = h('div', { class: 'tp-panel', role: 'tabpanel', tabindex: '-1' });
    const isAccount = (r) => !!(r && r.entity && M && M.isAccountKind(r.entity.type));
    const shownOf = (rec) => (rec ? rec.results.filter((r) => !isAccount(r)) : []);
    function drawTabs() {
      const rec = S.view, n = rec ? shownOf(rec).length : 0, hl = history().length;
      GH.clear(tabbar);
      const defs = [['results', 'Results' + (rec && rec.status !== 'error' ? ' (' + n + ')' : '')], ['raw', 'Raw'], ['history', 'History' + (hl ? ' (' + hl + ')' : '')]];
      for (const [t, label] of defs) tabbar.append(h('button', { type: 'button', role: 'tab', id: uid + '-t-' + t, class: 'tp-tab', 'aria-selected': S.tab === t ? 'true' : 'false', tabindex: S.tab === t ? '0' : '-1', 'aria-controls': uid + '-p', dataset: { tab: t }, onclick: () => { S.tab = t; drawTabs(); }, onkeydown: tabKey }, label));
      panel.setAttribute('aria-labelledby', uid + '-t-' + S.tab); panel.id = uid + '-p';
      drawPanel();
    }
    function tabKey(ev) {
      const i = TAB_IDS.indexOf(S.tab); let to = null;
      if (ev.key === 'ArrowRight') to = (i + 1) % 3; else if (ev.key === 'ArrowLeft') to = (i + 2) % 3; else if (ev.key === 'Home') to = 0; else if (ev.key === 'End') to = 2;
      if (to === null) return; ev.preventDefault(); S.tab = TAB_IDS[to]; drawTabs(); tabbar.querySelector('[aria-selected=true]').focus();
    }
    function drawPanel() { GH.clear(panel); (S.tab === 'raw' ? drawRaw : S.tab === 'history' ? drawHistory : drawResults)(); }

    let addBusy = false;
    async function addToCase(list, label) {
      if (addBusy || !list.length || !S.view) return; addBusy = true; if (S.syncBar) S.syncBar();
      try {
        const rec = S.view, e = S.entry || { id, version: '' };
        const qk = rec.kind, q = ({ 'org-name': 'org', lei: 'org', 'place-text': 'place' })[qk] || qk;
        const query = ['domain', 'ip', 'asn', 'url', 'cert-hash', 'org', 'place'].includes(q) && rec.query ? { kind: q, value: rec.query } : null;
        await GH.cs.addResults({ connector: e, query, results: list });
      } catch (x) { GH.toast(GH.errText(x)); }
      addBusy = false; if (S.syncBar) S.syncBar();
    }
    function drawResults() {
      const rec = S.view;
      if (!rec) {
        panel.append(h('div', { class: 'tp-empty' }, h('p', {}, S.loading ? 'Loading…' : status().canRun ? 'Nothing has been run yet. Type what to look up above and press Run.' : 'Nothing to show: this tool cannot run right now.')));
        return;
      }
      const list = shownOf(rec), hidden = rec.results.length - list.length;
      const line = h('p', { class: 'tp-sum ' + rec.status, role: rec.status === 'error' ? 'alert' : 'status', dataset: { status: rec.status } });
      const what = rec.query + (rec.optionsText ? ' (' + rec.optionsText + ')' : '');
      if (rec.status === 'done') line.textContent = 'Found ' + GH.plural(list.length, 'result') + ' for ' + what + ' in ' + rec.ms + ' ms' + (rec.truncated ? '. Showing the first ' + list.length : '') + '.';
      else if (rec.status === 'empty') line.textContent = 'Nothing found for ' + what + '. That does not prove nothing is there.';
      else if (rec.status === 'cancelled') line.textContent = 'Cancelled. Nothing was kept.';
      else line.textContent = 'It failed: ' + String(rec.error || 'no reason was given').replace(/[.\s]+$/, '') + '.';
      panel.append(line);
      if (rec.rejected) panel.append(h('p', { class: 'hint' }, GH.plural(rec.rejected, 'line') + ' from the tool could not be read and were left out.'));
      if (hidden) panel.append(h('p', { class: 'flow-note tp-withheld' }, GH.icon('lock'), h('span', {}, GH.plural(hidden, 'result') + ' withheld: Ghost does not show or store usernames, phone numbers, accounts or face data.')));
      if (!list.length) return;
      S.selected = [];
      const bar = h('div', { class: 'tp-addbar row-a' },
        GH.btn('Add selected to case', { cls: 'tp-add-sel', icon: 'plus', disabled: true, onclick: () => addToCase(S.selected.slice()) }),
        GH.btn('Add all (' + list.length + ')', { cls: 'tp-add-all', primary: true, icon: 'plus', disabled: addBusy, onclick: () => addToCase(list) }));
      const syncBar = () => { const n = S.selected.length, b = bar.querySelector('.tp-add-sel'), a = bar.querySelector('.tp-add-all'); b.disabled = !n || addBusy; b.querySelector('span').textContent = 'Add selected to case' + (n ? ' (' + n + ')' : ''); a.disabled = addBusy; };
      S.syncBar = syncBar;
      const names = {}; names[id] = S.name; if (S.entry) names[S.entry.id] = S.name;
      const table = GH.resultTable(list, { names, caption: S.name + ' results', onSelect: (s) => { S.selected = s; syncBar(); } });
      panel.append(bar, table);
    }
    function drawRaw() {
      const rec = S.view;
      if (!rec) { panel.append(h('div', { class: 'tp-empty' }, h('p', {}, 'Nothing to show yet. The raw answer appears here after a run.'))); return; }
      let text; try { text = JSON.stringify({ tool: id, query: rec.query, kind: rec.kind, ranAt: rec.at, ms: rec.ms, status: rec.status, ...(rec.error ? { error: rec.error } : {}), results: rec.results }, null, 2); } catch { text = 'The answer could not be shown as text.'; }
      const MAX = 400000;
      panel.append(h('div', { class: 'tp-rawbar row-a' }, GH.btn('Copy', { cls: 'tp-copyraw', onclick: () => GH.copy(text) }), h('span', { class: 'mute sm' }, text.length > MAX ? 'Showing the first ' + MAX.toLocaleString() + ' characters. Copy gives you all of it.' : GH.plural(rec.results.length, 'result') + ', exactly as the tool returned them.')),
        h('pre', { class: 'tp-raw mono', tabindex: '0', 'aria-label': 'Raw answer' }, text.length > MAX ? text.slice(0, MAX) : text));
    }
    function drawHistory() {
      const list = history();
      if (!list.length) { panel.append(h('div', { class: 'tp-empty' }, h('p', {}, 'No runs yet in this session. Runs are kept in memory and gone when you close Ghost.'))); return; }
      const rows = list.map((r) => h('tr', { class: S.view === r ? 'cur' : '' },
        h('td', { class: 'mono wrap' }, r.query + (r.optionsText ? ' (' + r.optionsText + ')' : '')), h('td', {}, L.KIND_LABEL[r.kind] || r.kind || ''), h('td', {}, GH.fmtClock(r.at)),
        h('td', { class: 'num' }, String(r.count)), h('td', { class: 'num' }, r.ms + ' ms'), h('td', {}, L.outcomeText(r)),
        h('td', {}, GH.btn('Open', { cls: 'tp-hopen', aria: 'Open the run for ' + r.query, onclick: () => { S.view = r; S.selected = []; S.tab = 'results'; drawTabs(); } }))));
      panel.append(h('div', { class: 'rt-scroll tp-hist' }, h('table', { class: 'rt-t tp-ht' }, h('caption', { class: 'sr' }, 'Runs in this session, newest first'),
        h('thead', {}, h('tr', {}, ['Looked up', 'Kind', 'Time', 'Found', 'Took', 'Outcome', ''].map((t, i) => h('th', { scope: 'col', class: i === 3 || i === 4 ? 'num' : '' }, t || h('span', { class: 'sr' }, 'Open'))))), h('tbody', {}, rows))));
    }

    // ---------- the About drawer ----------
    function aboutNode() {
      const e = S.entry || {}, t = S.tool || {}, st = status(), net = NET[e.network] || NET.unavailable, miss = L.missingNames(S.entry);
      const kv = [];
      const add = (k, v) => { if (v !== undefined && v !== null && String(v) !== '') kv.push(h('dt', {}, k), h('dd', {}, v)); };
      add('What it does', e.description);
      add('What it contacts', net[0] + '. ' + net[1] + (Array.isArray(t.hosts || e.hosts) && (t.hosts || e.hosts).length ? ' Addresses: ' + (t.hosts || e.hosts).join(', ') + '.' : ''));
      add('Rate limit', t.rateLimit || e.rateLimit || (e.network === 'local' ? 'None: nothing is sent anywhere.' : 'Ghost keeps to each service\'s fair-use rule, one polite request at a time.'));
      add('Scope', SCOPE_TEXT[e.scope === 'passive' && e.network === 'local' ? 'passive-local' : e.scope]);
      add('Licence', e.licence ? e.licence.spdx + ', ' + (e.licence.mode === 'separate-program' ? 'a separate program' : 'ships with the tool') + (e.licence.url ? '. ' + e.licence.url : '') : '');
      const terms = [e.externalRestrictions && e.externalRestrictions !== 'None.' ? e.externalRestrictions : '', t.dataTerms || e.dataTerms || '', t.contact || e.contact ? 'Contact: ' + (t.contact || e.contact) : ''].filter(Boolean).join(' ');
      add('Terms and contacts', terms || 'No special terms.');
      add('It needs permission to', e.permissions && e.permissions.length ? e.permissions.join(', ') : '');
      const reqs = (e.install && e.install.requirements) || [];
      const body = h('div', { class: 'stack tp-about-b' }, h('dl', { class: 'kv wide' }, kv));
      body.append(h('h3', { class: 'sub-h' }, 'What it needs'));
      if (!reqs.length) body.append(h('p', { class: 'mute' }, 'Nothing else. It works on its own.'));
      else body.append(h('ul', { class: 'reqs' }, reqs.map((r) => h('li', { class: 'req ' + r.status }, h('span', { class: 'mono' }, r.status === 'ok' ? 'Ready' : r.status === 'untested' ? 'Not checked' : 'Missing'), h('span', {}, r.name), r.detail && r.status !== 'ok' && r.status !== 'untested' ? h('span', { class: 'mute' }, ' ' + String(r.detail).slice(0, 160)) : null))));
      if (miss.length || st.state === 'needs-program') {
        body.append(h('h3', { class: 'sub-h' }, 'How to get ' + (miss.length ? miss.join(' and ') : 'the missing program')),
          h('p', {}, t.howTo || 'Add ' + (miss.length ? miss.join(' and ') : 'the program') + ' in the virtual computer (Tool Integrations), or install it on this computer with your usual package manager. This tool starts working as soon as the program is found. Ghost never fakes a result without it.'));
      }
      return body;
    }
    let aboutHost = null, lastFocus = null;
    function fillAbout() { if (!aboutHost) return; const b = aboutHost.querySelector('.tp-drawer-b'); GH.clear(b); b.append(aboutNode()); }
    function closeAbout() { if (!aboutHost) return; document.removeEventListener('keydown', aboutKey, true); window.removeEventListener('hashchange', closeAbout); aboutHost.remove(); aboutHost = null; S.drawer = false; if (lastFocus && lastFocus.isConnected) lastFocus.focus(); }
    function aboutKey(ev) {
      if (!aboutHost) return;
      if (!live()) { closeAbout(); return; }
      if (ev.key === 'Escape') { ev.stopPropagation(); closeAbout(); return; }
      if (ev.key !== 'Tab') return;
      const f = [...aboutHost.querySelectorAll('button:not([disabled]),a[href],[tabindex="0"]')].filter((x) => x.offsetParent !== null); if (!f.length) return;
      const a = f[0], z = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === a) { ev.preventDefault(); z.focus(); } else if (!ev.shiftKey && document.activeElement === z) { ev.preventDefault(); a.focus(); }
    }
    function openAbout(from) {
      if (aboutHost) return; lastFocus = from || document.activeElement; S.drawer = true;
      const tid = uid + '-about-h';
      aboutHost = h('div', { class: 'tp-scrim', onmousedown: (ev) => { if (ev.target === aboutHost) closeAbout(); } },
        h('aside', { class: 'tp-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': tid },
          h('div', { class: 'tp-drawer-h' }, h('h2', { id: tid }, 'About ' + S.name), GH.btn('', { icon: 'x', ghost: true, title: 'Close', cls: 'tp-about-x', onclick: closeAbout })),
          h('div', { class: 'tp-drawer-b' })));
      document.body.append(aboutHost); fillAbout(); document.addEventListener('keydown', aboutKey, true); window.addEventListener('hashchange', closeAbout);
      aboutHost.querySelector('.tp-about-x').focus();
    }

    // ---------- put it together ----------
    root.append(head, banner, msg, form, prog, tabbar, panel);
    drawHead(); drawTabs();
    fs.hidden = true;
    const start = async () => {
      try { await load(); } catch (e) { S.entryErr = GH.errText(e); S.loading = false; }
      if (!live() && !root.parentNode) { /* the caller may attach it later */ }
      if (o.kind && S.kinds.includes(o.kind)) { S.kind = o.kind; S.kindManual = true; }
      if (o.query) valueIn.value = String(o.query);
      if (Array.isArray(o.results)) {
        const rec = GH.toolHistory.add(id, { id: 'r' + Date.now().toString(36), at: new Date().toISOString(), query: String(o.query || ''), kind: S.kind, optionsText: '', count: o.results.length, ms: Number.isFinite(o.ms) ? o.ms : 0, status: o.results.length ? 'done' : 'empty', error: '', results: o.results, rejected: 0, truncated: false, mode: 'search' });
        S.view = rec;
      } else if (!S.view) { const l = history(); if (l.length) S.view = l[0]; }
      drawHead(); drawFormBits(); drawTabs();
      if (o.run && o.query && !Array.isArray(o.results)) doRun(true);
    };
    root.tp = { run: () => doRun(), setQuery(q, k) { if (k && S.kinds.includes(k)) { S.kind = k; S.kindManual = true; drawFormBits(); } valueIn.value = String(q || ''); onType(); }, reload: refresh, focus: () => { (S.kind === 'file' ? fileBtn : valueIn).focus(); }, state: () => ({ ...status(), kind: S.kind }) };
    const a0 = ad();
    if (a0.onBuiltins) { try { const off = a0.onBuiltins(() => { if (!live()) { if (typeof off === 'function') off(); return; } if (!S.running) refresh(); }); if (typeof off === 'function') offs.push(off); } catch { /* the app has no change events */ } }
    start();
    return root;
  };
})();
