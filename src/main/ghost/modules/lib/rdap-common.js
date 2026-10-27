'use strict';
// RDAP helpers shared by rdap-domain and rdap-ip-asn: the IANA bootstrap files tell which registry answers for a TLD, address block or
// AS number; the registry's own server then answers the query. Contacts are passed on as the registry publishes them: organisations as `org`,
// individuals as `person`, abuse mailboxes as `email`.
const { ModuleError, inCidr, isoDate, clip, isDnsName } = require('./core');

const BOOTSTRAP = { dns: 'https://data.iana.org/rdap/dns.json', ipv4: 'https://data.iana.org/rdap/ipv4.json', ipv6: 'https://data.iana.org/rdap/ipv6.json', asn: 'https://data.iana.org/rdap/asn.json' };

function pickBase(urls) {
  const https = (urls || []).filter((u) => typeof u === 'string' && /^https:\/\//i.test(u));
  if (!https.length) return null;
  let u;
  try { u = new URL(https[0]); } catch { return null; }
  if (!isDnsName(u.hostname.toLowerCase()) || u.username || u.password || (u.port && u.port !== '443')) return null;
  return { base: u.origin + (u.pathname.endsWith('/') ? u.pathname : u.pathname + '/'), host: u.hostname.toLowerCase() };
}

// kind: 'dns' (key = tld), 'ipv4'/'ipv6' (key = address), 'asn' (key = number). Returns {base, host}; adds the host to the client allowlist.
async function bootstrapFor(client, kind, key) {
  const res = await client.get(BOOTSTRAP[kind], { purpose: 'rdap-bootstrap' });
  if (res.status !== 200) throw new ModuleError('unavailable', 'the registry bootstrap file is not available');
  const doc = res.json();
  if (!doc || !Array.isArray(doc.services)) throw new ModuleError('bad-response', 'the registry bootstrap file has an unexpected shape');
  for (const svc of doc.services) {
    if (!Array.isArray(svc) || !Array.isArray(svc[0]) || !Array.isArray(svc[1])) continue;
    const hit = svc[0].some((e) => {
      if (kind === 'dns') return String(e).toLowerCase() === key;
      if (kind === 'asn') { const [a, b] = String(e).split('-').map(Number); return key >= a && key <= (b === undefined ? a : b); }
      return inCidr(key, e);
    });
    if (!hit) continue;
    const pb = pickBase(svc[1]);
    if (!pb) throw new ModuleError('unavailable', 'the registry for this query offers no https RDAP service');
    client.allow(pb.host);
    return pb;
  }
  throw new ModuleError('unavailable', kind === 'dns' ? `no RDAP service is listed for the TLD .${key}` : 'no registry RDAP service is listed for this address or number');
}

// ---- vCard (jCard) ----
function vcard(entity) {
  const out = { fn: null, kind: null, org: null, emails: [] };
  const arr = entity && entity.vcardArray;
  if (!Array.isArray(arr) || !Array.isArray(arr[1])) return out;
  for (const p of arr[1]) {
    if (!Array.isArray(p) || p.length < 4) continue;
    const [name, , , value] = p;
    if (name === 'fn' && typeof value === 'string') out.fn = value.trim();
    else if (name === 'kind' && typeof value === 'string') out.kind = value.toLowerCase();
    else if (name === 'org') out.org = (Array.isArray(value) ? value[0] : value) || null;
    else if (name === 'email' && typeof value === 'string') out.emails.push(value.trim());
  }
  return out;
}
const REDACTED_RE = /redacted|privacy|not disclosed|withheld/i;

// Walks an RDAP entity tree and passes on what the registry published. Calls cb.org({name, roles, handle}), cb.abuse(email) and cb.person({name, roles, handle, emails}).
// Returns the number of entries the registry itself marked as redacted (a placeholder such as "REDACTED FOR PRIVACY" is not data, so it is counted, not reported).
const ROLE_NAME_RE = /abuse|noc|hostmaster|security|support|desk|team|department|operations|registrar|network/i;
function walkEntities(entities, cb, depth = 0, parentOrg = false) {
  let redacted = 0;
  for (const e of Array.isArray(entities) ? entities : []) {
    if (!e || typeof e !== 'object' || depth > 3) continue;
    const roles = (Array.isArray(e.roles) ? e.roles : []).map((r) => String(r).toLowerCase());
    const v = vcard(e);
    const name = v.org || v.fn;
    const isOrg = v.kind === 'org' || !!v.org || (v.kind !== 'individual' && name && roles.some((r) => ['registrar', 'registry', 'reseller', 'sponsor'].includes(r)));
    const abuse = roles.includes('abuse');
    if (abuse) for (const m of v.emails) cb.abuse(m);
    const roleAccount = abuse && v.kind !== 'individual' && (isOrg || !name || parentOrg || ROLE_NAME_RE.test(name));
    if (name && REDACTED_RE.test(name)) redacted++;
    else if (isOrg && name) cb.org({ name: clip(name, 200), roles, handle: typeof e.handle === 'string' ? clip(e.handle, 100) : undefined });
    else if (name && !roleAccount) cb.person({ name: clip(name, 200), roles, handle: typeof e.handle === 'string' ? clip(e.handle, 100) : undefined, emails: abuse ? [] : v.emails.slice(0, 5) });
    redacted += walkEntities(e.entities, cb, depth + 1, parentOrg || (isOrg && !!name));
  }
  return redacted;
}

function events(doc) {
  const out = [];
  for (const ev of Array.isArray(doc.events) ? doc.events : []) {
    const t = isoDate(ev && ev.eventDate);
    if (t && typeof ev.eventAction === 'string') out.push({ action: clip(ev.eventAction, 40), t });
  }
  return out;
}

module.exports = { BOOTSTRAP, bootstrapFor, walkEntities, events, vcard, pickBase };
