'use strict';
// Photon (GPL-3.0, separate Python program): ACTIVE same-host crawl of ONE site the user names, depth 1 to 3, one thread, 1 s delay.
// Photon's "intel" output (emails, keys, social links) is never read. Every URL is re-checked to be on the declared host before it is reported;
// links to other sites are counted, not listed. No Wayback seeding, no DNS dump. Flags follow Photon's help; not run against a live install.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'photon', tool: 'photon', version: '1.0.0', scope: 'active', timeoutMs: 560000, partialOk: true, versionArgs: ['-h'], versionRe: /v?(\d+\.\d+\.\d+)/, versionNonzeroOk: true,
  extraChecks: { python: { argv: ['python3', '--version'], re: /Python (\d+)\./, minMajor: 3 } } };
const CAP = 500;

function normalizeInput(a) {
  const scheme = a.scheme === undefined ? 'https' : String(a.scheme);
  if (scheme !== 'http' && scheme !== 'https') throw new common.UsageError('scheme must be http or https');
  return { scheme, port: common.intArg(a.port, 'port', 1, 65535, scheme === 'https' ? 443 : 80), depth: common.intArg(a.depth, 'depth', 1, 3, 2) };
}
async function buildArgs(input, ctx) {
  const out = path.join(ctx.runDir, 'photon-out');
  const dflt = (input.scheme === 'https' && input.port === 443) || (input.scheme === 'http' && input.port === 80);
  const url = `${input.scheme}://${input.target}${dflt ? '' : ':' + input.port}/`;
  return { argv: ['-u', url, '-l', String(input.depth), '-t', '1', '--delay', '1', '--timeout', '10', '-o', out],
    collect: async () => { const r = {}; for (const f of ['internal', 'external', 'scripts', 'files']) { try { r[f] = fs.readFileSync(path.join(out, f + '.txt'), 'utf8'); } catch { r[f] = ''; } } return r; } };
}
// raw: {internal, external, scripts, files}: the text of Photon's list files, one URL per line
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  const host = opts.input && opts.input.target;
  const out = []; let bad = 0, offHost = 0, n = 0, over = 0;
  const seen = new Set();
  const list = (text, type, label) => {
    for (const l of String(text || '').split(/\r?\n/)) {
      const t = l.trim(); if (!t) continue;
      let u; try { u = new URL(t); } catch { bad++; continue; }
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) { bad++; continue; }
      if (host && u.hostname.toLowerCase() !== host) { offHost++; continue; }
      const k = type + '|' + u.href; if (seen.has(k)) continue; seen.add(k);
      if (n++ >= CAP) { over++; continue; }
      out.push(mk(type, u.href.slice(0, 1000), { url: u.href.slice(0, 500), raw: { list: label } }));
    }
  };
  list(raw.internal, 'crawled-url', 'internal'); list(raw.scripts, 'script-url', 'scripts'); list(raw.files, 'file-url', 'files');
  let ext = 0; for (const l of String(raw.external || '').split(/\r?\n/)) if (l.trim()) ext++;
  if (ext) out.push(mk('external-links', `${ext} link(s) to other sites were found and not followed`));
  if (offHost) out.push(mk('events-not-listed', `${offHost} URL(s) on other hosts left out of the same-host lists`));
  if (over) out.push(mk('output-truncated', `${over} more URLs not listed`, { confidence: 'uncertain', note: 'Only the first 500 URLs are recorded per job.' }));
  const w = common.skipNote(mk, bad, 'lines'); if (w) out.push(w);
  if (!out.length) out.push(mk('no-record', 'the crawl found no pages', { confidence: 'uncertain', note: 'The site may block crawlers, need JavaScript to show links, or have been unreachable; Photon does not run scripts.' }));
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse };
