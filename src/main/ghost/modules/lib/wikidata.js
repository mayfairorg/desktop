'use strict';
// Wikidata: organisations and places by name. An item that is a person (instance of human) is reported as a `person` result, like any other match.
const { ModuleError, isoDate, clip } = require('./core');

const meta = {
  id: 'wikidata', tool: 'wikidata-api', name: 'Organisations and places (Wikidata)', version: '1.0.0',
  description: 'Looks up an organisation or a place by name in Wikidata and reports the matching items with their identifier, description, website, founding date and coordinates.',
  capabilities: ['organisations', 'places', 'wikidata', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['www.wikidata.org'], client: { rps: 1, maxRequests: 4, timeoutMs: 20000, maxBytes: 4194304 },
  restrictions: 'Wikimedia asks API users to identify themselves and keep to modest request rates: at most one request per second, two per search. Wikidata content is CC0. Items about people that match the name are reported as people, with their Wikidata identifier and description.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'Wikidata is CC0 1.0',
  inputs: [
    { name: 'kind', type: 'enum', label: 'Looking for', values: ['organisation', 'place'] },
    { name: 'query', type: 'string', label: 'Name', minLength: 2, maxLength: 100 },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { kind: 'organisation', query: 'Mozilla Foundation' }, expect: { minResults: 1 } },
};
const claimValue = (e, p) => { const c = (e.claims && e.claims[p]) || []; for (const x of c) { const v = x && x.mainsnak && x.mainsnak.datavalue && x.mainsnak.datavalue.value; if (v !== undefined) return v; } return undefined; };
const claimIds = (e, p) => ((e.claims && e.claims[p]) || []).map((x) => x && x.mainsnak && x.mainsnak.datavalue && x.mainsnak.datavalue.value && x.mainsnak.datavalue.value.id).filter(Boolean);
const api = (p) => 'https://www.wikidata.org/w/api.php?' + Object.entries({ ...p, format: 'json', formatversion: '2' }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function run(ctx, input) {
  const query = String(input.query || '').trim().replace(/\s+/g, ' ');
  if (query.length < 2) throw new ModuleError('bad-input', 'the name is too short');
  if (/@/.test(query) || /^https?:/i.test(query)) throw new ModuleError('bad-input', 'enter an organisation or place name, not an address');
  if (input.kind !== 'organisation' && input.kind !== 'place') throw new ModuleError('bad-input', 'kind must be organisation or place');
  ctx.progress(0.1, 'searching');
  const s = await ctx.client.get(api({ action: 'wbsearchentities', search: query, language: 'en', uselang: 'en', type: 'item', limit: 8 }), { purpose: 'wikidata-search' });
  const sdoc = s.status === 404 ? {} : s.json();
  const hits = Array.isArray(sdoc.search) ? sdoc.search.filter((h) => h && /^Q\d{1,12}$/.test(h.id)) : [];
  if (!hits.length) { ctx.note('Wikidata has no item with that name'); return; }
  ctx.progress(0.5, 'reading items');
  const g = await ctx.client.get(api({ action: 'wbgetentities', ids: hits.map((h) => h.id).join('|'), props: 'labels|descriptions|claims', languages: 'en' }), { purpose: 'wikidata-entities' });
  const gdoc = g.json();
  const ents = gdoc && gdoc.entities && typeof gdoc.entities === 'object' ? gdoc.entities : {};
  for (const h of hits) {
    const e = ents[h.id];
    if (!e || typeof e !== 'object') continue;
    const label = (e.labels && e.labels.en && e.labels.en.value) || h.label || h.id;
    const desc = (e.descriptions && e.descriptions.en && e.descriptions.en.value) || h.description || undefined;
    const itemUrl = `https://www.wikidata.org/wiki/${h.id}`;
    const coord = claimValue(e, 'P625');
    const lat = coord && Number.isFinite(coord.latitude) ? +coord.latitude.toFixed(6) : undefined, lon = coord && Number.isFinite(coord.longitude) ? +coord.longitude.toFixed(6) : undefined;
    const exact = String(label).toLowerCase() === query.toLowerCase();
    const note = `matched by name${exact ? '' : ' (not an exact label match)'}; check the description before relying on it`;
    if (claimIds(e, 'P31').includes('Q5')) { ctx.emit({ type: 'person', value: String(label), confidence: 'likely', url: itemUrl, raw: { qid: h.id, description: desc, matchNote: note } }); continue; }
    if (input.kind === 'place') {
      ctx.emit({ type: 'place', value: String(label), confidence: lat !== undefined ? 'likely' : 'uncertain', ...(lat === undefined ? { uncertaintyNote: 'Wikidata gives no coordinates for this item; the match is by name only' } : {}), url: itemUrl, raw: { qid: h.id, description: desc, lat, lon, instanceOf: claimIds(e, 'P31').slice(0, 5), matchNote: note } });
    } else {
      ctx.emit({ type: 'org', value: String(label), confidence: 'likely', url: itemUrl, raw: { qid: h.id, description: desc, instanceOf: claimIds(e, 'P31').slice(0, 5), matchNote: note } });
      const site = claimValue(e, 'P856');
      if (typeof site === 'string') { let u; try { u = new URL(site); } catch { u = null; } if (u && /^https?:$/.test(u.protocol)) ctx.emit({ type: 'url', value: u.href, confidence: 'likely', url: itemUrl, raw: { rel: 'official-website', of: String(label), qid: h.id } }); }
      const inc = claimValue(e, 'P571');
      const t = inc && typeof inc.time === 'string' ? isoDate(inc.time.replace(/^\+/, '').replace(/-00/g, '-01')) : null;
      if (t) ctx.emit({ type: 'event', value: `inception of ${clip(label, 120)}: ${inc.precision >= 11 ? t.slice(0, 10) : t.slice(0, 4)}`, confidence: 'likely', url: itemUrl, raw: { kind: 'inception', t, precision: inc.precision, of: String(label), qid: h.id } });
    }
  }
  ctx.progress(1);
}
module.exports = { meta, run };
