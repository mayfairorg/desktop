'use strict';
// Sigma rule matcher (Mayfair's own implementation, no Sigma tooling bundled). Evaluates Sigma detection rules against JSON-lines events
// that you pick. Entirely local; nothing is sent anywhere.
//
// Rules keep their own licence. Most community Sigma rules are under the Detection Rule License (DRL) 1.1, https://github.com/SigmaHQ/sigma
// which requires the rule author to stay identified: every match carries the rule's author and licence fields in raw.
//
// Supported: field modifiers contains, startswith, endswith, all, re, cased, exists, cidr (IPv4), lt, lte, gt, gte; wildcards * and ?;
// keyword lists; lists of maps (OR); conditions with and, or, not, parentheses, "1 of X*", "all of X*", "1 of them", "all of them".
// NOT supported (the rule is reported as skipped, never guessed): aggregation/timeframe, correlation rules, base64*, utf16*, wide,
// windash, expand, fieldref, YAML anchors, collections ("action: global"). The rule's logsource is NOT checked.
const common = require('./common');
const SPEC = { id: 'sigma-match', tool: 'mayfair-sigma-matcher', version: '1.0.0', scope: 'local' };
const MAX_RULES = 300, MAX_EVENTS = 100000, MAX_MATCHES = 1000;

class Unsupported extends Error {}

// ---------- a YAML reader for the subset Sigma rules use ----------
function stripComment(r) {
  let q = null;
  for (let i = 0; i < r.length; i++) {
    const c = r[i];
    if (q) { if (c === q) { if (q === "'" && r[i + 1] === "'") i++; else q = null; } else if (q === '"' && c === '\\') i++; }
    else if (c === '"' || c === "'") { if (i === 0 || /[\s\[{,:-]/.test(r[i - 1])) q = c; }
    else if (c === '#' && (i === 0 || /\s/.test(r[i - 1]))) return r.slice(0, i);
  }
  return r;
}
function splitKey(s) {
  let i = 0, key;
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0]; i = 1;
    while (i < s.length && !(s[i] === q && !(q === "'" && s[i + 1] === "'"))) { if (q === "'" && s[i] === "'" && s[i + 1] === "'") i++; else if (q === '"' && s[i] === '\\') i++; i++; }
    if (s[i] !== q) return null;
    const after = s.slice(i + 1);
    const m = /^\s*:(?:\s+(.*))?$/.exec(after);
    if (!m) return null;
    return { key: unquote(s.slice(0, i + 1)), rest: (m[1] || '').trim() };
  }
  if (s[0] === '[' || s[0] === '{') return null;
  const m = /^([^\s:#'"][^:]*?)\s*:(?:\s+(.*))?$/.exec(s);
  if (!m || /^-(\s|$)/.test(s)) return null;
  key = m[1];
  return { key, rest: (m[2] || '').trim() };
}
function unquote(s) {
  if (s[0] === "'" && s[s.length - 1] === "'" && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s[0] === '"' && s[s.length - 1] === '"' && s.length >= 2) return s.slice(1, -1).replace(/\\(["\\\/nrt0]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g, (m, e) => ({ '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', 0: '\0' }[e] ?? String.fromCharCode(parseInt(e.slice(1), 16))));
  return s;
}
function splitFlow(s) {
  const out = []; let q = null, depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q) { if (q === "'" && s[i + 1] === "'") { cur += s[++i]; } else q = null; } else if (q === '"' && c === '\\') cur += s[++i] || ''; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function scalar(s) {
  s = s.trim();
  if (s === '' || s === '~' || /^null$/i.test(s)) return null;
  if (s[0] === '[' && s[s.length - 1] === ']') return splitFlow(s.slice(1, -1)).map(scalar);
  if (s === '{}') return Object.create(null);
  if (s[0] === '{' || s[0] === '&' || s[0] === '*' || s[0] === '!') throw new Unsupported('YAML feature (anchor, alias, tag or flow map) is not supported');
  if (s[0] === '"' || s[0] === "'") return unquote(s);
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function parseYaml(text) {
  const L = text.replace(/\r\n?/g, '\n').split('\n').map((raw) => {
    if (/^\t| \t/.test(raw.match(/^\s*/)[0])) throw new Unsupported('tab used for indentation');
    return { raw, indent: raw.match(/^ */)[0].length, text: stripComment(raw).trim() };
  });
  const n = L.length;
  const skip = (i) => { while (i < n && L[i].text === '') i++; return i; };
  const isSeq = (l) => l.text === '-' || l.text.startsWith('- ');
  function block(i, indent, depth) {
    if (depth > 30) throw new Unsupported('YAML nested too deeply');
    return isSeq(L[i]) ? seq(i, indent, depth) : map(i, indent, depth);
  }
  function seq(i, indent, depth) {
    const arr = [];
    while (true) {
      i = skip(i);
      if (i >= n || L[i].indent !== indent || !isSeq(L[i])) break;
      const rest = L[i].text.slice(1).trim();
      if (rest === '') {
        const j = skip(i + 1);
        if (j < n && L[j].indent > indent) { const [v, k] = block(j, L[j].indent, depth + 1); arr.push(v); i = k; } else { arr.push(null); i++; }
      } else if (splitKey(rest)) {
        const off = L[i].raw.indexOf(rest, indent + 1);
        L[i] = { raw: L[i].raw, indent: off, text: rest };
        const [v, k] = map(i, off, depth + 1); arr.push(v); i = k;
      } else { arr.push(scalar(rest)); i++; }
    }
    return [arr, i];
  }
  function map(i, indent, depth) {
    const obj = Object.create(null);
    while (true) {
      i = skip(i);
      if (i >= n || L[i].indent < indent) break;
      if (L[i].indent > indent) throw new Unsupported('inconsistent indentation');
      if (isSeq(L[i])) break;
      const kv = splitKey(L[i].text);
      if (!kv) throw new Unsupported('line is not "key: value"');
      let v;
      if (kv.rest === '') {
        const j = skip(i + 1);
        if (j < n && L[j].indent > indent) { [v, i] = block(j, L[j].indent, depth + 1); }
        else if (j < n && L[j].indent === indent && isSeq(L[j])) { [v, i] = seq(j, indent, depth + 1); }
        else { v = null; i++; }
      } else if (/^[|>][+-]?$/.test(kv.rest)) {
        let j = i + 1; const buf = []; let bi = -1;
        while (j < n && (L[j].raw.trim() === '' || L[j].indent > indent)) { if (bi < 0 && L[j].raw.trim() !== '') bi = L[j].indent; buf.push(bi >= 0 ? L[j].raw.slice(bi) : ''); j++; }
        while (buf.length && buf[buf.length - 1] === '') buf.pop();
        v = kv.rest[0] === '|' ? buf.join('\n') : buf.join(' ').replace(/\s+/g, ' ');
        i = j;
      } else { v = scalar(kv.rest); i++; }
      obj[kv.key] = v;
    }
    return [obj, i];
  }
  const s0 = skip(0);
  if (s0 >= n) return null;
  const [v, end] = block(s0, L[s0].indent, 0);
  if (skip(end) < n) throw new Unsupported('unexpected content after the document');
  return v;
}
function parseYamlDocs(text) {
  if (text.length > 4 * 1024 * 1024) throw new Unsupported('rules file is larger than 4 MiB');
  const parts = text.split(/^(?:---|\.\.\.)[ \t]*$/m);
  const docs = [];
  for (const p of parts) { if (!p.trim()) continue; try { docs.push({ doc: parseYaml(p) }); } catch (e) { docs.push({ error: e instanceof Unsupported ? e.message : 'could not read this YAML document' }); } }
  return docs;
}

// ---------- matching ----------
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function getField(ev, f) {
  if (Object.prototype.hasOwnProperty.call(ev, f)) return ev[f];
  if (!f.includes('.')) return undefined;
  let cur = ev;
  for (const p of f.split('.')) { if (!isMap(cur) || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined; cur = cur[p]; }
  return cur;
}
function globRegex(pat, mode, cased) {
  let r = '';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\' && (pat[i + 1] === '*' || pat[i + 1] === '?' || pat[i + 1] === '\\')) { r += '\\' + pat[++i]; continue; }
    if (c === '*') r += '[\\s\\S]*'; else if (c === '?') r += '[\\s\\S]'; else r += c.replace(/[.+^${}()|[\]\\\/-]/g, '\\$&');
  }
  const body = mode === 'contains' ? r : mode === 'startswith' ? '^' + r : mode === 'endswith' ? r + '$' : '^' + r + '$';
  return new RegExp(body, cased ? '' : 'i');
}
function ipv4Int(s) { const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s); if (!m) return null; const p = m.slice(1).map(Number); if (p.some((x) => x > 255)) return null; return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]; }
const KNOWN_MODS = new Set(['contains', 'startswith', 'endswith', 'all', 're', 'cased', 'exists', 'cidr', 'lt', 'lte', 'gt', 'gte', 'i', 'm', 's']);
function valuePredicate(mods, v) {
  const cased = mods.includes('cased');
  if (v === null) return (x) => x === undefined || x === null || x === '';
  if (mods.includes('re')) {
    const pat = String(v);
    if (pat.length > 200) throw new Unsupported('regular expression longer than 200 characters');
    let flags = cased ? '' : 'i'; if (mods.includes('m')) flags += 'm'; if (mods.includes('s')) flags += 's';
    let re; try { re = new RegExp(pat, flags); } catch { throw new Unsupported('invalid regular expression'); }
    return (x) => x !== undefined && x !== null && re.test(String(x));
  }
  if (mods.includes('cidr')) {
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(v));
    const base = m && ipv4Int(m[1]); if (!m || base === null || Number(m[2]) > 32) throw new Unsupported('only IPv4 CIDR values are supported');
    const bits = Number(m[2]); const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (x) => { const a = ipv4Int(String(x)); return a !== null && ((a & mask) >>> 0) === ((base & mask) >>> 0); };
  }
  for (const [mod, f] of [['lt', (a, b) => a < b], ['lte', (a, b) => a <= b], ['gt', (a, b) => a > b], ['gte', (a, b) => a >= b]]) {
    if (mods.includes(mod)) { const b = Number(v); if (!Number.isFinite(b)) throw new Unsupported(`${mod} needs a number`); return (x) => { const a = Number(x); return Number.isFinite(a) && f(a, b); }; }
  }
  const mode = mods.includes('contains') ? 'contains' : mods.includes('startswith') ? 'startswith' : mods.includes('endswith') ? 'endswith' : 'exact';
  if (typeof v === 'boolean') return (x) => x === v || String(x).toLowerCase() === String(v);
  const pat = String(v);
  if (!/[*?\\]/.test(pat)) {
    const p = cased ? pat : pat.toLowerCase();
    const norm = (x) => (cased ? String(x) : String(x).toLowerCase());
    if (mode === 'contains') return (x) => x !== undefined && x !== null && norm(x).includes(p);
    if (mode === 'startswith') return (x) => x !== undefined && x !== null && norm(x).startsWith(p);
    if (mode === 'endswith') return (x) => x !== undefined && x !== null && norm(x).endsWith(p);
    return (x) => x !== undefined && x !== null && norm(x) === p;
  }
  const re = globRegex(pat, mode, cased);
  return (x) => x !== undefined && x !== null && re.test(String(x));
}
function leaves(v, out = [], depth = 0) {
  if (depth > 6) return out;
  if (Array.isArray(v)) v.forEach((x) => leaves(x, out, depth + 1));
  else if (isMap(v)) Object.values(v).forEach((x) => leaves(x, out, depth + 1));
  else if (v !== null && v !== undefined) out.push(v);
  return out;
}
function compileMap(m) {
  const tests = [];
  for (const [k, raw] of Object.entries(m)) {
    const [field, ...mods] = k.split('|');
    for (const mod of mods) if (!KNOWN_MODS.has(mod)) throw new Unsupported(`modifier "${mod}" is not supported`);
    if (!field) throw new Unsupported('a rule key has no field name');
    if (mods.includes('exists')) { const want = raw === true || /^true$/i.test(String(raw)); tests.push((ev) => (getField(ev, field) !== undefined) === want); continue; }
    const vals = Array.isArray(raw) ? raw : [raw];
    if (!vals.length) throw new Unsupported('empty value list');
    const preds = vals.map((v) => { if (isMap(v) || Array.isArray(v)) throw new Unsupported('nested value'); return valuePredicate(mods, v); });
    const all = mods.includes('all');
    tests.push((ev) => {
      const fv = getField(ev, field);
      const cands = Array.isArray(fv) ? (fv.length ? fv : [undefined]) : [fv];
      const one = (p) => cands.some((c) => p(c));
      return all ? preds.every(one) : preds.some(one);
    });
  }
  return (ev) => tests.every((t) => t(ev));
}
function compileSelection(v) {
  if (isMap(v)) return compileMap(v);
  const list = Array.isArray(v) ? v : [v];
  if (list.length && list.every(isMap)) { const fs = list.map(compileMap); return (ev) => fs.some((f) => f(ev)); }
  if (list.some((x) => isMap(x) || Array.isArray(x))) throw new Unsupported('mixed selection list');
  const preds = list.map((x) => valuePredicate(['contains'], x === null ? '' : x));
  return (ev) => { const ls = leaves(ev); return preds.some((p) => ls.some((l) => p(l))); };
}
function compileCondition(cond, sels) {
  const toks = [];
  for (const m of cond.matchAll(/\(|\)|[^\s()]+/g)) toks.push(m[0]);
  let p = 0;
  const peek = () => toks[p], lower = (t) => (t === undefined ? t : t.toLowerCase());
  const names = Object.keys(sels);
  const group = (pat) => { const re = new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); return names.filter((x) => re.test(x)); };
  function orE() { let a = andE(); while (lower(peek()) === 'or') { p++; const b = andE(); const x = a; a = (ev) => x(ev) || b(ev); } return a; }
  function andE() { let a = notE(); while (lower(peek()) === 'and') { p++; const b = notE(); const x = a; a = (ev) => x(ev) && b(ev); } return a; }
  function notE() { if (lower(peek()) === 'not') { p++; const f = notE(); return (ev) => !f(ev); } return atom(); }
  function atom() {
    const t = peek();
    if (t === undefined) throw new Unsupported('condition ends unexpectedly');
    if (t === '(') { p++; const f = orE(); if (peek() !== ')') throw new Unsupported('condition has an unclosed parenthesis'); p++; return f; }
    if ((t === '1' || lower(t) === 'all') && lower(toks[p + 1]) === 'of') {
      const q = lower(t) === 'all' ? 'all' : 'one'; p += 2;
      const target = peek(); if (target === undefined) throw new Unsupported('"of" needs a target'); p++;
      const members = lower(target) === 'them' ? names : group(target);
      if (!members.length) throw new Unsupported(`no selection matches "${target}"`);
      return q === 'all' ? (ev) => members.every((n) => sels[n](ev)) : (ev) => members.some((n) => sels[n](ev));
    }
    if (t === ')' || ['and', 'or', 'of'].includes(lower(t))) throw new Unsupported('condition is malformed');
    p++;
    if (!sels[t]) throw new Unsupported(`condition refers to "${t}", which is not defined`);
    return sels[t];
  }
  const f = orE();
  if (p !== toks.length) throw new Unsupported('condition is malformed');
  return f;
}
function compileRule(doc) {
  if (!isMap(doc)) throw new Unsupported('not a rule');
  if (doc.action !== undefined || doc.correlation !== undefined) throw new Unsupported('collections and correlation rules are not supported');
  const det = doc.detection;
  if (!isMap(det)) throw new Unsupported('rule has no detection section');
  if (det.timeframe !== undefined) throw new Unsupported('timeframe (aggregation over time) is not supported');
  const condRaw = det.condition;
  const conds = Array.isArray(condRaw) ? condRaw : [condRaw];
  if (!conds.length || conds.some((c) => typeof c !== 'string')) throw new Unsupported('rule has no condition');
  if (conds.some((c) => c.includes('|'))) throw new Unsupported('aggregation conditions (count, near, ...) are not supported');
  const sels = Object.create(null);
  for (const [k, v] of Object.entries(det)) if (k !== 'condition') sels[k] = compileSelection(v);
  const fs = conds.map((c) => compileCondition(c, sels));
  return (ev) => fs.some((f) => f(ev));
}

// ---------- the job ----------
const TS_FIELDS = ['@timestamp', 'timestamp', 'UtcTime', 'EventTime', 'TimeCreated', 'time', 'ts'];
function eventTime(ev, now) {
  for (const f of TS_FIELDS) { const t = common.isoTs(getField(ev, f)); if (t && Date.parse(t) <= now + 3600e3) return t; }
  return undefined;
}
const text = (v, n) => (v === undefined || v === null ? '' : String(v)).slice(0, n);
const asList = (v) => (Array.isArray(v) ? v.map((x) => text(x, 120)) : v ? [text(v, 120)] : []);
// raw: {rules: text of the rules file, logs: JSON-lines text}
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
  const out = []; const rules = []; let skipped = 0;
  for (const d of parseYamlDocs(String(raw.rules || ''))) {
    if (rules.length + skipped >= MAX_RULES) { out.push(mk('output-truncated', `only the first ${MAX_RULES} rules were loaded`, { confidence: 'uncertain', note: 'A single run evaluates at most 300 rules.' })); break; }
    const title = d.doc && isMap(d.doc) ? text(d.doc.title, 120) || '(untitled rule)' : '(unreadable rule)';
    try {
      if (d.error) throw new Unsupported(d.error);
      rules.push({ title, test: compileRule(d.doc), doc: d.doc });
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      skipped++;
      if (skipped <= 50) out.push(mk('sigma-rule-skipped', `${title}: ${e.message}`, { confidence: 'uncertain', note: 'This rule was not evaluated, so its absence from the matches says nothing about your events.' }));
    }
  }
  let events = 0, badLines = 0, matches = 0, stopped = false;
  const lines = String(raw.logs || '').split(/\r?\n/);
  for (let ln = 0; ln < lines.length && !stopped; ln++) {
    const l = lines[ln];
    if (!l.trim()) continue;
    if (events >= MAX_EVENTS) { out.push(mk('output-truncated', `only the first ${MAX_EVENTS} events were read`, { confidence: 'uncertain', note: 'A single run reads at most 100000 events.' })); break; }
    let ev; try { ev = JSON.parse(l); } catch { badLines++; continue; }
    if (!isMap(ev)) { badLines++; continue; }
    events++;
    for (const r of rules) {
      let hit = false;
      try { hit = r.test(ev); } catch { hit = false; }
      if (!hit) continue;
      if (++matches > MAX_MATCHES) { stopped = true; out.push(mk('output-truncated', `stopped after ${MAX_MATCHES} matches`, { confidence: 'uncertain', note: 'Further events were not evaluated; narrow the rules or the log file.' })); break; }
      const d = r.doc;
      const status = text(d.status, 20).toLowerCase();
      const weak = ['experimental', 'test', 'unsupported', 'deprecated'].includes(status);
      const fp = asList(d.falsepositives).filter(Boolean);
      const noteBase = `Rule logic matched event ${ln + 1}; the logsource is not checked, so confirm the rule fits this log type.${fp.length ? ' Known false positives: ' + fp.slice(0, 3).join('; ') + '.' : ''}`;
      const fields = {}; let k = 0; for (const [fk, fv] of Object.entries(ev)) { if (k++ >= 10) break; fields[fk] = typeof fv === 'object' ? '[object]' : text(fv, 120); }
      out.push(mk('sigma-match', `${r.title} (event ${ln + 1})`, {
        observedAt: eventTime(ev, nowMs),
        confidence: weak ? 'uncertain' : 'likely',
        note: (weak ? `Rule status is "${status}", so it is not a mature detection. ` : '') + noteBase,
        raw: { ruleId: text(d.id, 80) || undefined, level: text(d.level, 20) || undefined, status: status || undefined, tags: asList(d.tags).slice(0, 8), author: text(d.author, 200) || undefined, license: text(d.license, 80) || undefined, event: ln + 1, fields },
      }));
    }
  }
  const w = common.skipNote(mk, badLines, 'log lines'); if (w) out.push(w);
  out.push(mk('sigma-summary', `${rules.length} rules evaluated, ${skipped} skipped, ${events} events read, ${Math.min(matches, MAX_MATCHES)} matches`));
  return out;
}

const SELFTEST_RULES = [
  'title: Mayfair self-test', 'id: 00000000-0000-4000-8000-000000000001', 'status: stable', 'level: low', 'author: Mayfair',
  'detection:', '  selection:', "    Image|endswith: '\\mfselftest.exe'", '    CommandLine|contains|all:', '      - alpha', '      - beta',
  '  filter:', '    User: nobody', '  condition: selection and not filter', '',
].join('\n');
const SELFTEST_LOGS = [
  { Image: 'C:\\Tools\\MFSELFTEST.EXE', CommandLine: 'x alpha BETA', User: 'alice' },
  { Image: 'C:\\Tools\\mfselftest.exe', CommandLine: 'x alpha beta', User: 'nobody' },
  { Image: 'C:\\Tools\\mfselftest.exe', CommandLine: 'x alpha only', User: 'alice' },
  { Image: 'C:\\Tools\\other.exe', CommandLine: 'alpha beta', User: 'alice' },
].map((e) => JSON.stringify(e)).join('\n');
function selfTest() {
  const res = parse({ rules: SELFTEST_RULES, logs: SELFTEST_LOGS }, {});
  const m = res.filter((r) => r.entity.type === 'sigma-match');
  if (m.length !== 1 || m[0].raw.event !== 1) throw new common.ToolError('the built-in Sigma test did not behave as expected (' + m.length + ' matches)', 3);
  return res;
}
module.exports = { SPEC, parse, selfTest, parseYaml, parseYamlDocs, compileRule, Unsupported, SELFTEST_RULES, SELFTEST_LOGS };
