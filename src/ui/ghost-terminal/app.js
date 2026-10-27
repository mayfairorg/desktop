// Ghost terminal window. Text reaches the shell only from key presses and pastes made in this window (and the terminal never answers
// the shell's queries on its own). Output is drawn from a screen model into rows of spans using textContent only.
(function () {
  'use strict';
  const { h, clear } = window.GhostDom;
  const { Screen, xterm256 } = window.GhostVT;
  const { encode } = window.GhostKeys;
  const { LineEditor } = window.GhostLine;
  const api = window.ghostTerm;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), tabsEl = $('tabs'), sink = $('sink'), notice = $('notice');
  const tabs = [];
  let active = null, info = null, fontPx = 14, cell = { w: 8, h: 17 }, raf = 0;
  try { const f = +localStorage.getItem('gt-font'); if (f >= 10 && f <= 28) fontPx = f; } catch { /* storage unavailable */ }

  const probe = h('span', { class: 'probe' }, 'W'.repeat(40)); stage.append(probe);
  function measure() {
    document.documentElement.style.setProperty('--gt-fs', fontPx + 'px');
    const r = probe.getBoundingClientRect();
    cell = { w: Math.max(4, r.width / 40), h: Math.max(8, r.height) };
  }
  function gridSize() {
    const r = stage.getBoundingClientRect();
    return { cols: Math.max(10, Math.min(500, Math.floor((r.width - 20) / cell.w))), rows: Math.max(2, Math.min(200, Math.floor((r.height - 16) / cell.h))) };
  }

  // ----- notices -----
  function say(text, actions) {
    clear(notice); notice.hidden = false;
    notice.append(h('span', { class: 'grow', text }));
    for (const a of actions || [{ label: 'Dismiss', run: () => { notice.hidden = true; } }]) notice.append(h('button', { class: 'btn line', onclick: () => { notice.hidden = true; a.run(); } }, a.label));
  }
  window.ghostSay = say;

  // ----- rendering -----
  function styleAttrs(scr, id, span) {
    const a = scr.describe(id);
    let fg = a.fg, bg = a.bg;
    if (a.r) { const t = fg; fg = bg === -1 ? 'bg' : bg; bg = t === -1 ? 'fg' : t; }
    const cls = [];
    if (a.b) cls.push('b'); if (a.d) cls.push('d'); if (a.i) cls.push('i'); if (a.u) cls.push('u'); if (a.s) cls.push('s');
    const col = (c, prop) => {
      if (c === 'bg') span.style[prop] = 'var(--gt-bg)'; else if (c === 'fg') span.style[prop] = 'var(--gt-fg)';
      else if (typeof c === 'number' && c >= 0 && c < 16) span.style[prop] = 'var(--c' + c + ')';
      else if (typeof c === 'number' && c >= 16) span.style[prop] = xterm256(c);
      else if (typeof c === 'string') span.style[prop] = c;
    };
    if (fg !== -1) col(fg, 'color'); if (bg !== -1) col(bg, 'backgroundColor');
    if (cls.length) span.className = cls.join(' ');
  }
  function paintRow(t, rowEl, line, curX) {
    clear(rowEl);
    const scr = t.screen;
    for (const run of scr.runs(line)) {
      if (curX >= 0 && curX >= run.x && curX < run.x + [...run.text].length) {
        // split the run around the cursor cell
        const chars = [...run.text]; const k = curX - run.x;
        const mk = (txt, cur) => { if (!txt) return; const s = document.createElement('span'); s.textContent = txt; styleAttrs(scr, run.st, s); if (cur) s.classList.add('cur'); rowEl.append(s); };
        mk(chars.slice(0, k).join('')); mk(chars[k], true); mk(chars.slice(k + 1).join(''));
      } else { const s = document.createElement('span'); s.textContent = run.text; if (run.st) styleAttrs(scr, run.st, s); rowEl.append(s); }
    }
    if (!rowEl.firstChild) rowEl.append(document.createTextNode('​'));
  }
  function render(t) {
    const scr = t.screen;
    while (t.rowEls.length < scr.rows) { const r = h('div', { class: 'row' }); t.el.append(r); t.rowEls.push(r); t.cache.push(null); }
    while (t.rowEls.length > scr.rows) { t.rowEls.pop().remove(); t.cache.pop(); }
    const base = scr.total - scr.rows - t.offset;
    const curRow = t.offset === 0 && scr.showCursor && !t.exited ? scr.y : -1;
    for (let r = 0; r < scr.rows; r++) {
      const line = scr.line(base + r);
      const cx = r === curRow ? scr.x : -1;
      const c = t.cache[r];
      if (c && c.line === line && c.v === line.v && c.cx === cx) continue;
      paintRow(t, t.rowEls[r], line, cx);
      t.cache[r] = { line, v: line.v, cx };
    }
  }
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (active) render(active); }); }

  // ----- tabs -----
  function drawTabs() {
    clear(tabsEl);
    tabs.forEach((t, i) => tabsEl.append(h('div', { class: 'tab', role: 'tab', 'aria-selected': t === active, tabindex: '-1', onclick: () => select(t) },
      h('span', { class: 't', text: (t.screen.title || t.shell || 'shell') + (t.exited ? ' (ended)' : '') }), h('button', { class: 'x', 'aria-label': 'Close terminal', onclick: (e) => { e.stopPropagation(); closeTab(t); } }, '×'))));
  }
  function select(t) {
    active = t;
    for (const x of tabs) x.el.classList.toggle('on', x === t);
    $('empty').hidden = true;
    fit(t); drawTabs(); schedule(); sink.focus();
    $('fMode').textContent = t.mode === 'pty' ? 'Terminal: full' : t.mode === 'python' ? 'Terminal: full (Python helper)' : 'Terminal: basic';
    $('fShell').textContent = 'Shell: ' + t.shell;
  }
  function fit(t) {
    const g = gridSize();
    if (g.cols === t.screen.cols && g.rows === t.screen.rows) return;
    t.screen.resize(g.cols, g.rows);
    api.resize(t.id, g.cols, g.rows).catch(() => {});
    t.cache = t.cache.map(() => null);
  }
  async function newTab() {
    measure();
    const g = gridSize();
    let r;
    try { r = await api.open(g.cols, g.rows); } catch (e) { say('Could not start a shell: ' + String(e.message || e).replace(/^Error: /, '')); return; }
    const t = { id: r.id, mode: r.mode, shell: r.shell, screen: new Screen(g.cols, g.rows, { convertEol: r.mode === 'basic' }), el: h('div', { class: 'screen', role: 'log', 'aria-label': 'Terminal output' }), rowEls: [], cache: [], offset: 0, exited: false, editor: r.mode === 'basic' ? new LineEditor() : null, editing: null };
    t.el.addEventListener('mousedown', () => setTimeout(() => { if (!String(getSelection())) sink.focus(); }, 0));
    t.el.addEventListener('wheel', (e) => { e.preventDefault(); const max = t.screen.scrollback.length; t.offset = Math.max(0, Math.min(max, t.offset + (e.deltaY < 0 ? 3 : -3))); schedule(); }, { passive: false });
    stage.append(t.el); tabs.push(t); select(t);
    if (r.mode === 'basic') say('Basic terminal: this computer has no way to give the shell a real terminal (no node-pty, no Python). Commands work, but full-screen programs (vim, less) and some prompts will not. Ctrl+C stops the running command on macOS and Linux only.');
  }
  function closeTab(t) {
    api.close(t.id).catch(() => {});
    remove(t);
  }
  function remove(t) {
    const i = tabs.indexOf(t); if (i < 0) return;
    tabs.splice(i, 1); t.el.remove();
    if (active === t) { active = null; if (tabs.length) select(tabs[Math.max(0, i - 1)]); else { drawTabs(); newTab(); } } else drawTabs();
  }
  const byId = (id) => tabs.find((t) => t.id === id);

  api.onData(({ id, data }) => {
    const t = byId(id); if (!t) return;
    t.screen.write(data); api.ack(id, data.length).catch(() => {});
    if (t.screen.title !== t.lastTitle) { t.lastTitle = t.screen.title; drawTabs(); }
    if (t.editing && t.editor.buf === '') t.editing = null;
    t.offset = 0;
    if (t === active) schedule();
  });
  api.onExit(({ id, code, signal }) => {
    const t = byId(id); if (!t) return;
    t.exited = true;
    t.screen.write('\r\n[process ended' + (code !== null && code !== undefined ? ' with code ' + code : signal ? ' (' + signal + ')' : '') + ']  Press Enter to close this tab.\r\n');
    drawTabs(); if (t === active) schedule();
  });

  // ----- keyboard, paste, copy -----
  const send = (t, data) => api.input(t.id, data).catch(() => {});
  function typeBasic(t, e) {
    const scr = t.screen;
    const r = t.editor.feed(e);
    if (r.clear) { scr.write('\x1b[2J\x1b[H'); }
    if (r.interrupt) { scr.write('^C\r\n'); t.editing = null; api.interrupt(t.id).catch(() => {}); return; }
    if (r.eof) { closeTab(t); return; }
    if (!t.editing) t.editing = { x: scr.x };
    const ed = t.editor;
    if (r.send !== undefined) {
      r.send.split('\n').slice(0, -1).forEach((ln, i) => scr.write('\x1b[' + ((i === 0 ? t.editing.x : 0) + 1) + 'G' + ln + '\x1b[K\r\n'));
      t.editing = null;
      send(t, r.send);
    } else if (r.redraw) {
      scr.write('\x1b[' + (t.editing.x + 1) + 'G' + ed.buf + '\x1b[K\x1b[' + (t.editing.x + 1 + ed.pos) + 'G');
    }
  }
  function sendPaste(t, text) {
    if (t.mode === 'basic') return typeBasic(t, { text });
    send(t, t.screen.bracketed ? '\x1b[200~' + text + '\x1b[201~' : text.replace(/\r?\n/g, '\r'));
  }
  const isMac = /Mac/i.test(navigator.platform);
  sink.addEventListener('keydown', (e) => {
    const t = active; if (!t) return;
    if (e.isComposing) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (t.exited) { if (e.key === 'Enter') { e.preventDefault(); closeTab(t); } return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') { e.preventDefault(); newTab(); return; }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') { e.preventDefault(); closeTab(t); return; }
    const sel = String(getSelection());
    if ((isMac && e.metaKey && e.key === 'c') || (!isMac && e.ctrlKey && (e.shiftKey || sel) && e.key.toLowerCase() === 'c' && sel) || (e.ctrlKey && e.key === 'Insert' && sel)) { e.preventDefault(); navigator.clipboard.writeText(sel).catch(() => {}); return; }
    if ((e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'v') || (mod && e.key.toLowerCase() === 'v') || (e.shiftKey && e.key === 'Insert')) return;       // the paste event does the rest
    if (e.shiftKey && e.key === 'PageUp') { e.preventDefault(); t.offset = Math.min(t.screen.scrollback.length, t.offset + t.screen.rows - 1); schedule(); return; }
    if (e.shiftKey && e.key === 'PageDown') { e.preventDefault(); t.offset = Math.max(0, t.offset - t.screen.rows + 1); schedule(); return; }
    if (t.mode === 'basic') {
      const ev = { key: e.key, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey };
      if (e.metaKey || (e.key.length > 1 && !/^(Enter|Backspace|Delete|Arrow(Left|Right|Up|Down)|Home|End)$/.test(e.key))) return;
      e.preventDefault(); t.offset = 0; typeBasic(t, ev); schedule(); return;
    }
    const data = encode(e, { appCursor: t.screen.appCursor });
    if (data === null) return;
    e.preventDefault(); t.offset = 0; send(t, data);
  });
  sink.addEventListener('compositionend', (e) => { const t = active; if (t && !t.exited && e.data) { if (t.mode === 'basic') typeBasic(t, { text: e.data }); else send(t, e.data); } sink.value = ''; });
  sink.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = active; if (!t || t.exited) return;
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (!text || text.length > 60000) { if (text) say('That paste is too large (limit 60,000 characters).'); return; }
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
    if (lines > 1) {
      // a pasted newline runs a command: ask first, and show what would run
      say('Paste ' + lines + ' lines into the terminal? Each line runs when it reaches the shell.\n' + text.slice(0, 400) + (text.length > 400 ? '\n...' : ''), [{ label: 'Paste', run: () => { sendPaste(t, text); sink.focus(); } }, { label: 'Cancel', run: () => sink.focus() }]);
      return;
    }
    sendPaste(t, text);
  });
  sink.addEventListener('input', () => { sink.value = ''; });
  sink.addEventListener('focus', () => { if (active) active.el.classList.add('focus'); });
  sink.addEventListener('blur', () => { if (active) active.el.classList.remove('focus'); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // ----- chrome -----
  $('newTab').addEventListener('click', () => newTab());
  const setFont = (d) => { fontPx = Math.max(10, Math.min(28, fontPx + d)); try { localStorage.setItem('gt-font', String(fontPx)); } catch { /* ignore */ } measure(); for (const t of tabs) { t.cache = t.cache.map(() => null); } if (active) { fit(active); schedule(); } };
  $('fontDown').addEventListener('click', () => setFont(-1));
  $('fontUp').addEventListener('click', () => setFont(1));
  const panel = $('panel');
  $('toolsBtn').addEventListener('click', () => {
    panel.hidden = !panel.hidden; $('toolsBtn').setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) window.GhostToolsUI.mount(panel, { api, info: () => info, refreshInfo }); else sink.focus();
    setTimeout(() => { if (active) { fit(active); schedule(); } }, 0);
  });
  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => { if (active) { fit(active); schedule(); } }, 40); }).observe(stage);
  async function refreshInfo() { try { info = await api.info(); } catch { /* shown by the panel */ } return info; }
  window.addEventListener('focus', () => sink.focus());

  (async () => { measure(); await refreshInfo(); await newTab(); })();
})();
