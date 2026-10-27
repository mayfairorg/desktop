#!/usr/bin/env node
'use strict';
// Packaged-like check under Xvfb with a real Electron binary:  node tools/packaged-check.js [electron-dist-dir] [variant,...]
//   1. builds the protected copy (tools/protect.js: minified src, integrity.json) and packs it into a real app.asar
//   2. copies the Electron folder (hard links, only the binary is rewritten), renames the binary so app.isPackaged is true
//   3. flips the fuses by patching the fuse wire in the binary (the same bytes @electron/fuses writes), with the sets tools/after-pack.js uses
//   4. starts the installed-style app with a mock Cloud page behind https://cloud.mayfairmail.com (host rules + a local https server)
//      and drives it over the Chromium debugging port: the Mayfair preload and its Browser bridge, tab views, and every UI page that is
//      loaded with file:// from inside the asar (start page, error page, tampered page) must work with GrantFileProtocolExtraPrivileges on.
// Variants: production (the set from src/main/lib/protect.js FUSES, must pass), stock (no fuse changed, must pass), tampered (a changed
// file in the asar: the Mayfair view must show the "changed" page and never open Cloud), nogrant (file:// privileges OFF: the negative
// control, must FAIL the UI checks), loose (loose app folder with OnlyLoadAppFromAsar on: must refuse to start).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');
const protect = require('./protect');
const { FUSES } = require('../src/main/lib/protect');

const ROOT = path.join(__dirname, '..');
const DIST = path.resolve(process.argv[2] || path.join(ROOT, '.electron-dl', 'dist'));
const WANT = (process.argv[3] || 'production,stock,tampered,nogrant,loose').split(',');
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
// V1 wire order of @electron/fuses
const ORDER = ['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

function readWire(binary) { const d = fs.readFileSync(binary); const i = d.indexOf(SENTINEL); return d.subarray(i + 34, i + 34 + d[i + 33]).toString('latin1'); }
function patchFuses(binary, set) {
  const d = fs.readFileSync(binary);
  const i = d.indexOf(SENTINEL);
  if (i < 0) throw new Error('fuse sentinel not found');
  const ver = d[i + 32], len = d[i + 33];
  if (ver !== 1 || len !== ORDER.length) throw new Error('unexpected fuse wire v' + ver + ' len ' + len);
  for (const [k, v] of Object.entries(set)) { const ix = ORDER.indexOf(k); if (ix < 0) throw new Error('unknown fuse ' + k); d[i + 34 + ix] = v ? 0x31 : 0x30; }
  fs.writeFileSync(binary, d);
  return d.subarray(i + 34, i + 34 + len).toString('latin1');
}

// asar: 4 | header size | json (padded) | file bytes
function writeAsar(srcDir, out) {
  const files = { off: 0, list: [] };
  const walk = (dir, node) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { node[e.name] = { files: {} }; walk(p, node[e.name].files); } else { const b = fs.readFileSync(p); node[e.name] = { size: b.length, offset: String(files.off) }; files.off += b.length; files.list.push(b); }
    }
  };
  const root = { files: {} };
  walk(srcDir, root.files);
  const hs = Buffer.from(JSON.stringify(root)); const al = (hs.length + 3) & ~3;
  const hp = Buffer.alloc(8 + al); hp.writeUInt32LE(4 + al, 0); hp.writeUInt32LE(hs.length, 4); hs.copy(hp, 8);
  const pre = Buffer.alloc(8); pre.writeUInt32LE(4, 0); pre.writeUInt32LE(hp.length, 4);
  fs.writeFileSync(out, Buffer.concat([pre, hp, ...files.list]));
}

function linkTree(from, to) { execFileSync('cp', ['-al', from, to]); }

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error('ws error')); });
    this.ws.onmessage = (m) => { const o = JSON.parse(m.data); const p = this.pending.get(o.id); if (p) { this.pending.delete(o.id); o.error ? p.rej(new Error(o.error.message)) : p.res(o.result); } };
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : 'eval error'); return r.result.value; }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}
const targets = (port) => new Promise((res) => { http.get({ host: '127.0.0.1', port, path: '/json/list' }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch { res([]); } }); }).on('error', () => res([])); });
async function waitTarget(port, pred, ms = 20000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const t = (await targets(port)).find(pred); if (t) return t; await sleep(250); } return null; }

async function runVariant(name, work, cert) {
  const dir = path.join(work, 'dist-' + name);
  linkTree(DIST, dir);
  const bin = path.join(dir, 'mayfair-desktop');
  fs.rmSync(path.join(dir, 'electron'));
  fs.copyFileSync(path.join(DIST, 'electron'), bin); fs.chmodSync(bin, 0o755);
  const res = path.join(dir, 'resources');
  fs.rmSync(path.join(res, 'default_app.asar'), { force: true });
  const set = name === 'stock' ? {} : { ...FUSES };      // stock: the binary exactly as shipped by Electron
  if (name === 'nogrant') set.GrantFileProtocolExtraPrivileges = false;
  const base = readWire(bin);
  const wire = patchFuses(bin, set);
  const expected = base.split('').map((c, i) => (set[ORDER[i]] === undefined ? c : set[ORDER[i]] ? '1' : '0')).join('');
  // the app
  const built = path.join(work, 'built-' + name);
  protect.run({ quiet: true, out: built });
  if (name === 'tampered') fs.appendFileSync(path.join(built, 'src', 'ui', 'ui.css'), '\n/* changed after the build */\n');
  if (name === 'loose') fs.cpSync(built, path.join(res, 'app'), { recursive: true }); else writeAsar(built, path.join(res, 'app.asar'));

  const home = fs.mkdtempSync(path.join(work, 'home-'));
  const out = { name, wire, set, checks: [], stderr: '' };
  const ck = (n, ok, d) => { out.checks.push({ n, ok: !!ok, d: d === undefined ? '' : String(d) }); log((ok ? '  PASS ' : '  FAIL ') + n + (d ? '  [' + d + ']' : '')); };

  // servers: mock Cloud over https, a plain page for tabs
  const cloudHtml = fs.readFileSync(path.join(__dirname, 'smoke-cloud.html'), 'utf8');
  const hs = https.createServer({ key: cert.key, cert: cert.cert }, (q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(cloudHtml); });
  await new Promise((r) => hs.listen(0, '127.0.0.1', r));
  const ps = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<title>Plain page</title><p>hello</p>'); });
  await new Promise((r) => ps.listen(0, '127.0.0.1', r));
  const cport = hs.address().port, pport = ps.address().port;
  const dport = 9400 + Math.floor(Math.random() * 400);
  const args = ['-a', '-s', '-screen 0 1280x800x24', bin, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=' + dport,
    `--host-resolver-rules=MAP cloud.mayfairmail.com 127.0.0.1:${cport}, MAP mayfairmail.com 127.0.0.1:${cport}`, '--ignore-certificate-errors'];
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));   // a proxy from the environment would be used for the mock Cloud address
  const child = spawn('xvfb-run', args, { env: { ...cleanEnv, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), MAYFAIR_DESKTOP_DATA: path.join(home, 'data'), MAYFAIR_TOR_BIN: '' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stderr.on('data', (c) => { out.stderr += c; }); child.stdout.on('data', (c) => { out.stderr += c; });
  let exited = null; child.on('exit', (c) => { exited = c; });
  try {
    ck('fuse wire in the binary equals the intended set', wire === expected, wire + ' (' + ORDER.map((k, i) => k.replace(/^Enable/, '') + '=' + wire[i]).join(' ') + ')');
    if (name === 'loose') {
      await sleep(7000);
      ck('loose app folder is refused (OnlyLoadAppFromAsar)', exited !== null || !(await targets(dport)).length, 'exit ' + exited + ', targets ' + (await targets(dport)).length);
      return out;
    }
    const homeT = await waitTarget(dport, (t) => t.type === 'page' && (/cloud\.mayfairmail\.com/.test(t.url) || /tampered\.html/.test(t.url)));
    ck('app started and the Mayfair view loaded a page', !!homeT, homeT ? homeT.url : 'no target; exit ' + exited);
    if (!homeT) return out;
    ck('no "installed files do not match" message', name === 'tampered' ? /do not match/.test(out.stderr) : !/do not match/.test(out.stderr), name === 'tampered' ? 'expected for the changed copy' : '');
    const h = new Cdp(homeT.webSocketDebuggerUrl); await h.open();
    const style = (c) => c.eval(`JSON.stringify({sheets:[...document.styleSheets].map(s=>{try{return s.cssRules.length}catch(e){return -1}}),bg:getComputedStyle(document.body).backgroundColor,font:getComputedStyle(document.body).fontFamily.slice(0,30)})`).then(JSON.parse);
    if (name === 'tampered') {
      ck('changed install shows the "changed" page from the asar, not Mayfair Cloud', /tampered\.html/.test(homeT.url) && !/cloud\.mayfairmail\.com/.test(homeT.url), homeT.url);
      await sleep(1000);
      const s = await style(h);
      ck('the page is styled (file:// stylesheet from the asar applied)', s.sheets.length && s.sheets.every((n) => n > 0), JSON.stringify(s));
      h.close(); return out;
    }
    await sleep(1500);
    const bridgeSeen = await h.eval('document.title + "|" + (typeof window.mayfairDesktop + "|" + typeof (window.mayfairDesktop && window.mayfairDesktop.browser)) + "|" + location.href');
    ck('mock Cloud page and the Browser bridge present', bridgeSeen.startsWith('Mock Cloud|object|object'), bridgeSeen);
    const rd = await h.eval('window.mayfairDesktop.browser.ready().then(r=>JSON.stringify({v:r.version,f:r.features.length,t:r.state.tabs.length}))');
    ck('ready() answers from the installed build', /"f":1[0-9]/.test(rd) && /"t":0/.test(rd), rd);
    const t1 = await h.eval(`window.mayfairDesktop.browser.newTab({url:'http://127.0.0.1:${pport}/'}).then(r=>r.id)`);
    await sleep(2500);
    const st = await h.eval('JSON.stringify(T.state)').then(JSON.parse);
    ck('tab view loaded a web page (state event)', st.tabs.length === 1 && st.tabs[0].title === 'Plain page' && st.activeId === t1, JSON.stringify(st.tabs[0]));
    const tab = await waitTarget(dport, (t) => /127\.0\.0\.1:\d+\/$/.test(t.url) && t.url.includes(String(pport)));
    ck('tab shows in the debugging list as its own view', !!tab);
    // start page: file:// inside the asar, own script, own CSS, preload bridge
    await h.eval('window.mayfairDesktop.browser.newTab({})');
    const sp = await waitTarget(dport, (t) => /newtab\.html/.test(t.url));
    ck('start page loads with file:// from the asar', !!sp, sp ? sp.url.replace(/\?.*/, '') : '');
    if (sp) {
      const s = new Cdp(sp.webSocketDebuggerUrl); await s.open();
      await sleep(800);
      const sty = await style(s);
      ck('start page is styled (both stylesheets applied: CSP self matches on file://)', sty.sheets.length >= 2 && sty.sheets.every((n) => n > 0), JSON.stringify(sty));
      ck('start page script ran and has only the search bridge', (await s.eval('typeof window.mfSearch + "|" + typeof window.mayfairDesktop + "|" + typeof window.require + "|" + !!document.getElementById("quick").children.length')) === 'object|undefined|undefined|true');
      await s.eval(`(()=>{const i=document.getElementById('q');i.focus();i.value='12*(3+4)';i.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await sleep(600);
      ck('start page calculator answer renders', (await s.eval(`(document.querySelector('.answer .big')||{}).textContent`)) === '84');
      s.close();
    }
    // error page inside a tab
    await h.eval(`window.mayfairDesktop.browser.newTab({url:'http://127.0.0.1:9/'})`);
    const ep = await waitTarget(dport, (t) => /error\.html/.test(t.url) && /127\.0\.0\.1:9/.test(decodeURIComponent(t.url)));
    ck('error page loads with file:// from the asar', !!ep);
    if (ep) { const e = new Cdp(ep.webSocketDebuggerUrl); await e.open(); await sleep(300); const sty = await style(e); ck('error page is styled and filled in', sty.sheets.every((n) => n > 0) && (await e.eval(`document.getElementById('u').textContent`)).includes('127.0.0.1:9'), JSON.stringify(sty)); e.close(); }
    // the Mayfair view cannot be turned into another site, devtools shortcut closed in an installed build
    ck('developer tools are off in the installed build (bridge says so)', (await h.eval('window.mayfairDesktop.browser.ready().then(r=>r.devtools)')) === false);
    ck('devtools(id) is refused', /blocked: devtools/.test(await h.eval(`window.mayfairDesktop.browser.devtools(${t1}).then(()=>'allowed',e=>e.message)`)));
    h.close();
  } catch (e) { ck('check run without an exception', false, e.message); } finally {
    try { process.kill(-child.pid); } catch { /* not a group */ }
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    hs.close(); ps.close();
    await sleep(800);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}

(async () => {
  if (!fs.existsSync(path.join(DIST, 'electron'))) { console.error('No Electron folder at ' + DIST); process.exit(2); }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-packaged-'));
  const certDir = path.join(work, 'cert');
  fs.mkdirSync(certDir);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'), '-days', '2', '-subj', '/CN=cloud.mayfairmail.com'], { stdio: 'ignore' });
  const cert = { key: fs.readFileSync(path.join(certDir, 'k.pem')), cert: fs.readFileSync(path.join(certDir, 'c.pem')) };
  const all = [];
  for (const v of WANT) { log('== variant ' + v); all.push(await runVariant(v, work, cert)); }
  fs.rmSync(work, { recursive: true, force: true });
  const expectFail = new Set(['nogrant']);
  let bad = 0;
  log('\nSummary');
  for (const o of all) {
    const failed = o.checks.filter((c) => !c.ok).length;
    const good = expectFail.has(o.name) ? failed > 0 : failed === 0;
    if (!good) bad++;
    log(`  ${good ? 'OK ' : 'BAD'} ${o.name}: ${o.checks.length - failed}/${o.checks.length} checks passed${expectFail.has(o.name) ? ' (negative control: failures expected)' : ''}  fuses ${o.wire}`);
  }
  process.exit(bad ? 1 : 0);
})();
