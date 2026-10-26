'use strict';
// A pop-up is allowed only if the user clicked or typed a moment ago.
function popupAllowed(now, lastInputAt, windowMs = 1500) {
  return Number.isFinite(lastInputAt) && lastInputAt > 0 && now - lastInputAt >= 0 && now - lastInputAt <= windowMs;
}

// Permission requests: Mayfair origins get a short list automatically; everything else asks.
const MAYFAIR_AUTO = ['notifications', 'clipboard-sanitized-write', 'fullscreen', 'window-management', 'clipboard-read', 'pointerLock'];
const NEVER = ['openExternal', 'hid', 'serial', 'usb', 'bluetooth', 'storage-access', 'top-level-storage-access'];
const ASKABLE = ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'fullscreen', 'pointerLock', 'idle-detection', 'display-capture'];
const NORMALISED = { 'clipboard-sanitized-write': null }; // always allowed, never prompts

// -> 'allow' | 'deny' | 'ask'
function decidePermission(permission, { mayfair, saved }) {
  if (permission === 'clipboard-sanitized-write') return 'allow';
  if (NEVER.includes(permission)) return 'deny';
  if (mayfair) {
    if (MAYFAIR_AUTO.includes(permission)) return 'allow';
    if (permission === 'media') return saved === 'deny' ? 'deny' : saved === 'allow' ? 'allow' : 'ask';
    return 'deny';
  }
  if (!ASKABLE.includes(permission)) return 'deny';
  return saved === 'allow' || saved === 'deny' ? saved : 'ask';
}

// Update host must not be a placeholder.
function updateFeedConfigured(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && !/(example|invalid|localhost|placeholder|your-)/i.test(u.hostname); } catch { return false; }
}

function chromeHeight(activeIsHome, settings, base = { tabs: 38, toolbar: 44, bar: 30 }) {
  const showToolbar = !(activeIsHome && settings.hideToolbarOnMayfair);
  return base.tabs + (showToolbar ? base.toolbar : 0) + (showToolbar && settings.bookmarksBar ? base.bar : 0);
}
module.exports = { popupAllowed, decidePermission, updateFeedConfigured, chromeHeight, NORMALISED };
