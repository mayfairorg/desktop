'use strict';
// Ghost virtual computer: name lookups for the "direct" route. Same rule as the Ghost browser's direct route: every lookup goes to ONE
// DNS-over-HTTPS server (the browser's provider list), and there is no fallback to the computer's own resolver. If the server cannot
// be reached the connection fails.
const PV = require('../../lib/privacy');

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function query(name, type) {
  const parts = [Buffer.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0])];
  for (const l of name.split('.')) { const b = Buffer.from(l, 'ascii'); if (!b.length || b.length > 63) throw new Error('bad name'); parts.push(Buffer.from([b.length]), b); }
  const tail = Buffer.alloc(5); tail.writeUInt16BE(type, 1); tail.writeUInt16BE(1, 3);
  parts.push(tail);
  return Buffer.concat(parts);
}
function skipName(buf, p) {
  for (let n = 0; n < 128; n++) {
    if (p >= buf.length) throw new Error('short');
    const l = buf[p];
    if (l === 0) return p + 1;
    if ((l & 0xc0) === 0xc0) return p + 2;
    p += 1 + l;
  }
  throw new Error('bad name');
}
function ip6(b) { const g = []; for (let i = 0; i < 16; i += 2) g.push(b.readUInt16BE(i).toString(16)); return g.join(':'); }
// -> {rcode, addrs:[{ip, ttl}]}
function parse(buf) {
  if (buf.length < 12) throw new Error('short');
  const rcode = buf.readUInt16BE(2) & 15, qd = buf.readUInt16BE(4), an = buf.readUInt16BE(6);
  let p = 12;
  for (let i = 0; i < qd; i++) p = skipName(buf, p) + 4;
  const addrs = [];
  for (let i = 0; i < an; i++) {
    p = skipName(buf, p);
    if (p + 10 > buf.length) throw new Error('short');
    const type = buf.readUInt16BE(p), ttl = buf.readUInt32BE(p + 4), rl = buf.readUInt16BE(p + 8); p += 10;
    if (p + rl > buf.length) throw new Error('short');
    if (type === 1 && rl === 4) addrs.push({ ip: [...buf.subarray(p, p + 4)].join('.'), ttl });
    else if (type === 28 && rl === 16) addrs.push({ ip: ip6(buf.subarray(p, p + 16)), ttl });
    p += rl;
  }
  return { rcode, addrs };
}

function createResolver({ fetchImpl = (typeof fetch === 'function' ? fetch : null), provider = 'cloudflare', now = Date.now } = {}) {
  const prov = PV.DNS_PROVIDERS[provider] || PV.DNS_PROVIDERS.cloudflare;
  const cache = new Map();
  async function one(name, type) {
    if (!fetchImpl) throw new Error('no network client');
    const r = await fetchImpl(prov.url + '?dns=' + b64url(query(name, type)), { headers: { accept: 'application/dns-message' }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('the DNS server answered ' + r.status);
    return parse(Buffer.from(await r.arrayBuffer()));
  }
  return {
    provider: prov,
    async resolve(host) {
      const key = host.toLowerCase(), hit = cache.get(key);
      if (hit && hit.until > now()) return hit.ips;
      const rs = await Promise.allSettled([one(key, 1), one(key, 28)]);
      const ok = rs.filter((x) => x.status === 'fulfilled').map((x) => x.value);
      if (!ok.length) throw new Error('lookup through ' + prov.name + ' failed: ' + ((rs[0].reason && rs[0].reason.message) || 'no answer'));
      const addrs = ok.flatMap((x) => x.addrs);
      if (!addrs.length) throw new Error('no such name: ' + host);
      const ttl = Math.min(300, Math.max(10, Math.min(...addrs.map((a) => a.ttl))));
      const ips = [...new Set(addrs.map((a) => a.ip))];
      cache.set(key, { ips, until: now() + ttl * 1000 });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return ips;
    },
  };
}
module.exports = { createResolver, query, parse };
