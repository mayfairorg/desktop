'use strict';
const { isMayfairUrl } = require('./origins');

// Hosts-file style: one domain per line, '#' comments, optional '0.0.0.0 ' prefix.
function parseList(text) {
  const set = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const l = line.replace(/#.*/, '').trim().toLowerCase();
    if (!l) continue;
    const d = l.split(/\s+/).pop();
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) set.add(d);
  }
  return set;
}

class Blocker {
  constructor(domains) { this.domains = domains instanceof Set ? domains : new Set(domains || []); this.allowSites = new Set(); }
  get size() { return this.domains.size; }
  matches(host) {
    let h = String(host).toLowerCase();
    while (h.includes('.')) { if (this.domains.has(h)) return true; h = h.slice(h.indexOf('.') + 1); }
    return false;
  }
  // pageUrl: the top-level page the request belongs to (may be empty for main-frame loads)
  shouldBlock(requestUrl, { pageUrl = '', resourceType = '' } = {}) {
    if (resourceType === 'mainFrame') return false; // never block what the user typed
    if (isMayfairUrl(requestUrl) || isMayfairUrl(pageUrl)) return false;
    let u; try { u = new URL(requestUrl); } catch { return false; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    let page = ''; try { page = pageUrl ? new URL(pageUrl).hostname : ''; } catch { /* none */ }
    if (page && this.allowSites.has(page)) return false;
    if (page && (u.hostname === page || u.hostname.endsWith('.' + page))) return false; // first party
    return this.matches(u.hostname);
  }
  setSiteAllowed(host, allowed) { allowed ? this.allowSites.add(host) : this.allowSites.delete(host); }
}
module.exports = { Blocker, parseList };
