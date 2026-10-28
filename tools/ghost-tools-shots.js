'use strict';
// Runs tools/ghost-tools-main.js under Xvfb at 1280x800, 1024x768, 768x1024 and 390x844, one after the other. Output: GHOST_OUT (default <tmp>/ghost-tools-shots).
// GHOST_SIZES="1280x800,390x844" runs only some sizes.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const bin = [process.env.ELECTRON_BIN, path.join(root, 'node_modules/electron/dist/electron'), path.join(root, '.electron-dl/dist/electron')].filter(Boolean).find((p) => fs.existsSync(p));
if (!bin) { console.error('No Electron binary found.'); process.exit(2); }
const sizes = (process.env.GHOST_SIZES || '1280x800,1024x768,768x1024,390x844').split(',');
let bad = 0;
for (const size of sizes) {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ghost-home-'));
  const r = spawnSync('xvfb-run', ['-a', '-s', `-screen 0 ${size}x24`, bin, path.join(__dirname, 'ghost-tools-main.js'), '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], { stdio: 'inherit', timeout: 300000, killSignal: 'SIGKILL', env: { ...process.env, HOME: home, GHOST_SIZE: size, GHOST_TAG: size.split('x')[0] } });
  if (r.status !== 0) bad++;
}
process.exit(bad ? 1 : 0);
