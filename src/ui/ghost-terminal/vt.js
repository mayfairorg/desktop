// Ghost terminal: screen model for terminal output (no DOM, so it runs in tests without a display).
// Handles the escape sequences command-line tools actually print: colours (16, 256, true colour), cursor movement, erase, insert/delete,
// scroll regions, the alternate screen, wide characters, tabs. It never answers back: nothing is written to the shell except keys and pastes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GhostVT = factory();
})(this, function () {
  'use strict';

  // Terminal column width of a code point: 0 (combining), 2 (wide, emoji), 1.
  function cw(cp) {
    if (cp < 0x300) return 1;
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x20e3 || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff) || (cp >= 0x20d0 && cp <= 0x20ff)) return 0;
    if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
    return 1;
  }

  const DEFAULT = { fg: -1, bg: -1, b: 0, d: 0, i: 0, u: 0, r: 0, s: 0 };
  const styleKey = (a) => a.fg + '|' + a.bg + '|' + a.b + a.d + a.i + a.u + a.r + a.s;
  const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  class Screen {
    constructor(cols = 80, rows = 24, { scrollback = 3000, convertEol = false } = {}) {
      this.cols = cols; this.rows = rows; this.maxScroll = scrollback; this.convertEol = convertEol;
      this.styles = [Object.assign({}, DEFAULT)]; this.styleIds = new Map([[styleKey(DEFAULT), 0]]);
      this.ver = 0;
      this.cur = Object.assign({}, DEFAULT);
      this.x = 0; this.y = 0; this.pending = false; this.top = 0; this.bottom = rows - 1;
      this.saved = null; this.mainSaved = null;
      this.alt = false; this.appCursor = false; this.bracketed = false; this.showCursor = true; this.autowrap = true; this.title = '';
      this.tabs = null;
      this.lines = []; this.scrollback = [];
      for (let i = 0; i < rows; i++) this.lines.push(this._blank(0));
      this.mode = 0; this.csiBuf = ''; this.strBuf = ''; this.strEsc = false; this.decoder = '';
    }

    // ---- styles and lines ----
    styleId(a) {
      const k = styleKey(a);
      let id = this.styleIds.get(k);
      if (id === undefined) { id = this.styles.length; this.styles.push(Object.assign({}, a)); this.styleIds.set(k, id); }
      return id;
    }
    curId() { return this.styleId(this.cur); }
    eraseId() { return this.cur.bg === -1 ? 0 : this.styleId(Object.assign({}, DEFAULT, { bg: this.cur.bg })); }
    _blank(st) { return { ch: new Array(this.cols).fill(' '), st: new Array(this.cols).fill(st), v: ++this.ver }; }
    _touch(l) { l.v = ++this.ver; }

    // ---- public ----
    resize(cols, rows) {
      cols = clamp(cols | 0, 2, 1000); rows = clamp(rows | 0, 1, 500);
      if (cols === this.cols && rows === this.rows) return;
      const fix = (l) => {
        if (l.ch.length > cols) { l.ch.length = cols; l.st.length = cols; } else while (l.ch.length < cols) { l.ch.push(' '); l.st.push(0); }
        this._touch(l);
      };
      for (const l of this.lines) fix(l);
      for (const l of this.scrollback) fix(l);
      this.cols = cols;
      if (rows < this.rows) {
        let cut = this.rows - rows;
        while (cut > 0) {
          if (this.y > 0) { const l = this.lines.shift(); if (!this.alt) this._push(l); this.y--; } else this.lines.pop();
          cut--;
        }
      } else if (rows > this.rows) {
        let add = rows - this.rows;
        while (add > 0) {
          if (!this.alt && this.scrollback.length) { this.lines.unshift(this.scrollback.pop()); this.y++; } else this.lines.push(this._blank(0));
          add--;
        }
      }
      this.rows = rows; this.top = 0; this.bottom = rows - 1;
      this.x = Math.min(this.x, cols - 1); this.y = clamp(this.y, 0, rows - 1); this.pending = false; this.tabs = null;
      this.ver++;
    }
    reset() {
      const { cols, rows } = this;
      Object.assign(this, new Screen(cols, rows, { scrollback: this.maxScroll, convertEol: this.convertEol }));
    }
    // total lines (scrollback + screen); line(i) is the i-th of them from the oldest
    get total() { return this.scrollback.length + this.rows; }
    line(i) { return i < this.scrollback.length ? this.scrollback[i] : this.lines[i - this.scrollback.length]; }
    lineText(l) { let s = ''; for (let i = 0; i < l.ch.length; i++) s += l.ch[i]; return s.replace(/\s+$/, ''); }
    // consecutive cells with the same style as {text, st}; the placeholder cell after a wide character is skipped
    runs(l) {
      const out = []; let cur = null;
      for (let i = 0; i < l.ch.length; i++) {
        const c = l.ch[i]; if (c === '') continue;
        if (cur && cur.st === l.st[i]) cur.text += c; else { cur = { text: c, st: l.st[i], x: i }; out.push(cur); }
      }
      return out;
    }
    // css-ready description of a style id: {fg, bg} as '#rrggbb' or a palette index 0..15 (kept as numbers for classes), plus flags
    describe(id) { return this.styles[id] || this.styles[0]; }

    // ---- writing ----
    write(data) {
      if (this.decoder) { data = this.decoder + data; this.decoder = ''; }
      for (let i = 0; i < data.length; i++) {
        const c = data.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 >= data.length) { this.decoder = data[i]; break; }
        this._ch(c >= 0xd800 && c <= 0xdbff ? (i++, data.codePointAt(i - 1)) : c);
      }
    }
    _ch(c) {
      switch (this.mode) {
        case 1: return this._esc(c);
        case 2: return this._csi(c);
        case 3: case 4: return this._str(c);
        case 5: this.mode = 0; return;                    // ESC ( B and the like: one more character, ignored
        default: break;
      }
      if (c < 0x20 || c === 0x7f) return this._ctl(c);
      this._print(c);
    }
    _ctl(c) {
      switch (c) {
        case 0x1b: this.mode = 1; break;
        case 0x0a: case 0x0b: case 0x0c: this._lf(); if (this.convertEol) { this.x = 0; } break;
        case 0x0d: this.x = 0; this.pending = false; break;
        case 0x08: if (this.x > 0) this.x--; this.pending = false; break;
        case 0x09: this._tab(1); break;
        default: break;                                   // bell and the rest are ignored
      }
    }
    _esc(c) {
      this.mode = 0;
      switch (c) {
        case 0x5b: this.mode = 2; this.csiBuf = ''; break;                           // [
        case 0x5d: this.mode = 3; this.strBuf = ''; this.strEsc = false; break;      // ]
        case 0x50: case 0x58: case 0x5e: case 0x5f: this.mode = 4; this.strBuf = ''; this.strEsc = false; break;   // P X ^ _
        case 0x28: case 0x29: case 0x2a: case 0x2b: case 0x23: case 0x25: this.mode = 5; break;
        case 0x37: this.saved = this._save(); break;                                 // 7
        case 0x38: if (this.saved) this._restore(this.saved); break;                 // 8
        case 0x44: this._lf(); break;                                                // D
        case 0x45: this._lf(); this.x = 0; break;                                    // E
        case 0x4d: this._ri(); break;                                                // M
        case 0x63: this.reset(); break;                                              // c
        case 0x1b: this.mode = 1; break;
        default: break;                                                              // = > H and the rest
      }
    }
    _str(c) {
      // OSC ends with BEL or ESC \ ; the other string types with ESC \ . The content is dropped except the window title.
      if (c === 0x07 && this.mode === 3) return this._strEnd();
      if (c === 0x1b) { this.strEsc = true; return; }
      if (this.strEsc) { this.strEsc = false; if (c === 0x5c) return this._strEnd(); }
      if (this.strBuf.length < 512) this.strBuf += String.fromCodePoint(c);
    }
    _strEnd() {
      if (this.mode === 3) { const m = /^[012];(.*)$/s.exec(this.strBuf); if (m) this.title = m[1].replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200); }
      this.mode = 0; this.strBuf = '';
    }
    _csi(c) {
      if (c >= 0x40 && c <= 0x7e) { const b = this.csiBuf; this.csiBuf = ''; this.mode = 0; this._dispatch(String.fromCharCode(c), b); return; }
      if (c < 0x20) { this._ctl(c); return; }                                         // controls inside a sequence still act
      if (this.csiBuf.length < 64) this.csiBuf += String.fromCharCode(c);
    }

    _dispatch(f, buf) {
      const priv = /^[?<=>]/.test(buf) ? buf[0] : '';
      const body = priv ? buf.slice(1) : buf;
      if (/[ -/]/.test(body.replace(/[0-9;:]/g, ''))) return;                         // intermediates (cursor shape, soft reset...): ignored
      const p = body.split(/[;:]/).map((s) => (s === '' ? 0 : parseInt(s, 10) || 0));
      const n = (d = 1) => (p[0] > 0 ? p[0] : d);
      if (priv === '?' ) { if (f === 'h' || f === 'l') for (const m of p) this._mode(m, f === 'h'); return; }
      if (priv) return;
      switch (f) {
        case 'A': this.y = Math.max(this.y - n(), this.y >= this.top ? this.top : 0); this.pending = false; break;
        case 'B': this.y = Math.min(this.y + n(), this.y <= this.bottom ? this.bottom : this.rows - 1); this.pending = false; break;
        case 'C': this.x = Math.min(this.x + n(), this.cols - 1); this.pending = false; break;
        case 'D': this.x = Math.max(this.x - n(), 0); this.pending = false; break;
        case 'E': this.y = Math.min(this.y + n(), this.rows - 1); this.x = 0; this.pending = false; break;
        case 'F': this.y = Math.max(this.y - n(), 0); this.x = 0; this.pending = false; break;
        case 'G': case '`': this.x = clamp(n() - 1, 0, this.cols - 1); this.pending = false; break;
        case 'd': this.y = clamp(n() - 1, 0, this.rows - 1); this.pending = false; break;
        case 'H': case 'f': this.y = clamp(n() - 1, 0, this.rows - 1); this.x = clamp((p[1] > 0 ? p[1] : 1) - 1, 0, this.cols - 1); this.pending = false; break;
        case 'I': this._tab(n()); break;
        case 'Z': this._tab(-n()); break;
        case 'J': this._eraseDisplay(p[0] || 0); break;
        case 'K': this._eraseLine(p[0] || 0); break;
        case 'L': this._insLines(n()); break;
        case 'M': this._delLines(n()); break;
        case 'P': this._delChars(n()); break;
        case '@': this._insChars(n()); break;
        case 'X': { const l = this.lines[this.y], e = this.eraseId(); for (let i = this.x; i < Math.min(this.cols, this.x + n()); i++) { l.ch[i] = ' '; l.st[i] = e; } this._touch(l); break; }
        case 'S': for (let i = 0; i < n(); i++) this._scrollUp(); break;
        case 'T': for (let i = 0; i < n(); i++) this._scrollDown(); break;
        case 'r': { const t = clamp(n() - 1, 0, this.rows - 1), b = clamp((p[1] > 0 ? p[1] : this.rows) - 1, 0, this.rows - 1); if (t < b) { this.top = t; this.bottom = b; } this.x = 0; this.y = 0; this.pending = false; break; }
        case 's': this.saved = this._save(); break;
        case 'u': if (this.saved) this._restore(this.saved); break;
        case 'm': this._sgr(p); break;
        case 'g': if (p[0] === 3) this.tabs = new Set(); else if (p[0] === 0) { this._tabset(); this.tabs.delete(this.x); } break;
        default: break;                                                               // n (reports), c (attributes), t (window ops): never answered
      }
    }
    _mode(m, on) {
      switch (m) {
        case 1: this.appCursor = on; break;
        case 7: this.autowrap = on; break;
        case 25: this.showCursor = on; break;
        case 2004: this.bracketed = on; break;
        case 47: case 1047: this._altScreen(on, false); break;
        case 1049: this._altScreen(on, true); break;
        default: break;
      }
    }
    _altScreen(on, saveCursor) {
      if (on === this.alt) return;
      if (on) {
        if (saveCursor) this.saved = this._save();
        this.mainSaved = { lines: this.lines, top: this.top, bottom: this.bottom };
        this.lines = []; for (let i = 0; i < this.rows; i++) this.lines.push(this._blank(0));
        this.alt = true; this.top = 0; this.bottom = this.rows - 1;
      } else {
        const m = this.mainSaved; this.alt = false;
        if (m) { this.lines = m.lines; this.top = 0; this.bottom = this.rows - 1; for (const l of this.lines) { while (l.ch.length < this.cols) { l.ch.push(' '); l.st.push(0); } l.ch.length = this.cols; l.st.length = this.cols; this._touch(l); } }
        while (this.lines.length < this.rows) this.lines.push(this._blank(0));
        this.lines.length = this.rows; this.mainSaved = null;
        if (saveCursor && this.saved) this._restore(this.saved);
      }
      this.pending = false; this.ver++;
    }
    _save() { return { x: this.x, y: this.y, cur: Object.assign({}, this.cur), pending: this.pending }; }
    _restore(s) { this.x = Math.min(s.x, this.cols - 1); this.y = Math.min(s.y, this.rows - 1); this.cur = Object.assign({}, s.cur); this.pending = s.pending; }

    _sgr(p) {
      const a = this.cur;
      for (let i = 0; i < p.length; i++) {
        const v = p[i];
        if (v === 0) Object.assign(a, DEFAULT);
        else if (v === 1) a.b = 1; else if (v === 2) a.d = 1; else if (v === 3) a.i = 1; else if (v === 4 || v === 21) a.u = 1;
        else if (v === 7) a.r = 1; else if (v === 9) a.s = 1;
        else if (v === 22) { a.b = 0; a.d = 0; } else if (v === 23) a.i = 0; else if (v === 24) a.u = 0; else if (v === 27) a.r = 0; else if (v === 29) a.s = 0;
        else if (v >= 30 && v <= 37) a.fg = v - 30; else if (v === 39) a.fg = -1;
        else if (v >= 40 && v <= 47) a.bg = v - 40; else if (v === 49) a.bg = -1;
        else if (v >= 90 && v <= 97) a.fg = v - 90 + 8; else if (v >= 100 && v <= 107) a.bg = v - 100 + 8;
        else if (v === 38 || v === 48) {
          let col = null;
          if (p[i + 1] === 5) { col = clamp(p[i + 2] | 0, 0, 255); i += 2; } else if (p[i + 1] === 2) {
            // 38;2;r;g;b (a colour-space slot after the 2 is tolerated: 38:2::r:g:b)
            let k = i + 2; if (p.length - k >= 4 && p[k] === 0) k++;
            col = '#' + hex2(clamp(p[k] | 0, 0, 255)) + hex2(clamp(p[k + 1] | 0, 0, 255)) + hex2(clamp(p[k + 2] | 0, 0, 255)); i = k + 2;
          } else i = p.length;
          if (col !== null) { if (v === 38) a.fg = col; else a.bg = col; }
        }
      }
    }

    // ---- cursor and text ----
    _print(cp) {
      const w = cw(cp), ch = String.fromCodePoint(cp);
      if (w === 0) { const l = this.lines[this.y]; const x = this.pending ? this.x : this.x - 1; if (x >= 0) { l.ch[x] += ch; this._touch(l); } return; }
      if (this.pending || this.x + w > this.cols) {
        if (this.autowrap) { this.x = 0; this._lf(); } else this.x = this.cols - w;
        this.pending = false;
      }
      const l = this.lines[this.y], id = this.curId();
      l.ch[this.x] = ch; l.st[this.x] = id;
      if (w === 2) { l.ch[this.x + 1] = ''; l.st[this.x + 1] = id; }
      this._touch(l);
      this.x += w;
      if (this.x >= this.cols) { this.x = this.cols - 1; this.pending = true; }
    }
    _push(l) { this.scrollback.push(l); if (this.scrollback.length > this.maxScroll) this.scrollback.splice(0, this.scrollback.length - this.maxScroll); }
    _lf() { this.pending = false; if (this.y === this.bottom) this._scrollUp(); else if (this.y < this.rows - 1) this.y++; }
    _ri() { this.pending = false; if (this.y === this.top) this._scrollDown(); else if (this.y > 0) this.y--; }
    _scrollUp() {
      const l = this.lines.splice(this.top, 1)[0];
      if (!this.alt && this.top === 0) this._push(l);
      this.lines.splice(this.bottom, 0, this._blank(this.eraseId()));
    }
    _scrollDown() { this.lines.splice(this.bottom, 1); this.lines.splice(this.top, 0, this._blank(this.eraseId())); }
    _insLines(n) { if (this.y < this.top || this.y > this.bottom) return; n = Math.min(n, this.bottom - this.y + 1); for (let i = 0; i < n; i++) { this.lines.splice(this.bottom, 1); this.lines.splice(this.y, 0, this._blank(this.eraseId())); } this.x = 0; this.pending = false; }
    _delLines(n) { if (this.y < this.top || this.y > this.bottom) return; n = Math.min(n, this.bottom - this.y + 1); for (let i = 0; i < n; i++) { this.lines.splice(this.y, 1); this.lines.splice(this.bottom, 0, this._blank(this.eraseId())); } this.x = 0; this.pending = false; }
    _insChars(n) { const l = this.lines[this.y]; n = Math.min(n, this.cols - this.x); const e = this.eraseId(); for (let i = 0; i < n; i++) { l.ch.splice(this.cols - 1, 1); l.st.splice(this.cols - 1, 1); l.ch.splice(this.x, 0, ' '); l.st.splice(this.x, 0, e); } this._touch(l); this.pending = false; }
    _delChars(n) { const l = this.lines[this.y]; n = Math.min(n, this.cols - this.x); const e = this.eraseId(); for (let i = 0; i < n; i++) { l.ch.splice(this.x, 1); l.st.splice(this.x, 1); l.ch.push(' '); l.st.push(e); } this._touch(l); this.pending = false; }
    _eraseLine(m) {
      const l = this.lines[this.y], e = this.eraseId();
      const a = m === 0 ? this.x : 0, b = m === 1 ? this.x + 1 : this.cols;
      for (let i = a; i < b; i++) { l.ch[i] = ' '; l.st[i] = e; }
      this._touch(l);
    }
    _eraseDisplay(m) {
      const e = this.eraseId();
      if (m === 3) { this.scrollback.length = 0; this.ver++; return; }
      const from = m === 0 ? this.y : 0, to = m === 1 ? this.y : this.rows - 1;
      for (let y = from; y <= to; y++) {
        const l = this.lines[y], a = y === this.y && m === 0 ? this.x : 0, b = y === this.y && m === 1 ? this.x + 1 : this.cols;
        for (let i = a; i < b; i++) { l.ch[i] = ' '; l.st[i] = e; }
        this._touch(l);
      }
    }
    _tabset() { if (!this.tabs) { this.tabs = new Set(); for (let i = 8; i < this.cols; i += 8) this.tabs.add(i); } }
    _tab(n) {
      this._tabset(); this.pending = false;
      for (; n > 0; n--) { let x = this.x + 1; while (x < this.cols - 1 && !this.tabs.has(x)) x++; this.x = Math.min(x, this.cols - 1); }
      for (; n < 0; n++) { let x = this.x - 1; while (x > 0 && !this.tabs.has(x)) x--; this.x = Math.max(x, 0); }
    }
  }

  // The 256-colour palette entry n as '#rrggbb' (0..15 are the theme colours, drawn from css, so this is only used for 16..255).
  function xterm256(n) {
    if (n >= 232) { const g = 8 + (n - 232) * 10; return '#' + hex2(g) + hex2(g) + hex2(g); }
    n -= 16; const lv = [0, 95, 135, 175, 215, 255];
    return '#' + hex2(lv[Math.floor(n / 36) % 6]) + hex2(lv[Math.floor(n / 6) % 6]) + hex2(lv[n % 6]);
  }

  return { Screen, cw, xterm256 };
});
