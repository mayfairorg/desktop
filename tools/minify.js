#!/usr/bin/env node
// Shrinks a JavaScript file: comments and whitespace are removed, and (esbuild engine) code is shortened without changing what it does.  Never writes a source map.
//   node tools/minify.js [--engine=auto|esbuild|strip] [--verify] < in.js > out.js        (reads stdin, writes stdout, a one line report goes to stderr)
// Engines:
//   esbuild  the esbuild package, found offline (MF_ESBUILD, ./node_modules, /opt/npm-tools/node_modules).  Whitespace, syntax and local-name shortening.
//            esbuild leaves every name alone in a scope that contains `with` or a direct `eval`, which is what the app chunks need
//            (they run inside with(scope), see src/s01z_lazy.js, and read the shell's names by their written name).
//   strip    pure acorn: removes comments and collapses whitespace, nothing else (no renaming).  Used when esbuild is not installed (npm may be blocked).
// --verify  parses the input and the output with acorn and compares the syntax trees (strip engine: they must be identical apart from positions).
const path = require('path'), fs = require('fs');
const acorn = (() => { for (const p of [process.env.MF_ACORN, path.join(__dirname, '..', 'node_modules', 'acorn'), '/opt/node-tools/node_modules/acorn', '/opt/npm-tools/node_modules/acorn', 'acorn']) { if (!p) continue; try { return require(p); } catch (e) {} } return null; })();
const loadEsbuild = () => { for (const p of [process.env.MF_ESBUILD, path.join(__dirname, '..', 'node_modules', 'esbuild'), '/opt/npm-tools/node_modules/esbuild', 'esbuild']) { if (!p) continue; try { return require(p); } catch (e) {} } return null; };
const OPTS = { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true };

const NLRE = new RegExp('[\\n\\r' + String.fromCharCode(0x2028, 0x2029) + ']');
const WORD = /[A-Za-z0-9_$\u0080-￿\\]/;
// a token after which a line break never matters (it cannot end a statement)
const FREE_AFTER = new Set([';', '{', ',', '(', '[', ':', '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=', '&&', '||', '??', '|', '^', '&', '==', '!=', '===', '!==', '<', '>', '<=', '>=', '<<', '>>', '>>>', '+', '-', '*', '/', '%', '**', '?', '=>', '!', '~', '...', '.', '?.']);
const FREE_BEFORE = new Set([')', ']', '}', ';', ',', '.', '?.', ':', '?', '=', '*', '%', '**', '&&', '||', '??', '|', '^', '&', '==', '!=', '===', '!==', '<', '>', '<=', '>=', '<<', '>>', '>>>', '=>']);   // never start a new statement, so a break before them is never what ends the one before

function strip(code) {
  if (!acorn) throw new Error('acorn is not installed (looked in MF_ACORN, node_modules, /opt/node-tools)');
  const toks = [];
  acorn.parse(code, { ...OPTS, onToken: (t) => { if (t.type.label !== 'eof' && t.end > t.start) toks.push({ s: t.start, e: t.end, label: t.type.label, num: t.type.label === 'num' }); } });
  const out = []; let prev = null;
  for (const t of toks) {
    const text = code.slice(t.s, t.e);
    if (prev) {
      const gap = code.slice(prev.e, t.s), nl = NLRE.test(gap);
      const a = prev.text[prev.text.length - 1], b = text[0];
      let sep = '';
      if (!gap.length) sep = '';          // nothing was between them (inside a template literal that is text), so add nothing
      else if (nl && !(FREE_AFTER.has(prev.text) && prev.label !== 'template') && !FREE_BEFORE.has(text)) sep = '\n';
      else if ((WORD.test(a) && WORD.test(b)) || (a === b && (a === '+' || a === '-')) || (a === '/' && (b === '/' || b === '*')) || (a === '<' && b === '!') || (a === '-' && b === '>' ) || (prev.num && b === '.') || (a === '.' && /[0-9]/.test(b) && prev.num)) sep = ' ';
      else if (gap.length && ((a === '/' && b === '/') )) sep = ' ';
      out.push(sep);
    }
    out.push(text); prev = { e: t.e, text, label: t.label, num: t.num };
  }
  return out.join('');
}

// the shape of a syntax tree without positions (the strip engine must not change it)
function shape(code) {
  const ast = acorn.parse(code, OPTS);
  return JSON.stringify(ast, (k, v) => (k === 'start' || k === 'end' || k === 'raw' ? undefined : (v instanceof RegExp ? String(v) : (typeof v === 'bigint' ? String(v) : v))));
}

function esb(code) {
  const E = loadEsbuild(); if (!E) return null;
  return E.transformSync(code, { minify: true, legalComments: 'none', target: ['chrome100', 'safari15', 'firefox100'], charset: 'utf8', sourcemap: false, logLevel: 'silent' }).code;
}

function minify(code, engine = 'auto', verify = false) {
  let out = null, used = engine;
  if (engine === 'auto' || engine === 'esbuild') { out = esb(code); used = 'esbuild'; if (out === null && engine === 'esbuild') throw new Error('esbuild not found'); }
  if (out === null) { out = strip(code); used = 'strip'; }
  if (verify) {
    if (!acorn) throw new Error('verify needs acorn');
    acorn.parse(out, OPTS);                                     // the output must parse
    if (used === 'strip' && shape(code) !== shape(out)) throw new Error('strip changed the syntax tree');
  }
  return { code: out.replace(/\n+$/, ''), engine: used };
}
// CSS: esbuild's CSS minifier; without esbuild only comments are removed (found by walking the text, so a comment-like piece inside a string or url() stays)
function stripCss(code) {
  let out = '', i = 0; const n = code.length;
  while (i < n) {
    const c = code[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < n && code[j] !== c) j += code[j] === '\\' ? 2 : 1; out += code.slice(i, j + 1); i = j + 1; }
    else if (c === '/' && code[i + 1] === '*') { const j = code.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; }
    else if (c === 'u' && code.startsWith('url(', i)) { const j = code.indexOf(')', i); const k = j < 0 ? n : j + 1; out += code.slice(i, k); i = k; }
    else { out += c; i++; }
  }
  return out.replace(/\n\s*\n+/g, '\n');
}
function minifyCss(code, engine = 'auto') {
  const E = engine === 'strip' ? null : loadEsbuild();
  if (E) return { code: E.transformSync(code, { loader: 'css', minify: true, legalComments: 'none', target: ['chrome100', 'safari15', 'firefox100'], logLevel: 'silent' }).code.trim(), engine: 'esbuild' };
  return { code: stripCss(code).trim(), engine: 'strip' };
}
module.exports = { minify, minifyCss, strip, shape };

if (require.main === module) {
  const args = process.argv.slice(2), eng = (args.find((a) => a.startsWith('--engine=')) || '--engine=auto').slice(9), verify = args.includes('--verify');
  let s = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => s += d).on('end', () => {
    const t0 = Date.now(), r = args.includes('--css') ? minifyCss(s, eng) : minify(s, eng, verify);
    process.stdout.write(r.code);
    process.stderr.write(`minify[${r.engine}${verify ? '+verify' : ''}]: ${s.length} -> ${r.code.length} bytes in ${Date.now() - t0} ms\n`);
  });
}
