'use strict';
// OpenStreetMap Nominatim: geocode a name or an address; reverse-geocode a coordinate to whatever OpenStreetMap holds there, house number
// and street included when it has them. One place per run (the public service forbids bulk use), at most one request a second.
const { ModuleError, clip } = require('./core');
const K = require('./keyless-common');

const meta = {
  id: 'nominatim', tool: 'osm-nominatim', name: 'Place search (OpenStreetMap)', version: '1.0.0',
  description: 'Finds the position of an organisation, site, landmark or address by text, or names what OpenStreetMap holds at a coordinate, with house number, street and postcode when the data has them.',
  capabilities: ['geocode', 'reverse-geocode', 'osm', 'places', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['nominatim.openstreetmap.org'], client: { rps: 1, maxRequests: 1, timeoutMs: 20000, maxBytes: 262144 },
  restrictions: 'The public Nominatim service allows at most one request a second, one place at a time (no bulk or batch use), a proper User-Agent and caching of results. This connector sends one request a run. Results are whatever OpenStreetMap holds, house-level results included; the Ghost Terms and the law that applies to you govern what you do with them. Credit OpenStreetMap contributors.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
  dataTerms: 'OpenStreetMap data is under the Open Database Licence (ODbL) 1.0; attribution "© OpenStreetMap contributors" is required wherever results are shown or exported',
  inputs: [
    { name: 'kind', type: 'enum', label: 'Do', values: ['geocode', 'reverse'] },
    { name: 'query', type: 'string', label: 'Place name, or "latitude,longitude" for reverse', minLength: 2, maxLength: 150 },
    { name: 'limit', type: 'integer', label: 'Most results (place search)', required: false, min: 1, max: 5 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { kind: 'geocode', query: 'Eiffel Tower, Paris', limit: 1 }, expect: { minResults: 1 } },
};

// a name that is only the house number (OpenStreetMap sometimes does that) is not a name
const placeName = (it) => { const n = typeof it.name === 'string' ? it.name.trim() : ''; return /^\d+[a-z]?$/i.test(n) ? '' : n; };
const loc = (a) => { a = a || {}; return a.city || a.town || a.village || a.hamlet || a.suburb || a.county || a.state; };

async function run(ctx, input) {
  const q = String(input.query || '').trim();
  if (/[\r\n]/.test(q) || /;/.test(q)) throw new ModuleError('bad-input', 'one place per run: the public service does not allow bulk or batch lookups');
  K.refuseContactShape(q.replace(/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/, 'ok'));
  if (input.kind === 'geocode') {
    const limit = K.intOr(input.limit, 3, 1, 5);
    ctx.progress(0.2, 'asking Nominatim');
    const res = await ctx.client.get(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&addressdetails=1&limit=${limit}&dedupe=1`, { purpose: 'nominatim-search' });
    const items = res.status === 404 ? [] : res.json();
    if (!Array.isArray(items)) throw new ModuleError('bad-response', 'Nominatim answered in a shape that is not a result list');
    if (!items.length) { ctx.note('no place matches'); return; }
    for (const it of items.slice(0, limit)) {
      const lat = Number(it.lat), lon = Number(it.lon);
      if (!it || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
      const name = placeName(it);
      const a = it.address || {};
      const street = [a.house_number, a.road].filter(Boolean).join(' ');
      const head = name || street || (typeof it.display_name === 'string' ? it.display_name.split(',')[0].trim() : '');
      if (!head) continue;
      const where = [head, name && street ? street : '', a.postcode, loc(a), a.country].filter((x, i, arr) => x && arr.indexOf(x) === i).join(', ');
      ctx.emit({
        type: 'place', value: clip(where, 300), confidence: 'likely', url: it.osm_type && it.osm_id ? `https://www.openstreetmap.org/${/^(node|way|relation)$/.test(it.osm_type) ? it.osm_type : 'node'}/${Number(it.osm_id)}` : undefined,
        raw: { kind: 'geocode', lat, lon, osmType: it.osm_type, osmId: it.osm_id, category: it.category, type: it.type, addresstype: it.addresstype, houseNumber: a.house_number, road: a.road, postcode: a.postcode, importance: Number.isFinite(it.importance) ? it.importance : undefined, boundingbox: Array.isArray(it.boundingbox) ? it.boundingbox.slice(0, 4).map(Number) : undefined, attribution: meta.attribution },
      });
    }
    ctx.note('results are ordered by Nominatim\'s relevance; the first is a best guess, not a verified match');
  } else if (input.kind === 'reverse') {
    const m = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(q);
    if (!m) throw new ModuleError('bad-input', 'for reverse lookup enter "latitude,longitude", for example 51.5007,-0.1246');
    const lat = Number(m[1]), lon = Number(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new ModuleError('bad-input', 'latitude must be within 90 and longitude within 180 degrees');
    ctx.progress(0.2, 'asking Nominatim');
    // zoom 18 asks for the building: a house number and street come back when OpenStreetMap has them
    const res = await ctx.client.get(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=jsonv2&zoom=18&addressdetails=1`, { purpose: 'nominatim-reverse' });
    const it = res.status === 404 ? null : res.json();
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new ModuleError('bad-response', 'Nominatim answered in a shape that is not a place');
    if (it.error) { ctx.note('no place is known at this position'); return; }
    const a = it.address || {};
    const street = [a.house_number, a.road].filter(Boolean).join(' ');
    const named = placeName(it);
    const where = [named || street || a.suburb || a.neighbourhood || a.quarter, named && street ? street : '', a.postcode, loc(a), a.country].filter((x, i, arr) => x && arr.indexOf(x) === i).join(', ');
    if (!where) { ctx.note('no named place is known at this position'); return; }
    ctx.emit({ type: 'place', value: clip(where, 300), confidence: 'likely', raw: { kind: 'reverse-geocode', queryLat: lat, queryLon: lon, level: it.addresstype || 'address', houseNumber: a.house_number, road: a.road, postcode: a.postcode, country: a.country, countryCode: a.country_code, osmType: it.osm_type, osmId: it.osm_id, category: it.category, type: it.type, attribution: meta.attribution } });
    ctx.note('reverse lookup returns what OpenStreetMap holds at this position, down to house number and street where it has them');
  } else throw new ModuleError('bad-input', 'kind must be geocode or reverse');
  ctx.progress(1);
}
module.exports = { meta, run };
