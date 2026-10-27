'use strict';
// Ghost virtual computer: the runtime the connector runner uses for tools that live inside the machine (a connector folder with ghost-vm.json).
//   start({spec, jobId, env})  -> a child-like object (stdout, stderr, killTree, 'close') so the runner treats it like any other program:
//       same argv-only rule, same limits, same JSON-lines output checks. The command runs in the machine through the agent, as the
//       unprivileged user, with the connector's folder as the working directory.
//   runCheck({argv, guestDir}) -> the install-requirement check, run inside the machine.
// Before each run the files inside the machine are checked against what was approved:
//   the folder is a git checkout; its HEAD must be the pinned commit (the one that was approved) and no tracked file may differ from it.
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

class ToolRuntime {
  // vm: () => VmService.
  constructor({ vm }) { this.vm = vm; }

  async prepare(svc, spec) {
    const v = spec.vm;
    const head = await svc.runArgv(['git', '-C', v.guestDir, 'rev-parse', 'HEAD'], { timeoutMs: 20000 });
    if (head.code !== 0) throw new Error('The tool is not in the virtual computer (its folder is missing: was the tools disk wiped?). Add it again.');
    if (head.stdout.trim() !== v.commit) throw new Error('The files in the virtual computer are at a different commit than the one you approved. Update the tool and approve it again.');
    const diff = await svc.runArgv(['git', '-C', v.guestDir, 'diff', '--quiet', 'HEAD'], { timeoutMs: 60000 });
    if (diff.code !== 0) throw new Error('A file of this tool was changed inside the virtual computer after you approved it, so it was not run. Update the tool to restore it.');
  }

  start({ spec, env = {} }) {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = undefined; child.exitCode = null; child.signalCode = null;
    let handle = null, killed = false, ended = false;
    const end = (code, signal) => {
      if (ended) return; ended = true; child.exitCode = code; child.signalCode = signal || null;
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', code, signal || null));
    };
    child.killTree = () => { killed = true; if (handle) handle.kill(); };
    (async () => {
      try {
        const svc = this.vm();
        await svc.ensureRunning();
        if (killed) return end(null, 'SIGTERM');
        await this.prepare(svc, spec);
        if (killed) return end(null, 'SIGTERM');
        handle = svc.execStream([spec.exe, ...spec.args], { cwd: spec.vm.guestDir, env, timeoutMs: spec.limits.timeoutMs + 5000, onOut: (ch, b) => (ch === 'o' ? child.stdout : child.stderr).write(b) });
        if (killed) handle.kill();
        const r = await handle.done;
        end(r.code, r.signal);
      } catch (e) { child.stderr.write(String((e && e.message) || e).replace(/^Error: /, '').slice(0, 400) + '\n'); end(1, null); }
    })();
    return child;
  }

  async runCheck({ argv, guestDir }) {
    try {
      const svc = this.vm();
      await svc.ensureRunning();
      const a = argv.slice(); if (a[0] === '@node') a[0] = 'node';
      const r = await svc.runArgv(a, { cwd: guestDir, timeoutMs: 15000 });
      return r.code === 0 ? { status: 'ok', detail: '' } : { status: 'missing', detail: r.code === 127 ? 'not found in the virtual computer: ' + a[0] : 'check exited with code ' + r.code };
    } catch (e) { return { status: 'missing', detail: String((e && e.message) || e).slice(0, 200) }; }
  }
}
module.exports = { ToolRuntime };
