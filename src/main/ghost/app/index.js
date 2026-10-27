'use strict';
// Ghost app: entry point used by src/main/main.js. createGhostApp({electron, userData, ghost, ...}) -> { show, app, installed, libraryEntry, ... }
const path = require('node:path');
const { IdClient } = require('./id-client');
const { GhostApp, CLOUD } = require('./service');
const { createGhostWindow } = require('./window');

function createGhostApp({ electron, userData, ghost, isPackaged = true, icon, version, openTerminal, openToolIntegrations, onInstallChange = () => {}, env = process.env }) {
  const { dialog, shell } = electron;
  // Test and screenshot runs may point the app at local stand-ins. An installed app ignores this completely.
  const dev = !isPackaged && !!env.MF_GHOST_ID_BASE;
  const id = new IdClient({ base: dev ? env.MF_GHOST_ID_BASE : undefined, allowLoopback: dev });
  const uiDir = path.join(__dirname, '..', '..', '..', 'ui', 'ghost');
  let w = null;
  const app = new GhostApp({ userData, ghost, id, cloudBase: dev && env.MF_GHOST_CLOUD_BASE ? env.MF_GHOST_CLOUD_BASE : CLOUD, allowLoopback: dev, shell, dialog, getWindow: () => (w && w.getWindow()), electron,
    openTerminal, openToolIntegrations, version, pollMinMs: dev && env.MF_GHOST_POLL_MS ? Number(env.MF_GHOST_POLL_MS) : 2000 });
  w = createGhostWindow({ electron, app, uiDir, isPackaged, icon, maximize: !(dev && env.MF_GHOST_NO_MAXIMIZE) });
  let was = app.installed();
  const origChanged = app._changed.bind(app);
  app._changed = () => { origChanged(); const now = app.installed(); if (now !== was) { was = now; try { onInstallChange(now); } catch { /* menu rebuild failed */ } } };
  return { app, win: w, show: () => w.show(), installed: () => app.installed(), libraryEntry: () => app.libraryEntry(), sendJob: w.sendJob, shutdown: () => app.shutdown(), page: w.page };
}
module.exports = { createGhostApp };
