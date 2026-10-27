// Ghost terminal: tiny DOM helper. Text is only ever set with textContent / text nodes, never as HTML.
(function (root) {
  'use strict';
  root.GhostDom = {
    h(tag, attrs, ...kids) {
      const el = document.createElement(tag);
      for (const k of Object.keys(attrs || {})) {
        const v = attrs[k];
        if (v === false || v === null || v === undefined) continue;
        if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'text') el.textContent = v; else el.setAttribute(k, v === true ? '' : String(v));
      }
      for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
      return el;
    },
    clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; },
  };
})(this);
