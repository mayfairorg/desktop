'use strict';
// Ghost app: the master search.
//   classify(query)  pure and deterministic: what kind of thing was typed, and the other readings the person can choose instead.
//   Search.run(...)  runs every READY tool that accepts the kind, at once, through the existing job runner (passive tools only, no scope needed),
//                    and streams one event per tool. It never throws to the page and never runs anything that is not ready.
// The kinds are a closed list. There is no person, username, email-account or phone kind anywhere in it.
const net = require('node:net');
const url = require('node:url');
const crypto = require('node:crypto');
const M = require('../manifest');
const TM = require('./toolmap');

const KINDS = ['domain', 'ip', 'cidr', 'asn', 'url', 'cert-hash', 'org-name', 'lei', 'file', 'place-text', 'coords', 'keyword'];
const MAX_QUERY = 2000;

// ---------- classify ----------
const FILE_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'txt', 'rtf', 'csv', 'json', 'xml', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'heic', 'svg', 'mp3', 'mp4', 'avi', 'mkv', 'wav', 'rar', 'gz', 'tar', '7z', 'exe', 'dll', 'bin', 'iso', 'dmg', 'apk', 'js', 'py', 'java', 'md', 'log', 'tmp', 'bak', 'docm', 'eml', 'msg', 'pst']);
const LABEL = /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)$/i;
const ORG_WORD = /\b(inc|incorporated|ltd|limited|llc|llp|lp|plc|gmbh|ag|sa|sarl|sas|spa|srl|bv|nv|pty|pte|corp|corporation|company|co|holdings?|group|foundation|association|university|institute|bank|trust|partners|ventures|industries|international|technologies|laboratories|council|ministry|department|agency|authority|committee|society|church|hospital|college|school)\.?$/i;
const PLACE_WORD = /\b(street|st|road|rd|avenue|ave|lane|ln|boulevard|blvd|drive|square|terrace|crescent|highway|hwy|mount|mt|mountain|lake|river|island|isle|bay|port|harbou?r|airport|station|bridge|tower|castle|palace|temple|cathedral|abbey|mosque|park|beach|valley|desert|forest|canyon|falls|peninsula|strait|glacier|volcano|stadium|museum|monument|memorial|quarry|refinery)\b/i;

const ipNorm = (s) => (net.isIPv6(s) ? s.toLowerCase() : s);
function toDomain(host) {
  let h = String(host || '').trim().replace(/\.$/, '');
  if (!h || h.length > 253) return null;
  if (/[^\x00-\x7f]/.test(h)) { h = url.domainToASCII(h); if (!h) return null; }
  h = h.toLowerCase();
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return null;
  if (FILE_EXT.has(tld)) return null;       // "report.pdf" is a file name, not a site
  return h;
}
function toCidr(s) {
  const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(s);
  if (!m) return null;
  const v = net.isIP(m[1]), bits = Number(m[2]);
  if (!v || bits > (v === 4 ? 32 : 128)) return null;
  return ipNorm(m[1]) + '/' + bits;
}
function toCoords(s) {
  // 51.5007, -0.1246   |   51.5007 -0.1246   |   51.5007° N, 0.1246° W
  const h = /^(-?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])?$/i.exec(s);
  if (!h) return null;
  let lat = Number(h[1]), lon = Number(h[3]);
  if (h[2]) { if (lat < 0) return null; if (/s/i.test(h[2])) lat = -lat; }
  if (h[4]) { if (lon < 0) return null; if (/w/i.test(h[4])) lon = -lon; }
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
  if (!h[2] && !h[4] && !/[,;.]/.test(s)) return null;        // two bare whole numbers with only a space between are not taken for a position
  const r = (n) => String(Math.round(n * 1e6) / 1e6);
  return r(lat) + ',' + r(lon);
}
function toUrl(s) {
  let t = s;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    const host = /^([^\s/?#]+)[/?#]/.exec(t);
    if (/\s/.test(t) || !host || /@/.test(host[1]) || !toDomain(host[1].replace(/:\d{1,5}$/, ''))) return null;      // "example.com/page", never plain text
    t = 'https://' + t;
  }
  if (/\s/.test(t)) return null;
  let u; try { u = new URL(t); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  u.hash = '';
  return u;
}
const textKind = (s) => {
  if (ORG_WORD.test(s.replace(/[,]+$/, '')) && /[A-Za-z]/.test(s)) return 'org-name';
  if (PLACE_WORD.test(s) || /^\d{1,5}\s+[A-Za-z]/.test(s)) return 'place-text';
  const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length === 2 && parts.every((p) => /^[\p{Lu}][\p{L}.' -]{1,40}$/u.test(p) && p.split(/\s+/).length <= 4)) return 'place-text';
  return 'keyword';
};
const str = (q) => { try { return String(q === undefined || q === null ? '' : q); } catch { return ''; } };
const clean = (q) => str(q).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY);

// -> { kind, value, alternatives:[{kind,value}] }
function classify(query) {
  const q = clean(query);
  const out = (kind, value, alts = []) => {
    const seen = new Set([kind + '\0' + value]);
    const alternatives = [];
    for (const a of alts) { if (!a || !a.value || seen.has(a.kind + '\0' + a.value)) continue; seen.add(a.kind + '\0' + a.value); alternatives.push({ kind: a.kind, value: a.value }); }
    return { kind, value, alternatives };
  };
  const text = (v) => [{ kind: 'org-name', value: v }, { kind: 'place-text', value: v }, { kind: 'keyword', value: v }];
  if (!q) return out('keyword', '', []);
  // the shapes that cannot be anything else first
  const cidr = toCidr(q); if (cidr) return out('cidr', cidr, [{ kind: 'ip', value: cidr.split('/')[0] }, { kind: 'keyword', value: q }]);
  if (net.isIP(q)) return out('ip', ipNorm(q), [{ kind: 'keyword', value: q }]);
  const asn = /^AS\s?(\d{1,10})$/i.exec(q); if (asn && Number(asn[1]) <= 4294967295) return out('asn', 'AS' + Number(asn[1]), [{ kind: 'keyword', value: q }]);
  const hex = q.replace(/[:\s-]/g, '');
  if ((/^[0-9a-f]{64}$/i.test(hex) || /^[0-9a-f]{40}$/i.test(hex)) && /^[0-9a-f]{2}(?:[:\s-]?[0-9a-f]{2})*$/i.test(q)) return out('cert-hash', hex.toLowerCase(), [{ kind: 'keyword', value: q }]);
  if (/^[A-Z0-9]{18}[0-9]{2}$/i.test(q) && /[A-Z]/i.test(q)) return out('lei', q.toUpperCase(), [{ kind: 'keyword', value: q }, { kind: 'org-name', value: q }]);
  const co = toCoords(q); if (co) return out('coords', co, [{ kind: 'place-text', value: q }, { kind: 'keyword', value: q }]);
  const u = toUrl(q);
  if (u) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const alts = net.isIP(host) ? [{ kind: 'ip', value: ipNorm(host) }] : (toDomain(host) ? [{ kind: 'domain', value: toDomain(host) }] : []);
    return out('url', u.href, [...alts, { kind: 'keyword', value: q }]);
  }
  // something@something: a keyword unless the person picks the domain part; no account handling of any kind
  const mail = /^[^@\s]+@([^@\s]+)$/.exec(q);
  if (mail) { const d = toDomain(mail[1]); return out('keyword', q, d ? [{ kind: 'domain', value: d }] : []); }
  const dom = toDomain(q.replace(/^\*\./, ''));
  if (dom && !/\s/.test(q)) return out('domain', dom, [{ kind: 'keyword', value: q }]);
  const k = textKind(q);
  const first = { kind: k, value: q };
  return out(k, q, text(q).filter((a) => a.kind !== first.kind));
}

// A kind chosen by the person (or the page): the value is cleaned the way classify would, and must really be that kind.
function normalise(kind, raw) {
  const q = clean(raw);
  if (!KINDS.includes(kind)) return { ok: false, error: 'That kind of search is not available.' };
  if (kind === 'file') return /^[A-Za-z0-9_-]{8,128}$/.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false, error: 'Choose a file first.' };
  if (!q) return { ok: false, error: 'Type something to look up.' };
  const bad = (what) => ({ ok: false, error: 'That does not look like ' + what + '.' });
  switch (kind) {
    case 'domain': { const u = toUrl(q); const d = toDomain(u ? u.hostname : q.replace(/^\*\./, '')); return d ? { ok: true, value: d } : bad('a domain name'); }
    case 'ip': return net.isIP(q) ? { ok: true, value: ipNorm(q) } : bad('an IP address');
    case 'cidr': { const c = toCidr(q); return c ? { ok: true, value: c } : bad('a network range such as 192.0.2.0/24'); }
    case 'asn': { const a = /^AS\s?(\d{1,10})$/i.exec(q); return a ? { ok: true, value: 'AS' + Number(a[1]) } : bad('an AS number such as AS15169'); }
    case 'url': { const u = toUrl(q); return u ? { ok: true, value: u.href } : bad('a web address'); }
    case 'cert-hash': { const h = q.replace(/[:\s-]/g, ''); return /^[0-9a-f]{64}$|^[0-9a-f]{40}$/i.test(h) ? { ok: true, value: h.toLowerCase() } : bad('a SHA-256 or SHA-1 fingerprint'); }
    case 'lei': return /^[A-Z0-9]{18}[0-9]{2}$/i.test(q) ? { ok: true, value: q.toUpperCase() } : bad('a 20-character LEI');
    case 'coords': { const c = toCoords(q); return c ? { ok: true, value: c } : bad('a latitude and longitude such as 51.5007, -0.1246'); }
    default: return { ok: true, value: q };       // org-name, place-text, keyword
  }
}

// ---------- the search itself ----------
const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });
const TERMINAL_BAD = new Set(['failed', 'timed-out']);

class Search {
  // setup: a BuiltinSetup (row(id) -> { state, note, ... }). manager: ConnectorManager (get). runner: JobRunner (submit, wait, cancel). picks: PickStore.
  constructor({ setup, manager, runner, picks = null, log = null, emit = () => {}, now = Date.now, blocked = () => false, maxParallel = 6, queueRetryMs = 250, queueRetries = 80 } = {}) {
    this.setup = setup; this.manager = manager; this.runner = runner; this.picks = picks; this.log = log; this.emit = emit; this.now = now;
    this.blocked = blocked; this.maxParallel = maxParallel; this.queueRetryMs = queueRetryMs; this.queueRetries = queueRetries;
    this.live = new Map();           // searchId -> { cancelled, jobs:Set }
    this.finished = new Set();
  }
  classify(q) { return classify(q && typeof q === 'object' ? q.query : q); }
  _send(p) { try { this.emit('search', p); } catch { /* the window is gone */ } }
  _warn(ev, f) { if (this.log) { try { this.log.warn(ev, f); } catch { /* ok */ } } }

  // Which tools would take part. -> { tools:[{id, row, input}], skipped:[{tool, state, note}] }
  // A search asks only tools that are ready and take this kind. A tool that takes it but is not ready (needs a program, switched off, still setting up,
  // failed) is reported in `skipped` with its own state and note, never run and never shown as a failure of the search. Naming tools asks exactly those.
  plan({ kind, value, tools = null }) {
    const picked = [], skipped = [], explicit = !!tools;
    const ids = explicit ? [...new Set(tools)] : require('../modules').MODULES.map((m) => m.meta.id);
    for (const id of ids) {
      const map = TM.info(id);
      const row = this.setup ? this.setup.row(id) : null;
      if (!row) { skipped.push({ tool: id, state: 'failed', note: 'That tool is not part of Ghost.' }); continue; }
      if (this.blocked({ id, name: row.name })) { skipped.push({ tool: id, state: 'failed', note: 'Ghost does not run tools that look up individual people.' }); continue; }
      const accepts = !!map && !map.own && map.kinds.includes(kind);
      if (!explicit && !accepts) continue;
      if (row.state !== 'ready') { skipped.push({ tool: id, state: row.state, note: row.note || row.state }); continue; }
      if (!accepts) { skipped.push({ tool: id, state: 'ready', note: 'This tool does not take that kind of input here. Open its own page.' }); continue; }
      const e = this.manager.get(id);
      if (!e || e.scope === 'active') { skipped.push({ tool: id, state: 'failed', note: 'Not available in a search.' }); continue; }
      let input; try { input = map.input(kind, value); } catch { input = null; }
      const v = input ? M.validateInput({ input: e.input }, input) : { ok: false, errors: ['it needs its own page'] };
      if (!v.ok) { if (explicit) skipped.push({ tool: id, state: 'ready', note: 'This tool cannot take that input: ' + v.errors[0] }); continue; }
      picked.push({ id, row, input });
    }
    return { tools: picked, skipped };
  }

  // -> { ok, searchId, kind, value, tools:[id], skipped:[...] } or { ok:false, code, error }. Never throws.
  run(o) {
    try {
      const q = o && typeof o === 'object' ? o : {};
      if (typeof q.query !== 'string') return { ok: false, code: 'bad-input', error: 'Type something to look up.' };
      const cl = q.kind ? null : classify(q.query);
      const kind = q.kind || cl.kind;
      const n = q.kind ? normalise(kind, q.query) : (kind === 'keyword' && !cl.value ? { ok: false, error: 'Type something to look up.' } : { ok: true, value: cl.value });
      if (!n.ok) return { ok: false, code: 'bad-input', error: n.error };
      const value = n.value;
      if (kind === 'file' && !(this.picks && this.picks.peek(value))) return { ok: false, code: 'bad-input', error: 'The chosen file is no longer available. Choose it again.' };
      const plan = this.plan({ kind, value, tools: Array.isArray(q.tools) && q.tools.length ? q.tools : null });
      if (!plan.tools.length && !(Array.isArray(q.tools) && q.tools.length)) {
        const waiting = plan.skipped.some((x) => x.state === 'needs-program');
        return { ok: false, code: 'no-tools', error: waiting && kind === 'file' ? 'The tools that read this kind of file need a program that is not on this computer yet.' : 'No tool that is ready takes ' + kind.replace('-', ' ') + ' input yet.', skipped: plan.skipped };
      }
      const searchId = 's-' + crypto.randomBytes(8).toString('hex');
      const st = { cancelled: false, jobs: new Set(), caseId: q.caseId || null };
      this.live.set(searchId, st);
      const ids = plan.tools.map((t) => t.id);
      setImmediate(() => this._go(searchId, st, kind, value, plan).catch((e) => { this._warn('search-failed', { reason: e && e.message }); this._send({ searchId, type: 'done', ms: 0, error: 'The search stopped unexpectedly.', ...(st.caseId ? { caseId: st.caseId } : {}) }); this.live.delete(searchId); }));
      return { ok: true, searchId, kind, value, tools: ids, skipped: plan.skipped };
    } catch (e) { this._warn('search-run-failed', { reason: e && e.message }); return { ok: false, code: 'error', error: 'The search could not start.' }; }
  }

  async _go(searchId, st, kind, value, plan) {
    const t0 = this.now();
    const base = st.caseId ? { searchId, caseId: st.caseId } : { searchId };
    const sum = { ran: 0, results: 0, errors: 0, empty: 0, notRun: plan.skipped.length };
    for (const s of plan.skipped) this._send({ ...base, type: 'tool-error', tool: s.tool, error: s.note, state: s.state, ms: 0 });
    const queue = [...plan.tools];
    const worker = async () => {
      while (queue.length && !st.cancelled) {
        const t = queue.shift(); await this._one(base, st, t, kind, value, sum);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.maxParallel, queue.length)) }, worker));
    this.live.delete(searchId); this.finished.add(searchId); if (this.finished.size > 200) this.finished.delete(this.finished.values().next().value);
    this._send({ ...base, type: 'done', ms: this.now() - t0, ...(st.cancelled ? { cancelled: true } : {}), summary: sum });
  }

  async _one(base, st, t, kind, value, sum) {
    const t0 = this.now();
    this._send({ ...base, type: 'tool-start', tool: t.id, ms: 0 });
    sum.ran++;
    let input = t.input;
    if (kind === 'file') {
      // a picked file works once: each tool gets its own fresh token for the same file
      const pk = this.picks && this.picks.peek(value);
      if (!pk) { sum.errors++; return this._send({ ...base, type: 'tool-error', tool: t.id, error: 'The chosen file is no longer available. Choose it again.', ms: this.now() - t0 }); }
      input = { ...input, file: this.picks.add(pk.path, pk.size) };
    }
    let sub = null;
    for (let i = 0; i <= this.queueRetries && !st.cancelled; i++) {
      try { sub = this.runner.submit({ connector: t.id, input }); } catch (e) { sub = { ok: false, error: 'error', message: e && e.message }; }
      if (sub && sub.ok === false && sub.error === 'queue-full') { await sleep(this.queueRetryMs); continue; }
      break;
    }
    if (st.cancelled) return;
    if (!sub || !sub.ok) { sum.errors++; this._warn('search-tool-refused', { connector: t.id, reason: sub && (sub.message || sub.error) }); return this._send({ ...base, type: 'tool-error', tool: t.id, error: (sub && (sub.message || sub.error)) || 'The tool did not start.', ms: this.now() - t0 }); }
    st.jobs.add(sub.jobId);
    let job = null;
    try { job = await this.runner.wait(sub.jobId); } catch (e) { job = null; }
    st.jobs.delete(sub.jobId);
    if (st.cancelled) return;
    const ms = this.now() - t0;
    if (!job) { sum.errors++; return this._send({ ...base, type: 'tool-error', tool: t.id, error: 'The tool did not answer.', ms }); }
    if (job.status === 'cancelled') return;
    if (TERMINAL_BAD.has(job.status)) {
      sum.errors++;
      const err = String(job.error || job.status);
      const missing = /is not installed|not found in this connector|missingProgram/i.test(err);
      return this._send({ ...base, type: 'tool-error', tool: t.id, error: err, ms, ...(missing ? { state: 'needs-program' } : {}), jobId: sub.jobId });
    }
    const results = (job.results || []).slice(0, 1000);
    if (!results.length) { sum.empty++; return this._send({ ...base, type: 'tool-empty', tool: t.id, ms, jobId: sub.jobId, ...(job.rejected ? { note: job.rejected + ' answer line(s) could not be read' } : {}) }); }
    sum.results += results.length;
    this._send({ ...base, type: 'tool-result', tool: t.id, results, total: job.resultCount || results.length, truncated: (job.resultCount || 0) > results.length, ms, jobId: sub.jobId });
  }

  cancel(searchId) {
    const st = this.live.get(searchId);
    if (!st) return { ok: true, cancelled: false };
    st.cancelled = true;
    for (const j of [...st.jobs]) { try { this.runner.cancel(j); } catch { /* already over */ } }
    st.jobs.clear();
    // the loop in _go ends by itself; make sure "done" is sent even when every tool was still waiting
    return { ok: true, cancelled: true };
  }
  shutdown() { for (const id of [...this.live.keys()]) this.cancel(id); }
}

module.exports = { Search, classify, normalise, KINDS, MAX_QUERY };
