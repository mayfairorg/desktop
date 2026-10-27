'use strict';
// Mayfair Ghost: structured JSON-lines log in <userData>/ghost/logs, rotated by size. Input values marked sensitive never reach it:
// callers pass a `secrets` list and every string is scrubbed of those values before it is written.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 256 * 1024, KEEP = 4;

// replace every sensitive value in a string with ***
function redact(v, secrets) {
  let s = String(v);
  for (const x of secrets || []) if (x) s = s.split(x).join('***');
  return s;
}
function scrub(v, secrets) {
  if (typeof v === 'string') {
    const s = redact(v, secrets);
    return s.length > 500 ? s.slice(0, 500) + '...' : s;
  }
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, secrets));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 30).map(([k, x]) => [k, scrub(x, secrets)]));
  return v;
}

class GhostLog {
  constructor(dir, { maxBytes = MAX_BYTES, keep = KEEP, now = Date.now, io = null } = {}) {
    this.io = io;   // optional vault storage: the scan log is then sealed at rest
    this.dir = dir; this.maxBytes = maxBytes; this.keep = keep; this.now = now;
    this.file = path.join(dir, 'ghost.log');
  }
  write(level, event, fields = {}, secrets = []) {
    try {
      const line = JSON.stringify({ t: this.now(), level, event, ...scrub(fields, secrets) }) + '\n';
      if (this.io) { this.io.append('ghost.log', line, { maxBytes: this.maxBytes, keep: this.keep }); return; }
      fs.mkdirSync(this.dir, { recursive: true });
      this.rotate(Buffer.byteLength(line));
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch { /* a log failure never stops a job */ }
  }
  info(event, fields, secrets) { this.write('info', event, fields, secrets); }
  warn(event, fields, secrets) { this.write('warn', event, fields, secrets); }
  error(event, fields, secrets) { this.write('error', event, fields, secrets); }
  rotate(incoming) {
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size + incoming <= this.maxBytes) return;
    try { fs.rmSync(`${this.file}.${this.keep}`, { force: true }); } catch { /* none */ }
    for (let i = this.keep - 1; i >= 1; i--) { try { fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`); } catch { /* none */ } }
    try { fs.renameSync(this.file, `${this.file}.1`); } catch { /* none */ }
  }
  // newest last; {jobId?, n}
  tail({ jobId, n = 100 } = {}) {
    n = Math.max(1, Math.min(500, Number.isInteger(n) ? n : 100));
    if (this.io) {
      const out = [];
      try { for (const txt of this.io.readAll('ghost.log')) for (const l of txt.split('\n')) { if (!l) continue; let o; try { o = JSON.parse(l); } catch { continue; } if (jobId && o.jobId !== jobId) continue; out.push(o); } } catch { /* locked */ }
      return out.slice(-n);
    }
    const files = [];
    for (let i = this.keep; i >= 1; i--) files.push(`${this.file}.${i}`);
    files.push(this.file);
    const out = [];
    for (const f of files) {
      let txt = '';
      try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const l of txt.split('\n')) {
        if (!l) continue;
        let o; try { o = JSON.parse(l); } catch { continue; }
        if (jobId && o.jobId !== jobId) continue;
        out.push(o);
      }
    }
    return out.slice(-n);
  }
}
module.exports = { GhostLog, scrub, redact };
