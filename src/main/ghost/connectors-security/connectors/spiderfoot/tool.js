'use strict';
// SpiderFoot OSS (MIT, separate Python program): domain / IP footprinting through a FIXED allowlist of passive, keyless modules.
// Person-lookup modules (usernames, email accounts, people search, social profiles, breach lookups) can never be selected: the page cannot name a
// module at all (only a preset), the module lists below are code, and DENIED_MODULE is checked again on every module. Person-type events in the
// output are discarded and counted. Flags follow the SpiderFoot CLI help as recalled; not run against a live install here.
const common = require('./common');
const SPEC = { id: 'spiderfoot', tool: 'spiderfoot', version: '1.0.0', scope: 'passive', timeoutMs: 580000, versionArgs: ['-V'], versionRe: /SpiderFoot (\d+\.\d+(?:\.\d+)?)/i, versionNonzeroOk: true,
  extraChecks: { python: { argv: ['python3', '--version'], re: /Python (\d+)\./, minMajor: 3 } } };
const PRESETS = {
  infrastructure: ['sfp_crt', 'sfp_certspotter', 'sfp_hackertarget', 'sfp_dnsgrep', 'sfp_robtex', 'sfp_whois', 'sfp_bgpview'],
  certificates: ['sfp_crt', 'sfp_certspotter'],
};
const DENIED_MODULE = /(account|email|emailformat|phone|people|social|username|names?$|profile|pgp|leak|breach|pwn|dehash|hunter|twitter|github|gravatar|keybase|skype|instagram|facebook|linkedin|pastebin|darkweb|tor)/i;
const PERSON_EVENTS = /^(EMAILADDR|EMAILADDR_GENERIC|EMAILADDR_COMPROMISED|PHONE_NUMBER|PHONE_NUMBER_COMPROMISED|HUMAN_NAME|USERNAME|SOCIAL_MEDIA|ACCOUNT_EXTERNAL_OWNED|ACCOUNT_EXTERNAL_OWNED_COMPROMISED|ACCOUNT_EXTERNAL_USER_SHARED_COMPROMISED|DOMAIN_WHOIS|WEBSERVER_HTTPHEADERS|GEOINFO|PHYSICAL_ADDRESS|PHYSICAL_COORDINATES|LEAKSITE_CONTENT|LEAKSITE_URL|DARKNET_MENTION_URL|DARKNET_MENTION_CONTENT)$/;
const MAP = { INTERNET_NAME: 'subdomain', DOMAIN_NAME: 'domain', IP_ADDRESS: 'ip-address', IPV6_ADDRESS: 'ip-address', SSL_CERTIFICATE_ISSUED: 'tls-certificate' };

function modulesFor(preset) {
  const list = PRESETS[preset];
  if (!list) throw new common.UsageError('preset must be ' + Object.keys(PRESETS).join(' or '));
  for (const m of list) if (DENIED_MODULE.test(m)) throw new common.UsageError('module ' + m + ' is not allowed in Mayfair Ghost');
  return list;
}
function normalizeInput(a) {
  const preset = a.preset === undefined ? 'infrastructure' : String(a.preset);
  modulesFor(preset);
  const t = String(a.domain || '').toLowerCase();
  if (!common.FQDN_RE.test(t) && !common.isIPv4(t)) throw new common.UsageError('target must be a domain name or an IPv4 address');
  return { preset, domain: t };
}
async function buildArgs(input) {
  return { argv: ['-s', input.domain, '-m', modulesFor(input.preset).join(','), '-u', 'passive', '-o', 'json', '-q'] };
}
// raw: stdout JSON array [{generated, type, data, module, source, confidence}]
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  let rows;
  try { rows = JSON.parse(String(raw).trim() || '[]'); } catch { throw new common.ToolError('SpiderFoot did not print readable JSON'); }
  if (!Array.isArray(rows)) throw new common.ToolError('SpiderFoot JSON is not a list');
  const out = []; const seen = new Set(); let person = 0, other = 0, bad = 0;
  const domain = opts.input && opts.input.domain;
  for (const r of rows) {
    if (!r || typeof r.type !== 'string' || typeof r.data !== 'string') { bad++; continue; }
    if (PERSON_EVENTS.test(r.type) || DENIED_MODULE.test(String(r.module || ''))) { person++; continue; }
    const type = MAP[r.type];
    if (!type) { other++; continue; }
    const v = r.data.trim().toLowerCase().slice(0, 300);
    if (type === 'subdomain' && (!common.FQDN_RE.test(v) || (domain && !common.FQDN_RE.test(domain) ? false : domain && !common.inDomain(v, domain)))) { other++; continue; }
    const k = type + '|' + v; if (seen.has(k)) continue; seen.add(k);
    const conf = Number(r.confidence);
    out.push(mk(type, v, { observedAt: common.isoTs(r.generated) || undefined, confidence: conf >= 90 ? 'likely' : 'uncertain', note: `Reported by SpiderFoot module ${String(r.module || 'unknown').slice(0, 40)} (its confidence ${Number.isFinite(conf) ? conf : '?'}/100) from public data; nothing was contacted or verified.`, raw: { module: r.module, eventType: r.type } }));
  }
  if (person) out.push(mk('fields-omitted', `${person} person-related or personal-data event(s) discarded by design`, { raw: { reason: 'Mayfair Ghost does not collect personal data about individuals' } }));
  if (other) out.push(mk('events-not-listed', `${other} other event(s) not turned into results`));
  const w = common.skipNote(mk, bad, 'rows'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, PRESETS, DENIED_MODULE, PERSON_EVENTS, modulesFor, normalizeInput, buildArgs, parse };
