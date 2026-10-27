'use strict';
// Mayfair Ghost passive modules (phase 1). Each module is both a library (run in-process with an injected fetch and the optional Ghost
// egress hook) and a connector: materialize() writes the connector folder (connector.json, run.js and the few library files it needs)
// that ConnectorManager validates, asks the user to approve, self-tests and runs through the normal runner.
const fs = require('node:fs');
const path = require('node:path');
const core = require('./lib/core');

const LIB = path.join(__dirname, 'lib');
const MODULES = ['dns-doh', 'rdap-domain', 'rdap-ip-asn', 'ct-crtsh', 'wayback-cdx', 'exif-meta', 'gdelt-doc', 'wikidata',
  'nasa-cmr', 'usgs-landsat', 'archivebox', 'exiftool', 'mediainfo', 'tesseract', 'ocrmypdf', 'tika', 'ffmpeg-frames', 'gdal-info', 'qgis-open',
  'gleif', 'sec-edgar', 'nominatim', 'overpass-query', 'nasa-gibs', 'earth-search-stac', 'gdelt-geo', 'common-crawl-index', 'rdns', 'cisa-kev', 'nvd', 'hash-file', 'stix-import', 'local-snapshot'].map((id) => require('./lib/' + id));
const byId = (id) => MODULES.find((m) => m.meta.id === id) || null;

function toManifest(meta) {
  const external = meta.network === 'keyless-external' || meta.network === 'rate-limited';
  const c = meta.client || {};
  const timeoutMs = external ? Math.min(600000, (c.timeoutMs || 15000) * Math.max(1, c.maxRequests || 1) + 15000) : Math.min(600000, (c.timeoutMs || 45000) + (meta.heavy ? 660000 : 15000));
  const fields = meta.inputs;
  return {
    id: meta.id, name: meta.name, version: meta.version, description: meta.description, capabilities: meta.capabilities,
    scope: meta.scope, network: meta.network,
    licence: { spdx: meta.licence.spdx, url: meta.licence.url, mode: meta.separateProgram ? 'separate-program' : 'bundled' },
    installRequirements: [{ name: "Mayfair's built-in Node runtime", check: ['@node', '-e', 'process.exit(0)'] }, ...(meta.program ? [{ name: meta.program + ' program', check: ['@node', 'run.js', '--locate'] }] : [])],
    command: { executable: '@node', args: ['run.js', ...fields.map((f) => `--${f.name}={${f.name}}`)], files: meta.files.map((f) => 'lib/' + f).concat('lib/' + meta.id + '.js') },
    input: { fields },
    output: { format: 'jsonl' },
    limits: { timeoutMs, maxOutputBytes: 4 * 1024 * 1024, maxMemoryMb: 256, maxConcurrent: meta.heavy ? 1 : 2 },
    permissions: [...(external ? ['network'] : []), ...(fields.some((f) => f.type === 'file') ? ['read-picked-file'] : []), ...(meta.separateProgram ? ['temp-files'] : [])],
    externalRestrictions: (external && (meta.hosts || []).length ? 'Contacts: ' + meta.hosts.join(', ') + '. ' : '') + meta.restrictions + (meta.dataTerms ? ' Data terms: ' + meta.dataTerms + '.' : ''),
    selfTest: meta.selfTest,
  };
}

// Writes <destRoot>/<id>/ and returns that folder. `prelude` is code placed first in run.js; production never passes it (tests use it
// to install a mock transport in the child process, so no test ever reaches the network).
function materialize(id, destRoot, { prelude = '' } = {}) {
  const mod = byId(id);
  if (!mod) throw new Error('unknown module: ' + id);
  const dir = path.join(destRoot, id);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  const m = toManifest(mod.meta);
  fs.writeFileSync(path.join(dir, 'connector.json'), JSON.stringify(m, null, 2));
  for (const f of new Set([...mod.meta.files, id + '.js'])) fs.copyFileSync(path.join(LIB, f), path.join(dir, 'lib', f));
  fs.writeFileSync(path.join(dir, 'run.js'), `'use strict';\n${prelude ? prelude + '\n' : ''}require('./lib/runtime').main(require('./lib/${id}'));\n`);
  return dir;
}

// Installs every module (or the named ones) into a ConnectorManager: validated and registered, NOT approved. The user approves each
// one in the native dialog, and nothing shows as ready until its own self-test has passed on this machine.
function installAll(manager, { ids = MODULES.map((m) => m.meta.id), stagingRoot = require('node:os').tmpdir(), prelude } = {}) {
  const stage = fs.mkdtempSync(path.join(stagingRoot, 'mf-ghost-modules-'));
  const out = [];
  try { for (const id of ids) out.push({ id, ...manager.register(materialize(id, stage, { prelude })) }); } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  return out;
}

// In-process run with an injected fetch and optional egress hook: {status, network, results, notes, ...}.
function runModule(id, input, opts = {}) {
  const mod = byId(id);
  if (!mod) throw new Error('unknown module: ' + id);
  return core.execute(mod, input, opts);
}
const describe = () => MODULES.map((m) => ({ id: m.meta.id, name: m.meta.name, scope: m.meta.scope, network: m.meta.network, hosts: m.meta.hosts }));

module.exports = { MODULES, byId, toManifest, materialize, installAll, runModule, describe, core };
