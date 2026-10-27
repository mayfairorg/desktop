'use strict';
const $ = (id) => document.getElementById(id);
const A = window.MFAnswers;
const ic = window.mfIcon;
let cfg = { engine: 'google', engineName: 'Google', engines: {}, online: true, rates: null };
let rows = [];      // [{el, run}]
let sel = -1;
let seq = 0;
let timers = { local: 0, online: 0 };
const q = $('q');

const QUICK = [
  ['apps', 'Web apps', () => mfSearch.panel('apps')],
  ['star', 'Bookmarks', () => mfSearch.panel('bookmarks')],
  ['clock', 'History', () => mfSearch.panel('history')],
  ['shield', 'Privacy', () => mfSearch.panel('privacy')],
];
function setup() {
  $('lead').innerHTML = ic('search');
  $('clear').innerHTML = ic('x');
  for (const [icon, label, fn] of QUICK) {
    const b = document.createElement('button'); b.type = 'button'; b.innerHTML = ic(icon); b.append(label); b.addEventListener('click', fn); $('quick').append(b);
  }
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

function opt(icon, title, sub, kind, run) {
  const o = el('div', 'opt'); o.setAttribute('role', 'option'); o.setAttribute('aria-selected', 'false'); o.id = 'o' + rows.length;
  const i = el('span', 'ic'); i.innerHTML = ic(icon);
  const tx = el('div', 'tx'); tx.append(el('div', 't', title)); if (sub) tx.append(el('div', 's', sub));
  o.append(i, tx); if (kind) o.append(el('span', 'k', kind));
  o.addEventListener('mousedown', (e) => e.preventDefault());
  o.addEventListener('click', run);
  return o;
}
const KIND = { file: ['cFiles', 'File'], note: ['note', 'Note'], contact: ['cSocial', 'Contact'], event: ['clock', 'Event'], mail: ['cMail', 'Mail'], bookmark: ['star', 'Bookmark'], history: ['clock', 'History'] };

let state = { answer: null, online: null, onlineMsg: '', cmd: null, local: [], text: '' };
function render() {
  const pop = $('pop'); pop.textContent = ''; rows = []; sel = -1;
  const t = state.text;
  if (!t) { pop.hidden = true; q.setAttribute('aria-expanded', 'false'); return; }
  const card = state.online || state.answer;
  if (card) {
    const c = el('div', 'answer'); c.setAttribute('role', 'status');
    c.append(el('div', 'big', card.title)); if (card.sub) c.append(el('div', 'sub', card.sub)); if (card.note) c.append(el('div', 'note', card.note));
    pop.append(c);
  } else if (state.onlineMsg) { const c = el('div', 'answer'); c.append(el('div', 'note', state.onlineMsg)); pop.append(c); }
  const add = (node, run) => { node._run = run; pop.append(node); rows.push(node); };
  for (const r of state.local) {
    const [icon, label] = KIND[r.kind] || ['globe', ''];
    add(opt(icon, r.title, r.sub || '', label, null), () => (r.link ? mfSearch.open('link', r.link) : mfSearch.open('url', r.url)));
  }
  add(opt('search', 'Search the web for "' + (t.length > 60 ? t.slice(0, 60) + '...' : t) + '"', '', cfg.engineName, null), () => mfSearch.go(t));
  rows.forEach((r, i) => { r.id = 'o' + i; r.addEventListener('click', () => r._run()); });
  pop.hidden = false; q.setAttribute('aria-expanded', 'true');
}

function pick(i) {
  rows.forEach((r, n) => r.setAttribute('aria-selected', String(n === i)));
  sel = i; if (i >= 0) { rows[i].scrollIntoView({ block: 'nearest' }); q.setAttribute('aria-activedescendant', rows[i].id); } else q.removeAttribute('aria-activedescendant');
}

function onInput() {
  const t = q.value.trim(); const my = ++seq;
  $('clear').hidden = !q.value;
  clearTimeout(timers.local); clearTimeout(timers.online);
  state = { answer: null, online: null, onlineMsg: '', cmd: null, local: [], text: t };
  if (!t) return render();
  state.answer = A.localAnswer(t, { rates: cfg.rates });
  render();
  const intent = cfg.online && A.networkIntent(t);
  if (intent) {
    timers.online = setTimeout(async () => {
      state.onlineMsg = 'Looking this up. Only "' + intent.q + '" is sent, to one free service.'; render();
      try { const r = await mfSearch.online(intent.type, intent.q); if (my !== seq) return; state.online = r; state.onlineMsg = r ? '' : 'No answer found. Press Enter to search the web.'; render(); } catch { if (my === seq) { state.onlineMsg = 'Could not reach the service. Press Enter to search the web.'; render(); } }
    }, 700);
  }
}

q.addEventListener('input', onInput);
q.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (rows.length) pick((sel + 1) % rows.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (rows.length) pick(sel <= 0 ? rows.length - 1 : sel - 1); }
  else if (e.key === 'Escape') { if (!$('pop').hidden) { state.text = ''; render(); } else { q.value = ''; onInput(); } }
});
$('f').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = q.value.trim(); if (!t) return;
  if (sel >= 0 && rows[sel]) return rows[sel]._run();
  mfSearch.go(t);
});
$('clear').addEventListener('click', () => { q.value = ''; onInput(); q.focus(); });
document.addEventListener('click', (e) => { if (!$('box').contains(e.target)) { $('pop').hidden = true; q.setAttribute('aria-expanded', 'false'); } });
q.addEventListener('focus', () => { if (state.text && rows.length) { $('pop').hidden = false; q.setAttribute('aria-expanded', 'true'); } });

async function init() {
  setup();
  try {
    cfg = await mfSearch.config();
    $('engtext').textContent = 'Results from ' + cfg.engineName;
    const s = $('engsel'); for (const [id, n] of Object.entries(cfg.engines)) { const o = document.createElement('option'); o.value = id; o.textContent = n; o.selected = id === cfg.engine; s.append(o); }
    $('chg').addEventListener('click', () => { s.hidden = false; $('chg').hidden = true; s.focus(); });
    s.addEventListener('change', async () => { const n = await mfSearch.setEngine(s.value); if (n) { cfg.engine = s.value; cfg.engineName = n; $('engtext').textContent = 'Results from ' + n; } s.hidden = true; $('chg').hidden = false; q.focus(); });
  } catch { $('engtext').textContent = 'Results from DuckDuckGo'; }
  q.focus();
}
if (window.mfSearch) init(); else { setup(); $('engtext').textContent = 'Search is not available on this page.'; }
