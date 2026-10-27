'use strict';
// OpenSearch adapter: talks to YOUR OWN OpenSearch cluster (Apache-2.0; never bundled). Read-only: version check and one phrase search over the
// index named in your instance config. Elasticsearch is refused (the version reply must say distribution "opensearch").
const common = require('./common');
const SPEC = { id: 'opensearch-client', tool: 'OpenSearch', version: '1.0.0', scope: 'passive', authTypes: ['none', 'basic', 'api-key', 'bearer'], apiKeyHeader: 'Authorization' };
const KINDS = ['ip', 'domain', 'url', 'md5', 'sha1', 'sha256', 'cve'];

function normalizeInput(a) {
  const kind = String(a.kind || '');
  if (!KINDS.includes(kind)) throw new common.UsageError('kind must be one of ' + KINDS.join(', '));
  return { kind, indicator: common.checkIndicator(kind, String(a.indicator || '').trim()) };
}
const pingRequest = () => ({ method: 'GET', pathname: '/' });
function parsePing(resp, opts) {
  const mk = common.makeMk(SPEC, opts);
  const v = resp.json && resp.json.version;
  if (!v || typeof v.number !== 'string') throw new common.ToolError('the address answered, but not like an OpenSearch cluster', 9);
  if (v.distribution !== 'opensearch') throw new common.ToolError(`this is not OpenSearch (distribution: ${String(v.distribution || 'elasticsearch').slice(0, 40)}); Mayfair Ghost only connects to OpenSearch`, 9);
  return [mk('instance-status', 'reachable', { version: v.number, url: opts.url, raw: { product: 'OpenSearch', version: v.number, cluster: resp.json.cluster_name } })];
}
function searchRequest(cfg, input) {
  if (!cfg.index) throw new common.ToolError('set "index" in your OpenSearch instance config (for example "ioc-*"); Ghost will not search every index', 5);
  return { method: 'POST', pathname: `/${encodeURIComponent(cfg.index)}/_search?ignore_unavailable=true&allow_no_indices=true`, body: { size: 25, track_total_hits: true, query: { multi_match: { query: input.indicator, type: 'phrase', fields: ['*'], lenient: true } } } };
}
// resp.json: {"hits":{"total":{"value":1},"hits":[{"_index","_id","_source":{...}}]}}
function parseSearch(resp, opts) {
  const mk = common.makeMk(SPEC, opts);
  const h = resp.json && resp.json.hits;
  if (!h || !Array.isArray(h.hits)) throw new common.ToolError('the OpenSearch answer has no hits list', 9);
  const out = [];
  for (const d of h.hits.slice(0, 25)) {
    const src = d && d._source && typeof d._source === 'object' ? d._source : {};
    const fields = {}; let i = 0;
    for (const [k, v] of Object.entries(src)) { if (i++ >= 8) break; fields[k.slice(0, 60)] = typeof v === 'object' && v !== null ? '[object]' : String(v).slice(0, 120); }
    const when = common.isoTs(src['@timestamp'] || src.timestamp);
    out.push(mk('search-hit', `${d._index}/${d._id}: ${opts.input.indicator.slice(0, 120)}`, { observedAt: when && Date.parse(when) <= Date.now() + 3600e3 ? when : undefined, url: opts.url, confidence: 'likely', note: 'Full-text phrase match in your index; the indicator may appear in a different role than expected, such as a comment.', raw: { index: d._index, id: d._id, score: d._score, fields } }));
  }
  const total = h.total && typeof h.total.value === 'number' ? h.total.value : h.hits.length;
  if (total > out.length) out.push(mk('output-truncated', `${total - out.length} more matching documents not listed`, { confidence: 'uncertain', note: 'Only the first 25 matches are recorded; narrow the index pattern to see others.', url: opts.url }));
  if (!total) out.push(mk('no-record', `no match in your OpenSearch index for ${opts.input.indicator.slice(0, 200)}`, { confidence: 'uncertain', note: 'Absence from this index only means it has no record; it is not evidence the indicator is harmless.', url: opts.url }));
  return out;
}
module.exports = { SPEC, KINDS, normalizeInput, pingRequest, parsePing, searchRequest, parseSearch };
