'use strict';
// Shared by the ghost-terminal*.test.js files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const tmp = (p = 'mfd-gterm-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A small zip writer: entries [{name, data, deflate?}]. Names are written as given (so tests can include ../ and absolute paths).
function makeZip(entries) {
  const locals = [], cds = []; let off = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const comp = e.deflate ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name), crc = zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.deflate ? 8 : 0, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(e.deflate ? 8 : 0, 10); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    cds.push(cd, name);
    off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}

const RUN_JS = `const a=process.argv.slice(2).find(x=>x.startsWith('--text='));const t=a?a.slice(7):'';
console.log(JSON.stringify({progress:0.5,message:'working'}));
console.log(JSON.stringify({entity:{type:'echo',value:t},source:{tool:'echo-tool',connector:process.env.MF_CONNECTOR_ID,version:'1.0.0'},observedAt:new Date().toISOString(),confidence:'confirmed'}));`;

function manifest(over = {}) {
  return {
    id: 'echo-tool', name: 'Echo tool', version: '1.0.0', description: 'Echoes its input. Local only.', capabilities: ['text'], scope: 'local', network: 'local',
    licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit', mode: 'bundled' },
    installRequirements: [], command: { executable: '@node', args: ['run.js', '--text={text}'] },
    input: { fields: [{ name: 'text', type: 'string', label: 'Text', maxLength: 200 }] }, output: { format: 'jsonl' },
    limits: { timeoutMs: 8000, maxOutputBytes: 65536, maxConcurrent: 2 }, permissions: [], externalRestrictions: 'None.',
    selfTest: { input: { text: 'hello' }, expect: { minResults: 1, contains: [{ type: 'echo', value: 'hello' }] } }, ...over,
  };
}
const toolFiles = (over) => [{ name: 'connector.json', data: JSON.stringify(manifest(over)) }, { name: 'run.js', data: RUN_JS }, { name: 'README.md', data: '# Echo\nDoes nothing risky.' }, { name: 'LICENSE', data: 'MIT License\n' }];

function writeFolder(dir, files) { for (const f of files) { const p = path.join(dir, f.name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, f.data); } return dir; }

async function waitFor(fn, ms = 6000, step = 25) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, step)); }
}
module.exports = { tmp, makeZip, manifest, toolFiles, writeFolder, waitFor, RUN_JS };
