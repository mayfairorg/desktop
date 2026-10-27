'use strict';
// Quick notes screenshots and a UI smoke run, with Playwright and a stub bridge (no Electron needed). Output: NOTES_OUT (default /tmp/ghost-notes-shots).
// Usage: NODE_PATH=/opt/npm-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node tools/ghost-notes-shots.js
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');
const out = process.env.NOTES_OUT || '/tmp/ghost-notes-shots';
fs.mkdirSync(out, { recursive: true });
const ui = path.join(__dirname, '..', 'src', 'ui', 'ghost');
const stub = () => {
  const mem = { docs: {}, blobs: {}, sent: [] };
  const ok = (data) => Promise.resolve({ ok: true, data });
  const nid = () => Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
  window.__mem = mem;
  window.ghostApp = new Proxy({ notes: {
    get: (s) => ok({ json: mem.docs[s] || null }), put: (s, j) => { mem.docs[s] = j; return ok({ bytes: j.length }); },
    blob: { put: (s, b) => { const id = nid(); mem.blobs[id] = b; return ok({ id, bytes: b.length }); }, get: (s, id) => ok(mem.blobs[id]), save: () => ok({}) },
    cases: () => ok([{ id: 'case-aaaa-1111-bbbb', title: 'Northwind review' }]), clipboard: () => ok({ text: '', html: '', image: null }), hint: () => ok(null),
    capture: { browser: () => Promise.resolve({ ok: false, code: 'no-browser', error: 'The Ghost browser is not open.' }), sources: () => ok([]), take: () => ok(null) },
    popout: { open: () => ok({}), close: () => ok({}), info: () => ok({ open: true, scope: 'case-aaaa-1111-bbbb', theme: window.__theme || 'dark', onTop: true }), top: () => ok({}) },
    send: (p) => { mem.sent.push(p); return ok({}); }, onSent: () => () => {},
  } }, { get: (t, k) => (k in t ? t[k] : () => ok(null)) });
};
const paste = (page, { text, html }) => page.evaluate(({ text, html }) => {
  const dt = new DataTransfer(); if (text) dt.setData('text/plain', text); if (html) dt.setData('text/html', html);
  const t = document.getElementById('qn-compose'); t.focus(); t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, { text, html });
(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox'] }); let bad = 0; const fail = (m) => { bad++; console.error('FAIL', m); };
  for (const [tag, w, h, theme] of [['desktop-dark', 1100, 800, 'dark'], ['desktop-light', 1100, 800, 'light'], ['phone', 390, 844, 'dark']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, serviceWorkers: 'block' }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await page.route(/^https?:/, (r) => { errs.push('network ' + r.request().url()); r.abort(); });
    await page.addInitScript(`window.__theme=${JSON.stringify(theme)};`); await page.addInitScript(stub);
    await page.goto(pathToFileURL(path.join(ui, 'quicknotes.html')).href); await page.waitForSelector('#qn-compose');
    await paste(page, { text: 'Registered office: 12 Example Road. Director appointed 2019.', html: '<p>Registered office: <b>12 Example Road</b>. <script>alert(1)</script>Director appointed 2019.</p><img src="https://x.example/p.png">' });
    await page.waitForSelector('.qn-list li'); const nclip = await page.locator('.qn-list > li').count(); if (nclip !== 1) fail(tag + ' expected 1 clip, got ' + nclip);
    if (await page.locator('.qn-list script, .qn-list img[src^="http"]').count()) fail(tag + ' unsafe markup rendered');
    await paste(page, { text: 'Second finding: shared mail host', html: '' }); await paste(page, { text: 'https://registry.example/co/42', html: '' });
    // highlight a word through a real selection
    await page.evaluate(() => { const sp = document.querySelector('.qn-list [data-o]'); const r = document.createRange(); const n = sp.firstChild; r.setStart(n, 0); r.setEnd(n, Math.min(10, n.length)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); });
    await page.locator('.qn-sw-yellow').first().click(); if (!(await page.locator('.qn-list mark, .qn-list .qn-m').count())) fail(tag + ' highlight not drawn');
    await page.waitForTimeout(200); await page.screenshot({ path: path.join(out, 'notes-popout-' + tag + '.png') });
    // tabs
    await page.keyboard.press('Control+t'); await page.waitForTimeout(150); const ntabs = await page.locator('.qn-tabs [role=tab]').count(); if (ntabs < 2) fail(tag + ' new tab not made (' + ntabs + ')');
    await page.locator('.qn-tabs [role=tab]').first().click();
    // search across tabs
    await page.fill('#qn-q', 'mail host'); await page.waitForTimeout(150); const hits = await page.locator('.qn-list .qn-count').innerText(); if (!/1 match/.test(hits)) fail(tag + ' search said: ' + hits); await page.fill('#qn-q', '');
    await page.waitForTimeout(1300); const saved = await page.evaluate(() => Object.keys(window.__mem.docs).length); if (!saved) fail(tag + ' nothing autosaved');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1); if (overflow) fail(tag + ' horizontal scroll');
    if (errs.length) fail(tag + ' errors: ' + errs.slice(0, 3).join(' | '));
    await ctx.close();
  }
  await browser.close(); console.log(bad ? 'smoke failed' : 'smoke ok, shots in ' + out); process.exit(bad ? 1 : 0);
})();
