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
  searchEngine: 'google',
  matchSearchColors: true,
  adblock: true,
  bookmarksBar: true,
  startup: 'start', // 'start' | 'restore'
  notifications: true,
  onlineAnswers: true,
  passwordOffer: true,       // ask to save a login to Mayfair Passwords
  passwordNever: [],         // origins where the user chose 'never save here'
  historySync: true,         // history events for the user's Mayfair ID record
  autofillSave: true,        // offer to keep form details (email, name, address...) on the Mayfair ID
  autofillNever: [],
  detailsLog: true,          // 'details-used' events: where an email or username was used (masked, never the value)
  ...PV.PRIVACY_DEFAULTS,
});
const SCHEMA = {
  startFullscreen: 'boolean', launchAtLogin: 'boolean', tray: 'boolean', closeToTray: 'boolean',
  downloadMode: (v) => ['drive', 'folder', 'ask'].includes(v),
  downloadFolder: (v) => typeof v === 'string' && v.length < 1024,
  searchEngine: (v) => Object.prototype.hasOwnProperty.call(SEARCH_ENGINES, v),
  matchSearchColors: 'boolean',
  secureDns: 'boolean', ech: 'boolean', standardLocale: 'boolean', reduceFingerprint: 'boolean',
  dnsProvider: (v) => Object.prototype.hasOwnProperty.call(PV.DNS_PROVIDERS, v),
  webrtc: (v) => Object.prototype.hasOwnProperty.call(PV.WEBRTC, v),
  proxyMode: (v) => PV.PROXY_MODES.includes(v),
  proxyHost: (v) => v === '' || PV.isHost(v),
  proxyPort: (v) => v === 0 || PV.isPort(v),
  passwordOffer: 'boolean', historySync: 'boolean', autofillSave: 'boolean', detailsLog: 'boolean',
  passwordNever: (v) => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 300),
  autofillNever: (v) => Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 300),
  adblock: 'boolean', onlineAnswers: 'boolean', bookmarksBar: 'boolean',
  startup: (v) => v === 'start' || v === 'restore', notifications: 'boolean',
};
const ok = (k, v) => { const s = SCHEMA[k]; return typeof s === 'function' ? s(v) : typeof v === s; };

class Settings {
  constructor(file, opts) { this.s = new JsonStore(file, () => ({}), opts); }
  get() { const out = { ...DEFAULTS, passwordNever: [], autofillNever: [] }; for (const k of Object.keys(DEFAULTS)) if (k in this.s.data && ok(k, this.s.data[k])) out[k] = Array.isArray(this.s.data[k]) ? this.s.data[k].slice() : this.s.data[k]; return out; }
  // Unknown keys and wrong types are ignored; returns the keys that changed.
  set(patch) {
    const changed = [];
    for (const [k, v] of Object.entries(patch || {})) {
      if (!(k in DEFAULTS) || !ok(k, v)) continue;
      if (JSON.stringify(this.get()[k]) !== JSON.stringify(v)) { this.s.data[k] = v; changed.push(k); }
    }
    if (changed.length) this.s.save();
    return changed;
  }
  flush() { this.s.flush(); }
}
module.exports = { Settings, DEFAULTS };
