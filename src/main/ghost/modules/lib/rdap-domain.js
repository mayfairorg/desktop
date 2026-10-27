'use strict';
// Domain registration data (RDAP). Passive: asks the public registry, never the investigated host.
const { ModuleError, needDomain } = require('./core');
const { bootstrapFor, walkEntities, events } = require('./rdap-common');

const meta = {
  id: 'rdap-domain', tool: 'rdap', name: 'Domain registration (RDAP)', version: '1.0.0',
  description: 'Registration data for a domain from the public RDAP registry service: status, registrar, name servers, key dates and the contacts the registry publishes.',
  capabilities: ['domain-registration', 'rdap', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['data.iana.org'], dynamicHosts: true, client: { rps: 1, maxRequests: 6, timeoutMs: 15000, maxBytes: 1048576 },
  restrictions: 'Public RDAP servers apply their own rate limits and terms; this module sends at most one request per second and a few per run. Contacts are reported as the registry publishes them (organisations, individuals and abuse mailboxes); an entry the registry itself redacted is counted and the domain is marked redacted. The registry\'s terms govern what you may do with the data.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'IANA RDAP bootstrap and registry data, free to use under each registry\'s terms',
  inputs: [{ name: 'domain', type: 'string', label: 'Domain', maxLength: 253, pattern: '^[A-Za-z0-9.-]+$' }],
  files: ['core.js', 'runtime.js', 'rdap-common.js'],
  selfTest: { input: { domain: 'example.com' }, expect: { minResults: 1, contains: [{ type: 'domain', value: 'example.com' }] } },
};

async function run(ctx, input) {
  const name = needDomain(input.domain);
  ctx.progress(0.1, 'finding the registry');
  const { base } = await bootstrapFor(ctx.client, 'dns', name.split('.').pop());
  ctx.progress(0.5, 'asking the registry');
  const url = `${base}domain/${encodeURIComponent(name)}`;
  const res = await ctx.client.get(url, { accept: 'application/rdap+json, application/json', purpose: 'rdap-domain' });
  if (res.status === 404) { ctx.note(`the registry has no record for ${name} (not registered, or not served by RDAP)`); return; }
  const doc = res.json();
  if (!doc || doc.objectClassName !== 'domain') throw new ModuleError('bad-response', 'the registry answer is not a domain record');
  const queried = String(doc.ldhName || name).toLowerCase();
  const orgs = [], abuse = [], people = [];
  const redacted = walkEntities(doc.entities, { org: (o) => orgs.push(o), abuse: (m) => abuse.push(m), person: (p) => people.push(p) });
  const status = (Array.isArray(doc.status) ? doc.status : []).map(String).slice(0, 12);
  ctx.emit({ type: 'domain', value: queried, url: res.url, raw: { handle: doc.handle || undefined, status, dnssec: doc.secureDNS ? !!doc.secureDNS.delegationSigned : undefined, redacted: redacted > 0 || undefined, registryRedactedContacts: redacted || undefined } });
  for (const ev of events(doc)) ctx.emit({ type: 'event', value: `${ev.action} of ${queried}: ${ev.t.slice(0, 10)}`, url: res.url, raw: { kind: ev.action, t: ev.t, of: queried } });
  for (const ns of Array.isArray(doc.nameservers) ? doc.nameservers : []) {
    const h = ns && typeof ns.ldhName === 'string' ? ns.ldhName.toLowerCase().replace(/\.$/, '') : null;
    if (h) ctx.emit({ type: 'domain', value: h, url: res.url, raw: { rel: 'nameserver', of: queried } });
  }
  for (const o of orgs) ctx.emit({ type: 'org', value: o.name, url: res.url, raw: { roles: o.roles, handle: o.handle, of: queried } });
  for (const m of abuse) ctx.emit({ type: 'email', value: m, url: res.url, raw: { role: 'abuse-contact', of: queried } });
  for (const p of people) ctx.emit({ type: 'person', value: p.name, url: res.url, raw: { roles: p.roles, handle: p.handle, emails: p.emails.length ? p.emails : undefined, of: queried } });
  if (redacted) ctx.note(`${redacted} contact(s) were redacted by the registry itself`);
  ctx.progress(1);
}
module.exports = { meta, run };
