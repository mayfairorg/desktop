'use strict';
// Web apps stay signed in: the cookie rules, pure so they can be tested without Electron.
// A site's sign-in cookie is often a "session cookie" (no expiry) that a browser drops when it closes. Web app sessions
// give such cookies the longest life Chromium allows (400 days) and push any cookie that would expire within 90 days
// out again whenever the app is opened (and daily while running). Only web app sessions, never normal, private or Tor tabs.
const DAY = 86400;
const MAX_DAYS = 400, REFRESH_WITHIN_DAYS = 90;

// Electron cookie object -> details for cookies.set with a long expiry, or null when it needs nothing.
// now is in seconds (Chromium's expirationDate unit).
function keepCookie(c, now = Date.now() / 1000) {
  if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string') return null;
  const exp = now + MAX_DAYS * DAY;
  const session = typeof c.expirationDate !== 'number' || c.session === true;
  if (!session && c.expirationDate - now > REFRESH_WITHIN_DAYS * DAY) return null;
  if (!session && c.expirationDate <= now) return null;                 // already expired: leave it to Chromium
  const host = c.domain.replace(/^\./, '');
  const d = {
    url: (c.secure ? 'https://' : 'http://') + host + (c.path || '/'),
    name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || 'unspecified', expirationDate: exp,
  };
  if (!c.hostOnly && c.domain.startsWith('.')) d.domain = c.domain;      // domain cookie keeps its domain; host-only cookies must not get one
  return d;
}
// A 'changed' event of session.cookies: rewrite only cookies that were added or updated by the site itself
const shouldRewrite = (removed, cause) => !removed && cause === 'explicit';
module.exports = { keepCookie, shouldRewrite, MAX_DAYS, REFRESH_WITHIN_DAYS };
