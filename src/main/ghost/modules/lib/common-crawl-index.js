'use strict';
// Common Crawl index: which pages of a domain the most recent crawl captured. Reads the public index only; it does not download any
// archived page content.
const { ModuleError, needDomain, clip, isoDate } = require('./core');
const K = require('./keyless-common');

const meta = {
  id: 'common-crawl-index', tool: 'commoncrawl-cdx', name: 'Web crawl index (Common Crawl)', version: '1.0.0',
  description: 'Lists pages of a domain captured by the latest Common Crawl crawl: address, capture time, status and type. Index lookup only.',
  capabilities: ['web-archive', 'commoncrawl', 'domains', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['index.commoncrawl.org'], client: { rps: 1, maxRequests: 2, timeoutMs: 45000, maxBytes: 2097152 },
  restrictions: 'Common Crawl asks for polite use and answers with errors when asked too fast: at most one request a second and two a run, up to 100 captures. Index lookups only: archived page content is not downloaded. The crawl samples the web, so a page that is not listed may still exist. Use it for organisations and sites, not to follow a private individual.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Data: Common Crawl (commoncrawl.org), subject to the Common Crawl Terms of Use',
  dataTerms: 'Common Crawl terms of use; archived content stays under its original owner\'s rights',
  inputs: [
    { name: 'domain', type: 'string', label: 'Domain', maxLength: 253, pattern: '^[A-Za-z0-9._-]+$' },
    { name: 'limit', type: 'integer', label: 'Most captures', required: false, min: 1, max: 100 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { domain: 'example.com', limit: 3 }, expect: { minResults: 1 } },
};
const CRAWL_RE = /^CC-MAIN-\d{4}-\d{2}$/;
const ts = (t) => { const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(t)); return m ? isoDate(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null; };

async function run(ctx, input) {
  const domain = needDomain(input.domain);
  const limit = K.intOr(input.limit, 25, 1, 100);
  ctx.progress(0.1, 'finding the latest crawl');
  const ci = await ctx.client.get('https://index.commoncrawl.org/collinfo.json', { purpose: 'cc-crawls' });
  if (ci.status === 404) throw new ModuleError('unavailable', 'the Common Crawl crawl list did not answer at its address');
  const crawls = ci.json();
  if (!Array.isArray(crawls)) throw new ModuleError('bad-response', 'the Common Crawl crawl list has an unexpected shape');
  const ids = crawls.map((c) => c && c.id).filter((id) => typeof id === 'string' && CRAWL_RE.test(id)).sort();
  if (!ids.length) throw new ModuleError('bad-response', 'the Common Crawl crawl list names no crawl');
  const crawl = ids[ids.length - 1];
  ctx.progress(0.5, 'looking up ' + domain);
  const res = await ctx.client.get(`https://index.commoncrawl.org/${crawl}-index?url=${encodeURIComponent(domain)}&matchType=domain&output=json&limit=${limit}&fl=url,timestamp,status,mime,digest,languages`, { accept: 'application/json, text/plain', purpose: 'cc-lookup' });
  const body = res.text.trim();
  if (res.status === 404 || !body) { ctx.note(`${crawl} holds no capture of this domain`); return; }
  let rows = 0, bad = 0;
  for (const line of body.split('\n').slice(0, limit)) {
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    if (o && typeof o.message === 'string' && !o.url) { ctx.note(`${crawl}: ${clip(o.message, 120)}`); return; }
    let u;
    try { u = new URL(o && o.url); } catch { bad++; continue; }
    if (!/^https?:$/.test(u.protocol)) { bad++; continue; }
    rows++;
    ctx.emit({ type: 'url', value: u.href, confidence: 'confirmed', raw: { kind: 'commoncrawl-capture', crawl, captured: ts(o.timestamp) || undefined, status: o.status, mime: o.mime ? clip(o.mime, 80) : undefined, digest: o.digest, languages: o.languages, attribution: meta.attribution } });
  }
  if (!rows && bad) throw new ModuleError('bad-response', 'the Common Crawl index did not return capture lines');
  if (bad) ctx.note(`${bad} unreadable line(s) skipped`);
  ctx.note(`captures are from crawl ${crawl} only; other crawls may hold other pages`);
  ctx.progress(1);
}
module.exports = { meta, run };
