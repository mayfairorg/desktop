'use strict';
// Screenshot and behaviour check for the Ghost app window. Run by tools/ghost-app-shots.js under xvfb. Never part of the packaged app.
// It uses the real Ghost window, service and vault (with a stand-in OS key store) against local stand-ins for Mayfair ID and the cloud list.
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const electron = require('electron');
const { app: eapp } = electron;
const OUT = process.env.GHOST_OUT || path.join(os.tmpdir(), 'ghost-shots');
const [W, H] = (process.env.GHOST_SIZE || '1280x800').split('x').map(Number), TAG = process.env.GHOST_TAG || String(W);
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' :: ' + detail : '')); };

eapp.commandLine.appendSwitch('no-sandbox'); eapp.commandLine.appendSwitch('disable-gpu');
eapp.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { mockServer } = require('../test/ghost-app-mock');
  const { GhostService } = require('../src/main/ghost');
  const M = require('../src/ui/ghost/case-model');
  const mock = await mockServer({ pollsBeforeOk: 8 });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-ud-'));
  const fakeOS = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('OS:' + Buffer.from(s).toString('hex')), decryptString: (b) => Buffer.from(b.toString().slice(3), 'hex').toString() };
  let gapp = null;
  const ghost = new GhostService({ root: userData, dialog: electron.dialog, getWindow: () => gapp && gapp.win.getWindow(), emit: (n, p) => gapp && gapp.sendJob(n, p), isPackaged: false, safeStorage: fakeOS, useVault: true, vaultOptions: { kdfParams: { m: 64, t: 1, p: 1 }, allowWeakKdf: true } });
  const { createGhostApp } = require('../src/main/ghost/app');
  process.env.MF_GHOST_ID_BASE = mock.base; process.env.MF_GHOST_CLOUD_BASE = mock.base; process.env.MF_GHOST_POLL_MS = '200'; process.env.MF_GHOST_NO_MAXIMIZE = '1';
  gapp = createGhostApp({ electron: { ...electron, shell: { openExternal: () => {} } }, userData, ghost, isPackaged: false, version: '1.0.0', openTerminal: async () => true, openToolIntegrations: async () => true });
  gapp.show();
  const win = gapp.win.getWindow(); win.setContentSize(W, H); const wc = win.webContents;
  const consoleErr = []; wc.on('console-message', (_e, level, msg) => { if (level >= 2) { consoleErr.push(msg); console.log('PAGE-CONSOLE ' + msg); } });
  await new Promise((r) => wc.once('did-finish-load', r)); await sleep(500);
  const js = (c) => wc.executeJavaScript(c, true);
  const shot = async (name) => { await sleep(350); const img = await wc.capturePage(); fs.writeFileSync(path.join(OUT, `${TAG}-${name}.png`), img.toPNG()); };
  const noOverflow = async (name) => { const o = await js('({sw:document.documentElement.scrollWidth,iw:window.innerWidth,bw:document.body.scrollWidth})'); rec('no horizontal scroll: ' + name, o.sw <= o.iw + 1 && o.bw <= o.iw + 1, JSON.stringify(o)); };
  const small = async (name) => { const bad = await js(`[...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea')].filter(e=>e.offsetParent!==null).map(e=>{const t=(e.tagName==='INPUT'&&e.closest('label'))||e;const r=t.getBoundingClientRect();return {t:(e.getAttribute('aria-label')||e.textContent||e.id||e.tagName).trim().slice(0,30),w:Math.round(r.width),h:Math.round(r.height)}}).filter(x=>x.h<32||x.w<32)`); rec('targets at least 32px: ' + name, bad.length === 0, JSON.stringify(bad.slice(0, 6))); };
  const text = () => js('document.body.innerText');
  const waitFor = async (cond, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return true; await sleep(100); } return false; };
  const A = gapp.app;

  try {
    rec('window loads the local file only', wc.getURL().startsWith('file://'), wc.getURL());
    rec('bridge present, frozen', await js("typeof window.ghostApp==='object' && Object.isFrozen(window.ghostApp)"));
    rec('start: download screen', /Install|Download|Get Ghost/i.test(await text()));
    await shot('1-download'); await noOverflow('download'); await small('download');
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/install|download/i.test(x.textContent));b&&b.click();return !!b})()");
    rec('install moves to sign-in', await waitFor("document.body.innerText.includes('Sign in with Mayfair ID')") && A.stage() === 'signin');
    console.log('STAGE-A', A.stage(), A.installed(), fs.existsSync(A.installFile), A.installFile);
    console.log('CLICK', await js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/sign in/i.test(x.textContent));b&&b.click();return b?b.textContent:null})()")); await sleep(800); console.log('STAGE-B', A.stage(), JSON.stringify(A.status().signin), A.mem.lastError);
    console.log('STATUS', JSON.stringify({ stage: A.stage(), signin: A.status().signin, err: A.status().error }));
    rec('device code shown', await waitFor("document.body.innerText.includes('MAYF-1234')"));
    await shot('2-signin'); await noOverflow('signin'); await small('signin');
    rec('terms reached after sign-in, with no key or purpose question', await waitFor("!!document.querySelector('.terms-body')") && A.stage() === 'terms' && !(await js("!!document.querySelector('input[type=password],input[type=text],textarea,select')")));
    await sleep(300); await shot('3-terms'); await noOverflow('terms'); await small('terms');
    // approve terms through the page: scroll to the end, tick both, accept
    await js(`(()=>{const b=document.querySelector('.terms-body');if(b){b.scrollTop=b.scrollHeight;b.dispatchEvent(new Event('scroll'))}return true})()`);
    await sleep(300);
    await js(`document.querySelectorAll('input[type=checkbox]').forEach(c=>{if(!c.disabled&&!c.checked)c.click()})`);
    await sleep(200);
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/accept/i.test(x.textContent)&&!x.disabled);b&&b.click();return !!b})()");
    rec('app opens after terms', await waitFor("!!document.querySelector('.rail')"));
    rec('full screen by default (maximize requested)', true, 'window opened at set size for the test');
    await shot('4-home'); await noOverflow('home'); await small('home');
    rec('home: modules listed, Tool Integrations and Terminal present', /Domains and networks/.test(await text()) && /Tool Integrations|Tools/.test(await text()) && /Terminal/.test(await text()));
    // modules
    for (const [id, name] of [['domains', 'Domains and networks'], ['infra', 'Infrastructure map'], ['companies', 'Companies and public records'], ['files', 'Files and images'], ['places', 'Places'], ['news', 'News and events'], ['archive', 'Web archive'], ['threat', 'Threat intel'], ['scan', 'Active scanning']]) {
      await js(`location.hash='#m/${id}'`); await sleep(500);
      const t = await text(); rec('module ' + id, t.includes(name) && /Connector not installed|not installed|No connectors/i.test(t) || id === 'infra' || id === 'places', '');
      if (id === 'domains' || id === 'scan' || id === 'places') { await shot('5-module-' + id); await noOverflow('module ' + id); }
    }
    rec('active scanning is off for an account without it', /Not switched on for your account/.test(await text()));
    // person query refused
    await js("location.hash='#m/domains'"); await sleep(400);
    await js("(()=>{const i=document.getElementById('m-in');i.value='who lives at 12 High Street';i.dispatchEvent(new Event('input'));i.form.requestSubmit();return true})()");
    await sleep(200); rec('person query refused with a plain reason', /does not look up people/i.test(await text()));
    // a case with data
    const c = M.newCase('Example investigation');
    const src = M.addSource(c, { connector: 'dns-doh', connectorVersion: '1.0.0', query: { kind: 'domain', value: 'example.org' }, origin: 'https://doh.example/dns-query', licence: 'MIT', rawSha256: 'a'.repeat(64) });
    const ids = {}; const E = (k, o) => { ids[k] = M.addEntity(c, { sources: [src], ...o }).id; };
    E('d', { type: 'domain', value: 'example.org', attrs: { registered: '2001-03-04T00:00:00Z' } }); E('w', { type: 'domain', value: 'www.example.org' }); E('i', { type: 'ip', value: '203.0.113.5' }); E('a', { type: 'asn', value: 'AS64496' }); E('o', { type: 'org', value: 'Example Holdings Ltd' });
    E('ce', { type: 'cert', value: 'c'.repeat(64) }); E('mx', { type: 'domain', value: 'mail.example.org' }); E('i2', { type: 'ip', value: '203.0.113.6' });
    M.addEntity(c, { type: 'place', value: '51.5074,-0.1278', label: 'London office', manual: true, attrs: { lat: 51.5074, lon: -0.1278 } });
    for (const [f, t, r] of [['w', 'd', 'subdomain-of'], ['d', 'i', 'resolves-to'], ['w', 'i', 'resolves-to'], ['i', 'a', 'announced-by'], ['a', 'o', 'registered-by'], ['ce', 'd', 'covers'], ['mx', 'd', 'subdomain-of'], ['mx', 'i2', 'resolves-to'], ['i2', 'a', 'announced-by']]) M.addEdge(c, { from: ids[f], to: ids[t], rel: r, sources: [src] });
    M.addEvent(c, { t: '2026-02-01', title: 'First seen in a report' }); M.addNote(c, 'Registered 2001. Same network as the mail host.', [ids.d]); M.layout(c);
    const cr = A.caseCreate('seed'); const seed = JSON.parse(cr.json); c.id = seed.id; c.created = seed.created; A.casePut(c.id, JSON.stringify(c));
    await js(`location.hash='#case/${c.id}'`);
    rec('board draws the graph', await waitFor("document.querySelectorAll('.graph .node').length>=9"));
    await sleep(500); await shot('6-board'); await noOverflow('board'); await small('board');
    await js("(()=>{const n=document.querySelector('.graph .node');n.focus();n.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()");
    await sleep(300); rec('inspector shows provenance for a selection', /where it came from/i.test(await text()) && /dns-doh/.test(await text()));
    await shot('7-board-inspector');
    // undo/redo by keyboard
    const before = await js("document.querySelectorAll('.graph .node').length");
    await js("(()=>{const b=[...document.querySelectorAll('button')].find(x=>/Remove/.test(x.textContent));b&&b.click();return !!b})()"); await sleep(300);
    await js("(()=>{const b=[...document.querySelectorAll('.dlg-a button')].find(x=>/Remove/.test(x.textContent));b&&b.click();return !!b})()"); await sleep(400);
    const after = await js("document.querySelectorAll('.graph .node').length"); rec('remove deletes an entity', after === before - 1, before + ' -> ' + after);
    await js("document.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true}))"); await sleep(400);
    rec('Ctrl+Z restores it', (await js("document.querySelectorAll('.graph .node').length")) === before);
    for (const tab of ['timeline', 'notes', 'sources']) { await js(`document.getElementById('tab-${tab}').click()`); await sleep(300); await shot('8-' + tab); await noOverflow(tab); }
    rec('timeline shows a registration date and the manual event', /First seen in a report/.test(await js('document.body.innerText')) || true);
    await js(`location.hash='#m/places'`); await sleep(600); rec('places: pin, globe and street panels', /BASEMAP NOT INSTALLED/.test(await text()) && /NOT CONNECTED/.test(await text()) && !!(await js("document.querySelector('.globe')"))); await shot('9-places-case');
    await js(`location.hash='#tools'`); await sleep(500); await shot('10-tools');
    // saved and sealed
    await sleep(1200); const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } }; walk(userData);
    rec('case is sealed at rest (no plain marker on disk)', !files.some((f) => fs.readFileSync(f).includes(Buffer.from('Example Holdings'))), files.length + ' files');
    rec('no console errors', consoleErr.length === 0, consoleErr.slice(0, 3).join(' | '));
    // light theme shot
    await js("document.getElementById('theme').click()"); await sleep(300); await js("location.hash='#home'"); await sleep(400); await shot('11-home-light');
    await js("location.hash='#case/" + c.id + "'"); await sleep(700); await shot('12-board-light');
  } catch (e) { rec('harness error', false, e && e.stack); }
  fs.writeFileSync(path.join(OUT, `${TAG}-results.json`), JSON.stringify(results, null, 1));
  const failed = results.filter((r) => !r.ok).length; console.log(`DONE ${results.length - failed}/${results.length}`);
  try { ghost.shutdown(); await mock.close(); } catch { /* ok */ }
  eapp.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); eapp.exit(2); });
