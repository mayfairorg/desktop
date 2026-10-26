'use strict';
// Preload for ordinary websites. No API is exposed to the page. It only reports whether a
// password field exists (so the toolbar can offer Mayfair Passwords) and fills fields when
// the user clicks that button.
const { ipcRenderer, contextBridge } = require('electron');

// The internal Mayfair Search start page (a file inside this app) gets a small bridge. No other page does.
if (location.protocol === 'file:' && /\/ui\/newtab\.html$/.test(location.pathname)) {
  const call = (c, ...a) => ipcRenderer.invoke(c, ...a);
  contextBridge.exposeInMainWorld('mfSearch', {
    config: () => call('search:config'), setEngine: (e) => call('search:setEngine', String(e)),
    suggest: (q) => call('search:suggest', String(q).slice(0, 120)), local: (q) => call('search:local', String(q).slice(0, 120)),
    open: (kind, value) => call('search:open', { kind, value: String(value) }), go: (t) => call('search:go', String(t).slice(0, 2048)),
    command: (t) => call('search:command', String(t).slice(0, 120)), online: (type, q) => call('search:online', { type, q: String(q).slice(0, 80) }),
    panel: (n) => call('search:panel', String(n)), home: () => call('search:home'),
  });
}

let last = null;
let timer = null;
function scan() {
  timer = null;
  let has = false;
  try { has = !!document.querySelector('input[type="password"]'); } catch { /* no DOM yet */ }
  if (has !== last) { last = has; ipcRenderer.invoke('page:pwDetected', has).catch(() => {}); }
}
function schedule() { if (!timer) timer = setTimeout(scan, 400); }
window.addEventListener('DOMContentLoaded', () => {
  scan();
  try { new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true }); } catch { /* ignore */ }
});

function setValue(el, v) {
  const proto = Object.getPrototypeOf(el);
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
  set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
ipcRenderer.on('pw:fill', (_e, cred) => {
  if (!cred || typeof cred.password !== 'string') return;
  const pw = document.querySelector('input[type="password"]');
  if (!pw) return;
  const scope = pw.form || document;
  const user = scope.querySelector('input[type="email"],input[autocomplete="username"],input[type="text"],input[name*="user" i],input[name*="mail" i],input[name*="login" i]');
  if (user && typeof cred.username === 'string') setValue(user, cred.username);
  setValue(pw, cred.password);
});
