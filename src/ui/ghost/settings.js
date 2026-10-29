'use strict';
// Ghost Settings > Appearance: the skin picker (live: the whole window changes as you choose), light or dark, and the decorations switch.
// The choice is kept in the Ghost vault for this account (ghostApp.prefs), not in the page, so it follows the user and is never stored in the clear.
(function () {
  const GH = window.GH, h = GH.h, K = window.GhostSkins;
  let state = K.clean(null), loaded = false;
  const LAYOUT = { sidebar: 'Sidebar layout', 'panel-grid': 'Panel grid layout', 'ring-hud': 'Ring layout', 'single-column': 'Single column layout', console: 'Console layout', 'menu-shell': 'Menu shell layout' };

  let shown = null;
  function paint(p) {
    const el = document.documentElement, c = K.clean(p), was = shown; shown = c.skin;
    el.setAttribute('data-skin', c.skin); el.setAttribute('data-theme', K.effectiveTheme(c));
    if (c.deco) el.removeAttribute('data-deco'); else el.setAttribute('data-deco', 'off');
    const m = document.querySelector('meta[name=color-scheme]'); if (m) m.setAttribute('content', K.effectiveTheme(c));
    if (GH.syncThemeButton) GH.syncThemeButton();
    document.querySelectorAll('.sk-prev[data-live=theme]').forEach((n) => n.setAttribute('data-theme', c.theme));
    if (was !== null && was !== c.skin && GH.relayout) GH.relayout();   // a different skin is a different layout: the frame is rebuilt at once
  }
  GH.appearance = {
    state: () => ({ ...state }), skin: () => state.skin, theme: () => K.effectiveTheme(state), darkOnly: () => K.byId(state.skin).dark, decorations: () => state.deco,
    // Show a state without saving it (the start screens use the default; a failed save leaves what the user chose on screen).
    apply: (p) => { state = K.clean(p); paint(state); },
    // Read this account's saved choice from the vault and show it.
    async load() { try { state = K.clean(await GH.call(GH.api.prefs.get)); } catch { state = K.clean(null); } loaded = true; paint(state); return { ...state }; },
    // patch: { skin?, theme?, deco? }. Shown at once, then saved. A failed save is said plainly and the choice stays until Ghost is closed.
    async set(patch) {
      const prev = state; state = K.clean({ ...state, ...patch }); paint(state);
      if (!GH.hasBridge) return state;
      try { state = K.clean(await GH.call(GH.api.prefs.set, patch)); paint(state); } catch (e) { GH.toast('Your choice is shown but could not be saved: ' + GH.errText(e)); void prev; }
      return state;
    },
  };

  // A small drawing of a window in a skin, in that skin's layout. The tile carries data-skin itself, so it takes that skin's variables whatever skin the page is in.
  const bs = (n, cls) => Array.from({ length: n }, () => h('b', { class: cls || null }));
  function preview(sk) {
    const live = !sk.dark, t = h('div', { class: 'sk-prev ' + 'lay-' + sk.layout, 'aria-hidden': 'true', dataset: { skin: sk.id } });
    if (live) { t.setAttribute('data-live', 'theme'); t.setAttribute('data-theme', state.theme); }
    if (sk.layout === 'console') t.append(h('i', { class: 'sk-tabs' }, bs(6)), h('i', { class: 'sk-tree' }, bs(4)), h('i', { class: 'sk-map' }, h('s', { class: 'sk-l1' }), h('s', { class: 'sk-dot' }), h('s', { class: 'sk-dot d2' })), h('i', { class: 'sk-side' }, bs(3)), h('i', { class: 'sk-tbls' }, h('s', {}), h('s', {}), h('s', {})));
    else if (sk.layout === 'panel-grid') t.append(h('i', { class: 'sk-box a' }, bs(3)), h('i', { class: 'sk-box b' }, h('s', { class: 'sk-bar' }, h('u', {})), h('s', { class: 'sk-bar' }, h('u', {}))), h('i', { class: 'sk-box c' }, bs(4)), h('i', { class: 'sk-box d' }, h('s', { class: 'sk-lock' })));
    else if (sk.layout === 'ring-hud') t.append(h('i', { class: 'sk-col' }, h('s', { class: 'sk-card' }), h('s', { class: 'sk-card' }), h('s', { class: 'sk-card' })), h('i', { class: 'sk-ring' }, h('s', {})), h('i', { class: 'sk-col' }, h('s', { class: 'sk-card' }), h('s', { class: 'sk-card' })));
    else if (sk.layout === 'menu-shell') t.append(h('i', { class: 'sk-ban' }), h('i', { class: 'sk-mnu' }, h('s', { class: 'on' }), h('s', {}), h('s', {}), h('s', {})));
    else if (sk.layout === 'single-column') t.append(h('i', { class: 'sk-big' }, h('s', {}), h('s', {})), h('i', { class: 'sk-in' }, h('s', {}), h('u', {})), h('i', { class: 'sk-chars' }, h('s', {}), h('s', {}), h('s', {})));
    else t.append(h('i', { class: 'sk-rail' }, h('b', {}), h('b', {}), h('b', { class: 'on' }), h('b', {})),
      h('i', { class: 'sk-main' }, h('s', { class: 'sk-h' }), h('s', { class: 'sk-t' }), h('i', { class: 'sk-card' }, h('s', { class: 'sk-l' }), h('s', { class: 'sk-l' }), h('s', { class: 'sk-bar' }, h('u', {}))), h('s', { class: 'sk-btn' })));
    return t;
  }
  function radio(name, value, checked, label, o = {}) {
    const input = h('input', { type: 'radio', name, value, checked, disabled: o.disabled, class: 'sr', onchange: () => o.onpick(value) });
    return h('label', { class: o.cls || 'seg', 'aria-disabled': o.disabled ? 'true' : null }, input, ...(o.kids || [h('span', {}, label)]));
  }
  function row(title, detail, control) { return h('div', { class: 'srow' }, h('div', { class: 'srow-t' }, h('b', {}, title), detail ? h('span', {}, detail) : null), h('div', { class: 'srow-c' }, control)); }

  GH.routes.settings = async () => {
    if (!loaded) await GH.appearance.load();
    const live = h('p', { class: 'sr', role: 'status' }, '');
    const skinHost = h('div', { class: 'skins', role: 'radiogroup', 'aria-label': 'Skin' });
    const modeHost = h('div', { class: 'segs', role: 'radiogroup', 'aria-label': 'Light or dark' });
    const modeNote = h('span', { class: 'hint' }, '');
    const decoBox = GH.chk('Show skin decorations', { checked: state.deco, onchange: (e) => GH.appearance.set({ deco: e.target.checked }) });
    const drawModes = () => {
      const only = GH.appearance.darkOnly(), cur = GH.appearance.theme(); GH.clear(modeHost);
      for (const [v, l] of [['dark', 'Dark'], ['light', 'Light']]) modeHost.append(radio('mode', v, cur === v, l, { disabled: only && v === 'light', onpick: (x) => GH.appearance.set({ theme: x }) }));
      modeNote.textContent = only ? 'This skin is dark only. Choose Mayfair to use the light theme.' : '';
    };
    const pick = async (id) => { await GH.appearance.set({ skin: id }); drawModes(); GH.say('Skin: ' + K.byId(GH.appearance.skin()).label + '. The layout changed.'); };
    for (const sk of K.SKINS) {
      skinHost.append(radio('skin', sk.id, state.skin === sk.id, sk.label, { cls: 'sk', onpick: pick, kids: [preview(sk), h('span', { class: 'sk-n' }, h('b', {}, sk.label), h('em', {}, LAYOUT[sk.layout]), sk.dark ? h('em', {}, 'Dark only') : null), h('span', { class: 'sk-d' }, sk.blurb), GH.icon('check', 'sk-ok')] }));
    }
    drawModes();
    const reset = GH.btn('Back to Mayfair', { onclick: async () => { await GH.appearance.set({ skin: K.DEFAULT, deco: true }); GH.render(); } });
    return h('section', { class: 'view settings', 'aria-labelledby': 'h-set' },
      h('div', {}, h('p', { class: 'eyebrow' }, 'Settings'), h('h1', { id: 'h-set' }, 'Appearance'), h('p', { class: 'lead sm' }, 'Choose how Ghost looks. It changes at once and is remembered for your account on this computer. Each skin has its own layout as well as its own colours and type: where Home, the navigation and the panels sit. A skin never changes what a screen says or does, and every number it draws is from this computer.')),
      h('div', { class: 'sgroup' }, h('h2', { class: 'sgroup-h' }, 'Skin'), skinHost),
      h('div', { class: 'sgroup' }, h('h2', { class: 'sgroup-h' }, 'Colour and effects'),
        h('div', { class: 'scard' },
          row('Light or dark', 'Dark is the default for Ghost.', h('div', { class: 'stack-s' }, modeHost, modeNote)),
          row('Decorations', 'Dotted grids, scan lines, corner brackets and panel headers, where the skin has them. Colours, type and layout stay when this is off. Moving effects stop on their own when your computer asks for less motion.', decoBox.el),
          row('Start again', 'Return to the Mayfair skin with decorations on.', reset))),
      live);
  };
})();
