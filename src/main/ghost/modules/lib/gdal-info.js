'use strict';
// GDAL (separate program, MIT): facts about a picked geospatial raster: size, bands, coordinate system, geographic footprint.
const { toolModule } = require('./tool-common');
const { ModuleError, clip } = require('./core');

function parse(ctx, stdout, info) {
  let d;
  try { d = JSON.parse(stdout); } catch { throw new ModuleError('bad-response', 'gdalinfo did not return JSON'); }
  if (!d || typeof d !== 'object' || !Array.isArray(d.size)) throw new ModuleError('bad-response', 'gdalinfo returned no raster description');
  const wkt = d.coordinateSystem && d.coordinateSystem.wkt;
  const crs = typeof wkt === 'string' ? ((/^(?:PROJCRS|GEOGCRS|PROJCS|GEOGCS)\["([^"]{1,120})"/.exec(wkt) || [])[1] || null) : null;
  ctx.emit({ type: 'document', value: clip(info.name, 200), raw: { kind: 'geospatial-raster', driver: d.driverShortName, width: d.size[0], height: d.size[1], bands: Array.isArray(d.bands) ? d.bands.length : undefined, crs: crs || undefined, size: info.size, sha256: info.sha256 } });
  const ring = d.wgs84Extent && d.wgs84Extent.type === 'Polygon' && Array.isArray(d.wgs84Extent.coordinates) ? d.wgs84Extent.coordinates[0] : null;
  const pts = Array.isArray(ring) ? ring.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90) : [];
  if (pts.length >= 3) {
    const lons = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
    const c = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2].map((x) => Math.round(x * 1e6) / 1e6);
    ctx.emit({ type: 'place', value: `${c[1]},${c[0]}`, confidence: 'likely', raw: { rel: 'dataset-centre', of: info.name, west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats), note: 'centre of the dataset footprint, not a feature in it' } });
  } else ctx.note('the file has no geographic footprint (no usable coordinate system)');
}
module.exports = toolModule({
  id: 'gdal-info', name: 'Geospatial raster info (GDAL)', program: 'GDAL', programs: ['gdalinfo'], capabilities: ['geospatial', 'raster', 'passive'], timeoutMs: 60000,
  description: 'Size, bands, coordinate system and geographic footprint of a picked GeoTIFF or other raster, read with GDAL\'s gdalinfo.',
  licence: { spdx: 'MIT', url: 'https://gdal.org/license.html' }, versionArgs: ['--version'],
  restrictions: 'Describes a data file only. The footprint centre is a summary of the whole dataset, not a position of anything in it.',
  exts: ['.tif', '.tiff', '.jp2', '.img', '.vrt', '.nc', '.png', '.jpg', '.jpeg'],
  argv: (ctx, input, file) => ['-json', '-nomd', file], parse,
});
module.exports.parse = parse;
