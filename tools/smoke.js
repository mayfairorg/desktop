'use strict';
// Launches the real Electron app under Xvfb and runs tools/smoke-hook.js inside it.
// Usage: node tools/smoke.js [WIDTHxHEIGHT] [tag]
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const size = process.argv[2] || '1280x800';
const tag = process.argv[3] || size.split('x')[0];
const out = process.env.MF_SMOKE_OUT || path.join(os.tmpdir(), 'mf-smoke');
const candidates = [process.env.ELECTRON_BIN, path.join(root, 'node_modules/electron/dist/electron'), path.join(root, '.electron-dl/dist/electron')].filter(Boolean);
const bin = candidates.find((p) => fs.existsSync(p));
if (!bin) { console.error('No Electron binary found. Run "npm install" (downloads it) or set ELECTRON_BIN.'); process.exit(2); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-home-'));
fs.mkdirSync(out, { recursive: true });
const args = ['-a', '-s', `-screen 0 ${size}x24`, bin, root, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const r = spawnSync('xvfb-run', args, {
  stdio: 'inherit', timeout: 150000,
  env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DOCUMENTS_DIR: path.join(home, 'Documents'), MAYFAIR_DESKTOP_DATA: path.join(home, 'data'), MF_SMOKE: '1', MAYFAIR_TOR_BIN: path.join(root, 'test/fixtures/fake-tor.js'), MF_SMOKE_OUT: out, MF_SMOKE_TAG: tag },
});
console.log('screenshots and results in', out);
process.exit(r.status === null ? 3 : r.status);
