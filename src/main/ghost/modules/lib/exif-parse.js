'use strict';
// A small, dependency-free metadata reader (no third-party code, so no licence to carry): EXIF/GPS in JPEG and TIFF, text chunks in
// PNG, the Info dictionary of a PDF. Every read is bounds-checked; a damaged file yields what could be read, never a crash.
// It covers the common cases only. Wider coverage (RAW, video, Office, XMP detail) is the job of the optional download-on-demand
// ExifTool connector, which is a separate program under its own licence.
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
const IFD0 = { 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation', 0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist', 0x8298: 'Copyright', 0x0100: 'ImageWidth', 0x0101: 'ImageHeight', 0x8769: 'ExifIFD', 0x8825: 'GPSIFD' };
const EXIF = { 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9011: 'OffsetTimeOriginal', 0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa430: 'CameraOwnerName', 0xa431: 'BodySerialNumber', 0xa434: 'LensModel', 0xa435: 'LensSerialNumber' };
const GPS = { 1: 'GPSLatitudeRef', 2: 'GPSLatitude', 3: 'GPSLongitudeRef', 4: 'GPSLongitude', 5: 'GPSAltitudeRef', 6: 'GPSAltitude' };

function detect(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 4 && ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0 && buf[3] === 0x2a))) return 'tiff';
  if (buf.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  return null;
}

// TIFF structure at buf[base..]. Returns {ifd0, exif, gps} with plain values (strings, numbers, arrays of numbers).
function parseTiff(buf, base = 0) {
  const out = { ifd0: {}, exif: {}, gps: {} };
  if (buf.length < base + 8) return out;
  const le = buf[base] === 0x49;
  const u16 = (o) => (o + 2 <= buf.length ? (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)) : null);
  const u32 = (o) => (o + 4 <= buf.length ? (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o)) : null);
  const i32 = (o) => (o + 4 <= buf.length ? (le ? buf.readInt32LE(o) : buf.readInt32BE(o)) : null);
  if (u16(base + 2) !== 42) return out;
  function value(type, count, at) {
    const sz = TYPE_SIZE[type];
    if (!sz || count < 1 || count > 4096) return undefined;
    const total = sz * count;
    const off = total <= 4 ? at : base + u32(at);
    if (off === null || Number.isNaN(off) || off + total > buf.length || off < 0) return undefined;
    const rd = (k) => {
      const o = off + k * sz;
      if (type === 1 || type === 7) return buf[o];
      if (type === 3) return u16(o);
      if (type === 4) return u32(o);
      if (type === 9) return i32(o);
      const n = type === 5 ? u32(o) : i32(o), d = type === 5 ? u32(o + 4) : i32(o + 4);
      return d ? n / d : null;
    };
    if (type === 2) return buf.toString('latin1', off, off + total).replace(/\0.*$/s, '').trim();
    const vals = []; for (let k = 0; k < count; k++) vals.push(rd(k));
    return count === 1 ? vals[0] : vals;
  }
  function ifd(off, names, into, depth = 0) {
    const start = base + off;
    const n = u16(start);
    if (n === null || n > 512) return;
    for (let k = 0; k < n; k++) {
      const e = start + 2 + k * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (tag === null || count === null) return;
      const name = names[tag];
      if (!name) continue;
      const v = value(type, count, e + 8);
      if (v === undefined || v === null) continue;
      into[name] = v;
    }
  }
  const first = u32(base + 4);
  if (first === null) return out;
  ifd(first, IFD0, out.ifd0);
  if (Number.isInteger(out.ifd0.ExifIFD)) ifd(out.ifd0.ExifIFD, EXIF, out.exif);
  if (Number.isInteger(out.ifd0.GPSIFD)) ifd(out.ifd0.GPSIFD, GPS, out.gps);
  delete out.ifd0.ExifIFD; delete out.ifd0.GPSIFD;
  return out;
}

function gpsDecimal(g) {
  const dms = (v, ref, neg, max) => {
    if (!Array.isArray(v) || v.length !== 3 || v.some((x) => typeof x !== 'number' || !Number.isFinite(x))) return null;
    let d = v[0] + v[1] / 60 + v[2] / 3600;
    if (ref === neg) d = -d;
    return Math.abs(d) <= max ? Math.round(d * 1e6) / 1e6 : null;
  };
  const lat = dms(g.GPSLatitude, g.GPSLatitudeRef, 'S', 90), lon = dms(g.GPSLongitude, g.GPSLongitudeRef, 'W', 180);
  if (lat === null || lon === null) return null;
  const alt = typeof g.GPSAltitude === 'number' ? Math.round(g.GPSAltitude * 10) / 10 * (g.GPSAltitudeRef === 1 ? -1 : 1) : undefined;
  return { lat, lon, ...(alt !== undefined ? { altitudeM: alt } : {}) };
}
// "2024:05:01 12:30:00" (+ optional "+01:00") -> {local, iso}. The camera clock has no zone unless OffsetTimeOriginal says so.
function exifDate(s, offset) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || m[1] === '0000') return null;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  if (Number.isNaN(Date.parse(local + 'Z'))) return null;
  const off = /^[+-]\d{2}:\d{2}$/.test(offset || '') ? offset : null;
  return { local, zone: off, t: off ? new Date(Date.parse(local + off)).toISOString() : local };
}

function parseJpeg(buf) {
  const out = { format: 'jpeg', tiff: null, xmp: false, width: null, height: null };
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) break;
    const len = buf.readUInt16BE(i + 2);
    const seg = i + 4, end = i + 2 + len;
    if (len < 2 || end > buf.length) break;
    if (m === 0xe1 && buf.toString('latin1', seg, seg + 6) === 'Exif\0\0' && !out.tiff) out.tiff = parseTiff(buf.subarray(seg + 6, end), 0);
    else if (m === 0xe1 && buf.toString('latin1', seg, seg + 29) === 'http://ns.adobe.com/xap/1.0/\0') out.xmp = true;
    else if (((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) && len >= 8) { out.height = buf.readUInt16BE(seg + 1); out.width = buf.readUInt16BE(seg + 3); }
    i = end;
  }
  return out;
}
function parsePng(buf) {
  const out = { format: 'png', tiff: null, xmp: false, width: null, height: null, text: {}, time: null };
  let i = 8, n = 0;
  while (i + 12 <= buf.length && n++ < 10000) {
    const len = buf.readUInt32BE(i), type = buf.toString('latin1', i + 4, i + 8), d = i + 8;
    if (d + len + 4 > buf.length) break;
    if (type === 'IHDR' && len >= 8) { out.width = buf.readUInt32BE(d); out.height = buf.readUInt32BE(d + 4); }
    else if (type === 'tEXt') { const z = buf.indexOf(0, d); if (z > d && z < d + len) out.text[buf.toString('latin1', d, z).slice(0, 79)] = buf.toString('latin1', z + 1, d + len).slice(0, 500); }
    else if (type === 'iTXt') { const z = buf.indexOf(0, d); if (z > d && z < d + len) { const key = buf.toString('latin1', d, z).slice(0, 79); if (key === 'XML:com.adobe.xmp') out.xmp = true; else out.text[key] = '(international text)'; } }
    else if (type === 'zTXt') { const z = buf.indexOf(0, d); if (z > d && z < d + len) out.text[buf.toString('latin1', d, z).slice(0, 79)] = '(compressed)'; }
    else if (type === 'eXIf' && !out.tiff) out.tiff = parseTiff(buf.subarray(d, d + len), 0);
    else if (type === 'tIME' && len === 7) out.time = `${buf.readUInt16BE(d)}-${String(buf[d + 2]).padStart(2, '0')}-${String(buf[d + 3]).padStart(2, '0')}T${String(buf[d + 4]).padStart(2, '0')}:${String(buf[d + 5]).padStart(2, '0')}:${String(buf[d + 6]).padStart(2, '0')}Z`;
    else if (type === 'IEND') break;
    i = d + len + 4;
  }
  return out;
}
function parseTiffFile(buf) {
  const t = parseTiff(buf, 0);
  return { format: 'tiff', tiff: t, xmp: false, width: Number.isInteger(t.ifd0.ImageWidth) ? t.ifd0.ImageWidth : null, height: Number.isInteger(t.ifd0.ImageHeight) ? t.ifd0.ImageHeight : null };
}
// PDF: a text scan of the Info entries. Not a full parser (object streams and encrypted files are not read), so results are 'likely'.
function parsePdf(buf) {
  const s = buf.toString('latin1');
  const out = { format: 'pdf', info: {}, version: (/^%PDF-(\d\.\d)/m.exec(s) || [])[1] || null, encrypted: /\/Encrypt\b/.test(s) };
  for (const key of ['Title', 'Author', 'Subject', 'Creator', 'Producer', 'CreationDate', 'ModDate']) {
    const m = new RegExp('/' + key + '\\s*\\(((?:\\\\.|[^\\\\)]){0,300})\\)').exec(s);
    if (m) out.info[key] = m[1].replace(/\\(.)/g, '$1').replace(/[\x00-\x1f]/g, ' ').trim();
  }
  return out;
}
const pdfDate = (s) => { const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/.exec(String(s || '')); if (!m) return null; const local = `${m[1]}-${m[2] || '01'}-${m[3] || '01'}T${m[4] || '00'}:${m[5] || '00'}:${m[6] || '00'}`; const z = m[7] && m[7] !== 'Z' ? m[7].replace(/'/g, '').replace(/(\d{2})(\d{2})$/, '$1:$2') : m[7] ? 'Z' : null; const t = Date.parse(local + (z || 'Z')); return Number.isNaN(t) ? null : { local, zone: z, t: z ? new Date(t).toISOString() : local }; };

function parse(buf) {
  const f = detect(buf);
  if (f === 'jpeg') return parseJpeg(buf);
  if (f === 'png') return parsePng(buf);
  if (f === 'tiff') return parseTiffFile(buf);
  if (f === 'pdf') return parsePdf(buf);
  return null;
}

// ---- a tiny JPEG with EXIF, built by hand: used by the module's own self-check and by tests ----
function buildExifJpeg({ make, model, software, dateOriginal, offsetOriginal, artist, lat, lon, alt, width = 8, height = 6, bigEndian = false } = {}) {
  const le = !bigEndian;
  const w16 = (n) => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
  const w32 = (n) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b; };
  const ascii = (s) => Buffer.from(s + '\0', 'latin1');
  const rat = (n, d) => Buffer.concat([w32(n), w32(d)]);
  // each IFD: entries {tag, type, count, data (Buffer) | inline (Buffer<=4)}; data blobs are appended after the directories
  const blobs = [];
  const layout = (entries, baseOff) => {
    const dirLen = 2 + entries.length * 12 + 4;
    let dataOff = baseOff + dirLen;
    const ent = [], data = [];
    for (const e of entries) {
      let valField;
      if (e.ptr !== undefined) valField = w32(e.ptr);
      else if (e.data.length <= 4) valField = Buffer.concat([e.data, Buffer.alloc(4 - e.data.length)]);
      else { valField = w32(dataOff); data.push(e.data); dataOff += e.data.length + (e.data.length % 2); if (e.data.length % 2) data.push(Buffer.alloc(1)); }
      ent.push(Buffer.concat([w16(e.tag), w16(e.type), w32(e.count), valField]));
    }
    return { buf: Buffer.concat([w16(entries.length), ...ent, w32(0), ...data]), size: dirLen + data.reduce((a, b) => a + b.length, 0) };
  };
  const exifEntries = [];
  if (dateOriginal) exifEntries.push({ tag: 0x9003, type: 2, count: dateOriginal.length + 1, data: ascii(dateOriginal) });
  if (offsetOriginal) exifEntries.push({ tag: 0x9011, type: 2, count: offsetOriginal.length + 1, data: ascii(offsetOriginal) });
  const gpsEntries = [];
  if (lat !== undefined) {
    const dms = (v) => { const a = Math.abs(v), d = Math.floor(a), mm = Math.floor((a - d) * 60), s = Math.round(((a - d) * 60 - mm) * 60 * 10000); return Buffer.concat([rat(d, 1), rat(mm, 1), rat(s, 10000)]); };
    gpsEntries.push({ tag: 1, type: 2, count: 2, data: ascii(lat < 0 ? 'S' : 'N') }, { tag: 2, type: 5, count: 3, data: dms(lat) }, { tag: 3, type: 2, count: 2, data: ascii(lon < 0 ? 'W' : 'E') }, { tag: 4, type: 5, count: 3, data: dms(lon) });
    if (alt !== undefined) gpsEntries.push({ tag: 5, type: 1, count: 1, data: Buffer.from([alt < 0 ? 1 : 0]) }, { tag: 6, type: 5, count: 1, data: rat(Math.round(Math.abs(alt) * 10), 10) });
  }
  const ifd0 = [];
  if (make) ifd0.push({ tag: 0x010f, type: 2, count: make.length + 1, data: ascii(make) });
  if (model) ifd0.push({ tag: 0x0110, type: 2, count: model.length + 1, data: ascii(model) });
  if (software) ifd0.push({ tag: 0x0131, type: 2, count: software.length + 1, data: ascii(software) });
  if (artist) ifd0.push({ tag: 0x013b, type: 2, count: artist.length + 1, data: ascii(artist) });
  // two passes: sizes do not depend on pointer values
  const sizeOf = (es) => layout(es.map((e) => (e.ptr !== undefined ? { ...e, ptr: 0 } : e)), 0).size;
  const mk = (withExif, withGps) => {
    const entries = [...ifd0];
    if (withExif) entries.push({ tag: 0x8769, type: 4, count: 1, ptr: 0 });
    if (withGps) entries.push({ tag: 0x8825, type: 4, count: 1, ptr: 0 });
    entries.sort((a, b) => a.tag - b.tag);
    return entries;
  };
  const e0 = mk(exifEntries.length > 0, gpsEntries.length > 0);
  const s0 = sizeOf(e0), sE = exifEntries.length ? sizeOf(exifEntries) : 0;
  const offExif = 8 + s0, offGps = offExif + sE;
  const fin = e0.map((e) => (e.tag === 0x8769 ? { ...e, ptr: offExif } : e.tag === 0x8825 ? { ...e, ptr: offGps } : e));
  const parts = [Buffer.from(le ? 'II' : 'MM'), w16(42), w32(8), layout(fin, 8).buf];
  if (exifEntries.length) parts.push(layout(exifEntries.sort((a, b) => a.tag - b.tag), offExif).buf);
  if (gpsEntries.length) parts.push(layout(gpsEntries, offGps).buf);
  const tiff = Buffer.concat(parts);
  const app1 = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const hdr = (m, body) => Buffer.concat([Buffer.from([0xff, m]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const sof = Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), hdr(0xe1, app1), hdr(0xc0, sof), Buffer.from([0xff, 0xda, 0, 3, 0, 0, 0xff, 0xd9])]);
}

module.exports = { detect, parse, parseTiff, gpsDecimal, exifDate, pdfDate, buildExifJpeg };
