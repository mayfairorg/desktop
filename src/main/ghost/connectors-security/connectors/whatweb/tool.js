'use strict';
// WhatWeb (GPL-2.0, separate program): ACTIVE (sends HTTP requests to the target). Aggression level 1 only (one request), no redirects followed.
// Page-scraped contact details (the Email plugin) and author names (Meta-Author) are deliberately not turned into results.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'whatweb', tool: 'whatweb', version: '1.0.0', scope: 'active', timeoutMs: 120000, versionArgs: ['--version'], versionRe: /WhatWeb version (\d+\.\d+(?:\.\d+)?)/i,
  extraChecks: { ruby: { argv: ['ruby', '--version'], re: /ruby (\d+)\./i, minMajor: 2 } } };
const OMIT = new Set(['Email', 'Meta-Author', 'Country', 'UncommonHeaders']);

function normalizeInput(a) {
  const scheme = a.scheme === undefined ? 'https' : String(a.scheme);
  if (scheme !== 'http' && scheme !== 'https') throw new common.UsageError('scheme must be http or https');
  const port = common.intArg(a.port, 'port', 1, 65535, scheme === 'https' ? 443 : 80);
  return { scheme, port };
}
async function buildArgs(input, ctx) {
  const out = path.join(ctx.runDir, 'whatweb.json');
  const hostPort = (input.scheme === 'https' && input.port === 443) || (input.scheme === 'http' && input.port === 80) ? input.target : `${input.target}:${input.port}`;
  return {
    argv: ['-a', '1', '--follow-redirect=never', '--open-timeout', '10', '--read-timeout', '15', '-t', '1', '--no-errors', `--log-json=${out}`, `${input.scheme}://${hostPort}/`],
    collect: async () => { try { return fs.readFileSync(out, 'utf8'); } catch { return ''; } },
  };
}
function records(raw) {
  const s = String(raw).trim();
  if (!s) return [];
  try { const j = JSON.parse(s); return Array.isArray(j) ? j : [j]; } catch { /* fall through to line mode */ }
  const out = [];
  for (const line of s.split(/\r?\n/)) { const t = line.trim().replace(/^\[/, '').replace(/[,\]]+$/, ''); if (!t) continue; try { out.push(JSON.parse(t)); } catch { out.push(null); } }
  return out;
}
// raw: --log-json file
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const out = []; let bad = 0; const omitted = new Set();
  for (const rec of records(raw)) {
    if (!rec || typeof rec !== 'object' || typeof rec.plugins !== 'object' || rec.plugins === null) { bad++; continue; }
    const url = typeof rec.target === 'string' && /^https?:\/\//.test(rec.target) ? rec.target.slice(0, 300) : undefined;
    const base = { ...(url ? { url } : {}) };
    for (const [name, p] of Object.entries(rec.plugins)) {
      if (OMIT.has(name)) { omitted.add(name); continue; }
      const strings = p && Array.isArray(p.string) ? p.string.filter((x) => typeof x === 'string') : [];
      const versions = p && Array.isArray(p.version) ? p.version.filter((x) => typeof x === 'string') : [];
      if (name === 'IP' && strings[0]) { out.push(mk('ip-address', strings[0], { ...base, raw: { status: rec.http_status } })); continue; }
      if (name === 'Title' && strings[0]) { out.push(mk('web-title', strings[0].slice(0, 300), { ...base })); continue; }
      const label = versions[0] ? `${name} ${versions[0]}` : (name === 'HTTPServer' && strings[0] ? `${name}: ${strings[0]}` : name);
      out.push(mk('web-technology', label, versions[0]
        ? { ...base, confidence: 'likely', note: 'Version read from a response header or page text; the site can change or hide it.', raw: { plugin: name, strings: strings.slice(0, 3) } }
        : { ...base, confidence: 'uncertain', note: 'Matched on a single signal at aggression level 1; this can be a false positive.', raw: { plugin: name, strings: strings.slice(0, 3) } }));
    }
  }
  if (omitted.size) out.push(mk('fields-omitted', `${[...omitted].join(', ')} plugin output left out by design`, { confidence: 'confirmed', raw: { reason: 'personal data or low-value geolocation' } }));
  const w = common.skipNote(mk, bad, 'records'); if (w) out.push(w);
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse };
