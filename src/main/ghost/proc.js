'use strict';
// Mayfair Ghost: process helpers. Every child is started from an argv array with shell:false, in the connector folder, with a
// minimal environment (no inherited tokens, cookies or API keys). Cancel and timeout kill the whole process group.
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');

const ENV_PASS = process.platform === 'win32' ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH'];

function minimalEnv({ node = false, extra = {} } = {}) {
  const env = {};
  for (const k of ENV_PASS) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (process.platform !== 'win32') { env.LANG = 'C.UTF-8'; env.TMPDIR = '/tmp'; }
  if (node) env.ELECTRON_RUN_AS_NODE = '1';
  return { ...env, ...extra };
}

// Kill the child and everything it started. SIGTERM first (so tools can tidy up), SIGKILL shortly after.
function killTree(child, graceMs = 800) {
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (process.platform === 'win32') {
    try { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* gone */ }
    return;
  }
  const sig = (s) => { try { process.kill(-pid, s); } catch { try { process.kill(pid, s); } catch { /* gone */ } } };
  sig('SIGTERM');
  const t = setTimeout(() => sig('SIGKILL'), graceMs);
  if (t.unref) t.unref();
  child.once('close', () => clearTimeout(t));
}

// VmRSS in MB for a pid on Linux (best effort: other platforms return null and the memory limit is not enforced there).
function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Math.round(+m[1] / 1024) : null;
  } catch { return null; }
}

// Run an installRequirements check: argv only, short timeout, output ignored. Resolves {status:'ok'|'missing', detail}.
function runCheck({ argv, cwd, nodePath, resolveRel, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    let exe = argv[0], isNode = false;
    if (exe === '@node') { if (!nodePath) return resolve({ status: 'missing', detail: 'the built-in Node runtime is switched off in this build' }); exe = nodePath; isNode = true; } else if (exe.includes('/')) exe = resolveRel(exe);
    if (!exe) return resolve({ status: 'missing', detail: 'the check program is outside the connector folder' });
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try { child = spawn(exe, argv.slice(1), { cwd, shell: false, env: minimalEnv({ node: isNode }), stdio: 'ignore', windowsHide: true }); } catch (e) { return fin({ status: 'missing', detail: 'cannot start: ' + (e.code || e.message) }); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } fin({ status: 'missing', detail: 'the check did not finish in time' }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); fin({ status: 'missing', detail: e.code === 'ENOENT' ? 'not found on this computer: ' + argv[0] : 'cannot start: ' + (e.code || e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); fin(code === 0 ? { status: 'ok', detail: '' } : { status: 'missing', detail: 'check exited with code ' + code }); });
  });
}

module.exports = { minimalEnv, killTree, rssMb, runCheck, spawn };
