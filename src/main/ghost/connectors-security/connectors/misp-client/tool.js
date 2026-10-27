'use strict';
// MISP adapter: talks to YOUR OWN MISP server (AGPL-3.0, never bundled) through its REST API with your key. Read-only: version and attribute search.
const common = require('./common');
const SPEC = { id: 'misp-client', tool: 'MISP', version: '1.0.0', scope: 'passive', authTypes: ['api-key'], apiKeyHeader: 'Authorization' };
const KINDS = ['ip', 'domain', 'url', 'md5', 'sha1', 'sha256'];
const MISP_TYPES = { ip: ['ip-src', 'ip-dst', 'ip-src|port', 'ip-dst|port'], domain: ['domain', 'hostname', 'domain|ip'], url: ['url', 'uri'], md5: ['md5', 'filename|md5'], sha1: ['sha1', 'filename|sha1'], sha256: ['sha256', 'filename|sha256'] };

function normalizeInput(a) {
  const kind = String(a.kind || '');
  if (!KINDS.includes(kind)) throw new common.UsageError('kind must be one of ' + KINDS.join(', '));
  return { kind, indicator: common.checkIndicator(kind, String(a.indicator || '').trim()) };
}
const pingRequest = () => ({ method: 'GET', pathname: '/servers/getVersion' });
function parsePing(resp, opts) {
  const mk = common.makeMk(SPEC, opts);
  const v = resp.json && typeof resp.json.version === 'string' ? resp.json.version : null;
  if (!v) throw new common.ToolError('the address answered, but not like a MISP server (no version in /servers/getVersion)', 9);
  return [mk('instance-status', 'reachable', { version: v, url: opts.url, raw: { product: 'MISP', version: v } })];
}
const searchRequest = (cfg, input) => ({ method: 'POST', pathname: '/attributes/restSearch', headers: { 'Content-Type': 'application/json' }, body: { returnFormat: 'json', value: input.indicator, type: MISP_TYPES[input.kind], limit: 50, page: 1, includeEventTags: true } });
// resp.json: {"response":{"Attribute":[{id,event_id,category,type,value,to_ids,timestamp,comment,Event:{id,info},Tag:[{name}]}]}}
function parseSearch(resp, opts) {
  const mk = common.makeMk(SPEC, opts);
  const list = resp.json && resp.json.response && Array.isArray(resp.json.response.Attribute) ? resp.json.response.Attribute : null;
  if (!list) throw new common.ToolError('the MISP answer has no attribute list', 9);
  const out = [];
  for (const a of list.slice(0, 50)) {
    if (!a || typeof a.value !== 'string') continue;
    const info = a.Event && typeof a.Event.info === 'string' ? ` "${a.Event.info.slice(0, 100)}"` : '';
    const tags = [...(Array.isArray(a.Tag) ? a.Tag : []), ...(a.Event && Array.isArray(a.Event.Tag) ? a.Event.Tag : [])].map((t) => t && t.name).filter(Boolean).slice(0, 6);
    const raw = { eventId: a.event_id, attributeType: a.type, category: a.category, toIds: a.to_ids === true, tags, comment: a.comment ? String(a.comment).slice(0, 200) : undefined };
    const base = { observedAt: common.isoTs(a.timestamp) || undefined, url: opts.url, raw };
    out.push(mk('threat-intel-hit', `${a.type}:${a.value.slice(0, 300)} in MISP event ${a.event_id}${info}`, a.to_ids === true
      ? { ...base, confidence: 'likely', note: 'Recorded in your MISP instance and flagged for detection use (to_ids); that is your platform\'s assessment, not an independent check.' }
      : { ...base, confidence: 'uncertain', note: 'Recorded in your MISP instance but not flagged for detection use (to_ids is false); it may be context only.' }));
  }
  if (!out.length) out.push(mk('no-record', `no match in your MISP instance for ${opts.input.indicator.slice(0, 200)}`, { confidence: 'uncertain', note: 'Absence from your instance only means it has no record; it is not evidence the indicator is harmless.', url: opts.url }));
  return out;
}
module.exports = { SPEC, KINDS, normalizeInput, pingRequest, parsePing, searchRequest, parseSearch };
