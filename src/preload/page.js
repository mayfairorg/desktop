'use strict';
// Preload for ordinary websites. No API is exposed to the page. It reports whether a password field exists (so the
// toolbar can offer Mayfair Passwords), tells main when a login or sign-up form was submitted (so Mayfair can offer
// to save it: main keeps it in memory only), and fills fields when the user asks.
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

// ---- login submitted: hand the credentials to main (memory only there), which asks Mayfair Passwords whether to save ----
const textLike = (i) => !i.type || ['text', 'email', 'tel', 'search', 'url'].includes(i.type.toLowerCase());
function snapshot() {
  try {
    const all = [...document.querySelectorAll('input[type="password"]')];
    const pws = all.filter((i) => i.value);
    if (!pws.length) return null;
    const ac = (i) => String(i.autocomplete || '');
    const newF = pws.find((i) => /new-password/.test(ac(i))), curF = pws.find((i) => /current-password/.test(ac(i)));
    let kind = 'new', el;
    if (newF && curF) { kind = 'change'; el = newF; }
    else if (all.length >= 3 && pws.length >= 3) { kind = 'change'; el = pws[1]; }
    else el = newF || pws[0];
    const scope = el.form || document;
    const cands = [...scope.querySelectorAll('input')].filter((i) => textLike(i) && i.value && !(i.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING));
    const hinted = cands.filter((i) => /user|mail|login|account|phone|name/i.test(ac(i) + ' ' + i.name + ' ' + i.id));
    const u = (hinted.length ? hinted : cands).slice(-1)[0];
    return { username: u ? String(u.value).slice(0, 300) : '', password: String(el.value).slice(0, 1000), kind };
  } catch { return null; }
}
let polling = false;
function settle(snap) {      // a script login: the password field goes away or is cleared once the site accepted the login
  if (polling) return; polling = true;
  const t0 = Date.now();
  const iv = setInterval(() => {
    const left = [...document.querySelectorAll('input[type="password"]')].some((i) => i.value && i.offsetParent !== null);
    if (!left) { clearInterval(iv); polling = false; ipcRenderer.invoke('page:pwSubmit', { ...snap, settled: true }).catch(() => {}); }
    else if (Date.now() - t0 > 10000) { clearInterval(iv); polling = false; }
  }, 300);
}
window.addEventListener('submit', (e) => {
  if (!e.isTrusted) return;
  const snap = snapshot(); if (!snap) return;
  ipcRenderer.invoke('page:pwSubmit', { ...snap, settled: false }).catch(() => {});
  settle(snap);
}, true);
window.addEventListener('click', (e) => {
  if (!e.isTrusted || !e.target || !e.target.closest) return;
  const b = e.target.closest('button,input[type="submit"],input[type="button"],[role="button"]');
  if (!b || (b.form && b.type === 'submit')) return;      // a real submit button already raises 'submit'
  const snap = snapshot(); if (snap) settle(snap);
}, true);
window.addEventListener('keydown', (e) => {
  if (!e.isTrusted || e.key !== 'Enter' || !e.target || e.target.type !== 'password' || e.target.form) return;
  const snap = snapshot(); if (snap) settle(snap);
}, true);
// a login field got focus: Mayfair may offer saved logins (it answers with fillPassword)
let focusSent = false;
window.addEventListener('focusin', (e) => {
  const i = e.target;
  if (focusSent || !i || i.tagName !== 'INPUT' || !(i.type === 'password' || (textLike(i) && document.querySelector('input[type="password"]')))) return;
  focusSent = true; ipcRenderer.invoke('page:pwFocus').catch(() => {});
}, true);

// ---- identity details of a submitted form (email, name, phone, address): offered to the Mayfair ID. Never passwords (own flow above),
// card numbers, security codes, ID or passport numbers, one-time codes, search boxes or free text areas. ----
const AC = { email: 'email', username: 'username', name: 'name', 'given-name': 'givenName', 'family-name': 'familyName', tel: 'tel', 'tel-national': 'tel', 'street-address': 'address', 'address-line1': 'address', 'address-line2': 'address2', 'postal-code': 'postalCode', 'address-level2': 'city', 'address-level1': 'region', country: 'country', 'country-name': 'country', organization: 'organization', bday: 'birthday' };
const NEVER = /\b(cc|card|cvc|cvv|csc|ccv|iban|ssn|social|passport|licen[cs]e|national[-_ ]?id|tax|otp|one[-_ ]?time|code|pin|captcha|search|query|comment|message|subject|coupon|promo)\b|^q$|credit|security/i;
function classify(i) {
  if (!i || i.tagName !== 'INPUT') return null;
  const type = String(i.type || 'text').toLowerCase();
  if (!['text', 'email', 'tel', 'url', ''].includes(type) && !(type === 'date' && /bday/.test(i.autocomplete || ''))) return null;
  const ac = String(i.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (ac.some((t) => /^(cc-|one-time-code|off$|new-password|current-password)/.test(t))) return null;
  const hint = [i.name, i.id, i.placeholder, i.getAttribute('aria-label')].filter(Boolean).join(' ');
  if (NEVER.test(hint)) return null;
  for (const t of ac) if (AC[t]) return AC[t];
  if (type === 'email') return 'email';
  if (type === 'tel') return 'tel';
  if (/^(e-?mail|email[-_ ]?address)$/i.test(i.name || '') || /e-?mail/i.test(hint)) return 'email';
  if (/^(user(name)?|login|user[-_ ]?name|handle)$/i.test(i.name || i.id || '')) return 'username';
  return null;
}
function afCollect(scope) {
  const out = {};
  try {
    for (const i of scope.querySelectorAll('input')) {
      const k = classify(i); const v = String(i.value || '').trim().slice(0, 300);
      if (!k || !v || out[k]) continue;
      if (k === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) continue;
      out[k] = v;
    }
  } catch { /* no DOM */ }
  return out;
}
window.addEventListener('submit', (e) => {
  if (!e.isTrusted) return;
  const f = afCollect(e.target && e.target.querySelectorAll ? e.target : document);
  if (Object.keys(f).length) ipcRenderer.invoke('page:afSubmit', f).catch(() => {});
}, true);
// a recognised field got focus: main may ask Mayfair for a value to type
const afSent = new Set();
window.addEventListener('focusin', (e) => {
  const k = classify(e.target);
  if (!k || !['email', 'username', 'name', 'tel', 'address'].includes(k) || afSent.has(k) || (e.target.value || '').length) return;
  afSent.add(k); ipcRenderer.invoke('page:afFocus', k).catch(() => {});
}, true);
ipcRenderer.on('af:fill', (_e, profile) => {
  if (!profile || typeof profile !== 'object') return;
  const scope = (document.activeElement && document.activeElement.form) || document;
  for (const i of scope.querySelectorAll('input')) {
    const k = classify(i);
    if (k && typeof profile[k] === 'string' && !i.value && i.offsetParent !== null) setValue(i, profile[k]);
  }
});
