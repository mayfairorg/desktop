'use strict';
// Ghost report export. HTML is one self-contained file: no script, no external address, everything escaped. PDF is made from that same HTML in a hidden window
// with scripts off and the network blocked. JSON is the case data with a content hash. Every report ends with the sources table, the attribution of the data it
// contains, the method and limits statement, the SHA-256 of the report data and the footer line.
const crypto = require('node:crypto');
const M = require('../../../ui/ghost/case-model');

const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const TYPE_NAME = { domain: 'Domains', ip: 'IP addresses', asn: 'Networks (ASN)', cert: 'Certificates', org: 'Organisations', document: 'Documents', image: 'Images', place: 'Places', event: 'Events', url: 'Web addresses', email: 'Infrastructure contacts', service: 'Services', finding: 'Other findings' };
const FOOTER = 'Made with Mayfair Ghost. Copyright The Mayfair Organization.';
const METHOD = 'This report was made from public sources and from files the author supplied. It may be incomplete or out of date. Check anything important against the original source before relying on it. A result that shows nothing does not prove nothing is there. Personal details found in public records are withheld.';

// What a report contains, after the author's "hide from report" choices. Pure data, hashed as given.
function reportData(c, { author, now = Date.now(), hide = [], version = '' } = {}) {
  const hidden = new Set([...(c.settings && c.settings.hideFromReport || []), ...hide]);
  const entities = Object.values(c.entities).filter((e) => !hidden.has(e.id)).sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : a.label < b.label ? -1 : 1));
  const keep = new Set(entities.map((e) => e.id));
  const edges = Object.values(c.edges).filter((e) => keep.has(e.from) && keep.has(e.to));
  const usedSources = new Set(); for (const e of entities) for (const s of e.sources) usedSources.add(s); for (const e of edges) for (const s of e.sources) usedSources.add(s);
  const sources = Object.values(c.sources).filter((s) => usedSources.has(s.id)).sort((a, b) => (a.fetchedAt < b.fetchedAt ? -1 : a.fetchedAt > b.fetchedAt ? 1 : a.id < b.id ? -1 : 1));
  const num = new Map(sources.map((s, i) => [s.id, i + 1]));
  const timeline = M.buildTimeline(c).filter((t) => !t.entity || keep.has(t.entity));
  const notes = c.notes.map((n) => ({ ...n, refs: (n.refs || []).filter((r) => keep.has(r)) }));
  return { format: 'mayfair-ghost-report/1', title: c.title, author: String(author || (c.settings && c.settings.reportAuthor) || '').slice(0, 120), generated: new Date(now).toISOString(), ghostVersion: version, caseId: c.id, hiddenCount: hidden.size, entities, edges, sources, timeline, notes, num };
}

function reportHtml(c, opts = {}) {
  const d = reportData(c, opts);
  const hash = sha(JSON.stringify({ ...d, num: undefined }));
  const byId = Object.fromEntries(d.entities.map((e) => [e.id, e]));
  const refs = (ids) => ids.map((s) => d.num.get(s)).filter(Boolean).sort((a, b) => a - b).map((n) => '[' + n + ']').join(' ');
  const local = new Date(d.generated);
  const groups = {}; for (const e of d.entities) (groups[e.type] = groups[e.type] || []).push(e);
  const attributions = [...new Set(d.sources.map((s) => s.attribution).filter(Boolean))];
  const licences = [...new Set(d.sources.map((s) => s.licence && s.connector + ': ' + s.licence).filter(Boolean))];
  const places = d.entities.filter((e) => e.type === 'place' && M.placeCoords(e));
  const entityHtml = Object.keys(groups).map((t) => `<section><h2>${esc(TYPE_NAME[t] || t)} <span class="n">${groups[t].length}</span></h2><table><thead><tr><th>Value</th><th>Details</th><th>First seen</th><th>Sources</th></tr></thead><tbody>${groups[t].map((e) => {
    const attrs = Object.entries(e.attrs || {}).map(([k, v]) => esc(k) + ': ' + esc(typeof v === 'object' ? JSON.stringify(v) : v)).join('; ');
    const tags = e.tags.length ? ' <span class="tags">' + e.tags.map((x) => esc(x)).join(', ') + '</span>' : '';
    const how = M.isUnsourced(e) ? '<em>no source on record</em>' : e.manual && !e.sources.length ? '<em>added by hand</em>' : esc(refs(e.sources));
    return `<tr><td class="v">${esc(e.label)}${tags}</td><td>${attrs}</td><td class="m">${esc(e.firstSeen.slice(0, 10))}</td><td class="m">${how}</td></tr>`;
  }).join('')}</tbody></table></section>`).join('');
  const rel = d.edges.length ? `<section><h2>Relations <span class="n">${d.edges.length}</span></h2><table><thead><tr><th>From</th><th>Relation</th><th>To</th><th>Sources</th></tr></thead><tbody>${d.edges.map((e) => `<tr><td class="v">${esc(byId[e.from].label)}</td><td>${esc(e.rel)}</td><td class="v">${esc(byId[e.to].label)}</td><td class="m">${e.manual && !e.sources.length ? '<em>added by hand</em>' : esc(refs(e.sources))}</td></tr>`).join('')}</tbody></table></section>` : '';
  const pins = places.length ? `<section><h2>Places</h2><table><thead><tr><th>Place</th><th>Latitude</th><th>Longitude</th><th>Basis</th></tr></thead><tbody>${places.map((e) => { const p = M.placeCoords(e); return `<tr><td class="v">${esc(e.label)}</td><td class="m">${p.lat.toFixed(5)}</td><td class="m">${p.lon.toFixed(5)}</td><td class="m">${esc(e.attrs.basis || '')}${e.attrs.accuracy ? ', ' + esc(e.attrs.accuracy) : ''}</td></tr>`; }).join('')}</tbody></table></section>` : '';
  const tl = d.timeline.length ? `<section><h2>Timeline</h2><table><thead><tr><th>Date (UTC)</th><th>Event</th><th>Sources</th></tr></thead><tbody>${d.timeline.map((t) => `<tr><td class="m">${esc(t.t.replace('T', ' ').slice(0, 16))}</td><td>${esc(t.title)}${t.manual ? ' <em>(added by hand)</em>' : ''}</td><td class="m">${esc(refs(t.sources || []))}</td></tr>`).join('')}</tbody></table></section>` : '';
  const nt = d.notes.length ? `<section><h2>Notes</h2>${d.notes.map((n) => `<div class="note"><div class="m">${esc(n.t.replace('T', ' ').slice(0, 16))} UTC${n.refs.length ? ' about ' + esc(n.refs.map((r) => byId[r].label).join(', ')) : ''}</div><p>${esc(n.text).replace(/\n/g, '<br>')}</p></div>`).join('')}</section>` : '';
  const src = `<section><h2>Sources <span class="n">${d.sources.length}</span></h2><table><thead><tr><th>#</th><th>Tool and version</th><th>Query</th><th>Fetched (UTC)</th><th>Origin</th><th>Licence</th></tr></thead><tbody>${d.sources.map((s) => `<tr><td class="m">${d.num.get(s.id)}</td><td class="v">${esc(s.connector)} ${esc(s.connectorVersion)}</td><td class="v">${s.query ? esc(s.query.kind + ': ' + s.query.value) : ''}</td><td class="m">${esc(s.fetchedAt.replace('T', ' ').slice(0, 19))}</td><td class="m">${esc(s.origin)}</td><td class="m">${esc(s.licence)}</td></tr>`).join('') || '<tr><td colspan="6"><em>No tool lookups are listed. Everything here was added by hand.</em></td></tr>'}</tbody></table></section>`;
  const attrib = attributions.length || licences.length ? `<section><h2>Data and licences</h2><ul>${attributions.map((a) => `<li>${esc(a)}</li>`).join('')}${licences.map((a) => `<li>${esc(a)}</li>`).join('')}</ul></section>` : '';
  const summary = `${d.entities.length} entities, ${d.edges.length} relations, ${d.sources.length} sources` + (d.hiddenCount ? `. ${d.hiddenCount} item(s) were left out of this report by the author.` : '.');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${esc(d.title)}</title><style>
:root{color-scheme:light}*{box-sizing:border-box}body{font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#1b1b19;background:#fff;margin:0;padding:40px 24px}main{max-width:980px;margin:0 auto}
h1{font-size:28px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:17px;margin:32px 0 8px;border-bottom:1px solid #d9d9d4;padding-bottom:6px}.n{font-weight:400;color:#6b6b66;font-size:13px}.eyebrow{font:600 11px ui-monospace,monospace;letter-spacing:.2em;color:#6b6b66}
.meta{color:#6b6b66;font-size:13px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;font:600 11px ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;color:#6b6b66;padding:6px 8px;border-bottom:1px solid #d9d9d4}td{padding:7px 8px;border-bottom:1px solid #eeeeea;vertical-align:top;overflow-wrap:anywhere}
.v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.m{font:12px ui-monospace,monospace;color:#6b6b66}.tags{font-size:12px;color:#6b6b66}.note{border:1px solid #d9d9d4;border-radius:8px;padding:10px 12px;margin:8px 0}.note p{margin:4px 0 0}
.box{border:1px solid #d9d9d4;border-radius:8px;padding:12px 14px;background:#f7f7f4;margin:16px 0}footer{margin-top:40px;padding-top:12px;border-top:1px solid #d9d9d4;color:#6b6b66;font-size:12px}tr{break-inside:avoid}h2{break-after:avoid}
@media print{body{padding:0}}</style></head><body><main>
<p class="eyebrow">MAYFAIR GHOST REPORT</p><h1>${esc(d.title)}</h1>
<p class="meta">${d.author ? 'Prepared by ' + esc(d.author) + '. ' : ''}Generated ${esc(d.generated.replace('T', ' ').slice(0, 16))} UTC (${esc(local.toString().replace(/ GMT.*/, ''))} local). ${esc(summary)}</p>
<div class="box"><strong>Method and limits.</strong> ${esc(METHOD)}</div>
${entityHtml || '<p><em>This case has no entities.</em></p>'}${pins}${rel}${tl}${nt}${src}${attrib}
<footer><p>Report data SHA-256: <span class="m">${hash}</span></p><p>${esc(FOOTER)}</p></footer></main></body></html>`;
}

function reportJson(c, opts = {}) {
  const d = reportData(c, opts); const { num, ...rest } = d;
  const body = { ...rest, entities: d.entities, edges: d.edges, sources: d.sources, timeline: d.timeline, notes: d.notes };
  return JSON.stringify({ ...body, sha256: sha(JSON.stringify(body)), footer: FOOTER }, null, 2);
}

// Renders HTML to a PDF with Electron: a hidden window, no scripts, every request cancelled. Returns a Buffer.
async function htmlToPdf(electron, html) {
  const { BrowserWindow, session } = electron;
  const part = 'mf-ghost-report-' + crypto.randomBytes(4).toString('hex');
  const ses = session.fromPartition(part);
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*', 'file://*/*'] }, (_d, cb) => cb({ cancel: true }));
  const w = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { partition: part, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, images: false, spellcheck: false } });
  try {
    w.webContents.on('will-navigate', (e) => e.preventDefault()); w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    await w.loadURL('data:text/html;charset=utf-8;base64,' + Buffer.from(html, 'utf8').toString('base64'));
    return await w.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
  } finally { try { w.destroy(); } catch { /* gone */ } }
}

module.exports = { reportHtml, reportJson, reportData, htmlToPdf, esc, FOOTER, METHOD, TYPE_NAME };
