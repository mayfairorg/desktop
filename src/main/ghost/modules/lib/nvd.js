'use strict';
// NIST National Vulnerability Database, CVE API 2.0, without a key. The keyless limit is 5 requests in a rolling 30 seconds; this
// connector makes one request a run and remembers recent request times between runs, refusing with a wait time when the window is full.
const { ModuleError, clip } = require('./core');
const os = require('node:os');
const path = require('node:path');
const K = require('./keyless-common');

const meta = {
  id: 'nvd', tool: 'nvd-cve-api-2.0', name: 'Vulnerability details (NVD)', version: '1.0.0',
  description: 'Looks up a CVE in the National Vulnerability Database (description, severity score, weakness type, dates, references) or searches CVEs by keyword.',
  capabilities: ['threat-intel', 'vulnerabilities', 'nvd', 'cve', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['services.nvd.nist.gov'], client: { rps: 1 / 6, maxRequests: 1, timeoutMs: 30000, maxBytes: 4194304 },
  restrictions: 'The NVD allows 5 requests in 30 seconds without an API key; this connector waits 6 seconds between requests and sends at most 1 a run and keeps a count between runs, so five in 30 seconds is never exceeded. No key is used. The NVD may answer HTTP 403 when it is over its limit; that is reported as rate-limited. Scores and descriptions are the NVD\'s, not Mayfair\'s.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Source: NIST National Vulnerability Database (nvd.nist.gov). This product uses the NVD API but is not endorsed or certified by the NVD.',
  dataTerms: 'NVD data is US government public information; NVD asks that its use is credited and not presented as endorsed by NIST',
  inputs: [
    { name: 'kind', type: 'enum', label: 'Look up', values: ['cve', 'keyword'] },
    { name: 'query', type: 'string', label: 'CVE id or keyword', minLength: 3, maxLength: 80, pattern: '^[A-Za-z0-9 ._:+/()-]{3,80}$' },
    { name: 'limit', type: 'integer', label: 'Most CVEs (keyword)', required: false, min: 1, max: 20 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { kind: 'cve', query: 'CVE-2021-44228' }, expect: { minResults: 1, contains: [{ type: 'document', value: 'CVE-2021-44228' }] } },
};
// Tests point `guard` at a temporary file and a fixed clock.
const budget = { file: () => path.join(os.tmpdir(), 'mayfair-ghost-nvd-window.json'), now: () => Date.now() };
const pickCvss = (m) => {
  if (!m || typeof m !== 'object') return undefined;
  for (const key of ['cvssMetricV40', 'cvssMetricV31', 'cvssMetricV30', 'cvssMetricV2']) {
    const e = Array.isArray(m[key]) && m[key][0] && m[key][0].cvssData;
    if (e && Number.isFinite(e.baseScore)) return { version: e.version, score: e.baseScore, severity: e.baseSeverity || (m[key][0].baseSeverity), vector: typeof e.vectorString === 'string' ? clip(e.vectorString, 120) : undefined };
  }
  return undefined;
};

async function run(ctx, input) {
  const q = String(input.query || '').trim();
  let url;
  if (input.kind === 'cve') {
    if (!/^cve-\d{4}-\d{4,7}$/i.test(q)) throw new ModuleError('bad-input', 'a CVE id looks like CVE-2021-44228');
    url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${q.toUpperCase()}`;
  } else if (input.kind === 'keyword') {
    K.refuseContactShape(q);
    url = `https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(q)}&resultsPerPage=${K.intOr(input.limit, 10, 1, 20)}`;
  } else throw new ModuleError('bad-input', 'kind must be cve or keyword');
  const win = K.windowLimit({ file: budget.file(), max: 5, windowMs: 30000, now: budget.now });
  const wait = win.check();
  if (wait > 0) { ctx.client.state.rateLimited = true; throw new ModuleError('rate-limited', `the NVD allows 5 keyless requests in 30 seconds and 5 were just sent from this computer: try again in ${Math.ceil(wait / 1000)} s`, { retryAfter: Math.ceil(wait / 1000) }); }
  win.record();
  ctx.progress(0.2, 'asking the NVD');
  let res;
  try { res = await ctx.client.get(url, { purpose: 'nvd-' + input.kind }); } catch (e) {
    K.reword403(ctx, e, 'the NVD refused the request (HTTP 403): without a key it allows 5 requests in 30 seconds; wait half a minute and try again', { asRateLimit: true });
  }
  if (res.status === 404) { ctx.note('the NVD has no record for this query'); return; }
  const doc = res.json();
  const items = doc && Array.isArray(doc.vulnerabilities) ? doc.vulnerabilities : null;
  if (!items) throw new ModuleError('bad-response', 'the NVD answered in a shape that is not a CVE list');
  if (!items.length) { ctx.note('no CVE matches'); return; }
  for (const it of items) {
    const c = it && it.cve;
    if (!c || typeof c.id !== 'string' || !/^CVE-\d{4}-\d{4,7}$/.test(c.id)) continue;
    const en = Array.isArray(c.descriptions) ? c.descriptions.find((d) => d && d.lang === 'en' && typeof d.value === 'string') : null;
    const cwes = [...new Set((Array.isArray(c.weaknesses) ? c.weaknesses : []).flatMap((w) => (Array.isArray(w.description) ? w.description : []).map((d) => d && d.value)).filter((v) => typeof v === 'string' && /^(CWE-\d+|NVD-CWE-\w+)$/.test(v)))].slice(0, 5);
    const refs = (Array.isArray(c.references) ? c.references : []).map((r) => r && r.url).filter((u) => typeof u === 'string' && /^https:\/\/[^\s<>"'`\\]+$/.test(u)).slice(0, 5);
    ctx.emit({ type: 'document', value: c.id, confidence: 'confirmed', url: `https://nvd.nist.gov/vuln/detail/${c.id}`, raw: { kind: 'nvd-cve', status: c.vulnStatus, published: c.published, lastModified: c.lastModified, description: en ? clip(en.value, 500) : undefined, cvss: pickCvss(c.metrics), cwes, exploitedInTheWild: c.cisaExploitAdd ? { added: c.cisaExploitAdd, due: c.cisaActionDue } : undefined, references: refs, attribution: meta.attribution } });
  }
  if (input.kind === 'keyword' && Number(doc.totalResults) > items.length) ctx.note(`${doc.totalResults} CVEs match; the first ${items.length} are shown`);
  ctx.note('scores are the NVD\'s own; a CVE without a score has not been analysed yet');
  ctx.progress(1);
}
module.exports = { meta, run, budget };
