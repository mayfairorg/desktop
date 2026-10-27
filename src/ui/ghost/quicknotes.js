'use strict';
// Ghost Quick notes: the drawer. One piece of page code, two places it can live:
//   - docked at the side of the Ghost window (GH.qn.attach, opened from the top bar or Ctrl+Shift+N), and
//   - in its own small always-on-top window (quicknotes.html), so the person can paste from the Ghost browser, the terminal, a viewer, any window.
// Everything the person pastes or drops becomes a clip: plain text, rich text (sanitised: see qn-model.js), a link, a picture or a file. A clip keeps where it
// came from (when Ghost knows), the time and an item hash. Tabs, highlights, tags, pins, search and undo all work on the note document (qn-model.js);
// the document and its pictures are saved by main into the vault, sealed. Nothing here uses the network. The page draws with textContent only.
(function () {
  const GH = (window.GH = window.GH || {}), N = window.GhostNotes, h = GH.h;
  const SVG = 'http://www.w3.org/2000/svg';
  const COLOR_NAMES = { yellow: 'Yellow', green: 'Green', blue: 'Blue', red: 'Red', grey: 'Grey' };
  const KIND_LABEL = { text: 'Text', rich: 'Rich text', link: 'Link', image: 'Picture', file: 'File' };
  const KIND_ICON = { text: 'text', rich: 'text', link: 'link', image: 'image', file: 'file' };
  const SHORTCUTS = [
    ['Ctrl Shift N', 'Quick notes: open or close the drawer'], ['Ctrl V', 'Paste into the open note (text, rich text, links, pictures)'], ['Ctrl Shift V', 'Paste as plain text'], ['Ctrl Shift O', 'Pop the notes out into their own window, or dock them back'],
    ['Ctrl T / Ctrl W', 'New tab, close tab'], ['Ctrl Shift T', 'Restore the tab you closed last'], ['Ctrl PageUp / PageDown', 'Previous and next tab (Alt 1 to 9 jumps)'], ['F2', 'Rename the tab'], ['Ctrl Shift Left / Right', 'Move the tab'],
    ['Ctrl F or /', 'Search every tab (tag:x color:red kind:image is:pinned)'], ['Up Down or J K', 'Move between clips'], ['1 to 5, U, 0', 'On a clip: highlight the selection (or the whole clip), underline, clear highlights'],
    ['M, G, P, S, C', 'On a clip: comments, tag, pin, send to the case, copy'], ['Delete', 'Delete the clip (Ctrl Z brings it back)'], ['Ctrl Z / Ctrl Shift Z', 'Undo and redo in the notes'], ['Escape', 'Clear search, or close the drawer'],
  ];

  // ---------- icons: plain strokes in the text colour, drawn here so the pop-out window needs nothing from the Ghost page ----------
  const ICONS = {
    note: ['M6 4h12v16H6zM9 9h6M9 13h6M9 17h3'], paste: ['M9 4.5h6V7H9zM7 6H6a1 1 0 0 0-1 1v12.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1M9 12h6M9 15.5h4'],
    capture: ['M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16', { c: [12, 12, 3] }],
    undo: ['M9 7 4.5 11.5 9 16M5 11.5h8a6 6 0 0 1 6 6'], redo: ['m15 7 4.5 4.5L15 16M19 11.5h-8a6 6 0 0 0-6 6'],
    popout: ['M14 5h5v5M19 5l-8 8M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'], dock: ['M3.5 6.5A1.5 1.5 0 0 1 5 5h14a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5zM15 5v14'],
    x: ['M6 6l12 12M18 6 6 18'], plus: ['M12 5v14M5 12h14'], search: [{ c: [10.5, 10.5, 6] }, 'm15 15 5 5'],
    pin: ['m14.5 4 5.5 5.5-3 .8-3 3 .6 4.2-1.4 1.4-3.5-3.5-5 5M9.5 8.5l-.7 3-2.8-.5 8-6.5'], tag: ['M3.5 12V4.5H11L20.5 14 14 20.5z', { c: [8, 9, 1.2] }],
    trash: ['M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.5 7M10 10.5v5.5M14 10.5v5.5'], copy: ['M8.5 8.5h9a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 7 19v-9a1.5 1.5 0 0 1 1.5-1.5zM5 15.5h-.5A1.5 1.5 0 0 1 3 14V5.5A1.5 1.5 0 0 1 4.5 4H13a1.5 1.5 0 0 1 1.5 1.5V6'],
    send: ['m4 11.5 16-7-6.5 16-2.5-6.5z'], underline: ['M7 4.5v7a5 5 0 0 0 10 0v-7M5 20h14'], comment: ['M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
    eraser: ['M8 20h11M5.5 14.5 14 6l5 5-8 8H8.5zM9.5 10.5l5 5'], link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1'],
    image: [{ r: [3.5, 5, 17, 14, 2] }, { c: [9, 10, 1.6] }, 'm4 17 5-4.5 3.5 3L15.5 13l4.5 4.5'], file: ['M6 3.5h8l4 4V20.5H6zM14 3.5v4h4'], text: ['M5 6h14M5 10h14M5 14h14M5 18h9'],
    edit: ['M4 20l1-4L16 5l3 3L8 19zM14 7l3 3'], restore: ['M5 8a8 8 0 1 1-1 5M5 4v4h4'], save: ['M12 4v11m0 0-4-4m4 4 4-4M5 19.5h14'], check: ['m5 12.5 4.5 4.5L19 7.5'],
    screen: ['M4.5 5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 20h6M12 16v4'], lock: [{ r: [5, 10.5, 14, 10, 2] }, 'M8 10.5V8a4 4 0 0 1 8 0v2.5'],
    globe: [{ c: [12, 12, 8.5] }, 'M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5S9.4 5.9 12 3.5Z'], more: [{ c: [6, 12, 1.2] }, { c: [12, 12, 1.2] }, { c: [18, 12, 1.2] }],
  };
  function ensureSprite() {
    if (document.getElementById('qn-sprite')) return;
    const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('id', 'qn-sprite'); svg.setAttribute('class', 'qn-sprite'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    const defs = document.createElementNS(SVG, 'defs'); svg.append(defs);
    for (const [name, parts] of Object.entries(ICONS)) {
      const sym = document.createElementNS(SVG, 'symbol'); sym.setAttribute('id', 'i-qn-' + name); sym.setAttribute('viewBox', '0 0 24 24');
      for (const p of parts) {
        let el;
        if (typeof p === 'string') { el = document.createElementNS(SVG, 'path'); el.setAttribute('d', p); }
        else if (p.c) { el = document.createElementNS(SVG, 'circle'); el.setAttribute('cx', p.c[0]); el.setAttribute('cy', p.c[1]); el.setAttribute('r', p.c[2]); }
        else { el = document.createElementNS(SVG, 'rect'); [, 'x', 'y', 'width', 'height', 'rx'].forEach((k, i) => { if (k) el.setAttribute(k, p.r[i - 1]); }); }
        el.setAttribute('fill', 'none'); el.setAttribute('stroke', 'currentColor'); el.setAttribute('stroke-width', '1.6'); el.setAttribute('stroke-linecap', 'round'); el.setAttribute('stroke-linejoin', 'round'); sym.append(el);
      }
      defs.append(sym);
    }
    document.body.append(svg);
  }
  const ic = (n) => GH.icon('qn-' + n);
  const ibtn = (name, label, onclick, o = {}) => h('button', { type: 'button', class: 'btn ghost icon qn-ib' + (o.cls ? ' ' + o.cls : ''), title: label, 'aria-label': label, onclick, onmousedown: o.keepSel ? (e) => e.preventDefault() : null, 'aria-pressed': o.pressed === undefined ? null : String(!!o.pressed), disabled: o.disabled, dataset: o.data || {} }, ic(name));
  const tbtn = (name, label, onclick, o = {}) => h('button', { type: 'button', class: 'btn ghost qn-tb' + (o.cls ? ' ' + o.cls : ''), title: o.title || label, onclick, disabled: o.disabled, onmousedown: o.keepSel ? (e) => e.preventDefault() : null }, ic(name), h('span', {}, label));

  // ---------- state ----------
  const S = { scope: 'inbox', doc: null, hist: null, usage: null, limits: null, cases: [], q: '', open: false, popped: false, standalone: false, loaded: false, loading: null, error: null, root: null, els: {}, appEl: null, save: { state: 'idle', at: null, error: null }, dirty: false, saving: Promise.resolve(true),
    focusId: null, lastSel: null, shown: 200, prevFocus: null, onTop: true, imgs: new Map(), theme: 'dark', saveTimer: null };
  const api = () => (GH.api && GH.api.notes) || null;
  const call = (fn, ...a) => GH.call(fn, ...a);
  const now = () => Date.now();
  const say = (m) => { if (GH.say) GH.say(m); };
  const toast = (m, k) => { if (GH.toast) GH.toast(m, k); };
  const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' bytes');
  const when = (iso) => { const d = new Date(iso); if (!Number.isFinite(d.getTime())) return ''; const t = new Date(), same = d.toDateString() === t.toDateString(); return same ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
    try { const t = h('textarea', { class: 'qn-copybuf', 'aria-hidden': 'true', tabindex: '-1' }); t.value = text; document.body.append(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return !!ok; } catch { return false; }
  }

  // ---------- loading, editing and saving the document ----------
  async function load(scope) {
    await flush(); const a = api(); if (!a) return;
    const my = (S.loading = Symbol('load'));
    S.error = null; S.scope = scope;
    try {
      const r = await call(a.get, scope);
      if (S.loading !== my) return;
      let doc = null; if (r.json) { try { doc = N.normalize(JSON.parse(r.json), scope); } catch { doc = null; } }
      S.doc = doc || N.newDoc(scope); S.hist = new N.History(S.doc); S.usage = r.usage; S.limits = r.limits; S.dirty = false; S.save = { state: r.json ? 'saved' : 'idle', at: S.doc.updated, error: null }; S.loaded = true; S.q = ''; S.shown = 200; S.imgs.clear();
      if (r.broken) toast('These notes could not be read. They were kept aside in the vault and a new note was started.', 'err');
    } catch (e) { if (S.loading !== my) return; S.doc = null; S.error = GH.errText(e); S.loaded = false; }
    drawAll();
  }
  function mutate(label, fn, o) {
    if (!S.doc) return null;
    const r = S.hist.run(label, fn, { ...(o || {}), now: now() }); S.dirty = true; schedule(); if (!(o && o.silent)) drawAll(); return r;
  }
  function schedule() { S.save = { ...S.save, state: 'pending' }; clearTimeout(S.saveTimer); S.saveTimer = setTimeout(() => { flush(); }, 500); drawFoot(); }
  function flush() {
    clearTimeout(S.saveTimer);
    S.saving = S.saving.then(async () => {
      if (!S.doc || !S.dirty) return true;
      const a = api(), doc = S.doc, scope = S.scope; let json; try { json = JSON.stringify(doc); } catch { return false; }
      S.dirty = false; S.save = { state: 'saving', at: S.save.at, error: null }; drawFoot();
      try { const r = await call(a.put, scope, json); S.save = { state: S.dirty ? 'pending' : 'saved', at: r.savedAt, error: null }; }
      catch (e) { S.dirty = true; S.save = { state: 'error', at: S.save.at, error: GH.errText(e) }; }
      drawFoot(); return S.save.state !== 'error';
    });
    return S.saving;
  }
  const tab = () => (S.doc ? N.activeTab(S.doc) : null);
  function undo() { if (!S.hist || !S.hist.canUndo()) return; const l = S.hist.undo(); S.dirty = true; schedule(); drawAll(); say('Undid: ' + l); }
  function redo() { if (!S.hist || !S.hist.canRedo()) return; const l = S.hist.redo(); S.dirty = true; schedule(); drawAll(); say('Redid: ' + l); }

  // ---------- getting things in: paste, drop, the clipboard button, capture ----------
  const MIME_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', htm: 'text/html', zip: 'application/zip', md: 'text/markdown' };
  const mimeOf = (f) => (f.type && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(f.type) ? f.type.toLowerCase() : MIME_BY_EXT[(String(f.name || '').split('.').pop() || '').toLowerCase()] || 'application/octet-stream');
  // A picture that is too big is scaled down (JPEG) before it is stored; anything else over the cap is refused.
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file); const k = Math.min(1, 3000 / Math.max(bmp.width, bmp.height)); const cv = document.createElement('canvas');
      cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k)); cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
      const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.82)); return blob && blob.size <= N.LIMITS.blobBytes ? new File([blob], String(file.name || 'image').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : null;
    } catch { return null; }
  }
  async function upload(file) {
    const a = api(); let f = file, mime = mimeOf(f);
    if (f.size > N.LIMITS.blobBytes) { const s = N.IMAGE_MIMES.includes(mime) ? await shrink(f) : null; if (!s) { toast((f.name || 'That file') + ' is larger than ' + fmtBytes(N.LIMITS.blobBytes) + ', the most one picture or file may take.', 'err'); return null; } f = s; mime = 'image/jpeg'; }
    const bytes = new Uint8Array(await f.arrayBuffer()); if (!bytes.length) return null;
    let w = 0, hh = 0; if (N.IMAGE_MIMES.includes(mime)) { try { const bmp = await createImageBitmap(new Blob([bytes], { type: mime })); w = bmp.width; hh = bmp.height; if (bmp.close) bmp.close(); } catch { /* size is optional */ } }
    const r = await call(a.blob.put, S.scope, bytes);
    return { name: f.name || (N.IMAGE_MIMES.includes(mime) ? 'image' : 'file'), mime, bytes: bytes.length, sha256: r.sha256, blob: r.id, w, h: hh };
  }
  async function getHint() { const a = api(); try { return await call(a.hint); } catch { return null; } }
  // p: { text, html, uris, files:[File|descriptor] }, o: { kind, from, title }
  async function ingest(p, o) {
    if (!S.doc) return;
    o = o || {};
    try {
      const files = []; for (const f of p.files || []) { const d = f.sha256 ? f : await upload(f); if (d) files.push(d); }
      const r = N.classifyPaste({ text: p.text || '', html: o.plain ? '' : p.html || '', uris: p.uris || [], files });
      if (!r.items.length) { toast(r.notes[0] || 'Nothing to paste.'); return; }
      const hint = o.from ? null : await getHint();
      const from = o.from || N.fromHint(hint, now(), o.kind);
      const clips = r.items.map((d) => { const c = N.makeClip(d, { from, now: now() }); if (o.title && !c.title) c.title = o.title; return c; });
      const res = mutate(clips.length > 1 ? 'Add ' + clips.length + ' clips' : 'Add a clip', (d) => N.addClips(d, S.doc.active, clips, now()));
      if (res && res.error) toast(res.error, 'err');
      else if (res && res.added.length) { S.q = ''; S.focusId = res.added[res.added.length - 1].id; drawAll(); focusClip(S.focusId); toast(res.added.length === 1 ? 'Added to ' + tab().title + (from.auto ? ' (from ' + from.label + ')' : '') + '.' : 'Added ' + res.added.length + ' clips.'); for (const n of r.notes) toast(n); }
      else if (res && res.skipped.length) toast('That is already in this tab.');
    } catch (e) { toast(GH.errText(e), 'err'); }
  }
  function pasteEvent(e) {
    if (!S.root || !S.doc) return;
    const t = e.target, tag = t && t.tagName, cd = e.clipboardData; if (!cd) return;
    const files = [...(cd.files || [])];
    if (tag === 'TEXTAREA' && t === S.els.compose && !files.length && t.value.trim()) return;            // typing a note: a normal paste
    if ((tag === 'INPUT' || tag === 'SELECT' || (tag === 'TEXTAREA' && t !== S.els.compose))) return;
    e.preventDefault();
    ingest({ text: cd.getData('text/plain'), html: cd.getData('text/html'), uris: (cd.getData('text/uri-list') || '').split(/\r?\n/).filter((x) => x && x[0] !== '#'), files });
  }
  // The "Paste" button and Ctrl Shift V: main reads the clipboard (works without a paste gesture, and sees pictures from any program).
  async function pasteButton(plain) {
    if (!S.doc) return; const a = api();
    try { const r = await call(a.clipboard, S.scope); const files = r.image ? [{ name: 'Pasted picture', mime: r.image.mime, bytes: r.image.bytes, sha256: r.image.sha256, blob: r.image.blob, w: r.image.w, h: r.image.h }] : []; await ingest({ text: r.text, html: r.html, files }, { plain: plain === true }); }
    catch (e) { toast(GH.errText(e), 'err'); }
  }
  function dropEvent(e) {
    e.preventDefault(); S.root.classList.remove('qn-drop'); if (!S.doc) return;
    const dt = e.dataTransfer; if (!dt) return;
    const files = [...(dt.files || [])];
    if (files.length) { ingest({ files, text: '' }, { kind: 'dropped' }); return; }
    ingest({ text: dt.getData('text/plain'), html: dt.getData('text/html'), uris: (dt.getData('text/uri-list') || '').split(/\r?\n/).filter((x) => x && x[0] !== '#') }, { kind: 'dropped' });
  }
  async function addTyped() {
    const v = S.els.compose.value; if (!v.trim() || !S.doc) return;
    S.els.compose.value = ''; await ingest({ text: v }, { kind: 'typed' }); S.els.compose.focus();
  }
  async function captureDialog() {
    const a = api(); if (!S.doc) return;
    const grid = h('div', { class: 'qn-shots' }), note = h('p', { class: 'mute sm', role: 'status' }, '');
    const v = await GH.dialog({ title: 'Capture', sub: 'Take a picture into the open tab. It goes into the vault, nowhere else.', icon: 'qn-capture', width: 560,
      body: (close) => h('div', { class: 'stack' },
        h('div', { class: 'row-a' }, GH.btn('Ghost browser page', { icon: 'qn-globe', primary: true, onclick: () => close('browser') }),
          GH.btn('Screen or window', { icon: 'qn-screen', onclick: async () => { note.textContent = 'Looking for screens and windows.'; try { const list = await call(a.capture.sources); note.textContent = list.length ? 'Choose one.' : 'Nothing to capture was found.'; GH.clear(grid).append(list.map((s) => h('button', { type: 'button', class: 'qn-shot', onclick: () => close({ id: s.id, name: s.name, kind: s.kind }) }, h('img', { src: s.thumb, alt: '' }), h('span', {}, s.name)))); const f = grid.querySelector('button'); if (f) f.focus(); } catch (e) { note.textContent = GH.errText(e); } } })),
        note, grid),
      actions: [{ label: 'Cancel', value: null }] });
    if (!v) return;
    try {
      if (v === 'browser') {
        const c = GH.cs && GH.cs.current && GH.cs.current(); const r = await call(a.capture.browser, S.scope, c ? c.id : null);
        await ingest({ files: [{ name: r.title || 'Page', mime: r.file.mime, bytes: r.file.bytes, sha256: r.file.sha256, blob: r.file.blob, w: r.file.w, h: r.file.h }] }, { from: { kind: 'capture-browser', label: 'Ghost browser capture' + (r.title ? ': ' + r.title : ''), url: r.url, auto: true }, title: r.title || 'Page capture' });
      } else {
        const r = await call(a.capture.take, S.scope, v.id);
        await ingest({ files: [{ name: v.name, mime: r.file.mime, bytes: r.file.bytes, sha256: r.file.sha256, blob: r.file.blob, w: r.file.w, h: r.file.h }] }, { from: { kind: 'capture-screen', label: (v.kind === 'screen' ? 'Screen capture: ' : 'Window capture: ') + v.name, url: '', auto: true }, title: v.name });
      }
    } catch (e) { toast(GH.errText(e), 'err'); }
  }

  // ---------- drawing ----------
  function build() {
    if (S.root) return S.root;
    ensureSprite();
    const el = S.els;
    el.scope = h('select', { id: 'qn-scope', class: 'qn-scope', 'aria-label': 'Which case these notes belong to', onchange: () => load(el.scope.value) });
    el.head = h('header', { class: 'qn-h' });
    el.tabs = h('div', { class: 'qn-tabs', role: 'tablist', 'aria-label': 'Note tabs' });
    el.tabbar = h('div', { class: 'qn-tabbar' });
    el.search = h('input', { type: 'text', id: 'qn-q', class: 'qn-q', placeholder: 'Search every tab', 'aria-label': 'Search every tab', autocomplete: 'off', spellcheck: 'false', maxlength: '200', oninput: () => { S.q = el.search.value; S.shown = 200; drawList(); drawFoot(); } });
    el.hl = h('div', { class: 'qn-hl', role: 'group', 'aria-label': 'Highlight the selected text' });
    el.tools = h('div', { class: 'qn-tools' }, h('div', { class: 'qn-sw-wrap' }, ic('search'), el.search), el.hl);
    el.list = h('ul', { class: 'qn-list', role: 'list', 'aria-label': 'Clips' });
    el.compose = h('textarea', { id: 'qn-compose', class: 'qn-compose', rows: '2', maxlength: '8000', placeholder: 'Paste here, or type a note. Enter adds it.', 'aria-label': 'Type a note or paste anything', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); addTyped(); } } });
    el.foot = h('footer', { class: 'qn-f mono' });
    el.body = h('div', { class: 'qn-b' }, el.tools, el.list, h('form', { class: 'qn-cf', onsubmit: (e) => { e.preventDefault(); addTyped(); } }, el.compose, GH.btn('Add', { primary: true, type: 'submit', icon: 'qn-plus' })));
    el.state = h('div', { class: 'qn-state', hidden: true });
    S.root = h('aside', { class: 'qn' + (S.standalone ? ' qn-pop' : ''), id: 'qn', 'aria-label': 'Quick notes', hidden: !S.standalone },
      el.head, el.tabbar, el.state, el.body, el.foot);
    S.root.addEventListener('paste', pasteEvent);
    S.root.addEventListener('dragover', (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].some((t) => t === 'Files' || t === 'text/plain' || t === 'text/uri-list' || t === 'text/html')) { e.preventDefault(); S.root.classList.add('qn-drop'); } });
    S.root.addEventListener('dragleave', (e) => { if (!S.root.contains(e.relatedTarget)) S.root.classList.remove('qn-drop'); });
    S.root.addEventListener('drop', dropEvent);
    S.root.addEventListener('focusin', (e) => { const li = e.target.closest && e.target.closest('.qn-clip'); if (li) S.focusId = li.dataset.id; });
    S.root.addEventListener('click', bodyClick);
    document.addEventListener('selectionchange', trackSelection);
    return S.root;
  }
  function drawAll() { if (!S.root) return; drawHead(); drawTabs(); drawTools(); drawList(); drawFoot(); allTagList(); }
  function drawHead() {
    const el = S.els, a = api();
    GH.clear(el.head);
    const opts = [h('option', { value: 'inbox' }, 'No case (inbox)'), ...S.cases.filter((c) => c.id !== 'inbox').map((c) => h('option', { value: c.id }, c.title || 'Untitled case'))];
    GH.clear(el.scope).append(opts); el.scope.value = S.cases.some((c) => c.id === S.scope) || S.scope === 'inbox' ? S.scope : 'inbox';
    const can = !!S.doc && !S.popped;
    el.head.append(h('div', { class: 'qn-ht' }, ic('note'), h('h2', {}, 'Quick notes')),
      h('div', { class: 'qn-ha' },
        ibtn('paste', 'Paste from the clipboard (Ctrl Shift V)', () => pasteButton(false), { disabled: !can && !S.standalone }), ibtn('capture', 'Capture a page, screen or window', captureDialog, { disabled: !can && !S.standalone }),
        ibtn('undo', 'Undo (Ctrl Z)', undo, { disabled: !S.hist || !S.hist.canUndo() }), ibtn('redo', 'Redo (Ctrl Shift Z)', redo, { disabled: !S.hist || !S.hist.canRedo() }),
        S.standalone ? ibtn('pin', S.onTop ? 'Stop keeping this window on top' : 'Keep this window on top', toggleTop, { pressed: S.onTop }) : null,
        a && a.popout ? ibtn(S.standalone ? 'dock' : 'popout', S.standalone ? 'Dock the notes back into Ghost (Ctrl Shift O)' : 'Pop out into their own window (Ctrl Shift O)', togglePop) : null,
        S.standalone ? null : ibtn('x', 'Close Quick notes (Escape)', () => close())),
      h('div', { class: 'qn-hs' }, h('label', { for: 'qn-scope', class: 'sr' }, 'Case'), el.scope));
  }
  function drawTabs() {
    const el = S.els, d = S.doc; GH.clear(el.tabs); GH.clear(el.tabbar);
    if (!d) return;
    const act = d.active;
    el.tabs.append(d.tabs.map((t, i) => {
      const on = t.id === act;
      const b = h('button', { type: 'button', role: 'tab', class: 'qn-tab' + (on ? ' on' : ''), id: 'qn-tab-' + t.id, 'aria-selected': String(on), tabindex: on ? '0' : '-1', draggable: 'true', title: t.title + (t.report ? ' (in the report)' : ''), dataset: { tab: t.id },
        onclick: () => switchTab(t.id), ondblclick: () => renameTab(t.id),
        ondragstart: (e) => { S.dragTab = t.id; e.dataTransfer.setData('application/x-qn-tab', t.id); e.dataTransfer.effectAllowed = 'move'; },
        ondragover: (e) => { if (S.dragTab) { e.preventDefault(); e.stopPropagation(); } }, ondrop: (e) => { if (!S.dragTab) return; e.preventDefault(); e.stopPropagation(); const id = S.dragTab; S.dragTab = null; mutate('Move tab', (x) => N.moveTab(x, id, i, now())); },
        onkeydown: (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const j = Math.max(0, Math.min(d.tabs.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1))); if (!e.ctrlKey && !e.metaKey) { switchTab(d.tabs[j].id, true); } } else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); switchTab(d.tabs[e.key === 'Home' ? 0 : d.tabs.length - 1].id, true); } } },
      h('span', { class: 'qn-tt' }, t.title), t.report ? h('span', { class: 'qn-rp', title: 'Goes in the report' }, ic('check')) : null, h('span', { class: 'qn-tn mono' }, String(t.clips.length)));
      return h('div', { class: 'qn-tabw', role: 'presentation' }, b, d.tabs.length > 1 || t.clips.length ? h('button', { type: 'button', class: 'qn-tx', title: 'Close ' + t.title + ' (Ctrl W)', 'aria-label': 'Close tab ' + t.title, tabindex: '-1', onclick: (e) => { e.stopPropagation(); closeTab(t.id); } }, ic('x')) : null);
    }));
    const row = h('div', { class: 'qn-tabrow' }, el.tabs,
      ibtn('plus', 'New tab (Ctrl T)', () => newTab()),
      ibtn('edit', 'Tab options: rename, report, move', tabOptions),
      d.closed.length ? h('button', { type: 'button', class: 'btn ghost qn-closed', title: 'Closed tabs (Ctrl Shift T restores the last one)', onclick: closedDialog }, ic('restore'), h('span', {}, String(d.closed.length))) : null);
    el.tabbar.append(row);
    const on = el.tabs.querySelector('.qn-tab.on'); if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* old engine */ } }
  }
  function drawTools() {
    const el = S.els; GH.clear(el.hl);
    el.hl.append(...Object.keys(COLOR_NAMES).map((c, i) => h('button', { type: 'button', class: 'qn-sw qn-sw-' + c, title: COLOR_NAMES[c] + ' highlight (' + (i + 1) + ')', 'aria-label': 'Highlight ' + COLOR_NAMES[c].toLowerCase(), onmousedown: (e) => e.preventDefault(), onclick: () => applyHighlight(c, false) }, h('span', { class: 'qn-dot qn-c-' + c })))
      , ibtn('underline', 'Underline the selection (U)', () => applyHighlight(null, true), { keepSel: true }), ibtn('comment', 'Comment on a highlight (M)', () => commentDialog(), { keepSel: true }), ibtn('eraser', 'Clear highlights in the selection (0)', () => clearSel(), { keepSel: true }));
    if (el.search.value !== S.q) el.search.value = S.q;
  }
  function drawFoot() {
    const el = S.els; if (!el.foot) return; GH.clear(el.foot);
    const sv = S.save, st = { idle: '', pending: 'Changes not saved yet', saving: 'Saving', saved: sv.at ? 'Saved ' + when(sv.at) : 'Saved', error: 'Not saved: ' + sv.error }[sv.state] || '';
    const u = S.doc ? N.usage(S.doc) : null, lim = S.limits ? S.limits.scopeBytes : N.LIMITS.scopeBytes;
    el.foot.append(h('span', { class: 'qn-fs' + (sv.state === 'error' ? ' err' : ''), role: 'status' }, ic('lock'), st || 'Sealed in the vault'), u && u.blobs ? h('span', { class: 'qn-fu' }, fmtBytes(u.blobBytes) + ' of ' + fmtBytes(lim) + ' in pictures and files') : null, h('span', { class: 'qn-fn' }, 'Stays on this computer. No network.'));
  }
  function stateView(msg, actions) { const el = S.els; el.state.hidden = false; el.body.hidden = true; el.tabbar.hidden = true; GH.clear(el.state).append(ic('note'), h('p', {}, msg), actions || null); }
  function drawList() {
    const el = S.els; if (!el.list) return;
    if (S.popped && !S.standalone) { stateView('Quick notes is open in its own window.', h('div', { class: 'row-a' }, GH.btn('Bring it back here', { primary: true, onclick: () => togglePop() }))); return; }
    if (S.error) { stateView(S.error, GH.btn('Try again', { onclick: () => load(S.scope) })); return; }
    if (!S.doc) { stateView(S.loading ? 'Opening the notes.' : S.loaded ? '' : 'Quick notes needs the Ghost window.'); return; }
    el.state.hidden = true; el.body.hidden = false; el.tabbar.hidden = false;
    const keepScroll = el.list.scrollTop; const focusId = S.focusId && el.list.contains(document.activeElement) ? S.focusId : null;
    GH.clear(el.list);
    if (S.q.trim()) {
      const res = N.search(S.doc, S.q), byTab = new Map(); for (const r of res) { if (!byTab.has(r.tab)) byTab.set(r.tab, []); byTab.get(r.tab).push(r.clip); }
      el.list.append(h('li', { class: 'qn-count mono', role: 'status' }, res.length ? GH.plural(res.length, 'match', 'matches') + ' in ' + GH.plural(byTab.size, 'tab') : 'No clip matches. Try tag:name, color:red, kind:image or is:pinned.'));
      for (const t of S.doc.tabs) { const ids = byTab.get(t.id); if (!ids) continue; el.list.append(h('li', { class: 'qn-group', role: 'presentation' }, h('button', { type: 'button', class: 'btn ghost', onclick: () => { S.q = ''; switchTab(t.id); } }, 'In ' + t.title)));
        for (const id of ids) { const f = N.findClip(S.doc, id); if (f) el.list.append(clipCard(f.clip, f.tab)); } }
    } else {
      const t = tab(), all = t.clips.slice().sort((a, b) => (a.pinned === b.pinned ? (a.t < b.t ? 1 : a.t > b.t ? -1 : 0) : a.pinned ? -1 : 1));
      if (!all.length) el.list.append(h('li', { class: 'qn-empty' }, ic('note'), h('p', {}, 'This tab is empty.'), h('p', { class: 'mute sm' }, 'Copy anything, in Ghost, the Ghost browser, the terminal or another program, then press Ctrl V here. Drop files and pictures onto this panel. Capture takes a screenshot.')));
      for (const c of all.slice(0, S.shown)) el.list.append(clipCard(c, t));
      if (all.length > S.shown) el.list.append(h('li', { class: 'qn-more' }, GH.btn('Show ' + Math.min(200, all.length - S.shown) + ' more', { onclick: () => { S.shown += 200; drawList(); } })));
    }
    el.list.scrollTop = keepScroll; if (focusId) focusClip(focusId, true);
  }
  function focusClip(id, quiet) { const li = S.els.list && S.els.list.querySelector('.qn-clip[data-id="' + id + '"]'); if (li) { li.focus({ preventScroll: !!quiet }); if (!quiet && li.scrollIntoView) { try { li.scrollIntoView({ block: 'nearest' }); } catch { /* old engine */ } } } }

  // text with its highlights: every piece is a span that knows where it starts, so a selection can be turned back into offsets
  function segs(str, start, c) {
    return N.coverage(start, start + str.length, c.hl).map((p) => {
      const st = N.pieceStyle(p.hl), cm = p.hl.map((x) => x.comment).filter(Boolean).join('\n');
      return h('span', { class: p.hl.length ? 'qn-m' + (st.color ? ' qn-c-' + st.color : '') + (st.u ? ' qn-u' : '') + (cm ? ' qn-has-c' : '') : null, dataset: Object.assign({ o: String(p.a) }, p.hl.length ? { hl: p.hl.map((x) => x.id).join(' ') } : {}), title: cm || null }, str.slice(p.a - start, p.b - start));
    });
  }
  function renderTree(nodes, ctx, c) {
    const out = [];
    for (const x of nodes) {
      if (typeof x === 'string') { out.push(...segs(x, ctx.off, c)); ctx.off += x.length; continue; }
      const el = h(x.t === 'a' ? 'span' : x.t, x.t === 'a' ? { class: 'qn-a', title: x.a && x.a.href ? x.a.href : null, dataset: { url: x.a && x.a.href ? x.a.href : '' } } : {});
      el.append(...renderTree(x.c || [], ctx, c)); out.push(el);
    }
    return out;
  }
  function blobImage(c) {
    const key = S.scope + ':' + c.image.blob, img = h('img', { class: 'qn-img', alt: c.title || 'Pasted picture', width: c.image.w || null, height: c.image.h || null, loading: 'lazy', onclick: (e) => { e.stopPropagation(); img.classList.toggle('qn-big'); } });
    const wrap = h('div', { class: 'qn-pic' }, h('span', { class: 'mute sm' }, 'Opening the picture.'));
    const put = (url) => { GH.clear(wrap).append(img); img.src = url; };
    if (S.imgs.has(key)) put(S.imgs.get(key));
    else call(api().blob.get, S.scope, c.image.blob).then((bytes) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(new Blob([bytes], { type: c.image.mime })); })).then((url) => { if (S.imgs.size > 40) S.imgs.delete(S.imgs.keys().next().value); S.imgs.set(key, url); put(url); }).catch((e) => { GH.clear(wrap).append(h('span', { class: 'err sm' }, GH.errText(e))); });
    return wrap;
  }
  function clipBody(c) {
    if (c.kind === 'image') return blobImage(c);
    if (c.kind === 'file') return h('div', { class: 'qn-file' }, ic('file'), h('div', {}, h('b', {}, c.file.name), h('div', { class: 'mono mute sm' }, c.file.mime + ', ' + fmtBytes(c.file.bytes))));
    const body = h('div', { class: 'qn-body' + (c.kind === 'rich' ? ' qn-rich' : ' qn-plain'), tabindex: '-1', dataset: { clip: c.id } });
    if (c.kind === 'rich') body.append(...renderTree(c.tree, { off: 0 }, c)); else body.append(...segs(c.text, 0, c));
    if (c.kind === 'link') return h('div', { class: 'qn-linkw' }, h('div', { class: 'qn-a qn-lt', dataset: { url: c.url } }, ic('link'), c.title || c.url), body);
    return body;
  }
  function clipCard(c, t) {
    const nm = c.title || KIND_LABEL[c.kind] + ' from ' + when(c.t);
    const tagIn = h('input', { type: 'text', class: 'qn-tagin', placeholder: 'tag', maxlength: String(N.LIMITS.tagLen), 'aria-label': 'Add a tag', hidden: true, list: 'qn-taglist',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = tagIn.value; mutate('Tag a clip', (d) => N.addTag(d, c.id, v, now())); focusClip(c.id); } else if (e.key === 'Escape') { e.stopPropagation(); tagIn.hidden = true; tagAdd.hidden = false; focusClip(c.id); } }, onblur: () => { tagIn.hidden = true; tagAdd.hidden = false; } });
    const tagAdd = h('button', { type: 'button', class: 'qn-tagadd', title: 'Add a tag (G)', onclick: () => { tagAdd.hidden = true; tagIn.hidden = false; tagIn.focus(); } }, ic('tag'), h('span', {}, 'Tag'));
    const others = S.doc.tabs.filter((x) => x.id !== t.id);
    const li = h('li', { class: 'qn-clip' + (c.pinned ? ' pinned' : '') + ' qn-k-' + c.kind, tabindex: '0', role: 'listitem', 'aria-label': nm + (c.pinned ? ', pinned' : ''), dataset: { id: c.id, kind: c.kind } },
      h('div', { class: 'qn-ch' }, h('span', { class: 'qn-kind mono' }, ic(KIND_ICON[c.kind]), KIND_LABEL[c.kind]),
        h('button', { type: 'button', class: 'qn-title', title: 'Rename this clip (E)', onclick: () => editTitle(c) }, c.title || h('span', { class: 'mute' }, 'No title')),
        h('time', { class: 'qn-time mono', datetime: c.t, title: c.t }, when(c.t)), ibtn('pin', c.pinned ? 'Unpin (P)' : 'Pin to the top (P)', () => act(c.id, 'pin'), { pressed: c.pinned, cls: c.pinned ? 'on' : '' })),
      h('div', { class: 'qn-from mono' }, ic(c.from.kind === 'ghost-browser' || c.from.kind === 'capture-browser' ? 'globe' : c.from.kind === 'capture-screen' ? 'screen' : 'paste'), h('span', { class: 'qn-fl', title: c.from.url || c.from.label }, 'From: ' + c.from.label + (c.from.url ? ' - ' + c.from.url : '') + (c.from.auto ? '' : '')), h('button', { type: 'button', class: 'btn ghost qn-fe', title: 'Change where this came from', 'aria-label': 'Change the source', onclick: () => editFrom(c) }, ic('edit'))),
      clipBody(c),
      h('div', { class: 'qn-tags' }, c.tags.map((g) => h('span', { class: 'qn-tag' }, h('button', { type: 'button', class: 'qn-tg', title: 'Show clips tagged ' + g, onclick: () => { S.q = 'tag:' + g; S.els.search.value = S.q; drawList(); } }, g), h('button', { type: 'button', class: 'qn-tx', title: 'Remove the tag ' + g, 'aria-label': 'Remove the tag ' + g, onclick: () => mutate('Remove a tag', (d) => N.removeTag(d, c.id, g, now())) }, ic('x')))), tagAdd, tagIn),
      c.sent.length ? h('div', { class: 'qn-sent mono' }, ic('send'), 'In the case: ' + c.sent.map((s) => s.label).slice(-3).join(', ')) : null,
      h('div', { class: 'qn-act' },
        tbtn('send', 'Send to case', () => act(c.id, 'send'), { cls: 'primary-ish' }),
        c.kind === 'image' || c.kind === 'file' ? tbtn('save', 'Save a copy', () => act(c.id, 'save')) : tbtn('copy', 'Copy', () => act(c.id, 'copy')),
        N.hasText(c) ? tbtn('comment', c.hl.length ? 'Marks ' + c.hl.length : 'Marks', () => highlightsDialog(c.id)) : null,
        others.length ? h('select', { class: 'qn-move', 'aria-label': 'Move this clip to another tab', onchange: (e) => { const to = e.target.value; if (to) { mutate('Move a clip', (d) => N.moveClip(d, c.id, to, now())); } } }, h('option', { value: '' }, 'Move to...'), others.map((x) => h('option', { value: x.id }, x.title))) : null,
        h('span', { class: 'qn-sp' }), h('button', { type: 'button', class: 'qn-hash mono', title: 'Item hash (SHA-256). Click to copy it: ' + c.hash, onclick: async () => { toast((await copyText(c.hash)) ? 'Item hash copied.' : 'Copy is not available here.'); } }, N.shortHash(c.hash)),
        ibtn('trash', 'Delete this clip (Delete). Ctrl Z brings it back.', () => act(c.id, 'delete'))));
    return li;
  }
  function allTagList() { let dl = document.getElementById('qn-taglist'); if (!dl) { dl = h('datalist', { id: 'qn-taglist' }); document.body.append(dl); } GH.clear(dl).append(N.allTags(S.doc || { tabs: [] }).map((t) => h('option', { value: t.tag }))); }

  // ---------- clip actions ----------
  async function act(id, name) {
    const f = N.findClip(S.doc, id); if (!f) return; const c = f.clip;
    if (name === 'pin') { mutate(c.pinned ? 'Unpin a clip' : 'Pin a clip', (d) => N.togglePin(d, id, now())); focusClip(id, true); }
    else if (name === 'delete') {
      const next = f.tab.clips[f.index + 1] || f.tab.clips[f.index - 1]; mutate('Delete a clip', (d) => N.removeClip(d, id, now())); toast('Clip deleted. Press Ctrl Z to bring it back.'); if (next) focusClip(next.id, false); else S.els.compose.focus();
    }
    else if (name === 'copy') { const ok = await copyText(c.kind === 'link' ? c.url : c.text); toast(ok ? 'Copied.' : 'Copy is not available here.'); }
    else if (name === 'save') { try { const r = await call(api().blob.save, S.scope, (c.image || c.file).blob, c.file ? c.file.name : (c.title || 'picture') + (c.image.mime === 'image/jpeg' ? '.jpg' : c.image.mime === 'image/png' ? '.png' : c.image.mime === 'image/gif' ? '.gif' : '.webp')); if (r && r.saved) toast('Saved ' + r.name + '.'); } catch (e) { toast(GH.errText(e), 'err'); } }
    else if (name === 'send') sendToCase(c);
    else if (name === 'tag') { const b = S.els.list.querySelector('.qn-clip[data-id="' + id + '"] .qn-tagadd'); if (b) b.click(); }
    else if (name === 'title') editTitle(c);
  }
  function editTitle(c) {
    const input = h('input', { type: 'text', class: 'qn-titlein', value: c.title, maxlength: String(N.LIMITS.title), 'aria-label': 'Clip title', 'data-autofocus': '' });
    const li = S.els.list.querySelector('.qn-clip[data-id="' + c.id + '"]'); const b = li && li.querySelector('.qn-title'); if (!b) return;
    b.replaceWith(input); input.focus(); input.select();
    let done = false; const end = (save) => { if (done) return; done = true; if (save) mutate('Rename a clip', (d) => N.setTitle(d, c.id, input.value, now())); else drawList(); focusClip(c.id, true); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.stopPropagation(); end(false); } }); input.addEventListener('blur', () => end(true));
  }
  async function editFrom(c) {
    const label = h('input', { type: 'text', id: 'qn-fl', value: c.from.label, maxlength: String(N.LIMITS.label), 'data-autofocus': '' }), url = h('input', { type: 'text', id: 'qn-fu', value: c.from.url, maxlength: '2000', spellcheck: 'false', placeholder: 'Optional web address' });
    const r = await GH.dialog({ title: 'Where did this come from?', sub: 'Ghost filled this in from what it knew. Correct it if it is wrong; the report prints what you enter.', body: h('div', { class: 'stack' }, GH.field('Source', label), GH.field('Address (optional)', url)), actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }] });
    if (r === true) mutate('Change a source', (d) => N.setFrom(d, c.id, { label: label.value, url: url.value }, now()));
    focusClip(c.id, true);
  }

  // ---------- highlights ----------
  function offsetOf(body, node, off) {
    const spans = [...body.querySelectorAll('[data-o]')]; if (!spans.length) return 0;
    for (const s of spans) {
      const r = document.createRange(); r.selectNodeContents(s); let cmp; try { cmp = r.comparePoint(node, off); } catch { continue; }
      if (cmp < 0) return Number(s.dataset.o);
      if (cmp === 0) { const t = s.firstChild; return Number(s.dataset.o) + (node === t || node.nodeType === 3 ? Math.min(off, s.textContent.length) : off > 0 ? s.textContent.length : 0); }
    }
    const l = spans[spans.length - 1]; return Number(l.dataset.o) + l.textContent.length;
  }
  function selectionRange() {
    const sel = document.getSelection(); if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0), anc = r.commonAncestorContainer, el = anc.nodeType === 1 ? anc : anc.parentElement, body = el && el.closest ? el.closest('.qn-body[data-clip]') : null;
    if (!body || !S.root.contains(body)) return null;
    const a = offsetOf(body, r.startContainer, r.startOffset), b = offsetOf(body, r.endContainer, r.endOffset);
    return a === b ? null : { clip: body.dataset.clip, a: Math.min(a, b), b: Math.max(a, b) };
  }
  function trackSelection() { if (!S.root) return; const r = selectionRange(); if (r) S.lastSel = r; }
  // The range to mark: the live selection, else the last one made in a clip, else the whole text of the clip that has the focus.
  function targetRange() {
    const live = selectionRange() || (S.lastSel && N.findClip(S.doc, S.lastSel.clip) && S.root.contains(document.activeElement) && !/TEXTAREA|INPUT|SELECT/.test(document.activeElement.tagName) ? S.lastSel : null);
    if (live) return live;
    const f = S.focusId && N.findClip(S.doc, S.focusId); if (f && N.hasText(f.clip) && f.clip.text.length) return { clip: f.clip.id, a: 0, b: f.clip.text.length, whole: true };
    return null;
  }
  function applyHighlight(color, u) {
    const t = targetRange(); if (!t) { toast('Select some text in a clip first.'); return; }
    const r = mutate(u ? 'Underline' : 'Highlight ' + color, (d) => N.addHighlight(d, t.clip, { a: t.a, b: t.b, color, u }, now()));
    if (r && r.error) toast(r.error); else say(r && r.toggled ? 'Highlight removed.' : 'Highlighted.');
    S.lastSel = null; try { document.getSelection().removeAllRanges(); } catch { /* none */ } focusClip(t.clip, true);
  }
  function clearSel() {
    const t = targetRange(); if (!t) { toast('Select some text in a clip first.'); return; }
    const n = mutate('Clear highlights', (d) => N.clearHighlights(d, t.clip, t.whole ? undefined : t.a, t.b, now())); say(n ? 'Cleared.' : 'No highlights there.'); focusClip(t.clip, true);
  }
  // Comments: on the selection (it is highlighted yellow first if it had no mark), or the list of this clip's marks.
  async function commentDialog() {
    const t = targetRange();
    if (t && !t.whole) {
      const f = N.findClip(S.doc, t.clip); let hl = f.clip.hl.find((x) => x.a === t.a && x.b === t.b);
      if (!hl) { const r = mutate('Highlight', (d) => N.addHighlight(d, t.clip, { a: t.a, b: t.b, color: 'yellow' }, now())); if (r && r.error) { toast(r.error); return; } hl = N.findClip(S.doc, t.clip).clip.hl.find((x) => x.id === r.id); }
      return highlightsDialog(t.clip, hl && hl.id);
    }
    const f = S.focusId && N.findClip(S.doc, S.focusId); if (!f || !N.hasText(f.clip)) { toast('Select some text in a clip first.'); return; }
    if (!f.clip.hl.length) { toast('Select some text, then press M to comment on it.'); return; }
    return highlightsDialog(f.clip.id);
  }
  async function highlightsDialog(clipId, focusId) {
    const f = N.findClip(S.doc, clipId); if (!f) return; const c = f.clip;
    if (!c.hl.length) { toast('Nothing is marked in this clip yet. Select some text and choose a colour.'); return; }
    const rows = c.hl.slice().sort((a, b) => a.a - b.a).map((x) => {
      const col = h('select', { 'aria-label': 'Colour' }, h('option', { value: '' }, 'No colour'), Object.keys(COLOR_NAMES).map((k) => h('option', { value: k, selected: x.color === k }, COLOR_NAMES[k]))); col.value = x.color || '';
      const u = h('input', { type: 'checkbox', checked: x.u, 'aria-label': 'Underline' }), cm = h('textarea', { rows: '2', maxlength: String(N.LIMITS.comment), 'aria-label': 'Comment', placeholder: 'Comment', 'data-autofocus': x.id === focusId ? '' : null }); cm.value = x.comment;
      const row = { id: x.id, col, u, cm, remove: false };
      row.el = h('li', { class: 'qn-hr' }, h('blockquote', { class: 'qn-q2' }, c.text.slice(x.a, x.b).replace(/\s+/g, ' ').slice(0, 160)), h('div', { class: 'qn-hr-c' }, col, h('label', { class: 'chk' }, u, h('span', {}, 'Underline')), GH.btn('Remove', { ghost: true, icon: 'qn-trash', onclick: () => { row.remove = !row.remove; row.el.classList.toggle('gone', row.remove); } })), cm);
      return row;
    });
    const r = await GH.dialog({ title: 'Marks in this clip', sub: 'Colour, underline and a comment for each. Comments are printed in the report.', width: 560, body: h('ul', { class: 'qn-hrs' }, rows.map((x) => x.el)), actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }] });
    if (r === true) mutate('Edit marks', (d) => { for (const x of rows) { if (x.remove) N.removeHighlight(d, clipId, x.id, now()); else { const g = N.findClip(d, clipId).clip.hl.find((k) => k.id === x.id); if (g) { g.color = x.col.value || null; g.u = x.u.checked; if (!g.color && !g.u) g.u = true; g.comment = x.cm.value.slice(0, N.LIMITS.comment); } } } });
    focusClip(clipId, true);
  }
  function bodyClick(e) {
    const a = e.target.closest && e.target.closest('.qn-a[data-url]'); if (a && a.dataset.url && !selectionRange()) { copyText(a.dataset.url).then((ok) => toast(ok ? 'Link address copied.' : a.dataset.url)); return; }
    const m = e.target.closest && e.target.closest('.qn-m[data-hl]'); if (m && !selectionRange()) { const body = m.closest('.qn-body[data-clip]'); if (body) highlightsDialog(body.dataset.clip, m.dataset.hl.split(' ').pop()); }
  }

  // ---------- tabs ----------
  function switchTab(id, focus) { if (!S.doc || S.doc.active === id) { if (focus) { const b = document.getElementById('qn-tab-' + id); if (b) b.focus(); } return; } S.doc.active = id; S.dirty = true; schedule(); S.shown = 200; S.q = ''; drawAll(); if (focus) { const b = document.getElementById('qn-tab-' + id); if (b) b.focus(); } }
  function newTab() { const r = mutate('New tab', (d) => N.addTab(d, '', now())); if (r && r.error) toast(r.error); else { const b = document.getElementById('qn-tab-' + S.doc.active); if (b) { b.focus(); renameTab(S.doc.active); } } }
  function renameTab(id) {
    const t = N.tabById(S.doc, id); const b = document.getElementById('qn-tab-' + id); if (!t || !b) return;
    const input = h('input', { type: 'text', class: 'qn-tabin', value: t.title, maxlength: String(N.LIMITS.tabTitle), 'aria-label': 'Tab name' }); const w = b.parentElement; b.hidden = true; w.prepend(input); input.focus(); input.select();
    let done = false; const end = (save) => { if (done) return; done = true; if (save && input.value.trim()) mutate('Rename a tab', (d) => N.renameTab(d, id, input.value, now())); else drawTabs(); const nb = document.getElementById('qn-tab-' + id); if (nb) nb.focus(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); end(true); } else if (e.key === 'Escape') { e.stopPropagation(); end(false); } e.stopPropagation(); }); input.addEventListener('blur', () => end(true));
  }
  function closeTab(id) {
    const t = N.tabById(S.doc, id); if (!t) return; mutate('Close a tab', (d) => N.closeTab(d, id, now())); toast('Closed "' + t.title + '". Ctrl Shift T brings it back.'); const b = document.getElementById('qn-tab-' + S.doc.active); if (b) b.focus();
  }
  function restoreTab(id) { const t = mutate('Restore a tab', (d) => N.restoreTab(d, id, now())); if (!t) toast('There is no closed tab to restore.'); else { toast('Restored "' + t.title + '".'); const b = document.getElementById('qn-tab-' + t.id); if (b) b.focus(); } }
  function moveActive(dir) { const i = S.doc.tabs.findIndex((t) => t.id === S.doc.active); mutate('Move a tab', (d) => N.moveTab(d, S.doc.active, i + dir, now())); const b = document.getElementById('qn-tab-' + S.doc.active); if (b) b.focus(); }
  async function closedDialog() {
    const list = S.doc.closed.slice().reverse(), pick = { id: null };
    const body = h('ul', { class: 'qn-closed-l' }, list.map((c) => h('li', {}, h('span', {}, h('b', {}, c.tab.title), h('span', { class: 'mute sm mono' }, '  ' + GH.plural(c.tab.clips.length, 'clip') + ', closed ' + when(c.closedAt))), GH.btn('Restore', { icon: 'qn-restore', onclick: () => { pick.id = c.tab.id; document.querySelector('.scrim')._close(true); } }))));
    const r = await GH.dialog({ title: 'Closed tabs', sub: 'The last ' + N.LIMITS.closed + ' closed tabs are kept with their clips.', body, actions: [{ label: 'Close', value: false }] });
    if (r === true && pick.id) restoreTab(pick.id);
  }
  async function tabOptions() {
    const t = N.activeTab(S.doc), i = S.doc.tabs.indexOf(t);
    const name = h('input', { type: 'text', id: 'qn-tn', value: t.title, maxlength: String(N.LIMITS.tabTitle), 'data-autofocus': '' }), rep = GH.chk('Include this tab in the report appendix', { checked: t.report });
    const r = await GH.dialog({ title: 'Tab options', sub: 'Only tabs you include are printed in a report, with where each clip came from.', body: h('div', { class: 'stack' }, GH.field('Name', name), rep.el, h('div', { class: 'row-a' }, GH.btn('Move left', { icon: 'qn-dock', disabled: i === 0, onclick: () => { document.querySelector('.scrim')._close('left'); } }), GH.btn('Move right', { disabled: i === S.doc.tabs.length - 1, onclick: () => { document.querySelector('.scrim')._close('right'); } }))), actions: [{ label: 'Cancel', value: false }, { label: 'Save', primary: true, value: true }] });
    if (r === true) mutate('Tab options', (d) => { if (name.value.trim()) N.renameTab(d, t.id, name.value, now()); const tt = N.tabById(d, t.id); if (tt) tt.report = rep.input.checked; });
    else if (r === 'left' || r === 'right') mutate('Move a tab', (d) => N.moveTab(d, t.id, i + (r === 'left' ? -1 : 1), now()));
    const b = document.getElementById('qn-tab-' + S.doc.active); if (b) b.focus();
  }

  // ---------- send to the case board ----------
  async function sendToCase(c) {
    const a = api();
    if (S.standalone) {
      try { await call(a.send, { scope: S.scope, clip: c }); toast('Sent to the Ghost window. Finish there.'); } catch (e) { toast(GH.errText(e), 'err'); }
      return;
    }
    const M = window.GhostCase; if (!GH.cs || !M) { toast('Open the Ghost window to send clips to a case.'); return; }
    const r = await runSend(c); if (r && !S.popped) { mutate('Mark a clip as sent', (d) => N.markSent(d, c.id, { ...r, caseId: GH.cs.current().id }, now())); }
  }
  // The dialog and the change to the open case. Returns { entityId, label } or null. Used for clips from this drawer and for clips sent from the pop-out window.
  async function runSend(c) {
    const M = window.GhostCase;
    if (!GH.cs.current() && !(await GH.cs.pickCase())) return null;
    const cs = GH.cs.current(); if (!cs) return null;
    const sug = N.suggestEntity(c), types = M.ENTITY_TYPES.filter((t) => t !== 'email');
    const mode = { v: 'new' };
    const rNew = h('input', { type: 'radio', name: 'qn-sm', id: 'qn-sm-new', checked: true, onchange: () => { mode.v = 'new'; show(); } }), rOld = h('input', { type: 'radio', name: 'qn-sm', id: 'qn-sm-old', onchange: () => { mode.v = 'attach'; show(); } });
    const type = h('select', { id: 'qn-st' }, types.map((t) => h('option', { value: t, selected: t === sug.type }, GH.TYPE_LABEL[t]))), value = h('input', { type: 'text', id: 'qn-sv', value: sug.value, maxlength: '500', spellcheck: 'false' }), label = h('input', { type: 'text', id: 'qn-sl', value: sug.label, maxlength: '300' });
    const filter = h('input', { type: 'text', id: 'qn-sf', placeholder: 'Find an entity', maxlength: '100', 'aria-label': 'Find an entity in the case', oninput: fill }), pick = h('select', { id: 'qn-sp', size: '7', 'aria-label': 'Entity to attach this clip to' });
    function fill() { const q = filter.value.trim().toLowerCase(); const list = Object.values(cs.entities).filter((e) => !q || e.label.toLowerCase().includes(q) || e.key.toLowerCase().includes(q) || e.type === q).sort((x, y) => (x.label < y.label ? -1 : 1)).slice(0, 200); GH.clear(pick).append(list.map((e) => h('option', { value: e.id }, e.label + '  (' + GH.TYPE_LABEL[e.type] + ')'))); if (list.length) pick.selectedIndex = 0; }
    const newBox = h('div', { class: 'stack' }, GH.field('Type', type), GH.field('Value', value, 'The value is what the case board merges on.'), GH.field('Label', label)), oldBox = h('div', { class: 'stack' }, filter, pick);
    function show() { newBox.hidden = mode.v !== 'new'; oldBox.hidden = mode.v !== 'attach'; }
    fill(); show();
    const body = h('div', { class: 'stack' }, h('p', { class: 'qn-sendq' }, (c.title || KIND_LABEL[c.kind]) + (N.hasText(c) ? ': ' + c.text.replace(/\s+/g, ' ').slice(0, 100) : '')),
      h('label', { class: 'chk' }, rNew, h('span', {}, 'Make it a new entity on the board')), newBox, h('label', { class: 'chk' }, rOld, h('span', {}, 'Attach it as evidence to an entity already on the board')), oldBox);
    const go = await GH.dialog({ title: 'Send to "' + cs.title + '"', sub: 'The clip becomes a source of the case: where it came from, when, and its item hash.', icon: 'qn-send', width: 560, body, actions: [{ label: 'Cancel', value: false }, { label: 'Send', primary: true, value: true }] });
    if (go !== true) return null;
    let res = null;
    if (mode.v === 'attach' && !pick.value) { toast('Choose an entity first.'); return null; }
    GH.cs.mutate('Add a quick note clip', (x) => { res = N.sendToCase(M, x, c, { mode: mode.v, type: type.value, value: value.value, label: label.value, entityId: pick.value, now: now() }); if (res && res.entityId) M.layout(x); });
    if (!res || res.error) { toast(res && res.error || 'That could not be added.', 'err'); return null; }
    toast((mode.v === 'attach' ? 'Attached to "' : 'Added "') + res.label + '" ' + (mode.v === 'attach' ? 'as evidence.' : 'to "' + cs.title + '".'));
    return { entityId: res.entityId, label: res.label };
  }

  // ---------- keyboard ----------
  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey, k = e.key, lk = k.length === 1 ? k.toLowerCase() : k;
    if (!S.standalone && mod && e.shiftKey && !e.altKey && lk === 'n' && GH.mounted !== false) { e.preventDefault(); e.stopImmediatePropagation(); toggle(); return; }
    if (!S.root || S.root.hidden || !S.root.contains(e.target) || document.querySelector('.scrim')) return;
    const t = e.target, typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName || '') || t.isContentEditable;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (mod && !e.altKey && lk === 'z' && !typing) { stop(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && !e.altKey && lk === 'y' && !typing) { stop(); redo(); return; }
    if (mod && e.shiftKey && lk === 'v') { if (typing && t !== S.els.compose) return; stop(); pasteButton(true); return; }
    if (mod && e.shiftKey && lk === 'o' && api() && api().popout) { stop(); togglePop(); return; }
    if (!S.doc) { if (k === 'Escape' && !S.standalone) { stop(); close(); } return; }
    if (mod && !e.shiftKey && lk === 't') { stop(); newTab(); return; }
    if (mod && e.shiftKey && lk === 't') { stop(); restoreTab(); return; }
    if (mod && !e.shiftKey && lk === 'w') { stop(); closeTab(S.doc.active); return; }
    if (mod && (k === 'PageDown' || k === 'PageUp' || (k === 'Tab'))) { stop(); const i = S.doc.tabs.findIndex((x) => x.id === S.doc.active), dir = k === 'PageUp' || (k === 'Tab' && e.shiftKey) ? -1 : 1; switchTab(S.doc.tabs[(i + dir + S.doc.tabs.length) % S.doc.tabs.length].id, true); return; }
    if (e.altKey && !mod && /^[1-9]$/.test(k)) { const x = S.doc.tabs[Number(k) - 1]; if (x) { stop(); switchTab(x.id, true); } return; }
    if (mod && e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight')) { stop(); moveActive(k === 'ArrowLeft' ? -1 : 1); return; }
    if (k === 'F2') { stop(); renameTab(S.doc.active); return; }
    if ((mod && !e.shiftKey && lk === 'f') || (k === '/' && !typing)) { stop(); S.els.search.focus(); S.els.search.select(); return; }
    if (k === 'Escape') {
      if (t === S.els.search && S.q) { stop(); S.q = ''; S.els.search.value = ''; drawList(); drawFoot(); return; }
      if (typing) { stop(); if (t === S.els.compose || t === S.els.search) { const first = S.els.list.querySelector('.qn-clip'); if (first) first.focus(); else t.blur(); } return; }
      if (!S.standalone) { stop(); close(); } return;
    }
    const li = t.closest && t.closest('.qn-clip'); if (typing || !li || t !== li) return;
    const id = li.dataset.id, items = [...S.els.list.querySelectorAll('.qn-clip')], i = items.indexOf(li);
    if (k === 'ArrowDown' || lk === 'j') { stop(); (items[i + 1] || li).focus(); } else if (k === 'ArrowUp' || lk === 'k') { stop(); (items[i - 1] || li).focus(); }
    else if (k === 'Home') { stop(); items[0].focus(); } else if (k === 'End') { stop(); items[items.length - 1].focus(); }
    else if (/^[1-5]$/.test(k) && !mod) { stop(); S.focusId = id; applyHighlight(Object.keys(COLOR_NAMES)[Number(k) - 1], false); }
    else if (lk === 'u' && !mod) { stop(); S.focusId = id; applyHighlight(null, true); } else if (k === '0') { stop(); S.focusId = id; clearSel(); }
    else if (lk === 'm') { stop(); S.focusId = id; commentDialog(); } else if (lk === 'p') { stop(); act(id, 'pin'); } else if (lk === 'g') { stop(); act(id, 'tag'); }
    else if (lk === 's') { stop(); act(id, 'send'); } else if (lk === 'c' && !mod) { stop(); act(id, N.findClip(S.doc, id).clip.kind === 'image' || N.findClip(S.doc, id).clip.kind === 'file' ? 'save' : 'copy'); } else if (lk === 'e') { stop(); act(id, 'title'); }
    else if (k === 'Delete' || k === 'Backspace') { stop(); act(id, 'delete'); } else if (k === 'Enter') { stop(); const b = li.querySelector('.qn-body'); if (b) b.focus(); }
  }

  // ---------- docking, pop-out, opening ----------
  async function refreshCases() { const a = api(); if (!a) return; try { S.cases = (await call(a.cases)).map((c) => ({ id: c.id, title: c.title })); } catch { S.cases = []; } }
  const caseNow = () => { const c = GH.cs && GH.cs.current && GH.cs.current(); return c ? c.id : 'inbox'; };
  function setDocked(on) { if (S.appEl) S.appEl.classList.toggle('qn-docked', !!on); document.documentElement.classList.toggle('qn-on', !!on); const b = document.getElementById('qn-btn'); if (b) b.setAttribute('aria-pressed', String(!!on)); }
  async function open() {
    if (S.standalone) return; build(); if (!S.root.isConnected) document.body.append(S.root);
    S.open = true; S.root.hidden = false; setDocked(true); S.prevFocus = document.activeElement;
    allTagList(); drawAll();
    if (S.popped) return;
    await refreshCases();
    const want = caseNow(); if (!S.loaded || S.scope !== want) await load(want); else drawAll();
    allTagList(); if (S.els.compose) S.els.compose.focus();
  }
  function close() { if (!S.root || S.standalone) return; flush(); S.open = false; S.root.hidden = true; setDocked(false); const p = S.prevFocus; S.prevFocus = null; if (p && p.focus && p.isConnected) { try { p.focus(); } catch { /* gone */ } } }
  function toggle() { if (S.open) close(); else open(); }
  async function togglePop() {
    const a = api(); if (!a) return;
    try {
      if (S.standalone) { await flush(); await call(a.popout.close); return; }
      if (S.popped) { await call(a.popout.close); return; }
      await flush(); await call(a.popout.open, { scope: S.scope, theme: document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark' });
    } catch (e) { toast(GH.errText(e), 'err'); }
  }
  async function toggleTop() { const a = api(); try { const r = await call(a.popout.top, !S.onTop); S.onTop = r.onTop; drawHead(); } catch (e) { toast(GH.errText(e), 'err'); } }
  // Where did the last copy in Ghost itself happen (for the paste source). Copies inside the drawer do not count.
  function trackCopy(e) {
    const a = api(); if (!a || S.standalone || (S.root && S.root.contains(e.target))) return;
    const sel = document.getSelection(), n = sel && sel.anchorNode, el = n ? (n.nodeType === 1 ? n : n.parentElement) : e.target; if (!el || !el.closest || el.closest('.qn')) return;
    const card = el.closest('.ccard'), crumb = document.getElementById('crumb');
    const o = card ? { kind: 'tool', label: 'Tool: ' + (card.getAttribute('aria-label') || 'connector') } : { kind: 'ghost-app', label: 'Mayfair Ghost: ' + (crumb ? crumb.textContent : 'Ghost') };
    call(a.copied, o).catch(() => {});
  }

  // ---------- public ----------
  GH.qn = {
    SHORTCUTS, state: S,
    topButton() { ensureSprite(); return h('button', { type: 'button', class: 'btn ghost icon', id: 'qn-btn', title: 'Quick notes (Ctrl Shift N)', 'aria-label': 'Quick notes', 'aria-pressed': String(S.open), onclick: toggle }, ic('note')); },
    // Called by the shell each time it draws the app: keep the drawer, and say whether the page is making room for it.
    attach(appEl) {
      S.appEl = appEl; if (!api()) return; build(); if (!S.root.isConnected) document.body.append(S.root);
      S.root.hidden = !S.open; setDocked(S.open);
    },
    open, close, toggle, flush: () => flush(), reload: () => load(S.scope),
    // For the report dialog: a field listing the tabs, and the ids of the ones chosen (saved with the notes).
    async reportField(caseId) {
      if (!api() || S.standalone) return null;
      await refreshCases(); if (!S.loaded || S.scope !== caseId) await load(caseId); if (!S.doc) return null;
      const boxes = S.doc.tabs.map((t) => ({ t, c: GH.chk(t.title + ' (' + GH.plural(t.clips.length, 'clip') + ')', { checked: t.report, disabled: !t.clips.length }) }));
      S.reportBoxes = boxes;
      return h('fieldset', { class: 'fld qn-rf' }, h('legend', {}, 'Quick notes appendix'), boxes.length && boxes.some((b) => b.t.clips.length) ? boxes.map((b) => b.c.el) : h('p', { class: 'mute sm' }, 'This case has no quick notes yet.'), h('span', { class: 'hint' }, 'Each clip is printed with where it came from, when it was saved and its hash.'));
    },
    async reportTabs() {
      if (!S.doc || !S.reportBoxes) return [];
      const ids = S.reportBoxes.filter((b) => b.c.input.checked && b.t.clips.length).map((b) => b.t.id);
      N.setReportTabs(S.doc, ids, now()); S.dirty = true; await flush(); S.reportBoxes = null; return ids;
    },
    mountStandalone(rootEl, info) {
      S.standalone = true; S.onTop = !info || info.onTop !== false; build(); S.root.hidden = false; GH.clear(rootEl).append(S.root); const a = api();
      document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
      if (a && a.onSent) a.onSent((p) => { if (S.doc && p && p.clipId) { mutate('Mark a clip as sent', (d) => N.markSent(d, p.clipId, p, now())); } });
      window.addEventListener('beforeunload', () => { flush(); });
      refreshCases().then(() => load(info && info.scope ? info.scope : 'inbox').then(() => { allTagList(); S.els.compose.focus(); }));
    },
  };
  // inside the Ghost window: follow the open case, keep up with the pop-out, take clips sent from it, note where copies happen
  function init() {
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('copy', trackCopy, true);
    window.addEventListener('beforeunload', () => { if (S.dirty) flush(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && S.dirty) flush(); });
    const a = api(); if (!a) return;
    if (GH.cs && GH.cs.on) GH.cs.on((why) => { if (GH.mounted === false) { if (S.open) close(); S.loaded = false; S.doc = null; return; } if ((why === 'open' || why === 'close') && S.open && !S.popped) refreshCases().then(() => load(caseNow())); else if (why === 'open' || why === 'close') S.loaded = false; });
    if (a.onPopped) a.onPopped((p) => {
      S.popped = !!p.open;
      if (p.open) { if (S.root) { S.open = false; S.root.hidden = true; setDocked(false); drawAll(); } return; }      // the pop-out is the editor now: the side panel makes room
      S.open = true; build(); if (!S.root.isConnected) document.body.append(S.root); S.root.hidden = false; setDocked(true);      // the pop-out closed: the notes come back to the side
      S.loaded = false; refreshCases().then(() => load(S.scope)).then(() => { if (S.els.compose) S.els.compose.focus(); });
    });
    if (a.onSend) a.onSend(async (p) => {
      if (!p || !p.clip || !window.GhostCase || !GH.cs) return;
      const r = await runSend(p.clip); if (r) { try { await call(a.sent, { clipId: p.clip.id, entityId: r.entityId, label: r.label, caseId: GH.cs.current() ? GH.cs.current().id : '' }); } catch { /* the window may be closed */ } }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { ensureSprite(); init(); }); else { ensureSprite(); init(); }
})();
