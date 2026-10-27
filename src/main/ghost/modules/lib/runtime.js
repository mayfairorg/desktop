'use strict';
// Mayfair Ghost passive modules: the entry point shared by every generated connector (run.js calls main(module)).
// Output: JSON lines on stdout (progress and results). Diagnostics and the honest network state go to stderr.
// Exit codes: 0 ok, 2 bad input, 69 service unavailable, 70 internal, 75 rate-limited, 76 bad response, 77 blocked by the egress rules.
const { execute, parseArgs, ModuleError, EXIT } = require('./core');

async function main(mod, { argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr, exit = (c) => { process.exitCode = c; }, fetch, egress, tools } = {}) {
  // install requirement check for a tool connector: is the separate program there?
  if (mod.meta.program && argv.length === 1 && argv[0] === '--locate') {
    const t = tools || require('./tool-run').realTools();
    const found = mod.locate ? mod.locate(t) : (mod.meta.programNames ? t.find(mod.meta.programNames) : null);
    if (!found) { stderr.write(`${mod.meta.program} is not installed\n`); return exit(3); }
    return exit(0);
  }
  let input;
  try { input = parseArgs(argv, mod.meta.inputs); } catch (e) {
    stderr.write((e instanceof ModuleError ? 'bad-input: ' + e.message : 'internal: ' + e.message) + '\n');
    return exit(EXIT.badInput);
  }
  const lastP = { t: 0 };
  const r = await execute(mod, input, {
    fetch, egress, tools,
    onResult: (line) => stdout.write(JSON.stringify(line) + '\n'),
    onProgress: (p, message) => { const t = Date.now(); if (t - lastP.t < 100 && p < 1) return; lastP.t = t; stdout.write(JSON.stringify({ progress: p, ...(message ? { message } : {}) }) + '\n'); },
  });
  if (r.status !== 'ok') stderr.write(`${r.status}: ${r.message}\n`);   // first line: the runner shows it as the failure reason
  for (const n of r.notes) stderr.write('note: ' + n + '\n');
  if (r.dropped) stderr.write(`note: ${r.dropped} personal or out-of-scope value(s) withheld\n`);
  stderr.write(`network: ${r.network}${r.requests ? ` (${r.requests} request${r.requests === 1 ? '' : 's'})` : ''}\n`);
  return exit(r.exitCode);
}
module.exports = { main };
