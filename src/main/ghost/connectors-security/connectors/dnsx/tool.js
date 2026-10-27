'use strict';
// dnsx (ProjectDiscovery, MIT): DNS record lookup for ONE domain. Plain queries only: no brute-force wordlist mode, no -d bruteforce.
// Queries go to the resolver you choose (system, Cloudflare or Quad9); the target's own hosts are not contacted by this connector.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'dnsx', tool: 'dnsx', version: '1.0.0', scope: 'passive', versionArgs: ['-version'], versionRe: /(?:Current Version|version)[: ]+v?(\d+\.\d+\.\d+)/i, versionNonzeroOk: true };
const RESOLVERS = { system: null, cloudflare: '1.1.1.1,1.0.0.1', quad9: '9.9.9.9,149.112.112.112' };

function normalizeInput(a) {
  const domain = String(a.domain || '').toLowerCase();
  if (!common.FQDN_RE.test(domain)) throw new common.UsageError('domain must be a full domain name such as example.com');
  const resolver = a.resolver === undefined ? 'system' : String(a.resolver);
  if (!(resolver in RESOLVERS)) throw new common.UsageError('resolver must be system, cloudflare or quad9');
  return { domain, resolver };
}
async function buildArgs(input, ctx) {
  const list = path.join(ctx.runDir, 'hosts.txt');
  fs.writeFileSync(list, input.domain + '\n');
  const argv = ['-l', list, '-a', '-aaaa', '-cname', '-mx', '-ns', '-txt', '-json', '-silent', '-retry', '2', '-rl', '10', '-t', '5'];
  if (RESOLVERS[input.resolver]) argv.push('-r', RESOLVERS[input.resolver]);
  return { argv };
}
// raw: stdout JSON lines {"host","resolver":[],"a":[],"aaaa":[],"cname":[],"mx":[],"ns":[],"txt":[],"status_code","timestamp"}
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const out = []; let bad = 0;
  const rec = (host, type, data, at, raw2) => out.push(mk('dns-record', `${host} ${type} ${data}`, { observedAt: at || undefined, raw: raw2 }));
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch { bad++; continue; }
    const host = typeof j.host === 'string' ? j.host.toLowerCase() : '';
    if (!host) { bad++; continue; }
    const at = common.isoTs(j.timestamp);
    const resolver = Array.isArray(j.resolver) ? j.resolver.slice(0, 3) : undefined;
    if (j.status_code && j.status_code !== 'NOERROR') {
      out.push(mk('dns-status', `${host} ${j.status_code}`, { observedAt: at || undefined, raw: { resolver } }));
      continue;
    }
    for (const [key, type] of [['a', 'A'], ['aaaa', 'AAAA'], ['cname', 'CNAME'], ['mx', 'MX'], ['ns', 'NS'], ['txt', 'TXT']]) {
      for (const d of Array.isArray(j[key]) ? j[key].slice(0, 50) : []) if (typeof d === 'string' && d) rec(host, type, d.slice(0, 1500), at, { resolver });
    }
  }
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, RESOLVERS, normalizeInput, buildArgs, parse };
