'use strict';
// The only IPC the app speaks. Every channel names who may call it and checks its arguments.
// Roles: 'web' (the Mayfair view, Mayfair origin only: the Mayfair bridge and the Browser bridge),
//        'start' (the Mayfair Search start page inside a tab: derived from the page URL),
//        'page' (any other website in a tab: password-field detection only).
// There is no UI role: the Browser's own interface is drawn by Mayfair Cloud inside the Mayfair view.
const str = (max = 2048) => (v) => typeof v === 'string' && v.length <= max;
const num = (v) => Number.isFinite(v);
const bool = (v) => typeof v === 'boolean';
const id = (v) => Number.isInteger(v) && v > 0 && v < 1e9;
const int = (v) => Number.isInteger(v);
const none = (a) => a.length === 0;
const args = (...checks) => (a) => a.length === checks.length && checks.every((c, i) => c(a[i]));
// the last arguments may be left out
const argsOpt = (min, ...checks) => (a) => { a = a.slice(); while (a.length > min && a[a.length - 1] === undefined) a.pop(); return a.length >= min && a.length <= checks.length && a.every((x, i) => checks[i](x)); };
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (...xs) => (v) => xs.includes(v);
const optStr = (max) => (v) => v === undefined || str(max)(v);
const optBool = (v) => v === undefined || bool(v);
const W = ['web'];

// Browser bridge: window.mayfairDesktop.browser.<name>  <->  channel 'br:<name>' (a dotted name stays dotted: 'br:bookmarks.list')
const BR = {
  ready: none, setBounds: args((v) => obj(v) && num(v.x) && num(v.y) && num(v.w) && num(v.h) && optBool(v.visible)), setOccluded: argsOpt(1, bool, (v) => obj(v) && optBool(v.focus)), capture: none,
  focus: args(id),
  newTab: argsOpt(0, (v) => obj(v) && optStr(2048)(v.url) && optBool(v.private) && optBool(v.tor) && optBool(v.background) && (v.webapp === undefined || v.webapp === null || str(32)(v.webapp))),
  closeTab: args(id), activate: args(id), move: args(id, int), duplicate: args(id), pin: args(id, bool), mute: args(id, bool), closeOthers: args(id), reopenClosed: none,
  go: args(id, str(2048)), back: args(id), forward: args(id), reload: argsOpt(1, id, bool), stop: args(id), home: none, suggest: args(str(200)),
  find: argsOpt(2, id, str(200), (v) => obj(v) && optBool(v.forward) && optBool(v.findNext) && optBool(v.matchCase)), stopFind: args(id),
  zoom: args(id, (v) => v === 'reset' || (Number.isInteger(v) && v >= -10 && v <= 10)), print: args(id), savePage: args(id), devtools: args(id),
  fullscreen: args(bool), windowFullscreen: argsOpt(0, bool), fillPassword: args(id),
  'bookmarks.list': none, 'bookmarks.add': args((v) => obj(v) && str(2048)(v.url) && optStr(200)(v.title)), 'bookmarks.remove': args(str(64)),
  'bookmarks.update': args(str(64), (v) => obj(v) && optStr(2048)(v.url) && optStr(200)(v.title)),
  'bookmarks.import': args((v) => Array.isArray(v) && v.length <= 5000 && v.every((x) => obj(x) && str(2048)(x.url) && optStr(200)(x.title))),
  'history.list': argsOpt(0, (v) => int(v) && v > 0 && v <= 5000), 'history.search': argsOpt(1, str(200), (v) => int(v) && v > 0 && v <= 1000), 'history.remove': args(str(2048)), 'history.clear': argsOpt(0, num),
  'downloads.list': none, 'downloads.open': args(str(64)), 'downloads.show': args(str(64)), 'downloads.cancel': args(str(64)), 'downloads.clear': none,
  'settings.get': none, 'settings.set': args(obj), 'settings.setProxy': args(oneOf('off', 'http', 'socks5'), str(253), (v) => int(v) && v >= 0 && v <= 65535), 'settings.pickFolder': none,
  'settings.clearBrowsingData': argsOpt(0, (v) => obj(v) && optBool(v.history) && optBool(v.downloads) && optBool(v.cookies) && optBool(v.cache)),
  'permissions.list': none, 'permissions.site': args(id), 'permissions.set': args(str(300), str(40), oneOf('allow', 'deny', 'ask')), 'permissions.reset': args(str(300)), 'permissions.answer': args(str(64), bool, bool),
  'popups.allow': args(str(64)),
  'webapps.catalogue': none, 'webapps.open': argsOpt(1, str(32), (v) => obj(v) && optBool(v.window)), 'webapps.pin': args(str(32), bool), 'webapps.reset': args(str(32)), 'webapps.remove': args(str(32)), 'webapps.shortcut': args(str(32)),
  'tor.status': none, 'tor.start': none, 'tor.stop': none, 'tor.newIdentity': none,
  'adblock.stats': argsOpt(0, id), 'adblock.toggleSite': args(id), 'adblock.updateNow': none,
  'extensions.list': none, 'extensions.install': args(str(32), str(300), str(64)), 'extensions.remove': args(str(32)),
  about: none,
  subscribe: args(str(40), bool),
};

const CH = {
  // Mayfair web app bridge (window.mayfairDesktop)
  'web:info': { roles: W, check: none },
  'web:notify': { roles: W, check: args((v) => obj(v) && str(200)(v.title || '') && str(1000)(v.body || '') && (v.url === undefined || str(2048)(v.url)) && (v.tag === undefined || str(100)(v.tag))) },
  'web:openBrowser': { roles: W, check: args(str(2048)) },
  'web:readFile': { roles: W, check: args(str(64)) },
  'web:pwRespond': { roles: W, check: args(str(64), (v) => Array.isArray(v) && v.length <= 20 && v.every((c) => obj(c) && str(300)(c.username || '') && str(1000)(c.password || ''))) },
  'web:pwListening': { roles: W, check: args(bool) },
  'web:extInstall': { roles: W, check: args(str(32), str(300), str(64)) },
  'web:extRemove': { roles: W, check: args(str(32)) },
  'web:extList': { roles: W, check: none },
  'web:appsList': { roles: W, check: none },
  'web:appsOpen': { roles: W, check: args(str(32)) },
  'web:badge': { roles: W, check: args((v) => Number.isInteger(v) && v >= 0 && v < 1e6) },
  'web:searchRespond': { roles: W, check: args(str(64), (v) => Array.isArray(v) && v.length <= 50) },
  'web:searchListening': { roles: W, check: args(bool) },

  // Mayfair Search start page (an internal page only; role 'start' is derived from the page URL)
  'search:config': { roles: ['start'], check: none },
  'search:setEngine': { roles: ['start'], check: args(str(20)) },
  'search:suggest': { roles: ['start'], check: args(str(120)) },
  'search:local': { roles: ['start'], check: args(str(120)) },
  'search:open': { roles: ['start'], check: args((v) => obj(v) && (v.kind === 'url' || v.kind === 'link') && str(2048)(v.value)) },
  'search:go': { roles: ['start'], check: args(str(2048)) },
  'search:command': { roles: ['start'], check: args(str(120)) },
  'search:online': { roles: ['start'], check: args((v) => obj(v) && oneOf('weather', 'define', 'wiki')(v.type) && str(80)(v.q)) },
  'search:panel': { roles: ['start'], check: args(oneOf('apps', 'bookmarks', 'history', 'privacy', 'settings')) },
  'search:home': { roles: ['start'], check: none },

  // untrusted sites
  'page:pwDetected': { roles: ['page', 'start'], check: args(bool) },
};
for (const [name, check] of Object.entries(BR)) CH['br:' + name] = { roles: W, check };

// Channels the main process sends to renderers (one way). Used by the preload to filter listeners.
// 'br:ev' carries every Browser bridge event as (name, payload); BR_EVENTS lists the names.
const BR_EVENTS = ['state', 'find-result', 'download', 'permission-request', 'permission-cancel', 'new-window-request', 'open-url', 'fullscreen', 'menu', 'panel-request', 'notice', 'tor', 'focus'];
const EVENTS = {
  web: ['file:open', 'deeplink', 'download:done', 'pw:request', 'search:query', 'br:ev'],
  start: [],
  page: ['pw:fill'],
};

function check(role, channel, a) {
  const def = Object.prototype.hasOwnProperty.call(CH, channel) ? CH[channel] : null;
  if (!def) return { ok: false, reason: 'unknown-channel' };
  if (!def.roles.includes(role)) return { ok: false, reason: 'role-not-allowed' };
  if (!Array.isArray(a)) return { ok: false, reason: 'bad-args' };
  let good = false;
  try { good = def.check(a); } catch { good = false; }
  return good ? { ok: true } : { ok: false, reason: 'bad-args' };
}
const channelsFor = (role) => Object.keys(CH).filter((c) => CH[c].roles.includes(role));

module.exports = { CH, BR, BR_EVENTS, EVENTS, check, channelsFor };
