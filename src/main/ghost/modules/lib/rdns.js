'use strict';
// Reverse DNS (PTR) through a public DNS-over-HTTPS resolver, with a forward check: a name is "confirmed" only when that name's own A or
// AAAA record points back at the address. Passive: the resolver is asked, the address itself is never contacted.
const { isIP } = require('node:net');
const { ModuleError, isDnsName, isReservedIp, ipToBig, toAscii } = require('./core');

const PROVIDERS = { cloudflare: (n, t) => `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(n)}&type=${t}`, google: (n, t) => `https://dns.google/resolve?name=${encodeURIComponent(n)}&type=${t}` };
const STATUS = { 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };
const meta = {
  id: 'rdns', tool: 'doh-ptr', name: 'Reverse DNS (DoH)', version: '1.0.0',
  description: 'The host names an IP address\'s owner has published for it (PTR records), each checked against the name\'s own address records.',
  capabilities: ['dns', 'rdns', 'ptr', 'doh', 'passive'], scope: 'passive', network: 'keyless-external',
  hosts: ['cloudflare-dns.com', 'dns.google'], client: { rps: 4, maxRequests: 8, timeoutMs: 10000, maxBytes: 262144 },
  restrictions: 'Sends the address you enter to the chosen public resolver (Cloudflare or Google), under that resolver\'s privacy policy. The address is not contacted. Private, reserved and loopback addresses are refused. The owner of an address can publish any PTR name, so a name is only confirmed when a forward lookup agrees. No account or key.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, attribution: 'DNS answers as returned by the chosen resolver', dataTerms: 'DNS answers as returned by the chosen resolver',
  inputs: [
    { name: 'value', type: 'string', label: 'IP address', maxLength: 45, pattern: '^[0-9A-Fa-f:.]+$' },
    { name: 'provider', type: 'enum', label: 'Resolver', required: false, values: ['cloudflare', 'google'] },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { value: '8.8.8.8' }, expect: { minResults: 1, contains: [{ type: 'domain', value: 'dns.google' }] } },
};

function arpaName(ip) {
  if (isIP(ip) === 4) return ip.split('.').reverse().join('.') + '.in-addr.arpa';
  const big = ipToBig(ip);
  const hex = big.n.toString(16).padStart(32, '0');
  return hex.split('').reverse().join('.') + '.ip6.arpa';
}
const trimDot = (s) => String(s).toLowerCase().replace(/\.$/, '');
const same = (a, b) => { const x = ipToBig(a), y = ipToBig(b); return !!x && !!y && x.v === y.v && x.n === y.n; };

async function run(ctx, input) {
  const ip = String(input.value || '').trim();
  if (!isIP(ip)) throw new ModuleError('bad-input', 'enter an IPv4 or IPv6 address');
  if (isReservedIp(ip)) throw new ModuleError('bad-input', 'private, loopback and reserved addresses have no public reverse DNS and are not looked up');
  const provider = input.provider || 'cloudflare';
  if (!PROVIDERS[provider]) throw new ModuleError('bad-input', 'resolver must be cloudflare or google');
  ctx.progress(0.1, 'asking for PTR');
  const res = await ctx.client.get(PROVIDERS[provider](arpaName(ip), 'PTR'), { accept: 'application/dns-json', purpose: 'doh-ptr' });
  if (res.status === 404) throw new ModuleError('unavailable', 'the resolver does not offer the DNS JSON service');
  const doc = res.json();
  if (!doc || typeof doc.Status !== 'number') throw new ModuleError('bad-response', 'the resolver answer is not DNS JSON');
  if (doc.Status !== 0) { ctx.note(`PTR: ${STATUS[doc.Status] || 'status ' + doc.Status}`); return; }
  const names = [];
  for (const a of Array.isArray(doc.Answer) ? doc.Answer : []) {
    if (a.type !== 12 || typeof a.data !== 'string') continue;
    const n = toAscii(trimDot(a.data));
    if (isDnsName(n) && !names.includes(n)) names.push(n);
  }
  if (!names.length) { ctx.note('no reverse DNS name is published for this address'); return; }
  const fwdType = isIP(ip) === 4 ? 'A' : 'AAAA', fwdNum = fwdType === 'A' ? 1 : 28;
  let i = 0;
  for (const n of names.slice(0, 3)) {
    ctx.progress(0.3 + 0.2 * i++, 'checking ' + n);
    const f = await ctx.client.get(PROVIDERS[provider](n, fwdType), { accept: 'application/dns-json', purpose: 'doh-forward' });
    const fd = f.status === 404 ? null : f.json();
    const back = fd && fd.Status === 0 && Array.isArray(fd.Answer) && fd.Answer.some((a) => a.type === fwdNum && typeof a.data === 'string' && isIP(a.data) && same(a.data, ip));
    ctx.emit({
      type: 'domain', value: n, url: res.url, confidence: back ? 'confirmed' : 'uncertain',
      ...(back ? {} : { uncertaintyNote: 'the owner of an address can publish any reverse name; this name\'s own ' + fwdType + ' record does not point back at the address' }),
      raw: { rel: 'reverse-dns-of', ip, forwardConfirmed: !!back, resolver: provider, ttl: Number.isFinite(doc.Answer[0] && doc.Answer[0].TTL) ? doc.Answer[0].TTL : undefined },
    });
  }
  if (names.length > 3) ctx.note(`${names.length - 3} further name(s) not checked (three per run)`);
  ctx.progress(1);
}
module.exports = { meta, run, arpaName };
