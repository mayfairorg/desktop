// Ghost, Tool Integrations: "Add a tool". A separate module so the screens file stays as it is: it wraps GH.routes.tools and adds its own section.
// Tools are put into Ghost's virtual computer (never on this computer). Everything shown comes from main; the page never supplies a command:
// setup commands are named by id (main made them from fixed steps), a path comes only from a native picker, a connector is described by a form main checks.
(function () {
  'use strict';
  const GH = window.GH; if (!GH || !GH.routes || !GH.routes.tools || !GH.api || !GH.api.vm) return;
  const h = GH.h, V = GH.api.vm;
  const CASE_OK = /^[A-Za-z0-9_-]{1,40}$/;

  // styles (the page's policy allows only files from its own folder)
  try { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '../ghost-vm/vm.css'; document.head.append(l); } catch { /* unstyled is still usable */ }

  // Terminal buttons open the virtual computer for the case that is open (main checks the id again).
  const baseApi = GH.api;
  GH.api = Object.freeze({ ...baseApi, terminal: Object.freeze({ ...baseApi.terminal, open: (o) => { const c = GH.cs && GH.cs.current && GH.cs.current(); const id = c && c.id; return baseApi.terminal.open(o || (typeof id === 'string' && CASE_OK.test(id) ? { caseId: id } : {})); } }) });

  const fail = (e) => GH.toast(GH.errText(e));
  const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1048576)) + ' MB');
  const short = (s) => String(s || '').slice(0, 10);
  const kv = (rows) => h('dl', { class: 'gvm-facts' }, rows.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  const pre = (t, n) => h('pre', { class: 'gvm-pre' }, String(t || '').slice(0, n || 2000));

  function section() {
    const root = h('section', { class: 'gvm-add', 'aria-label': 'Add a tool' });
    let st = null, staged = null, tools = [], open = {}, runs = {}, update = {}, regForm = {}, imp = null, busy = '', timer = 0;
    const alive = () => root.isConnected;
    const draw = () => { if (!alive()) return; GH.clear(root); root.append(head(), vmBox(), staged ? preview() : addBox(), installed(), library()); };
    async function loadStatus() { try { st = await V.status(); } catch { st = null; } }
    async function loadTools() { try { const r = await GH.call(V.tools.list); tools = r.tools || []; } catch { tools = []; } }
    async function refresh() { await Promise.all([loadStatus(), loadTools()]); draw(); }
    function poll() {
      clearInterval(timer);
      timer = setInterval(async () => {
        if (!alive()) { clearInterval(timer); return; }
        const active = Object.values(runs).some((r) => r.status === 'running') || (imp && !imp.done) || (st && ['downloading', 'starting', 'stopping'].includes(st.state));
        if (!active) return;
        await loadStatus();
        for (const r of Object.values(runs)) if (r.status === 'running') { try { runs[r.name] = await GH.call(V.tools.setupRun, r.id); } catch { /* keep */ } }
        if (imp && !imp.done) { try { imp = await GH.call(V.library.importStatus); if (imp.done) await loadTools(); } catch { /* keep */ } }
        draw();
      }, 1200);
    }
    const act = async (label, fn) => { if (busy) return null; busy = label; draw(); try { return await fn(); } catch (e) { fail(e); return null; } finally { busy = ''; draw(); } };

    function head() {
      return h('div', {}, h('h2', {}, 'Add a tool'),
        h('p', {}, 'Bring in an open-source tool from GitHub, or your own folder, zip or script. It is put in Ghost\'s virtual computer, in a separate disk that survives a reset, and never on this computer. Ghost shows what is in it and what it would run first, and runs nothing by itself.'));
    }
    function vmBox() {
      if (!st) return h('p', { class: 'gvm-err-t' }, 'The virtual computer could not be reached.');
      const s = st, rows = [['Virtual computer', ({ running: 'Running', starting: 'Starting', stopping: 'Stopping', stopped: 'Stopped', downloading: 'Downloading', 'not-installed': 'Not downloaded', error: 'Problem' })[s.state] || s.state]];
      if (s.accel) rows.push(['Speed', s.accel.fast ? s.accel.label : 'Slow: ' + s.accel.notice]);
      if (s.route) rows.push(['Network', s.route.text || s.route.label]);
      const box = h('div', { class: 'gvm-tool' }, kv(rows));
      if (s.error) box.append(h('p', { class: 'gvm-err-t' }, s.error));
      if (s.state === 'downloading') { const d = s.download || {}; box.append(h('p', {}, 'Downloading: ' + mb(d.doneBytes || 0) + ' of ' + mb(d.total || 0)), GH.btn('Cancel download', { onclick: () => act('cancel', () => GH.call(V.cancelInstall)) })); }
      else if (s.state === 'not-installed') {
        box.append(h('p', {}, s.notPublished || s.installNote ? (s.installNote || 'No image has been published yet.') : 'The virtual computer is a small Linux system (' + mb(s.totalBytes || 0) + ', downloaded once from github.com and checked against a pinned SHA-256).'));
        if (!s.notPublished && !(s.installNote && !(s.missing || []).length)) box.append(GH.btn('Download the virtual computer', { primary: true, onclick: () => act('install', () => GH.call(V.install)).then(poll) }));
      } else if (s.state === 'stopped' || s.state === 'error') box.append(GH.btn('Start', { primary: true, onclick: () => act('start', () => GH.call(V.start, {})).then(poll) }));
      return box;
    }

    // ---- step 1: where from
    const url = h('input', { type: 'text', id: 'gvm-url', placeholder: 'https://github.com/owner/repo' }), ref = h('input', { type: 'text', id: 'gvm-ref', placeholder: 'tag or commit (optional)' });
    function addBox() {
      const ok = st && ['running', 'stopped', 'starting'].includes(st.state);
      const look = () => act('look', async () => { const r = await GH.call(V.tools.prepareGithub, { url: url.value.trim(), ...(ref.value.trim() ? { ref: ref.value.trim() } : {}) }); staged = r; return r; });
      const up = (kind) => act('upload', async () => { const r = await GH.call(V.tools.prepareUpload, { kind }); staged = r; return r; }).catch(() => {});
      return h('div', { class: 'gvm-tool' }, h('h4', {}, 'Where is it?'),
        GH.field('GitHub address', url), GH.field('Tag, branch or commit', ref, 'Ghost pins the exact commit it finds.'),
        h('div', { class: 'gvm-row' }, GH.btn(busy === 'look' ? 'Fetching…' : 'Fetch and look', { primary: true, disabled: !ok || !!busy, onclick: look }), h('span', { class: 'mute sm' }, 'or your own files:'),
          GH.btn('Folder…', { disabled: !ok || !!busy, onclick: () => up('folder') }), GH.btn('Zip…', { disabled: !ok || !!busy, onclick: () => up('zip') }), GH.btn('Script…', { disabled: !ok || !!busy, onclick: () => up('script') })),
        !ok ? h('p', { class: 'mute sm' }, 'Download and start the virtual computer first.') : h('p', { class: 'mute sm' }, 'The machine does the downloading, through the network route shown above. Nothing is added to Ghost until you press Keep.'));
    }

    // ---- step 2: the preview
    function setupRows(name, sugg) {
      const r = runs[name];
      return [h('h4', {}, 'Setup commands'), sugg.length ? h('p', { class: 'mute sm' }, 'Built from fixed steps for what Ghost found in the files. Read each one; it runs inside the virtual computer only when you press its button.') : h('p', { class: 'mute sm' }, 'Ghost could not tell how to set this up. Read the README and add the commands yourself in the Ghost terminal.'),
        sugg.map((s) => h('div', { class: 'gvm-cmd' }, h('div', {}, h('b', {}, s.label), h('code', {}, s.command), s.note ? h('small', {}, s.note) : null),
          GH.btn('Run', { disabled: !!(r && r.status === 'running'), onclick: async () => { try { const x = await GH.call(V.tools.runSetup, { name, ids: [s.id] }); runs[name] = await GH.call(V.tools.setupRun, x.runId); draw(); poll(); } catch (e) { fail(e); } } }))),
        r ? [h('p', { class: 'mono ' + (r.status === 'failed' ? 'gvm-err-t' : '') }, 'Setup: ' + r.status), pre(r.output, 6000), r.status === 'running' ? GH.btn('Stop', { onclick: () => GH.call(V.tools.cancelSetup, r.id).catch(fail) }) : null] : null];
    }
    function preview() {
      const p = staged;
      return h('div', { class: 'gvm-tool' }, h('h4', {}, 'Look before you keep: ' + p.name),
        kv([['Source', p.source.type === 'github' ? p.source.url : 'your files: ' + (p.source.name || '')], ['Commit', p.commit || 'none (uploaded files are kept in a private history inside the machine)'], ['Checksum', 'sha256 ' + short(p.checksum) + '…'], ['Files', String((p.files || []).length) + (p.files && p.files.length >= 200 ? '+' : '')], ['Where', p.guestDir + ' (in the virtual computer)'], ['Licence', p.licenceGuess || 'not recognised']]),
        p.licenceFile ? [h('p', { class: 'mute sm' }, p.licenceFile.name), pre(p.licenceFile.text, 700)] : h('p', { class: 'gvm-err-t' }, 'No licence file found. Check the licence before you use it.'),
        p.readme ? [h('p', { class: 'mute sm' }, p.readme.name), pre(p.readme.text, 2500)] : h('p', { class: 'mute sm' }, 'No README found.'),
        setupRows(p.name, p.suggestions || []),
        h('p', { class: 'mute sm' }, p.note),
        h('div', { class: 'gvm-row' }, GH.btn('Keep this tool', { primary: true, disabled: !!busy, onclick: async () => { const r = await act('keep', () => GH.call(V.tools.commit, p.token)); if (r) { staged = null; if (r.warning) GH.toast(r.warning); GH.toast('Added. Pinned at ' + short(r.commit)); await loadTools(); open[p.name] = true; draw(); } } }),
          GH.btn('Discard', { disabled: !!busy, onclick: async () => { try { await GH.call(V.tools.cancel, p.token); } catch (e) { fail(e); } staged = null; draw(); } })));
    }

    // ---- the tools that are in
    function regBox(t) {
      const f = regForm[t.name] = regForm[t.name] || { program: 'python3', args: '', output: 'lines', entityType: 'finding', inputLabel: 'Target', network: 'local', scope: 'local', licence: t.licence || '', restrictions: '', timeoutSec: '120', selfTestInput: 'test' };
      const inp = (k, label, hint, tag) => { const el = h(tag || 'input', tag ? { rows: 3 } : { type: 'text' }); el.value = f[k]; el.addEventListener('input', () => { f[k] = el.value; }); return GH.field(label, el, hint); };
      const sel = (k, label, opts, hint) => { const el = h('select', {}, opts.map(([v, l]) => h('option', { value: v }, l))); el.value = f[k]; el.addEventListener('change', () => { f[k] = el.value; }); return GH.field(label, el, hint); };
      const body = () => ({ program: f.program.trim(), args: f.args.split('\n').map((x) => x.trim()).filter(Boolean), output: f.output, entityType: f.entityType.trim(), inputLabel: f.inputLabel.trim(), network: f.network, scope: f.scope, licence: f.licence.trim(), restrictions: f.restrictions.trim(), timeoutSec: Number(f.timeoutSec) || 120, selfTestInput: f.selfTestInput });
      const out = h('div', {});
      const prev = async () => { try { const r = await GH.call(V.tools.previewConnector, { name: t.name, form: body() }); GH.clear(out).append(h('p', { class: 'mute sm' }, 'It would run, inside the virtual computer, at commit ' + short(t.commit) + ':'), pre(r.command), pre(JSON.stringify(r.manifest, null, 2), 3000)); } catch (e) { GH.clear(out).append(h('p', { class: 'gvm-err-t' }, GH.errText(e))); } };
      return h('div', { class: 'gvm-sec' }, h('h4', {}, 'Use it as a connector'),
        h('p', { class: 'mute sm' }, 'Describe how to run it. Ghost runs it only through the connector runner, inside the virtual computer, with the arguments below (no shell). Use {text} where the input goes.'),
        inp('program', 'Program', 'python3, node, go, cargo, make, or a file inside the tool folder such as bin/run'), inp('args', 'Arguments, one per line', 'e.g. main.py then {text}', 'textarea'),
        sel('output', 'What it prints', [['lines', 'Plain lines (Ghost marks each result uncertain)'], ['json', 'JSON (marked uncertain)'], ['jsonl', 'Ghost result lines (jsonl)']]),
        inp('entityType', 'Result type', 'lowercase, e.g. domain, ip, finding'), inp('inputLabel', 'Input label', 'leave empty if it takes no input'),
        sel('network', 'Network', [['local', 'None: local only'], ['keyless-external', 'Reaches the internet (no key)'], ['rate-limited', 'Reaches the internet (rate limited)']]), sel('scope', 'Scope', [['local', 'Local'], ['passive', 'Passive: reads public information'], ['active', 'Active: touches a target']]),
        inp('licence', 'Licence (SPDX)', 'e.g. MIT, Apache-2.0, GPL-3.0-only; NOASSERTION if unknown'), inp('restrictions', 'Restrictions to show', 'optional'), inp('timeoutSec', 'Time limit, seconds'), inp('selfTestInput', 'Self-test input'),
        out, h('div', { class: 'gvm-row' }, GH.btn('Preview', { onclick: prev }), GH.btn('Register', { primary: true, onclick: async () => { const r = await act('register', () => GH.call(V.tools.register, { name: t.name, form: body() })); if (r) { GH.conn.bust(); GH.toast('Registered. Approve it in the list above.'); await loadTools(); draw(); } } })));
    }
    function updateBox(t) {
      const u = update[t.name];
      if (!u) return null;
      if (u.upToDate) return h('p', { class: 'mute sm' }, 'Already at the newest commit (' + short(u.commit) + ').');
      return h('div', { class: 'gvm-sec' }, h('h4', {}, 'Newer commit ' + short(u.to)), kv([['From', short(u.from)], ['Changed files', String(u.changedFiles)], ['Licence files changed', u.licenceTouched ? 'Yes: read it again' : 'No']]), pre(u.stat, 2000),
        u.localChanges && u.localChanges.length ? [h('p', { class: 'gvm-err-t' }, 'Changed inside the machine: ' + u.localChanges.join(', ')), h('p', { class: 'mute sm' }, 'Updating discards those changes.')] : null, h('p', { class: 'mute sm' }, u.note),
        h('div', { class: 'gvm-row' }, GH.btn('Update to this commit', { primary: true, onclick: async () => { const r = await act('update', async () => { try { return await GH.call(V.tools.applyUpdate, { token: u.token, ...(u.localChanges && u.localChanges.length ? { discardChanges: true } : {}) }); } catch (e) { throw e; } }); if (r) { delete update[t.name]; GH.conn.bust(); GH.toast(r.needsApproval ? 'Updated. Approve the new commit in the list above.' : 'Updated.'); await loadTools(); draw(); } } }),
          GH.btn('Not now', { onclick: () => { delete update[t.name]; draw(); } })));
    }
    function toolCard(t) {
      const c = t.connector;
      const conn = c ? ({ 'not-approved': 'registered, needs your approval', approved: 'approved', enabled: 'switched on', disabled: 'switched off' }[c.state] || c.state) + (c.health && c.health !== 'ok' ? ' (' + (c.health === 'changed' ? 'files changed: approval withdrawn' : c.health) + ')' : '') : 'not a connector';
      const card = h('article', { class: 'gvm-tool', 'aria-label': t.name }, h('h4', {}, t.name),
        kv([['Source', t.source.type === 'github' ? t.source.url + (t.source.ref ? ' @ ' + t.source.ref : '') : 'your files: ' + (t.source.name || '')], ['Pinned commit', t.commit ? short(t.commit) : 'none'], ['Checksum', 'sha256 ' + short(t.checksum && t.checksum.value) + '…'], ['Licence', t.licence || 'unknown'], ['In the machine', t.present === null ? 'not checked' : t.present ? 'yes' : 'missing: wipe or reset removed it'], ['Connector', conn]]));
      const row = h('div', { class: 'gvm-row' });
      if (c && c.state === 'not-approved') row.append(GH.btn('Review and approve…', { primary: true, onclick: async () => { try { await GH.call(GH.api.connectors.requestApproval, c.id); } catch (e) { fail(e); } GH.conn.bust(); await loadTools(); draw(); } }));
      if (c && (c.state === 'approved' || c.state === 'enabled' || c.state === 'disabled')) row.append(GH.btn('Run self-test', { onclick: async () => { try { const r = await GH.call(GH.api.connectors.test, c.id); GH.toast(r && r.passed === false ? 'The self-test failed: ' + (r.detail || '') : 'The self-test passed.'); } catch (e) { fail(e); } GH.conn.bust(); await loadTools(); draw(); } }));
      if (c && (c.state === 'approved' || c.state === 'disabled')) row.append(GH.btn('Switch on', { onclick: async () => { try { await GH.call(GH.api.connectors.enable, c.id); } catch (e) { fail(e); } GH.conn.bust(); await loadTools(); draw(); } }));
      if (c && c.state === 'enabled') row.append(GH.btn('Switch off', { onclick: async () => { try { await GH.call(GH.api.connectors.disable, c.id); } catch (e) { fail(e); } GH.conn.bust(); await loadTools(); draw(); } }));
      row.append(GH.btn(open[t.name] ? 'Hide details' : 'Details', { onclick: async () => { open[t.name] = !open[t.name]; if (open[t.name] && !runs[t.name] && st && st.state === 'running') { try { const o = await GH.call(V.tools.setupOptions, t.name); t._sugg = o.suggestions; } catch { /* shown empty */ } } draw(); } }));
      if (t.source.type === 'github') row.append(GH.btn('Check for a newer commit', { disabled: !!busy, onclick: async () => { const r = await act('check', () => GH.call(V.tools.prepareUpdate, { name: t.name })); if (r) { update[t.name] = r; draw(); } } }));
      row.append(GH.btn('Remove', { onclick: async () => {
        const del = await GH.confirm('Remove ' + t.name + '?', 'Ghost forgets the tool and removes its connector' + (t.registered ? '' : '') + '. Its files in the virtual computer are deleted too.', 'Remove', true);
        if (!del) return;
        const r = await act('remove', () => GH.call(V.tools.remove, { name: t.name, deleteFiles: true })); if (r) { GH.conn.bust(); if (r.note) GH.toast(r.note); await loadTools(); draw(); }
      } }));
      card.append(row);
      const u = updateBox(t); if (u) card.append(u);
      if (open[t.name]) { card.append(...setupRows(t.name, t._sugg || [])); if (!t.registered) card.append(regBox(t)); else card.append(h('div', { class: 'gvm-row' }, GH.btn('Remove the connector only', { onclick: async () => { try { await GH.call(V.tools.unregister, t.name); GH.conn.bust(); await loadTools(); draw(); } catch (e) { fail(e); } } }))); }
      return card;
    }
    function installed() {
      return h('div', {}, h('h2', {}, 'Tools in the virtual computer'),
        tools.length ? h('div', { class: 'gvm-tools' }, tools.map(toolCard)) : h('p', { class: 'mute' }, 'None yet. A tool you add stays until you remove it or wipe the tools disk. Environments a tool sets up for itself (.venv, node_modules) are not covered by its pin.'));
    }

    // ---- the library list
    function library() {
      const box = h('div', { class: 'gvm-tool' }, h('h4', {}, 'Tool library list'),
        h('p', { class: 'mute sm' }, 'A small list of the tools you added: name, source, pinned commit, checksum, version and install notes. No case data. Import one on another computer and Ghost fetches each tool again, checks it against its pinned commit and checksum, and asks for your approval again.'),
        h('div', { class: 'gvm-row' }, GH.btn('Export the list…', { onclick: async () => { try { const r = await GH.call(V.library.exportFile); if (r && r.saved) GH.toast('Saved.'); } catch (e) { if (e.code !== 'cancelled') fail(e); } } }),
          GH.btn('Import a list…', { disabled: !!busy || !(st && ['running', 'stopped'].includes(st.state)), onclick: async () => { try { await GH.call(V.library.importFile); imp = await GH.call(V.library.importStatus); draw(); poll(); } catch (e) { if (e.code !== 'cancelled') fail(e); } } })));
      if (imp) {
        const items = imp.items || [];
        box.append(h('p', { class: 'mono' }, imp.done ? 'Import finished.' : 'Importing…'), items.length ? h('ul', { class: 'gvm-steps' }, items.map((i) => h('li', { class: i.status === 'done' || i.status === 'ready' ? 'done' : i.status === 'failed' || i.status === 'mismatch' ? 'failed' : 'running' }, i.name + ': ' + i.status + (i.error ? ' (' + i.error + ')' : '')))) : null,
          (imp.manual || []).length ? h('p', { class: 'mute sm' }, 'Uploaded tools cannot be fetched again; add these yourself: ' + imp.manual.map((m) => m.name).join(', ')) : null,
          (imp.conflicts || []).length ? h('p', { class: 'mute sm' }, 'Different commits on the two computers: ' + imp.conflicts.map((c) => c.name + ' (kept ' + c.chose + ')').join(', ')) : null,
          (imp.rejected || []).length ? h('p', { class: 'gvm-err-t' }, 'Not valid and skipped: ' + imp.rejected.map((r) => r.name).join(', ')) : null,
          imp.done && items.length ? h('p', { class: 'mute sm' }, 'Registered tools need your approval on this computer (see the list above).') : null);
      }
      return box;
    }

    refresh().then(() => { poll(); loadTools().then(() => GH.call(V.tools.verify).then((r) => { tools = r.tools || tools; draw(); }).catch(() => {})); });
    draw();
    return root;
  }

  const base = GH.routes.tools;
  GH.routes.tools = async function (...a) {
    const view = await base.apply(this, a);
    try { if (view && view.append) view.append(section()); } catch (e) { /* the screen still works without the section */ }
    return view;
  };
})();
