'use strict';
// Code protection helpers (pure functions, unit tested without Electron): which keys and addresses open developer tools or the page source,
// and the start-up check that the installed files are the ones that were built.  See README.md, Code protection.
// Honest limit: a copy of the app can always be unpacked and read.  This makes casual copying and editing hard and visible; it is not secrecy.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST = 'integrity.json';

// The owner's switch: MAYFAIR_DESKTOP_DEVTOOLS=1 in the environment turns developer tools back on in an installed build.  A build run from source always has them.
function devToolsAllowed({ env = process.env, isPackaged = true } = {}) { return !isPackaged || env.MAYFAIR_DESKTOP_DEVTOOLS === '1'; }

// Keys that open developer tools or view-source: F12, Ctrl/Cmd+Shift+I, J and C, Ctrl+Alt+I (mac: Cmd+Alt+I/J/U), Ctrl/Cmd+U.
function isDevToolsKey(input) {
  if (!input || input.type !== 'keyDown') return false;
  const k = String(input.key || '').toLowerCase(), mod = !!(input.control || input.meta);
  if (input.key === 'F12') return true;
  if (mod && input.shift && ['i', 'j', 'c'].includes(k)) return true;
  if (mod && input.alt && ['i', 'j', 'u'].includes(k)) return true;
  if (mod && !input.shift && !input.alt && k === 'u') return true;
  return false;
}
const isViewSource = (url) => /^\s*view-source:/i.test(String(url || ''));

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// what is checked: package.json and every file under src/ (the program); not assets (filter lists are replaced by updates) or user data
function listFiles(root, rel = 'src', fsx = fs) {
  const out = [];
  for (const e of fsx.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel + '/' + e.name;
    if (e.isDirectory()) out.push(...listFiles(root, r, fsx)); else out.push(r);
  }
  return out.sort();
}
function buildManifest(root, fsx = fs) {
  const files = {};
  for (const f of ['package.json', ...listFiles(root, 'src', fsx)]) files[f] = sha256(fsx.readFileSync(path.join(root, f)));
  const all = sha256(Object.keys(files).map((k) => k + ':' + files[k]).join('\n'));
  return { v: 1, algo: 'sha256', files, all };
}
// -> { ok, reason, bad: [files that differ, are missing or were added] }.  A missing manifest in an installed build is a failure, not a pass.
function verify(root, { fsx = fs, requireManifest = true } = {}) {
  let m;
  try { m = JSON.parse(fsx.readFileSync(path.join(root, MANIFEST), 'utf8')); } catch { return requireManifest ? { ok: false, reason: 'no-manifest', bad: [MANIFEST] } : { ok: true, reason: 'skipped', bad: [] }; }
  if (!m || m.v !== 1 || m.algo !== 'sha256' || !m.files || typeof m.files !== 'object') return { ok: false, reason: 'bad-manifest', bad: [MANIFEST] };
  const bad = [];
  for (const [f, h] of Object.entries(m.files)) {
    if (f.includes('..') || path.isAbsolute(f)) { bad.push(f); continue; }
    try { if (sha256(fsx.readFileSync(path.join(root, f))) !== h) bad.push(f); } catch { bad.push(f); }
  }
  try { for (const f of listFiles(root, 'src', fsx)) if (!(f in m.files)) bad.push(f); } catch { bad.push('src'); }
  const all = sha256(Object.keys(m.files).map((k) => k + ':' + m.files[k]).join('\n'));
  if (all !== m.all) bad.push(MANIFEST);
  return bad.length ? { ok: false, reason: 'modified', bad: [...new Set(bad)].slice(0, 20) } : { ok: true, reason: 'ok', bad: [] };
}

// the Electron fuses the installer sets (tools/after-pack.js); kept here so a test can pin them
const FUSES = {
  RunAsNode: false,                                   // the binary cannot be used as a plain Node.js (ELECTRON_RUN_AS_NODE)
  EnableNodeOptionsEnvironmentVariable: false,        // NODE_OPTIONS cannot inject code
  EnableNodeCliInspectArguments: false,               // --inspect and friends are ignored
  EnableEmbeddedAsarIntegrityValidation: true,        // the app.asar must match the hash stored in the signed binary (macOS and Windows)
  OnlyLoadAppFromAsar: true,                          // no loose app folder next to the asar
  GrantFileProtocolExtraPrivileges: true,             // must stay on: with it off Chromium treats file:// as non-standard, CSP 'self' stops matching and the tab strip draws blank (white bar)
};

module.exports = { MANIFEST, devToolsAllowed, isDevToolsKey, isViewSource, buildManifest, verify, listFiles, sha256, FUSES };
