'use strict';
// Running a separate program for a tool connector: found in the connector's own bin/ folder (where the download-on-first-use step puts
// it) or on PATH; started from an argv array with shell:false, a minimal environment, no stdin, a timeout and an output cap. Heavy tools
// (OCR, video, Java) take a machine-wide lock so only one runs at a time. Everything is injectable, so tests use stand-in programs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const EXT = process.platform === 'win32' ? ['.exe'] : [''];
const isExec = (p) => { try { const st = fs.statSync(p); if (!st.isFile()) return false; if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } };

function minimalEnv() {
  const env = {};
  for (const k of process.platform === 'win32' ? ['PATH', 'SystemRoot', 'TEMP', 'TMP'] : ['PATH']) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (process.platform !== 'win32') { env.LANG = 'C.UTF-8'; env.TMPDIR = os.tmpdir(); env.HOME = os.tmpdir(); }
  return env;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function realTools({ binDirs = [path.join(process.cwd(), 'bin')], pathEnv = process.env.PATH || '', lockFile = path.join(os.tmpdir(), 'mf-ghost-heavy.lock'), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const dirs = [...binDirs, ...pathEnv.split(path.delimiter).filter(Boolean)];
  const find = (names) => { for (const d of dirs) for (const n of names) for (const e of EXT) { const p = path.join(d, n + e); if (isExec(p)) return p; } return null; };
  // first file matching a pattern in the bin folders (a .jar next to the connector)
  const findFile = (re) => { for (const d of binDirs) { let l = []; try { l = fs.readdirSync(d).sort().reverse(); } catch { /* none */ } const n = l.find((x) => re.test(x)); if (n) return path.join(d, n); } return null; };

  function run(file, args, { timeoutMs = 60000, maxBytes = 4 * 1024 * 1024, cwd } = {}) {
    return new Promise((resolve) => {
      let child, out = Buffer.alloc(0), err = '', timedOut = false, truncated = false, done = false;
      const fin = (r) => { if (!done) { done = true; clearTimeout(t); resolve({ stdout: out.toString('utf8'), stderr: err.slice(0, 4096), timedOut, truncated, ...r }); } };
      try { child = spawn(file, args, { cwd, shell: false, env: minimalEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return fin({ code: null, error: e.code || e.message }); }
      const t = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
      child.stdout.on('data', (c) => { if (out.length + c.length > maxBytes) { truncated = true; try { child.kill('SIGKILL'); } catch { /* gone */ } return; } out = Buffer.concat([out, c]); });
      child.stderr.on('data', (c) => { if (err.length < 8192) err += c.toString('utf8'); });
      child.on('error', (e) => fin({ code: null, error: e.code || e.message }));
      child.on('close', (code) => fin({ code }));
    });
  }
  // Start a program that outlives this job (a desktop application). Resolves {ok, pid} or {ok:false, error} if it fails at once.
  function launch(file, args) {
    return new Promise((resolve) => {
      let child;
      try { child = spawn(file, args, { shell: false, env: minimalEnv(), stdio: 'ignore', detached: true, windowsHide: false }); } catch (e) { return resolve({ ok: false, error: e.code || e.message }); }
      child.once('error', (e) => resolve({ ok: false, error: e.code || e.message }));
      setTimeout(() => { child.unref(); resolve({ ok: true, pid: child.pid }); }, 300);
    });
  }
  // One heavy job at a time on this machine: an exclusive lock file holding the owner's pid; a dead owner's lock is taken over.
  async function heavy(fn, { waitMs = 10 * 60 * 1000 } = {}) {
    const t0 = Date.now(); let fd = null;
    for (;;) {
      try { fd = fs.openSync(lockFile, 'wx', 0o600); fs.writeSync(fd, String(process.pid)); break; } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let owner = NaN; try { owner = Number(fs.readFileSync(lockFile, 'utf8')); } catch { /* released */ }
        if (!Number.isInteger(owner) || owner <= 0 || !alive(owner)) { try { fs.unlinkSync(lockFile); } catch { /* raced */ } continue; }
        if (Date.now() - t0 > waitMs) throw Object.assign(new Error('another heavy tool is still running'), { code: 'HEAVY_BUSY' });
        await sleep(250);
      }
    }
    try { return await fn(); } finally { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.unlinkSync(lockFile); } catch { /* gone */ } }
  }
  return { find, findFile, run, launch, heavy, dirs };
}
module.exports = { realTools, minimalEnv };
