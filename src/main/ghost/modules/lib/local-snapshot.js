'use strict';
// Records the address, time and SHA-256 of a page the Ghost browser saved to a file, so the case board can show where a saved copy came
// from and prove it is unchanged later. Local only: it fetches nothing and never contacts the page's site.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModuleError, clip, isoDate } = require('./core');

const meta = {
  id: 'local-snapshot', tool: 'mayfair-local-snapshot', name: 'Saved page record', version: '1.0.0',
  description: 'Records the web address, save time and SHA-256 fingerprint of a page the Ghost browser saved to a file, as a case entry that proves the saved copy is unchanged.',
  capabilities: ['web-archive', 'snapshot', 'file-integrity', 'passive', 'local'], scope: 'local', network: 'local',
  hosts: [], client: { maxRequests: 0, timeoutMs: 300000 },
  restrictions: 'None for the service: nothing is sent anywhere and the site is not contacted. The record shows what you tell it about the address; it cannot prove that the file really came from that address. The time is when the file was last written, unless you give one.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, attribution: 'Local processing; no third-party data', dataTerms: 'Local processing; no third-party data',
  inputs: [
    { name: 'url', type: 'string', label: 'Address the page was saved from', required: false, maxLength: 2000 },
    { name: 'file', type: 'file', label: 'Saved page file', required: false, maxBytes: 1073741824 },
    { name: 'timestamp', type: 'string', label: 'Saved at (ISO date-time; default: the file\'s own time)', required: false, maxLength: 40, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9:.]+(Z|[+-][0-9]{2}:?[0-9]{2})?)?$' },
    { name: 'check', type: 'enum', label: 'Self-check', required: false, values: ['selftest'] },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { check: 'selftest' }, expect: { minResults: 2, contains: [{ type: 'url', value: 'https://example.com/snapshot-selftest' }] } },
};
const TYPES = { '.html': 'text/html', '.htm': 'text/html', '.mhtml': 'multipart/related', '.mht': 'multipart/related', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain', '.warc': 'application/warc', '.json': 'application/json' };

function cleanUrl(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch { throw new ModuleError('bad-input', 'enter the web address the page was saved from, starting with https:// or http://'); }
  if (!/^https?:$/.test(u.protocol)) throw new ModuleError('bad-input', 'only http and https addresses are recorded');
  if (u.username || u.password) throw new ModuleError('bad-input', 'the address contains a user name or password: remove it first');
  u.hash = '';
  return u.href;
}
function sha256Of(stream) {
  return new Promise((res, rej) => { const h = crypto.createHash('sha256'); let n = 0; stream.on('data', (c) => { n += c.length; h.update(c); }); stream.on('end', () => res({ sha256: h.digest('hex'), size: n })); stream.on('error', rej); });
}

async function run(ctx, input) {
  let url, name, hashed, savedAt;
  if (input.check === 'selftest') {
    const { Readable } = require('node:stream');
    url = 'https://example.com/snapshot-selftest'; name = 'self-check-sample.html';
    hashed = await sha256Of(Readable.from([Buffer.from('<html>snapshot self-check</html>')]));
    savedAt = '2001-02-03T04:05:06.000Z';
  } else {
    if (!input.file) throw new ModuleError('bad-input', 'pick the saved page file');
    url = cleanUrl(input.url);
    let st;
    try { st = fs.statSync(input.file); } catch { throw new ModuleError('bad-input', 'the file cannot be read'); }
    if (!st.isFile()) throw new ModuleError('bad-input', 'not a regular file');
    name = path.basename(input.file);
    if (input.timestamp) {
      savedAt = isoDate(input.timestamp);
      if (!savedAt) throw new ModuleError('bad-input', 'the time is not a valid date-time');
      if (Date.parse(savedAt) > Date.now() + 86400000) throw new ModuleError('bad-input', 'the save time is in the future');
    } else savedAt = st.mtime.toISOString();
    ctx.progress(0.1, 'fingerprinting');
    try { hashed = await sha256Of(fs.createReadStream(input.file)); } catch { throw new ModuleError('bad-input', 'the file could not be read to the end'); }
    if (hashed.size !== st.size) ctx.note('the file changed size while it was being read; record it again');
  }
  const contentType = TYPES[path.extname(name).toLowerCase()];
  const raw = { kind: 'saved-page-snapshot', url, savedAt, sha256: hashed.sha256, size: hashed.size, fileName: clip(name, 200), contentType, timeSource: input.timestamp ? 'given' : 'file-time' };
  ctx.emit({ type: 'url', value: url, confidence: 'likely', raw });
  ctx.emit({ type: 'document', value: clip(name, 200), confidence: 'confirmed', raw: { ...raw, rel: 'saved-copy-of', of: url } });
  ctx.note('the address is as you gave it: the record cannot prove the file was saved from there');
  if (!input.timestamp && input.check !== 'selftest') ctx.note('the save time is the file\'s last-written time; give a time if the file was copied or re-saved');
  ctx.progress(1);
}
module.exports = { meta, run, cleanUrl };
