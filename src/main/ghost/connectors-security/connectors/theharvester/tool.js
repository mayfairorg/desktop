'use strict';
// theHarvester (treated as GPL: its licence was not confirmed from the repository, see the tool audit; separate Python program): COMPANY DOMAIN
// ONLY. Sources are a fixed allowlist of keyless infrastructure sources. People and social sources (linkedin, twitter, ...), keyed services and
// email-oriented sources are excluded, and the "emails" and "people" parts of the output are discarded and counted, never reported.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'theharvester', tool: 'theHarvester', version: '1.0.0', scope: 'passive', timeoutMs: 400000, versionArgs: ['-h'], versionRe: /theHarvester\s+v?(\d+\.\d+\.\d+)/i, versionNonzeroOk: true,
  extraChecks: { python: { argv: ['python3', '--version'], re: /Python (\d+)\./, minMajor: 3 } } };
const SOURCES = ['crtsh', 'hackertarget', 'rapiddns', 'anubis', 'threatminer', 'certspotter'];
const DENIED_SOURCE = /(linkedin|twitter|people|social|github|hunter|snov|intelx|haveibeen|pwn|leak|shodan|censys|virustotal|securitytrails|fullhunt|bevigil|zoomeye|netlas|criminalip|bing|google|yahoo|duckduckgo|baidu|email)/i;

function normalizeInput(a) {
  const domain = String(a.domain || '').toLowerCase();
  if (!common.FQDN_RE.test(domain)) throw new common.UsageError('domain must be a company domain name such as example.com');
  for (const s of SOURCES) if (DENIED_SOURCE.test(s)) throw new common.UsageError('source ' + s + ' is not allowed');
  return { domain };
}
async function buildArgs(input, ctx) {
  const base = path.join(ctx.runDir, 'out');
  return { argv: ['-d', input.domain, '-b', SOURCES.join(','), '-l', '200', '-f', base],
    collect: async () => { try { return fs.readFileSync(base + '.json', 'utf8'); } catch { return ''; } } };
}
// raw: out.json {"hosts":["a.example.com:1.2.3.4"],"ips":[],"emails":[...],...}
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  let j;
  try { j = JSON.parse(String(raw)); } catch { throw new common.ToolError('theHarvester did not write a readable JSON file'); }
  if (!j || typeof j !== 'object') throw new common.ToolError('theHarvester JSON is not an object');
  const domain = opts.input && opts.input.domain;
  const out = []; const seen = new Set(); let bad = 0;
  for (const h of Array.isArray(j.hosts) ? j.hosts : []) {
    if (typeof h !== 'string') { bad++; continue; }
    const [name, ip] = h.split(':');
    const n = String(name).trim().toLowerCase().replace(/^\*\./, '');
    if (!common.FQDN_RE.test(n) || (domain && !common.inDomain(n, domain))) { bad++; continue; }
    if (!seen.has(n)) { seen.add(n); out.push(mk('subdomain', n, { confidence: 'uncertain', note: 'Listed by passive sources; not contacted by Ghost, so it may be stale.', raw: ip && common.isIPv4(ip) ? { ip } : undefined })); }
    if (ip && common.isIPv4(ip) && !seen.has('ip|' + n + ip)) { seen.add('ip|' + n + ip); out.push(mk('ip-address', ip, { confidence: 'uncertain', note: `Address paired with ${n} by a source's own resolution, at an unknown time.`, raw: { host: n } })); }
  }
  const omitted = ['emails', 'people', 'linkedin_people', 'twitter_people', 'linkedin_links'].filter((k) => Array.isArray(j[k]) && j[k].length).map((k) => `${j[k].length} ${k}`);
  if (omitted.length) out.push(mk('fields-omitted', `${omitted.join(', ')} left out by design`, { raw: { reason: 'Mayfair Ghost does not collect personal data about individuals' } }));
  const w = common.skipNote(mk, bad, 'host entries'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, SOURCES, DENIED_SOURCE, normalizeInput, buildArgs, parse };
