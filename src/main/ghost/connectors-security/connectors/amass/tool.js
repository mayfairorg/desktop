'use strict';
// OWASP Amass (Apache-2.0): enumeration in PASSIVE mode only. This connector never passes -active or -brute.
// Output is read from a file in the per-run folder. Flags follow the upstream help as recalled; not run against a live binary here.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'amass', tool: 'amass', version: '1.0.0', scope: 'passive', versionArgs: ['-version'], versionRe: /v?(\d+\.\d+\.\d+)/, versionNonzeroOk: true };

function normalizeInput(a) {
  const domain = String(a.domain || '').toLowerCase();
  if (!common.FQDN_RE.test(domain)) throw new common.UsageError('domain must be a full domain name such as example.com');
  return { domain };
}
async function buildArgs(input, ctx) {
  const out = path.join(ctx.runDir, 'amass-out.txt');
  return {
    argv: ['enum', '-passive', '-d', input.domain, '-timeout', '8', '-nocolor', '-dir', path.join(ctx.runDir, 'db'), '-o', out],
    collect: async () => { try { return fs.readFileSync(out, 'utf8'); } catch { return ''; } },
  };
}
// raw: the -o file. Accepts "name", "[source] name" and "name (FQDN) --> relation --> value (Type)".
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const domain = opts.input && opts.input.domain;
  const names = new Map(); const out = []; let bad = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^[#=-]/.test(t)) continue;
    let m = /^(\S+) \(FQDN\)(?: --> ([a-z_]+) --> (\S+) \((\w+)\))?$/.exec(t);
    let name, source = null, rel = null;
    if (m) { name = m[1]; if (m[2]) rel = { relation: m[2], value: m[3], type: m[4] }; }
    else if ((m = /^\[([^\]]{1,40})\]\s+(\S+)(?:\s+.*)?$/.exec(t))) { source = m[1]; name = m[2]; }
    else if (/^\S+$/.test(t)) name = t;
    else { bad++; continue; }
    name = name.toLowerCase().replace(/^\*\./, '');
    if (!common.FQDN_RE.test(name) || (domain && !common.inDomain(name, domain))) { bad++; continue; }
    const e = names.get(name) || { sources: new Set(), rels: [] };
    if (source) e.sources.add(source);
    if (rel && e.rels.length < 5) e.rels.push(rel);
    names.set(name, e);
  }
  for (const [name, e] of names) {
    out.push(mk('subdomain', name, { confidence: 'uncertain', note: 'Found by passive enumeration only; the name was not contacted, so it may be stale.', raw: { ...(e.sources.size ? { sources: [...e.sources] } : {}), ...(e.rels.length ? { relations: e.rels } : {}) } }));
  }
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse };
