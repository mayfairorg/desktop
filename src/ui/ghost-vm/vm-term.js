// Ghost virtual computer: the pieces of the terminal window that belong to the virtual computer.
//   - the status bar (running or not, accelerator, network route, shared folder, resources, disk protection, Kill)
//   - the cover shown until the machine is ready: first-use download with progress, "starting", and plain reasons when it cannot run
//   - the Tools panel: network switches, shared folder, case, resources, snapshots, Reset, "Run from GitHub", tools disk, boot log, the advanced local terminal
// Everything shown comes from main; text is set with text nodes only. Nothing here can run a command: "Run from GitHub" shows commands that main
// made from fixed templates, and the person copies one or has it typed at the prompt (no Enter), exactly as if they had typed it.
(function (root) {
  'use strict';
  const { h, clear } = root.GhostDom;
  let ctx = null, st = null, bar = null, over = null, panelEl = null, coverWanted = false, readyWaiters = [], gh = null, ghBusy = false, snapName = '', caseNew = '', log = '', res = null;
  const msg = (e) => String((e && e.message) || e || '').replace(/^Error: /, '').replace(/^Error invoking remote method '[^']+': /, '');
  const say = (t) => ctx && ctx.say && ctx.say(t);
  const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(n / 1048576)) + ' MB');
  const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));   // raw append would print null and [object HTMLElement]
  const btn = (label, o = {}) => h('button', { class: 'gvm-btn' + (o.primary ? ' primary' : '') + (o.danger ? ' danger' : ''), disabled: o.disabled, title: o.title, onclick: o.onclick }, label);
  async function run(fn) { try { const r = await fn(); if (r && r.ok === false && r.code !== 'declined' && r.code !== 'cancelled') say(r.error || 'That did not work.'); return r; } catch (e) { say(msg(e)); return null; } }

  // ---------------------------------------------------------------- status bar
  const STATE = { running: ['ok', 'Virtual computer running'], starting: ['warn', 'Starting the virtual computer'], stopping: ['warn', 'Stopping'], stopped: ['', 'Virtual computer stopped'], error: ['bad', 'Virtual computer problem'], downloading: ['warn', 'Downloading'], 'not-installed': ['bad', 'Virtual computer not downloaded'], unknown: ['', 'Virtual computer'] };
  function chip(text, tone, o = {}) {
    const el = h(o.onclick ? 'button' : 'span', { class: 'gvm-chip ' + (tone || ''), title: o.title, onclick: o.onclick }, h('span', { class: 'gvm-dot', 'aria-hidden': 'true' }), text);
    return el;
  }
  function drawBar() {
    if (!bar) return;
    clear(bar);
    if (!st) { bar.hidden = true; return; }
    bar.hidden = false;
    const [tone, text] = STATE[st.state] || STATE.unknown;
    bar.append(chip(text, tone, { title: st.error || '' }));
    if (st.accel) bar.append(chip(st.accel.fast ? st.accel.label : 'Slow mode: ' + st.accel.label, st.accel.fast ? 'ok' : 'warn', { title: st.accel.notice || 'Hardware virtualization is in use.' }));
    const r = st.route;
    if (r) bar.append(chip('Network: ' + (r.mode === 'none' ? 'off' : r.text || r.label), r.tone, { title: r.mode === 'direct-doh' ? 'Direct: sites see your real IP address.' : r.mode === 'tor' ? 'Every connection goes through Ghost\'s Tor program. If Tor is down, connections are refused.' : 'No network.', onclick: () => ctx.showPanel() }));
    if (st.share && st.share.dir) bar.append(chip('Shared folder: case ' + st.caseId, 'ok', { title: st.share.dir + '\nThe only folder of this computer the machine can see (/mnt/shared in the machine).', onclick: () => run(() => ctx.api.vm.openShare()) }));
    else bar.append(chip('Case: ' + (st.caseId || 'default'), '', { title: 'The shared folder is made when the machine starts.' }));
    if (st.resources) bar.append(chip(st.resources.cpus + ' CPU · ' + st.resources.memMb + ' MB · ' + (st.resources.diskGb || 16) + ' GB disk', '', { title: 'Caps for the virtual computer.' }));
    if (st.disk) bar.append(chip(st.disk.encrypted ? 'Disk encrypted' : 'Disk not encrypted', st.disk.encrypted ? 'ok' : 'warn', { title: st.disk.note }));
    bar.append(h('span', { class: 'gvm-grow' }));
    if (st.state === 'running' || st.state === 'starting') bar.append(h('button', { class: 'gvm-chip gvm-kill', title: 'Stop the virtual computer at once (Ctrl+Shift+Backspace). Its disk stays.', onclick: () => run(() => ctx.api.vm.kill()) }, 'Kill'));
  }

  // ---------------------------------------------------------------- the cover
  function facts(rows) { return h('dl', { class: 'gvm-facts' }, rows.map(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])); }
  function drawCover() {
    if (!over) return;
    clear(over);
    if (!coverWanted || !st) { over.hidden = true; return; }
    over.hidden = false;
    const local = ctx.openLocal ? btn('Open the local terminal (advanced)', { onclick: () => ctx.openLocal(), title: 'A shell on THIS computer, outside the virtual computer. Asks first.' }) : null;
    const card = h('div', { class: 'gvm-card' });
    if (st.state === 'downloading') {
      const d = st.download || { doneBytes: 0, total: st.totalBytes || 1, item: '' };
      const pct = Math.min(100, Math.round(((d.doneBytes || 0) / (d.total || 1)) * 100));
      put(card, h('h2', { text: 'Downloading the virtual computer' }), h('div', { class: 'gvm-meter', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('i', { id: 'gvmFill' })),
        h('p', { text: pct + '%  ·  ' + mb(d.doneBytes || 0) + ' of ' + mb(d.total || 0) + (d.item ? '  ·  ' + ({ qemu: 'QEMU program', kernel: 'kernel', initrd: 'start-up files', disk: 'system image' }[d.item] || d.item) : '') }),
        h('p', { text: 'Each file is checked against its pinned SHA-256 before it is used. A file that does not match is deleted.' }),
        h('div', { class: 'gvm-actions' }, btn('Cancel', { onclick: () => run(() => ctx.api.vm.cancelInstall()) })));
      over.append(card);
      const fill = document.getElementById('gvmFill'); if (fill) fill.style.width = pct + '%';
      return;
    }
    if (st.state === 'not-installed' || st.state === 'unknown') {
      if (st.notPublished || (st.installNote && !st.missing.length)) {
        put(card, h('h2', { text: 'The virtual computer is not available yet' }), h('p', { text: st.installNote || 'No image has been published.' }), h('p', { text: 'Nothing was downloaded and nothing runs on this computer in its place.' }), h('div', { class: 'gvm-actions' }, btn('Check again', { onclick: () => run(() => ctx.api.vm.status().then(onStatus)) }), local));
      } else {
        put(card, h('h2', { text: 'Set up the Ghost virtual computer' }),
          h('p', { text: 'Ghost runs tools and a terminal inside a small Linux computer (Alpine) that lives in this window, not on your computer. It can see one shared folder for this case and nothing else of yours: no home folder, no clipboard, no devices.' }),
          facts([['Download', mb(st.totalBytes || 0) + ', once, from github.com'], ['Contains', 'the QEMU program and a Linux image with git, python, pip, node, go and build tools'], ['Checked', 'every file against a SHA-256 pinned in this app'], ['Network', 'through Tor by default (you can change it), or none']]),
          h('p', { class: 'gvm-note', text: 'The download goes straight to GitHub from your computer, so GitHub sees your IP address. No case data is involved.' }),
          st.error ? h('p', { class: 'gvm-err', text: st.error }) : null,
          h('div', { class: 'gvm-actions' }, btn('Download the virtual computer', { primary: true, onclick: () => run(() => ctx.api.vm.install()) }), local));
      }
      over.append(card); return;
    }
    if (st.state === 'starting' || st.state === 'stopping') {
      put(card, h('h2', { text: st.state === 'starting' ? 'Starting the virtual computer' : 'Stopping' }), h('div', { class: 'gvm-meter' }, h('i', { id: 'gvmFill' })),
        st.accel && !st.accel.fast ? h('p', { class: 'gvm-note', text: st.accel.notice }) : h('p', { text: 'This takes a few seconds with hardware virtualization.' }));
      over.append(card); const fill = document.getElementById('gvmFill'); if (fill) fill.style.width = '60%'; return;
    }
    if (st.state === 'stopped' || st.state === 'error') {
      put(card, h('h2', { text: 'The virtual computer is not running' }), st.error ? h('p', { class: 'gvm-err', text: st.error }) : h('p', { text: 'Start it to open a terminal.' }),
        h('div', { class: 'gvm-actions' }, btn('Start', { primary: true, onclick: () => start() }), btn('Reset it', { onclick: () => run(() => ctx.api.vm.reset()), title: 'Erase the machine\'s disk for this case and start clean. The shared folder and tools disk stay.' }), local));
      over.append(card);
    }
  }
  function start() { return run(() => ctx.api.vm.start({})); }

  // Resolves true when the machine is running, false when the person gives up (the cover stays up until they choose).
  function ensure() {
    return new Promise((resolve) => {
      coverWanted = true;
      const done = (v) => { coverWanted = false; drawCover(); resolve(v); };
      readyWaiters.push(done);
      ctx.api.vm.status().then((s) => { onStatus(s); if (s.state === 'stopped') start(); }).catch(() => done(false));
    });
  }

  // ---------------------------------------------------------------- the Tools panel
  function onStatus(s) {
    st = s; drawBar(); drawCover();
    if (st.state === 'running') { const w = readyWaiters.splice(0); w.forEach((f) => f(true)); }
    if (panelEl && !panelEl.contains(document.activeElement)) drawPanel();
  }
  function sec(title, ...kids) { return h('section', { class: 'gvm-sec' }, h('h3', { text: title }), kids); }
  function networkSec() {
    const cur = st.route.mode;
    const opt = (v, label, hint) => h('label', { class: 'gvm-radio' }, h('input', { type: 'radio', name: 'gvmnet', checked: cur === v, onchange: () => run(() => ctx.api.vm.network({ mode: v })) }), h('span', null, label, h('small', { text: hint })));
    return sec('Network', h('p', { text: 'The machine has no network card. Every connection is decided by Ghost, so a program that ignores proxy settings, and anything that is not TCP (ping, scans), cannot connect at all.' }),
      opt('tor', 'Through Tor (default)', 'Names are resolved at the exit. If Tor is not connected, connections are refused: there is no fallback.'),
      opt('direct-doh', 'Directly, with encrypted DNS', 'Sites see your real IP address. Ghost asks you to confirm in a native window.'),
      opt('none', 'No network', 'Everything is refused. Nothing leaves the machine.'),
      h('p', { text: 'Now: ' + (st.route.text || st.route.label) }),
      st.blocked && st.blocked.length ? h('pre', { class: 'gvm-pre', text: 'Recently refused:\n' + st.blocked.slice(-8).map((b) => b.host + ':' + b.port + ' ' + b.reason).join('\n') }) : null);
  }
  function caseSec() {
    const sel = h('select', { 'aria-label': 'Case', onchange: (e) => run(() => ctx.api.vm.useCase({ caseId: e.target.value })) }, [...new Set([st.caseId, ...(st.cases || [])])].map((c) => h('option', { value: c, selected: c === st.caseId }, c)));
    const inp = h('input', { type: 'text', placeholder: 'new case id (letters, digits, - _)', oninput: (e) => { caseNew = e.target.value; } }); inp.value = caseNew;
    return sec('Case and shared folder', h('p', { text: 'Each case has its own disk and its own shared folder. The machine sees only this folder, at /mnt/shared. It is an ordinary folder inside Ghost\'s data folder: it is not encrypted.' }),
      facts([['Case', st.caseId], ['Folder', (st.share && st.share.dir) || 'made when the machine starts']]), h('div', { class: 'gvm-row' }, sel, btn('Open folder', { disabled: !(st.share && st.share.dir), onclick: () => run(() => ctx.api.vm.openShare()) })),
      h('label', null, 'Switch to another case', inp), btn('Use this case', { disabled: false, onclick: () => { if (caseNew.trim()) run(() => ctx.api.vm.useCase({ caseId: caseNew.trim() })).then(() => { caseNew = ''; }); } }));
  }
  function resSec() {
    const cur = st.settings || {}, r = st.resources || {};
    res = res || { memMb: cur.memMb || r.memMb || 2048, cpus: cur.cpus || r.cpus || 2, diskGb: cur.diskGb || r.diskGb || 16 };
    const num = (label, k, lo, hi) => { const i = h('input', { type: 'text', inputmode: 'numeric', 'aria-label': label }); i.value = String(res[k]); i.addEventListener('input', () => { res[k] = Number(i.value); }); return h('label', null, label + ' (' + lo + ' to ' + hi + ')', i); };
    return sec('Resources', h('p', { text: 'Caps for the machine. Memory and processors apply the next time it starts; disk size only when a disk is made (after a Reset).' }), num('Memory, MB', 'memMb', 512, 8192), num('Processors', 'cpus', 1, 4), num('Disk, GB', 'diskGb', 4, 64),
      btn('Save caps', { onclick: () => run(() => ctx.api.vm.resources({ memMb: res.memMb, cpus: res.cpus, diskGb: res.diskGb })).then((r2) => { if (r2 && r2.ok) say('Saved. They apply the next time the machine starts.'); }) }));
  }
  function snapSec() {
    const list = st.snapshots || [];
    const i = h('input', { type: 'text', placeholder: 'snapshot name', 'aria-label': 'Snapshot name', oninput: (e) => { snapName = e.target.value; } }); i.value = snapName;
    return sec('Reset and snapshots', h('p', { text: 'Reset erases the machine\'s own disk (everything installed or saved inside it, apart from the tools disk) and starts clean. A snapshot saves the disk as it is now; taking or restoring one briefly stops the machine. Snapshots hold the disk, not running programs.' }),
      h('div', { class: 'gvm-row' }, btn('Reset the virtual computer', { danger: true, onclick: () => run(() => ctx.api.vm.reset()) })),
      list.length ? list.map((s) => h('div', { class: 'gvm-row' }, h('span', { class: 'gvm-tag', text: s.name }), s.t ? h('small', { text: new Date(s.t).toLocaleString() }) : null, btn('Restore', { onclick: () => run(() => ctx.api.vm.restore(s.name)) }), btn('Delete', { onclick: () => run(() => ctx.api.vm.deleteSnapshot(s.name)) }))) : h('p', { text: 'No snapshots yet.' }),
      h('label', null, 'New snapshot', i), btn('Take snapshot', { onclick: () => { if (snapName.trim()) run(() => ctx.api.vm.snapshot(snapName.trim())).then((r) => { if (r && r.ok) snapName = ''; }); } }));
  }
  function ghSec() {
    const url = h('input', { type: 'text', placeholder: 'https://github.com/owner/repo', 'aria-label': 'GitHub repository address' });
    const ref = h('input', { type: 'text', placeholder: 'tag, branch or commit (optional)', 'aria-label': 'Tag, branch or commit' });
    const out = h('div', { class: 'gvm-sec', style: 'border:0;padding:0;margin:0' });
    const go = async () => {
      if (ghBusy) return; ghBusy = true; clear(out).append(h('p', { text: 'Cloning inside the virtual computer…' }));
      const r = await run(() => ctx.api.vm.gh.clone({ url: url.value.trim(), ...(ref.value.trim() ? { ref: ref.value.trim() } : {}) }));
      ghBusy = false; gh = r && r.ok ? r : null; clear(out);
      if (!r) return;
      if (!r.ok) { out.append(h('p', { class: 'gvm-err-t', text: r.error })); return; }
      out.append(h('p', { text: 'Cloned ' + r.source.repo + ' at commit ' + r.commit + ' into ' + r.dir + (r.replaced ? ' (replaced the earlier copy)' : '') + '. Nothing has been run.' }),
        r.licenceFile ? h('pre', { class: 'gvm-pre', text: r.licenceFile.name + '\n' + r.licenceFile.text.slice(0, 600) }) : h('p', { class: 'gvm-err-t', text: 'No licence file found. Check the licence before you use it.' }),
        r.readme ? h('pre', { class: 'gvm-pre', text: r.readme.name + '\n' + r.readme.text.slice(0, 1500) }) : null,
        r.detected.length ? h('p', { text: 'Looks like: ' + r.detected.join(', ') + '. Commands built from fixed steps, shown for you to read:' }) : h('p', { text: 'Ghost could not tell what kind of project this is. Read the README above and type the commands yourself.' }),
        r.suggestions.map((s) => h('div', { class: 'gvm-cmd' }, h('div', null, h('b', { text: s.label }), h('code', { text: s.command }), s.note ? h('small', { text: s.note }) : null),
          h('div', { class: 'gvm-actions' }, btn('Copy', { onclick: () => navigator.clipboard.writeText(s.command).then(() => say('Copied.'), () => say('Could not copy.')) }), btn('Type at prompt', { title: 'Types the command at the prompt without pressing Enter', onclick: async () => { const c = await run(() => ctx.api.vm.gh.show({ name: r.name, id: s.id })); if (c && c.ok && ctx.typeInto) { ctx.typeInto(c.command); say('Typed at the prompt. Press Enter to run it.'); } } })))));
    };
    return sec('Run from GitHub', h('p', { text: 'Paste a repository address. Ghost clones one commit into the virtual computer and pins it. It never runs anything for you.' }), h('label', null, 'Repository', url), h('label', null, 'Tag, branch or commit', ref), btn('Clone and look', { primary: true, onclick: go }), out);
  }
  function toolsSec() {
    return sec('Tools', h('p', { text: 'Tools you add in Ghost (Tool Integrations, "Add a tool") are kept on a separate disk inside the virtual computer, in /opt/ghost-tools. They survive a Reset. Wiping the disk removes them; connectors you registered stay listed but cannot run until the tools are added again.' }),
      btn('Wipe the tools disk', { danger: true, onclick: () => run(() => ctx.api.vm.wipeTools()) }));
  }
  function logSec() {
    const pre = h('pre', { class: 'gvm-pre', text: log || '' }); pre.hidden = !log;
    return sec('Boot log', btn(log ? 'Refresh the log' : 'Show the boot log', { onclick: async () => { const r = await run(() => ctx.api.vm.log()); if (r && r.ok) { log = (r.errors ? 'QEMU said:\n' + r.errors + '\n\n' : '') + (r.boot || '(empty)'); drawPanel(); } } }), pre);
  }
  function advSec() {
    return sec('Advanced', h('p', { text: 'The local terminal is a shell on THIS computer, with your files and network and none of the virtual computer\'s protection. Ghost asks you to confirm every time.' }), ctx.openLocal ? btn('Open the local terminal', { onclick: () => ctx.openLocal() }) : null);
  }
  function drawPanel() {
    if (!panelEl || !st) return;
    clear(panelEl);
    const stateRow = h('div', { class: 'gvm-row' }, h('span', { class: 'gvm-tag ' + ((STATE[st.state] || [''])[0]), text: (STATE[st.state] || STATE.unknown)[1] }),
      st.state === 'stopped' ? btn('Start', { primary: true, onclick: start }) : null, st.state === 'running' ? btn('Stop', { onclick: () => run(() => ctx.api.vm.stop()) }) : null);
    put(panelEl, h('section', { class: 'gvm-sec' }, h('h3', { text: 'Virtual computer' }), stateRow, st.error ? h('p', { class: 'gvm-err-t', text: st.error }) : null,
      st.accel ? h('p', { text: (st.accel.fast ? 'Accelerated with ' : 'Software emulation: ') + st.accel.label + (st.accel.fast ? '.' : '. ' + st.accel.notice) }) : h('p', { text: 'The accelerator is checked when the machine first starts.' }),
      st.disk ? h('p', { text: st.disk.note }) : null), networkSec(), caseSec(), resSec(), snapSec(), ghSec(), toolsSec(), logSec(), advSec());
  }
  // The person chose something else (the advanced local terminal): stop waiting.
  function cancel() { const w = readyWaiters.splice(0); coverWanted = false; drawCover(); w.forEach((f) => f(false)); }
  function mountPanel(panel) { panelEl = panel; res = null; drawPanel(); ctx.api.vm.snapshots().catch(() => {}); }
  function unmountPanel() { panelEl = null; }

  function init(c) {
    ctx = c; bar = document.getElementById('vmbar'); over = document.getElementById('vmover');
    c.api.onVm(onStatus);
    return c.api.vm.status().then(onStatus, () => {});
  }
  root.GhostVmUI = { init, ensure, cancel, mountPanel, unmountPanel, status: () => st };
})(window);
