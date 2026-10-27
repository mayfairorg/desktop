'use strict';
// Ghost investigation browser: control window. Text only (textContent).
(() => {
  const $ = (id) => document.getElementById(id);
  const gb = window.ghostBrowser;
  const say = (t, err) => { const n = $('notice'); n.textContent = t; n.className = 'notice' + (err ? ' err' : ''); n.hidden = !t; };
  const form = () => ({ caseId: $('case').value.trim(), name: $('name').value.trim() || undefined, url: $('url').value.trim() || undefined });
  const valid = (f) => /^[A-Za-z0-9_-]{1,40}$/.test(f.caseId);
  async function open(route, directConfirmed) {
    const f = form(); if (!valid(f)) return say('Case ID must be 1 to 40 letters, digits, - or _.', true);
    say(route === 'tor' ? 'Connecting to Tor. This can take a minute.' : '');
    $('go').disabled = true;
    const r = await gb.launcher.open({ ...f, route, ...(directConfirmed ? { directConfirmed: true } : {}) }).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
    $('go').disabled = false;
    if (r.ok) { say(''); $('direct').hidden = true; refresh(); return; }
    if (r.code === 'tor-unavailable') { say('Tor is not available: ' + r.error + ' Nothing was opened. You can choose to connect directly instead, which shows your real IP address to sites.', true); $('direct').hidden = false; return; }
    say(r.error || 'Could not open.', r.code !== 'declined');
  }
  async function refresh() {
    const r = await gb.launcher.cases().catch(() => null); const box = $('open'); box.replaceChildren();
    $('open-card').hidden = !r || !r.cases.length; if (!r) return;
    for (const c of r.cases) { const d = document.createElement('div'); d.className = 'rowx'; const t = document.createElement('span'); t.className = 'chip ' + c.tone; t.textContent = c.text; d.appendChild(t); box.appendChild(d); }
  }
  $('go').addEventListener('click', () => open('tor'));
  $('direct').addEventListener('click', () => open('direct-doh'));
  $('kill').addEventListener('click', async () => { const r = await gb.kill(); say(r.ok ? 'Done: ' + r.report.windows + ' window(s) closed and wiped, Tor stopped, vault locked.' : 'Kill failed.', !r.ok); refresh(); });
  gb.onKilled(() => refresh());
  refresh();
})();
