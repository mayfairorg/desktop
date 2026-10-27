// Ghost terminal: line editing for "basic" mode (no real terminal behind the shell). The shell cannot echo or edit, so the window does:
// the person edits a line locally and the whole line is sent when they press Enter. Pure state machine, tested without a display.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GhostLine = factory(); })(this, function () {
  'use strict';
  class LineEditor {
    constructor() { this.buf = ''; this.pos = 0; this.hist = []; this.hi = -1; this.draft = ''; }
    // key: {key, ctrlKey, altKey, metaKey} or {text}. Returns {send?: string, interrupt?: bool, eof?: bool, clear?: bool, redraw: bool}.
    feed(e) {
      const r = { redraw: false };
      if (typeof e.text === 'string') { for (const ch of e.text.replace(/\r\n?/g, '\n')) { if (ch === '\n') { const s = this._enter(); r.send = (r.send || '') + s; } else if (ch >= ' ') this._ins(ch); } r.redraw = true; return r; }
      const k = e.key;
      if (e.ctrlKey && !e.altKey) {
        const c = (k || '').toLowerCase();
        if (c === 'c') { this.buf = ''; this.pos = 0; this.hi = -1; r.interrupt = true; r.redraw = true; return r; }
        if (c === 'd') { if (this.buf === '') r.eof = true; else this._del(); r.redraw = true; return r; }
        if (c === 'l') { r.clear = true; r.redraw = true; return r; }
        if (c === 'u') { this.buf = this.buf.slice(this.pos); this.pos = 0; r.redraw = true; return r; }
        if (c === 'a') { this.pos = 0; r.redraw = true; return r; }
        if (c === 'e') { this.pos = this.buf.length; r.redraw = true; return r; }
        if (c === 'k') { this.buf = this.buf.slice(0, this.pos); r.redraw = true; return r; }
        if (c === 'w') { const a = this.buf.slice(0, this.pos).replace(/\S+\s*$/, ''); this.buf = a + this.buf.slice(this.pos); this.pos = a.length; r.redraw = true; return r; }
        return r;
      }
      if (e.metaKey) return r;
      switch (k) {
        case 'Enter': r.send = this._enter(); r.redraw = true; break;
        case 'Backspace': if (this.pos > 0) { this.buf = this.buf.slice(0, this.pos - 1) + this.buf.slice(this.pos); this.pos--; } r.redraw = true; break;
        case 'Delete': this._del(); r.redraw = true; break;
        case 'ArrowLeft': if (this.pos > 0) this.pos--; r.redraw = true; break;
        case 'ArrowRight': if (this.pos < this.buf.length) this.pos++; r.redraw = true; break;
        case 'Home': this.pos = 0; r.redraw = true; break;
        case 'End': this.pos = this.buf.length; r.redraw = true; break;
        case 'ArrowUp': this._hist(-1); r.redraw = true; break;
        case 'ArrowDown': this._hist(1); r.redraw = true; break;
        default: if (k && [...k].length === 1) { this._ins(k); r.redraw = true; }
      }
      return r;
    }
    _ins(ch) { this.buf = this.buf.slice(0, this.pos) + ch + this.buf.slice(this.pos); this.pos += ch.length; }
    _del() { this.buf = this.buf.slice(0, this.pos) + this.buf.slice(this.pos + 1); }
    _enter() {
      const line = this.buf;
      if (line.trim() && this.hist[this.hist.length - 1] !== line) { this.hist.push(line); if (this.hist.length > 200) this.hist.shift(); }
      this.buf = ''; this.pos = 0; this.hi = -1;
      return line + '\n';
    }
    _hist(d) {
      if (!this.hist.length) return;
      if (this.hi === -1) { if (d > 0) return; this.draft = this.buf; this.hi = this.hist.length; }
      this.hi = Math.min(this.hist.length, Math.max(0, this.hi + d));
      this.buf = this.hi === this.hist.length ? this.draft : this.hist[this.hi]; this.pos = this.buf.length;
      if (this.hi === this.hist.length) this.hi = -1;
    }
  }
  return { LineEditor };
});
