'use strict';
// Ghost data for the skin layouts. Everything a layout draws comes from here, and everything here comes from this computer:
// the connector list, the cases in the vault, the open case, the lookups run in this window and the scan log.
// Nothing is sampled or filled in: where there is nothing yet, the value is empty and the layout says so.
(function () {
  const GH = window.GH, L = window.GhostLay;

  // The entity everyone is looking at (tree, map, tables, board and the detail panel share it).
  const selSubs = new Set();
  GH.sel = {
    id: null,
    get() { const c = GH.cs.current(); return this.id && c && c.entities[this.id] ? this.id : null; },
    set(id, from) { if (this.id === id) return; this.id = id || null; for (const f of [...selSubs]) { try { f(this.id, from); } catch { /* listener failed */ } } },
    on(f) { selSubs.add(f); return () => selSubs.delete(f); },
  };
  GH.cs.on((why) => { if (why === 'open' || why === 'close') GH.sel.set(null, 'case'); else if (why === 'change' && GH.sel.id && !GH.sel.get()) GH.sel.set(null, 'case'); });

  // The lookups run in this window. Memory only: nothing about what was looked up is written anywhere outside the vault.
  const jobSubs = new Set(); let jobSeq = 0;
  GH.jobs = {
    items: [],
    on(f) { jobSubs.add(f); return () => jobSubs.delete(f); },
    _ping() { for (const f of [...jobSubs]) { try { f(); } catch { /* listener failed */ } } },
    start(connector, query) { const j = { id: 'j' + (++jobSeq), connector, query: String(query || '').slice(0, 120), status: 'running', startedAt: Date.now(), finishedAt: null, results: undefined, progress: 0 }; this.items.unshift(j); if (this.items.length > 60) this.items.length = 60; this._ping(); return j; },
    update(j, patch) { Object.assign(j, patch); this._ping(); },
    running() { return this.items.filter((j) => j.status === 'running' || j.status === 'queued'); },
  };

  // One call gives a layout everything it draws. Each piece fails on its own: a failure leaves that piece empty, never faked.
  let snapAt = 0, snapP = null;
  GH.data = {
    async snapshot(force) {
      if (!force && snapP && Date.now() - snapAt < 1500) return snapP;
      snapAt = Date.now();
      snapP = (async () => {
        const now = Date.now(), st = GH.status || {};
        const [conns, cases, scope, scopeActive] = await Promise.all([
          GH.conn.list(!!force).catch(() => null),
          GH.cs.list().catch(() => null),
          GH.call(GH.api.scope.log, 60).catch(() => null),
          GH.call(GH.api.scope.active).catch(() => null),
        ]);
        const cur = GH.cs.current(), stats = L.connStats(conns), health = L.caseHealth(cur), pins = L.placePins(cur);
        const save = GH.cs.state.save;
        const acts = L.activity({ jobs: GH.jobs.items, conns: conns || [], scopeLog: scope && scope.entries, save: cur ? save : null }, 80);
        const times = [...GH.jobs.items.map((j) => j.startedAt), ...acts.map((a) => a.t)];
        return {
          now, status: st, vault: st.vault || null, account: st.account || null, entitlement: st.entitlement || null,
          conns, stats, cases, current: cur, health, pins, links: L.placeLinks(cur), satellites: L.placeSatellites(cur),
          jobs: GH.jobs.items.slice(), lookups: L.lookups(GH.jobs.items, cur), activity: acts, days: L.dayBuckets(times, 14, now),
          scopeVerify: scope && scope.verify || null, scopeLog: scope && scope.entries || null, scopeActive: Array.isArray(scopeActive) ? scopeActive : null, entities: L.topEntities(cur, 40), save,
        };
      })();
      return snapP;
    },
    bust() { snapP = null; snapAt = 0; },
    // Call fn(why) whenever the open case, a lookup, the connector list or the selection changes (why is 'sel' for a selection only, otherwise 'data').
    // Stops once host leaves the page. fn is not called at the start: the layout draws once itself.
    watch(host, fn, opts = {}) {
      let t = null, live = true, pending = null;
      const run = (w) => { if (!live) return; if (!host.isConnected) { stop(); return; } if (w !== 'sel') GH.data.bust(); fn(w); };
      const soon = (w) => { pending = pending === 'data' ? 'data' : w; clearTimeout(t); t = setTimeout(() => { const x = pending; pending = null; run(x); }, 120); };
      const offs = [GH.cs.on((why) => { if (why !== 'save' || opts.save) soon('data'); }), GH.jobs.on(() => soon('data'))];
      if (opts.sel) offs.push(GH.sel.on(() => soon('sel')));
      function stop() { live = false; clearTimeout(t); offs.forEach((o) => o()); }
      return stop;
    },
  };
})();
