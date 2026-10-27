'use strict';
// Mayfair Ghost security connectors: runner for "connect to your own instance" adapters (MISP, OpenCTI, OpenSearch, Neo4j).
// CANONICAL SOURCE, copied to run.js in each adapter folder by sync.js. The server is never bundled and never guessed: the address and
// key come from <userData>/ghost/instances/<id>.json (written by the vault-ready helper), never from the page or the command line.
//   run.js --check                 exits 0 only if a valid instance config exists (the server itself is tested by the self-test)
//   run.js --action=ping           asks the instance for its version; "selftest passed" only if it answers as the right product
//   run.js --action=search --kind=... --indicator=...
const common = require('./common');
const tool = require('./tool.js');
const { SPEC } = tool;
const { ToolError, UsageError } = common;

async function call(cfg, req) {
  let r;
  try {
    r = await common.httpJson({ baseUrl: cfg.url, pathname: req.pathname, method: req.method || 'GET', body: req.body, headers: { ...common.authHeaders(cfg, SPEC), ...(req.headers || {}) }, allowSelfSigned: cfg.allowSelfSigned === true, timeoutMs: 20000 });
  } catch (e) {
    const code = e && e.code ? ` (${e.code})` : '';
    throw new ToolError(common.scrub(`could not reach the ${SPEC.tool} instance at ${new URL(cfg.url).host}${code}: ${(e && e.message) || 'error'}`, common.secretsOf(cfg)), 7);
  }
  if (r.status === 401 || r.status === 403) throw new ToolError(`the ${SPEC.tool} instance rejected the credentials (HTTP ${r.status})`, 8);
  if (r.status < 200 || r.status >= 300) throw new ToolError(common.scrub(`the ${SPEC.tool} instance answered HTTP ${r.status}: ${common.firstLine(r.text).slice(0, 120)}`, common.secretsOf(cfg)), 7);
  return r;
}

(async () => {
  try {
    const args = common.parseArgs();
    if (args.check !== undefined) { common.loadInstanceConfig(SPEC.id, SPEC); return; }
    const cfg = common.loadInstanceConfig(SPEC.id, SPEC);
    const secrets = common.secretsOf(cfg);
    const url = cfg.url.replace(/\/+$/, '');
    const action = args.action === undefined ? 'search' : String(args.action);
    const opts = { url, now: new Date().toISOString() };
    if (action === 'ping') {
      const res = tool.parsePing(await call(cfg, tool.pingRequest(cfg)), opts);
      for (const r of res) common.emit(r);
      common.emit(common.makeMk(SPEC, opts)('selftest', 'passed'));
      return;
    }
    if (action !== 'search') throw new UsageError('action must be ping or search');
    const input = tool.normalizeInput(args);
    common.progress(0.2, `asking your ${SPEC.tool} instance`);
    const resp = await call(cfg, tool.searchRequest(cfg, input));
    for (const r of tool.parseSearch(resp, { ...opts, input, cfg })) common.emit(JSON.parse(common.scrub(JSON.stringify(r), secrets)));
    common.progress(1, 'done');
  } catch (e) {
    process.stderr.write(((e && e.message) || String(e)).split('\n')[0] + '\n');
    process.exitCode = (e && e.exitCode) || 1;
  }
})();
