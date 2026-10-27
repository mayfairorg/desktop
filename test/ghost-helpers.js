'use strict';
// Shared by the ghost-*.test.js files: a throw-away userData folder, a connector built from a small script, and a ready manager + runner.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ConnectorManager } = require('../src/main/ghost/manager');
const { JobRunner } = require('../src/main/ghost/runner');
const { GhostLog } = require('../src/main/ghost/logger');
const { PickStore } = require('../src/main/ghost/picks');

const tmp = (p = 'mfd-ghost-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A test connector that can misbehave in a chosen way (field "mode").
const SCRIPT = `
const { spawn } = require('node:child_process');
const arg = (n) => { const p = '--' + n + '='; const a = process.argv.slice(2).find((x) => x.startsWith(p)); return a === undefined ? undefined : a.slice(p.length); };
const mode = arg('mode'), text = arg('text');
const res = (value, extra) => process.stdout.write(JSON.stringify({ entity: { type: 'note', value: String(value) }, source: { tool: 't', connector: process.env.MF_CONNECTOR_ID, version: '1.0.0' }, observedAt: new Date().toISOString(), confidence: 'confirmed', ...(extra || {}) }) + '\\n');
const hang = () => setTimeout(() => {}, 60000);
if (mode === 'ok') { res('one'); res('two'); }
else if (mode === 'progress') { console.log(JSON.stringify({ progress: 0.5, message: 'half' })); setTimeout(() => res('x'), 300); }
else if (mode === 'sleep') { res('started'); hang(); }
else if (mode === 'spam') { const s = 'x'.repeat(1000); for (let i = 0; i < 3000; i++) process.stdout.write(s + '\\n'); hang(); }
else if (mode === 'badjson') { process.stdout.write('not json at all\\n'); res('after'); }
else if (mode === 'invalid') { process.stdout.write(JSON.stringify({ entity: { type: 'note', value: 'v' } }) + '\\n'); }
else if (mode === 'env') { res(Object.keys(process.env).sort().join(',')); }
else if (mode === 'echo') { res(text); }
else if (mode === 'longline') { process.stdout.write('y'.repeat(200000) + '\\n'); res('after'); }
else if (mode === 'fail') { process.stderr.write('boom\\n'); process.exit(3); }
else if (mode === 'children') { const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore', env: { ELECTRON_RUN_AS_NODE: '1' } }); res(c.pid); hang(); }
else if (mode === 'mem') { const b = Buffer.alloc(300 * 1024 * 1024, 1); res(b.length); hang(); }
else if (mode === 'stderr') { process.stderr.write('e'.repeat(100000)); res('done'); }
else if (mode === 'future') { res('f', { observedAt: '2999-01-01T00:00:00Z' }); }
else if (mode === 'wrongsource') { res('w', { source: { tool: 't', connector: 'someone-else', version: '1' } }); }
else if (mode === 'bigraw') { res('r', { raw: { blob: 'z'.repeat(50000) } }); }
else if (mode === 'uncertain') { res('u', { confidence: 'uncertain' }); }
`;

function baseManifest(over = {}) {
  return {
    id: 'test-conn', name: 'Test connector', version: '1.0.0', description: 'A connector used by the tests.',
    capabilities: ['testing'], scope: 'local', network: 'local',
    licence: { spdx: 'MIT', url: 'https://example.invalid/mit', mode: 'bundled' },
    installRequirements: [],
    command: { executable: '@node', args: ['run.js', '--mode={mode}', '--text={text}'] },
    input: { fields: [
      { name: 'mode', type: 'enum', values: ['ok', 'progress', 'sleep', 'spam', 'badjson', 'invalid', 'env', 'echo', 'longline', 'fail', 'children', 'mem', 'stderr', 'future', 'wrongsource', 'bigraw', 'uncertain'] },
      { name: 'text', type: 'string', required: false, maxLength: 4096 },
    ] },
    output: { format: 'jsonl' },
    limits: { timeoutMs: 15000, maxOutputBytes: 1048576, maxConcurrent: 2 },
    permissions: [], externalRestrictions: 'None.',
    selfTest: { input: { mode: 'ok' }, expect: { minResults: 2, contains: [{ type: 'note', value: 'one' }] } },
    ...over,
  };
}
// Writes a connector folder (connector.json + run.js) into a fresh staging folder and returns its path.
function stage(over = {}, { script = SCRIPT, extra = {} } = {}) {
  const dir = tmp('mfd-stage-');
  fs.writeFileSync(path.join(dir, 'connector.json'), JSON.stringify(baseManifest(over), null, 2));
  fs.writeFileSync(path.join(dir, 'run.js'), script);
  for (const [k, v] of Object.entries(extra)) { fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); fs.writeFileSync(path.join(dir, k), v); }
  return dir;
}
// A manager and runner on a fresh userData. answer.value is what the (fake) native dialog replies.
function context({ maxHistory, globalMax } = {}) {
  const root = tmp();
  const answer = { value: true, calls: [] };
  const events = [];
  const log = new GhostLog(path.join(root, 'ghost', 'logs'));
  const manager = new ConnectorManager({ root, confirm: async (o) => { answer.calls.push(o); return answer.value; }, log });
  const picks = new PickStore();
  const runner = new JobRunner({ manager, log, ghostDir: path.join(root, 'ghost'), picks, emit: (n, p) => events.push([n, p]), maxHistory, globalMax });
  manager.setRunner(runner);
  const ctx = { root, answer, events, manager, runner, picks, log };
  // install, approve and enable a connector in one go
  ctx.ready = async (over, opts) => {
    const r = manager.register(stage(over, opts));
    if (!r.ok) throw new Error(JSON.stringify(r));
    await manager.requestApproval(r.id);
    manager.enable(r.id);
    return r.id;
  };
  return ctx;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }
module.exports = { tmp, baseManifest, stage, context, sleep, until, SCRIPT };
