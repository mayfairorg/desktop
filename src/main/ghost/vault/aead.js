'use strict';
// Versioned, authenticated envelope. Layout (big-endian):
//   "MFV1" | version(1) | algorithm(1) | keyId(4) | iv(12) | ciphertext | tag(16)
// version 1, algorithm 1 = AES-256-GCM (node:crypto, OpenSSL/BoringSSL). The 10 header bytes plus a caller-supplied context string
// (record kind, namespace, id) are authenticated as AAD, so a record cannot be moved to another id, another namespace or another key id unnoticed.
// XChaCha20-Poly1305 is deliberately not used: it is not in node:crypto and would need a second crypto dependency for no gain here
// (every record has its own random 96-bit IV under a key that is rotated, far below the 2^32 messages-per-key bound NIST sets for random IVs).
const crypto = require('node:crypto');

class VaultError extends Error {
  constructor(code, message) { super(message || code); this.name = 'VaultError'; this.code = code; }
}
const MAGIC = Buffer.from('MFV1'), HDR = 10, IV = 12, TAG = 16, VERSION = 1, ALG_GCM = 1;

function seal(key, plain, context, keyId = 0) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new VaultError('bad-input', 'key must be 32 bytes');
  const hdr = Buffer.alloc(HDR); MAGIC.copy(hdr); hdr[4] = VERSION; hdr[5] = ALG_GCM; hdr.writeUInt32BE(keyId >>> 0, 6);
  const iv = crypto.randomBytes(IV);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
  c.setAAD(Buffer.concat([hdr, Buffer.from(String(context))]));
  const ct = Buffer.concat([c.update(Buffer.from(plain)), c.final()]);
  return Buffer.concat([hdr, iv, ct, c.getAuthTag()]);
}
function peek(env) {
  if (!Buffer.isBuffer(env) || env.length < HDR + IV + TAG || !env.subarray(0, 4).equals(MAGIC)) throw new VaultError('format', 'not a vault record');
  if (env[4] !== VERSION) throw new VaultError('version', 'unsupported vault record version ' + env[4]);
  if (env[5] !== ALG_GCM) throw new VaultError('version', 'unsupported cipher ' + env[5]);
  return { version: env[4], alg: env[5], keyId: env.readUInt32BE(6) };
}
function open(key, env, context) {
  peek(env);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, env.subarray(HDR, HDR + IV), { authTagLength: TAG });
    d.setAAD(Buffer.concat([env.subarray(0, HDR), Buffer.from(String(context))]));
    d.setAuthTag(env.subarray(env.length - TAG));
    return Buffer.concat([d.update(env.subarray(HDR + IV, env.length - TAG)), d.final()]);
  } catch { throw new VaultError('auth', 'authentication failed'); }
}
const hkdf = (ikm, info, salt = Buffer.alloc(32)) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));
const wipe = (b) => { if (Buffer.isBuffer(b)) b.fill(0); };
module.exports = { seal, open, peek, hkdf, wipe, VaultError, HDR };
