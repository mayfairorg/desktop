'use strict';
// Ghost report: the Quick notes appendix. The author picks which tabs go in (a tab's "report" flag, set from the export dialog); each clip is printed with
// where it came from, when it was saved and its item hash, highlights are kept (colour, underline, comment), pictures are embedded as data (no outside
// address), and everything is escaped. Returns the markup for the report and a plain description of it, which the report hashes with the rest of its data.
const QN = require('../../../ui/ghost/qn-model');

const esc = QN.escHtml;
const IMG_TOTAL_CAP = 32 * 1024 * 1024;            // pictures embedded in one report; beyond this a clip says the picture was left out
const CSS = '.qn-app{margin-top:40px}.qn-app h3{font-size:15px;margin:22px 0 6px}.qn-clip{border:1px solid #d9d9d4;border-radius:8px;padding:10px 12px;margin:10px 0;break-inside:avoid}.qn-meta{font:12px ui-monospace,monospace;color:#6b6b66;overflow-wrap:anywhere}.qn-body{margin:8px 0 4px;overflow-wrap:anywhere;white-space:normal}.qn-body p,.qn-body li,.qn-body h3,.qn-body h4{margin:2px 0}.qn-plain{white-space:pre-wrap}.qn-body pre{white-space:pre-wrap;background:#f1f1ee;padding:6px 8px;border-radius:6px}.qn-body blockquote{margin:4px 0 4px 8px;padding-left:10px;border-left:3px solid #d9d9d4}.qn-body table{width:auto}.qn-body td,.qn-body th{border:1px solid #eeeeea;padding:3px 6px}.qn-body img,.qn-img{max-width:100%;height:auto;border:1px solid #d9d9d4;border-radius:6px}mark.h{color:inherit;border-radius:2px}mark.h-yellow{background:#fff3a3}mark.h-green{background:#c9f0cf}mark.h-blue{background:#cfe3ff}mark.h-red{background:#ffd0cc}mark.h-grey{background:#e2e2de}mark.h.u,.qn-u{text-decoration:underline}mark.h-none{background:none}.qn-tags{font-size:12px;color:#6b6b66}.qn-hl{font-size:12px;margin:4px 0 0;padding-left:18px}';

function pieces(text, hl) {
  return QN.coverage(0, text.length, hl).map((p) => {
    const raw = esc(text.slice(p.a, p.b)).replace(/\n/g, '<br>'); if (!p.hl.length) return raw;
    const st = QN.pieceStyle(p.hl);
    return '<mark class="h h-' + (st.color || 'none') + (st.u ? ' u' : '') + '">' + raw + '</mark>';
  }).join('');
}
const quote = (c, h) => { const t = (c.text || '').slice(h.a, h.b).replace(/\s+/g, ' ').trim(); return t.length > 160 ? t.slice(0, 157) + '...' : t; };
const utc = (iso) => String(iso || '').replace('T', ' ').slice(0, 16) + ' UTC';

function clipHtml(c, blob) {
  const from = c.from && c.from.label ? esc(c.from.label) + (c.from.url ? ' <span class="qn-meta">(' + esc(c.from.url) + ')</span>' : '') : 'Pasted';
  const kind = { text: 'Text', rich: 'Rich text', link: 'Link', image: 'Image', file: 'File' }[c.kind] || c.kind;
  let body = '';
  if (c.kind === 'rich') body = '<div class="qn-body">' + QN.treeToHtml(c.tree, { wrap: (a, b, s) => pieces(s, c.hl.map((h) => ({ ...h, a: h.a - a, b: h.b - a })).filter((h) => h.b > 0 && h.a < s.length).map((h) => ({ ...h, a: Math.max(0, h.a), b: Math.min(s.length, h.b) }))) }) + '</div>';
  else if (c.kind === 'text') body = '<div class="qn-body qn-plain">' + pieces(c.text, c.hl) + '</div>';
  else if (c.kind === 'link') body = '<div class="qn-body"><a href="' + esc(c.url) + '" rel="noreferrer noopener">' + esc(c.title || c.url) + '</a><br><span class="qn-meta">' + pieces(c.text, c.hl) + '</span></div>';
  else if (c.kind === 'image') { const d = blob(c); body = d ? '<div class="qn-body"><img class="qn-img" alt="' + esc(c.title || 'Pasted image') + '" src="data:' + esc(c.image.mime) + ';base64,' + d + '"></div>' : '<div class="qn-body"><em>The picture was left out of this report (size or missing).</em></div>'; }
  else if (c.kind === 'file') body = '<div class="qn-body">' + esc(c.file.name) + ' <span class="qn-meta">(' + esc(c.file.mime) + ', ' + c.file.bytes.toLocaleString('en-GB') + ' bytes). The file itself is not printed here; its hash identifies it.</span></div>';
  const hl = (c.hl || []).filter((h) => h.comment || h.color || h.u).sort((a, b) => a.a - b.a);
  const hls = hl.some((h) => h.comment) ? '<ol class="qn-hl">' + hl.filter((h) => h.comment).map((h) => '<li>&ldquo;' + esc(quote(c, h)) + '&rdquo; (' + esc([h.color, h.u ? 'underline' : ''].filter(Boolean).join(', ')) + '): ' + esc(h.comment) + '</li>').join('') + '</ol>' : '';
  const sent = (c.sent || []).length ? '<div class="qn-meta">Sent to the case board as: ' + esc(c.sent.map((s) => s.label).join(', ')) + '</div>' : '';
  return '<div class="qn-clip"><div><strong>' + esc(c.title || kind) + '</strong>' + (c.pinned ? ' <span class="qn-meta">(pinned)</span>' : '') + '</div>'
    + '<div class="qn-meta">' + esc(kind) + ' &middot; saved ' + esc(utc(c.t)) + ' &middot; from ' + from + '</div>'
    + '<div class="qn-meta">Item hash (SHA-256) ' + esc(c.hash) + '</div>' + body
    + (c.tags && c.tags.length ? '<div class="qn-tags">Tags: ' + esc(c.tags.join(', ')) + '</div>' : '') + hls + sent + '</div>';
}

// store: NoteStore. caseId: the case. tabs: the tab ids to include. -> { html, data } or null when there are no notes or no chosen tab.
function build({ store, caseId, tabs }) {
  if (!store || !Array.isArray(tabs) || !tabs.length) return null;
  const json = store.read(caseId); if (json === null) return null;
  let doc; try { doc = JSON.parse(json); } catch { return null; }
  if (QN.validate(doc).length) return null;
  const want = new Set(tabs), chosen = doc.tabs.filter((t) => want.has(t.id));
  if (!chosen.length) return null;
  let imgBytes = 0;
  const blob = (c) => {
    if (imgBytes + c.image.bytes > IMG_TOTAL_CAP) return '';
    try { const b = store.getBlob(caseId, c.image.blob); imgBytes += b.length; return b.toString('base64'); } catch { return ''; }
  };
  const data = { tabs: chosen.map((t) => ({ id: t.id, title: t.title, clips: t.clips.map((c) => ({ id: c.id, kind: c.kind, saved: c.t, title: c.title, text: QN.hasText(c) ? c.text : '', url: c.url || '', from: c.from, hash: c.hash, tags: c.tags, pinned: !!c.pinned,
    highlights: c.hl.map((h) => ({ text: quote(c, h), color: h.color, underline: !!h.u, comment: h.comment })), image: c.image ? { mime: c.image.mime, bytes: c.image.bytes } : undefined, file: c.file ? { name: c.file.name, mime: c.file.mime, bytes: c.file.bytes } : undefined })) })) };
  const n = chosen.reduce((k, t) => k + t.clips.length, 0);
  const html = '<section class="qn-app"><style>' + CSS + '</style><h2>Appendix: Quick notes <span class="n">' + n + (n === 1 ? ' clip' : ' clips') + ' in ' + chosen.length + (chosen.length === 1 ? ' tab' : ' tabs') + '</span></h2>'
    + '<p class="meta">These are the author\'s own notes, kept as they were pasted. Each clip shows where it came from (as far as Ghost knew or the author entered), when it was saved and its item hash, so it can be checked against the original.</p>'
    + chosen.map((t) => '<h3>' + esc(t.title) + '</h3>' + (t.clips.length ? t.clips.slice().sort((a, b) => (a.pinned === b.pinned ? (a.t < b.t ? -1 : a.t > b.t ? 1 : 0) : a.pinned ? -1 : 1)).map((c) => clipHtml(c, blob)).join('') : '<p class="meta"><em>This tab is empty.</em></p>')).join('') + '</section>';
  return { html, data };
}
module.exports = { build, CSS, IMG_TOTAL_CAP };
