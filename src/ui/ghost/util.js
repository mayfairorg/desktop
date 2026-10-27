'use strict';
// Ghost page helpers: element builder (text only, never HTML from data), icons, toasts, dialogs, the bridge wrapper, small formatters.
// The page draws everything with textContent so nothing a connector returns can become markup. No inline style attributes are used (the page policy forbids them).
(function () {
  const GH = (window.GH = window.GH || {});
  const NS = 'http://www.w3.org/2000/svg';

  // h('div', {class:'x', onclick: fn, dataset:{a:1}, style:{width:'3px'}}, child, 'text', [more])
  GH.h = function h(tag, attrs, ...kids) {
    const svg = tag === 'svg' || tag.startsWith('svg:');
    const e = svg ? document.createElementNS(NS, tag.replace('svg:', '')) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') e.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'object') for (const [p, x] of Object.entries(v)) e.style.setProperty(p, x);
      else if (k === 'dataset') for (const [p, x] of Object.entries(v)) e.dataset[p] = x;
      else if (k === 'value') e.value = v;
      else if (k === 'checked') e.checked = !!v;
      else if (k === 'disabled') { if (v) e.setAttribute('disabled', ''); }
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'style') continue;
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };
  const h = GH.h;
  // Element.append would write the word "null" for a null child; the page builds many lists with optional pieces, so null, undefined and false are skipped and arrays are flattened.
  const nativeAppend = Element.prototype.append;
  Element.prototype.append = function append(...kids) { return nativeAppend.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
  GH.icon = (name, cls) => { const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', 'ico' + (cls ? ' ' + cls : '')); s.setAttribute('aria-hidden', 'true'); const u = document.createElementNS(NS, 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s; };
  GH.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  GH.btn = (label, o = {}) => h('button', { type: o.type || 'button', class: 'btn' + (o.primary ? ' primary' : '') + (o.ghost ? ' ghost' : '') + (o.icon && !label ? ' icon' : '') + (o.l ? ' l' : '') + (o.cls ? ' ' + o.cls : ''), onclick: o.onclick, disabled: o.disabled, title: o.title, 'aria-label': o.aria || (label ? null : o.title), id: o.id }, o.icon ? GH.icon(o.icon) : null, label ? h('span', {}, label) : null);

  GH.say = (msg) => { const l = document.getElementById('live'); if (l) { l.textContent = ''; setTimeout(() => { l.textContent = msg; }, 20); } };
  let toastTimer = null;
  GH.toast = (msg, kind) => {
    let t = document.getElementById('toast');
    if (!t) { t = h('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(t); }
    t.textContent = msg; t.className = 'toast' + (kind ? ' ' + kind : ''); t.hidden = false; GH.say(msg);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 5200);
  };

  // dialog({ title, sub, body: Node, actions: [{label, primary, value, keep}], width }) -> Promise(value of the pressed action, or null when closed)
  // `body` may be a function (close) => Node. Focus is trapped, Escape closes, focus returns to where it was.
  GH.dialog = (o) => new Promise((resolve) => {
    const prev = document.activeElement;
    let done = false;
    const close = (v) => { if (done) return; done = true; scrim.remove(); document.removeEventListener('keydown', key, true); if (prev && prev.focus) { try { prev.focus(); } catch { /* gone */ } } resolve(v === undefined ? null : v); };
    const titleId = 'dlg-t-' + Math.random().toString(36).slice(2, 8);
    const acts = (o.actions || [{ label: 'Close', value: null }]).map((a) => GH.btn(a.label, { primary: a.primary, cls: a.danger ? 'danger' : '', disabled: a.disabled, onclick: async () => { if (a.onclick) { const r = await a.onclick(close); if (r === false) return; } if (!a.keep) close(a.value === undefined ? a.label : a.value); } }));
    const body = typeof o.body === 'function' ? o.body(close, acts) : o.body;
    const scrim = h('div', { class: 'scrim', onmousedown: (e) => { if (e.target === scrim && !o.modal) close(null); } },
      h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, style: o.width ? { width: 'min(' + o.width + 'px,100%)' } : {} },
        h('div', { class: 'dlg-in' },
          h('div', { class: 'dlg-h' }, o.icon ? GH.icon(o.icon, 'ico-l') : null, h('div', {}, h('h2', { id: titleId }, o.title), o.sub ? h('p', { class: 'mute sm' }, o.sub) : null), GH.btn('', { icon: 'x', ghost: true, title: 'Close', onclick: () => close(null) })),
          h('div', { class: 'dlg-b' }, body),
          h('div', { class: 'dlg-f' }, h('span', { class: 'why', id: titleId + '-why', 'aria-live': 'polite' }), h('div', { class: 'dlg-a' }, acts)))));
    const key = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); return; }
      if (e.key !== 'Tab') return;
      const f = [...scrim.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"],a[href]')].filter((x) => x.offsetParent !== null);
      if (!f.length) return; const a = f[0], z = f[f.length - 1];
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', key, true);
    document.body.append(scrim);
    const first = scrim.querySelector('[data-autofocus]') || scrim.querySelector('input,select,textarea') || scrim.querySelector('.dlg-a .btn.primary') || scrim.querySelector('.dlg-a .btn');
    if (first) first.focus();
    scrim._close = close; scrim._why = scrim.querySelector('.why'); scrim._actions = acts;
    if (o.onopen) o.onopen(scrim, close);
  });
  GH.confirm = (title, detail, ok, danger) => GH.dialog({ title, body: h('p', {}, detail), actions: [{ label: 'Cancel', value: false }, { label: ok || 'OK', primary: !danger, danger, value: true }] }).then((v) => v === true);

  // ---------- the bridge ----------
  // Every call resolves to its data, or throws Error with .code and a plain message (for display). Without the desktop bridge the page shows a "needs Mayfair Desktop" screen.
  const api = window.ghostApp || null;
  GH.hasBridge = !!api;
  GH.api = api;
  GH.call = async function call(fn, ...a) {
    let r;
    try { r = await fn(...a); } catch (e) { const err = new Error('Ghost could not reach the app. Close and reopen it.'); err.code = 'bridge'; throw err; }
    if (r && r.ok === false) { const err = new Error(r.error || 'That did not work.'); err.code = r.code || 'error'; throw err; }
    return r && r.ok === true && 'data' in r ? r.data : r;
  };
  GH.errText = (e) => (e && e.message ? e.message : 'That did not work.');

  // ---------- formatting ----------
  GH.fmtTime = (iso) => { if (!iso) return 'never'; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : String(iso); };
  GH.fmtClock = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; };
  GH.fmtDate = (iso) => String(iso || '').slice(0, 10);
  GH.plural = (n, a, b) => n + ' ' + (n === 1 ? a : b || a + 's');
  GH.TYPE_LABEL = { domain: 'Domain', ip: 'IP address', asn: 'Network (ASN)', cert: 'Certificate', org: 'Organisation', document: 'Document', image: 'Image', place: 'Place', event: 'Event', url: 'Web address', email: 'Infrastructure contact', service: 'Service', finding: 'Finding' };
  GH.TYPE_PLURAL = { domain: 'Domains', ip: 'IP addresses', asn: 'Networks', cert: 'Certificates', org: 'Organisations', document: 'Documents', image: 'Images', place: 'Places', event: 'Events', url: 'Web addresses', email: 'Contacts', service: 'Services', finding: 'Findings' };
  GH.debounce = (fn, ms) => { let t = null; const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; d.flush = () => { clearTimeout(t); fn(); }; d.cancel = () => clearTimeout(t); return d; };
  GH.copy = async (text) => { try { await navigator.clipboard.writeText(text); GH.toast('Copied.'); } catch { GH.toast('Copy is not available here.'); } };

  // A labelled form field. kind: 'text'|'textarea'|'select'|'checkbox'
  GH.field = (label, control, hint) => { const id = control.id || (control.id = 'f-' + Math.random().toString(36).slice(2, 8)); return h('div', { class: 'fld' }, h('label', { for: id }, label), control, hint ? h('span', { class: 'hint', id: id + '-h' }, hint) : null); };
  GH.chk = (label, o = {}) => { const input = h('input', { type: 'checkbox', id: o.id, checked: o.checked, disabled: o.disabled, onchange: o.onchange }); return { el: h('label', { class: 'chk' }, input, h('span', {}, label)), input }; };
})();
