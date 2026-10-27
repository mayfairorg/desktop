'use strict';
// Ghost investigation browser: toolbar page of a case window. Text only (textContent), no remote content.
(() => {
  const $ = (id) => document.getElementById(id);
  const gb = window.ghostBrowser;
  const ICON = { back: 'M15 18l-6-6 6-6', fwd: 'M9 18l6-6-6-6', reload: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5', stop: 'M6 6l12 12M18 6L6 18' };
  const NS = ['http:', '', 'www.w3.org', '2000', 'svg'].join('/');   // the SVG namespace name, not an address that is ever fetched
  const icon = (d) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'i'); const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p); return s; };
  const setIcon = (el, k) => { el.replaceChildren(icon(ICON[k])); };
  setIcon($('back'), 'back'); setIcon($('fwd'), 'fwd'); setIcon($('reload'), 'reload');
  let st = null, panelOpen = false, msgTimer = 0;
  const say = (t) => { const m = $('msg'); m.textContent = t; m.hidden = false; clearTimeout(msgTimer); msgTimer = setTimeout(() => { m.hidden = true; }, 6000); };

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function renderPanel() {
    const p = $('panel'); p.replaceChildren();
    if (!st) return;
    p.appendChild(el('h2', '', 'Blocked requests'));
    if (!st.blocked.length) p.appendChild(el('p', 'r', 'Nothing blocked yet.'));
    const seen = new Set();
    for (const b of st.blocked.slice().reverse()) {
      const k = b.host + '|' + b.reason; if (seen.has(k)) continue; seen.add(k);
      const r = el('div', 'rowx'); r.appendChild(el('span', 'u', (b.host || b.url) + (b.kind === 'top' ? '  (address you opened)' : '')));
      r.appendChild(el('span', 'r', b.reason));
      if (b.canAllow && b.host) { const a = el('button', 'btn line sm', 'Allow for this case'); a.addEventListener('click', async () => { const x = await gb.allowHost(b.host); if (!x.ok) say(x.error); else if (b.kind === 'top') gb.reload(); }); r.appendChild(a); }
      p.appendChild(r);
    }
    p.appendChild(el('h2', '', 'Allowed for this case'));
    p.appendChild(el('p', 'r', st.allowed.length ? st.allowed.join(', ') : 'Nothing yet. Open an address, then allow the sites it needs.'));
    p.appendChild(el('h2', '', 'What this window does not hide'));
    const ul = el('ul');
    ul.appendChild(el('li', '', st.exposesIp ? 'Direct route: sites and your network see your real IP address. Only the name lookups are encrypted.' : 'Tor hides your IP address from the site, not from Tor itself. The exit relay sees unencrypted traffic and the site name you ask for.'));
    ul.appendChild(el('li', '', 'Anything you sign in to links your activity to that account.'));
    for (const l of st.limits) ul.appendChild(el('li', '', l));
    p.appendChild(ul);
  }
  function setPanel(open) {
    panelOpen = open; $('panel').hidden = !open; $('blocked').setAttribute('aria-expanded', String(open));
    gb.panel(open ? 260 : 0);
    if (open) renderPanel();
  }
  function render(s) {
    st = s; if (!s) return;
    const c = $('chip'); c.className = 'chip ' + s.tone; c.textContent = s.text;
    c.title = 'Route: ' + s.route + '. DNS: ' + s.dns + '. Case: ' + s.case;
    $('modname').textContent = s.module; $('vault').textContent = 'Vault ' + s.vault;
    $('blocked').textContent = 'Blocked ' + s.blockedCount;
    const n = s.nav || {};
    $('back').disabled = !n.canGoBack; $('fwd').disabled = !n.canGoForward;
    setIcon($('reload'), n.loading ? 'stop' : 'reload'); $('reload').setAttribute('aria-label', n.loading ? 'Stop' : 'Reload');
    if (document.activeElement !== $('addr') && n.url && n.url !== 'about:blank') $('addr').value = n.url;
    if (n.error) say(n.error);
    document.title = (n.title ? n.title + ' · ' : '') + 'Ghost: ' + s.case;
    $('capture').disabled = s.vault !== 'unlocked';
    $('capture').title = s.vault === 'unlocked' ? 'Save this page into the case (HTML, screenshot, hash, time)' : 'Unlock the Ghost vault to save captures';
    if (panelOpen) renderPanel();
  }
  $('back').addEventListener('click', () => gb.back()); $('fwd').addEventListener('click', () => gb.forward());
  $('reload').addEventListener('click', () => { if (st && st.nav && st.nav.loading) gb.stop(); else gb.reload(); });
  $('addr').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const v = $('addr').value.trim(); if (!v) return;
    const r = await gb.navigate(v);
    if (!r.ok && r.code === 'blocked') { setPanel(true); say(r.error + (r.canAllow ? ' Use "Allow for this case" to open it.' : '')); }
    else if (!r.ok) say(r.error);
  });
  $('blocked').addEventListener('click', () => setPanel(!panelOpen));
  $('capture').addEventListener('click', async () => { const r = await gb.capture(); say(r.ok ? 'Saved to the case, ' + r.snapshot.html.sha256.slice(0, 12) + ' (page hash).' : r.error); });
  $('kill').addEventListener('click', () => gb.kill());
  gb.onState((s) => { if (s.notice) say(s.notice); if (s.block && s.block.kind === 'top' && s.block.canAllow && !panelOpen) setPanel(true); render(s); });
  gb.onKilled(() => { document.body.textContent = 'Closed, wiped and locked.'; });
  gb.info().then((r) => render(r.status)).catch(() => {});
})();
