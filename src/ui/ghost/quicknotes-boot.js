'use strict';
// Quick notes pop-out window: ask main which case and theme to open with, then draw the notes. This window has its own small bridge (quicknotes-preload.js).
(function () {
  const GH = window.GH;
  async function boot() {
    const root = document.getElementById('root');
    if (!GH.hasBridge || !GH.api.notes) { root.append(GH.h('main', { class: 'state' }, GH.h('h1', {}, 'Quick notes'), GH.h('p', {}, 'This window needs Mayfair Ghost.'))); return; }
    let info = { scope: 'inbox', theme: 'dark', onTop: true };
    try { info = { ...info, ...(await GH.call(GH.api.notes.popout.info)) }; } catch { /* the defaults are fine */ }
    document.documentElement.setAttribute('data-theme', info.theme === 'light' ? 'light' : 'dark');
    GH.qn.mountStandalone(root, info);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
