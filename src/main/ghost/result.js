'use strict';
// Mayfair Ghost: the result schema every connector must print on stdout, one JSON object per line.
//   {entity:{type,value}, source:{tool,connector,version,url?}, observedAt, confidence:'confirmed'|'likely'|'uncertain', uncertaintyNote?, raw?}
// A line that does not validate is REJECTED with a reason; the runner records it. Nothing is repaired, invented or dropped silently.
const { isObj } = require('./manifest');

const CONFIDENCE = ['confirmed', 'likely', 'uncertain'];
const TYPE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const RAW_CAP = 4096;      // bytes of serialised JSON kept in "raw"

const str = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !v.includes('\0');
function keysOk(o, allowed) { return Object.keys(o).every((k) => allowed.includes(k)); }

function capRaw(raw) {
  let s;
  try { s = JSON.stringify(raw); } catch { return { truncated: true, bytes: 0, preview: '' }; }
  if (s === undefined) return undefined;
  const bytes = Buffer.byteLength(s);
  if (bytes <= RAW_CAP) return JSON.parse(s);
  return { truncated: true, bytes, preview: s.slice(0, 1000) };
}

// ctx: {connector, now}. Returns {ok:true, result} or {ok:false, error}.
function validateResult(o, ctx = {}) {
  if (!isObj(o)) return { ok: false, error: 'result must be a JSON object' };
  if (!keysOk(o, ['entity', 'source', 'observedAt', 'confidence', 'uncertaintyNote', 'raw'])) return { ok: false, error: 'result has an unknown key' };
  const e = o.entity, s = o.source;
  if (!isObj(e) || !keysOk(e, ['type', 'value']) || typeof e.type !== 'string' || !TYPE_RE.test(e.type) || !str(e.value, 1, 2000)) return { ok: false, error: 'entity must be {type, value} with a lowercase type and a value of 1 to 2000 characters' };
  if (!isObj(s) || !keysOk(s, ['tool', 'connector', 'version', 'url']) || !str(s.tool, 1, 80) || !str(s.connector, 1, 40) || !str(s.version, 1, 64)) return { ok: false, error: 'source must be {tool, connector, version, url?}' };
  if (s.url !== undefined && (typeof s.url !== 'string' || s.url.length > 500 || !/^https?:\/\/[^\s<>"'`\\]+$/.test(s.url))) return { ok: false, error: 'source.url must be an http(s) address' };
  if (ctx.connector && s.connector !== ctx.connector) return { ok: false, error: 'source.connector must be the connector that printed the result' };
  if (typeof o.observedAt !== 'string' || o.observedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(o.observedAt) || Number.isNaN(Date.parse(o.observedAt))) return { ok: false, error: 'observedAt must be an ISO 8601 date-time' };
  const t = Date.parse(o.observedAt);
  if (t > (ctx.now || Date.now()) + 24 * 3600 * 1000) return { ok: false, error: 'observedAt is in the future' };
  if (!CONFIDENCE.includes(o.confidence)) return { ok: false, error: 'confidence must be confirmed, likely or uncertain' };
  if (o.uncertaintyNote !== undefined && !str(o.uncertaintyNote, 1, 500)) return { ok: false, error: 'uncertaintyNote must be 1 to 500 characters' };
  if (o.confidence === 'uncertain' && o.uncertaintyNote === undefined) return { ok: false, error: 'an uncertain result must say why in uncertaintyNote' };
  const out = {
    entity: { type: e.type, value: e.value },
    source: { tool: s.tool, connector: s.connector, version: s.version, ...(s.url !== undefined ? { url: s.url } : {}) },
    observedAt: new Date(t).toISOString(),
    confidence: o.confidence,
  };
  if (o.uncertaintyNote !== undefined) out.uncertaintyNote = o.uncertaintyNote;
  if (o.raw !== undefined) out.raw = capRaw(o.raw);
  return { ok: true, result: out };
}

// A progress line: {"progress":0..1,"message":""}. Returns null when the object is not a progress line.
function parseProgress(o) {
  if (!isObj(o) || o.progress === undefined || o.entity !== undefined) return null;
  if (!keysOk(o, ['progress', 'message']) || typeof o.progress !== 'number' || !(o.progress >= 0 && o.progress <= 1) || (o.message !== undefined && !str(o.message, 0, 200))) return { error: 'progress line must be {progress: 0..1, message?: text up to 200 characters}' };
  return { progress: o.progress, message: o.message || '' };
}

module.exports = { CONFIDENCE, RAW_CAP, validateResult, parseProgress };
