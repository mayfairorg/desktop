'use strict';
// Ghost investigation browser: the capture helper. Saves what the page looks like now (HTML, screenshot, hashes, time) into the case,
// sealed in the vault, with the address it came from as provenance. Nothing is written outside the vault.
const crypto = require('node:crypto');
const { CASE_ID } = require('./policy');

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const MAX_HTML = 12 * 1024 * 1024;

class CaptureError extends Error { constructor(code, message) { super(message); this.code = code; } }

const recId = (caseId, stamp, part) => `${caseId}.snap.${stamp}.${part}`;
const stampOf = (ms, rand) => ms.toString(36) + rand;

// wc: the page's webContents (DevTools protocol attached by the window). ctx: what the chip says now.
async function capturePage({ wc, vault, caseId, ctx, now = Date.now, rand = () => crypto.randomBytes(2).toString('hex') }) {
  if (!CASE_ID.test(caseId)) throw new CaptureError('bad-input', 'Bad case id.');
  if (!vault || !vault.unlocked) throw new CaptureError('locked', 'Unlock the vault first: captures are only saved inside it.');
  const url = wc.getURL();
  if (!/^https?:/.test(url)) throw new CaptureError('no-page', 'Open a web page first.');
  // The document is read through the DevTools protocol, not through the page's own script, so the page cannot answer for itself.
  const doc = await wc.debugger.sendCommand('DOM.getDocument', { depth: 0 });
  const out = await wc.debugger.sendCommand('DOM.getOuterHTML', { nodeId: doc.root.nodeId });
  const html = Buffer.from('<!-- captured from ' + url.replace(/--/g, '-') + ' -->\n' + String(out.outerHTML || ''), 'utf8');
  if (html.length > MAX_HTML) throw new CaptureError('too-large', 'The page is too large to save.');
  const img = await wc.capturePage();
  const png = img.toPNG(); const size = img.getSize();
  const t = now(); const stamp = stampOf(t, rand());
  const meta = {
    v: 1, kind: 'page-snapshot', caseId, id: stamp,
    capturedAt: new Date(t).toISOString(),
    source: { url, title: String(wc.getTitle() || '').slice(0, 300) },
    html: { sha256: sha256(html), bytes: html.length },
    screenshot: { sha256: sha256(png), bytes: png.length, width: size.width, height: size.height },
    route: { route: ctx.route, dns: ctx.dns, exposesIp: !!ctx.exposesIp },
    egress: { allowedHosts: ctx.allowedHosts || [], blockedCount: ctx.blockedCount || 0 },
    tool: 'mayfair-ghost-browser',
  };
  meta.recordSha256 = sha256(Buffer.from(JSON.stringify(meta)));
  // Written in this order so a half-finished capture never has a meta record pointing at nothing.
  vault.put('cases', recId(caseId, stamp, 'html'), html);
  vault.put('cases', recId(caseId, stamp, 'png'), png);
  vault.putJSON('cases', recId(caseId, stamp, 'meta'), meta);
  return meta;
}

function listSnapshots({ vault, caseId }) {
  if (!vault || !vault.unlocked) throw new CaptureError('locked', 'The vault is locked.');
  const p = caseId + '.snap.';
  return vault.list('cases').filter((i) => i.startsWith(p) && i.endsWith('.meta')).map((i) => vault.getJSON('cases', i)).filter(Boolean).sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
}
// Re-reads the stored bytes and checks them against the recorded hashes.
function verifySnapshot({ vault, caseId, id }) {
  const m = vault.getJSON('cases', recId(caseId, id, 'meta')); if (!m) return { ok: false, error: 'not found' };
  const h = vault.get('cases', recId(caseId, id, 'html')), p = vault.get('cases', recId(caseId, id, 'png'));
  const { recordSha256, ...rest } = m;
  return { ok: !!h && !!p && sha256(h) === m.html.sha256 && sha256(p) === m.screenshot.sha256 && sha256(Buffer.from(JSON.stringify(rest))) === recordSha256, meta: m };
}

module.exports = { capturePage, listSnapshots, verifySnapshot, CaptureError, recId };
