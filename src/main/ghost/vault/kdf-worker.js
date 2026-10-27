'use strict';
const { parentPort, workerData } = require('node:worker_threads');
try {
  const { argon2id } = require('./argon2id');
  parentPort.postMessage({ key: argon2id({ password: Buffer.from(workerData.pw), salt: Buffer.from(workerData.salt), ...workerData.p, dkLen: 32 }) });
} catch (e) { parentPort.postMessage({ error: String(e && e.message || e) }); }
