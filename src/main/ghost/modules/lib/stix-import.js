'use strict';
// Reads a STIX 2.1 bundle (JSON) the user picked and turns its objects into case entities. Local only: no network. Hard caps on file
// size, nesting depth and object count. Natural-person data (individual identities, email addresses, user accounts) is withheld and counted.
const fs = require('node:fs');
const { ModuleError, clip, isDnsName, isoDate } = require('./core');
const K = require('./keyless-common');
const { isIP } = require('node:net');

const MAX_BYTES = 10 * 1048576, MAX_DEPTH = 32, MAX_OBJECTS = 20000, MAX_EMIT = 5000;
const meta = {
  id: 'stix-import', tool: 'mayfair-stix-reader', name: 'STIX bundle import', version: '1.0.0',
  description: 'Reads a STIX 2.1 threat-intelligence bundle file and lists the indicators, domains, addresses, URLs, organisations, malware and other objects it contains as case entries.',
  capabilities: ['threat-intel', 'stix', 'import', 'indicators', 'passive', 'local'], scope: 'local', network: 'local',
  hosts: [], client: { maxRequests: 0, timeoutMs: 60000 },
  restrictions: `None for the service: nothing is sent anywhere. Reads one JSON file of at most ${MAX_BYTES / 1048576} MB, ${MAX_DEPTH} levels deep and ${MAX_OBJECTS} objects. Everything in a bundle is the publisher's claim and is never marked confirmed. Individual identities, email addresses and user accounts are withheld. Only simple one-value indicator patterns are unpacked; other patterns are kept as text.`,
  licence: { spdx: 'MIT', url: 'https://opensource.org/license/mit' }, attribution: 'STIX is an OASIS standard; entries carry the publisher\'s data under the publisher\'s terms', dataTerms: 'Local processing; the bundle keeps the licence its publisher gave it',
  inputs: [
    { name: 'file', type: 'file', label: 'STIX 2.1 bundle (.json)', required: false, maxBytes: MAX_BYTES },
    { name: 'limit', type: 'integer', label: 'Most entries', required: false, min: 1, max: MAX_EMIT },
    { name: 'check', type: 'enum', label: 'Self-check', required: false, values: ['selftest'] },
  ],
  files: ['core.js', 'runtime.js', 'keyless-common.js'],
  selfTest: { input: { check: 'selftest' }, expect: { minResults: 4, contains: [{ type: 'domain', value: 'selftest.example' }] } },
};
const SAMPLE = { type: 'bundle', id: 'bundle--11111111-1111-4111-8111-111111111111', objects: [
  { type: 'indicator', spec_version: '2.1', id: 'indicator--22222222-2222-4222-8222-222222222222', created: '2001-02-03T04:05:06.000Z', modified: '2001-02-03T04:05:06.000Z', name: 'self-check indicator', pattern: "[domain-name:value = 'selftest.example']", pattern_type: 'stix', valid_from: '2001-02-03T04:05:06Z', confidence: 80 },
  { type: 'ipv4-addr', spec_version: '2.1', id: 'ipv4-addr--33333333-3333-4333-8333-333333333333', value: '198.51.100.9' },
  { type: 'identity', spec_version: '2.1', id: 'identity--44444444-4444-4444-8444-444444444444', created: '2001-02-03T04:05:06.000Z', modified: '2001-02-03T04:05:06.000Z', name: 'Self-check Org', identity_class: 'organization' },
  { type: 'identity', spec_version: '2.1', id: 'identity--55555555-5555-4555-8555-555555555555', created: '2001-02-03T04:05:06.000Z', modified: '2001-02-03T04:05:06.000Z', name: 'withheld-sample-name', identity_class: 'individual' },
] };

const DOC_TYPES = new Set(['malware', 'tool', 'threat-actor', 'intrusion-set', 'campaign', 'vulnerability', 'attack-pattern', 'report', 'infrastructure', 'course-of-action', 'grouping', 'malware-analysis']);
const WITHHELD_TYPES = new Set(['email-addr', 'user-account', 'email-message']);
const PAT = /\[\s*(domain-name|ipv4-addr|ipv6-addr|url):value\s*=\s*'((?:[^'\\]|\\.)*)'\s*\]|\[\s*file:hashes\.(?:'SHA-256'|"SHA-256"|SHA-256)\s*=\s*'([0-9a-fA-F]{64})'\s*\]/g;
const unesc = (s) => String(s).replace(/\\(['\\])/g, '$1');

function confOf(o) {
  const c = Number(o && o.confidence);
  if (Number.isFinite(c) && c >= 75) return { confidence: 'likely' };
  return { confidence: 'uncertain', uncertaintyNote: Number.isFinite(c) ? `the bundle's own confidence for this object is ${c} of 100` : 'a claim made in the bundle you supplied, not checked; the bundle gives no confidence score' };
}
const meta2 = (o) => ({ stixId: typeof o.id === 'string' ? clip(o.id, 80) : undefined, created: isoDate(o.created) || undefined, modified: isoDate(o.modified) || undefined, labels: Array.isArray(o.labels) ? o.labels.slice(0, 10).map((l) => clip(String(l), 40)) : undefined });

function parseBundleText(text) {
  if (K.textDepth(text, MAX_DEPTH) > MAX_DEPTH) throw new ModuleError('bad-input', `the file is nested more than ${MAX_DEPTH} levels deep and was not read`);
  let doc;
  try { doc = JSON.parse(text); } catch { throw new ModuleError('bad-input', 'the file is not valid JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.type !== 'bundle' || !Array.isArray(doc.objects)) throw new ModuleError('bad-input', 'this is not a STIX bundle (expected {"type":"bundle","objects":[...]})');
  if (doc.spec_version === '2.0' || doc.objects.some((o) => o && o.spec_version === '2.0')) throw new ModuleError('bad-input', 'this is a STIX 2.0 bundle; this reader supports STIX 2.1');
  if (doc.objects.length > MAX_OBJECTS) throw new ModuleError('bad-input', `the bundle holds ${doc.objects.length} objects; the limit is ${MAX_OBJECTS}`);
  return doc;
}

function convert(ctx, doc, limit) {
  const count = { skipped: 0, withheld: 0, other: new Map(), pattern: 0 };
  const budget = () => ctx.out.count < limit;
  let stopped = false;
  for (const o of doc.objects) {
    if (!budget()) { stopped = true; break; }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') { count.skipped++; continue; }
    const t = o.type, c = confOf(o), base = meta2(o);
    const emit = (type, value, extra = {}) => { if (!budget()) { stopped = true; return; } if (typeof value === 'string' && value.trim()) ctx.emit({ type, value: value.trim(), ...c, raw: { stixType: t, ...base, ...extra } }); };
    if (t === 'indicator') {
      const pat = typeof o.pattern === 'string' ? o.pattern : '';
      let m, found = 0; PAT.lastIndex = 0;
      while ((m = PAT.exec(pat)) && found < 50) {
        found++;
        if (m[3]) emit('document', `sha256:${m[3].toLowerCase()}`, { rel: 'indicator-file-hash', indicator: o.name ? clip(o.name, 120) : undefined });
        else {
          const v = unesc(m[2]).trim();
          if (m[1] === 'domain-name' && isDnsName(v.toLowerCase())) emit('domain', v.toLowerCase(), { rel: 'indicator', indicator: o.name ? clip(o.name, 120) : undefined, validFrom: isoDate(o.valid_from) || undefined, validUntil: isoDate(o.valid_until) || undefined });
          else if ((m[1] === 'ipv4-addr' || m[1] === 'ipv6-addr') && isIP(v.split('/')[0])) emit('ip', v, { rel: 'indicator', indicator: o.name ? clip(o.name, 120) : undefined, validFrom: isoDate(o.valid_from) || undefined, validUntil: isoDate(o.valid_until) || undefined });
          else if (m[1] === 'url' && /^https?:\/\/[^\s<>"'`\\]+$/.test(v)) emit('url', v, { rel: 'indicator', indicator: o.name ? clip(o.name, 120) : undefined, validFrom: isoDate(o.valid_from) || undefined, validUntil: isoDate(o.valid_until) || undefined });
        }
      }
      if (!found) count.pattern++;
      emit('document', `indicator: ${clip(o.name || o.id || 'unnamed', 200)}`, { pattern: clip(pat, 500), patternType: o.pattern_type, validFrom: isoDate(o.valid_from) || undefined, validUntil: isoDate(o.valid_until) || undefined, unpackedValues: found });
    } else if (t === 'domain-name') { const v = String(o.value || '').toLowerCase(); if (isDnsName(v)) emit('domain', v); else count.skipped++; }
    else if (t === 'ipv4-addr' || t === 'ipv6-addr') { if (isIP(String(o.value || '').split('/')[0])) emit('ip', String(o.value)); else count.skipped++; }
    else if (t === 'url') { if (/^https?:\/\/[^\s<>"'`\\]+$/.test(String(o.value || ''))) emit('url', String(o.value)); else count.skipped++; }
    else if (t === 'autonomous-system') { if (Number.isInteger(o.number) && o.number >= 0) emit('asn', `AS${o.number}`, { name: o.name ? clip(o.name, 120) : undefined }); else count.skipped++; }
    else if (t === 'file') { const h = o.hashes && (o.hashes['SHA-256'] || o.hashes['SHA-1'] || o.hashes.MD5); const algo = o.hashes && (o.hashes['SHA-256'] ? 'sha256' : o.hashes['SHA-1'] ? 'sha1' : 'md5'); if (typeof h === 'string' && /^[0-9a-fA-F]{32,64}$/.test(h)) emit('document', `${algo}:${h.toLowerCase()}`, { fileName: o.name ? clip(o.name, 120) : undefined, size: Number.isInteger(o.size) ? o.size : undefined }); else count.skipped++; }
    else if (t === 'x509-certificate') { const h = o.hashes && (o.hashes['SHA-256'] || o.hashes['SHA-1']); if (typeof h === 'string' && /^[0-9a-fA-F]{40,64}$/.test(h)) emit('cert', h.toLowerCase(), { serial: o.serial_number ? clip(String(o.serial_number), 80) : undefined }); else count.skipped++; }
    else if (t === 'identity') {
      if (o.identity_class === 'organization' && typeof o.name === 'string') emit('org', clip(o.name, 300), { sectors: Array.isArray(o.sectors) ? o.sectors.slice(0, 5) : undefined });
      else if (o.identity_class === 'individual') count.withheld++;
      else count.skipped++;
    } else if (t === 'location') {
      const where = typeof o.name === 'string' && o.name.trim() ? o.name : [o.city, o.administrative_area, o.country].filter((x) => typeof x === 'string' && x).join(', ');
      const lat = Number(o.latitude), lon = Number(o.longitude);
      if (where) emit('place', clip(where, 300), Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : {});
      else if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) emit('place', `${lat},${lon}`);
      else count.skipped++;
    } else if (DOC_TYPES.has(t)) { if (typeof o.name === 'string' && o.name.trim()) emit('document', `${t}: ${clip(o.name, 200)}`, { aliases: Array.isArray(o.aliases) ? o.aliases.slice(0, 5).map((a) => clip(String(a), 60)) : undefined, description: o.description ? clip(String(o.description), 300) : undefined }); else count.skipped++; }
    else if (WITHHELD_TYPES.has(t)) count.withheld++;
    else { count.skipped++; count.other.set(t, (count.other.get(t) || 0) + 1); }
  }
  if (stopped) ctx.note(`stopped at ${limit} entries`);
  return count;
}

async function run(ctx, input) {
  const limit = K.intOr(input.limit, 1000, 1, MAX_EMIT);
  let text;
  if (input.check === 'selftest') text = JSON.stringify(SAMPLE);
  else {
    if (!input.file) throw new ModuleError('bad-input', 'pick a STIX bundle file');
    let st;
    try { st = fs.statSync(input.file); } catch { throw new ModuleError('bad-input', 'the file cannot be read'); }
    if (!st.isFile()) throw new ModuleError('bad-input', 'not a regular file');
    if (st.size > MAX_BYTES) throw new ModuleError('bad-input', `the file is ${Math.round(st.size / 1048576)} MB; the limit is ${MAX_BYTES / 1048576} MB`);
    text = fs.readFileSync(input.file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  }
  ctx.progress(0.2, 'reading the bundle');
  const doc = parseBundleText(text);
  const n = convert(ctx, doc, limit);
  if (n.withheld) ctx.note(`${n.withheld} object(s) about individuals, email addresses or accounts were withheld`);
  if (n.pattern) ctx.note(`${n.pattern} indicator(s) use a pattern too complex to unpack and are kept as text`);
  if (n.skipped) ctx.note(`${n.skipped} object(s) skipped${n.other.size ? ' (types without a case entry: ' + [...n.other.entries()].slice(0, 6).map(([k, v]) => `${k} x${v}`).join(', ') + ')' : ''}`);
  ctx.note('everything here is the bundle publisher\'s claim: check it before relying on it');
  ctx.progress(1);
}
module.exports = { meta, run, parseBundleText };
