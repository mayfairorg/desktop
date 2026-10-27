'use strict';
// Ghost start flow: download -> sign in with Mayfair ID -> access check -> Terms -> the app. There is no question about keys, a passphrase or a purpose.
// Each screen is drawn from the status main reports (GH.status). Main decides the stage; this file only shows it and asks main to move on.
(function () {
  const GH = window.GH, h = GH.h;
  const STEPS = ['Download', 'Sign in', 'Access', 'Terms'];
  const stepOf = { download: 0, 'vault-locked': 0, signin: 1, checking: 2, offline: 2, apply: 2, terms: 3 };

  function frame(stage, ...kids) {
    const i = stepOf[stage] === undefined ? 0 : stepOf[stage];
    return h('main', { id: 'main', class: 'flow', tabindex: '-1' },
      h('div', { class: 'flow-grid', 'aria-hidden': 'true' }),
      h('div', { class: 'flow-in' },
        h('div', { class: 'flow-brand' }, GH.icon('ghost', 'brand-ico'), h('span', { class: 'brand-t' }, h('b', {}, 'MAYFAIR'), h('i', {}, 'GHOST'))),
        h('ol', { class: 'steps', 'aria-label': 'Start steps' }, STEPS.map((s, n) => h('li', { class: n < i ? 'done' : '', 'aria-current': n === i ? 'step' : null }, h('span', { class: 'mono' }, n < i ? GH.icon('check') : String(n + 1)), s))),
        ...kids));
  }
  const bullets = (items, no) => h('ul', { class: 'bul' + (no ? ' no' : '') }, items.map((t) => h('li', {}, t)));
  const panel = (title, ...kids) => h('section', { class: 'panel' }, h('div', { class: 'panel-h' }, h('h2', {}, title)), ...kids);
  const notice = (text, kind) => (text ? h('p', { class: 'flow-note ' + (kind || ''), role: kind === 'err' ? 'alert' : null }, GH.icon(kind === 'err' ? 'alert' : 'lock'), h('span', {}, text)) : null);
  const accountLine = (st) => (st.account && (st.account.email || st.account.name) ? h('p', { class: 'mute mono sm' }, 'Signed in as ' + (st.account.email || st.account.name)) : null);

  // ---------- 1. download ----------
  function download(st) {
    const bar = h('i', {}), phase = h('span', { class: 'mono mute sm', 'aria-live': 'polite' }, ''), prog = h('div', { class: 'dl-prog', hidden: true }, h('div', { class: 'bar' }, bar), phase);
    const msg = h('div', {});
    let off = null;
    const go = GH.btn('Download and continue', { primary: true, l: true, onclick: async () => {
      go.disabled = true; prog.hidden = false; GH.clear(msg);
      off = GH.api.onInstall((p) => { phase.textContent = p.phase; bar.style.width = (p.pct || 0) + '%'; });
      try { await GH.call(GH.api.install); } catch (e) { prog.hidden = true; go.disabled = false; msg.append(notice(GH.errText(e), 'err')); } finally { if (off) off(); }
    } });
    return frame('download',
      h('div', { class: 'flow-head' }, h('p', { class: 'eyebrow mono' }, 'OPEN-SOURCE INTELLIGENCE'), h('h1', {}, 'Ghost, for approved professionals.'),
        h('p', { class: 'lead' }, 'Look up domains, networks, companies, files, places and news. Keep what you find in a case on this computer. Free, with no limits.')),
      h('div', { class: 'cols' },
        panel('What happens next', h('ol', { class: 'how' }, [
          ['Download', 'A small download. Tools come later, only when you use them.'], ['Sign in', 'With your Mayfair ID, in your browser.'], ['Access check', 'Ghost opens for approved accounts only. If you are not approved yet, you can apply.'], ['Terms', 'You accept them once. Then Ghost opens.']].map(([a, b], n) => h('li', {}, h('span', { class: 'mono n' }, String(n + 1)), h('div', {}, h('b', {}, a), h('span', { class: 'mute' }, ' ' + b)))))),
        panel('What Ghost will not do', bullets(['Find or profile one private person: no username, email, phone or face search.', 'Look up people in breach data, or use people-search sites.', 'Get past logins, CAPTCHAs or other access controls.', 'Send anything about your work to Mayfair. No telemetry.'], true))),
      h('div', { class: 'flow-act' }, go, prog), msg,
      h('p', { class: 'mute mono sm' }, 'Nothing is stored in plain text. Your cases are encrypted on this computer.'));
  }

  // ---------- 1b. vault asks for its passphrase (only when the person turned that on in the vault settings) ----------
  function vaultLocked() {
    const pass = h('input', { type: 'password', id: 'vl-pass', autocomplete: 'current-password', 'data-autofocus': '' }), msg = h('div', {});
    const go = async () => { GH.clear(msg); try { await GH.call(GH.api.vault.unlock, { passphrase: pass.value }); pass.value = ''; } catch (e) { msg.append(notice(GH.errText(e), 'err')); } };
    return frame('vault-locked', h('div', { class: 'flow-head' }, h('h1', {}, 'Unlock your vault'), h('p', { class: 'lead sm' }, 'You asked the vault to ask for its passphrase each time. Your cases stay encrypted until you unlock it.')),
      h('form', { class: 'panel stack narrow', onsubmit: (e) => { e.preventDefault(); go(); } }, GH.field('Vault passphrase', pass), msg, h('div', { class: 'row-a' }, GH.btn('Unlock', { primary: true, type: 'submit' }))));
  }

  // ---------- 2. sign in ----------
  function signin(st) {
    const si = st.signin, msg = h('div', {});
    const start = async (btn) => { btn.disabled = true; GH.clear(msg); try { await GH.call(GH.api.signIn.start); } catch (e) { msg.append(notice(GH.errText(e), 'err')); btn.disabled = false; } };
    let body;
    if (si && si.state === 'waiting') {
      body = h('div', { class: 'panel code-card' },
        h('p', { class: 'mute' }, 'We opened the Mayfair ID page in your browser. Check that this code matches, then approve.'),
        h('p', { class: 'ucode mono', 'aria-label': 'Your code: ' + String(si.userCode).split('').join(' ') }, si.userCode),
        h('p', { class: 'wait mono' }, GH.icon('refresh', 'spin'), h('span', {}, 'Waiting for you to approve')),
        h('p', { class: 'mute sm' }, 'The page is ' + si.verificationUri),
        h('div', { class: 'row-a' }, GH.btn('Open the page again', { onclick: () => GH.call(GH.api.signIn.open).catch((e) => GH.toast(GH.errText(e))) }), GH.btn('Cancel', { ghost: true, onclick: () => GH.call(GH.api.signIn.cancel).catch(() => {}) })));
    } else {
      const go = GH.btn('Sign in with Mayfair ID', { primary: true, l: true, onclick: () => start(go) });
      body = h('div', { class: 'stack' },
        si && si.error ? notice(si.error, 'err') : null, st.error ? notice(st.error, 'err') : null, h('div', { class: 'flow-act' }, go), msg,
        h('p', { class: 'mute sm' }, 'You sign in on the Mayfair ID page, not here. Ghost never sees your password.'));
    }
    return frame('signin', h('div', { class: 'flow-head' }, h('h1', {}, 'Sign in with Mayfair ID'), h('p', { class: 'lead sm' }, 'Ghost opens for approved accounts. Your Mayfair ID tells us who you are, so there is nothing else to set up.')), body);
  }

  // ---------- 3. access ----------
  function checking() { return frame('checking', h('div', { class: 'flow-head' }, h('h1', {}, 'Checking your access'), h('p', { class: 'lead sm' }, 'One moment.')), h('div', { class: 'skel', 'aria-hidden': 'true' }, h('i', {}), h('i', {}), h('i', {}))); }
  function offline(st) {
    const msg = h('div', {});
    return frame('offline', h('div', { class: 'flow-head' }, h('h1', {}, 'Mayfair cannot be reached'), h('p', { class: 'lead sm' }, 'Ghost checks your access with Mayfair when it starts. It can work without a connection for up to 3 days after the last check, and that time has run out.')),
      accountLine(st), msg, h('div', { class: 'row-a' }, GH.btn('Try again', { primary: true, onclick: async (e) => { try { await GH.call(GH.api.entitlement.check); } catch (x) { GH.clear(msg); msg.append(notice(GH.errText(x), 'err')); } } }), GH.btn('Sign out', { ghost: true, onclick: () => GH.call(GH.api.signIn.out) })));
  }
  const APPLY = {
    none: ['Ghost is for approved professionals', 'This Mayfair ID has not been approved for Ghost. Approval is for people who work for a government body or hold a professional licence, and who have a lawful reason to look up public information.'],
    pending: ['Your application is being reviewed', 'A reviewer is checking it. You will not need to do anything until it is decided. When it is approved, press "Check again" and Ghost opens.'],
    rejected: ['Your application was not approved', 'You can apply again after the wait shown on the apply page.'],
    revoked: ['Your access was withdrawn', 'Ghost is locked for this account. The apply page explains what to do next.'],
    expired: ['Your approval has run out', 'Approvals last 12 months. Renew yours on the apply page, then press "Check again".'],
  };
  function apply(st) {
    const e = st.entitlement || { status: 'none' }; const [title, text] = APPLY[e.status] || APPLY.none, msg = h('div', {});
    const chk = GH.btn('Check again', { onclick: async () => { chk.disabled = true; GH.clear(msg); try { await GH.call(GH.api.entitlement.check); } catch (x) { msg.append(notice(GH.errText(x), 'err')); } chk.disabled = false; } });
    return frame('apply', h('div', { class: 'flow-head' }, h('p', { class: 'eyebrow mono' }, 'ACCESS'), h('h1', {}, title), h('p', { class: 'lead sm' }, text)), accountLine(st), e.note ? h('p', { class: 'flow-note' }, GH.icon('alert'), h('span', {}, e.note)) : null,
      h('div', { class: 'cols' },
        panel('What the application asks for', bullets(['Government photo ID and a live selfie check.', 'Proof of your role: an employer letter or a professional licence number.', 'Your work email on your organisation\'s domain, and a call to its public switchboard.', 'A short statement of what you will use Ghost for, and a referee who confirms.', 'Acceptance of the Ghost Terms.'])),
        panel('What nothing here does', bullets(['Nothing is downloaded for you until you are approved.', 'Mayfair keeps your application and its outcome. It never sees your cases.'], false))),
      h('div', { class: 'row-a' }, GH.btn(e.status === 'pending' ? 'Open the application' : e.status === 'expired' ? 'Renew access' : 'Apply for access', { primary: true, l: true, onclick: async () => { try { await GH.call(GH.api.entitlement.apply); } catch (x) { GH.toast(GH.errText(x)); } } }), chk, GH.btn('Use another account', { ghost: true, onclick: () => GH.call(GH.api.signIn.out) })), msg);
  }

  // ---------- 4. terms ----------
  function inline(text) { const out = []; const re = /\[\[([^\]]+)\]\]/g; let last = 0, m; while ((m = re.exec(text))) { if (m.index > last) out.push(text.slice(last, m.index)); out.push(h('span', { class: 'ph', title: 'Waiting for legal review' }, '[' + m[1] + ']')); last = m.index + m[0].length; } if (last < text.length) out.push(text.slice(last)); return out; }
  function clauseNodes(c) {
    const nodes = [h('h3', {}, c.title)]; let list = null;
    for (const block of c.body.split(/\n{2,}/)) {
      const lines = block.split('\n');
      if (lines.every((l) => l.startsWith('- '))) nodes.push(h('ul', {}, lines.map((l) => h('li', {}, inline(l.slice(2))))));
      else if (lines.some((l) => l.startsWith('- '))) { const lead = lines.filter((l) => !l.startsWith('- ')).join(' '); if (lead) nodes.push(h('p', {}, inline(lead))); nodes.push(h('ul', {}, lines.filter((l) => l.startsWith('- ')).map((l) => h('li', {}, inline(l.slice(2)))))); }
      else nodes.push(h('p', {}, inline(lines.join(' '))));
    }
    return nodes;
  }
  function terms(st) {
    const body = h('div', { class: 'terms-body', id: 'terms-body', tabindex: '0', role: 'region', 'aria-label': 'Full terms. Scroll to the end to accept.' }, h('div', { class: 'skel' }, h('i', {}), h('i', {})));
    const hint = h('span', { class: 'mute mono', id: 'scroll-h' }, 'Scroll to the end to accept');
    const c1 = GH.chk('I have read and accept the Terms.', { disabled: true }), c2 = GH.chk('I will use Ghost only for a genuine, lawful reason.', { disabled: true });
    const msg = h('div', {});
    let data = null;
    const accept = GH.btn('Accept and open Ghost', { primary: true, l: true, disabled: true, onclick: async () => { accept.disabled = true; GH.clear(msg); try { await GH.call(GH.api.terms.accept, { version: data.version, sha256: data.sha256, lawful: c2.input.checked }); } catch (e) { msg.append(notice(GH.errText(e), 'err')); accept.disabled = false; } } });
    const upd = () => { accept.disabled = !(c1.input.checked && c2.input.checked && !c1.input.disabled); };
    c1.input.addEventListener('change', upd); c2.input.addEventListener('change', upd);
    const reached = () => { c1.input.disabled = c2.input.disabled = false; hint.textContent = 'You reached the end'; upd(); };
    GH.call(GH.api.terms.get).then((t) => {
      data = t; GH.clear(body); for (const c of t.clauses) body.append(...clauseNodes(c));
      body.addEventListener('scroll', () => { if (body.scrollTop + body.clientHeight >= body.scrollHeight - 8) reached(); });
      requestAnimationFrame(() => { if (body.scrollHeight <= body.clientHeight + 8) reached(); });
      if (t.draftNotes) draft.hidden = false; ver.textContent = 'Version ' + t.version + (t.record ? ', last accepted ' + GH.fmtDate(t.record.acceptedAt) : '');
    }).catch((e) => { GH.clear(body); body.append(notice(GH.errText(e), 'err')); });
    const draft = h('p', { class: 'flow-note', hidden: true }, GH.icon('alert'), h('span', {}, 'This text is a draft. Items in [brackets] are waiting for legal review.'));
    const ver = h('p', { class: 'mute mono' }, '');
    return frame('terms', h('div', { class: 'terms-head' }, h('h1', {}, 'Terms of use'), ver), draft,
      h('div', { class: 'cols terms-cols' },
        panel('The short version', bullets(['Use Ghost only for a genuine, lawful reason.', 'Never use it to stalk, harass or profile a private person.', 'Scan only systems you own or have written permission to test.', 'Public data can be wrong. Check before you rely on it.', 'Your cases stay on this computer. We cannot read or recover them.']), h('p', { class: 'mute sm' }, 'The full text is what applies.')),
        h('section', { class: 'panel full' }, h('div', { class: 'panel-h' }, h('h2', {}, 'Full terms'), hint), body)),
      h('div', { class: 'accept' }, c1.el, c2.el, msg, h('div', { class: 'accept-a' }, accept, GH.btn('Sign out', { ghost: true, onclick: () => GH.call(GH.api.signIn.out) }))));
  }

  GH.flow = {
    view(st) {
      switch (st.stage) {
        case 'download': return download(st);
        case 'vault-locked': return vaultLocked();
        case 'signin': return signin(st);
        case 'checking': return checking();
        case 'offline': return offline(st);
        case 'apply': return apply(st);
        case 'terms': return terms(st);
        default: return null;
      }
    },
    noBridge() {
      return h('main', { id: 'main', class: 'flow', tabindex: '-1' }, h('div', { class: 'flow-grid', 'aria-hidden': 'true' }), h('div', { class: 'flow-in' },
        h('div', { class: 'flow-brand' }, GH.icon('ghost', 'brand-ico'), h('span', { class: 'brand-t' }, h('b', {}, 'MAYFAIR'), h('i', {}, 'GHOST'))),
        h('div', { class: 'flow-head' }, h('h1', {}, 'Needs Mayfair Desktop'), h('p', { class: 'lead sm' }, 'Ghost runs only inside Mayfair Desktop. Nothing is looked up from a web page.'))));
    },
  };
})();
