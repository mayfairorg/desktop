'use strict';
// USGS Landsat scene search over a place and period, through USGS's public LandsatLook STAC service. USGS EarthExplorer's own search and its
// machine interface need a login; this connector does not log in. If the public service starts asking for one it reports "unavailable" and why.
const { ModuleError, clip, isoDate } = require('./core');

const meta = {
  id: 'usgs-landsat', tool: 'landsatlook-stac', name: 'USGS Landsat scene search', version: '1.0.0',
  description: 'Finds Landsat scenes (acquisition time, cloud cover, satellite) covering an area in a period, from USGS\'s public LandsatLook search.',
  capabilities: ['earth-observation', 'usgs', 'landsat', 'satellite', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['landsatlook.usgs.gov'], client: { rps: 2, maxRequests: 1, timeoutMs: 30000, maxBytes: 2097152 },
  restrictions: 'Search only; no account is used. EarthExplorer itself and downloads from USGS need a free login, which this connector does not use. Landsat data is public domain; credit the U.S. Geological Survey. At most two requests per second.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'Landsat data: U.S. Government public domain',
  inputs: [
    { name: 'bbox', type: 'string', label: 'Area: west,south,east,north', maxLength: 80, pattern: '^-?[0-9]+(\\.[0-9]+)?(,-?[0-9]+(\\.[0-9]+)?){3}$' },
    { name: 'start', type: 'string', label: 'From (YYYY-MM-DD)', required: false, maxLength: 10, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    { name: 'end', type: 'string', label: 'To (YYYY-MM-DD)', required: false, maxLength: 10, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    { name: 'maxCloud', type: 'integer', label: 'Most cloud cover (%)', required: false, min: 0, max: 100 },
    { name: 'limit', type: 'integer', label: 'Most scenes', required: false, min: 1, max: 50 },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { bbox: '-0.5,51.3,0.3,51.7', start: '2024-06-01', end: '2024-06-30', limit: 3 }, expect: { minResults: 1 } },
};
async function run(ctx, input) {
  const [w, s, e, n] = String(input.bbox || '').split(',').map(Number);
  if (![w, s, e, n].every(Number.isFinite) || w < -180 || e > 180 || s < -90 || n > 90 || s >= n || w >= e) throw new ModuleError('bad-input', 'the area must be west,south,east,north in degrees with west < east and south < north');
  for (const d of [input.start, input.end]) if (d && !isoDate(d + 'T00:00:00Z')) throw new ModuleError('bad-input', 'dates must be real calendar dates');
  const limit = Number.isInteger(+input.limit) && +input.limit > 0 ? Math.min(+input.limit, 50) : 20;
  const dt = input.start || input.end ? `&datetime=${encodeURIComponent((input.start ? input.start + 'T00:00:00Z' : '..') + '/' + (input.end ? input.end + 'T23:59:59Z' : '..'))}` : '';
  ctx.progress(0.2, 'asking USGS');
  const res = await ctx.client.get(`https://landsatlook.usgs.gov/stac-server/search?collections=landsat-c2l2-sr&bbox=${[w, s, e, n].join(',')}&limit=${limit}${dt}`, { accept: 'application/geo+json, application/json', purpose: 'stac-search' });
  if (res.status === 404) throw new ModuleError('unavailable', 'the USGS search service did not answer at this address');
  const doc = res.json();
  const feats = doc && Array.isArray(doc.features) ? doc.features : null;
  if (!feats) throw new ModuleError('bad-response', 'USGS answered in a shape that is not a STAC search result');
  const max = Number.isInteger(+input.maxCloud) ? +input.maxCloud : 100;
  let skipped = 0;
  for (const f of feats) {
    if (!f || typeof f.id !== 'string' || !/^[A-Za-z0-9_.-]{5,80}$/.test(f.id)) continue;
    const p = f.properties || {};
    const cloud = Number.isFinite(p['eo:cloud_cover']) ? p['eo:cloud_cover'] : undefined;
    if (cloud !== undefined && cloud > max) { skipped++; continue; }
    ctx.emit({ type: 'image', value: f.id, url: `https://landsatlook.usgs.gov/stac-server/collections/landsat-c2l2-sr/items/${f.id}`, raw: { kind: 'satellite-scene', acquired: isoDate(p.datetime) || undefined, cloudCoverPercent: cloud, platform: p.platform ? clip(String(p.platform), 40) : undefined, bbox: Array.isArray(f.bbox) ? f.bbox.slice(0, 4) : undefined, downloadNeedsLogin: true } });
  }
  if (skipped) ctx.note(`${skipped} scene(s) above ${max}% cloud cover were left out`);
  if (!feats.length) ctx.note('no scenes match');
  ctx.note('downloading scenes needs a free USGS login, which Ghost does not use');
  ctx.progress(1);
}
module.exports = { meta, run };
