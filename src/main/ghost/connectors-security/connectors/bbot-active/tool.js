'use strict';
// BBOT (AGPL-3.0, separate program only, never bundled): ACTIVE, behind the scope guard. Fixed argv: preset web-basic with --strict-scope (stay on
// the declared host) and "-ef aggressive,deadly" (no aggressive or deadly modules). Email, username, social and cloud-bucket-brute presets are not reachable. This connector's active
// Passive sibling: "bbot". Scope is a manifest property and cannot change at run time. Flags follow the BBOT docs; not run against a live install.
const common = require('./common');
const SPEC = { id: 'bbot-active', tool: 'bbot', version: '1.0.0', scope: 'active', timeoutMs: 580000, versionArgs: ['--version'], versionRe: /v?(\d+\.\d+\.\d+)/, versionNonzeroOk: true, partialOk: true,
  extraChecks: { python: { argv: ['python3', '--version'], re: /Python (\d+)\./, minMajor: 3 } } };
const PRESETS = ['web-basic'];
const DENIED_PRESET = /(email|username|social|people|profile|account|leak|cloud-enum|kitchen)/i;
const ACTIVE = true;
const DROP = /^(EMAIL_ADDRESS|USERNAME|SOCIAL|PROTOCOL|PASSWORD|HASHED_PASSWORD|CODE_REPOSITORY|STORAGE_BUCKET|FILESYSTEM|MOBILE_APP|PHONE_NUMBER|PERSON|ORG_STUB|AZURE_TENANT)$/;
const MAP = { DNS_NAME: 'subdomain', IP_ADDRESS: 'ip-address', OPEN_TCP_PORT: 'open-port', TECHNOLOGY: 'web-technology', URL: 'url', FINDING: 'bbot-finding' };

function normalizeInput(a) {
  const preset = a.preset === undefined ? PRESETS[0] : String(a.preset);
  if (!PRESETS.includes(preset) || DENIED_PRESET.test(preset)) throw new common.UsageError('preset must be one of ' + PRESETS.join(', '));
  return { preset };
}
async function buildArgs(input, ctx) {
  const argv = ['-t', input.target, '-p', input.preset, '-y', '--json', '--silent', '-ef', 'aggressive,deadly', '-o', ctx.runDir, '-n', 'mayfair'];
  if (!ACTIVE) argv.push('-rf', 'passive'); else argv.push('--strict-scope');
  return { argv };
}
// raw: stdout, one BBOT event per line {"type","data","module","tags","timestamp"}
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const domain = opts.input && opts.input.target;
  const out = []; const seen = new Set(); let dropped = 0, other = 0, bad = 0;
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { bad++; continue; }
    if (!e || typeof e.type !== 'string') { bad++; continue; }
    if (DROP.test(e.type)) { dropped++; continue; }
    const type = MAP[e.type];
    if (!type) { other++; continue; }
    let data = e.data;
    if (data && typeof data === 'object') data = data.url || data.host || data.description || JSON.stringify(data).slice(0, 300);
    if (typeof data !== 'string' || !data) { bad++; continue; }
    data = data.slice(0, 400);
    if (type === 'subdomain') { data = data.toLowerCase(); if (!common.FQDN_RE.test(data) || (domain && !common.inDomain(data, domain))) { other++; continue; } }
    if (type === 'url') { try { const u = new URL(data); if (domain && !common.inDomain(u.hostname, domain)) { other++; continue; } } catch { bad++; continue; } }
    const k = type + '|' + data; if (seen.has(k)) continue; seen.add(k);
    const tags = Array.isArray(e.tags) ? e.tags.map(String).slice(0, 8) : [];
    out.push(mk(type, data, ACTIVE && type !== 'subdomain' && type !== 'ip-address'
      ? { confidence: 'likely', note: 'Observed by BBOT modules during a scope-limited active run; confirm independently before acting.', raw: { module: e.module, tags }, observedAt: common.isoTs(e.timestamp) || undefined }
      : { confidence: 'uncertain', note: 'Found by BBOT passive modules from public data; the asset was not contacted.', raw: { module: e.module, tags }, observedAt: common.isoTs(e.timestamp) || undefined }));
  }
  if (dropped) out.push(mk('fields-omitted', `${dropped} person-related or credential event(s) discarded by design`, { raw: { reason: 'Mayfair Ghost does not collect personal data about individuals' } }));
  if (other) out.push(mk('events-not-listed', `${other} other event(s) not turned into results`));
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, PRESETS, DENIED_PRESET, DROP, normalizeInput, buildArgs, parse };
