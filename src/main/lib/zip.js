'use strict';
// Minimal, defensive ZIP reader (stored and deflate entries). No dependencies.
const zlib = require('node:zlib');

const LIMITS = { entries: 600, total: 24 * 1024 * 1024, single: 8 * 1024 * 1024 };

function safeName(n) {
  if (!n || n.length > 240) return null;
  if (n.includes('\\') || n.includes('\0') || n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return null;
  const parts = n.split('/');
  if (parts.some((p) => p === '..')) return null;
  return n;
}

// -> [{ name, data:Buffer }] (directories skipped). Throws Error with a plain message.
function readZip(buf, limits = LIMITS) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('Not a zip file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10); const cdOff = buf.readUInt32LE(eocd + 16);
  if (count > limits.entries) throw new Error('Zip has too many files');
  const out = []; let p = cdOff; let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Damaged zip');
    const flags = buf.readUInt16LE(p + 8); const method = buf.readUInt16LE(p + 10); const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20); const usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28); const el = buf.readUInt16LE(p + 30); const cl = buf.readUInt16LE(p + 32); const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Encrypted zips are not allowed');
    const safe = safeName(name); if (!safe) throw new Error('Unsafe file name in zip: ' + name.slice(0, 60));
    if (usize > limits.single) throw new Error('A file in the zip is too large');
    total += usize; if (total > limits.total) throw new Error('Zip is too large when unpacked');
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('Damaged zip');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw new Error('Damaged zip');
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) { try { data = zlib.inflateRawSync(raw, { maxOutputLength: limits.single }); } catch { throw new Error('Damaged zip'); } }
    else throw new Error('Unsupported zip compression');
    if (data.length !== usize) throw new Error('Damaged zip');
    if (zlib.crc32 && zlib.crc32(data) !== crc) throw new Error('Zip checksum mismatch');
    out.push({ name: safe, data });
  }
  return out;
}
module.exports = { readZip, safeName, LIMITS };
