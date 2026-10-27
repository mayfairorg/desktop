'use strict';
// Ghost terminal: which shell to start. The shell is started with NO command: no "-c", no startup script of ours. It waits for the person to type.
const fs = require('node:fs');
const path = require('node:path');
const { which } = require('./tools');

const base = (f, platform) => (platform === 'win32' ? path.win32 : path.posix).basename(f).replace(/\.exe$/i, '').toLowerCase();

// mode 'pty' (a real terminal) or 'basic' (pipes: the shell is told it is interactive with -i).
function pickShell({ platform = process.platform, env = {}, mode = 'pty', exists = fs.existsSync, pathValue = env.PATH || '' } = {}) {
  if (platform === 'win32') {
    const sysroot = env.SystemRoot || 'C:\\Windows', pf = env.ProgramFiles || 'C:\\Program Files';
    const cands = [path.win32.join(pf, 'PowerShell', '7', 'pwsh.exe'), path.win32.join(sysroot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
    const hit = cands.find((c) => exists(c)) || which('pwsh', pathValue, 'win32', exists) || which('powershell', pathValue, 'win32', exists);
    if (hit) return { file: hit, args: mode === 'basic' ? ['-NoLogo', '-NoProfile', '-Command', '-'] : ['-NoLogo'], name: base(hit, 'win32') };
    const cmd = env.ComSpec || path.win32.join(sysroot, 'System32', 'cmd.exe');
    return { file: cmd, args: mode === 'basic' ? ['/Q', '/K'] : [], name: 'cmd' };
  }
  const want = [env.SHELL, platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/bash', '/bin/sh'];
  const file = want.find((s) => typeof s === 'string' && path.posix.isAbsolute(s) && exists(s));
  if (!file) throw new Error('no shell found on this computer');
  const name = base(file, platform);
  const args = [];
  if (['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish'].includes(name)) args.push('-l');         // login shell: picks up PATH from the person's profile
  if (mode === 'basic' && ['bash', 'zsh', 'sh', 'dash', 'ksh', 'fish'].includes(name)) args.push('-i');
  return { file, args, name };
}

module.exports = { pickShell };
