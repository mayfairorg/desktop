'use strict';
const { JsonStore } = require('./stores');
const { SEARCH_ENGINES } = require('./origins');
const PV = require('./privacy');

const DEFAULTS = Object.freeze({
  startFullscreen: true,
  launchAtLogin: false,
  tray: true,
  closeToTray: true,
  downloadMode: 'drive', // 'drive' | 'folder' | 'ask'
  downloadFolder: '',
  searchEngine: 'duckduckgo',
  adblock: true,
  bookmarksBar: true,
  hideToolbarOnMayfair: true,
  notifications: true,
  onlineAnswers: true,
  ...PV.PRIVACY_DEFAULTS,
});
const SCHEMA = {
  startFullscreen: 'boolean', launchAtLogin: 'boolean', tray: 'boolean', closeToTray: 'boolean',
  downloadMode: (v) => ['drive', 'folder', 'ask'].includes(v),
  downloadFolder: (v) => typeof v === 'string' && v.length < 1024,
  searchEngine: (v) => Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, v),
  secureDns: 'boolean', ech: 'boolean', standardLocale: 'boolean', reduceFingerprint: 'boolean',
  dnsProvider: (v) => Object.prototype.hasOwnProperty.call(PV.DNS_PROVIDERS, v),
  webrtc: (v) => Object.prototype.hasOwnProperty.call(PV.WEBRTC, v),
  proxyMode: (v) => PV.PROXY_MODES.includes(v),
  proxyHost: (v) => v === '' || PV.isHost(v),
  proxyPort: (v) => v === 0 || PV.isPort(v),
  adblock: 'boolean', onlineAnswers: 'boolean', bookmarksBar: 'boolean', hideToolbarOnMayfair: 'boolean', notifications: 'boolean',
};
const ok = (k, v) => { const s = SCHEMA[k]; return typeof s === 'function' ? s(v) : typeof v === s; };

class Settings {
  constructor(file, opts) { this.s = new JsonStore(file, () => ({}), opts); }
  get() { const out = { ...DEFAULTS }; for (const k of Object.keys(DEFAULTS)) if (k in this.s.data && ok(k, this.s.data[k])) out[k] = this.s.data[k]; return out; }
  // Unknown keys and wrong types are ignored; returns the keys that changed.
  set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS) || !ok(k, v)) continue;
      if (this.get()[k] !== v) { this.s.data[k] = v; changed.push(k); }
    }
    if (changed.length) this.s.save();
    return changed;
  }
  flush() { this.s.flush(); }
}
module.exports = { Settings, DEFAULTS };
