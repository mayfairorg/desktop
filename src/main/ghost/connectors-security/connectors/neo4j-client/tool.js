'use strict';
// Neo4j adapter: talks to YOUR OWN Neo4j server (Community is GPL-3.0; never bundled) through its HTTP transaction API. The only statement it
// can send is one fixed, read-only MATCH ... RETURN built from a label and a property name you give (letters, digits, underscore) and your
// value as a parameter. Use a read-only database user in your instance config. Needs Neo4j 5 (elementId).
const common = require('./common');
const SPEC = { id: 'neo4j-client', tool: 'Neo4j', version: '1.0.0', scope: 'passive', authTypes: ['none', 'basic'] };
const KINDS = ['ip', 'domain', 'url', 'md5', 'sha1', 'sha256'];
const IDENT = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

function normalizeInput(a) {
  const kind = String(a.kind || '');
  if (!KINDS.includes(kind)) throw new common.UsageError('kind must be one of ' + KINDS.join(', '));
  for (const k of ['label', 'property']) if (!IDENT.test(String(a[k] || ''))) throw new common.UsageError(`${k} must be a plain name (letters, digits, underscore)`);
  return { kind, label: String(a.label), property: String(a.property), indicator: common.checkIndicator(kind, String(a.indicator || '').trim()) };
}
const pingRequest = () => ({ method: 'GET', pathname: '/' });
function parsePing(resp, opts) {
  const mk = common.makeMk(SPEC, opts);
  const v = resp.json && typeof resp.json.neo4j_version === 'string' ? resp.json.neo4j_version : null;
  if (!v) throw new common.ToolError('the address answered, but not like a Neo4j server (no neo4j_version in the discovery reply)', 9);
  return [mk('instance-status', 'reachable', { version: v, url: opts.url, raw: { product: 'Neo4j', version: v, edition: resp.json.neo4j_edition } })];
}
function searchRequest(cfg, input) {
  const db = cfg.database || 'neo4j';
  const statement = `MATCH (n:\`${input.label}\`) WHERE toLower(toString(n.\`${input.property}\`)) = toLower($v) RETURN labels(n) AS labels, properties(n) AS props, elementId(n) AS id LIMIT 25`;
  return { method: 'POST', pathname: `/db/${encodeURIComponent(db)}/tx/commit`, body: { statements: [{ statement, parameters: { v: input.indicator } }] } };
}
// resp.json: {"results":[{"columns":["labels","props","id"],"data":[{"row":[["Domain"],{...},"4:abc:1"],"meta":[...]}]}],"errors":[]}
function parseSearch(resp, opts) {
  const mk = common.makeMk(SPEC, opts);
  const j = resp.json;
  if (j && Array.isArray(j.errors) && j.errors.length) throw new common.ToolError('Neo4j refused the query: ' + String(j.errors[0].message || j.errors[0].code || 'error').slice(0, 120), 8);
  const res = j && Array.isArray(j.results) ? j.results[0] : null;
  if (!res || !Array.isArray(res.data)) throw new common.ToolError('the Neo4j answer has no result rows', 9);
  const out = [];
  for (const d of res.data.slice(0, 25)) {
    const [labels, props, id] = Array.isArray(d.row) ? d.row : [];
    const p = props && typeof props === 'object' ? props : {};
    const fields = {}; let i = 0;
    for (const [k, v] of Object.entries(p)) { if (i++ >= 8) break; fields[k.slice(0, 60)] = typeof v === 'object' && v !== null ? '[object]' : String(v).slice(0, 120); }
    out.push(mk('graph-node', `${Array.isArray(labels) ? labels.slice(0, 3).join(':') : opts.input.label} ${opts.input.property}=${opts.input.indicator.slice(0, 200)}`, { url: opts.url, raw: { nodeId: id, fields } }));
  }
  if (!out.length) out.push(mk('no-record', `no ${opts.input.label} node with ${opts.input.property} = ${opts.input.indicator.slice(0, 160)} in your Neo4j database`, { confidence: 'uncertain', note: 'Absence from your graph only means it has no record; it is not evidence the indicator is harmless.', url: opts.url }));
  return out;
}
module.exports = { SPEC, KINDS, IDENT, normalizeInput, pingRequest, parsePing, searchRequest, parseSearch };
