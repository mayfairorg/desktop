'use strict';
// NASA Earthdata public search (CMR): find datasets and data files (granules) for a place and time. Search only: downloading files needs a
// free Earthdata login, which Ghost does not handle. If the service asks for a login the connector says "unavailable" and why.
const { ModuleError, clip, isoDate } = require('./core');

const meta = {
  id: 'nasa-cmr', tool: 'nasa-cmr-search', name: 'NASA Earthdata search', version: '1.0.0',
  description: 'Searches NASA\'s public Common Metadata Repository for earth-observation datasets by keyword, or for the data files of one dataset over a place and period.',
  capabilities: ['earth-observation', 'nasa', 'satellite', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['cmr.earthdata.nasa.gov'], client: { rps: 2, maxRequests: 2, timeoutMs: 30000, maxBytes: 2097152 },
  restrictions: 'Search only; no account is used. Downloading data files needs a free NASA Earthdata login, which this connector does not use. NASA\'s service has fair-use limits: at most two requests per second. Data and metadata are free to use under NASA\'s data policy; credit NASA.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'NASA Earthdata open data policy',
  inputs: [
    { name: 'kind', type: 'enum', label: 'Search for', values: ['collections', 'granules'] },
    { name: 'query', type: 'string', label: 'Keyword (datasets) or dataset short name (files)', minLength: 2, maxLength: 120, pattern: "^[A-Za-z0-9 ._:/()+-]+$" },
    { name: 'bbox', type: 'string', label: 'Area: west,south,east,north', required: false, maxLength: 80, pattern: '^-?[0-9]+(\\.[0-9]+)?(,-?[0-9]+(\\.[0-9]+)?){3}$' },
    { name: 'start', type: 'string', label: 'From (YYYY-MM-DD)', required: false, maxLength: 10, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    { name: 'end', type: 'string', label: 'To (YYYY-MM-DD)', required: false, maxLength: 10, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' },
    { name: 'limit', type: 'integer', label: 'Most results', required: false, min: 1, max: 50 },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { kind: 'collections', query: 'MODIS', limit: 3 }, expect: { minResults: 1 } },
};
function checkBox(b) {
  if (!b) return null;
  const [w, s, e, n] = b.split(',').map(Number);
  if (![w, s, e, n].every(Number.isFinite) || w < -180 || e > 180 || s < -90 || n > 90 || s >= n || w >= e) throw new ModuleError('bad-input', 'the area must be west,south,east,north in degrees with west < east and south < north');
  return `${w},${s},${e},${n}`;
}
const day = (d, end) => { if (!d) return ''; if (!isoDate(d + 'T00:00:00Z')) throw new ModuleError('bad-input', 'dates must be real calendar dates'); return d + (end ? 'T23:59:59Z' : 'T00:00:00Z'); };

async function run(ctx, input) {
  const limit = Number.isInteger(+input.limit) && +input.limit > 0 ? Math.min(+input.limit, 50) : 20;
  const box = checkBox(input.bbox);
  const base = 'https://cmr.earthdata.nasa.gov/search/';
  ctx.progress(0.2, 'asking NASA');
  if (input.kind === 'collections') {
    const res = await ctx.client.get(`${base}collections.json?keyword=${encodeURIComponent(input.query)}&page_size=${limit}${box ? '&bounding_box=' + box : ''}`, { purpose: 'cmr-collections' });
    const feed = res.status === 404 ? null : res.json().feed;
    const ents = feed && Array.isArray(feed.entry) ? feed.entry : [];
    if (!ents.length) { ctx.note('no datasets match'); return; }
    for (const e of ents) {
      if (!e || typeof e.id !== 'string' || !/^C[0-9A-Za-z_-]+$/.test(e.id)) continue;
      ctx.emit({ type: 'document', value: clip(e.title || e.short_name || e.id, 300), url: `https://cmr.earthdata.nasa.gov/search/concepts/${e.id}.html`, raw: { kind: 'dataset', conceptId: e.id, shortName: e.short_name, version: e.version_id, dataCenter: e.data_center, timeStart: isoDate(e.time_start) || undefined, timeEnd: isoDate(e.time_end) || undefined, summary: e.summary ? clip(e.summary, 400) : undefined } });
    }
  } else if (input.kind === 'granules') {
    const t = input.start || input.end ? `&temporal=${encodeURIComponent(day(input.start, false) + ',' + day(input.end, true))}` : '';
    const res = await ctx.client.get(`${base}granules.json?short_name=${encodeURIComponent(input.query)}&page_size=${limit}${box ? '&bounding_box=' + box : ''}${t}`, { purpose: 'cmr-granules' });
    const feed = res.status === 404 ? null : res.json().feed;
    const ents = feed && Array.isArray(feed.entry) ? feed.entry : [];
    if (!ents.length) { ctx.note('no data files match'); return; }
    for (const e of ents) {
      if (!e || typeof e.id !== 'string' || !/^G[0-9A-Za-z_-]+$/.test(e.id)) continue;
      const links = Array.isArray(e.links) ? e.links : [];
      const browse = links.find((l) => l && /browse#$/.test(l.rel || '') && typeof l.href === 'string' && /^https:\/\//.test(l.href));
      ctx.emit({ type: 'document', value: clip(e.title || e.producer_granule_id || e.id, 300), url: `https://cmr.earthdata.nasa.gov/search/concepts/${e.id}.html`, raw: { kind: 'granule', conceptId: e.id, collectionId: e.collection_concept_id, timeStart: isoDate(e.time_start) || undefined, timeEnd: isoDate(e.time_end) || undefined, dataCenter: e.data_center, browseImage: browse ? browse.href : undefined, downloadNeedsLogin: true } });
    }
    ctx.note('downloading these files needs a free NASA Earthdata login, which Ghost does not use');
  } else throw new ModuleError('bad-input', 'kind must be collections or granules');
  ctx.progress(1);
}
module.exports = { meta, run };
