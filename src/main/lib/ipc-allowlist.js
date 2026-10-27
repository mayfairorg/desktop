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
const optGid = (v) => v === undefined || id(v);
const appOpt = (v) => obj(v) && (v.app === undefined || /^[a-z][a-z0-9-]{0,31}$/.test(v.app)) && (v.limit === undefined || (int(v.limit) && v.limit > 0 && v.limit <= 5000)) && (v.since === undefined || num(v.since));
const gidObj = (v) => obj(v) && optGid(v.gid);
const AF_KEYS = ['email', 'username', 'name', 'givenName', 'familyName', 'tel', 'address', 'address2', 'postalCode', 'city', 'region', 'country', 'organization', 'birthday'];
const afFields = (v) => obj(v) && Object.keys(v).length > 0 && Object.keys(v).length <= 14 && Object.entries(v).every(([k, x]) => AF_KEYS.includes(k) && str(300)(x) && x.length > 0);
const W = ['web'];

// Browser bridge: window.mayfairDesktop.browser.<name>  <->  channel 'br:<name>' (a dotted name stays dotted: 'br:bookmarks.list')
const BR = {
  ready: argsOpt(0, gidObj), setBounds: args((v) => obj(v) && num(v.x) && num(v.y) && num(v.w) && num(v.h) && optBool(v.visible) && optGid(v.gid)), setOccluded: argsOpt(1, bool, (v) => obj(v) && optBool(v.focus) && optBool(v.capture) && optGid(v.gid)), capture: argsOpt(0, gidObj),
  'windows.create': argsOpt(0, (v) => obj(v) && (v.webapp === undefined || str(32)(v.webapp))), 'windows.close': args(id), 'windows.focus': args(id), 'windows.list': none, moveTab: argsOpt(2, id, (v) => v === 'new' || id(v), (v) => obj(v) && (v.index === undefined || (int(v.index) && v.index >= 0 && v.index < 1e4))),
  focus: args(id),
  newTab: argsOpt(0, (v) => obj(v) && optStr(2048)(v.url) && optBool(v.private) && optBool(v.tor) && optBool(v.background) && optGid(v.gid) && (v.webapp === undefined || v.webapp === null || str(32)(v.webapp))),
  closeTab: args(id), activate: args(id), move: args(id, int), duplicate: args(id), pin: args(id, bool), mute: args(id, bool), closeOthers: args(id), reopenClosed: argsOpt(0, gidObj),
  go: args(id, str(2048)), back: args(id), forward: args(id), reload: argsOpt(1, id, bool), stop: args(id), home: none, suggest: argsOpt(1, str(200), appOpt),
  find: argsOpt(2, id, str(200), (v) => obj(v) && optBool(v.forward) && optBool(v.findNext) && optBool(v.matchCase)), stopFind: args(id),
  zoom: args(id, (v) => v === 'reset' || (Number.isInteger(v) && v >= -10 && v <= 10)), print: args(id), savePage: args(id), devtools: args(id),
  'network.block': args(bool),
  fullscreen: argsOpt(1, bool, gidObj), windowFullscreen: argsOpt(0, bool), fillPassword: args(id),
  'bookmarks.list': none, 'bookmarks.add': args((v) => obj(v) && str(2048)(v.url) && optStr(200)(v.title)), 'bookmarks.remove': args(str(64)),
  'bookmarks.update': args(str(64), (v) => obj(v) && optStr(2048)(v.url) && optStr(200)(v.title)),
  'bookmarks.import': args((v) => Array.isArray(v) && v.length <= 5000 && v.every((x) => obj(x) && str(2048)(x.url) && optStr(200)(x.title))),
  'history.list': argsOpt(0, (v) => (int(v) && v > 0 && v <= 5000) || appOpt(v), appOpt), 'history.search': argsOpt(1, str(200), (v) => (int(v) && v > 0 && v <= 1000) || appOpt(v), appOpt), 'history.remove': argsOpt(1, str(2048), appOpt), 'history.clear': argsOpt(0, (v) => num(v) || appOpt(v), appOpt),
  'webapps.match': args(str(2048)),
  'history.import': argsOpt(1, (v) => Array.isArray(v) && v.length <= 5000 && v.every((x) => obj(x) && (x.kind === undefined || x.kind === 'visit' || x.kind === 'search') && (x.id === undefined || str(64)(x.id)) && (x.url === undefined || str(2048)(x.url)) && (x.q === undefined || str(300)(x.q)) && (x.title === undefined || str(300)(x.title)) && num(x.t)), appOpt),
  'history.syncState': none,
  'autofill.take': args(str(64)), 'autofill.dismiss': argsOpt(1, str(64), (v) => obj(v) && optBool(v.never)), 'autofill.fill': args(id, afFields), 'autofill.answer': args(str(64), (v) => v === null || (str(300)(v) && v.length > 0)),
  'downloads.list': none, 'downloads.open': args(str(64)), 'downloads.show': args(str(64)), 'downloads.cancel': args(str(64)), 'downloads.clear': none,
  'settings.get': none, 'settings.set': args(obj), 'settings.setProxy': args(oneOf('off', 'http', 'socks5'), str(253), (v) => int(v) && v >= 0 && v <= 65535), 'settings.pickFolder': none,
  'settings.clearBrowsingData': argsOpt(0, (v) => obj(v) && optBool(v.history) && optBool(v.downloads) && optBool(v.cookies) && optBool(v.cache) && optBool(v.webapps)),
  'passwords.take': args(str(64)), 'passwords.dismiss': argsOpt(1, str(64), (v) => obj(v) && optBool(v.never)),
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
  // a login form was submitted (or its password field cleared after a script login): kept in memory by main, offered to Mayfair Passwords
  'page:pwSubmit': { roles: ['page'], check: args((v) => obj(v) && str(300)(v.username) && typeof v.password === 'string' && v.password.length > 0 && v.password.length <= 1000 && oneOf('new', 'change')(v.kind) && bool(v.settled)) },
  'page:pwFocus': { roles: ['page'], check: none },
  // identity details of a submitted form (never passwords, cards or ID numbers): kept in memory by main, offered to the Mayfair ID
  'page:afSubmit': { roles: ['page'], check: args(afFields) },
  'page:afFocus': { roles: ['page'], check: args(oneOf('email', 'username', 'name', 'tel', 'address')) },
};
for (const [name, check] of Object.entries(BR)) CH['br:' + name] = { roles: W, check };

// Channels the main process sends to renderers (one way). Used by the preload to filter listeners.
// 'br:ev' carries every Browser bridge event as (name, payload); BR_EVENTS lists the names.
const BR_EVENTS = ['state', 'find-result', 'download', 'permission-request', 'permission-cancel', 'new-window-request', 'open-url', 'fullscreen', 'menu', 'panel-request', 'notice', 'tor', 'focus', 'windows', 'password-offer', 'password-offer-cancel', 'password-field', 'history-add', 'history-remove', 'history-clear', 'autofill-offer', 'autofill-offer-cancel', 'autofill-request', 'details-used'];
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

module.exports = { AF_KEYS, CH, BR, BR_EVENTS, EVENTS, check, channelsFor };
