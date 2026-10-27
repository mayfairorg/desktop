'use strict';
// Ghost: what may be named as the target of an active scan, and what kind of thing a typed lookup is.
// Plain functions with no DOM and no Node dependency: the page uses them to explain a refusal early, the main process runs the same code again
// before anything starts, so the page is never trusted.
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.GhostScope = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const MAX_V4_PREFIX = 24, MAX_V6_PREFIX = 120;        // the widest range one declaration may cover: 256 addresses
  // Common public suffixes of two labels. A bare suffix names a whole registry, never a target.
  const SUFFIX2 = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'co.nz', 'org.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'com.br', 'net.br', 'org.br', 'co.in', 'net.in', 'org.in', 'co.za', 'org.za', 'com.cn', 'net.cn', 'org.cn', 'com.mx', 'com.ar', 'com.tr', 'co.kr', 'or.kr', 'com.sg', 'com.hk', 'com.tw', 'co.il', 'com.ua', 'github.io', 'blogspot.com', 'herokuapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com']);

  function v4(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    if (!m) return null;
    const p = m.slice(1).map(Number);
    if (p.some((n) => n > 255) || m.slice(1).some((x) => x.length > 1 && x[0] === '0')) return null;
    return p;
  }
  function v6(s) {
    if (!/^[0-9a-f:.]+$/i.test(s) || s.indexOf(':') < 0) return null;
    try { const h = new URL('http://[' + s + ']/').hostname; return h.slice(1, -1); } catch { return null; }
  }
  function isIPv4(s) { return !!v4(String(s)); }
  function isIPv6(s) { return !!v6(String(s)); }

  // -> { ok:true, kind:'domain'|'ip'|'cidr', value } or { ok:false, reason }
  function parseTarget(input) {
    const raw = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
    if (!raw) return { ok: false, reason: 'Enter the domain, IP address or range you want to scan.' };
    if (raw.length > 253) return { ok: false, reason: 'That is too long to be a domain or address.' };
    if (/\s/.test(raw) || /[,;]/.test(raw)) return { ok: false, reason: 'Name one target at a time. Several targets in one declaration are not allowed.' };
    if (raw.includes('*') || raw.includes('?')) return { ok: false, reason: 'Wildcards are not allowed. Name the exact domain or address.' };
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(raw) || raw.includes('/') && !/^[0-9a-f:.]+\/\d{1,3}$/.test(raw)) return { ok: false, reason: 'Enter only the domain or address, without http:// or a path.' };
    if (raw.includes('@')) return { ok: false, reason: 'That looks like an email address. A scan target is a domain or an IP address.' };
    const cidr = /^([0-9a-f:.]+)\/(\d{1,3})$/.exec(raw);
    if (cidr) {
      const prefix = Number(cidr[2]);
      if (v4(cidr[1])) {
        if (prefix < MAX_V4_PREFIX) return { ok: false, reason: 'That range is too large. The widest range allowed is /' + MAX_V4_PREFIX + ' (256 addresses).' };
        if (prefix > 32) return { ok: false, reason: 'A range prefix cannot be more than 32.' };
        if (cidr[1] === '0.0.0.0') return { ok: false, reason: 'That range is not a real target.' };
        return { ok: true, kind: prefix === 32 ? 'ip' : 'cidr', value: prefix === 32 ? cidr[1] : cidr[1] + '/' + prefix };
      }
      const six = v6(cidr[1]);
      if (six) {
        if (prefix < MAX_V6_PREFIX) return { ok: false, reason: 'That range is too large. The widest IPv6 range allowed is /' + MAX_V6_PREFIX + '.' };
        if (prefix > 128) return { ok: false, reason: 'A range prefix cannot be more than 128.' };
        if (six === '::') return { ok: false, reason: 'That range is not a real target.' };
        return { ok: true, kind: prefix === 128 ? 'ip' : 'cidr', value: prefix === 128 ? six : six + '/' + prefix };
      }
      return { ok: false, reason: 'That is not a valid address range.' };
    }
    if (v4(raw)) { if (raw === '0.0.0.0') return { ok: false, reason: 'That address is not a real target.' }; return { ok: true, kind: 'ip', value: raw }; }
    if (raw.indexOf(':') >= 0) { const six = v6(raw); if (six && six !== '::') return { ok: true, kind: 'ip', value: six }; return { ok: false, reason: 'That is not a valid IP address.' }; }
    let host = raw.replace(/\.$/, '');
    if (/[^\x00-\x7f]/.test(host)) { try { host = new URL('http://' + host + '/').hostname; } catch { return { ok: false, reason: 'That is not a valid domain name.' }; } }
    const labels = host.split('.');
    if (labels.length < 2) return { ok: false, reason: 'A bare name such as "' + host + '" is a whole registry, not a target. Name a full domain.' };
    if (!labels.every((l) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(l))) return { ok: false, reason: 'That is not a valid domain name.' };
    if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1])) return { ok: false, reason: 'That does not end in a real top-level domain.' };
    if (SUFFIX2.has(labels.slice(-2).join('.')) && labels.length === 2) return { ok: false, reason: '"' + host + '" is a public suffix shared by many owners, not a target. Name a full domain.' };
    return { ok: true, kind: 'domain', value: host };
  }

  // Is a single host or address inside what was declared? Domains match exactly; an IP matches itself or the declared range.
  function ipv4Num(p) { return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]; }
  function inside(declared, candidate) {
    const d = parseTarget(declared), c = parseTarget(candidate);
    if (!d.ok || !c.ok) return false;
    if (d.kind === 'domain') return c.kind === 'domain' && c.value === d.value;
    if (d.kind === 'ip') return c.kind === 'ip' && c.value === d.value;
    if (c.kind === 'domain') return false;
    const [base, pre] = d.value.split('/'), prefix = Number(pre);
    const bp = v4(base);
    if (bp) {
      const cp = v4(c.kind === 'cidr' ? c.value.split('/')[0] : c.value); if (!cp) return false;
      const cpre = c.kind === 'cidr' ? Number(c.value.split('/')[1]) : 32; if (cpre < prefix) return false;
      const size = Math.pow(2, 32 - prefix), start = Math.floor(ipv4Num(bp) / size) * size;
      const n = ipv4Num(cp); return n >= start && n < start + size;
    }
    const dg = groups6(base), cg = groups6(c.kind === 'cidr' ? c.value.split('/')[0] : c.value);
    if (!dg || !cg) return false;
    const cpre6 = c.kind === 'cidr' ? Number(c.value.split('/')[1]) : 128; if (cpre6 < prefix) return false;
    for (let i = 0; i < 7; i++) if (dg[i] !== cg[i]) return false;
    const size = Math.pow(2, 128 - prefix), start = Math.floor(dg[7] / size) * size;
    return cg[7] >= start && cg[7] < start + size;
  }
  // eight 16-bit groups of a compressed IPv6 address
  function groups6(s) {
    const parts = String(s).split('::');
    if (parts.length > 2) return null;
    const a = parts[0] ? parts[0].split(':') : [], b = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
    if (parts.length === 1 && a.length !== 8) return null;
    const fill = parts.length === 2 ? 8 - a.length - b.length : 0;
    if (fill < 0) return null;
    const g = [...a, ...Array(fill).fill('0'), ...b].map((x) => parseInt(x, 16));
    return g.length === 8 && g.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? g : null;
  }

  // ---------- what a typed lookup is (the Ghost command bar and module boxes) ----------
  const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const PHONE = /^\+?[\d][\d\s().-]{6,}$/;
  const PERSON_PHRASES = [
    /who\s+(lives|live|owns? (the )?(house|home|flat|property))/i, /\blives?\s+(at|here|in|near)\b/i, /home\s+address/i, /\b(his|her|their)\s+(address|phone|number|accounts?|profiles?|socials?)\b/i,
    /\buser\s?names?\b/i, /\bhandles?\s+(of|for)\b/i, /\bprofiles?\s+(of|for)\b/i, /\bfind\s+(a\s+)?(person|people|someone|somebody|him|her|them)\b/i, /\bsocial\s+(media\s+)?accounts?\b/i,
    /\bphone\s+number\b/i, /\bfacial\b|\bface\s+(match|search|recogni)/i, /\bwhere\s+(does|do)\s+\S+\s+live\b/i, /\bwhose\s+(number|phone|email|address|account|face|photo)\b/i, /\bowner\s+of\s+\d+\s+\w+\s+(street|st|road|rd|avenue|ave|lane|ln|close|drive|dr)\b/i,
  ];
  const PERSON_REFUSAL = 'Ghost looks up domains, networks, organisations, documents, places and events. It does not look up people, usernames, email addresses, phone numbers or where someone lives.';

  // -> { refused:true, reason } when the text is aimed at one private person; otherwise { refused:false }
  function refusePersonQuery(text) {
    const t = String(text === undefined || text === null ? '' : text).trim();
    if (!t) return { refused: false };
    if (EMAIL.test(t) || /^@[\w.]{2,}$/.test(t) || PHONE.test(t) && !v4(t)) return { refused: true, reason: PERSON_REFUSAL };
    if (/\b(sherlock|maigret|blackbird|holehe|whats\s?my\s?name|whatsmyname)\b/i.test(t)) return { refused: true, reason: PERSON_REFUSAL };
    for (const p of PERSON_PHRASES) if (p.test(t)) return { refused: true, reason: PERSON_REFUSAL };
    return { refused: false };
  }

  // -> { kind:'domain'|'ip'|'cidr'|'asn'|'url'|'cert-hash'|null, value, refused?:true, reason? }
  function detectInput(text) {
    const t = String(text === undefined || text === null ? '' : text).trim();
    if (!t) return { kind: null, value: '' };
    const pr = refusePersonQuery(t); if (pr.refused) return { kind: null, value: t, refused: true, reason: pr.reason };
    if (/^as\d{1,10}$/i.test(t)) return { kind: 'asn', value: 'AS' + t.slice(2) };
    if (/^[0-9a-f]{64}$/i.test(t)) return { kind: 'cert-hash', value: t.toLowerCase() };
    if (/^https?:\/\//i.test(t)) {
      try {
        const u = new URL(t);
        if (u.username || u.password) return { kind: null, value: t, reason: 'Remove the user name and password from the address first.' };
        return { kind: 'url', value: u.protocol + '//' + u.host + (u.pathname === '/' ? '' : u.pathname) };
      } catch { return { kind: null, value: t, reason: 'That web address is not valid.' }; }
    }
    if (/^[0-9a-f:.]+\/\d{1,3}$/i.test(t)) { const p = parseTarget(t); return p.ok ? { kind: p.kind === 'ip' ? 'ip' : 'cidr', value: p.value } : { kind: null, value: t, reason: p.reason }; }
    if (v4(t) || (t.indexOf(':') >= 0 && v6(t))) { const p = parseTarget(t); return p.ok ? { kind: 'ip', value: p.value } : { kind: null, value: t, reason: p.reason }; }
    if (/^[^\s/@]+\.[^\s/@]+$/.test(t)) { const p = parseTarget(t); if (p.ok) return { kind: 'domain', value: p.value }; return { kind: null, value: t, reason: p.reason }; }
    return { kind: null, value: t };
  }

  return { parseTarget, inside, detectInput, refusePersonQuery, isIPv4, isIPv6, MAX_V4_PREFIX, MAX_V6_PREFIX, PERSON_REFUSAL };
});
