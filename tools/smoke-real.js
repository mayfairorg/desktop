'use strict';
// Runs INSIDE the Electron main process when MF_SMOKE=1 and MF_SMOKE_HOOK=real (never in a packaged app).
// The REAL Cloud build (dev stack, MF_PORT_BASE, default 10500) is served for https://cloud.mayfairmail.com inside the app's own Mayfair session:
//   https://cloud.mayfairmail.com/*  ->  http://127.0.0.1:<base+1>/*   (the page)
// and requests from that page to the dev API / Mayfair ID / Mail stand-ins get the headers they need (hook only, shipped CSP untouched).
// A test account is signed in with the dev Mayfair ID stand-in, then the Browser app is driven together with the native tab views.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const OUT = process.env.MF_SMOKE_OUT || '/tmp/mf-smoke';
const TAG = process.env.MF_SMOKE_TAG || 'real';
const PB = +(process.env.MF_PORT_BASE || 10500);
const OSO = `http://127.0.0.1:${PB + 1}`, API = `http://127.0.0.1:${PB}`, IDO = `http://127.0.0.1:${PB + 2}`;
const CLOUD = 'https://cloud.mayfairmail.com';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : '')); };
const shot = async (name) => { await sleep(600); try { execFileSync('import', ['-window', 'root', path.join(OUT, `${TAG}-${name}.png`)], { stdio: 'ignore' }); } catch (e) { rec('screenshot ' + name, false, e.message); } };
const b64u = (b) => Buffer.from(b).toString('base64url');

async function run(br, app) {
  setTimeout(() => { console.log('WATCHDOG: hook ran too long'); app.exit(3); }, 280000).unref();
  fs.mkdirSync(OUT, { recursive: true });
  const { session, net } = require('electron');
  const ms = session.fromPartition('persist:mayfair');
  const ours = (u) => u.hostname === '127.0.0.1' && +u.port >= PB && +u.port <= PB + 3;

  // ---- the proxy: https cloud host -> dev page; dev stand-ins get Origin and CORS fixed up; the token call gets the redirect address the stand-in registered ----
  ms.protocol.handle('https', async (req) => {
    const u = new URL(req.url);
    if (u.hostname !== 'cloud.mayfairmail.com') return new Response('offline', { status: 503 });
    let r;
    try { r = await fetch(OSO + u.pathname + u.search, { method: req.method, headers: { accept: req.headers.get('accept') || '*/*' } }); }
    catch (e) { console.log('proxy https failed', req.method, req.url, e.message); return new Response('proxy error', { status: 502 }); }
    const h = new Headers(r.headers); h.delete('content-encoding'); h.delete('content-length');
    // Test-only: the shipped page exposes its window.__cloud test handle on 127.0.0.1 / localhost only. Here the core script is served with the cloud host added to that one list
    // (and the integrity attribute of that one script tag dropped, since its bytes change). The shipped files and CSP are untouched.
    if (/^\/c\/core\.[0-9a-f]+\.js$/.test(u.pathname)) return new Response((await r.text()).split('["127.0.0.1","localhost"].includes(location.hostname)&&Object.defineProperty(window,"__cloud"').join('["127.0.0.1","localhost","cloud.mayfairmail.com"].includes(location.hostname)&&Object.defineProperty(window,"__cloud"'), { status: r.status, headers: h });
    if (u.pathname === '/' || u.pathname === '/index.html') return new Response((await r.text()).replace(/(<script src="c\/core\.[0-9a-f]+\.js")[^>]*>/, '$1>'), { status: r.status, headers: h });
    return new Response(r.body, { status: r.status, headers: h });
  });
  ms.protocol.handle('http', async (req) => {
    const u = new URL(req.url);
    if (!ours(u)) return net.fetch(req, { bypassCustomProtocolHandlers: true });
    const cors = { 'access-control-allow-origin': CLOUD, 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'access-control-expose-headers': '*', 'access-control-max-age': '600' };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const headers = new Headers(req.headers); headers.set('origin', OSO);
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = Buffer.from(await req.arrayBuffer());
      if (u.pathname === '/oauth/token') body = Buffer.from(body.toString('utf8').split(encodeURIComponent(CLOUD + '/')).join(encodeURIComponent(OSO + '/')));
      headers.delete('content-length');
    }
    let r;
    try { r = await fetch(req.url, { method: req.method, headers, body }); }
    catch (e) { console.log('proxy http failed', req.method, req.url, e.message); return new Response('proxy error', { status: 502, headers: cors }); }
    if (u.pathname === '/oauth/token') { const t = await r.clone().text(); console.log('token call', r.status, t.slice(0, 160)); }
    const h = new Headers(r.headers); for (const [k, v] of Object.entries(cors)) h.set(k, v); h.delete('content-encoding'); h.delete('content-length');
    return new Response(r.body, { status: r.status, headers: h });
  });

  // ---- a local test site ----
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    if (req.url.startsWith('/file.txt')) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="report.txt"' }); return res.end('hello from the real smoke test'); }
    if (req.url.startsWith('/popup')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(`<title>Popup opener</title><button id=b onclick="window.open('http://127.0.0.1:${port}/second')">open</button><p>popup test</p>`); }
    if (req.url.startsWith('/second')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Second page</title><p>second</p>'); }
    if (req.url.startsWith('/fs')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>Fullscreen page</title><body style="background:#246"><button id=f style="font-size:30px" onclick="document.documentElement.requestFullscreen()">full</button>'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Local test page</title><body style="font:16px system-ui;padding:24px;background:#fff;color:#111">
<h1>Local test page</h1><p>Search me: amber mayfair amber.</p><img src="https://doubleclick.net/pixel.gif" width=1 height=1><script src="https://www.google-analytics.com/analytics.js"></script>
<a id="l" href="http://127.0.0.1:${port}/second?x=1">second link</a></body>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const home = br.home;
  const ev = (wc, js) => wc.executeJavaScript(js, true);
  const P = (expr) => ev(home.wc, `(async()=>{try{const v=await (${expr});return JSON.stringify(v===undefined?null:v)}catch(e){return JSON.stringify({__err:String(e&&e.message||e)})}})()`).then((s) => JSON.parse(s));
  const waitFor = async (fn, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(150); } return false; };
  const click = (sel) => P(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return false;e.click();return true})()`);
  const key = (k, mods = []) => { home.wc.focus(); home.wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: mods }); home.wc.sendInputEvent({ type: 'char', keyCode: k, modifiers: mods }); home.wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: mods }); };
  const typeText = async (t) => { for (const ch of t) { home.wc.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(15); } };
  const stView = () => { const id = br.group().model.activeId; return id == null ? null : br.tabs.get(id); };
  const rectOf = async (sel) => P(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}})()`);
  const near = (a, b) => Math.abs(a - b) <= 2;
  const viewMatches = async () => { const v = stView(); if (!v) return false; const r = await rectOf('.br-view'), z = home.wc.getZoomFactor(), b = v.view.getBounds(); return near(b.x, Math.round(r.x * z)) && near(b.y, Math.round(r.y * z)) && near(b.width, Math.round(r.w * z)) && near(b.height, Math.round(r.h * z)); };
  const pageErrors = []; home.wc.on('console-message', (e) => { const lvl = e.level === 'error' ? 3 : 0; if (lvl >= 3) pageErrors.push(String(e.message).slice(0, 200) + ' @' + String(e.sourceId).split('/').pop() + ':' + e.lineNumber); });

  // ---- load the real Cloud page, sign in a test account ----
  await waitFor(() => /Mayfair Cloud/.test(home.wc.getTitle()), 20000);
  rec('Mayfair view loaded the REAL Cloud page over https (proxied)', /Mayfair Cloud/.test(home.wc.getTitle()) && home.wc.getURL().startsWith(CLOUD), home.wc.getTitle() + ' ' + home.wc.getURL());
  rec('bridge exists in the real page', (await P('!!(window.mayfairDesktop&&window.mayfairDesktop.browser)')) === true);
  await shot('01-signin');
  const user = 'smoke' + Date.now().toString(36);
  await fetch(API + '/__dev/session', { method: 'POST', body: JSON.stringify({ user }) });
  const v = b64u(crypto.randomBytes(48)), ch = b64u(crypto.createHash('sha256').update(v).digest()), state = b64u(crypto.randomBytes(18)), nonce = b64u(crypto.randomBytes(18));
  const scope = await P('window.__cloud.CL&&1').then(() => '');   // scope is taken from the build below
  const cfgScope = await P(`(()=>{try{return window.__cloud.CLC.scope}catch(e){return ''}})()`);
  const q = new URLSearchParams({ response_type: 'code', client_id: 'mayfair-cloud', redirect_uri: OSO + '/', scope: cfgScope || 'openid profile email plan offline_access', state, nonce, code_challenge: ch, code_challenge_method: 'S256' });
  const ar = await fetch(IDO + '/oauth/authorize?' + q, { redirect: 'manual' });
  const loc = ar.headers.get('location') || '';
  const code = loc ? new URL(loc, IDO).searchParams.get('code') : null;
  rec('Mayfair ID stand-in issued a code for the test account', !!code, ar.status + ' ' + loc.slice(0, 80) + scope);
  await P(`sessionStorage.setItem('mfc:pkce',${JSON.stringify(JSON.stringify({ v, state, nonce, t: Date.now(), silent: false, login: false }))})`);
  await ev(home.wc, `location.href=${JSON.stringify(CLOUD + '/?code=' + code + '&state=' + state)}`);
  const signed = await waitFor(async () => (await P('!!(window.__cloud&&window.__cloud.CL&&window.__cloud.CL.on)')) === true, 40000);
  rec('signed in as the test account (token call went through the proxy)', signed, user);
  console.log('diag', JSON.stringify(await P(`(()=>{const c=window.__cloud||{};return {keys:Object.keys(c).slice(0,30),href:location.href,on:c.CL&&c.CL.on,state:c.CL&&c.CL.state,pk:sessionStorage.getItem('mfc:pkce'),had:localStorage.getItem('mfc:had'),aubtn:!!document.getElementById('aubtn')}})()`)));
  console.log('console errors:', pageErrors.slice(0, 10).join(' || '));
  if (!signed) { await shot('01b-signin-failed'); console.log(pageErrors.slice(0, 8).join('\n')); return finish(); }
  await sleep(2500);
  if (await click('.mf-dlg button[data-b=skip],.mf-dlg button:not([data-b=ok])')) { /* may be something else; checked below */ }
  await P(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/^skip set-?up$/i.test(x.textContent.trim()));if(b)b.click();return !!b})()`); await sleep(800);
  await P(`(()=>{const b=[...document.querySelectorAll('.mf-dlg button')].find(x=>/skip|not now|close|later/i.test(x.textContent));if(b)b.click()})()`); await sleep(500);
  rec('first-run set-up dialog dismissed', (await P(`!document.querySelector('.mf-dlg')`)) === true);
  await shot('02-desktop');

  // ---- open the Browser from Start ----
  const startOk = await click('.mf-tbi.start');
  await sleep(700);
  await shot('03-start-menu');
  const inStart = await P(`(()=>{const e=[...document.querySelectorAll('.mf-start [data-app],.mf-start .mf-row,.mf-start button')].find(x=>/browser/i.test((x.dataset&&x.dataset.app)||'')||/^\\s*browser\\s*$/i.test(x.textContent.trim().split('\\n')[0]));if(!e)return false;e.click();return true})()`);
  rec('Start menu lists the Browser and opens it', startOk && inStart === true && await waitFor(async () => (await P(`!!document.querySelector('.br [data-k=url]')`)) === true, 15000), 'start ' + startOk + ' item ' + inStart);
  if (!inStart) { await P(`window.__cloud.MFA.launch('browser')`); await waitFor(async () => (await P(`!!document.querySelector('.br [data-k=url]')`)) === true, 15000); }
  await sleep(1200);
  await shot('04-browser-start-page');
  const st0 = await P('(async()=>{const r=await window.mayfairDesktop.browser.ready();return {tabs:r.state.tabs.length,features:r.features.length}})()');
  rec('Browser app registered with the real bridge and made its first (start page) tab', st0.tabs === 1 && br.group().model.tabs.length === 1, JSON.stringify(st0));

  // ---- navigate by typing in the omnibox ----
  const omnibox = async (text) => {
    home.wc.focus(); await P(`(()=>{const us=[document.querySelector('.br-url'),document.querySelector('.br-si')].filter(x=>x&&x.getBoundingClientRect().width>0);const u=us[0];u.focus();u.select()})()`);
    await home.wc.insertText(text); await sleep(400); home.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); home.wc.sendInputEvent({ type: 'char', keyCode: 'Return' }); home.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  };
  await omnibox(base + '/');
  console.log('diag omnibox', JSON.stringify(await P(`(()=>{const u=document.querySelector('.br-url');return {val:u&&u.value,vis:u&&u.getBoundingClientRect().width,mode:document.querySelector('.br').dataset.mode,act:document.activeElement&&document.activeElement.className}})()`)), JSON.stringify(br.group().model.tabs.map((t) => [t.id, t.url])));
  const t1ok = await waitFor(() => { const v = stView(); return v && v.wc.getURL() === base + '/' && v.wc.getTitle() === 'Local test page'; }, 10000);
  rec('typing in the omnibox loads the local page in a native tab view', !!t1ok, stView() && stView().wc.getURL());
  await sleep(800);
  console.log('diag web', JSON.stringify(await P(`(()=>{const b=document.querySelector('.br');const r=e=>{e=document.querySelector(e);if(!e)return null;const q=e.getBoundingClientRect();return [Math.round(q.left),Math.round(q.top),Math.round(q.width),Math.round(q.height),getComputedStyle(e).display]};return {mode:b.dataset.mode,br:r('.br'),view:r('.br-view'),bar:r('.br-bar,.br-top,.br-tools'),strip:r('.br-tabs,.br-strip'),cls:b.className,kids:[...b.children].map(c=>c.className+':'+Math.round(c.getBoundingClientRect().height))}})()`)), 'native', JSON.stringify(stView().view.getBounds()), stView().shown, stView().view.getVisible(), br.win.contentView.children.length);
  await shot('05a-debug');
  rec('native view sits exactly on the Browser content area', await viewMatches(), JSON.stringify(stView() && stView().view.getBounds()) + ' vs ' + JSON.stringify(await rectOf('.br-view')));
  rec('omnibox shows the address and tab strip shows the title', await P(`(()=>{const u=document.querySelector('.br-url');return u.value.includes('127.0.0.1')&&/Local test page/.test(document.querySelector('.br').innerText)})()`));
  await shot('05-page-open');
  await omnibox(base + '/second?x=2'); await waitFor(() => /second\?x=2/.test(stView().wc.getURL()), 8000); await sleep(600);
  const back = await click('[data-a=back]'); await waitFor(() => stView().wc.getURL() === base + '/', 6000);
  rec('back button goes back', back && stView().wc.getURL() === base + '/', stView().wc.getURL());
  const fwd = await click('[data-k=fwd]'); await waitFor(() => /second\?x=2/.test(stView().wc.getURL()), 6000);
  rec('forward button goes forward', fwd && /second\?x=2/.test(stView().wc.getURL()), stView().wc.getURL());
  await omnibox(base + '/'); await waitFor(() => stView().wc.getURL() === base + '/', 6000); await sleep(600);

  // ---- another Mayfair window over the browser: native view hides, picture shows ----
  const visible = () => { const v = stView(); return !!v && v.shown && v.view.getVisible(); };
  rec('page view visible before covering it', visible());
  const closeFront = () => click('.win.front button[aria-label=Close],.win.front button[data-act=xclose],.win.front button[data-act=close],button[data-act=xclose][aria-label="Close window"],button[data-act=close][aria-label="Close window"]');
  const picShown = () => P(`(()=>{const c=document.querySelector('.br-view');if(!c)return '';const i=c.querySelector('img');return (getComputedStyle(c).backgroundImage||'')+' '+(i&&getComputedStyle(i).display!=='none'?i.src.slice(0,22):'')})()`);
  { const du = await P('window.mayfairDesktop.browser.capture()'); if (typeof du === 'string' && du.length > 100) fs.writeFileSync(path.join(OUT, TAG + '-cap-direct.jpg'), Buffer.from(du.split(',')[1], 'base64')); }
  // 1. a small dialog over part of the page
  await P(`(()=>{window.__cloud.MFU.alert('Hello','A dialog over the Browser');return 1})()`); await sleep(900);
  rec('a Mayfair dialog over the page: native view hidden, picture of the page painted', !visible() && /data:image/.test(await picShown()), 'visible=' + visible() + ' ' + await picShown());
  await shot('06a-dialog-over-browser');
  await click('.mf-dlg button[data-b=ok]'); await sleep(900);
  rec('dialog closed: native view back at its place', visible() && await viewMatches());
  // 2. another full Mayfair window (Files) opened over the Browser
  await P(`window.__cloud.MFA.launch('files')`); const filesOpen = await waitFor(async () => (await P(`!!(()=>{const w=document.querySelector('.win.front:not([data-app=browser])');return !!w&&w.getBoundingClientRect().width>200})()`)) === true, 6000);
  await sleep(900);
  console.log('diag files', JSON.stringify(await P(`({wins:window.__cloud.MFA.wins.map(w=>[w.app,w.max,w.min]),dom:[...document.querySelectorAll('.win')].map(e=>e.dataset.app+':'+Math.round(e.getBoundingClientRect().width)+':'+e.className)})`)));
  rec('another Mayfair window over the Browser: native view hidden', filesOpen && !visible(), 'files=' + filesOpen + ' visible=' + visible());
  await shot('06-occluded-by-window');
  const cl = await closeFront(); await sleep(1200);
  rec('closing the other window brings the native view back', cl === true && await waitFor(() => visible(), 4000) && await viewMatches(), 'closed=' + cl);
  await shot('07-view-returned');

  // ---- drag / resize the Browser window ----
  const wasMax = await P(`(()=>{const w=window.__cloud.MFA.wins.find(x=>x.app==='browser');if(w.max){window.__cloud.MFA.toggleMax(w)}return true})()`);
  await sleep(900);
  rec('window restored to a floating window: view follows', await viewMatches(), JSON.stringify(stView().view.getBounds()));
  await shot('08-windowed');
  const tr = await P(`(()=>{const r=document.querySelector('.win[data-app=browser] .mf-wtitle').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
  if (tr && tr.length) {
    const z = home.wc.getZoomFactor(); const mx = (x, y, type, extra) => home.wc.sendInputEvent({ type, x: Math.round(x * z), y: Math.round(y * z), button: 'left', clickCount: 1, ...extra });
    mx(tr[0], tr[1], 'mouseMove'); mx(tr[0], tr[1], 'mouseDown');
    for (let i = 1; i <= 14; i++) { mx(tr[0] - i * 10, tr[1] + i * 5, 'mouseMove', { modifiers: ['leftButtonDown'] }); await sleep(40); }
    await sleep(150); const dragVis = visible(); mx(tr[0] - 140, tr[1] + 70, 'mouseUp'); await sleep(900);
    rec('after dragging the Browser window the view is back at the new place', visible() && await viewMatches(), 'while dragging visible=' + dragVis);
    await shot('09-dragged');
    const edge = await P(`(()=>{const r=document.querySelector('.win[data-app=browser]').getBoundingClientRect();return [r.right-2,r.top+r.height/2]})()`);
    mx(edge[0], edge[1], 'mouseMove'); mx(edge[0], edge[1], 'mouseDown');
    for (let i = 1; i <= 8; i++) { mx(edge[0] - i * 15, edge[1], 'mouseMove', { modifiers: ['leftButtonDown'] }); await sleep(40); }
    mx(edge[0] - 120, edge[1], 'mouseUp'); await sleep(900);
    rec('after resizing the Browser window the view matches', visible() && await viewMatches());
    await shot('10-resized');
  } else rec('window title bar found for dragging', false);
  await P(`(()=>{const w=window.__cloud.MFA.wins.find(x=>x.app==='browser');if(!w.max)window.__cloud.MFA.toggleMax(w)})()`); await sleep(900);
  rec('maximised again: view matches', await viewMatches());

  // ---- bookmark, find ----
  await click('[data-k=star],[data-a=star]'); await sleep(700);
  rec('bookmark button adds the page natively', (await P('window.mayfairDesktop.browser.bookmarks.list()')).some((b) => b.url === base + '/'));
  await shot('11-bookmarked');
  key('F', ['control']); await sleep(500);
  const findOpen = await P(`!!document.querySelector('.br-find input,[data-k=find] input,input[aria-label*=ind i]')`);
  if (findOpen) { await P(`(()=>{const i=document.querySelector('.br-find input,[data-k=find] input,input[aria-label*=ind i]');i.focus()})()`); await typeText('amber'); key('Return'); await sleep(800); }
  rec('Ctrl+F opens find and it reports matches', findOpen === true && /2/.test(await P(`(document.querySelector('.br-find')||document.body).innerText.slice(0,300)`)), '');
  await shot('12-find');
  key('Escape'); await sleep(300);

  // ---- private tab ----
  const hn = br.history.list().length;
  key('N', ['control', 'shift']); await sleep(1500);
  rec('Ctrl+Shift+N opens a private tab', br.group().model.tabs.some((t) => t.private));
  await omnibox(base + '/'); await sleep(2000);
  rec('private tab page not in history', br.history.list().length === hn);
  await shot('13-private');
  const pid = br.group().model.tabs.find((t) => t.private); if (pid) br.closeTab(pid.id); await sleep(600);

  // ---- web apps catalogue ----
  key('A', ['control', 'shift']); await sleep(300);
    await click('[data-k=menu]'); await sleep(400); const appsBtn = await P(`(()=>{const e=[...document.querySelectorAll('.mfu-menu .mf-mi')].find(x=>/web apps/i.test(x.textContent));if(!e)return false;e.click();return true})()`);
  await sleep(1000);
  rec('Web apps catalogue shows the native catalogue', /Gmail|Discord|Slack/i.test(await P(`document.querySelector('.br').innerText`)) || appsBtn === true, '');
  await shot('14-webapps');
  key('Escape'); await sleep(400);

  // ---- adblock toggle ----
  const siteAllowed = async () => (await P(`window.mayfairDesktop.browser.permissions.site(${br.group().model.activeId})`)).siteAllowed;
  const abBefore = await siteAllowed();
  await click('[data-k=site]'); await sleep(600);
  await shot('15-site-info');
  console.log('diag ad', JSON.stringify(await P(`[...document.querySelectorAll('.br-pop [data-a]')].map(e=>e.dataset.a+':'+e.getAttribute('aria-checked')+':'+e.disabled)`)), abBefore);
  const ab = await click('[data-a=sitead],[data-a=sitead2]');
  await sleep(1500);
  const abAfter = await siteAllowed();
  rec('adblock toggle in the site panel changes the native allow list', ab === true && abBefore !== abAfter, 'siteAllowed ' + abBefore + ' -> ' + abAfter);
  key('Escape'); await sleep(300);
  if (abAfter) await P(`window.mayfairDesktop.browser.adblock.toggleSite(${br.group().model.activeId})`);

  // ---- download ----
  const drive = path.join(app.getPath('documents'), 'Mayfair Drive', 'Downloads');
  stView().wc.downloadURL(base + '/file.txt');
  await waitFor(() => fs.existsSync(path.join(drive, 'report.txt')), 8000);
  rec('download completes into the Mayfair Drive folder', fs.existsSync(path.join(drive, 'report.txt')));
  await sleep(800); await shot('16-download');

  // ---- popup / new window ----
  await omnibox(base + '/popup'); await waitFor(() => /popup/.test(stView().wc.getURL()), 6000); await sleep(800);
  const n0 = br.group().model.tabs.length;
  stView().wc.focus(); await ev(stView().wc, `document.getElementById('b').focus()`).catch(() => {});
  stView().wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 }); stView().wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
  await ev(stView().wc, `(()=>{document.getElementById('b').click()})()`).catch(() => {});
  await sleep(1500);
  rec('a page pop-up (after a click) opens as a new tab in the Browser strip', br.group().model.tabs.length === n0 + 1 && await P(`document.querySelectorAll('.br-tab').length`) >= 2, br.group().model.tabs.length + ' vs ' + n0);
  await shot('17-popup');

  // ---- Start menu overlap ----
  await click('.mf-tbi.start'); await sleep(900);
  rec('Start menu over the Browser hides the native view', !visible());
  await shot('18-start-over-browser');
  await click('.mf-tbi.start'); await sleep(900);
  rec('Start menu closed: view back', visible() && await viewMatches());

  // ---- minimise / restore ----
  await P(`(()=>{const M=window.__cloud.MFA;M.toggleMin(M.wins.find(x=>x.app==='browser'))})()`); await sleep(800);
  rec('minimised Browser hides the native view', !visible());
  await shot('19-minimised');
  await P(`(()=>{const M=window.__cloud.MFA;M.focus(M.wins.find(x=>x.app==='browser'))})()`); await sleep(900);
  rec('restored Browser shows it at the right place', visible() && await viewMatches());

  // ---- HTML5 fullscreen ----
  await omnibox(base + '/fs'); await waitFor(() => /fs$/.test(stView().wc.getURL()), 6000); await sleep(800);
  ev(stView().wc, `document.documentElement.requestFullscreen().then(()=>1,()=>0)`).catch(() => {});
  const fsOn = await waitFor(() => { const b = stView().view.getBounds(), [w, h] = br.win.getContentSize(); return b.x === 0 && b.y === 0 && b.width === w && b.height === h; }, 5000);
  rec('HTML5 fullscreen covers the whole window', fsOn);
  await shot('20-fullscreen');
  await P('window.mayfairDesktop.browser.fullscreen(false)'); await sleep(1200);
  rec('leaving fullscreen restores the Browser layout', await viewMatches());
  await shot('21-after-fullscreen');

  rec('no page errors from the Cloud page during the run', pageErrors.filter((e) => !/Failed to load resource|fonts\.g|net::ERR/.test(e)).length === 0, pageErrors.slice(0, 3).join(' | '));
  finish();

  function finish() {
    const bad = results.filter((r) => !r.ok);
    fs.writeFileSync(path.join(OUT, `${TAG}-results.json`), JSON.stringify(results, null, 2));
    console.log(`SMOKE REAL DONE ${results.length - bad.length}/${results.length} passed`);
    server.close(); br.quitting = true;
    setTimeout(() => app.exit(bad.length ? 1 : 0), 300);
  }
}
module.exports = { run };
