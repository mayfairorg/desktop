'use strict';
// Internet Archive: Wayback Machine capture history (CDX index) and nearest capture. Read only: it never asks the archive to save a page
// (that writes to a third party and belongs to a separate, confirmed action) and never contacts the investigated host.
const { ModuleError, isDnsName, toAscii, isoDate } = require('./core');

const meta = {
  id: 'wayback-cdx', tool: 'wayback-cdx', name: 'Web archive history (Wayback)', version: '1.0.0',
  description: 'Capture history of a domain or page in the Internet Archive: first and last capture, a list of captures, or the capture nearest a date.',
  capabilities: ['web-archive', 'wayback', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['web.archive.org', 'archive.org'], client: { rps: 1, maxRequests: 6, timeoutMs: 30000, maxBytes: 2097152 },
  restrictions: 'The Internet Archive asks for polite use and may throttle: at most one request per second. Read only. The archive holds copies of public pages; use it for organisations, sites and events, not to follow a private individual.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'Internet Archive terms of use; archived content stays under its original owner\'s rights',
  inputs: [
    { name: 'target', type: 'string', label: 'Domain or page address', maxLength: 1000 },
    { name: 'mode', type: 'enum', label: 'Mode', required: false, values: ['summary', 'snapshots', 'closest'] },
    { name: 'timestamp', type: 'string', label: 'Nearest to (YYYY, YYYYMM, YYYYMMDD...)', required: false, maxLength: 14, pattern: '^[0-9]{4,14}$' },
    { name: 'limit', type: 'integer', label: 'Most captures to list', required: false, min: 1, max: 500 },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { target: 'example.com', mode: 'summary' }, expect: { minResults: 2 } },
};

// A bare host, host/path, or http(s) address. Returns the text the archive expects (no scheme).
function normaliseTarget(t) {
  let s = String(t || '').trim();
  if (!s || /[\s<>"'`\\]/.test(s)) throw new ModuleError('bad-input', 'enter a domain or a page address');
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (m) { if (!/^https?$/i.test(m[1])) throw new ModuleError('bad-input', 'only http and https addresses are accepted'); s = s.slice(m[0].length); }
  const slash = s.search(/[/?#]/);
  const host = toAscii((slash < 0 ? s : s.slice(0, slash)).replace(/:\d+$/, '').replace(/^[^@]*@/, ''));
  if (!isDnsName(host)) throw new ModuleError('bad-input', 'enter a domain name or a page address with a domain name');
  return host + (slash < 0 ? '' : s.slice(slash).replace(/#.*$/, ''));
}
const tsIso = (ts) => { const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(ts)); return m ? isoDate(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null; };
const snapUrl = (ts, orig) => `https://web.archive.org/web/${ts}/${orig}`;

async function cdx(ctx, target, params, purpose) {
  const q = Object.entries({ url: target, output: 'json', ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const res = await ctx.client.get(`https://web.archive.org/cdx/search/cdx?${q}`, { purpose });
  if (res.status === 404) return [];
  const t = res.text.trim();
  if (!t) return [];
  let rows;
  try { rows = JSON.parse(t); } catch { throw new ModuleError('bad-response', 'the archive did not return JSON'); }
  if (!Array.isArray(rows) || (rows.length && !Array.isArray(rows[0]))) throw new ModuleError('bad-response', 'the archive returned an unexpected shape');
  const head = rows[0] || [];
  return rows.slice(1).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]]))).filter((r) => /^\d{14}$/.test(r.timestamp || '') && typeof r.original === 'string');
}

async function run(ctx, input) {
  const target = normaliseTarget(input.target);
  const mode = input.mode || 'summary';
  const fl = 'timestamp,original,statuscode,mimetype,digest';
  if (mode === 'summary') {
    ctx.progress(0.1, 'first capture');
    const first = await cdx(ctx, target, { fl, limit: 1 }, 'cdx-first');
    if (!first.length) { ctx.note('the archive has no capture of this address'); return; }
    ctx.progress(0.5, 'last capture');
    const last = await cdx(ctx, target, { fl, limit: -1 }, 'cdx-last');
    const years = await cdx(ctx, target, { fl: 'timestamp,original', collapse: 'timestamp:4' }, 'cdx-years');
    const f = first[0], l = last[0] || first[0];
    ctx.emit({ type: 'event', value: `first capture of ${target}: ${tsIso(f.timestamp).slice(0, 10)}`, url: snapUrl(f.timestamp, f.original), raw: { kind: 'wayback-first', t: tsIso(f.timestamp), status: f.statuscode, mime: f.mimetype } });
    ctx.emit({ type: 'event', value: `last capture of ${target}: ${tsIso(l.timestamp).slice(0, 10)}`, url: snapUrl(l.timestamp, l.original), raw: { kind: 'wayback-last', t: tsIso(l.timestamp), status: l.statuscode, mime: l.mimetype } });
    ctx.emit({ type: 'url', value: snapUrl(f.timestamp, f.original), raw: { rel: 'first-capture', timestamp: f.timestamp } });
    ctx.emit({ type: 'url', value: snapUrl(l.timestamp, l.original), raw: { rel: 'last-capture', timestamp: l.timestamp } });
    if (years.length) ctx.emit({ type: 'event', value: `captured in ${years.length} calendar year(s): ${years.map((y) => y.timestamp.slice(0, 4)).join(', ')}`.slice(0, 400), raw: { kind: 'wayback-years', years: years.map((y) => y.timestamp.slice(0, 4)) } });
  } else if (mode === 'snapshots') {
    const limit = Number.isInteger(+input.limit) && +input.limit > 0 ? Math.min(+input.limit, 500) : 100;
    ctx.progress(0.2, 'listing captures');
    const rows = await cdx(ctx, target, { fl, collapse: 'timestamp:6', limit }, 'cdx-list');
    if (!rows.length) { ctx.note('the archive has no capture of this address'); return; }
    ctx.note(`one capture per month, up to ${limit}`);
    for (const r of rows) ctx.emit({ type: 'url', value: snapUrl(r.timestamp, r.original), raw: { timestamp: r.timestamp, t: tsIso(r.timestamp), status: r.statuscode, mime: r.mimetype, digest: r.digest } });
  } else if (mode === 'closest') {
    ctx.progress(0.2, 'finding the nearest capture');
    const q = `https://archive.org/wayback/available?url=${encodeURIComponent(target)}${input.timestamp ? '&timestamp=' + encodeURIComponent(input.timestamp) : ''}`;
    const res = await ctx.client.get(q, { purpose: 'availability' });
    const doc = res.status === 404 ? {} : res.json();
    const c = doc && doc.archived_snapshots && doc.archived_snapshots.closest;
    if (!c || c.available !== true || !/^\d{14}$/.test(c.timestamp || '')) { ctx.note('the archive has no capture near that date'); return; }
    const u = (() => { try { return new URL(String(c.url).replace(/^http:/, 'https:')); } catch { return null; } })();
    if (!u || u.hostname !== 'web.archive.org') throw new ModuleError('bad-response', 'the archive answered with an address on another host');
    ctx.emit({ type: 'url', value: u.href, url: res.url, raw: { timestamp: c.timestamp, t: tsIso(c.timestamp), status: c.status, rel: 'nearest-capture' } });
    ctx.emit({ type: 'event', value: `nearest capture of ${target}: ${tsIso(c.timestamp).slice(0, 10)}`, url: u.href, raw: { kind: 'wayback-closest', t: tsIso(c.timestamp) } });
  } else throw new ModuleError('bad-input', 'mode must be summary, snapshots or closest');
  ctx.progress(1);
}
module.exports = { meta, run, normaliseTarget };
