'use strict';
// QGIS launcher (separate program, GPL-2.0-or-later): opens a picked export of case data in the user's own QGIS. Nothing is embedded in
// Ghost and nothing is sent anywhere; QGIS keeps running on its own after the job ends.
const path = require('node:path');
const { ModuleError, clip } = require('./core');
const { sha256 } = require('./tool-common');
const fs = require('node:fs');

const EXTS = ['.geojson', '.json', '.gpkg', '.shp', '.kml', '.gpx', '.csv', '.tif', '.tiff'];
const meta = {
  id: 'qgis-open', tool: 'qgis', name: 'Open in QGIS', version: '1.0.0',
  description: 'Opens a picked export of case data (GeoJSON, GeoPackage, shapefile, KML, GPX, CSV, GeoTIFF) in QGIS on this computer.',
  capabilities: ['qgis', 'launcher', 'local'], scope: 'local', network: 'local', hosts: [], client: { maxRequests: 0 },
  program: 'QGIS', programNames: ['qgis', 'qgis-ltr'], heavy: false, separateProgram: true,
  restrictions: 'QGIS is a separate program under the GPL; it is opened on the exported file and is not part of Ghost. QGIS itself may reach the network if you add online layers: that is outside this connector. The file you pick is passed to QGIS unchanged.',
  licence: { spdx: 'GPL-2.0-or-later', url: 'https://www.qgis.org/en/site/about/license.html' },
  inputs: [{ name: 'file', type: 'file', label: 'Exported file', required: false, maxBytes: 1073741824 }, { name: 'check', type: 'enum', label: 'Self-check', required: false, values: ['version'] }],
  files: ['core.js', 'runtime.js', 'tool-run.js', 'tool-common.js'],
  selfTest: { input: { check: 'version' }, expect: { minResults: 1, contains: [{ type: 'document', value: 'QGIS available' }] } },
};
async function run(ctx, input) {
  const file = ctx.tools.find(meta.programNames);
  if (!file) throw new ModuleError('unavailable', "QGIS is not installed (not found in this connector's bin folder or on PATH)", { missingProgram: true });
  if (input.check === 'version') { ctx.emit({ type: 'document', value: 'QGIS available', raw: { selfCheck: true, program: path.basename(file), note: 'found; not started' } }); return; }
  if (!input.file) throw new ModuleError('bad-input', 'pick a file');
  if (!EXTS.includes(path.extname(input.file).toLowerCase())) throw new ModuleError('bad-input', `QGIS is opened on ${EXTS.join(' ')} files`);
  let st; try { st = fs.statSync(input.file); } catch { throw new ModuleError('bad-input', 'the file cannot be read'); }
  if (!st.isFile()) throw new ModuleError('bad-input', 'not a regular file');
  const hash = await sha256(input.file);
  const r = await ctx.tools.launch(file, ['--nologo', input.file]);
  if (!r.ok) throw new ModuleError('unavailable', 'QGIS could not be started: ' + r.error);
  ctx.emit({ type: 'document', value: clip(path.basename(input.file), 200), raw: { openedInQgis: true, size: st.size, sha256: hash } });
  ctx.note('QGIS was started and keeps running on its own');
}
module.exports = { meta, run, locate: (t) => t.find(meta.programNames) };
