// Ghost terminal: key presses to the bytes a terminal sends. Pure, so it can be tested without a display.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GhostKeys = factory(); })(this, function () {
  'use strict';
  const CSI = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
  const TILDE = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 };
  const FN = { F1: 'P', F2: 'Q', F3: 'R', F4: 'S' }, FNT = { F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
  // e: {key, ctrlKey, altKey, shiftKey, metaKey}; opts.appCursor. Returns a string to send, or null (not a terminal key: let the browser handle it).
  function encode(e, opts) {
    const o = opts || {};
    const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
    const k = e.key;
    if (e.metaKey) return null;
    if (CSI[k]) return mod > 1 ? '\x1b[1;' + mod + CSI[k] : (o.appCursor && 'ABCD'.includes(CSI[k]) ? '\x1bO' : '\x1b[') + CSI[k];
    if (TILDE[k]) return '\x1b[' + TILDE[k] + (mod > 1 ? ';' + mod : '') + '~';
    if (FN[k]) return mod > 1 ? '\x1b[1;' + mod + FN[k] : '\x1bO' + FN[k];
    if (FNT[k]) return '\x1b[' + FNT[k] + (mod > 1 ? ';' + mod : '') + '~';
    if (k === 'Enter') return e.altKey ? '\x1b\r' : '\r';
    if (k === 'Backspace') return e.altKey ? '\x1b\x7f' : (e.ctrlKey ? '\x08' : '\x7f');
    if (k === 'Tab') return e.shiftKey ? '\x1b[Z' : '\t';
    if (k === 'Escape') return '\x1b';
    if (k && k.length === 1 || (k && [...k].length === 1)) {
      if (e.ctrlKey && !e.altKey) {
        const c = k.toLowerCase();
        if (c >= 'a' && c <= 'z') return String.fromCharCode(c.charCodeAt(0) - 96);
        const map = { '@': 0, ' ': 0, '[': 27, '\\': 28, ']': 29, '^': 30, '_': 31, '?': 127, '2': 0, '3': 27, '4': 28, '5': 29, '6': 30, '7': 31, '8': 127 };
        return Object.prototype.hasOwnProperty.call(map, c) ? String.fromCharCode(map[c]) : null;
      }
      if (e.ctrlKey) return null;
      return e.altKey ? '\x1b' + k : k;
    }
    return null;
  }
  return { encode };
});
