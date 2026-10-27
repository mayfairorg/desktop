'use strict';
// Ghost terminal: the Ghost tools folder, and a read-only check for the programs code tools need. Nothing here starts a program:
// "found" means a file with that name exists on PATH, nothing more.
const fs = require('node:fs');
const path = require('node:path');

const MAX_SUB = 50, MAX_LIST = 200;
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const fileTarget = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

// <tools>, <tools>/bin and <tools>/<name>/bin (one level; folders holding a connector.json are tools added through "Add tool" and are left out). Links are skipped so a link cannot point the PATH at a folder elsewhere.
function toolDirs(toolsDir) {
  const out = [toolsDir, path.join(toolsDir, 'bin')];
  let names = [];
  try { names = fs.readdirSync(toolsDir).sort(); } catch { return out.filter((d) => d === toolsDir); }
  let n = 0;
  for (const name of names) {
    if (n >= MAX_SUB) break;
    const d = path.join(toolsDir, name);
    if (name === 'bin' || isLink(d) || !isDir(d)) continue;
    if (fs.existsSync(path.join(d, 'connector.json'))) continue;      // an added tool (a connector): runs only through the approved runner, never by typing its name
    const b = path.join(d, 'bin');
    if (isDir(b) && !isLink(b)) { out.push(b); n++; }
  }
  return out;
}

function ensureToolsDir(toolsDir) {
  try { fs.mkdirSync(toolsDir, { recursive: true, mode: 0o700 }); return true; } catch { return false; }
}

// Names of files the user can type, from the tools folder (up to 200).
function listTools(toolsDir, platform = process.platform) {
  const names = new Set();
  for (const d of toolDirs(toolsDir)) {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!(e.isFile() || (e.isSymbolicLink() && fileTarget(path.join(d, e.name))))) continue;
      if (platform === 'win32') { if (/\.(exe|cmd|bat|ps1|com)$/i.test(e.name)) names.add(e.name.replace(/\.[^.]+$/, '')); } else {
        try { fs.accessSync(path.join(d, e.name), fs.constants.X_OK); names.add(e.name); } catch { /* not executable */ }
      }
      if (names.size >= MAX_LIST) return [...names].sort();
    }
  }
  return [...names].sort();
}

function which(name, pathValue, platform = process.platform, exists = fs.existsSync) {
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['', ...(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const d of String(pathValue || '').split(sep)) {
    if (!d) continue;
    for (const x of exts) {
      const p = (platform === 'win32' ? path.win32 : path.posix).join(d, name + x);
      if (exists(p) && !isDir(p)) return p;
    }
  }
  return null;
}

// The programs people expect in a code terminal, each with the alternatives that satisfy it and a hint when missing.
const WANTED = [
  { id: 'git', any: ['git'], hint: { win32: 'Install Git for Windows (git-scm.com).', darwin: 'Run "xcode-select --install" or install Git with Homebrew.', linux: 'Install git with your package manager.' } },
  { id: 'gh', any: ['gh'], hint: { win32: 'Install the GitHub CLI (cli.github.com).', darwin: 'Install it with "brew install gh".', linux: 'Install "gh" with your package manager or from cli.github.com.' } },
  { id: 'node', any: ['node'], hint: { win32: 'Install Node.js (nodejs.org).', darwin: 'Install Node.js (nodejs.org or "brew install node").', linux: 'Install Node.js with your package manager or nvm.' } },
  { id: 'npm', any: ['npm'], hint: { win32: 'npm comes with Node.js.', darwin: 'npm comes with Node.js.', linux: 'npm comes with Node.js.' } },
  { id: 'python', any: ['python3', 'python', 'py'], hint: { win32: 'Install Python (python.org).', darwin: 'Install Python 3 (python.org or "brew install python").', linux: 'Install python3 with your package manager.' } },
  { id: 'pip', any: ['pip3', 'pip'], hint: { win32: 'pip comes with Python (or run "py -m ensurepip").', darwin: 'pip comes with Python 3.', linux: 'Install python3-pip with your package manager.' } },
  { id: 'pipx', any: ['pipx'], hint: { win32: 'Install it with "py -m pip install --user pipx".', darwin: 'Install it with "brew install pipx".', linux: 'Install pipx with your package manager (or "python3 -m pip install --user pipx").' } },
];

function probe(pathValue, platform = process.platform, exists = fs.existsSync) {
  return WANTED.map((w) => {
    for (const n of w.any) { const p = which(n, pathValue, platform, exists); if (p) return { id: w.id, found: true, path: p }; }
    return { id: w.id, found: false, hint: w.hint[platform] || w.hint.linux };
  });
}

module.exports = { toolDirs, ensureToolsDir, listTools, which, probe, WANTED };
