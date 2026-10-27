'use strict';
// Layout check for the Ghost skins. Run by tools/ghost-layout-shots.js under xvfb, once per window size. Never part of the packaged app.
// It opens the real Ghost window with the real service and vault (stand-in OS key store, stand-in Mayfair ID), then for every skin:
//   structure (the key regions of that skin's layout exist), real-data binding (an empty state first, then a case with places, lookups and a vault),
//   no horizontal page scroll, keyboard use, reduced motion, text contrast measured on the drawn page, and screenshots of Home, Domains and the Case board.
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
  const CONTRAST = `(()=>{const parse=(s)=>{const m=/rgba?\\(([^)]+)\\)/.exec(s);if(!m)return null;const p=m[1].split(/[ ,/]+/).filter(Boolean).map(Number);return {r:p[0],g:p[1],b:p[2],a:p[3]===undefined?1:p[3]}};
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
  const contrast = async (label) => { await js('document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) {} })'); await sleep(250); const c = await js(CONTRAST); rec(`contrast AA ${label}`, c.nbad === 0, c.nbad ? c.nbad + ' of ' + c.n + ': ' + JSON.stringify(c.bad) : c.n + ' text runs checked'); };
  const set = async (skin) => { await js(`GH.appearance.set({skin:'${skin}'})`); await sleep(350); };
  const go = async (hash, sel) => { await js(`location.hash=${JSON.stringify(hash)}`); await sleep(350); if (sel) await waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 6000); await sleep(250); };

  const HOME = {
    mayfair: ['.rail', '.top', 'main#main', '.status', '.hero', '.mods'],
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

    // ----- the real connectors: approve and test a few so some states are not the default (the approval window is answered by the test hook) -----
    const tried = await js(`(async()=>{const out=[];for(const id of ['hash-file','local-snapshot','exif-meta','dns-doh']){try{const a=await GH.call(GH.api.connectors.requestApproval,id);if(!a||a.ok===false){out.push(id+':declined');continue}const t=await GH.call(GH.api.connectors.test,id);await GH.call(GH.api.connectors.enable,id);out.push(id+':'+(t&&t.passed?'passed':'failed'))}catch(e){out.push(id+':'+e.message)}}GH.conn.bust();return out})()`);
    console.log('CONNECTORS', JSON.stringify(tried));

    // ----- EMPTY states: no case, no lookups -----
    for (const sk of Sk.SKINS) {
      await set(sk.id); await go('#home');
      rec(`skin ${sk.id}: data-skin applied and saved in the vault`, (await js('document.documentElement.dataset.skin')) === sk.id && A.prefsGet().skin === sk.id, JSON.stringify(A.prefsGet()));
      await regions(`${sk.id} home (empty)`, HOME[sk.id]);
      const t = await text();
      const emptyOk = { mayfair: /No cases yet/i.test(t), ops: /No case is open/i.test(t) && /No lookups yet/i.test(t), terminal: /No jobs have run in this window/i.test(t) && /No cases yet/i.test(t) && /No case is open/i.test(t), hud: /No case is open/i.test(t) && /No activity yet|0 event/i.test(t) || /No cases yet/i.test(t), mono: /nothing looked up in this window yet/i.test(t) && /No lookups have run/i.test(t) }[sk.id];
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
        rec('terminal: function-key bar has every page', (await count('.tm-keys .tk')) >= 12);
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
        rec('mono: stat row shows the case entity count', /12/.test(await js("document.querySelector('.mn-stats').innerText")), '');
        rec('mono: last lookup shown as a character progress bar', (await count('.mn-last .mn-ch')) === 1);
        rec('mono: headline is large', (await js("parseFloat(getComputedStyle(document.querySelector('.mn-h')).fontSize)")) >= (W >= 1024 ? 48 : 30));
      }
      await contrast(`${sk.id} home`);
      await shot(`${sk.id}-home`);
      // Domains
      await go('#m/domains', '.mod-view'); await noOverflow(`${sk.id} domains`); await contrast(`${sk.id} domains`);
      if (sk.id !== 'mayfair') rec(`${sk.id}: Domains shows the real connector states for the module`, (await count('.mod-view .ccard')) >= 3 && /not installed|Test passed|Needs approval|Not tested|Test failed|Needs your approval/i.test(await js("document.querySelector('.mod-view').innerText")));
      await shot(`${sk.id}-domains`);
      // Case board
      await go('#case/' + c.id, '#tab-graph'); await waitFor("document.querySelectorAll('.graph .node').length>=9"); await sleep(400);
      await noOverflow(`${sk.id} board`); await contrast(`${sk.id} board`);
      if (sk.id !== 'mayfair') rec(`${sk.id}: board has the skin's case summary from the open case`, (await count('.bd-strip > *')) === 1 && /12|entities/i.test(await js("document.querySelector('.bd-strip').innerText")));
      await shot(`${sk.id}-board`);
      // other screens must not overflow either
      for (const hsh of ['#case', '#tools', '#modules', '#settings/appearance']) { await go(hsh); await noOverflow(`${sk.id} ${hsh}`); }
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
    await go('#home'); rec('mayfair home is the original design (sidebar, hero, module cards)', (await count('.rail')) === 1 && (await count('.hero')) === 1 && (await count('.mods .mod')) === 9);
    rec('no console errors', pageErr.length === 0, pageErr.slice(0, 3).join(' | '));
  } catch (e) { rec('harness error', false, e && e.stack); }
  fs.writeFileSync(path.join(OUT, `${TAG}-layout-results.json`), JSON.stringify(results, null, 1));
  const failed = results.filter((r) => !r.ok).length; console.log(`DONE ${results.length - failed}/${results.length}`);
  try { ghost.shutdown(); await mock.close(); } catch { /* ok */ }
  eapp.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); eapp.exit(2); });
