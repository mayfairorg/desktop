'use strict';
// Vault-ready config for "connect to your own instance" adapters (MISP, OpenCTI, OpenSearch, Neo4j). The address and key are supplied by the user
// and stored in <userData>/ghost/instances/<id>.json, owner-only (0600), in the shape the adapters read. Nothing is bundled or defaulted.
// "Vault-ready": auth may hold {vaultRef: "vault:<name>"} instead of a key, so the Ghost vault can take over storage later without changing the
// adapters; this build cannot open vault references yet and the adapter says so. The key is never returned by describe() and never logged.
const fs = require('node:fs');
const path = require('node:path');
const common = require('./shared/common');

const AUTH = { 'misp-client': ['api-key'], 'opencti-client': ['bearer'], 'opensearch-client': ['none', 'basic', 'api-key', 'bearer'], 'neo4j-client': ['none', 'basic'] };
const dirOf = (root) => path.join(root, 'ghost', 'instances');
const fail = (error, message, errors) => ({ ok: false, error, message, ...(errors ? { errors } : {}) });

function save(root, id, cfg) {
  if (!AUTH[id]) return fail('unknown-adapter', 'That is not an instance adapter.');
  const v = common.validateInstanceConfig(cfg, { authTypes: AUTH[id] });
  if (!v.ok) return fail('invalid-config', v.errors[0], v.errors);
  fs.mkdirSync(dirOf(root), { recursive: true, mode: 0o700 });
  const p = path.join(dirOf(root), id + '.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* not supported on this file system */ }
  fs.renameSync(tmp, p);
  return { ok: true, config: describe(root, id) };
}
// Never includes a secret.
function describe(root, id) {
  if (!AUTH[id]) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dirOf(root), id + '.json'), 'utf8'));
    return { configured: true, url: j.url, authType: j.auth && j.auth.type, hasSecret: !!(j.auth && (j.auth.key || j.auth.token || j.auth.password || j.auth.vaultRef)), usesVault: !!(j.auth && j.auth.vaultRef), database: j.database, index: j.index };
  } catch { return { configured: false }; }
}
function remove(root, id) {
  if (!AUTH[id]) return fail('unknown-adapter', 'That is not an instance adapter.');
  try { fs.rmSync(path.join(dirOf(root), id + '.json'), { force: true }); } catch { /* gone */ }
  return { ok: true };
}
module.exports = { AUTH, save, describe, remove, dirOf };
