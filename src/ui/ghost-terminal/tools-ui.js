// Ghost terminal: the Tools panel. (1) which code tools were found, (2) the Ghost tools folder, (3) "Add tool" and the list of added tools.
// Everything shown comes from main; text is set with text nodes only. Nothing here can run a command: a tool runs only through the
// approved runner, with the input values the person types into its form.
(function (root) {
  'use strict';
  const { h, clear } = root.GhostDom;
  let ctx = null, el = null, staged = null, form = { runtime: 'native', scope: 'local', network: 'local' }, tab = 'folder', runs = {}, busy = '';
  const say = (t) => root.ghostSay && root.ghostSay(t);
  const msg = (e) => String((e && e.message) || e || '').replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': /, '');

  async function guard(label, fn) {
    busy = label; draw();
    try { return await fn(); } catch (e) { say(msg(e)); } finally { busy = ''; await refresh(); }
  }
  let list = [], info = null;
  async function refresh() {
    try { list = await ctx.api.tools.list(); } catch { list = []; }
    try { info = await ctx.refreshInfo(); } catch { /* keep the old one */ }
    draw();
  }

  const short = (s) => String(s || '').slice(0, 7);
  function programs() {
    const p = (info && info.programs) || [];
    return h('section', null, h('h2', { text: 'Code tools' }),
      h('p', { text: 'Found by looking at your PATH. Nothing was run to check.' }),
      h('div', { class: 'prog' }, p.map((x) => [h('b', { text: x.id }), h('span', { class: x.found ? null : 'warn', text: x.found ? x.path : 'Not found. ' + x.hint })])),
      h('p', { class: 'mono', text: 'pip installs into the user folder or a virtual environment; for command-line tools prefer pipx.' }));
  }
  function folder() {
    return h('section', null, h('h2', { text: 'Ghost tools folder' }),
      h('p', { class: 'mono', text: info ? info.toolsDir : '' }),
      h('p', { text: 'Programs you place here (and in its bin folder) are on your PATH in this terminal. Tools added below stay in their own folders and run only after you approve them.' }),
      h('div', { class: 'row-actions' }, h('button', { class: 'btn line', onclick: () => ctx.api.openTools().catch((e) => say(msg(e))) }, 'Open folder')),
      info && info.tools.length ? h('p', { class: 'mono', text: 'On PATH: ' + info.tools.slice(0, 30).join(', ') + (info.tools.length > 30 ? ', ...' : '') }) : null);
  }

  // ----- Add tool -----
  const seg = (id, label) => h('button', { class: 'btn line' + (tab === id ? ' on' : ''), onclick: () => { tab = id; draw(); } }, label);
  const field = (label, key, ph, big) => h('label', null, label, big ? h('textarea', { placeholder: ph || '', oninput: (e) => { form[key] = e.target.value; } }, form[key] || '') : h('input', { type: 'text', placeholder: ph || '', value: form[key] || '', oninput: (e) => { form[key] = e.target.value; } }));
  const sel = (label, key, opts) => h('label', null, label, h('select', { onchange: (e) => { form[key] = e.target.value; } }, opts.map(([v, t]) => h('option', { value: v, selected: form[key] === v }, t))));

  function addTool() {
    const kids = [h('h2', { text: 'Add tool' }),
      h('p', { text: 'A tool is a connector: a connector.json manifest plus its files. Adding only copies files for you to look at. Nothing runs, no install script is ever run, and the tool cannot run until you approve it.' }),
      h('div', { class: 'seg' }, seg('folder', 'Folder'), seg('zip', 'Zip file'), seg('script', 'One script'), seg('github', 'GitHub'))];
    if (tab === 'folder') kids.push(h('p', { text: 'Choose a folder that contains connector.json.' }), h('button', { class: 'btn primary', disabled: !!busy, onclick: () => stage(() => ctx.api.tools.addFolder()) }, 'Choose folder...'));
    if (tab === 'zip') kids.push(h('p', { text: 'Choose a .zip with connector.json at the top (or inside one folder). Limits: 24 MiB, 500 files.' }), h('button', { class: 'btn primary', disabled: !!busy, onclick: () => stage(() => ctx.api.tools.addZip()) }, 'Choose zip...'));
    if (tab === 'github') {
      kids.push(h('p', { text: 'Paste a repository address. Ghost looks up the commit, downloads exactly that commit from GitHub, and shows you the manifest, README and licence first. The commit is pinned.' }),
        field('Repository', 'ghUrl', 'https://' + 'github.com/owner/repo'), field('Tag, branch or commit (optional)', 'ghRef', 'v1.2.0'),
        h('button', { class: 'btn primary', disabled: !!busy || !form.ghUrl, onclick: () => stage(() => ctx.api.tools.addGithub({ url: String(form.ghUrl || '').trim(), ...(form.ghRef ? { ref: String(form.ghRef).trim() } : {}) })) }, 'Look up'));
    }
    if (tab === 'script') {
      kids.push(h('p', { text: 'For one script or program. Describe it; Ghost writes the manifest. The program must print its results as JSON lines (see the connector guide), because that is how results are checked.' }),
        field('Name', 'name', 'My checker'), field('What it does', 'description', 'One sentence'),
        sel('Runs with', 'runtime', [['native', 'Run the file itself (macOS/Linux: needs a #! line)'], ['node', "Mayfair's built-in Node (script is .js)"]]),
        sel('Network', 'network', [['local', 'None: stays on this computer'], ['keyless-external', 'Contacts outside services'], ['rate-limited', 'Contacts rate-limited services']]),
        sel('Scope', 'scope', [['local', 'Local: only data on this computer'], ['passive', 'Passive: reads public information']]),
        field('Licence (SPDX, e.g. MIT)', 'licence', 'MIT'), field('Terms or limits to know about', 'restrictions', 'None.'),
        field('Input label (optional: adds one text box)', 'inputLabel', 'Text to look at'),
        field('Arguments, one per line. Use {text} for the input', 'argsText', '--text={text}', true),
        field('Self-test input', 'selfTestInput', 'test'),
        h('button', { class: 'btn primary', disabled: !!busy, onclick: () => stage(() => ctx.api.tools.addScript({ name: form.name || '', description: form.description || '', runtime: form.runtime, scope: form.scope, network: form.network, licence: form.licence || '', restrictions: form.restrictions || '', inputLabel: form.inputLabel || '', args: String(form.argsText || '').split('\n').map((s) => s.trim()).filter(Boolean), selfTestInput: form.selfTestInput || 'test' })) }, 'Choose the file...'));
    }
    if (busy) kids.push(h('p', { class: 'mono', text: busy + '...' }));
    return h('section', null, kids);
  }
  async function stage(fn) {
    const r = await guard('Reading', async () => { try { return await fn(); } catch (e) { return { ok: false, error: 'failed', errors: [msg(e)] }; } });
    if (!r) return;
    if (r.ok === false && r.error === 'cancelled') return;
    if (r.ok === false) { staged = { failed: true, errors: r.errors || [r.error] }; draw(); return; }
    staged = r; draw();
  }
  function preview() {
    if (!staged) return null;
    const s = staged;
    if (s.failed) return h('section', null, h('h2', { text: 'Could not add' }), s.errors.map((e) => h('p', { class: 'err', text: e })), h('button', { class: 'btn line', onclick: () => { staged = null; draw(); } }, 'Close'));
    const m = s.manifest;
    return h('section', null, h('h2', { text: 'Review before adding' }),
      s.source.type === 'github' ? h('p', { class: 'mono', text: 'Source: github.com/' + s.source.repo + ' at commit ' + s.source.commit + '\narchive sha256 ' + s.source.archiveSha256 }) : h('p', { class: 'mono', text: 'Source: ' + s.source.type + ' ' + s.source.name }),
      s.errors.map((e) => h('p', { class: 'err', text: e })), s.warnings.map((e) => h('p', { class: 'warn', text: e })),
      m ? h('div', { class: 'card' }, h('div', { class: 'top' }, h('b', { text: m.name }), h('span', { class: 'mono', text: m.id + ' ' + m.version })), h('p', { text: m.description }),
        h('p', { class: 'mono', text: 'Scope: ' + m.scope + '   Network: ' + m.network + '\nPermissions: ' + (m.permissions.length ? m.permissions.join(', ') : 'none') + '\nLicence: ' + m.licence.spdx + ' (' + m.licence.mode + ')\nRuns: ' + m.command.executable + ' ' + JSON.stringify(m.command.args) }),
        h('p', { text: 'Restrictions: ' + m.externalRestrictions })) : null,
      h('h3', { text: 'connector.json' }), h('pre', { class: 'view', text: s.manifestText || '(missing)' }),
      s.readme ? [h('h3', { text: s.readme.name }), h('pre', { class: 'view', text: s.readme.text })] : null,
      s.licenceFile ? [h('h3', { text: s.licenceFile.name }), h('pre', { class: 'view', text: s.licenceFile.text })] : null,
      h('p', { class: 'mono', text: s.files + ' files, ' + Math.round(s.bytes / 1024) + ' KiB' }),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn primary', disabled: !s.valid || !!busy, onclick: async () => { const r = await guard('Adding', () => ctx.api.tools.commit(s.token)); if (r && r.ok) { staged = null; say('Added "' + r.id + '". It is not approved yet and has not been tested.'); } else if (r) say((r.errors || [r.error]).join('\n')); } }, 'Add to Ghost tools'),
        h('button', { class: 'btn line', onclick: () => { ctx.api.tools.cancel(s.token).catch(() => {}); staged = null; draw(); } }, 'Discard')),
      h('p', { text: 'Adding does not approve it. Approval is a separate step with its own confirmation window.' }));
  }

  // ----- installed tools -----
  function statusLine(t) {
    const cls = t.status === 'Test passed' ? 'ok' : (t.status === 'Test failed' || t.status === 'Broken') ? 'bad' : 'na';
    const detail = t.install && t.install.lastTest && t.install.lastTest.detail ? ' (' + t.install.lastTest.detail + ')' : '';
    return h('p', { class: 'st ' + cls, text: t.status + (t.install && t.install.verified !== 'not-tested' ? detail : '') });
  }
  async function act(label, fn) { const r = await guard(label, fn); if (r && r.ok === false) say(r.error === 'declined' ? 'Cancelled.' : (r.errors || [r.message || r.error]).join('\n')); return r; }
  function card(t) {
    const run = runs[t.id] || (runs[t.id] = { input: {}, ack: false });
    const btns = [];
    if (t.state === 'not-approved') btns.push(h('button', { class: 'btn primary', disabled: !!busy || t.health === 'broken', onclick: () => act('Waiting for your answer', () => ctx.api.tools.approve(t.id)) }, 'Approve...'));
    if (t.state !== 'not-approved') btns.push(h('button', { class: 'btn line', disabled: !!busy, onclick: () => act('Testing', () => ctx.api.tools.test(t.id)) }, 'Run self-test'));
    if (t.state === 'approved' || t.state === 'disabled') btns.push(h('button', { class: 'btn line', disabled: !!busy, onclick: () => act('Enabling', () => ctx.api.tools.enable(t.id)) }, 'Enable'));
    if (t.state === 'enabled') btns.push(h('button', { class: 'btn line', disabled: !!busy, onclick: () => act('Disabling', () => ctx.api.tools.disable(t.id)) }, 'Disable'));
    btns.push(h('button', { class: 'btn line', disabled: !!busy, onclick: () => act('Removing', () => ctx.api.tools.remove(t.id)) }, 'Remove...'));
    const form_ = t.state === 'enabled' ? runForm(t, run) : null;
    return h('div', { class: 'card' },
      h('div', { class: 'top' }, h('b', { text: t.name }), h('span', { class: 'mono', text: t.id + ' ' + t.version }), h('span', { class: 'badge' + (t.scope === 'active' ? ' warn' : ''), text: t.scope }), h('span', { class: 'badge', text: 'network: ' + t.network })),
      t.description ? h('p', { text: t.description }) : null,
      t.source ? h('p', { class: 'mono', text: 'github.com/' + t.source.repo + ' @ ' + short(t.source.commit) }) : null,
      h('p', { class: 'mono', text: 'State: ' + t.state + (t.licence ? '   Licence: ' + t.licence.spdx : '') }),
      statusLine(t), t.health === 'changed' ? h('p', { class: 'warn', text: 'Files changed since you approved this tool, so approval was withdrawn. Review and approve again.' }) : null,
      t.errors && t.errors.length ? t.errors.map((e) => h('p', { class: 'err', text: e })) : null,
      h('div', { class: 'row-actions' }, btns), form_, run.job ? jobView(run.job) : null);
  }
  function runForm(t, run) {
    const kids = (t.fields || []).map((f) => f.type === 'enum' ? h('label', null, f.label || f.name, h('select', { onchange: (e) => { run.input[f.name] = e.target.value; } }, f.values.map((v) => h('option', { value: v, selected: run.input[f.name] === v }, v))))
      : f.type === 'file' ? h('p', { class: 'mono', text: f.name + ': file inputs are not available in the terminal window' })
        : h('label', null, f.label || f.name, h('input', { type: 'text', maxlength: f.maxLength || 4096, value: run.input[f.name] || '', oninput: (e) => { run.input[f.name] = f.type === 'integer' ? Number(e.target.value) : e.target.value; } })));
    if (t.scope === 'active') kids.push(h('label', null, 'Target you are authorised to test', h('input', { type: 'text', value: run.target || '', oninput: (e) => { run.target = e.target.value; } })), h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: run.ack, onchange: (e) => { run.ack = e.target.checked; draw(); } }), 'I own this target or have written permission to test it. This run is recorded in the audit log on this computer.'));
    const needFile = (t.fields || []).some((f) => f.type === 'file' && f.required !== false);
    kids.push(h('div', { class: 'row-actions' }, h('button', { class: 'btn primary', disabled: !!busy || needFile || (t.scope === 'active' && (!run.ack || !run.target)), onclick: async () => {
      const input = {}; for (const f of t.fields || []) if (run.input[f.name] !== undefined && run.input[f.name] !== '') input[f.name] = run.input[f.name];
      const r = await act('Starting', () => ctx.api.tools.run({ id: t.id, input, ...(t.scope === 'active' ? { scope: { target: run.target, confirmedAuthorised: true } } : {}) }));
      if (r && r.ok) { run.job = { id: r.jobId, status: r.status }; poll(t.id); draw(); }
    } }, 'Run'), run.job && !isDone(run.job.status) ? h('button', { class: 'btn line', onclick: () => ctx.api.tools.cancelJob(run.job.id).catch(() => {}) }, 'Cancel') : null));
    return h('div', null, h('h3', { text: 'Run' }), kids);
  }
  const isDone = (s) => ['done', 'failed', 'cancelled', 'timed-out'].includes(s);
  function jobView(j) {
    const kids = [h('p', { class: 'st ' + (j.status === 'done' ? 'ok' : isDone(j.status) ? 'bad' : 'na'), text: 'Job: ' + j.status + (j.message ? ' - ' + j.message : '') + (j.error ? ' - ' + j.error : '') })];
    if (j.results && j.results.length) kids.push(h('pre', { class: 'view', text: j.results.slice(0, 200).map((r) => r.entity.type + ': ' + r.entity.value + '  [' + r.confidence + ']').join('\n') }));
    if (j.errors && j.errors.length) kids.push(h('p', { class: 'warn', text: j.rejected + ' line(s) rejected: ' + j.errors[0].reason }));
    if (j.stderr) kids.push(h('pre', { class: 'view', text: j.stderr.slice(0, 600) }));
    return h('div', null, kids);
  }
  async function poll(toolId) {
    const run = runs[toolId]; if (!run || !run.job) return;
    for (let i = 0; i < 400; i++) {
      let j = null; try { j = await ctx.api.tools.job(run.job.id); } catch { return; }
      if (j) { run.job = j; draw(); if (isDone(j.status)) return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  function draw() {
    if (!el) return;
    const top = el.scrollTop;
    clear(el);
    el.append(programs(), folder(), addTool(), preview(),
      h('section', null, h('h2', { text: 'Added tools' }), list.length ? list.map(card) : h('p', { text: 'None yet.' })));
    el.scrollTop = top;
  }
  function mount(panel, c) {
    ctx = c; el = panel;
    if (!mount.job) { mount.job = true; c.api.onJob((p) => { for (const id of Object.keys(runs)) { const r = runs[id]; if (r.job && r.job.id === p.jobId) { r.job = Object.assign({}, r.job, p); if (isDone(p.status)) poll(id); draw(); } } }); }
    refresh();
  }
  root.GhostToolsUI = { mount };
})(this);
