'use strict';
// SHA-256, SHA-1 and MD5 of a file the user picked. Local only: the file never leaves the computer and this module makes no network
// request. The file is read once as a stream, so a large file does not fill memory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ModuleError, clip } = require('./core');

const meta = {
  id: 'hash-file', tool: 'mayfair-hash', name: 'File hashes', version: '1.0.0',
  description: 'Computes the SHA-256, SHA-1 and MD5 fingerprints of a picked file, to prove a copy is unchanged or to match it against a known list. Runs entirely on this computer.',
  capabilities: ['hash', 'file-integrity', 'forensics', 'passive', 'local'], scope: 'local', network: 'local',
  hosts: [], client: { maxRequests: 0, timeoutMs: 300000 },
  restrictions: 'None for the service: nothing is sent anywhere. SHA-256 is the fingerprint to rely on; MD5 and SHA-1 can be forged and are listed only to match older lists. A hash proves the file is identical to another copy, not who made it or when.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, attribution: 'Local processing; no third-party data', dataTerms: 'Local processing; no third-party data',
  inputs: [
    { name: 'file', type: 'file', label: 'File', required: false, maxBytes: 1073741824 },
    { name: 'types', type: 'enum', label: 'Hashes', required: false, values: ['all', 'sha256', 'sha1', 'md5'] },
    { name: 'check', type: 'enum', label: 'Self-check', required: false, values: ['selftest'] },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { check: 'selftest' }, expect: { minResults: 1, contains: [{ type: 'document', value: 'self-check-sample' }] } },
};
const KNOWN_ABC = { sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d', md5: '900150983cd24fb0d6963f7d28e17f72' };
const ALGOS = ['sha256', 'sha1', 'md5'];

function hashStream(stream, algos) {
  return new Promise((resolve, reject) => {
    const hs = algos.map((a) => [a, crypto.createHash(a)]);
    let size = 0;
    stream.on('data', (c) => { size += c.length; for (const [, h] of hs) h.update(c); });
    stream.on('end', () => resolve({ size, ...Object.fromEntries(hs.map(([a, h]) => [a, h.digest('hex')])) }));
    stream.on('error', reject);
  });
}

async function run(ctx, input) {
  const algos = !input.types || input.types === 'all' ? ALGOS : [input.types];
  if (!algos.every((a) => ALGOS.includes(a))) throw new ModuleError('bad-input', 'hashes must be all, sha256, sha1 or md5');
  if (input.check === 'selftest') {
    const { Readable } = require('node:stream');
    const h = await hashStream(Readable.from([Buffer.from('a'), Buffer.from('bc')]), ALGOS);
    for (const a of ALGOS) if (h[a] !== KNOWN_ABC[a]) throw new Error('the built-in hash self-check failed for ' + a);
    ctx.emit({ type: 'document', value: 'self-check-sample', raw: { selfCheck: true, sha256: h.sha256, note: 'a sample generated inside the module to prove hashing works; not a user file' } });
    return;
  }
  if (!input.file) throw new ModuleError('bad-input', 'pick a file');
  let st;
  try { st = fs.statSync(input.file); } catch { throw new ModuleError('bad-input', 'the file cannot be read'); }
  if (!st.isFile()) throw new ModuleError('bad-input', 'not a regular file');
  ctx.progress(0.1, 'hashing');
  let h;
  try { h = await hashStream(fs.createReadStream(input.file), algos); } catch { throw new ModuleError('bad-input', 'the file could not be read to the end'); }
  if (h.size !== st.size) ctx.note('the file changed size while it was being read; hash it again');
  const raw = { kind: 'file-hash', size: h.size, ...Object.fromEntries(algos.map((a) => [a, h[a]])) };
  ctx.emit({ type: 'document', value: clip(path.basename(input.file), 200), confidence: 'confirmed', raw });
  if (algos.includes('md5') || algos.includes('sha1')) ctx.note('MD5 and SHA-1 can be forged: rely on SHA-256');
  ctx.progress(1);
}
module.exports = { meta, run };
