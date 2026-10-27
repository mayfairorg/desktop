'use strict';
// OWASP ZAP (Apache-2.0, a separate Java program, download on first use): ACTIVE, baseline only. A crawl of the declared host plus passive
// rules on what it returns. No active attack scan, no fuzzing, no authentication. The scope regex keeps the crawl on the declared host.
// The plan is ZAP's Automation Framework; flags and job names follow the ZAP documentation, not run against a live ZAP here.
const path = require('node:path');
const fs = require('node:fs');
const common = require('./common');
const SPEC = { id: 'zap-baseline', tool: 'zap', version: '1.0.0', scope: 'active', timeoutMs: 590000, versionArgs: ['-version'], versionRe: /^\s*v?(\d+\.\d+\.\d+)\s*$/m, versionNonzeroOk: true,
  extraChecks: { java: { argv: ['java', '-version'], re: /version "(\d+)/, minMajor: 17 } } };

function normalizeInput(a) {
  const scheme = a.scheme === undefined ? 'https' : String(a.scheme);
  if (scheme !== 'http' && scheme !== 'https') throw new common.UsageError('scheme must be http or https');
  return { scheme, port: common.intArg(a.port, 'port', 1, 65535, scheme === 'https' ? 443 : 80) };
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function planYaml(input, runDir) {
  const t = input.target;                                    // a validated host name or IPv4: letters, digits, dot, hyphen only
  const default_ = (input.scheme === 'https' && input.port === 443) || (input.scheme === 'http' && input.port === 80);
  const base = `${input.scheme}://${t}${default_ ? '' : ':' + input.port}`;
  const include = `${input.scheme}://${reEsc(t)}:${input.port}/.*`;
  const includeDefault = `${input.scheme}://${reEsc(t)}/.*`;
  const q = (s) => JSON.stringify(s);
  return [
    'env:',
    '  contexts:',
    '    - name: "mayfair-scope"',
    '      urls:',
    `        - ${q(base + '/')}`,
    '      includePaths:',
    `        - ${q(default_ ? includeDefault : include)}`,
    '  parameters:',
    '    failOnError: false',
    '    progressToStdout: false',
    'jobs:',
    '  - type: spider',
    '    parameters:',
    '      context: "mayfair-scope"',
    '      maxDuration: 2',
    '      maxDepth: 3',
    '  - type: passiveScan-wait',
    '    parameters:',
    '      maxDuration: 3',
    '  - type: report',
    '    parameters:',
    '      template: "traditional-json"',
    `      reportDir: ${q(runDir)}`,
    '      reportFile: "zap-report"',
    '',
  ].join('\n');
}
async function buildArgs(input, ctx) {
  const r = await ctx.resolveTarget(input.target);
  const plan = path.join(ctx.runDir, 'plan.yaml');
  fs.writeFileSync(plan, planYaml(input, ctx.runDir));
  return {
    argv: ['-cmd', '-silent', '-notel', '-dir', path.join(ctx.runDir, 'zap-home'), '-autorun', plan],
    pinned: r,
    collect: async () => { try { return fs.readFileSync(path.join(ctx.runDir, 'zap-report.json'), 'utf8'); } catch { return ''; } },
  };
}
const plain = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const RISK = { 0: 'Informational', 1: 'Low', 2: 'Medium', 3: 'High' };
// raw: zap-report.json (traditional-json): {"@version", "site":[{"@name","@host","alerts":[{pluginid,alertRef,alert,riskcode,confidence,desc,instances:[{uri,method,param}],count,solution,cweid}]}]}
function parse(raw, opts = {}) {
  const mk = common.makeMk(SPEC, opts);
  let j;
  try { j = JSON.parse(String(raw)); } catch { throw new common.ToolError('ZAP did not write a readable JSON report'); }
  if (!j || !Array.isArray(j.site)) throw new common.ToolError('ZAP report has no site list');
  const out = []; let fp = 0, n = 0;
  const ver = typeof j['@version'] === 'string' ? j['@version'].slice(0, 40) : undefined;
  for (const site of j.site) {
    for (const a of Array.isArray(site.alerts) ? site.alerts : []) {
      const conf = Number(a.confidence), risk = Number(a.riskcode);
      if (conf === 0) { fp++; continue; }
      if (n++ >= 500) continue;
      const name = plain(a.alert || a.name).slice(0, 200) || 'unnamed alert';
      const inst = Array.isArray(a.instances) ? a.instances : [];
      const raw2 = { pluginId: a.pluginid, risk: RISK[risk] || String(a.riskcode), zapConfidence: conf, cwe: a.cweid && a.cweid !== '-1' ? a.cweid : undefined, count: Number(a.count) || inst.length, uris: inst.slice(0, 3).map((i) => String(i.uri || '').slice(0, 200)), solution: plain(a.solution).slice(0, 400) };
      const value = `${name} [${RISK[risk] || 'risk ' + a.riskcode}] ${String(site['@name'] || '').slice(0, 200)}`;
      if (conf === 4) out.push(mk('web-alert', value, { version: ver, raw: raw2 }));
      else if (conf === 3) out.push(mk('web-alert', value, { version: ver, confidence: 'likely', note: 'Passive rule matched with ZAP confidence High; no attack was sent, so it is an observation about responses, not a proven vulnerability.', raw: raw2 }));
      else out.push(mk('web-alert', value, { version: ver, confidence: 'uncertain', note: `ZAP rates its own confidence ${conf === 2 ? 'Medium' : 'Low'}; passive rules infer from responses and can be wrong.`, raw: raw2 }));
    }
  }
  if (n > 500) out.push(mk('output-truncated', `${n - 500} further alerts not listed`, { confidence: 'uncertain', note: 'Only the first 500 alerts are recorded per job.' }));
  out.push(mk('scan-summary', `${Math.min(n, 500)} alerts recorded (${fp} marked false positive by ZAP and left out); baseline crawl and passive rules only`, { version: ver }));
  return out;
}
module.exports = { SPEC, normalizeInput, buildArgs, parse, planYaml };
