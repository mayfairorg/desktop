'use strict';
// Copies the shared helper and the right runner into every connector folder (a connector folder is installed on its own, so it must be
// self-contained). `node sync.js` writes; `node sync.js --check` exits 1 if any copy differs (the test suite runs the same check).
const fs = require('node:fs');
const path = require('node:path');

const ADAPTERS = ['misp-client', 'opencti-client', 'opensearch-client', 'neo4j-client'];
const SIGMA = ['sigma-match'];
const dir = __dirname;
const runnerFor = (id) => (SIGMA.includes(id) ? 'run-sigma.js' : ADAPTERS.includes(id) ? 'run-adapter.js' : 'run-binary.js');
const ids = () => fs.readdirSync(path.join(dir, 'connectors'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

// Returns the list of files that differ from the shared source (and writes them unless check is true).
function sync({ check = false } = {}) {
  const diffs = [];
  for (const id of ids()) {
    for (const [src, dst] of [['common.js', 'common.js'], [runnerFor(id), 'run.js']]) {
      const want = fs.readFileSync(path.join(dir, 'shared', src));
      const p = path.join(dir, 'connectors', id, dst);
      let have = null; try { have = fs.readFileSync(p); } catch { /* missing */ }
      if (!have || !have.equals(want)) { diffs.push(`${id}/${dst}`); if (!check) fs.writeFileSync(p, want); }
    }
  }
  return diffs;
}
if (require.main === module) {
  const check = process.argv.includes('--check');
  const d = sync({ check });
  if (check && d.length) { console.error('out of date: ' + d.join(', ')); process.exit(1); }
  console.log(check ? 'in sync' : `updated ${d.length} file(s)`);
}
module.exports = { sync, ids, runnerFor, ADAPTERS, SIGMA };
