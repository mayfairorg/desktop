'use strict';
// GDELT DOC 2.0: news coverage of an organisation, domain, place or topic. Passive: reads GDELT's public index only.
const { ModuleError, needDomain, isoDate, clip } = require('./core');

const meta = {
  id: 'gdelt-doc', tool: 'gdelt-doc-2.0', name: 'News coverage (GDELT)', version: '1.0.0',
  description: 'Recent news articles or a coverage-volume timeline for an organisation, a domain, a place or a topic, from the GDELT project.',
  capabilities: ['news', 'gdelt', 'timeline', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['api.gdeltproject.org'], client: { rps: 0.2, maxRequests: 2, timeoutMs: 30000, maxBytes: 2097152 },
  restrictions: 'GDELT asks for one request every 5 seconds and offers no guarantee of availability. Use free to use with citation of GDELT. This module is for organisations, domains, places and topics: queries that look like a person\'s contact details (an email address, a phone number, a handle) are refused, and it must not be used to follow or profile a private individual.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, dataTerms: 'GDELT Project data, free to use with citation',
  inputs: [
    { name: 'kind', type: 'enum', label: 'What the query names', values: ['organisation', 'domain', 'place', 'topic'] },
    { name: 'query', type: 'string', label: 'Query', minLength: 2, maxLength: 120 },
    { name: 'mode', type: 'enum', label: 'Result', required: false, values: ['articles', 'timeline'] },
    { name: 'timespan', type: 'enum', label: 'Period', required: false, values: ['1d', '7d', '1month', '3months'] },
  ],
  files: ['core.js', 'runtime.js'],
  selfTest: { input: { kind: 'organisation', query: 'United Nations', mode: 'articles', timespan: '7d' }, expect: { minResults: 1 } },
};
const MAX_ARTICLES = 75;

function buildQuery(kind, raw) {
  const q = String(raw || '').trim();
  if (kind === 'domain') return `domain:${needDomain(q)}`;
  if (/@/.test(q) || /(?:\+?\d[\s().-]*){8,}/.test(q) || /^[#@]/.test(q) || /[/\\]/.test(q) || /^https?:/i.test(q)) throw new ModuleError('bad-input', 'this module takes an organisation, place or topic, not an email address, phone number, handle or address');
  const clean = q.replace(/["()<>\[\]{}:]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length < 2) throw new ModuleError('bad-input', 'the query is too short');
  return /\s/.test(clean) ? `"${clean}"` : clean;
}
const gdeltDate = (s) => { const m = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/.exec(String(s)); return m ? isoDate(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : null; };

async function run(ctx, input) {
  const query = buildQuery(input.kind, input.query);
  const mode = input.mode || 'articles', span = input.timespan || '7d';
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=${mode === 'timeline' ? 'timelinevol' : 'artlist'}&format=json&timespan=${span}${mode === 'articles' ? `&maxrecords=${MAX_ARTICLES}&sort=datedesc` : ''}`;
  ctx.progress(0.2, 'asking GDELT');
  const res = await ctx.client.get(url, { purpose: 'gdelt-' + mode });
  const text = res.text.trim();
  if (res.status === 404 || !text) { ctx.note('GDELT returned nothing for this query'); return; }
  let doc;
  try { doc = JSON.parse(text); } catch {
    // GDELT answers errors in plain text with HTTP 200
    if (/limit requests|one every|too many/i.test(text)) throw new ModuleError('rate-limited', 'GDELT asked us to slow down (one request every 5 seconds)');
    if (/too short|too long|invalid|not valid|illegal/i.test(text)) throw new ModuleError('bad-input', 'GDELT rejected the query: ' + clip(text, 160));
    throw new ModuleError('bad-response', 'GDELT did not return JSON');
  }
  if (mode === 'articles') {
    const arts = Array.isArray(doc.articles) ? doc.articles : [];
    if (!arts.length) { ctx.note('no articles in this period'); return; }
    for (const a of arts.slice(0, MAX_ARTICLES)) {
      let u;
      try { u = new URL(a.url); } catch { continue; }
      if (!/^https?:$/.test(u.protocol)) continue;
      ctx.emit({ type: 'url', value: u.href, confidence: 'likely', url: res.url, raw: { title: clip(a.title || '', 300), domain: a.domain, seen: gdeltDate(a.seendate), language: a.language, sourceCountry: a.sourcecountry, query } });
    }
    ctx.note('GDELT matches words in articles; relevance is not verified');
  } else {
    const series = Array.isArray(doc.timeline) && doc.timeline[0] && Array.isArray(doc.timeline[0].data) ? doc.timeline[0].data : [];
    if (!series.length) { ctx.note('no coverage in this period'); return; }
    for (const p of series.slice(-200)) {
      const t = gdeltDate(p.date);
      if (t && Number.isFinite(p.value)) ctx.emit({ type: 'event', value: `news volume ${t.slice(0, 16).replace('T', ' ')}Z: ${p.value}% of monitored coverage`, confidence: 'likely', url: res.url, raw: { kind: 'news-volume', t, volumePercent: p.value, query } });
    }
  }
  ctx.progress(1);
}
module.exports = { meta, run, buildQuery };
