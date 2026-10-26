'use strict';
// The only IPC the app speaks. Every channel names who may call it and checks its arguments.
// Roles: 'chrome' (tab strip + toolbar), 'overlay' (panels), 'web' (the Mayfair tab, Mayfair origin only),
// 'page' (any other website: password-field detection only).
const str = (max = 2048) => (v) => typeof v === 'string' && v.length <= max;
const num = (v) => Number.isFinite(v);
const bool = (v) => typeof v === 'boolean';
const id = (v) => Number.isInteger(v) && v > 0 && v < 1e9;
const none = (a) => a.length === 0;
const args = (...checks) => (a) => a.length === checks.length && checks.every((c, i) => c(a[i]));
const obj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (...xs) => (v) => xs.includes(v);

const UI = ['chrome', 'overlay'];
const CH = {
  // tabs
  'tab:new': { roles: UI, check: (a) => a.length <= 1 && (a.length === 0 || (obj(a[0]) && (a[0].url === undefined || str()(a[0].url)) && (a[0].private === undefined || bool(a[0].private)))) },
  'tab:close': { roles: UI, check: args(id) },
  'tab:closeOthers': { roles: UI, check: args(id) },
  'tab:activate': { roles: UI, check: args(id) },
  'tab:move': { roles: UI, check: args(id, Number.isInteger) },
  'tab:go': { roles: UI, check: args(str(2048)) },
  'tab:back': { roles: UI, check: none },
  'tab:forward': { roles: UI, check: none },
  'tab:reload': { roles: UI, check: (a) => a.length <= 1 },
  'tab:stop': { roles: UI, check: none },
  'tab:list': { roles: UI, check: none },
  'tab:duplicate': { roles: UI, check: args(id) },
  // bookmarks and history
  'bm:list': { roles: UI, check: none },
  'bm:toggle': { roles: UI, check: none },
  'bm:remove': { roles: UI, check: args(str(64)) },
  'bm:rename': { roles: UI, check: args(str(64), str(200)) },
  'hist:list': { roles: UI, check: (a) => a.length <= 1 && (a.length === 0 || str(200)(a[0])) },
  'hist:remove': { roles: UI, check: args(str(2048)) },
  'hist:clear': { roles: UI, check: (a) => a.length <= 1 && (a.length === 0 || num(a[0])) },
  // panels, find, zoom
  'panel:open': { roles: UI, check: args(oneOf('menu', 'privacy', 'about', 'apps', 'bookmarks', 'history', 'downloads', 'site', 'settings', 'find', 'permissions')) },
  'panel:close': { roles: UI, check: none },
  'find:run': { roles: ['overlay'], check: (a) => a.length === 3 && str(200)(a[0]) && bool(a[1]) && bool(a[2]) },
  'find:stop': { roles: ['overlay'], check: none },
  'zoom:set': { roles: UI, check: args(oneOf('in', 'out', 'reset')) },
  'page:fullscreenToggle': { roles: UI, check: none },
  // privacy panel
  'privacy:get': { roles: UI, check: none },
  'privacy:set': { roles: UI, check: args(obj) },
  'privacy:setProxy': { roles: UI, check: args(oneOf('off', 'http', 'socks5'), str(253), (v) => Number.isInteger(v) && v >= 0 && v <= 65535) },
  'tor:newTab': { roles: UI, check: none },
  'tor:newIdentity': { roles: UI, check: none },
  'tor:stop': { roles: UI, check: none },
  // web apps catalogue
  'apps:list': { roles: UI, check: none },
  'apps:open': { roles: UI, check: args(str(32)) },
  'apps:openWindow': { roles: UI, check: args(str(32)) },
  'apps:add': { roles: UI, check: args(str(32)) },
  'apps:remove': { roles: UI, check: args(str(32)) },
  'apps:reset': { roles: UI, check: args(str(32)) },
  'apps:pin': { roles: UI, check: args(str(32), bool) },
  'apps:shortcut': { roles: UI, check: args(str(32)) },
  // downloads
  'dl:list': { roles: UI, check: none },
  'dl:cancel': { roles: UI, check: args(str(64)) },
  'dl:show': { roles: UI, check: args(str(64)) },
  'dl:open': { roles: UI, check: args(str(64)) },
  'dl:clear': { roles: UI, check: none },
  // settings and permissions
  'settings:get': { roles: UI, check: none },
  'settings:set': { roles: UI, check: args(obj) },
  'settings:pickFolder': { roles: UI, check: none },
  'perm:answer': { roles: ['overlay'], check: args(str(64), oneOf('allow', 'deny'), bool) },
  'perm:site': { roles: UI, check: none },
  'perm:setSite': { roles: UI, check: args(str(300), str(40), oneOf('allow', 'deny', 'ask')) },
  'perm:reset': { roles: UI, check: args(str(300)) },
  'popup:allowOnce': { roles: UI, check: none },
  'privacy:clearBrowsing': { roles: UI, check: none },
  'adblock:toggleSite': { roles: UI, check: none },
  'adblock:updateNow': { roles: UI, check: none },
  'about:get': { roles: UI, check: none },
  'pw:fill': { roles: UI, check: none },
  'app:minimize': { roles: UI, check: none },
  'app:toggleFullscreen': { roles: UI, check: none },
  'app:quit': { roles: UI, check: none },
  'ui:ready': { roles: UI, check: none },

  // Mayfair web app bridge (window.mayfairDesktop)
  'web:info': { roles: ['web'], check: none },
  'web:notify': { roles: ['web'], check: args((v) => obj(v) && str(200)(v.title || '') && str(1000)(v.body || '') && (v.url === undefined || str(2048)(v.url)) && (v.tag === undefined || str(100)(v.tag))) },
  'web:openBrowser': { roles: ['web'], check: args(str(2048)) },
  'web:readFile': { roles: ['web'], check: args(str(64)) },
  'web:pwRespond': { roles: ['web'], check: args(str(64), (v) => Array.isArray(v) && v.length <= 20 && v.every((c) => obj(c) && str(300)(c.username || '') && str(1000)(c.password || ''))) },
  'web:pwListening': { roles: ['web'], check: args(bool) },
  'web:extInstall': { roles: ['web'], check: args(str(32), str(300), str(64)) },
  'web:extRemove': { roles: ['web'], check: args(str(32)) },
  'web:extList': { roles: ['web'], check: none },
  'web:appsList': { roles: ['web'], check: none },
  'web:appsOpen': { roles: ['web'], check: args(str(32)) },
  'web:badge': { roles: ['web'], check: args((v) => Number.isInteger(v) && v >= 0 && v < 1e6) },

  'web:searchRespond': { roles: ['web'], check: args(str(64), (v) => Array.isArray(v) && v.length <= 50) },
  'web:searchListening': { roles: ['web'], check: args(bool) },

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
  'page:pwDetected': { roles: ['page'], check: args(bool) },
};

// Channels the main process sends to renderers (one way). Used by preloads to filter listeners.
const EVENTS = {
  chrome: ['state', 'focus-address'],
  overlay: ['panel', 'state', 'downloads', 'prompts', 'find:result'],
  web: ['file:open', 'deeplink', 'download:done', 'pw:request', 'search:query'],
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

module.exports = { CH, EVENTS, check, channelsFor };
