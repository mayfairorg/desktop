'use strict';
// Passphrase -> 32-byte key with Argon2id. Implementation order (same algorithm and output in all three, so a vault file opens anywhere):
//   1. "argon2" (node-argon2: native prebuilds for win32/darwin/linux x64+arm64, libargon2 reference code), if installed in the app
//   2. "hash-wasm" (WASM Argon2, no native code, runs on every platform Electron does), if installed
//   3. the bundled pure-JS implementation (argon2id.js, RFC 9106 test vector checked), run in a worker thread so the window does not freeze (about 5 s for the default cost)
// None of 1 and 2 is bundled in this copy (no registry access when it was built): install one with `npm i argon2` or `npm i hash-wasm` to use it.
const path = require('node:path');
const { VaultError } = require('./aead');
const DEFAULT = Object.freeze({ m: 65536, t: 3, p: 1 });          // 64 MiB, 3 passes, 1 lane
const LIMITS = Object.freeze({ minM: 19456, maxM: 262144, maxT: 10, maxP: 4 });
let lastImpl = null;

function check(p, allowWeak) {
  const ok = p && Number.isInteger(p.m) && Number.isInteger(p.t) && Number.isInteger(p.p) && p.t >= 1 && p.t <= LIMITS.maxT && p.p >= 1 && p.p <= LIMITS.maxP &&
    p.m >= (allowWeak ? 64 : LIMITS.minM) && p.m <= LIMITS.maxM && p.m >= 8 * p.p;
  if (!ok) throw new VaultError('bad-kdf', 'The key-derivation settings are outside the allowed range.');
  return { m: p.m, t: p.t, p: p.p };
}
async function viaNative(pw, salt, p) {
  let a; try { a = require('argon2'); } catch { return null; }
  const raw = await a.hash(pw, { type: a.argon2id, salt, raw: true, memoryCost: p.m, timeCost: p.t, parallelism: p.p, hashLength: 32 });
  return { key: Buffer.from(raw), impl: 'argon2 (native)' };
}
async function viaWasm(pw, salt, p) {
  let h; try { h = require('hash-wasm'); } catch { return null; }
  const raw = await h.argon2id({ password: pw, salt, parallelism: p.p, iterations: p.t, memorySize: p.m, hashLength: 32, outputType: 'binary' });
  return { key: Buffer.from(raw), impl: 'hash-wasm (WASM)' };
}
function viaJs(pw, salt, p) {
  return new Promise((resolve, reject) => {
    const inline = () => { try { resolve({ key: require('./argon2id').argon2id({ password: pw, salt, ...p, dkLen: 32 }), impl: 'pure JS (inline)' }); } catch (e) { reject(e); } };
    let W; try { ({ Worker: W } = require('node:worker_threads')); } catch { return inline(); }
    let w; try { w = new W(path.join(__dirname, 'kdf-worker.js'), { workerData: { pw, salt, p } }); } catch { return inline(); }
    let done = false;
    w.once('message', (m) => { done = true; m.error ? reject(new VaultError('kdf', m.error)) : resolve({ key: Buffer.from(m.key), impl: 'pure JS (worker)' }); });
    w.once('error', () => { if (!done) { done = true; inline(); } });
  });
}
// pass: string (already NFKC-normalised by the caller), salt: Buffer >= 16 bytes
async function deriveKey(pass, salt, params = DEFAULT, { allowWeak = false, prefer = null } = {}) {
  const p = check(params, allowWeak), pw = Buffer.from(pass, 'utf8');
  let r = null;
  if (prefer !== 'js') { try { r = await viaNative(pw, salt, p); } catch { r = null; } if (!r) { try { r = await viaWasm(pw, salt, p); } catch { r = null; } } }
  if (!r) r = await viaJs(pw, salt, p);
  lastImpl = r.impl; pw.fill(0);
  return r.key;
}
module.exports = { deriveKey, DEFAULT, LIMITS, check, implementation: () => lastImpl };
