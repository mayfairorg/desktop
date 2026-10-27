'use strict';
// Ghost case service: the one case that is open, its undo history, autosave into the vault (through main), and "add to case" for the module screens.
// The page holds the decrypted case in memory only. Saving sends the JSON to main, which validates it and seals it in the vault.
(function () {
  const GH = window.GH, M = window.GhostCase;
  GH.caseUnsourced = M.isUnsourced;
  const subs = new Set();
  const S = { c: null, hist: null, save: { state: 'idle', at: null, error: null }, dirty: false };
  const notify = (why) => { for (const f of subs) { try { f(why); } catch { /* listener failed */ } } };
  GH.cs = {
    state: S,
    on(f) { subs.add(f); return () => subs.delete(f); },
    current: () => S.c,
    hist: () => S.hist,
    async list() { return GH.call(GH.api.cases.list); },
    async open(id) {
      await this.flush();
      const text = await GH.call(GH.api.cases.get, id);
      let c; try { c = JSON.parse(text); } catch { throw new Error('That case could not be read.'); }
      M.normalize(c); S.c = c; S.hist = new M.History(c); M.layout(c); S.dirty = false; S.save = { state: 'saved', at: c.updated, error: null }; notify('open'); return c;
    },
    async create(title) {
      await this.flush();
      const r = await GH.call(GH.api.cases.create, title || 'Untitled case');
      const c = JSON.parse(r.json); M.normalize(c); S.c = c; S.hist = new M.History(c); S.dirty = false; S.save = { state: 'saved', at: c.updated, error: null }; notify('open'); return c;
    },
    async remove(id) { await GH.call(GH.api.cases.delete, id); if (S.c && S.c.id === id) { S.c = null; S.hist = null; S.dirty = false; notify('close'); } },
    close() { S.c = null; S.hist = null; S.dirty = false; notify('close'); },
    // Runs a change with undo. opts: {group, windowMs, silent}. fn(c) may return a value.
    mutate(label, fn, opts) {
      if (!S.c) throw new Error('Open a case first.');
      const r = S.hist.run(label, fn, opts || {}); M.touch(S.c); S.dirty = true; GH.cs._schedule(); if (!(opts && opts.silent)) notify('change'); return r;
    },
    // Direct change that is already covered by an earlier history step (a drag in progress). Saves later.
    touched() { M.touch(S.c); S.dirty = true; GH.cs._schedule(); },
    undo() { if (!S.hist || !S.hist.canUndo()) return null; const l = S.hist.undo(); S.dirty = true; GH.cs._schedule(); notify('change'); GH.say('Undid: ' + l); return l; },
    redo() { if (!S.hist || !S.hist.canRedo()) return null; const l = S.hist.redo(); S.dirty = true; GH.cs._schedule(); notify('change'); GH.say('Redid: ' + l); return l; },
    _schedule() { S.save = { ...S.save, state: 'pending' }; GH.cs._debounced(); notify('save'); },
    async flush() {
      GH.cs._debounced.cancel();
      if (!S.c || !S.dirty) return true;
      const c = S.c; S.save = { state: 'saving', at: S.save.at, error: null }; notify('save');
      try { const r = await GH.call(GH.api.cases.put, c.id, JSON.stringify(c)); if (S.c === c) { S.dirty = false; S.save = { state: 'saved', at: r.savedAt, error: null }; } }
      catch (e) { S.save = { state: 'error', at: S.save.at, error: GH.errText(e) }; }
      notify('save'); return S.save.state === 'saved';
    },
    // Adds what a connector run returned. Asks which case when none is open. -> ingest counts, or null when the person cancelled.
    async addResults({ connector, query, results }) {
      if (!S.c && !(await GH.cs.pickCase())) return null;
      const raw = await M.hashRaw(results);
      const meta = { id: connector.id, version: connector.version, licence: connector.licence && connector.licence.spdx ? connector.licence.spdx : '', attribution: connector.externalRestrictions && connector.externalRestrictions !== 'None.' && /attribution|credit|contains data/i.test(connector.externalRestrictions) ? connector.externalRestrictions.slice(0, 280) : '' };
      const out = GH.cs.mutate('Add results from ' + connector.id, (c) => { const r = M.ingest(c, { connector: meta, query, results, rawSha256: raw }); M.layout(c); return r; });
      GH.toast(out.added + out.merged ? 'Added to "' + S.c.title + '": ' + GH.plural(out.added, 'new entity', 'new entities') + (out.merged ? ', ' + out.merged + ' merged' : '') + '.' : 'Nothing new to add.');
      if (out.withheld) GH.toast(GH.plural(out.withheld, 'result') + ' withheld: Ghost does not store details about private people.');
      return out;
    },
    // A small dialog: pick an existing case or start a new one. -> true when a case is now open.
    async pickCase() {
      let list = []; try { list = await GH.cs.list(); } catch (e) { GH.toast(GH.errText(e)); return false; }
      const sel = GH.h('select', { id: 'pc-sel', 'data-autofocus': '' }, GH.h('option', { value: '' }, 'New case'), list.map((c) => GH.h('option', { value: c.id }, c.title + ' (' + GH.plural(c.entities, 'entity', 'entities') + ')')));
      const name = GH.h('input', { type: 'text', id: 'pc-name', value: 'Untitled case', maxlength: '200' });
      const r = await GH.dialog({ title: 'Add to which case?', sub: 'Everything you add keeps its source.', body: GH.h('div', { class: 'stack' }, GH.field('Case', sel), GH.field('Name of the new case', name)), actions: [{ label: 'Cancel', value: false }, { label: 'Use this case', primary: true, value: true }] });
      if (r !== true) return false;
      try { if (sel.value) await GH.cs.open(sel.value); else await GH.cs.create(name.value.trim() || 'Untitled case'); return true; } catch (e) { GH.toast(GH.errText(e)); return false; }
    },
  };
  GH.cs._debounced = GH.debounce(() => { GH.cs.flush(); }, 700);
  window.addEventListener('beforeunload', () => { if (S.dirty) GH.cs.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && S.dirty) GH.cs.flush(); });
})();
