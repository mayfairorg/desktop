'use strict';
const { JsonStore } = require('./stores');

const MIN = { width: 900, height: 600 };

// displays: [{ workArea: {x,y,width,height} }]. Returns bounds that are on a screen.
function sanitizeBounds(b, displays, fallback = { width: 1280, height: 800 }) {
  const wa0 = (displays[0] && displays[0].workArea) || { x: 0, y: 0, width: 1920, height: 1080 };
  const centre = (w, h) => ({ width: w, height: h, x: wa0.x + Math.round((wa0.width - w) / 2), y: wa0.y + Math.round((wa0.height - h) / 2) });
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return centre(Math.min(fallback.width, wa0.width), Math.min(fallback.height, wa0.height));
  const width = Math.max(MIN.width, Math.round(b.width));
  const height = Math.max(MIN.height, Math.round(b.height));
  // at least a 120x60 corner of the title area must be visible on some display
  const visible = displays.some(({ workArea: w }) => {
    const ox = Math.min(b.x + width, w.x + w.width) - Math.max(b.x, w.x);
    const oy = Math.min(b.y + 60, w.y + w.height) - Math.max(b.y, w.y);
    return ox >= 120 && oy >= 40;
  });
  if (!visible) return centre(Math.min(width, wa0.width), Math.min(height, wa0.height));
  return { x: Math.round(b.x), y: Math.round(b.y), width, height };
}

class WindowState {
  constructor(file, opts) { this.s = new JsonStore(file, () => ({}), opts); }
  get() { return { bounds: this.s.data.bounds || null, maximized: !!this.s.data.maximized, fullscreen: typeof this.s.data.fullscreen === 'boolean' ? this.s.data.fullscreen : null }; }
  update(patch) { Object.assign(this.s.data, patch); this.s.save(); }
  flush() { this.s.flush(); }
}
module.exports = { WindowState, sanitizeBounds, MIN };
