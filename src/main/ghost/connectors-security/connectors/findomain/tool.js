'use strict';
// Findomain (GPL-3.0-or-later, separate program): passive subdomain listing. Quiet mode, no resolver check, no API keys.
const common = require('./common');
const SPEC = { id: 'findomain', tool: 'findomain', version: '1.0.0', scope: 'passive', versionArgs: ['--version'], versionRe: /findomain\s+v?(\d+\.\d+\.\d+)/i };

function normalizeInput(a) {
  const domain = String(a.domain || '').toLowerCase();
  if (!common.FQDN_RE.test(domain)) throw new common.UsageError('domain must be a full domain name such as example.com');
  return { domain };
}
async function buildArgs(input) { return { argv: ['-t', input.domain, '-q'] }; }
// raw: stdout, one name per line
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const domain = opts.input && opts.input.domain;
  const seen = new Set(); let bad = 0; const out = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const h = line.trim().toLowerCase().replace(/^\*\./, '');
    if (!h) continue;
    if (!common.FQDN_RE.test(h) || (domain && !common.inDomain(h, domain))) { bad++; continue; }
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(mk('subdomain', h, { confidence: 'uncertain', note: 'Listed by passive sources only; not resolved or contacted, so it may be stale or a wildcard artefact.' }));
  }
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse };
