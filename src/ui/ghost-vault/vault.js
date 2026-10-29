'use strict';
// Ghost vault page. Draws only with textContent (no HTML from data). Talks to the desktop through the Ghost bridge group `vault`.
(() => {
  const root = (window.mayfairDesktop && (window.mayfairDesktop.ghost || (window.mayfairDesktop.browser && window.mayfairDesktop.browser.ghost))) || null;
  const V = root && root.vault;
  const $ = (id) => document.getElementById(id);
  const h = (tag, attrs, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v); }
    for (const c of kids.flat(Infinity)) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  };
  let st = null, phraseView = null;     // phraseView: { words, challenge } held only while the phrase is on screen
  const say = (msg, kind = '') => { const n = $('notice'); n.textContent = msg || ''; n.className = 'notice ' + kind; n.hidden = !msg; };
  const call = async (fn, ...a) => {
    if (!V) { say('Open this page in Mayfair Desktop to use the vault.', 'err'); return { ok: false }; }
    try { const r = await fn(...a); if (r && r.ok === false) say(r.error || 'That did not work.', 'err'); return r || { ok: false }; }
    catch { say('The vault could not be reached.', 'err'); return { ok: false }; }
  };
  const date = (s) => (s ? new Date(s).toLocaleString() : 'never');

  function renderFacts() {
    const f = $('facts'); f.textContent = '';
    const rows = [['Format', st.format || 'MFV1'], ['Key store', st.protection === 'os' ? 'This computer\'s secure key store' : 'File permissions only'],
      ['Key in use', st.keyId == null ? 'locked' : 'generation ' + st.keyId], ['Keys last rotated', st.rotated ? date(st.rotated) : 'never (created ' + date(st.created) + ')'],
      ['Stored', ['cases', 'scanlogs', 'connectors'].map((k) => (st.counts[k] || 0) + ' ' + ({ cases: 'case file(s)', scanlogs: 'log set(s)', connectors: 'setting set(s)' })[k]).join(', ')]];
    for (const [a, b] of rows) f.append(h('dt', {}, a), h('dd', {}, b));
    $('prot-msg').textContent = st.message || '';
  }
  function words(list) { return h('ol', { class: 'words' }, list.map((w, i) => h('li', {}, h('span', {}, i + 1), w))); }

  function renderBackup() {
    const b = $('backup-body'); b.textContent = '';
    const bk = st.backup || {};
    if (phraseView) { renderPhrase(b); return; }
    if (!bk.on) {
      b.append(h('p', { class: 's' }, 'Off. Your vault works without it, tied to this computer. Turn it on to add a passphrase, a 12-word recovery phrase, a downloadable encrypted vault file and an encrypted copy in Mayfair Files. If this computer is lost and Backup was never on, the data cannot be recovered.'));
      const p1 = h('input', { type: 'password', id: 'bk-pass', autocomplete: 'new-password' }), p2 = h('input', { type: 'password', id: 'bk-pass2', autocomplete: 'new-password' });
      b.append(h('label', {}, 'Passphrase (at least 10 characters)', p1), h('label', {}, 'Repeat passphrase', p2),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async () => {
          if (p1.value !== p2.value) return say('The two passphrases are different.', 'err');
          const r = await call(V.backup.begin, { passphrase: p1.value }); if (!r.ok) return;
          say(''); phraseView = { words: r.phrase, challenge: r.challenge, kind: 'enable' }; st = r.status; render();
        } }, 'Turn on Backup and passphrase')));
      return;
    }
    const sync = bk.lastSync;
    b.append(h('p', { class: 's' }, 'On. Passphrase and recovery phrase are set. ' + (bk.syncTarget ? (sync ? (sync.ok ? 'Last encrypted copy to Mayfair Files: ' + date(sync.at) + '.' : 'Last sync failed: ' + sync.error) : 'Syncing to Mayfair Files starts with your next change.') : 'Mayfair Files is not connected in this build, so nothing is synced; the downloaded vault file still works.')));
    b.append(h('div', { class: 'row' },
      h('button', { class: 'btn line', onclick: async () => { const r = await call(V.exportFile); if (r.ok) say(r.saved ? 'Saved ' + r.name + '. Keep it with your passphrase and phrase.' : 'Cancelled.', r.saved ? 'ok' : ''); } }, 'Download vault file'),
      h('button', { class: 'btn line', onclick: async () => { const r = await call(V.syncNow); if (r.ok) { st = r.status; render(); say(r.sync && r.sync.ok ? 'Synced.' : 'Not synced: ' + ((r.sync && (r.sync.error || r.sync.skipped)) || 'unknown'), r.sync && r.sync.ok ? 'ok' : 'err'); } } }, 'Sync now'),
      h('button', { class: 'btn line', onclick: async () => { const r = await call(V.backup.newPhrase); if (r.ok) { phraseView = { words: r.phrase, challenge: r.challenge, kind: 'phrase' }; st = r.status; render(); } } }, 'New recovery phrase')));
    // change passphrase
    const o = h('input', { type: 'password', autocomplete: 'current-password' }), n = h('input', { type: 'password', autocomplete: 'new-password' });
    b.append(h('details', {}, h('summary', {}, 'Change passphrase'), h('label', {}, 'Current passphrase', o), h('label', {}, 'New passphrase', n),
      h('div', { class: 'row' }, h('button', { class: 'btn line', onclick: async () => { const r = await call(V.changePassphrase, { oldPassphrase: o.value, newPassphrase: n.value }); if (r.ok) { o.value = n.value = ''; say('Passphrase changed.', 'ok'); } } }, 'Change'))));
    // require passphrase
    const cb = h('input', { type: 'checkbox', id: 'req', ...(st.requirePassphrase ? { checked: true } : {}) });
    cb.checked = !!st.requirePassphrase;
    cb.addEventListener('change', async () => { const r = await call(V.requirePassphrase, cb.checked); if (r.ok) { st = r.status; say(cb.checked ? 'The vault will ask for the passphrase each time the app starts.' : 'The vault opens with this computer\'s key store again.', 'ok'); } else cb.checked = !cb.checked; });
    b.append(h('label', { class: 'check' }, cb, 'Ask for the passphrase every time the app starts'));
    // restore
    const rp = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Passphrase of the file' }), rw = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'or its 12-word recovery phrase' });
    const rr = h('input', { type: 'checkbox' });
    b.append(h('details', {}, h('summary', {}, 'Restore from a vault file'), h('p', { class: 's' }, 'Replaces what is in this vault with the contents of the file.'), h('label', {}, 'Passphrase', rp), h('label', {}, 'Recovery phrase', rw),
      h('label', { class: 'check' }, rr, 'Replace what is here now'),
      h('div', { class: 'row' }, h('button', { class: 'btn line', onclick: async () => {
        const sec = rp.value ? { passphrase: rp.value } : rw.value ? { phrase: rw.value } : null; if (!sec) return say('Enter the passphrase or the recovery phrase first.', 'err');
        const r = await call(V.importFile, { ...sec, replace: rr.checked }); if (r.ok && r.imported) { rp.value = rw.value = ''; st = r.status; render(); say('Restored ' + r.records + ' item(s).', 'ok'); }
        else if (r.ok) say('Cancelled.');
      } }, 'Choose file and restore'))));
    // off
    b.append(h('div', { class: 'row' }, h('button', { class: 'btn line bad', onclick: async () => {
      const r = await call(V.backup.disable); if (r.ok) { st = r.status; render(); say('Backup is off and syncing has stopped. ' + ({ removed: 'The copy in Mayfair Files was deleted.', failed: 'The copy in Mayfair Files could not be deleted; remove it there. It cannot be opened with anything new.', none: '' })[r.remote || 'none'] + ' Every key was replaced, so the old passphrase, phrase and file open nothing written from now on.', 'ok'); }
    } }, 'Turn off Backup and stop syncing')));
  }
  function renderPhrase(b) {
    const pv = phraseView, ans = {};
    b.append(h('p', { class: 's' }, 'Write these 12 words down, in order, on paper. They are shown once and Mayfair cannot show them again. Anyone with the words and the vault file can open your vault.'), words(pv.words));
    const area = h('div', {});
    const ack = h('input', { type: 'checkbox' }), go = h('button', { class: 'btn primary', disabled: true }, 'Continue');
    ack.addEventListener('change', () => { go.disabled = !ack.checked; });
    go.addEventListener('click', () => {
      pv.words = null; b.textContent = '';   // the words leave the screen and memory of this page
      b.append(h('p', { class: 's' }, 'Check your copy. Type the words in these positions.'));
      for (const n of pv.challenge) { const i = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Word ' + n }); i.addEventListener('input', () => { ans[n] = i.value; }); b.append(h('label', {}, 'Word ' + n, i)); }
      b.append(h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          const r = await call(V.backup.confirm, { answers: ans });
          if (r.ok) { phraseView = null; st = r.status; render(); say('Backup is on.', 'ok'); } else { const s = await call(V.status); if (s && s.state && !(s.backup && s.backup.pending)) { phraseView = null; st = s; render(); } }
        } }, 'Confirm'),
        h('button', { class: 'btn line', onclick: async () => { await call(V.backup.cancel); phraseView = null; st = await call(V.status); render(); say('Cancelled. Nothing was changed.'); } }, 'Cancel')));
    });
    area.append(h('label', { class: 'check' }, ack, 'I wrote the words down'), h('div', { class: 'row' }, go,
      h('button', { class: 'btn line', onclick: async () => { await call(V.backup.cancel); phraseView = null; st = await call(V.status); render(); } }, 'Cancel')));
    b.append(area);
  }
  function render() {
    if (!st) return;
    const pill = $('pill');
    pill.textContent = st.state === 'unlocked' ? 'Unlocked' : st.state === 'locked' ? 'Locked' : 'Not started';
    pill.className = 'pill ' + (st.state === 'unlocked' ? (st.protection === 'os' ? 'ok' : 'warn') : 'warn');
    $('locked').hidden = st.state !== 'locked'; $('main').hidden = st.state === 'locked';
    if (st.state === 'locked' && st.note) say(st.note, 'err');
    if (st.state !== 'locked') { renderFacts(); renderBackup(); }
    if (st.protection !== 'os' && st.state !== 'locked' && !$('notice').textContent) say(st.message, '');
  }
  async function refresh() { const r = V ? await V.status() : null; if (r) { st = r; render(); } else say('Open this page in Mayfair Desktop to use the vault.', 'err'); }

  $('u-go').addEventListener('click', async () => { const r = await call(V && V.unlock, { passphrase: $('u-pass').value }); if (r.ok) { $('u-pass').value = ''; say(''); st = r.status; render(); } });
  $('u-phrase-go').addEventListener('click', async () => { const r = await call(V && V.resetPassphrase, { phrase: $('u-phrase').value, newPassphrase: $('u-new').value }); if (r.ok) { $('u-phrase').value = $('u-new').value = ''; say('Unlocked, and the passphrase was changed.', 'ok'); st = r.status; render(); } });
  $('lock').addEventListener('click', async () => { const r = await call(V && V.lock); if (r.ok) { st = r.status; render(); say('Locked. The key is no longer in memory.', 'ok'); } });
  $('rotate').addEventListener('click', async () => {
    let pass; if (st.backup && st.backup.on) { pass = window.prompt('Enter your passphrase to rotate keys:'); if (!pass) return; }
    const r = await call(V && V.rotateKeys, pass ? { passphrase: pass } : undefined);
    if (!r.ok) return; st = r.status;
    if (r.phrase) { phraseView = { words: r.phrase, challenge: r.challenge, kind: 'phrase' }; say('Keys rotated. The old recovery phrase no longer works: write down and confirm the new one.', 'ok'); } else say('Keys rotated. ' + r.records + ' item(s) re-encrypted.', 'ok');
    render();
  });
  $('w-text').addEventListener('input', () => { $('w-go').disabled = $('w-text').value !== 'WIPE'; });
  $('w-go').addEventListener('click', async () => { const r = await call(V && V.wipe, { confirm: 'WIPE' }); if (r.ok) { $('w-text').value = ''; $('w-go').disabled = true; phraseView = null; say('The vault was wiped and its keys destroyed. A new empty vault is created the next time you use Ghost.', 'ok'); const s = await V.status(); st = s; render(); } });
  refresh();
})();
