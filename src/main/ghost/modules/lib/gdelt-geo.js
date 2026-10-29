'use strict';
// GDELT GEO 2.0: where in the world news coverage of an organisation, domain, place or topic is located (place mentions, as GeoJSON points).
const { ModuleError, needDomain, clip } = require('./core');
const K = require('./keyless-common');

const meta = {
  id: 'gdelt-geo', tool: 'gdelt-geo-2.0', name: 'News locations (GDELT GEO)', version: '1.0.0',
  description: 'Places named in recent news coverage of an organisation, a domain, a place or a topic, with how many articles mention each, from the GDELT project.',
  capabilities: ['news', 'gdelt', 'geo', 'places', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['api.gdeltproject.org'], client: { rps: 0.2, maxRequests: 4, timeoutMs: 30000, maxBytes: 2097152 },
  restrictions: 'GDELT asks for one request every 5 seconds and offers no availability guarantee; this connector sends one a run. Free to use with citation of GDELT. The points are places mentioned in articles, not verified event locations. Any query text is sent to GDELT as typed; a domain query must be a valid domain.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Data: The GDELT Project (gdeltproject.org)',
  dataTerms: 'GDELT Project data, free to use with citation',
  inputs: [
    { name: 'kind', type: 'enum', label: 'What the query names', values: ['organisation', 'domain', 'place', 'topic'] },
    { name: 'query', type: 'string', label: 'Query', minLength: 2, maxLength: 120 },
    { name: 'timespan', type: 'enum', label: 'Period', required: false, values: ['1d', '7d', '1month', '3months'] },
    { name: 'limit', type: 'integer', label: 'Most places', required: false, min: 1, max: 100 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { kind: 'organisation', query: 'United Nations', timespan: '7d', limit: 5 }, expect: { minResults: 1 } },
};

function buildQuery(kind, raw) {
  const q = String(raw || '').trim();
  if (kind === 'domain') return `domain:${needDomain(q)}`;
  const clean = q.replace(/["()<>\[\]{}:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) throw new ModuleError('bad-input', 'the query is too short');
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

// GDELT answers "please limit requests to one every 5 seconds" in plain text with HTTP 200, and two GDELT tools started together share one allowance.
// The client already spaces requests by 5 seconds, so asking again after that answer is polite: up to three tries.
async function getPolite(ctx, url, purpose) {
  let res;
  for (let i = 0; i < 3; i++) {
    res = await ctx.client.get(url, { purpose });
    if (!/limit requests|one every|too many/i.test(String(res.text || '').slice(0, 300)) || res.status === 404) return res;
    ctx.progress(0.3, 'GDELT asked to slow down, trying again');
  }
  return res;
}

async function run(ctx, input) {
  if (!['organisation', 'domain', 'place', 'topic'].includes(input.kind)) throw new ModuleError('bad-input', 'kind must be organisation, domain, place or topic');
  const query = buildQuery(input.kind, input.query);
  const span = input.timespan || '7d', limit = K.intOr(input.limit, 40, 1, 100);
  ctx.progress(0.2, 'asking GDELT');
  const res = await getPolite(ctx, `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodeURIComponent(query)}&format=geojson&timespan=${span}&maxpoints=${limit}`, 'gdelt-geo');
  const text = res.text.trim();
  if (res.status === 404 || !text) { ctx.note('GDELT returned nothing for this query'); return; }
  let doc;
  try { doc = JSON.parse(text); } catch {
    if (/limit requests|one every|too many/i.test(text)) throw new ModuleError('rate-limited', 'GDELT asked us to slow down (one request every 5 seconds)');
    if (/too short|too long|invalid|not valid|illegal/i.test(text)) throw new ModuleError('bad-input', 'GDELT rejected the query: ' + clip(text, 160));
    throw new ModuleError('bad-response', 'GDELT did not return JSON');
  }
  const feats = doc && doc.type === 'FeatureCollection' && Array.isArray(doc.features) ? doc.features : null;
  if (!feats) throw new ModuleError('bad-response', 'GDELT answered in a shape that is not a GeoJSON feature list');
  if (!feats.length) { ctx.note('no places in this period'); return; }
  const rows = [];
  for (const f of feats) {
    const g = f && f.geometry, p = (f && f.properties) || {};
    if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
    const lon = Number(g.coordinates[0]), lat = Number(g.coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || typeof p.name !== 'string' || !p.name.trim()) continue;
    rows.push({ name: p.name.trim(), lat, lon, count: Number.isFinite(Number(p.count)) ? Number(p.count) : undefined });
  }
  rows.sort((a, b) => (b.count || 0) - (a.count || 0));
  for (const r of rows.slice(0, limit)) ctx.emit({ type: 'place', value: clip(r.name, 300), confidence: 'likely', url: res.url, raw: { kind: 'news-location', lat: r.lat, lon: r.lon, articleCount: r.count, timespan: span, query, attribution: meta.attribution } });
  ctx.note('a place appears when articles mention it near your query words: it is a mention, not a verified event location');
  ctx.progress(1);
}
module.exports = { meta, run, buildQuery };
