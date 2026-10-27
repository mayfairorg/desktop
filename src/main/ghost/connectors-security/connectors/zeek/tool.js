'use strict';
// Zeek (BSD-3-Clause, separate program, best on Linux and macOS): reads a packet capture (pcap) file YOU picked, offline. No live capture,
// no network. Logs are written to a per-run folder and removed afterwards.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'zeek', tool: 'zeek', version: '1.0.0', scope: 'local', timeoutMs: 300000, versionArgs: ['--version'], versionRe: /zeek version (\d+\.\d+(?:\.\d+)?)/i };
const LOGS = ['conn', 'dns', 'http', 'ssl', 'notice', 'weird'];
const CAP = { conn: 1000, dns: 1000, http: 500, ssl: 500, notice: 200, weird: 100 };

function normalizeInput(a) {
  if (typeof a.pcap !== 'string' || !path.isAbsolute(a.pcap)) throw new common.UsageError('pcap must be a picked file');
  return { pcap: a.pcap };
}
async function buildArgs(input, ctx) {
  return {
    argv: ['-C', '-r', input.pcap, 'LogAscii::use_json=T'], cwd: ctx.runDir,
    collect: async (res, dir) => { const o = {}; for (const l of LOGS) { try { o[l] = fs.readFileSync(path.join(dir, l + '.log'), 'utf8'); } catch { o[l] = ''; } } return o; },
  };
}
function lines(text, onBad) { const out = []; for (const l of String(text || '').split(/\r?\n/)) { if (!l.trim() || l.startsWith('#')) continue; try { const j = JSON.parse(l); if (j && typeof j === 'object') out.push(j); else onBad(); } catch { onBad(); } } return out; }
const s = (v, n = 200) => (v === undefined || v === null ? '' : String(v).slice(0, n));
// raw: {conn, dns, http, ssl, notice, weird} each the text of that JSON log
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const out = []; let bad = 0;
  const onBad = () => { bad++; };
  const take = (kind, rows, f) => { let n = 0; for (const r of rows) { if (n++ >= CAP[kind]) continue; f(r); } if (rows.length > CAP[kind]) out.push(mk('output-truncated', `${kind}.log: ${rows.length - CAP[kind]} more records not listed`, { confidence: 'uncertain', note: 'Only the first records of each log are turned into results to keep a job readable.' })); };
  const at = (r) => common.isoTs(r.ts) || undefined;
  take('conn', lines(raw.conn, onBad), (r) => out.push(mk('network-flow', `${s(r['id.orig_h'])}:${s(r['id.orig_p'])} -> ${s(r['id.resp_h'])}:${s(r['id.resp_p'])}/${s(r.proto)}`, { observedAt: at(r), raw: { service: r.service, state: r.conn_state, durationS: r.duration, origBytes: r.orig_bytes, respBytes: r.resp_bytes } })));
  take('dns', lines(raw.dns, onBad), (r) => out.push(mk('dns-query', `${s(r.query)} ${s(r.qtype_name)} -> ${Array.isArray(r.answers) && r.answers.length ? r.answers.map((a) => s(a, 100)).slice(0, 8).join(',') : s(r.rcode_name) || 'no answer'}`, { observedAt: at(r), raw: { rcode: r.rcode_name } })));
  take('http', lines(raw.http, onBad), (r) => out.push(mk('http-request', `${s(r.method)} ${s(r.host)}${s(r.uri, 300)}`, { observedAt: at(r), raw: { status: r.status_code } })));
  take('ssl', lines(raw.ssl, onBad), (r) => out.push(mk('tls-session', `${s(r.server_name) || '(no SNI)'} ${s(r.version)} ${s(r.cipher)}`.trim(), { observedAt: at(r), raw: { established: r.established } })));
  take('notice', lines(raw.notice, onBad), (r) => out.push(mk('zeek-notice', `${s(r.note)}: ${s(r.msg, 300)}`, { observedAt: at(r), confidence: 'likely', note: "Raised by Zeek's own detection scripts; review the packets before concluding anything.", raw: { src: r.src, dst: r.dst } })));
  const weird = new Map();
  for (const r of lines(raw.weird, onBad)) weird.set(s(r.name, 80), (weird.get(s(r.name, 80)) || 0) + 1);
  let k = 0;
  for (const [name, n] of weird) if (k++ < CAP.weird) out.push(mk('protocol-anomaly', `${name} (${n}x)`, { confidence: 'uncertain', note: 'Zeek "weird" entries often come from capture artefacts or odd but harmless software, not from attacks.' }));
  const w = common.skipNote(mk, bad, 'log lines'); if (w) out.push(w);
  if (!out.length) out.push(mk('capture-summary', 'Zeek found no connections, DNS, HTTP or TLS records in this capture', { confidence: 'uncertain', note: 'The file may be empty, truncated or not a supported capture type.' }));
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse };
