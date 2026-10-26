'use strict';
// Preload for the pinned Mayfair tab. Exposes window.mayfairDesktop ONLY on the Mayfair origins.
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
  contextBridge.exposeInMainWorld('mayfairDesktop', {
    isDesktop: true,
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
