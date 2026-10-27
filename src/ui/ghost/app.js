'use strict';
// Ghost page bootstrap: ask main for the status, draw the start flow or the app, and follow status changes.
(function () {
  const GH = window.GH;
  let lastStage = null;
  function draw(st) {
    const root = document.getElementById('root');
    GH.status = st;
    if (st.stage === 'ready') {
      if (GH.mounted && lastStage === 'ready') { GH.updateBars(); return; }
      GH.mounted = true; lastStage = 'ready'; GH.mount(); return;
    }
    GH.mounted = false; lastStage = st.stage; GH.cs.close();
    if (GH.appearance) GH.appearance.apply(null);      // the start screens always use the default skin; a saved choice is read again once the vault is open
    GH.clear(root); root.append(GH.flow.view(st));
    const f = root.querySelector('[data-autofocus]') || root.querySelector('h1'); if (f) { if (!f.hasAttribute('tabindex') && f.tagName === 'H1') f.setAttribute('tabindex', '-1'); try { f.focus({ preventScroll: true }); } catch { /* ok */ } }
  }
  async function boot() {
    if (!GH.hasBridge) { GH.clear(document.getElementById('root')).append(GH.flow.noBridge()); return; }
    try { draw(await GH.call(GH.api.status)); } catch (e) { GH.clear(document.getElementById('root')).append(GH.h('main', { id: 'main', class: 'flow' }, GH.h('div', { class: 'flow-in' }, GH.h('div', { class: 'state' }, GH.icon('alert'), GH.h('h1', {}, 'Ghost did not start'), GH.h('p', {}, GH.errText(e)), GH.btn('Try again', { primary: true, onclick: boot }))))); return; }
    GH.api.onStatus((st) => draw(st));
    // Re-check access now and then, so a revoked account stops working without waiting for a restart.
    setInterval(() => { if (GH.mounted) GH.call(GH.api.entitlement.check).catch(() => {}); }, 30 * 60 * 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
