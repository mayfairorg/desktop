'use strict';
// Preload for the Mayfair view. Exposes window.mayfairDesktop (and window.mayfairDesktop.browser, the Browser bridge) ONLY on the Mayfair origins.
const { contextBridge, ipcRenderer } = require('electron');

const MAYFAIR = ['https://cloud.mayfairmail.com', 'https://mayfairmail.com'];

if (MAYFAIR.includes(location.origin)) {
  const listeners = { file: [], deeplink: [], download: [], pw: [], search: [] };
  const queued = { file: [], deeplink: [], download: [], pw: [], search: [] };
  const map = { 'file:open': 'file', deeplink: 'deeplink', 'download:done': 'download', 'pw:request': 'pw', 'search:query': 'search' };
  for (const [ch, key] of Object.entries(map)) {
    ipcRenderer.on(ch, (_e, payload) => {
      if (listeners[key].length) listeners[key].forEach((cb) => { try { cb(payload); } catch { /* page error */ } });
      else if (queued[key].length < 20) queued[key].push(payload); // replay to the first listener
    });
  }
  const sub = (key, cb) => {
    if (typeof cb !== 'function') return () => {};
    listeners[key].push(cb);
    if (key === 'pw') ipcRenderer.invoke('web:pwListening', true).catch(() => {});
    if (key === 'search') ipcRenderer.invoke('web:searchListening', true).catch(() => {});
    for (const p of queued[key].splice(0)) { try { cb(p); } catch { /* page error */ } }
    return () => {
      listeners[key] = listeners[key].filter((x) => x !== cb);
      if (key === 'pw' && !listeners.pw.length) ipcRenderer.invoke('web:pwListening', false).catch(() => {});
      if (key === 'search' && !listeners.search.length) ipcRenderer.invoke('web:searchListening', false).catch(() => {});
    };
  };
  // Same contract the Passwords extension uses on the web, so the Cloud code is written once:
  // page gets window.postMessage {mayfair:1,v:1,type:'mf.pw.request',id,payload:{origin,host}}
  // and answers {type:'mf.pw.credentials', id, payload:{id, credentials:[{username,password}]}}.
  // Posting {type:'mf.pw.listening'} tells the app Mayfair Passwords is open.
  ipcRenderer.on('pw:request', (_e, r) => {
    try { window.postMessage({ mayfair: 1, v: 1, type: 'mf.pw.request', id: String(r.id), payload: { origin: String(r.origin), host: new URL(r.origin).hostname } }, location.origin); } catch { /* ignore */ }
  });
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.mayfair !== 1 || d.v !== 1 || typeof d.type !== 'string') return;
    if (d.type === 'mf.pw.listening') ipcRenderer.invoke('web:pwListening', true).catch(() => {});
    else if (d.type === 'mf.pw.credentials' && d.payload && typeof d.payload.id === 'string' && Array.isArray(d.payload.credentials)) {
      ipcRenderer.invoke('web:pwRespond', d.payload.id, d.payload.credentials.slice(0, 20).map((c) => ({ username: String(c && c.username || ''), password: String(c && c.password || '') }))).catch(() => {});
    }
  });

  // ---- Browser bridge: window.mayfairDesktop.browser (contract: audit/browser-bridge-contract.md) ----
  // Every method is one allowlisted invoke 'br:<name>' that main checks again (sender, role, argument types).
  // This list must equal the keys of BR in src/main/lib/ipc-allowlist.js (a test compares them).
  const BR_NAMES = ['ready', 'setBounds', 'setOccluded', 'capture', 'windows.create', 'windows.close', 'windows.focus', 'windows.list', 'moveTab', 'focus', 'newTab', 'closeTab', 'activate', 'move', 'duplicate', 'pin', 'mute', 'closeOthers', 'reopenClosed',
    'go', 'back', 'forward', 'reload', 'stop', 'home', 'suggest', 'find', 'stopFind', 'zoom', 'print', 'savePage', 'devtools', 'fullscreen', 'windowFullscreen', 'fillPassword',
    'network.block', 'bookmarks.list', 'bookmarks.add', 'bookmarks.remove', 'bookmarks.update', 'bookmarks.import', 'history.list', 'history.search', 'history.remove', 'history.clear', 'history.import', 'history.syncState', 'autofill.take', 'autofill.dismiss', 'autofill.fill', 'autofill.answer', 'webapps.match',
    'downloads.list', 'downloads.open', 'downloads.show', 'downloads.cancel', 'downloads.clear',
    'settings.get', 'settings.set', 'settings.setProxy', 'settings.pickFolder', 'settings.clearBrowsingData',
    'passwords.take', 'passwords.dismiss', 'permissions.list', 'permissions.site', 'permissions.set', 'permissions.reset', 'permissions.answer', 'popups.allow',
    'webapps.catalogue', 'webapps.open', 'webapps.pin', 'webapps.reset', 'webapps.remove', 'webapps.shortcut',
    'tor.status', 'tor.start', 'tor.stop', 'tor.newIdentity', 'adblock.stats', 'adblock.toggleSite', 'adblock.updateNow',
    'extensions.list', 'extensions.install', 'extensions.remove', 'about',
    'ghost.connectors.list', 'ghost.connectors.get', 'ghost.connectors.validate', 'ghost.connectors.test', 'ghost.connectors.requestApproval', 'ghost.connectors.enable', 'ghost.connectors.disable', 'ghost.connectors.remove', 'ghost.connectors.installSample',
    'ghost.jobs.run', 'ghost.jobs.cancel', 'ghost.jobs.list', 'ghost.jobs.get', 'ghost.logs.tail', 'ghost.pickFile',
    'ghost.vault.status', 'ghost.vault.unlock', 'ghost.vault.lock', 'ghost.vault.backup.begin', 'ghost.vault.backup.confirm', 'ghost.vault.backup.cancel', 'ghost.vault.backup.disable', 'ghost.vault.backup.newPhrase', 'ghost.vault.changePassphrase', 'ghost.vault.resetPassphrase', 'ghost.vault.requirePassphrase', 'ghost.vault.rotateKeys', 'ghost.vault.syncNow', 'ghost.vault.wipe', 'ghost.vault.exportFile', 'ghost.vault.importFile',
    'ghost.toollib.list', 'ghost.toollib.import', 'ghost.toollib.importStatus', 'ghost.toollib.localOnly', 'ghost.toollib.setLocalOnly',
    'ghost.app.library', 'ghost.app.open', 'ghost.app.remove', 'ghost.app.bounds', 'ghost.app.hide', 'ghost.app.occluded', 'ghost.app.capture', 'ghost.app.state'];
  const BR_EVENTS = ['ghost-job', 'state', 'find-result', 'download', 'permission-request', 'permission-cancel', 'new-window-request', 'open-url', 'fullscreen', 'menu', 'panel-request', 'notice', 'tor', 'focus', 'windows', 'password-offer', 'password-offer-cancel', 'password-field', 'history-add', 'history-remove', 'history-clear', 'autofill-offer', 'autofill-offer-cancel', 'autofill-request', 'details-used', 'ghost-app', 'ghost-toollib'];
  const BR_QUEUED = ['permission-request', 'new-window-request', 'open-url', 'menu', 'panel-request'];   // happened before anyone listened: replayed to the first listener
  const browser = {};
  for (const name of BR_NAMES) {
    const fn = (...a) => ipcRenderer.invoke('br:' + name, ...a);
    const parts = name.split('.');   // 'bookmarks.list' -> browser.bookmarks.list; 'ghost.jobs.run' -> browser.ghost.jobs.run
    let o = browser;
    for (const g of parts.slice(0, -1)) o = (o[g] = o[g] || {});
    o[parts[parts.length - 1]] = fn;
  }
  const brL = {}, brQ = {};
  const brState = new Map();   // gid -> last state (replayed to a new 'state' subscriber)
  ipcRenderer.on('br:ev', (_e, name, payload) => {
    if (!BR_EVENTS.includes(name)) return;
    if (name === 'state' && payload && Number.isInteger(payload.gid)) brState.set(payload.gid, payload);
    if (payload && Array.isArray(payload.groups) && (name === 'state' || name === 'windows')) for (const k of [...brState.keys()]) if (!payload.groups.includes(k)) brState.delete(k);   // a closed window's last state is not replayed
    const ls = brL[name];
    if (ls && ls.length) ls.slice().forEach((cb) => { try { cb(payload); } catch { /* page error */ } });
    else if (BR_QUEUED.includes(name)) { const q = brQ[name] = brQ[name] || []; if (q.length < 20) q.push(payload); }
  });
  browser.on = (event, cb) => {
    if (!BR_EVENTS.includes(event) || typeof cb !== 'function') return () => {};
    const ls = brL[event] = brL[event] || [];
    ls.push(cb);
    if (ls.length === 1) ipcRenderer.invoke('br:subscribe', event, true).catch(() => {});
    if (event === 'state') for (const k of [...brState.keys()].sort((a, b) => a - b)) { try { cb(brState.get(k)); } catch { /* page error */ } }
    for (const p of (brQ[event] || []).splice(0)) { try { cb(p); } catch { /* page error */ } }
    return () => {
      brL[event] = (brL[event] || []).filter((x) => x !== cb);
      if (!brL[event].length) ipcRenderer.invoke('br:subscribe', event, false).catch(() => {});
    };
  };
  contextBridge.exposeInMainWorld('mayfairDesktop', {
    isDesktop: true,
    browser,
    info: () => ipcRenderer.invoke('web:info'),
    // Native notification. Electron has no Web Push (no Google push service), so the web app
    // should call this when its own live connection receives an event.
    notify: (n) => ipcRenderer.invoke('web:notify', { title: String(n && n.title || ''), body: String(n && n.body || ''), url: n && n.url ? String(n.url) : undefined, tag: n && n.tag ? String(n.tag) : undefined }),
    setBadge: (n) => ipcRenderer.invoke('web:badge', Math.max(0, Math.floor(Number(n) || 0))),
    openBrowser: (url) => ipcRenderer.invoke('web:openBrowser', String(url)),
    onFile: (cb) => sub('file', cb),
    readFile: (token) => ipcRenderer.invoke('web:readFile', String(token)),
    onDeepLink: (cb) => sub('deeplink', cb),
    onDownload: (cb) => sub('download', cb),
    // Web apps the user pinned in Mayfair Desktop, so the Cloud desktop can show them.
    // Extensions from the Cloud App Library. Only cloud.mayfairmail.com/ext/*.zip with a matching sha256 installs.
    installExtension: (id, url, sha256) => ipcRenderer.invoke('web:extInstall', String(id), String(url), String(sha256)),
    removeExtension: (id) => ipcRenderer.invoke('web:extRemove', String(id)),
    listExtensions: () => ipcRenderer.invoke('web:extList'),
    apps: {
      list: () => ipcRenderer.invoke('web:appsList'),
      open: (id) => ipcRenderer.invoke('web:appsOpen', String(id)),
    },
    // Mayfair Search asks the Cloud for the user's own files, notes and contacts.
    // onQuery(cb): cb({id, q}) -> call search.respond(id, [{kind:'file'|'note'|'contact'|'event'|'mail', title, subtitle, link:'/files/abc'}])
    search: {
      onQuery: (cb) => sub('search', cb),
      respond: (id, results) => ipcRenderer.invoke('web:searchRespond', String(id), Array.isArray(results) ? results.slice(0, 50).map((r) => ({ kind: String(r && r.kind || ''), title: String(r && r.title || ''), subtitle: String(r && r.subtitle || ''), link: String(r && r.link || '') })) : []),
    },
    passwords: {
      onRequest: (cb) => sub('pw', cb),
      respond: (id, credentials) => ipcRenderer.invoke('web:pwRespond', String(id), Array.isArray(credentials) ? credentials.map((c) => ({ username: String(c && c.username || ''), password: String(c && c.password || '') })) : []),
    },
  });
}
