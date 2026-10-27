'use strict';
// Ghost terminal: the environment the user's shell starts with, and the PATH it gets.
// The terminal is the user's own shell, so it inherits the user's login environment (HOME, USER, proxy settings, their own GH_TOKEN...).
// What it must NOT inherit is anything that belongs to this app: Electron switches (ELECTRON_RUN_AS_NODE would turn a child
// "electron" into a plain Node), Mayfair settings, NODE_OPTIONS, and the AppImage/Chromium library overrides that break system tools.
const fs = require('node:fs');
const path = require('node:path');

const DROP = [/^ELECTRON_/i, /^MAYFAIR_/i, /^MF_/i, /^NODE_OPTIONS$/i, /^NODE_ENV$/i, /^NODE_PATH$/i, /^CHROME_/i, /^GOOGLE_API_KEY$/i, /^GOOGLE_DEFAULT_/i,
  /^APPIMAGE$/i, /^APPDIR$/i, /^ARGV0$/i, /^OWD$/i, /^ORIGINAL_/i, /^LD_PRELOAD$/i, /^npm_(config|lifecycle|package|command|execpath|node_execpath)/i];
const isDropped = (k) => DROP.some((r) => r.test(k));

// Directories added after the inherited PATH when they exist. An app started from the Dock or a Start menu entry gets a short PATH
// that misses Homebrew, pipx and npm's user folder, so the usual places are added (never created, never written to).
function extraDirs({ platform, env, home }) {
  const j = platform === 'win32' ? path.win32.join : path.posix.join;
  if (platform === 'win32') {
    const pf = env.ProgramFiles || 'C:\\Program Files', pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const appData = env.APPDATA || j(home, 'AppData', 'Roaming'), local = env.LOCALAPPDATA || j(home, 'AppData', 'Local');
    return [j(pf, 'Git', 'cmd'), j(pf, 'Git', 'bin'), j(pf86, 'Git', 'cmd'), j(pf, 'GitHub CLI'), j(pf, 'nodejs'), j(appData, 'npm'), j(home, '.local', 'bin'),
      j(local, 'Microsoft', 'WindowsApps'), j(local, 'Programs', 'Python', 'Launcher'), j(pf, 'PowerShell', '7')];
  }
  const common = [j(home, '.local', 'bin'), j(home, '.npm-global', 'bin'), j(home, '.cargo', 'bin'), j(home, 'go', 'bin')];
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...common];
  return ['/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/snap/bin', ...common];
}

// toolDirs first (the Ghost tools folder wins over system copies on purpose: the user installed those for Ghost), then the inherited PATH, then extras.
function buildPath({ platform = process.platform, basePath = '', toolDirs = [], extras = [], exists = fs.existsSync }) {
  const sep = platform === 'win32' ? ';' : ':';
  const seen = new Set(), out = [];
  const add = (d, must) => {
    if (!d || typeof d !== 'string') return;
    const key = platform === 'win32' ? d.toLowerCase() : d;
    if (seen.has(key)) return;
    if (must && !exists(d)) return;
    seen.add(key); out.push(d);
  };
  for (const d of toolDirs) add(d, false);
  for (const d of basePath.split(sep)) add(d, false);
  for (const d of extras) add(d, true);
  return out.join(sep);
}

// base: the environment to start from (the caller passes the app's own). Returns a new plain object; base is not modified.
function buildEnv(base, { platform = process.platform, home, toolsDir, toolDirs = [], mode = 'pty', exists = fs.existsSync, term = 'xterm-256color' } = {}) {
  const env = {};
  let pathKey = 'PATH';
  for (const k of Object.keys(base || {})) {
    if (typeof base[k] !== 'string' || isDropped(k)) continue;
    if (platform === 'win32' && k.toLowerCase() === 'path') { pathKey = k; }
    env[k] = base[k];
  }
  const h = home || env.HOME || env.USERPROFILE || '';
  env[pathKey] = buildPath({ platform, basePath: env[pathKey] || '', toolDirs, extras: extraDirs({ platform, env, home: h }), exists });
  if (h && !env.HOME && platform !== 'win32') env.HOME = h;
  env.TERM = term;
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'MayfairGhost';
  if (toolsDir) env.MAYFAIR_GHOST_TOOLS = toolsDir;
  if (!env.LANG && !env.LC_ALL && platform !== 'win32') env.LANG = 'en_US.UTF-8';
  if (mode === 'basic') { env.PAGER = 'cat'; env.GIT_PAGER = 'cat'; env.TERM = 'dumb'; delete env.COLORTERM; }   // no terminal: pagers would wait forever
  return env;
}

module.exports = { buildEnv, buildPath, extraDirs, isDropped };
