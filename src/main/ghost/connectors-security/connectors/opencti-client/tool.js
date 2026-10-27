'use strict';
// OpenCTI adapter: talks to YOUR OWN OpenCTI platform (Community Edition is Apache-2.0; never bundled) over GraphQL with your token. Read-only.
const common = require('./common');
const SPEC = { id: 'opencti-client', tool: 'OpenCTI', version: '1.0.0', scope: 'passive', authTypes: ['bearer'] };
const KINDS = ['ip', 'domain', 'url', 'md5', 'sha1', 'sha256'];

function normalizeInput(a) {
  const kind = String(a.kind || '');
  if (!KINDS.includes(kind)) throw new common.UsageError('kind must be one of ' + KINDS.join(', '));
  return { kind, indicator: common.checkIndicator(kind, String(a.indicator || '').trim()) };
}
const pingRequest = () => ({ method: 'POST', pathname: '/graphql', body: { query: '{ about { version } }' } });
function parsePing(resp, opts) {
  const mk = common.makeMk(SPEC, opts);
  if (resp.json && Array.isArray(resp.json.errors) && resp.json.errors.length) throw new common.ToolError('OpenCTI refused the request: ' + String(resp.json.errors[0].message || 'error').slice(0, 120), 8);
  const v = resp.json && resp.json.data && resp.json.data.about && typeof resp.json.data.about.version === 'string' ? resp.json.data.about.version : null;
  if (!v) throw new common.ToolError('the address answered, but not like an OpenCTI platform (no version in the GraphQL reply)', 9);
  return [mk('instance-status', 'reachable', { version: v, url: opts.url, raw: { product: 'OpenCTI', version: v } })];
}
const Q = 'query Search($s: String, $n: Int) { stixCyberObservables(search: $s, first: $n) { edges { node { id entity_type observable_value x_opencti_score created_at } } } indicators(search: $s, first: $n) { edges { node { id name pattern valid_from x_opencti_score confidence } } } }';
const searchRequest = (cfg, input) => ({ method: 'POST', pathname: '/graphql', body: { query: Q, variables: { s: input.indicator, n: 25 } } });
// resp.json: {"data":{"stixCyberObservables":{"edges":[{"node":{...}}]},"indicators":{"edges":[...]}}}
function parseSearch(resp, opts) {
  const mk = common.makeMk(SPEC, opts);
  const j = resp.json;
  if (j && Array.isArray(j.errors) && j.errors.length) throw new common.ToolError('OpenCTI refused the query: ' + String(j.errors[0].message || 'error').slice(0, 120), 8);
  if (!j || !j.data) throw new common.ToolError('the OpenCTI answer has no data', 9);
  const out = [];
  const edges = (k) => (j.data[k] && Array.isArray(j.data[k].edges) ? j.data[k].edges.map((e) => e && e.node).filter(Boolean) : []);
  const verdict = (score) => (Number(score) >= 70
    ? { confidence: 'likely', note: `OpenCTI score ${Number(score)}/100 is your platform's own rating, not an independent check.` }
    : { confidence: 'uncertain', note: `OpenCTI score is ${Number.isFinite(Number(score)) && score !== null ? Number(score) + '/100' : 'not set'}; the platform does not rate this strongly.` });
  for (const n of edges('stixCyberObservables')) {
    if (typeof n.observable_value !== 'string') continue;
    out.push(mk('threat-intel-hit', `${n.entity_type || 'observable'}: ${n.observable_value.slice(0, 300)} (OpenCTI observable)`, { observedAt: common.isoTs(n.created_at) || undefined, url: opts.url, ...verdict(n.x_opencti_score), raw: { id: n.id, score: n.x_opencti_score } }));
  }
  for (const n of edges('indicators')) {
    if (typeof n.name !== 'string') continue;
    const c = verdict(n.x_opencti_score);
    out.push(mk('threat-intel-hit', `indicator: ${n.name.slice(0, 200)} (OpenCTI indicator)`, { observedAt: common.isoTs(n.valid_from) || undefined, url: opts.url, ...c, raw: { id: n.id, pattern: String(n.pattern || '').slice(0, 300), score: n.x_opencti_score, confidenceField: n.confidence } }));
  }
  if (!out.length) out.push(mk('no-record', `no match in your OpenCTI platform for ${opts.input.indicator.slice(0, 200)}`, { confidence: 'uncertain', note: 'Absence from your platform only means it has no record; it is not evidence the indicator is harmless.', url: opts.url }));
  return out;
}
module.exports = { SPEC, KINDS, normalizeInput, pingRequest, parsePing, searchRequest, parseSearch };
