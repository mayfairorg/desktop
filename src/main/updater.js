'use strict';
const { updateFeedConfigured } = require('./lib/policy');

// Auto-update through electron-updater against a feed the owner hosts. No telemetry:
// the only request is the feed file itself. Does nothing until a real feed URL is set.
function setup({ app, feedUrl, onReady, log = () => {} }) {
  if (!app.isPackaged) return { enabled: false, reason: 'development build' };
  if (!updateFeedConfigured(feedUrl)) return { enabled: false, reason: 'update feed URL is still a placeholder' };
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (e) { return { enabled: false, reason: 'electron-updater not installed' }; }
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
  autoUpdater.on('update-downloaded', (info) => onReady && onReady(info.version, () => autoUpdater.quitAndInstall()));
  autoUpdater.on('error', (e) => log('update error: ' + (e && e.message)));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000).unref();
  setInterval(check, 6 * 3600 * 1000).unref();
  return { enabled: true };
}
module.exports = { setup };
