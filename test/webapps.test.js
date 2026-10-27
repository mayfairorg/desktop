'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../src/main/lib/webapps');
const cat = require('../src/main/lib/webapps.json');

test('shipped catalogue validates with no errors and has about 30+ apps', () => {
  const r = W.validateCatalogue(cat.apps);
  assert.deepEqual(r.errors, []);
  assert.ok(r.apps.length >= 30, String(r.apps.length));
  for (const n of ['Instagram', 'WhatsApp Web', 'Gmail', 'Outlook', 'YouTube', 'X', 'TikTok', 'LinkedIn', 'Facebook', 'Discord', 'Slack', 'Spotify', 'Google Drive', 'Google Docs', 'Google Maps', 'Notion', 'Trello', 'Canva', 'Figma', 'ChatGPT']) assert.ok(r.apps.some((a) => a.name === n), n);
  for (const a of r.apps) { assert.ok(a.url.startsWith('https://')); assert.ok(a.hosts.includes(new URL(a.url).hostname)); }
  const drm = r.apps.filter((a) => a.drm).map((a) => a.id).sort();
  assert.deepEqual(drm, ['disney', 'netflix', 'spotify']);
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
