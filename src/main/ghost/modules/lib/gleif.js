'use strict';
// GLEIF: legal entity lookup in the Global LEI Index, by name or by LEI. Organisations only. Records of sole proprietors (a natural person
// trading under their own name) are withheld and counted.
const { ModuleError, clip } = require('./core');
const K = require('./keyless-common');

const meta = {
  id: 'gleif', tool: 'gleif-lei-api', name: 'Legal entity lookup (GLEIF)', version: '1.0.0',
  description: 'Finds registered legal entities in the Global LEI Index by name or by 20-character LEI: legal name, jurisdiction, legal form, status and registration dates.',
  capabilities: ['companies', 'lei', 'gleif', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['api.gleif.org'], client: { rps: 1, maxRequests: 2, timeoutMs: 20000, maxBytes: 1048576 },
  restrictions: 'GLEIF allows 60 requests a minute; this connector makes at most one a second and two a run. No account. Covers legal entities that hold an LEI (mostly companies, funds and public bodies), not every company. Records of sole proprietors are withheld. Organisations only: do not use it to look up a private individual.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Contains data from the Global Legal Entity Identifier Foundation (GLEIF), CC0 1.0',
  dataTerms: 'GLEIF Golden Copy and API data are CC0 1.0 (public domain dedication). Attribution: GLEIF',
  inputs: [
    { name: 'kind', type: 'enum', label: 'Search by', values: ['name', 'lei'] },
    { name: 'query', type: 'string', label: 'Legal name or LEI', minLength: 2, maxLength: 120 },
    { name: 'limit', type: 'integer', label: 'Most records', required: false, min: 1, max: 25 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { kind: 'name', query: 'Microsoft Corporation', limit: 3 }, expect: { minResults: 1 } },
};
const LEI_RE = /^[A-Z0-9]{18}[0-9]{2}$/;
const addr = (a) => (a && typeof a === 'object' ? { country: a.country, region: a.region, city: a.city } : undefined);

async function run(ctx, input) {
  const q = String(input.query || '').trim();
  const limit = K.intOr(input.limit, 10, 1, 25);
  let url;
  if (input.kind === 'lei') {
    const lei = q.toUpperCase().replace(/\s+/g, '');
    if (!LEI_RE.test(lei)) throw new ModuleError('bad-input', 'an LEI is 20 letters and digits (the last two are digits)');
    url = `https://api.gleif.org/api/v1/lei-records/${lei}`;
  } else if (input.kind === 'name') {
    K.refuseContactShape(q);
    url = `https://api.gleif.org/api/v1/lei-records?filter%5Bfulltext%5D=${encodeURIComponent(q)}&page%5Bsize%5D=${limit}&page%5Bnumber%5D=1`;
  } else throw new ModuleError('bad-input', 'kind must be name or lei');
  ctx.progress(0.2, 'asking GLEIF');
  const res = await ctx.client.get(url, { accept: 'application/vnd.api+json, application/json', purpose: 'gleif-' + input.kind });
  if (res.status === 404) { ctx.note('GLEIF has no record for this LEI'); return; }
  const doc = res.json();
  const data = doc && doc.data;
  const recs = Array.isArray(data) ? data : (data && typeof data === 'object' ? [data] : null);
  if (!recs) throw new ModuleError('bad-response', 'GLEIF answered in a shape that is not a record list');
  if (!recs.length) { ctx.note('no legal entity matches'); return; }
  let withheld = 0;
  for (const r of recs.slice(0, limit)) {
    const a = r && r.attributes;
    const e = a && a.entity;
    const lei = a && typeof a.lei === 'string' ? a.lei : (r && r.id);
    const name = e && e.legalName && e.legalName.name;
    if (!e || typeof name !== 'string' || !LEI_RE.test(String(lei))) continue;
    if (e.category === 'SOLE_PROPRIETOR') { withheld++; continue; }
    const reg = a.registration || {};
    ctx.emit({
      type: 'org', value: clip(name, 300), confidence: input.kind === 'lei' ? 'confirmed' : 'likely', url: `https://search.gleif.org/#/record/${lei}`,
      raw: { kind: 'legal-entity', lei, jurisdiction: e.jurisdiction, category: e.category, legalForm: e.legalForm && (e.legalForm.id || e.legalForm.other), entityStatus: e.status, registeredAt: e.registeredAt && e.registeredAt.id, registeredAs: e.registeredAs ? clip(e.registeredAs, 80) : undefined, legalAddress: addr(e.legalAddress), headquarters: addr(e.headquartersAddress), registrationStatus: reg.status, initialRegistrationDate: reg.initialRegistrationDate, lastUpdateDate: reg.lastUpdateDate, nextRenewalDate: reg.nextRenewalDate, corroborationLevel: reg.corroborationLevel, managingLou: reg.managingLou, attribution: meta.attribution },
    });
  }
  if (withheld) ctx.note(`${withheld} record(s) of sole proprietors were withheld (organisations only)`);
  if (input.kind === 'name') ctx.note('matched on the name text: check the jurisdiction and LEI before treating a record as the organisation you mean');
  ctx.progress(1);
}
module.exports = { meta, run };
