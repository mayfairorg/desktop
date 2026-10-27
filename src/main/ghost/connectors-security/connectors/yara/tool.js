'use strict';
// YARA (BSD-3-Clause): scan ONE file you picked with a rules file you picked. Local only, no network. Rules keep their own licences.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'yara', tool: 'yara', version: '1.0.0', scope: 'local', timeoutMs: 120000, versionArgs: ['--version'], versionRe: /^\s*v?(\d+\.\d+\.\d+)/m };

function normalizeInput(a) {
  for (const k of ['rules', 'file']) if (typeof a[k] !== 'string' || !path.isAbsolute(a[k])) throw new common.UsageError(`${k} must be a picked file`);
  return { rules: a.rules, file: a.file };
}
async function buildArgs(input) { return { argv: ['-w', '-s', '-m', '-a', '60', input.rules, input.file] }; }

function splitMeta(s) {                      // k=v,k2="quoted, with comma",k3=1
  const out = {}; let i = 0;
  while (i < s.length) {
    const eq = s.indexOf('=', i); if (eq < 0) break;
    const key = s.slice(i, eq).trim(); let v;
    if (s[eq + 1] === '"') { let j = eq + 2; v = ''; while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) j++; v += s[j++]; } i = j + 2; }
    else { const c = s.indexOf(',', eq); const end = c < 0 ? s.length : c; v = s.slice(eq + 1, end); i = end + 1; }
    if (/^[\w.-]{1,40}$/.test(key) && Object.keys(out).length < 12) out[key] = v.slice(0, 200);
  }
  return out;
}
// raw: stdout of `yara -s -m`:
//   rule_name [tag1,tag2] [author="x",description="y"] /path/to/file
//   0x10:$a: matched text
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const file = opts.input && opts.input.file;
  const out = []; let bad = 0; let cur = null;
  const flush = () => { if (cur) { out.push(mk('yara-match', cur.rule, { raw: { ...(cur.tags.length ? { tags: cur.tags } : {}), ...(Object.keys(cur.meta).length ? { meta: cur.meta } : {}), matchedStrings: cur.n, first: cur.first } })); cur = null; } };
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sm = /^0x([0-9a-fA-F]+):(\$[\w]*):\s?(.*)$/.exec(line);
    if (sm && cur) { cur.n++; if (cur.first.length < 5) cur.first.push({ offset: parseInt(sm[1], 16), id: sm[2], preview: sm[3].slice(0, 60) }); continue; }
    let head = null;
    if (file && line.endsWith(' ' + file)) head = line.slice(0, -(file.length + 1));
    else if (!file) { const m = /^(.*\S) (\/\S.*|[A-Za-z]:\\.*)$/.exec(line); if (m) head = m[1]; }
    const hm = head && /^([A-Za-z_]\w*)((?: \[[^\]]*\])*)$/.exec(head);
    if (!hm) { bad++; continue; }
    flush();
    cur = { rule: hm[1], tags: [], meta: {}, n: 0, first: [] };
    for (const g of hm[2].matchAll(/\[([^\]]*)\]/g)) { if (g[1].includes('=')) Object.assign(cur.meta, splitMeta(g[1])); else cur.tags.push(...g[1].split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10)); }
  }
  flush();
  if (!out.length && !bad) out.push(mk('yara-no-match', 'the file matched none of the rules', { confidence: 'uncertain', note: 'No match only means these rules did not fire on this file; it does not show the file is safe.' }));
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  return out;
}
// Real check of the installed program: compile a tiny rule and scan a tiny file that must match.
async function functionalSelfTest({ exe, launcher, runDir, mk, runTool }) {
  const rules = path.join(runDir, 'selftest.yar'), sample = path.join(runDir, 'selftest.bin');
  fs.writeFileSync(rules, 'rule mfselftest { strings: $a = "mayfair-selftest-marker" condition: $a }\n');
  fs.writeFileSync(sample, 'xx mayfair-selftest-marker yy');
  const r = await runTool(exe, ['-w', rules, sample], { cwd: runDir, timeoutMs: 20000, launcher });
  if (r.code !== 0 || !/^mfselftest /m.test(r.stdout)) throw new common.ToolError('yara started but did not match the built-in test rule; it is not working', 3);
  return [mk('yara-selftest', 'built-in rule matched built-in sample')];
}
module.exports = { SPEC, normalizeInput, buildArgs, parse, functionalSelfTest, splitMeta };
