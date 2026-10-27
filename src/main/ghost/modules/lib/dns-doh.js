'use strict';
// DNS records over HTTPS (DoH, JSON API). Passive: asks a public resolver, never the investigated host's own servers.
const { isIP } = require('node:net');
const { ModuleError, needDomain, toAscii, clip } = require('./core');

const PROVIDERS = { cloudflare: (n, t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`, google: (n, t) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}` };
const ALL = ['A', 'AAAA', 'MX', 'NS', 'TXT', 'SOA', 'CAA'];
const TYPE_NAME = { 1: 'A', 2: 'NS', 5: 'CNAME', 6: 'SOA', 15: 'MX', 16: 'TXT', 28: 'AAAA', 257: 'CAA' };
const STATUS = { 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };

const meta = {
  id: 'dns-doh', tool: 'doh-json', name: 'DNS records (DoH)', version: '1.0.0',
  description: 'DNS records of a domain (A, AAAA, MX, NS, TXT, SOA, CAA, CNAME chains) asked of a public DNS-over-HTTPS resolver. Reports whether the resolver validated the answer with DNSSEC.',
  capabilities: ['dns', 'doh', 'passive'], scope: 'passive', network: 'keyless-external',
  hosts: ['cloudflare-dns.com', 'dns.google'], client: { rps: 4, maxRequests: 12, timeoutMs: 10000, maxBytes: 262144 },
  restrictions: 'Sends the domain name you enter to the chosen public resolver (Cloudflare or Google), under that resolver\'s privacy policy. The investigated host is not contacted. No account or key.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'DNS answers as returned by the chosen resolver',
  inputs: [
    { name: 'domain', type: 'string', label: 'Domain', maxLength: 253, pattern: '^[A-Za-z0-9._-]+$' },
    { name: 'types', type: 'enum', label: 'Record types', required: false, values: ['all', ...ALL, 'CNAME'] },
    { name: 'provider', type: 'enum', label: 'Resolver', required: false, values: ['cloudflare', 'google'] },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { domain: 'example.com', types: 'A' }, expect: { minResults: 1 } },
};

const trimDot = (s) => String(s).toLowerCase().replace(/\.$/, '');
const unquote = (s) => String(s).replace(/^"|"$/g, '').replace(/" "/g, '');

async function run(ctx, input) {
  const name = toAscii(input.domain || '');
  needDomain(name.replace(/(^|\.)_+/g, '$1a'));   // underscore labels such as _dmarc are allowed
  const types = !input.types || input.types === 'all' ? ALL : [input.types];
  const provider = input.provider || 'cloudflare';
  if (!PROVIDERS[provider]) throw new ModuleError('bad-input', 'resolver must be cloudflare or google');
  let i = 0;
  for (const t of types) {
    ctx.progress(i++ / types.length, `asking for ${t}`);
    const res = await ctx.client.get(PROVIDERS[provider](name, t), { accept: 'application/dns-json', purpose: 'doh-' + t });
    if (res.status === 404) throw new ModuleError('unavailable', 'the resolver does not offer the DNS JSON service');
    const doc = res.json();
    if (!doc || typeof doc.Status !== 'number') throw new ModuleError('bad-response', 'the resolver answer is not DNS JSON');
    if (doc.Status !== 0) { ctx.note(`${t}: ${STATUS[doc.Status] || 'status ' + doc.Status}`); continue; }
    const validated = doc.AD === true;
    for (const a of Array.isArray(doc.Answer) ? doc.Answer : []) {
      const tn = TYPE_NAME[a.type];
      if (!tn || typeof a.data !== 'string') continue;
      const owner = trimDot(a.name || name), ttl = Number.isFinite(a.TTL) ? a.TTL : undefined;
      const common = { confidence: validated ? 'confirmed' : 'likely', url: res.url };
      const raw = { rrtype: tn, name: owner, ttl, resolver: provider, dnssecValidated: validated };
      if (tn === 'A' || tn === 'AAAA') { if (isIP(a.data)) ctx.emit({ type: 'ip', value: a.data, ...common, raw: { ...raw, rel: 'address-of' } }); }
      else if (tn === 'NS' || tn === 'CNAME') ctx.emit({ type: 'domain', value: trimDot(a.data), ...common, raw: { ...raw, rel: tn === 'NS' ? 'nameserver' : 'alias-target', of: owner } });
      else if (tn === 'MX') {
        const [pri, host] = a.data.split(/\s+/);
        if (host) ctx.emit({ type: 'domain', value: trimDot(host), ...common, raw: { ...raw, rel: 'mail-exchanger', priority: Number(pri), of: owner } });
      } else if (tn === 'TXT') {
        const txt = unquote(a.data);
        ctx.emit({ type: 'event', value: clip(`TXT ${owner}: ${txt}`, 400), ...common, raw: { ...raw, kind: 'dns-txt', txt: clip(txt, 1000) } });
      } else if (tn === 'SOA') {
        const p = a.data.split(/\s+/);   // mname rname serial refresh retry expire minimum; rname (a mailbox) is not reported
        ctx.emit({ type: 'event', value: `SOA ${owner}: primary ${trimDot(p[0])}, serial ${p[2]}`, ...common, raw: { ...raw, kind: 'dns-soa', primary: trimDot(p[0]), serial: Number(p[2]), refresh: Number(p[3]), retry: Number(p[4]), expire: Number(p[5]), minimum: Number(p[6]) } });
      } else if (tn === 'CAA') {
        const m = /^(\d+)\s+(\w+)\s+"?([^"]*)"?$/.exec(a.data) || /^\\#/.exec(a.data);
        if (m && m[2]) {
          const mail = /^mailto:/i.test(m[3]) || /@/.test(m[3]);
          ctx.emit({ type: 'event', value: `CAA ${owner}: ${m[2]} ${mail ? '(contact address withheld)' : m[3]}`, ...common, raw: { ...raw, kind: 'dns-caa', flags: Number(m[1]), tag: m[2], value: mail ? undefined : clip(m[3], 200), contactWithheld: mail || undefined } });
        }
      }
    }
  }
  ctx.progress(1);
}
module.exports = { meta, run };
