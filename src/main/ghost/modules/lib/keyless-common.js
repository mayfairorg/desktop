'use strict';
// Shared helpers for the keyless connectors (gleif, sec-edgar, nominatim, overpass-query, nasa-gibs, earth-search-stac, gdelt-geo,
// common-crawl-index, rdns, cisa-kev, nvd, hash-file, stix-import, local-snapshot). Pure functions only; no network, no state.
const fs = require('node:fs');
const { ModuleError, isoDate } = require('./core');

const BBOX_PATTERN = '^-?[0-9]+(\\.[0-9]+)?(,-?[0-9]+(\\.[0-9]+)?){3}$';
const DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

// "west,south,east,north" in degrees. maxSpan limits each side, maxArea (square degrees) limits the whole box.
function parseBox(text, { maxSpan = 180, maxArea = Infinity } = {}) {
  const [w, s, e, n] = String(text || '').split(',').map(Number);
  if (![w, s, e, n].every(Number.isFinite) || w < -180 || e > 180 || s < -90 || n > 90 || s >= n || w >= e) throw new ModuleError('bad-input', 'the area must be west,south,east,north in degrees with west < east and south < north');
  if (e - w > maxSpan || n - s > maxSpan || (e - w) * (n - s) > maxArea) throw new ModuleError('bad-input', `the area is too large for this connector (at most ${maxSpan} degrees on a side and ${maxArea === Infinity ? 'no' : maxArea} square degrees); draw a smaller box`);
  return { w, s, e, n, text: [w, s, e, n].join(',') };
}
function parseDay(d) {
  if (d === undefined || d === null || d === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !isoDate(d + 'T00:00:00Z') || isoDate(d + 'T00:00:00Z').slice(0, 10) !== d) throw new ModuleError('bad-input', 'dates must be real calendar dates, YYYY-MM-DD');
  return d;
}
const intOr = (v, def, min, max) => (Number.isInteger(+v) && v !== '' && v !== undefined && v !== null ? Math.max(min, Math.min(max, +v)) : def);

// A query naming a person's contact detail or account is not a query about an organisation, place or topic.
function refuseContactShape(q) {
  if (/@/.test(q) || /(?:\+?\d[\s().-]*){8,}/.test(q) || /^[#@]/.test(q) || /[/\\]/.test(q) || /^https?:/i.test(q)) throw new ModuleError('bad-input', 'this connector takes an organisation, place or topic, not an email address, phone number, handle or address');
}

// Some services answer HTTP 403 for "too fast" or "no proper User-Agent". The shared client reads 403 as "login needed"; this restates it
// honestly for the services where that is not what 403 means.
function reword403(ctx, err, message, { asRateLimit = false } = {}) {
  if (!(err instanceof ModuleError) || !err.loginRequired) throw err;
  if (asRateLimit) { ctx.client.state.unreachable = false; ctx.client.state.rateLimited = true; throw new ModuleError('rate-limited', message); }
  throw new ModuleError('unavailable', message);
}

// Walks parsed JSON without recursion and reports the deepest nesting and the number of values (for size and depth caps).
function jsonShape(root, { maxDepth = 64, maxNodes = 2000000 } = {}) {
  let nodes = 0, depth = 0;
  const stack = [[root, 1]];
  while (stack.length) {
    const [v, d] = stack.pop();
    nodes++;
    if (d > depth) depth = d;
    if (depth > maxDepth || nodes > maxNodes) return { ok: false, depth, nodes };
    if (v && typeof v === 'object') for (const k of Object.keys(v)) stack.push([v[k], d + 1]);
  }
  return { ok: true, depth, nodes };
}
// Nesting depth of JSON text, string-aware, before any parse (a parse of hostile input is the thing we are protecting against).
function textDepth(text, cap) {
  let depth = 0, max = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) { if (c === 92) i++; else if (c === 34) inStr = false; continue; }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) { depth++; if (depth > max) max = depth; if (max > cap) return max; }
    else if (c === 125 || c === 93) depth--;
  }
  return max;
}
// A rolling-window request budget that survives between runs (each run is a separate process): the times of recent requests are kept in a
// small file. check() returns how many milliseconds to wait before another request fits (0 = go); record() notes a request. Best effort:
// an unreadable or unwritable file means no memory, never a failure.
function windowLimit({ file, max, windowMs, now = Date.now }) {
  const load = () => { try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a.filter((t) => Number.isFinite(t) && t <= now() && now() - t < windowMs).slice(-max) : []; } catch { return []; } };
  return {
    check() { const a = load(); return a.length < max ? 0 : Math.max(0, a[a.length - max] + windowMs - now()); },
    record() { try { fs.writeFileSync(file, JSON.stringify([...load(), now()].slice(-max)), { mode: 0o600 }); } catch { /* no memory this time */ } },
  };
}
module.exports = { windowLimit, BBOX_PATTERN, DATE_PATTERN, parseBox, parseDay, intOr, refuseContactShape, reword403, jsonShape, textDepth };
