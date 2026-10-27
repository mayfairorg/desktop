'use strict';
// Ghost virtual computer: the frame format on the network channel between the machine and Ghost's gateway.
//   type u8 | connection u32 (big endian) | payload length u16 | payload
// OPEN carries "host:port" (the machine asks Ghost to connect), DATA carries bytes either way, CLOSE ends one connection,
// OK and ERR answer an OPEN (ERR carries a plain reason). The guest side is tools/ghost-vm/guest/ghost-netd.py.
const T = { OPEN: 1, DATA: 2, CLOSE: 3, OK: 4, ERR: 5 };
const MAX_PAYLOAD = 16 * 1024;
const HEAD = 7;

function encode(type, conn, payload = Buffer.alloc(0)) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (p.length > MAX_PAYLOAD) throw new Error('frame too large');
  const h = Buffer.alloc(HEAD); h.writeUInt8(type, 0); h.writeUInt32BE(conn >>> 0, 1); h.writeUInt16BE(p.length, 5);
  return Buffer.concat([h, p]);
}

class FrameParser {
  constructor(onFrame, onError = () => {}) { this.onFrame = onFrame; this.onError = onError; this.buf = Buffer.alloc(0); this.dead = false; }
  push(chunk) {
    if (this.dead) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= HEAD) {
      const type = this.buf.readUInt8(0), conn = this.buf.readUInt32BE(1), len = this.buf.readUInt16BE(5);
      if (type < 1 || type > 5 || len > MAX_PAYLOAD) { this.dead = true; this.buf = Buffer.alloc(0); return this.onError(new Error('bad frame')); }
      if (this.buf.length < HEAD + len) break;
      const payload = this.buf.subarray(HEAD, HEAD + len);
      this.buf = this.buf.subarray(HEAD + len);
      this.onFrame({ type, conn, payload });
    }
  }
}
module.exports = { T, MAX_PAYLOAD, encode, FrameParser };
