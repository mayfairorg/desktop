'use strict';
// Certificate transparency (crt.sh). Passive: reads public log records, never contacts the investigated host.
const { ModuleError, needDomain, isDnsName, isoDate, clip } = require('./core');

const meta = {
  id: 'ct-crtsh', tool: 'crt.sh', name: 'Certificate transparency (crt.sh)', version: '1.0.0',
  description: 'Certificates publicly logged for a domain and its subdomains, with the host names they list and their validity dates.',
  capabilities: ['certificate-transparency', 'subdomains', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['crt.sh'], client: { rps: 0.33, maxRequests: 2, timeoutMs: 60000, maxBytes: 8388608 },
  restrictions: 'crt.sh is a free public service run by Sectigo with no stated guarantee: it is often slow or unavailable, and it asks for light use. This module sends one request per run, at most one per 3 seconds. Names that are not host names (for example email addresses in certificate subjects) are withheld.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'Public certificate transparency log data via crt.sh',
  inputs: [
    { name: 'domain', type: 'string', label: 'Domain', maxLength: 253, pattern: '^[A-Za-z0-9.-]+$' },
    { name: 'expired', type: 'enum', label: 'Expired certificates', required: false, values: ['include', 'exclude'] },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { domain: 'example.com', expired: 'exclude' }, expect: { minResults: 1 } },
};
const MAX_CERTS = 300, MAX_NAMES = 500;

async function run(ctx, input) {
  const domain = needDomain(input.domain);
  const q = encodeURIComponent('%.' + domain);
  ctx.progress(0.1, 'asking crt.sh (it can take a while)');
  const res = await ctx.client.get(`https://crt.sh/?q=${q}&output=json${input.expired === 'exclude' ? '&exclude=expired' : ''}`, { purpose: 'ct-search' });
  const text = res.text.trim();
  if (res.status === 404 || text === '') { ctx.note('crt.sh lists no certificate for this domain'); return; }
  let rows;
  try { rows = JSON.parse(text); } catch { throw new ModuleError('bad-response', 'crt.sh did not return JSON'); }
  if (!Array.isArray(rows)) throw new ModuleError('bad-response', 'crt.sh returned an unexpected shape');
  const byId = new Map();
  for (const r of rows) if (r && Number.isInteger(r.id) && !byId.has(r.id)) byId.set(r.id, r);
  const certs = [...byId.values()].sort((a, b) => b.id - a.id);
  if (certs.length > MAX_CERTS) ctx.note(`crt.sh listed ${certs.length} certificates; the newest ${MAX_CERTS} are reported`);
  ctx.progress(0.5, `${certs.length} certificates`);
  const names = new Map();      // host -> {wildcard, first, last, certs}
  let withheld = 0, outOfScope = 0;
  for (const c of certs.slice(0, MAX_CERTS)) {
    const nb = isoDate(c.not_before), na = isoDate(c.not_after);
    const list = String(c.name_value || '').split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const inScope = [];
    for (const raw of list) {
      const wildcard = raw.startsWith('*.');
      const h = wildcard ? raw.slice(2) : raw;
      if (!isDnsName(h)) { withheld++; continue; }
      if (h !== domain && !h.endsWith('.' + domain)) { outOfScope++; continue; }
      inScope.push(h);
      const e = names.get(h) || { wildcard: false, first: nb, last: na, ids: new Set() };
      e.wildcard = e.wildcard || wildcard; e.ids.add(c.id);
      if (nb && (!e.first || nb < e.first)) e.first = nb;
      if (na && (!e.last || na > e.last)) e.last = na;
      names.set(h, e);
    }
    ctx.emit({ type: 'cert', value: `crtsh:${c.id}`, url: `https://crt.sh/?id=${c.id}`, raw: { serial: c.serial_number ? clip(c.serial_number, 80) : undefined, issuer: clip(c.issuer_name || '', 200), issuerCaId: c.issuer_ca_id, notBefore: nb, notAfter: na, loggedAt: isoDate(c.entry_timestamp), namesInScope: [...new Set(inScope)].length, namesOutOfScope: list.length - inScope.length } });
  }
  let n = 0;
  for (const [h, e] of [...names].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (n++ >= MAX_NAMES) { ctx.note(`more than ${MAX_NAMES} names; the rest are not reported`); break; }
    ctx.emit({ type: 'domain', value: h, url: `https://crt.sh/?q=${encodeURIComponent(h)}`, raw: { rel: 'certificate-name', of: domain, wildcardSeen: e.wildcard || undefined, certificates: e.ids.size, firstNotBefore: e.first, lastNotAfter: e.last } });
  }
  if (withheld) ctx.note(`${withheld} certificate name(s) that are not host names were withheld`);
  if (outOfScope) ctx.note(`${outOfScope} other name(s) on shared certificates are counted but not reported`);
  ctx.progress(1);
}
module.exports = { meta, run };
