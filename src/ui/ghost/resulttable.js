'use strict';
// Ghost result table: one table per kind of thing a lookup found, with the columns that suit that kind, a filter box, sortable headers, row selection,
// copy, a key/value detail row and keyboard use. Used by every tool page and by the merged Overview.
//   GH.resultTable(entities, { compact, type, names, onSelect, selectable, caption, emptyText }) -> HTMLElement
//   entities: connector results {entity:{type,value}, source:{tool,connector,version,url?}, observedAt, confidence, uncertaintyNote?, raw?}
//             or merged entities {type, value, tools|sources|source, observedAt|time, confidence?, raw?}
//   The element has .rt: { selected(), selectAll(), clear(), setEntities(list), setFilter(text), count(), shown() } and fires onSelect(selectedEntities) on every change.
// The first half of this file is plain logic (no page needed) so it can be tested in Node; the second half draws it. The page draws with textContent only.
(function () {
  const logic = (() => {
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const clip = (s, n) => { s = String(s === undefined || s === null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const scalar = (v) => {
      if (v === undefined || v === null) return '';
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (Array.isArray(v)) return v.map(scalar).filter(Boolean).join(', ');
      return '';
    };
    const pick = (raw, keys) => { for (const k of keys) { const s = scalar(raw && raw[k]); if (s !== '') return s; } return ''; };

    // What a connector calls a thing -> the kind this table knows. Anything else is "unknown" and is shown as key and value.
    const ALIAS = {
      domain: 'domain', hostname: 'domain', host: 'domain', fqdn: 'domain', subdomain: 'domain', 'dns-name': 'domain',
      ip: 'ip', ipv4: 'ip', ipv6: 'ip', 'ip-address': 'ip', ipaddress: 'ip',
      asn: 'asn', 'autonomous-system': 'asn',
      cert: 'certificate', certificate: 'certificate', 'tls-cert': 'certificate', 'tls-certificate': 'certificate', x509: 'certificate',
      org: 'organisation', organisation: 'organisation', organization: 'organisation', company: 'organisation', 'registered-entity': 'organisation',
      place: 'place', location: 'place', site: 'place', landmark: 'place',
      url: 'url', uri: 'url', link: 'url', 'web-page': 'url', page: 'url',
      document: 'file', doc: 'file', file: 'file', pdf: 'file', image: 'file', photo: 'file', picture: 'file',
      hash: 'hash', sha256: 'hash', sha1: 'hash', md5: 'hash',
      event: 'event', article: 'article', 'news-item': 'article',
      record: 'record', finding: 'record', service: 'record', port: 'record', 'open-port': 'record', 'listening-service': 'record',
    };
    const NAMES = {
      domain: ['Domain', 'Domains'], ip: ['IP address', 'IP addresses'], asn: ['Network (ASN)', 'Networks (ASN)'], certificate: ['Certificate', 'Certificates'], organisation: ['Organisation', 'Organisations'],
      place: ['Place', 'Places'], url: ['Web address', 'Web addresses'], file: ['File', 'Files'], hash: ['Hash', 'Hashes'], event: ['Event', 'Events'], article: ['News article', 'News articles'], record: ['Record', 'Records'],
    };
    const TYPES = Object.keys(NAMES);
    const CONF = { confirmed: 'Confirmed', likely: 'Likely', uncertain: 'Uncertain' };
    const REL = { nameserver: 'Name server', 'mail-exchanger': 'Mail server', 'alias-target': 'Alias of', 'certificate-name': 'Name in a certificate', 'address-of': 'Address of', 'subdomain-of': 'Subdomain of', 'resolves-to': 'Resolves to', 'official-website': 'Official website' };
    const relOf = (n) => { const r = scalar(n.raw.rel); return REL[r] || r.replace(/[-_]+/g, ' '); };

    const when = (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return scalar(iso); return new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; };
    const fmtSize = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) return scalar(v); if (n < 1024) return n + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let x = n / 1024, i = 0; while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; } return (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10) + ' ' + u[i]; };
    const hostOf = (v) => { try { return new URL(v).host; } catch { return ''; } };
    const hashKind = (v) => ({ 32: 'MD5', 40: 'SHA-1', 64: 'SHA-256', 128: 'SHA-512' })[String(v).replace(/^[a-z0-9-]+:/i, '').length] || '';
    const summary = (raw, max) => Object.entries(raw || {}).filter(([, v]) => scalar(v) !== '').slice(0, max || 4).map(([k, v]) => k + ': ' + clip(scalar(v), 60)).join(' · ');
    const coord = (n, key) => { const s = pick(n.raw, [key, key === 'lon' ? 'lng' : key]); if (s) return s; const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(n.value); return m ? m[key === 'lat' ? 1 : 2] : ''; };

    // ----- turn whatever came in into one flat row shape -----
    function names(x) {
      const out = [];
      const add = (s) => { s = scalar(s); if (s && !out.includes(s)) out.push(s); };
      if (Array.isArray(x.tools)) x.tools.forEach((t) => add(isObj(t) ? t.name || t.id || t.connector || t.tool : t));
      if (Array.isArray(x.sources)) x.sources.forEach((t) => add(isObj(t) ? t.name || t.connector || t.tool || t.id : t));
      if (isObj(x.source)) add(x.source.connector || x.source.tool || x.source.name); else if (typeof x.source === 'string') add(x.source);
      return out;
    }
    function norm(x, i, nameMap) {
      x = isObj(x) ? x : {};
      const e = isObj(x.entity) ? x.entity : x;
      const rawType = scalar(e.type !== undefined ? e.type : x.type).toLowerCase().trim();
      const value = scalar(e.value !== undefined ? e.value : x.value);
      const raw = isObj(x.raw) ? x.raw : isObj(e.raw) ? e.raw : {};
      let type = ALIAS[rawType] || 'unknown';
      if (type === 'url' && raw.title && (raw.domain || raw.seen)) type = 'article';
      const src = isObj(x.source) ? x.source : {};
      const nm = names(x).map((s) => (nameMap && nameMap[s]) || s);
      return {
        i, orig: x, rawType, type, value, raw, tools: nm, source: nm.join(', '), sourceUrl: scalar(src.url), version: scalar(src.version),
        time: scalar(x.observedAt || x.time || x.seen || x.lastSeen || ''), confidence: scalar(x.confidence), note: scalar(x.uncertaintyNote),
      };
    }
    const normAll = (list, nameMap) => (Array.isArray(list) ? list : []).map((x, i) => norm(x, i, nameMap));
    const typeLabel = (type, rawType, plural) => (NAMES[type] ? NAMES[type][plural ? 1 : 0] : (rawType ? rawType.charAt(0).toUpperCase() + rawType.slice(1) : 'Other') + (plural ? ' (other)' : ''));
    const groupKey = (n) => (n.type === 'unknown' ? 'unknown:' + n.rawType : n.type);

    // ----- columns per kind. get() gives the text that is shown, sorted and filtered on. -----
    const C = (key, label, get, o) => ({ key, label, get, ...(o || {}) });
    const BY_TYPE = {
      domain: (c) => [C('v', 'Domain', (n) => n.value, { mono: 1, wrap: 1 }), C('role', 'Role', relOf), C('of', 'For', (n) => pick(n.raw, ['of', 'name']), { mono: 1 }), C('certs', 'Certificates', (n) => pick(n.raw, ['certificates']), { num: 1 })],
      ip: () => [C('v', 'Address', (n) => n.value, { mono: 1 }), C('role', 'Role', relOf), C('of', 'For', (n) => pick(n.raw, ['of', 'name']), { mono: 1 }), C('net', 'Network', (n) => pick(n.raw, ['asn', 'network', 'cidr', 'prefix', 'handle']), { mono: 1 }), C('cc', 'Country', (n) => pick(n.raw, ['country', 'countryCode']))],
      asn: () => [C('v', 'Network number', (n) => n.value, { mono: 1 }), C('name', 'Name', (n) => pick(n.raw, ['name', 'org', 'description']), { wrap: 1 }), C('cc', 'Country', (n) => pick(n.raw, ['country', 'countryCode'])), C('pfx', 'Range', (n) => pick(n.raw, ['prefix', 'cidr', 'prefixes']), { mono: 1 })],
      certificate: () => [C('v', 'Certificate', (n) => n.value, { mono: 1 }), C('iss', 'Issuer', (n) => pick(n.raw, ['issuer', 'issuerName']), { wrap: 1 }), C('from', 'Valid from', (n) => pick(n.raw, ['notBefore']), { date: 1 }), C('to', 'Valid to', (n) => pick(n.raw, ['notAfter']), { date: 1 }), C('names', 'Names', (n) => (Array.isArray(n.raw.namesInScope) ? String(n.raw.namesInScope.length) : pick(n.raw, ['names'])), { num: 1 })],
      organisation: () => [C('v', 'Name', (n) => n.value, { wrap: 1 }), C('id', 'Identifier', (n) => pick(n.raw, ['lei', 'qid', 'cik', 'id']), { mono: 1 }), C('cc', 'Country', (n) => pick(n.raw, ['country', 'jurisdiction', 'legalJurisdiction'])), C('st', 'Status', (n) => pick(n.raw, ['status', 'entityStatus', 'registrationStatus'])), C('about', 'About', (n) => pick(n.raw, ['description', 'matchNote', 'category']), { wrap: 1 })],
      place: () => [C('v', 'Place', (n) => n.value, { wrap: 1 }), C('lat', 'Latitude', (n) => coord(n, 'lat'), { num: 1 }), C('lon', 'Longitude', (n) => coord(n, 'lon'), { num: 1 }), C('about', 'About', (n) => pick(n.raw, ['description', 'kind', 'class', 'type']), { wrap: 1 })],
      url: () => [C('v', 'Web address', (n) => n.value, { mono: 1, wrap: 1 }), C('title', 'Title', (n) => pick(n.raw, ['title']), { wrap: 1 }), C('site', 'Site', (n) => pick(n.raw, ['domain']) || hostOf(n.value)), C('role', 'Role', relOf)],
      file: () => [C('v', 'Name', (n) => n.value, { mono: 1, wrap: 1 }), C('kind', 'Kind', (n) => (n.rawType === 'image' ? 'Image' : n.rawType === 'document' || n.rawType === 'file' ? 'Document' : n.rawType)), C('sha', 'SHA-256', (n) => pick(n.raw, ['sha256']), { mono: 1 }), C('size', 'Size', (n) => { const s = pick(n.raw, ['size', 'bytes']); return s ? fmtSize(s) : ''; }, { num: 0 }), C('fmt', 'Format', (n) => pick(n.raw, ['mime', 'format', 'mimeType']))],
      hash: () => [C('v', 'Hash', (n) => n.value, { mono: 1, wrap: 1 }), C('kind', 'Kind', (n) => pick(n.raw, ['algorithm', 'alg']) || hashKind(n.value)), C('of', 'For', (n) => pick(n.raw, ['of', 'file', 'name']), { mono: 1 })],
      event: () => [C('v', 'What happened', (n) => n.value, { wrap: 1 }), C('when', 'When', (n) => pick(n.raw, ['t', 'date', 'seen']), { date: 1 }), C('kind', 'Kind', (n) => pick(n.raw, ['kind']).replace(/[-_]+/g, ' '))],
      article: () => [C('title', 'Title', (n) => pick(n.raw, ['title']) || n.value, { wrap: 1 }), C('site', 'Site', (n) => pick(n.raw, ['domain']) || hostOf(n.value)), C('pub', 'Published', (n) => pick(n.raw, ['seen', 't', 'date']), { date: 1 }), C('lang', 'Language', (n) => pick(n.raw, ['language'])), C('cc', 'Country', (n) => pick(n.raw, ['sourceCountry', 'country'])), C('v', 'Web address', (n) => n.value, { mono: 1, wrap: 1 })],
      record: () => [C('v', 'Record', (n) => n.value, { mono: 1, wrap: 1 }), C('kind', 'Kind', (n) => pick(n.raw, ['kind']) || n.rawType), C('about', 'Detail', (n) => summary(n.raw, 3), { wrap: 1 })],
      unknown: () => [C('t', 'Type', (n) => n.rawType || 'unknown'), C('v', 'Value', (n) => n.value, { mono: 1, wrap: 1 }), C('about', 'Details', (n) => summary(n.raw, 4), { wrap: 1 })],
    };
    const TAIL = [
      C('conf', 'Confidence', (n) => CONF[n.confidence] || n.confidence),
      C('src', 'Source', (n) => n.source, { wrap: 1 }),
      C('time', 'Seen', (n) => n.time, { date: 1, tail: 1 }),
    ];
    function columnsFor(type, o) {
      const compact = !!(o && o.compact);
      const mk = BY_TYPE[type] || BY_TYPE.unknown;
      let cols = mk(compact);
      if (compact) cols = cols.slice(0, 3);
      return cols.concat(compact ? TAIL.filter((c) => c.key !== 'conf') : TAIL);
    }

    // ----- sort and filter -----
    function compare(a, b) {
      const x = String(a === undefined || a === null ? '' : a), y = String(b === undefined || b === null ? '' : b);
      const nx = Number(x), ny = Number(y);
      if (x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny;
      return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
    }
    // dir: 'asc' | 'desc'. Rows with nothing in that column always go last. Stable.
    function sortRows(rows, col, dir) {
      if (!col) return rows.slice();
      const sign = dir === 'desc' ? -1 : 1;
      const keyed = rows.map((r, k) => ({ r, k, v: col.get(r) }));
      keyed.sort((p, q) => { const pe = p.v === '' , qe = q.v === ''; if (pe !== qe) return pe ? 1 : -1; const c = compare(p.v, q.v) * sign; return c || p.k - q.k; });
      return keyed.map((p) => p.r);
    }
    const haystack = (n, cols) => (cols.map((c) => c.get(n)).join('\n') + '\n' + n.value + '\n' + n.source + '\n' + n.rawType).toLowerCase();
    function filterRows(rows, cols, q) {
      const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return rows.slice();
      return rows.filter((n) => { const h = haystack(n, cols); return words.every((w) => h.includes(w)); });
    }
    // [{key, type, rawType, label, rows}] biggest first, then by name
    function groups(rows) {
      const m = new Map();
      for (const n of rows) { const k = groupKey(n); if (!m.has(k)) m.set(k, { key: k, type: n.type, rawType: n.rawType, label: typeLabel(n.type, n.rawType, true), rows: [] }); m.get(k).rows.push(n); }
      return [...m.values()].sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
    }
    // key and value pairs for the detail row
    function details(n) {
      const kv = [['Value', n.value], ['Kind', n.type === 'unknown' ? n.rawType : typeLabel(n.type, n.rawType, false) + (n.rawType && ALIAS[n.rawType] !== n.rawType && n.rawType !== n.type ? ' (' + n.rawType + ')' : '')]];
      if (n.confidence) kv.push(['Confidence', (CONF[n.confidence] || n.confidence) + (n.note ? ': ' + n.note : '')]);
      if (n.source) kv.push(['Source', n.source + (n.version ? ' ' + n.version : '')]);
      if (n.sourceUrl) kv.push(['Source address', n.sourceUrl]);
      if (n.time) kv.push(['Seen', when(n.time)]);
      for (const [k, v] of Object.entries(n.raw || {})) { if (v === undefined || v === null) continue; const s = scalar(v) !== '' ? scalar(v) : (() => { try { return JSON.stringify(v); } catch { return ''; } })(); if (s !== '') kv.push([k, clip(s, 600)]); }
      return kv;
    }
    return { ALIAS, NAMES, TYPES, CONF, norm, normAll, columnsFor, sortRows, filterRows, groups, details, compare, typeLabel, groupKey, when, fmtSize, pick, scalar, clip };
  })();

  if (typeof module === 'object' && module.exports) module.exports = logic;
  if (typeof window === 'undefined' || !window.GH) return;

  // ================= the page part =================
  const GH = window.GH, h = GH.h, L = logic;
  const PAGE = 250;
  let seq = 0;
  const showTime = (iso) => { if (!iso) return ''; return GH.fmtTime ? GH.fmtTime(iso) : L.when(iso); };

  GH.resultTable = function resultTable(entities, opts) {
    const o = opts || {}, compact = !!o.compact, selectable = o.selectable !== false, uid = 'rt' + (++seq);
    let rows = L.normAll(entities, o.names);
    const st = { type: o.type || null, sort: null, q: '', sel: new Set(), open: new Set(), limit: PAGE, focus: null, refocus: null };
    const root = h('div', { class: 'rt' + (compact ? ' compact' : ''), dataset: { rt: '1' } });
    const filter = h('input', { type: 'text', id: uid + '-q', class: 'rt-q', placeholder: 'Filter these results', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Filter these results', oninput: () => { st.q = filter.value; st.limit = PAGE; draw(); } });
    const count = h('span', { class: 'rt-count mute sm', role: 'status', 'aria-live': 'polite' });
    const copySel = GH.btn('Copy selected', { cls: 'rt-copysel', onclick: () => { const v = selected().map((n) => n.value); if (v.length) GH.copy(v.join('\n')); } });
    const tabs = h('div', { class: 'rt-types', role: 'group', 'aria-label': 'Kind of result' });
    const holder = h('div', { class: 'rt-body' });
    root.append(h('div', { class: 'rt-bar' }, h('div', { class: 'rt-find' }, h('label', { class: 'sr', for: uid + '-q' }, 'Filter these results'), filter), count, selectable ? copySel : null), tabs, holder);

    const groupsAll = () => L.groups(rows);
    const curGroup = () => { const g = groupsAll(); if (!g.length) return null; return g.find((x) => x.key === st.type) || g[0]; };
    const selected = () => rows.filter((n) => st.sel.has(n.i));
    const fire = () => { if (typeof o.onSelect === 'function') { try { o.onSelect(selected().map((n) => n.orig)); } catch { /* the page's own handler failed */ } } };
    function visible() {
      const g = curGroup(); if (!g) return { g: null, cols: [], list: [] };
      const cols = L.columnsFor(g.type, { compact });
      let list = L.filterRows(g.rows, cols, st.q);
      if (st.sort) { const col = cols.find((c) => c.key === st.sort.key); if (col) list = L.sortRows(list, col, st.sort.dir); else st.sort = null; }
      return { g, cols, list };
    }
    function syncSel() {
      const { list } = visible();
      const shown = list.slice(0, st.limit), n = selected().length, inShown = shown.filter((r) => st.sel.has(r.i)).length;
      copySel.disabled = n === 0; copySel.querySelector('span').textContent = n ? 'Copy selected (' + n + ')' : 'Copy selected';
      const all = holder.querySelector('.rt-all'); if (all) { all.checked = shown.length > 0 && inShown === shown.length; all.indeterminate = inShown > 0 && inShown < shown.length; }
      for (const tr of holder.querySelectorAll('tr[data-i]')) { const on = st.sel.has(Number(tr.dataset.i)); tr.setAttribute('aria-selected', on ? 'true' : 'false'); const cb = tr.querySelector('.rt-cb'); if (cb) cb.checked = on; }
    }
    function toggle(i, on) { if (on === undefined) on = !st.sel.has(i); if (on) st.sel.add(i); else st.sel.delete(i); syncSel(); fire(); }
    function focusRow(i) { const tr = holder.querySelector('tr[data-i="' + i + '"]'); if (tr) { for (const x of holder.querySelectorAll('tr[data-i]')) x.tabIndex = -1; tr.tabIndex = 0; tr.focus(); st.focus = i; } }
    const copyOne = (n) => GH.copy(n.value);

    function drawTabs(gs, g) {
      GH.clear(tabs); tabs.hidden = gs.length < 2;
      for (const x of gs) tabs.append(h('button', { type: 'button', class: 'rt-type', 'aria-pressed': x.key === g.key ? 'true' : 'false', dataset: { k: x.key }, onclick: () => { st.type = x.key; st.limit = PAGE; st.sort = null; st.refocus = '.rt-type[data-k="' + CSS.escape(x.key) + '"]'; draw(); } }, x.label + ' ', h('span', { class: 'rt-n mono' }, String(x.rows.length))));
    }
    function header(cols, shown) {
      const tr = h('tr', { role: 'row' });
      if (selectable) tr.append(h('th', { class: 'rt-sel', scope: 'col' }, h('input', { type: 'checkbox', class: 'rt-all', 'aria-label': 'Select all shown rows', onchange: (ev) => { const { list } = visible(); for (const r of list.slice(0, st.limit)) { if (ev.target.checked) st.sel.add(r.i); else st.sel.delete(r.i); } syncSel(); fire(); } })));
      tr.append(h('th', { class: 'rt-open', scope: 'col' }, h('span', { class: 'sr' }, 'Details')));
      for (const c of cols) {
        const on = st.sort && st.sort.key === c.key;
        tr.append(h('th', { scope: 'col', class: 'rt-h' + (c.num ? ' num' : ''), 'aria-sort': on ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
          h('button', { type: 'button', class: 'rt-sortbtn', dataset: { k: c.key }, title: 'Sort by ' + c.label.toLowerCase(), onclick: () => { st.sort = !on ? { key: c.key, dir: 'asc' } : st.sort.dir === 'asc' ? { key: c.key, dir: 'desc' } : null; st.refocus = '.rt-sortbtn[data-k="' + CSS.escape(c.key) + '"]'; draw(true); } }, c.label, h('i', { class: 'rt-arrow', 'aria-hidden': 'true' }))));
      }
      tr.append(h('th', { class: 'rt-act', scope: 'col' }, h('span', { class: 'sr' }, 'Copy')));
      return h('thead', {}, tr);
    }
    function bodyRows(cols, shown) {
      const tb = h('tbody', {});
      shown.forEach((n, k) => {
        const open = st.open.has(n.i);
        const tr = h('tr', { role: 'row', tabindex: k === 0 ? '0' : '-1', dataset: { i: String(n.i) }, 'aria-selected': selectable ? (st.sel.has(n.i) ? 'true' : 'false') : null, 'aria-expanded': open ? 'true' : 'false', class: 'rt-r' });
        if (selectable) tr.append(h('td', { class: 'rt-sel' }, h('input', { type: 'checkbox', class: 'rt-cb', tabindex: '-1', checked: st.sel.has(n.i), 'aria-label': 'Select ' + L.clip(n.value, 80), onchange: (ev) => toggle(n.i, ev.target.checked) })));
        tr.append(h('td', { class: 'rt-open' }, h('button', { type: 'button', class: 'rt-exp', tabindex: '-1', 'aria-label': (open ? 'Hide' : 'Show') + ' details of ' + L.clip(n.value, 80), 'aria-expanded': open ? 'true' : 'false', onclick: () => { expand(n.i); } }, GH.icon('chev'))));
        for (const c of cols) {
          const v = c.get(n);
          tr.append(h('td', { class: (c.mono ? 'mono ' : '') + (c.num ? 'num ' : '') + (c.wrap ? 'wrap ' : '') + (c.tail ? 'tail' : ''), title: c.wrap && v.length > 60 ? v : null }, c.date && v ? showTime(v) : v));
        }
        tr.append(h('td', { class: 'rt-act' }, h('button', { type: 'button', class: 'btn rt-copy', tabindex: '-1', 'aria-label': 'Copy ' + L.clip(n.value, 80), onclick: () => copyOne(n) }, 'Copy')));
        tb.append(tr);
        if (open) {
          const dl = h('dl', { class: 'kv rt-kv' }, L.details(n).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
          tb.append(h('tr', { class: 'rt-detail', role: 'row' }, h('td', { colspan: String(cols.length + (selectable ? 3 : 2)), role: 'gridcell' }, dl)));
        }
      });
      return tb;
    }
    function expand(i) { if (st.open.has(i)) st.open.delete(i); else st.open.add(i); st.focus = i; draw(true); }
    function onKey(ev) {
      const tr = ev.target.closest && ev.target.closest('tr[data-i]'); if (!tr) return;
      if (ev.target !== tr && /^(INPUT|BUTTON)$/.test(ev.target.tagName) && ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const all = [...holder.querySelectorAll('tr[data-i]')], at = all.indexOf(tr), i = Number(tr.dataset.i);
      const go = (to, extend) => { to = Math.max(0, Math.min(all.length - 1, to)); const t = all[to]; if (t) { focusRow(Number(t.dataset.i)); if (extend && selectable) toggle(Number(t.dataset.i), true); } ev.preventDefault(); };
      switch (ev.key) {
        case 'ArrowDown': go(at + 1, ev.shiftKey); break;
        case 'ArrowUp': go(at - 1, ev.shiftKey); break;
        case 'PageDown': go(at + 10); break;
        case 'PageUp': go(at - 10); break;
        case 'Home': go(0); break;
        case 'End': go(all.length - 1); break;
        case ' ': if (selectable) { toggle(i); ev.preventDefault(); } break;
        case 'Enter': expand(i); ev.preventDefault(); break;
        case 'c': case 'C': if (!ev.ctrlKey && !ev.metaKey) { const n = rows.find((r) => r.i === i); if (n) copyOne(n); ev.preventDefault(); } break;
        case 'a': case 'A': if ((ev.ctrlKey || ev.metaKey) && selectable) { const { list } = visible(); for (const r of list.slice(0, st.limit)) st.sel.add(r.i); syncSel(); fire(); ev.preventDefault(); } break;
        case 'Escape': if (st.sel.size) { st.sel.clear(); syncSel(); fire(); ev.preventDefault(); } break;
        default:
      }
    }
    function draw(keepFocus) {
      const had = keepFocus && holder.contains(document.activeElement), fi = st.focus;
      const gs = groupsAll(); GH.clear(holder);
      if (!gs.length) { tabs.hidden = true; count.textContent = '0 results'; copySel.disabled = true; holder.append(h('div', { class: 'rt-empty' }, o.emptyText || 'No results.')); return; }
      const g = curGroup(); st.type = g.key; drawTabs(gs, g);
      const { cols, list } = visible(), shown = list.slice(0, st.limit);
      count.textContent = (st.q ? list.length + ' of ' + g.rows.length : g.rows.length) + ' ' + (g.rows.length === 1 ? L.typeLabel(g.type, g.rawType, false).toLowerCase() : g.label.toLowerCase()) + (st.q ? ' match' : '');
      if (!list.length) { holder.append(h('div', { class: 'rt-empty' }, 'Nothing matches that filter.', ' ', h('button', { type: 'button', class: 'btn', onclick: () => { filter.value = ''; st.q = ''; draw(); filter.focus(); } }, 'Clear the filter'))); syncSel(); return; }
      const table = h('table', { class: 'rt-t', role: 'grid', 'aria-label': o.caption || g.label, 'aria-multiselectable': selectable ? 'true' : null, 'aria-rowcount': String(list.length + 1) }, header(cols, shown), bodyRows(cols, shown));
      table.addEventListener('keydown', onKey);
      holder.append(h('div', { class: 'rt-scroll', role: 'region', 'aria-label': (o.caption || g.label) + ' table, scrolls sideways' }, table));
      if (list.length > shown.length) holder.append(h('div', { class: 'rt-more' }, h('span', { class: 'mute sm' }, 'Showing ' + shown.length + ' of ' + list.length + '. '), GH.btn('Show ' + Math.min(PAGE, list.length - shown.length) + ' more', { onclick: () => { st.limit += PAGE; draw(true); } })));
      syncSel();
      if (st.refocus) { const b = holder.querySelector(st.refocus) || tabs.querySelector(st.refocus); st.refocus = null; if (b) { b.focus(); return; } }
      if (had && fi !== null && fi !== undefined) focusRow(fi);
    }
    root.rt = {
      selected: () => selected().map((n) => n.orig), selectAll() { const { list } = visible(); for (const r of list) st.sel.add(r.i); syncSel(); fire(); }, clear() { st.sel.clear(); syncSel(); fire(); },
      setEntities(list) { rows = L.normAll(list, o.names); st.sel.clear(); st.open.clear(); st.limit = PAGE; draw(); fire(); },
      setFilter(t) { filter.value = String(t || ''); st.q = filter.value; st.limit = PAGE; draw(); }, count: () => rows.length, shown: () => visible().list.length,
    };
    draw();
    return root;
  };
})();
