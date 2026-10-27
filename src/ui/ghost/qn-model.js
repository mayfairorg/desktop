'use strict';
// Ghost Quick notes: the note model (format mayfair-ghost-notes/1). Plain functions on plain objects: no DOM, no Node-only calls, no network.
// The page edits a note document with these; the main process runs `validate` on every save and on every report, so a document that breaks the
// rules (unknown tag, remote address inside rich text, a highlight outside its text, an over-size blob reference) is never written to the vault.
//
//   doc   { format, scope, updated, active, tabs:[tab], closed:[{tab, index, closedAt}], settings:{} }
//   tab   { id, title, created, report, clips:[clip] }
//   clip  { id, kind: text|rich|link|image|file, t, title, text, tree?, url?, image?, file?, from, hash, tags, pinned, hl:[highlight], sent:[] }
//   highlight { id, a, b, color: yellow|green|blue|red|grey|null, u: underline, comment, t }       a and b are offsets into clip.text
//
// Rich text is kept as a small tree of allowed tags and plain strings (never as markup). The sanitiser below is the only way rich text gets in.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GhostNotes = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const FORMAT = 'mayfair-ghost-notes/1';
  const LIMITS = { tabs: 40, closed: 20, clips: 2000, clipText: 200000, title: 200, tabTitle: 60, tags: 12, tagLen: 32, highlights: 200, comment: 2000, docBytes: 8 * 1024 * 1024, blobBytes: 8 * 1024 * 1024, scopeBytes: 128 * 1024 * 1024, nodes: 8000, depth: 32, url: 2000, label: 200, fileName: 120 };
  const COLORS = ['yellow', 'green', 'blue', 'red', 'grey'];
  const KINDS = ['text', 'rich', 'link', 'image', 'file'];
  const FROM_KINDS = ['pasted', 'ghost-browser', 'tool', 'ghost-app', 'terminal', 'window', 'capture-browser', 'capture-screen', 'dropped', 'typed'];
  const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const HINT_MAX_AGE_MS = 120 * 1000;
  const UNDO_LIMIT = 50, UNDO_BYTES = 32 * 1024 * 1024;

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);
  const nowIso = (now) => new Date(now === undefined ? Date.now() : now).toISOString();
  const hex = (n) => { const a = new Uint8Array(n); const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null; if (c && c.getRandomValues) c.getRandomValues(a); else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256); return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join(''); };
  const rid = (p, n) => p + '-' + hex(n || 6);
  const ID_RE = /^[A-Za-z0-9_-]{4,40}$/, BLOB_RE = /^[0-9a-f]{16}$/, HASH_RE = /^[0-9a-f]{64}$/;

  // ---------- SHA-256 (string as UTF-8, or bytes). Pure, so the page and the tests agree without WebCrypto. ----------
  const K = [], H0 = [];
  (function init() {
    const prime = (n) => { for (let i = 2; i * i <= n; i++) if (n % i === 0) return false; return true; };
    const frac = (x) => ((x - Math.floor(x)) * 4294967296) >>> 0;
    for (let n = 2, c = 0; c < 64; n++) if (prime(n)) { if (c < 8) H0[c] = frac(Math.sqrt(n)); K[c] = frac(Math.cbrt(n)); c++; }
  })();
  function sha256(data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
    const l = bytes.length, total = ((l + 9 + 63) >> 6) << 6, buf = new Uint8Array(total);
    buf.set(bytes); buf[l] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(total - 8, Math.floor(l / 0x20000000)); dv.setUint32(total - 4, (l << 3) >>> 0);
    const h = H0.slice(), w = new Uint32Array(64), ror = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + 4 * t);
      for (let t = 16; t < 64; t++) { const a = w[t - 15], b = w[t - 2]; w[t] = (w[t - 16] + (ror(a, 7) ^ ror(a, 18) ^ (a >>> 3)) + w[t - 7] + (ror(b, 17) ^ ror(b, 19) ^ (b >>> 10))) >>> 0; }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let t = 0; t < 64; t++) {
        const t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0; h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map((x) => x.toString(16).padStart(8, '0')).join('');
  }
  const shortHash = (h) => String(h || '').slice(0, 12);

  // ---------- the sanitiser ----------
  // Takes HTML text and returns { tree, text, truncated }. Nothing in the tree can load or run anything:
  //   only these tags survive, every other tag is removed and its text kept; script, style, frames, objects, svg, forms' controls and the like are removed with their content;
  //   no attribute survives except a link's address (http, https or mailto only) and its title; style, class, id, event handlers, srcset and every src are dropped;
  //   an image becomes the words [image: alt text]: nothing remote is ever fetched; comments, doctype and processing instructions are dropped.
  const OUT_BLOCK_END = new Set(['p', 'h3', 'h4', 'blockquote', 'pre', 'li', 'tr']);
  const OUT_TAGS = new Set(['p', 'h3', 'h4', 'b', 'i', 'u', 's', 'code', 'mark', 'sub', 'sup', 'small', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'a', 'hr']);
  const MAP = {};
  for (const t of ['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'nav', 'main', 'address', 'figure', 'figcaption', 'details', 'summary', 'fieldset', 'center', 'caption', 'dd', 'dt']) MAP[t] = 'p';
  for (const t of ['h1', 'h2', 'h3']) MAP[t] = 'h3'; for (const t of ['h4', 'h5', 'h6']) MAP[t] = 'h4';
  for (const t of ['b', 'strong']) MAP[t] = 'b'; for (const t of ['i', 'em', 'cite', 'dfn', 'var']) MAP[t] = 'i'; for (const t of ['u', 'ins']) MAP[t] = 'u'; for (const t of ['s', 'strike', 'del']) MAP[t] = 's';
  for (const t of ['code', 'kbd', 'samp', 'tt']) MAP[t] = 'code';
  for (const t of ['mark', 'sub', 'sup', 'small', 'blockquote', 'pre', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'a', 'hr']) MAP[t] = t;
  const DROP_RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'iframe', 'noembed', 'noframes', 'template', 'plaintext']);
  const DROP_NEST = new Set(['svg', 'math', 'object', 'applet', 'canvas', 'audio', 'video', 'select', 'datalist', 'dialog', 'frameset', 'map']);
  const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr', 'param', 'frame']);
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', deg: '°', times: '×', rarr: '→', larr: '←' };
  const decode = (s) => String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n < 0x110000 && !(n >= 0xd800 && n < 0xe000) && n !== 0 ? String.fromCodePoint(n) : ''; }
    return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
  });
  // A link target that is allowed to be kept as text: http, https, mailto. Anything else (javascript:, data:, file:, vbscript: ...) is refused.
  function safeUrl(u) {
    const s = String(u === undefined || u === null ? '' : u).replace(/[\u0000-\u001f\u007f\s]+/g, '').slice(0, LIMITS.url + 1);
    if (!s || s.length > LIMITS.url) return '';
    return /^(https?:|mailto:)/i.test(s) && !/^https?:$/i.test(s) ? s : '';
  }
  const webUrl = (u) => { const s = safeUrl(u); return /^https?:/i.test(s) ? s : ''; };

  function sanitizeHtml(html, o) {
    const cap = (o && o.maxText) || LIMITS.clipText;
    const src = String(html === undefined || html === null ? '' : html).slice(0, 4 * 1024 * 1024);
    const rootArr = [];
    const stack = [{ src: null, out: null, arr: rootArr }];       // src: the tag name in the source; out: the tag kept (or null when only the text is kept)
    let nodes = 0, chars = 0, truncated = false, pre = 0, last = '', leaf = null;
    const top = () => stack[stack.length - 1];
    const setLeaf = (arr, i) => { leaf = { arr, i }; };
    const push = (s) => {
      if (!s) return;
      if (chars + s.length > cap) { s = s.slice(0, Math.max(0, cap - chars)); truncated = true; if (!s) return; }
      const arr = top().arr, prev = arr[arr.length - 1];
      if (typeof prev === 'string') { arr[arr.length - 1] = prev + s; setLeaf(arr, arr.length - 1); } else { if (++nodes > LIMITS.nodes) { truncated = true; return; } arr.push(s); setLeaf(arr, arr.length - 1); }
      chars += s.length; last = s[s.length - 1];
    };
    const rtrim = () => { if (leaf && typeof leaf.arr[leaf.i] === 'string' && / $/.test(leaf.arr[leaf.i]) && pre === 0) { leaf.arr[leaf.i] = leaf.arr[leaf.i].replace(/ $/, ''); chars--; last = leaf.arr[leaf.i].slice(-1) || '\n'; } };
    const text = (raw) => {
      let s = decode(raw);
      if (!pre) { s = s.replace(/[ \t\r\n\f ]+/g, ' '); if (last === '' || last === '\n' || last === ' ' || last === '\t') s = s.replace(/^ /, ''); } else s = s.replace(/\r\n?/g, '\n');
      push(s);
    };
    const newline = () => { rtrim(); if (last !== '\n' && last !== '') push('\n'); };
    const open = (name, attrs) => {
      const out = MAP[name] || null;
      if (out && stack.length < LIMITS.depth && nodes + 1 <= LIMITS.nodes) {
        if (OUT_BLOCK_END.has(out) && out !== 'li' && last !== '\n' && last !== '') { rtrim(); if (last !== '\n' && last !== '') push('\n'); }      // a block starts on its own line
        nodes++;
        const node = { t: out, c: [] };
        if (out === 'a') { const href = safeUrl(attrs.href); if (href) node.a = { href }; if (attrs.title) node.a = { ...(node.a || {}), title: clip(decode(attrs.title), 200) }; }
        top().arr.push(node); stack.push({ src: name, out, arr: node.c, node });
        if (out === 'pre') pre++;
      } else stack.push({ src: name, out: null, arr: top().arr });
    };
    const close = (name) => {
      let k = stack.length - 1; while (k > 0 && stack[k].src !== name) k--;
      if (k === 0) return;
      while (stack.length > k) {
        const e = stack.pop();
        if (e.out === 'pre') pre--;
        if (e.out && OUT_BLOCK_END.has(e.out)) { stack.push(e); newline(); stack.pop(); }
        if (e.out === 'td' || e.out === 'th') { stack.push(e); rtrim(); if (last !== '\t' && last !== '\n') push('\t'); stack.pop(); }
      }
    };
    let i = 0; const n = src.length;
    while (i < n) {
      const lt = src.indexOf('<', i);
      if (lt < 0) { text(src.slice(i)); break; }
      if (lt > i) text(src.slice(i, lt));
      if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
      if (src[lt + 1] === '!' || src[lt + 1] === '?') { const e = src.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
      const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(src.slice(lt, lt + 80));
      if (!m) { text('<'); i = lt + 1; continue; }
      const closing = m[1] === '/', name = m[2].toLowerCase();
      let j = lt + m[0].length; const attrs = {}; let selfClose = false;
      while (j < n) {
        while (j < n && /[\s]/.test(src[j])) j++;
        if (src[j] === '>') { j++; break; }
        if (src[j] === '/') { selfClose = true; j++; continue; }
        selfClose = false;
        const am = /^[^\s=>/]+/.exec(src.slice(j, j + 200)); if (!am) { j++; continue; }
        const an = am[0].toLowerCase(); j += am[0].length;
        while (j < n && /[\s]/.test(src[j])) j++;
        let val = '';
        if (src[j] === '=') {
          j++; while (j < n && /[\s]/.test(src[j])) j++;
          const q = src[j];
          if (q === '"' || q === "'") { const e = src.indexOf(q, j + 1); val = src.slice(j + 1, e < 0 ? n : e); j = e < 0 ? n : e + 1; }
          else { const e = /^[^\s>]*/.exec(src.slice(j, j + 4000)); val = e[0]; j += e[0].length; }
        }
        if (!(an in attrs)) attrs[an] = val;
      }
      i = j;
      if (closing) { if (!VOID.has(name)) close(name); continue; }
      if (name === 'br') { rtrim(); push('\n'); continue; }
      if (name === 'img') { const alt = clip(decode(attrs.alt || '').replace(/\s+/g, ' ').trim(), 120); text(alt ? '[image: ' + alt + ']' : '[image]'); continue; }
      if (DROP_RAW.has(name)) { if (name === 'plaintext') { i = n; continue; } const re = new RegExp('</' + name + '\\b[^>]*>', 'i'); const rest = src.slice(i); const e = rest.search(re); if (e < 0) i = n; else { const mm = re.exec(rest.slice(e)); i += e + mm[0].length; } continue; }
      if (DROP_NEST.has(name)) {
        if (selfClose) continue;
        const re = new RegExp('<(/?)' + name + '\\b[^>]*>', 'gi'); re.lastIndex = i; let depth = 1, mm;
        while ((mm = re.exec(src))) { depth += mm[1] ? -1 : /\/>$/.test(mm[0]) ? 0 : 1; if (depth === 0) { i = re.lastIndex; break; } }
        if (depth > 0) i = n; continue;
      }
      if (VOID.has(name)) { if (name === 'hr' && nodes < LIMITS.nodes) { rtrim(); if (last !== '\n' && last !== '') push('\n'); nodes++; top().arr.push({ t: 'hr', c: [] }); } continue; }
      if (MAP[name] === undefined) { open(name, attrs); stack[stack.length - 1].out = null; if (selfClose) close(name); continue; }
      open(name, attrs); if (selfClose) close(name);
    }
    while (stack.length > 1) { const e = stack.pop(); if (e.out === 'pre') pre--; if (e.out && OUT_BLOCK_END.has(e.out)) { stack.push(e); newline(); stack.pop(); } }
    // Leading and trailing blank lines are not part of the text (so highlight offsets stay inside what is shown).
    const trimEnds = (arr) => {
      while (arr.length) { const l = arr[arr.length - 1]; if (typeof l === 'string') { const t = l.replace(/[ \t\n]+$/, ''); if (t) { arr[arr.length - 1] = t; return true; } arr.pop(); } else { if (l.t === 'hr') return true; if (trimEnds(l.c)) return true; if (!l.c.length) arr.pop(); else return true; } }
      return false;
    };
    trimEnds(rootArr);
    const stripEmpty = (arr) => { for (let k = arr.length - 1; k >= 0; k--) { const x = arr[k]; if (typeof x !== 'string') { stripEmpty(x.c); if (!x.c.length && x.t !== 'hr') arr.splice(k, 1); } } };
    stripEmpty(rootArr);
    while (rootArr.length && typeof rootArr[0] === 'string' && !rootArr[0].replace(/\s+/g, '')) rootArr.shift();
    return { tree: rootArr, text: flatten(rootArr), truncated };
  }
  // The plain text of a tree: every string in order. Highlight offsets count into this.
  function flatten(tree) { let s = ''; const walk = (a) => { for (const x of a) { if (typeof x === 'string') s += x; else walk(x.c || []); } }; walk(tree || []); return s; }
  const escHtml = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  // Serialises a tree to escaped markup for the report (and for tests). `marks(start, end, text)` may wrap a slice of text (used for highlights).
  function treeToHtml(tree, o) {
    const wrap = o && o.wrap; let off = 0;
    const text = (s) => { if (!wrap) { off += s.length; return escHtml(s).replace(/\n/g, '<br>'); } const r = wrap(off, off + s.length, s); off += s.length; return r; };
    const walk = (a) => a.map((x) => {
      if (typeof x === 'string') return text(x);
      const inner = walk(x.c || []);
      if (x.t === 'a') { const href = x.a && safeUrl(x.a.href); return href ? '<a href="' + escHtml(href) + '" rel="noreferrer noopener">' + inner + '</a>' : inner; }
      if (x.t === 'hr') return '<hr>';
      if (x.t === 'p' || x.t === 'h3' || x.t === 'h4') return '<' + x.t + '>' + inner.replace(/(<br>)+$/, '') + '</' + x.t + '>';
      if (x.t === 'li') return '<li>' + inner.replace(/(<br>)+$/, '') + '</li>';
      if (x.t === 'tr') return '<tr>' + inner.replace(/(<br>)+$/, '') + '</tr>';
      if (x.t === 'td' || x.t === 'th') return '<' + x.t + '>' + inner.replace(/(<br>|\t)+$/, '') + '</' + x.t + '>';
      return '<' + x.t + '>' + inner + '</' + x.t + '>';
    }).join('');
    return walk(tree || []);
  }
  // Is a tree one that the sanitiser could have made? Used by `validate` so nothing foreign is ever stored.
  function treeProblem(tree) {
    let n = 0;
    const walk = (a, d) => {
      if (!Array.isArray(a) || d > LIMITS.depth + 2) return 'The rich text is nested too deeply.';
      for (const x of a) {
        if (++n > LIMITS.nodes + 100) return 'The rich text has too many parts.';
        if (typeof x === 'string') continue;
        if (!isObj(x) || !OUT_TAGS.has(x.t) || !Array.isArray(x.c)) return 'The rich text holds a part that is not allowed.';
        const keys = Object.keys(x).filter((k) => k !== 't' && k !== 'c' && k !== 'a'); if (keys.length) return 'The rich text holds a part that is not allowed.';
        if (x.a !== undefined) { if (x.t !== 'a' || !isObj(x.a) || Object.keys(x.a).some((k) => k !== 'href' && k !== 'title') || (x.a.href !== undefined && safeUrl(x.a.href) !== x.a.href) || (x.a.title !== undefined && typeof x.a.title !== 'string')) return 'The rich text holds a link that is not allowed.'; }
        const r = walk(x.c, d + 1); if (r) return r;
      }
      return null;
    };
    return walk(tree, 0);
  }
  const hasTag = (tree, f) => (tree || []).some((x) => typeof x !== 'string' && (f(x) || hasTag(x.c, f)));

  // ---------- provenance ----------
  // hint: what main (or the page) knows about where the clipboard came from: { kind, label, url?, at }. Older than two minutes, or unknown: 'Pasted'.
  function fromHint(hint, nowMs, kindIfNone) {
    const def = { kind: kindIfNone || 'pasted', label: kindIfNone === 'typed' ? 'Typed here' : kindIfNone === 'dropped' ? 'Dropped file' : 'Pasted', url: '', auto: false };
    if (!isObj(hint) || !FROM_KINDS.includes(hint.kind) || hint.kind === 'pasted' || kindIfNone === 'typed') return def;
    const age = (nowMs === undefined ? Date.now() : nowMs) - Number(hint.at || 0);
    if (!(age >= -5000 && age <= HINT_MAX_AGE_MS)) return def;
    return { kind: hint.kind, label: clip(hint.label || hint.kind, LIMITS.label), url: webUrl(hint.url), auto: true };
  }

  // ---------- the paste model ----------
  const URL_LINE = /^\s*(https?:\/\/[^\s<>"]+)\s*$/i;
  const cleanName = (s) => clip(String(s || 'file').replace(/[\\/\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'file', LIMITS.fileName);
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const firstImgSrc = (html) => { const m = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(String(html || '')); return m ? webUrl(decode(m[1] || m[2] || m[3] || '')) : ''; };
  // payload: { text, html, uris:[], files:[{name, mime, bytes, sha256, blob, w, h}] }  ->  { items:[draft], notes:[string] }
  // A draft has everything but the id, time and provenance: see makeClip.
  function classifyPaste(p) {
    const items = [], notes = [];
    const files = Array.isArray(p && p.files) ? p.files : [];
    const text = typeof (p && p.text) === 'string' ? p.text : '', html = typeof (p && p.html) === 'string' ? p.html : '';
    if (files.length) {
      const srcUrl = firstImgSrc(html);
      for (const f of files) {
        if (!f || !HASH_RE.test(f.sha256 || '') || !BLOB_RE.test(f.blob || '')) continue;
        const bytes = Math.max(0, Math.floor(Number(f.bytes) || 0));
        if (IMAGE_MIMES.includes(f.mime)) items.push({ kind: 'image', title: f.name && f.name !== 'image.png' ? cleanName(f.name) : '', image: { blob: f.blob, mime: f.mime, bytes, w: Math.floor(Number(f.w) || 0), h: Math.floor(Number(f.h) || 0), name: cleanName(f.name) }, hash: f.sha256, srcUrl });
        else items.push({ kind: 'file', title: cleanName(f.name), file: { blob: f.blob, name: cleanName(f.name), mime: clip(f.mime || 'application/octet-stream', 100), bytes }, hash: f.sha256 });
      }
      if (items.length) return { items, notes };
    }
    if (html.trim()) {
      const s = sanitizeHtml(html);
      const only = s.tree.filter((x) => typeof x !== 'string' || x.trim());
      const lone = only.length === 1 && typeof only[0] !== 'string' && only[0].t === 'a' && only[0].a && webUrl(only[0].a.href) ? only[0] : null;
      if (lone) { const url = webUrl(lone.a.href); items.push({ kind: 'link', url, title: clip(flatten(lone.c).replace(/\s+/g, ' ').trim() || hostOf(url), LIMITS.title), text: url, hash: sha256('link\n' + url) }); return { items, notes }; }
      if (s.text.trim()) {
        const formatted = hasTag(s.tree, (x) => x.t !== 'p');
        if (formatted) { if (s.truncated) notes.push('Long text was cut to ' + LIMITS.clipText.toLocaleString('en-GB') + ' characters.'); items.push({ kind: 'rich', tree: s.tree, text: s.text, hash: sha256('rich\n' + s.text), truncated: s.truncated }); return { items, notes }; }
        if (!text.trim()) { items.push({ kind: 'text', text: s.text, hash: sha256(s.text), truncated: s.truncated }); return { items, notes }; }
      }
    }
    if (text.trim()) {
      const uri = Array.isArray(p.uris) && p.uris.length === 1 ? webUrl(p.uris[0]) : '';
      const m = URL_LINE.exec(text);
      const url = m ? webUrl(m[1]) : uri && text.trim() === uri ? uri : '';
      if (url) { items.push({ kind: 'link', url, title: hostOf(url), text: url, hash: sha256('link\n' + url) }); return { items, notes }; }
      let t = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, ''); let truncated = false;
      if (t.length > LIMITS.clipText) { t = t.slice(0, LIMITS.clipText); truncated = true; notes.push('Long text was cut to ' + LIMITS.clipText.toLocaleString('en-GB') + ' characters.'); }
      t = t.replace(/\s+$/, '');
      items.push({ kind: 'text', text: t, hash: sha256(t), truncated }); return { items, notes };
    }
    return { items, notes: ['Nothing to paste.'] };
  }
  function makeClip(d, o) {
    o = o || {};
    const c = { id: o.id || rid('c', 6), kind: d.kind, t: nowIso(o.now), title: clip(d.title || '', LIMITS.title), text: '', from: o.from && FROM_KINDS.includes(o.from.kind) ? { kind: o.from.kind, label: clip(o.from.label, LIMITS.label), url: webUrl(o.from.url), auto: !!o.from.auto } : { kind: 'pasted', label: 'Pasted', url: '', auto: false },
      hash: d.hash, tags: [], pinned: false, hl: [], sent: [] };
    if (d.kind === 'text') c.text = d.text;
    if (d.kind === 'rich') { c.text = d.text; c.tree = d.tree; }
    if (d.kind === 'link') { c.text = d.url; c.url = d.url; }
    if (d.kind === 'image') { c.image = d.image; if (d.srcUrl && !c.from.url) c.from.url = d.srcUrl; }
    if (d.kind === 'file') c.file = d.file;
    return c;
  }
  const textOf = (c) => (c.kind === 'image' ? [c.title, c.image && c.image.name].filter(Boolean).join(' ') : c.kind === 'file' ? c.file.name : c.text || '');
  const hasText = (c) => c.kind === 'text' || c.kind === 'rich' || c.kind === 'link';

  // ---------- documents and tabs ----------
  const newTab = (title, now) => ({ id: rid('t', 4), title: clip(title || 'Notes', LIMITS.tabTitle), created: nowIso(now), report: false, clips: [] });
  function newDoc(scope, now) { const t = newTab('Notes', now); return { format: FORMAT, scope: String(scope || 'inbox'), updated: nowIso(now), active: t.id, tabs: [t], closed: [], settings: {} }; }
  const touch = (doc, now) => { doc.updated = nowIso(now); return doc; };
  const tabById = (doc, id) => doc.tabs.find((t) => t.id === id) || null;
  const activeTab = (doc) => tabById(doc, doc.active) || doc.tabs[0];
  function uniqueTitle(doc, base) { const names = new Set(doc.tabs.map((t) => t.title)); if (!names.has(base)) return base; for (let n = 2; n < 1000; n++) if (!names.has(base + ' ' + n)) return base + ' ' + n; return base; }
  function addTab(doc, title, now) {
    if (doc.tabs.length >= LIMITS.tabs) return { error: 'There are already ' + LIMITS.tabs + ' tabs. Close one first.' };
    const t = newTab(title ? clip(title, LIMITS.tabTitle) : uniqueTitle(doc, 'Notes'), now); doc.tabs.push(t); doc.active = t.id; touch(doc, now); return { tab: t };
  }
  function renameTab(doc, id, title, now) { const t = tabById(doc, id), s = clip(title, LIMITS.tabTitle).trim(); if (!t || !s) return false; t.title = s; touch(doc, now); return true; }
  // Moves a tab to position `to` (0-based, clamped).
  function moveTab(doc, id, to, now) { const i = doc.tabs.findIndex((t) => t.id === id); if (i < 0) return false; const j = Math.max(0, Math.min(doc.tabs.length - 1, Math.floor(to))); if (i === j) return false; const [t] = doc.tabs.splice(i, 1); doc.tabs.splice(j, 0, t); touch(doc, now); return true; }
  // Closing keeps the tab (with its clips) in `closed` so it can be restored. Closing the last tab leaves a new empty one.
  function closeTab(doc, id, now) {
    const i = doc.tabs.findIndex((t) => t.id === id); if (i < 0) return null;
    const [t] = doc.tabs.splice(i, 1);
    doc.closed.push({ tab: t, index: i, closedAt: nowIso(now) }); while (doc.closed.length > LIMITS.closed) doc.closed.shift();
    if (!doc.tabs.length) { const f = newTab('Notes', now); doc.tabs.push(f); doc.active = f.id; } else if (doc.active === id) doc.active = doc.tabs[Math.min(i, doc.tabs.length - 1)].id;
    touch(doc, now); return t;
  }
  // Restores the most recently closed tab, or the one with this id. Returns the tab, or null.
  function restoreTab(doc, id, now) {
    if (!doc.closed.length || doc.tabs.length >= LIMITS.tabs) return null;
    let k = id ? doc.closed.findIndex((c) => c.tab.id === id) : doc.closed.length - 1; if (k < 0) return null;
    const [c] = doc.closed.splice(k, 1); const t = c.tab;
    if (doc.tabs.some((x) => x.id === t.id)) t.id = rid('t', 4);
    if (doc.tabs.length === 1 && !doc.tabs[0].clips.length && c.index === 0) doc.tabs.splice(0, 1, t); else doc.tabs.splice(Math.min(c.index, doc.tabs.length), 0, t);
    doc.active = t.id; touch(doc, now); return t;
  }
  function discardClosed(doc, id, now) { const k = doc.closed.findIndex((c) => c.tab.id === id); if (k < 0) return false; doc.closed.splice(k, 1); touch(doc, now); return true; }
  const totalClips = (doc) => doc.tabs.reduce((n, t) => n + t.clips.length, 0);
  function findClip(doc, id) { for (const t of doc.tabs) { const i = t.clips.findIndex((c) => c.id === id); if (i >= 0) return { tab: t, clip: t.clips[i], index: i }; } return null; }
  // Adds clips to a tab. A clip whose hash and kind already sit in that tab is skipped. -> { added:[clip], skipped:[clip], error? }
  function addClips(doc, tabId, clips, now) {
    const tab = tabById(doc, tabId) || activeTab(doc), added = [], skipped = [];
    for (const c of clips) {
      if (tab.clips.some((x) => x.hash === c.hash && x.kind === c.kind)) { skipped.push(c); continue; }
      if (totalClips(doc) >= LIMITS.clips) return { added, skipped, error: 'This note holds ' + LIMITS.clips + ' clips already.' };
      tab.clips.push(c); added.push(c);
    }
    if (added.length) touch(doc, now);
    return { added, skipped, tab };
  }
  function removeClip(doc, id, now) { const f = findClip(doc, id); if (!f) return null; f.tab.clips.splice(f.index, 1); touch(doc, now); return f.clip; }
  function moveClip(doc, id, toTab, now) { const f = findClip(doc, id), t = tabById(doc, toTab); if (!f || !t || f.tab === t) return false; f.tab.clips.splice(f.index, 1); const dup = t.clips.some((x) => x.hash === f.clip.hash && x.kind === f.clip.kind); if (dup) { f.tab.clips.splice(f.index, 0, f.clip); return false; } t.clips.push(f.clip); touch(doc, now); return true; }
  const togglePin = (doc, id, now) => { const f = findClip(doc, id); if (!f) return null; f.clip.pinned = !f.clip.pinned; touch(doc, now); return f.clip.pinned; };
  const setTitle = (doc, id, title, now) => { const f = findClip(doc, id); if (!f) return false; f.clip.title = clip(title, LIMITS.title).trim(); touch(doc, now); return true; };
  const setFrom = (doc, id, o, now) => { const f = findClip(doc, id); if (!f) return false; f.clip.from = { kind: f.clip.from.kind, label: clip(o.label, LIMITS.label).trim() || f.clip.from.label, url: webUrl(o.url), auto: false }; touch(doc, now); return true; };
  const normTag = (s) => clip(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}_.:/ -]+/gu, '').replace(/\s+/g, ' ').trim(), LIMITS.tagLen);
  function addTag(doc, id, tag, now) { const f = findClip(doc, id), t = normTag(tag); if (!f || !t || f.clip.tags.includes(t) || f.clip.tags.length >= LIMITS.tags) return false; f.clip.tags.push(t); touch(doc, now); return true; }
  function removeTag(doc, id, tag, now) { const f = findClip(doc, id); if (!f || !f.clip.tags.includes(tag)) return false; f.clip.tags = f.clip.tags.filter((x) => x !== tag); touch(doc, now); return true; }
  function allTags(doc) { const m = {}; for (const t of doc.tabs) for (const c of t.clips) for (const g of c.tags) m[g] = (m[g] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([tag, n]) => ({ tag, n })); }
  function setReportTabs(doc, ids, now) { const s = new Set(ids); for (const t of doc.tabs) t.report = s.has(t.id); touch(doc, now); }

  // ---------- highlights ----------
  // A highlight is a range [a, b) of the clip's text, with a colour, an underline, or both, and an optional comment. Ranges may overlap.
  const hlLen = (c) => (hasText(c) ? c.text.length : 0);
  function addHighlight(doc, clipId, o, now) {
    const f = findClip(doc, clipId); if (!f || !hasText(f.clip)) return { error: 'This clip has no text to mark.' };
    const c = f.clip, len = hlLen(c);
    let a = Math.max(0, Math.min(len, Math.floor(Number(o.a)))), b = Math.max(0, Math.min(len, Math.floor(Number(o.b))));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return { error: 'Select some text first.' };
    if (a > b) [a, b] = [b, a];
    if (a === b) return { error: 'Select some text first.' };
    const color = COLORS.includes(o.color) ? o.color : null, u = !!o.u;
    if (!color && !u) return { error: 'Choose a colour or underline.' };
    const same = c.hl.find((h) => h.a === a && h.b === b && (u ? true : !!h.color || h.u));
    if (same) {
      if (u) { if (same.u) { same.u = false; if (!same.color) c.hl.splice(c.hl.indexOf(same), 1); } else same.u = true; touch(doc, now); return { toggled: true, id: same.id }; }
      if (same.color === color) { same.color = null; if (!same.u) c.hl.splice(c.hl.indexOf(same), 1); touch(doc, now); return { toggled: true, id: same.id }; }
      same.color = color; if (o.comment) same.comment = clip(o.comment, LIMITS.comment); touch(doc, now); return { id: same.id, recoloured: true };
    }
    if (c.hl.length >= LIMITS.highlights) return { error: 'This clip already has ' + LIMITS.highlights + ' highlights.' };
    const h = { id: rid('h', 4), a, b, color, u, comment: clip(o.comment || '', LIMITS.comment), t: nowIso(now) }; c.hl.push(h); touch(doc, now); return { id: h.id, a, b };
  }
  function setHighlightComment(doc, clipId, hid, comment, now) { const f = findClip(doc, clipId); const h = f && f.clip.hl.find((x) => x.id === hid); if (!h) return false; h.comment = clip(comment, LIMITS.comment); touch(doc, now); return true; }
  function removeHighlight(doc, clipId, hid, now) { const f = findClip(doc, clipId); if (!f) return false; const n = f.clip.hl.length; f.clip.hl = f.clip.hl.filter((x) => x.id !== hid); if (f.clip.hl.length === n) return false; touch(doc, now); return true; }
  // Removes every highlight that touches [a, b). With no range, removes all of them.
  function clearHighlights(doc, clipId, a, b, now) { const f = findClip(doc, clipId); if (!f) return 0; const n = f.clip.hl.length; f.clip.hl = a === undefined ? [] : f.clip.hl.filter((h) => !(h.a < b && h.b > a)); if (n !== f.clip.hl.length) touch(doc, now); return n - f.clip.hl.length; }
  // Cuts [s, e) of a text into pieces, each with the highlights that cover it. Pieces tile the range exactly. -> [{a, b, hl:[highlight]}]
  function coverage(s, e, hls) {
    const cuts = new Set([s, e]); for (const h of hls || []) { if (h.a > s && h.a < e) cuts.add(h.a); if (h.b > s && h.b < e) cuts.add(h.b); }
    const xs = [...cuts].sort((p, q) => p - q), out = [];
    for (let i = 0; i + 1 < xs.length; i++) out.push({ a: xs[i], b: xs[i + 1], hl: (hls || []).filter((h) => h.a <= xs[i] && h.b >= xs[i + 1]) });
    return out;
  }
  // Which colour shows on a piece: the most recent highlight with a colour wins; underline shows if any covering highlight has it.
  const pieceStyle = (hl) => { let color = null, u = false; for (const h of hl) { if (h.color) color = h.color; if (h.u) u = true; } return { color, u }; };

  // ---------- search ----------
  const fold = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Terms are ANDed. Filters: tag:x  color:red  kind:image  is:pinned  tab:name  from:name. Quotes keep a phrase together.
  function parseQuery(q) {
    const terms = [], f = { tags: [], colors: [], kinds: [], pinned: false, tab: [], from: [] };
    for (const m of String(q || '').matchAll(/(?:(tag|color|colour|kind|is|tab|from):)?(?:"([^"]*)"|(\S+))/gi)) {
      const key = (m[1] || '').toLowerCase(), v = fold(m[2] !== undefined ? m[2] : m[3]).trim(); if (!v) continue;
      if (key === 'tag') f.tags.push(v); else if (key === 'color' || key === 'colour') f.colors.push(v); else if (key === 'kind') f.kinds.push(v); else if (key === 'is') { if (v === 'pinned') f.pinned = true; else terms.push(v); } else if (key === 'tab') f.tab.push(v); else if (key === 'from') f.from.push(v); else terms.push(v);
    }
    return { terms, ...f };
  }
  const snippet = (text, i, len) => { const a = Math.max(0, i - 30), b = Math.min(text.length, i + len + 50); return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : ''); };
  // -> [{ tab, tabTitle, clip, field, snippet, at }] across every tab (or one tab), pinned first, then newest first.
  function search(doc, q, o) {
    const p = parseQuery(q), out = [];
    if (!p.terms.length && !p.tags.length && !p.colors.length && !p.kinds.length && !p.pinned && !p.tab.length && !p.from.length) return out;
    for (const tab of doc.tabs) {
      if (o && o.tab && o.tab !== tab.id) continue;
      if (p.tab.length && !p.tab.every((x) => fold(tab.title).includes(x))) continue;
      for (const c of tab.clips) {
        if (p.pinned && !c.pinned) continue;
        if (p.kinds.length && !p.kinds.every((k) => c.kind === k || (k === 'text' && c.kind === 'rich'))) continue;
        if (p.tags.length && !p.tags.every((x) => c.tags.some((g) => fold(g).includes(x)))) continue;
        if (p.colors.length && !p.colors.every((x) => c.hl.some((h) => h.color === x || (x === 'underline' && h.u)))) continue;
        if (p.from.length && !p.from.every((x) => fold(c.from.label + ' ' + c.from.url).includes(x))) continue;
        const fields = [['text', textOf(c)], ['title', c.title], ['url', c.url || ''], ['source', c.from.label + ' ' + c.from.url], ['tag', c.tags.join(' ')], ['comment', c.hl.map((h) => h.comment).filter(Boolean).join('\n')], ['file', c.file ? c.file.name : ''], ['hash', c.hash]];
        let hit = null; const folded = fields.map(([k, v]) => [k, v, fold(v)]);
        if (!p.terms.length) hit = { field: p.tags.length ? 'tag' : 'text', snippet: snippet(textOf(c) || c.title || c.from.label, 0, 0), at: 0 };
        else {
          const ok = p.terms.every((t) => folded.some(([, , fv]) => fv.includes(t)));
          if (ok) { const t0 = p.terms[0]; const fh = folded.find(([, , fv]) => fv.includes(t0)) || folded[0]; const idx = Math.max(0, fh[2].indexOf(t0)); hit = { field: fh[0], snippet: snippet(fh[1], idx, t0.length), at: idx }; }
        }
        if (hit) out.push({ tab: tab.id, tabTitle: tab.title, clip: c.id, field: hit.field, snippet: hit.snippet, at: hit.at, pinned: c.pinned, t: c.t });
      }
    }
    return out.sort((a, b) => (a.pinned === b.pinned ? (a.t < b.t ? 1 : a.t > b.t ? -1 : 0) : a.pinned ? -1 : 1));
  }

  // ---------- storage figures ----------
  function blobRefs(doc, includeClosed) {
    const s = new Set(); const add = (t) => { for (const c of t.clips) { if (c.image) s.add(c.image.blob); if (c.file) s.add(c.file.blob); } };
    for (const t of doc.tabs) add(t); if (includeClosed !== false) for (const c of doc.closed || []) add(c.tab);
    return s;
  }
  function usage(doc) {
    const seen = new Map(); const add = (t) => { for (const c of t.clips) { const b = c.image || c.file; if (b) seen.set(b.blob, b.bytes || 0); } };
    for (const t of doc.tabs) add(t); for (const c of doc.closed || []) add(c.tab);
    let bytes = 0; for (const v of seen.values()) bytes += v;
    return { blobs: seen.size, blobBytes: bytes, clips: totalClips(doc) };
  }

  // ---------- load and check ----------
  function normalize(doc, scope) {
    if (!isObj(doc)) return newDoc(scope);
    doc.format = FORMAT; doc.scope = String(scope || doc.scope || 'inbox'); doc.settings = isObj(doc.settings) ? doc.settings : {};
    const fixTab = (t) => {
      t.id = ID_RE.test(String(t.id)) ? String(t.id) : rid('t', 4); t.title = clip(t.title || 'Notes', LIMITS.tabTitle) || 'Notes'; t.created = typeof t.created === 'string' ? t.created : nowIso(); t.report = !!t.report;
      t.clips = (Array.isArray(t.clips) ? t.clips : []).filter(isObj).map((c) => {
        c.hl = (Array.isArray(c.hl) ? c.hl : []).filter((h) => isObj(h) && Number.isFinite(h.a) && Number.isFinite(h.b)).map((h) => ({ id: ID_RE.test(String(h.id)) ? String(h.id) : rid('h', 4), a: Math.max(0, Math.floor(h.a)), b: Math.floor(h.b), color: COLORS.includes(h.color) ? h.color : null, u: !!h.u, comment: clip(h.comment, LIMITS.comment), t: typeof h.t === 'string' ? h.t : nowIso() }));
        const len = hlLen(c); c.hl = c.hl.filter((h) => h.b <= len && h.a < h.b && (h.color || h.u)).slice(0, LIMITS.highlights);
        c.tags = (Array.isArray(c.tags) ? c.tags : []).filter((g) => typeof g === 'string').slice(0, LIMITS.tags); c.sent = (Array.isArray(c.sent) ? c.sent : []).filter(isObj).slice(0, 50); c.pinned = !!c.pinned; c.title = clip(c.title, LIMITS.title);
        return c;
      });
      return t;
    };
    doc.tabs = (Array.isArray(doc.tabs) ? doc.tabs : []).filter(isObj).map(fixTab);
    if (!doc.tabs.length) doc.tabs.push(newTab('Notes'));
    doc.closed = (Array.isArray(doc.closed) ? doc.closed : []).filter((c) => isObj(c) && isObj(c.tab)).map((c) => ({ tab: fixTab(c.tab), index: Math.max(0, Math.floor(Number(c.index) || 0)), closedAt: typeof c.closedAt === 'string' ? c.closedAt : nowIso() })).slice(-LIMITS.closed);
    if (!tabById(doc, doc.active)) doc.active = doc.tabs[0].id;
    doc.updated = typeof doc.updated === 'string' ? doc.updated : nowIso();
    return doc;
  }
  function validate(doc) {
    const p = [];
    if (!isObj(doc)) return ['The notes are not an object.'];
    if (doc.format !== FORMAT) p.push('Unknown notes format.');
    if (typeof doc.scope !== 'string' || !/^(inbox|[A-Za-z0-9_-]{8,64})$/.test(doc.scope)) p.push('The notes scope is not valid.');
    if (!Array.isArray(doc.tabs) || !doc.tabs.length || doc.tabs.length > LIMITS.tabs) p.push('The notes need between 1 and ' + LIMITS.tabs + ' tabs.');
    if (!Array.isArray(doc.closed) || doc.closed.length > LIMITS.closed) p.push('Too many closed tabs.');
    if (p.length) return p;
    const ids = new Set(); let clips = 0;
    const checkTab = (t, where) => {
      if (!isObj(t) || !ID_RE.test(String(t.id)) || typeof t.title !== 'string' || t.title.length > LIMITS.tabTitle || !Array.isArray(t.clips)) { p.push(where + ' is malformed.'); return; }
      if (ids.has(t.id)) p.push('Two tabs share an id.'); ids.add(t.id);
      for (const c of t.clips) {
        clips++;
        if (!isObj(c) || !ID_RE.test(String(c.id))) { p.push('A clip in "' + clip(t.title, 30) + '" is malformed.'); continue; }
        const w = 'Clip ' + c.id;
        if (!KINDS.includes(c.kind)) p.push(w + ' has an unknown kind.');
        if (!HASH_RE.test(c.hash || '')) p.push(w + ' has no item hash.');
        if (typeof c.t !== 'string' || !Number.isFinite(Date.parse(c.t))) p.push(w + ' has no time.');
        if (typeof c.text !== 'string' || c.text.length > LIMITS.clipText) p.push(w + ' has text that is missing or too long.');
        if (typeof c.title !== 'string' || c.title.length > LIMITS.title) p.push(w + ' has a bad title.');
        if (!isObj(c.from) || !FROM_KINDS.includes(c.from.kind) || typeof c.from.label !== 'string' || c.from.label.length > LIMITS.label || (c.from.url && !webUrl(c.from.url))) p.push(w + ' has no valid source.');
        if (!Array.isArray(c.tags) || c.tags.length > LIMITS.tags || c.tags.some((g) => typeof g !== 'string' || g.length > LIMITS.tagLen)) p.push(w + ' has bad tags.');
        if (c.kind === 'rich') { const r = Array.isArray(c.tree) ? treeProblem(c.tree) : 'The rich text is missing.'; if (r) p.push(w + ': ' + r); else if (flatten(c.tree) !== c.text) p.push(w + ' has text that does not match its rich text.'); } else if (c.tree !== undefined) p.push(w + ' carries rich text it should not.');
        if (c.kind === 'link' && (!webUrl(c.url) || c.url !== c.text)) p.push(w + ' has a bad link.');
        if (c.kind === 'image' && !(isObj(c.image) && BLOB_RE.test(c.image.blob || '') && IMAGE_MIMES.includes(c.image.mime) && Number.isInteger(c.image.bytes) && c.image.bytes >= 0 && c.image.bytes <= LIMITS.blobBytes)) p.push(w + ' has a bad image.');
        if (c.kind === 'file' && !(isObj(c.file) && BLOB_RE.test(c.file.blob || '') && typeof c.file.name === 'string' && c.file.name.length <= LIMITS.fileName && Number.isInteger(c.file.bytes) && c.file.bytes >= 0 && c.file.bytes <= LIMITS.blobBytes)) p.push(w + ' has a bad file.');
        if (!Array.isArray(c.hl) || c.hl.length > LIMITS.highlights) p.push(w + ' has bad highlights.');
        else for (const h of c.hl) if (!isObj(h) || !Number.isInteger(h.a) || !Number.isInteger(h.b) || h.a < 0 || h.a >= h.b || h.b > (c.text || '').length || !(h.color === null || COLORS.includes(h.color)) || !(h.color || h.u) || typeof h.comment !== 'string' || h.comment.length > LIMITS.comment) { p.push(w + ' has a highlight outside its text.'); break; }
        if (p.length > 20) return;
      }
    };
    doc.tabs.forEach((t) => checkTab(t, 'A tab'));
    doc.closed.forEach((c) => checkTab(c && c.tab, 'A closed tab'));
    if (clips > LIMITS.clips) p.push('Too many clips.');
    if (!tabById(doc, doc.active)) p.push('The active tab does not exist.');
    return p;
  }

  // ---------- send to a case ----------
  const isIp4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((x) => Number(x) <= 255);
  const isIp6 = (s) => /^[0-9a-f:]{2,45}$/i.test(s) && (s.match(/:/g) || []).length >= 2;
  const isDomain = (s) => /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(s);
  // What kind of entity a clip most likely is, and the value and label to propose. The person can change all three.
  function suggestEntity(c) {
    if (c.kind === 'link') return { type: 'url', value: c.url, label: clip(c.title || c.url, 300) };
    if (c.kind === 'image') return { type: 'image', value: c.title || 'Image ' + shortHash(c.hash), label: clip(c.title || 'Image ' + shortHash(c.hash), 300) };
    if (c.kind === 'file') return { type: 'document', value: c.file.name, label: clip(c.file.name, 300) };
    const first = clip((c.text || '').split('\n').map((x) => x.trim()).find(Boolean) || '', 300), one = (c.text || '').trim();
    if (one && !/\s/.test(one)) { if (isIp4(one) || isIp6(one)) return { type: 'ip', value: one, label: one }; if (/^AS\d{1,10}$/i.test(one)) return { type: 'asn', value: one, label: one.toUpperCase() }; if (isDomain(one.replace(/\.$/, ''))) return { type: 'domain', value: one.replace(/\.$/, '').toLowerCase(), label: one.replace(/\.$/, '').toLowerCase() }; }
    return { type: 'finding', value: clip(first, 80) || 'Note', label: clip(first, 80) || 'Note' };
  }
  // Adds the clip to an open case. M is the case model. o: { mode:'new'|'attach', type, value, label, entityId, now }.
  // The clip is recorded as a source of the case (tool "quick-notes", the item hash, where it came from), so the entity is never unsourced.
  function sendToCase(M, c, cl, o) {
    o = o || {}; const now = o.now;
    const note = clip('Quick note: ' + (cl.from.label || 'pasted') + (cl.from.auto ? '' : ' (as entered)') + '. Saved ' + cl.t.replace('T', ' ').slice(0, 16) + ' UTC. Item hash ' + shortHash(cl.hash) + '.', 500);
    const sid = M.addSource(c, { connector: 'quick-notes', connectorVersion: '1', query: null, fetchedAt: cl.t, origin: cl.from.url || cl.url || '', licence: '', attribution: '', rawSha256: cl.hash, note });
    let id = null, merged = false;
    if (o.mode === 'attach') {
      const e = c.entities[o.entityId]; if (!e) return { error: 'That entity is no longer in the case.' };
      if (!e.sources.includes(sid)) e.sources.push(sid); const seen = nowIso(now); if (seen > e.lastSeen) e.lastSeen = seen; id = e.id; merged = true;
      if (!e.attrs.note && hasText(cl) && cl.kind !== 'link') e.attrs.note = clip(cl.text.replace(/\s+/g, ' ').trim(), 300);
    } else {
      const sug = suggestEntity(cl); const type = M.ENTITY_TYPES.includes(o.type) && o.type !== 'email' ? o.type : sug.type;
      const value = clip(o.value, 500).trim() || sug.value, label = clip(o.label, 300).trim() || value;
      const attrs = { clipHash: cl.hash };
      if (type === 'finding') attrs.kind = 'note';
      if (hasText(cl) && cl.kind !== 'link' && type !== 'finding') attrs.note = clip(cl.text.replace(/\s+/g, ' ').trim(), 300);
      if (type === 'finding') attrs.note = clip(cl.text.replace(/\s+/g, ' ').trim(), 300);
      if (cl.kind === 'file') attrs.file = cl.file.name; if (cl.kind === 'image') attrs.sha256 = cl.hash;
      const r = M.addEntity(c, { type, value, label, attrs, sources: [sid], manual: true, seen: cl.t });
      if (!r.id) return { error: r.error || 'The case could not take that.' };
      id = r.id; merged = r.merged;
      if (merged) { const e = c.entities[id]; if (!e.sources.includes(sid)) e.sources.push(sid); }
    }
    return { entityId: id, sourceId: sid, merged, label: c.entities[id].label };
  }
  function markSent(doc, clipId, info, now) { const f = findClip(doc, clipId); if (!f) return false; f.clip.sent.push({ t: nowIso(now), entity: info.entityId, label: clip(info.label, 120), case: info.caseId || '' }); if (f.clip.sent.length > 50) f.clip.sent.shift(); touch(doc, now); return true; }

  // ---------- undo and redo ----------
  // run(label, fn) saves the document before fn changes it. Changes with the same group inside windowMs (typing a comment) count as one step.
  // The document is edited in place (the page holds references to it), so undo and redo restore into the same object.
  class History {
    constructor(doc, limit) { this.doc = doc; this.limit = limit || UNDO_LIMIT; this.undoStack = []; this.redoStack = []; this.lastGroup = null; this.lastAt = 0; this.bytes = 0; }
    snapshot() { return JSON.stringify(this.doc); }
    restore(s) { const o = JSON.parse(s); for (const k of Object.keys(this.doc)) delete this.doc[k]; Object.assign(this.doc, o); }
    _trim() { while (this.undoStack.length > this.limit || (this.bytes > UNDO_BYTES && this.undoStack.length > 1)) { const x = this.undoStack.shift(); this.bytes -= x.s.length; } }
    run(label, fn, o) {
      const { group = null, windowMs = 800, now = Date.now() } = o || {};
      const coalesce = group && this.lastGroup === group && now - this.lastAt < windowMs && this.undoStack.length;
      if (!coalesce) { const s = this.snapshot(); this.undoStack.push({ label, s }); this.bytes += s.length; this._trim(); }
      this.redoStack.length = 0; this.lastGroup = group; this.lastAt = now;
      return fn(this.doc);
    }
    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    undo() { const st = this.undoStack.pop(); if (!st) return null; this.bytes -= st.s.length; this.redoStack.push({ label: st.label, s: this.snapshot() }); this.restore(st.s); this.lastGroup = null; return st.label; }
    redo() { const st = this.redoStack.pop(); if (!st) return null; const s = this.snapshot(); this.undoStack.push({ label: st.label, s }); this.bytes += s.length; this.restore(st.s); this.lastGroup = null; return st.label; }
    reset(doc) { if (doc) this.doc = doc; this.undoStack.length = 0; this.redoStack.length = 0; this.lastGroup = null; this.bytes = 0; }
  }

  return { FORMAT, LIMITS, COLORS, KINDS, FROM_KINDS, IMAGE_MIMES, HINT_MAX_AGE_MS, UNDO_LIMIT, sha256, shortHash, safeUrl, webUrl, sanitizeHtml, flatten, treeToHtml, treeProblem, escHtml, fromHint, classifyPaste, makeClip, textOf, hasText,
    newTab, newDoc, activeTab, tabById, addTab, renameTab, moveTab, closeTab, restoreTab, discardClosed, findClip, addClips, removeClip, moveClip, togglePin, setTitle, setFrom, addTag, removeTag, allTags, normTag, setReportTabs, totalClips,
    addHighlight, setHighlightComment, removeHighlight, clearHighlights, coverage, pieceStyle, parseQuery, search, blobRefs, usage, normalize, validate, suggestEntity, sendToCase, markSent, History, rid };
});
