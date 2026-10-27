'use strict';
// Argon2id v1.3 (RFC 9106) in pure JavaScript, 32-bit word arithmetic. Verified against the RFC 9106 test vector in test/ghost-vault-crypto.test.js.
// It is the portable fallback: kdf.js prefers a native or WASM implementation when one is installed (same algorithm, same output).
const { blake2b } = require('./blake2b');

const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

// H' (variable-length hash), RFC 9106 section 3.3
function hPrime(input, T) {
  const pre = Buffer.concat([le32(T), input]);
  if (T <= 64) return blake2b(pre, T);
  const r = Math.ceil(T / 32) - 2;
  const out = Buffer.alloc(T);
  let v = blake2b(pre, 64); v.copy(out, 0, 0, 32);
  for (let i = 1; i < r; i++) { v = blake2b(v, 64); v.copy(out, i * 32, 0, 32); }
  v = blake2b(v, T - 32 * r); v.copy(out, 32 * r);
  return out;
}

// 32x32 -> 64 multiply. Results in the module variables MH (high) and ML (low).
let MH = 0, ML = 0;
function mul32(a, b) {
  const a0 = a & 0xffff, a1 = a >>> 16, b0 = b & 0xffff, b1 = b >>> 16;
  const p00 = a0 * b0, mid = a0 * b1 + a1 * b0, p11 = a1 * b1;
  const t = p00 + (mid % 65536) * 65536;
  ML = t >>> 0;
  MH = (p11 + Math.floor(mid / 65536) + Math.floor(t / 4294967296)) >>> 0;
}

// One BlaMka G-step on 64-bit words held as (lo, hi) pairs in v. Word w lives at v[2w], v[2w+1].
function gb(v, a, b, c, d) {
  a <<= 1; b <<= 1; c <<= 1; d <<= 1;
  let al = v[a], ah = v[a + 1], bl = v[b], bh = v[b + 1], cl = v[c], ch = v[c + 1], dl = v[d], dh = v[d + 1];
  let t, lo, hi;
  // a = a + b + 2*lo(a)*lo(b)
  mul32(al, bl); lo = ML; hi = MH; const m2h = ((hi << 1) | (lo >>> 31)) >>> 0, m2l = (lo << 1) >>> 0;
  t = al + bl + m2l; const nl = t >>> 0; ah = (ah + bh + m2h + Math.floor(t / 4294967296)) >>> 0; al = nl;
  // d = rotr(d ^ a, 32)
  t = dl ^ al; dl = (dh ^ ah) >>> 0; dh = t >>> 0;
  // c = c + d + 2*lo(c)*lo(d)
  mul32(cl, dl); lo = ML; hi = MH; let h2 = ((hi << 1) | (lo >>> 31)) >>> 0, l2 = (lo << 1) >>> 0;
  t = cl + dl + l2; cl = t >>> 0; ch = (ch + dh + h2 + Math.floor(t / 4294967296)) >>> 0;
  // b = rotr(b ^ c, 24)
  let xl = (bl ^ cl) >>> 0, xh = (bh ^ ch) >>> 0;
  bl = ((xl >>> 24) | (xh << 8)) >>> 0; bh = ((xh >>> 24) | (xl << 8)) >>> 0;
  // a = a + b + 2*lo(a)*lo(b)
  mul32(al, bl); lo = ML; hi = MH; h2 = ((hi << 1) | (lo >>> 31)) >>> 0; l2 = (lo << 1) >>> 0;
  t = al + bl + l2; al = t >>> 0; ah = (ah + bh + h2 + Math.floor(t / 4294967296)) >>> 0;
  // d = rotr(d ^ a, 16)
  xl = (dl ^ al) >>> 0; xh = (dh ^ ah) >>> 0;
  dl = ((xl >>> 16) | (xh << 16)) >>> 0; dh = ((xh >>> 16) | (xl << 16)) >>> 0;
  // c = c + d + 2*lo(c)*lo(d)
  mul32(cl, dl); lo = ML; hi = MH; h2 = ((hi << 1) | (lo >>> 31)) >>> 0; l2 = (lo << 1) >>> 0;
  t = cl + dl + l2; cl = t >>> 0; ch = (ch + dh + h2 + Math.floor(t / 4294967296)) >>> 0;
  // b = rotr(b ^ c, 63)
  xl = (bl ^ cl) >>> 0; xh = (bh ^ ch) >>> 0;
  bl = ((xl << 1) | (xh >>> 31)) >>> 0; bh = ((xh << 1) | (xl >>> 31)) >>> 0;
  v[a] = al; v[a + 1] = ah; v[b] = bl; v[b + 1] = bh; v[c] = cl; v[c + 1] = ch; v[d] = dl; v[d + 1] = dh;
}
function perm(v, i0, i1, i2, i3, i4, i5, i6, i7, i8, i9, i10, i11, i12, i13, i14, i15) {
  gb(v, i0, i4, i8, i12); gb(v, i1, i5, i9, i13); gb(v, i2, i6, i10, i14); gb(v, i3, i7, i11, i15);
  gb(v, i0, i5, i10, i15); gb(v, i1, i6, i11, i12); gb(v, i2, i7, i8, i13); gb(v, i3, i4, i9, i14);
}

// G(X, Y) -> out. All three are 256-entry Uint32Arrays (128 64-bit words). R and Q are scratch.
const R = new Uint32Array(256), Q = new Uint32Array(256);
function compressG(X, Y, out, xorInto) {
  for (let i = 0; i < 256; i++) R[i] = X[i] ^ Y[i];
  Q.set(R);
  for (let i = 0; i < 8; i++) { const o = 16 * i; perm(Q, o, o + 1, o + 2, o + 3, o + 4, o + 5, o + 6, o + 7, o + 8, o + 9, o + 10, o + 11, o + 12, o + 13, o + 14, o + 15); }
  for (let i = 0; i < 8; i++) { const o = 2 * i; perm(Q, o, o + 1, o + 16, o + 17, o + 32, o + 33, o + 48, o + 49, o + 64, o + 65, o + 80, o + 81, o + 96, o + 97, o + 112, o + 113); }
  if (xorInto) for (let i = 0; i < 256; i++) out[i] ^= R[i] ^ Q[i];
  else for (let i = 0; i < 256; i++) out[i] = R[i] ^ Q[i];
}

const ZERO = new Uint32Array(256);
function argon2id({ password, salt, secret = Buffer.alloc(0), ad = Buffer.alloc(0), t = 3, m = 65536, p = 1, dkLen = 32 }) {
  password = Buffer.from(password); salt = Buffer.from(salt); secret = Buffer.from(secret); ad = Buffer.from(ad);
  if (!(t >= 1 && p >= 1 && p <= 255 && m >= 8 * p && dkLen >= 4 && salt.length >= 8)) throw new RangeError('argon2id: bad parameters');
  const h0 = blake2b(Buffer.concat([le32(p), le32(dkLen), le32(m), le32(t), le32(0x13), le32(2),
    le32(password.length), password, le32(salt.length), salt, le32(secret.length), secret, le32(ad.length), ad]), 64);
  const mPrime = 4 * p * Math.floor(m / (4 * p));
  const q = mPrime / p, seg = q / 4;
  const B = new Uint32Array(mPrime * 256);
  const blk = (lane, col) => (lane * q + col) * 256;
  for (let lane = 0; lane < p; lane++) for (let c = 0; c < 2; c++) {
    const b = hPrime(Buffer.concat([h0, le32(c), le32(lane)]), 1024);
    const o = blk(lane, c);
    for (let i = 0; i < 256; i++) B[o + i] = b.readUInt32LE(i * 4);
  }
  const cur = new Uint32Array(256), prevB = new Uint32Array(256), refB = new Uint32Array(256);
  const inBlk = new Uint32Array(256), addr = new Uint32Array(256), tmp = new Uint32Array(256);
  for (let pass = 0; pass < t; pass++) for (let slice = 0; slice < 4; slice++) for (let lane = 0; lane < p; lane++) {
    const indep = pass === 0 && slice < 2;
    let counter = 0;
    const nextAddr = () => {
      counter++;
      inBlk.fill(0);
      inBlk[0] = pass; inBlk[2] = lane; inBlk[4] = slice; inBlk[6] = mPrime; inBlk[8] = t; inBlk[10] = 2; inBlk[12] = counter;
      compressG(ZERO, inBlk, tmp, false); compressG(ZERO, tmp, addr, false);
    };
    let start = 0;
    if (pass === 0 && slice === 0) start = 2;
    if (indep) nextAddr();
    for (let idx = start; idx < seg; idx++) {
      const col = slice * seg + idx;
      const prevCol = col === 0 ? q - 1 : col - 1;
      let j1, j2;
      if (indep) {
        if (idx > start && idx % 128 === 0) nextAddr();
        const k = idx % 128; j1 = addr[2 * k]; j2 = addr[2 * k + 1];
      } else {
        const po = blk(lane, prevCol); j1 = B[po]; j2 = B[po + 1];
      }
      const refLane = (pass === 0 && slice === 0) ? lane : j2 % p;
      let area;
      if (pass === 0) {
        if (slice === 0) area = idx - 1;
        else if (refLane === lane) area = slice * seg + idx - 1;
        else area = slice * seg + (idx === 0 ? -1 : 0);
      } else if (refLane === lane) area = q - seg + idx - 1;
      else area = q - seg + (idx === 0 ? -1 : 0);
      mul32(j1, j1); let x = MH;                       // (j1 * j1) >> 32
      mul32(area, x); const y = MH;                    // (area * x) >> 32
      const rel = area - 1 - y;
      const startPos = (pass !== 0 && slice !== 3) ? (slice + 1) * seg : 0;
      const refCol = (startPos + rel) % q;
      const po = blk(lane, prevCol), ro = blk(refLane, refCol), co = blk(lane, col);
      prevB.set(B.subarray(po, po + 256)); refB.set(B.subarray(ro, ro + 256));
      if (pass === 0) { compressG(prevB, refB, cur, false); }
      else { cur.set(B.subarray(co, co + 256)); compressG(prevB, refB, cur, true); }
      B.set(cur, co);
    }
  }
  const fin = new Uint32Array(256);
  for (let lane = 0; lane < p; lane++) { const o = blk(lane, q - 1); for (let i = 0; i < 256; i++) fin[i] ^= B[o + i]; }
  const fb = Buffer.alloc(1024);
  for (let i = 0; i < 256; i++) fb.writeUInt32LE(fin[i], i * 4);
  B.fill(0);
  return hPrime(fb, dkLen);
}
module.exports = { argon2id, hPrime };
