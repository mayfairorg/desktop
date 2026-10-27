'use strict';
// SEC EDGAR: company search (by name, ticker or CIK) and a company's recent filings list. Public US filings of companies. SEC requires a
// descriptive User-Agent with a contact and caps use at 10 requests a second; this connector stays at 5.
const { ModuleError, clip } = require('./core');
const K = require('./keyless-common');

// SEC's fair-access rules ask for "company name and contact email" in the User-Agent. Replace the contact with the address the
// Mayfair Organization wants SEC to write to before release (the placeholder below is not a working mailbox).
const CONTACT = 'ghost-support@mayfair.invalid';
const USER_AGENT = `Mayfair Organization MayfairGhost/1.0 ${CONTACT}`;

const meta = {
  id: 'sec-edgar', tool: 'sec-edgar', name: 'US company filings (SEC EDGAR)', version: '1.0.0',
  description: 'Finds US-listed companies by name, ticker or CIK and lists their recent public filings (form type, date, link) from the SEC.',
  capabilities: ['companies', 'filings', 'sec', 'passive'], scope: 'passive', network: 'rate-limited',
  hosts: ['data.sec.gov', 'www.sec.gov'], client: { rps: 5, maxRequests: 4, timeoutMs: 30000, maxBytes: 8388608 },
  restrictions: 'The SEC requires an identifying User-Agent and allows at most 10 requests a second; this connector sends 5 a second at most. The company list covers companies with a stock ticker. Filings by company insiders (forms 3, 4, 5 and 144) are left out unless asked for, because they are about individuals. Organisations only.',
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' },
  attribution: 'Source: U.S. Securities and Exchange Commission, EDGAR (public information)',
  dataTerms: 'SEC EDGAR data is public information of the US government; see sec.gov/os/accessing-edgar-data for fair access',
  inputs: [
    { name: 'kind', type: 'enum', label: 'Look up', values: ['company', 'filings'] },
    { name: 'query', type: 'string', label: 'Company name, ticker or CIK', minLength: 1, maxLength: 120 },
    { name: 'types', type: 'string', label: 'Form types, e.g. 10-K,8-K (filings only)', required: false, maxLength: 60, pattern: '^[A-Za-z0-9/,-]{1,60}$' },
    { name: 'limit', type: 'integer', label: 'Most results', required: false, min: 1, max: 100 },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { kind: 'company', query: 'Apple Inc', limit: 3 }, expect: { minResults: 1 } },
};
const INSIDER = new Set(['3', '3/A', '4', '4/A', '5', '5/A', '144', '144/A']);
const pad = (cik) => String(cik).padStart(10, '0');
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);

async function get(ctx, url, purpose) {
  try { return await ctx.client.get(url, { purpose, headers: { 'user-agent': USER_AGENT } }); } catch (e) {
    return K.reword403(ctx, e, 'the SEC refused the request (HTTP 403): this usually means its fair-access limit or User-Agent rule was not met; wait a minute and try again');
  }
}
async function searchCompanies(ctx, q) {
  const res = await get(ctx, 'https://www.sec.gov/files/company_tickers.json', 'edgar-companies');
  if (res.status === 404) throw new ModuleError('unavailable', 'the SEC company list did not answer at its address');
  const doc = res.json();
  const rows = doc && typeof doc === 'object' ? Object.values(doc) : null;
  if (!rows || (rows.length && !rows.every((r) => r && Number.isInteger(r.cik_str) && typeof r.title === 'string'))) throw new ModuleError('bad-response', 'the SEC company list has an unexpected shape');
  const qs = q.trim();
  if (/^\d{1,10}$/.test(qs)) return rows.filter((r) => r.cik_str === Number(qs)).map((r) => ({ r, rank: 0 }));
  const up = qs.toUpperCase(), qw = words(qs);
  if (!qw.length) throw new ModuleError('bad-input', 'enter a company name, ticker or CIK');
  const out = [];
  for (const r of rows) {
    const tw = words(r.title), t = tw.join(' ');
    let rank = -1;
    if (String(r.ticker).toUpperCase() === up) rank = 0;
    else if (t === qw.join(' ')) rank = 1;
    else if (t.startsWith(qw.join(' '))) rank = 2;
    else if (qw.every((w) => tw.includes(w) || tw.some((x) => x.startsWith(w)))) rank = 3;
    if (rank >= 0) out.push({ r, rank });
  }
  return out.sort((a, b) => a.rank - b.rank || a.r.title.length - b.r.title.length);
}
const orgEntity = (ctx, r, conf) => ctx.emit({ type: 'org', value: clip(r.title, 300), confidence: conf, url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${pad(r.cik_str)}`, raw: { kind: 'sec-registrant', cik: pad(r.cik_str), ticker: r.ticker || undefined, exchange: r.exchange || undefined, attribution: meta.attribution } });

async function run(ctx, input) {
  const q = String(input.query || '').trim();
  K.refuseContactShape(q);
  const limit = K.intOr(input.limit, input.kind === 'filings' ? 25 : 10, 1, 100);
  ctx.progress(0.1, 'asking the SEC');
  if (input.kind === 'company') {
    const found = await searchCompanies(ctx, q);
    if (!found.length) { ctx.note('no company with a ticker matches (the list covers companies that have a stock ticker)'); return; }
    for (const { r, rank } of found.slice(0, limit)) orgEntity(ctx, r, rank <= 1 ? 'confirmed' : 'likely');
    ctx.note('matched on name, ticker or CIK text; check the CIK before relying on a match');
  } else if (input.kind === 'filings') {
    let cik, company = null;
    if (/^\d{1,10}$/.test(q)) cik = Number(q);
    else {
      const found = await searchCompanies(ctx, q);
      if (!found.length) { ctx.note('no company with a ticker matches; enter its CIK to list filings of a company without one'); return; }
      if (found[0].rank > 1 && found.length > 1) throw new ModuleError('bad-input', `"${clip(q, 60)}" matches several companies (${found.slice(0, 3).map((f) => f.r.title).join('; ')}); search by company first and use its CIK`);
      company = found[0].r; cik = company.cik_str;
    }
    if (!(cik > 0)) throw new ModuleError('bad-input', 'the CIK must be a positive number');
    const res = await get(ctx, `https://data.sec.gov/submissions/CIK${pad(cik)}.json`, 'edgar-submissions');
    if (res.status === 404) { ctx.note('the SEC has no filer with this CIK'); return; }
    const doc = res.json();
    const recent = doc && doc.filings && doc.filings.recent;
    if (!recent || !Array.isArray(recent.accessionNumber) || !Array.isArray(recent.form) || !Array.isArray(recent.filingDate)) throw new ModuleError('bad-response', 'the SEC answered in a shape that is not a filing list');
    if (doc.entityType === 'individual' || (doc.insiderTransactionForOwnerExists === 1 && doc.insiderTransactionForIssuerExists !== 1 && !doc.sic)) { ctx.note('this CIK looks like an individual filer, not a company: withheld (organisations only)'); return; }
    const name = typeof doc.name === 'string' ? doc.name : (company && company.title);
    if (name) orgEntity(ctx, { title: name, cik_str: cik, ticker: Array.isArray(doc.tickers) ? doc.tickers[0] : undefined, exchange: Array.isArray(doc.exchanges) ? doc.exchanges[0] : undefined }, 'confirmed');
    const want = input.types ? new Set(String(input.types).toUpperCase().split(',').map((s) => s.trim()).filter(Boolean)) : null;
    let n = 0, hidden = 0;
    for (let i = 0; i < recent.accessionNumber.length && n < limit; i++) {
      const acc = recent.accessionNumber[i], form = String(recent.form[i] || ''), date = recent.filingDate[i];
      if (!/^\d{10}-\d{2}-\d{6}$/.test(acc) || !/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !/^[A-Za-z0-9/ -]{1,20}$/.test(form)) continue;
      if (want ? !want.has(form.toUpperCase()) : INSIDER.has(form.toUpperCase())) { if (!want) hidden++; continue; }
      const doc1 = Array.isArray(recent.primaryDocument) ? recent.primaryDocument[i] : '';
      const link = /^[A-Za-z0-9._-]{1,120}$/.test(String(doc1)) ? `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${doc1}` : `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}-index.htm`;
      const desc = Array.isArray(recent.primaryDocDescription) && recent.primaryDocDescription[i] ? clip(recent.primaryDocDescription[i], 120) : undefined;
      ctx.emit({ type: 'document', value: clip(`${form} filed ${date}${name ? ' by ' + name : ''}`, 300), url: link, raw: { kind: 'sec-filing', cik: pad(cik), accession: acc, form, filingDate: date, reportDate: recent.reportDate && recent.reportDate[i] ? recent.reportDate[i] : undefined, description: desc, attribution: meta.attribution } });
      n++;
    }
    if (hidden) ctx.note(`${hidden} insider-transaction filing(s) (forms 3, 4, 5, 144) left out; ask for them with the form types box if the case needs them`);
    if (!n) ctx.note('no filings match');
    ctx.note('this is the recent-filings window the SEC returns first; older filings sit in archive files this connector does not fetch');
  } else throw new ModuleError('bad-input', 'kind must be company or filings');
  ctx.progress(1);
}
module.exports = { meta, run, USER_AGENT };
