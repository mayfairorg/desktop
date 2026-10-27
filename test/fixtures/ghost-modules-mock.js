'use strict';
// A mock transport for the Ghost module tests: no test reaches the network. Routes come from ghost-modules.json (hand-labelled data, all
// invented). A route matches on host, path and a subset of query parameters; the first match answers. An unmatched request throws and is
// recorded, and tests assert the list stays empty.
function makeFetch(fixtures, { log = [], unmocked = [], overrides = [] } = {}) {
  const routes = [...overrides, ...fixtures.routes];
  const fn = async (input, init = {}) => {
    const u = new URL(String(input));
    log.push(u.href);
    if (init.signal && init.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    for (const r of routes) {
      const m = r.match;
      if (m.host !== u.hostname) continue;
      if (m.path !== undefined && m.path !== u.pathname) continue;
      if (m.pathPrefix !== undefined && !u.pathname.startsWith(m.pathPrefix)) continue;
      if (m.query && !Object.entries(m.query).every(([k, v]) => (v === null ? !u.searchParams.has(k) : u.searchParams.get(k) === v))) continue;
      if (r.hang) return new Promise((_, rej) => { if (init.signal) init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
      if (r.throw) throw new Error(r.throw);
      const body = r.json !== undefined ? JSON.stringify(r.json) : (r.text !== undefined ? r.text : '');
      return new Response(r.status === 204 ? null : body, { status: r.status || 200, headers: r.headers || {} });
    }
    unmocked.push(u.href);
    throw new Error('unmocked request: ' + u.href);
  };
  fn.log = log; fn.unmocked = unmocked;
  return fn;
}
module.exports = { makeFetch };
