'use strict';
// ExifTool (separate program, Artistic-2.0 or GPL-1.0-or-later): wide metadata coverage for files the user picks. Local only.
const { toolModule, isPersonalTag } = require('./tool-common');
const X = require('./exif-parse');
const { clip, isoDate } = require('./core');

const KEEP = new Set(['Make', 'Model', 'Software', 'LensModel', 'FileType', 'MIMEType', 'ImageWidth', 'ImageHeight', 'Orientation', 'Producer', 'CreatorTool', 'PDFVersion', 'PageCount', 'Duration', 'Encoder']);
const base = (k) => k.replace(/^[^:]*:/, '');
const camel = (n) => (/^[A-Z]{2,}(?=[A-Z][a-z])/.test(n) ? n.replace(/^[A-Z]+(?=[A-Z][a-z])/, (m) => m.toLowerCase()) : n.charAt(0).toLowerCase() + n.slice(1));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function parse(ctx, stdout, info) {
  let arr;
  try { arr = JSON.parse(stdout); } catch { throw new (require('./core').ModuleError)('bad-response', 'ExifTool did not return JSON'); }
  const t = Array.isArray(arr) && arr[0] && typeof arr[0] === 'object' ? arr[0] : null;
  if (!t) throw new (require('./core').ModuleError)('bad-response', 'ExifTool returned no record');
  const get = (...names) => { for (const n of names) for (const k of Object.keys(t)) if (k === n || base(k) === n) return t[k]; return undefined; };
  const raw = { size: info.size, sha256: info.sha256 }, withheld = [];
  for (const [k, v] of Object.entries(t)) {
    if (k === 'SourceFile' || /^ExifTool:/.test(k)) continue;
    if (isPersonalTag(base(k))) { withheld.push(base(k)); continue; }
    if (KEEP.has(base(k)) && (typeof v === 'string' || typeof v === 'number')) raw[camel(base(k))] = typeof v === 'string' ? clip(v, 120) : v;
  }
  if (withheld.length) raw.personalFieldsWithheld = [...new Set(withheld)].slice(0, 20);
  const mime = String(get('MIMEType') || '');
  ctx.emit({ type: /^image\//.test(mime) ? 'image' : 'document', value: clip(info.name, 200), raw });
  const off = get('OffsetTimeOriginal');
  for (const [kind, v, zone] of [['capture', get('DateTimeOriginal'), off], ['created', get('CreateDate'), off], ['modified', get('ModifyDate'), null]]) {
    const d = typeof v === 'string' ? X.exifDate(v.replace(/[+-]\d{2}:\d{2}$|Z$/, ''), zone || (/[+-]\d{2}:\d{2}$/.test(v) ? v.slice(-6) : null)) : null;
    if (d) ctx.emit({ type: 'event', value: `${kind} time of ${clip(info.name, 120)}: ${d.local.replace('T', ' ')}${d.zone ? ' (' + d.zone + ')' : ''}`, raw: { kind, t: d.t, zoneStated: !!d.zone, of: info.name } });
  }
  const lat = num(get('Composite:GPSLatitude')), lon = num(get('Composite:GPSLongitude'));
  if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    const alt = num(get('Composite:GPSAltitude'));
    ctx.emit({ type: 'place', value: `${Math.round(lat * 1e6) / 1e6},${Math.round(lon * 1e6) / 1e6}`, confidence: 'likely', raw: { rel: 'embedded-gps', of: info.name, ...(alt !== null ? { altitudeM: alt } : {}), note: 'position recorded in the file; it can be wrong, edited or copied from another file' } });
  }
  if (withheld.length) ctx.note(`personal fields withheld: ${[...new Set(withheld)].slice(0, 20).join(', ')}`);
  void isoDate;
}
module.exports = toolModule({
  id: 'exiftool', name: 'ExifTool metadata', program: 'ExifTool', programs: ['exiftool'], capabilities: ['file-metadata', 'exif', 'gps', 'passive'],
  description: 'Reads the metadata of a picked file with ExifTool: camera and software, times, embedded GPS, document properties, for many more formats than the built-in reader.',
  licence: { spdx: 'Artistic-2.0 OR GPL-1.0-or-later', url: 'https://exiftool.org/#license' }, versionArgs: ['-ver'], files: ['exif-parse.js'],
  restrictions: 'Metadata can be edited or stripped: it is evidence about the file, not proof about the scene. Names of authors and owners and device serial numbers are withheld. Embedded GPS can reveal where a person lives or was; respect the rights of the person in a picture.',
  argv: (ctx, input, file) => ['-json', '-G1', '-a', '-n', '-fast2', '-api', 'largefilesupport=1', '--', file], parse, timeoutMs: 60000,
});
module.exports.parse = parse;
