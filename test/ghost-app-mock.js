'use strict';
// A local stand-in for Mayfair ID and the Mayfair Cloud list. Loopback only. Used by the tests and the screenshot run.
const http = require('node:http');
const live = { servers: [] };
// opts.ent: what GET /api/platform/v1/ghost/entitlement answers (object, or status number). opts.pollsBeforeOk: pending answers before sign-in succeeds.
async function mockServer(opts = {}) {
  const st = { ent: opts.ent === undefined ? { status: 'approved', modules: {} } : opts.ent, polls: 0, pollsBeforeOk: opts.pollsBeforeOk === undefined ? 1 : opts.pollsBeforeOk, hits: [], index: opts.index === undefined ? { components: [] } : opts.index, refreshes: 0, down: false, accessTtl: opts.accessTtl || 900, badTokens: new Set() };
  const srv = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      st.hits.push(req.method + ' ' + req.url);
      const send = (code, obj) => { const t = obj === undefined ? '' : JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json' }); res.end(t); };
      if (st.down) { req.socket.destroy(); return; }
      const base = 'http://127.0.0.1:' + srv.address().port;
      const u = req.url.split('?')[0];
      if (u === '/.well-known/openid-configuration') return send(200, { issuer: base, device_authorization_endpoint: base + '/oauth/device_authorization', token_endpoint: base + '/oauth/token', userinfo_endpoint: base + '/oauth/userinfo' });
      if (u === '/oauth/device_authorization') return send(200, { device_code: 'dev-1', user_code: 'MAYF-1234', verification_uri: base + '/oauth/device', verification_uri_complete: base + '/oauth/device?c=MAYF-1234', expires_in: 600, interval: 1 });
      if (u === '/oauth/token') {
        const p = new URLSearchParams(body);
        if (p.get('grant_type') === 'refresh_token') { st.refreshes++; if (p.get('refresh_token') !== st.refresh) return send(400, { error: 'invalid_grant' }); st.refresh = 'r' + st.refreshes; st.access = 'a-r' + st.refreshes; return send(200, { access_token: st.access, refresh_token: st.refresh, expires_in: st.accessTtl }); }
        if (st.polls++ < st.pollsBeforeOk) return send(400, { error: 'authorization_pending' });
        st.access = 'a0'; st.refresh = 'r0'; return send(200, { access_token: 'a0', refresh_token: 'r0', expires_in: st.accessTtl });
      }
      if (u === '/oauth/userinfo') return send(200, { sub: 'user-1', email: 'analyst@example.org', name: 'Test Analyst' });
      if (u === '/api/platform/v1/ghost/entitlement') { if ((req.headers.authorization || '') !== 'Bearer ' + st.access) return send(401, { error: 'invalid_token' }); if (typeof st.ent === 'number') return send(st.ent); return send(200, st.ent); }
      if (u === '/ghost/index.json') { if (st.index === 404) return send(404, { error: 'none' }); return send(200, st.index); }
      send(404, { error: 'not-found' });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  st.base = 'http://127.0.0.1:' + srv.address().port; st.close = () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); });
  live.servers.push(st);
  return st;
}

module.exports = { mockServer, live };
