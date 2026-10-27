'use strict';
// NASA GIBS (Global Imagery Browse Services): build the web-map tile addresses for a layer, date and area, list the dates a daily layer
// nominally has imagery for, and (probe) confirm that a date really has imagery by fetching one small overview tile. No bulk downloads:
// at most 16 tile addresses are built per run and at most 2 tiles fetched.
const { ModuleError } = require('./core');
const K = require('./keyless-common');

// Hand-kept layer table (GIBS layer catalogue). `from` is the first day of the layer's record; check a date with the probe mode.
const LAYERS = {
  MODIS_Terra_CorrectedReflectance_TrueColor: { title: 'MODIS Terra true colour', from: '2000-02-24', set: 'GoogleMapsCompatible_Level9', ext: 'jpg', zoom: 9 },
  MODIS_Aqua_CorrectedReflectance_TrueColor: { title: 'MODIS Aqua true colour', from: '2002-07-04', set: 'GoogleMapsCompatible_Level9', ext: 'jpg', zoom: 9 },
  VIIRS_SNPP_CorrectedReflectance_TrueColor: { title: 'VIIRS Suomi NPP true colour', from: '2015-11-24', set: 'GoogleMapsCompatible_Level9', ext: 'jpg', zoom: 9 },
  VIIRS_NOAA20_CorrectedReflectance_TrueColor: { title: 'VIIRS NOAA-20 true colour', from: '2018-01-01', set: 'GoogleMapsCompatible_Level9', ext: 'jpg', zoom: 9 },
  VIIRS_SNPP_DayNightBand_ENCC: { title: 'VIIRS Suomi NPP day/night band (night lights)', from: '2012-01-19', set: 'GoogleMapsCompatible_Level8', ext: 'png', zoom: 8 },
};
const MAX_TILES = 16, MAX_DATES = 100, MAX_RANGE_DAYS = 366;
const meta = {
  id: 'nasa-gibs', tool: 'nasa-gibs-wmts', name: 'NASA satellite imagery tiles (GIBS)', version: '1.0.0',
  description: 'Builds viewable map-tile addresses of NASA daily satellite imagery for a place and date, lists the dates a layer covers, and checks that a date has imagery.',
  capabilities: ['earth-observation', 'nasa', 'gibs', 'satellite', 'imagery', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['gibs.earthdata.nasa.gov'], client: { rps: 2, maxRequests: 2, timeoutMs: 20000, maxBytes: 1048576 },
  restrictions: `NASA asks for fair use. Tile addresses are built here without a request; the probe mode fetches at most 2 small tiles (a run never downloads imagery in bulk). At most ${MAX_TILES} tile addresses per run. Imagery is free to use; credit "NASA EOSDIS GIBS". A tile can exist for a date and still be blank where the satellite did not pass.`,
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Imagery courtesy of NASA EOSDIS Global Imagery Browse Services (GIBS)',
  dataTerms: 'NASA open data policy: free to use; acknowledge NASA EOSDIS GIBS',
  inputs: [
    { name: 'query', type: 'enum', label: 'Layer', values: Object.keys(LAYERS) },
    { name: 'mode', type: 'enum', label: 'Do', values: ['tiles', 'dates', 'probe'] },
    { name: 'start', type: 'string', label: 'Date, or first date (YYYY-MM-DD)', maxLength: 10, pattern: K.DATE_PATTERN },
    { name: 'end', type: 'string', label: 'Last date (YYYY-MM-DD)', required: false, maxLength: 10, pattern: K.DATE_PATTERN },
    { name: 'bbox', type: 'string', label: 'Area: west,south,east,north', required: false, maxLength: 80, pattern: K.BBOX_PATTERN },
    { name: 'max', type: 'integer', label: 'Zoom level (tiles)', required: false, min: 0, max: 9 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { query: 'MODIS_Terra_CorrectedReflectance_TrueColor', mode: 'probe', start: '2024-06-15' }, expect: { minResults: 1 } },
};

const MERC = 85.0511287798;
const tileX = (lon, z) => Math.min(2 ** z - 1, Math.max(0, Math.floor((lon + 180) / 360 * 2 ** z)));
const tileY = (lat, z) => { const l = Math.max(-MERC, Math.min(MERC, lat)) * Math.PI / 180; return Math.min(2 ** z - 1, Math.max(0, Math.floor((1 - Math.log(Math.tan(l) + 1 / Math.cos(l)) / Math.PI) / 2 * 2 ** z))); };
function tileUrl(layerId, date, z, x, y) {
  const L = LAYERS[layerId];
  if (!L || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ModuleError('bad-input', 'unknown layer or date');
  return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layerId}/default/${date}/${L.set}/${z}/${y}/${x}.${L.ext}`;
}
function tileRange(box, z) {
  const x0 = tileX(box.w, z), x1 = tileX(box.e, z), y0 = tileY(box.n, z), y1 = tileY(box.s, z);
  return { x0, x1, y0, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
}
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

async function run(ctx, input) {
  const L = LAYERS[input.query];
  if (!L) throw new ModuleError('bad-input', 'choose one of the listed layers');
  const start = K.parseDay(input.start), end = K.parseDay(input.end) || start;
  if (!start) throw new ModuleError('bad-input', 'enter a date');
  if (end < start) throw new ModuleError('bad-input', 'the last date is before the first');
  if (Date.parse(end) - Date.parse(start) > MAX_RANGE_DAYS * 86400000) throw new ModuleError('bad-input', `at most ${MAX_RANGE_DAYS} days at a time`);
  if (start < L.from) throw new ModuleError('bad-input', `${L.title} starts on ${L.from}`);
  if (start > today()) throw new ModuleError('bad-input', 'that date is in the future');
  const mode = input.mode || 'tiles';
  const finalDay = end > today() ? today() : end;
  if (mode === 'dates') {
    let n = 0;
    for (let d = start; d <= finalDay && n < MAX_DATES; d = addDays(d, 1), n++) {
      ctx.emit({ type: 'event', value: `${L.title}: daily imagery nominally published for ${d}`, confidence: 'likely', url: tileUrl(input.query, d, 0, 0, 0), raw: { kind: 'gibs-date', layer: input.query, date: d, period: 'daily', attribution: meta.attribution } });
    }
    if (finalDay > addDays(start, MAX_DATES - 1)) ctx.note(`the list stops at ${MAX_DATES} dates`);
    ctx.note('these dates come from the layer\'s published daily schedule; use the probe mode to confirm a date really has imagery (recent days can lag by a few hours)');
  } else if (mode === 'tiles') {
    const z = K.intOr(input.max, Math.min(L.zoom, 5), 0, L.zoom);
    const box = input.bbox ? K.parseBox(input.bbox) : { w: -180, s: -85, e: 180, n: 85, text: 'world' };
    const r = tileRange(box, z);
    if (r.count > MAX_TILES) throw new ModuleError('bad-input', `that area at zoom ${z} needs ${r.count} tiles (at most ${MAX_TILES}); draw a smaller area or lower the zoom`);
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
      ctx.emit({ type: 'url', value: tileUrl(input.query, start, z, x, y), confidence: 'likely', raw: { kind: 'map-tile', layer: input.query, date: start, zoom: z, x, y, tileMatrixSet: L.set, attribution: meta.attribution } });
    }
    ctx.note('tile addresses are built from the published layout and were not fetched: open one to view the imagery, or use the probe mode to check a date');
  } else if (mode === 'probe') {
    const box = input.bbox ? K.parseBox(input.bbox) : null;
    const z = box ? Math.min(2, L.zoom) : 0;
    const cx = box ? tileX((box.w + box.e) / 2, z) : 0, cy = box ? tileY((box.s + box.n) / 2, z) : 0;
    const dates = [...new Set([start, finalDay])].slice(0, 2);
    let missing = 0;
    for (const d of dates) {
      ctx.progress(0.2, 'checking ' + d);
      const res = await ctx.client.get(tileUrl(input.query, d, z, cx, cy), { accept: 'image/*', purpose: 'gibs-probe' });
      if (res.status === 404) { missing++; ctx.note(`no imagery tile found for ${d}`); continue; }
      ctx.emit({ type: 'event', value: `${L.title}: imagery tile found for ${d}`, confidence: 'confirmed', url: res.url, raw: { kind: 'gibs-probe', layer: input.query, date: d, zoom: z, x: cx, y: cy, attribution: meta.attribution } });
    }
    if (missing === dates.length) ctx.note('no imagery was found for the dates asked');
    ctx.note('a tile that exists can still be blank where the satellite did not pass that day');
  } else throw new ModuleError('bad-input', 'mode must be tiles, dates or probe');
  ctx.progress(1);
}
module.exports = { meta, run, tileUrl, tileRange, LAYERS };
