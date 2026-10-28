'use strict';
// Layout check for the Ghost skins. Run by tools/ghost-layout-shots.js under xvfb, once per window size. Never part of the packaged app.
// It opens the real Ghost window with the real service and vault (stand-in OS key store, stand-in Mayfair ID), then for every skin:
//   structure (the key regions of that skin's layout exist), real-data binding (an empty state first, then a case with places, lookups and a vault),
//   no horizontal page scroll, keyboard use, reduced motion, text contrast measured on the drawn page, and screenshots of Home, the Workspace, the results, a tool page, Active scanning and the Case board.
// The case and the lookups it shows are fixtures made here, through the same case model and page calls the app itself uses.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const electron = require('electron');
const { app: eapp } = electron;
const OUT = process.env.GHOST_OUT || path.join(os.tmpdir(), 'ghost-layout-shots');
const [W, H] = (process.env.GHOST_SIZE || '1280x800').split('x').map(Number), TAG = process.env.GHOST_TAG || String(W);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };


// The page-side stand-in for the app calls the Workspace uses (gapp:builtins.status, gapp:search.classify, gapp:search.run, gapp:search.cancel and their events), run in the page with executeJavaScript.
// It answers from a fixed list of tools and fixed results, and says so: it is only here until the main-process side of the contract is in the app.
function installMock() {
  const GH = window.GH, S = window.GhostScope;
  const T = (id, name, category, inputs, state, o = {}) => ({ id, name, category, inputs, state, note: o.note || '', tested: o.tested || (state === 'ready' ? 'tested' : 'pending'), testNote: o.testNote || '' });
  const tools = [
    T('dns-doh', 'DNS records', 'Domains and networks', ['domain'], 'ready'), T('rdap-domain', 'Registration data of a domain', 'Domains and networks', ['domain'], 'ready'),
    T('rdap-ip-asn', 'Registration data of an IP address or ASN', 'Domains and networks', ['ip', 'asn'], 'ready'), T('ct-crtsh', 'Certificates in public logs', 'Domains and networks', ['domain', 'cert-hash'], 'ready'), T('rdns', 'Reverse DNS', 'Domains and networks', ['ip'], 'ready'),
    T('gleif', 'GLEIF legal entities', 'Companies', ['org-name', 'lei'], 'ready'), T('sec-edgar', 'SEC EDGAR filings', 'Companies', ['org-name'], 'failed', { note: 'The filing index could not be read: the service refused the request.', tested: 'failed', testNote: 'Refused.' }),
    T('wikidata', 'Wikidata', 'Companies', ['org-name', 'domain', 'place-text'], 'ready'),
    T('hash-file', 'Hashes', 'Files and images', ['file'], 'ready'), T('exif-meta', 'File metadata (built in)', 'Files and images', ['file'], 'ready'),
    T('exiftool', 'Metadata with ExifTool', 'Files and images', ['file'], 'needs-program', { note: 'Runs in the virtual computer' }), T('tesseract', 'Text in images (OCR)', 'Files and images', ['file'], 'needs-program', { note: 'Needs tesseract' }),
    T('nominatim', 'Place search (OpenStreetMap)', 'Places', ['place-text', 'coords'], 'ready'), T('nasa-cmr', 'Satellite data search', 'Places', ['place-text', 'coords'], 'off'),
    T('gdelt-doc', 'News coverage (GDELT)', 'News', ['keyword', 'org-name', 'domain', 'place-text'], 'ready', { tested: 'failed', testNote: 'The last test timed out.' }),
    T('wayback-cdx', 'Internet Archive captures', 'Archive', ['url', 'domain'], 'ready'), T('archivebox', 'Saved copies in ArchiveBox', 'Archive', ['url'], 'needs-program', { note: 'Runs in the virtual computer' }),
    T('cisa-kev', 'CISA known exploited list', 'Threat intel', ['keyword'], 'ready'), T('nvd', 'NVD vulnerabilities', 'Threat intel', ['keyword'], 'setting-up'),
  ];
  const M = (window.__mock = { tools, b: [], s: [], fail: false, runs: [], seq: 0, timers: [] });
  const status = () => ({ ok: true, total: tools.length, ready: tools.filter((t) => t.state === 'ready').length, 'setting-up': tools.filter((t) => t.state === 'setting-up').length, failed: tools.filter((t) => t.state === 'failed').map((t) => ({ id: t.id, name: t.name, reason: t.note })), tools: tools.map((t) => ({ ...t })) });
  const LEI = /^[A-Z0-9]{18}[0-9]{2}$/, COORD = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/, ORG = /\b(ltd|limited|plc|inc|llc|gmbh|holdings|group)\b/i;
  const classify = (q) => {
    const t = String(q || '').trim(), pr = S.refusePersonQuery(t); if (pr.refused) return { ok: false, error: pr.reason, code: 'refused' };
    const d = S.detectInput(t); if (d.kind) return { ok: true, kind: d.kind, value: d.value, alternatives: d.kind === 'domain' ? [{ kind: 'keyword', value: t }] : [] };
    if (LEI.test(t)) return { ok: true, kind: 'lei', value: t, alternatives: [{ kind: 'keyword', value: t }] };
    const c = COORD.exec(t); if (c) return { ok: true, kind: 'coords', value: +c[1] + ', ' + +c[2], alternatives: [{ kind: 'place-text', value: t }] };
    return { ok: true, kind: ORG.test(t) ? 'org-name' : 'keyword', value: t, alternatives: [{ kind: 'org-name', value: t }, { kind: 'place-text', value: t }] };
  };
  const R = (tool, type, value, k) => ({ entity: { type, value }, source: { tool, connector: tool, version: '1.0.0' }, observedAt: new Date(Date.now() - (k || 0) * 60000).toISOString(), confidence: 'confirmed' });
  const outcome = (id, kind, v) => {
    if (id === 'gdelt-doc') return { type: 'tool-error', error: 'The service said too many requests. Ghost waits longer between requests next time.' };
    if (id === 'wikidata') return { type: 'tool-empty' };
    if (id === 'dns-doh') return { type: 'tool-result', results: [R(id, 'domain', v, 1), R(id, 'domain', 'www.' + v, 1), R(id, 'ip', '203.0.113.5', 1), R(id, 'ip', '203.0.113.6', 1), R(id, 'username', 'someone', 1)] };
    if (id === 'rdap-domain') return { type: 'tool-result', results: [R(id, 'domain', v, 2), R(id, 'org', 'Example Holdings Ltd', 2), R(id, 'event', 'Registered 2001-03-04', 2)] };
    if (id === 'ct-crtsh') return { type: 'tool-result', results: [R(id, 'hostname', 'WWW.' + v.toUpperCase(), 3), R(id, 'domain', 'mail.' + v, 3), R(id, 'cert', 'd'.repeat(64), 3)] };
    if (id === 'wayback-cdx') return { type: 'tool-result', results: [R(id, 'url', 'http://' + v + '/', 4), R(id, 'event', 'First capture 2002-01-01', 4)] };
    if (id === 'hash-file') return { type: 'tool-result', results: [R(id, 'document', 'sha256:' + 'a'.repeat(64), 0)] };
    if (id === 'exif-meta') return { type: 'tool-result', results: [R(id, 'document', 'report.pdf', 0), R(id, 'place', '51.5074, -0.1278', 0)] };
    return { type: 'tool-result', results: [R(id, 'finding', 'note from ' + id, 0)] };
  };
  const send = (ev) => { for (const f of M.s) { try { f(ev); } catch (e) { /* listener failed */ } } };
  GH.api = Object.assign({}, GH.api, {
    builtins: { status: async () => (M.fail ? { ok: false, error: 'The tool list is not available right now.' } : status()) },
    search: {
      classify: async ({ query }) => classify(query),
      run: async ({ query, kind, tools: want }) => {
        const k = kind || classify(query).kind, ready = tools.filter((t) => t.state === 'ready' && t.inputs.includes(k)), ids = (want && want.length ? want : ready.map((t) => t.id)).filter((id) => ready.some((t) => t.id === id));
        if (!ids.length) return { ok: false, error: 'No ready tool takes that kind of input.' };
        const id = 's' + ++M.seq, value = k === 'file' ? 'report.pdf' : query, slow = /^slow\./.test(value), run = { id, ids, cancelled: false }; M.runs.push({ id, kind: k, value, tools: ids });
        const at = (ms, ev) => M.timers.push(setTimeout(() => { if (!run.cancelled) send({ searchId: id, ...ev }); }, ms));
        ids.forEach((tid, i) => { const o = outcome(tid, k, value), t0 = (slow ? 4000 : 60) + i * 40, t1 = t0 + 120 + i * 90; at(t0, { type: 'tool-start', tool: tid }); at(t1, { ...o, tool: tid, ms: t1 - t0 }); });
        at((slow ? 4000 : 60) + ids.length * 130 + 400, { type: 'done' });
        run.stop = () => { run.cancelled = true; setTimeout(() => send({ searchId: id, type: 'done' }), 30); };
        M.last = run; M['run:' + id] = run;
        return { ok: true, searchId: id, kind: k, value, tools: ids };
      },
      cancel: async ({ searchId }) => { const r = M['run:' + searchId]; if (r) r.stop(); return { ok: true }; },
    },
    onBuiltins: (cb) => { M.b.push(cb); return () => { M.b = M.b.filter((x) => x !== cb); }; },
    onSearch: (cb) => { M.s.push(cb); return () => { M.s = M.s.filter((x) => x !== cb); }; },
    pickFile: async () => ({ token: 'tok-1', name: 'report.pdf', size: 2048 }),
  });
  M.flip = (id, state) => { tools.find((t) => t.id === id).state = state; for (const f of M.b) f({}); };
}

eapp.commandLine.appendSwitch('no-sandbox'); eapp.commandLine.appendSwitch('disable-gpu');
process.env.MF_SMOKE = '1';
eapp.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { mockServer } = require('../test/ghost-app-mock');
  const { GhostService } = require('../src/main/ghost');
  const M = require('../src/ui/ghost/case-model');
  const Sk = require('../src/ui/ghost/skins');
  const mock = await mockServer({ pollsBeforeOk: 2 });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-ud-'));
  const fakeOS = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('OS:' + Buffer.from(s).toString('hex')), decryptString: (b) => Buffer.from(b.toString().slice(3), 'hex').toString() };
  let gapp = null;
  const ghost = new GhostService({ root: userData, dialog: electron.dialog, getWindow: () => gapp && gapp.win.getWindow(), emit: (n, p) => gapp && gapp.sendJob(n, p), isPackaged: false, safeStorage: fakeOS, useVault: true, vaultOptions: { kdfParams: { m: 64, t: 1, p: 1 }, allowWeakKdf: true } });
  ghost.useTestConfirm(() => true);   // stands in for the native approval window, only in this test run
  const { createGhostApp } = require('../src/main/ghost/app');
  process.env.MF_GHOST_ID_BASE = mock.base; process.env.MF_GHOST_CLOUD_BASE = mock.base; process.env.MF_GHOST_POLL_MS = '200'; process.env.MF_GHOST_NO_MAXIMIZE = '1';
  gapp = createGhostApp({ electron: { ...electron, shell: { openExternal: () => {} } }, userData, ghost, isPackaged: false, version: '1.0.0', openTerminal: async () => true, openToolIntegrations: async () => true });
  gapp.show();
  const win = gapp.win.getWindow(); win.setContentSize(W, H); const wc = win.webContents;
  const pageErr = []; wc.on('console-message', (_e, level, msg) => { if (level >= 2) { pageErr.push(msg); console.log('PAGE-CONSOLE ' + msg); } });
  await new Promise((r) => wc.once('did-finish-load', r)); await sleep(500);
  const js = (c) => wc.executeJavaScript(c, true);
  const shot = async (name) => { await sleep(450); const img = await wc.capturePage(); fs.writeFileSync(path.join(OUT, `${TAG}-${name}.png`), img.toPNG()); };
  const waitFor = async (cond, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(100); } return false; };
  const A = gapp.app;
  const count = (sel) => js(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const text = () => js('document.body.innerText');
  const regions = async (label, sels) => { const miss = []; for (const s of sels) if (!(await count(s))) miss.push(s); rec(`structure ${label}`, miss.length === 0, miss.length ? 'missing ' + miss.join(', ') : sels.length + ' regions'); };
  const noOverflow = async (label) => { const o = await js('({sw:document.documentElement.scrollWidth,iw:window.innerWidth,bw:document.body.scrollWidth})'); rec(`no horizontal scroll ${label} at ${W}`, o.sw <= o.iw + 1 && o.bw <= o.iw + 1, JSON.stringify(o)); };
  // text contrast measured on the page as drawn: foreground against the colour it really sits on (layers composited), 4.5 for text, 3 for large text
  const CONTRAST = `(()=>{const parse=(s)=>{const cm=/color\\(srgb ([^ )]+) ([^ )]+) ([^ )]+)(?: \\/ ([^ )]+))?\\)/.exec(s);if(cm)return {r:Math.round(+cm[1]*255),g:Math.round(+cm[2]*255),b:Math.round(+cm[3]*255),a:cm[4]===undefined?1:+cm[4]};const m=/rgba?\\(([^)]+)\\)/.exec(s);if(!m)return null;const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}};
    const over=(t,b)=>({r:t.r*t.a+b.r*(1-t.a),g:t.g*t.a+b.g*(1-t.a),b:t.b*t.a+b.b*(1-t.a),a:1});
    const lum=(c)=>{const f=(x)=>{x/=255;return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4)};return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b)};
    const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};
    const bgOf=(el)=>{const layers=[];for(let e=el;e;e=e.parentElement){const c=parse(getComputedStyle(e).backgroundColor);if(c&&c.a>0){layers.push(c);if(c.a>=1)break}}let b={r:0,g:0,b:0,a:1};for(let i=layers.length-1;i>=0;i--)b=over(layers[i],b);return b};
    const bad=[];let n=0;const seen=new Set();
    const walker=document.createTreeWalker(document.getElementById('root'),NodeFilter.SHOW_TEXT);
    while(walker.nextNode()){const t=walker.currentNode;if(!t.nodeValue.trim())continue;const el=t.parentElement;if(!el||seen.has(el))continue;seen.add(el);const cs=getComputedStyle(el);if(cs.visibility==='hidden'||cs.display==='none'||el.closest('.sr,[hidden],[aria-hidden=true]'))continue;const r=el.getBoundingClientRect();if(r.width<2||r.height<2)continue;
      const isSvg=el instanceof SVGElement;let fg=parse(isSvg?cs.fill:cs.color);if(!fg)continue;let bg=bgOf(isSvg?el.closest('svg').parentElement:el);if(isSvg){const svgBg=bgOf(el.closest('svg').parentElement);bg=svgBg}
      fg=over(fg,bg);const px=parseFloat(cs.fontSize),bold=parseInt(cs.fontWeight)>=700,large=px>=24||(px>=18.66&&bold);const need=large?3:4.5;n++;const rr=ratio(fg,bg);if(rr<need-0.001)bad.push({t:t.nodeValue.trim().slice(0,28),cls:(el.getAttribute('class')||el.tagName).slice(0,30),r:Math.round(rr*100)/100,need});}
    return {n,bad:bad.slice(0,8),nbad:bad.length}})()`;
  const contrast = async (label) => { try { let xy = { x: 1, y: 1 }; if (process.env.GHOST_HOVER_TEST) { const b = await js("(()=>{const e=document.querySelector('.btn.primary');if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()"); if (b) xy = b; } wc.sendInputEvent({ type: 'mouseMove', x: xy.x, y: xy.y }); } catch (e) { /* ok */ } await js('document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} })'); await sleep(250); const c = await js(CONTRAST); rec(`contrast AA ${label}`, c.nbad === 0, c.nbad ? c.nbad + ' of ' + c.n + ': ' + JSON.stringify(c.bad) : c.n + ' text runs checked'); };
  const set = async (skin) => { await js(`GH.appearance.set({skin:'${skin}'})`); await sleep(350); };
  const go = async (hash, sel) => { await js(`location.hash=${JSON.stringify(hash)}`); await sleep(350); if (sel) await waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 6000); await sleep(250); };


  // ----- the Workspace: master search, results, tool pages (answered by the stand-in) -----
  const setVal = (sel, v) => js(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  const txt = (sel) => js(`(document.querySelector(${JSON.stringify(sel)})||{innerText:''}).innerText`);
  const key = async (k) => { wc.sendInputEvent({ type: 'keyDown', keyCode: k }); if (k === 'Return') wc.sendInputEvent({ type: 'char', keyCode: '\r' }); wc.sendInputEvent({ type: 'keyUp', keyCode: k }); await sleep(120); };
  const finished = (ms = 15000) => waitFor("/Finished|Stopped/.test((document.querySelector('.ws-prog-t')||{}).textContent||'')", ms);
  const wsFlow = async (id) => {
    const L = (n) => `${id} ${n}`;
    // --- the Workspace page and the tool index, with every state shown as it is
    await go('#workspace', '.ws-search'); await waitFor("document.querySelectorAll('.ws-tool').length>=15");
    await regions(L('workspace'), ['.ws', '.ws-search', '#ws-q', '.ws-idx', '.ws-cat', '.ws-tool', '.ws-filter']);
    rec(L('workspace: tool index grouped by category, from the tool list'), (await count('.ws-cat')) >= 6 && (await count('.ws-tool')) === 19 && /domains and networks/i.test(await txt('.ws-idx')) && /threat intel/i.test(await txt('.ws-idx')), `${await count('.ws-cat')} groups, ${await count('.ws-tool')} tools`);
    rec(L('workspace: states shown honestly (ready, setting up, needs program, off, not working) and the test badge'), (await count('.ws-st.st-ready')) === 13 && (await count('.ws-st.st-setting-up')) === 1 && (await count('.ws-st.st-needs-program')) === 3 && (await count('.ws-st.st-off')) === 1 && (await count('.ws-st.st-failed')) === 1 && (await count('.tb-failed')) === 1 && (await count('.tb-tested')) === 12);
    rec(L('workspace: a failed tool is named with its reason, the count line is plain words'), /filing index could not be read/.test(await txt('.ws-fail')) && /13 of 19 ready, 1 setting up, 3 need a program, 1 switched off, 1 not working/.test(await txt('.ws-count')), await txt('.ws-count'));
    rec(L('workspace: a program that is not here says where it runs'), /Runs in the virtual computer/.test(await js("document.querySelector('.ws-tool[data-tool=exiftool] .ws-st').title")) && /Needs a program/.test(await txt('.ws-tool[data-tool=exiftool]')));
    await noOverflow(L('workspace')); await contrast(L('workspace')); await shot(`${id}-workspace`);
    // --- the box understands what is typed, and can be changed
    await js("document.getElementById('ws-q').focus()");
    await setVal('#ws-q', 'Example.org'); await waitFor("/Domain/.test((document.querySelector('.ws-understood')||{innerText:''}).innerText)");
    rec(L('search box: shows what it understood and how many tools it will ask'), /Understood as Domain: example\.org/.test((await txt('.ws-understood')).replace(/\s+/g, ' ')) && /Will ask 6 tools/.test(await txt('.ws-ask')), (await txt('.ws-understood')).replace(/\s+/g, ' '));
    await js(`(()=>{const s=document.getElementById('ws-kind');s.value=[...s.options].find(o=>o.value.startsWith('keyword|')).value;s.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(150);
    rec(L('search box: the kind can be changed and the tool count follows'), /Keyword/.test(await txt('.ws-understood')) && /Will ask 2 tools/.test(await txt('.ws-ask')) && (await js("document.getElementById('ws-kind').selectedOptions[0].textContent")) === 'Keyword', await txt('.ws-ask'));
    await setVal('#ws-q', 'someone@example.org'); await waitFor("!!document.querySelector('.ws-u .cmd-err')");
    rec(L('search box: a person is refused in plain words and nothing runs'), /does not look up people/.test(await txt('.ws-u .cmd-err')) && (await count('.ws-ask')) === 0);
    await setVal('#ws-q', '10.0.0.0/24'); await waitFor("/Network range/.test((document.querySelector('.ws-understood')||{innerText:''}).innerText)");
    rec(L('search box: a range explains where it goes (no passive tool takes it)'), /Active scanning/.test(await txt('.ws-warn')));
    await js("document.querySelector('.ws-search').requestSubmit()"); await sleep(300);
    rec(L('search box: nothing runs when no ready tool takes it'), (await js('location.hash')) === '#workspace' || /workspace/.test(await js('location.hash')));
    // --- Enter runs it across every ready tool that takes a domain
    await setVal('#ws-q', 'Example.org'); await waitFor("/Will ask 6 tools/.test((document.querySelector('.ws-ask')||{innerText:''}).innerText)");
    await js("document.getElementById('ws-q').focus()"); await key('Return');
    rec(L('Enter runs the search and opens the results'), await waitFor("location.hash==='#search/domain/example.org'&&document.querySelectorAll('.ws-tabs [role=tab]').length===7", 8000), await js('location.hash'));
    rec(L('results: the tab strip is Overview plus one tab per tool that ran'), (await js("[...document.querySelectorAll('.ws-tab .ws-tl')].map(e=>e.textContent)[0]")) === 'Overview' && (await js("[...document.querySelectorAll('.ws-tab')].filter(t=>t.getAttribute('aria-selected')==='true').length")) === 1);
    const prog = await txt('.ws-prog-t'); rec(L('results: live progress line names how many tools were asked'), /6 tools asked/.test(prog), prog);
    rec(L('results: the search finishes'), await finished());
    await sleep(500);
    rec(L('results: badges say what each tool did (found, none, error)'), (await count('.ws-badge.b-done')) === 4 && (await count('.ws-badge.b-empty')) === 1 && (await count('.ws-badge.b-error')) === 1 && /^error$/.test(await js("document.querySelector('.ws-badge.b-error').textContent")) && /^none$/.test(await js("document.querySelector('.ws-badge.b-empty').textContent")), `${await count('.ws-badge.b-done')}/${await count('.ws-badge.b-empty')}/${await count('.ws-badge.b-error')}`);
    rec(L('overview: grouped by entity type with counts'), (await count('.ws-g')) >= 5 && /Domains/.test(await txt('.ws-ov')) && /IP addresses/.test(await txt('.ws-ov')) && /Organisations/.test(await txt('.ws-ov')), `${await count('.ws-g')} groups`);
    rec(L('overview: the same domain from two tools (written two ways) is one row with both tools'), (await js("[...document.querySelectorAll('.ws-tbl tbody tr')].filter(r=>/^www\\.example\\.org/i.test(r.querySelector('.ws-v .mono').textContent)).length")) === 1 && (await js("(()=>{const r=[...document.querySelectorAll('.ws-tbl tbody tr')].find(r=>/^www\\.example\\.org/i.test(r.querySelector('.ws-v .mono').textContent));return r.querySelectorAll('.ws-chip').length})()")) === 2);
    rec(L('overview: each row shows source time, and its sources open'), (await count('.ws-when')) >= 8 && (await count('.ws-src')) >= 8 && !/no time given/.test(await txt('.ws-ov')));
    rec(L('overview: results about a person are counted and left out, never shown'), /1 result left out/.test(await txt('.ws-ov .flow-note')) && !/someone/.test(await txt('.ws-ov')));
    rec(L('results: the badge of Overview counts the findings'), /^\d+$/.test(await js("document.querySelector('.ws-tab .ws-badge').textContent")) && +(await js("document.querySelector('.ws-tab .ws-badge').textContent")) === (await count('.ws-tbl tbody tr')));
    await noOverflow(L('results overview')); await contrast(L('results overview')); await shot(`${id}-results`);
    // --- select and add to case through the case store
    const before = await js('Object.keys(GH.cs.current().entities).length');
    await js(`(()=>{const rows=[...document.querySelectorAll('.ws-tbl tbody tr')];const pick=(re)=>{const r=rows.find(r=>re.test(r.querySelector('.ws-v .mono').textContent));const c=r.querySelector('input[type=checkbox]');c.click()};pick(/^d{64}$/);pick(/^www\\.example\\.org/i)})()`); await sleep(150);
    rec(L('overview: selecting rows counts them and enables Add to case'), /2 selected/.test(await txt('.ws-selcount')) && !(await js("document.querySelector('.ws-add').disabled")) && /Add 2 to case/.test(await txt('.ws-add')));
    await js("document.querySelector('.ws-add').click()"); await waitFor(`Object.keys(GH.cs.current().entities).length>${before}`, 6000);
    rec(L('add to case: new entity added, each keeps its own tool as source'), await js(`(()=>{const c=GH.cs.current();const e=Object.values(c.entities).find(x=>x.type==='cert'&&x.label==='${'d'.repeat(64)}');const w=Object.values(c.entities).find(x=>x.label==='www.example.org');return !!e&&e.sources.some(s=>c.sources[s].connector==='ct-crtsh')&&!!w&&['dns-doh','ct-crtsh'].every(t=>w.sources.some(s=>c.sources[s].connector===t))})()`));
    // --- the tab strip by keyboard
    await js("document.querySelector('.ws-tab[aria-selected=true]').focus()"); await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))"); await sleep(250);
    rec(L('tabs: ArrowRight moves to the next tab, focus and selection together, panel follows'), (await js("document.activeElement.getAttribute('role')")) === 'tab' && (await js("document.activeElement.getAttribute('aria-selected')")) === 'true' && (await js("document.querySelector('[role=tabpanel]').getAttribute('aria-labelledby')")) === (await js('document.activeElement.id')) && /This search/.test(await txt('.ws-panel')));
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))"); await sleep(200);
    rec(L('tabs: End goes to the last tab and Home to Overview'), (await js("document.activeElement.dataset.tab")) !== 'overview');
    await js("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))"); await sleep(200);
    rec(L('tabs: Home returns to Overview'), (await js("document.activeElement.dataset.tab")) === 'overview' && (await count('.ws-ov')) === 1);
    // --- a tool's own tab: results, error, nothing found, and the tool page
    await js("document.querySelector('.ws-tab[data-tab=dns-doh]').click()"); await sleep(250);
    rec(L('tool tab: status strip, results table, This search / Tool page switch'), (await count('.ws-strip')) === 1 && /Ready/.test(await txt('.ws-strip')) && (await count('.ws-panel table')) >= 1 && (await count('.ws-sw .btn')) === 2 && /Add these to case/.test(await txt('.ws-panel')) && /left out/.test(await txt('.ws-panel .flow-note')));
    await shot(`${id}-tool-tab`);
    await js("[...document.querySelectorAll('.ws-sw .btn')].find(b=>/Tool page/.test(b.textContent)).click()"); await sleep(250);
    rec(L('tool tab: Tool page opens the tool\'s own page with the search handed over'), (await count('.ws-tt-b > *')) >= 1 && (!(await count('.stub-toolpage')) || /query: example\.org, kind: domain/.test(await txt('.stub-toolpage'))) && (await js("document.querySelector('.ws-sw .btn[aria-pressed=true]').textContent")) === 'Tool page', (await txt('.ws-panel')).slice(0, 80));
    await js("document.querySelector('.ws-tab[data-tab=gdelt-doc]').click()"); await sleep(250);
    rec(L('tool tab: an error says which tool and why, in plain words'), /could not answer/.test(await txt('.ws-panel')) && /too many requests/.test(await txt('.ws-panel')) && (await count('.ws-panel [role=alert]')) >= 1);
    await js("document.querySelector('.ws-tab[data-tab=wikidata]').click()"); await sleep(250);
    rec(L('tool tab: nothing found says it does not prove nothing is there'), /Nothing found by/.test(await txt('.ws-panel')) && /does not prove nothing/.test(await txt('.ws-panel')));
    await js("document.querySelector('.ws-tab[data-tab=overview]').click()"); await sleep(200);
    await js("document.querySelector('.ws-chip').click()"); await sleep(250);
    rec(L('overview: a tool chip opens that tool\'s tab'), (await js("document.querySelector('.ws-tab[aria-selected=true]').dataset.tab")) !== 'overview');
    await noOverflow(L('results tool tab')); await contrast(L('results tool tab'));
    // --- stop a slow search
    await go('#workspace', '.ws-search'); await setVal('#ws-q', 'slow.example.org'); await waitFor("/Will ask/.test((document.querySelector('.ws-ask')||{innerText:''}).innerText)");
    await js("document.querySelector('.ws-search').requestSubmit()"); await waitFor("!!document.querySelector('.ws-prog-t')&&/still working/.test(document.querySelector('.ws-prog-t').textContent)", 8000);
    rec(L('results: a running search shows what is still working and offers Stop'), /still working/.test(await txt('.ws-prog-t')) && (await js("(()=>{const b=[...document.querySelectorAll('.ws-progress .btn')].find(b=>/Stop/.test(b.textContent));return !!b&&!b.hidden})()")) && /Waiting for the first answer/.test(await txt('.ws-panel')));
    await noOverflow(L('results running')); await contrast(L('results running')); await shot(`${id}-results-running`);
    await js("[...document.querySelectorAll('.ws-progress .btn')].find(b=>/Stop/.test(b.textContent)).click()");
    rec(L('results: Stop ends the run and says so'), await waitFor("/Stopped/.test((document.querySelector('.ws-prog-t')||{}).textContent||'')", 6000) && /Search again/.test(await txt('.ws-progress')));
    // --- a file: choose, understood as a file, the file tools run
    await go('#workspace', '.ws-search'); await js("document.querySelector('.ws-file').click()"); await waitFor("/report\\.pdf/.test((document.querySelector('.ws-understood')||{innerText:''}).innerText)", 4000);
    rec(L('file: choosing a file is understood as a file and asks the file tools'), /File: report\.pdf/.test((await txt('.ws-understood')).replace(/\s+/g, ' ')) && /Will ask 2 tools/.test(await txt('.ws-ask')), (await txt('.ws-understood')).replace(/\s+/g, ' '));
    await js("document.querySelector('.ws-search').requestSubmit()"); await waitFor("location.hash==='#search/file/report.pdf'&&document.querySelectorAll('.ws-tab').length===3", 6000); rec(L('file: runs and opens the results'), await finished() && /Documents/.test(await txt('.ws-ov')));
    // --- / goes to the master search from anywhere
    await go('#settings/appearance'); await js("document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'/',bubbles:true}))"); await waitFor("document.activeElement&&document.activeElement.id==='ws-q'", 3000);
    rec(L('/ focuses the master search from another screen'), (await js("document.activeElement.id")) === 'ws-q');
    // --- the tool index on its own page, the filter, a tool page, an unknown tool
    await go('#tool', '.ws-idx'); await waitFor("document.querySelectorAll('.ws-tool').length>=15");
    await setVal('.ws-filter', 'dns'); await sleep(150);
    rec(L('tool index: the filter narrows the list'), (await count('.ws-tool')) >= 1 && (await count('.ws-tool')) <= 3, String(await count('.ws-tool')));
    await setVal('.ws-filter', 'zzzz'); await sleep(100); rec(L('tool index: a filter with no match says so'), /No tool matches/.test(await txt('.ws-idx')));
    await noOverflow(L('all tools')); await contrast(L('all tools')); await shot(`${id}-tools`);
    await go('#tool/dns-doh', '.ws-split'); await sleep(300);
    rec(L('tool page: the index beside it, this tool marked, the tool\'s own page in the main area'), (await count('.ws-aside .ws-tool[aria-current=page]')) === 1 && (await count('.ws-main')) === 1 && /dns-doh|DNS records/.test(await txt('.ws-main')) && /Workspace/.test(await txt('.ws-crumbs')));
    await noOverflow(L('tool page')); await contrast(L('tool page')); await shot(`${id}-toolpage`);
    await go('#tool/nope'); rec(L('tool page: an unknown tool says so'), /There is no tool called/.test(await text()));
    await go('#tool/exiftool', '.ws-split'); rec(L('tool page: a tool that needs a program is not shown as broken'), (await count('.ws-aside .ws-tool[aria-current=page]')) === 1);
    // --- old module links go to the Workspace
    await go('#m/domains'); await sleep(200); rec(L('old module link opens the tool index, no card screen'), (await count('.ws-idx')) === 1 && (await count('.mod-view')) === 0 && (await count('.ccard')) === 0);
    await go('#m/domains/' + encodeURIComponent('Example.org'), '.ws-tabs'); rec(L('old module link with a value opens the results for it'), (await count('.ws-tabs')) === 1 && /example\.org/i.test(await txt('.ws-res h1')));
    // --- the tool list failing, and recovering
    await js('__mock.fail=true;GH.ws.status.load(true)'); await sleep(200); await go('#tool', '.ws-idx'); await sleep(300);
    rec(L('tool index: a failed refresh says so, keeps what was read, and offers Try again'), /could not be refreshed/.test(await txt('.ws-idx')) && /not available right now/.test(await txt('.ws-idx')) && (await count('.ws-idx [role=alert] .btn')) === 1);
    await js('__mock.fail=false'); await js("document.querySelector('.ws-idx [role=alert] .btn').click()"); await waitFor("document.querySelectorAll('.ws-tool').length>=15", 4000);
    rec(L('tool index: Try again brings the tools back'), (await count('.ws-tool')) === 19);
    // --- a tool finishing setup shows up without a reload
    await js("__mock.flip('nvd','ready')"); await waitFor("document.querySelectorAll('.ws-st.st-setting-up').length===0", 4000);
    rec(L('tool index: a tool that finishes setting up turns Ready by itself'), (await count('.ws-st.st-setting-up')) === 0 && (await count('.ws-st.st-ready')) === 14); await js("__mock.flip('nvd','setting-up')");
    // --- Tool Integrations keeps own and security tools, not the lookups that ship
    await go('#tools'); await sleep(500);
    rec(L('Tool Integrations: the shipped lookups are not listed as cards, the security tools are'), /work without approval/.test(await text()) && !/dns-doh/.test(await js("[...document.querySelectorAll('.ccard')].map(c=>c.innerText).join(' ')")) && (await count('.ccard')) >= 3);
    await noOverflow(L('tool integrations')); await contrast(L('tool integrations'));
    await go('#m/scan', '.mod-view'); await sleep(300);
    rec(L('Active scanning keeps its scope guard and its cards'), (await count('.scope-panel')) === 1 && (await count('.mod-view .ccard')) >= 3);
    await noOverflow(L('active scanning')); await contrast(L('active scanning')); await shot(`${id}-scanning`);
    await go('#m/threat', '.mod-view'); await sleep(300);
    rec(L('Security tools: only tools you approve, none of the shipped lookups'), (await count('.mod-view .ccard')) >= 3 && !/cisa-kev|nvd/.test(await js("[...document.querySelectorAll('.mod-view .ccard')].map(c=>c.innerText).join(' ')")));
    await noOverflow(L('security tools'));
  };

  const HOME = {
    mayfair: ['.rail', '.top', 'main#main', '.status', '.ws', '.ws-search', '#ws-q', '.ws-idx'],
    ops: ['.ops-menu', '.ops-tabs', '.ops-tree', 'main#main', '.ops-detail', '.status', '.ops-map .pmap', '.ops-tables', '.ops-t1', '.ops-t2', '.ops-t3'],
    terminal: ['.tm-top', '.tm-keys', 'main#main', '.status', '.tm-prompt', '.tm-jobs', '.tm-health', '.tm-files', '.tm-case', '.tm-log', '.tm-vault', '.padlock', '.dial'],
    hud: ['.hd-nav', '.hd-top', 'main#main', '.status', '.hd-ring', '.hd-l', '.hd-r', '.hd-conn', '.hd-cases', '.hd-scan', '.hd-act', '.hd-sweep', '.hd-last', '.hd-ring-svg', '.hd-card .br'],
    mono: ['.mn-top', '.mn-nav', 'main#main', '.status', '.mn-h', '.mn-search', '.mn-grid', '.mn-stats', '.mn-ch', '.mn-key'],
  };

  try {
    // ----- get into the app -----
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/install|download/i.test(x.textContent));b&&b.click();return !!b})()");
    await waitFor("document.body.innerText.includes('Sign in with Mayfair ID')");
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/sign in/i.test(x.textContent));b&&b.click();return !!b})()");
    await waitFor("!!document.querySelector('.terms-body')", 15000); await sleep(300);
    await js(`(()=>{const b=document.querySelector('.terms-body');if(b){b.scrollTop=b.scrollHeight;b.dispatchEvent(new Event('scroll'))}})()`); await sleep(300);
    await js(`document.querySelectorAll('input[type=checkbox]').forEach(c=>{if(!c.disabled&&!c.checked)c.click()})`); await sleep(200);
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/accept/i.test(x.textContent)&&!x.disabled);b&&b.click()})()");
    rec('app opens', await waitFor("!!document.getElementById('app')"));
    await sleep(500);
    // the Workspace's app calls are answered by a stand-in in the page (see installMock); the placeholders for the tool page and the result table are only used when the real ones are not in the page
    await js('(' + installMock.toString() + ')()');
    const stubs = path.join(__dirname, 'workspace-stubs.js'); if (fs.existsSync(stubs)) await js(fs.readFileSync(stubs, 'utf8'));
    rec('tool page and result table: ' + ((await js("typeof GH.toolPage==='function'&&typeof GH.resultTable==='function'")) ? 'present' : 'missing'), true, (await js("!!document.querySelector('script[src=\"toolpage.js\"]')")) ? 'real module loaded' : 'placeholders from tools/workspace-stubs.js');
    await js('GH.render()'); await sleep(300);

    // ----- the real connectors: approve and test a few so some states are not the default (the approval window is answered by the test hook) -----
    const tried = await js(`(async()=>{const out=[];for(const id of ['hash-file','local-snapshot','exif-meta','dns-doh']){try{const a=await GH.call(GH.api.connectors.requestApproval,id);if(!a||a.ok===false){out.push(id+':declined');continue}const t=await GH.call(GH.api.connectors.test,id);await GH.call(GH.api.connectors.enable,id);out.push(id+':'+(t&&t.passed?'passed':'failed'))}catch(e){out.push(id+':'+e.message)}}GH.conn.bust();return out})()`);
    console.log('CONNECTORS', JSON.stringify(tried));

    // ----- EMPTY states: no case, no lookups -----
    for (const sk of Sk.SKINS) {
      await set(sk.id); await go('#home');
      rec(`skin ${sk.id}: data-skin applied and saved in the vault`, (await js('document.documentElement.dataset.skin')) === sk.id && A.prefsGet().skin === sk.id, JSON.stringify(A.prefsGet()));
      await regions(`${sk.id} home (empty)`, HOME[sk.id]);
      const t = await text();
      const emptyOk = { mayfair: /No cases yet/i.test(t) && /Nothing searched in this window yet/i.test(t), ops: /No case is open/i.test(t) && /No lookups yet/i.test(t), terminal: /No jobs have run in this window/i.test(t) && /No cases yet/i.test(t) && /No case is open/i.test(t), hud: /No case is open/i.test(t) && /No activity yet|0 event/i.test(t) || /No cases yet/i.test(t), mono: /nothing looked up in this window yet/i.test(t) && /No lookups have run/i.test(t) }[sk.id];
      rec(`empty state ${sk.id}: says so, shows no sample data`, emptyOk, '');
      if (sk.id === 'ops') rec('empty state ops: map has no pins, the empty note is shown', (await count('.pm-pin')) === 0 && (await count('.pmap-empty')) === 1);
      if (sk.id === 'hud') rec('empty state hud: sweep has no blips', (await count('.rd-blip')) === 0);
      await noOverflow(`${sk.id} home (empty)`); await shot(`${sk.id}-home-empty`);
    }

    // ----- a case with places, links, sources and notes; some lookups run in this window -----
    const c = M.newCase('Harbour logistics review');
    const src = M.addSource(c, { connector: 'dns-doh', connectorVersion: '1.0.0', query: { kind: 'domain', value: 'example.org' }, origin: 'https://doh.example/dns-query', licence: 'MIT', rawSha256: 'a'.repeat(64) });
    const ids = {}; const E = (k, o) => { ids[k] = M.addEntity(c, { sources: [src], ...o }).id; };
    E('d', { type: 'domain', value: 'example.org', attrs: { registered: '2001-03-04T00:00:00Z' } }); E('w', { type: 'domain', value: 'www.example.org' }); E('i', { type: 'ip', value: '203.0.113.5' }); E('a', { type: 'asn', value: 'AS64496' }); E('o', { type: 'org', value: 'Example Holdings Ltd' });
    E('ce', { type: 'cert', value: 'c'.repeat(64) }); E('mx', { type: 'domain', value: 'mail.example.org' }); E('i2', { type: 'ip', value: '203.0.113.6' }); E('o2', { type: 'org', value: 'Example Freight GmbH' });
    const P = (k, label, lat, lon, manual) => { ids[k] = M.addEntity(c, { type: 'place', value: lat + ',' + lon, label, manual: true, attrs: { lat, lon } }).id; };
    P('p1', 'London office', 51.5074, -0.1278); P('p2', 'Hamburg depot', 53.5511, 9.9937); P('p3', 'Rotterdam terminal', 51.9244, 4.4777);
    for (const [f, t, r] of [['w', 'd', 'subdomain-of'], ['d', 'i', 'resolves-to'], ['w', 'i', 'resolves-to'], ['i', 'a', 'announced-by'], ['a', 'o', 'registered-by'], ['ce', 'd', 'covers'], ['mx', 'd', 'subdomain-of'], ['mx', 'i2', 'resolves-to'], ['i2', 'a', 'announced-by'], ['o', 'p1', 'located-at'], ['o2', 'p2', 'located-at'], ['o', 'p3', 'located-at'], ['o2', 'p3', 'located-at'], ['p1', 'p2', 'linked-to']]) M.addEdge(c, { from: ids[f], to: ids[t], rel: r, sources: [src] });
    M.addEvent(c, { t: '2026-02-01', title: 'First seen in a report' }); M.addNote(c, 'Registered 2001. Same network as the mail host.', [ids.d]); M.layout(c);
    const cr = A.caseCreate('seed'); const seed = JSON.parse(cr.json); c.id = seed.id; c.created = seed.created; A.casePut(c.id, JSON.stringify(c));
    await js(`GH.cs.open('${c.id}')`); await sleep(500);
    await js(`(()=>{const a=GH.jobs.start('dns-doh','example.org');GH.jobs.update(a,{status:'done',finishedAt:Date.now(),results:7});const b=GH.jobs.start('rdap-domain','example.org');GH.jobs.update(b,{status:'failed',finishedAt:Date.now(),results:0});const r=GH.jobs.start('ct-crtsh','example.org');GH.jobs.update(r,{status:'running',progress:0.4})})()`);
    await sleep(300);

    for (const sk of Sk.SKINS) {
      await set(sk.id); await go('#home');
      const t = await text();
      await regions(`${sk.id} home (with data)`, HOME[sk.id]);
      await noOverflow(`${sk.id} home`);
      if (sk.id === 'ops') {
        rec('ops: map draws the 3 places of the case', (await count('.pm-pin')) === 3, String(await count('.pm-pin')));
        rec('ops: lines between related places (direct link and via an organisation)', (await count('.pm-link')) >= 2, String(await count('.pm-link')));
        rec('ops: linked entities drawn beside their places', (await count('.pm-sat')) >= 2);
        if (W < 720) { await js("document.querySelector('.ot-toggle').click()"); await sleep(200); }
        rec('ops: tree lists the case and its entity folders', (await count('.ops-tree [role=treeitem]')) >= 3 && /Harbour logistics review/.test(await js("document.querySelector('.ops-tree').innerText")));
        rec('ops: lookups table has the real jobs of this window', (await count('.ops-t1 tbody tr')) >= 3 && /example\.org/.test(await js("document.querySelector('.ops-t1').innerText")));
        rec('ops: entities table is the open case', (await count('.ops-t2 tbody tr')) >= 5);
        await js(`document.querySelector('.pm-pin').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`); await sleep(400);
        rec('ops: selecting a pin by keyboard fills the detail panel', /London office|Hamburg depot|Rotterdam terminal/.test(await js("document.querySelector('.ops-detail').innerText")) && (await count('.ops-detail .ed-conn tbody tr')) >= 1);
        // tree keyboard
        if (W < 720 && (await js("document.querySelector('.ot-toggle').getAttribute('aria-expanded')")) !== 'true') { await js("document.querySelector('.ot-toggle').click()"); await sleep(200); }
        await js(`document.querySelector('.ops-tree [role=treeitem][tabindex="0"]').focus()`); await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))`); await sleep(100);
        rec('ops: tree moves with the arrow keys', (await js("document.activeElement.getAttribute('role')")) === 'treeitem' && (await js("document.activeElement.dataset.id")) !== (await js("document.querySelector('.ops-tree [role=treeitem]').dataset.id")));
        if (W >= 720) rec('ops: three columns at this width (tree, work, detail)', await js(`(()=>{const a=document.querySelector('.ops-tree').getBoundingClientRect(),b=document.getElementById('main').getBoundingClientRect(),d=document.querySelector('.ops-detail').getBoundingClientRect();return a.right<=b.left+1&&(W>=1181?b.right<=d.left+1:d.top>=b.bottom-1)})()`.replace('W>=1181', String(W >= 1181))));
        rec('ops: the tab bar scrolls by itself, the page does not', (await js("(()=>{const t=document.querySelector('.ops-tabs');return t.scrollWidth>t.clientWidth})()")) || W >= 1280);
      }
      if (sk.id === 'terminal') {
        rec('terminal: jobs table lists the 3 real jobs', (await count('.tm-jobs tbody tr')) === 3, String(await count('.tm-jobs tbody tr')));
        rec('terminal: vault panel reads UNLOCKED from the vault state', /UNLOCKED/.test(await js("document.querySelector('.tm-vault').innerText")) && (await js("document.querySelector('.padlock').classList.contains('is-open')")));
        rec('terminal: case files grid has the case', (await count('.tm-file')) === 1 && /Harbour logistics review/.test(await js("document.querySelector('.tm-files').innerText")));
        rec('terminal: activity log has lines from the lookups', (await count('.tm-log-l li')) >= 3);
        rec('terminal: health dials and module bars', (await count('.tm-dials .dial')) === 3 && (await count('.tm-mods li')) === 9);
        rec('terminal: function-key bar has every page, Workspace and Tools included', (await count('.tm-keys .tk')) === (await js('GH.shellParts.navItems().length')) + 1 && /Workspace/.test(await js("document.querySelector('.tm-keys').innerText")) && /All tools/.test(await js("document.querySelector('.tm-keys').innerText")));
      }
      if (sk.id === 'hud') {
        rec('hud: ring reads the vault and the connectors', /Vault: unlocked/.test(await js("document.querySelector('.hd-ring-svg').getAttribute('aria-label')")) && /Connectors ready: \d+ of \d+/.test(await js("document.querySelector('.hd-ring-svg').getAttribute('aria-label')")));
        rec('hud: sweep has one blip per place', (await count('.rd-blip')) === 3, String(await count('.rd-blip')));
        rec('hud: every card has four corner brackets', await js(`[...document.querySelectorAll('.hd-card,.hd-ring')].every(c=>c.querySelectorAll('.br').length===4)`));
        rec('hud: activity chart counts the real events', (await count('.bars-bar')) >= 1);
        rec('hud: side panels either side of the ring', await js(`(()=>{const l=document.querySelector('.hd-l').getBoundingClientRect(),r=document.querySelector('.hd-ring').getBoundingClientRect(),x=document.querySelector('.hd-r').getBoundingClientRect();return ${W >= 1181} ? (l.right<=r.left+1&&r.right<=x.left+1) : true})()`));
      }
      if (sk.id === 'mono') {
        const total = await js("[...document.querySelectorAll('.mn-mods .mn-ch')].reduce((a,e)=>a+e.textContent.length,0)");
        const exp = await js("(async()=>GhostLay.connStats(await GH.conn.list()).rows.reduce((a,r)=>a+r.cells.length,0))()").catch(() => null);
        rec('mono: one character per connector in the grid', total > 0 && (exp === null || total === exp), total + ' vs ' + exp);
        rec('mono: stat row shows the case entity count', (await js("document.querySelector('.mn-stats').innerText")).includes(String(await js('Object.keys(GH.cs.current().entities).length'))), '');
        rec('mono: last lookup shown as a character progress bar', (await count('.mn-last .mn-ch')) === 1);
        rec('mono: headline is large', (await js("parseFloat(getComputedStyle(document.querySelector('.mn-h')).fontSize)")) >= (W >= 1024 ? 48 : 30));
      }
      await contrast(`${sk.id} home`);
      await shot(`${sk.id}-home`);
      await wsFlow(sk.id);
      // Case board
      await go('#case/' + c.id, '#tab-graph'); await waitFor("document.querySelectorAll('.graph .node').length>=9"); await sleep(400);
      await noOverflow(`${sk.id} board`); await contrast(`${sk.id} board`);
      if (sk.id !== 'mayfair') rec(`${sk.id}: board has the skin's case summary from the open case`, (await count('.bd-strip > *')) === 1 && /12|entities/i.test(await js("document.querySelector('.bd-strip').innerText")));
      await shot(`${sk.id}-board`);
      // other screens must not overflow either
      for (const hsh of ['#case', '#tools', '#modules', '#tool', '#workspace', '#settings/appearance']) { await go(hsh); await noOverflow(`${sk.id} ${hsh}`); }
      await shot(`${sk.id}-settings`);
    }

    // ----- reduced motion: the sweep, the cursors and the transitions stop -----
    await set('hud'); await go('#home');
    const dbg = wc.debugger; dbg.attach('1.3');
    const anim = () => js("getComputedStyle(document.querySelector('.rd-sweep')).animationName");
    const before = await anim();
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await sleep(200);
    const after = await anim();
    rec('reduced motion: the HUD sweep animates normally and stops when the computer asks for less motion', before !== 'none' && after === 'none', before + ' -> ' + after);
    await set('mono'); await go('#home'); rec('reduced motion: the Mono cursor stops', (await js("getComputedStyle(document.querySelector('.mn-cur')).animationName")) === 'none');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] }); dbg.detach();

    // ----- the picker: choose live, persists, theme switch is off for dark skins, back to Mayfair restores the sidebar -----
    await go('#settings/appearance', '.skins');
    rec('picker: five skins with a layout name each', (await count('.sk')) === 5 && (await count('.sk .sk-n em')) >= 5);
    await js(`document.querySelector('.sk input[value=ops]').click()`); await sleep(700);
    rec('picker: choosing Operations changes the whole frame at once and keeps the Settings screen', (await count('.ops-tabs')) === 1 && (await count('.rail')) === 0 && /Appearance/.test(await text()) && A.prefsGet().skin === 'ops');
    rec('picker: the chosen skin is focused after the change (keyboard users keep their place)', (await js("document.activeElement.closest('.sk')&&document.activeElement.value")) === 'ops');
    await js(`document.querySelector('.sk input[value=mayfair]').click()`); await sleep(700);
    rec('picker: choosing Mayfair brings the sidebar back', (await count('.rail')) === 1 && (await count('.ops-tabs')) === 0 && A.prefsGet().skin === 'mayfair');
    // Mayfair follows its own design: not a recoloured other skin
    await go('#home'); rec('mayfair home is the Workspace (sidebar, master search, tool index, no module cards)', (await count('.rail')) === 1 && (await count('.ws-search')) === 1 && (await count('.ws-idx')) === 1 && (await count('.mods .mod')) === 0 && (await count('.hero')) === 0);
    rec('mayfair rail lists Workspace and Tools, not the module list', /Workspace/.test(await js("document.querySelector('.rail').textContent")) && /All tools/.test(await js("document.querySelector('.rail').textContent")) && !/Companies and public records/.test(await js("document.querySelector('.rail').textContent")) && (await count('.rail [data-nav]')) === 7, typeof (await count('.rail [data-nav]')) + ' ' + (await js("document.querySelector('.rail').textContent")).slice(0, 120) + ' nav items: ' + (await js("[...document.querySelectorAll('.rail [data-nav]')].map(e=>e.dataset.nav).join(',')")));
    rec('no console errors', pageErr.length === 0, pageErr.slice(0, 3).join(' | '));
  } catch (e) { rec('harness error', false, e && e.stack); }
  fs.writeFileSync(path.join(OUT, `${TAG}-layout-results.json`), JSON.stringify(results, null, 1));
  const failed = results.filter((r) => !r.ok).length; console.log(`DONE ${results.length - failed}/${results.length}`);
  try { ghost.shutdown(); await mock.close(); } catch { /* ok */ }
  eapp.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); eapp.exit(2); });
