'use strict';
// IP block and AS number registration (RDAP). Passive: asks the regional internet registry, never the address itself.
const { isIP } = require('node:net');
const { ModuleError, isReservedIp } = require('./core');
const { bootstrapFor, walkEntities, events } = require('./rdap-common');

const meta = {
  id: 'rdap-ip-asn', tool: 'rdap', name: 'IP and ASN registration (RDAP)', version: '1.0.0',
  description: 'Who the regional internet registry lists for a public IP address block or an AS number: network name, country, organisation, contacts as published, abuse mailbox, key dates.',
  capabilities: ['ip-registration', 'asn', 'rdap', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['data.iana.org'], dynamicHosts: true, client: { rps: 1, maxRequests: 6, timeoutMs: 15000, maxBytes: 1048576 },
  restrictions: 'Registries apply their own rate limits and terms; at most one request per second. Only public addresses are accepted. Contacts are reported as the registry publishes them (organisations, individuals and abuse mailboxes); an entry the registry itself redacted is counted and the result is marked redacted. The registry\'s terms govern what you may do with the data.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'IANA RDAP bootstrap and regional registry data, free to use under each registry\'s terms',
  inputs: [
    { name: 'kind', type: 'enum', label: 'Kind', values: ['ip', 'asn'] },
    { name: 'value', type: 'string', label: 'IP address or AS number', maxLength: 45, pattern: '^[0-9A-Fa-f:.aAsS]+$' },
  ],
  files: ['core.js', 'runtime.js', 'rdap-common.js'],
  selfTest: { input: { kind: 'ip', value: '8.8.8.8' }, expect: { minResults: 1 } },
};

async function run(ctx, input) {
  const kind = input.kind, value = String(input.value || '').trim();
  if (kind === 'ip') {
    const v = isIP(value);
    if (!v) throw new ModuleError('bad-input', 'enter an IPv4 or IPv6 address');
    if (isReservedIp(value)) throw new ModuleError('bad-input', 'this is a private, reserved or documentation address: no registry lists it');
    ctx.progress(0.1, 'finding the registry');
    const { base } = await bootstrapFor(ctx.client, v === 4 ? 'ipv4' : 'ipv6', value);
    ctx.progress(0.5, 'asking the registry');
    const res = await ctx.client.get(`${base}ip/${encodeURIComponent(value)}`, { accept: 'application/rdap+json, application/json', purpose: 'rdap-ip' });
    if (res.status === 404) { ctx.note('the registry has no record for this address'); return; }
    const doc = res.json();
    if (!doc || doc.objectClassName !== 'ip network') throw new ModuleError('bad-response', 'the registry answer is not an IP network record');
    const cidr = Array.isArray(doc.cidr0_cidrs) && doc.cidr0_cidrs[0] ? (doc.cidr0_cidrs[0].v4prefix || doc.cidr0_cidrs[0].v6prefix) + '/' + doc.cidr0_cidrs[0].length : null;
    const label = cidr || `${doc.startAddress}-${doc.endAddress}`;
    const orgs = [], abuse = [], people = [];
    const redacted = walkEntities(doc.entities, { org: (o) => orgs.push(o), abuse: (m) => abuse.push(m), person: (p) => people.push(p) });
    ctx.emit({ type: 'ip', value: label, url: res.url, raw: { queried: value, name: doc.name, handle: doc.handle, country: doc.country, netType: doc.type, parentHandle: doc.parentHandle, start: doc.startAddress, end: doc.endAddress, redacted: redacted > 0 || undefined } });
    for (const ev of events(doc)) ctx.emit({ type: 'event', value: `${ev.action} of ${label}: ${ev.t.slice(0, 10)}`, url: res.url, raw: { kind: ev.action, t: ev.t, of: label } });
    for (const o of orgs) ctx.emit({ type: 'org', value: o.name, url: res.url, raw: { roles: o.roles, handle: o.handle, of: label } });
    for (const m of abuse) ctx.emit({ type: 'email', value: m, url: res.url, raw: { role: 'abuse-contact', of: label } });
    for (const p of people) ctx.emit({ type: 'person', value: p.name, url: res.url, raw: { roles: p.roles, handle: p.handle, emails: p.emails.length ? p.emails : undefined, of: label } });
    if (redacted) ctx.note(`${redacted} contact(s) were redacted by the registry itself`);
  } else if (kind === 'asn') {
    const m = /^(?:as)?(\d{1,10})$/i.exec(value);
    const n = m ? Number(m[1]) : NaN;
    if (!m || n < 1 || n > 4294967295) throw new ModuleError('bad-input', 'enter an AS number such as AS64500 or 64500');
    ctx.progress(0.1, 'finding the registry');
    const { base } = await bootstrapFor(ctx.client, 'asn', n);
    ctx.progress(0.5, 'asking the registry');
    const res = await ctx.client.get(`${base}autnum/${n}`, { accept: 'application/rdap+json, application/json', purpose: 'rdap-asn' });
    if (res.status === 404) { ctx.note('the registry has no record for this AS number'); return; }
    const doc = res.json();
    if (!doc || doc.objectClassName !== 'autnum') throw new ModuleError('bad-response', 'the registry answer is not an AS number record');
    const label = `AS${n}`;
    const orgs = [], abuse = [], people = [];
    const redacted = walkEntities(doc.entities, { org: (o) => orgs.push(o), abuse: (x) => abuse.push(x), person: (p) => people.push(p) });
    ctx.emit({ type: 'asn', value: label, url: res.url, raw: { name: doc.name, handle: doc.handle, country: doc.country, asnType: doc.type, start: doc.startAutnum, end: doc.endAutnum, redacted: redacted > 0 || undefined } });
    for (const ev of events(doc)) ctx.emit({ type: 'event', value: `${ev.action} of ${label}: ${ev.t.slice(0, 10)}`, url: res.url, raw: { kind: ev.action, t: ev.t, of: label } });
    for (const o of orgs) ctx.emit({ type: 'org', value: o.name, url: res.url, raw: { roles: o.roles, handle: o.handle, of: label } });
    for (const x of abuse) ctx.emit({ type: 'email', value: x, url: res.url, raw: { role: 'abuse-contact', of: label } });
    for (const p of people) ctx.emit({ type: 'person', value: p.name, url: res.url, raw: { roles: p.roles, handle: p.handle, emails: p.emails.length ? p.emails : undefined, of: label } });
    if (redacted) ctx.note(`${redacted} contact(s) were redacted by the registry itself`);
  } else throw new ModuleError('bad-input', 'kind must be ip or asn');
  ctx.progress(1);
}
module.exports = { meta, run };
