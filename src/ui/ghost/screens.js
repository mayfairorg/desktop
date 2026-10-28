'use strict';
// Ghost screens: Home, the case list and Tool Integrations. The Workspace, the results and the tool pages are in workspace.js and results.js.
(function () {
  const GH = window.GH, h = GH.h;

  // connector list, cached for a few seconds so several screens can ask
  let cache = null, cacheAt = 0;
  GH.conn = {
    async list(force) { if (!force && cache && Date.now() - cacheAt < 4000) return cache; cache = await GH.call(GH.api.connectors.list); cacheAt = Date.now(); return cache; },
    bust() { cache = null; },
    // the installed connector for a wanted id, matching on id or on the capability name `ghost-<module id>`
    find(list, id) { return list.find((c) => c.id === id) || null; },
    forModule(list, m) { const known = new Set(m.wants.map((w) => w[0])); const extra = list.filter((c) => !known.has(c.id) && (c.capabilities || []).includes('ghost-' + m.id)); return { wanted: m.wants.map(([id, label]) => ({ id, label, entry: GH.conn.find(list, id) })), extra }; },
  };

  // Home. A skin layout has its own Home (a dashboard of this computer); Mayfair's Home is the Workspace: the master search, the tools and the last searches.
  GH.routes.home = async () => {
    const Lx = GH.layout && GH.layout(); if (Lx && Lx.home) return Lx.home();
    return GH.routes.workspace();
  };
  // The old module index is the tool index now.
  GH.routes.modules = async () => GH.routes.tool('');

  // ---------- case list ----------
  GH.routes.case = async (id) => {
    if (id) return GH.routes.board(id);
    let list = [], error = null; try { list = await GH.cs.list(); } catch (e) { error = GH.errText(e); }
    const host = h('div', {}), name = h('input', { type: 'text', id: 'nc-name', value: '', maxlength: '200', placeholder: 'Name of the case', 'aria-label': 'Name of the new case' });
    const create = async (ev) => { ev.preventDefault(); try { const c = await GH.cs.create(name.value.trim() || 'Untitled case'); GH.go('case', c.id); } catch (e) { GH.toast(GH.errText(e)); } };
    const draw = (rows) => {
      GH.clear(host);
      if (error) { host.append(h('div', { class: 'state' }, GH.icon('alert'), h('h2', {}, 'Cases could not be read'), h('p', {}, error), GH.btn('Try again', { onclick: GH.render }))); return; }
      if (!rows.length) { host.append(h('div', { class: 'state' }, GH.icon('board'), h('h2', {}, 'No cases yet'), h('p', {}, 'A case holds what you find, with the source of every item. Start an empty one here, or add results from any module.'))); return; }
      host.append(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Case', 'Entities', 'Sources', 'Changed', ''].map((t, i) => h('th', { scope: 'col', class: i > 0 && i < 3 ? 'r' : '' }, t)))),
        h('tbody', {}, rows.map((c) => h('tr', {}, h('td', {}, h('a', { class: 'link', href: GH.href('case', c.id) }, c.title)), h('td', { class: 'r' }, String(c.entities)), h('td', { class: 'r' }, String(c.sources)), h('td', { class: 'mono mute' }, GH.fmtTime(c.updated)),
          h('td', { class: 'r' }, GH.btn('', { icon: 'trash', ghost: true, title: 'Delete ' + c.title, onclick: async () => { if (await GH.confirm('Delete this case?', '"' + c.title + '" and its backups are overwritten and removed from your vault. This cannot be undone.', 'Delete case', true)) { try { await GH.cs.remove(c.id); GH.render(); } catch (e) { GH.toast(GH.errText(e)); } } } }))))))));
    };
    draw(list);
    return h('section', { class: 'view' }, h('div', { class: 'case-head' }, h('div', { class: 'case-t' }, h('p', { class: 'eyebrow mono' }, 'CASE BOARD'), h('h1', {}, 'Your cases'), h('p', { class: 'meta mono' }, GH.icon('lock'), ' Sealed in your Ghost vault on this computer')),
      h('form', { class: 'case-a', onsubmit: create }, name, GH.btn('New case', { primary: true, type: 'submit', icon: 'plus' }))), host);
  };

  // ---------- Tool Integrations ----------
  GH.routes.tools = async () => {
    const host = h('div', { class: 'stack' }, h('div', { class: 'skel' }, h('i', {}), h('i', {})));
    const draw = async (force) => {
      let list; try { list = await GH.conn.list(force); } catch (e) { GH.clear(host); host.append(h('div', { class: 'state' }, GH.icon('alert'), h('h2', {}, 'Tools could not be listed'), h('p', {}, GH.errText(e)), GH.btn('Try again', { onclick: () => draw(true) }))); return; }
      GH.clear(host);
      if (!list.length) { host.append(h('div', { class: 'state' }, GH.icon('tool'), h('h2', {}, 'No connectors are installed'), h('p', {}, 'Connectors are separate programs with a manifest. Modules show which ones they look for. Nothing is shown as ready until its own self-test passes on this computer.'))); return; }
      // The lookups that ship with Mayfair are ready on their own and have their own pages; this screen is for the tools you add yourself and the security tools you approve.
      const B = window.GhostModules.BUILTIN, own = list.filter((c) => !B.includes(c.id)), shipped = list.length - own.length;
      if (shipped) host.append(h('p', { class: 'flow-note' }, GH.icon('check'), h('span', {}, GH.plural(shipped, 'lookup') + ' that ship with Mayfair work without approval. ', h('a', { class: 'link', href: GH.href('tool') }, 'Open them in All tools'), '.')));
      if (!own.length) { host.append(h('div', { class: 'state' }, GH.icon('tool'), h('h2', {}, 'No tools of your own yet'), h('p', {}, 'Tools you add yourself, and the security tools, appear here and ask for your approval in a native window before they run.'))); return; }
      host.append(h('div', { class: 'cards' }, own.map((c) => GH.connectorCard({ entry: c, label: c.name, onChange: () => draw(true), runnable: false }))));
    };
    draw(false);
    return h('section', { class: 'view' }, h('div', { class: 'case-head' }, h('div', { class: 'case-t' }, h('p', { class: 'eyebrow mono' }, 'TOOLS'), h('h1', {}, 'Tool Integrations'), h('p', { class: 'lead sm' }, 'The tools you add yourself and the security tools: what each one needs, whether it passed its own test, and what it may do. You approve these in a native dialog; Ghost cannot approve for you. Mayfair\'s own lookups need no approval.')),
      h('div', { class: 'case-a' }, GH.btn('Open the full page in Mayfair', { icon: 'link', onclick: async () => { try { await GH.call(GH.api.toolIntegrations.open); } catch (e) { GH.toast(GH.errText(e)); } } }), GH.btn('Terminal', { icon: 'term', onclick: GH.openTerminal }))), host);
  };
})();
