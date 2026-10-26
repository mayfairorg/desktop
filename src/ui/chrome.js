'use strict';
const $ = (id) => document.getElementById(id);
const ic = window.mfIcon;
let S = null;
let dragId = null;

const setIcons = () => {
  $('newtab').innerHTML = ic('plus');
  $('back').innerHTML = ic('back'); $('fwd').innerHTML = ic('fwd');
  $('dl').innerHTML = ic('download'); $('menu').innerHTML = ic('dots'); $('menu0').innerHTML = ic('dots');
  $('pw').innerHTML = ic('key');
};

function renderTabs() {
  const host = $('tabs');
  host.textContent = '';
  for (const t of S.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === S.activeId ? ' active' : '') + (t.pinned ? ' pinned' : '') + (t.private ? ' priv' : '') + (t.tor ? ' tor' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(t.id === S.activeId));
    el.tabIndex = t.id === S.activeId ? 0 : -1;
    el.title = t.title;
    el.draggable = !t.pinned;
    if (t.pinned) el.innerHTML = ic('home') + '<span class="t">Mayfair</span>';
    else {
      if (t.favicon) { const im = document.createElement('img'); im.className = 'fav'; im.src = t.favicon; im.alt = ''; im.onerror = () => im.remove(); el.appendChild(im); }
      else el.insertAdjacentHTML('beforeend', ic('globe'));
      const sp = document.createElement('span'); sp.className = 't'; sp.textContent = t.title; el.appendChild(sp);
      if (t.badge) { const bd = document.createElement('span'); bd.className = 'bd'; bd.textContent = t.badge > 99 ? '99+' : String(t.badge); bd.title = t.badge + ' unread'; el.appendChild(bd); }
      const x = document.createElement('button'); x.className = 'btn x'; x.title = 'Close tab'; x.setAttribute('aria-label', 'Close tab'); x.innerHTML = ic('x');
      x.addEventListener('click', (e) => { e.stopPropagation(); mf.invoke('tab:close', t.id); });
      el.appendChild(x);
    }
    if (t.loading) { const l = document.createElement('i'); l.className = 'load'; el.appendChild(l); }
    el.addEventListener('mousedown', (e) => { if (e.button === 0) mf.invoke('tab:activate', t.id); if (e.button === 1 && !t.pinned) { e.preventDefault(); mf.invoke('tab:close', t.id); } });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') mf.invoke('tab:activate', t.id); if (e.key === 'Delete' && !t.pinned) mf.invoke('tab:close', t.id); });
    el.addEventListener('dragstart', (e) => { dragId = t.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(t.id)); });
    el.addEventListener('dragover', (e) => { if (dragId && dragId !== t.id && !t.pinned) { e.preventDefault(); el.classList.add('dragover'); } });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('dragover'); if (dragId) mf.invoke('tab:move', dragId, S.tabs.findIndex((x) => x.id === t.id)); dragId = null; });
    el.addEventListener('dragend', () => { dragId = null; });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!t.pinned) mf.invoke('tab:duplicate', t.id); });
    host.appendChild(el);
  }
}

function render() {
  document.body.classList.toggle('home', S.home && S.settings.hideToolbarOnMayfair);
  document.body.classList.toggle('nobar', !S.settings.bookmarksBar);
  renderTabs();
  document.body.classList.toggle('istor', !!S.tor);
  const md = $('mode'); md.hidden = !(S.tor || S.proxy); md.textContent = S.tor ? 'Tor' : 'Proxy'; md.title = S.tor ? 'This tab is routed through the Tor network' : 'Browser tabs use your proxy';
  $('tornew').hidden = !S.tor;
  $('back').disabled = !S.canBack; $('fwd').disabled = !S.canForward;
  $('reload').innerHTML = ic(S.loading ? 'stop' : 'reload');
  $('reload').title = S.loading ? 'Stop' : 'Reload';
  $('reload').setAttribute('aria-label', S.loading ? 'Stop' : 'Reload');
  const site = $('site');
  site.className = 'btn ' + S.secure;
  site.innerHTML = ic(S.secure === 'secure' ? 'lock' : S.secure === 'insecure' ? 'warn' : S.private ? 'mask' : 'globe');
  site.title = S.secure === 'secure' ? 'Secure connection (HTTPS). Site settings' : S.secure === 'insecure' ? 'Not secure (HTTP). Site settings' : 'Site settings';
  if (document.activeElement !== $('addr')) $('addr').value = S.url;
  $('star').innerHTML = ic(S.bookmarked ? 'starOn' : 'star');
  $('star').classList.toggle('on', S.bookmarked);
  $('star').disabled = !S.url;
  const z = $('zoom'); z.hidden = !S.zoom; z.textContent = Math.round(Math.pow(1.2, S.zoom) * 100) + '%';
  $('pw').hidden = !S.pw;
  $('shield').innerHTML = ic('shield') + (S.blocked ? '<span class="n">' + S.blocked + '</span>' : '');
  $('shield').title = S.blocked ? S.blocked + ' trackers and ads blocked on this page' : 'No ads or trackers blocked on this page';
  const bar = $('bar'); bar.textContent = '';
  if (!S.bookmarks.length) { const e = document.createElement('span'); e.className = 'empty'; e.textContent = 'Bookmarks you add appear here.'; bar.appendChild(e); }
  for (const b of S.bookmarks) {
    const el = document.createElement('button'); el.className = 'bm'; el.title = b.url;
    el.innerHTML = ic('star'); const sp = document.createElement('span'); sp.textContent = b.title; el.appendChild(sp);
    el.querySelector('svg').style.width = '14px'; el.querySelector('svg').style.height = '14px';
    el.addEventListener('click', () => mf.invoke('tab:go', b.url));
    bar.appendChild(el);
  }
}

setIcons();
mf.on('state', (s) => { S = s; render(); });
mf.on('focus-address', () => { $('addr').focus(); $('addr').select(); });
$('newtab').onclick = () => mf.invoke('tab:new');
$('back').onclick = () => mf.invoke('tab:back');
$('fwd').onclick = () => mf.invoke('tab:forward');
$('reload').onclick = () => mf.invoke(S && S.loading ? 'tab:stop' : 'tab:reload');
$('star').onclick = () => mf.invoke('bm:toggle');
$('site').onclick = () => mf.invoke('panel:open', 'site');
$('shield').onclick = () => mf.invoke('panel:open', 'site');
$('dl').onclick = () => mf.invoke('panel:open', 'downloads');
$('menu').onclick = () => mf.invoke('panel:open', 'menu');
$('menu0').onclick = () => mf.invoke('panel:open', 'menu');
$('tornew').onclick = () => mf.invoke('tor:newIdentity');
$('pw').onclick = () => mf.invoke('pw:fill');
$('zoom').onclick = () => mf.invoke('zoom:set', 'reset');
$('toolbar').addEventListener('submit', (e) => { e.preventDefault(); mf.invoke('tab:go', $('addr').value); $('addr').blur(); });
$('addr').addEventListener('focus', () => $('addr').select());
$('addr').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('addr').value = S ? S.url : ''; $('addr').blur(); } });
mf.invoke('ui:ready');
