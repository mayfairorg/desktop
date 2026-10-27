'use strict';
// Entry used by src/main/main.js. createGhostBrowserApp({electron, userData, getVault, isPackaged, icon, restoreResolver}) -> {showLauncher, shutdown, ...}.
const path = require('node:path');
const { TorManager, binaryPath } = require('../../lib/tor');
const { createGhostBrowser } = require('./window');

function createGhostBrowserApp({ electron, getVault, isPackaged = true, icon, restoreResolver, tor = null }) {
  const root = path.join(__dirname, '..', '..', '..', '..');
  // Ghost runs its own Tor process (own data folder, own circuits), separate from the Browser app's Tor tabs.
  const t = tor || new TorManager({ binary: binaryPath({ resourcesPath: process.resourcesPath, root }) });
  return createGhostBrowser({ electron, tor: t, vault: getVault, uiDir: path.join(root, 'src', 'ui', 'ghost-browser'), isPackaged, icon, restoreResolver });
}
module.exports = { createGhostBrowserApp };
