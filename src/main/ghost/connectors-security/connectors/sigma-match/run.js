'use strict';
// Mayfair Ghost security connectors: runner for the Sigma matcher (pure JavaScript, no external program).
// CANONICAL SOURCE, copied to run.js in the sigma-match connector folder by sync.js.
//   run.js --check                 exits 0 (nothing to install)
//   run.js --action=selftest       runs the built-in rule against built-in events; "selftest passed" only if the matcher behaves
//   run.js --rules=FILE --logs=FILE
const fs = require('node:fs');
const path = require('node:path');
const common = require('./common');
const tool = require('./tool.js');
const { SPEC } = tool;

function readCapped(p, max, what) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new common.UsageError(`${what} must be a picked file`);
  const st = fs.statSync(p);
  if (!st.isFile()) throw new common.UsageError(`${what} is not a file`);
  if (st.size > max) throw new common.UsageError(`${what} is larger than ${Math.round(max / 1048576)} MiB`);
  return fs.readFileSync(p, 'utf8');
}
(async () => {
  try {
    const args = common.parseArgs();
    if (args.check !== undefined) return;
    if (args.action === 'selftest') {
      const res = tool.selfTest();
      const mk = common.makeMk(SPEC, {});
      for (const r of res.filter((x) => x.entity.type === 'sigma-match')) common.emit(r);
      common.emit(mk('selftest', 'passed'));
      return;
    }
    const rules = readCapped(args.rules, 4 * 1024 * 1024, 'rules');
    const logs = readCapped(args.logs, 50 * 1024 * 1024, 'logs');
    common.progress(0.1, 'evaluating');
    for (const r of tool.parse({ rules, logs }, {})) common.emit(r);
    common.progress(1, 'done');
  } catch (e) {
    process.stderr.write(((e && e.message) || String(e)).split('\n')[0] + '\n');
    process.exitCode = (e && e.exitCode) || 1;
  }
})();
