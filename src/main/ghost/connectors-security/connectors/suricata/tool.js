'use strict';
// Suricata (GPL-2.0, separate program): replays a packet capture (pcap) YOU picked, offline (-r). Never live capture, never inline mode.
// Rules and the config are files you pick; Mayfair ships no rules. Output is the eve.json written to the per-run folder.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'suricata', tool: 'suricata', version: '1.0.0', scope: 'local', timeoutMs: 300000, partialOk: true, versionArgs: ['-V'], versionRe: /Suricata version (\d+\.\d+(?:\.\d+)?)/i };
const CAP = 1000;

function normalizeInput(a) {
  for (const k of ['pcap']) if (typeof a[k] !== 'string' || !path.isAbsolute(a[k])) throw new common.UsageError(`${k} must be a picked file`);
  for (const k of ['rules', 'config']) if (a[k] !== undefined && (typeof a[k] !== 'string' || !path.isAbsolute(a[k]))) throw new common.UsageError(`${k} must be a picked file`);
  return { pcap: a.pcap, ...(a.rules ? { rules: a.rules } : {}), ...(a.config ? { config: a.config } : {}) };
}
async function buildArgs(input, ctx) {
  const argv = ['-r', input.pcap, '-l', ctx.runDir, '-k', 'none'];
  if (input.config) argv.push('-c', input.config);
  if (input.rules) argv.push('-S', input.rules);
  return {
    argv,
    collect: async () => {
      try { return fs.readFileSync(path.join(ctx.runDir, 'eve.json'), 'utf8'); }
      catch { throw new common.ToolError('Suricata wrote no eve.json. Pick a suricata.yaml that has the eve-log output enabled.'); }
    },
  };
}
const s = (v, n = 200) => (v === undefined || v === null ? '' : String(v).slice(0, n));
// raw: eve.json (one JSON object per line)
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const out = []; let bad = 0; const skipped = new Map(); const counts = {};
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { bad++; continue; }
    if (!e || typeof e.event_type !== 'string') { bad++; continue; }
    const at = common.isoTs(e.timestamp) || undefined;
    const type = e.event_type;
    const listed = ['alert', 'dns', 'tls', 'http'].includes(type);
    if (!listed) { skipped.set(type, (skipped.get(type) || 0) + 1); continue; }
    counts[type] = (counts[type] || 0) + 1;
    if (counts[type] > CAP) continue;
    const flow = `${s(e.src_ip)}:${s(e.src_port)} -> ${s(e.dest_ip)}:${s(e.dest_port)}`;
    if (type === 'alert' && e.alert) {
      out.push(mk('ids-alert', `${s(e.alert.signature, 300)} (sid ${s(e.alert.signature_id, 12)}) ${flow}`, { observedAt: at, confidence: 'likely', note: `Signature match, not proof of an attack: signatures raise false positives (category ${s(e.alert.category, 80) || 'none'}, severity ${s(e.alert.severity, 3) || '?'}).`, raw: { sid: e.alert.signature_id, rev: e.alert.rev, proto: e.proto } }));
    } else if (type === 'dns' && e.dns) {
      out.push(mk('dns-query', `${s(e.dns.rrname)} ${s(e.dns.rrtype)}${e.dns.rdata ? ' -> ' + s(e.dns.rdata, 200) : ''}`, { observedAt: at, raw: { kind: e.dns.type, rcode: e.dns.rcode } }));
    } else if (type === 'tls' && e.tls) {
      out.push(mk('tls-session', `${s(e.tls.sni) || '(no SNI)'} ${s(e.tls.version)}`.trim(), { observedAt: at, raw: { dest: s(e.dest_ip) } }));
    } else if (type === 'http' && e.http) {
      out.push(mk('http-request', `${s(e.http.http_method)} ${s(e.http.hostname)}${s(e.http.url, 300)}`, { observedAt: at, raw: { status: e.http.status } }));
    } else bad++;
  }
  for (const [k, n] of Object.entries(counts)) if (n > CAP) out.push(mk('output-truncated', `${k} events: ${n - CAP} more not listed`, { confidence: 'uncertain', note: 'Only the first events of each kind are turned into results.' }));
  if (skipped.size) out.push(mk('events-not-listed', [...skipped].map(([k, n]) => `${n} ${k}`).join(', ') + ' event(s) not turned into results'));
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  if (!out.length) out.push(mk('capture-summary', 'Suricata produced no alerts or protocol records for this capture', { confidence: 'uncertain', note: 'With no rules loaded, or an empty or unsupported capture, nothing is expected to match; this is not a clean bill of health.' }));
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse };
