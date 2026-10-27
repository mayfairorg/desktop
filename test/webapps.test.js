'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../src/main/lib/webapps');
const cat = require('../src/main/lib/webapps.json');

test('shipped catalogue validates with no errors and has 250-300 apps', () => {
  const r = W.validateCatalogue(cat.apps);
  assert.deepEqual(r.errors, []);
  assert.ok(r.apps.length >= 250 && r.apps.length <= 300, String(r.apps.length));
  for (const n of ['Instagram', 'WhatsApp Web', 'Gmail', 'Outlook', 'YouTube', 'X', 'TikTok', 'LinkedIn', 'Facebook', 'Discord', 'Slack', 'Spotify', 'Google Drive', 'Google Docs', 'Google Maps', 'Notion', 'Trello', 'Canva', 'Figma', 'ChatGPT']) assert.ok(r.apps.some((a) => a.name === n), n);
  for (const a of r.apps) { assert.ok(a.url.startsWith('https://')); assert.ok(a.hosts.includes(new URL(a.url).hostname)); }
  const drm = r.apps.filter((a) => a.drm).map((a) => a.id);
  for (const id of ['disney', 'netflix', 'spotify', 'primevideo']) assert.ok(drm.includes(id), id);
  assert.ok(!drm.includes('gmail') && !drm.includes('github'));
});
test('catalogue has no logos or remote images (plain names only)', () => {
  const txt = JSON.stringify(cat);
  assert.ok(!/\.(png|svg|ico|jpg)|"icon"|"logo"/i.test(txt));
});
test('validation drops bad entries and explains why', () => {
  const r = W.validateCatalogue([
    { id: 'ok', name: 'Ok', url: 'https://ok.example/' }, { id: 'ok', name: 'Dup', url: 'https://d.example/' },
    { id: 'Bad Id', name: 'x', url: 'https://x.example/' }, { id: 'http', name: 'x', url: 'http://x.example/' },
    { id: 'cred', name: 'x', url: 'https://u:p@x.example/' }, { id: 'noname', name: '', url: 'https://x.example/' },
    { id: 'js', name: 'x', url: 'javascript:1' }, null, 5,
  ]);
  assert.deepEqual(r.apps.map((a) => a.id), ['ok']);
  assert.equal(r.errors.length, 8);
  assert.deepEqual(W.validateCatalogue('nope').apps, []);
  assert.equal(W.validateCatalogue([{ id: 'a', name: 'A', url: 'https://a.example/', category: 'Weird', hosts: ['bad host', 'good.example'] }]).apps[0].category, 'Tools');
});
test('each app has its own session partition', () => {
  assert.equal(W.partitionFor('gmail'), 'persist:app-gmail');
  const ids = cat.apps.map((a) => W.partitionFor(a.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((p) => p.startsWith('persist:app-') && !['persist:mayfair', 'persist:browse'].includes(p)));
});
test('staysInApp keeps the app and its sign-in hosts, sends the rest out', () => {
  const g = W.validateCatalogue(cat.apps).apps.find((a) => a.id === 'gmail');
  assert.ok(W.staysInApp(g, 'https://mail.google.com/mail/u/0/'));
  assert.ok(W.staysInApp(g, 'https://accounts.google.com/signin'));
  assert.equal(W.staysInApp(g, 'https://evil.com/?https://mail.google.com'), false);
  assert.equal(W.staysInApp(g, 'https://mail.google.com.evil.com/'), false);
  assert.equal(W.staysInApp(g, 'http://mail.google.com/'), false);
  assert.equal(W.staysInApp(g, 'javascript:1'), false);
  assert.equal(W.staysInApp(g, 'nope'), false);
});
test('unread count from window titles', () => {
  const b = W.badgeFromTitle;
  assert.equal(b('(3) WhatsApp'), 3); assert.equal(b('[12] Chat'), 12); assert.equal(b('(99+) Facebook'), 99);
  assert.equal(b('Inbox (5) - me@x.com - Gmail'), 5); assert.equal(b('4 new messages'), 4);
  assert.equal(b('WhatsApp'), 0); assert.equal(b(''), 0); assert.equal(b(null), 0);
  assert.equal(b('Report (final) draft'), 0); assert.equal(b('2024 plans'), 0);
  assert.equal(b('(123456) x'), 0);
});
test('notify only when the count rises and the app is out of view', () => {
  assert.equal(W.shouldNotify(0, 2, false), true); assert.equal(W.shouldNotify(2, 2, false), false);
  assert.equal(W.shouldNotify(3, 1, false), false); assert.equal(W.shouldNotify(0, 2, true), false); assert.equal(W.shouldNotify(0, 0, false), false);
});
test('apps store: add, pin, window mode, remove, persist', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mfd-')), 'a.json');
  const s = new W.AppsStore(f, { delay: 1 });
  assert.equal(s.add('gmail'), true); assert.equal(s.add('Bad Id'), false);
  assert.equal(s.setPinned('gmail', true), true); assert.equal(s.setPinned('nope', true), false);
  assert.equal(s.setWindow('gmail', true), true);
  assert.deepEqual(s.pinned(), ['gmail']);
  s.flush();
  const again = new W.AppsStore(f);
  assert.deepEqual(again.list().map((a) => [a.id, a.pinned, a.window]), [['gmail', true, true]]);
  assert.equal(again.remove('gmail'), true); assert.equal(again.remove('gmail'), false); assert.equal(again.has('gmail'), false);
});
test('Linux launcher and --app argument', () => {
  const e = W.desktopEntry({ id: 'gmail', name: 'Gmail' }, '/opt/My App/mayfair');
  assert.match(e, /Exec="\/opt\/My App\/mayfair" --app=gmail/); assert.match(e, /^Name=Gmail$/m);
  assert.equal(W.findAppArg(['x', '--app=gmail']), 'gmail'); assert.equal(W.findAppArg(['--app=../etc']), null); assert.equal(W.findAppArg([]), null);
});

test('stay signed in: cookie rewrite rules (pure)', () => {
  const KC = require('../src/main/lib/keepcookies');
  const now = 1_800_000_000, D = 86400;
  const sess = { name: 'sid', value: 'v', domain: '.example.com', hostOnly: false, path: '/a', secure: true, httpOnly: true, sameSite: 'lax', session: true };
  const d = KC.keepCookie(sess, now);
  assert.equal(d.expirationDate, now + 400 * D);
  assert.deepEqual([d.name, d.value, d.domain, d.path, d.secure, d.httpOnly, d.sameSite, d.url], ['sid', 'v', '.example.com', '/a', true, true, 'lax', 'https://example.com/a']);
  const host = KC.keepCookie({ ...sess, domain: 'www.example.com', hostOnly: true }, now);
  assert.equal(host.domain, undefined, 'host-only cookies get no domain'); assert.equal(host.url, 'https://www.example.com/a');
  assert.equal(KC.keepCookie({ ...sess, session: false, expirationDate: now + 30 * D }, now).expirationDate, now + 400 * D, 'near expiry is renewed');
  assert.equal(KC.keepCookie({ ...sess, session: false, expirationDate: now + 100 * D }, now), null, 'far expiry is left alone (also stops a rewrite loop)');
  assert.equal(KC.keepCookie({ ...sess, session: false, expirationDate: now - 5 }, now), null, 'expired cookies are not revived');
  assert.equal(KC.keepCookie({ ...sess, secure: false }, now).url, 'http://example.com/a');
  assert.equal(KC.keepCookie(null, now), null);
  assert.equal(KC.shouldRewrite(false, 'explicit'), true);
  for (const [r, c] of [[true, 'explicit'], [true, 'overwrite'], [false, 'expired'], [false, 'evicted'], [false, 'expired-overwrite']]) assert.equal(KC.shouldRewrite(r, c), false, r + c);
});
test('stay signed in: partitions are persistent and authHosts join the app hosts', () => {
  const W = require('../src/main/lib/webapps');
  assert.match(W.partitionFor('snapchat'), /^persist:app-/);
  const { apps } = W.validateCatalogue([{ id: 'x', name: 'X', url: 'https://x.example.com/', authHosts: ['accounts.google.com', 'bad host', 5] }]);
  assert.deepEqual(apps[0].authHosts, ['accounts.google.com']); assert.ok(apps[0].hosts.includes('accounts.google.com'));
  assert.ok(W.staysInApp(apps[0], 'https://accounts.google.com/o/oauth2'));
  const svc = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/main/browser-service.js'), 'utf8');
  assert.ok(!/s\.clearStorageData|clearStorageData\(\)/.test(svc.replace(/async wipeApp[^\n]*\n/, '').replace(/async wipePrivate[\s\S]*?\n  }\n/, '').replace(/async wipeTor[^\n]*\n/, '').replace(/if \(want\('cookies'\)\)[^\n]*\n/, '')), 'no clear-on-quit or other clearing of app sessions');
});

test('site to web app matching', () => {
  const apps = W.validateCatalogue([
    { id: 'snapchat', name: 'Snapchat', url: 'https://web.snapchat.com/', hosts: ['snapchat.com'] },
    { id: 'instagram', name: 'Instagram', url: 'https://www.instagram.com/', authHosts: ['accounts.google.com'] },
    { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/' }, { id: 'drive', name: 'Drive', url: 'https://drive.google.com/' },
  ]).apps;
  const m = (u) => W.matchApp(apps, u);
  assert.equal(m('https://www.snapchat.com/x'), 'snapchat'); assert.equal(m('https://accounts.snapchat.com/login'), 'snapchat'); assert.equal(m('https://web.snapchat.com/'), 'snapchat');
  assert.equal(m('https://instagram.com/a'), 'instagram'); assert.equal(m('https://l.instagram.com/'), 'instagram');
  assert.equal(m('https://mail.google.com/mail'), 'gmail'); assert.equal(m('https://www.google.com/'), null, 'several Google apps: ambiguous'); assert.equal(m('https://accounts.google.com/'), null, 'sign-in hosts never match alone');
  assert.equal(m('https://example.org/'), null); assert.equal(m('javascript:1'), null); assert.equal(m('nonsense'), null); assert.equal(m('https://notsnapchat.com/'), null);
  assert.equal(W.registrable('a.b.example.co.uk'), 'example.co.uk'); assert.equal(W.registrable('www.snapchat.com'), 'snapchat.com');
  const { check } = require('../src/main/lib/ipc-allowlist');
  const ok = (ch, ...a) => check('web', 'br:' + ch, a).ok;
  for (const a of [[], [50], [{ app: 'snapchat' }], [{ app: 'snapchat', limit: 10 }]]) assert.equal(ok('history.list', ...a), true, JSON.stringify(a));
  assert.equal(ok('history.list', { app: 'Bad Id' }), false); assert.equal(ok('history.search', 'q', { app: 'snapchat' }), true); assert.equal(ok('history.clear', { app: 'snapchat' }), true); assert.equal(ok('history.clear', 5), true);
  assert.equal(ok('history.remove', 'https://a.com/', { app: 'snapchat' }), true); assert.equal(ok('suggest', 'x', { app: 'snapchat' }), true); assert.equal(ok('webapps.match', 'https://a.com'), true); assert.equal(ok('webapps.match', 5), false);
});
test('web app history is a separate store, never the browser history', () => {
  const { HistoryStore } = require('../src/main/lib/stores');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mfh-'));
  const b = new HistoryStore(path.join(d, 'history.json')), a = new HistoryStore(path.join(d, 'history-app-snapchat.json'));
  a.add('https://web.snapchat.com/chat', 'Chat'); b.add('https://example.org/', 'Ex');
  assert.deepEqual(a.list().map((x) => x.url), ['https://web.snapchat.com/chat']); assert.deepEqual(b.list().map((x) => x.url), ['https://example.org/']);
  a.clear(); assert.equal(a.list().length, 0); assert.equal(b.list().length, 1);
  const svc = fs.readFileSync(path.join(__dirname, '../src/main/browser-service.js'), 'utf8');
  assert.ok(/hs = webapp \? this\.histFor\(webapp\.id\) : this\.history; hs\.add/.test(svc), 'tab navigation writes to the app history when the tab is a web app');
});

test('history sync: ids, import merge and validation, no echo, caps; autofill channel checks', () => {
  const { HistoryStore } = require('../src/main/lib/stores');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mfs-'));
  const h = new HistoryStore(path.join(d, 'h.json'), { max: 5 });
  const it = h.add('https://a.com/1', 'A', 1000); assert.ok(/^h/.test(it.id)); assert.equal(h.lastNew, true);
  h.add('https://a.com/1', 'A2', 2000); assert.equal(h.lastNew, false, 'a repeat of the newest entry is not new');
  const r = h.importEntries([
    { id: 'x1', url: 'https://b.com/', title: 'B', t: 500 }, { id: 'x1', url: 'https://c.com/', t: 600 }, { url: 'https://b.com/', t: 500 },
    { url: 'javascript:1', t: 5 }, { url: 'https://d.com/', t: -1 }, { url: 'https://d.com/', t: Date.now() + 9e9 }, { id: 'bad id!', url: 'https://e.com/', t: 5 }, { url: 'https://f.com/', title: 5, t: 5 }, null, 'x',
    { url: 'https://g.com/', t: 100 }, { url: 'https://h.com/', t: 90 }, { url: 'https://i.com/', t: 80 }, { url: 'https://j.com/', t: 70 }, { url: 'https://k.com/', t: 60 },
  ]);
  assert.equal(r.added, 6); assert.equal(r.skipped, 9, JSON.stringify(r));
  assert.equal(h.list().length, 5, 'cap kept'); assert.ok(h.list()[0].t >= h.list()[1].t, 'newest first');
  h.flush(); assert.equal(new HistoryStore(path.join(d, 'h.json')).list().length, 5, 'persisted');
  assert.deepEqual(h.removeUrl(h.list()[0].id).length, 1, 'removal by id');
  assert.equal(require('../src/main/lib/origins').isSearchInput('cats and dogs'), true);
  for (const a of ['example.com', 'https://a.b/c', 'localhost:3000']) assert.equal(require('../src/main/lib/origins').isSearchInput(a), false, a);
  const { check } = require('../src/main/lib/ipc-allowlist');
  const w = (ch, ...a) => check('web', 'br:' + ch, a).ok;
  assert.equal(w('history.import', [{ url: 'https://a.com', t: 1 }]), true); assert.equal(w('history.import', [{ url: 'https://a.com', t: 1 }], { app: 'snapchat' }), true);
  assert.equal(w('history.import', [{ url: 5, t: 1 }]), false); assert.equal(w('history.import', Array(5001).fill({ url: 'https://a.com', t: 1 })), false); assert.equal(w('history.import', 'x'), false);
  assert.equal(w('history.syncState'), true);
  const page = (ch, ...a) => check('page', ch, a).ok;
  assert.equal(page('page:afSubmit', { email: 'a@b.co', name: 'Ann' }), true);
  for (const bad of [{ password: 'x' }, { cardNumber: '4111' }, { email: '' }, { email: 5 }, {}, []]) assert.equal(page('page:afSubmit', bad), false, JSON.stringify(bad));
  assert.equal(page('page:afFocus', 'email'), true); assert.equal(page('page:afFocus', 'cc'), false); assert.equal(check('web', 'page:afSubmit', [{ email: 'a@b.co' }]).ok, false);
  assert.equal(w('autofill.take', 'a1'), true); assert.equal(w('autofill.dismiss', 'a1', { never: true }), true); assert.equal(w('autofill.fill', 3, { email: 'a@b.co' }), true); assert.equal(w('autofill.fill', 3, { ssn: '1' }), false);
  assert.equal(w('autofill.answer', 'r1', null), true); assert.equal(w('autofill.answer', 'r1', 'x'), true); assert.equal(w('autofill.answer', 'r1', ''), false);
  assert.equal(check('page', 'br:autofill.take', ['a1']).ok, false);
});

// ---- the large catalogue: shape, no duplicates, search words, icons, and the Cloud copy ----
const { apps: ALL } = W.validateCatalogue(cat.apps);
const hostOf = (a) => new URL(a.url).hostname.toLowerCase().replace(/^www\./, '');
const keyOf = (a) => { const u = new URL(a.url); return hostOf(a) + u.pathname.replace(/\/+$/, '').toLowerCase(); };
test('catalogue: ids are unique and valid, installed-state ids of the first 36 apps are unchanged', () => {
  assert.equal(cat.apps.length, ALL.length, 'nothing was dropped by validation');
  assert.equal(new Set(ALL.map((a) => a.id)).size, ALL.length);
  assert.ok(ALL.every((a) => /^[a-z][a-z0-9-]{0,31}$/.test(a.id)));
  for (const id of ['whatsapp', 'messenger', 'telegram', 'discord', 'slack', 'teams', 'meet', 'zoom', 'gmail', 'outlook', 'gdrive', 'gdocs', 'gsheets', 'gcal', 'gmaps', 'dropbox', 'notion', 'trello', 'asana', 'miro', 'canva', 'figma', 'chatgpt', 'github', 'linkedin', 'facebook', 'instagram', 'x', 'tiktok', 'reddit', 'pinterest', 'youtube', 'twitch', 'spotify', 'netflix', 'disney']) assert.ok(ALL.some((a) => a.id === id), id);
});
test('catalogue: every address is https with a well-formed host, and no two apps share an address', () => {
  for (const a of ALL) {
    const u = new URL(a.url);
    assert.equal(u.protocol, 'https:', a.id); assert.ok(!u.username && !u.password && !u.search && !u.hash, a.id);
    assert.match(u.hostname, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, a.id);
    assert.ok(!/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) && u.hostname !== 'localhost', a.id);
    assert.ok(a.hosts.length >= 1 && a.hosts.every((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)), a.id);
  }
  const keys = ALL.map(keyOf); const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dup, [], 'duplicate address: ' + dup);
  // sites that share a host (Google Docs / Sheets / Slides / Forms, the BBC apps) are told apart by their path; only one may sit at the root
  const byHost = {}; for (const a of ALL) (byHost[hostOf(a)] = byHost[hostOf(a)] || []).push(a);
  for (const [h, l] of Object.entries(byHost)) if (l.length > 1) assert.ok(l.filter((a) => new URL(a.url).pathname.length <= 1).length <= 1, h + ': at most one app at the root');
});
test('catalogue: categories are known, non-empty and in tab order; names and descriptions are plain text', () => {
  const used = [...new Set(ALL.map((a) => a.category))];
  assert.ok(used.every((c) => W.CATEGORIES.includes(c)), used.join());
  for (const c of used) assert.ok(ALL.filter((a) => a.category === c).length >= 3, c);
  for (const c of ['AI', 'Social', 'Chat', 'Media', 'Mail', 'Office', 'Files', 'Work', 'Design', 'Dev', 'Shopping', 'Travel', 'News', 'Reference', 'Games', 'Tools']) assert.ok(used.includes(c), 'missing ' + c);
  const order = ALL.map((a) => W.CATEGORIES.indexOf(a.category)); assert.deepEqual(order, [...order].sort((a, b) => a - b), 'grouped by category');
  for (const a of ALL) { assert.ok(a.description.length >= 5 && a.description.length <= 120, a.id); assert.ok(!/[<>]/.test(a.name + a.description), a.id); }
  for (const n of ['Claude', 'ChatGPT', 'Gemini', 'Perplexity', 'Snapchat', 'Instagram', 'Threads', 'Bluesky', 'YouTube Music', 'BBC iPlayer', 'ITVX', 'Channel 4', 'OneDrive', 'Word', 'Todoist', 'Linear', 'GitLab', 'Stack Overflow', 'Vinted', 'Deliveroo', 'Airbnb', 'Skyscanner', 'Wikipedia', 'Chess.com', 'Lichess', 'Steam', 'Xbox Cloud Gaming']) assert.ok(ALL.some((a) => a.name === n), n);
});
test('catalogue: no adult or bank and payment sites; nothing hosted on a login-only portal host', () => {
  const bad = /(porn|xxx|onlyfans|paypal|stripe|revolut|monzo|barclays|hsbc|lloyds|natwest|santander|wise\.com|venmo|klarna|coinbase|binance|bet365|bank)/i;
  for (const a of ALL) assert.ok(!bad.test(a.url + ' ' + a.name), a.id);
});
test('catalogue: search words are lower case, short, and the aliases people type are there', () => {
  for (const a of ALL) { assert.ok(a.keywords.length >= 1 && a.keywords.length <= 12, a.id); assert.ok(a.keywords.every((k) => k === k.toLowerCase() && k.length <= 24), a.id); }
  const search = (q) => { q = q.toLowerCase(); return ALL.filter((a) => (a.name + ' ' + a.description + ' ' + a.category + ' ' + a.keywords.join(' ') + ' ' + a.id).toLowerCase().includes(q)).map((a) => a.id); };
  for (const [q, id] of [['openai', 'chatgpt'], ['chat gpt', 'chatgpt'], ['gpt', 'chatgpt'], ['insta', 'instagram'], ['ig', 'instagram'], ['twitter', 'x'], ['tweet', 'x'], ['yt', 'youtube'], ['fb', 'facebook'], ['snap', 'snapchat'], ['anthropic', 'claude'], ['bard', 'gemini'], ['xai', 'grok'], ['le chat', 'mistral'], ['bing chat', 'copilot'], ['google docs', 'gdocs'], ['hotmail', 'outlook'], ['msteams', 'teams'], ['iplayer', 'bbciplayer'], ['takeaway', 'deliveroo'], ['stack overflow', 'stackoverflow'], ['weather', 'metoffice']]) assert.ok(search(q).includes(id), q + ' -> ' + id);
  assert.equal(W.validateCatalogue([{ id: 'k', name: 'K', url: 'https://k.example/', keywords: ['ok word', 'Bad', 5, '<x>', 'a'.repeat(30)] }]).apps[0].keywords.join('|'), 'ok word');
});
test('catalogue: matchApp tells apps on one host apart by path, and keeps existing matches', () => {
  const m = (u) => W.matchApp(ALL, u);
  assert.equal(m('https://docs.google.com/spreadsheets/d/1/edit'), 'gsheets'); assert.equal(m('https://docs.google.com/presentation/d/1'), 'gslides');
  assert.equal(m('https://docs.google.com/forms/d/1'), 'gforms'); assert.equal(m('https://docs.google.com/document/d/1'), 'gdocs');
  assert.equal(m('https://www.bbc.co.uk/iplayer/episode/x'), 'bbciplayer'); assert.equal(m('https://www.bbc.co.uk/news/uk'), 'bbcnews'); assert.equal(m('https://www.bbc.co.uk/sport/football'), 'bbcsport');
  assert.equal(m('https://claude.ai/chat/1'), 'claude'); assert.equal(m('https://chatgpt.com/c/1'), 'chatgpt'); assert.equal(m('https://www.instagram.com/p/1'), 'instagram');
});
test('app icons: finding the icon address in a page', () => {
  const { pickIcons, safeIconUrl, sniff } = require('../src/main/lib/webapp-icons');
  const html = '<html><head><link rel="icon" href="/f16.png" sizes="16x16"><link rel="shortcut icon" href="https://cdn.example.com/f48.png" sizes="48x48"><link rel="apple-touch-icon" sizes="180x180" href="/touch.png"><link rel="icon" href="http://insecure.example.com/x.png"><link rel="icon" href="data:image/png;base64,AAAA"><link rel="icon" href="https://127.0.0.1/x.png"></head>';
  const l = pickIcons(html, 'https://www.example.com/');
  assert.deepEqual(l.slice(0, 3), ['https://www.example.com/touch.png', 'https://cdn.example.com/f48.png', 'https://www.example.com/f16.png']);
  assert.equal(l[l.length - 1], 'https://www.example.com/favicon.ico'); assert.ok(l.length <= 4);
  assert.deepEqual(pickIcons('<p>nothing</p>', 'https://a.example.org/x/y'), ['https://a.example.org/favicon.ico']);
  for (const u of ['http://a.example.com/', 'https://u:p@a.example.com/', 'https://127.0.0.1/', 'https://localhost/', 'https://printer.local/', 'https://10.0.0.1/', 'ftp://a.example.com/', 'nope', 'https://intranet/']) assert.equal(safeIconUrl(u), null, u);
  assert.equal(safeIconUrl('https://a.example.com/i.png'), 'https://a.example.com/i.png');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  assert.equal(sniff(png), 'image/png'); assert.equal(sniff(Buffer.from('<!doctype html><html><body>hi</body></html>')), ''); assert.equal(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(sniff(Buffer.from('GIF89a......')), 'image/gif'); assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0])), 'image/jpeg'); assert.equal(sniff(Buffer.alloc(3)), '');
});
test('app icons: fetch, size cap, disk cache, failures ignored, one request pool', async () => {
  const { WebAppIcons } = require('../src/main/lib/webapp-icons');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfi-'));
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(100, 1)]);
  const calls = []; let active = 0, peak = 0;
  const fetch = async (u) => {
    calls.push(u); active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--;
    if (u === 'https://good.example.com/') return { ok: true, url: u, buf: Buffer.from('<link rel="apple-touch-icon" href="/t.png">') };
    if (u === 'https://good.example.com/t.png') return { ok: true, url: u, buf: png };
    if (u === 'https://redir.example.com/') return { ok: true, url: 'http://evil.example.com/', buf: Buffer.from('<link rel="icon" href="/x.png">') };
    if (u === 'https://big.example.com/') return { ok: true, url: u, buf: Buffer.from('<link rel="icon" href="/big.png">') };
    if (u === 'https://big.example.com/big.png') return { ok: true, url: u, buf: Buffer.concat([png, Buffer.alloc(50000, 2)]) };
    if (u === 'https://html.example.com/favicon.ico') return { ok: true, url: u, buf: Buffer.from('<!doctype html><html>not an image at all</html>') };
    throw new Error('network down');
  };
  let t = 1000; const ic = new WebAppIcons({ dir, fetch, now: () => t });
  const apps = ['good', 'redir', 'big', 'html', 'down'].map((n) => ({ id: n, url: 'https://' + n + '.example.com/x' }));
  assert.deepEqual(ic.collect(apps).icons, {}); assert.equal(ic.collect(apps).pending, 5);
  for (let i = 0; i < 100 && ic.active + ic.queue.length; i++) await new Promise((r) => setTimeout(r, 10));
  const r = ic.collect(apps);
  assert.deepEqual(Object.keys(r.icons), ['good']); assert.match(r.icons.good, /^data:image\/png;base64,/); assert.equal(r.pending, 0);
  assert.ok(peak <= 3, 'at most 3 at a time: ' + peak);
  assert.ok(!calls.some((u) => u.startsWith('http://')), 'never http');
  const again = new WebAppIcons({ dir, fetch: async () => { throw new Error('should come from disk'); }, now: () => t + 1000 });
  assert.equal(again.collect(apps).icons.good, r.icons.good); assert.equal(again.queue.length + again.active, 0, 'fresh answers (also failures) are not asked again');
  let asked = 0; const later = new WebAppIcons({ dir, fetch: async () => { asked++; return { ok: false }; }, now: () => t + 4 * 24 * 3600 * 1000 });
  later.collect(apps); for (let i = 0; i < 100 && later.active + later.queue.length; i++) await new Promise((r2) => setTimeout(r2, 10));
  assert.ok(asked > 0, 'failures are retried after 3 days'); assert.ok(later.collect(apps).icons.good, 'an old icon keeps showing while it is refreshed');
  assert.ok(fs.readdirSync(dir).every((f) => /^[a-z0-9-]+\.json$/.test(f)));
  assert.equal(ic.collect([{ id: 'Bad Id', url: 'https://x.example.com/' }]).pending, 0);
});
test('app icons: the catalogue bridge carries icon and keywords, requests are https-only and cookie-free', () => {
  const svc = fs.readFileSync(path.join(__dirname, '../src/main/browser-service.js'), 'utf8');
  assert.ok(/'br:webapps\.catalogue'[\s\S]{0,900}keywords: a\.keywords, icon: ic\[a\.id\] \|\| ''/.test(svc));
  const f = svc.slice(svc.indexOf('async fetchIcon'), svc.indexOf('async fetchBuffer'));
  assert.ok(/credentials: 'omit'/.test(f) && /safeIconUrl\(u\)/.test(f) && /netBlocked/.test(f) && /quitting/.test(f));
  assert.ok(!/session\.|cookies/.test(f));
});
test('the Cloud copy of the catalogue (if present) is generated from this one', () => {
  const g = require('../tools/gen-cloud-webapps');
  const text = g.render(); assert.match(text, /^\/\*[\s\S]*\*\/\nwindow\.MFWEBAPPS=\[/);
  const rows = new Function('window', text + '; return window.MFWEBAPPS;')({});
  assert.equal(rows.length, ALL.length); assert.deepEqual(rows.map((r) => r[0]), ALL.map((a) => a.id));
  assert.ok(rows.every((r) => r.length === 6 && r[3].startsWith('https://')));
  const copy = process.env.MF_CLOUD_WEBAPPS || path.join(__dirname, '../../release-wc/apps/webapps_catalogue.js');
  if (fs.existsSync(copy)) assert.equal(fs.readFileSync(copy, 'utf8'), text, 'run: node tools/gen-cloud-webapps.js ' + copy);
});
