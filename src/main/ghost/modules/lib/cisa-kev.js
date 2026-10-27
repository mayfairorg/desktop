'use strict';
// CISA Known Exploited Vulnerabilities catalogue. One public JSON file, cached on this computer for 12 hours so repeat lookups send no
// request; when CISA cannot be reached an older cached copy is used and says so.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModuleError, clip } = require('./core');
const K = require('./keyless-common');

const URL_KEV = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';
const meta = {
  id: 'cisa-kev', tool: 'cisa-kev-json', name: 'Known exploited vulnerabilities (CISA)', version: '1.0.0',
  description: 'Looks up vulnerabilities that CISA lists as exploited in the wild, by CVE, vendor or product, or the most recently added.',
  capabilities: ['threat-intel', 'vulnerabilities', 'cisa', 'kev', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['www.cisa.gov'], client: { rps: 1, maxRequests: 1, timeoutMs: 30000, maxBytes: 16777216 },
  restrictions: 'Downloads CISA\'s one public catalogue file (about 1 to 2 MB) at most once every 12 hours and keeps a copy in this computer\'s temporary folder. If CISA is unreachable an older copy is used and marked as such. CISA data is US government public information.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Source: CISA Known Exploited Vulnerabilities Catalog (cisa.gov/known-exploited-vulnerabilities-catalog)',
  dataTerms: 'US government public information, CC0 1.0 per the catalogue\'s page',
  inputs: [
    { name: 'query', type: 'string', label: 'CVE id, vendor or product (blank: newest)', required: false, maxLength: 60, pattern: '^[A-Za-z0-9 ._:+/()-]{1,60}$' },
    { name: 'start', type: 'string', label: 'Added on or after (YYYY-MM-DD)', required: false, maxLength: 10, pattern: K.DATE_PATTERN },
    { name: 'limit', type: 'integer', label: 'Most entries', required: false, min: 1, max: 100 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { query: 'CVE-2021-44228', limit: 1 }, expect: { minResults: 1, contains: [{ type: 'document', value: 'CVE-2021-44228' }] } },
};

// Tests point this at a temporary folder and a fixed clock.
const cache = { dir: () => os.tmpdir(), ttlMs: 12 * 3600 * 1000, now: () => Date.now(), file: 'mayfair-ghost-cisa-kev.json' };
const cachePath = () => path.join(cache.dir(), cache.file);
function readCache() {
  try {
    const st = fs.lstatSync(cachePath());
    if (!st.isFile() || st.size > 20 * 1048576) return null;
    const o = JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    if (!o || typeof o.savedAt !== 'number' || !o.doc || !Array.isArray(o.doc.vulnerabilities)) return null;
    return o;
  } catch { return null; }
}
function writeCache(doc) {
  try {
    const tmp = cachePath() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: cache.now(), doc }), { mode: 0o600 });
    fs.renameSync(tmp, cachePath());
  } catch { /* a cache that cannot be written only costs a later download */ }
}
const isKev = (d) => d && Array.isArray(d.vulnerabilities);

async function catalogue(ctx) {
  const c = readCache();
  if (c && cache.now() - c.savedAt >= 0 && cache.now() - c.savedAt < cache.ttlMs) return { doc: c.doc, from: 'cache', savedAt: c.savedAt };
  ctx.progress(0.2, 'downloading the CISA catalogue');
  try {
    const res = await ctx.client.get(URL_KEV, { purpose: 'kev-catalogue' });
    if (res.status === 404) throw new ModuleError('unavailable', 'the CISA catalogue did not answer at its address');
    const doc = res.json();
    if (!isKev(doc)) throw new ModuleError('bad-response', 'the CISA catalogue has an unexpected shape');
    writeCache(doc);
    return { doc, from: 'network', savedAt: cache.now() };
  } catch (e) {
    if (c && e instanceof ModuleError && ['unavailable', 'rate-limited', 'bad-response'].includes(e.kind)) return { doc: c.doc, from: 'stale-cache', savedAt: c.savedAt, why: e.message };
    throw e;
  }
}

async function run(ctx, input) {
  const q = String(input.query || '').trim();
  const start = K.parseDay(input.start);
  const limit = K.intOr(input.limit, 25, 1, 100);
  const cve = /^cve-\d{4}-\d{4,7}$/i.test(q) ? q.toUpperCase() : null;
  const { doc, from, savedAt, why } = await catalogue(ctx);
  const all = doc.vulnerabilities.filter((v) => v && typeof v.cveID === 'string' && /^CVE-\d{4}-\d{4,7}$/.test(v.cveID));
  const needle = q.toLowerCase();
  let hits = all.filter((v) => (!cve || v.cveID === cve) && (cve || !q || [v.vendorProject, v.product, v.vulnerabilityName].some((s) => typeof s === 'string' && s.toLowerCase().includes(needle))) && (!start || String(v.dateAdded) >= start));
  hits.sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded)) || a.cveID.localeCompare(b.cveID));
  if (!hits.length) ctx.note('no entry in the catalogue matches');
  for (const v of hits.slice(0, limit)) {
    ctx.emit({ type: 'document', value: v.cveID, confidence: from === 'stale-cache' ? 'likely' : 'confirmed', url: `https://nvd.nist.gov/vuln/detail/${v.cveID}`, raw: { kind: 'cisa-kev', name: v.vulnerabilityName ? clip(v.vulnerabilityName, 200) : undefined, vendor: v.vendorProject, product: v.product, dateAdded: v.dateAdded, dueDate: v.dueDate, requiredAction: v.requiredAction ? clip(v.requiredAction, 300) : undefined, knownRansomwareCampaignUse: v.knownRansomwareCampaignUse, cwes: Array.isArray(v.cwes) ? v.cwes.slice(0, 5) : undefined, catalogVersion: doc.catalogVersion, source: from, attribution: meta.attribution } });
  }
  if (hits.length > limit) ctx.note(`${hits.length - limit} more match(es) not shown`);
  const age = new Date(savedAt).toISOString();
  if (from === 'cache') ctx.note(`served from the copy saved on this computer at ${age}; no request was sent`);
  else if (from === 'stale-cache') ctx.note(`CISA could not be reached (${clip(why, 100)}): showing the copy saved at ${age}, which may be out of date`);
  if (doc.catalogVersion) ctx.note(`catalogue version ${doc.catalogVersion}, ${all.length} entries`);
  ctx.progress(1);
}
module.exports = { meta, run, cache };
