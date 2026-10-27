'use strict';
// BIP-39 construction for a 12-word recovery phrase: 128 bits of entropy + the first 4 bits of SHA-256(entropy) as checksum = 132 bits = 12 x 11-bit indexes.
// The word list (wordlist-en.txt, 2048 words, unique first four letters, 4-6 letters) is Mayfair's own, NOT the standard BIP-39 English list:
// phrases work with this app only, not with crypto wallets. The list id is stored beside each wrapped key, so replacing the list later is detected.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { VaultError } = require('./aead');

let LIST = null, ID = null;
function words() {
  if (LIST) return LIST;
  const txt = fs.readFileSync(path.join(__dirname, 'wordlist-en.txt'), 'utf8');
  const l = txt.split('\n').filter(Boolean);
  if (l.length !== 2048 || new Set(l.map((w) => w.slice(0, 4))).size !== 2048) throw new Error('word list is damaged');
  ID = crypto.createHash('sha256').update(txt).digest('hex').slice(0, 16);
  return (LIST = l);
}
const listId = () => { words(); return ID; };

function toWords(entropy) {
  if (!Buffer.isBuffer(entropy) || entropy.length !== 16) throw new VaultError('bad-input', 'entropy must be 16 bytes');
  const cs = crypto.createHash('sha256').update(entropy).digest()[0] >> 4;
  let bits = BigInt('0x' + entropy.toString('hex')) << 4n | BigInt(cs);
  const L = words(), out = [];
  for (let i = 11; i >= 0; i--) out.push(L[Number((bits >> BigInt(i * 11)) & 2047n)]);
  return out;
}
const normalise = (s) => (Array.isArray(s) ? s.join(' ') : String(s || '')).normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
function fromWords(input) {
  const w = normalise(input);
  if (w.length !== 12) throw new VaultError('bad-phrase', 'A recovery phrase has 12 words.');
  const L = words(); let bits = 0n;
  for (const x of w) {
    const i = L.indexOf(x);
    if (i < 0) throw new VaultError('bad-phrase', 'One of the words is not on the list.');
    bits = (bits << 11n) | BigInt(i);
  }
  const cs = Number(bits & 15n);
  const entropy = Buffer.from((bits >> 4n).toString(16).padStart(32, '0'), 'hex');
  if ((crypto.createHash('sha256').update(entropy).digest()[0] >> 4) !== cs) throw new VaultError('bad-phrase', 'The phrase has a typing mistake (checksum does not match).');
  return entropy;
}
const generate = () => { const e = crypto.randomBytes(16); return { entropy: e, words: toWords(e) }; };
module.exports = { generate, toWords, fromWords, normalise, words, listId };
