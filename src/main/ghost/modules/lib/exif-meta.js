'use strict';
// File metadata (EXIF, GPS, PNG text, PDF info) from a file the user picked. Local only: the file never leaves the computer and this
// module makes no network request. Personal fields (author, owner, serial numbers, copyright holder) are never reported, only their names.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModuleError, clip } = require('./core');
const X = require('./exif-parse');

const meta = {
  id: 'exif-meta', tool: 'mayfair-metadata-reader', name: 'File metadata', version: '1.0.0',
  description: 'Reads the metadata inside a picked image or PDF: camera and software, capture and edit times, embedded GPS position, dimensions, a SHA-256 hash. Runs entirely on this computer.',
  capabilities: ['file-metadata', 'exif', 'gps', 'hash', 'passive', 'local'], scope: 'local', network: 'local',
  hosts: [], client: { maxRequests: 0 },
  restrictions: 'None for the service: nothing is sent anywhere. Covers JPEG, TIFF, PNG and PDF. Metadata can be edited or stripped, so a value is evidence about the file, not proof about the scene. Names of authors and owners and device serial numbers are withheld. Embedded GPS can reveal where a person lives or was: use it for organisations, sites and events, and respect the rights of the person in a picture.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'Local processing; no third-party data',
  inputs: [
    { name: 'file', type: 'file', label: 'File', required: false, maxBytes: 104857600 },
    { name: 'check', type: 'enum', label: 'Self-check', required: false, values: ['parser'] },
  ],
  files: ['core.js', 'runtime.js', 'exif-parse.js'],
  selfTest: { input: { check: 'parser' }, expect: { minResults: 1, contains: [{ type: 'image', value: 'self-check-sample' }] } },
};
const READ_MAX = 32 * 1024 * 1024;
const PERSONAL = { Artist: 'Artist', Copyright: 'Copyright', CameraOwnerName: 'CameraOwnerName', BodySerialNumber: 'BodySerialNumber', LensSerialNumber: 'LensSerialNumber', Author: 'Author' };

const SAMPLE = { make: 'Selfcheck', model: 'Parser', software: 'built-in sample', dateOriginal: '2001:02:03 04:05:06', offsetOriginal: '+00:00', artist: 'withheld-sample-name', lat: 10.5, lon: -20.25, width: 8, height: 6 };

function report(ctx, buf, { name, size, sha256 }) {
  const p = X.parse(buf);
  if (!p) throw new ModuleError('bad-input', 'unsupported file type (this module reads JPEG, TIFF, PNG and PDF); the optional ExifTool connector covers more formats');
  const isPdf = p.format === 'pdf';
  const t = p.tiff || { ifd0: {}, exif: {}, gps: {} };
  const withheld = [];
  const conf = isPdf ? 'likely' : 'confirmed';
  for (const k of Object.keys(PERSONAL)) { if (t.ifd0[k] || t.exif[k] || (p.info && p.info[k]) || (p.text && p.text[k])) withheld.push(k); }
  const raw = { format: p.format, size, sha256, ...(p.width ? { width: p.width, height: p.height } : {}), ...(p.tiff ? { make: t.ifd0.Make, model: t.ifd0.Model, lens: t.exif.LensModel, software: t.ifd0.Software, orientation: t.ifd0.Orientation } : {}), ...(p.xmp ? { xmpPresent: true } : {}), ...(isPdf ? { pdfVersion: p.version, encrypted: p.encrypted || undefined, title: p.info.Title ? clip(p.info.Title, 120) : undefined, creator: p.info.Creator ? clip(p.info.Creator, 120) : undefined, producer: p.info.Producer ? clip(p.info.Producer, 120) : undefined } : {}), ...(p.text ? { textChunks: Object.keys(p.text).slice(0, 20), software: p.text.Software ? clip(p.text.Software, 120) : undefined } : {}), personalFieldsWithheld: withheld.length ? withheld : undefined };
  const label = clip(name, 200);
  ctx.emit({ type: isPdf ? 'document' : 'image', value: label, confidence: 'confirmed', raw });
  const times = [];
  if (t.exif.DateTimeOriginal) times.push(['capture', X.exifDate(t.exif.DateTimeOriginal, t.exif.OffsetTimeOriginal)]);
  if (t.exif.DateTimeDigitized) times.push(['digitised', X.exifDate(t.exif.DateTimeDigitized, t.exif.OffsetTimeOriginal)]);
  if (t.ifd0.DateTime) times.push(['file-modified-in-camera-or-editor', X.exifDate(t.ifd0.DateTime, null)]);
  if (p.time) times.push(['png-last-modified', { local: p.time, zone: 'Z', t: p.time }]);
  if (p.text && p.text['Creation Time']) { const d = Date.parse(p.text['Creation Time']); if (!Number.isNaN(d)) times.push(['png-creation', { local: p.text['Creation Time'], zone: null, t: new Date(d).toISOString() }]); }
  if (isPdf) { if (p.info.CreationDate) times.push(['pdf-created', X.pdfDate(p.info.CreationDate)]); if (p.info.ModDate) times.push(['pdf-modified', X.pdfDate(p.info.ModDate)]); }
  for (const [kind, d] of times) {
    if (!d) continue;
    ctx.emit({ type: 'event', value: `${kind} time of ${label}: ${d.local.replace('T', ' ')}${d.zone ? ' (' + d.zone + ')' : ''}`, confidence: conf, raw: { kind, t: d.t, zoneStated: !!d.zone, of: label } });
  }
  const g = X.gpsDecimal(t.gps);
  if (g) ctx.emit({ type: 'place', value: `${g.lat},${g.lon}`, confidence: 'likely', raw: { rel: 'embedded-gps', of: label, ...(g.altitudeM !== undefined ? { altitudeM: g.altitudeM } : {}), note: 'position recorded by the device when the file was made; it can be wrong, edited or copied from another file' } });
  if (!g && Object.keys(t.gps).length) ctx.note('the file has GPS fields but no usable position');
  if (isPdf && p.encrypted) ctx.note('the PDF is encrypted: its metadata may be incomplete');
  if (isPdf) ctx.note('PDF information is read by a text scan, not a full parser; treat it as likely, not certain');
  if (withheld.length) ctx.note(`personal fields withheld: ${withheld.join(', ')}`);
}

async function run(ctx, input) {
  if (input.check === 'parser') {
    const buf = X.buildExifJpeg(SAMPLE);
    const p = X.parse(buf), g = X.gpsDecimal(p && p.tiff ? p.tiff.gps : {});
    if (!p || !p.tiff || p.tiff.ifd0.Make !== SAMPLE.make || p.tiff.ifd0.Model !== SAMPLE.model || !g || g.lat !== 10.5 || g.lon !== -20.25 || p.width !== 8) throw new Error('the built-in parser self-check failed');
    ctx.emit({ type: 'image', value: 'self-check-sample', raw: { selfCheck: true, note: 'a sample generated inside the module to prove the reader works; not a user file' } });
    return;
  }
  if (!input.file) throw new ModuleError('bad-input', 'pick a file');
  let st;
  try { st = fs.statSync(input.file); } catch { throw new ModuleError('bad-input', 'the file cannot be read'); }
  if (!st.isFile()) throw new ModuleError('bad-input', 'not a regular file');
  const fd = fs.openSync(input.file, 'r');
  let buf;
  try { buf = Buffer.alloc(Math.min(st.size, READ_MAX)); fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
  ctx.progress(0.3, 'hashing');
  const sha256 = await new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(input.file).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej); });
  if (st.size > READ_MAX) ctx.note(`only the first ${READ_MAX / 1048576} MB were read for metadata`);
  report(ctx, buf, { name: path.basename(input.file), size: st.size, sha256 });
  ctx.progress(1);
}
module.exports = { meta, run, SAMPLE };
