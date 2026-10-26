'use strict';
// Free web APIs for three explicit question types. Each runs only when the user types the
// prefix (weather ..., define ..., wiki ...). Only the typed place or word is sent, to that one
// service, with no cookies and no account. Fetch is injected so tests need no network.
const HOSTS = Object.freeze(['geocoding-api.open-meteo.com', 'api.open-meteo.com', 'api.dictionaryapi.dev', 'en.wikipedia.org']);
const WMO = { 0: 'Clear sky', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail' };

const urls = {
  geocode: (q) => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=en&format=json`,
  forecast: (lat, lon) => `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`,
  define: (w) => `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`,
  wiki: (t) => `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}?redirect=true`,
};
const allowed = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && HOSTS.includes(x.hostname); } catch { return false; } };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '...' : s; };

function parseWeather(geo, fc) {
  const g = geo && geo.results && geo.results[0]; const c = fc && fc.current;
  if (!g || !c || typeof c.temperature_2m !== 'number') return null;
  const f = Math.round(c.temperature_2m * 9 / 5 + 32);
  return { kind: 'weather', title: Math.round(c.temperature_2m) + '°C  (' + f + '°F)', sub: [g.name, g.admin1, g.country].filter(Boolean).join(', '), note: (WMO[c.weather_code] || 'Current conditions') + (typeof c.wind_speed_10m === 'number' ? ', wind ' + Math.round(c.wind_speed_10m) + ' km/h' : '') + '. Source: Open-Meteo.' };
}
function parseDefine(d) {
  const e = Array.isArray(d) && d[0]; const m = e && e.meanings && e.meanings[0]; const def = m && m.definitions && m.definitions[0];
  if (!def) return null;
  return { kind: 'define', title: e.word, sub: (m.partOfSpeech ? m.partOfSpeech + '. ' : '') + clip(def.definition, 220), note: 'Source: Free Dictionary API.' };
}
function parseWiki(d) {
  if (!d || d.type === 'disambiguation' || !d.extract) return null;
  const url = d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page;
  return { kind: 'wiki', title: d.title, sub: clip(d.extract, 300), note: 'Source: Wikipedia.', url: url && allowed(url) ? url : undefined };
}

async function run(intent, fetchJson) {
  const get = async (u) => { if (!allowed(u)) throw new Error('blocked host'); return fetchJson(u); };
  try {
    if (intent.type === 'weather') {
      const geo = await get(urls.geocode(intent.q)); const g = geo && geo.results && geo.results[0];
      if (!g) return null;
      return parseWeather(geo, await get(urls.forecast(g.latitude, g.longitude)));
    }
    if (intent.type === 'define') return parseDefine(await get(urls.define(intent.q)));
    if (intent.type === 'wiki') return parseWiki(await get(urls.wiki(intent.q)));
  } catch { return null; }
  return null;
}
module.exports = { run, urls, allowed, parseWeather, parseDefine, parseWiki, HOSTS };
