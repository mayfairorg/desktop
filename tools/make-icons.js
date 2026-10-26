'use strict';
// Draws the app and tray icons with no dependencies (PNG written by hand).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const M = [[.2,.78],[.2,.24],[.3,.24],[.5,.52],[.7,.24],[.8,.24],[.8,.78],[.69,.78],[.69,.42],[.52,.66],[.48,.66],[.31,.42],[.31,.78]];
const inPoly = (x, y, p) => { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { const [xi, yi] = p[i], [xj, yj] = p[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
const inRound = (x, y, r) => { const cx = Math.min(Math.max(x, r), 1 - r), cy = Math.min(Math.max(y, r), 1 - r); return (x - cx) ** 2 + (y - cy) ** 2 <= r * r; };

function render(size, { bg, fg, round }) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 3;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let a = 0, r = 0, g = 0, b = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + .5) / SS) / size, y = (py + (sy + .5) / SS) / size;
      const inShape = round ? inRound(x, y, .22) : true;
      if (!inShape) continue;
      const glyph = inPoly(x, y, M);
      const c = glyph ? fg : bg;
      if (!c) continue;
      a += c[3]; r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3];
    }
    const n = SS * SS, i = (py * size + px) * 4;
    if (a) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; buf[i + 3] = Math.round(a / n); }
  }
  return buf;
}
function png(size, rgba) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const out = (f, size, o) => { fs.writeFileSync(f, png(size, render(size, o))); console.log('wrote', path.relative(process.cwd(), f)); };
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
const amber = [255, 168, 0, 255], ink = [10, 10, 10, 255];
out(path.join(root, 'build', 'icon.png'), 1024, { bg: ink, fg: amber, round: true });
out(path.join(root, 'assets', 'icon.png'), 256, { bg: ink, fg: amber, round: true });
out(path.join(root, 'assets', 'tray.png'), 32, { bg: null, fg: [255, 255, 255, 255], round: false });
