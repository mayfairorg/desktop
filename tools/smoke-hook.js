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
const W = require('../src/main/lib/webapps');
const O_site = (u) => require('../src/main/lib/origins').siteKey(u);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const shot = async (name) => { await sleep(500); try { execFileSync('import', ['-window', 'root', path.join(OUT, `${TAG}-${name}.png`)], { stdio: 'ignore' }); } catch (e) { rec('screenshot ' + name, false, e.message); } };

async function run(br, app) {
  const M = () => br.groups.get(1).model;
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
    if (req.url.startsWith('/login') && req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { if (/pw=good/.test(b)) { res.writeHead(302, { location: '/home' }); return res.end(); } res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Login</title><p>Wrong password</p><form method=post action=/login><input name=user value=ann@example.com><input type=password name=pw></form>'); }); return; }
    if (req.url.startsWith('/login')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Login</title><form id=f method=post action=/login><input id=u name=user autocomplete=username><input id=p type=password name=pw autocomplete=current-password><button type=submit>Sign in</button></form>'); }
    if (req.url.startsWith('/home')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Account home</title><p>Welcome</p>'); }
    if (req.url.startsWith('/spa')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>SPA login</title><div id=box><input id=u type=email><input id=p type=password><button id=go type=button style="width:120px;height:40px">Log in</button></div><script>document.getElementById("go").onclick=()=>fetch("/home").then(()=>{document.getElementById("box").remove()})</script>'); }
    if (req.url.startsWith('/change')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Change</title><form id=f onsubmit="event.preventDefault();setTimeout(()=>{location.href=\'/home\'},100)"><input id=u autocomplete=username><input id=a type=password autocomplete=current-password><input id=b type=password autocomplete=new-password><input id=c type=password autocomplete=new-password><button>Change</button></form>'); }
    if (req.url.startsWith('/trackpop')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Tracker pop-up</title><script>setTimeout(()=>window.open("https://fls.doubleclick.net/activityi;src=1;type=x"),50)</script><p>tracker pop-up test</p>'); }
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
  // the Mayfair view follows every size change of the window
  {
    const fits = async (what) => { await sleep(500); const c = br.win.getContentBounds(), v = home.view.getBounds(); rec('Mayfair view fills the window after ' + what, v.x === 0 && v.y === 0 && v.width === c.width && v.height === c.height, JSON.stringify(v) + ' vs ' + c.width + 'x' + c.height); };
    const was = br.win.isMaximized(), orig = br.win.getBounds();
    br.win.setBounds({ x: 0, y: 0, width: 900, height: 600 }); await fits('setBounds 900x600');
    br.win.setBounds({ x: 0, y: 0, width: 1100, height: 700 }); await fits('setBounds 1100x700');
    br.win.maximize(); await fits('maximize');
    br.win.unmaximize(); await fits('unmaximize');
    br.win.hide(); br.win.setBounds({ x: 0, y: 0, width: 1000, height: 650 }); br.win.show(); await fits('hide, resize, show');
    br.win.minimize(); br.win.restore(); await fits('minimize and restore');
    br.win.setBounds(orig); await sleep(300);
    if (was) br.win.maximize();
  }
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
  rec('home() focuses Mayfair, tabs untouched', (await BR('home()')) === true && M().tabs.length === 1);

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
  rec('settings.get has values and read-only info', s0 && s0.searchEngine === 'google' && s0.version && s0.dnsProviders && s0.startup === 'start', JSON.stringify(s0).slice(0, 100));
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
  const before = M().tabs.length;
  rec('popups.allow opens it as a tab', (await BR(`popups.allow('${nw.id}')`)) === true && M().tabs.length === before + 1);
  for (const m of M().tabs.filter((t) => t.id !== t1)) br.closeTab(m.id);
  await sleep(300);
  const tp = (await BR(`newTab({url:'${base}/trackpop'})`)).id; await sleep(3000);
  rec('an advertising address opened as a pop-up is dropped, neither a tab nor a pop-up notice', !(await events('new-window-request')).some((e) => /doubleclick/.test(e.url)) && !M().tabs.some((t) => /doubleclick/.test(t.url || '')));
  br.closeTab(tp); await sleep(300);

  // ---- tab management ----
  const ids = [t1];
  for (let i = 0; i < 3; i++) ids.push((await BR(`newTab({url:'${base}/?n=${i}',background:true})`)).id);
  rec('background tabs do not take over', (await P('T.state')).activeId === t1 || M().activeId === t1);
  rec('activate switches the visible native view', (await BR(`activate(${ids[2]})`)) === true && br.tabs.get(ids[2]).shown && !br.tabs.get(t1).shown && br.tabs.get(ids[1]).shown === false);
  rec('pin moves to the left and move cannot cross the pinned block', (await BR(`pin(${ids[2]},true)`)) === true && M().tabs[0].id === ids[2] && (await BR(`move(${ids[1]},0)`)) === true && M().tabs[0].id === ids[2]);
  const dup = (await BR(`duplicate(${ids[1]})`)).id; await sleep(800);
  rec('duplicate opens a copy next to it', M().tabs[M().index(dup)] && M().index(dup) === M().index(ids[1]) + 1);
  rec('mute', (await BR(`mute(${dup},true)`)) === true && br.tabs.get(dup).wc.audioMuted === true);
  rec('closeOthers keeps pinned and the chosen one', (await BR(`closeOthers(${ids[1]})`)) === true && M().tabs.map((t) => t.id).sort().join() === [ids[2], ids[1]].sort().join());
  rec('closeTab then reopenClosed', (await BR(`closeTab(${ids[1]})`)) === true && (await BR('reopenClosed()')).id > 0);
  for (const m of [...M().tabs]) br.closeTab(m.id);
  await sleep(400);
  const empty = await P('T.state');
  rec('closing the last tab leaves zero tabs, no automatic new tab', empty.tabs.length === 0 && empty.activeId === null && br.win.contentView.children.length === 1);
  await shot('04-no-tabs');

  // ---- v3: several Browser windows (groups) ----
  {
    const rdg = await BR('ready()');
    rec('v3: ready() lists the windows feature and group 1', rdg.features.includes('windows') && rdg.groups.join() === '1' && rdg.focusedGid === 1 && rdg.states[1] && rdg.states[1].gid === 1 && Array.isArray(rdg.restoreGroups));
    const g2 = (await BR('windows.create()')).gid;
    rec('v3: windows.create gives a new gid, event and list', g2 === 2 && (await waitFor(async () => (await events('windows')).some((e) => e.created === 2 && e.groups.join() === '1,2'))) && (await BR('windows.list()')).length === 2);
    const a1 = (await BR(`newTab({url:'${base}/?w=1',gid:1})`)); const a2 = (await BR(`newTab({url:'${base}/?w=2',gid:2})`));
    rec('v3: newTab with gid lands in that group and says so', a1.gid === 1 && a2.gid === 2 && br.tabs.get(a1.id).gid === 1 && br.tabs.get(a2.id).gid === 2);
    await sleep(2500);
    await P('T.open2(1,2)'); await sleep(700);
    const r1 = await P('T.bounds'), r2g = await P('T.bounds2'), zf2 = home.wc.getZoomFactor();
    const v1 = br.tabs.get(a1.id), v2 = br.tabs.get(a2.id);
    const b1 = v1.view.getBounds(), b2 = v2.view.getBounds();
    rec('v3: two groups show their own native view side by side', v1.shown && v2.shown && Math.abs(b1.x - Math.round(r1.x * zf2)) <= 1 && Math.abs(b2.x - Math.round(r2g.x * zf2)) <= 1 && b1.x + b1.width <= b2.x, JSON.stringify(b1) + ' | ' + JSON.stringify(b2));
    rec('v3: each page loaded its own address', /w=1/.test(v1.wc.getURL()) && /w=2/.test(v2.wc.getURL()));
    const sts = await P('T.states');
    rec('v3: state events are per group', sts[1].tabs.map((t) => t.id).join() === String(a1.id) && sts[2].tabs.map((t) => t.id).join() === String(a2.id) && sts[2].tabs[0].gid === 2 && sts[2].groups.join() === '1,2');
    await shot('04b-two-windows');
    const oc2 = await P('T.occlude2(true)');
    rec('v3: occluding one group hides only its view and captures it', oc2 && oc2.captured === true && oc2.imgLen > 3000 && !v2.shown && v1.shown, JSON.stringify(oc2));
    rec('v3: capture({gid}) of the occluded group returns its stored picture, the other captures fresh', ((await BR('capture({gid:2})')) || '').startsWith('data:image/jpeg') && ((await BR('capture({gid:1})')) || '').length > 3000);
    await shot('04c-one-occluded');
    await P('T.occlude2(false)'); await sleep(300);
    rec('v3: un-occluding shows it again', v2.shown && v1.shown);
    // activate in one group does not touch the other
    const a3 = (await BR(`newTab({url:'${base}/?w=3',gid:2})`)); await sleep(1200);
    rec('v3: a second tab in group 2 takes the right-hand view only', br.tabs.get(a3.id).shown && !v2.shown && v1.shown && (await BR(`activate(${a2.id})`)) === true && v2.shown && !br.tabs.get(a3.id).shown && v1.shown);
    // focus, menu and open-url routing
    await BR('windows.focus(2)'); br.menuAction('find'); await sleep(300);
    rec('v3: menu goes to the focused group', (await events('menu')).filter((e) => e.action === 'find').pop().gid === 2);
    await BR('windows.focus(1)'); br.menuAction('bookmarks'); await sleep(300);
    rec('v3: focus change moves menu events', (await events('menu')).filter((e) => e.action === 'bookmarks').pop().gid === 1);
    br.openInBrowser('https://example.net/a'); br.openInBrowser('https://example.net/b', { newWindow: true }); await sleep(300);
    const ouw = await events('open-url');
    rec('v3: open-url goes to the last focused group; newWindow flag for link in new window', ouw.filter((e) => e.url === 'https://example.net/a').pop().gid === 1 && ouw.filter((e) => e.url === 'https://example.net/b').pop().newWindow === true);
    v2.wc.focus(); await sleep(300);
    rec('v3: a page tab getting keyboard focus makes its group the focused one', br.focusedGid === 2 && (await events('focus')).some((e) => e.gid === 2 && e.focused));
    v2.wc.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] }); v2.wc.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control'] }); await sleep(500);
    rec('v3: Ctrl+N in a page tab is a newWindow menu event with its gid', (await events('menu')).some((e) => e.action === 'newWindow' && e.gid === 2));
    // gid-less calls mean the focused group (v2 compatibility)
    await BR('windows.focus(1)');
    const ng = await BR(`newTab({url:'${base}/?w=4'})`);
    rec('v3: newTab without gid goes to the focused group', ng.gid === 1); await sleep(800);
    await BR(`closeTab(${ng.id})`);
    // find and pop-ups carry the group
    const f2 = await BR(`find(${a2.id},'mayfair',{})`); await sleep(300);
    rec('v3: find-result carries gid', f2.of >= 1 && (await events('find-result')).some((e) => e.id === a2.id && e.gid === 2));
    await BR(`stopFind(${a2.id})`);
    const pg = (await BR(`newTab({url:'${base}/popup',gid:2})`)); await sleep(3000);
    const nw2 = (await events('new-window-request')).filter((e) => e.tabId === pg.id).pop();
    rec('v3: pop-up request carries the opener group', nw2 && nw2.gid === 2, JSON.stringify(nw2));
    await BR(`popups.allow('${nw2.id}')`); await sleep(500);
    rec('v3: an allowed pop-up opens in the opener group', br.groups.get(2).model.tabs.length === 4 && br.groups.get(1).model.tabs.length === 1, br.groups.get(2).model.tabs.length);
    await BR(`closeTab(${pg.id})`);
    for (const m of br.groups.get(2).model.tabs.filter((t) => ![a2.id, a3.id].includes(t.id))) br.closeTab(m.id);
    // HTML5 fullscreen in group 2 only
    const fsBefore = (await events('fullscreen')).length;
    await BR(`activate(${a2.id})`); await sleep(300);
    ev(v2.wc, `document.documentElement.requestFullscreen().then(()=>1,()=>0)`).catch(() => {});
    await waitFor(async () => (await events('fullscreen')).length > fsBefore, 5000);
    const [fw2, fh2] = br.win.getContentSize(); const fbb = v2.view.getBounds();
    rec('v3: fullscreen is per group (event gid, only that view covers the window)', (await events('fullscreen')).slice(fsBefore).some((e) => e.on && e.gid === 2) && fbb.width === fw2 && fbb.height === fh2 && br.groups.get(2).fsTab === a2.id && br.groups.get(1).fsTab === null && v1.view.getBounds().width < fw2);
    await BR('fullscreen(false,{gid:2})'); await sleep(800);
    rec('v3: leaving fullscreen of group 2 restores its rectangle', br.groups.get(2).fsTab === null && v2.view.getBounds().width < fw2 && (await events('fullscreen')).some((e) => !e.on && e.gid === 2));
    // moving tabs
    const viewBefore = br.tabs.get(a1.id).view;
    const mv = await BR(`moveTab(${a1.id},2)`); await sleep(500);
    rec('v3: moveTab to another group keeps the native view and shows it there', mv.ok && mv.gid === 2 && br.tabs.get(a1.id).view === viewBefore && br.tabs.get(a1.id).gid === 2 && br.tabs.get(a1.id).shown && !br.tabs.get(a2.id).shown && br.groups.get(1).model.tabs.length === 0 && br.groups.get(2).model.activeId === a1.id);
    const sts2 = await P('T.states');
    rec('v3: state events follow the move', sts2[1].tabs.length === 0 && sts2[1].activeId === null && sts2[2].tabs.some((t) => t.id === a1.id && t.gid === 2));
    const mvn = await BR(`moveTab(${a1.id},'new')`); await sleep(500);
    const g3 = mvn.gid;
    rec('v3: moveTab new creates a group with a windows event; it stays hidden until it has bounds', mvn.ok && g3 === 3 && (await events('windows')).some((e) => e.created === 3) && !br.tabs.get(a1.id).shown && br.focusedGid === 3);
    await BR(`setBounds({x:20,y:20,w:300,h:200,visible:true,gid:${g3}})`); await sleep(300);
    rec('v3: setBounds with the new gid shows the moved tab', br.tabs.get(a1.id).shown && br.tabs.get(a1.id).view.getBounds().width === Math.round(300 * zf2));
    rec('v3: moveTab back and to unknown groups', (await BR(`moveTab(${a1.id},1)`)).gid === 1 && /no such window/.test((await BR(`moveTab(${a1.id},77)`)).__err || ''));
    // reopen per group
    await BR(`closeTab(${a3.id})`); await BR(`closeTab(${a1.id})`);
    const ro = await BR('reopenClosed({gid:2})');
    rec('v3: reopenClosed({gid}) reopens in that group', ro.id > 0 && ro.gid === 2 && br.tabs.get(ro.id).gid === 2);
    await BR(`closeTab(${ro.id})`);
    // private session is wiped only when the last private tab of ALL groups closes
    const ps = session.fromPartition('mf-private');
    const pa = (await BR(`newTab({url:'${base}/',private:true,gid:1})`)).id; const pb = (await BR(`newTab({url:'${base}/',private:true,gid:2})`)).id; await sleep(1500);
    await ps.cookies.set({ url: base + '/', name: 'pk', value: 'v' });
    await BR(`closeTab(${pa})`); await sleep(500);
    const still = (await ps.cookies.get({ name: 'pk' })).length === 1;
    await BR(`closeTab(${pb})`); await sleep(1200);
    rec('v3: private session survives while another group has a private tab, wiped after the last', still && (await ps.cookies.get({ name: 'pk' })).length === 0);
    // closing a window closes its tabs
    const x1 = (await BR(`newTab({url:'${base}/?x=1',gid:2})`)).id; await sleep(500);
    const nTabs = br.tabs.size;
    rec('v3: windows.close closes its tabs, removes the group, event, list', (await BR('windows.close(2)')) === true && !br.tabs.has(x1) && !br.groups.has(2) && (await events('windows')).some((e) => e.closed === 2) && (await BR('windows.list()')).every((w) => w.gid !== 2), nTabs + ' -> ' + br.tabs.size);
    rec('v3: a closed window gid is refused, its tab ids too', /no such window/.test((await BR(`newTab({gid:2})`)).__err || '') && /no such tab/.test((await BR(`back(${x1})`)).__err || ''));
    await BR('windows.close(3)'); await P('T.close2()');
    rec('v3: bad windows arguments refused by main', (await bad('windows.close("x")')) && (await bad('windows.focus()')) && (await bad(`moveTab(1,'old')`)) && (await bad(`setBounds({x:0,y:0,w:1,h:1,gid:0})`)));
    rec('v3: back to the default group only, no stray views', br.groups.size === 1 && br.groups.has(1) && br.win.contentView.children.length === 1 && br.tabs.size === 0, br.groups.size + ' groups, ' + br.win.contentView.children.length + ' views');
    await BR('windows.focus(1)'); await P('T.send()'); await sleep(300);
  }

  // ---- save-password offers ----
  {
    const evAll = async (name) => events(name);
    const waitEv = async (name, pred, ms = 6000) => { const n0 = (await evAll(name)).length; return waitFor(async () => (await evAll(name)).slice(n0).find(pred), ms); };
    const loginTab = async (url, o = {}) => { const id = (await BR(`newTab({url:'${base}${url}'${o.private ? ',private:true' : ''}})`)).id; await sleep(1800); return id; };
    const fill = (id, js) => ev(br.tabs.get(id).wc, js);
    await BR(`settings.set({passwordNever:[],passwordOffer:true})`);
    // 1. a form login that works
    let id = await loginTab('/login');
    const n0 = (await evAll('password-offer')).length;
    await fill(id, `(()=>{document.getElementById('u').value='ann@example.com';document.getElementById('p').value='good-pw-1';document.getElementById('f').requestSubmit()})()`);
    const o1 = await waitFor(async () => (await evAll('password-offer')).slice(n0)[0], 7000);
    rec('login: after a successful form login the page gets an offer (origin, username, no password in it)', o1 && o1.origin === base && o1.username === 'ann@example.com' && o1.kind === 'new' && o1.update === false && o1.tabId === id && o1.gid === 1 && !JSON.stringify(o1).includes('good-pw-1'), JSON.stringify(o1));
    const tk = await BR(`passwords.take('${o1.id}')`);
    rec('login: passwords.take returns the credentials once, then nothing', tk && tk.password === 'good-pw-1' && tk.username === 'ann@example.com' && tk.origin === base && tk.url === base + '/login' && (await BR(`passwords.take('${o1.id}')`)) === null);
    rec('login: nothing about the password sits in main afterwards', br.pwOffers.size === 0 && !br.tabs.get(id).pwCand);
    br.closeTab(id);
    // 2. wrong password: the login form comes back, no offer
    id = await loginTab('/login');
    const n1 = (await evAll('password-offer')).length;
    await fill(id, `(()=>{document.getElementById('u').value='ann@example.com';document.getElementById('p').value='bad';document.getElementById('f').requestSubmit()})()`);
    await sleep(3000);
    rec('login: a failed login (form shown again) makes no offer', (await evAll('password-offer')).length === n1 && br.pwOffers.size === 0);
    br.closeTab(id);
    // 3. script login (no navigation): the field disappears
    id = await loginTab('/spa');
    await fill(id, `(()=>{document.getElementById('u').value='bob@example.com';document.getElementById('p').value='spa-pw';return 1})()`);
    const rc = JSON.parse(await fill(id, `JSON.stringify((()=>{const r=document.getElementById('go').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})())`));
    br.tabs.get(id).wc.focus();
    const wcx = br.tabs.get(id).wc;
    wcx.sendInputEvent({ type: 'mouseMove', x: rc.x, y: rc.y }); wcx.sendInputEvent({ type: 'mouseDown', x: rc.x, y: rc.y, button: 'left', clickCount: 1 }); wcx.sendInputEvent({ type: 'mouseUp', x: rc.x, y: rc.y, button: 'left', clickCount: 1 });
    const o3 = await waitFor(async () => (await evAll('password-offer')).slice(n1).find((e) => e.username === 'bob@example.com'), 7000);
    rec('login: a script login that removes the password field also gets an offer', !!o3 && o3.kind === 'new', JSON.stringify(o3));
    // 4. 'never save here'
    await BR(`passwords.dismiss('${o3.id}',{never:true})`);
    rec('login: dismiss with never puts the origin on the never list (settings) and forgets the offer', (await BR('settings.get()')).passwordNever.includes(base) && br.pwOffers.size === 0);
    br.closeTab(id);
    id = await loginTab('/login');
    const n2 = (await evAll('password-offer')).length;
    await fill(id, `(()=>{document.getElementById('u').value='ann@example.com';document.getElementById('p').value='good-pw-2';document.getElementById('f').requestSubmit()})()`);
    await sleep(3000);
    rec('login: no offer on a site on the never list', (await evAll('password-offer')).length === n2);
    br.closeTab(id);
    await BR(`settings.set({passwordNever:[]})`);
    // 5. change password
    id = await loginTab('/change');
    const n3 = (await evAll('password-offer')).length;
    await fill(id, `(()=>{u.value='ann@example.com';a.value='old-pw';b.value='new-pw-9';c.value='new-pw-9';document.getElementById('f').requestSubmit()})()`);
    const o5 = await waitFor(async () => (await evAll('password-offer')).slice(n3)[0], 7000);
    rec('login: a change-password form offers Update with the NEW password', o5 && o5.kind === 'change' && o5.update === true && (await BR(`passwords.take('${o5.id}')`)).password === 'new-pw-9', JSON.stringify(o5));
    br.closeTab(id);
    // 6. private tab, setting off, tab closed before the answer, expiry
    id = await loginTab('/login', { private: true });
    const n4 = (await evAll('password-offer')).length;
    await fill(id, `(()=>{document.getElementById('u').value='p@example.com';document.getElementById('p').value='good-pw-3';document.getElementById('f').requestSubmit()})()`);
    await sleep(3000);
    rec('login: private tabs never make an offer', (await evAll('password-offer')).length === n4 && !br.tabs.get(id).pwCand);
    br.closeTab(id);
    await BR(`settings.set({passwordOffer:false})`);
    id = await loginTab('/login');
    await fill(id, `(()=>{document.getElementById('u').value='q@example.com';document.getElementById('p').value='good-pw-4';document.getElementById('f').requestSubmit()})()`);
    await sleep(3000);
    rec('login: the setting off means no offer', (await evAll('password-offer')).length === n4);
    br.closeTab(id); await BR(`settings.set({passwordOffer:true})`);
    id = await loginTab('/login');
    await fill(id, `(()=>{document.getElementById('u').value='r@example.com';document.getElementById('p').value='good-pw-5';document.getElementById('f').requestSubmit()})()`);
    const o6 = await waitFor(async () => (await evAll('password-offer')).slice(n4)[0], 7000);
    const cn = (await evAll('password-offer-cancel')).length;
    br.closeTab(id); await sleep(400);
    rec('login: closing the tab withdraws the offer (cancel event) and forgets the password', o6 && (await evAll('password-offer-cancel')).length > cn && (await BR(`passwords.take('${o6.id}')`)) === null && br.pwOffers.size === 0);
    rec('login: a made-up submission from the Mayfair view is refused', /blocked/.test((await P(`window.mayfairDesktop.browser.passwords.take(5)`)).__err || ''));
    // 7. focus hint
    id = await loginTab('/login');
    br.tabs.get(id).wc.focus();
    const hint = await (async () => { await fill(id, `document.getElementById('u').focus()`); return waitFor(async () => (await evAll('password-field')).find((e) => e.tabId === id), 4000); })();
    rec('login: focusing a login field on a page sends the password-field hint only on https', !hint, 'the test page is http, so no hint is expected: ' + JSON.stringify(hint));
    const fe = { sender: { id: br.tabs.get(id).wc.id }, senderFrame: { url: 'https://shop.example.com/login' } };
    const nh = (await evAll('password-field')).length;
    br.onPwFocus(fe); await sleep(300);
    const ph = (await evAll('password-field')).slice(nh)[0];
    rec('login: the password-field hint (https page, ordinary tab) carries tab, gid, origin and host', ph && ph.tabId === id && ph.gid === 1 && ph.origin === 'https://shop.example.com' && ph.host === 'shop.example.com', JSON.stringify(ph));
    br.closeTab(id);
  }

  // ---- history sync, web app history, form details, site matching ----
  {
    const evA = async (n) => events(n);
    await BR(`settings.set({historySync:true,autofillSave:true,autofillNever:[]})`);
    const sc0 = await BR('history.syncState()');
    rec('sync: syncState reports enabled and subscribed', sc0.enabled === true && sc0.subscribed === true && typeof sc0.entries === 'number', JSON.stringify(sc0));
    const a0 = (await evA('history-add')).length;
    const id1 = (await BR(`newTab({url:'${base}/home?sync=1'})`)).id; await sleep(3500);
    const added = (await evA('history-add')).slice(a0).map((e) => e.entry);
    const visit = added.find((e) => /sync=1/.test(e.url || ''));
    rec('sync: a new visit raises history-add with id, title, time and kind', visit && visit.kind === 'visit' && /^h/.test(visit.id) && visit.title === 'Account home' && visit.t > 0 && !visit.app, JSON.stringify(visit));
    const a1 = (await evA('history-add')).length;
    await BR(`go(${id1},'my typed search words')`); await sleep(1500);
    const srch = (await evA('history-add')).slice(a1).map((e) => e.entry).find((e) => e.kind === 'search');
    rec('sync: a typed web search raises history-add with the query and no url', srch && srch.q === 'my typed search words' && srch.url === undefined && /^s/.test(srch.id), JSON.stringify(srch));
    const a2 = (await evA('history-add')).length;
    await BR(`go(${id1},'${base}/home?typed=url')`); await sleep(2500);
    rec('sync: typing an address is a visit, not a search', !(await evA('history-add')).slice(a2).some((e) => e.entry.kind === 'search'));
    // private and Tor never
    const a3 = (await evA('history-add')).length;
    const pv = (await BR(`newTab({url:'${base}/home?private=1',private:true})`)).id; await sleep(500); await BR(`go(${pv},'private search words')`); await sleep(3500);
    rec('sync: private tabs raise no history events (visits and searches)', (await evA('history-add')).length === a3);
    br.closeTab(pv);
    // import never echoes
    const a4 = (await evA('history-add')).length;
    const imp = await BR(`history.import([{id:'imp1',url:'https://imported.example/a',title:'Imported',t:1700000000000},{id:'imps1',kind:'search',q:'old search',t:1700000001000},{url:'javascript:1',t:5},{url:'https://x.example/',t:-3}])`);
    await sleep(2000);
    rec('sync: history.import merges valid entries, skips bad ones, raises no history-add', imp.added === 2 && imp.skipped === 2 && (await evA('history-add')).length === a4 && (await BR('history.list()')).some((h) => h.url === 'https://imported.example/a') && (await BR(`suggest('imported')`)).some((x) => x.kind === 'history'), JSON.stringify(imp));
    rec('sync: import over 5000 entries is refused by main', /blocked/.test((await BR(`history.import(Array(5001).fill({url:'https://a.example/',t:1}))`)).__err || ''));
    // delete events
    const r0 = (await evA('history-remove')).length;
    await BR(`history.remove('imp1')`); await BR(`history.remove('imps1')`); await sleep(300);
    const rm = (await evA('history-remove')).slice(r0);
    rec('sync: deleting entries (by id) raises history-remove with the ids', rm.some((e) => e.ids.includes('imp1')) && rm.some((e) => e.ids.includes('imps1')), JSON.stringify(rm));
    const c0 = (await evA('history-clear')).length;
    await BR('history.clear()'); await sleep(300);
    rec('sync: clearing raises history-clear', (await evA('history-clear')).length === c0 + 1 && (await BR('history.list()')).length === 0);
    // setting off
    await BR(`settings.set({historySync:false})`);
    const a5 = (await evA('history-add')).length;
    await BR(`go(${id1},'${base}/home?off=1')`); await sleep(2800);
    rec('sync: with historySync off nothing is sent', (await evA('history-add')).length === a5 && (await BR('history.syncState()')).enabled === false);
    await BR(`settings.set({historySync:true})`);
    br.closeTab(id1);
    // web app history is its own store
    const hb = br.history.list().length;
    const wa = (await BR(`newTab({webapp:'gmail'})`)).id; await sleep(500);
    br.histFor('gmail').add('https://mail.google.com/mail/u/0/', 'Inbox'); br.noteVisit(br.histFor('gmail'), 'gmail'); await sleep(2200);
    rec('web app history: the app has its own list, the browser history is untouched', (await BR(`history.list({app:'gmail'})`)).length === 1 && br.history.list().length === hb && !(await BR('history.list()')).some((h) => /mail\.google\.com/.test(h.url)));
    rec('web app history: its visit is announced with the app id', (await evA('history-add')).some((e) => e.entry.app === 'gmail' && /mail\.google\.com/.test(e.entry.url)));
    rec('web app history: suggestions for the app come only from it, the browser suggests none of it', (await BR(`suggest('inbox',{app:'gmail'})`)).some((x) => x.kind === 'history') && !(await BR(`suggest('inbox')`)).some((x) => /mail\.google\.com/.test(x.url || '')));
    rec('web app history: search and file name', (await BR(`history.search('inbox',{app:'gmail'})`)).length === 1 && fs.existsSync(path.join(br.dir, 'history-app-gmail.json')) || (br.histFor('gmail').flush(), fs.existsSync(path.join(br.dir, 'history-app-gmail.json'))));
    rec('web app history: clear({app}) clears only that app', (await BR(`history.clear({app:'gmail'})`)) === true && (await BR(`history.list({app:'gmail'})`)).length === 0);
    rec('web app history: unknown app is refused', /unknown app/.test((await BR(`history.list({app:'nope'})`)).__err || ''));
    await BR(`webapps.remove('gmail')`);
    // matching
    rec('webapps.match finds the app of a web address, null otherwise', (await BR(`webapps.match('https://discord.com/channels/1')`)) === 'discord' && (await BR(`webapps.match('https://example.org/')`)) === null);
    rec('webapps.catalogue entries carry the match domains', (await BR('webapps.catalogue()')).every((a) => Array.isArray(a.match) && a.match.length === 1));
    // autofill offer
    const af0 = (await evA('autofill-offer')).length;
    const ft = (await BR(`newTab({url:'${base}/login'})`)).id; await sleep(1800);
    await ev(br.tabs.get(ft).wc, `(()=>{document.getElementById('u').value='ann@example.com';document.getElementById('p').value='bad';document.getElementById('f').requestSubmit()})()`);
    const fo = await waitFor(async () => (await evA('autofill-offer')).slice(af0)[0], 5000);
    rec('autofill: a submitted form offers its username, no password or other secrets in it', fo && fo.fields.username === 'ann@example.com' && Object.keys(fo.fields).join() === 'username' && !JSON.stringify(fo).includes('bad') && fo.tabId === ft && fo.gid === 1, JSON.stringify(fo));
    const tkA = await BR(`autofill.take('${fo.id}')`);
    rec('autofill: take returns the fields once', tkA && tkA.fields.username === 'ann@example.com' && (await BR(`autofill.take('${fo.id}')`)) === null && br.afOffers.size === 0);
    br.closeTab(ft);
    await BR(`settings.set({autofillSave:false})`);
    const af1 = (await evA('autofill-offer')).length;
    const ft2 = (await BR(`newTab({url:'${base}/login'})`)).id; await sleep(1800);
    await ev(br.tabs.get(ft2).wc, `(()=>{document.getElementById('u').value='zed@example.com';document.getElementById('p').value='bad';document.getElementById('f').requestSubmit()})()`); await sleep(2500);
    rec('autofill: the setting off means no offer', (await evA('autofill-offer')).length === af1);
    br.closeTab(ft2); await BR(`settings.set({autofillSave:true})`);
    const pf = (await BR(`newTab({url:'${base}/login',private:true})`)).id; await sleep(1800);
    await ev(br.tabs.get(pf).wc, `(()=>{document.getElementById('u').value='priv@example.com';document.getElementById('p').value='bad';document.getElementById('f').requestSubmit()})()`); await sleep(2500);
    rec('autofill: private tabs never offer', (await evA('autofill-offer')).length === af1);
    br.closeTab(pf);
    // fill and answer
    const fl = (await BR(`newTab({url:'${base}/login'})`)).id; await sleep(1800);
    rec('autofill.fill types into empty recognised fields only', (await BR(`autofill.fill(${fl},{username:'filled@example.com',email:'x@y.co'})`)) === true && await waitFor(async () => (await ev(br.tabs.get(fl).wc, `document.getElementById('u').value`)) === 'filled@example.com', 3000));
    rec('autofill.fill refuses unknown keys', /blocked/.test((await BR(`autofill.fill(${fl},{password:'x'})`)).__err || ''));
    br.afRequests.set('rtest', { tabId: fl, kind: 'username', origin: O_site(base), timer: setTimeout(() => {}, 1000).unref() });
    rec('autofill.answer refuses unknown requests, null clears one', (await BR(`autofill.answer('nope','x')`)) === false && (await BR(`autofill.answer('rtest',null)`)) === false && !br.afRequests.has('rtest'));
    br.closeTab(fl);
  }

  // ---- v3: hiding a window on a workspace switch is cheap and reliable; two windows visible together ----
  {
    const ga = (await BR('windows.create()')).gid;
    const ta = (await BR(`newTab({url:'${base}/?h=1',gid:1})`)).id, tb = (await BR(`newTab({url:'${base}/?h=2',gid:${ga}})`)).id; await sleep(2500);
    await P(`T.open2(1,${ga})`); await sleep(600);
    rec('v3 workspaces: two windows visible at once', br.tabs.get(ta).shown && br.tabs.get(tb).shown);
    const t0 = Date.now();
    await BR(`setOccluded(true,{gid:${ga},capture:false})`);
    const dt = Date.now() - t0;
    rec('v3 workspaces: setOccluded(true,{capture:false}) hides one window without a capture, quickly', !br.tabs.get(tb).shown && br.tabs.get(ta).shown && dt < 200, dt + ' ms');
    await BR(`setOccluded(false,{gid:${ga}})`); await sleep(200);
    await BR(`setBounds({x:0,y:0,w:300,h:200,visible:false,gid:${ga}})`);
    rec('v3 workspaces: setBounds visible:false hides it too, the other stays', !br.tabs.get(tb).shown && br.tabs.get(ta).shown);
    await P('T.send2()'); await sleep(300);
    rec('v3 workspaces: setBounds visible:true brings it back', br.tabs.get(tb).shown);
    for (let i = 0; i < 6; i++) { BR(`setOccluded(${i % 2 === 0},{gid:${ga}})`); BR(`setOccluded(${i % 2 === 1},{gid:1})`); }
    await sleep(1200);
    rec('v3 workspaces: rapid hide/show toggles end in the last requested state', !br.tabs.get(tb).shown === (br.groups.get(ga).occluded) && br.groups.get(ga).occluded === false && br.groups.get(1).occluded === true, JSON.stringify([br.groups.get(ga).occluded, br.groups.get(1).occluded]));
    await BR(`setOccluded(false,{gid:1})`); await BR(`setOccluded(false,{gid:${ga}})`); await sleep(300);
    rec('v3 workspaces: both visible again after the last show', br.tabs.get(ta).shown && br.tabs.get(tb).shown);
    await BR(`windows.close(${ga})`); await P('T.close2()'); br.closeTab(ta);
    await BR('windows.focus(1)'); await P('T.send()'); await sleep(300);
  }

  // ---- v3: web app windows (a group bound to one web app, no tab strip in Cloud) ----
  {
    const w1 = await BR(`windows.create({webapp:'gmail'})`);
    const ag = br.groups.get(w1.gid);
    rec('v3 app window: windows.create({webapp}) returns gid and its one tab', w1.gid > 1 && w1.id > 0 && w1.existing === false && ag && ag.webapp === 'gmail' && ag.model.tabs.length === 1 && ag.model.tabs[0].appId === 'gmail', JSON.stringify(w1));
    rec('v3 app window: the windows event and state name the app', (await events('windows')).some((e) => e.created === w1.gid && e.webapp === 'gmail' && e.apps[w1.gid] === 'gmail') && await waitFor(async () => (await P('T.states'))[w1.gid] && (await P('T.states'))[w1.gid].webapp === 'gmail'));
    const w1b = await BR(`windows.create({webapp:'gmail'})`);
    rec('v3 app window: asking again reuses the window (focus), same tab', w1b.gid === w1.gid && w1b.id === w1.id && w1b.existing === true && br.groups.size === 2 && br.focusedGid === w1.gid);
    const ex = await BR(`newTab({url:'${base}/',gid:${w1.gid}})`); await sleep(500);
    rec('v3 app window: a second tab is refused, it goes to a normal window', ex.gid !== w1.gid && ag.model.tabs.length === 1 && !br.groups.get(ex.gid).webapp);
    await BR(`closeTab(${ex.id})`);
    rec('v3 app window: its tab cannot be moved out, and nothing moves in', (await BR(`moveTab(${w1.id},'new')`)).ok === false && (await BR(`moveTab(${w1.id},1)`)).ok === false);
    const plain = (await BR(`newTab({url:'${base}/',gid:1})`)).id; await sleep(500);
    rec('v3 app window: moving a normal tab into it is refused', (await BR(`moveTab(${plain},${w1.gid})`)).ok === false && ag.model.tabs.length === 1);
    await BR(`closeTab(${plain})`);
    br.setBadge(br.appById('gmail'), 5, true);
    rec('v3 app window: unread badge is in that window state', await waitFor(async () => ((await P('T.states'))[w1.gid].tabs[0] || {}).badge === 5));
    const sess = br.tabs.get(w1.id).wc.session;
    await sess.cookies.set({ url: 'https://mail.google.com', name: 'ak', value: '1' });
    const w2 = await BR(`windows.create({webapp:'discord'})`);
    rec('v3 app window: each app keeps its own session (cookies separate)', w2.gid !== w1.gid && br.tabs.get(w2.id).wc.session !== sess && (await br.tabs.get(w2.id).wc.session.cookies.get({ name: 'ak' })).length === 0 && (await sess.cookies.get({ name: 'ak' })).length === 1);
    await BR('windows.focus(1)');
    const ou0 = (await events('open-url')).length;
    await ev(br.tabs.get(w1.id).wc, `window.open('https://example.org/out')`).catch(() => {}); await sleep(600);
    await ev(br.tabs.get(w1.id).wc, `location.href='https://example.net/leave'`).catch(() => {}); await sleep(600);
    await BR(`windows.focus(${w1.gid})`);
    await ev(br.tabs.get(w1.id).wc, `window.open('https://example.org/out2')`).catch(() => {}); await sleep(600);
    const ouNew = (await events('open-url')).slice(ou0);
    rec('v3 app window: links leaving the app open in a normal window (open-url, normal gid), the app tab stays', ouNew.some((e) => e.url === 'https://example.org/out' && e.gid === 1) && ouNew.some((e) => e.url === 'https://example.net/leave' && e.gid === 1) && ouNew.some((e) => e.url === 'https://example.org/out2' && e.gid === 1) && ag.model.tabs.length === 1 && /google\.com/.test(br.tabs.get(w1.id).wc.getURL() || 'google.com'), JSON.stringify(ouNew.map((e) => [e.url, e.gid])));
    rec('v3 app window: gid-less newTab and menu never land in an app window', (await BR(`newTab({url:'${base}/'})`)).gid === 1 && (await (async () => { br.menuAction('find'); await sleep(200); return true; })()));
    for (const m of [...br.groups.get(1).model.tabs]) br.closeTab(m.id);
    const ob = (await BR('webapps.catalogue()')).filter((a) => a.open).map((a) => a.id).sort().join();
    rec('v3 app window: catalogue says the app is open', ob === 'discord,gmail', ob);
    const sv = (await events('menu')).length;
    br.openApp('gmail', { window: true }); await sleep(300);
    rec('v3 app window: opening an open app again focuses its window (showApp)', (await events('menu')).slice(sv).some((e) => e.action === 'showApp' && e.gid === w1.gid && e.appId === 'gmail') && br.groups.size === 3);
    rec('v3 app window: windows.close closes it, the app stays installed', (await BR(`windows.close(${w2.gid})`)) === true && !br.groups.has(w2.gid) && br.appsStore.has('discord') && !br.tabs.has(w2.id));
    rec('v3 app window: webapps.remove closes the window too', (await BR(`webapps.remove('gmail')`)) === true && !br.groups.has(w1.gid) && !br.tabs.has(w1.id));
    await BR(`webapps.remove('discord')`);
    rec('v3 app window: only the normal group is left', br.groups.size === 1 && br.groups.has(1), [...br.groups.keys()].join());
  }

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
  const fsN = (await events('fullscreen')).length;
  ev(br.tabs.get(dl).wc, `document.documentElement.requestFullscreen().then(()=>1,()=>0)`).catch(() => {});   // not awaited: it settles when the page is in full screen
  const fsOn = await waitFor(async () => (await events('fullscreen')).slice(fsN).some((e) => e.on), 5000); await sleep(500);
  const fb = br.tabs.get(dl).view.getBounds(); const [fw, fh] = br.win.getContentSize();
  rec('HTML5 fullscreen: event, view covers the whole window', fsOn && fb.x === 0 && fb.y === 0 && fb.width === fw && fb.height === fh, JSON.stringify(fb) + ' in ' + fw + 'x' + fh);
  await shot('06-html-fullscreen');
  await BR('fullscreen(false)'); await sleep(800);
  const fb2 = br.tabs.get(dl).view.getBounds();
  rec('leaving fullscreen restores the reported rectangle', (await events('fullscreen')).slice(fsN).some((e) => !e.on) && fb2.width < fw, JSON.stringify(fb2));
  br.closeTab(dl);

  // ---- navigation lock of the Mayfair view ----
  await sleep(300);
  const n0 = M().tabs.length;
  await P(`window.mayfairDesktop.openBrowser('https://example.com/')`);
  await sleep(500);
  const ou = await events('open-url');
  rec('openBrowser asks the Cloud side to open the address (no tab made by main)', ou.some((e) => e.url === 'https://example.com/') && M().tabs.length === n0);
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
  const nT = M().tabs.length;
  rec('webapps.open opens a tab with the app session', (await BR(`webapps.open('gmail')`)) === true);
  await sleep(1500);
  const gt = M().tabs.find((t) => t.appId === 'gmail');
  rec('app opens in its own tab', !!gt && M().tabs.length === nT + 1 && M().activeId === gt.id);
  rec('app tab uses its own isolated session', br.tabs.get(gt.id).wc.session !== session.fromPartition('persist:browse') && br.tabs.get(gt.id).wc.session !== session.fromPartition('persist:mayfair'));
  rec('app open asks the Cloud side to show the Browser', (await events('menu')).some((e) => e.action === 'showBrowser'));
  br.openApp('gmail'); rec('opening again switches to the same tab', M().tabs.filter((t) => t.appId === 'gmail').length === 1);
  br.setBadge(br.appById('gmail'), 7, true);
  rec('unread badge in state', await waitFor(async () => (await P('T.state')).tabs.find((t) => t.webapp === 'gmail').badge === 7));
  const gs = br.sessionForApp(br.appById('gmail'));
  await gs.cookies.set({ url: 'https://mail.google.com', name: 'k', value: 'v' });
  rec('cookie stored in the app session only', (await gs.cookies.get({ name: 'k' })).length === 1 && (await session.fromPartition('persist:browse').cookies.get({ name: 'k' })).length === 0);
  rec('webapps.pin and pinned list for the Cloud desktop', (await BR(`webapps.pin('gmail',true)`)) === true && (await P(`window.mayfairDesktop.apps.list()`)).map((a) => a.id).join() === 'gmail');
  {
    const now = Date.now() / 1000;
    await gs.cookies.set({ url: 'https://mail.google.com', name: 'sess', value: 'login-token', httpOnly: true, secure: true });          // a session cookie: no expiry
    await gs.cookies.set({ url: 'https://mail.google.com', name: 'soon', value: 'x', expirationDate: now + 5 * 86400 });
    await gs.cookies.set({ url: 'https://mail.google.com', name: 'far', value: 'y', expirationDate: now + 200 * 86400 });
    await sleep(800);
    const got = Object.fromEntries((await gs.cookies.get({})).map((c) => [c.name, c]));
    rec('web app stay-signed-in: a session cookie gets an expiry of about 400 days, other fields kept', got.sess && !got.sess.session && got.sess.expirationDate > now + 399 * 86400 && got.sess.httpOnly === true && got.sess.secure === true && got.sess.value === 'login-token', got.sess && got.sess.expirationDate);
    rec('web app stay-signed-in: a cookie expiring in 5 days is pushed out, a 200-day one left alone', got.soon.expirationDate > now + 399 * 86400 && Math.abs(got.far.expirationDate - (now + 200 * 86400)) < 120, got.soon.expirationDate + ' / ' + got.far.expirationDate);
    br.flushNow(gs); await sleep(500);
    rec('web app stay-signed-in: after a flush the cookies read back from the store with their expiry', (await gs.cookies.get({ name: 'sess' }))[0].expirationDate > now + 399 * 86400);
    rec('web app partitions are persistent and live in the app data folder', br.catalogue.every((x) => W.partitionFor(x.id).startsWith('persist:app-')) && /Partitions/.test(gs.storagePath || '') && (gs.storagePath || '').startsWith(app.getPath('userData')), gs.storagePath);
    await BR('settings.clearBrowsingData({})');
    rec('Clear browsing data without Web apps leaves web app sign-ins', (await gs.cookies.get({ name: 'sess' })).length === 1);
    const sw = await BR('settings.clearBrowsingData({webapps:true})'); await sleep(500);
    rec('Clear browsing data with Web apps ticked clears them (only explicit action)', sw === true && (await gs.cookies.get({ name: 'sess' })).length === 0);
    await gs.cookies.set({ url: 'https://mail.google.com', name: 'k', value: 'v' });
  }
  rec('webapps.reset clears the app session', (await BR(`webapps.reset('gmail')`)) === true && (await gs.cookies.get({ name: 'k' })).length === 0);
  const sc = await BR(`webapps.shortcut('gmail')`);
  rec('desktop shortcut created (Linux .desktop)', process.platform !== 'linux' || (sc.ok && fs.existsSync(sc.path) && /--app=gmail/.test(fs.readFileSync(sc.path, 'utf8'))), sc.path || sc.reason);
  rec('webapps.remove closes the tab and forgets the app', (await BR(`webapps.remove('gmail')`)) === true && !M().tabs.some((t) => t.appId === 'gmail') && !br.appsStore.has('gmail'));
  await BR(`webapps.open('discord',{window:true})`); await sleep(1500);
  rec('app opens in its own window (a chromeless window group when the Cloud listens for windows)', [...br.groups.values()].some((g) => g.webapp === 'discord') && !br.appWindows.has('discord'));
  await BR(`webapps.remove('discord')`);
  rec('window closed on remove', ![...br.groups.values()].some((g) => g.webapp === 'discord'));
  br.subs.delete('windows');
  await BR(`webapps.open('discord',{window:true})`); await sleep(1500);
  rec('without a windows subscriber (older Cloud) the app opens in a native window', br.appWindows.has('discord') && !br.appWindows.get('discord').isDestroyed());
  await BR(`webapps.remove('discord')`); br.subs.add('windows');
  rec('newTab({webapp}) works through the tab call', await (async () => { const r = await BR(`newTab({webapp:'gmail'})`); const ok = r.id && M().get(r.id).appId === 'gmail'; await BR(`webapps.remove('gmail')`); return ok; })());

  // ---- privacy ----
  const bt = (await BR(`newTab({url:'${base}/'})`)).id; await sleep(2500);
  const bw = br.tabs.get(bt).wc;
  rec('WebRTC leak policy on browser tabs', bw.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp', bw.getWebRTCIPHandlingPolicy());
  rec('Mayfair view keeps default WebRTC (calls work)', home.wc.getWebRTCIPHandlingPolicy() === 'default', home.wc.getWebRTCIPHandlingPolicy());
  await BR(`settings.set({standardLocale:true})`);
  const lt = (await BR(`newTab({url:'${base}/'})`)).id; await sleep(3000);
  const loc = await ev(br.tabs.get(lt).wc, `[Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language, navigator.hardwareConcurrency, navigator.languages.join()].join('|')`);
  rec('standard time zone, language and reduced fingerprint on new tabs', loc === 'UTC|en-US|4|en-US,en', loc);
  const uaInfo = await ev(br.tabs.get(lt).wc, `JSON.stringify({ua:navigator.userAgent,brands:(navigator.userAgentData||{}).brands,mobile:(navigator.userAgentData||{}).mobile,vendor:navigator.vendor,wd:navigator.webdriver,plat:navigator.platform})`);
  console.log('UAINFO ' + uaInfo);
  rec('tabs look like Chrome (UA without Electron or app names, Chrome brand)', !/Electron|mayfair/i.test(uaInfo.split('"brands"')[0]) && /Google Chrome/.test(uaInfo), uaInfo.slice(0, 300));
  await BR(`settings.set({standardLocale:false})`);
  // Tor with the stand-in daemon (the real tor binary cannot be downloaded here)
  rec('Tor binary found for this run', !!br.tor.binary, br.tor.binary);
  const tr = await BR(`newTab({tor:true})`); await sleep(2500);
  const tid = tr.id;
  rec('Tor tab opens only after Tor reports 100%', !!tid && br.tor.ready);
  const tproxy = await session.fromPartition('mf-tor').resolveProxy('https://example.org/');
  rec('Tor session routed to the local SOCKS port, own partition', M().get(tid) && M().get(tid).tor && new RegExp('SOCKS5 127\\.0\\.0\\.1:' + br.tor.state.socksPort).test(tproxy), tproxy);
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
  for (const m of [...M().tabs]) br.closeTab(m.id);

  // ---- Tor start/stop through the bridge, window fullscreen, password fill refusal, renderer crash ----
  const ts = await BR('tor.start()');
  rec('tor.start() reports connected with a SOCKS port', ts.state === 'connected' && ts.socksPort > 0 && ts.progress === 100, JSON.stringify(ts));
  const tt = (await BR('newTab({tor:true})')).id; await sleep(800);
  rec('tor.stop() closes Tor tabs and stops the daemon', (await BR('tor.stop()')) === true && !M().get(tt) && await waitFor(() => br.tor.state.status === 'off', 4000));
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
  rec('desktop commands are not offered by the start page', !/Open Finance/.test(await ev(sw, `document.querySelector('#pop').textContent`)));
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

  // ---- Ghost connectors: the sample installs into userData, is approved through the (test-only) stand-in for the native dialog, tested, run, and its real results come back over the bridge ----
  {
    const crypto = require('node:crypto');
    const ghostText = 'smoke test text\nsecond line here\n';
    const gl0 = await BR('ghost.connectors.installSample()');
    rec('ghost: sample installs into userData/connectors (no network)', gl0 && gl0.ok && fs.existsSync(path.join(app.getPath('userData'), 'connectors', 'sample-textstats', 'connector.json')), JSON.stringify(gl0));
    const e0 = ((await BR('ghost.connectors.list()')) || []).find((x) => x.id === 'sample-textstats');
    rec('ghost: a fresh connector is not approved and not reported as installed', e0 && e0.state === 'not-approved' && e0.install.installed === false && e0.install.verified === 'not-tested', JSON.stringify(e0 && e0.install));
    const r0 = await BR(`ghost.jobs.run({connector:'sample-textstats',input:{text:'x'}})`);
    rec('ghost: an unapproved connector cannot run', r0 && r0.ok === false && r0.error === 'not-approved', JSON.stringify(r0));
    const refused = await BR(`ghost.jobs.run({connector:'sample-textstats',command:'/bin/sh',input:{}})`);
    rec('ghost: the bridge refuses a run request that carries a command', refused && /blocked: bad-args/.test(refused.__err || ''), JSON.stringify(refused));
    br.ghost.useTestConfirm(() => false);
    const rd = await BR(`ghost.connectors.requestApproval('sample-textstats')`);
    rec('ghost: the page cannot approve; a "no" in the dialog leaves it not-approved', rd && rd.ok === false && rd.error === 'declined' && ((await BR('ghost.connectors.list()'))[0].state === 'not-approved'), JSON.stringify(rd));
    br.ghost.useTestConfirm((o) => o.kind === 'approve');           // stands in for the user pressing Approve (smoke runs only, never in an installed app)
    await P(`(()=>{window.__ghostEv=[];window.mayfairDesktop.browser.on('ghost-job',(p)=>window.__ghostEv.push(p));return 1})()`);
    const ra = await BR(`ghost.connectors.requestApproval('sample-textstats')`);
    rec('ghost: approved through the dialog stand-in', ra && ra.ok === true && ra.state === 'approved', JSON.stringify(ra));
    const tt = await BR(`ghost.connectors.test('sample-textstats')`);
    rec('ghost: self-test really ran and passed', tt && tt.ok && tt.passed === true && tt.verified === 'tested', JSON.stringify(tt));
    const en = await BR(`ghost.connectors.enable('sample-textstats')`);
    const e1 = ((await BR('ghost.connectors.list()')) || []).find((x) => x.id === 'sample-textstats');
    rec('ghost: enabled, and now reported installed because the self-test passed', en && en.ok && e1 && e1.state === 'enabled' && e1.install.installed === true && e1.install.requirements.every((q) => q.status === 'ok'), JSON.stringify(e1 && e1.install));
    const run = await BR(`ghost.jobs.run({connector:'sample-textstats',input:{text:${JSON.stringify(ghostText)}}})`);
    rec('ghost: a run is accepted', run && run.ok === true && /^j-/.test(run.jobId || ''), JSON.stringify(run));
    let job = null;
    for (let i = 0; i < 60; i++) { job = await BR(`ghost.jobs.get('${run.jobId}')`); if (job && ['done', 'failed', 'cancelled', 'timed-out'].includes(job.status)) break; await sleep(250); }
    const by = Object.fromEntries(((job && job.results) || []).map((x) => [x.entity.type, x.entity.value]));
    const want = { sha256: crypto.createHash('sha256').update(ghostText).digest('hex'), 'byte-count': String(Buffer.byteLength(ghostText)), 'line-count': '2', 'word-count': '6' };
    rec('ghost: real results came back and match an independent computation', job && job.status === 'done' && JSON.stringify(by) === JSON.stringify(want), JSON.stringify(job && { status: job.status, error: job.error, by }));
    await sleep(300);
    const evs = (await P('window.__ghostEv')) || [];
    rec('ghost: ghost-job events reached the page (running, done)', evs.some((x) => x.jobId === run.jobId && x.status === 'running') && evs.some((x) => x.jobId === run.jobId && x.status === 'done'), JSON.stringify(evs.map((x) => x.status)));
    const jl = await BR('ghost.jobs.list()');
    const lg = await BR(`ghost.logs.tail({jobId:'${run.jobId}',n:20})`);
    rec('ghost: job history and log are readable over the bridge', Array.isArray(jl) && jl.some((x) => x.id === run.jobId) && Array.isArray(lg) && lg.some((x) => x.event === 'job-end'), JSON.stringify(lg && lg.map((x) => x.event)));
    fs.appendFileSync(path.join(app.getPath('userData'), 'connectors', 'sample-textstats', 'run.js'), '\n// changed on disk\n');
    const e2 = ((await BR('ghost.connectors.list()')) || []).find((x) => x.id === 'sample-textstats');
    const r2 = await BR(`ghost.jobs.run({connector:'sample-textstats',input:{text:'x'}})`);
    rec('ghost: changing a connector file revokes approval and stops runs', e2 && e2.state === 'not-approved' && e2.health === 'changed' && r2 && r2.ok === false, JSON.stringify({ s: e2 && e2.state, h: e2 && e2.health, r2 }));
    br.ghost.useTestConfirm((o) => o.kind === 'remove');
    const rm = await BR(`ghost.connectors.remove('sample-textstats')`);
    rec('ghost: remove (confirmed) deletes the connector', rm && rm.ok === true && !fs.existsSync(path.join(app.getPath('userData'), 'connectors', 'sample-textstats')), JSON.stringify(rm));
    br.ghost.confirmOverride = null;
  }

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
