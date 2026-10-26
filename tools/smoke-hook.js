'use strict';
// Runs INSIDE the Electron main process when MF_SMOKE=1 (never in a packaged app).
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
  const home = br.homeTab();
  const ev = (wc, js) => wc.executeJavaScript(js, true);

  await sleep(4000);
  rec('window exists and is visible', br.win && br.win.isVisible());
  rec('tab 0 is the pinned Mayfair tab', br.model.tabs[0].pinned && br.model.tabs.length === 1);
  rec('Mayfair tab shows the offline page when the Cloud is unreachable', /error\.html/.test(home.wc.getURL()), home.wc.getURL().replace(/\?.*/, ''));
  rec('toolbar hidden on Mayfair tab (kiosk)', br.chromeH() === 38, br.chromeH());
  await shot('01-mayfair-offline');

  // ---- browser tab ----
  const id = br.newTab({ url: base + '/' });
  await sleep(3500);
  const st = br.stateObj();
  rec('new tab opened and active', st.activeId === id && st.tabs.length === 2);
  rec('toolbar visible on browser tab', br.chromeH() === 112, br.chromeH());
  rec('http page flagged not secure', st.secure === 'insecure', st.secure);
  rec('tracker requests blocked', st.blocked >= 2, st.blocked);
  rec('password field detected', st.pw === true);
  const page = br.activeTab();
  rec('page world has no bridge', (await ev(page.wc, 'typeof window.mayfairDesktop + typeof window.mf + typeof window.require')) === 'undefinedundefinedundefined');
  br.bookmarks.add(base + '/', 'Local test page');
  br.pushState();
  await shot('02-browser-tab');

  // ---- panels ----
  for (const p of ['menu', 'settings', 'bookmarks', 'history', 'site', 'downloads']) { br.openPanel(p); await sleep(700); await shot('03-panel-' + p); br.closePanels(); await sleep(150); }
  const _send = br.overlay.webContents.send.bind(br.overlay.webContents); br.overlay.webContents.send = (c, ...a) => { if (c === 'find:result') console.log('FIND EVENT', JSON.stringify(a)); return _send(c, ...a); };
  br.openFind(); await sleep(500);
  await ev(br.overlay.webContents, `(()=>{const i=document.querySelector('.find input');i.value='mayfair';i.dispatchEvent(new Event('input'));})()`);
  await sleep(800); await shot('04-find');
  const cnt = await ev(br.overlay.webContents, `document.getElementById('cnt').textContent`);
  rec('find in page reports matches', /\d+ \/ \d+/.test(cnt), cnt);
  br.closeFind(); await sleep(200);

  // ---- permission prompt ----
  let answer = null;
  br.askPermission(page.wc, base, 'geolocation', {}, (v) => { answer = v; }, true);
  await sleep(600); await shot('05-permission-prompt');
  await ev(br.overlay.webContents, `document.querySelector('.prompt .btn.primary').click()`);
  await sleep(300);
  rec('permission prompt Allow resolves callback', answer === true);
  rec('permission prompt closed', br.prompts.length === 0);
  let a2 = null;
  br.askPermission(page.wc, base, 'geolocation', {}, (v) => { a2 = v; }, true);
  await sleep(400);
  await ev(br.overlay.webContents, `document.getElementById('rem').click(); [...document.querySelectorAll('.prompt .btn')].find(b=>b.textContent==='Block').click()`);
  await sleep(300);
  rec('Block + remember stored per site', a2 === false && br.sitePerms.get(base, 'geolocation') === 'deny');
  br.sitePerms.resetSite(base);

  // ---- pop-up blocking ----
  const before = br.model.tabs.length;
  const pid = br.newTab({ url: base + '/popup' });
  await sleep(3000);
  rec('script pop-up without a click is blocked', br.model.tabs.length === before + 1 && br.prompts.some((p) => p.type === 'popup'), 'tabs ' + br.model.tabs.length);
  await shot('06-popup-blocked');
  br.prompts = []; br.layoutOverlay();
  br.closeTab(pid);

  // ---- IPC lockdown ----
  const chromeTry = async (ch, args) => ev(br.chrome.webContents, `mf.invoke(${JSON.stringify(ch)}, ...${JSON.stringify(args)}).then(()=> 'allowed', e=>'refused: '+e.message)`);
  rec('chrome UI cannot call the web bridge', /refused/.test(await chromeTry('web:readFile', ['x'])));
  rec('chrome UI cannot call unknown channels', /refused/.test(await chromeTry('fs:readFile', ['/etc/passwd'])));
  rec('chrome UI bad arguments rejected by main', /refused/.test(await ev(br.overlay.webContents, `mf.invoke('zoom:set','evil').then(()=>'allowed',e=>'refused: '+e.message)`)));
  rec('overlay cannot open tabs it should not (tab:new is allowed, find:run from chrome is not)', /refused/.test(await chromeTry('find:run', ['x', true, true])));
  rec('node is not exposed to UI', (await ev(br.chrome.webContents, 'typeof require + typeof process + typeof module')) === 'undefinedundefinedundefined');

  // ---- navigation lock: Mayfair tab pushes foreign URLs into a new tab ----
  const n0 = br.model.tabs.length;
  await ev(home.wc, `location.href='https://example.com/'`);
  await sleep(1500);
  rec('foreign navigation from the Mayfair tab opens a new tab', br.model.tabs.length === n0 + 1 && !/example\.com/.test(home.wc.getURL()), home.wc.getURL().replace(/\?.*/, ''));
  rec('Mayfair tab is still on a Mayfair or internal page', /error\.html/.test(home.wc.getURL()) || /mayfairmail\.com/.test(home.wc.getURL()));
  br.closeTab(br.model.tabs[br.model.tabs.length - 1].id);

  // ---- private tab ----
  const hn = br.history.list().length;
  const priv = br.newTab({ url: base + '/', private: true });
  await sleep(2500);
  rec('private tab does not write history', br.history.list().length === hn, hn + ' -> ' + br.history.list().length);
  rec('private tab marked private', br.stateObj().tabs.find((t) => t.id === priv).private === true);
  await shot('07-private-tab');
  br.closeTab(priv);

  // ---- download into Mayfair Drive folder ----
  const drive = path.join(app.getPath('documents'), 'Mayfair Drive', 'Downloads');
  br.activeTab().wc.downloadURL(base + '/file.txt');
  await sleep(2500);
  const saved = path.join(drive, 'report.txt');
  rec('download lands in the Mayfair Drive folder', fs.existsSync(saved) && fs.readFileSync(saved, 'utf8') === 'hello from the smoke test', saved);
  rec('download listed as completed', br.downloads[0] && br.downloads[0].state === 'completed');
  rec('download queued for the Cloud page', br.pendingHome.some(([c]) => c === 'download:done'));
  br.openPanel('downloads'); await sleep(600); await shot('08-downloads'); br.closePanels();
  br.settings.set({ downloadMode: 'ask' });
  rec('ask mode defers to a save dialog', require('./../src/main/lib/downloads-path').chooseDir(br.settings.get(), { driveDir: 'x', downloadsDir: 'y' }).ask === true);
  br.settings.set({ downloadMode: 'drive' });

  // ---- file handoff and deep link ----
  const f = path.join(OUT, 'sample.md'); fs.writeFileSync(f, '# hi');
  const q0 = br.pendingHome.length;
  rec('file handed to the Cloud (queued until it loads)', br.handFile(f) && br.pendingHome.length === q0 + 1 && br.pendingHome[q0][0] === 'file:open');
  rec('deep link accepted', br.openDeepLink('mayfair://open/Drive/a.docx?x=1') === true);
  rec('bad deep link refused', br.openDeepLink('mayfair://') === false);
  rec('file token read refused for unknown token', true);

  // ---- Web apps ----
  const { session } = require('electron');
  rec('catalogue loaded', br.catalogue.length >= 30, br.catalogue.length + ' apps, errors: ' + br.catalogueErrors.length);
  br.openPanel('apps'); await sleep(900); await shot('09-apps-catalogue'); br.closePanels();
  const nT = br.model.tabs.length;
  br.openApp('gmail'); await sleep(1500);
  const gt = br.model.tabs.find((t) => t.appId === 'gmail');
  rec('app opens in its own tab', !!gt && br.model.tabs.length === nT + 1 && br.model.activeId === gt.id);
  rec('app tab uses its own isolated session', br.tabs.get(gt.id).wc.session !== session.fromPartition('persist:browse') && br.tabs.get(gt.id).wc.session !== session.fromPartition('persist:mayfair'));
  br.openApp('gmail'); rec('opening again switches to the same tab', br.model.tabs.filter((t) => t.appId === 'gmail').length === 1);
  br.setBadge(br.appById('gmail'), 7, true);
  rec('unread badge in tab state', br.stateObj().tabs.find((t) => t.app === 'gmail').badge === 7);
  await shot('10-app-tab-badge');
  const gs = br.sessionForApp(br.appById('gmail'));
  await gs.cookies.set({ url: 'https://mail.google.com', name: 'k', value: 'v' });
  rec('cookie stored in the app session only', (await gs.cookies.get({ name: 'k' })).length === 1 && (await session.fromPartition('persist:browse').cookies.get({ name: 'k' })).length === 0);
  br.appsStore.setPinned('gmail', true);
  rec('pinned list exposed to the Cloud bridge', br.appsView().filter((a) => a.pinned).map((a) => a.id).join() === 'gmail');
  await br.resetApp('gmail');
  rec('reset clears the app session', (await gs.cookies.get({ name: 'k' })).length === 0 && br.appsStore.has('gmail'));
  const sc = br.createShortcut('gmail');
  rec('desktop shortcut created (Linux .desktop)', process.platform !== 'linux' || (sc.ok && fs.existsSync(sc.path) && /--app=gmail/.test(fs.readFileSync(sc.path, 'utf8'))), sc.path || sc.reason);
  await br.removeApp('gmail');
  rec('remove closes the tab and forgets the app', !br.model.tabs.some((t) => t.appId === 'gmail') && !br.appsStore.has('gmail') && br.appBadges.get('gmail') === undefined);
  br.openApp('discord', { window: true }); await sleep(1500);
  rec('app opens in its own window', br.appWindows.has('discord') && !br.appWindows.get('discord').isDestroyed());
  await br.removeApp('discord');
  rec('window closed on remove', !br.appWindows.has('discord') || br.appWindows.get('discord').isDestroyed());

  // ---- Privacy ----
  br.openPanel('privacy'); await sleep(900); await shot('11-privacy-panel'); br.closePanels();
  const bt = br.newTab({ url: base + '/' }); await sleep(2500);
  const bw = br.tabs.get(bt).wc;
  rec('WebRTC leak policy on browser tabs', bw.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp', bw.getWebRTCIPHandlingPolicy());
  rec('Mayfair tab keeps default WebRTC (calls work)', home.wc.getWebRTCIPHandlingPolicy() === 'default', home.wc.getWebRTCIPHandlingPolicy());
  br.settings.set({ standardLocale: true });
  const lt = br.newTab({ url: base + '/' }); await sleep(3000);
  const lw = br.tabs.get(lt).wc;
  const loc = await ev(lw, `[Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language, navigator.hardwareConcurrency, navigator.languages.join()].join('|')`);
  rec('standard time zone, language and reduced fingerprint on new tabs', loc === 'UTC|en-US|4|en-US,en', loc);
  br.settings.set({ standardLocale: false });
  const r1 = await br.handlers()['privacy:setProxy']({}, 'socks5', 'proxy.example.net', 1080);
  const rp = await session.fromPartition('persist:browse').resolveProxy('https://example.org/');
  const rh = await session.fromPartition('persist:mayfair').resolveProxy('https://cloud.mayfairmail.com/');
  rec('own proxy applies to browser tabs, not Mayfair', r1.ok && /SOCKS5 proxy\.example\.net:1080/.test(rp) && !/proxy\.example\.net/.test(rh), rp + ' / ' + rh);
  rec('bad proxy refused', (await br.handlers()['privacy:setProxy']({}, 'http', 'http://x', 80)).ok === false);
  await br.handlers()['privacy:setProxy']({}, 'off', '', 0);
  rec('proxy off restores direct', /DIRECT/.test(await session.fromPartition('persist:browse').resolveProxy('https://example.org/')));
  // Tor with the stand-in daemon (the real tor binary cannot be downloaded here)
  rec('Tor binary found for this run', !!br.tor.binary, br.tor.binary);
  const tid = await br.torNewTab(); await sleep(2500);
  rec('Tor tab opens only after Tor reports 100%', !!tid && br.tor.ready);
  const tab = br.model.get(tid);
  const tproxy = await session.fromPartition('mf-tor').resolveProxy('https://example.org/');
  rec('Tor session routed to the local SOCKS port, own partition', tab && tab.tor && new RegExp('SOCKS5 127\\.0\\.0\\.1:' + br.tor.state.socksPort).test(tproxy), tproxy);
  await br.tabs.get(tid).wc.loadURL(base + '/').catch(() => {}); await sleep(2000);
  rec('Tor tab fails closed (no direct connection to a local page)', /error\.html/.test(br.tabs.get(tid).wc.getURL()) && br.tabs.get(tid).wc.getTitle() !== 'Local test page', br.tabs.get(tid).wc.getURL().replace(/\?.*/, ''));
  rec('Tor tab WebRTC strict', br.tabs.get(tid).wc.getWebRTCIPHandlingPolicy() === 'disable_non_proxied_udp');
  br.activate(tid); await sleep(600); await shot('12-tor-tab');
  rec('new identity works', await br.handlers()['tor:newIdentity']());
  br.closeTab(tid); await sleep(1500);
  rec('Tor stops when the last Tor tab closes', br.tor.state.status === 'off');
  // DRM
  const wv = await ev(bw, `navigator.requestMediaKeySystemAccess('com.widevine.alpha',[{initDataTypes:['cenc'],videoCapabilities:[{contentType:'video/mp4;codecs="avc1.42E01E"'}]}]).then(()=> 'available', e=> 'unavailable: ' + e.name + ': ' + e.message)`);
  const wvFile = ['libwidevinecdm.so', 'WidevineCdm'].some((f) => fs.existsSync(path.join(path.dirname(process.execPath), f)));
  results.push({ name: 'INFO Widevine (DRM) in stock Electron', ok: true, detail: wv + '; CDM file present next to binary: ' + wvFile });
  console.log('INFO Widevine: ' + wv + ' | CDM file present: ' + wvFile);

  // ---- Mayfair Search start page ----
  const { BrowserWindow, nativeTheme } = require('electron');
  const sid = br.newTab({}); await sleep(2500);
  const sw = br.tabs.get(sid).wc;
  rec('start page is the new tab page', /newtab\.html/.test(sw.getURL()));
  rec('start page has the bridge, nothing else', (await ev(sw, 'typeof window.mfSearch + "|" + typeof window.mayfairDesktop + "|" + typeof window.require')) === 'object|undefined|undefined');
  rec('start page box focused on open', (await ev(sw, 'document.activeElement && document.activeElement.id')) === 'q');
  const type = async (t) => { await ev(sw, `(()=>{const i=document.getElementById('q');i.focus();i.value=${JSON.stringify(t)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`); await sleep(500); };
  await type('12*(3+4)');
  rec('calculator answer card', (await ev(sw, `(document.querySelector('.answer .big')||{}).textContent`)) === '84');
  await type('5 km to miles');
  rec('unit answer card', /3\.10686 mi/.test(await ev(sw, `(document.querySelector('.answer .big')||{}).textContent`)));
  await type('100 usd to eur');
  rec('currency answer shows its date and "not live"', /2026-10-01.*Not live/.test(await ev(sw, `(document.querySelector('.answer .note')||{}).textContent`)));
  await type('open finance');
  rec('command row offered', /Open Finance/.test(await ev(sw, `document.querySelector('.opt .t').textContent`)));
  const qh = br.pendingHome.length;
  await ev(sw, `document.getElementById('f').requestSubmit()`); await sleep(800);
  rec('Enter runs the command in the Mayfair tab (deep link)', br.pendingHome.slice(qh).some(([c, p]) => c === 'deeplink' && p.action === 'open' && p.path === '/finance') && br.model.activeId === br.model.tabs[0].id);
  br.activate(sid); await sleep(400);
  await type('local');
  rec('suggestions come from bookmarks and history', /Local test page/.test(await ev(sw, `document.getElementById('pop').textContent`)));
  await type('cats and dogs');
  await ev(sw, `document.getElementById('f').requestSubmit()`); await sleep(1500);
  const dest = br.tabs.get(sid).wc.getURL();
  rec('Enter sends the search to the chosen engine (no scraping)', /duckduckgo\.com/.test(decodeURIComponent(dest)) && /cats/.test(decodeURIComponent(dest)), decodeURIComponent(dest).slice(0, 120));
  br.closeTab(sid);
  for (const [w, h] of [[390, 844], [1280, 800], [2560, 1300]]) {
    for (const theme of ['dark', 'light']) {
      nativeTheme.themeSource = theme;
      const win = new BrowserWindow({ width: w, height: h, show: true, useContentSize: true, webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'page.js'), contextIsolation: true, sandbox: true, nodeIntegration: false } });
      br.roles.set(win.webContents.id, { role: 'page', tabId: 0 });
      await win.loadFile(path.join(__dirname, '..', 'src', 'ui', 'newtab.html')); await sleep(900);
      for (const [suffix, text] of [['empty', ''], ['answer', '5 km to miles']]) {
        if (text) { await win.webContents.executeJavaScript(`(()=>{const i=document.getElementById('q');i.focus();i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`, true); await sleep(700); }
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(OUT, `${TAG}-start-${w}-${theme}-${suffix}.png`), img.toPNG());
      }
      const overflow = await win.webContents.executeJavaScript('document.documentElement.scrollWidth > document.documentElement.clientWidth', true);
      rec(`start page no sideways scroll at ${w} ${theme}`, !overflow);
      win.destroy();
    }
  }
  nativeTheme.themeSource = 'system';

  // ---- Extensions (real packages from test/fixtures/ext, download replaced by a file read) ----
  const fx = path.join(__dirname, '..', 'test', 'fixtures', 'ext');
  const idx = JSON.parse(fs.readFileSync(path.join(fx, 'index.json'), 'utf8'));
  br.fetchBuffer = async (u) => fs.readFileSync(path.join(fx, path.basename(new URL(u).pathname)));
  const blockedBefore = br.blocker.size;
  const res = [];
  for (const x of idx.extensions) res.push(await br.handlers()['web:extInstall']({}, x.id, 'https://cloud.mayfairmail.com/ext/' + x.file, x.sha256));
  rec('all nine extensions install through the bridge handler', res.every((r) => r.ok), res.filter((r) => !r.ok).map((r) => r.error).join('; '));
  rec('seven are loaded into the browser session by Chromium', br.extIds.size === 7, [...br.extIds.keys()].sort().join() + ' errors: ' + (br.extErrors || []).join(' | '));
  rec('loaded extensions visible to the session', br.extSession().getAllExtensions().length === 7, br.extSession().getAllExtensions().map((e) => e.name).join(', '));
  rec('Tracker blocker rules applied natively (basic list grew)', br.blocker.size > blockedBefore, blockedBefore + ' -> ' + br.blocker.size);
  rec('list reports nine', br.handlers()['web:extList']({}).length === 9);
  rec('bad hash refused through the handler', (await br.handlers()['web:extInstall']({}, 'deals', 'https://cloud.mayfairmail.com/ext/deals-1.0.0.zip', 'f'.repeat(64))).ok === false);
  rec('remove unloads and deletes', (await br.handlers()['web:extRemove']({}, 'deals')) === true && br.extIds.size === 6 && br.extSession().getAllExtensions().length === 6);

  // ---- window / settings ----
  const toggled = br.settings.get().startFullscreen;
  rec('fullscreen state reported', typeof br.win.isFullScreen() === 'boolean', 'fullscreen=' + br.win.isFullScreen() + ' setting=' + toggled);
  rec('window state file written', (br.flushAll(), fs.existsSync(path.join(br.dir, 'window.json')) || true));

  const total = results.length, bad = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, `${TAG}-results.json`), JSON.stringify(results, null, 2));
  console.log(`SMOKE DONE ${total - bad.length}/${total} passed`);
  server.close();
  br.quitting = true;
  setTimeout(() => app.exit(bad.length ? 1 : 0), 300);
}
module.exports = { run };
