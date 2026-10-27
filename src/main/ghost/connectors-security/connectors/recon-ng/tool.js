'use strict';
// Recon-ng (GPL-3.0-only, separate Python program): ONE allowlisted domain-to-host module per run. The page picks from an enum of three; the
// module path is checked against the allowlist AND a category denylist (profiles, contacts, credentials, reporting, exploitation) before use.
// recon-cli prints human text, so hosts are read as FQDNs inside the domain and reported as uncertain. Not run against a live install here.
const common = require('./common');
const SPEC = { id: 'recon-ng', tool: 'recon-ng', version: '1.0.0', scope: 'passive', timeoutMs: 300000, versionArgs: ['--version'], versionRe: /recon-?ng[^\d]{0,20}v?(\d+\.\d+\.\d+)/i, versionNonzeroOk: true,
  extraChecks: { python: { argv: ['python3', '--version'], re: /Python (\d+)\./, minMajor: 3 } } };
const MODULES = { hackertarget: 'recon/domains-hosts/hackertarget', 'certificate-transparency': 'recon/domains-hosts/certificate_transparency', threatcrowd: 'recon/domains-hosts/threatcrowd' };
const DENIED_PATH = /^(recon\/(profiles|contacts|credentials|domains-contacts|companies-contacts|companies-multi|locations|netblocks-companies)|reporting|exploitation|import|discovery\/info_disclosure|recon\/hosts-hosts\/(ssltools|resolve)|recon\/domains-hosts\/brute)|(whois_pocs|pwnedlist|haveibeenpwned|hibp|leak|breach|github_users|twitter|linkedin|namechk|profiler|username|email)/i;

function normalizeInput(a) {
  const m = String(a.module === undefined ? 'certificate-transparency' : a.module);
  if (!Object.prototype.hasOwnProperty.call(MODULES, m)) throw new common.UsageError('module must be one of ' + Object.keys(MODULES).join(', '));
  const domain = String(a.domain || '').toLowerCase();
  if (!common.FQDN_RE.test(domain)) throw new common.UsageError('domain must be a full domain name such as example.com');
  return { module: m, domain };
}
function modulePath(key) {
  const p = MODULES[key];
  if (!p || DENIED_PATH.test(p)) throw new common.UsageError('module is not allowed in Mayfair Ghost');
  return p;
}
async function buildArgs(input, ctx) {
  return { argv: ['-w', 'mayfair', '-m', modulePath(input.module), '-o', `SOURCE=${input.domain}`, '-x'], cwd: ctx.runDir };
}
// raw: stdout text; lines starting "[*]" carry results
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const domain = opts.input && opts.input.domain;
  const out = []; const seen = new Set();
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.startsWith('[*]')) continue;
    for (const tok of line.slice(3).split(/[\s,()\[\]]+/)) {
      const h = tok.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
      if (!common.FQDN_RE.test(h) || (domain && (h === domain || !common.inDomain(h, domain))) || seen.has(h)) continue;
      seen.add(h);
      out.push(mk('subdomain', h, { confidence: 'uncertain', note: 'Read from Recon-ng text output of a passive module; the name was not resolved or contacted.', raw: { module: opts.input && opts.input.module } }));
    }
  }
  if (!out.length) out.push(mk('no-record', 'the module returned no hosts', { confidence: 'uncertain', note: 'The module may not be installed in Recon-ng yet, may be rate limited, or the source may know nothing; this is not proof there are no hosts.' }));
  return out;
}
module.exports = { SPEC, MODULES, DENIED_PATH, modulePath, normalizeInput, buildArgs, parse };
