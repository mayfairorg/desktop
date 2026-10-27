'use strict';
// testssl.sh (GPL-2.0, separate program): ACTIVE (many TLS handshakes with the target). Read-only checks; no client certificates, no exploit modes.
// The resolved address is pinned with --ip. Flags follow the testssl.sh usage text; not run against a live binary here.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'testssl', tool: 'testssl.sh', version: '1.0.0', scope: 'active', timeoutMs: 580000, partialOk: true, versionArgs: ['--version'], versionRe: /testssl\.sh\s+(\d+\.\d+(?:\.\d+)?)/i,
  extraChecks: { bash: { argv: ['bash', '--version'], re: /version (\d+)\./i, minMajor: 3 } } };
const PRESETS = { quick: ['-p', '-S'], standard: ['-p', '-S', '-U', '-s'] };
const PROTO = { SSLv2: 'SSL 2.0', SSLv3: 'SSL 3.0', TLS1: 'TLS 1.0', TLS1_1: 'TLS 1.1', TLS1_2: 'TLS 1.2', TLS1_3: 'TLS 1.3' };

function normalizeInput(a) {
  const preset = a.preset === undefined ? 'quick' : String(a.preset);
  if (!PRESETS[preset]) throw new common.UsageError('preset must be quick or standard');
  return { preset, port: common.intArg(a.port, 'port', 1, 65535, 443) };
}
async function buildArgs(input, ctx) {
  const r = await ctx.resolveTarget(input.target);
  const out = path.join(ctx.runDir, 'testssl.json');
  return {
    argv: ['--jsonfile', out, '--warnings', 'off', '--color', '0', '--quiet', '--connect-timeout', '10', '--openssl-timeout', '10', ...PRESETS[input.preset], '--ip', r.pinned, `${input.target}:${input.port}`],
    pinned: r,
    collect: async () => { try { return fs.readFileSync(out, 'utf8'); } catch { return ''; } },
  };
}
// raw: --jsonfile content, an array of {id, ip, port, severity, finding}
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const s = String(raw).trim();
  let rows;
  try { rows = JSON.parse(s); } catch { throw new common.ToolError('testssl.sh did not write a readable JSON file'); }
  if (!Array.isArray(rows)) throw new common.ToolError('testssl.sh JSON is not a list');
  const out = []; let ok = 0, weak = 0, bad = 0, certs = 0;
  const seenIp = new Set();
  for (const r of rows) {
    if (!r || typeof r.id !== 'string' || typeof r.finding !== 'string') { bad++; continue; }
    const sev = String(r.severity || '').toUpperCase();
    const finding = r.finding.replace(/\s+/g, ' ').slice(0, 400);
    const where = r.port ? { port: r.port } : {};
    if (typeof r.ip === 'string' && r.ip.includes('/')) { const ip = r.ip.split('/')[1]; if (ip && !seenIp.has(ip)) { seenIp.add(ip); out.push(mk('ip-address', ip, { raw: { host: r.ip.split('/')[0], ...where } })); } }
    if (PROTO[r.id]) { if (/^offered/i.test(finding)) out.push(mk('tls-protocol', `${PROTO[r.id]} offered`, { raw: { severity: sev, finding, ...where } })); else ok++; continue; }
    if (/^cert(?:[_ ]|$)/.test(r.id)) { if (certs++ < 40) out.push(mk('tls-certificate', `${r.id.replace(/^cert_?/, '')}: ${finding}`, { raw: { severity: sev, ...where } })); if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(sev)) weak++; continue; }
    if (sev === 'FATAL') { out.push(mk('scan-error', `${r.id}: ${finding}`, { confidence: 'uncertain', note: 'testssl.sh could not complete this check, so nothing can be concluded from it.' })); continue; }
    if (['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'WARN'].includes(sev)) {
      const possible = sev === 'WARN' || /potentially|probably|may be|inconclusive|not tested|uncertain/i.test(finding);
      weak++;
      out.push(mk('tls-weakness', `${r.id}: ${finding}`, possible
        ? { confidence: 'uncertain', note: 'testssl.sh reports this as a possibility, not a confirmed weakness.', raw: { severity: sev, ...(r.cve ? { cve: String(r.cve).slice(0, 80) } : {}), ...where } }
        : { confidence: 'likely', note: 'Derived from how the server answered handshakes; confirm independently before acting.', raw: { severity: sev, ...(r.cve ? { cve: String(r.cve).slice(0, 80) } : {}), ...where } }));
      continue;
    }
    if (sev === 'OK') ok++;
  }
  out.push(mk('tls-summary', `${ok} checks OK, ${weak} findings to review`, { raw: { rows: rows.length } }));
  const w = common.skipNote(mk, bad, 'rows'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, PRESETS, normalizeInput, buildArgs, parse };
