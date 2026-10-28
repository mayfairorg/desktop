'use strict';
// Ghost merge: the Overview of a master search. Several tools answer the same search; the same domain, address or organisation often comes back from more than one of them.
// This pure module keeps one row per thing: the key is the entity type plus the value written the way the case file writes it (the same canonical form the case
// uses to join duplicates), and each row remembers which tools found it, where each saw it and when. Plain functions on plain objects: no DOM, no Node-only calls.
// Nothing is invented here: every field comes from a result a tool printed, and a result that is aimed at one private person is counted and left out, never shown.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./case-model')); else root.GhostMerge = factory(root.GhostCase); })(typeof self !== 'undefined' ? self : this, function (M) {
  // The order the Overview groups types in: the infrastructure first, then who owns it, then what it is about.
  const TYPE_ORDER = ['domain', 'ip', 'asn', 'cert', 'url', 'org', 'person', 'place', 'document', 'image', 'event', 'service', 'email', 'finding'];
  const RANK = { confirmed: 3, likely: 2, uncertain: 1 };
  const clip = (s, n) => String(s === undefined || s === null ? '' : s).slice(0, n);
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const validTime = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

  // The type a result's entity lands on, and the key that joins duplicates: 'domain:example.org'. Same canon as the case file, so what merges here merges there.
  function typeOf(rawType) { return M.mapType(rawType); }
  function entityKey(rawType, value, kind) {
    const m = typeOf(rawType);
    return m.type + ':' + M.canonKey(m.type, value, kind || m.kind);
  }
  // The text shown for a thing: the written-out canonical form where there is one (a domain in lower case, an AS number), otherwise the first spelling a tool used.
  const SHOW_CANON = new Set(['domain', 'ip', 'asn', 'cert']);
  function displayValue(type, value, kind) { return SHOW_CANON.has(type) ? M.canonKey(type, value, kind) : clip(value, 2000); }

  function create() { return { map: new Map(), results: 0, withheld: 0, withheldReasons: {}, byTool: {} }; }
  const tool = (st, id) => (st.byTool[id] = st.byTool[id] || { results: 0, keys: new Set(), withheld: 0 });

  function withhold(st, id, why) { st.withheld++; st.withheldReasons[why] = (st.withheldReasons[why] || 0) + 1; tool(st, id).withheld++; }

  // Adds what one tool returned: [{entity:{type,value}, source:{tool,connector,version,url?}, observedAt, confidence, uncertaintyNote?, raw?}].
  // -> { added, merged, withheld }: a new row, a result that joined a row that was already there, a result that was left out.
  function add(st, toolId, results, opts) {
    const out = { added: 0, merged: 0, withheld: 0 }, T = tool(st, toolId);
    for (const r of Array.isArray(results) ? results : []) {
      const e = isObj(r) && r.entity; if (!isObj(e) || typeof e.type !== 'string' || typeof e.value !== 'string' || !e.value.trim()) { withhold(st, toolId, 'invalid'); out.withheld++; continue; }
      if (M.isAccountKind(e.type)) { withhold(st, toolId, 'account'); out.withheld++; continue; }
      const m = typeOf(e.type);
      if (m.type === 'finding' && M.isAccountKind(m.kind)) { withhold(st, toolId, 'account'); out.withheld++; continue; }
      if (m.type === 'email' && !(r.raw && M.EMAIL_ROLES.includes(r.raw.role))) { withhold(st, toolId, 'email'); out.withheld++; continue; }
      const key = m.type + ':' + M.canonKey(m.type, e.value, m.kind);
      let row = st.map.get(key);
      if (!row) {
        row = { key, type: m.type, kind: m.kind || null, value: displayValue(m.type, e.value, m.kind), tools: [], sources: [], first: null, last: null, confidence: 'uncertain', notes: [], hits: [] };
        st.map.set(key, row); out.added++;
      } else out.merged++;
      if (!row.tools.includes(toolId)) row.tools.push(toolId);
      const src = isObj(r.source) ? r.source : {}, at = validTime(r.observedAt);
      const s = { tool: toolId, version: clip(src.version, 64), url: clip(src.url, 500), observedAt: at === null ? null : new Date(at).toISOString(), confidence: RANK[r.confidence] ? r.confidence : 'uncertain', note: clip(r.uncertaintyNote, 500) };
      if (!row.sources.some((x) => x.tool === s.tool && x.url === s.url && x.observedAt === s.observedAt)) row.sources.push(s);
      if (at !== null) { if (row.first === null || at < Date.parse(row.first)) row.first = s.observedAt; if (row.last === null || at > Date.parse(row.last)) row.last = s.observedAt; }
      if ((RANK[s.confidence] || 0) > (RANK[row.confidence] || 0) || !row.hits.length) row.confidence = s.confidence;
      if (s.note && !row.notes.includes(s.note)) row.notes.push(s.note);
      row.hits.push({ tool: toolId, result: r });
      T.results++; T.keys.add(key); st.results++;
    }
    return out;
  }

  const byValue = (a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0);
  // Every row, most corroborated first (found by the most tools), then by value.
  function entities(st, opts) {
    const o = opts || {}, all = [...st.map.values()].filter((e) => (!o.tool || e.tools.includes(o.tool)) && (!o.type || e.type === o.type));
    return all.sort((a, b) => b.tools.length - a.tools.length || byValue(a, b));
  }
  // Rows grouped by type in TYPE_ORDER: [{ type, items }]. A type nobody found is not listed.
  function groups(st, opts) {
    const all = entities(st, opts), by = new Map();
    for (const e of all) { if (!by.has(e.type)) by.set(e.type, []); by.get(e.type).push(e); }
    const order = [...TYPE_ORDER, ...[...by.keys()].filter((t) => !TYPE_ORDER.includes(t)).sort()];
    return order.filter((t) => by.has(t)).map((t) => ({ type: t, items: by.get(t) }));
  }
  // What one tool tab shows: the results that tool returned, each as the tool printed it plus type, value and key for a table.
  function resultsOf(st, toolId) {
    const out = [];
    for (const e of st.map.values()) for (const h of e.hits) if (h.tool === toolId) out.push({ ...h.result, type: e.type, value: e.value, label: e.value, key: e.key });
    return out;
  }
  const countFor = (st, toolId) => (st.byTool[toolId] ? st.byTool[toolId].keys.size : 0);
  const withheldFor = (st, toolId) => (st.byTool[toolId] ? st.byTool[toolId].withheld : 0);
  function summary(st) { return { entities: st.map.size, results: st.results, withheld: st.withheld, reasons: { ...st.withheldReasons }, corroborated: [...st.map.values()].filter((e) => e.tools.length > 1).length }; }

  // The selected rows turned back into what the case store takes: one list per tool, each result exactly as the tool printed it, so every case entity keeps its own source.
  // -> [{ tool, results }]
  function toIngest(st, keys) {
    const want = keys instanceof Set ? keys : new Set(keys || []), by = new Map();
    for (const k of want) { const row = st.map.get(k); if (!row) continue; for (const h of row.hits) { if (!by.has(h.tool)) by.set(h.tool, []); by.get(h.tool).push(h.result); } }
    return [...by.entries()].map(([t, results]) => ({ tool: t, results }));
  }
  // The newest and oldest source time among a list of rows, for the line under the summary.
  function span(rows) {
    let a = null, b = null;
    for (const e of rows) { if (e.first !== null && (a === null || Date.parse(e.first) < Date.parse(a))) a = e.first; if (e.last !== null && (b === null || Date.parse(e.last) > Date.parse(b))) b = e.last; }
    return { first: a, last: b };
  }

  return { TYPE_ORDER, entityKey, displayValue, create, add, entities, groups, resultsOf, countFor, withheldFor, summary, toIngest, span };
});
