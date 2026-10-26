'use strict';
// Instant answers and command shortcuts for the Mayfair Search start page.
// Pure functions: no network, no DOM. Loaded by the page (global MFAnswers) and by the main
// process and tests (module.exports). Nothing here is sent anywhere.
(function (root) {
  // ---------- calculator (no eval) ----------
  const FUNCS = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log: Math.log10, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil };
  const CONST = { pi: Math.PI, e: Math.E };
  function tokenize(src) {
    const t = []; const s = src.toLowerCase().replace(/×|x(?=\s*[\d(])/g, '*').replace(/÷/g, '/').replace(/,/g, '');
    for (let i = 0; i < s.length;) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      let m;
      if ((m = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/.exec(s.slice(i)))) { t.push({ n: parseFloat(m[0]) }); i += m[0].length; continue; }
      if ((m = /^[a-z]+/.exec(s.slice(i)))) { t.push({ w: m[0] }); i += m[0].length; continue; }
      if ('+-*/^()%'.includes(c)) { t.push({ o: c }); i++; continue; }
      return null;
    }
    return t;
  }
  function calc(src) {
    const t = tokenize(src); if (!t || !t.length) return null;
    let p = 0;
    const peek = () => t[p]; const eat = () => t[p++];
    const fail = () => { throw new Error('x'); };
    function expr() { let v = term(); while (peek() && (peek().o === '+' || peek().o === '-')) { const o = eat().o; const r = term(); v = o === '+' ? v + r : v - r; } return v; }
    function term() { let v = pow(); while (peek() && (peek().o === '*' || peek().o === '/')) { const o = eat().o; const r = pow(); v = o === '*' ? v * r : v / r; } return v; }
    function pow() { const b = unary(); if (peek() && peek().o === '^') { eat(); return Math.pow(b, pow()); } return b; }
    function unary() { if (peek() && peek().o === '-') { eat(); return -unary(); } if (peek() && peek().o === '+') { eat(); return unary(); } return post(); }
    function post() { let v = atom(); while (peek() && peek().o === '%') { eat(); v /= 100; } return v; }
    function atom() {
      const k = eat(); if (!k) fail();
      if (k.n !== undefined) return k.n;
      if (k.o === '(') { const v = expr(); if (!peek() || eat().o !== ')') fail(); return v; }
      if (k.w && CONST[k.w] !== undefined) return CONST[k.w];
      if (k.w && FUNCS[k.w]) { if (!peek() || eat().o !== '(') fail(); const v = expr(); if (!peek() || eat().o !== ')') fail(); return FUNCS[k.w](v); }
      return fail();
    }
    try { const v = expr(); if (p !== t.length || !Number.isFinite(v)) return null; return v; } catch { return null; }
  }
  const fmt = (v, d) => { if (Number.isInteger(v) && Math.abs(v) < 1e15) return v.toLocaleString('en-US'); const a = Math.abs(v); if (a >= 1e15 || a < 1e-6) return v.toExponential(6).replace(/\.?0+e/, 'e'); return parseFloat(v.toPrecision(d || 10)).toLocaleString('en-US', { maximumFractionDigits: 8 }); };

  function mathAnswer(text) {
    const pct = /^\s*([\d.,]+)\s*%\s*of\s*([\d.,]+)\s*$/i.exec(text);
    if (pct) { const v = parseFloat(pct[1].replace(/,/g, '')) / 100 * parseFloat(pct[2].replace(/,/g, '')); return Number.isFinite(v) ? { kind: 'calc', title: fmt(v), sub: text.trim() } : null; }
    if (!/[-+*/^%×÷]|\d\s*x\s*[\d(]|\b(sqrt|sin|cos|tan|ln|log|abs|round|floor|ceil)\b|\(/i.test(text)) return null;
    if (/^[\d\s.,]+$/.test(text)) return null;
    if (/^\s*[-+]?\d[\d\s]*$/.test(text)) return null;
    const v = calc(text);
    return v === null ? null : { kind: 'calc', title: fmt(v), sub: text.trim() + ' =' };
  }

  // ---------- units ----------
  const U = {
    length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254, nmi: 1852 },
    mass: { kg: 1, g: 0.001, mg: 1e-6, lb: 0.45359237, oz: 0.028349523125, st: 6.35029318, t: 1000 },
    volume: { l: 1, ml: 0.001, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625, tbsp: 0.01478676478, tsp: 0.00492892159 },
    speed: { 'm/s': 1, 'km/h': 1 / 3.6, mph: 0.44704, kn: 0.5144444444 },
    area: { m2: 1, km2: 1e6, ha: 1e4, acre: 4046.8564224, ft2: 0.09290304, mi2: 2589988.110336 },
    data: { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1048576, gib: 1073741824 },
    time: { s: 1, min: 60, h: 3600, d: 86400, wk: 604800 },
  };
  const ALIAS = {
    meter: 'm', meters: 'm', metre: 'm', metres: 'm', kilometer: 'km', kilometers: 'km', kilometre: 'km', kilometres: 'km', centimeter: 'cm', centimeters: 'cm', millimeter: 'mm', millimeters: 'mm',
    mile: 'mi', miles: 'mi', yard: 'yd', yards: 'yd', foot: 'ft', feet: 'ft', inch: 'in', inches: 'in',
    kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg', gram: 'g', grams: 'g', pound: 'lb', pounds: 'lb', lbs: 'lb', ounce: 'oz', ounces: 'oz', stone: 'st', tonne: 't', tonnes: 't',
    liter: 'l', liters: 'l', litre: 'l', litres: 'l', milliliter: 'ml', milliliters: 'ml', gallon: 'gal', gallons: 'gal', quart: 'qt', pint: 'pt', cups: 'cup', tablespoon: 'tbsp', teaspoon: 'tsp',
    kph: 'km/h', kmh: 'km/h', knot: 'kn', knots: 'kn', 'sq m': 'm2', hectare: 'ha', hectares: 'ha', acres: 'acre',
    byte: 'b', bytes: 'b', kilobyte: 'kb', megabyte: 'mb', gigabyte: 'gb', terabyte: 'tb',
    second: 's', seconds: 's', sec: 's', minute: 'min', minutes: 'min', mins: 'min', hour: 'h', hours: 'h', hr: 'h', hrs: 'h', day: 'd', days: 'd', week: 'wk', weeks: 'wk',
    celsius: 'c', centigrade: 'c', fahrenheit: 'f', kelvin: 'k', '°c': 'c', '°f': 'f',
  };
  const canon = (u) => { const x = u.toLowerCase().trim(); return ALIAS[x] || x; };
  const dimOf = (u) => Object.keys(U).find((d) => Object.prototype.hasOwnProperty.call(U[d], u)) || ((u === 'c' || u === 'f' || u === 'k') ? 'temp' : null);
  const toK = { c: (v) => v + 273.15, f: (v) => (v - 32) * 5 / 9 + 273.15, k: (v) => v };
  const fromK = { c: (k) => k - 273.15, f: (k) => (k - 273.15) * 9 / 5 + 32, k: (k) => k };
  const UNIT_NAME = { b: 'B', kb: 'KB', mb: 'MB', gb: 'GB', tb: 'TB', kib: 'KiB', mib: 'MiB', gib: 'GiB', h: 'h', t: 't', c: '°C', f: '°F', k: 'K', mi: 'mi', km: 'km', lb: 'lb', kg: 'kg', ft: 'ft', in: 'in', l: 'L', ml: 'mL', gal: 'US gal', floz: 'fl oz', 'km/h': 'km/h', mph: 'mph', m2: 'm²', km2: 'km²', ft2: 'ft²', mi2: 'mi²' };
  const label = (u) => UNIT_NAME[u] || u;

  function unitAnswer(text) {
    const m = /^\s*(-?[\d.,]+)\s*°?\s*([a-z°/0-9²]+(?:\s?[a-z]+)?)\s+(?:to|in|into|as)\s+°?\s*([a-z/0-9²]+)\s*$/i.exec(text.replace(/²/g, '2'));
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, '')); if (!Number.isFinite(n)) return null;
    const a = canon(m[2]); const b = canon(m[3]);
    const da = dimOf(a); const db = dimOf(b);
    if (!da || da !== db) return null;
    const out = da === 'temp' ? fromK[b](toK[a](n)) : n * U[da][a] / U[da][b];
    return { kind: 'unit', title: fmt(out, 6) + ' ' + label(b), sub: fmt(n) + ' ' + label(a) + ' =' };
  }

  // ---------- currency (offline table, always shows its date) ----------
  const CUR_WORD = { dollar: 'USD', dollars: 'USD', usd: 'USD', euro: 'EUR', euros: 'EUR', eur: 'EUR', pound: 'GBP', pounds: 'GBP', gbp: 'GBP', yen: 'JPY', jpy: 'JPY', franc: 'CHF', chf: 'CHF', cad: 'CAD', aud: 'AUD', nzd: 'NZD', cny: 'CNY', yuan: 'CNY', rmb: 'CNY', inr: 'INR', rupee: 'INR', rupees: 'INR' };
  const curCode = (s, rates) => { const k = s.toLowerCase(); return CUR_WORD[k] || (rates[k.toUpperCase()] ? k.toUpperCase() : null); };
  function currencyAnswer(text, table) {
    if (!table || !table.rates) return null;
    const sym = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
    let s = text.trim(); const lead = sym[s[0]];
    if (lead) { const r = /^.\s*(-?[\d.,]+)\s+(?:to|in|into|as)\s+([a-z]{2,8})\s*$/i.exec(s); if (!r) return null; s = r[1] + ' ' + lead + ' to ' + r[2]; }
    const m = /^\s*(-?[\d.,]+)\s*([a-z]{2,8})\s+(?:to|in|into|as)\s+([a-z]{2,8})\s*$/i.exec(s);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, '')); const a = curCode(m[2], table.rates); const b = curCode(m[3], table.rates);
    if (!Number.isFinite(n) || !a || !b || a === b) return null;
    const v = n / table.rates[a] * table.rates[b];
    return { kind: 'currency', title: v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 4 : 2 }) + ' ' + b, sub: n.toLocaleString('en-US') + ' ' + a + ' =', note: (table.approximate ? 'Approximate offline rates, ' : 'Offline rates, ') + table.date + '. Not live.' };
  }

  // ---------- time zones ----------
  const CITY = { london: 'Europe/London', paris: 'Europe/Paris', berlin: 'Europe/Berlin', madrid: 'Europe/Madrid', rome: 'Europe/Rome', amsterdam: 'Europe/Amsterdam', dublin: 'Europe/Dublin', lisbon: 'Europe/Lisbon', zurich: 'Europe/Zurich', vienna: 'Europe/Vienna', stockholm: 'Europe/Stockholm', athens: 'Europe/Athens', istanbul: 'Europe/Istanbul', moscow: 'Europe/Moscow', dubai: 'Asia/Dubai', mumbai: 'Asia/Kolkata', delhi: 'Asia/Kolkata', bangkok: 'Asia/Bangkok', singapore: 'Asia/Singapore', 'hong kong': 'Asia/Hong_Kong', shanghai: 'Asia/Shanghai', beijing: 'Asia/Shanghai', tokyo: 'Asia/Tokyo', seoul: 'Asia/Seoul', sydney: 'Australia/Sydney', melbourne: 'Australia/Melbourne', auckland: 'Pacific/Auckland', 'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York', toronto: 'America/Toronto', chicago: 'America/Chicago', denver: 'America/Denver', 'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', seattle: 'America/Los_Angeles', vancouver: 'America/Vancouver', 'mexico city': 'America/Mexico_City', 'sao paulo': 'America/Sao_Paulo', 'buenos aires': 'America/Argentina/Buenos_Aires', cairo: 'Africa/Cairo', lagos: 'Africa/Lagos', nairobi: 'Africa/Nairobi', johannesburg: 'Africa/Johannesburg', utc: 'UTC', gmt: 'UTC' };
  const title = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  function offsetMin(date, tz) {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(date).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
    return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
  }
  const clock = (d, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).format(d);
  function timeAnswer(text, now) {
    now = now || new Date();
    let m = /^\s*(?:what(?:'s| is)?\s+(?:the\s+)?)?time(?:\s+is\s+it)?\s+(?:in|at)?\s*([a-z ]+?)\s*\??$/i.exec(text);
    if (m && CITY[m[1].toLowerCase()]) { const tz = CITY[m[1].toLowerCase()]; return { kind: 'time', title: clock(now, tz), sub: 'Time in ' + title(m[1].toLowerCase()), note: tz.replace('_', ' ') }; }
    m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(?:in\s+)?([a-z ]+?)\s+(?:to|in)\s+([a-z ]+?)\s*$/i.exec(text);
    if (m && CITY[m[4].toLowerCase()] && CITY[m[5].toLowerCase()]) {
      let h = +m[1]; const mi = m[2] ? +m[2] : 0; const ap = (m[3] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
      if (h > 23 || mi > 59) return null;
      const from = CITY[m[4].toLowerCase()]; const to = CITY[m[5].toLowerCase()];
      const guess = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, mi);
      const inst = new Date(guess - offsetMin(new Date(guess), from) * 60000);
      return { kind: 'time', title: clock(inst, to), sub: (m[1] + (m[2] ? ':' + m[2] : '') + (ap ? ' ' + ap : '')) + ' in ' + title(m[4].toLowerCase()) + ' is', note: title(m[5].toLowerCase()) };
    }
    return null;
  }

  // Everything that can be answered on this device. rates: the offline table.
  function localAnswer(text, opts) {
    opts = opts || {}; const t = String(text || '').trim();
    if (!t || t.length > 120) return null;
    return unitAnswer(t) || currencyAnswer(t, opts.rates) || timeAnswer(t, opts.now) || mathAnswer(t);
  }

  // Answers that need a free web API. They run only for these explicit prefixes.
  function networkIntent(text) {
    const t = String(text || '').trim(); let m;
    if ((m = /^weather(?:\s+(?:in|for|at))?\s+(.{2,60})$/i.exec(t))) return { type: 'weather', q: m[1].trim() };
    if ((m = /^(?:define|definition of|meaning of)\s+([a-zA-Z'-]{2,40})$/i.exec(t))) return { type: 'define', q: m[1].toLowerCase() };
    if ((m = /^(?:wiki|wikipedia)\s+(.{2,80})$/i.exec(t))) return { type: 'wiki', q: m[1].trim() };
    return null;
  }

  // ---------- command shortcuts for the Mayfair desktop ----------
  const MODULES = { finance: 'Finance', files: 'Files', drive: 'Drive', notes: 'Notes', mail: 'Mail', calendar: 'Calendar', contacts: 'Contacts', chat: 'Chat', forms: 'Forms', booking: 'Booking', crm: 'CRM', studio: 'Studio', production: 'Production', passwords: 'Passwords', settings: 'Settings' };
  const CREATE = { note: 'note', event: 'event', contact: 'contact', invoice: 'invoice', task: 'task', form: 'form', file: 'file' };
  function parseCommand(text) {
    const t = String(text || '').trim().replace(/\s+/g, ' '); let m;
    if (!t || t.length > 120) return null;
    if ((m = /^(?:open|go to|show)\s+(?:my\s+)?([a-z]+)$/i.exec(t)) && MODULES[m[1].toLowerCase()]) { const k = m[1].toLowerCase(); return { label: 'Open ' + MODULES[k], action: 'open', path: '/' + k, params: {} }; }
    if ((m = /^invoice\s+(.{1,60})$/i.exec(t))) return { label: 'New invoice for ' + m[1], action: 'new', path: '/invoice', params: { name: m[1] } };
    if ((m = /^(?:new|create|add)\s+(note|event|contact|invoice|task|form|file)(?:\s+(?:for|called|named)\s+(.{1,60}))?$/i.exec(t))) { const k = CREATE[m[1].toLowerCase()]; return { label: 'New ' + k + (m[2] ? ' ' + m[2] : ''), action: 'new', path: '/' + k, params: m[2] ? { name: m[2] } : {} }; }
    return null;
  }

  const api = { calc, fmt, localAnswer, networkIntent, parseCommand, mathAnswer, unitAnswer, currencyAnswer, timeAnswer, MODULES, CITY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MFAnswers = api;
})(typeof window !== 'undefined' ? window : globalThis);
