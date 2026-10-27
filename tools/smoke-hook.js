'use strict';
// Runs INSIDE the Electron main process when MF_SMOKE=1 (never in a packaged app).
// A mock Mayfair Cloud page (tools/smoke-cloud.html) is served for https://cloud.mayfairmail.com/ inside the app's own Mayfair session.
// It plays the part of the Cloud Browser app: it reports the content rectangle with setBounds, listens to the bridge events and
// does what the real window manager does around occlusion (capture, setOccluded).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const OUT = process.env.MF_SMOKE_OUT || '/tmp/mf-smoke';
const TAG = process.env.MF_SMOKE_TAG || 'w';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const shot = async (name) => { await sleep(500); try { execFileSync('import', ['-window', 'root', path.join(OUT, `${TAG}-${name}.png`)], { stdio: 'ignore' }); } catch (e) { rec('screenshot ' + name, false, e.message); } };

async function run(br, app) {
  fs.mkdirSync(OUT, { recursive: true });
  const { session, nativeTheme } = require('electron');
  const cloudHtml = fs.readFileSync(path.join(__dirname, 'smoke-cloud.html'), 'utf8');
  session.fromPartition('persist:mayfair').protocol.handle('https', (req) => {
    const u = new URL(req.url);
    if (u.hostname === 'cloud.mayfairmail.com') return new Response(cloudHtml, { headers: { 'content-type': 'text/html' } });
    return new Response('offline', { status: 503 });
  });
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/file.txt')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' }); return res.end('hello from the smoke test'); }
    if (req.url.startsWith('/popup')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Popup page</title><script>setTimeout(()=>window.open("http://127.0.0.1:' + server.address().port + '/"),50)</script><p>popup test</p>'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Local test page</title><body style="font:16px system-ui;padding:24px;background:#fff;color:#111">
<h1>Local test page</h1><p>Search me: amber mayfair.</p>
<form><input type="text" name="user" placeholder="user"><input type="password" name="pw" placeholder="password"></form>
<img src="https://doubleclick.net/pixel.gif" width=1 height=1><script src="https://www.google-analytics.com/analytics.js"></script>
<a id="l" href="http://127.0.0.1:${server.address().port}/popup">link</a></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const home = br.home;
  const ev = (wc, js) => wc.executeJavaScript(js, true);
  // run an expression in the Mock Cloud page (the Mayfair view), JSON-safe result
  const P = (expr) => ev(home.wc, `(async()=>{try{const v=await (${expr});return JSON.stringify(v===undefined?null:v)}catch(e){return JSON.stringify({__err:String(e&&e.message||e)})}})()`).then((s) => JSON.parse(s));
  const BR = (expr) => P('window.mayfairDesktop.browser.' + expr);
  const events = async (name) => (await P('T.events')).filter((e) => e[0] === name).map((e) => e[1]);
  const waitFor = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(150); } return false; };

  // ---- window shape: one Mayfair view, nothing else ----
  await waitFor(() => /Mock Cloud/.test(home.wc.getTitle()), 10000);
  rec('Mayfair view loaded the (mock) Cloud page over https', home.wc.getTitle() === 'Mock Cloud' && /cloud\.mayfairmail\.com/.test(home.wc.getURL()), home.wc.getURL());
  const [cw, ch] = br.win.getContentSize();
  const hb = home.view.getBounds();
  rec('Mayfair view fills the window (no strip)', hb.x === 0 && hb.y === 0 && hb.width === cw && hb.height === ch, JSON.stringify(hb) + ' in ' + cw + 'x' + ch);
  rec('window holds exactly one view before any tab', br.win.contentView.children.length === 1, br.win.contentView.children.length);
  rec('bridge exists on the Mayfair page', (await P('T.hasBridge')) === true);
  rec('bridge has every group', await P(`['bookmarks','history','downloads','settings','permissions','popups','webapps','tor','adblock','extensions'].every((g)=>typeof window.mayfairDesktop.browser[g]==='object')`));
  rec('legacy bridge still there', await P(`['installExtension','removeExtension','listExtensions','onFile','onDeepLink','notify','openBrowser'].every((k)=>typeof window.mayfairDesktop[k]==='function')`));
  await shot('01-mayfair-only');

  const rd = await BR('ready()');
  rec('ready() describes the app', rd && rd.version && rd.platform === process.platform && Array.isArray(rd.features) && rd.features.includes('capture') && rd.state && Array.isArray(rd.state.tabs) && rd.state.tabs.length === 0, JSON.stringify(rd).slice(0, 160));
  rec('no tabs at start, not even a Mayfair tab', rd.state.tabs.length === 0 && rd.state.activeId === null);

  // ---- first tab, bounds, state events ----
  const t1 = (await BR(`newTab({url:'${base}/'})`)).id;
  await sleep(3000);
  const t1v = br.tabs.get(t1);
  const rect = await P('T.bounds');
  const zf = home.wc.getZoomFactor();
  const eb = t1v.view.getBounds();
  rec('tab view sits at the rectangle the page reported', Math.abs(eb.x - Math.round(rect.x * zf)) <= 1 && Math.abs(eb.y - Math.round(rect.y * zf)) <= 1 && Math.abs(eb.width - Math.round(rect.w * zf)) <= 1 && Math.abs(eb.height - Math.round(rect.h * zf)) <= 1, JSON.stringify(eb) + ' vs ' + JSON.stringify(rect));
  rec('tab view is visible above the Mayfair view', t1v.shown && br.win.contentView.children[br.win.contentView.children.length - 1] === t1v.view && br.win.contentView.children[0] === home.view);
  const st = await P('T.state');
  const a = st && st.tabs.find((x) => x.id === t1);
  rec('state event carries the tab', a && st.activeId === t1 && a.url === base + '/' && a.title === 'Local test page' && a.secure === 'insecure' && a.loading === false, JSON.stringify(a));
  rec('tracker requests blocked and counted', a && a.blocked >= 2, a && a.blocked);
  rec('password field detected', a && a.pw === true);
  rec('page world has no bridge', (await ev(t1v.wc, 'typeof window.mayfairDesktop + typeof window.mf + typeof window.require + typeof window.mfSearch')) === 'undefinedundefinedundefinedundefined');
  await shot('02-tab-in-cloud-window');

  // moving the window: the page sends new bounds, the view follows
  await P(`(()=>{const w=document.getElementById('win');w.style.left='12%';w.style.top='15%';w.style.width='80%';w.style.height='70%';T.send();return 1})()`);
  await sleep(500);
  const r2 = await P('T.bounds'); const eb2 = t1v.view.getBounds();
  rec('view follows when the window moves and resizes', Math.abs(eb2.x - Math.round(r2.x * zf)) <= 1 && Math.abs(eb2.width - Math.round(r2.w * zf)) <= 1 && eb2.x !== eb.x && eb2.width !== eb.width, JSON.stringify(eb2));
  // page zoom of the Mayfair view
  home.wc.setZoomFactor(1.25); await sleep(100); await P('T.send()'); await sleep(300);
  const r3 = await P('T.bounds'); const eb3 = t1v.view.getBounds();
  rec('bounds are converted with the Mayfair view zoom factor', Math.abs(eb3.width - Math.round(r3.w * 1.25)) <= 1 && Math.abs(eb3.x - Math.round(r3.x * 1.25)) <= 1, JSON.stringify(eb3) + ' css ' + JSON.stringify(r3));
  home.wc.setZoomFactor(1); await sleep(100); await P('T.send()'); await sleep(300);

  // ---- occlusion and capture ----
  const oc = await P('T.occlude(true)');
  rec('setOccluded(true) hides the native view after capturing it', oc && oc.captured === true && oc.imgLen > 3000 && !t1v.shown && t1v.view.getVisible() === false, JSON.stringify(oc));
  rec('capture() while occluded returns the stored picture', ((await BR('capture()')) || '').startsWith('data:image/jpeg;base64,'));
  await shot('03-occluded-picture');
  await P('T.occlude(false)'); await sleep(300);
  rec('setOccluded(false) shows it again', t1v.shown && t1v.view.getVisible() === true);
  const cap = await BR('capture()');
  rec('capture() of a visible tab is a JPEG data URL', typeof cap === 'string' && cap.startsWith('data:image/jpeg;base64,') && cap.length > 3000, cap.length);
  await BR('setBounds({x:0,y:0,w:0,h:0,visible:true})'); await sleep(200);
  rec('empty bounds hide the view', !t1v.shown);
  await P('T.send()'); await sleep(300);
  rec('real bounds show it again', t1v.shown);

  // ---- navigation ----
  rec('go() with a URL', (await BR(`go(${t1},'${base}/x?a=1')`)) === true && await waitFor(() => /x\?a=1/.test(t1v.wc.getURL())));
  rec('go() with plain words searches with the chosen engine', (await BR(`go(${t1},'cats and dogs')`)) === true && await waitFor(() => /duckduckgo\.com/.test(decodeURIComponent(t1v.wc.getURL())) || /error\.html/.test(t1v.wc.getURL())) && /duckduckgo|cats/.test(decodeURIComponent(t1v.wc.getURL())), decodeURIComponent(t1v.wc.getURL()).slice(0, 100));
  await BR(`go(${t1},'${base}/')`); await sleep(1500);
  rec('go() refuses javascript: (turned into a search)', (await BR(`go(${t1},'javascript:alert(1)')`)) === true && await waitFor(() => !/^javascript:/.test(t1v.wc.getURL())) && !/^javascript:/.test(t1v.wc.getURL()));
  await BR(`go(${t1},'${base}/')`); await sleep(1500);
  rec('back and forward', (await BR(`back(${t1})`)) === true && await waitFor(() => t1v.wc.navigationHistory.canGoForward()) && (await BR(`forward(${t1})`)) === true);
  rec('reload and stop', (await BR(`reload(${t1})`)) === true && (await BR(`reload(${t1},true)`)) === true && (await BR(`stop(${t1})`)) === true);
  await sleep(1500);
  const sg = await BR(`suggest('local')`);
  rec('suggest() uses history, plus a search row', Array.isArray(sg) && sg.some((x) => x.kind === 'history') && sg.some((x) => x.kind === 'search'), JSON.stringify(sg).slice(0, 120));
  rec('home() focuses Mayfair, tabs untouched', (await BR('home()')) === true && br.model.tabs.length === 1);

  // ---- find, zoom, bookmarks, history ----
  await BR(`go(${t1},'${base}/')`); await sleep(1800);
  const f1 = await BR(`find(${t1},'mayfair',{})`);
  rec('find reports matches', f1 && f1.of >= 1 && f1.n === 1, JSON.stringify(f1));
  rec('find-result event', (await events('find-result')).some((e) => e.id === t1 && e.of >= 1));
  await BR(`stopFind(${t1})`);
  const z1 = await BR(`zoom(${t1},1)`); const z2 = await BR(`zoom(${t1},1)`);
  rec('zoom steps in percent and reaches the state', z1 === 110 && z2 === 125 && (await waitFor(async () => (await P('T.state')).tabs[0].zoom === 125)), z1 + ',' + z2);
  rec('zoom reset', (await BR(`zoom(${t1},'reset')`)) === 100);
  const bm = await BR(`bookmarks.add({url:'${base}/',title:'Local test page'})`);
  rec('bookmark add and list', bm && bm.id && (await BR('bookmarks.list()')).some((b) => b.url === base + '/'));
  rec('state shows bookmarked', await waitFor(async () => (await P('T.state')).tabs[0].bookmarked === true));
  rec('bookmark update', (await BR(`bookmarks.update('${bm.id}',{title:'Renamed'})`)) === true && (await BR('bookmarks.list()')).some((b) => b.title === 'Renamed'));
  rec('bookmark import (dedup, http only)', (await BR(`bookmarks.import([{url:'${base}/',title:'dup'},{url:'https://example.org/a',title:'A'},{url:'javascript:1',title:'bad'}])`)).added === 1);
  rec('bookmark remove', (await BR(`bookmarks.remove('${bm.id}')`)) === true);
  const hl = await BR('history.list()');
  rec('history list and search', hl.length >= 1 && hl[0].visited > 0 && (await BR(`history.search('local')`)).length >= 1);
  rec('history remove and clear', (await BR(`history.remove('${base}/')`)) === true && (await BR('history.clear()')) === true && (await BR('history.list()')).length === 0);

  // ---- settings ----
  const s0 = await BR('settings.get()');
  rec('settings.get has values and read-only info', s0 && s0.searchEngine === 'duckduckgo' && s0.version && s0.dnsProviders && s0.startup === 'start', JSON.stringify(s0).slice(0, 100));
  const s1 = await BR(`settings.set({searchEngine:'brave',startup:'restore',bogus:1,adblock:'yes'})`);
  rec('settings.set applies valid keys only', s1.changed.sort().join() === 'searchEngine,startup' && s1.settings.searchEngine === 'brave');
  await BR(`settings.set({searchEngine:'duckduckgo',startup:'start'})`);
  const px = await BR(`settings.setProxy('socks5','proxy.example.net',1080)`);
  const rp = await session.fromPartition('persist:browse').resolveProxy('https://example.org/');
  const rh = await session.fromPartition('persist:mayfair').resolveProxy('https://cloud.mayfairmail.com/');
  rec('own proxy applies to browser tabs, not Mayfair', px.ok && /SOCKS5 proxy\.example\.net:1080/.test(rp) && !/proxy\.example\.net/.test(rh), rp + ' / ' + rh);
  rec('bad proxy refused', (await BR(`settings.setProxy('http','http://x',80)`)).ok === false);
  await BR(`settings.setProxy('off','',0)`);
  rec('proxy off restores direct', /DIRECT/.test(await session.fromPartition('persist:browse').resolveProxy('https://example.org/')));

  // ---- argument checks and who may call ----
  const bad = async (expr) => /blocked/.test((await BR(expr)).__err || '');
  rec('bad arguments are refused by main', (await bad(`closeTab('1')`)) && (await bad(`setBounds({x:'a'})`)) && (await bad(`zoom(${t1},'evil')`)) && (await bad(`settings.set(5)`)) && (await bad(`go(${t1},5)`)));
  br.devTools = false; rec('devtools(id) refused when developer tools are off (installed build)', /blocked: devtools/.test((await BR(`devtools(${t1})`)).__err || '')); br.devTools = true;
  rec('unknown tab id rejects', /no such tab/.test((await BR('back(99999)')).__err || ''));
  const sneak = await ev(t1v.wc, `(typeof require)`);
  rec('a page tab cannot reach the bridge or IPC', sneak === 'undefined');

  // ---- permission prompt ----
  rec('permission-request has a subscriber (page listens)', br.subs.has('permission-request'));
  let ans = null;
  br.askPermission(t1v.wc, base, 'geolocation', {}, (v) => { ans = v; }, true);
  await sleep(500);
  const pr = (await events('permission-request')).find((e) => e.kind === 'geolocation');
  rec('permission-request event: tab, origin, plain label', pr && pr.tabId === t1 && pr.origin === base && pr.label === 'know your location' && pr.canRemember === true, JSON.stringify(pr));
  rec('answer allow + remember stores it per site', (await BR(`permissions.answer('${pr.id}',true,true)`)) === true && ans === true && br.sitePerms.get(base, 'geolocation') === 'allow');
  rec('permissions.list and site', (await BR('permissions.list()')).sites[base].geolocation === 'allow' && (await BR(`permissions.site(${t1})`)).origin === base);
  await BR(`permissions.reset('${base}')`);
  let a2 = null; br.askPermission(t1v.wc, base, 'media', { mediaTypes: ['audio', 'video'] }, (v) => { a2 = v; }, true); await sleep(300);
  const pr2 = (await events('permission-request')).find((e) => e.kind === 'media');
  await BR(`permissions.answer('${pr2.id}',false,false)`);
  rec('media prompt says camera and microphone; deny works', pr2.label === 'camera and microphone' && a2 === false && br.sitePerms.get(base, 'media') === 'ask');
  rec('unknown request id answers false', (await BR(`permissions.answer('p99999',true,false)`)) === false);
  const cancelBefore = (await events('permission-cancel')).length;
  const tmp = (await BR(`newTab({url:'${base}/'})`)).id; await sleep(800);
  let a4 = null; br.askPermission(br.tabs.get(tmp).wc, base, 'midi', {}, (v) => { a4 = v; }, false); await sleep(200);
  await BR(`closeTab(${tmp})`); await sleep(300);
  rec('closeTab denies pending request and sends permission-cancel', a4 === false && (await events('permission-cancel')).length > cancelBefore);
  for (const id of [...br.perms.keys()]) br.dropPerm(id, true);

  // ---- pop-up blocking ----
  const pid = (await BR(`newTab({url:'${base}/popup'})`)).id; await sleep(3000);
  const nw = (await events('new-window-request'))[0];
  rec('script pop-up without a click is blocked and reported', nw && nw.tabId === pid && /127\.0\.0\.1/.test(nw.url), JSON.stringify(nw));
  const before = br.model.tabs.length;
  rec('popups.allow opens it as a tab', (await BR(`popups.allow('${nw.id}')`)) === true && br.model.tabs.length === before + 1);
  for (const m of br.model.tabs.filter((t) => t.id !== t1)) br.closeTab(m.id);
  await sleep(300);

  // ---- tab management ----
  const ids = [t1];
  for (let i = 0; i < 3; i++) ids.push((await BR(`newTab({url:'${base}/?n=${i}',background:true})`)).id);
  rec('background tabs do not take over', (await P('T.state')).activeId === t1 || br.model.activeId === t1);
  rec('activate switches the visible native view', (await BR(`activate(${ids[2]})`)) === true && br.tabs.get(ids[2]).shown && !br.tabs.get(t1).shown && br.tabs.get(ids[1]).shown === false);
  rec('pin moves to the left and move cannot cross the pinned block', (await BR(`pin(${ids[2]},true)`)) === true && br.model.tabs[0].id === ids[2] && (await BR(`move(${ids[1]},0)`)) === true && br.model.tabs[0].id === ids[2]);
  const dup = (await BR(`duplicate(${ids[1]})`)).id; await sleep(800);
  rec('duplicate opens a copy next to it', br.model.tabs[br.model.index(dup)] && br.model.index(dup) === br.model.index(ids[1]) + 1);
  rec('mute', (await BR(`mute(${dup},true)`)) === true && br.tabs.get(dup).wc.audioMuted === true);
  rec('closeOthers keeps pinned and the chosen one', (await BR(`closeOthers(${ids[1]})`)) === true && br.model.tabs.map((t) => t.id).sort().join() === [ids[2], ids[1]].sort().join());
  rec('closeTab then reopenClosed', (await BR(`closeTab(${ids[1]})`)) === true && (await BR('reopenClosed()')).id > 0);
  for (const m of [...br.model.tabs]) br.closeTab(m.id);
  await sleep(400);
  const empty = await P('T.state');
  rec('closing the last tab leaves zero tabs, no automatic new tab', empty.tabs.length === 0 && empty.activeId === null && br.win.contentView.children.length === 1);
  await shot('04-no-tabs');

  // ---- private tab ----
  const hn = br.history.list().length;
  const priv = (await BR(`newTab({url:'${base}/',private:true})`)).id; await sleep(2500);
  rec('private tab does not write history', br.history.list().length === hn, hn + ' -> ' + br.history.list().length);
  rec('private tab marked private in state', (await P('T.state')).tabs.find((t) => t.id === priv).private === true);
  await shot('05-private-tab');
  await BR(`closeTab(${priv})`);

  // ---- download ----
  const dl = (await BR(`newTab({url:'${base}/'})`)).id; await sleep(1500);
  const drive = path.join(app.getPath('documents'), 'Mayfair Drive', 'Downloads');
  br.tabs.get(dl).wc.downloadURL(base + '/file.txt');
  await waitFor(async () => (await events('download')).some((d) => d.done), 6000);
  const saved = path.join(drive, 'report.txt');
  rec('download lands in the Mayfair Drive folder', fs.existsSync(saved) && fs.readFileSync(saved, 'utf8') === 'hello from the smoke test', saved);
  const dls = await BR('downloads.list()');
  rec('downloads.list shows it completed', dls[0] && dls[0].state === 'completed' && dls[0].name === 'report.txt' && dls[0].cloud === true);
  rec('download events and a notice reach the page', (await events('download')).some((d) => d.done && d.state === 'completed') && (await events('notice')).some((n) => /Downloaded report\.txt/.test(n.text)));
  rec('download reaches the legacy onDownload bridge for the Cloud Files app', (await events('legacy-download')).some((d) => d.name === 'report.txt'));
  rec('downloads.show and clear', (await BR(`downloads.clear()`)) === true && (await BR('downloads.list()')).length === 0);

  // ---- fullscreen from a page ----
  ev(br.tabs.get(dl).wc, `document.documentElement.requestFullscreen().then(()=>1,()=>0)`).catch(() => {});   // not awaited: it settles when the page is in full screen
  const fsOn = await waitFor(async () => (await events('fullscreen')).some((e) => e.on), 5000);
  const fb = br.tabs.get(dl).view.getBounds(); const [fw, fh] = br.win.getContentSize();
  rec('HTML5 fullscreen: event, view covers the whole window', fsOn && fb.x === 0 && fb.y === 0 && fb.width === fw && fb.height === fh, JSON.stringify(fb) + ' in ' + fw + 'x' + fh);
  await shot('06-html-fullscreen');
  await BR('fullscreen(false)'); await sleep(800);
  const fb2 = br.tabs.get(dl).view.getBounds();
  rec('leaving fullscreen restores the reported rectangle', (await events('fullscreen')).some((e) => !e.on) && fb2.width < fw, JSON.stringify(fb2));
  br.closeTab(dl);

  // ---- navigation lock of the Mayfair view ----
  await sleep(300);
  const n0 = br.model.tabs.length;
  await P(`window.mayfairDesktop.openBrowser('https://example.com/')`);
  await sleep(500);
  const ou = await events('open-url');
  rec('openBrowser asks the Cloud side to open the address (no tab made by main)', ou.some((e) => e.url === 'https://example.com/') && br.model.tabs.length === n0);
  rec('openBrowser refuses non-web addresses', (await P(`window.mayfairDesktop.openBrowser('file:///etc/passwd')`)) === false);
  await ev(home.wc, `location.href='https://example.com/'`);
  await sleep(1500);
  rec('foreign navigation of the Mayfair view is turned into open-url', (await events('open-url')).filter((e) => e.url === 'https://example.com/').length >= 2 && /cloud\.mayfairmail\.com/.test(home.wc.getURL()), home.wc.getURL());
  rec('mayfair://browse deep link reaches the Browser', br.openDeepLink('mayfair://browse?url=' + encodeURIComponent('https://example.org/x')) === true && (await waitFor(async () => (await events('open-url')).some((e) => e.url === 'https://example.org/x'), 3000)));
  rec('deep link with a bad url refused', br.openDeepLink('mayfair://browse?url=javascript%3A1') === false && br.openDeepLink('mayfair://') === false);
  rec('legacy deep link still goes to the Mayfair page', br.openDeepLink('mayfair://open/Drive/a.docx?x=1') === true);
  await sleep(500);
  rec('Mayfair page still on its own origin', /cloud\.mayfairmail\.com/.test(home.wc.getURL()) && home.wc.getTitle() === 'Mock Cloud');

  // ---- menu and key shortcuts ----
  br.menuAction('find'); await sleep(300);
  rec('menu action is reported as a menu event', (await events('menu')).some((e) => e.action === 'find'));
  const kt = (await BR(`newTab({url:'${base}/'})`)).id; await sleep(1500);
  br.tabs.get(kt).wc.focus();
  br.tabs.get(kt).wc.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] });
  br.tabs.get(kt).wc.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] });
  await sleep(500);
  rec('Ctrl+T pressed inside a page tab becomes a menu event', (await events('menu')).some((e) => e.action === 'newTab'));
  br.closeTab(kt);

  // ---- web apps ----
  rec('catalogue loaded', br.catalogue.length >= 30, br.catalogue.length + ' apps, errors: ' + br.catalogueErrors.length);
  const cat = await BR('webapps.catalogue()');
  rec('webapps.catalogue shape', cat.length >= 30 && cat[0].id && cat[0].name && cat[0].category && (cat[0].badge === 'title' || cat[0].badge === 'none') && typeof cat[0].badgeCount === 'number' && cat[0].hosts === undefined);
  const nT = br.model.tabs.length;
  rec('webapps.open opens a tab with the app session', (await BR(`webapps.open('gmail')`)) === true);
  await sleep(1500);
  const gt = br.model.tabs.find((t) => t.appId === 'gmail');
  rec('app opens in its own tab', !!gt && br.model.tabs.length === nT + 1 && br.model.activeId === gt.id);
  rec('app tab uses its own isolated session', br.tabs.get(gt.id).wc.session !== session.fromPartition('persist:browse') && br.tabs.get(gt.id).wc.session !== session.fromPartition('persist:mayfair'));
  rec('app open asks the Cloud side to show the Browser', (await events('menu')).some((e) => e.action === 'showBrowser'));
  br.openApp('gmail'); rec('opening again switches to the same tab', br.model.tabs.filter((t) => t.appId === 'gmail').length === 1);
  br.setBadge(br.appById('gmail'), 7, true);
  rec('unread badge in state', await waitFor(async () => (await P('T.state')).tabs.find((t) => t.webapp === 'gmail').badge === 7));
  const gs = br.sessionForApp(br.appById('gmail'));
  await gs.cookies.set({ url: 'https://mail.google.com', name: 'k', value: 'v' });
  rec('cookie stored in the app session only', (await gs.cookies.get({ name: 'k' })).length === 1 && (await session.fromPartition('persist:browse').cookies.get({ name: 'k' })).length === 0);
  rec('webapps.pin and pinned list for the Cloud desktop', (await BR(`webapps.pin('gmail',true)`)) === true && (await P(`window.mayfairDesktop.apps.list()`)).map((a) => a.id).join() === 'gmail');
  rec('webapps.reset clears the app session', (await BR(`webapps.reset('gmail')`)) === true && (await gs.cookies.get({ name: 'k' })).length === 0);
  const sc = await BR(`webapps.shortcut('gmail')`);
  rec('desktop shortcut created (Linux .desktop)', process.platform !== 'linux' || (sc.ok && fs.existsSync(sc.path) && /--app=gmail/.test(fs.readFileSync(sc.path, 'utf8'))), sc.path || sc.reason);
  rec('webapps.remove closes the tab and forgets the app', (await BR(`webapps.remove('gmail')`)) === true && !br.model.tabs.some((t) => t.appId === 'gmail') && !br.appsStore.has('gmail'));
  await BR(`webapps.open('discord',{window:true})`); await sleep(1500);
  rec('app opens in its own window', br.appWindows.has('discord') && !br.appWindows.get('discord').isDestroyed());
  await BR(`webapps.remove('discord')`);
  rec('window closed on remove', !br.appWindows.has('discord') || br.appWindows.get('discord').isDestroyed());
  rec('newTab({webapp}) works through the tab call', await (async () => { const r = await BR(`newTab({webapp:'gmail'})`); const ok = r.id && br.model.get(r.id).appId === 'gmail'; await BR(`webapps.remove('gmail')`); return ok; })());

  // ---- privacy ----
  const bt = (await BR(`newTab({url:'${base}/'})`)).id; await sleep(2500);
  const bw = br.tabs.get(bt).wc;
  rec('WebRTC leak policy on browser tabs', bw.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp', bw.getWebRTCIPHandlingPolicy());
  rec('Mayfair view keeps default WebRTC (calls work)', home.wc.getWebRTCIPHandlingPolicy() === 'default', home.wc.getWebRTCIPHandlingPolicy());
  await BR(`settings.set({standardLocale:true})`);
  const lt = (await BR(`newTab({url:'${base}/'})`)).id; await sleep(3000);
  const loc = await ev(br.tabs.get(lt).wc, `[Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language, navigator.hardwareConcurrency, navigator.languages.join()].join('|')`);
  rec('standard time zone, language and reduced fingerprint on new tabs', loc === 'UTC|en-US|4|en-US,en', loc);
  await BR(`settings.set({standardLocale:false})`);
  // Tor with the stand-in daemon (the real tor binary cannot be downloaded here)
  rec('Tor binary found for this run', !!br.tor.binary, br.tor.binary);
  const tr = await BR(`newTab({tor:true})`); await sleep(2500);
  const tid = tr.id;
  rec('Tor tab opens only after Tor reports 100%', !!tid && br.tor.ready);
  const tproxy = await session.fromPartition('mf-tor').resolveProxy('https://example.org/');
  rec('Tor session routed to the local SOCKS port, own partition', br.model.get(tid) && br.model.get(tid).tor && new RegExp('SOCKS5 127\\.0\\.0\\.1:' + br.tor.state.socksPort).test(tproxy), tproxy);
  await br.tabs.get(tid).wc.loadURL(base + '/').catch(() => {}); await sleep(2000);
  rec('Tor tab fails closed (no direct connection to a local page)', /error\.html/.test(br.tabs.get(tid).wc.getURL()) && br.tabs.get(tid).wc.getTitle() !== 'Local test page', br.tabs.get(tid).wc.getURL().replace(/\?.*/, ''));
  rec('Tor tab WebRTC strict', br.tabs.get(tid).wc.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp');
  rec('tor.status and state', (await BR('tor.status()')).state === 'connected' && (await P('T.state')).tabs.find((t) => t.id === tid).tor === true);
  rec('new identity works', (await BR('tor.newIdentity()')) === true);
  await BR(`closeTab(${tid})`); await sleep(1500);
  rec('Tor stops when the last Tor tab closes', br.tor.state.status === 'off');
  const adb = await BR(`adblock.stats(${bt})`);
  rec('adblock.stats', adb && typeof adb.rules === 'number' && adb.blocked >= 2 && Array.isArray(adb.lists), JSON.stringify(adb).slice(0, 100));
  rec('adblock.toggleSite reloads without blocking', (await BR(`adblock.toggleSite(${bt})`)) === true);
  await sleep(1500);
  await BR(`adblock.toggleSite(${bt})`); await sleep(500);
  const ab = await BR('about()');
  rec('about() has components and licence note', ab.components.length >= 6 && /THIRD_PARTY_NOTICES/.test(ab.licenseNote) && ab.version);
  rec('settings.clearBrowsingData', (await BR('settings.clearBrowsingData({})')) === true);
  for (const m of [...br.model.tabs]) br.closeTab(m.id);

  // ---- Tor start/stop through the bridge, window fullscreen, password fill refusal, renderer crash ----
  const ts = await BR('tor.start()');
  rec('tor.start() reports connected with a SOCKS port', ts.state === 'connected' && ts.socksPort > 0 && ts.progress === 100, JSON.stringify(ts));
  const tt = (await BR('newTab({tor:true})')).id; await sleep(800);
  rec('tor.stop() closes Tor tabs and stops the daemon', (await BR('tor.stop()')) === true && !br.model.get(tt) && await waitFor(() => br.tor.state.status === 'off', 4000));
  const wasFs = br.win.isFullScreen();
  rec('windowFullscreen(bool) switches the Desktop window', (await BR(`windowFullscreen(${!wasFs})`)) === !wasFs && (await BR(`windowFullscreen(${wasFs})`)) === wasFs);
  const ct = (await BR(`newTab({url:'${base}/'})`)).id; await sleep(1500);
  rec('fillPassword refuses on an insecure page with a notice', (await BR(`fillPassword(${ct})`)) === false && (await events('notice')).some((n) => /secure pages/.test(n.text)));
  br.tabs.get(ct).wc.forcefullyCrashRenderer(); await sleep(2500);
  rec('a crashed page shows the error page inside the tab and state says crashed', /error\.html/.test(br.tabs.get(ct).wc.getURL()) && (await P('T.state')).tabs.find((t) => t.id === ct).crashed === true);
  rec('the crashed tab can still be closed', (await BR(`closeTab(${ct})`)) === true);

  // ---- Mayfair Search start page (inside tab content) ----
  const sid = (await BR('newTab({})')).id; await sleep(2500);
  const sw = br.tabs.get(sid).wc;
  rec('start page is the new tab page', /newtab\.html/.test(sw.getURL()) && (await P('T.state')).tabs.find((t) => t.id === sid).start === true);
  rec('start page has the search bridge, nothing else', (await ev(sw, 'typeof window.mfSearch + "|" + typeof window.mayfairDesktop + "|" + typeof window.require')) === 'object|undefined|undefined');
  const type = async (t) => { await ev(sw, `(()=>{const i=document.getElementById('q');i.focus();i.value=${JSON.stringify(t)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(500); };
  rec('start page panel link becomes a panel-request event', await (async () => { await ev(sw, `window.mfSearch.panel('history')`); return waitFor(async () => (await events('panel-request')).some((e) => e.panel === 'history'), 2000); })());
  await type('12*(3+4)');
  rec('calculator answer card', (await ev(sw, `(document.querySelector('.answer .big')||{}).textContent`)) === '84');
  await type('5 km to miles');
  rec('unit answer card', /3\.10686 mi/.test(await ev(sw, `(document.querySelector('.answer .big')||{}).textContent`)));
  await type('100 usd to eur');
  rec('currency answer shows its date and "not live"', /2026-10-01.*Not live/.test(await ev(sw, `(document.querySelector('.answer .note')||{}).textContent`)));
  await type('open finance');
  rec('command row offered', /Open Finance/.test(await ev(sw, `document.querySelector('.opt .t').textContent`)));
  await ev(sw, `document.getElementById('f').requestSubmit()`); await sleep(800);
  rec('Enter runs the command in the Mayfair view (deep link)', await waitFor(async () => (await events('legacy-deeplink')).some((p) => p.action === 'open' && p.path === '/finance'), 3000));
  await type('local');
  await type('cats and dogs');
  await ev(sw, `document.getElementById('f').requestSubmit()`); await sleep(1500);
  const dest = br.tabs.get(sid).wc.getURL();
  rec('Enter sends the search to the chosen engine (no scraping)', /duckduckgo\.com/.test(decodeURIComponent(dest)) && /cats/.test(decodeURIComponent(dest)), decodeURIComponent(dest).slice(0, 120));
  br.closeTab(sid);
  const sid2 = (await BR('newTab({})')).id; await sleep(2000);
  await shot('07-start-page-in-cloud-window');
  br.closeTab(sid2);

  // ---- error page inside the tab ----
  const et = (await BR(`newTab({url:'http://127.0.0.1:9/'})`)).id; await sleep(2500);
  rec('unreachable page shows the error page inside the tab', /error\.html/.test(br.tabs.get(et).wc.getURL()));
  await shot('08-error-in-tab');
  br.closeTab(et);

  // ---- extensions (real packages from test/fixtures/ext, download replaced by a file read) ----
  const fx = path.join(__dirname, '..', 'test', 'fixtures', 'ext');
  const idx = JSON.parse(fs.readFileSync(path.join(fx, 'index.json'), 'utf8'));
  br.fetchBuffer = async (u) => fs.readFileSync(path.join(fx, path.basename(new URL(u).pathname)));
  const blockedBefore = br.blocker.size;
  const res = [];
  for (const x of idx.extensions) res.push(await BR(`extensions.install('${x.id}','https://cloud.mayfairmail.com/ext/${x.file}','${x.sha256}')`));
  rec('all nine extensions install through the browser bridge', res.every((r) => r.ok), res.filter((r) => !r.ok).map((r) => r.error).join('; '));
  rec('seven are loaded into the browser session by Chromium', br.extIds.size === 7, [...br.extIds.keys()].sort().join() + ' errors: ' + (br.extErrors || []).join(' | '));
  rec('Tracker blocker rules applied natively (basic list grew)', br.blocker.size > blockedBefore, blockedBefore + ' -> ' + br.blocker.size);
  rec('extensions.list reports nine, legacy list too', (await BR('extensions.list()')).length === 9 && (await P('window.mayfairDesktop.listExtensions()')).length === 9);
  rec('bad hash refused', (await BR(`extensions.install('deals','https://cloud.mayfairmail.com/ext/deals-1.0.0.zip','${'f'.repeat(64)}')`)).ok === false);
  rec('legacy installExtension refuses a foreign host', (await P(`window.mayfairDesktop.installExtension('deals','https://evil.example/x.zip','${'f'.repeat(64)}')`)).ok === false);
  rec('extensions.remove unloads and deletes', (await BR(`extensions.remove('deals')`)) === true && br.extIds.size === 6);

  // ---- session restore ----
  const rt1 = (await BR(`newTab({url:'${base}/r1'})`)).id; const rt2 = (await BR(`newTab({url:'${base}/r2'})`)).id; await sleep(1500);
  rec('open tab addresses are saved for restore', JSON.stringify(br.tabsStore.data.urls) === JSON.stringify([base + '/r1', base + '/r2']), JSON.stringify(br.tabsStore.data.urls));
  br.restoreList = [...br.tabsStore.data.urls];
  await BR(`settings.set({startup:'restore'})`);
  const rd2 = await BR('ready()');
  rec('ready() hands over the restore list once', rd2.restore.length === 2 && (await BR('ready()')).restore.length === 0);
  await BR(`settings.set({startup:'start'})`);
  br.flushAll();
  rec('tab list and settings flushed to disk', fs.existsSync(path.join(br.dir, 'tabs.json')) && fs.existsSync(path.join(br.dir, 'settings.json')));

  // ---- screenshots of the whole window at two sizes and themes ----
  nativeTheme.themeSource = 'light'; await sleep(300); await shot('09-light-theme'); nativeTheme.themeSource = 'system';

  const total = results.length, badOnes = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, `${TAG}-results.json`), JSON.stringify(results, null, 2));
  console.log(`SMOKE DONE ${total - badOnes.length}/${total} passed`);
  server.close();
  br.quitting = true;
  setTimeout(() => app.exit(badOnes.length ? 1 : 0), 300);
}
module.exports = { run };
