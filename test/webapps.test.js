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
