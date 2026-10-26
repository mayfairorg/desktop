'use strict';
// Bundles the filter lists into the installer: downloads each list from its public URL into
// assets/filters/. Run before "npm run dist" (the GitHub workflow does). Needs network access to
// easylist.to, ublockorigin.github.io and cdn.jsdelivr.net. A list that fails is reported and skipped.
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../src/main/lib/filter-lists.json');
const out = path.join(__dirname, '..', 'assets', 'filters');
fs.mkdirSync(out, { recursive: true });
const get = (url, depth = 0) => new Promise((res, rej) => https.get(url, { headers: { 'user-agent': 'MayfairDesktop-build' } }, (r) => {
  if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && depth < 5) return res(get(new URL(r.headers.location, url).toString(), depth + 1));
  if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
  const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res(Buffer.concat(c).toString('utf8')));
}).on('error', rej));
(async () => {
  let bad = 0;
  for (const j of [...manifest.lists.map((l) => ({ file: l.file, url: l.url })), { file: 'resources.txt', url: manifest.resources }]) {
    try { const t = await get(j.url); fs.writeFileSync(path.join(out, j.file), t); console.log('ok  ', j.file, (t.length / 1024).toFixed(0) + ' KB'); } catch (e) { bad++; console.error('FAIL', j.file, e.message); }
  }
  fs.writeFileSync(path.join(out, 'fetched.json'), JSON.stringify({ at: new Date().toISOString() }));
  if (bad === manifest.lists.length + 1) process.exit(1);
})();
