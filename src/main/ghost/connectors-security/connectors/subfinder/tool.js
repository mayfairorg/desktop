'use strict';
// Subfinder (ProjectDiscovery, MIT): passive subdomain discovery from public sources. Passive mode only: no -nW / -active, no API keys.
// Command-line flags follow the upstream help as documented; they have not been run against a live binary in this build environment.
const common = require('./common');
const SPEC = { id: 'subfinder', tool: 'subfinder', version: '1.0.0', scope: 'passive', versionArgs: ['-version'], versionRe: /(?:Current Version|version)[: ]+v?(\d+\.\d+\.\d+)/i, versionNonzeroOk: true };

function normalizeInput(a) {
  const domain = String(a.domain || '').toLowerCase();
  if (!common.FQDN_RE.test(domain)) throw new common.UsageError('domain must be a full domain name such as example.com');
  return { domain };
}
async function buildArgs(input) {
  return { argv: ['-d', input.domain, '-json', '-silent', '-timeout', '20', '-max-time', '5'] };
}
// raw: stdout, JSON lines {"host","input","source":[...]}
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const domain = opts.input && opts.input.domain;
  const seen = new Map();
  let bad = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { bad++; continue; }
    const host = typeof j.host === 'string' ? j.host.trim().toLowerCase().replace(/^\*\./, '') : '';
    if (!common.FQDN_RE.test(host) || (domain && !common.inDomain(host, domain))) { bad++; continue; }
    const e = seen.get(host) || { sources: new Set() };
    for (const s of Array.isArray(j.source) ? j.source : (j.source ? [j.source] : [])) if (typeof s === 'string') e.sources.add(s.slice(0, 40));
    seen.set(host, e);
  }
  const out = [];
  for (const [host, e] of seen) {
    const n = e.sources.size;
    const src = [...e.sources];
    out.push(mk('subdomain', host, n >= 2
      ? { confidence: 'likely', note: `Reported by ${n} public sources; the name was not resolved or contacted.`, raw: { sources: src } }
      : { confidence: 'uncertain', note: `Reported by ${n ? 'one public source (' + src[0] + ')' : 'an unnamed source'}; the name was not resolved or contacted, so it may be stale.`, raw: { sources: src } }));
  }
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse };
