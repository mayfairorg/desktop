'use strict';
// Test stand-in for Electron's utilityProcess: fork() starts the module in a plain Node child with exactly the given environment,
// reports 'spawn' and 'exit' like Electron does (no 'close', no signal), and offers stdout/stderr when stdio is 'pipe'.
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

function makeFake({ failFork = false } = {}) {
  const forks = [];
  return {
    forks,
    fork(modulePath, args = [], opts = {}) {
      if (failFork) throw Object.assign(new Error('fork refused'), { code: 'EFORK' });
      const inner = new EventEmitter();
      const c = spawn(process.execPath, [...(opts.execArgv || []), modulePath, ...args], { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
      forks.push({ modulePath, args, opts });
      inner.stdout = opts.stdio === 'pipe' ? c.stdout : null; inner.stderr = opts.stdio === 'pipe' ? c.stderr : null;
      Object.defineProperty(inner, 'pid', { get: () => c.pid });
      inner.kill = () => c.kill('SIGTERM');
      c.on('spawn', () => inner.emit('spawn'));
      c.on('exit', (code) => inner.emit('exit', code));
      return inner;
    },
  };
}
module.exports = { makeFake };
