'use strict';
// Pure URL and origin rules. No Electron imports, so node:test can run them.

const MAYFAIR_ORIGINS = Object.freeze([
  'https://cloud.mayfairmail.com',
  'https://mayfairmail.com',
]);
const HOME_URL = 'https://cloud.mayfairmail.com/';

const SEARCH_ENGINES = Object.freeze({
  duckduckgo: 'https://duckduckgo.com/?q=%s',
  startpage: 'https://www.startpage.com/do/search?q=%s',
  brave: 'https://search.brave.com/search?q=%s',
  google: 'https://www.google.com/search?q=%s',
  bing: 'https://www.bing.com/search?q=%s',
  ecosia: 'https://www.ecosia.org/search?q=%s',
  qwant: 'https://www.qwant.com/?q=%s',
});
const ENGINE_NAMES = Object.freeze({ duckduckgo: 'DuckDuckGo', brave: 'Brave Search', google: 'Google', bing: 'Bing', startpage: 'Startpage', ecosia: 'Ecosia', qwant: 'Qwant' });

function parse(url) {
  try { return new URL(String(url)); } catch { return null; }
}

function isMayfairUrl(url) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  return MAYFAIR_ORIGINS.includes(u.origin);
}

// What should a locked (Mayfair) tab do with a navigation target?
//  'allow'  stay in the tab
//  'newtab' open in a new browser tab
//  'external' hand to the operating system (mailto:, tel:)
//  'block'  refuse (javascript:, file:, data:, unknown schemes)
function classifyNavigation(url, { locked }) {
  const u = parse(url);
  if (!u) return 'block';
  const p = u.protocol;
  if (p === 'mailto:' || p === 'tel:') return 'external';
  if (p !== 'https:' && p !== 'http:') return 'block';
  if (!locked) return 'allow';
  return isMayfairUrl(url) ? 'allow' : 'newtab';
}

const HOSTLIKE = /^(localhost|(\d{1,3}\.){3}\d{1,3}|([a-z0-9-]+\.)+[a-z]{2,})(:\d+)?([/?#].*)?$/i;

// Address bar text -> a loadable URL. Anything that does not look like a
// site becomes a search.
function normalizeInput(text, engine = 'google') {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const tpl = SEARCH_ENGINES[engine] || SEARCH_ENGINES.google;
  const search = () => tpl.replace('%s', encodeURIComponent(raw));
  if (/^(javascript|data|file|vbscript|blob):/i.test(raw)) return search();
  if (/^https?:\/\//i.test(raw)) {
    const u = parse(raw);
    return u ? u.toString() : search();
  }
  if (/\s/.test(raw)) return search();
  if (HOSTLIKE.test(raw)) {
    const insecureLocal = /^(localhost|(\d{1,3}\.){3}\d{1,3})(:|\/|$)/i.test(raw);
    const u = parse((insecureLocal ? 'http://' : 'https://') + raw);
    return u ? u.toString() : search();
  }
  return search();
}

// true when typed text is a web search (not an address): same branches as normalizeInput that end in the search engine
function isSearchInput(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return false;
  if (/^(javascript|data|file|vbscript|blob):/i.test(raw)) return true;
  if (/^https?:\/\//i.test(raw)) return !parse(raw);
  if (/\s/.test(raw)) return true;
  if (HOSTLIKE.test(raw)) return false;
  return true;
}

// 'secure' https, 'insecure' http, 'internal' app pages, 'none' otherwise.
function httpsState(url) {
  const u = parse(url);
  if (!u) return 'none';
  if (u.protocol === 'https:') return 'secure';
  if (u.protocol === 'http:') return 'insecure';
  if (u.protocol === 'file:') return 'internal';
  return 'none';
}

function siteKey(url) {
  const u = parse(url);
  return u && (u.protocol === 'https:' || u.protocol === 'http:') ? u.origin : null;
}

// mayfair://open?path=/Drive/a.docx  ->  https://cloud.mayfairmail.com/#mf=%2Fopen%3Fpath%3D...
// The deep link never chooses a host: it is always the Cloud origin.
function parseDeepLink(link) {
  const u = parse(link);
  if (!u || u.protocol !== 'mayfair:') return null;
  const action = (u.hostname || '').toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(action)) return null;
  const params = {};
  for (const [k, v] of u.searchParams) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(k)) continue;
    params[k] = v.slice(0, 2048);
  }
  const path = u.pathname && u.pathname !== '/' ? u.pathname.slice(0, 512) : '';
  const hash = '#mf=' + encodeURIComponent('/' + action + path + (u.search ? '?' + new URLSearchParams(params).toString() : ''));
  return { action, path, params, url: HOME_URL + hash };
}

function findDeepLink(argv) {
  return (argv || []).find((a) => typeof a === 'string' && /^mayfair:\/\//i.test(a)) || null;
}

const FILE_EXTENSIONS = Object.freeze([
  'docx', 'xlsx', 'pptx', 'pdf', 'csv', 'md', 'txt',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
]);

function isHandledFile(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || ''));
  return !!m && FILE_EXTENSIONS.includes(m[1].toLowerCase());
}

function findFileArgs(argv) {
  return (argv || []).filter((a) => typeof a === 'string' && !a.startsWith('-') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(a) && isHandledFile(a));
}

module.exports = { isSearchInput,
  MAYFAIR_ORIGINS, HOME_URL, SEARCH_ENGINES, ENGINE_NAMES, FILE_EXTENSIONS,
  isMayfairUrl, classifyNavigation, normalizeInput, httpsState, siteKey,
  parseDeepLink, findDeepLink, isHandledFile, findFileArgs,
};
