'use strict';
const root = document.getElementById('root');
const ic = window.mfIcon;
let S = null, kind = null, prompts = [], downloads = [], findCount = '';

const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v; else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
};
const close = () => mf.invoke('panel:close');
const btn = (label, onclick, cls = '') => h('button', { class: 'btn ' + cls, type: 'button', onclick }, label);
const iconBtn = (name, label, onclick) => h('button', { class: 'btn', type: 'button', title: label, 'aria-label': label, onclick, html: ic(name) });
const card = (title, ...body) => h('section', { class: 'card', role: 'dialog', 'aria-label': title },
  h('div', { class: 'hd' }, h('h2', {}, title), iconBtn('x', 'Close', close)), h('div', { class: 'body' }, ...body));
const empty = (t, s) => h('div', { class: 'empty' }, h('b', {}, t), s);
const errBox = (again) => h('div', { class: 'empty' }, h('b', { class: 'err' }, 'Could not load this'), btn('Try again', again, 'line'));
const row = (icon, label, hint, fn) => h('button', { class: 'row', type: 'button', onclick: fn }, h('span', { html: icon ? ic(icon) : '' }), h('span', { class: 'grow t' }, label), hint ? h('kbd', {}, hint) : null);
const sw = (on, fn) => { const b = h('button', { class: 'sw', type: 'button', role: 'switch', 'aria-checked': String(on) }); b.addEventListener('click', () => { const n = b.getAttribute('aria-checked') !== 'true'; b.setAttribute('aria-checked', String(n)); fn(n); }); return b; };
const mod = navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl';
const bytes = (n) => n > 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B';
const when = (t) => { const d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };

const PERM_TEXT = { notifications: 'show notifications', geolocation: 'know your location', 'clipboard-read': 'read your clipboard', midi: 'use MIDI devices', fullscreen: 'go full screen', pointerLock: 'hide your pointer', 'idle-detection': 'know when you are idle', 'display-capture': 'share your screen' };
const permText = (p) => PERM_TEXT[p] || 'use your ' + p;

async function panelMenu() {
  const z = Math.round(Math.pow(1.2, S ? S.zoom : 0) * 100);
  return card('Menu',
    row('plus', 'New tab', mod + '+T', () => mf.invoke('tab:new')),
    row('mask', 'New private tab', mod + '+Shift+N', () => mf.invoke('tab:new', { private: true })),
    h('div', { class: 'sep' }),
    row('apps', 'Web apps', mod + '+Shift+A', () => mf.invoke('panel:open', 'apps')),
    row('mask', 'Private tab with Tor', mod + '+Alt+T', () => { mf.invoke('tor:newTab'); close(); }),
    row('shield', 'Privacy', mod + '+Shift+P', () => mf.invoke('panel:open', 'privacy')),
    row('globe', 'About and licences', null, () => mf.invoke('panel:open', 'about')),
    row('star', 'Bookmarks', mod + '+Shift+O', () => mf.invoke('panel:open', 'bookmarks')),
    row('clock', 'History', mod + '+Y', () => mf.invoke('panel:open', 'history')),
    row('download', 'Downloads', mod + '+J', () => mf.invoke('panel:open', 'downloads')),
    row('search', 'Find in page', mod + '+F', () => mf.invoke('panel:open', 'find')),
    h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Zoom ' + z + '%'), h('button', { class: 'btn line', type: 'button', onclick: () => mf.invoke('zoom:set', 'out'), 'aria-label': 'Zoom out' }, '-'), h('button', { class: 'btn line', type: 'button', onclick: () => mf.invoke('zoom:set', 'reset') }, 'Reset'), h('button', { class: 'btn line', type: 'button', onclick: () => mf.invoke('zoom:set', 'in'), 'aria-label': 'Zoom in' }, '+')),
    h('div', { class: 'sep' }),
    row('full', S && S.fullscreen ? 'Leave full screen' : 'Full screen', 'F11', () => { mf.invoke('app:toggleFullscreen'); close(); }),
    row('settings', 'Settings', mod + '+,', () => mf.invoke('panel:open', 'settings')),
    row('x', 'Quit Mayfair Desktop', null, () => mf.invoke('app:quit')));
}

const CAT_ICON = { Chat: 'cChat', Mail: 'cMail', Work: 'cWork', Files: 'cFiles', Tools: 'cTools', Design: 'cDesign', AI: 'cAI', Social: 'cSocial', Media: 'cMedia' };
let appsFilter = { q: '', cat: 'All' };
async function panelApps() {
  const grid = h('div', { class: 'grid' });
  const cats = h('div', { class: 'cats', role: 'tablist', 'aria-label': 'Categories' });
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Search web apps', 'aria-label': 'Search web apps', value: appsFilter.q });
  let list = [];
  const sure = new Set();
  const act = (label, fn, cls = '') => h('button', { class: 'btn line ' + cls, type: 'button', onclick: fn }, label);
  const draw = () => {
    const names = ['All', ...new Set(list.map((a) => a.category)), 'My apps'];
    cats.textContent = '';
    for (const c of names) cats.append(h('button', { class: 'btn' + (appsFilter.cat === c ? ' on' : ''), type: 'button', role: 'tab', 'aria-selected': String(appsFilter.cat === c), onclick: () => { appsFilter.cat = c; draw(); } }, c));
    const needle = q.value.trim().toLowerCase();
    const shown = list.filter((a) => (appsFilter.cat === 'All' || (appsFilter.cat === 'My apps' ? a.installed : a.category === appsFilter.cat)) && (!needle || (a.name + ' ' + a.description).toLowerCase().includes(needle)));
    grid.textContent = '';
    if (!shown.length) { grid.append(empty(appsFilter.cat === 'My apps' ? 'No apps added yet' : 'Nothing matches', appsFilter.cat === 'My apps' ? 'Add one from the list. Each app keeps its own sign-in.' : 'Try a different word.')); return; }
    for (const a of shown) {
      const refresh = async () => { list = await mf.invoke('apps:list'); draw(); };
      const confirm = (key, label, fn) => act(sure.has(key) ? 'Sure?' : label, async () => { if (!sure.has(key)) { sure.add(key); draw(); setTimeout(() => { sure.delete(key); draw(); }, 3000); return; } sure.delete(key); await fn(); await refresh(); }, 'danger');
      grid.append(h('div', { class: 'app' },
        h('div', { class: 'top' }, h('span', { html: ic(CAT_ICON[a.category] || 'apps') }), h('span', { class: 'n' }, a.name), a.badge ? h('span', { class: 'bd', title: a.badge + ' unread' }, a.badge > 99 ? '99+' : String(a.badge)) : null),
        h('div', { class: 'd' }, a.description),
        a.drm ? h('div', { class: 'tag' }, 'Video playback may not work here') : null,
        h('div', { class: 'acts' }, a.installed
          ? [act(a.open ? 'Switch to' : 'Open', () => { mf.invoke('apps:open', a.id); }), act('Own window', () => { mf.invoke('apps:openWindow', a.id); }), act(a.pinned ? 'Unpin' : 'Pin', async () => { await mf.invoke('apps:pin', a.id, !a.pinned); refresh(); }), act('Shortcut', async () => { const r = await mf.invoke('apps:shortcut', a.id); if (!r.ok) alert(r.reason || 'Could not create a shortcut'); }), confirm('r' + a.id, 'Sign out', () => mf.invoke('apps:reset', a.id)), confirm('x' + a.id, 'Remove', () => mf.invoke('apps:remove', a.id))]
          : act('Add and open', () => { mf.invoke('apps:add', a.id); }, 'primary'))));
    }
  };
  const load = async () => { grid.textContent = ''; try { list = await mf.invoke('apps:list'); draw(); } catch { grid.append(errBox(load)); } };
  q.addEventListener('input', draw);
  load();
  return card('Web apps', h('div', { class: 'apps-tools' }, q), cats, grid);
}

async function panelPrivacy() {
  let p; try { p = await mf.invoke('privacy:get'); } catch { return card('Privacy', errBox(() => render())); }
  const note = (t) => h('div', { class: 'row s', style: false }, h('div', { class: 's grow' }, t));
  const set = (k) => async (v) => { const r = await mf.invoke('privacy:set', { [k]: v }); if (r.restart) { msg.textContent = 'Restart Mayfair Desktop to finish turning this on.'; } };
  const tog = (label, sub, k) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, label), sub ? h('div', { class: 's' }, sub) : null), sw(p[k], set(k)));
  const sel = (label, k, opts) => { const el = h('select', { class: 'field', 'aria-label': label }); for (const [v, t] of opts) el.append(h('option', { value: v, selected: p[k] === v }, t)); el.addEventListener('change', () => set(k)(el.value)); return h('div', { class: 'row' }, h('span', { class: 'grow' }, label), el); };
  const msg = h('div', { class: 'row s', role: 'status' });
  const ts = p.torState || {};
  const torLine = !p.torAvailable ? 'Tor is not included in this build. See the README to add it.' : ts.status === 'starting' ? 'Connecting to Tor... ' + ts.progress + '%' : ts.status === 'ready' ? 'Connected to Tor.' : ts.status === 'error' ? ts.error : 'Not running.';
  const host = h('input', { class: 'field', type: 'text', placeholder: 'host or IP', value: p.proxyHost, 'aria-label': 'Proxy host' });
  const port = h('input', { class: 'field', type: 'number', min: '1', max: '65535', placeholder: 'port', value: p.proxyPort || '', 'aria-label': 'Proxy port' }); port.style.cssText = 'width:90px';
  const mode = h('select', { class: 'field', 'aria-label': 'Proxy type' }); for (const [v, t] of [['off', 'No proxy'], ['http', 'HTTP'], ['socks5', 'SOCKS5']]) mode.append(h('option', { value: v, selected: p.proxyMode === v }, t));
  const perr = h('div', { class: 'row s err', role: 'alert' });
  return card('Privacy', h('div', {},
    h('div', { class: 'sec' }, 'Private tab with Tor'),
    note(p.notes.tor),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, 'Tor network'), h('div', { class: 's' }, torLine)),
      btn('New Tor tab', async () => { await mf.invoke('tor:newTab'); close(); }, 'primary')),
    ts.status === 'ready' ? h('div', { class: 'row' }, h('span', { class: 'grow s' }, 'A new identity changes your Tor circuit and clears the Tor session.'), btn('New identity', () => mf.invoke('tor:newIdentity'), 'line'), btn('Stop Tor', () => mf.invoke('tor:stop').then(render), 'line')) : null,
    h('div', { class: 'sec' }, 'Secure DNS'),
    tog('Use secure DNS', 'Encrypted name lookups, plus Encrypted Client Hello where the site supports it.', 'secureDns'),
    sel('Provider', 'dnsProvider', Object.entries(p.dnsProviders)),
    tog('Encrypted Client Hello', 'Needs secure DNS. Takes effect after a restart.', 'ech'),
    note(p.notes.dns),
    h('div', { class: 'sec' }, 'Leak protection'),
    sel('WebRTC address leaks', 'webrtc', [['strict', 'Block (recommended)'], ['public', 'Public address only'], ['off', 'Allow']]),
    note('Applies to browser and private tabs. Mayfair and Web apps keep calls working. Tor tabs always block.'),
    tog('Standard time zone and language', 'Browser and private tabs report UTC and English (US). Tor tabs always do. Applies to new tabs.', 'standardLocale'),
    tog('Reduce fingerprinting', 'Narrows some details sites can read. Applies to new tabs.', 'reduceFingerprint'),
    note(p.notes.fp),
    h('div', { class: 'sec' }, 'Your own proxy'),
    h('div', { class: 'row' }, mode, host, port),
    h('div', { class: 'row' }, h('span', { class: 'grow s' }, 'Used by browser tabs, private tabs and Web apps. Mayfair itself connects directly. Tor never goes through it.'), btn('Apply', async () => { perr.textContent = ''; const r = await mf.invoke('privacy:setProxy', mode.value, mode.value === 'off' ? '' : host.value.trim(), mode.value === 'off' ? 0 : parseInt(port.value, 10) || 0); if (!r.ok) perr.textContent = r.error; else msg.textContent = mode.value === 'off' ? 'Proxy off.' : 'Proxy applied.'; }, 'line')),
    perr, msg,
    h('div', { class: 'sec' }, 'Please read'),
    note(p.notes.rules)));
}

async function panelAbout() {
  let a; try { a = await mf.invoke('about:get'); } catch { return card('About', errBox(() => render())); }
  const ad = a.adblock;
  const status = ad.engine === 'ghostery' ? 'Full blocker active: ' + ad.rules.toLocaleString() + ' rules' + (ad.scriptlets ? ', scriptlets on' : ', scriptlets not loaded') + '.' : 'Basic blocker active (' + ad.legacyDomains + ' tracker domains). ' + (ad.error || '');
  const upd = h('div', { class: 'row s', role: 'status' });
  const comp = [['Mayfair Desktop ' + a.version, 'Copyright (c) 2022-2026 The Mayfair Organization. All rights reserved. Copying, reverse engineering and redistribution are not allowed (LICENSE.txt).'], ['Electron and Chromium', 'MIT and BSD-style licences (electronjs.org, chromium.org)'], ['@ghostery/adblocker', 'MPL-2.0, Ghostery GmbH (github.com/ghostery/adblocker)'], ['electron-updater', 'MIT, electron-userland (github.com/electron-userland/electron-builder)'], ['EasyList, EasyPrivacy, uBlock filters', 'Filter lists (data): CC BY-SA 3.0 or GPL v3, and GPL v3. See the list credits above.'], ['tor (optional, Tor tab)', 'BSD 3-clause, The Tor Project. Not Tor Browser, not endorsed by The Tor Project.'], ['Open-Meteo, Wikipedia, Free Dictionary API', 'Used only when you type weather, wiki or define. Their own terms apply.']];
  return card('About and licences', h('div', {},
    h('div', { class: 'sec' }, 'Ad blocker'),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, ad.enabled ? 'On' : 'Off'), h('div', { class: 's' }, status), ad.lastUpdate ? h('div', { class: 's' }, 'Lists updated ' + new Date(ad.lastUpdate).toLocaleString()) : h('div', { class: 's' }, 'Lists have not been updated yet.')), btn('Update lists', async () => { upd.textContent = 'Updating...'; try { const r = await mf.invoke('adblock:updateNow'); upd.textContent = r.done + ' updated' + (r.failed.length ? '. Could not fetch: ' + r.failed.join('; ') : '.'); } catch (e) { upd.textContent = 'Update failed.'; } }, 'line')),
    upd,
    h('div', { class: 'row s' }, h('div', { class: 's grow' }, 'No telemetry. Lists are plain downloads from their public addresses. Blocking ads and video ads is a moving target: sites change and some detect blockers, so some ads will get through.')),
    h('div', { class: 'sec' }, 'Filter lists'),
    a.lists.map((l) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, l.name), h('div', { class: 's' }, 'By ' + l.credit + '. Licence: ' + l.license + '. ' + l.homepage), h('div', { class: 's' }, l.loaded ? (l.source === 'updated' ? 'Updated copy in use' : 'Copy from the installer in use') + (l.version ? ', version ' + l.version : '') : 'Not loaded')))),
    a.allow.length ? h('div', { class: 'sec' }, 'Blocking turned off for') : null,
    a.allow.length ? h('div', { class: 'row s' }, a.allow.join(', ')) : null,
    h('div', { class: 'sec' }, 'Software'),
    comp.map(([n, t]) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, n), h('div', { class: 's' }, t)))),
    h('div', { class: 'row s' }, h('div', { class: 's grow' }, 'Full licence texts: see the licenses folder next to the app (LICENSE.txt, THIRD_PARTY_NOTICES.txt). Tor notice: licenses/TOR-NOTICE.txt.'))));
}

async function panelDownloads() {
  const body = h('div');
  const draw = () => {
    body.textContent = '';
    if (!downloads.length) { body.append(empty('Nothing downloaded yet', 'Files save to your Mayfair Drive folder unless you pick another one in Settings.')); return; }
    for (const d of downloads) {
      const pct = d.total ? Math.min(100, Math.round(100 * d.received / d.total)) : 0;
      const status = d.state === 'completed' ? bytes(d.received) + (d.cloud ? ' - sent to Mayfair Drive' : '') : d.state === 'progressing' ? (d.total ? pct + '% of ' + bytes(d.total) : bytes(d.received)) : d.state === 'cancelled' ? 'Cancelled' : d.state === 'paused' ? 'Paused' : 'Failed';
      body.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 't' }, d.name), h('div', { class: 's' }, status), d.state === 'progressing' ? h('div', { class: 'bar' }, h('i', { style: false })) : null),
        d.state === 'completed' ? [btn('Open', () => mf.invoke('dl:open', d.id), 'line'), btn('Show', () => mf.invoke('dl:show', d.id))] : d.state === 'progressing' ? btn('Cancel', () => mf.invoke('dl:cancel', d.id)) : null));
      const i = body.querySelector('.row:last-child .bar i'); if (i) i.style.width = pct + '%';
    }
  };
  draw(); body._redraw = draw;
  return Object.assign(card('Downloads', body), { _dl: body });
}

async function panelBookmarks() {
  const body = h('div');
  const load = async () => {
    body.textContent = '';
    let list; try { list = await mf.invoke('bm:list'); } catch { body.append(errBox(load)); return; }
    if (!list.length) { body.append(empty('No bookmarks yet', 'Press ' + mod + '+D on any page to add it.')); return; }
    for (const b of list) body.append(h('div', { class: 'row' },
      h('button', { class: 'grow t', style: false, type: 'button', title: b.url, onclick: () => { mf.invoke('tab:go', b.url); close(); } }, b.title),
      iconBtn('trash', 'Remove bookmark', async () => { await mf.invoke('bm:remove', b.id); load(); })));
    body.querySelectorAll('button.grow').forEach((x) => { x.style.cssText = 'background:none;border:0;text-align:left;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0;min-height:32px'; });
  };
  load(); return card('Bookmarks', body);
}

async function panelHistory() {
  const list = h('div'); const q = h('input', { class: 'field', type: 'search', placeholder: 'Search history', 'aria-label': 'Search history' });
  const load = async () => {
    list.textContent = '';
    let items; try { items = await mf.invoke('hist:list', q.value); } catch { list.append(errBox(load)); return; }
    if (!items.length) { list.append(empty(q.value ? 'Nothing matches' : 'No history yet', q.value ? 'Try a different word.' : 'Pages you visit show up here. Private tabs never do.')); return; }
    for (const it of items) list.append(h('button', { class: 'row', type: 'button', onclick: () => { mf.invoke('tab:go', it.url); close(); } }, h('div', { class: 'grow' }, h('div', { class: 't' }, it.title), h('div', { class: 's' }, it.url)), h('span', { class: 's' }, when(it.t))));
  };
  q.addEventListener('input', load); load();
  const clear = btn('Clear all', async () => { await mf.invoke('hist:clear'); load(); }, 'line');
  const c = card('History', h('div', { style: false }, q), list);
  c.querySelector('.hd').insertBefore(clear, c.querySelector('.hd .btn:last-child'));
  setTimeout(() => q.focus(), 30);
  return c;
}

async function panelSite() {
  let d; try { d = await mf.invoke('perm:site'); } catch { return card('Site settings', errBox(() => render())); }
  const body = h('div');
  const secure = d.secure === 'secure' ? 'Connection is secure (HTTPS).' : d.secure === 'insecure' ? 'Connection is not secure (HTTP). Do not enter passwords here.' : 'This is a Mayfair page.';
  body.append(h('div', { class: 'row', style: false }, h('span', { html: ic(d.secure === 'insecure' ? 'warn' : 'lock') }), h('div', { class: 'grow' }, h('div', { class: 't' }, d.origin || 'Mayfair Desktop'), h('div', { class: 's' }, secure))));
  if (!d.internal) {
    body.append(h('div', { class: 'sec' }, 'Ads and trackers'));
    body.append(h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, 'Block on this site'), h('div', { class: 's' }, d.blocked + ' blocked on this page')), sw(!d.siteAllowed && d.adblock, () => mf.invoke('adblock:toggleSite').then(() => setTimeout(render, 400)))));
    body.append(h('div', { class: 'sec' }, 'Permissions'));
    const labels = { media: 'Camera and microphone', geolocation: 'Location', notifications: 'Notifications', 'clipboard-read': 'Clipboard', popups: 'Pop-ups' };
    for (const [k, label] of Object.entries(labels)) {
      const sel = h('select', { class: 'field', 'aria-label': label });
      for (const [v, t] of [['ask', 'Ask'], ['allow', 'Allow'], ['deny', 'Block']]) sel.append(h('option', { value: v, selected: (d.perms[k] || 'ask') === v }, t));
      sel.addEventListener('change', () => mf.invoke('perm:setSite', d.origin, k, sel.value));
      body.append(h('div', { class: 'row' }, h('span', { class: 'grow' }, label), sel));
    }
    body.append(h('div', { class: 'sep' }), row('trash', 'Reset all for this site', null, async () => { await mf.invoke('perm:reset', d.origin); render(); }));
  }
  return card('Site settings', body);
}

async function panelSettings() {
  let s; try { s = await mf.invoke('settings:get'); } catch { return card('Settings', errBox(() => render())); }
  const set = (k) => (v) => mf.invoke('settings:set', { [k]: v });
  const tog = (label, sub, k) => h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, label), sub ? h('div', { class: 's' }, sub) : null), sw(s[k], set(k)));
  const sel = (label, k, opts) => { const el = h('select', { class: 'field', 'aria-label': label }); for (const [v, t] of opts) el.append(h('option', { value: v, selected: s[k] === v }, t)); el.addEventListener('change', () => set(k)(el.value)); return h('div', { class: 'row' }, h('span', { class: 'grow' }, label), el); };
  const folder = h('div', { class: 's' }, s.downloadFolder || 'Default downloads folder');
  return card('Settings', h('div', {},
    h('div', { class: 'sec' }, 'Window'),
    tog('Open full screen', 'Kiosk style. Off opens in a normal window.', 'startFullscreen'),
    tog('Start when I sign in', null, 'launchAtLogin'),
    tog('Tray icon', 'Keeps Mayfair running for notifications.', 'tray'),
    tog('Close button hides to tray', null, 'closeToTray'),
    tog('Hide the toolbar on Mayfair', 'Show it only on browser tabs.', 'hideToolbarOnMayfair'),
    h('div', { class: 'sec' }, 'Browser'),
    sel('Mayfair Search results from', 'searchEngine', [['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave Search'], ['google', 'Google'], ['bing', 'Bing'], ['startpage', 'Startpage'], ['ecosia', 'Ecosia'], ['qwant', 'Qwant']]),
    tog('Online answers', 'Weather, definitions and Wikipedia, only when you type weather, define or wiki first.', 'onlineAnswers'),
    tog('Block ads and trackers', s.blocklistSize + ' domains in the bundled list', 'adblock'),
    tog('Show bookmarks bar', null, 'bookmarksBar'),
    tog('Notifications from Mayfair', null, 'notifications'),
    h('div', { class: 'sec' }, 'Downloads'),
    sel('Save downloads to', 'downloadMode', [['drive', 'My Mayfair Drive folder'], ['folder', 'A folder I choose'], ['ask', 'Ask every time']]),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', {}, 'Chosen folder'), folder), btn('Choose', async () => { const p = await mf.invoke('settings:pickFolder'); if (p) { folder.textContent = p; render(); } }, 'line')),
    h('div', { class: 'sec' }, 'Privacy'),
    row('trash', 'Clear browsing data', 'History, cookies, cache', async () => { await mf.invoke('privacy:clearBrowsing'); close(); }),
    h('div', { class: 'row' }, h('div', { class: 's grow' }, 'Mayfair Desktop ' + s.version + ' on ' + s.platform + '. No telemetry is sent.'))));
}

function findBar() {
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Find in page', 'aria-label': 'Find in page' });
  const cnt = h('span', { class: 'cnt', id: 'cnt' }, findCount);
  const run = (fwd, next) => mf.invoke('find:run', q.value, fwd, next);
  q.addEventListener('input', () => run(true, false));
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(!e.shiftKey, true); } });
  setTimeout(() => { q.focus(); q.select(); }, 30);
  return h('div', { class: 'card find' }, q, cnt, iconBtn('up', 'Previous match', () => run(false, true)), iconBtn('down', 'Next match', () => run(true, true)), iconBtn('x', 'Close find', () => mf.invoke('find:stop')));
}

function promptCard(p) {
  if (p.type === 'permission') {
    const rem = h('input', { type: 'checkbox', id: 'rem' });
    return h('section', { class: 'card prompt', role: 'alertdialog', 'aria-label': 'Permission request' },
      h('div', { class: 'q' }, h('b', {}, p.origin), ' wants to ' + permText(p.permission)),
      h('div', { class: 'acts' }, p.canRemember ? h('label', { for: 'rem' }, rem, 'Remember my choice') : h('span', { class: 'grow' }),
        btn('Block', () => mf.invoke('perm:answer', p.id, 'deny', rem.checked), 'line'), btn('Allow', () => mf.invoke('perm:answer', p.id, 'allow', rem.checked), 'primary')));
  }
  if (p.type === 'popup') return h('section', { class: 'card prompt', role: 'alertdialog' }, h('div', { class: 'q' }, 'Pop-up blocked on ', h('b', {}, p.origin)), h('div', { class: 'acts' }, btn('Dismiss', () => mf.invoke('panel:close'), 'line'), btn('Open it', () => mf.invoke('popup:allowOnce'), 'primary')));
  return h('section', { class: 'card notice', role: 'status' }, h('span', { class: 'grow' }, p.text));
}

let seq = 0;
async function render() {
  const my = ++seq;
  document.body.className = 'kind-' + (kind === 'find' ? 'find' : kind ? 'panel' : prompts.length ? 'prompt' : '') + (kind === 'apps' ? ' wide' : '');
  if (prompts.length && (!kind || kind === 'find')) {
    document.body.className = 'kind-prompt'; root.textContent = '';
    for (const p of prompts) root.append(promptCard(p));
    return;
  }
  if (kind === 'find') { root.textContent = ''; root.append(findBar()); return; }
  if (!kind) { root.textContent = ''; return; }
  root.textContent = '';
  const f = { menu: panelMenu, downloads: panelDownloads, apps: panelApps, privacy: panelPrivacy, about: panelAbout, bookmarks: panelBookmarks, history: panelHistory, site: panelSite, settings: panelSettings }[kind];
  const el = await f();
  if (my !== seq) return;
  root.textContent = ''; root.append(el);
  if (kind === 'downloads') root._dl = el._dl;
  const first = el.querySelector('input,button,select'); if (first && kind !== 'history') first.focus();
}

mf.on('panel', (m) => { kind = m.kind || null; render(); });
mf.on('state', (s) => { const was = S; S = s; if (kind === 'menu' && was && was.zoom !== s.zoom) render(); if (kind === 'privacy' && was && JSON.stringify(was.torState) !== JSON.stringify(s.torState)) render(); });
mf.on('prompts', (p) => { prompts = p; if (!kind || kind === 'find') render(); });
mf.on('downloads', (d) => { downloads = d; if (kind === 'downloads' && root._dl && root._dl._redraw) root._dl._redraw(); });
mf.on('find:result', (r) => { findCount = r.of ? r.n + ' / ' + r.of : (document.querySelector('.find input') && document.querySelector('.find input').value ? '0' : ''); const c = document.getElementById('cnt'); if (c) c.textContent = findCount; });
document.getElementById('backdrop').addEventListener('mousedown', () => mf.invoke('panel:close'));
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); kind === 'find' ? mf.invoke('find:stop') : mf.invoke('panel:close'); } });
mf.invoke('ui:ready');
