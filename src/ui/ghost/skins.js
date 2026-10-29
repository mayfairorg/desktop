'use strict';
// Ghost skins: the list the picker shows and the checks the vault record must pass. Data and two pure helpers, so the window and the main process share one list.
// A skin is a set of CSS variables (skins.css, selected by the data-skin attribute on <html>) and a layout: where things sit on Home, in the frame and on the module screens.
// A layout changes where and how things are drawn. It never changes what a screen says or does, and it only ever draws real data.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GhostSkins = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  // dark: true means the skin has no light version, so the light/dark switch is off while it is on.
  // layout: how the window is arranged. 'sidebar' is the Mayfair rail; the others each have their own frame, home and module screens (layouts-*.js).
  const SKINS = [
    { id: 'mayfair', label: 'Mayfair', layout: 'sidebar', dark: false, blurb: 'The same look as Mayfair Settings and Files: a sidebar and soft cards. Follows the light or dark choice.' },
    { id: 'terminal', label: 'Terminal green', layout: 'panel-grid', dark: true, blurb: 'A grid of bordered panels: jobs, connector gauges, case files, an activity log and a large vault status. Green on black.' },
    { id: 'hud', label: 'Cyan HUD', layout: 'ring-hud', dark: true, blurb: 'A status ring in the middle, stat panels either side, an activity chart and a sweep. Corner brackets on every card.' },
    { id: 'mono', label: 'Mono minimal', layout: 'single-column', dark: true, blurb: 'One column of large fixed-width type on a dotted page, a big search box and lookups drawn as a character grid.' },
    { id: 'shell', label: 'Shell', layout: 'menu-shell', dark: true, blurb: 'A command-line session: a block-letter banner, a status line, a prompt to look something up and a boxed menu of tool categories you move through with the arrow keys.' },
    { id: 'ops', label: 'Operations', layout: 'console', dark: true, blurb: 'Module tabs across the top, a case tree on the left, a map in the middle with tables below and a detail panel on the right.' },
  ];
  const DEFAULT = 'mayfair';
  const IDS = SKINS.map((s) => s.id);
  const THEMES = ['dark', 'light'];
  const byId = (id) => SKINS.find((s) => s.id === id) || null;
  // Anything that is not a known skin or theme falls back to the default. Used on read (the page) and on write (main).
  const clean = (p) => { const o = p && typeof p === 'object' ? p : {}; return { skin: IDS.includes(o.skin) ? o.skin : DEFAULT, theme: THEMES.includes(o.theme) ? o.theme : 'dark', deco: o.deco === false ? false : true }; };
  // The theme that is really drawn: a dark-only skin always shows dark.
  const effectiveTheme = (p) => { const c = clean(p); return byId(c.skin).dark ? 'dark' : c.theme; };
  return { SKINS, IDS, DEFAULT, THEMES, byId, clean, effectiveTheme };
});
