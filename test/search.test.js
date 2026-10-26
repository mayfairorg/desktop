'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/ui/answers.js');
const SG = require('../src/main/lib/suggest');
const ON = require('../src/main/lib/online-answers');
const O = require('../src/main/lib/origins');
const { check, channelsFor } = require('../src/main/lib/ipc-allowlist');
const rates = require('../src/ui/rates.json');
const now = new Date('2026-10-26T12:00:00Z');
const ans = (t) => A.localAnswer(t, { rates, now });

test('calculator: precedence, functions, percent, no eval', () => {
  assert.equal(ans('2+3*4').title, '14'); assert.equal(ans('(2+3)*4').title, '20'); assert.equal(ans('2^10').title, '1,024');
  assert.equal(ans('sqrt(144)').title, '12'); assert.equal(ans('20% of 150').title, '30'); assert.equal(ans('10/4').title, '2.5');
  assert.equal(ans('-3+5').title, '2'); assert.equal(ans('2 x 3').title, '6');
  for (const bad of ['1/0', '2+', 'alert(1)', 'process.exit()', '2+2; rm', '(1+2', '1e999*10', '2024', 'hello', '12']) assert.equal(ans(bad), null, bad);
});
test('units: length, mass, temperature, data, speed; unknown or mixed refused', () => {
  assert.match(ans('5 km to miles').title, /^3\.10686 mi$/); assert.match(ans('10 kg to lb').title, /^22\.0462 lb$/);
  assert.match(ans('100 f to c').title, /^37\.7778/); assert.match(ans('0 c to f').title, /^32 /); assert.match(ans('1.5 gb to mb').title, /^1,500 MB$/);
  assert.match(ans('60 mph in km/h').title, /^96\.5606 km\/h$/);
  assert.equal(ans('5 km to kg'), null); assert.equal(ans('5 foo to bar'), null);
});
test('currency uses the bundled table and always shows its date', () => {
  const r = ans('100 usd to eur'); assert.match(r.title, /EUR$/); assert.match(r.note, new RegExp(rates.date)); assert.match(r.note, /Not live/);
  assert.equal(ans('$50 to gbp').kind, 'currency'); assert.equal(ans('100 usd to usd'), null); assert.equal(ans('100 usd to zzz'), null);
  assert.ok(Math.abs(parseFloat(ans('1 eur to eur'.replace('eur to eur', 'eur to usd')).title) - rates.rates.USD) < 0.01);
  assert.equal(rates.base, 'EUR'); assert.match(rates.date, /^\d{4}-\d{2}-\d{2}$/);
});
test('time zones: city time and conversion honour daylight saving', () => {
  assert.match(ans('time in tokyo').title, /21:00/);
  assert.match(ans('3pm london to new york').title, /11:00/);
  assert.match(ans('9:30am tokyo to london').title, /00:30/);
  assert.equal(ans('time in atlantis'), null); assert.equal(ans('25pm london to paris'), null);
});
test('network answers only for explicit prefixes', () => {
  assert.deepEqual(A.networkIntent('weather in Paris'), { type: 'weather', q: 'Paris' });
  assert.deepEqual(A.networkIntent('define serendipity'), { type: 'define', q: 'serendipity' });
  assert.deepEqual(A.networkIntent('wiki Ada Lovelace'), { type: 'wiki', q: 'Ada Lovelace' });
  for (const t of ['weather', 'what is the weather', 'paris', 'define', 'wiki', 'cats and dogs', 'serendipity meaning']) assert.equal(A.networkIntent(t), null, t);
});
test('command shortcuts', () => {
  assert.deepEqual(A.parseCommand('open finance'), { label: 'Open Finance', action: 'open', path: '/finance', params: {} });
  assert.equal(A.parseCommand('Open my Calendar').path, '/calendar');
  assert.deepEqual(A.parseCommand('new note'), { label: 'New note', action: 'new', path: '/note', params: {} });
  const inv = A.parseCommand('invoice Acme Ltd'); assert.equal(inv.path, '/invoice'); assert.deepEqual(inv.params, { name: 'Acme Ltd' });
  assert.equal(A.parseCommand('new invoice for Bob').params.name, 'Bob');
  for (const t of ['open source software', 'open ../../etc', 'new rocket', 'open', '', 'x'.repeat(200), 'open finance; drop']) assert.equal(A.parseCommand(t), null, t);
});
test('suggestions come from bookmarks and history only, bookmarks first, deduped', () => {
  const bm = [{ title: 'Mayfair Docs', url: 'https://a.com/' }]; const hs = [{ title: 'Mayfair Docs', url: 'https://a.com/' }, { title: 'Maybe later', url: 'https://b.com/' }, { title: 'Other', url: 'https://mayfair.example/x' }, { title: 'Nope', url: 'https://z.com/' }];
  const r = SG.suggest('may', bm, hs);
  assert.equal(r[0].kind, 'bookmark'); assert.equal(r.filter((x) => x.url === 'https://a.com/').length, 1); assert.equal(r.length, 3); assert.ok(!r.some((x) => x.url === 'https://z.com/'));
  assert.deepEqual(SG.suggest('', bm, hs), []);
  const src = require('node:fs').readFileSync(require.resolve('../src/main/lib/suggest.js'), 'utf8'); assert.ok(!/\bfetch\b|require\('(node:)?https?'\)/.test(src));
});
test('web app search results are cleaned: kind, link shape, size', () => {
  const r = SG.cleanWebResults([
    { kind: 'file', title: 'Budget.xlsx', subtitle: 'Drive', link: '/files/abc123' }, { kind: 'bogus', title: 'x', link: '/a' }, { kind: 'note', title: 'n', link: 'https://evil.com' },
    { kind: 'note', title: 'n', link: '/../etc' }, { kind: 'note', title: '', link: '/ok' }, { kind: 'contact', title: 'Ann', link: '/contacts/9?x=1' }, null, 5,
  ]);
  assert.deepEqual(r.map((x) => x.link), ['/files/abc123']);
  assert.equal(SG.cleanWebResults('nope').length, 0);
  assert.equal(SG.cleanWebResults(new Array(40).fill({ kind: 'file', title: 't', link: '/f/1' })).length, 6);
});
test('online answers: parsers, host allow-list, failures return null', async () => {
  assert.equal(ON.parseDefine([{ word: 'amber', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'A fossil resin.' }] }] }]).sub, 'noun. A fossil resin.');
  assert.equal(ON.parseDefine([]), null);
  assert.match(ON.parseWiki({ title: 'Ada', extract: 'x'.repeat(500), content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ada' } } }).sub, /\.\.\.$/);
  assert.equal(ON.parseWiki({ type: 'disambiguation', extract: 'x' }), null);
  assert.equal(ON.parseWiki({ title: 'x', extract: 'y', content_urls: { desktop: { page: 'https://evil.com/' } } }).url, undefined);
  assert.equal(ON.parseWeather({ results: [] }, {}), null);
  assert.equal(ON.allowed('https://api.open-meteo.com/v1/forecast'), true); assert.equal(ON.allowed('https://evil.com/'), false); assert.equal(ON.allowed('http://api.open-meteo.com/'), false);
  let hit = []; const f = async (u) => { hit.push(new URL(u).hostname); return u.includes('geocoding') ? { results: [{ name: 'Paris', country: 'France', latitude: 1, longitude: 2 }] } : { current: { temperature_2m: 10, weather_code: 0 } }; };
  const w = await ON.run({ type: 'weather', q: 'paris' }, f);
  assert.match(w.title, /10°C/); assert.deepEqual(hit, ['geocoding-api.open-meteo.com', 'api.open-meteo.com']);
  assert.equal(await ON.run({ type: 'wiki', q: 'x' }, async () => { throw new Error('offline'); }), null);
});
test('search engines: all seven, default DuckDuckGo, names, results go to the engine own page', () => {
  assert.deepEqual(Object.keys(O.SEARCH_ENGINES).sort(), ['bing', 'brave', 'duckduckgo', 'ecosia', 'google', 'qwant', 'startpage']);
  for (const k of Object.keys(O.SEARCH_ENGINES)) { assert.ok(O.ENGINE_NAMES[k]); assert.ok(O.SEARCH_ENGINES[k].startsWith('https://') && O.SEARCH_ENGINES[k].includes('%s')); }
  assert.equal(O.normalizeInput('cats', 'google'), 'https://www.google.com/search?q=cats');
  assert.equal(O.normalizeInput('cats'), 'https://duckduckgo.com/?q=cats');
});
test('start page IPC: its own role only, no tab or settings control', () => {
  assert.ok(channelsFor('start').length >= 9);
  assert.equal(check('start', 'search:go', ['cats']).ok, true); assert.equal(check('start', 'search:go', [5]).ok, false);
  assert.equal(check('start', 'search:online', [{ type: 'weather', q: 'x' }]).ok, true); assert.equal(check('start', 'search:online', [{ type: 'evil', q: 'x' }]).ok, false);
  assert.equal(check('start', 'search:panel', ['apps']).ok, true); assert.equal(check('start', 'search:panel', ['downloads']).ok, false);
  for (const ch of ['tab:new', 'settings:set', 'web:readFile', 'tor:newTab', 'hist:clear', 'apps:remove']) assert.equal(check('start', ch, []).ok, false, ch);
  for (const r of ['page', 'web', 'chrome', 'overlay']) assert.equal(check(r, 'search:go', ['x']).ok, false, r);
});
