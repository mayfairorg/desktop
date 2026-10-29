'use strict';
// Ghost case model: the case file (format mayfair-ghost-case/1), merging, provenance, timeline, undo and redo, search and paths.
// Plain functions on plain objects. No DOM, no Node-only calls: the page edits a case with these, and the main process runs `validate` on
// every save, so a case that breaks the provenance rule is never written to the vault.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GhostCase = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const FORMAT = 'mayfair-ghost-case/1';
  // The case entity types. `person` connects CEOs, directors and owners to organisations; it is filled by hand from sources the analyst found (or passed through from a registry
  // that published it). `service` (an open port or service) and `finding` (anything else a tool reports, kept with its own kind) let the security connectors land on the board.
  const ENTITY_TYPES = ['domain', 'ip', 'asn', 'cert', 'org', 'person', 'document', 'image', 'place', 'event', 'url', 'email', 'service', 'finding'];
  // `custom` is a link with a free-text label of the analyst's choosing (any link can also carry a label).
  const REL = ['resolves-to', 'name-server', 'mail-exchanger', 'announced-by', 'covers', 'issued-by', 'registered-by', 'registrar', 'located-at', 'subdomain-of', 'contains', 'depicts', 'mentions', 'archived-as', 'linked-to', 'same-as', 'found-for', 'ceo-of', 'director-of', 'owner-of', 'works-with', 'custom'];
  const SYMMETRIC = ['same-as', 'works-with'];
  // Custom fields: any title, any value. The kind only tells the page how to show and edit it; nothing is refused because of what a title or value says.
  const FIELD_KINDS = ['text', 'longtext', 'link', 'date', 'number'];
  // Suggested fields for a Person (professional ones). Offered by the form; the person may use, rename or delete them.
  const PERSON_SUGGESTED = [{ title: 'Role / title', kind: 'text' }, { title: 'Organisation(s)', kind: 'text' }, { title: 'Appointed date', kind: 'date' }, { title: 'Public profile link', kind: 'link' }];
  const EMAIL_ROLES = ['abuse-contact', 'registrar-contact', 'security-contact', 'mx', 'cert-subject', 'dmarc-report', 'soa-contact'];
  const UNDO_LIMIT = 50;
  const LIMITS = { entities: 5000, edges: 20000, sources: 5000, notes: 2000, tags: 24, tagLen: 32, noteLen: 20000, label: 300, title: 200, fields: 200, fieldTitle: 300, fieldValue: 20000, fieldSource: 1000, edgeLabel: 200 };

  const ALIASES = {
    domain: ['domain', 'hostname', 'host', 'fqdn', 'subdomain', 'dns-name'],
    ip: ['ip', 'ipv4', 'ipv6', 'ip-address', 'ipaddress'],
    asn: ['asn', 'autonomous-system'],
    cert: ['cert', 'certificate', 'tls-cert', 'tls-certificate', 'x509'],
    org: ['org', 'organisation', 'organization', 'company', 'registered-entity'],
    person: ['person', 'people', 'individual'],
    document: ['document', 'doc', 'file', 'pdf'],
    image: ['image', 'photo', 'picture'],
    place: ['place', 'location', 'site', 'landmark'],
    event: ['event', 'news-item', 'article'],
    url: ['url', 'uri', 'link', 'web-page', 'page'],
    email: ['email', 'mailbox'],
    service: ['service', 'port', 'open-port', 'listening-service'],
  };
  const ALIAS_TO_TYPE = {};
  for (const [t, list] of Object.entries(ALIASES)) for (const a of list) ALIAS_TO_TYPE[a] = t;
  // Account-style kinds (usernames, handles, profiles, phone numbers, faces ...) are not a case type; kept as findings, not blocked.
  // A `person` result is a Person entity.
  const ACCOUNT_KIND = /(^|[-_.])(user|username|handle|account|profile|social|phone|telephone|mobile|face|name|surname|relative|resident|occupant)([-_.]|$)/i;

  const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  function uid() {
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => { const r = (Math.random() * 16) | 0; return (ch === 'x' ? r : (r & 3) | 8).toString(16); });
  }
  const nowIso = (now) => new Date(now === undefined ? Date.now() : now).toISOString();

  // ---------- types and keys ----------
  function isAccountKind(raw) { return ACCOUNT_KIND.test(String(raw || '')); }
  function mapType(raw) {
    const r = String(raw || '').toLowerCase().trim();
    if (ENTITY_TYPES.includes(r) && r !== 'finding') return { type: r, kind: null };
    if (ALIAS_TO_TYPE[r]) return { type: ALIAS_TO_TYPE[r], kind: null };
    return { type: 'finding', kind: r || 'finding' };
  }
  function hostOf(v) { try { return new URL('http://' + String(v).trim() + '/').hostname; } catch { return String(v).trim().toLowerCase(); } }
  // Canonical value used to merge duplicates: lowercase punycode domains, compressed IPv6, AS + number, sha256 hex, normalised names.
  function canonKey(type, value, kind) {
    const v = String(value === undefined || value === null ? '' : value).trim();
    switch (type) {
      case 'domain': return hostOf(v).replace(/\.$/, '');
      case 'ip': { if (v.indexOf(':') >= 0) { try { return new URL('http://[' + v.replace(/^\[|\]$/g, '') + ']/').hostname.slice(1, -1); } catch { return v.toLowerCase(); } } return v; }
      case 'asn': { const m = /(\d{1,10})/.exec(v); return m ? 'AS' + Number(m[1]) : v.toUpperCase(); }
      case 'cert': return v.replace(/[^0-9a-f]/gi, '').toLowerCase() || v.toLowerCase();
      case 'org': case 'person': return v.toLowerCase().replace(/\s+/g, ' ');
      case 'url': { try { const u = new URL(v); return u.protocol + '//' + u.host.toLowerCase() + (u.pathname === '/' ? '' : u.pathname); } catch { return v; } }
      case 'email': return v.toLowerCase();
      case 'finding': return (kind || 'finding') + ':' + v;
      default: return v.toLowerCase();
    }
  }
  const stripQuery = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return ''; } };

  // ---------- creating and shaping a case ----------
  function newCase(title, now) {
    const t = nowIso(now);
    return { format: FORMAT, id: uid(), title: clip(title || 'Untitled case', LIMITS.title), created: t, updated: t, tz: 'UTC', entities: {}, edges: {}, sources: {}, timeline: [], notes: [], settings: { reportAuthor: '', hideFromReport: [] } };
  }
  function touch(c, now) { c.updated = nowIso(now); return c; }

  function addSource(c, s) {
    const id = s.id || uid();
    c.sources[id] = { id, connector: clip(s.connector, 40), connectorVersion: clip(s.connectorVersion, 40), query: s.query ? { kind: clip(s.query.kind, 20), value: clip(s.query.value, 500) } : null, fetchedAt: s.fetchedAt || nowIso(),
      origin: clip(stripQuery(s.origin || '') || '', 500), licence: clip(s.licence, 200), attribution: clip(s.attribution, 300), rawSha256: /^[0-9a-f]{64}$/.test(s.rawSha256 || '') ? s.rawSha256 : '', note: clip(s.note, 500) };
    return id;
  }
  // Adds an entity, or merges into the one with the same type and key (sources joined, first and last seen widened).
  // `o.duplicate` (used for people added by hand: two different people can share a name) always makes a new entity instead of merging by name.
  // `o.fields` is a list of {title, value, kind?, source?} added as custom fields (on a merge, the ones the entity does not already have).
  function addEntity(c, o) {
    const type = ENTITY_TYPES.includes(o.type) ? o.type : 'finding';
    let key = canonKey(type, o.key !== undefined ? o.key : o.value !== undefined ? o.value : o.label, o.attrs && o.attrs.kind);
    const found = o.duplicate ? null : Object.values(c.entities).find((e) => e.type === type && e.key === key);
    const seen = o.seen || nowIso();
    const srcs = (o.sources || []).filter((s) => c.sources[s]);
    if (found) {
      for (const s of srcs) if (!found.sources.includes(s)) found.sources.push(s);
      if (seen < found.firstSeen) found.firstSeen = seen; if (seen > found.lastSeen) found.lastSeen = seen;
      if (o.attrs) for (const [k, v] of Object.entries(o.attrs)) if (found.attrs[k] === undefined) found.attrs[k] = v;
      found.fields = found.fields || [];
      for (const f of o.fields || []) if (!hasField(found, f)) pushField(found, f, seen);
      return { id: found.id, merged: true };
    }
    if (Object.keys(c.entities).length >= LIMITS.entities) return { id: null, error: 'This case already holds ' + LIMITS.entities + ' entities.' };
    const id = o.id || uid();
    if (o.duplicate && Object.values(c.entities).some((e) => e.type === type && e.key === key)) key = key + '#' + id.slice(0, 6);
    const ent = { id, type, key, label: clip(o.label || o.value || key, LIMITS.label), attrs: isObj(o.attrs) ? { ...o.attrs } : {}, fields: [], sources: srcs, tags: [], firstSeen: seen, lastSeen: seen, manual: !!o.manual, pos: o.pos || null, pinned: false };
    for (const f of o.fields || []) pushField(ent, f, seen);
    c.entities[id] = ent;
    return { id, merged: false };
  }

  // ---------- custom fields (every entity type, Person included) ----------
  // A field is {id, title, value, kind, source, t, updated}: a title and a value of the analyst's choosing, where it came from (free text), when it was recorded and when it last changed.
  // Nothing is refused for what a title or value says; only the size limits apply. Order is the order of the list.
  const fieldKind = (k) => (FIELD_KINDS.includes(k) ? k : 'text');
  const fieldText = (v, n) => clip(typeof v === 'number' && Number.isFinite(v) ? String(v) : v, n);
  function makeField(f, when) {
    f = isObj(f) ? f : {};
    return { id: typeof f.id === 'string' && f.id ? clip(f.id, 64) : uid(), title: fieldText(f.title, LIMITS.fieldTitle), value: fieldText(f.value, LIMITS.fieldValue), kind: fieldKind(f.kind), source: fieldText(f.source, LIMITS.fieldSource), t: typeof f.t === 'string' && f.t ? f.t : when, updated: typeof f.updated === 'string' && f.updated ? f.updated : (typeof f.t === 'string' && f.t ? f.t : when) };
  }
  function pushField(e, f, when) { if ((e.fields || (e.fields = [])).length >= LIMITS.fields) return null; const x = makeField(f, when || nowIso()); e.fields.push(x); return x.id; }
  const sameField = (a, b) => String(a.title) === String(b.title) && String(a.value) === String(b.value) && fieldKind(a.kind) === fieldKind(b.kind);
  const hasField = (e, f) => (e.fields || []).some((x) => sameField(x, makeField(f, '')));
  function addField(c, entityId, f, now) { const e = c.entities[entityId]; if (!e) return null; const id = pushField(e, f, nowIso(now)); if (id) touch(c, now); return id; }
  // patch may carry title, value, kind, source; anything missing stays.
  function updateField(c, entityId, fieldId, patch, now) {
    const e = c.entities[entityId], f = e && (e.fields || []).find((x) => x.id === fieldId); if (!f || !isObj(patch)) return false;
    if (patch.title !== undefined) f.title = fieldText(patch.title, LIMITS.fieldTitle);
    if (patch.value !== undefined) f.value = fieldText(patch.value, LIMITS.fieldValue);
    if (patch.kind !== undefined) f.kind = fieldKind(patch.kind);
    if (patch.source !== undefined) f.source = fieldText(patch.source, LIMITS.fieldSource);
    f.updated = nowIso(now); touch(c, now); return true;
  }
  function removeField(c, entityId, fieldId) { const e = c.entities[entityId]; if (!e || !e.fields) return false; const i = e.fields.findIndex((x) => x.id === fieldId); if (i < 0) return false; e.fields.splice(i, 1); touch(c); return true; }
  // to: a new index, or 'up' / 'down' / 'top' / 'bottom'.
  function moveField(c, entityId, fieldId, to) {
    const e = c.entities[entityId], list = e && e.fields; if (!list) return false;
    const i = list.findIndex((x) => x.id === fieldId); if (i < 0) return false;
    const j = to === 'up' ? i - 1 : to === 'down' ? i + 1 : to === 'top' ? 0 : to === 'bottom' ? list.length - 1 : Number(to);
    if (!Number.isInteger(j) || j < 0 || j >= list.length || j === i) return false;
    const [x] = list.splice(i, 1); list.splice(j, 0, x); touch(c); return true;
  }
  const fieldsOf = (e) => (Array.isArray(e && e.fields) ? e.fields : []);
  function addEdge(c, o) {
    if (!c.entities[o.from] || !c.entities[o.to] || o.from === o.to) return { id: null };
    const rel = REL.includes(o.rel) ? o.rel : 'linked-to';
    const label = clip(o.label, LIMITS.edgeLabel).trim();
    const dup = Object.values(c.edges).find((e) => e.rel === rel && (e.label || '') === label && ((e.from === o.from && e.to === o.to) || (SYMMETRIC.includes(rel) && e.from === o.to && e.to === o.from)));
    const srcs = (o.sources || []).filter((s) => c.sources[s]);
    if (dup) { for (const s of srcs) if (!dup.sources.includes(s)) dup.sources.push(s); return { id: dup.id, merged: true }; }
    if (Object.keys(c.edges).length >= LIMITS.edges) return { id: null, error: 'This case already holds ' + LIMITS.edges + ' links.' };
    const id = o.id || uid();
    c.edges[id] = { id, from: o.from, to: o.to, rel, sources: srcs, t: o.t || nowIso(), manual: !!o.manual };
    if (label) c.edges[id].label = label;
    if (o.sourceNote) c.edges[id].sourceNote = clip(o.sourceNote, LIMITS.fieldSource);
    return { id, merged: false };
  }

  // Adds what a connector run returned. `results` are the runner's validated lines {entity:{type,value}, source:{tool,connector,version,url?}, observedAt, confidence, uncertaintyNote?, raw?}.
  // `rawSha256` (hex, computed by the caller) fingerprints the raw output; the raw data itself is never stored. Returns counts, including what was withheld.
  function ingest(c, { connector, query, results, rawSha256, now }) {
    const out = { added: 0, merged: 0, links: 0, withheld: 0, withheldReasons: {}, ids: [] };
    const bySrc = new Map();
    const srcFor = (origin) => {
      const k = stripQuery(origin || '');
      if (!bySrc.has(k)) bySrc.set(k, addSource(c, { connector: connector.id, connectorVersion: connector.version, query, fetchedAt: nowIso(now), origin: k, licence: connector.licence || '', attribution: connector.attribution || '', rawSha256 }));
      return bySrc.get(k);
    };
    const withhold = (why) => { out.withheld++; out.withheldReasons[why] = (out.withheldReasons[why] || 0) + 1; };
    let target = null;
    const qtype = query && ({ domain: 'domain', ip: 'ip', asn: 'asn', url: 'url', 'cert-hash': 'cert', org: 'org', place: 'place' })[query.kind];
    const first = srcFor('');
    if (qtype && query.value) { const r = addEntity(c, { type: qtype, value: query.value, label: query.value, sources: [first], manual: false, seen: nowIso(now) }); target = r.id; }
    for (const r of results || []) {
      const e = r && r.entity; if (!e || typeof e.type !== 'string' || typeof e.value !== 'string') { withhold('invalid'); continue; }
      const m = mapType(e.type);
      const sid = srcFor(r.source && r.source.url);
      const attrs = {}; if (m.kind) attrs.kind = m.kind; if (r.confidence) attrs.confidence = r.confidence; if (r.uncertaintyNote) attrs.uncertaintyNote = clip(r.uncertaintyNote, 300);
      if (m.type === 'email' && r.raw && r.raw.role) attrs.role = r.raw.role;
      const seen = r.observedAt || nowIso(now);
      // what a registry or database published about a person goes in as fields, each with the connector it came from and the time
      const fields = [];
      if (m.type === 'person' && isObj(r.raw)) {
        const src = connector.id + (r.source && r.source.url ? ' ' + stripQuery(r.source.url) : '');
        const roles = Array.isArray(r.raw.roles) ? r.raw.roles.join(', ') : r.raw.role;
        if (roles) fields.push({ title: 'Role', value: roles, source: src, t: seen });
        if (r.raw.description) fields.push({ title: 'Description', value: r.raw.description, source: src, t: seen });
        if (r.raw.of) fields.push({ title: 'Associated with', value: r.raw.of, source: src, t: seen });
        if (Array.isArray(r.raw.emails)) for (const m of r.raw.emails.slice(0, 5)) fields.push({ title: 'Email (as published)', value: String(m), source: src, t: seen });
        if (r.raw.handle) fields.push({ title: 'Registry handle', value: r.raw.handle, source: src, t: seen });
        if (r.raw.qid) fields.push({ title: 'Wikidata item', value: 'https://www.wikidata.org/wiki/' + r.raw.qid, kind: 'link', source: src, t: seen });
      }
      const res = addEntity(c, { type: m.type, value: e.value, label: e.value, attrs, fields, sources: [sid], manual: false, seen });
      if (!res.id) { withhold('limit'); continue; }
      res.merged ? out.merged++ : out.added++; out.ids.push(res.id);
      if (target && res.id !== target) { const ed = addEdge(c, { from: target, to: res.id, rel: 'found-for', sources: [sid], t: seen }); if (ed.id && !ed.merged) out.links++; }
    }
    // a source that ended up with nothing attached is not kept
    for (const [k, sid] of [...bySrc]) { const used = Object.values(c.entities).some((x) => x.sources.includes(sid)) || Object.values(c.edges).some((x) => x.sources.includes(sid)); if (!used) { delete c.sources[sid]; bySrc.delete(k); } }
    touch(c, now); return out;
  }

  function removeEntity(c, id) {
    if (!c.entities[id]) return false;
    delete c.entities[id];
    for (const [k, e] of Object.entries(c.edges)) if (e.from === id || e.to === id) delete c.edges[k];
    for (const n of c.notes) n.refs = (n.refs || []).filter((r) => r !== id);
    for (const t of c.timeline) if (t.entity === id) t.entity = null;
    c.settings.hideFromReport = (c.settings.hideFromReport || []).filter((x) => x !== id);
    touch(c); return true;
  }
  function removeEdge(c, id) { if (!c.edges[id]) return false; delete c.edges[id]; touch(c); return true; }
  // Removing a source never silently removes what depended on it: those things show as "unsourced".
  function removeSource(c, id) {
    if (!c.sources[id]) return false; delete c.sources[id];
    for (const e of Object.values(c.entities)) e.sources = e.sources.filter((s) => s !== id);
    for (const e of Object.values(c.edges)) e.sources = e.sources.filter((s) => s !== id);
    touch(c); return true;
  }
  const isUnsourced = (x) => !x.manual && (!x.sources || !x.sources.length);

  function addTag(c, id, tag) {
    const e = c.entities[id], t = clip(tag, LIMITS.tagLen).trim().toLowerCase().replace(/\s+/g, '-');
    if (!e || !t || e.tags.includes(t) || e.tags.length >= LIMITS.tags) return false;
    e.tags.push(t); touch(c); return true;
  }
  function removeTag(c, id, tag) { const e = c.entities[id]; if (!e || !e.tags.includes(tag)) return false; e.tags = e.tags.filter((x) => x !== tag); touch(c); return true; }
  function allTags(c) { const m = {}; for (const e of Object.values(c.entities)) for (const t of e.tags) m[t] = (m[t] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([tag, n]) => ({ tag, n })); }

  function addNote(c, text, refs, now) {
    const t = clip(text, LIMITS.noteLen).trim(); if (!t || c.notes.length >= LIMITS.notes) return null;
    const n = { id: uid(), t: nowIso(now), text: t, refs: (refs || []).filter((r) => c.entities[r]) }; c.notes.push(n); touch(c, now); return n.id;
  }
  function editNote(c, id, text) { const n = c.notes.find((x) => x.id === id); if (!n) return false; n.text = clip(text, LIMITS.noteLen); touch(c); return true; }
  function deleteNote(c, id) { const i = c.notes.findIndex((x) => x.id === id); if (i < 0) return false; c.notes.splice(i, 1); touch(c); return true; }
  function addEvent(c, { t, title, entity, precision }) {
    const when = Date.parse(t); if (!Number.isFinite(when) || !clip(title, 300).trim()) return null;
    const ev = { id: uid(), t: new Date(when).toISOString(), precision: precision || 'day', kind: 'note', entity: entity && c.entities[entity] ? entity : null, title: clip(title, 300).trim(), sources: [], manual: true };
    c.timeline.push(ev); touch(c); return ev.id;
  }
  function deleteEvent(c, id) { const i = c.timeline.findIndex((x) => x.id === id); if (i < 0) return false; c.timeline.splice(i, 1); touch(c); return true; }

  // Timeline: dates the entities carry (registration, certificate validity), when each source was fetched, and events added by hand. Newest last.
  function buildTimeline(c) {
    const out = [];
    const dateOf = (v) => { const t = Date.parse(v); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
    for (const e of Object.values(c.entities)) {
      const a = e.attrs || {};
      const push = (kind, t, title) => { const d = dateOf(t); if (d) out.push({ id: 'g-' + e.id + '-' + kind, t: d, kind, entity: e.id, title, sources: e.sources.slice(), manual: false }); };
      if (e.type === 'domain') push('registered', a.registered, 'Registered: ' + e.label);
      if (e.type === 'cert') { push('cert-issued', a.notBefore, 'Certificate issued: ' + e.label.slice(0, 16)); push('cert-expires', a.notAfter, 'Certificate expires: ' + e.label.slice(0, 16)); }
      if (e.type === 'event') push(a.kind || 'event', a.t, e.label);
      if (e.type === 'document') push('created', a.created, 'Document created: ' + e.label);
    }
    for (const s of Object.values(c.sources)) { const d = dateOf(s.fetchedAt); if (d) out.push({ id: 'g-src-' + s.id, t: d, kind: 'lookup', entity: null, title: 'Looked up with ' + s.connector + (s.query ? ': ' + s.query.value : ''), sources: [s.id], manual: false }); }
    for (const t of c.timeline) out.push({ ...t });
    out.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.id < y.id ? -1 : 1));
    return out;
  }

  // ---------- graph helpers ----------
  function neighbours(c, id) {
    const out = [];
    for (const e of Object.values(c.edges)) { if (e.from === id) out.push({ edge: e, other: e.to, dir: 'out' }); else if (e.to === id) out.push({ edge: e, other: e.from, dir: 'in' }); }
    return out;
  }
  function shortestPath(c, from, to) {
    if (!c.entities[from] || !c.entities[to]) return null;
    if (from === to) return { nodes: [from], edges: [] };
    const adj = {}; for (const e of Object.values(c.edges)) { (adj[e.from] = adj[e.from] || []).push([e.to, e.id]); (adj[e.to] = adj[e.to] || []).push([e.from, e.id]); }
    const prev = { [from]: null }, q = [from];
    while (q.length) { const n = q.shift(); for (const [m, eid] of adj[n] || []) if (!(m in prev)) { prev[m] = [n, eid]; if (m === to) { const nodes = [to], edges = []; let k = to; while (prev[k]) { edges.unshift(prev[k][1]); k = prev[k][0]; nodes.unshift(k); } return { nodes, edges }; } q.push(m); } }
    return null;
  }
  function search(c, q) {
    const t = String(q || '').trim().toLowerCase(); if (!t) return Object.keys(c.entities);
    const has = (v) => String(v === undefined || v === null ? '' : v).toLowerCase().includes(t);
    return Object.values(c.entities).filter((e) => e.label.toLowerCase().includes(t) || e.key.toLowerCase().includes(t) || e.type === t || e.tags.some((x) => x.includes(t)) || Object.values(e.attrs || {}).some((v) => typeof v === 'string' && v.toLowerCase().includes(t))
      || fieldsOf(e).some((f) => has(f.title) || has(f.value) || has(f.source))).map((e) => e.id);
  }
  function stats(c) { return { entities: Object.keys(c.entities).length, edges: Object.keys(c.edges).length, sources: Object.keys(c.sources).length, notes: c.notes.length, places: Object.values(c.entities).filter((e) => e.type === 'place' && placeCoords(e)).length }; }
  function placeCoords(e) { const a = e.attrs || {}; const lat = Number(a.lat), lon = Number(a.lon); return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && a.lat !== '' && a.lon !== '' ? { lat, lon } : null; }

  // Deterministic layout for entities that have no position yet (positions are fractions of the canvas, 0 to 1). Existing positions stay.
  function layout(c, iterations) {
    const ids = Object.keys(c.entities); if (!ids.length) return;
    const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };
    const P = {}; let fresh = 0;
    for (const id of ids) { const e = c.entities[id]; if (e.pos && Number.isFinite(e.pos.x) && Number.isFinite(e.pos.y)) P[id] = { x: e.pos.x, y: e.pos.y, fixed: true }; else { P[id] = { x: 0.15 + 0.7 * hash(id), y: 0.15 + 0.7 * hash(id + 'y'), fixed: false }; fresh++; } }
    if (!fresh) return;
    const edges = Object.values(c.edges), k = Math.sqrt(1 / Math.max(ids.length, 4)) * 0.9;
    const n = iterations || Math.min(260, 60 + ids.length * 2);
    for (let it = 0; it < n; it++) {
      const cool = 0.08 * (1 - it / n) + 0.004, D = {}; for (const id of ids) D[id] = { x: 0, y: 0 };
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        const a = P[ids[i]], b = P[ids[j]]; let dx = a.x - b.x, dy = a.y - b.y; let d = Math.sqrt(dx * dx + dy * dy) || 0.001;
        const f = (k * k) / d; dx /= d; dy /= d; D[ids[i]].x += dx * f; D[ids[i]].y += dy * f; D[ids[j]].x -= dx * f; D[ids[j]].y -= dy * f;
      }
      for (const e of edges) { const a = P[e.from], b = P[e.to]; if (!a || !b) continue; let dx = a.x - b.x, dy = a.y - b.y; const d = Math.sqrt(dx * dx + dy * dy) || 0.001; const f = (d * d) / k; dx /= d; dy /= d; D[e.from].x -= dx * f; D[e.from].y -= dy * f; D[e.to].x += dx * f; D[e.to].y += dy * f; }
      for (const id of ids) { const p = P[id]; if (p.fixed) continue; p.x += (D[id].x - (p.x - 0.5) * 0.02) * cool * 0.9; p.y += (D[id].y - (p.y - 0.5) * 0.02) * cool * 0.9; p.x = Math.min(0.96, Math.max(0.04, p.x)); p.y = Math.min(0.94, Math.max(0.06, p.y)); }
    }
    for (const id of ids) if (!P[id].fixed) c.entities[id].pos = { x: Math.round(P[id].x * 1000) / 1000, y: Math.round(P[id].y * 1000) / 1000 };
  }

  // ---------- validation (run in the page, and again in main before anything is written) ----------
  function validate(c) {
    const p = [];
    if (!isObj(c)) return ['The case is not an object.'];
    if (c.format !== FORMAT) p.push('Unknown case format.');
    if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(c.id)) p.push('The case id is not valid.');
    if (typeof c.title !== 'string' || !c.title.trim() || c.title.length > LIMITS.title) p.push('The case needs a title of up to ' + LIMITS.title + ' characters.');
    for (const k of ['entities', 'edges', 'sources']) if (!isObj(c[k])) p.push('"' + k + '" must be an object.');
    if (!Array.isArray(c.timeline) || !Array.isArray(c.notes)) p.push('"timeline" and "notes" must be lists.');
    if (p.length) return p;
    if (Object.keys(c.entities).length > LIMITS.entities) p.push('Too many entities.');
    if (Object.keys(c.edges).length > LIMITS.edges) p.push('Too many links.');
    if (Object.keys(c.sources).length > LIMITS.sources) p.push('Too many sources.');
    for (const [id, e] of Object.entries(c.entities)) {
      if (!isObj(e) || e.id !== id) { p.push('Entity ' + id + ' is malformed.'); continue; }
      if (!ENTITY_TYPES.includes(e.type)) p.push('Entity ' + id + ' has a type Ghost does not store (' + clip(e.type, 20) + ').');
      if (e.fields !== undefined) { if (!Array.isArray(e.fields)) p.push('Entity ' + id + ' has fields that are not a list.'); else if (e.fields.length > LIMITS.fields) p.push('Entity ' + id + ' has too many fields.'); else for (const f of e.fields) if (!isObj(f) || typeof f.id !== 'string' || !f.id || typeof f.title !== 'string' || typeof f.value !== 'string') { p.push('Entity ' + id + ' has a malformed field.'); break; } }
      if (typeof e.key !== 'string' || !e.key) p.push('Entity ' + id + ' has no key.');
      if (e.type === 'email' && !(e.attrs && EMAIL_ROLES.includes(e.attrs.role))) p.push('Entity ' + id + ' is an email without an infrastructure role.');
      if (!e.manual && (!Array.isArray(e.sources) || !e.sources.length)) p.push('Entity "' + clip(e.label, 60) + '" has no source and was not added by hand.');
      for (const s of e.sources || []) if (!c.sources[s]) { /* a deleted source: shown as unsourced, but the case still loads */ }
    }
    for (const [id, e] of Object.entries(c.edges)) {
      if (!isObj(e) || e.id !== id || !c.entities[e.from] || !c.entities[e.to]) { p.push('Link ' + id + ' points at something missing.'); continue; }
      if (!REL.includes(e.rel)) p.push('Link ' + id + ' has an unknown relation.');
      if (e.label !== undefined && typeof e.label !== 'string') p.push('Link ' + id + ' has a label that is not text.');
      if (!e.manual && (!Array.isArray(e.sources) || !e.sources.length)) p.push('Link ' + id + ' has no source and was not added by hand.');
    }
    return p;
  }
  // Repairs what can be repaired on load (missing optional fields, old shapes) without inventing anything.
  function normalize(c) {
    c.settings = isObj(c.settings) ? c.settings : {}; c.settings.hideFromReport = Array.isArray(c.settings.hideFromReport) ? c.settings.hideFromReport : []; c.settings.reportAuthor = clip(c.settings.reportAuthor, 120);
    for (const e of Object.values(c.entities)) { e.tags = Array.isArray(e.tags) ? e.tags : []; e.sources = Array.isArray(e.sources) ? e.sources : []; e.attrs = isObj(e.attrs) ? e.attrs : {}; e.fields = Array.isArray(e.fields) ? e.fields.filter(isObj).slice(0, LIMITS.fields).map((f) => makeField(f, e.firstSeen || c.created)) : []; e.label = e.label || e.key; e.firstSeen = e.firstSeen || c.created; e.lastSeen = e.lastSeen || c.created; if (e.pos && !(Number.isFinite(e.pos.x) && Number.isFinite(e.pos.y))) e.pos = null; }
    for (const e of Object.values(c.edges)) { e.sources = Array.isArray(e.sources) ? e.sources : []; if (e.label !== undefined) { e.label = clip(e.label, LIMITS.edgeLabel); if (!e.label) delete e.label; } }
    c.timeline = c.timeline.filter(isObj); c.notes = c.notes.filter(isObj).map((n) => ({ ...n, refs: Array.isArray(n.refs) ? n.refs : [] }));
    return c;
  }

  // Changes how a link you made reads: the relation, a free-text label and where you found it. Returns false when nothing matches or the change would repeat another link.
  function updateEdge(c, id, patch, now) {
    const e = c.edges[id]; if (!e || !isObj(patch)) return false;
    const rel = patch.rel !== undefined ? (REL.includes(patch.rel) ? patch.rel : e.rel) : e.rel;
    const label = patch.label !== undefined ? clip(patch.label, LIMITS.edgeLabel).trim() : (e.label || '');
    if (Object.values(c.edges).some((x) => x.id !== id && x.rel === rel && (x.label || '') === label && x.from === e.from && x.to === e.to)) return false;
    e.rel = rel; if (label) e.label = label; else delete e.label;
    if (patch.sourceNote !== undefined) { const n = clip(patch.sourceNote, LIMITS.fieldSource); if (n) e.sourceNote = n; else delete e.sourceNote; }
    touch(c, now); return true;
  }

  // ---------- case file: export, import, merge ----------
  // The case file is the case itself (format mayfair-ghost-case/1), custom fields, link labels and sources included.
  function exportJson(c) { return JSON.stringify(c, null, 2); }
  // Reads a case file. -> { case, problems }. `case` is null when the text is not a case Ghost can open; nothing is invented or dropped for what a field says.
  function importJson(text) {
    let o; try { o = JSON.parse(String(text)); } catch { return { case: null, problems: ['That file is not valid JSON.'] }; }
    if (!isObj(o)) return { case: null, problems: ['That file is not a case.'] };
    if (o.format !== FORMAT) return { case: null, problems: ['Unknown case format.'] };
    if (!isObj(o.entities) || !isObj(o.edges) || !isObj(o.sources)) return { case: null, problems: ['The case file is missing its entities, links or sources.'] };
    o.timeline = Array.isArray(o.timeline) ? o.timeline : []; o.notes = Array.isArray(o.notes) ? o.notes : [];
    normalize(o);
    const problems = validate(o);
    return { case: problems.length ? null : o, problems };
  }
  // Merges another case into `c` (the same entity type and key is one entity; a person is keyed by name). Fields, tags, sources, links, notes and timeline entries are kept
  // and never overwrite what `c` already has. -> counts.
  function mergeCase(c, other, now) {
    const inc = JSON.parse(JSON.stringify(other)); normalize(inc);
    const out = { entitiesAdded: 0, entitiesMerged: 0, fieldsAdded: 0, linksAdded: 0, sourcesAdded: 0, notesAdded: 0, eventsAdded: 0, skipped: 0 };
    const srcMap = {}, entMap = {};
    const sameSource = (a, b) => a.connector === b.connector && a.fetchedAt === b.fetchedAt && a.origin === b.origin && a.rawSha256 === b.rawSha256 && JSON.stringify(a.query) === JSON.stringify(b.query);
    for (const s of Object.values(inc.sources)) {
      const have = c.sources[s.id];
      if (have && sameSource(have, s)) { srcMap[s.id] = s.id; continue; }
      if (Object.keys(c.sources).length >= LIMITS.sources) { out.skipped++; continue; }
      const id = have ? uid() : s.id; c.sources[id] = { ...s, id }; srcMap[s.id] = id; out.sourcesAdded++;
    }
    const mapSrcs = (list) => (list || []).map((x) => srcMap[x]).filter(Boolean);
    for (const e of Object.values(inc.entities)) {
      if (!ENTITY_TYPES.includes(e.type)) { out.skipped++; continue; }
      const found = Object.values(c.entities).find((x) => x.type === e.type && x.key === e.key);
      if (found) {
        for (const s of mapSrcs(e.sources)) if (!found.sources.includes(s)) found.sources.push(s);
        if (e.firstSeen < found.firstSeen) found.firstSeen = e.firstSeen; if (e.lastSeen > found.lastSeen) found.lastSeen = e.lastSeen;
        for (const [k, v] of Object.entries(e.attrs || {})) if (found.attrs[k] === undefined) found.attrs[k] = v;
        for (const t of e.tags || []) if (!found.tags.includes(t) && found.tags.length < LIMITS.tags) found.tags.push(t);
        found.fields = found.fields || [];
        for (const f of e.fields || []) if (!found.fields.some((x) => x.id === f.id || sameField(x, f)) && found.fields.length < LIMITS.fields) { found.fields.push({ ...f }); out.fieldsAdded++; }
        found.manual = !!(found.manual || e.manual);
        entMap[e.id] = found.id; out.entitiesMerged++; continue;
      }
      if (Object.keys(c.entities).length >= LIMITS.entities) { out.skipped++; continue; }
      const id = c.entities[e.id] ? uid() : e.id;
      c.entities[id] = { ...e, id, sources: mapSrcs(e.sources), tags: (e.tags || []).slice(0, LIMITS.tags), fields: (e.fields || []).map((f) => ({ ...f })), attrs: { ...(e.attrs || {}) }, pos: null, pinned: false };
      entMap[e.id] = id; out.entitiesAdded++; out.fieldsAdded += c.entities[id].fields.length;
    }
    for (const e of Object.values(inc.edges)) {
      const from = entMap[e.from], to = entMap[e.to]; if (!from || !to || from === to) { out.skipped++; continue; }
      const label = e.label || '';
      const dup = Object.values(c.edges).find((x) => x.rel === e.rel && (x.label || '') === label && ((x.from === from && x.to === to) || (SYMMETRIC.includes(e.rel) && x.from === to && x.to === from)));
      if (dup) { for (const s of mapSrcs(e.sources)) if (!dup.sources.includes(s)) dup.sources.push(s); if (!dup.sourceNote && e.sourceNote) dup.sourceNote = e.sourceNote; continue; }
      if (Object.keys(c.edges).length >= LIMITS.edges) { out.skipped++; continue; }
      const id = c.edges[e.id] ? uid() : e.id;
      c.edges[id] = { ...e, id, from, to, sources: mapSrcs(e.sources) }; out.linksAdded++;
    }
    const haveNote = new Set(c.notes.map((n) => n.id));
    for (const n of inc.notes) if (n.id && !haveNote.has(n.id) && c.notes.length < LIMITS.notes) { c.notes.push({ ...n, refs: (n.refs || []).map((r) => entMap[r]).filter(Boolean) }); out.notesAdded++; }
    const haveEv = new Set(c.timeline.map((t) => t.id));
    for (const t of inc.timeline) if (t.id && !haveEv.has(t.id)) { c.timeline.push({ ...t, entity: t.entity ? entMap[t.entity] || null : null, sources: mapSrcs(t.sources) }); out.eventsAdded++; }
    const hide = new Set(c.settings.hideFromReport || []); for (const x of (inc.settings && inc.settings.hideFromReport) || []) if (entMap[x]) hide.add(entMap[x]); c.settings.hideFromReport = [...hide];
    touch(c, now); return out;
  }

  // ---------- undo and redo ----------
  // run(label, fn) saves the state before fn changes it. Many small changes with the same `group` inside `windowMs` (a drag, typing) count as one step.
  class History {
    constructor(c, limit) { this.c = c; this.limit = limit || UNDO_LIMIT; this.undoStack = []; this.redoStack = []; this.lastGroup = null; this.lastAt = 0; }
    snapshot() { return JSON.stringify(this.c); }
    restore(s) { const o = JSON.parse(s); for (const k of Object.keys(this.c)) delete this.c[k]; Object.assign(this.c, o); }
    run(label, fn, { group = null, windowMs = 800, now = Date.now() } = {}) {
      const coalesce = group && this.lastGroup === group && now - this.lastAt < windowMs && this.undoStack.length;
      if (!coalesce) { this.undoStack.push({ label, s: this.snapshot() }); if (this.undoStack.length > this.limit) this.undoStack.shift(); }
      this.redoStack.length = 0; this.lastGroup = group; this.lastAt = now;
      return fn(this.c);
    }
    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }
    undo() { const st = this.undoStack.pop(); if (!st) return null; this.redoStack.push({ label: st.label, s: this.snapshot() }); this.restore(st.s); this.lastGroup = null; return st.label; }
    redo() { const st = this.redoStack.pop(); if (!st) return null; this.undoStack.push({ label: st.label, s: this.snapshot() }); this.restore(st.s); this.lastGroup = null; return st.label; }
    reset(c) { if (c) this.c = c; this.undoStack.length = 0; this.redoStack.length = 0; this.lastGroup = null; }
  }

  // SHA-256 of the raw output of a run, as lowercase hex (WebCrypto exists in the page and in Node).
  async function hashRaw(results) {
    const text = JSON.stringify((results || []).map((r) => (r && r.raw !== undefined ? r.raw : null)));
    const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (!c || !c.subtle) return '';
    const d = await c.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  return { FORMAT, ENTITY_TYPES, REL, SYMMETRIC, FIELD_KINDS, PERSON_SUGGESTED, EMAIL_ROLES, UNDO_LIMIT, LIMITS, newCase, uid, canonKey, mapType, isAccountKind, addField, updateField, removeField, moveField, fieldsOf, updateEdge, exportJson, importJson, mergeCase, addSource, addEntity, addEdge, ingest, removeEntity, removeEdge, removeSource, isUnsourced, addTag, removeTag, allTags, addNote, editNote, deleteNote, addEvent, deleteEvent, buildTimeline, neighbours, shortestPath, search, stats, placeCoords, layout, validate, normalize, History, hashRaw, touch };
});
