'use strict';
// Ghost layout core: the pure functions behind the skin layouts. No DOM, no calls into the app, no stored or sample values.
// Everything here turns what Ghost really holds on this computer (connector states, the open case, the jobs run in this window, the scan log)
// into the numbers, rows and shapes the layouts draw. An empty input gives an empty result, never a made-up one.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./case-model'), require('./modules'));
  else root.GhostLay = factory(root.GhostCase, root.GhostModules);
})(typeof self !== 'undefined' ? self : this, function (M, MODS) {
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const KEYS = ['passed', 'needs-approval', 'not-tested', 'test-failed', 'program-missing', 'not-installed'];
  const KEY_LABEL = { passed: 'Test passed', 'needs-approval': 'Needs approval', 'not-tested': 'Not tested', 'test-failed': 'Test failed', 'program-missing': 'Program missing', 'not-installed': 'Not installed' };

  // ---------- connectors ----------
  // list: the connector list the app returned (array, or null when it could not be read).
  // -> per module and overall counts of the connectors each module expects, by the one honest state each has (modules.statusOf).
  function connStats(list) {
    const ok = Array.isArray(list), L = ok ? list : [];
    const by = new Map(L.map((c) => [c.id, c]));
    const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]));
    const rows = [], all = new Map();
    for (const m of MODS.MODULES) {
      const row = { id: m.id, name: m.name, total: 0, ready: 0, keys: zero(), cells: [] }, seen = new Set();
      const add = (id, entry) => {
        if (seen.has(id)) return; seen.add(id);
        const st = MODS.statusOf(entry, id); row.total++; row.keys[st.key]++; if (st.key === 'passed') row.ready++;
        row.cells.push({ id, key: st.key, name: entry ? entry.name : id }); all.set(id, st.key);
      };
      for (const w of m.wants) add(w[0], by.get(w[0]) || null);
      for (const c of L) if (!seen.has(c.id) && (c.capabilities || []).includes('ghost-' + m.id)) add(c.id, c);
      rows.push(row);
    }
    const keys = zero(); for (const k of all.values()) keys[k]++;
    return { readable: ok, expected: all.size, ready: keys.passed, keys, installed: L.length, enabled: L.filter((c) => c.state === 'enabled').length, approved: L.filter((c) => c.state !== 'not-approved').length, rows, byModule: Object.fromEntries(rows.map((r) => [r.id, r])) };
  }
  // one character per connector for the character grids: # test passed, : on this computer but not ready, . not installed
  const cellChar = (key) => (key === 'passed' ? '#' : key === 'not-installed' ? '.' : ':');
  const charBar = (n, total, width, on = '#', off = ':') => { const w = Math.max(0, width | 0); if (!total || total <= 0) return off.repeat(w); const k = clamp(Math.round((n / total) * w), 0, w); return on.repeat(k) + off.repeat(w - k); };

  // ---------- the case ----------
  function caseHealth(c) {
    if (!c || !c.entities) return null;
    const ents = Object.values(c.entities), st = M.stats(c);
    const unsourced = ents.filter(M.isUnsourced).length, byType = {};
    for (const e of ents) byType[e.type] = (byType[e.type] || 0) + 1;
    return { entities: st.entities, edges: st.edges, sources: st.sources, notes: st.notes, places: st.places, unsourced, byType,
      handAdded: ents.filter((e) => e.manual && !(e.sources && e.sources.length)).length, pct: ents.length ? Math.round(((ents.length - unsourced) / ents.length) * 100) : null };
  }
  const placePins = (c) => (c && c.entities ? Object.values(c.entities).filter((e) => e.type === 'place').map((e) => ({ e, p: M.placeCoords(e) })).filter((x) => x.p).map((x) => ({ id: x.e.id, label: x.e.label, lat: x.p.lat, lon: x.p.lon })) : []);
  // Lines between related places: a link straight between two places, or two places that both link to one other entity (shown as "via").
  function placeLinks(c, cap = 300) {
    if (!c || !c.entities) return [];
    const isPlace = (id) => c.entities[id] && c.entities[id].type === 'place' && M.placeCoords(c.entities[id]);
    const out = [], seen = new Set(), adj = {};
    const key = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
    for (const e of Object.values(c.edges || {})) {
      (adj[e.from] = adj[e.from] || []).push([e.to, e.rel]); (adj[e.to] = adj[e.to] || []).push([e.from, e.rel]);
      if (isPlace(e.from) && isPlace(e.to) && e.from !== e.to && !seen.has(key(e.from, e.to))) { seen.add(key(e.from, e.to)); out.push({ a: e.from, b: e.to, rel: e.rel, via: null }); }
    }
    for (const [mid, list] of Object.entries(adj)) {
      if (!c.entities[mid] || isPlace(mid)) continue;
      const ps = [...new Set(list.map((x) => x[0]).filter(isPlace))].sort();
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) { const k = key(ps[i], ps[j]); if (seen.has(k)) continue; seen.add(k); out.push({ a: ps[i], b: ps[j], rel: 'via', via: mid }); }
    }
    return out.slice(0, cap);
  }
  // Entities (other than places) that a place is linked to: drawn beside the place, not by location (they have no coordinates).
  function placeSatellites(c, perPlace = 8) {
    if (!c || !c.entities) return [];
    const isPlace = (id) => c.entities[id] && c.entities[id].type === 'place' && M.placeCoords(c.entities[id]);
    const used = new Set(), by = {}, out = [];
    for (const e of Object.values(c.edges || {})) {
      for (const [p, o] of [[e.from, e.to], [e.to, e.from]]) { if (!isPlace(p) || !c.entities[o] || c.entities[o].type === 'place' || used.has(o)) continue; (by[p] = by[p] || []).push(o); used.add(o); }
    }
    for (const [p, ids] of Object.entries(by)) ids.slice(0, perPlace).forEach((id, i, a) => out.push({ id, place: p, i, n: a.length, label: c.entities[id].label, type: c.entities[id].type }));
    return out;
  }

  // ---------- map geometry (plain latitude and longitude, no basemap) ----------
  const WORLD = { lon0: -180, lon1: 180, lat0: -90, lat1: 90 };
  function viewFor(pins, opts = {}) {
    if (opts.world || !pins || !pins.length) return { ...WORLD };
    let lon0 = 1e9, lon1 = -1e9, lat0 = 1e9, lat1 = -1e9;
    for (const p of pins) { lon0 = Math.min(lon0, p.lon); lon1 = Math.max(lon1, p.lon); lat0 = Math.min(lat0, p.lat); lat1 = Math.max(lat1, p.lat); }
    const minLon = opts.minLon || 16, minLat = opts.minLat || 9;
    let sl = Math.max(lon1 - lon0, minLon), st = Math.max(lat1 - lat0, minLat); const cl = (lon0 + lon1) / 2, ct = (lat0 + lat1) / 2;
    sl *= 1.35; st *= 1.5;
    return { lon0: cl - sl / 2, lon1: cl + sl / 2, lat0: ct - st / 2, lat1: ct + st / 2 };
  }
  // Same scale on both axes for a w x h box, kept inside the world.
  function fitAspect(v, w, h) {
    const aspect = w / h; let sl = v.lon1 - v.lon0, st = v.lat1 - v.lat0; const cl = (v.lon0 + v.lon1) / 2, ct = (v.lat0 + v.lat1) / 2;
    if (sl / st < aspect) sl = st * aspect; else st = sl / aspect;
    if (st > 180) { st = 180; sl = st * aspect; } if (sl > 360) { sl = 360; st = sl / aspect; }
    let lon0 = cl - sl / 2, lat0 = ct - st / 2;
    lon0 = clamp(lon0, -180, 180 - sl); lat0 = clamp(lat0, -90, 90 - st);
    return { lon0, lon1: lon0 + sl, lat0, lat1: lat0 + st };
  }
  const project = (v, w, h, lat, lon) => ({ x: ((lon - v.lon0) / (v.lon1 - v.lon0)) * w, y: ((v.lat1 - lat) / (v.lat1 - v.lat0)) * h });
  function graticule(v) {
    const span = v.lon1 - v.lon0, steps = [1, 2, 5, 10, 15, 30, 45], step = steps.find((s) => span / s <= 12) || 45;
    const lons = [], lats = [];
    for (let x = Math.ceil(v.lon0 / step) * step; x <= v.lon1 + 1e-9; x += step) lons.push(Math.round(x * 1e6) / 1e6);
    for (let y = Math.ceil(v.lat0 / step) * step; y <= v.lat1 + 1e-9; y += step) lats.push(Math.round(y * 1e6) / 1e6);
    return { step, lons, lats };
  }
  const fmtLat = (x) => Math.abs(Math.round(x * 10) / 10) + (x < 0 ? '°S' : x > 0 ? '°N' : '°');
  const fmtLon = (x) => Math.abs(Math.round(x * 10) / 10) + (x < 0 ? '°W' : x > 0 ? '°E' : '°');
  // Radar: bearing and distance of each pin from the centre of the pins, scaled so the farthest sits at 85% of the radius.
  function radarPoints(pins) {
    if (!pins || !pins.length) return [];
    const cl = pins.reduce((a, p) => a + p.lon, 0) / pins.length, ct = pins.reduce((a, p) => a + p.lat, 0) / pins.length;
    const d = pins.map((p) => ({ id: p.id, label: p.label, dx: (p.lon - cl) * Math.cos((ct * Math.PI) / 180), dy: p.lat - ct }));
    const far = Math.max(...d.map((q) => Math.hypot(q.dx, q.dy)), 1e-9);
    return d.map((q) => ({ id: q.id, label: q.label, x: far < 1e-6 ? 0 : (q.dx / far) * 0.85, y: far < 1e-6 ? 0 : (-q.dy / far) * 0.85 }));
  }

  // ---------- time ----------
  const toMs = (t) => { if (typeof t === 'number') return Number.isFinite(t) ? t : null; const n = Date.parse(t); return Number.isFinite(n) ? n : null; };
  const DAY = 86400000;
  // Counts per day for the last `days` days ending today (UTC days), oldest first.
  function dayBuckets(times, days, now) {
    const end = Math.floor(now / DAY), counts = new Array(days).fill(0), labels = [];
    for (let i = 0; i < days; i++) labels.push(new Date((end - days + 1 + i) * DAY).toISOString().slice(0, 10));
    for (const t of times) { const m = toMs(t); if (m === null) continue; const i = days - 1 - (end - Math.floor(m / DAY)); if (i >= 0 && i < days) counts[i]++; }
    return { counts, labels, total: counts.reduce((a, b) => a + b, 0) };
  }
  const ago = (t, now) => { const m = toMs(t); if (m === null) return ''; const s = Math.max(0, Math.round((now - m) / 1000)); if (s < 60) return s + 's'; if (s < 3600) return Math.round(s / 60) + 'm'; if (s < 86400) return Math.round(s / 3600) + 'h'; return Math.round(s / 86400) + 'd'; };

  // ---------- jobs, lookups and the activity log ----------
  const JOB_STATE = { queued: 'WAITING', running: 'RUNNING', done: 'DONE', failed: 'FAILED', cancelled: 'CANCELLED', 'timed-out': 'TIMED OUT' };
  // Lookups: the jobs run in this window, then lookups recorded in the open case that are not the same run (same tool and query within two minutes).
  function lookups(jobs, c, limit = 50) {
    const rows = (jobs || []).map((j) => ({ t: toMs(j.startedAt), tool: j.connector, query: j.query || '', state: j.status, results: j.results === undefined ? null : j.results, where: 'this window', id: j.id }));
    if (c && c.sources) for (const s of Object.values(c.sources)) {
      const t = toMs(s.fetchedAt); if (t === null) continue;
      const q = s.query && s.query.value ? s.query.value : '';
      if (rows.some((r) => r.tool === s.connector && r.query === q && Math.abs((r.t || 0) - t) < 120000)) continue;
      const n = Object.values(c.entities || {}).filter((e) => (e.sources || []).includes(s.id)).length;
      rows.push({ t, tool: s.connector, query: q, state: 'done', results: n, where: 'case', id: s.id });
    }
    return rows.sort((a, b) => (b.t || 0) - (a.t || 0)).slice(0, limit);
  }
  // Activity: one list from the jobs of this window, connector self-tests, the scan log and the last case save, newest first.
  function activity({ jobs, conns, scopeLog, save }, limit = 60) {
    const out = [];
    for (const j of jobs || []) {
      const t = toMs(j.startedAt); if (t !== null) out.push({ t, tone: 'info', text: j.connector + ' started' + (j.query ? ': ' + j.query : '') });
      const e = toMs(j.finishedAt);
      if (e !== null) out.push({ t: e, tone: j.status === 'done' ? 'ok' : 'bad', text: j.connector + ' ' + (JOB_STATE[j.status] || j.status).toLowerCase() + (j.results !== undefined && j.results !== null ? ', ' + j.results + (j.results === 1 ? ' result' : ' results') : '') });
    }
    for (const c of conns || []) { const lt = c.install && c.install.lastTest; if (lt && toMs(lt.t) !== null) out.push({ t: toMs(lt.t), tone: lt.ok ? 'ok' : 'bad', text: c.id + ' self-test ' + (lt.ok ? 'passed' : 'failed') }); }
    for (const x of scopeLog || []) { const t = toMs(x.t); if (t !== null) out.push({ t, tone: 'info', text: 'scan log: ' + (x.action || 'entry') + (x.target ? ' ' + x.target : x.connector ? ' ' + x.connector : '') }); }
    if (save && save.state === 'saved' && toMs(save.at) !== null) out.push({ t: toMs(save.at), tone: 'ok', text: 'case saved and sealed in the vault' });
    return out.sort((a, b) => b.t - a.t).slice(0, limit);
  }

  // The vault's state in words, from what the app reports (status.vault).
  function vaultWord(v) {
    if (!v) return { word: 'NOT IN USE', locked: null, detail: 'This build keeps cases without a vault.' };
    if (v.state === 'unlocked') return { word: 'UNLOCKED', locked: false, detail: 'Open for this account on this computer.' };
    if (v.state === 'locked') return { word: 'LOCKED', locked: true, detail: 'Sealed until you unlock it.' };
    if (v.state === 'uninitialised') return { word: 'NOT SET UP', locked: null, detail: 'No vault has been created yet.' };
    return { word: String(v.state || 'UNKNOWN').toUpperCase(), locked: null, detail: '' };
  }

  // ---------- the tree of cases and entities ----------
  function buildTree(cases, current, typeLabel) {
    const label = typeLabel || {};
    const nodes = [{ id: 'cases', label: 'Cases', count: Array.isArray(cases) ? cases.length : 0, kids: (Array.isArray(cases) ? cases : []).map((c) => ({ id: 'case:' + c.id, kind: 'case', caseId: c.id, label: c.title, meta: String(c.entities), current: !!(current && current.id === c.id) })) }];
    if (current && current.entities) {
      const groups = {};
      for (const e of Object.values(current.entities)) (groups[e.type] = groups[e.type] || []).push(e);
      const kids = Object.keys(groups).sort((a, b) => (label[a] || a).localeCompare(label[b] || b)).map((t) => {
        const list = groups[t].sort((a, b) => a.label.localeCompare(b.label));
        return { id: 'type:' + t, label: label[t] || t, count: list.length, kids: list.slice(0, 200).map((e) => ({ id: 'ent:' + e.id, kind: 'entity', entityId: e.id, label: e.label, type: t })), more: Math.max(0, list.length - 200) };
      });
      nodes.push({ id: 'ents', label: current.title, count: Object.keys(current.entities).length, kids });
    }
    return nodes;
  }
  // The entities a table shows: the ones with the most links first, then by name.
  function topEntities(c, limit = 30) {
    if (!c || !c.entities) return [];
    const deg = {}; for (const e of Object.values(c.edges || {})) { deg[e.from] = (deg[e.from] || 0) + 1; deg[e.to] = (deg[e.to] || 0) + 1; }
    return Object.values(c.entities).map((e) => ({ id: e.id, type: e.type, label: e.label, sources: (e.sources || []).length, links: deg[e.id] || 0, manual: !!e.manual })).sort((a, b) => b.links - a.links || a.label.localeCompare(b.label)).slice(0, limit);
  }

  return { KEYS, KEY_LABEL, JOB_STATE, clamp, connStats, cellChar, charBar, caseHealth, placePins, placeLinks, placeSatellites, WORLD, viewFor, fitAspect, project, graticule, fmtLat, fmtLon, radarPoints, toMs, dayBuckets, ago, lookups, activity, buildTree, topEntities, vaultWord };
});
