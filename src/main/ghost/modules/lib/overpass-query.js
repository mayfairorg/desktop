'use strict';
// OpenStreetMap features in a small box or circle through the public Overpass API. One tag filter (key=value) from a safe pattern, hard
// caps on area, radius, result count, server time and server memory. Named features only; home-like building types, address tags and
// contact tags are never queried or reported.
const { ModuleError, clip } = require('./core');
const K = require('./keyless-common');

const MAX_SPAN = 0.1, MAX_AREA = 0.004, MAX_RADIUS = 2000;
const meta = {
  id: 'overpass-query', tool: 'osm-overpass', name: 'Map features nearby (OpenStreetMap)', version: '1.0.0',
  description: 'Lists named OpenStreetMap features of one kind (for example amenity=hospital) inside a small box or within a few hundred metres of a point.',
  capabilities: ['osm', 'overpass', 'places', 'features', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['overpass-api.de'], client: { rps: 0.5, maxRequests: 1, timeoutMs: 40000, maxBytes: 2097152 },
  restrictions: `Light queries only: at most one request a run and one every 2 seconds. The box may be at most ${MAX_SPAN} degrees on a side and ${MAX_AREA} square degrees; a circle at most ${MAX_RADIUS} m. The server is told to stop after 20 seconds or 5 MB. Residential building types, address tags and contact tags are refused. For organisations, sites and landmarks, not to find where a person lives. Credit OpenStreetMap contributors.`,
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
  dataTerms: 'OpenStreetMap data is under the Open Database Licence (ODbL) 1.0; attribution "© OpenStreetMap contributors" is required wherever results are shown or exported',
  inputs: [
    { name: 'query', type: 'string', label: 'Feature kind as key=value, e.g. amenity=hospital', minLength: 3, maxLength: 60, pattern: '^[a-z_:]{2,30}=[a-z0-9_;-]{1,40}$' },
    { name: 'bbox', type: 'string', label: 'Small area: west,south,east,north', required: false, maxLength: 80, pattern: K.BBOX_PATTERN },
    { name: 'value', type: 'string', label: 'Or a circle: latitude,longitude,metres', required: false, maxLength: 40, pattern: '^-?[0-9]+(\\.[0-9]+)?,-?[0-9]+(\\.[0-9]+)?,[0-9]{2,4}$' },
    { name: 'limit', type: 'integer', label: 'Most features', required: false, min: 1, max: 100 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { query: 'amenity=cafe', bbox: '2.29,48.855,2.30,48.862', limit: 3 }, expect: { minResults: 1 } },
};
const BAD_KEYS = /^(name|addr:.*|contact:.*|phone|email|fax|website|operator:.*|wikidata|ref:.*|note|description)$/;
const BAD_VALUES = new Set(['house', 'residential', 'detached', 'semidetached_house', 'terrace', 'apartments', 'bungalow', 'dormitory', 'yes', 'flats', 'cabin', 'houseboat', 'static_caravan', 'farm']);
const SHOW = ['amenity', 'shop', 'tourism', 'historic', 'leisure', 'man_made', 'aeroway', 'railway', 'office', 'building', 'healthcare', 'public_transport', 'craft', 'emergency'];

function parseFilter(q) {
  const m = /^([a-z_:]{2,30})=([a-z0-9_;-]{1,40})$/.exec(String(q || '').trim());
  if (!m) throw new ModuleError('bad-input', 'enter one feature kind as key=value, for example amenity=hospital');
  if (BAD_KEYS.test(m[1]) || (['building', 'landuse'].includes(m[1]) && BAD_VALUES.has(m[2])) || (m[1] === 'building' && m[2] === 'yes')) throw new ModuleError('bad-input', 'this filter would list homes, addresses or contact details and is refused; ask for a kind of site such as amenity=school or tourism=museum');
  return { k: m[1], v: m[2] };
}
function buildQl({ k, v }, area, cap) {
  const f = `["${k}"="${v}"]`;
  const a = area.box ? `(${area.box.s},${area.box.w},${area.box.n},${area.box.e})` : `(around:${area.r},${area.lat},${area.lon})`;
  return `[out:json][timeout:20][maxsize:5000000];(node${f}${a};way${f}${a};);out tags center ${cap};`;
}

async function run(ctx, input) {
  const filter = parseFilter(input.query);
  let area;
  if (input.bbox && input.value) throw new ModuleError('bad-input', 'give either a box or a circle, not both');
  if (input.bbox) area = { box: K.parseBox(input.bbox, { maxSpan: MAX_SPAN, maxArea: MAX_AREA }) };
  else if (input.value) {
    const [lat, lon, r] = String(input.value).split(',').map(Number);
    if (![lat, lon, r].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new ModuleError('bad-input', 'the circle must be latitude,longitude,metres');
    if (r < 10 || r > MAX_RADIUS) throw new ModuleError('bad-input', `the radius must be 10 to ${MAX_RADIUS} metres`);
    area = { lat, lon, r };
  } else throw new ModuleError('bad-input', 'give a small box (west,south,east,north) or a circle (latitude,longitude,metres)');
  const limit = K.intOr(input.limit, 50, 1, 100);
  ctx.progress(0.2, 'asking Overpass');
  const res = await ctx.client.get(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(buildQl(filter, area, limit * 2))}`, { purpose: 'overpass' });
  if (res.status === 404) throw new ModuleError('unavailable', 'the Overpass service did not answer at this address');
  const doc = res.json();
  if (!doc || !Array.isArray(doc.elements)) throw new ModuleError('bad-response', 'Overpass answered in a shape that is not a feature list');
  if (typeof doc.remark === 'string' && /runtime error|timed out|out of memory|too many requests/i.test(doc.remark)) throw new ModuleError('unavailable', 'Overpass could not finish the query (' + clip(doc.remark, 100) + '); try a smaller area');
  let unnamed = 0, n = 0;
  for (const el of doc.elements) {
    if (n >= limit) break;
    if (!el || !['node', 'way', 'relation'].includes(el.type) || !Number.isInteger(el.id)) continue;
    const tags = el.tags && typeof el.tags === 'object' ? el.tags : {};
    const name = typeof tags.name === 'string' ? tags.name.trim() : '';
    if (!name) { unnamed++; continue; }
    const c = el.type === 'node' ? el : el.center;
    const lat = c && Number(c.lat), lon = c && Number(c.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const shown = {};
    for (const key of SHOW) if (typeof tags[key] === 'string') shown[key] = clip(tags[key], 60);
    if (ctx.emit({ type: 'place', value: clip(name, 300), confidence: 'likely', url: `https://www.openstreetmap.org/${el.type}/${el.id}`, raw: { kind: 'osm-feature', filter: `${filter.k}=${filter.v}`, osmType: el.type, osmId: el.id, lat, lon, tags: shown, attribution: meta.attribution }, dedupe: false })) n++;
  }
  if (unnamed) ctx.note(`${unnamed} unnamed feature(s) left out`);
  if (!doc.elements.length) ctx.note('no features of this kind in the area');
  else if (doc.elements.length >= limit * 2) ctx.note('the list was cut at the result cap: use a smaller area to see everything');
  ctx.note('map data is volunteer-made: a missing feature does not mean it does not exist');
  ctx.progress(1);
}
module.exports = { meta, run, buildQl, parseFilter };
