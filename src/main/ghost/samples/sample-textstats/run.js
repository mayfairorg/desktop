'use strict';
// sample-textstats: SHA-256, byte, line and word counts of a text or a picked file. Local only, no network.
// Usage: run.js --text=<text> | --file=<path>      Prints JSON lines on stdout (progress lines, then results).
const fs = require('node:fs');
const crypto = require('node:crypto');

const TOOL = 'sample-textstats', CONNECTOR = 'sample-textstats', VERSION = '1.0.0';
const arg = (n) => { const p = `--${n}=`; const a = process.argv.slice(2).find((x) => x.startsWith(p)); return a === undefined ? undefined : a.slice(p.length); };
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const fail = (msg) => { process.stderr.write(msg + '\n'); process.exit(2); };

const text = arg('text'), file = arg('file');
if ((text === undefined) === (file === undefined)) fail('give exactly one of --text or --file');

let buf;
out({ progress: 0.1, message: 'reading' });
if (file !== undefined) {
  try { buf = fs.readFileSync(file); } catch (e) { fail('cannot read the file: ' + e.code); }
} else buf = Buffer.from(text, 'utf8');

out({ progress: 0.6, message: 'counting' });
const s = buf.toString('utf8');
const lines = s.length === 0 ? 0 : s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
const words = (s.match(/\S+/g) || []).length;
const sha = crypto.createHash('sha256').update(buf).digest('hex');
const now = new Date().toISOString();
for (const [type, value] of [['sha256', sha], ['byte-count', String(buf.length)], ['line-count', String(lines)], ['word-count', String(words)]]) {
  out({ entity: { type, value }, source: { tool: TOOL, connector: CONNECTOR, version: VERSION }, observedAt: now, confidence: 'confirmed' });
}
out({ progress: 1, message: 'done' });
