'use strict';
// Mayfair Ghost: production runner for '@node' connectors. In an installed build the RunAsNode fuse is OFF, so the app binary cannot be
// started as plain Node. This adapter runs the connector script in an Electron utilityProcess instead and presents the same small
// child interface the JobRunner already uses (pid, stdout, stderr, 'error', 'close', exitCode, signalCode, killTree), so caps, timeout,
// cancel, memory watch, minimal environment and output validation are the unchanged code paths in runner.js.
//
// Differences from a plain child, stated honestly:
//  * no stdin (the connector contract closes stdin anyway);
//  * a utility process is not a process-group leader, so cancel and timeout kill the process AND every descendant found by walking the
//    process tree (Linux /proc, Windows taskkill /T, macOS pgrep); a helper that detaches itself and re-parents before the walk is missed;
//  * the exit signal is not reported by Electron, so `signalCode` stays null (the runner decides cancel/timeout from its own reason).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFile } = require('node:child_process');

const BOOTSTRAP = path.join(__dirname, 'bootstrap.js').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');   // unpacked copy (see asarUnpack in package.json)
const ENV_PASS = process.platform === 'win32' ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH'];

// The environment of a utility connector: exactly the minimal set the plain runner builds (no ELECTRON_RUN_AS_NODE), plus extras.
function utilityEnv(extra = {}) {
  const env = {};
  for (const k of ENV_PASS) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (process.platform !== 'win32') { env.LANG = 'C.UTF-8'; env.TMPDIR = '/tmp'; }
  return { ...env, ...extra };
}

// Descendant pids of `pid`, deepest last. `readTable()` returns [[pid, ppid], ...]; the default reads the live system (Linux /proc;
// on macOS `ps` is run asynchronously in tableAsync, because the code here never runs a synchronous command).
function processTable() {
  if (process.platform === 'linux') {
    const rows = [];
    for (const n of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(n)) continue;
      try {
        const s = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
        const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');   // state ppid ...
        rows.push([+n, +rest[1]]);
      } catch { /* process ended */ }
    }
    return rows;
  }
  return [];
}
function tableAsync() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(processTable());
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 }, (err, out) => resolve(err ? [] : String(out).split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length === 2 && r.every(Number.isFinite))));
  });
}
function descendants(pid, readTable = processTable) {
  let rows;
  try { rows = readTable(); } catch { rows = []; }
  const kids = new Map();
  for (const [p, pp] of rows) { if (!kids.has(pp)) kids.set(pp, []); kids.get(pp).push(p); }
  const out = [], seen = new Set([pid]);
  const walk = (p) => { for (const k of kids.get(p) || []) { if (seen.has(k)) continue; seen.add(k); walk(k); out.push(k); } };
  walk(pid);
  return out;
}

// utilityProcess: Electron's `utilityProcess` object (injected so tests can pass a stand-in). Returns {spawn, runCheck, available}.
function createUtilityRunner({ utilityProcess, bootstrap = BOOTSTRAP, killGraceMs = 800, readTable = processTable } = {}) {
  if (!utilityProcess || typeof utilityProcess.fork !== 'function') return null;

  // spec: {script (absolute), args[], cwd, env (the whole environment), execArgv?[], serviceName?}
  function spawn(spec) {
    const child = new EventEmitter();
    child.stdout = null; child.stderr = null; child.exitCode = null; child.signalCode = null;
    let inner, exited = false, closed = false, timer = null;
    const env = { ...spec.env, MF_RUN_SCRIPT: spec.script, MF_RUN_ARGS: JSON.stringify(spec.args || []) };
    try {
      inner = utilityProcess.fork(bootstrap, [], { cwd: spec.cwd, env, execArgv: spec.execArgv || [], stdio: 'pipe', serviceName: spec.serviceName || 'mayfair-ghost-connector' });
    } catch (e) {
      const err = Object.assign(new Error(e.message), { code: e.code || 'ESPAWN' });
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      process.nextTick(() => child.emit('error', err));
      return child;
    }
    child.stdout = inner.stdout; child.stderr = inner.stderr;
    Object.defineProperty(child, 'pid', { get: () => inner.pid, enumerable: true });
    const streams = [inner.stdout, inner.stderr].filter(Boolean);
    let open = streams.length;
    const maybeClose = () => {
      if (closed || !exited || open > 0) return;
      closed = true;
      if (timer) clearTimeout(timer);
      child.emit('close', child.exitCode, child.signalCode);
    };
    for (const s of streams) { const done = () => { open--; maybeClose(); }; s.once('end', done); s.once('close', () => { if (!s.readableEnded) done(); }); }
    inner.on('exit', (code) => {
      exited = true; child.exitCode = typeof code === 'number' ? code : null;
      if (child.exitCode === null) child.exitCode = 1;
      timer = setTimeout(() => { open = 0; maybeClose(); }, 500);   // a stream that never ends must not hold the job open
      if (timer.unref) timer.unref();
      maybeClose();
    });
    inner.on('error', (...a) => { if (inner.pid === undefined && !exited) child.emit('error', Object.assign(new Error('utility process could not start'), { code: 'ESPAWN', detail: String(a[0]) })); });
    child.killTree = () => {
      if (exited) return;
      const pid = inner.pid;
      if (process.platform === 'win32') {
        if (pid) { try { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* gone */ } }
        return;
      }
      let kids = [];
      const killKids = (sig) => { for (const k of kids) { try { process.kill(k, sig); } catch { /* gone */ } } };
      if (readTable === processTable && process.platform === 'darwin') tableAsync().then((rows) => { kids = descendants(pid, () => rows); killKids('SIGTERM'); });
      else { kids = pid ? descendants(pid, readTable) : []; }
      try { inner.kill(); } catch { /* gone */ }
      killKids('SIGTERM');
      const hard = setTimeout(() => { for (const k of [...(pid ? [pid] : []), ...kids]) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } } }, killGraceMs);
      if (hard.unref) hard.unref();
      child.once('close', () => clearTimeout(hard));
    };
    return child;
  }

  // The '@node' install requirement check under this runtime: `["@node","-e",code]` or `["@node", relativeScript, ...args]`. {status, detail}.
  function runCheck({ argv, cwd, resolveRel, timeoutMs = 5000 }) {
    return new Promise((resolve) => {
      let script, args, tmpDir = null;
      if (argv[1] === '-e' && typeof argv[2] === 'string') {
        try { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-ghost-check-')); script = path.join(tmpDir, 'check.js'); fs.writeFileSync(script, argv[2], { mode: 0o600 }); } catch (e) { return resolve({ status: 'missing', detail: 'cannot prepare the check: ' + (e.code || e.message) }); }
        args = argv.slice(3);
      } else if (typeof argv[1] === 'string' && !argv[1].startsWith('-')) {
        script = resolveRel(argv[1]);
        if (!script) return resolve({ status: 'missing', detail: 'the check script is outside the connector folder' });
        args = argv.slice(2);
      } else return resolve({ status: 'missing', detail: 'unsupported check for the built-in runtime' });
      const cleanup = () => { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* temp */ } } };
      let done = false;
      const fin = (r) => { if (!done) { done = true; clearTimeout(t); cleanup(); resolve(r); } };
      const child = spawn({ script, args, cwd, env: utilityEnv() });
      if (child.stdout) child.stdout.resume();
      if (child.stderr) child.stderr.resume();
      const t = setTimeout(() => { if (child.killTree) child.killTree(); fin({ status: 'missing', detail: 'the check did not finish in time' }); }, timeoutMs);
      child.on('error', (e) => fin({ status: 'missing', detail: 'cannot start: ' + (e.code || e.message) }));
      child.on('close', (code) => fin(code === 0 ? { status: 'ok', detail: '' } : { status: 'missing', detail: 'check exited with code ' + code }));
    });
  }

  return { available: true, start: spawn, runCheck, bootstrap };
}

module.exports = { createUtilityRunner, utilityEnv, descendants, BOOTSTRAP };
