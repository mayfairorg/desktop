'use strict';
// Reads skins.css and mf-tokens.css the way the page cascades them, so tests can resolve every variable of every skin without a browser.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'src', 'ui', 'ghost');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const blocks = (css) => { const out = []; const src = css.replace(/\/\*[\s\S]*?\*\//g, ''); const re = /([^{}]+)\{([^{}]*)\}/g; let m; while ((m = re.exec(src))) { const decl = {}; for (const d of m[2].split(/;(?![^(]*\))/)) { const i = d.indexOf(':'); if (i > 0) decl[d.slice(0, i).trim()] = d.slice(i + 1).trim(); } out.push({ sels: m[1].split(',').map((s) => s.trim()), decl }); } return out; };
const TOK = blocks(read('mf-tokens.css')), SKIN = blocks(read('skins.css'));
const skinBlocks = (id) => SKIN.filter((b) => b.sels.some((s) => s.replace(/ body$/, '') === `[data-skin=${id}]`));
// What <html data-skin data-theme> computes: mf-tokens (dark, plus light on top for the light theme), then the skin's own blocks.
function resolveAll(id, theme) {
  const v = {}; const put = (b) => Object.assign(v, b.decl);
  const takes = (b, themeName) => b.sels.some((s) => { const t = s.replace(/ body$/, ''); return t === ':root' || t === '[data-theme]' || t === `[data-theme=${themeName}]`; });
  for (const b of TOK) if (takes(b, 'dark')) put(b);
  if (theme === 'light') for (const b of TOK) if (b.sels.some((s) => s.replace(/ body$/, '') === '[data-theme=light]')) put(b);
  for (const b of SKIN.filter((x) => x.sels.includes('[data-skin]'))) put(b);
  for (const b of skinBlocks(id)) put(b);
  return v;
}
const hex = (s) => { const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s); if (!m) return null; let h = m[1]; if (h.length === 3) h = h.split('').map((c) => c + c).join(''); return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }; };
function color(vars, expr, depth = 0) {
  expr = String(expr).trim(); if (depth > 12) throw new Error('loop at ' + expr);
  let m = /^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/.exec(expr);
  if (m) { if (m[1] in vars) return color(vars, vars[m[1]], depth + 1); if (m[2]) return color(vars, m[2], depth + 1); throw new Error('undefined ' + m[1]); }
  if (expr === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const h = hex(expr); if (h) return h;
  m = /^color-mix\(\s*in srgb\s*,(.*)\)$/.exec(expr);
  if (m) {
    const parts = []; let d = 0, cur = ''; for (const ch of m[1]) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += ch; } parts.push(cur);
    const one = (p) => { const x = /^(.*?)(?:\s+([\d.]+)%)?$/.exec(p.trim()); return { c: color(vars, x[1], depth + 1), p: x[2] === undefined ? null : Number(x[2]) }; };
    let [A, B] = [one(parts[0]), one(parts[1])]; if (A.p === null && B.p === null) { A.p = 50; B.p = 50; } else if (A.p === null) A.p = 100 - B.p; else if (B.p === null) B.p = 100 - A.p;
    const sum = A.p + B.p, a = A.p / sum, b = B.p / sum, al = A.c.a * a + B.c.a * b;
    const ch = (k) => (al === 0 ? 0 : (A.c[k] * A.c.a * a + B.c[k] * B.c.a * b) / al);
    return { r: ch('r'), g: ch('g'), b: ch('b'), a: al * (sum < 100 ? sum / 100 : 1) };
  }
  throw new Error('cannot read colour: ' + expr);
}
const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
const ratio = (fg, bg) => { const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
module.exports = { read, blocks, TOK, SKIN, skinBlocks, resolveAll, color, over, ratio };
