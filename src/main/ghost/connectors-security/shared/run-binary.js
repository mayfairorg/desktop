'use strict';
// Mayfair Ghost security connectors: generic runner for a separate program (installed by the Ghost tool installer).
// CANONICAL SOURCE, copied to run.js in each binary-tool connector folder by sync.js. The tool-specific part is ./tool.js.
//   run.js --check[=name]         exit 0 only if the requirement holds (used by installRequirements)
//   run.js --action=selftest      runs the installed program in a harmless local mode and prints "selftest passed" only if it behaves
//   run.js --target=... (active)  runs the tool, prints one JSON result per line
const common = require('./common');
const tool = require('./tool.js');
const { SPEC } = tool;
const { emit, progress, UsageError, ToolError } = common;
const MAX_RESULTS = 4900;      // the runner accepts 5000

async function checkExtra(name) {
  const c = (SPEC.extraChecks || {})[name];
  if (!c) throw new UsageError('unknown check');
  const dir = common.makeRunDir(SPEC.id);
  try {
    const r = await common.runTool(c.argv[0], c.argv.slice(1), { cwd: dir, timeoutMs: 8000 });
    const text = r.stdout + '\n' + r.stderr;
    const m = c.re.exec(text);
    if (r.spawnError || r.code !== 0 || !m) throw new ToolError(`${c.argv[0]} was not found or did not answer`, 1);
    if (c.minMajor && Number(m[1]) < c.minMajor) throw new ToolError(`${c.argv[0]} ${m[1]} is too old (need ${c.minMajor} or newer)`, 1);
  } finally { common.removeDir(dir); }
}

async function selfTest() {
  const found = await common.locateTool(SPEC);
  const dir = common.makeRunDir(SPEC.id);
  try {
    const r = await common.runTool(found.exe, SPEC.versionArgs, { cwd: dir, timeoutMs: 20000, launcher: found.launcher });
    if (r.spawnError) throw new ToolError(`${SPEC.tool} could not start (${r.spawnError})`, 3);
    const m = SPEC.versionRe.exec(r.stdout + '\n' + r.stderr);
    if (!m || (r.code !== 0 && !SPEC.versionNonzeroOk)) throw new ToolError(`${SPEC.tool} did not report a version we recognise (exit ${r.code}); it is not the expected program`, 3);
    const mk = common.makeMk(SPEC, { toolVersion: m[1] });
    emit(mk('tool-version', `${SPEC.tool} ${m[1]}`, { raw: { args: SPEC.versionArgs } }));
    if (typeof tool.functionalSelfTest === 'function') {
      const extra = await tool.functionalSelfTest({ exe: found.exe, launcher: found.launcher, runDir: dir, mk, runTool: common.runTool });
      for (const e of extra) emit(e);
    }
    emit(mk('selftest', 'passed', { raw: { tool: SPEC.tool, version: m[1] } }));
  } finally { common.removeDir(dir); }
}

async function scan(args) {
  const input = tool.normalizeInput(args);           // typed, validated again here (never trust the caller)
  if (SPEC.scope === 'active') input.target = common.checkActiveTarget(args.target);
  const found = await common.locateTool(SPEC);
  const dir = common.makeRunDir(SPEC.id);
  try {
    const plan = await tool.buildArgs(input, { runDir: dir, resolveTarget: common.resolveTarget, found });
    progress(0.05, 'running: ' + [SPEC.tool, ...plan.argv].join(' '));
    const r = await common.runTool(found.exe, plan.argv, { cwd: plan.cwd || dir, timeoutMs: SPEC.timeoutMs || 540000, launcher: found.launcher });
    if (r.spawnError) throw new ToolError(`${SPEC.tool} could not start (${r.spawnError})`);
    if (r.timedOut) throw new ToolError(`${SPEC.tool} took too long and was stopped`);
    if (r.truncated) throw new ToolError(`${SPEC.tool} output is larger than the limit and was stopped`);
    const raw = plan.collect ? await plan.collect(r, dir) : r.stdout;
    if (r.code !== 0 && !SPEC.partialOk) {
      const why = common.firstLine(r.stderr) || common.firstLine(r.stdout) || 'no message';
      throw new ToolError(`${SPEC.tool} exited with code ${r.code}: ${why}`);
    }
    progress(0.9, 'reading the output');
    let results = tool.parse(raw, { toolVersion: found.version || undefined, input, plan, exitCode: r.code, stderr: r.stderr });
    if (r.code !== 0 && !results.length) throw new ToolError(`${SPEC.tool} exited with code ${r.code}: ${common.firstLine(r.stderr) || 'no output'}`);
    if (results.length > MAX_RESULTS) {
      const mk = common.makeMk(SPEC, { toolVersion: found.version || undefined });
      results = results.slice(0, MAX_RESULTS - 1);
      results.push(mk('output-truncated', `showing the first ${MAX_RESULTS - 1} results`, { confidence: 'uncertain', note: 'The tool produced more results than one job can hold; the rest were not recorded.' }));
    }
    for (const x of results) emit(x);
    if (r.code !== 0) progress(1, `${SPEC.tool} exited with code ${r.code}; results above are partial`); else progress(1, 'done');
  } finally { common.removeDir(dir); }
}

common.installSignalHandler();
(async () => {
  try {
    const args = common.parseArgs();
    if (args.check !== undefined) { if (args.check === true) await common.locateTool(SPEC); else await checkExtra(String(args.check)); return; }
    if (args.action === 'selftest') return await selfTest();
    await scan(args);
  } catch (e) {
    process.stderr.write(((e && e.message) || String(e)).split('\n')[0] + '\n');
    process.exitCode = (e && e.exitCode) || 1;
  }
})();
