'use strict';
// Tool page harness. Run by tools/ghost-tools-shots.js under xvfb, once per window size. Never part of the packaged app.
// It builds a page from the real Ghost scripts and styles (util, case-model, casesvc, resulttable, toolpage, the skin css) with a stand-in for the Ghost preload
// (tools/ghost-tools-mock.js), then drives every state of the tool page: ready, running, cancelled, needs a program, off, failed, getting ready, nothing found,
// an error, withheld results, the table (columns per kind, sort, filter, select, copy, paging, key/value fallback), raw, history, add to case, the About drawer,
// keyboard use, reflow, sticky header, contrast, and screenshots. Output: GHOST_OUT (default <tmp>/ghost-tools-shots).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app: eapp, BrowserWindow } = electron;
const OUT = process.env.GHOST_OUT || path.join(os.tmpdir(), 'ghost-tools-shots');
const [W, H] = (process.env.GHOST_SIZE || '1280x800').split('x').map(Number), TAG = process.env.GHOST_TAG || String(W);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };
eapp.commandLine.appendSwitch('no-sandbox'); eapp.commandLine.appendSwitch('disable-gpu');

const UI = path.join(__dirname, '..', 'src', 'ui', 'ghost');
function buildPage() {
  const idx = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  const sprite = /<svg width="0"[\s\S]*?<\/svg>/.exec(idx)[0];
  const css = ['mf-tokens.css', 'skins.css', 'ghost.css', 'layouts.css', 'fields.css', 'toolpage.css'];
  const js = ['scope-parse.js', 'case-model.js', 'modules.js', 'util.js', 'casesvc.js', 'resulttable.js', 'toolpage.js'];
  const base = pathToFileURL(UI).href + '/';
  const html = `<!doctype html><html lang="en" data-theme="dark" data-skin="mayfair"><head><meta charset="utf-8"><base href="${base}"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src file:; style-src file:; img-src data:; font-src file:"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tool page harness</title>
${css.map((c) => `<link rel="stylesheet" href="${c}">`).join('\n')}</head><body>${sprite}
<div id="root"><div class="app-harness"><main id="main" tabindex="-1"></main></div></div><div id="live" class="sr" role="status" aria-live="polite"></div>
<script src="${pathToFileURL(path.join(__dirname, 'ghost-tools-mock.js')).href}"></script>
${js.map((j) => `<script src="${j}"></script>`).join('\n')}</body></html>`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-tools-page-')); const f = path.join(dir, 'harness.html'); fs.writeFileSync(f, html); return f;
}

eapp.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const page = buildPage();
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
  const wc = win.webContents;
  const pageErr = []; wc.on('console-message', (_e, level, msg) => { if (level >= 2 && !/Electron Security Warning/.test(msg)) { pageErr.push(msg); console.log('PAGE-CONSOLE ' + msg); } });
  wc.on('did-fail-load', (_e, c, d, u) => console.log('LOAD-FAIL ' + c + ' ' + d + ' ' + u));
  await win.loadFile(page); await sleep(300);
  const J = (c) => wc.executeJavaScript(c, true);
  const waitFor = async (cond, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await J(cond)) return true; } catch { /* page busy */ } await sleep(60); } return false; };
  const shot = async (name) => { await sleep(350); const img = await wc.capturePage(); fs.writeFileSync(path.join(OUT, `${TAG}-${name}.png`), img.toPNG()); };
  const q = (sel) => J(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent.trim().replace(/\\s+/g,' '):null})()`);
  const has = (sel) => J(`!!document.querySelector(${JSON.stringify(sel)})`);
  const n = (sel) => J(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const click = (sel) => J(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e)e.click();return !!e})()`);
  const noOverflow = async (label) => { const o = await J('({sw:document.documentElement.scrollWidth,iw:window.innerWidth,bw:document.body.scrollWidth})'); rec(`no horizontal page scroll ${label} at ${W}`, o.sw <= o.iw + 1 && o.bw <= o.iw + 1, JSON.stringify(o)); };
  const key = (sel, k, o) => J(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.focus();e.dispatchEvent(new KeyboardEvent('keydown',Object.assign({key:${JSON.stringify(k)},bubbles:true,cancelable:true},${JSON.stringify(o || {})})));return true})()`);
  const show = async (id, opts) => { await J(`document.getElementById('main').replaceChildren(GH.toolPage(${JSON.stringify(id)},${JSON.stringify(opts || {})}))`); await waitFor(`(()=>{const h=document.querySelector('.tp h1');return h&&h.textContent!==${JSON.stringify(id)}&&!document.querySelector('.tp-fs').hidden})()`); await sleep(120); };
  const type = (v) => J(`(()=>{const i=document.querySelector('.tp-q');i.value=${JSON.stringify(v)};i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const run = async (v, ms = 9000) => { await type(v); await click('.tp-run'); return waitFor(`!!document.querySelector('.tp-sum')&&!document.querySelector('.tp-cancel:not([hidden])')`, ms); };
  const labels = () => J(`[...document.querySelectorAll('.rt-t th.rt-h')].map(t=>t.textContent.trim())`);
  const firstCells = (n2) => J(`[...document.querySelectorAll('.rt-t tbody tr.rt-r')].slice(0,${n2}).map(r=>r.children[2].textContent.trim())`);
  const theme = (t, sk) => J(`document.documentElement.dataset.theme=${JSON.stringify(t)};document.documentElement.dataset.skin=${JSON.stringify(sk || 'mayfair')};true`);
  const CONTRAST = (rootSel) => `(()=>{const parse=(s)=>{const cm=/color\\(srgb ([^ )]+) ([^ )]+) ([^ )]+)(?: \\/ ([^ )]+))?\\)/.exec(s);if(cm)return {r:Math.round(+cm[1]*255),g:Math.round(+cm[2]*255),b:Math.round(+cm[3]*255),a:cm[4]===undefined?1:+cm[4]};const m=/rgba?\\(([^)]+)\\)/.exec(s);if(!m)return null;const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}};
    const over=(t,b)=>({r:t.r*t.a+b.r*(1-t.a),g:t.g*t.a+b.g*(1-t.a),b:t.b*t.a+b.b*(1-t.a),a:1});
    const lum=(c)=>{const f=(x)=>{x/=255;return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4)};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)};
    const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};
    const bgOf=(el)=>{const layers=[];for(let e=el;e;e=e.parentElement){const c=parse(getComputedStyle(e).backgroundColor);if(c&&c.a>0){layers.push(c);if(c.a>=1)break}}let b={r:0,g:0,b:0,a:1};for(let i=layers.length-1;i>=0;i--)b=over(layers[i],b);return b};
    const bad=[];let n=0;const seen=new Set();
    const walker=document.createTreeWalker(document.querySelector(${JSON.stringify(rootSel)}),NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){const t=walker.currentNode;if(!t.nodeValue.trim())continue;const el=t.parentElement;if(!el||seen.has(el))continue;seen.add(el);const cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none'||el.closest('.sr,[hidden],[aria-hidden=true],option'))continue;const r=el.getBoundingClientRect();if(r.width<2||r.height<2)continue;
      let fg=parse(cs.color);if(!fg)continue;let bg=bgOf(el);const dis=el.closest(':disabled');fg=over(fg,bg);const px=parseFloat(cs.fontSize),bold=parseInt(cs.fontWeight)>=700,large=px>=24||(px>=18.66&&bold);const need=large?3:4.5;n++;const rr=ratio(fg,bg);if(rr<need-0.001&&!dis)bad.push({t:t.nodeValue.trim().slice(0,28),cls:(el.getAttribute('class')||el.tagName).slice(0,30),r:Math.round(rr*100)/100,need});}
    return {n,bad:bad.slice(0,8),nbad:bad.length}})()`;
  const contrast = async (label, rootSel) => { await J('document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} })'); await sleep(200); const c = await J(CONTRAST(rootSel || '#root')); rec(`contrast AA ${label}`, c.nbad === 0, c.nbad ? c.nbad + ' of ' + c.n + ': ' + JSON.stringify(c.bad) : c.n + ' text runs checked'); };
  const mock = (e) => J(`__mock.${e}`);

  try {
    // ================= a ready tool, before any run =================
    await show('dns-doh');
    rec('ready: tool page, not a card (no .ccard, one h1 with the tool name)', (await n('.ccard')) === 0 && (await n('.tp h1')) === 1 && (await q('.tp h1')) === 'DNS records (DoH)');
    rec('ready: category and id shown', /Domains and networks/.test(await q('.tp-title .eyebrow')) && /dns-doh/.test(await q('.tp-id')));
    rec('ready: state badge says Ready', (await q('.tp-badge')) === 'Ready' && (await J("document.querySelector('.tp-badge').dataset.state")) === 'ready');
    rec('ready: last-test note says the self-test passed, with its time', /Self-test passed on/.test(await q('.tp-test')) && (await J("document.querySelector('.tp-test').dataset.test")) === 'tested', await q('.tp-test'));
    rec('ready: no banner, Run is enabled, no fake results on screen', (await has('.tp-banner:not([hidden])')) === false && (await J("!document.querySelector('.tp-run').disabled")) && (await has('.rt')) === false && /Nothing has been run yet/.test(await q('.tp-panel')));
    rec('ready: tabs Results, Raw, History', JSON.stringify(await J("[...document.querySelectorAll('.tp-tab')].map(t=>t.textContent)")) === JSON.stringify(['Results', 'Raw', 'History']));
    rec('ready: single input kind -> no kind picker, says what it takes', (await J("document.querySelector('.tp-kindf').hidden")) === true && /Takes: domain/.test(await q('.tp-under')), await q('.tp-under'));
    await noOverflow('ready'); await contrast('ready tool page'); await shot('ready-empty');

    // ================= person-aimed text is refused with the reason, nothing is sent =================
    await mock('reset()'); await type('someone@example.com'); await click('.tp-run'); await sleep(200);
    rec('refusal: an email address is refused with the plain reason and nothing was sent', /does not look up people/.test(await q('.tp-err')) && (await mock("count('search.run')")) === 0 && (await mock("count('jobs.run')")) === 0, await q('.tp-err'));
    await type(''); await click('.tp-run'); rec('empty input: asks for something to look up', /Type something/.test(await q('.tp-err')));

    // ================= a run: live progress, results table =================
    await type('example.org'); await click('.tp-run');
    rec('running: progress strip appears, badge says Running, Cancel shows, Run is off', await waitFor("!document.querySelector('.tp-prog').hidden && document.querySelector('.tp-badge').dataset.state==='running' && !document.querySelector('.tp-cancel').hidden && document.querySelector('.tp-run').disabled", 3000), await q('.tp-prog'));
    await shot('running');
    rec('running: finishes with a summary and a table', await waitFor("!!document.querySelector('.tp-sum.done') && !!document.querySelector('.rt-t')"), await q('.tp-sum'));
    rec('run went through the search call for this one tool with kind and value', JSON.stringify((await mock("last('search.run')")).args) === JSON.stringify({ query: 'example.org', kind: 'domain', tools: ['dns-doh'] }), JSON.stringify((await mock("last('search.run')")).args));
    rec('results: summary counts the results and gives the time taken', /^Found 8 results for example\.org in \d+ ms\.$/.test(await q('.tp-sum')), await q('.tp-sum'));
    rec('results: the Results tab shows the count, History shows 1', (await q('#' + (await J("document.querySelector('.tp-tab').id")))) === 'Results (8)' && /History \(1\)/.test(await q('.tp-tab[data-tab=history]')));
    rec('table: one button per kind with its count (Domains, IP addresses, Events)', JSON.stringify(await J("[...document.querySelectorAll('.rt-type')].map(b=>b.textContent.trim().replace(/\\s+/g,' '))")) === JSON.stringify(['Domains 3', 'IP addresses 3', 'Events 2']), JSON.stringify(await J("[...document.querySelectorAll('.rt-type')].map(b=>b.textContent.trim())")));
    rec('table: domain columns', JSON.stringify(await labels()) === JSON.stringify(['Domain', 'Role', 'For', 'Certificates', 'Confidence', 'Source', 'Seen']), JSON.stringify(await labels()));
    rec('table: roles are in plain words, source is the tool name', /Name server/.test(await q('.rt-t tbody')) && /Mail server/.test(await q('.rt-t tbody')) && /DNS records \(DoH\)/.test(await q('.rt-t tbody tr td.tail') || '') === false && /DNS records \(DoH\)/.test(await q('.rt-t tbody')));
    await shot('results-domains');
    await click('.rt-type:nth-child(2)'); await sleep(100);
    rec('table: IP columns differ from domain columns', JSON.stringify(await labels()) === JSON.stringify(['Address', 'Role', 'For', 'Network', 'Country', 'Confidence', 'Source', 'Seen']), JSON.stringify(await labels()));
    rec('table: kind button is pressed and keeps focus after switching', (await J("document.querySelector('.rt-type:nth-child(2)').getAttribute('aria-pressed')")) === 'true' && (await J("document.activeElement.classList.contains('rt-type')")));
    // sort
    await click('.rt-sortbtn[data-k=v]'); await sleep(80);
    rec('sort: first click sorts ascending, aria-sort says so', (await firstCells(3)).join('|') === '203.0.113.5|203.0.113.20|2001:db8::7' && (await J("document.querySelector('th.rt-h[aria-sort]:not([aria-sort=none])').getAttribute('aria-sort')")) === 'ascending', (await firstCells(3)).join('|'));
    await click('.rt-sortbtn[data-k=v]'); await sleep(80);
    rec('sort: second click sorts descending', (await firstCells(3))[0] === '2001:db8::7' && (await J("document.querySelector('th.rt-h[aria-sort=descending]')!==null")));
    rec('sort: the sort button keeps focus', await J("document.activeElement.classList.contains('rt-sortbtn')"));
    await click('.rt-sortbtn[data-k=v]'); await sleep(80);
    rec('sort: third click puts the order back', (await J("document.querySelector('th.rt-h[aria-sort=ascending],th.rt-h[aria-sort=descending]')")) === null && (await firstCells(1))[0] === '203.0.113.5');
    // filter
    await J(`(()=>{const f=document.querySelector('.rt-q');f.value='db8';f.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(100);
    rec('filter: typing narrows the rows and says how many match', (await n('.rt-t tbody tr.rt-r')) === 1 && /1 of 3 .* match/.test(await q('.rt-count')), await q('.rt-count'));
    await J(`(()=>{const f=document.querySelector('.rt-q');f.value='zzzz';f.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(100);
    rec('filter: nothing matching shows a plain line and a way back', /Nothing matches that filter/.test(await q('.rt-empty')) && (await has('.rt-empty .btn')));
    await click('.rt-empty .btn'); await sleep(100);
    rec('filter: clearing it brings every row back and focuses the box', (await n('.rt-t tbody tr.rt-r')) === 3 && (await J("document.activeElement.classList.contains('rt-q')")));
    // keyboard on rows
    await J("document.querySelector('.rt-t tbody tr.rt-r').focus()");
    const kr = (k, o) => J(`(()=>{const e=document.activeElement;e.dispatchEvent(new KeyboardEvent('keydown',Object.assign({key:${JSON.stringify(k)},bubbles:true,cancelable:true},${JSON.stringify(o || {})})));return true})()`);
    await kr('ArrowDown'); rec('keyboard: ArrowDown moves to the next row', (await J("document.activeElement.dataset.i")) === '1' && (await J("document.activeElement.tabIndex")) === 0, await J("document.activeElement.dataset.i"));
    await kr('ArrowUp'); await kr(' ');
    rec('keyboard: Space selects the row, aria-selected and the checkbox follow', (await J("document.activeElement.getAttribute('aria-selected')")) === 'true' && (await J("document.activeElement.querySelector('.rt-cb').checked")));
    rec('keyboard: Add selected to case now says (1) and is enabled', (await q('.tp-add-sel')) === 'Add selected to case (1)' && (await J("!document.querySelector('.tp-add-sel').disabled")));
    await J("window.__copied=null;GH.copy=(t)=>{window.__copied=t};true"); await kr('c');
    rec('keyboard: c copies the row value', (await J('window.__copied')) === '203.0.113.5', await J('window.__copied'));
    await kr('Enter'); await sleep(100);
    rec('keyboard: Enter opens a key and value detail row', (await has('.rt-detail .rt-kv')) && /rrtype/.test(await q('.rt-detail')) && /Confidence/.test(await q('.rt-detail')) && /Source address/.test(await q('.rt-detail')) && (await J("document.activeElement.getAttribute('aria-expanded')")) === 'true', await q('.rt-detail'));
    await shot('results-ip-detail');
    await kr('Enter'); await kr('a', { ctrlKey: true });
    rec('keyboard: Ctrl+A selects every shown row', (await q('.tp-add-sel')) === 'Add selected to case (3)', await q('.tp-add-sel'));
    await kr('Escape'); rec('keyboard: Escape clears the selection', (await q('.tp-add-sel')) === 'Add selected to case' && (await J("document.querySelector('.tp-add-sel').disabled")));
    await click('.rt-t tbody tr.rt-r .rt-copy'); rec('copy button copies the value too', (await J('window.__copied')) === '203.0.113.5');
    await click('.rt-t .rt-all'); rec('header checkbox selects all shown rows', (await q('.tp-add-sel')) === 'Add selected to case (3)'); await click('.rt-t .rt-all');
    rec('copy selected button copies the selected values', await (async () => { await click('.rt-t tbody tr.rt-r .rt-cb'); await sleep(50); await click('.rt-copysel'); return (await J('window.__copied')) === '203.0.113.5'; })());

    // ================= add to case =================
    await J("GH.cs.create('Harness case').then(()=>true)");
    await J("document.querySelector('.rt-t tbody tr.rt-r').focus()"); await kr('Escape'); await kr(' ');
    await click('.tp-add-sel'); rec('add selected: the case gains the entity with its source and time', await waitFor("Object.values(GH.cs.current().entities).some(e=>e.type==='ip'&&e.label==='203.0.113.5')"), JSON.stringify(await J('Object.values(GH.cs.current().entities).map(e=>e.type+":"+e.label)')));
    const src = await J('Object.values(GH.cs.current().sources)');
    rec('add selected: a source is recorded with the tool, its version, the query, a time and the address it came from', src.some((s) => s.connector === 'dns-doh' && s.connectorVersion === '1.0.0' && s.query && s.query.value === 'example.org' && /^\d{4}-/.test(s.fetchedAt) && /service\.example/.test(s.origin)), JSON.stringify(src.map((s) => [s.connector, s.connectorVersion, s.fetchedAt, s.origin])));
    const before = await J('Object.keys(GH.cs.current().entities).length');
    await click('.tp-add-all'); await waitFor(`Object.keys(GH.cs.current().entities).length>${before}`);
    rec('add all: every result lands in the case (8 results plus the domain looked up)', (await J('Object.keys(GH.cs.current().entities).length')) >= 9, await J('Object.keys(GH.cs.current().entities).length'));
    rec('add buttons come back after adding', await waitFor("!document.querySelector('.tp-add-all').disabled"));

    // ================= raw and history =================
    await click('.tp-tab[data-tab=raw]'); await sleep(100);
    rec('raw: pretty JSON of the answer with the tool, query and results, and a Copy button', /"tool": "dns-doh"/.test(await q('.tp-raw')) && /"results": \[/.test(await q('.tp-raw')) && (await has('.tp-copyraw')));
    await click('.tp-copyraw'); rec('raw: Copy puts the JSON on the clipboard call', /"query": "example\.org"/.test((await J('window.__copied')) || ''));
    await shot('raw');
    await click('.tp-tab[data-tab=results]'); await run('example.net');
    await click('.tp-tab[data-tab=history]'); await sleep(100);
    rec('history: two runs listed newest first with query, kind, time, count and ms', (await n('.tp-ht tbody tr')) === 2 && /example\.net/.test(await q('.tp-ht tbody tr:first-child')) && /example\.org/.test(await q('.tp-ht tbody tr:last-child')) && /Found 8/.test(await q('.tp-ht tbody tr')) && /Domain/.test(await q('.tp-ht tbody tr')), await q('.tp-ht tbody'));
    await shot('history');
    await click('.tp-ht tbody tr:last-child .tp-hopen'); await sleep(150);
    rec('history: clicking an older run reopens its results', /example\.org/.test(await q('.tp-sum')) && (await J("document.querySelector('.tp-tab[aria-selected=true]').dataset.tab")) === 'results', await q('.tp-sum'));
    await show('dns-doh');
    rec('history survives leaving the page and coming back (and the last run is shown)', /History \(2\)/.test(await q('.tp-tab[data-tab=history]')) && (await has('.rt-t')), await q('.tp-sum'));

    // ================= options use the tool's own fields =================
    await mock('reset()'); await show('dns-doh');
    await J("document.querySelector('.tp-opts').open=true"); await J(`(()=>{const s=document.querySelector('.tp-opts select');s.value='A';s.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    rec('options: a box set by the person shows in the summary', /Options \(1 set\)/.test(await q('.tp-opts summary')));
    await run('example.org');
    const jr = await mock("last('jobs.run')");
    rec('options: the run uses the tool\'s own fields (jobs.run) with the option and the main value', jr && JSON.stringify(jr.args) === JSON.stringify({ connector: 'dns-doh', input: { domain: 'example.org', types: 'A' } }) && (await mock("count('search.run')")) === 0, jr && JSON.stringify(jr.args));
    rec('options: results show and the summary names the option', /Found 8 results for example\.org \(types A\)/.test(await q('.tp-sum')), await q('.tp-sum'));

    // ================= several input kinds: it says what it understood =================
    await show('gdelt-doc');
    rec('kinds: a tool taking several kinds shows a picker with plain names', JSON.stringify(await J("[...document.querySelectorAll('.tp-kindf option')].map(o=>o.textContent)")) === JSON.stringify(['Keyword', 'Organisation name', 'Domain', 'Place name']), JSON.stringify(await J("[...document.querySelectorAll('.tp-kindf option')].map(o=>o.textContent)")));
    await type('example.org'); rec('kinds: a domain typed is understood as a domain and the picker follows', /Understood as Domain: example\.org/.test(await q('.tp-under')) && (await J("document.querySelector('.tp-kindf select').value")) === 'domain', await q('.tp-under'));
    await type('Example Holdings'); rec('kinds: plain words are taken as an organisation name for a tool that takes one', (await J("document.querySelector('.tp-kindf select').value")) === 'org-name' && /Understood as Organisation name/.test(await q('.tp-under')));
    await J(`(()=>{const s=document.querySelector('.tp-kindf select');s.value='place-text';s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await type('Example Holdings');
    rec('kinds: choosing a kind by hand sticks', (await J("document.querySelector('.tp-kindf select').value")) === 'place-text');
    await mock('reset()'); await J(`(()=>{const s=document.querySelector('.tp-kindf select');s.value='org-name';s.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await run('Example Holdings');
    rec('kinds: the search is sent with the chosen kind', JSON.stringify((await mock("last('search.run')")).args) === JSON.stringify({ query: 'Example Holdings', kind: 'org-name', tools: ['gdelt-doc'] }), JSON.stringify((await mock("last('search.run')")).args));
    rec('articles: columns for a news article', JSON.stringify(await labels()) === JSON.stringify(['Title', 'Site', 'Published', 'Language', 'Country', 'Web address', 'Confidence', 'Source', 'Seen']), JSON.stringify(await labels()));
    rec('articles: grouped with the timeline event as another kind', /News articles 2/.test(await q('.rt-types')) && /Events 1/.test(await q('.rt-types')));
    await J("document.querySelector('.tp-opts').open=true"); await J(`(()=>{const i=document.querySelector('.tp-opts input[type=number]');i.value='5';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await mock('reset()'); await run('Example Holdings');
    rec('options: a required list the person left alone is chosen to suit the kind, a number is sent as a number', JSON.stringify((await mock("last('jobs.run')")).args.input) === JSON.stringify({ query: 'Example Holdings', kind: 'organisation', limit: 5 }), JSON.stringify((await mock("last('jobs.run')")).args));
    await noOverflow('articles'); await shot('results-articles');
    if (W <= 800) rec('reflow: the wide articles table scrolls inside its own box, the page does not', await J("(()=>{const s=document.querySelector('.rt-scroll');return s.scrollWidth>s.clientWidth+4})()"), JSON.stringify(await J("(()=>{const s=document.querySelector('.rt-scroll');return [s.scrollWidth,s.clientWidth]})()")));

    // ================= honest states =================
    await show('exiftool');
    rec('needs a program: badge, one plain line naming the program, no results, Run off', (await q('.tp-badge')) === 'Ghost computer' && /Needs ExifTool, which is not on this computer/.test(await q('.tp-banner')) && (await J("document.querySelector('.tp-run').disabled")) && (await has('.tp-sum')) === false && (await has('.rt')) === false, await q('.tp-banner'));
    rec('needs a program: only the one line is shown (no form, no tabs, nothing that looks like a result)', (await J("document.querySelector('.tp-form').hidden && document.querySelector('.tp-tabs').hidden && document.querySelector('.tp-panel').hidden")) && !/Found|result/.test(await J("document.querySelector('.tp').innerText")), await J("document.querySelector('.tp').innerText.slice(0,200)"));
    await mock('reset()'); await J(`document.querySelector('.tp-form').requestSubmit()`); await sleep(150);
    rec('needs a program: nothing can be started (no calls made)', (await mock("count('jobs.run')")) === 0 && (await mock("count('search.run')")) === 0);
    await shot('needs-program'); await contrast('needs-program page');
    await click('.tp-about-btn'); await sleep(200);
    rec('about: drawer opens with what it contacts, rate limit, licence, terms and what it needs', (await has('.tp-drawer')) && /Nothing leaves this computer/.test(await q('.tp-drawer')) && /Rate limit/.test(await q('.tp-drawer')) && /GPL-1\.0-or-later, a separate program/.test(await q('.tp-drawer')) && /Terms and contacts/.test(await q('.tp-drawer')) && /Missing/.test(await q('.tp-drawer')) && /exiftool/.test(await q('.tp-drawer')), await q('.tp-drawer'));
    rec('about: says how to get the missing program', /How to get exiftool/.test(await q('.tp-drawer')) && /virtual computer/.test(await q('.tp-drawer')));
    rec('about: focus moves into the drawer', await J("document.querySelector('.tp-drawer').contains(document.activeElement)"));
    await shot('about'); await contrast('about drawer', '.tp-drawer');
    await key('.tp-about-x', 'Tab'); await J("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))"); await sleep(120);
    rec('about: Escape closes it and focus returns to the About button', (await has('.tp-drawer')) === false && (await J("document.activeElement.classList.contains('tp-about-btn')")));
    await click('.tp-about-btn'); await sleep(100); await click('.tp-about-x'); rec('about: the close button works', (await has('.tp-drawer')) === false);

    await show('rdap-domain');
    rec('off: badge says Off, one plain line, Run off, Switch on offered', (await q('.tp-badge')) === 'Off' && /switched off/.test(await q('.tp-banner')) && (await J("document.querySelector('.tp-run').disabled")) && (await q('.tp-toggle')) === 'Switch on');
    await shot('off');
    await click('.tp-toggle'); rec('off: switching on makes it ready and Run works', await waitFor("document.querySelector('.tp-badge').dataset.state==='ready' && !document.querySelector('.tp-run').disabled"), await q('.tp-badge'));
    rec('off: switching on went through the app (connectors.enable)', (await mock("count('connectors.enable')")) === 1);
    await run('example.org'); rec('off then on: it runs and shows a table', await has('.rt-t'));
    await click('.tp-toggle'); rec('a ready tool can be switched off again', await waitFor("document.querySelector('.tp-badge').dataset.state==='off'"));

    await show('ct-crtsh');
    rec('failed: badge says Failed, the real reason is shown, Run off', (await q('.tp-badge')) === 'Failed' && /Could not be set up: its files are not valid/.test(await q('.tp-banner')) && (await J("document.querySelector('.tp-banner').getAttribute('role')")) === 'alert' && (await J("document.querySelector('.tp-run').disabled")), await q('.tp-banner'));
    await shot('failed');
    await show('cisa-kev'); rec('getting ready: says so, Run off', (await q('.tp-badge')) === 'Getting ready' && /Getting ready/.test(await q('.tp-banner')) && (await J("document.querySelector('.tp-run').disabled")));
    await show('wayback-cdx');
    rec('a failed self-test is reported but never blocks use (ready, test note in red text, Run on)', (await q('.tp-badge')) === 'Ready' && /Self-test failed: the archive did not answer in time/.test(await q('.tp-test')) && (await J("document.querySelector('.tp-test').dataset.test")) === 'failed' && (await J("!document.querySelector('.tp-run').disabled")), await q('.tp-test'));
    await click('.tp-retest'); rec('test again: reports the failure it got', await waitFor("/did not answer in time/.test(document.querySelector('.tp-msg').textContent)"), await q('.tp-msg'));

    // ================= nothing found, an error, withheld =================
    await show('wikidata'); await run('Example Holdings');
    rec('nothing found: says so plainly, with the caution, and shows no table or add buttons', /^Nothing found for Example Holdings\. That does not prove nothing is there\.$/.test(await q('.tp-sum')) && (await has('.rt')) === false && (await has('.tp-add-all')) === false, await q('.tp-sum'));
    rec('nothing found: History records the empty run', /History \(1\)/.test(await q('.tp-tab[data-tab=history]')));
    await shot('empty');
    await show('gleif'); await run('Example Holdings');
    rec('error: shows the real reason as an alert', /^It failed: The service answered 503 \(try again later\)\.$/.test(await q('.tp-sum')) && (await J("document.querySelector('.tp-sum').getAttribute('role')")) === 'alert' && (await has('.rt')) === false, await q('.tp-sum'));
    await shot('error'); await contrast('error state');
    await show('sec-edgar'); await run('Example Holdings');
    rec('withheld: an account-style result is left out and the page says so', /1 result withheld/.test(await q('.tp-withheld')) && (await n('.rt-t tbody tr.rt-r')) === 1 && /^Found 1 result/.test(await q('.tp-sum')), await q('.tp-sum'));

    // ================= cancel =================
    await mock('reset()'); await show('nasa-cmr'); await type('Rotterdam'); await click('.tp-run');
    await waitFor("!document.querySelector('.tp-cancel').hidden"); await sleep(150); await click('.tp-cancel');
    rec('cancel: says Cancelled, keeps nothing, Run is back', await waitFor("/^Cancelled\\./.test((document.querySelector('.tp-sum')||{}).textContent||'') && !document.querySelector('.tp-run').disabled", 4000), await q('.tp-sum'));
    const cc = await mock("last('search.cancel')"); rec('cancel: the app was asked to cancel this search', cc && /^s\d+$/.test(cc.args.searchId), JSON.stringify(cc));
    rec('cancel: no table, no add buttons, badge back to Ready', (await has('.rt')) === false && (await has('.tp-add-all')) === false && (await q('.tp-badge')) === 'Ready');

    // ================= files =================
    await mock('reset()'); await show('hash-file');
    rec('file: a file tool shows the chooser and drop area, not a text box, and says nothing is sent', (await J("document.querySelector('.tp-q').hidden")) && (await J("!document.querySelector('.tp-drop').hidden")) && /Files never leave it/.test(await q('.tp-under')), await q('.tp-under'));
    await click('.tp-run'); rec('file: Run without a file asks for one', /Choose a file first/.test(await q('.tp-err')));
    await click('.tp-choose'); await waitFor("/photo\\.jpg/.test(document.querySelector('.tp-filename').textContent)");
    rec('file: chosen file shows its name and size', /photo\.jpg \(200 KB\)/.test(await q('.tp-filename')), await q('.tp-filename'));
    await click('.tp-run'); await waitFor("!!document.querySelector('.tp-sum.done')");
    rec('file: the run sends the file token the app gave, never a path', JSON.stringify((await mock("last('search.run')")).args) === JSON.stringify({ query: 'tok_abcdef123456', kind: 'file', tools: ['hash-file'] }), JSON.stringify((await mock("last('search.run')")).args));
    rec('file: columns for a file with its hash', JSON.stringify(await labels()) === JSON.stringify(['Name', 'Kind', 'SHA-256', 'Size', 'Format', 'Confidence', 'Source', 'Seen']) && /aaaaaaaa/.test(await q('.rt-t tbody')) && /200 KB/.test(await q('.rt-t tbody')), JSON.stringify(await labels()));
    await shot('results-file');

    // ================= unknown kind falls back to key and value =================
    await show('nvd'); await run('example');
    rec('unknown kind: Type, Value and Details columns', JSON.stringify(await labels()) === JSON.stringify(['Type', 'Value', 'Details', 'Confidence', 'Source', 'Seen']), JSON.stringify(await labels()));
    await J("document.querySelector('.rt-t tbody tr.rt-r').focus()"); await kr('Enter'); await sleep(100);
    rec('unknown kind: the detail row lists every key and value', /score/.test(await q('.rt-detail')) && /9\.8/.test(await q('.rt-detail')) && /vector/.test(await q('.rt-detail')) && /summary/.test(await q('.rt-detail')), await q('.rt-detail'));
    await shot('results-unknown');

    // ================= places: coordinates in their own columns =================
    await show('nominatim'); await run('Rotterdam');
    rec('places: Place, Latitude, Longitude, About', JSON.stringify(await labels()).startsWith('["Place","Latitude","Longitude","About"') && /51\.9244/.test(await q('.rt-t tbody')) && /4\.4777/.test(await q('.rt-t tbody')), JSON.stringify(await labels()));
    await click('.rt-sortbtn[data-k=lat]'); await click('.rt-sortbtn[data-k=lat]'); await sleep(80);
        const lat = await J("[...document.querySelectorAll('.rt-t tbody tr.rt-r')].map(r=>r.children[3].textContent.trim())"); rec('sort: numeric order is right', lat.join('|') === '51.9249|51.9244', lat.join('|'));

    // ================= a big table pages and keeps its header =================
    await show('overpass-query'); await run('Rotterdam');
    rec('big: shows the first 250 rows and offers the rest', (await n('.rt-t tbody tr.rt-r')) === 250 && /Show 250 more/.test(await q('.rt-more')) && /600 ip addresses/.test(await q('.rt-count')), await q('.rt-count'));
    await click('.rt-more .btn'); await sleep(150); rec('big: Show more adds rows', (await n('.rt-t tbody tr.rt-r')) === 500);
    await J(`(()=>{const f=document.querySelector('.rt-q');f.value='198.51.2.';f.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(120);
    rec('big: the filter looks through every row, not only the shown ones', (await n('.rt-t tbody tr.rt-r')) === 100 && /100 of 600/.test(await q('.rt-count')), await q('.rt-count'));
    await J(`(()=>{const f=document.querySelector('.rt-q');f.value='';f.dispatchEvent(new Event('input',{bubbles:true}))})()`); await sleep(100);
    await J("document.querySelector('.rt-scroll').scrollTop=400"); await sleep(120);
    const st = await J("(()=>{const s=document.querySelector('.rt-scroll').getBoundingClientRect(),t=document.querySelector('.rt-t th.rt-h').getBoundingClientRect();return {top:Math.round(s.top),th:Math.round(t.top),scrolled:document.querySelector('.rt-scroll').scrollTop}})()");
    rec('sticky header: stays at the top of the table box after scrolling the rows', st.scrolled > 0 && Math.abs(st.th - st.top) <= 2, JSON.stringify(st));
    await noOverflow('big table'); await shot('big');

    // ================= keyboard through the page =================
    await show('dns-doh'); await J("document.querySelector('.tp-q').focus()");
    const stops = []; for (let i = 0; i < 4; i++) { wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' }); await sleep(80); stops.push(await J("(()=>{const a=document.activeElement;return a.className.split(' ')[0]||a.tagName})()")); }
    rec('keyboard: Tab goes from the input through Options to Run', stops.includes('tp-run') || stops.includes('btn'), stops.join(','));
    await key('.tp-tab[data-tab=results]', 'ArrowRight'); rec('keyboard: arrow keys move between the tabs', (await J("document.querySelector('.tp-tab[aria-selected=true]').dataset.tab")) === 'raw' && (await J("document.activeElement.dataset.tab")) === 'raw');
    await key('.tp-tab[data-tab=raw]', 'End'); rec('keyboard: End goes to History', (await J("document.querySelector('.tp-tab[aria-selected=true]').dataset.tab")) === 'history');
    rec('tabs: tablist, tabs and panel carry their roles and links', (await J("document.querySelector('.tp-tabs').getAttribute('role')")) === 'tablist' && (await n('.tp-tab[role=tab]')) === 3 && (await J("document.querySelector('.tp-panel').getAttribute('aria-labelledby')===document.querySelector('.tp-tab[aria-selected=true]').id")));

    // ================= skins and themes: contrast of the results page =================
    await show('dns-doh'); await run('example.org'); await J("document.querySelector('.rt-t tbody tr.rt-r').focus()"); await kr(' ');
    for (const [t, sk] of [['dark', 'mayfair'], ['light', 'mayfair'], ['dark', 'ops'], ['dark', 'terminal'], ['dark', 'hud'], ['dark', 'mono']]) {
      await theme(t, sk); await sleep(250);
      await contrast(`results page, ${sk} ${t}`); await noOverflow(`${sk} ${t}`);
      if (sk === 'mayfair' && t === 'light') await shot('results-light');
      if (sk === 'terminal') await shot('results-terminal');
      if (sk === 'mono') await shot('results-mono');
    }
    await theme('dark', 'mayfair');
    await click('.tp-about-btn'); await sleep(150); await theme('light', 'mayfair'); await sleep(200); await contrast('about drawer, light', '.tp-drawer'); await shot('about-light'); await theme('dark', 'mayfair'); await click('.tp-about-x');

    // ================= source results handed over by the master search =================
    await J("document.getElementById('main').replaceChildren(GH.toolPage('dns-doh',{query:'example.com',kind:'domain',results:[{entity:{type:'ip',value:'192.0.2.1'},source:{tool:'t',connector:'dns-doh',version:'1.0.0'},observedAt:'2026-10-27T10:00:00.000Z',confidence:'likely'}]}))");
    await waitFor("!!document.querySelector('.rt-t')");
    rec('hand-over: results passed in by the master search are shown with the query filled in', /192\.0\.2\.1/.test(await q('.rt-t tbody')) && (await J("document.querySelector('.tp-q').value")) === 'example.com');

    // ================= the table works on its own with merged entities =================
    await J(`document.getElementById('main').replaceChildren(GH.resultTable([{type:'domain',value:'a.example',tools:['DNS records','Certificates'],observedAt:'2026-10-27T10:00:00Z'},{type:'domain',value:'b.example',tools:['DNS records'],observedAt:'2026-10-26T10:00:00Z'}],{compact:true}))`);
    rec('table alone: merged entities (several tools per entity) show every source', /DNS records, Certificates/.test(await q('.rt-t tbody')) && JSON.stringify(await labels()) === JSON.stringify(['Domain', 'Role', 'For', 'Source', 'Seen']), JSON.stringify(await labels()));

    rec('no console errors', pageErr.length === 0, pageErr.slice(0, 3).join(' | '));
  } catch (e) { rec('harness error', false, e && e.stack); }
  fs.writeFileSync(path.join(OUT, `${TAG}-tools-results.json`), JSON.stringify(results, null, 1));
  const failed = results.filter((r) => !r.ok).length; console.log(`DONE ${results.length - failed}/${results.length}`);
  try { fs.rmSync(path.dirname(page), { recursive: true, force: true }); } catch { /* ok */ }
  eapp.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); eapp.exit(2); });
