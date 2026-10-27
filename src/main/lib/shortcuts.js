'use strict';
// Browser keyboard shortcuts. Pure: maps a key event (Electron before-input-event shape) to a menu action name.
// The native menu shows these keys but does not register them (so Mayfair's own apps keep Ctrl+F, Ctrl+Y, Ctrl+D...);
// a page tab that has keyboard focus reports them through this table instead.
function actionForKey(input, platform = process.platform) {
  if (!input || input.type !== 'keyDown') return null;
  const mac = platform === 'darwin';
  const key = String(input.key || '');
  const k = key.toLowerCase();
  const mod = mac ? !!input.meta : !!input.control;
  const ctrl = !!input.control, alt = !!input.alt, shift = !!input.shift;
  if (ctrl && !alt && k === 'tab') return shift ? 'prevTab' : 'nextTab';
  if (ctrl && !alt && !shift && (key === 'PageDown' || key === 'PageUp')) return key === 'PageDown' ? 'nextTab' : 'prevTab';
  if (key === 'F5') return ctrl || shift ? 'hardReload' : 'reload';
  if (alt && !mod && !shift && key === 'ArrowLeft') return 'back';
  if (alt && !mod && !shift && key === 'ArrowRight') return 'forward';
  if (!mod || alt && !(k === 't')) return null;
  if (mod && alt && !shift && k === 't') return 'torTab';
  if (alt) return null;
  if (shift) {
    return { n: 'newPrivate', t: 'reopenClosed', r: 'hardReload', o: 'bookmarks', p: 'privacy', a: 'apps', h: 'home', delete: 'clearData' }[k] || null;
  }
  if (/^[1-9]$/.test(k)) return 'tab' + k;
  if (mac && key === '[') return 'back';
  if (mac && key === ']') return 'forward';
  return { t: 'newTab', w: 'closeTab', r: 'reload', l: 'address', f: 'find', d: 'bookmark', y: 'history', j: 'downloads', ',': 'settings', '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut', _: 'zoomOut', '0': 'zoomReset', p: 'print' }[k] || null;
}
module.exports = { actionForKey };
