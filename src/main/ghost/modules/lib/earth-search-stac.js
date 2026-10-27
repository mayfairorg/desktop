'use strict';
// Element 84 Earth Search: public STAC search of open satellite scenes (Sentinel-2 by default) by area, period and cloud cover. Lists
// scenes and thumbnail addresses only; nothing is downloaded.
const { ModuleError, clip, isoDate } = require('./core');
const K = require('./keyless-common');

const MAX_SPAN = 5;
const meta = {
  id: 'earth-search-stac', tool: 'earth-search-stac', name: 'Open satellite scene search (Earth Search)', version: '1.0.0',
  description: 'Finds open satellite scenes (Sentinel-2 by default) covering an area in a period, with acquisition time, cloud cover and a preview address.',
  capabilities: ['earth-observation', 'stac', 'sentinel', 'satellite', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['earth-search.aws.element84.com'], client: { rps: 2, maxRequests: 1, timeoutMs: 30000, maxBytes: 2097152 },
  restrictions: `Search only; no account or key. One request a run, at most 50 scenes, an area of at most ${MAX_SPAN} degrees on a side. Previews are listed as addresses, not downloaded. Sentinel data is free to use under the Copernicus licence; credit "Contains modified Copernicus Sentinel data". Element 84 runs the index as a free public service without a service guarantee.`,
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Scene index: Element 84 Earth Search. Sentinel data: Copernicus Sentinel data (ESA)',
  dataTerms: 'Sentinel-2 data: free, full and open under the Copernicus data and information policy; attribution required',
  inputs: [
    { name: 'bbox', type: 'string', label: 'Area: west,south,east,north', maxLength: 80, pattern: K.BBOX_PATTERN },
    { name: 'start', type: 'string', label: 'From (YYYY-MM-DD)', required: false, maxLength: 10, pattern: K.DATE_PATTERN },
    { name: 'end', type: 'string', label: 'To (YYYY-MM-DD)', required: false, maxLength: 10, pattern: K.DATE_PATTERN },
    { name: 'query', type: 'string', label: 'Collection (default sentinel-2-l2a)', required: false, maxLength: 40, pattern: '^[a-z0-9-]{3,40}$' },
    { name: 'maxCloud', type: 'integer', label: 'Most cloud cover (%)', required: false, min: 0, max: 100 },
    { name: 'limit', type: 'integer', label: 'Most scenes', required: false, min: 1, max: 50 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { bbox: '-0.5,51.3,0.3,51.7', start: '2024-06-01', end: '2024-06-30', limit: 3 }, expect: { minResults: 1 } },
};

async function run(ctx, input) {
  const box = K.parseBox(input.bbox, { maxSpan: MAX_SPAN });
  const start = K.parseDay(input.start), end = K.parseDay(input.end);
  if (start && end && end < start) throw new ModuleError('bad-input', 'the last date is before the first');
  const collection = input.query || 'sentinel-2-l2a';
  if (!/^[a-z0-9-]{3,40}$/.test(collection)) throw new ModuleError('bad-input', 'the collection name is not valid');
  const limit = K.intOr(input.limit, 20, 1, 50);
  const max = K.intOr(input.maxCloud, 100, 0, 100);
  const dt = start || end ? `&datetime=${encodeURIComponent((start ? start + 'T00:00:00Z' : '..') + '/' + (end ? end + 'T23:59:59Z' : '..'))}` : '';
  ctx.progress(0.2, 'asking Earth Search');
  const res = await ctx.client.get(`https://earth-search.aws.element84.com/v1/search?collections=${encodeURIComponent(collection)}&bbox=${box.text}&limit=${limit}${dt}`, { accept: 'application/geo+json, application/json', purpose: 'stac-search' });
  if (res.status === 404) throw new ModuleError('unavailable', 'the Earth Search service did not answer at this address');
  const doc = res.json();
  const feats = doc && Array.isArray(doc.features) ? doc.features : null;
  if (!feats) throw new ModuleError('bad-response', 'Earth Search answered in a shape that is not a STAC search result');
  let skipped = 0;
  for (const f of feats) {
    if (!f || typeof f.id !== 'string' || !/^[A-Za-z0-9_.-]{5,100}$/.test(f.id)) continue;
    const p = f.properties || {};
    const cloud = Number.isFinite(p['eo:cloud_cover']) ? p['eo:cloud_cover'] : undefined;
    if (cloud !== undefined && cloud > max) { skipped++; continue; }
    const th = f.assets && f.assets.thumbnail && typeof f.assets.thumbnail.href === 'string' && /^https:\/\/[^\s<>"'`\\]+$/.test(f.assets.thumbnail.href) ? f.assets.thumbnail.href : undefined;
    const col = typeof f.collection === 'string' && /^[a-z0-9-]{3,40}$/.test(f.collection) ? f.collection : collection;
    ctx.emit({ type: 'image', value: f.id, url: `https://earth-search.aws.element84.com/v1/collections/${col}/items/${f.id}`, raw: { kind: 'satellite-scene', collection: col, acquired: isoDate(p.datetime) || undefined, cloudCoverPercent: cloud, platform: p.platform ? clip(String(p.platform), 40) : undefined, bbox: Array.isArray(f.bbox) ? f.bbox.slice(0, 4) : undefined, thumbnail: th, attribution: meta.attribution } });
  }
  if (skipped) ctx.note(`${skipped} scene(s) above ${max}% cloud cover were left out`);
  if (!feats.length) ctx.note('no scenes match');
  ctx.note('cloud cover is the provider\'s estimate for the whole scene, not for your area');
  ctx.progress(1);
}
module.exports = { meta, run };
